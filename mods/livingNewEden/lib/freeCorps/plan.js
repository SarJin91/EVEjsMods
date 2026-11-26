"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { ARCHETYPES, CORP_STATES, OWNER_KIND, MAX_END_REASON_LENGTH } = require("./schema");
const { generateName, nameKey } = require("./names");
const { resolveSkirmish } = require("./skirmish");

function drawWeighted(keys, weights, rng) {
  let sum = 0;
  for (const k of keys) {
    const w = weights.get(k) || 0;
    if (w > 0) sum += w;
  }
  if (sum <= 0) return null;
  let r = rng.nextInt(1, sum);
  for (const k of keys) {
    const w = weights.get(k) || 0;
    if (w <= 0) continue;
    if (r <= w) return k;
    r -= w;
  }
  return null;
}

function hasBandWeight(archetype, bandWeights) {
  return archetype.bands.some((b) => (bandWeights.get(b) || 0) > 0);
}

function planFounding(input) {
  const { worldSeed, corpId, salt, now, S, archetypes } = input;
  const seed = deriveSeed(worldSeed, "freecorp", corpId, salt);
  const rng = createRng(seed);
  const archWeights = new Map();
  for (const id of ARCHETYPES) {
    const a = archetypes[id];
    const w = S.archetypeWeights.get(id) || 0;
    if (a && a.available !== false && w > 0 && hasBandWeight(a, S.bandWeights)) archWeights.set(id, w);
  }
  const archetypeId = drawWeighted(ARCHETYPES, archWeights, rng);
  if (archetypeId === null) return { ok: false, reason: "NO_ARCHETYPE" };
  const archetype = archetypes[archetypeId];
  const band = drawWeighted(archetype.bands, S.bandWeights, rng);
  if (band === null) return { ok: false, reason: "NO_ARCHETYPE" };
  const lo = Math.min(S.membersMin, S.membersMax);
  const hi = Math.max(S.membersMin, S.membersMax);
  if (!(input.memberRoom >= lo)) return { ok: false, reason: "NO_ROOM" };
  const membersTarget = Math.min(rng.nextInt(lo, hi), input.memberRoom);
  const raceFactionId = rng.pick(input.raceSourceFactionIds);
  if (!Number.isSafeInteger(raceFactionId)) return { ok: false, reason: "NO_HOME" };
  const systems = input.systemsOf(band) || [];
  let home = null;
  for (let i = 0; i < S.maxHomeAttempts && systems.length > 0 && home === null; i += 1) {
    const systemId = systems[rng.nextInt(0, systems.length - 1)];
    const stations = (input.stationsOf(systemId) || []).slice().sort((a, b) => a.stationId - b.stationId);
    if (stations.length === 0 || input.homeCount(systemId) >= S.maxCorpsPerHomeSystem) continue;
    const station = rng.pick(stations);
    home = { systemId, stationId: station.stationId,
      stationCorpId: Number.isSafeInteger(station.corporationId) && station.corporationId > 0
        ? station.corporationId : null };
  }
  if (home === null) return { ok: false, reason: "NO_HOME" };
  let picked = null;
  const first = salt * S.maxNameAttempts;
  for (let attempt = first; attempt < first + S.maxNameAttempts && picked === null; attempt += 1) {
    const n = generateName({ worldSeed, corpId, archetype: archetypeId, attempt });
    if (input.reserved.names.has(nameKey(n.name)) || input.reserved.tickers.has(n.ticker)) continue;
    if (input.nameTaken(n.name, n.ticker)) continue;
    picked = { ...n, attempt };
  }
  if (picked === null) return { ok: false, reason: "NAME_EXHAUSTED" };
  return { ok: true, row: Object.freeze({ corp_id: corpId, archetype: archetypeId, sec_band: band,
    members_target: membersTarget, race_faction_id: raceFactionId, home_system_id: home.systemId,
    home_station_id: home.stationId, home_station_corp_id: home.stationCorpId, name: picked.name,
    ticker: picked.ticker, name_attempt: picked.attempt, seed, isk: S.initialIsk, next_at: now + S.foundingRecheckMs,
    founded_at: now }) };
}

function bornOf(row) {
  const recruited = Number.isSafeInteger(row.recruited) && row.recruited > 0 ? row.recruited : 0;
  return row.members_target - recruited;
}

function memberCount(identity) {
  const ids = Array.isArray(identity.characterIds) ? identity.characterIds.length : 0;
  const refused = Number.isSafeInteger(identity.refusedMemberCount) ? identity.refusedMemberCount : 0;
  return ids + refused;
}

function stepCorp(row, identity, { now, S }) {
  if (!identity || identity.ok !== true) {
    return { kind: "RESCHEDULE", nextAt: now + S.foundingRecheckMs, ensure: false, note: "VC_UNAVAILABLE" };
  }
  const short = identity.state === "LINKED" && memberCount(identity) < bornOf(row);
  if (row.state === CORP_STATES.FOUNDING) {
    if (identity.state === "LINKED") {
      return { kind: "ACTIVATE", corporationId: identity.corporationId, nextAt: now + S.activeIdleMs, ensure: short };
    }
    if (identity.state === "REFUSED") {
      return { kind: "REFUSE", reason: String(identity.reason || "REFUSED").slice(0, MAX_END_REASON_LENGTH) };
    }
    const out = { kind: "RESCHEDULE", nextAt: now + S.foundingRecheckMs, ensure: true };
    if (now - row.founded_at > S.foundingStaleMs) out.note = "STALE";
    return out;
  }
  const nextAt = now + S.activeIdleMs;
  if (identity.state === "LINKED") {
    if (identity.corporationId !== row.corporation_id) {
      return { kind: "RESCHEDULE", nextAt, ensure: short, corporationId: identity.corporationId,
        note: "CORP_ID_CHANGED" };
    }
    if (short) return { kind: "RESCHEDULE", nextAt, ensure: true, note: "REPAIR" };
    return { kind: "RESCHEDULE", nextAt, ensure: false };
  }
  if (identity.state === "REFUSED") return { kind: "RESCHEDULE", nextAt, ensure: false, note: "REFUSED_ACTIVE" };
  return { kind: "RESCHEDULE", nextAt, ensure: true, note: "REPAIR" };
}

function specOf(row, graph, bloodlinesOf, archetypes) {
  const vertex = graph && typeof graph.getSystem === "function" ? graph.getSystem(row.home_system_id) : null;
  const archetype = archetypes[row.archetype];
  const bloodlines = bloodlinesOf(row.race_faction_id);
  if (!vertex || !archetype || !Array.isArray(bloodlines) || bloodlines.length === 0) return null;
  const spec = { ownerKind: OWNER_KIND, ownerId: row.corp_id,
    corporation: { name: row.name, ticker: row.ticker,
      description: `Independent ${archetype.label} corporation, home: ${vertex.name}` },
    members: bornOf(row), stationId: row.home_station_id, stationCorporationId: row.home_station_corp_id,
    systemId: row.home_system_id, constellationId: vertex.constellationId, regionId: vertex.regionId,
    bloodlineIds: bloodlines.slice(), securityRating: archetype.securityRating };
  if (Number.isSafeInteger(row.ceo_character_id) && row.ceo_character_id > 0) spec.ceoCharacterId = row.ceo_character_id;
  return spec;
}

module.exports = { drawWeighted, planFounding, stepCorp, specOf, bornOf, resolveSkirmish };
