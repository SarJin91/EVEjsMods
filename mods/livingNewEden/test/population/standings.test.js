"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { resolveConfig } = config;
const { createRng, deriveSeed } = require("../../lib/util/rng");
const rules = require("../../lib/population/rules");
const { settingsOf, STATE, INTENT, ARCHETYPE } = require("../../lib/population/schema");
const { buildStandingTables, createStandings } = require("../../lib/population/standings");
const { REL } = require("../../lib/population/data/standingRules");
const { DANGER } = require("../../lib/population/data/contextWeights");
const { createWorldContext } = require("../../lib/population/worldContext");
const { createPopulationService } = require("../../lib/population/service");
const { buildPopulationPanel } = require("../../lib/population/view");
const { buildHubDistance } = require("../../lib/highsecLife/density");
const { populationStandingFactions } = require("../../lib/runtime/services");
const { findCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 4242;
const NOW = 1700000000000;
const AMARR = 500001;
const MINMATAR = 500004;
const PIRATE = 500019;
const FACTIONS = Object.freeze([{ factionId: AMARR, kind: "empire", homeRegionIds: [10] },
  { factionId: MINMATAR, kind: "empire", homeRegionIds: [] }, { factionId: PIRATE, kind: "pirate" },
  { factionId: 500006, kind: "police", homeRegionIds: [20] }]);
const ON = { context: { enabled: true }, standings: { enabled: true } };
const KEYS = ["ENABLED", "PROFILES", "FRIENDLY_MIN", "HOSTILE_MAX", "EMPIRE_BASE_MIN", "EMPIRE_BASE_MAX",
  "PIRATE_BASE_MIN", "PIRATE_BASE_MAX", "HOME_BONUS", "RIVAL_PENALTY", "PANEL_TOP_PROFILES"]
  .map((k) => `EVEJS_LNE_POPULATION_STANDINGS_${k}`);

function countingRng(seed) {
  const r = createRng(seed);
  const rng = { draws: 0, nextFloat() {
    rng.draws += 1;
    return r.nextFloat();
  } };
  return rng;
}

function sources(control = new Map(), battles = []) {
  return {
    readControl: (ids) => ({ ok: true, systems: ids.filter((id) => control.has(id)).map((id) => ({ systemId: id,
      controllerFactionId: null, occupationState: "STABLE", occupierFactionId: null, ...control.get(id) })) }),
    readOpenBattleSystems: () => ({ ok: true, systemIds: battles }),
    readOpenEvents: () => ({ ok: true, events: [] }),
    richVeinSystems: () => new Set(),
    readWreckSystems: () => ({ ok: true, systemIds: [] }),
    readBelts: (ids) => ({ ok: true, counts: new Map(ids.map((id) => [id, 1])) }),
    pirateFactionIds: [PIRATE, 500010],
    hourCurvePermille: null,
  };
}

function ctxView(S, T, tables, control, battles) {
  const wc = createWorldContext({ S, getTable: () => T, sources: sources(control, battles),
    ...(tables ? { standing: { getTables: () => tables } } : {}) });
  for (let i = 0; i < 50 && !wc.step(NOW).done; i += 1) {}
  return { wc, view: wc.view() };
}

function memStore(db = { rows: new Map(), meta: null }) {
  const COLS = ["pilot_id", "system_id", "prev_id", "dest_id", "home_id", "ship_type_id", "archetype", "intent", "state",
    "seq", "since_at", "due_at", "flags"];
  const labels = [];
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
      return { run: (...v) => {
        if (sql.includes("OR IGNORE") && db.rows.has(v[0])) return { changes: 0 };
        db.rows.set(v[0], Object.fromEntries(COLS.map((c, i) => [c, v[i]])));
        return { changes: 1 };
      } };
    }
    return { run: () => ({ changes: 0 }) };
  } };
  return { db, labels, limits: { maxRowsPerTransaction: 500 }, labelTx() {},
    transaction: (name, fn) => {
      labels.push(name);
      return { ok: true, value: fn(tx) };
    } };
}

async function service(settings, o = {}) {
  const clock = { t: NOW, now() { return this.t; } };
  let probe = null;
  const telemetry = { count() {}, observe() {}, gauge() {},
    registerMemoryProbe: (_name, fn) => {
      probe = fn;
      return { ok: true, unregister() {} };
    } };
  const store = o.store || memStore();
  const svc = createPopulationService({ store, worldSeed: o.worldSeed || 77, clock, settings, telemetry,
    getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: F.fakeGraph() }) }),
    listStations: F.listStations, buildHubDistance, yieldTurn: () => Promise.resolve(), nowMs: () => 0,
    contextSources: sources(o.control || new Map([[F.sid(8), { controllerFactionId: PIRATE }]])),
    ...(o.factions ? { standingFactions: o.factions } : {}) });
  assert.strictEqual(await svc.boot(), "running", JSON.stringify(svc.getStatus()));
  return { svc, clock, store, probe: () => probe() };
}

function findPilot(s, factionId, rel, from = 1) {
  for (let id = from; id < from + 5000; id += 1) if (s.relationOf(s.profileOfPilot(id), factionId) === rel) return id;
  throw new Error(`no pilot with relation ${rel} to ${factionId}`);
}

const rngOf = (id, seq) => createRng(deriveSeed(SEED, "pop", id, seq));

module.exports = ({ test }) => {
  const S_ON = F.settings(ON);
  const T = F.table(S_ON);
  const graph = F.fakeGraph();
  const route = (from, to) => graph.findRoute(from, to, { maxJumps: 12 });
  const tablesOf = (seed, S = S_ON) => buildStandingTables({ worldSeed: seed, factions: FACTIONS, table: T, S });
  const standingsOf = (tables, homeOf, extra = {}) => createStandings({ tables, worldSeed: SEED, size: 5000, homeOf,
    indexOf: (id) => T.indexOf.get(id), ...extra });

  test("ST1 standings off = the transitions of a config without the section; the service builds nothing", async () => {
    const { standings: _drop, ...population } = F.populationConfig({ context: { enabled: true } });
    const S_NONE = settingsOf({ population });
    const S_OFF = F.settings({ context: { enabled: true }, standings: { enabled: false } });
    assert.deepStrictEqual([S_NONE.standings.enabled, S_OFF.standings.enabled], [false, false]);
    const control = new Map([[F.sid(8), { controllerFactionId: PIRATE }], [F.sid(2), { controllerFactionId: MINMATAR }]]);
    const plain = ctxView(S_NONE, T, null, control).view;
    const extended = ctxView(S_OFF, T, tablesOf(SEED), control).view;
    const walk = (S, view) => {
      const trace = [];
      for (let id = 1; id <= 300; id += 1) {
        let p = rules.seedPilot(id, SEED, T, S, NOW).row;
        let now = NOW;
        for (let i = 0; i < 50; i += 1) {
          const rng = countingRng(deriveSeed(SEED, "pop", id, p.seq));
          const notes = [];
          const opts = { context: view, note: (n) => notes.push(n) };
          let next;
          if (p.state === STATE.TRAVEL) next = rules.dwellInPlace(p, T, S, rng, now, opts).next;
          else {
            const r = rules.rollIntent(p, T, S, rng, route, now, opts);
            next = r.ok ? r.next : rules.dwellInPlace(p, T, S, rng, now, opts).next;
          }
          trace.push([id, i, rng.draws, notes.join(","), JSON.stringify(next)]);
          p = { ...p, ...next, seq: p.seq + 1, sinceAt: now };
          now = Math.max(now + 1, p.dueAt);
        }
      }
      return trace;
    };
    const a = walk(S_NONE, plain);
    assert.strictEqual(a.length, 300 * 50);
    assert.deepStrictEqual(walk(S_OFF, plain), a);
    assert.deepStrictEqual(walk(S_OFF, extended), a);
    assert.ok(a.some((row) => row[3].includes("context.retreats")), "the trace crosses the pirate system");

    const base = { enabled: true, size: 300, context: { enabled: true } };
    const { standings: _d2, ...popNone } = F.populationConfig(base);
    const none = await service(settingsOf({ population: popNone }));
    const off = await service(F.settings({ ...base, standings: { enabled: false } }), { factions: FACTIONS });
    for (let k = 1; k <= 12; k += 1) {
      none.svc.runPass(NOW + k * 600000);
      off.svc.runPass(NOW + k * 600000);
    }
    const pilotsOf = (svc) => Array.from({ length: 300 }, (_, i) => svc.pilot(i + 1));
    assert.deepStrictEqual(pilotsOf(off.svc), pilotsOf(none.svc));
    assert.deepStrictEqual(off.svc.getStatus().counters, none.svc.getStatus().counters);
    assert.strictEqual(off.probe().approxBytes, none.probe().approxBytes, "no standing buffer, no table");
    assert.deepStrictEqual(off.svc.getStatus().standings, { enabled: false, active: false, profiles: 0, factions: 0 });
    assert.strictEqual(off.svc.standingCensus(), null);
    assert.strictEqual(off.svc.standings(), null);
    none.svc.stop();
    off.svc.stop();
  });

  test("ST2 determinism: same seed = same tables and profiles after a restart, no write; the API", async () => {
    const a = tablesOf(SEED);
    const b = tablesOf(SEED);
    assert.deepStrictEqual([a.F, a.G, a.K, a.P], [3, 2, 64, 128], "police skipped; races: none, Amarr");
    assert.deepStrictEqual(Buffer.from(a.standing.buffer), Buffer.from(b.standing.buffer));
    assert.deepStrictEqual(Buffer.from(a.rel.buffer), Buffer.from(b.rel.buffer));
    assert.notDeepStrictEqual(Buffer.from(tablesOf(SEED + 1).standing.buffer), Buffer.from(a.standing.buffer));

    const S = F.settings({ ...ON, enabled: true, size: 300 });
    const first = await service(S, { factions: FACTIONS });
    const p1 = Array.from({ length: 300 }, (_, i) => first.svc.standings().profileOfPilot(i + 1));
    first.svc.stop();
    const db = first.store.db;
    const rowsBefore = JSON.stringify([...db.rows.values()]);
    const second = await service(S, { factions: FACTIONS, store: memStore(db) });
    assert.strictEqual(second.svc.getStatus().counters.seeded, 0, "the second boot loads");
    assert.deepStrictEqual(Array.from({ length: 300 }, (_, i) => second.svc.standings().profileOfPilot(i + 1)), p1);
    assert.ok(new Set(p1.map((p) => p % a.G)).size === 2, "both race groups among the pilots");
    second.svc.stop();
    assert.strictEqual(JSON.stringify([...db.rows.values()]), rowsBefore, "no row changed by the standings");
    assert.deepStrictEqual([...new Set([...first.store.labels, ...second.store.labels])].sort(),
      ["population.load", "population.seed"]);

    const s = standingsOf(a, () => F.sid(1));
    const P = s.profileCount();
    for (let x = 0; x < P; x += 7) {
      assert.strictEqual(s.distance(x, x), 0);
      for (let y = 0; y < P; y += 13) {
        const d = s.distance(x, y);
        assert.ok(d >= 0 && d <= 200 && d === s.distance(y, x), `${x}/${y}: ${d}`);
      }
      for (const f of [AMARR, MINMATAR, PIRATE]) {
        const v = s.standingOf(x, f);
        assert.ok(v >= -100 && v <= 100);
      }
      assert.strictEqual(s.standingOf(x, 500006), 0, "a faction outside the list");
      assert.strictEqual(s.relationOf(x, 500006), REL.NEUTRAL);
    }
    const T2 = S_ON.standings;
    const clamp = (v) => Math.max(-100, Math.min(100, v));
    for (let k = 0; k < a.K; k += 1) {
      assert.strictEqual(s.standingOf(k * 2 + 1, AMARR), clamp(s.standingOf(k * 2, AMARR) + T2.homeBonus));
      assert.strictEqual(s.standingOf(k * 2 + 1, MINMATAR), clamp(s.standingOf(k * 2, MINMATAR) - T2.rivalPenalty));
      assert.strictEqual(s.standingOf(k * 2 + 1, PIRATE), s.standingOf(k * 2, PIRATE));
    }
    assert.strictEqual(s.profileOfPilot(9) % 2, 1, "home sid(1) = region 10 = Amarr race");
    assert.strictEqual(standingsOf(a, () => F.sid(8)).profileOfPilot(9) % 2, 0, "region 20 = no race");
    assert.strictEqual(standingsOf(a, () => 0).profileOfPilot(9) % 2, 0, "unknown home = group 0");
    const ov = new Map([[1, 5], [2, -1], [3, P + 3], [4, 1.5]]);
    const so = standingsOf(a, () => F.sid(1), { override: (id) => (ov.has(id) ? ov.get(id) : -1) });
    assert.deepStrictEqual([so.profileOf(1), so.profileOf(2), so.profileOf(3), so.profileOf(4)],
      [5, so.profileOfPilot(2), 3, so.profileOfPilot(4)]);
    assert.deepStrictEqual([s.standingOf(-1, AMARR), s.standingOf(P + 3, AMARR)], [0, s.standingOf(3, AMARR)]);
    assert.strictEqual(s.distance(-1, -1), 0);
  });

  test("ST3 a route through a pirate system: friend passes, enemy refused (dwell), home skipped, TRAVEL path", async () => {
    const tables = tablesOf(SEED);
    const control = new Map([[F.sid(8), { controllerFactionId: PIRATE }]]);
    const { view } = ctxView(S_ON, T, tables, control);
    const homes = new Map();
    const s = standingsOf(tables, (id) => homes.get(id) || F.sid(6));
    const friend = findPilot(s, PIRATE, REL.FRIENDLY);
    const enemy = findPilot(s, PIRATE, REL.HOSTILE);
    const homeEnemy = findPilot(standingsOf(tables, () => F.sid(8)), PIRATE, REL.HOSTILE, 6000);
    homes.set(homeEnemy, F.sid(8));
    const st = Object.freeze({ profileOf: s.profileOf, dangerForProfile: view.dangerForProfile,
      weightForProfile: view.weightForProfile, hostileOnRoute: view.hostileOnRoute });
    const via = (from) => ({ ok: true, route: [from, F.sid(7), F.sid(8), F.sid(9), F.sid(10), F.sid(11)] });
    const trips = (pilotId) => {
      const out = { ok: 0, refused: 0, notes: [] };
      for (let seq = 0; seq < 60; seq += 1) {
        const p = { pilotId, systemId: F.sid(6), prevId: 0, destId: 0, homeId: homes.get(pilotId) || F.sid(6),
          shipTypeId: 648, archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.ACTIVE, seq, sinceAt: NOW,
          dueAt: NOW, flags: 0 };
        let called = false;
        const r = rules.rollIntent(p, T, S_ON, rngOf(pilotId, seq), (f) => {
          called = true;
          return via(f);
        }, NOW, { context: view, standing: st, note: (n) => out.notes.push(n) });
        if (!called) continue;
        if (r.ok) out.ok += 1;
        else if (r.reason === "NO_ROUTE") out.refused += 1;
      }
      return out;
    };
    const f = trips(friend);
    assert.ok(f.ok > 5 && f.refused === 0, JSON.stringify(f));
    assert.strictEqual(f.notes.filter((n) => n === "standing.friendlyPass").length, f.ok);
    const e = trips(enemy);
    assert.ok(e.refused > 5 && e.ok === 0, JSON.stringify(e));
    assert.strictEqual(e.notes.filter((n) => n === "standing.routeRefused").length, e.refused);
    const h = trips(homeEnemy);
    assert.ok(h.ok > 5 && h.refused === 0, `home sid(8) skipped: ${JSON.stringify(h)}`);
    assert.ok(view.hostileOnRoute([F.sid(6), F.sid(7), F.sid(8)], s.profileOf(enemy), F.sid(6), {}) === 2);
    const deep = ctxView(S_ON, T, tables, new Map([8, 9, 10, 12].map((n) => [F.sid(n), { controllerFactionId: PIRATE }])))
      .view;
    const ep = s.profileOf(enemy);
    assert.deepStrictEqual([deep.hostileOnRoute(route(F.sid(10), F.sid(6)).route, ep, F.sid(6), {}),
      deep.hostileOnRoute(route(F.sid(10), F.sid(12)).route, ep, F.sid(6), {}),
      deep.hostileOnRoute(route(F.sid(11), F.sid(9)).route, ep, F.sid(6), {})], [-1, 2, 1]);
    const stDeep = Object.freeze({ ...st, dangerForProfile: deep.dangerForProfile, weightForProfile: deep.weightForProfile,
      hostileOnRoute: deep.hostileOnRoute });
    let homeOk = 0;
    for (let seq = 0; seq < 60; seq += 1) {
      const p = { pilotId: enemy, systemId: F.sid(10), prevId: 0, destId: 0, homeId: F.sid(6), shipTypeId: 648,
        archetype: ARCHETYPE.TRADER, intent: INTENT.DOCK, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
      const r = rules.rollIntent(p, T, S_ON, rngOf(enemy, seq), route, NOW, { context: deep, standing: stDeep });
      if (r.ok && r.next.destId === F.sid(6)) homeOk += 1;
    }
    assert.ok(homeOk > 5, `the way home from sid(10): ${homeOk}`);

    const size = Math.max(friend, enemy);
    const db = { rows: new Map(), meta: { rules_version: 1, size, seeded_at: 1, flushed_at: 1 } };
    for (let id = 1; id <= size; id += 1) {
      const travel = id === friend || id === enemy;
      db.rows.set(id, { pilot_id: id, system_id: F.sid(6), prev_id: 0, dest_id: travel ? F.sid(11) : 0,
        home_id: F.sid(6), ship_type_id: 648, archetype: ARCHETYPE.TRADER, intent: travel ? INTENT.TRAVEL : INTENT.DOCK,
        state: travel ? STATE.TRAVEL : STATE.DOCKED, seq: 3, since_at: NOW, due_at: travel ? NOW + 600000 : NOW + 1e9,
        flags: 0 });
    }
    const { svc } = await service(F.settings({ ...ON, enabled: true, size, maxRoutesPerPass: 100 }),
      { factions: FACTIONS, store: memStore(db), control, worldSeed: SEED });
    for (let i = 0; i < 20 && svc.getStatus().counters.contextRefreshes === 0; i += 1) svc.runPass(NOW);
    assert.strictEqual(svc.getStatus().counters.contextRefreshes, 1);
    svc.runPass(NOW + 600000);
    const c = svc.getStatus().counters;
    assert.deepStrictEqual([c["standing.routeRefused"], c["standing.friendlyPass"], c.noRoute], [1, 1, 1]);
    assert.deepStrictEqual([svc.pilot(friend).state, svc.pilot(friend).systemId], ["TRAVEL", F.sid(7)]);
    assert.deepStrictEqual([svc.pilot(enemy).state, svc.pilot(enemy).systemId], ["DOCKED", F.sid(6)]);
    assert.strictEqual(svc.getStatus().standings.active, true);
    svc.stop();
  });

  test("ST4 danger and retreat per pilot; a hostile station system weighs 0", () => {
    const tables = tablesOf(SEED);
    const control = new Map([[F.sid(8), { controllerFactionId: PIRATE }], [F.sid(2), { controllerFactionId: MINMATAR }]]);
    const { view } = ctxView(S_ON, T, tables, control);
    const battle = ctxView(S_ON, T, tables, control, [F.sid(8)]).view;
    const s = standingsOf(tables, () => F.sid(6));
    const prof = (rel, f = PIRATE) => s.profileOfPilot(findPilot(s, f, rel));
    const [friend, neutral, enemy] = [prof(REL.FRIENDLY), prof(REL.NEUTRAL), prof(REL.HOSTILE)];
    const d = (v, sys, p) => v.dangerForProfile(sys, p, F.sid(6));
    assert.deepStrictEqual([d(view, F.sid(8), friend), d(battle, F.sid(8), friend)], [0, DANGER.OPEN_BATTLE]);
    assert.deepStrictEqual([d(view, F.sid(8), neutral), view.dangerOf(F.sid(8))], [1000, 1000], "neutral =");
    const minEnemy = prof(REL.HOSTILE, MINMATAR);
    assert.deepStrictEqual([view.dangerOf(F.sid(2)), d(view, F.sid(2), minEnemy)], [0, DANGER.HOSTILE_CONTROLLER]);
    assert.strictEqual(view.dangerForProfile(F.sid(2), minEnemy, F.sid(2)), 0, "the home system is never hostile");
    const avoid = S_ON.context.dangerAvoidPermille;
    assert.deepStrictEqual([view.weightForProfile(F.sid(8), enemy, F.sid(6), avoid),
      view.weightForProfile(F.sid(8), friend, F.sid(6), avoid), view.weightForProfile(F.sid(8), neutral, F.sid(6), avoid)],
    [0, 1000, 1000 - avoid]);
    const st = Object.freeze({ profileOf: (id) => (id === 1 ? friend : enemy), dangerForProfile: view.dangerForProfile,
      weightForProfile: view.weightForProfile, hostileOnRoute: view.hostileOnRoute });
    const retreats = (pilotId) => {
      let n = 0;
      for (let seq = 0; seq < 200; seq += 1) {
        const p = { pilotId, systemId: F.sid(8), prevId: 0, destId: 0, homeId: F.sid(6), shipTypeId: 16240,
          archetype: ARCHETYPE.RATTER, intent: INTENT.RAT, state: STATE.ACTIVE, seq, sinceAt: NOW, dueAt: NOW, flags: 0 };
        rules.rollIntent(p, T, S_ON, rngOf(pilotId, seq), route, NOW, { context: view, standing: st,
          note: (x) => { if (x === "context.retreats") n += 1; } });
      }
      return n;
    };
    assert.deepStrictEqual([retreats(1) === 0, retreats(2) > 20], [true, true], `${retreats(1)} / ${retreats(2)}`);
  });

  test("ST5 config (11 keys, W251, W252), compose and .env.example, the panel section", async () => {
    const env0 = { EVEJS_DATA_ROOT: os.tmpdir() };
    const def = resolveConfig({ modDir: MOD_DIR, env: env0 });
    assert.deepStrictEqual(def.config.population.standings, { enabled: false, profiles: 64, friendlyMin: 50,
      hostileMax: -50, empireBaseMin: -30, empireBaseMax: 40, pirateBaseMin: -100, pirateBaseMax: 60, homeBonus: 40,
      rivalPenalty: 40, panelTopProfiles: 5 });
    assert.ok(!def.warnings.some((w) => /W25[12]/.test(w)));
    const clamped = resolveConfig({ modDir: MOD_DIR, env: { ...env0, EVEJS_LNE_POPULATION_STANDINGS_PROFILES: "1",
      EVEJS_LNE_POPULATION_STANDINGS_HOSTILE_MAX: "5" } }).config.population.standings;
    assert.deepStrictEqual([clamped.profiles, clamped.hostileMax], [8, -1]);
    const on = { ...env0, EVEJS_LNE_POPULATION_ENABLED: "1", EVEJS_LNE_POPULATION_STANDINGS_ENABLED: "1" };
    const w1 = resolveConfig({ modDir: MOD_DIR, env: on }).warnings;
    assert.ok(w1.some((w) => /profiles only, routes and danger unchanged \(W251\)/.test(w)), w1.join(" | "));
    const w2 = resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_POPULATION_CONTEXT_ENABLED: "1",
      EVEJS_LNE_POPULATION_STANDINGS_PIRATE_BASE_MIN: "20", EVEJS_LNE_POPULATION_STANDINGS_PIRATE_BASE_MAX: "-10" } });
    assert.ok(!w2.warnings.some((w) => /W251/.test(w)));
    assert.ok(w2.warnings.some((w) => /pirateBaseMin=20 above pirateBaseMax=-10 - swapped \(W252\)/.test(w)));
    const sw = settingsOf(w2.config).standings;
    assert.deepStrictEqual([sw.enabled, sw.pirateBaseMin, sw.pirateBaseMax], [true, -10, 20]);
    assert.strictEqual(config.SCHEMA.filter((r) => r.key.startsWith("population.standings.")).length, 11);
    const list = populationStandingFactions();
    assert.deepStrictEqual([list.filter((x) => x.kind === "empire").length, list.filter((x) => x.kind === "pirate").length],
      [6, 5]);

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

    const panelOf = async (standings) => {
      const S = F.settings({ enabled: true, size: 300, context: { enabled: true }, standings });
      const { svc, clock } = await service(S, { factions: FACTIONS });
      const data = buildPopulationPanel({ service: svc, settings: S, clock }).getData();
      svc.stop();
      return data;
    };
    const off = await panelOf({ enabled: false });
    assert.ok(!("standings" in off));
    const panel = await panelOf({ enabled: true, panelTopProfiles: 3 });
    assert.strictEqual(panel.status.standings.enabled, true);
    assert.deepStrictEqual(panel.standings.byFaction.map((x) => x.factionId), [AMARR, MINMATAR, PIRATE]);
    for (const row of panel.standings.byFaction) assert.strictEqual(row.friendly + row.neutral + row.hostile, 300);
    assert.ok(panel.standings.top.length > 0 && panel.standings.top.length <= 3);
    assert.ok(panel.standings.byFaction[2].hostile > 0 && panel.standings.byFaction[2].friendly > 0);
  });
};
