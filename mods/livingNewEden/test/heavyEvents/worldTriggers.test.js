"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig, SCHEMA } = require("../../config");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { createRng } = require("../../lib/util/rng");
const PC = require("../../lib/heavyEvents/power/catalog");
const W = require("../../lib/heavyEvents/world/schema");
const { chooseWorld, labelOf } = require("../../lib/heavyEvents/world/choose");
const { planWorldPass } = require("../../lib/heavyEvents/world/planner");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { createLossesCache } = require("../../lib/inGameMap/losses");
const { startAbyssal, createUnavailableAbyssal } = require("../../lib/abyssal");
const { unavailableSalvageAnomaly } = require("../../lib/events/salvage");
const { createSalvageAnomalyService } = require("../../lib/events/salvage/anomalyService");
const { createViewRegistry } = require("../../lib/observer/views");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const EMPIRE = 500001;
const PIRATE = 500010;
const TRIG = 500026;
const SYS_A = 30000142;
const SYS_B = 30000144;
const REGION = 10000002;
const KINDS = new Map([[PIRATE, "pirate"], [EMPIRE, "empire"], [TRIG, "invader"]]);
const SUB6 = [W.KIND.FLAGWRECK, W.KIND.BREACH];

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const BUCKET = Math.floor(NOW / BASE.eventAnomalies.planIntervalMs);
const STEPS = BASE.heavyEvents.maxUpscaleSteps;

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const worldCfg = (over) => ({ ...BASE.eventAnomalies, enabled: true, maxUpscaleSteps: STEPS, ...over });
const sysOf = (systemId, controller, occupier) => ({ systemId, band: "nullsec", controllerFactionId: controller,
  previousControllerFactionId: null, occupationState: occupier ? "OCCUPIED" : null, occupierFactionId: occupier || null });
const factsOf = (over) => ({ now: NOW, systems: [sysOf(SYS_A, PIRATE)], kindOf: KINDS, losses: [], beachheads: [],
  factions: new Map(), open: [], lastWorldEndedAt: new Map(), ...over });
const lossRow = (hullGroup, count, factionId = PIRATE) => ({ systemId: SYS_A, settledAt: NOW - 60000, factionId,
  typeId: 603, count, hullGroup });

function planOnce(store, worldOver, extra, losses) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const repo = createHeavyEventRepository({ journal });
  const sites = { calls: [],
    createSiteInTx(_tx, req) {
      this.calls.push([req.eventId, req.siteKind || null, req.label]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    countLive: () => ({ ok: true, count: 0 }) };
  const systems = new Map([[SYS_A, sysOf(SYS_A, PIRATE)], [SYS_B, sysOf(SYS_B, EMPIRE, PIRATE)]]);
  const battle = { calls: [],
    listVirtualLossesSince(tx, opts) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(opts);
      return { ok: true, losses: (losses || []).filter((l) => l.settledAt >= opts.sinceMs), truncated: false };
    } };
  const weights = Object.fromEntries(W.KINDS.map((k) => [W.KIND_WEIGHT_KEY[k], 0]));
  const env = { store, repo, journal, settings: { ...BASE.heavyEvents }, power: { ...BASE.powerSites },
    world: { ...BASE.eventAnomalies, ...weights, enabled: true, fundFromStock: false, maxPlansPerPass: 1,
      ...worldOver },
    worldSeed: 7, maxActiveSites: BASE.sites.maxActiveSites,
    getStations: () => ({ getMode: () => "ready", repository: {} }), getSites: () => sites,
    getWorldRepository: () => ({ getSystem: (_tx, id) => ({ ok: true, system: systems.get(id) || null }) }),
    getInvasions: () => ({ listBeachheadsInTx: (_tx, opts) => ({ ok: true, truncated: false,
      beachheads: opts.systems.includes(SYS_A) ? [{ invasionId: "inv:1", factionId: TRIG, systemId: SYS_A }] : [] }) }),
    getBattleRepository: () => battle,
    getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec",
      regionId: REGION }), getNeighbors: () => [] } }) }),
    getPresence: () => ({ getStatus: () => ({ available: true, stale: false }),
      observedWithin: () => ({ ok: true, systems: [[SYS_A, 0], [SYS_B, 1]] }) }),
    getFactionKind: (id) => KINDS.get(id) || null, factionName: () => null,
    ...(typeof extra === "function" ? extra(store) : extra) };
  const result = planWorldPass(env, NOW, BUCKET);
  const rows = run(store, (tx) => tx.prepare("SELECT * FROM world_heavy_events ORDER BY event_id").all());
  return { result, rows, sites: sites.calls, battle };
}

function fakeSeam() {
  return { nextId: 9000, alive: new Set(),
    readGrid() {
      return { ok: true, players: [{ characterId: 1, entityId: 1 }], copies: 0 };
    },
    spawnPhase(_sys, input) {
      const spawned = input.members.map((m) => {
        const entityId = this.nextId++;
        this.alive.add(entityId);
        return { memberKey: m.memberKey, entityId, hullGroup: m.hullGroup };
      });
      return { ok: true, spawned, unspawnable: [] };
    },
    readMembers(_sys, ids) {
      return { ok: true, live: ids.filter((id) => this.alive.has(id)).map((entityId) => ({ entityId, position: null })),
        gone: ids.filter((id) => !this.alive.has(id)) };
    },
    despawn(_sys, ids) {
      for (const id of ids) this.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    kill() {
      this.alive.clear();
    } };
}

function fakeSites(eventId) {
  const byEvent = new Map([[eventId, [{ eventId, slot: 0, state: "ACTIVE", siteKey: `site:${eventId}:0`,
    position: { x: 1, y: 2, z: 3 } }]]]);
  return { created: [],
    listSitesByEvent: (id) => ({ ok: true, sites: (byEvent.get(id) || []).map((s) => ({ ...s })) }),
    createSiteInTx(tx, spec) {
      assert.strictEqual(tx.inTransaction, true);
      const list = byEvent.get(spec.eventId) || [];
      list.push({ eventId: spec.eventId, slot: spec.slot, state: "ACTIVE", siteKey: `site:${spec.eventId}:${spec.slot}`,
        position: { x: 1000 * spec.slot, y: 2, z: 3 } });
      byEvent.set(spec.eventId, list);
      this.created.push(spec);
      return { ok: true, siteKey: `site:${spec.eventId}:${spec.slot}` };
    },
    releaseSlotInTx(_tx, id, slot) {
      const list = byEvent.get(id) || [];
      const at = list.findIndex((s) => s.slot === slot);
      if (at >= 0) list.splice(at, 1);
      return { ok: true, released: at >= 0 ? 1 : 0 };
    },
    cleanupSitesInTx: () => ({ ok: true }) };
}

function breachPocket(store, factionName) {
  const eventId = "hwa:1:0";
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const repo = createHeavyEventRepository({ journal });
  const settings = { ...BASE.heavyEvents, enabled: true, maxUpscaleSteps: 0, engagedMaxMs: 3600000,
    abandonGraceMs: 60000, plannedTtlMs: 7200000 };
  const world = { ...BASE.eventAnomalies, enabled: true, breachWeight: 1 };
  const members = PC.membersOf("trail", 2, W.KIND.BREACH, 0, world);
  assert.ok(members.ok, JSON.stringify(members));
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId, planKey: "wa:1800000:1:0", eventType: "trail", tier: 2,
    systemId: SYS_A, factionId: TRIG, beneficiaryFactionId: null, stationId: null, members: members.members,
    funded: false, integrity: null, seed: 1, at: NOW, expiresAt: NOW + 7200000, dueAt: null, variant: W.KIND.BREACH,
    affix: W.AFFIX_NONE }).ok));
  const seam = fakeSeam();
  const sites = fakeSites(eventId);
  const counters = {};
  const hooks = { bump: (name, n = 1) => {
    counters[name] = (counters[name] || 0) + n;
  }, refuse: () => {} };
  const live = createLive({ store, repo, settings, power: { ...BASE.powerSites, enabled: false }, world, journal,
    getStations: () => ({ getMode: () => "ready", repository: {} }), getSites: () => sites,
    getPresence: () => ({ getStatus: () => ({ available: true }), isObserved: (id) => id === SYS_A }),
    getSeam: () => seam, getOccupation: () => ({ dropInfluenceInTx: () => ({ ok: true, outcome: "APPLIED" }) }),
    admits: () => true, factionName: () => factionName }, hooks);
  live.pass(NOW);
  seam.kill();
  live.pass(NOW + 1000);
  const row = run(store, (tx) => repo.getInTx(tx, eventId).row);
  live.stopAll();
  return { row, created: sites.created, counters };
}

module.exports = ({ test, skip }) => {
  test("EA6-2 chooseWorld flagwreck: capital loss -> hunt signature tier III unfunded; NO_TRIGGER / BUSY / KIND_OFF",
    () => {
      const cfg = worldCfg({ flagwreckWeight: 1 });
      const facts = factsOf({ capitalLosses: [{ systemId: SYS_A, factionId: PIRATE, count: 1 }] });
      for (let seed = 1; seed <= 6; seed += 1) {
        const r = chooseWorld(facts, cfg, createRng(seed));
        assert.ok(r.ok, JSON.stringify(r));
        const c = r.candidate;
        assert.deepStrictEqual([c.kind, c.eventType, c.systemId, c.factionId, c.tier, c.siteKind, c.funded,
          c.stationId], [W.KIND.FLAGWRECK, "hunt", SYS_A, PIRATE, 3, "signature", false, null]);
      }
      assert.strictEqual(labelOf("Guristas Pirates", W.KIND.FLAGWRECK), "Guristas Pirates Fallen Flagship");
      const refusal = (over) => chooseWorld(factsOf(over), cfg, createRng(1));
      assert.deepStrictEqual(refusal({ capitalLosses: [] }), { ok: false, reason: "NO_TRIGGER" });
      assert.deepStrictEqual(refusal({ capitalLosses: facts.capitalLosses, salvageSystems: new Set([SYS_A]) }),
        { ok: false, reason: "BUSY" });
      assert.deepStrictEqual(refusal({ capitalLosses: [{ systemId: SYS_A, factionId: TRIG, count: 2 }] }),
        { ok: false, reason: "KIND_OFF" });
      assert.deepStrictEqual(chooseWorld(facts, worldCfg({ flagwreckWeight: 1, flagwreckMinCapitals: 2 }),
        createRng(1)), { ok: false, reason: "NO_TRIGGER" });
    });

  test("EA6-3 chooseWorld breach: attention >= threshold -> trail 500026 tier II/III anomaly; below NO_TRIGGER; "
    + "weights 0 ignore the facts", () => {
    const cfg = worldCfg({ breachWeight: 1 });
    const min = BASE.eventAnomalies.breachMinPressureMilli;
    const tiers = new Set();
    for (let seed = 1; seed <= 12; seed += 1) {
      const r = chooseWorld(factsOf({ pressure: new Map([[SYS_A, min]]) }), cfg, createRng(seed));
      assert.ok(r.ok, JSON.stringify(r));
      const c = r.candidate;
      assert.deepStrictEqual([c.kind, c.eventType, c.systemId, c.factionId, c.siteKind, c.funded, c.stationId],
        [W.KIND.BREACH, "trail", SYS_A, TRIG, "anomaly", false, null]);
      tiers.add(c.tier);
    }
    assert.deepStrictEqual([...tiers].sort(), [2, 3]);
    assert.deepStrictEqual(chooseWorld(factsOf({ pressure: new Map([[SYS_A, min - 1]]) }), cfg, createRng(1)),
      { ok: false, reason: "NO_TRIGGER" });
    const sub1 = factsOf({ systems: [sysOf(SYS_A, PIRATE), sysOf(SYS_B, EMPIRE, PIRATE)],
      losses: [{ systemId: SYS_A, factionId: PIRATE, count: 20 }],
      lostConvoys: [{ systemId: SYS_B, factionId: PIRATE, lostUnits: 9 }] });
    const extra = { capitalLosses: [{ systemId: SYS_A, factionId: PIRATE, count: 3 }], salvageSystems: new Set([SYS_B]),
      pressure: new Map([[SYS_A, 99999], [SYS_B, 99999]]) };
    const old = worldCfg({ warcampWeight: 1, hideoutWeight: 1, wreckedconvoyWeight: 1, fundFromStock: false });
    for (let seed = 1; seed <= 8; seed += 1) {
      const without = chooseWorld(sub1, old, createRng(seed));
      assert.ok(without.ok, JSON.stringify(without));
      assert.deepStrictEqual(chooseWorld({ ...sub1, ...extra }, old, createRng(seed)), without);
    }
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("EA6-1, EA6-4, EA6-5 store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("EA6-1 listVirtualLossesSince returns hullGroup; the inGameMap losses snapshot keeps its keys and values", () => {
    let handle = null;
    const opened = openStore({ filePath: ":memory:", openDatabase: (f) => {
      handle = new driver.Database(f);
      return handle;
    }, exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    try {
      handle.pragma("foreign_keys = OFF");
      run(store, (db) => {
        db.prepare(`INSERT INTO battle_records (battle_id, idempotency_key, system_id, environment, objective, mode,
          state, resolver_version, input_hash, seed, input_json, fleet_ids, claim_seq, created_at, updated_at,
          settled_at, version) VALUES ('b1', 'k-b1', ?, 'nullsec', 'destroy', 'VIRTUAL', 'COMPLETED', 'internal-v1',
          ?, 1, '{}', '[]', 0, 1, 1, ?, 1)`).run(BigInt(SYS_A), "a".repeat(64), BigInt(NOW - 1000));
        const insL = db.prepare(`INSERT INTO battle_losses (battle_id, fleet_id, faction_id, hull_group, type_id, count)
          VALUES ('b1', ?, ?, ?, ?, ?)`);
        insL.run("f1", BigInt(PIRATE), "dreadnought", 19720n, 1n);
        insL.run("f2", BigInt(EMPIRE), "frigate", 587n, 3n);
      });
      const repo = createBattleRepository({ journal: { applyOnce() {}, findByKey() {} },
        fleetRepository: { transition() {}, getFleets() {} }, clock: { now: () => NOW }, ids: { next: () => "x" },
        worldSeed: 1, limits: { maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
          maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500, maxSettlementRows: 450 } });
      assert.deepStrictEqual(run(store, (db) => repo.listVirtualLossesSince(db, { sinceMs: NOW - 3600000, limit: 10 })),
        { ok: true, truncated: false, losses: [
          { systemId: SYS_A, settledAt: NOW - 1000, factionId: PIRATE, typeId: 19720, count: 1, hullGroup: "dreadnought" },
          { systemId: SYS_A, settledAt: NOW - 1000, factionId: EMPIRE, typeId: 587, count: 3, hullGroup: "frigate" }] });
      const cache = createLossesCache({ battle: { repository: repo }, store, clock: { now: () => NOW },
        wallNow: () => NOW, getGovernor: () => null,
        settings: { starmapKillsRefreshMs: 60000, starmapMaxLossRows: 2000 } });
      assert.deepStrictEqual(cache.refreshNow(), { ok: true });
      const snap = cache.snapshot();
      assert.deepStrictEqual(snap.losses.map((l) => Object.keys(l).sort()),
        [0, 1].map(() => ["ageMs", "count", "factionId", "systemId", "typeId"]));
      assert.deepStrictEqual(snap.losses.map((l) => ({ ...l })), [
        { systemId: SYS_A, ageMs: 1000, typeId: 19720, factionId: PIRATE, count: 1 },
        { systemId: SYS_A, ageMs: 1000, typeId: 587, factionId: EMPIRE, count: 3 }]);
      cache.stop();
    } finally {
      store.close("test_cleanup");
    }
  });

  test("EA6-4 planWorldPass: weights 0 no new read; refused attention / salvage -> readRefused; flagwreck / BUSY; "
    + "refused invasion / losses read -> readRefused.staging /.warcamp, no NO_TRIGGER", () => {
    const pass = (worldOver, extra, losses) => withStore(driver, ({ store }) => planOnce(store, worldOver, extra,
      losses));
    const calls = [];
    const thrower = (name) => () => {
      calls.push(name);
      throw new Error(`${name} called`);
    };
    const ea = BASE.eventAnomalies;
    const old = { warcampWeight: 1, hideoutWeight: 1, stagingWeight: 1, maxPlansPerPass: 3 };
    const losses = [lossRow("dreadnought", 20)];
    const plain = pass(old, {}, losses);
    const off = pass(old, { getAbyssal: thrower("abyssal"), getSalvageAnomaly: thrower("salvage") }, losses);
    assert.ok(plain.result.ok && plain.result.planned >= 2, JSON.stringify(plain.result));
    assert.deepStrictEqual([off.result, off.rows, off.sites], [plain.result, plain.rows, plain.sites]);
    assert.deepStrictEqual([calls, plain.result.readRefused, plain.battle.calls],
      [[], {}, [{ sinceMs: NOW - ea.warcampWindowMs, limit: ea.maxLossRows }]]);
    const camp = { warcampWeight: 1, breachWeight: 1 };
    for (const abyssal of [{ pressureOf: () => ({ ok: false, reason: "PRESSURE_DISABLED" }) },
      createUnavailableAbyssal("stopped")]) {
      const r = pass(camp, { getAbyssal: () => abyssal }, losses).result;
      assert.deepStrictEqual([r.readRefused, r.plans.map((p) => p.kind)], [{ breach: true }, [W.KIND.WARCAMP]],
        JSON.stringify(r));
    }
    let asked = 0;
    const hot = pass({ breachWeight: 1 }, { getAbyssal: () => ({ pressureOf: (regionId) => {
      asked += 1;
      return regionId === REGION ? { ok: true, milli: ea.breachMinPressureMilli, atMs: NOW } : { ok: false };
    } }) }).result;
    assert.deepStrictEqual([hot.readRefused, hot.plans.map((p) => [p.kind, p.eventType]), asked],
      [{}, [[W.KIND.BREACH, "trail"]], 1], JSON.stringify(hot));
    const disabled = { getSalvageAnomaly: () => unavailableSalvageAnomaly("SALVAGE_ANOMALY_DISABLED") };
    const wreck = pass({ flagwreckWeight: 1 }, disabled, [lossRow("dreadnought", 1)]);
    assert.deepStrictEqual(wreck.rows.map((x) => [x.event_type, x.variant, x.system_id, x.faction_id, x.tier, x.funded,
      x.station_id]), [["hunt", W.KIND.FLAGWRECK, SYS_A, PIRATE, 3, 0, null]], JSON.stringify(wreck.result));
    assert.deepStrictEqual([wreck.sites, wreck.battle.calls.map((c) => c.sinceMs), wreck.result.readRefused],
      [[[W.eventIdOf(BUCKET, 0), "signature", "Fallen Flagship"]], [NOW - ea.flagwreckWindowMs], {}]);
    const ship = pass({ flagwreckWeight: 1 }, disabled, [lossRow("battleship", 3)]).result;
    assert.deepStrictEqual([ship.plans, ship.refused], [[], { NO_TRIGGER: 1 }]);
    const asked6 = [];
    const field = pass({ flagwreckWeight: 1 }, (store) => ({ getSalvageAnomaly: () => ({ listBoardRows: (opts) => {
      asked6.push([store.isInTransaction(), opts.systemIds instanceof Set, opts.limit]);
      return { ok: true, rows: [{ systemId: SYS_A }], truncated: false };
    } }) }), [lossRow("dreadnought", 1)]).result;
    assert.deepStrictEqual([field.plans, field.refused, asked6], [[], { BUSY: 1 },
      [[false, true, ea.flagwreckSalvageMaxRows]]]);
    for (const salvage of [unavailableSalvageAnomaly("SALVAGE_ANOMALY_UNAVAILABLE"),
      { listBoardRows: () => ({ ok: true, rows: [], truncated: true }) }]) {
      const r = pass({ flagwreckWeight: 1, hideoutWeight: 1 }, { getSalvageAnomaly: () => salvage },
        [lossRow("dreadnought", 1)]).result;
      assert.deepStrictEqual([r.readRefused, r.plans.map((p) => p.kind)], [{ flagwreck: true }, [W.KIND.HIDEOUT]]);
    }
    const staging = pass({ stagingWeight: 1, hideoutWeight: 1 }, { getInvasions: () => null }).result;
    assert.deepStrictEqual([staging.readRefused, staging.refused, staging.plans.map((p) => p.kind)],
      [{ staging: true }, {}, [W.KIND.HIDEOUT]]);
    const camp0 = pass({ warcampWeight: 1, hideoutWeight: 1 }, { getBattleRepository: () => null }).result;
    assert.deepStrictEqual([camp0.readRefused, camp0.refused, camp0.plans.map((p) => p.kind)],
      [{ warcamp: true }, {}, [W.KIND.HIDEOUT]]);
  });

  test("EA6-6 debt-sweep: only staging + refused invasion read -> readRefused.staging, refused {}; no beachhead -> "
    + "NO_TRIGGER; readRefusedKinds in chooseWorld", () => {
    const pass = (worldOver, extra) => withStore(driver, ({ store }) => planOnce(store, worldOver, extra, []));
    const refusedRead = pass({ stagingWeight: 1 }, { getInvasions: () => null }).result;
    assert.deepStrictEqual([refusedRead.readRefused, refusedRead.refused, refusedRead.plans],
      [{ staging: true }, {}, []], JSON.stringify(refusedRead));
    const empty = { getInvasions: () => ({ listBeachheadsInTx: () => ({ ok: true, truncated: false, beachheads: [] }) }) };
    const noBeachhead = pass({ stagingWeight: 1 }, empty).result;
    assert.deepStrictEqual([noBeachhead.readRefused, noBeachhead.refused, noBeachhead.plans],
      [{}, { NO_TRIGGER: 1 }, []], JSON.stringify(noBeachhead));
    const cfg = worldCfg({ ...Object.fromEntries(W.KINDS.map((k) => [W.KIND_WEIGHT_KEY[k], 0])), stagingWeight: 1 });
    assert.deepStrictEqual(chooseWorld(factsOf({}), cfg, createRng(1)), { ok: false, reason: "NO_TRIGGER" });
    assert.deepStrictEqual(chooseWorld(factsOf({ readRefusedKinds: new Set([W.KIND.STAGING]) }), cfg, createRng(1)),
      { ok: false, reason: "NO_CANDIDATE" });
    assert.deepStrictEqual(chooseWorld(factsOf({ readRefusedKinds: new Set([W.KIND.WARCAMP]) }), cfg, createRng(1)),
      { ok: false, reason: "NO_TRIGGER" }, "another kind refused: staging still NO_TRIGGER");
  });

  test("EA6-5 LIVE breach pocket 2 label / signature / anomaly.pocket; long name keeps the suffix; facade methods; "
    + "config defaults, compose 0, frontdepot types and breach warnings", () => {
    withStore(driver, ({ store }) => {
      const r = breachPocket(store, "Triglavian Collective");
      assert.deepStrictEqual([r.row.state, r.row.pocket], ["PLANNED", 1], JSON.stringify(r.counters));
      const spec = r.created.find((c) => c.slot === 1);
      assert.ok(spec, "pocket 2 beacon");
      assert.deepStrictEqual([spec.label, spec.siteKind, spec.templateId],
        [`${labelOf("Triglavian Collective", W.KIND.BREACH)} Pocket 2`, "signature", BASE.heavyEvents.beaconTemplateId]);
      assert.deepStrictEqual([r.counters["anomaly.pocket"], r.counters["power.pocket"]], [1, undefined]);
    });
    withStore(driver, ({ store }) => {
      const name = "X".repeat(70);
      const base = labelOf(name, W.KIND.BREACH);
      assert.strictEqual(base.length, W.LABEL_MAX);
      const spec = breachPocket(store, name).created.find((c) => c.slot === 1);
      assert.strictEqual(spec.label, `${base.slice(0, W.LABEL_MAX - " Pocket 2".length)} Pocket 2`);
      assert.ok(spec.label.length <= W.LABEL_MAX && spec.label.endsWith(" Pocket 2"), spec.label);
    });
    for (const m of W.BREACH_ABYSSAL_METHODS) {
      assert.strictEqual(typeof createUnavailableAbyssal("x")[m], "function", m);
    }
    for (const m of W.FLAGWRECK_SALVAGE_METHODS) {
      assert.strictEqual(typeof unavailableSalvageAnomaly("x")[m], "function", m);
    }
    withStore(driver, ({ store, journal }) => {
      const abyssalConfig = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_ABYSSAL_ENABLED: "1",
        EVEJS_LNE_ABYSSAL_PRESSURE_ENABLED: "1" } }).config;
      const seam = { isAbyssalHost: () => false, readActiveRun: () => ({ ok: true, run: null }),
        installCompletionHook: () => ({ ok: false, reason: "SEAM_MISSING" }), projectRun: () => null,
        stats: () => ({ hostDegraded: false }) };
      const started = startAbyssal({ config: abyssalConfig, ctx: { persistence: { store }, presence: null,
        views: createViewRegistry(), graph: null, governor: null }, adapter: { abyssalSeams: () => ({ ok: true, seam }) },
      clock: { now: () => NOW }, telemetry: null, logger: { log() {} },
      setTimer: () => ({ cancel() {}, hasRef: () => false }) });
      assert.ok(started.ok, JSON.stringify(started));
      for (const m of W.BREACH_ABYSSAL_METHODS) assert.strictEqual(typeof started.abyssal[m], "function", m);
      assert.strictEqual(started.abyssal.pressureOf(REGION).ok, true);
      started.abyssal.stop();
      const salvage = createSalvageAnomalyService({ store, journal: journal || createJournal({ clock: { now: () => NOW },
        maxPayloadBytes: 16384, maxRows: 500 }), worldSeed: 1, adapter: null, clock: { now: () => NOW }, config: BASE });
      for (const m of W.FLAGWRECK_SALVAGE_METHODS) assert.strictEqual(typeof salvage[m], "function", m);
      assert.deepStrictEqual(salvage.listBoardRows({ systemIds: new Set([SYS_A]),
        limit: BASE.eventAnomalies.flagwreckSalvageMaxRows }), { ok: true, rows: [], truncated: false });
    });
    const ea = BASE.eventAnomalies;
    assert.deepStrictEqual([ea.flagwreckWeight, ea.flagwreckFactionKinds, ea.flagwreckWindowMs, ea.flagwreckMinCapitals,
      ea.flagwreckSalvageMaxRows, ea.flagwreckRolls, ea.flagwreckInfluencePoints, ea.breachWeight, ea.breachFactionId,
      ea.breachMinPressureMilli, ea.breachTierWeights, ea.breachRolls, ea.breachInfluencePoints],
    [0, "empire,pirate", 21600000, 1, 64, "4,6,9", 40, 0, 500026, 5000, "0,60,40", "1,2,3", 0]);
    assert.strictEqual(SCHEMA.filter((row) => /^eventAnomalies\.(flagwreck|breach)/.test(row.key)).length, 13);
    const warn = (env, part) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENT_ANOMALIES_ENABLED: "1", ...env } })
      .warnings.filter((w) => w.includes(part));
    const types = { EVEJS_LNE_EVENT_ANOMALIES_FRONTDEPOT_OPERATION_TYPES: "invazion,raid" };
    const typed = warn({ ...types, EVEJS_LNE_EVENT_ANOMALIES_FRONTDEPOT_WEIGHT: "1" }, "frontdepotOperationTypes");
    assert.strictEqual(typed.length, 1, typed.join("; "));
    assert.ok(typed[0].includes("invazion") && !typed[0].includes(" raid "), typed[0]);
    assert.deepStrictEqual(warn(types, "frontdepotOperationTypes"), [], "weight 0: no warning");
    assert.deepStrictEqual(warn({ EVEJS_LNE_EVENT_ANOMALIES_FRONTDEPOT_WEIGHT: "1" }, "frontdepotOperationTypes"), []);
    assert.strictEqual(warn({ EVEJS_LNE_EVENT_ANOMALIES_BREACH_WEIGHT: "1" }, "breach never triggers").length, 1);
    assert.deepStrictEqual(warn({ EVEJS_LNE_EVENT_ANOMALIES_BREACH_WEIGHT: "1", EVEJS_LNE_ABYSSAL_ENABLED: "1",
      EVEJS_LNE_ABYSSAL_PRESSURE_ENABLED: "1" }, "breach never triggers"), []);
    const many = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_ACTIVE_ANOMALIES: "300" };
    const capped = warn({ ...many, EVEJS_LNE_EVENT_ANOMALIES_FLAGWRECK_WEIGHT: "1" }, "flagwreckSalvageMaxRows=64");
    assert.strictEqual(capped.length, 1, capped.join("; "));
    assert.deepStrictEqual(warn(many, "flagwreckSalvageMaxRows"), [], "flagwreck weight 0: no warning");
    assert.deepStrictEqual(warn({ EVEJS_LNE_EVENT_ANOMALIES_FLAGWRECK_WEIGHT: "1" }, "flagwreckSalvageMaxRows"), [],
      "defaults 8 < 64: no warning");
    assert.deepStrictEqual(warn({ ...many, EVEJS_LNE_EVENT_ANOMALIES_FLAGWRECK_WEIGHT: "1",
      EVEJS_LNE_SALVAGE_ANOMALY_ENABLED: "0" }, "flagwreckSalvageMaxRows"), [], "salvage off: no warning");
    const file = findCompose();
    if (file === null) return;
    const { env } = readCompose(file);
    for (const k of SUB6) assert.strictEqual(env[`EVEJS_LNE_EVENT_ANOMALIES_${k.toUpperCase()}_WEIGHT`], "0", k);
  });
};
