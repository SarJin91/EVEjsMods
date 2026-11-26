"use strict";

const S = require("./schema");

const OFFER_TRANSITIONS = Object.freeze({
  [S.PLANNED]: Object.freeze([S.ISSUING, S.CANCELLED]),
  [S.ISSUING]: Object.freeze([S.OPEN, S.CANCELLED]),
  [S.OPEN]: Object.freeze([S.ACCEPTED, S.CANCELLED]),
  [S.ACCEPTED]: Object.freeze([S.INTAKE, S.LOST]),
  [S.INTAKE]: Object.freeze([S.DELIVERED, S.LOST]),
  [S.DELIVERED]: Object.freeze([]),
  [S.CANCELLED]: Object.freeze([]),
  [S.LOST]: Object.freeze([]),
});

const EDGE_BUDGET = Object.freeze({
  [`${S.PLANNED}>${S.CANCELLED}`]: "release",
  [`${S.ISSUING}>${S.CANCELLED}`]: "release",
  [`${S.OPEN}>${S.ACCEPTED}`]: "spend",
  [`${S.OPEN}>${S.CANCELLED}`]: "release",
});

const PATCH_FIELDS = Object.freeze({
  [`${S.PLANNED}>${S.ISSUING}`]: Object.freeze(["expiresAt", "issuerCharacterId", "issuerCharacterCorpId", "channel"]),
  [`${S.ISSUING}>${S.OPEN}`]: Object.freeze(["contractId", "marketOrderId"]),
  [`${S.OPEN}>${S.ACCEPTED}`]: Object.freeze(["acceptorCharacterId", "filledQuantity"]),
  [`${S.INTAKE}>${S.DELIVERED}`]: Object.freeze(["deliveredQuantity"]),
});

const OFFER_TRANSITIONS_SELL = Object.freeze({
  [S.PLANNED]: Object.freeze([S.ISSUING, S.CANCELLED]),
  [S.ISSUING]: Object.freeze([S.OPEN, S.INTAKE, S.CANCELLED, S.LOST]),
  [S.OPEN]: Object.freeze([S.ACCEPTED, S.INTAKE]),
  [S.ACCEPTED]: Object.freeze([S.DELIVERED, S.LOST]),
  [S.INTAKE]: Object.freeze([S.CANCELLED, S.LOST]),
  [S.DELIVERED]: Object.freeze([]),
  [S.CANCELLED]: Object.freeze([]),
  [S.LOST]: Object.freeze([]),
});
const EDGE_BUDGET_SELL = Object.freeze({});
const PATCH_FIELDS_SELL = Object.freeze({
  [`${S.PLANNED}>${S.ISSUING}`]: Object.freeze(["expiresAt", "issuerCharacterId", "issuerCharacterCorpId", "channel"]),
  [`${S.ISSUING}>${S.OPEN}`]: Object.freeze(["contractId", "marketOrderId"]),
  [`${S.OPEN}>${S.ACCEPTED}`]: Object.freeze(["acceptorCharacterId", "filledQuantity"]),
  [`${S.ACCEPTED}>${S.DELIVERED}`]: Object.freeze(["deliveredQuantity"]),
  [`${S.INTAKE}>${S.CANCELLED}`]: Object.freeze(["deliveredQuantity"]),
});

const isSell = (side) => side === S.SIDE_SELL;

function isValidTransition(from, to, side) {
  const allowed = (isSell(side) ? OFFER_TRANSITIONS_SELL : OFFER_TRANSITIONS)[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function edgeBudget(from, to, side) {
  return (isSell(side) ? EDGE_BUDGET_SELL : EDGE_BUDGET)[`${from}>${to}`] || null;
}

function patchFields(from, to, side) {
  const fields = (isSell(side) ? PATCH_FIELDS_SELL : PATCH_FIELDS)[`${from}>${to}`];
  return Array.isArray(fields) ? fields : Object.freeze([]);
}

function nextStateSeq(currentSeq) {
  return Number.isSafeInteger(currentSeq) && currentSeq >= 0 ? currentSeq + 1 : 1;
}

module.exports = { OFFER_TRANSITIONS, OFFER_TRANSITIONS_SELL, isValidTransition, nextStateSeq, edgeBudget,
  patchFields };