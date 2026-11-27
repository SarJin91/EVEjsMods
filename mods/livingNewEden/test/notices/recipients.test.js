"use strict";

const assert = require("node:assert");

const { proximityRecipients, systemsWithin } = require("../../lib/notices/recipients");

const EDGES = new Map([[1, [2]], [2, [1, 3]], [3, [2, 4]], [4, [3]]]);
const graph = { getNeighbors: (id) => (EDGES.has(id) ? EDGES.get(id) : null) };

function presenceOf(bySystem, status = { available: true, stale: false }) {
  return {
    getStatus: () => status,
    getSystemPresence: (id) => (bySystem[id] ? { characters: bySystem[id].map((characterId) => ({ characterId,
      name: `c${characterId}`, state: "space" })) } : null),
  };
}

module.exports = ({ test }) => {
  test("NRC1 proximity: BFS 0/1/2 jumps, unique ascending, max + truncated, refusals", () => {
    const presence = presenceOf({ 1: [30, 10], 2: [20, 10], 3: [40], 4: [50], 9: [90] });
    const at = (systemId, jumps, max = 50) => proximityRecipients({ graph, presence, systemId, jumps, max });
    assert.deepStrictEqual(at(2, 0), { ok: true, characterIds: [10, 20], truncated: false });
    assert.deepStrictEqual(at(2, 1), { ok: true, characterIds: [10, 20, 30, 40], truncated: false });
    assert.deepStrictEqual(at(1, 2), { ok: true, characterIds: [10, 20, 30, 40], truncated: false });
    assert.deepStrictEqual(at(1, 3), { ok: true, characterIds: [10, 20, 30, 40, 50], truncated: false });
    assert.deepStrictEqual(at(2, 1, 3), { ok: true, characterIds: [10, 20, 30], truncated: true });
    assert.deepStrictEqual(at(9, 2), { ok: true, characterIds: [90], truncated: false }, "outside the graph");

    const spec = { graph, systemId: 2, jumps: 1, max: 50 };
    assert.deepStrictEqual(proximityRecipients({ ...spec, presence: presenceOf({}, { available: true, stale: true }) }),
      { ok: false, reason: "PRESENCE_STALE" });
    assert.deepStrictEqual(proximityRecipients({ ...spec, presence: presenceOf({}, { available: false }) }),
      { ok: false, reason: "PRESENCE_UNAVAILABLE" });
    assert.deepStrictEqual(proximityRecipients({ ...spec, presence: null }), { ok: false,
      reason: "PRESENCE_UNAVAILABLE" });
    assert.deepStrictEqual(proximityRecipients({ ...spec, presence, graph: null }), { ok: false,
      reason: "GRAPH_NOT_READY" });
  });

  test("NRC2 systemsWithin: 0 / 1 / 2 jumps on the line graph, outside = itself", () => {
    assert.deepStrictEqual([...systemsWithin(graph, 1, 2)], [[1, 0], [2, 1], [3, 2]]);
    assert.deepStrictEqual([...systemsWithin(graph, 2, 0)], [[2, 0]]);
    assert.deepStrictEqual([...systemsWithin(graph, 9, 3)], [[9, 0]], "outside the graph");
    assert.deepStrictEqual([...systemsWithin(null, 4, 2)], [[4, 0]], "no graph");
  });
};
