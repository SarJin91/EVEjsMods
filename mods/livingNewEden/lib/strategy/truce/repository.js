"use strict";

const { toBind } = require("../../persistence/repository");
const {
  WAR_PAIR_TABLE_NAME, WAR_PAIR_AGGREGATE, EVENT_WAR_PAIR_TRUCE, STATE_TRUCE, MAX_KEY_LENGTH,
} = require("./schema");
const { pairOf, stepWarPair } = require("./weariness");

const COLUMNS = "faction_lo, faction_hi, state, series_start_at, last_battle_at, battles, losses_lo, losses_hi, "
  + "wins_lo, wins_hi, truce_until, truce_initiator, cooldown_until, truces_total, updated_at, version";
const BATTLE_FIELDS = Object.freeze(["lo", "hi", "at", "lossesLo", "lossesHi", "winner"]);
const PARAM_KEYS = Object.freeze(["windowMs", "minLosses", "lossRatioPermille", "maxWinPermille", "truceMs",
  "cooldownMs"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const nullable = (v) => (v === null || v === undefined ? null : Number(v));

function toRecord(row) {
  return Object.freeze({
    lo: Number(row.faction_lo), hi: Number(row.faction_hi), state: String(row.state),
    seriesStartAt: Number(row.series_start_at), lastBattleAt: Number(row.last_battle_at),
    battles: Number(row.battles), lossesLo: Number(row.losses_lo), lossesHi: Number(row.losses_hi),
    winsLo: Number(row.wins_lo), winsHi: Number(row.wins_hi), truceUntil: nullable(row.truce_until),
    initiator: nullable(row.truce_initiator), cooldownUntil: nullable(row.cooldown_until),
    trucesTotal: Number(row.truces_total), updatedAt: Number(row.updated_at), version: Number(row.version),
  });
}

function createTruceRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createTruceRepository: deps missing");
  const { journal, limits, params, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createTruceRepository: journal with applyOnce and findByKey required");
  }
  if (!limits || !isId(limits.maxWarPairRows)) {
    throw new TypeError("createTruceRepository: limits.maxWarPairRows must be a positive integer");
  }
  for (const name of PARAM_KEYS) {
    if (!params || !isCount(params[name])) {
      throw new TypeError(`createTruceRepository: params.${name} must be a non-negative integer`);
    }
  }
  const L = Object.freeze({ maxWarPairRows: limits.maxWarPairRows });
  const P = Object.freeze(Object.fromEntries(PARAM_KEYS.map((k) => [k, params[k]])));
  const count = (name) => {
    if (typeof onCount !== "function") return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = WAR_PAIR_TABLE_NAME;
    s = {
      byKey: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_lo = ? AND faction_hi = ?`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T}`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${T} SET state = ?, series_start_at = ?, last_battle_at = ?, battles = ?,
        losses_lo = ?, losses_hi = ?, wins_lo = ?, wins_hi = ?, truce_until = ?, truce_initiator = ?,
        cooldown_until = ?, truces_total = ?, updated_at = ?, version = version + 1
        WHERE faction_lo = ? AND faction_hi = ? AND version = ?`),
      trucedLo: db.prepare(`SELECT faction_hi AS partner FROM ${T} WHERE faction_lo = ? AND state = 'TRUCE'
        AND truce_until > ? ORDER BY faction_hi LIMIT ?`),
      trucedHi: db.prepare(`SELECT faction_lo AS partner FROM ${T} WHERE faction_hi = ? AND state = 'TRUCE'
        AND truce_until > ? ORDER BY faction_lo LIMIT ?`),
      trucesLo: db.prepare(`SELECT faction_hi AS partner, truce_until, truce_initiator FROM ${T} WHERE faction_lo = ?
        AND state = 'TRUCE' AND truce_until > ? ORDER BY truce_until, faction_hi LIMIT ?`),
      trucesHi: db.prepare(`SELECT faction_lo AS partner, truce_until, truce_initiator FROM ${T} WHERE faction_hi = ?
        AND state = 'TRUCE' AND truce_until > ? ORDER BY truce_until, faction_lo LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function validate(b) {
    if (!isPlainObject(b)) return "battle";
    for (const key of Object.keys(b)) if (!BATTLE_FIELDS.includes(key)) return `battle.${key}`;
    const pair = pairOf(b.lo, b.hi);
    if (pair === null || pair.lo !== b.lo) return "battle.lo";
    if (!isTime(b.at)) return "battle.at";
    if (!isCount(b.lossesLo)) return "battle.lossesLo";
    if (!isCount(b.lossesHi)) return "battle.lossesHi";
    if (b.winner !== null && b.winner !== b.lo && b.winner !== b.hi) return "battle.winner";
    return null;
  }

  function getPairInDb(db, lo, hi) {
    if (!db || db.inTransaction !== true) return TX_REQUIRED;
    const pair = pairOf(lo, hi);
    if (pair === null || pair.lo !== lo) return invalid("pair");
    const row = stmts(db).byKey.get(toBind(lo), toBind(hi));
    return { ok: true, record: row ? toRecord(row) : null };
  }

  function recordBattleInTx(tx, b, key) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const bad = validate(b);
    if (bad !== null) return invalid(bad);
    if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_LENGTH) return invalid("key");
    const seen = journal.findByKey(tx, key);
    if (!seen || seen.ok !== true) return { ok: false, reason: (seen && seen.reason) || "JOURNAL_READ_FAILED" };
    const lo = toBind(b.lo);
    const hi = toBind(b.hi);
    const s = stmts(tx);
    const stored = s.byKey.get(lo, hi) || null;
    const current = stored === null ? null : toRecord(stored);
    if (seen.found === true) {
      return { ok: true, duplicate: true, state: current === null ? "WAR" : current.state, event: null };
    }
    const step = stepWarPair(current, b, P);
    if (step.event === null) {
      count("strategy.warPair.skipped");
      return { ok: true, duplicate: false, state: STATE_TRUCE, event: null, skipped: "TRUCE_IN_FORCE" };
    }
    const n = step.row;
    const payload = { ...Object.fromEntries(BATTLE_FIELDS.map((k) => [k, b[k]])),
      ...(step.event === EVENT_WAR_PAIR_TRUCE ? { truceUntil: n.truceUntil, initiator: n.initiator } : {}) };
    const result = journal.applyOnce(tx, { key, aggregate: { type: WAR_PAIR_AGGREGATE, id: `${b.lo}:${b.hi}` },
      eventType: step.event, payload }, (db) => {
      const w = stmts(db);
      const values = [n.state, toBind(n.seriesStartAt), toBind(n.lastBattleAt), toBind(n.battles), toBind(n.lossesLo),
        toBind(n.lossesHi), toBind(n.winsLo), toBind(n.winsHi), n.truceUntil === null ? null : toBind(n.truceUntil),
        n.initiator === null ? null : toBind(n.initiator), n.cooldownUntil === null ? null : toBind(n.cooldownUntil),
        toBind(n.trucesTotal), toBind(b.at)];
      if (current !== null) {
        const r = w.update.run(...values, lo, hi, toBind(current.version));
        if (r.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
      } else {
        if (Number(w.countAll.get().n) >= L.maxWarPairRows) {
          return { ok: false, reason: "WAR_PAIR_LIMIT", limit: L.maxWarPairRows };
        }
        w.insert.run(lo, hi, ...values);
      }
      return { ok: true };
    });
    if (!result.ok) {
      const refusal = result.reason === "APPLY_REFUSED" ? result.refusal : result;
      return refusal && refusal.reason ? refusal : { ok: false, reason: "WAR_PAIR_WRITE_FAILED" };
    }
    if (result.duplicate) return { ok: true, duplicate: true, state: n.state, event: null };
    count("strategy.warPair.recorded");
    if (step.event === EVENT_WAR_PAIR_TRUCE) count("strategy.warPair.truceStarted");
    return { ok: true, duplicate: false, state: n.state, event: step.event };
  }

  function listTrucedInDb(db, f, at) {
    if (!db || db.inTransaction !== true) return TX_REQUIRED;
    if (!isId(f)) return invalid("factionId");
    if (!isTime(at)) return invalid("at");
    const s = stmts(db);
    const lim = toBind(L.maxWarPairRows);
    const rows = [...s.trucedLo.all(toBind(f), toBind(at), lim), ...s.trucedHi.all(toBind(f), toBind(at), lim)];
    const partners = rows.map((r) => Number(r.partner)).sort((x, y) => x - y).slice(0, L.maxWarPairRows);
    return { ok: true, partners };
  }

  function listTrucesInDb(db, f, at) {
    if (!db || db.inTransaction !== true) return TX_REQUIRED;
    if (!isId(f)) return invalid("factionId");
    if (!isTime(at)) return invalid("at");
    const s = stmts(db);
    const lim = toBind(L.maxWarPairRows);
    const rows = [...s.trucesLo.all(toBind(f), toBind(at), lim), ...s.trucesHi.all(toBind(f), toBind(at), lim)];
    const truces = rows.map((r) => ({ partner: Number(r.partner), until: Number(r.truce_until),
      initiator: nullable(r.truce_initiator) }))
      .sort((x, y) => x.until - y.until || x.partner - y.partner).slice(0, L.maxWarPairRows);
    return { ok: true, truces };
  }

  return Object.freeze({ getPairInDb, recordBattleInTx, listTrucedInDb, listTrucesInDb, limits: L, params: P });
}

module.exports = { createTruceRepository };
