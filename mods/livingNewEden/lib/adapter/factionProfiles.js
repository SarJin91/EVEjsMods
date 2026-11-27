"use strict";

const { wrapGeneratedRows } = require("./npcGeneratedRows");
const { NAVY_PROFILES_BY_FACTION_ID } = require("./empireNavyCatalog");

const WRAPPED = Symbol.for("livingNewEden.factionProfiles");
const METHOD = "getCapitalNpcGeneratedRows";
const LABEL = "livingNewEden_faction_getCapitalNpcGeneratedRows";
const PROFILES_TABLE = "npcProfiles";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const nonEmpty = (value) => typeof value === "string" && value !== "";

function validClassEntry(entry) {
  return isObject(entry) && Number.isSafeInteger(entry.typeId) && entry.typeId > 0
    && Number.isSafeInteger(entry.presentationTypeId) && entry.presentationTypeId > 0 && nonEmpty(entry.label)
    && nonEmpty(entry.loadoutId) && nonEmpty(entry.behaviorProfileId);
}

function validFaction(key, faction) {
  return /^[1-9][0-9]*$/.test(key) && isObject(faction) && Number.isSafeInteger(faction.corporationId)
    && nonEmpty(faction.hardwareFamily) && nonEmpty(faction.namePrefix) && isObject(faction.byClass)
    && Object.keys(faction.byClass).every((cls) => validClassEntry(faction.byClass[cls]));
}

function validData(data) {
  return isObject(data) && nonEmpty(data.PROFILE_PREFIX) && isObject(data.FACTION_LIVE_PROFILES)
    && Object.keys(data.FACTION_LIVE_PROFILES).every((k) => validFaction(k, data.FACTION_LIVE_PROFILES[k]))
    && Number.isSafeInteger(data.SPAWN_DISTANCE_METERS) && Number.isFinite(data.SECURITY_STATUS)
    && nonEmpty(data.PLACEHOLDER_LOOT_TABLE_ID) && nonEmpty(data.NPC_ENTITY_TYPE)
    && nonEmpty(data.PREFERRED_TARGET_MODE);
}

const profileIdOf = (data, factionKey, cls) => `${data.PROFILE_PREFIX}${factionKey}_${cls}`;

function navyTableOf(data) {
  if (!validData(data)) return Object.freeze({});
  const out = {};
  for (const factionKey of Object.keys(data.FACTION_LIVE_PROFILES)) {
    const byClass = {};
    for (const cls of Object.keys(data.FACTION_LIVE_PROFILES[factionKey].byClass)) {
      byClass[cls] = profileIdOf(data, factionKey, cls);
    }
    out[factionKey] = Object.freeze(byClass);
  }
  return Object.freeze(out);
}

function selectNavyTable(csv, data) {
  if (!nonEmpty(csv)) return Object.freeze({});
  const table = navyTableOf(data);
  const out = {};
  for (const token of csv.split(",")) {
    const id = token.trim();
    if (hasOwn(table, id) && !hasOwn(NAVY_PROFILES_BY_FACTION_ID, id)) out[id] = table[id];
  }
  return Object.freeze(out);
}

function bountyFreighterRows(data) {
  const factions = isObject(data.BOUNTY_FREIGHTERS) ? data.BOUNTY_FREIGHTERS : null;
  const hulls = isObject(data.BOUNTY_FREIGHTER_HULLS) ? data.BOUNTY_FREIGHTER_HULLS : null;
  if (!factions || !hulls || typeof data.bountyFreighterProfileId !== "function"
    || !nonEmpty(data.BOUNTY_FREIGHTER_LOADOUT_ID)) {
    return null;
  }
  const out = [];
  for (const factionKey of Object.keys(factions)) {
    const f = factions[factionKey];
    const r = isObject(f) && hasOwn(hulls, f.race) ? hulls[f.race] : null;
    if (!/^[1-9][0-9]*$/.test(factionKey) || !isObject(r) || !nonEmpty(f.label)
      || !Number.isSafeInteger(f.corporationId) || f.corporationId <= 0) return null;
    for (const jump of [false, true]) {
      const hull = jump ? r.jump : r.freighter;
      if (!isObject(hull) || !Number.isSafeInteger(hull.typeId) || hull.typeId <= 0) return null;
      const name = `${f.label} ${jump ? "Jump Freighter" : "Freighter"}`;
      out.push(Object.freeze({
        profileID: data.bountyFreighterProfileId(factionKey, jump),
        name,
        description: `Living New Eden bounty smuggler ${name} (hull ${hull.hull} ${hull.typeId}, no weapons).`,
        aliases: Object.freeze([]),
        entityType: data.NPC_ENTITY_TYPE,
        shipTypeID: hull.typeId,
        presentationTypeID: r.presentationTypeId,
        presentationName: name,
        corporationID: f.corporationId,
        allianceID: 0,
        factionID: Number(factionKey),
        behaviorProfileID: f.behaviorProfileId,
        loadoutID: data.BOUNTY_FREIGHTER_LOADOUT_ID,
        hardwareFamily: f.hardwareFamily,
        lootTableID: data.PLACEHOLDER_LOOT_TABLE_ID,
        shipNameTemplate: name,
        securityStatus: data.BOUNTY_FREIGHTER_SECURITY_STATUS,
        bounty: 0,
        spawnDistanceMeters: data.SPAWN_DISTANCE_METERS,
        preferredTargetMode: data.PREFERRED_TARGET_MODE,
      }));
    }
  }
  return out;
}

const CIVILIAN_ROLES = Object.freeze(["HAULER", "MINER", "UNDOCK", "GATE_IDLE", "RATTER", "EXPLORER", "POD", "PILOT"]);
const CIVILIAN_KEY_RE = /^[a-z0-9_]{1,24}$/;
const posInt = (value) => Number.isSafeInteger(value) && value > 0;

function validCivilianHull(entry) {
  return isObject(entry) && typeof entry.key === "string" && CIVILIAN_KEY_RE.test(entry.key) && nonEmpty(entry.label)
    && posInt(entry.shipTypeId) && posInt(entry.presentationTypeId)
    && entry.presentationTypeId !== entry.shipTypeId
    && nonEmpty(entry.loadoutId) && nonEmpty(entry.behaviorProfileId)
    && Array.isArray(entry.roles) && entry.roles.length > 0 && entry.roles.every((r) => CIVILIAN_ROLES.includes(r))
    && Number.isFinite(entry.weight) && entry.weight > 0;
}

function civilianRowsOf(civ, data) {
  if (!isObject(civ) || !Array.isArray(civ.CIVILIAN_HULLS) || civ.CIVILIAN_HULLS.length === 0
    || typeof civ.civilianProfileId !== "function" || !posInt(civ.CIVILIAN_CORPORATION_ID)
    || !posInt(civ.CIVILIAN_FACTION_ID) || !nonEmpty(civ.CIVILIAN_HARDWARE_FAMILY)
    || !Number.isFinite(civ.CIVILIAN_SECURITY_STATUS)) {
    return null;
  }
  const keys = new Set();
  const out = [];
  for (const entry of civ.CIVILIAN_HULLS) {
    if (!validCivilianHull(entry) || keys.has(entry.key)) return null;
    keys.add(entry.key);
    out.push(Object.freeze({
      profileID: civ.civilianProfileId(entry.key),
      name: entry.label,
      description: `Living New Eden civilian ${entry.label} (hull ${entry.shipTypeId}, no weapons).`,
      aliases: Object.freeze([]),
      entityType: data.NPC_ENTITY_TYPE,
      shipTypeID: entry.shipTypeId,
      presentationTypeID: entry.presentationTypeId,
      presentationName: entry.label,
      corporationID: civ.CIVILIAN_CORPORATION_ID,
      allianceID: 0,
      factionID: civ.CIVILIAN_FACTION_ID,
      behaviorProfileID: entry.behaviorProfileId,
      loadoutID: entry.loadoutId,
      hardwareFamily: civ.CIVILIAN_HARDWARE_FAMILY,
      lootTableID: data.PLACEHOLDER_LOOT_TABLE_ID,
      shipNameTemplate: entry.label,
      securityStatus: civ.CIVILIAN_SECURITY_STATUS,
      bounty: 0,
      spawnDistanceMeters: data.SPAWN_DISTANCE_METERS,
      preferredTargetMode: data.PREFERRED_TARGET_MODE,
    }));
  }
  return out;
}

function buildFactionProfileRows(input) {
  if (!isObject(input) || !validData(input.data)) return { ok: false, reason: "INVALID_INPUT" };
  const { data } = input;
  const includeFactions = input.includeFactions !== false;
  const freighters = input.bountyFreighters === true ? bountyFreighterRows(data) : [];
  if (!freighters) return { ok: false, reason: "INVALID_INPUT" };
  const civilians = input.civilianRows === true ? civilianRowsOf(input.civilianData, data) : [];
  if (!civilians) return { ok: false, reason: "INVALID_INPUT" };
  const profiles = [];
  for (const factionKey of includeFactions ? Object.keys(data.FACTION_LIVE_PROFILES) : []) {
    const faction = data.FACTION_LIVE_PROFILES[factionKey];
    for (const cls of Object.keys(faction.byClass)) {
      const entry = faction.byClass[cls];
      const profileId = profileIdOf(data, factionKey, cls);
      const name = `${faction.namePrefix} ${entry.label}`;
      profiles.push(Object.freeze({
        profileID: profileId,
        name,
        description: `Living New Eden ${cls} of faction ${factionKey} (player hull ${entry.typeId}, loadout `
          + `${entry.loadoutId}, behaviour ${entry.behaviorProfileId}).`,
        aliases: Object.freeze([]),
        entityType: data.NPC_ENTITY_TYPE,
        shipTypeID: entry.typeId,
        presentationTypeID: entry.presentationTypeId,
        presentationName: name,
        corporationID: faction.corporationId,
        allianceID: 0,
        factionID: Number(factionKey),
        behaviorProfileID: entry.behaviorProfileId,
        loadoutID: entry.loadoutId,
        hardwareFamily: faction.hardwareFamily,
        lootTableID: data.PLACEHOLDER_LOOT_TABLE_ID,
        shipNameTemplate: name,
        securityStatus: data.SECURITY_STATUS,
        bounty: 0,
        spawnDistanceMeters: data.SPAWN_DISTANCE_METERS,
        preferredTargetMode: data.PREFERRED_TARGET_MODE,
      }));
    }
  }
  profiles.push(...freighters, ...civilians);
  return { ok: true, rows: Object.freeze({ [PROFILES_TABLE]: Object.freeze(profiles) }),
    index: includeFactions ? navyTableOf(data) : Object.freeze({}) };
}

let current = null;
const counters = { rowsInjected: 0, buildFailed: 0 };

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
    if (outcome === "built") counters.rowsInjected = detail.rowsInjected;
    else counters.buildFailed += 1;
    if (typeof opts.onOutcome === "function") opts.onOutcome(outcome, detail);
  };
  const wrapped = wrapGeneratedRows(existing, opts.build, onOutcome, { symbol: WRAPPED, label: LABEL });
  try {
    catalogExports[METHOD] = wrapped;
  } catch (_err) {
    return { ok: false, reason: "NOT_WRITABLE" };
  }
  if (catalogExports[METHOD] !== wrapped) return { ok: false, reason: "NOT_WRITABLE" };
  current = wrapped[WRAPPED];
  return { ok: true, alreadyInstalled: false };
}

function installedNavyTable() {
  if (current === null) return Object.freeze({});
  let built = null;
  try {
    built = current.ensure();
  } catch (_err) {
    built = null;
  }
  return built && isObject(built.index) ? built.index : Object.freeze({});
}

function stats() {
  return { installed: current !== null, ...counters };
}

function _resetForTest() {
  current = null;
  counters.rowsInjected = 0;
  counters.buildFailed = 0;
}

module.exports = {
  WRAPPED, METHOD, LABEL, CIVILIAN_ROLES, buildFactionProfileRows, navyTableOf, selectNavyTable, install, installedNavyTable, stats, _resetForTest,
};
