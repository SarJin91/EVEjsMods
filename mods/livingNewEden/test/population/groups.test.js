"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { resolveConfig } = config;
const { settingsOf, STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { buildStandingTables, createStandings } = require("../../lib/population/standings");
const { REL } = require("../../lib/population/data/standingRules");
const { createPopulationService } = require("../../lib/population/service");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { loadDriver } = require("../notices/storeHelper");
const { findCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 4242;
const NOW = 1700000000000;
const FAR = NOW + 1e9;
const SYS = F.sid(3);
const SIZE = 6;
const PIRATE = 500019;
const FACTIONS = Object.freeze([{ factionId: 500001, kind: "empire", homeRegionIds: [10] },
  { factionId: 500004, kind: "empire", homeRegionIds: [] }, { factionId: PIRATE, kind: "pirate" },
  { factionId: 500006, kind: "police", homeRegionIds: [20] }]);
const KEYS = ["ENABLED", "MAX_SIZE", "MIN_MEMBERS", "ESCORT_MAX", "FORM_PERMILLE", "SCAN_PER_FORM", "MAX_FORMS_PER_PASS",
  "MAX_GROUPS", "MAX_LIFETIME_MS"].map((k) => `EVEJS_LNE_POPULATION_GROUPS_${k}`);

function memStore(db = { rows: new Map(), meta: null }) {
  const tx = { prepare(sql) {
    if (sql.includes("MAX(pilot_id)")) return { get: () => ({ m: db.rows.size > 0 ? Math.max(...db.rows.keys()) : null }) };
    if (sql.startsWith("SELECT rules_version")) return { get: () => db.meta || undefined };
    if (sql.startsWith("SELECT")) return { all: () => [...db.rows.values()].sort((a, b) => a.pilot_id - b.pilot_id) };
    if (sql.includes("INTO world_npc_population")) {
      return { run: (...v) => {
        db.meta = { rules_version: v[0], size: v[1], seeded_at: v[2], flushed_at: v[3] };
        return { changes: 1 };
      } };
    }
    if (sql.startsWith("INSERT")) {
      const cols = sql.slice(sql.indexOf("(") + 1, sql.indexOf(")")).split(",").map((c) => c.trim());
      return { run: (...v) => {
        if (sql.includes("OR IGNORE") && db.rows.has(v[0])) return { changes: 0 };
        db.rows.set(v[0], Object.fromEntries(cols.map((c, i) => [c, v[i]])));
        return { changes: 1 };
      } };
    }
    return { run: () => ({ changes: 0 }) };
  } };
  return { db, limits: { maxRowsPerTransaction: 500 }, labelTx() {},
    transaction: (_name, fn) => ({ ok: true, value: fn(tx) }) };
}

const row = (id, o) => ({ pilot_id: id, system_id: SYS, prev_id: 0, dest_id: 0, home_id: SYS, ship_type_id: 32880,
  archetype: ARCHETYPE.MINER, intent: INTENT.DOCK, state: STATE.DOCKED, seq: 1, since_at: NOW, due_at: FAR, flags: 0,
  corp_id: 0, group_id: 0, ...o });

function dbOf(seq) {
  const rows = new Map([[1, row(1, { seq, due_at: NOW })]]);
  for (let id = 2; id <= 5; id += 1) rows.set(id, row(id));
  rows.set(6, row(6, { system_id: F.sid(11), home_id: F.sid(11), archetype: ARCHETYPE.TRADER }));
  return { rows, meta: { rules_version: 1, size: SIZE, seeded_at: 1, flushed_at: 1 } };
}

function presenceOf(graph, live) {
  return { getVersion: () => 1, observedSystems: () => [...live],
    observedWithin(radius) {
      const map = new Map(live.map((id) => [id, 0]));
      let frontier = [...live];
      for (let d = 1; d <= radius; d += 1) {
        const next = [];
        for (const id of frontier) {
          for (const n of graph.getNeighbors(id) || []) {
            if (map.has(n)) continue;
            map.set(n, d);
            next.push(n);
          }
        }
        frontier = next;
      }
      return { ok: true, systems: [...map] };
    } };
}

function sources(control) {
  return {
    readControl: (ids) => ({ ok: true, systems: ids.filter((id) => control.has(id)).map((id) => ({ systemId: id,
      controllerFactionId: null, occupationState: "STABLE", occupierFactionId: null, ...control.get(id) })) }),
    readOpenBattleSystems: () => ({ ok: true, systemIds: [] }),
    readOpenEvents: () => ({ ok: true, events: [] }),
    richVeinSystems: () => new Set(),
    readWreckSystems: () => ({ ok: true, systemIds: [] }),
    readBelts: (ids) => ({ ok: true, counts: new Map(ids.map((id) => [id, 1])) }),
    pirateFactionIds: [PIRATE],
    hourCurvePermille: null,
  };
}

const groupsOn = (over) => ({ enabled: true, formPermille: 1000, minMembers: 2, maxSize: 3, escortMax: 2,
  scanPerForm: 32, maxFormsPerPass: 16, maxGroups: 500, maxLifetimeMs: 7200000, ...over });

async function service(settings, store, o = {}) {
  const graph = o.graph || F.fakeGraph();
  const clock = { t: NOW, now() { return this.t; } };
  const svc = createPopulationService({ store, worldSeed: o.worldSeed || SEED, clock, settings,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph }) }), listStations: F.listStations,
    buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0, ...(o.deps ? o.deps(graph) : {}) });
  assert.strictEqual(await svc.boot(), "running", JSON.stringify(svc.getStatus()));
  return { svc, graph };
}

const base = (over = {}) => ({ enabled: true, size: SIZE, maxEventsPerPass: 5000, maxPassMs: 50,
  maxRoutesPerPass: 100, ...over });

async function formed(over, o = {}) {
  for (let seq = 0; seq < 80; seq += 1) {
    const db = dbOf(seq);
    const { svc } = await service(F.settings(base(over)), memStore(db), o);
    svc.runPass(NOW);
    const g = svc.getStatus().groups;
    if (g.groups === 1 && svc.pilot(1).state === "TRAVEL") {
      const members = [2, 3, 4, 5].filter((id) => svc.pilot(id).groupId === 1);
      return { svc, db, seq, members };
    }
    svc.stop();
  }
  throw new Error("no seq forms a TRAVEL group");
}

const strip = (v) => {
  const { groupId: _g, ...rest } = v;
  return rest;
};

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) skip("GR5b migration 125 on 124", `no sqlite driver: ${driver.detail || driver.reason}`);

  test("GR1 forming + common jump: members without a queue entry, the hop moves them in one event", async () => {
    const { svc, seq, members } = await formed({ groups: groupsOn() });
    assert.ok(members.length >= 2 && members.length <= 3, JSON.stringify(members));
    const st = svc.getStatus();
    assert.deepStrictEqual([st.queue, st.groups.members, st.counters["groups.formed"]], [SIZE - members.length,
      members.length, 1]);
    assert.strictEqual(svc.pilot(1).groupId, 1);
    const off = (await service(F.settings(base({ groups: { enabled: false } })), memStore(dbOf(seq)))).svc;
    off.runPass(NOW);
    assert.deepStrictEqual(strip(svc.pilot(1)), off.pilot(1));
    for (const id of members) {
      const m = svc.pilot(id);
      const l = svc.pilot(1);
      assert.deepStrictEqual([m.systemId, m.state, m.destId, m.dueAt, m.seq, m.groupId], [l.systemId, l.state, l.destId,
        l.dueAt, 2, 1]);
    }
    const at = svc.pilot(1).dueAt;
    const r = svc.runPass(at);
    off.runPass(at);
    assert.deepStrictEqual(r, { ok: true, events: 1 });
    const l = svc.pilot(1);
    assert.notStrictEqual(l.systemId, SYS);
    assert.deepStrictEqual(strip(l), off.pilot(1));
    for (const id of members) {
      const m = svc.pilot(id);
      assert.deepStrictEqual([m.systemId, m.state, m.destId, m.dueAt, m.prevId, m.seq], [l.systemId, l.state, l.destId,
        l.dueAt, l.prevId, 3]);
    }
    assert.strictEqual(svc.getStatus().queue, SIZE - members.length);
    svc.stop();
    off.stop();
  });

  test("GR2 POD of the leader (LIVE KILLED) dissolves; a member is no LIVE candidate (GROUP_MEMBER); lifetime", async () => {
    const live = { near: { enabled: true, attractPermille: 0 }, live: { trafficEnabled: true } };
    const { svc, members } = await formed({ ...live, groups: groupsOn() }, { deps: (graph) => ({
      getPresence: () => presenceOf(graph, [SYS]), liveMaxOwned: 12 }) });
    const cands = svc.liveCandidatesIn(SYS, NOW - 60000, 10);
    assert.deepStrictEqual(cands.map((c) => c.pilotId), [1]);
    assert.strictEqual(svc.getStatus().counters["live.noRoute"], 0);
    assert.deepStrictEqual(svc.claimLive(members[0], SYS, NOW), { ok: false, reason: "GROUP_MEMBER" });
    const c = svc.claimLive(1, SYS, NOW);
    assert.ok(c.ok, JSON.stringify(c));
    assert.strictEqual(svc.getStatus().queue, SIZE - members.length - 1);
    const rel = svc.releaseLive(1, c.token, "KILLED", NOW + 1000);
    assert.deepStrictEqual([rel.applied, rel.state], [true, "POD"]);
    const st = svc.getStatus();
    assert.deepStrictEqual([st.queue, st.groups.groups, st.groups.members, st.groups.dissolvedBy.POD,
      st.counters["groups.dissolved"]], [SIZE, 0, 0, 1, 1]);
    for (const id of [1, ...members]) assert.ok(!("groupId" in svc.pilot(id)), String(id));
    svc.stop();

    const t = await formed({ groups: groupsOn({ maxLifetimeMs: 1 }) });
    t.svc.runPass(t.svc.pilot(1).dueAt);
    const s2 = t.svc.getStatus();
    assert.deepStrictEqual([s2.groups.groups, s2.groups.dissolvedBy.LIFETIME, s2.groups.dissolvedBy.END], [0, 1, 0]);
    assert.strictEqual(s2.queue, SIZE);
    t.svc.stop();
  });

  test("GR3 restart: the groups from group_id, no double queue entry; a moved member is an orphan", async () => {
    const S = F.settings(base({ groups: groupsOn() }));
    const { svc, db, members } = await formed({ groups: groupsOn() });
    svc.stop();
    assert.deepStrictEqual([1, ...members].map((id) => db.rows.get(id).group_id), [1, ...members].map(() => 1));
    const again = (await service(S, memStore(db))).svc;
    const st = again.getStatus();
    assert.deepStrictEqual([st.groups.groups, st.groups.members, st.queue, st.counters["groups.orphaned"]],
      [1, members.length, SIZE - members.length, 0]);
    for (const id of members) assert.strictEqual(again.pilot(id).groupId, 1);
    db.rows.get(members[0]).system_id = F.sid(6);
    const third = (await service(S, memStore(db))).svc;
    const s3 = third.getStatus();
    assert.deepStrictEqual([s3.counters["groups.orphaned"], s3.queue, s3.groups.members], [1,
      SIZE - members.length + 1, members.length - 1]);
    assert.ok(!("groupId" in third.pilot(members[0])));
    const off = (await service(F.settings(base()), memStore(db))).svc;
    assert.strictEqual(off.getStatus().queue, SIZE);
    assert.ok(!("groups" in off.getStatus()));
  });

  test("GR4: a TRAVEL lost from RAM to a hostile destination is refused before findRoute", async () => {
    const S = F.settings(base({ context: { enabled: true }, standings: { enabled: true }, size: 1 }));
    const T = F.table(S);
    const tables = buildStandingTables({ worldSeed: SEED, factions: FACTIONS, table: T, S });
    const s = createStandings({ tables, worldSeed: SEED, size: 5000, homeOf: () => F.sid(6),
      indexOf: (id) => T.indexOf.get(id) });
    let enemy = 0;
    for (let id = 1; id < 5000 && enemy === 0; id += 1) if (s.relationOf(s.profileOfPilot(id), PIRATE) === REL.HOSTILE) enemy = id;
    assert.ok(enemy > 0);
    const control = new Map([10, 11, 12].map((n) => [F.sid(n), { controllerFactionId: PIRATE }]));
    const db = { rows: new Map(), meta: { rules_version: 1, size: enemy, seeded_at: 1, flushed_at: 1 } };
    for (let id = 1; id <= enemy; id += 1) {
      const travel = id === enemy;
      db.rows.set(id, row(id, { system_id: travel ? F.sid(10) : F.sid(6), home_id: F.sid(6), archetype: ARCHETYPE.TRADER,
        dest_id: travel ? F.sid(12) : 0, intent: travel ? INTENT.TRAVEL : INTENT.DOCK,
        state: travel ? STATE.TRAVEL : STATE.DOCKED, seq: 3, due_at: travel ? NOW + 600000 : FAR }));
    }
    const { svc, graph } = await service(F.settings(base({ context: { enabled: true }, standings: { enabled: true },
      size: enemy })), memStore(db), { deps: () => ({ contextSources: sources(control), standingFactions: FACTIONS }) });
    for (let i = 0; i < 20 && svc.getStatus().counters.contextRefreshes === 0; i += 1) svc.runPass(NOW);
    assert.strictEqual(svc.getStatus().counters.contextRefreshes, 1);
    const calls = graph.routeCalls();
    svc.runPass(NOW + 600000);
    const c = svc.getStatus().counters;
    assert.deepStrictEqual([c["standing.routeRefused"], c.noRoute, graph.routeCalls() - calls], [1, 1, 0]);
    const p = svc.pilot(enemy);
    assert.ok(!(p.state === "TRAVEL" && p.destId === F.sid(12)), JSON.stringify(p));
    svc.stop();
  });

  test("GR5 flag off bit for bit, migration 125 on 124, config (9 keys, W255, W256), compose and .env.example",
    async () => {
      const { groups: _drop, ...population } = F.populationConfig(base({ size: 120, seedRowsPerSlice: 200,
        flushRowsPerSlice: 400, maxRoutesPerPass: 5000 }));
      const runs = [];
      for (const S of [settingsOf({ population }), F.settings(base({ size: 120, seedRowsPerSlice: 200,
        flushRowsPerSlice: 400, maxRoutesPerPass: 5000, groups: { enabled: false } }))]) {
        const store = memStore();
        const { svc } = await service(S, store);
        for (let i = 0; i < 40; i += 1) svc.runPass(NOW + i * 60000);
        const views = Array.from({ length: 120 }, (_, i) => svc.pilot(i + 1));
        assert.ok(!("groups" in svc.getStatus()));
        svc.stop();
        runs.push({ views, rows: [...store.db.rows.values()] });
      }
      assert.deepStrictEqual(runs[0], runs[1]);
      assert.ok(runs[0].rows.every((r) => r.group_id === 0));
      assert.ok(runs[0].views.some((v) => v.seq > 1), "the population moved");

      assert.strictEqual(MIGRATIONS[124].name, "population-groups");
      if (driver.ok) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m125-"));
        const file = path.join(tmp, "world.sqlite");
        const open = (migrations) => {
          const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
            busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
          assert.ok(o.ok, JSON.stringify(o));
          return o;
        };
        try {
          const old = open(MIGRATIONS.slice(0, 124));
          assert.strictEqual(old.schemaVersion, 124);
          const ins = old.store.transaction("t", (tx) => tx.prepare("INSERT INTO world_npc_pilots (pilot_id, system_id, "
            + "home_id, ship_type_id, archetype, intent, state, seq, since_at, due_at, corp_id) VALUES "
            + "(1, 5, 5, 601, 2, 1, 1, 3, 9, 9, 7)").run().changes);
          assert.deepStrictEqual([ins.ok, ins.value], [true, 1]);
          old.store.close("upgrade");
          const up = open(MIGRATIONS.slice(0, 125));
          assert.strictEqual(up.schemaVersion, 125);
          const rows = up.store.transaction("t", (tx) => tx.prepare("SELECT pilot_id, seq, corp_id, group_id FROM "
            + "world_npc_pilots").all().map((r) => [Number(r.pilot_id), Number(r.seq), Number(r.corp_id),
            Number(r.group_id)]));
          assert.deepStrictEqual(rows.value, [[1, 3, 7, 0]]);
          up.store.close("test_cleanup");
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        }
      }

      const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
      const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
      assert.deepStrictEqual(def.config.population.groups, { enabled: false, maxSize: 4, minMembers: 2, escortMax: 2,
        formPermille: 250, scanPerForm: 32, maxFormsPerPass: 16, maxGroups: 500, maxLifetimeMs: 7200000,
        liveSpawnEnabled: false, liveSpacingMeters: 500 });
      assert.strictEqual(config.SCHEMA.filter((r) => r.key.startsWith("population.groups.")).length, 11);
      assert.ok(!def.warnings.some((x) => /W25[56]/.test(x)));
      const on = { ...env0, EVEJS_LNE_POPULATION_GROUPS_ENABLED: "1" };
      const w1 = resolveConfig({ modDir: MOD_DIR, env: on }).warnings;
      assert.ok(w1.some((x) => /\(W255\)/.test(x)), w1.join(" | "));
      const w2 = resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_POPULATION_ENABLED: "1",
        EVEJS_LNE_POPULATION_GROUPS_MIN_MEMBERS: "8" } });
      assert.ok(!w2.warnings.some((x) => /W255/.test(x)), w2.warnings.join(" | "));
      assert.ok(w2.warnings.some((x) => /minMembers=8 above groups\.maxSize=4 .*\(W256\)/.test(x)),
        w2.warnings.join(" | "));
      assert.strictEqual(settingsOf(w2.config).groups.minMembers, 4);
      const modEnv = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
      const rootEnv = fs.readFileSync(path.join(MOD_DIR, "..", "..", ".env.example"), "utf8");
      assert.deepStrictEqual(KEYS.filter((k) => !modEnv.includes(`# ${k}=`) || !rootEnv.includes(`# ${k}=`)), []);
      const composeFile = findCompose();
      if (composeFile) {
        const text = fs.readFileSync(composeFile, "utf8");
        assert.deepStrictEqual(KEYS.filter((k) => !text.includes(`${k}: \${${k}:-${k.endsWith("_ENABLED") ? "0" : ""}}`)),
          []);
      }
    });
};

module.exports.rig = { memStore, service, presenceOf, row, base, groupsOn, formed, NOW, FAR, SYS, SEED };
