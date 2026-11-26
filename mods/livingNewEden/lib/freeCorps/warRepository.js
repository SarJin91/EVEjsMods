"use strict";

const { toBind } = require("../persistence/repository");
const { WAR_STATES, WAR_END_REASONS, SKIRMISH_OUTCOMES } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const DUPLICATE = Object.freeze({ ok: false, reason: "DUPLICATE" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const bindOrNull = (v) => (v === null || v === undefined ? null : toBind(v));

const WAR_COLUMNS = ["war_id", "corp_a", "corp_b", "n", "declarer_corp_id", "ally_corp_id", "ally_side",
  "ally_fee_isk", "declare_cost_isk", "state", "open", "declared_at", "active_at", "ends_at", "next_at", "ended_at",
  "kills_a", "kills_b", "isk_lost_a", "isk_lost_b", "skirmishes", "surrender_isk", "winner", "end_reason",
  "updated_at", "version"];
const WAR_TEXT = new Set(["war_id", "ally_side", "state", "end_reason"]);
const WAR_SELECT = WAR_COLUMNS.map((c) => `w.${c}`).join(", ");
const WAR_COUNTERS = Object.freeze(["kills_a", "kills_b", "isk_lost_a", "isk_lost_b", "skirmishes", "surrender_isk"]);
const SKIRMISH_COLUMNS = ["skirmish_id", "at", "system_id", "sec_band", "war_id", "attacker_corp_id",
  "attacker_venture_id", "attacker_kind", "attacker_crew", "defender_corp_id", "defender_venture_id", "defender_kind",
  "defender_crew", "crew_lost_a", "crew_lost_d", "isk_lost_a", "isk_lost_d", "loot_isk", "outcome", "seed"];
const SKIRMISH_TEXT = new Set(["skirmish_id", "sec_band", "war_id", "attacker_venture_id", "attacker_kind",
  "defender_venture_id", "defender_kind", "outcome"]);
const STATES = Object.freeze(Object.values(WAR_STATES));

function convert(r, textSet) {
  const out = {};
  for (const [k, v] of Object.entries(r)) out[k] = textSet.has(k) || typeof v === "string" ? v : num(v);
  return Object.freeze(out);
}
const warOf = (r) => convert(r, WAR_TEXT);
const skirmishOf = (r) => convert(r, SKIRMISH_TEXT);

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

const page = (rows, limit) => {
  const truncated = rows.length > limit;
  return { ok: true, rows: truncated ? rows.slice(0, limit) : rows, truncated };
};

function createFreeCorpWarRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      open: db.prepare(`SELECT ${WAR_SELECT}, ca.home_system_id AS home_a, cb.home_system_id AS home_b, `
        + "cl.home_system_id AS home_ally FROM world_free_corp_wars w "
        + "LEFT JOIN world_free_corps ca ON ca.corp_id = w.corp_a "
        + "LEFT JOIN world_free_corps cb ON cb.corp_id = w.corp_b "
        + "LEFT JOIN world_free_corps cl ON cl.corp_id = w.ally_corp_id "
        + "WHERE w.open = 1 ORDER BY w.next_at, w.war_id LIMIT ?"),
      last: db.prepare("SELECT n, open, ended_at FROM world_free_corp_wars WHERE corp_a = ? AND corp_b = ? "
        + "ORDER BY n DESC LIMIT 1"),
      insert: db.prepare("INSERT INTO world_free_corp_wars (war_id, corp_a, corp_b, n, declarer_corp_id, "
        + "ally_corp_id, ally_side, ally_fee_isk, declare_cost_isk, state, open, declared_at, active_at, ends_at, "
        + "next_at, ended_at, kills_a, kills_b, isk_lost_a, isk_lost_b, skirmishes, surrender_isk, winner, end_reason, "
        + "updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, NULL, 0, 0, 0, 0, 0, 0, NULL, "
        + "NULL, ?, 1)"),
      update: db.prepare("UPDATE world_free_corp_wars SET state = ?, open = ?, next_at = ?, ended_at = ?, "
        + "kills_a = ?, kills_b = ?, isk_lost_a = ?, isk_lost_b = ?, skirmishes = ?, surrender_isk = ?, winner = ?, "
        + "end_reason = ?, version = version + 1, updated_at = ? WHERE war_id = ? AND version = ? AND state = ?"),
      insertSkirmish: db.prepare(`INSERT INTO world_free_corp_skirmishes (${SKIRMISH_COLUMNS.join(", ")}) VALUES `
        + `(${SKIRMISH_COLUMNS.map(() => "?").join(", ")})`),
      pruneWars: db.prepare("DELETE FROM world_free_corp_wars WHERE war_id IN (SELECT war_id FROM "
        + "world_free_corp_wars WHERE open = 0 AND ended_at < ? ORDER BY ended_at, war_id LIMIT ?)"),
      pruneSkirmishes: db.prepare("DELETE FROM world_free_corp_skirmishes WHERE skirmish_id IN (SELECT skirmish_id "
        + "FROM world_free_corp_skirmishes WHERE at < ? ORDER BY at, skirmish_id LIMIT ?)"),
      view: db.prepare(`SELECT ${WAR_SELECT}, ca.name AS name_a, ca.ticker AS ticker_a, cb.name AS name_b, `
        + "cb.ticker AS ticker_b, cl.name AS name_ally, cl.ticker AS ticker_ally FROM world_free_corp_wars w "
        + "LEFT JOIN world_free_corps ca ON ca.corp_id = w.corp_a "
        + "LEFT JOIN world_free_corps cb ON cb.corp_id = w.corp_b "
        + "LEFT JOIN world_free_corps cl ON cl.corp_id = w.ally_corp_id "
        + "WHERE w.open = 1 ORDER BY w.next_at, w.war_id LIMIT ?"),
      recent: db.prepare(`SELECT ${SKIRMISH_COLUMNS.map((c) => `s.${c}`).join(", ")}, ca.ticker AS ticker_a, `
        + "cd.ticker AS ticker_d FROM world_free_corp_skirmishes s "
        + "LEFT JOIN world_free_corps ca ON ca.corp_id = s.attacker_corp_id "
        + "LEFT JOIN world_free_corps cd ON cd.corp_id = s.defender_corp_id "
        + "ORDER BY s.at DESC, s.skirmish_id DESC LIMIT ?"),
      since: db.prepare("SELECT outcome, COUNT(*) AS n FROM world_free_corp_skirmishes WHERE at >= ? "
        + "GROUP BY outcome ORDER BY outcome"),
    };
    cache.set(db, s);
    return s;
  }

  function listOpenInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return page(stmts(tx).open.all(toBind(limit + 1)).map(warOf), limit);
  }

  function lastOfPairInTx(tx, corpA, corpB) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpA) || !isId(corpB) || corpA >= corpB) return invalid("pair");
    const r = stmts(tx).last.get(toBind(corpA), toBind(corpB));
    return { ok: true, last: r ? Object.freeze({ n: num(r.n), open: num(r.open), endedAt: num(r.ended_at) }) : null };
  }

  function insertWarInTx(tx, row, at) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!row || typeof row.war_id !== "string" || !isId(row.corp_a) || !isId(row.corp_b) || row.corp_a >= row.corp_b
      || !isId(row.n) || !isId(row.declarer_corp_id) || !isTime(at)) {
      return invalid("row/at");
    }
    if (row.state !== WAR_STATES.DECLARED) return invalid("state");
    for (const c of ["ally_fee_isk", "declare_cost_isk", "declared_at", "active_at", "ends_at", "next_at"]) {
      if (!isTime(row[c])) return invalid(c);
    }
    const ally = row.ally_corp_id === undefined ? null : row.ally_corp_id;
    const side = row.ally_side === undefined ? null : row.ally_side;
    if ((ally === null) !== (side === null) || (ally !== null && !isId(ally)) || (side !== null && side !== "A"
      && side !== "B")) {
      return invalid("ally");
    }
    try {
      stmts(tx).insert.run(row.war_id, toBind(row.corp_a), toBind(row.corp_b), toBind(row.n),
        toBind(row.declarer_corp_id), bindOrNull(ally), side, toBind(row.ally_fee_isk), toBind(row.declare_cost_isk),
        row.state, toBind(row.declared_at), toBind(row.active_at), toBind(row.ends_at), toBind(row.next_at),
        toBind(at));
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
    return { ok: true, warId: row.war_id };
  }

  function updateWarInTx(tx, { warId, expectedVersion, expectedState, row, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof warId !== "string" || !isId(expectedVersion) || !STATES.includes(expectedState) || !isTime(at)
      || !row) {
      return invalid("update");
    }
    if (!STATES.includes(row.state)) return invalid("state");
    const open = row.state === WAR_STATES.ENDED ? 0 : 1;
    const ended = row.ended_at === undefined ? null : row.ended_at;
    const reason = row.end_reason === undefined ? null : row.end_reason;
    const winner = row.winner === undefined ? null : row.winner;
    if (row.open !== open || (ended === null) !== (open === 1) || (ended !== null && !isTime(ended))) {
      return invalid("state/open");
    }
    if ((reason === null) !== (open === 1) || (reason !== null && !WAR_END_REASONS.includes(reason))) {
      return invalid("end_reason");
    }
    if (winner !== null && (!isId(winner) || open === 1)) return invalid("winner");
    if (!isTime(row.next_at)) return invalid("next_at");
    for (const c of WAR_COUNTERS) if (!isTime(row[c])) return invalid(c);
    const info = stmts(tx).update.run(row.state, toBind(open), toBind(row.next_at), bindOrNull(ended),
      toBind(row.kills_a), toBind(row.kills_b), toBind(row.isk_lost_a), toBind(row.isk_lost_b), toBind(row.skirmishes),
      toBind(row.surrender_isk), bindOrNull(winner), reason, toBind(at), warId, toBind(expectedVersion),
      expectedState);
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function insertSkirmishInTx(tx, row) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!row || typeof row.skirmish_id !== "string" || !isTime(row.at) || !isId(row.system_id)
      || !isId(row.attacker_corp_id) || !isId(row.defender_corp_id)
      || !Object.values(SKIRMISH_OUTCOMES).includes(row.outcome)) {
      return invalid("row");
    }
    for (const c of ["attacker_crew", "defender_crew", "crew_lost_a", "crew_lost_d", "isk_lost_a", "isk_lost_d",
      "loot_isk", "seed"]) {
      if (!isTime(row[c])) return invalid(c);
    }
    try {
      stmts(tx).insertSkirmish.run(...SKIRMISH_COLUMNS.map((c) => (SKIRMISH_TEXT.has(c)
        ? (row[c] === undefined ? null : row[c]) : bindOrNull(row[c]))));
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
    return { ok: true, skirmishId: row.skirmish_id };
  }

  function pruneInTx(tx, { before, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isId(limit)) return invalid("before/limit");
    const s = stmts(tx);
    const wars = Number(s.pruneWars.run(toBind(before), toBind(limit)).changes);
    const skirmishes = Number(s.pruneSkirmishes.run(toBind(before), toBind(limit)).changes);
    return { ok: true, wars, skirmishes };
  }

  function listForViewInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return page(stmts(tx).view.all(toBind(limit + 1)).map(warOf), limit);
  }

  function recentSkirmishesInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).recent.all(toBind(limit)).map(skirmishOf) };
  }

  function countSkirmishesSinceInTx(tx, since) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(since)) return invalid("since");
    const byOutcome = { ATTACKER_WIN: 0, DEFENDER_WIN: 0 };
    let count = 0;
    for (const r of stmts(tx).since.all(toBind(since))) {
      const n = num(r.n);
      byOutcome[r.outcome] = n;
      count += n;
    }
    return { ok: true, count, byOutcome };
  }

  return Object.freeze({ listOpenInTx, lastOfPairInTx, insertWarInTx, updateWarInTx, insertSkirmishInTx, pruneInTx,
    listForViewInTx, recentSkirmishesInTx, countSkirmishesSinceInTx });
}

module.exports = { createFreeCorpWarRepository };
