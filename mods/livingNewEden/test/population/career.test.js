"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadDriver } = require("../notices/storeHelper");
const { createPopulationService } = require("../../lib/population/service");
const { settingsOf, ARCHETYPE, INTENT, STATE } = require("../../lib/population/schema");
const rules = require("../../lib/population/rules");
const career = require("../../lib/population/lifecycle/career");
const { CAREER, hullCountOf, identityKey } = require("../../lib/population/lifecycle/schema");
const { hullPoolOf } = require("../../lib/population/data/hullPools");
const { ARCHETYPES } = require("../../lib/population/data/archetypes");
const { buildStandingTables, createStandings } = require("../../lib/population/standings");
const { createRng } = require("../../lib/util/rng");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const config = require("../../config");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 77;
const T0 = 1700000000000;
const N = 300;
const MIN = 60000;
const HOUR = 60 * MIN;
const BASE = { enabled: true, size: N, seedRowsPerSlice: 100, flushRowsPerSlice: 400, maxEventsPerPass: 5000,
  maxPassMs: 50, maxRoutesPerPass: 100000 };
const LIFE = { enabled: true, awayPerDayPermille: 0, quitOnReturnPermille: 0 };
const FACTIONS = Object.freeze([{ factionId: 500001, kind: "empire", homeRegionIds: [10] },
  { factionId: 500019, kind: "pirate" }]);
const CAREER_KEYS = ["careerEnabled", "xpByCareer", "costByCareer", "earnByBand", "tradeEarn", "lossOnPod", "wealthMax",
  "seedCareerPermille", "moveHomePermille"];

const settingsWith = (life, extra = {}) => settingsOf({ population: F.populationConfig({ ...BASE, ...extra,
  lifecycle: life }) });

async function booted(store, settings, opts = {}) {
  const graph = F.fakeGraph();
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: SEED, clock, settings, telemetry: opts.telemetry,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }),
    listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
    ...(opts.factions ? { standingFactions: opts.factions } : {}) });
  assert.strictEqual(await svc.boot(), "running");
  return { svc, clock };
}

function gauges() {
  const g = {};
  return { g, telemetry: { count() {}, observe() {}, gauge(name, value) {
    g[name] = value;
  } } };
}

const views = (svc) => Array.from({ length: N }, (_, i) => svc.pilot(i + 1));
const counter = (svc, name) => svc.getStatus().counters[name];

function pilot(extra) {
  return { pilotId: 1, systemId: F.sid(3), prevId: 0, destId: 0, homeId: F.sid(3), shipTypeId: 0,
    archetype: ARCHETYPE.RATTER, intent: INTENT.DOCK, state: STATE.DOCKED, seq: 500, sinceAt: T0, dueAt: T0,
    flags: 0, corpId: 0, groupId: 0, gen: 0, career: CAREER.ROOKIE, xp: 0, wealth: 0, ...extra };
}

const NO_ROUTE = () => ({ ok: false, reason: "NO_ROUTE" });

function rolls(p, T, S, opts, tries = 3000) {
  const out = [];
  for (let s = 1; s <= tries; s += 1) out.push(rules.rollIntent(p, T, S, createRng(s), NO_ROUTE, T0, opts));
  return out;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();

  test("CR3 hull slice of RESHIP (with / without context) and podRespawn; the bands of a ROOKIE", () => {
    const S = settingsWith({ ...LIFE, careerEnabled: true }, { hulls: { enabled: true } });
    const off = settingsWith(LIFE, { hulls: { enabled: true } });
    const T = F.table(S);
    const pool = hullPoolOf(ARCHETYPE.RATTER, "highsec");
    const rookieN = hullCountOf(pool.length, CAREER.ROOKIE);
    assert.ok(rookieN >= 1 && rookieN < pool.length, `pool ${pool.length}, slice ${rookieN}`);
    const cx = { hourPermille: () => 1000, dangerOf: () => 0, hasBelts: () => true, attracts: () => false,
      attractList: () => [] };
    for (const opts of [undefined, { context: cx }]) {
      const rookie = rolls(pilot({ shipTypeId: pool[0] }), T, S, opts)
        .filter((r) => r.ok && r.next.intent === INTENT.RESHIP);
      assert.ok(rookie.length > 0, "RESHIP rolled");
      for (const r of rookie) assert.ok(pool.slice(0, rookieN).includes(r.next.shipTypeId), String(r.next.shipTypeId));
      const vet = new Set(rolls(pilot({ shipTypeId: pool[0], career: CAREER.VETERAN }), T, S, opts)
        .filter((r) => r.ok && r.next.intent === INTENT.RESHIP).map((r) => r.next.shipTypeId));
      assert.ok([...vet].some((h) => !pool.slice(0, rookieN).includes(h)), `veteran hulls ${[...vet]}`);
    }
    for (let s = 1; s <= 200; s += 1) {
      const r = rules.podRespawn(pilot({ state: STATE.POD, shipTypeId: pool[0] }), S, createRng(s), T0, T);
      assert.ok(pool.slice(0, rookieN).includes(r.next.shipTypeId), String(r.next.shipTypeId));
    }
    const vetPod = new Set(Array.from({ length: 200 }, (_, s) => rules.podRespawn(pilot({ state: STATE.POD,
      shipTypeId: pool[0], career: CAREER.VETERAN }), S, createRng(s + 1), T0, T).next.shipTypeId));
    assert.ok(vetPod.has(pool[pool.length - 1]), `veteran POD hulls ${[...vetPod]}`);
    const inLow = pilot({ systemId: F.sid(7), state: STATE.ACTIVE, intent: INTENT.RAT, shipTypeId: pool[0] });
    assert.deepStrictEqual([...rules.archOf(inLow, S, T).bands], ["highsec"]);
    assert.strictEqual(rules.archOf(inLow, off, T), ARCHETYPES[ARCHETYPE.RATTER], "flag off = ARCHETYPES");
    assert.strictEqual(rules.archOf(pilot({ career: CAREER.SEASONED }), S, T), ARCHETYPES[ARCHETYPE.RATTER]);
    const rat = (S2) => rolls(inLow, T, S2, undefined, 500).filter((r) => r.ok && r.next.intent === INTENT.RAT).length;
    assert.strictEqual(rat(S), 0, "ROOKIE: no RAT in lowsec");
    assert.ok(rat(off) > 0, "flag off: RAT in lowsec");
    assert.deepStrictEqual([...rules.archOf(pilot({ homeId: F.sid(8) }), S, T).bands], ["highsec", "lowsec"]);
  });

  if (!driver.ok) {
    for (const name of ["CR1", "CR2", "CR4", "CR5"]) {
      skip(`${name} population career`, `no sqlite driver: ${driver.detail || driver.reason}`);
    }
    return;
  }

  test("CR1 bit for bit: careerEnabled absent / false / without lifecycle.enabled = the same rows, career 0",
    async () => {
      const runs = [];
      for (const life of [LIFE, { ...LIFE, careerEnabled: false }, { ...LIFE, enabled: false, careerEnabled: true }]) {
        await F.withStore(driver, async (store) => {
          const { svc } = await booted(store, settingsWith(life));
          for (let k = 1; k <= 60; k += 1) svc.runPass(T0 + k * 30 * MIN);
          assert.strictEqual(counter(svc, "lifecycle.careerSeeded"), 0);
          assert.strictEqual(svc.getStatus().lifecycle && svc.getStatus().lifecycle.career, undefined);
          svc.stop();
          runs.push(F.dbRows(store));
        });
      }
      assert.strictEqual(runs[0].length, N);
      assert.strictEqual(Object.keys(runs[0][0]).length, 19, Object.keys(runs[0][0]).join(","));
      assert.ok(runs[0].some((r) => r.seq > 2), "the pilots moved");
      for (const r of runs[0]) assert.deepStrictEqual([r.career, r.xp, r.wealth], [0, 0, 0], `pilot ${r.pilot_id}`);
      assert.deepStrictEqual(runs[1], runs[0], "careerEnabled false = absent");
      assert.deepStrictEqual(runs[2], runs[0], "careerEnabled without lifecycle.enabled = off");
    });

  test("CR2 accrue (activity by band, trade with a jump, POD min 0, wealthMax); a ROOKIE promoted to PILOT",
    async () => {
      const C = settingsWith({ ...LIFE, careerEnabled: true, wealthMax: 100 }).lifecycle.career;
      assert.deepStrictEqual([...C.earnByBand], [10, 20, 40]);
      const act = pilot({ state: STATE.ACTIVE, intent: INTENT.RAT, xp: 4, wealth: 5 });
      assert.deepStrictEqual(career.accrue(act, { state: STATE.DOCKED }, C, 1, false),
        { xp: 5, wealth: 25, event: "ACTIVITY" });
      assert.deepStrictEqual(career.accrue({ ...act, wealth: 95 }, { state: STATE.TRAVEL }, C, 2, false),
        { xp: 5, wealth: 100, event: "ACTIVITY" }, "wealthMax");
      const trader = pilot({ archetype: ARCHETYPE.TRADER, state: STATE.TRAVEL, intent: INTENT.TRAVEL, xp: 1,
        wealth: 1 });
      assert.deepStrictEqual(career.accrue(trader, { state: STATE.DOCKED }, C, 0, true),
        { xp: 2, wealth: 16, event: "TRADE" });
      assert.strictEqual(career.accrue(trader, { state: STATE.DOCKED }, C, 0, false).event, null, "no jump");
      assert.deepStrictEqual(career.accrue({ ...act, career: CAREER.SEASONED, wealth: 120 }, { state: STATE.POD }, C, 0,
        false), { xp: 4, wealth: 0, event: "POD" }, "3 x 50 > 120 -> 0");

      await F.withStore(driver, async (store) => {
        const { g, telemetry } = gauges();
        const S = settingsWith({ ...LIFE, careerEnabled: true, xpByCareer: "0,3,100000,200000",
          costByCareer: "0,20,100000,200000", seedCareerPermille: "1000,0,0,0" }, { bandPermille: "1000,0,0" });
        const { svc } = await booted(store, S, { telemetry });
        for (let k = 1; k <= 3; k += 1) svc.runPass(T0 + k * 30 * MIN);
        const first = svc.getStatus().lifecycle.career.byCareer;
        assert.deepStrictEqual([first.UNASSIGNED, first.ROOKIE, g["population.rookies"]], [0, N, N],
          JSON.stringify(first));
        let promotedPilot = null;
        for (let k = 4; k <= 200 && !promotedPilot; k += 1) {
          const before = views(svc);
          svc.runPass(T0 + k * 30 * MIN);
          const after = views(svc);
          const i = after.findIndex((v, j) => v.career === "PILOT" && before[j].career === "ROOKIE");
          if (i >= 0) promotedPilot = { before: before[i], after: after[i] };
        }
        assert.ok(promotedPilot, "a ROOKIE was promoted");
        const { before, after } = promotedPilot;
        assert.ok(before.xp >= 3 && before.wealth >= 20, JSON.stringify(before));
        assert.deepStrictEqual([after.wealth, after.xp, after.state, after.systemId],
          [before.wealth - 20, before.xp, "DOCKED", before.systemId]);
        assert.ok(counter(svc, "lifecycle.promoted") >= 1);
        assert.ok(g["population.rookies"] < N, `rookies ${g["population.rookies"]}`);
        assert.strictEqual(g["population.veterans"], 0);
        const by = svc.getStatus().lifecycle.career.byCareer;
        assert.strictEqual(by.ROOKIE + by.PILOT + by.UNASSIGNED, N, JSON.stringify(by));
        svc.stop();
      });
    });

  test("CR4 seed career (nullsec home >= SEASONED, xp threshold, deterministic, counted once); home move at SEASONED",
    async () => {
      const S = settingsWith({ ...LIFE, careerEnabled: true, seedCareerPermille: "1000,0,0,0" },
        { bandPermille: "0,0,1000" });
      const C = S.lifecycle.career;
      assert.deepStrictEqual([...C.minCareerByBand], [1, 2, 3]);
      const s = career.seedCareerOf(pilot({ career: 0 }), C, SEED, 2);
      assert.deepStrictEqual(s, { career: CAREER.SEASONED, xp: 300 });
      const rows = [];
      for (let run = 0; run < 2; run += 1) {
        await F.withStore(driver, async (store) => {
          const { svc } = await booted(store, S);
          svc.runPass(T0 + 91 * MIN);
          assert.strictEqual(counter(svc, "lifecycle.careerSeeded"), N, "every seed pilot written once");
          for (const v of views(svc)) assert.deepStrictEqual([v.career, v.xp >= 300], ["SEASONED", true]);
          svc.runPass(T0 + 181 * MIN);
          assert.strictEqual(counter(svc, "lifecycle.careerSeeded"), N, "not counted again");
          svc.stop();
          rows.push(F.dbRows(store));
        });
      }
      assert.deepStrictEqual(rows[1], rows[0], "two instances, the same rows");

      await F.withStore(driver, async (store) => {
        const M = settingsWith({ ...LIFE, careerEnabled: true, seedCareerPermille: "0,1000,0,0",
          xpByCareer: "0,0,0,999999", costByCareer: "0,0,0,999999", moveHomePermille: 1000 },
        { standings: { enabled: true } });
        const { svc } = await booted(store, M, { factions: FACTIONS });
        const std = svc.standings();
        const before = views(svc);
        const old = before.map((v) => std.profileOfPilot(v.pilotId));
        svc.runPass(T0 + 91 * MIN);
        const after = views(svc);
        const moved = after.filter((v, i) => v.homeId !== before[i].homeId);
        assert.ok(moved.length > 0, "homes moved");
        assert.strictEqual(counter(svc, "lifecycle.homeMoved"), moved.length);
        assert.ok(counter(svc, "lifecycle.promoted") >= moved.length);
        const T = F.table(M);
        const tables = buildStandingTables({ worldSeed: SEED, factions: FACTIONS, table: T, S: M });
        let changed = 0;
        for (const v of moved) {
          assert.deepStrictEqual([v.career, v.state, v.systemId], ["SEASONED", "DOCKED", v.homeId]);
          const fresh = createStandings({ tables, worldSeed: SEED, size: N, homeOf: () => v.homeId,
            indexOf: (id) => T.indexOf.get(id), identityOf: (id) => identityKey(id, 0) });
          assert.strictEqual(std.profileOfPilot(v.pilotId), fresh.profileOfPilot(v.pilotId), `pilot ${v.pilotId}`);
          if (fresh.profileOfPilot(v.pilotId) !== old[v.pilotId - 1]) changed += 1;
        }
        assert.ok(changed > 0, "a moved pilot has a new standing profile");
        svc.stop();
      });
    });

  test("CR5 restart: the same rows and byCareer; 9 keys in config / compose / .env.example x2; W272",
    async () => {
      const S = settingsWith({ ...LIFE, careerEnabled: true, xpByCareer: "0,2,4,6", costByCareer: "0,10,20,30" });
      const PASSES = 80;
      const at = (k) => T0 + k * 30 * MIN;
      let reference = null;
      await F.withStore(driver, async (store) => {
        const { svc } = await booted(store, S);
        for (let k = 1; k <= PASSES; k += 1) svc.runPass(at(k));
        assert.ok(counter(svc, "lifecycle.promoted") > 0, "promotions in the reference");
        svc.stop();
        reference = F.dbRows(store);
      });
      assert.ok(reference.some((r) => r.career >= CAREER.SEASONED), "SEASONED+ in the reference");
      await F.withStore(driver, async (store) => {
        const a = await booted(store, S);
        for (let k = 1; k <= PASSES / 2; k += 1) a.svc.runPass(at(k));
        const by = a.svc.getStatus().lifecycle.career.byCareer;
        a.svc.stop();
        const b = await booted(store, S, { clock: { t: at(PASSES / 2), now() { return this.t; } } });
        assert.deepStrictEqual(b.svc.getStatus().lifecycle.career.byCareer, by, "recountCareers = before the restart");
        for (let k = PASSES / 2 + 1; k <= PASSES; k += 1) b.svc.runPass(at(k));
        b.svc.stop();
        assert.deepStrictEqual(F.dbRows(store), reference, "the same rows as without the restart");
      });

      const keyRows = config.SCHEMA.filter((r) => CAREER_KEYS.some((k) => r.key === `population.lifecycle.${k}`));
      assert.deepStrictEqual(keyRows.map((r) => r.key.slice("population.lifecycle.".length)), CAREER_KEYS);
      const compose = fs.readFileSync(path.resolve(MOD_DIR, "..", "..", "compose.yaml"), "utf8");
      const rootEnv = fs.readFileSync(path.resolve(MOD_DIR, "..", "..", ".env.example"), "utf8");
      const modEnv = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
      for (const row of keyRows) {
        const want = row.type === "boolean" ? `${row.env}: \${${row.env}:-0}` : `${row.env}: \${${row.env}:-}`;
        assert.ok(compose.includes(want), want);
        assert.ok(rootEnv.includes(`# ${row.env}=`), `root .env.example ${row.env}`);
        assert.ok(modEnv.includes(`# ${row.env}=`), `mod .env.example ${row.env}`);
      }
      const w272 = (w) => /careerEnabled without .* \(W272\)/.test(w);
      const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
      const env = { EVEJS_LNE_POPULATION_ENABLED: "1", EVEJS_LNE_POPULATION_LIFECYCLE_CAREER_ENABLED: "1" };
      assert.ok(resolve(env).warnings.some(w272), "careerEnabled without lifecycle.enabled");
      const both = resolve({ ...env, EVEJS_LNE_POPULATION_LIFECYCLE_ENABLED: "1" });
      assert.ok(!both.warnings.some(w272), both.warnings.join(" | "));
      assert.ok(!resolve({}).warnings.some(w272));
    });
};
