"use strict";

const INVADER_KIND = "invader";

const empty = () => ({ ok: true, systems: new Set() });

function createFootholdRepairNodes(deps) {
  const footholdsOf = deps && deps.footholdsOf;
  const kindOf = deps && deps.kindOf;
  return function footholdRepairNodes(tx, factionId) {
    try {
      if (typeof kindOf !== "function" || kindOf(factionId) !== INVADER_KIND) return empty();
      if (typeof footholdsOf !== "function") return empty();
      const r = footholdsOf(tx, factionId);
      if (r === null || r === undefined) return empty();
      if (!r.ok) return { ok: false, reason: r.reason || "FOOTHOLD_REPAIR_FAILED" };
      const systems = new Set();
      for (const fh of Array.isArray(r.footholds) ? r.footholds : []) {
        if (fh && Number.isSafeInteger(fh.systemId) && fh.systemId > 0) systems.add(fh.systemId);
      }
      return { ok: true, systems };
    } catch (_err) {
      return { ok: false, reason: "FOOTHOLD_REPAIR_THREW" };
    }
  };
}

function createHomeRepairNodes(deps) {
  const homeOf = deps && deps.homeOf;
  return function homeRepairNodes(tx, factionId) {
    try {
      if (typeof homeOf !== "function") return empty();
      const home = homeOf(tx, factionId);
      if (!home || !Number.isSafeInteger(home.systemId) || home.systemId <= 0) return empty();
      return { ok: true, systems: new Set([home.systemId]) };
    } catch (_err) {
      return { ok: false, reason: "HOME_REPAIR_THREW" };
    }
  };
}

function composeRepairNodes(first, second) {
  const fns = [first, second].filter((fn) => typeof fn === "function");
  if (fns.length === 0) return undefined;
  if (fns.length === 1) return fns[0];
  return function composedRepairNodes(tx, factionId) {
    const systems = new Set();
    for (const fn of fns) {
      const r = fn(tx, factionId);
      if (!r || !r.ok) return r || { ok: false, reason: "REPAIR_NODES_FAILED" };
      if (r.systems instanceof Set) for (const id of r.systems) systems.add(id);
    }
    return { ok: true, systems };
  };
}

module.exports = { createFootholdRepairNodes, createHomeRepairNodes, composeRepairNodes };
