"use strict";

const { pairOf } = require("./weariness");
const { warPairKeyOf } = require("./schema");

const NAME = "warPair";

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const skip = (why) => ({ ok: true, recorded: 0, skipped: why });

function createWarPairConsequence(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createWarPairConsequence: deps missing");
  const { repository, registry, isHostile, kinds } = deps;
  if (!repository || typeof repository.recordBattleInTx !== "function") {
    throw new TypeError("createWarPairConsequence: repository required");
  }
  if (!registry || typeof registry.getFaction !== "function") {
    throw new TypeError("createWarPairConsequence: registry required");
  }
  if (typeof isHostile !== "function") throw new TypeError("createWarPairConsequence: isHostile required");
  if (!Array.isArray(kinds)) throw new TypeError("createWarPairConsequence: kinds must be an array");
  const kindSet = new Set(kinds);

  function eligible(f) {
    const entry = registry.getFaction(f);
    if (entry === null || entry === undefined) return false;
    if (typeof registry.isActive === "function" && registry.isActive(f) !== true) return false;
    return kindSet.has(entry.kind);
  }

  function applyIn(tx, settled, ck) {
    if (!isPlainObject(settled) || !isTime(settled.at) || !isPlainObject(settled.sides)
      || !isPlainObject(settled.sides.A) || !isPlainObject(settled.sides.B) || !Array.isArray(settled.losses)) {
      return { ok: false, reason: "WAR_PAIR_INPUT_INVALID", detail: "settled" };
    }
    if (typeof ck !== "string" || ck.length < 1) return { ok: false, reason: "WAR_PAIR_INPUT_INVALID", detail: "ck" };
    const a = settled.sides.A.factionId;
    const b = settled.sides.B.factionId;
    const pair = pairOf(a, b);
    if (pair === null) return skip("NOT_A_PAIR");
    if (!eligible(a) || !eligible(b)) return skip("NOT_ELIGIBLE");
    if (isHostile(a, b) !== true) return skip("NOT_HOSTILE");
    let lossesLo = 0;
    let lossesHi = 0;
    for (const row of settled.losses) {
      if (!isPlainObject(row) || !Number.isSafeInteger(row.count) || row.count < 0) {
        return { ok: false, reason: "WAR_PAIR_INPUT_INVALID", detail: "losses[]" };
      }
      if (row.factionId === pair.lo) lossesLo += row.count;
      else if (row.factionId === pair.hi) lossesHi += row.count;
    }
    const w = settled.winnerFactionId;
    const winner = w === pair.lo || w === pair.hi ? w : null;
    const r = repository.recordBattleInTx(tx, { lo: pair.lo, hi: pair.hi, at: settled.at, lossesLo, lossesHi,
      winner }, warPairKeyOf(ck));
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "WAR_PAIR_WRITE_FAILED" };
    if (r.skipped) return skip(r.skipped);
    return { ok: true, recorded: r.duplicate === true ? 0 : 1 };
  }

  return Object.freeze({ name: NAME, apply(tx, settled, ck) {
    try {
      return applyIn(tx, settled, ck);
    } catch (err) {
      return { ok: false, reason: "WAR_PAIR_THREW", detail: String((err && err.message) || err).slice(0, 200) };
    }
  } });
}

module.exports = { createWarPairConsequence };
