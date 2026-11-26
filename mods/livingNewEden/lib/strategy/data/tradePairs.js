"use strict";

const { OPEN_OFFER_STATES } = require("./tradeStates");

function pairTaken(openOffers, newOffers, stationId, itemKey) {
  for (const o of openOffers) {
    if (OPEN_OFFER_STATES.includes(o.state) && o.stationId === stationId && o.itemKey === itemKey) return true;
  }
  for (const o of newOffers) if (o.stationId === stationId && o.itemKey === itemKey) return true;
  return false;
}

module.exports = { pairTaken };
