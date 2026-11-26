"use strict";

const INVADER_PROFILES_VERSION = 7;

const TAG_RE = /^[A-Z]{2,4}$/;

function tagOf(profileId) {
  switch (profileId) {
    case "triglavian-conduit-v1": return "TRIG";
    case "deathless-conduit-v1": return "DTH";
    case "sleeper-tunnel-v1": return "SLP";
    case "drifter-wormhole-v1": return "DRF";
    default: return "??";
  }
}

const PROFILES = Object.freeze([
  Object.freeze({
    profileId: "triglavian-conduit-v1",
    factionId: 500026,
    label: "Triglavian Collective",
    tag: "TRIG",
    weight: 4,
    captureRangeJumps: null,
    withdrawAfterKey: "triglavianWithdrawAfterMs",
    keepsConquest: true,
    consolidates: true,
    doctrineId: "triglavian-invader-v1",
    package: Object.freeze([
      { role: "garrison", count: 2 },
      { role: "invasion", count: 2 },
      { role: "scout", count: 1 },
    ]),
  }),
  Object.freeze({
    profileId: "deathless-conduit-v1",
    factionId: 500029,
    label: "Deathless Circle (Zarzakh)",
    tag: "DTH",
    weight: 3,
    captureRangeJumps: null,
    withdrawAfterKey: "deathlessWithdrawAfterMs",
    keepsConquest: false,
    consolidates: true,
    doctrineId: "deathless-invader-v1",
    package: Object.freeze([
      { role: "garrison", count: 2 },
      { role: "invasion", count: 2 },
      { role: "scout", count: 1 },
    ]),
  }),
  Object.freeze({
    profileId: "sleeper-tunnel-v1",
    factionId: 500021,
    label: "Sleepers",
    tag: "SLP",
    weight: 3,
    captureRangeJumps: 0,
    withdrawAfterKey: "sleeperWithdrawAfterMs",
    keepsConquest: false,
    consolidates: false,
    doctrineId: "sleeper-invader-v1",
    package: Object.freeze([
      { role: "garrison", count: 3 },
    ]),
  }),
  Object.freeze({
    profileId: "drifter-wormhole-v1",
    factionId: 500024,
    label: "Drifters",
    tag: "DRF",
    weight: 3,
    captureRangeJumps: null,
    withdrawAfterKey: "drifterWithdrawAfterMs",
    keepsConquest: false,
    consolidates: true,
    doctrineId: "drifter-invader-v1",
    targetListKey: "knownSpaceJoveObservatorySystemIDs",
    package: Object.freeze([
      { role: "garrison", count: 2 },
      { role: "invasion", count: 2 },
      { role: "scout", count: 1 },
    ]),
  }),
]);
 
for (const p of PROFILES) {
  if (!TAG_RE.test(p.tag)) {
    throw new Error(`INVADER_PROFILE_INVALID_TAG: ${p.profileId} tag="${p.tag}" does not match ^[A-Z]{2,4}$`);
  }
  if (typeof p.keepsConquest !== "boolean") {
    throw new Error(`INVADER_PROFILE_INVALID_KEEPS_CONQUEST: ${p.profileId} keepsConquest must be a boolean`);
  }
}
 
module.exports = { INVADER_PROFILES_VERSION, PROFILES, tagOf };