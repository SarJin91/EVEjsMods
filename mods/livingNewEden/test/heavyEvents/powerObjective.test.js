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
const { membersOf: powerMembersOf, META } = require("../../lib/heavyEvents/power/catalog");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { createLive } = require("../../lib/heavyEvents/live");
const { powerChestSpecOf } = require("../../lib/heavyEvents/reward");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:1";
const EVENT = "hpw:1:0";
const MINERALS = 50000;

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SETTINGS = { ...BASE.heavyEvents, enabled: true, maxUpscaleSteps: 0, engagedMaxMs: 3600000,
  abandonGraceMs: 1000, plannedTtlMs: 7200000 };
const POWER = { ...BASE.powerSites, enabled: true, maxUpscaleSteps: 0, escapeAfterMs: 1000, huntInfluencePoints: 20,
  convoyInfluencePoints: 10, convoyDrainPermillePerHauler: 30, drainMaxUnits: 100000, lootSharePermille: 100,
  lootMaxUnitsPerType: 10000, convoyRolls: "1,1" };

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function fakeSeam() {
  return { scene: true, players: 1, nextId: 9000, alive: new Set(), idOf: new Map(), despawned: [],
    readGrid() {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      return { ok: true, players: Array.from({ length: this.players }, (_, i) => ({ characterId: i + 1 })), copies: 0 };
    },
    spawnPhase(_sys, input) {
      if (!this.scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
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
      return { ok: true, live: ids.filter((id) => this.alive.has(id)).map((entityId) => ({ entityId, position: null })),
        gone: ids.filter((id) => !this.alive.has(id)) };
    },
    despawn(_sys, ids) {
      this.despawned.push(...ids);
      for (const id of ids) this.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    kill(keys) {
      for (const key of keys) this.alive.delete(this.idOf.get(key));
    } };
}

function harness(store, type, variant, opts = {}) {
  const EVENT_ID = opts.eventId || EVENT;
  const world = opts.world || null;
  const journal = createJournal({ clock: { now: () => NOW }, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "hevt:stock", reason: "seed", at: NOW,
      deltas: [{ itemKind: "mineral", itemKey: "type:34", delta: MINERALS }] }).ok);
  });
  const repo = createHeavyEventRepository({ journal });
  const members = powerMembersOf(type, 1, variant, 0, { trailPockets: (world || POWER).trailPockets }).members;
  run(store, (tx) => assert.ok(repo.planInTx(tx, { eventId: EVENT_ID, planKey: "pw:1800000:1:0", eventType: type,
    tier: 1, systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
    integrity: null, seed: 1, at: NOW, expiresAt: NOW + SETTINGS.plannedTtlMs, dueAt: null, variant,
    affix: "none" }).ok));
  const seam = fakeSeam();
  const site = { eventId: EVENT_ID, slot: 0, state: "ACTIVE", position: { x: 1, y: 2, z: 3 },
    siteKey: `site:${EVENT_ID}:0` };
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
  const makeLive = () => createLive({ store, repo, settings: SETTINGS, power: POWER, world, journal,
    getStations: () => stationsCtx, getSites: () => sites, getPresence: () => ({ isObserved: (id) => id === SYS }),
    getSeam: () => seam, getOccupation: () => occupation, admits: () => true }, hooks);
  const h = { live: makeLive(), seam, sites, occupation, counters, site, members };
  h.row = () => run(store, (tx) => repo.getInTx(tx, EVENT_ID).row);
  h.hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key)).found === true;
  h.stock = (kind, key) => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === kind && (key === undefined || i.itemKey === key)).reduce((a, i) => a + i.quantity, 0);
  h.keysOf = (role) => h.row().members.filter((m) => (role ? m.role === role : !m.role)).map((m) => m.key);
  h.restart = (at) => {
    h.live.stopAll();
    run(store, (tx) => {
      const cur = repo.getInTx(tx, EVENT_ID).row;
      assert.ok(repo.transitionInTx(tx, { eventId: EVENT_ID, expectedVersion: cur.version, from: S.STATE.ENGAGED,
        to: S.STATE.PLANNED, at, patch: { abandons: cur.abandons + 1 }, reason: S.END_REASON.RESTART }).ok);
    });
    h.live = makeLive();
  };
  return h;
}

const stateOf = (row, key) => row.members.find((m) => m.key === key).state;

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("PO1-PO5 power objective", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("PO1 hunt: commander killed -> CLEARED, escort despawned, influence once, reward PENDING", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.HUNT, "guarded");
      h.live.pass(NOW);
      assert.strictEqual(h.row().state, "ENGAGED");
      const [commander] = h.keysOf(P.ROLE.OBJECTIVE);
      const escort = h.keysOf(null);
      assert.ok(commander && escort.length >= 1);
      h.seam.kill([commander]);
      h.live.pass(NOW + 500);
      const r = h.row();
      assert.deepStrictEqual([r.state, r.rewardState, stateOf(r, commander)], ["CLEARED", "PENDING", "DESTROYED"]);
      assert.ok(escort.every((k) => stateOf(r, k) === "RESERVED"), "the escort is not a loss");
      assert.ok(escort.every((k) => h.seam.despawned.includes(h.seam.idOf.get(k))), "escort despawned");
      assert.deepStrictEqual(h.occupation.calls, [[PIRATE, POWER.huntInfluencePoints, S.influenceKeyOf(EVENT)]]);
      assert.strictEqual(META[P.TYPE.HUNT].rewardProfile, "power_rare");
      assert.deepStrictEqual([h.counters["cleared.hunt"], h.counters.hullsLost, h.counters.hullsReturned],
        [1, 1, escort.length]);
      h.live.pass(NOW + 1500);
      assert.deepStrictEqual([h.occupation.calls.length, h.counters["cleared.hunt"], h.counters["power.escaped"]],
        [1, 1, undefined]);
    });
  });

  test("PO2 hunt: commander escaped -> ESCAPE step, then FAILED ESCAPED, no chest, hulls back", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.HUNT, "guarded");
      h.live.pass(NOW);
      const [commander] = h.keysOf(P.ROLE.OBJECTIVE);
      h.live.pass(NOW + 500);
      assert.deepStrictEqual([h.row().state, h.counters["power.escaped"]], ["ENGAGED", undefined], "not yet due");
      h.live.pass(NOW + 1000);
      let r = h.row();
      assert.deepStrictEqual([r.state, r.phase, stateOf(r, commander)], ["ENGAGED", 1, "ESCAPED"]);
      assert.ok(h.hasKey(P.escapeKeyOf(EVENT, 1)));
      assert.ok(h.seam.despawned.includes(h.seam.idOf.get(commander)), "commander left the grid");
      assert.strictEqual(h.counters["power.escaped"], 1);
      h.live.pass(NOW + 1500);
      r = h.row();
      assert.deepStrictEqual([r.state, r.endReason, r.rewardState, r.open], ["FAILED", "ESCAPED", "NONE", false]);
      assert.deepStrictEqual([h.counters["power.failed.ESCAPED"], h.counters.hullsReturned, h.counters.hullsLost || 0],
        [1, r.members.length, 0], "every hull back, the escaped commander too");
      assert.strictEqual(h.stock("hull"), r.members.length);
      assert.deepStrictEqual(h.sites.cleaned, [[EVENT, "EVENT_CANCELLED"]]);
      assert.deepStrictEqual(h.occupation.calls, []);
    });
  });

  test("PO3 convoy: 2/3 haulers killed, 1 escaped -> CLEARED haulersKilled=2, proportional drain once", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.CONVOY, "light");
      h.live.pass(NOW);
      const haulers = h.keysOf(P.ROLE.HAULER);
      assert.strictEqual(haulers.length, 3);
      h.seam.kill(haulers.slice(0, 2));
      h.live.pass(NOW + 500);
      let r = h.row();
      assert.deepStrictEqual([r.state, ...haulers.map((k) => stateOf(r, k))],
        ["ENGAGED", "DESTROYED", "DESTROYED", "RESERVED"], "one hauler left -> HOLD");
      h.live.pass(NOW + 1000);
      r = h.row();
      assert.deepStrictEqual([r.state, stateOf(r, haulers[2]), h.counters["power.escaped"]], ["ENGAGED", "ESCAPED", 1]);
      h.live.pass(NOW + 1500);
      r = h.row();
      const units = Math.floor((MINERALS * POWER.convoyDrainPermillePerHauler * 2) / 1000);
      assert.deepStrictEqual([r.state, r.rewardState, r.result.haulersKilled, r.result.drain.outcome,
        r.result.drain.total], ["CLEARED", "PENDING", 2, "APPLIED", units]);
      assert.strictEqual(h.stock("mineral", "type:34"), MINERALS - units);
      assert.deepStrictEqual(h.occupation.calls, [[PIRATE, POWER.convoyInfluencePoints, S.influenceKeyOf(EVENT)]]);
      assert.deepStrictEqual([h.counters["cleared.convoy"], h.counters.mineralsDrained], [1, units]);
      h.live.pass(NOW + 2000);
      assert.deepStrictEqual([h.counters["cleared.convoy"], h.counters.mineralsDrained,
        h.stock("mineral", "type:34")], [1, units, MINERALS - units], "exactly once");
      const built = powerChestSpecOf(r, h.site, { settings: SETTINGS, powerSettings: POWER,
        eventRewards: BASE.eventRewards, fallbackLootTableId: "fallback", META }, NOW + 2000, r.result.drain);
      assert.ok(built.ok, JSON.stringify(built));
      assert.deepStrictEqual([built.profile, built.spec.lootRolls, built.spec.fixedItems],
        ["power_small", 2, [{ typeId: 34, quantity: Math.floor((units * POWER.lootSharePermille) / 1000) }]]);
    });
  });

  test("PO4 no scene / no player on the grid: ABANDON after the grace, never ESCAPE", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.HUNT, "guarded");
      h.live.pass(NOW);
      h.live.pass(NOW + 500);
      h.seam.scene = false;
      h.live.pass(NOW + 1200);
      assert.deepStrictEqual([h.row().state, h.counters["power.escaped"]], ["ENGAGED", undefined],
        "escape due, no scene: the grace runs");
      h.live.pass(NOW + 1600);
      let r = h.row();
      assert.deepStrictEqual([r.state, r.abandons, h.counters["power.escaped"]], ["PLANNED", 1, undefined]);
      h.seam.scene = true;
      h.live.pass(NOW + 2000);
      assert.strictEqual(h.row().state, "ENGAGED");
      h.seam.players = 0;
      h.live.pass(NOW + 3000);
      r = h.row();
      assert.deepStrictEqual([r.state, r.abandons, h.counters["power.escaped"]], ["PLANNED", 2, undefined]);
      assert.ok(r.members.every((m) => m.state === "RESERVED"));
      assert.strictEqual(h.hasKey(P.escapeKeyOf(EVENT, 1)), false);
    });
  });

  test("PO5 restart: the escape timer starts again, DESTROYED and ESCAPED members survive", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store, P.TYPE.HUNT, "guarded");
      h.live.pass(NOW);
      const [commander] = h.keysOf(P.ROLE.OBJECTIVE);
      const [escort] = h.keysOf(null);
      h.seam.kill([escort]);
      h.live.pass(NOW + 500);
      assert.strictEqual(stateOf(h.row(), escort), "DESTROYED");
      h.restart(NOW + 900);
      h.live.pass(NOW + 1000);
      assert.strictEqual(h.row().state, "ENGAGED", "re-engaged");
      h.live.pass(NOW + 1500);
      let r = h.row();
      assert.deepStrictEqual([r.state, stateOf(r, commander), h.counters["power.escaped"]],
        ["ENGAGED", "RESERVED", undefined], "the timer runs from the new engage");
      h.live.pass(NOW + 2000);
      r = h.row();
      assert.deepStrictEqual([stateOf(r, commander), stateOf(r, escort)], ["ESCAPED", "DESTROYED"]);
      h.restart(NOW + 2100);
      r = h.row();
      assert.deepStrictEqual([r.state, stateOf(r, commander), stateOf(r, escort)], ["PLANNED", "ESCAPED", "DESTROYED"]);
      h.live.pass(NOW + 2200);
      h.live.pass(NOW + 2300);
      r = h.row();
      assert.deepStrictEqual([r.state, r.endReason, stateOf(r, commander), stateOf(r, escort)],
        ["FAILED", "ESCAPED", "ESCAPED", "DESTROYED"]);
      assert.deepStrictEqual([h.counters["power.escaped"], h.counters["power.failed.ESCAPED"]], [1, 1]);
    });
  });

  test("LS3 world hideout escape: anomaly.escaped and anomaly.failed.ESCAPED, no power.* mechanic counter", () => {
    withStore(driver, ({ store }) => {
      const world = { ...BASE.eventAnomalies, enabled: true, maxUpscaleSteps: 0, escapeAfterMs: 1000 };
      const h = harness(store, P.TYPE.HUNT, "hideout", { eventId: "hwa:1:0", world });
      h.live.pass(NOW);
      const commanders = h.keysOf(P.ROLE.OBJECTIVE);
      assert.ok(commanders.length >= 1);
      h.live.pass(NOW + 1000);
      assert.deepStrictEqual([h.row().state, h.counters["anomaly.escaped"]], ["ENGAGED", commanders.length]);
      h.live.pass(NOW + 1500);
      const r = h.row();
      assert.deepStrictEqual([r.state, r.endReason], ["FAILED", "ESCAPED"]);
      assert.deepStrictEqual([h.counters["anomaly.failed.ESCAPED"], h.counters["power.escaped"],
        h.counters["power.failed.ESCAPED"]], [1, undefined, undefined]);
      for (const name of ["anomaly.escaped", "anomaly.failed.ESCAPED", "anomaly.pocket", "anomaly.deferred.SITES"]) {
        assert.ok(S.COUNTER_NAMES.includes(name), name);
      }
    });
  });
};
