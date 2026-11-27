"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createFreeCorpVentureRepository } = require("../../lib/freeCorps/ventureRepository");
const { createResidentReads } = require("../../lib/freeCorps/residentReads");
const whCorpModule = require("../../lib/freeCorps/whCorpRepository");
const W = require("../../lib/freeCorps/whCorps");
const V = require("../../lib/freeCorps/ventures");
const FCS = require("../../lib/freeCorps/schema");
const { createRng, deriveSeed } = require("../../lib/util/rng");
const { createJournal } = require("../../lib/persistence/journal");
const H = require("./hunting.test").harness;
const { loadDriver, withStore, withStoreAsync } = require("../notices/storeHelper");
const CT = require("../../lib/freeCorps/contracts");
const { buildContractGoods } = require("../../lib/freeCorps/contractGoods");
const { WH_GAS_TYPES } = require("../../lib/freeCorps/data/whGoods");
const contractPumpModule = require("../../lib/freeCorps/contractPump");
const contractModule = require("../../lib/freeCorps/contractRepository");
const outboxModule = require("../../lib/freeCorps/outboxRepository");
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const { createManualClock } = require("../../lib/util/clock");
const VIEW = require("../../lib/freeCorps/view");
const { createWormholeIndex } = require("../../lib/freeCorps/wormholeIndex");
const { createViewRegistry } = require("../../lib/observer/views");
const HT =require("../../lib/economy/data/hullTradeTypes");
const MP = require("../../lib/economy/data/mineralRefPrices");
const GOODS_DATA = Object.freeze({ oreBands: require("../../lib/economy/data/industryCatalog").ORE_BANDS,
  oreTypes: require("../../lib/economy/data/oreTypes").ORE_TYPES, refPriceMilli: MP.REF_PRICE_MILLI,
  hullValueFactorPermille: MP.HULL_VALUE_FACTOR_PERMILLE, hullGroups: require("../../lib/economy/data/hullRecipes").GROUPS,
  hullRaces: HT.RACES, factionRace: HT.FACTION_RACE, hullGroupKeys: ["frigate", "destroyer"] });
const GOODS_BASE = buildContractGoods(GOODS_DATA);
const GOODS_GAS = buildContractGoods({ ...GOODS_DATA, gasTypes: WH_GAS_TYPES });

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = H.T0;
const L1 = H.L1;
const K1 = 30000001;
const K2 = 30000002;
const J1 = 31000001;
const J2 = 31000002;
const MIG = MIGRATIONS.findIndex((m) => m.name === "free-corp-wh-corps");
const COLS = ["venture_id", "corp_id", "seq", "kind", "state", "open", "home_system_id", "system_id",
  "target_system_id", "target_station_id", "sec_band", "jumps", "crew", "crew_lost", "step", "travel_steps",
  "work_steps", "steps_total", "holds", "yield_isk", "cost_isk", "started_at", "step_due_at", "updated_at", "ended_at",
  "end_reason", "version", "wh_route", "wh_entry_system_id", "stranded_steps"];

const plain = (rows) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
  typeof v === "bigint" ? Number(v) : v])));
const all = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.all", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return plain(r.value);
};
const run = (opened, sql, ...args) => opened.store.transaction("t.run", (db) => db.prepare(sql).run(...args));

const vrow = (i, kind, o = {}) => ({ venture_id: `fcv:${i}:1`, corp_id: i, seq: 1, kind, state: "DONE", open: 0,
  home_system_id: K1, system_id: K1, target_system_id: K2, target_station_id: null, sec_band: "highsec", jumps: 1,
  crew: 3, crew_lost: 0, step: 4, travel_steps: 1, work_steps: 2, steps_total: 4, holds: 0, yield_isk: 1000 * i,
  cost_isk: 0, started_at: T0, step_due_at: T0 + 1, updated_at: T0, ended_at: T0 + 5, end_reason: "DONE", version: 2,
  wh_route: null, wh_entry_system_id: null, stranded_steps: 0, ...o });

function cfgOf({ wc = {}, wormholes = null, fc = {}, ventures = {} } = {}) {
  const base = H.cfgOf({ hunting: { enabled: false }, ventures, fc });
  const f = base.freeCorps;
  const out = { ...base, freeCorps: { ...f, whCorps: { ...f.whCorps, enabled: true, targetCorps: 0, ...wc,
    home: { ...f.whCorps.home, ...(wc.home || {}) }, haul: { ...f.whCorps.haul, ...(wc.haul || {}) },
    raid: { ...f.whCorps.raid, ...(wc.raid || {}) },
    contracts: { ...f.whCorps.contracts, ...(wc.contracts || {}) } } } };
  if (wormholes) out.freeCorps.wormholes = { ...f.wormholes, enabled: true, ...wormholes };
  return out;
}

function whGraph(edges) {
  const cls = { [K1]: "highsec", [K2]: "highsec", [J1]: "wormhole", [J2]: "wormhole" };
  const gates = { [K1]: [K2], [K2]: [K1] };
  const byId = new Map(Object.entries(cls).map(([id, c]) => [Number(id), { id: Number(id), name: `S${id}`,
    regionId: 10000002, constellationId: 20000020, secClass: c }]));
  const pair = (a, b) => (gates[a] || []).includes(b)
    || edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  return { getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (byId.has(id) ? (gates[id] || []).slice() : null),
    listWormholeEdges: () => edges.map(([a, b]) => ({ fromSystemId: a, toSystemId: b, expiresAt: 0 })),
    getWormholeVersion: () => 1, getRouteStats: () => ({ wormholeEdges: edges.length }),
    validateRoute: (route) => ({ ok: route.every((id, i) => i === 0 || pair(route[i - 1], id)) }) };
}

const HUB = 30000142;
function haulGraph(edges) {
  const cls = { [L1]: "highsec", [K2]: "highsec", [HUB]: "highsec", [J1]: "wormhole", [J2]: "wormhole" };
  const gates = { [L1]: [K2], [K2]: [L1, HUB], [HUB]: [K2] };
  const g = whGraph(edges);
  const byId = new Map(Object.entries(cls).map(([id, c]) => [Number(id), { id: Number(id), name: `S${id}`,
    regionId: 10000002, constellationId: 20000020, secClass: c }]));
  const pair = (a, b) => (gates[a] || []).includes(b)
    || edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  const findRoute = (from, to, c = {}) => {
    if (!byId.has(from) || !byId.has(to)) return { ok: false, reason: "UNKNOWN_SYSTEM" };
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length > 0 && !prev.has(to)) {
      const id = queue.shift();
      for (const nb of gates[id] || []) if (!prev.has(nb)) { prev.set(nb, id); queue.push(nb); }
    }
    if (!prev.has(to)) return { ok: false, reason: "UNREACHABLE" };
    const route = [];
    for (let id = to; id !== null; id = prev.get(id)) route.unshift(id);
    const jumps = route.length - 1;
    if (Number.isSafeInteger(c.maxJumps) && jumps > c.maxJumps) return { ok: false, reason: "TOO_FAR" };
    return { ok: true, route, jumps, cost: jumps };
  };
  return { ...g, getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (byId.has(id) ? (gates[id] || []).slice() : null),
    validateRoute: (route) => ({ ok: route.every((id, i) => i === 0 || pair(route[i - 1], id)) }), findRoute };
}

const A1 = 30000021;
const A2 = 30000022;
const A3 = 30000023;
function raidGraph(edges) {
  const cls = { [L1]: "highsec", [K2]: "lowsec", [A1]: "nullsec", [J1]: "wormhole", [J2]: "wormhole" };
  const gates = { [L1]: [K2], [K2]: [L1, A1], [A1]: [K2] };
  const g = whGraph(edges);
  const byId = new Map(Object.entries(cls).map(([id, c]) => [Number(id), { id: Number(id), name: `S${id}`,
    regionId: 10000002, constellationId: 20000020, secClass: c }]));
  const pair = (a, b) => (gates[a] || []).includes(b)
    || edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  return { ...g, getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (byId.has(id) ? (gates[id] || []).slice() : null),
    validateRoute: (route) => ({ ok: route.every((id, i) => i === 0 || pair(route[i - 1], id)) }) };
}

const insertHome = (opened, corpId, j, staging = L1) => {
  const r = opened.store.transaction("t.h", (db) => whCorpModule.createFreeCorpWhCorpRepository().insertInTx(db,
    { corpId, jSystemId: j, stagingSystemId: staging, now: T0 - 1000 }));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
};
const homeOf = (opened, corpId) => all(opened, "SELECT * FROM world_free_corp_wh_homes WHERE corp_id = ?", corpId)[0];
const openVenture = (opened, corpId) => all(opened, "SELECT * FROM world_free_corp_ventures WHERE corp_id = ? "
  + "ORDER BY seq DESC LIMIT 1", corpId)[0];

function haulScene(opened, { second = false } = {}) {
  const cfg = cfgOf({ wc: { haul: { enabled: true } }, wormholes: {} });
  H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
  insertHome(opened, 1, J1);
  H.exec(opened, "UPDATE world_free_corp_wh_homes SET loot_isk = 250000000, gas_isk = 100000000 WHERE corp_id = 1");
  if (second) {
    H.seedCorp(opened, { corpId: 2, archetype: "explorer", seed: 777, nextAt: T0 + 3 * cfg.freeCorps.ventures.stepMs });
    insertHome(opened, 2, J2);
    H.exec(opened, "UPDATE world_free_corp_wh_homes SET cargo_loot_isk = 7, cargo_gas_isk = 3, cargo_venture_seq = 5 "
      + "WHERE corp_id = 2");
  }
  const graph = haulGraph([[K2, J1]]);
  const env = H.boot(opened, { cfg, stationSystems: [L1, K2], extra: { getWormholes: () => ({
    isSynced: () => true, getStatus: () => ({}) }), getGraph: () => ({ ok: true, graph }) } });
  env.vc.identities.set(1, H.linked(5, 98000001));
  if (second) env.vc.identities.set(2, H.linked(5, 98000002));
  return env;
}

function untilClosed(opened, env, corpId, stepMs, from = T0) {
  let st = null;
  for (let i = 0; i < 20; i += 1) {
    env.clock.set(from + i * stepMs);
    st = H.pass(env);
    const v = openVenture(opened, corpId);
    if (v && v.open === 0) return { st, at: from + i * stepMs, v };
  }
  throw new Error("the venture never closed");
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WC1 migration 127: every old venture kind copied 1:1 (30 columns), 3 indexes, WH_HOME without a route, "
    + "the new CHECKs, the homes table, TABLE_POLICY KEEP", () => {
    assert.ok(MIG > 0, "WH corps migration registered");
    assert.strictEqual(MIGRATIONS[MIG].version, 127);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-wc1-"));
    const file = path.join(tmp, "world.sqlite");
    const open = (migrations) => openStore({ filePath: file, openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations });
    const indexSql = "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_free_corp_ventures' "
      + "AND sql IS NOT NULL ORDER BY name";
    const listSql = `SELECT ${COLS.join(", ")} FROM world_free_corp_ventures ORDER BY venture_id`;
    try {
      const before = open(MIGRATIONS.slice(0, MIG));
      assert.ok(before.ok, JSON.stringify(before));
      const rows = ["MINE", "HAUL", "RAT", "EXPLORE", "BUILD", "RUN", "HUNT", "ANCHOR"].map((k, i) => vrow(i + 1, k));
      rows.push(vrow(9, "EXPLORE_WH", { state: "STRANDED", open: 1, ended_at: null, end_reason: null, system_id: J1,
        target_system_id: J1, sec_band: "wormhole", steps_total: 5, wh_route: JSON.stringify([J1, K2]),
        wh_entry_system_id: K2, stranded_steps: 2, step: 2 }));
      rows.push(vrow(10, "MINE", { state: "WORKING", open: 1, ended_at: null, end_reason: null, step: 2 }));
      for (const v of rows) {
        const r = run(before, `INSERT INTO world_free_corp_ventures (${COLS.join(", ")}) VALUES (${COLS.map(() => "?")
          .join(", ")})`, ...COLS.map((c) => v[c]));
        assert.ok(r.ok, JSON.stringify(r));
      }
      const snap = all(before, listSql);
      const idx = all(before, indexSql).map((x) => x.name);
      before.store.close("test");
      const after = open(MIGRATIONS.slice(0, MIG + 1));
      assert.ok(after.ok, JSON.stringify(after));
      try {
        assert.deepStrictEqual(all(after, listSql), snap, "every row 1:1");
        assert.strictEqual(snap.length, 10);
        assert.deepStrictEqual(all(after, indexSql).map((x) => x.name), idx);
        assert.deepStrictEqual(idx, ["world_free_corp_ventures_ended", "world_free_corp_ventures_open",
          "world_free_corp_ventures_system"]);
        assert.strictEqual(all(after, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = "
          + "'world_free_corp_ventures_v127'")[0].n, 0);
        const repo = createFreeCorpVentureRepository();
        const home = vrow(11, "WH_HOME", { state: "WORKING", open: 1, ended_at: null, end_reason: null, home_system_id: J1,
          system_id: J1, target_system_id: J1, sec_band: "wormhole", jumps: 0, travel_steps: 0, work_steps: 3,
          steps_total: 3, step: 0 });
        const ok = after.store.transaction("t.v", (db) => repo.insertInTx(db, home, T0));
        assert.ok(ok.ok && ok.value.ok, JSON.stringify(ok));
        const bad1 = after.store.transaction("t.v", (db) => repo.insertInTx(db, { ...home, venture_id: "fcv:12:1",
          corp_id: 12, wh_route: JSON.stringify([J1, K2]) }, T0));
        assert.ok(!bad1.ok && /CHECK constraint failed/.test(String(bad1.error && bad1.error.message)),
          `WH_HOME with a route: ${JSON.stringify(bad1)}`);
        const bad2 = run(after, "UPDATE world_free_corp_ventures SET state = 'STRANDED', open = 1, ended_at = NULL, "
          + "end_reason = NULL WHERE venture_id = 'fcv:7:1'");
        assert.ok(!bad2.ok && /CHECK constraint failed/.test(String(bad2.error && bad2.error.message)),
          `HUNT STRANDED: ${JSON.stringify(bad2)}`);
        assert.strictEqual(all(after, "SELECT COUNT(*) AS n FROM world_free_corp_wh_homes")[0].n, 0);
        assert.deepStrictEqual(all(after, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = "
          + "'world_free_corp_wh_homes' AND sql IS NOT NULL ORDER BY name").map((x) => x.name),
        ["world_free_corp_wh_homes_j", "world_free_corp_wh_homes_open"]);
      } finally {
        after.store.close("test");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    assert.strictEqual(TABLE_POLICY.world_free_corp_wh_homes, ACTION.KEEP);
  });

  needsDriver("WC2 flag off = no whCorps section bit for bit (rows, journal), one anyOpenInTx then no home read; "
    + "stepCorpVenture reads no home with whCorpsOn false", () => {
    const stepMs = H.cfgOf().freeCorps.ventures.stepMs;
    const sequence = (cfg, spy) => {
      let out = null;
      const real = whCorpModule.createFreeCorpWhCorpRepository;
      if (spy) {
        whCorpModule.createFreeCorpWhCorpRepository = () => {
          const repo = real();
          return Object.freeze(Object.fromEntries(Object.entries(repo).map(([name, fn]) => [name, (...a) => {
            spy.push(name);
            return fn(...a);
          }])));
        };
      }
      try {
        withStore(driver, (opened) => {
          const env = H.scene(opened, cfg, null);
          for (let i = 0; i < 6; i += 1) {
            env.clock.set(T0 + i * stepMs);
            H.pass(env);
          }
          out = { corps: all(opened, "SELECT * FROM world_free_corps ORDER BY corp_id"),
            ventures: all(opened, "SELECT * FROM world_free_corp_ventures ORDER BY venture_id"),
            journal: all(opened, "SELECT idempotency_key, event_type, payload, created_at FROM world_event_journal "
              + "ORDER BY journal_id") };
          env.fc.stop();
        });
      } finally {
        whCorpModule.createFreeCorpWhCorpRepository = real;
      }
      return out;
    };
    const base = H.cfgOf({ hunting: { enabled: false } });
    const { whCorps: _wc, ...noSection } = base.freeCorps;
    const spy = [];
    const off = sequence({ ...base, freeCorps: { ...base.freeCorps, whCorps: { ...base.freeCorps.whCorps,
      enabled: false } } }, spy);
    const old = sequence({ ...base, freeCorps: noSection }, null);
    assert.ok(off.ventures.length >= 2, JSON.stringify(off.ventures.map((v) => v.kind)));
    assert.deepStrictEqual(off, old, "bit for bit");
    assert.deepStrictEqual(spy, ["anyOpenInTx"], "one read, then whSeen = false");

    const S = base.freeCorps;
    const corp = { corp_id: 1, archetype: "explorer", state: "ACTIVE", open: 1, sec_band: "highsec",
      home_system_id: K1, members_target: 5, isk: 200000000, struggle_count: 0, seed: 7, venture_seq: 0,
      recover_until: 0, recover_crew: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0, isk_lost: 0,
      last_review_at: 0, ended_at: null, end_reason: null };
    const env = { now: T0, linkedCount: 5, memberRoom: 0, isObserved: () => false, beltsOf: () => 2,
      stationsOf: () => [], reachOf: () => Object.freeze([{ systemId: K1, jumps: 0, secClass: "highsec" },
        { systemId: K2, jumps: 1, secClass: "highsec" }]) };
    const a = V.stepCorpVenture(corp, null, env, S);
    const b = V.stepCorpVenture(corp, null, { ...env, whCorpsOn: false,
      whCorp: () => { throw new Error("home read with the flag off"); } }, S);
    assert.deepStrictEqual(b, a);
  });

  needsDriver("WC3 quota: WH LIVE, 2 pairs -> explorer + home J1 in one applyFn (payload whSystemId), then J2; no pair "
    + "-> whQuotaNoHome and the plain founding", () => {
    const fc = { bandWeights: "highsec:100", maxFoundingOpen: 8 };
    const synced = { getWormholes: () => ({ isSynced: () => true, getStatus: () => ({}) }) };
    withStore(driver, (opened) => {
      const cfg = cfgOf({ fc, wc: { targetCorps: 2 }, wormholes: {} });
      const graph = whGraph([[K2, J1], [K2, J2]]);
      const env = H.boot(opened, { cfg, stationSystems: [K1, K2],
        extra: { ...synced, getGraph: () => ({ ok: true, graph }) } });
      let st = H.pass(env);
      const first = all(opened, "SELECT corp_id, archetype, home_system_id FROM world_free_corps ORDER BY corp_id");
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0].archetype, "explorer");
      const h1 = homeOf(opened, first[0].corp_id);
      assert.ok(h1 && h1.open === 1 && [J1, J2].includes(h1.j_system_id), JSON.stringify(h1));
      assert.strictEqual(h1.staging_system_id, first[0].home_system_id);
      const payload = JSON.parse(all(opened, "SELECT payload FROM world_event_journal WHERE idempotency_key = ?",
        `lne:fc:found:${first[0].corp_id}`)[0].payload);
      assert.strictEqual(payload.whSystemId, h1.j_system_id);
      assert.strictEqual(st.counters.whCorpsFounded, 1);
      env.clock.set(T0 + cfg.freeCorps.foundingIntervalMs);
      st = H.pass(env);
      const homes = all(opened, "SELECT corp_id, j_system_id FROM world_free_corp_wh_homes ORDER BY corp_id");
      assert.deepStrictEqual(homes.map((h) => h.j_system_id).sort(), [J1, J2], "the taken J is skipped");
      assert.deepStrictEqual(st.whCorps, { open: 2, target: 2 });
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const cfg = cfgOf({ fc: { ...fc, targetCorps: 1 }, wc: { targetCorps: 2 }, wormholes: {} });
      const graph = whGraph([]);
      const env = H.boot(opened, { cfg, stationSystems: [K1, K2],
        extra: { ...synced, getGraph: () => ({ ok: true, graph }) } });
      const st = H.pass(env);
      assert.strictEqual(st.counters.whQuotaNoHome, 1);
      assert.strictEqual(st.counters.founded, 1, "the plain founding goes on");
      assert.strictEqual(all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_wh_homes")[0].n, 0);
      env.fc.stop();
    });
  });

  needsDriver("WC4 WH_HOME: WORKING in J, DONE -> stock of splitHomeYield + PI in the treasury; stock ceiling -> "
    + "whStockCapped then WH_STOCK_FULL; observed J never LOST; deterministic", () => {
    const cfg = cfgOf();
    const P = cfg.freeCorps;
    const stepMs = P.ventures.stepMs;
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
      insertHome(opened, 1, J1);
      const env = H.boot(opened, { cfg });
      env.vc.identities.set(1, H.linked(5, 98000001));
      H.pass(env);
      const v0 = openVenture(opened, 1);
      assert.deepStrictEqual([v0.kind, v0.state, v0.system_id, v0.home_system_id, v0.sec_band, v0.wh_route],
        ["WH_HOME", "WORKING", J1, J1, "wormhole", null]);
      const done = untilClosed(opened, env, 1, stepMs, T0 + stepMs);
      assert.strictEqual(done.v.state, "DONE");
      const part = W.splitHomeYield(done.v.yield_isk, P.whCorps.home);
      const h = homeOf(opened, 1);
      assert.deepStrictEqual([h.loot_isk, h.gas_isk, h.pi_isk_total, h.home_done], [part.loot, part.gas, part.pi, 1]);
      assert.ok(part.pi > 0 && part.loot > part.gas, JSON.stringify(part));
      assert.strictEqual(H.all(opened, "SELECT isk_earned FROM world_free_corps WHERE corp_id = 1")[0].isk_earned,
        part.pi, "PI into the treasury");
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const small = cfgOf({ wc: { home: { stockMaxIsk: 1000 } } });
      H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
      insertHome(opened, 1, J1);
      const env = H.boot(opened, { cfg: small });
      env.vc.identities.set(1, H.linked(5, 98000001));
      H.pass(env);
      const done = untilClosed(opened, env, 1, stepMs, T0 + stepMs);
      const h = homeOf(opened, 1);
      assert.deepStrictEqual([h.loot_isk + h.gas_isk, h.home_done], [1000, 1]);
      assert.strictEqual(done.st.counters.whStockCapped, 1);
      env.clock.set(done.at + P.ventures.restMs);
      const st = H.pass(env);
      assert.strictEqual(st.counters.whStockFull, 1);
      assert.strictEqual(openVenture(opened, 1).open, 0, "no new venture");
      env.fc.stop();
    });

    const S = { ...P, ventures: { ...P.ventures, loss: { highsecPermille: 0, lowsecPermille: 0,
      nullsecPermille: 1000 } }, whCorps: { ...P.whCorps, home: { ...P.whCorps.home, riskPermille: 1000 } } };
    const corp = { corp_id: 1, seed: 4242, venture_seq: 0, members_target: 5, recover_until: 0, recover_crew: 0,
      isk: 100000000 };
    const wh = { j_system_id: J1, loot_isk: 0, gas_isk: 0 };
    const p = W.planWhCorpVenture(corp, wh, { now: T0, linkedCount: 5 }, S);
    assert.ok(p.ok, JSON.stringify(p));
    const step = (observed) => W.advanceWhCorpVenture(corp, p.row, wh, { now: T0 + stepMs,
      isObserved: () => observed }, S);
    assert.deepStrictEqual([step(true).venture.state, step(true).closed, step(true).venture.step], ["WORKING", null, 1]);
    assert.deepStrictEqual([step(false).venture.state, step(false).closed, step(false).whPatch], ["LOST", "LOST", null]);
    assert.deepStrictEqual(W.planWhCorpVenture(corp, wh, { now: T0, linkedCount: 5 }, S), p, "same seed, same row");
    assert.deepStrictEqual(step(false), step(false), "same seed, same step");
    assert.deepStrictEqual(W.planWhCorpVenture(corp, { ...wh, loot_isk: S.whCorps.home.stockMaxIsk },
      { now: T0, linkedCount: 5 }, S), { ok: false, reason: "WH_STOCK_FULL" });
  });

  needsDriver("WC5 the home of a closed corporation -> CORP_CLOSED; homeCorpsInTx(staging) without the WH corporation; "
    + "config defaults, W280-W281", () => {
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "explorer", nextAt: T0 + 86400000 });
      H.seedCorp(opened, { corpId: 2, archetype: "explorer", nextAt: T0 + 86400000 });
      H.seedCorp(opened, { corpId: 3, archetype: "miner", nextAt: T0 + 86400000 });
      insertHome(opened, 1, J1);
      insertHome(opened, 2, J2);
      H.exec(opened, "UPDATE world_free_corps SET state = 'MERGED', open = 0, ended_at = ?, end_reason = 'MERGED', "
        + "merged_into = 3 WHERE corp_id = 1", T0 - 10);
      const env = H.boot(opened, { cfg: cfgOf() });
      const st = H.pass(env);
      const h1 = homeOf(opened, 1);
      assert.deepStrictEqual([h1.open, h1.end_reason, h1.ended_at], [0, "CORP_CLOSED", T0]);
      assert.strictEqual(homeOf(opened, 2).open, 1);
      assert.strictEqual(st.counters.whHomeSwept, 1);
      const reads = createResidentReads();
      const r = opened.store.transaction("t.r", (db) => reads.homeCorpsInTx(db, L1, 10));
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      assert.deepStrictEqual(r.value.rows.map((x) => x.corpId), [3], "the WH corporation is not idle in staging");
      env.fc.stop();
    });
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    const { haul: _haul, raid: _raid, contracts: _contracts, ...whCorpsSub1 } = def.config.freeCorps.whCorps;
    assert.deepStrictEqual(whCorpsSub1, { enabled: false, targetCorps: 4, homePickTries: 8,
      sweepPerPass: 8, home: { riskPermille: 800, lootIskPerStepPerPilot: 6000000, gasIskPerStepPerPilot: 2000000,
        piIskPerStepPerPilot: 1000000, stockMaxIsk: 2000000000 } });
    const on = resolve({ EVEJS_LNE_FREE_CORPS_WH_CORPS_ENABLED: "1", EVEJS_LNE_FREE_CORPS_WH_CORPS_TARGET_CORPS: "0" });
    assert.ok(on.warnings.some((w) => w.endsWith("(W280)")), on.warnings.join("|"));
    assert.ok(on.warnings.some((w) => w.endsWith("(W281)")), on.warnings.join("|"));
    assert.ok(!def.warnings.some((w) => /\(W28[01]\)$/.test(w)));
  });

  const P2 = cfgOf({ wc: { haul: { enabled: true } } }).freeCorps;
  const corpP = { corp_id: 1, seed: 4242, venture_seq: 1, members_target: 5, recover_until: 0, recover_crew: 0,
    isk: 100000000 };
  const homeP = Object.freeze({ j_system_id: J1, staging_system_id: L1, loot_isk: 250000000, gas_isk: 100000000,
    cargo_loot_isk: 0, cargo_gas_isk: 0, cargo_venture_seq: null });
  const whP = (o = {}) => ({ mode: "LIVE", waitSince: null, isLinked: () => true,
    findExit: () => ({ ok: true, route: [J1, K2], hops: 1, gateJumps: 1 }), ...o });
  const haulP = (o = {}) => ({ hubIds: [HUB], hubOf: () => ({ ok: true, hubSystemId: HUB, jumps: 4 }),
    bandOf: () => "nullsec", ...o });
  const envP = (o = {}) => ({ now: T0, linkedCount: 5, isObserved: () => false, wh: whP(), haul: haulP(), ...o });
  const loadedP = Object.freeze({ ...homeP, loot_isk: 0, gas_isk: 0, cargo_loot_isk: 250000000,
    cargo_gas_isk: 100000000, cargo_venture_seq: 2 });

  needsDriver("WC6 WH_HAUL plan: row (T, 2T+1, route, band) + load; NO_HUB -> staging; DEFERRED; env.haul null = the "
    + "WH_HOME of; stepCorpVenture carries whPatch (insert, refusal); the pass moves the stock into the cargo", () => {
    const p = W.planWhCorpVenture(corpP, homeP, envP(), P2);
    assert.ok(p.ok, JSON.stringify(p));
    const r = p.row;
    assert.deepStrictEqual([r.kind, r.state, r.system_id, r.home_system_id, r.target_system_id, r.sec_band, r.jumps,
      r.travel_steps, r.work_steps, r.steps_total, r.wh_route, r.wh_entry_system_id, r.seq],
    ["WH_HAUL", "TRAVEL", J1, J1, HUB, "nullsec", 5, 3, 1, 7, JSON.stringify([J1, K2]), K2, 2]);
    assert.deepStrictEqual(p.whPatch, { op: "load", seq: 2 });
    const st = W.planWhCorpVenture(corpP, homeP, envP({ haul: haulP({ hubOf: () => ({ ok: false, reason: "NO_HUB" }) }) }),
      P2);
    assert.deepStrictEqual([st.row.target_system_id, st.row.jumps, st.row.travel_steps], [L1, 2, 2]);
    for (const e of [envP({ haul: haulP({ hubOf: () => ({ ok: false, reason: "DEFERRED" }) }) }),
      envP({ wh: whP({ findExit: () => ({ ok: false, reason: "DEFERRED" }) }) })]) {
      assert.deepStrictEqual(W.planWhCorpVenture(corpP, homeP, e, P2), { ok: false, reason: "WH_HAUL_DEFERRED" });
    }
    const sub1 = W.planWhCorpVenture(corpP, homeP, { now: T0, linkedCount: 5 }, P2);
    assert.strictEqual(sub1.row.kind, "WH_HOME");
    assert.deepStrictEqual(W.planWhCorpVenture(corpP, homeP, envP({ haul: null }), P2), sub1, "flag off bit for bit");
    assert.deepStrictEqual(W.planWhCorpVenture(corpP, homeP, envP({ wh: whP({ findExit: () => ({ ok: false,
      reason: "NO_EXIT" }) }) }), P2), sub1, "NO_EXIT = WH_HOME");
    const corp = { ...corpP, archetype: "explorer", state: "ACTIVE", open: 1, sec_band: "highsec", home_system_id: L1,
      isk: 200000000, struggle_count: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0, isk_lost: 0,
      last_review_at: 0, ended_at: null, end_reason: null };
    const senv = (home) => envP({ memberRoom: 0, beltsOf: () => 2, stationsOf: () => [], reachOf: () => null,
      whCorpsOn: true, whCorp: () => home });
    const ins = V.stepCorpVenture(corp, null, senv(homeP), P2);
    assert.deepStrictEqual([ins.venture.op, ins.venture.row.kind, ins.whPatch], ["insert", "WH_HAUL", p.whPatch]);
    const orphan = V.stepCorpVenture(corp, null, senv({ ...loadedP, cargo_venture_seq: 9 }), P2);
    assert.deepStrictEqual([orphan.venture, orphan.rest, orphan.whPatch],
      [null, { reason: "WH_CARGO_RESTORED" }, { op: "restore", seq: 9 }]);
    assert.ok(orphan.tallies.includes("whCargoRestored"));
    withStore(driver, (opened) => {
      const env = haulScene(opened);
      H.pass(env);
      const v = openVenture(opened, 1);
      assert.deepStrictEqual([v.kind, v.state, v.target_system_id, v.wh_route, v.travel_steps, v.steps_total],
        ["WH_HAUL", "TRAVEL", HUB, JSON.stringify([J1, K2]), 2, 5]);
      const h = homeOf(opened, 1);
      assert.deepStrictEqual([h.loot_isk, h.gas_isk, h.cargo_loot_isk, h.cargo_gas_isk, h.cargo_venture_seq],
        [0, 0, 250000000, 100000000, 2]);
      env.fc.stop();
    });
  });

  needsDriver("WC7 the sale exactly once: treasury + floor(L*1000/1000) + floor(G*900/1000), cargo 0, sold_isk_total, "
    + "journal lne:fc:whsale; a rolled back pass after the sale pays once; staging price; BigInt", () => {
    const stepMs = P2.ventures.stepMs;
    const sale = 250000000 + 90000000;
    const armed = { on: false, hits: 0 };
    const real = whCorpModule.createFreeCorpWhCorpRepository;
    whCorpModule.createFreeCorpWhCorpRepository = () => {
      const repo = real();
      return Object.freeze({ ...repo, updateInTx: (tx, a) => {
        if (armed.on && a && a.corpId === 2) {
          armed.on = false;
          armed.hits += 1;
          throw new Error("injected after the sale");
        }
        return repo.updateInTx(tx, a);
      } });
    };
    try {
      withStore(driver, (opened) => {
        const env = haulScene(opened, { second: true });
        for (let i = 0; i < 3; i += 1) {
          env.clock.set(T0 + i * stepMs);
          H.pass(env);
        }
        assert.strictEqual(openVenture(opened, 1).state, "WORKING");
        const isk0 = H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk;
        env.clock.set(T0 + 3 * stepMs);
        armed.on = true;
        const failed = env.fc.runPassNow();
        assert.strictEqual(failed.ok, false, "the injected fault after the sale rolls the pass back");
        assert.strictEqual(armed.hits, 1);
        assert.strictEqual(all(opened, "SELECT COUNT(*) AS n FROM world_event_journal WHERE idempotency_key LIKE "
          + "'lne:fc:whsale:%'")[0].n, 0);
        const st = H.pass(env);
        const isk1 = H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk;
        assert.strictEqual(isk1 - isk0, sale, "paid exactly once");
        const h = homeOf(opened, 1);
        assert.deepStrictEqual([h.cargo_loot_isk, h.cargo_gas_isk, h.cargo_venture_seq, h.sold_isk_total],
          [0, 0, null, sale]);
        const j = all(opened, "SELECT idempotency_key, event_type, payload FROM world_event_journal WHERE "
          + "idempotency_key LIKE 'lne:fc:whsale:%'");
        assert.deepStrictEqual(j.map((x) => [x.idempotency_key, x.event_type]), [["lne:fc:whsale:1:2",
          "FREE_CORP_WH_SOLD"]]);
        assert.strictEqual(JSON.parse(j[0].payload).saleIsk, sale);
        assert.strictEqual(st.counters.whHaulSold, 1);
        assert.strictEqual(st.counters.whCargoRestored, 1, "the second corporation (orphan cargo) after the retry");
        const v = openVenture(opened, 1);
        assert.deepStrictEqual([v.state, v.yield_isk, v.system_id], ["RETURNING", sale, HUB]);
        env.clock.set(T0 + 4 * stepMs);
        H.pass(env);
        env.clock.set(T0 + 5 * stepMs);
        H.pass(env);
        const done = openVenture(opened, 1);
        assert.deepStrictEqual([done.state, done.open, done.system_id, done.end_reason], ["DONE", 0, J1, null]);
        assert.strictEqual(homeOf(opened, 1).haul_done, 1);
        env.fc.stop();
      });
    } finally {
      whCorpModule.createFreeCorpWhCorpRepository = real;
    }
    const HL = P2.whCorps.haul;
    assert.strictEqual(W.haulSaleOf({ cargo_loot_isk: 1000, cargo_gas_isk: 999 }, HL, true), 1000 + 899);
    assert.strictEqual(W.haulSaleOf({ cargo_loot_isk: 1000, cargo_gas_isk: 999 }, HL, false), Math.floor(1999 * 0.85));
    const big = 9007199254740991;
    const want = (BigInt(big) * 1000n) / 1000n + (BigInt(big) * 900n) / 1000n;
    assert.strictEqual(W.haulSaleOf({ cargo_loot_isk: big, cargo_gas_isk: big }, HL, true),
      Number(want > BigInt(big) ? BigInt(big) : want), "capped at MAX_SAFE_INTEGER");
    const L = 9007199254740;
    assert.strictEqual(W.haulSaleOf({ cargo_loot_isk: 0, cargo_gas_isk: L }, { ...HL, gasSalePermille: 1999 }, true),
      Number((BigInt(L) * 1999n) / 1000n));
  });

  test("WC8 exit closed -> ABORTED WH_GONE + restore; env.haul null before the sale -> ABORTED WH_OFFLINE + restore "
    + "(no loss), after it -> DONE WH_OFFLINE + haulDone", () => {
    const p = W.planWhCorpVenture(corpP, homeP, envP(), P2);
    const step = (v, e) => W.advanceWhCorpVenture({ ...corpP, venture_seq: 2 }, v, loadedP, { ...envP(), ...e }, P2);
    const gone = step(p.row, { wh: whP({ isLinked: () => false }) });
    assert.deepStrictEqual([gone.venture.state, gone.venture.end_reason, gone.venture.system_id, gone.closed,
      gone.whPatch], ["ABORTED", "WH_GONE", J1, null, { op: "restore", seq: 2 }]);
    assert.ok(gone.tallies.includes("whHaulGone"));
    const lossy = { ...P2, ventures: { ...P2.ventures, loss: { highsecPermille: 1000, lowsecPermille: 1000,
      nullsecPermille: 1000 } }, whCorps: { ...P2.whCorps, haul: { ...P2.whCorps.haul, riskPermille: 5000 } } };
    const off = W.advanceWhCorpVenture({ ...corpP, venture_seq: 2 }, { ...p.row, step: 1, system_id: K2 }, loadedP,
      envP({ haul: null }), lossy);
    assert.deepStrictEqual([off.venture.state, off.venture.end_reason, off.closed, off.whPatch],
      ["ABORTED", "WH_OFFLINE", null, { op: "restore", seq: 2 }]);
    const ret = { ...p.row, state: "RETURNING", step: 4, system_id: K2, yield_isk: 5 };
    const sold = { ...loadedP, cargo_loot_isk: 0, cargo_gas_isk: 0, cargo_venture_seq: null };
    const doneOff = W.advanceWhCorpVenture({ ...corpP, venture_seq: 2 }, ret, sold, envP({ haul: null }), P2);
    assert.deepStrictEqual([doneOff.venture.state, doneOff.venture.end_reason, doneOff.venture.system_id,
      doneOff.closed, doneOff.whPatch, doneOff.corpDelta.done], ["DONE", "WH_OFFLINE", J1, "DONE",
      { op: "haulDone" }, 1]);
  });

  test("WC9 the last RETURNING step without a link: reroute / STRANDED outside J; NO_EXIT series -> DONE WH_LONG_WAY "
    + "without a loss; TRAVEL step 2 in nullsec: LOST + drop, observed = no loss", () => {
    const lossy = { ...P2, ventures: { ...P2.ventures, loss: { highsecPermille: 1000, lowsecPermille: 1000,
      nullsecPermille: 1000 } }, whCorps: { ...P2.whCorps, haul: { ...P2.whCorps.haul, riskPermille: 1000 } } };
    const corp = { ...corpP, venture_seq: 2 };
    const p = W.planWhCorpVenture(corpP, homeP, envP(), P2);
    const sold = { ...loadedP, cargo_loot_isk: 0, cargo_gas_isk: 0, cargo_venture_seq: null };
    const last = { ...p.row, state: "RETURNING", step: p.row.steps_total - 1, system_id: K2 };
    const cut = whP({ isLinked: () => false, findExit: () => ({ ok: true, route: [J1, J2, L1], hops: 2,
      gateJumps: 4 }) });
    const rr = W.advanceWhCorpVenture(corp, last, sold, envP({ wh: cut }), lossy);
    assert.deepStrictEqual([rr.venture.state, rr.venture.wh_route, rr.venture.steps_total],
      ["RETURNING", JSON.stringify([J1, J2, L1]), last.step + 2]);
    assert.ok(rr.venture.step <= rr.venture.steps_total && rr.tallies.includes("whHaulRerouted"));
    const none = whP({ isLinked: () => false, findExit: () => ({ ok: false, reason: "NO_EXIT" }) });
    let r = W.advanceWhCorpVenture(corp, last, sold, envP({ wh: none }), lossy);
    assert.deepStrictEqual([r.venture.state, r.venture.system_id, r.venture.step_due_at],
      ["STRANDED", K2, T0 + P2.wormholes.strandedStepMs]);
    let calls = 0;
    while (r.venture.open === 1 && calls < 100) {
      calls += 1;
      r = W.advanceWhCorpVenture(corp, r.venture, sold, envP({ now: T0 + calls * 1000, wh: none }), lossy);
      assert.notStrictEqual(r.closed, "LOST");
    }
    assert.strictEqual(calls, P2.whCorps.haul.outsideMaxSteps);
    assert.deepStrictEqual([r.venture.state, r.venture.end_reason, r.venture.system_id, r.whPatch],
      ["DONE", "WH_LONG_WAY", J1, { op: "haulDone" }]);
    assert.ok(r.tallies.includes("whLongWay"));
    const gates = { ...p.row, step: 1, system_id: K2 };
    const lost = W.advanceWhCorpVenture(corp, gates, loadedP, envP(), lossy);
    assert.deepStrictEqual([lost.venture.state, lost.closed, lost.whPatch], ["LOST", "LOST", { op: "drop", seq: 2 }]);
    const seen = W.advanceWhCorpVenture(corp, gates, loadedP, envP({ isObserved: () => true }), lossy);
    assert.deepStrictEqual([seen.venture.state, seen.venture.step, seen.closed], ["TRAVEL", 2, null]);
  });

  needsDriver("WC10 orphan cargo -> stock (whCargoRestored); whHomeFilter; refused corporation row throws "
    + "haul defaults, W282, W284", () => {
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
      insertHome(opened, 1, J1);
      H.exec(opened, "UPDATE world_free_corp_wh_homes SET loot_isk = 100, cargo_loot_isk = 7, cargo_gas_isk = 3, "
        + "cargo_venture_seq = 5 WHERE corp_id = 1");
      const env = H.boot(opened, { cfg: cfgOf() });
      env.vc.identities.set(1, H.linked(5, 98000001));
      const st = H.pass(env);
      const h = homeOf(opened, 1);
      assert.deepStrictEqual([h.loot_isk, h.gas_isk, h.cargo_loot_isk, h.cargo_gas_isk, h.cargo_venture_seq],
        [107, 3, 0, 0, null]);
      assert.strictEqual(st.counters.whCargoRestored, 1);
      assert.strictEqual(openVenture(opened, 1), undefined, "no venture in the restoring step");
      const homeCorps = (opts) => {
        const r = opened.store.transaction("t.r", (db) => createResidentReads(opts).homeCorpsInTx(db, L1, 10));
        assert.ok(r.ok && r.value.ok, JSON.stringify(r));
        return r.value.rows.map((x) => x.corpId);
      };
      assert.deepStrictEqual(homeCorps({ whHomeFilter: false }), [1], "flag off: idle in staging Local");
      assert.deepStrictEqual(homeCorps(undefined), [], "default = the filter of");
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const cfg = cfgOf({ fc: { bandWeights: "highsec:100", maxFoundingOpen: 8 }, wc: { targetCorps: 1 },
        wormholes: {} });
      const graph = whGraph([[K2, J1]]);
      H.exec(opened, "CREATE TRIGGER wc10_refuse BEFORE INSERT ON world_free_corps BEGIN "
        + "SELECT RAISE(ABORT, 'UNIQUE constraint failed: world_free_corps.name'); END");
      const taken = [];
      const real = whCorpModule.createFreeCorpWhCorpRepository;
      whCorpModule.createFreeCorpWhCorpRepository = () => {
        const repo = real();
        return Object.freeze({ ...repo, isJTakenInTx: (tx, j) => {
          const t = repo.isJTakenInTx(tx, j);
          taken.push([j, t.ok && t.taken]);
          return t;
        } });
      };
      try {
        const env = H.boot(opened, { cfg, stationSystems: [K1, K2], extra: { getWormholes: () => ({
          isSynced: () => true, getStatus: () => ({}) }), getGraph: () => ({ ok: true, graph }) } });
        const r = env.fc.runPassNow();
        assert.strictEqual(r.ok, false, `a refused corporation row rolls the pass back: ${JSON.stringify(r)}`);
        assert.strictEqual(env.fc.getStatus().counters.whQuotaRefused, 0);
        assert.deepStrictEqual(taken, [[J1, false]], "whPick: J1 free, the founding went to the J home branch");
        env.fc.stop();
      } finally {
        whCorpModule.createFreeCorpWhCorpRepository = real;
      }
    });
    const resolve = (e) => config.resolveConfig({ modDir: MOD_DIR, env: e });
    assert.deepStrictEqual(resolve({}).config.freeCorps.whCorps.haul, { enabled: false, minIsk: 300000000,
      hubSystemIds: "30000142,30002187,30002659,30002510,30002053", maxHubJumps: 20, maxHubSearchesPerPass: 4,
      lootSalePermille: 1000, gasSalePermille: 900, stagingSalePermille: 850, riskPermille: 300, outsideMaxSteps: 12 });
    const w282 = resolve({ EVEJS_LNE_FREE_CORPS_WH_CORPS_HAUL_ENABLED: "1" });
    assert.ok(w282.warnings.some((w) => w.endsWith("(W282)")), w282.warnings.join("|"));
    const w284 = resolve({ EVEJS_LNE_FREE_CORPS_WH_CORPS_HAUL_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_WH_CORPS_HAUL_MIN_ISK: "5000000000" });
    assert.ok(w284.warnings.some((w) => w.endsWith("(W284)")), w284.warnings.join("|"));
    assert.ok(!resolve({}).warnings.some((w) => /\(W28[24]\)$/.test(w)));
  });

  const P3 = cfgOf({ wc: { raid: { enabled: true } } }).freeCorps;
  const S3 = (raid = {}, o = {}) => ({ ...P3, ...o, whCorps: { ...P3.whCorps, raid: { ...P3.whCorps.raid, ...raid } } });
  const AREA = Object.freeze([{ systemId: K2, jumps: 0, secClass: "lowsec" }, { systemId: A1, jumps: 1,
    secClass: "lowsec" }, { systemId: A2, jumps: 1, secClass: "nullsec" }, { systemId: A3, jumps: 2,
    secClass: "nullsec" }]);
  const raidP = (o = {}) => ({ takePlan: () => true, areaOf: () => ({ ok: true, systems: AREA }),
    bandOf: () => "lowsec", ...o });
  const envR = (o = {}) => envP({ haul: null, raid: raidP(), ...o });
  const homeR = Object.freeze({ ...homeP, loot_isk: 0, gas_isk: 0 });
  const corpR = { ...corpP, venture_seq: 2 };
  const raidRow = () => W.planWhCorpVenture(corpP, homeR, envR(), S3({ planPermille: 1000 })).row;

  test("WC11 WH_RAID plan: env.raid null = bit for bit; planPermille 1000 -> row; 0 -> the WH_HOME of; full "
    + "stock -> raid / WH_STOCK_FULL + whRaidBudget; empty area -> whRaidNoArea; one findExit per plan", () => {
    const full = { ...homeR, loot_isk: P3.whCorps.home.stockMaxIsk };
    for (const h of [homeR, full]) {
      assert.deepStrictEqual(W.planWhCorpVenture(corpP, h, envR({ raid: null }), S3({ planPermille: 1000 })),
        W.planWhCorpVenture(corpP, h, { now: T0, linkedCount: 5 }, P3), "flag off =");
    }
    const sub2 = W.planWhCorpVenture(corpP, homeR, { now: T0, linkedCount: 5 }, P3);
    assert.strictEqual(sub2.row.kind, "WH_HOME");
    const Wk = sub2.row.work_steps;
    const p = W.planWhCorpVenture(corpP, homeR, envR(), S3({ planPermille: 1000 }));
    const r = p.row;
    assert.deepStrictEqual([r.kind, r.state, r.system_id, r.home_system_id, r.target_system_id, r.travel_steps,
      r.work_steps, r.steps_total, r.wh_route, r.wh_entry_system_id, r.sec_band, r.jumps, r.step],
    ["WH_RAID", "TRAVEL", J1, J1, K2, 1, Wk, 2 + Wk + Math.ceil(2 / P3.ventures.jumpsPerStep), JSON.stringify([J1, K2]),
      K2, "lowsec", 3, 0]);
    assert.strictEqual(p.whPatch, undefined, "a raid takes no stock");
    assert.strictEqual(p.planTallies, undefined);
    assert.deepStrictEqual(W.planWhCorpVenture(corpP, homeR, envR(), S3({ planPermille: 0 })), sub2,
      "a lost roll = the WH_HOME row of");
    assert.strictEqual(W.planWhCorpVenture(corpP, full, envR(), S3({ planPermille: 0 })).row.kind, "WH_RAID",
      "a full stock always tries a raid");
    let exits = 0;
    const spyWh = whP({ findExit: () => {
      exits += 1;
      return { ok: true, route: [J1, K2], hops: 1, gateJumps: 1 };
    } });
    assert.deepStrictEqual(W.planWhCorpVenture(corpP, full, envR({ wh: spyWh, raid: raidP({ takePlan: () => false }) }),
      S3({ planPermille: 0 })), { ok: false, reason: "WH_STOCK_FULL", planTallies: ["whRaidBudget"] });
    assert.strictEqual(exits, 0, "no exit search without takePlan");
    const noArea = W.planWhCorpVenture(corpP, homeR, envR({ raid: raidP({ areaOf: () => ({ ok: true, systems: [] }) }) }),
      S3({ planPermille: 1000 }));
    assert.deepStrictEqual(noArea, { ...sub2, planTallies: ["whRaidNoArea"] });
    let takes = 0;
    const noExit = whP({ findExit: () => {
      exits += 1;
      return { ok: false, reason: "NO_EXIT" };
    } });
    const f = W.planWhCorpVenture(corpP, homeP, envP({ wh: noExit, raid: raidP({ takePlan: () => {
      takes += 1;
      return true;
    } }) }), S3({ planPermille: 1000 }));
    assert.deepStrictEqual([f.row.kind, f.planTallies, exits, takes], ["WH_HOME", ["whRaidNoExit"], 1, 0]);
    const corp = { ...corpP, archetype: "explorer", state: "ACTIVE", open: 1, sec_band: "highsec", home_system_id: L1,
      isk: 200000000, struggle_count: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0, isk_lost: 0,
      last_review_at: 0, ended_at: null, end_reason: null };
    const senv = (home, raid) => envR({ memberRoom: 0, beltsOf: () => 2, stationsOf: () => [], reachOf: () => null,
      whCorpsOn: true, whCorp: () => home, raid });
    const ref = V.stepCorpVenture(corp, null, senv(full, raidP({ takePlan: () => false })), S3({ planPermille: 0 }));
    assert.ok(ref.tallies.includes("whStockFull") && ref.tallies.includes("whRaidBudget"), ref.tallies.join(","));
    const ins = V.stepCorpVenture(corp, null, senv(homeR, raidP({ areaOf: () => ({ ok: true, systems: [] }) })),
      S3({ planPermille: 1000 }));
    assert.ok(ins.venture.op === "insert" && ins.tallies.includes("whRaidNoArea"), ins.tallies.join(","));
  });

  test("WC12 pickRaidSystem: observed system share 0.5-0.75 (weight 5 of 8), each system >= 60 of 400 without a player; "
    + "the WORKING step stands in the picked system", () => {
    const seen = new Map();
    const free = new Map();
    for (let s = 1; s <= 400; s += 1) {
      const a = W.pickRaidSystem(AREA, (id) => id === A2, 5, createRng(deriveSeed(s, "fcwh-roam", 1, 1)));
      seen.set(a.systemId, (seen.get(a.systemId) || 0) + 1);
      const b = W.pickRaidSystem(AREA, () => false, 5, createRng(deriveSeed(s, "fcwh-roam", 1, 1)));
      free.set(b.systemId, (free.get(b.systemId) || 0) + 1);
    }
    const share = (seen.get(A2) || 0) / 400;
    assert.ok(share >= 0.5 && share <= 0.75, `observed share ${share}`);
    for (const s of AREA) assert.ok((free.get(s.systemId) || 0) >= 60, JSON.stringify([...free]));
    assert.strictEqual(W.pickRaidSystem([], () => true, 5, createRng(1)), null);
    const row = { ...raidRow(), state: "WORKING", step: 1, system_id: K2 };
    for (const obs of [false, true]) {
      const isObs = (id) => obs && id === A2;
      const a = W.advanceWhCorpVenture(corpR, row, homeR, envR({ isObserved: isObs }), S3());
      const want = W.pickRaidSystem(AREA, isObs, P3.whCorps.raid.observedWeight,
        createRng(deriveSeed(corpR.seed, "fcwh-roam", row.seq, 1)));
      assert.deepStrictEqual([a.venture.system_id, a.venture.step, a.venture.state, a.closed],
        [want.systemId, 2, row.work_steps > 1 ? "WORKING" : "RETURNING", null]);
      assert.ok(a.venture.yield_isk > 0);
      assert.strictEqual(a.tallies.includes("whRaidObservedStep"), want.observed);
    }
  });

  test("WC13 loss: nullsec unobserved -> LOST (no payout, treasury - cost), observed -> a work step; the last work "
    + "step -> RETURNING with steps_total = step + 1 + ceil(j/3): no graph = WAIT up to syncWaitMaxMs, then "
    + "OFFLINE (WH_RAID and WH_HAUL)", () => {
    const lossy = S3({ riskPermille: 1000 }, { ventures: { ...P3.ventures, loss: { highsecPermille: 0,
      lowsecPermille: 0, nullsecPermille: 1000 } } });
    const only = raidP({ areaOf: () => ({ ok: true, systems: [AREA[2]] }) });
    const row = { ...raidRow(), state: "WORKING", step: 1, system_id: K2, yield_isk: 1000 };
    const lost = W.advanceWhCorpVenture(corpR, row, homeR, envR({ raid: only }), lossy);
    assert.deepStrictEqual([lost.venture.state, lost.closed, lost.whPatch, lost.venture.system_id, lost.corpDelta.iskEarned],
      ["LOST", "LOST", null, A2, 0]);
    assert.strictEqual(lost.corpDelta.isk, -Math.min(corpR.isk, lost.venture.cost_isk));
    const safe = W.advanceWhCorpVenture(corpR, row, homeR, envR({ raid: only, isObserved: () => true }), lossy);
    assert.deepStrictEqual([safe.venture.state, safe.venture.step, safe.closed], [row.work_steps > 1 ? "WORKING"
      : "RETURNING", 2, null]);
    const last = { ...row, step: row.work_steps };
    const ret = W.advanceWhCorpVenture(corpR, last, homeR, envR({ raid: only, isObserved: () => true }), lossy);
    assert.deepStrictEqual([ret.venture.state, ret.venture.step, ret.venture.steps_total],
      ["RETURNING", last.step + 1, last.step + 2 + Math.ceil(1 / P3.ventures.jumpsPerStep)]);
    const SW = P3.wormholes.syncWaitMaxMs;
    const graphless = (now) => ({ ...envR({ now, raid: null, haul: null, wh: whP({ mode: "WAIT", waitSince: T0 }) }),
      whGraphWait: { haul: true, raid: true } });
    const wait = W.advanceWhCorpVenture(corpR, { ...row, step_due_at: T0 }, homeR, graphless(T0 + SW), S3());
    assert.deepStrictEqual(wait, { defer: true, reason: "WH_SYNC_WAIT", tallies: ["whSyncWait"] });
    const gone = W.advanceWhCorpVenture(corpR, { ...row, step_due_at: T0 }, homeR, graphless(T0 + SW + 1), S3());
    assert.deepStrictEqual([gone.venture.state, gone.venture.end_reason, gone.whPatch, gone.corpDelta.isk],
      ["DONE", "WH_OFFLINE", { op: "raidDone" }, 1000]);
    const h = W.planWhCorpVenture(corpP, homeP, envP(), P2).row;
    const hret = { ...h, state: "RETURNING", step: 4, system_id: K2, step_due_at: T0 };
    assert.strictEqual(W.advanceWhCorpVenture(corpR, hret, loadedP, graphless(T0 + SW), P2).defer, true);
    assert.deepStrictEqual(W.advanceWhCorpVenture(corpR, hret, loadedP, graphless(T0 + SW + 1), P2).venture.end_reason,
      "WH_OFFLINE");
    assert.strictEqual(W.advanceWhCorpVenture(corpR, { ...row, step_due_at: T0 }, homeR,
      { ...graphless(T0), whGraphWait: null }, S3()).venture.end_reason, "WH_OFFLINE");
  });

  needsDriver("WC14 WH_RAID with the store: plan -> DONE pays yield_isk once (rollback at raidDone), raid_done 1; no "
    + "graph = deferred step; WH_GONE in J, WORKING with env.raid null -> DONE WH_OFFLINE, STRANDED -> WH_LONG_WAY; "
    + "a duplicate whsale key throws", () => {
    const stepMs = P3.ventures.stepMs;
    const armed = { on: false, hits: 0 };
    const real = whCorpModule.createFreeCorpWhCorpRepository;
    whCorpModule.createFreeCorpWhCorpRepository = () => {
      const repo = real();
      return Object.freeze({ ...repo, updateInTx: (tx, a) => {
        if (armed.on && a && a.patch && a.patch.raid_done !== undefined) {
          armed.on = false;
          armed.hits += 1;
          throw new Error("injected at raidDone");
        }
        return repo.updateInTx(tx, a);
      } });
    };
    try {
      withStore(driver, (opened) => {
        const cfg = cfgOf({ wc: { raid: { enabled: true, planPermille: 1000 } }, wormholes: {} });
        H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
        insertHome(opened, 1, J1);
        const graph = raidGraph([[K2, J1]]);
        const sw = { on: true };
        const env = H.boot(opened, { cfg, stationSystems: [L1, K2], extra: { getWormholes: () => ({
          isSynced: () => true, getStatus: () => ({}) }), getGraph: () => (sw.on ? { ok: true, graph }
          : { ok: false, reason: "NOT_READY" }) } });
        env.vc.identities.set(1, H.linked(5, 98000001));
        H.pass(env);
        const v0 = openVenture(opened, 1);
        assert.deepStrictEqual([v0.kind, v0.state, v0.target_system_id, v0.sec_band], ["WH_RAID", "TRAVEL", K2,
          "lowsec"]);
        const isk0 = H.all(opened, "SELECT isk, isk_earned FROM world_free_corps WHERE corp_id = 1")[0];
        env.clock.set(T0 + stepMs);
        H.pass(env);
        const v1 = openVenture(opened, 1);
        assert.deepStrictEqual([v1.state, v1.system_id, v1.step], ["WORKING", K2, 1]);
        sw.on = false;
        env.clock.set(T0 + 2 * stepMs);
        const st = H.pass(env);
        assert.strictEqual(openVenture(opened, 1).version, v1.version, "no write without a graph");
        assert.ok(st.counters.whSyncWait >= 1, JSON.stringify(st.counters.whSyncWait));
        sw.on = true;
        let at = T0 + 2 * stepMs;
        let v = openVenture(opened, 1);
        for (let i = 0; i < 20 && v.open === 1; i += 1) {
          env.clock.set(at);
          if (v.state === "RETURNING" && v.step + 1 >= v.steps_total) {
            armed.on = true;
            assert.strictEqual(env.fc.runPassNow().ok, false, "the injected fault at raidDone rolls back");
          }
          H.pass(env);
          at += stepMs;
          v = openVenture(opened, 1);
        }
        assert.strictEqual(armed.hits, 1);
        assert.deepStrictEqual([v.state, v.system_id, v.end_reason], ["DONE", J1, null]);
        assert.ok(v.yield_isk > 0);
        const isk1 = H.all(opened, "SELECT isk, isk_earned FROM world_free_corps WHERE corp_id = 1")[0];
        assert.strictEqual(isk1.isk - isk0.isk, v.yield_isk, "paid exactly once");
        assert.strictEqual(isk1.isk_earned - isk0.isk_earned, v.yield_isk);
        assert.strictEqual(homeOf(opened, 1).raid_done, 1);
        env.fc.stop();
      });
    } finally {
      whCorpModule.createFreeCorpWhCorpRepository = real;
    }
    const row = raidRow();
    const gone = W.advanceWhCorpVenture(corpR, row, homeR, envR({ wh: whP({ isLinked: () => false }) }), S3());
    assert.deepStrictEqual([gone.venture.state, gone.venture.end_reason, gone.venture.system_id, gone.closed,
      gone.whPatch], ["ABORTED", "WH_GONE", J1, null, null]);
    assert.ok(gone.tallies.includes("whRaidGone"));
    const work = { ...row, state: "WORKING", step: 1, system_id: A1, yield_isk: 777 };
    const off = W.advanceWhCorpVenture(corpR, work, homeR, envR({ raid: null }), S3());
    assert.deepStrictEqual([off.venture.state, off.venture.end_reason, off.venture.system_id, off.whPatch,
      off.corpDelta.isk, off.corpDelta.iskEarned], ["DONE", "WH_OFFLINE", J1, { op: "raidDone" }, 777, 777]);
    const lossy = S3({ riskPermille: 5000 }, { ventures: { ...P3.ventures, loss: { highsecPermille: 1000,
      lowsecPermille: 1000, nullsecPermille: 1000 } } });
    const none = whP({ isLinked: () => false, findExit: () => ({ ok: false, reason: "NO_EXIT" }) });
    let r = W.advanceWhCorpVenture(corpR, { ...work, state: "RETURNING", step: 5, steps_total: 6 }, homeR,
      envR({ wh: none }), lossy);
    assert.deepStrictEqual([r.venture.state, r.venture.system_id], ["STRANDED", A1]);
    let calls = 0;
    while (r.venture.open === 1 && calls < 100) {
      calls += 1;
      r = W.advanceWhCorpVenture(corpR, r.venture, homeR, envR({ now: T0 + calls * 1000, wh: none }), lossy);
      assert.notStrictEqual(r.closed, "LOST");
    }
    assert.strictEqual(calls, P3.whCorps.raid.outsideMaxSteps);
    assert.deepStrictEqual([r.venture.state, r.venture.end_reason, r.whPatch, r.corpDelta.isk],
      ["DONE", "WH_LONG_WAY", { op: "raidDone" }, 777]);
    assert.ok(r.tallies.includes("whRaidLongWay"));
    withStore(driver, (opened) => {
      const env = haulScene(opened);
      const hStep = P2.ventures.stepMs;
      for (let i = 0; i < 3; i += 1) {
        env.clock.set(T0 + i * hStep);
        H.pass(env);
      }
      assert.strictEqual(openVenture(opened, 1).state, "WORKING");
      const j = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 16384, maxRows: 500 });
      const pre = opened.store.transaction("t.j", (db) => j.applyOnce(db, { key: "lne:fc:whsale:1:2",
        aggregate: { type: "free_corp", id: 1 }, eventType: "FREE_CORP_WH_SOLD", payload: { pre: true } },
      () => ({ ok: true })));
      assert.ok(pre.ok && pre.value.ok, JSON.stringify(pre));
      const isk0 = H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk;
      env.clock.set(T0 + 3 * hStep);
      const failed = env.fc.runPassNow();
      assert.strictEqual(failed.ok, false, "a duplicate whsale key rolls the pass back");
      assert.ok(/JOURNAL_DUPLICATE/.test(JSON.stringify(env.fc.getStatus().lastError)),
        JSON.stringify(env.fc.getStatus().lastError));
      assert.strictEqual(H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk, isk0);
      assert.strictEqual(openVenture(opened, 1).state, "WORKING");
      env.fc.stop();
    });
  });

  test("WC15 raid config: 12 defaults, parseRaidBands, W283 (a) and (b)", () => {
    const resolve = (e) => config.resolveConfig({ modDir: MOD_DIR, env: e });
    const def = resolve({});
    assert.deepStrictEqual(def.config.freeCorps.whCorps.raid, { enabled: false, planPermille: 300, maxPlansPerPass: 1,
      maxJumps: 3, maxBfsSystems: 60, maxAreaBuildsPerPass: 8, areaMemoMax: 128, bands: "lowsec,nullsec",
      observedWeight: 5, riskPermille: 1200, yieldIskPerStepPerPilot: 6000000, outsideMaxSteps: 12 });
    assert.deepStrictEqual(FCS.parseRaidBands(" lowsec, nullsec"), ["lowsec", "nullsec"]);
    for (const bad of ["lowsec,lowsec", "wormhole", "", "lowsec,", null]) {
      assert.strictEqual(FCS.parseRaidBands(bad), null, String(bad));
    }
    const badBands = resolve({ EVEJS_LNE_FREE_CORPS_WH_CORPS_RAID_BANDS: "wormhole" });
    assert.strictEqual(badBands.config.freeCorps.whCorps.raid.bands, "lowsec,nullsec", "the check keeps the default");
    assert.ok(badBands.warnings.some((w) => /RAID_BANDS="wormhole" is not 1\.\.3 distinct bands/.test(w)),
      badBands.warnings.join("|"));
    const a = resolve({ EVEJS_LNE_FREE_CORPS_WH_CORPS_RAID_ENABLED: "1" });
    assert.ok(a.warnings.some((w) => /no effect \(W283\)$/.test(w)), a.warnings.join("|"));
    const on = { EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_WORMHOLES_ENABLED: "1", EVEJS_LNE_FREE_CORPS_WH_CORPS_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_WH_CORPS_RAID_ENABLED: "1" };
    const b = resolve(on);
    assert.ok(b.warnings.some((w) => /no names in Local \(W283\)$/.test(w)), b.warnings.join("|"));
    assert.ok(!b.warnings.some((w) => /no effect \(W283\)$/.test(w)), b.warnings.join("|"));
    assert.ok(!def.warnings.some((w) => /\(W283\)$/.test(w)));
  });

  const ctS = (o = {}) => ({ ...P2.contracts, enabled: true, issueChancePermille: 1000, ...o });
  const GAS_IDS = WH_GAS_TYPES.map((g) => g.typeId);
  const gasIn = (o = {}) => ({ corp: { corp_id: 1, seed: 4242 }, venture: { venture_id: "fcv:1:2", seq: 2,
    kind: "WH_HAUL", target_system_id: HUB }, identity: H.linked(5, 98000001), goods: GOODS_GAS.goods,
  known: new Set(GAS_IDS), S: ctS(), WS: { gasSharePermille: 300 }, gasIsk: 100000000, stationId: 60000042, now: T0,
  ...o });

  test("WC16 planGasContract: deterministic, Gc = min(lotMaxIsk, floor(G x share / 1000)) in BigInt, refusals "
    + "NOT_ELIGIBLE / NO_IDENTITY / NO_FACTS / CHANCE / NO_GOODS / SMALL_LOT, the row; haulSaleOf with Gc; entryOf GAS",
  () => {
    assert.ok(GOODS_GAS.ok, JSON.stringify(GOODS_GAS));
    const a = CT.planGasContract(gasIn());
    assert.deepStrictEqual(CT.planGasContract(gasIn()), a, "the same seed = the same plan");
    assert.ok(a.ok, JSON.stringify(a));
    assert.strictEqual(a.gasIsk, 10000000, "capped at contracts.lotMaxIsk");
    const r = a.row;
    assert.deepStrictEqual([r.contract_key, r.outbox_key, r.venture_id, r.kind, r.goods, r.state, r.open, r.station_id,
      r.system_id, r.lot_isk, r.issuer_character_id, r.issuer_corporation_id, r.quantity, r.price_isk],
    ["fcc:1:2", "lne:fc:ct:fcv:1:2", "fcv:1:2", "WTS", "GAS", "PLANNED", 1, 60000042, HUB, a.gasIsk, 98000002, 98000001,
      null, null]);
    assert.ok(GAS_IDS.includes(r.type_id));
    assert.deepStrictEqual(a.outbox, { key: "lne:fc:ct:fcv:1:2", kind: "CONTRACT_WTS",
      payload: { v: 1, contractKey: "fcc:1:2" } });
    assert.strictEqual(CT.planGasContract(gasIn({ S: ctS({ lotMaxIsk: 1000000000 }) })).gasIsk, 30000000);
    const MAX = Number.MAX_SAFE_INTEGER;
    const big = CT.planGasContract(gasIn({ gasIsk: MAX, S: ctS({ lotMaxIsk: MAX }) }));
    assert.strictEqual(big.gasIsk, Number((BigInt(MAX) * 300n) / 1000n), "BigInt past 2^53 / 1000");
    assert.strictEqual(CT.planGasContract(gasIn({ gasIsk: MAX })).gasIsk, 10000000);
    const refusal = (o) => CT.planGasContract(gasIn(o)).reason;
    assert.strictEqual(refusal({ venture: { ...gasIn().venture, kind: "MINE" } }), "NOT_ELIGIBLE");
    assert.strictEqual(refusal({ identity: { ok: true, state: "PENDING" } }), "NO_IDENTITY");
    assert.strictEqual(refusal({ known: null }), "NO_FACTS");
    assert.strictEqual(refusal({ S: ctS({ issueChancePermille: 0 }) }), "CHANCE");
    assert.strictEqual(refusal({ known: new Set([34]) }), "NO_GOODS");
    assert.strictEqual(refusal({ goods: GOODS_BASE.goods }), "NO_GOODS");
    assert.strictEqual(refusal({ gasIsk: 1000000 }), "SMALL_LOT", "300000 < lotMinIsk 500000");
    const only = CT.planGasContract(gasIn({ known: new Set([30377]) }));
    assert.strictEqual(only.row.type_id, 30377);
    const HL = P2.whCorps.haul;
    const home = { cargo_loot_isk: 250000000, cargo_gas_isk: 100000000 };
    assert.strictEqual(W.haulSaleOf(home, HL, true, 0), W.haulSaleOf(home, HL, true));
    assert.strictEqual(W.haulSaleOf(home, HL, true, 10000000), 250000000 + Math.floor(90000000 * 900 / 1000));
    assert.strictEqual(W.haulSaleOf(home, HL, false, 10000000), W.haulSaleOf(home, HL, false));
    assert.strictEqual(W.haulSaleOf(home, HL, true, 999999999999), 250000000);
    assert.deepStrictEqual(CT.entryOf(GOODS_GAS.goods, "GAS", 30372), { typeId: 30372, weight: 150,
      unitPriceMilli: 700000 });
    assert.strictEqual(CT.entryOf(GOODS_BASE.goods, "GAS", 30372), null);
    assert.strictEqual(CT.entryOf(GOODS_GAS.goods, "ORE", 30372), null);
  });

  test("WC17 the sale step with env.whContract: ok -> the buy cut by Gc, sale.contractGasIsk / contractKey; refusal = "
    + "the step without env.whContract (bit for bit); staging / no gas -> not asked; gasIsk > G ignored", () => {
    const p = W.planWhCorpVenture(corpP, homeP, envP(), P2);
    const working = { ...p.row, state: "WORKING", step: 3, system_id: HUB };
    const calls = [];
    const offer = (res) => (venture, wh) => {
      calls.push([venture.venture_id, wh.cargo_gas_isk]);
      return res;
    };
    const step = (v, e) => W.advanceWhCorpVenture({ ...corpP, venture_seq: 2 }, v, loadedP, { ...envP(), ...e }, P2);
    const base = step(working, {});
    assert.strictEqual(base.sale.isk, 250000000 + 90000000);
    const ok = step(working, { whContract: offer({ ok: true, gasIsk: 10000000, contractKey: "fcc:1:2" }) });
    const isk = 250000000 + Math.floor(90000000 * 900 / 1000);
    assert.deepStrictEqual(calls, [["fcv:1:2", 100000000]]);
    assert.deepStrictEqual([ok.sale.isk, ok.sale.contractGasIsk, ok.sale.contractKey, ok.whPatch, ok.corpDelta.isk,
      ok.corpDelta.iskEarned, ok.venture.yield_isk], [isk, 10000000, "fcc:1:2", { op: "sell", seq: 2, sale: isk }, isk,
      isk, isk]);
    const refused = step(working, { whContract: offer({ ok: false, reason: "whContractSkipChance" }) });
    assert.deepStrictEqual(refused, base, "a refusal = bit for bit");
    assert.deepStrictEqual(step(working, { whContract: offer({ ok: true, gasIsk: 100000001, contractKey: "x" }) }),
      base, "gasIsk above the cargo gas is ignored");
    calls.length = 0;
    const staging = { ...working, target_system_id: L1, system_id: L1 };
    step(staging, { whContract: offer({ ok: true, gasIsk: 1, contractKey: "x" }) });
    W.advanceWhCorpVenture({ ...corpP, venture_seq: 2 }, working, { ...loadedP, cargo_gas_isk: 0 },
      { ...envP(), whContract: offer({ ok: true, gasIsk: 1, contractKey: "x" }) }, P2);
    assert.deepStrictEqual(calls, [], "staging / no gas: the offer is not asked");
  });

  function gasScene(opened, { stations, second = false }) {
    const cfg0 = cfgOf({ wc: { haul: { enabled: true }, contracts: { enabled: true } }, wormholes: {} });
    const cfg = { ...cfg0, freeCorps: { ...cfg0.freeCorps, contracts: ctS() } };
    H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
    insertHome(opened, 1, J1);
    H.exec(opened, "UPDATE world_free_corp_wh_homes SET loot_isk = 250000000, gas_isk = 100000000 WHERE corp_id = 1");
    if (second) {
      H.seedCorp(opened, { corpId: 2, archetype: "explorer", seed: 777, nextAt: T0 + 3 * cfg.freeCorps.ventures.stepMs });
      insertHome(opened, 2, J2);
      H.exec(opened, "UPDATE world_free_corp_wh_homes SET cargo_loot_isk = 7, cargo_gas_isk = 3, cargo_venture_seq = 5 "
        + "WHERE corp_id = 2");
    }
    const graph = haulGraph([[K2, J1]]);
    const env = H.boot(opened, { cfg, extra: { getWormholes: () => ({ isSynced: () => true, getStatus: () => ({}) }),
      getGraph: () => ({ ok: true, graph }), contractGoods: () => GOODS_GAS, contractAdapter: () => null,
      freeCorpsContractSeams: () => ({ ok: true }), addContractAcceptedListener: () => ({ ok: false, reason: "TEST" }),
      listStations: (id) => ({ ok: true, stations: id === HUB ? stations : [L1, K2].includes(id)
        ? [{ stationId: 60000000 + (id % 100), corporationId: 1000100 }] : [] }) } });
    env.vc.identities.set(1, H.linked(5, 98000001));
    if (second) env.vc.identities.set(2, H.linked(5, 98000002));
    return env;
  }

  needsDriver("WC18 pass with the store: one GAS contract at the smallest hub station + one CONTRACT_WTS outbox in the "
    + "savepoint of the sale, treasury + the cut buy, journal contractGasIsk; rollback -> once; DONE -> "
    + "ctSkipNotEligible; no station -> the full buy of (whContractSkipNoStation)", () => {
    const stepMs = P2.ventures.stepMs;
    const realPump = contractPumpModule.createContractPump;
    contractPumpModule.createContractPump = (d) => ({ ...realPump(d), gasTypesKnown: () => new Set(GAS_IDS) });
    const armed = { on: false, hits: 0 };
    const realRepo = whCorpModule.createFreeCorpWhCorpRepository;
    whCorpModule.createFreeCorpWhCorpRepository = () => {
      const repo = realRepo();
      return Object.freeze({ ...repo, updateInTx: (tx, a) => {
        if (armed.on && a && a.corpId === 2) {
          armed.on = false;
          armed.hits += 1;
          throw new Error("injected after the sale");
        }
        return repo.updateInTx(tx, a);
      } });
    };
    const toWorking = (opened, env) => {
      for (let i = 0; i < 3; i += 1) {
        env.clock.set(T0 + i * stepMs);
        H.pass(env);
      }
      assert.strictEqual(openVenture(opened, 1).state, "WORKING");
      return H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk;
    };
    const ctRows = (opened) => all(opened, "SELECT * FROM world_free_corp_contracts ORDER BY contract_key");
    try {
      withStore(driver, (opened) => {
        const env = gasScene(opened, { second: true, stations: [{ stationId: 60000099, corporationId: 1000100 },
          { stationId: 60000050, corporationId: 1000100 }] });
        const isk0 = toWorking(opened, env);
        env.clock.set(T0 + 3 * stepMs);
        armed.on = true;
        assert.strictEqual(env.fc.runPassNow().ok, false, "the injected fault after the sale rolls the pass back");
        assert.strictEqual(armed.hits, 1);
        assert.strictEqual(ctRows(opened).length, 0, "no contract after the rollback");
        const st = H.pass(env);
        const sale = 250000000 + Math.floor(90000000 * 900 / 1000);
        assert.strictEqual(H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk - isk0, sale,
          "the cut buy paid exactly once");
        const c = ctRows(opened);
        assert.deepStrictEqual(c.map((x) => [x.contract_key, x.goods, x.state, x.station_id, x.system_id, x.lot_isk,
          x.venture_id]), [["fcc:1:2", "GAS", "PLANNED", 60000050, HUB, 10000000, "fcv:1:2"]]);
        const ob = all(opened, "SELECT key, kind FROM world_free_corp_outbox");
        assert.deepStrictEqual(ob.map((x) => [x.key, x.kind]), [["lne:fc:ct:fcv:1:2", "CONTRACT_WTS"]]);
        const j = all(opened, "SELECT payload FROM world_event_journal WHERE idempotency_key = 'lne:fc:whsale:1:2'");
        const pl = JSON.parse(j[0].payload);
        assert.deepStrictEqual([pl.saleIsk, pl.contractGasIsk, pl.contractKey], [sale, 10000000, "fcc:1:2"]);
        assert.strictEqual(st.counters.whContractPlanned, 1);
        assert.strictEqual(homeOf(opened, 1).sold_isk_total, sale);
        let last = null;
        for (let i = 4; i < 6; i += 1) {
          env.clock.set(T0 + i * stepMs);
          last = H.pass(env);
        }
        assert.strictEqual(openVenture(opened, 1).state, "DONE");
        assert.ok(last.counters.ctSkipNotEligible >= 1, JSON.stringify(last.counters));
        assert.strictEqual(ctRows(opened).length, 1, "no second contract at DONE");
        env.fc.stop();
      });
      withStore(driver, (opened) => {
        const env = gasScene(opened, { stations: [] });
        const isk0 = toWorking(opened, env);
        env.clock.set(T0 + 3 * stepMs);
        const st = H.pass(env);
        assert.strictEqual(H.all(opened, "SELECT isk FROM world_free_corps WHERE corp_id = 1")[0].isk - isk0,
          250000000 + 90000000);
        assert.strictEqual(ctRows(opened).length, 0);
        assert.strictEqual(st.counters.whContractSkipNoStation, 1);
        const j = all(opened, "SELECT payload FROM world_event_journal WHERE idempotency_key = 'lne:fc:whsale:1:2'");
        assert.deepStrictEqual(Object.keys(JSON.parse(j[0].payload)).sort(), ["corpId", "gasIsk", "hubSystemId",
          "lootIsk", "saleIsk", "seq", "staging"], "the payload of");
        env.fc.stop();
      });
    } finally {
      contractPumpModule.createContractPump = realPump;
      whCorpModule.createFreeCorpWhCorpRepository = realRepo;
    }
  });

  needsDriver("WC19 catalogue without gasTypes =; with them gas / gasTypeIds, typeIds unchanged; the pump: one gas "
    + "type without facts -> gasTypesKnown without it, ctGasFactsMissing 1, the GAS claim by unit price; config, W285",
  async () => {
    assert.deepStrictEqual(Object.keys(GOODS_BASE.goods), ["ores", "minerals", "hulls", "factionRace", "typeIds"]);
    const { gas, gasTypeIds, ...rest } = GOODS_GAS.goods;
    assert.deepStrictEqual(rest, GOODS_BASE.goods, "the part unchanged");
    assert.deepStrictEqual([gas.length, gasTypeIds], [9, GAS_IDS]);
    assert.ok(!GOODS_BASE.goods.typeIds.some((id) => GAS_IDS.includes(id)), "typeIds without the gas");
    const bad = buildContractGoods({ ...GOODS_DATA, gasTypes: [{ typeId: 0, weight: 1, unitPriceMilli: 1 },
      { typeId: 30370, weight: 0, unitPriceMilli: 1 }] });
    assert.deepStrictEqual(bad, GOODS_BASE, "bad gas rows only = the catalogue of");
    await withStoreAsync(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "explorer" });
      const S9 = ctS();
      const p = CT.planGasContract(gasIn({ known: new Set([30372]), S: S9 }));
      assert.ok(p.ok, JSON.stringify(p));
      const repo = contractModule.createFreeCorpContractRepository();
      const ob = outboxModule.createFreeCorpOutboxRepository();
      const w = opened.store.transaction("t.ct", (db) => {
        const ins = repo.insertPlannedInTx(db, p.row);
        if (!ins.ok) return ins;
        return ob.enqueueInTx(db, { key: p.outbox.key, kind: p.outbox.kind, payload: p.outbox.payload, now: T0 });
      });
      assert.ok(w.ok && w.value.ok, JSON.stringify(w));
      const reads = [];
      const adapter = {
        readItemTypeFacts: (ids) => {
          reads.push(ids.slice());
          const missing = ids.filter((id) => id === 30375);
          return { ok: true, missing, facts: new Map(ids.filter((id) => id !== 30375).map((id) => [id,
            { typeId: id, name: `Type ${id}`, volume: 1, portionSize: 1 }])) };
        },
        tradeGrantStock: () => ({ ok: false, reason: "TEST" }),
      };
      const counters = {};
      const pump = contractPumpModule.createContractPump({ store: opened.store, outbox: ob, contracts: repo,
        corps: createFreeCorpRepository(), clock: createManualClock(T0 + 1000), nowMs: () => 0, adapter: () => adapter,
        seams: () => ({ ok: true }), goods: () => GOODS_GAS.goods, getGovernor: () => null, workClass: "MAINTENANCE",
        isRunning: () => true, bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; },
        metric: () => {}, log: () => {}, setTimer: () => ({ cancel() {}, hasRef: () => false }), S: S9,
        retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 }, mode: "RUN" });
      assert.strictEqual(pump.gasTypesKnown(), null, "not read yet");
      return pump.runNow().then(() => {
        assert.deepStrictEqual(reads, [GOODS_GAS.goods.typeIds, GAS_IDS], "required first, then the gas");
        assert.deepStrictEqual([...pump.gasTypesKnown()].sort((x, y) => x - y), GAS_IDS.filter((id) => id !== 30375));
        assert.strictEqual(counters.ctGasFactsMissing, 1);
        assert.strictEqual(counters.ctFactsMissing, undefined, "the required facts are not blocked by the gas");
        const row = H.all(opened, "SELECT * FROM world_free_corp_contracts")[0];
        assert.deepStrictEqual([row.state, row.quantity], ["ISSUING", Math.floor(p.row.lot_isk * 1000 / 700000)],
          "the GAS claim by unit price");
        return pump.runNow();
      }).then(() => {
        assert.strictEqual(reads.length, 2, "the facts are read once per process");
        pump.stop();
      });
    });
    const resolve = (e) => config.resolveConfig({ modDir: MOD_DIR, env: e });
    const def = resolve({});
    assert.deepStrictEqual(def.config.freeCorps.whCorps.contracts, { enabled: false, gasSharePermille: 300 });
    assert.ok(!def.warnings.some((w) => /\(W285\)$/.test(w)));
    const on = { EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_WORMHOLES_ENABLED: "1", EVEJS_LNE_FREE_CORPS_WH_CORPS_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_WH_CORPS_HAUL_ENABLED: "1", EVEJS_LNE_FREE_CORPS_CONTRACTS_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_WH_CORPS_CONTRACTS_ENABLED: "1" };
    const w285 = (e) => resolve(e).warnings.some((w) => /no effect \(W285\)$/.test(w));
    assert.strictEqual(w285(on), false, "all flags on = no W285");
    assert.strictEqual(w285({ ...on, EVEJS_LNE_FREE_CORPS_CONTRACTS_ENABLED: "0" }), true, "without the contracts");
    assert.strictEqual(w285({ ...on, EVEJS_LNE_FREE_CORPS_WH_CORPS_HAUL_ENABLED: "0" }), true, "without the haul");
  });

  const J3 = 31000003;
  const whViewScene = (opened, { only = null } = {}) => {
    const ids = only || [1, 2, 3];
    for (const id of ids) H.seedCorp(opened, { corpId: id, archetype: "explorer", seed: 100 + id });
    insertHome(opened, 1, J1);
    H.exec(opened, "UPDATE world_free_corp_wh_homes SET loot_isk = 100, gas_isk = 20, cargo_loot_isk = 7, "
      + "cargo_gas_isk = 3, cargo_venture_seq = 4, pi_isk_total = 50, sold_isk_total = 900, home_done = 2, haul_done = 1 "
      + "WHERE corp_id = 1");
    if (!ids.includes(2)) return;
    insertHome(opened, 2, J2);
    insertHome(opened, 3, J3);
    H.exec(opened, "UPDATE world_free_corp_wh_homes SET loot_isk = 30, gas_isk = 5, pi_isk_total = 10, home_done = 4, "
      + "raid_done = 3 WHERE corp_id = 2");
    H.exec(opened, "UPDATE world_free_corp_wh_homes SET loot_isk = 999, home_done = 9 WHERE corp_id = 3");
    const closed = opened.store.transaction("t.c", (db) => whCorpModule.createFreeCorpWhCorpRepository().closeInTx(db,
      { corpId: 3, expectedVersion: 1, reason: "CORP_CLOSED", now: T0 }));
    assert.ok(closed.ok && closed.value.ok, JSON.stringify(closed));
    const ins = (v) => {
      const r = run(opened, `INSERT INTO world_free_corp_ventures (${COLS.join(", ")}) VALUES (${COLS.map(() => "?")
        .join(", ")})`, ...COLS.map((c) => v[c]));
      assert.ok(r.ok, JSON.stringify(r));
    };
    ins(vrow(1, "WH_HAUL", { venture_id: "fcv:1:4", seq: 4, state: "TRAVEL", open: 1, ended_at: null, end_reason: null,
      home_system_id: J1, system_id: K2, target_system_id: HUB, step: 2, steps_total: 6, wh_route: JSON.stringify([J1, K2]),
      wh_entry_system_id: K2 }));
    ins(vrow(2, "WH_HOME", { venture_id: "fcv:2:1", home_system_id: J2, system_id: J2, target_system_id: J2,
      sec_band: "wormhole" }));
  };

  needsDriver("WC20 whRepo.listOpenForViewInTx / statsForViewInTx: open homes only, corp_id order, the open venture "
    + "(LEFT JOIN), no character id, truncated, TX_REQUIRED / INVALID_INPUT", () => {
    withStore(driver, (opened) => {
      whViewScene(opened);
      const repo = whCorpModule.createFreeCorpWhCorpRepository();
      const tx = (fn) => {
        const r = opened.store.transaction("t.wv", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const l = tx((db) => repo.listOpenForViewInTx(db, { limit: 10 }));
      assert.strictEqual(l.ok, true, JSON.stringify(l));
      assert.deepStrictEqual(l.rows.map((r) => r.corp_id), [1, 2], "C (closed) skipped");
      assert.strictEqual(l.truncated, false);
      const [a, b] = l.rows;
      assert.deepStrictEqual([a.v_kind, a.v_state, a.v_system_id, a.v_step, a.v_steps_total], ["WH_HAUL", "TRAVEL", K2,
        2, 6]);
      assert.deepStrictEqual([a.j_system_id, a.staging_system_id, a.cargo_loot_isk, a.cargo_gas_isk, a.cargo_venture_seq,
        a.name, a.ticker, a.isk], [J1, L1, 7, 3, 4, "Corp 1", "TC1", 500000000]);
      assert.deepStrictEqual([b.v_kind, b.v_state, b.v_system_id, b.v_step, b.v_steps_total, b.cargo_venture_seq],
        [null, null, null, null, null, null], "B: the closed venture is not joined");
      for (const k of Object.keys(a)) assert.ok(!/ceo|character/.test(k), k);
      const one = tx((db) => repo.listOpenForViewInTx(db, { limit: 1 }));
      assert.deepStrictEqual([one.rows.length, one.rows[0].corp_id, one.truncated], [1, 1, true]);
      assert.strictEqual(repo.listOpenForViewInTx(null, { limit: 1 }).reason, "TX_REQUIRED");
      assert.strictEqual(tx((db) => repo.listOpenForViewInTx(db, { limit: 0 })).reason, "INVALID_INPUT");
      assert.strictEqual(repo.statsForViewInTx(null).reason, "TX_REQUIRED");
      assert.deepStrictEqual(tx((db) => repo.statsForViewInTx(db)), { ok: true, open: 2, lootIsk: 130, gasIsk: 25,
        cargoIsk: 10, piIskTotal: 60, soldIskTotal: 900, homeDone: 6, haulDone: 1, raidDone: 3 });
    });
  });

  needsDriver("WC21 the whCorps section of free-corps: WH_ROW_KEYS, wh* counters, index.kjPairs, graph names; "
    + "whRepository null = no key and no read of the homes table; service rig off / on", () => {
    withStore(driver, (opened) => {
      whViewScene(opened);
      const graph = { getSystem: (id) => ({ [J1]: { name: "J-One" }, [K2]: { name: "K-Two" } }[id] || null) };
      const prepared = [];
      const RUNS = new Set(["all", "get", "run", "iterate"]);
      const bound = (t, p) => (typeof t[p] === "function" ? t[p].bind(t) : t[p]);
      const spyStmt = (sql, s) => new Proxy(s, { get: (t, p) => (RUNS.has(p) ? (...a) => {
        prepared.push(sql);
        return t[p](...a);
      } : bound(t, p)) });
      const store = { isOpen: () => opened.store.isOpen(),
        transaction: (name, fn) => opened.store.transaction(name, (db) => fn(new Proxy(db, { get: (t, p) =>
          (p === "prepare" ? (sql) => spyStmt(sql, t.prepare(sql)) : bound(t, p)) }))) };
      const deps = (o) => ({ store, repository: createFreeCorpRepository(),
        ventureRepository: createFreeCorpVentureRepository(), getGraph: () => graph,
        getStatus: () => ({ state: "running", counters: { whCorpsFounded: 2, ventureDone: 5 } }),
        getWriteVersion: () => 1, maxRows: 10, now: () => T0, ...o });
      const on = VIEW.buildFreeCorpsView(deps({ whRepository: whCorpModule.createFreeCorpWhCorpRepository(),
        whStatus: () => ({ mode: "LIVE", index: { key: "1:4", builtAt: T0, edges: 4, entries: 2, kjPairs: 3 } }),
        whSettings: Object.freeze({ target: 4, haul: true, raid: false, contracts: false }) })).getData({});
      assert.strictEqual(on.available, true, JSON.stringify(on));
      const w = on.whCorps;
      assert.deepStrictEqual([w.enabled, w.mode, w.target, w.open, w.truncated], [true, "LIVE", 4, 2, false]);
      assert.deepStrictEqual(w.flags, { haul: true, raid: false, contracts: false });
      assert.strictEqual(w.index.kjPairs, 3);
      assert.deepStrictEqual(w.counters, { whCorpsFounded: 2 }, "wh* only");
      assert.deepStrictEqual(w.totals, { lootIsk: 130, gasIsk: 25, cargoIsk: 10, piIskTotal: 60, soldIskTotal: 900,
        homeDone: 6, haulDone: 1, raidDone: 3 });
      assert.deepStrictEqual(w.rows.map((r) => Object.keys(r)), [VIEW.WH_ROW_KEYS, VIEW.WH_ROW_KEYS]);
      const [ra, rb] = w.rows;
      assert.deepStrictEqual([ra.corporation, ra.jSystem, ra.staging, ra.cargoIsk, ra.cargoSeq, ra.done, ra.venture],
        ["Corp 1 [TC1]", "J-One", String(L1), 10, 4, "2/1/0", "WH_HAUL TRAVEL @ K-Two 2/6"]);
      assert.deepStrictEqual([rb.jSystem, rb.cargoSeq, rb.venture, rb.done], [String(J2), "-", "-", "4/0/3"]);
      assert.ok(prepared.some((s) => s.includes("world_free_corp_wh_homes")), "the homes read with the flag on");

      prepared.length = 0;
      const off = VIEW.buildFreeCorpsView(deps({ whRepository: null,
        whStatus: () => { throw new Error("whStatus with the flag off"); } })).getData({});
      assert.strictEqual(off.available, true, JSON.stringify(off));
      assert.strictEqual("whCorps" in off, false, "no key");
      assert.ok(prepared.length > 0, "the panel did read");
      assert.deepStrictEqual(prepared.filter((s) => s.includes("world_free_corp_wh_homes")), [], "no homes read");
    });
    for (const enabled of [false, true]) {
      withStore(driver, (opened) => {
        whViewScene(opened, { only: [1] });
        const views = createViewRegistry();
        const env = H.boot(opened, { cfg: cfgOf({ wc: { enabled }, fc: { targetCorps: 2 } }), extra: { views } });
        const st = H.pass(env);
        const data = views.getView("free-corps").getData({});
        assert.strictEqual(data.available, true, JSON.stringify(data));
        if (enabled) {
          assert.strictEqual(data.whCorps.open, st.whCorps.open);
          assert.strictEqual(data.whCorps.open, 1);
          assert.strictEqual(data.whCorps.mode, null, "freeCorps.wormholes off");
          assert.strictEqual(data.whCorps.index, null);
        } else {
          assert.strictEqual("whCorps" in data, false, "flag off: no key");
          assert.strictEqual(st.whCorps, undefined);
        }
        env.fc.stop();
      });
    }
  });

  test("WC22 wormholeIndex.kjPairs: k <-> J in both orientations, not J <-> J / k <-> k / an excluded region; stats() "
    + "keys unchanged; the gauge freeCorps.whKjPairs only with whCorps on", () => {
    const KX = 30000099;
    const sys = new Map([[K1, "highsec"], [K2, "highsec"], [J1, "wormhole"], [J2, "wormhole"], [KX, "highsec"]]
      .map(([id, c]) => [id, { id, name: `S${id}`, secClass: c, regionId: id === KX ? 10000070 : 10000002 }]));
    const edges = [[K1, J1], [J2, K2], [J1, J2], [K1, K2], [KX, J1]];
    const graph = { getSystem: (id) => sys.get(id) || null,
      listWormholeEdges: () => edges.map(([a, b]) => ({ fromSystemId: a, toSystemId: b, expiresAt: 0 })),
      getWormholeVersion: () => 1, getRouteStats: () => ({ wormholeEdges: edges.length }),
      validateRoute: () => ({ ok: true }) };
    const idx = createWormholeIndex({ graph: () => graph, excluded: new Set([10000070]), bfs: () => new Map(),
      settings: { maxWhJumps: 4, maxBfsSystems: 100, maxExitCandidates: 4, maxReturnJumps: 10, indexRefreshMs: 1000 },
      nowMs: () => 0 });
    assert.strictEqual(idx.kjPairs(), 0, "before a build");
    assert.strictEqual(idx.refresh(T0).rebuilt, true);
    assert.strictEqual(idx.kjPairs(), 2);
    assert.deepStrictEqual(Object.keys(idx.stats()), ["key", "builtAt", "edges", "entries"]);
    if (!driver.ok) return;
    for (const wcOn of [true, false]) {
      withStore(driver, (opened) => {
        const gauges = [];
        const telemetry = { gauge: (name, value) => gauges.push([name, value]), observe() {}, count() {} };
        const g = whGraph([[K2, J1], [J2, K1]]);
        const env = H.boot(opened, { cfg: cfgOf({ wc: { enabled: wcOn }, wormholes: {} }), stationSystems: [K1, K2],
          extra: { telemetry, getWormholes: () => ({ isSynced: () => true, getStatus: () => ({}) }),
            getGraph: () => ({ ok: true, graph: g }) } });
        H.pass(env);
        assert.deepStrictEqual(gauges.filter(([n]) => n === "freeCorps.whKjPairs"),
          wcOn ? [["freeCorps.whKjPairs", 2]] : [], `whCorps ${wcOn}`);
        env.fc.stop();
      });
    }
  });
};
