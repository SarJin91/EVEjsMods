"use strict";

const { deriveSeed, createRng } = require("../util/rng");
const { hullDeltas } = require("../stations/stockKeys");
const { STATION_STATES } = require("../stations/schema");
const { CLAIM_STATES, HELD_STATES } = require("../world/occupation/schema");
const S = require("./schema");
const W = require("./world/schema");
const { LAYER, layerOfRow } = require("./layer");
const { maxComposition, initialMembersOf, defensePeakOf } = require("./catalog");
const { chooseCandidate, stockCovers } = require("./candidates");
const { decidePlanned } = require("./machine");
const P = require("./power/schema");
const { UNKNOWN } = require("../names/fallback");

const STATION_ONLINE = STATION_STATES[0];
const SITE_SLOT = 0;
const PLAN_SLOT = 0;
const PLANNED_TYPES = Object.freeze([S.TYPE.REDOUBT, S.TYPE.FOUNDRY, S.TYPE.DEFENSE]);
const FUND_REASON = "heavy_event_fund";
const RETURN_REASON = "heavy_event_return";
const HULL_PREFIX = "group:";
const LABEL_SUFFIX = Object.freeze({ redoubt: "Redoubt", foundry: "Forward Foundry", defense: "Picket Under Siege" });
const MAX_LABEL = 64;
const ORPHAN_REASONS = Object.freeze(["STATION_DESTROYED", "ROW_NOT_FOUND", "STOCK_CAP", "STOCK_ITEMS_LIMIT"]);
const STATION_DESTROYED_STATE = STATION_STATES[3];
const MODE_PENDING = "pending";

class Rollback extends Error {
  constructor(reason, detail) {
    super(`heavyEvents rollback ${reason}`);
    this.name = "Rollback";
    this.reason = String(reason || "OTHER");
    this.detail = detail === undefined ? null : detail;
  }
}

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
};

const waveParamsOf = (settings) => ({ defenseWaves: settings.defenseWaves, waveGrowthPermille: settings.waveGrowthPermille });

function compositionOf(members, keep) {
  const by = new Map();
  for (const m of members) {
    if (!m || typeof m.hullGroup !== "string" || !keep(m)) continue;
    by.set(m.hullGroup, (by.get(m.hullGroup) || 0) + 1);
  }
  return [...by.keys()].sort().map((hullGroup) => ({ hullGroup, count: by.get(hullGroup) }));
}

const totalOf = (composition) => composition.reduce((a, x) => a + x.count, 0);

function stockFactsOf(items) {
  const hullStock = {};
  let mineralUnits = 0;
  for (const it of items || []) {
    if (it.itemKind === "hull" && typeof it.itemKey === "string" && it.itemKey.startsWith(HULL_PREFIX)) {
      hullStock[it.itemKey.slice(HULL_PREFIX.length)] = Number(it.quantity);
    } else if (it.itemKind === "mineral") {
      mineralUnits += Number(it.quantity);
    }
  }
  return { hullStock, mineralUnits };
}

function stationsRepoOf(env) {
  const st = safe(() => env.getStations(), null);
  const mode = st && typeof st.getMode === "function" ? safe(() => st.getMode(), "off") : "off";
  return mode === "ready" && st.repository ? st.repository : null;
}

function stationsPending(env) {
  const st = safe(() => env.getStations(), null);
  return Boolean(st && typeof st.getMode === "function" && safe(() => st.getMode(), "off") === MODE_PENDING);
}

function returnStationInTx(tx, stations, row) {
  const own = stations.getStation(tx, row.stationId);
  if (!own || own.ok !== true) throw new Rollback("OTHER", (own && own.reason) || "STATION_READ_FAILED");
  const rec = own.record;
  if (rec && rec.state !== STATION_DESTROYED_STATE && rec.ownerFactionId === row.factionId) return row.stationId;
  const listed = stations.listStationsOfFaction(tx, row.factionId, { states: [STATION_ONLINE] });
  if (!listed || listed.ok !== true) throw new Rollback("OTHER", (listed && listed.reason) || "STATION_READ_FAILED");
  const pool = listed.records.filter((r) => r.stationId !== row.stationId);
  const near = pool.find((r) => r.systemId === row.systemId);
  return near ? near.stationId : (pool[0] ? pool[0].stationId : null);
}

function labelOf(env, factionId, type) {
  const name = safe(() => env.factionName(factionId), null);
  const suffix = LABEL_SUFFIX[type] || "Event";
  const head = typeof name === "string" && name.trim() !== "" ? name.trim() : UNKNOWN.faction;
  return `${head.slice(0, MAX_LABEL - suffix.length - 1)} ${suffix}`;
}

function nearSystems(env, bands) {
  const presence = safe(() => env.getPresence(), null);
  const status = presence && typeof presence.getStatus === "function" ? safe(() => presence.getStatus(), null) : null;
  if (!status || status.available !== true || status.stale === true) return { ok: false, reason: "PRESENCE" };
  const within = typeof presence.observedWithin === "function"
    ? safe(() => presence.observedWithin(env.settings.presenceRadiusJumps), null) : null;
  if (!within || within.ok !== true || !Array.isArray(within.systems)) return { ok: false, reason: "PRESENCE" };
  const g = safe(() => env.getGraph(), null);
  const graph = g && typeof g.getGraph === "function" ? safe(() => g.getGraph(), null) : null;
  const universe = graph && graph.ok === true && graph.graph ? graph.graph : null;
  const out = [];
  for (const entry of within.systems) {
    const systemId = Array.isArray(entry) ? entry[0] : null;
    if (!Number.isSafeInteger(systemId) || systemId <= 0) continue;
    const vertex = universe ? safe(() => universe.getSystem(systemId), null) : null;
    const band = vertex && typeof vertex.secClass === "string" ? vertex.secClass : null;
    if (band !== null && bands.includes(band)) out.push({ systemId, band });
  }
  out.sort((a, b) => a.systemId - b.systemId);
  return { ok: true, systems: out };
}

function readPlanFactsInTx(tx, env, near, eventId, now) {
  const existing = env.repo.getInTx(tx, eventId);
  if (!existing.ok) throw new Rollback("OTHER", existing.reason);
  if (existing.row) return { duplicate: true };
  const stations = stationsRepoOf(env);
  if (!stations) throw new Rollback("STATIONS_NOT_READY");
  const worldRepo = safe(() => env.getWorldRepository(), null);
  if (!worldRepo || typeof worldRepo.getSystem !== "function") throw new Rollback("OTHER", "WORLD_NOT_READY");
  const kinds = S.parseFactionKinds(env.settings.factionKinds) || [];
  const defenseOn = env.settings[S.TYPE_SWITCH_KEY[S.TYPE.DEFENSE]] === true;
  const systems = [];
  for (const sys of near) {
    if (systems.length >= env.settings.maxCandidateSystems) break;
    const w = worldRepo.getSystem(tx, sys.systemId, { includeInfluence: false });
    const system = w && w.ok === true && w.system ? w.system : null;
    const controller = system ? system.controllerFactionId : null;
    if (!Number.isSafeInteger(controller) || controller <= 0) continue;
    const kind = safe(() => env.getFactionKind(controller), null);
    const occupier = system.occupierFactionId;
    const occupation = defenseOn && CLAIM_STATES.includes(system.occupationState) && Number.isSafeInteger(occupier)
      && occupier > 0 && occupier !== controller ? { state: system.occupationState, occupierFactionId: occupier,
        occupierKind: safe(() => env.getFactionKind(occupier), null) } : null;
    if (!kinds.includes(kind) && occupation === null) continue;
    systems.push({ systemId: sys.systemId, band: sys.band, controllerFactionId: controller, controllerKind: kind,
      occupation, stations: [] });
  }
  const lastEndedAt = new Map();
  for (const sys of systems) {
    const list = stations.listStationsInSystem(tx, sys.systemId);
    const records = list && list.ok === true ? list.records : [];
    const live = records.filter((r) => r.state === STATION_ONLINE);
    const stocks = live.length > 0 ? stations.getStocks(tx, live.map((r) => r.stationId)) : null;
    sys.stations = live.map((r) => {
      const st = stocks && stocks.ok === true ? stocks.byStation.get(r.stationId) : null;
      return { stationId: r.stationId, factionId: r.ownerFactionId, state: r.state,
        ...stockFactsOf(st ? st.items : []) };
    });
    const ended = env.repo.lastEndedInSystemInTx(tx, sys.systemId);
    if (ended.ok && ended.endedAt !== null) lastEndedAt.set(sys.systemId, ended.endedAt);
  }
  const open = env.repo.listOpenInTx(tx, { limit: S.OPEN_SCAN_LIMIT });
  if (!open.ok) throw new Rollback("OTHER", open.reason);
  return { duplicate: false, facts: { now, systems, lastEndedAt,
    open: open.rows.map((r) => ({ systemId: r.systemId, factionId: r.factionId, eventType: r.eventType,
      state: r.state })) } };
}

function capTier(env, candidate, facts) {
  const s = env.settings;
  if (candidate.eventType === S.TYPE.DEFENSE) {
    const peak = defensePeakOf(candidate.tier, s.maxUpscaleSteps, waveParamsOf(s));
    return peak.ok && peak.total <= s.maxShipsPerEvent ? candidate : null;
  }
  if (candidate.total <= s.maxShipsPerEvent) return candidate;
  const station = facts.systems.find((x) => x.systemId === candidate.systemId).stations
    .find((st) => st.stationId === candidate.stationId);
  for (let tier = candidate.tier - 1; tier >= 1; tier -= 1) {
    const comp = maxComposition(candidate.eventType, tier, s.maxUpscaleSteps, waveParamsOf(s));
    if (!comp.ok || comp.total > s.maxShipsPerEvent) continue;
    if (candidate.funded && !(station && stockCovers(station.hullStock, comp.composition))) continue;
    return { ...candidate, tier, composition: comp.composition, total: comp.total };
  }
  return null;
}

function planPass(env, now) {
  const s = env.settings;
  const bucket = Math.floor(now / s.planIntervalMs);
  const eventId = S.eventIdOf(bucket, PLAN_SLOT);
  const planKey = S.planKeyOf(s.planIntervalMs, bucket, PLAN_SLOT);
  const bands = S.parseSecurityBands(s.securityBands) || [];
  const near = nearSystems(env, bands);
  if (!near.ok) return { ok: false, reason: near.reason };
  if (!stationsRepoOf(env)) return { ok: false, reason: "STATIONS_NOT_READY" };

  const read = env.store.transaction("heavyEvents.planRead", (tx) => readPlanFactsInTx(tx, env, near.systems,
    eventId, now));
  if (!read.ok) return refusalOf(read);
  if (read.value.duplicate) return { ok: true, outcome: "DUPLICATE", eventId };
  const facts = read.value.facts;
  const seed = deriveSeed(env.worldSeed, planKey);
  const cfg = { ...s };
  for (const type of S.TYPES) if (!PLANNED_TYPES.includes(type)) cfg[S.TYPE_SWITCH_KEY[type]] = false;
  const choice = chooseCandidate(facts, cfg, createRng(seed));
  if (!choice.ok) {
    return { ok: false, reason: S.CANDIDATE_REASON_RANK.includes(choice.reason) ? choice.reason : "OTHER",
      detail: choice.reason };
  }
  const candidate = capTier(env, choice.candidate, facts);
  if (!candidate) return { ok: false, reason: "SHIPS_CAP" };
  const built = initialMembersOf(candidate.eventType, candidate.tier, s.maxUpscaleSteps, waveParamsOf(s));
  if (!built.ok) return { ok: false, reason: "OTHER", detail: built.reason };
  const expiresAt = now + s.plannedTtlMs;
  const defense = candidate.eventType === S.TYPE.DEFENSE;
  const label = labelOf(env, defense ? candidate.beneficiaryFactionId : candidate.factionId, candidate.eventType);

  const write = env.store.transaction("heavyEvents.plan", (tx) => {
    const existing = env.repo.getInTx(tx, eventId);
    if (!existing.ok) throw new Rollback("OTHER", existing.reason);
    if (existing.row) return { duplicate: true };
    if (candidate.funded) {
      const stations = stationsRepoOf(env);
      if (!stations) throw new Rollback("STATIONS_NOT_READY");
      const deltas = hullDeltas(candidate.composition, -1);
      if (!deltas.ok) throw new Rollback("OTHER", deltas.reason);
      const fund = stations.applyStockChange(tx, { stationId: candidate.stationId, key: S.fundKeyOf(eventId),
        reason: FUND_REASON, at: now, deltas: deltas.deltas });
      if (!fund || fund.ok !== true) throw new Rollback((fund && fund.reason) || "OTHER");
    }
    const planned = env.repo.planInTx(tx, { eventId, planKey, eventType: candidate.eventType, tier: candidate.tier,
      systemId: candidate.systemId, factionId: candidate.factionId,
      beneficiaryFactionId: candidate.beneficiaryFactionId, stationId: candidate.stationId, members: built.members,
      funded: candidate.funded, integrity: defense ? S.INTEGRITY_START : null, seed, at: now, expiresAt,
      dueAt: expiresAt });
    if (!planned.ok) throw new Rollback("OTHER", planned.reason);
    if (planned.duplicate) throw new Rollback("OTHER", "PLAN_DUPLICATE");
    const sites = safe(() => env.getSites(), null);
    if (!sites || typeof sites.createSiteInTx !== "function") throw new Rollback("OTHER", "SITES_UNAVAILABLE");
    const site = sites.createSiteInTx(tx, { eventId, slot: SITE_SLOT, systemId: candidate.systemId,
      templateId: s.beaconTemplateId, label, factionId: candidate.factionId,
      expiresAt: expiresAt + s.engagedMaxMs + s.aftermathMs });
    if (!site || site.ok !== true) throw new Rollback((site && site.reason) || "OTHER");
    return { duplicate: false };
  });
  if (!write.ok) return refusalOf(write);
  if (write.value.duplicate) return { ok: true, outcome: "DUPLICATE", eventId };
  return { ok: true, outcome: "PLANNED", eventId, eventType: candidate.eventType, tier: candidate.tier,
    systemId: candidate.systemId, total: candidate.funded ? candidate.total : 0 };
}

function refusalOf(tx) {
  const reason = tx.error instanceof Rollback ? tx.error.reason : "OTHER";
  const known = S.PLAN_REFUSALS.includes(reason) || S.CANDIDATE_REASON_RANK.includes(reason);
  const detail = tx.error instanceof Rollback ? tx.error.detail : tx.reason;
  return { ok: false, reason: known ? reason : "OTHER", detail: known ? detail : `${reason}${detail ? ` ${detail}` : ""}` };
}

function endInTx(tx, env, row, end, now) {
  const patch = { endedAt: now, endReason: end.reason, siteReleased: true };
  if (end.rewardState) patch.rewardState = end.rewardState;
  if (end.integrity !== undefined) patch.integrity = end.integrity;
  const moved = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: row.version, from: row.state,
    to: end.to, patch, at: now, reason: end.reason });
  if (!moved.ok) throw new Rollback("OTHER", moved.reason);
  const { returned, orphaned } = moved.duplicate === true || row.state === S.STATE.CLEARED
    ? { returned: 0, orphaned: 0 } : returnHullsInTx(tx, env, row, now);
  const sites = safe(() => env.getSites(), null);
  if (!sites || typeof sites.cleanupSitesInTx !== "function") throw new Rollback("OTHER", "SITES_UNAVAILABLE");
  const cleaned = sites.cleanupSitesInTx(tx, row.eventId, end.to === S.STATE.COMPLETED ? "EVENT_END"
    : "EVENT_CANCELLED");
  if (!cleaned || cleaned.ok !== true) throw new Rollback("OTHER", (cleaned && cleaned.reason) || "CLEANUP_FAILED");
  return { duplicate: moved.duplicate === true, returned, orphaned };
}

function returnHullsInTx(tx, env, row, now) {
  let returned = 0;
  let orphaned = 0;
  const back = row.funded && row.stationId ? compositionOf(row.members, (m) => m.state !== S.MEMBER_STATE.DESTROYED)
    : [];
  if (back.length > 0) {
    const stations = stationsRepoOf(env);
    if (!stations) throw new Rollback("STATIONS_NOT_READY");
    const deltas = hullDeltas(back, 1);
    if (!deltas.ok) throw new Rollback("OTHER", deltas.reason);
    const to = returnStationInTx(tx, stations, row);
    const r = to === null ? { ok: false, reason: "STATION_LOST" } : stations.applyStockChange(tx, { stationId: to,
      key: S.returnKeyOf(row.eventId), reason: RETURN_REASON, at: now, deltas: deltas.deltas });
    if (r && r.ok === true) {
      if (!r.duplicate) returned = totalOf(back);
    } else if (to === null || (r && ORPHAN_REASONS.includes(r.reason))) {
      orphaned = totalOf(back);
    } else {
      throw new Rollback("OTHER", (r && r.reason) || "RETURN_FAILED");
    }
  }
  return { returned, orphaned };
}

function causeHoldsInTx(tx, env, row) {
  if (env.settings[S.TYPE_SWITCH_KEY[row.eventType]] !== true) return false;
  const owner = row.beneficiaryFactionId === null ? row.factionId : row.beneficiaryFactionId;
  const stations = stationsRepoOf(env);
  if (stations && row.stationId) {
    const st = stations.getStation(tx, row.stationId);
    if (st && st.ok === true && (!st.record || st.record.state !== STATION_ONLINE || st.record.ownerFactionId !== owner)) {
      return false;
    }
  }
  const worldRepo = safe(() => env.getWorldRepository(), null);
  if (worldRepo && typeof worldRepo.getSystem === "function") {
    const w = worldRepo.getSystem(tx, row.systemId, { includeInfluence: false });
    if (w && w.ok === true && w.system && w.system.controllerFactionId !== owner) return false;
    if (w && w.ok === true && w.system && row.eventType === S.TYPE.DEFENSE
      && (!CLAIM_STATES.includes(w.system.occupationState) || w.system.occupierFactionId !== row.factionId)) {
      return false;
    }
  }
  return true;
}

const layerOf = (row) => layerOfRow(row) || (P.isPowerType(row.eventType) ? LAYER.POWER : LAYER.HEAVY);

function stagingOffInTx(tx, env, row) {
  const invasions = typeof env.getInvasions === "function" ? safe(() => env.getInvasions(), null) : null;
  if (!invasions || typeof invasions.listBeachheadsInTx !== "function") return null;
  const r = safe(() => invasions.listBeachheadsInTx(tx, { limit: 1, systems: [row.systemId] }), null);
  if (!r || r.ok !== true || !Array.isArray(r.beachheads)) return null;
  return r.beachheads.some((b) => b && b.systemId === row.systemId && b.factionId === row.factionId)
    ? null : S.END_REASON.CANCELLED;
}

function worldOffInTx(tx, env, row) {
  const ws = env.world;
  if (!ws || ws.enabled !== true) return S.END_REASON.DISABLED;
  const weightKey = Object.prototype.hasOwnProperty.call(W.KIND_WEIGHT_KEY, row.variant)
    ? W.KIND_WEIGHT_KEY[row.variant] : null;
  if (weightKey === null || !(ws[weightKey] > 0)) return "TYPE_OFF";
  if (row.variant === W.KIND.STAGING) return stagingOffInTx(tx, env, row);
  if (row.variant !== W.KIND.HIDEOUT) return null;
  const worldRepo = safe(() => env.getWorldRepository(), null);
  if (worldRepo && typeof worldRepo.getSystem === "function") {
    const w = worldRepo.getSystem(tx, row.systemId, { includeInfluence: false });
    if (w && w.ok === true && w.system && (w.system.occupierFactionId !== row.factionId
      || !(HELD_STATES.includes(w.system.occupationState) || CLAIM_STATES.includes(w.system.occupationState)))) {
      return S.END_REASON.CANCELLED;
    }
  }
  return null;
}

function layerOffInTx(tx, env, row) {
  const layer = layerOf(row);
  if (layer === LAYER.WORLD) return worldOffInTx(tx, env, row);
  if (layer === LAYER.INCURSION) return env.incursionEnabled === true ? null : S.END_REASON.DISABLED;
  if (layer !== LAYER.POWER) return env.settings.enabled === true ? null : S.END_REASON.DISABLED;
  const ps = env.power;
  if (!ps || ps.enabled !== true) return S.END_REASON.DISABLED;
  if (!(ps[P.TYPE_WEIGHT_KEY[row.eventType]] > 0)) return "TYPE_OFF";
  const worldRepo = safe(() => env.getWorldRepository(), null);
  if (worldRepo && typeof worldRepo.getSystem === "function") {
    const w = worldRepo.getSystem(tx, row.systemId, { includeInfluence: false });
    if (w && w.ok === true && w.system && w.system.controllerFactionId !== row.factionId) return S.END_REASON.CANCELLED;
  }
  return null;
}

function pumpPlanned(env, now) {
  const out = { expired: 0, cancelled: 0, disabled: 0, power: {}, world: {}, returned: 0, orphaned: 0, errors: 0,
    lastError: null };
  const read = env.store.transaction("heavyEvents.pumpRead", (tx) => {
    const open = env.repo.listOpenInTx(tx, { limit: S.OPEN_SCAN_LIMIT });
    if (!open.ok) throw new Rollback("OTHER", open.reason);
    const decided = [];
    for (const row of open.rows) {
      if (row.state !== S.STATE.PLANNED && row.state !== S.STATE.ENGAGED) continue;
      const off = layerOffInTx(tx, env, row);
      if (off === S.END_REASON.CANCELLED && row.state !== S.STATE.PLANNED) continue;
      const layer = layerOf(row);
      if (off !== null) {
        decided.push({ eventId: row.eventId, action: "CANCEL", from: row.state, off, layer });
        continue;
      }
      if (row.state !== S.STATE.PLANNED) continue;
      const d = decidePlanned(row, { now, siteActive: null, gridPlayers: null, sceneLoaded: false,
        causeHolds: layer !== LAYER.HEAVY ? true : causeHoldsInTx(tx, env, row) });
      if (d.action === "EXPIRE" || d.action === "CANCEL") {
        decided.push({ eventId: row.eventId, action: d.action, from: row.state, off: null, layer });
      }
    }
    return decided;
  });
  if (!read.ok) {
    out.errors += 1;
    out.lastError = refusalOf(read).detail;
    return out;
  }
  for (const d of read.value) {
    const expire = d.action === "EXPIRE";
    const endReason = expire ? S.END_REASON.EXPIRED
      : (d.off === S.END_REASON.DISABLED ? S.END_REASON.DISABLED : S.END_REASON.CANCELLED);
    const r = env.store.transaction("heavyEvents.end", (tx) => {
      const got = env.repo.getInTx(tx, d.eventId);
      if (!got.ok || !got.row || got.row.state !== d.from) return null;
      return endInTx(tx, env, got.row, { to: expire ? S.STATE.EXPIRED : S.STATE.CANCELLED, reason: endReason }, now);
    });
    if (!r.ok) {
      out.errors += 1;
      out.lastError = `${d.eventId} ${refusalOf(r).detail || r.reason}`;
      continue;
    }
    if (!r.value || r.value.duplicate) continue;
    if (expire) out.expired += 1;
    else if (d.off !== null && d.layer === LAYER.POWER) out.power[d.off] = (out.power[d.off] || 0) + 1;
    else if (d.off !== null && d.layer === LAYER.WORLD) out.world[d.off] = (out.world[d.off] || 0) + 1;
    else if (d.off === S.END_REASON.DISABLED) out.disabled += 1;
    else out.cancelled += 1;
    out.returned += r.value.returned;
    out.orphaned += r.value.orphaned;
  }
  return out;
}

module.exports = { planPass, pumpPlanned, endInTx, returnHullsInTx, Rollback, compositionOf, stationsPending,
  stationsRepoOf, PLANNED_TYPES, nearSystems, stockFactsOf, refusalOf, labelOf };
