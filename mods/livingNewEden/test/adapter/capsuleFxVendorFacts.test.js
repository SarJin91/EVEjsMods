"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { CAREER_LESSON_DUNGEON_IDS } = require("../../lib/adapter/capsuleFx");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function functionBody(text, head) {
  const at = text.indexOf(head);
  if (at < 0) return null;
  const next = text.indexOf("\nfunction ", at + head.length);
  return text.slice(at, next < 0 ? text.length : next);
}

module.exports = ({ test }) => {
  test("CFXF vendor facts: show identity, its destruction branch, untargetable flag, transient spawn and warp", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");

    const identity = read("space", "FireShow", "showIdentity.js");
    for (const part of ["entity.kind === \"ship\"", "entity.nativeNpc === true", "entity.transient === true",
      "entity.npcEntityType === \"fireShow\""]) {
      assert.ok(identity.includes(part), `isFireShowShip: ${part}`);
    }

    const destruction = read("space", "runtime", "combatDestruction.js");
    const branch = destruction.indexOf("require(\"../FireShow/showIdentity\").isFireShowShip(entity)");
    const shipPath = destruction.lastIndexOf("if (entity.kind === \"ship\") {", branch);
    const career = destruction.indexOf("snapshotAttackHull(", branch);
    const wreckCall = destruction.indexOf("destroyShipEntityWithWreck", branch);
    const bounty = destruction.indexOf("recordNpcBountyForCombatDestruction(", branch);
    assert.ok(branch > shipPath && shipPath > 0, "show branch inside the ship path");
    assert.ok(career > branch && wreckCall > branch && bounty > branch, "show branch before career, wreck, bounty");
    const branchText = destruction.slice(branch, career);
    assert.ok(branchText.includes("persistSpaceState: false") && branchText.includes("syntheticShow: true")
      && branchText.includes("return {"), "show branch returns after removing the entity without a wreck");

    const tracker = read("space", "combat", "killmailTracker.js");
    const record = functionBody(tracker, "function recordKillmailFromDestruction(");
    assert.ok(record && record.includes("isFireShowShip(targetEntity)"), "no killmail for a show ship");

    const targeting = read("space", "runtime", "targeting.js");
    assert.ok(targeting.includes("airMiningTargetable === false"), "untargetable flag");

    const dynamics = read("space", "runtime", "spaceRuntime", "dynamicEntities.js");
    const spawn = dynamics.slice(dynamics.indexOf("spawnDynamicShip(systemID, shipSpec, options = {}) {"));
    const spawnBody = spawn.slice(0, spawn.indexOf("\n  },\n"));
    assert.ok(spawnBody.includes("applyRuntimeEntityScopeMetadata(entity, options.entityScopeMetadata)"),
      "spawn applies the scope metadata");
    assert.ok(spawnBody.includes("persistSpaceState: options.persistSpaceState === true"), "spawn persist flag");

    const store = read("space", "npc", "nativeNpcStore.js");
    const allocate = functionBody(store, "function allocateID(");
    assert.ok(allocate && allocate.includes("if (options.transient === true) {"), "transient id branch");

    const warp = read("space", "destiny", "commands", "warpCommands.js");
    assert.ok(warp.includes("if (options.ignoreWarpDisruptionField !== true) {"), "warp disruption bypass");

    const disposal = read("space", "runtime", "spaceRuntime", "sceneDisposal.js");
    const byDescriptor = new RegExp("getSceneByDescriptor\\(sceneDescriptor\\) \\{\\n\\s*"
      + "const descriptor = normalizeSceneDescriptor\\(sceneDescriptor\\);\\n\\s*"
      + "return descriptor \\? this\\.scenes\\.get\\(descriptor\\.sceneKey\\) \\|\\| null : null;");
    assert.ok(byDescriptor.test(disposal), "scene by descriptor without loading");
  });

  test("CFXF2 vendor facts: career lesson blast wrecks site native NPCs; lesson dungeon IDs; summary source", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const read = (...p) => fs.readFileSync(path.join(found.srcDir, ...p), "utf8").replace(/\r\n/g, "\n");

    const career = read("services", "dungeon", "careerLessonRuntime.js");
    const ids = /const IDS = new Set\(\[([\d,\s]+)\]\);/.exec(career);
    assert.ok(ids, "career lesson dungeon id set");
    const vendorIds = ids[1].split(",").map((s) => Number(s.trim())).sort((a, b) => a - b);
    assert.deepStrictEqual(vendorIds, [...CAREER_LESSON_DUNGEON_IDS].sort((a, b) => a - b));
    assert.ok(career.includes("IDS.has(Number(template?.sourceDungeonID))"), "contract keys on sourceDungeonID");
    const blast = career.indexOf("const pirates = scene.getDynamicEntities().filter(");
    assert.ok(blast > 0, "blast pirate filter");
    const blastText = career.slice(blast, career.indexOf("\n  }\n", blast));
    for (const part of ["entity.kind === \"ship\"", "entity.nativeNpc === true",
      "Number(entity.dungeonSiteInstanceID) === Number(instance.instanceID)", "destroyShipEntityWithWreck("]) {
      assert.ok(blastText.includes(part), `blast: ${part}`);
    }

    const scope = read("space", "destiny", "identity", "interactionScope.js");
    const child = functionBody(scope, "function buildChildEntityScopeMetadata(");
    assert.ok(child && child.includes("[\"dungeonSiteInstanceID\", scope.dungeonInstanceID]"),
      "child scope copies the dungeon instance");
    const resolve = functionBody(scope, "function resolveEntityInteractionScope(");
    assert.ok(/"dungeonCurrentInstanceID",\s*"dungeonSiteInstanceID",/.test(resolve), "dungeon instance aliases");

    const instance = read("services", "dungeon", "dungeonRuntime.js");
    assert.ok(instance.includes("sourceDungeonID: template.sourceDungeonID || null,"), "instance keeps template id");
    const state = read("services", "dungeon", "dungeonRuntimeState.js");
    const summary = functionBody(state, "function buildInstanceSummary(");
    assert.ok(summary && summary.includes("sourceDungeonID: instance.sourceDungeonID,"), "summary source id");
  });
};
