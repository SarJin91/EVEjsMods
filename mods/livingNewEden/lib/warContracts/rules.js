"use strict";

const T = require("../strategy/data/tradeStates");
const S = require("./schema");
const { UNKNOWN } = require("../names/fallback");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const CONTRACT = "contract";
const WAIT_STATES = Object.freeze([T.PLANNED, T.ISSUING, T.OPEN]);
const AWARD_STATES = Object.freeze([T.ACCEPTED, T.INTAKE, T.DELIVERED, T.LOST]);
const ALL_KINDS = Object.freeze(["hull", "mineral", "ore"]);
const HULL_KINDS = Object.freeze(["hull"]);

const itemKindsOf = (hullsOnly) => (hullsOnly === true ? HULL_KINDS : ALL_KINDS);

function isWarOffer(offer, P, now) {
  if (!offer || typeof offer.offerId !== "string" || !offer.offerId.startsWith(S.WAR_OFFER_PREFIX)) return false;
  if (offer.side === T.SIDE_SELL || offer.channel !== CONTRACT) return false;
  if (!WAIT_STATES.includes(offer.state)) return false;
  const hasAssignee = offer.assigneeCharacterId !== null && offer.assigneeCharacterId !== undefined;
  if (hasAssignee && P.includePrivate !== true) return false;
  if (!Array.isArray(P.itemKinds) || !P.itemKinds.includes(offer.itemKind)) return false;
  if (!isId(offer.factionId) || !isId(offer.systemId) || !isId(offer.typeId) || !isId(offer.quantity)) return false;
  if (typeof offer.stationId !== "string" || offer.stationId === "" || typeof offer.itemKey !== "string"
    || offer.itemKey === "") return false;
  if (!isId(offer.iskTotal)) return false;
  return !(Number.isSafeInteger(offer.expiresAt) && offer.expiresAt <= now);
}

function isLateWarOffer(offer, P, now) {
  if (!(Number.isSafeInteger(P.adoptLateMs) && P.adoptLateMs > 0)) return false;
  if (!offer || !AWARD_STATES.includes(offer.state)) return false;
  const at = Number.isSafeInteger(offer.endedAt) ? offer.endedAt : offer.updatedAt;
  if (!Number.isSafeInteger(at) || at < now - P.adoptLateMs) return false;
  return isWarOffer({ ...offer, state: T.OPEN, expiresAt: null }, P, now);
}

function rewardOf(offer, P, lpCorpOf) {
  const iskTotal = isId(offer && offer.iskTotal) ? offer.iskTotal : 0;
  const corp = typeof lpCorpOf === "function" ? lpCorpOf(offer && offer.factionId) : null;
  const lpCorporationId = isId(corp) ? corp : null;
  let lpAmount = 0;
  if (lpCorporationId !== null) {
    const raw = Math.floor((iskTotal * P.lpPerMillionIsk) / 1e6);
    lpAmount = Math.min(P.lpMax, Math.max(P.lpMin, raw));
  }
  const iskAmount = Math.floor((iskTotal * P.iskBonusPermille) / 1000);
  const standingMicro = Math.max(0, Math.round(P.standingRaw * 1e6));
  return { iskAmount: Math.max(0, iskAmount), lpAmount: Math.max(0, lpAmount), lpCorporationId, standingMicro };
}

function decideSettle(row, offer, { awardsInWindow, maxAwards, tradeStandingGrant }) {
  if (offer === null || offer === undefined) return { action: "LAPSE", reason: S.END_REASON_OFFER_GONE };
  if (WAIT_STATES.includes(offer.state)) return { action: "WAIT" };
  if (isId(offer.acceptorCharacterId) && AWARD_STATES.includes(offer.state)) {
    const characterId = offer.acceptorCharacterId;
    if (awardsInWindow >= maxAwards) return { action: "CAP", characterId };
    const legs = {
      isk: row.iskAmount > 0 ? S.LEG.PENDING : S.LEG.SKIPPED,
      lp: row.lpAmount > 0 && isId(row.lpCorporationId) ? S.LEG.PENDING : S.LEG.SKIPPED,
      std: row.standingMicro > 0 && tradeStandingGrant !== true ? S.LEG.PENDING : S.LEG.SKIPPED,
    };
    const allSkipped = [legs.isk, legs.lp, legs.std].every((l) => l === S.LEG.SKIPPED);
    return { action: "AWARD", characterId, legs, payoutState: allSkipped ? S.PAYOUT.PAID : S.PAYOUT.PENDING };
  }
  if (AWARD_STATES.includes(offer.state)) return { action: "LAPSE", reason: S.END_REASON_NO_CHARACTER };
  const reason = String(offer.endReason || offer.state || S.END_REASON_OFFER_GONE).slice(0, S.MAX_END_REASON);
  return { action: "LAPSE", reason };
}

function descriptionOf(row, names) {
  const n = names || {};
  const faction = (typeof n.faction === "function" && n.faction(row.factionId)) || UNKNOWN.faction;
  const type = (typeof n.type === "function" && n.type(row.typeId)) || UNKNOWN.item;
  return `Living New Eden: war contract ${row.quantity}x ${type} for ${faction}`.slice(0, S.MAX_DESCRIPTION);
}

module.exports = { isWarOffer, isLateWarOffer, rewardOf, decideSettle, descriptionOf, itemKindsOf, WAIT_STATES, AWARD_STATES };
