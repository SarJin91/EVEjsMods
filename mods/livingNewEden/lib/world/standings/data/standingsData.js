"use strict";

const STANDINGS_DATA_VERSION = 1;

const STANDINGS_DATA_V1 = Object.freeze({
  version: 1,
  eligibleBeneficiaries: Object.freeze([500001, 500002, 500003, 500004, 500006]),
  beneficiaryByRegion: Object.freeze({}),
  rivalByPirate: Object.freeze({ 500010: 500001, 500011: 500002, 500012: 500003, 500019: 500003, 500020: 500004 }),
  eventTypeId: 486,
  navyEventTypeId: 76,
  msgByReason: Object.freeze({ PIRATE_SUPPRESSION: "Pirate suppression (Living New Eden)",
    NAVY_AGGRESSION: "Aggression against the belt navy (Living New Eden)",
    PIRATE_ALLEGIANCE: "Fighting for the pirates (Living New Eden)",
    CONVOY_AGGRESSION: "Attack on a faction convoy (Living New Eden)",
    PIRATE_KILL: "Killing pirates of this faction (Living New Eden)" }),
});

module.exports = { STANDINGS_DATA_VERSION, STANDINGS_DATA_V1 };
