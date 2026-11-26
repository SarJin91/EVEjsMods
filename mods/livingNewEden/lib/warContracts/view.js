"use strict";

const S = require("./schema");

const VIEW_ID = "war-contracts";
const VIEW_ORDER = 68;
const WORK_CLASS = "MAINTENANCE";
const REFRESH_MS = 60000;
const MICRO = 1000000;
const CORP_ACCEPTED = "corp-accepted";
const ROW_KEYS = Object.freeze(["offerId", "faction", "factionId", "type", "typeId", "quantity", "system", "systemId",
  "lp", "standing", "state", "endReason", "character", "characterId", "adoptedAt", "endedAt"]);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildWarContractsView(deps) {
  const { store, repo, now } = deps;
  const names = deps.names || {};
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const nameOf = (fn, id) => {
    const n = typeof fn === "function" ? call(() => fn(id), null) : null;
    return typeof n === "string" && n !== "" ? n : null;
  };

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function pilotNames() {
    const presence = call(getPresence, null);
    const list = presence && typeof presence.listPresence === "function" ? call(() => presence.listPresence(), []) : [];
    const out = new Map();
    for (const sys of list || []) for (const c of sys.characters || []) if (c.name) out.set(c.characterId, c.name);
    return out;
  }

  function rowOf(r, pilots) {
    return { offerId: r.offerId, faction: nameOf(names.faction, r.factionId), factionId: r.factionId,
      type: nameOf(names.type, r.typeId), typeId: r.typeId, quantity: r.quantity,
      system: nameOf(names.system, r.systemId), systemId: r.systemId, lp: r.lpAmount,
      standing: r.standingMicro / MICRO, state: r.state,
      endReason: r.endReason === S.END_REASON_NO_CHARACTER ? CORP_ACCEPTED : r.endReason,
      character: r.characterId === null ? null : pilots.get(r.characterId) || null, characterId: r.characterId,
      adoptedAt: r.adoptedAt, endedAt: r.endedAt };
  }

  function cacheKey() {
    return `w${Math.floor(now() / REFRESH_MS)}`;
  }

  function getData() {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const at = now();
    const r = store.transaction("warContracts.view", (db) => {
      const open = repo.listOpenInTx(db, { afterOfferId: "", limit: deps.viewRows });
      if (!open.ok) return open;
      const recent = repo.listRecentEndedInTx(db, deps.viewRows);
      if (!recent.ok) return recent;
      const sums = repo.sumsByFactionInTx(db, at - deps.viewSumWindowMs);
      if (!sums.ok) return sums;
      const payouts = repo.payoutCountsInTx(db, at - deps.viewSumWindowMs);
      if (!payouts.ok) return payouts;
      return { ok: true, open: open.rows, recent: recent.rows, sums: sums.rows, payouts };
    });
    const v = r && r.ok ? r.value : r;
    if (!r || !r.ok || !v || !v.ok) return { available: false, reason: String((v && v.reason) || "TX_FAILED") };
    const pilots = pilotNames();
    return { available: true, open: v.open.map((x) => rowOf(x, pilots)), recent: v.recent.map((x) => rowOf(x, pilots)),
      sums: v.sums.map((s) => ({ faction: nameOf(names.faction, s.factionId), factionId: s.factionId,
        awarded: s.awarded, lp: s.lp, standing: s.standingMicro / MICRO, isk: s.isk })),
      payouts: { pending: v.payouts.pending, failed: v.payouts.failed }, generatedAt: at };
  }

  return { title: "War contracts", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

function registerWarContractsView(deps) {
  const views = deps && deps.views;
  if (!views || typeof views.registerView !== "function") return null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const def = buildWarContractsView(deps);
  const r = call(() => views.registerView(VIEW_ID, def), null);
  if (r && r.ok) return r;
  log(`view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
  return null;
}

module.exports = { VIEW_ID, VIEW_ORDER, ROW_KEYS, buildWarContractsView, registerWarContractsView };
