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
const { membersOf: powerMembersOf } = require("../../lib/heavyEvents/power/catalog");
const { membersOf } = require("../../lib/heavyEvents/catalog");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { createReward } = require("../../lib/heavyEvents/reward");
const { labelOf: powerLabelOf } = require("../../lib/heavyEvents/power/choose");
const { labelOf: worldLabelOf } = require("../../lib/heavyEvents/world/choose");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:1";
const EVENT_TRAIL = "hpw:1:0";
const EVENT_REDOUBT = "hev:1:0";
const EVENT_FOUNDRY = "hev:2:0";
const EVENT_DEFENSE = "hev:3:0";
const EVENT_WORLD_TRAIL = "hwa:1:0";
const FACTION_NAME = "Guristas Pirates";

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const settingsOf = (over) => ({ ...BASE.heavyEvents, enabled: true, ...(over || {}) });
const powerOf = (over) => ({ ...BASE.powerSites, enabled: true, trailPockets: 3, pocketTtlMs: 3600000, trailWeight: 1, outpostWeight: 0, cacheWeight: 0, huntWeight: 0, convoyWeight: 0, musterWeight: 0, trailRolls: "1,2", trailInfluencePoints: 15, ...(over || {}) });

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeSeam() {
  return { scene: true, players: 1, copies: 0, nextId: 9000, alive: new Set(), spawns: [], anchors: [], despawned: [],
    readGrid() {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, players: Array.from({ length: this.players }, (_, i) => ({ characterId: i + 1, entityId: i + 1 })),
        copies: this.copies };
    },
    spawnPhase(_sys, input) {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      this.spawns.push(input.members.map((m) => m.memberKey));
      this.anchors.push(input.anchorPoint.x);
      const spawned = input.members.map((m) => {
        const entityId = this.nextId++;
        this.alive.add(entityId);
        return { memberKey: m.memberKey, entityId, hullGroup: m.hullGroup };
      });
      return { ok: true, spawned, unspawnable: [] };
    },
    readMembers(_sys, ids) {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, live: ids.filter((id) => this.alive.has(id)).map((entityId) => ({ entityId, position: null })),
        gone: ids.filter((id) => !this.alive.has(id)) };
    },
    despawn(_sys, ids) {
      this.despawned.push(...ids);
      for (const id of ids) this.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    kill(n) {
      for (const id of [...this.alive].slice(0, n === undefined ? this.alive.size : n)) this.alive.delete(id);
    } };
}

function fakeSites(over = {}) {
  const sitesByEvent = new Map();
  const releases = [];
  const self = {
    created: [],
    releases,
    createdByEvent: new Map(),
    maxActiveSites: over.maxActiveSites,
    maxSystemSites: over.maxSystemSites,
    systemSitesCount: over.systemSitesCount,
    listSitesByEvent(eventId, _tx) {
      const sites = sitesByEvent.get(eventId) || [];
      return { ok: true, sites: sites.map((s) => ({ ...s })) };
    },
    createSiteInTx(tx, spec) {
      assert.strictEqual(tx.inTransaction, true);
      if (typeof spec.templateId !== "string" || spec.templateId === "") {
        return { ok: false, reason: "SITE_REQUEST_INVALID", detail: "templateId" };
      }
      const existing = sitesByEvent.get(spec.eventId) || [];
      if (self.maxActiveSites && existing.length >= self.maxActiveSites) {
        return { ok: false, reason: "SITES_FULL" };
      }
      if (self.maxSystemSites && self.systemSitesCount && self.systemSitesCount >= self.maxSystemSites) {
        return { ok: false, reason: "SYSTEM_WINDOW_FULL" };
      }
      if (existing.some((s) => s.slot === spec.slot)) {
        return { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
      }
      const site = { eventId: spec.eventId, slot: spec.slot, systemId: spec.systemId, state: "ACTIVE",
        position: { x: 1000 * spec.slot, y: 2, z: 3 }, siteKey: `site:${spec.eventId}:${spec.slot}`, label: spec.label, factionId: spec.factionId, siteKind: spec.siteKind, expiresAt: spec.expiresAt };
      existing.push(site);
      sitesByEvent.set(spec.eventId, existing);
      self.created.push(spec);
      self.createdByEvent.set(spec.eventId, existing);
      return { ok: true, siteKey: site.siteKey };
    },
    releaseSlotInTx(tx, eventId, slot, reason) {
      assert.strictEqual(tx.inTransaction, true);
      const existing = sitesByEvent.get(eventId) || [];
      const idx = existing.findIndex((s) => s.slot === slot);
      if (idx >= 0) {
        existing.splice(idx, 1);
        releases.push({ eventId, slot, reason });
        return { ok: true, released: 1 };
      }
      return { ok: true, released: 0 };
    },
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      sitesByEvent.delete(eventId);
      return { ok: true };
    },
    addSite(eventId, site) {
      const existing = sitesByEvent.get(eventId) || [];
      existing.push(site);
      sitesByEvent.set(eventId, existing);
      const byEvent = self.createdByEvent.get(eventId) || [];
      byEvent.push(site);
      self.createdByEvent.set(eventId, byEvent);
    }
  };
  return self;
}

function fakeOccupation() {
  return { calls: [], keys: new Set(),
    dropInfluenceInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push([spec.factionId, spec.points, spec.reason, spec.allowNonController, key]);
      if (this.keys.has(key)) return { ok: true, outcome: "DUPLICATE" };
      this.keys.add(key);
      return { ok: true, outcome: "APPLIED", written: true };
    } };
}

function fakePresence(sys) {
  return { getStatus: () => ({ available: true }), isObserved: (id) => id === sys };
}

function harnessTrail(store, overSettings, overPower, opts = {}) {
  const eventId = opts.eventId || EVENT_TRAIL;
  const world = opts.world || null;
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "hevt:stock", reason: "seed", at: NOW,
      deltas: hullDeltas([{ hullGroup: "cruiser", count: 10 }], 1).deltas }).ok);
  });
  const repo = createHeavyEventRepository({ journal });
  const settings = settingsOf(overSettings);
  const power = powerOf({ maxUpscaleSteps: 0, ...overPower });
  const variant = "courier";
  const affix = "none";
  const members = powerMembersOf("trail", 1, variant, power.maxUpscaleSteps,
    { trailPockets: (world || power).trailPockets }).members;
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId, planKey: `pw:1800000:1:0`, eventType: "trail", tier: 1,
    systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
    integrity: null, seed: 1, at: NOW, expiresAt: NOW + settings.plannedTtlMs, dueAt: null, variant, affix }).ok));
  const seam = fakeSeam();
  const sites = fakeSites();
  sites.addSite(eventId, { eventId, slot: 0, state: "ACTIVE", position: { x: 1, y: 2, z: 3 }, siteKey: `site:${eventId}:0`, label: "Test Trail Pocket 1", factionId: PIRATE, siteKind: "anomaly", expiresAt: NOW + settings.plannedTtlMs + settings.engagedMaxMs + settings.aftermathMs });
  const occupation = fakeOccupation();
  const presence = fakePresence(SYS);
  const counters = {};
  const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
  const stationsCtx = { getMode: () => "ready", repository: stations };
  const live = createLive({ store, repo, settings, power, world, journal, getStations: () => stationsCtx,
    getSites: () => sites, getPresence: () => presence, getSeam: () => seam, getOccupation: () => occupation,
    admits: () => true, factionName: () => FACTION_NAME }, hooks);
  const wrecks = { ok: true, placed: [],
    place(spec) {
      this.placed.push(spec);
      return { ok: true, vendorWrites: 0 };
    },
    readGrid: () => ({ ok: true, sceneLoaded: true, players: [] }) };
  const reward = createReward({ store, repo, journal, settings, power, eventRewards: BASE.eventRewards,
    fallbackLootTableId: "fallback", getSites: () => sites, getWrecks: () => wrecks, getStations: () => stationsCtx,
    admits: () => true }, hooks);
  const row = () => run(store, (tx) => repo.getInTx(tx, eventId).row);
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 }, stations: stationsCtx, sites, presence,
    occupation, adapter: { getHeavyEventScene: () => ({ ok: true, seam }) },
    world: { repository: { getSystem: (_tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: PIRATE } }) } } };
  const h = { live, reward, wrecks, seam, sites, occupation, counters, row, repo, ctx, settings, power };
  h.restart = (at) => {
    h.live.stopAll();
    run(store, (tx) => {
      const cur = repo.getInTx(tx, eventId).row;
      assert.ok(repo.transitionInTx(tx, { eventId, expectedVersion: cur.version, from: S.STATE.ENGAGED,
        to: S.STATE.PLANNED, at, patch: { abandons: cur.abandons + 1 }, reason: S.END_REASON.RESTART }).ok);
    });
    h.live = createLive({ store, repo, settings, power, world, journal, getStations: () => stationsCtx,
      getSites: () => sites, getPresence: () => presence, getSeam: () => seam, getOccupation: () => occupation,
      admits: () => true, factionName: () => FACTION_NAME }, hooks);
  };
  return h;
}

function harnessHeavy(store, type, overSettings) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "hevt:stock", reason: "seed", at: NOW,
      deltas: hullDeltas([{ hullGroup: "cruiser", count: 10 }], 1).deltas }).ok);
  });
  const repo = createHeavyEventRepository({ journal });
  const settings = settingsOf(overSettings);
  const waveParams = type === "defense" ? { defenseWaves: settings.defenseWaves, waveGrowthPermille: settings.waveGrowthPermille } : undefined;
  const membersResult = membersOf(type, 1, settings.maxUpscaleSteps, waveParams);
  assert.ok(membersResult.ok, `membersOf failed for ${type}: ${membersResult.reason}`);
  const members = membersResult.members;
  assert.ok(Array.isArray(members) && members.length > 0, `members empty for ${type}`);
  const bucket = Math.floor(NOW / settings.planIntervalMs);
  const eventId = type === "redoubt" ? EVENT_REDOUBT : type === "foundry" ? EVENT_FOUNDRY : EVENT_DEFENSE;
  const planKey = `${settings.planIntervalMs}:${bucket}:${type === "redoubt" ? 0 : type === "foundry" ? 1 : 2}`;
  const planResult = run(store, (tx) => repo.planInTx(tx, { eventId, planKey, eventType: type, tier: 1,
    systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
    integrity: null, seed: 1, at: NOW, expiresAt: NOW + settings.plannedTtlMs, dueAt: null }));
  assert.ok(planResult.ok, `planInTx failed for ${type}: ${planResult.reason} ${planResult.detail ? JSON.stringify(planResult.detail) : ""}`);
  const seam = fakeSeam();
  const sites = fakeSites();
  sites.addSite(eventId, { eventId, slot: 0, state: "ACTIVE", position: { x: 1, y: 2, z: 3 }, siteKey: `site:${eventId}:0`, label: "Test Heavy", factionId: PIRATE, siteKind: "anomaly", expiresAt: NOW + settings.plannedTtlMs + settings.engagedMaxMs + settings.aftermathMs });
  const occupation = fakeOccupation();
  const presence = fakePresence(SYS);
  const counters = {};
  const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
  const stationsCtx = { getMode: () => "ready", repository: stations };
  const live = createLive({ store, repo, settings, journal, getStations: () => stationsCtx, getSites: () => sites,
    getPresence: () => presence, getSeam: () => seam, getOccupation: () => occupation, admits: () => true }, hooks);
  const wrecks = { 
    ok: true,
    placed: [], 
    place(spec) { this.placed.push(spec); return { ok: true, vendorWrites: 1 }; }, 
    flush() {},
    readGrid() { return { ok: true, sceneLoaded: true, players: [] }; }
  };
  const reward = createReward({ store, repo, journal, settings, eventRewards: BASE.eventRewards, fallbackLootTableId: "fallback",
    getSites: () => sites, getWrecks: () => wrecks, getStations: () => stationsCtx, admits: () => true }, hooks);
  const row = () => run(store, (tx) => repo.getInTx(tx, eventId).row);
  return { live, reward, seam, sites, occupation, counters, row, repo, settings, eventId };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PT1-PT5 power trail", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("PT1 trail 3 pockets: k0->k1->k2->CLEARED, each beacon proper siteKind, previous slot released, chest in slot 2", () => {
    withStore(driver, ({ store }) => {
      const h = harnessTrail(store, { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 },
        { trailPockets: 3, pocketTtlMs: 3600000, maxUpscaleSteps: 0 });
      let r = h.row();
      assert.strictEqual(r.state, "PLANNED");
      assert.strictEqual(r.pocket, 0);
      h.live.pass(NOW);
      r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.pocket], ["ENGAGED", 1, 0]);
      const site0 = h.sites.createdByEvent.get(EVENT_TRAIL).find((s) => s.slot === 0);
      assert.ok(site0, "site 0 created");
      assert.strictEqual(site0.siteKind, "anomaly", "pocket 0 is anomaly");
      h.seam.kill();
      h.live.pass(NOW + 1000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.pocket, r.abandons], ["PLANNED", 2, 1, 0]);
      assert.strictEqual(r.result && r.result.pockets, 1, "result_json.pockets = 1 after first pocket");
      assert.deepStrictEqual(h.seam.anchors, [1], "no spawn of pocket 1 at the old beacon");
      h.live.pass(NOW + 1500);
      r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.pocket], ["ENGAGED", 2, 1]);
      assert.deepStrictEqual(h.seam.anchors, [1, 1000], "pocket 1 spawns at beacon slot 1");
      const site1 = h.sites.createdByEvent.get(EVENT_TRAIL).find((s) => s.slot === 1);
      assert.ok(site1, "site 1 created");
      assert.strictEqual(site1.siteKind, "signature", "pocket 1 is signature");
      assert.strictEqual(h.sites.releases.some((rel) => rel.eventId === EVENT_TRAIL && rel.slot === 0 && rel.reason === "POCKET"), true, "slot 0 released");
      h.seam.kill();
      h.live.pass(NOW + 2000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.pocket], ["PLANNED", 3, 2]);
      assert.strictEqual(r.result && r.result.pockets, 2, "result_json.pockets = 2 after second pocket");
      h.live.pass(NOW + 2500);
      assert.deepStrictEqual([h.row().state, h.seam.anchors], ["ENGAGED", [1, 1000, 2000]]);
      const site2 = h.sites.createdByEvent.get(EVENT_TRAIL).find((s) => s.slot === 2);
      assert.ok(site2, "site 2 created");
      assert.strictEqual(site2.siteKind, "signature", "pocket 2 is signature");
      assert.strictEqual(h.sites.releases.some((rel) => rel.eventId === EVENT_TRAIL && rel.slot === 1 && rel.reason === "POCKET"), true, "slot 1 released");
      h.seam.kill();
      h.live.pass(NOW + 3000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.open, r.rewardState, r.pocket], ["CLEARED", true, "PENDING", 2]);
      assert.strictEqual(r.result && r.result.pockets, 2, "result_json.pockets = 2 at CLEARED");
      h.reward.pass(NOW + 3000 + h.settings.rewardWaitMs);
      assert.strictEqual(h.wrecks.placed.length, 1, JSON.stringify(h.counters));
      const chest = h.wrecks.placed[0];
      assert.deepStrictEqual([chest.slot, chest.siteKey, chest.lootRolls], [2, `site:${EVENT_TRAIL}:2`, 3]);
      assert.strictEqual(h.row().state, "COMPLETED");
      assert.deepStrictEqual([h.counters["power.pocket"], h.counters["cleared.trail"]], [2, 1]);
    });
  });

  test("PT2 NEXT_POCKET idempotency: duplicate step = one beacon k+1, one release", () => {
    withStore(driver, ({ store }) => {
      const h = harnessTrail(store, { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 },
        { trailPockets: 3, pocketTtlMs: 3600000, maxUpscaleSteps: 0 });
      h.live.pass(NOW);
      assert.strictEqual(h.row().pocket, 0);
      h.seam.kill();
      h.live.pass(NOW + 1000);
      let r = h.row();
      assert.strictEqual(r.pocket, 1);
      const releasesAfterFirst = h.sites.releases.filter((rel) => rel.eventId === EVENT_TRAIL && rel.slot === 0).length;
      const createsAfterFirst = h.sites.created.filter((c) => c.eventId === EVENT_TRAIL && c.slot === 1).length;
      assert.strictEqual(releasesAfterFirst, 1, "one release of slot 0");
      assert.strictEqual(createsAfterFirst, 1, "one create of slot 1");
      h.live.pass(NOW + 1000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.pocket], ["ENGAGED", 1], "pocket unchanged on a second pass");
      const releasesAfterSecond = h.sites.releases.filter((rel) => rel.eventId === EVENT_TRAIL && rel.slot === 0).length;
      const createsAfterSecond = h.sites.created.filter((c) => c.eventId === EVENT_TRAIL && c.slot === 1).length;
      assert.strictEqual(releasesAfterSecond, 1, "still one release of slot 0");
      assert.strictEqual(createsAfterSecond, 1, "still one create of slot 1");
      assert.strictEqual(h.counters["power.pocket"], 1, "power.pocket counter only incremented once");
    });
  });

  test("PT3 NEXT_POCKET SITES_FULL leaves ENGAGED, power.deferred.SITES++, retries next pass", () => {
    withStore(driver, ({ store }) => {
      const h = harnessTrail(store, { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 },
        { trailPockets: 3, pocketTtlMs: 3600000, maxUpscaleSteps: 0 });
      h.sites.created = [];
      h.sites.releases = [];
      h.sites.createdByEvent.clear();
      h.sites.maxActiveSites = 1;
      h.sites.addSite(EVENT_TRAIL, { eventId: EVENT_TRAIL, slot: 2, state: "ACTIVE", position: { x: 1, y: 2, z: 3 }, siteKey: "dummy" });
      h.live.pass(NOW);
      assert.strictEqual(h.row().pocket, 0);
      h.seam.kill();
      h.live.pass(NOW + 1000);
      let r = h.row();
      assert.strictEqual(r.state, "ENGAGED", "row stays ENGAGED on SITES_FULL");
      assert.strictEqual(r.pocket, 0, "pocket unchanged");
      assert.strictEqual(h.counters["power.deferred.SITES"], 1, "power.deferred.SITES incremented");
      h.sites.maxActiveSites = 2;
      const eventSites = h.sites.createdByEvent.get(EVENT_TRAIL) || [];
      const dummyIdx = eventSites.findIndex(s => s.slot === 2);
      if (dummyIdx >= 0) eventSites.splice(dummyIdx, 1);
      h.live.pass(NOW + 2000);
      r = h.row();
      assert.strictEqual(r.pocket, 1, "pocket advanced on retry");
      assert.strictEqual(h.counters["power.pocket"], 1, "power.pocket incremented on successful transition");
    });
  });

  test("PT4 restart in pocket 1 -> engage at slot 1", () => {
    withStore(driver, ({ store }) => {
      const h = harnessTrail(store, { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 },
        { trailPockets: 3, pocketTtlMs: 3600000, maxUpscaleSteps: 0 });
      h.live.pass(NOW);
      h.seam.kill();
      h.live.pass(NOW + 1000);
      h.live.pass(NOW + 1500);
      assert.deepStrictEqual([h.row().state, h.row().pocket], ["ENGAGED", 1]);
      h.restart(NOW + 2000);
      let r = h.row();
      assert.deepStrictEqual([r.state, r.pocket, r.phase, r.abandons], ["PLANNED", 1, 2, 1]);
      h.live.pass(NOW + 3000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.phase, r.pocket], ["ENGAGED", 2, 1], "engaged at pocket 1");
      assert.deepStrictEqual(h.seam.anchors, [1, 1000, 1000], "every engage of pocket 1 at beacon slot 1");
    });
  });

  test("PT5 heavy row (pocket 0) unchanged: redoubt/foundry/defense behave identically", () => {
    withStore(driver, ({ store }) => {
      for (const type of ["redoubt", "foundry", "defense"]) {
        const over = { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 };
        if (type === "defense") over.defenseWaves = 2;
        const h = harnessHeavy(store, type, over);
        h.live.pass(NOW);
        let r = h.row();
        assert.deepStrictEqual([r.state, r.phase, r.pocket], ["ENGAGED", 1, 0], `${type}: engage at pocket 0`);
        h.seam.kill();
        h.live.pass(NOW + 1000);
        r = h.row();
        assert.strictEqual(r.pocket, 0, `${type}: pocket stays 0`);
        if (type !== "defense") {
          h.seam.kill();
          h.live.pass(NOW + 2000);
          r = h.row();
          assert.deepStrictEqual([r.state, r.pocket], ["CLEARED", 0], `${type}: CLEARED at pocket 0`);
        } else {
          h.seam.kill();
          h.live.pass(NOW + 2000);
          r = h.row();
          assert.deepStrictEqual([r.state, r.pocket], ["CLEARED", 0], `${type}: CLEARED at pocket 0`);
        }
        h.reward.pass(NOW + 3000);
        r = h.row();
        assert.strictEqual(r.state, "COMPLETED", `${type}: COMPLETED`);
      }
    });
  });

  test("LS1 power pocket 2: heavyEvents.beaconTemplateId, power label, powerSites.pocketTtlMs, power.pocket", () => {
    withStore(driver, ({ store }) => {
      const h = harnessTrail(store, { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 },
        { trailPockets: 3, pocketTtlMs: 1800000, maxUpscaleSteps: 0 });
      h.live.pass(NOW);
      h.seam.kill();
      h.live.pass(NOW + 1000);
      const r = h.row();
      assert.deepStrictEqual([r.state, r.pocket], ["PLANNED", 1], JSON.stringify(h.counters));
      const spec = h.sites.created.find((c) => c.slot === 1);
      assert.ok(spec, "pocket 2 beacon requested");
      assert.ok(typeof h.settings.beaconTemplateId === "string" && h.settings.beaconTemplateId !== "");
      assert.strictEqual(spec.templateId, h.settings.beaconTemplateId);
      assert.strictEqual(spec.label, `${powerLabelOf(FACTION_NAME, "trail", "none")} Pocket 2`.slice(0, 64));
      assert.strictEqual(spec.expiresAt, NOW + 1000 + 1800000);
      assert.deepStrictEqual([h.counters["power.pocket"], h.counters["anomaly.pocket"]], [1, undefined]);
    });
  });

  test("LS2 world trail: eventAnomalies trailPockets / pocketTtlMs, anomaly.pocket, SITES_FULL -> anomaly.deferred", () => {
    withStore(driver, ({ store }) => {
      const world = { ...BASE.eventAnomalies, enabled: true, trailPockets: 4, pocketTtlMs: 1200000 };
      const h = harnessTrail(store, { maxUpscaleSteps: 0, engagedMaxMs: 3600000, abandonGraceMs: 60000, plannedTtlMs: 7200000 },
        { trailPockets: 3, pocketTtlMs: 3600000, maxUpscaleSteps: 0 }, { eventId: EVENT_WORLD_TRAIL, world });
      h.sites.maxActiveSites = 1;
      h.sites.addSite(EVENT_WORLD_TRAIL, { eventId: EVENT_WORLD_TRAIL, slot: 9, state: "ACTIVE", siteKey: "dummy",
        position: { x: 1, y: 2, z: 3 } });
      h.live.pass(NOW);
      assert.deepStrictEqual([h.row().state, h.row().pocket], ["ENGAGED", 0]);
      h.seam.kill();
      h.live.pass(NOW + 500);
      assert.deepStrictEqual([h.row().state, h.row().pocket], ["ENGAGED", 0]);
      assert.deepStrictEqual([h.counters["anomaly.deferred.SITES"], h.counters["power.deferred.SITES"]], [1, undefined]);
      h.sites.maxActiveSites = 0;
      let at = NOW + 1000;
      h.live.pass(at);
      const steps = [at];
      for (let k = 1; k <= 2; k += 1) {
        at += 1000;
        h.live.pass(at);
        assert.deepStrictEqual([h.row().state, h.row().pocket], ["ENGAGED", k]);
        h.seam.kill();
        h.live.pass(at + 500);
        steps.push(at + 500);
      }
      const r = h.row();
      assert.deepStrictEqual([r.state, r.pocket], ["PLANNED", 3], JSON.stringify(h.counters));
      const created = h.sites.created.filter((c) => c.eventId === EVENT_WORLD_TRAIL);
      assert.deepStrictEqual(created.map((c) => [c.slot, c.expiresAt, c.label, c.templateId]),
        [1, 2, 3].map((slot, i) => [slot, steps[i] + 1200000,
          `${worldLabelOf(FACTION_NAME, "courier")} Pocket ${slot + 1}`.slice(0, 64), h.settings.beaconTemplateId]));
      assert.deepStrictEqual([h.counters["anomaly.pocket"], h.counters["power.pocket"]], [3, undefined]);
    });
  });
};