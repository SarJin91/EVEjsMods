"use strict";

const assert = require("node:assert");

const { planSentries } = require("../../../lib/strategy/ai/sentries");

const ENEMY = 500010;
const FRIEND = 500004;
const P = Object.freeze({ costIsk: 100, minBalanceMultiple: 5, maxPerFaction: 24, maxPerSystem: 6,
  maxBuildsPerReview: 2, maxCandidateSystems: 16, allowHighsec: false, maxPerAnchor: 6, maxTotal: 500 });

function snap(over = {}) {
  return Object.freeze({
    faction: Object.freeze({ status: "ACTIVE" }),
    treasury: Object.freeze({ mode: "ready", balanceIsk: 1000, accountMode: "NORMAL", ...(over.treasury || {}) }),
    isHostile: (o) => o === ENEMY,
    sentries: Object.freeze({ mode: "ready", typeId: 340501, factionLive: 0, total: 0, rows: [], ...(over.sentries || {}),
      systems: over.systems || [
        { systemId: 2, secClass: "nullsec", occupationState: "STABLE", stations: [],
          neighbours: [{ systemId: 8, controllerFactionId: FRIEND }] },
        { systemId: 1, secClass: "lowsec", occupationState: "STABLE",
          stations: [{ stationId: "st-npc", kind: "npc" }, { stationId: "st-a", kind: "upwell" }],
          neighbours: [{ systemId: 9, controllerFactionId: ENEMY }] },
        { systemId: 3, secClass: "highsec", occupationState: "STABLE", stations: [{ stationId: "st-h", kind: "upwell" }],
          neighbours: [{ systemId: 6, controllerFactionId: ENEMY }] },
        { systemId: 4, secClass: "nullsec", occupationState: "STABLE", stations: [],
          neighbours: [{ systemId: 7, controllerFactionId: ENEMY }] },
        { systemId: 5, secClass: "nullsec", occupationState: "CONTESTED", stations: [],
          neighbours: [{ systemId: 10, controllerFactionId: ENEMY }] },
      ] }),
  });
}

module.exports = ({ test }) => {
  test("SF1 planSentries: station before gate, gate only at a hostile neighbour, highsec skipped, BROKE / CAP / "
    + "NO_SITE, flag off silent", () => {
    const plan = planSentries(snap(), { sentries: P });
    assert.deepStrictEqual(plan, { notes: ["SENTRY_PLAN"], intents: [
      { type: "SENTRY_BUILD", slot: 0, systemId: 1, anchorKind: "station", anchorRef: { stationId: "st-a" },
        typeId: 340501 },
      { type: "SENTRY_BUILD", slot: 1, systemId: 4, anchorKind: "gate", anchorRef: { toSystemId: 7 }, typeId: 340501 }] });
    const full = planSentries(snap({ sentries: { factionLive: 6, rows: Array.from({ length: 6 }, () => ({ systemId: 1,
      anchorKind: "station", anchorRef: { stationId: "st-a" } })) } }), { sentries: { ...P, maxPerSystem: 12,
      maxBuildsPerReview: 1 } });
    assert.deepStrictEqual(full.intents.map((i) => [i.systemId, i.anchorKind, i.anchorRef]),
      [[1, "gate", { toSystemId: 9 }]]);
    const taken = planSentries(snap({ sentries: { anchors: [{ systemId: 1, anchorKind: "station",
      anchorRef: { stationId: "st-a" }, live: 1 }] } }), { sentries: { ...P, maxPerAnchor: 1 } });
    assert.deepStrictEqual(taken.intents.map((i) => [i.systemId, i.anchorKind, i.anchorRef]),
      [[1, "gate", { toSystemId: 9 }], [4, "gate", { toSystemId: 7 }]]);
    const gates = [
      planSentries(snap({ treasury: { balanceIsk: 499 } }), { sentries: P }),
      planSentries(snap({ treasury: { accountMode: "AUSTERITY" } }), { sentries: P }),
      planSentries(snap({ sentries: { factionLive: 24 } }), { sentries: P }),
      planSentries(snap({ systems: [{ systemId: 2, secClass: "nullsec", stations: [],
        neighbours: [{ systemId: 8, controllerFactionId: FRIEND }] }] }), { sentries: P }),
      planSentries(snap(), { sentries: null }),
    ];
    assert.deepStrictEqual(gates.map((g) => [g.notes, g.intents.length]), [[["SENTRY_BROKE"], 0],
      [["SENTRY_BROKE"], 0], [["SENTRY_CAP"], 0], [["SENTRY_NO_SITE"], 0], [[], 0]]);
  });
};
