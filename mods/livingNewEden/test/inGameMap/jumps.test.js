"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const crypto = require("node:crypto");

const config = require("../../config");
const { countJumps, mergeLeg, pruneLegs, createLegState, allLegs, cutStaleLegs } = require("../../lib/inGameMap/jumps");
const { createTrafficTracker } = require("../../lib/inGameMap/trafficTracker");
const { startInGameMap } = require("../../lib/inGameMap");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const overlay = require("../../lib/adapter/starmapOverlay");
const { functionBody } = require("../../lib/adapter/essRepositoryFast");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const TELEMETRY_FILE = path.join(SERVER_SRC, "services", "map", "mapTelemetryState.js");
const MAP_FILE = path.join(SERVER_SRC, "services", "map", "mapService.js");
const MIN = 60000;
const HOUR = 3600000;
const D = 1800000000000;
const S = [30000001, 30000002, 30000003, 30000004];

function readSource(abs) {
  return fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");
}

function route(systems, departAt, jumpMs = MIN) {
  return { v: 1, mode: "travel", systems, departAt, jumpMs, arriveAt: departAt + (systems.length - 1) * jumpMs,
    graphVersion: 1, observed: false };
}

function fleet(fleetId, legSeq, r, shipCount = 5, state = "TRAVELLING") {
  return { fleetId, legSeq, route: r, shipCount, state };
}

const toObj = (m) => Object.fromEntries([...m].sort((a, b) => a[0] - b[0]));

function vendorFunction(events) {
  const body = functionBody(readSource(TELEMETRY_FILE), "listJumpHistoryRows");
  const toPositiveInteger = (value, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const t = Math.trunc(n);
    return t > 0 ? t : fallback;
  };
  return vm.runInThisContext(`(function (toPositiveInteger, readJumpEvents) {\n${body}\nreturn listJumpHistoryRows;\n})`)(
    toPositiveInteger, () => events.current);
}

module.exports = ({ test, skip }) => {
  test("J1 countJumps + mergeLeg: window edges as the vendor, cutAt, weight per ship, known / invalid", () => {
    const state = createLegState();
    assert.strictEqual(mergeLeg(state, fleet("f1", 1, route(S, D)), { perShip: true }), "added");
    assert.strictEqual(mergeLeg(state, fleet("f1", 1, route(S, D)), { perShip: true }), "known");
    assert.strictEqual(mergeLeg(state, fleet("f2", 1, { ...route(S, D), arriveAt: 1 }), { perShip: true }), "invalid");
    const legs = () => allLegs(state);
    assert.deepStrictEqual(toObj(countJumps(legs(), D + 2 * MIN, HOUR)), { [S[1]]: 5, [S[2]]: 5 });
    assert.deepStrictEqual(toObj(countJumps(legs(), D + MIN + HOUR, HOUR)), { [S[1]]: 5, [S[2]]: 5, [S[3]]: 5 });
    assert.deepStrictEqual(toObj(countJumps(legs(), D + MIN + HOUR + 1, HOUR)), { [S[2]]: 5, [S[3]]: 5 });
    assert.strictEqual(mergeLeg(state, fleet("f1", 2, route([S[1], S[0]], D + 2 * MIN)), { perShip: true }), "added");
    assert.strictEqual(mergeLeg(state, fleet("f1", 1, route(S, D)), { perShip: true }), "known", "an older legSeq");
    assert.deepStrictEqual(toObj(countJumps(legs(), D + 10 * MIN, HOUR)), { [S[0]]: 5, [S[1]]: 5 });
    assert.strictEqual(state.size, 2);
    assert.strictEqual(mergeLeg(state, fleet("f1", 3, route([S[0], S[3]], D + 4 * MIN)), { perShip: true }), "added");
    assert.strictEqual(state.legs.get("f1").length, 2);
    assert.strictEqual(state.size, 2);
    const one = createLegState();
    mergeLeg(one, fleet("a", 1, route(S, D), 9), { perShip: false });
    mergeLeg(one, fleet("b", 1, route(S, D), 0), { perShip: true });
    assert.deepStrictEqual(toObj(countJumps(allLegs(one), D + 3 * MIN, HOUR)), { [S[1]]: 2, [S[2]]: 2, [S[3]]: 2 });
    assert.deepStrictEqual(pruneLegs(one, D + 3 * MIN + 24 * HOUR + 1, { maxTrackedLegs: 10 }), { pruned: 2, evicted: 0 });
    assert.strictEqual(one.size, 0);
  });

  test("J2 tracker: pages + setImmediate, governor hold, eviction, 24 h prune, no double count", async () => {
    const now = { t: D + 10 * MIN };
    const rows = { TRAVELLING: ["a", "b", "c", "d", "e"].map((id, i) => fleet(id, 1, route(S, D + i * MIN), 1)),
      RETREATING: [fleet("r", 1, route([S[3], S[2]], D), 2, "RETREATING")] };
    const calls = [];
    const repository = { listFleetsByState(tx, state, opts) {
      assert.ok(tx, "inside a transaction");
      calls.push([state, opts.afterFleetId, opts.limit]);
      const list = rows[state].filter((f) => f.fleetId > opts.afterFleetId).slice(0, opts.limit);
      return { ok: true, fleets: list, nextAfterFleetId: list.length === opts.limit ? list[list.length - 1].fleetId : null };
    } };
    const txNames = [];
    const store = { transaction(name, fn) {
      txNames.push(name);
      return { ok: true, value: fn({}) };
    } };
    const gov = { admit: true };
    const metrics = [];
    const make = (over = {}) => createTrafficTracker({ fleets: { repository }, store, clock: { now: () => now.t },
      getGovernor: () => ({ admits: (c) => (c === "MAINTENANCE" ? gov.admit : true) }),
      settings: { starmapJumpsPerShip: true, starmapScanMs: 30000, starmapScanPageSize: 2, starmapMaxScanFleets: 100,
        starmapMaxTrackedLegs: 100, ...over }, maxListLimit: 500,
      telemetry: { count: (n, v) => metrics.push([n, v]), observe: (n) => metrics.push([n]), gauge: (n, v) => metrics.push([n, v]) } });
    const tracker = make();
    const pending = tracker.scanNow();
    assert.strictEqual(calls.length, 1, "one page per turn of the loop (setImmediate between pages)");
    await pending;
    assert.deepStrictEqual(calls, [["TRAVELLING", "", 2], ["TRAVELLING", "b", 2], ["TRAVELLING", "d", 2],
      ["RETREATING", "", 2]]);
    assert.ok(txNames.every((n) => n === "inGameMap.scan"));
    assert.deepStrictEqual(tracker.status(), { legs: 6, lastScanAt: now.t, scans: 1, skipped: 0, partial: 0,
      lastScanComplete: true, lastPartialReason: null, staleCuts: 0 });
    const first = toObj(tracker.jumpCounts(HOUR));
    await tracker.scanNow();
    assert.strictEqual(tracker.status().legs, 6, "the same legs again = known");
    assert.deepStrictEqual(toObj(tracker.jumpCounts(HOUR)), first, "no double count");
    assert.strictEqual(first[S[2]], 5 + 2, "five fleets of 1 ship into S[2] and the retreat of 2 ships");
    assert.ok(metrics.some(([n]) => n === "inGameMap.starmap.scans") && metrics.some(([n]) => n === "inGameMap.starmap.scanMs")
      && metrics.some(([n, v]) => n === "inGameMap.starmap.trackedLegs" && v === 6), JSON.stringify(metrics));

    gov.admit = false;
    await tracker.scanNow();
    assert.deepStrictEqual(tracker.status(), { legs: 6, lastScanAt: now.t, scans: 2, skipped: 1, partial: 0,
      lastScanComplete: true, lastPartialReason: null, staleCuts: 0 }, "hold: old legs stay");
    gov.admit = true;

    const capped = make({ starmapMaxTrackedLegs: 4, starmapMaxScanFleets: 100 });
    await capped.scanNow();
    assert.strictEqual(capped.status().legs, 4);
    assert.deepStrictEqual(toObj(capped.jumpCounts(HOUR)), { [S[1]]: 4, [S[2]]: 4, [S[3]]: 4 });
    const few = make({ starmapMaxScanFleets: 3 });
    calls.length = 0;
    await few.scanNow();
    assert.strictEqual(few.status().legs, 3, "at most starmapMaxScanFleets read");
    assert.deepStrictEqual(calls, [["TRAVELLING", "", 2], ["TRAVELLING", "b", 1]]);
    assert.strictEqual(few.status().lastScanComplete, false, "cut by starmapMaxScanFleets = incomplete");
    assert.strictEqual(few.status().lastPartialReason, "MAX_SCAN_FLEETS");
    assert.strictEqual(few.status().partial, 1);

    now.t += 25 * HOUR;
    rows.TRAVELLING = [];
    rows.RETREATING = [];
    await tracker.scanNow();
    assert.strictEqual(tracker.status().legs, 0, "legs older than 24 h pruned");
    tracker.stop();
    assert.strictEqual(tracker.jumpCounts(HOUR).size, 0);
  });

  test("J6: a fleet stopped mid-leg stops counting after a complete scan, an incomplete scan cuts nothing", async () => {
    const now = { t: D + 30000 };
    const rows = { TRAVELLING: [fleet("f", 1, route(S, D)), fleet("h", 1, route([S[0], S[1]], D), 2)], RETREATING: [] };
    const fail = { on: false };
    const repository = { listFleetsByState(_tx, state, opts) {
      if (fail.on) return { ok: false, reason: "DB_BUSY" };
      const list = rows[state].filter((x) => x.fleetId > opts.afterFleetId).slice(0, opts.limit);
      return { ok: true, fleets: list, nextAfterFleetId: list.length === opts.limit ? list[list.length - 1].fleetId : null };
    } };
    const tracker = createTrafficTracker({ fleets: { repository }, clock: { now: () => now.t },
      store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
      settings: { starmapJumpsPerShip: true, starmapScanMs: 30000, starmapScanPageSize: 50, starmapMaxScanFleets: 100,
        starmapMaxTrackedLegs: 100 } });
    await tracker.scanNow();
    now.t = D + 90000;
    await tracker.scanNow();
    rows.TRAVELLING = [];
    fail.on = true;
    now.t = D + 150000;
    await tracker.scanNow();
    const st = tracker.status();
    assert.deepStrictEqual([st.lastScanComplete, st.lastPartialReason, st.partial, st.staleCuts],
      [false, "DB_BUSY", 1, 0], "a failed page = an incomplete scan, distinguished in status");
    assert.deepStrictEqual(toObj(tracker.jumpCounts(HOUR)), { [S[1]]: 7, [S[2]]: 5 }, "nothing cut yet");
    fail.on = false;
    now.t = D + 170000;
    await tracker.scanNow();
    assert.strictEqual(tracker.status().lastScanComplete, true);
    assert.strictEqual(tracker.status().staleCuts, 1, "only f: h is past its arriveAt (a normal arrival)");
    const after = toObj(tracker.jumpCounts(HOUR));
    assert.deepStrictEqual(after, { [S[1]]: 7 }, "cut at the last scan that saw f: no phantom S[2] / S[3]");
    now.t = D + 10 * MIN;
    await tracker.scanNow();
    assert.deepStrictEqual(toObj(tracker.jumpCounts(HOUR)), after, "a later now does not grow the count");
    assert.strictEqual(tracker.status().staleCuts, 1, "the cut is idempotent");
    const state = createLegState();
    mergeLeg(state, fleet("f", 1, route(S, D)), { perShip: false }, D + 30000);
    assert.strictEqual(cutStaleLegs(state, new Map(), D + 100000), 1);
    assert.deepStrictEqual(toObj(countJumps(allLegs(state), D + 10 * MIN, HOUR)), {});
    assert.strictEqual(cutStaleLegs(state, new Map(), D + 110000), 0);
    mergeLeg(state, fleet("f", 1, route(S, D)), { perShip: false }, D + 120000);
    assert.deepStrictEqual(toObj(countJumps(allLegs(state), D + 10 * MIN, HOUR)), { [S[1]]: 1, [S[2]]: 1, [S[3]]: 1 });
    assert.strictEqual(cutStaleLegs(state, new Map([["f", 1]]), D + 130000), 0, "seen with its legSeq = not cut");
    tracker.stop();
  });

  const haveSrc = fs.existsSync(TELEMETRY_FILE) && fs.existsSync(MAP_FILE);
  const j3 = "J3 wrapper on the facade: merge + sort, hours clamp, provider throw -> vendor rows, uninstall identity";
  if (!haveSrc) skip(j3, "server/src not found");
  else {
    test(j3, () => {
      const events = { current: [{ atMs: Date.now() - 1000, toSolarSystemID: S[2] },
        { atMs: Date.now() - 1000, toSolarSystemID: S[0] }] };
      const exportsObject = { listJumpHistoryRows: vendorFunction(events) };
      const original = exportsObject.listJumpHistoryRows;
      const adapter = createAdapter({ moduleApi: { _cache: { [TELEMETRY_FILE]: { exports: exportsObject } } } });
      adapter.setServerSrc(SERVER_SRC);
      assert.deepStrictEqual(adapter.starmapOverlaySeams(), { ok: true });
      const windows = [];
      const lne = { current: new Map([[S[2], 3], [S[1], 4], [-1, 9], [S[3], 1.5]]) };
      const seen = [];
      const provider = { jumpCounts: (w) => {
        windows.push(w);
        if (lne.current === null) throw new Error("boom");
        return lne.current;
      }, onEvent: (name) => seen.push(name) };
      try {
        assert.deepStrictEqual(adapter.installStarmapJumps(provider), { ok: true });
        assert.deepStrictEqual(adapter.installStarmapJumps(provider), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
        assert.notStrictEqual(exportsObject.listJumpHistoryRows, original);
        assert.deepStrictEqual(exportsObject.listJumpHistoryRows(1),
          [[S[0], 1, 0, 0], [S[1], 4, 0, 0], [S[2], 4, 0, 0]], "summed per system, ascending, junk ids dropped");
        exportsObject.listJumpHistoryRows(0);
        exportsObject.listJumpHistoryRows(30);
        exportsObject.listJumpHistoryRows("x");
        assert.deepStrictEqual(windows, [HOUR, HOUR, 24 * HOUR, HOUR], "clamp(hours, 1, 24) as the vendor");
        lne.current = null;
        assert.deepStrictEqual(exportsObject.listJumpHistoryRows(1), [[S[0], 1, 0, 0], [S[2], 1, 0, 0]]);
        assert.deepStrictEqual(adapter.starmapOverlayStatus().jumps, { state: "active", served: 4, errors: 1 });
        assert.deepStrictEqual(seen, ["jumpsServed", "jumpsServed", "jumpsServed", "jumpsServed", "jumpsErrors"]);
      } finally {
        assert.deepStrictEqual(adapter.uninstallStarmapJumps(), { ok: true });
      }
      assert.strictEqual(exportsObject.listJumpHistoryRows, original, "uninstall restores the vendor export");
      assert.strictEqual(adapter.starmapOverlayStatus().jumps.state, "idle");

      lne.current = new Map([[S[3], 7]]);
      assert.deepStrictEqual(adapter.installStarmapJumps(provider), { ok: true });
      const ours = exportsObject.listJumpHistoryRows;
      exportsObject.listJumpHistoryRows = function foreign(...a) { return ours.apply(this, a); };
      adapter.uninstallStarmapJumps();
      assert.strictEqual(adapter.starmapOverlayStatus().jumps.state, "passthrough");
      assert.deepStrictEqual(exportsObject.listJumpHistoryRows(1), [[S[0], 1, 0, 0], [S[2], 1, 0, 0]]);
      const before = exportsObject.listJumpHistoryRows;
      const drift = adapter.installStarmapJumps(provider);
      assert.strictEqual(drift.reason, "STARMAP_DRIFT", JSON.stringify(drift));
      assert.strictEqual(exportsObject.listJumpHistoryRows, before);
      assert.strictEqual(adapter.starmapOverlayStatus().jumps.state, "refused:STARMAP_DRIFT");
      const changed = overlay.checkJumps({ listJumpHistoryRows: original },
        { telemetryText: readSource(TELEMETRY_FILE).replace("Math.min(24,", "Math.min(48,"), mapServiceText: readSource(MAP_FILE) });
      assert.deepStrictEqual(changed, { ok: false, reason: "STARMAP_DRIFT",
        detail: "services/map/mapTelemetryState.js:listJumpHistoryRows" });
      const blind = createAdapter({ moduleApi: { _cache: {} } });
      assert.strictEqual(blind.installStarmapJumps(provider).reason, "STARMAP_SEAM_UNAVAILABLE");
    });
  }

  const j4 = "J4 vendor facts: own export, module object call, no destructuring, SHA-1, GAME_MODULES wrap";
  if (!haveSrc) skip(j4, "server/src not found");
  else {
    test(j4, () => {
      const telemetry = readSource(TELEMETRY_FILE);
      const map = readSource(MAP_FILE);
      const sha1 = (t) => crypto.createHash("sha1").update(t).digest("hex");
      assert.strictEqual(sha1(functionBody(telemetry, "listJumpHistoryRows")),
        overlay.FUNCTION_SHA1["services/map/mapTelemetryState.js:listJumpHistoryRows"]);
      assert.strictEqual(sha1(functionBody(map, "buildHistoryRows")),
        overlay.FUNCTION_SHA1["services/map/mapService.js:buildHistoryRows"]);
      assert.ok(/module\.exports = \{[^}]*\n {2}listJumpHistoryRows,\n/.test(telemetry), "own export");
      assert.ok(telemetry.includes(`Math.min(${overlay.VENDOR_MAX_WINDOW_HOURS}, toPositiveInteger(hours, 1))`));
      assert.ok(map.includes("const mapTelemetryState = require(path.join(__dirname, \"./mapTelemetryState\"));"));
      assert.strictEqual(map.split("mapTelemetryState\n        .listJumpHistoryRows(hours)").length - 1, 1);
      const users = [];
      const destructured = [];
      const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const abs = path.join(dir, e.name);
          if (e.isDirectory()) walk(abs);
          else if (e.name.endsWith(".js")) {
            const text = fs.readFileSync(abs, "utf8");
            if (!text.includes("listJumpHistoryRows")) continue;
            users.push(path.relative(SERVER_SRC, abs));
            if (/\{[^}]*\blistJumpHistoryRows\b[^}]*\}\s*=/.test(text)) destructured.push(abs);
          }
        }
      };
      walk(SERVER_SRC);
      assert.deepStrictEqual(users.sort(), [path.join("services", "map", "mapService.js"),
        path.join("services", "map", "mapTelemetryState.js")]);
      assert.deepStrictEqual(destructured, []);
      const entry = GAME_MODULES.filter((m) => m.path === overlay.TELEMETRY_PATH);
      assert.strictEqual(entry.length, 1);
      assert.deepStrictEqual(entry[0].symbols.map((s) => [s.name, s.kind, s.wrap, s.firstLoad, [...s.consumers]]),
        [["listJumpHistoryRows", "export", true, undefined, ["inGameMap.starmap"]],
          ["filetimeFromMs", "export", undefined, undefined, ["inGameMap.starmap"]]]);
      assert.strictEqual(GAME_MODULES.filter((m) => m.path === overlay.MAP_SERVICE_PATH).length, 1);
    });
  }

  test("J5 service: flag off = no install; on = install + tracker; refusal keeps the service; stop; W57", () => {
    const timers = [];
    const make = (over, installResult = { ok: true }) => {
      const log = { installs: [], uninstalls: 0 };
      const adapter = { installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }),
        installStarmapJumps(p) {
          log.installs.push(p);
          return installResult;
        },
        uninstallStarmapJumps() {
          log.uninstalls += 1;
          return { ok: true };
        } };
      const r = startInGameMap({ config: { inGameMap: { enabled: true, chatEnabled: false, observerUrl: "",
        chatMinIntervalMs: 10000, starmapJumpsEnabled: true, starmapJumpsPerShip: true, starmapScanMs: 30000,
        starmapScanPageSize: 500, starmapMaxScanFleets: 5000, starmapMaxTrackedLegs: 20000, ...over },
      fleets: { maxListLimit: 500 } }, ctx: {}, adapter, clock: { now: () => D },
      setTimer: (fn, ms) => {
        const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; }, hasRef: () => false };
        timers.push(t);
        return t;
      } });
      return { r, log };
    };
    const off = make({ starmapJumpsEnabled: false });
    assert.strictEqual(off.r.ok, true);
    assert.strictEqual(off.log.installs.length, 0);
    assert.deepStrictEqual(off.r.inGameMap.getStatus().starmap, { jumps: "off", reason: null, tracker: null });
    assert.strictEqual(timers.length, 0, "no tracker timer");

    const on = make({});
    assert.strictEqual(on.log.installs.length, 1);
    assert.strictEqual(typeof on.log.installs[0].jumpCounts, "function");
    assert.strictEqual(on.log.installs[0].jumpCounts(HOUR).size, 0, "no fleets in ctx: no data");
    assert.strictEqual(on.r.inGameMap.getStatus().starmap.jumps, "active");
    assert.ok(timers.some((t) => t.ms === 0 && !t.cancelled), "first scan armed at once");
    on.r.inGameMap.stop("test");
    assert.strictEqual(on.log.uninstalls, 1);
    assert.ok(timers.every((t) => t.cancelled), "tracker timer cancelled at stop");
    on.r.inGameMap.stop("again");
    assert.strictEqual(on.log.uninstalls, 1);

    const refused = make({}, { ok: false, reason: "STARMAP_DRIFT", detail: "x.js:f" });
    assert.strictEqual(refused.r.ok, true, "the service runs without the overlay");
    assert.deepStrictEqual(refused.r.inGameMap.getStatus().starmap,
      { jumps: "refused", reason: "STARMAP_DRIFT:x.js:f", tracker: null });
    refused.r.inGameMap.stop("test");
    assert.strictEqual(refused.log.uninstalls, 0);

    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const W = (x) => x.warnings.filter((w) => w.startsWith("inGameMap."));
    assert.deepStrictEqual(W(resolve({ EVEJS_LNE_INGAME_MAP_ENABLED: "1", EVEJS_LNE_FLEETS_ENABLED: "0" })),
      ["inGameMap.starmapJumpsEnabled with modules.fleets.enabled=false - no LNE jumps in the star map"], "W57");
    assert.strictEqual(W(resolve({ EVEJS_LNE_INGAME_MAP_STARMAP_JUMPS_ENABLED: "1" })).length, 1, "W55");
    assert.strictEqual(resolve({ EVEJS_LNE_INGAME_MAP_STARMAP_SCAN_MS: "1" }).config.inGameMap.starmapScanMs, 5000);
  });
};
