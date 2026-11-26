"use strict";

const S = require("./schema");

const PERMILLE = 1000;
const MAX_FIT_PERMILLE = 10000;
const NAME = "treasury";
const NO_TREASURY_KINDS = Object.freeze(["hive"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "TREASURY_INVALID_INPUT", detail });

function scaledPermille(isk, permille) {
  const q = Math.floor(isk / PERMILLE);
  const r = isk % PERMILLE;
  return Math.min(S.MAX_ISK, q * permille + Math.floor((r * permille) / PERMILLE));
}

function lossChargesOf(losses, valueOf, fitValuePermille) {
  if (!Array.isArray(losses)) return invalid("losses");
  if (typeof valueOf !== "function") return invalid("valueOf");
  if (!Number.isSafeInteger(fitValuePermille) || fitValuePermille < 0 || fitValuePermille > MAX_FIT_PERMILLE) {
    return invalid("fitValuePermille");
  }
  const byFaction = new Map();
  for (const row of losses) {
    if (!row || !isId(row.factionId)) return invalid("factionId");
    if (!Number.isSafeInteger(row.count) || row.count < 1) return invalid("count");
    if (typeof row.hullGroup !== "string" || row.hullGroup === "") return invalid("hullGroup");
    let acc = byFaction.get(row.factionId);
    if (!acc) {
      acc = { hullIsk: 0, shipsLost: 0, unvalued: 0 };
      byFaction.set(row.factionId, acc);
    }
    const v = valueOf(row.hullGroup);
    if (Number.isSafeInteger(v) && v >= 0) {
      acc.hullIsk = Math.min(S.MAX_ISK, acc.hullIsk + Math.min(S.MAX_ISK, row.count * v));
    } else acc.unvalued = Math.min(S.MAX_ISK, acc.unvalued + row.count);
    acc.shipsLost = Math.min(S.MAX_ISK, acc.shipsLost + row.count);
  }
  const charges = [...byFaction.keys()].sort((a, b) => a - b).map((factionId) => {
    const acc = byFaction.get(factionId);
    const lossFit = scaledPermille(acc.hullIsk, fitValuePermille);
    return { factionId, lossFit, lossValue: Math.min(S.MAX_ISK, acc.hullIsk + lossFit), shipsLost: acc.shipsLost,
      unvalued: acc.unvalued };
  });
  return { ok: true, charges };
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createTreasuryLossConsequence(deps) {
  const { repository, hullValues, fitValuePermille, seedIfMissingInTx, getRegistry, isRunning } = deps;
  const count = (name, n) => call(() => deps.count(name, n), undefined);

  function apply(tx, settled, ck) {
    if (!call(isRunning, false)) return { ok: true, skipped: "TREASURY_OFF" };
    const losses = settled && settled.losses;
    if (!Array.isArray(losses) || losses.length === 0) return { ok: true, skipped: "NO_LOSSES" };
    const registry = call(getRegistry, null);
    if (!registry || typeof registry.isActive !== "function" || typeof registry.getFaction !== "function") {
      return { ok: true, skipped: "REGISTRY_UNAVAILABLE" };
    }
    if (typeof ck !== "string" || ck === "" || !Number.isSafeInteger(settled.at) || settled.at < 0) {
      return invalid("settled");
    }
    const c = lossChargesOf(losses, (g) => hullValues.valueOf(g), fitValuePermille);
    if (!c.ok) return c;
    const day = S.dayOf(settled.at);
    const charged = [];
    let skipped = 0;
    let unvalued = 0;
    let fitPaid = 0;
    let unpaid = 0;
    let seeded = 0;
    for (const ch of c.charges) {
      const f = ch.factionId;
      if (call(() => registry.isActive(f), false) !== true) {
        skipped += 1;
        continue;
      }
      const entry = call(() => registry.getFaction(f), null);
      if (entry && NO_TREASURY_KINDS.includes(entry.kind)) {
        skipped += 1;
        continue;
      }
      const sd = seedIfMissingInTx(tx, f, entry && typeof entry.kind === "string" ? entry.kind : "", settled.at);
      if (!sd || sd.ok !== true) return sd || { ok: false, reason: "TREASURY_SEED_FAILED", detail: String(f) };
      if (sd.seeded) seeded += 1;
      const key = `${ck}:${f}`;
      const st = repository.settleInTx(tx, { factionId: f, day, at: settled.at, credits: {},
        debits: { lossFit: ch.lossFit }, stats: { lossValue: ch.lossValue, shipsLost: ch.shipsLost } }, key);
      if (!st || st.ok !== true) return st || { ok: false, reason: "TREASURY_SETTLE_FAILED", detail: key };
      if (st.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
      fitPaid = Math.min(S.MAX_ISK, fitPaid + st.paid.lossFit);
      unpaid = Math.min(S.MAX_ISK, unpaid + st.unpaid);
      unvalued += ch.unvalued;
      charged.push({ factionId: f, lossFit: ch.lossFit, paid: st.paid.lossFit, unpaid: st.unpaid,
        lossValue: ch.lossValue, shipsLost: ch.shipsLost });
    }
    count("seeded", seeded);
    count("lossSettled", charged.length);
    count("lossSkipped", skipped);
    count("lossFitIsk", fitPaid);
    count("lossUnvalued", unvalued);
    count("unpaid", unpaid);
    return { ok: true, charged, skipped };
  }

  return Object.freeze({ name: NAME, apply });
}

module.exports = { lossChargesOf, createTreasuryLossConsequence, NO_TREASURY_KINDS };
