"use strict";

const { bfs } = require("./bfs");
const { defensiveBudgetOf } = require("./defenseBudget");

const IDLE = "IDLE";
const KIND = "intercept_post";
const BLOCKADE_TYPE = "blockade";
const DEFENSE_TYPE = "defense";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const NOT_OBSERVING = Object.freeze(["TRAVELLING", "RETREATING", "DESTROYED"]);
const INTERCEPT_TARGET_TYPES = Object.freeze(["invasion", "raid", "gank"]);

const byText = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function legOf(e) {
  const leg = e && e.leg;
  if (!leg || !Array.isArray(leg.systems) || leg.systems.length < 1 || !Number.isSafeInteger(leg.departAt)
    || !(leg.jumpMs > 0) || !Array.isArray(e.own)) return null;
  return leg;
}

function planIntercepts(snapshot, params, used, room) {
  const intents = [];
  const notes = [];
  const out = () => ({ intents, notes });
  const P = params && params.intercept;
  if (!P || !(room >= 1)) return out();
  if (!snapshot || snapshot.operationsTruncated === true) return out();
  const d = snapshot.doctrine;
  if (!d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(DEFENSE_TYPE)) return out();
  const kind = (params.kinds || []).find((k) => k.kind === KIND);
  if (!kind) return out();
  if (!Array.isArray(snapshot.incoming) || snapshot.incoming.length === 0) return out();

  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) notes.push(n);
    noted.add(n);
  };
  const fleets = snapshot.fleets || [];
  const open = (snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state));
  const { cap, busy } = defensiveBudgetOf(fleets, open, P.defensiveSharePermille);
  if (!(cap > 0)) return out();
  const incoming = [...snapshot.incoming].filter((o) => o && typeof o.operationId === "string")
    .sort((a, b) => byText(a.operationId, b.operationId));
  if (busy >= cap) {
    for (const o of incoming) note(`INTERCEPT_CAPPED:${o.operationId}`);
    return out();
  }
  const limit = Math.min(room, P.maxPerSweep, cap - busy);
  if (!(limit > 0)) return out();

  const at = snapshot.at;
  const held = new Set(open.filter((op) => op.operationType === BLOCKADE_TYPE).map((op) => op.targetSystemId));
  const roles = new Set(kind.fleetRoles || []);
  const pool = fleets.filter((x) => x.state === IDLE && (x.operationId === null || x.operationId === undefined)
    && x.refitPending !== true && roles.has(x.fleetRole) && x.jumpMs > 0 && Number.isSafeInteger(x.systemId))
    .sort((a, b) => byText(a.fleetId, b.fleetId));
  const observers = new Set(fleets.filter((x) => !NOT_OBSERVING.includes(x.state) && Number.isSafeInteger(x.systemId))
    .map((x) => x.systemId));
  const bfsOpts = { maxJumps: Math.max(0, P.maxJumps), maxSystems: params.maxBfsSystems };
  const dists = new Map();
  const distFrom = (X) => {
    if (!dists.has(X)) dists.set(X, bfs([X], snapshot.neighbors, bfsOpts));
    return dists.get(X);
  };

  for (const o of incoming) {
    if (intents.length >= limit) break;
    const seen = [];
    let covered = false;
    for (const e of o.fleets || []) {
      const leg = legOf(e);
      if (!leg) continue;
      const len = leg.systems.length;
      const iNow = Math.min(len - 1, Math.max(0, Math.floor((at - leg.departAt) / leg.jumpMs)));
      let sighted = false;
      for (let j = 0; j <= iNow && !sighted; j += 1) {
        sighted = e.own[j] === true || observers.has(leg.systems[j]);
      }
      if (!sighted) continue;
      for (let i = iNow + 1; i < len && !covered; i += 1) covered = held.has(leg.systems[i]);
      if (covered) break;
      seen.push({ e, leg, iNow });
    }
    if (covered || seen.length === 0) continue;

    const firstFrom = new Map();
    for (const { e, leg, iNow } of seen) {
      for (let i = Math.max(iNow + 1, 1); i <= leg.systems.length - 2; i += 1) {
        const X = leg.systems[i];
        if (!isId(X) || X === o.targetSystemId || e.own[i] !== true) continue;
        const from = leg.departAt + i * leg.jumpMs;
        if (!firstFrom.has(X) || from < firstFrom.get(X)) firstFrom.set(X, from);
      }
    }
    const candidates = [...firstFrom.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0]).map(([X]) => X);
    if (candidates.length === 0) continue;

    let launched = false;
    for (const X of candidates) {
      const group = [];
      for (const { e, leg } of seen) {
        const i = leg.systems.indexOf(X);
        if (i <= 0 || i >= leg.systems.length - 1) continue;
        const from = leg.departAt + i * leg.jumpMs;
        if (from < at) continue;
        group.push({ fleetId: e.fleetId, from, strength: Number.isFinite(e.strength) ? e.strength : 0 });
      }
      if (group.length === 0) continue;
      group.sort((a, b) => a.from - b.from || byText(a.fleetId, b.fleetId));
      const picked = group.slice(0, Math.max(1, P.maxFleetIds));
      const required = picked.reduce((s, g) => s + g.strength, 0) * P.strengthRatio;
      const earliest = picked[0].from;
      const latest = picked.reduce((m, g) => Math.max(m, g.from), earliest);
      const dist = distFrom(X);
      let best = null;
      for (const x of pool) {
        if (used.has(x.fleetId) || !dist.has(x.systemId)) continue;
        const jumps = dist.get(x.systemId);
        if (!((x.strength || 0) >= required)) continue;
        if (at + jumps * x.jumpMs + P.minLeadMs > earliest) continue;
        if (best === null || jumps < best.jumps) best = { fleet: x, jumps };
      }
      if (best === null) continue;
      const x = best.fleet;
      intents.push({ type: "LAUNCH", kind: KIND, target: { kind: "system", systemId: X, ref: null },
        originSystemId: x.systemId, fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [],
        dueAt: latest + P.holdMs,
        intercept: { operationId: o.operationId, fleetIds: picked.map((g) => g.fleetId).sort(byText) } });
      notes.push(`INTERCEPT:${X}`);
      used.add(x.fleetId);
      held.add(X);
      launched = true;
      break;
    }
    if (!launched) note(`INTERCEPT_NO_FLEET:${o.operationId}`);
  }
  return out();
}

module.exports = { planIntercepts, INTERCEPT_TARGET_TYPES };
