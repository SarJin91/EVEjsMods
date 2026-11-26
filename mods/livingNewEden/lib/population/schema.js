"use strict";

const PILOTS_TABLE = "world_npc_pilots";
const META_TABLE = "world_npc_population";
const RULES_VERSION = 1;

const ARCHETYPE_NAMES = Object.freeze(["TRADER", "MINER", "RATTER", "EXPLORER", "COMMUTER"]);
const INTENT_NAMES = Object.freeze(["DOCK", "TRAVEL", "MINE", "RAT", "EXPLORE", "RESHIP"]);
const STATE_NAMES = Object.freeze(["DOCKED", "ACTIVE", "TRAVEL", "POD", "AWAY"]);

function codes(names) {
  return Object.freeze(Object.fromEntries(names.map((n, i) => [n, i + 1])));
}
const ARCHETYPE = codes(ARCHETYPE_NAMES);
const INTENT = codes(INTENT_NAMES);
const STATE = codes(STATE_NAMES);
const BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);

const nameOf = (names, code) => (Number.isInteger(code) && code >= 1 && code <= names.length ? names[code - 1] : null);

const COUNTER_NAMES = Object.freeze(["deferred.GOVERNOR", "deferred.ROUTE_BUDGET", "deferred.FLUSH_GOVERNOR",
  "flushForced", "flushFailed", "fastForward", "noRoute", "seeded", "retired", "loadNormalized",
  "stationsReadFailed", "deferred.PREWARM_BUDGET", "prewarmed", "attracted", "tierRefreshes",
  "live.claimed", "live.claimRefused", "live.noRoute", "live.ownTimeout", "live.JUMPED", "live.DOCKED", "live.LEFT",
  "live.EXPIRED", "live.STUCK", "live.REFUSED", "live.KILLED",
  "deferred.CONTEXT_GOVERNOR", "contextRefreshes", "context.sourceFailed", "context.retreats", "context.attractedDest",
  "context.stayedDocked",
  "activeLife.noRouteInSpace", "activeLife.hubSkipped",
  "standing.routeRefused", "standing.friendlyPass",
  "corps.founded", "corps.joined", "corps.left", "corps.dissolved", "corps.orphanMembers", "corps.nameRefused",
  "deferred.CORPS_GOVERNOR",
  "groups.formed", "groups.dissolved", "groups.orphaned", "groups.noMembers", "groups.capped",
  "hulls.restrictedRoutes", "hulls.groupRefused", "hulls.noLiveProfile",
  "live.memberKilled",
  "lifecycle.away", "lifecycle.awayCapped", "lifecycle.returned", "lifecycle.returnedHome", "lifecycle.quit",
  "lifecycle.reborn", "lifecycle.rookieFallback", "lifecycle.wakeFailed",
  "lifecycle.promoted", "lifecycle.homeMoved", "lifecycle.careerSeeded",
  "corps.dissolvedInactive", "corps.skippedInactive"]);
const LIVE_OUTCOMES = Object.freeze(["JUMPED", "DOCKED", "LEFT", "EXPIRED", "STUCK", "REFUSED", "KILLED"]);
const TRAFFIC_MODES = Object.freeze(["replace", "mix"]);

const TIER_NAMES = Object.freeze(["FAR", "NEAR", "LIVE"]);
const TIER = codesFrom0(TIER_NAMES);
const SUBSTATE_NAMES = Object.freeze(["DOCKED", "UNDOCKING", "AT_GATE", "IN_SPACE"]);
const SUBSTATE = codesFrom0(SUBSTATE_NAMES);
const FLAG_NEAR = 1;
const SUBSTATE_SHIFT = 1;
const SUBSTATE_MASK = 6;
const PREWARM_MASK = FLAG_NEAR | SUBSTATE_MASK;

function codesFrom0(names) {
  return Object.freeze(Object.fromEntries(names.map((n, i) => [n, i])));
}

const MEMORY_ESTIMATE = Object.freeze({ MAP_ENTRY_BYTES: 64, SET_ENTRY_BYTES: 32, QUEUE_ENTRY_BYTES: 96,
  NAME_ENTRY_BYTES: 96, ROUTE_HOP_BYTES: 8 });

function parseSystemIdList(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (parts.length < 1 || parts.length > 16) return null;
  const ids = [];
  for (const part of parts) {
    if (!/^\d{1,10}$/.test(part)) return null;
    const id = Number(part);
    if (!Number.isSafeInteger(id) || id <= 0 || ids.includes(id)) return null;
    ids.push(id);
  }
  return Object.freeze(ids);
}

function parsePermilleList(text, count) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== count) return null;
  const out = [];
  let sum = 0;
  for (const part of parts) {
    if (!/^\d{1,4}$/.test(part)) return null;
    const v = Number(part);
    if (v > 1000) return null;
    out.push(v);
    sum += v;
  }
  return sum > 0 ? Object.freeze(out) : null;
}

function parseIntList(text, count, max) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== count) return null;
  const out = [];
  for (const part of parts) {
    if (!/^\d{1,10}$/.test(part)) return null;
    const v = Number(part);
    if (!Number.isSafeInteger(v) || v > max) return null;
    out.push(v);
  }
  return Object.freeze(out);
}

const HULL_AVOID_BANDS = Object.freeze(["lowsec", "nullsec"]);
const HULL_AVOID_NONE = "none";

function parseAvoidSecClasses(text) {
  if (typeof text !== "string") return null;
  const value = text.trim();
  if (value === HULL_AVOID_NONE) return Object.freeze([]);
  const parts = value.split(",").map((s) => s.trim());
  if (parts.length < 1 || parts.some((p) => !HULL_AVOID_BANDS.includes(p)) || new Set(parts).size !== parts.length) {
    return null;
  }
  return Object.freeze(HULL_AVOID_BANDS.filter((b) => parts.includes(b)));
}

function hullsSettingsOf(P) {
  const H = P && P.hulls && typeof P.hulls === "object" ? P.hulls : {};
  if (H.enabled !== true) return Object.freeze({ ...H, enabled: false, avoidSecClasses: Object.freeze([]) });
  const avoid = parseAvoidSecClasses(H.restrictedAvoidSecClasses);
  return Object.freeze({ ...H, enabled: true, avoidSecClasses: avoid || Object.freeze(["nullsec"]) });
}

function activeLifeOf(P) {
  if (!P.activeLife || typeof P.activeLife !== "object" || P.activeLife.enabled !== true) {
    return Object.freeze({ ...(P.activeLife && typeof P.activeLife === "object" ? P.activeLife : {}), enabled: false });
  }
  const L = P.activeLife;
  const { ARCHETYPES } = require("./data/archetypes");
  const byArchetype = {};
  for (const [code, arch] of Object.entries(ARCHETYPES)) {
    byArchetype[code] = Object.freeze(arch.weights.map((w, i) => (i === INTENT.DOCK - 1
      ? Math.floor((w * L.dockWeightPermille) / 1000) : w)));
  }
  return Object.freeze({ ...L, enabled: true, weightsByArchetype: Object.freeze(byArchetype) });
}

function standingsOf(P) {
  const T = P.standings && typeof P.standings === "object" ? P.standings : {};
  const swap = (lo, hi) => (Number.isFinite(lo) && Number.isFinite(hi) && lo > hi ? [hi, lo] : [lo, hi]);
  const [empireBaseMin, empireBaseMax] = swap(T.empireBaseMin, T.empireBaseMax);
  const [pirateBaseMin, pirateBaseMax] = swap(T.pirateBaseMin, T.pirateBaseMax);
  return Object.freeze({ ...T, enabled: T.enabled === true, empireBaseMin, empireBaseMax, pirateBaseMin,
    pirateBaseMax });
}

function settingsOf(config) {
  const P = config && config.population;
  if (!P || typeof P !== "object") return null;
  const dwellMaxMs = Math.max(P.dwellMinMs, P.dwellMaxMs);
  const hopMaxMs = Math.max(P.hopMinMs, P.hopMaxMs);
  const near = P.near && typeof P.near === "object" ? Object.freeze({ ...P.near, enabled: P.near.enabled === true })
    : Object.freeze({ enabled: false });
  const observer = P.observer && typeof P.observer === "object" ? Object.freeze({ ...P.observer })
    : Object.freeze({ layerEnabled: false, panelEnabled: false });
  const live = P.live && typeof P.live === "object"
    ? Object.freeze({ ...P.live, trafficEnabled: P.live.trafficEnabled === true })
    : Object.freeze({ trafficEnabled: false });
  const context = P.context && typeof P.context === "object"
    ? Object.freeze({ ...P.context, enabled: P.context.enabled === true }) : Object.freeze({ enabled: false });
  return Object.freeze({ ...P, dwellMaxMs, hopMaxMs, near, observer, live, context, activeLife: activeLifeOf(P),
    standings: standingsOf(P),
    corps: require("./corps/schema").corpsSettingsOf(P),
    groups: require("./groups/schema").groupsSettingsOf(P),
    hulls: hullsSettingsOf(P),
    lifecycle: require("./lifecycle/schema").lifecycleSettingsOf(P),
    hopMeanMs: Math.max(1, Math.floor((P.hopMinMs + hopMaxMs) / 2)),
    flushMaxDeferMs: Math.max(P.flushIntervalMs, P.flushMaxDeferMs),
    hubSystemIds: parseSystemIdList(P.hubSystemIds) || Object.freeze([]),
    bandPermille: parsePermilleList(P.bandPermille, BANDS.length) || Object.freeze([700, 150, 150]),
    archetypePermille: parsePermilleList(P.archetypePermille, ARCHETYPE_NAMES.length)
      || Object.freeze([300, 200, 200, 100, 200]) });
}

const DDL = `
CREATE TABLE world_npc_pilots (
  pilot_id     INTEGER PRIMARY KEY,
  system_id    INTEGER NOT NULL,
  prev_id      INTEGER NOT NULL DEFAULT 0,
  dest_id      INTEGER NOT NULL DEFAULT 0,
  home_id      INTEGER NOT NULL,
  ship_type_id INTEGER NOT NULL,
  archetype    INTEGER NOT NULL,
  intent       INTEGER NOT NULL,
  state        INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  since_at     INTEGER NOT NULL,
  due_at       INTEGER NOT NULL,
  flags        INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE world_npc_population (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  rules_version INTEGER NOT NULL,
  size          INTEGER NOT NULL,
  seeded_at     INTEGER NOT NULL,
  flushed_at    INTEGER NOT NULL
) STRICT;
`;

function upPopulation(db) {
  db.exec(DDL);
}

module.exports = { PILOTS_TABLE, META_TABLE, RULES_VERSION, ARCHETYPE_NAMES, INTENT_NAMES, STATE_NAMES, ARCHETYPE,
  INTENT, STATE, BANDS, nameOf, COUNTER_NAMES, parseSystemIdList, parsePermilleList, parseIntList, settingsOf,
  standingsOf,
  upPopulation, TIER_NAMES, TIER, SUBSTATE_NAMES, SUBSTATE, FLAG_NEAR, SUBSTATE_SHIFT, SUBSTATE_MASK, PREWARM_MASK,
  LIVE_OUTCOMES, TRAFFIC_MODES, MEMORY_ESTIMATE, HULL_AVOID_BANDS, parseAvoidSecClasses, hullsSettingsOf };
