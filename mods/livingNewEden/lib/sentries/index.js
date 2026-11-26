"use strict";

const { isModuleEnabled } = require("../../config");
const { createSentryRepository } = require("./repository");
const { createSentryService } = require("./service");
const { VIEW_ID, SYSTEM_VIEW_ID, buildSentriesViews } = require("./view");
const S = require("./schema");
const { WEAPON_TYPES, DEFAULT_AMMO, kindOfType, LOOK_CANDIDATES,
  typeIdsOfKind } = require("../adapter/data/sentryTypes");
const { GROUPS: STRENGTH_GROUPS } = require("../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../battle/strength");
const { capitalPowerOverlayOf } = require("../battle/data/capitalStrengthRows");
const { huntThresholds } = require("../playerHunt/policy");
const { parseNeutralPolicy } = require("../playerHunt/schema");

const SCHEDULER_READY = "ready";
const UNAVAILABLE = "SENTRIES_UNAVAILABLE";
const START_FAILED = "SENTRIES_START_FAILED";
const COUNT_KEYS = Object.freeze(["anchorMinDistanceM", "anchorMaxDistanceM", "minSpacingM", "armDelayMs",
  "accessRangeM", "maxPerAnchor", "maxTotal", "maxAnchorsRead", "reconcileIntervalMs", "reconcileMaxRows",
  "maxHealsPerPass", "retentionMs", "pruneBatch"]);
const PLAYER_COUNT_KEYS = Object.freeze(["maxPerSystemPerOwner", "maxPerOwner"]);
const FACTION_COUNT_KEYS = Object.freeze(["costIsk", "minBalanceMultiple", "maxPerFaction", "maxPerSystem",
  "maxBuildsPerReview", "maxCandidateSystems", "buildDelayMs", "ringDistanceM", "topUpBelowPermille",
  "maxTopUpsPerPass"]);
const BATTLE_COUNT_KEYS = Object.freeze(["roundMs", "maxFleetsRead", "maxStandingReads", "maxSystemsPerBootstrap",
  "maxSentriesPerBattle", "dpsPermille", "damageTakenPermille", "attackerRetreatLossPermille", "defaultDesignSig"]);
const BATTLE_POSITIVE_KEYS = Object.freeze(["roundMs", "maxSentriesPerBattle", "damageTakenPermille",
  "defaultDesignSig"]);
const FACADE_METHODS = Object.freeze(["getMode", "getStatus", "whenReady", "reconcile", "isArmed", "listLiveInSystem",
  "markEnded", "readForReview", "requestBuildInTx", "noteCommitted", "stop", "battleConsequence", "kindOf",
  "listLiveOfKind", "ownerOnlineOf"]);
const stubKindOf = (ref) => {
  const kind = ref && typeof ref === "object" ? kindOfType(ref.typeId) : null;
  return kind === null ? "sentry" : kind;
};

const messageOf = (err) => String((err && err.message) || err);

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableSentries(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE, detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const off = Object.freeze({ ok: true, mode: "off", factionLive: 0, total: 0, rows: Object.freeze([]),
    truncated: false });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, whenReady: () => Promise.resolve(status),
    reconcile: () => refusal, isArmed: () => false, listLiveInSystem: () => [], markEnded: () => refusal,
    readForReview: () => off, requestBuildInTx: () => Object.freeze({ ok: false, reason: "SENTRY_OFF" }),
    battleConsequence: null,
    kindOf: stubKindOf, listLiveOfKind: () => [], ownerOnlineOf: () => false,
    noteCommitted() {}, stop() {} });
}

function battleConsequenceOf(service) {
  return Object.freeze({ name: "sentries", apply: (tx, settled, ck) => service.battleConsequence(tx, settled, ck) });
}

function factionNamesOf(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

const LOOK_OPTIONAL = Object.freeze(["defensePresentation", "sentryLook"]);

function resolveLook(C, seam, logger, service) {
  const HV = C.heavy && typeof C.heavy === "object" ? C.heavy : {};
  if (HV.enabled !== true) return null;
  const id = HV.lookTypeId;
  if (!Number.isSafeInteger(id) || id === 0) return null;
  const refused = (why) => {
    logger.log(`sentries: look type ${id} ${why} - battery look stays`);
    service.noteLookRefused();
    return null;
  };
  if (!LOOK_CANDIDATES.includes(id)) return refused("not a candidate");
  for (const group of LOOK_OPTIONAL) {
    if (hasOwnKey(seam.optional, group)) return refused(`${group} ${seam.optional[group]}`);
  }
  let r;
  try {
    r = typeof seam.seam.resolveLookType === "function" ? seam.seam.resolveLookType(id) : null;
  } catch (err) {
    r = { ok: false, reason: messageOf(err) };
  }
  if (!r || r.ok !== true) return refused(`unread ${(r && r.reason) || "no result"}`);
  return { typeIds: typeIdsOfKind("heavy_sentry"), graphicID: r.graphicID,
    slimTypeID: HV.lookMode === "type" ? id : null };
}

const hasOwnKey = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

function seamOf(adapter) {
  if (!adapter || typeof adapter.sentrySeams !== "function" || typeof adapter.bindSentryPolicy !== "function") {
    return { ok: false, detail: "adapter" };
  }
  let r;
  try {
    r = adapter.sentrySeams();
  } catch (err) {
    return { ok: false, detail: messageOf(err) };
  }
  if (!r || r.ok !== true || !r.seam) return { ok: false, detail: String((r && (r.detail || r.reason)) || "?") };
  return { ok: true, seam: r.seam, optional: r.optional || {} };
}

function startSentries(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.sentries || config.sentries.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function"
      || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: START_FAILED, detail: "clock" };
    const C = config.sentries;
    if (!C.player || typeof C.player !== "object") return { ok: false, reason: START_FAILED, detail: "sentries.player" };
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 0) return { ok: false, reason: START_FAILED, detail: `sentries.${key}` };
    }
    for (const key of PLAYER_COUNT_KEYS) {
      if (!Number.isSafeInteger(C.player[key]) || C.player[key] < 0) {
        return { ok: false, reason: START_FAILED, detail: `sentries.player.${key}` };
      }
    }
    const factionOn = C.faction && typeof C.faction === "object" && C.faction.enabled === true;
    if (factionOn) {
      for (const key of FACTION_COUNT_KEYS) {
        if (!Number.isSafeInteger(C.faction[key]) || C.faction[key] < 0) {
          return { ok: false, reason: START_FAILED, detail: `sentries.faction.${key}` };
        }
      }
    }
    const battleWanted = C.battle && typeof C.battle === "object" && C.battle.enabled === true;
    if (battleWanted) {
      for (const key of BATTLE_COUNT_KEYS) {
        if (!Number.isSafeInteger(C.battle[key]) || C.battle[key] < 0) {
          return { ok: false, reason: START_FAILED, detail: `sentries.battle.${key}` };
        }
      }
      for (const key of BATTLE_POSITIVE_KEYS) {
        if (C.battle[key] <= 0) return { ok: false, reason: START_FAILED, detail: `sentries.battle.${key}` };
      }
    }
    if (C.anchorMaxDistanceM <= C.anchorMinDistanceM) {
      return { ok: false, reason: START_FAILED, detail: `sentries.anchorMaxDistanceM ${C.anchorMaxDistanceM} <= `
        + `sentries.anchorMinDistanceM ${C.anchorMinDistanceM}` };
    }
    const seam = seamOf(deps.adapter);
    if (!seam.ok) return { ok: false, reason: "SENTRY_SEAM_UNAVAILABLE", detail: seam.detail };
    const adapter = deps.adapter;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const graph = deps.graph || null;
    const repository = createSentryRepository({ journal: persistence.journal });
    const fleets = deps.fleets || null;
    const fleetsOk = Boolean(fleets && fleets.repository && typeof fleets.repository.listFleetsInSystem === "function"
      && fleets.travel && typeof fleets.travel.addArrivalListener === "function");
    if (battleWanted && !fleetsOk) logger.log("sentries: battle rounds off - fleets unavailable");
    const chainWanted = battleWanted;
    const huntSettings = config.playerHunt && typeof config.playerHunt === "object" ? config.playerHunt : {};
    const service = createSentryService({ store: persistence.store, repository, seam: seam.seam, scheduler, config,
      clock, getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null),
      getTreasury: typeof deps.getTreasury === "function" ? deps.getTreasury : null,
      journal: persistence.journal, fleetRepository: chainWanted && fleetsOk ? fleets.repository : null,
      grid: chainWanted && fleetsOk && C.battle.gridEnabled === true && fleets.grid ? fleets.grid : null,
      getBattle: typeof deps.getBattle === "function" ? deps.getBattle : null,
      getPresence: typeof deps.getPresence === "function" ? deps.getPresence : null,
      getOwnerOnline: typeof deps.getOwnerOnline === "function" ? deps.getOwnerOnline : null,
      groups: expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy)),
      hostility: { readStanding: deps.adapter && typeof deps.adapter.readCharacterStanding === "function"
        ? (characterId, factionId) => deps.adapter.readCharacterStanding(characterId, factionId) : null,
      getFactionKind: typeof deps.getFactionKind === "function" ? deps.getFactionKind : null,
      isFactionEnemy: typeof deps.isFactionEnemy === "function" ? deps.isFactionEnemy : null,
      thresholds: huntThresholds(huntSettings), neutralPolicy: parseNeutralPolicy(huntSettings.neutralPolicy) || {} },
      telemetry: deps.telemetry || null, logger });

    let registration;
    try {
      registration = scheduler.registerHandler(S.RECONCILE_EVENT_TYPE, service.onReconcile, { maxPerPass: 1 });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: START_FAILED, detail: `handler ${S.RECONCILE_EVENT_TYPE}: `
        + `${(registration && registration.reason) || "no result"}` };
    }
    let deployRegistration;
    try {
      deployRegistration = scheduler.registerHandler(S.DEPLOY_EVENT_TYPE, service.onDeploy,
        { maxPerPass: Math.max(1, (C.faction && C.faction.maxBuildsPerReview) || 1) });
    } catch (err) {
      deployRegistration = { ok: false, reason: messageOf(err) };
    }
    if (!deployRegistration || !deployRegistration.ok) {
      swallow(() => registration.unregister());
      return { ok: false, reason: START_FAILED, detail: `handler ${S.DEPLOY_EVENT_TYPE}: `
        + `${(deployRegistration && deployRegistration.reason) || "no result"}` };
    }
    let attritionRegistration;
    try {
      attritionRegistration = scheduler.registerHandler(S.ATTRITION_EVENT_TYPE, service.onAttrition,
        { maxPerPass: 1 });
    } catch (err) {
      attritionRegistration = { ok: false, reason: messageOf(err) };
    }
    if (!attritionRegistration || !attritionRegistration.ok) {
      swallow(() => registration.unregister());
      swallow(() => deployRegistration.unregister());
      return { ok: false, reason: START_FAILED, detail: `handler ${S.ATTRITION_EVENT_TYPE}: `
        + `${(attritionRegistration && attritionRegistration.reason) || "no result"}` };
    }
    let battleDamageRegistration;
    try {
      battleDamageRegistration = scheduler.registerHandler("SENTRY_BATTLE_DAMAGE", service.onBattleDamage,
        { maxPerPass: 1 });
    } catch (err) {
      battleDamageRegistration = { ok: false, reason: messageOf(err) };
    }
    if (!battleDamageRegistration || !battleDamageRegistration.ok) {
      swallow(() => registration.unregister());
      swallow(() => deployRegistration.unregister());
      swallow(() => attritionRegistration.unregister());
      return { ok: false, reason: START_FAILED, detail: `handler SENTRY_BATTLE_DAMAGE: `
        + `${(battleDamageRegistration && battleDamageRegistration.reason) || "no result"}` };
    }
    let listener = null;
    if (service.chainEnabled()) {
      const l = fleets.travel.addArrivalListener(service.onArrival);
      if (l && l.ok) listener = l;
      else logger.log(`sentries: battle arrival listener refused ${(l && l.reason) || "no result"}`);
    }
    let gridListener = null;
    if (service.chainEnabled() && C.battle.gridEnabled === true && fleets.grid
      && typeof fleets.grid.addGridArrivalListener === "function") {
      let gl;
      try {
        gl = fleets.grid.addGridArrivalListener(service.onGridArrival);
      } catch (err) {
        gl = { ok: false, reason: messageOf(err) };
      }
      if (gl && gl.ok === true && typeof gl.remove === "function") gridListener = gl;
      else logger.log(`sentries: grid arrival listener refused ${(gl && gl.reason) || "no result"}`);
    }
    const viewHandles = [];
    const unregisterAll = () => {
      swallow(() => registration.unregister());
      swallow(() => deployRegistration.unregister());
      swallow(() => attritionRegistration.unregister());
      swallow(() => battleDamageRegistration.unregister());
      if (listener !== null) swallow(() => listener.remove());
      if (gridListener !== null) swallow(() => gridListener.remove());
      for (const h of viewHandles.splice(0)) swallow(() => h.unregister());
    };
    if (factionOn) {
      const pairs = WEAPON_TYPES.map((t) => ({ typeId: t.typeId, chargeTypeId: DEFAULT_AMMO[t.family].typeId }));
      const checked = typeof seam.seam.checkFactionAmmo === "function" ? seam.seam.checkFactionAmmo(pairs) : null;
      if (checked && checked.ok === true) {
        service.setNoAmmoTypes(checked.incompatible);
        if (checked.incompatible.length > 0) {
          logger.log(`sentries: default ammo refused by the vendor for types ${checked.incompatible.join(",")} - `
            + "those faction sentries deploy without ammo");
        }
      } else {
        logger.log(`sentries: faction ammo check unavailable ${(checked && (checked.detail || checked.reason)) || "?"}`);
      }
    }
    const policy = Object.freeze({ anchor: service.anchor, online: service.online, isArmed: service.isArmed });
    const look = resolveLook(C, seam, logger, service);
    const bound = adapter.bindSentryPolicy(policy, { accessRangeM: C.accessRangeM, messages: S.messagesOf(C), look });
    if (!bound || !bound.ok) {
      unregisterAll();
      return { ok: false, reason: START_FAILED, detail: `policy: ${(bound && bound.reason) || "no result"}` };
    }
    for (const [group, why] of Object.entries(seam.optional)) {
      if (LOOK_OPTIONAL.includes(group)) continue;
      logger.log(`sentries: optional wrap ${group} ${why} - the vendor text stays`);
      service.noteSeamRefused();
    }
    const HV = C.heavy && typeof C.heavy === "object" ? C.heavy : {};
    const lookStatus = () => {
      if (look === null) return null;
      const st = typeof seam.seam.lookStats === "function" ? seam.seam.lookStats() : null;
      return Object.freeze({ typeId: HV.lookTypeId, mode: HV.lookMode, applied: st ? st.applied : 0,
        skipped: st ? st.skipped : 0 });
    };

    const armed = service.rebuildArmed();
    if (!armed.ok) logger.log(`sentries: armed map not rebuilt ${armed.reason}; the reconcile fills it`);
    const rec = service.reconcile(clock.now(), "");
    if (!rec.ok) logger.log(`sentries: reconcile failed ${rec.reason}; the chain retries`);
    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`sentries: reconcile chain bootstrap failed ${boot.reason}; the next start retries`);
    const kick = service.kickBattle(clock.now());
    if (!kick.ok) logger.log(`sentries: battle bootstrap failed ${kick.reason}; the next reconcile retries`);
    const views = deps.views;
    const maxRows = config.observer && config.observer.sentriesMaxRows;
    if (views && typeof views.registerView === "function" && Number.isSafeInteger(maxRows) && maxRows > 0) {
      const built = buildSentriesViews({ store: persistence.store, repository, getSeam: () => seam.seam,
        getGovernor: deps.getGovernor, graph, factionNames: factionNamesOf(adapter), maxRows });
      for (const [id, def] of [[VIEW_ID, built.sentries], [SYSTEM_VIEW_ID, built.system]]) {
        const r = views.registerView(id, def);
        if (r && r.ok) viewHandles.push(r);
        else logger.log(`sentries: view ${id} not registered - ${(r && r.reason) || "no result"}`);
      }
    }
    logger.log(`sentries: running armed=${armed.ok ? armed.armed : "?"} band=${C.anchorMinDistanceM}-`
      + `${C.anchorMaxDistanceM}m player=${C.player.enabled === true} faction=${factionOn} `
      + `battle=${service.battleEnabled()}`);

    const facade = {
      getMode: service.getMode,
      getStatus: () => Object.freeze({ ...service.getStatus(), look: lookStatus() }),
      whenReady: () => Promise.resolve(facade.getStatus()),
      reconcile: (at) => service.reconcile(Number.isSafeInteger(at) ? at : clock.now(), ""),
      isArmed: service.isArmed,
      listLiveInSystem: service.listLiveInSystem,
      markEnded: service.markEnded,
      readForReview: service.readForReview,
      requestBuildInTx: service.requestBuildInTx,
      noteCommitted: service.noteCommitted,
      battleConsequence: battleConsequenceOf(service),
      kindOf: service.kindOf,
      listLiveOfKind: service.listLiveOfKind,
      ownerOnlineOf: service.ownerOnlineOf,
      stop() {
        if (service.isStopped()) return;
        swallow(() => adapter.bindSentryPolicy(null));
        service.stop();
        unregisterAll();
      },
    };
    return { ok: true, sentries: Object.freeze(facade), service };
  } catch (err) {
    return { ok: false, reason: START_FAILED, detail: messageOf(err) };
  }
}

module.exports = { startSentries, createUnavailableSentries, FACADE_METHODS };
