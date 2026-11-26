"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "characterDeletionRuntime",
    file: "server/src/services/character/characterDeletionRuntime.js",
    required: Object.freeze([
      "function deleteCharacter(characterID, accountID) {",
      "  deleteCharacter,",
      "  prepareCharacterForDelete,",
      "isDeleted: true,",
    ]),
  }),
  Object.freeze({
    key: "charService",
    file: "server/src/services/character/charService.js",
    required: Object.freeze(["} = require(\"./characterDeletionRuntime\");"]),
  }),
  Object.freeze({
    key: "industryRuntimeState",
    file: "server/src/services/industry/industryRuntimeState.js",
    required: Object.freeze([
      "function removeBlueprintState(itemID) {",
      "delete payload.records[String(numericItemID)];",
      "function getBlueprintState(itemID, inventoryItem = null) {",
      "function getRecoverableIndustrySourceIntent",
    ]),
  }),
  Object.freeze({
    key: "industryConstants",
    file: "server/src/services/industry/industryConstants.js",
    required: Object.freeze(["INDUSTRY_JOBS_TABLE = \"industryJobs\""]),
  }),
  Object.freeze({
    key: "itemStore",
    file: "server/src/services/inventory/itemStore.js",
    required: Object.freeze(["  findItemById,"]),
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
