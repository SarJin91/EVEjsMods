"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const S = require("../../lib/heavyEvents/schema");
const { membersOf, maxComposition } = require("../../lib/heavyEvents/catalog");
const { chooseCandidate } = require("../../lib/heavyEvents/candidates");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { fixedItemsOf } = require("../../lib/heavyEvents/reward");
const { createRng } = require("../../lib/util/rng");
const { FIXED_ITEMS_MAX } = require("../../lib/adapter/nativeWrecks");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:6";
const EVENT = "hev:6:0";
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

module.exports = ({ test, skip }) => {
  test("HF2 foundry candidate: few minerals -> NO_MINERALS, enough -> foundry; DRAIN_MAX_TYPES = FIXED_ITEMS_MAX", () => {
    const cfg = { ...BASE.heavyEvents, redoubtEnabled: false, defenseEnabled: false };
    const big = Object.fromEntries(HULL_GROUPS.map((name) => [name, 99]));
    const factsWith = (mineralUnits) => ({ now: NOW, open: [], lastEndedAt: new Map(), systems: [{ systemId: SYS,
      band: "nullsec", controllerFactionId: PIRATE, controllerKind: "pirate", occupation: null,
      stations: [{ stationId: STATION, factionId: PIRATE, state: "ONLINE", hullStock: big, mineralUnits }] }] });
    assert.deepStrictEqual(chooseCandidate(factsWith(cfg.foundryMinMineralUnits - 1), cfg, createRng(3)),
      { ok: false, reason: "NO_MINERALS" });
    const ok = chooseCandidate(factsWith(cfg.foundryMinMineralUnits), cfg, createRng(3));
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.deepStrictEqual([ok.candidate.eventType, ok.candidate.stationId, ok.candidate.funded],
      ["foundry", STATION, true]);
    assert.ok(maxComposition("foundry", ok.candidate.tier, cfg.maxUpscaleSteps).ok);
    assert.strictEqual(S.DRAIN_MAX_TYPES, FIXED_ITEMS_MAX);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("HF1 heavy events foundry drain", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("HF1 foundry CLEARED: drain permille with the cap once, result_json, repeated step = duplicate, chest share",
    () => {
      withStore(driver, ({ store }) => {
        const settings = { ...BASE.heavyEvents, enabled: true, foundryDrainPermille: 200, foundryDrainMaxUnits: 250000,
          foundryLootSharePermille: 50, foundryLootMaxUnitsPerType: 2000 };
        const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
        const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
          limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
            maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
        const mineral = (typeId, delta) => ({ itemKind: "mineral", itemKey: `type:${typeId}`, delta });
        run(store, (tx) => {
          assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
            systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "fd:st").ok);
          assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "fd:stock", reason: "seed", at: NOW,
            deltas: [mineral(34, 1000000), mineral(35, 400000), mineral(36, 50000)] }).ok);
        });
        const repo = createHeavyEventRepository({ journal });
        const members = membersOf("foundry", 1, settings.maxUpscaleSteps).members;
        run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: EVENT, planKey: `1:${EVENT}`, eventType: "foundry",
          tier: 1, systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members,
          funded: false, integrity: null, seed: 1, at: NOW, expiresAt: NOW + settings.plannedTtlMs, dueAt: null }).ok));
        const engaged = run(store, (tx) => {
          const r0 = repo.getInTx(tx, EVENT).row;
          const moved = repo.transitionInTx(tx, { eventId: EVENT, expectedVersion: r0.version, from: "PLANNED",
            to: "ENGAGED", patch: { engagedAt: NOW, phase: 1 }, at: NOW });
          assert.ok(moved.ok, JSON.stringify(moved));
          return moved.row;
        });
        const stationsCtx = { getMode: () => "ready", repository: stations };
        const live = createLive({ store, repo, settings, getStations: () => stationsCtx, getSites: () => null,
          getPresence: () => null, getSeam: () => null, getOccupation: () => null, admits: () => true },
        { bump() {}, refuse() {} });
        const minerals = () => Object.fromEntries(run(store, (tx) => stations.getStock(tx, STATION)).items
          .filter((i) => i.itemKind === "mineral").map((i) => [i.itemKey, i.quantity]));

        const first = run(store, (tx) => live.clearInTx(tx, engaged, NOW + 1000));
        assert.deepStrictEqual([first.duplicate, first.drain.outcome, first.drain.units, first.drain.total],
          [false, "APPLIED", { 34: 200000, 35: 50000 }, 250000]);
        assert.deepStrictEqual(minerals(), { "type:34": 800000, "type:35": 350000, "type:36": 50000 });
        const row = run(store, (tx) => repo.getInTx(tx, EVENT).row);
        assert.deepStrictEqual([row.state, row.result.drain.units], ["CLEARED", { 34: 200000, 35: 50000 }]);
        const again = run(store, (tx) => live.clearInTx(tx, engaged, NOW + 2000));
        assert.deepStrictEqual([again.duplicate, again.drain], [true, null]);
        assert.deepStrictEqual(minerals(), { "type:34": 800000, "type:35": 350000, "type:36": 50000 });
        assert.deepStrictEqual(fixedItemsOf(row, settings), [{ typeId: 34, quantity: 2000 },
          { typeId: 35, quantity: 2000 }]);
        assert.deepStrictEqual(fixedItemsOf(row, { ...settings, foundryLootMaxUnitsPerType: 1000000 }),
          [{ typeId: 34, quantity: 10000 }, { typeId: 35, quantity: 2500 }]);
      });
    });
};
