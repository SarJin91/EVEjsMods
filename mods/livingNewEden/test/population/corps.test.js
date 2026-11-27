"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { resolveConfig } = config;
const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { CORP_STATE } = require("../../lib/population/corps/schema");
const rules = require("../../lib/population/corps/rules");
const { generateName } = require("../../lib/freeCorps/names");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { seedDbFile } = require("../_support/dbTemplate");
const { findCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 91;
const T0 = 1700000000000;
const N = 300;
const MIN = 60000;
const KEYS = ["ENABLED", "TARGET_CORPS", "MEMBERS_MIN", "MEMBERS_MAX", "CORPLESS_PERMILLE", "FOUND_PER_PASS",
  "FOUNDING_INTERVAL_MS", "MAX_CORPS_PER_PASS", "REVIEW_MS", "SCAN_PER_REVIEW", "RECRUITS_PER_REVIEW", "LEAVE_PERMILLE",
  "JOIN_MAX_DISTANCE", "FOCUS_MATCH_PERMILLE", "OTHER_FOCUS_PERMILLE", "DISSOLVE_AFTER_MS", "RETENTION_MS",
  "FLUSH_ROWS_PER_SLICE", "MAX_NAME_ATTEMPTS"].map((k) => `EVEJS_LNE_POPULATION_CORPS_${k}`);

async function withRowsStore(driver, maxRows, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-pcorp-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: maxRows, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return await fn(store);
  } finally {
    if (store) store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function spyStore(store) {
  const flushRows = [];
  const sql = [];
  return { flushRows, sql, limits: store.limits, labelTx: (l) => store.labelTx(l),
    transaction(name, fn) {
      const r = store.transaction(name, (tx) => fn({ prepare(text) {
        sql.push(text);
        return tx.prepare(text);
      } }));
      if (name === "population.flush" && r.ok) flushRows.push(r.rows);
      return r;
    } };
}

function makeService(store, o = {}) {
  const clock = { t: o.t || T0, now() { return this.t; } };
  const settings = F.settings({ enabled: true, size: o.size || N, seedRowsPerSlice: 400,
    flushRowsPerSlice: o.flushRowsPerSlice || 400, maxEventsPerPass: 5000, maxPassMs: 50, maxRoutesPerPass: 5000,
    standings: { enabled: o.standings !== false }, corps: o.corps || { enabled: false } });
  const svc = createPopulationService({ store, worldSeed: SEED, clock, settings,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: F.fakeGraph() }) }),
    listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
    generateName });
  return { svc, clock };
}

async function booted(store, o) {
  const m = makeService(store, o);
  assert.strictEqual(await m.svc.boot(), "running", JSON.stringify(m.svc.getStatus()));
  return m;
}

const corpsOn = (over) => ({ enabled: true, targetCorps: 1, foundPerPass: 1, foundingIntervalMs: 1000,
  maxCorpsPerPass: 4, reviewMs: MIN, scanPerReview: 64, recruitsPerReview: 5, leavePermille: 0, membersMin: 50,
  membersMax: 120, corplessPermille: 0, focusMatchPermille: 1000, otherFocusPermille: 1000, joinMaxDistance: 60,
  dissolveAfterMs: 3 * MIN, retentionMs: 3600000, flushRowsPerSlice: 100, maxNameAttempts: 8, ...over });

function views(svc, n = N) {
  return Array.from({ length: n }, (_, i) => svc.pilot(i + 1));
}

function corpIdsOf(store, ids) {
  const r = store.transaction("test.read", (tx) => ids.map((id) => Number(tx.prepare(
    "SELECT corp_id FROM world_npc_pilots WHERE pilot_id = ?").get(id).corp_id)));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function count(store, sql) {
  const r = store.transaction("test.read", (tx) => Number(tx.prepare(sql).get().n));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    for (const id of ["PC1", "PC2", "PC3", "PC4", "PC5"]) skip(`${id} population corps`, `no sqlite driver: ${driver.detail || driver.reason}`);
    return;
  }

  test("PC1 founding and budgets: <= foundPerPass foundings, <= maxCorpsPerPass reviews, <= scanPerReview checks",
    async () => {
      await F.withStore(driver, async (store) => {
        const S = corpsOn({ targetCorps: 10, foundPerPass: 2, maxCorpsPerPass: 3, scanPerReview: 8, membersMin: 1 });
        const { svc } = await booted(store, { corps: S });
        const c = svc.corps();
        assert.ok(c, JSON.stringify(svc.getStatus().corps));
        let founded = 0;
        for (let i = 0; i < 8; i += 1) {
          const r = c.step(T0 + i * 1000);
          const ls = c.getStatus().lastStep;
          assert.ok(r.founded <= 2 && r.reviewed <= 3, JSON.stringify(r));
          assert.ok(ls.foundScans <= 2 * 8 && ls.maxReviewScans <= 8, JSON.stringify(ls));
          founded += r.founded;
        }
        assert.deepStrictEqual([founded, c.getStatus().open, svc.getStatus().counters["corps.founded"]], [10, 10, 10]);
        const r = c.step(T0 + 10 * MIN);
        assert.deepStrictEqual([r.founded, r.reviewed], [0, 3]);
        assert.ok(c.getStatus().lastStep.maxReviewScans <= 8);
        assert.strictEqual(svc.runPass(T0 + 10 * MIN + 1).ok, true);
        assert.ok(c.getStatus().lastStep.reviewed <= 3);
        svc.stop();
      });
      await F.withStore(driver, async (store) => {
        const governor = { admits: (cls) => cls !== "STRATEGIC" };
        const clock = { t: T0, now() { return this.t; } };
        const svc = createPopulationService({ store, worldSeed: SEED, clock, getGovernor: () => governor,
          settings: F.settings({ enabled: true, size: N, standings: { enabled: true }, corps: corpsOn({}) }),
          getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: F.fakeGraph() }) }),
          listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
          generateName });
        await svc.boot();
        svc.runPass(T0);
        assert.deepStrictEqual([svc.getStatus().counters["deferred.CORPS_GOVERNOR"], svc.corps().getStatus().open], [1, 0]);
        svc.stop();
      });
    });

  test("PC2 recruitment, leaving (CEO), dissolution; a member reads the corp standing profile", async () => {
    await F.withStore(driver, async (store) => {
      const { svc } = await booted(store, { corps: corpsOn({}) });
      const c = svc.corps();
      const st = svc.standings();
      assert.strictEqual(c.step(T0).founded, 1);
      const corp = c.corp(1);
      assert.deepStrictEqual([corp.state, corp.ceoPilotId, corp.members, corp.lowSince], [CORP_STATE.ACTIVE, 1, 1, T0]);
      assert.strictEqual(corp.profile, st.profileOfPilot(1));
      c.step(T0 + MIN + 1);
      c.step(T0 + 2 * MIN + 2);
      const members = c.membersOf(1);
      assert.strictEqual(members.length, 11, JSON.stringify(members));
      assert.strictEqual(svc.getStatus().counters["corps.joined"], 10);
      let differs = 0;
      for (const id of members) {
        assert.strictEqual(st.profileOf(id), corp.profile);
        if (st.profileOfPilot(id) !== corp.profile) differs += 1;
      }
      assert.ok(differs > 0, "at least one member changed its profile");
      const outsider = Array.from({ length: N }, (_, i) => i + 1).find((id) => !members.includes(id));
      assert.strictEqual(st.profileOf(outsider), st.profileOfPilot(outsider));
      c.step(T0 + 3 * MIN + 3);
      const gone = c.corp(1);
      assert.deepStrictEqual([gone.state, gone.endedAt, gone.members, c.membersOf(1).length, c.getStatus().open],
        [CORP_STATE.DISSOLVED, T0 + 3 * MIN + 3, 0, 0, 0]);
      for (const id of members) assert.strictEqual(st.profileOf(id), st.profileOfPilot(id));
      assert.strictEqual(svc.getStatus().counters["corps.dissolved"], 1);
      svc.stop();
    });
    await F.withStore(driver, async (store) => {
      const { svc } = await booted(store, { corps: corpsOn({ leavePermille: 1000, membersMin: 1 }) });
      const c = svc.corps();
      c.step(T0);
      c.step(T0 + MIN + 1);
      const members = c.membersOf(1);
      assert.strictEqual(members.length, 5);
      assert.ok(!members.includes(1));
      assert.deepStrictEqual([c.corp(1).ceoPilotId, c.corp(1).state], [members[0], CORP_STATE.ACTIVE]);
      assert.strictEqual(svc.standings().profileOf(1), svc.standings().profileOfPilot(1));
      assert.strictEqual(svc.getStatus().counters["corps.left"], 1);
      svc.stop();
    });
    const S = corpsOn({ leavePermille: 250, joinMaxDistance: 10, focusMatchPermille: 800, otherFocusPermille: 200 });
    assert.strictEqual(rules.leaveCount(8, { nextFloat: () => 0.99 }, S), 2);
    assert.strictEqual(rules.leaveCount(0, { nextFloat: () => 0.99 }, S), 0);
    const mining = { focus: rules.focusOf(2) };
    assert.strictEqual(rules.accepts(mining, { archetype: 2, corpId: 0 }, 10, 0.79, S), true);
    assert.strictEqual(rules.accepts(mining, { archetype: 1, corpId: 0 }, 10, 0.21, S), false);
    assert.strictEqual(rules.accepts(mining, { archetype: 2, corpId: 3 }, 0, 0, S), false);
    assert.strictEqual(rules.accepts(mining, { archetype: 2, corpId: 0 }, 11, 0, S), false);
  });

  test("PC3 restart: the same corporations and members; corp_id without a corporation -> 0 + corps.orphanMembers",
    async () => {
      await F.withStore(driver, async (store) => {
        const S = corpsOn({ targetCorps: 5, foundPerPass: 5, leavePermille: 100, membersMin: 1 });
        const a = await booted(store, { corps: S });
        const ca = a.svc.corps();
        ca.step(T0);
        ca.step(T0 + MIN + 1);
        ca.step(T0 + 2 * MIN + 2);
        const snap = [1, 2, 3, 4, 5].map((id) => [ca.corp(id), ca.membersOf(id)]);
        assert.ok(snap.every(([corp, m]) => corp.members === m.length && m.length >= 1));
        a.svc.stop();
        assert.strictEqual(count(store, "SELECT count(*) AS n FROM world_npc_corps"), 5);
        const b = await booted(store, { corps: S, t: T0 + 2 * MIN + 2 });
        const cb = b.svc.corps();
        assert.deepStrictEqual([1, 2, 3, 4, 5].map((id) => [cb.corp(id), cb.membersOf(id)]), snap);
        assert.strictEqual(b.svc.getStatus().counters["corps.orphanMembers"], 0);
        b.svc.stop();
        const members = new Set(snap.flatMap(([, m]) => m));
        const lone = Array.from({ length: N }, (_, i) => i + 1).find((id) => !members.has(id));
        const w = store.transaction("test.write", (tx) => tx.prepare(
          "UPDATE world_npc_pilots SET corp_id = 4242 WHERE pilot_id = ?").run(lone).changes);
        assert.deepStrictEqual([w.ok, w.value], [true, 1]);
        const c = await booted(store, { corps: S, t: T0 + 2 * MIN + 3 });
        assert.strictEqual(c.svc.getStatus().counters["corps.orphanMembers"], 1);
        assert.strictEqual(c.svc.corps().profileOf(lone), -1);
        c.svc.stop();
        assert.deepStrictEqual(corpIdsOf(store, [lone]), [0]);
      });
    });

  test("PC4 row bound: one population.flush tx <= maxRowsPerTransaction (corps first, pilot cap lowered)", async () => {
    const run = (maxRows, flushRowsPerSlice) => withRowsStore(driver, maxRows, async (raw) => {
      const store = spyStore(raw);
      const S = corpsOn({ targetCorps: 112, foundPerPass: 16, membersMin: 1, maxCorpsPerPass: 4 });
      const { svc } = await booted(store, { size: 1200, flushRowsPerSlice, corps: S });
      const c = svc.corps();
      for (let i = 0; i < 7; i += 1) c.step(T0 + i * 1000);
      assert.deepStrictEqual([c.getStatus().open, c.dirtyCount()], [112, 112]);
      svc.runPass(T0 + 6 * 3600000);
      const corpsRows = count(raw, "SELECT count(*) AS n FROM world_npc_corps");
      const first = store.flushRows[0];
      svc.stop();
      return { first, corpsRows };
    });
    const a = await run(1800, 1000);
    assert.deepStrictEqual(a, { first: 1101, corpsRows: 100 });
    const b = await run(1300, 1200);
    assert.deepStrictEqual(b, { first: 1200, corpsRows: 100 });
  });

  test("PC5 off bit for bit, migration 124 on 123, worldReset WIPE, config (W253, W254), compose and .env.example",
    async () => {
      const passes = [T0 + 6 * 3600000, T0 + 6 * 3600000 + 5000, T0 + 7 * 3600000];
      let reference = null;
      await F.withStore(driver, async (store) => {
        const { svc } = await booted(store, {});
        for (const t of passes) svc.runPass(t);
        reference = views(svc);
        svc.stop();
      });
      for (const corps of [{ enabled: false }, corpsOn({})]) {
        await F.withStore(driver, async (raw) => {
          const seeded = await booted(raw, {});
          seeded.svc.stop();
          const w = raw.transaction("test.write", (tx) => tx.prepare(
            "UPDATE world_npc_pilots SET corp_id = 7 WHERE pilot_id <= 10").run().changes);
          assert.deepStrictEqual([w.ok, w.value], [true, 10]);
          const store = spyStore(raw);
          const { svc } = await booted(store, { corps, standings: corps.enabled !== true });
          for (const t of passes) svc.runPass(t);
          assert.deepStrictEqual(views(svc), reference, "the transitions of a pilot store without corp_id");
          assert.strictEqual(svc.corps(), null);
          if (corps.enabled) assert.deepStrictEqual(svc.getStatus().corps, { enabled: false, reason: "NO_STANDINGS" });
          else assert.ok(!("corps" in svc.getStatus()));
          svc.stop();
          assert.deepStrictEqual(store.sql.filter((s) => s.includes("world_npc_corps")), []);
          assert.deepStrictEqual(corpIdsOf(raw, [1, 5, 10, 11]), [7, 7, 7, 0]);
          assert.strictEqual(count(raw, "SELECT count(*) AS n FROM world_npc_corps"), 0);
        });
      }

      const m = MIGRATIONS.find((x) => x.version === 124);
      assert.deepStrictEqual([m && m.name, MIGRATIONS.indexOf(m)], ["population-corps", 123]);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m124-"));
      const file = path.join(tmp, "world.sqlite");
      const open = (migrations) => {
        const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
          busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
        assert.ok(o.ok, JSON.stringify(o));
        return o;
      };
      try {
        const old = open(MIGRATIONS.slice(0, 123));
        assert.strictEqual(old.schemaVersion, 123);
        const ins = old.store.transaction("t", (tx) => tx.prepare("INSERT INTO world_npc_pilots (pilot_id, system_id, "
          + "home_id, ship_type_id, archetype, intent, state, seq, since_at, due_at) VALUES (1, 5, 5, 601, 2, 1, 1, 3, 9, 9)")
          .run().changes);
        assert.deepStrictEqual([ins.ok, ins.value], [true, 1]);
        old.store.close("upgrade");
        const up = open(MIGRATIONS.slice(0, 124));
        assert.strictEqual(up.schemaVersion, 124);
        const rows = up.store.transaction("t", (tx) => ({
          pilot: tx.prepare("SELECT pilot_id, seq, corp_id FROM world_npc_pilots").all().map((r) => [Number(r.pilot_id),
            Number(r.seq), Number(r.corp_id)]),
          corps: Number(tx.prepare("SELECT count(*) AS n FROM world_npc_corps").get().n) }));
        assert.deepStrictEqual(rows.value, { pilot: [[1, 3, 0]], corps: 0 });
        up.store.close("test_cleanup");
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
      assert.strictEqual(TABLE_POLICY.world_npc_corps, ACTION.WIPE);

      const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
      const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
      assert.deepStrictEqual(def.config.population.corps, { enabled: false, targetCorps: 300, membersMin: 3,
        membersMax: 120, corplessPermille: 300, foundPerPass: 1, foundingIntervalMs: 30000, maxCorpsPerPass: 4,
        reviewMs: 3600000, scanPerReview: 64, recruitsPerReview: 5, leavePermille: 20, joinMaxDistance: 60,
        focusMatchPermille: 800, otherFocusPermille: 200, dissolveAfterMs: 86400000, retentionMs: 604800000,
        flushRowsPerSlice: 100, maxNameAttempts: 8 });
      assert.ok(!def.warnings.some((x) => /W25[34]/.test(x)));
      assert.strictEqual(config.SCHEMA.filter((r) => r.key.startsWith("population.corps.")).length, 19);
      const on = { ...env0, EVEJS_LNE_POPULATION_ENABLED: "1", EVEJS_LNE_POPULATION_CORPS_ENABLED: "1" };
      const w1 = resolveConfig({ modDir: MOD_DIR, env: on }).warnings;
      assert.ok(w1.some((x) => /\(W253\)/.test(x)), w1.join(" | "));
      const w2 = resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_POPULATION_STANDINGS_ENABLED: "1",
        EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "150" } }).warnings;
      assert.ok(!w2.some((x) => /W253/.test(x)), w2.join(" | "));
      assert.ok(w2.some((x) => /flushRowsPerSlice=100: 2 x rows \+ 2 above .*=150 .*\(W254\)/.test(x)), w2.join(" | "));

      const modEnv = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
      assert.deepStrictEqual(KEYS.filter((k) => !modEnv.includes(`# ${k}=`)), []);
      const composeFile = findCompose();
      if (composeFile) {
        const compose = fs.readFileSync(composeFile, "utf8");
        assert.ok(compose.includes(`${KEYS[0]}: \${${KEYS[0]}:-0}`));
        assert.deepStrictEqual(KEYS.slice(1).filter((k) => !compose.includes(`${k}: \${${k}:-}`)), []);
        const rootEnv = fs.readFileSync(path.join(path.dirname(composeFile), ".env.example"), "utf8");
        assert.deepStrictEqual(KEYS.filter((k) => !rootEnv.includes(`# ${k}=`)), []);
      }
    });
};
