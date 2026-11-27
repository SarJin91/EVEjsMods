"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createFreeCorpVentureRepository } = require("../../lib/freeCorps/ventureRepository");
const { createResidentReads } = require("../../lib/freeCorps/residentReads");
const V = require("../../lib/freeCorps/ventures");
const { loadDriver } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const T0 = 2000000000000;
const A = 30000001;
const B = 30000002;
const J = 31000001;
const COLS74 = ["venture_id", "corp_id", "seq", "kind", "state", "open", "home_system_id", "system_id",
  "target_system_id", "target_station_id", "sec_band", "jumps", "crew", "crew_lost", "step", "travel_steps",
  "work_steps", "steps_total", "holds", "yield_isk", "cost_isk", "started_at", "step_due_at", "updated_at", "ended_at",
  "end_reason", "version"];

const plain = (rows) => rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k,
  typeof v === "bigint" ? Number(v) : v])));
const all = (opened, sql, ...args) => {
  const r = opened.store.transaction("t.all", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return plain(r.value);
};
const run = (opened, sql, ...args) => opened.store.transaction("t.run", (db) => db.prepare(sql).run(...args));

function seedCorp(opened) {
  const r = run(opened, "INSERT INTO world_free_corps (corp_id, archetype, state, open, name, ticker, sec_band, "
    + "home_system_id, home_station_id, home_station_corp_id, race_faction_id, members_target, corporation_id, isk, "
    + "struggle_count, seed, name_attempt, venture_seq, next_at, founded_at, updated_at, version) VALUES (1, "
    + "'explorer', 'ACTIVE', 1, 'Corp 1', 'TC1', 'highsec', ?, 60000001, 1000100, 500001, 5, 98000001, 1000, 0, 7, 0, "
    + "3, ?, ?, ?, 1)", A, T0, T0, T0);
  assert.ok(r.ok, JSON.stringify(r));
}

function insert74(opened, v) {
  const r = run(opened, `INSERT INTO world_free_corp_ventures (${COLS74.join(", ")}) VALUES (${COLS74.map(() => "?")
    .join(", ")})`, ...COLS74.map((c) => v[c]));
  assert.ok(r.ok, JSON.stringify(r));
}

const v74 = (o) => ({ venture_id: `fcv:1:${o.seq}`, corp_id: 1, seq: o.seq, kind: "MINE", state: o.state,
  open: o.open, home_system_id: A, system_id: B, target_system_id: B, target_station_id: null, sec_band: "highsec",
  jumps: 1, crew: 3, crew_lost: 0, step: o.step, travel_steps: 1, work_steps: 2, steps_total: 4, holds: 0,
  yield_isk: 4000000, cost_isk: 0, started_at: T0 - 5000, step_due_at: T0 + 900000, updated_at: T0,
  ended_at: o.open ? null : T0 - 10, end_reason: o.open ? null : "DONE", version: 2 });

const whRow = (o = {}) => ({ venture_id: "fcv:1:3", corp_id: 1, seq: 3, kind: "EXPLORE_WH", state: "STRANDED",
  open: 1, home_system_id: A, system_id: J, target_system_id: J, target_station_id: null, sec_band: "wormhole",
  jumps: 2, crew: 3, crew_lost: 0, step: 2, travel_steps: 1, work_steps: 3, steps_total: 5, holds: 0, yield_isk: 0,
  cost_isk: 0, started_at: T0, step_due_at: T0, updated_at: T0, ended_at: null, end_reason: null, version: 1,
  wh_route: JSON.stringify([J, B]), wh_entry_system_id: B, stranded_steps: 1, ...o });

const NEW_FIELDS = ["wh_route", "wh_entry_system_id", "stranded_steps"];
const without = (row) => Object.fromEntries(Object.entries(row).filter(([k]) => !NEW_FIELDS.includes(k)));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FC6-4 migration 75 keeps the 74 rows bit for bit, STRANDED only for EXPLORE_WH, residents of J read the "
    + "STRANDED venture; flag off = plans, open EXPLORE_WH returns WH_OFFLINE", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 76, "migration 76 (wars) after 75");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-fc6-"));
    const file = path.join(tmp, "world.sqlite");
    const open = (migrations) => openStore({ filePath: file, openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations });
    const indexSql = "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = "
      + "'world_free_corp_ventures' AND sql IS NOT NULL ORDER BY name";
    try {
      const at74 = open(MIGRATIONS.slice(0, 74));
      assert.ok(at74.ok, JSON.stringify(at74));
      seedCorp(at74);
      insert74(at74, v74({ seq: 1, state: "DONE", open: 0, step: 4 }));
      insert74(at74, v74({ seq: 2, state: "WORKING", open: 1, step: 2 }));
      const before = all(at74, `SELECT ${COLS74.join(", ")} FROM world_free_corp_ventures ORDER BY venture_id`);
      const idxBefore = all(at74, indexSql).map((x) => x.name);
      at74.store.close("test");

      const at75 = open(MIGRATIONS);
      assert.ok(at75.ok, JSON.stringify(at75));
      try {
        assert.deepStrictEqual(all(at75, `SELECT ${COLS74.join(", ")} FROM world_free_corp_ventures ORDER BY venture_id`),
          before, "the 27 columns bit for bit");
        assert.deepStrictEqual(all(at75, "SELECT wh_route, wh_entry_system_id, stranded_steps FROM "
          + "world_free_corp_ventures ORDER BY venture_id"), [{ wh_route: null, wh_entry_system_id: null,
          stranded_steps: 0 }, { wh_route: null, wh_entry_system_id: null, stranded_steps: 0 }]);
        assert.deepStrictEqual(all(at75, indexSql).map((x) => x.name), idxBefore);
        assert.deepStrictEqual(idxBefore, ["world_free_corp_ventures_ended", "world_free_corp_ventures_open",
          "world_free_corp_ventures_system"]);
        assert.strictEqual(all(at75, "SELECT COUNT(*) AS n FROM sqlite_master WHERE name = "
          + "'world_free_corp_ventures_v75'")[0].n, 0);

        const repo = createFreeCorpVentureRepository();
        run(at75, "UPDATE world_free_corp_ventures SET state = 'DONE', open = 0, ended_at = ?, end_reason = 'DONE' "
          + "WHERE venture_id = 'fcv:1:2'", T0);
        const ok = at75.store.transaction("t.v", (db) => repo.insertInTx(db, whRow(), T0));
        assert.ok(ok.ok && ok.value.ok, JSON.stringify(ok));
        const bad = run(at75, "UPDATE world_free_corp_ventures SET state = 'STRANDED', open = 1, ended_at = NULL, "
          + "end_reason = NULL WHERE venture_id = 'fcv:1:1'");
        assert.ok(bad.ok === false && /CHECK constraint failed/.test(String(bad.error && bad.error.message)),
          `STRANDED MINE refused by the CHECK: ${JSON.stringify(bad)} ${bad.error && bad.error.message}`);
        const got = all(at75, "SELECT state, wh_route, stranded_steps FROM world_free_corp_ventures WHERE seq = 3");
        assert.deepStrictEqual(got, [{ state: "STRANDED", wh_route: JSON.stringify([J, B]), stranded_steps: 1 }]);

        const reads = createResidentReads();
        const res = at75.store.transaction("t.r", (db) => reads.venturesInSystemInTx(db, J, 10));
        assert.ok(res.ok, JSON.stringify(res));
        assert.deepStrictEqual(res.value.rows.map((x) => ({ ...x })), [{ corpId: 1, systemId: J, crew: 3 }]);
      } finally {
        at75.store.close("test");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    const resolved = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
    assert.deepStrictEqual(resolved.errors, []);
    const f = resolved.config.freeCorps;
    assert.strictEqual(f.wormholes.enabled, false, "default off");
    const S = { ...f, ventures: { ...f.ventures, enabled: true } };
    const { wormholes: _w, ...noSection } = S;
    const corp = (seed) => ({ corp_id: 1, archetype: "explorer", state: "ACTIVE", open: 1, sec_band: "highsec",
      home_system_id: A, members_target: 5, isk: 200000000, struggle_count: 0, seed, venture_seq: 0, recover_until: 0,
      recover_crew: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0, isk_lost: 0, last_review_at: 0,
      ended_at: null, end_reason: null });
    const env = { now: T0, linkedCount: 5, memberRoom: 0,
      reachOf: () => Object.freeze([{ systemId: A, jumps: 0, secClass: "highsec" },
        { systemId: B, jumps: 1, secClass: "highsec" }]),
      beltsOf: (id) => (id === B ? 2 : null), stationsOf: () => [], isObserved: () => false };
    for (let seed = 1; seed <= 20; seed += 1) {
      const on = V.planVenture(corp(seed), env, S);
      const off = V.planVenture(corp(seed), env, noSection);
      assert.ok(on.ok && off.ok, `seed ${seed}`);
      assert.notStrictEqual(on.row.kind, "EXPLORE_WH");
      assert.deepStrictEqual(without(on.row), without(off.row), `seed ${seed}`);
      assert.deepStrictEqual(NEW_FIELDS.map((k) => on.row[k]), [null, null, 0]);
    }
    const working = whRow({ state: "WORKING", stranded_steps: 0 });
    const out = V.stepCorpVenture({ ...corp(7), venture_seq: 3 }, working, env, S);
    assert.deepStrictEqual([out.venture.row.state, out.venture.row.end_reason, out.venture.row.system_id,
      out.venture.row.steps_total, out.venture.row.crew_lost, out.corp.ventures_lost],
    ["RETURNING", "WH_OFFLINE", B, 2 + 1, 0, 0]);
  });
};
