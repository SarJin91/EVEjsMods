"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { wrapDurableSchedulerExports, wrapKillmailExports } = require("../../lib/adapter/stallSeams");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;

function vendorFactory() {
  const handlers = new Map();
  return Object.freeze({
    start() {},
    register(type, handler) {
      if (typeof handler !== "function") throw new TypeError("scheduler handlers require a type and function");
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
    dispatch: (type, job) => handlers.get(type)(job),
    size: () => handlers.size,
  });
}

module.exports = ({ test }) => {
  test("SD-S4 stall seams: SD-F vendor facts, scheduler and killmail wraps on fakes, GAME_MODULES", () => {
    const src = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(src.ok, "EveJS server/src not found above the mod");
    const read = (rel) => fs.readFileSync(path.join(src.srcDir, rel), "utf8").replace(/\r\n/g, "\n");
    const sched = read(path.join("services", "scheduler", "durableScheduler.js"));
    assert.ok(sched.includes("\nmodule.exports = { createDurableScheduler };"), "SD-F1 export line");
    assert.match(sched, /\n {2}return Object\.freeze\(\{\n(?:.*\n){0,5} {4}register\(type, handler\) \{/,
      "SD-F2 frozen instance literal with register");
    assert.ok(sched.includes("      return () => handlers.delete(normalizedType);"), "SD-F3 register returns unregister");
    assert.ok(sched.includes("const handler = handlers.get(String(job && job.type || \"\"));")
      && sched.includes("await enterHandler(() => handler(Object.freeze({"), "SD-F4 dispatch calls the registered handler");
    assert.match(read(path.join("services", "scheduler", "productionSchedulerRuntime.js")),
      /const \{ createDurableScheduler \} = require\(/, "SD-F5 destructured -> first load");
    const km = read(path.join("services", "killmail", "killmailState.js"));
    assert.match(km, /\nfunction getAllKillmailRecords\(\) \{\n {2}return redactReservedAbyssalHostsFromKillmails\(\n {4}cloneValue\(ensureKillmailIndexes\(\)\.recordsDesc\),/,
      "SD-F6 definer: full clone");
    assert.match(km, /\n {2}getAllKillmailRecords,\n/, "SD-F7 export block");
    const map = read(path.join("services", "map", "mapService.js"));
    assert.match(map, /\n {2}forEachKillmailRecordDescending,\n\} = require\([^)]*killmailState"\)/,
      "SD-F8 mapService destructures the walk");
    assert.ok(!map.includes("getAllKillmailRecords"), "SD-F8 no getAll in mapService");

    let now = 0;
    const notes = { foreign: [], jobs: [] };
    const sink = { noteForeign: (l, s, ms) => notes.foreign.push([l, s, ms]), noteJob: (t, a, ms) => notes.jobs.push([t, a, ms]) };
    const exp = { createDurableScheduler: vendorFactory };
    assert.deepStrictEqual(wrapDurableSchedulerExports(exp, sink, { slowMs: 50, now: () => now }), { ok: true });
    assert.deepStrictEqual(wrapDurableSchedulerExports(exp, sink), { ok: false, reason: "already_wrapped" });
    assert.deepStrictEqual(wrapDurableSchedulerExports(Object.freeze({ createDurableScheduler: vendorFactory }), sink),
      { ok: false, reason: "not_writable" });
    assert.deepStrictEqual(wrapDurableSchedulerExports({}, sink), { ok: false, reason: "missing" });
    const s = exp.createDurableScheduler();
    assert.ok(Object.isFrozen(s));
    const promise = Promise.resolve(7);
    const unregister = s.register("ess.settlement", () => {
      now += 60;
      return promise;
    });
    assert.strictEqual(s.dispatch("ess.settlement", {}), promise, "the handler's promise unchanged");
    assert.deepStrictEqual(notes.jobs, [["ess.settlement", 0, 60]]);
    assert.deepStrictEqual(notes.foreign, [["job:ess.settlement", 0, 60]]);
    const err = new Error("boom");
    s.register("bad", () => { throw err; });
    assert.throws(() => s.dispatch("bad", {}), (e) => e === err);
    assert.strictEqual(notes.foreign.length, 1, "a fast handler is not a foreign span");
    assert.throws(() => s.register("x", null), TypeError, "a non-function goes to the vendor");
    assert.strictEqual(s.size(), 2);
    assert.strictEqual(unregister(), true);
    assert.strictEqual(s.size(), 1);

    const records = Object.freeze([{ killmailID: 1 }]);
    const km2 = { getAllKillmailRecords: () => {
      now += 80;
      return records;
    } };
    notes.foreign.length = 0;
    assert.deepStrictEqual(wrapKillmailExports(km2, sink, { slowMs: 50, stackDepth: 8, now: () => now,
      rootDir: REPO_ROOT }), { ok: true });
    assert.deepStrictEqual(wrapKillmailExports(km2, sink, { slowMs: 50 }), { ok: false, reason: "already_wrapped" });
    assert.strictEqual(km2.getAllKillmailRecords(), records);
    assert.strictEqual(notes.foreign.length, 1);
    assert.ok(notes.foreign[0][0].startsWith("vendor:killmail.getAll<-mods/livingNewEden/test/adapter/stallSeams.test.js:"),
      notes.foreign[0][0]);
    assert.strictEqual(notes.foreign[0][2], 80);

    const entry = (p) => GAME_MODULES.find((e) => e.path === p).symbols.map((x) => [x.name, x.kind, x.firstLoad,
      x.wrap, [...x.consumers]]);
    assert.deepStrictEqual(entry("services/scheduler/durableScheduler"),
      [["createDurableScheduler", "export", true, undefined, ["telemetry.stallDiag"]]]);
    assert.deepStrictEqual(entry("services/killmail/killmailState"),
      [["getAllKillmailRecords", "export", true, undefined, ["telemetry.stallDiag"]],
        ["forEachKillmailRecordDescending", "export", true, undefined, ["inGameMap.starmap"]],
        ["getKillmailProjectionStats", "export", undefined, undefined, ["dbsKillmailCache", "shipAiDb"]],
        ["listKillmailsForCharacter", "export", undefined, undefined, ["shipAiDb"]],
        ["createKillmailRecordIdempotent", "export", undefined, undefined, ["freeCorpsKillmails"]],
        ["getKillmailRecord", "export", undefined, undefined, ["killboard.vendorKills"]],
        ["listPendingKillmailEvents", "export", undefined, undefined, ["killboard.vendorKills"]]]);
  });
};
