"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { pickWeighted, bandRows } = require("./contracts");
const { contractKeyOf, contractOutboxKeyOf, OUTBOX_KIND_CONTRACT_COURIER } = require("./schema");

const PERMILLE = 1000;
const MILLI = 1000;
const MAX_TITLE = 200;
const MAX_DESCRIPTION = 4000;
const MAX_QUANTITY = 2147483647;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const refuse = (reason) => ({ ok: false, reason });

function rewardOf(jumps, CS) {
  const j = Number.isSafeInteger(jumps) && jumps > 1 ? jumps : 1;
  const raw = CS.rewardBaseIsk + CS.rewardPerJumpIsk * j;
  const capped = Number.isSafeInteger(raw) ? Math.min(CS.rewardMaxIsk, raw) : CS.rewardMaxIsk;
  return Math.max(1, capped);
}

function planCourier({ corp, venture, identity, goods, S, payout, now }) {
  if (!venture || venture.kind !== "HAUL") return refuse("NOT_ELIGIBLE");
  if (!identity || identity.state !== "LINKED" || !isId(identity.ceoCharacterId) || !isId(identity.corporationId)) {
    return refuse("NO_IDENTITY");
  }
  if (!isId(venture.target_station_id) || !isId(venture.target_system_id)
    || venture.target_station_id === corp.home_station_id) {
    return refuse("NO_DESTINATION");
  }
  const CS = S.courier;
  const rng = createRng(deriveSeed(corp.seed, "fccr", venture.seq));
  if (rng.nextInt(1, PERMILLE) > CS.issueChancePermille) return refuse("CHANCE");
  const kind = rng.nextInt(1, PERMILLE) <= S.mineralSharePermille ? "MINERAL" : "ORE";
  const entry = pickWeighted(rng, bandRows(kind === "ORE" ? goods.ores : goods.minerals, venture, corp));
  if (!entry) return refuse("NO_GOODS");
  const share = Math.floor(Math.max(0, Number(payout) || 0) * S.lotSharePermille / PERMILLE);
  const lotIsk = Math.min(S.lotMaxIsk, share);
  if (!isId(lotIsk) || lotIsk < S.lotMinIsk) return refuse("SMALL_LOT");
  const contractKey = contractKeyOf(corp.corp_id, venture.seq);
  const outboxKey = contractOutboxKeyOf(venture.venture_id);
  const row = Object.freeze({ contract_key: contractKey, outbox_key: outboxKey, venture_id: venture.venture_id,
    corp_id: corp.corp_id, kind: "COURIER", goods: kind, state: "PLANNED", open: 1, type_id: entry.typeId,
    station_id: corp.home_station_id, system_id: corp.home_system_id,
    issuer_character_id: identity.ceoCharacterId, issuer_corporation_id: identity.corporationId, lot_isk: lotIsk,
    quantity: null, price_isk: null, vendor_contract_id: null, return_plan: null, revenue_isk: 0, close_attempts: 0,
    created_at: now, opened_at: null, expires_at: null, next_check_at: null, updated_at: now, ended_at: null,
    end_reason: null, version: 1, dest_station_id: venture.target_station_id,
    dest_system_id: venture.target_system_id, reward_isk: rewardOf(venture.jumps, CS), collateral_isk: null,
    deadline_at: null, refund_isk: null });
  return { ok: true, row, outbox: { key: outboxKey, kind: OUTBOX_KIND_CONTRACT_COURIER,
    payload: { v: 1, contractKey } } };
}

function priceCourier({ goods, entry, lotIsk, portionSize, volume, S }) {
  const CS = S.courier;
  if (!entry || !isId(lotIsk)) return refuse("SMALL_LOT");
  const ore = goods === "ORE";
  if (ore && !isId(portionSize)) return refuse("NO_PORTION");
  if (typeof volume !== "number" || !Number.isFinite(volume) || volume <= 0) return refuse("NO_VOLUME");
  const refMilli = ore ? entry.portionPriceMilli : entry.unitPriceMilli;
  if (!isId(refMilli)) return refuse("SMALL_LOT");
  const lotMilli = lotIsk * MILLI;
  if (!Number.isSafeInteger(lotMilli)) return refuse("OVERFLOW");
  const wanted = Math.floor(lotMilli / refMilli);
  const maxUnits = Math.floor(CS.maxVolumeM3 / volume);
  const maxPortions = ore ? Math.floor(maxUnits / portionSize) : maxUnits;
  const portions = Math.min(wanted, maxPortions);
  if (portions < 1) return refuse("SMALL_LOT");
  const quantity = ore ? portions * portionSize : portions;
  if (!Number.isSafeInteger(quantity) || quantity > MAX_QUANTITY) return refuse("OVERFLOW");
  const valueMilli = portions * refMilli;
  const priced = valueMilli * CS.collateralPermille;
  if (!Number.isSafeInteger(valueMilli) || !Number.isSafeInteger(priced)) return refuse("OVERFLOW");
  const collateralIsk = Math.max(1, Math.ceil(priced / (MILLI * PERMILLE)));
  return { ok: true, quantity, collateralIsk, volumeCapped: wanted > maxPortions };
}

function courierTexts({ typeName, quantity, corpName, ticker, contractKey, destName }) {
  const type = typeof typeName === "string" && typeName !== "" ? typeName : "Goods";
  const dest = destName === null || destName === undefined || destName === "" ? "a station" : String(destName);
  const issuer = typeof corpName === "string" && corpName !== ""
    ? `${corpName}${typeof ticker === "string" && ticker !== "" ? ` [${ticker}]` : ""}`
    : "An independent corporation";
  const tag = `[LNE:${contractKey}]`;
  const title = `Courier: ${type} x${quantity} to ${dest}`.slice(0, MAX_TITLE);
  const body = `${issuer} needs ${quantity} x ${type} hauled to ${dest}.`;
  const description = `${body.slice(0, MAX_DESCRIPTION - tag.length - 1)} ${tag}`;
  return { title, description };
}

module.exports = { planCourier, rewardOf, priceCourier, courierTexts };
