"use strict";

const { CAUSES } = require("./schema");

const MIN_FLEET_ROWS = 3;

function createCrewsConsequence(deps) {
  const S = deps.settings;
  return Object.freeze({ name: "crews", apply(tx, settled, _ck) {
    if (!settled || !Array.isArray(settled.fleets) || !Number.isSafeInteger(settled.at)) {
      return { ok: false, reason: "INVALID_ARGUMENT", detail: "settled" };
    }
    let lost = 0;
    let fleets = 0;
    let truncated = 0;
    let deferred = 0;
    let rowsLeft = S.maxSettleRows;
    for (const f of settled.fleets) {
      if (!f || !(f.lost > 0 || f.disposition === "DESTROYED")) continue;
      if (rowsLeft < MIN_FLEET_ROWS) {
        deferred += 1;
        continue;
      }
      const r = deps.reconcileInTx(tx, f.fleetId, { cause: CAUSES.BATTLE, at: settled.at, enlist: false,
        budget: { seats: S.maxCrewPerFleet * 2, reclaim: 0 }, maxRows: rowsLeft });
      if (!r.ok) return { ok: false, reason: r.reason, fleetId: f.fleetId };
      rowsLeft -= r.writes + 1;
      lost += r.lost;
      truncated += r.truncated;
      fleets += 1;
    }
    if (lost > 0 && typeof deps.onLost === "function") deps.onLost(lost);
    if (truncated + deferred > 0 && typeof deps.onTruncated === "function") deps.onTruncated(truncated + deferred);
    return { ok: true, lost, fleets, truncated, deferred };
  } });
}

module.exports = { createCrewsConsequence };
