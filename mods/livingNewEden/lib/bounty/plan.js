"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { DATA } = require("../names/generate");
const { styleFor } = require("../names/styles");
const S = require("./schema");
const { LEVEL_WEIGHTS, MAX_LEVEL, ARCHETYPE_WEIGHTS, SMUGGLER_MIN_LEVEL, SMUGGLER_REWARD_PERMILLE } =
  require("./data/levels");
const { CORP_SUFFIXES, DESCRIPTION } = require("./data/gangNames");
const { levelOrder } = require("./territory");

const PERMILLE = 1000;
const FALLBACK_ARCHETYPE = "RUNNER";
const TICKER_LETTERS = 3;
const MAX_CORP_NAME = 50;
const MAX_TICKER = 5;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const ascending = (a, b) => a - b;

function weighted(rng, entries) {
  let total = 0;
  for (const [, w] of entries) total += w;
  let r = rng.nextInt(0, total - 1);
  for (const [value, w] of entries) {
    if (r < w) return value;
    r -= w;
  }
  return entries[entries.length - 1][0];
}

function stayOf(rng, levelData, minStayMs) {
  const [lo, hi] = levelData.stayMs;
  return Math.max(rng.nextInt(lo, hi), Number.isSafeInteger(minStayMs) && minStayMs > 0 ? minStayMs : 0);
}

function classesOf(data, classRoll, highsecEnabled) {
  const allowed = (data.secClasses || []).filter((c) => c !== "highsec" || highsecEnabled !== false);
  if (allowed.length < 2 || !allowed.includes("highsec")) return allowed;
  const others = allowed.filter((c) => c !== "highsec");
  return classRoll < (Number.isInteger(data.highsecPermille) ? data.highsecPermille : 0) ? ["highsec", ...others]
    : [...others, "highsec"];
}

const isTerritory = (t) => Boolean(t && t.factionOf instanceof Map && t.lists instanceof Map);

function rollTarget(p) {
  if (!p || !Number.isInteger(p.worldSeed) || !isId(p.slot) || !isId(p.cycle) || !isId(p.factionId)
    || !isTime(p.now) || !p.levels || !isTerritory(p.territory) || !(p.busySystems instanceof Set)
    || !Number.isInteger(p.smugglerPermille)
    || (p.rewardPermille !== undefined && !(Number.isSafeInteger(p.rewardPermille) && p.rewardPermille >= 0))) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const rewardPermille = p.rewardPermille === undefined ? PERMILLE : p.rewardPermille;
  const seed = deriveSeed(p.worldSeed >>> 0, S.RNG_STREAM_TARGET, p.slot, p.cycle);
  const rng = createRng(seed);
  const base = weighted(rng, LEVEL_WEIGHTS);
  if (!p.levels[base]) return { ok: false, reason: "INVALID_INPUT" };
  const baseArchetype = weighted(rng, ARCHETYPE_WEIGHTS[base]);
  const smugglerRoll = rng.nextInt(0, PERMILLE - 1);
  const classRoll = rng.nextInt(0, PERMILLE - 1);
  const lists = p.territory.lists.get(p.factionId) || null;
  let found = null;
  for (const level of levelOrder(base, MAX_LEVEL)) {
    const data = p.levels[level];
    if (!data || !lists) continue;
    const classes = classesOf(data, classRoll, p.highsecEnabled);
    for (let c = 0; c < classes.length && !found; c += 1) {
      const list = lists[classes[c]] || [];
      if (list.length === 0) continue;
      const start = rng.nextInt(0, list.length - 1);
      for (let k = 0; k < list.length; k += 1) {
        const id = list[(start + k) % list.length];
        if (!p.busySystems.has(id)) {
          found = { level, data, systemId: id, classFallback: c > 0 };
          break;
        }
      }
    }
    if (found) break;
  }
  if (!found) return { ok: false, reason: "NO_SYSTEM" };
  const { level, data, systemId } = found;
  const archetype = ARCHETYPE_WEIGHTS[level].some(([a]) => a === baseArchetype) ? baseArchetype : FALLBACK_ARCHETYPE;
  const smuggler = level >= SMUGGLER_MIN_LEVEL && smugglerRoll < p.smugglerPermille ? 1 : 0;
  const nextMoveAt = p.now + stayOf(rng, data, p.minStayMs);
  const scaled = Math.floor((data.rewardIsk * rewardPermille) / PERMILLE);
  const rewardIsk = smuggler === 1 ? Math.floor((scaled * SMUGGLER_REWARD_PERMILLE) / PERMILLE) : scaled;
  return { ok: true, row: { level, archetype, smuggler, systemId, nextMoveAt, expiresAt: p.now + data.lifetimeMs,
    rewardIsk, seed }, fallback: level !== base, classFallback: found.classFallback };
}

function pickNextSystem(p) {
  if (!p || !Number.isInteger(p.seed) || !isTime(p.stayIndex) || !isId(p.systemId) || !p.levels
    || !p.levels[p.level] || !isId(p.factionId) || !isTerritory(p.territory) || !p.graph
    || typeof p.graph.getNeighbors !== "function" || typeof p.graph.getSystem !== "function"
    || !(p.busySystems instanceof Set) || !isTime(p.now)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const data = p.levels[p.level];
  const allowed = classesOf(data, 0, p.highsecEnabled);
  const here = p.graph.getSystem(p.systemId);
  const keep = here && allowed.includes(here.secClass) ? here.secClass : null;
  const rng = createRng(deriveSeed(p.seed >>> 0, S.RNG_STREAM_MOVE, p.stayIndex));
  const neighbors = p.graph.getNeighbors(p.systemId) || [];
  const candidates = [];
  for (const n of neighbors) {
    if (p.territory.factionOf.get(n) !== p.factionId || p.busySystems.has(n)) continue;
    if (typeof p.isExcluded === "function" && p.isExcluded(n)) continue;
    const sys = p.graph.getSystem(n);
    if (sys && (keep !== null ? sys.secClass === keep : allowed.includes(sys.secClass))) candidates.push(n);
  }
  if (candidates.length === 0) return { ok: false, reason: "NO_NEIGHBOR" };
  candidates.sort(ascending);
  const systemId = candidates[rng.nextInt(0, candidates.length - 1)];
  return { ok: true, systemId, nextMoveAt: p.now + stayOf(rng, data, p.minStayMs) };
}

function slotLayout(slot, gangMembers) {
  if (!isId(slot) || !isId(gangMembers)) return { ok: false, reason: "INVALID_INPUT" };
  return { ok: true, gangId: Math.ceil(slot / gangMembers), memberIndex: (slot - 1) % gangMembers };
}

function bossOf(identity, memberIndex) {
  if (!identity || identity.ok !== true || identity.state !== "LINKED" || !Array.isArray(identity.characterIds)
    || !Array.isArray(identity.memberIndexes)) {
    return { ok: false, reason: "NOT_LINKED" };
  }
  const at = identity.memberIndexes.indexOf(memberIndex);
  const characterId = at >= 0 ? identity.characterIds[at] : undefined;
  return isId(characterId) ? { ok: true, characterId } : { ok: false, reason: "MEMBER_PENDING" };
}

function gangSpecOf(p) {
  if (!p || !isId(p.slot) || !isId(p.factionId) || !Number.isInteger(p.worldSeed) || !isId(p.members) || !p.home
    || !isId(p.home.stationId) || !isId(p.home.systemId) || !p.system || !Array.isArray(p.bloodlineIds)
    || p.bloodlineIds.length === 0) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const rng = createRng(deriveSeed(p.worldSeed >>> 0, S.RNG_STREAM_GANG, p.slot));
  const style = styleFor({ factionId: p.factionId }).style;
  const surname = rng.pick(DATA[style].last);
  const suffix = rng.pick(CORP_SUFFIXES);
  const name = `${surname} ${suffix}`.slice(0, MAX_CORP_NAME);
  const letters = surname.toUpperCase().replace(/[^A-Z]/g, "").slice(0, TICKER_LETTERS);
  const digits = String(p.slot);
  const ticker = `${(letters.length >= 2 ? letters : "OL").slice(0, MAX_TICKER - digits.length)}${digits}`;
  return { ok: true, spec: {
    ownerKind: S.OUTLAW_OWNER_KIND,
    ownerId: p.slot,
    corporation: { name, ticker, description: DESCRIPTION.replace("{corp}", name) },
    members: p.members,
    stationId: p.home.stationId,
    stationCorporationId: isId(p.home.corporationId) ? p.home.corporationId : null,
    systemId: p.home.systemId,
    constellationId: p.system.constellationId,
    regionId: p.system.regionId,
    bloodlineIds: p.bloodlineIds.slice(),
    securityRating: Number.isFinite(p.securityRating) ? p.securityRating : 0,
  } };
}

module.exports = { rollTarget, pickNextSystem, classesOf, gangSpecOf, weighted, slotLayout, bossOf };
