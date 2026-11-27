"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { startFleets } = require("../../lib/fleets");
const { LAYER_ID } = require("../../lib/fleets/parkedFleetsLayer");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION = 500019;
const SYS_A = 30000142;
const SYS_B = 30000144;
const SYS_C = 30002187;
const SYS_D = 30002510;
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", count: 5 }, { hullGroup: "cruiser", count: 3 }]);
const OBSERVER = Object.freeze({ galaxyEnabled: true, galaxyFleetsEnabled: false, galaxyParkedFleetsEnabled: true,
  galaxyParkedFleetsMaxSystems: 1000, galaxyParkedFleetsMaxLines: 8, galaxyParkedFleetsRefreshMs: 15000 });

function configWith(observer = {}) {
  return { enabled: true, modules: { fleets: { enabled: true } }, limits: { maxVirtualFleets: 2000 },
    persistence: { journalMaxPayloadBytes: 8192 },
    fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
      maxListLimit: 500 },
    observer: { ...OBSERVER, ...observer } };
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-p-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 5000, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(opened);
  } finally {
    if (store) store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function boot(opened, observer) {
  const clock = createManualClock(START_MS);
  const views = createViewRegistry();
  const observed = [];
  let hold = false;
  let txCalls = 0;
  const real = opened.store;
  const store = { ...real, transaction: (name, fn) => {
    if (name === "observer.galaxyParkedFleets") txCalls += 1;
    return real.transaction(name, fn);
  } };
  const persistence = { ok: true, store, journal: createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 }),
    worldSeed: opened.worldSeed };
  const fr = startFleets({ config: configWith(observer), persistence, clock,
    ids: createIdGenerator({ clock, rng: createRng(3) }), views,
    telemetry: { observe: (name, v) => observed.push([name, v]) },
    getGovernor: () => ({ admits: () => !hold }) });
  assert.ok(fr.ok, JSON.stringify(fr));
  return { clock, views, fleets: fr.fleets, observed, store: real, setHold: (v) => { hold = v; },
    txCalls: () => txCalls };
}

function seed(env, rows) {
  const made = env.fleets.createFleet({ factionId: FACTION, currentSystemId: SYS_A, homeSystemId: SYS_A,
    fleetRole: "invasion", composition: COMPOSITION }, "p:template");
  assert.strictEqual(made.ok, true, JSON.stringify(made));
  const r = env.store.transaction("test", (db) => {
    const cols = db.prepare("SELECT name FROM pragma_table_info('virtual_fleets')").all().map((c) => c.name);
    const set = { fleet_id: "?", current_system_id: "?", state: "?", ship_count: "?", faction_id: "?" };
    const sql = `INSERT INTO virtual_fleets (${cols.join(", ")}) SELECT ${cols.map((c) => set[c] || c).join(", ")}
      FROM virtual_fleets WHERE fleet_id = ?`;
    const ins = db.prepare(sql);
    const order = cols.filter((c) => set[c]);
    for (const [fleetId, systemId, state, ships, factionId] of rows) {
      const v = { fleet_id: fleetId, current_system_id: systemId, state, ship_count: ships,
        faction_id: factionId || FACTION };
      ins.run(...order.map((c) => v[c]), made.fleetId);
    }
    db.prepare("DELETE FROM virtual_fleets WHERE fleet_id = ?").run(made.fleetId);
    return true;
  });
  assert.ok(r.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PF1 parked fleets layer: one mark per system, dominant state by priority, legend shapes", () => {
    withStore(driver, (opened) => {
      const env = boot(opened);
      seed(env, [["fa1", SYS_A, "IDLE", 10], ["fa2", SYS_A, "STAGED", 20], ["fa3", SYS_A, "ENGAGED", 30],
        ["fb1", SYS_B, "REFITTING", 5], ["fc1", SYS_C, "PLANNED", 7], ["ft1", SYS_D, "TRAVELLING", 9]]);
      assert.deepStrictEqual(env.views.listMapLayers().map((l) => [l.id, l.kind]), [[LAYER_ID, "marks"]]);
      const data = env.views.getView(LAYER_ID).getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.legend.map((l) => [l[0], l[3]]),
        [["engaged", "diamond2"], ["staged", "diamond"], ["refitting", "diamond"], ["idle", "diamond"]]);
      const bySys = new Map(data.items.map((it) => [it[0], it]));
      assert.deepStrictEqual([...bySys.keys()].sort(), [SYS_A, SYS_B, SYS_C].sort(), "TRAVELLING not shown");
      assert.strictEqual(bySys.get(SYS_A)[1], "engaged");
      assert.strictEqual(bySys.get(SYS_B)[1], "refitting");
      assert.strictEqual(bySys.get(SYS_C)[1], "staged", "PLANNED in the staged style (P1)");
      assert.strictEqual(bySys.get(SYS_A)[2], "3/60");
      const lines = bySys.get(SYS_A)[3];
      assert.strictEqual(lines[0], "ENGAGED 1 · STAGED 1 · IDLE 1 - 60 ships");
      assert.strictEqual(lines.length, 4);
      assert.strictEqual(lines[1], "fa1 - faction 500019 - IDLE - 10 ships - op -");
      assert.strictEqual(bySys.get(SYS_C)[3][1].includes("PLANNED"), true, "the tooltip shows the real state");
      assert.match(data.note, /^5 parked fleets in 3 systems/);
      env.fleets.stop("test");
      assert.strictEqual(env.views.getView(LAYER_ID), null, "unregistered on stop");
    });
  });

  needsDriver("PF2 limits: maxLines + '+N more', maxSystems keeps the engaged system, 0 = no transaction", () => {
    withStore(driver, (opened) => {
      const rows = [["a1", SYS_A, "IDLE", 1], ["a2", SYS_A, "IDLE", 1], ["a3", SYS_A, "IDLE", 1],
        ["a4", SYS_A, "IDLE", 1], ["b1", SYS_B, "ENGAGED", 2], ["c1", SYS_C, "STAGED", 3]];
      const lines = boot(opened, { galaxyParkedFleetsMaxLines: 2 });
      seed(lines, rows);
      const a = lines.views.getView(LAYER_ID).getData().items.find((it) => it[0] === SYS_A);
      assert.deepStrictEqual(a[3].slice(1), ["a1 - faction 500019 - IDLE - 1 ships - op -",
        "a2 - faction 500019 - IDLE - 1 ships - op -", "+2 more"]);
      lines.fleets.stop("test");

      const one = boot(opened, { galaxyParkedFleetsMaxSystems: 1 });
      const d1 = one.views.getView(LAYER_ID).getData();
      assert.deepStrictEqual(d1.items.map((it) => [it[0], it[1]]), [[SYS_B, "engaged"]]);
      assert.match(d1.note, /\(truncated\)$/);
      one.fleets.stop("test");

      const none = boot(opened, { galaxyParkedFleetsMaxSystems: 0 });
      const d0 = none.views.getView(LAYER_ID).getData();
      assert.deepStrictEqual([d0.available, d0.items.length, none.txCalls()], [true, 0, 0]);
      none.fleets.stop("test");

      const noLines = boot(opened, { galaxyParkedFleetsMaxLines: 0 });
      const z = noLines.views.getView(LAYER_ID).getData().items.find((it) => it[0] === SYS_A);
      assert.deepStrictEqual(z[3].slice(1), ["+4 more"]);
      noLines.fleets.stop("test");
    });
  });

  needsDriver("PF3 cache bucket, governor HOLD without a transaction, 1000 fleets cost + metric, flag off", () => {
    withStore(driver, (opened) => {
      const env = boot(opened);
      const states = ["IDLE", "STAGED", "REFITTING", "ENGAGED", "PLANNED"];
      seed(env, Array.from({ length: 1000 }, (_, i) => [`f${String(i).padStart(4, "0")}`, 30000001 + (i % 300),
        states[i % states.length], 10 + (i % 7)]));
      const view = env.views.getView(LAYER_ID);
      env.clock.advance(15000 - (START_MS % 15000));
      const key = view.cacheKey();
      env.clock.advance(14999);
      assert.strictEqual(view.cacheKey(), key, "same bucket");
      const t0 = performance.now();
      const data = view.getData();
      const ms = performance.now() - t0;
      assert.ok(ms < 200, `getData ${ms} ms`);
      assert.strictEqual(data.items.length, 300);
      assert.strictEqual(data.items.reduce((s, it) => s + it[3].length, 0) <= 300 * (1 + 8 + 1), true);
      assert.ok(env.observed.some(([name, v]) => name === "observer.galaxyParkedMs" && v >= 0), "metric observed");
      env.clock.advance(1);
      assert.notStrictEqual(view.cacheKey(), key, "a new time bucket");
      const before = env.txCalls();
      env.setHold(true);
      assert.strictEqual(view.cacheKey(), null);
      assert.strictEqual(view.getData().reason, "GOVERNOR_HOLD");
      assert.strictEqual(env.txCalls(), before, "HOLD touches no database");
      env.fleets.stop("test");

      const off = boot(opened, { galaxyParkedFleetsEnabled: false });
      assert.strictEqual(off.views.getView(LAYER_ID), null, "flag off -> not registered");
      off.fleets.stop("test");
      const noGalaxy = boot(opened, { galaxyEnabled: false });
      assert.strictEqual(noGalaxy.views.getView(LAYER_ID), null, "galaxyEnabled off -> not registered");
      noGalaxy.fleets.stop("test");
    });
  });

  test("PF4 client marks shape: diamond2 kept, missing / unknown -> ring, legend carries the shape", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const pure = sandbox.window.LneGalaxy._pure;
    const marks = pure.ingestMarks({ legend: [["engaged", "engaged", "#ff2850", "diamond2"],
      ["idle", "idle", "#c0c8d4"], ["odd", "odd", "#123456", "bogus"]],
    items: [[SYS_A, "engaged", "1/3", ["h"]], [SYS_B, "idle", "2/4", null], [SYS_C, "odd", null, null],
      [SYS_D, "nope", null, null]] }, new Map([[SYS_A, 0], [SYS_B, 1], [SYS_C, 2], [SYS_D, 3]]));
    assert.strictEqual(marks.byIndex.get(0).shape, "diamond2");
    assert.strictEqual(marks.byIndex.get(0).color, "#ff2850");
    assert.strictEqual(marks.byIndex.get(1).shape, "ring", "no fourth field -> ring");
    assert.strictEqual(marks.byIndex.get(2).shape, "ring", "unknown shape -> ring");
    assert.strictEqual(marks.byIndex.get(3).shape, "ring", "unknown style -> ring");
    assert.strictEqual(marks.legend.map((l) => l[2]).join(","), "diamond2,ring,ring");
  });

  needsDriver("PF5 factions: dominant state beats count, totals unchanged, tooltip line, legend dash", () => {
    withStore(driver, (opened) => {
      const env = boot(opened);
      const FA = 500001;
      const FB = 500002;
      seed(env, [["fa1", SYS_A, "IDLE", 10, FA], ["fa2", SYS_A, "IDLE", 5, FA], ["fb1", SYS_A, "ENGAGED", 7, FB],
        ["fc1", SYS_B, "IDLE", 3]]);
      const data = env.views.getView(LAYER_ID).getData();
      assert.deepStrictEqual(data.legend.map((l) => [l[0], l[4], l[5]]), [["engaged", null, "solid"],
        ["staged", null, "dashed"], ["refitting", null, "dashdot"], ["idle", null, "dotted"]]);
      const a = data.items.find((it) => it[0] === SYS_A);
      assert.deepStrictEqual([a[1], a[2]], ["engaged", "3/22"], "counts / fleets / ships as before");
      assert.deepStrictEqual(a[4], [[FB, 1], [FA, 2]], "factions[0] = dominant state (ENGAGED) before the count");
      assert.strictEqual(a[3][0], "ENGAGED 1 · IDLE 2 - 22 ships");
      assert.strictEqual(a[3][1], `factions ${FB} 1/7 · ${FA} 2/15`);
      const b = data.items.find((it) => it[0] === SYS_B);
      assert.deepStrictEqual(b[4], [[FACTION, 1]]);
      assert.strictEqual(b[3].some((l) => l.startsWith("factions ")), false, "one faction -> no factions line");
      env.fleets.stop("test");
    });
  });
};
