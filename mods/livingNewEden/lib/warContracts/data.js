"use strict";

const STANDING_REASON = "WAR_CONTRACT";

const STANDING_DATA = Object.freeze({
  eventTypeId: 486,
  msgByReason: Object.freeze({ [STANDING_REASON]: "War contract (Living New Eden)" }),
});

const ISK_SOURCE = "lne-warcontracts";

module.exports = { STANDING_REASON, STANDING_DATA, ISK_SOURCE };
