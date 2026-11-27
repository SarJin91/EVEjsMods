"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { hullDeltas } = require("../../lib/stations/stockKeys");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const S = require("../../lib/heavyEvents/schema");
const P = require("../../lib/heavyEvents/power/schema");
const PC = require("../../lib/heavyEvents/power/catalog");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createReward, powerRollsOf, cacheDrainInTx, cacheFixedItemsOf, decidePowerReward, powerChestSpecOf } = require("../../lib/heavyEvents/reward");
const { pumpPlanned } = require("../../lib/heavyEvents/planner");
const { validatePlaceSpec } = require("../../lib/adapter/nativeWrecks");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:pw:1";

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const PW_BUCKET = Math.floor(NOW / BASE.powerSites.planIntervalMs);

function configOf(heavyOver, powerOver) {
  const modules = { ...BASE.modules, world: { ...BASE.modules.world, enabled: true },
    sites: { ...BASE.modules.sites, enabled: true } };
  return { ...BASE, enabled: true, modules, heavyEvents: { ...BASE.heavyEvents, ...heavyOver },
    powerSites: { ...BASE.powerSites, ...powerOver } };
}

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
  const h = { now: NOW };
  const clock = { now: () => h.now };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "pwt:st").ok);
    const deltas = hullDeltas([{ hullGroup: "cruiser", count: 50 }], 1).deltas;
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "pwt:stock", reason: "seed", at: NOW,
      deltas: [...deltas, { itemKind: "mineral", itemKey: "type:34", delta: 50000 }] }).ok);
  });
  const sites = { cleaned: [],
    listSitesByEvent: (eventId) => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", siteKey: `lne:${eventId}`,
      position: { x: 1, y: 2, z: 3 } }] }),
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.cleaned.push([eventId, reason]);
      return { ok: true };
    } };
  const occupation = { calls: [],
    dropInfluenceInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push([spec.factionId, spec.points, key]);
      return { ok: true, outcome: "APPLIED", written: true };
    } };
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 },
    stations: { getMode: () => "ready", repository: stations }, sites, occupation,
    world: { repository: { getSystem: (_tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: PIRATE } }) } },
    graph: { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }) },
    presence: { getStatus: () => ({ available: true, stale: false }), isObserved: () => false,
      observedWithin: () => ({ ok: true, systems: [SYS].map((id, i) => [id, i]) }) } };
  const repo = createHeavyEventRepository({ journal });
  const settings = { ...BASE.heavyEvents, enabled: true, ...(over && over.heavy) };
  const power = { ...BASE.powerSites, enabled: true, ...(over && over.power),
    maxWeight: 1000 };
  const eventRewards = { ...BASE.eventRewards, deadspaceModuleWeight: 100, maxWeight: 1000 };
  const wrecks = fakeWrecks();
  const counters = {};
  const hooks = { bump: (name, n = 1) => {
    assert.ok(S.COUNTER_NAMES.includes(name), `counter ${name} not in COUNTER_NAMES`);
    counters[name] = (counters[name] || 0) + n;
  }, refuse: () => {} };
  const stationsCtx = { getMode: () => "ready", repository: stations };
  const admits = () => true;
  const env = { store, repo, journal, settings, power, eventRewards,
    fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId, getSites: () => sites,
    getStations: () => stationsCtx, getWrecks: () => wrecks, admits };
  const reward = createReward(env, hooks);
  const live = createLive({ ...env,
    getSeam: () => ({ ok: true, seam: { alive: new Set(), spawns: [], nextId: 100,
      readGrid: () => ({ ok: true, players: [{ characterId: 1, entityId: 1 }], copies: 0 }),
      spawnPhase(_sys, input) {
        this.spawns.push(input.members.map((m) => m.memberKey));
        return { ok: true, unspawnable: [], spawned: input.members.map((m) => {
          const entityId = this.nextId++;
          this.alive.add(entityId);
          return { memberKey: m.memberKey, entityId, hullGroup: m.hullGroup };
        }) };
      },
      readMembers(_sys, ids) {
        return { ok: true, live: ids.filter((i) => this.alive.has(i)).map((entityId) => ({ entityId, position: null })),
          gone: ids.filter((i) => !this.alive.has(i)) };
      },
      despawn(_sys, ids) {
        for (const i of ids) this.alive.delete(i);
        return { ok: true };
      } } }),
    getOccupation: () => occupation,
    payoutRepo: null, admits }, hooks);
  const hulls = () => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
  const row = (id) => run(store, (tx) => repo.getInTx(tx, id).row);
  const keysOfDay = (prefix) => run(store, (tx) => {
    const range = prefix === "hpwrwd" ? P.rewardDayRangeOf(Math.floor(NOW / 86400000))
      : S.rewardDayRangeOf(Math.floor(NOW / 86400000));
    return journal.countKeyRange(tx, range.from, range.to, 100).count;
  });
  const hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key)).found === true;
  const stockOf = (typeId) => run(store, (tx) => stations.getStock(tx, STATION)).items
    .find((i) => i.itemKind === "mineral" && i.itemKey === `type:${typeId}`)?.quantity || 0;
  return Object.assign(h, { ctx, sites, occupation, repo, journal, stations, hulls, row, keysOfDay, hasKey, stockOf,
    reward, live, settings, power, env, wrecks, counters, clock,
    crash: (n) => {} });
}

function clearedPower(store, h, spec) {
  const members = PC.membersOf(spec.type, spec.tier, spec.variant, BASE.heavyEvents.maxUpscaleSteps, BASE.powerSites);
  run(store, (tx) => {
    const r = h.repo.planInTx(tx, { eventId: spec.eventId, planKey: `pw:1:${spec.eventId}`, eventType: spec.type,
      tier: spec.tier, systemId: spec.systemId, factionId: PIRATE, beneficiaryFactionId: null,
      stationId: spec.funded ? STATION : null, members: members.members, funded: spec.funded === true, integrity: null,
      seed: 3, at: NOW, expiresAt: NOW + 3600000, dueAt: null, variant: spec.variant, affix: spec.affix });
    assert.ok(r.ok, JSON.stringify(r));
  });
  run(store, (tx) => {
    let row = h.repo.getInTx(tx, spec.eventId).row;
    const ended = row.members.map((m) => (m.phase === 1 ? { ...m, state: "DESTROYED" } : m));
    row = h.repo.transitionInTx(tx, { eventId: spec.eventId, expectedVersion: row.version, from: "PLANNED", to: "ENGAGED", at: NOW,
      patch: { phase: 1, scaleSteps: 0, engagedAt: NOW, members: ended } }).row;
    assert.ok(h.repo.transitionInTx(tx, { eventId: spec.eventId, expectedVersion: row.version, from: "ENGAGED", to: "CLEARED", at: NOW,
      patch: { rewardState: "PENDING", dueAt: NOW + BASE.heavyEvents.rewardWaitMs }, reason: "CLEARED" }).ok);
  });
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PW1-PW5 power sites reward", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("PW1 power_small profile rolls correctly (medium hulls)", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { power: { outpostRolls: "2,3", cacheRolls: "2,3", trailRolls: "1,2",
        huntRolls: "2,4", convoyRolls: "1,1", musterRolls: "1,1",
        affixRolls: 1, richRolls: 2, maxLootRolls: 8, rareDeadspacePermille: 2000 } });
      clearedPower(store, h, { eventId: "hpw:1:0", type: "outpost", tier: 1, variant: "brawl", affix: "none",
        systemId: SYS, funded: true });
      h.reward.pass(NOW + 1000);
      const r = h.row("hpw:1:0");
      assert.deepStrictEqual([r.state, r.rewardState], ["COMPLETED", "PLACED"]);
      assert.strictEqual(h.wrecks.places.length, 1);
      const spec = h.wrecks.places[0];
      assert.strictEqual(spec.lootRolls, 2);
      assert.strictEqual(spec.hullGroup, "cruiser");
      assert.ok(spec.rewardLoot);
      assert.strictEqual(spec.rewardLoot.sizeBand, "medium");
      assert.strictEqual(h.keysOfDay("hpwrwd"), 1);
      assert.strictEqual(h.counters["power.reward.placed"], 1);
      h.reward.pass(NOW + 2000);
      assert.strictEqual(h.wrecks.places.length, 1);
      assert.strictEqual(h.keysOfDay("hpwrwd"), 1);
      assert.strictEqual(h.counters["power.reward.placed"], 1);
    });
  });

  test("PW2 power_rare profile has deadspace weight × rareDeadspacePermille", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { power: { outpostRolls: "2,3", cacheRolls: "2,3", trailRolls: "1,2",
        huntRolls: "2,4", convoyRolls: "1,1", musterRolls: "1,1",
        affixRolls: 1, richRolls: 2, maxLootRolls: 8, rareDeadspacePermille: 2000 } });
      clearedPower(store, h, { eventId: "hpw:2:0", type: "hunt", tier: 1, variant: "guarded", affix: "none",
        systemId: SYS, funded: true });
      h.reward.pass(NOW + 1000);
      const r = h.row("hpw:2:0");
      assert.deepStrictEqual([r.state, r.rewardState], ["COMPLETED", "PLACED"]);
      assert.strictEqual(h.wrecks.places.length, 1);
      const spec = h.wrecks.places[0];
      assert.ok(spec.rewardLoot);
      assert.strictEqual(spec.rewardLoot.sizeBand, "large");
      assert.strictEqual(spec.hullGroup, "battleship");
      assert.ok(spec.rewardLoot.deadspaceModuleWeight > 0);
    });
  });

  test("PW3 cache drain in CLEARED→COMPLETED tx (idempotent key <eventId>:drain)", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { power: { outpostRolls: "2,3", cacheRolls: "2,3", trailRolls: "1,2",
        huntRolls: "2,4", convoyRolls: "1,1", musterRolls: "1,1",
        affixRolls: 1, richRolls: 2, maxLootRolls: 8, rareDeadspacePermille: 2000,
        cacheDrainPermille: 50, drainMaxUnits: 100000, lootSharePermille: 100, lootMaxUnitsPerType: 10000 } });
      clearedPower(store, h, { eventId: "hpw:3:0", type: "cache", tier: 1, variant: "guard", affix: "none",
        systemId: SYS, funded: true });
      const before = h.stockOf(34);
      h.reward.pass(NOW + 1000);
      const r = h.row("hpw:3:0");
      assert.deepStrictEqual([r.state, r.rewardState], ["COMPLETED", "PLACED"]);
      assert.ok(r.result && r.result.drain, `no drain in result: ${JSON.stringify(r.result)}`);
      assert.strictEqual(r.result.drain.outcome, "APPLIED", `drain outcome: ${r.result.drain.outcome}, reason: ${r.result.drain.reason}`);
      assert.ok(r.result.drain.total > 0, `drain total: ${r.result.drain.total}`);
      const after = h.stockOf(34);
      assert.ok(after < before, `stock should decrease: ${before} -> ${after}, drain: ${JSON.stringify(r.result.drain)}`);
      const spec = h.wrecks.places[0];
      assert.ok(Array.isArray(spec.fixedItems), `fixedItems not array: ${JSON.stringify(spec.fixedItems)}`);
      assert.ok(spec.fixedItems.length > 0, `fixedItems empty: ${JSON.stringify(spec.fixedItems)}`);
      const after2 = h.stockOf(34);
      h.reward.pass(NOW + 2000);
      const after3 = h.stockOf(34);
      assert.strictEqual(after2, after3, "second pass should not drain again");
      assert.ok(h.hasKey("hpw:3:0:drain"), "drain key not found");
    });
  });

  test("PW4 hpwrwd: day caps separate from hevrwd: (power and heavy don't eat each other's caps)", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { heavy: { rewardMaxPerDay: 1, rewardMaxPerSystemPerDay: 1 },
        power: { rewardMaxPerDay: 1, rewardMaxPerSystemPerDay: 1,
          outpostRolls: "2,3", cacheRolls: "2,3", trailRolls: "1,2",
          huntRolls: "2,4", convoyRolls: "1,1", musterRolls: "1,1",
          affixRolls: 1, richRolls: 2, maxLootRolls: 8, rareDeadspacePermille: 2000 } });
      const day = Math.floor(NOW / 86400000);
      run(store, (tx) => {
        const key = S.rewardKeyOf(day, 30000999, "hev:0:0");
        assert.ok(h.journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: "hev:0:0" },
          eventType: S.EVENT_REWARD, payload: { eventId: "hev:0:0" } }, () => ({ ok: true })).ok);
      });
      clearedPower(store, h, { eventId: "hpw:4:0", type: "outpost", tier: 1, variant: "brawl", affix: "none",
        systemId: SYS, funded: true });
      h.reward.pass(NOW + 1000);
      const r = h.row("hpw:4:0");
      assert.deepStrictEqual([r.state, r.rewardState], ["COMPLETED", "PLACED"]);
      assert.strictEqual(h.keysOfDay("hpwrwd"), 1, "first power event should write 1 key");
      const dayRange = P.rewardDayRangeOf(day);
      const directCount = run(store, (tx) => h.journal.countKeyRange(tx, dayRange.from, dayRange.to, 100)).count;
      assert.strictEqual(directCount, 1, `direct journal count: ${directCount}`);
      clearedPower(store, h, { eventId: "hpw:4:1", type: "outpost", tier: 1, variant: "brawl", affix: "none",
        systemId: SYS, funded: true });
      h.reward.pass(NOW + 2000);
      const r2 = h.row("hpw:4:1");
      assert.deepStrictEqual([r2.state, r2.rewardState], ["COMPLETED", "SKIPPED"]);
      assert.strictEqual(h.counters["power.reward.skipped.LIMIT_DAY"], 1);
      assert.strictEqual(h.keysOfDay("hevrwd"), 1);
    });
  });

  test("PW5 rich affix boosts deadspace weight", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { power: { outpostRolls: "2,3", cacheRolls: "2,3", trailRolls: "1,2",
        huntRolls: "2,4", convoyRolls: "1,1", musterRolls: "1,1",
        affixRolls: 1, richRolls: 2, maxLootRolls: 8, rareDeadspacePermille: 2000 } });
      clearedPower(store, h, { eventId: "hpw:5:0", type: "convoy", tier: 1, variant: "light", affix: "rich",
        systemId: SYS, funded: true });
      h.reward.pass(NOW + 1000);
      const r = h.row("hpw:5:0");
      assert.deepStrictEqual([r.state, r.rewardState], ["COMPLETED", "PLACED"]);
      const spec = h.wrecks.places[0];
      assert.ok(spec.rewardLoot);
      assert.ok(spec.rewardLoot.deadspaceModuleWeight > 0);
      assert.strictEqual(spec.lootRolls, 3);
    });
  });

  test("powerRollsOf pure function: base × mult + affix + rich, capped", () => {
    const settings = { outpostRolls: "2,3", cacheRolls: "2,3", trailRolls: "1,2",
      huntRolls: "2,4", convoyRolls: "1,1", musterRolls: "1,1",
      affixRolls: 1, richRolls: 2, maxLootRolls: 8 };
    assert.strictEqual(powerRollsOf({ eventType: "outpost", tier: 1, affix: "none" }, settings, {}), 2);
    assert.strictEqual(powerRollsOf({ eventType: "trail", tier: 1, affix: "none" }, settings, { pockets: 2 }), 3);
    assert.strictEqual(powerRollsOf({ eventType: "convoy", tier: 2, affix: "none" }, settings, { haulersKilled: 2 }), 2);
    assert.strictEqual(powerRollsOf({ eventType: "muster", tier: 1, affix: "none" }, settings, { wavesCleared: 4 }), 4);
    assert.strictEqual(powerRollsOf({ eventType: "outpost", tier: 1, affix: "reinforced" }, settings, {}), 3);
    assert.strictEqual(powerRollsOf({ eventType: "outpost", tier: 1, affix: "rich" }, settings, {}), 4);
    assert.strictEqual(powerRollsOf({ eventType: "trail", tier: 2, affix: "rich" }, settings, { pockets: 10 }), 8);
  });

  test("cacheFixedItemsOf pure function: floor(drained * share / 1000), capped", () => {
    const settings = { lootSharePermille: 100, lootMaxUnitsPerType: 10000 };
    const drainResult = { outcome: "APPLIED", units: { "34": 50000, "35": 200 }, total: 50200 };
    const items = cacheFixedItemsOf(drainResult, settings);
    assert.deepStrictEqual(items, [{ typeId: 34, quantity: 5000 }, { typeId: 35, quantity: 20 }]);
    const drainResult2 = { outcome: "APPLIED", units: { "34": 200000 }, total: 200000 };
    const items2 = cacheFixedItemsOf(drainResult2, settings);
    assert.deepStrictEqual(items2, [{ typeId: 34, quantity: 10000 }]);
    assert.deepStrictEqual(cacheFixedItemsOf(null, settings), []);
    assert.deepStrictEqual(cacheFixedItemsOf({ outcome: "EMPTY", units: {}, total: 0 }, settings), []);
    assert.deepStrictEqual(cacheFixedItemsOf({ outcome: "REFUSED", units: {}, total: 0 }, settings), []);
  });

  test("decidePowerReward: MARK when key exists, SKIP when caps full, WAIT when scene not ready", () => {
    const settings = { rewardMaxPerDay: 1, rewardMaxPerSystemPerDay: 1, rewardMaxAttempts: 10 };
    const facts = { now: NOW, keyFound: false, siteActive: true, sceneLoaded: true, dayFull: false, systemFull: false };
    const row = { eventType: "outpost", members: [{ state: "DESTROYED" }], rewardAttempts: 0, dueAt: NOW + 3600000 };
    assert.deepStrictEqual(decidePowerReward(row, facts, settings), { action: "PLACE" });
    assert.deepStrictEqual(decidePowerReward({ ...row }, { ...facts, keyFound: true }, settings), { action: "MARK" });
    assert.deepStrictEqual(decidePowerReward(row, { ...facts, dayFull: true }, settings), { action: "SKIP", reason: "LIMIT_DAY" });
    assert.deepStrictEqual(decidePowerReward(row, { ...facts, systemFull: true }, settings), { action: "SKIP", reason: "LIMIT_SYSTEM" });
    assert.deepStrictEqual(decidePowerReward({ ...row, members: [{ state: "RESERVED" }] }, facts, settings), { action: "SKIP", reason: "NO_LOSSES" });
    assert.deepStrictEqual(decidePowerReward({ ...row, rewardAttempts: 10 }, facts, settings), { action: "SKIP", reason: "ATTEMPTS" });
    assert.deepStrictEqual(decidePowerReward({ ...row, dueAt: NOW + 3600000 }, { ...facts, sceneLoaded: false }, settings), { action: "WAIT" });
    assert.deepStrictEqual(decidePowerReward({ ...row, dueAt: NOW - 1000 }, { ...facts, sceneLoaded: false }, settings), { action: "SKIP", reason: "SCENE" });
  });
};