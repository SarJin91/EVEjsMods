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
const { startHeavyEvents } = require("../../lib/heavyEvents");
const { createHeavyEventRepository, toEvent } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createReward } = require("../../lib/heavyEvents/reward");
const { pumpPlanned } = require("../../lib/heavyEvents/planner");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS1 = 30000142;
const SYS2 = 30000144;
const SYS3 = 30000145;
const STATION = "st:pw:1";
const STOCK_PER_GROUP = 50;
const GROUPS = ["frigate", "destroyer", "cruiser", "tackle", "ewar", "logistics", "battlecruiser", "battleship",
  "dreadnought", "industrial"];

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

function harness(store, systems) {
  const h = { now: NOW };
  const clock = { now: () => h.now };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS1, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "pwt:st").ok);
    const deltas = hullDeltas(GROUPS.map((hullGroup) => ({ hullGroup, count: STOCK_PER_GROUP })), 1).deltas;
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "pwt:stock", reason: "seed", at: NOW,
      deltas: [...deltas, { itemKind: "mineral", itemKey: "type:34", delta: 50000 }] }).ok);
  });
  const sites = { calls: [], refuse: null, live: 0,
    createSiteInTx(tx, req) {
      assert.strictEqual(tx.inTransaction, true);
      if (this.refuse) return { ok: false, reason: this.refuse };
      this.calls.push(["create", req.eventId, req.slot, req.siteKind || null, req.label]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(["cleanup", eventId, reason]);
      return { ok: true, released: 1 };
    },
    listSitesByEvent: () => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", siteKey: "k", position: { x: 1, y: 2,
      z: 3 } }] }),
    countLive() {
      return { ok: true, count: this.live };
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
      observedWithin: () => ({ ok: true, systems: (systems || [SYS1]).map((id, i) => [id, i]) }) } };
  const start = (config) => startHeavyEvents({ config, ctx, clock, getFactionKind: () => "pirate",
    setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
  const repo = createHeavyEventRepository({ journal });
  const hulls = () => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
  const rows = () => run(store, (tx) => repo.listOpenInTx(tx, { limit: 64 }).rows);
  const row = (id) => run(store, (tx) => repo.getInTx(tx, id).row);
  const hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key)).found === true;
  return Object.assign(h, { ctx, sites, occupation, start, repo, journal, stations, hulls, rows, row, hasKey });
}

function planPower(store, h, spec) {
  const members = PC.membersOf(spec.type, spec.tier, spec.variant, BASE.heavyEvents.maxUpscaleSteps, BASE.powerSites);
  run(store, (tx) => {
    const r = h.repo.planInTx(tx, { eventId: spec.eventId, planKey: `pw:1:${spec.eventId}`, eventType: spec.type,
      tier: spec.tier, systemId: spec.systemId, factionId: PIRATE, beneficiaryFactionId: null,
      stationId: spec.funded ? STATION : null, members: members.members, funded: spec.funded === true, integrity: null,
      seed: 3, at: NOW, expiresAt: NOW + 3600000, dueAt: null, variant: spec.variant, affix: spec.affix });
    assert.ok(r.ok, JSON.stringify(r));
  });
  return members.members;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PP1-PP5 power sites plan", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("PP1 power plan: fund + row + signature beacon in one tx, same bucket = DUPLICATE, SITES_FULL rolls back", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, [SYS1, SYS2]);
      const config = configOf({ enabled: false }, { enabled: true, outpostWeight: 0, trailWeight: 0, huntWeight: 0,
        convoyWeight: 0, maxPlansPerPass: 1 });
      const before = h.hulls();
      let svc = h.start(config).heavyEvents;
      svc.runPass(NOW);
      const eventId = P.eventIdOf(PW_BUCKET, 0);
      const r = h.row(eventId);
      assert.ok(r, JSON.stringify(svc.getStatus()));
      assert.deepStrictEqual([r.eventType, r.state, r.pocket, r.funded, r.planKey],
        ["cache", "PLANNED", 0, true, P.planKeyOf(BASE.powerSites.planIntervalMs, PW_BUCKET, 0)]);
      assert.ok(P.VARIANTS.cache.includes(r.variant) && P.AFFIXES.includes(r.affix), `${r.variant} ${r.affix}`);
      const funded = PC.maxComposition("cache", r.tier, r.variant, BASE.heavyEvents.maxUpscaleSteps, BASE.powerSites).total;
      assert.strictEqual(h.hulls(), before - funded);
      assert.strictEqual(h.sites.calls.length, 1);
      const [kind, id, slot, siteKind, label] = h.sites.calls[0];
      assert.deepStrictEqual([kind, id, slot, siteKind], ["create", eventId, 0, "signature"]);
      assert.ok(label.endsWith("Buried Stash"), label);
      assert.ok(h.hasKey(S.fundKeyOf(eventId)));
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c["power.planned"], c["planned.cache"], c[`power.affix.${r.affix}`], c.hullsFunded],
        [1, 1, 1, funded]);
      svc.stop("test");
      svc = h.start(config).heavyEvents;
      svc.runPass(NOW + 60000);
      assert.deepStrictEqual([svc.getStatus().counters["power.planned"], h.sites.calls.length, h.rows().length,
        h.hulls()], [0, 1, 1, before - funded]);
      h.sites.refuse = "SITES_FULL";
      svc.runPass(NOW + BASE.powerSites.planIntervalMs);
      assert.deepStrictEqual([svc.getStatus().counters["power.refused.SITES_FULL"], h.rows().length, h.hulls()],
        [1, 1, before - funded]);
      assert.strictEqual(h.hasKey(S.fundKeyOf(P.eventIdOf(PW_BUCKET + 1, 0))), false);
      svc.stop("test");
    });
  });

  test("PP2 heavy and power in one pass: own limits, a BUSY system of one layer is BUSY for the other", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, [SYS1, SYS2, SYS3]);
      planPower(store, h, { eventId: "hpw:1:0", type: "cache", tier: 1, variant: "guard", affix: "none",
        systemId: SYS2 });
      const config = configOf({ enabled: true, maxOpen: 1 }, { enabled: true, maxOpen: 2, maxPlansPerPass: 2 });
      const svc = h.start(config).heavyEvents;
      svc.runPass(NOW);
      const open = h.rows().map((r) => [r.systemId, P.isPowerType(r.eventType) ? "power" : "heavy"])
        .sort((a, b) => a[0] - b[0]);
      assert.deepStrictEqual(open, [[SYS1, "heavy"], [SYS2, "power"], [SYS3, "power"]], JSON.stringify(open));
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c["power.planned"], c["power.refused.LIMIT"]], [1, 1]);
      assert.ok(S.HEAVY_TYPES.some((t) => c[`planned.${t}`] === 1));
      svc.stop("test");
    });
  });

  test("PP3 outpost reinforced: engage steps 1 -> phase 2 -> CLEARED (powerSites influence) -> COMPLETED PLACED", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const eventId = "hpw:9:0";
      planPower(store, h, { eventId, type: "outpost", tier: 1, variant: "brawl", affix: "reinforced", systemId: SYS1,
        funded: true });
      const seam = { alive: new Set(), spawns: [], nextId: 100,
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
        } };
      const wrecks = { ok: true, scene: true, places: [], wrecks: new Map(),
        readGrid() { return { ok: true, sceneLoaded: this.scene }; },
        place(spec) {
          this.places.push(spec);
          if (this.wrecks.has(spec.anomalyId)) {
            return { ok: true, adopted: true, wreckId: this.wrecks.get(spec.anomalyId), items: 3, factionItems: 0, vendorWrites: 0 };
          }
          this.wrecks.set(spec.anomalyId, 700 + this.wrecks.size);
          return { ok: true, adopted: false, wreckId: this.wrecks.get(spec.anomalyId), items: 3, factionItems: 1, vendorWrites: 2 };
        },
        flush() {} };
      const counters = {};
      const hooks = { bump: (name, n = 1) => {
        assert.ok(S.COUNTER_NAMES.includes(name), `counter ${name} not in COUNTER_NAMES`);
        counters[name] = (counters[name] || 0) + n;
      }, refuse: () => {} };
      const settings = { ...BASE.heavyEvents, enabled: true };
      const env = { store, repo: h.repo, settings, power: { ...BASE.powerSites, enabled: true },
        getStations: () => h.ctx.stations, getSites: () => h.sites, getSeam: () => seam,
        getPresence: () => ({ isObserved: () => true }), getOccupation: () => h.occupation, admits: () => true };
      const live = createLive(env, hooks);
      live.pass(NOW);
      assert.deepStrictEqual([h.row(eventId).state, h.row(eventId).scaleSteps], ["ENGAGED", 1]);
      assert.deepStrictEqual(seam.spawns[0], ["p1:0", "p1:1", "p1:2", "p1:3", "p1:4", "u1:0"]);
      seam.alive.clear();
      live.pass(NOW + 1000);
      assert.deepStrictEqual([h.row(eventId).phase, seam.spawns[1]], [2, ["p2:0", "p2:1"]]);
      seam.alive.clear();
      live.pass(NOW + 2000);
      assert.strictEqual(h.row(eventId).state, "CLEARED");
      assert.deepStrictEqual(h.occupation.calls, [[PIRATE, BASE.powerSites.outpostInfluencePoints,
        S.influenceKeyOf(eventId)]]);
      const reward = createReward({ ...env, journal: h.journal, eventRewards: BASE.eventRewards,
        fallbackLootTableId: BASE.salvageAnomaly.fallbackLootTableId, getWrecks: () => wrecks }, hooks);
      reward.pass(NOW + 3000);
      const done = h.row(eventId);
      assert.deepStrictEqual([done.state, done.rewardState], ["COMPLETED", "PLACED"]);
      assert.strictEqual(counters["power.reward.placed"], 1);
      assert.strictEqual(counters["cleared.outpost"], 1);
    });
  });

  test("PP4 powerSites.enabled off: only the power row is CANCELLED (DISABLED), its hulls go back", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, [SYS1]);
      const heavyMembers = [{ key: "p1:0", phase: 1, step: null, hullGroup: "cruiser", state: "RESERVED" }];
      run(store, (tx) => assert.ok(h.repo.planInTx(tx, { eventId: "hev:1:0", planKey: "1:hev:1:0", eventType: "redoubt",
        tier: 1, systemId: SYS1, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION,
        members: heavyMembers, funded: true, integrity: null, seed: 1, at: NOW, expiresAt: NOW + 3600000,
        dueAt: null }).ok));
      const members = planPower(store, h, { eventId: "hpw:1:0", type: "outpost", tier: 1, variant: "kite",
        affix: "none", systemId: SYS2, funded: true });
      const before = h.hulls();
      const svc = h.start(configOf({ enabled: true }, { enabled: false })).heavyEvents;
      svc.runPass(NOW);
      const pw = h.row("hpw:1:0");
      assert.deepStrictEqual([pw.state, pw.endReason, pw.open], ["CANCELLED", "DISABLED", false]);
      assert.strictEqual(h.row("hev:1:0").state, "PLANNED");
      assert.strictEqual(h.hulls(), before + members.length);
      assert.ok(h.sites.calls.some((c) => c[0] === "cleanup" && c[1] === "hpw:1:0" && c[2] === "EVENT_CANCELLED"));
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c["power.cancelled.DISABLED"], c["cancelled.DISABLED"]], [1, 0]);
      svc.stop("test");
    });
  });

  test("PP6: controller flip cancels PLANNED only; ENGAGED keeps its losses, only survivors' hulls go back", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const eventId = "hpw:7:0";
      const members = planPower(store, h, { eventId, type: "outpost", tier: 1, variant: "brawl", affix: "none",
        systemId: SYS1, funded: true });
      planPower(store, h, { eventId: "hpw:7:1", type: "cache", tier: 1, variant: "guard", affix: "none",
        systemId: SYS2 });
      const before = h.hulls();
      const seam = { alive: new Set(), nextId: 100,
        readGrid: () => ({ ok: true, players: [{ characterId: 1, entityId: 1 }], copies: 0 }),
        spawnPhase(_sys, input) {
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
        } };
      let controller = PIRATE;
      const hooks = { bump: () => {}, refuse: () => {} };
      const settings = { ...BASE.heavyEvents, enabled: true };
      const env = { store, repo: h.repo, settings, power: { ...BASE.powerSites, enabled: true },
        getStations: () => h.ctx.stations, getSites: () => h.sites, getSeam: () => seam,
        getPresence: () => ({ isObserved: (id) => id === SYS1 }), getOccupation: () => h.occupation,
        admits: () => true,
        getWorldRepository: () => ({ getSystem: (_tx, id) => ({ ok: true, system: { systemId: id,
          controllerFactionId: controller } }) }) };
      const live = createLive(env, hooks);
      live.pass(NOW);
      assert.strictEqual(h.row(eventId).state, "ENGAGED");
      const killed = 100;
      assert.ok(seam.alive.delete(killed));
      controller = PIRATE + 1;
      const out = pumpPlanned(env, NOW + 1000);
      assert.deepStrictEqual([out.power.CANCELLED, h.row("hpw:7:1").state, h.row(eventId).state],
        [1, "CANCELLED", "ENGAGED"]);
      live.pass(NOW + 1000);
      const destroyed = h.row(eventId).members.filter((m) => m.state === "DESTROYED");
      assert.strictEqual(destroyed.length, 1);
      live.pass(NOW + settings.engagedMaxMs + 1000);
      const done = h.row(eventId);
      assert.deepStrictEqual([done.state, done.endReason], ["FAILED", "TIMEOUT"]);
      assert.strictEqual(h.hulls(), before + members.length - 1);
      assert.strictEqual(seam.alive.size, 0);
      assert.strictEqual(live.status().engaged, 0);
    });
  });

  test("PP7: heavyEvents off + power on -> the heavy row CANCELLED (DISABLED), its hulls back once", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, []);
      run(store, (tx) => assert.ok(h.repo.planInTx(tx, { eventId: "hev:2:0", planKey: "1:hev:2:0", eventType: "redoubt",
        tier: 1, systemId: SYS1, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION,
        members: [{ key: "p1:0", phase: 1, step: null, hullGroup: "cruiser", state: "RESERVED" }], funded: true,
        integrity: null, seed: 1, at: NOW, expiresAt: NOW + 3600000, dueAt: null }).ok));
      const before = h.hulls();
      const svc = h.start(configOf({ enabled: false }, { enabled: true })).heavyEvents;
      svc.runPass(NOW);
      svc.runPass(NOW + 60000);
      const r = h.row("hev:2:0");
      assert.deepStrictEqual([r.state, r.endReason], ["CANCELLED", "DISABLED"]);
      assert.strictEqual(h.hulls(), before + 1);
      assert.strictEqual(svc.getStatus().counters["cancelled.DISABLED"], 1);
      svc.stop("test");
    });
  });

  test("PP8 fix: a funded muster plans every wave; EXPIRED and TIMEOUT in wave 1 return the full fund", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, [SYS1, SYS2]);
      const config = configOf({ enabled: false }, { enabled: true, outpostWeight: 0, cacheWeight: 0, trailWeight: 0,
        huntWeight: 0, convoyWeight: 0, musterWeight: 1, maxPlansPerPass: 1 });
      const seam = { alive: new Set(), nextId: 100,
        readGrid: () => ({ ok: true, players: [{ characterId: 1, entityId: 1 }], copies: 0 }),
        spawnPhase(_sys, input) {
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
        } };
      const settings = { ...config.heavyEvents, enabled: true };
      const env = { store, repo: h.repo, settings, power: config.powerSites, getStations: () => h.ctx.stations,
        getSites: () => h.sites, getSeam: () => seam, getPresence: () => ({ isObserved: () => true }),
        getOccupation: () => h.occupation, admits: () => true,
        getWorldRepository: () => h.ctx.world.repository };
      const planOne = (at, bucket) => {
        const before = h.hulls();
        const svc = h.start(config).heavyEvents;
        svc.runPass(at);
        svc.stop("test");
        const r = h.row(P.eventIdOf(bucket, 0));
        assert.ok(r, JSON.stringify(h.rows()));
        assert.deepStrictEqual([r.eventType, r.state, r.funded], ["muster", "PLANNED", true]);
        const waves = PC.phaseCountOf("muster", r.tier, r.variant, config.powerSites);
        assert.ok(r.members.some((m) => m.phase === waves), "the last wave is planned");
        assert.strictEqual(before - h.hulls(), r.members.length);
        return { row: r, before };
      };
      const a = planOne(NOW, PW_BUCKET);
      const out = pumpPlanned(env, a.row.expiresAt + 1);
      assert.strictEqual(out.expired, 1, JSON.stringify(out));
      assert.strictEqual(h.row(a.row.eventId).state, "EXPIRED");
      assert.strictEqual(h.hulls(), a.before);
      const at = NOW + BASE.powerSites.planIntervalMs;
      const b = planOne(at, PW_BUCKET + 1);
      const live = createLive(env, { bump: () => {}, refuse: () => {} });
      live.pass(at + 1);
      assert.deepStrictEqual([h.row(b.row.eventId).state, h.row(b.row.eventId).phase], ["ENGAGED", 1]);
      live.pass(at + 1 + settings.engagedMaxMs);
      const done = h.row(b.row.eventId);
      assert.deepStrictEqual([done.state, done.endReason, done.phase], ["FAILED", "TIMEOUT", 1]);
      assert.strictEqual(h.hulls(), b.before);
      pumpPlanned(env, at + 2 + settings.engagedMaxMs);
      assert.strictEqual(h.hulls(), b.before);
    });
  });

  test("PP5 migration 66: an old heavy row gets variant / affix NULL and pocket 0; the variant CHECK holds", () => {
    const m = MIGRATIONS.find((x) => x.version === 66);
    assert.deepStrictEqual([m.name, m.up === S.upHeavyEventsPower], ["world_heavy_events_power", true]);
    const db = new driver.Database(":memory:");
    try {
      S.upHeavyEvents(db);
      db.prepare("INSERT INTO world_heavy_events (event_id, plan_key, event_type, tier, system_id, faction_id, state, "
        + "open, members_json, seed, created_at, expires_at, updated_at) VALUES ('hev:1:0', '3600000:1:0', 'redoubt', "
        + "1, 1, 1, 'PLANNED', 1, '[]', 1, 0, 1, 0)").run();
      S.upHeavyEventsPower(db);
      const raw = db.prepare("SELECT * FROM world_heavy_events WHERE event_id = 'hev:1:0'").get();
      assert.deepStrictEqual([raw.variant, raw.affix, Number(raw.pocket)], [null, null, 0]);
      const view = toEvent(raw);
      assert.deepStrictEqual([view.variant, view.affix, view.pocket, view.eventType], [null, null, 0, "redoubt"]);
      assert.throws(() => db.prepare("UPDATE world_heavy_events SET variant = ? WHERE event_id = 'hev:1:0'")
        .run("x".repeat(17)));
      assert.throws(() => db.prepare("UPDATE world_heavy_events SET pocket = -1 WHERE event_id = 'hev:1:0'").run());
    } finally {
      db.close();
    }
  });
};
