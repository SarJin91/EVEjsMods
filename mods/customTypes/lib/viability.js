"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { ACTIVITY_KEYS, BLUEPRINT_CATEGORY_ID } = require("./pack");

const INDUSTRY = "server/src/services/industry";

const ACTIVITY_BLOCK = [
  "const ACTIVITY_KEY_BY_ID = Object.freeze({",
  ...ACTIVITY_KEYS.map((key) => `  [INDUSTRY_ACTIVITY.${key.toUpperCase()}]: "${key}",`),
  "});",
].join("\n");

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "referenceData",
    file: "server/src/services/_shared/referenceData.js",
    required: Object.freeze([
      "  ITEM_TYPES: \"itemTypes\",",
      "  TYPE_DOGMA: \"typeDogma\",",
      "  [TABLE.ITEM_TYPES]: \"types\",",
      "function readStaticTable(tableName) {\n  if (cache.has(tableName)) {\n    return cache.get(tableName);",
      "function readStaticRows(tableName) {\n  const payload = readStaticTable(tableName);",
      "  readStaticTable,\n  readStaticRows,\n",
    ]),
  }),
  Object.freeze({
    key: "itemTypeRegistry",
    file: "server/src/services/inventory/itemTypeRegistry.js",
    required: Object.freeze([
      "  readStaticRows,\n} = require(path.join(__dirname, \"../_shared/referenceData\"));",
      "const types = readStaticRows(TABLE.ITEM_TYPES);",
    ]),
  }),
  Object.freeze({
    key: "gameStore",
    file: "server/src/gameStore/index.js",
    required: Object.freeze([
      "return { success: true, errorMsg: null, data: db };",
      "function preloadAll() {",
      "  preloadAll,\n",
    ]),
  }),
  Object.freeze({
    key: "industryStaticData",
    file: `${INDUSTRY}/industryStaticData.js`,
    required: Object.freeze([
      "const database = require(path.join(__dirname, \"../../gameStore\"));",
      "const payload = readTable(INDUSTRY_BLUEPRINT_TABLE);",
      "Array.isArray(payload.blueprintDefinitions)",
      "function clearIndustryStaticCaches() {\n  blueprintCache = null;",
      "  clearIndustryStaticCaches,\n",
    ]),
  }),
  Object.freeze({
    key: "industryConstants",
    file: `${INDUSTRY}/industryConstants.js`,
    required: Object.freeze([
      "const INDUSTRY_BLUEPRINT_TABLE = \"industryBlueprints\";",
      `const BLUEPRINT_CATEGORY_ID = ${BLUEPRINT_CATEGORY_ID};`,
    ]),
  }),
  Object.freeze({
    key: "industryParityHelpers",
    file: `${INDUSTRY}/industryParityHelpers.js`,
    required: Object.freeze([ACTIVITY_BLOCK]),
  }),
  Object.freeze({
    key: "bootstrap",
    file: "server/bootstrap.js",
    required: Object.freeze(["async function bootWorld(options = {}) {", "  bootWorld,\n"]),
  }),
  Object.freeze({
    key: "itemStore",
    file: "server/src/services/inventory/itemStore.js",
    required: Object.freeze([
      "function listItemsMatching(predicate) {",
      "function removeInventoryItem(itemId, options = {}) {",
    ]),
  }),
]);

const CONTRACTS = "server/src/services/contracts";
const AUTHORITY_REQUIRE = "require(\"../corporation/corporationAuthority\")";

const SHOP_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "contractRuntimeState",
    file: `${CONTRACTS}/contractRuntimeState.js`,
    required: Object.freeze([
      "async function createContract(rawInfo, session, options = {}) {",
      "async function deleteContract(contractID, session, options = {}) {",
      "function listContractRecords(predicate = null) {",
      "    if (key !== \"_meta\" && value && typeof value === \"object\") {\n      yield value;",
      "const CORP_ROLE_CONTRACT_MANAGER = ",
      "function toFileTimeBigInt(value) {",
      "  CONTRACT_STATUS,\n",
      "  CORP_ROLE_CONTRACT_MANAGER,\n",
      "  toFileTimeBigInt,\n",
      "\n  listContractRecords,\n  getContractRecord,\n",
      "  createContract,\n",
      "  deleteContract,\n",
    ]),
    functionRequires: Object.freeze([
      Object.freeze({ header: "function getSessionCorporationID(session) {", token: AUTHORITY_REQUIRE }),
      Object.freeze({ header: "function sessionHasCorpContractManagerRole(session) {", token: AUTHORITY_REQUIRE }),
      Object.freeze({ header: "function canAccessCorporationContractItem(session, ownerID, locationID, flagID, takeRequired = false) {",
        token: AUTHORITY_REQUIRE }),
      Object.freeze({ header: "function getAuctionCreationTerms(info, session) {", token: "ConTooManyContractsMax" }),
    ]),
  }),
  Object.freeze({
    key: "contractSettlementState",
    file: `${CONTRACTS}/contractSettlementState.js`,
    required: Object.freeze(["function listPendingContractSettlements() {", "  listPendingContractSettlements,\n"]),
  }),
  Object.freeze({
    key: "corporationAuthority",
    file: "server/src/services/corporation/corporationAuthority.js",
    required: Object.freeze(["function getPersistedCorporationAuthority(session) {", "  getPersistedCorporationAuthority,\n"]),
  }),
  Object.freeze({
    key: "corporationState",
    file: "server/src/services/corporation/corporationState.js",
    required: Object.freeze(["function getCorporationRecord(corporationID) {", "  getCorporationRecord,\n"]),
  }),
  Object.freeze({
    key: "industryRuntimeState",
    file: `${INDUSTRY}/industryRuntimeState.js`,
    required: Object.freeze([
      "function seedBlueprintForOwner(ownerID, locationID, options = {}) {",
      "function getBlueprintState(itemID, inventoryItem = null) {",
      "  seedBlueprintForOwner,\n",
      "  getBlueprintState,\n",
    ]),
  }),
  Object.freeze({
    key: "itemStoreShop",
    file: "server/src/services/inventory/itemStore.js",
    required: Object.freeze([
      "function listContainerItems(ownerId, locationId, flagId = null, typeIds = null) {",
      "  CORP_DELIVERIES: 62,",
      "  listContainerItems,\n",
    ]),
  }),
  Object.freeze({
    key: "worldData",
    file: "server/src/space/worldData.js",
    required: Object.freeze(["function getStationByID(stationID) {", "  getStationByID,\n"]),
  }),
]);

const MONITOR_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "industryMonitorService",
    file: `${INDUSTRY}/industryMonitorService.js`,
    required: Object.freeze([
      "  Handle_ConnectJob(args, session) {",
      "    const result = connectMonitor(session, request);",
      "      result.data.monitorID,\n      buildAvailableMaterialsPayload(result.data.availableMaterials),\n    ];",
      "module.exports = IndustryMonitorService;",
    ]),
  }),
  Object.freeze({
    key: "baseServiceDispatch",
    file: "server/src/services/baseService.js",
    required: Object.freeze([
      "const handlerName = `Handle_${normalizedMethod}`;",
      "const result = this[handlerName](args, session, kwargs, callContext);",
    ]),
  }),
  Object.freeze({
    key: "industryPayloads",
    file: `${INDUSTRY}/industryPayloads.js`,
    required: Object.freeze([
      "function parseIndustryRequest(value) {",
      "    blueprintID: toInt(request.blueprintID, 0),",
      "    inputLocation: parseLocationRequest(request.inputLocation),",
      "  parseIndustryRequest,\n",
    ]),
  }),
  Object.freeze({
    key: "serviceHelpersDict",
    file: "server/src/services/_shared/serviceHelpers.js",
    required: Object.freeze(["function buildDict(entries = []) {\n  return {\n    type: \"dict\",\n    entries,\n  };\n}"]),
  }),
  Object.freeze({
    key: "industryRuntimeStateBlueprint",
    file: `${INDUSTRY}/industryRuntimeState.js`,
    required: Object.freeze(["function getBlueprintByItemID(itemID, session = null) {", "  getBlueprintByItemID,\n"]),
  }),
  Object.freeze({
    key: "industryStaticDataDefinition",
    file: `${INDUSTRY}/industryStaticData.js`,
    required: Object.freeze([
      "function getBlueprintDefinitionByTypeID(blueprintTypeID) {",
      "  getBlueprintDefinitionByTypeID,\n",
    ]),
  }),
]);

const SHIP_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "referenceDataShips",
    file: "server/src/services/_shared/referenceData.js",
    required: Object.freeze([
      "  SHIP_TYPES: \"shipTypes\",",
      "  SHIP_DOGMA_ATTRIBUTES: \"shipDogmaAttributes\",",
      "  MOVEMENT_ATTRIBUTES: \"movementAttributes\",",
      "  [TABLE.SHIP_TYPES]: \"ships\",",
      "  [TABLE.MOVEMENT_ATTRIBUTES]: \"attributes\",",
    ]),
  }),
  Object.freeze({
    key: "liveFittingStateShips",
    file: "server/src/services/fitting/liveFittingState.js",
    required: Object.freeze(["shipDogmaRoot.shipAttributesByTypeID[String(numericTypeID)];"]),
  }),
  Object.freeze({
    key: "worldDataMovement",
    file: "server/src/space/worldData.js",
    required: Object.freeze([
      "const attributes = readStaticRows(TABLE.MOVEMENT_ATTRIBUTES);",
      "movementByTypeId.set(attribute.typeID, attribute);",
    ]),
  }),
  Object.freeze({
    key: "itemInfoShips",
    file: "server/src/services/dogma/dogmaService/itemInfo.js",
    required: Object.freeze(["payload.shipAttributesByTypeID[String(shipTypeID)] || null"]),
  }),
]);

function functionBodyOf(source, header) {
  const start = source.indexOf(header);
  if (start < 0) return null;
  const end = source.indexOf("\n}\n", start);
  return end < 0 ? null : source.slice(start, end + 2);
}

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
    .map((token) => `seam ${JSON.stringify(token.slice(0, 80))} count ${countOf(source, token)}, expected 1`);
  for (const { header, token } of definition.functionRequires || []) {
    const body = functionBodyOf(source, header);
    if (!body || !body.includes(token)) {
      problems.push(`seam ${JSON.stringify(header.slice(0, 60))} has no ${token} in its body`);
    }
  }
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

function inspectShop(runtimeRoot) {
  return inspect(runtimeRoot, SHOP_REQUIREMENTS);
}

function inspectMonitor(runtimeRoot) {
  return inspect(runtimeRoot, MONITOR_REQUIREMENTS);
}

function inspectShips(runtimeRoot) {
  return inspect(runtimeRoot, SHIP_REQUIREMENTS);
}

module.exports = {
  ACTIVITY_BLOCK,
  MONITOR_REQUIREMENTS,
  SHIP_REQUIREMENTS,
  SHOP_REQUIREMENTS,
  SOURCE_REQUIREMENTS,
  functionBodyOf,
  inspect,
  inspectMonitor,
  inspectShips,
  inspectShop,
  inspectSourceShape,
};
