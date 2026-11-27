"use strict";

const assert = require("node:assert");

const { buildMaterializationView } = require("../../lib/materialization/view");

const T0 = 1760000000000;

function statusWith(hunts) {
  return { state: "running", bootAt: T0, passes: 3, budget: null, live: [], spawning: 0, strays: 0,
    failedBattles: 0, failedRecent: [], counters: {}, lastRefusal: null, revertPending: [], hunts };
}

module.exports = ({ test }) => {
  test("SD4 materialization view: hunts section with one hunt (huntId, system, faction, quarry by name, mode "
    + "phase code + label, ships alive/all, time); off without the hunt step", () => {
    const hunt = { huntId: "ph:f1:2", systemId: 30000142, fleetId: "f1", factionId: 500019, characterId: 103,
      quarryName: "Pilot 103", mode: "SCAN", state: "LIVE", phase: "WARP_TO_TARGET", phaseSince: T0, objectIndex: 0,
      visited: 1, objects: 3, scanCycle: 4, ships: 3, alive: 2, liveSince: T0, aggressors: 0, despawned: false,
      endReason: null };
    const counters = { scanCycles: 4, scanHits: 1 };
    let status = statusWith({ enabled: true, lossImport: "on", active: 1, ships: 3, hunts: [hunt], counters,
      lastRefusal: null });
    const graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === 30000142 ? { name: "Jita" }
      : null) } }) };
    const view = buildMaterializationView({ getStatus: () => status, clock: { now: () => T0 + 125000 },
      getGraph: () => graph, readFactionNames: () => new Map([[500019, "Guristas Pirates"]]) });
    const data = view.getData();
    assert.deepStrictEqual(data.hunts, { enabled: true, lossImport: "on", active: 1, ships: 3, counters,
      lastRefusal: null, rows: [{ huntId: "ph:f1:2", system: "Jita", frakcja: "Guristas Pirates", ofiara: "Pilot 103",
        tryb: "SCAN", trybEtykieta: "scanner", stan: "LIVE", faza: "WARP_TO_TARGET", fazaEtykieta: "warping to quarry",
        cykl: 4, statki: "2/3", czas: "2m 05s" }], pursuits: [] });
    assert.ok(data.hunts.rows.every((r) => Object.values(r).every((v) => v === null || typeof v !== "object")),
      "flat rows: the generic renderer draws a table");

    status = statusWith({ enabled: true, lossImport: "on", active: 1, ships: 0, counters, lastRefusal: null,
      hunts: [{ ...hunt, mode: "SWEEP", state: "SPAWNING", phase: "SWEEP_DWELL", liveSince: null, alive: 0 }] });
    const bare = buildMaterializationView({ getStatus: () => status }).getData();
    assert.deepStrictEqual(bare.hunts.rows.map((r) => [r.system, r.frakcja, r.tryb, r.fazaEtykieta, r.cykl, r.czas]),
      [["30000142", "500019", "SWEEP", "spawn", null, "-"]]);

    status = statusWith({ state: "off" });
    assert.deepStrictEqual(view.getData().hunts, { enabled: false, active: 0, rows: [] });
  });

  test("HW5 materialization view: the faction names are read at most once per getData (an empty map is not "
    + "cached across requests, a non-empty one is)", () => {
    const row = (n) => ({ huntId: `ph:f${n}:1`, systemId: 30000142, fleetId: `f${n}`, factionId: 500019,
      characterId: 100 + n, quarryName: null, mode: "SWEEP", state: "LIVE", phase: "SWEEP_DWELL", phaseSince: T0,
      objectIndex: 0, visited: 1, objects: 3, scanCycle: 0, ships: 3, alive: 3, liveSince: T0, aggressors: 0,
      despawned: false, endReason: null });
    const status = statusWith({ enabled: true, lossImport: "on", active: 3, ships: 9, counters: {}, lastRefusal: null,
      hunts: [row(1), row(2), row(3)] });
    let reads = 0;
    let names = new Map();
    const view = buildMaterializationView({ getStatus: () => status, readFactionNames: () => {
      reads += 1;
      return names;
    } });
    assert.deepStrictEqual(view.getData().hunts.rows.map((r) => r.frakcja), ["500019", "500019", "500019"]);
    assert.strictEqual(reads, 1, "3 rows, empty map: one read in one getData");
    view.getData();
    assert.strictEqual(reads, 2, "empty map not cached: one more read in the next getData");
    names = new Map([[500019, "Guristas Pirates"]]);
    assert.strictEqual(view.getData().hunts.rows[2].frakcja, "Guristas Pirates");
    view.getData();
    assert.strictEqual(reads, 3, "non-empty map cached");
  });

  test("Materialization view: hunts.pursuits lists the pursuits on the way (from / to by name, faction "
    + "quarry, hops, arriveAt, time to arrival); empty without pursuits", () => {
    const pursuit = { chainId: "ph:f1:2", fleetId: "f1", factionId: 500019, characterId: 103, quarryName: null,
      fromSystemId: 30000142, targetSystemId: 30000144, operationId: "op1", arriveAt: T0 + 90000, hops: 1,
      startedAt: T0 };
    let status = statusWith({ enabled: true, lossImport: "off", active: 0, ships: 0, hunts: [], counters: {},
      lastRefusal: null, pursuits: [pursuit] });
    const graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ 30000142: { name: "Jita" },
      30000144: { name: "Perimeter" } })[id] || null } }) };
    const view = buildMaterializationView({ getStatus: () => status, clock: { now: () => T0 + 15000 },
      getGraph: () => graph, readFactionNames: () => new Map([[500019, "Guristas Pirates"]]) });
    const data = view.getData();
    assert.deepStrictEqual(data.hunts.pursuits, [{ chainId: "ph:f1:2", fleetId: "f1", frakcja: "Guristas Pirates",
      ofiara: "103", skad: "Jita", dokad: "Perimeter", skoki: 1, arriveAt: T0 + 90000, przylotZa: "1m 15s" }]);
    assert.deepStrictEqual(data.hunts.rows, []);

    status = statusWith({ enabled: true, lossImport: "off", active: 0, ships: 0, hunts: [], counters: {},
      lastRefusal: null, pursuits: [] });
    assert.deepStrictEqual(view.getData().hunts.pursuits, []);
  });
};
