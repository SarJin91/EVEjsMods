"use strict";

const assert = require("node:assert");

const { candidatesOf, regionsToRead, pickNextPlace, pickTemplate } = require("../../lib/archaeology/places");
const { STAGE_KIND } = require("../../lib/archaeology/schema");
const { BATTLE_RELIC_TEMPLATES } = require("../../lib/events/data/eventCatalog");
const { START, EXCLUDED_REGION, lineGraph, regionOf } = require("./fixture");

const SEED = 123456789;
const base = (extra = {}) => ({ fromSystemId: START, minJumps: 6, maxJumps: 20, maxBfsNodes: 4000,
  excludedRegionIds: [EXCLUDED_REGION], visitedRegionIds: [10], seed: SEED, stageNo: 1, ...extra });

module.exports = ({ test }) => {
  test("A1 archaeology places: deterministic, start/excluded region never, jumps window, HOSTILE controllers, "
    + "regionReused, NO_PLACE, truncated, templates data/relic (500025 relic only)", () => {
    const graph = lineGraph();
    const a = candidatesOf(graph, base());
    const b = candidatesOf(graph, base());
    assert.deepStrictEqual([...a.byRegion], [...b.byRegion]);
    assert.deepStrictEqual(a.regionOrder, b.regionOrder);
    assert.strictEqual(a.truncated, false);
    const all = [...a.byRegion.values()].flat().sort((x, y) => x - y);
    assert.deepStrictEqual(all, [106, 107, 108, 109, 110, 113, 114, 115, 116, 117, 118, 119, 120]);
    assert.ok(!a.byRegion.has(EXCLUDED_REGION) && !a.byRegion.has(10) && !a.byRegion.has(40));
    assert.deepStrictEqual([...a.regionOrder].sort((x, y) => x - y), [20, 30, 50, 60]);

    const nul = pickNextPlace(a, { kind: STAGE_KIND.NULL, seed: SEED, stageNo: 1, controllerOf: new Map() });
    assert.strictEqual(nul.ok, true);
    assert.strictEqual(nul.kind, STAGE_KIND.NULL);
    assert.strictEqual(nul.regionId, a.regionOrder[0]);
    assert.strictEqual(regionOf(nul.systemId), nul.regionId);
    assert.deepStrictEqual(nul, pickNextPlace(a, { kind: STAGE_KIND.NULL, seed: SEED, stageNo: 1 }));

    const ids = regionsToRead(a, { kind: STAGE_KIND.HOSTILE_NULL, hostileRegionTries: 3, maxReadIds: 1000 });
    const regions3 = a.regionOrder.slice(0, 3);
    assert.deepStrictEqual(ids, regions3.flatMap((r) => a.byRegion.get(r)));
    assert.deepStrictEqual(regionsToRead(a, { kind: STAGE_KIND.NULL, hostileRegionTries: 3, maxReadIds: 1000 }), []);
    assert.strictEqual(regionsToRead(a, { kind: STAGE_KIND.HOSTILE_NULL, hostileRegionTries: 3, maxReadIds: 2 })
      .length, 2);
    const held = ids[ids.length - 1];
    const hostile = pickNextPlace(a, { kind: STAGE_KIND.HOSTILE_NULL, seed: SEED, stageNo: 1,
      controllerOf: new Map(ids.map((id) => [id, id === held ? 500010 : null])) });
    assert.deepStrictEqual([hostile.ok, hostile.kind, hostile.systemId], [true, STAGE_KIND.HOSTILE_NULL, held]);
    const loose = pickNextPlace(a, { kind: STAGE_KIND.HOSTILE_NULL, seed: SEED, stageNo: 1,
      controllerOf: new Map(ids.map((id) => [id, null])) });
    assert.strictEqual(loose.kind, STAGE_KIND.NULL);

    const visited = candidatesOf(graph, base({ visitedRegionIds: [10, 20, 30, 50, 60] }));
    const reused = pickNextPlace(visited, { kind: STAGE_KIND.NULL, seed: SEED, stageNo: 1 });
    assert.deepStrictEqual([reused.ok, reused.regionReused], [true, true]);

    assert.deepStrictEqual(pickNextPlace(candidatesOf(lineGraph({ allLow: true }), base()),
      { kind: STAGE_KIND.NULL, seed: SEED, stageNo: 1 }), { ok: false, reason: "NO_PLACE" });
    const cut = candidatesOf(graph, base({ maxBfsNodes: 5 }));
    assert.deepStrictEqual([cut.truncated, cut.nodes, cut.byRegion.size], [true, 5, 0]);

    const relic = BATTLE_RELIC_TEMPLATES[500010];
    const jove = pickTemplate({ theme: "JOVE", controllerFactionId: 500010, seed: SEED, stageNo: 1 });
    assert.strictEqual(jove.factionId, 500010);
    assert.ok(relic.slice(4, 8).includes(jove.templateId), jove.templateId);
    const drifter = pickTemplate({ theme: "DRIFTER", controllerFactionId: 500010, seed: SEED, stageNo: 1 });
    assert.ok(relic.slice(0, 4).includes(drifter.templateId), drifter.templateId);
    const droneData = pickTemplate({ theme: "JOVE", controllerFactionId: 500025, seed: SEED, stageNo: 1 });
    assert.ok(droneData.ok && droneData.factionId !== 500025, JSON.stringify(droneData));
    assert.ok(BATTLE_RELIC_TEMPLATES[droneData.factionId].slice(4, 8).includes(droneData.templateId));
    const droneRelic = pickTemplate({ theme: "DRIFTER", controllerFactionId: 500025, seed: SEED, stageNo: 1 });
    assert.strictEqual(droneRelic.factionId, 500025);
    assert.deepStrictEqual(pickTemplate({ theme: "JOVE", controllerFactionId: null, seed: SEED, stageNo: 1 }),
      pickTemplate({ theme: "JOVE", controllerFactionId: null, seed: SEED, stageNo: 1 }));
    assert.deepStrictEqual(pickTemplate({ theme: "X", controllerFactionId: null, seed: SEED, stageNo: 1 }),
      { ok: false, reason: "NO_TEMPLATE" });
  });
};
