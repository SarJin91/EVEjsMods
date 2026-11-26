"use strict";

const { bfs } = require("./bfs");
const { pickDefenders } = require("./relief");
const { strengthOf } = require("./strength");

const ACTIVE = "ACTIVE";
const READY = "ready";
const PERMILLE = 1000;
const BOSS_RESPONSE_KIND = "boss_response";
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

const byTarget = (a, b) => a.systemId - b.systemId || (a.bossId < b.bossId ? -1 : a.bossId > b.bossId ? 1 : 0);

function planBossResponse(snapshot, params, used, room, opts) {
  const out = { intents: [], notes: [], fleetIds: [] };
  const P = params && params.bossResponse;
  if (!P || !(P.maxPerReview > 0) || !(room > 0)) return out;
  const wb = snapshot.worldBosses;
  if (!wb || wb.mode !== READY || !Array.isArray(wb.items)) return out;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out;
  const d = snapshot.doctrine;
  const kind = (params.kinds || []).find((k) => k.kind === BOSS_RESPONSE_KIND);
  if (!kind || !d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(kind.operationType)) {
    if (wb.items.length > 0) out.notes.push("BOSS_RESPONSE_NO_KIND");
    return out;
  }
  if (wb.truncated === true) out.notes.push("BOSS_RESPONSE_TRUNCATED");
  if (wb.items.length === 0) return out;

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
  for (const b of [...wb.items].filter((x) => x && Number.isSafeInteger(x.systemId)).sort(byTarget)) {
    if (out.intents.length >= limit) break;
    const T = b.systemId;
    if (!hostile(b.factionId) || covered.has(T) || launched.has(T)) continue;
    const lead = Number.isSafeInteger(P.minLeadMs) && P.minLeadMs > 0 ? P.minLeadMs : 0;
    if (!Number.isSafeInteger(b.departAt) || b.departAt - snapshot.at < lead) {
      out.notes.push(`BOSS_RESPONSE_LATE:${T}`);
      continue;
    }
    const reach = bfs([T], snapshot.neighbors, { maxJumps: P.rangeJumps, maxSystems: params.maxBfsSystems });
    if (![...reach.keys()].some((id) => controlled.has(id))) continue;
    const S = strengthOf(Array.isArray(b.composition) ? b.composition : [], table);
    const required = Math.max(1, Math.ceil((S * P.strengthPermille) / PERMILLE));
    const { chosen, sum } = pickDefenders(snapshot, params, kind, T, required, taken, NO_SYSTEMS);
    if (chosen.length === 0 || sum < required) {
      out.notes.push(`BOSS_RESPONSE_INSUFFICIENT:${T}`);
      continue;
    }
    covered.add(T);
    for (const x of chosen) {
      taken.add(x.fleetId);
      mine.push(x.fleetId);
    }
    out.intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: T, ref: b.bossId },
      originSystemId: chosen[0].systemId,
      fleets: chosen.map((x) => ({ fleetId: x.fleetId, expectedVersion: x.version })), mobilize: [],
      dueAt: Math.min(snapshot.at + P.windowMs, b.departAt) });
    out.notes.push(`BOSS_RESPONSE_LAUNCH:${T}`);
  }
  out.fleetIds = mine;
  return out;
}

module.exports = { planBossResponse, BOSS_RESPONSE_KIND };
