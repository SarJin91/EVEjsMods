"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { createFactionIncursionRepository } = require("./repository");
const { createFactionIncursionService, COUNTER_NAMES, MODE } = require("./service");
const { parseClaimStates, parseFactionIds, POOL_MODE, POOL_ROWS_RESERVE, CONSEQUENCES_MODE } = require("./schema");
const { settleTxRowsBound } = require("./consequence");
const { buildUiEntries } = require("./presentation");
const { createHudDriver } = require("./hud");
const { createEffectsDriver } = require("./effects");
const { EMPIRE_FACTION_IDS } = require("./data/catalog");

const FACTION_INCURSIONS_METHODS = Object.freeze(["getStatus", "runPass", "listActive", "listUiEntries", "stop"]);

const messageOf = (err) => String((err && err.message) || err);

function templateNameIdOf(config) {
  const ui = config && config.invasions && config.invasions.incursionUi;
  const v = ui ? ui.templateNameID : 0;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function createUnavailableFactionIncursions(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, runPass: () => refusal, listActive: () => refusal,
    listUiEntries: () => refusal, stop() {} });
}

const MAX_POOL_PARTICIPANTS = 256;

function rewardsPoolOf(S, limits) {
  const R = S.rewards;
  if (!R || R.enabled !== true) return { mode: null, bound: 0, maxRows: null };
  if (!(R.hqPoolLp > 0)) return { mode: POOL_MODE.OFF, bound: 0, maxRows: null };
  const bound = R.maxPoolParticipants + POOL_ROWS_RESERVE;
  const maxRows = limits && Number.isSafeInteger(limits.maxRowsPerTransaction) ? limits.maxRowsPerTransaction : null;
  return { mode: maxRows !== null && bound > maxRows ? POOL_MODE.ROW_BOUND : POOL_MODE.ON, bound, maxRows };
}

function consequencesModeOf(S, limits, maxFactionsPerSystem) {
  const C = S && S.consequences;
  if (!C || C.enabled !== true) return { mode: null, bound: 0, maxRows: null };
  if (!(C.defeatInfluencePoints > 0) && !(C.expireInfluencePoints > 0)) {
    return { mode: CONSEQUENCES_MODE.OFF, bound: 0, maxRows: null };
  }
  const pool = S.rewardsPool === POOL_MODE.ON && S.rewards ? S.rewards.maxPoolParticipants : 0;
  const bound = settleTxRowsBound(maxFactionsPerSystem, pool);
  const maxRows = limits && Number.isSafeInteger(limits.maxRowsPerTransaction) ? limits.maxRowsPerTransaction : null;
  return { mode: maxRows !== null && bound > maxRows ? CONSEQUENCES_MODE.ROW_BOUND : CONSEQUENCES_MODE.ON, bound,
    maxRows };
}

function settingsOf(P) {
  if (!P || typeof P !== "object" || !P.settle || !P.influence) return { ok: false, key: "factionIncursions" };
  const claimStates = parseClaimStates(P.claimStates);
  if (claimStates === null) return { ok: false, key: "claimStates" };
  const parsedIds = parseFactionIds(P.factionIds);
  if (parsedIds === null) return { ok: false, key: "factionIds" };
  const allowEmpire = P.allowEmpireFactions === true;
  const factionIds = Object.freeze(parsedIds.filter((id) => allowEmpire || !EMPIRE_FACTION_IDS.includes(id)));
  const skippedEmpireFactionIds = Object.freeze(parsedIds.filter((id) => !factionIds.includes(id)));
  const I = P.influence;
  const ints = { maxActive: P.maxActive, maxActivePerFaction: P.maxActivePerFaction, systems: P.systems,
    minSystems: P.minSystems, establishedMs: P.establishedMs, mobilizingMs: P.mobilizingMs,
    withdrawingMs: P.withdrawingMs, siteTtlMs: P.siteTtlMs, siteRespawnMs: P.siteRespawnMs,
    minSiteWindowMs: P.minSiteWindowMs, passIntervalMs: P.passIntervalMs, maxIncursionsPerPass: P.maxIncursionsPerPass,
    maxSitePlansPerPass: P.maxSitePlansPerPass, maxCreatesPerPass: P.maxCreatesPerPass,
    maxSettlementsPerPass: P.maxSettlementsPerPass, maxTargets: P.maxTargets,
    maxSiteClearsPerIncursion: P.maxSiteClearsPerIncursion, settleMaxAttempts: P.settleMaxAttempts,
    "influence.initialMaxMilli": I.initialMaxMilli, "influence.initialMinMilli": I.initialMinMilli,
    "influence.perCompletionMilli": I.perCompletionMilli, "influence.graceMinutes": I.graceMinutes,
    "influence.decayMilliPerHour": I.decayMilliPerHour, "influence.hqUnlockMilli": I.hqUnlockMilli };
  const H = P.hud && typeof P.hud === "object" ? P.hud : {};
  if (H.enabled === true) {
    Object.assign(ints, { "hud.refreshMs": H.refreshMs, "hud.maxSessionsPerSync": H.maxSessionsPerSync,
      "hud.removeTemplateID": H.removeTemplateID });
  }
  const E = P.effects && typeof P.effects === "object" ? P.effects : {};
  if (E.enabled === true) {
    Object.assign(ints, { "effects.maxRefreshPerPass": E.maxRefreshPerPass,
      "effects.refreshDeltaMilli": E.refreshDeltaMilli });
  }
  const R = P.rewards && typeof P.rewards === "object" ? P.rewards : {};
  if (R.enabled === true) {
    Object.assign(ints, { "rewards.hqPoolLp": R.hqPoolLp, "rewards.maxPoolParticipants": R.maxPoolParticipants,
      "rewards.poolMaxHoldPasses": R.poolMaxHoldPasses });
  }
  const C = P.consequences && typeof P.consequences === "object" ? P.consequences : {};
  if (C.enabled === true) {
    Object.assign(ints, { "consequences.defeatInfluencePoints": C.defeatInfluencePoints,
      "consequences.expireInfluencePoints": C.expireInfluencePoints });
  }
  for (const [key, v] of Object.entries(ints)) if (!Number.isSafeInteger(v) || v < 0) return { ok: false, key };
  if (R.enabled === true && (R.maxPoolParticipants < 1 || R.maxPoolParticipants > MAX_POOL_PARTICIPANTS)) {
    return { ok: false, key: "rewards.maxPoolParticipants" };
  }
  if (R.enabled === true && R.poolMaxHoldPasses < 1) return { ok: false, key: "rewards.poolMaxHoldPasses" };
  if (E.enabled === true && (E.refreshDeltaMilli < 1 || E.refreshDeltaMilli > 1000)) {
    return { ok: false, key: "effects.refreshDeltaMilli" };
  }
  if (H.enabled === true && H.refreshMs < 1) return { ok: false, key: "hud.refreshMs" };
  if (H.enabled === true && H.maxSessionsPerSync < 1) return { ok: false, key: "hud.maxSessionsPerSync" };
  if (I.initialMinMilli > I.initialMaxMilli) return { ok: false, key: "influence.initialMinMilli" };
  if (P.minSystems > P.systems || P.minSystems < 1) return { ok: false, key: "minSystems" };
  return { ok: true, settings: Object.freeze({ ...P, claimStates, factionIds, skippedEmpireFactionIds,
    settle: Object.freeze({ ...P.settle, enabled: P.settle.enabled === true }),
    influence: Object.freeze({ ...I }) }) };
}

function startFactionIncursions(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const P = config && config.factionIncursions;
    if (!P || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    const on = P.enabled === true;
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: on ? "dependency_disabled:persistence" : "disabled_by_config" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "FACTION_INCURSIONS_START_FAILED", detail: "clock" };
    }
    const repository = createFactionIncursionRepository();
    if (!on) {
      const c = persistence.store.transaction("factionIncursions.count", (db) => repository.countOpenInTx(db));
      if (!c.ok || !c.value || c.value.ok !== true || c.value.count === 0) return { ok: false, reason: "disabled_by_config" };
    }
    const parsed = settingsOf(P);
    if (!parsed.ok) {
      return { ok: false, reason: "FACTION_INCURSIONS_START_FAILED", detail: `factionIncursions.${parsed.key}` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const pool = rewardsPoolOf(parsed.settings, persistence.store.limits);
    if (on && pool.mode === POOL_MODE.ROW_BOUND) {
      logger.log(`factionIncursions: rewards pool off - ROW_BOUND ${pool.bound} > persistence.maxRowsPerTransaction `
        + `${pool.maxRows}`);
    }
    const S0 = pool.mode === null ? parsed.settings : Object.freeze({ ...parsed.settings, rewardsPool: pool.mode });
    const cons = on ? consequencesModeOf(S0, persistence.store.limits, config.world && config.world.maxFactionsPerSystem)
      : { mode: null };
    if (cons.mode === CONSEQUENCES_MODE.ROW_BOUND) {
      logger.log(`factionIncursions: consequences off - ROW_BOUND ${cons.bound} > persistence.maxRowsPerTransaction `
        + `${cons.maxRows}`);
    }
    const S = cons.mode === null ? S0 : Object.freeze({ ...S0, consequencesMode: cons.mode });
    const getter = (fn) => (typeof fn === "function" ? fn : () => null);
    let poller = null;
    let hud = null;
    let effects = null;
    const service = createFactionIncursionService({ store: persistence.store, journal: persistence.journal,
      repository, settings: S, clock, mode: on ? MODE.FULL : MODE.DRAIN,
      getWorldRepository: getter(deps.getWorldRepository), getOccupation: getter(deps.getOccupation),
      getHeavyEvents: getter(deps.getHeavyEvents), getGraph: getter(deps.getGraph), getGovernor: deps.getGovernor,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      onDrained: () => {
        if (poller) poller.stop();
      },
      onPassDone: () => {
        if (hud) hud.arm(0);
        if (effects) effects.publish();
      } });
    poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: S.passIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`factionIncursions: pass threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started.ok) {
      service.stop();
      return { ok: false, reason: "FACTION_INCURSIONS_START_FAILED", detail: `poller ${started.reason}` };
    }
    logger.log(on ? `factionIncursions: running factions=${S.factionIds.join(",")} settle=${S.settle.enabled} `
      + `claimStates=${S.claimStates.join(",")} maxActive=${S.maxActive} systems=${S.systems}/${S.minSystems}`
      + (S.rewardsPool ? ` rewardsPool=${S.rewardsPool}` : "")
      + (S.consequencesMode ? ` consequences=${S.consequencesMode}` : "")
      + (S.skippedEmpireFactionIds.length > 0 ? ` skippedEmpire=${S.skippedEmpireFactionIds.join(",")}` : "")
      : "factionIncursions: drain mode - open incursions are cancelled (DISABLED)");
    const uiOn = on && Boolean(S.ui) && S.ui.enabled === true;
    if (on && S.hud && S.hud.enabled === true) {
      hud = createHudDriver({ getAdapter: getter(deps.getAdapter), getPresence: getter(deps.getPresence),
        getGovernor: deps.getGovernor, listActive: (opts) => service.listActive(opts),
        settings: { refreshMs: S.hud.refreshMs, maxSessionsPerSync: S.hud.maxSessionsPerSync,
          removeTemplateID: S.hud.removeTemplateID, templateNameID: templateNameIdOf(config), maxActive: S.maxActive },
        telemetry: deps.telemetry || null, logger, now: () => clock.now(), setTimer: deps.setTimer });
      const h = hud.start();
      if (!h.ok) {
        logger.log(`factionIncursions: hud not started - ${h.reason}`);
        hud = null;
      } else {
        logger.log(`factionIncursions: hud running refreshMs=${S.hud.refreshMs} `
          + `maxSessionsPerSync=${S.hud.maxSessionsPerSync}`);
      }
    }
    if (on && S.effects && S.effects.enabled === true) {
      effects = createEffectsDriver({ getAdapter: getter(deps.getAdapter),
        listActive: (opts) => service.listActive(opts),
        settings: { maxActive: S.maxActive, maxRefreshPerPass: S.effects.maxRefreshPerPass,
          refreshDeltaMilli: S.effects.refreshDeltaMilli },
        bump: (name, n) => service.bump(name, n), telemetry: deps.telemetry || null, logger });
      logger.log(`factionIncursions: effects running maxRefreshPerPass=${S.effects.maxRefreshPerPass} `
        + `refreshDeltaMilli=${S.effects.refreshDeltaMilli}`);
    }
    const statusOf = () => {
      const base = service.getStatus();
      if (!hud && !effects) return base;
      return Object.freeze({ ...base, ...(hud ? { hud: hud.status() } : {}),
        ...(effects ? { effects: effects.status() } : {}) });
    };
    const facade = {
      getStatus: statusOf,
      runPass: (now) => service.runPass(now),
      listActive: (opts) => service.listActive(opts),
      listUiEntries(opts) {
        if (!uiOn || service.isStopped()) return { ok: true, entries: [] };
        const o = opts || {};
        const listed = service.listActive({ limit: S.maxActive || 1 });
        if (!listed.ok) return listed;
        return { ok: true, entries: buildUiEntries(listed.incursions, { templateNameID: o.templateNameID,
          maxEntries: o.maxEntries }) };
      },
      stop() {
        if (service.isStopped()) return;
        if (hud) hud.stop();
        if (effects) effects.stop();
        poller.stop();
        service.stop();
      },
    };
    return { ok: true, factionIncursions: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "FACTION_INCURSIONS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startFactionIncursions, createUnavailableFactionIncursions, settingsOf, rewardsPoolOf,
  consequencesModeOf, COUNTER_NAMES, FACTION_INCURSIONS_METHODS };
