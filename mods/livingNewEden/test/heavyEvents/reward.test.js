"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { hullDeltas } = require("../../lib/stations/stockKeys");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const S = require("../../lib/heavyEvents/schema");
const { membersOf } = require("../../lib/heavyEvents/catalog");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createReward, chestSpecOf, dayOf } = require("../../lib/heavyEvents/reward");
const { endInTx } = require("../../lib/heavyEvents/planner");
const { validatePlaceSpec } = require("../../lib/adapter/nativeWrecks");
const { buildRewardLootTable } = require("../../lib/adapter/rewardLoot");
const { LOOT_TABLES } = require("../../lib/events/salvage/data");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:1";

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const settingsOf = (over) => ({ ...BASE.heavyEvents, enabled: true, ...(over || {}) });

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeWrecks() {
  return { ok: true, scene: true, places: [], wrecks: new Map(),
    readGrid() {
      return { ok: true, sceneLoaded: this.scene };
    },
    place(spec) {
      this.places.push(spec);
      if (this.wrecks.has(spec.anomalyId)) {
        return { ok: true, adopted: true, wreckId: this.wrecks.get(spec.anomalyId), items: 3, factionItems: 0,
          vendorWrites: 0 };
      }
      this.wrecks.set(spec.anomalyId, 700 + this.wrecks.size);
      return { ok: true, adopted: false, wreckId: this.wrecks.get(spec.anomalyId), items: 3, factionItems: 1,
        vendorWrites: 2 };
    },
    flush() {} };
}

function harness(store, over) {
  const base = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  let crashMarks = 0;
  const journal = { findByKey: (...a) => base.findByKey(...a), countKeyRange: (...a) => base.countKeyRange(...a),
    applyOnce(tx, entry, fn) {
      if (crashMarks > 0 && entry.key.startsWith(`${S.REWARD_KEY_PREFIX}:`)) {
        crashMarks -= 1;
        throw new Error("crash between place and mark");
      }
      return base.applyOnce(tx, entry, fn);
    } };
  const stations = createStationRepository({ journal: base, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "hevt:stock", reason: "seed", at: NOW,
      deltas: hullDeltas([{ hullGroup: "cruiser", count: 1 }], 1).deltas }).ok);
  });
  const repo = createHeavyEventRepository({ journal: base });
  const settings = settingsOf(over);
  const wrecks = fakeWrecks();
  const sites = { cleaned: [],
    listSitesByEvent: (eventId) => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", siteKey: `lne:${eventId}`,
      position: { x: 1, y: 2, z: 3 } }] }),
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.cleaned.push([eventId, reason]);
      return { ok: true };
    } };
  const counters = {};
  const hooks = { bump: (name, n = 1) => {
    assert.ok(S.COUNTER_NAMES.includes(name), `counter ${name} not in COUNTER_NAMES`);
    counters[name] = (counters[name] || 0) + n;
  }, refuse: () => {} };
  const stationsCtx = { getMode: () => "ready", repository: stations };
  const env = { store, repo, journal, settings, eventRewards: BASE.eventRewards,
    fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId, getSites: () => sites,
    getStations: () => stationsCtx, getWrecks: () => wrecks, admits: () => true };
  const reward = createReward(env, hooks);

  function cleared(eventId, opts = {}) {
    const members = membersOf("redoubt", 1, settings.maxUpscaleSteps).members;
    run(store, (tx) => {
      assert.ok(repo.planInTx(tx, { eventId, planKey: `1:${eventId}`, eventType: "redoubt", tier: 1, systemId: SYS,
        factionId: opts.factionId || PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
        integrity: null, seed: 1, at: NOW, expiresAt: NOW + settings.plannedTtlMs, dueAt: null }).ok);
      let row = repo.getInTx(tx, eventId).row;
      const ended = row.members.map((m) => (m.phase === 1 ? { ...m, state: opts.noLosses ? "UNSPAWNABLE" : "DESTROYED" }
        : m));
      row = repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "PLANNED", to: "ENGAGED", at: NOW,
        patch: { phase: 1, scaleSteps: opts.steps || 0, engagedAt: NOW, members: ended } }).row;
      assert.ok(repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "ENGAGED", to: "CLEARED", at: NOW,
        patch: { rewardState: "PENDING", dueAt: NOW + settings.rewardWaitMs }, reason: "CLEARED" }).ok);
    });
  }
  const row = (id) => run(store, (tx) => repo.getInTx(tx, id).row);
  const keysOfDay = () => run(store, (tx) => {
    const range = S.rewardDayRangeOf(dayOf(NOW));
    return base.countKeyRange(tx, range.from, range.to, 100).count;
  });
  const hulls = () => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
  return { reward, wrecks, sites, counters, row, keysOfDay, hulls, cleared, settings, env, base,
    crash: (n) => { crashMarks = n; } };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("RW1-RW4 heavy events reward", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("RW1 place -> mark exactly once, COMPLETED PLACED, beacon released at cleanup_at", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.cleared("hev:1:0", { steps: 2 });
      const at = NOW + 1000;
      h.reward.pass(at);
      let r = h.row("hev:1:0");
      assert.deepStrictEqual([r.state, r.rewardState, r.open, r.cleanupAt, r.endedAt],
        ["COMPLETED", "PLACED", true, at + h.settings.aftermathMs, at]);
      assert.strictEqual(h.wrecks.places.length, 1);
      const spec = h.wrecks.places[0];
      assert.deepStrictEqual([spec.anomalyId, spec.slot, spec.siteKey, spec.hullGroup, spec.adopt, spec.lootRolls,
        spec.expiresAtMs, spec.rewardLoot.id, spec.rewardLoot.sizeBand, spec.lootTableId],
      ["hev:1:0", 0, "lne:hev:1:0", "battleship", true, 4 + 2 * h.settings.rollsPerUpscaleStep,
        at + h.settings.aftermathMs, "redoubt_500010", "large", undefined]);
      assert.strictEqual(Math.round(Math.hypot(spec.offset.x, spec.offset.z) / 10),
        Math.round(BASE.eventRewards.cacheOffsetM / 10));
      assert.strictEqual(h.keysOfDay(), 1);
      h.reward.pass(at + 1000);
      assert.deepStrictEqual([h.wrecks.places.length, h.keysOfDay(), h.counters["reward.placed"]], [1, 1, 1]);
      h.reward.pass(at + h.settings.aftermathMs);
      r = h.row("hev:1:0");
      assert.deepStrictEqual([r.open, r.siteReleased, h.sites.cleaned], [false, true, [["hev:1:0", "EVENT_END"]]]);
      assert.strictEqual(h.counters.errors, undefined);
    });
  });

  test("RW2 crash between place and mark: the retry adopts the wreck, one reward key", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.cleared("hev:2:0");
      h.crash(1);
      h.reward.pass(NOW + 1000);
      assert.deepStrictEqual([h.row("hev:2:0").state, h.keysOfDay(), h.wrecks.places.length, h.counters.errors],
        ["CLEARED", 0, 1, 1]);
      h.reward.pass(NOW + 2000);
      const r = h.row("hev:2:0");
      assert.deepStrictEqual([r.state, r.rewardState, h.keysOfDay(), h.wrecks.places.length, h.wrecks.wrecks.size],
        ["COMPLETED", "PLACED", 1, 2, 1]);
      assert.strictEqual(h.wrecks.places[1].anomalyId, h.wrecks.places[0].anomalyId);
      assert.strictEqual(h.counters["reward.placed"], 1);
    });
  });

  test("RW3 day cap -> SKIPPED without place; no losses -> SKIPPED; drain of CLEARED never returns hulls again", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { rewardMaxPerDay: 1 });
      run(store, (tx) => assert.ok(h.base.applyOnce(tx, { key: S.rewardKeyOf(dayOf(NOW), 30000999, "hev:0:0"),
        aggregate: { type: S.AGGREGATE, id: "hev:0:0" }, eventType: S.EVENT_REWARD, payload: { eventId: "hev:0:0" } },
      () => ({ ok: true })).ok));
      h.cleared("hev:3:0");
      h.cleared("hev:3:1", { noLosses: true });
      h.cleared("hev:3:2", { noLosses: true });
      const before = h.hulls();
      const clearedRow = h.row("hev:3:2");
      const ended = run(store, (tx) => endInTx(tx, h.env, clearedRow, { to: "COMPLETED", reason: "CLEARED",
        rewardState: "SKIPPED" }, NOW + 500));
      assert.deepStrictEqual([ended.returned, ended.orphaned, h.hulls()], [0, 0, before]);
      assert.strictEqual(run(store, (tx) => h.base.findByKey(tx, S.returnKeyOf("hev:3:2"))).found, false);
      h.reward.pass(NOW + 1000);
      assert.deepStrictEqual([h.row("hev:3:0").state, h.row("hev:3:0").rewardState, h.row("hev:3:1").rewardState],
        ["COMPLETED", "SKIPPED", "SKIPPED"]);
      assert.deepStrictEqual([h.wrecks.places.length, h.keysOfDay(), h.counters["reward.skipped"],
        h.counters["reward.skipped.LIMIT_DAY"], h.counters["reward.skipped.NO_LOSSES"]], [0, 1, 2, 1, 1]);
    });
  });

  test("RW4 a faction without REWARD_FACTIONS gets its vendor table or the fallback; specs pass the adapter check",
    () => {
      const cfg = { settings: settingsOf(), eventRewards: BASE.eventRewards,
        fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId };
      const rowOf = (factionId, tier, steps) => ({ eventId: `hev:4:${factionId}`, eventType: "redoubt", tier,
        scaleSteps: steps, systemId: SYS, factionId, seed: 9, members: [] });
      const site = { siteKey: "lne:site:4" };
      assert.ok(!Object.prototype.hasOwnProperty.call(LOOT_TABLES, 500026));
      const drones = chestSpecOf(rowOf(500025, 1, 0), site, cfg, NOW);
      const other = chestSpecOf(rowOf(500026, 3, 3), site, cfg, NOW);
      const pirate = chestSpecOf(rowOf(PIRATE, 2, 0), site, cfg, NOW);
      assert.deepStrictEqual([drones.spec.lootTableId, drones.spec.rewardLoot, drones.spec.lootRolls],
        [LOOT_TABLES[500025].large, undefined, 4]);
      assert.deepStrictEqual([other.spec.lootTableId, other.spec.rewardLoot, other.spec.lootRolls],
        [BASE.salvageAnomaly.fallbackLootTableId, undefined, BASE.heavyEvents.maxLootRolls]);
      const onCfg = { ...cfg, sizedDefaultLoot: BASE.salvageAnomaly.sizedDefaultLoot };
      assert.strictEqual(onCfg.sizedDefaultLoot, true);
      const otherOn = chestSpecOf(rowOf(500026, 3, 3), site, onCfg, NOW);
      const empireOn = chestSpecOf(rowOf(500001, 1, 0), site, onCfg, NOW);
      const dronesOn = chestSpecOf(rowOf(500025, 1, 0), site, onCfg, NOW);
      assert.deepStrictEqual([otherOn.spec.lootTableId, empireOn.spec.lootTableId, dronesOn.spec.lootTableId],
        ["loot_belt_normal_large", "loot_belt_normal_large", LOOT_TABLES[500025].large]);
      assert.strictEqual(validatePlaceSpec(otherOn.spec), null);
      assert.deepStrictEqual([pirate.spec.lootTableId, pirate.spec.lootRolls], [undefined, 6]);
      assert.strictEqual(buildRewardLootTable(pirate.spec.rewardLoot).ok, true);
      for (const built of [drones, other, pirate]) assert.strictEqual(validatePlaceSpec(built.spec), null);
      const defense = chestSpecOf({ ...rowOf(PIRATE, 1, 0), eventType: "defense" }, site, cfg, NOW);
      assert.deepStrictEqual([defense.profile, defense.spec.rewardLoot.sizeBand, defense.spec.lootRolls],
        ["defense", "medium", 4]);
      assert.deepStrictEqual(chestSpecOf({ ...rowOf(PIRATE, 1, 0), eventType: "unknown" }, site, cfg, NOW),
        { ok: false, reason: "NO_PROFILE" });
    });
};
