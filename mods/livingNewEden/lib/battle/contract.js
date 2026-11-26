"use strict";

const { ENVIRONMENTS, BATTLE_OBJECTIVES, OUTCOMES, RESOLVER_VERSIONS, SIDES, CONTRACT_VERSION } = require("./schema");
const { FLEET_ROLES, SUPPLY_MIN, SUPPLY_MAX, MAX_ID_LENGTH } = require("../fleets/schema");
const { normalizeComposition, compareEntries } = require("../fleets/composition");
const { stableJson, fingerprint } = require("../util/fingerprint");
const { isId } = require("../util/ids");

const MAX_UINT32 = 0xFFFFFFFF;
const HASH_LIMITS = Object.freeze({ maxFleetsPerSide: 32, maxResolutionMs: 5000, maxCompositionEntries: 256,
  maxShipsPerFleet: 100000 });

const INPUT_KEYS = Object.freeze(["v", "battleId", "seed", "systemId", "environment", "sideA", "sideB", "objective",
  "garrison", "resolverVersion", "maxResolutionMs"]);
const SIDE_KEYS = Object.freeze(["factionId", "fleets"]);
const FLEET_KEYS = Object.freeze(["fleetId", "factionId", "fleetRole", "doctrineId", "supplyState", "composition"]);
const GARRISON_KEYS = Object.freeze(["side", "factionId", "strength"]);
const RESULT_KEYS = Object.freeze(["battleId", "resolver", "outcome", "destroyedShips", "escapedShips",
  "survivingShips", "objectiveAchieved", "estimatedDurationSec", "confidence", "diagnostics"]);
const SHIP_LISTS = Object.freeze(["destroyedShips", "escapedShips", "survivingShips"]);
const GROUP_KEYS = Object.freeze(["fleetId", "hullGroup", "typeId", "count"]);
const INPUT_STRUCTURE_KEYS = Object.freeze(["structureId", "structureTypeId", "structureSide"]);
const RESULT_STRUCTURE_KEYS = Object.freeze(["structureDestroyed", "structureId", "structureTypeId"]);
const INPUT_FIXED_KEY = "fixedDefenses";
const RESULT_FIXED_KEY = "fixedDefenseOutcome";
const MAX_FIXED_DEFENSES = 64;
const FIXED_KEYS = Object.freeze(["attackerRetreatLossPermille", "entries"]);
const FIXED_ENTRY_KEYS = Object.freeze(["sentryId", "itemId", "typeId", "ownerKind", "ownerId", "hp", "ehp", "dps",
  "signature", "designSig"]);
const FIXED_OUTCOME_KEYS = Object.freeze(["sentryId", "damage", "destroyed"]);
const FIXED_OWNER_KINDS = Object.freeze(["faction", "player"]);
const FIXED_SENTRY_ID_MAX = 64;
const FIXED_RETREAT_PERMILLE_MIN = 50;
const FIXED_RETREAT_PERMILLE_MAX = 1000;
const FIXED_HP_MAX = 1e9;
const FIXED_EHP_MAX = 1e10;
const FIXED_DPS_MAX = 1e6;
const FIXED_SIG_MAX = 1e9;

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const INPUT_STRUCTURE_CHECKS = Object.freeze([["structureId", isPositiveId], ["structureTypeId", isPositiveId],
  ["structureSide", (v) => SIDES.includes(v)]]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function keysProblem(obj, keys, where, optional = []) {
  if (!isPlainObject(obj)) return `${where}: not an object`;
  for (const key of Object.keys(obj)) {
    if (!keys.includes(key) && !optional.includes(key)) return `${where}: field ${key}`;
  }
  for (const key of keys) if (!has(obj, key)) return `${where}: missing ${key}`;
  return null;
}

const present = (obj, key) => has(obj, key) && obj[key] !== null && obj[key] !== undefined;

function copyStructureKeys(src, dst, checks) {
  for (const [key, ok] of checks) {
    if (!present(src, key)) continue;
    if (!ok(src[key])) return key;
    dst[key] = src[key];
  }
  return null;
}

const inputInvalid = (detail) => ({ ok: false, reason: "INPUT_INVALID", detail });
const resultInvalid = (detail) => ({ ok: false, reason: "RESULT_INVALID", detail });

function checkLimits(limits) {
  if (!limits || typeof limits !== "object") return "limits missing";
  for (const name of Object.keys(HASH_LIMITS)) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1) return `limits.${name}`;
  }
  return null;
}

function normalizeFleet(fleet, side, where, limits) {
  const problem = keysProblem(fleet, FLEET_KEYS, where);
  if (problem) return inputInvalid(problem);
  if (!isText(fleet.fleetId, MAX_ID_LENGTH)) return inputInvalid(`${where}.fleetId`);
  if (fleet.factionId !== side.factionId) return inputInvalid(`${where}.factionId != side factionId`);
  if (!FLEET_ROLES.includes(fleet.fleetRole)) return inputInvalid(`${where}.fleetRole`);
  if (fleet.doctrineId !== null && !isText(fleet.doctrineId, MAX_ID_LENGTH)) return inputInvalid(`${where}.doctrineId`);
  const supply = fleet.supplyState;
  if (!Number.isSafeInteger(supply) || supply < SUPPLY_MIN || supply > SUPPLY_MAX) {
    return inputInvalid(`${where}.supplyState`);
  }
  const composition = normalizeComposition(fleet.composition, limits);
  if (!composition.ok) {
    return inputInvalid(`${where}.composition: ${composition.reason} ${composition.detail || composition.hullGroup || ""}`
      .trim());
  }
  return { ok: true, fleet: { fleetId: fleet.fleetId, factionId: fleet.factionId, fleetRole: fleet.fleetRole,
    doctrineId: fleet.doctrineId, supplyState: supply,
    composition: composition.composition.map((e) => ({ hullGroup: e.hullGroup, typeId: e.typeId, count: e.count })) } };
}

function normalizeSide(side, where, limits, allowEmpty = false) {
  const problem = keysProblem(side, SIDE_KEYS, where);
  if (problem) return inputInvalid(problem);
  if (allowEmpty) {
    if (side.factionId !== null) return inputInvalid(`${where}.factionId: must be null with fixedDefenses`);
    if (!Array.isArray(side.fleets) || side.fleets.length !== 0) {
      return inputInvalid(`${where}.fleets: must be empty with fixedDefenses`);
    }
    return { ok: true, side: { factionId: null, fleets: [] } };
  }
  if (!isPositiveId(side.factionId)) return inputInvalid(`${where}.factionId`);
  if (!Array.isArray(side.fleets) || side.fleets.length === 0) return inputInvalid(`${where}.fleets: empty`);
  if (side.fleets.length > limits.maxFleetsPerSide) {
    return inputInvalid(`${where}.fleets: ${side.fleets.length} > maxFleetsPerSide ${limits.maxFleetsPerSide}`);
  }
  const fleets = [];
  for (let i = 0; i < side.fleets.length; i += 1) {
    const r = normalizeFleet(side.fleets[i], side, `${where}.fleets[${i}]`, limits);
    if (!r.ok) return r;
    fleets.push(r.fleet);
  }
  fleets.sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
  return { ok: true, side: { factionId: side.factionId, fleets } };
}

const isNumIn = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const isIntIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const FIXED_ENTRY_CHECKS = Object.freeze([
  ["sentryId", (v) => isText(v, FIXED_SENTRY_ID_MAX)], ["itemId", isPositiveId], ["typeId", isPositiveId],
  ["ownerKind", (v) => FIXED_OWNER_KINDS.includes(v)], ["ownerId", isPositiveId],
  ["hp", (v) => isIntIn(v, 1, FIXED_HP_MAX)], ["ehp", (v) => isIntIn(v, 1, FIXED_EHP_MAX)],
  ["dps", (v) => isNumIn(v, 0, FIXED_DPS_MAX)], ["signature", (v) => isNumIn(v, 1, FIXED_SIG_MAX)],
  ["designSig", (v) => isNumIn(v, 1, FIXED_SIG_MAX)],
]);

function normalizeFixedDefenses(fd) {
  const problem = keysProblem(fd, FIXED_KEYS, "fixedDefenses");
  if (problem) return inputInvalid(problem);
  if (!isIntIn(fd.attackerRetreatLossPermille, FIXED_RETREAT_PERMILLE_MIN, FIXED_RETREAT_PERMILLE_MAX)) {
    return inputInvalid("fixedDefenses.attackerRetreatLossPermille");
  }
  const list = fd.entries;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_FIXED_DEFENSES) {
    return inputInvalid(`fixedDefenses.entries: 1..${MAX_FIXED_DEFENSES}`);
  }
  const entries = [];
  for (let i = 0; i < list.length; i += 1) {
    const where = `fixedDefenses.entries[${i}]`;
    const eProblem = keysProblem(list[i], FIXED_ENTRY_KEYS, where);
    if (eProblem) return inputInvalid(eProblem);
    const entry = {};
    for (const [key, ok] of FIXED_ENTRY_CHECKS) {
      if (!ok(list[i][key])) return inputInvalid(`${where}.${key}`);
      entry[key] = list[i][key];
    }
    entries.push(entry);
  }
  entries.sort((a, b) => (a.sentryId < b.sentryId ? -1 : a.sentryId > b.sentryId ? 1 : 0));
  const items = new Set();
  for (let i = 0; i < entries.length; i += 1) {
    if (i > 0 && entries[i].sentryId === entries[i - 1].sentryId) return inputInvalid("fixedDefenses: duplicate sentryId");
    if (items.has(entries[i].itemId)) return inputInvalid("fixedDefenses: duplicate itemId");
    items.add(entries[i].itemId);
  }
  return { ok: true, fixedDefenses: { attackerRetreatLossPermille: fd.attackerRetreatLossPermille, entries } };
}

function validateInput(input, limits) {
  const limitProblem = checkLimits(limits);
  if (limitProblem) return inputInvalid(limitProblem);
  const problem = keysProblem(input, INPUT_KEYS, "input", [...INPUT_STRUCTURE_KEYS, INPUT_FIXED_KEY]);
  if (problem) return inputInvalid(problem);
  const structure = {};
  const badStructure = copyStructureKeys(input, structure, INPUT_STRUCTURE_CHECKS);
  if (badStructure) return inputInvalid(badStructure);
  const structureKeys = Object.keys(structure).length;
  if (structureKeys !== 0 && structureKeys !== INPUT_STRUCTURE_KEYS.length) {
    return inputInvalid("structure: structureId, structureTypeId, structureSide all or none");
  }
  if (structureKeys !== 0 && input.garrison !== null) return inputInvalid("structure: garrison must be null");
  if (input.v !== CONTRACT_VERSION) return inputInvalid("v");
  if (!isId(input.battleId, "battle")) return inputInvalid("battleId");
  if (!Number.isSafeInteger(input.seed) || input.seed < 0 || input.seed > MAX_UINT32) return inputInvalid("seed");
  if (!isPositiveId(input.systemId)) return inputInvalid("systemId");
  if (!ENVIRONMENTS.includes(input.environment)) return inputInvalid("environment");
  if (!BATTLE_OBJECTIVES.includes(input.objective)) return inputInvalid("objective");
  if (!RESOLVER_VERSIONS.includes(input.resolverVersion)) return inputInvalid("resolverVersion");
  const ms = input.maxResolutionMs;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > limits.maxResolutionMs) return inputInvalid("maxResolutionMs");
  const extra = {};
  const withFixed = present(input, INPUT_FIXED_KEY);
  if (withFixed) {
    if (structureKeys !== 0) return inputInvalid("fixedDefenses: no structure keys");
    if (input.garrison !== null) return inputInvalid("fixedDefenses: garrison must be null");
    const fd = normalizeFixedDefenses(input[INPUT_FIXED_KEY]);
    if (!fd.ok) return fd;
    extra[INPUT_FIXED_KEY] = fd.fixedDefenses;
  }
  const a = normalizeSide(input.sideA, "sideA", limits);
  if (!a.ok) return a;
  const b = normalizeSide(input.sideB, "sideB", limits, withFixed);
  if (!b.ok) return b;
  if (b.side.factionId !== null && a.side.factionId === b.side.factionId) {
    return inputInvalid("sideA.factionId === sideB.factionId");
  }
  const ids = [...a.side.fleets, ...b.side.fleets].map((f) => f.fleetId);
  if (new Set(ids).size !== ids.length) return inputInvalid("fleets: duplicate fleetId");
  let garrison = null;
  if (input.garrison !== null) {
    const gProblem = keysProblem(input.garrison, GARRISON_KEYS, "garrison");
    if (gProblem) return inputInvalid(gProblem);
    const g = input.garrison;
    if (!SIDES.includes(g.side)) return inputInvalid("garrison.side");
    const sideFaction = g.side === "A" ? a.side.factionId : b.side.factionId;
    if (g.factionId !== sideFaction) return inputInvalid("garrison.factionId != factionId of its side");
    if (!Number.isSafeInteger(g.strength) || g.strength < 0) return inputInvalid("garrison.strength");
    garrison = { side: g.side, factionId: g.factionId, strength: g.strength };
  }
  return { ok: true, input: deepFreeze({ v: CONTRACT_VERSION, battleId: input.battleId, seed: input.seed,
    systemId: input.systemId, environment: input.environment, sideA: a.side, sideB: b.side,
    objective: input.objective, garrison, resolverVersion: input.resolverVersion, maxResolutionMs: ms,
    ...structure, ...extra }) };
}

function normalizeFixedOutcome(input, result) {
  const fd = present(input, INPUT_FIXED_KEY) ? input[INPUT_FIXED_KEY] : null;
  const given = present(result, RESULT_FIXED_KEY);
  if (!fd) return given ? resultInvalid(`${RESULT_FIXED_KEY}: input has no fixedDefenses`) : { ok: true, extra: {} };
  const list = result[RESULT_FIXED_KEY];
  const entries = fd.entries;
  if (!Array.isArray(list) || !Array.isArray(entries) || list.length !== entries.length) {
    return resultInvalid(`${RESULT_FIXED_KEY}: one entry per fixedDefenses entry`);
  }
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const where = `${RESULT_FIXED_KEY}[${i}]`;
    const o = list[i];
    const problem = keysProblem(o, FIXED_OUTCOME_KEYS, where);
    if (problem) return resultInvalid(problem);
    const e = entries[i];
    if (o.sentryId !== e.sentryId) return resultInvalid(`${where}.sentryId != input entry`);
    if (!isIntIn(o.damage, 0, e.ehp)) return resultInvalid(`${where}.damage`);
    if (typeof o.destroyed !== "boolean" || o.destroyed !== (o.damage === e.ehp)) {
      return resultInvalid(`${where}.destroyed`);
    }
    out.push({ sentryId: o.sentryId, damage: o.damage, destroyed: o.destroyed });
  }
  return { ok: true, extra: { [RESULT_FIXED_KEY]: out } };
}

const groupKey = (fleetId, hullGroup, typeId) => `${fleetId}|${hullGroup}|${typeId || 0}`;

function compareGroups(x, y) {
  if (x.fleetId !== y.fleetId) return x.fleetId < y.fleetId ? -1 : 1;
  return compareEntries(x, y);
}

function validateResult(input, result, limits) {
  if (!limits || !Number.isSafeInteger(limits.maxResultBytes) || limits.maxResultBytes < 1) {
    return resultInvalid("limits.maxResultBytes");
  }
  if (!isPlainObject(input) || !input.sideA || !input.sideB) return resultInvalid("input");
  const problem = keysProblem(result, RESULT_KEYS, "result", [...RESULT_STRUCTURE_KEYS, RESULT_FIXED_KEY]);
  if (problem) return resultInvalid(problem);
  const structure = {};
  const badStructure = copyStructureKeys(result, structure, [["structureDestroyed", (v) => typeof v === "boolean"],
    ["structureId", isPositiveId], ["structureTypeId", isPositiveId]]);
  if (badStructure) return resultInvalid(badStructure);
  const fixedOutcome = normalizeFixedOutcome(input, result);
  if (!fixedOutcome.ok) return fixedOutcome;
  Object.assign(structure, fixedOutcome.extra);
  if (result.battleId !== input.battleId) return resultInvalid("battleId != input");
  if (result.resolver !== input.resolverVersion) return resultInvalid("resolver != input.resolverVersion");
  if (!OUTCOMES.includes(result.outcome)) return resultInvalid("outcome");
  if (typeof result.objectiveAchieved !== "boolean") return resultInvalid("objectiveAchieved");
  const c = result.confidence;
  if (typeof c !== "number" || !Number.isFinite(c) || c < 0 || c > 1) return resultInvalid("confidence");
  const d = result.estimatedDurationSec;
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) return resultInvalid("estimatedDurationSec");
  if (!isPlainObject(result.diagnostics)) return resultInvalid("diagnostics");
  for (const [key, value] of Object.entries(result.diagnostics)) {
    const okValue = typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
    if (!okValue) return resultInvalid(`diagnostics.${key}`);
  }
  const expected = new Map();
  for (const side of [input.sideA, input.sideB]) {
    for (const f of side.fleets) {
      for (const e of f.composition) {
        expected.set(groupKey(f.fleetId, e.hullGroup, e.typeId),
          { fleetId: f.fleetId, hullGroup: e.hullGroup, typeId: e.typeId, count: e.count });
      }
    }
  }
  const actual = new Map();
  const lists = {};
  for (const name of SHIP_LISTS) {
    const list = result[name];
    if (!Array.isArray(list)) return resultInvalid(`${name}: not an array`);
    const seen = new Set();
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const g = list[i];
      const where = `${name}[${i}]`;
      if (!isPlainObject(g)) return resultInvalid(`${where}: not an object`);
      for (const key of Object.keys(g)) if (!GROUP_KEYS.includes(key)) return resultInvalid(`${where}: field ${key}`);
      if (typeof g.fleetId !== "string") return resultInvalid(`${where}.fleetId`);
      if (typeof g.hullGroup !== "string") return resultInvalid(`${where}.hullGroup`);
      const typeId = g.typeId === undefined ? null : g.typeId;
      if (typeId !== null && (!Number.isSafeInteger(typeId) || typeId < 0)) return resultInvalid(`${where}.typeId`);
      if (!Number.isSafeInteger(g.count) || g.count < 1) return resultInvalid(`${where}.count`);
      const key = groupKey(g.fleetId, g.hullGroup, typeId);
      const group = expected.get(key);
      if (!group) return resultInvalid(`${where}: group not in the input`);
      if (seen.has(key)) return resultInvalid(`${where}: duplicate group`);
      seen.add(key);
      actual.set(key, (actual.get(key) || 0) + g.count);
      out.push({ fleetId: group.fleetId, hullGroup: group.hullGroup, typeId: group.typeId, count: g.count });
    }
    lists[name] = out.sort(compareGroups);
  }
  const normalized = { battleId: result.battleId, resolver: result.resolver, outcome: result.outcome,
    destroyedShips: lists.destroyedShips, escapedShips: lists.escapedShips, survivingShips: lists.survivingShips,
    objectiveAchieved: result.objectiveAchieved, estimatedDurationSec: d, confidence: c,
    diagnostics: { ...result.diagnostics }, ...structure };
  let bytes;
  try {
    bytes = Buffer.byteLength(stableJson(normalized), "utf8");
  } catch (err) {
    return resultInvalid(`not JSON data: ${(err && err.message) || err}`);
  }
  if (bytes > limits.maxResultBytes) return resultInvalid(`${bytes} bytes > maxResultBytes ${limits.maxResultBytes}`);
  for (const [key, group] of expected) {
    const got = actual.get(key) || 0;
    if (got !== group.count) {
      return { ok: false, reason: "RESULT_UNBALANCED",
        group: { fleetId: group.fleetId, hullGroup: group.hullGroup, typeId: group.typeId },
        expected: group.count, actual: got };
    }
  }
  return { ok: true, result: deepFreeze(normalized) };
}

function hashInput(input, limits = HASH_LIMITS) {
  const r = validateInput(input, limits);
  if (!r.ok) throw new TypeError(`INPUT_INVALID: ${r.detail}`);
  return fingerprint(r.input);
}

function buildFleetSnapshot(factionId, fleetRecords) {
  const fleets = fleetRecords.map((f) => ({ fleetId: f.fleetId, factionId: f.factionId, fleetRole: f.fleetRole,
    doctrineId: f.doctrineId, supplyState: f.supplyState,
    composition: f.composition.map((e) => ({ hullGroup: e.hullGroup, typeId: e.typeId, count: e.count })) }));
  fleets.sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
  return { factionId, fleets };
}

module.exports = { HASH_LIMITS, MAX_FIXED_DEFENSES, INPUT_FIXED_KEY, RESULT_FIXED_KEY, validateInput, validateResult,
  hashInput, buildFleetSnapshot };
