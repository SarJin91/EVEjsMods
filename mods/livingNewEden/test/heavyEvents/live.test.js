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
const { startHeavyEvents } = require("../../lib/heavyEvents");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:1";
const EVENT = "hev:1:0";

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const settingsOf = (over) => ({ ...BASE.heavyEvents, enabled: true, ...(over || {}) });

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeSeam() {
  return { scene: true, players: 1, copies: 0, nextId: 9000, alive: new Set(), spawns: [], despawned: [],
    readGrid() {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, players: Array.from({ length: this.players }, (_, i) => ({ characterId: i + 1, entityId: i + 1 })),
        copies: this.copies };
    },
    spawnPhase(_sys, input) {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      this.spawns.push(input.members.map((m) => m.memberKey));
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

function harness(store, over) {
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "hevt:stock", reason: "seed", at: NOW,
      deltas: hullDeltas([{ hullGroup: "cruiser", count: 1 }], 1).deltas }).ok);
  });
  const repo = createHeavyEventRepository({ journal });
  const settings = settingsOf(over);
  const members = membersOf("redoubt", 1, settings.maxUpscaleSteps).members;
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: EVENT, planKey: `1:${EVENT}`, eventType: "redoubt", tier: 1,
    systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
    integrity: null, seed: 1, at: NOW, expiresAt: NOW + settings.plannedTtlMs, dueAt: null }).ok));
  const seam = fakeSeam();
  const sites = { cleaned: [],
    listSitesByEvent: () => ({ ok: true, sites: [{ slot: 0, state: "ACTIVE", position: { x: 1, y: 2, z: 3 } }] }),
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.cleaned.push([eventId, reason]);
      return { ok: true };
    } };
  const occupation = { calls: [], keys: new Set(),
    dropInfluenceInTx(tx, spec, key) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push([spec.factionId, spec.points, spec.reason, spec.allowNonController, key]);
      if (this.keys.has(key)) return { ok: true, outcome: "DUPLICATE" };
      this.keys.add(key);
      return { ok: true, outcome: "APPLIED", written: true };
    } };
  const presence = { getStatus: () => ({ available: false }), isObserved: (id) => id === SYS };
  const counters = {};
  const hooks = { bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, refuse: () => {} };
  const stationsCtx = { getMode: () => "ready", repository: stations };
  const live = createLive({ store, repo, settings, getStations: () => stationsCtx, getSites: () => sites,
    getPresence: () => presence, getSeam: () => seam, getOccupation: () => occupation, admits: () => true }, hooks);
  const row = () => run(store, (tx) => repo.getInTx(tx, EVENT).row);
  const hulls = () => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
  const statesOf = (r, phase) => r.members.filter((m) => m.phase === phase).map((m) => m.state);
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 }, stations: stationsCtx, sites, presence,
    occupation, adapter: { getHeavyEventScene: () => ({ ok: true, seam }) },
    world: { repository: { getSystem: (_tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: PIRATE } }) } } };
  return { live, seam, sites, occupation, counters, row, hulls, statesOf, repo, ctx, settings };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("LV1-LV5 heavy events live", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("LV1 engage -> phase 1 wiped -> phase 2 -> CLEAR: influence and reserve back once, a repeated step = duplicate",
    () => {
      withStore(driver, ({ store }) => {
        const h = harness(store);
        const before = h.hulls();
        h.live.pass(NOW);
        let r = h.row();
        assert.deepStrictEqual([r.state, r.phase, r.scaleSteps, r.engagedAt], ["ENGAGED", 1, 0, NOW]);
        assert.deepStrictEqual(h.seam.spawns, [["p1:0", "p1:1", "p1:2", "p1:3", "p1:4", "p1:5", "p1:6"]]);
        h.seam.kill();
        h.live.pass(NOW + 1000);
        r = h.row();
        assert.deepStrictEqual([r.state, r.phase], ["ENGAGED", 2]);
        assert.ok(h.statesOf(r, 1).every((x) => x === "DESTROYED"));
        assert.deepStrictEqual(h.seam.spawns[1], ["p2:0", "p2:1", "p2:2"]);
        h.seam.kill();
        h.live.pass(NOW + 2000);
        r = h.row();
        assert.deepStrictEqual([r.state, r.open, r.rewardState], ["CLEARED", true, "PENDING"]);
        assert.strictEqual(h.hulls(), before + 6);
        assert.deepStrictEqual(h.occupation.calls, [[PIRATE, BASE.heavyEvents.redoubtInfluencePoints,
          "HEAVY_EVENT_CLEARED", true, S.influenceKeyOf(EVENT)]]);
        assert.deepStrictEqual([h.counters.engaged, h.counters.phase, h.counters["cleared.redoubt"], h.counters.hullsLost,
          h.counters.hullsReturned, h.counters.errors], [1, 1, 1, 10, 6, undefined]);
        assert.strictEqual(h.seam.despawned.length, 10, "gone ids handed to despawn (dormancyGuard)");
        const seen = { ...r, state: "ENGAGED", version: r.version - 1 };
        const again = run(store, (tx) => h.live.clearInTx(tx, seen, NOW + 3000));
        assert.deepStrictEqual([again.duplicate, again.returned], [true, 0]);
        h.live.pass(NOW + 4000);
        assert.deepStrictEqual([h.hulls(), h.occupation.calls.length, h.row().version], [before + 6, 1, r.version]);
      });
    });

  test("LV2 abandon: live ships despawned, destroyed stay DESTROYED, a new engage fields only RESERVED", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.live.pass(NOW);
      const firstIds = [...h.seam.alive];
      h.seam.kill(2);
      h.live.pass(NOW + 1000);
      assert.deepStrictEqual(h.statesOf(h.row(), 1).filter((x) => x === "DESTROYED").length, 2);
      h.seam.players = 0;
      h.live.pass(NOW + 1000 + h.settings.abandonGraceMs);
      const r = h.row();
      assert.deepStrictEqual([r.state, r.abandons, r.phase], ["PLANNED", 1, 1]);
      assert.strictEqual(h.seam.alive.size, 0);
      assert.deepStrictEqual([...h.seam.despawned].sort(), [...firstIds].sort());
      h.seam.players = 1;
      h.live.pass(NOW + 2000 + h.settings.abandonGraceMs);
      assert.strictEqual(h.row().state, "ENGAGED");
      assert.deepStrictEqual(h.seam.spawns[1], ["p1:2", "p1:3", "p1:4", "p1:5", "p1:6"]);
      assert.strictEqual(h.counters.abandoned, 1);
    });
  });

  test("LV3 no scene loaded: gone ids are not losses; after the grace the event is abandoned", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.live.pass(NOW);
      h.seam.kill();
      h.seam.scene = false;
      h.live.pass(NOW + 1000);
      let r = h.row();
      assert.strictEqual(r.state, "ENGAGED");
      assert.ok(r.members.every((m) => m.state === "RESERVED"));
      assert.strictEqual(h.counters.hullsLost, undefined);
      h.live.pass(NOW + h.settings.abandonGraceMs);
      r = h.row();
      assert.deepStrictEqual([r.state, r.abandons], ["PLANNED", 1]);
      assert.ok(r.members.every((m) => m.state === "RESERVED"));
    });
  });

  test("LV4 scaling only up: 7 players unlock 2 steps, 1 player at phase 2 keeps scale_steps 2", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.seam.players = 7;
      h.live.pass(NOW);
      assert.strictEqual(h.row().scaleSteps, 2);
      assert.deepStrictEqual(h.seam.spawns[0].filter((k) => k.startsWith("u")), ["u1:0", "u1:1", "u2:0", "u2:1"]);
      h.seam.kill();
      h.seam.players = 1;
      h.live.pass(NOW + 1000);
      const r = h.row();
      assert.deepStrictEqual([r.phase, r.scaleSteps], [2, 2]);
      assert.deepStrictEqual(h.seam.spawns[1], ["p2:0", "p2:1", "p2:2"]);
    });
  });

  test("LV5 service: maxLiveShips below the phase defers the engage (deferred.BUDGET, no spawn)", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, { maxLiveShips: 5 });
      const config = { ...BASE, enabled: true, heavyEvents: h.settings, modules: { ...BASE.modules,
        world: { ...BASE.modules.world, enabled: true }, sites: { ...BASE.modules.sites, enabled: true } } };
      const started = startHeavyEvents({ config, ctx: h.ctx, adapter: h.ctx.adapter, clock: { now: () => NOW }, getFactionKind: () => "pirate",
        setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
      assert.ok(started.ok, JSON.stringify(started));
      const svc = started.heavyEvents;
      svc.runPass(NOW);
      assert.deepStrictEqual([h.row().state, h.seam.spawns.length, svc.getStatus().counters["deferred.BUDGET"]],
        ["PLANNED", 0, 1], JSON.stringify(svc.getStatus()));
      svc.stop("test");
    });
  });
};
