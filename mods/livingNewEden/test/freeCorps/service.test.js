"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { createManualClock } = require("../../lib/util/clock");
const { createViewRegistry } = require("../../lib/observer/views");
const { startFreeCorps, createUnavailableFreeCorps } = require("../../lib/freeCorps");
const { FACADE_METHODS, keyFound } = require("../../lib/freeCorps/schema");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 2000000000000;
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const SYSTEMS = Object.freeze({ highsec: [30000001, 30000002], lowsec: [30000003], nullsec: [30000004] });

function baseConfig(over = {}, env = ON_ENV) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(r.errors, []);
  const c = r.config;
  return { ...c, freeCorps: { ...c.freeCorps, ...(over.freeCorps || {}) },
    virtualCorps: { ...c.virtualCorps, ...(over.virtualCorps || {}) } };
}

function fakeGraph(systems = SYSTEMS) {
  const all = Object.entries(systems).flatMap(([band, ids]) => ids.map((id) => [id, band]));
  const byId = new Map(all.map(([id, band]) => [id, { id, name: `Sys${id}`, regionId: 10000002,
    constellationId: 20000020, secClass: band }]));
  return { getSystem: (id) => byId.get(id) || null, getSystemsBySecClass: (c) => systems[c] || [] };
}

function fakeVc(store) {
  const vc = { identities: new Map(), ensures: [], calls: 0,
    oc: { ok: true, ready: true, total: 0, byKind: { capsuleer: 0, civilian: 0, free: 0 } },
    ensureOwnerIdentity(spec) {
      vc.calls += 1;
      vc.ensures.push({ spec, inTx: store.isInTransaction() });
      return { ok: true, queued: true };
    },
    getOwnerIdentity(kind, id) {
      vc.calls += 1;
      assert.strictEqual(kind, "free");
      return vc.identities.get(id) || { ok: true, state: "PENDING" };
    },
    countOwnerCharacters() {
      vc.calls += 1;
      return vc.oc;
    } };
  return vc;
}

function boot(opened, { cfg = baseConfig(), vc = fakeVc(opened.store), graph = fakeGraph(), clock, views } = {}) {
  const clk = clock || createManualClock(T0);
  const journal = createJournal({ clock: clk, maxPayloadBytes: 16384, maxRows: 500 });
  const timers = [];
  const r = startFreeCorps({ config: cfg, clock: clk, logger: { log() {} }, telemetry: null,
    persistence: { store: opened.store, journal, worldSeed: opened.worldSeed }, views: views || null,
    getGraph: () => ({ ok: true, graph }), getVirtualCorps: () => vc, getGovernor: () => null,
    listStations: (systemId) => ({ ok: true, stations: [{ stationId: 60000000 + (systemId % 1000), corporationId:
      1000100 }] }),
    bloodlinesOf: () => [1, 2], raceSourceFactionIds: [500001, 500002, 500003, 500004],
    excludedRegionIds: [10000070], reservedNames: () => ({ names: new Set(), tickers: new Set() }),
    setTimer: (fn, ms) => { timers.push(ms); return { cancel() {}, hasRef: () => false }; }, nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { fc: r.freeCorps, vc, clock: clk, journal, timers };
}

function rows(opened) {
  const r = opened.store.transaction("t.rows", (db) => db.prepare("SELECT corp_id, state, open, name, ticker, "
    + "members_target, corporation_id, end_reason, home_system_id FROM world_free_corps ORDER BY corp_id").all());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value.map((x) => ({ ...x, corp_id: Number(x.corp_id), open: Number(x.open),
    members_target: Number(x.members_target), corporation_id: x.corporation_id === null ? null
      : Number(x.corporation_id), home_system_id: Number(x.home_system_id) }));
}

function pass(env) {
  const r = env.fc.runPassNow();
  assert.deepStrictEqual(r, { ok: true, ran: true });
  return env.fc.getStatus();
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FC2-3 population controller: found after commit, interval, target, budget, home limit, ACTIVE, "
    + "REFUSED", () => {
    withStore(driver, (opened) => {
      const views = createViewRegistry();
      const env = boot(opened, { views });
      assert.deepStrictEqual(env.timers, [5000], "first arm passMs, not synchronous");
      pass(env);
      let list = rows(opened);
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].state, "FOUNDING");
      assert.strictEqual(env.vc.ensures.length, 1);
      const e = env.vc.ensures[0];
      assert.strictEqual(e.inTx, false, "ensure after the commit");
      assert.strictEqual(e.spec.ownerKind, "free");
      assert.strictEqual(e.spec.ownerId, 1);
      assert.ok(e.spec.members >= 3 && e.spec.members <= 8, String(e.spec.members));
      assert.strictEqual(e.spec.members, list[0].members_target);
      assert.strictEqual(e.spec.corporation.name, list[0].name);
      assert.strictEqual(e.spec.corporation.ticker, list[0].ticker);
      env.clock.advance(1000);
      pass(env);
      assert.strictEqual(rows(opened).length, 1, "interval gate");
      env.vc.identities.set(1, { ok: true, state: "LINKED", corporationId: 98000001, ceoCharacterId: 91000001,
        characterIds: Array.from({ length: list[0].members_target }, (_v, i) => 91000001 + i),
        refusedMemberCount: 0 });
      env.clock.advance(60000);
      pass(env);
      list = rows(opened);
      assert.strictEqual(list[0].state, "ACTIVE");
      assert.strictEqual(list[0].corporation_id, 98000001);
      assert.strictEqual(list.length, 2, "second founding after the interval");
      assert.strictEqual(env.fc.getStatus().counters.activated, 1);
      env.vc.identities.set(2, { ok: true, state: "REFUSED", reason: "NAME_TAKEN" });
      env.clock.advance(30000);
      pass(env);
      list = rows(opened);
      assert.deepStrictEqual([list[1].state, list[1].open, list[1].end_reason], ["REFUSED", 0, "NAME_TAKEN"]);
      env.clock.advance(60000);
      const st = pass(env);
      assert.strictEqual(st.population.open, 2, "REFUSED is not open (ACTIVE 1 + new FOUNDING 1)");
      assert.strictEqual(st.population.refused, 1);
      const view = views.getView("free-corps");
      assert.ok(view, "panel registered");
      const data = view.getData({});
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.strictEqual(data.rows.length, 3);
      assert.strictEqual(data.byState.REFUSED, 1);
      assert.ok(data.rows[0].corporation.endsWith(`[${list[0].ticker}]`));
      env.fc.stop();
      assert.strictEqual(views.getView("free-corps"), null, "panel unregistered on stop");
    });
    withStore(driver, (opened) => {
      const env = boot(opened, { cfg: baseConfig({ freeCorps: { targetCorps: 1 } }) });
      pass(env);
      env.clock.advance(120000);
      pass(env);
      assert.strictEqual(rows(opened).length, 1, "targetCorps 1");
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const env = boot(opened, { cfg: baseConfig({ virtualCorps: { ownerCharacterBudget: 100 } }) });
      env.vc.oc = { ok: true, ready: true, total: 98, byKind: { capsuleer: 98, civilian: 0, free: 0 } };
      const st = pass(env);
      assert.strictEqual(rows(opened).length, 0);
      assert.strictEqual(st.counters.foundingBlockedBudget, 1);
      assert.strictEqual(env.vc.ensures.length, 0);
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const env = boot(opened, { cfg: baseConfig({ freeCorps: { maxCorpsPerHomeSystem: 1,
        bandWeights: "highsec:1" } }), graph: fakeGraph({ highsec: [30000001] }) });
      pass(env);
      env.clock.advance(60000);
      const st = pass(env);
      assert.strictEqual(rows(opened).length, 1);
      assert.strictEqual(st.counters.foundingNoHome, 1);
      env.fc.stop();
    });
  });

  needsDriver("FC2-4 restart in FOUNDING re-ensures without a second row or journal entry; a throw in the INSERT "
    + "rolls the pass back and the next pass founds the same corp_id", () => {
    withStore(driver, (opened) => {
      const a = boot(opened);
      pass(a);
      a.fc.stop();
      assert.strictEqual(rows(opened).length, 1);
      const clock = createManualClock(T0 + 30000);
      const b = boot(opened, { clock });
      pass(b);
      assert.strictEqual(rows(opened).length, 1, "no second row");
      assert.deepStrictEqual(b.vc.ensures.map((x) => x.spec.ownerId), [1], "ensure again after the restart");
      const n = opened.store.transaction("t.j", (db) => db.prepare("SELECT COUNT(*) AS n FROM world_event_journal "
        + "WHERE idempotency_key = ?").get(keyFound(1)).n);
      assert.strictEqual(Number(n.value), 1, "one journal entry");
      b.fc.stop();
    });
    withStore(driver, (opened) => {
      const add = opened.store.transaction("t.trigger", (db) => db.exec("CREATE TEMP TRIGGER fc_boom BEFORE INSERT "
        + "ON world_free_corps BEGIN SELECT RAISE(ABORT, 'test boom'); END;"));
      assert.ok(add.ok, JSON.stringify(add));
      const env = boot(opened);
      const r = env.fc.runPassNow();
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(rows(opened).length, 0, "rolled back");
      assert.strictEqual(env.vc.ensures.length, 0, "no ensure");
      assert.strictEqual(env.fc.getStatus().counters.passFailed, 1);
      const n = opened.store.transaction("t.j", (db) => db.prepare("SELECT COUNT(*) AS n FROM world_event_journal "
        + "WHERE idempotency_key = ?").get(keyFound(1)).n);
      assert.strictEqual(Number(n.value), 0, "no journal entry");
      assert.ok(opened.store.transaction("t.drop", (db) => db.exec("DROP TRIGGER temp.fc_boom")).ok);
      pass(env);
      const list = rows(opened);
      assert.deepStrictEqual(list.map((x) => x.corp_id), [1], "same corp_id");
      assert.deepStrictEqual(env.vc.ensures.map((x) => x.spec.ownerId), [1]);
      env.fc.stop();
    });
  });

  needsDriver("FC2-5 flag off / dependency off: no timer, no virtualCorps call; stub; migration 73; config "
    + "defaults, checks and W4-W7 at their condition", () => {
    withStore(driver, (opened) => {
      const vc = fakeVc(opened.store);
      const timers = [];
      const deps = (cfg) => ({ config: cfg, clock: createManualClock(T0), persistence: { store: opened.store,
        journal: createJournal({ clock: createManualClock(T0), maxPayloadBytes: 16384, maxRows: 500 }),
        worldSeed: 1 }, getGraph: () => null, getVirtualCorps: () => vc, getGovernor: () => null,
      listStations: () => ({ ok: false }), bloodlinesOf: () => null, raceSourceFactionIds: [500001],
      excludedRegionIds: [], reservedNames: () => ({ names: new Set(), tickers: new Set() }),
      setTimer: (fn, ms) => { timers.push(ms); return { cancel() {}, hasRef: () => false }; } });
      assert.deepStrictEqual(startFreeCorps(deps(baseConfig({}, {}))), { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual(startFreeCorps(deps(baseConfig({}, { EVEJS_LNE_FREE_CORPS_ENABLED: "1" }))),
        { ok: false, reason: "disabled_by_dependency", detail: "modules.virtualCorps" });
      assert.deepStrictEqual(timers, [], "no timer");
      assert.strictEqual(vc.calls, 0, "no virtualCorps call");
      assert.strictEqual(rows(opened).length, 0, "no row");
    });
    const stub = createUnavailableFreeCorps("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub).sort(), FACADE_METHODS.slice().sort());
    assert.deepStrictEqual(stub.runPassNow(), { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(stub.getStatus(), { state: "unavailable", reason: "disabled_by_config" });
    withStore(driver, (opened) => {
      assert.ok(LATEST_SCHEMA_VERSION >= 73, String(LATEST_SCHEMA_VERSION));
      const r = opened.store.transaction("t.schema", (db) => ({
        version: db.prepare("SELECT value FROM lne_meta WHERE key = 'schema_version'").get().value,
        n: db.prepare("SELECT COUNT(*) AS n FROM world_free_corps").get().n,
        idx: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_free_corps' "
          + "AND sql LIKE '%WHERE open = 1%' ORDER BY name").all().map((x) => x.name) }));
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(Number(r.value.version), LATEST_SCHEMA_VERSION);
      assert.strictEqual(Number(r.value.n), 0);
      assert.deepStrictEqual(r.value.idx, ["world_free_corps_due", "world_free_corps_home"]);
    }, { fresh: true });

    const W = Object.freeze({ W4: "freeCorps.targetCorps limited by", W5: "freeCorps.archetypeWeights:",
      W6: "freeCorps.membersMin above membersMax", W7: "freeCorps.enabled needs modules.virtualCorps" });
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const which = (r) => r.warnings.map((w) => Object.keys(W).find((k) => w.startsWith(W[k]))).filter(Boolean);
    const def = resolve({});
    const { ventures: _v, lifecycle: _l, retention: _r, local: _lo, map: _m, chatter: _ch, wormholes: _wh,
      hunting: _hu, wars: _wa, killmails: _km, contracts: _ct, recycle: _rc, structures: _st, whCorps: _wc,
      ...fcSub2 } = def.config.freeCorps;
    assert.deepStrictEqual(fcSub2, { enabled: false, targetCorps: 60, membersMin: 3, membersMax: 8,
      passMs: 5000, maxCorpsPerPass: 32, maxPassMs: 8, foundingIntervalMs: 60000, maxFoundingsPerPass: 1,
      maxFoundingOpen: 2, foundingRecheckMs: 30000, foundingStaleMs: 3600000, activeIdleMs: 600000, maxRefused: 50,
      bandWeights: "highsec:50,lowsec:30,nullsec:20",
      archetypeWeights: "miner:20,hauler:15,ratter:15,explorer:10,industrialist:10,missioner:15",
      maxCorpsPerHomeSystem: 3, maxHomeAttempts: 8, maxNameAttempts: 8, initialIsk: 200000000, observerMaxRows: 200 });
    assert.deepStrictEqual(which(def), []);
    assert.deepStrictEqual(which(resolve(ON_ENV)), [], "on with virtualCorps, defaults");
    const band = resolve({ EVEJS_LNE_FREE_CORPS_BAND_WEIGHTS: "highsec:0" });
    assert.ok(band.warnings.some((w) => w.startsWith("EVEJS_LNE_FREE_CORPS_BAND_WEIGHTS=") && w.includes("ignored")),
      band.warnings.join("; "));
    assert.strictEqual(band.config.freeCorps.bandWeights, "highsec:50,lowsec:30,nullsec:20");
    const arch = resolve({ EVEJS_LNE_FREE_CORPS_ARCHETYPE_WEIGHTS: "pirate:5" });
    assert.ok(arch.warnings.some((w) => w.startsWith("EVEJS_LNE_FREE_CORPS_ARCHETYPE_WEIGHTS=")), arch.warnings.join("; "));
    const c = def.config;
    const need = c.capsuleers.maxCorps * c.capsuleers.membersPerCorp
      + c.highsecLife.civilianCorps * c.highsecLife.civilianMembersPerCorp + c.freeCorps.targetCorps * c.freeCorps.membersMin;
    assert.deepStrictEqual(which(resolve({ ...ON_ENV, EVEJS_LNE_VIRTUAL_CORPS_OWNER_CHARACTER_BUDGET: String(need) })),
      [], "W4 at the edge");
    assert.deepStrictEqual(which(resolve({ ...ON_ENV,
      EVEJS_LNE_VIRTUAL_CORPS_OWNER_CHARACTER_BUDGET: String(need - 1) })), ["W4"]);
    assert.deepStrictEqual(which(resolve({ EVEJS_LNE_VIRTUAL_CORPS_OWNER_CHARACTER_BUDGET: String(need - 1) })), [],
      "W4 only with freeCorps.enabled");
    assert.deepStrictEqual(which(resolve({ EVEJS_LNE_FREE_CORPS_ARCHETYPE_WEIGHTS: "miner:1,hunter:1" })), ["W5"]);
    assert.deepStrictEqual(which(resolve({ EVEJS_LNE_FREE_CORPS_ARCHETYPE_WEIGHTS: "miner:1,hunter:0" })), []);
    assert.deepStrictEqual(which(resolve({ EVEJS_LNE_FREE_CORPS_MEMBERS_MIN: "5", EVEJS_LNE_FREE_CORPS_MEMBERS_MAX: "4" })),
      ["W6"]);
    assert.deepStrictEqual(which(resolve({ EVEJS_LNE_FREE_CORPS_MEMBERS_MIN: "5", EVEJS_LNE_FREE_CORPS_MEMBERS_MAX: "5" })),
      []);
    assert.deepStrictEqual(which(resolve({ EVEJS_LNE_FREE_CORPS_ENABLED: "1" })), ["W7"]);
  });
};
