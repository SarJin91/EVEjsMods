"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { WRECK_YIELD } = require("../../lib/world/data/wreckYield");
const { buildWreckField, fractionPpm, effectivePool } = require("../../lib/world/wreckPool");
const { createWreckConsequence, expireKey } = require("../../lib/world/wreckConsequence");
const { startWrecks, createUnavailableWrecks } = require("../../lib/world/wrecks");
const { LAYER_ID } = require("../../lib/world/wrecksLayer");
const { createViewRegistry } = require("../../lib/observer/views");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const plan = require("../../lib/battle/settlementPlan");
const config = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const TTL = 604800000;
const WRECKS = Object.freeze({ enabled: true, fieldTtlMs: TTL, decayFloor: 0.25, maxFieldsPerSystem: 3,
  maxFieldsGlobal: 2000, minShipsLost: 1, maxCompositionEntries: 64, salvageYieldFactor: 1, lootYieldFactor: 1 });
const OBSERVER = Object.freeze({ galaxyEnabled: true, galaxyWrecksEnabled: true, galaxyWrecksMaxSystems: 1000,
  galaxyWrecksMaxLines: 6, galaxyWrecksRefreshMs: 60000, galaxyWrecksTierMediumUnits: 50,
  galaxyWrecksTierLargeUnits: 400 });

function wrecksConfig(wrecks = {}, observer = {}) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, world: { enabled: true } },
    wrecks: { ...WRECKS, ...wrecks }, observer: { ...OBSERVER, ...observer } };
}

function bootWrecks(env, shared, opts = {}) {
  const views = opts.views || createViewRegistry();
  const r = startWrecks({ config: wrecksConfig(opts.wrecks, opts.observer), persistence: { ok: true,
    store: env.store, journal: env.journal }, clock: shared.clock, scheduler: env.scheduler, views,
  getGovernor: opts.getGovernor, nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { wrecks: r.wrecks, views };
}

const start = (opened, shared) => {
  const env = H.boot(opened, shared);
  env.now = () => shared.clock.now();
  return env;
};

const COMP_A = Object.freeze([{ hullGroup: "cruiser", count: 2 }, { hullGroup: "frigate", typeId: 587, count: 3 }]);
const COMP_B = Object.freeze([{ hullGroup: "frigate", count: 2 }]);

function lossyBattle(env, tag, systemId, opts = {}) {
  const a = H.newFleet(env, `${tag}:a`, H.FACTION_A, COMP_A);
  const b = H.newFleet(env, `${tag}:b`, H.FACTION_B, COMP_B);
  const battle = H.battleOfFleets(env, tag, [a], [b], { systemId });
  const spec = opts.noLosses ? {} : { [b]: (e) => ({ d: e.count, e: 0 }),
    [a]: (e) => (e.hullGroup === "cruiser" ? { d: 1, e: 0 } : { d: 0, e: 0 }) };
  return { battle, result: H.resultFor(battle.input, opts.noLosses ? "DRAW" : "A_WIN", spec) };
}

const fieldRow = (env, battleId) => env.tx((db) => db.prepare("SELECT * FROM world_wreck_fields WHERE battle_id = ?")
  .get(battleId));
const countOf = (env, sql, ...args) => H.n(env, sql, ...args);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("W1 wreck pool (pure): aggregation, yield, collapse, decay, effective pool, skip, yield table", () => {
    assert.deepStrictEqual(Object.keys(WRECK_YIELD).sort(), [...HULL_GROUPS].sort(), "yield covers HULL_GROUPS");
    const settled = { battleId: "b1", systemId: 30000205, environment: "nullsec", at: 1000, outcome: "A_WIN",
      winnerFactionId: 500019, losses: [
        { fleetId: "f2", factionId: 500019, hullGroup: "cruiser", typeId: 0, count: 1 },
        { fleetId: "f1", factionId: 500019, hullGroup: "cruiser", typeId: 0, count: 2 },
        { fleetId: "f1", factionId: 500019, hullGroup: "frigate", typeId: 587, count: 1 },
        { fleetId: "f3", factionId: 500010, hullGroup: "frigate", typeId: 0, count: 4 },
        { fleetId: "f3", factionId: 500010, hullGroup: "frigate", typeId: 590, count: 1 },
      ] };
    const r = buildWreckField(settled, { ...WRECKS, salvageYieldFactor: 2, lootYieldFactor: 0.5 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.collapsed, false);
    const f = r.field;
    assert.deepStrictEqual(f.composition, [[500010, "frigate", 0, 4], [500010, "frigate", 590, 1],
      [500019, "cruiser", 0, 3], [500019, "frigate", 587, 1]]);
    assert.deepStrictEqual([f.fieldId, f.shipsLost, f.salvageUnits, f.lootUnits, f.decayFloorPpm, f.createdAt,
      f.expiresAt, f.winnerFactionId], ["wf:b1", 9, (3 * 4 + 6 * 1) * 2, Math.floor((3 * 3 + 6 * 1) * 0.5), 250000,
      1000, 1000 + TTL, 500019]);
    const c = buildWreckField(settled, { ...WRECKS, maxCompositionEntries: 1 });
    assert.strictEqual(c.collapsed, true);
    assert.deepStrictEqual(c.field.composition, [[500010, "frigate", 0, 5], [500019, "cruiser", 0, 3],
      [500019, "frigate", 0, 1]]);
    assert.ok(c.field.composition.every((e) => e[2] === 0));

    assert.strictEqual(fractionPpm(f, f.createdAt), 1000000);
    assert.strictEqual(fractionPpm(f, f.createdAt - 5), 1000000);
    assert.strictEqual(fractionPpm(f, f.createdAt + TTL / 2), 625000);
    assert.strictEqual(fractionPpm(f, f.expiresAt), 250000);
    const half = effectivePool({ ...f, salvagedSalvageUnits: 6, salvagedLootUnits: 0 }, f.createdAt + TTL / 2);
    assert.deepStrictEqual(half, { salvage: Math.ceil(30 * 0.625), loot: Math.ceil(7 * 0.625),
      total: Math.ceil(30 * 0.625) + Math.ceil(7 * 0.625), expired: false });
    assert.deepStrictEqual(effectivePool(f, f.expiresAt), { salvage: 0, loot: 0, total: 0, expired: true });

    assert.deepStrictEqual(buildWreckField({ ...settled, losses: [] }, WRECKS), { ok: true, skip: "NO_LOSSES",
      field: null });
    assert.strictEqual(buildWreckField(settled, { ...WRECKS, minShipsLost: 10 }).skip, "BELOW_MIN_SHIPS");
    const bad = buildWreckField({ ...settled, losses: [{ factionId: 1, hullGroup: "no_such_hull", typeId: 0, count: 1 }] },
      WRECKS);
    assert.deepStrictEqual([bad.ok, bad.reason, bad.detail], [false, "WRECK_INPUT_INVALID", "losses.hullGroup"]);

    assert.deepStrictEqual(config.resolveConfig({ modDir: MOD_DIR, env: {} }).warnings, []);
    const low = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_BATTLE_SETTLE_ROWS_RESERVE: "25",
      EVEJS_LNE_TREASURY_LOSSES_ENABLED: "0", EVEJS_LNE_STRATEGY_RECON_LOSS_ENABLED: "0" } });
    assert.strictEqual(low.warnings.length, 1, low.warnings.join("\n"));
    assert.ok(low.warnings[0].startsWith("battle.settleRowsReserve=25 below 39"), low.warnings[0]);
    assert.deepStrictEqual(config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_BATTLE_SETTLE_ROWS_RESERVE: "19",
      EVEJS_LNE_WRECKS_ENABLED: "0", EVEJS_LNE_TREASURY_LOSSES_ENABLED: "0",
      EVEJS_LNE_OCCUPATION_ENABLED: "0", EVEJS_LNE_STRATEGY_RECON_LOSS_ENABLED: "0" } }).warnings, []);
    const swap = config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_OBSERVER_GALAXY_WRECKS_TIER_LARGE_UNITS: "10" } });
    assert.strictEqual(swap.warnings.length, 1);
    assert.deepStrictEqual([swap.config.observer.galaxyWrecksTierMediumUnits,
      swap.config.observer.galaxyWrecksTierLargeUnits], [10, 50]);
    assert.strictEqual(MIGRATIONS[6].name, "world_wreck_fields");
  });

  needsDriver("W2 settlement + wrecks: one ACTIVE field + one expiry event, retry is a duplicate, no losses -> none",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const { wrecks } = bootWrecks(env, shared);
      const settlement = env.makeSettlement({ consequences: [wrecks.consequence] });
      const { battle, result } = lossyBattle(env, "w2", H.S.N5);
      const at = shared.clock.now();
      const r = H.settleIn(env, settlement, battle, result);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.consequences, { applied: ["wrecks"], refused: [] });
      const row = fieldRow(env, battle.battleId);
      assert.deepStrictEqual([row.field_id, row.state, row.system_id, row.ships_lost, row.salvage_units,
        row.loot_units, row.created_at, row.expires_at, row.winner_faction_id, row.outcome, row.end_reason],
      [`wf:${battle.battleId}`, "ACTIVE", H.S.N5, 3, 6, 5, at, at + TTL, H.FACTION_A, "A_WIN", null]);
      assert.deepStrictEqual(H.eventOf(env, expireKey(row.field_id, row.expires_at)),
        { state: "QUEUED", due_at: at + TTL });
      const K = plan.settleKey(battle.battleId, 1);
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        `${K}:c:wrecks:field`), 1);

      const again = H.settleIn(env, settlement, battle, result);
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_wreck_fields"), 1);
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = ?",
        "WRECK_FIELD_EXPIRE"), 1);

      const calm = lossyBattle(env, "w2b", H.S.N6, { noLosses: true });
      const c = H.settleIn(env, settlement, calm.battle, calm.result);
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      assert.deepStrictEqual(c.consequences, { applied: ["wrecks"], refused: [] });
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_wreck_fields"), 1);
      assert.deepStrictEqual([wrecks.getStatus().counters.created, wrecks.getStatus().counters.skipped], [1, 1]);
      wrecks.stop("test");
    }));

  needsDriver("W3 limits: system and global eviction of the oldest; QUEUE_FULL rolls back only the field", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const { wrecks } = bootWrecks(env, shared, { wrecks: { maxFieldsPerSystem: 1, maxFieldsGlobal: 2 } });
      const settlement = env.makeSettlement({ consequences: [wrecks.consequence] });
      const ids = [];
      for (const [tag, sys] of [["w3a", H.S.N5], ["w3b", H.S.N5], ["w3c", H.S.N6], ["w3d", H.S.N7]]) {
        shared.clock.advance(60000);
        const { battle, result } = lossyBattle(env, tag, sys);
        const r = H.settleIn(env, settlement, battle, result);
        assert.deepStrictEqual([r.ok, r.consequences && r.consequences.refused], [true, []], JSON.stringify(r));
        ids.push(battle.battleId);
      }
      const st = (id) => { const row = fieldRow(env, id); return [row.state, row.end_reason]; };
      assert.deepStrictEqual(st(ids[0]), ["EXPIRED", "EVICTED_SYSTEM"]);
      assert.deepStrictEqual(st(ids[1]), ["EXPIRED", "EVICTED_GLOBAL"]);
      assert.deepStrictEqual(st(ids[2]), ["ACTIVE", null]);
      assert.deepStrictEqual(st(ids[3]), ["ACTIVE", null]);
      assert.strictEqual(fieldRow(env, ids[0]).ended_at, fieldRow(env, ids[1]).created_at);
      const c = wrecks.getStatus().counters;
      assert.deepStrictEqual([c.created, c.evictedSystem, c.evictedGlobal], [4, 1, 1]);

      const full = createWreckConsequence({ repository: wrecks.repository, settings: WRECKS,
        scheduler: { enqueue: () => ({ ok: false, reason: "QUEUE_FULL" }) } });
      const refusing = env.makeSettlement({ consequences: [full] });
      const { battle, result } = lossyBattle(env, "w3q", H.S.N9);
      const fieldsBefore = countOf(env, "SELECT count(*) AS n FROM world_wreck_fields");
      const r = H.settleIn(env, refusing, battle, result);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual([r.outcome, r.consequences], ["COMPLETED", { applied: [], refused: ["wrecks"] }]);
      assert.strictEqual(H.battleOf(env, battle.battleId).state, "COMPLETED");
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_wreck_fields"), fieldsBefore);
      const K = plan.settleKey(battle.battleId, 1);
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key LIKE ?",
        `${K}:c:wrecks%`), 0, "the whole consequence rolled back");
      assert.deepStrictEqual(st(ids[3]), ["ACTIVE", null], "no eviction kept");
      wrecks.stop("test");
    }));

  needsDriver("W4 expiry + restart: TTL at expires_at after reopen, evicted field -> noop, listActive hides it", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const first = start(reopen(), shared);
      const one = bootWrecks(first, shared, { wrecks: { maxFieldsPerSystem: 1 } });
      const settlement = first.makeSettlement({ consequences: [one.wrecks.consequence] });
      const a = lossyBattle(first, "w4a", H.S.N5);
      assert.ok(H.settleIn(first, settlement, a.battle, a.result).ok);
      shared.clock.advance(60000);
      const b = lossyBattle(first, "w4b", H.S.N5);
      assert.ok(H.settleIn(first, settlement, b.battle, b.result).ok);
      one.wrecks.stop("restart");
      first.store.close("restart");

      const env = start(reopen(), shared);
      const { wrecks } = bootWrecks(env, shared);
      const fb = fieldRow(env, b.battle.battleId);
      assert.deepStrictEqual([fb.state, fieldRow(env, a.battle.battleId).end_reason], ["ACTIVE", "EVICTED_SYSTEM"]);
      const live = (at) => env.tx((db) => wrecks.repository.listActive(db, { at, limit: 10 })).fields
        .map((f) => f.fieldId);
      assert.deepStrictEqual(live(fb.expires_at - 1), [fb.field_id]);
      assert.deepStrictEqual(live(fb.expires_at), [], "expired by time before its event ran");

      shared.clock.set(fb.expires_at + 1000);
      const p = await env.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      const after = fieldRow(env, b.battle.battleId);
      assert.deepStrictEqual([after.state, after.end_reason, after.ended_at], ["EXPIRED", "TTL", fb.expires_at]);
      assert.strictEqual(H.eventOf(env, expireKey(fb.field_id, fb.expires_at)).state, "DONE");
      const fa = fieldRow(env, a.battle.battleId);
      assert.strictEqual(H.eventOf(env, expireKey(fa.field_id, fa.expires_at)).state, "DONE");
      const c = wrecks.getStatus().counters;
      assert.deepStrictEqual([c.expired, c.expireNoop, c.expireMissing], [1, 1, 0]);
      wrecks.stop("test");
    }));

  needsDriver("W5 layer-wrecks: triangles, tiers, label = effective sum, HOLD, switch off; client shape + scale", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      let hold = false;
      const governor = { admits: () => !hold };
      const { wrecks, views } = bootWrecks(env, shared, { getGovernor: () => governor });
      const now = shared.clock.now();
      const field = (id, systemId, salvage, loot) => ({ fieldId: id, battleId: null, source: "battle", systemId,
        environment: "nullsec", outcome: "A_WIN", winnerFactionId: null, shipsLost: 2, composition: [],
        salvageUnits: salvage, lootUnits: loot, decayFloorPpm: 250000, createdAt: now, expiresAt: now + TTL });
      env.tx((db) => {
        for (const f of [field("x1", H.S.N5, 300, 200), field("x2", H.S.N5, 100, 50), field("x3", H.S.N6, 10, 5)]) {
          const r = wrecks.repository.insertInTx(db, f, `test:${f.fieldId}`);
          assert.ok(r.ok, JSON.stringify(r));
        }
      });
      assert.deepStrictEqual(views.listMapLayers().map((l) => [l.id, l.kind, l.order]), [[LAYER_ID, "marks", 12]]);
      const view = views.getView(LAYER_ID);
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.ok(data.legend.every((l) => l[3] === "triangle"));
      assert.deepStrictEqual(data.legend.map((l) => l[4]), [0.8, 1, 1.4]);
      assert.deepStrictEqual(data.items.map((i) => [i[0], i[1], i[2]]),
        [[H.S.N5, "wrecks-large", "650"], [H.S.N6, "wrecks-small", "15"]]);
      assert.strictEqual(data.items[0][3][0], "2 fields · salvage 400 · loot 250 (decayed)");
      assert.ok(data.items[0][3][1].endsWith("expires in 168 h"), data.items[0][3][1]);
      assert.ok(view.cacheKey() !== null);
      hold = true;
      assert.strictEqual(view.cacheKey(), null);
      assert.strictEqual(view.getData().reason, "GOVERNOR_HOLD");
      wrecks.stop("test");
      assert.strictEqual(views.getView(LAYER_ID), null, "stop unregisters the layer");
      const off = bootWrecks(env, shared, { observer: { galaxyWrecksEnabled: false } });
      assert.strictEqual(off.views.getView(LAYER_ID), null, "flag off -> not registered");
      off.wrecks.stop("test");

      const sandbox = { window: {} };
      vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
        { filename: "galaxy.js" });
      const pure = sandbox.window.LneGalaxy._pure;
      assert.deepStrictEqual([pure.markShape("triangle"), pure.markShape("bogus"), pure.markScale(1.4),
        pure.markScale(undefined), pure.markScale(7)], ["triangle", "ring", 1.4, 1, 1]);
      const marks = pure.ingestMarks({ legend: [["l", "large", "#ffcc33", "triangle", 1.4], ["p", "p", "#123456"]],
        items: [[1, "l", "650", null], [2, "p", null, null]] }, new Map([[1, 0], [2, 1]]));
      assert.deepStrictEqual([marks.byIndex.get(0).shape, marks.byIndex.get(0).scale, marks.byIndex.get(1).scale],
        ["triangle", 1.4, 1]);
      assert.strictEqual(marks.legend.map((l) => l[2]).join(","), "triangle,ring");
    }));

  const plainField = (now, id, systemId, salvage, loot) => ({ fieldId: id, battleId: null, source: "battle",
    systemId, environment: "nullsec", outcome: "A_WIN", winnerFactionId: null, shipsLost: 2, composition: [],
    salvageUnits: salvage, lootUnits: loot, decayFloorPpm: 250000, createdAt: now, expiresAt: now + TTL });

  needsDriver("W5b layer-wrecks: fields taken by an anomaly (pool 0) get no marker, the note counts them", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const { wrecks, views } = bootWrecks(env, shared);
      const now = shared.clock.now();
      const repo = wrecks.repository;
      env.tx((db) => {
        for (const f of [plainField(now, "x1", H.S.N5, 300, 200), plainField(now, "x2", H.S.N5, 100, 50),
          plainField(now, "x3", H.S.N6, 10, 5)]) {
          assert.ok(repo.insertInTx(db, f, `test:${f.fieldId}`).ok);
        }
        for (const id of ["x2", "x3"]) {
          assert.ok(repo.claimForAnomalyInTx(db, { fieldId: id, expectedVersion: 1, at: now }, `test:${id}:claim`).ok);
        }
      });
      const data = views.getView(LAYER_ID).getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.items.map((i) => [i[0], i[1], i[2]]), [[H.S.N5, "wrecks-large", "500"]],
        "N6 (only an emptied field) has no marker - before the fix it showed \"0\"");
      assert.strictEqual(data.items[0][3][0], "1 fields · salvage 300 · loot 200 (decayed)");
      assert.ok(data.note.includes("2 emptied fields hidden"), data.note);
      assert.ok(data.note.startsWith("1 wreck fields in 1 systems"), data.note);
      wrecks.stop("test");
    }));

  needsDriver("W5c countWithPoolInSystem: claimed field 0 (countActive still 1), partly salvaged 1, systemId 0 refused",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const { wrecks } = bootWrecks(env, shared);
      const now = shared.clock.now();
      const repo = wrecks.repository;
      env.tx((db) => {
        assert.ok(repo.insertInTx(db, plainField(now, "p1", H.S.N5, 10, 6), "test:p1").ok);
        assert.ok(repo.insertInTx(db, plainField(now, "c1", H.S.N6, 10, 5), "test:c1").ok);
        assert.ok(repo.recordSalvageInTx(db, { fieldId: "p1", expectedVersion: 1, salvageUnits: 10, lootUnits: 5,
          at: now }, "test:p1:salvage").ok);
        assert.ok(repo.claimForAnomalyInTx(db, { fieldId: "c1", expectedVersion: 1, at: now }, "test:c1:claim").ok);
      });
      const r = env.tx((db) => ({
        n6: repo.countWithPoolInSystem(db, { systemId: H.S.N6, at: now }),
        n6Active: repo.countActive(db, { systemId: H.S.N6 }),
        n5: repo.countWithPoolInSystem(db, { systemId: H.S.N5, at: now }),
        bad: repo.countWithPoolInSystem(db, { systemId: 0, at: now }),
      }));
      assert.deepStrictEqual([r.n6, r.n6Active, r.n5], [{ ok: true, count: 0 }, { ok: true, count: 1 },
        { ok: true, count: 1 }]);
      assert.strictEqual(r.bad.reason, "WRECK_INVALID_INPUT", JSON.stringify(r.bad));
      wrecks.stop("test");
    }));
  needsDriver("T6: global limit 1, the old field past its TTL closes as TTL at expires_at "
    + "no eviction counted", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const { wrecks } = bootWrecks(env, shared, { wrecks: { maxFieldsGlobal: 1 } });
      const settlement = env.makeSettlement({ consequences: [wrecks.consequence] });
      const first = lossyBattle(env, "t6a", H.S.N5);
      assert.strictEqual(H.settleIn(env, settlement, first.battle, first.result).ok, true);
      shared.clock.advance(TTL + 60000);
      const second = lossyBattle(env, "t6b", H.S.N6);
      const r = H.settleIn(env, settlement, second.battle, second.result);
      assert.deepStrictEqual([r.ok, r.consequences && r.consequences.refused], [true, []], JSON.stringify(r));
      const old = fieldRow(env, first.battle.battleId);
      assert.deepStrictEqual([old.state, old.end_reason, old.ended_at], ["EXPIRED", "TTL", old.expires_at]);
      const c = wrecks.getStatus().counters;
      assert.deepStrictEqual([c.created, c.evictedGlobal, c.evictedSystem, c.expired], [2, 0, 0, 1]);
      wrecks.stop("test");
    }));

  test("WE1 bug-wreck-fields-empty: effectivePool rounds up - a 1/1 frigate field shows 1/1 until expiresAt, "
    + "a fully salvaged field 0, 400/250 at half TTL = ceil", () => {
    const f = { createdAt: 1000, expiresAt: 1000 + TTL, decayFloorPpm: 250000, salvageUnits: 1, lootUnits: 1,
      salvagedSalvageUnits: 0, salvagedLootUnits: 0 };
    const live = { salvage: 1, loot: 1, total: 2, expired: false };
    assert.deepStrictEqual(effectivePool(f, f.createdAt + 1), live);
    assert.deepStrictEqual(effectivePool(f, f.expiresAt - 1), live);
    assert.deepStrictEqual(effectivePool(f, f.expiresAt), { salvage: 0, loot: 0, total: 0, expired: true });
    assert.deepStrictEqual(effectivePool({ ...f, salvagedSalvageUnits: 1, salvagedLootUnits: 1 }, f.createdAt + 1),
      { salvage: 0, loot: 0, total: 0, expired: false });
    assert.deepStrictEqual(effectivePool({ ...f, salvageUnits: 400, lootUnits: 250 }, f.createdAt + TTL / 2),
      { salvage: 250, loot: 157, total: 407, expired: false });
  });

  needsDriver("WE4 bug-wreck-fields-empty: layer-wrecks field lines say left S/L, salvaged by NPC, in space "
    + "(anomaly), end with expires in N h; the note counts recently ended fields per end_reason", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const { wrecks, views } = bootWrecks(env, shared);
      const now = shared.clock.now();
      const field = (id, createdAt) => ({ fieldId: id, battleId: null, source: "battle", systemId: H.S.N5,
        environment: "nullsec", outcome: "A_WIN", winnerFactionId: 500019, shipsLost: 2, composition: [],
        salvageUnits: 10, lootUnits: 6, decayFloorPpm: 250000, createdAt, expiresAt: createdAt + TTL });
      const repo = wrecks.repository;
      env.tx((db) => {
        for (const [id, at] of [["npc", now - 2], ["anom", now - 1], ["e1", now], ["e2", now], ["e3", now]]) {
          assert.ok(repo.insertInTx(db, field(id, at), `test:${id}`).ok);
        }
        assert.ok(repo.recordSalvageInTx(db, { fieldId: "npc", expectedVersion: 1, salvageUnits: 5, lootUnits: 3,
          at: now }, "test:npc:salvage").ok);
        assert.ok(repo.claimForAnomalyInTx(db, { fieldId: "anom", expectedVersion: 1, at: now }, "test:anom:claim").ok);
        for (const [id, reason] of [["e1", "EVICTED_SYSTEM"], ["e2", "EVICTED_SYSTEM"], ["e3", "TTL"]]) {
          assert.ok(repo.transitionInTx(db, { fieldId: id, expectedVersion: 1, from: "ACTIVE", to: "EXPIRED",
            endReason: reason, at: now }, `test:${id}:end`).ok);
        }
      });
      const data = views.getView(LAYER_ID).getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      const lines = data.items[0][3];
      assert.strictEqual(lines[0], "1 fields · salvage 5 · loot 3 (decayed)");
      const left = (pool) => pool.salvage + "/" + pool.loot;
      const npcPool = effectivePool({ ...field("npc", now - 2), salvagedSalvageUnits: 5, salvagedLootUnits: 3 }, now);
      assert.deepStrictEqual(lines.slice(1), [
        `battle npc · A_WIN · 2 ships lost · winner 500019 · left ${left(npcPool)} · salvaged by NPC · expires in 168 h`,
      ]);
      assert.ok(data.note.endsWith(" · 1 emptied fields hidden · recent ended: EVICTED_SYSTEM 2 · TTL 1"), data.note);
      const counted = env.tx((db) => repo.countEndedSince(db, { since: now - TTL }));
      assert.deepStrictEqual(counted, { ok: true, byReason: { EVICTED_SYSTEM: 2, TTL: 1 } });
      wrecks.stop("test");
    }));

  needsDriver("HG2 placeGankField: one field source gank (battle_id NULL, winner NULL, highsec, wf:hg:<sys>:<bucket>, "
    + "Catalysts + victim, created_at = at) + WRECK_FIELD_EXPIRE; again and after a restart -> duplicate, one row, "
    + "one event; the stub refuses", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = start(reopen(), shared);
      const first = bootWrecks(env, shared);
      const at = shared.clock.now() - 60000;
      const ttlMs = 21600000;
      const spec = { systemId: H.S.N5, bucket: 123456, at, factionId: 500001,
        victim: { hullGroup: "freighter", typeId: 20185 },
        gankers: { hullGroup: "destroyer", typeId: 16240, count: 9 }, ttlMs };
      const r = first.wrecks.placeGankField(spec);
      const fieldId = `wf:hg:${H.S.N5}:123456`;
      assert.deepStrictEqual(r, { ok: true, duplicate: false, fieldId, shipsLost: 10, expiresAt: at + ttlMs });
      const row = env.tx((db) => db.prepare("SELECT * FROM world_wreck_fields WHERE field_id = ?").get(fieldId));
      assert.deepStrictEqual([row.source, row.battle_id, row.winner_faction_id, row.environment, row.outcome,
        row.state, row.ships_lost, row.created_at, row.expires_at, JSON.parse(row.composition_json)],
      ["gank", null, null, "highsec", "GANKED", "ACTIVE", 10, at, at + ttlMs,
        [[500001, "destroyer", 16240, 9], [500001, "freighter", 20185, 1]]]);
      assert.deepStrictEqual([row.salvage_units, row.loot_units, row.decay_floor_ppm], [58, 98, 250000]);
      assert.deepStrictEqual(H.eventOf(env, expireKey(fieldId, at + ttlMs)), { state: "QUEUED", due_at: at + ttlMs });
      const journalKey = `hsgank:${H.S.N5}:123456`;
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        journalKey), 1);

      assert.deepStrictEqual(first.wrecks.placeGankField(spec), { ok: true, duplicate: true, fieldId });
      first.wrecks.stop("restart");
      const second = bootWrecks(env, shared);
      assert.deepStrictEqual(second.wrecks.placeGankField(spec), { ok: true, duplicate: true, fieldId });
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_wreck_fields"), 1);
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = ?",
        "WRECK_FIELD_EXPIRE"), 1);
      assert.strictEqual(second.wrecks.placeGankField({ ...spec, at: at + 1 }).reason, "IDEMPOTENCY_CONFLICT",
        "the same (system, bucket) with another moment");
      assert.strictEqual(second.wrecks.placeGankField({ ...spec, factionId: 0 }).reason, "WRECK_INPUT_INVALID");
      second.wrecks.stop("test");
      assert.deepStrictEqual(createUnavailableWrecks("disabled_by_config").placeGankField(spec),
        { ok: false, reason: "WRECKS_UNAVAILABLE" });
    }));
};
