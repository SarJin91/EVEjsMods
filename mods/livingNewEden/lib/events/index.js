"use strict";

const { isModuleEnabled } = require("../../config");
const { validateCatalog, withoutTemplates, listTemplateIds, anomalyCatalogOf, richVeinCatalogOf, developedCatalogOf,
  EVENT_CATALOG, REWARD_EVENT_CATALOG, ANOMALY_EVENT_CATALOG, CAUSE } = require("./catalog");
const { createEventService, EMPTY_SYSTEM_SET } = require("./eventService");
const { LAYER_ID, buildEventsLayerView } = require("./eventsLayer");
const S = require("./schema");

const PULSE_FIXED_ROWS = 4;
const CLEARED_ROWS_BASE = 2;

function messageOf(err) {
  return String((err && err.message) || err);
}

function unavailableEvents(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    listOpenEvents: refuse,
    listBoardRows: refuse,
    getEvent: refuse,
    richVeinSystems: () => EMPTY_SYSTEM_SET,
    getStatus: () => status,
    stop() {},
  });
}

function pulseRowBound(config) {
  const P = config.events;
  const slots = config.sites.maxSlotsPerEvent;
  const cleared = P.clearedInfluencePoints > 0
    ? P.maxOpenEvents * (CLEARED_ROWS_BASE + config.world.maxFactionsPerSystem) : 0;
  return P.maxOpenEvents * (1 + slots) + P.maxCleanupRetriesPerPass * (1 + slots) + P.maxNewEventsPerPass
    + P.maxDeletesPerPass + PULSE_FIXED_ROWS + cleared;
}

function factionCount(catalog) {
  const set = new Set();
  for (const t of catalog.types) for (const f of Object.keys(t.templatesByFaction)) set.add(f);
  return set.size;
}

function catalogWarnings(config, catalog) {
  const out = [];
  const maxCooldown = Math.max(0, ...catalog.types.map((t) => t.cooldownMs));
  if (config.events.rowRetentionMs < maxCooldown) out.push("EVENTS_RETENTION_BELOW_COOLDOWN");
  const maxLife = Math.max(0, ...catalog.types.map((t) => t.durationMs + t.aftermathMs));
  if (config.sites.rowRetentionMs < maxLife) out.push("SITES_RETENTION_BELOW_EVENT_LIFE");
  const minDuration = Math.min(...catalog.types.map((t) => t.durationMs));
  if (config.events.presenceActivation === true && config.events.plannedWaitMs >= minDuration) {
    out.push("EVENTS_PLANNED_WAIT_ABOVE_DURATION");
  }
  return out;
}

const hasTemplates = (type) => Object.values(type.templatesByFaction).some((l) => Array.isArray(l) && l.length > 0);

function directorKindsOf(catalog) {
  const names = new Set(ANOMALY_EVENT_CATALOG.map((t) => t.eventType));
  return catalog.types.filter((t) => names.has(t.eventType) && hasTemplates(t)).map((t) => t.eventType);
}

function aftermathSettingsOf(config, catalog, getBattleRepository) {
  const factions = new Set();
  for (const t of catalog.types) {
    if (t.cause !== CAUSE.BATTLE_AFTERMATH) continue;
    for (const [f, list] of Object.entries(t.templatesByFaction)) {
      if (Array.isArray(list) && list.length > 0) factions.add(Number(f));
    }
  }
  const A = config.eventAnomalies;
  if (factions.size === 0 || !A) return null;
  return Object.freeze({ windowMs: A.battleRelicsWindowMs, minLosses: A.battleRelicsMinLosses,
    maxLossRows: A.maxLossRows, maxSystems: A.battleRelicsMaxSystems, factions,
    getBattleRepository: typeof getBattleRepository === "function" ? getBattleRepository : () => null });
}

function liberatedSettingsOf(config, catalog) {
  const R = config.richVeins;
  const types = catalog.types.filter((t) => t.cause === CAUSE.LIBERATED && hasTemplates(t)).map((t) => t.eventType);
  if (!R || types.length === 0) return null;
  return Object.freeze({ windowMs: R.liberatedWindowMs, maxRows: R.maxLiberatedRows, maxOpen: R.maxOpen,
    eventTypes: new Set(types) });
}

function frontSettingsOf(config, catalog) {
  const R = config.richVeins;
  const types = catalog.types.filter((t) => t.cause === CAUSE.FRONT_LINE && hasTemplates(t)).map((t) => t.eventType);
  if (!R || types.length === 0) return null;
  return Object.freeze({ maxOpen: R.maxOpen, eventTypes: new Set(types) });
}

function developedSettingsOf(config, catalog, getDevIndices, ratFactionsOf) {
  const D = config.devIndices;
  const isDev = (t) => (t.cause === CAUSE.DEVELOPED_INDUSTRY || t.cause === CAUSE.DEVELOPED_MILITARY) && hasTemplates(t);
  const types = catalog.types.filter(isDev);
  if (!D || types.length === 0) return null;
  const classesOf = (cause) => Object.freeze([...new Set(types.filter((t) => t.cause === cause)
    .flatMap((t) => t.securityClasses))]);
  return Object.freeze({ minLevel: D.anomalyMinLevel, maxOpen: D.anomalyMaxOpen, candidateRows: D.anomalyCandidateRows,
    eventTypes: new Set(types.map((t) => t.eventType)), oreClasses: classesOf(CAUSE.DEVELOPED_INDUSTRY),
    ratClasses: classesOf(CAUSE.DEVELOPED_MILITARY),
    getDevIndices: typeof getDevIndices === "function" ? getDevIndices : () => null,
    ratFactionsOf: typeof ratFactionsOf === "function" ? ratFactionsOf
      : () => ({ ok: false, reason: "NO_RAT_FACTIONS" }) });
}

function startEvents(deps) {
  let service = null;
  let reg = null;
  let viewHandle = null;
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "events")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function") {
      return { ok: false, reason: "EVENTS_START_FAILED", detail: "scheduler" };
    }
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: "EVENTS_START_FAILED", detail: "clock/ids" };
    }
    if (!config.events || !config.sites || !config.limits) {
      return { ok: false, reason: "EVENTS_START_FAILED", detail: "config" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const telemetry = deps.telemetry || null;
    const count = (name, n) => {
      if (!telemetry || typeof telemetry.count !== "function") return;
      try {
        telemetry.count(name, n);
      } catch (_err) {
      }
    };

    const rewardsOn = Boolean(config.eventRewards && config.eventRewards.enabled === true);
    const valid = validateCatalog(deps.catalogSource
      || [...EVENT_CATALOG, ...(rewardsOn ? REWARD_EVENT_CATALOG : []), ...anomalyCatalogOf(config),
        ...richVeinCatalogOf(config), ...developedCatalogOf(config)]);
    if (!valid.ok) return { ok: false, reason: "CATALOG_INVALID", detail: valid.errors.slice(0, 5).join("; ") };
    let catalog = valid.catalog;
    let templates = "unchecked";
    let templatesMissing = 0;
    let seam = null;
    try {
      seam = deps.adapter && typeof deps.adapter.getDungeonSites === "function" ? deps.adapter.getDungeonSites() : null;
    } catch (_err) {
      seam = null;
    }
    const check = seam && seam.ok === true && typeof seam.checkTemplates === "function"
      ? (() => {
        try {
          return seam.checkTemplates(listTemplateIds(catalog));
        } catch (err) {
          return { ok: false, reason: "CHECK_FAILED", detail: messageOf(err) };
        }
      })() : null;
    if (check && check.ok === true && Array.isArray(check.missing)) {
      templates = "checked";
      templatesMissing = check.missing.length;
      if (templatesMissing > 0) {
        catalog = withoutTemplates(catalog, check.missing).catalog;
        count("events.templatesMissing", templatesMissing);
        logger.log(`events: templates missing in EveJS (removed from the catalog): ${check.missing.join(", ")}`);
      }
    } else {
      count("events.catalogUnchecked", 1);
      logger.log(`events: catalog templates unchecked - ${(check && (check.detail || check.reason))
        || "no dungeon seam"}`);
    }

    const bound = pulseRowBound(config);
    if (bound > config.persistence.maxRowsPerTransaction) {
      return { ok: false, reason: "EVENTS_ROW_BOUND",
        detail: `${bound} rows > persistence.maxRowsPerTransaction=${config.persistence.maxRowsPerTransaction}` };
    }
    const warnings = catalogWarnings(config, catalog);
    for (const w of warnings) logger.log(`events: warning ${w}`);

    const aftermath = aftermathSettingsOf(config, catalog, deps.getBattleRepository);
    const directorKinds = directorKindsOf(catalog);
    const liberated = liberatedSettingsOf(config, catalog);
    const front = frontSettingsOf(config, catalog);
    const developed = developedSettingsOf(config, catalog, deps.getDevIndices, deps.ratFactionsOf);
    service = createEventService({ config, store: persistence.store, clock, ids, scheduler,
      world: deps.getWorld, strategy: deps.getStrategy, presence: deps.getPresence, graph: deps.getGraph,
      sites: deps.getSites, occupation: deps.getOccupation, telemetry, logger, catalog,
      worldSeed: persistence.worldSeed, nowMs: deps.nowMs, setTimer: deps.setTimer, templates, templatesMissing,
      warnings, ...(aftermath ? { aftermath } : {}), ...(liberated ? { liberated } : {}),
      ...(front ? { front } : {}), ...(developed ? { developed } : {}) });
    const veinTypes = [...(liberated ? liberated.eventTypes : []), ...(front ? front.eventTypes : [])];
    try {
      reg = scheduler.registerHandler(S.PULSE_EVENT, service.pulseHandler, { maxPerPass: 1 });
    } catch (err) {
      reg = { ok: false, reason: messageOf(err) };
    }
    if (!reg || !reg.ok) {
      try {
        service.stop();
      } catch (_err) {
      }
      return { ok: false, reason: "EVENTS_START_FAILED", detail: `handler ${S.PULSE_EVENT}: ${(reg && reg.reason)
        || "no result"}` };
    }
    const chain = service.bootstrap();
    let degraded = null;
    if (!chain.ok) {
      degraded = chain.reason;
      logger.log(`events: pulse chain not started ${chain.reason}; the next start retries`);
    }
    const observer = config.observer || {};
    const views = deps.views;
    if (observer.galaxyEnabled === true && observer.galaxyEventsEnabled === true && views
      && typeof views.registerView === "function") {
      const svc = service;
      const getPulseMark = () => {
        try {
          const s = svc.getStatus();
          return Math.max(s.lastPulseAt || 0, s.lastBootPulseAt || 0, s.lastNudgeAt || 0);
        } catch (_err) {
          return 0;
        }
      };
      const r = views.registerView(LAYER_ID, buildEventsLayerView({ store: persistence.store, clock,
        getGovernor: deps.getGovernor, getPulseMark, telemetry, nowMs: deps.nowMs,
        maxEvents: config.events.maxOpenEvents, maxSystems: observer.galaxyEventsMaxSystems,
        refreshMs: observer.galaxyEventsRefreshMs, presenceActivation: config.events.presenceActivation === true }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`events: view ${LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    logger.log(`events: ${degraded ? "degraded" : "running"} open=? cleanupPending=? catalog=v${catalog.version} `
      + `types=${catalog.types.length} factions=${factionCount(catalog)} templates=${templates} `
      + `templatesMissing=${templatesMissing} director-kinds=${directorKinds.length > 0 ? directorKinds.join(",")
        : "none"}${config.richVeins && config.richVeins.enabled === true
        ? ` rich-veins=${veinTypes.length > 0 ? veinTypes.join(",") : "none"}` : ""}${config.devIndices
        && config.devIndices.anomaliesEnabled === true
        ? ` developed=${developed ? [...developed.eventTypes].join(",") : "none"}` : ""}`);
    let stopped = false;
    const facade = {
      listOpenEvents: service.listOpenEvents,
      listBoardRows: service.listBoardRows,
      getEvent: service.getEvent,
      richVeinSystems: () => (stopped ? EMPTY_SYSTEM_SET : service.richVeinSystems()),
      getStatus: () => {
        const st = { ...service.getStatus(), layer: viewHandle !== null };
        if (stopped) return Object.freeze({ ...st, state: "stopped" });
        return Object.freeze(degraded ? { ...st, state: "degraded", reason: degraded } : st);
      },
      stop() {
        if (stopped) return;
        stopped = true;
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          try {
            handle.unregister();
          } catch (_err) {
          }
        }
        service.stop();
        try {
          reg.unregister();
        } catch (_err) {
        }
      },
    };
    return { ok: true, events: Object.freeze(facade), service, catalog };
  } catch (err) {
    if (viewHandle) {
      try {
        viewHandle.unregister();
      } catch (_err) {
      }
    }
    if (service) {
      try {
        service.stop();
      } catch (_err) {
      }
    }
    if (reg && reg.ok && typeof reg.unregister === "function") {
      try {
        reg.unregister();
      } catch (_err) {
      }
    }
    return { ok: false, reason: "EVENTS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startEvents, unavailableEvents, pulseRowBound };
