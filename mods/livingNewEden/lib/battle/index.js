"use strict";

const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../config");
const { createBattleRepository } = require("./battleRepository");
const { createCooldownRepository } = require("./cooldownRepository");
const { createSettlement } = require("./settlement");
const { settlementRowsLimit } = require("./settlementPlan");
const { buildResolverParams } = require("./resolverParams");
const { createStrengthCatalog } = require("./strength");
const { createHostility } = require("./data/hostility");
const { SELF_TEST_INPUT, CONTACT_CHECK_ROWS } = require("./data/contactRules");
const { createContactService, CONTACT_EVENT, RESOLUTION_EVENT, resolveKey } = require("./contactService");
const { createResolutionService, RECENT_SETTLED } = require("./resolutionService");
const { createReconcile, RECONCILE_EVENT, reconcileKey } = require("./reconcile");
const { VIEW_ID, buildBattlesView } = require("./battlesView");
const { LAYER_ID: OPEN_LAYER_ID, buildBattlesOpenLayerView } = require("./battlesOpenLayer");
const { seedDemo } = require("./demo");
const { createSlowOpLog } = require("../telemetry/slowOps");
const { createLiveBridge, LIVE_METHODS } = require("./liveBridge");
const { createLiveMemberRepository } = require("./liveMemberRepository");
const { createLiveRecovery, LIVE_RECOVER_EVENT } = require("./liveRecovery");

const STATE_READY = "ready";
const STATE_UNAVAILABLE = "unavailable";
const STATE_STOPPED = "stopped";
const CREATE_ROWS_FIXED = 2;
const CREATE_ROWS_PER_FLEET = 3;
const SIDES = 2;
const OPEN_STATES = Object.freeze(["PENDING", "CLAIMED", "RESOLVING", "LIVE", "SETTLING"]);
const FIXED_DEFENSE_EXTRA_ROWS = 5;
const FIXED_DEFENSE_SPEC_KEYS = Object.freeze(["systemId", "at", "sideA", "fixedDefenses", "grid"]);
const FIXED_DEFENSE_EVENT = "BATTLE_FIXED_DEFENSE";
const FIXED_DEFENSE_HOLD_REASON = "FIXED_DEFENSE";
const FIXED_DEFENSE_OBJECTIVE = "destroy";
const FIXED_DEFENSE_SKIPPED = "FIXED_DEFENSE";
const FIXED_DEFENSE_PERMANENT = Object.freeze(["IDEMPOTENCY_CONFLICT", "INPUT_INVALID", "BATTLE_INPUT_TOO_LARGE",
  "BATTLE_TOO_LARGE_TO_SETTLE", "UNKNOWN_SYSTEM"]);
const SETTING_KEYS = Object.freeze(["engageDelayMs", "recontactCooldownMs", "contactScanMaxFleets", "holdRecheckMs",
  "holdWhenPresenceUnknown", "holdRadius", "neighborHoldMaxMs", "reconcileDelayMs", "reconcileMaxBattles", "logSettledPerMin", "maxFleetsPerSide",
  "maxResolutionMs", "maxInputBytes", "maxResultBytes", "maxListLimit", "retreatSearchMaxJumps",
  "retreatSearchMaxSystems", "retreatMaxCandidates", "strengthGroupConfidence", "strengthUnknownTypeConfidence"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function refusingLive(reason) {
  return Object.freeze(Object.fromEntries(LIVE_METHODS.map((name) => [name, () => ({ ok: false, reason })])));
}

function createUnavailableBattle(reason, detail) {
  const status = Object.freeze({ state: STATE_UNAVAILABLE, reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ repository: null, getStatus: () => status,
    requestContactCheckInTx: () => ({ ok: false, reason: String(reason) }),
    requestReleaseContactInTx: () => ({ ok: false, reason: String(reason) }), countByState: () => ({ ok: false,
      reason: String(reason) }), readCooldownsInTx: () => ({ ok: false, reason: String(reason) }),
    createFixedDefenseBattleInTx: () => ({ ok: false, reason: String(reason) }),
    live: refusingLive(String(reason)), stop() {} });
}

function liveSkippingWrecks(inner) {
  return Object.freeze({ name: inner.name, apply(tx, settled, ck) {
    if (settled && settled.mode === "LIVE_EVEJS") return { ok: true, skipped: "LIVE_WRECKS_NATIVE" };
    return inner.apply(tx, settled, ck);
  } });
}

function telemetryOf(telemetry) {
  const call = (kind, name, value) => {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  };
  return { count: (name, n = 1) => call("count", name, n), gauge: (name, v) => call("gauge", name, v),
    observe: (name, v) => call("observe", name, v) };
}

function lazySiegeConsequence(getSiege) {
  return Object.freeze({ name: "siege", apply(tx, settled, ck) {
    let siege = null;
    try {
      siege = getSiege();
    } catch (_err) {
      siege = null;
    }
    const c = siege && siege.consequence;
    if (!c || typeof c.apply !== "function") return { ok: true, skipped: "SIEGE_OFF" };
    return c.apply(tx, settled, ck);
  } });
}

function lazyIntelConsequence(getStrategy) {
  return Object.freeze({ name: "intel", apply(tx, settled, ck) {
    let strategy = null;
    try {
      strategy = getStrategy();
    } catch (_err) {
      strategy = null;
    }
    const c = strategy && strategy.intelConsequence;
    if (!c || typeof c.apply !== "function") return { ok: true, skipped: "STRATEGY_OFF" };
    return c.apply(tx, settled, ck);
  } });
}

function lazyTreasuryConsequence(getTreasury) {
  return Object.freeze({ name: "treasury", apply(tx, settled, ck) {
    let treasury = null;
    try {
      treasury = getTreasury();
    } catch (_err) {
      treasury = null;
    }
    const c = treasury && treasury.lossConsequence;
    if (!c || typeof c.apply !== "function") return { ok: true, skipped: "TREASURY_OFF" };
    return c.apply(tx, settled, ck);
  } });
}

function lazyCrewsConsequence(getCrews) {
  return Object.freeze({ name: "crews", apply(tx, settled, ck) {
    let crews = null;
    try {
      crews = getCrews();
    } catch (_err) {
      crews = null;
    }
    const c = crews && crews.consequence;
    if (!c || typeof c.apply !== "function") return { ok: true, skipped: "CREWS_OFF" };
    return c.apply(tx, settled, ck);
  } });
}

function skipFixedDefense(inner, onSkip) {
  return Object.freeze({ name: inner.name, apply(tx, settled, ck) {
    if (settled && settled.fixedDefenses) {
      if (typeof onSkip === "function") onSkip();
      return { ok: true, skipped: FIXED_DEFENSE_SKIPPED };
    }
    return inner.apply(tx, settled, ck);
  } });
}

function lazySentriesConsequence(getSentries, onOff) {
  return Object.freeze({ name: "sentries", apply(tx, settled, ck) {
    let sentries = null;
    try {
      sentries = getSentries();
    } catch (_err) {
      sentries = null;
    }
    const c = sentries && sentries.battleConsequence;
    if (!c || typeof c !== "object" || typeof c.apply !== "function") {
      if (typeof onOff === "function") {
        try {
          onOff();
        } catch (_err) {
        }
      }
      return { ok: true, skipped: "SENTRIES_OFF" };
    }
    return c.apply(tx, settled, ck);
  } });
}

function lazyWorldBossesConsequence(getWorldBosses) {
  return Object.freeze({ name: "worldBosses", apply(tx, settled, ck) {
    let wb = null;
    try {
      wb = getWorldBosses();
    } catch (_err) {
      wb = null;
    }
    const c = wb && wb.battleConsequence;
    if (!c || typeof c !== "object" || typeof c.apply !== "function") return { ok: true, skipped: "WORLD_BOSSES_OFF" };
    return c.apply(tx, settled, ck);
  } });
}

function schedulerReady(scheduler) {
  try {
    return Boolean(scheduler && typeof scheduler.registerHandler === "function"
      && typeof scheduler.enqueue === "function" && scheduler.getStatus().state === STATE_READY);
  } catch (_err) {
    return false;
  }
}

function startBattle(deps) {
  const undo = [];
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    if (!isModuleEnabled(config, "battle")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository || !fleets.travel || typeof fleets.travel.addArrivalListener !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    if (!schedulerReady(scheduler)) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    const bc = config.battle;
    const S = Object.freeze(Object.fromEntries(SETTING_KEYS.map((k) => [k, bc[k]])));
    const store = persistence.store;
    const maxRows = store.limits && store.limits.maxRowsPerTransaction;
    const createRows = CREATE_ROWS_FIXED + CREATE_ROWS_PER_FLEET * SIDES * S.maxFleetsPerSide + CONTACT_CHECK_ROWS;
    if (Number.isSafeInteger(maxRows) && createRows > maxRows) {
      return { ok: false, reason: "BATTLE_PERSISTENCE_FIT", detail: `battle.maxFleetsPerSide=${S.maxFleetsPerSide}: `
        + `a contact needs ${createRows} rows > persistence.maxRowsPerTransaction=${maxRows}` };
    }
    const fixedRows = CREATE_ROWS_FIXED + CREATE_ROWS_PER_FLEET * S.maxFleetsPerSide + FIXED_DEFENSE_EXTRA_ROWS;
    if (Number.isSafeInteger(maxRows) && fixedRows > maxRows) {
      return { ok: false, reason: "BATTLE_PERSISTENCE_FIT", detail: `battle.maxFleetsPerSide=${S.maxFleetsPerSide}: `
        + `a battle against sentries needs ${fixedRows} rows > persistence.maxRowsPerTransaction=${maxRows}` };
    }
    const builtParams = buildResolverParams(config);
    if (!builtParams.ok) return { ok: false, reason: "BATTLE_PARAMS_INVALID", detail: builtParams.detail };
    const made = createStrengthCatalog(undefined, { groupConfidence: S.strengthGroupConfidence,
      unknownTypeConfidence: S.strengthUnknownTypeConfidence });
    if (!made.ok) return { ok: false, reason: "BATTLE_CATALOG_INVALID", detail: made.detail };
    const resolver = deps.resolver || require("./resolverInternalV1");
    const params = builtParams.params;
    const catalog = made.catalog;
    const selfTest = resolver.resolve({ ...SELF_TEST_INPUT, maxResolutionMs: Math.min(SELF_TEST_INPUT.maxResolutionMs,
      S.maxResolutionMs) }, catalog, params);
    if (!selfTest || selfTest.ok !== true) {
      return { ok: false, reason: selfTest && selfTest.reason === "CATALOG_INVALID" ? "BATTLE_CATALOG_INVALID"
        : "BATTLE_PARAMS_INVALID", detail: `self-test: ${(selfTest && selfTest.detail) || "no result"}` };
    }

    const metrics = telemetryOf(deps.telemetry || null);
    const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
    const counters = {};
    let seq = 0;
    let state = STATE_READY;
    let stopReason = null;
    const recentSettled = [];
    const bump = (name, n = 1) => {
      if (!(n > 0)) return;
      counters[name] = (counters[name] || 0) + n;
      seq += 1;
      metrics.count(`battle.${name}`, n);
    };
    const onCount = (name, n) => {
      seq += 1;
      metrics.count(name, n);
    };
    const isActive = () => state === STATE_READY;
    const settlementRows = settlementRowsLimit(config);
    const battleRepository = createBattleRepository({ journal: persistence.journal, fleetRepository: fleets.repository,
      clock, ids, worldSeed: persistence.worldSeed, onCount,
      limits: { maxFleetsPerSide: S.maxFleetsPerSide, maxCompositionEntries: config.fleets.maxCompositionEntries,
        maxShipsPerFleet: config.fleets.maxShipsPerFleet, maxResolutionMs: S.maxResolutionMs,
        maxInputBytes: S.maxInputBytes, maxResultBytes: S.maxResultBytes, maxListLimit: S.maxListLimit,
        maxSettlementRows: settlementRows } });
    const cooldownRepository = createCooldownRepository({ journal: persistence.journal, clock });

    const currentGraph = () => {
      try {
        const r = deps.graph && typeof deps.graph.getGraph === "function" ? deps.graph.getGraph() : null;
        return r && r.ok === true && r.graph ? r.graph : null;
      } catch (_err) {
        return null;
      }
    };
    const worldRepository = deps.world && deps.world.repository ? deps.world.repository : null;
    const gridContactsEnabled = Boolean(bc.gridContacts && bc.gridContacts.enabled === true);
    const contacts = createContactService({ store, scheduler, battleRepository, cooldownRepository,
      fleetRepository: fleets.repository, getGraph: currentGraph, worldRepository,
      resolverVersion: resolver.RESOLVER_VERSION || "internal-v1",
      settings: { engageDelayMs: S.engageDelayMs, recontactCooldownMs: S.recontactCooldownMs,
        contactScanMaxFleets: S.contactScanMaxFleets, maxResolutionMs: S.maxResolutionMs,
        stationGarrisonEnabled: Boolean(config.siege && config.siege.stationGarrisonEnabled === true),
        structureLiveCombatEnabled: Boolean(bc.structureLiveCombat && bc.structureLiveCombat.enabled === true),
        influenceGarrison: bc.influenceGarrison === "off" ? "off" : "legacy",
        releaseContactEnabled: Boolean(bc.releaseContact && bc.releaseContact.enabled === true),
        capsuleerTripsFightable: Boolean(bc.capsuleerTripsFightable && bc.capsuleerTripsFightable.enabled === true),
        gridContactsEnabled,
        assemblyEnabled: Boolean(bc.assembly && bc.assembly.enabled === true),
        assemblyGraceMs: bc.assemblyGraceMs,
        assemblyRecheckMs: bc.assemblyRecheckMs, assemblyMaxRounds: bc.assemblyMaxRounds,
        declineEnabled: Boolean(bc.decline && bc.decline.enabled === true),
        declineRatioPermille: bc.declineRatioPermille,
        retreatLimits: { retreatSearchMaxJumps: S.retreatSearchMaxJumps,
          retreatSearchMaxSystems: S.retreatSearchMaxSystems, retreatMaxCandidates: S.retreatMaxCandidates } },
      powerPerPoint: Number(bc.resolverGarrisonDpsPerPoint) > 0 && Number(bc.resolverGarrisonEhpPerPoint) > 0
        ? Math.sqrt(Number(bc.resolverGarrisonDpsPerPoint) * Number(bc.resolverGarrisonEhpPerPoint)) : 0,
      travel: fleets.travel || null,
      getStrategy: typeof deps.getStrategy === "function" ? deps.getStrategy : undefined,
      grid: fleets.grid || null,
      getStations: typeof deps.getStations === "function" ? deps.getStations : undefined,
      getSiege: typeof deps.getSiege === "function" ? deps.getSiege : undefined,
      getDevIndices: typeof deps.getDevIndices === "function" && config.devIndices
        && config.devIndices.enabled === true && config.devIndices.garrisonEnabled === true ? deps.getDevIndices
        : undefined,
      limits: { maxFleetsPerSide: S.maxFleetsPerSide, maxSettlementRows: settlementRows },
      isHostile: createHostility(), bump, logger, isActive });

    const wrecks = deps.wrecks || null;
    let wrecksOn = false;
    try {
      wrecksOn = Boolean(wrecks && wrecks.consequence && wrecks.getStatus().state === STATE_READY);
    } catch (_err) {
      wrecksOn = false;
    }
    const occupation = deps.occupation || null;
    let occupationOn = false;
    try {
      occupationOn = Boolean(occupation && occupation.consequence && occupation.getStatus().state === STATE_READY);
    } catch (_err) {
      occupationOn = false;
    }
    const siegeOn = Boolean(typeof deps.getSiege === "function" && config.siege && config.siege.enabled === true);
    const intelOn = Boolean(typeof deps.getStrategy === "function" && isModuleEnabled(config, "strategy"));
    const treasuryLossOn = Boolean(typeof deps.getTreasury === "function" && isModuleEnabled(config, "strategy")
      && config.treasury && config.treasury.enabled === true && config.treasury.lossesEnabled === true);
    const crewsOn = Boolean(typeof deps.getCrews === "function" && config.crews && config.crews.enabled === true);
    const sentriesCfg = config.sentries || null;
    const sentriesOn = Boolean(typeof deps.getSentries === "function" && sentriesCfg && sentriesCfg.enabled === true
      && sentriesCfg.battle && sentriesCfg.battle.enabled === true);
    const wbCfg = config.worldBosses || null;
    const worldBossesOn = Boolean(typeof deps.getWorldBosses === "function" && wbCfg && wbCfg.enabled === true
      && wbCfg.clash && wbCfg.clash.enabled === true);
    const skipFixed = (inner) => skipFixedDefense(inner, () => bump("consequenceFixedDefenseSkipped"));
    const consequences = [...(wrecksOn ? [liveSkippingWrecks(wrecks.consequence)] : []), contacts.consequence,
      ...(occupationOn ? [skipFixed(occupation.consequence)] : []),
      ...(siegeOn ? [skipFixed(lazySiegeConsequence(deps.getSiege))] : []),
      ...(intelOn ? [skipFixed(lazyIntelConsequence(deps.getStrategy))] : []),
      ...(treasuryLossOn ? [lazyTreasuryConsequence(deps.getTreasury)] : []),
      ...(crewsOn ? [lazyCrewsConsequence(deps.getCrews)] : []),
      ...(sentriesOn ? [lazySentriesConsequence(deps.getSentries, () => bump("consequenceSentriesOff"))] : []),
      ...(worldBossesOn ? [lazyWorldBossesConsequence(deps.getWorldBosses)] : [])];
    const settlement = createSettlement({ journal: persistence.journal, battleRepository,
      fleetRepository: fleets.repository, travel: fleets.travel, getGraph: currentGraph, worldRepository,
      limits: { maxResultBytes: S.maxResultBytes, maxSettlementRows: settlementRows,
        retreatSearchMaxJumps: S.retreatSearchMaxJumps, retreatSearchMaxSystems: S.retreatSearchMaxSystems,
        retreatMaxCandidates: S.retreatMaxCandidates }, consequences, onCount });
    const live = createLiveBridge({ journal: persistence.journal, battleRepository,
      memberRepository: createLiveMemberRepository({ clock }), settlement, scheduler,
      limits: { maxListLimit: S.maxListLimit }, bump,
      garrisonLiveEnabled: Boolean(config.battle.garrisonLive && config.battle.garrisonLive.enabled === true) });

    const createFixedDefenseBattle = (tx, spec, key) => {
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      const permanentOf = (r) => (FIXED_DEFENSE_PERMANENT.includes(r.reason) ? { ...r, permanent: true } : r);
      const s = spec && typeof spec === "object" && !Array.isArray(spec) ? spec : null;
      const badKey = s ? Object.keys(s).find((k) => !FIXED_DEFENSE_SPEC_KEYS.includes(k)) : "spec";
      if (badKey !== undefined) return permanentOf({ ok: false, reason: "INPUT_INVALID", detail: `spec: ${badKey}` });
      if (!Number.isSafeInteger(s.at) || s.at < 0) return permanentOf({ ok: false, reason: "INPUT_INVALID", detail: "at" });
      if (!s.fixedDefenses || typeof s.fixedDefenses !== "object") {
        return permanentOf({ ok: false, reason: "INPUT_INVALID", detail: "fixedDefenses" });
      }
      const g = currentGraph();
      if (!g) return { ok: false, reason: "GRAPH_NOT_READY" };
      const system = Number.isSafeInteger(s.systemId) && s.systemId > 0 ? g.getSystem(s.systemId) : null;
      if (!system) return permanentOf({ ok: false, reason: "UNKNOWN_SYSTEM", systemId: s.systemId });
      const battleSpec = { systemId: s.systemId, environment: system.secClass, objective: FIXED_DEFENSE_OBJECTIVE,
        resolverVersion: resolver.RESOLVER_VERSION || "internal-v1", maxResolutionMs: S.maxResolutionMs,
        garrison: null, sideA: s.sideA, sideB: { factionId: null, fleets: [] }, fixedDefenses: s.fixedDefenses };
      if (s.grid !== undefined) battleSpec.grid = s.grid;
      const seen = persistence.journal.findByKey(tx, key);
      if (!seen.ok) return permanentOf(seen);
      if (seen.found) {
        const dup = battleRepository.createBattle(tx, battleSpec, key);
        if (!dup.ok) return permanentOf(dup);
        return { ok: true, duplicate: true, battleId: dup.battleId };
      }
      const battleId = ids.next("battle");
      const fleetIds = Array.isArray(s.sideA && s.sideA.fleets)
        ? s.sideA.fleets.map((f) => (f && typeof f.fleetId === "string" ? f.fleetId : null)).sort() : [];
      const dueAt = s.at + S.engageDelayMs;
      const r = persistence.journal.applyOnce(tx, { key: `${key}:fd`, aggregate: { type: "battle", id: battleId },
        eventType: FIXED_DEFENSE_EVENT, payload: { systemId: s.systemId, fleetIds } }, (db) => {
        const created = battleRepository.createBattle(db, { ...battleSpec, battleId }, key);
        if (!created.ok) return created;
        if (created.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", stage: "create" };
        const u = live.markUnsupportedInTx(db, { battleId, expectedVersion: created.version,
          reason: FIXED_DEFENSE_HOLD_REASON });
        if (!u.ok) return u;
        if (u.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", stage: "unsupported" };
        const q = scheduler.enqueue(RESOLUTION_EVENT, battleId, dueAt, { battleId, at: dueAt }, resolveKey(battleId),
          { tx: db, chained: true });
        if (!q || q.ok !== true) return { ok: false, reason: (q && q.reason) || "ENQUEUE_FAILED", stage: "resolve" };
        return { ok: true };
      });
      if (!r.ok) return permanentOf(r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r);
      if (r.duplicate) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", permanent: true, detail: `${key}:fd` };
      bump("fixedDefenseCreated");
      return { ok: true, duplicate: false, battleId };
    };

    const materializationEnabled = isModuleEnabled(config, "materialization");
    const maxRadius = config.presence && Number.isSafeInteger(config.presence.maxRadius) ? config.presence.maxRadius
      : S.holdRadius;
    const holdRadius = materializationEnabled ? Math.max(0, Math.min(S.holdRadius, maxRadius)) : 0;
    const presenceState = () => {
      const presence = deps.presence || null;
      if (!presence || typeof presence.getStatus !== "function") return "disabled";
      try {
        const st = presence.getStatus();
        if (st && st.reason === "PRESENCE_DISABLED") return "disabled";
        return st && st.available === true && st.stale !== true ? "ready" : "unknown";
      } catch (_err) {
        return "unknown";
      }
    };
    const presencePolicy = () => {
      const p = presenceState();
      return p === "disabled" ? p : `${p} radius:${holdRadius}`;
    };
    const telemetryCfg = config.telemetry || {};
    const slowLog = createSlowOpLog({ slowOpMs: telemetryCfg.slowOpMs, perMin: telemetryCfg.slowOpLogPerMin, nowMs,
      logger });
    const resolution = createResolutionService({ store, battleRepository, settlement, cooldownRepository, contacts,
      resolver, catalog, params, getPresence: () => deps.presence || null, hooks: deps.hooks,
      settings: { holdRecheckMs: S.holdRecheckMs, holdWhenPresenceUnknown: S.holdWhenPresenceUnknown,
        recontactCooldownMs: S.recontactCooldownMs, maxAttempts: config.scheduler.maxAttempts,
        logSettledPerMin: S.logSettledPerMin, materializationEnabled, holdRadius,
        neighborHoldMaxMs: S.neighborHoldMaxMs },
      bump, observe: (name, v) => metrics.observe(`battle.${name}`, v), slowLog, logger, nowMs,
      onSettled: (entry) => {
        recentSettled.unshift(entry);
        if (recentSettled.length > RECENT_SETTLED) recentSettled.length = RECENT_SETTLED;
      } });
    const reconcile = createReconcile({ store, scheduler, battleRepository, fleetRepository: fleets.repository,
      settings: { holdRecheckMs: S.holdRecheckMs, reconcileMaxBattles: S.reconcileMaxBattles }, bump,
      gauge: (name, v) => {
        seq += 1;
        metrics.gauge(`battle.${name}`, v);
      }, logger });

    const quota = config.limits.maxBattleResolutionsPerPass;
    const registrations = [];
    const unregisterAll = () => {
      for (const r of registrations.splice(0)) swallow(() => r.unregister());
    };
    const liveRecovery = createLiveRecovery({ store, battleRepository, live, bump, logger,
      getStructureSeam: typeof deps.getStructureSeam === "function" ? deps.getStructureSeam : undefined });

    for (const [type, fn, opts] of [[RESOLUTION_EVENT, resolution.onResolution, { maxPerPass: quota }],
      [CONTACT_EVENT, contacts.onContactCheck, undefined], [RECONCILE_EVENT, reconcile.onReconcile, undefined],
      [LIVE_RECOVER_EVENT, liveRecovery.onLiveRecover, { maxPerPass: quota }]]) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn, opts);
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || !r.ok) {
        unregisterAll();
        return { ok: false, reason: "BATTLE_START_FAILED", detail: `handler ${type}: ${(r && r.reason) || "no result"}` };
      }
      registrations.push(r);
    }
    undo.push(unregisterAll);
    const listener = fleets.travel.addArrivalListener(contacts.onArrival);
    if (!listener || !listener.ok) {
      unregisterAll();
      return { ok: false, reason: "BATTLE_START_FAILED", detail: `arrival listener: ${(listener && listener.reason)}` };
    }
    undo.push(() => listener.remove());
    let gridListener = null;
    if (gridContactsEnabled && fleets.grid && typeof fleets.grid.addGridArrivalListener === "function") {
      let gl;
      try {
        gl = fleets.grid.addGridArrivalListener(contacts.onGridArrival);
      } catch (err) {
        gl = { ok: false, reason: messageOf(err) };
      }
      if (gl && gl.ok === true && typeof gl.remove === "function") {
        gridListener = gl;
        undo.push(() => gl.remove());
      } else logger.log(`battle: grid contacts without grid arrivals (${(gl && gl.reason) || "no result"})`);
    }

    const bootAt = clock.now();

    const rec = scheduler.enqueue(RECONCILE_EVENT, "reconcile", bootAt + S.reconcileDelayMs,
      { afterId: null, page: 0, bootAt }, reconcileKey(bootAt, 0));
    if (!rec || !rec.ok) logger.log(`battle: reconcile not scheduled - ${(rec && rec.reason) || "no result"}`);

    const countByState = () => {
      const r = store.transaction("battle.countByState", (tx) => battleRepository.countByState(tx));
      return r.ok ? r.value : { ok: false, reason: r.reason || "TX_FAILED" };
    };
    const getStatus = () => Object.freeze({ state, reason: stopReason, seq, counters: Object.freeze({ ...counters }),
      presencePolicy: presencePolicy(), quota, consequences: Object.freeze(consequences.map((c) => c.name)),
      lastQuarantine: settlement.getCounters().lastQuarantine, lastRefusal: settlement.getCounters().lastRefusal,
      recentSettled: Object.freeze([...recentSettled]) });

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = views.registerView(VIEW_ID, buildBattlesView({ store, repository: battleRepository, getStatus,
        getWrecks: () => (wrecksOn ? wrecks : null) }));
      if (r && r.ok) {
        viewHandle = r;
        undo.push(() => r.unregister());
      }
      else logger.log(`battle: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    let openLayerHandle = null;
    const observer = config.observer || {};
    if (observer.galaxyEnabled === true && observer.galaxyBattlesOpenEnabled === true && views
      && typeof views.registerView === "function") {
      const r = views.registerView(OPEN_LAYER_ID, buildBattlesOpenLayerView({ store, repository: battleRepository,
        clock, getGovernor: deps.getGovernor, telemetry: deps.telemetry || null, nowMs: deps.nowMs,
        maxBattles: observer.galaxyBattlesOpenMaxBattles, maxLines: observer.galaxyBattlesOpenMaxLines,
        refreshMs: observer.galaxyBattlesOpenRefreshMs }));
      if (r && r.ok) {
        openLayerHandle = r;
        undo.push(() => r.unregister());
      } else logger.log(`battle: view ${OPEN_LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const testing = config.testing || {};
    if (testing.battleDemo === true) {
      const runDemo = () => {
        const g = currentGraph();
        if (!g) {
          logger.log("battle: demo refused - GRAPH_NOT_READY");
          return;
        }
        if (state !== STATE_READY) return;
        seedDemo({ store, fleetRepository: fleets.repository, scheduler, graph: g, presence: deps.presence || null,
          testing, filePath: persistence.filePath, clock, logger });
      };
      if (currentGraph()) runDemo();
      else if (deps.graph && typeof deps.graph.whenReady === "function") {
        Promise.resolve().then(() => deps.graph.whenReady()).then(runDemo, () => logger.log(
          "battle: demo refused - GRAPH_NOT_READY"));
      } else logger.log("battle: demo refused - GRAPH_NOT_READY");
    }

    const counted = countByState();
    const byState = counted && counted.ok ? counted.counts : {};
    const open = OPEN_STATES.reduce((n, st) => n + (byState[st] || 0), 0);
    logger.log(`battle: running open=${counted && counted.ok ? open : "?"} quarantined=${byState.QUARANTINED || 0}`
      + ` presence=${presencePolicy()} wrecks=${wrecksOn ? "on" : "off"} quota=${quota}`);

    const facade = {
      repository: battleRepository,
      settlement,
      countByState,
      getStatus,
      requestContactCheckInTx: (tx, spec) => (state === STATE_READY ? contacts.requestContactCheckInTx(tx, spec)
        : { ok: false, reason: "BATTLE_STOPPED" }),
      requestReleaseContactInTx: (tx, info) => (state === STATE_READY ? contacts.requestReleaseCheckInTx(tx, info)
        : { ok: false, reason: "BATTLE_STOPPED" }),
      readCooldownsInTx: (tx, systemId) => (state === STATE_READY ? cooldownRepository.listForSystem(tx, systemId)
        : { ok: false, reason: "BATTLE_STOPPED" }),
      createFixedDefenseBattleInTx: (tx, spec, key) => (state === STATE_READY
        ? createFixedDefenseBattle(tx, spec, key) : { ok: false, reason: "BATTLE_STOPPED" }),
      live: Object.freeze(Object.fromEntries(LIVE_METHODS.map((name) => [name,
        (...args) => (state === STATE_READY ? live[name](...args) : { ok: false, reason: "BATTLE_STOPPED" })]))),
      stop(reason) {
        if (state === STATE_STOPPED) return;
        state = STATE_STOPPED;
        stopReason = reason === undefined ? null : String(reason);
        swallow(() => listener.remove());
        if (gridListener) swallow(() => gridListener.remove());
        unregisterAll();
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
        if (openLayerHandle) {
          const handle = openLayerHandle;
          openLayerHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, battle: Object.freeze(facade) };
  } catch (err) {
    for (const fn of undo.splice(0).reverse()) swallow(fn);
    return { ok: false, reason: "BATTLE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startBattle, createUnavailableBattle, lazySiegeConsequence, lazyIntelConsequence,
  lazyTreasuryConsequence, lazyCrewsConsequence, liveSkippingWrecks, skipFixedDefense, lazySentriesConsequence,
  lazyWorldBossesConsequence };
