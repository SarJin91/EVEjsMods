"use strict";

const { ROW_STATE } = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function buildTargets(claimRows, params) {
  const states = params && Array.isArray(params.claimStates) ? params.claimStates : [];
  const max = params && Number.isSafeInteger(params.maxTargets) && params.maxTargets > 0 ? params.maxTargets : 0;
  const ids = new Set();
  for (const row of Array.isArray(claimRows) ? claimRows : []) {
    if (row && isId(row.systemId) && states.includes(row.occupationState)) ids.add(row.systemId);
  }
  return [...ids].sort((a, b) => a - b).slice(0, max).map((systemId) => ({ systemId }));
}

function decideTale(tale, row, ctx) {
  if (!tale || !isId(tale.taleId)) return { action: "NONE" };
  if (row) {
    if (row.state === ROW_STATE.BOUND && tale.terminal) return { action: "SETTLE", outcome: tale.terminal.outcome };
    return { action: "NONE" };
  }
  if (tale.terminal || !ctx || !(ctx.boundCount < ctx.maxActiveBindings)) return { action: "NONE" };
  const logged = tale.selectionKey !== null && ctx.steerLog instanceof Map ? ctx.steerLog.get(tale.selectionKey) : undefined;
  if (isId(logged)) return { action: "BIND", targetSystemId: logged, steered: true };
  const set = ctx.targetSet instanceof Set ? ctx.targetSet : new Set();
  const hit = (Array.isArray(tale.systemIds) ? tale.systemIds : []).find((id) => set.has(id));
  return hit === undefined ? { action: "NONE" } : { action: "BIND", targetSystemId: hit, steered: false };
}

module.exports = { buildTargets, decideTale };
