"use strict";

const OPEN = "('PENDING', 'CLAIMED', 'RESOLVING', 'LIVE', 'SETTLING')";

function messageOf(err) {
  return String((err && err.message) || err);
}

function checkBattleInvariants(db) {
  try {
    const one = (sql) => db.prepare(sql).get().n;
    const out = { ok: true, battles: 0, completed: 0, open: 0, failed: 0, quarantined: 0 };
    for (const row of db.prepare("SELECT state, count(*) AS n FROM battle_records GROUP BY state").all()) {
      out.battles += row.n;
      if (row.state === "COMPLETED") out.completed = row.n;
      else if (row.state === "FAILED") out.failed = row.n;
      else if (row.state === "QUARANTINED") out.quarantined = row.n;
      else out.open += row.n;
    }
    const settledTwice = one(`SELECT count(*) AS n FROM (SELECT aggregate_id FROM world_event_journal
      WHERE kind = 'APPLY' AND event_type = 'BATTLE_SETTLED' GROUP BY aggregate_id HAVING count(*) > 1)`);
    const keyTwice = one(`SELECT count(*) AS n FROM (SELECT idempotency_key FROM battle_records
      GROUP BY idempotency_key HAVING count(*) > 1)`);
    const settleKeyTwice = one(`SELECT count(*) AS n FROM (SELECT settlement_key FROM battle_records
      WHERE settlement_key IS NOT NULL GROUP BY settlement_key HAVING count(*) > 1)`);
    out.duplicateSettlements = settledTwice + keyTwice + settleKeyTwice;
    out.fleetsInTwoOpenBattles = one(`SELECT count(*) AS n FROM (SELECT p.fleet_id FROM battle_participants p
      JOIN battle_records b ON b.battle_id = p.battle_id WHERE b.state IN ${OPEN}
      GROUP BY p.fleet_id HAVING count(*) > 1)`);
    out.orphanEngaged = one(`SELECT count(*) AS n FROM virtual_fleets f WHERE f.state = 'ENGAGED'
      AND NOT EXISTS (SELECT 1 FROM battle_participants p JOIN battle_records b ON b.battle_id = p.battle_id
        WHERE p.fleet_id = f.fleet_id AND (b.state IN ${OPEN} OR b.state = 'QUARANTINED'))`);
    out.openWithoutEvent = one(`SELECT count(*) AS n FROM battle_records b
      WHERE b.state IN ('PENDING', 'CLAIMED', 'RESOLVING', 'SETTLING') AND coalesce(b.mode, '') <> 'LIVE_EVEJS'
      AND NOT EXISTS (SELECT 1 FROM world_scheduled_events e WHERE e.event_type = 'BATTLE_RESOLUTION'
        AND e.aggregate_id = b.battle_id AND e.state <> 'DONE' AND e.state IN ('QUEUED', 'RETRY', 'CLAIMED'))`);
    const wrecks = db.prepare(`SELECT max(n) AS n FROM (SELECT count(*) AS n FROM world_wreck_fields
      WHERE battle_id IS NOT NULL GROUP BY battle_id)`).get().n;
    out.wreckFieldsPerBattleMax = wrecks === null ? 0 : wrecks;
    out.pass = out.duplicateSettlements === 0 && out.fleetsInTwoOpenBattles === 0 && out.orphanEngaged === 0
      && out.openWithoutEvent === 0 && out.wreckFieldsPerBattleMax <= 1 && out.quarantined === 0;
    return out;
  } catch (err) {
    return { ok: false, reason: "CHECK_FAILED", detail: messageOf(err) };
  }
}

function formatBattleCheck(r) {
  if (!r.ok) return `check-battles: ${r.reason} ${r.detail || ""}`;
  return `check-battles: battles=${r.battles} completed=${r.completed} open=${r.open} failed=${r.failed}`
    + ` quarantined=${r.quarantined} duplicateSettlements=${r.duplicateSettlements}`
    + ` fleetsInTwoOpenBattles=${r.fleetsInTwoOpenBattles} orphanEngaged=${r.orphanEngaged}`
    + ` openWithoutEvent=${r.openWithoutEvent} wreckFieldsPerBattleMax=${r.wreckFieldsPerBattleMax}`
    + ` -> ${r.pass ? "PASS" : "FAIL"}`;
}

module.exports = { checkBattleInvariants, formatBattleCheck };
