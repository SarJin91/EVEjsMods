"use strict";

const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");
const S = require("./schema");
const { isValidTransition, nextStateSeq, edgeBudget, patchFields } = require("./offerMachine");
const { marketSpendIsk } = require("./marketRules");

const PURPOSE_STOCKPILE = "stockpile";
const PURPOSES = Object.freeze(["mobilization", PURPOSE_STOCKPILE, "hull"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const INVALID_TRANSITION = Object.freeze({ ok: false, reason: "INVALID_TRANSITION" });
const VERSION_CONFLICT = Object.freeze({ ok: false, reason: "VERSION_CONFLICT" });
const NOT_FOUND = Object.freeze({ ok: false, reason: "NOT_FOUND" });
const BUDGET_NEGATIVE = Object.freeze({ ok: false, reason: "BUDGET_NEGATIVE" });
const TRADE_INVALID_INPUT = Object.freeze({ ok: false, reason: "TRADE_INVALID_INPUT" });
const IDEMPOTENCY_CONFLICT = Object.freeze({ ok: false, reason: "IDEMPOTENCY_CONFLICT" });
const OFFER_EXISTS = Object.freeze({ ok: false, reason: "OFFER_EXISTS" });
const BUDGET_SHORT = Object.freeze({ ok: false, reason: "BUDGET_SHORT" });
const NO_BUDGET = Object.freeze({ ok: false, reason: "NO_BUDGET" });
const CONTRACT_ID_TAKEN = Object.freeze({ ok: false, reason: "CONTRACT_ID_TAKEN" });
const MARKET_ORDER_TAKEN = Object.freeze({ ok: false, reason: "MARKET_ORDER_TAKEN" });
const INVALID_STATE = Object.freeze({ ok: false, reason: "INVALID_STATE" });
const STATIONS_NOT_READY = Object.freeze({ ok: false, reason: "STATIONS_NOT_READY" });
const STATION_NOT_OWNED = Object.freeze({ ok: false, reason: "STATION_NOT_OWNED" });
const SELL_STOCK_OUT_MISSING = Object.freeze({ ok: false, reason: "SELL_STOCK_OUT_MISSING" });

const OFFERS_TABLE = defineTable({
  name: S.OFFERS_TABLE_NAME,
  idColumn: "offer_id",
  columns: [
    "faction_id", "station_id", "system_id", "issuer_corporation_id",
    "item_kind", "item_key", "type_id", "quantity", "unit_price_milli",
    "isk_total", "ref_price_milli", "cap_price_milli", "price_source",
    "state", "state_seq", "end_reason", "contract_id", "acceptor_character_id",
    "assignee_character_id", "standing_bonus_permille",
    "delivered_quantity", "created_at", "expires_at", "updated_at", "ended_at",
    "issuer_character_id", "issuer_character_corp_id",
    "channel", "market_order_id", "filled_quantity",
    "side",
  ],
});

const PATCH_COLUMNS = Object.freeze({
  expiresAt: "expires_at",
  contractId: "contract_id",
  acceptorCharacterId: "acceptor_character_id",
  deliveredQuantity: "delivered_quantity",
  issuerCharacterId: "issuer_character_id",
  issuerCharacterCorpId: "issuer_character_corp_id",
  marketOrderId: "market_order_id",
  filledQuantity: "filled_quantity",
});
const MAX_ISSUER_CHARACTER_IDS = 64;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isStationId = (v) => typeof v === "string" && v.length > 0 && v.length <= 64;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isIsk = (v) => Number.isSafeInteger(v) && v >= 0 && v <= S.MAX_ISK;
const isPosIsk = (v) => Number.isSafeInteger(v) && v >= 1 && v <= S.MAX_ISK;
const isQuantity = (v) => Number.isSafeInteger(v) && v >= 1 && v <= 1e9;
const isUnitPrice = (v) => Number.isSafeInteger(v) && v >= 1 && v <= S.MAX_UNIT_PRICE_MILLI;
const isState = (v) => typeof v === "string" && S.OFFER_STATES.includes(v);
const isEndReason = (v) => v === null || v === undefined || (typeof v === "string" && v.length > 0 && v.length <= 32);
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "TRADE_INVALID_INPUT", detail });
const toPositiveInteger = (value, fallback = 0) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
};

function toOffer(row) {
  return Object.freeze({
    offerId: row.offer_id,
    factionId: row.faction_id,
    stationId: row.station_id,
    systemId: row.system_id,
    issuerCorporationId: row.issuer_corporation_id,
    itemKind: row.item_kind,
    itemKey: row.item_key,
    typeId: row.type_id,
    quantity: row.quantity,
    unitPriceMilli: row.unit_price_milli,
    iskTotal: row.isk_total,
    refPriceMilli: row.ref_price_milli,
    capPriceMilli: row.cap_price_milli,
    priceSource: row.price_source,
    state: row.state,
    stateSeq: row.state_seq,
    endReason: row.end_reason,
    contractId: row.contract_id,
    acceptorCharacterId: row.acceptor_character_id,
    assigneeCharacterId: row.assignee_character_id,
    standingBonusPermille: row.standing_bonus_permille,
    deliveredQuantity: row.delivered_quantity,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    endedAt: row.ended_at,
    version: row.version,
    issuerCharacterId: row.issuer_character_id ?? null,
    issuerCharacterCorpId: row.issuer_character_corp_id ?? null,
    channel: row.channel || "contract",
    marketOrderId: row.market_order_id ?? null,
    filledQuantity: row.filled_quantity ?? 0,
    side: row.side === S.SIDE_SELL ? S.SIDE_SELL : S.SIDE_BUY,
  });
}

function createOfferRepository(deps) {
  const { journal, budgets, ids, clock } = deps || {};
  const catalog = deps && deps.catalog && typeof deps.catalog.offerable === "function" ? deps.catalog : null;
  const getStockRepository = deps && typeof deps.getStockRepository === "function" ? deps.getStockRepository : null;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("offerRepository: journal");
  if (!budgets || typeof budgets.adjustInDb !== "function") throw new TypeError("offerRepository: budgets");
  if (!ids || typeof ids.next !== "function") throw new TypeError("offerRepository: ids");
  if (!clock || typeof clock.now !== "function") throw new TypeError("offerRepository: clock");

  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      openByStationItem: db.prepare(
        "SELECT 1 FROM world_trade_offers WHERE station_id = ? AND item_kind = ? AND item_key = ? " +
        "AND state IN ('PLANNED', 'ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE') LIMIT 1"
      ),
      byId: db.prepare("SELECT * FROM world_trade_offers WHERE offer_id = ?"),
      listOpen: db.prepare(
        "SELECT * FROM world_trade_offers WHERE faction_id = ? AND state IN ('PLANNED', 'ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE') ORDER BY offer_id LIMIT ?"
      ),
      listRecent: db.prepare(
        "SELECT * FROM world_trade_offers WHERE faction_id = ? AND ended_at IS NOT NULL AND ended_at >= ? ORDER BY ended_at DESC LIMIT ?"
      ),
      sumReserved: db.prepare(
        "SELECT COALESCE(SUM(isk_total), 0) AS total FROM world_trade_offers WHERE faction_id = ? AND state IN ('PLANNED', 'ISSUING', 'OPEN') AND side = 'buy'"
      ),
      sumOpenReserved: db.prepare(
        "SELECT COALESCE(SUM(isk_total), 0) AS total FROM world_trade_offers WHERE faction_id = ? AND state IN ('PLANNED', 'ISSUING', 'OPEN') AND side = 'buy'"
      ),
      listByStates: db.prepare(
        "SELECT * FROM world_trade_offers WHERE faction_id = ? AND state IN (SELECT value FROM json_each(?)) AND offer_id > ? ORDER BY offer_id LIMIT ?"
      ),
      byContractId: db.prepare("SELECT * FROM world_trade_offers WHERE contract_id = ?"),
      countOpenAll: db.prepare(
        "SELECT COUNT(*) AS open_count, COALESCE(SUM(CASE WHEN state = 'OPEN' THEN 1 ELSE 0 END), 0) AS listed_count "
        + "FROM world_trade_offers WHERE state IN ('PLANNED', 'ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE')"
      ),
      issuerCharacterIds: db.prepare(
        "SELECT DISTINCT issuer_character_id AS id FROM world_trade_offers WHERE issuer_character_id IS NOT NULL "
        + "ORDER BY issuer_character_id LIMIT ?"
      ),
      issuerCorporationIds: db.prepare(
        "SELECT DISTINCT issuer_corporation_id AS id FROM world_trade_offers WHERE issuer_character_id IS NULL "
        + "ORDER BY issuer_corporation_id LIMIT ?"
      ),
      countOpenByIssuer: db.prepare(
        "SELECT issuer_character_id AS characterId, COUNT(*) AS cnt FROM world_trade_offers " +
        "WHERE faction_id = ? AND issuer_character_id IS NOT NULL " +
        "AND state IN ('PLANNED', 'ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE') " +
        "GROUP BY issuer_character_id"
      ),
      listSuppliers: db.prepare(
        `SELECT acceptor_character_id AS characterId, COUNT(*) AS deliveries, MAX(updated_at) AS lastAt
         FROM world_trade_offers
         WHERE faction_id = ? AND acceptor_character_id IS NOT NULL AND updated_at >= ? AND side = 'buy'
         GROUP BY acceptor_character_id
         ORDER BY lastAt DESC, characterId ASC
         LIMIT ?`
      ),
      lastRejectedAt: db.prepare(
        `SELECT MAX(ended_at) AS at FROM world_trade_offers
         WHERE faction_id = ? AND assignee_character_id = ? AND end_reason = 'REJECTED' AND ended_at >= ?`
      ),
      insert: db.prepare(
        `INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, issuer_corporation_id,
          item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli,
          cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id,
          assignee_character_id, standing_bonus_permille,
          delivered_quantity, created_at, expires_at, updated_at, ended_at, version,
          channel, market_order_id, filled_quantity, side)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?, ?, ?)`
      ),
    };
    cache.set(db, s);
    return s;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function channelRefusal(row, spec) {
    const patch = spec.patch || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(patch, k) && patch[k] !== undefined && patch[k] !== null;
    if (has("channel")) {
      if (patch.channel !== S.CHANNEL_CONTRACT && patch.channel !== S.CHANNEL_MARKET) return invalid("channel");
      const commodity = row.item_kind === S.ITEM_KIND_MOON || row.item_kind === S.ITEM_KIND_PI;
      const kindOk = row.side === S.SIDE_SELL
        ? spec.allowSellMarket === true && (row.item_kind === S.ITEM_KIND_MINERAL || commodity)
        : row.item_kind === S.ITEM_KIND_MINERAL
          || (row.item_kind === S.ITEM_KIND_HULL && spec.allowHullMarket === true)
          || (commodity && spec.allowCommodityMarket === true);
      if (patch.channel === S.CHANNEL_MARKET && (!kindOk
        || row.assignee_character_id !== null || has("issuerCharacterId") || row.issuer_character_id !== null)) {
        return invalid("channel:market");
      }
    }
    const channel = has("channel") ? patch.channel : (row.channel || S.CHANNEL_CONTRACT);
    const market = channel === S.CHANNEL_MARKET;
    if (market && has("contractId")) return invalid("market:contractId");
    if (!market && has("marketOrderId")) return invalid("contract:marketOrderId");
    if (has("marketOrderId") && (typeof patch.marketOrderId !== "string" || patch.marketOrderId.length < 1
      || patch.marketOrderId.length > 24)) return invalid("marketOrderId");
    if (spec.from === S.ISSUING && spec.to === S.OPEN && market && !has("marketOrderId")) return invalid("market:marketOrderId");
    if (has("filledQuantity")) {
      if (!market) return invalid("contract:filledQuantity");
      if (!Number.isSafeInteger(patch.filledQuantity) || patch.filledQuantity < 1 || patch.filledQuantity > row.quantity) {
        return invalid("filledQuantity");
      }
    }
    if (spec.from === S.OPEN && spec.to === S.ACCEPTED && market && !has("filledQuantity")) return invalid("market:filledQuantity");
    return null;
  }

  function stockRepository() {
    if (!getStockRepository) return null;
    let repo = null;
    try { repo = getStockRepository(); } catch (_err) { repo = null; }
    return repo && typeof repo.getStation === "function" && typeof repo.applyStockChange === "function"
      && typeof repo.getStock === "function" ? repo : null;
  }

  const stockKindOf = (itemKind) => (itemKind === S.ITEM_KIND_HULL || itemKind === S.ITEM_KIND_MOON
    || itemKind === S.ITEM_KIND_PI ? itemKind : S.ITEM_KIND_MINERAL);

  function stockOutInDb(db, repo, spec, offerId) {
    const g = repo.getStation(db, spec.stationId);
    if (!g.ok) return g;
    const rec = g.record;
    if (!rec || rec.ownerFactionId !== spec.factionId || rec.state === S.STATION_STATE_DESTROYED) {
      return STATION_NOT_OWNED;
    }
    if (rec.state !== S.STATION_STATE_ONLINE) return { ok: false, reason: "STATION_NOT_ONLINE", state: rec.state };
    const key = S.stockOutKey(offerId);
    const out = repo.applyStockChange(db, { stationId: spec.stationId, key, reason: S.STOCK_REASON_SELL_OUT,
      at: spec.at, deltas: [{ itemKind: stockKindOf(spec.itemKind), itemKey: spec.itemKey, delta: -spec.quantity }] });
    if (!out.ok) return out;
    if (out.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    return { ok: true };
  }

  function stockBackInDb(db, row, spec, explicitQuantity) {
    const repo = stockRepository();
    if (!repo) return STATIONS_NOT_READY;
    const gate = journal.findByKey(db, S.stockOutKey(row.offer_id));
    if (!gate || gate.ok !== true) return gate || SELL_STOCK_OUT_MISSING;
    if (!gate.found) return SELL_STOCK_OUT_MISSING;
    let quantity = row.quantity;
    if (explicitQuantity !== undefined) {
      quantity = explicitQuantity;
    } else if (row.state === S.INTAKE) {
      const d = spec.patch ? spec.patch.deliveredQuantity : undefined;
      if (!Number.isSafeInteger(d) || d < 1 || d > row.quantity) return invalid("patch:deliveredQuantity");
      quantity = d;
    }
    const lostAll = { ok: true, stockBack: { credited: 0, lost: quantity } };
    const g = repo.getStation(db, row.station_id);
    if (!g.ok) return g;
    const rec = g.record;
    if (!rec || rec.state === S.STATION_STATE_DESTROYED || rec.ownerFactionId !== row.faction_id) return lostAll;
    const itemKind = stockKindOf(row.item_kind);
    const key = S.stockBackKey(row.offer_id);
    const credit = (n) => repo.applyStockChange(db, { stationId: row.station_id, key, reason: S.STOCK_REASON_SELL_BACK,
      at: spec.at, deltas: [{ itemKind, itemKey: row.item_key, delta: n }] });
    const done = (r, n) => {
      if (!r.ok) return r;
      if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
      return { ok: true, stockBack: { credited: n, lost: quantity - n } };
    };
    const first = credit(quantity);
    if (first.ok) return done(first, quantity);
    if (first.reason === "STATION_DESTROYED" || first.reason === "ROW_NOT_FOUND") return lostAll;
    if (first.reason !== "STOCK_CAP" && first.reason !== "STOCK_ITEMS_LIMIT") return first;
    const stock = repo.getStock(db, row.station_id);
    if (!stock.ok) return stock;
    const item = stock.items.find((x) => x.itemKind === itemKind && x.itemKey === row.item_key);
    const free = first.reason === "STOCK_CAP" && item && Number.isSafeInteger(first.limit)
      ? Math.max(0, first.limit - item.quantity) : 0;
    const n = Math.min(quantity, free);
    if (n <= 0) return lostAll;
    return done(credit(n), n);
  }

  function createOfferInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const side = spec && spec.side !== undefined ? spec.side : S.SIDE_BUY;
    if (!S.SIDES.includes(side)) return invalid("side");
    const sell = side === S.SIDE_SELL;
    if (!spec || !isId(spec.factionId) || !isStationId(spec.stationId) || !isId(spec.systemId)
      || !isId(spec.issuerCorporationId)
      || (spec.itemKind !== S.ITEM_KIND_MINERAL && spec.itemKind !== S.ITEM_KIND_ORE
        && spec.itemKind !== S.ITEM_KIND_HULL && spec.itemKind !== S.ITEM_KIND_MOON
        && spec.itemKind !== S.ITEM_KIND_PI)
      || !spec.itemKey || typeof spec.itemKey !== "string"
      || !isId(spec.typeId) || !isQuantity(spec.quantity) || !isUnitPrice(spec.unitPriceMilli)
      || !isPosIsk(spec.iskTotal) || !isPosIsk(spec.refPriceMilli)
      || !(spec.capPriceMilli === null || isPosIsk(spec.capPriceMilli))
      || !(sell ? S.SELL_PRICE_SOURCES : S.PRICE_SOURCES).includes(spec.priceSource)
      || !isTime(spec.expiresAt) || !isTime(spec.at)) {
      return invalid("spec");
    }
    if (sell) {
      if (spec.itemKind === S.ITEM_KIND_ORE) return invalid("sell:itemKind");
      if (spec.capPriceMilli !== null) return invalid("sell:capPriceMilli");
      if ((spec.assigneeCharacterId !== undefined && spec.assigneeCharacterId !== null)
        || (spec.standingBonusPermille !== undefined && spec.standingBonusPermille !== 0)) return invalid("sell:private");
      if ((spec.channel || S.CHANNEL_CONTRACT) !== S.CHANNEL_CONTRACT) return invalid("sell:channel");
      if (spec.purpose !== undefined) return invalid("sell:purpose");
    }
    if (spec.itemKind === S.ITEM_KIND_ORE) {
      const entry = catalog && catalog.offerable(S.ITEM_KIND_ORE, spec.itemKey, spec.typeId)
        ? catalog.get(spec.itemKey) : null;
      if (!entry || spec.quantity % entry.portionSize !== 0
        || (spec.channel || S.CHANNEL_CONTRACT) !== S.CHANNEL_CONTRACT) return invalid("ore");
    }
    if (spec.itemKind === S.ITEM_KIND_HULL) {
      if (!catalog || catalog.offerable(S.ITEM_KIND_HULL, spec.itemKey, spec.typeId) !== true
        || (spec.channel || S.CHANNEL_CONTRACT) !== S.CHANNEL_CONTRACT
        || (spec.assigneeCharacterId !== undefined && spec.assigneeCharacterId !== null)) return invalid("hull");
    }
    if (spec.itemKind === S.ITEM_KIND_MOON || spec.itemKind === S.ITEM_KIND_PI) {
      if (!catalog || catalog.offerable(spec.itemKind, spec.itemKey, spec.typeId) !== true
        || (spec.channel || S.CHANNEL_CONTRACT) !== S.CHANNEL_CONTRACT
        || (spec.assigneeCharacterId !== undefined && spec.assigneeCharacterId !== null)) return invalid("commodity");
    }
    if (spec.assigneeCharacterId !== undefined && spec.assigneeCharacterId !== null &&
      (!Number.isSafeInteger(spec.assigneeCharacterId) || spec.assigneeCharacterId <= 0)) {
      return invalid("assigneeCharacterId");
    }
    const bonus = spec.standingBonusPermille === undefined ? 0 : spec.standingBonusPermille;
    if (!Number.isInteger(bonus) || bonus < 0 || bonus > S.MAX_BONUS_PERMILLE) {
      return invalid("standingBonusPermille");
    }
    if ((spec.assigneeCharacterId === undefined || spec.assigneeCharacterId === null) && bonus > 0) {
      return invalid("assignee_null_bonus_positive");
    }
    if (spec.purpose !== undefined && !PURPOSES.includes(spec.purpose)) return invalid("purpose");
    if (typeof key !== "string" || key === "") return invalid("key");

    const existingJournal = journal.findByKey && typeof journal.findByKey === "function"
      ? journal.findByKey(tx, key)
      : null;
    if (existingJournal && existingJournal.found) {
      const originalOfferId = existingJournal.entry.aggregateId;
      const existing = originalOfferId ? stmts(tx).byId.get(toBind(originalOfferId)) : null;
      return { ok: true, duplicate: true, offer: existing ? toOffer(existing) : null };
    }

    const stockRepo = sell ? stockRepository() : null;
    if (sell && !stockRepo) return STATIONS_NOT_READY;

    let offerId;
    if (sell) offerId = ids.next("ts");
    else offerId = spec.purpose === PURPOSE_STOCKPILE ? ids.next("tp") : ids.next("to");
    const assignee = spec.assigneeCharacterId === undefined ? null : spec.assigneeCharacterId;
    const payload = {
      factionId: spec.factionId,
      stationId: spec.stationId,
      itemKey: spec.itemKey,
      quantity: spec.quantity,
      unitPriceMilli: spec.unitPriceMilli,
      iskTotal: spec.iskTotal,
      expiresAt: spec.expiresAt,
    };
    if (assignee !== null) {
      payload.assigneeCharacterId = assignee;
      payload.standingBonusPermille = bonus;
    }
    if (sell) payload.side = S.SIDE_SELL;

    const r = journal.applyOnce(tx, {
      key,
      aggregate: { type: S.OFFER_AGGREGATE, id: offerId },
      eventType: "TRADE_OFFER_CREATED",
      payload,
    }, (db) => {
      const s = stmts(db);

      const exists = s.openByStationItem.get(toBind(spec.stationId), toBind(spec.itemKind), toBind(spec.itemKey));
      if (exists) return OFFER_EXISTS;

      if (sell) {
        const out = stockOutInDb(db, stockRepo, spec, offerId);
        if (!out.ok) return out;
      } else {
        const adj = budgets.adjustInDb(db, spec.factionId, { availableDelta: -spec.iskTotal, reservedDelta: spec.iskTotal }, spec.at);
        if (!adj.ok) return adj.reason === "BUDGET_NEGATIVE" ? BUDGET_SHORT : NO_BUDGET;
      }

      s.insert.run(
        toBind(offerId),
        toBind(spec.factionId),
        toBind(spec.stationId),
        toBind(spec.systemId),
        toBind(spec.issuerCorporationId),
        toBind(spec.itemKind),
        toBind(spec.itemKey),
        toBind(spec.typeId),
        toBind(spec.quantity),
        toBind(spec.unitPriceMilli),
        toBind(spec.iskTotal),
        toBind(spec.refPriceMilli),
        toBind(spec.capPriceMilli),
        toBind(spec.priceSource),
        toBind(S.PLANNED),
        toBind(spec.endReason || null),
        toBind(null),
        toBind(null),
        toBind(assignee),
        toBind(bonus),
        toBind(spec.at),
        toBind(spec.expiresAt),
        toBind(spec.at),
        toBind(null),
        toBind(spec.channel || "contract"),
        toBind(null),
        toBind(0),
        toBind(side),
      );
      return { ok: true, offer: toOffer(s.byId.get(toBind(offerId))) };
    });

    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const again = journal.findByKey(tx, key);
      const originalOfferId = again && again.found ? again.entry.aggregateId : null;
      const existing = originalOfferId ? stmts(tx).byId.get(toBind(originalOfferId)) : null;
      return { ok: true, duplicate: true, offer: existing ? toOffer(existing) : null };
    }
    return { ok: true, duplicate: false, offer: r.value.offer };
  }

  function transitionOfferInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || !spec.offerId || !Number.isSafeInteger(spec.expectedVersion)
      || !isState(spec.from) || !isState(spec.to) || spec.reason === undefined || typeof spec.reason !== "string"
      || !isTime(spec.at)) {
      return invalid("spec");
    }
    if (typeof key !== "string" || key === "") return invalid("key");
    const hasFee = spec.feeIsk !== undefined;
    if (hasFee && (!Number.isSafeInteger(spec.feeIsk) || spec.feeIsk <= 0 || spec.from !== S.ISSUING
      || spec.to !== S.OPEN)) return invalid("feeIsk");
    const hasStockBackQty = spec.stockBackQuantity !== undefined;
    if (hasStockBackQty && (!Number.isSafeInteger(spec.stockBackQuantity) || spec.stockBackQuantity < 0
      || spec.from !== S.ACCEPTED || spec.to !== S.DELIVERED)) return invalid("stockBackQuantity");
    const pre = stmts(tx).byId.get(toBind(spec.offerId));
    const preSide = pre && pre.side === S.SIDE_SELL ? S.SIDE_SELL : S.SIDE_BUY;
    if (!isValidTransition(spec.from, spec.to, preSide)) return INVALID_TRANSITION;
    const allowedPatch = patchFields(spec.from, spec.to, preSide);
    if (spec.patch && typeof spec.patch === "object") {
      for (const k of Object.keys(spec.patch)) {
        if (!allowedPatch.includes(k)) return invalid(`patch:${k}`);
      }
      const hasChar = Object.prototype.hasOwnProperty.call(spec.patch, "issuerCharacterId");
      const hasCorp = Object.prototype.hasOwnProperty.call(spec.patch, "issuerCharacterCorpId");
      if (hasChar || hasCorp) {
        const c = spec.patch.issuerCharacterId ?? null;
        const k = spec.patch.issuerCharacterCorpId ?? null;
        if ((c === null) !== (k === null)) return invalid("issuer_character_pair");
        if (c !== null && (!isId(c) || !isId(k))) return invalid("issuer_character_ids");
      }
    }

    const payload = { offerId: spec.offerId, from: spec.from, to: spec.to, reason: spec.reason, patch: spec.patch || null };
    if (hasFee) payload.feeIsk = spec.feeIsk;

    const r = journal.applyOnce(tx, {
      key,
      aggregate: { type: S.OFFER_AGGREGATE, id: spec.offerId },
      eventType: "TRADE_OFFER_TRANSITIONED",
      payload,
    }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.offerId));
      if (!row) return NOT_FOUND;
      if (row.version !== spec.expectedVersion) return VERSION_CONFLICT;
      if (row.state !== spec.from) return INVALID_TRANSITION;
      const side = row.side === S.SIDE_SELL ? S.SIDE_SELL : S.SIDE_BUY;
      if (!isValidTransition(spec.from, spec.to, side)) return INVALID_TRANSITION;
      const channelBad = channelRefusal(row, spec);
      if (channelBad) return channelBad;
      if (spec.patch && typeof spec.patch.marketOrderId === "string" && db.prepare(
        "SELECT 1 AS hit FROM world_trade_offers WHERE market_order_id = ? AND offer_id <> ? LIMIT 1")
        .get(spec.patch.marketOrderId, toBind(spec.offerId))) return MARKET_ORDER_TAKEN;

      const newSeq = nextStateSeq(row.state_seq);
      const now = spec.at;
      const isTerminal = S.TERMINAL_OFFER_STATES.includes(spec.to);

      let stockBack = null;
      if (side === S.SIDE_SELL && spec.to === S.CANCELLED) {
        const back = stockBackInDb(db, row, spec);
        if (!back.ok) return back;
        stockBack = back.stockBack;
      }
      if (hasStockBackQty && spec.stockBackQuantity > 0) {
        const maxBack = row.quantity - (Number.isSafeInteger(row.filled_quantity) ? row.filled_quantity : 0);
        if (row.channel !== S.CHANNEL_MARKET || spec.stockBackQuantity > maxBack) return invalid("stockBackQuantity");
        const back = stockBackInDb(db, row, spec, spec.stockBackQuantity);
        if (!back.ok) return back;
        stockBack = back.stockBack;
      } else if (hasStockBackQty && row.channel !== S.CHANNEL_MARKET) {
        return invalid("stockBackQuantity");
      }

      const budgetEffect = edgeBudget(spec.from, spec.to, side);
      let adj = { ok: true };
      if (budgetEffect === "release" && row.isk_total > 0) {
        adj = budgets.adjustInDb(db, row.faction_id, { availableDelta: row.isk_total, reservedDelta: -row.isk_total, releasedTotal: row.isk_total }, now);
        if (!adj.ok) return BUDGET_NEGATIVE;
      } else if (budgetEffect === "spend" && row.isk_total > 0 && row.channel === S.CHANNEL_MARKET) {
        const spent = marketSpendIsk({ unitPriceMilli: row.unit_price_milli, quantity: row.quantity,
          iskTotal: row.isk_total }, spec.patch.filledQuantity);
        const rest = row.isk_total - spent;
        adj = budgets.adjustInDb(db, row.faction_id, { reservedDelta: -row.isk_total, spentTotal: spent,
          availableDelta: rest, releasedTotal: rest }, now);
        if (!adj.ok) return BUDGET_NEGATIVE;
      } else if (budgetEffect === "spend" && row.isk_total > 0) {
        adj = budgets.adjustInDb(db, row.faction_id, { reservedDelta: -row.isk_total, spentTotal: row.isk_total }, now);
        if (!adj.ok) return BUDGET_NEGATIVE;
      }

      let feeChargedIsk = 0;
      if (hasFee) {
        const b = typeof budgets.getBudget === "function" ? budgets.getBudget(db, row.faction_id) : null;
        const avail = b && b.ok && b.budget ? b.budget.availableIsk : 0;
        feeChargedIsk = Math.max(0, Math.min(spec.feeIsk, avail));
        if (feeChargedIsk > 0) {
          const feeAdj = budgets.adjustInDb(db, row.faction_id, { availableDelta: -feeChargedIsk, spentTotal: feeChargedIsk }, now);
          if (!feeAdj.ok) return BUDGET_NEGATIVE;
        }
      }

      const endReason = isTerminal ? spec.reason : null;
      const endedAt = isTerminal ? now : null;

      const updateObj = {
        state: spec.to,
        state_seq: newSeq,
        end_reason: endReason,
        updated_at: now,
        ended_at: endedAt,
      };
      if (spec.patch) {
        for (const k of Object.keys(spec.patch)) {
          const col = PATCH_COLUMNS[k] || k;
          const issuerKey = k === "issuerCharacterId" || k === "issuerCharacterCorpId";
          updateObj[col] = issuerKey && spec.patch[k] === undefined ? null : spec.patch[k];
        }
      }

      const update = updateWithVersion(db, OFFERS_TABLE, spec.offerId, spec.expectedVersion, updateObj);
      if (!update.ok) {
        if (update.reason === "VERSION_CONFLICT") return VERSION_CONFLICT;
        if (update.reason === "UNIQUE_CONSTRAINT") {
          return spec.patch && spec.patch.marketOrderId ? MARKET_ORDER_TAKEN : CONTRACT_ID_TAKEN;
        }
        return update;
      }

      return { ok: true, offer: toOffer(s.byId.get(toBind(spec.offerId))), stockBack, feeChargedIsk };
    });

    if (!r.ok) return unwrap(r);
    const sellCancel = preSide === S.SIDE_SELL && spec.to === S.CANCELLED;
    if (r.duplicate) {
      const existing = stmts(tx).byId.get(toBind(spec.offerId));
      const dup = { ok: true, duplicate: true, offer: existing ? toOffer(existing) : null };
      if (hasFee) return { ...dup, feeChargedIsk: 0, feeShortIsk: 0 };
      return sellCancel ? { ...dup, stockBack: { credited: 0, lost: 0 } } : dup;
    }
    if (hasFee) {
      const charged = r.value.feeChargedIsk;
      return { ok: true, duplicate: false, offer: r.value.offer, feeChargedIsk: charged, feeShortIsk: spec.feeIsk - charged };
    }
    if (r.value.stockBack) return { ok: true, duplicate: false, offer: r.value.offer, stockBack: r.value.stockBack };
    return { ok: true, duplicate: false, offer: r.value.offer };
  }

  function recallOfferInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec.offerId !== "string" || spec.offerId === ""
      || !Number.isSafeInteger(spec.expectedVersion) || !isTime(spec.at)) return invalid("spec");
    if (typeof key !== "string" || key === "") return invalid("key");
    const payload = { offerId: spec.offerId, from: S.OPEN, reason: S.END_REASON_RECALLED };
    const r = journal.applyOnce(tx, {
      key,
      aggregate: { type: S.OFFER_AGGREGATE, id: spec.offerId },
      eventType: "TRADE_OFFER_RECALLED",
      payload,
    }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.offerId));
      if (!row) return NOT_FOUND;
      if (row.version !== spec.expectedVersion) return VERSION_CONFLICT;
      if (row.state !== S.OPEN) return INVALID_TRANSITION;
      const update = updateWithVersion(db, OFFERS_TABLE, spec.offerId, spec.expectedVersion, {
        expires_at: Math.min(row.expires_at, spec.at),
        updated_at: spec.at,
      });
      if (!update.ok) return update.reason === "VERSION_CONFLICT" ? VERSION_CONFLICT : update;
      return { ok: true, offer: toOffer(s.byId.get(toBind(spec.offerId))) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const existing = stmts(tx).byId.get(toBind(spec.offerId));
      return { ok: true, duplicate: true, offer: existing ? toOffer(existing) : null };
    }
    return { ok: true, duplicate: false, offer: r.value.offer };
  }

  function countOpenAll(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const row = stmts(tx).countOpenAll.get();
    return { ok: true, open: Number(row.open_count) || 0, listed: Number(row.listed_count) || 0 };
  }

  function listOpenOfFaction(tx, factionId, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!Number.isSafeInteger(limit) || limit < 1) return invalid("limit");
    const s = stmts(tx);
    const rows = s.listOpen.all(toBind(factionId), toBind(limit + 1));
    const truncated = rows.length > limit;
    const offers = rows.slice(0, limit).map(toOffer);
    return { ok: true, offers, truncated };
  }

  function listRecent(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!opts || !isId(opts.since) || !Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts");
    const s = stmts(tx);
    const rows = s.listRecent.all(toBind(opts.factionId), toBind(opts.since), toBind(opts.limit + 1));
    const truncated = rows.length > opts.limit;
    return { ok: true, offers: rows.slice(0, opts.limit).map(toOffer), truncated };
  }

  function getOffer(tx, offerId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!offerId || typeof offerId !== "string") return invalid("offerId");
    const s = stmts(tx);
    const row = s.byId.get(toBind(offerId));
    return { ok: true, offer: row ? toOffer(row) : null };
  }

  function listByStates(tx, states, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(states) || states.length === 0) return invalid("states");
    for (const st of states) if (!S.OFFER_STATES.includes(st)) return invalid("states");
    if (!opts || !Number.isSafeInteger(opts.factionId) || opts.factionId <= 0) return invalid("factionId");
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;
    const afterOfferId = (opts && opts.afterOfferId) || "";
    const s = stmts(tx);
    const statesJson = JSON.stringify(states);
    const rows = s.listByStates.all(toBind(opts.factionId), toBind(statesJson), toBind(afterOfferId), toBind(limit + 1));
    const truncated = rows.length > limit;
    const offers = rows.slice(0, limit).map(toOffer);
    return { ok: true, offers, truncated };
  }

  function findByContractId(tx, contractId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Number.isSafeInteger(contractId) || contractId <= 0) return invalid("contractId");
    const s = stmts(tx);
    const row = s.byContractId.get(toBind(contractId));
    return { ok: true, offer: row ? toOffer(row) : null };
  }

  function sumOpenReserved(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    const s = stmts(tx);
    const row = s.sumOpenReserved.get(toBind(factionId));
    return { ok: true, total: Number.isSafeInteger(row.total) ? row.total : 0 };
  }

  function listIssuerCorporationIds(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).issuerCorporationIds.all(toBind(limit));
    return { ok: true, corporationIds: rows.map((r) => Number(r.id)).filter(isId) };
  }

  function listIssuerCharacterIds(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    const lim = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_ISSUER_CHARACTER_IDS) : MAX_ISSUER_CHARACTER_IDS;
    const rows = stmts(tx).issuerCharacterIds.all(toBind(lim));
    return { ok: true, characterIds: rows.map((r) => Number(r.id)).filter(isId) };
  }

  function countOpenByIssuer(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    const s = stmts(tx);
    const rows = s.countOpenByIssuer.all(toBind(factionId));
    const counts = new Map();
    for (const r of rows) {
      const cid = Number(r.characterId);
      const cnt = Number(r.cnt);
      if (isId(cid) && Number.isSafeInteger(cnt) && cnt >= 0) counts.set(cid, cnt);
    }
    return { ok: true, counts };
  }

  function listSuppliers(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!opts || !isTime(opts.since) || !Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts");
    const s = stmts(tx);
    const rows = s.listSuppliers.all(toBind(factionId), toBind(opts.since), toBind(opts.limit));
    return { ok: true, suppliers: rows.map(r => ({ characterId: r.characterId, deliveries: r.deliveries, lastAt: r.lastAt })) };
  }

  function lastRejectedAt(tx, factionId, characterId, since) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId) || !isId(characterId) || !isTime(since)) return invalid("args");
    const s = stmts(tx);
    const row = s.lastRejectedAt.get(toBind(factionId), toBind(characterId), toBind(since));
    return { ok: true, at: row && row.at !== null ? Number(row.at) : null };
  }

  function getSuppliersWithRejection(tx, factionId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!opts || !isTime(opts.since) || !Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts");
    const cooldownMs = Number.isSafeInteger(opts.cooldownMs) && opts.cooldownMs > 0 ? opts.cooldownMs : 0;
    
    const supplierResult = listSuppliers(tx, factionId, { since: opts.since, limit: opts.limit });
    if (!supplierResult.ok) return supplierResult;
    
    if (supplierResult.suppliers.length === 0) return { ok: true, suppliers: [] };
    
    const suppliers = [];
    if (cooldownMs > 0) {
      const sinceForRejection = isTime(opts.rejectedSince) ? opts.rejectedSince : Math.max(0, opts.since - cooldownMs);
      for (const s of supplierResult.suppliers) {
        const rejResult = lastRejectedAt(tx, factionId, s.characterId, sinceForRejection);
        if (!rejResult.ok) return rejResult;
        suppliers.push({
          characterId: s.characterId,
          deliveries: s.deliveries,
          lastAt: s.lastAt,
          rejectedAt: rejResult.at,
        });
      }
    } else {
      for (const s of supplierResult.suppliers) {
        suppliers.push({
          characterId: s.characterId,
          deliveries: s.deliveries,
          lastAt: s.lastAt,
          rejectedAt: null,
        });
      }
    }
    return { ok: true, suppliers };
  }

  function listMarketCorporations(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const rows = tx.prepare(
      "SELECT DISTINCT issuer_corporation_id FROM world_trade_offers WHERE channel = 'market' AND issuer_corporation_id IS NOT NULL"
      + " ORDER BY issuer_corporation_id"
    ).all();
    return { ok: true, corporationIds: rows.map(r => r.issuer_corporation_id).filter(v => Number.isSafeInteger(v) && v > 0) };
  }

  function marketOrderGuard(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec.orderId !== "string" || spec.orderId.length === 0) return invalid("orderId");
    const live = S.OPEN_OFFER_STATES.map(() => "?").join(", ");
    const liveRow = tx.prepare(
      `SELECT 1 AS hit FROM world_trade_offers WHERE market_order_id = ? AND state IN (${live}) LIMIT 1`
    ).get(spec.orderId, ...S.OPEN_OFFER_STATES);
    const issuingRow = tx.prepare(
      "SELECT 1 AS hit FROM world_trade_offers o JOIN world_stations s ON s.station_id = o.station_id"
      + " WHERE o.issuer_corporation_id = ? AND s.npc_station_id = ? AND o.type_id = ? AND o.channel = ? AND o.state = ?"
      + " LIMIT 1"
    ).get(spec.corporationId, spec.npcStationId, spec.typeId, S.CHANNEL_MARKET, S.ISSUING);
    return { ok: true, liveOffer: Boolean(liveRow), issuing: Boolean(issuingRow) };
  }

  function recordFillInTx(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec.offerId !== "string" || spec.offerId === "" || !Number.isSafeInteger(spec.expectedVersion)
      || !Number.isSafeInteger(spec.filled) || spec.filled < 1 || !isTime(spec.at)) return invalid("spec");
    if (typeof key !== "string" || key === "") return invalid("key");
    const r = journal.applyOnce(tx, {
      key,
      aggregate: { type: S.OFFER_AGGREGATE, id: spec.offerId },
      eventType: "TRADE_OFFER_FILLED",
      payload: { offerId: spec.offerId, filled: spec.filled },
    }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(toBind(spec.offerId));
      if (!row) return NOT_FOUND;
      if (row.state !== S.OPEN || row.channel !== S.CHANNEL_MARKET) return INVALID_STATE;
      if (row.version !== spec.expectedVersion) return VERSION_CONFLICT;
      if (spec.filled <= row.filled_quantity || spec.filled > row.quantity) return invalid("filled");
      const update = updateWithVersion(db, OFFERS_TABLE, spec.offerId, spec.expectedVersion, {
        filled_quantity: spec.filled,
        updated_at: spec.at,
      });
      if (!update.ok) return update.reason === "VERSION_CONFLICT" ? VERSION_CONFLICT : update;
      return { ok: true, offer: toOffer(s.byId.get(toBind(spec.offerId))) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const existing = stmts(tx).byId.get(toBind(spec.offerId));
      return { ok: true, duplicate: true, offer: existing ? toOffer(existing) : null };
    }
    return { ok: true, duplicate: false, offer: r.value.offer };
  }

  function findByMarketOrderId(tx, orderId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof orderId !== "string" || orderId.length < 1 || orderId.length > 24) return invalid("orderId");
    const row = tx.prepare("SELECT * FROM world_trade_offers WHERE market_order_id = ?").get(orderId);
    return { ok: true, offer: row ? toOffer(row) : null };
  }

  function listOpenMarketOrderIds(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = tx.prepare(
      "SELECT market_order_id AS id FROM world_trade_offers WHERE state IN (?, ?) AND market_order_id IS NOT NULL"
      + " ORDER BY market_order_id LIMIT ?"
    ).all(S.ISSUING, S.OPEN, limit);
    return { ok: true, orderIds: rows.map((r) => String(r.id)) };
  }

  function readForExecutor(store, opts) {
    const tx = store.transaction("trade.executor.read", (db) => {
      const s = stmts(db);
      const { maxIssuesPerPass, maxPollsPerPass, pollCursor } = opts;

      const issuingStmt = db.prepare(
        "SELECT * FROM world_trade_offers WHERE state = ? ORDER BY offer_id LIMIT ?"
      );
      const issuingRows = issuingStmt.all(toBind(S.ISSUING), toBind(maxIssuesPerPass));
      const issuingOffers = issuingRows.map(toOffer);

      const plannedStmt = db.prepare(
        "SELECT * FROM world_trade_offers WHERE state = ? ORDER BY offer_id LIMIT ?"
      );
      const plannedRows = plannedStmt.all(toBind(S.PLANNED), toBind(maxIssuesPerPass));
      const plannedOffers = plannedRows.map(toOffer);

      const openStmt = db.prepare(
        "SELECT * FROM world_trade_offers WHERE state = ? AND offer_id > ? ORDER BY offer_id LIMIT ?"
      );
      const openRows = openStmt.all(toBind(S.OPEN), toBind(pollCursor), toBind(maxPollsPerPass + 1));
      const openOffers = openRows.slice(0, maxPollsPerPass).map(toOffer);
      const newCursor = openRows.length > maxPollsPerPass
        ? openRows[maxPollsPerPass].offer_id
        : "";

      const stationIds = new Set();
      for (const o of issuingOffers) stationIds.add(o.stationId);
      for (const o of plannedOffers) stationIds.add(o.stationId);
      for (const o of openOffers) stationIds.add(o.stationId);

      const stationIdsArr = [...stationIds];
      const stationStmt = db.prepare(
        "SELECT station_id, system_id, kind, state, npc_station_id, owner_corporation_id, destroyed_at FROM world_stations WHERE station_id IN (" +
        stationIdsArr.map(() => "?").join(",") + ")"
      );
      const stationRows = stationStmt.all(...stationIdsArr.map(toBind));
      const stations = new Map();
      for (const r of stationRows) {
        stations.set(r.station_id, {
          stationId: toPositiveInteger(r.npc_station_id) || r.station_id,
          systemId: r.system_id,
          kind: r.kind,
          online: r.state === "ONLINE",
          npcStationId: toPositiveInteger(r.npc_station_id),
          ownerCorporationId: r.owner_corporation_id,
          destroyed: r.destroyed_at !== null,
        });
      }

      return {
        issuingOffers,
        plannedOffers,
        openOffers,
        stations,
        newCursor,
      };
    });
    return tx;
  }

  return Object.freeze({ createOfferInTx, transitionOfferInTx, recallOfferInTx, getOffer, listByStates, listOpenOfFaction, countOpenAll, listRecent, sumOpenReserved, readForExecutor, findByContractId, listSuppliers, lastRejectedAt, getSuppliersWithRejection, listIssuerCharacterIds, listIssuerCorporationIds, countOpenByIssuer, listMarketCorporations, marketOrderGuard, recordFillInTx, findByMarketOrderId, listOpenMarketOrderIds });
}

const deliveriesCache = new WeakMap();
const MAX_DELIVERIES_PAGE = 5000;
const MILLI = 1000n;

function listPlayerDeliveriesAfter(tx, spec) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!spec || !isTime(spec.afterAt) || typeof spec.afterKey !== "string" || spec.afterKey.length > 64
    || !isTime(spec.untilAt) || !Number.isSafeInteger(spec.limit) || spec.limit < 1
    || spec.limit > MAX_DELIVERIES_PAGE) {
    return invalid("deliveriesAfter");
  }
  let stmt = deliveriesCache.get(tx);
  if (!stmt) {
    stmt = tx.prepare(`SELECT offer_id, ended_at, system_id, delivered_quantity, unit_price_milli,
      acceptor_character_id, side
      FROM world_trade_offers WHERE ended_at IS NOT NULL AND ended_at <= ?
      AND (ended_at > ? OR (ended_at = ? AND offer_id > ?)) ORDER BY ended_at, offer_id LIMIT ?`);
    deliveriesCache.set(tx, stmt);
  }
  const read = stmt.all(toBind(spec.untilAt), toBind(spec.afterAt), toBind(spec.afterAt), spec.afterKey,
    toBind(spec.limit));
  const rows = [];
  for (const r of read) {
    if (r.acceptor_character_id === null || r.acceptor_character_id === undefined
      || !(Number(r.delivered_quantity) > 0)) continue;
    const isk = (BigInt(r.delivered_quantity) * BigInt(r.unit_price_milli)) / MILLI;
    rows.push(Object.freeze({ offerId: r.offer_id, endedAt: Number(r.ended_at), systemId: Number(r.system_id),
      iskDelivered: isk > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(isk),
      side: r.side === "sell" ? "sell" : "buy" }));
  }
  const last = read.length > 0 ? read[read.length - 1] : null;
  return { ok: true, rows, scanned: read.length, lastAt: last ? Number(last.ended_at) : null,
    lastKey: last ? last.offer_id : null };
}

module.exports = { createOfferRepository, toOffer, OFFERS_TABLE, MAX_ISSUER_CHARACTER_IDS, listPlayerDeliveriesAfter };