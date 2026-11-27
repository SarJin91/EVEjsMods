"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createViewRegistry } = require("../../lib/observer/views");
const V = require("../../lib/situations/view");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = 7200000;
const MIN = 60000;

function fakeStore(queries) {
  return { isOpen: () => true, transaction: (name, fn) => ({ ok: true, value: fn({ name }) }), queries };
}

const OPEN = Object.freeze([Object.freeze({ situationId: "s1-2", kind: "BELT_RAID", systemId: 10, phase: "FIGHT",
  beltLabel: "Belt 1", anchorLabel: "Belt 1", victims: 2, startedAt: NOW - 5 * MIN, phaseSince: NOW - 2 * MIN,
  deadlineAt: NOW + 8 * MIN })]);
const ENDED = Object.freeze([
  { situationId: "s1-1", kind: "BELT_RAID", systemId: 10, state: "RESCUED", victims: 3, victimsSaved: 2,
    endedAt: NOW - MIN, endReason: "PIRATES_DOWN" },
  { situationId: "s0-9", kind: "BELT_RAID", systemId: 20, state: "ABANDONED", victims: 2, victimsSaved: 0,
    endedAt: NOW - 2 * MIN, endReason: "NO_PLAYER" },
  { situationId: "s0-8", kind: "BELT_RAID", systemId: 30, state: "LOST", victims: 2, victimsSaved: 0,
    endedAt: NOW - 5 * MIN, endReason: "VICTIMS_GONE" },
]);

function depsOf(over) {
  const queries = [];
  const repo = { listEndedSinceInTx: (db, since, limit) => {
    queries.push([db.name, since, limit]);
    return { ok: true, rows: ENDED, truncated: true };
  } };
  return { queries, deps: { store: fakeStore(queries), repo, listOpen: () => OPEN, clock: { now: () => NOW },
    settings: { layerRecentMs: 30 * MIN, layerMaxRows: 100, pollMs: 3000 }, ...(over || {}) } };
}

module.exports = ({ test }) => {
  test("SC1 layer-situations: marks order 23, FIGHT over RESCUED, ABANDONED out, truncated note, one tx, legend "
    + "shapes; panel order 69 listed, GOVERNOR_HOLD", () => {
    const { deps, queries } = depsOf();
    const layer = V.buildSituationsLayer(deps);
    const views = createViewRegistry();
    assert.strictEqual(views.registerView(V.LAYER_ID, layer).ok, true);
    assert.deepStrictEqual([V.LAYER_ID, layer.listed, layer.mapLayer, layer.cacheKey()],
      ["layer-situations", false, { kind: "marks", order: 23 }, `k${Math.floor(NOW / 3000)}`]);
    const data = layer.getData();
    assert.deepStrictEqual(queries, [["observer.situations", NOW - 30 * MIN, 100]]);
    assert.deepStrictEqual(data.items, [
      [10, "fight", "!", ["Distress: Belt 1 (FIGHT, 2 min)", "RESCUED 2/3 (1 min ago)"], null],
      [30, "lost", null, ["LOST 0/2 (5 min ago)"], null]]);
    assert.deepStrictEqual([data.available, data.note], [true, "1 open, 3 ended in 30 min (truncated)"]);
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const pure = sandbox.window.LneGalaxy._pure;
    assert.deepStrictEqual(data.legend.map((l) => [l[0], pure.markShape(l[3])]),
      [["fight", "versus"], ["calling", "diamond"], ["rescued", "triangle"], ["lost", "ring"]]);

    const names = { 10: "Jita", 30: "Perimeter" };
    const panel = V.buildSituationsPanel({ ...deps, systemNameOf: (id) => names[id] || null,
      getStatus: () => ({ counters: { rescued: 1 }, payouts: { pending: 0 } }) });
    assert.strictEqual(views.registerView(V.VIEW_ID, panel).ok, true);
    assert.deepStrictEqual([V.VIEW_ID, panel.order, panel.listed, panel.title], ["situations", 69, true, "Situations"]);
    const p = panel.getData();
    assert.deepStrictEqual(p.open, [{ situationId: "s1-2", kind: "BELT_RAID", system: "Jita", systemId: 10,
      phase: "FIGHT", anchor: "Belt 1", victims: 2, ageS: 300 }]);
    assert.deepStrictEqual(p.recent.map((r) => [r.situationId, r.system, r.state, r.saved]), [
      ["s1-1", "Jita", "RESCUED", 2], ["s0-9", null, "ABANDONED", 0], ["s0-8", "Perimeter", "LOST", 0]]);
    assert.deepStrictEqual([p.truncated, p.counters, p.payouts, p.generatedAt], [true, { rescued: 1 },
      { pending: 0 }, NOW]);
    const hold = V.buildSituationsPanel({ ...deps, getGovernor: () => ({ admits: () => false }) });
    assert.deepStrictEqual([hold.getData(), hold.cacheKey()], [{ available: false, reason: "GOVERNOR_HOLD" }, null]);
  });
};
