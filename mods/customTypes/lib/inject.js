"use strict";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function injectItemTypeRows(payload, rows) {
  const list = isPlainObject(payload) ? payload.types : undefined;
  let added = 0;
  if (Array.isArray(list)) {
    const present = new Set(list.map((row) => Number(row && row.typeID)));
    for (const row of rows) {
      if (present.has(row.typeID)) continue;
      list.push(clone(row));
      present.add(row.typeID);
      added += 1;
    }
    return { ok: true, added };
  }
  if (isPlainObject(list)) {
    for (const row of rows) {
      const key = String(row.typeID);
      if (Object.prototype.hasOwnProperty.call(list, key)) continue;
      list[key] = clone(row);
      added += 1;
    }
    return { ok: true, added };
  }
  return { ok: false, reason: "itemTypes payload has no types" };
}

function addRowsByTypeID(list, rows) {
  let added = 0;
  if (Array.isArray(list)) {
    const present = new Set(list.map((row) => Number(row && row.typeID)));
    for (const row of rows) {
      if (present.has(row.typeID)) continue;
      list.push(clone(row));
      present.add(row.typeID);
      added += 1;
    }
    return added;
  }
  for (const row of rows) {
    const key = String(row.typeID);
    if (Object.prototype.hasOwnProperty.call(list, key)) continue;
    list[key] = clone(row);
    added += 1;
  }
  return added;
}

function rowOfType(list, typeID) {
  if (Array.isArray(list)) return list.find((row) => row && Number(row.typeID) === typeID) || null;
  const row = list[String(typeID)];
  return isPlainObject(row) ? row : null;
}

function applyAttributes(attributes, overrides) {
  for (const [id, value] of Object.entries(overrides || {})) attributes[String(id)] = value;
  return attributes;
}

function injectTypeDogma(payload, sources) {
  const map = isPlainObject(payload) ? payload.typesByTypeID : undefined;
  if (!isPlainObject(map)) return { ok: false, reason: "typeDogma payload has no typesByTypeID" };
  let added = 0;
  for (const source of sources) {
    const key = String(source.typeID);
    if (Object.prototype.hasOwnProperty.call(map, key)) continue;
    const record = map[String(source.sourceTypeID)];
    if (!isPlainObject(record)) continue;
    const copy = { ...clone(record), typeID: source.typeID, typeName: source.name };
    if (isPlainObject(copy.attributes)) applyAttributes(copy.attributes, source.dogmaAttributes);
    map[key] = copy;
    added += 1;
  }
  return { ok: true, added };
}

function injectShipTypeRows(payload, rows) {
  const list = isPlainObject(payload) ? payload.ships : undefined;
  if (!Array.isArray(list) && !isPlainObject(list)) return { ok: false, reason: "shipTypes payload has no ships" };
  return { ok: true, added: addRowsByTypeID(list, rows.map((row) => ({ ...row, published: false }))) };
}

function injectShipDogma(payload, ships) {
  const map = isPlainObject(payload) ? payload.shipAttributesByTypeID : undefined;
  if (!isPlainObject(map)) return { ok: false, reason: "shipDogmaAttributes payload has no shipAttributesByTypeID" };
  let added = 0;
  for (const ship of ships) {
    const key = String(ship.typeID);
    if (Object.prototype.hasOwnProperty.call(map, key)) continue;
    const source = map[String(ship.sourceTypeID)];
    let attributes = null;
    if (isPlainObject(source) && isPlainObject(source.attributes)) {
      attributes = applyAttributes(clone(source.attributes), ship.dogmaAttributes);
    } else if (isPlainObject(ship.fallbackAttributes)) {
      attributes = clone(ship.fallbackAttributes);
    }
    if (!attributes) continue;
    map[key] = { ...(isPlainObject(source) ? clone(source) : {}), typeID: ship.typeID, typeName: ship.name,
      attributeCount: Object.keys(attributes).length, attributes };
    added += 1;
  }
  return { ok: true, added };
}

const MOVEMENT_FIELDS = Object.freeze([
  ["mass", "4", "overrideMass"],
  ["maxVelocity", "37", null],
  ["inertia", "70", null],
  ["radius", "162", "overrideRadius"],
  ["signatureRadius", "552", null],
  ["warpSpeedMultiplier", "600", null],
]);

function injectMovementRows(payload, ships) {
  const list = isPlainObject(payload) ? payload.attributes : undefined;
  if (!Array.isArray(list) && !isPlainObject(list)) return { ok: false, reason: "movementAttributes payload has no attributes" };
  const rows = [];
  for (const ship of ships) {
    const source = rowOfType(list, ship.sourceTypeID);
    const fallback = isPlainObject(ship.fallbackAttributes) ? ship.fallbackAttributes : null;
    if (!source && !fallback) continue;
    const row = source ? { ...clone(source) } : { alignTime: null, maxAccelerationTime: null };
    delete row._key;
    row.typeID = ship.typeID;
    row.typeName = ship.name;
    for (const [field, attributeID, overrideKey] of MOVEMENT_FIELDS) {
      const dogma = ship.dogmaAttributes || {};
      if (Object.prototype.hasOwnProperty.call(dogma, attributeID)) row[field] = dogma[attributeID];
      else if (overrideKey && ship[overrideKey] !== null && ship[overrideKey] !== undefined) row[field] = ship[overrideKey];
      else if (!source) row[field] = Object.prototype.hasOwnProperty.call(fallback, attributeID) ? fallback[attributeID] : null;
    }
    rows.push(row);
  }
  return { ok: true, added: addRowsByTypeID(list, rows) };
}

function injectBlueprintDefinitions(payload, definitions) {
  if (!isPlainObject(payload) || !Array.isArray(payload.blueprintDefinitions)) {
    return { ok: false, reason: "industryBlueprints payload has no blueprintDefinitions" };
  }
  const present = new Set(payload.blueprintDefinitions.map((row) => Number(row && row.blueprintTypeID)));
  let added = 0;
  for (const definition of definitions) {
    const blueprintTypeID = definition.blueprintTypeID;
    if (present.has(blueprintTypeID)) continue;
    const copy = clone(definition);
    payload.blueprintDefinitions.push(copy);
    present.add(blueprintTypeID);
    added += 1;
    if (isPlainObject(payload.blueprintDefinitionsByTypeID)) {
      payload.blueprintDefinitionsByTypeID[String(blueprintTypeID)] = copy;
    }
    if (isPlainObject(payload.blueprintTypeIDsByProductTypeID) && definition.productTypeID > 0) {
      payload.blueprintTypeIDsByProductTypeID[String(definition.productTypeID)] = blueprintTypeID;
    }
    if (Array.isArray(payload.manufacturingBlueprintTypeIDs) && definition.activities.manufacturing
      && !payload.manufacturingBlueprintTypeIDs.includes(blueprintTypeID)) {
      payload.manufacturingBlueprintTypeIDs.push(blueprintTypeID);
    }
  }
  return { ok: true, added };
}

module.exports = {
  injectBlueprintDefinitions,
  injectItemTypeRows,
  injectMovementRows,
  injectShipDogma,
  injectShipTypeRows,
  injectTypeDogma,
};
