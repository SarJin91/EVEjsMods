"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { buildSystemCardView } = require("../../lib/observer/views/systemCard");
const { buildFleetsLayerView } = require("../../lib/fleets/fleetsLayer");
const { buildParkedFleetsLayerView } = require("../../lib/fleets/parkedFleetsLayer");
const { createUnavailableCrews } = require("../../lib/crews");

const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const SYS = 30000142;
const NOW = 100000;
const SETTINGS = Object.freeze({ refreshMs: 15000, maxRows: 12, maxFleets: 200, recentBattles: 5,
  crewsMaxPilots: 4, crewsMaxFleets: 64 });

function fakeStore() {
  const s = { dbs: [], isOpen: () => true };
  s.transaction = (_name, fn) => {
    const db = { token: s.dbs.length + 1 };
    s.dbs.push(db);
    return { ok: true, value: fn(db) };
  };
  return s;
}

function fakeCrews(store, seatsByFleet, wantedByFleet) {
  const seen = [];
  const inTx = (db) => {
    seen.push(db);
    assert.strictEqual(db, store.dbs[store.dbs.length - 1], "read in the card's transaction");
  };
  return { seen, crews: {
    listSeatsInTx(db, ids) {
      inTx(db);
      return { ok: true, byFleet: new Map(ids.map((id) => [id, seatsByFleet[id] || []])) };
    },
    summarizeInTx(db, ids) {
      inTx(db);
      return { ok: true, byFleet: new Map(ids.map((id) => [id, { seated: (seatsByFleet[id] || []).length,
        wanted: wantedByFleet[id] || 0, names: [] }])) };
    },
    listPilotStatsInTx(db, ids) {
      inTx(db);
      return { ok: true, byId: new Map(ids.filter((c) => c === 9001).map((c) => [c, { losses: 2 }])) };
    },
    describe: (c) => ({ ok: true, name: `P${c}`, corporationId: 1, allianceId: 2, corporationName: `Corp${c % 2}`,
      allianceName: "Ally" }),
  } };
}

const seat = (c, hullGroup) => ({ seat: c % 10, characterId: c, hullGroup, typeId: null, joinedAt: 1 });

function cardOf(store, crews) {
  const ctx = {
    world: { repository: { getSystem: () => ({ ok: true, system: { occupationState: "STABLE", controllerFactionId: 500,
      occupierFactionId: null, previousControllerFactionId: null, homeFactionId: 500, lastStateChangeAt: 0,
      capturedAt: null, detachedSinceAt: null, influence: [] } }) } },
    fleets: { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [
      { fleetId: "fa", factionId: 500, fleetRole: "garrison", state: "IDLE", shipCount: 3 },
      { fleetId: "fb", factionId: 501, fleetRole: "patrol", state: "STAGED", shipCount: 2 },
      { fleetId: "fc", factionId: 501, fleetRole: "patrol", state: "IDLE", shipCount: 1 }] }),
    listOperationsByTarget: () => ({ ok: true, operations: [] }) } },
    crews,
  };
  return buildSystemCardView({ ctx, store, clock: { now: () => NOW }, factionNames: new Map(), settings: SETTINGS })
    .getData({ param: SYS });
}

function inFlight(fleetId) {
  return { fleetId, factionId: 500, fleetRole: "patrol", shipCount: 3, operationId: null, targetSystemId: 3,
    legSeq: 1, state: "TRAVELLING", route: { v: 1, mode: "travel", systems: [1, 2, 3], departAt: 0, jumpMs: 100000,
      arriveAt: 200000, graphVersion: 1, observed: false } };
}

module.exports = ({ test }) => {
  test("OC1 system-card crews: 3+2 pilots, limit 4 -> 4 and truncated, names by describe, same tx; stub -> null", () => {
    const store = fakeStore();
    const f = fakeCrews(store, { fa: [seat(9001, "frigate"), seat(9002, "frigate"), seat(9003, "cruiser")],
      fb: [seat(9011, "cruiser"), seat(9012, "cruiser")] }, { fa: 3, fb: 2 });
    const data = cardOf(store, f.crews);
    assert.strictEqual(data.available, true, JSON.stringify(data));
    assert.strictEqual(store.dbs.length, 1, "one transaction");
    assert.ok(f.seen.length >= 3);
    assert.strictEqual(data.crews.truncated, true);
    assert.deepStrictEqual(data.crews.fleets.map((x) => [x.fleetId, x.factionId, x.shipCount, x.seated, x.wanted,
      x.pilots.length]), [["fa", 500, 3, 3, 3, 3], ["fb", 501, 2, 2, 2, 1]], "fc has no crew: left out");
    assert.deepStrictEqual(data.crews.fleets[0].pilots[0], { characterId: 9001, name: "P9001", corporationName: "Corp1",
      allianceName: "Ally", hullGroup: "frigate", typeId: null, losses: 2 });
    assert.strictEqual(data.crews.fleets[1].pilots[0].losses, 0);

    const offStore = fakeStore();
    const off = cardOf(offStore, createUnavailableCrews("disabled_by_config"));
    assert.strictEqual(off.crews, null);
    const { crews: _a, ...restOn } = data;
    const { crews: _b, ...restOff } = off;
    assert.deepStrictEqual(restOff, restOn, "the rest of the card unchanged");
    assert.strictEqual(cardOf(fakeStore(), undefined).crews, null, "no ctx.crews");

    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(WEB_DIR, "systemCard.js"), "utf8"), sandbox,
      { filename: "systemCard.js" });
    const model = sandbox.window.LneSystemCard._pure.crewModel(data.crews);
    assert.strictEqual(model.truncated, true);
    assert.strictEqual(model.fleets[0].seats, "3/3");
    assert.strictEqual(model.fleets[0].pilots[0].name, "P9001");
    assert.strictEqual(model.fleets[0].pilots[0].detail, "Corp1 · Ally · losses 2");
    assert.strictEqual(model.fleets[1].more, 1, "+1 at the truncated fleet");
    assert.strictEqual(sandbox.window.LneSystemCard._pure.crewModel(null), null);
  });

  test("OC2 layer-fleets: getCrewSummary -> `pilots: A, B +1` in the same tx; no dep -> the old tooltip", () => {
    const fleets = [inFlight("f1"), inFlight("f2")];
    const repository = { listFleetsByState: (_tx, state) => ({ ok: true,
      fleets: state === "TRAVELLING" ? fleets : [], nextAfterFleetId: null }) };
    const base = { repository, clock: { now: () => NOW }, maxItems: 10, refreshMs: 1000 };
    const plain = buildFleetsLayerView({ ...base, store: fakeStore() }).getData();
    assert.deepStrictEqual(plain.items[0][4], ["f1", "faction 500", "patrol - 3 ships", "op -", "-> 3 ETA 2 min",
      "leg 1"], "the tooltip without crews as before");
    const store = fakeStore();
    const calls = [];
    const getCrewSummary = (tx, ids) => {
      calls.push(ids);
      assert.strictEqual(tx, store.dbs[0], "the layer's transaction");
      return new Map([["f1", { seated: 3, wanted: 3, names: ["A", "B"] }], ["f2", { seated: 0, wanted: 2, names: [] }]]);
    };
    const data = buildFleetsLayerView({ ...base, store, getCrewSummary }).getData();
    assert.deepStrictEqual(calls, [["f1", "f2"]]);
    assert.strictEqual(store.dbs.length, 1);
    assert.deepStrictEqual(data.items[0][4], [...plain.items[0][4], "pilots: A, B +1"]);
    assert.deepStrictEqual(data.items[1][4], plain.items[1][4], "no names -> no line");
    assert.strictEqual(data.key, plain.key, "cache key unchanged");
    const nul = buildFleetsLayerView({ ...base, store: fakeStore(), getCrewSummary: () => null }).getData();
    assert.deepStrictEqual(nul.items, plain.items);
  });

  test("OC3 parked fleets layer: ` - crew 3` at the fleet line, same tx; no dep -> lines unchanged", () => {
    const line = (fleetId) => ({ fleetId, factionId: 500, state: "IDLE", shipCount: 4, operationId: null });
    const repository = { summarizeStationary: () => ({ ok: true, systems: [{ systemId: SYS, fleets: 2, ships: 8,
      counts: { IDLE: 2 }, byFaction: new Map([[500, { fleets: 2, ships: 8, counts: { IDLE: 2 } }]]),
      lines: [line("p1"), line("p2")] }] }) };
    const base = { repository, clock: { now: () => NOW }, maxSystems: 10, maxLines: 8, refreshMs: 1000 };
    const plain = buildParkedFleetsLayerView({ ...base, store: fakeStore() }).getData();
    const store = fakeStore();
    const data = buildParkedFleetsLayerView({ ...base, store, getCrewSummary: (tx, ids) => {
      assert.strictEqual(tx, store.dbs[0]);
      assert.deepStrictEqual(ids, ["p1", "p2"]);
      return new Map([["p1", { seated: 3, wanted: 4, names: [] }]]);
    } }).getData();
    assert.deepStrictEqual(plain.items[0][3].slice(1), ["p1 - faction 500 - IDLE - 4 ships - op -",
      "p2 - faction 500 - IDLE - 4 ships - op -"]);
    assert.deepStrictEqual(data.items[0][3].slice(1), ["p1 - faction 500 - IDLE - 4 ships - op - - crew 3",
      "p2 - faction 500 - IDLE - 4 ships - op -"]);
    assert.strictEqual(data.key, plain.key);
  });
};
