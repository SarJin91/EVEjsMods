"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { backoffMs } = require("./killmails");
const { contractKeyOf, contractOutboxKeyOf, OUTBOX_KIND_CONTRACT_WTS } = require("./schema");

const PERMILLE = 1000;
const MILLI = 1000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_QUANTITY = 2147483647;
const ELIGIBLE = Object.freeze(["MINE", "BUILD"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const refuse = (reason) => ({ ok: false, reason });

function pickWeighted(rng, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let total = 0;
  for (const r of rows) total += r.weight;
  if (!(total >= 1)) return null;
  let at = rng.nextInt(1, total);
  for (const r of rows) {
    at -= r.weight;
    if (at <= 0) return r;
  }
  return rows[rows.length - 1];
}

function bandRows(table, venture, corp) {
  if (table && Array.isArray(table[venture.sec_band]) && table[venture.sec_band].length > 0) {
    return table[venture.sec_band];
  }
  return table && Array.isArray(table[corp.sec_band]) ? table[corp.sec_band] : null;
}

function raceOf(goods, factionId) {
  const race = goods.factionRace[String(factionId)];
  if (race !== undefined && goods.hulls[String(race)]) return String(race);
  const keys = Object.keys(goods.hulls).map(Number).filter(isId).sort((a, b) => a - b);
  return keys.length > 0 ? String(keys[0]) : null;
}

function planContract({ corp, venture, identity, goods, S, payout, now }) {
  if (!venture || !ELIGIBLE.includes(venture.kind)) return refuse("NOT_ELIGIBLE");
  if (!identity || identity.state !== "LINKED" || !isId(identity.ceoCharacterId) || !isId(identity.corporationId)) {
    return refuse("NO_IDENTITY");
  }
  const rng = createRng(deriveSeed(corp.seed, "fcct", venture.seq));
  if (rng.nextInt(1, PERMILLE) > S.issueChancePermille) return refuse("CHANCE");
  let kind;
  let entry;
  if (venture.kind === "MINE") {
    kind = rng.nextInt(1, PERMILLE) <= S.mineralSharePermille ? "MINERAL" : "ORE";
    entry = pickWeighted(rng, bandRows(kind === "ORE" ? goods.ores : goods.minerals, venture, corp));
  } else {
    kind = "HULL";
    const race = raceOf(goods, corp.race_faction_id);
    const rows = race === null ? [] : goods.hulls[race];
    entry = rows.length > 0 ? rows[rng.nextInt(0, rows.length - 1)] : null;
  }
  if (!entry) return refuse("NO_GOODS");
  const share = Math.floor(Math.max(0, Number(payout) || 0) * S.lotSharePermille / PERMILLE);
  const lotIsk = Math.min(S.lotMaxIsk, share);
  if (!isId(lotIsk) || lotIsk < S.lotMinIsk) return refuse("SMALL_LOT");
  const contractKey = contractKeyOf(corp.corp_id, venture.seq);
  const outboxKey = contractOutboxKeyOf(venture.venture_id);
  const row = Object.freeze({ contract_key: contractKey, outbox_key: outboxKey, venture_id: venture.venture_id,
    corp_id: corp.corp_id, kind: "WTS", goods: kind, state: "PLANNED", open: 1, type_id: entry.typeId,
    station_id: corp.home_station_id, system_id: corp.home_system_id,
    issuer_character_id: identity.ceoCharacterId, issuer_corporation_id: identity.corporationId, lot_isk: lotIsk,
    quantity: null, price_isk: null, vendor_contract_id: null, return_plan: null, revenue_isk: 0, close_attempts: 0,
    created_at: now, opened_at: null, expires_at: null, next_check_at: null, updated_at: now, ended_at: null,
    end_reason: null, version: 1 });
  return { ok: true, row, outbox: { key: outboxKey, kind: OUTBOX_KIND_CONTRACT_WTS,
    payload: { v: 1, contractKey } } };
}

function entryOf(goods, goodsKind, typeId) {
  const scan = (table) => {
    for (const rows of Object.values(table || {})) {
      for (const r of rows) if (r.typeId === typeId) return r;
    }
    return null;
  };
  if (goodsKind === "ORE") return scan(goods.ores);
  if (goodsKind === "MINERAL") return scan(goods.minerals);
  if (goodsKind === "HULL") return scan(goods.hulls);
  if (goodsKind === "GAS") return scan({ gas: Array.isArray(goods.gas) ? goods.gas : [] });
  return null;
}

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const bigOf = (v) => (Number.isSafeInteger(v) && v > 0 ? BigInt(v) : 0n);

function planGasContract(input) {
  const { corp, venture, identity, goods, known, S, WS, gasIsk, stationId, now } = input || {};
  if (!venture || venture.kind !== "WH_HAUL" || !corp || !S || !WS) return refuse("NOT_ELIGIBLE");
  if (!identity || identity.state !== "LINKED" || !isId(identity.ceoCharacterId) || !isId(identity.corporationId)) {
    return refuse("NO_IDENTITY");
  }
  if (!(known instanceof Set)) return refuse("NO_FACTS");
  const rng = createRng(deriveSeed(corp.seed, "fcct", venture.seq));
  if (rng.nextInt(1, PERMILLE) > S.issueChancePermille) return refuse("CHANCE");
  const rows = goods && Array.isArray(goods.gas) ? goods.gas.filter((r) => known.has(r.typeId)) : [];
  const entry = pickWeighted(rng, rows);
  if (!entry) return refuse("NO_GOODS");
  const share = (bigOf(gasIsk) * bigOf(WS.gasSharePermille)) / BigInt(PERMILLE);
  const cap = bigOf(S.lotMaxIsk);
  const lot = share < cap ? share : cap;
  const lotIsk = Number(lot > MAX_SAFE_BIG ? MAX_SAFE_BIG : lot);
  if (!isId(lotIsk) || lotIsk < Math.max(1, S.lotMinIsk)) return refuse("SMALL_LOT");
  const contractKey = contractKeyOf(corp.corp_id, venture.seq);
  const outboxKey = contractOutboxKeyOf(venture.venture_id);
  const row = Object.freeze({ contract_key: contractKey, outbox_key: outboxKey, venture_id: venture.venture_id,
    corp_id: corp.corp_id, kind: "WTS", goods: "GAS", state: "PLANNED", open: 1, type_id: entry.typeId,
    station_id: stationId, system_id: venture.target_system_id,
    issuer_character_id: identity.ceoCharacterId, issuer_corporation_id: identity.corporationId, lot_isk: lotIsk,
    quantity: null, price_isk: null, vendor_contract_id: null, return_plan: null, revenue_isk: 0, close_attempts: 0,
    created_at: now, opened_at: null, expires_at: null, next_check_at: null, updated_at: now, ended_at: null,
    end_reason: null, version: 1 });
  return { ok: true, gasIsk: lotIsk, row, outbox: { key: outboxKey, kind: OUTBOX_KIND_CONTRACT_WTS,
    payload: { v: 1, contractKey } } };
}

function priceLot({ goods, entry, lotIsk, portionSize, S }) {
  if (!entry || !isId(lotIsk)) return refuse("SMALL_LOT");
  const ore = goods === "ORE";
  if (ore && !isId(portionSize)) return refuse("NO_PORTION");
  const refMilli = ore ? entry.portionPriceMilli : entry.unitPriceMilli;
  if (!isId(refMilli)) return refuse("SMALL_LOT");
  const lotMilli = lotIsk * MILLI;
  if (!Number.isSafeInteger(lotMilli)) return refuse("OVERFLOW");
  const portions = Math.floor(lotMilli / refMilli);
  if (portions < 1) return refuse("SMALL_LOT");
  const quantity = ore ? portions * portionSize : portions;
  if (!Number.isSafeInteger(quantity) || quantity > MAX_QUANTITY) return refuse("OVERFLOW");
  const valueMilli = portions * refMilli;
  const priced = valueMilli * S.priceFactorPermille;
  if (!Number.isSafeInteger(valueMilli) || !Number.isSafeInteger(priced)) return refuse("OVERFLOW");
  const priceIsk = Math.max(1, Math.ceil(priced / (MILLI * PERMILLE)));
  return { ok: true, quantity, priceIsk };
}

function contractTexts({ typeName, quantity, corpName, ticker, contractKey }) {
  const type = typeof typeName === "string" && typeName !== "" ? typeName : "Goods";
  const seller = typeof corpName === "string" && corpName !== ""
    ? `${corpName}${typeof ticker === "string" && ticker !== "" ? ` [${ticker}]` : ""}`
    : "An independent corporation";
  const tag = `[LNE:${contractKey}]`;
  const title = `${type} x${quantity}`.slice(0, MAX_TITLE);
  const body = `${seller} sells ${quantity} x ${type} from its own operations.`;
  const description = `${body.slice(0, MAX_DESCRIPTION - tag.length - 1)} ${tag}`;
  return { title, description };
}

module.exports = { planContract, priceLot, contractTexts, entryOf, backoffMs, pickWeighted, bandRows,
  planGasContract };
