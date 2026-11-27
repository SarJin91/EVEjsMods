"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { buildHeavyEventsView, ROW_KEYS } = require("../../lib/heavyEvents/view");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30002001;
const PIRATE = 500010;
const EMPIRE = 500001;

const _graph = Object.freeze({
  getGraph: () => ({ ok: true, graph: { getSystem: (id) => id === SYS ? { systemId: id, name: `S-${SYS}`, regionId: 10000001 } : null } }),
  getSystem: (id) => id === SYS ? { systemId: id, name: `S-${SYS}`, regionId: 10000001 } : null,
});

const CONFIG = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config;

function env(opened) {
  const store = opened.store;
  const clock = createManualClock(T0);
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const heavy = createHeavyEventRepository({ journal });
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const planHeavy = (eventId, eventType, tier, factionId, beneficiaryFactionId) => tx((db) => {
    const r = heavy.planInTx(db, { eventId, planKey: `1:${eventId}`, eventType, tier, systemId: SYS, factionId,
      beneficiaryFactionId, stationId: "st:1", funded: false, integrity: null, seed: 1, at: T0, expiresAt: T0 + 1000,
      dueAt: null, members: [{ key: "p1:0", phase: 1, step: null, hullGroup: "cruiser", state: "RESERVED" }] });
    assert.ok(r.ok, JSON.stringify(r));
  });
  const planPower = (eventId, eventType, tier, variant, affix, pocket, factionId, beneficiaryFactionId) => tx((db) => {
    const r = heavy.planInTx(db, { eventId, planKey: `1:${eventId}`, eventType, tier, systemId: SYS, factionId,
      beneficiaryFactionId, stationId: "st:1", funded: false, integrity: null, seed: 1, at: T0, expiresAt: T0 + 1000,
      dueAt: null, members: [{ key: "p1:0", phase: 1, step: null, hullGroup: "cruiser", state: "RESERVED" }],
      variant, affix, pocket });
    assert.ok(r.ok, JSON.stringify(r));
  });
  return { store, tx, heavy, planHeavy, planPower };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("OB1-OB2 heavy events view power", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("OB1 panel heavy-events: power row has layer, variant, affix, pocket, pocketCount, beaconVisibility, signalStrength", () => withStore(
    driver, (opened) => {
      const e = env(opened);
      e.planPower("hpw:1:0", "outpost", 1, "brawl", "reinforced", 0, PIRATE, null);
      e.planHeavy("hev:1:0", "redoubt", 1, PIRATE, null);

      const view = buildHeavyEventsView({
        store: e.store,
        repository: e.heavy,
        maxEnded: 20,
        graph: _graph,
        factionNames: new Map([[PIRATE, "Red Cutthroats"]]),
        config: CONFIG,
      });

      const dataAll = view.getData({ query: new URLSearchParams() });
      assert.strictEqual(dataAll.available, true, JSON.stringify(dataAll));
      const powerRows = dataAll.open.filter((r) => r.layer === "power");
      const heavyRows = dataAll.open.filter((r) => r.layer === "heavy");
      assert.strictEqual(powerRows.length, 1, "one power row");
      assert.strictEqual(heavyRows.length, 1, "one heavy row");

      const prow = powerRows[0];
      assert.strictEqual(prow.layer, "power", "layer is power");
      assert.strictEqual(prow.variant, "brawl", "variant is brawl");
      assert.strictEqual(prow.affix, "reinforced", "affix is reinforced");
      assert.strictEqual(prow.pocket, 0, "pocket is 0");
      assert.ok(typeof prow.pocketCount === "number" && prow.pocketCount > 0, "pocketCount > 0");
      assert.ok(prow.beaconVisibility === "anomaly" || prow.beaconVisibility === "signature", "beaconVisibility is anomaly or signature");
      assert.ok(typeof prow.signalStrength === "string" && prow.signalStrength.length > 0, "signalStrength is non-empty string");

      const hrow = heavyRows[0];
      assert.strictEqual(hrow.layer, "heavy", "layer is heavy");
      assert.strictEqual(hrow.variant, null, "variant is null for heavy");
      assert.strictEqual(hrow.affix, null, "affix is null for heavy");
      assert.strictEqual(hrow.pocket, 0, "pocket is 0 for heavy");
      assert.strictEqual(hrow.pocketCount, null, "pocketCount is null for heavy");
      assert.strictEqual(hrow.beaconVisibility, null, "beaconVisibility is null for heavy");
      assert.strictEqual(hrow.signalStrength, null, "signalStrength is null for heavy");

      const expectedKeys = [...ROW_KEYS];
      assert.deepStrictEqual(Object.keys(prow).sort(), expectedKeys.sort(), "ROW_KEYS matches row keys");
    }));

  test("OB2 panel heavy-events: filter layer=power skips heavy, layer=heavy skips power", () => withStore(
    driver, (opened) => {
      const e = env(opened);
      e.planPower("hpw:1:0", "outpost", 1, "brawl", "reinforced", 0, PIRATE, null);
      e.planPower("hpw:1:1", "cache", 2, "guard", "rich", 1, EMPIRE, PIRATE);
      e.planHeavy("hev:1:0", "redoubt", 1, PIRATE, null);
      e.planHeavy("hev:1:1", "defense", 3, EMPIRE, PIRATE);

      const view = buildHeavyEventsView({
        store: e.store,
        repository: e.heavy,
        maxEnded: 20,
        graph: _graph,
        factionNames: new Map([[PIRATE, "Red Cutthroats"], [EMPIRE, "Amarr Empire"]]),
        config: CONFIG,
      });

      const dataPower = view.getData({ query: new URLSearchParams("layer=power") });
      assert.strictEqual(dataPower.available, true);
      assert.strictEqual(dataPower.layerFilter, "power");
      assert.ok(dataPower.open.every((r) => r.layer === "power"), "all open rows are power");
      assert.ok(dataPower.ended.every((r) => r.layer === "power"), "all ended rows are power");
      assert.strictEqual(dataPower.open.length, 2, "two power rows");
      assert.strictEqual(dataPower.ended.length, 0, "no ended rows");

      const dataHeavy = view.getData({ query: new URLSearchParams("layer=heavy") });
      assert.strictEqual(dataHeavy.available, true);
      assert.strictEqual(dataHeavy.layerFilter, "heavy");
      assert.ok(dataHeavy.open.every((r) => r.layer === "heavy"), "all open rows are heavy");
      assert.ok(dataHeavy.ended.every((r) => r.layer === "heavy"), "all ended rows are heavy");
      assert.strictEqual(dataHeavy.open.length, 2, "two heavy rows");
      assert.strictEqual(dataHeavy.ended.length, 0, "no ended rows");

      const dataAll = view.getData({ query: new URLSearchParams() });
      assert.strictEqual(dataAll.layerFilter, null);
      assert.strictEqual(dataAll.open.length, 4, "four rows total");
    }));

  test("OB2 cacheKey differs by layer filter", () => withStore(driver, (opened) => {
    const e = env(opened);
    e.planPower("hpw:1:0", "outpost", 1, "brawl", "reinforced", 0, PIRATE, null);
    e.planHeavy("hev:1:0", "redoubt", 1, PIRATE, null);

    const view = buildHeavyEventsView({
      store: e.store,
      repository: e.heavy,
      maxEnded: 20,
      graph: _graph,
      factionNames: new Map([[PIRATE, "Red Cutthroats"]]),
      config: CONFIG,
    });

    const keyAll = view.cacheKey({ query: new URLSearchParams() });
    const keyPower = view.cacheKey({ query: new URLSearchParams("layer=power") });
    const keyHeavy = view.cacheKey({ query: new URLSearchParams("layer=heavy") });
    const keyUnknown = view.cacheKey({ query: new URLSearchParams("layer=unknown") });

    assert.strictEqual(keyAll, "all");
    assert.strictEqual(keyPower, "power");
    assert.strictEqual(keyHeavy, "heavy");
    assert.strictEqual(keyUnknown, "all", "unknown layer falls back to all");
  }));

  test("OB3 panel heavy-events?layer=world: only world rows with the kind, signature beacon, weak signal; cacheKey "
    + "world; keys = ROW_KEYS", () => withStore(driver, (opened) => {
    const e = env(opened);
    e.planPower("hwa:1:0", "hunt", 1, "hideout", "none", 0, PIRATE, null);
    e.planPower("hpw:1:0", "outpost", 1, "brawl", "reinforced", 0, PIRATE, null);
    e.planHeavy("hev:1:0", "redoubt", 1, PIRATE, null);
    const view = buildHeavyEventsView({ store: e.store, repository: e.heavy, maxEnded: 20, graph: _graph,
      factionNames: new Map([[PIRATE, "Red Cutthroats"]]), config: CONFIG });
    const req = { query: new URLSearchParams("layer=world") };
    const data = view.getData(req);
    assert.strictEqual(data.available, true, JSON.stringify(data));
    assert.strictEqual(data.layerFilter, "world");
    assert.deepStrictEqual(data.open.map((r) => [r.eventId, r.layer, r.variant, r.beaconVisibility, r.signalStrength]),
      [["hwa:1:0", "world", "hideout", "signature", "weak"]]);
    assert.deepStrictEqual(Object.keys(data.open[0]).sort(), [...ROW_KEYS].sort());
    assert.strictEqual(view.cacheKey(req), "world");
  }));
};