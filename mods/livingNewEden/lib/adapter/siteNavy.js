"use strict";

const { decideNavy, buildNavyDefinitions, SELECTION_PREFIX } = require("./empireBelts");
const { NAVY_PASSIVE_BEHAVIOR } = require("./data/liveProfiles");

const WRAPPED_SITE_NAVY = Symbol.for("livingNewEden.siteNavyWrapped");
const WRAPPED_SITE_NAVY_ORIGINAL = Symbol.for("livingNewEden.siteNavyOriginal");

const PIRATE_FACTION_KEYS = Object.freeze(["angels", "blood", "guristas", "sanshas", "serpentis"]);
const HULL_CLASSES = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);
const ENCOUNTER_KEY_PREFIX = "instance:";
const SITE_FAMILY = "combat";
const SITE_KIND = "anomaly";
const LNE_EVENT_ORIGIN = "lne_event";
const STRUCTURE_KINDS = Object.freeze(["killablestructure", "combatstructure", "dungeonstructure"]);
const REASON_THREW = "THREW";

function isObject(value) {
  return value !== null && typeof value === "object";
}

function positiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function nonEmptyObject(value) {
  return isObject(value) && Object.keys(value).length > 0;
}

function siteSpawnOf(options) {
  const meta = isObject(options) ? options.entityScopeMetadata : null;
  if (!isObject(meta) || meta.dungeonMaterializedSiteContent !== true) return null;
  const instanceId = positiveInt(meta.dungeonSiteInstanceID);
  if (instanceId === 0) return null;
  const key = meta.dungeonEncounterKey;
  if (typeof key !== "string" || !key.startsWith(ENCOUNTER_KEY_PREFIX)) return null;
  return { instanceId };
}

function eligibleInstance(summary) {
  if (!isObject(summary) || lower(summary.siteFamily) !== SITE_FAMILY || lower(summary.siteKind) !== SITE_KIND) {
    return { ok: false, reason: "NOT_COMBAT_ANOMALY" };
  }
  if (lower(summary.siteOrigin) === LNE_EVENT_ORIGIN) return { ok: false, reason: "LNE_EVENT" };
  const flags = isObject(summary.runtimeFlags) ? summary.runtimeFlags : {};
  if (flags.manualSpawn === true) return { ok: false, reason: "MANUAL" };
  if (flags.universeSeeded !== true) return { ok: false, reason: "NOT_UNIVERSE" };
  const templateId = typeof summary.templateID === "string" || typeof summary.templateID === "number"
    ? String(summary.templateID).trim() : "";
  if (templateId === "") return { ok: false, reason: "NOT_UNIVERSE" };
  return { ok: true, templateId };
}

function isStructureEntry(entry) {
  const kind = lower(entry.entityKind || entry.kind || entry.spawnKind || entry.role).replace(/[^a-z0-9]+/g, "");
  return entry.killableStructure === true || STRUCTURE_KINDS.includes(kind);
}

function checkTemplate(template, factionKeys) {
  if (!isObject(template)) return { ok: false, reason: "NO_TEMPLATE" };
  const hints = isObject(template.populationHints) ? template.populationHints : {};
  if (nonEmptyObject(hints.fetchObjective)) return { ok: false, reason: "IDENTITY_TRIGGER" };
  const completion = isObject(hints.completion) ? hints.completion : {};
  if (Array.isArray(completion.objectiveTargets) ? completion.objectiveTargets.length > 0
    : nonEmptyObject(completion.objectiveTargets)) {
    return { ok: false, reason: "IDENTITY_TRIGGER" };
  }
  let encounters = Array.isArray(hints.encounters) ? hints.encounters.filter(isObject) : [];
  if (encounters.length === 0 && isObject(hints.encounter)) encounters = [hints.encounter];
  if (encounters.length === 0) return { ok: false, reason: "NO_ENCOUNTERS" };
  for (const encounter of encounters) {
    if (nonEmptyObject(encounter.triggerEntity)) return { ok: false, reason: "IDENTITY_TRIGGER" };
    const entries = Array.isArray(encounter.spawnEntries) ? encounter.spawnEntries.filter(isObject) : [];
    if (entries.length === 0) return { ok: false, reason: "PROCEDURAL_WAVE" };
    for (const entry of entries) {
      if (isStructureEntry(entry)) continue;
      if (!HULL_CLASSES.includes(lower(entry.hullClass)) || !factionKeys.includes(lower(entry.factionKey))) {
        return { ok: false, reason: "ENTRY_UNCLASSIFIED" };
      }
    }
  }
  return { ok: true };
}

function recoverDecision(instanceRef, navyTypeIds) {
  const states = isObject(instanceRef) && isObject(instanceRef.spawnState)
    && isObject(instanceRef.spawnState.encounterStatesByKey) ? instanceRef.spawnState.encounterStatesByKey : {};
  let seen = false;
  for (const state of Object.values(states)) {
    const identities = isObject(state) && isObject(state.spawnedIdentitiesByEntityID)
      ? state.spawnedIdentitiesByEntityID : {};
    for (const identity of Object.values(identities)) {
      const typeId = positiveInt(identity && identity.typeID);
      if (typeId === 0) continue;
      if (navyTypeIds.has(typeId)) return "NAVY";
      seen = true;
    }
  }
  return seen ? "PIRATES" : "NONE";
}

function spawnedEntityIds(result) {
  const spawned = result && result.data && result.data.spawned;
  if (!Array.isArray(spawned)) return [];
  return spawned.map((entry) => positiveInt(entry && entry.entity && entry.entity.itemID)).filter((id) => id > 0);
}

const DEP_FUNCTIONS = Object.freeze(["enabled", "readSummary", "readInstanceRef", "readTemplate", "readController",
  "resolveSecurityProfile", "buildNpcDefinition", "resolveNpcBounty", "decideSite", "getAggroSink", "nowMs"]);

function wrapSiteSpawnForNavy(originalFn, deps) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED_SITE_NAVY] === true) {
    return { ok: true, wrapped: originalFn, original: originalFn[WRAPPED_SITE_NAVY_ORIGINAL] || originalFn, noop: true };
  }
  const d = deps || {};
  for (const name of DEP_FUNCTIONS) if (typeof d[name] !== "function") return { ok: false, reason: `DEP_${name}` };
  if (!isObject(d.navyProfiles)) return { ok: false, reason: "NAVY_TABLE_INVALID" };
  if (!(d.navyTypeIds instanceof Set) || d.navyTypeIds.size === 0) return { ok: false, reason: "NAVY_TYPES_EMPTY" };
  if (!Number.isSafeInteger(d.maxTrackedSites) || d.maxTrackedSites <= 0) return { ok: false, reason: "MAX_SITES_INVALID" };
  const onOutcome = typeof d.onOutcome === "function" ? d.onOutcome : null;
  const decisionDeps = Object.freeze({ navyProfiles: d.navyProfiles, readController: d.readController,
    resolveSecurityProfile: d.resolveSecurityProfile });
  const decisions = new Map();
  const templates = new Map();
  const passive = d.standingAggroEnabled === true;

  function note(outcome, reason) {
    if (!onOutcome) return;
    try {
      onOutcome(outcome, reason);
    } catch (_err) {
    }
  }

  function remember(instanceId, decision) {
    if (decisions.size >= d.maxTrackedSites && !decisions.has(instanceId)) {
      decisions.delete(decisions.keys().next().value);
    }
    decisions.set(instanceId, decision);
    return decision;
  }

  function templateCheck(templateId) {
    if (!templates.has(templateId)) templates.set(templateId, checkTemplate(d.readTemplate(templateId), PIRATE_FACTION_KEYS));
    return templates.get(templateId);
  }

  function aggroSink() {
    const sink = d.getAggroSink();
    return sink && typeof sink.canAccept === "function" && sink.canAccept() === true ? sink : null;
  }

  function decide(instanceId, systemId) {
    if (d.rewardsEnabled !== true) {
      note("pirates", "REWARDS_OFF");
      return null;
    }
    const navy = decideNavy(systemId, {}, decisionDeps);
    if (!navy.navy) {
      note("pirates", navy.reason);
      return null;
    }
    const eligible = eligibleInstance(d.readSummary(instanceId));
    if (!eligible.ok) {
      note("pirates", eligible.reason);
      return null;
    }
    const pirates = { navy: false, factionId: navy.factionId, navyProfiles: null, decidedAt: d.nowMs() };
    const template = templateCheck(eligible.templateId);
    if (!template.ok) {
      note("pirates", template.reason);
      return remember(instanceId, pirates);
    }
    const asNavy = { navy: true, factionId: navy.factionId, navyProfiles: navy.navy, decidedAt: pirates.decidedAt };
    const recovered = recoverDecision(d.readInstanceRef(instanceId), d.navyTypeIds);
    if (recovered !== "NONE") {
      note("recovered", recovered);
      return remember(instanceId, recovered === "NAVY" ? asNavy : pirates);
    }
    const roll = d.decideSite({ systemId, factionId: navy.factionId, instanceId, atMs: pirates.decidedAt });
    if (!roll || roll.ok !== true) {
      note("fallback", `ROLL_${(roll && roll.reason) || "NO_RESULT"}`);
      return remember(instanceId, pirates);
    }
    if (roll.navy !== true) {
      note("pirates", "ROLL");
      return remember(instanceId, pirates);
    }
    if (passive && !aggroSink()) {
      note("fallback", "AGGRO_UNAVAILABLE");
      return remember(instanceId, pirates);
    }
    return remember(instanceId, asNavy);
  }

  function register(instanceId, systemId, factionId, result) {
    if (!passive) return;
    let reason;
    try {
      const sink = d.getAggroSink();
      const group = sink ? sink.registerGroup({ spawnSiteId: `site:${instanceId}`, kind: "site", systemId, factionId,
        entityIds: spawnedEntityIds(result), atMs: d.nowMs() }) : { ok: false, reason: "NO_SINK" };
      if (group && group.ok === true) return;
      reason = (group && group.reason) || "NO_RESULT";
    } catch (_err) {
      reason = REASON_THREW;
    }
    note("unwatched", reason);
  }

  function livingNewEdenSiteNavySpawn(context, selectionResult, options) {
    let call = null;
    try {
      if (d.enabled() !== true) return originalFn.apply(this, arguments);
      const site = siteSpawnOf(options);
      if (!site) return originalFn.apply(this, arguments);
      const systemId = positiveInt(context && context.systemID);
      const decision = decisions.has(site.instanceId) ? decisions.get(site.instanceId) : decide(site.instanceId, systemId);
      if (!decision || decision.navy !== true) return originalFn.apply(this, arguments);
      const data = selectionResult && selectionResult.data;
      const rewards = { factionId: decision.factionId, bountyMultiplier: d.bountyMultiplier,
        resolveBounty: d.resolveNpcBounty };
      const built = buildNavyDefinitions(data && data.definitions, decision.navyProfiles, d.buildNpcDefinition, rewards);
      if (!built.ok) {
        note("failed", built.reason);
        return originalFn.apply(this, arguments);
      }
      const selectionID = `${SELECTION_PREFIX}:${decision.factionId}:site:${site.instanceId}`;
      const navySelection = { ...selectionResult, data: { ...data, definitions: built.definitions, selectionID,
        selectionName: selectionID } };
      const navyOptions = { ...options, selectionID, selectionName: selectionID };
      call = { instanceId: site.instanceId, systemId, factionId: decision.factionId, args: passive
        ? [{ ...context, preferredTargetID: 0 }, navySelection, { ...navyOptions, preferredTargetID: 0,
          behaviorOverrides: { ...NAVY_PASSIVE_BEHAVIOR } }]
        : [context, navySelection, navyOptions] };
    } catch (_err) {
      note("failed", REASON_THREW);
      return originalFn.apply(this, arguments);
    }
    const result = originalFn.call(this, call.args[0], call.args[1], call.args[2]);
    try {
      if (result && result.success === true) {
        note("navy", "CONTROLLER_NAVY");
        register(call.instanceId, call.systemId, call.factionId, result);
      } else {
        note("failed", `SPAWN_${(result && result.errorMsg) || "FAILED"}`);
      }
    } catch (_err) {
    }
    return result;
  }

  livingNewEdenSiteNavySpawn[WRAPPED_SITE_NAVY] = true;
  livingNewEdenSiteNavySpawn[WRAPPED_SITE_NAVY_ORIGINAL] = originalFn;
  return { ok: true, wrapped: livingNewEdenSiteNavySpawn, original: originalFn };
}

module.exports = { siteSpawnOf, eligibleInstance, checkTemplate, recoverDecision, wrapSiteSpawnForNavy,
  PIRATE_FACTION_KEYS, WRAPPED_SITE_NAVY };
