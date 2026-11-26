"use strict";

const path = require("node:path");

const { POSITIVE_FIELDS, checkDogmaOverride, checkFieldOverride } = require("./limits");

const TYPE_ID_MIN = 340000;
const TYPE_ID_MAX = 349999;

const BLUEPRINT_CATEGORY_ID = 9;

const ACTIVITY_KEYS = Object.freeze([
  "manufacturing", "research_time", "research_material", "copying", "invention", "reaction",
]);

const OVERRIDE_KEYS = Object.freeze(["name", "groupID", "iconID", "basePrice", "published", "marketGroupID",
  "description", "mass", "volume", "capacity", "radius"]);
const PACK_KEYS = Object.freeze(["packID", "version", "types", "blueprints", "icons", "source", "description"]);
const TYPE_KEYS = Object.freeze(["typeID", "sourceTypeID", "overrides", "dogma"]);
const DOGMA_KEYS = Object.freeze(["attributes"]);
const BLUEPRINT_KEYS = Object.freeze(["blueprintTypeID", "productTypeID", "maxProductionLimit", "activities", "shop"]);
const SHOP_KEYS = Object.freeze(["listed", "price"]);
const ICON_KEYS = Object.freeze(["iconID", "templateIconID", "file", "sha256"]);

const ICON_ID_MIN = 950000;
const ICON_ID_MAX = 959999;
const SHIP_CATEGORY_ID = 6;
const SHOP_PRICE_MAX = 1e12;

const MAX_DESCRIPTION_LENGTH = 2000;

const MAX_SKILL_LEVEL = 5;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function unknownKeys(object, allowed) {
  return Object.keys(object).filter((key) => !allowed.includes(key));
}

function dogmaFactsOf(facts) {
  const dogmaOf = typeof facts.dogmaOf === "function" ? facts.dogmaOf : null;
  const nameOf = typeof facts.attributeNameOf === "function" ? facts.attributeNameOf : null;
  return {
    of(typeID) {
      if (!dogmaOf) return undefined;
      const record = dogmaOf(typeID);
      if (record === undefined) return undefined;
      const attributes = record && (record.attributes instanceof Map
        ? Object.fromEntries(record.attributes) : record.attributes);
      return isPlainObject(attributes) ? { attributes } : null;
    },
    nameOf(attributeID) {
      const name = nameOf ? nameOf(attributeID) : null;
      return typeof name === "string" && name !== "" ? name : null;
    },
  };
}

function buildDogmaOverrides(entry, typeID, sourceTypeID, dogmaFacts) {
  const dogma = entry.dogma;
  if (dogma === undefined) return { ok: true, dogmaAttributes: {} };
  if (!isPlainObject(dogma)) return { ok: false, reason: `type ${typeID}: dogma is not an object` };
  const unknown = unknownKeys(dogma, DOGMA_KEYS);
  if (unknown.length > 0) return { ok: false, reason: `type ${typeID}: unknown dogma keys ${unknown.join(", ")}` };
  if (!isPlainObject(dogma.attributes)) return { ok: false, reason: `type ${typeID}: dogma.attributes is not an object` };
  const record = dogmaFacts.of(sourceTypeID);
  if (record === undefined) return { ok: false, reason: "typeDogma table unavailable" };
  const dogmaAttributes = {};
  for (const [key, value] of Object.entries(dogma.attributes)) {
    const attributeID = Number(key);
    if (!/^[0-9]+$/u.test(key) || !isPositiveInteger(attributeID)) {
      return { ok: false, reason: `type ${typeID}: dogma attribute ${JSON.stringify(key)} is not an attributeID` };
    }
    if (!record || !Object.prototype.hasOwnProperty.call(record.attributes, String(attributeID))) {
      return { ok: false, reason: `type ${typeID}: dogma attribute ${attributeID} not on source ${sourceTypeID}` };
    }
    const name = dogmaFacts.nameOf(attributeID);
    const problem = checkDogmaOverride(attributeID, value, Number(record.attributes[String(attributeID)]), name);
    if (problem) {
      return { ok: false, reason: `type ${typeID}: dogma attribute ${attributeID}${name ? ` (${name})` : ""} ${problem}` };
    }
    dogmaAttributes[String(attributeID)] = value;
  }
  return { ok: true, dogmaAttributes };
}

function loadPackFiles(dataDir, fsImpl = require("node:fs")) {
  const entries = [];
  const problems = [];
  let names = [];
  try {
    names = fsImpl.readdirSync(dataDir).filter((name) => name.toLowerCase().endsWith(".json")).sort();
  } catch (error) {
    problems.push(`data directory unreadable (${error.message})`);
    return { entries, problems };
  }
  for (const name of names) {
    try {
      entries.push({ file: name, pack: JSON.parse(fsImpl.readFileSync(path.join(dataDir, name), "utf8")) });
    } catch (error) {
      problems.push(`pack file ${name} unreadable (${error.message})`);
    }
  }
  return { entries, problems };
}

function indexVanilla(itemTypeRows, blueprintDefinitions) {
  const typesByID = new Map();
  const groups = new Map();
  for (const row of itemTypeRows || []) {
    const typeID = Number(row && row.typeID);
    if (!isPositiveInteger(typeID)) continue;
    typesByID.set(typeID, row);
    const groupID = Number(row.groupID);
    if (isPositiveInteger(groupID) && !groups.has(groupID)) {
      groups.set(groupID, { groupName: row.groupName == null ? null : row.groupName, categoryID: row.categoryID });
    }
  }
  const blueprintIDs = new Set();
  const productIDs = new Set();
  const categoryNames = new Map();
  for (const definition of blueprintDefinitions || []) {
    if (!definition) continue;
    const blueprintTypeID = Number(definition.blueprintTypeID);
    if (isPositiveInteger(blueprintTypeID)) blueprintIDs.add(blueprintTypeID);
    const productTypeID = Number(definition.productTypeID);
    if (isPositiveInteger(productTypeID)) productIDs.add(productTypeID);
    for (const [idKey, nameKey] of [["blueprintCategoryID", "blueprintCategoryName"],
      ["productCategoryID", "productCategoryName"]]) {
      const categoryID = Number(definition[idKey]);
      if (isPositiveInteger(categoryID) && definition[nameKey] && !categoryNames.has(categoryID)) {
        categoryNames.set(categoryID, String(definition[nameKey]));
      }
    }
  }
  return { typesByID, groups, blueprintIDs, productIDs, categoryNames };
}

function buildTypeRow(entry, vanilla, claimedTypeIDs, dogmaFacts) {
  if (!isPlainObject(entry)) return { ok: false, reason: "type entry is not an object" };
  const { typeID, sourceTypeID } = entry;
  const overrides = entry.overrides === undefined ? {} : entry.overrides;
  if (!isPositiveInteger(typeID) || typeID < TYPE_ID_MIN || typeID > TYPE_ID_MAX) {
    return { ok: false, reason: `type ${JSON.stringify(typeID)} outside ${TYPE_ID_MIN}-${TYPE_ID_MAX}` };
  }
  const unknownTypeKeys = unknownKeys(entry, TYPE_KEYS);
  if (unknownTypeKeys.length > 0) return { ok: false, reason: `type ${typeID}: unknown keys ${unknownTypeKeys.join(", ")}` };
  if (vanilla.typesByID.has(typeID)) return { ok: false, reason: `type ${typeID} already exists in the SDE` };
  if (claimedTypeIDs.has(typeID)) return { ok: false, reason: `type ${typeID} declared twice` };
  const source = vanilla.typesByID.get(sourceTypeID);
  if (!source) return { ok: false, reason: `type ${typeID}: source type ${JSON.stringify(sourceTypeID)} not found` };
  if (!isPlainObject(overrides)) return { ok: false, reason: `type ${typeID}: overrides is not an object` };
  const unknown = Object.keys(overrides).filter((key) => !OVERRIDE_KEYS.includes(key));
  if (unknown.length > 0) return { ok: false, reason: `type ${typeID}: unknown overrides ${unknown.join(", ")}` };

  const row = { ...clone(source), typeID };
  if (overrides.name !== undefined) {
    if (typeof overrides.name !== "string" || overrides.name.trim() === "") {
      return { ok: false, reason: `type ${typeID}: name must be a non-empty string` };
    }
    row.name = overrides.name;
  }
  if (overrides.groupID !== undefined) {
    const group = vanilla.groups.get(overrides.groupID);
    if (!group) return { ok: false, reason: `type ${typeID}: group ${JSON.stringify(overrides.groupID)} not found` };
    row.groupID = overrides.groupID;
    row.groupName = group.groupName;
    row.categoryID = group.categoryID;
  }
  if (overrides.iconID !== undefined) {
    if (overrides.iconID !== null && !isPositiveInteger(overrides.iconID)) {
      return { ok: false, reason: `type ${typeID}: iconID must be a positive integer or null` };
    }
    row.iconID = overrides.iconID;
  }
  if (overrides.basePrice !== undefined) {
    if (typeof overrides.basePrice !== "number" || !Number.isFinite(overrides.basePrice) || overrides.basePrice < 0) {
      return { ok: false, reason: `type ${typeID}: basePrice must be a number >= 0` };
    }
    row.basePrice = overrides.basePrice;
  }
  if (overrides.published !== undefined) {
    if (typeof overrides.published !== "boolean") return { ok: false, reason: `type ${typeID}: published must be boolean` };
    row.published = overrides.published;
  }
  if (overrides.marketGroupID !== undefined) {
    if (overrides.marketGroupID !== null && !isPositiveInteger(overrides.marketGroupID)) {
      return { ok: false, reason: `type ${typeID}: marketGroupID must be a positive integer or null` };
    }
    row.marketGroupID = overrides.marketGroupID;
  }
  if (overrides.description !== undefined) {
    if (typeof overrides.description !== "string" || overrides.description.trim() === ""
      || overrides.description.length > MAX_DESCRIPTION_LENGTH) {
      return { ok: false, reason: `type ${typeID}: description must be a non-empty string of at most ${MAX_DESCRIPTION_LENGTH} characters` };
    }
    if (Object.prototype.hasOwnProperty.call(row, "description")) row.description = overrides.description;
  }
  for (const field of POSITIVE_FIELDS) {
    if (overrides[field] === undefined) continue;
    const problem = checkFieldOverride(field, overrides[field]);
    if (problem) return { ok: false, reason: `type ${typeID}: ${field} ${problem}` };
    row[field] = overrides[field];
  }
  const dogma = buildDogmaOverrides(entry, typeID, sourceTypeID, dogmaFacts);
  if (!dogma.ok) return dogma;
  const planned = { typeID, sourceTypeID, name: row.name, dogmaAttributes: dogma.dogmaAttributes };
  let ship = null;
  if (row.categoryID === SHIP_CATEGORY_ID) {
    const record = dogmaFacts.of(sourceTypeID);
    ship = {
      ...planned,
      dogmaAttributes: { ...dogma.dogmaAttributes },
      fallbackAttributes: record ? { ...clone(record.attributes), ...dogma.dogmaAttributes } : null,
      overrideMass: overrides.mass === undefined ? null : overrides.mass,
      overrideRadius: overrides.radius === undefined ? null : overrides.radius,
    };
  }
  return { ok: true, row, sourceTypeID, source: planned, ship };
}

function checkIcons(icons, overrideIconIDs, claimedIconIDs) {
  if (!Array.isArray(icons)) return { ok: false, reason: "icons is not an array" };
  const seen = new Set();
  for (const icon of icons) {
    if (!isPlainObject(icon)) return { ok: false, reason: "icon entry is not an object" };
    const label = `icon ${JSON.stringify(icon.iconID)}`;
    const unknown = unknownKeys(icon, ICON_KEYS);
    if (unknown.length > 0) return { ok: false, reason: `${label}: unknown keys ${unknown.join(", ")}` };
    if (!isPositiveInteger(icon.iconID) || icon.iconID < ICON_ID_MIN || icon.iconID > ICON_ID_MAX) {
      return { ok: false, reason: `${label} outside ${ICON_ID_MIN}-${ICON_ID_MAX}` };
    }
    if (seen.has(icon.iconID) || claimedIconIDs.has(icon.iconID)) return { ok: false, reason: `${label} declared twice` };
    seen.add(icon.iconID);
    if (!isPositiveInteger(icon.templateIconID)) return { ok: false, reason: `${label}: templateIconID must be a positive integer` };
    if (typeof icon.file !== "string" || !/^icons\/[0-9]+\.png$/u.test(icon.file)) {
      return { ok: false, reason: `${label}: file must be icons/<digits>.png` };
    }
    if (typeof icon.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/u.test(icon.sha256)) {
      return { ok: false, reason: `${label}: sha256 must be 64 hex characters` };
    }
    if (!overrideIconIDs.has(icon.iconID)) return { ok: false, reason: `${label} is used by no type of the pack` };
  }
  return { ok: true, iconIDs: [...seen] };
}

function checkShop(shop, label) {
  if (shop === undefined) return { ok: true, shop: null };
  if (!isPlainObject(shop)) return { ok: false, reason: `${label}: shop is not an object` };
  const unknown = unknownKeys(shop, SHOP_KEYS);
  if (unknown.length > 0) return { ok: false, reason: `${label}: unknown shop keys ${unknown.join(", ")}` };
  if (shop.listed !== undefined && typeof shop.listed !== "boolean") {
    return { ok: false, reason: `${label}: shop.listed must be boolean` };
  }
  if (shop.price !== undefined && (!Number.isSafeInteger(shop.price) || shop.price < 1 || shop.price > SHOP_PRICE_MAX)) {
    return { ok: false, reason: `${label}: shop.price must be an ISK amount 1-${SHOP_PRICE_MAX}` };
  }
  return { ok: true, shop: clone(shop) };
}

function checkTypedList(list, label, typeExists, valueKey) {
  if (list === undefined) return null;
  if (!Array.isArray(list)) return `${label} is not an array`;
  for (const item of list) {
    if (!isPlainObject(item) || !typeExists(item.typeID)) {
      return `${label}: type ${JSON.stringify(item && item.typeID)} not found`;
    }
    const value = item[valueKey];
    if (valueKey === "level") {
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_SKILL_LEVEL) return `${label}: bad level ${value}`;
    } else if (!isPositiveInteger(value)) {
      return `${label}: bad quantity ${JSON.stringify(value)} for type ${item.typeID}`;
    }
  }
  return null;
}

function checkActivities(activities, productTypeID, typeExists) {
  if (!isPlainObject(activities) || Object.keys(activities).length === 0) return "activities missing";
  for (const [key, activity] of Object.entries(activities)) {
    if (!ACTIVITY_KEYS.includes(key)) return `unknown activity ${key}`;
    if (!isPlainObject(activity)) return `activity ${key} is not an object`;
    if (!Number.isSafeInteger(activity.time) || activity.time < 0) return `activity ${key}: bad time`;
    const problem = checkTypedList(activity.materials, `${key}.materials`, typeExists, "quantity")
      || checkTypedList(activity.products, `${key}.products`, typeExists, "quantity")
      || checkTypedList(activity.skills, `${key}.skills`, typeExists, "level");
    if (problem) return problem;
  }
  const manufacturing = activities.manufacturing;
  const first = manufacturing && Array.isArray(manufacturing.products) ? manufacturing.products[0] : null;
  if (!first || first.typeID !== productTypeID) return "manufacturing.products[0] must be the productTypeID";
  return null;
}

function buildDefinition(entry, context) {
  const { vanilla, typeRows, typeExists, rowOf, claimedProducts } = context;
  if (!isPlainObject(entry)) return { ok: false, reason: "blueprint entry is not an object" };
  const { blueprintTypeID, productTypeID, maxProductionLimit } = entry;
  const label = `blueprint ${JSON.stringify(blueprintTypeID)}`;
  const unknown = unknownKeys(entry, BLUEPRINT_KEYS);
  if (unknown.length > 0) return { ok: false, reason: `${label}: unknown keys ${unknown.join(", ")}` };
  const shop = checkShop(entry.shop, label);
  if (!shop.ok) return shop;
  const blueprintRow = typeRows.get(blueprintTypeID);
  if (!blueprintRow) return { ok: false, reason: `${label} is not a type of this pack` };
  if (blueprintRow.categoryID !== BLUEPRINT_CATEGORY_ID) {
    return { ok: false, reason: `${label}: category ${blueprintRow.categoryID}, expected ${BLUEPRINT_CATEGORY_ID}` };
  }
  if (vanilla.blueprintIDs.has(blueprintTypeID)) return { ok: false, reason: `${label} already has a definition` };
  if (!typeExists(productTypeID)) return { ok: false, reason: `${label}: product ${JSON.stringify(productTypeID)} not found` };
  if (vanilla.productIDs.has(productTypeID) || claimedProducts.has(productTypeID)) {
    return { ok: false, reason: `${label}: product ${productTypeID} already has a blueprint` };
  }
  if (!isPositiveInteger(maxProductionLimit)) return { ok: false, reason: `${label}: bad maxProductionLimit` };
  const problem = checkActivities(entry.activities, productTypeID, typeExists);
  if (problem) return { ok: false, reason: `${label}: ${problem}` };

  const product = rowOf(productTypeID);
  const categoryName = (categoryID) => vanilla.categoryNames.get(categoryID) || "";
  return {
    ok: true,
    shop: shop.shop,
    definition: {
      blueprintTypeID,
      blueprintName: blueprintRow.name || `Blueprint ${blueprintTypeID}`,
      blueprintGroupID: blueprintRow.groupID || 0,
      blueprintGroupName: blueprintRow.groupName || "",
      blueprintCategoryID: blueprintRow.categoryID || 0,
      blueprintCategoryName: categoryName(blueprintRow.categoryID),
      productTypeID,
      productName: product.name || "",
      productGroupID: product.groupID || 0,
      productGroupName: product.groupName || "",
      productCategoryID: product.categoryID || 0,
      productCategoryName: categoryName(product.categoryID),
      maxProductionLimit,
      published: blueprintRow.published === true,
      activities: clone(entry.activities),
    },
  };
}

function planPack(pack, vanilla, claimed, dogmaFacts) {
  if (!isPlainObject(pack)) return { ok: false, reason: "pack is not an object" };
  if (typeof pack.packID !== "string" || pack.packID.trim() === "") return { ok: false, reason: "packID missing" };
  const unknownPackKeys = unknownKeys(pack, PACK_KEYS);
  if (unknownPackKeys.length > 0) return { ok: false, reason: `unknown pack keys ${unknownPackKeys.join(", ")}` };
  if (!Array.isArray(pack.types)) return { ok: false, reason: "types is not an array" };
  const blueprints = pack.blueprints === undefined ? [] : pack.blueprints;
  if (!Array.isArray(blueprints)) return { ok: false, reason: "blueprints is not an array" };

  const typeRows = new Map();
  const sources = [];
  const ships = [];
  const overrideIconIDs = new Set();
  for (const entry of pack.types) {
    const taken = { has: (typeID) => claimed.rows.has(typeID) || typeRows.has(typeID) };
    const built = buildTypeRow(entry, vanilla, taken, dogmaFacts);
    if (!built.ok) return built;
    typeRows.set(built.row.typeID, built.row);
    sources.push(built.source);
    if (built.ship) ships.push(built.ship);
    if (isPlainObject(entry.overrides) && isPositiveInteger(entry.overrides.iconID)) overrideIconIDs.add(entry.overrides.iconID);
  }
  const icons = checkIcons(pack.icons === undefined ? [] : pack.icons, overrideIconIDs, claimed.iconIDs);
  if (!icons.ok) return icons;
  for (const entry of blueprints) {
    const row = isPlainObject(entry) ? typeRows.get(entry.blueprintTypeID) : undefined;
    if (row) row.published = false;
  }
  const typeExists = (typeID) => vanilla.typesByID.has(typeID) || typeRows.has(typeID) || claimed.rows.has(typeID);
  const rowOf = (typeID) => typeRows.get(typeID) || claimed.rows.get(typeID) || vanilla.typesByID.get(typeID);
  const definitions = [];
  const shop = {};
  const claimedProducts = new Set(claimed.productIDs);
  for (const entry of blueprints) {
    const built = buildDefinition(entry, { vanilla, typeRows, typeExists, rowOf, claimedProducts });
    if (!built.ok) return built;
    claimedProducts.add(built.definition.productTypeID);
    definitions.push(built.definition);
    if (built.shop) shop[String(built.definition.blueprintTypeID)] = built.shop;
  }
  return {
    ok: true, typeRows: [...typeRows.values()], sources, definitions, ships,
    shipTypeIDs: ships.map((ship) => ship.typeID), iconIDs: icons.iconIDs, shop,
  };
}

function buildPlan(entries, facts) {
  const packs = [];
  const rejected = [];
  if (!Array.isArray(facts.itemTypeRows) || facts.itemTypeRows.length === 0) {
    for (const { file, pack } of entries) {
      rejected.push({ packID: String(pack && pack.packID), file, reason: "itemTypes table unavailable" });
    }
    return { packs, rejected };
  }
  const vanilla = indexVanilla(facts.itemTypeRows, facts.blueprintDefinitions);
  const claimed = { rows: new Map(), productIDs: new Set(), iconIDs: new Set() };
  const dogmaFacts = dogmaFactsOf(facts);
  for (const { file, pack } of entries) {
    const packID = String(pack && pack.packID);
    const hasBlueprints = Array.isArray(pack && pack.blueprints) && pack.blueprints.length > 0;
    if (hasBlueprints && !Array.isArray(facts.blueprintDefinitions)) {
      rejected.push({ packID, file, reason: "industryBlueprints table unavailable" });
      continue;
    }
    const planned = planPack(pack, vanilla, claimed, dogmaFacts);
    if (!planned.ok) {
      rejected.push({ packID, file, reason: planned.reason });
      continue;
    }
    if (facts.shipTablesDrift === true && planned.shipTypeIDs.length > 0) {
      rejected.push({ packID, file, reason: "ship tables drift" });
      continue;
    }
    for (const row of planned.typeRows) claimed.rows.set(row.typeID, row);
    for (const definition of planned.definitions) claimed.productIDs.add(definition.productTypeID);
    for (const iconID of planned.iconIDs) claimed.iconIDs.add(iconID);
    packs.push({ packID, file, ...planned });
  }
  return { packs, rejected };
}

module.exports = {
  ACTIVITY_KEYS,
  BLUEPRINT_CATEGORY_ID,
  BLUEPRINT_KEYS,
  ICON_ID_MAX,
  ICON_ID_MIN,
  OVERRIDE_KEYS,
  PACK_KEYS,
  SHIP_CATEGORY_ID,
  TYPE_ID_MAX,
  TYPE_ID_MIN,
  TYPE_KEYS,
  buildPlan,
  loadPackFiles,
};
