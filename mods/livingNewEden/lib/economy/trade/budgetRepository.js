"use strict";

const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");
const S = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const BUDGETS_TABLE = defineTable({ name: S.BUDGETS_TABLE_NAME, idColumn: "faction_id", columns: ["isk_available",
  "isk_reserved", "funded_units_total", "funded_total", "spent_total", "released_total", "last_funded_at",
  "updated_at", "wts_proceeds_total", "wts_treasury_total", "wts_burned_total"] });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isIsk = (v) => Number.isSafeInteger(v) && v >= 0 && v <= S.MAX_ISK;
const isDelta = (v) => Number.isSafeInteger(v) && Math.abs(v) <= S.MAX_ISK;
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "TRADE_INVALID_INPUT", detail });
const saturate = (v) => Math.min(S.MAX_ISK, v);

function toBudget(row) {
  return Object.freeze({ factionId: row.faction_id, availableIsk: row.isk_available, reservedIsk: row.isk_reserved,
    fundedUnitsTotal: row.funded_units_total, fundedTotal: row.funded_total, spentTotal: row.spent_total,
    releasedTotal: row.released_total, lastFundedAt: row.last_funded_at, createdAt: row.created_at,
    updatedAt: row.updated_at, version: row.version,
    wtsProceedsTotal: row.wts_proceeds_total ?? 0, wtsTreasuryTotal: row.wts_treasury_total ?? 0,
    wtsBurnedTotal: row.wts_burned_total ?? 0 });
}

function createBudgetRepository(deps) {
  const { journal, clock } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("budgetRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("budgetRepository: clock");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      byId: db.prepare("SELECT * FROM world_trade_budgets WHERE faction_id = ?"),
      list: db.prepare("SELECT * FROM world_trade_budgets ORDER BY faction_id LIMIT ?"),
      insert: db.prepare(`INSERT INTO world_trade_budgets (faction_id, isk_available, isk_reserved, funded_units_total,
        funded_total, spent_total, released_total, last_funded_at, created_at, updated_at, version)
        VALUES (?, ?, 0, ?, ?, 0, 0, ?, ?, ?, 1)`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function getBudget(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    const row = stmts(tx).byId.get(toBind(factionId));
    return { ok: true, budget: row ? toBudget(row) : null };
  }

  function listBudgets(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = opts && opts.limit;
    if (!Number.isSafeInteger(limit) || limit < 1) return invalid("limit");
    return { ok: true, budgets: stmts(tx).list.all(toBind(limit)).map(toBudget) };
  }

  function fundInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.factionId) || !Number.isSafeInteger(spec.units) || spec.units < 1
      || !isTime(spec.paidUntilTo) || !Number.isSafeInteger(spec.iskPerUnit) || spec.iskPerUnit < 1
      || !isIsk(spec.capIsk) || !isTime(spec.at)) {
      return invalid("spec");
    }
    if (typeof key !== "string" || key === "") return invalid("key");
    const payload = { factionId: spec.factionId, units: spec.units, paidUntilTo: spec.paidUntilTo };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.BUDGET_AGGREGATE, id: String(spec.factionId) },
      eventType: S.EVENT_BUDGET_FUNDED, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.factionId));
      const held = row ? row.isk_available + row.isk_reserved : 0;
      const headroom = Math.max(0, spec.capIsk - held);
      const fundedUnits = Math.min(spec.units, Math.floor(headroom / spec.iskPerUnit));
      const fundedIsk = fundedUnits * spec.iskPerUnit;
      const capped = fundedUnits < spec.units;
      if (fundedUnits === 0) return { ok: true, fundedUnits, fundedIsk, capped, budget: row ? toBudget(row) : null };
      if (!row) {
        s.insert.run(toBind(spec.factionId), toBind(fundedIsk), toBind(saturate(fundedUnits)), toBind(fundedIsk),
          toBind(spec.at), toBind(spec.at), toBind(spec.at));
      } else {
        const u = updateWithVersion(db, BUDGETS_TABLE, spec.factionId, row.version, {
          isk_available: row.isk_available + fundedIsk,
          funded_units_total: saturate(row.funded_units_total + fundedUnits),
          funded_total: saturate(row.funded_total + fundedIsk),
          last_funded_at: spec.at, updated_at: spec.at });
        if (!u.ok) return u;
      }
      return { ok: true, fundedUnits, fundedIsk, capped, budget: toBudget(s.byId.get(toBind(spec.factionId))) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(toBind(spec.factionId));
      return { ok: true, duplicate: true, fundedUnits: 0, fundedIsk: 0, capped: false,
        budget: row ? toBudget(row) : null };
    }
    if (r.value.fundedUnits > 0) changes += 1;
    return { ok: true, duplicate: false, fundedUnits: r.value.fundedUnits, fundedIsk: r.value.fundedIsk,
      capped: r.value.capped, budget: r.value.budget };
  }

  function fundIskInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.factionId) || !isIsk(spec.isk) || spec.isk < 1 || !isIsk(spec.capIsk)
      || !isTime(spec.at)) {
      return invalid("spec");
    }
    if (typeof key !== "string" || key === "") return invalid("key");
    const payload = { factionId: spec.factionId, isk: spec.isk };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.BUDGET_AGGREGATE, id: String(spec.factionId) },
      eventType: S.EVENT_BUDGET_TREASURY, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.factionId));
      const held = row ? row.isk_available + row.isk_reserved : 0;
      const fundedIsk = Math.min(spec.isk, Math.max(0, spec.capIsk - held));
      const capped = fundedIsk < spec.isk;
      if (fundedIsk === 0) return { ok: true, fundedIsk, capped, budget: row ? toBudget(row) : null };
      if (!row) {
        s.insert.run(toBind(spec.factionId), toBind(fundedIsk), toBind(0), toBind(fundedIsk), toBind(spec.at),
          toBind(spec.at), toBind(spec.at));
      } else {
        const u = updateWithVersion(db, BUDGETS_TABLE, spec.factionId, row.version, {
          isk_available: row.isk_available + fundedIsk,
          funded_total: saturate(row.funded_total + fundedIsk),
          last_funded_at: spec.at, updated_at: spec.at });
        if (!u.ok) return u;
      }
      return { ok: true, fundedIsk, capped, budget: toBudget(s.byId.get(toBind(spec.factionId))) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(toBind(spec.factionId));
      return { ok: true, duplicate: true, fundedIsk: 0, capped: false, budget: row ? toBudget(row) : null };
    }
    if (r.value.fundedIsk > 0) changes += 1;
    return { ok: true, duplicate: false, fundedIsk: r.value.fundedIsk, capped: r.value.capped, budget: r.value.budget };
  }

  const proceedsCache = new WeakMap();
  function insertProceedsStmt(db) {
    let s = proceedsCache.get(db);
    if (!s) {
      s = db.prepare(`INSERT INTO world_trade_budgets (faction_id, isk_available, isk_reserved, funded_units_total,
        funded_total, spent_total, released_total, last_funded_at, created_at, updated_at, version, wts_proceeds_total)
        VALUES (?, ?, 0, 0, 0, 0, 0, NULL, ?, ?, 1, ?)`);
      proceedsCache.set(db, s);
    }
    return s;
  }

  function creditProceedsInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.factionId) || !isIsk(spec.isk) || spec.isk < 1 || !isIsk(spec.capIsk)
      || !isTime(spec.at)) {
      return invalid("spec");
    }
    if (typeof key !== "string" || key === "") return invalid("key");
    const payload = { factionId: spec.factionId, isk: spec.isk };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.BUDGET_AGGREGATE, id: String(spec.factionId) },
      eventType: S.EVENT_BUDGET_WTS_PROCEEDS, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.factionId));
      const held = row ? row.isk_available + row.isk_reserved : 0;
      const creditedIsk = Math.min(spec.isk, Math.max(0, spec.capIsk - held));
      const overflowIsk = spec.isk - creditedIsk;
      if (!row) {
        insertProceedsStmt(db).run(toBind(spec.factionId), toBind(creditedIsk), toBind(spec.at), toBind(spec.at),
          toBind(creditedIsk));
      } else if (creditedIsk > 0) {
        const u = updateWithVersion(db, BUDGETS_TABLE, spec.factionId, row.version, {
          isk_available: row.isk_available + creditedIsk,
          wts_proceeds_total: saturate((row.wts_proceeds_total || 0) + creditedIsk),
          updated_at: spec.at });
        if (!u.ok) return u;
      }
      return { ok: true, creditedIsk, overflowIsk, written: !row || creditedIsk > 0,
        budget: toBudget(s.byId.get(toBind(spec.factionId))) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(toBind(spec.factionId));
      return { ok: true, duplicate: true, creditedIsk: 0, overflowIsk: 0, budget: row ? toBudget(row) : null };
    }
    if (r.value.written) changes += 1;
    return { ok: true, duplicate: false, creditedIsk: r.value.creditedIsk, overflowIsk: r.value.overflowIsk,
      budget: r.value.budget };
  }

  function recordProceedsSplitInDb(tx, factionId, split, at) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!split || !isIsk(split.treasuryIsk) || !isIsk(split.burnedIsk)) return invalid("split");
    if (!isTime(at)) return invalid("at");
    const s = stmts(tx);
    const row = s.byId.get(toBind(factionId));
    if (split.treasuryIsk === 0 && split.burnedIsk === 0) return { ok: true, budget: row ? toBudget(row) : null };
    if (!row) return { ok: false, reason: "NO_BUDGET", detail: String(factionId) };
    const u = updateWithVersion(tx, BUDGETS_TABLE, factionId, row.version, {
      wts_treasury_total: saturate((row.wts_treasury_total || 0) + split.treasuryIsk),
      wts_burned_total: saturate((row.wts_burned_total || 0) + split.burnedIsk),
      updated_at: at });
    if (!u.ok) return u;
    changes += 1;
    return { ok: true, budget: toBudget(s.byId.get(toBind(factionId))) };
  }

  function adjustInDb(tx, factionId, deltas, at) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!deltas || (deltas.availableDelta !== undefined && !isDelta(deltas.availableDelta)) || (deltas.reservedDelta !== undefined && !isDelta(deltas.reservedDelta))
      || (deltas.spentTotal !== undefined && !isIsk(deltas.spentTotal))
      || (deltas.releasedTotal !== undefined && !isIsk(deltas.releasedTotal))) {
      return invalid("deltas");
    }
    if (!isTime(at)) return invalid("at");
    const s = stmts(tx);
    const row = s.byId.get(toBind(factionId));
    if (!row) return { ok: false, reason: "NO_BUDGET", detail: String(factionId) };
    const available = row.isk_available + (deltas.availableDelta || 0);
    const reserved = row.isk_reserved + (deltas.reservedDelta || 0);
    if (available < 0 || reserved < 0) return { ok: false, reason: "BUDGET_NEGATIVE", detail: String(factionId) };
    if (available > S.MAX_ISK || reserved > S.MAX_ISK) return invalid("deltas: above MAX_ISK");
    const u = updateWithVersion(tx, BUDGETS_TABLE, factionId, row.version, {
      isk_available: available, isk_reserved: reserved,
      spent_total: saturate(row.spent_total + (deltas.spentTotal || 0)),
      released_total: saturate(row.released_total + (deltas.releasedTotal || 0)), updated_at: at });
    if (!u.ok) return u;
    changes += 1;
    return { ok: true, budget: toBudget(s.byId.get(toBind(factionId))) };
  }

  return Object.freeze({
    getBudget,
    listBudgets,
    fundInTx,
    fundIskInTx,
    creditProceedsInTx,
    recordProceedsSplitInDb,
    adjustInDb,
    getChangeCount: () => changes,
  });
}

module.exports = { createBudgetRepository, toBudget, BUDGETS_TABLE };
