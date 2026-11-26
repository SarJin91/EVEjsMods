"use strict";

const { deriveSeed, createRng, deterministicUnit } = require("../util/rng");

function requireUint(name, v) {
  if (!Number.isInteger(v) || v < 0) {
    throw new TypeError(`${name} must be a non-negative integer, got ${String(v)}`);
  }
  return v;
}

function requirePositiveInt(name, v) {
  if (!Number.isInteger(v) || v <= 0) {
    throw new TypeError(`${name} must be a positive integer, got ${String(v)}`);
  }
  return v;
}

function requireUint32(name, v) {
  if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) {
    throw new TypeError(`${name} must be a uint32, got ${String(v)}`);
  }
  return v >>> 0;
}

function deepFreeze(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    obj.forEach(deepFreeze);
    return Object.freeze(obj);
  }
  Object.values(obj).forEach(deepFreeze);
  return Object.freeze(obj);
}

function chooseEvents(context) {
  try {
    requireUint32("context.seed", context.seed);
    requireUint("context.now", context.now);
    requireUint("context.round", context.round);
    requirePositiveInt("context.intervalMs", context.intervalMs);

    if (!context.catalog || !Array.isArray(context.catalog.types)) {
      throw new TypeError("context.catalog missing");
    }

    if (!Array.isArray(context.excludedRegionIds)) {
      throw new TypeError("context.excludedRegionIds must be array");
    }

    const limits = context.limits;
    if (!limits || typeof limits !== "object") {
      throw new TypeError("context.limits missing");
    }
    requirePositiveInt("limits.maxNewEventsPerPass", limits.maxNewEventsPerPass);
    requireUint("limits.maxOpenEvents", limits.maxOpenEvents);
    requirePositiveInt("limits.maxOpenEventsPerSystem", limits.maxOpenEventsPerSystem);
    requireUint("limits.maxNewSitesPerSystemPerWindow", limits.maxNewSitesPerSystemPerWindow);
    requirePositiveInt("limits.siteWindowMs", limits.siteWindowMs);
    requireUint("limits.presenceRadius", limits.presenceRadius);
    requireUint("limits.presenceBonus", limits.presenceBonus);
    requireUint("limits.maxSkipped", limits.maxSkipped);
    if (limits.maxUnobservedOpen !== undefined && limits.maxUnobservedOpen !== null) {
      requireUint("limits.maxUnobservedOpen", limits.maxUnobservedOpen);
      requireUint("limits.observeRadius", limits.observeRadius);
    } else if (limits.observeRadius !== undefined) {
      requireUint("limits.observeRadius", limits.observeRadius);
    }
    if (context.openUnobserved !== undefined) requireUint("context.openUnobserved", context.openUnobserved);

    if (!Array.isArray(context.candidates)) {
      throw new TypeError("context.candidates must be array");
    }
    if (!Array.isArray(context.openEvents)) {
      throw new TypeError("context.openEvents must be array");
    }
    if (!Array.isArray(context.recent)) {
      throw new TypeError("context.recent must be array");
    }
    if (typeof context.recentTruncated !== "boolean") {
      throw new TypeError("context.recentTruncated must be boolean");
    }

    const seenSystems = new Set();
    for (const c of context.candidates) {
      if (!Number.isInteger(c.systemId) || c.systemId <= 0) {
        throw new TypeError("candidate.systemId must be positive integer");
      }
      if (seenSystems.has(c.systemId)) {
        throw new TypeError(`duplicate systemId in candidates: ${c.systemId}`);
      }
      seenSystems.add(c.systemId);
      if (!c.causes || !Array.isArray(c.causes)) {
        throw new TypeError("candidate.causes must be array");
      }
      for (const cause of c.causes) {
        if (!cause.cause || !Number.isInteger(cause.factionId)) {
          throw new TypeError("cause must have cause string and factionId integer");
        }
        if (cause.opponents !== undefined
          && (!Array.isArray(cause.opponents) || !cause.opponents.every((f) => Number.isInteger(f)))) {
          throw new TypeError("cause.opponents must be an array of integers");
        }
      }
    }

    for (const o of context.openEvents) {
      if (!Number.isInteger(o.systemId) || !o.eventType) {
        throw new TypeError("openEvent must have systemId and eventType");
      }
    }

    for (const r of context.recent) {
      if (!Number.isInteger(r.systemId) || !r.eventType || !Number.isInteger(r.createdAt) || !Number.isInteger(r.spawnBudget)) {
        throw new TypeError("recent entry must have systemId, eventType, createdAt, spawnBudget");
      }
    }
  } catch (err) {
    return { ok: false, reason: "CONTEXT_INVALID", detail: String(err) };
  }

  if (context.recentTruncated) {
    return { ok: false, reason: "RECENT_TRUNCATED" };
  }

  const { now, seed, round, intervalMs, catalog, excludedRegionIds, limits, candidates, openEvents, recent } = context;
  const { maxNewEventsPerPass, maxOpenEvents, maxOpenEventsPerSystem, maxNewSitesPerSystemPerWindow, siteWindowMs, presenceRadius, presenceBonus, maxSkipped } = limits;
  const maxUnobservedOpen = limits.maxUnobservedOpen === undefined ? null : limits.maxUnobservedOpen;
  const observeRadius = limits.observeRadius === undefined ? 0 : limits.observeRadius;
  const openUnobserved = context.openUnobserved === undefined ? 0 : context.openUnobserved;

  const room = Math.min(maxNewEventsPerPass, maxOpenEvents - openEvents.length);
  if (room <= 0) {
    return {
      ok: true,
      plans: [],
      skipped: [],
      skippedByReason: { OPEN_LIMIT: 1 },
      considered: 0,
    };
  }

  const openBySystem = new Map();
  for (const o of openEvents) {
    openBySystem.set(o.systemId, (openBySystem.get(o.systemId) || 0) + 1);
  }

  const openKeys = new Set();
  for (const o of openEvents) {
    openKeys.add(`${o.systemId}:${o.eventType}`);
  }

  const lastCreated = new Map();
  for (const r of recent) {
    const key = `${r.systemId}:${r.eventType}`;
    const existing = lastCreated.get(key) || 0;
    if (r.createdAt > existing) {
      lastCreated.set(key, r.createdAt);
    }
  }

  const windowStart = now - siteWindowMs;
  const windowUsed = new Map();
  for (const r of recent) {
    if (r.createdAt > windowStart) {
      windowUsed.set(r.systemId, (windowUsed.get(r.systemId) || 0) + r.spawnBudget);
    }
  }

  const options = [];
  let considered = 0;

  const sortedCandidates = [...candidates].sort((a, b) => a.systemId - b.systemId);

  for (const candidate of sortedCandidates) {
    const { systemId, securityClass, regionId, causes, observedDistance } = candidate;

    if (regionId !== null && excludedRegionIds.includes(regionId)) {
      for (const cause of causes) {
        considered++;
        options.push({
          systemId,
          eventType: null,
          cause: cause.cause,
          factionId: cause.factionId,
          campaignId: cause.campaignId,
          occupationState: cause.occupationState,
          reason: "REGION_EXCLUDED",
          score: 0,
          tie: 0,
          type: null,
          slots: 0,
          cooldownMs: 0,
          durationMs: 0,
          aftermathMs: 0,
          windowUsed: windowUsed.get(systemId) || 0,
        });
      }
      continue;
    }

    for (const cause of causes) {
      considered++;
      const matchingTypes = catalog.types.filter((t) => t.cause === cause.cause
        && (!t.causeFactions || t.causeFactions.includes(cause.factionId)));
      const opponents = Array.isArray(cause.opponents) ? cause.opponents : [];

      if (matchingTypes.length === 0) {
        options.push({
          systemId,
          eventType: null,
          cause: cause.cause,
          factionId: cause.factionId,
          campaignId: cause.campaignId,
          occupationState: cause.occupationState,
          reason: "NO_TEMPLATE",
          score: 0,
          tie: 0,
          type: null,
          slots: 0,
          cooldownMs: 0,
          durationMs: 0,
          aftermathMs: 0,
          windowUsed: windowUsed.get(systemId) || 0,
        });
        continue;
      }

      for (const type of matchingTypes) {
        if (!type.securityClasses.includes(securityClass)) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "SEC_CLASS",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: windowUsed.get(systemId) || 0,
          });
          continue;
        }

        if (!type.startStates.includes(cause.occupationState)) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "STATE_MISMATCH",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: windowUsed.get(systemId) || 0,
          });
          continue;
        }

        const hasTemplates = (f) => Array.isArray(type.templatesByFaction[f]) && type.templatesByFaction[f].length > 0;
        const contentFactionId = type.content === "OPPONENT"
          ? (opponents.find(hasTemplates) || null)
          : type.content === "NEUTRAL" ? (hasTemplates(0) ? 0 : null)
            : (hasTemplates(cause.factionId) ? cause.factionId : null);
        if (contentFactionId === null) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "NO_TEMPLATE",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: windowUsed.get(systemId) || 0,
          });
          continue;
        }

        const openKey = `${systemId}:${type.eventType}`;
        if (openKeys.has(openKey)) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "DUPLICATE",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: windowUsed.get(systemId) || 0,
          });
          continue;
        }

        const openCount = openBySystem.get(systemId) || 0;
        if (openCount >= maxOpenEventsPerSystem) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "SYSTEM_BUSY",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: windowUsed.get(systemId) || 0,
          });
          continue;
        }

        const lastCreatedAt = lastCreated.get(openKey) || 0;
        if (lastCreatedAt + type.cooldownMs > now) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "COOLDOWN",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: windowUsed.get(systemId) || 0,
          });
          continue;
        }

        const used = windowUsed.get(systemId) || 0;
        if (used + type.slots > maxNewSitesPerSystemPerWindow) {
          options.push({
            systemId,
            eventType: type.eventType,
            cause: cause.cause,
            factionId: cause.factionId,
            campaignId: cause.campaignId,
            occupationState: cause.occupationState,
            reason: "WINDOW_FULL",
            score: 0,
            tie: 0,
            type,
            slots: type.slots,
            cooldownMs: type.cooldownMs,
            durationMs: type.durationMs,
            aftermathMs: type.aftermathMs,
            windowUsed: used,
          });
          continue;
        }

        let score = type.weight;
        let presenceBonusApplied = false;
        if (observedDistance !== null && observedDistance <= presenceRadius) {
          score = score * (1000 + presenceBonus) / 1000;
          presenceBonusApplied = true;
        }

        const tie = deterministicUnit(seed, systemId, type.eventType);

        options.push({
          systemId,
          eventType: type.eventType,
          cause: cause.cause,
          factionId: cause.factionId,
          campaignId: cause.campaignId,
          occupationState: cause.occupationState,
          reason: null,
          score,
          tie,
          type,
          slots: type.slots,
          cooldownMs: type.cooldownMs,
          durationMs: type.durationMs,
          aftermathMs: type.aftermathMs,
          windowUsed: used,
          presenceBonusApplied,
          observedDistance,
          contentFactionId,
        });
      }
    }
  }

  const passed = options.filter((o) => o.reason === null);
  const failed = options.filter((o) => o.reason !== null);

  passed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.tie !== a.tie) return b.tie - a.tie;
    if (a.systemId !== b.systemId) return a.systemId - b.systemId;
    return a.eventType.localeCompare(b.eventType);
  });

  const plans = [];
  const selectedSystems = new Set();
  const skipped = [];
  const skippedByReason = {};

  function addSkipped(reason, systemId, eventType) {
    skipped.push({ systemId, eventType, reason });
    skippedByReason[reason] = (skippedByReason[reason] || 0) + 1;
  }

  for (const opt of failed) {
    addSkipped(opt.reason, opt.systemId, opt.eventType);
  }

  let rank = 0;
  let selectedUnobserved = 0;
  for (const opt of passed) {
    if (plans.length >= room) {
      addSkipped("ROOM", opt.systemId, opt.eventType);
      continue;
    }
    if (selectedSystems.has(opt.systemId)) {
      addSkipped("PASS_SYSTEM_TAKEN", opt.systemId, opt.eventType);
      continue;
    }
    const observed = opt.observedDistance !== null && opt.observedDistance <= observeRadius;
    if (maxUnobservedOpen !== null && !observed) {
      if (openUnobserved + selectedUnobserved >= maxUnobservedOpen) {
        addSkipped("NOT_OBSERVED", opt.systemId, opt.eventType);
        continue;
      }
      selectedUnobserved++;
    }

    rank++;
    selectedSystems.add(opt.systemId);

    const planKey = `${intervalMs}:${round}:${opt.systemId}:${opt.eventType}`;
    const planSeed = deriveSeed(seed, planKey);
    const rng = createRng(planSeed);

    const factionTemplates = opt.type.templatesByFaction[opt.contentFactionId];
    const availableTemplates = [...factionTemplates];
    const templateIds = [];
    for (let i = 0; i < opt.slots && availableTemplates.length > 0; i++) {
      const idx = rng.nextInt(0, availableTemplates.length - 1);
      templateIds.push(availableTemplates.splice(idx, 1)[0]);
    }

    const factionLabel = catalog.factionLabels ? catalog.factionLabels[opt.contentFactionId] : undefined;
    const label = typeof factionLabel === "string" ? `${factionLabel} ${opt.type.labelNoun}` : opt.type.labelNoun;

    const plan = Object.freeze({
      planKey,
      eventType: opt.eventType,
      catalogVersion: catalog.version,
      systemId: opt.systemId,
      factionId: opt.factionId,
      contentFactionId: opt.contentFactionId,
      campaignId: opt.campaignId,
      cause: opt.cause,
      templateIds: Object.freeze(templateIds),
      label,
      spawnBudget: opt.slots,
      score: opt.score,
      dueAt: now,
      expiresAt: now + opt.durationMs,
      aftermathMs: opt.aftermathMs,
      seed: planSeed,
      reason: Object.freeze({
        cause: opt.cause,
        occupationState: opt.occupationState,
        campaignId: opt.campaignId,
        factionId: opt.factionId,
        contentFactionId: opt.contentFactionId,
        weight: opt.type.weight,
        score: opt.score,
        observedDistance: opt.observedDistance,
        presenceBonusApplied: opt.presenceBonusApplied,
        windowUsed: opt.windowUsed,
        windowMax: maxNewSitesPerSystemPerWindow,
        cooldownMs: opt.cooldownMs,
        rank,
        options: passed.length,
      }),
    });

    plans.push(plan);
  }

  const finalSkipped = skipped.slice(0, maxSkipped);

  return {
    ok: true,
    plans: Object.freeze(plans),
    skipped: Object.freeze(finalSkipped),
    skippedByReason: Object.freeze(skippedByReason),
    considered,
  };
}

module.exports = {
  chooseEvents,
};