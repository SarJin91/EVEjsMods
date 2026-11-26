"use strict";

const { isModuleEnabled } = require("../../config");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../fleets/schema");
const { GROUPS: STRENGTH_GROUPS } = require("../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../battle/strength");
const { capitalPowerOverlayOf } = require("../battle/data/capitalStrengthRows");
const { createHostility } = require("../battle/data/hostility");
const { REGISTRY_DATA_V1, createFactionRegistry, BORDER_REACH_KEYS } = require("./registry");
const { createBorderIndex } = require("./border");
const { createHive } = require("./hive");
const { createReviewFootholdsOf } = require("./reviewFootholds");
const { validateCampaign } = require("./campaignCheck");
const { createFactionRepository } = require("./factionRepository");
const { runFactionSeed } = require("./factionSeed");
const { runCoreGrant, coreGrantLogLine } = require("./coreGrant");
const { coresFor } = require("../world/core");
const { VIEW_ID, buildFactionsView } = require("./factionsView");
const { VIEW_ID: ACTIVITY_VIEW_ID, buildActivityView } = require("./activity/activityView");
const { createIntelRepository } = require("./intelRepository");
const { createBattleIntelConsequence } = require("./battleIntel");
const { createReconLossRepository } = require("./reconLossRepository");
const { createReconLossConsequence } = require("./reconLoss");
const { createAttackLossRepository } = require("./attackLossRepository");
const { createAttackLossConsequence } = require("./attackLoss");
const { createTruceRepository } = require("./truce/repository");
const { createWarPairConsequence } = require("./truce/consequence");
const { createPlayerActivityRepository } = require("./playerActivityRepository");
const { createPlayerActivityService } = require("./playerActivity");
const killObservation = require("../adapter/killObservation");
const { createOperationKinds } = require("./kinds");
const { createReviewService, EVENT_TYPE: REVIEW_EVENT, LIVE_FLEET_STATES } = require("./reviewService");
const { createReactiveService, EVENT_TYPE: SWEEP_EVENT, LEGACY_EVENT_TYPE: REACTIVE_EVENT } =
  require("./reactiveService");
const { createTerritoryTrimService, TRIM_EVENT } = require("./territoryTrimService");
const { buildPowerTable } = require("./ai/strength");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("./data/operationKinds");
const { TARGET_SCORING_V1 } = require("./data/targetScoring");

const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", DEGRADED: "degraded", STOPPED: "stopped",
  UNAVAILABLE: "unavailable" });
const CAMPAIGN = Object.freeze({ PENDING: "pending", OK: "ok", INVALID: "invalid", UNAVAILABLE: "unavailable" });
const NO_CAMPAIGNS = "none";
const REFUSAL_FIELDS = Object.freeze(["code", "detail", "rows", "limit"]);
const CLOSED_REASONS = Object.freeze(["STORE_CLOSED"]);
const STORE_SUSPENDED = "STORE_SUSPENDED";
const MAX_DETAIL_LENGTH = 200;

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function unwrap(result) {
  if (result && result.ok) return result.value;
  const out = { ok: false, reason: (result && result.reason) || "TX_FAILED" };
  for (const field of REFUSAL_FIELDS) {
    if (result && result[field] !== undefined && result[field] !== null) out[field] = result[field];
  }
  return out;
}

function createUnavailableStrategy(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  const status = Object.freeze({ state: STATE.UNAVAILABLE, reason: refusal.reason });
  return Object.freeze({
    registry: null,
    whenReady: () => Promise.resolve(status),
    getStatus: () => status,
    getFaction: refuse,
    listFactions: refuse,
    applyFactionChange: refuse,
    isApplied: refuse,
    getCampaign: refuse,
    listActiveCampaigns: refuse,
    getCaptureBelt: refuse,
    repository: null,
    intelRepository: null,
    intelConsequence: null,
    listTruced: refuse,
    hive: null,
    stop: noop,
  });
}

const REGISTRY_ACTIVE = "registry";

function parseActiveFactions(text) {
  const value = String(text === undefined || text === null ? "" : text).trim();
  if (value === "" || value === REGISTRY_ACTIVE) return REGISTRY_ACTIVE;
  if (value === NO_CAMPAIGNS) return [];
  return value.split(",").map((p) => Number(p.trim()));
}

function resolveActiveFactions(registry, text, max, enabledFlags) {
  const wanted = parseActiveFactions(text);
  const flags = Array.isArray(enabledFlags) ? enabledFlags : [];
  if (wanted !== REGISTRY_ACTIVE) {
    for (const factionId of wanted) {
      const entry = registry.getFaction(factionId);
      if (!entry || entry.activity !== "active"
        || (entry.requiresFlag !== undefined && !flags.includes(entry.requiresFlag))) {
        return { ok: false, detail: String(factionId) };
      }
    }
  }
  const count = wanted === REGISTRY_ACTIVE ? registry.listActiveFactions().length : wanted.length;
  if (count > max) return { ok: false, detail: `count=${count} max=${max}` };
  return { ok: true, wanted, count };
}

function enabledFlagsOf(config) {
  const flags = [];
  if (config && config.hive && config.hive.enabled === true) flags.push("hive");
  if (config && config.invasions && config.invasions.drifters && config.invasions.drifters.enabled === true) {
    flags.push("drifters");
  }
  return flags;
}

function parseCampaigns(text) {
  const value = String(text === undefined || text === null ? "" : text).trim();
  if (value === "" || value === NO_CAMPAIGNS) return [];
  return value.split(",").map((p) => p.trim());
}

function readFactionNames(adapter, logger) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    if (r && r.ok && r.names instanceof Map) return r.names;
    logger.log(`strategy: faction names unavailable - ${(r && r.reason) || "no_result"}; panel shows ids`);
  } catch (err) {
    logger.log(`strategy: faction names unavailable - ${messageOf(err)}; panel shows ids`);
  }
  return new Map();
}

function startStrategy(deps) {
  try {
    const { config, persistence, clock, telemetry } = deps || {};
    if (!isModuleEnabled(config, "strategy")) return { ok: false, reason: "STRATEGY_DISABLED" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "PERSISTENCE_UNAVAILABLE" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
    const settings = config.strategy;
    const activeIds = parseCampaigns(settings.campaigns);
    const strengthGroups = expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(settings));
    const powerTable = buildPowerTable(strengthGroups);
    const registryCtx = {
      hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES, hostility: createHostility(),
      maxFactions: settings.maxRegistryFactions, maxCampaignSystems: settings.maxCampaignSystems,
      maxShipsPerFleet: config.fleets.maxShipsPerFleet, maxCompositionEntries: config.fleets.maxCompositionEntries,
      maxResourceUnits: settings.maxResourceUnits, activeCampaignIds: activeIds,
      enabledFlags: enabledFlagsOf(config),
      battleshipDoctrines: settings.battleshipDoctrines,
      battleshipPowerCalibrated: settings.battleshipPowerCalibrated === true, powerTable,
    };
    let built = createFactionRegistry(REGISTRY_DATA_V1, registryCtx);
    if (!built.ok) return { ok: false, reason: "STRATEGY_REGISTRY_INVALID", detail: built.detail };
    const act = resolveActiveFactions(built.registry, settings.activeFactions, settings.maxActiveFactions,
      registryCtx.enabledFlags);
    if (!act.ok) return { ok: false, reason: "STRATEGY_ACTIVE_FACTIONS_INVALID", detail: act.detail };
    if (act.wanted !== REGISTRY_ACTIVE) {
      built = createFactionRegistry(REGISTRY_DATA_V1, { ...registryCtx, activeFactionIds: act.wanted });
      if (!built.ok) return { ok: false, reason: "STRATEGY_REGISTRY_INVALID", detail: built.detail };
    }
    const registry = built.registry;
    const activeFactionIds = Object.freeze(registry.listActiveFactions().map((f) => f.factionId));
    const unknown = activeIds.find((id) => registry.getCampaign(id) === null);
    if (unknown !== undefined) return { ok: false, reason: "STRATEGY_CAMPAIGN_UNKNOWN", detail: unknown };

    const border = createBorderIndex({ registry, getGraph: () => {
      const g = deps.graph;
      try {
        const r = g && typeof g.getGraph === "function" ? g.getGraph() : null;
        return r && r.ok === true && r.graph ? r.graph : null;
      } catch (_err) {
        return null;
      }
    }, settings: { enabled: settings.borderEnabled === true, maxBfsSystems: settings.maxBfsSystems,
      routeMaxJumps: config.graph.routeMaxJumps, reach: Object.fromEntries(BORDER_REACH_KEYS
        .filter((k) => Number.isSafeInteger(settings[k])).map((k) => [k, settings[k]])) },
    logger: deps.logger, hostility: registryCtx.hostility });

    const hive = createHive({ registry, getGraph: () => {
      const g = deps.graph;
      try {
        const r = g && typeof g.getGraph === "function" ? g.getGraph() : null;
        return r && r.ok === true && r.graph ? r.graph : null;
      } catch (_err) {
        return null;
      }
    }, getWorldRepository: () => (deps.world && deps.world.repository ? deps.world.repository : null),
    settings: config.hive || { enabled: false }, logger: deps.logger });

    const hooks = (telemetry && telemetry.hooks) || {};
    const repository = createFactionRepository({ journal: persistence.journal,
      limits: { maxResourceUnits: settings.maxResourceUnits, maxFrontLimit: config.limits.maxActiveFrontsPerFaction,
        maxListLimit: settings.maxRegistryFactions },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    const store = persistence.store;
    const run = (op, fn) => unwrap(store.transaction(`strategy.${op}`, fn));
    const intelRepository = createIntelRepository({ journal: persistence.journal,
      limits: { maxIntelRowsPerFaction: settings.maxIntelRowsPerFaction, maxListLimit: settings.maxBfsSystems },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    const reconLossRepository = createReconLossRepository({ journal: persistence.journal,
      limits: { reconLossThreshold: settings.reconLossThreshold, reconLossCooldownMs: settings.reconLossCooldownMs,
        reconLossWindowMs: settings.reconLossWindowMs, reconLossMaxMultiplier: settings.reconLossMaxMultiplier,
        maxReconLossRowsPerFaction: settings.maxReconLossRowsPerFaction },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    const attackLossRepository = createAttackLossRepository({ journal: persistence.journal,
      limits: { attackLossThreshold: settings.attackLossThreshold, attackLossCooldownMs: settings.attackLossCooldownMs,
        attackLossWindowMs: settings.attackLossWindowMs, attackLossMaxMultiplier: settings.attackLossMaxMultiplier,
        maxAttackLossRowsPerFaction: settings.maxAttackLossRowsPerFaction },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    const truceRepository = settings.truceEnabled === true
      ? createTruceRepository({ journal: persistence.journal, limits: { maxWarPairRows: settings.maxWarPairRows },
        params: { windowMs: settings.truceWindowMs, minLosses: settings.truceMinLosses,
          lossRatioPermille: settings.truceLossRatioPermille, maxWinPermille: settings.truceMaxWinPermille,
          truceMs: settings.truceMs, cooldownMs: settings.truceCooldownMs },
        onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined })
      : null;
    const playerActivityRepository = createPlayerActivityRepository({
      limits: { playerActivityWindowMs: settings.playerActivityWindowMs,
        playerActivityMaxKills: settings.playerActivityMaxKills,
        maxPlayerActivityRowsPerFaction: settings.maxPlayerActivityRowsPerFaction },
      onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined });
    const status = { state: STATE.STARTING, reason: null, seq: 0,
      seed: { state: "pending", created: 0, existing: 0, orphans: 0, failed: 0, reason: null } };
    const campaigns = new Map(activeIds.map((id) => [id, { campaignId: id, state: CAMPAIGN.PENDING, reason: null,
      systemId: null, detail: null, check: null }]));
    let readyResolve = null;
    const ready = new Promise((resolve) => { readyResolve = resolve; });

    function log(line) {
      try {
        logger.log(line);
      } catch (_err) {
      }
    }

    const bsMode = settings.battleshipDoctrines === undefined ? "off" : settings.battleshipDoctrines;
    if (bsMode !== "off" || registryCtx.battleshipPowerCalibrated) {
      const garrison = registry.battleshipGarrison;
      log(`strategy: battleshipDoctrines=${bsMode} calibrated=${registryCtx.battleshipPowerCalibrated ? "on" : "off"} `
        + `garrisonOverlay=${garrison.applied.length}`);
      if (garrison.dropped.length > 0) {
        log(`strategy: battleship garrison overlay dropped (stronger than v18): ${garrison.dropped.join(",")}`);
      }
    }

    function metric(name, n) {
      if (!telemetry || typeof telemetry.count !== "function" || n <= 0) return;
      try {
        telemetry.count(name, n);
      } catch (_err) {
      }
    }

    const stopped = () => status.state === STATE.STOPPED;

    const ai = { state: "off", reason: null, service: null, registration: null, trim: null, trimRegistration: null,
      reactive: null, reactiveRegistration: null, legacyRegistration: null };
    function unregisterQuietly(registration) {
      try {
        registration.unregister();
      } catch (_err) {
      }
    }
    function wireAi() {
      if (settings.aiEnabled !== true) {
        ai.reason = "disabled_by_config";
        return;
      }
      const scheduler = deps.scheduler;
      const fleets = deps.fleets;
      const schedulerOk = Boolean(scheduler && typeof scheduler.registerHandler === "function"
        && typeof scheduler.enqueueMany === "function" && typeof scheduler.getStatus === "function"
        && (() => {
          try {
            return scheduler.getStatus().state === "ready";
          } catch (_err) {
            return false;
          }
        })());
      if (!schedulerOk) {
        Object.assign(ai, { state: "unavailable", reason: "SCHEDULER_UNAVAILABLE" });
        return;
      }
      if (!fleets || !fleets.repository || !fleets.travel || typeof fleets.travel.planInTx !== "function"
        || typeof fleets.travel.requestRefitInTx !== "function") {
        Object.assign(ai, { state: "unavailable", reason: "FLEETS_UNAVAILABLE" });
        return;
      }
      const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
        { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
      if (!k.ok) {
        Object.assign(ai, { state: "unavailable", reason: `KINDS_INVALID:${k.detail}` });
        return;
      }
      const hostility = createHostility();
      const trim = createTerritoryTrimService({ journal: persistence.journal, getOccupation: deps.getOccupation,
        worldRepository: deps.world && deps.world.repository ? deps.world.repository : null,
        getStations: deps.getStations, config, telemetry, logger });
      let trimOn = false;
      const service = createReviewService({ store, journal: persistence.journal, strategyRepository: repository,
        intelRepository, registry, kinds: k.kinds, powerTable,
        reconLossRepository,
        attackLossRepository,
        truceRepository,
        playerActivityRepository,
        scoring: TARGET_SCORING_V1, scheduler, fleets, world: deps.world || null, presence: deps.presence || null,
        getStations: deps.getStations, getOccupation: deps.getOccupation, getMining: deps.getMining,
        getProduction: deps.getProduction, getConstruction: deps.getConstruction,
        getLogistics: deps.getLogistics, getTrade: deps.getTrade, getSiege: deps.getSiege,
        getPlayerSiege: deps.getPlayerSiege || null, strengthGroups,
        getHarvestRaid: deps.getHarvestRaid || null,
        getPlayerSovSiege: deps.getPlayerSovSiege || null,
        getPlayerValue: deps.getPlayerValue || null,
        getTransit: deps.getTransit || null,
        getDevIndices: deps.getDevIndices || null,
        getTreasury: deps.getTreasury || null,
        getSentries: deps.getSentries || null,
        getHunt: deps.getHunt || null,
        getBlockade: deps.getBlockade || null,
        getVirtualCorps: deps.getVirtualCorps || null,
        getTrim: () => (trimOn ? trim : null),
        getHive: () => hive,
        footholdsOf: createReviewFootholdsOf({ hive, footholdsOf: deps.footholdsOf,
          enabled: Boolean(config.invasions) && config.invasions.reviewFootholdsEnabled === true,
          kindOf: (f) => {
            const entry = registry.getFaction(f);
            return entry ? entry.kind : null;
          } }),
        beachheadsOf: typeof deps.beachheadsOf === "function" ? deps.beachheadsOf : null,
        worldBossTargetsOf: typeof deps.worldBossTargetsOf === "function" ? deps.worldBossTargetsOf : null,
        border,
        graph: deps.graph || null, clock,
        worldSeed: persistence.worldSeed, config,
        hostility, isCampaignOk: (id) => {
          const c = campaigns.get(String(id));
          return Boolean(c && c.state === CAMPAIGN.OK);
        }, telemetry, logger, hooks: deps.hooks });
      let r;
      try {
        r = scheduler.registerHandler(REVIEW_EVENT, service.handler, { maxPerPass: settings.maxReviewsPerPass });
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || !r.ok) {
        Object.assign(ai, { state: "unavailable", reason: `HANDLER_${(r && r.reason) || "no result"}` });
        service.stop();
        trim.stop();
        return;
      }
      let t;
      try {
        t = scheduler.registerHandler(TRIM_EVENT, trim.handler, { maxPerPass: settings.maxTrimBatchesPerPass });
      } catch (err) {
        t = { ok: false, reason: messageOf(err) };
      }
      if (t && t.ok) trimOn = true;
      else {
        trim.stop();
        log(`strategy: territory trim unavailable HANDLER_${(t && t.reason) || "no result"}; reviews keep running`);
      }
      Object.assign(ai, { state: "on", reason: null, service, registration: r, trim, trimRegistration: t && t.ok
        ? t : null });
      let reactive = null;
      let rr;
      let lr = null;
      try {
        reactive = createReactiveService({ store, journal: persistence.journal, strategyRepository: repository,
          registry, kinds: k.kinds, scheduler, fleets, world: deps.world || null, getStations: deps.getStations,
          getSiege: deps.getSiege, getPlayerSiege: deps.getPlayerSiege || null, graph: deps.graph || null, clock,
          worldSeed: persistence.worldSeed, config,
          params: service.params, liveFleetStates: LIVE_FLEET_STATES, telemetry, logger,
          hostility, getBlockade: deps.getBlockade || null });
        rr = scheduler.registerHandler(SWEEP_EVENT, reactive.handler, { maxPerPass: 1 });
        if (rr && rr.ok) {
          lr = scheduler.registerHandler(REACTIVE_EVENT, reactive.legacyHandler,
            { maxPerPass: settings.maxReactiveReviewsPerPass });
          if (!lr || !lr.ok) {
            unregisterQuietly(rr);
            rr = lr;
          }
        }
      } catch (err) {
        if (rr && rr.ok) unregisterQuietly(rr);
        rr = { ok: false, reason: messageOf(err) };
      }
      if (rr && rr.ok) Object.assign(ai, { reactive, reactiveRegistration: rr, legacyRegistration: lr });
      else {
        if (reactive) reactive.stop();
        log(`strategy: reactive review unavailable HANDLER_${(rr && rr.reason) || "no result"}; reviews keep running`);
      }
    }
    if (!Number.isSafeInteger(persistence.worldSeed)) Object.assign(ai, { state: "unavailable", reason: "NO_WORLD_SEED" });
    else wireAi();
    if (ai.state !== "on" && ai.reason !== "disabled_by_config") log(`strategy: ai ${ai.state} ${ai.reason}`);

    function aiStatus() {
      return Object.freeze({ state: ai.state, reason: ai.reason,
        ...(ai.service ? { review: ai.service.getStatus() } : {}),
        ...(ai.trim ? { trim: ai.trim.getStatus() } : {}),
        ...(ai.reactive ? { reactive: ai.reactive.getStatus() } : {}) });
    }

    function runCoreGrantStep() {
      const worldRepository = deps.world && deps.world.repository ? deps.world.repository : null;
      if (!worldRepository) {
        log("strategy: core grant skipped WORLD_UNAVAILABLE");
        return;
      }
      const g = runCoreGrant({ store, journal: persistence.journal, worldRepository, registry,
        cores: coresFor(config), settings: { baselineScore: config.occupation.stableBaselineScore } });
      if (stopped()) return;
      if (!g.ok) {
        log(`strategy: core grant failed ${g.reason}${g.detail ? ` (${g.detail})` : ""}; next start retries`);
        return;
      }
      metric("strategy.coreGrant.granted", g.granted);
      metric("strategy.coreGrant.owned", g.owned);
      metric("strategy.coreGrant.skipped", g.skipped);
      let seedState = null;
      try {
        const seed = deps.world.seed;
        const st = seed && typeof seed.getStatus === "function" ? seed.getStatus() : null;
        seedState = st && typeof st.state === "string" ? st.state : null;
      } catch (_err) {
        seedState = null;
      }
      for (const r of g.results) {
        const line = coreGrantLogLine(r, seedState);
        if (line !== null) log(line);
      }
    }

    function runBootstrap() {
      if (ai.state !== "on") return;
      const b = ai.service.bootstrap();
      if (b.ok) log(`strategy: ai on reviews enqueued=${b.enqueued} duplicates=${b.duplicates}`);
      else log(`strategy: ai bootstrap failed ${b.reason}; the next start retries`);
      if (!ai.reactive || settings.reactiveEnabled !== true) return;
      const rb = ai.reactive.bootstrap();
      if (rb.ok) log(`strategy: reactive sweep enqueued=${rb.enqueued} duplicates=${rb.duplicates}`);
      else log(`strategy: reactive bootstrap failed ${rb.reason}; the next start retries`);
    }

    function stopAi() {
      if (ai.legacyRegistration) {
        unregisterQuietly(ai.legacyRegistration);
        ai.legacyRegistration = null;
      }
      if (ai.reactiveRegistration) {
        unregisterQuietly(ai.reactiveRegistration);
        ai.reactiveRegistration = null;
      }
      if (ai.reactive) ai.reactive.stop();
      if (ai.trimRegistration) {
        try {
          ai.trimRegistration.unregister();
        } catch (_err) {
        }
        ai.trimRegistration = null;
      }
      if (ai.trim) ai.trim.stop();
      if (ai.registration) {
        try {
          ai.registration.unregister();
        } catch (_err) {
        }
        ai.registration = null;
      }
      if (ai.service) ai.service.stop();
      if (ai.state === "on") ai.state = "stopped";
    }

    function getStatus() {
      return Object.freeze({
        state: status.state, reason: status.reason, seq: status.seq,
        seed: Object.freeze({ ...status.seed }),
        ai: aiStatus(),
        activeFactions: activeFactionIds,
        campaigns: Object.freeze([...campaigns.values()].map((c) => Object.freeze({ ...c }))),
      });
    }

    function finish(state, reason) {
      status.state = state;
      status.reason = reason === undefined ? null : reason;
      status.seq += 1;
      readyResolve(getStatus());
    }

    function onGraph(res) {
      if (stopped()) return;
      if (!res || res.ok !== true || !res.graph) {
        for (const c of campaigns.values()) {
          Object.assign(c, { state: CAMPAIGN.UNAVAILABLE, reason: "GRAPH_UNAVAILABLE" });
        }
        status.seed.state = "skipped";
        status.seed.reason = "graph_unavailable";
        log(`strategy: degraded graph_unavailable (${(res && res.reason) || "no_result"}); no seed, no campaign`);
        finish(STATE.DEGRADED, "graph_unavailable");
        return;
      }
      const graph = res.graph;
      for (const c of campaigns.values()) {
        const check = validateCampaign(registry.getCampaign(c.campaignId), registry, graph,
          { maxJumps: config.graph.routeMaxJumps });
        if (check.ok) Object.assign(c, { state: CAMPAIGN.OK, check });
        else {
          Object.assign(c, { state: CAMPAIGN.INVALID, reason: check.reason, systemId: check.systemId || null,
            detail: check.detail || null });
          metric("strategy.campaignInvalid", 1);
          log(`strategy: campaign ${c.campaignId} invalid ${check.reason}`
            + `${check.systemId ? ` ${check.systemId}` : ""}${check.detail ? ` (${check.detail})` : ""}`);
        }
      }
      if (settings.factionSeedEnabled !== true) {
        status.seed.state = "off";
      } else {
        const seeded = runFactionSeed({ store, repository, registry, clock, settings: {
          budgetFactor: settings.budgetFactor, maxResourceUnits: settings.maxResourceUnits,
          maxActiveFrontsPerFaction: config.limits.maxActiveFrontsPerFaction,
          maxRowsPerTransaction: config.persistence.maxRowsPerTransaction,
          registryVersion: registry.version.factions } });
        if (stopped()) return;
        if (seeded.ok) {
          Object.assign(status.seed, { state: "done", created: seeded.created, existing: seeded.existing,
            orphans: seeded.orphans, failed: seeded.failed });
          for (const name of ["created", "existing", "orphans", "failed"]) {
            metric(`strategy.factionSeed.${name}`, seeded[name]);
          }
          if (seeded.failed > 0) {
            log(`strategy: seed failed for factions ${seeded.failedIds.join(",")} (row deleted or key conflict); kept`);
          }
        } else if (seeded.reason === STORE_SUSPENDED) {
          Object.assign(status.seed, { state: "failed", reason: seeded.reason });
          log("strategy: seed skipped - store suspended; next start retries");
          finish(STATE.DEGRADED, "store_suspended");
          return;
        } else if (CLOSED_REASONS.includes(seeded.reason)) {
          return;
        } else {
          Object.assign(status.seed, { state: "failed", reason: seeded.reason });
          metric("strategy.factionSeed.failed", 1);
          log(`strategy: seed failed ${seeded.reason}${seeded.detail ? ` (${seeded.detail})` : ""}`
            + "; next start retries");
        }
      }
      runCoreGrantStep();
      if (stopped()) return;
      const s = status.seed;
      const parts = [...campaigns.values()].map((c) => (c.state === CAMPAIGN.OK
        ? `${c.campaignId}(${c.check.systems} systems, ecc ${c.check.eccentricity})` : `${c.campaignId}(${c.state})`));
      runBootstrap();
      log(`strategy: running factions=${registry.listFactions().length} active=${activeFactionIds.length} `
        + (s.state === "done" ? `created=${s.created} existing=${s.existing} orphans=${s.orphans}` : `seed=${s.state}`)
        + ` campaigns=${parts.length > 0 ? parts.join(",") : "none"}`);
      finish(s.state === "failed" ? STATE.DEGRADED : STATE.RUNNING, s.state === "failed" ? `seed_${s.reason}` : null);
    }

    const viewHandles = [];
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const factionNames = readFactionNames(deps.adapter, logger);
      const r = views.registerView(VIEW_ID, buildFactionsView({ store, repository, registry, getStatus,
        graph: deps.graph || null, world: deps.world || null, getGovernor: deps.getGovernor,
        factionNames,
        getAiMemory: (f) => (ai.service ? ai.service.getMemory(f) : null),
        getAiSeq: () => (ai.service ? ai.service.getSeq() : 0),
        getTreasury: deps.getTreasury || null }));
      if (r && r.ok) viewHandles.push(r);
      else log(`strategy: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
      if (config.observer && config.observer.factionActivityEnabled === true) {
        let a;
        try {
          a = views.registerView(ACTIVITY_VIEW_ID, buildActivityView({ store, repository, registry, getStatus,
            graph: deps.graph || null, clock, config, getGovernor: deps.getGovernor,
            factionNames, world: deps.world || null,
            getAiService: () => ai.service, scheduler: deps.scheduler || null, fleets: deps.fleets || null,
            getStations: deps.getStations, getMining: deps.getMining, getProduction: deps.getProduction,
            getLogistics: deps.getLogistics, getConstruction: deps.getConstruction, getSiege: deps.getSiege,
            getServices: deps.getServices, telemetry: telemetry || null,
            truce: truceRepository }));
        } catch (err) {
          a = { ok: false, reason: messageOf(err) };
        }
        if (a && a.ok) viewHandles.push(a);
        else log(`strategy: view ${ACTIVITY_VIEW_ID} not registered - ${(a && a.reason) || "no result"}`);
      }
    }

    function getCampaign(campaignId) {
      const def = registry.getCampaign(campaignId);
      const c = campaigns.get(String(campaignId));
      if (!def || !c) return { ok: false, reason: "CAMPAIGN_INACTIVE" };
      if (c.state === CAMPAIGN.PENDING) return { ok: false, reason: "CAMPAIGN_PENDING" };
      if (c.state !== CAMPAIGN.OK) {
        return { ok: false, reason: c.reason, ...(c.systemId ? { systemId: c.systemId } : {}),
          ...(c.detail ? { detail: c.detail } : {}) };
      }
      return { ok: true, campaign: def, check: c.check };
    }

    function applyFactionChange(change) {
      const patch = change && change.patch;
      if (patch && patch.doctrineId !== undefined && registry.getDoctrine(patch.doctrineId) === null) {
        return { ok: false, reason: "INVALID_INPUT", detail: "change.patch.doctrineId" };
      }
      return run("applyFactionChange", (tx) => repository.applyFactionChange(tx, change));
    }

    const intelFleetRepository = deps.fleets && deps.fleets.repository ? deps.fleets.repository : null;
    const intelIsHostile = (f, o) => {
      const entry = registry.getFaction(f);
      return Boolean(entry) && Number.isSafeInteger(o) && o > 0 && o !== f && !entry.allies.includes(o)
        && registryCtx.hostility(f, o) === true;
    };
    const battleIntel = intelFleetRepository && typeof intelFleetRepository.getFleets === "function"
      ? createBattleIntelConsequence({ intelRepository, fleetRepository: intelFleetRepository,
        worldRepository: deps.world && deps.world.repository ? deps.world.repository : null, registry, powerTable,
        isHostile: intelIsHostile, onCount: typeof hooks.onCount === "function" ? hooks.onCount : undefined })
      : null;
    const reconLoss = battleIntel !== null && settings.reconLossEnabled === true
      ? createReconLossConsequence({ reconLossRepository, fleetRepository: intelFleetRepository, registry })
      : null;
    const attackLoss = battleIntel !== null && settings.attackLossMemoryEnabled === true
      ? createAttackLossConsequence({ attackLossRepository, fleetRepository: intelFleetRepository, registry })
      : null;
    const warPair = battleIntel !== null && truceRepository !== null
      ? createWarPairConsequence({ repository: truceRepository, registry, isHostile: intelIsHostile,
        kinds: String(settings.truceKinds).split(",").map((x) => x.trim()).filter((x) => x.length > 0) })
      : null;
    function warPairFailed() {
      if (typeof hooks.onCount !== "function") return;
      try {
        hooks.onCount("strategy.warPair.failed", 1);
      } catch (_err) {
      }
    }
    function reconLossFailed() {
      if (typeof hooks.onCount !== "function") return;
      try {
        hooks.onCount("strategy.reconLoss.failed", 1);
      } catch (_err) {
      }
    }
    function attackLossFailed() {
      if (typeof hooks.onCount !== "function") return;
      try {
        hooks.onCount("strategy.attackLoss.failed", 1);
      } catch (_err) {
      }
    }
    const intelConsequence = Object.freeze({ name: "intel", apply(tx, settled, ck) {
      if (battleIntel === null || ![STATE.RUNNING, STATE.DEGRADED].includes(status.state)) {
        return { ok: true, skipped: "STRATEGY_OFF" };
      }
      const a = battleIntel.apply(tx, settled, ck);
      if (!a || a.ok === false || (reconLoss === null && attackLoss === null && warPair === null)) return a;
      let out = a;
      if (reconLoss !== null) {
        let b;
        try {
          b = reconLoss.apply(tx, settled, ck);
        } catch (err) {
          b = { ok: false, reason: "RECON_LOSS_THREW", detail: messageOf(err) };
        }
        if (!b || b.ok !== true) {
          reconLossFailed();
          out = { ...out, reconLoss: (b && b.reason) || "RECON_LOSS_FAILED" };
        }
      }
      if (attackLoss !== null) {
        let c;
        try {
          c = attackLoss.apply(tx, settled, ck);
        } catch (err) {
          c = { ok: false, reason: "ATTACK_LOSS_THREW", detail: messageOf(err) };
        }
        if (!c || c.ok !== true) {
          attackLossFailed();
          out = { ...out, attackLoss: (c && c.reason) || "ATTACK_LOSS_FAILED" };
        }
      }
      if (warPair !== null) {
        let d;
        try {
          d = warPair.apply(tx, settled, ck);
        } catch (err) {
          d = { ok: false, reason: "WAR_PAIR_THREW", detail: messageOf(err) };
        }
        if (!d || d.ok !== true) {
          warPairFailed();
          out = { ...out, warPair: (d && d.reason) || "WAR_PAIR_FAILED" };
        }
      }
      return out;
    } });

    const playerActivity = settings.playerActivityEnabled === true
      ? createPlayerActivityService({ store, repository: playerActivityRepository, registry, config,
        getWorldRepository: () => (deps.world && deps.world.repository ? deps.world.repository : null),
        telemetry: telemetry || null, logger })
      : null;
    if (playerActivity !== null) killObservation.setPlayerActivity(playerActivity);

    const strategy = Object.freeze({
      registry,
      powerTable,
      whenReady: () => ready,
      getStatus,
      getFaction: (factionId) => run("getFaction", (tx) => repository.getFaction(tx, factionId)),
      listFactions: () => run("listFactions", (tx) => repository.listFactions(tx)),
      applyFactionChange,
      isApplied: (key) => run("isApplied", (tx) => repository.isApplied(tx, key)),
      getCampaign,
      listActiveCampaigns: () => ({ ok: true, campaigns: [...campaigns.keys()].map((id) => {
        const r = getCampaign(id);
        return Object.freeze({ campaignId: id, ok: r.ok, reason: r.ok ? null : r.reason,
          check: r.ok ? r.check : null });
      }) }),
      getCaptureBelt: (factionId) => border.beltOf(factionId),
      hive,
      repository,
      intelRepository,
      intelConsequence,
      listTruced: (factionId, at) => (truceRepository === null ? { ok: false, reason: "TRUCE_OFF" }
        : run("listTruced", (tx) => truceRepository.listTrucedInDb(tx, factionId, at))),
      stop(reason) {
        if (stopped()) return;
        if (playerActivity !== null && killObservation.getPlayerActivity() === playerActivity) {
          killObservation.setPlayerActivity(null);
        }
        stopAi();
        status.state = STATE.STOPPED;
        status.reason = reason === undefined ? null : String(reason);
        status.seq += 1;
        readyResolve(getStatus());
        while (viewHandles.length > 0) {
          try {
            viewHandles.pop().unregister();
          } catch (_err) {
          }
        }
      },
    });

    const graphService = deps.graph || null;
    if (!graphService || typeof graphService.whenReady !== "function") onGraph(null);
    else {
      Promise.resolve(graphService.whenReady())
        .then((res) => {
          try {
            onGraph(res);
          } catch (err) {
            if (!stopped()) {
              log(`strategy: start after graph failed - ${messageOf(err)}`);
              finish(STATE.DEGRADED, "STRATEGY_GRAPH_STEP_THREW");
            }
          }
        })
        .catch(noop);
    }
    return { ok: true, strategy };
  } catch (err) {
    return { ok: false, reason: "STRATEGY_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startStrategy, createUnavailableStrategy, parseCampaigns, parseActiveFactions,
  resolveActiveFactions, enabledFlagsOf, STATE, CAMPAIGN };
