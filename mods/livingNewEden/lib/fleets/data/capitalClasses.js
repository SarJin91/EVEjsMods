"use strict";

const CLASS_SDE_GROUPS = Object.freeze({
  carrier: Object.freeze([547]),
  dreadnought: Object.freeze([485]),
  force_auxiliary: Object.freeze([1538]),
  supercarrier: Object.freeze([659]),
  titan: Object.freeze([30]),
});

const CLASS_SOURCE_TYPES = Object.freeze({
  carrier: Object.freeze({ amarr: 23757, caldari: 23915, gallente: 23911, minmatar: 24483 }),
  dreadnought: Object.freeze({ amarr: 19720, caldari: 19726, gallente: 19724, minmatar: 19722 }),
  force_auxiliary: Object.freeze({ amarr: 37604, caldari: 37605, gallente: 37607, minmatar: 37606 }),
  supercarrier: Object.freeze({ amarr: 23919, caldari: 23917, gallente: 23913, minmatar: 22852 }),
  titan: Object.freeze({ amarr: 11567, caldari: 3764, gallente: 671, minmatar: 23773 }),
});

const CLASS_TIERS = Object.freeze({
  carrier: 1,
  dreadnought: 1,
  force_auxiliary: 1,
  supercarrier: 2,
  titan: 3,
});

module.exports = { CLASS_SDE_GROUPS, CLASS_SOURCE_TYPES, CLASS_TIERS };
