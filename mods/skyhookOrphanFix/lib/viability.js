"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOV = "server/src/services/sovereignty";

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "sovStaticData",
    file: `${SOV}/sovStaticData.js`,
    required: Object.freeze([
      "function getSovereigntyStaticSnapshot() {",
      "  if (!staticSnapshotCache) {",
      "  getSovereigntyStaticSnapshot,\n};",
    ]),
  }),
  Object.freeze({
    key: "sovModernState",
    file: `${SOV}/sovModernState.js`,
    required: Object.freeze([
      "const {\n  getSovereigntyStaticSnapshot,\n} = require(path.join(__dirname, \"./sovStaticData\"));",
      "const definition = staticSnapshot.planetDefinitionsByPlanetID.get(Number(orbital.planetID));",
      "if (!definition) continue;",
      "const planets = getSovereigntyStaticSnapshot().planetDefinitionsByPlanetID;",
      "const planet = planets.get(Number(entry.planetID));",
      "if (!active && (access.skyhook.reagentDefinitions || []).length > 0) {",
    ]),
  }),
  Object.freeze({
    key: "sovUpgradeSupport",
    file: `${SOV}/sovUpgradeSupport.js`,
    required: Object.freeze(["const {\n  getSovereigntyStaticSnapshot,\n} = require(path.join(__dirname, \"./sovStaticData\"));"]),
  }),
  Object.freeze({
    key: "sovereigntyGatewayService",
    file: "server/src/_secondary/express/gatewayServices/sovereigntyGatewayService.js",
    required: Object.freeze([
      "const {\n  getSovereigntyStaticSnapshot,\n} = require(path.join(__dirname, \"../../../services/sovereignty/sovStaticData\"));",
    ]),
  }),
  Object.freeze({
    key: "skyhookHarvest",
    file: `${SOV}/skyhookHarvest.js`,
    required: Object.freeze(["for (const simulation of skyhook.reagentSimulations || []) {"]),
  }),
  Object.freeze({
    key: "skyhookRuntime",
    file: `${SOV}/skyhookRuntime.js`,
    required: Object.freeze([
      "const reagent = state && state.reagentDefinitions[0];",
      "if (!reagent) throw refusal(\"SkyhookExtractionFailed\", \"SKYHOOK_NO_REAGENTS\");",
    ]),
  }),
  Object.freeze({
    key: "skyhookRaidRuntime",
    file: `${SOV}/skyhookRaidRuntime.js`,
    required: Object.freeze([
      "if (!record.reagentSimulations.some((row) => row.unsecuredStock > 0)) return { success: false, errorMsg: \"SKYHOOK_SURPLUS_EMPTY\" };",
    ]),
  }),
  Object.freeze({
    key: "worldData",
    file: "server/src/space/worldData.js",
    required: Object.freeze(["function getCelestialByID(celestialID) {", "  getCelestialByID,\n"]),
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
