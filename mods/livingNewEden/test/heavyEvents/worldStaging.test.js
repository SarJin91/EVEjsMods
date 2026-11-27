"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createRng } = require("../../lib/util/rng");
const S = require("../../lib/heavyEvents/schema");
const PC = require("../../lib/heavyEvents/power/catalog");
const W = require("../../lib/heavyEvents/world/schema");
const PS = require("../../lib/heavyEvents/payoutSchema");
const { SUBSTITUTE } = require("../../lib/heavyEvents/catalog");
const { chooseWorld } = require("../../lib/heavyEvents/world/choose");
const { STAGING_INVASION_METHODS } = require("../../lib/heavyEvents/world/planner");
const { peakOf } = require("../../lib/heavyEvents/power/planner");
const { startHeavyEvents } = require("../../lib/heavyEvents");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createReward, worldLootTableOf } = require("../../lib/heavyEvents/reward");
const { pumpPlanned } = require("../../lib/heavyEvents/planner");
const { createHeavyEventPayoutRepository } = require("../../lib/heavyEvents/payoutRepository");
const { createHeavyEventPayoutPump } = require("../../lib/heavyEvents/payouts");
const salvageData = require("../../lib/events/salvage/data");
const { buildStandingGrantCall } = require("../../lib/adapter/standingWrite");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const { createHeavyEventScene } = require("../../lib/adapter/heavyEventScene");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { INVADER_LIVE_PROFILES } = require("../../lib/adapter/data/invaderLiveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { harness: H } = require("../battle/settlement.test");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const TRIG = 500026;
const DEATHLESS = 500029;
const PIRATE = 500010;
const EMPIRE = 500001;
const NEUTRAL = 500014;
const SYS_A = 30000142;
const SYS_B = 30000144;
const FALLBACK = "generic_random_any";
const KINDS = new Map([[PIRATE, "pirate"], [EMPIRE, "empire"], [NEUTRAL, "neutral"], [TRIG, "invader"]]);

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const BUCKET = Math.floor(NOW / BASE.eventAnomalies.planIntervalMs);
const STEPS = BASE.heavyEvents.maxUpscaleSteps;

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const worldCfg = (over) => ({ ...BASE.eventAnomalies, enabled: true, maxUpscaleSteps: STEPS, ...over });

function factsOf(over) {
  return { now: NOW, systems: [{ systemId: SYS_A, band: "nullsec", controllerFactionId: PIRATE,
    previousControllerFactionId: null, occupationState: null, occupierFactionId: null }],
  kindOf: KINDS, losses: [], factions: new Map(), open: [], lastWorldEndedAt: new Map(),
  beachheads: [{ invasionId: "inv:1", factionId: TRIG, systemId: SYS_A }], ...over };
}

function configOf(worldOver) {
  const modules = { ...BASE.modules, world: { ...BASE.modules.world, enabled: true },
    sites: { ...BASE.modules.sites, enabled: true } };
  return { ...BASE, enabled: true, modules, heavyEvents: { ...BASE.heavyEvents, enabled: false },
    powerSites: { ...BASE.powerSites, enabled: false }, eventAnomalies: { ...BASE.eventAnomalies, ...worldOver } };
}

function rig(store) {
  const h = { now: NOW, beachheads: [{ invasionId: "inv:1", factionId: TRIG, systemId: SYS_A }], facade: true,
    systems: new Map([[SYS_A, { systemId: SYS_A, controllerFactionId: PIRATE, previousControllerFactionId: null,
      occupationState: null, occupierFactionId: null }]]) };
  const clock = { now: () => h.now };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sites = { calls: [], live: 0,
    createSiteInTx(_tx, req) {
      this.calls.push(["create", req.eventId, req.slot, req.siteKind || null, req.label]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    cleanupSitesInTx(_tx, eventId, reason) {
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
  const invasions = { calls: [],
    listBeachheadsInTx(tx, opts) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(opts);
      return { ok: true, beachheads: h.beachheads.filter((b) => opts.systems.includes(b.systemId))
        .slice(0, opts.limit), truncated: false };
    } };
  const worldRepository = { getSystem: (_tx, id) => ({ ok: true, system: h.systems.get(id) || { systemId: id,
    controllerFactionId: EMPIRE, previousControllerFactionId: null, occupationState: null,
    occupierFactionId: null } }) };
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 },
    stations: { getMode: () => "ready", repository: {} }, sites, occupation, invasions,
    world: { repository: worldRepository },
    graph: { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }) },
    presence: { getStatus: () => ({ available: true, stale: false }), isObserved: () => false,
      observedWithin: () => ({ ok: true, systems: [SYS_A, SYS_B].map((id, i) => [id, i]) }) } };
  const start = (config) => startHeavyEvents({ config, ctx, clock, getFactionKind: (id) => KINDS.get(id) || null,
    adapter: { readFactionNames: () => ({ ok: true, names: new Map([[TRIG, "Triglavian Collective"]]) }) },
    setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
  const repo = createHeavyEventRepository({ journal });
  const payoutRepo = createHeavyEventPayoutRepository();
  const row = (id) => run(store, (tx) => repo.getInTx(tx, id).row);
  const hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key)).found === true;
  const payouts = (id) => run(store, (tx) => payoutRepo.listPayoutsOfEventInTx(tx, id).rows);
  return Object.assign(h, { ctx, sites, occupation, invasions, worldRepository, journal, repo, payoutRepo, start, row,
    hasKey, payouts });
}

function planStaging(store, h, spec) {
  const members = PC.membersOf("muster", spec.tier, "staging", STEPS, BASE.eventAnomalies);
  assert.ok(members.ok, JSON.stringify(members));
  run(store, (tx) => {
    const r = h.repo.planInTx(tx, { eventId: spec.eventId, planKey: `wa:1:${spec.eventId}`, eventType: "muster",
      tier: spec.tier, systemId: spec.systemId, factionId: TRIG, beneficiaryFactionId: spec.beneficiary,
      stationId: null, members: members.members, funded: false, integrity: null, seed: 3, at: NOW,
      expiresAt: NOW + 3600000, dueAt: null, variant: "staging", affix: W.AFFIX_NONE });
    assert.ok(r.ok, JSON.stringify(r));
  });
}

function envOf(store, h, worldOver, extra) {
  return { store, repo: h.repo, journal: h.journal, settings: { ...BASE.heavyEvents, enabled: false },
    power: { ...BASE.powerSites, enabled: false }, world: { ...BASE.eventAnomalies, ...worldOver },
    worldSeed: 7, maxActiveSites: BASE.sites.maxActiveSites, eventRewards: { ...BASE.eventRewards },
    fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId, sizedDefaultLoot: true,
    getStations: () => h.ctx.stations, getSites: () => h.sites, getWorldRepository: () => h.worldRepository,
    getOccupation: () => h.occupation, getInvasions: () => (h.facade ? h.invasions : null), admits: () => true,
    payoutRepo: null, factionName: () => null, ...extra };
}

function engageInTx(tx, h, eventId) {
  const row = h.repo.getInTx(tx, eventId).row;
  const waves = PC.phaseCountOf("muster", row.tier, "staging", BASE.eventAnomalies);
  const members = row.members.map((m) => ({ ...m, state: "DESTROYED" }));
  return h.repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from: "PLANNED", to: "ENGAGED", at: NOW,
    patch: { phase: waves, scaleSteps: 0, engagedAt: NOW, members } }).row;
}

function fakeGame(system) {
  const byId = new Map();
  let nextId = 9000;
  const scene = { dynamicEntities: byId, getEntityByID: (id) => byId.get(id) || null, broadcastAddBalls: () => {} };
  const mods = {
    "space/runtime": { scenes: new Map([[system, scene]]), isSolarSystemSceneLoaded: (id) => id === system },
    "space/npc/nativeNpcService": {
      spawnNativeNpcEntityInSystem(_systemId, options) {
        nextId += 1;
        const entity = { itemID: nextId, kind: "ship", nativeNpc: true, operatorKind: options.operatorKind,
          position: { ...options.anchorDescriptor.position } };
        byId.set(nextId, entity);
        return { success: true, data: { entity } };
      },
    },
    "space/npc/npcService": { setBehaviorOverrides: () => ({ success: true }), issueManualOrder: () => ({ success: true }),
      wakeNpcController: () => ({ success: true }), destroyNpcControllerByEntityID: () => ({ success: true }) },
    "space/npc/pirateHullProfiles": { resolveFactionHullProfileID: (key, hullClass) => `${key}_${hullClass}` },
    "space/worldData": { getStargatesForSystem: () => [], getStationsForSystem: () => [],
      getAsteroidBeltsForSystem: () => [] },
  };
  return (rel) => (mods[rel] ? { ok: true, exports: mods[rel] } : { ok: false, reason: "missing" });
}

module.exports = ({ test, skip }) => {
  test("WS1 chooseWorld staging: tier II/III, unfunded, defender rule, 500029 KIND_OFF; weight 0 bit for bit", () => {
    const cfg = worldCfg({ stagingWeight: 1 });
    const tiers = new Set();
    for (let seed = 1; seed <= 24; seed += 1) {
      const r = chooseWorld(factsOf(), cfg, createRng(seed));
      assert.ok(r.ok, JSON.stringify(r));
      const c = r.candidate;
      assert.deepStrictEqual([c.kind, c.eventType, c.variant, c.systemId, c.factionId, c.funded, c.stationId,
        c.beneficiaryFactionId, c.siteKind], ["staging", "muster", "staging", SYS_A, TRIG, false, null, PIRATE,
        "anomaly"]);
      tiers.add(c.tier);
    }
    assert.deepStrictEqual([...tiers].sort(), [2, 3], "stagingTierWeights 0,60,40");
    const taken = factsOf({ systems: [{ systemId: SYS_A, band: "nullsec", controllerFactionId: TRIG,
      previousControllerFactionId: EMPIRE, occupationState: null, occupierFactionId: null }] });
    assert.strictEqual(chooseWorld(taken, cfg, createRng(1)).candidate.beneficiaryFactionId, EMPIRE);
    const neutral = factsOf({ systems: [{ systemId: SYS_A, band: "nullsec", controllerFactionId: NEUTRAL,
      previousControllerFactionId: EMPIRE, occupationState: null, occupierFactionId: null }] });
    const n = chooseWorld(neutral, cfg, createRng(1));
    assert.ok(n.ok && n.candidate.beneficiaryFactionId === null, JSON.stringify(n));
    const deathless = factsOf({ beachheads: [{ invasionId: "inv:2", factionId: DEATHLESS, systemId: SYS_A }] });
    assert.deepStrictEqual(chooseWorld(deathless, cfg, createRng(1)), { ok: false, reason: "KIND_OFF" });
    assert.deepStrictEqual(chooseWorld(factsOf({ beachheads: [] }), cfg, createRng(1)),
      { ok: false, reason: "NO_TRIGGER" });
    const sub1 = { now: NOW, systems: [
      { systemId: SYS_A, band: "nullsec", controllerFactionId: PIRATE, occupationState: null, occupierFactionId: null },
      { systemId: SYS_B, band: "nullsec", controllerFactionId: EMPIRE, occupationState: "OCCUPIED",
        occupierFactionId: PIRATE }],
    kindOf: KINDS, losses: [{ systemId: SYS_A, factionId: PIRATE, count: 20 }],
    factions: new Map([[PIRATE, { stations: [{ stationId: "st:1", state: "ONLINE", hullStock: Object.fromEntries(
      ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics", "dreadnought"]
        .map((g) => [g, 50])) }] }]]), open: [], lastWorldEndedAt: new Map() };
    const off = worldCfg({ warcampWeight: 1, hideoutWeight: 1, stagingWeight: 0 });
    for (let seed = 1; seed <= 8; seed += 1) {
      const without = chooseWorld(sub1, off, createRng(seed));
      assert.ok(without.ok, JSON.stringify(without));
      assert.strictEqual(without.candidate.beneficiaryFactionId, null);
      assert.deepStrictEqual(chooseWorld({ ...sub1, beachheads: [{ invasionId: "inv:1", factionId: TRIG,
        systemId: SYS_A }] }, off, createRng(seed)), without);
    }
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("WS2-WS3 staging store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("WS2 staging plan: hwa: muster/staging unfunded with the defender; cancel only PLANNED without beachhead", () =>
      H.withStore(driver, (reopen) => {
        const { store } = reopen();
        const h = rig(store);
        let svc = h.start(configOf({ enabled: true, stagingWeight: 1 })).heavyEvents;
        svc.runPass(NOW);
        const eventId = W.eventIdOf(BUCKET, 0);
        const r = h.row(eventId);
        assert.ok(r, JSON.stringify(svc.getStatus()));
        assert.deepStrictEqual([r.eventType, r.variant, r.affix, r.systemId, r.factionId, r.beneficiaryFactionId,
          r.stationId, r.funded, r.state], ["muster", "staging", "none", SYS_A, TRIG, PIRATE, null, false, "PLANNED"]);
        assert.ok([2, 3].includes(r.tier), `tier ${r.tier}`);
        assert.ok(!h.hasKey(S.fundKeyOf(eventId)), "no fund key");
        assert.deepStrictEqual(h.sites.calls, [["create", eventId, 0, "anomaly",
          "Triglavian Collective Invasion Staging"]]);
        assert.deepStrictEqual(h.invasions.calls, [{ limit: 2, systems: [SYS_A, SYS_B] }]);
        const c = svc.getStatus().counters;
        assert.deepStrictEqual([c["anomaly.planned"], c["anomaly.planned.staging"], c["anomaly.staging.noBeneficiary"],
          c.hullsFunded], [1, 1, 0, 0]);
        svc.stop("test");
        planStaging(store, h, { eventId: "hwa:9:0", tier: 3, systemId: SYS_B, beneficiary: EMPIRE });
        run(store, (tx) => engageInTx(tx, h, "hwa:9:0"));
        const env = envOf(store, h, { enabled: true, stagingWeight: 1 });
        h.facade = false;
        assert.deepStrictEqual(pumpPlanned(env, NOW + 1000).world, {}, "no facade = holds");
        h.facade = true;
        const reads = h.invasions.calls.length;
        assert.deepStrictEqual(pumpPlanned(env, NOW + 2000).world, {}, "ACTIVE beachhead = holds");
        assert.strictEqual(h.invasions.calls.length, reads + 2);
        h.beachheads = [];
        assert.deepStrictEqual(pumpPlanned(env, NOW + 3000).world, { CANCELLED: 1 });
        assert.deepStrictEqual([h.row(eventId).state, h.row(eventId).endReason], ["CANCELLED", "CANCELLED"]);
        assert.strictEqual(h.row("hwa:9:0").state, "ENGAGED");
        const before = h.invasions.calls.length;
        svc = h.start(configOf({ enabled: true, stagingWeight: 0, hideoutWeight: 1 })).heavyEvents;
        svc.runPass(NOW + BASE.eventAnomalies.planIntervalMs);
        svc.stop("test");
        assert.strictEqual(h.invasions.calls.length, before);
      }));

    test("WS3 staging CLEARED: defender payouts once, none without defender; invader chest; pump reasons", () =>
      H.withStore(driver, async (reopen) => {
        const { store } = reopen();
        const h = rig(store);
        planStaging(store, h, { eventId: "hwa:7:0", tier: 2, systemId: SYS_A, beneficiary: EMPIRE });
        planStaging(store, h, { eventId: "hwa:7:1", tier: 3, systemId: SYS_B, beneficiary: null });
        const env = envOf(store, h, { enabled: true, stagingWeight: 1 },
          { payoutRepo: h.payoutRepo, sizedDefaultLoot: false, fallbackLootTableId: FALLBACK });
        const counters = {};
        const hooks = { bump: (name, n = 1) => {
          if (S.COUNTER_NAMES.includes(name)) counters[name] = (counters[name] || 0) + n;
        }, refuse: () => {} };
        const live = createLive({ ...env, getSeam: () => null }, hooks);
        const engaged = run(store, (tx) => engageInTx(tx, h, "hwa:7:0"));
        const first = run(store, (tx) => live.clearInTx(tx, engaged, NOW + 1000, {}, [101, 102]));
        assert.deepStrictEqual([first.duplicate, first.payouts], [false, { planned: 2, failed: null }]);
        const again = run(store, (tx) => live.clearInTx(tx, engaged, NOW + 1000, {}, [101, 102, 103]));
        assert.strictEqual(again.duplicate, true);
        const rows = h.payouts("hwa:7:0");
        assert.deepStrictEqual(rows.map((p) => [p.payoutKey, p.issuerFactionId, p.lpAmount, p.standingMicro,
          p.iskAmount, p.iskState, p.description]), [101, 102].map((id) => [`hwa:7:0:${id}`, EMPIRE, 2000, 50000, 0,
          "SKIPPED", PS.WORLD_DESCRIPTION]));
        const noDefender = run(store, (tx) => live.clearInTx(tx, engageInTx(tx, h, "hwa:7:1"), NOW + 1000, {}, [101]));
        assert.deepStrictEqual([noDefender.duplicate, noDefender.payouts], [false, null]);
        assert.deepStrictEqual(h.payouts("hwa:7:1"), []);
        assert.deepStrictEqual(h.occupation.calls, [[TRIG, 40, S.influenceKeyOf("hwa:7:0")],
          [TRIG, 40, S.influenceKeyOf("hwa:7:1")]]);
        const wrecks = { ok: true, places: [], readGrid: () => ({ ok: true, sceneLoaded: true }),
          place(spec) {
            this.places.push(spec);
            return { ok: true, adopted: false, wreckId: 700 + this.places.length, items: 3, factionItems: 0,
              vendorWrites: 0 };
          } };
        createReward({ ...env, getWrecks: () => wrecks }, hooks).pass(NOW + 1000 + BASE.heavyEvents.rewardWaitMs);
        assert.strictEqual(wrecks.places.length, 2);
        for (const spec of wrecks.places) {
          const belt = salvageData.resolveLootTable(TRIG, spec.hullGroup, { sizedDefault: true, fallbackId: null });
          assert.ok(typeof belt === "string" && belt !== FALLBACK, belt);
          assert.deepStrictEqual([spec.lootTableId, spec.rewardLoot], [belt, undefined]);
        }
        const sub1Cfg = { sizedDefaultLoot: false, fallbackLootTableId: FALLBACK };
        assert.strictEqual(worldLootTableOf({ variant: "warcamp", factionId: EMPIRE }, "battleship", sub1Cfg), FALLBACK,
          "warcamp / hideout keep the lookup");
        run(store, (tx) => assert.ok(h.payoutRepo.planPayoutsInTx(tx, { eventId: "hev:8:0", issuerFactionId: EMPIRE,
          systemId: SYS_A, characterIds: [201], iskAmount: 0, lpAmount: 0, standingMicro: 50000, at: NOW }).ok));
        const grants = [];
        const adapter = { rewardSeams: () => ({ ok: true }), rewardCreditIsk: async () => ({ ok: true }),
          rewardCreditLp: () => ({ ok: true, duplicate: false }),
          applyStandingGrant(grant, data) {
            grants.push([grant, data]);
            return { ok: true, outcome: "APPLIED" };
          } };
        const s = BASE.heavyEvents;
        const pump = createHeavyEventPayoutPump({ store, repo: h.payoutRepo, adapter,
          params: { payoutEnabled: true, payoutMaxPerPass: 10, payoutMaxAttempts: s.payoutMaxAttempts,
            payoutRetryBaseMs: s.payoutRetryBaseMs, payoutRetryMaxMs: s.payoutRetryMaxMs,
            payoutRetentionMs: s.payoutRetentionMs, prunePerPass: s.pruneBatch },
          count: () => {}, isStopped: () => false });
        await pump.runPass(NOW + 5000);
        const reasons = grants.map(([g]) => [g.key, g.reason]).sort();
        assert.deepStrictEqual(reasons, [["lne:hev:8:0:201:std", "HEAVY_EVENT_DEFENSE"],
          ["lne:hwa:7:0:101:std", "EVENT_ANOMALY"], ["lne:hwa:7:0:102:std", "EVENT_ANOMALY"]]);
        const hev = grants.find(([g]) => g.key === "lne:hev:8:0:201:std");
        const before = { eventTypeId: 486, msgByReason: { HEAVY_EVENT_DEFENSE: "Outpost defense (Living New Eden)" } };
        assert.deepStrictEqual(buildStandingGrantCall(hev[0], hev[1]), buildStandingGrantCall(hev[0], before));
        const hwa = grants.find(([g]) => g.key === "lne:hwa:7:0:101:std");
        assert.strictEqual(buildStandingGrantCall(hwa[0], hwa[1]).changes[0].msg, "Event anomaly (Living New Eden)");
      }));
  }

  test("WS4 tier III: invader classes only, peaks <= 24; dreadnought -> NO_PROFILE -> SUBSTITUTE battleship", () => {
    const allowed = new Set([...Object.keys(INVADER_LIVE_PROFILES[TRIG]), ...Object.keys(SUBSTITUTE)]);
    assert.deepStrictEqual(Object.keys(INVADER_LIVE_PROFILES[500024]).sort(),
      Object.keys(INVADER_LIVE_PROFILES[TRIG]).sort());
    const cfg = { ...BASE.eventAnomalies, maxUpscaleSteps: 3 };
    for (let tier = 1; tier <= W.TIER_COUNT; tier += 1) {
      const members = PC.membersOf("muster", tier, "staging", 3, cfg);
      assert.ok(members.ok, JSON.stringify(members));
      for (const m of members.members) {
        assert.ok(allowed.has(m.hullGroup) && m.hullGroup !== "logistics", `tier ${tier} ${m.hullGroup}`);
      }
      const peak = peakOf("muster", tier, "staging", cfg);
      assert.ok(peak !== null && peak <= BASE.eventAnomalies.maxShipsPerEvent, `tier ${tier} peak ${peak}`);
    }
    assert.ok(PC.membersOf("muster", 3, "staging", 0, cfg).members.some((m) => m.hullGroup === "dreadnought"));
    const requireGame = fakeGame(SYS_A);
    const spawn = createNpcSpawn({ requireGame, navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      invaderProfiles: INVADER_LIVE_PROFILES, data: liveProfiles, capitalIndex: () => ({ ok: true, enabled: true,
        index: {}, skipped: [] }) });
    const one = (hullGroup) => spawn.resolveProfiles([{ memberKey: "k", factionId: TRIG, hullGroup }],
      { seedPrefix: "p", invaders: true });
    assert.strictEqual(one("dreadnought").reason, "NO_PROFILE");
    assert.deepStrictEqual(one("battleship"), { ok: true, profiles: ["parity_trig_liminal_leshak"] });
    const seam = createHeavyEventScene({ requireGame, getNpcSpawn: () => spawn, getHuntScene: () => null });
    const res = seam.spawnPhase(SYS_A, { eventId: "hwa:1:0", factionId: TRIG, anchorPoint: { x: 1, y: 0, z: 0 },
      members: [{ memberKey: "p1:0", hullGroup: "dreadnought" }, { memberKey: "p1:1", hullGroup: "cruiser" }],
      spawnDistanceM: 30000, aggroRangeM: 100000, leashRangeM: 150000, ownerId: null, substitute: SUBSTITUTE });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.deepStrictEqual([res.spawned.map((x) => [x.memberKey, x.hullGroup]), res.unspawnable],
      [[["p1:0", "battleship"], ["p1:1", "cruiser"]], []]);
  });

  test("WS5 config: staging defaults, no warning at defaults, invader defender warns, compose 0, faction id list", () => {
    const ea = BASE.eventAnomalies;
    assert.deepStrictEqual([ea.stagingWeight, ea.stagingFactions, ea.stagingTierWeights, ea.stagingRolls,
      ea.stagingInfluencePoints, ea.stagingBeneficiaryKinds, ea.stagingLpPerTier, ea.stagingStandingMicro],
    [0, "500026,500024", "0,60,40", "4,6,9", 40, "empire,pirate", "1000,2000,4000", 50000]);
    for (const row of SCHEMA.filter((r) => r.key.startsWith("eventAnomalies.staging"))) {
      assert.ok(row.env.startsWith("EVEJS_LNE_EVENT_ANOMALIES_STAGING_"), row.env);
    }
    const quiet = resolveConfig({ modDir: MOD_DIR, env: {} }).warnings.filter((w) => w.includes("eventAnomalies"));
    assert.deepStrictEqual(quiet, []);
    const noisy = resolveConfig({ modDir: MOD_DIR, env: {
      EVEJS_LNE_EVENT_ANOMALIES_STAGING_BENEFICIARY_KINDS: "empire,invader" } }).warnings
      .filter((w) => w.includes("stagingBeneficiaryKinds"));
    assert.strictEqual(noisy.length, 1, noisy.join("; "));
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENT_ANOMALIES_STAGING_FACTIONS: "500026,500026",
      EVEJS_LNE_EVENT_ANOMALIES_STAGING_LP_PER_TIER: "1,2,100001" } }).config.eventAnomalies;
    assert.deepStrictEqual([bad.stagingFactions, bad.stagingLpPerTier], ["500026,500024", "1000,2000,4000"]);
    assert.deepStrictEqual(W.parseFactionIdList(" 500026 , 500024 "), [TRIG, 500024]);
    for (const text of ["", "0", "500026,500026", "1,2,3,4,5,6,7,8,9", "x", 500026, "-1"]) {
      assert.strictEqual(W.parseFactionIdList(text), null, String(text));
    }
    assert.deepStrictEqual(STAGING_INVASION_METHODS, ["listBeachheadsInTx"]);
    const file = findCompose();
    if (file === null) return;
    const { env } = readCompose(file);
    assert.strictEqual(env.EVEJS_LNE_EVENT_ANOMALIES_STAGING_WEIGHT, "0");
  });
};
