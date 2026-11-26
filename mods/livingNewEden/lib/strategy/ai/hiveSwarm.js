"use strict";

const { usableKinds } = require("./targeting");
const { bfs } = require("./bfs");

const ACTIVE = "ACTIVE";
const READY = "ready";
const FALLBACK_ROLE = "patrol";
const RAID_OPERATION_TYPE = "raid";
const HIVE_SWARM_MARKER_EVENT = "HIVE_SWARM_MARKER";

const none = () => ({ intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } });

function swarmBucketOf(at, cooldownMs) {
  return Math.floor(at / cooldownMs);
}

function hiveSwarmKey(factionId, bucket) {
  return `hive:swarm:v1:${factionId}:${bucket}`;
}

function candidatesOf(snapshot, supply, params) {
  const f = snapshot.factionId;
  const rows = new Map((snapshot.systems || []).map((s) => [s.systemId, s]));
  const fronts = new Set(Array.isArray(supply.frontTargets) ? supply.frontTargets : []);
  const kinds = usableKinds(snapshot, params);
  const capture = kinds.find((k) => k.offensive === true && k.captures === true) || null;
  const raid = kinds.find((k) => k.operationType === RAID_OPERATION_TYPE) || null;
  const captureReach = supply.captureReach instanceof Map ? supply.captureReach : new Map();
  const reach = supply.reach instanceof Map ? supply.reach : new Map();
  const out = [];
  for (const T of snapshot.lostHome.systemIds || []) {
    const row = rows.get(T);
    if (!row) continue;
    const c = row.controllerFactionId;
    if (c === null || c === undefined || c === f) continue;
    if (typeof snapshot.isHostile !== "function" || snapshot.isHostile(c) !== true) continue;
    if (fronts.has(T)) continue;
    if (capture && captureReach.has(T)) out.push({ T, kind: capture, rank: 0, jumps: captureReach.get(T) });
    else if (raid && reach.has(T)) out.push({ T, kind: raid, rank: 1, jumps: reach.get(T) });
  }
  return out.sort((a, b) => a.rank - b.rank || a.jumps - b.jumps || a.T - b.T);
}

function planHiveSwarm({ snapshot, supply, params, budget, slots }) {
  const out = none();
  const P = params && params.hive && params.hive.swarm;
  const d = snapshot && snapshot.doctrine;
  if (!P || !d || d.hive !== true) return out;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out;
  const S = snapshot.hive && snapshot.hive.swarm;
  if (!S) return out;
  const u = snapshot.upkeep;
  const lh = snapshot.lostHome;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true || !u || u.mode !== READY
    || !lh || lh.mode !== READY) {
    out.notes.push("HIVE_SWARM_SKIPPED");
    return out;
  }
  if (S.done === true) return out;
  if (!budget || !(budget.resourceUnits >= P.thresholdUnits)) return out;
  const opSlots = slots && Number.isSafeInteger(slots.operations) ? slots.operations : 0;
  const mobSlots = slots && Number.isSafeInteger(slots.mobilizations) ? slots.mobilizations : 0;
  if (opSlots < 1 || mobSlots < 1) {
    out.notes.push("HIVE_SWARM_NO_SLOT");
    return out;
  }
  const pick = candidatesOf(snapshot, supply || {}, params)[0];
  if (!pick) {
    out.notes.push("HIVE_SWARM_NO_TARGET");
    return out;
  }
  const nodes = new Set((snapshot.footholds || []).map((x) => x.systemId).filter(Number.isSafeInteger));
  const dist = bfs([pick.T], snapshot.neighbors, { maxJumps: P.maxJumps, maxSystems: params.maxBfsSystems });
  let node = null;
  for (const [id, j] of dist) {
    if (!nodes.has(id)) continue;
    if (node === null || j < dist.get(node) || (j === dist.get(node) && id < node)) node = id;
  }
  if (node === null) {
    out.notes.push("HIVE_SWARM_NO_TARGET");
    return out;
  }
  const kind = pick.kind;
  const own = d.templates && d.templates[kind.mobilizeRole];
  const role = Array.isArray(own) && own.length > 0 ? kind.mobilizeRole : FALLBACK_ROLE;
  const template = d.templates && d.templates[role];
  if (!Array.isArray(template) || template.length === 0) {
    out.notes.push("HIVE_SWARM_NO_TARGET");
    return out;
  }
  const ships = template.reduce((s, e) => s + e.count, 0);
  const mobCost = { resourceUnits: ships * params.mobilizeResourcePerShip,
    reserveUnits: ships * params.mobilizeReservePerShip };
  const afford = (have, each) => (each > 0 ? Math.floor(have / each) : Number.MAX_SAFE_INTEGER);
  const n = Math.max(0, Math.min(P.fleets, mobSlots, params.maxFleetsPerOperation,
    afford(budget.resourceUnits, mobCost.resourceUnits), afford(budget.reserveUnits, mobCost.reserveUnits)));
  if (n < 1) {
    out.notes.push("INSUFFICIENT_RESOURCES");
    return out;
  }
  const composition = template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count }));
  const mobs = [];
  for (let i = 0; i < n; i += 1) {
    mobs.push({ type: "MOBILIZE", slot: i, role, systemId: node, homeSystemId: node,
      composition: composition.map((e) => ({ ...e })), cost: { ...mobCost }, stationId: null, hulls: [] });
  }
  out.cost.resourceUnits = n * mobCost.resourceUnits;
  out.cost.reserveUnits = n * mobCost.reserveUnits;
  out.intents.push({ type: "LAUNCH", slot: n, kind: kind.kind,
    target: { kind: "system", systemId: pick.T, ref: null }, originSystemId: node, fleets: [], mobilize: mobs,
    dueAt: snapshot.at + params[kind.windowKey], swarmBucket: S.bucket });
  out.notes.push(`HIVE_SWARM:${pick.T}:${n}`);
  return out;
}

module.exports = { planHiveSwarm, hiveSwarmKey, swarmBucketOf, HIVE_SWARM_MARKER_EVENT };
