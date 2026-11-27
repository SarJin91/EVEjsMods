"use strict";

const assert = require("node:assert");
const { planTerritoryTrim } = require("../../lib/strategy/ai/territoryTrim");

const F = 500011;
const EDGES = [[100, 101], [101, 102], [102, 103], [103, 104], [104, 105], [105, 106], [106, 107], [107, 108],
  [103, 201], [201, 202], [202, 203], [203, 204], [203, 205], [203, 206]];
const ADJ = new Map();
for (const [a, b] of EDGES) {
  ADJ.set(a, [...(ADJ.get(a) || []), b]);
  ADJ.set(b, [...(ADJ.get(b) || []), a]);
}
const PARAMS = Object.freeze({ territoryTrimEnabled: true, startTerritoryJumps: 2, maxTrimsPerReview: 32,
  captureRangeFromStationJumps: 5, routeMaxJumps: 40, maxBfsSystems: 2000 });
const row = (systemId, over = {}) => ({ systemId, state: "STABLE", capturedAt: null, ...over });

function snap(trim, over = {}) {
  return { factionId: F, faction: { homeSystemId: 205 }, neighbors: (id) => ADJ.get(id) || [], theatre: [201],
    border: { mode: "ready", reach: new Map([[204, 1]]) }, trim, ...over };
}

const ROWS = [row(101), row(102), row(103), row(104), row(105, { capturedAt: 1 }), row(106), row(108), row(201),
  row(202, { state: "CONTESTED" }), row(203), row(204), row(205), row(206)];
const READY = (over = {}) => ({ mode: "ready", anchors: [100, 108], rows: ROWS, afterSystemId: 0,
  nextAfterSystemId: 500, passClean: true, ...over });

module.exports = ({ test }) => {
  test("TT1 planner: radius 2, stations, captured, theatre, belt, home and non-STABLE stay; the rest by "
    + "(jumps desc, systemId) up to the limit; cursor kept above the limit, next page below it", () => {
    const two = planTerritoryTrim(snap(READY()), { ...PARAMS, maxTrimsPerReview: 2 });
    assert.deepStrictEqual(two, { intents: [{ type: "TERRITORY_TRIM", systemIds: [203, 206] }],
      notes: ["TRIM_PLANNED"], cursor: { afterSystemId: 0, passClean: false } });
    const all = planTerritoryTrim(snap(READY()), PARAMS);
    assert.deepStrictEqual(all, { intents: [{ type: "TERRITORY_TRIM", systemIds: [103, 104, 203, 206] }],
      notes: ["TRIM_PLANNED"], cursor: { afterSystemId: 500, passClean: false } });
    const three = planTerritoryTrim(snap(READY()), { ...PARAMS, maxTrimsPerReview: 3 });
    assert.deepStrictEqual(three.intents[0].systemIds, [104, 203, 206], "jumps desc: far first, then 4");
    assert.deepStrictEqual(planTerritoryTrim(snap(READY({ nextAfterSystemId: null })), PARAMS).cursor,
      { afterSystemId: 0, passClean: true });
  });

  test("TT2 planner: a clean pass at the end -> TERRITORY_TRIM_DONE (cursor null); done / off / disabled -> "
    + "nothing; no_anchors / stations_off / failed -> one note; deterministic", () => {
    const kept = ROWS.filter((r) => ![103, 104, 203, 206].includes(r.systemId));
    assert.deepStrictEqual(planTerritoryTrim(snap(READY({ rows: kept, nextAfterSystemId: null })), PARAMS),
      { intents: [{ type: "TERRITORY_TRIM_DONE" }], notes: ["TRIM_DONE"], cursor: null });
    assert.deepStrictEqual(planTerritoryTrim(snap(READY({ rows: kept })), PARAMS),
      { intents: [], notes: [], cursor: { afterSystemId: 500, passClean: true } });
    assert.deepStrictEqual(planTerritoryTrim(snap(READY({ rows: kept, nextAfterSystemId: null, passClean: false })),
      PARAMS), { intents: [], notes: [], cursor: { afterSystemId: 0, passClean: true } });
    const none = { intents: [], notes: [], cursor: null };
    assert.deepStrictEqual(planTerritoryTrim(snap({ mode: "done" }), PARAMS), none);
    assert.deepStrictEqual(planTerritoryTrim(snap({ mode: "off" }), PARAMS), none);
    assert.deepStrictEqual(planTerritoryTrim(snap(undefined), PARAMS), none);
    assert.deepStrictEqual(planTerritoryTrim(snap(READY()), { ...PARAMS, territoryTrimEnabled: false }), none);
    assert.deepStrictEqual(planTerritoryTrim(snap(READY()), null), none);
    assert.deepStrictEqual(planTerritoryTrim(snap({ mode: "no_anchors" }), PARAMS),
      { intents: [], notes: ["TRIM_NO_ANCHORS"], cursor: null });
    assert.deepStrictEqual(planTerritoryTrim(snap({ mode: "stations_off" }), PARAMS).notes, ["TRIM_STATIONS_OFF"]);
    assert.deepStrictEqual(planTerritoryTrim(snap({ mode: "failed" }), PARAMS).notes, ["TRIM_FAILED"]);
    assert.deepStrictEqual(planTerritoryTrim(snap(READY({ rows: null })), PARAMS),
      { intents: [], notes: ["TRIM_FAILED"], cursor: null }, "never throws");
    assert.deepStrictEqual(planTerritoryTrim(snap(READY()), PARAMS), planTerritoryTrim(snap(READY()), PARAMS));
    assert.deepStrictEqual(planTerritoryTrim(snap(READY()), { ...PARAMS, maxBfsSystems: 3 }).intents, []);
  });
};
