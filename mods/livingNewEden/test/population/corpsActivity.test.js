"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { resolveConfig } = config;
const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { createPilotStore } = require("../../lib/population/store");
const { createCorpsService } = require("../../lib/population/corps/service");
const { CORP_STATE } = require("../../lib/population/corps/schema");
const rules = require("../../lib/population/corps/rules");
const { settingsOf, ARCHETYPE, INTENT, STATE } = require("../../lib/population/schema");
const career = require("../../lib/population/lifecycle/career");
const { CAREER } = require("../../lib/population/lifecycle/schema");
const { hullPoolOf, isRouteRestricted } = require("../../lib/population/data/hullPools");
const { generateName } = require("../../lib/freeCorps/names");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { findCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ROOT_DIR = path.resolve(MOD_DIR, "..", "..");
const SEED = 93;
const T0 = 1700000000000;
const N = 300;
const MIN = 60000;
const SYS_A = 101;
const SYS_B = 201;
const LIFE = { enabled: true, awayPerDayPermille: 0, quitOnReturnPermille: 0 };
const ENV_KEYS = ["EVEJS_LNE_POPULATION_LIFECYCLE_CORPS_ACTIVITY_ENABLED",
  "EVEJS_LNE_POPULATION_LIFECYCLE_CORPS_REGION_COMPACT_AT"];

const CORPS = { enabled: true, targetCorps: 0, foundPerPass: 1, foundingIntervalMs: 1000, maxCorpsPerPass: 4,
  reviewMs: MIN, scanPerReview: 64, recruitsPerReview: 5, leavePermille: 0, membersMin: 3, membersMax: 120,
  corplessPermille: 0, focusMatchPermille: 1000, otherFocusPermille: 1000, joinMaxDistance: 60,
  dissolveAfterMs: 3 * MIN, retentionMs: 3600000, flushRowsPerSlice: 100, maxNameAttempts: 8 };

const fakeTable = () => ({ indexOf: new Map([[SYS_A, 0], [SYS_B, 1]]), regionId: Int32Array.from([10, 20]) });

function corpRow(corpId, homeId, ceo, nextAt) {
  return { corpId, name: `Corp ${corpId}`, ticker: "CC", focus: 1, state: CORP_STATE.ACTIVE, homeId,
    regionId: homeId === SYS_A ? 10 : 20, profile: 0, ceoPilotId: ceo, members: 0, seq: 0, foundedAt: T0, nextAt,
    lowSince: 0, endedAt: 0, version: 1 };
}

function rig(o) {
  const pilots = createPilotStore(o.n);
  const home = o.home || (() => SYS_A);
  for (let id = 1; id <= o.n; id += 1) {
    const away = o.away ? o.away(id) : false;
    pilots.put({ pilotId: id, systemId: away ? 0 : home(id), prevId: away ? home(id) : 0, destId: 0, homeId: home(id),
      shipTypeId: 1, archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: away ? STATE.AWAY : STATE.DOCKED, seq: 0,
      sinceAt: 0, dueAt: 0, flags: 0, corpId: o.corp ? o.corp(id) : 0, groupId: 0, gen: 0, career: 0, xp: 0,
      wealth: 0 });
  }
  const counters = {};
  const bump = (name, k = 1) => {
    counters[name] = (counters[name] || 0) + k;
  };
  const table = fakeTable();
  const make = () => createCorpsService({ S: { corps: { ...CORPS, ...(o.C || {}) } }, worldSeed: SEED, pilots,
    getTable: () => table, standings: { profileOfPilot: () => 0, distance: () => 0 },
    generateName: ({ corpId, attempt }) => ({ name: `Corp ${corpId} ${attempt}`, ticker: "TT" }), bump,
    ...(o.activity ? { activity: { isActive: (id) => pilots.stateOf(id) !== STATE.AWAY,
      isEligible: (id) => pilots.stateOf(id) !== STATE.AWAY, compactAt: o.compactAt || 256 } } : {}) });
  const c = make();
  c.load(o.rows || [], T0);
  return { pilots, c, counters, make };
}

const setAway = (pilots, id) => pilots.apply(id, { state: STATE.AWAY, systemId: 0, prevId: pilots.homeOf(id) });
const setBack = (pilots, id) => pilots.apply(id, { state: STATE.DOCKED, systemId: pilots.homeOf(id), prevId: 0 });

const settingsWith = (o) => settingsOf({ population: F.populationConfig({ enabled: true, size: N,
  seedRowsPerSlice: 400, flushRowsPerSlice: 400, maxEventsPerPass: 5000, maxPassMs: 50, maxRoutesPerPass: 100000,
  standings: { enabled: true }, ...o }) });

async function booted(store, settings) {
  const clock = { t: T0, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: SEED, clock, settings,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: F.fakeGraph() }) }),
    listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
    generateName });
  assert.strictEqual(await svc.boot(), "running", JSON.stringify(svc.getStatus()));
  return svc;
}

function exec(store, sql) {
  const r = store.transaction("test.write", (tx) => tx.prepare(sql).run());
  assert.ok(r.ok, JSON.stringify(r));
}

function corpsRun(svc, steps) {
  const c = svc.corps();
  assert.ok(c, JSON.stringify(svc.getStatus().corps));
  for (let k = 0; k < steps; k += 1) c.step(T0 + k * (MIN + 1));
  const corps = [];
  for (let id = 1; id <= c.getStatus().maxIdSeen; id += 1) corps.push({ corp: c.corp(id), members: c.membersOf(id) });
  const counters = Object.fromEntries(Object.entries(svc.getStatus().counters).filter(([k]) => k.startsWith("corps.")));
  return { corps, counters, rows: c.takeDirty(100000), bytes: c.approxBytes(), status: c.getStatus() };
}

const counterOf = (svc, name) => svc.getStatus().counters[name] || 0;

module.exports = ({ test, skip }) => {
  const driver = loadDriver();

  test("CA1 removeMember: members and CEO at once, the second call refused", () => {
    const { c, pilots, counters } = rig({ n: 5, corp: (id) => (id <= 3 ? 1 : 0),
      rows: [corpRow(1, SYS_A, 1, T0 + 10 * MIN)], C: { recruitsPerReview: 0 } });
    c.takeDirty(100);
    assert.strictEqual(c.getStatus().members, 3);
    assert.deepStrictEqual(c.removeMember(1), { removed: true });
    assert.deepStrictEqual(c.membersOf(1), [2, 3]);
    assert.deepStrictEqual([c.corp(1).members, c.corp(1).ceoPilotId, c.corp(1).state], [2, 2, CORP_STATE.ACTIVE]);
    assert.strictEqual(pilots.corpOf(1), 0);
    assert.strictEqual(counters["corps.left"], 1);
    assert.strictEqual(c.getStatus().members, 2);
    const rows = c.takeDirty(100);
    assert.deepStrictEqual(rows.map((r) => [r.corpId, r.members, r.ceoPilotId]), [[1, 2, 2]]);
    assert.deepStrictEqual(c.removeMember(1), { removed: false });
    assert.strictEqual(counters["corps.left"], 1);
    assert.deepStrictEqual(c.removeMember(3), { removed: true });
    assert.strictEqual(c.corp(1).ceoPilotId, 2);
    c.removeMember(2);
    assert.deepStrictEqual([c.corp(1).members, c.corp(1).ceoPilotId, c.corp(1).state], [0, 0, CORP_STATE.ACTIVE]);
    c.step(T0 + 10 * MIN);
    assert.strictEqual(c.corp(1).state, CORP_STATE.DISSOLVED);
  });

  test("CA2 flag off bit for bit: no key / false / true without the life cycle / true with nobody AWAY", async () => {
    const S = { membersMin: 3, dissolveAfterMs: 3 * MIN };
    for (const members of [0, 1, 2, 3, 5]) {
      for (const lowSince of [0, T0 - 4 * MIN, T0 - MIN]) {
        const a = rules.shouldDissolve({ lowSince }, members, T0, S);
        const b = rules.shouldDissolveActive({ lowSince }, members, members, T0, S);
        assert.deepStrictEqual([b.dissolve, b.lowSince, b.inactive], [a.dissolve, a.lowSince, false]);
      }
    }
    if (!driver.ok) {
      skip("CA2 service part", `no sqlite driver: ${driver.detail || driver.reason}`);
      return;
    }
    const corps = { ...CORPS, targetCorps: 3, leavePermille: 300, membersMin: 4, recruitsPerReview: 3 };
    const variants = [LIFE, { ...LIFE, corpsActivityEnabled: false }, { enabled: false, corpsActivityEnabled: true },
      { ...LIFE, corpsActivityEnabled: true }];
    const out = [];
    for (const lifecycle of variants) {
      await F.withStore(driver, async (store) => {
        const svc = await booted(store, settingsWith({ corps, lifecycle }));
        out.push(corpsRun(svc, 12));
        svc.stop();
      });
    }
    assert.ok(out[0].corps.length >= 2 && out[0].counters["corps.joined"] > 0 && out[0].counters["corps.left"] > 0,
      JSON.stringify(out[0].counters));
    for (let i = 1; i < out.length; i += 1) {
      assert.deepStrictEqual(out[i].corps, out[0].corps, `variant ${i}: corporations and members`);
      assert.deepStrictEqual(out[i].rows, out[0].rows, `variant ${i}: dirty rows`);
      assert.deepStrictEqual(out[i].counters, out[0].counters, `variant ${i}: counters`);
      assert.strictEqual(out[i].bytes, out[0].bytes, `variant ${i}: approxBytes`);
    }
    for (const r of out.slice(0, 3)) assert.ok(!("activity" in r.status), JSON.stringify(r.status));
    assert.deepStrictEqual(out[3].status.activity, { extraEntries: 0, compactions: 0 });
  });

  test("CA3 dissolution by the active members: AWAY members, the timer, a return resets it", () => {
    const o = { n: 4, corp: () => 1, away: (id) => id >= 3, rows: [corpRow(1, SYS_A, 1, T0)] };
    const { c, pilots, counters } = rig({ ...o, activity: true });
    c.step(T0);
    assert.deepStrictEqual([c.corp(1).state, c.corp(1).lowSince, c.corp(1).members], [CORP_STATE.ACTIVE, T0, 4]);
    c.step(T0 + MIN);
    assert.strictEqual(c.corp(1).lowSince, T0);
    setBack(pilots, 3);
    c.step(T0 + 2 * MIN);
    assert.deepStrictEqual([c.corp(1).state, c.corp(1).lowSince], [CORP_STATE.ACTIVE, 0], "a return resets the timer");
    setAway(pilots, 3);
    for (let k = 3; k <= 5; k += 1) c.step(T0 + k * MIN);
    assert.deepStrictEqual([c.corp(1).state, c.corp(1).lowSince], [CORP_STATE.ACTIVE, T0 + 3 * MIN]);
    c.step(T0 + 6 * MIN);
    assert.deepStrictEqual([c.corp(1).state, c.corp(1).endedAt, c.membersOf(1).length],
      [CORP_STATE.DISSOLVED, T0 + 6 * MIN, 0]);
    for (let id = 1; id <= 4; id += 1) assert.strictEqual(pilots.corpOf(id), 0, `pilot ${id} (AWAY too) left`);
    assert.deepStrictEqual([counters["corps.dissolved"], counters["corps.dissolvedInactive"]], [1, 1]);

    const off = rig(o);
    for (let k = 0; k <= 6; k += 1) off.c.step(T0 + k * MIN);
    assert.deepStrictEqual([off.c.corp(1).state, off.c.corp(1).lowSince], [CORP_STATE.ACTIVE, 0]);
    assert.strictEqual(off.counters["corps.dissolvedInactive"], undefined);

    const all = rig({ n: 3, corp: () => 1, away: () => true, rows: [corpRow(1, SYS_A, 1, T0)], activity: true });
    all.c.step(T0);
    assert.deepStrictEqual([all.c.corp(1).state, all.c.corp(1).lowSince], [CORP_STATE.ACTIVE, T0]);
  });

  test("CA4 founder and recruits skip AWAY / ROOKIE (career on); ROOKIE kept without the career", async () => {
    if (!driver.ok) {
      skip("CA4 population service", `no sqlite driver: ${driver.detail || driver.reason}`);
      return;
    }
    const corps = { ...CORPS, targetCorps: 1, membersMin: 1, recruitsPerReview: 10 };
    const runWith = async (careerEnabled) => F.withStore(driver, async (store) => {
      const seeded = await booted(store, settingsWith({ lifecycle: LIFE }));
      seeded.stop();
      exec(store, "UPDATE world_npc_pilots SET state = 5, system_id = 0, prev_id = home_id WHERE pilot_id % 4 = 1");
      exec(store, "UPDATE world_npc_pilots SET career = 1 WHERE pilot_id % 4 = 2");
      const svc = await booted(store, settingsWith({ corps,
        lifecycle: { ...LIFE, corpsActivityEnabled: true, careerEnabled } }));
      const c = svc.corps();
      assert.strictEqual(c.step(T0).founded, 1);
      const ceo = c.corp(1).ceoPilotId;
      for (let k = 1; k <= 4; k += 1) c.step(T0 + k * (MIN + 1));
      const members = c.membersOf(1);
      const skipped = counterOf(svc, "corps.skippedInactive");
      const joined = counterOf(svc, "corps.joined");
      svc.stop();
      return { ceo, members, skipped, joined };
    });
    const on = await runWith(true);
    assert.strictEqual(on.ceo, 3, "pilot 1 AWAY and pilot 2 ROOKIE never found");
    assert.ok(on.joined > 0, JSON.stringify(on));
    assert.ok(on.skipped >= 2, JSON.stringify(on));
    assert.deepStrictEqual(on.members.filter((id) => id % 4 === 1 || id % 4 === 2), [], JSON.stringify(on.members));
    const off = await runWith(false);
    assert.strictEqual(off.ceo, 2, "a ROOKIE founds without the career");
    assert.deepStrictEqual(off.members.filter((id) => id % 4 === 1), [], "AWAY never recruited");
    assert.ok(off.members.filter((id) => id !== 2 && id % 4 === 2).length > 0, JSON.stringify(off.members));
  });

  test("CA5 region list after a home change, compaction, restart; config keys and W273", () => {
    const o = { n: 40, home: (id) => (id <= 20 ? SYS_A : SYS_B), corp: (id) => (id === 1 ? 1 : id === 21 ? 2 : 0),
      rows: [corpRow(1, SYS_A, 1, T0 + MIN), corpRow(2, SYS_B, 21, T0)], activity: true,
      C: { recruitsPerReview: 64 } };
    const r = rig(o);
    r.pilots.apply(30, { homeId: SYS_A, systemId: SYS_A });
    assert.deepStrictEqual(r.c.noteHomeChange(30), { noted: true, compacted: false });
    r.c.step(T0);
    assert.strictEqual(r.pilots.corpOf(30), 0, "corp B never recruits a pilot with a home in region A");
    assert.ok(r.counters["corps.skippedInactive"] >= 1);
    assert.ok(r.c.membersOf(2).includes(31));
    r.c.step(T0 + MIN);
    assert.ok(r.c.membersOf(1).includes(30), JSON.stringify(r.c.membersOf(1)));
    assert.deepStrictEqual(r.c.getStatus().activity, { extraEntries: 1, compactions: 0 });

    const k = rig({ ...o, corp: () => 0, rows: [corpRow(1, SYS_A, 0, T0 + 10 * MIN)], compactAt: 16 });
    const before = k.c.approxBytes();
    for (let id = 21; id <= 36; id += 1) {
      k.pilots.apply(id, { homeId: SYS_A, systemId: SYS_A });
      assert.deepStrictEqual(k.c.noteHomeChange(id), { noted: true, compacted: false });
    }
    assert.deepStrictEqual(k.c.getStatus().activity, { extraEntries: 16, compactions: 0 });
    assert.strictEqual(k.c.approxBytes() - before, 16 * 8 + 64, "16 additions + one map entry");
    assert.deepStrictEqual(k.c.noteHomeChange(21), { noted: true, compacted: true });
    assert.deepStrictEqual(k.c.getStatus().activity, { extraEntries: 0, compactions: 1 });
    assert.strictEqual(k.c.approxBytes() - before, 16 * 4, "list A + 16 unique Int32 entries");
    const again = k.make();
    k.pilots.apply(5, { corpId: 1 });
    again.load([corpRow(1, SYS_A, 5, T0)], T0);
    again.step(T0);
    const members = again.membersOf(1);
    for (let id = 21; id <= 36; id += 1) assert.ok(members.includes(id), `pilot ${id} in the base list of A`);
    assert.ok(!members.some((id) => id > 36), JSON.stringify(members));
    assert.deepStrictEqual(again.getStatus().activity, { extraEntries: 0, compactions: 0 });

    const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
    const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
    assert.deepStrictEqual([def.config.population.lifecycle.corpsActivityEnabled,
      def.config.population.lifecycle.corpsRegionCompactAt], [false, 256]);
    assert.ok(!def.warnings.some((x) => /W27[34]/.test(x)), def.warnings.join(" | "));
    const flag = { ...env0, EVEJS_LNE_POPULATION_ENABLED: "1", [ENV_KEYS[0]]: "1" };
    const w1 = resolveConfig({ modDir: MOD_DIR, env: flag }).warnings;
    assert.ok(w1.some((x) => /\(W273\)/.test(x)), w1.join(" | "));
    const w2 = resolveConfig({ modDir: MOD_DIR, env: { ...flag, EVEJS_LNE_POPULATION_LIFECYCLE_ENABLED: "1",
      EVEJS_LNE_POPULATION_CORPS_ENABLED: "1", EVEJS_LNE_POPULATION_STANDINGS_ENABLED: "1" } }).warnings;
    assert.ok(!w2.some((x) => /W273/.test(x)), w2.join(" | "));
    const rows = config.SCHEMA.filter((row) => ENV_KEYS.includes(row.env));
    assert.deepStrictEqual(rows.map((row) => row.key), ["population.lifecycle.corpsActivityEnabled",
      "population.lifecycle.corpsRegionCompactAt"]);
    const modEnv = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    const rootEnv = fs.readFileSync(path.join(ROOT_DIR, ".env.example"), "utf8");
    assert.deepStrictEqual(ENV_KEYS.filter((k2) => !modEnv.includes(`# ${k2}=`)), []);
    assert.deepStrictEqual(ENV_KEYS.filter((k2) => !rootEnv.includes(`# ${k2}=`)), []);
    const composeFile = findCompose();
    if (composeFile) {
      const compose = fs.readFileSync(composeFile, "utf8");
      assert.ok(compose.includes(`${ENV_KEYS[0]}: \${${ENV_KEYS[0]}:-0}`));
      assert.ok(compose.includes(`${ENV_KEYS[1]}: \${${ENV_KEYS[1]}:-}`));
    }
  });

  test("CA6 career fixes of lifecycle: hull of a home move, xp of a seeded promotion, W274",
    async () => {
      const S = settingsOf({ population: F.populationConfig({ bandPermille: "0,0,1000", hulls: { enabled: true },
        lifecycle: { ...LIFE, careerEnabled: true, moveHomePermille: 1000 } }) });
      const T = F.table(S);
      const freighter = hullPoolOf(ARCHETYPE.TRADER, "highsec").find((h) => isRouteRestricted(h));
      assert.ok(freighter, "a route restricted TRADER hull");
      const p = { pilotId: 7, systemId: F.sid(3), prevId: 0, destId: 0, homeId: F.sid(3), shipTypeId: freighter,
        archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.DOCKED, seq: 3, sinceAt: T0, dueAt: T0,
        flags: 0, corpId: 0, groupId: 0, gen: 0, career: CAREER.PILOT, xp: 400, wealth: 5000 };
      const r = career.promote(p, CAREER.SEASONED, S.lifecycle.career, S, T, SEED, T0);
      assert.strictEqual(r.moved, true);
      assert.strictEqual(T.bandOf(r.next.homeId), "nullsec");
      assert.ok(r.next.shipTypeId !== undefined && !isRouteRestricted(r.next.shipTypeId), String(r.next.shipTypeId));
      assert.ok(hullPoolOf(ARCHETYPE.TRADER, "nullsec").includes(r.next.shipTypeId));
      const safeHull = hullPoolOf(ARCHETYPE.TRADER, "nullsec").find((h) => !isRouteRestricted(h));
      assert.strictEqual(career.promote({ ...p, shipTypeId: safeHull }, CAREER.SEASONED, S.lifecycle.career, S, T, SEED,
        T0).next.shipTypeId, undefined);
      const off = settingsOf({ population: F.populationConfig({ bandPermille: "0,0,1000",
        lifecycle: { ...LIFE, careerEnabled: true, moveHomePermille: 1000 } }) });
      const r0 = career.promote(p, CAREER.SEASONED, off.lifecycle.career, off, F.table(off), SEED, T0);
      assert.deepStrictEqual([r0.moved, r0.next.shipTypeId], [true, undefined]);

      const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_POPULATION_ENABLED: "1",
        EVEJS_LNE_POPULATION_LIFECYCLE_ENABLED: "1", EVEJS_LNE_POPULATION_LIFECYCLE_CAREER_ENABLED: "1" };
      const w = (extra) => resolveConfig({ modDir: MOD_DIR, env: { ...env, ...extra } }).warnings;
      assert.ok(!w({}).some((x) => /W274/.test(x)), w({}).join(" | "));
      assert.ok(w({ EVEJS_LNE_POPULATION_LIFECYCLE_XP_BY_CAREER: "0,300,30,1500" }).some((x) => /\(W274\)/.test(x)));
      assert.ok(w({ EVEJS_LNE_POPULATION_LIFECYCLE_COST_BY_CAREER: "0,100,1500,8000",
        EVEJS_LNE_POPULATION_LIFECYCLE_WEALTH_MAX: "5000" }).some((x) => /\(W274\)/.test(x)));

      if (!driver.ok) {
        skip("CA6 population service", `no sqlite driver: ${driver.detail || driver.reason}`);
        return;
      }
      await F.withStore(driver, async (store) => {
        const svc = await booted(store, settingsWith({ lifecycle: { ...LIFE, careerEnabled: true,
          xpByCareer: "50,50,50,50", costByCareer: "0,0,0,0", seedCareerPermille: "1000,0,0,0",
          moveHomePermille: 0 } }));
        svc.runPass(T0 + 91 * MIN);
        const promoted = Array.from({ length: N }, (_, i) => svc.pilot(i + 1))
          .filter((v) => v.career !== null && v.career !== "ROOKIE");
        assert.ok(promoted.length > 0, "promotions");
        assert.deepStrictEqual(promoted.filter((v) => v.xp < 50).map((v) => [v.pilotId, v.career, v.xp]), []);
        svc.stop();
      });
    });
};
