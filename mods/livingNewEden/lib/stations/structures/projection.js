"use strict";

const {
  CONDITION_FULL, CONDITION_ARMOR_STAGE, CONDITION_HULL_STAGE, OPS, OP_PRIORITY, DESIRED_KINDS, REMOVE_REASONS,
  RECREATE_REASON,
} = require("./schema");
const { DESTROYED_STATION_STATE } = require("../schema");
const { createRng } = require("../../util/rng");

const UPWELL_KIND = "upwell";

const STATE_MAP = Object.freeze({
  ANCHORING: Object.freeze({ running: "ANCHOR_VULNERABLE", after: null, condition: CONDITION_ARMOR_STAGE }),
  ONLINE: Object.freeze({ running: "SHIELD_VULNERABLE", after: null, condition: CONDITION_FULL }),
  ARMOR_REINFORCE: Object.freeze({ running: "ARMOR_REINFORCE", after: "ARMOR_VULNERABLE",
    condition: CONDITION_ARMOR_STAGE }),
  HULL_REINFORCE: Object.freeze({ running: "HULL_REINFORCE", after: "HULL_VULNERABLE",
    condition: CONDITION_HULL_STAGE }),
});

const COMPARED = Object.freeze([
  ["state", "state"], ["stateEndsAt", "stateEndsAt"], ["ownerCorpId", "ownerCorpId"], ["allianceId", "allianceId"],
  ["upkeepState", "upkeepState"], ["docking", "docking"], ["quantumCore", "hasQuantumCore"],
]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isLive = (view) => view !== null && view !== undefined && (view.destroyedAt === null
  || view.destroyedAt === undefined);
const nullable = (v) => (v === undefined ? null : v);

const ABSENT = Object.freeze({ kind: DESIRED_KINDS.ABSENT });
const DESTROYED = Object.freeze({ kind: DESIRED_KINDS.DESTROYED });

function desiredStructure(station, now, cfg, states) {
  if (!station || station.kind !== UPWELL_KIND || !isId(station.typeId)) return ABSENT;
  if (station.state === DESTROYED_STATION_STATE) return DESTROYED;
  const map = Object.prototype.hasOwnProperty.call(STATE_MAP, station.state) ? STATE_MAP[station.state] : null;
  if (map === null) return Object.freeze({ kind: DESIRED_KINDS.UNMAPPED, state: String(station.state) });
  const until = station.stateUntilAt;
  const running = map.after === null || (Number.isFinite(until) && now < until);
  const name = running ? map.running : map.after;
  return Object.freeze({
    kind: DESIRED_KINDS.PRESENT,
    typeId: station.typeId,
    systemId: station.systemId,
    ownerCorpId: station.ownerCorporationId,
    allianceId: null,
    state: states.states[name],
    stateEndsAt: running && map.after !== null ? until : null,
    condition: map.condition,
    upkeepState: states.upkeep.FULL_POWER,
    docking: cfg.dockingAccess,
    quantumCore: cfg.quantumCore === true,
    name: typeof station.name === "string" && station.name !== "" ? station.name : null,
  });
}

function diffStructure(desired, actual, own) {
  const live = isLive(actual);
  switch (desired && desired.kind) {
    case DESIRED_KINDS.ABSENT:
      return live ? { op: OPS.REMOVE } : { op: OPS.NOOP };
    case DESIRED_KINDS.DESTROYED:
      return live ? { op: OPS.DESTROY } : { op: OPS.NOOP };
    case DESIRED_KINDS.PRESENT:
      break;
    default:
      return { op: OPS.NOOP };
  }
  if (!live) {
    const destroyedAt = own ? nullable(own.destroyedAt) : null;
    if (destroyedAt === null || !isId(own.structureId) || own.modDestroyed === true) return { op: OPS.CREATE };
    return { op: OPS.CREATE, foreignDestroyed: { structureId: own.structureId, destroyedAt } };
  }
  if (actual.typeId !== desired.typeId || actual.systemId !== desired.systemId) {
    return { op: OPS.RECREATE, reason: RECREATE_REASON };
  }
  const patch = {};
  for (const [want, have] of COMPARED) {
    if (nullable(desired[want]) !== nullable(actual[have])) patch[want] = nullable(desired[want]);
  }
  const stateChanged = Object.prototype.hasOwnProperty.call(patch, "state");
  if (stateChanged) patch.condition = desired.condition;
  if (Object.keys(patch).length === 0) return { op: OPS.NOOP };
  return { op: OPS.UPDATE, patch, stateChanged };
}

function desiredFingerprint(desired) {
  if (!desired || desired.kind !== DESIRED_KINDS.PRESENT) return String(desired && desired.kind);
  return [desired.kind, desired.typeId, desired.systemId, desired.ownerCorpId, desired.allianceId, desired.state,
    desired.stateEndsAt, desired.upkeepState, desired.docking, desired.quantumCore].join("|");
}

const byStructureId = (a, b) => a.structureId - b.structureId;
const tagOf = (stationId, world) => Object.freeze({ stationId, world });

function planPass(input) {
  const { live, tagged, dirty, applied, now, cfg, states, world, maxWrites } = input;
  if (!(tagged instanceof Map)) return { ops: [], deferred: 0, unknown: [], needsFullReconcile: true };
  const full = dirty === null || dirty === undefined;
  const records = new Map();
  for (const station of Array.isArray(live) ? live : []) {
    if (station && typeof station.stationId === "string") records.set(station.stationId, station);
  }
  const desiredOf = new Map();
  const desired = (id) => {
    if (!desiredOf.has(id)) desiredOf.set(id, desiredStructure(records.get(id) || null, now, cfg, states));
    return desiredOf.get(id);
  };

  const scope = new Set();
  if (full) {
    for (const id of records.keys()) scope.add(id);
    for (const id of tagged.keys()) scope.add(id);
  } else {
    for (const id of dirty) scope.add(id);
    for (const [id, station] of records) {
      if (station.state === DESTROYED_STATION_STATE) continue;
      const known = applied instanceof Map ? applied.get(id) : undefined;
      if (known !== desiredFingerprint(desired(id))) scope.add(id);
    }
  }

  const ops = [];
  const unknown = [];
  for (const stationId of scope) {
    if (!full && !tagged.has(stationId)) {
      unknown.push(stationId);
      continue;
    }
    const views = (tagged.get(stationId) || []).filter((v) => v && isId(v.structureId));
    const own = [];
    for (const view of views) {
      const sameWorld = view.tag && view.tag.world === world;
      if (!sameWorld) {
        if (isLive(view)) {
          ops.push({ op: OPS.REMOVE, stationId, structureId: view.structureId, tag: view.tag,
            reason: REMOVE_REASONS.ORPHAN });
        }
        continue;
      }
      own.push(view);
    }
    const ownLive = own.filter(isLive).sort(byStructureId);
    const want = records.has(stationId) ? desired(stationId) : null;
    if (want === null) {
      for (const view of ownLive) {
        ops.push({ op: OPS.REMOVE, stationId, structureId: view.structureId, tag: view.tag,
          reason: REMOVE_REASONS.ORPHAN });
      }
      continue;
    }
    for (const view of ownLive.slice(1)) {
      ops.push({ op: OPS.REMOVE, stationId, structureId: view.structureId, tag: view.tag,
        reason: REMOVE_REASONS.DUPLICATE });
    }
    const actual = ownLive.length > 0 ? ownLive[0] : null;
    const itemId = records.get(stationId).evejsItemId;
    const named = isId(itemId) ? own.find((v) => v.structureId === itemId) || null : null;
    const diff = diffStructure(want, actual, named);
    const tag = tagOf(stationId, world);
    switch (diff.op) {
      case OPS.CREATE:
        ops.push(diff.foreignDestroyed
          ? { op: OPS.CREATE, stationId, tag, desired: want, foreignDestroyed: diff.foreignDestroyed }
          : { op: OPS.CREATE, stationId, tag, desired: want });
        break;
      case OPS.DESTROY:
        ops.push({ op: OPS.DESTROY, stationId, structureId: actual.structureId, tag });
        break;
      case OPS.UPDATE:
        ops.push({ op: OPS.UPDATE, stationId, structureId: actual.structureId, tag, patch: diff.patch,
          stateChanged: diff.stateChanged });
        break;
      case OPS.RECREATE:
        ops.push({ op: OPS.REMOVE, stationId, structureId: actual.structureId, tag, reason: REMOVE_REASONS.RECREATE });
        break;
      case OPS.REMOVE:
        ops.push({ op: OPS.REMOVE, stationId, structureId: actual.structureId, tag,
          reason: REMOVE_REASONS.NOT_PROJECTED });
        break;
      default:
        break;
    }
  }

  ops.sort((a, b) => (OP_PRIORITY[a.op] - OP_PRIORITY[b.op])
    || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0)
    || ((a.structureId || 0) - (b.structureId || 0)));
  const budget = Number.isFinite(maxWrites) ? Math.max(0, Math.floor(maxWrites)) : 0;
  unknown.sort();
  return { ops: ops.slice(0, budget), deferred: Math.max(0, ops.length - budget), unknown,
    needsFullReconcile: unknown.length > 0 };
}

function placementCandidates(input) {
  const { seed, anchors, clearanceM, attempts } = input || {};
  const list = (Array.isArray(anchors) ? anchors : [])
    .filter((a) => a && a.position && [a.position.x, a.position.y, a.position.z].every(Number.isFinite))
    .slice().sort((a, b) => a.itemId - b.itemId);
  const n = list.length;
  const count = Number.isFinite(attempts) ? Math.max(0, Math.floor(attempts)) : 0;
  if (n === 0 || count === 0) return [];
  const rng = createRng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const anchor = list[(Math.floor(rng.nextFloat() * n) + i) % n];
    let dx = rng.nextFloat() * 2 - 1;
    let dy = rng.nextFloat() * 2 - 1;
    let dz = rng.nextFloat() * 2 - 1;
    const len = Math.hypot(dx, dy, dz);
    if (len === 0) {
      dx = 1; dy = 0; dz = 0;
    } else {
      dx /= len; dy /= len; dz /= len;
    }
    const radius = Number.isFinite(anchor.radius) && anchor.radius > 0 ? anchor.radius : 0;
    const distance = radius + clearanceM;
    out.push(Object.freeze({ x: anchor.position.x + dx * distance, y: anchor.position.y + dy * distance,
      z: anchor.position.z + dz * distance }));
  }
  return out;
}

module.exports = { STATE_MAP, desiredStructure, diffStructure, desiredFingerprint, planPass, placementCandidates };
