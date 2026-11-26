"use strict";

const {
  CATALOG_VERSION,
  CAUSE,
  CONTENT,
  FACTION_LABELS,
  DENIED_TEMPLATE_IDS,
  SECURITY_CLASSES,
  OCCUPATION_STATES,
  EVENT_CATALOG,
  REWARD_PROFILES,
  REWARD_FACTIONS,
  REWARD_EVENT_CATALOG,
  ANOMALY_EVENT_CATALOG,
  NEUTRAL_CONTENT_KEY,
  RICH_VEIN_EVENT_CATALOG,
  MOON_VEIN_TEMPLATES,
  DEVELOPED_EVENT_CATALOG,
  rewardLootIdOf,
} = require("./data/eventCatalog");

const { CLAIM_STATES, HELD_STATES } = require("../world/occupation/schema");

const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]{2,31}$/;
const TEMPLATE_ID_PATTERN = /^(client-dungeon:\d+|evejs-mod:moon-ore:r(4|8|16|32|64):v\d+)$/;

const MIN_WEIGHT = 1;
const MAX_WEIGHT = 100;
const MIN_SLOTS = 1;
const MAX_SLOTS = 4;
const MIN_DURATION_MS = 600000;
const MAX_DURATION_MS = 604800000;
const MAX_COOLDOWN_MS = 2592000000;
const MAX_LABEL_LENGTH = 64;

const REWARD_LOOT_ID_PATTERN = /^[a-z0-9_]{3,48}$/;
const REWARD_LOOT_ID_SIZE_SUFFIX = /_(small|medium|large)$/;
const REWARD_LOOT_ID_DENIED_PARTS = Object.freeze(["_officer", "belt_commander"]);

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function rewardLootIdIssue(id) {
  if (typeof id !== "string" || !REWARD_LOOT_ID_PATTERN.test(id)) return "pattern";
  if (REWARD_LOOT_ID_SIZE_SUFFIX.test(id)) return "size_suffix";
  if (REWARD_LOOT_ID_DENIED_PARTS.some((part) => id.includes(part))) return "denied_part";
  return null;
}

function rewardErrors(entry, prefix) {
  if (entry.reward === undefined) return [];
  if (typeof entry.reward !== "string" || !hasOwn(REWARD_PROFILES, entry.reward)) {
    return [`${prefix}.reward must be one of ${Object.keys(REWARD_PROFILES).join(", ")}`];
  }
  const out = [];
  const templatesByFaction = entry.templatesByFaction;
  if (!templatesByFaction || typeof templatesByFaction !== "object") return out;
  for (const factionId of Object.keys(templatesByFaction)) {
    if (!hasOwn(REWARD_FACTIONS, factionId)) {
      out.push(`${prefix}.reward faction without prefixes: ${factionId}`);
      continue;
    }
    const id = rewardLootIdOf(entry.reward, factionId);
    const issue = rewardLootIdIssue(id);
    if (issue) out.push(`${prefix}.reward loot id ${id} refused (${issue})`);
  }
  return out;
}

function validateCatalog(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, reason: "CATALOG_INVALID", errors: ["catalog must be an array"] };
  }

  const errors = [];
  const seenTypes = new Set();
  const deniedSet = new Set(DENIED_TEMPLATE_IDS);
  const factionLabelKeys = Object.keys(FACTION_LABELS).map(Number);
  const causeValues = Object.values(CAUSE);
  const CONTENT_VALUES = Object.values(CONTENT);
  const validStartStates = new Set(OCCUPATION_STATES);
  const validSecClasses = new Set(SECURITY_CLASSES);

  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const prefix = `catalog[${i}]`;

    if (!entry || typeof entry !== "object") {
      errors.push(`${prefix}: must be an object`);
      continue;
    }

    const eventType = entry.eventType;
    if (typeof eventType !== "string" || !EVENT_TYPE_PATTERN.test(eventType)) {
      errors.push(`${prefix}.eventType must match ${EVENT_TYPE_PATTERN}`);
    } else if (seenTypes.has(eventType)) {
      errors.push(`${prefix}.eventType duplicate: ${eventType}`);
    } else {
      seenTypes.add(eventType);
    }

    const cause = entry.cause;
    if (!causeValues.includes(cause)) {
      errors.push(`${prefix}.cause must be one of ${causeValues.join(", ")}`);
    }

    const startStates = entry.startStates;
    if (!Array.isArray(startStates) || startStates.length === 0) {
      errors.push(`${prefix}.startStates must be a non-empty array`);
    } else {
      for (const state of startStates) {
        if (!validStartStates.has(state)) {
          errors.push(`${prefix}.startStates contains unknown state: ${state}`);
        }
      }
      if (cause === CAUSE.OCCUPATION_CLAIM) {
        for (const state of startStates) {
          if (!CLAIM_STATES.includes(state)) {
            errors.push(`${prefix}.startStates for OCCUPATION_CLAIM must be subset of CLAIM_STATES, got ${state}`);
          }
        }
      } else if (cause === CAUSE.OCCUPATION_HELD) {
        for (const state of startStates) {
          if (!HELD_STATES.includes(state)) {
            errors.push(`${prefix}.startStates for OCCUPATION_HELD must be subset of HELD_STATES, got ${state}`);
          }
        }
      } else if (cause === CAUSE.CAMPAIGN_THEATRE) {
        for (const state of startStates) {
          if (state !== "STABLE") {
            errors.push(`${prefix}.startStates for CAMPAIGN_THEATRE must be ["STABLE"], got ${state}`);
          }
        }
      } else if (cause === CAUSE.LIBERATED || cause === CAUSE.DEVELOPED_INDUSTRY
        || cause === CAUSE.DEVELOPED_MILITARY) {
        for (const state of startStates) {
          if (state !== "STABLE") {
            errors.push(`${prefix}.startStates for ${cause} must be ["STABLE"], got ${state}`);
          }
        }
      } else if (cause === CAUSE.FRONT_LINE) {
        for (const state of startStates) {
          if (!CLAIM_STATES.includes(state)) {
            errors.push(`${prefix}.startStates for FRONT_LINE must be subset of CLAIM_STATES, got ${state}`);
          }
        }
      }
    }

    const securityClasses = entry.securityClasses;
    if (!Array.isArray(securityClasses) || securityClasses.length === 0) {
      errors.push(`${prefix}.securityClasses must be a non-empty array`);
    } else {
      for (const sc of securityClasses) {
        if (!validSecClasses.has(sc)) {
          errors.push(`${prefix}.securityClasses contains unknown class: ${sc}`);
        }
      }
    }

    const labelNoun = entry.labelNoun;
    if (typeof labelNoun !== "string" || labelNoun.length === 0) {
      errors.push(`${prefix}.labelNoun must be a non-empty string`);
    }

    const weight = entry.weight;
    if (!Number.isInteger(weight) || weight < MIN_WEIGHT || weight > MAX_WEIGHT) {
      errors.push(`${prefix}.weight must be integer in [${MIN_WEIGHT}, ${MAX_WEIGHT}]`);
    }

    const slots = entry.slots;
    if (!Number.isInteger(slots) || slots < MIN_SLOTS || slots > MAX_SLOTS) {
      errors.push(`${prefix}.slots must be integer in [${MIN_SLOTS}, ${MAX_SLOTS}]`);
    }

    const durationMs = entry.durationMs;
    if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_DURATION_MS) {
      errors.push(`${prefix}.durationMs must be integer in [${MIN_DURATION_MS}, ${MAX_DURATION_MS}]`);
    }

    const cooldownMs = entry.cooldownMs;
    if (!Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > MAX_COOLDOWN_MS) {
      errors.push(`${prefix}.cooldownMs must be integer in [0, ${MAX_COOLDOWN_MS}]`);
    }

    const aftermathMs = entry.aftermathMs;
    if (!Number.isInteger(aftermathMs) || aftermathMs < 0 || aftermathMs > durationMs) {
      errors.push(`${prefix}.aftermathMs must be integer in [0, durationMs]`);
    }

    const templatesByFaction = entry.templatesByFaction;
    if (!templatesByFaction || typeof templatesByFaction !== "object") {
      errors.push(`${prefix}.templatesByFaction must be an object`);
    } else {
      const factionKeys = Object.keys(templatesByFaction).map(Number);
      const neutral = entry.content === CONTENT.NEUTRAL;
      if (neutral && (factionKeys.length !== 1 || factionKeys[0] !== NEUTRAL_CONTENT_KEY)) {
        errors.push(`${prefix}.templatesByFaction for NEUTRAL must have exactly the key ${NEUTRAL_CONTENT_KEY}`);
      }
      if (neutral && typeof labelNoun === "string" && labelNoun.length > MAX_LABEL_LENGTH) {
        errors.push(`${prefix}.label "${labelNoun}" exceeds ${MAX_LABEL_LENGTH} characters`);
      }
      for (const factionId of factionKeys) {
        if (factionId === NEUTRAL_CONTENT_KEY) {
          if (!neutral) errors.push(`${prefix}.templatesByFaction key ${NEUTRAL_CONTENT_KEY} only for NEUTRAL content`);
        } else if (!factionLabelKeys.includes(factionId)) {
          errors.push(`${prefix}.templatesByFaction has unknown factionId: ${factionId}`);
        }
        if (typeof labelNoun === "string" && FACTION_LABELS[factionId]) {
          const label = `${FACTION_LABELS[factionId]} ${labelNoun}`;
          if (label.length > MAX_LABEL_LENGTH) {
            errors.push(`${prefix}.label "${label}" exceeds ${MAX_LABEL_LENGTH} characters`);
          }
        }
        const templateList = templatesByFaction[factionId];
        if (!Array.isArray(templateList) || templateList.length === 0) {
          errors.push(`${prefix}.templatesByFaction[${factionId}] must be a non-empty array`);
        } else {
          const seenTemplates = new Set();
          for (const tmpl of templateList) {
            if (typeof tmpl !== "string" || !TEMPLATE_ID_PATTERN.test(tmpl)) {
              errors.push(`${prefix}.templatesByFaction[${factionId}] contains invalid template ID: ${tmpl}`);
            } else if (seenTemplates.has(tmpl)) {
              errors.push(`${prefix}.templatesByFaction[${factionId}] duplicate template: ${tmpl}`);
            } else if (deniedSet.has(tmpl)) {
              errors.push(`${prefix}.templatesByFaction[${factionId}] contains denied template: ${tmpl}`);
            } else {
              seenTemplates.add(tmpl);
            }
          }
        }
      }
      if (factionKeys.length === 0) {
        errors.push(`${prefix}.templatesByFaction must have at least one faction`);
      }
    }

    if (entry.content !== undefined && !CONTENT_VALUES.includes(entry.content)) {
      errors.push(`${prefix}.content must be one of ${CONTENT_VALUES.join(", ")}`);
    }

    const causeFactions = entry.causeFactions;
    if (causeFactions !== undefined && causeFactions !== null) {
      if (!Array.isArray(causeFactions) || causeFactions.length === 0) {
        errors.push(`${prefix}.causeFactions must be null or a non-empty array`);
      } else if (!causeFactions.every((f) => Number.isSafeInteger(f) && f > 0)) {
        errors.push(`${prefix}.causeFactions must hold positive integers`);
      } else if (new Set(causeFactions).size !== causeFactions.length) {
        errors.push(`${prefix}.causeFactions must be unique`);
      }
    }

    errors.push(...rewardErrors(entry, prefix));

    if (entry.clearedConsequence !== undefined && typeof entry.clearedConsequence !== "boolean") {
      errors.push(`${prefix}.clearedConsequence must be a boolean`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, reason: "CATALOG_INVALID", errors };
  }

  const types = raw.map((e) => Object.freeze(e));
  const byType = Object.freeze(
    Object.fromEntries(types.map((t) => [t.eventType, t]))
  );

  const catalog = Object.freeze({
    version: CATALOG_VERSION,
    types: Object.freeze(types),
    byType,
    factionLabels: FACTION_LABELS,
  });

  return { ok: true, catalog };
}

function withoutTemplates(catalog, missingIds) {
  const missingSet = new Set(missingIds);
  const removed = [];
  const emptyFactions = [];

  const newTypes = catalog.types.map((type) => {
    const newTemplatesByFaction = {};
    for (const [factionIdStr, templates] of Object.entries(type.templatesByFaction)) {
      const factionId = Number(factionIdStr);
      const filtered = templates.filter((tmpl) => {
        if (missingSet.has(tmpl)) {
          removed.push(tmpl);
          return false;
        }
        return true;
      });
      if (filtered.length > 0) {
        newTemplatesByFaction[factionId] = Object.freeze(filtered);
      } else {
        emptyFactions.push({ eventType: type.eventType, factionId });
      }
    }
    return Object.freeze({
      ...type,
      templatesByFaction: Object.freeze(newTemplatesByFaction),
    });
  });

  const newByType = Object.freeze(
    Object.fromEntries(newTypes.map((t) => [t.eventType, t]))
  );

  const newCatalog = Object.freeze({
    version: catalog.version,
    types: Object.freeze(newTypes),
    byType: newByType,
    factionLabels: catalog.factionLabels,
  });

  return { catalog: newCatalog, removed: Object.freeze(removed), emptyFactions: Object.freeze(emptyFactions) };
}

function listTemplateIds(catalog) {
  const set = new Set();
  for (const type of catalog.types) {
    for (const templates of Object.values(type.templatesByFaction)) {
      for (const tmpl of templates) {
        set.add(tmpl);
      }
    }
  }
  return Object.freeze(Array.from(set).sort());
}

function anomalyCatalogOf(config) {
  const A = config && config.eventAnomalies;
  if (!A || A.directorKindsEnabled !== true) return Object.freeze([]);
  const out = [];
  for (const entry of ANOMALY_EVENT_CATALOG) {
    const w = A[entry.weightKey];
    if (!Number.isInteger(w) || w <= 0) continue;
    const { weightKey: _weightKey, ...rest } = entry;
    out.push(Object.freeze({ ...rest, weight: w }));
  }
  return Object.freeze(out);
}

function richVeinCatalogOf(config) {
  const R = config && config.richVeins;
  if (!R || R.enabled !== true) return Object.freeze([]);
  const out = [];
  for (const entry of RICH_VEIN_EVENT_CATALOG) {
    const w = R[entry.weightKey];
    if (!Number.isInteger(w) || w <= 0) continue;
    const { weightKey: _weightKey, ...rest } = entry;
    const liberated = entry.cause === CAUSE.LIBERATED;
    const templatesByFaction = liberated && R.moonTemplatesEnabled === true
      ? Object.freeze({ [NEUTRAL_CONTENT_KEY]: Object.freeze([...entry.templatesByFaction[NEUTRAL_CONTENT_KEY],
        ...MOON_VEIN_TEMPLATES]) })
      : entry.templatesByFaction;
    out.push(Object.freeze({ ...rest, weight: w, durationMs: R.durationMs,
      aftermathMs: Math.min(R.aftermathMs, R.durationMs),
      cooldownMs: liberated ? Math.max(R.cooldownMs, R.liberatedWindowMs) : R.cooldownMs, templatesByFaction }));
  }
  return Object.freeze(out);
}

function developedCatalogOf(config) {
  const D = config && config.devIndices;
  if (!D || D.enabled !== true || D.anomaliesEnabled !== true) return Object.freeze([]);
  const out = [];
  for (const entry of DEVELOPED_EVENT_CATALOG) {
    const w = D[entry.weightKey];
    if (!Number.isInteger(w) || w <= 0) continue;
    const { weightKey: _weightKey, ...rest } = entry;
    const durationMs = entry.cause === CAUSE.DEVELOPED_INDUSTRY ? D.anomalyOreDurationMs : D.anomalyRatsDurationMs;
    out.push(Object.freeze({ ...rest, weight: w, durationMs, aftermathMs: Math.min(D.anomalyAftermathMs, durationMs),
      cooldownMs: D.anomalyCooldownMs }));
  }
  return Object.freeze(out);
}

function getEventType(catalog, eventType) {
  return catalog.byType[eventType] || null;
}

module.exports = {
  validateCatalog,
  withoutTemplates,
  listTemplateIds,
  getEventType,
  rewardLootIdIssue,
  anomalyCatalogOf,
  richVeinCatalogOf,
  developedCatalogOf,
  CATALOG_VERSION,
  CAUSE,
  CONTENT,
  FACTION_LABELS,
  DENIED_TEMPLATE_IDS,
  EVENT_CATALOG,
  REWARD_EVENT_CATALOG,
  ANOMALY_EVENT_CATALOG,
  RICH_VEIN_EVENT_CATALOG,
  DEVELOPED_EVENT_CATALOG,
};