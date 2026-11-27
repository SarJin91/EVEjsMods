"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const S = require("../../lib/world/devIndices/schema");
const R = require("../../lib/world/devIndices/rules");
const { startDevIndices, createUnavailableDevIndices, DEV_INDICES_METHODS } = require("../../lib/world/devIndices");
const { createMemoryIndex } = require("../../lib/world/devIndices/memoryIndex");
const V = require("../../lib/world/devIndices/view");
const CMD = require("../../lib/world/devIndices/command");
const { createViewRegistry } = require("../../lib/observer/views");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");
const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

function fakeTimers() {
  const pending = [];
  return {
    pending,
    setTimer(fn, ms) {
      const t = { fn, ms, cancelled: false };
      pending.push(t);
      return { cancel() { t.cancelled = true; }, hasRef: () => false };
    },
    fire() {
      const live = pending.filter((t) => !t.cancelled);
      pending.length = 0;
      live.sort((a, b) => a.ms - b.ms);
      const [first, ...rest] = live;
      pending.push(...rest);
      if (first) first.fn();
      return Boolean(first);
    },
  };
}

function marksShapes() {
  const text = fs.readFileSync(path.join(F.MOD_DIR, "web", "galaxy.js"), "utf8");
  const m = /const MARK_SHAPES = Object\.freeze\(\[([^\]]*)\]/.exec(text);
  assert.ok(m, "MARK_SHAPES in web/galaxy.js");
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function insertRows(store, rows) {
  const r = store.transaction("test.dev.insert", (db) => {
    for (const [id, mil, ind, trade] of rows) {
      db.prepare(`INSERT INTO world_system_dev (system_id, mil_points, ind_points, trade_points, mil_trend, ind_trend,
        trade_trend, controller_faction_id, decay_permille, anchor_at, last_input_at, kill_window_at,
        kill_window_points, invested_isk_total, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, 1, 0, -1, NULL, 1000, ?, ?, 0, 0, 0, ?, ?, 1)`).run(id, mil, ind, trade, F.T0, F.T0, F.T0,
        F.T0);
    }
  });
  assert.ok(r.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();

  test("DI4 service: off = zero timers; stub/facade keys; cold null/[]; warm by pages; DEV_ROW_BOUND; warnings", () => {
    const timers = fakeTimers();
    const off = startDevIndices({ config: F.configOf({ EVEJS_LNE_DEV_INDICES_ENABLED: "0" }).config,
      persistence: { ok: true, store: {} }, clock: { now: () => F.T0 }, setTimer: timers.setTimer });
    assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(timers.pending.length, 0, "zero timers");
    const stub = createUnavailableDevIndices("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub), [...DEV_INDICES_METHODS]);
    assert.deepStrictEqual([stub.getMode(), stub.levelsOf(1), stub.listTop("mil")], ["off", null, []]);
    assert.strictEqual(createUnavailableDevIndices("stopped").getMode(), "stopped");

    const bound = startDevIndices({ config: F.configOf({ EVEJS_LNE_DEV_INDICES_MAX_SYSTEMS_PER_PASS: "600" }).config,
      persistence: { ok: true, store: { limits: { maxRowsPerTransaction: 500 } } }, clock: { now: () => F.T0 },
      setTimer: timers.setTimer });
    assert.deepStrictEqual([bound.ok, bound.reason], [false, "DEV_ROW_BOUND"]);
    assert.strictEqual(timers.pending.length, 0);

    const W = (env) => F.configOf(env).warnings.filter((w) => w.startsWith("devIndices"));
    assert.deepStrictEqual(W(), []);
    assert.strictEqual(W({ EVEJS_LNE_KILLBOARD_ENABLED: "0" }).length, 2, "W94 + W95");
    assert.ok(W({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "150" }).some((w) => w.includes("DEV_ROW_BOUND")));
    assert.deepStrictEqual(W({ EVEJS_LNE_DEV_INDICES_ENABLED: "0" }), []);
    assert.strictEqual(W({ EVEJS_LNE_DEV_INDICES_ENABLED: "0", EVEJS_LNE_DEV_INDICES_COMMAND_ENABLED: "1" }).length, 1);
    assert.ok(W({ EVEJS_LNE_DEV_INDICES_DECAY_POINTS_PER_HOUR: "1", EVEJS_LNE_DEV_INDICES_REFRESH_MIN_AGE_MS: "600000" })
      .some((w) => w.includes("refreshMinAgeMs")), "W193");

    if (!driver.ok) return;
    withStore(driver, (opened) => {
      insertRows(opened.store, [[1, 2500, 0, 1200], [2, 400, 0, 0], [3, 5000, 0, 0]]);
      const t = fakeTimers();
      const views = createViewRegistry();
      const started = startDevIndices({ config: F.configOf({ EVEJS_LNE_DEV_INDICES_INDEX_PAGE_ROWS: "50",
        EVEJS_LNE_OBSERVER_GALAXY_ENABLED: "0" }).config,
        persistence: opened, clock: { now: () => F.T0 }, setTimer: t.setTimer, views,
        getGraph: () => F.makeGraph(), getWorldRepository: () => F.makeWorld({}) });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const dev = started.devIndices;
      assert.deepStrictEqual(Object.keys(dev), [...DEV_INDICES_METHODS]);
      assert.deepStrictEqual([dev.getMode(), dev.levelsOf(1), dev.listTop("mil")], ["warming", null, []]);
      assert.ok(t.fire(), "the warm load timer");
      assert.strictEqual(dev.getMode(), "on");
      assert.deepStrictEqual(dev.levelsOf(1), { mil: 2, ind: 0, trade: 1, milPoints: 2500, indPoints: 0,
        tradePoints: 1200, trend: { mil: 1, ind: 0, trade: -1 }, controllerFactionId: null });
      assert.deepStrictEqual(dev.listTop("mil"), [{ systemId: 3, level: 5, points: 5000 },
        { systemId: 1, level: 2, points: 2500 }]);
      assert.strictEqual(dev.getStatus().tracked, 3);
      assert.deepStrictEqual(views.listViews().map((v) => v.id), [S.VIEW_ID], "no layer without galaxyEnabled");
      dev.stop("test");
      assert.deepStrictEqual([dev.getMode(), dev.levelsOf(1), views.listViews().length], ["stopped", null, 0]);
    });
  });

  test("DI5 views and !dev: layer marks order 7, legend shapes, panel order 74, galaxy gate, chat replies", () => {
    const P = F.settingsFor();
    const clock = { t: F.T0, now() { return this.t; } };
    const memory = createMemoryIndex({ P, clock });
    const layer = V.buildDevLayer({ memory, settings: P, clock });
    assert.deepStrictEqual([layer.listed, layer.mapLayer], [false, { kind: "marks", order: 7 }]);
    assert.deepStrictEqual(layer.getData(), { available: false, reason: "WARMING" });
    const row = (id, mil, ind, trade) => Object.freeze({ ...R.emptyRow(id, F.T0), mil, ind, trade, milTrend: 1,
      tradeTrend: -1, lastInputAt: F.T0, version: 1 });
    memory.loadPage([row(2, 3120, 1040, 2210), row(1, 1500, 2600, 0), row(3, 900, 0, 0)]);
    memory.markWarm();
    const data = layer.getData();
    assert.deepStrictEqual(data.items, [[1, "dev-ind", "2", ["MIL 1+ IND 2 TRADE 0-"], null],
      [2, "dev-mil", "3", ["MIL 3+ IND 1 TRADE 2-"], null]]);
    const shapes = marksShapes();
    assert.ok(data.legend.every((l) => l.length === 4 && shapes.includes(l[3])), JSON.stringify(data.legend));
    assert.match(layer.cacheKey(), /^d\d+:\d+$/);
    const panel = V.buildDevPanel({ memory, settings: P, clock, getStatus: () => ({ cursors: [] }),
      systemNameOf: (id) => `Sys${id}` });
    assert.deepStrictEqual([panel.order, panel.listed], [74, true]);
    assert.deepStrictEqual(panel.getData().top.mil[0], { systemId: 2, level: 3, points: 3120, system: "Sys2" });

    if (driver.ok) {
      withStore(driver, (opened) => {
        const views = createViewRegistry();
        const r = startDevIndices({ config: F.configOf().config,
          persistence: opened, clock, setTimer: fakeTimers().setTimer, views });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual([views.getView(S.LAYER_ID).mapLayer, views.getView(S.VIEW_ID).order],
          [{ kind: "marks", order: 7 }, 74]);
        r.devIndices.stop("test");
      });
    }

    const bumps = [];
    let warm = false;
    const chat = CMD.createDevChat({ levelsOf: (id) => (warm ? memory.levelsOf(id) : null), settings: P, clock,
      isRunning: () => true, systemNameOf: (id) => (id === 2 ? "Akidagi" : `Sys${id}`), bump: (n) => bumps.push(n) });
    const rec = { characterId: 90000001, systemId: 2 };
    assert.strictEqual(chat.handle(rec, "!dev"), "Dev: indices warming up");
    warm = true;
    clock.t += P.commandCooldownMs;
    assert.strictEqual(chat.handle(rec, "!dev"), "Dev Akidagi: MIL 3+ (3120) | IND 1 (1040) | TRADE 2- (2210)");
    assert.match(chat.handle(rec, "!dev"), /^Dev: wait \d+s before the next !dev$/);
    assert.strictEqual(chat.handle({ characterId: 90000002, systemId: 9 }, "!dev"), "Dev Sys9: MIL 0 | IND 0 | TRADE 0");
    assert.strictEqual(chat.handle({ characterId: 90000003 }, "!dev"), "Dev: no system");
    assert.strictEqual(chat.handle(rec, "!dev help"), "Dev: !dev = development indices of this system");
    assert.deepStrictEqual([CMD.matchDevCommand("!DEV"), CMD.matchDevCommand("!devx")], [true, false]);
    assert.deepStrictEqual(bumps, ["command.unavailable", "command.replies", "command.rateLimited", "command.replies"]);
    const installs = [];
    assert.strictEqual(CMD.installDevCommand({ installChatCommand: (o) => {
      installs.push(o.name);
      return { ok: true };
    } }, chat).ok, true);
    assert.deepStrictEqual(installs, ["dev"]);
  });

  test("DI W97/W195: flags without devIndices.enabled; stationsEnabled without construction / strategy", () => {
    const W = (env) => F.configOf(env).warnings.filter((w) => w.startsWith("devIndices"));
    for (const k of ["STATIONS_ENABLED", "CLIENT_INDICES_ENABLED"]) {
      assert.strictEqual(W({ EVEJS_LNE_DEV_INDICES_ENABLED: "0", [`EVEJS_LNE_DEV_INDICES_${k}`]: "1" }).length, 1, k);
    }
    const w195 = (env) => W({ EVEJS_LNE_DEV_INDICES_STATIONS_ENABLED: "1", ...env })
      .filter((w) => w.includes("no developed station"));
    assert.strictEqual(w195({ EVEJS_LNE_CONSTRUCTION_ENABLED: "0" }).length, 1, "W195 construction off");
    assert.strictEqual(w195({ EVEJS_LNE_CONSTRUCTION_ENABLED: "1", EVEJS_LNE_STRATEGY_ENABLED: "0" }).length, 1,
      "W195 strategy off");
    assert.strictEqual(w195({ EVEJS_LNE_CONSTRUCTION_ENABLED: "1", EVEJS_LNE_STRATEGY_ENABLED: "1" }).length, 0);
  });

  const composeFile = findCompose();
  if (!composeFile) {
    skip("DICOMP dev indices compose keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("DICOMP compose: every devIndices.* SCHEMA key has a ${NAME:-...} line, booleans default \"\" or \"0\"", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const rows = config.SCHEMA.filter((row) => row.key.startsWith("devIndices."));
      assert.ok(rows.length >= 71, `devIndices.* SCHEMA rows: ${rows.length}`);
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
      assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
      const noDefault = rows.filter((row) => !text.includes(`\${${row.env}:-`)).map((row) => row.env);
      assert.deepStrictEqual(noDefault, [], `no \${NAME:-} line: ${noDefault.join(", ")}`);
      const flags = rows.filter((row) => row.type === "boolean");
      assert.ok(flags.length >= 10,`devIndices.* boolean rows: ${flags.length}`);
      const wrong = flags.filter((row) => env[row.env] !== "" && env[row.env] !== "0")
        .map((row) => `${row.env}=${env[row.env]}`);
      assert.deepStrictEqual(wrong, [], `flags with a default other than "" / 0: ${wrong.join(", ")}`);
      for (const k of ["STATIONS_ENABLED", "CLIENT_INDICES_ENABLED"]) {
        assert.strictEqual(env[`EVEJS_LNE_DEV_INDICES_${k}`], "0", `${k} :-0`);
      }
    });
  }
};
