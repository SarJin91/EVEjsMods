"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const DUNGEON = path.join(SERVER_SRC, "services", "dungeon");
const FILES = Object.freeze({
  runtime: path.join(DUNGEON, "dungeonRuntime.js"),
  siteService: path.join(DUNGEON, "dungeonUniverseSiteService.js"),
  tracking: path.join(DUNGEON, "dungeonTrackingRuntime.js"),
  exploration: path.join(DUNGEON, "dungeonExplorationMgrService.js"),
});

const textOf = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function functionBody(text, header) {
  const at = text.indexOf(header);
  if (at < 0) return null;
  const end = text.indexOf("\nfunction ", at + header.length);
  return text.slice(at, end < 0 ? text.length : end);
}

function methodBody(text, header) {
  const at = text.indexOf(header);
  if (at < 0) return null;
  const end = text.indexOf("\n  }\n", at);
  return text.slice(at, end < 0 ? text.length : end);
}

module.exports = ({ test, skip }) => {
  const name = "ESA1 vendor facts: dungeonRuntime listener register/unregister exported, setLifecycleState emits "
    + "updated with source setLifecycleState, maybeCompleteClearedEncounterSite settles achievements then completes "
    + "with encounters_cleared, tracking writes achievementCompletionCharacterIDs, escalation journal rowset empty";
  const missing = Object.values(FILES).filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    skip(name, `vendor file not found: ${missing.map((f) => path.basename(f)).join(", ")}`);
    return;
  }
  test(name, () => {
    const runtime = textOf(FILES.runtime);
    assert.ok(runtime.includes("\nfunction registerInstanceChangeListener(listener) {"), "register declared");
    assert.ok(runtime.includes("\nfunction unregisterInstanceChangeListener(listener) {"), "unregister declared");
    const exportsAt = runtime.lastIndexOf("\nmodule.exports = {");
    assert.ok(exportsAt > 0, "module.exports block");
    const exportsBlock = runtime.slice(exportsAt);
    assert.ok(exportsBlock.includes("\n  registerInstanceChangeListener,\n"), "register exported");
    assert.ok(exportsBlock.includes("\n  unregisterInstanceChangeListener,\n"), "unregister exported");
    const register = functionBody(runtime, "function registerInstanceChangeListener(");
    assert.ok(/return false;/.test(register) && /return true;/.test(register), "register answers true/false");
    const emit = functionBody(runtime, "function emitInstanceChange(");
    assert.ok(emit && emit.includes("listener(payload);") && emit.includes("catch (error)"),
      "emit calls each listener inside try/catch");
    for (const field of ["changeType:", "before,", "after,", "metadata:"]) {
      assert.ok(emit.includes(field), `payload field ${field}`);
    }
    const setLifecycle = functionBody(runtime, "function setLifecycleState(");
    assert.ok(setLifecycle, "setLifecycleState declared");
    assert.ok(setLifecycle.includes("target.timers.completedAtMs ="), "completedAtMs written on completed");
    assert.ok(/emitInstanceChange\("updated", existing, updated, \{\s*source: "setLifecycleState",/.test(setLifecycle),
      "setLifecycleState emits updated with source setLifecycleState");

    const siteService = textOf(FILES.siteService);
    const complete = functionBody(siteService, "function maybeCompleteClearedEncounterSite(");
    assert.ok(complete, "maybeCompleteClearedEncounterSite declared");
    const settle = complete.indexOf("settleSiteCompletionAchievements(");
    const setCompleted = complete.indexOf("setLifecycleState(latestInstance.instanceID, \"completed\"");
    const reason = complete.indexOf("lifecycleReason: \"encounters_cleared\"");
    assert.ok(settle > 0 && setCompleted > settle && reason > setCompleted,
      `order settle ${settle} < completed ${setCompleted} < reason ${reason}`);
    assert.ok(complete.includes("!== \"combat\""), "combat family only");
    assert.strictEqual(siteService.split("lifecycleReason: \"encounters_cleared\"").length - 1, 1,
      "encounters_cleared is set on this one path");

    const tracking = textOf(FILES.tracking);
    const settleBody = functionBody(tracking, "function settleSiteCompletionAchievements(");
    assert.ok(settleBody && settleBody.includes("achievementCompletionCharacterIDs"),
      "tracking writes achievementCompletionCharacterIDs");
    assert.ok(settleBody.includes("evejs-election:") && settleBody.includes("metadata.eventID"),
      "the time limited filter mirrored by completionOf");

    const exploration = textOf(FILES.exploration);
    const journal = methodBody(exploration, "  buildEscalatingPathDetails() {");
    assert.ok(journal, "buildEscalatingPathDetails declared");
    assert.ok(/buildRowset\(\s*\[\.\.\.ESCALATING_PATH_HEADER\],\s*\[\],/.test(journal), "empty escalation rowset");
  });
};
