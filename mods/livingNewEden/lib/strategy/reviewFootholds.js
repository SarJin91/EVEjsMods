"use strict";

const INVADER = "invader";
const FOOTHOLDS_THREW = "FOOTHOLDS_THREW";
const MAX_DETAIL_LENGTH = 200;

const emptyResult = () => ({ ok: true, footholds: [] });

function detailOf(err) {
  try {
    return String(err && err.message ? err.message : err).slice(0, MAX_DETAIL_LENGTH);
  } catch {
    return "unknown";
  }
}

function createReviewFootholdsOf(deps) {
  const { hive, footholdsOf, enabled, kindOf } = deps;
  return (tx, f) => {
    try {
      if (hive.isHive(f)) return hive.listNodesInTx(tx, f);
      if (enabled === true && typeof footholdsOf === "function" && kindOf(f) === INVADER) return footholdsOf(tx, f);
      return emptyResult();
    } catch (err) {
      return { ok: false, reason: FOOTHOLDS_THREW, detail: detailOf(err) };
    }
  };
}

module.exports = { createReviewFootholdsOf, FOOTHOLDS_THREW };
