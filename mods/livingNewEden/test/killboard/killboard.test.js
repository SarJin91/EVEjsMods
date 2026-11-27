"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { SCHEMA } = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createBattleRepository, SETTLED_AFTER_SQL } = require("../../lib/battle/battleRepository");
const { planBattle } = require("../../lib/killboard/battlePlan");
const { createKillboardRepository } = require("../../lib/killboard/repository");
const { createBattleProjector } = require("../../lib/killboard/battleProjector");
const { startKillboard } = require("../../lib/killboard");
const { createViewRegistry } = require("../../lib/observer/views");
const { createRouter } = require("../../lib/observer/router");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REGISTRY_FILE = path.resolve(MOD_DIR, "..", "..", "server", "src", "services", "inventory", "itemTypeRegistry.js");
const HOUR = 3600000;
const NOW = 1800000000000;
const A = 500001;
const B = 500002;
const C = 500003;

const KB_DEFAULTS = Object.freeze(Object.fromEntries(SCHEMA.filter((r) => r.key.startsWith("killboard."))
  .map((r) => [r.key.slice("killboard.".length), r.default])));

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function battleRepositoryOf() {
  return createBattleRepository({ journal: { applyOnce() {}, findByKey() {} },
    fleetRepository: { transition() {}, getFleets() {} }, clock: { now: () => NOW }, ids: { next: () => "x" },
    worldSeed: 1, limits: { maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
      maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500, maxSettlementRows: 450 } });
}

const inputOf = (aFleets, bFleets, garrison) => ({ sideA: { factionId: A, fleets: aFleets },
  sideB: { factionId: B, fleets: bFleets }, ...(garrison ? { garrison } : {}) });
const fleet = (fleetId, factionId) => ({ fleetId, factionId });

function withStore(driver, fn) {
  let handle = null;
  const opened = openStore({ filePath: ":memory:", openDatabase: (f) => {
    handle = new driver.Database(f);
    return handle;
  }, exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
  assert.ok(opened.ok, JSON.stringify(opened));
  const store = opened.store;
  handle.pragma("foreign_keys = OFF");
  const tx = (f) => {
    const r = store.transaction("test", f);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const insB = (db, id, state, settledAt, input, result, system = 30000142) => db.prepare(`INSERT INTO battle_records
    (battle_id, idempotency_key, system_id, environment, objective, mode, state, resolver_version, input_hash, seed,
    input_json, fleet_ids, result_json, claim_seq, created_at, updated_at, settled_at, version) VALUES (?, ?, ?,
    'lowsec', 'destroy', 'VIRTUAL', ?, 'internal-v1', ?, 1, ?, '[]', ?, 0, 1, 1, ?, 1)`).run(id, `k-${id}`,
    BigInt(system), state, "a".repeat(64), JSON.stringify(input), result === null ? null : JSON.stringify(result),
    settledAt === null ? null : BigInt(settledAt));
  const insL = (db, id, rows) => {
    const st = db.prepare("INSERT INTO battle_losses (battle_id, fleet_id, faction_id, hull_group, type_id, count) "
      + "VALUES (?, ?, ?, ?, ?, ?)");
    for (const [f, fac, hull, type, n] of rows) st.run(id, f, BigInt(fac), hull, BigInt(type), BigInt(n));
  };
  const battle = (id, state, settledAt, losses, opts = {}) => tx((db) => {
    insB(db, id, state, settledAt, opts.input || inputOf([fleet(`fa-${id}`, A)], [fleet(`fb-${id}`, B)]),
      opts.result === undefined ? { outcome: "A_WIN", estimatedDurationSec: 90 } : opts.result, opts.system);
    insL(db, id, losses);
  });
  const count = (table) => tx((db) => Number(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()));
  const all = (sql) => tx((db) => db.prepare(sql).all());
  try {
    return fn({ store, tx, battle, count, all, losses: (id, rows) => tx((db) => insL(db, id, rows)) });
  } finally {
    store.close();
  }
}

function facts(byId) {
  return (ids) => {
    const map = new Map();
    const missing = [];
    for (const id of ids) {
      if (byId[id]) map.set(id, { typeId: id, name: byId[id][0], volume: null, portionSize: null, basePrice: byId[id][1] });
      else missing.push(id);
    }
    return { ok: true, facts: map, missing };
  };
}

function projectorOn(h, extra = {}) {
  const metrics = [];
  const gov = { admit: true };
  const writes = { n: 0 };
  const p = createBattleProjector({ store: h.store, repo: createKillboardRepository(),
    getBattleRepository: () => battleRepositoryOf(), readItemTypeFacts: extra.facts || facts({ 587: ["Rifter", 400000.4] }),
    getGovernor: () => ({ admits: (c) => (c === "MAINTENANCE" ? gov.admit : true) }),
    clock: extra.clock || { now: () => NOW }, P: { ...KB_DEFAULTS, ...(extra.P || {}) }, rowsCap: extra.rowsCap || 500,
    count: (n, v) => metrics.push([n, v === undefined ? 1 : v]), gauge: () => {}, onWrite: () => { writes.n += 1; },
    log: () => {} });
  return { p, metrics, gov, writes };
}

module.exports = ({ test, skip }) => {
  test("KB1 planBattle: garrison, unpriced, A_WIN / DRAW / no result, unattributed, killed = the other side", () => {
    const battle = (result, garrison) => Object.freeze({ battleId: "b1", systemId: 30000142, settledAt: 5000,
      createdAt: 1000, mode: "VIRTUAL", environment: "lowsec", objective: "destroy", result,
      input: inputOf([fleet("fa1", A)], [fleet("fb1", B), fleet("fb2", B)], garrison) });
    const losses = [{ fleetId: "fa1", factionId: A, hullGroup: "frigate", typeId: 587, count: 2 },
      { fleetId: "fb1", factionId: B, hullGroup: "cruiser", typeId: null, count: 1 },
      { fleetId: "gar", factionId: C, hullGroup: "frigate", typeId: 587, count: 3 },
      { fleetId: "x9", factionId: 999999, hullGroup: "frigate", typeId: 587, count: 4 }];
    const prices = new Map([[587, 1000]]);
    const win = planBattle(battle({ outcome: "A_WIN", estimatedDurationSec: 61.6 }, { side: "B", factionId: C }),
      losses, prices);
    assert.strictEqual(win.ok, true, JSON.stringify(win));
    assert.deepStrictEqual([win.row.outcome, win.row.aShipsLost, win.row.bShipsLost, win.row.aIskLost, win.row.bIskLost,
      win.row.unpricedShips, win.row.durationSec, win.row.aFleets, win.row.bFleets, win.unattributed],
    ["A_WIN", 2, 4, 2000, 3000, 1, 62, 1, 2, 4], "garrison loss to B by faction; unknown faction unattributed");
    assert.deepStrictEqual(win.sides.map((s) => [s.side, s.factionId, s.fleets, s.shipsLost, s.iskLost, s.result]),
      [["A", A, 1, 2, 2000, "W"], ["B", B, 2, 1, 0, "L"], ["B", C, 0, 3, 3000, "L"]]);
    assert.deepStrictEqual(win.deltas.map((d) => [d.factionId, d.wins, d.losses, d.shipsLost, d.iskLost, d.shipsKilled,
      d.iskKilled]), [[A, 1, 0, 2, 2000, 4, 3000], [B, 0, 1, 1, 0, 2, 2000], [C, 0, 1, 3, 3000, 2, 2000]]);
    const draw = planBattle(battle({ outcome: "DRAW" }, null), losses.slice(0, 2), prices);
    assert.deepStrictEqual([draw.row.outcome, ...draw.sides.map((s) => s.result), draw.deltas[0].draws],
      ["DRAW", "D", "D", 1]);
    const none = planBattle(battle(null, null), [], prices);
    assert.deepStrictEqual([none.row.outcome, none.row.durationSec, ...none.sides.map((s) => s.result),
      none.deltas[1].undecided], [null, null, "U", "U", 1]);
    assert.strictEqual(planBattle(battle({}, null), [], prices).row.outcome, null, "no outcome key = U");
    assert.deepStrictEqual(planBattle({ battleId: "" }, [], prices), { ok: false, reason: "PLAN_INVALID",
      detail: "battleId" });
  });

  test("KB9 client: parseHash paths / bad values -> #/, formatIsk, buildViewUrl refuses non-integers", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "killboard.js"), "utf8"), sandbox,
      { filename: "killboard.js" });
    const pure = sandbox.window.LneKillboard._pure;
    const ph = (h) => JSON.parse(JSON.stringify(pure.parseHash(h)));
    const home = { page: "battles", params: {} };
    for (const h of ["", "#", "#/", "#/battles", "#/nope", "#/battle/abc", "#/battle/0", "#/battle", "#/battle/1/2",
      "#/factions/5", "battle/3", null]) {
      assert.deepStrictEqual(ph(h), home, String(h));
    }
    assert.deepStrictEqual(ph("#/battle/12"), { page: "battle", params: { battle: 12 } });
    assert.deepStrictEqual(ph("#/battles?faction=500001&system=x&before=7"),
      { page: "battles", params: { faction: 500001, before: 7 } }, "bad optional value dropped");
    assert.deepStrictEqual(ph("#/faction/500001?before=40"), { page: "faction", params: { faction: 500001, before: 40 } });
    assert.deepStrictEqual(ph("#/factions"), { page: "factions", params: {} });
    assert.strictEqual(pure.formatHash("battles", { faction: 500001 }), "#/battles?faction=500001");
    assert.deepStrictEqual(ph(pure.formatHash("faction", { faction: 9, before: 3 })),
      { page: "faction", params: { faction: 9, before: 3 } }, "formatHash is the inverse");

    assert.deepStrictEqual([1234567890, 456700000, 12000, 950, 0, null, undefined, NaN, Infinity].map(pure.formatIsk),
      ["1.23 B", "456.7 M", "12.0 k", "950", "0", "—", "—", "—", "—"]);

    assert.strictEqual(pure.buildViewUrl("battle", { battle: 12 }), "/api/views/kb-battle?battle=12");
    assert.strictEqual(pure.buildViewUrl("battles", {}), "/api/views/kb-battles");
    assert.strictEqual(pure.buildViewUrl("battles", { faction: 5, system: 30000142, before: 9 }),
      "/api/views/kb-battles?faction=5&system=30000142&before=9");
    assert.strictEqual(pure.buildViewUrl("faction", { faction: 5, before: 2 }), "/api/views/kb-faction?faction=5&before=2");
    assert.strictEqual(pure.buildViewUrl("factions", {}), "/api/views/kb-factions");
    for (const [page, params] of [["battle", {}], ["battle", { battle: "12" }], ["battle", { battle: 1.5 }],
      ["battle", { battle: -1 }], ["battle", { battle: 0 }], ["battles", { faction: "1;x" }],
      ["battles", { other: 1 }], ["nope", {}], ["toString", {}], ["faction", { faction: 2 ** 53 }]]) {
      assert.strictEqual(pure.buildViewUrl(page, params), null, JSON.stringify([page, params]));
    }
  });

  const driver = loadDriver();
  const k2 = "KB2 migration 98 + listSettledAfter + projector: 3 of 4, idempotent pass / restart, overlap, prices";
  const k3 = "KB3 budget rowsCap 12: partial pass, cursor on the last loaded, next pass completes; governor hold";
  const k4 = "KB4 view kb-battles: filters, nextBefore, names, GOVERNOR_HOLD, flag off 404; facade; vendor fact";
  const k5 = "KB5 time budget: a clock past maxPassMs on every now() -> 1 battle per pass, then completes";
  const k6 = "KB6 view kb-battle: garrison + structure -> sides, hulls, ISK, unpriced; NOT_FOUND; summaryOnly";
  const k7 = "KB7 views kb-faction + kb-factions: totals, paging before, order by isk_killed";
  const k8 = "KB8 kb-battle 64 fleets x 8 hulls < 256 KB; GOVERNOR_HOLD on kb-battle / kb-faction / kb-factions";
  if (!driver.ok) {
    for (const k of [k2, k3, k4, k5, k6, k7, k8]) skip(k, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  function bootKb(h, extra = {}) {
    const views = createViewRegistry();
    const gov = { admit: true };
    const ctx = { persistence: { store: h.store }, battle: { repository: battleRepositoryOf() }, views,
      governor: { admits: () => gov.admit }, graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (
        id === 30000142 ? { name: "Jita", security: 0.946 } : null) } }) } };
    const adapter = { readItemTypeFacts: extra.facts || facts({ 587: ["Rifter", 1000] }),
      readFactionNames: () => ({ ok: true, names: new Map([[A, "Amarr Empire"], [B, "Caldari State"]]) }) };
    const started = startKillboard({ config: { killboard: { ...KB_DEFAULTS, enabled: true, ...(extra.P || {}) },
      persistence: { maxRowsPerTransaction: 500 } }, ctx, adapter, clock: { now: () => NOW },
    setTimer: () => ({ cancel() {}, hasRef: () => false }) });
    assert.ok(started.ok, JSON.stringify(started));
    const router = createRouter({ views, assets: {}, config: { maxResponseBytes: 262144, refreshSeconds: 5,
      systemCardCacheSlots: 8 }, modVersion: "t", now: () => NOW });
    const get = (view, q = "") => {
      const r = router.route({ method: "GET", url: `/api/views/${view}${q}`, host: "127.0.0.1" });
      return { status: r.status, bytes: Buffer.byteLength(r.body), body: JSON.parse(r.body) };
    };
    return { kb: started.killboard, get, gov, ctx };
  }

  test(k6, () => {
    withStore(driver, (h) => {
      const input = { sideA: { factionId: A, fleets: [{ fleetId: "fa", factionId: A, fleetRole: "assault",
        composition: [{ hullGroup: "frigate", typeId: 587, count: 5 }, { hullGroup: "cruiser", typeId: 620, count: 2 }] }] },
      sideB: { factionId: B, fleets: [{ fleetId: "fb", factionId: B, fleetRole: "defense",
        composition: [{ hullGroup: "frigate", typeId: null, count: 3 }] }] },
      garrison: { side: "B", factionId: C, strength: 10 } };
      const result = { outcome: "A_WIN", estimatedDurationSec: 120,
        escapedShips: [{ fleetId: "fb", hullGroup: "frigate", typeId: null, count: 1 }],
        survivingShips: [{ fleetId: "fa", hullGroup: "frigate", typeId: 587, count: 3 },
          { fleetId: "fa", hullGroup: "cruiser", typeId: 620, count: 2 }],
        structureDestroyed: true, structureTypeId: 35832 };
      h.battle("g1", "COMPLETED", NOW - HOUR, [["fa", A, "frigate", 587, 2], ["fb", B, "frigate", 0, 2],
        ["gar", C, "frigate", 587, 1]], { input, result });
      const env = bootKb(h);
      assert.strictEqual(env.kb.runPassNow().ingested, 1);
      const r = env.get("kb-battle", "?battle=1");
      assert.strictEqual(r.status, 200);
      const d = r.body.data;
      assert.deepStrictEqual([d.available, d.no, d.battleId, d.systemName, d.security, d.outcome, d.durationSec,
        d.unpriced, d.unattributed, d.priceBasis, d.summaryOnly, d.settledAt],
      [true, 1, "g1", "Jita", 0.946, "A_WIN", 120, 2, 0, "base-v1", false, NOW - HOUR]);
      assert.deepStrictEqual(d.structure, { typeId: 35832, typeName: null, destroyed: true });
      const [sa, sb] = d.sides;
      assert.deepStrictEqual([sa.side, sa.shipsLost, sa.iskLost, sb.side, sb.shipsLost, sb.iskLost],
        ["A", 2, 2000, "B", 3, 1000]);
      assert.deepStrictEqual(sa.factions, [{ id: A, name: "Amarr Empire", result: "W", shipsLost: 2, iskLost: 2000 }]);
      assert.deepStrictEqual(sb.factions, [{ id: B, name: "Caldari State", result: "L", shipsLost: 2, iskLost: 0 },
        { id: C, name: null, result: "L", shipsLost: 1, iskLost: 1000 }], "garrison faction on side B");
      assert.deepStrictEqual(sa.fleets, [{ fleetId: "fa", factionId: A, fleetRole: "assault", hulls: [
        { hullGroup: "frigate", typeId: 587, typeName: "Rifter", start: 5, destroyed: 2, escaped: 0, surviving: 3,
          iskDestroyed: 2000 },
        { hullGroup: "cruiser", typeId: 620, typeName: null, start: 2, destroyed: 0, escaped: 0, surviving: 2,
          iskDestroyed: null }] }]);
      assert.deepStrictEqual(sb.fleets, [{ fleetId: "fb", factionId: B, fleetRole: "defense", hulls: [
        { hullGroup: "frigate", typeId: null, typeName: null, start: 3, destroyed: 2, escaped: 1, surviving: 0,
          iskDestroyed: null }] },
      { fleetId: "gar", factionId: C, fleetRole: null, hulls: [{ hullGroup: "frigate", typeId: 587, typeName: "Rifter",
        start: 0, destroyed: 1, escaped: 0, surviving: 0, iskDestroyed: 1000 }] }], "garrison loss as its own row");

      assert.deepStrictEqual(env.get("kb-battle", "?battle=99").body.data, { available: false, reason: "NOT_FOUND" });
      assert.strictEqual(env.get("kb-battle").status, 400, "param required");
      h.battle("g2", "SETTLING", null, []);
      assert.strictEqual(env.kb.runPassNow().ingested, 0);
      assert.deepStrictEqual(env.get("kb-battle", "?battle=2").body.data.reason, "NOT_FOUND");

      h.tx((db) => {
        db.prepare("DELETE FROM battle_losses WHERE battle_id = 'g1'").run();
        db.prepare("DELETE FROM battle_records WHERE battle_id = 'g1'").run();
      });
      env.kb.runPassNow();
      const s = env.get("kb-battle", "?battle=1").body.data;
      assert.deepStrictEqual([s.available, s.summaryOnly, s.sides[0].fleets, s.sides[1].factions.length, s.unpriced,
        s.structure.destroyed], [true, true, [], 2, 2, true]);
      env.kb.stop();
      assert.strictEqual(env.get("kb-battle", "?battle=1").status, 404, "stop unregisters every view");
    });
  });

  test("KB18 debt-sweep: kb-battle getBattle ok:false / throw -> BATTLE_READ_FAILED; battle:null -> summaryOnly", () => {
    withStore(driver, (h) => {
      h.battle("r1", "COMPLETED", NOW - HOUR, [["fa-r1", A, "frigate", 587, 1]]);
      const env = bootKb(h);
      assert.strictEqual(env.kb.runPassNow().ingested, 1);
      const real = env.ctx.battle.repository;
      const withGetBattle = (getBattle) => {
        env.ctx.battle.repository = { ...real, getBattle };
        env.kb.runPassNow();
        return env.get("kb-battle", "?battle=1").body.data;
      };
      assert.deepStrictEqual(withGetBattle(() => ({ ok: false, reason: "X" })),
        { available: false, reason: "BATTLE_READ_FAILED" });
      assert.deepStrictEqual(withGetBattle(() => { throw new Error("boom"); }),
        { available: false, reason: "BATTLE_READ_FAILED" });
      const none = withGetBattle(() => ({ ok: true, battle: null }));
      assert.deepStrictEqual([none.available, none.summaryOnly], [true, true]);
      env.ctx.battle.repository = real;
      env.kb.runPassNow();
      assert.strictEqual(env.get("kb-battle", "?battle=1").body.data.summaryOnly, false);
      env.kb.stop();
    });
  });

  test(k7, () => {
    withStore(driver, (h) => {
      h.battle("p1", "COMPLETED", NOW - 3 * HOUR, [["fb-p1", B, "frigate", 587, 3]]);
      h.battle("p2", "COMPLETED", NOW - 2 * HOUR, [["fa-p2", A, "frigate", 587, 1]]);
      h.battle("p3", "COMPLETED", NOW - HOUR, [["fb-p3", B, "frigate", 587, 1]],
        { input: { sideA: { factionId: C, fleets: [fleet("fc-p3", C)] }, sideB: { factionId: B, fleets: [fleet("fb-p3", B)] } } });
      const env = bootKb(h, { P: { pageRows: 1 } });
      assert.strictEqual(env.kb.runPassNow().ingested, 3);
      const all = env.get("kb-factions").body.data;
      assert.deepStrictEqual(all.factions.map((f) => [f.factionId, f.name, f.iskKilled, f.iskLost, f.battles, f.wins]),
        [[A, "Amarr Empire", 3000, 1000, 2, 2], [B, "Caldari State", 1000, 4000, 3, 0], [C, null, 1000, 0, 1, 1]],
      "isk_killed DESC, then faction_id");
      const p1 = env.get("kb-faction", `?faction=${A}`);
      assert.deepStrictEqual(p1.body.params, { faction: A });
      const f1 = p1.body.data;
      assert.deepStrictEqual([f1.available, f1.factionId, f1.name, f1.totals.battles, f1.totals.shipsKilled,
        f1.totals.iskKilled, f1.battles.map((b) => [b.no, b.side, b.result, b.shipsLost, b.iskLost]), f1.nextBefore],
      [true, A, "Amarr Empire", 2, 3, 3000, [[2, "A", "W", 1, 1000]], 2]);
      const f2 = env.get("kb-faction", `?faction=${A}&before=${f1.nextBefore}`).body.data;
      assert.deepStrictEqual([f2.battles.map((b) => [b.no, b.shipsLost]), f2.nextBefore], [[[1, 0]], null]);
      const none = env.get("kb-faction", "?faction=999").body.data;
      assert.deepStrictEqual([none.available, none.totals, none.battles], [true, null, []]);
      assert.strictEqual(env.get("kb-faction", "?faction=1&before=x").status, 400);
    });
  });

  test(k8, () => {
    withStore(driver, (h) => {
      const types = [1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008];
      const fleetsOf = (side, faction) => Array.from({ length: 32 }, (_, i) => ({ fleetId: `f${side}-${i}`,
        factionId: faction, fleetRole: "assault", doctrineId: "doctrine-long-name",
        composition: types.map((t, j) => ({ hullGroup: `hullgroup${j}`, typeId: t, count: 20 })) }));
      const input = { sideA: { factionId: A, fleets: fleetsOf("a", A) }, sideB: { factionId: B, fleets: fleetsOf("b", B) } };
      const lossRows = [];
      for (const f of [...input.sideA.fleets, ...input.sideB.fleets]) {
        types.forEach((t, j) => lossRows.push([f.fleetId, f.factionId, `hullgroup${j}`, t, 5]));
      }
      const survive = (list) => list.flatMap((f) => types.map((t, j) => ({ fleetId: f.fleetId,
        hullGroup: `hullgroup${j}`, typeId: t, count: 15 })));
      h.battle("big", "COMPLETED", NOW - HOUR, lossRows.slice(0, 256), { input, result: { outcome: "DRAW",
        survivingShips: survive([...input.sideA.fleets, ...input.sideB.fleets]) } });
      h.losses("big", lossRows.slice(256));
      const byId = Object.fromEntries(types.map((t) => [t, [`Some Long Ship Type Name ${t}`, 12345678]]));
      const env = bootKb(h, { facts: facts(byId) });
      assert.strictEqual(env.kb.runPassNow().ingested, 1);
      const r = env.get("kb-battle", "?battle=1");
      assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
      const hulls = r.body.data.sides.flatMap((s) => s.fleets.flatMap((f) => f.hulls));
      assert.strictEqual(hulls.length, 512);
      assert.ok(hulls.every((x) => x.start === 20 && x.destroyed === 5 && x.surviving === 15
        && x.iskDestroyed === 5 * 12345678));
      assert.ok(r.bytes < 262144, `kb-battle ${r.bytes} bytes`);

      env.gov.admit = false;
      for (const [view, q] of [["kb-battle", "?battle=1"], ["kb-faction", `?faction=${A}`], ["kb-factions", ""]]) {
        const held = env.get(view, q);
        if (view === "kb-battle") {
          assert.strictEqual(held.body.stale, true, view);
        } else {
          assert.deepStrictEqual(held.body.data, { available: false, reason: "GOVERNOR_HOLD" }, view);
        }
      }
      assert.deepStrictEqual(env.get("kb-battle", "?battle=2").body.data, { available: false, reason: "GOVERNOR_HOLD" });
    });
  });

  test(k2, () => {
    assert.strictEqual(MIGRATIONS[97].name, "killboard_battles");
    withStore(driver, (h) => {
      h.battle("b1", "COMPLETED", NOW - 3 * HOUR, [[`fa-b1`, A, "frigate", 587, 2], [`fb-b1`, B, "cruiser", 0, 1]]);
      h.battle("b2", "COMPLETED", NOW - 2 * HOUR, [[`fb-b2`, B, "frigate", 641, 1]], { result: null });
      h.battle("b3", "COMPLETED", NOW - HOUR, [[`fb-b3`, B, "frigate", 587, 1]], { result: { outcome: "DRAW" } });
      h.battle("b4", "SETTLING", NOW - HOUR, [[`fb-b4`, B, "frigate", 587, 1]]);
      const repo = battleRepositoryOf();
      const plan = h.tx((db) => db.prepare(`EXPLAIN QUERY PLAN ${SETTLED_AFTER_SQL}`).all(1n, 1n, "", 10n));
      assert.ok(plan.some((r) => /USING INDEX battle_records_settled/.test(String(r.detail))), JSON.stringify(plan));
      const page = h.tx((db) => repo.listSettledAfter(db, { afterMs: NOW - 3 * HOUR, afterBattleId: "b1", limit: 10 }));
      assert.deepStrictEqual(page, { ok: true, rows: [{ battleId: "b2", settledAt: NOW - 2 * HOUR },
        { battleId: "b3", settledAt: NOW - HOUR }] }, "strictly after the key, COMPLETED only");
      assert.deepStrictEqual(repo.listSettledAfter(null, { afterMs: 0, afterBattleId: "", limit: 1 }),
        { ok: false, reason: "TX_REQUIRED" });
      assert.strictEqual(h.tx((db) => repo.listSettledAfter(db, { afterMs: 0, afterBattleId: "", limit: 0 })).reason,
        "INVALID_ARGUMENT");

      const pr = projectorOn(h);
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 3, known: 0, deferred: null });
      assert.strictEqual(h.count("kb_battles"), 3);
      assert.deepStrictEqual(h.all("SELECT type_id, isk, name, basis FROM kb_type_prices ORDER BY type_id"),
        [{ type_id: 587, isk: 400000, name: "Rifter", basis: "base-v1" },
          { type_id: 641, isk: null, name: null, basis: "base-v1" }], "rounded basePrice; missing type frozen NULL");
      assert.deepStrictEqual(h.all("SELECT battle_id, outcome, a_ships_lost, b_ships_lost, a_isk_lost, b_isk_lost, "
        + "unpriced_ships, duration_sec FROM kb_battles ORDER BY battle_no"), [
        { battle_id: "b1", outcome: "A_WIN", a_ships_lost: 2, b_ships_lost: 1, a_isk_lost: 800000, b_isk_lost: 0,
          unpriced_ships: 1, duration_sec: 90 },
        { battle_id: "b2", outcome: null, a_ships_lost: 0, b_ships_lost: 1, a_isk_lost: 0, b_isk_lost: 0,
          unpriced_ships: 1, duration_sec: null },
        { battle_id: "b3", outcome: "DRAW", a_ships_lost: 0, b_ships_lost: 1, a_isk_lost: 0, b_isk_lost: 400000,
          unpriced_ships: 0, duration_sec: null }]);
      const totals = () => h.all("SELECT * FROM kb_faction_totals ORDER BY faction_id");
      const before = totals();
      assert.deepStrictEqual(before.map((t) => [t.faction_id, t.battles, t.wins, t.losses, t.draws, t.undecided,
        t.ships_lost, t.ships_killed, t.isk_lost, t.isk_killed, t.version]),
      [[A, 3, 1, 0, 1, 1, 2, 3, 800000, 400000, 3], [B, 3, 0, 1, 1, 1, 3, 2, 400000, 800000, 3]]);
      assert.strictEqual(pr.writes.n, 1);

      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 0, known: 1, deferred: null }, "second pass");
      assert.deepStrictEqual(projectorOn(h).p.runPass(NOW), { ok: true, ingested: 0, known: 1, deferred: null },
        "restart: a new projector on the same store");
      assert.deepStrictEqual(totals(), before, "no double count");
      const cursor = h.all("SELECT at_ms, key_text, rows, state FROM kb_cursor")[0];
      assert.deepStrictEqual(cursor, { at_ms: NOW - HOUR, key_text: "b3", rows: 3, state: "RUNNING" });

      h.battle("b0", "COMPLETED", NOW - HOUR - 60000, [[`fa-b0`, A, "frigate", 587, 1]]);
      h.battle("b5", "COMPLETED", NOW - 1000, [[`fa-b5`, A, "frigate", 999, 1]]);
      const refusing = projectorOn(h, { facts: () => ({ ok: false, reason: "ITEM_TYPES_UNAVAILABLE" }) });
      assert.deepStrictEqual(refusing.p.runPass(NOW), { ok: true, ingested: 2, known: 1, deferred: null });
      assert.deepStrictEqual(h.all("SELECT battle_id, unpriced_ships FROM kb_battles WHERE battle_no > 3 "
        + "ORDER BY battle_no"), [{ battle_id: "b0", unpriced_ships: 0 }, { battle_id: "b5", unpriced_ships: 1 }]);
      assert.strictEqual(h.count("kb_type_prices"), 2, "type 999 not frozen");
      assert.ok(refusing.metrics.some(([n, v]) => n === "killboard.pricesDeferred" && v === 1));
    });
  });

  test(k3, () => {
    withStore(driver, (h) => {
      for (let i = 1; i <= 3; i += 1) h.battle(`c${i}`, "COMPLETED", NOW - (10 - i) * 60000, [[`fa-c${i}`, A, "frigate", 587, 1]]);
      const pr = projectorOn(h, { rowsCap: 12 });
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 2, known: 0, deferred: "ROWS" });
      assert.deepStrictEqual(h.all("SELECT at_ms, key_text, rows FROM kb_cursor")[0],
        { at_ms: NOW - 8 * 60000, key_text: "c2", rows: 2 });
      assert.ok(pr.metrics.some(([n]) => n === "killboard.deferredRows"));
      assert.strictEqual(pr.p.getStatus().backlogHint, true);
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, known: 2, deferred: null });
      assert.deepStrictEqual(h.all("SELECT key_text, rows FROM kb_cursor")[0], { key_text: "c3", rows: 3 });

      h.battle("c4", "COMPLETED", NOW - 1000, [[`fa-c4`, A, "frigate", 587, 1]]);
      pr.gov.admit = false;
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 0, known: 0, deferred: "GOVERNOR" });
      assert.strictEqual(h.count("kb_battles"), 3);
      assert.strictEqual(pr.p.getStatus().counters.deferredGovernor, 1);
      assert.ok(pr.metrics.some(([n]) => n === "killboard.deferredGovernor"));
    });
  });

  test(k5, () => {
    withStore(driver, (h) => {
      for (let i = 1; i <= 3; i += 1) h.battle(`t${i}`, "COMPLETED", NOW - (10 - i) * 60000, [[`fa-t${i}`, A, "frigate", 587, 1]]);
      let t = NOW;
      const clock = { now: () => { t += KB_DEFAULTS.maxPassMs + 1; return t; } };
      const pr = projectorOn(h, { clock });
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, known: 0, deferred: "TIME" }, "first pass");
      assert.deepStrictEqual(h.all("SELECT key_text, rows FROM kb_cursor")[0], { key_text: "t1", rows: 1 });
      assert.strictEqual(pr.p.getStatus().counters.deferredTime, 1);
      assert.ok(pr.metrics.some(([n]) => n === "killboard.deferredTime"));
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, known: 1, deferred: "TIME" });
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, known: 2, deferred: null }, "completes");
      assert.deepStrictEqual(h.all("SELECT key_text, rows FROM kb_cursor")[0], { key_text: "t3", rows: 3 });
      assert.strictEqual(h.count("kb_battles"), 3);
    });
  });

  test(k4, () => {
    assert.ok(Object.keys(battleRepositoryOf()).includes("listSettledAfter"));
    const text = fs.readFileSync(REGISTRY_FILE, "utf8").replace(/\r\n/g, "\n");
    assert.ok(text.includes("basePrice: Number.isFinite(Number(entry.basePrice))"), "vendor normalizeEntry basePrice");

    withStore(driver, (h) => {
      const sysB = 30000144;
      h.battle("d1", "COMPLETED", NOW - 5 * HOUR, [[`fa-d1`, A, "frigate", 587, 1]]);
      h.battle("d2", "COMPLETED", NOW - 4 * HOUR, [[`fa-d2`, A, "frigate", 587, 1]], { system: sysB });
      h.battle("d3", "COMPLETED", NOW - 3 * HOUR, [[`fc-d3`, C, "frigate", 587, 1]],
        { input: { sideA: { factionId: C, fleets: [fleet("fc-d3", C)] }, sideB: { factionId: B, fleets: [] } } });
      const views = createViewRegistry();
      const gov = { admit: true };
      const settings = { ...KB_DEFAULTS, enabled: true, pageRows: 10 };
      const ctx = { persistence: { store: h.store }, battle: { repository: battleRepositoryOf() }, views,
        governor: { admits: () => gov.admit },
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === sysB ? { name: "Perimeter",
          security: 0.95 } : null) } }) } };
      const adapter = { readItemTypeFacts: facts({ 587: ["Rifter", 1000] }),
        readFactionNames: () => ({ ok: true, names: new Map([[A, "Amarr Empire"], [B, "Caldari State"]]) }) };
      const started = startKillboard({ config: { killboard: settings, persistence: { maxRowsPerTransaction: 500 } },
        ctx, adapter, clock: { now: () => NOW }, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
      assert.ok(started.ok, JSON.stringify(started));
      assert.strictEqual(started.killboard.runPassNow().ingested, 3);
      const router = createRouter({ views, assets: {}, config: { maxResponseBytes: 1 << 20, refreshSeconds: 5,
        systemCardCacheSlots: 8 }, modVersion: "t", now: () => NOW });
      const get = (q) => {
        const r = router.route({ method: "GET", url: `/api/views/kb-battles${q}`, host: "127.0.0.1" });
        return { status: r.status, body: JSON.parse(r.body) };
      };
      const all = get("");
      assert.strictEqual(all.status, 200);
      assert.deepStrictEqual(all.body.params, {});
      assert.deepStrictEqual(all.body.data.rows.map((r) => r.no), [3, 2, 1], "newest first");
      assert.strictEqual(all.body.data.nextBefore, null);
      const r2 = all.body.data.rows[1];
      assert.deepStrictEqual([r2.systemName, r2.security, r2.a.factions, r2.a.iskLost, r2.iskTotal],
        ["Perimeter", 0.95, [[A, "Amarr Empire", "W"]], 1000, 1000]);
      assert.deepStrictEqual(all.body.data.rows[0].a.factions, [[C, null, "W"]], "no name = null");
      assert.deepStrictEqual(get(`?faction=${A}`).body.data.rows.map((r) => r.no), [2, 1]);
      assert.deepStrictEqual(get(`?system=${sysB}`).body.data.rows.map((r) => r.no), [2]);
      assert.deepStrictEqual(get(`?faction=${B}&before=3`).body.data.rows.map((r) => r.no), [2, 1]);
      assert.deepStrictEqual(get(`?faction=${A}&system=${sysB}`).body.data.rows.map((r) => r.no), [2]);
      assert.deepStrictEqual(get("?before=3").body.params, { before: 3 });
      assert.strictEqual(get("?system=abc").status, 400);
      assert.strictEqual(get("?system=abc").body.error.reason, "BAD_PARAM");

      for (let i = 4; i <= 12; i += 1) h.battle(`e${i}`, "COMPLETED", NOW - 1000 + i, [[`fa-e${i}`, A, "frigate", 587, 1]]);
      started.killboard.runPassNow();
      const p1 = get("").body.data;
      assert.deepStrictEqual([p1.rows.length, p1.rows[0].no, p1.nextBefore], [10, 12, 3]);
      assert.deepStrictEqual(get(`?before=${p1.nextBefore}`).body.data.rows.map((r) => r.no), [2, 1]);

      gov.admit = false;
      const held = get("?faction=999");
      assert.deepStrictEqual(held.body.data, { available: false, reason: "GOVERNOR_HOLD" });
      started.killboard.stop();
      assert.strictEqual(get("").status, 404, "stop unregisters the view");
    });

    withStore(driver, (h) => {
      h.battle("f1", "COMPLETED", NOW - HOUR, [[`fa-f1`, A, "frigate", 587, 1]]);
      const views = createViewRegistry();
      const r = startKillboard({ config: { killboard: { ...KB_DEFAULTS }, persistence: { maxRowsPerTransaction: 500 } },
        ctx: { persistence: { store: h.store }, views }, adapter: null, clock: { now: () => NOW } });
      assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
      const router = createRouter({ views, assets: {}, config: { maxResponseBytes: 65536, refreshSeconds: 5 },
        modVersion: "t", now: () => NOW });
      const res = router.route({ method: "GET", url: "/api/views/kb-battles", host: "127.0.0.1" });
      assert.deepStrictEqual([res.status, JSON.parse(res.body).error.reason], [404, "VIEW_NOT_FOUND"]);
      for (const t of ["kb_battles", "kb_battle_sides", "kb_faction_totals", "kb_type_prices", "kb_cursor"]) {
        assert.strictEqual(h.count(t), 0, t);
      }
    });
  });
};
