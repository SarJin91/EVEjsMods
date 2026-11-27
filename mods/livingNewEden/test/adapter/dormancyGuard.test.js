"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const guard = require("../../lib/adapter/dormancyGuard");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function exportBlock(source) {
  const start = source.search(/^module\.exports = \{/m);
  assert.ok(start >= 0, "module.exports block");
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\};/m));
}

module.exports = ({ test }) => {
  test("DG1 dormancyGuard: protected entityID -> false without the original, else the original; release; one wrap "
    + "on a second install; blocked counts refusals", () => {
    const calls = [];
    const S = Symbol("foreign.wrapped");
    const original = function vendor(scene, controller, entity, options) {
      calls.push([controller.entityID, options && options.ignoreSceneSessionCount]);
      return true;
    };
    original[S] = true;
    const exportsObj = { canDematerializeDormantCombatController: original, isCombatDormantControllerRecord: () => true };
    assert.strictEqual(guard.checkHookInstalled(exportsObj), false);
    assert.deepStrictEqual(guard.install(exportsObj), { ok: true, alreadyInstalled: false });
    const wrapped = exportsObj.canDematerializeDormantCombatController;
    assert.notStrictEqual(wrapped, original);
    assert.strictEqual(wrapped[S], true, "a foreign symbol survives the chain-wrap");
    assert.strictEqual(guard.checkHookInstalled(exportsObj), true);

    const before = guard.stats().blocked;
    guard.protect(9100001);
    guard.protect(9100001);
    guard.protect(0);
    guard.protect("9100002");
    assert.strictEqual(guard.isProtected(9100001), true);
    assert.strictEqual(guard.isProtected(9100002), false);
    const scene = {};
    assert.strictEqual(wrapped(scene, { entityID: 9100001 }, {}, { ignoreSceneSessionCount: true }), false);
    assert.strictEqual(wrapped(scene, { itemID: 9100001 }, {}, {}), false, "itemID fallback");
    assert.deepStrictEqual(calls, [], "the original is not called for a protected ship");
    assert.strictEqual(wrapped(scene, { entityID: 9100003 }, {}, { ignoreSceneSessionCount: true }), true);
    assert.deepStrictEqual(calls, [[9100003, true]], "arguments passed through");
    assert.strictEqual(guard.stats().blocked - before, 2);
    assert.ok(guard.stats().protected >= 1);

    guard.release(9100001);
    guard.release(9100001);
    assert.strictEqual(guard.isProtected(9100001), false);
    assert.strictEqual(wrapped(scene, { entityID: 9100001 }, {}, {}), true, "after release -> the original");
    assert.strictEqual(guard.stats().blocked - before, 2);

    assert.deepStrictEqual(guard.install(exportsObj), { ok: true, alreadyInstalled: true });
    assert.strictEqual(exportsObj.canDematerializeDormantCombatController, wrapped, "one level of wrap");
    assert.strictEqual(guard.stats().installed, true);
    const { createAdapter } = require("../../lib/adapter");
    assert.deepStrictEqual(createAdapter({ moduleApi: { _cache: {} } }).readDormancyGuardStats(), guard.stats());

    const boom = { canDematerializeDormantCombatController: () => { throw new Error("vendor"); } };
    guard.install(boom);
    assert.throws(() => boom.canDematerializeDormantCombatController({}, { entityID: 1 }, {}), /vendor/);
    assert.deepStrictEqual(guard.install({}), { ok: false, reason: "NOT_A_FUNCTION" });
    const frozen = Object.freeze({ canDematerializeDormantCombatController: () => true });
    assert.deepStrictEqual(guard.install(frozen), { ok: false, reason: "NOT_WRITABLE" });
  });

  test("DG2 vendor facts: npcAnchorRelevance destructures the export and calls it with ignoreSceneSessionCount; "
    + "operatorKind qualifies; nativeNpcStore exports the purge functions; GAME_MODULES entries", () => {
    const relevance = readSource("space/npc/npcAnchorRelevance.js");
    assert.match(relevance, /\{[^}]*\bcanDematerializeDormantCombatController,[^}]*\}\s*=\s*require\(path\.join\(__dirname, "\.\/npcCombatDormancy"\)\);/);
    const demat = functionBody(relevance, "dematerializeIrrelevantCombatControllers");
    assert.match(demat, /canDematerializeDormantCombatController\(scene, liveController, entity, \{[^}]*ignoreSceneSessionCount: true/);
    const dormancy = readSource("space/npc/npcCombatDormancy.js");
    assert.ok(functionBody(dormancy, "isCombatDormantControllerRecord").includes("operatorKind !== \"\""));
    const canDemat = functionBody(dormancy, "canDematerializeDormantCombatController");
    assert.ok(canDemat.startsWith("\nfunction canDematerializeDormantCombatController(scene, controller, entity, "));
    const block = exportBlock(dormancy);
    for (const n of ["isCombatDormantControllerRecord", "canDematerializeDormantCombatController"]) {
      assert.match(block, new RegExp(`^ {2}${n},$`, "m"), n);
    }
    const store = exportBlock(readSource("space/npc/nativeNpcStore.js"));
    for (const n of ["getNativeController", "removeNativeEntityCascade"]) {
      assert.match(store, new RegExp(`^ {2}${n},$`, "m"), n);
    }
    const entry = GAME_MODULES.find((e) => e.path === "space/npc/npcCombatDormancy");
    assert.ok(entry, "GAME_MODULES entry");
    const wrapSym = entry.symbols.find((s) => s.name === "canDematerializeDormantCombatController");
    assert.deepStrictEqual([wrapSym.firstLoad, [...wrapSym.consumers]], [true, ["dormancyGuard"]]);
    const purge = GAME_MODULES.find((e) => e.path === "space/npc/nativeNpcStore").symbols
      .filter((s) => s.consumers.includes("dormancyPurge")).map((s) => s.name);
    assert.deepStrictEqual(purge, ["getNativeController", "removeNativeEntityCascade"]);
    const loaderSource = fs.readFileSync(path.join(__dirname, "..", "..", "loader.js"), "utf8");
    assert.ok(loaderSource.includes("\"npcCombatDormancy\""), "loader.js literal \"npcCombatDormancy\"");
  });
};
