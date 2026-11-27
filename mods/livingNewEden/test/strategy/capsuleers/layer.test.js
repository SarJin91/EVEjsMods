"use strict";

const assert = require("node:assert");

const { buildCapsuleersLayerView, activityOf, LAYER_ID } = require("../../../lib/strategy/capsuleers/capsuleersLayer");

const CAPS = 500018;
const NOW = 1500;
const CORPS = Object.freeze([{ corporationId: 98000001, name: "Iron Wardens Corp", ticker: "IWC", baseSystemId: 102 }]);

const fleet = (fleetId, extra) => ({ fleetId, factionId: CAPS, corporationId: 98000001, state: "IDLE",
  currentSystemId: 102, route: null, legSeq: 0, composition: [{ hullGroup: "cruiser", count: 1 }], shipCount: 1,
  ...extra });

const FLEETS = Object.freeze([
  fleet("fl_a", { state: "TRAVELLING", currentSystemId: 301, legSeq: 1, route: { v: 1, mode: "travel",
    systems: [301, 302, 303], departAt: 0, jumpMs: 1000, arriveAt: 2000, graphVersion: 1, observed: false } }),
  fleet("fl_b", { composition: [{ hullGroup: "cruiser", count: 2 }], shipCount: 2 }),
  fleet("fl_c", { corporationId: 98000002, composition: [{ hullGroup: "destroyer", count: 3 }], shipCount: 3 }),
]);

function harness(opts) {
  const o = opts || {};
  const calls = { list: [], tx: 0, crews: 0 };
  const db = { inTransaction: true };
  const env = { open: true, governor: null };
  const store = {
    isOpen: () => env.open,
    transaction: (name, fn) => {
      calls.tx += 1;
      assert.strictEqual(name, "observer.galaxyCapsuleers");
      return { ok: true, value: fn(db) };
    },
  };
  const all = [...(o.fleets || FLEETS)].sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1));
  const repository = {
    listFleetsByFaction: (tx, factionId, q) => {
      assert.strictEqual(tx, db);
      calls.list.push({ factionId, limit: q.limit, after: q.afterFleetId, dead: q.states.includes("DESTROYED") });
      const rows = all.filter((f) => f.fleetId > (q.afterFleetId || "")).slice(0, q.limit);
      return { ok: true, fleets: rows, nextAfterFleetId: rows.length === q.limit ? rows[rows.length - 1].fleetId : null };
    },
  };
  const view = buildCapsuleersLayerView({ store, repository, clock: { now: () => NOW },
    getGovernor: () => env.governor, listCorps: () => CORPS, listTrips: () => o.trips || [],
    listContracts: () => o.contracts || [],
    getCrewSummary: (tx, ids) => {
      assert.strictEqual(tx, db);
      calls.crews += 1;
      return new Map(ids.filter((id) => id === "fl_b").map((id) => [id, { seated: 4, names: ["Ann", "Bob"] }]));
    },
    telemetry: null, nowMs: () => 0, maxFleets: o.maxFleets === undefined ? 256 : o.maxFleets, maxLines: 6,
    refreshMs: 1000, ...("getHighsecLife" in o ? { getHighsecLife: o.getHighsecLife, civilianNames: 5 } : {}) });
  return { view, calls, env };
}

module.exports = ({ test }) => {
  test("L1 layer-capsuleers aggregation: in-flight fleet at the middle system, pilots = seated vs shipCount, combat "
    + "beats ratting, corp / composition / activity line + pilots line, 5th element null", () => {
    const h = harness({
      trips: [{ fleetId: "fl_b", kind: "rat", state: "RATTING", targetSystemId: 30002813 }],
      contracts: [{ fleetId: "fl_c", kind: "DEFENSE", state: "ON_STATION", targetSystemId: 102 }],
    });
    assert.strictEqual(LAYER_ID, "layer-capsuleers");
    assert.deepStrictEqual([h.view.title, h.view.listed, h.view.mapLayer], ["Wolni piloci", false,
      { kind: "marks", order: 9 }]);
    const data = h.view.getData();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    assert.deepStrictEqual(data.items, [
      [102, "combat", "7", ["7 pilots · 2 fleets", "corp 98000002 · 3x destroyer · contract ON_STATION",
        "Iron Wardens Corp [IWC] · 2x cruiser · ratting -> 30002813", "pilots: Ann, Bob +2"], null],
      [302, "travel", "1", ["1 pilots · 1 fleets", "Iron Wardens Corp [IWC] · 1x cruiser · TRAVELLING"], null],
    ]);
    assert.strictEqual(data.note, "8 pilots in 2 systems (3 fleets)");
    assert.deepStrictEqual([data.key, h.view.cacheKey(), h.calls.tx, h.calls.crews], ["c1", "c1", 1, 1]);
    assert.deepStrictEqual(h.calls.list[0], { factionId: CAPS, limit: 256, after: "", dead: false });
    assert.ok(data.legend.every((l) => l[3] === "pip"), JSON.stringify(data.legend));
  });

  test("L2 layer-capsuleers empty: no fleets -> items [] and a zero note; maxFleets 0 -> no repository call", () => {
    const empty = harness({ fleets: [] });
    const data = empty.view.getData();
    assert.deepStrictEqual([data.available, data.items, data.note], [true, [], "0 pilots in 0 systems (0 fleets)"]);
    assert.strictEqual(empty.calls.crews, 0);
    const zero = harness({ maxFleets: 0 });
    const z = zero.view.getData();
    assert.deepStrictEqual([z.available, z.items, zero.calls.list.length, zero.calls.tx], [true, [], 0, 0]);
  });

  test("L3 layer-capsuleers refusals are never cached: STORE_CLOSED, GOVERNOR_HOLD (MAINTENANCE)", () => {
    const h = harness();
    h.env.open = false;
    assert.deepStrictEqual([h.view.getData(), h.view.cacheKey()], [{ available: false, reason: "STORE_CLOSED" },
      null]);
    h.env.open = true;
    const asked = [];
    h.env.governor = { admits: (cls) => {
      asked.push(cls);
      return false;
    } };
    assert.deepStrictEqual([h.view.getData(), h.view.cacheKey()], [{ available: false, reason: "GOVERNOR_HOLD" },
      null]);
    assert.deepStrictEqual([asked[0], h.calls.tx], ["MAINTENANCE", 0]);
  });

  test("L4 layer-capsuleers truncation (maxFleets 2 of 3) and a closed trip (DOCKED) leaves IDLE as base", () => {
    const h = harness({ maxFleets: 2, trips: [{ fleetId: "fl_b", kind: "rat", state: "DOCKED",
      targetSystemId: 30002813 }] });
    const data = h.view.getData();
    assert.strictEqual(data.note, "5 pilots in 2 systems (2 fleets) (truncated)");
    assert.deepStrictEqual(h.calls.list.map((c) => [c.limit, c.after]), [[2, ""], [1, "fl_b"]]);
    const b = data.items.find((i) => i[0] === 102);
    assert.deepStrictEqual([b[1], b[3][1]], ["base", "Iron Wardens Corp [IWC] · 2x cruiser · IDLE"]);
    assert.deepStrictEqual(activityOf({ state: "IDLE" }, { kind: "rat", state: "DOCKED" }, null),
      { style: "base", text: "IDLE" });
  });

  test("L6 civilians merged: a fleet system keeps its style, label = sum, civilian line last; a civilian-only system "
    + "gets style civilian and the sort follows the sum; legend row and note suffix", () => {
    const seen = [];
    const hs = { listCivilianRoster: (opts) => {
      seen.push(opts);
      return { ok: true, atMs: 1, systems: [{ systemId: 302, count: 8, names: ["X", "Y"] },
        { systemId: 401, count: 2, names: ["A", "B"] }] };
    } };
    const plain = harness().view.getData();
    const data = harness({ getHighsecLife: () => hs }).view.getData();
    assert.deepStrictEqual(seen, [{ maxNames: 5 }]);
    assert.deepStrictEqual(data.items.map((i) => [i[0], i[1], i[2], i[4]]), [[302, "travel", "9", null],
      [102, "base", "7", null], [401, "civilian", "2", null]]);
    assert.deepStrictEqual(data.items[0][3], ["1 pilots · 1 fleets", "Iron Wardens Corp [IWC] · 1x cruiser · TRAVELLING",
      "8 civilians: X, Y +6"]);
    assert.deepStrictEqual(data.items[1], plain.items.find((i) => i[0] === 102));
    assert.deepStrictEqual(data.items[2][3], ["2 civilians", "2 civilians: A, B"]);
    assert.deepStrictEqual(data.legend, [...plain.legend, ["civilian", "highsec civilians", "#9fb3c8", "pip"]]);
    assert.strictEqual(data.note, "8 pilots in 2 systems (3 fleets) · 10 civilians in 2 systems");
  });

  test("L7 highsecLife off: null / stub ok:false / throw -> items, legend and note as without getHighsecLife", () => {
    const plain = harness().view.getData();
    const pick = (d) => [d.items, d.legend, d.note];
    for (const getHighsecLife of [() => null, () => ({ listCivilianRoster: () => ({ ok: false, reason: "X" }) }),
      () => {
        throw new Error("boom");
      }, () => ({ listCivilianRoster: () => {
        throw new Error("boom");
      } })]) {
      assert.deepStrictEqual(pick(harness({ getHighsecLife }).view.getData()), pick(plain));
    }
  });
};
