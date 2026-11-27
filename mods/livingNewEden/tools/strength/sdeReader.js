"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const SHIP_CATEGORY_ID = 6;
const KEY_RE = /^\{"_key": (\d+),/;
const GROUP_RE = /"groupID": (\d+)/;

async function streamLines(file, onLine) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) onLine(line);
}

function readSdeHeader(sdeDir) {
  for (const line of fs.readFileSync(path.join(sdeDir, "_sde.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (row._key === "sde") return { buildNumber: row.buildNumber, releaseDate: row.releaseDate };
  }
  throw new Error(`${path.join(sdeDir, "_sde.jsonl")}: no sde row`);
}

function readShipGroups(sdeDir) {
  const groups = [];
  for (const line of fs.readFileSync(path.join(sdeDir, "groups.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    if (row.categoryID !== SHIP_CATEGORY_ID) continue;
    groups.push({ groupId: Number(row._key), categoryId: row.categoryID, published: row.published === true });
  }
  return groups.sort((a, b) => a.groupId - b.groupId);
}

async function readSdeInputs(sdeDir, options = {}) {
  const withDogma = options.dogma !== false;
  const sde = readSdeHeader(sdeDir);
  const groups = readShipGroups(sdeDir);
  const groupIds = new Set(groups.map((row) => row.groupId));
  const referenceIds = new Set((options.referenceTypeIds || []).map(Number));

  const types = [];
  await streamLines(path.join(sdeDir, "types.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key) return;
    const typeId = Number(key[1]);
    const group = GROUP_RE.exec(line);
    if (!referenceIds.has(typeId) && !(group && groupIds.has(Number(group[1])))) return;
    const row = JSON.parse(line);
    types.push({ typeId, groupId: row.groupID, published: row.published === true });
  });
  types.sort((a, b) => a.typeId - b.typeId);

  const wanted = new Set(types.map((t) => t.typeId));
  const dogma = {};
  if (withDogma) await streamLines(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key || !wanted.has(Number(key[1]))) return;
    const row = JSON.parse(line);
    const attrs = {};
    for (const a of row.dogmaAttributes || []) attrs[a.attributeID] = a.value;
    dogma[key[1]] = attrs;
  });
  return { sde, groups, types, dogma };
}

function readBlueprints(sdeDir) {
  const out = new Map();
  for (const line of fs.readFileSync(path.join(sdeDir, "blueprints.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    const m = row.activities && row.activities.manufacturing;
    if (!m || !Array.isArray(m.products) || m.products.length !== 1) continue;
    const product = m.products[0];
    const blueprintTypeId = Number(row._key);
    const earlier = out.get(product.typeID);
    if (earlier && earlier.blueprintTypeId < blueprintTypeId) continue;
    out.set(product.typeID, { blueprintTypeId, timeSec: Number(m.time) || 0,
      materials: (m.materials || []).map((x) => ({ typeId: x.typeID, quantity: x.quantity })),
      productQuantity: product.quantity });
  }
  return out;
}

function readReactions(sdeDir) {
  const out = new Map();
  for (const line of fs.readFileSync(path.join(sdeDir, "blueprints.jsonl"), "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    const m = row.activities && row.activities.reaction;
    if (!m || !Array.isArray(m.products) || m.products.length !== 1) continue;
    const product = m.products[0];
    const blueprintTypeId = Number(row._key);
    const earlier = out.get(product.typeID);
    if (earlier && earlier.blueprintTypeId < blueprintTypeId) continue;
    out.set(product.typeID, { blueprintTypeId, timeSec: Number(m.time) || 0,
      materials: (m.materials || []).map((x) => ({ typeId: x.typeID, quantity: x.quantity })),
      productQuantity: product.quantity });
  }
  return out;
}

const finiteOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

async function readTypeRows(sdeDir, select = {}) {
  const typeIds = new Set([...(select.typeIds || [])].map(Number));
  const groupIds = new Set([...(select.groupIds || [])].map(Number));
  const names = new Set(select.names || []);
  const nameNeedles = [...names].map((n) => `"en": ${JSON.stringify(n)}`);
  const out = new Map();
  await streamLines(path.join(sdeDir, "types.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key) return;
    const typeId = Number(key[1]);
    const group = GROUP_RE.exec(line);
    const byId = typeIds.has(typeId) || (group && groupIds.has(Number(group[1])));
    if (!byId && !nameNeedles.some((n) => line.includes(n))) return;
    const row = JSON.parse(line);
    const name = row.name && typeof row.name.en === "string" ? row.name.en : "";
    if (!byId && !names.has(name)) return;
    out.set(typeId, { typeId, groupId: row.groupID, published: row.published === true, name,
      basePrice: finiteOrNull(row.basePrice), capacity: finiteOrNull(row.capacity), volume: finiteOrNull(row.volume),
      portionSize: finiteOrNull(row.portionSize), mass: finiteOrNull(row.mass) });
  });
  return out;
}

async function readTypeMaterials(sdeDir, typeIds) {
  const wanted = new Set([...typeIds].map(Number));
  const out = new Map();
  await streamLines(path.join(sdeDir, "typeMaterials.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key || !wanted.has(Number(key[1]))) return;
    const row = JSON.parse(line);
    out.set(Number(key[1]), (row.materials || []).map((m) => ({ typeId: m.materialTypeID, quantity: m.quantity })));
  });
  return out;
}

async function readDogmaRows(sdeDir, typeIds) {
  const wanted = new Set([...typeIds].map(Number));
  const out = new Map();
  await streamLines(path.join(sdeDir, "typeDogma.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key || !wanted.has(Number(key[1]))) return;
    const row = JSON.parse(line);
    const attrs = {};
    for (const a of row.dogmaAttributes || []) attrs[a.attributeID] = a.value;
    out.set(Number(key[1]), attrs);
  });
  return out;
}

async function readMetaGroups(sdeDir, typeIds) {
  const wanted = new Set([...typeIds].map(Number));
  const out = new Map();
  await streamLines(path.join(sdeDir, "types.jsonl"), (line) => {
    const key = KEY_RE.exec(line);
    if (!key || !wanted.has(Number(key[1]))) return;
    const row = JSON.parse(line);
    if (Number.isSafeInteger(row.metaGroupID)) out.set(Number(key[1]), row.metaGroupID);
  });
  return out;
}

module.exports = { readSdeInputs, readBlueprints, readReactions, streamLines, readSdeHeader, readTypeRows, readTypeMaterials,
  readDogmaRows, readMetaGroups };
