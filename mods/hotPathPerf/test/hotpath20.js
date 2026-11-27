"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { createCynoBroadcastFilter } = require("../lib/cynoBroadcastFilter");

const COMPOSE = path.resolve(__dirname, "../../../compose.yaml");

function fakeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath20-"));
  const src = path.join(root, "server", "src", "services");
  for (const dir of ["chat", "sovereignty", "structure"]) fs.mkdirSync(path.join(src, dir), { recursive: true });
  fs.writeFileSync(path.join(src, "chat", "sessionRegistry.js"), "\"use strict\";\n" +
    "function getSessions() { return [{ solarsystemid2: 30000002 }]; }\nmodule.exports = { getSessions };\n");
  fs.writeFileSync(path.join(src, "sovereignty", "sovSuppressionState.js"), "\"use strict\";\nconst seen = [];\n" +
    "function broadcastCynoJammerChangesForStructureRows(previousRows = [], nextRows = [], options = {}) {\n" +
    "  seen.push(options.systemIDs);\n  return options.systemIDs.length;\n}\n" +
    "module.exports = { broadcastCynoJammerChangesForStructureRows, seen };\n");
  fs.writeFileSync(path.join(src, "structure", "structureState.js"), "\"use strict\";\nconst path = require(\"node:path\");\n" +
    "require(path.join(__dirname, \"../chat/sessionRegistry\"));\n" +
    "function maybeBroadcast(systemIDs) {\n  const {\n    broadcastCynoJammerChangesForStructureRows,\n" +
    "  } = require(path.join(__dirname, \"../sovereignty/sovSuppressionState\"));\n" +
    "  return broadcastCynoJammerChangesForStructureRows([], [], { systemIDs });\n}\nmodule.exports = { maybeBroadcast };\n");
  return { root, src };
}

function withTree(fn) {
  const tree = fakeTree();
  const previous = Module._load;
  try {
    return fn(tree);
  } finally {
    Module._load = previous;
    for (const key of Object.keys(require.cache)) if (key.startsWith(tree.root)) delete require.cache[key];
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
}

function register(ctx) {
  const { test, src, listJs, loader, config, SERVER_SRC } = ctx;

  test("hotpath20 CF1 filter: only systems with a session in input order, the same this/options/result; empty = 0; passthrough; sessions_error", () => {
    const lines = [];
    let sessions = [{ solarsystemid2: 2 }, { solarsystemid: 1 }, { charid: 7 }, null];
    const filter = createCynoBroadcastFilter({ config: { cynoBroadcastSessionFilter: true }, log: (l) => lines.push(l) });
    assert.strictEqual(filter.setSessionRegistry({ getSessions: () => sessions }), true);
    const calls = [];
    const R = { n: 3 };
    const original = function broadcastCynoJammerChangesForStructureRows(...args) {
      calls.push({ self: this, args });
      return R;
    };
    const wrapped = filter.wrapBroadcast(original);
    assert.strictEqual(filter.wrapBroadcast(wrapped), wrapped, "double wrap = noop");
    const self = { tag: "this" };
    const prev = [{ itemID: 1 }];
    const next = [{ itemID: 2 }];
    assert.strictEqual(wrapped.call(self, prev, next, { systemIDs: [3, 1, 2], nowMs: 5 }), R, "the original's result");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].self, self, "the same this");
    assert.strictEqual(calls[0].args[0], prev);
    assert.strictEqual(calls[0].args[1], next);
    assert.deepStrictEqual(calls[0].args[2], { systemIDs: [1, 2], nowMs: 5 }, "input order, options unchanged");
    assert.strictEqual(wrapped(prev, next, { systemIDs: [3, 4] }), 0);
    assert.strictEqual(calls.length, 1, "original not called");
    const opts = { systemIDs: "x" };
    wrapped(prev, next, opts);
    assert.strictEqual(calls[1].args[2], opts);
    wrapped(prev);
    assert.deepStrictEqual(calls[2].args, [prev], "no extra arguments");
    assert.deepStrictEqual(filter.drainStatsLines(), ["cynoBroadcast stats calls=2 systems=5 kept=2 skipped=3 noop=1"]);
    assert.deepStrictEqual(filter.drainStatsLines(), [], "empty window = no line");
    sessions = null;
    filter.setSessionRegistry({ getSessions: () => { throw new Error("boom"); } });
    wrapped(prev, next, { systemIDs: [3] });
    assert.deepStrictEqual(calls[3].args[2], { systemIDs: [3] }, "passthrough without the filter");
    assert.strictEqual(filter.snapshot().state, "disabled");
    assert.strictEqual(filter.snapshot().reason, "sessions_error");
    assert.ok(lines.includes("WARN cynoBroadcastSessionFilter disabled: sessions_error (boom)"), lines.join("|"));
    const off = createCynoBroadcastFilter({ config: { cynoBroadcastSessionFilter: false } });
    off.setSessionRegistry({ getSessions: () => { throw new Error("do not read"); } });
    assert.strictEqual(off.wrapBroadcast(original)(prev, next, { systemIDs: [9] }), R);
    assert.strictEqual(off.snapshot().state, "off");
  });

  test("hotpath20 CF2 vendor facts: lazyRequire + destructuring in the body, return 0 without a session, session match, the only consumer, compose", () => {
    const structure = src("services/structure/structureState.js").replace(/\r\n/g, "\n");
    assert.ok(structure.includes("    resolved = require(path.join(__dirname, relativeId));\n    _lazyModuleCache.set(relativeId, resolved);"),
      "lazyRequire caches the module object");
    const at = structure.indexOf("function maybeBroadcastCynoJammerStateChanges(");
    assert.ok(at >= 0, "maybeBroadcastCynoJammerStateChanges");
    const body = structure.slice(at, structure.indexOf("\nfunction ", at + 1));
    assert.ok(body.includes("    const {\n      broadcastCynoJammerChangesForStructureRows,\n" +
      "    } = lazyRequire(\"../sovereignty/sovSuppressionState\");"), body);
    assert.ok(body.includes("return broadcastCynoJammerChangesForStructureRows(previousRows, nextRows, {\n      systemIDs,\n    });"), body);
    const notif = src("services/sovereignty/sovNotifications.js").replace(/\r\n/g, "\n");
    const bAt = notif.indexOf("function broadcastCynoJammerChanged(");
    const bBody = notif.slice(bAt, notif.indexOf("\nfunction ", bAt + 1));
    assert.ok(bBody.includes("if (sessions.length === 0) {\n    return 0;\n  }"), bBody);
    assert.ok(bBody.includes("solarSystemID: numericSolarSystemID,"), bBody);
    assert.ok(notif.includes("for (const session of sessionRegistry.getSessions()) {"), "getTargetSessions iterates getSessions");
    assert.ok(notif.includes("session && (session.solarsystemid2 || session.solarsystemid),"), "session system match");
    const supp = src("services/sovereignty/sovSuppressionState.js").replace(/\r\n/g, "\n");
    assert.ok(supp.includes("const systemIDs = Array.isArray(options.systemIDs)\n    ? options.systemIDs\n"), "systemIDs from the options");
    assert.ok(supp.includes("notifiedSessions += broadcastCynoJammerChanged(numericSystemID, nextSimTime);"), "suma = broadcast");
    assert.ok(supp.includes("function normalizePositiveInteger(value, fallback = null) {\n  const numeric = normalizeInteger(value, 0);\n" +
      "  return numeric > 0 ? numeric : fallback;\n}"), "normalizePositiveInteger as the copy");
    const users = listJs(SERVER_SRC).filter((f) => fs.readFileSync(f, "utf8").includes("broadcastCynoJammerChangesForStructureRows"))
      .map((f) => path.relative(SERVER_SRC, f).replace(/\\/g, "/")).sort();
    assert.deepStrictEqual(users, ["services/sovereignty/sovSuppressionState.js", "services/structure/structureState.js"]);
    assert.strictEqual(structure.split("broadcastCynoJammerChangesForStructureRows(").length - 1, 1, "one call");
    const compose = fs.readFileSync(COMPOSE, "utf8");
    assert.ok(compose.includes("      HOTPATH_CYNO_BROADCAST_SESSION_FILTER: ${HOTPATH_CYNO_BROADCAST_SESSION_FILTER:-1}"), "compose");
  });

  test("hotpath20 CF3 loader: flag 0 = not wrapped; 1 = wrapped by the hook, the consumer gets systems with a session, probe without DRIFT", () => {
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false };
    assert.strictEqual(loader.targetOf("/app/server/src/services/sovereignty/sovSuppressionState.js"), "sovSuppressionState");
    const run = (flag) => withTree((tree) => {
      const lines = [];
      const state = loader.createState({ ...base, cynoBroadcastSessionFilter: flag }, null, { log: (l) => lines.push(l) });
      loader.installHook(state);
      const structure = require(path.join(tree.src, "structure", "structureState.js"));
      const n = structure.maybeBroadcast([30000003, 30000002, 30000001]);
      const supp = require(path.join(tree.src, "sovereignty", "sovSuppressionState.js"));
      return { state, n, supp, lines };
    });
    const off = run(false);
    assert.strictEqual(off.state.cyno, null);
    assert.strictEqual(off.supp.broadcastCynoJammerChangesForStructureRows.__hotPathPerfCyno, undefined);
    assert.deepStrictEqual(off.supp.seen, [[30000003, 30000002, 30000001]]);
    assert.strictEqual(loader.cynoStateText(off.state), "off");

    const on = run(true);
    assert.ok(on.supp.broadcastCynoJammerChangesForStructureRows.__hotPathPerfCyno, "wrapped");
    for (const symbol of loader.CYNO_REQUIRED) assert.ok(on.state.patched.has(symbol), symbol);
    assert.deepStrictEqual(on.supp.seen, [[30000002]], "only the system with a session");
    assert.strictEqual(on.n, 1);
    assert.strictEqual(loader.cynoStateText(on.state), "on");
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkCynoDrift(on.state), false);
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));
  });
}

module.exports = { register };
