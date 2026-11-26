"use strict";

const { bfs } = require("./bfs");
const { valueIn } = require("./playerValue");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const READY = "ready";
const ASSAULT_KIND = "structure_assault";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);

function dpsOf(composition, groups) {
  let dps = 0;
  for (const e of Array.isArray(composition) ? composition : []) {
    const g = e && groups ? groups[e.hullGroup] : null;
    if (!g || !Number.isSafeInteger(e.count) || e.count <= 0) continue;
    dps += e.count * (Number(g.dps) || 0) * (Number(g.applicationFactor) || 0);
  }
  return dps;
}

function controlledOf(snapshot) {
  const f = snapshot.factionId;
  const out = new Set();
  for (const s of snapshot.systems || []) if (s && s.controllerFactionId === f) out.add(s.systemId);
  for (const t of Array.isArray(snapshot.territory) ? snapshot.territory : []) if (t) out.add(t.systemId);
  for (const s of Array.isArray(snapshot.stations) ? snapshot.stations : []) {
    if (s && Number.isSafeInteger(s.systemId)) out.add(s.systemId);
  }
  return out;
}

function planStructureAssault(snapshot, params, used, room, opts) {
  const out = { intents: [], notes: [], fleetIds: [] };
  const P = params && params.playerSiege;
  if (!P || !(P.maxDispatchPerReview > 0) || !(room > 0)) return out;
  const ps = snapshot.playerSiege;
  if (!ps || ps.mode !== READY || !Array.isArray(ps.attacking) || !Array.isArray(ps.targets)) return out;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out;
  const d = snapshot.doctrine;
  const kind = (params.kinds || []).find((k) => k.kind === ASSAULT_KIND);
  if (!kind || !d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(kind.operationType)
    || (kind.needsCanOccupy === true && d.canOccupy !== true)) {
    if (ps.targets.length > 0) out.notes.push("STRUCTURE_ASSAULT_NO_KIND");
    return out;
  }
  const operations = snapshot.operations || [];
  const open = operations.filter((op) => OPEN_OPERATION_STATES.includes(op.state));
  if (ps.attacking.length > 0 || open.some((op) => op.operationType === kind.operationType)) {
    out.notes.push("STRUCTURE_ASSAULT_BUSY");
    return out;
  }
  if (ps.targets.length === 0) return out;

  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const covered = new Set(open.map((op) => op.targetSystemId));
  const controlled = controlledOf(snapshot);
  const limit = Math.min(room, P.maxDispatchPerReview);
  const taken = new Set();
  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) out.notes.push(n);
    noted.add(n);
  };
  const V = snapshot.playerValue;
  const ordered = params.playerValue && V instanceof Map
    ? [...ps.targets].sort((a, b) => valueIn(V, b.systemId) - valueIn(V, a.systemId))
    : ps.targets;
  for (const t of ordered) {
    if (out.intents.length >= limit) break;
    const T = t.systemId;
    if (!Number.isSafeInteger(T) || covered.has(T) || launched.has(T)) continue;
    const reach = bfs([T], snapshot.neighbors, { maxJumps: P.dispatchMaxJumps, maxSystems: params.maxBfsSystems });
    if (![...reach.keys()].some((id) => controlled.has(id))) continue;
    const distT = bfs([T], snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems });
    const need = (Number(t.requiredDps) || 0) * P.dispatchDpsMargin;
    const avail = (snapshot.fleets || []).filter((x) => x.state === IDLE && x.refitPending !== true
      && !used.has(x.fleetId) && !taken.has(x.fleetId) && kind.fleetRoles.includes(x.fleetRole)
      && distT.has(x.systemId) && distT.get(x.systemId) >= 1)
      .sort((a, b) => distT.get(a.systemId) - distT.get(b.systemId) || (a.fleetId < b.fleetId ? -1 : 1));
    const chosen = [];
    let sum = 0;
    for (const x of avail) {
      if (sum >= need || chosen.length >= params.maxFleetsPerOperation) break;
      chosen.push(x);
      sum += dpsOf(x.composition, P.groups);
    }
    if (chosen.length === 0 || sum < need) {
      note("STRUCTURE_ASSAULT_INSUFFICIENT");
      continue;
    }
    covered.add(T);
    for (const x of chosen) taken.add(x.fleetId);
    out.intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: T, ref: null },
      originSystemId: chosen[0].systemId,
      fleets: chosen.map((x) => ({ fleetId: x.fleetId, expectedVersion: x.version })), mobilize: [],
      dueAt: snapshot.at + params.attackWindowMs });
    out.notes.push(`STRUCTURE_ASSAULT_LAUNCH:${T}`);
  }
  out.fleetIds = [...taken];
  return out;
}

module.exports = { planStructureAssault, dpsOf, controlledOf, ASSAULT_KIND };
