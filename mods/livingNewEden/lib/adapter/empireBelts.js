"use strict";

const { NAVY_PROFILES_BY_FACTION_ID } = require("./empireNavyCatalog");
const { isFailure } = require("./projection");
const { NAVY_PASSIVE_BEHAVIOR } = require("./data/liveProfiles");

const WRAPPED_EMPIRE_BELTS = Symbol.for("livingNewEden.empireBeltsWrapped");

const REASON_NAVY = "CONTROLLER_NAVY";
const REASON_PATROL = "CONTROLLER_PATROL";
const REASON_FAILED = "FAILED";
const REASON_AGGRO_UNAVAILABLE = "AGGRO_UNAVAILABLE";
const ROLL_NO_SCORE = "NO_SCORE";
const READ_PREFIX = "READ_";
const NULLSEC_BAND = "nullsec";
const SELECTION_PREFIX = "belt_navy";
const VENDOR_SELECTION_PREFIX = "belt_rat:";
const SPECIAL_SELECTION_SEGMENTS = 4;
const OWN_OPTION = "spawnNativeDefinitionsInContext";
const HULL_CHECK_ORDER = Object.freeze(["battlecruiser", "battleship", "destroyer", "cruiser", "frigate"]);

function hasOwn(obj, key) {
  return obj !== null && typeof obj === "object" && Object.prototype.hasOwnProperty.call(obj, key);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

// Port of beltRatRuntime.js:622-624 normalizeHullClass.
function normalizeHullClass(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
}

// Port of beltRatRuntime.js:626-646 profileMatchesHullClass, haystack + sourceProfileName (the belt presentation
function profileMatchesHullClass(profile, hullClass) {
  const normalizedHullClass = normalizeHullClass(hullClass);
  if (!normalizedHullClass) return false;
  const haystack = [
    profile && profile.profileID,
    profile && profile.name,
    profile && profile.description,
    profile && profile.shipNameTemplate,
    profile && profile.sourceProfileName,
    ...(Array.isArray(profile && profile.aliases) ? profile.aliases : []),
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[_-]+/g, " ");
  if (normalizedHullClass === "battlecruiser") {
    return /(^|[^a-z])battle\s*cruiser([^a-z]|$)/.test(haystack);
  }
  const pattern = new RegExp(`(^|[^a-z])${normalizedHullClass}([^a-z]|$)`);
  return pattern.test(haystack.replace(/\s+/g, " "));
}

function classifyHull(definition) {
  const profile = definition && definition.profile;
  if (!profile || typeof profile !== "object") return null;
  for (const hull of HULL_CHECK_ORDER) if (profileMatchesHullClass(profile, hull)) return hull;
  return null;
}

function selectNavyProfiles(csv) {
  if (!nonEmptyString(csv)) return NAVY_PROFILES_BY_FACTION_ID;
  const out = {};
  for (const token of csv.split(",")) {
    const id = token.trim();
    if (hasOwn(NAVY_PROFILES_BY_FACTION_ID, id)) out[id] = NAVY_PROFILES_BY_FACTION_ID[id];
  }
  return Object.freeze(out);
}

function decideNavy(systemId, options, deps) {
  if (options !== null && typeof options === "object" && (nonEmptyString(options.factionKey)
    || nonEmptyString(options.forceSpecialSpawnKind) || nonEmptyString(options.specialSpawnKind))) {
    return { navy: null, reason: "EXPLICIT_OVERRIDE" };
  }
  const id = Math.trunc(Number(systemId));
  if (!Number.isSafeInteger(id) || id <= 0) return { navy: null, reason: "BAD_SYSTEM_ID" };
  const security = deps.resolveSecurityProfile(id);
  if (!security || security.band !== NULLSEC_BAND) return { navy: null, reason: "NOT_NULLSEC" };
  const read = deps.readController(id);
  if (!read || read.ok !== true) return { navy: null, reason: `${READ_PREFIX}${(read && read.reason) || "NO_RESULT"}` };
  const controller = read.controllerFactionId;
  if (controller === null || controller === undefined) return { navy: null, reason: "NO_CONTROLLER" };
  const field = String(controller);
  if (!hasOwn(deps.navyProfiles, field)) return { navy: null, reason: "NOT_EMPIRE" };
  return { navy: deps.navyProfiles[field], factionId: Number(controller), reason: REASON_NAVY };
}

function withPirateRewards(definition, vendorDefinition, rewards) {
  const pirateBounty = Number(rewards.resolveBounty(vendorDefinition));
  const bounty = Math.round(pirateBounty * rewards.bountyMultiplier);
  if (!(pirateBounty > 0) || !Number.isFinite(bounty) || bounty <= 0) return { ok: false, reason: "BOUNTY_UNRESOLVED" };
  const lootTable = vendorDefinition.lootTable;
  if (!lootTable || !nonEmptyString(lootTable.lootTableID)) return { ok: false, reason: "LOOT_UNRESOLVED" };
  return { ok: true, definition: { ...definition, lootTable, profile: { ...definition.profile,
    factionID: rewards.factionId, lootTableID: lootTable.lootTableID, bounty } } };
}

function buildNavyDefinitions(vendorDefinitions, navy, buildNpcDefinition, rewards = null) {
  if (!Array.isArray(vendorDefinitions) || vendorDefinitions.length === 0) return { ok: false, reason: "EMPTY" };
  const definitions = [];
  const profileIds = [];
  for (const vendorDefinition of vendorDefinitions) {
    const hull = classifyHull(vendorDefinition);
    if (!hull || !hasOwn(navy, hull)) return { ok: false, reason: "HULL_UNKNOWN" };
    const profileId = navy[hull];
    const definition = buildNpcDefinition(profileId);
    if (!definition) return { ok: false, reason: "DEFINITION_MISSING" };
    const rewarded = rewards ? withPirateRewards(definition, vendorDefinition, rewards) : { ok: true, definition };
    if (!rewarded.ok) return rewarded;
    definitions.push(rewarded.definition);
    profileIds.push(profileId);
  }
  return { ok: true, definitions, profileIds };
}

function isBeltNavyVictim(entity) {
  const selectionId = entity && entity.selectionID;
  return typeof selectionId === "string" && selectionId.startsWith(`${SELECTION_PREFIX}:`);
}

function isSpecialSelection(selectionId) {
  const id = String(selectionId);
  return id.startsWith(VENDOR_SELECTION_PREFIX) && id.split(":").length >= SPECIAL_SELECTION_SEGMENTS;
}

function stripOwn(spawnOptions) {
  if (spawnOptions === null || typeof spawnOptions !== "object") return spawnOptions;
  const rest = { ...spawnOptions };
  delete rest[OWN_OPTION];
  return rest;
}

function spawnedEntityIds(result) {
  const spawned = result && result.data && result.data.spawned;
  if (!Array.isArray(spawned)) return [];
  return spawned.map((entry) => Math.trunc(Number(entry && entry.entity && entry.entity.itemID)))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
}

function wrapBeltSpawnForNavy(originalFn, deps) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED_EMPIRE_BELTS] === true) return { ok: true, wrapped: originalFn, noop: true };
  const d = deps || {};
  if (d.navyProfiles === null || typeof d.navyProfiles !== "object") return { ok: false, reason: "NAVY_TABLE_INVALID" };
  if (typeof d.readController !== "function") return { ok: false, reason: "READ_CONTROLLER_NOT_A_FUNCTION" };
  if (typeof d.resolveSecurityProfile !== "function") return { ok: false, reason: "SECURITY_PROFILE_NOT_A_FUNCTION" };
  if (typeof d.getNpcSpawnTools !== "function") return { ok: false, reason: "SPAWN_TOOLS_NOT_A_FUNCTION" };
  const onOutcome = typeof d.onOutcome === "function" ? d.onOutcome : null;
  const fullReplace = new Set(Array.isArray(d.fullReplaceFactionIds)
    ? d.fullReplaceFactionIds.map((id) => Math.trunc(Number(id))).filter((id) => Number.isSafeInteger(id) && id > 0)
    : []);
  const decisionDeps = Object.freeze({ navyProfiles: d.navyProfiles, readController: d.readController,
    resolveSecurityProfile: d.resolveSecurityProfile });

  function note(outcome, reason) {
    if (!onOutcome) return;
    try {
      onOutcome(outcome, reason);
    } catch (_err) {
    }
  }

  function livingNewEdenEmpireBeltSpawn(scene, session, shipEntity, options) {
    let decision;
    try {
      decision = decideNavy(scene && scene.systemID, options, decisionDeps);
    } catch (_err) {
      decision = { navy: null, reason: REASON_FAILED };
    }
    if (!decision.navy) {
      if (isFailure(decision.reason)) note("failed", decision.reason);
      return originalFn.apply(this, arguments);
    }
    let tools;
    try {
      tools = d.getNpcSpawnTools();
    } catch (_err) {
      tools = { ok: false, reason: "THREW" };
    }
    if (!tools || tools.ok !== true || typeof tools.buildNpcDefinition !== "function"
      || typeof tools.spawnNativeDefinitionsInContext !== "function") {
      note("fallback", `TOOLS_${(tools && tools.reason) || "INVALID"}`);
      return originalFn.apply(this, arguments);
    }
    const rewardsOn = d.rewardsEnabled === true;
    if (rewardsOn && typeof tools.resolveNpcBounty !== "function") {
      note("fallback", "TOOLS_NO_BOUNTY_READER");
      return originalFn.apply(this, arguments);
    }
    const given = options !== null && typeof options === "object" ? options : {};
    const inner = typeof given[OWN_OPTION] === "function" ? given[OWN_OPTION] : tools.spawnNativeDefinitionsInContext;
    const { navy, factionId } = decision;
    const patrol = fullReplace.has(factionId);
    const shareOn = d.shareEnabled === true && !patrol;
    const rewards = rewardsOn ? { factionId, bountyMultiplier: d.bountyMultiplier,
      resolveBounty: tools.resolveNpcBounty } : null;

    function vendorKeeps(data, own) {
      if (!shareOn) return null;
      if (isSpecialSelection(data && data.selectionID)) return ["pirates", "SPECIAL"];
      if (typeof d.decideSpawn !== "function") return ["fallback", "ROLL_UNAVAILABLE"];
      let roll;
      try {
        roll = d.decideSpawn({ systemId: Math.trunc(Number(scene.systemID)), factionId,
          spawnSiteId: own && own.spawnSiteID, atMs: d.nowMs() });
      } catch (_err) {
        return ["fallback", REASON_FAILED];
      }
      if (roll && roll.ok !== true && roll.reason === ROLL_NO_SCORE) return ["noScore", `ROLL_${ROLL_NO_SCORE}`];
      if (!roll || roll.ok !== true) return ["fallback", `ROLL_${(roll && roll.reason) || "NO_RESULT"}`];
      return roll.navy === true ? null : ["pirates", "ROLL"];
    }

    function aggroSink() {
      try {
        const sink = typeof d.getAggroSink === "function" ? d.getAggroSink() : null;
        return sink && sink.canAccept() === true ? sink : null;
      } catch (_err) {
        return null;
      }
    }

    function registerSpawn(sink, result, own) {
      let reason;
      try {
        const group = sink.registerGroup({ spawnSiteId: own && own.spawnSiteID, factionId, entityIds: spawnedEntityIds(result),
          systemId: Math.trunc(Number(scene.systemID)), atMs: d.nowMs() });
        if (group && group.ok === true) return;
        reason = (group && group.reason) || "NO_RESULT";
      } catch (_err) {
        reason = REASON_FAILED;
      }
      note("failed", `AGGRO_${reason}`);
    }

    function livingNewEdenEmpireBeltInterceptor(context, selectionResult, spawnOptions) {
      const own = stripOwn(spawnOptions);
      const data = selectionResult && selectionResult.data;
      const kept = vendorKeeps(data, own);
      if (kept) {
        note(kept[0], kept[1]);
        return inner(context, selectionResult, own);
      }
      let built;
      try {
        built = buildNavyDefinitions(data && data.definitions, navy, tools.buildNpcDefinition, rewards);
      } catch (_err) {
        built = { ok: false, reason: REASON_FAILED };
      }
      if (!built.ok) {
        note("fallback", built.reason);
        return inner(context, selectionResult, own);
      }
      const passive = d.standingAggroEnabled === true;
      const sink = passive ? aggroSink() : null;
      if (passive && !sink) {
        note("fallback", REASON_AGGRO_UNAVAILABLE);
        return inner(context, selectionResult, own);
      }
      const selectionID = `${SELECTION_PREFIX}:${factionId}:${data.selectionID || ""}`;
      const selectionName = `${SELECTION_PREFIX}:${factionId}:${data.selectionName || ""}`;
      const navySelection = { ...selectionResult, data: { ...data, definitions: built.definitions, selectionID,
        selectionName } };
      const navyOwn = { ...own, selectionID, selectionName };
      const result = passive
        ? inner({ ...context, preferredTargetID: 0 }, navySelection, { ...navyOwn, preferredTargetID: 0,
          behaviorOverrides: { ...NAVY_PASSIVE_BEHAVIOR } })
        : inner(context, navySelection, navyOwn);
      if (result && result.success === true) {
        if (patrol) note("patrol", REASON_PATROL);
        else note("navy", REASON_NAVY);
        if (sink) registerSpawn(sink, result, own);
      } else note("failed", `SPAWN_${(result && result.errorMsg) || REASON_FAILED}`);
      return result;
    }

    return originalFn.call(this, scene, session, shipEntity, { ...given, ...(shareOn ? {} : { skipSpecialSpawns: true }),
      [OWN_OPTION]: livingNewEdenEmpireBeltInterceptor });
  }

  livingNewEdenEmpireBeltSpawn[WRAPPED_EMPIRE_BELTS] = true;
  return { ok: true, wrapped: livingNewEdenEmpireBeltSpawn };
}

module.exports = { classifyHull, selectNavyProfiles, decideNavy, buildNavyDefinitions, isBeltNavyVictim,
  isSpecialSelection, wrapBeltSpawnForNavy, WRAPPED_EMPIRE_BELTS, REASON_NAVY, SELECTION_PREFIX };
