"use strict";

const RUMOUR_KINDS = Object.freeze(["ATTACK_STARTED", "SYSTEM_CAPTURED", "SYSTEM_RELEASED", "ATTACK_REPELLED",
  "SIEGE_STARTED", "SIEGE_ENDED", "HEAVY_EVENT_STARTED", "BATTLE", "GANK", "FC_LOST", "FC_RICH", "SIT_RESCUED",
  "SIT_LOST"]);
const BATTLE = "BATTLE";
const FC_KINDS = Object.freeze(["FC_LOST", "FC_RICH"]);
const SIT_KINDS = Object.freeze(["SIT_RESCUED", "SIT_LOST"]);
const SIT_KEY_PREFIX = "si:";
const SIT_OUTCOME_KIND = Object.freeze({ RESCUED: "SIT_RESCUED", LOST: "SIT_LOST", UNANSWERED: "SIT_LOST" });
const FC_KEY_PREFIX = "fc:";
const BATTLE_KEY_PREFIX = "b:";
const GANK = "GANK";
const GANK_KEY_PREFIX = "g:";

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isNonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function nameOrNull(v) {
  return typeof v === "string" && v !== "" ? v : null;
}

function toWarRumour(view) {
  if (!view || typeof view !== "object") return null;
  if (!RUMOUR_KINDS.includes(view.kind) || view.kind === BATTLE || view.kind === GANK
    || FC_KINDS.includes(view.kind) || SIT_KINDS.includes(view.kind)) return null;
  if (typeof view.eventKey !== "string" || view.eventKey === "" || !isPositiveInt(view.systemId)
    || !Number.isFinite(view.at)) return null;
  const systemName = nameOrNull(view.systemName);
  if (!systemName) return null;
  return Object.freeze({ key: view.eventKey, kind: view.kind, systemId: view.systemId, at: view.at,
    attackerName: nameOrNull(view.attackerName), defenderName: nameOrNull(view.defenderName), systemName,
    regionName: nameOrNull(view.regionName), losses: null });
}

function toBattleRumour(entry, placeOf, minLosses) {
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.battleId !== "string" || entry.battleId === "" || !isPositiveInt(entry.systemId)
    || !Number.isFinite(entry.at) || !isNonNegInt(entry.destroyedA) || !isNonNegInt(entry.destroyedB)) return null;
  const losses = entry.destroyedA + entry.destroyedB;
  if (losses < (isNonNegInt(minLosses) ? minLosses : 0)) return null;
  const place = typeof placeOf === "function" ? placeOf(entry.systemId) : null;
  const systemName = place ? nameOrNull(place.name) : null;
  if (!systemName) return null;
  return Object.freeze({ key: `${BATTLE_KEY_PREFIX}${entry.battleId}`, kind: BATTLE, systemId: entry.systemId,
    at: entry.at, attackerName: null, defenderName: null, systemName, regionName: nameOrNull(place.regionName),
    losses });
}

function toGankRumour(event, placeOf) {
  if (!event || typeof event !== "object") return null;
  if (!isPositiveInt(event.systemId) || !isNonNegInt(event.bucket) || !Number.isFinite(event.at)
    || !isPositiveInt(event.shipsLost)) return null;
  const place = typeof placeOf === "function" ? placeOf(event.systemId) : null;
  const systemName = place ? nameOrNull(place.name) : null;
  if (!systemName) return null;
  return Object.freeze({ key: `${GANK_KEY_PREFIX}${event.systemId}:${event.bucket}`, kind: GANK,
    systemId: event.systemId, at: event.at, attackerName: null, defenderName: null, systemName,
    regionName: nameOrNull(place.regionName), losses: event.shipsLost });
}

function toFreeCorpRumour(item, placeOf) {
  if (!item || typeof item !== "object" || !FC_KINDS.includes(item.kind)) return null;
  if (typeof item.key !== "string" || !item.key.startsWith(FC_KEY_PREFIX) || item.key.length <= FC_KEY_PREFIX.length
    || !isPositiveInt(item.systemId) || !Number.isFinite(item.endedAt)) return null;
  const place = typeof placeOf === "function" ? placeOf(item.systemId) : null;
  const systemName = place ? nameOrNull(place.name) : null;
  if (!systemName) return null;
  return Object.freeze({ key: item.key, kind: item.kind, systemId: item.systemId, at: item.endedAt,
    attackerName: null, defenderName: nameOrNull(item.corpName), systemName, regionName: nameOrNull(place.regionName),
    losses: item.kind === "FC_LOST" && isPositiveInt(item.crewLost) ? item.crewLost : null });
}

function toSituationRumour(e, placeOf) {
  if (!e || typeof e !== "object" || !Object.prototype.hasOwnProperty.call(SIT_OUTCOME_KIND, e.outcome)) return null;
  if (typeof e.situationId !== "string" || e.situationId === "" || !isPositiveInt(e.systemId)
    || !Number.isFinite(e.at) || !isNonNegInt(e.victims) || !isNonNegInt(e.saved) || e.saved > e.victims) return null;
  const place = typeof placeOf === "function" ? placeOf(e.systemId) : null;
  const systemName = place ? nameOrNull(place.name) : null;
  if (!systemName) return null;
  const kind = SIT_OUTCOME_KIND[e.outcome];
  return Object.freeze({ key: `${SIT_KEY_PREFIX}${e.situationId}`, kind, systemId: e.systemId, at: e.at,
    attackerName: null, defenderName: null, systemName, regionName: nameOrNull(place.regionName),
    losses: kind === "SIT_RESCUED" ? e.saved : e.victims });
}

function createRumourRing(o) {
  const limit = o && isPositiveInt(o.size) ? o.size : 1;
  const byKey = new Map();
  return Object.freeze({
    add(r) {
      if (!r || typeof r.key !== "string" || byKey.has(r.key)) return false;
      byKey.set(r.key, r);
      while (byKey.size > limit) byKey.delete(byKey.keys().next().value);
      return true;
    },
    list: () => Object.freeze([...byKey.values()]),
    prune(now, maxAgeMs) {
      let removed = 0;
      for (const [key, r] of byKey) {
        if (now - r.at > maxAgeMs) {
          byKey.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
    size: () => byKey.size,
    clear: () => byKey.clear(),
  });
}

function eligibleRumours(rumours, listener, near, told, now, C) {
  const anyDistance = listener && listener.isHub === true && C.hubRumoursAnyDistance === true;
  const out = [];
  for (const r of Array.isArray(rumours) ? rumours : []) {
    if (!r || now - r.at > C.rumourMaxAgeMs || (r.systemId === listener.systemId && r.kind !== GANK)) continue;
    if (told && told.has(r.key)) continue;
    const jumps = near && typeof near.get === "function" ? near.get(r.systemId) : undefined;
    if (!anyDistance && !(Number.isSafeInteger(jumps) && jumps <= C.rumourMaxJumps)) continue;
    out.push(r);
  }
  return out.sort((a, b) => (b.at - a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

module.exports = { RUMOUR_KINDS, FC_KINDS, SIT_KINDS, toWarRumour, toBattleRumour, toGankRumour, toFreeCorpRumour,
  toSituationRumour, createRumourRing, eligibleRumours };
