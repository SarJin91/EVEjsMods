"use strict";

const CAMPAIGNS_VERSION = 1;

const CAMPAIGNS_V1 = Object.freeze([
  Object.freeze({
    campaignId: "k3-stain",
    regionId: 10000022,
    ownerFactionId: 500019,
    baseSystemId: 30001868,
    constellationIds: Object.freeze([20000276, 20000280, 20000281, 20000284, 20000287]),
    systemIds: Object.freeze([
      30001867,
      30001868,
      30001869,
      30001870,
      30001871,
      30001872,
      30001893,
      30001894,
      30001895,
      30001896,
      30001897,
      30001898,
      30001899,
      30001900,
      30001901,
      30001902,
      30001903,
      30001904,
      30001923,
      30001924,
      30001925,
      30001926,
      30001927,
      30001928,
      30001929,
      30001930,
      30001948,
      30001949,
      30001950,
      30001951,
      30001952,
      30001953,
      30001954,
      30001955,
    ]),
    defenders: Object.freeze([
      Object.freeze({ factionId: 500003, stagingSystemId: 30001721, entrySystemId: 30001954 }),
    ]),
    origin: "corrected: Stain theatre extended by the corridor to the only Stain-empire "
      + "gate, so the Amarr defender (reach 10) has a front; SDE 3396210",
  }),
]);

module.exports = { CAMPAIGNS_VERSION, CAMPAIGNS_V1 };
