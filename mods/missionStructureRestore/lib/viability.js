"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SERVICE_FILE = "server/src/services/dungeon/dungeonUniverseSiteService.js";

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "dungeonUniverseSiteService",
    file: SERVICE_FILE,
    required: Object.freeze([
      "DungeonUniverseSiteService.ensureSiteContentsMaterialized = ensureSiteContentsMaterialized;",
      "DungeonUniverseSiteService.homefrontPorts = {\n  structure: spawnEncounterKillableStructures,",
      "  rocks: buildMiningRockEntities,\n  roomAnchor: resolveRoomWorldPositionForTemplate,",
      "function resolveRoomWorldPositionForTemplate(sitePosition, template, roomKey) {",
      "function spawnEncounterKillableStructures(scene, instance, siteEntity, encounterPlan, spawnEntries, options = {}) {",
      "anchorPosition: options.anchorPosition,",
      "return context.hasNpcEntries !== true;",
      "entry.entity.dungeonObjectiveTargetKey =",
      "isManagedMaterializedSiteInstance(instance) &&\n      instanceReferencesEncounterEntityID(instance, entityID)",
      "spawnEntry.blocksObjectiveProgress === true",
      "function entityOrSpawnEntryMatchesObjectiveTarget(candidate, target) {",
      "DungeonUniverseSiteService._testing = {",
    ]),
  }),
  Object.freeze({
    key: "dungeonRuntime",
    file: "server/src/services/dungeon/dungeonRuntime.js",
    required: Object.freeze([
      "  mergeSpawnState,",
      "  getInstance,",
      "target.metadata.objectiveTargetsDestroyed = [...destroyedKeys, key];",
    ]),
  }),
  Object.freeze({
    key: "agentMgrService",
    file: "server/src/services/agent/agentMgrService.js",
    required: Object.freeze(["dungeonUniverseSiteService.ensureSiteContentsMaterialized("]),
  }),
  Object.freeze({
    key: "keeperService",
    file: "server/src/services/dungeon/keeperService.js",
    required: Object.freeze(["dungeonUniverseSiteService.ensureSiteContentsMaterialized(scene, {"]),
  }),
  Object.freeze({
    key: "agentMissionRuntime",
    file: "server/src/services/agent/agentMissionRuntime.js",
    required: Object.freeze(["      siteKind: \"mission\",\n      siteOrigin: \"agentMission\","]),
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
  SERVICE_FILE,
  SOURCE_REQUIREMENTS,
  inspect,
  inspectSourceShape,
};
