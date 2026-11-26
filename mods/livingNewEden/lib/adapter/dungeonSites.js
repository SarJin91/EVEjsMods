"use strict";

const MAX_DETAIL = 120;

const PROVIDER_ID = "livingNewEden";

const SITE_ORIGIN = "lne_event";

const SPAWN_FAMILY_KEY = "lne_event";

const SITE_KEY_PREFIX = "lne:";

const MAX_SITE_KEY_CHARS = 128;

const MANUAL_SITE_ID_BASE = 6_800_000_000_000;

const DUNGEON_TABLE = "dungeonRuntimeState";

const ACTIVE_STATES = Object.freeze(new Set(["seeded", "active", "paused"]));

const TERMINAL_STATES = Object.freeze(new Set(["completed", "failed", "despawned"]));

const VALID_LIFECYCLE_STATES = Object.freeze(new Set([...ACTIVE_STATES, ...TERMINAL_STATES]));

const DESPAWN_REASONS = Object.freeze(new Set(["lne_event_end", "lne_event_failed", "lne_site_id_mismatch"]));

const SPEC_SITE_KINDS = Object.freeze(["anomaly", "signature"]);
const SPEC_SITE_FAMILY = "combat";

const PLACEMENT_DEFAULTS = Object.freeze({
  distanceJitterAu: 0.35,
  verticalJitterAu: 0.14,
});

const VENDOR_ERRORS = Object.freeze({
  DUNGEON_SITE_KEY_IN_USE: "DUNGEON_SITE_KEY_IN_USE",
  DUNGEON_INSTANCE_NOT_FOUND: "DUNGEON_INSTANCE_NOT_FOUND",
  DUNGEON_LIFECYCLE_STATE_REQUIRED: "DUNGEON_LIFECYCLE_STATE_REQUIRED",
});

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function invalidSiteKey(detail) {
  return { ok: false, reason: "SITE_KEY_INVALID", detail };
}

function invalidSpec(detail) {
  return { ok: false, reason: "SITE_SPEC_INVALID", detail };
}

function validateSiteKey(siteKey) {
  if (typeof siteKey !== "string") return false;
  if (siteKey !== siteKey.trim()) return false;
  if (!siteKey.startsWith(SITE_KEY_PREFIX)) return false;
  if (siteKey.length > MAX_SITE_KEY_CHARS) return false;
  return true;
}

function validateSpec(spec) {
  if (!spec || typeof spec !== "object") return "spec";
  if (!validateSiteKey(spec.siteKey)) return "siteKey";
  if (!Number.isSafeInteger(spec.systemId) || spec.systemId <= 0) return "systemId";
  if (!spec.templateId || typeof spec.templateId !== "string" || spec.templateId.trim() !== spec.templateId) return "templateId";
  if (!spec.label || typeof spec.label !== "string" || spec.label.trim() !== spec.label) return "label";
  if (!Number.isSafeInteger(spec.vendorExpiresAtMs) || spec.vendorExpiresAtMs <= 0) return "vendorExpiresAtMs";
  if (!Number.isSafeInteger(spec.nowMs) || spec.nowMs <= 0) return "nowMs";
  if (spec.vendorExpiresAtMs <= spec.nowMs) return "vendorExpiresAtMs<=nowMs";
  if (!spec.eventId || typeof spec.eventId !== "string") return "eventId";
  if (!Number.isSafeInteger(spec.slot) || spec.slot < 0) return "slot";
  if (typeof spec.durable !== "boolean") return "durable";
  if (!Number.isSafeInteger(spec.placementSeed) && typeof spec.placementSeed !== "string") return "placementSeed";
  if (typeof spec.placementBaseDistanceAu !== "number" || !Number.isFinite(spec.placementBaseDistanceAu) || spec.placementBaseDistanceAu <= 0) return "placementBaseDistanceAu";
  if (spec.siteKind !== undefined && spec.siteKind !== null && !SPEC_SITE_KINDS.includes(spec.siteKind)) return "siteKind";
  if (spec.position !== null && spec.position !== undefined) {
    const p = spec.position;
    if (!p || typeof p !== "object") return "position";
    if (typeof p.x !== "number" || typeof p.y !== "number" || typeof p.z !== "number") return "position";
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return "position";
  }
  if (spec.extraContainers !== undefined && !validExtraContainers(spec.extraContainers)) return "extraContainers";
  return null;
}

const EXTRA_CONTAINERS_MAX = 2;
const EXTRA_KEY_RE = /^lne_[a-z0-9_]{1,24}$/;
const EXTRA_LABEL_RE = /^[\x20-\x7e]{1,40}$/;
const EXTRA_ANALYZERS = Object.freeze(["data", "relic"]);
const EXTRA_DIFFICULTY_MAX = 5;
const EXTRA_OFFSET_MAX_M = 20000;
const EXTRA_LOOT_MAX = 4;
const EXTRA_LOOT_QUANTITY_MAX = 1000;
const EXTRA_LOOT_RUNS_MAX = 100;
const CONTAINER_KEY_PREFIX = "container:";

const intIn = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;

function validLootEntry(e) {
  if (!e || typeof e !== "object") return false;
  if (!Number.isSafeInteger(e.typeId) || e.typeId <= 0) return false;
  if (!intIn(e.quantity, 1, EXTRA_LOOT_QUANTITY_MAX)) return false;
  return e.runs === undefined || intIn(e.runs, 1, EXTRA_LOOT_RUNS_MAX);
}

function validExtraContainers(list) {
  if (!Array.isArray(list) || list.length > EXTRA_CONTAINERS_MAX) return false;
  const keys = new Set();
  for (const x of list) {
    if (!x || typeof x !== "object") return false;
    if (typeof x.key !== "string" || !EXTRA_KEY_RE.test(x.key) || keys.has(x.key)) return false;
    keys.add(x.key);
    if (!EXTRA_ANALYZERS.includes(x.analyzer)) return false;
    if (typeof x.label !== "string" || !EXTRA_LABEL_RE.test(x.label) || x.label.trim() !== x.label) return false;
    if (!intIn(x.hackingDifficulty, 0, EXTRA_DIFFICULTY_MAX)) return false;
    if (!intIn(x.offsetMeters, 0, EXTRA_OFFSET_MAX_M)) return false;
    if (!Array.isArray(x.explicitLoot) || x.explicitLoot.length > EXTRA_LOOT_MAX
      || !x.explicitLoot.every(validLootEntry)) return false;
  }
  return true;
}

const isPositiveTypeId = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

function archiveHintsOf(template, extraContainers) {
  const base = template && template.populationHints;
  if (!base || typeof base !== "object" || !Array.isArray(base.containers)) return null;
  const list = base.containers.filter((c) => c && typeof c === "object");
  const archives = [];
  for (const x of extraContainers) {
    const src = list.find((c) => c.analyzer === x.analyzer && Number(c.count) > 0)
      || list.find((c) => EXTRA_ANALYZERS.includes(c.analyzer));
    if (!src || !isPositiveTypeId(src.typeID)) return null;
    const off = src.positionOffset && typeof src.positionOffset === "object" ? src.positionOffset : null;
    archives.push({
      role: x.analyzer,
      analyzer: x.analyzer,
      count: 1,
      typeID: src.typeID,
      roomKey: src.roomKey === undefined ? null : src.roomKey,
      positionOffset: off ? { x: Number(off.x || 0) + x.offsetMeters, y: Number(off.y || 0), z: Number(off.z || 0) }
        : null,
      lootProfile: src.lootProfile === undefined ? null : src.lootProfile,
      lootTags: Array.isArray(src.lootTags) ? [...src.lootTags] : [],
      label: x.label,
      contentKey: `${CONTAINER_KEY_PREFIX}${x.key}`,
      failureNeverDestroys: true,
      hackingDifficulty: x.hackingDifficulty,
      explicitLoot: x.explicitLoot.map((e) => ({ typeID: e.typeId, quantity: e.quantity,
        ...(e.runs ? { runsRemaining: e.runs } : {}) })),
    });
  }
  const hints = structuredClone(base);
  hints.containers = [...archives, ...hints.containers];
  return hints;
}

const hasExtraContainers = (spec) => Array.isArray(spec.extraContainers) && spec.extraContainers.length > 0;

function isOwnSummary(summary, siteKey) {
  if (!summary) return false;
  if (summary.siteKey !== siteKey) return false;
  if (summary.siteOrigin !== SITE_ORIGIN) return false;
  const md = summary.metadata;
  if (!md || typeof md !== "object") return false;
  if (md.providerID !== PROVIDER_ID) return false;
  if (md.lneSiteKey !== siteKey) return false;
  return true;
}

// Ported from dungeonUniverseSiteService.js:8187-8219.
function buildInstanceOptions(spec, template, siteId, position, populationHints) {
  const nowMs = spec.nowMs;
  const hints = hasExtraContainers(spec)
    ? (populationHints === undefined ? archiveHintsOf(template, spec.extraContainers) : populationHints) : null;
  return {
    templateID: spec.templateId,
    solarSystemID: spec.systemId,
    siteKey: spec.siteKey,
    lifecycleState: "active",
    instanceScope: "shared",
    siteFamily: spec.siteKind ? SPEC_SITE_FAMILY : String(template.siteFamily || "unknown").toLowerCase(),
    siteKind: spec.siteKind ? spec.siteKind : String(template.siteKind || "anomaly").toLowerCase(),
    siteOrigin: SITE_ORIGIN,
    position,
    nowMs,
    activatedAtMs: nowMs,
    expiresAtMs: spec.vendorExpiresAtMs,
    spawnState: {
      siteID: siteId,
      label: spec.label,
      entryObjectTypeID: template.entryObjectTypeID || null,
      ...(hints ? { populationHints: hints } : {}),
    },
    runtimeFlags: {
      universeSeeded: true,
      universePersistent: false,
      lazyMaterialized: false,
      manualSpawn: true,
    },
    metadata: {
      providerID: PROVIDER_ID,
      siteID: siteId,
      label: spec.label,
      spawnFamilyKey: SPAWN_FAMILY_KEY,
      lneSiteKey: spec.siteKey,
      lneEventId: spec.eventId,
      lneSlot: spec.slot,
    },
  };
}

function readSiteFrom(mods, siteKey) {
  try {
    if (!validateSiteKey(siteKey)) return invalidSiteKey("format");
    const findFn = mods.dungeonRuntime && mods.dungeonRuntime.findInstanceBySiteKey;
    if (typeof findFn !== "function") return { ok: false, reason: "READ_FAILED", detail: "findInstanceBySiteKey_missing" };
    const summary = findFn(siteKey);
    if (!summary) return { ok: true, state: "missing", vendorState: null, instanceId: null, foreign: false, expiresAtMs: null };
    if (!isOwnSummary(summary, siteKey)) {
      return { ok: true, state: "missing", vendorState: summary.lifecycleState || null, instanceId: summary.instanceID || null, foreign: true, expiresAtMs: (summary.timers && summary.timers.expiresAtMs) || null };
    }
    const lifecycleState = String(summary.lifecycleState || "").toLowerCase();
    let state;
    if (ACTIVE_STATES.has(lifecycleState)) state = "active";
    else if (TERMINAL_STATES.has(lifecycleState)) state = lifecycleState;
    else state = "despawned";
    return {
      ok: true,
      state,
      vendorState: lifecycleState,
      instanceId: summary.instanceID,
      foreign: false,
      expiresAtMs: (summary.timers && summary.timers.expiresAtMs) || null,
    };
  } catch (err) {
    return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
  }
}

function ensureSiteFrom(mods, spec) {
  if (!spec || typeof spec !== "object") return invalidSpec("spec");
  if (!validateSiteKey(spec.siteKey)) return invalidSiteKey("format");

  const specError = validateSpec(spec);
  if (specError && specError !== "siteKey") return invalidSpec(specError);

  const findFn = mods.dungeonRuntime && mods.dungeonRuntime.findInstanceBySiteKey;
  const createFn = mods.dungeonRuntime && mods.dungeonRuntime.createInstance;
  const peekFn = mods.dungeonRuntime && mods.dungeonRuntime.peekNextInstanceID;
  const templateFn = mods.dungeonAuthority && mods.dungeonAuthority.getTemplateByID;
  const flushFn = mods.gameStore && mods.gameStore.flushTableSync;

  if (typeof findFn !== "function" || typeof createFn !== "function" || typeof peekFn !== "function" || typeof templateFn !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "missing_core_functions" };
  }

  const siteKey = spec.siteKey;

  const existing = findFn(siteKey);
  if (existing) {
    if (isOwnSummary(existing, siteKey)) {
      const lifecycleState = String(existing.lifecycleState || "").toLowerCase();
      if (ACTIVE_STATES.has(lifecycleState)) {
        return {
          ok: true,
          adopted: true,
          instanceId: existing.instanceID,
          siteId: (existing.metadata && existing.metadata.siteID) || null,
          position: existing.position,
          durable: null,
          vendorWrites: 0,
        };
      }
      if (TERMINAL_STATES.has(lifecycleState)) {
        return { ok: false, reason: "SITE_TERMINAL", vendorState: lifecycleState };
      }
      return { ok: false, reason: "SITE_TERMINAL", vendorState: lifecycleState };
    }
    return { ok: false, reason: "SITE_FOREIGN", vendorState: existing.lifecycleState || null };
  }

  const template = templateFn(spec.templateId);
  if (!template) return { ok: false, reason: "TEMPLATE_MISSING", detail: spec.templateId };
  const populationHints = hasExtraContainers(spec) ? archiveHintsOf(template, spec.extraContainers) : null;
  if (hasExtraContainers(spec) && !populationHints) return invalidSpec("extraContainers");

  let position;
  if (spec.position) {
    position = { x: spec.position.x, y: spec.position.y, z: spec.position.z };
  } else {
    const planResult = planPositionFrom(mods, spec.systemId, template.siteFamily, spec.placementSeed, spec.placementBaseDistanceAu);
    if (!planResult.ok) return planResult;
    position = planResult.position;
  }

  const guess = peekFn();
  const siteId = MANUAL_SITE_ID_BASE + guess;

  let created;
  try {
    const options = buildInstanceOptions(spec, template, siteId, position, populationHints);
    created = createFn(options);
  } catch (err) {
    const errCode = err && err.code;
    if (errCode === VENDOR_ERRORS.DUNGEON_SITE_KEY_IN_USE) {
      const retry = findFn(siteKey);
      if (retry && isOwnSummary(retry, siteKey) && ACTIVE_STATES.has(String(retry.lifecycleState || "").toLowerCase())) {
        return {
          ok: true,
          adopted: true,
          instanceId: retry.instanceID,
          siteId: (retry.metadata && retry.metadata.siteID) || null,
          position: retry.position,
          durable: null,
          vendorWrites: 0,
        };
      }
      return { ok: false, reason: "SITE_FOREIGN", vendorState: retry ? retry.lifecycleState : null };
    }
    return { ok: false, reason: "CREATE_FAILED", detail: errCode || messageOf(err) };
  }

  if (created.instanceID !== guess) {
    return {
      ok: false,
      reason: "SITE_ID_MISMATCH",
      instanceId: created.instanceID,
      detail: `expected ${guess}, got ${created.instanceID}`,
      vendorWrites: 1,
    };
  }

  let durable = null;
  if (spec.durable && flushFn) {
    try {
      const result = flushFn(DUNGEON_TABLE);
      durable = result && result.success === true;
    } catch (_err) {
      durable = false;
    }
  }

  return {
    ok: true,
    adopted: false,
    instanceId: created.instanceID,
    siteId: siteId,
    position,
    durable,
    vendorWrites: 1,
  };
}

function extendSiteFrom(mods, siteKey, vendorExpiresAtMs, nowMs) {
  try {
    if (!validateSiteKey(siteKey)) return invalidSiteKey("format");
    if (!Number.isSafeInteger(vendorExpiresAtMs) || vendorExpiresAtMs <= 0) return { ok: false, reason: "EXTEND_FAILED", detail: "vendorExpiresAtMs" };
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return { ok: false, reason: "EXTEND_FAILED", detail: "nowMs" };

    const findFn = mods.dungeonRuntime && mods.dungeonRuntime.findInstanceBySiteKey;
    const setFn = mods.dungeonRuntime && mods.dungeonRuntime.setLifecycleState;
    if (typeof findFn !== "function" || typeof setFn !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "missing_core_functions" };
    }

    const summary = findFn(siteKey);
    if (!summary || !isOwnSummary(summary, siteKey)) {
      return { ok: true, extended: false, state: summary ? "foreign" : "missing", vendorWrites: 0 };
    }

    const lifecycleState = String(summary.lifecycleState || "").toLowerCase();
    if (!ACTIVE_STATES.has(lifecycleState)) {
      return { ok: true, extended: false, state: lifecycleState, vendorWrites: 0 };
    }

    const currentExpires = (summary.timers && summary.timers.expiresAtMs) || 0;
    if (currentExpires === vendorExpiresAtMs) {
      return { ok: true, extended: false, state: lifecycleState, vendorWrites: 0 };
    }

    setFn(summary.instanceID, "active", {
      expiresAtMs: vendorExpiresAtMs,
      nowMs,
      lifecycleReason: "lne_event_extend",
    });

    return { ok: true, extended: true, state: "active", vendorWrites: 1 };
  } catch (err) {
    return { ok: false, reason: "EXTEND_FAILED", detail: messageOf(err) };
  }
}

function positiveIntOrNull(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function siteIdOfSummary(summary) {
  return positiveIntOrNull(summary && summary.metadata && summary.metadata.siteID);
}

function teardownParkedOf(mods, systemId, instanceId) {
  const fn = mods.siteService && mods.siteService.isUniverseSiteTeardownParked;
  if (typeof fn !== "function" || systemId === null || !instanceId) return false;
  try {
    return fn(systemId, instanceId) === true;
  } catch (_err) {
    return false;
  }
}

function despawnSiteFrom(mods, siteKey, reason, nowMs) {
  try {
    if (!validateSiteKey(siteKey)) return invalidSiteKey("format");
    if (!DESPAWN_REASONS.has(reason)) return { ok: false, reason: "DESPAWN_FAILED", detail: "invalid_reason" };
    if (!Number.isSafeInteger(nowMs) || nowMs <= 0) return { ok: false, reason: "DESPAWN_FAILED", detail: "nowMs" };

    const findFn = mods.dungeonRuntime && mods.dungeonRuntime.findInstanceBySiteKey;
    const setFn = mods.dungeonRuntime && mods.dungeonRuntime.setLifecycleState;
    if (typeof findFn !== "function" || typeof setFn !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "missing_core_functions" };
    }

    const summary = findFn(siteKey);
    if (!summary || !isOwnSummary(summary, siteKey)) {
      return { ok: true, already: true, instanceId: summary ? summary.instanceID : null, systemId: null, siteId: null,
        parked: false, vendorWrites: 0 };
    }

    const systemId = positiveIntOrNull(summary.solarSystemID);
    const siteId = siteIdOfSummary(summary);
    const lifecycleState = String(summary.lifecycleState || "").toLowerCase();
    if (!ACTIVE_STATES.has(lifecycleState)) {
      return { ok: true, already: true, instanceId: summary.instanceID, systemId, siteId,
        parked: teardownParkedOf(mods, systemId, summary.instanceID), vendorWrites: 0 };
    }

    setFn(summary.instanceID, "despawned", {
      lifecycleReason: reason,
      nowMs,
    });

    return { ok: true, already: false, instanceId: summary.instanceID, systemId, siteId,
      parked: teardownParkedOf(mods, systemId, summary.instanceID), vendorWrites: 1 };
  } catch (err) {
    const errCode = err && err.code;
    if (errCode === VENDOR_ERRORS.DUNGEON_INSTANCE_NOT_FOUND) {
      return { ok: true, already: true, instanceId: null, systemId: null, siteId: null, parked: false,
        vendorWrites: 0 };
    }
    return { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
  }
}

function purgeSiteFrom(mods, siteKey, systemId) {
  try {
    if (!validateSiteKey(siteKey)) return invalidSiteKey("format");
    if (!Number.isSafeInteger(systemId) || systemId <= 0) return { ok: false, reason: "PURGE_FAILED", detail: "systemId" };

    const findFn = mods.dungeonRuntime && mods.dungeonRuntime.findInstanceBySiteKey;
    const purgeFn = mods.dungeonRuntime && mods.dungeonRuntime.purgeInstance;
    const teardownFn = mods.siteService && mods.siteService.isUniverseSiteTeardownParked;
    if (typeof findFn !== "function" || typeof purgeFn !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "missing_core_functions" };
    }

    const summary = findFn(siteKey);
    if (!summary || !isOwnSummary(summary, siteKey)) {
      return { ok: true, purged: false, deferred: false, vendorWrites: 0 };
    }

    const lifecycleState = String(summary.lifecycleState || "").toLowerCase();
    if (ACTIVE_STATES.has(lifecycleState)) {
      return { ok: false, reason: "SITE_STILL_ACTIVE", detail: lifecycleState };
    }

    let deferred = false;
    if (typeof teardownFn === "function") {
      try {
        deferred = teardownFn(systemId, summary.instanceID) === true;
      } catch (_err) {
        deferred = false;
      }
    }

    if (deferred) {
      return { ok: true, purged: false, deferred: true, vendorWrites: 0 };
    }

    try {
      purgeFn(summary.instanceID);
      return { ok: true, purged: true, deferred: false, siteId: siteIdOfSummary(summary), vendorWrites: 1 };
    } catch (err) {
      const errCode = err && err.code;
      if (errCode === VENDOR_ERRORS.DUNGEON_INSTANCE_NOT_FOUND) {
        return { ok: true, purged: false, deferred: false, vendorWrites: 0 };
      }
      return { ok: false, reason: "PURGE_FAILED", detail: messageOf(err) };
    }
  } catch (err) {
    return { ok: false, reason: "PURGE_FAILED", detail: messageOf(err) };
  }
}

function checkTemplatesFrom(mods, templateIds) {
  try {
    const templateFn = mods.dungeonAuthority && mods.dungeonAuthority.getTemplateByID;
    if (typeof templateFn !== "function") {
      return { ok: false, reason: "CHECK_FAILED", detail: "getTemplateByID_missing" };
    }
    const ids = Array.isArray(templateIds) ? templateIds : [];
    const missing = [];
    for (const id of ids) {
      if (id && typeof id === "string") {
        const t = templateFn(id);
        if (!t) missing.push(id);
      }
    }
    return { ok: true, missing };
  } catch (err) {
    return { ok: false, reason: "CHECK_FAILED", detail: messageOf(err) };
  }
}

function planPositionFrom(mods, systemId, siteFamily, seed, baseDistanceAu) {
  try {
    if (!Number.isSafeInteger(systemId) || systemId <= 0) return { ok: false, reason: "SYSTEM_UNKNOWN" };
    if (!siteFamily || typeof siteFamily !== "string") return { ok: false, reason: "SYSTEM_UNKNOWN" };
    if (typeof seed !== "string" && !Number.isSafeInteger(seed)) return { ok: false, reason: "SYSTEM_UNKNOWN" };
    if (typeof baseDistanceAu !== "number" || !Number.isFinite(baseDistanceAu) || baseDistanceAu <= 0) return { ok: false, reason: "SYSTEM_UNKNOWN" };

    const worldData = mods.worldData;
    const placement = mods.placement;

    const getCelestials = worldData && worldData.getCelestialsForSystem;
    const getBelts = worldData && worldData.getAsteroidBeltsForSystem;
    const getStations = worldData && worldData.getStationsForSystem;
    const getStargates = worldData && worldData.getStargatesForSystem;
    const getSystem = worldData && worldData.getSolarSystemByID;
    const buildPlacement = placement && placement.buildAnchorRelativeSignaturePlacement;

    if (typeof getCelestials !== "function" || typeof getBelts !== "function" ||
        typeof getStations !== "function" || typeof getStargates !== "function" ||
        typeof getSystem !== "function" || typeof buildPlacement !== "function") {
      return { ok: false, reason: "SYSTEM_UNKNOWN" };
    }

    const normalizedFamily = String(siteFamily).toLowerCase();
    const belts = (getBelts(systemId) || [])
      .map((belt) => ({
        itemID: belt && belt.itemID ? Math.max(0, Math.trunc(belt.itemID)) : 0,
        position: extractStaticPosition(belt),
      }))
      .filter((entry) => entry.itemID > 0);

    const celestials = (getCelestials(systemId) || [])
      .filter((celestial) => (celestial && celestial.groupID) ? Math.max(0, Math.trunc(celestial.groupID)) !== 6 : true)
      .map((celestial) => ({
        itemID: celestial && celestial.itemID ? Math.max(0, Math.trunc(celestial.itemID)) : 0,
        position: extractStaticPosition(celestial),
      }))
      .filter((entry) => entry.itemID > 0);

    const stations = (getStations(systemId) || [])
      .map((station) => ({
        itemID: station && station.stationID ? Math.max(0, Math.trunc(station.stationID)) : 0,
        position: extractStaticPosition(station),
      }))
      .filter((entry) => entry.itemID > 0);

    const stargates = (getStargates(systemId) || [])
      .map((stargate) => ({
        itemID: stargate && stargate.itemID ? Math.max(0, Math.trunc(stargate.itemID)) : 0,
        position: extractStaticPosition(stargate),
      }))
      .filter((entry) => entry.itemID > 0);

    let ordered;
    if (normalizedFamily === "ore" || normalizedFamily === "gas") {
      ordered = [...belts, ...celestials, ...stations, ...stargates];
    } else {
      ordered = [...celestials, ...belts, ...stations, ...stargates];
    }

    let anchorCandidates = ordered;

    if (anchorCandidates.length === 0) {
      const systemRecord = getSystem(systemId);
      if (!systemRecord) return { ok: false, reason: "SYSTEM_UNKNOWN" };
      const fallbackRadius = Math.max(
        1_000_000_000,
        Math.round((systemRecord && systemRecord.radius ? Math.max(0, systemRecord.radius) : 0) * 0.25)
      );
      anchorCandidates = [{
        itemID: systemId,
        position: { x: fallbackRadius, y: 0, z: 0 },
      }];
    }

    const placementResult = buildPlacement(anchorCandidates, String(seed), {
      fallbackAnchorItemID: systemId,
      baseDistanceAu,
      distanceJitterAu: PLACEMENT_DEFAULTS.distanceJitterAu,
      verticalJitterAu: PLACEMENT_DEFAULTS.verticalJitterAu,
    });

    const position = placementResult && placementResult.position;
    if (!position || typeof position.x !== "number" || typeof position.y !== "number" || typeof position.z !== "number") {
      return { ok: false, reason: "SYSTEM_UNKNOWN" };
    }

    return { ok: true, position: { x: position.x, y: position.y, z: position.z } };
  } catch (err) {
    return { ok: false, reason: "SYSTEM_UNKNOWN", detail: messageOf(err) };
  }
}

function extractStaticPosition(record) {
  const position = (record && record.position && typeof record.position === "object")
    ? record.position
    : record;
  const axis = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    x: axis(position && position.x),
    y: axis(position && position.y),
    z: axis(position && position.z),
  };
}

module.exports = {
  PROVIDER_ID,
  SITE_ORIGIN,
  SPAWN_FAMILY_KEY,
  SITE_KEY_PREFIX,
  MAX_SITE_KEY_CHARS,
  MANUAL_SITE_ID_BASE,
  DUNGEON_TABLE,
  ACTIVE_STATES,
  TERMINAL_STATES,
  VALID_LIFECYCLE_STATES,
  DESPAWN_REASONS,
  PLACEMENT_DEFAULTS,
  VENDOR_ERRORS,

  isOwnSummary,
  buildInstanceOptions,
  ensureSiteFrom,
  readSiteFrom,
  extendSiteFrom,
  despawnSiteFrom,
  purgeSiteFrom,
  checkTemplatesFrom,
  planPositionFrom,
  validateSiteKey,
  validateSpec,
  extractStaticPosition,
  archiveHintsOf,
};