"use strict";

process.env.EVEJS_INDUSTRY_ORPHAN_CLEANUP_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));
const wraps = require(path.join(modDir, "lib", "wraps.js"));

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const DELIVERED = 101;
const CANCELLED = 102;
const ACTIVE = 1;

function makeConfig(overrides = {}) {
  return Object.freeze({ ...configModule.DEFAULTS, ...overrides, problems: Object.freeze([]) });
}

function makeRuntime(overrides = {}) {
  const lines = [];
  const errors = [];
  const runtime = loader._testing.createRuntime({
    config: makeConfig(overrides),
    logFn: (message) => lines.push(message),
    logErrorFn: (message) => errors.push(message),
  });
  return { runtime, lines, errors };
}

function makeWorld({ items = [], records = {}, jobs = [], itemOwners = {} } = {}) {
  const world = {
    items: new Set(items),
    records: { ...records },
    removeCalls: [],
    jobs: Object.fromEntries(jobs.map((job) => [String(job.jobID), job])),
  };
  world.industry = {
    getBlueprintState(id) {
      return world.records[String(id)] || null;
    },
    removeBlueprintState(id) {
      world.removeCalls.push(id);
      delete world.records[String(id)];
      return true;
    },
  };
  world.itemStore = { findItemById: (id) => (world.items.has(Number(id)) ? { itemID: Number(id) } : null) };
  world.store = { read: (table) => ({ success: true, errorMsg: null, data: table === "industryJobs" ? { jobs: world.jobs } : {} }) };
  world.vendorResult = { success: true, deletedAt: "1", assetSummary: {}, privateStateSummary: {} };
  world.deletion = {
    prepareCharacterForDelete() {},
    deleteCharacter(characterID) {
      for (const [itemID, ownerID] of Object.entries(itemOwners)) {
        if (ownerID === characterID) world.items.delete(Number(itemID));
      }
      return world.vendorResult;
    },
  };
  return world;
}

function wireRuntime(world, overrides) {
  const ctx = makeRuntime(overrides);
  assert.deepStrictEqual(ctx.runtime.applyReference("industry", world.industry), { ok: true });
  assert.deepStrictEqual(ctx.runtime.applyReference("items", world.itemStore), { ok: true });
  assert.deepStrictEqual(ctx.runtime.applyReference("store", world.store), { ok: true });
  assert.deepStrictEqual(ctx.runtime.applyDeletion(world.deletion), { ok: true });
  return ctx;
}

test("T1 viability: real v0.12.9 server files have every seam token once", () => {
  const report = viability.inspect(runtimeRoot);
  assert.strictEqual(report.ok, true, JSON.stringify(report.reports.filter((entry) => !entry.ok)));
  const broken = viability.inspect(runtimeRoot, [
    { key: "charService", file: "server/src/services/character/charService.js", required: ["no such seam token"] },
  ]);
  assert.strictEqual(broken.ok, false);
  assert.match(broken.reports[0].reason, /count 0, expected 1/u);
});

test("T2 happy path: delivered and cancelled orphans of char 9 removed, vendor result returned as is", () => {
  const world = makeWorld({
    items: [1001, 1002],
    itemOwners: { 1001: 9, 1002: 9 },
    records: {
      1001: { jobID: 0, lastCompletedJobID: 1 },
      1002: { jobID: 0, lastCancelledJobID: 2 },
    },
    jobs: [
      { jobID: 1, blueprintID: 1001, ownerID: 9, status: DELIVERED },
      { jobID: 2, blueprintID: 1002, ownerID: 9, status: CANCELLED },
    ],
  });
  const { runtime, lines } = wireRuntime(world);
  const result = world.deletion.deleteCharacter(9, 77);
  assert.strictEqual(result, world.vendorResult);
  assert.deepStrictEqual(world.records, {});
  assert.deepStrictEqual(world.removeCalls.sort(), [1001, 1002]);
  assert.strictEqual(runtime.stats.removed, 2);
  assert.strictEqual(runtime.stats.deletes, 1);
  assert.strictEqual(runtime.stats.cleanups, 1);
  assert.match(lines[lines.length - 1], /^removed 2 state records for char 9 \(bp=100[12],100[12]\)$/u);
  assert.strictEqual(Object.keys(world.jobs).length, 2, "jobs stay as history");
});

test("T3 untouched: active job, pending job, non-terminal job, existing item, other characters", () => {
  const world = makeWorld({
    items: [2004],
    records: {
      2001: { jobID: 3, lastCompletedJobID: 0 },
      2002: { jobID: 0, lastCompletedJobID: 4 },
      2003: { jobID: 0, lastCompletedJobID: 6 },
      2004: { jobID: 0, lastCompletedJobID: 8 },
      3001: { jobID: 0, lastCompletedJobID: 9 },
      2005: { jobID: 0, lastCompletedJobID: 11 },
      2006: { jobID: 0, lastCompletedJobID: 12 },
    },
    jobs: [
      { jobID: 3, blueprintID: 2001, ownerID: 9, status: DELIVERED },
      { jobID: 4, blueprintID: 2002, ownerID: 9, status: DELIVERED },
      { jobID: 5, blueprintID: 2002, ownerID: 9, status: DELIVERED, installationPending: true },
      { jobID: 6, blueprintID: 2003, ownerID: 9, status: DELIVERED },
      { jobID: 7, blueprintID: 2003, ownerID: 9, status: ACTIVE },
      { jobID: 8, blueprintID: 2004, ownerID: 9, status: DELIVERED },
      { jobID: 9, blueprintID: 3001, ownerID: 10, status: DELIVERED },
      { jobID: 10, blueprintID: 2005, ownerID: 9, status: DELIVERED },
      { jobID: 11, blueprintID: 2005, ownerID: 10, status: DELIVERED },
      { jobID: 12, blueprintID: 2006, ownerID: 9, status: DELIVERED },
    ],
  });
  const { runtime, lines } = wireRuntime(world);
  world.deletion.deleteCharacter(9, 77);
  assert.deepStrictEqual(Object.keys(world.records).sort(), ["2001", "2002", "2003", "2004", "2005", "3001"]);
  assert.deepStrictEqual(world.removeCalls, [2006]);
  assert.strictEqual(runtime.stats.removed, 1);
  assert.strictEqual(runtime.stats.skipped, 4);
  const line = lines[lines.length - 1];
  assert.match(line, /2001:STATE_HAS_ACTIVE_JOB/u);
  assert.match(line, /2002:JOB_NOT_TERMINAL/u);
  assert.match(line, /2003:JOB_NOT_TERMINAL/u);
  assert.match(line, /2005:OWNER_NOT_DELETED_CHARACTER/u);
});

test("T4 exceptions: vendor throw propagates without cleanup; cleanup throw keeps the result", () => {
  const world = makeWorld({
    records: { 1001: { jobID: 0, lastCompletedJobID: 1 } },
    jobs: [{ jobID: 1, blueprintID: 1001, ownerID: 9, status: DELIVERED }],
  });
  world.deletion.deleteCharacter = () => {
    throw new Error("That character is still waiting for the biomass timer to expire.");
  };
  const { runtime } = wireRuntime(world);
  assert.throws(() => world.deletion.deleteCharacter(9, 77), /biomass timer/u);
  assert.deepStrictEqual(world.removeCalls, []);
  assert.strictEqual(runtime.stats.deletes, 0);

  const second = makeWorld({
    records: { 1001: { jobID: 0, lastCompletedJobID: 1 } },
    jobs: [{ jobID: 1, blueprintID: 1001, ownerID: 9, status: DELIVERED }],
  });
  second.industry.removeBlueprintState = () => {
    throw new Error("gameStore shutdown is in progress");
  };
  const ctx = wireRuntime(second);
  assert.strictEqual(second.deletion.deleteCharacter(9, 77), second.vendorResult);
  assert.strictEqual(ctx.runtime.stats.errors, 1);
  assert.match(ctx.errors[0], /cleanup for char 9 failed - deletion result kept/u);
  const third = makeWorld({
    records: { 1001: { jobID: 0, lastCompletedJobID: 1 } },
    jobs: [{ jobID: 1, blueprintID: 1001, ownerID: 9, status: DELIVERED }],
  });
  third.vendorResult = { success: false };
  wireRuntime(third);
  assert.strictEqual(third.deletion.deleteCharacter(9, 77), third.vendorResult);
  assert.deepStrictEqual(third.removeCalls, []);
});

test("T5 DRIFT, deps and hook: inert without deleteCharacter, passthrough without deps, first-load wrap", () => {
  const { runtime, errors } = makeRuntime();
  const partial = { prepareCharacterForDelete() {} };
  assert.deepStrictEqual(runtime.applyDeletion({}), { ok: false, reason: "pending" });
  assert.strictEqual(runtime.state.inert, false);
  assert.deepStrictEqual(runtime.applyDeletion(partial), { ok: false, reason: "drift" });
  assert.strictEqual(runtime.state.inert, true);
  assert.deepStrictEqual(Object.keys(partial), ["prepareCharacterForDelete"]);
  assert.match(errors[0], /^DRIFT characterDeletionRuntime\.deleteCharacter - mod inert/u);
  const later = { prepareCharacterForDelete() {}, deleteCharacter() { return { success: true }; } };
  const original = later.deleteCharacter;
  runtime.applyDeletion(later);
  assert.strictEqual(later.deleteCharacter, original, "inert mod wraps nothing");

  const world = makeWorld({
    records: { 1001: { jobID: 0, lastCompletedJobID: 1 } },
    jobs: [{ jobID: 1, blueprintID: 1001, ownerID: 9, status: DELIVERED }],
  });
  const ctx = makeRuntime();
  ctx.runtime.applyReference("items", world.itemStore);
  ctx.runtime.applyReference("store", world.store);
  assert.deepStrictEqual(ctx.runtime.applyReference("industry", { getBlueprintState() {} }), { ok: false, reason: "pending" });
  ctx.runtime.applyDeletion(world.deletion);
  assert.strictEqual(world.deletion.deleteCharacter(9, 77), world.vendorResult);
  assert.strictEqual(ctx.runtime.stats.skippedDeps, 1);
  assert.deepStrictEqual(world.removeCalls, []);
  assert.deepStrictEqual(
    wraps.wrapDeleteCharacter(world.deletion, { state: ctx.runtime.state, stats: ctx.runtime.stats, deps: ctx.runtime.deps, config: makeConfig(), logFn() {}, onError() {} }),
    { ok: false, reason: "already-wrapped" },
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ioc-hook-"));
  const file = (relative) => path.join(root, ...relative.split("/"));
  const files = {
    store: file("server/src/gameStore/index.js"),
    items: file("server/src/services/inventory/itemStore.js"),
    industry: file("server/src/services/industry/industryRuntimeState.js"),
    deletion: file("server/src/services/character/characterDeletionRuntime.js"),
    charService: file("server/src/services/character/charService.js"),
  };
  for (const filename of Object.values(files)) fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(
    files.store,
    "const jobs = { 1: { jobID: 1, blueprintID: 1001, ownerID: 9, status: 101 } };\n" +
      "module.exports = { read: () => ({ success: true, data: { jobs } }) };\n",
  );
  fs.writeFileSync(files.items, "module.exports = { findItemById: () => null };\n");
  fs.writeFileSync(
    files.industry,
    "const records = { 1001: { jobID: 0, lastCompletedJobID: 1 } };\n" +
      "module.exports = { records, getBlueprintState: (id) => records[id] || null,\n" +
      "  removeBlueprintState: (id) => { delete records[id]; return true; } };\n",
  );
  fs.writeFileSync(
    files.deletion,
    "require('../inventory/itemStore'); require('../../gameStore');\n" +
      "module.exports = { prepareCharacterForDelete() {}, deleteCharacter: () => ({ success: true }) };\n",
  );
  fs.writeFileSync(
    files.charService,
    "const { deleteCharacter } = require('./characterDeletionRuntime');\n" +
      "require('../industry/industryRuntimeState');\n" +
      "module.exports = { remove: (id) => deleteCharacter(id, 1) };\n",
  );
  const hookCtx = makeRuntime();
  const savedLoad = Module._load;
  try {
    const hookState = loader._testing.installModuleHook(hookCtx.runtime, root, () => {});
    const charService = require(files.charService);
    assert.strictEqual(hookState.pending.size, 0);
    assert.deepStrictEqual(charService.remove(9), { success: true });
    assert.deepStrictEqual(require(files.industry).records, {});
    assert.strictEqual(hookCtx.runtime.stats.removed, 1);
  } finally {
    Module._load = savedLoad;
    for (const filename of Object.values(files)) delete require.cache[filename];
    fs.rmSync(root, { recursive: true, force: true });
  }

  const entrypoint = fs.readFileSync(path.join(runtimeRoot, "docker", "entrypoint.sh"), "utf8");
  assert.strictEqual(entrypoint.split("--require /app/mods/industryOrphanCleanup/loader.js").length - 1, 2);
});

let passed = 0;
let failed = 0;
const selected = tests.filter((entry) => !only || only.some((fragment) => entry.name.includes(fragment)));
for (const entry of selected) {
  try {
    entry.fn();
    passed += 1;
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${entry.name}`);
    console.log(error && error.stack ? error.stack : error);
  }
}
console.log(`${passed}/${selected.length} PASS`);
process.exitCode = failed > 0 ? 1 : 0;
