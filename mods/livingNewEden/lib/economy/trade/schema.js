"use strict";

const { PLANNED, END_REASON_EXPIRED, END_REASON_STATION_GONE, END_REASON_RECALLED, MINERAL_TYPE_IDS, ISSUING, OPEN, ACCEPTED, INTAKE, DELIVERED, CANCELLED, LOST, OPEN_OFFER_STATES, TERMINAL_OFFER_STATES, OFFER_STATES, RESERVED_OFFER_STATES, SIDE_SELL: SIDE_SELL_STATES } = require("../../strategy/data/tradeStates");

const BUDGETS_TABLE_NAME = "world_trade_budgets";
const OFFERS_TABLE_NAME = "world_trade_offers";
const BUDGET_AGGREGATE = "trade_budget";
const OFFER_AGGREGATE = "trade_offer";
const EVENT_BUDGET_FUNDED = "TRADE_BUDGET_FUNDED";
const EVENT_BUDGET_TREASURY = "TRADE_BUDGET_TREASURY";

const ITEM_KIND_MINERAL = "mineral";
const ITEM_KIND_ORE = "ore";
const ITEM_KIND_HULL = "hull";
const ITEM_KIND_MOON = "moon";
const ITEM_KIND_PI = "pi";
const COMMODITY_KINDS = Object.freeze([ITEM_KIND_MOON, ITEM_KIND_PI]);

const PRICE_SOURCE_BID = "bid";
const PRICE_SOURCE_BASE = "base";
const PRICE_SOURCES = Object.freeze([PRICE_SOURCE_BID, PRICE_SOURCE_BASE]);
const SIDE_BUY = "buy";
const SIDE_SELL = SIDE_SELL_STATES;
const SIDES = Object.freeze([SIDE_BUY, SIDE_SELL]);
const PRICE_SOURCE_ASK = "ask";
const SELL_PRICE_SOURCES = Object.freeze([PRICE_SOURCE_ASK]);
const STOCK_REASON_SELL_OUT = "TRADE_WTS_OUT";
const STOCK_REASON_SELL_BACK = "TRADE_WTS_BACK";
const STATION_STATE_DESTROYED = "DESTROYED";
const STATION_STATE_ONLINE = "ONLINE";

const END_REASONS_M6_23B = Object.freeze([END_REASON_EXPIRED, END_REASON_STATION_GONE]);
const END_REASON_ISSUE_FAILED = "ISSUE_FAILED";
const END_REASON_DISABLED = "DISABLED";
const END_REASON_DELETED_EXTERNALLY = "DELETED_EXTERNALLY";
const END_REASON_CONTRACT_MISSING = "CONTRACT_MISSING";
const END_REASON_NO_ISSUER = "NO_ISSUER";
const END_REASONS_M6_24B = Object.freeze([
  END_REASON_EXPIRED, END_REASON_STATION_GONE,
  END_REASON_ISSUE_FAILED, END_REASON_DISABLED,
  END_REASON_DELETED_EXTERNALLY, END_REASON_CONTRACT_MISSING, END_REASON_NO_ISSUER,
]);
const END_REASON_REJECTED = "REJECTED";
const END_REASON_MARKET_EXPIRED = "MARKET_EXPIRED";
const END_REASON_MARKET_CANCELLED = "MARKET_CANCELLED";
const END_REASON_MARKET_MISSING = "MARKET_MISSING";
const END_REASONS = Object.freeze([...END_REASONS_M6_24B, END_REASON_REJECTED, END_REASON_RECALLED,
  END_REASON_MARKET_EXPIRED, END_REASON_MARKET_CANCELLED, END_REASON_MARKET_MISSING]);
const MAX_BONUS_PERMILLE = 1000;

const CHANNEL_CONTRACT = "contract";
const CHANNEL_MARKET = "market";

const TRADE_OFFER_ROWS = 4;
const TRADE_CANCEL_ROWS = 4;

const MAX_UNIT_PRICE_MILLI = 1e12;

const MAX_ISK = 1e15;

const tradeKey = (ik) => `${ik}:trade`;

function transitionKey(offerId, seq, to) {
  return `trade:${String(offerId)}:s${Number(seq)}:${String(to)}`;
}
function issueOutboxKey(offerId) {
  return `trade:${String(offerId)}:issue`;
}
function walletCommandId(offerId, leg) {
  return `lne:trade:${String(offerId)}:${String(leg)}`;
}
function contractTag(offerId) {
  return `[LNE:${String(offerId)}]`;
}
const EVENT_OUTBOX_ISSUE = "TRADE_CONTRACT_ISSUE";
const EVENT_OUTBOX_INTAKE = "TRADE_CONTRACT_INTAKE";
const EVENT_OUTBOX_SWEEP = "TRADE_MARKET_SWEEP";

function intakeOutboxKey(offerId) {
  return `trade:${String(offerId)}:intake`;
}

function sweepOutboxKey(corporationId, n) {
  return `trade:msweep:${String(corporationId)}:${String(n)}`;
}

function sweepCommandId(corporationId, n) {
  return `lne:trade:msweep:${String(corporationId)}:${String(n)}`;
}
function marketPlaceOutboxKey(offerId) {
  return `trade:${String(offerId)}:mplace`;
}
function marketCloseOutboxKey(offerId) {
  return `trade:${String(offerId)}:mclose`;
}
function fillKey(offerId, filled) {
  return `trade:${String(offerId)}:fill:${Number(filled)}`;
}
function marketSellEscrowKey(offerId, orderId, itemId) {
  return `lne:trade:${String(offerId)}:msplace:${String(orderId)}:${String(itemId)}`;
}
function marketSellReturnKey(offerId, orderId, itemId) {
  return `lne:trade:${String(offerId)}:mret:${String(orderId)}:${String(itemId)}`;
}
function marketOrphanVoidKey(orderId, itemId) {
  return `lne:trade:orphan:${String(orderId)}:${String(itemId)}`;
}
const EVENT_OUTBOX_MARKET_PLACE = "TRADE_MARKET_PLACE";
const EVENT_OUTBOX_MARKET_CLOSE = "TRADE_MARKET_CLOSE";
function voidKey(offerId, itemId) {
  return `lne:trade:${String(offerId)}:void:${String(itemId)}`;
}
function deliverKey(offerId) {
  return `trade:${String(offerId)}:deliver`;
}
function stockOutKey(offerId) {
  return `trade:${String(offerId)}:stock-out`;
}
function stockBackKey(offerId) {
  return `trade:${String(offerId)}:stock-back`;
}
function grantKey(offerId) {
  return `lne:trade:${String(offerId)}:grant`;
}
function returnOutboxKey(offerId) {
  return `trade:${String(offerId)}:return`;
}
const EVENT_OUTBOX_RETURN = "TRADE_CONTRACT_RETURN";
const END_REASON_NOTHING_RETURNED = "NOTHING_RETURNED";
const END_REASON_SELL_STOCK_OUT_MISSING = "SELL_STOCK_OUT_MISSING";
const EVENT_BUDGET_WTS_PROCEEDS = "TRADE_BUDGET_WTS_PROCEEDS";
const END_REASON_PROCEEDS_FAILED = "PROCEEDS_FAILED";
function proceedsBudgetKey(offerId) {
  return `trade:${String(offerId)}:proceeds:budget`;
}
function proceedsTreasuryKey(offerId) {
  return `trade:${String(offerId)}:proceeds:treasury`;
}
function proceedsLegKey(offerId) {
  return `trade:${String(offerId)}:proceeds:leg`;
}
const EVENT_WTS_PROCEEDS_LEG = "TRADE_WTS_PROCEEDS_LEG";
const WTS_ORPHAN_ID_PREFIX = "ts_";

const EVENT_STANDING_GRANT = "TRADE_STANDING_GRANT";
const STANDING_KEY_PREFIX = "lne:trd:";
const STANDING_REASON = "FACTION_DELIVERY";
const STANDING_DAY_MS = 86400000;
const STANDING_RAW_SCALE = 1e7;

function standingGrantKey({ characterId, day, factionId, offerId }) {
  return `${STANDING_KEY_PREFIX}${characterId}:${day}:${factionId}:${offerId}`;
}

function standingDayPrefix(characterId, day, factionId) {
  return `${STANDING_KEY_PREFIX}${characterId}:${day}:${factionId}:`;
}

function standingDayRangeEnd(prefix) {
  return `${prefix.slice(0, -1)};`;
}

function parseStandingPayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const required = ["characterId", "factionId", "journalId", "offerId", "rawChange"];
  if (Object.keys(p).sort().join() !== required.sort().join()) return null;
  if (!Number.isSafeInteger(p.characterId) || p.characterId <= 0) return null;
  if (!Number.isSafeInteger(p.factionId) || p.factionId <= 0) return null;
  if (!Number.isSafeInteger(p.journalId) || p.journalId <= 0) return null;
  if (typeof p.offerId !== "string" || p.offerId === "") return null;
  if (typeof p.rawChange !== "number" || !Number.isFinite(p.rawChange) || p.rawChange === 0) return null;
  return { characterId: p.characterId, factionId: p.factionId, journalId: p.journalId, offerId: p.offerId, rawChange: p.rawChange };
}

function upTrade(db) {
  db.exec(`CREATE TABLE world_trade_budgets (
  faction_id          INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
  isk_available       INTEGER NOT NULL CHECK (isk_available BETWEEN 0 AND 1000000000000000),
  isk_reserved        INTEGER NOT NULL CHECK (isk_reserved BETWEEN 0 AND 1000000000000000),
  funded_units_total  INTEGER NOT NULL DEFAULT 0 CHECK (funded_units_total BETWEEN 0 AND 1000000000000000),
  funded_total        INTEGER NOT NULL DEFAULT 0 CHECK (funded_total BETWEEN 0 AND 1000000000000000),
  spent_total         INTEGER NOT NULL DEFAULT 0 CHECK (spent_total BETWEEN 0 AND 1000000000000000),
  released_total      INTEGER NOT NULL DEFAULT 0 CHECK (released_total BETWEEN 0 AND 1000000000000000),
  last_funded_at      INTEGER CHECK (last_funded_at IS NULL OR last_funded_at >= 0),
  created_at          INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
  version             INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
CREATE TABLE world_trade_offers (
  offer_id               TEXT    PRIMARY KEY NOT NULL CHECK (length(offer_id) BETWEEN 1 AND 64),
  faction_id             INTEGER NOT NULL CHECK (faction_id > 0),
  station_id             TEXT    NOT NULL CHECK (length(station_id) BETWEEN 1 AND 64),
  system_id              INTEGER NOT NULL CHECK (system_id > 0),
  issuer_corporation_id  INTEGER NOT NULL CHECK (issuer_corporation_id > 0),
  item_kind              TEXT    NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 16),
  item_key               TEXT    NOT NULL CHECK (length(item_key) BETWEEN 1 AND 64),
  type_id                INTEGER NOT NULL CHECK (type_id > 0),
  quantity               INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000000),
  unit_price_milli       INTEGER NOT NULL CHECK (unit_price_milli BETWEEN 1 AND 1000000000000),
  isk_total              INTEGER NOT NULL CHECK (isk_total BETWEEN 1 AND 1000000000000),
  ref_price_milli        INTEGER NOT NULL CHECK (ref_price_milli > 0),
  cap_price_milli        INTEGER CHECK (cap_price_milli IS NULL OR cap_price_milli > 0),
  price_source           TEXT    NOT NULL CHECK (length(price_source) BETWEEN 1 AND 16),
  state                  TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  state_seq              INTEGER NOT NULL DEFAULT 0 CHECK (state_seq >= 0),
  end_reason             TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
  contract_id            INTEGER CHECK (contract_id IS NULL OR contract_id > 0),
  acceptor_character_id  INTEGER CHECK (acceptor_character_id IS NULL OR acceptor_character_id > 0),
  delivered_quantity     INTEGER NOT NULL DEFAULT 0 CHECK (delivered_quantity >= 0),
  created_at             INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at             INTEGER NOT NULL CHECK (expires_at >= 0),
  updated_at             INTEGER NOT NULL CHECK (updated_at >= 0),
  ended_at               INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
  version                INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
CREATE INDEX world_trade_offers_faction_open ON world_trade_offers (faction_id, offer_id)
  WHERE state IN ('PLANNED', 'ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE');
CREATE UNIQUE INDEX world_trade_offers_station_item_open ON world_trade_offers (station_id, item_kind, item_key)
  WHERE state IN ('PLANNED', 'ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE');
CREATE UNIQUE INDEX world_trade_offers_contract ON world_trade_offers (contract_id) WHERE contract_id IS NOT NULL;
CREATE INDEX world_trade_offers_ended ON world_trade_offers (ended_at) WHERE ended_at IS NOT NULL;`);
}

function upTradePrivate(db) {
  db.exec(`ALTER TABLE world_trade_offers ADD COLUMN assignee_character_id INTEGER
    CHECK (assignee_character_id IS NULL OR assignee_character_id > 0);
ALTER TABLE world_trade_offers ADD COLUMN standing_bonus_permille INTEGER NOT NULL DEFAULT 0
    CHECK (standing_bonus_permille BETWEEN 0 AND 1000);
CREATE INDEX world_trade_offers_supplier ON world_trade_offers (faction_id, updated_at)
    WHERE acceptor_character_id IS NOT NULL;`);
}

const ISSUER_KIND_CORPORATION = "corporation";
const ISSUER_KIND_CHARACTER = "character";
const CHARACTER_ACCOUNT_KEY = 1000;

function upTradeIssuer(db) {
  db.exec(`ALTER TABLE world_trade_offers ADD COLUMN issuer_character_id INTEGER
    CHECK (issuer_character_id IS NULL OR issuer_character_id > 0);
ALTER TABLE world_trade_offers ADD COLUMN issuer_character_corp_id INTEGER
    CHECK (issuer_character_corp_id IS NULL OR issuer_character_corp_id > 0);
CREATE INDEX world_trade_offers_issuer_open ON world_trade_offers (faction_id, issuer_character_id)
    WHERE issuer_character_id IS NOT NULL AND state IN ('ISSUING', 'OPEN', 'ACCEPTED', 'INTAKE');`);
}

function upTradeMarket(db) {
  db.exec(`ALTER TABLE world_trade_offers ADD COLUMN channel TEXT NOT NULL DEFAULT 'contract'
    CHECK (length(channel) BETWEEN 1 AND 16);
ALTER TABLE world_trade_offers ADD COLUMN market_order_id TEXT
    CHECK (market_order_id IS NULL OR length(market_order_id) BETWEEN 1 AND 24);
ALTER TABLE world_trade_offers ADD COLUMN filled_quantity INTEGER NOT NULL DEFAULT 0
    CHECK (filled_quantity >= 0);
CREATE UNIQUE INDEX world_trade_offers_market_order ON world_trade_offers (market_order_id)
    WHERE market_order_id IS NOT NULL;
CREATE INDEX world_trade_offers_market ON world_trade_offers (issuer_corporation_id)
    WHERE channel = 'market';`);
}

function upTradeSell(db) {
  db.exec(`ALTER TABLE world_trade_offers ADD COLUMN side TEXT NOT NULL DEFAULT 'buy'
    CHECK (length(side) BETWEEN 1 AND 8);
ALTER TABLE world_trade_budgets ADD COLUMN wts_proceeds_total INTEGER NOT NULL DEFAULT 0
    CHECK (wts_proceeds_total BETWEEN 0 AND 1000000000000000);
ALTER TABLE world_trade_budgets ADD COLUMN wts_treasury_total INTEGER NOT NULL DEFAULT 0
    CHECK (wts_treasury_total BETWEEN 0 AND 1000000000000000);
ALTER TABLE world_trade_budgets ADD COLUMN wts_burned_total INTEGER NOT NULL DEFAULT 0
    CHECK (wts_burned_total BETWEEN 0 AND 1000000000000000);`);
}

module.exports = {
  BUDGETS_TABLE_NAME,
  OFFERS_TABLE_NAME,
  BUDGET_AGGREGATE,
  OFFER_AGGREGATE,
  EVENT_BUDGET_FUNDED,
  EVENT_BUDGET_TREASURY,
  PLANNED,
  ISSUING,
  OPEN,
  ACCEPTED,
  INTAKE,
  DELIVERED,
  CANCELLED,
  LOST,
  OPEN_OFFER_STATES,
  TERMINAL_OFFER_STATES,
  OFFER_STATES,
  RESERVED_OFFER_STATES,
  ITEM_KIND_MINERAL,
  ITEM_KIND_ORE,
  ITEM_KIND_HULL,
  ITEM_KIND_MOON,
  ITEM_KIND_PI,
  COMMODITY_KINDS,
  PRICE_SOURCE_BID,
  PRICE_SOURCE_BASE,
  PRICE_SOURCES,
  END_REASON_EXPIRED,
  END_REASON_STATION_GONE,
  END_REASONS_M6_23B,
  END_REASON_ISSUE_FAILED,
  END_REASON_DISABLED,
  END_REASON_DELETED_EXTERNALLY,
  END_REASON_CONTRACT_MISSING,
  END_REASON_NO_ISSUER,
  END_REASONS_M6_24B,
  END_REASONS,
  MINERAL_TYPE_IDS,
  TRADE_OFFER_ROWS,
  TRADE_CANCEL_ROWS,
  MAX_UNIT_PRICE_MILLI,
  MAX_ISK,
  tradeKey,
  transitionKey,
  issueOutboxKey,
  walletCommandId,
  contractTag,
  EVENT_OUTBOX_ISSUE,
  intakeOutboxKey,
  voidKey,
  deliverKey,
  EVENT_OUTBOX_INTAKE,
  upTrade,
  upTradePrivate,
  upTradeIssuer,
  ISSUER_KIND_CORPORATION,
  ISSUER_KIND_CHARACTER,
  CHARACTER_ACCOUNT_KEY,
  EVENT_STANDING_GRANT,
  STANDING_KEY_PREFIX,
  STANDING_REASON,
  STANDING_DAY_MS,
  STANDING_RAW_SCALE,
  standingGrantKey,
  standingDayPrefix,
  standingDayRangeEnd,
  parseStandingPayload,
  END_REASON_REJECTED,
  END_REASON_RECALLED,
  MAX_BONUS_PERMILLE,
  CHANNEL_CONTRACT,
  CHANNEL_MARKET,
  EVENT_OUTBOX_SWEEP,
  sweepOutboxKey,
  sweepCommandId,
  upTradeMarket,
  marketPlaceOutboxKey,
  marketCloseOutboxKey,
  fillKey,
  EVENT_OUTBOX_MARKET_PLACE,
  EVENT_OUTBOX_MARKET_CLOSE,
  END_REASON_MARKET_EXPIRED,
  END_REASON_MARKET_CANCELLED,
  END_REASON_MARKET_MISSING,
  marketSellEscrowKey,
  marketSellReturnKey,
  marketOrphanVoidKey,
  SIDE_BUY,
  SIDE_SELL,
  SIDES,
  PRICE_SOURCE_ASK,
  SELL_PRICE_SOURCES,
  STOCK_REASON_SELL_OUT,
  STOCK_REASON_SELL_BACK,
  STATION_STATE_DESTROYED,
  STATION_STATE_ONLINE,
  stockOutKey,
  stockBackKey,
  grantKey,
  returnOutboxKey,
  EVENT_OUTBOX_RETURN,
  END_REASON_NOTHING_RETURNED,
  END_REASON_SELL_STOCK_OUT_MISSING,
  upTradeSell,
  EVENT_BUDGET_WTS_PROCEEDS,
  END_REASON_PROCEEDS_FAILED,
  proceedsBudgetKey,
  proceedsTreasuryKey,
  proceedsLegKey,
  EVENT_WTS_PROCEEDS_LEG,
  WTS_ORPHAN_ID_PREFIX,
};