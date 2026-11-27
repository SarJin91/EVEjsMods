"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createRng } = require("../../lib/util/rng");
const S = require("../../lib/heavyEvents/schema");
const P = require("../../lib/heavyEvents/power/schema");
const PC = require("../../lib/heavyEvents/power/catalog");
const W = require("../../lib/heavyEvents/world/schema");
const { chooseWorld, triggersOf, labelOf } = require("../../lib/heavyEvents/world/choose");
const { planWorldPass } = require("../../lib/heavyEvents/world/planner");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createReward } = require("../../lib/heavyEvents/reward");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { createFleetRepository } = require("../../lib/fleets/fleetRepository");
const { HULL_GROUPS, OPERATION_TYPES, OPEN_OPERATION_STATES } = require("../../lib/fleets/schema");
const { OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { harness: H } = require("../battle/settlement.test");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const EMPIRE = 500001;
const PIRATE = 500010;
const TRIG = 500026;
const SYS_A = 30000142;
const SYS_B = 30000144;
const SYS_C = 30000145;
const MINERALS = 50000;
const KINDS = new Map([[PIRATE, "pirate"], [EMPIRE, "empire"], [TRIG, "invader"]]);
const ECONOMY = [W.KIND.DESERTERS, W.KIND.SMUGGLING, W.KIND.FRONTDEPOT, W.KIND.WRECKEDCONVOY];

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const BUCKET = Math.floor(NOW / BASE.eventAnomalies.planIntervalMs);
const STEPS = BASE.heavyEvents.maxUpscaleSteps;
const FAT = Object.freeze(Object.fromEntries(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship",
  "logistics", "tackle", "ewar", "industrial"].map((g) => [g, 50])));
const HUGE = Object.freeze(Object.fromEntries(Object.keys(FAT).map((g) => [g, 500])));

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const worldCfg = (over) => ({ ...BASE.eventAnomalies, enabled: true, maxUpscaleSteps: STEPS, ...over });
const station = (stationId, systemId, hullStock = FAT) => ({ stationId, state: "ONLINE", systemId, hullStock,
  mineralUnits: 0 });
const fund = (factionId, ...stations) => new Map([[factionId, { stations }]]);
const sysOf = (controller) => ({ systemId: SYS_A, band: "nullsec", controllerFactionId: controller,
  previousControllerFactionId: null, occupationState: null, occupierFactionId: null });
const factsOf = (over) => ({ now: NOW, systems: [sysOf(EMPIRE)], kindOf: KINDS, losses: [], beachheads: [],
  factions: new Map(), open: [], lastWorldEndedAt: new Map(), ...over });

function fakesOf() {
  const sites = { calls: [], live: 0,
    createSiteInTx(_tx, req) {
      this.calls.push([req.eventId, req.siteKind || null, req.label]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    cleanupSitesInTx: () => ({ ok: true, released: 1 }),
    listSitesByEvent: (eventId) => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", siteKey: `lne:${eventId}`,
      position: { x: 1, y: 2, z: 3 } }] }),
    countLive() {
      return { ok: true, count: this.live };
    } };
  const occupation = { calls: [],
    dropInfluenceInTx(_tx, spec, key) {
      this.calls.push([spec.factionId, spec.points, key]);
      return { ok: true, outcome: "APPLIED", written: true };
    } };
  return { sites, occupation };
}

function planOnce(store, worldOver, extra) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const repo = createHeavyEventRepository({ journal });
  const { sites } = fakesOf();
  const systems = new Map([[SYS_A, sysOf(PIRATE)], [SYS_B, { systemId: SYS_B, controllerFactionId: EMPIRE,
    previousControllerFactionId: null, occupationState: "OCCUPIED", occupierFactionId: PIRATE }]]);
  const throwing = () => {
    throw new Error("graph neighbours read at weight 0");
  };
  const env = { store, repo, journal, settings: { ...BASE.heavyEvents }, power: { ...BASE.powerSites },
    world: { ...BASE.eventAnomalies, enabled: true, fundFromStock: false, hideoutWeight: 1, stagingWeight: 1,
      maxPlansPerPass: 2, ...worldOver },
    worldSeed: 7, maxActiveSites: BASE.sites.maxActiveSites,
    getStations: () => ({ getMode: () => "ready", repository: {} }), getSites: () => sites,
    getWorldRepository: () => ({ getSystem: (_tx, id) => ({ ok: true, system: systems.get(id) || null }) }),
    getInvasions: () => ({ listBeachheadsInTx: (_tx, opts) => ({ ok: true, truncated: false,
      beachheads: opts.systems.includes(SYS_A) ? [{ invasionId: "inv:1", factionId: TRIG, systemId: SYS_A }] : [] }) }),
    getBattleRepository: () => null,
    getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }),
      getNeighbors: throwing } }) }),
    getPresence: () => ({ getStatus: () => ({ available: true, stale: false }),
      observedWithin: () => ({ ok: true, systems: [[SYS_A, 0], [SYS_B, 1]] }) }),
    getFactionKind: (id) => KINDS.get(id) || null, factionName: () => null, ...extra };
  const result = planWorldPass(env, NOW, BUCKET);
  const rows = run(store, (tx) => tx.prepare("SELECT * FROM world_heavy_events ORDER BY event_id").all());
  return { result, rows, sites: sites.calls };
}

function rigOf(store) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: "st:p", kind: "upwell", structureFamily: "astrahus",
      systemId: SYS_B, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "ea5:st").ok);
    assert.ok(stations.applyStockChange(tx, { stationId: "st:p", key: "ea5:stock", reason: "seed", at: NOW,
      deltas: [{ itemKind: "mineral", itemKey: "type:34", delta: MINERALS }] }).ok);
  });
  const repo = createHeavyEventRepository({ journal });
  const { sites, occupation } = fakesOf();
  const world = { ...BASE.eventAnomalies, enabled: true, smugglingWeight: 1, wreckedconvoyWeight: 1 };
  const env = { store, repo, journal, settings: { ...BASE.heavyEvents }, power: { ...BASE.powerSites }, world,
    worldSeed: 7, maxActiveSites: BASE.sites.maxActiveSites, eventRewards: { ...BASE.eventRewards },
    fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId, sizedDefaultLoot: true,
    getStations: () => ({ getMode: () => "ready", repository: stations }), getSites: () => sites,
    getOccupation: () => occupation, getWorldRepository: () => null, getInvasions: () => null, admits: () => true,
    payoutRepo: null, factionName: () => null, getSeam: () => null };
  const engaged = (spec) => run(store, (tx) => {
    const members = PC.membersOf(spec.eventType, 1, spec.kind, 0, world).members;
    assert.ok(repo.planInTx(tx, { eventId: spec.eventId, planKey: `wa:1:${spec.eventId}`, eventType: spec.eventType,
      tier: 1, systemId: SYS_A, factionId: spec.factionId, beneficiaryFactionId: null, stationId: spec.stationId,
      members, funded: false, integrity: null, seed: 3, at: NOW, expiresAt: NOW + 3600000, dueAt: null,
      variant: spec.kind, affix: W.AFFIX_NONE }).ok);
    const row = repo.getInTx(tx, spec.eventId).row;
    return repo.transitionInTx(tx, { eventId: spec.eventId, expectedVersion: row.version, from: "PLANNED",
      to: "ENGAGED", at: NOW, patch: { phase: 1, scaleSteps: 0, engagedAt: NOW,
        members: row.members.map((m) => ({ ...m, state: "DESTROYED" })) } }).row;
  });
  const minerals = () => run(store, (tx) => stations.getStock(tx, "st:p")).items
    .filter((i) => i.itemKind === "mineral").reduce((a, i) => a + i.quantity, 0);
  const hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key)).found === true;
  const row = (id) => run(store, (tx) => repo.getInTx(tx, id).row);
  return { env, stations, occupation, engaged, minerals, hasKey, row };
}

module.exports = ({ test, skip }) => {
  test("EA5-1 chooseWorld: deserters / smuggling / frontdepot / wreckedconvoy at weight 1, none at 0; frontdepot funds "
    + "from the origin system", () => {
    const cases = [
      [W.KIND.DESERTERS, "outpost", "anomaly", EMPIRE, "Amarr Empire Mutineer Flotilla",
        factsOf({ treasury: new Map([[EMPIRE, { unpaidDays: 3 }]]), factions: fund(EMPIRE, station("st:e", SYS_C)) })],
      [W.KIND.SMUGGLING, "convoy", "anomaly", PIRATE, "Amarr Empire Smuggling Run",
        factsOf({ starved: [{ systemId: SYS_A, factionId: EMPIRE }], neighborControllers: new Map([[SYS_A, [PIRATE]]]),
          factions: fund(PIRATE, station("st:p", SYS_B)) })],
      [W.KIND.FRONTDEPOT, "cache", "signature", PIRATE, "Amarr Empire Forward Supply Cache",
        factsOf({ fronts: [{ systemId: SYS_A, factionId: PIRATE, originSystemId: SYS_B, operationId: "op:2" }],
          factions: fund(PIRATE, station("st:p", SYS_B)) })],
      [W.KIND.WRECKEDCONVOY, "cache", "signature", EMPIRE, "Amarr Empire Convoy Wreckage",
        factsOf({ lostConvoys: [{ systemId: SYS_A, factionId: EMPIRE, lostUnits: 50 }],
          factions: fund(EMPIRE, station("st:e", SYS_C)) })],
    ];
    for (const [kind, type, siteKind, factionId, label, facts] of cases) {
      const cfg = worldCfg({ [W.KIND_WEIGHT_KEY[kind]]: 1 });
      for (let seed = 1; seed <= 6; seed += 1) {
        const r = chooseWorld(facts, cfg, createRng(seed));
        assert.ok(r.ok, `${kind} ${JSON.stringify(r)}`);
        const c = r.candidate;
        assert.deepStrictEqual([c.kind, c.eventType, c.variant, c.systemId, c.factionId, c.funded, c.siteKind],
          [kind, type, kind, SYS_A, factionId, true, siteKind], kind);
        assert.ok(c.tier >= 1 && c.tier <= W.TIER_COUNT, `${kind} tier ${c.tier}`);
      }
      assert.strictEqual(labelOf("Amarr Empire", kind), label);
      assert.deepStrictEqual(triggersOf(facts, worldCfg({})).byKind.get(kind), [], `${kind} weight 0`);
      assert.deepStrictEqual(chooseWorld(facts, worldCfg({}), createRng(1)), { ok: false, reason: "TYPE_OFF" });
    }
    const few = factsOf({ treasury: new Map([[EMPIRE, { unpaidDays: 2 }]]), factions: fund(EMPIRE, station("e", 1)) });
    assert.deepStrictEqual(chooseWorld(few, worldCfg({ desertersWeight: 1 }), createRng(1)),
      { ok: false, reason: "NO_TRIGGER" });
    const front = (originSystemId) => factsOf({ fronts: [{ systemId: SYS_A, factionId: PIRATE, originSystemId,
      operationId: "op:1" }], factions: fund(PIRATE, station("st:a-big", SYS_C, HUGE), station("st:b-home", SYS_B)) });
    const cfg = worldCfg({ frontdepotWeight: 1 });
    for (let seed = 1; seed <= 6; seed += 1) {
      assert.strictEqual(chooseWorld(front(SYS_B), cfg, createRng(seed)).candidate.stationId, "st:b-home");
      assert.strictEqual(chooseWorld(front(null), cfg, createRng(seed)).candidate.stationId, "st:a-big");
    }
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("EA5-2-EA5-4 store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("EA5-2 bit for bit: weights 0 never call the new facades; refused reads -> readRefused, other kinds plan the "
    + "same; chooseWorld ignores the economic facts at weights 0", async () => {
    const calls = [];
    const thrower = (name) => () => {
      calls.push(name);
      throw new Error(`${name} called`);
    };
    const throwing = { getTreasury: thrower("treasury"), getLogistics: thrower("logistics"),
      getFleetRepository: thrower("fleets") };
    const plain = await H.withStore(driver, (reopen) => planOnce(reopen().store, {}, {}));
    const off = await H.withStore(driver, (reopen) => planOnce(reopen().store, {}, throwing));
    assert.ok(plain.result.ok && plain.result.planned >= 1, JSON.stringify(plain.result));
    assert.deepStrictEqual([off.result, off.rows, off.sites], [plain.result, plain.rows, plain.sites]);
    assert.deepStrictEqual([calls, plain.result.readRefused], [[], {}]);
    const weights = Object.fromEntries(ECONOMY.map((k) => [W.KIND_WEIGHT_KEY[k], 1]));
    const on = await H.withStore(driver, (reopen) => planOnce(reopen().store, weights, throwing));
    assert.deepStrictEqual(on.result.readRefused, Object.fromEntries(ECONOMY.map((k) => [k, true])));
    assert.deepStrictEqual(on.result.plans, plain.result.plans, "hideout / staging plan as before");
    assert.deepStrictEqual(calls.sort(), ["fleets", "logistics", "treasury"]);
    const sub1 = factsOf({ systems: [sysOf(PIRATE), { systemId: SYS_B, band: "nullsec", controllerFactionId: EMPIRE,
      occupationState: "OCCUPIED", occupierFactionId: PIRATE }], losses: [{ systemId: SYS_A, factionId: PIRATE,
      count: 20 }], factions: fund(PIRATE, station("st:1", SYS_A, { ...FAT, dreadnought: 50 })) });
    const extra = { treasury: new Map([[PIRATE, { unpaidDays: 9 }]]), starved: [{ systemId: SYS_A, factionId: EMPIRE }],
      neighborControllers: new Map([[SYS_A, [PIRATE]]]), lostConvoys: [{ systemId: SYS_A, factionId: PIRATE,
        lostUnits: 9 }], fronts: [{ systemId: SYS_B, factionId: PIRATE, originSystemId: SYS_A, operationId: "o" }] };
    const sub1Cfg = worldCfg({ warcampWeight: 1, hideoutWeight: 1 });
    for (let seed = 1; seed <= 8; seed += 1) {
      const without = chooseWorld(sub1, sub1Cfg, createRng(seed));
      assert.ok(without.ok, JSON.stringify(without));
      assert.deepStrictEqual(chooseWorld({ ...sub1, ...extra }, sub1Cfg, createRng(seed)), without);
    }
  });

  test("EA5-6 frontdepot: 4 open mining operations with smaller ids do not push the invasion out of "
    + "frontdepotMaxOpsPerSystem (one read per type)", async () => {
    const op = (operationId, operationType, factionId) => ({ operationId, operationType, factionId, state: "ACTIVE",
      targetSystemId: SYS_A, originSystemId: SYS_B });
    const ops = [1, 2, 3, 4].map((n) => op(`op:${n}`, "mining", EMPIRE)).concat([op("op:5", "invasion", PIRATE)]);
    const calls = [];
    const fleets = { listOperationsByTarget: (_tx, systemId, opts) => {
      calls.push([systemId, opts.operationType === undefined ? null : opts.operationType]);
      if (opts.operationType !== undefined && !OPERATION_TYPES.includes(opts.operationType)) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      return { ok: true, operations: ops.filter((o) => o.targetSystemId === systemId && opts.states.includes(o.state)
        && (opts.operationType === undefined || o.operationType === opts.operationType))
        .sort((a, b) => (a.operationId < b.operationId ? -1 : 1)).slice(0, opts.limit) };
    } };
    assert.strictEqual(BASE.eventAnomalies.frontdepotMaxOpsPerSystem, 4);
    const r = await H.withStore(driver, (reopen) => planOnce(reopen().store, { hideoutWeight: 0, stagingWeight: 0,
      frontdepotWeight: 1, maxPlansPerPass: 1 }, { getFleetRepository: () => fleets }));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.plans.map((p) => [p.kind, p.systemId]), [[W.KIND.FRONTDEPOT, SYS_A]],
      JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.readRefused, {});
    assert.deepStrictEqual(calls, [[SYS_A, "invasion"], [SYS_A, "raid"], [SYS_B, "invasion"], [SYS_B, "raid"]]);
  });

  test("EA5-7: a throwing neighbour getSystem refuses smuggling only (readRefused.smuggling), the "
    + "other kinds plan the same", async () => {
    const victims = { listStationsInSystem: (_tx, systemId) => ({ ok: true, records: systemId === SYS_A
      ? [{ stationId: "st:v", state: "ONLINE", ownerFactionId: EMPIRE, systemId: SYS_A }] : [] }),
    getStocks: () => ({ ok: true, byStation: new Map([["st:v", { items: [] }]]) }) };
    const systems = new Map([[SYS_A, sysOf(PIRATE)], [SYS_B, { systemId: SYS_B, controllerFactionId: EMPIRE,
      previousControllerFactionId: null, occupationState: "OCCUPIED", occupierFactionId: PIRATE }]]);
    const extra = { getStations: () => ({ getMode: () => "ready", repository: victims }),
      getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }),
        getNeighbors: () => [SYS_C] } }) }),
      getWorldRepository: () => ({ getSystem: (_tx, id) => {
        if (id === SYS_C) throw new Error("neighbour read failed");
        return { ok: true, system: systems.get(id) || null };
      } }) };
    const plain = await H.withStore(driver, (reopen) => planOnce(reopen().store, {}, {}));
    const r = await H.withStore(driver, (reopen) => planOnce(reopen().store, { smugglingWeight: 1 }, extra));
    assert.ok(r.result.ok, JSON.stringify(r.result));
    assert.deepStrictEqual(r.result.readRefused, { [W.KIND.SMUGGLING]: true });
    assert.deepStrictEqual(r.result.plans, plain.result.plans, "hideout / staging plan as before");
  });

  test("EA5-3 smuggling CLEARED drains the pirate station once (<eventId>:drain); a world cache row without a station "
    + "places its chest", () => H.withStore(driver, (reopen) => {
    const { store } = reopen();
    const h = rigOf(store);
    const counters = {};
    const refusals = [];
    const hooks = { bump: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    }, refuse: (text) => refusals.push(text) };
    const live = createLive(h.env, hooks);
    const smuggling = h.engaged({ eventId: "hwa:5:0", eventType: "convoy", kind: W.KIND.SMUGGLING,
      factionId: PIRATE, stationId: "st:p" });
    const haulers = smuggling.members.filter((m) => m.role === P.ROLE.HAULER).length;
    const units = Math.floor((MINERALS * BASE.powerSites.convoyDrainPermillePerHauler * haulers) / 1000);
    const first = run(store, (tx) => live.clearInTx(tx, smuggling, NOW + 1000, {}, []));
    assert.deepStrictEqual([first.duplicate, first.drain.outcome, first.drain.total, haulers], [false, "APPLIED",
      units, 3]);
    assert.deepStrictEqual([h.minerals(), h.hasKey(P.drainKeyOf("hwa:5:0"))], [MINERALS - units, true]);
    const again = run(store, (tx) => live.clearInTx(tx, smuggling, NOW + 1000, {}, []));
    assert.deepStrictEqual([again.duplicate, again.drain, h.minerals()], [true, null, MINERALS - units]);
    assert.deepStrictEqual(h.occupation.calls, [[PIRATE, BASE.eventAnomalies.smugglingInfluencePoints,
      S.influenceKeyOf("hwa:5:0")]]);
    const wreck = h.engaged({ eventId: "hwa:5:1", eventType: "cache", kind: W.KIND.WRECKEDCONVOY, factionId: EMPIRE,
      stationId: null });
    assert.strictEqual(run(store, (tx) => live.clearInTx(tx, wreck, NOW + 1000, {}, [])).duplicate, false);
    const wrecks = { ok: true, places: [], readGrid: () => ({ ok: true, sceneLoaded: true }),
      place(spec) {
        this.places.push(spec);
        return { ok: true, adopted: false, wreckId: 700 + this.places.length, items: 3, factionItems: 0,
          vendorWrites: 0 };
      } };
    createReward({ ...h.env, getWrecks: () => wrecks }, hooks).pass(NOW + 1000 + BASE.heavyEvents.rewardWaitMs);
    const done = h.row("hwa:5:1");
    assert.deepStrictEqual([done.state, done.rewardState], ["COMPLETED", "PLACED"], JSON.stringify({ counters, refusals, places: wrecks.places.length }));
    assert.ok(!h.hasKey(P.drainKeyOf("hwa:5:1")), "no drain without a station");
    assert.strictEqual(h.minerals(), MINERALS - units, "the convoy chest takes its minerals from result.drain");
    assert.strictEqual(wrecks.places.length, 2);
  }));

  test("EA5-4 real facades: fleet / station repositories have the plan methods and accept its calls; default "
    + "frontdepot types open a front; weights 0 in SCHEMA and compose", () => H.withStore(driver, (reopen) => {
    const { store } = reopen();
    const clock = { now: () => NOW };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const fleets = createFleetRepository({ journal, clock, ids: { next: (p) => `${p}:1` }, worldSeed: 1,
      limits: { maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16,
        maxJsonBytes: 4096, maxListLimit: 500 } });
    const stations = rigOf(store).stations;
    for (const name of W.FRONTDEPOT_FLEET_METHODS) assert.strictEqual(typeof fleets[name], "function", name);
    for (const name of W.SMUGGLING_STATION_METHODS) assert.strictEqual(typeof stations[name], "function", name);
    assert.deepStrictEqual(run(store, (tx) => fleets.listOperationsByTarget(tx, SYS_A, {
      states: [...OPEN_OPERATION_STATES], limit: BASE.eventAnomalies.frontdepotMaxOpsPerSystem })),
    { ok: true, operations: [] });
    assert.deepStrictEqual(run(store, (tx) => fleets.listOperationsByTarget(tx, SYS_A, {
      states: [...OPEN_OPERATION_STATES], operationType: "invasion",
      limit: BASE.eventAnomalies.frontdepotMaxOpsPerSystem })), { ok: true, operations: [] });
    const listed = run(store, (tx) => stations.listStationsInSystem(tx, SYS_B));
    assert.deepStrictEqual(listed.records.map((r) => [r.stationId, r.ownerFactionId, r.state]),
      [["st:p", PIRATE, "ONLINE"]]);
    const stocks = run(store, (tx) => stations.getStocks(tx, ["st:p"]));
    assert.ok(stocks.ok && stocks.byStation instanceof Map && stocks.byStation.has("st:p"), JSON.stringify(stocks));
    const types = W.parseOperationTypes(BASE.eventAnomalies.frontdepotOperationTypes);
    assert.deepStrictEqual(types, ["invasion", "raid"]);
    for (const t of types) {
      assert.ok(OPERATION_TYPES.includes(t), t);
      assert.strictEqual(OPERATION_KINDS_V1.find((k) => k.operationType === t).opensFront, true, t);
    }
    for (const text of ["", "Invasion", "raid,raid", "a,b,c,d,e,f,g,h,i", 7]) {
      assert.strictEqual(W.parseOperationTypes(text), null, String(text));
    }
    const ea = BASE.eventAnomalies;
    assert.deepStrictEqual(ECONOMY.map((k) => ea[W.KIND_WEIGHT_KEY[k]]), [0, 0, 0, 0]);
    const file = findCompose();
    if (file === null) return;
    const { env } = readCompose(file);
    for (const k of ECONOMY) assert.strictEqual(env[`EVEJS_LNE_EVENT_ANOMALIES_${k.toUpperCase()}_WEIGHT`], "0", k);
  }));
};
