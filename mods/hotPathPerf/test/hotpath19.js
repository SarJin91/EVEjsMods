"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const { createSovCaptureEchoSkip, isOwnedHubEcho, TYPE_INFRASTRUCTURE_HUB } = require("../lib/sovCaptureEchoSkip");

const COMPOSE = path.resolve(__dirname, "../../../compose.yaml");

function echoHub(itemID = 101) {
  return {
    itemID,
    typeID: 32458,
    entosisCapture: { captureEpoch: "owned-hub:30000001:101:1", controllingTeamID: 99000001, scoreAtLastUpdateTime: 1 },
    devFlags: { sovereigntyOwnedHubCapture: { defenderAllianceID: 99000001 }, sovereigntyCaptureEpoch: "gm-capture:30000001:1" },
  };
}

function systems() {
  const prepared = echoHub(102);
  prepared.entosisCapture.completionReceipt = { status: "prepared" };
  return [
    { solarSystemID: 30000001, structures: [echoHub(101)] },
    { solarSystemID: 30000002, structures: [prepared] },
    { solarSystemID: 30000003, structures: [{ itemID: 103, typeID: 32458,
      entosisCapture: { captureEpoch: "initial-hub:30000003:103:5", controllingTeamID: 99000009,
        completionCandidateAllianceID: 99000002, scoreAtLastUpdateTime: 1 } }] },
  ];
}

const capturesOf = (list) => list.map((s) => s.structures.map((h) => `${h.itemID}:${h.entosisCapture ? "c" : "-"}`).join()).join("|");

function fakeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpath19-"));
  const dir = path.join(root, "server", "src", "services", "sovereignty");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "sovState.js"), "\"use strict\";\n" +
    `const SYSTEMS = ${JSON.stringify(systems())};\n` +
    "function listAllSovereigntySystemStates() { return JSON.parse(JSON.stringify(SYSTEMS)); }\n" +
    "module.exports = { listAllSovereigntySystemStates };\n");
  fs.writeFileSync(path.join(dir, "sovCaptureState.js"), "\"use strict\";\nconst path = require(\"node:path\");\n" +
    "const {\n  listAllSovereigntySystemStates,\n} = require(path.join(__dirname, \"./sovState\"));\n" +
    "function reconcilePreparedSovereigntyCaptures() {\n  const seen = listAllSovereigntySystemStates();\n" +
    "  return { success: true, errorMsg: null, data: { scannedCandidates: 0, completed: 0, blocked: 0, results: [], seen } };\n}\n" +
    "module.exports = { reconcilePreparedSovereigntyCaptures };\n");
  return { root, dir };
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
  const { test, src, loader, config } = ctx;

  test("hotpath19 SE1 echo predicate: truth table 1–6, throwing getter = false", () => {
    assert.strictEqual(TYPE_INFRASTRUCTURE_HUB, 32458);
    assert.strictEqual(isOwnedHubEcho(echoHub()), true, "owned-hub: vs gm-capture:");
    const broken = {
      "equal epoch": (h) => { h.devFlags.sovereigntyCaptureEpoch = h.entosisCapture.captureEpoch; },
      "receipt prepared": (h) => { h.entosisCapture.completionReceipt = { status: "prepared" }; },
      "score 0.99": (h) => { h.entosisCapture.scoreAtLastUpdateTime = 0.99; },
      "no sovereigntyOwnedHubCapture": (h) => { delete h.devFlags.sovereigntyOwnedHubCapture; },
      "type ≠ 32458": (h) => { h.typeID = 35833; },
      "empty devEpoch": (h) => { h.devFlags.sovereigntyCaptureEpoch = "  "; },
      "no capture": (h) => { delete h.entosisCapture; },
      "no winner": (h) => { h.entosisCapture.controllingTeamID = 0; },
    };
    for (const [name, mutate] of Object.entries(broken)) {
      const h = echoHub();
      mutate(h);
      assert.strictEqual(isOwnedHubEcho(h), false, name);
    }
    const throwing = echoHub();
    Object.defineProperty(throwing, "entosisCapture", { get() { throw new Error("boom"); } });
    assert.strictEqual(isOwnedHubEcho(throwing), false, "getter throws");
    assert.strictEqual(isOwnedHubEcho(null), false);
  });

  test("hotpath19 SE2 scope + mask: first list in scope masked, the same result, a line; throw; list_not_called", () => {
    let t = 1000;
    const lines = [];
    const skip = createSovCaptureEchoSkip({ config: { sovCaptureOwnedEchoSkip: true }, log: (l) => lines.push(l), now: () => t });
    const list = skip.wrapList(function listAllSovereigntySystemStates() { return systems(); });
    assert.strictEqual(skip.wrapList(list), list, "double wrap = noop");
    skip.markListFirstLoad();
    const seen = [];
    const R = { success: false, errorMsg: "SOVEREIGNTY_CAPTURE_FENCE_CHANGED", data: { scannedCandidates: 2, completed: 0, blocked: 0,
      results: [{ success: false, errorMsg: "SOVEREIGNTY_CAPTURE_FENCE_CHANGED" }, { success: true }] } };
    const reconcile = skip.wrapReconcile(function reconcilePreparedSovereigntyCaptures(...args) {
      seen.push(capturesOf(list()), capturesOf(list()));
      t += 42;
      assert.deepStrictEqual(args, [{ nowMs: 5 }], "arguments unchanged");
      return R;
    });
    assert.strictEqual(capturesOf(list()), "101:c|102:c|103:c", "full outside the scope");
    assert.strictEqual(reconcile({ nowMs: 5 }), R, "the same result object");
    assert.deepStrictEqual(seen, ["101:-|102:c|103:c", "101:c|102:c|103:c"], "mask only in the first call");
    assert.strictEqual(capturesOf(list()), "101:c|102:c|103:c", "full after the scope");
    assert.deepStrictEqual(lines, ["sovCaptureEcho: masked=1 scanned=2 completed=0 blocked=0 failed=1" +
      " errors=SOVEREIGNTY_CAPTURE_FENCE_CHANGED:1 ms=42 sample=30000001:101"]);
    const err = new Error("vendor boom");
    const thrower = skip.wrapReconcile(function reconcilePreparedSovereigntyCaptures() { throw err; });
    assert.throws(() => thrower(), (e) => e === err);
    assert.strictEqual(capturesOf(list()), "101:c|102:c|103:c", "after a throw the list has no mask");
    assert.strictEqual(skip.snapshot().state, "on");
    const noList = skip.wrapReconcile(function reconcilePreparedSovereigntyCaptures() { return { data: {} }; });
    noList();
    assert.deepStrictEqual(skip.snapshot(), { state: "disabled", reason: "list_not_called", masked: 1, calls: 3 });
    assert.ok(lines.includes("WARN sovCaptureOwnedEchoSkip disabled: list_not_called"), lines.join("|"));
    seen.length = 0;
    const before = lines.length;
    reconcile({ nowMs: 5 });
    assert.deepStrictEqual(seen, ["101:c|102:c|103:c", "101:c|102:c|103:c"], "no mask after disabling");
    assert.strictEqual(lines.length, before, "no summary line");
  });

  test("hotpath19 SE3 loader: flag 0 = not wrapped; first-load hook = on and mask; sweep (modules in cache) = late_wrap", () => {
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false };
    assert.strictEqual(loader.targetOf("/app/server/src/services/sovereignty/sovState.js"), "sovState");
    assert.strictEqual(loader.targetOf("/app/server/src/services/sovereignty/sovCaptureState.js"), "sovCaptureState");
    const viaHook = (flag) => withTree((tree) => {
      const lines = [];
      const state = loader.createState({ ...base, sovCaptureOwnedEchoSkip: flag }, null, { log: (l) => lines.push(l) });
      loader.installHook(state);
      const capture = require(path.join(tree.dir, "sovCaptureState.js"));
      const sov = require(path.join(tree.dir, "sovState.js"));
      const r = capture.reconcilePreparedSovereigntyCaptures();
      return { state, capture, sov, r, lines };
    });
    const off = viaHook(false);
    assert.strictEqual(off.state.sovEcho, null);
    assert.strictEqual(off.sov.listAllSovereigntySystemStates.__hotPathPerfSovEcho, undefined);
    assert.strictEqual(off.capture.reconcilePreparedSovereigntyCaptures.__hotPathPerfSovEcho, undefined);
    assert.strictEqual(capturesOf(off.r.data.seen), "101:c|102:c|103:c");
    assert.strictEqual(loader.sovEchoStateText(off.state), "off");

    const on = viaHook(true);
    assert.ok(on.sov.listAllSovereigntySystemStates.__hotPathPerfSovEcho);
    assert.ok(on.capture.reconcilePreparedSovereigntyCaptures.__hotPathPerfSovEcho);
    for (const symbol of loader.SOV_ECHO_REQUIRED) assert.ok(on.state.patched.has(symbol), symbol);
    assert.strictEqual(loader.sovEchoStateText(on.state), "on");
    assert.strictEqual(capturesOf(on.r.data.seen), "101:-|102:c|103:c", "destructured binding = our mask");
    assert.ok(on.lines.some((l) => /^sovCaptureEcho: masked=1 scanned=0 completed=0 .* sample=30000001:101$/.test(l)), on.lines.join("|"));
    on.state.gameSeen = true;
    assert.strictEqual(loader.checkSovEchoDrift(on.state), false);
    assert.ok(/^probe: passed \(2 /.test(loader.probeMessage(on.state)), loader.probeMessage(on.state));

    const late = withTree((tree) => {
      const lines = [];
      const capture = require(path.join(tree.dir, "sovCaptureState.js"));
      const state = loader.createState({ ...base, sovCaptureOwnedEchoSkip: true }, null, { log: (l) => lines.push(l) });
      loader.sweepModuleCache(state);
      return { state, capture, r: capture.reconcilePreparedSovereigntyCaptures(), lines };
    });
    assert.ok(late.capture.reconcilePreparedSovereigntyCaptures.__hotPathPerfSovEcho, "scope wrapped");
    assert.strictEqual(loader.sovEchoStateText(late.state), "disabled:late_wrap");
    assert.ok(late.lines.some((l) => l.startsWith("WARN sovCaptureOwnedEchoSkip disabled: late_wrap")), late.lines.join("|"));
    assert.strictEqual(capturesOf(late.r.data.seen), "101:c|102:c|103:c", "scope = original");
    assert.ok(!late.lines.some((l) => l.startsWith("sovCaptureEcho:")));
  });

  test("hotpath19 SE4 vendor facts: destructuring, reconcile loop, list clones, data.completed consumer, fence, constant, compose", () => {
    const capture = src("services/sovereignty/sovCaptureState.js").replace(/\r\n/g, "\n");
    assert.ok(/\n  listAllSovereigntySystemStates,\n[^}]*\} = require\(path\.join\(__dirname, "\.\/sovState"\)\);/.test(capture),
      "list destructured from ./sovState");
    assert.ok(/function reconcilePreparedSovereigntyCaptures\(options = \{\}\) \{\s*const nowMs = normalizeNowMs\(options\.nowMs\);\s*const results = \[\];\s*for \(const system of listAllSovereigntySystemStates\(\)\)/
      .test(capture), "start of reconcile");
    assert.ok(capture.includes("function normalizePositiveInteger(value, fallback = null) {\n  const numericValue = Number(value);\n" +
      "  if (!Number.isFinite(numericValue)) {\n    return fallback;\n  }\n  const integerValue = Math.trunc(numericValue);\n" +
      "  return integerValue > 0 ? integerValue : fallback;\n}"), "normalizePositiveInteger as the copy");
    assert.ok(capture.includes("function clampScore(value) {\n  const numericValue = Number(value);\n  if (!Number.isFinite(numericValue)) {\n" +
      "    return 0;\n  }\n  return Math.max(0, Math.min(1, numericValue));\n}"), "clampScore as the copy");
    assert.ok(capture.includes("const hasBlockedWinner =\n        !receipt &&\n        clampScore(capture.scoreAtLastUpdateTime) >= 1 &&\n" +
      "        normalizePositiveInteger(\n          capture.completionCandidateAllianceID,\n          capture.controllingTeamID,\n        );"),
    "hasBlockedWinner");
    assert.ok(capture.includes("if (!capture) {\n        continue;\n      }"), "hub without capture = continue");
    const sov = src("services/sovereignty/sovState.js").replace(/\r\n/g, "\n");
    assert.ok(sov.includes("function listAllSovereigntySystemStates() {\n  ensureLoaded();\n  return Object.values(tableCache.systems || {})\n" +
      "    .map((system) => cloneValue(system))"), "list = clones");
    assert.ok(sov.includes("(targetEpoch && targetEpoch !== captureEpoch)"), "epoch fence");
    assert.ok(!/require\([^)]*sovCaptureState/.test(sov), "sovState does not require sovCaptureState");
    const campaign = src("services/sovereignty/sovCampaignState.js").replace(/\r\n/g, "\n");
    const at = campaign.indexOf("function buildHubEntosisCapture(");
    assert.ok(at >= 0);
    const body = campaign.slice(at, campaign.indexOf("\nfunction ", at + 1));
    assert.ok(body.includes("controllingTeamID: state.defenderAllianceID") && !body.includes("completionReceipt"), body);
    const prod = src("services/scheduler/productionSchedulerRuntime.js").replace(/\r\n/g, "\n");
    assert.ok(prod.includes("sovereigntyCaptureOwner.reconcilePreparedSovereigntyCaptures("));
    const uses = [...prod.matchAll(/sovereigntyCaptureReconciliation/g)].map((m) => prod.slice(m.index + m[0].length, m.index + m[0].length + 20));
    assert.ok(uses.length >= 2, String(uses.length));
    const others = uses.filter((u) => !/^ = await/.test(u));
    assert.strictEqual(uses.length - others.length, 1, "one assignment");
    for (const u of others) assert.ok(/^(\s*&&|\.data\s*&&|\.data\.completed)/.test(u), `read: ${JSON.stringify(u)}`);
    assert.ok(src("services/sovereignty/sovConstants.js").includes(`const TYPE_INFRASTRUCTURE_HUB = ${TYPE_INFRASTRUCTURE_HUB};`));
    const compose = fs.readFileSync(COMPOSE, "utf8");
    assert.ok(compose.includes("      HOTPATH_SOV_CAPTURE_OWNED_ECHO_SKIP: ${HOTPATH_SOV_CAPTURE_OWNED_ECHO_SKIP:-1}"), "compose");
  });
}

module.exports = { register };
