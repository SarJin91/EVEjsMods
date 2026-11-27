"use strict";

const Module = require("node:module");
const workerThreads = require("node:worker_threads");
const defaultLogger = require("./lib/log");

const MOD_VERSION = "0.2.1";
const MOD_DIR = __dirname;

const INSTALL_FLAG = "__shipWingLoaderInstalled";
const NO_INSTALL_ENV = "SHIPWING_NO_INSTALL";
const ENV_ROLE_KEY = "EVEJS_GAMESTORE_OWNER_ROLE";
const BOOTSTRAP_REQUEST = /[\\/]bootstrap(\.js)?$/;
const NPC_BEHAVIOR_REQUEST = /[\\/]npcBehaviorLoop(\.js)?$/;
const SALVAGE_BOUNDARY_REQUEST = /[\\/]moduleCycleBoundarySnapshot(\.js)?$/;
const CLIENT_SOURCE_REL = "client/wing.py";

function exportHas(value, property, expectedType) {
  if (value === null || typeof value !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(value, property)) return false;
  return typeof value[property] === expectedType;
}

function failedConfig(err) {
  return {
    ok: false,
    config: { enabled: false, debug: false },
    sources: {},
    warnings: [],
    errors: [`config_load_failed: ${(err && err.message) || err}`],
  };
}

function enabledProblem(configResult) {
  const errors = Array.isArray(configResult.errors) ? configResult.errors : [];
  if (configResult.ok !== true) return `config error: ${errors[0] || "unknown"}`;
  const warnings = Array.isArray(configResult.warnings) ? configResult.warnings : [];
  const bad = warnings.find((w) => /(^|[\s:])(enabled|EVEJS_SHIPWING_ENABLED) must be/.test(String(w)));
  return bad ? `config warning: ${bad}` : null;
}

function safeLoadConfig(loadConfig) {
  try {
    const result = loadConfig();
    if (!result || typeof result !== "object" || !result.config || typeof result.config !== "object") {
      return failedConfig(new Error("loadConfig returned no config"));
    }
    return result;
  } catch (err) {
    return failedConfig(err);
  }
}

function logTelemetry(ctx, final) {
  const { formatTelemetry } = require("./lib/core/telemetry");
  const line = formatTelemetry({
    wing: ctx.wing ? ctx.wing.stats() : null,
    guards: ctx.guards ? ctx.guards.counters : null,
    store: ctx.store ? ctx.store.stats() : null,
    driver: ctx.driver ? ctx.driver.stats() : null,
    client: ctx.clientWindow && ctx.clientWindow.channel ? ctx.clientWindow.channel.stats() : null,
    delivery: ctx.clientDelivery && ctx.clientDelivery.delivery ? ctx.clientDelivery.delivery.stats() : null,
    mining: ctx.miningHook ? ctx.miningHook.stats() : null,
    salvage: ctx.salvageHook ? ctx.salvageHook.stats() : null,
    combat: ctx.combatAccess ? ctx.combatAccess.stats() : null,
    mirror: ctx.commandMirror ? ctx.commandMirror.stats() : null,
    safeLogoff: ctx.safeLogoffHook ? ctx.safeLogoffHook.stats() : null,
    npcAggro: ctx.npcAggro ? ctx.npcAggro.stats() : null,
    board: ctx.boardHook ? ctx.boardHook.stats() : null,
    start: ctx.state.startErrors || null,
  });
  if (!final && line === ctx.state.lastTelemetry) return;
  ctx.state.lastTelemetry = line;
  ctx.logger.log(final ? `${line} (shutdown)` : line);
}

function stopServices(ctx, reason) {
  if (ctx.state.stopped) return false;
  ctx.state.stopped = true;
  try {
    if (ctx.chat) ctx.chat.uninstall();
    if (ctx.commandMirror) ctx.commandMirror.stop();
    if (ctx.safeLogoffHook) ctx.safeLogoffHook.stop();
    if (ctx.npcAggro) ctx.npcAggro.deactivate();
    if (ctx.boardHook && typeof ctx.boardHook.stop === "function") ctx.boardHook.stop();
    if (ctx.clientDelivery && ctx.clientDelivery.delivery) ctx.clientDelivery.delivery.setReady(false);
    if (ctx.clientWindow && ctx.clientWindow.channel) ctx.clientWindow.channel.stop();
    if (ctx.driver) ctx.driver.stop();
    if (ctx.wing) ctx.wing.stop();
    ctx.logger.log(`stopped (${reason})`);
  } catch (err) {
    ctx.logger.logError(`stop failed (${reason})`, err);
  }
  try {
    if (ctx.burst) ctx.burst.clearAll();
  } catch (err) {
    ctx.logger.logError(`burst clear failed (${reason})`, err);
  }
  try {
    if (ctx.formations && ctx.formations.isDirty()) ctx.formations.flush();
  } catch (err) {
    ctx.logger.logError(`formation file flush failed (${reason})`, err);
  }
  try {
    if (ctx.uiPrefsApi) {
      ctx.uiPrefsApi.deactivate();
      require("./lib/channels/uiPrefsApi").unregisterUiPrefsApi(ctx.globalObj || globalThis, ctx.uiPrefsApi.api);
    }
    ctx.uiPrefsApi = null;
    if (ctx.uiPrefs && ctx.uiPrefs.isDirty()) ctx.uiPrefs.flush();
  } catch (err) {
    ctx.logger.logError(`ui prefs stop failed (${reason})`, err);
  }
  try {
    if (ctx.drones) ctx.drones.clearAll();
  } catch (err) {
    ctx.logger.logError(`drones clear failed (${reason})`, err);
  }
  try {
    if (ctx.liveEntry) require("./lib/core/liveSettings").unregisterLive(ctx.globalObj || globalThis, ctx.liveEntry);
    ctx.liveEntry = null;
  } catch (err) {
    ctx.logger.logError(`live settings unregister failed (${reason})`, err);
  }
  return true;
}

function startBoardHook(ctx, wing, live) {
  const { installBoardHookFromGame } = require("./lib/adapter/boardHook");
  const { createStowCargoFromGame } = require("./lib/adapter/cargoAccess");
  const liveAdapter = live.ok ? live.adapter : null;
  const stowCargo = ctx.config.boardEnabled === true
    ? createStowCargoFromGame(ctx.adapter, { config: ctx.config,
      emit: (ownerCharacterId, changes) => {
        const session = liveAdapter ? liveAdapter.findSession(ownerCharacterId) : null;
        if (session) liveAdapter.emitItemChanges(session, changes);
      } })
    : { ok: false, reason: "off" };
  const installed = installBoardHookFromGame(ctx.adapter, wing, ctx.config, {
    stowCargo: stowCargo.ok ? stowCargo.access : null, stowCargoReason: stowCargo.ok ? null : stowCargo.reason,
    live: live.ok ? live.adapter : null, boardReason: live.ok ? live.boardReason : live.reason, log: ctx.logger,
    boardServerReason: live.ok ? live.boardServerReason : live.reason,
    boardGhostReason: live.ok ? live.boardGhostReason : live.reason,
    boardStowReason: live.ok ? live.boardStowReason : live.reason,
    scoopReturnReason: live.ok ? live.scoopReturnReason : live.reason,
  });
  if (installed.ok) {
    ctx.boardHook = installed.hook;
    const h = installed.hook;
    ctx.logger.log(`board hook installed (ShipService.prototype.Handle_Board; range=${ctx.config.boardRangeMeters}m `
      + `cooldown=${ctx.config.boardCooldownMs}ms orphan=${ctx.config.boardOrphanEnabled === true
        ? `${ctx.config.boardOrphanGraceMs}ms hostRange=${ctx.config.boardHostRangeMeters}m` : "off"} `
      + `server=${h.serverBoard ? "ok" : h.serverReason} ghost=${h.ghostReason || "ok"} `
      + `stow=${h.stowReason || "ok"} stowCargo=${h.stowCargoReason || "ok"} scoop=${h.scoopReason || "ok"})`);
    return "ok";
  }
  if (installed.reason !== "off") ctx.logger.log(`board hook NOT installed - ${installed.reason}`);
  return installed.reason;
}

function startGuards(ctx, wing) {
  const { installGuardsFromGame } = require("./lib/adapter/guards");
  const guards = installGuardsFromGame(ctx.adapter, wing, ctx.config, { log: ctx.logger });
  ctx.guards = guards;
  if (guards.ok) {
    ctx.state.guardsReady = true;
    ctx.logger.log(`guards installed (ShipService ${guards.ship.guarded.length + guards.ship.already.length}, `
      + `InvBrokerService ${guards.invBroker.guarded.length + guards.invBroker.already.length} handlers guarded; `
      + `${guards.ship.readOnly.length + guards.invBroker.readOnly.length} read-only)`);
  } else {
    const failed = guards.ship ? [...guards.ship.failed, ...guards.invBroker.failed] : [];
    ctx.logger.log(`guards NOT installed - ${guards.reason}${failed.length ? ` (${failed.join(", ")})` : ""}; `
      + "launch refused (GUARDS_UNAVAILABLE)");
  }
}

function startLossHook(ctx, wing, live) {
  const { installLossHookFromGame } = require("./lib/adapter/lossHook");
  const installed = installLossHookFromGame(ctx.adapter, {
    wing, adapter: live.ok ? live.adapter : null, config: ctx.config,
  });
  if (installed.ok) {
    ctx.lossHook = installed.hook;
    ctx.state.lossReady = true;
    ctx.logger.log("loss hook installed (shipDestruction.destroyShipEntityWithWreck; "
      + `durableWreck=${ctx.config.durableWreck} skipInsurance=${ctx.config.lossSkipInsurance} `
      + `lossOnMissingTwin=${ctx.config.lossOnMissingTwin})`);
    return;
  }
  const reason = installed.reason === "loss_accessors_unavailable" && live.ok && live.lossReason
    ? live.lossReason : installed.reason;
  ctx.logger.log(`loss hook NOT installed - ${reason}; launch refused (LOSS_UNAVAILABLE)`);
}

function startTaskHooks(ctx, wing, _live) {
  const { installSceneGuardFromGame } = require("./lib/adapter/sceneGuard");
  const installed = installSceneGuardFromGame(ctx.adapter, { wing });
  if (!installed.ok) {
    ctx.logger.log(`derived-state guard NOT installed - ${installed.reason}; task verbs off, `
      + "launch refused (DERIVED_GUARD_UNAVAILABLE)");
    return installed.reason;
  }
  ctx.sceneGuard = installed.guard;
  ctx.state.derivedReady = true;
  ctx.logger.log("derived-state guard installed (SolarSystemScene.prototype.refreshShipEntityDerivedState); "
    + `verbs=${wing.SUPPORTED_VERBS.join("|")}`);
  return "ok";
}

function startMiningHook(ctx, wing) {
  if (ctx.config.miningEnabled !== true) return "off";
  const { installMiningHookFromGame } = require("./lib/adapter/miningHook");
  const installed = installMiningHookFromGame(ctx.adapter, { wing, config: ctx.config });
  if (!installed.ok) {
    ctx.logger.log(`mining hook NOT installed - ${installed.reason}; mine off`);
    return installed.reason;
  }
  ctx.miningHook = installed.hook;
  ctx.logger.log(`mining hook installed (miningRuntime ${installed.wrapped.length} wrapped; `
    + `ledger=${ctx.config.miningLedgerEnabled === true})`);
  return "ok";
}

function startCommandMirror(ctx, wing, live) {
  if (ctx.config.commandMirrorEnabled !== true) return "off";
  const { installCommandMirrorFromGame, mirroredVerbs } = require("./lib/adapter/commandMirror");
  const returnEnabled = ctx.config.commandMirrorReturnEnabled === true;
  const droneIdsInSpace = (session) => {
    if (!live || !live.ok) return null;
    const space = live.adapter.spaceOf(session);
    const scene = space ? live.adapter.sceneOf(session) : null;
    return scene ? live.adapter.controlledDroneIds(scene, space.shipId) : null;
  };
  const engageEnabled = ctx.config.commandMirrorEngageEnabled === true;
  const installed = installCommandMirrorFromGame(ctx.adapter, { wing, log: ctx.logger, returnEnabled,
    droneIdsInSpace, engageEnabled });
  if (!installed.ok) {
    ctx.logger.log(`command mirror NOT installed - ${installed.reason}; mirror off`);
    return installed.reason;
  }
  ctx.commandMirror = installed.mirror;
  const verbs = mirroredVerbs(returnEnabled, engageEnabled);
  ctx.logger.log(`command mirror installed (${installed.wrapped.join(", ")}; verbs=`
    + `${wing.SUPPORTED_VERBS.filter((v) => verbs.has(v)).join("|") || "none"})`);
  return "ok";
}

function startSafeLogoffHook(ctx, wing, live, characterIdOf) {
  const cfg = ctx.config;
  if (cfg.safeLogoffAbortOnOrder !== true && cfg.safeLogoffBlockWhileDeployed !== true) return "off";
  const { installSafeLogoffHookFromGame, CONSUMER } = require("./lib/adapter/safeLogoffHook");
  const probeOk = Boolean(ctx.adapter && typeof ctx.adapter.isConsumerAvailable === "function"
    && ctx.adapter.isConsumerAvailable(CONSUMER));
  const installed = probeOk && !live.ok ? { ok: false, reason: "live_unavailable" }
    : installSafeLogoffHookFromGame(ctx.adapter, {
      wing, characterIdOf, findSession: (charId) => live.adapter.findSession(charId), config: cfg, log: ctx.logger,
    });
  if (!installed.ok) {
    ctx.logger.log(`safe logoff hook NOT installed - ${installed.reason}; safe logoff unchanged`);
    return installed.reason;
  }
  ctx.safeLogoffHook = installed.hook;
  ctx.logger.log(`safe logoff hook installed (prepareStart; abortOnOrder=${cfg.safeLogoffAbortOnOrder === true} `
    + `blockWhileDeployed=${cfg.safeLogoffBlockWhileDeployed === true})`);
  return "ok";
}

function startNpcAggro(ctx, wing) {
  if (ctx.config.npcAggroEnabled !== true) return "off";
  const { activateNpcAggroFromGame } = require("./lib/adapter/npcAggro");
  const status = activateNpcAggroFromGame(ctx.adapter, ctx.npcAggro, ctx.state.npcAggroHook, { wing });
  if (status !== "ok") {
    ctx.logger.log(`npc aggro NOT available - ${status}; NPCs ignore twins`);
    return status;
  }
  ctx.logger.log("npc aggro installed (npcBehaviorLoop tickScene|tickControllersByEntityID scope; SolarSystemScene "
    + "activateGenericModule|deactivateGenericModule|launchMissile suspended)");
  return "ok";
}

const VERB_CONSUMERS = Object.freeze({
  hold: Object.freeze(["tasks"]),
  mine: Object.freeze(["tasks", "twinControl", "mining"]),
  attack: Object.freeze(["tasks", "twinControl", "combat"]),
  salvage: Object.freeze(["tasks", "twinControl", "salvage"]),
});

function twinControlStatus(ctx) {
  const ok = Boolean(ctx.adapter && typeof ctx.adapter.isConsumerAvailable === "function"
    && ctx.adapter.isConsumerAvailable("twinControl"));
  if (ok) return "ok";
  const { VERB_FLAGS } = require("./lib/core/wingService");
  const off = Object.keys(VERB_CONSUMERS).filter((verb) => VERB_CONSUMERS[verb].includes("twinControl")
    && (VERB_FLAGS[verb] || []).some((key) => ctx.config[key] === true));
  ctx.logger.log("twin control NOT available - probe_twinControl_unavailable; "
    + `${off.length > 0 ? `${off.join(", ")} off` : "no enabled verb affected"}`);
  return "probe_twinControl_unavailable";
}

function startCombatAccess(ctx) {
  if (ctx.config.combatEnabled !== true) return "off";
  if (ctx.combatAccess) return "ok";
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const { createCombatAccessFromGame } = require("./lib/adapter/combatAccess");
  const created = createCombatAccessFromGame(ctx.adapter, { scene: createTwinScene(), config: ctx.config });
  if (!created.ok) {
    ctx.logger.log(`combat access NOT available - ${created.reason}; attack off`);
    return created.reason;
  }
  ctx.combatAccess = created.access;
  if (ctx.config.combatMissilesEnabled === true && !ctx.adapter.isConsumerAvailable("combatMissile")) {
    ctx.logger.log("missiles NOT available - probe_combatMissile_unavailable; twins fire turrets only");
  }
  if (ctx.config.combatPrecursorEnabled === true && !ctx.adapter.isConsumerAvailable("combatPrecursor")) {
    ctx.logger.log("precursor NOT available - probe_combatPrecursor_unavailable; twins fire no Entropic "
      + "Disintegrators");
  }
  if (ctx.config.combatVortonEnabled === true && !ctx.adapter.isConsumerAvailable("combatVorton")) {
    ctx.logger.log("vorton NOT available - probe_combatVorton_unavailable; twins fire no Vorton Projectors");
  }
  if (ctx.config.combatAreaEnabled === true && !ctx.adapter.isConsumerAvailable("combatArea")) {
    ctx.logger.log("area NOT available - probe_combatArea_unavailable; twins fire no smartbombs or point defense");
  }
  if (ctx.config.combatBreacherEnabled === true && !ctx.adapter.isConsumerAvailable("combatBreacher")) {
    ctx.logger.log("breacher NOT available - probe_combatBreacher_unavailable; twins fire no breacher pods");
  }
  if (ctx.config.combatBombsEnabled === true && !ctx.adapter.isConsumerAvailable("combatBomb")) {
    ctx.logger.log("bomb NOT available - probe_combatBomb_unavailable; twins launch no bombs");
  }
  return "ok";
}

function weaponsStatus(ctx, combat) {
  if (combat === "off") return "off";
  if (ctx.combatAccess && typeof ctx.combatAccess.weaponKinds === "function") {
    return ctx.combatAccess.weaponKinds().join(",") || "none";
  }
  return combat;
}

function autoTargetStatus(ctx, combat, engine) {
  if (ctx.config.combatAutoTargetEnabled !== true || combat !== "ok" || !engine) return "off";
  if (!ctx.adapter || typeof ctx.adapter.isConsumerAvailable !== "function"
    || ctx.adapter.isConsumerAvailable("combatAuto") !== true) {
    ctx.logger.log("auto target NOT available - probe_combatAuto_unavailable; attack needs the pilot's target");
    return "probe_combatAuto_unavailable";
  }
  return "ok";
}

function taskReadyFor(adapter) {
  return (verb) => {
    const needed = VERB_CONSUMERS[verb];
    if (!needed || !adapter || typeof adapter.isConsumerAvailable !== "function") return false;
    return needed.every((name) => adapter.isConsumerAvailable(name) === true);
  };
}

function createMineTaskEngine(ctx, live) {
  if (ctx.config.miningEnabled !== true || !taskReadyFor(ctx.adapter)("mine")) return null;
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const { createMiningAccessFromGame } = require("./lib/adapter/miningAccess");
  const { createMineEngine } = require("./lib/core/miningTask");
  const scene = createTwinScene();
  const liveAdapter = live.ok ? live.adapter : null;
  const emit = (ownerCharacterId, changes) => {
    const session = liveAdapter ? liveAdapter.findSession(ownerCharacterId) : null;
    if (session) liveAdapter.emitItemChanges(session, changes);
  };
  const access = createMiningAccessFromGame(ctx.adapter, { scene, config: ctx.config, emit });
  if (!access.ok) {
    ctx.logger.log(`mine engine NOT created - ${access.reason}; mine off`);
    return null;
  }
  if (access.overflowReason && access.overflowReason !== "off") {
    ctx.logger.log(`mining overflow NOT available - ${access.overflowReason}; surplus ore waits in the twins (FULL)`);
  }
  ctx.realCargoReady = access.realCargoReady === true;
  return createMineEngine({
    access: access.access, scene, config: ctx.config,
    hookReady: () => Boolean(ctx.miningHook && ctx.miningHook.isActive()),
    isBlocked: (id) => Boolean(ctx.wing && ctx.wing.isBlocked(id)),
    cargoStoreOf: (hostShipId) => (ctx.wing && typeof ctx.wing.cargoStoreOf === "function"
      ? ctx.wing.cargoStoreOf(hostShipId) : 0),
  });
}

function createCargo(ctx, live) {
  const { createCargoAccessFromGame } = require("./lib/adapter/cargoAccess");
  const liveAdapter = live.ok ? live.adapter : null;
  const emit = (ownerCharacterId, changes) => {
    const session = liveAdapter ? liveAdapter.findSession(ownerCharacterId) : null;
    if (session) liveAdapter.emitItemChanges(session, changes);
  };
  const made = createCargoAccessFromGame(ctx.adapter, { config: ctx.config, emit });
  if (!made.ok) {
    if (made.reason !== "off") ctx.logger.log(`cargo panel NOT available - ${made.reason}; no !wing cargo|move`);
    return { access: null, status: made.reason };
  }
  return { access: made.access, status: "ok" };
}

function createSalvageTaskEngine(ctx) {
  if (ctx.config.salvageEnabled !== true) return { engine: null, status: "off" };
  if (!taskReadyFor(ctx.adapter)("salvage")) {
    const missing = VERB_CONSUMERS.salvage.filter((name) => !ctx.adapter || !ctx.adapter.isConsumerAvailable(name));
    const status = `probe_${missing[0] || "salvage"}_unavailable`;
    ctx.logger.log(`salvage engine NOT created - ${status}; salvage off`);
    return { engine: null, status };
  }
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const { createSalvageAccessFromGame } = require("./lib/adapter/salvageAccess");
  const { createSalvageEngine } = require("./lib/core/salvageTask");
  const scene = createTwinScene();
  const access = createSalvageAccessFromGame(ctx.adapter, { scene, config: ctx.config });
  if (!access.ok) {
    ctx.logger.log(`salvage engine NOT created - ${access.reason}; salvage off`);
    return { engine: null, status: access.reason };
  }
  return {
    engine: createSalvageEngine({
      access: access.access, scene, config: ctx.config,
      hookReady: () => Boolean(ctx.salvageHook && ctx.salvageHook.isActive()),
      isBlocked: (id) => Boolean(ctx.wing && ctx.wing.isBlocked(id)),
      droneSalvage: (_twin, c) => Boolean(ctx.drones && typeof ctx.drones.hasSalvageDrones === "function"
        && ctx.drones.hasSalvageDrones(c && c.record, c && c.rt)),
      droneSalvageProgress: (rt, wreckId) => (ctx.drones && typeof ctx.drones.salvageProgress === "function"
        ? ctx.drones.salvageProgress(rt, wreckId) : null),
    }),
    status: "ok",
  };
}

function startSalvageHook(ctx, wing, made) {
  if (!made || !made.engine) return made ? made.status : "off";
  const boundary = ctx.state.salvageBoundary;
  if (!boundary || boundary.ok !== true) {
    const reason = `boundary_unwrapped${boundary && boundary.reason ? `:${boundary.reason}` : ""}`;
    ctx.logger.log(`salvage hook NOT installed - ${reason}; salvage off`);
    return reason;
  }
  const { installSalvageHookFromGame } = require("./lib/adapter/salvageHook");
  const installed = installSalvageHookFromGame(ctx.adapter, { wing });
  if (!installed.ok) {
    ctx.logger.log(`salvage hook NOT installed - ${installed.reason}; salvage off`);
    return installed.reason;
  }
  ctx.salvageHook = installed.hook;
  ctx.logger.log(`salvage hook installed (salvagerRuntime ${installed.installed.length} wrapped)`);
  return "ok";
}

function createAttackTaskEngine(ctx, live) {
  const combat = startCombatAccess(ctx);
  if (combat !== "ok") return { engine: null, combat };
  if (!taskReadyFor(ctx.adapter)("attack")) {
    const missing = VERB_CONSUMERS.attack.filter((name) => !ctx.adapter.isConsumerAvailable(name));
    ctx.logger.log(`attack engine NOT created - probe_${missing.join("_")}_unavailable; attack off`);
    return { engine: null, combat };
  }
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const { createAttackEngine } = require("./lib/core/combatTask");
  const liveAdapter = live.ok ? live.adapter : null;
  const emit = (ownerCharacterId, changes) => {
    const session = liveAdapter ? liveAdapter.findSession(ownerCharacterId) : null;
    if (session) liveAdapter.emitItemChanges(session, changes);
  };
  const engine = createAttackEngine({
    access: ctx.combatAccess, scene: createTwinScene(), config: ctx.config, emit,
    isTwin: (twin) => Boolean(ctx.wing && ctx.wing.twinOf(twin)),
    droneWeapons: (_twin, c) => Boolean(ctx.drones && ctx.drones.hasCombatDrones(c && c.record)),
  });
  return { engine, combat };
}

function createActiveModules(ctx, collectBurst = null) {
  const none = (active) => ({ planActive: null, sidecar: null, ewarSidecar: null, active,
    logi: ctx.config.logiEnabled === true ? active : "off",
    prop: ctx.config.activePropEnabled === true ? active : "off",
    ewar: ctx.config.ewarEnabled === true ? active : "off" });
  if (ctx.config.activeModulesEnabled !== true) return none("off");
  const available = (name) => Boolean(ctx.adapter && typeof ctx.adapter.isConsumerAvailable === "function"
    && ctx.adapter.isConsumerAvailable(name));
  const missing = ["active", "twinControl"].filter((name) => !available(name));
  if (missing.length > 0) {
    const reason = `probe_${missing.join("_")}_unavailable`;
    ctx.logger.log(`active modules NOT available - ${reason}; twins fly without active modules`);
    return none(reason);
  }
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const { createActiveAccessFromGame } = require("./lib/adapter/activeAccess");
  const { createActiveSidecar } = require("./lib/core/activeTask");
  const logiMade = createLogi(ctx, available, collectBurst);
  const propMade = createProp(ctx, available);
  const ewarMade = createEwar(ctx, available);
  const planConfig = { ...ctx.config, logiEnabled: logiMade.access !== null,
    activePropEnabled: propMade.access !== null, ewarEnabled: ewarMade.access !== null };
  const created = createActiveAccessFromGame(ctx.adapter, { config: planConfig, collectBurst,
    ...(ewarMade.access ? { ewarFamilyOf: ewarMade.access.familyOf } : {}) });
  if (!created.ok) {
    ctx.logger.log(`active modules NOT available - ${created.reason}; twins fly without active modules`);
    return none(created.reason);
  }
  const access = created.access;
  const planActive = (spec, planCtx) => {
    let weapons = null;
    if (ctx.combatAccess) {
      try {
        weapons = ctx.combatAccess.listWeapons({ ...spec, kind: "ship" });
      } catch (_err) {
        weapons = null;
      }
    }
    return access.planActive(spec, { ...planCtx, weapons });
  };
  const sidecar = createActiveSidecar({ access, scene: createTwinScene(), config: planConfig,
    isTwin: (twin) => Boolean(ctx.wing && ctx.wing.twinOf(twin)),
    logi: logiMade.access,
    prop: propMade.access,
    wingTwins: (charId) => (ctx.wing && typeof ctx.wing.activeTwinsOf === "function"
      ? ctx.wing.activeTwinsOf(charId) : []) });
  let ewarSidecar = null;
  if (ewarMade.access) {
    const { createEwarSidecar } = require("./lib/core/ewarTask");
    ewarSidecar = createEwarSidecar({ access: ewarMade.access, combat: ctx.combatAccess, scene: createTwinScene(),
      config: planConfig, isTwin: (twin) => Boolean(ctx.wing && ctx.wing.twinOf(twin)) });
  }
  return { planActive, sidecar, access, active: "ok", logi: logiMade.status, prop: propMade.status, ewarSidecar,
    ewar: ewarMade.status };
}

function createEwar(ctx, available) {
  if (ctx.config.ewarEnabled !== true) return { access: null, status: "off" };
  const fail = (reason) => {
    ctx.logger.log(`EWAR NOT available - ${reason}; twins use no EWAR`);
    return { access: null, status: reason };
  };
  if (!available("ewar")) return fail("probe_ewar_unavailable");
  if (!ctx.combatAccess || typeof ctx.combatAccess.targetAllowed !== "function") {
    return fail(ctx.config.combatEnabled === true ? "combat_unavailable" : "combat_off");
  }
  const { createEwarAccessFromGame } = require("./lib/adapter/ewarAccess");
  const made = createEwarAccessFromGame(ctx.adapter, { config: ctx.config });
  if (!made.ok) return fail(made.reason);
  return { access: made.access, status: "ok" };
}

function createBurst(ctx) {
  if (ctx.config.burstEnabled !== true) return { access: null, sidecar: null, status: "off" };
  const { createBurstAccessFromGame } = require("./lib/adapter/burstAccess");
  const made = createBurstAccessFromGame(ctx.adapter);
  if (!made.ok) {
    ctx.logger.log(`command burst NOT available - ${made.reason}; twins get no command bursts`);
    return { access: null, sidecar: null, status: made.reason };
  }
  const { createBurstSidecar } = require("./lib/core/burstTask");
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const late = { activeAccess: null, activeSidecar: null };
  const sidecar = createBurstSidecar({ access: made.access, config: ctx.config, log: ctx.logger,
    scene: createTwinScene(), activeAccess: () => late.activeAccess,
    propNow: (rt) => (late.activeSidecar && typeof late.activeSidecar.propNow === "function"
      ? late.activeSidecar.propNow(rt) : null) });
  return { access: made.access, sidecar, status: "ok", late };
}

function createDrones(ctx) {
  if (ctx.config.dronesEnabled !== true) return { sidecar: null, status: "off" };
  const available = (name) => Boolean(ctx.adapter && typeof ctx.adapter.isConsumerAvailable === "function"
    && ctx.adapter.isConsumerAvailable(name));
  const missing = ["drones", "twinControl"].find((name) => !available(name));
  if (missing) {
    const reason = `probe_${missing}_unavailable`;
    ctx.logger.log(`copy drones NOT available - ${reason}; twins launch no drones`);
    return { sidecar: null, status: reason };
  }
  const { createDroneAccessFromGame } = require("./lib/adapter/droneAccess");
  const made = createDroneAccessFromGame(ctx.adapter, { config: ctx.config });
  if (!made.ok) {
    ctx.logger.log(`copy drones NOT available - ${made.reason}; twins launch no drones`);
    return { sidecar: null, status: made.reason };
  }
  if (ctx.config.droneSalvageEnabled === true && ctx.config.salvageEnabled === true && !available("droneSalvage")) {
    ctx.logger.log("drone salvage NOT available - probe_droneSalvage_unavailable; twins launch no salvage drones");
  }
  const { createDroneSidecar } = require("./lib/core/droneTask");
  const { createTwinScene } = require("./lib/adapter/twinScene");
  const sidecar = createDroneSidecar({ access: made.access, scene: createTwinScene(), combat: ctx.combatAccess || null,
    config: ctx.config, log: ctx.logger, journal: openDroneJournal(ctx),
    wingTwins: (charId) => (ctx.wing && typeof ctx.wing.activeTwinsOf === "function"
      ? ctx.wing.activeTwinsOf(charId) : []),
    ...droneMiningDeps(ctx) });
  return { sidecar, status: "ok" };
}

function droneMiningDeps(ctx) {
  if (ctx.config.droneMiningEnabled !== true || ctx.config.miningEnabled !== true) return {};
  const none = { ok: false, reason: "HOOK_UNAVAILABLE" };
  return {
    mineYield: (...args) => (ctx.miningHook && typeof ctx.miningHook.droneCycle === "function"
      ? ctx.miningHook.droneCycle(...args) : none),
    mineRock: (...args) => (ctx.miningHook && typeof ctx.miningHook.droneRock === "function"
      ? ctx.miningHook.droneRock(...args) : none),
  };
}

function droneMiningStatus(ctx, drones, mining) {
  const c = ctx.config;
  if (c.droneMiningEnabled !== true || c.dronesEnabled !== true || c.miningEnabled !== true) return "off";
  if (!ctx.adapter || typeof ctx.adapter.isConsumerAvailable !== "function"
    || ctx.adapter.isConsumerAvailable("droneMining") !== true) {
    ctx.logger.log("drone mining NOT available - probe_droneMining_unavailable; twins launch no mining drones");
    return "probe_droneMining_unavailable";
  }
  if (!drones || drones.status !== "ok" || mining !== "ok") return "unavailable";
  return "ok";
}

function openDroneJournal(ctx) {
  const path = require("node:path");
  const { createDroneJournal, JOURNAL_FILE_NAME } = require("./lib/store/droneJournal");
  const journal = createDroneJournal({ filePath: path.join(ctx.config.dataDir, JOURNAL_FILE_NAME),
    ...ctx.storeDeps });
  const loaded = journal.load();
  if (loaded.recovered) {
    ctx.logger.log(`drone journal unreadable (${loaded.recovered.reason}) - moved to `
      + `${loaded.recovered.movedTo || "(rename failed, journal read-only)"}; starting empty`);
  }
  if (loaded.dropped > 0) ctx.logger.log(`drone journal: ${loaded.dropped} broken entr(y/ies) dropped`);
  return journal;
}

function openFormations(ctx, live) {
  if (ctx.config.formationEnabled !== true) return { store: null, status: "off" };
  if (!ctx.adapter || typeof ctx.adapter.isConsumerAvailable !== "function"
    || ctx.adapter.isConsumerAvailable("formation") !== true) {
    ctx.logger.log("formations NOT available - probe_formation_unavailable; twins follow the host");
    return { store: null, status: "probe_formation_unavailable" };
  }
  if (!live || !live.ok) {
    ctx.logger.log("formations NOT available - live_unavailable; twins follow the host");
    return { store: null, status: "live_unavailable" };
  }
  if (live.formationReason) {
    ctx.logger.log(`formations NOT available - ${live.formationReason}; twins follow the host`);
    return { store: null, status: live.formationReason };
  }
  try {
    const path = require("node:path");
    const { createFormationStore, FORMATION_FILE_NAME } = require("./lib/store/formationStore");
    const { FORMATIONS } = require("./lib/core/formation");
    const store = createFormationStore({ filePath: path.join(ctx.config.dataDir, FORMATION_FILE_NAME),
      maxPilots: ctx.config.formationMaxPilots, isKnown: (name) => FORMATIONS.includes(name), ...ctx.storeDeps });
    const loaded = store.load();
    if (loaded.recovered) {
      ctx.logger.log(`formation file unreadable (${loaded.recovered.reason}) - moved to `
        + `${loaded.recovered.movedTo || "(rename failed, file read-only)"}; starting empty`);
    }
    if (loaded.dropped > 0) ctx.logger.log(`formation file: ${loaded.dropped} broken entr(y/ies) dropped`);
    return { store, status: "ok" };
  } catch (err) {
    startStepFailed(ctx, "formations", "formation file failed - choices kept in memory only", err);
    return { store: null, status: "ok-memory" };
  }
}

function reclaimBootDrones(ctx) {
  if (!ctx.drones || typeof ctx.drones.reclaimBoot !== "function") return;
  const wing = ctx.wing;
  const out = ctx.drones.reclaimBoot({ enabled: ctx.config.droneReclaimOnBoot === true,
    hasLoss: wing && typeof wing.hasLossRecord === "function" ? (id) => wing.hasLossRecord(id) : undefined });
  if (out.entries === 0) return;
  ctx.logger.log(`drones reclaimed=${out.reclaimed} skipped=${out.skipped}`
    + `${ctx.config.droneReclaimOnBoot === true ? "" : " (droneReclaimOnBoot off)"}`
    + `${out.flushed ? "" : " - journal not written"}`);
}

function createProp(ctx, available) {
  if (ctx.config.activePropEnabled !== true) return { access: null, status: "off" };
  if (!available("prop")) {
    ctx.logger.log("AB/MWD NOT available - probe_prop_unavailable; twins fly without AB/MWD");
    return { access: null, status: "probe_prop_unavailable" };
  }
  const { createPropAccessFromGame } = require("./lib/adapter/propAccess");
  const made = createPropAccessFromGame(ctx.adapter, { config: ctx.config });
  if (!made.ok) {
    ctx.logger.log(`AB/MWD NOT available - ${made.reason}; twins fly without AB/MWD`);
    return { access: null, status: made.reason };
  }
  return { access: made.access, status: "ok" };
}

function createLogi(ctx, available, collectBurst = null) {
  if (ctx.config.logiEnabled !== true) return { access: null, status: "off" };
  if (!available("logi")) {
    ctx.logger.log("remote repair NOT available - probe_logi_unavailable; twins do not repair");
    return { access: null, status: "probe_logi_unavailable" };
  }
  const { createLogiAccessFromGame } = require("./lib/adapter/logiAccess");
  const made = createLogiAccessFromGame(ctx.adapter, { config: ctx.config, collectBurst });
  if (!made.ok) {
    ctx.logger.log(`remote repair NOT available - ${made.reason}; twins do not repair`);
    return { access: null, status: made.reason };
  }
  return { access: made.access, status: "ok" };
}

function startAmmoReceiptPrune(ctx) {
  if (ctx.config.combatAmmoReceiptPruneEnabled !== true || !ctx.combatAccess
    || typeof ctx.combatAccess.pruneAmmoReceipts !== "function") {
    return "off";
  }
  const { createAmmoReceiptSweeper } = require("./lib/core/ammoReceipts");
  const store = ctx.store;
  const sweeper = createAmmoReceiptSweeper({ access: ctx.combatAccess, listRecords: () => store.list(),
    config: ctx.config });
  ctx.ammoReceipts = sweeper;
  const out = sweeper.boot();
  if (out && out.ok === true) {
    ctx.logger.log(`ammo receipts boot prune removed=${out.removed}${out.capped ? " (capped, rest later)" : ""}`);
    return "ok";
  }
  const reason = (out && out.reason) || "ERROR";
  ctx.logger.log(`ammo receipts boot prune failed - ${reason}; continuing`);
  return reason;
}

function settleBootLosses(ctx, wing, live) {
  if (!live.ok) return;
  const out = wing.settlePending();
  ctx.logger.log(`lossSettle boot settled=${out.settled} purged=${out.purged} failed=${out.failed}`);
}

function openWindowFor(ctx) {
  if (ctx.config.clientWindowEnabled !== true) return undefined;
  return (charId) => (ctx.clientWindow && ctx.clientWindow.channel
    ? ctx.clientWindow.channel.open(charId)
    : { ok: false, reason: "WINDOW_OFF" });
}

function serverBoardFor(ctx) {
  return ctx.boardHook && typeof ctx.boardHook.serverBoard === "function" ? ctx.boardHook.serverBoard : undefined;
}

function startChat(ctx, wing, characterIdOf) {
  const { createChatChannel } = require("./lib/channels/chat");
  const { installChatFromGame } = require("./lib/adapter/chatHook");
  const channel = createChatChannel({ core: wing, trigger: ctx.config.chatTrigger, characterIdOf,
    openWindow: openWindowFor(ctx), board: serverBoardFor(ctx), uiAuto: uiAutoFor(ctx) });
  const chat = installChatFromGame(ctx.adapter, { match: channel.match, handle: channel.handle, logger: ctx.logger });
  if (chat.ok) {
    ctx.chat = chat.hook;
    ctx.logger.log(`chat installed (${ctx.config.chatTrigger} launch|return|status in Local)`);
  } else {
    ctx.logger.log(`chat NOT installed - ${chat.reason}`);
  }
}

function startClientWindow(ctx, wing, world, live, characterIdOf) {
  if (ctx.config.clientWindowEnabled !== true) return "off";
  const service = startClientService(ctx, wing, world, live, characterIdOf);
  const delivery = ctx.clientDelivery && ctx.clientDelivery.hook && ctx.clientDelivery.hook.ok
    ? ctx.clientDelivery.delivery : null;
  if (delivery && service === "service:ok") delivery.setReady(true);
  return `${hookStatus(ctx)} ${service}`;
}

function openUiPrefs(ctx) {
  try {
    const path = require("node:path");
    const { createUiPrefsStore, UI_PREFS_FILE_NAME } = require("./lib/store/uiPrefsStore");
    const store = createUiPrefsStore({ filePath: path.join(ctx.config.dataDir, UI_PREFS_FILE_NAME),
      maxPilots: ctx.config.uiPrefsMaxPilots, ...ctx.storeDeps });
    const loaded = store.load();
    if (loaded.recovered) {
      ctx.logger.log(`ui prefs file unreadable (${loaded.recovered.reason}) - moved to `
        + `${loaded.recovered.movedTo || "(rename failed, file read-only)"}; starting empty`);
    }
    if (loaded.dropped > 0) ctx.logger.log(`ui prefs file: ${loaded.dropped} broken entr(y/ies) dropped`);
    ctx.uiPrefs = store;
    return store;
  } catch (err) {
    startStepFailed(ctx, "uiPrefs", "ui prefs file failed - no window at login", err);
    return null;
  }
}

function publishUiPrefsApi(ctx, channel, uiPrefs) {
  if (!uiPrefs) return;
  try {
    const { createUiPrefsApi, registerUiPrefsApi } = require("./lib/channels/uiPrefsApi");
    const made = createUiPrefsApi({ channel, store: uiPrefs });
    if (registerUiPrefsApi(ctx.globalObj || globalThis, made.api)) ctx.uiPrefsApi = made;
  } catch (err) {
    startStepFailed(ctx, "uiPrefsApi", "ui prefs API failed - the LNE panel cannot reach it", err);
  }
}

function uiAutoFor(ctx) {
  if (ctx.config.clientWindowEnabled !== true) return undefined;
  const off = { ok: false, reason: "WINDOW_OFF" };
  return {
    get: (charId) => (ctx.uiPrefsApi ? ctx.uiPrefsApi.api.get(charId) : off),
    set: (charId, on) => (ctx.uiPrefsApi ? ctx.uiPrefsApi.api.set(charId, on) : off),
  };
}

function startClientService(ctx, wing, world, live, characterIdOf) {
  if (!ctx.adapter || typeof ctx.adapter.isConsumerAvailable !== "function"
    || !ctx.adapter.isConsumerAvailable("clientWindow")) {
    ctx.logger.log("client window NOT installed - probe_clientWindow_unavailable");
    return "service:probe_clientWindow_unavailable";
  }
  const { createClientWindowChannel } = require("./lib/channels/clientWindow");
  const { createNotifier, installClientServiceFromGame, SERVICE_NAME } = require("./lib/adapter/clientService");
  const uiPrefs = openUiPrefs(ctx);
  const channel = createClientWindowChannel({
    core: wing, config: ctx.config, notify: createNotifier(live.ok ? live.adapter : null), log: ctx.logger,
    liveConfig: ctx.liveSettings || null, board: serverBoardFor(ctx), uiPrefs: uiPrefs || undefined,
  });
  const installed = installClientServiceFromGame(ctx.adapter, world, channel, { characterIdOf, log: ctx.logger });
  if (!installed.ok) {
    channel.stop();
    ctx.logger.log(`client window NOT installed - ${installed.reason}`);
    return `service:${installed.reason}`;
  }
  ctx.clientWindow = { channel, service: installed.service };
  publishUiPrefsApi(ctx, channel, uiPrefs);
  ctx.logger.log(`client window installed (${SERVICE_NAME}: GetState|Command|Report; OnShipWingState, `
    + `OnShipWingOpen; client code ${ctx.clientDelivery && ctx.clientDelivery.hook && ctx.clientDelivery.hook.ok
      ? "delivered at login" : "not delivered"})`);
  return "service:ok";
}

function startLiveSettings(ctx) {
  try {
    const { createLiveSettings, registerLive } = require("./lib/core/liveSettings");
    ctx.liveSettings = createLiveSettings(ctx.config);
    ctx.liveEntry = registerLive(ctx.globalObj || globalThis, ctx.liveSettings);
  } catch (err) {
    ctx.liveSettings = null;
    ctx.liveEntry = null;
    startStepFailed(ctx, "liveSettings", "live settings failed - every key applies at a restart", err);
  }
}

function startStepFailed(ctx, step, message, err) {
  const name = `start.error.${step}`;
  ctx.state.startErrors[name] = (ctx.state.startErrors[name] || 0) + 1;
  ctx.logger.logError(message, err);
}

function defaultStartServices(world, ctx) {
  const { createWingService } = require("./lib/core/wingService");
  const { createTickDriver } = require("./lib/core/tickDriver");
  const vendor = require("./lib/adapter/vendor");
  ctx.state.guardsReady = false;
  ctx.state.lossReady = false;
  ctx.state.derivedReady = false;
  ctx.state.tickReady = false;
  ctx.state.startErrors = {};
  const live = vendor.createLiveAdapter(ctx.adapter,
    ctx.npcAggro ? { afterSpawn: (entity) => ctx.npcAggro && ctx.npcAggro.attach(entity) } : {});
  if (!live.ok) ctx.logger.log(`live adapter NOT available - ${live.reason}; launch refused (DISABLED)`);
  let mine = null;
  try {
    mine = createMineTaskEngine(ctx, live);
  } catch (err) {
    startStepFailed(ctx, "mine", "mine engine failed - mine off", err);
  }
  let salvageMade;
  try {
    salvageMade = createSalvageTaskEngine(ctx);
  } catch (err) {
    startStepFailed(ctx, "salvage", "salvage engine failed - salvage off", err);
    salvageMade = { engine: null, status: "error" };
  }
  let attack = null;
  let combat;
  try {
    const made = createAttackTaskEngine(ctx, live);
    attack = made.engine;
    combat = made.combat;
  } catch (err) {
    startStepFailed(ctx, "combat", "combat access failed - attack off", err);
    combat = "error";
  }
  const autoTarget = autoTargetStatus(ctx, combat, attack);
  const engines = {};
  if (mine) engines.mine = mine;
  if (attack) engines.attack = attack;
  if (salvageMade.engine) engines.salvage = salvageMade.engine;
  let burst;
  try {
    burst = createBurst(ctx);
  } catch (err) {
    startStepFailed(ctx, "burst", "command burst failed - twins get no command bursts", err);
    burst = { access: null, sidecar: null, status: "error" };
  }
  ctx.burst = burst.sidecar;
  const collectBurst = burst.access ? burst.access.collect : null;
  let activeModules;
  try {
    activeModules = createActiveModules(ctx, collectBurst);
  } catch (err) {
    startStepFailed(ctx, "active", "active modules failed - twins fly without active modules", err);
    activeModules = { planActive: null, sidecar: null, ewarSidecar: null, active: "error",
      logi: ctx.config.logiEnabled === true ? "error" : "off",
      prop: ctx.config.activePropEnabled === true ? "error" : "off",
      ewar: ctx.config.ewarEnabled === true ? "error" : "off" };
  }
  if (burst.late) {
    burst.late.activeAccess = activeModules.access || null;
    burst.late.activeSidecar = activeModules.sidecar || null;
  }
  let drones;
  try {
    drones = createDrones(ctx);
  } catch (err) {
    startStepFailed(ctx, "drones", "copy drones failed - twins launch no drones", err);
    drones = { sidecar: null, status: "error" };
  }
  ctx.drones = drones.sidecar;
  const formation = openFormations(ctx, live);
  ctx.formations = formation.store;
  startLiveSettings(ctx);
  let cargo = { access: null, status: "off" };
  if (ctx.config.cargoPanelEnabled === true) {
    try {
      cargo = createCargo(ctx, live);
    } catch (err) {
      startStepFailed(ctx, "cargo", "cargo panel failed - no !wing cargo|move", err);
      cargo = { access: null, status: "error" };
    }
  }
  const wing = createWingService({
    adapter: live.ok ? live.adapter : null, store: ctx.store, config: ctx.config, log: ctx.logger,
    liveConfig: ctx.liveSettings || null,
    guardsReady: () => ctx.state.guardsReady === true,
    lossReady: () => ctx.state.lossReady === true,
    derivedReady: () => ctx.state.derivedReady === true,
    tickReady: () => ctx.state.tickReady === true,
    taskReady: taskReadyFor(ctx.adapter),
    taskEngines: Object.keys(engines).length > 0 ? engines : undefined,
    taskSidecars: sidecarsOf(activeModules.sidecar, activeModules.ewarSidecar, burst.sidecar, drones.sidecar),
    planActive: activeModules.planActive || undefined,
    onOrderAccepted: (charId, verb, source) => {
      if (ctx.safeLogoffHook) ctx.safeLogoffHook.abortFor(charId, verb, source);
    },
    mirrorEngageOn: () => Boolean(ctx.commandMirror && ctx.commandMirror.isActive()
      && ctx.config.commandMirrorEngageEnabled === true),
    formations: formation.store || undefined,
    formationReady: () => formation.status === "ok" || formation.status === "ok-memory",
    boardReady: () => Boolean(ctx.boardHook),
    cargo: cargo.access || undefined,
  });
  ctx.wing = wing;
  try {
    settleBootLosses(ctx, wing, live);
  } catch (err) {
    startStepFailed(ctx, "lossSettle", "lossSettle boot failed - LOST records stay locked", err);
  }
  try {
    reclaimBootDrones(ctx);
  } catch (err) {
    startStepFailed(ctx, "droneReclaim", "drone reclaim at start failed - drones stay in space", err);
  }
  try {
    startAmmoReceiptPrune(ctx);
  } catch (err) {
    startStepFailed(ctx, "ammoPrune", "ammo receipt prune failed - continuing", err);
  }
  let board;
  try {
    board = startBoardHook(ctx, wing, live);
  } catch (err) {
    startStepFailed(ctx, "board", "board hook failed - Board on a copy does nothing", err);
    board = "error";
  }
  try {
    startGuards(ctx, wing);
  } catch (err) {
    ctx.state.guardsReady = false;
    startStepFailed(ctx, "guards", "guards failed - launch refused (GUARDS_UNAVAILABLE)", err);
  }
  try {
    startLossHook(ctx, wing, live);
  } catch (err) {
    startStepFailed(ctx, "loss", "loss hook failed - launch refused (LOSS_UNAVAILABLE)", err);
  }
  let tasks;
  try {
    tasks = startTaskHooks(ctx, wing, live);
  } catch (err) {
    startStepFailed(ctx, "tasks", "derived-state guard failed - launch refused (DERIVED_GUARD_UNAVAILABLE)", err);
    tasks = "error";
  }
  let aggro;
  try {
    aggro = startNpcAggro(ctx, wing);
  } catch (err) {
    startStepFailed(ctx, "npcAggro", "npc aggro failed - NPCs ignore twins", err);
    aggro = "error";
  }
  let twinControl;
  try {
    twinControl = twinControlStatus(ctx);
  } catch (err) {
    startStepFailed(ctx, "twinControl", "twin control status failed - continuing", err);
    twinControl = "error";
  }
  let mining;
  try {
    mining = startMiningHook(ctx, wing);
  } catch (err) {
    startStepFailed(ctx, "mining", "mining hook failed - continuing without it", err);
    mining = "error";
  }
  let salvage;
  try {
    salvage = startSalvageHook(ctx, wing, salvageMade);
  } catch (err) {
    startStepFailed(ctx, "salvageHook", "salvage hook failed - continuing without it", err);
    salvage = "error";
  }
  let droneMining;
  try {
    droneMining = droneMiningStatus(ctx, drones, mining);
  } catch (err) {
    startStepFailed(ctx, "droneMining", "drone mining status failed - continuing", err);
    droneMining = "error";
  }
  let mirror;
  try {
    mirror = startCommandMirror(ctx, wing, live);
  } catch (err) {
    startStepFailed(ctx, "mirror", "command mirror failed - continuing without it", err);
    mirror = "error";
  }
  let safeLogoff;
  try {
    safeLogoff = startSafeLogoffHook(ctx, wing, live, vendor.characterIdOf);
  } catch (err) {
    startStepFailed(ctx, "safeLogoff", "safe logoff hook failed - safe logoff unchanged", err);
    safeLogoff = "error";
  }
  try {
    const driver = createTickDriver({
      wing, tickIntervalMs: ctx.config.tickIntervalMs, telemetryIntervalMs: ctx.config.telemetryIntervalMs,
      onTelemetry: (final) => logTelemetry(ctx, final), timers: ctx.timers || undefined,
      onTick: (nowMs) => {
        if (ctx.drones && !ctx.state.stopped) ctx.drones.flush();
        if (ctx.uiPrefs && !ctx.state.stopped && ctx.uiPrefs.isDirty()) ctx.uiPrefs.flush();
        if (ctx.ammoReceipts && !ctx.state.stopped) ctx.ammoReceipts.tick(nowMs);
      },
    });
    ctx.driver = driver;
    ctx.state.tickReady = driver.start().ok === true;
  } catch (err) {
    ctx.state.tickReady = false;
    startStepFailed(ctx, "tick", "tick driver failed - launch refused (TICK_UNAVAILABLE)", err);
  }
  try {
    startChat(ctx, wing, vendor.characterIdOf);
  } catch (err) {
    startStepFailed(ctx, "chat", "chat failed - no chat orders", err);
  }
  let clientWindow;
  try {
    clientWindow = startClientWindow(ctx, wing, world, live, vendor.characterIdOf);
  } catch (err) {
    startStepFailed(ctx, "clientWindow", "client window failed - continuing without it", err);
    clientWindow = `${hookStatus(ctx)} service:error`;
  }
  const hook = vendor.registerShutdown(world && world.database, "shipWing",
    (signal) => stopServices(ctx, `shutdown:${signal}`));
  if (!hook.ok) {
    ctx.logger.log(`shutdown hook not registered - ${hook.reason}${hook.detail ? ` (${hook.detail})` : ""}; `
      + "the timers stop with the process (unref)");
  }
  ctx.logger.log(`ready v${MOD_VERSION} pid=${process.pid} dir=${ctx.modDir} state=${ctx.config.stateFile} `
    + `blocked=${wing.blockedCount()} live=${live.ok} guards=${ctx.state.guardsReady} loss=${ctx.state.lossReady} `
    + `chat=${ctx.chat !== null} `
    + `tick=${ctx.config.tickIntervalMs}ms clientWindow=${clientWindow} tasks=${tasks} twinControl=${twinControl} `
    + `mining=${mining} combat=${combat} mirror=${mirror} active=${activeModules.active} safeLogoff=${safeLogoff} `
    + `logi=${activeModules.logi} prop=${activeModules.prop} weapons=${weaponsStatus(ctx, combat)} `
    + `burst=${burst.status} drones=${drones.status} aggro=${aggro} autoTarget=${autoTarget} `
    + `droneMining=${droneMining} formation=${formation.status} salvage=${salvage} board=${board} `
    + `boardOrphan=${board === "ok" && ctx.config.boardOrphanEnabled === true ? "ok" : "off"}`
    + `${ctx.config.miningRealCargoEnabled === true ? ` realCargo=${mine && ctx.realCargoReady === true ? "on" : "off"}`
      : ""}${ctx.config.cargoPanelEnabled === true ? ` cargo=${cargo.status}` : ""}`
    + `${ctx.config.ewarEnabled === true ? ` ewar=${activeModules.ewar}` : ""}`);
}

function sidecarsOf(...sidecars) {
  const list = sidecars.filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function onReadiness(ctx, request, parent) {
  ctx.state.readinessSeen = true;
  const { findServerSrcInCache } = require("./lib/adapter/index");
  let found;
  try {
    found = findServerSrcInCache(ctx.moduleApi._cache, ctx.moduleApi._resolveFilename(request, parent));
  } catch (_err) {
    found = { ok: false, reason: "gamestore_not_cached" };
  }
  if (found.ok) ctx.state.serverSrc = found.srcDir;
  else ctx.logger.debug(`readiness: server/src not found - ${found.reason}`);
}

function runProbe(ctx) {
  const { createAdapter, findServerSrcInCache, formatProbeLog } = require("./lib/adapter/index");
  const adapter = createAdapter({ moduleApi: ctx.moduleApi, ...ctx.adapterDeps });
  let serverSrc = ctx.state.serverSrc;
  if (!serverSrc) {
    const found = findServerSrcInCache(ctx.moduleApi._cache, ctx.state.bootstrapFile);
    if (found.ok) serverSrc = found.srcDir;
  }
  if (serverSrc) {
    const set = adapter.setServerSrc(serverSrc);
    if (!set.ok) ctx.logger.log(`probe: server/src not set - ${set.reason}`);
  }
  adapter.markBooted();
  const report = adapter.runProbe();
  for (const line of formatProbeLog(report)) ctx.logger.log(line);
  const outside = adapter.getLoadedOutsideCache();
  if (outside.length > 0) ctx.logger.debug(`probe loaded outside require.cache: ${outside.join(", ")}`);
  ctx.adapter = adapter;
}

function openStore(ctx) {
  const { createWingStore } = require("./lib/store/wingStore");
  const store = createWingStore({ filePath: ctx.config.stateFile, ...ctx.storeDeps });
  const loaded = store.load();
  if (loaded.recovered) {
    ctx.logger.log(`state file unreadable (${loaded.recovered.reason}) - moved to `
      + `${loaded.recovered.movedTo || "(rename failed)"}; starting empty, LOST records of that file are dropped`);
  }
  if (loaded.dropped > 0) {
    ctx.logger.log(`state file: ${loaded.dropped} broken record(s) dropped - original copied to `
      + `${loaded.backedUpTo || "(copy failed)"}`);
  }
  if (loaded.readOnly) {
    const cause = loaded.recovered
      ? "could not be read and could not be moved aside"
      : "has dropped records and its backup copy failed";
    ctx.logger.log(`STATE FILE READ-ONLY: ${ctx.config.stateFile} ${cause} `
      + "- nothing is written until a restart, every launch is refused (STORE_WRITE_FAILED)");
  }
  const swept = store.bootSweep();
  ctx.logger.log(`bootSweep cleared=${swept.cleared} keptLost=${swept.keptLost}`
    + `${swept.ok ? "" : ` - not written (${swept.reason})${loaded.readOnly ? ", store read-only" : ""}`}`);
  ctx.store = store;
}

function onBooted(ctx, world) {
  const { evaluateWorldGate, processRoleFromWorld } = require("./lib/adapter/index");
  const role = processRoleFromWorld(world);
  const gate = role.ok
    ? evaluateWorldGate({
      isMainThread: ctx.isMainThread, envRole: ctx.env[ENV_ROLE_KEY], processRole: role.processRole,
    })
    : { ok: false, reason: role.reason };
  if (!gate.ok) {
    ctx.logger.log(`boot: not starting - ${gate.reason}`);
    return;
  }
  if (ctx.state.started) return;
  ctx.state.started = true;
  const preloadHook = ctx.clientDelivery && ctx.clientDelivery.hook;
  if (preloadHook && !preloadHook.ok) {
    ctx.logger.log(preloadHook.line || `SHIPWING_UI:UNAVAILABLE:${preloadHook.reason}`);
  }
  const cfg = ctx.configResult;
  for (const w of cfg.warnings || []) ctx.logger.log(`config: warning - ${w}`);
  for (const e of cfg.errors || []) ctx.logger.log(`config: error - ${e}`);
  if (!cfg.ok) {
    ctx.logger.log(`boot: not starting - config_invalid (${(cfg.errors || []).length} error(s))`);
    return;
  }
  ctx.config = cfg.config;
  try {
    runProbe(ctx);
  } catch (err) {
    ctx.logger.logError("probe failed - continuing", err);
  }
  try {
    openStore(ctx);
  } catch (err) {
    ctx.logger.logError("state file failed - mod not running", err);
    return;
  }
  try {
    ctx.startServices(world, ctx);
  } catch (err) {
    ctx.logger.logError("service start failed - mod not running", err);
    dropLiveEntry(ctx);
  }
}

function dropLiveEntry(ctx) {
  try {
    if (ctx.liveEntry) require("./lib/core/liveSettings").unregisterLive(ctx.globalObj || globalThis, ctx.liveEntry);
  } catch (err) {
    ctx.logger.logError("live settings cleanup failed", err);
  }
  ctx.liveEntry = null;
}

function onBootModule(ctx, exportsObject, request, parent) {
  try {
    ctx.state.bootstrapFile = ctx.moduleApi._resolveFilename(request, parent);
  } catch (_err) {
  }
  const { wrapBootWorld } = require("./lib/adapter/bootWrap");
  const result = wrapBootWorld(exportsObject, {
    onBooted: (world) => onBooted(ctx, world),
    onBootFailed: (reason, err) => {
      ctx.logger.log(`boot: not starting - ${reason}`);
      if (err !== undefined) ctx.logger.debug(`boot failure detail: ${(err && err.stack) || err}`);
    },
    onHandlerError: (message, err) => ctx.logger.logError(`${message} - mod not running`, err),
  });
  if (!result.ok) ctx.logger.log(`bootWorld not wrapped - ${result.reason}; mod will not start`);
}

function buildHooks(ctx) {
  const hooks = [
    {
      name: "gameRuntimeReady",
      match(request, exports) {
        return request.includes("wormholeRuntimeState") && exportHas(exports, "mutateState", "function");
      },
      run(_exports, request, parent) {
        onReadiness(ctx, request, parent);
      },
    },
    {
      name: "bootWorld",
      match(request, exports) {
        return BOOTSTRAP_REQUEST.test(request)
          && exportHas(exports, "bootWorld", "function")
          && exportHas(exports, "PRODUCTION_STAGES", "object");
      },
      run(exports, request, parent) {
        onBootModule(ctx, exports, request, parent);
      },
    },
  ];
  const config = ctx.configResult && ctx.configResult.config;
  if (config && config.enabled === true && config.salvageEnabled === true) {
    hooks.push({
      name: "salvageBoundary",
      match(request, exports) {
        return SALVAGE_BOUNDARY_REQUEST.test(request)
          && exportHas(exports, "resolveSalvagerCycleRuntimeSnapshot", "function");
      },
      run(exports) {
        const { wrapBoundaryExports } = require("./lib/adapter/salvageHook");
        ctx.state.salvageBoundary = wrapBoundaryExports(exports, () => ctx.salvageHook);
      },
    });
  }
  if (ctx.npcAggro && config && config.npcAggroEnabled === true) {
    hooks.push({
      name: "npcAggro",
      match(request, exports) {
        return NPC_BEHAVIOR_REQUEST.test(request)
          && exportHas(exports, "tickScene", "function")
          && exportHas(exports, "tickControllersByEntityID", "function")
          && exportHas(exports, "__testing", "object");
      },
      run(exports) {
        ctx.state.npcAggroHook = ctx.npcAggro.wrapBehaviorExports(exports);
      },
    });
  }
  return hooks;
}

function installClientDelivery(deps) {
  const fs = require("node:fs");
  const path = require("node:path");
  const { buildPayload, createClientDelivery, DELIVERY_KEY } = require("./lib/adapter/clientDelivery");
  const { installHandshakeHook } = require("./lib/adapter/handshakeHook");
  const readFile = deps.readFile || ((file) => fs.readFileSync(file, "utf8"));
  const root = deps.root || path.resolve(MOD_DIR, "..", "..");
  let delivery = null;
  try {
    const payload = buildPayload(String(readFile(path.join(MOD_DIR, CLIENT_SOURCE_REL))));
    if (payload.ok) delivery = createClientDelivery({ encoded: payload.encoded, log: deps.logger });
  } catch (_err) {
    delivery = null;
  }
  const hook = installHandshakeHook({ moduleApi: deps.moduleApi, globalObj: deps.globalObj, root, readFile,
    hashes: deps.config.clientWindowHandshakeHashes, delivery, logger: deps.logger });
  if (!hook.ok) return { delivery: null, hook };
  deps.globalObj[DELIVERY_KEY] = delivery;
  return { delivery, hook };
}

function hookStatus(ctx) {
  const cd = ctx.clientDelivery;
  if (!cd || !cd.hook) return "hook:OFF";
  return cd.hook.ok ? `hook:${cd.hook.state.status}` : `hook:OFF:${cd.hook.reason}`;
}

function installModuleHook(moduleApi, hooks, logger = defaultLogger) {
  const originalLoad = moduleApi._load;
  const pending = hooks.map((hook) => ({ hook, done: false }));
  moduleApi._load = function shipWingHookedLoad(request, parent) {
    const result = originalLoad.apply(this, arguments);
    if (!parent || !parent.filename) return result;
    for (const entry of pending) {
      if (entry.done) continue;
      try {
        if (typeof request !== "string" || !entry.hook.match(request, result)) continue;
        entry.done = true;
        entry.hook.run(result, request, parent);
        logger.debug(`hook "${entry.hook.name}" applied`);
      } catch (err) {
        entry.done = true;
        logger.logError(`hook "${entry.hook.name}" failed - continuing without it`, err);
      }
    }
    return result;
  };
  return pending;
}

function install(deps = {}) {
  const env = deps.env || process.env;
  const logger = deps.logger || defaultLogger;
  const isMainThread = deps.isMainThread === undefined ? workerThreads.isMainThread : deps.isMainThread;
  const globalObj = deps.globalObj || globalThis;
  const moduleApi = deps.moduleApi || Module;

  if (env[NO_INSTALL_ENV] === "1") return { ok: false, reason: "no_install_env" };
  if (!isMainThread) return { ok: false, reason: "not_main_thread" };
  const loadConfig = deps.loadConfig || (() => require("./config").loadConfig({ env }));
  const configResult = safeLoadConfig(loadConfig);
  if (configResult.config.enabled !== true) {
    const problem = enabledProblem(configResult);
    if (problem) logger.log(`not enabled - ${problem}`);
    return { ok: false, reason: "disabled_by_config" };
  }
  if (globalObj[INSTALL_FLAG]) {
    logger.log("already installed - ignoring second preload");
    return { ok: false, reason: "already_installed" };
  }
  globalObj[INSTALL_FLAG] = true;
  try {
    if (typeof logger.setDebug === "function") logger.setDebug(configResult.config.debug === true);
  } catch (_err) {
  }
  const ctx = {
    modDir: MOD_DIR,
    moduleApi,
    logger,
    env,
    isMainThread,
    configResult,
    config: null,
    globalObj,
    liveSettings: null,
    liveEntry: null,
    startServices: deps.startServices || defaultStartServices,
    adapterDeps: deps.adapterDeps || {},
    storeDeps: deps.storeDeps || {},
    timers: deps.timers || null,
    adapter: null,
    store: null,
    wing: null,
    guards: null,
    driver: null,
    chat: null,
    clientWindow: null,
    uiPrefs: null,
    uiPrefsApi: null,
    clientDelivery: null,
    lossHook: null,
    sceneGuard: null,
    miningHook: null,
    salvageHook: null,
    combatAccess: null,
    ammoReceipts: null,
    commandMirror: null,
    safeLogoffHook: null,
    burst: null,
    drones: null,
    npcAggro: null,
    stop: null,
    state: { readinessSeen: false, serverSrc: null, bootstrapFile: null, started: false, guardsReady: false,
      lossReady: false, derivedReady: false, tickReady: false, stopped: false, lastTelemetry: null,
      npcAggroHook: null,
      salvageBoundary: null },
  };
  if (configResult.ok === true && configResult.config.npcAggroEnabled === true) {
    const { createNpcAggro } = require("./lib/adapter/npcAggro");
    ctx.npcAggro = createNpcAggro({ log: logger });
  }
  ctx.stop = (reason) => stopServices(ctx, reason);
  if (configResult.ok === true && configResult.config.clientWindowEnabled === true) {
    try {
      ctx.clientDelivery = installClientDelivery({ moduleApi, globalObj, logger, config: configResult.config,
        ...(deps.handshakeDeps || {}) });
    } catch (err) {
      ctx.clientDelivery = { delivery: null,
        hook: { ok: false, reason: "INTERNAL", line: "SHIPWING_UI:UNAVAILABLE:INTERNAL" } };
      logger.logError("client delivery failed at preload - window off", err);
    }
  }
  const pending = installModuleHook(moduleApi, buildHooks(ctx), logger);
  logger.debug(`armed v${MOD_VERSION} - ${pending.length} hook(s), loaded from ${MOD_DIR}`);
  return { ok: true, reason: null, ctx };
}

module.exports = {
  MOD_VERSION, INSTALL_FLAG, NO_INSTALL_ENV, exportHas, buildHooks, installModuleHook, install, taskReadyFor,
  startAmmoReceiptPrune, weaponsStatus, autoTargetStatus, droneMiningStatus,
};

if (process.env[NO_INSTALL_ENV] !== "1") {
  try {
    install();
  } catch (err) {
    defaultLogger.logError("loader failed to install - mod not running", err);
  }
}
