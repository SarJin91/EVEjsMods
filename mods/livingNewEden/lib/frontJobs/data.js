"use strict";

const STANDING_REASON = "FRONT_JOB";

const STANDING_DATA = Object.freeze({
  eventTypeId: 486,
  msgByReason: Object.freeze({ [STANDING_REASON]: "Front job (Living New Eden)" }),
});

const ISK_SOURCE = "lne-frontjobs";

module.exports = { STANDING_REASON, STANDING_DATA, ISK_SOURCE };
