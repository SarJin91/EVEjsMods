"use strict";

const GANK_HULLS = Object.freeze({
  500001: Object.freeze({ freighter: 20185, industrial: 648 }),
  500002: Object.freeze({ freighter: 20189, industrial: 653 }),
  500003: Object.freeze({ freighter: 20183, industrial: 1944 }),
  500004: Object.freeze({ freighter: 20187, industrial: 657 }),
});

const FALLBACK_EMPIRE = 500003;

const GANKER = Object.freeze({ typeId: 16240, hullGroup: "destroyer" });

const VICTIM_HULL_GROUPS = Object.freeze({ freighter: "freighter", industrial: "industrial" });

module.exports = { GANK_HULLS, FALLBACK_EMPIRE, GANKER, VICTIM_HULL_GROUPS };
