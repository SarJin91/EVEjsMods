"use strict";

const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");
const S = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const TREASURY_TABLE = defineTable({ name: S.TREASURY_TABLE_NAME, idColumn: "faction_id", columns: ["isk_balance",
  "mode", "paid_until", "mode_changed_at", "income_total", "fleet_upkeep_total", "production_fee_total", "loss_total",
  "loss_value_total", "ships_lost_total", "trade_out_total", "trade_in_total", "unpaid_total", "updated_at",
  "merc_fee_total", "merc_refund_total",
  "admin_total", "war_spend_total"] });
const DEBIT_ORDER = Object.freeze(["fleetUpkeep", "admin", "productionFees", "lossFit", "warSpend", "tradeOut",
  "mercFees"]);
const CREDIT_KEYS = Object.freeze(["income", "tradeIn", "mercRefunds"]);
const UNSATURATED_DEBITS = Object.freeze(["tradeOut", "mercFees"]);
const STAT_KEYS = Object.freeze(["lossValue", "shipsLost"]);
const MAX_MODE_LENGTH = 16;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isIsk = (v) => Number.isSafeInteger(v) && v >= 0 && v <= S.MAX_ISK;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_MODE_LENGTH;
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "TREASURY_INVALID_INPUT", detail });
const saturate = (v) => Math.min(S.MAX_ISK, v);
const isLimit = (v, max) => Number.isSafeInteger(v) && v >= 1 && v <= max;
const zeroPaid = () => ({ fleetUpkeep: 0, admin: 0, productionFees: 0, lossFit: 0, warSpend: 0, tradeOut: 0,
  mercFees: 0 });

function applyDebits(balance, credits, debits) {
  const c = credits || {};
  const d = debits || {};
  let b = saturate(balance + (c.income || 0) + (c.tradeIn || 0) + (c.mercRefunds || 0));
  const paid = zeroPaid();
  let unpaid = 0;
  for (const k of DEBIT_ORDER) {
    const want = d[k] || 0;
    if (UNSATURATED_DEBITS.includes(k) && want > b) return invalid(`${k} above the balance`);
    const got = Math.min(b, want);
    paid[k] = got;
    unpaid += want - got;
    b -= got;
  }
  return { ok: true, balance: b, paid, unpaid };
}

function toTreasury(row) {
  return Object.freeze({ factionId: row.faction_id, kind: row.kind, initialIsk: row.initial_isk,
    balanceIsk: row.isk_balance, mode: row.mode, paidUntil: row.paid_until, modeChangedAt: row.mode_changed_at,
    totals: Object.freeze({ income: row.income_total, fleetUpkeep: row.fleet_upkeep_total,
      productionFees: row.production_fee_total, losses: row.loss_total, lossValue: row.loss_value_total,
      shipsLost: row.ships_lost_total, tradeOut: row.trade_out_total, tradeIn: row.trade_in_total,
      unpaid: row.unpaid_total, mercFees: row.merc_fee_total, mercRefunds: row.merc_refund_total,
      admin: row.admin_total, warSpend: row.war_spend_total }),
    createdAt: row.created_at, updatedAt: row.updated_at, version: row.version });
}

function toDay(row) {
  return Object.freeze({ day: row.day, income: row.income, fleetUpkeep: row.fleet_upkeep,
    productionFees: row.production_fees, losses: row.losses, lossValue: row.loss_value, shipsLost: row.ships_lost,
    tradeOut: row.trade_out, tradeIn: row.trade_in, unpaid: row.unpaid, balanceEnd: row.balance_end,
    updatedAt: row.updated_at, mercFees: row.merc_fees, mercRefunds: row.merc_refunds, admin: row.admin,
    warSpend: row.war_spend });
}

function pick(group, keys) {
  if (group === undefined) return {};
  if (!group || typeof group !== "object" || Array.isArray(group)) return null;
  const out = {};
  for (const k of Object.keys(group)) {
    if (!keys.includes(k)) return null;
    if (group[k] === undefined) continue;
    if (!isIsk(group[k])) return null;
    out[k] = group[k];
  }
  return out;
}

function createTreasuryRepository(deps) {
  const { journal, clock } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("treasuryRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("treasuryRepository: clock");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      byId: db.prepare("SELECT * FROM world_faction_treasury WHERE faction_id = ?"),
      list: db.prepare("SELECT * FROM world_faction_treasury ORDER BY faction_id LIMIT ?"),
      insert: db.prepare(`INSERT INTO world_faction_treasury (faction_id, kind, initial_isk, isk_balance, mode,
        paid_until, mode_changed_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)`),
      days: db.prepare(`SELECT * FROM world_faction_treasury_days WHERE faction_id = ? ORDER BY day DESC LIMIT ?`),
      sumTradeOut: db.prepare("SELECT COALESCE(SUM(trade_out), 0) AS isk FROM world_faction_treasury_days WHERE day = ?"),
      upsertDay: db.prepare(`INSERT INTO world_faction_treasury_days (faction_id, day, income, fleet_upkeep,
        production_fees, losses, loss_value, ships_lost, trade_out, trade_in, unpaid, balance_end, updated_at,
        merc_fees, merc_refunds, admin, war_spend)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(faction_id, day) DO UPDATE SET
          income = min(income + excluded.income, 1000000000000000),
          fleet_upkeep = min(fleet_upkeep + excluded.fleet_upkeep, 1000000000000000),
          production_fees = min(production_fees + excluded.production_fees, 1000000000000000),
          losses = min(losses + excluded.losses, 1000000000000000),
          loss_value = min(loss_value + excluded.loss_value, 1000000000000000),
          ships_lost = min(ships_lost + excluded.ships_lost, 1000000000000000),
          trade_out = min(trade_out + excluded.trade_out, 1000000000000000),
          trade_in = min(trade_in + excluded.trade_in, 1000000000000000),
          unpaid = min(unpaid + excluded.unpaid, 1000000000000000),
          merc_fees = min(merc_fees + excluded.merc_fees, 1000000000000000),
          merc_refunds = min(merc_refunds + excluded.merc_refunds, 1000000000000000),
          admin = min(admin + excluded.admin, 1000000000000000),
          war_spend = min(war_spend + excluded.war_spend, 1000000000000000),
          balance_end = excluded.balance_end,
          updated_at = excluded.updated_at`),
      prune: db.prepare(`DELETE FROM world_faction_treasury_days WHERE rowid IN (SELECT rowid
        FROM world_faction_treasury_days WHERE day < ? ORDER BY day, faction_id LIMIT ?)`),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function getInDb(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    const row = stmts(tx).byId.get(toBind(factionId));
    return { ok: true, treasury: row ? toTreasury(row) : null };
  }

  function listInDb(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = opts && opts.limit;
    if (!isLimit(limit, Number.MAX_SAFE_INTEGER)) return invalid("limit");
    return { ok: true, rows: stmts(tx).list.all(toBind(limit)).map(toTreasury) };
  }

  function daysInDb(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    const limit = opts && opts.limit;
    if (!isLimit(limit, S.MAX_DAYS_READ)) return invalid("limit");
    return { ok: true, days: stmts(tx).days.all(toBind(factionId), toBind(limit)).map(toDay) };
  }

  function galaxyDaySumInDb(tx, day, column) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(day)) return invalid("day");
    if (!S.DAY_SUM_COLUMNS.includes(column)) return invalid("column");
    const row = stmts(tx).sumTradeOut.get(toBind(day));
    return { ok: true, isk: Number(row.isk) };
  }

  function seedInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.factionId) || !isText(spec.kind) || !isIsk(spec.initialIsk) || !isTime(spec.at)) {
      return invalid("spec");
    }
    if (typeof key !== "string" || key === "") return invalid("key");
    const payload = { factionId: spec.factionId, kind: spec.kind, initialIsk: spec.initialIsk };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: String(spec.factionId) },
      eventType: S.EVENT_SEEDED, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.factionId));
      if (row) return { ok: true, treasury: toTreasury(row), written: false };
      s.insert.run(toBind(spec.factionId), spec.kind, toBind(spec.initialIsk), toBind(spec.initialIsk), S.MODE_NORMAL,
        toBind(spec.at), toBind(spec.at));
      return { ok: true, treasury: toTreasury(s.byId.get(toBind(spec.factionId))), written: true };
    });
    if (!r.ok) return unwrap(r);
    const row = stmts(tx).byId.get(toBind(spec.factionId));
    if (r.duplicate) {
      if (!row) return { ok: false, reason: "NO_TREASURY", detail: String(spec.factionId) };
      return { ok: true, duplicate: true, treasury: toTreasury(row) };
    }
    if (r.value.written) changes += 1;
    return { ok: true, duplicate: false, treasury: r.value.treasury };
  }

  function settleInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !isId(spec.factionId) || !isTime(spec.day) || !isTime(spec.at)) return invalid("spec");
    if (typeof key !== "string" || key === "") return invalid("key");
    const credits = pick(spec.credits, CREDIT_KEYS);
    const debits = pick(spec.debits, DEBIT_ORDER);
    const stats = pick(spec.stats, STAT_KEYS);
    if (!credits || !debits || !stats) return invalid("credits/debits/stats");
    const patch = spec.patch === undefined ? {} : spec.patch;
    if (!patch || typeof patch !== "object" || Array.isArray(patch)
      || Object.keys(patch).some((k) => k !== "paidUntil" && k !== "mode")
      || (patch.paidUntil !== undefined && !isTime(patch.paidUntil))
      || (patch.mode !== undefined && !isText(patch.mode))) {
      return invalid("patch");
    }
    const payload = { factionId: spec.factionId, credits, debits, stats,
      patch: Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: String(spec.factionId) },
      eventType: S.EVENT_SETTLED, payload }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.factionId));
      if (!row) return { ok: false, reason: "NO_TREASURY", detail: String(spec.factionId) };
      const income = credits.income || 0;
      const tradeIn = credits.tradeIn || 0;
      const mercRefunds = credits.mercRefunds || 0;
      const settled = applyDebits(row.isk_balance, credits, debits);
      if (!settled.ok) return settled;
      const { balance, paid, unpaid } = settled;
      const lossValue = stats.lossValue || 0;
      const shipsLost = stats.shipsLost || 0;
      const modeChange = patch.mode !== undefined && patch.mode !== row.mode;
      const u = updateWithVersion(db, TREASURY_TABLE, spec.factionId, row.version, {
        isk_balance: balance,
        income_total: saturate(row.income_total + income),
        trade_in_total: saturate(row.trade_in_total + tradeIn),
        fleet_upkeep_total: saturate(row.fleet_upkeep_total + paid.fleetUpkeep),
        production_fee_total: saturate(row.production_fee_total + paid.productionFees),
        loss_total: saturate(row.loss_total + paid.lossFit),
        loss_value_total: saturate(row.loss_value_total + lossValue),
        ships_lost_total: saturate(row.ships_lost_total + shipsLost),
        trade_out_total: saturate(row.trade_out_total + paid.tradeOut),
        unpaid_total: saturate(row.unpaid_total + unpaid),
        merc_fee_total: saturate(row.merc_fee_total + paid.mercFees),
        merc_refund_total: saturate(row.merc_refund_total + mercRefunds),
        ...(paid.admin > 0 ? { admin_total: saturate(row.admin_total + paid.admin) } : {}),
        ...(paid.warSpend > 0 ? { war_spend_total: saturate(row.war_spend_total + paid.warSpend) } : {}),
        ...(patch.paidUntil !== undefined ? { paid_until: patch.paidUntil } : {}),
        ...(modeChange ? { mode: patch.mode, mode_changed_at: spec.at } : {}),
        updated_at: spec.at });
      if (!u.ok) return u;
      s.upsertDay.run(toBind(spec.factionId), toBind(spec.day), toBind(income), toBind(paid.fleetUpkeep),
        toBind(paid.productionFees), toBind(paid.lossFit), toBind(lossValue), toBind(shipsLost), toBind(paid.tradeOut),
        toBind(tradeIn), toBind(unpaid), toBind(balance), toBind(spec.at), toBind(paid.mercFees), toBind(mercRefunds),
        toBind(paid.admin), toBind(paid.warSpend));
      return { ok: true, treasury: toTreasury(s.byId.get(toBind(spec.factionId))), paid, unpaid };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(toBind(spec.factionId));
      if (!row) return { ok: false, reason: "NO_TREASURY", detail: String(spec.factionId) };
      return { ok: true, duplicate: true, treasury: toTreasury(row), paid: zeroPaid(), unpaid: 0 };
    }
    changes += 1;
    return { ok: true, duplicate: false, treasury: r.value.treasury, paid: r.value.paid, unpaid: r.value.unpaid };
  }

  function pruneDaysInDb(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !isTime(opts.beforeDay) || !isLimit(opts.limit, Number.MAX_SAFE_INTEGER)) return invalid("opts");
    const info = stmts(tx).prune.run(toBind(opts.beforeDay), toBind(opts.limit));
    if (info.changes > 0) changes += 1;
    return { ok: true, deleted: Number(info.changes) };
  }

  return Object.freeze({
    getInDb,
    listInDb,
    daysInDb,
    galaxyDaySumInDb,
    seedInTx,
    settleInTx,
    pruneDaysInDb,
    getChangeCount: () => changes,
  });
}

module.exports = { createTreasuryRepository, applyDebits, toTreasury, toDay, TREASURY_TABLE };
