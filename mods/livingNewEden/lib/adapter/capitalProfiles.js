"use strict";

const { wrapGeneratedRows } = require("./npcGeneratedRows");

const WRAPPED = Symbol.for("livingNewEden.capitalLiveProfiles");
const METHOD = "getCapitalNpcGeneratedRows";
const TABLES = Object.freeze({
  PROFILES: "npcProfiles",
  LOADOUTS: "npcLoadouts",
  BEHAVIOR_PROFILES: "npcBehaviorProfiles",
  LOOT_TABLES: "npcLootTables",
});

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function withoutKeysStartingWith(object, prefix) {
  const out = {};
  for (const key of Object.keys(object)) {
    if (!key.startsWith(prefix)) out[key] = object[key];
  }
  return out;
}

function validInput(input) {
  return isObject(input) && Array.isArray(input.authority) && typeof input.classTypeOf === "function"
    && Array.isArray(input.factionIds) && Array.isArray(input.classes) && isObject(input.data)
    && typeof input.data.PROFILE_PREFIX === "string" && isObject(input.data.TEMPLATE_RACE_BY_FACTION_ID)
    && isObject(input.data.TEMPLATE_BY_RACE_CLASS) && isObject(input.data.IDENTITY_TEMPLATE_BY_RACE)
    && isObject(input.data.CAPITAL_CLASS_RUNTIME) && isObject(input.data.FIGHTER_TUBES)
    && Array.isArray(input.data.EMPIRE_FACTION_IDS) && isObject(input.data.SECURITY_STATUS)
    && isObject(input.data.CLASS_LABEL);
}

function behaviorRowOf(template, ids, cls, fighters, superweapons, data) {
  let row = clone(template.behaviorProfile);
  row.behaviorProfileID = ids.behaviorProfileID;
  row.name = ids.name;
  if (!fighters) {
    row = withoutKeysStartingWith(row, "capitalFighter");
  } else if (Array.isArray(row.capitalFighterWingTypeIDs)) {
    const tubes = hasOwn(data.FIGHTER_TUBES, cls) ? data.FIGHTER_TUBES[cls] : row.capitalFighterWingTypeIDs.length;
    row.capitalFighterWingTypeIDs = row.capitalFighterWingTypeIDs.slice(0, tubes);
  }
  if (!superweapons) row = withoutKeysStartingWith(row, "capitalSuperweapon");
  return row;
}

function loadoutRowOf(template, ids, superweapons, unarmed) {
  if (unarmed) return { loadoutID: ids.loadoutID, name: ids.name, modules: [], charges: [], cargo: [] };
  const loadout = isObject(template.loadout) ? template.loadout : {};
  const doomsday = template.behaviorProfile.capitalSuperweaponModuleTypeID;
  const modules = clone(Array.isArray(loadout.modules) ? loadout.modules : []);
  return {
    loadoutID: ids.loadoutID,
    name: ids.name,
    modules: superweapons || doomsday === undefined ? modules : modules.filter((m) => !m || m.typeID !== doomsday),
    charges: clone(Array.isArray(loadout.charges) ? loadout.charges : []),
    cargo: clone(Array.isArray(loadout.cargo) ? loadout.cargo : []),
  };
}

function buildCapitalProfileRows(input) {
  if (!validInput(input)) return { ok: false, reason: "INVALID_INPUT" };
  const { authority, classTypeOf, factionIds, classes, data } = input;
  const fighters = input.fighters === true;
  const superweapons = input.superweapons === true;
  const templates = new Map();
  for (const entry of authority) {
    if (isObject(entry) && typeof entry.profileID === "string" && isObject(entry.faction)
      && isObject(entry.behaviorProfile)) templates.set(entry.profileID, entry);
  }
  if (templates.size === 0) return { ok: false, reason: "NO_TEMPLATES" };

  const rows = { [TABLES.PROFILES]: [], [TABLES.LOADOUTS]: [], [TABLES.BEHAVIOR_PROFILES]: [], [TABLES.LOOT_TABLES]: [] };
  const index = {};
  const skipped = [];
  for (const factionId of factionIds) {
    const race = hasOwn(data.TEMPLATE_RACE_BY_FACTION_ID, String(factionId))
      ? data.TEMPLATE_RACE_BY_FACTION_ID[String(factionId)] : null;
    const byClass = race !== null && hasOwn(data.TEMPLATE_BY_RACE_CLASS, race) ? data.TEMPLATE_BY_RACE_CLASS[race] : {};
    const empire = data.EMPIRE_FACTION_IDS.includes(factionId);
    for (const cls of classes) {
      if (!hasOwn(data.CAPITAL_CLASS_RUNTIME, cls)) continue;
      const typeId = classTypeOf(factionId, cls);
      if (!Number.isSafeInteger(typeId) || typeId <= 0) {
        skipped.push({ factionId, cls, reason: "NO_TYPE" });
        continue;
      }
      const template = hasOwn(byClass, cls) ? templates.get(byClass[cls]) : undefined;
      const identity = race !== null && hasOwn(data.IDENTITY_TEMPLATE_BY_RACE, race)
        ? templates.get(data.IDENTITY_TEMPLATE_BY_RACE[race]) : undefined;
      if (!template || (!empire && !identity)) {
        skipped.push({ factionId, cls, reason: "NO_TEMPLATE" });
        continue;
      }
      const profileId = `${data.PROFILE_PREFIX}${factionId}_${cls}`;
      const name = `LNE ${data.CLASS_LABEL[cls] || cls} ${factionId}`;
      const ids = { name, behaviorProfileID: `${profileId}_behavior`, loadoutID: `${profileId}_loadout` };
      const lootTableID = empire ? null : `${profileId}_loot`;
      const superHull = superweapons && Number.isSafeInteger(template.titanSuperweaponHullTypeID)
        ? template.titanSuperweaponHullTypeID : null;
      rows[TABLES.PROFILES].push({
        profileID: profileId,
        name,
        description: `Living New Eden ${cls} of faction ${factionId} (template ${template.profileID}).`,
        aliases: [],
        entityType: data.NPC_ENTITY_TYPE,
        shipTypeID: typeId,
        presentationTypeID: typeId,
        corporationID: empire ? 0 : identity.faction.corporationID,
        allianceID: 0,
        factionID: empire ? 0 : identity.faction.factionID,
        behaviorProfileID: ids.behaviorProfileID,
        loadoutID: ids.loadoutID,
        lootTableID,
        shipNameTemplate: name,
        securityStatus: empire ? data.SECURITY_STATUS.empire : data.SECURITY_STATUS.pirate,
        bounty: empire ? 0 : (Number(template.bounty) || 0),
        spawnDistanceMeters: template.spawnDistanceMeters,
        preferredTargetMode: "invoker",
        hardwareFamily: template.faction.hardwareFamily,
        capitalClassID: data.CAPITAL_CLASS_RUNTIME[cls],
        capitalRarity: template.rarity,
        capitalNpc: true,
        titanSuperweaponHullTypeID: superHull,
      });
      const unarmed = Array.isArray(data.UNARMED_CLASSES) && data.UNARMED_CLASSES.includes(cls);
      rows[TABLES.LOADOUTS].push(loadoutRowOf(template, ids, superweapons, unarmed));
      rows[TABLES.BEHAVIOR_PROFILES].push(behaviorRowOf(template, ids, cls, fighters, superweapons, data));
      if (lootTableID !== null) {
        rows[TABLES.LOOT_TABLES].push({ lootTableID, ...clone(isObject(template.lootTable) ? template.lootTable : {}) });
      }
      if (!hasOwn(index, String(factionId))) index[String(factionId)] = {};
      index[String(factionId)][cls] = { profileId, typeId };
    }
  }
  for (const table of Object.keys(rows)) Object.freeze(rows[table]);
  return { ok: true, rows: Object.freeze(rows), index, skipped };
}

function wrapCapitalGeneratedRows(original, build, onOutcome) {
  return wrapGeneratedRows(original, build, onOutcome, { symbol: WRAPPED, label: `livingNewEden_${METHOD}` });
}

let current = null;
const counters = { rowsInjected: 0, skipped: 0, buildFailed: 0 };

function install(catalogExports, opts) {
  if (!catalogExports || typeof catalogExports !== "object" || !hasOwn(catalogExports, METHOD)
    || typeof catalogExports[METHOD] !== "function") {
    return { ok: false, reason: "NOT_A_FUNCTION" };
  }
  if (!opts || typeof opts.build !== "function") return { ok: false, reason: "NO_BUILD" };
  const existing = catalogExports[METHOD];
  if (existing[WRAPPED]) {
    current = existing[WRAPPED];
    return { ok: true, alreadyInstalled: true };
  }
  const onOutcome = (outcome, detail) => {
    if (outcome === "built") {
      counters.rowsInjected = detail.rowsInjected;
      counters.skipped = detail.skipped;
    } else {
      counters.buildFailed += 1;
    }
    if (typeof opts.onOutcome === "function") opts.onOutcome(outcome, detail);
  };
  const wrapped = wrapCapitalGeneratedRows(existing, opts.build, onOutcome);
  try {
    catalogExports[METHOD] = wrapped;
  } catch (_err) {
    return { ok: false, reason: "NOT_WRITABLE" };
  }
  if (catalogExports[METHOD] !== wrapped) return { ok: false, reason: "NOT_WRITABLE" };
  current = wrapped[WRAPPED];
  return { ok: true, alreadyInstalled: false };
}

function readIndex() {
  if (current === null) return { ok: false, reason: "DISABLED" };
  const built = current.ensure();
  if (!built) return { ok: false, reason: "NOT_BUILT" };
  return { ok: true, enabled: true, index: clone(built.index), skipped: clone(built.skipped) };
}

function stats() {
  return { installed: current !== null, ...counters };
}

function _resetForTest() {
  current = null;
  counters.rowsInjected = 0;
  counters.skipped = 0;
  counters.buildFailed = 0;
}

module.exports = {
  WRAPPED, METHOD, TABLES, buildCapitalProfileRows, wrapCapitalGeneratedRows, install, readIndex, stats,
  _resetForTest,
};
