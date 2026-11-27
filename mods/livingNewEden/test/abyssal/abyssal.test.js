"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const runs = require("../../lib/adapter/abyssalRuns");
const { startAbyssal, createUnavailableAbyssal } = require("../../lib/abyssal");
const { createAbyssalRunRepository } = require("../../lib/abyssal/runRepository");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const SRC = path.join(path.sep, "x", "server", "src");
const T0 = 1700000000000;
const HOST = 32000007;
const SOURCE = 30000142;
const PILOT = 90000001;
const WING = 90000002;

function pocket(instanceID, characterID, extra = {}) {
  return { instanceID, characterID, shipID: 1000 + instanceID, sourceSolarSystemID: SOURCE, solarSystemID: HOST,
    abyssalLocationID: HOST, activatedAtMs: T0 - 1000, runOutcome: null, shipClass: "cruiser",
    contentProfile: { tier: 3, weatherType: "electrical" }, timerState: { expiresAtMs: T0 + 1200000 },
    dungeonTrackingState: { roomIndex: 1, pocketsCompleted: 0, totalPockets: 3, weatherType: "Electrical" },
    participantRoster: [{ characterID, shipTypeID: 17715, status: "active" }], encounter: { big: "ignored" },
    ...extra };
}

function fakePresence() {
  const p = { who: new Map(), stale: false, listeners: [] };
  p.facade = {
    getStatus: () => ({ available: true, stale: p.stale }),
    observedSystems: () => [...p.who.keys()].sort((a, b) => a - b),
    getSystemPresence: (id) => (p.who.has(id) ? { systemId: id,
      characters: p.who.get(id).map((c) => ({ characterId: c, name: `Pilot ${c}`, state: "space" })) } : null),
    listPresence: () => [...p.who.keys()].map((id) => p.facade.getSystemPresence(id)),
    onSystemObserved: (cb) => {
      p.listeners.push(cb);
      return { ok: true, unsubscribe() {} };
    },
  };
  return p;
}

function fakeSeam() {
  const s = { live: new Map(), reads: 0, installs: 0, asked: 0,
    tracking: { recordAbyssalRunCompletion: (ps) => ({ success: true, data: { id: ps && ps.instanceID } }) } };
  const project = (ps) => runs.projectRunWith(ps, null);
  s.seam = {
    isAbyssalHost: (id) => runs.isHostIdFallback(id),
    readActiveRun: (c) => {
      s.reads += 1;
      const ps = s.live.get(c);
      return { ok: true, run: ps ? project(ps) : null };
    },
    installCompletionHook: (onExited) => {
      s.installs += 1;
      const hook = runs.createCompletionHook({ trackingExports: s.tracking, onExited, project });
      const r = hook.install();
      return r.ok ? { ok: true, uninstall: () => hook.uninstall() } : r;
    },
    projectRun: project,
    stats: () => ({ hostDegraded: false }),
  };
  s.adapter = { abyssalSeams: () => {
    s.asked += 1;
    return { ok: true, seam: s.seam };
  } };
  return s;
}

function fakeTimers() {
  const list = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      list.push(t);
      return { cancel: () => { t.cancelled = true; }, hasRef: () => false };
    },
    fire() {
      const t = list.filter((x) => !x.cancelled).pop();
      assert.ok(t, "an armed timer");
      t.cancelled = true;
      t.fn();
    },
  };
}

function rowsOf(store) {
  const r = store.transaction("t.abyssal.rows", (db) => db.prepare(
    "SELECT instance_id, activated_at_ms, state, vendor_outcome, finished_at_ms, version, room_index "
    + "FROM lne_abyssal_runs ORDER BY instance_id, activated_at_ms").all()
    .map((x) => ({ id: Number(x.instance_id), act: Number(x.activated_at_ms), state: x.state,
      outcome: x.vendor_outcome, fin: x.finished_at_ms === null ? null : Number(x.finished_at_ms),
      version: Number(x.version), room: Number(x.room_index) })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function tx(store, fn) {
  const r = store.transaction("t.abyssal", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const ON_CONFIG = resolveConfig({ env: { EVEJS_LNE_ABYSSAL_ENABLED: "1" }, modDir: MOD_DIR });
const OFF_CONFIG = resolveConfig({ env: {}, modDir: MOD_DIR });

function boot(store, opts = {}) {
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const presence = opts.presence || fakePresence();
  const seam = opts.seam || fakeSeam();
  const timers = fakeTimers();
  const views = createViewRegistry();
  const started = startAbyssal({ config: opts.config || ON_CONFIG.config,
    ctx: { persistence: { store }, presence: presence.facade, views, graph: null, governor: null },
    adapter: seam.adapter, clock, telemetry: null, logger: { log() {} }, setTimer: timers.setTimer });
  return { started, clock, presence, seam, timers, views };
}

module.exports = ({ test, skip }) => {
  test("AB1 projectRunWith: every field, compact profile tier through the resolver, null cases, frozen copy", () => {
    const ps = pocket(41, PILOT, { contentProfile: { abyssalContentProfileReferenceSchemaVersion: 1, id: "t4" },
      participantRoster: [{ characterID: PILOT, shipTypeID: 17715, status: "active" },
        { characterID: WING, shipTypeID: 621, status: "exited" }, null, { characterID: 0 },
        { characterID: 3, shipTypeID: 1, status: "active" }, { characterID: 4, shipTypeID: 1, status: "active" }] });
    let asked = null;
    const s = runs.projectRunWith(ps, (profile) => {
      asked = profile;
      return { success: true, definition: { tier: 4 } };
    });
    assert.strictEqual(asked, ps.contentProfile, "the compact profile goes to the vendor resolver");
    assert.deepStrictEqual(s, { instanceId: 41, activatedAtMs: T0 - 1000, ownerCharacterId: PILOT,
      sourceSystemId: SOURCE, hostLocationId: HOST, tier: 4, weather: "electrical", shipClass: "cruiser",
      participants: [{ characterId: PILOT, shipTypeId: 17715, status: "active" },
        { characterId: WING, shipTypeId: 621, status: "exited" }, { characterId: 3, shipTypeId: 1, status: "active" }],
      roomIndex: 1, pocketsCompleted: 0, expiresAtMs: T0 + 1200000, vendorOutcome: null });
    assert.ok(Object.isFrozen(s) && Object.isFrozen(s.participants) && Object.isFrozen(s.participants[0]));
    ps.participantRoster[0].status = "destroyed";
    ps.dungeonTrackingState.roomIndex = 3;
    ps.runOutcome = "exited";
    assert.strictEqual(s.participants[0].status, "active");
    assert.strictEqual(s.roomIndex, 1);
    assert.strictEqual(s.vendorOutcome, null);
    assert.ok(!JSON.stringify(s).includes("ignored"), "no copy of other vendor fields");
    assert.strictEqual(runs.projectRunWith(pocket(0, PILOT)), null);
    assert.strictEqual(runs.projectRunWith(pocket(5, 0)), null);
    assert.strictEqual(runs.projectRunWith(null), null);
    const compact = pocket(6, PILOT, { contentProfile: { abyssalContentProfileReferenceSchemaVersion: 1 } });
    assert.strictEqual(runs.projectRunWith(compact, () => { throw new Error("boom"); }).tier, -1);
    assert.strictEqual(runs.projectRunWith(compact, null).tier, -1, "no resolver -> -1");
    assert.strictEqual(runs.projectRunWith(pocket(7, PILOT)).tier, 3, "plain profile tier");
    assert.strictEqual(runs.projectRunWith(pocket(8, PILOT, { sourceSolarSystemID: HOST })).sourceSystemId, 0,
      "a host is never a source system");
  });

  test("AB2 enabled: poll ACTIVE -> COMPLETED -> wrap EXITED (once), gone -> LOST after the grace, failed_timeout "
    + "-> FAILED, panel without host ID", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("AB2 abyssal service", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStore(driver, ({ store }) => {
      const b = boot(store);
      assert.strictEqual(b.started.ok, true, JSON.stringify(b.started));
      const aby = b.started.abyssal;
      assert.strictEqual(aby.getStatus().hook, "on");
      const grace = ON_CONFIG.config.abyssal.lostGraceMs;
      b.presence.who.set(SOURCE, [77]);
      b.presence.who.set(HOST, [PILOT, WING]);
      const a = pocket(11, PILOT);
      b.seam.live.set(PILOT, a);
      b.seam.live.set(WING, pocket(12, WING));
      b.timers.fire();
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.id, r.state]), [[11, "ACTIVE"], [12, "ACTIVE"]]);
      assert.strictEqual(b.seam.reads, 2, "only characters of the host");

      b.clock.t += 5000;
      b.timers.fire();
      assert.deepStrictEqual(rowsOf(store).map((r) => r.version), [1, 1], "unchanged runs: no write");

      a.runOutcome = "completed";
      a.dungeonTrackingState.roomIndex = 3;
      b.seam.live.delete(WING);
      b.presence.who.set(HOST, [PILOT]);
      b.clock.t += 5000;
      b.timers.fire();
      let rows = rowsOf(store);
      assert.deepStrictEqual(rows.map((r) => [r.id, r.state, r.room]), [[11, "COMPLETED", 3], [12, "ACTIVE", 1]]);

      a.runOutcome = "exited";
      const out = b.seam.tracking.recordAbyssalRunCompletion(a);
      assert.deepStrictEqual(out, { success: true, data: { id: 11 } });
      b.seam.tracking.recordAbyssalRunCompletion(a);
      b.seam.live.delete(PILOT);
      b.timers.fire();
      rows = rowsOf(store);
      assert.deepStrictEqual([rows[0].state, rows[0].outcome, rows[0].fin, rows[0].version],
        ["EXITED", "exited", b.clock.t, 3]);
      b.seam.tracking.recordAbyssalRunCompletion(a);
      b.timers.fire();
      assert.strictEqual(rowsOf(store)[0].version, 3, "a late retry of the wrap is a no-op");

      b.clock.t = T0 + 5000 + grace - 1;
      b.timers.fire();
      assert.strictEqual(rowsOf(store)[1].state, "ACTIVE", "before the grace");
      b.clock.t = T0 + 5000 + grace;
      b.timers.fire();
      rows = rowsOf(store);
      assert.deepStrictEqual([rows[1].state, rows[1].outcome, rows[1].fin], ["LOST", null, b.clock.t]);

      b.seam.live.set(PILOT, pocket(13, PILOT, { runOutcome: "failed_timeout" }));
      b.timers.fire();
      rows = rowsOf(store);
      assert.deepStrictEqual([rows[2].state, rows[2].outcome, rows[2].fin === b.clock.t], ["FAILED", "failed_timeout",
        true]);

      const fin = aby.listFinished({ limit: 10 });
      assert.deepStrictEqual(fin.runs.map((r) => [r.instanceId, r.state]), [[11, "EXITED"], [12, "LOST"],
        [13, "FAILED"]]);
      const data = b.views.getView("abyssal-runs").getData({});
      assert.strictEqual(data.available, true);
      assert.deepStrictEqual(data.finished.map((r) => r.instanceId), [13, 12, 11], "newest first");
      assert.deepStrictEqual([data.finished[2].pilot, data.finished[2].room, data.finished[2].sourceSystemId],
        [`Pilot ${PILOT}`, "3/3", SOURCE]);
      assert.ok(!JSON.stringify(data).includes(String(HOST)), "no host ID in the panel");
      const st = aby.getStatus().observer;
      assert.deepStrictEqual([st.counters.lost, st.counters.exited, st.open], [1, 1, 0]);
      aby.stop();
      assert.strictEqual(b.views.getView("abyssal-runs"), null, "panel removed at stop");
      assert.deepStrictEqual(aby.listActive(), { ok: false, reason: "ABYSSAL_UNAVAILABLE" });
      b.seam.tracking.recordAbyssalRunCompletion(pocket(14, PILOT, { runOutcome: "exited" }));
      assert.strictEqual(rowsOf(store).length, 3, "nothing after stop");
    });
  });

  test("ABL4: listActive / listFinished / getRun of the facade have no hostLocationId "
    + "the repository keeps it", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("ABL4 abyssal facade", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStore(driver, ({ store }) => {
      const b = boot(store);
      assert.strictEqual(b.started.ok, true, JSON.stringify(b.started));
      const aby = b.started.abyssal;
      b.presence.who.set(HOST, [PILOT, WING]);
      b.seam.live.set(PILOT, pocket(21, PILOT));
      b.seam.live.set(WING, pocket(22, WING, { runOutcome: "failed_timeout" }));
      b.timers.fire();
      const active = aby.listActive();
      const finished = aby.listFinished({ limit: 10 });
      const one = aby.getRun(21);
      assert.deepStrictEqual([active.ok, active.runs.map((r) => r.instanceId), finished.runs.map((r) => r.instanceId),
        one.ok, one.run.instanceId], [true, [21], [22], true, 21]);
      for (const run of [...active.runs, ...finished.runs, one.run]) {
        assert.ok(!Object.prototype.hasOwnProperty.call(run, "hostLocationId"), JSON.stringify(run));
        assert.ok(Object.isFrozen(run));
        assert.deepStrictEqual([run.ownerCharacterId > 0, run.expiresAtMs, run.tier], [true, T0 + 1200000, 3]);
      }
      assert.deepStrictEqual(aby.getRun(99), { ok: true, run: null });
      assert.deepStrictEqual(aby.getRun(0), { ok: false, reason: "INVALID_INPUT" });
      const repo = createAbyssalRunRepository({ store, maxListRows: 10 });
      assert.strictEqual(repo.listActive().runs[0].hostLocationId, HOST, "the repository keeps the host");
      assert.strictEqual(repo.getRun(22).run.hostLocationId, HOST);
      aby.stop();
    });
  });

  test("AB3 idempotence and restart: two wraps -> one row, version +1 once; new repository = UPDATE; the same "
    + "instance after a restart = the same row, a missing one LOST after the grace", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("AB3 abyssal restart", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStore(driver, ({ store }) => {
      const repo = createAbyssalRunRepository({ store });
      const s = runs.projectRunWith(pocket(21, PILOT));
      assert.strictEqual(tx(store, (db) => repo.observeInTx(db, s, T0)).state, "ACTIVE");
      const exited = runs.projectRunWith(pocket(21, PILOT, { runOutcome: "exited" }));
      assert.strictEqual(tx(store, (db) => repo.markExitedInTx(db, exited, T0 + 1)).changed, true);
      assert.strictEqual(tx(store, (db) => repo.markExitedInTx(db, exited, T0 + 2)).changed, false);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.id, r.state, r.version]), [[21, "EXITED", 2]]);
      assert.deepStrictEqual(tx(store, (db) => repo.observeInTx(db, s, T0 + 3)), { ok: false, reason: "FINISHED" });

      const live = runs.projectRunWith(pocket(22, PILOT));
      tx(store, (db) => repo.observeInTx(db, live, T0));
      const again = createAbyssalRunRepository({ store });
      const moved = runs.projectRunWith(pocket(22, PILOT, { dungeonTrackingState: { roomIndex: 2 } }));
      const r = tx(store, (db) => again.observeInTx(db, moved, T0 + 10));
      assert.deepStrictEqual([r.changed, r.key.activatedAtMs], [true, T0 - 1000]);
      tx(store, (db) => again.observeInTx(db, runs.projectRunWith(pocket(23, WING)), T0));
      assert.deepStrictEqual(rowsOf(store).map((x) => [x.id, x.version, x.room]), [[21, 2, 1], [22, 2, 2], [23, 1, 1]]);

      const clock = { t: T0 + 600000, now() { return this.t; } };
      const b = boot(store, { clock });
      assert.strictEqual(b.started.ok, true, JSON.stringify(b.started));
      assert.strictEqual(b.started.abyssal.getStatus().observer.open, 2);
      b.presence.who.set(HOST, [PILOT]);
      b.seam.live.set(PILOT, pocket(22, PILOT, { dungeonTrackingState: { roomIndex: 2 } }));
      b.timers.fire();
      assert.deepStrictEqual(rowsOf(store).map((x) => [x.id, x.state, x.version]),
        [[21, "EXITED", 2], [22, "ACTIVE", 2], [23, "ACTIVE", 1]], "same rows, no duplicate, grace from the start");
      clock.t += ON_CONFIG.config.abyssal.lostGraceMs;
      b.timers.fire();
      assert.deepStrictEqual(rowsOf(store).map((x) => [x.id, x.state]),
        [[21, "EXITED"], [22, "ACTIVE"], [23, "LOST"]]);
      b.started.abyssal.stop();
    });
  });

  test("AB4 abyssal.enabled=false (default): no seam call (no wrap, no read), facade unavailable", () => {
    assert.strictEqual(OFF_CONFIG.config.abyssal.enabled, false);
    const seam = fakeSeam();
    const store = { transaction() { throw new Error("no store access when off"); } };
    const r = startAbyssal({ config: OFF_CONFIG.config, ctx: { persistence: { store }, presence: fakePresence().facade },
      adapter: seam.adapter, logger: { log() {} } });
    assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual([seam.asked, seam.installs, seam.reads], [0, 0, 0]);
    const off = createUnavailableAbyssal("disabled_by_config");
    assert.deepStrictEqual(off.getStatus(), { available: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(off.listFinished({ limit: 5 }), { ok: false, reason: "ABYSSAL_UNAVAILABLE" });
    assert.deepStrictEqual(Object.keys(off).sort(), ["getRun", "getStatus", "listActive", "listFinished", "pressureOf",
      "stop", "topRegions"]);
  });

  test("AB5 vendor facts: host range, ABYSSAL_RUN_OUTCOME, the completion export and its only caller", () => {
    if (!fs.existsSync(SERVER_SRC)) return skip("AB5 abyssal vendor facts", "server/src not found");
    const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const host = read("abyssal/domain/abyssalHostLocation.js");
    assert.match(host, /\nconst ABYSSAL_LOCATION_ID_MIN = 32000001;\n/);
    assert.match(host, /\nconst ABYSSAL_LOCATION_ID_COUNT = 200;\n/);
    assert.deepStrictEqual([runs.HOST_ID_MIN, runs.HOST_ID_COUNT], [32000001, 200]);
    const policy = read("abyssal/domain/abyssalTerminalTransitionPolicy.js");
    const block = /const ABYSSAL_RUN_OUTCOME = Object\.freeze\(\{\n([\s\S]*?)\n\}\);/.exec(policy);
    assert.ok(block, "ABYSSAL_RUN_OUTCOME block");
    const values = [...block[1].matchAll(/^ {2}[A-Z_]+: "([a-z_]+)",$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(values, ["completed", "exited", "failed_entry_readiness", "failed_room_activation",
      "failed_timeout", "failed_ship_destroyed", "abandoned_or_recovered", "admin_aborted", "cluster_shutdown_returned"]);
    const { FAILED_OUTCOMES } = require("../../lib/abyssal/machine");
    assert.deepStrictEqual(values.slice(2), [...FAILED_OUTCOMES]);
    assert.match(policy, /\n {2}ABYSSAL_RUN_OUTCOME,\n/);
    const tracking = read("services/dungeon/dungeonTrackingRuntime.js");
    assert.match(tracking, /\nfunction recordAbyssalRunCompletion\(pocketState\) \{\n {2}if \(!pocketState \|\| pocketState\.runOutcome !== "exited"\) \{/);
    assert.match(tracking, /\n {2}recordAbyssalRunCompletion,\n/);
    assert.match(tracking, /\n {2}recordCareerAbyssalRun,\n/);
    assert.strictEqual((tracking.match(/recordAbyssalRunCompletion\(/g) || []).length, 1, "the definer never calls it");
    const g6 = read("abyssal/runtime/abyssalManagerRuntimeGroup6.js");
    assert.match(g6, /const dungeonTrackingRuntime = require\("\.\.\/\.\.\/services\/dungeon\/dungeonTrackingRuntime"\);\n\s*scope\.dungeonTrackingRuntime = dungeonTrackingRuntime;/);
    assert.match(read("abyssal/runtime/abyssalManagerRuntimeGroup12.js"), /dungeonTrackingRuntime: scope\.dungeonTrackingRuntime,/);
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && full !== path.join(SERVER_SRC, "abyssal", "catalog")) walk(full);
        else if (e.name.endsWith(".js")) files.push(full);
      }
    };
    walk(path.join(SERVER_SRC, "abyssal"));
    walk(path.join(SERVER_SRC, "services", "dungeon"));
    const hits = [];
    for (const f of files) {
      const text = fs.readFileSync(f, "utf8");
      if (!text.includes("recordAbyssalRunCompletion")) continue;
      assert.ok(!/\{[^}]*\brecordAbyssalRunCompletion\b[^}]*\}\s*=/.test(text), `${f} destructures it`);
      for (const line of text.split(/\r?\n/)) if (line.includes("recordAbyssalRunCompletion")) hits.push(line.trim());
    }
    assert.deepStrictEqual(hits.filter((l) => l.includes("deps.dungeonTrackingRuntime")).length, 2,
      "abyssalCleanupPreparation: typeof check + call through deps.");
    assert.strictEqual(hits.length, 4, hits.join("\n"));
  });

  test("AB6 adapter facade abyssalSeams: methods, host check, live read, the wrap, DRIFT -> SEAM_UNAVAILABLE", () => {
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const live = new Map([[PILOT, pocket(31, PILOT)]]);
    let thrown = false;
    const tracking = { recordAbyssalRunCompletion(ps) {
      if (thrown) throw new Error("vendor boom");
      return { success: true, self: this === tracking, n: arguments.length, id: ps.instanceID };
    } };
    const facade = {};
    Object.defineProperty(facade, "getActiveAbyssalRunForCharacterID", { enumerable: true,
      get: () => (id) => live.get(id) || null });
    const cache = {
      [key("abyssal/domain/abyssalHostLocation")]: { exports: { isAbyssalHostLocationID: (id) => id === HOST } },
      [key("abyssal/policy/abyssalSpaceRuntimeIntegration")]: { exports: facade },
      [key("services/dungeon/dungeonTrackingRuntime")]: { exports: tracking },
    };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(SRC);
    const res = adapter.abyssalSeams();
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    const seam = res.seam;
    assert.deepStrictEqual(Object.keys(seam).sort(), ["installCompletionHook", "isAbyssalHost", "projectRun",
      "readActiveRun", "stats"]);
    assert.deepStrictEqual([seam.isAbyssalHost(HOST), seam.isAbyssalHost(HOST + 1)], [true, false], "the vendor answer");
    assert.strictEqual(seam.stats().hostDegraded, false);
    const read = seam.readActiveRun(PILOT);
    assert.deepStrictEqual([read.ok, read.run.instanceId, read.run.hostLocationId], [true, 31, HOST]);
    assert.deepStrictEqual(seam.readActiveRun(WING), { ok: true, run: null });
    assert.strictEqual(seam.projectRun(pocket(31, PILOT, { contentProfile: {
      abyssalContentProfileReferenceSchemaVersion: 1 } })).tier, -1, "no tier module in the cache -> -1");

    const seen = [];
    const hook = seam.installCompletionHook((s) => seen.push(s.instanceId));
    assert.strictEqual(hook.ok, true, JSON.stringify(hook));
    assert.deepStrictEqual(seam.installCompletionHook(() => {}), { ok: false, reason: "ALREADY_INSTALLED" });
    const exited = pocket(31, PILOT, { runOutcome: "exited" });
    assert.deepStrictEqual(tracking.recordAbyssalRunCompletion(exited, "x"), { success: true, self: true, n: 2,
      id: 31 });
    tracking.recordAbyssalRunCompletion(pocket(32, PILOT, { runOutcome: "completed" }));
    assert.deepStrictEqual(seen, [31], "only exited");
    thrown = true;
    assert.throws(() => tracking.recordAbyssalRunCompletion(exited), /vendor boom/);
    thrown = false;
    assert.deepStrictEqual(seen, [31], "no event after a vendor throw");
    const wrapped = tracking.recordAbyssalRunCompletion;
    hook.uninstall();
    assert.notStrictEqual(tracking.recordAbyssalRunCompletion, wrapped, "the original is back");
    tracking.recordAbyssalRunCompletion(exited);
    assert.deepStrictEqual(seen, [31]);

    const bare = createAdapter({ moduleApi: { _cache: {} }, logger: { log() {} } });
    bare.setServerSrc(SRC);
    const bareSeam = bare.abyssalSeams().seam;
    assert.deepStrictEqual([bareSeam.isAbyssalHost(32000200), bareSeam.isAbyssalHost(32000201)], [true, false]);
    assert.strictEqual(bareSeam.stats().hostDegraded, true);
    assert.strictEqual(bareSeam.readActiveRun(PILOT).reason, "ABYSSAL_UNAVAILABLE");
    assert.strictEqual(bareSeam.installCompletionHook(() => {}).reason, "SEAM_MISSING");

    const table = GAME_MODULES.map((e) => (e.path === "abyssal/policy/abyssalSpaceRuntimeIntegration" ? e
      : { ...e, symbols: [] }));
    const drift = createAdapter({ moduleApi: { _cache: { [key("abyssal/policy/abyssalSpaceRuntimeIntegration")]:
      { exports: {} } } }, logger: { log() {} }, gameModules: table });
    drift.setServerSrc(SRC);
    const report = drift.runProbe();
    assert.ok(Object.keys(report.disabledModules).includes("abyssal"), JSON.stringify(report.disabledModules));
    const refused = drift.abyssalSeams();
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "SEAM_UNAVAILABLE"]);
  });
};
