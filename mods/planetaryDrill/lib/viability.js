"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SOV = "server/src/services/sovereignty";
const PLANET = "server/src/services/planet";
const GATEWAY = "server/src/_secondary/express/gatewayServices";

const once = (token) => Object.freeze({ token, count: 1 });
const times = (token, count) => Object.freeze({ token, count });

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "sovStaticData",
    file: `${SOV}/sovStaticData.js`,
    required: Object.freeze([
      once("function getSovereigntyStaticSnapshot() {"),
      once("  if (!staticSnapshotCache) {"),
      once("  getSovereigntyStaticSnapshot,\n};"),
      once("reagentDefinitions: (source.reagentDefinitions || []).map((definition) => ({"),
    ]),
  }),
  Object.freeze({
    key: "sovModernState",
    file: `${SOV}/sovModernState.js`,
    required: Object.freeze([
      once("const {\n  getSovereigntyStaticSnapshot,\n} = require(path.join(__dirname, \"./sovStaticData\"));"),
      once("const definition = staticSnapshot.planetDefinitionsByPlanetID.get(Number(orbital.planetID));"),
      once("const planets = getSovereigntyStaticSnapshot().planetDefinitionsByPlanetID;"),
      once("refreshResourceDefinitions: resourcesChanged,"),
      once("next.reagentDefinitions = cloneValue(definition.reagentDefinitions || []);"),
      once("cache.orbitalRevision === orbitalRevision &&"),
      once("cache.staticSnapshot === getSovereigntyStaticSnapshot()"),
      once("function invalidateSovereigntyModernStateCache() {"),
      once("  invalidateSovereigntyModernStateCache,\n"),
    ]),
  }),
  Object.freeze({
    key: "skyhookRuntime",
    file: `${SOV}/skyhookRuntime.js`,
    required: Object.freeze([once("const reagent = state && state.reagentDefinitions[0];")]),
  }),
  Object.freeze({
    key: "sovereigntyGatewayService",
    file: `${GATEWAY}/sovereigntyGatewayService.js`,
    required: Object.freeze([
      once("const {\n  getSovereigntyStaticSnapshot,\n} = require(path.join(__dirname, \"../../../services/sovereignty/sovStaticData\"));"),
      times("definitions: staticSnapshot.planetDefinitions.map(", 2),
      times("reagent_definitions: (skyhook.reagentDefinitions || []).map(", 2),
      times("reagent_simulations: (skyhook.reagentSimulations || []).map(", 2),
      times("planet_resources_definitions_version: buildSemanticVersion(", 2),
    ]),
  }),
  Object.freeze({
    key: "gatewayServiceHelpers",
    file: `${GATEWAY}/gatewayServiceHelpers.js`,
    required: Object.freeze([once("const leftPre = Array.isArray(leftValue.prerelease_tags)")]),
  }),
  Object.freeze({
    key: "planetOrbitalState",
    file: `${PLANET}/planetOrbitalState.js`,
    required: Object.freeze([
      once("function getDeployedSkyhookRevision() {"),
      once("  getDeployedSkyhookRevision,\n"),
      once("  readState,\n  writeState,\n"),
      once("return Boolean(intent && !intent.completed && Number(intent.launchedItemID) === Number(record.itemID));"),
    ]),
  }),
  Object.freeze({
    key: "itemStore",
    file: "server/src/services/inventory/itemStore.js",
    required: Object.freeze([once("function findItemById(itemId) {")]),
  }),
  Object.freeze({
    key: "worldData",
    file: "server/src/space/worldData.js",
    required: Object.freeze([once("function getCelestialByID(celestialID) {"), once("  getCelestialByID,\n")]),
  }),
  Object.freeze({
    key: "planetStaticData",
    file: `${PLANET}/planetStaticData.js`,
    required: Object.freeze([once("function getPlanetResourceTypeIDs(planetTypeID) {"), once("  getPlanetResourceTypeIDs,\n")]),
  }),
  Object.freeze({
    key: "planetRuntimeStore",
    file: `${PLANET}/planetRuntimeStore.js`,
    required: Object.freeze([
      once("function buildResourceRecord(planetMeta, resourceTypeIDs = []) {"),
      once("    const nextRecord = buildResourceRecord(planetMeta, resourceTypeIDs);"),
      once("  _testing: {\n    setNowFileTimeOverride,\n    resetNowFileTimeOverride,\n    buildPin,\n    buildResourceRecord,\n"),
      once("const security = Number(planetMeta && planetMeta.security);"),
    ]),
  }),
]);

const SHIP = "server/src/services/ship";

const LAUNCH_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "orbitalLaunchRuntime",
    file: `${SHIP}/orbitalLaunchRuntime.js`,
    required: Object.freeze([
      once("  if (toInt(item.typeID, 0) === 81080) {"),
      once("  if (sourceTypeID === 81080) {"),
      once("function launchOrbitalsFromShip(session, rawItemIDs, options = {}) {"),
      once("module.exports = {\n  launchOrbitalsFromShip,"),
      once("    normalizeLaunchRequests,"),
      once("    buildOrbitalSpawnState,"),
      once("    if (Array.isArray(entry)) {"),
    ]),
  }),
  Object.freeze({
    key: "shipService",
    file: `${SHIP}/shipService.js`,
    required: Object.freeze([once("  launchOrbitalsFromShip,\n} = require(path.join(__dirname, \"./orbitalLaunchRuntime\"));")]),
  }),
  Object.freeze({
    key: "itemCustody",
    file: "server/src/services/inventory/itemCustody.js",
    required: Object.freeze([once("command.reason === CUSTODY_REASON.SKYHOOK_DEPLOY && Number(currentItem.typeID) !== 81080")]),
  }),
  Object.freeze({
    key: "skyhookOfficeReplacement",
    file: `${PLANET}/skyhookOfficeReplacement.js`,
    required: Object.freeze([
      once("return existing.sourceItem.itemID === item.itemID"),
      once("const intent = { phase: \"deploying\", planetID, systemID: context.systemID, sourceItem: clone(item),"),
      once("if (source && Number(source.typeID) === 81080 &&"),
      once("intent.launchedItemID = Number(launched.itemID);"),
      once("const planetID = orbitals.findNearestPlanetID(context.systemID, spawnState.position);"),
    ]),
  }),
  Object.freeze({
    key: "planetOrbitalState",
    file: `${PLANET}/planetOrbitalState.js`,
    required: Object.freeze([once("function findNearestPlanetID(solarSystemID, position = null) {")]),
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
    .filter(({ token, count }) => countOf(source, token) !== count)
    .map(({ token, count }) => `seam ${JSON.stringify(token)} count ${countOf(source, token)}, expected ${count}`);
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

function inspectLaunch(runtimeRoot) {
  return inspect(runtimeRoot, LAUNCH_REQUIREMENTS);
}

module.exports = {
  LAUNCH_REQUIREMENTS,
  SOURCE_REQUIREMENTS,
  inspect,
  inspectLaunch,
  inspectSourceShape,
};
