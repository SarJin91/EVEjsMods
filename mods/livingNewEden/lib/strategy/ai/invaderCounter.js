"use strict";

const { bfs } = require("./bfs");
const { pickDefenders } = require("./relief");
const { strengthOf } = require("./strength");

const ACTIVE = "ACTIVE";
const READY = "ready";
const COUNTER_KIND = "counter_offensive";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const NO_SYSTEMS = new Set();

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

function planInvaderCounter(snapshot, params, used, room, opts) {
  const out = { intents: [], notes: [], fleetIds: [] };
  const P = params && params.invaderCounter;
  if (!P || !(P.maxPerReview > 0) || !(room > 0)) return out;
  const ib = snapshot.invaderBeachheads;
  if (!ib || ib.mode !== READY || !Array.isArray(ib.items)) return out;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out;
  const d = snapshot.doctrine;
  const kind = (params.kinds || []).find((k) => k.kind === COUNTER_KIND);
  if (!kind || !d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(kind.operationType)) {
    if (ib.items.length > 0) out.notes.push("INVADER_COUNTER_NO_KIND");
    return out;
  }
  if (ib.truncated === true) out.notes.push("INVADER_COUNTER_TRUNCATED");
  if (ib.items.length === 0) return out;

  const f = snapshot.factionId;
  const hostile = (o) => o !== f && typeof snapshot.isHostile === "function" && snapshot.isHostile(o) === true;
  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const covered = new Set((snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state)
    && op.operationType === kind.operationType).map((op) => op.targetSystemId));
  const controlled = controlledOf(snapshot);
  const limit = Math.min(room, P.maxPerReview);
  const taken = new Set(used instanceof Set ? used : []);
  const mine = [];
  const table = params.powerTable || {};
  for (const b of [...ib.items].sort((x, y) => x.systemId - y.systemId)) {
    if (out.intents.length >= limit) break;
    const T = b.systemId;
    if (!Number.isSafeInteger(T) || !hostile(b.factionId) || covered.has(T) || launched.has(T)) continue;
    if (b.holdersTruncated === true) continue;
    const reach = bfs([T], snapshot.neighbors, { maxJumps: P.rangeJumps, maxSystems: params.maxBfsSystems });
    if (![...reach.keys()].some((id) => controlled.has(id))) continue;
    const S = (Array.isArray(b.holders) ? b.holders : []).reduce((n, h) => n + strengthOf(h.composition, table), 0);
    const required = Math.max(1, Math.ceil(S * params.attackStrengthRatio));
    const { chosen, sum } = pickDefenders(snapshot, params, kind, T, required, taken, NO_SYSTEMS);
    if (chosen.length === 0 || sum < required) {
      out.notes.push(`INVADER_COUNTER_INSUFFICIENT:${T}`);
      continue;
    }
    covered.add(T);
    for (const x of chosen) {
      taken.add(x.fleetId);
      mine.push(x.fleetId);
    }
    out.intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: T, ref: null },
      originSystemId: chosen[0].systemId,
      fleets: chosen.map((x) => ({ fleetId: x.fleetId, expectedVersion: x.version })), mobilize: [],
      dueAt: snapshot.at + params.attackWindowMs });
    out.notes.push(`INVADER_COUNTER_LAUNCH:${T}`);
  }
  out.fleetIds = mine;
  return out;
}

module.exports = { planInvaderCounter, COUNTER_KIND };
