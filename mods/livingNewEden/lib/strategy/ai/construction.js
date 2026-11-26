"use strict";

const { bfs } = require("./bfs");
const { countCaptureCandidates } = require("./targeting");

const ACTIVE = "ACTIVE";
const READY = "ready";
const BUSY_STATES = Object.freeze(["CONTESTED", "INVASION"]);
const MINERAL_PREFIX = "mineral/";
const numberOr = (v, fallback) => (typeof v === "number" && !Number.isNaN(v) ? v : fallback);
const WAIT = "wait";
const UPWELL = "upwell";
const underLimit = (s, C) => (s.liveStations || 0) < C.maxPerSystem
  && (s.ownLiveStations || 0) < C.maxPerSystemPerFaction;

const DEV_HARD_NOTES = Object.freeze(["CONSTRUCTION_OFF", "CONSTRUCTION_INACTIVE", "CONSTRUCTION_TRUNCATED",
  "CONSTRUCTION_GLOBAL_CAP", "CONSTRUCTION_GAP", "CONSTRUCTION_BUSY", "CONSTRUCTION_NO_KIT",
  "CONSTRUCTION_NO_STOCK_DATA", "OUTPOST_CAP"]);
const STABLE = "STABLE";

function planConstruction(snapshot, supply, params) {
  const base = planBaseConstruction(snapshot, supply, params);
  const C = params.construction;
  const sc = snapshot.construction;
  if (!C || !C.dev || !sc || !(sc.devLevels instanceof Map)) return base;
  if (base.intents.length > 0 || base.notes.some((n) => DEV_HARD_NOTES.includes(n))
    || !snapshot.doctrine || snapshot.doctrine.buildsStations === false) return base;
  const dev = planDevStations(snapshot, supply, sc, C);
  return { intents: dev.intents, notes: [...base.notes, ...dev.notes] };
}

function planDevStations(snapshot, supply, sc, C) {
  const done = (note) => ({ intents: [], notes: [note] });
  if (sc.truncated === true) return done("CONSTRUCTION_TRUNCATED");
  const shared = sharedGateNote(sc, C);
  if (shared !== null) return done(shared);
  const open = Array.isArray(sc.open) ? sc.open : [];
  const room = Math.min(C.maxBuildsPerReview, C.maxOpenBuildsPerFaction - open.length,
    numberOr(C.maxOpenBuildsTotal, Infinity) - numberOr(sc.openTotal, 0));
  if (room <= 0) return done("CONSTRUCTION_DEV_BUSY");
  const sumOf = (id) => {
    const lv = sc.devLevels.get(id);
    return lv ? numberOr(lv.ind, 0) + numberOr(lv.trade, 0) : 0;
  };
  const qualifies = (id) => sc.devLevels.has(id) && sumOf(id) >= C.dev.minLevelSum;
  const devOpen = open.filter((b) => qualifies(b.systemId)).length;
  if (devOpen >= C.dev.maxOpen) return done("CONSTRUCTION_DEV_BUSY");
  const kitNote = kitShortNote(snapshot, sc, C);
  if (kitNote !== null) return done(kitNote);
  const f = snapshot.factionId;
  const stationSystems = new Set(supply.stationSystems || []);
  const building = new Set(open.map((b) => b.systemId));
  const indOf = (id) => numberOr(sc.devLevels.get(id).ind, 0);
  const sites = snapshot.systems.filter((s) => s.controllerFactionId === f && (s.occupationState || STABLE) === STABLE
    && !stationSystems.has(s.systemId) && !building.has(s.systemId) && underLimit(s, C) && qualifies(s.systemId))
    .map((s) => s.systemId)
    .sort((a, b) => sumOf(b) - sumOf(a) || indOf(b) - indOf(a) || a - b);
  if (sites.length === 0) return { intents: [], notes: [] };
  const intents = sites.slice(0, Math.min(room, C.dev.maxOpen - devOpen)).map((systemId, slot) => ({
    type: "BUILD_PLAN", slot, systemId, kitId: sc.kit.kitId }));
  return { intents, notes: ["CONSTRUCTION_DEV_PLAN"] };
}

function planBaseConstruction(snapshot, supply, params) {
  const done = (note) => ({ intents: [], notes: note ? [note] : [] });
  const C = params.construction;
  const sc = snapshot.construction;
  if (!C || !sc || sc.mode !== READY || !sc.kit || !(C.maxBuildsPerReview > 0)) return done("CONSTRUCTION_OFF");
  if (snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== READY) return done("CONSTRUCTION_INACTIVE");
  const d = snapshot.doctrine;
  if (d.buildsStations === false) return done(null);
  if (d.canOccupy !== true || d.expandsBeyondTheatre !== true) {
    if (!sc.outposts || sc.outposts.mode === "off") return done(null);
    return planOutposts(snapshot, sc, C);
  }
  if (sc.truncated === true) return done("CONSTRUCTION_TRUNCATED");
  if (supply.captureRoomKnown === true && supply.captureRoom === 0) return done("CONSTRUCTION_TERRITORY_LIMIT");
  const total = numberOr(C.maxOpenBuildsTotal, Infinity);
  const openTotal = numberOr(sc.openTotal, 0);
  const shared = sharedGateNote(sc, C);
  if (shared !== null) return done(shared);
  const since = Number.isSafeInteger(sc.sinceLastBuildMs) ? sc.sinceLastBuildMs : null;
  const targets = countCaptureCandidates(snapshot, supply, params);
  const overdueMs = numberOr(C.overdueMs, 0);
  const overdue = overdueMs > 0 && (since === null || since >= overdueMs);
  if (targets > numberOr(C.targetsGateMax, 0) && !overdue) return done("CONSTRUCTION_HAS_TARGETS");
  const open = Array.isArray(sc.open) ? sc.open : [];
  const room = Math.min(C.maxBuildsPerReview, C.maxOpenBuildsPerFaction - open.length, total - openTotal);
  if (room <= 0) return done("CONSTRUCTION_BUSY");
  const kitNote = kitShortNote(snapshot, sc, C);
  if (kitNote !== null) return done(kitNote);

  const f = snapshot.factionId;
  const far = supply.captureJumps + 1;
  const distOf = (id) => (supply.captureReach.has(id) ? supply.captureReach.get(id) : far);
  const stationSystems = new Set(supply.stationSystems || []);
  const building = new Set(open.map((b) => b.systemId));
  const sites = snapshot.systems.filter((s) => s.controllerFactionId === f && !BUSY_STATES.includes(s.occupationState)
    && !stationSystems.has(s.systemId) && !building.has(s.systemId) && underLimit(s, C))
    .map((s) => s.systemId)
    .sort((a, b) => distOf(b) - distOf(a) || a - b)
    .slice(0, C.maxSiteCandidates);

  const rows = new Map(snapshot.systems.map((s) => [s.systemId, s]));
  const theatre = new Set(snapshot.theatre);
  const targetable = typeof sc.targetable === "function" ? sc.targetable : () => false;
  const capturable = (id) => {
    const s = rows.get(id);
    if (!s) return true;
    if (s.controllerFactionId === f) return false;
    if (s.controllerFactionId !== null && s.controllerFactionId !== undefined
      && !snapshot.isHostile(s.controllerFactionId)) return false;
    return !(Number.isSafeInteger(s.occupierFactionId) && s.occupierFactionId !== f
      && BUSY_STATES.includes(s.occupationState));
  };
  const scored = [];
  for (const site of sites) {
    const area = bfs([site], snapshot.neighbors, { maxJumps: supply.captureJumps, maxSystems: params.maxBfsSystems });
    let gain = 0;
    for (const id of area.keys()) {
      if (supply.captureReach.has(id) || !(theatre.has(id) || targetable(id))) continue;
      if (capturable(id)) gain += 1;
    }
    if (gain >= C.minSiteGain) scored.push({ systemId: site, gain, dist: distOf(site) });
  }
  if (scored.length === 0) return done("CONSTRUCTION_NO_SITE");
  scored.sort((a, b) => b.gain - a.gain || b.dist - a.dist || a.systemId - b.systemId);
  const intents = scored.slice(0, room).map((s, slot) => ({ type: "BUILD_PLAN", slot, systemId: s.systemId,
    kitId: sc.kit.kitId }));
  const parallelNote = targets > 0 ? "CONSTRUCTION_PARALLEL" : null;
  const notes = ["CONSTRUCTION_PLAN"];
  if (parallelNote !== null) notes.unshift(parallelNote);
  return { intents, notes };
}

function sharedGateNote(sc, C) {
  const openTotal = numberOr(sc.openTotal, 0);
  if (openTotal >= numberOr(C.maxOpenBuildsTotal, Infinity)
    || numberOr(sc.liveTotal, 0) >= numberOr(C.maxLiveStationsTotal, Infinity)) return "CONSTRUCTION_GLOBAL_CAP";
  const since = Number.isSafeInteger(sc.sinceLastBuildMs) ? sc.sinceLastBuildMs : null;
  if (since !== null && since < numberOr(C.minGapMs, 0)) return "CONSTRUCTION_GAP";
  return null;
}

function kitShortNote(snapshot, sc, C) {
  if (C.requireKitInStock !== true) return null;
  const pr = snapshot.production;
  if (!pr || pr.mode !== READY || pr.truncated === true) return "CONSTRUCTION_NO_STOCK_DATA";
  for (const key of Object.keys(sc.kit.items)) {
    const k = key.startsWith(MINERAL_PREFIX) ? key.slice(MINERAL_PREFIX.length) : null;
    const have = k === null ? 0 : pr.stations.reduce((n, s) => n + (((s.minerals || {})[k]) || 0), 0);
    if (have < sc.kit.items[key]) return "CONSTRUCTION_NO_KIT";
  }
  return null;
}

function planOutposts(snapshot, sc, C) {
  const done = (note) => ({ intents: [], notes: [note] });
  if (sc.truncated === true) return done("CONSTRUCTION_TRUNCATED");
  const shared = sharedGateNote(sc, C);
  if (shared !== null) return done(shared);
  if (sc.outposts.mode === WAIT) return done("OUTPOST_WAIT");
  const open = Array.isArray(sc.open) ? sc.open : [];
  const maxOpen = numberOr(C.outpostMaxOpen, 0);
  if (open.length >= maxOpen) return done("CONSTRUCTION_BUSY");
  const ownUpwell = (snapshot.stations || []).filter((s) => s.kind === UPWELL).length;
  const maxStations = numberOr(C.outpostMaxStations, 0);
  if (ownUpwell + open.length >= maxStations) return done("OUTPOST_CAP");
  const kitNote = kitShortNote(snapshot, sc, C);
  if (kitNote !== null) return done(kitNote);
  const sites = (Array.isArray(sc.outposts.sites) ? sc.outposts.sites : []).filter((s) => underLimit(s, C))
    .sort((a, b) => b.borderNeighbours - a.borderNeighbours || a.systemId - b.systemId);
  if (sites.length === 0) return done("OUTPOST_NO_SITE");
  const room = Math.min(C.maxBuildsPerReview, maxOpen - open.length, maxStations - ownUpwell - open.length,
    numberOr(C.maxOpenBuildsTotal, Infinity) - numberOr(sc.openTotal, 0));
  if (room <= 0) return done("CONSTRUCTION_BUSY");
  const intents = sites.slice(0, room).map((s, slot) => ({ type: "BUILD_PLAN", slot, systemId: s.systemId,
    kitId: sc.kit.kitId }));
  return { intents, notes: ["OUTPOST_PLAN"] };
}

module.exports = { planConstruction, planBaseConstruction, planDevStations, DEV_HARD_NOTES };
