"use strict";

const VIEW_ID = "invasions";
const VIEW_ORDER = 70;
const WORK_CLASS = "MAINTENANCE";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function iso(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function buildInvasionsView(deps) {
  const { store, repository } = deps;
  const { tagOf } = require("./data/invaderProfiles");
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));
  const effectiveWithdrawAt = typeof deps.effectiveWithdrawAt === "function" ? deps.effectiveWithdrawAt : (row) => row.withdraw_at;

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(deps.graph, "getGraph") : null;
    const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
    return vertex ? vertex.name : null;
  }

  function regionName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(deps.graph, "getGraph") : null;
    const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
    return vertex ? vertex.regionName : null;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.invasions", (db) => {
      const open = repository.listOpen(db, { limit: maxRows });
      if (!open.ok) return open;
      const recentEnded = repository.listRecentEnded(db, { limit: 20 });
      if (!recentEnded.ok) return recentEnded;
      const totals = repository.listTotals(db);
      if (!totals.ok) return totals;
      const result = { ok: true, invasions: open.invasions, truncated: open.truncated, ended: recentEnded.invasions, totals: totals.totals };
      return result;
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};

    return {
      available: true,
      state: st.state || null,
      truncated: read.truncated,
      open: read.invasions.map((inv) => ({
        invasion: inv.invasion_id,
        system: systemName(inv.beachhead_system_id) || inv.beachhead_system_id,
        region: regionName(inv.beachhead_system_id) || "",
        faction: names.get(inv.faction_id) || inv.faction_id,
        profile: tagOf(inv.profile_id),
        state: inv.state,
        startedAt: iso(inv.started_at),
        withdrawAt: iso(effectiveWithdrawAt(inv)),
        fleets: (() => { try { return JSON.parse(inv.fleet_ids_json || "[]").length; } catch (_e) { return 0; } })(),
      })),
      ended: read.ended.map((inv) => ({
        invasion: inv.invasion_id,
        system: systemName(inv.beachhead_system_id) || inv.beachhead_system_id,
        region: regionName(inv.beachhead_system_id) || "",
        faction: names.get(inv.faction_id) || inv.faction_id,
        profile: tagOf(inv.profile_id),
        endReason: inv.end_reason || "ENDED",
        endedAt: iso(inv.ended_at),
      })),
      totals: Object.fromEntries(
        read.totals.map((t) => [String(t.faction_id), {
          started: t.started,
          collapsed: t.collapsed,
          withdrawn: t.withdrawn,
        }])
      ),
      lastDecision: st.lastDecision || null,
      rollIntervalMs: Number.isSafeInteger(deps.rollIntervalMs) && deps.rollIntervalMs > 0 ? deps.rollIntervalMs : null,
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return `i${repository.getChangeCount()}`;
  }

  return { title: "Invasions", listed: true, order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildInvasionsView };