"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "gameStore",
    file: "server/src/gameStore/index.js",
    required: Object.freeze([
      "return { success: true, errorMsg: null, data: db };",
      "function write(table, pth, data, options = {}) {",
      "const unchanged = !sameReference && !changedSegments && options.force !== true &&",
      "if (unchanged) {",
      "  read,",
      "  write,",
    ]),
  }),
  Object.freeze({
    key: "dailyGoalsState",
    file: "server/src/services/dailyGoals/dailyGoalsState.js",
    required: Object.freeze([
      "const TABLE_NAME = \"dailyGoals\";",
      "const database = require(path.join(__dirname, \"../../gameStore\"));",
      "database.read(TABLE_NAME, \"/\")",
      "const result = database.write(\n    TABLE_NAME,\n    \"/\",",
      "  redeemGoal,",
      "  claimMonthlyMilestone,",
    ]),
  }),
  Object.freeze({
    key: "dailyGoalsGateway",
    file: "server/src/_secondary/express/gatewayServices/dailyGoalsGatewayService.js",
    required: Object.freeze([
      "dailyGoalsState.redeemGoal(activeCharacterID, uuid)",
      "dailyGoalsState.claimMonthlyMilestone(activeCharacterID, uuid)",
      "statusCode: result.success ? 200 : 404,",
    ]),
  }),
]);

function countOf(source, token) {
  return source.split(token).length - 1;
}

function inspectSourceShape(runtimeRoot, definition) {
  const filename = path.join(runtimeRoot, ...definition.file.split("/"));
  let source = "";
  try {
    source = fs.readFileSync(filename, "utf8").replace(/\r\n/gu, "\n");
  } catch (error) {
    return { key: definition.key, filename, ok: false, reason: error.message };
  }
  const problems = definition.required
    .filter((token) => countOf(source, token) !== 1)
    .map((token) => `seam ${JSON.stringify(token)} count ${countOf(source, token)}, expected 1`);
  return {
    key: definition.key,
    filename,
    ok: problems.length === 0,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

function inspect(runtimeRoot, requirements = SOURCE_REQUIREMENTS) {
  const reports = requirements.map((definition) => inspectSourceShape(runtimeRoot, definition));
  return { ok: reports.every((report) => report.ok), reports };
}

module.exports = {
  SOURCE_REQUIREMENTS,
  inspect,
  inspectSourceShape,
};
