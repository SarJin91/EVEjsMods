"use strict";

const { AMMO_RECEIPT_PREFIX } = require("./combatTask");

const KEY_RE = /^(\d+):(\d+):(\d+)$/;

function parseAmmoReceiptKey(key) {
  if (typeof key !== "string" || !key.startsWith(AMMO_RECEIPT_PREFIX)) return null;
  const m = KEY_RE.exec(key.slice(AMMO_RECEIPT_PREFIX.length));
  if (!m) return null;
  const [shipItemId, launchedAtMs, realChargeItemId] = [m[1], m[2], m[3]].map(Number);
  if (![shipItemId, launchedAtMs, realChargeItemId].every(Number.isSafeInteger)) return null;
  return { shipItemId, launchedAtMs, realChargeItemId };
}

function launchKey(shipItemId, launchedAtMs) {
  return `${shipItemId}:${launchedAtMs}`;
}

function createAmmoReceiptSweeper(deps) {
  const access = deps.access;
  const config = deps.config || {};
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const intervalMs = Math.max(0, Number(config.combatAmmoReceiptPruneIntervalMs) || 0);
  let nextAtMs = null;

  function pass(minAgeMs, nowMs) {
    let live;
    try {
      live = new Set((deps.listRecords() || []).map((r) => launchKey(r.shipItemId, r.launchedAtMs)));
    } catch (_err) {
      return { ok: false, reason: "RECORDS_UNAVAILABLE" };
    }
    const isDead = (receipt) => {
      const parsed = parseAmmoReceiptKey(receipt && receipt.receiptKey);
      if (!parsed || live.has(launchKey(parsed.shipItemId, parsed.launchedAtMs))) return false;
      if (minAgeMs > 0) {
        const at = Number(receipt.completedAtMs);
        if (!Number.isFinite(at) || nowMs - at < minAgeMs) return false;
      }
      return true;
    };
    return access.pruneAmmoReceipts(isDead, config.combatAmmoReceiptPruneMaxPerPass);
  }

  function boot() {
    const nowMs = clock.now();
    if (intervalMs > 0) nextAtMs = nowMs + intervalMs;
    return pass(0, nowMs);
  }

  function tick(nowMs) {
    if (nextAtMs === null || !(nowMs >= nextAtMs)) return null;
    nextAtMs = nowMs + intervalMs;
    return pass(Math.max(0, Number(config.combatAmmoReceiptPruneMinAgeMs) || 0), nowMs);
  }

  return { boot, tick };
}

module.exports = { parseAmmoReceiptKey, createAmmoReceiptSweeper };
