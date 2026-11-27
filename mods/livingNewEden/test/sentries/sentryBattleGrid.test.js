"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const seams = require("../../lib/adapter/sentrySeams");
const { createSentryService } = require("../../lib/sentries/service");
const { startSentries } = require("../../lib/sentries");
const S = require("../../lib/sentries/schema");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { harness: H } = require("../battle/settlement.test");
const { fakeVendor } = require("./factionSentries.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GROUPS = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(undefined));
const SYS = 30002000;
const OWNER = 500020;
const ENEMY = 500010;
const GATE = 50001001;
const STATION = 60001001;
const GATE_GRID = `gate:${GATE}`;
const STATION_GRID = `station:${STATION}`;
const GRIDS = Object.freeze([{ gridKey: GATE_GRID, anchors: [{ kind: "gate", id: GATE }] },
  { gridKey: STATION_GRID, anchors: [{ kind: "station", id: STATION }] }]);

const fleet = (fleetId, count) => ({ fleetId, factionId: ENEMY, version: 3, fleetRole: "patrol", state: "STAGED",
  shipCount: count, currentSystemId: SYS, legSeq: 1, composition: [{ hullGroup: "cruiser", count }] });
const row = (n, anchorKind, anchorId) => ({ sentryId: `sf-${n}`, itemId: 7000 + n, typeId: 340501,
  ownerKind: "faction", factionId: OWNER, characterId: null, systemId: SYS, anchorKind, anchorId, state: S.ACTIVE,
  armedAt: 0 });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function serviceRig(opened, clock) {
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const rows = [row(1, "gate", GATE), row(2, "station", STATION)];
    const seam = { readSentryItem: () => ({ ok: true, item: { hp: 500000, destroyed: false, incapacitated: false } }),
      readSentryCombat: () => ({ ok: true, dps: 67.7, signature: 6000, designSig: 125 }),
      readAmmo: () => ({ ok: true, units: 50, capacityUnits: 100 }) };
    const calls = [];
    const facade = { getStatus: () => ({ state: "ready" }),
      createFixedDefenseBattleInTx(tx, spec, key) {
        calls.push({ spec, key });
        return { ok: true, duplicate: false, battleId: `b-${calls.length}` };
      } };
    const grid = { anchorsReason: null, positions: new Map(), reads: 0,
      isEnabled: () => true,
      positionsOf(tx, systemId, fleets) {
        grid.reads += 1;
        assert.strictEqual(tx.inTransaction, true);
        return { ok: true, anchorsReason: grid.anchorsReason, positions: new Map(fleets.map((f) => [f.fleetId,
          grid.positions.get(f.fleetId) || { kind: "warp" }])) };
      },
      readSystemGrid: () => ({ ok: true, grids: GRIDS }) };
    const enqueued = new Set();
    const queue = [];
    const scheduler = { enqueue(type, agg, dueAt, payload, key) {
      if (enqueued.has(key)) return { ok: true, duplicate: true };
      enqueued.add(key);
      queue.push(key);
      return { ok: true };
    } };
    const cfg = { ...DEFAULTS, sentries: { ...DEFAULTS.sentries, enabled: true,
      battle: { ...DEFAULTS.sentries.battle, enabled: true, gridEnabled: true } } };
    const service = createSentryService({ store: opened.store, config: cfg, clock, seam, journal,
      repository: { listActive: () => ({ ok: true, sentries: rows, truncated: false }) }, scheduler,
      fleetRepository: { listFleetsInSystem: (db, systemId, opts) => ({ ok: true, nextAfterFleetId: null,
        fleets: [fleet("f-station", 10), fleet("f-gate", 5)].filter((f) => opts.states.includes(f.state)) }) },
      getPresence: () => ({ distanceToObserved: () => ({ ok: true, distance: null }) }), groups: GROUPS,
      hostility: { isFactionEnemy: (f, g) => g === ENEMY }, getBattle: () => facade, grid });
    assert.ok(service.rebuildArmed().ok);
    return { service, calls, grid, queue, R: cfg.sentries.battle.roundMs };
  }

  needsDriver("T2 grid sentry battle round: battleSpec.grid of the station, the other grid outside sideA "
    + "anchorsReason -> system battle + battleGridFallback; NO_GRID_CONTACT -> no reschedule + battleGridMiss",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const { clock } = H.sharedOf();
    const env = serviceRig(opened, clock);
    const { service, calls, grid, R } = env;
    const round = Math.floor(clock.now() / R) + 1;
    const ev = (r) => ({ payload: { systemId: SYS, round: r }, dueAt: r * R });
    const run = (r) => {
      const t = opened.store.transaction("test", (db) => r.effect(db));
      assert.ok(t.ok, JSON.stringify(t));
      r.onCommitted(t.value);
    };

    grid.positions = new Map([["f-station", { kind: "anchor", gridKey: STATION_GRID }],
      ["f-gate", { kind: "anchor", gridKey: GATE_GRID }]]);
    const a = service.onAttrition(ev(round), { anchorAt: round * R });
    assert.strictEqual(a.outcome, "BATTLE", JSON.stringify(a));
    run(a);
    assert.deepStrictEqual([calls[0].spec.grid, calls[0].spec.sideA.fleets.map((f) => f.fleetId),
      calls[0].spec.fixedDefenses.entries.map((e) => e.sentryId)], [{ kind: "station", id: STATION }, ["f-station"],
      ["sf-2"]]);

    grid.anchorsReason = "BENCH_UNSUPPORTED";
    const b = service.onAttrition(ev(round + 1), { anchorAt: (round + 1) * R });
    run(b);
    assert.deepStrictEqual([Object.prototype.hasOwnProperty.call(calls[1].spec, "grid"),
      calls[1].spec.sideA.fleets.map((f) => f.fleetId), calls[1].spec.fixedDefenses.entries.length,
      service.getStatus().counters.battleGridFallback], [false, ["f-station", "f-gate"], 2, 1]);

    grid.anchorsReason = null;
    grid.positions = new Map();
    const c = service.onAttrition(ev(round + 2), { anchorAt: (round + 2) * R });
    c.onCommitted();
    assert.deepStrictEqual([c.outcome, c.reschedule, typeof c.effect, calls.length,
      service.getStatus().counters.battleGridMiss], ["NO_GRID_CONTACT", undefined, "undefined", 2, 1]);
    service.stop();
  }));

  needsDriver("T3 grid onGridArrival: grid of a hostile sentry -> one round attritionKey(s, r+1), again -> "
    + "duplicate, another grid -> nothing; the grid arrival listener registered only with the flag",
  () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const { clock } = shared;
    const env = serviceRig(opened, clock);
    const at = clock.now();
    const tx = { inTransaction: true };
    const arrival = (gridKey) => ({ fleetId: "f-gate", factionId: ENEMY, fleetRole: "patrol", systemId: SYS,
      legSeq: 1, moveSeq: 1, at, purpose: "WORK", targetFleetId: null, gridKey, anchor: null, source: "MOVE" });
    env.service.onGridArrival(tx, arrival(GATE_GRID));
    env.service.onGridArrival(tx, arrival(GATE_GRID));
    env.service.onGridArrival(tx, arrival("station:777"));
    assert.deepStrictEqual([env.queue, env.service.getStatus().counters.gridArrivalQueued],
      [[S.attritionKey(SYS, Math.floor(at / env.R) + 1)], 1]);
    env.service.stop();

    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const v = fakeVendor();
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: v.modules[rel] }) });
    const adapter = { sentrySeams: () => ({ ok: true, seam, optional: {} }), bindSentryPolicy: () => ({ ok: true }) };
    const listeners = { added: 0, removed: 0 };
    const fleets = { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [], nextAfterFleetId: null }) },
      travel: { addArrivalListener: () => ({ ok: true, remove() {} }) },
      grid: { isEnabled: () => true, addGridArrivalListener: () => {
        listeners.added += 1;
        return { ok: true, remove: () => { listeners.removed += 1; } };
      } } };
    const start = (gridEnabled) => {
      const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
        sentries: { ...DEFAULTS.sentries, enabled: true,
          battle: { ...DEFAULTS.sentries.battle, enabled: true, gridEnabled } } };
      const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
        nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));
      const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
        scheduler: sr.scheduler, adapter, fleets,
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) } });
      assert.ok(started.ok, JSON.stringify(started));
      return started;
    };
    const off = start(false);
    assert.strictEqual(listeners.added, 0);
    off.sentries.stop();
    const on = start(true);
    assert.strictEqual(listeners.added, 1);
    on.sentries.stop();
    assert.strictEqual(listeners.removed, 1);
  }));
};
