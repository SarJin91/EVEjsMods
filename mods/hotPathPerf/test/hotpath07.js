"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { createRockRemainderCoalesce, AIR_TEMPLATE_ID, MISSION_KEY, KEY, HOOK_NAME } = require("../lib/rockRemainderCoalesce");

const clone = (v) => JSON.parse(JSON.stringify(v));

function vendorError(code) {
  const error = new Error(code);
  error.dungeonError = code;
  return error;
}

function fakeDungeon(records) {
  const dr = {
    inst: new Map(records.map((r) => [r.instanceID, clone(r)])),
    calls: [], order: [], throwNext: null, refThrowNext: false, onMerge: null,
    getInstanceRef(id) {
      if (dr.refThrowNext) { dr.refThrowNext = false; throw new Error("ref boom"); }
      return dr.inst.get(Number(id)) || null;
    },
    getInstance(id) {
      const r = dr.inst.get(Number(id));
      return r ? clone(r) : null;
    },
    mergeSpawnState(instanceID, patch = {}, options = {}) {
      dr.calls.push({ id: instanceID, patch: clone(patch), options: clone(options) });
      dr.order.push("merge");
      if (dr.throwNext) { const e = dr.throwNext; dr.throwNext = null; throw e; }
      const r = dr.inst.get(Number(instanceID));
      if (!r) throw vendorError("DUNGEON_INSTANCE_NOT_FOUND");
      r.spawnState = { ...(r.spawnState || {}), ...clone(patch) };
      if (dr.onMerge) { const fn = dr.onMerge; dr.onMerge = null; fn(); }
      return clone(r);
    },
  };
  return dr;
}

function record(dr, instanceID, rockID, value, nowMs) {
  const instance = dr.getInstance(instanceID);
  if (!instance) return false;
  const recorded = instance.spawnState && instance.spawnState[KEY] && typeof instance.spawnState[KEY] === "object"
    ? instance.spawnState[KEY] : {};
  if (recorded[String(rockID)] === value) return false;
  try {
    dr.mergeSpawnState(instanceID, { [KEY]: { ...recorded, [String(rockID)]: value } }, { nowMs });
  } catch (_error) {
    return false;
  }
  return true;
}

function fakeTimers() {
  const t = {
    list: [],
    setTimer(fn, ms) { const h = { fn, ms, cancelled: false }; t.list.push(h); return h; },
    clearTimer(h) { h.cancelled = true; },
    run() {
      const due = t.list.filter((h) => !h.cancelled);
      t.list = [];
      for (const h of due) { h.cancelled = true; h.fn(); }
      return due.length;
    },
    armed() { return t.list.filter((h) => !h.cancelled).length; },
  };
  return t;
}

function fakeStore() {
  const s = {
    hooks: new Map(), registerCount: 0, shuttingDown: false,
    registerShutdownHook(name, fn) {
      s.registerCount += 1;
      if (s.hooks.has(name)) throw new Error(`shutdown hook already registered: ${name}`);
      s.hooks.set(name, fn);
      return () => s.hooks.delete(name);
    },
    isShutdownInProgress() { return s.shuttingDown; },
  };
  return s;
}

const inst = (id, map, templateID = "evejs.ore-site:1") => ({ instanceID: id, templateID, spawnState: { [KEY]: map, other: 1 } });

function setup(cfg = {}, opts = {}) {
  const lines = [];
  const timers = fakeTimers();
  const clock = { t: 1000 };
  const dr = fakeDungeon(opts.records || [inst(100, { 1: 500, 2: 400 }), inst(200, { 3: 300 }), inst(300, { 7: 38 }, AIR_TEMPLATE_ID)]);
  const store = fakeStore();
  const rock = createRockRemainderCoalesce({
    config: { rockRemainderCoalesceMs: 10000, rockRemainderCoalesceMaxInstances: 256, ...cfg },
    log: (l) => lines.push(l), now: () => clock.t, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  assert.strictEqual(rock.setDungeonDeps(dr), true);
  assert.strictEqual(rock.setStoreDeps(store), true);
  dr.mergeSpawnState = rock.wrapMerge(dr.mergeSpawnState);
  const mining = { handleSceneDisposed() { dr.order.push("dispose"); return "d"; } };
  const sites = { resetSceneGeneratedResourceSites() { dr.order.push("reset"); return "r"; } };
  if (!opts.noDispose) mining.handleSceneDisposed = rock.wrapFlushPoint(mining.handleSceneDisposed, "dispose");
  sites.resetSceneGeneratedResourceSites = rock.wrapFlushPoint(sites.resetSceneGeneratedResourceSites, "reset");
  return { lines, timers, clock, dr, store, rock, mining, sites };
}

function register(ctx) {
  const { test, src, listJs, config, loader, createRecorder, SERVER_SRC } = ctx;
  const { createState, patchTarget, probeMessage, checkRockDrift, requestPatternFor, ROCK_POINTS } = loader;
  const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
  const rockConfig = Object.freeze({ ...config, ...quiet, prewarmLocations: false, rockRemainderCoalesce: true });

  test("G1 coalescing: 10 cycles of two rocks = 0 writes, timer = 1 write with the last values and nowMs; second instance separate; noop", () => {
    const s = setup();
    for (let i = 1; i <= 5; i += 1) {
      s.clock.t += 1000;
      record(s.dr, 100, 1, 500 - i * 10, 5000 + i);
      record(s.dr, 100, 2, 400 - i * 10, 6000 + i);
    }
    assert.strictEqual(s.dr.calls.length, 0, "no vendor write within the window");
    assert.deepStrictEqual([s.rock.status().pendingInstances, s.rock.status().pendingRocks], [1, 2]);
    assert.strictEqual(s.timers.armed(), 1, "one timer");
    assert.strictEqual(s.timers.list[0].ms, 10000);
    record(s.dr, 100, 1, 450, 7000);
    assert.strictEqual(s.rock.statsSnapshot().noop, 1, "value equal to the buffer = noop");
    s.timers.run();
    assert.deepStrictEqual(s.dr.calls, [{ id: 100, patch: { [KEY]: { 1: 450, 2: 350 } }, options: { nowMs: 6005 } }]);
    assert.deepStrictEqual(s.dr.inst.get(100).spawnState, { [KEY]: { 1: 450, 2: 350 }, other: 1 });
    record(s.dr, 100, 1, 440, 8000);
    record(s.dr, 200, 3, 290, 8001);
    assert.strictEqual(s.dr.calls.length, 1);
    s.timers.run();
    assert.deepStrictEqual(s.dr.calls.slice(1).map((c) => [c.id, c.patch[KEY]]), [[100, { 1: 440, 2: 350 }], [200, { 3: 290 }]]);
    const st = s.rock.statsSnapshot();
    assert.deepStrictEqual([st.intercepted, st.buffered, st.written, st.flushes.timer], [13, 12, 3, 3]);
    assert.deepStrictEqual(s.lines, []);
    const line = s.rock.drainStatsLines()[0];
    assert.ok(/^stats rockRemainderCoalesce state=ready pending=0\/0 intercepted=13 buffered=12 noop=1 flushes=timer:3,zero:0,/.test(line), line);
    assert.ok(/written=3 dropped=notFound:0,shutdown:0 writeErrors=0 passthrough=air:0,mission:0,noDisposeHook:0,durable:0 flushMaxMs=\d+ maxAgeMs=\d+$/.test(line), line);
  });

  test("G2 zero = write at once with the rest of the buffer; foreign write with overlay (min); AIR passthrough; patch without the key", () => {
    const s = setup();
    record(s.dr, 100, 1, 450, 1);
    record(s.dr, 100, 2, 390, 2);
    record(s.dr, 100, 1, 0, 3);
    assert.deepStrictEqual(s.dr.calls, [{ id: 100, patch: { [KEY]: { 1: 0, 2: 390 } }, options: { nowMs: 3 } }]);
    assert.strictEqual(s.rock.status().pendingInstances, 0);
    assert.strictEqual(s.rock.statsSnapshot().flushes.zero, 1);

    const f = setup();
    record(f.dr, 100, 1, 450, 1);
    record(f.dr, 100, 2, 390, 2);
    const foreign = { airMining: { x: 1 }, [KEY]: { 1: 430, 2: 400, 5: 7 } };
    const before = clone(foreign);
    f.dr.mergeSpawnState(100, foreign, { nowMs: 9 });
    assert.deepStrictEqual(f.dr.calls, [{ id: 100, patch: { airMining: { x: 1 }, [KEY]: { 1: 430, 2: 390, 5: 7 } }, options: { nowMs: 9 } }]);
    assert.deepStrictEqual(foreign, before, "caller's object unchanged");
    assert.strictEqual(f.rock.status().pendingInstances, 0);
    assert.strictEqual(f.rock.statsSnapshot().flushes.foreign, 1);
    record(f.dr, 200, 3, 250, 1);
    f.dr.mergeSpawnState(200, { airMining: {}, [KEY]: { 3: 280 } });
    assert.deepStrictEqual(f.dr.calls[1].patch[KEY], { 3: 250 });
    f.dr.mergeSpawnState(100, { [KEY]: { 1: 420 } }, { durable: true });
    assert.deepStrictEqual(f.dr.calls[2].patch, { [KEY]: { 1: 420 } });
    assert.strictEqual(f.rock.statsSnapshot().passDurable, 1);

    const a = setup();
    record(a.dr, 300, 7, 30, 1);
    record(a.dr, 300, 7, 20, 2);
    assert.strictEqual(a.dr.calls.length, 2, "AIR: every call goes to the vendor");
    assert.strictEqual(a.rock.statsSnapshot().passAir, 2);
    record(a.dr, 100, 1, 450, 3);
    a.dr.mergeSpawnState(100, { hackingContainerState: { z: 1 } });
    assert.deepStrictEqual(a.dr.calls[2].patch, { hackingContainerState: { z: 1 } });
    assert.deepStrictEqual([a.rock.status().pendingInstances, a.rock.status().pendingRocks], [1, 1], "buffer untouched");
  });

  test("G3 flush before dispose/reset, shutdown hook once, drop at shutdown, notFound, WRITE_FAILED, limit, reentrancy", () => {
    const s = setup();
    record(s.dr, 100, 1, 450, 1);
    assert.strictEqual(s.mining.handleSceneDisposed({}), "d");
    record(s.dr, 200, 3, 290, 2);
    assert.strictEqual(s.sites.resetSceneGeneratedResourceSites({}, {}), "r");
    assert.deepStrictEqual(s.dr.order, ["merge", "dispose", "merge", "reset"]);
    const fl = s.rock.statsSnapshot().flushes;
    assert.deepStrictEqual([fl.dispose, fl.reset], [1, 1]);
    record(s.dr, 100, 2, 390, 3);
    assert.deepStrictEqual([s.store.registerCount, [...s.store.hooks.keys()]], [1, [HOOK_NAME]]);
    s.store.hooks.get(HOOK_NAME)("SIGTERM");
    assert.deepStrictEqual(s.dr.calls.at(-1), { id: 100, patch: { [KEY]: { 1: 450, 2: 390 } }, options: { nowMs: 3 } });
    assert.strictEqual(s.rock.statsSnapshot().flushes.shutdown, 1);
    record(s.dr, 100, 2, 380, 4);
    s.store.shuttingDown = true;
    const n = s.dr.calls.length;
    s.timers.run();
    assert.strictEqual(s.dr.calls.length, n);
    assert.strictEqual(s.rock.statsSnapshot().droppedShutdown, 1);

    const g = setup();
    record(g.dr, 100, 1, 450, 1);
    g.dr.inst.delete(100);
    g.timers.run();
    assert.deepStrictEqual([g.dr.calls.length, g.rock.statsSnapshot().droppedNotFound], [0, 1]);
    record(g.dr, 200, 3, 290, 1);
    g.dr.throwNext = vendorError("DUNGEON_INSTANCE_NOT_FOUND");
    g.timers.run();
    assert.strictEqual(g.rock.statsSnapshot().droppedNotFound, 2);
    record(g.dr, 200, 3, 280, 2);
    g.dr.throwNext = vendorError("DUNGEON_RUNTIME_STATE_WRITE_FAILED");
    g.timers.run();
    g.dr.throwNext = vendorError("DUNGEON_RUNTIME_STATE_WRITE_FAILED");
    assert.strictEqual(record(g.dr, 200, 3, 0, 3), true, "a zero write with a vendor error does not throw into the mining cycle");
    assert.strictEqual(g.rock.statsSnapshot().writeErrors, 2);
    assert.strictEqual(g.lines.filter((l) => l.startsWith("WARN rockRemainderCoalesce write failed")).length, 1, g.lines.join("|"));
    assert.strictEqual(g.rock.status().state, "ready");

    const l = setup({ rockRemainderCoalesceMaxInstances: 1 });
    record(l.dr, 100, 1, 450, 1);
    record(l.dr, 200, 3, 290, 2);
    assert.deepStrictEqual(l.dr.calls.map((c) => c.id), [100]);
    assert.strictEqual(l.rock.statsSnapshot().flushes.limit, 1);
    assert.deepStrictEqual(l.rock.status().pendingInstances, 1);

    const r = setup();
    record(r.dr, 100, 1, 450, 1);
    r.dr.onMerge = () => r.dr.mergeSpawnState(100, { [KEY]: { 1: 440, 2: 400 } });
    r.timers.run();
    assert.deepStrictEqual(r.dr.calls.map((c) => c.patch[KEY][1]), [450, 440], "a call during the flush = passthrough");
    assert.strictEqual(r.rock.status().pendingInstances, 0);
  });

  test("G4 states: without the dispose point passthrough, coalesceMs=0, waiting, own error = disabled:error with a buffer write", () => {
    const n = setup({}, { noDispose: true });
    record(n.dr, 100, 1, 450, 1);
    assert.strictEqual(n.dr.calls.length, 1);
    assert.strictEqual(n.rock.statsSnapshot().passNoDisposeHook, 1);

    const z = setup({ rockRemainderCoalesceMs: 0 });
    record(z.dr, 100, 1, 450, 1);
    record(z.dr, 100, 1, 440, 2);
    assert.strictEqual(z.dr.calls.length, 2);
    assert.strictEqual(z.timers.armed(), 0);

    const dr = fakeDungeon([inst(100, { 1: 500 })]);
    const w = createRockRemainderCoalesce({ config: { rockRemainderCoalesceMs: 10000, rockRemainderCoalesceMaxInstances: 4 }, log: () => {} });
    w.setDungeonDeps(dr);
    dr.mergeSpawnState = w.wrapMerge(dr.mergeSpawnState);
    w.wrapFlushPoint(() => {}, "dispose");
    assert.strictEqual(w.status().state, "waiting");
    record(dr, 100, 1, 450, 1);
    assert.strictEqual(dr.calls.length, 1, "waiting = passthrough");
    assert.strictEqual(w.setStoreDeps({}), false);

    const e = setup();
    record(e.dr, 100, 1, 450, 1);
    e.dr.refThrowNext = true;
    record(e.dr, 100, 2, 390, 2);
    assert.strictEqual(e.rock.status().state, "disabled:error");
    assert.deepStrictEqual(e.dr.calls.map((c) => c.patch[KEY]), [{ 1: 450, 2: 400 }, { 1: 500, 2: 390 }], "buffer through the original, then the vendor patch");
    assert.deepStrictEqual(e.lines.filter((l) => l.includes("disabled")), ["WARN rockRemainderCoalesce disabled: error (ref boom)"]);
    record(e.dr, 100, 2, 380, 3);
    assert.strictEqual(e.dr.calls.length, 3, "after disabling: passthrough");
    assert.strictEqual(e.timers.armed(), 0);
    assert.deepStrictEqual(e.rock.flushAll("timer"), { ok: false, reason: "DISABLED" });
  });

  test("G4b missions (261108.1): missionMining journal = passthrough; a patch creating the journal takes the buffer (record map + buffer)", () => {
    const m = setup();
    m.dr.inst.get(100).spawnState[MISSION_KEY] = { version: 1, extractionsByKey: {} };
    record(m.dr, 100, 1, 450, 1);
    record(m.dr, 100, 1, 440, 2);
    assert.deepStrictEqual(m.dr.calls.map((c) => c.patch[KEY]), [{ 1: 450, 2: 400 }, { 1: 440, 2: 400 }], "every write goes to the vendor");
    assert.strictEqual(m.rock.statsSnapshot().passMission, 2);
    assert.strictEqual(m.rock.status().pendingInstances, 0);
    m.dr.inst.get(200).spawnState.populationHints = { retailResourceRevision: 1 };
    record(m.dr, 200, 3, 290, 3);
    assert.strictEqual(m.dr.calls.length, 3);
    assert.strictEqual(m.rock.statsSnapshot().passMission, 3);
    const d = setup();
    d.dr.inst.get(200).spawnState.retailResourceRevision = 1;
    record(d.dr, 200, 3, 290, 1);
    assert.strictEqual(d.dr.calls.length, 1, "every write goes to the vendor");
    assert.strictEqual(d.rock.statsSnapshot().passMission, 1);
    assert.strictEqual(d.rock.status().pendingInstances, 0);

    const j = setup();
    record(j.dr, 100, 1, 450, 1);
    assert.strictEqual(j.dr.calls.length, 0, "before the journal: buffer");
    const journal = { [MISSION_KEY]: { version: 1, extractionsByKey: {} } };
    j.dr.mergeSpawnState(100, journal, { nowMs: 5, durable: true, force: true });
    assert.deepStrictEqual(j.dr.calls, [{ id: 100, patch: { ...journal, [KEY]: { 1: 450, 2: 400 } }, options: { nowMs: 5, durable: true, force: true } }]);
    assert.deepStrictEqual(Object.keys(journal), [MISSION_KEY], "caller's object unchanged");
    assert.strictEqual(j.rock.status().pendingInstances, 0);
    assert.strictEqual(j.rock.statsSnapshot().flushes.foreign, 1);
    record(j.dr, 100, 1, 430, 6);
    assert.strictEqual(j.dr.calls.length, 2, "after the journal: passthrough");
    j.dr.mergeSpawnState(200, { [MISSION_KEY]: {} }, { durable: true, force: true });
    assert.deepStrictEqual(j.dr.calls[2].patch, { [MISSION_KEY]: {} });
    assert.ok(/passthrough=air:0,mission:1,/.test(j.rock.drainStatsLines()[0]));
  });

  test("G5 vendor facts 261108.1: depletion write, first-level merge, readers, AIR, flush points, shutdown, destructuring", () => {
    const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
    const mrs = norm("services/mining/miningRuntimeState.js");
    const body = mrs.slice(mrs.indexOf("function recordDungeonRockRemainder("), mrs.indexOf("\n}\n", mrs.indexOf("function recordDungeonRockRemainder(")));
    assert.ok(/\n {4}dungeonRuntime\.mergeSpawnState\(instanceID, \{\n {6}miningRockRemainingByID: \{\n/.test(body), "mergeSpawnState with the only key");
    assert.ok(!/=\s*dungeonRuntime\.mergeSpawnState/.test(body), "result ignored");
    assert.ok(/const dungeonRuntime = getDungeonRuntimeModule\(\);/.test(body));
    assert.ok(/function getDungeonRuntimeModule\(\) \{\n {2}return require\(/.test(mrs), "require on every call");
    const delta = mrs.slice(mrs.indexOf("function applyMiningDelta("));
    assert.ok(/\n {2}recordDungeonRockRemainder\(entity, nextState, options\);/.test(delta.slice(0, delta.indexOf("\n}\n"))), "local call in applyMiningDelta");
    assert.ok(!/^\s+recordDungeonRockRemainder,?$/m.test(mrs), "no export");

    const drt = norm("services/dungeon/dungeonRuntime.js");
    const mfs = drt.slice(drt.indexOf("function mergeStateField("), drt.indexOf("\n}\n", drt.indexOf("function mergeStateField(")));
    assert.ok(/target\[fieldName\] = \{\n\s+\.\.\.\(target\[fieldName\][^\n]*\n\s+\.\.\.normalizedPatch,\n\s+\};/.test(mfs), "first-level merge");
    assert.ok(/function mergeSpawnState\(instanceID, patch = \{\}, options = \{\}\) \{\n {2}return mergeStateField\(instanceID, "spawnState", patch, options\);/.test(drt));
    assert.ok(/error\.dungeonError = /.test(drt) && drt.includes('dungeonError("DUNGEON_INSTANCE_NOT_FOUND"'));

    const files = listJs(SERVER_SRC);
    const texts = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8").replace(/\r\n/g, "\n")]));
    const rel = (f) => path.relative(SERVER_SRC, f).replace(/\\/g, "/");
    const readers = [...texts].filter(([, t]) => t.includes("miningRockRemainingByID")).map(([f]) => rel(f)).sort();
    assert.deepStrictEqual(readers, [
      "services/dungeon/dungeonUniverseSiteService.js", "services/dungeon/missionMiningSettlement.js",
      "services/homefront/homefrontWorld.js", "services/mining/airMiningSettlement.js", "services/mining/miningRuntimeState.js",
    ]);
    assert.ok(norm("services/mining/airMiningSettlement.js").includes(`"${AIR_TEMPLATE_ID}"`), "AIR template");
    const mms = norm("services/dungeon/missionMiningSettlement.js");
    assert.ok(mms.includes(`const journalOf = instance => instance?.spawnState?.${MISSION_KEY} ||`), "journal key");
    assert.ok(mms.includes(`if (!instance?.spawnState?.${MISSION_KEY}) return { success: true, changes: [] };`), "reconcile without a journal = nothing");
    assert.ok(/function synchronizeScene\(instance, scene\) \{[\s\S]*?instance\.spawnState\?\.miningRockRemainingByID[\s\S]*?remainingQuantity: quantity/.test(mms), "scene from the record");
    assert.ok(mms.includes("return runtime().mergeSpawnState(instanceID, patch, { nowMs, durable: true, force: true });"), "mission commit = foreign write");
    assert.ok(mms.includes(`commit(instance.instanceID, { ${MISSION_KEY}: journal }, nowMs);`), "journal created by a patch without the rock key");
    assert.ok(/\nfunction settleExtraction\(instance, intent, nowMs = intent\.cycleAtMs\) \{/.test(mms) &&
      mms.includes("return settleExtraction(instance, intent);") &&
      mms.includes("return settleExtraction(instance, { ...intent, flagID, deliveredAtMs: nowMs }, nowMs);"), "extract and drone delivery both settle through one journal patch");
    const dus = norm("services/dungeon/dungeonUniverseSiteService.js");
    assert.ok(/if \(recordedRemaining !== null && recordedRemaining <= 0 &&[^\n]*\n\s+toInt\(populationHints\.retailResourceRevision, 0\) !== 1\) \{\n\s+return null;/.test(dus), "record <= 0 skips the rock");
    assert.ok(dus.includes(": (recordedRemaining === null ? rock.quantity : Math.min(rock.quantity, recordedRemaining)),"), "others: min(record)");
    const mat = dus.slice(dus.indexOf("const miningRockEntities = buildMiningRockEntities("));
    const loop = mat.slice(0, mat.indexOf("scene.addStaticEntity(entity);"));
    assert.ok(/if \(!gas && !revised && scene\.staticEntitiesByID && scene\.staticEntitiesByID\.has\(Number\(entity\.itemID\)\)\) \{\n\s+continue;\n\s+\}/.test(loop), "a present rock is skipped before addStaticEntity");
    assert.ok(loop.includes("const revised = entity.retailResourceRevision === 1;"));
    assert.ok(dus.includes("...(toInt(populationHints.retailResourceRevision, 0) === 1 ? { retailResourceRevision: 1 } : {}),"), "rock flag from populationHints");
    assert.ok(/instance\.spawnState\.populationHints &&\n\s+typeof instance\.spawnState\.populationHints === "object"\n\s+\? instance\.spawnState\.populationHints/.test(dus), "hints from spawnState");

    assert.ok(/miningRuntime\.handleSceneDisposed\(scene\)/.test(norm("space/runtime/spaceRuntime/sceneDisposal.js")));
    assert.ok(norm("services/mining/miningResourceSiteService.js").includes("module.exports.resetSceneGeneratedResourceSites = resetSceneGeneratedResourceSites;"));
    const gs = norm("gameStore/index.js");
    assert.ok(/\n {2}registerShutdownHook,\n/.test(gs) && /\n {2}isShutdownInProgress,\n/.test(gs), "gameStore exports");
    const sfs = gs.slice(gs.indexOf("function shutdownForSignal("));
    const hooksAt = sfs.indexOf("await runShutdownHooks(signal)");
    assert.ok(hooksAt > 0 && hooksAt < sfs.indexOf("await shutdown(signal)"), "hooks before shutdown()");

    const re = /mergeSpawnState\s*[,}]|handleSceneDisposed\s*[,}]|resetSceneGeneratedResourceSites\s*[,}]|getInstanceRef\s*[,}]/g;
    const bad = [];
    for (const [f, t] of texts) {
      for (const m of t.matchAll(re)) {
        const lines = t.slice(0, m.index).split("\n");
        let head = lines.length - 1;
        while (head > 0 && /^\s/.test(lines[head])) head -= 1;
        if (!/^[\w$]+(\.[\w$]+)+ = \{/.test(lines[head])) bad.push(`${rel(f)}: ${lines[head]}`);
      }
    }
    assert.deepStrictEqual(bad, []);
    const MODS = path.resolve(SERVER_SRC, "../../mods");
    const MERGE_CALLERS = new Set(["missionStructureRestore", "livingNewEden"]);
    const others = [];
    for (const dir of fs.readdirSync(MODS, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name === "hotPathPerf") continue;
      const re = MERGE_CALLERS.has(dir.name) ? /miningRockRemainingByID/ : /mergeSpawnState|miningRockRemainingByID/;
      for (const f of listJs(path.join(MODS, dir.name))) {
        if (re.test(fs.readFileSync(f, "utf8"))) others.push(f);
      }
    }
    assert.deepStrictEqual(others, []);
  });

  test("G6 loader: flag on wraps the write, dispose and the class static field; off unchanged; probe drift/waiting; coexistence with career", () => {
    const vendor = () => {
      const dr = fakeDungeon([inst(100, { 1: 500 })]);
      dr.listInstancesByLifecycle = function listInstancesByLifecycle() { return []; };
      const mergeOrig = dr.mergeSpawnState;
      const store = fakeStore();
      store.readPersisted = function readPersisted() { return { success: true, data: {} }; };
      const registerOrig = store.registerShutdownHook;
      const mr = { handleSceneDisposed: function handleSceneDisposed() { return "d"; } };
      class MiningResourceSiteService {}
      MiningResourceSiteService.resetSceneGeneratedResourceSites = function resetSceneGeneratedResourceSites() { return "r"; };
      return { dr, mergeOrig, store, registerOrig, mr, Cls: MiningResourceSiteService };
    };
    const lines = [];
    const mk = (cfg) => createState(cfg, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: (l) => lines.push(l), rockSetTimer: fakeTimers().setTimer });
    const ALL = ROCK_POINTS.map((p) => p.symbol);

    const v = vendor();
    const on = mk(rockConfig);
    patchTarget("dungeonRuntime", v.dr, on);
    patchTarget("gameStore", v.store, on);
    patchTarget("miningRuntime", v.mr, on);
    patchTarget("miningResourceSites", v.Cls, on);
    for (const s of ALL) assert.ok(on.patched.has(s), s);
    assert.strictEqual(v.dr.mergeSpawnState.__hotPathPerfOriginal, v.mergeOrig);
    assert.strictEqual(v.dr.mergeSpawnState.name, "mergeSpawnState");
    assert.ok(v.mr.handleSceneDisposed.__hotPathPerfRock);
    assert.ok(v.Cls.resetSceneGeneratedResourceSites.__hotPathPerfRock, "exportsStatic on a function export");
    assert.strictEqual(v.Cls.resetSceneGeneratedResourceSites(), "r");
    assert.strictEqual(v.store.registerShutdownHook, v.registerOrig, "gameStore only deps");
    on.gameSeen = true;
    assert.strictEqual(checkRockDrift(on), false);
    assert.ok(/^probe: passed/.test(probeMessage(on)) && !probeMessage(on).includes("rockRemainderCoalesce"), probeMessage(on));
    record(v.dr, 100, 1, 450, 1);
    assert.strictEqual(on.rock.status().pendingInstances, 1, "buffers through the loader");
    assert.ok(on.requestPattern.test("../services/mining/miningRuntime") && on.requestPattern.test("./miningResourceSiteService") && on.requestPattern.test("../../gameStore"));

    const off = mk(config);
    const vo = vendor();
    patchTarget("dungeonRuntime", vo.dr, off);
    patchTarget("miningRuntime", vo.mr, off);
    assert.strictEqual(off.rock, null);
    assert.strictEqual(vo.dr.mergeSpawnState, vo.mergeOrig);
    assert.strictEqual(vo.mr.handleSceneDisposed.name, "handleSceneDisposed");
    assert.strictEqual(off.requestPattern.source, requestPatternFor({}).source);
    for (const s of ALL) assert.ok(!off.expected.has(s), s);

    const vw = vendor();
    const wait = mk(rockConfig);
    patchTarget("dungeonRuntime", vw.dr, wait);
    patchTarget("gameStore", vw.store, wait);
    patchTarget("miningRuntime", vw.mr, wait);
    wait.gameSeen = true;
    assert.strictEqual(checkRockDrift(wait), false);
    assert.ok(/^probe: passed .*; rockRemainderCoalesce waiting$/.test(probeMessage(wait)), probeMessage(wait));
    patchTarget("miningResourceSites", function NoStatic() {}, wait);
    assert.ok(probeMessage(wait).startsWith("DRIFT: miningResourceSiteService.resetSceneGeneratedResourceSites#rockFlush"), probeMessage(wait));
    assert.strictEqual(wait.rock.status().disabledReason, null);

    const vd = vendor();
    const drift = mk(rockConfig);
    patchTarget("dungeonRuntime", vd.dr, drift);
    patchTarget("miningRuntime", vd.mr, drift);
    patchTarget("miningResourceSites", vd.Cls, drift);
    drift.gameSeen = true;
    assert.strictEqual(checkRockDrift(drift), true);
    assert.strictEqual(drift.rock.status().state, "disabled:drift");
    const msg = probeMessage(drift);
    assert.ok(msg.startsWith("DRIFT: gameStore#rockDeps") && msg.endsWith("; rockRemainderCoalesce disabled: drift"), msg);

    const vx = vendor();
    const inner = vx.dr.mergeSpawnState;
    vx.dr.mergeSpawnState = function otherModWrapper() { return inner.apply(this, arguments); };
    const ord = mk(rockConfig);
    patchTarget("dungeonRuntime", vx.dr, ord);
    assert.strictEqual(ord.rock.status().state, "disabled:order");
    assert.strictEqual(vx.dr.mergeSpawnState.name, "otherModWrapper");

    const vc = vendor();
    const both = mk({ ...rockConfig, careerAbyssalRead: true, careerCombatItemsRead: true });
    patchTarget("gameStore", vc.store, both);
    assert.strictEqual(vc.store.readPersisted.name, "hotPathPerfCareerGate");
    assert.strictEqual(vc.store.readPersisted.__hotPathPerfCareer.name, "readPersisted");
    assert.strictEqual(vc.store.registerShutdownHook, vc.registerOrig);
    assert.ok(both.patched.has("gameStore#rockDeps") && both.patched.has("gameStore.readPersisted#gate") && both.patched.has("gameStore.readPersisted#combatGate"));
  });
}

module.exports = { register };
