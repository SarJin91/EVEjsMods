"use strict";

const { CAPITAL_HULL_GROUPS } = require("../fleets/schema");

const CAPITAL_NO_PROFILE_DETAIL = "CAPITAL";

const isCapital = (hullGroup) => CAPITAL_HULL_GROUPS.includes(hullGroup);

function noop() {}

function createCapitalRules(deps) {
  const S = deps && deps.settings ? deps.settings : {};
  const count = deps && typeof deps.count === "function" ? deps.count : noop;
  const log = deps && typeof deps.log === "function" ? deps.log : noop;
  const weight = Number.isSafeInteger(S.capitalBudgetWeight) && S.capitalBudgetWeight >= 1 ? S.capitalBudgetWeight : 1;
  const distanceMeters = Number.isSafeInteger(S.capitalAnchorDistanceMeters) && S.capitalAnchorDistanceMeters > 0
    ? S.capitalAnchorDistanceMeters : null;
  const warned = new Set();

  const slotsOf = (members) => {
    let n = 0;
    for (const m of members) n += m && isCapital(m.hullGroup) ? weight : 1;
    return n;
  };

  const countOf = (members) => members.filter((m) => m && isCapital(m.hullGroup)).length;

  const noteSpawned = (n) => {
    if (n > 0) count("capitalSpawned", n);
  };

  const noteRefused = (r, where) => {
    if (!r || r.reason !== "NO_PROFILE" || r.detail !== CAPITAL_NO_PROFILE_DETAIL) return;
    count("capitalNoProfile", 1);
    const key = `${r.hullGroup}:${r.factionId}`;
    if (warned.has(key)) return;
    warned.add(key);
    try {
      log(`materialization: WARNING no LIVE capital profile for ${r.hullGroup} of faction ${r.factionId} (${where}) - `
        + "stays virtual; check materialization.capitalLiveEnabled / capitalClassesLive and the capitalLive probe "
        + "(shown once per class and faction)");
    } catch (_err) {
    }
  };

  return Object.freeze({ weight, distanceMeters, isCapital, slotsOf, countOf, noteSpawned, noteRefused });
}

const NO_CAPITAL_RULES = createCapitalRules({ settings: {} });

module.exports = { CAPITAL_NO_PROFILE_DETAIL, createCapitalRules, NO_CAPITAL_RULES };
