"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig, SCHEMA } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { hullDeltas } = require("../../lib/stations/stockKeys");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { createRng } = require("../../lib/util/rng");
const S = require("../../lib/heavyEvents/schema");
const P = require("../../lib/heavyEvents/power/schema");
const PC = require("../../lib/heavyEvents/power/catalog");
const W = require("../../lib/heavyEvents/world/schema");
const WC = require("../../lib/heavyEvents/world/catalog");
const L = require("../../lib/heavyEvents/layer");
const { chooseWorld } = require("../../lib/heavyEvents/world/choose");
const { choosePower } = require("../../lib/heavyEvents/power/choose");
const { peakOf } = require("../../lib/heavyEvents/power/planner");
const { startHeavyEvents } = require("../../lib/heavyEvents");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createReward } = require("../../lib/heavyEvents/reward");
const { pumpPlanned } = require("../../lib/heavyEvents/planner");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const PIRATE = 500010;
const OTHER = 500011;
const SYS_A = 30000142;
const SYS_B = 30000144;
const SYS_C = 30000145;
const STATION = "st:wa:1";
const GROUPS = ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics", "dreadnought"];
const STOCK = 50;

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const WA_BUCKET = Math.floor(NOW / BASE.eventAnomalies.planIntervalMs);
const STEPS = BASE.heavyEvents.maxUpscaleSteps;

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

const fullStock = () => Object.fromEntries(GROUPS.map((g) => [g, STOCK]));
const worldCfg = (over) => ({ ...BASE.eventAnomalies, enabled: true, maxUpscaleSteps: STEPS, ...over });

function factsOf(over) {
  return { now: NOW,
    systems: [
      { systemId: SYS_A, band: "nullsec", controllerFactionId: PIRATE, occupationState: null, occupierFactionId: null },
      { systemId: SYS_B, band: "nullsec", controllerFactionId: OTHER, occupationState: "OCCUPIED",
        occupierFactionId: PIRATE }],
    kindOf: new Map([[PIRATE, "pirate"], [OTHER, "empire"]]),
    losses: [{ systemId: SYS_A, factionId: PIRATE, count: 20 }],
    factions: new Map([[PIRATE, { stations: [{ stationId: STATION, state: "ONLINE", hullStock: fullStock() }] }]]),
    open: [], lastWorldEndedAt: new Map(), ...over };
}

function configOf(worldOver, powerOver) {
  const modules = { ...BASE.modules, world: { ...BASE.modules.world, enabled: true },
    sites: { ...BASE.modules.sites, enabled: true } };
  return { ...BASE, enabled: true, modules, heavyEvents: { ...BASE.heavyEvents, enabled: false },
    powerSites: { ...BASE.powerSites, enabled: false, ...powerOver },
    eventAnomalies: { ...BASE.eventAnomalies, ...worldOver } };
}

function harness(store) {
  const h = { now: NOW, systems: new Map([
    [SYS_A, { systemId: SYS_A, controllerFactionId: PIRATE, occupationState: null, occupierFactionId: null }],
    [SYS_B, { systemId: SYS_B, controllerFactionId: OTHER, occupationState: "OCCUPIED", occupierFactionId: PIRATE }]]),
  losses: [{ systemId: SYS_A, settledAt: NOW - 60000, factionId: PIRATE, typeId: 603, count: 20 }] };
  const clock = { now: () => h.now };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS_C, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "wat:st").ok);
    const deltas = hullDeltas(GROUPS.map((hullGroup) => ({ hullGroup, count: STOCK })), 1).deltas;
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "wat:stock", reason: "seed", at: NOW,
      deltas }).ok);
  });
  const sites = { calls: [], live: 0,
    createSiteInTx(tx, req) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(["create", req.eventId, req.slot, req.siteKind || null, req.label]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(["cleanup", eventId, reason]);
      return { ok: true, released: 1 };
    },
    listSitesByEvent: (eventId) => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", siteKey: `lne:${eventId}`,
      position: { x: 1, y: 2, z: 3 } }] }),
    countLive() {
      return { ok: true, count: this.live };
    } };
  const occupation = { calls: [],
    dropInfluenceInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push([spec.factionId, spec.points, key]);
      return { ok: true, outcome: "APPLIED", written: true };
    } };
  const battleRepo = { calls: [],
    listVirtualLossesSince(tx, opts) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(opts);
      return { ok: true, losses: h.losses.filter((l) => l.settledAt >= opts.sinceMs).slice(0, opts.limit),
        truncated: false };
    } };
  const worldRepository = { getSystem: (_tx, id) => ({ ok: true, system: h.systems.get(id) || { systemId: id,
    controllerFactionId: PIRATE, occupationState: null, occupierFactionId: null } }) };
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 },
    stations: { getMode: () => "ready", repository: stations }, sites, occupation,
    world: { repository: worldRepository }, battle: { repository: battleRepo },
    graph: { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }) },
    presence: { getStatus: () => ({ available: true, stale: false }), isObserved: () => false,
      observedWithin: () => ({ ok: true, systems: [SYS_A, SYS_B].map((id, i) => [id, i]) }) } };
  const start = (config) => startHeavyEvents({ config, ctx, clock, getFactionKind: (id) => (id === PIRATE ? "pirate"
    : "empire"), setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
  const repo = createHeavyEventRepository({ journal });
  const hulls = () => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
  const rows = () => run(store, (tx) => repo.listOpenInTx(tx, { limit: 64 }).rows);
  const row = (id) => run(store, (tx) => repo.getInTx(tx, id).row);
  const hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key)).found === true;
  return Object.assign(h, { ctx, sites, occupation, battleRepo, worldRepository, stations, journal, repo, start,
    hulls, rows, row, hasKey, clock });
}

function planWorld(store, h, spec) {
  const type = W.MECHANIC_OF[spec.kind];
  const members = PC.membersOf(type, spec.tier, spec.kind, STEPS, BASE.eventAnomalies);
  assert.ok(members.ok, JSON.stringify(members));
  run(store, (tx) => {
    if (spec.funded) {
      const comp = PC.maxComposition(type, spec.tier, spec.kind, STEPS, BASE.eventAnomalies);
      assert.ok(h.stations.applyStockChange(tx, { stationId: STATION, key: S.fundKeyOf(spec.eventId),
        reason: "heavy_event_fund", at: NOW, deltas: hullDeltas(comp.composition, -1).deltas }).ok);
    }
    const r = h.repo.planInTx(tx, { eventId: spec.eventId, planKey: `wa:1:${spec.eventId}`, eventType: type,
      tier: spec.tier, systemId: spec.systemId, factionId: PIRATE, beneficiaryFactionId: null,
      stationId: spec.funded ? STATION : null, members: members.members, funded: spec.funded === true,
      integrity: null, seed: 3, at: NOW, expiresAt: NOW + 3600000, dueAt: null, variant: spec.kind,
      affix: W.AFFIX_NONE });
    assert.ok(r.ok, JSON.stringify(r));
  });
  return members.members;
}

function envOf(store, h, worldOver) {
  return { store, repo: h.repo, journal: h.journal, settings: { ...BASE.heavyEvents, enabled: false },
    power: { ...BASE.powerSites, enabled: false }, world: { ...BASE.eventAnomalies, ...worldOver },
    worldSeed: 7, maxActiveSites: BASE.sites.maxActiveSites, eventRewards: { ...BASE.eventRewards },
    fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId,
    getStations: () => h.ctx.stations, getSites: () => h.sites, getWorldRepository: () => h.worldRepository,
    getOccupation: () => h.occupation, admits: () => true, payoutRepo: null, factionName: () => null };
}

module.exports = ({ test, skip }) => {
  test("WA1 layerOfRow: power / heavy / world by the event id; world kinds apart from power; peaks <= 24", () => {
    assert.deepStrictEqual([L.PREFIX_OF.heavy, L.PREFIX_OF.power, L.PREFIX_OF.world, L.PREFIX_OF.incursion],
      [S.KEY_PREFIX, P.KEY_PREFIX, W.KEY_PREFIX, require("../../lib/factionIncursions/schema").SITE_EVENT_PREFIX]);
    for (const type of P.POWER_TYPES) {
      for (const variant of P.VARIANTS[type]) {
        const row = { eventId: P.eventIdOf(12, 1), eventType: type, variant };
        assert.strictEqual(L.layerOfRow(row), "power", `${type}/${variant}`);
      }
    }
    for (const type of S.HEAVY_TYPES) assert.strictEqual(L.layerOfRow({ eventId: S.eventIdOf(3, 0), eventType: type }), "heavy");
    assert.strictEqual(L.layerOfRow({ eventId: W.eventIdOf(3, 0), eventType: "muster" }), "world");
    assert.deepStrictEqual([L.layerOfRow({ eventId: "xyz:1:0" }), L.layerOfRow(null), L.layerOfEventId("hwa")],
      [null, null, null]);
    assert.deepStrictEqual(L.layerIdRange("world"), { from: "hwa:", to: "hwa;" });
    const powerVariants = Object.values(P.VARIANTS).flat();
    for (const kind of W.KINDS) {
      const type = W.MECHANIC_OF[kind];
      assert.ok(kind.length <= 16 && !powerVariants.includes(kind), kind);
      assert.ok(!Object.keys(PC.TIERS[type]).includes(kind), `power TIERS ${type} has ${kind}`);
      assert.ok(WC.isWorldVariant(type, kind) && !WC.isWorldVariant(type, P.VARIANTS[type][0]));
      for (let tier = 1; tier <= W.TIER_COUNT; tier += 1) {
        const peak = peakOf(type, tier, kind, { ...BASE.eventAnomalies, maxUpscaleSteps: 3 });
        assert.ok(peak !== null && peak <= 24, `${kind} ${tier} peak ${peak}`);
        assert.strictEqual(PC.tierDefOf(type, tier, kind).def.rewardProfile, WC.META[kind].rewardProfiles[tier - 1]);
      }
    }
  });

  test("WA2 chooseWorld: warcamp tier II anomaly, hideout signature, BUSY / COOLDOWN / per kind, same seed", () => {
    const warcamp = chooseWorld(factsOf(), worldCfg({ warcampWeight: 1 }), createRng(11));
    assert.ok(warcamp.ok, JSON.stringify(warcamp));
    const c = warcamp.candidate;
    assert.deepStrictEqual([c.kind, c.eventType, c.systemId, c.factionId, c.tier, c.siteKind, c.funded, c.stationId],
      ["warcamp", "muster", SYS_A, PIRATE, 2, "anomaly", true, STATION]);
    assert.strictEqual(c.total, PC.maxComposition("muster", 2, "warcamp", STEPS, BASE.eventAnomalies).total);
    const hideout = chooseWorld(factsOf(), worldCfg({ hideoutWeight: 1 }), createRng(11));
    assert.ok(hideout.ok, JSON.stringify(hideout));
    assert.deepStrictEqual([hideout.candidate.kind, hideout.candidate.eventType, hideout.candidate.systemId,
      hideout.candidate.factionId, hideout.candidate.siteKind], ["hideout", "hunt", SYS_B, PIRATE, "signature"]);
    const only = worldCfg({ warcampWeight: 1 });
    const busy = factsOf({ open: [{ systemId: SYS_A, factionId: OTHER, eventType: "redoubt", variant: null,
      state: "PLANNED", layer: "heavy" }] });
    assert.deepStrictEqual(chooseWorld(busy, only, createRng(11)), { ok: false, reason: "BUSY" });
    const cooled = factsOf({ lastWorldEndedAt: new Map([[SYS_A, NOW - 1000]]) });
    assert.deepStrictEqual(chooseWorld(cooled, only, createRng(11)), { ok: false, reason: "COOLDOWN" });
    const perKind = factsOf({ open: [{ systemId: SYS_C, factionId: OTHER, eventType: "muster", variant: "warcamp",
      state: "PLANNED", layer: "world" }] });
    assert.deepStrictEqual(chooseWorld(perKind, only, createRng(11)), { ok: false, reason: "LIMIT" });
    const both = worldCfg({ warcampWeight: 1, hideoutWeight: 1 });
    assert.deepStrictEqual(chooseWorld(factsOf(), both, createRng(5)), chooseWorld(factsOf(), both, createRng(5)));
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("WA3-WA5 event anomalies store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("WA3 world plan: off = nothing; row hwa: + beacon + fund once per bucket; no power limit taken", () => {
      withStore(driver, ({ store }) => {
        const h = harness(store);
        assert.deepStrictEqual(h.start(configOf({})), { ok: false, reason: "disabled_by_config" });
        const before = h.hulls();
        const config = configOf({ enabled: true, warcampWeight: 1 });
        let svc = h.start(config).heavyEvents;
        svc.runPass(NOW);
        const eventId = W.eventIdOf(WA_BUCKET, 0);
        const r = h.row(eventId);
        assert.ok(r, JSON.stringify(svc.getStatus()));
        assert.deepStrictEqual([r.eventType, r.variant, r.affix, r.tier, r.systemId, r.state, r.funded, r.planKey],
          ["muster", "warcamp", "none", 2, SYS_A, "PLANNED", true,
            W.planKeyOf(BASE.eventAnomalies.planIntervalMs, WA_BUCKET, 0)]);
        const funded = PC.maxComposition("muster", 2, "warcamp", STEPS, BASE.eventAnomalies).total;
        assert.strictEqual(h.hulls(), before - funded);
        assert.ok(h.hasKey(S.fundKeyOf(eventId)));
        assert.deepStrictEqual(h.sites.calls, [["create", eventId, 0, "anomaly", "Regroup Camp"]]);
        const c = svc.getStatus().counters;
        assert.deepStrictEqual([c["anomaly.planned"], c["anomaly.planned.warcamp"], c["planned.muster"],
          c["power.planned"]], [1, 1, 1, 0]);
        svc.stop("test");
        svc = h.start(config).heavyEvents;
        svc.runPass(NOW + 60000);
        assert.deepStrictEqual([svc.getStatus().counters["anomaly.planned"], h.sites.calls.length, h.rows().length,
          h.hulls()], [0, 1, 1, before - funded]);
        svc.stop("test");
        const open = h.rows().map((x) => ({ systemId: x.systemId, factionId: x.factionId, eventType: x.eventType,
          state: x.state, layer: L.layerOfRow(x) }));
        const pf = { now: NOW, systems: [{ systemId: SYS_C, band: "nullsec", controllerFactionId: PIRATE,
          controllerKind: "pirate" }], factions: new Map([[PIRATE, { stations: [{ stationId: STATION,
          state: "ONLINE", hullStock: fullStock(), mineralUnits: 0 }] }]]), lastPowerEndedAt: new Map() };
        const pc = { ...BASE.powerSites, maxOpen: 1, maxOpenPerFaction: 1, maxOpenPerType: 1, cacheWeight: 0,
          convoyWeight: 0, maxUpscaleSteps: STEPS };
        const withWorld = choosePower({ ...pf, open }, pc, createRng(9));
        assert.ok(withWorld.ok, JSON.stringify(withWorld));
        assert.deepStrictEqual(withWorld, choosePower({ ...pf, open: [] }, pc, createRng(9)));
      });
    });

    test("WA4 drain: flag off -> CANCELLED DISABLED with the hulls back; hideout occupier changed -> CANCELLED", () => {
      withStore(driver, ({ store }) => {
        const h = harness(store);
        const before = h.hulls();
        planWorld(store, h, { eventId: "hwa:1:0", kind: "warcamp", tier: 1, systemId: SYS_A, funded: true });
        assert.ok(h.hulls() < before);
        const off = pumpPlanned(envOf(store, h, { enabled: false, warcampWeight: 1 }), NOW + 1000);
        assert.deepStrictEqual([off.world, off.disabled, off.cancelled, off.errors], [{ DISABLED: 1 }, 0, 0, 0]);
        const r = h.row("hwa:1:0");
        assert.deepStrictEqual([r.state, r.endReason, h.hulls()], ["CANCELLED", "DISABLED", before]);
        assert.ok(h.hasKey(S.returnKeyOf("hwa:1:0")));
        planWorld(store, h, { eventId: "hwa:2:0", kind: "hideout", tier: 1, systemId: SYS_B });
        const on = envOf(store, h, { enabled: true, hideoutWeight: 1 });
        assert.deepStrictEqual(pumpPlanned(on, NOW + 2000).world, {});
        h.systems.set(SYS_B, { systemId: SYS_B, controllerFactionId: OTHER, occupationState: "OCCUPIED",
          occupierFactionId: OTHER });
        assert.deepStrictEqual(pumpPlanned(on, NOW + 3000).world, { CANCELLED: 1 });
        assert.deepStrictEqual([h.row("hwa:2:0").state, h.row("hwa:2:0").endReason], ["CANCELLED", "CANCELLED"]);
      });
    });

    test("WA5 CLEARED warcamp: warcampInfluencePoints, wavesCleared; chest hwarwd: with the tier profile", () => {
      withStore(driver, ({ store }) => {
        const h = harness(store);
        const eventId = "hwa:3:0";
        planWorld(store, h, { eventId, kind: "warcamp", tier: 2, systemId: SYS_A });
        const waves = PC.phaseCountOf("muster", 2, "warcamp", BASE.eventAnomalies);
        const env = envOf(store, h, { enabled: true, warcampWeight: 1, warcampRolls: "1,2,3" });
        const counters = {};
        const hooks = { bump: (name, n = 1) => {
          assert.ok(S.COUNTER_NAMES.includes(name), `counter ${name} not in COUNTER_NAMES`);
          counters[name] = (counters[name] || 0) + n;
        }, refuse: () => {} };
        const live = createLive({ ...env, getSeam: () => null }, hooks);
        run(store, (tx) => {
          const row = h.repo.getInTx(tx, eventId).row;
          const members = row.members.map((m) => (m.phase === 1 ? { ...m, state: "DESTROYED" } : m));
          const engaged = h.repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "PLANNED",
            to: "ENGAGED", at: NOW, patch: { phase: waves, scaleSteps: 0, engagedAt: NOW, members } }).row;
          const cleared = live.clearInTx(tx, engaged, NOW + 1000);
          assert.strictEqual(cleared.duplicate, false);
        });
        assert.deepStrictEqual(h.occupation.calls, [[PIRATE, BASE.eventAnomalies.warcampInfluencePoints,
          S.influenceKeyOf(eventId)]]);
        const cleared = h.row(eventId);
        assert.deepStrictEqual([cleared.state, cleared.result.wavesCleared], ["CLEARED", waves]);
        const wrecks = { ok: true, places: [], readGrid: () => ({ ok: true, sceneLoaded: true }),
          place(spec) {
            this.places.push(spec);
            return { ok: true, adopted: false, wreckId: 700, items: 3, factionItems: 1, vendorWrites: 0 };
          } };
        const reward = createReward({ ...env, getWrecks: () => wrecks }, hooks);
        reward.pass(NOW + 1000 + BASE.heavyEvents.rewardWaitMs);
        const done = h.row(eventId);
        assert.deepStrictEqual([done.state, done.rewardState], ["COMPLETED", "PLACED"]);
        assert.strictEqual(wrecks.places.length, 1);
        assert.deepStrictEqual([wrecks.places[0].hullGroup, wrecks.places[0].lootRolls],
          ["battlecruiser", Math.min(2 * waves, BASE.eventAnomalies.maxLootRolls)]);
        assert.ok(h.hasKey(W.rewardKeyOf(Math.floor(NOW / 86400000), SYS_A, eventId)));
        assert.deepStrictEqual([counters["anomaly.reward.placed"], counters["power.reward.placed"]], [1, undefined]);
      });
    });

    test("WA7 failed world chest: anomaly.reward.failed counted, row stays CLEARED with reward_attempts + 1", () => {
      withStore(driver, ({ store }) => {
        const h = harness(store);
        const eventId = "hwa:4:0";
        planWorld(store, h, { eventId, kind: "warcamp", tier: 1, systemId: SYS_A });
        const waves = PC.phaseCountOf("muster", 1, "warcamp", BASE.eventAnomalies);
        const env = envOf(store, h, { enabled: true, warcampWeight: 1 });
        const counters = {};
        const hooks = { bump: (name, n = 1) => {
          if (S.COUNTER_NAMES.includes(name)) counters[name] = (counters[name] || 0) + n;
        }, refuse: () => {} };
        const live = createLive({ ...env, getSeam: () => null }, hooks);
        run(store, (tx) => {
          const row = h.repo.getInTx(tx, eventId).row;
          const members = row.members.map((m) => ({ ...m, state: "DESTROYED" }));
          const engaged = h.repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "PLANNED",
            to: "ENGAGED", at: NOW, patch: { phase: waves, scaleSteps: 0, engagedAt: NOW, members } }).row;
          live.clearInTx(tx, engaged, NOW + 1000);
        });
        const wrecks = { ok: true, readGrid: () => ({ ok: true, sceneLoaded: true }),
          place: () => ({ ok: false, reason: "PLACE_FAILED" }) };
        createReward({ ...env, getWrecks: () => wrecks }, hooks).pass(NOW + 1000 + BASE.heavyEvents.rewardWaitMs);
        const after = h.row(eventId);
        assert.deepStrictEqual([after.state, after.rewardAttempts], ["CLEARED", 1]);
        assert.deepStrictEqual([counters["anomaly.reward.failed"], counters["anomaly.reward.placed"]], [1, undefined]);
        assert.ok(S.COUNTER_NAMES.includes("power.reward.failed") && S.COUNTER_NAMES.includes("anomaly.reward.failed"));
      });
    });

    test("WA8 live world muster: dueAt and wave 2 from eventAnomalies, not powerSites", () => {
      withStore(driver, ({ store }) => {
        const h = harness(store);
        const eventId = "hwa:5:0";
        const planned = planWorld(store, h, { eventId, kind: "warcamp", tier: 1, systemId: SYS_A });
        const ea = BASE.eventAnomalies;
        const env = { ...envOf(store, h, { enabled: true, warcampWeight: 1, musterWaveIntervalMs: 1000 }),
          power: { ...BASE.powerSites, enabled: false, musterWaves: ea.musterWaves + 2, musterWaveIntervalMs: 999000,
            musterWaveGrowthPermille: ea.musterWaveGrowthPermille + 600 } };
        const spawns = [];
        let nextId = 9000;
        const seam = { readGrid: () => ({ ok: true, players: [{ characterId: 1 }], copies: 0 }),
          spawnPhase(_sys, input) {
            spawns.push(input.members.map((m) => m.memberKey));
            const spawned = input.members.map((m) => ({ memberKey: m.memberKey, entityId: nextId++,
              hullGroup: m.hullGroup }));
            return { ok: true, spawned, unspawnable: [] };
          },
          readMembers: (_sys, ids) => ({ ok: true, live: ids.map((entityId) => ({ entityId, position: null })),
            gone: [] }),
          despawn: (_sys, ids) => ({ ok: true, removed: ids.length, missing: 0 }) };
        const live = createLive({ ...env, getSeam: () => seam,
          getPresence: () => ({ isObserved: (id) => id === SYS_A }) }, { bump: () => {}, refuse: () => {} });
        live.pass(NOW);
        let r = h.row(eventId);
        assert.deepStrictEqual([r.state, r.phase, r.dueAt], ["ENGAGED", 1, NOW + 1000]);
        live.pass(NOW + 1000);
        r = h.row(eventId);
        assert.deepStrictEqual([r.phase, r.dueAt, r.members.length], [2, NOW + 2000, planned.length]);
        assert.deepStrictEqual(spawns[1], planned.filter((m) => m.phase === 2).map((m) => m.key));
        live.stopAll();
      });
    });
  }

  test("WA6 config: SCHEMA defaults, cross warnings, compose passes flag and weights with 0", () => {
    const ea = BASE.eventAnomalies;
    assert.deepStrictEqual([ea.enabled, ea.warcampWeight, ea.hideoutWeight, ea.maxShipsPerEvent, ea.maxOpen,
      ea.maxOpenPerFaction, ea.maxOpenPerKind, ea.systemCooldownMs, ea.fundFromStock],
    [false, 0, 0, 24, 3, 1, 1, 21600000, true]);
    const ttl = SCHEMA.find((row) => row.key === "eventAnomalies.pocketTtlMs");
    assert.deepStrictEqual([ea.pocketTtlMs, ttl.min, ttl.max, ttl.env],
      [3600000, 600000, 14400000, "EVEJS_LNE_EVENT_ANOMALIES_POCKET_TTL_MS"]);
    for (const name of ["anomaly.pocket", "anomaly.escaped", "anomaly.failed.ESCAPED"]) {
      assert.ok(S.COUNTER_NAMES.includes(name), name);
    }
    const quiet = resolveConfig({ modDir: MOD_DIR, env: {} }).warnings.filter((w) => w.includes("eventAnomalies"));
    assert.deepStrictEqual(quiet, []);
    const noisy = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENT_ANOMALIES_ENABLED: "1",
      EVEJS_LNE_EVENT_ANOMALIES_SYSTEM_COOLDOWN_MS: "600000", EVEJS_LNE_EVENT_ANOMALIES_MAX_OPEN: "1",
      EVEJS_LNE_EVENT_ANOMALIES_MAX_OPEN_PER_FACTION: "2" } }).warnings.filter((w) => w.includes("eventAnomalies"));
    assert.strictEqual(noisy.length, 3, noisy.join("; "));
    assert.ok(noisy.some((w) => w.includes("enabled without a kind weight")), noisy.join("; "));
    const file = findCompose();
    if (file === null) return;
    const { env } = readCompose(file);
    const want = (name) => {
      const row = SCHEMA.find((r) => r.key === `eventAnomalies.${name}`);
      return [row.env, row.type === "boolean" ? (row.default ? "1" : "0") : String(row.default)];
    };
    for (const name of ["enabled", "planIntervalMs", "warcampWeight", "hideoutWeight"]) {
      const [envName, value] = want(name);
      assert.strictEqual(env[envName], value, envName);
    }
  });
};
