"use strict";

const SYSTEM_ID_SPACES = Object.freeze({
  known: Object.freeze({ min: 30000000, max: 30999999 }),
  wormhole: Object.freeze({ min: 31000000, max: 31999999 }),
});

const SEC_CLASS_BY_BAND = Object.freeze(["nullsec", "lowsec", "highsec"]);

const SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);

module.exports = { SYSTEM_ID_SPACES, SEC_CLASS_BY_BAND, SEC_CLASSES };
