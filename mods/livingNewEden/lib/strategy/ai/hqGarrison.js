"use strict";

const { bfs } = require("./bfs");

const HQ_HOLDING = "HQ_HOLDING";
const HQ_RETURN = "HQ_RETURN";
const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const GARRISON = "garrison";
const PATROL_KIND = "patrol";
const STAYING_STATES = Object.freeze(["REFITTING", "MATERIALIZED", "ENGAGED"]);
const ORDERED_STATES = Object.freeze(["PLANNED", "STAGED", "TRAVELLING"]);
const REAL_STATES = Object.freeze(["IDLE", "PLANNED", "TRAVELLING", "STAGED", "ENGAGED", "RETREATING", "REFITTING",
  "DESTROYED", "MATERIALIZED"]);
const LEAVING_PSEUDO = "RELIEVING";

const strengthOf = (x) => (Number.isFinite(x.strength) ? x.strength : 0);
const byId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));
const byPriority = (a, b) => ((a.fleetRole === GARRISON ? 0 : 1) - (b.fleetRole === GARRISON ? 0 : 1))
  || (strengthOf(b) - strengthOf(a)) || byId(a, b);

function hqOf(snapshot, P) {
  if (!P || !snapshot || !snapshot.entry) return null;
  if (snapshot.doctrine && snapshot.doctrine.hive === true) return null;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return null;
  const hq = snapshot.entry.hqSystemId;
  return Number.isSafeInteger(hq) ? hq : null;
}

function stayingIn(snapshot, hq, pseudo) {
  const targetOf = new Map((snapshot.operations || []).map((op) => [op.operationId, op.targetSystemId]));
  let n = 0;
  for (const x of Array.isArray(snapshot.fleets) ? snapshot.fleets : []) {
    if (ORDERED_STATES.includes(x.state) && x.operationId != null && targetOf.get(x.operationId) === hq) {
      n += 1;
      continue;
    }
    if (x.systemId !== hq) continue;
    const ps = pseudo.has(x.fleetId) ? pseudo.get(x.fleetId) : (REAL_STATES.includes(x.state) ? null : x.state);
    if (ps !== null && ps !== undefined) {
      if (ps !== LEAVING_PSEUDO) n += 1;
      continue;
    }
    if (STAYING_STATES.includes(x.state) || (x.state === IDLE && x.refitPending === true)) n += 1;
  }
  return n;
}

function markHqHolders(snapshot, params, pseudo) {
  const notes = [];
  const P = params ? params.hqGarrison : null;
  const hq = hqOf(snapshot, P);
  if (hq === null) return notes;
  const need = P.minFleets - stayingIn(snapshot, hq, pseudo);
  if (need <= 0) return notes;
  const roles = Array.isArray(P.roles) ? P.roles : [];
  const free = (Array.isArray(snapshot.fleets) ? snapshot.fleets : []).filter((x) => x.systemId === hq
    && x.state === IDLE && x.refitPending !== true && !pseudo.has(x.fleetId) && roles.includes(x.fleetRole))
    .sort(byPriority);
  for (const x of free.slice(0, need)) pseudo.set(x.fleetId, HQ_HOLDING);
  if (free.length > 0) notes.push("HQ_HOLD");
  return notes;
}

function planHqReturn(snapshot, params, used, room) {
  const intents = [];
  const notes = [];
  const out = () => ({ intents, notes });
  const P = params ? params.hqGarrison : null;
  const hq = hqOf(snapshot, P);
  if (hq === null || !(room > 0)) return out();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out();
  const kind = (params.kinds || []).find((k) => k.kind === PATROL_KIND);
  if (!kind) return out();
  if (P.minFleets - stayingIn(snapshot, hq, new Map()) <= 0) return out();
  const roles = Array.isArray(P.roles) ? P.roles : [];
  const idle = (Array.isArray(snapshot.fleets) ? snapshot.fleets : []).filter((x) => x.state === IDLE
    && (x.operationId === null || x.operationId === undefined) && x.refitPending !== true && !used.has(x.fleetId)
    && roles.includes(x.fleetRole) && Number.isSafeInteger(x.systemId) && x.systemId !== hq);
  const dist = idle.length > 0 && typeof snapshot.neighbors === "function"
    ? bfs([hq], snapshot.neighbors, { maxJumps: P.maxJumps, maxSystems: params.maxBfsSystems })
    : new Map();
  const pick = idle.filter((x) => dist.has(x.systemId))
    .sort((a, b) => (dist.get(a.systemId) - dist.get(b.systemId)) || (strengthOf(b) - strengthOf(a)) || byId(a, b))[0];
  if (!pick) {
    notes.push("HQ_UNHELD");
    return out();
  }
  intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: hq, ref: null },
    originSystemId: pick.systemId, fleets: [{ fleetId: pick.fleetId, expectedVersion: pick.version }], mobilize: [],
    dueAt: snapshot.at + P.windowMs, purpose: HQ_RETURN });
  notes.push(`HQ_RETURN:${hq}`);
  used.add(pick.fleetId);
  return out();
}

module.exports = { markHqHolders, planHqReturn, HQ_HOLDING, HQ_RETURN };
