"use strict";

const assert = require("node:assert");

module.exports = ({ test, skip }) => {
  test("huntsLayer: exports expected symbols", () => {
    const mod = require("../../lib/observer/views/huntsLayer");
    assert.strictEqual(mod.LAYER_ID, "layer-hunts");
    assert.strictEqual(mod.LAYER_ORDER, 18);
    assert.strictEqual(mod.MARK_KIND, "marks");
    assert.ok(typeof mod.buildHuntsLayerView === "function");
  });

  test("huntsPanel: exports expected symbols", () => {
    const mod = require("../../lib/observer/views/huntsPanel");
    assert.strictEqual(mod.PANEL_ID, "hunts");
    assert.ok(typeof mod.buildHuntsPanelView === "function");
  });

  test("huntsLayer view definition has correct structure", () => {
    const { buildHuntsLayerView } = require("../../lib/observer/views/huntsLayer");
    const mockDeps = {
      store: { isOpen: () => true },
      repository: {},
      getStaticView: () => ({ cacheKey: () => "static-key", getData: () => ({ available: true, systems: { id: [], x: [], y: [] } }) }),
      config: { observer: { galaxyEnabled: true } },
      factionNames: new Map([[500019, "Test Faction"]]),
      getGovernor: () => ({ admits: () => true }),
      telemetry: { observe: () => {}, count: () => {} },
      clock: { now: () => 1000000 },
      nowMs: () => Date.now(),
      settings: { maxSystems: 1000, refreshMs: 15000 },
    };
    const view = buildHuntsLayerView(mockDeps);
    assert.strictEqual(view.title, "Hunters & Pins");
    assert.strictEqual(view.listed, false);
    assert.ok(view.mapLayer);
    assert.strictEqual(view.mapLayer.kind, "marks");
    assert.strictEqual(view.mapLayer.order, 18);
    assert.strictEqual(view.mapLayer.shape, "versus");
    assert.ok(typeof view.cacheKey === "function");
    assert.ok(typeof view.getData === "function");
  });

  test("huntsPanel view definition has correct structure", () => {
    const { buildHuntsPanelView } = require("../../lib/observer/views/huntsPanel");
    const mockDeps = {
      store: { isOpen: () => true },
      repository: {},
      config: { hunt: { enabled: true, maxActivePinsPerFaction: 2, maxActivePins: 64, maxHuntersPerFaction: 2 } },
      factionNames: new Map([[500019, "Test Faction"]]),
      getGovernor: () => ({ admits: () => true }),
      telemetry: { observe: () => {}, count: () => {} },
      clock: { now: () => 1000000 },
      nowMs: () => Date.now(),
      settings: { maxRows: 100, refreshMs: 15000 },
    };
    const view = buildHuntsPanelView(mockDeps);
    assert.strictEqual(view.title, "Hunters & Pins");
    assert.strictEqual(view.listed, true);
    assert.strictEqual(view.order, 90);
    assert.ok(typeof view.cacheKey === "function");
    assert.ok(typeof view.getData === "function");
  });

  const H = require("../battle/settlement.test").harness;
  const driver = H.loadDriver();
  const th5 = "TH5 hunt views: panel hunts and layer-hunts read a pin on a migrated store";
  if (!driver.ok) {
    skip(th5, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(th5, () => H.withStore(driver, async (reopen) => {
    const { createPinRepository } = require("../../lib/strategy/hunt/pinRepository");
    const { buildHuntsPanelView } = require("../../lib/observer/views/huntsPanel");
    const { buildHuntsLayerView } = require("../../lib/observer/views/huntsLayer");
    const store = reopen().store;
    const at = H.START_MS;
    const w = store.transaction("test", (db) => createPinRepository().createPin(db, { pinId: "hp_test_1",
      idempotencyKey: "test:pin", factionId: H.FACTION_A, hunterFleetId: "fleet_h", systemId: H.S.N6,
      targetFleetId: "fleet_t", targetFactionId: H.FACTION_B, strikeOperationId: "op_s", strikeFleetId: "fleet_s",
      pinnedAt: at, untilAt: at + 60000, detail: { strikeLegSeq: 1 } }));
    assert.ok(w.ok && w.value.ok, JSON.stringify(w));
    const common = { store, repository: null, config: { hunt: {} }, factionNames: new Map(), getGovernor: () => null,
      telemetry: null, clock: { now: () => at + 1000 }, nowMs: () => 0 };
    const panel = buildHuntsPanelView({ ...common, settings: { maxRows: 10, refreshMs: 1000 } }).getData();
    assert.strictEqual(panel.available, true, JSON.stringify(panel));
    assert.deepStrictEqual(panel.pins.map((p) => [p.pinId, p.hunterFactionId, p.targetFactionId]),
      [["hp_test_1", H.FACTION_A, H.FACTION_B]]);
    const staticView = { cacheKey: () => "s1", getData: () => ({ available: true, systems: { id: [H.S.N6], x: [1],
      y: [1] } }) };
    const layer = buildHuntsLayerView({ ...common, getStaticView: () => staticView,
      settings: { maxSystems: 10, refreshMs: 1000 } }).getData();
    assert.strictEqual(layer.available, true, JSON.stringify(layer));
    assert.ok(layer.details.some(([sys, lines]) => sys === H.S.N6 && lines.includes("Pin ID: hp_test_1")),
      JSON.stringify(layer.details));
  }));

  test("TH6 observer registration: hunts, layer-hunts, layer-sov-projection read the persistence store",
    () => H.withStore(driver, async (reopen) => {
      const path = require("node:path");
      const { resolveConfig } = require("../../config");
      const { createViewRegistry } = require("../../lib/observer/views");
      const { startObserver } = require("../../lib/observer");
      const persistence = reopen();
      const at = H.START_MS;
      const views = createViewRegistry();
      const staticReg = views.registerView("galaxy-static", { title: "static", listed: false,
        cacheKey: () => "s1", getData: () => ({ available: true, systems: { id: [H.S.N6], x: [1], y: [1] } }) });
      assert.ok(staticReg.ok, JSON.stringify(staticReg));
      const httpApi = { createServer: () => ({ on() {}, listen() {}, unref() {}, close() {} }) };
      const base = resolveConfig({ modDir: path.join(__dirname, "..", ".."), env: {} }).config;
      const config = { ...base, observer: { ...base.observer, enabled: true, galaxyEnabled: true,
        sovProjectionEnabled: true } };
      const ctx = { modVersion: "t", state: {}, persistence, world: { repository: {} },
        strategy: { getStatus: () => ({}) }, clock: { now: () => at }, nowMs: () => 0 };
      const started = startObserver({ config, ctx, views, logger: { log() {} }, httpApi });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      try {
        for (const id of ["hunts", "layer-hunts", "layer-sov-projection"]) {
          const view = views.getView(id);
          assert.ok(view, `${id} registered`);
          const data = view.getData();
          assert.strictEqual(data.available, true, `${id}: ${JSON.stringify(data)}`);
        }
      } finally {
        started.observer.stop();
      }
    }));
};