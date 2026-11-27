"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const S = require("../../lib/heavyEvents/schema");
const P = require("../../lib/heavyEvents/power/schema");
const { membersOf: powerMembersOf } = require("../../lib/heavyEvents/power/catalog");
const { initialMembersOf } = require("../../lib/heavyEvents/catalog");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:1";
const EVENT = "hpw:1:0";
const BEACON = Object.freeze({ x: 1, y: 2, z: 3 });

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SETTINGS = { ...BASE.heavyEvents, enabled: true, maxUpscaleSteps: 0, engagedMaxMs: 3600000,
  abandonGraceMs: 1000, plannedTtlMs: 7200000, maxShipsPerEvent: 50 };
const POWER = { ...BASE.powerSites, enabled: true, maxUpscaleSteps: 0, trailPockets: 3, escapeAfterMs: 240000,
  musterWaves: 3, musterWaveIntervalMs: 1000, musterWaveGrowthPermille: 300, musterInfluencePoints: 15,
  huntInfluencePoints: 20, convoyInfluencePoints: 10, convoyDrainPermillePerHauler: 30, drainMaxUnits: 100000,
  lootSharePermille: 100, lootMaxUnitsPerType: 10000, convoyRolls: "1,1", musterRolls: "1,1" };

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeSeam() {
  return { scene: true, players: 1, nextId: 9000, alive: new Set(), idOf: new Map(), despawned: [], spawns: [],
    pos: null,
    readGrid() {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, players: Array.from({ length: this.players }, (_, i) => ({ characterId: i + 1 })), copies: 0 };
    },
    spawnPhase(_sys, input) {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      this.spawns.push({ keys: input.members.map((m) => m.memberKey), distance: input.spawnDistanceM });
      const spawned = input.members.map((m) => {
        const entityId = this.nextId++;
        this.alive.add(entityId);
        this.idOf.set(m.memberKey, entityId);
        return { memberKey: m.memberKey, entityId, hullGroup: m.hullGroup };
      });
      return { ok: true, spawned, unspawnable: [] };
    },
    readMembers(_sys, ids) {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, live: ids.filter((id) => this.alive.has(id))
        .map((entityId) => ({ entityId, position: this.pos ? { ...this.pos } : null })),
      gone: ids.filter((id) => !this.alive.has(id)) };
    },
    despawn(_sys, ids) {
      this.despawned.push(...ids);
      for (const id of ids) this.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    kill(keys) {
      for (const key of keys) this.alive.delete(this.idOf.get(key));
    },
    killAll() {
      this.alive.clear();
    } };
}

function harness(store, type, variant, powerOver) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
  });
  const repo = createHeavyEventRepository({ journal });
  const power = { ...POWER, ...(powerOver || {}) };
  const members = powerMembersOf(type, 1, variant, 0, power).members;
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: EVENT, planKey: "pw:1800000:1:0", eventType: type,
    tier: 1, systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
    integrity: null, seed: 1, at: NOW, expiresAt: NOW + SETTINGS.plannedTtlMs, dueAt: null, variant,
    affix: "none" }).ok));
  const seam = fakeSeam();
  const site = { eventId: EVENT, slot: 0, state: "ACTIVE", position: { ...BEACON }, siteKey: `site:${EVENT}:0` };
  const sites = { cleaned: [],
    listSitesByEvent: () => ({ ok: true, sites: [{ ...site }] }),
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
  const counters = {};
  const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
  const stationsCtx = { getMode: () => "ready", repository: stations };
  const makeLive = () => createLive({ store, repo, settings: SETTINGS, power, journal,
    getStations: () => stationsCtx, getSites: () => sites, getPresence: () => ({ isObserved: (id) => id === SYS }),
    getSeam: () => seam, getOccupation: () => occupation, admits: () => true }, hooks);
  const h = { live: makeLive(), seam, sites, occupation, counters, site, members };
  h.row = () => run(store, (tx) => repo.getInTx(tx, EVENT).row);
  h.stock = (kind, key) => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === kind && (key === undefined || i.itemKey === key)).reduce((a, i) => a + i.quantity, 0);
  h.waveKeys = (k) => members.filter((m) => m.phase === k).map((m) => m.key);
  h.restart = (at) => {
    h.live.stopAll();
    run(store, (tx) => {
      const cur = repo.getInTx(tx, EVENT).row;
      assert.ok(repo.transitionInTx(tx, { eventId: EVENT, expectedVersion: cur.version, from: S.STATE.ENGAGED,
        to: S.STATE.PLANNED, at, patch: { abandons: cur.abandons + 1 }, reason: S.END_REASON.RESTART }).ok);
    });
    h.live = makeLive();
  };
  return h;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PM1-PM4 power muster", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("PM1 muster wave cadence: due sends next, wipe all -> CLEARED with wavesCleared", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.MUSTER, "swarm");
      const w = POWER.musterWaveIntervalMs;
      const [wave1, wave2, wave3] = [1, 2, 3].map((k) => h.waveKeys(k));
      assert.ok(wave1.length > 0 && wave2.length > 0 && wave3.length > 0, "the plan holds every wave");
      h.live.pass(NOW);
      let r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.dueAt], ["ENGAGED", 1, NOW + w], "first wave engaged");
      assert.deepStrictEqual(h.seam.spawns.map((x) => x.keys), [wave1], "wave 1 only (wave 2+ not fielded early)");
      h.live.pass(NOW + w - 1);
      assert.strictEqual(h.row().phase, 1, "phase 1 before due");
      h.live.pass(NOW + w);
      r = h.row();
      assert.deepStrictEqual([r.phase, r.dueAt], [2, NOW + 2 * w], "wave 2 sent, next due");
      assert.deepStrictEqual(h.seam.spawns[1].keys, wave2);
      h.seam.killAll();
      h.live.pass(NOW + w + 100);
      r = h.row();
      assert.deepStrictEqual([r.phase, r.dueAt], [3, NOW + w + 100 + w], "wave 3 sent immediately after wipe");
      assert.deepStrictEqual(h.seam.spawns[2].keys, wave3);
      assert.ok(h.seam.spawns.every((x) => x.distance === SETTINGS.waveSpawnDistanceM), "waves from waveSpawnDistanceM");
      h.seam.killAll();
      h.live.pass(NOW + 2 * w + 100);
      r = h.row();
      assert.deepStrictEqual([r.state, r.rewardState], ["CLEARED", "PENDING"], "CLEARED after last wave wiped");
      assert.strictEqual(r.result?.wavesCleared, 3, "result_json.wavesCleared === totalWaves (3 for tier I)");
      assert.deepStrictEqual(h.occupation.calls, [[PIRATE, POWER.musterInfluencePoints, S.influenceKeyOf(EVENT)]],
        "influence drop with musterInfluencePoints");
      assert.strictEqual(h.counters["cleared.muster"], 1);
      assert.ok(r.members.every((m) => m.state === S.MEMBER_STATE.DESTROYED));
      assert.strictEqual(h.stock("hull"), 0);
    });
  });

  test("PM2 muster no integrity: never FAIL INTEGRITY even with invaders on beacon", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.MUSTER, "swarm");
      h.seam.pos = { ...BEACON };
      h.live.pass(NOW);
      h.live.pass(NOW + 300000);
      let r = h.row();
      assert.strictEqual(r.state, "ENGAGED", "still engaged, no integrity fail");
      assert.strictEqual(r.integrity, null, "integrity stays null for muster");
      h.seam.killAll();
      h.live.pass(NOW + 301000);
      h.seam.killAll();
      h.live.pass(NOW + 302000);
      h.seam.killAll();
      h.live.pass(NOW + 303000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.rewardState], ["CLEARED", "PENDING"], "CLEARED without integrity fail");
      assert.strictEqual(h.counters["failed.INTEGRITY"], undefined);
    });
  });

  test("PM3 defense regression: defense still behaves as before (waves, integrity, CLEARED)", () => {
    withStore(driver, ({ store }) => {
      const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
      const repo = createHeavyEventRepository({ journal });
      const settings = { ...SETTINGS, waveIntervalMs: 1000, waveSpawnDistanceM: 5000, gridRadiusM: 10000,
        pressureRadiusM: 30000, pressurePerHullPerMinPermille: 8, maxShipsPerEvent: 50, defenseWaves: 2,
        defenseInfluencePoints: 10 };
      const members = initialMembersOf("defense", 1, settings.maxUpscaleSteps, settings).members;
      run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: "hev:7:0", planKey: "1:hev:7:0", eventType: "defense",
        tier: 1, systemId: SYS, factionId: 500010, beneficiaryFactionId: 500001, stationId: "st:def:1", members,
        funded: false, integrity: S.INTEGRITY_START, seed: 1, at: NOW,
        expiresAt: NOW + settings.plannedTtlMs, dueAt: null }).ok));
      const seam = { players: 1, nextId: 7000, alive: new Set(), spawns: [], despawned: [], pos: { x: 1e9, y: 0, z: 0 }, distances: [],
        readGrid() { return { ok: true, players: Array.from({ length: this.players }, (_, i) => ({ characterId: i + 1 })), copies: 0 }; },
        spawnPhase(_sys, input) { this.spawns.push(input.members.map((m) => m.memberKey)); this.distances.push(input.spawnDistanceM);
          const spawned = input.members.map((m) => { const entityId = this.nextId++; this.alive.add(entityId);
            return { memberKey: m.memberKey, entityId, hullGroup: m.hullGroup }; }); return { ok: true, spawned, unspawnable: [] }; },
        readMembers(_sys, ids) { return { ok: true, live: ids.filter((id) => this.alive.has(id)).map((entityId) => ({ entityId, position: { ...this.pos } })),
          gone: ids.filter((id) => !this.alive.has(id)) }; },
        despawn(_sys, ids) { this.despawned.push(...ids); for (const id of ids) this.alive.delete(id); return { ok: true, removed: ids.length }; },
        kill(n) { for (const id of [...this.alive].slice(0, n === undefined ? this.alive.size : n)) this.alive.delete(id); } };
      const sites = { cleaned: [], listSitesByEvent: () => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", position: { x: 1, y: 2, z: 3 } }] }),
        cleanupSitesInTx(_tx, eventId, reason) { this.cleaned.push([eventId, reason]); return { ok: true }; } };
      const occupation = { calls: [], keys: new Set(),
        dropInfluenceInTx(tx, spec, key) { this.calls.push([spec.factionId, spec.points, spec.reason, spec.allowNonController, key]);
          if (this.keys.has(key)) return { ok: true, outcome: "DUPLICATE" }; this.keys.add(key);
          return { ok: true, outcome: "APPLIED", written: false }; } };
      const counters = {};
      const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
      const live = createLive({ store, repo, settings, getStations: () => null, getSites: () => sites,
        getPresence: () => ({ isObserved: (id) => id === SYS }), getSeam: () => seam, getOccupation: () => occupation,
        admits: () => true }, hooks);
      const row = () => run(store, (tx) => repo.getInTx(tx, "hev:7:0").row);

      live.pass(NOW);
      let r = row();
      assert.deepStrictEqual([r.state, r.phase, r.dueAt], ["ENGAGED", 1, NOW + 1000]);
      live.pass(NOW + 1000);
      r = row();
      assert.strictEqual(r.phase, 2);
      seam.kill();
      live.pass(NOW + 2000);
      r = row();
      assert.deepStrictEqual([r.state, r.rewardState], ["CLEARED", "PENDING"]);
      assert.deepStrictEqual(occupation.calls, [[500010, settings.defenseInfluencePoints, "HEAVY_EVENT_DEFENDED", true, S.influenceKeyOf("hev:7:0")]]);
      assert.strictEqual(counters["cleared.defense"], 1);
    });
  });

  test("PM4 restart in wave 2: re-engage fields wave 1 survivors + wave 2; wave 3 budget counts the survivors", () => {
    withStore(driver, ({ store }) => {
      const probe = powerMembersOf(P.TYPE.MUSTER, 1, "swarm", 0, POWER).members;
      const sizeOf = (k) => probe.filter((m) => m.phase === k).length;
      const h = harness(store, P.TYPE.MUSTER, "swarm", { maxShipsPerEvent: sizeOf(2) + sizeOf(3) });
      const w = POWER.musterWaveIntervalMs;
      const [wave1, wave2] = [h.waveKeys(1), h.waveKeys(2)];
      h.live.pass(NOW);
      h.live.pass(NOW + w);
      assert.strictEqual(h.row().phase, 2);
      h.seam.kill([wave1[0]]);
      h.live.pass(NOW + w + 10);
      assert.strictEqual(h.row().members.find((m) => m.key === wave1[0]).state, S.MEMBER_STATE.DESTROYED);
      h.restart(NOW + w + 20);
      h.live.pass(NOW + w + 30);
      let r = h.row();
      assert.deepStrictEqual([r.state, r.phase], ["ENGAGED", 2]);
      const fielded = h.seam.spawns[h.seam.spawns.length - 1].keys;
      assert.deepStrictEqual([...fielded].sort(), [...wave1.slice(1), ...wave2].sort(), "survivors of wave 1 + wave 2");
      h.live.pass(NOW + 2 * w + 30);
      assert.strictEqual(h.row().phase, 2);
      assert.ok(h.counters["deferred.BUDGET"] >= 1);
      h.seam.kill(wave1.slice(1));
      h.live.pass(NOW + 2 * w + 40);
      r = h.row();
      assert.strictEqual(r.phase, 3);
    });
  });
  
  test("PM5 engage muster: no INVALID_PARAMS from powerPhaseCountOf", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.MUSTER, "swarm");
      h.live.pass(NOW);
      const r = h.row();
      assert.strictEqual(r.state, "ENGAGED", "engage succeeded, not HOLD with INVALID_PARAMS");
      assert.strictEqual(r.phase, 1);
      assert.strictEqual(r.dueAt, NOW + POWER.musterWaveIntervalMs, "dueAt uses musterWaveIntervalMs");
    });
  });
};
