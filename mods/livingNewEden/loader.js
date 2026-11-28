"use strict";

const Module = require("node:module");
const workerThreads = require("node:worker_threads");
const defaultLogger = require("./lib/log");

const MOD_VERSION = "0.2.1";
const MOD_DIR = __dirname;

const INSTALL_FLAG = "__livingNewEdenLoaderInstalled";

const NO_INSTALL_ENV = "EVEJS_LNE_NO_INSTALL";

const ENV_ROLE_KEY = "EVEJS_GAMESTORE_OWNER_ROLE";

const BOOTSTRAP_REQUEST = /[\\/]bootstrap(\.js)?$/;

function exportHas(value, property, expectedType) {
  if (value === null || typeof value !== "object") return false;
  if (!Object.prototype.hasOwnProperty.call(value, property)) return false;
  return typeof value[property] === expectedType;
}

function formatDiag(diag) {
  return Object.keys(diag).map((key) => `${key}=${diag[key]}`).join(" ");
}

function mainFilename() {
  return (require.main && require.main.filename) || null;
}

function gateInput(ctx, processRole) {
  return {
    isMainThread: ctx.isMainThread,
    envRole: ctx.env[ENV_ROLE_KEY],
    processRole,
    hasProcessSend: typeof process.send === "function",
    mainFilename: mainFilename(),
  };
}

function defaultStartServices(world, ctx) {
  const gate = ctx.state.bootGate;
  ctx.logger.log(
    `ready (world process) v${MOD_VERSION} pid=${process.pid} role=${gate.diag.envRole} `
    + `processRole=${gate.diag.processRole} ipc=${gate.diag.hasProcessSend} main=${gate.diag.mainFilename} `
    + `readinessSeen=${ctx.state.readinessSeen} dir=${ctx.modDir} dataDir=${ctx.config.dataDir}`,
  );
  const { createServiceRegistry } = require("./lib/runtime/services");
  ctx.services = createServiceRegistry({ logger: ctx.logger });
  ctx.services.startAll(ctx);
}

function failedConfig(err) {
  return {
    ok: false,
    config: { enabled: false, debug: false, modules: {} },
    sources: {},
    warnings: [],
    errors: [`config_load_failed: ${(err && err.message) || err}`],
  };
}

function getConfig(ctx) {
  if (ctx.state.configResult) return ctx.state.configResult;
  let result;
  try {
    result = ctx.loadConfig();
    if (!result || typeof result !== "object" || !result.config || typeof result.config !== "object") {
      result = failedConfig(new Error("loadConfig returned no config"));
    }
  } catch (err) {
    result = failedConfig(err);
  }
  ctx.state.configResult = result;
  try {
    if (typeof ctx.logger.setDebug === "function") ctx.logger.setDebug(result.config.debug === true);
  } catch (_err) {
  }
  return result;
}

function reportConfig(ctx, result) {
  if (ctx.state.configReported) return;
  ctx.state.configReported = true;
  for (const w of Array.isArray(result.warnings) ? result.warnings : []) ctx.logger.log(`config: warning - ${w}`);
  for (const e of Array.isArray(result.errors) ? result.errors : []) ctx.logger.log(`config: error - ${e}`);
}

function getAdapter(ctx) {
  if (!ctx.adapterInstance) {
    const { createAdapter } = require("./lib/adapter");
    const deps = { moduleApi: ctx.moduleApi, logger: ctx.logger, ...ctx.adapterDeps };
    if (ctx.config) deps.config = ctx.config;
    ctx.adapterInstance = createAdapter(deps);
  }
  return ctx.adapterInstance;
}

function onReadiness(ctx, request, parent) {
  ctx.state.readinessSeen = true;
  if (!getConfig(ctx).config.enabled) {
    ctx.logger.debug("readiness: skipped - disabled_by_config");
    return;
  }
  const { evaluateWorldGate } = require("./lib/runtime/worldGate");
  const { findCachedProcessRole, GAMESTORE_SEARCH_MAX_DEPTH } = require("./lib/adapter/locator");
  let found;
  try {
    const filename = ctx.moduleApi._resolveFilename(request, parent);
    found = findCachedProcessRole(ctx.moduleApi._cache, filename, GAMESTORE_SEARCH_MAX_DEPTH);
  } catch (_err) {
    found = { ok: false, reason: "gamestore_not_cached" };
  }
  if (!found.ok) {
    const refused = evaluateWorldGate(gateInput(ctx, undefined));
    ctx.state.readinessGate = { ok: false, reason: found.reason, diag: refused.diag };
    ctx.logger.log(`readiness gate refused - ${found.reason} ${formatDiag(refused.diag)}`);
    return;
  }
  ctx.state.serverSrc = found.srcDir;
  const gate = evaluateWorldGate(gateInput(ctx, found.processRole));
  ctx.state.readinessGate = gate;
  if (gate.ok) ctx.logger.debug("readiness: world gate ok");
  else {
    ctx.logger.log(`readiness gate refused - ${gate.reason} ${formatDiag(gate.diag)}`);
    dropStallTimers(ctx, "gate");
  }
}

function runProbe(ctx) {
  const { findServerSrcInCache, GAMESTORE_SEARCH_MAX_DEPTH } = require("./lib/adapter/locator");
  const { formatProbeLog } = require("./lib/adapter/probe");
  const adapter = getAdapter(ctx);
  let serverSrc = ctx.state.serverSrc;
  if (!serverSrc) {
    const found = findServerSrcInCache(ctx.moduleApi._cache, ctx.state.bootstrapFile, GAMESTORE_SEARCH_MAX_DEPTH);
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

function onBooted(ctx, world) {
  if (ctx.state.essCollapse) {
    try {
      ctx.state.essCollapse.markReady("booted");
    } catch (err) {
      ctx.logger.logError("essCollapse: markReady failed", err);
    }
  }
  const { evaluateWorldGate } = require("./lib/runtime/worldGate");
  const { processRoleFromWorld } = require("./lib/adapter/locator");
  const role = processRoleFromWorld(world);
  if (!role.ok) {
    ctx.logger.log(`boot: not starting services - ${role.reason}`);
    dropStallTimers(ctx, "gate");
    return;
  }
  const gate = evaluateWorldGate(gateInput(ctx, role.processRole));
  if (!gate.ok) {
    ctx.logger.log(`boot: not starting services - ${gate.reason} ${formatDiag(gate.diag)}`);
    dropStallTimers(ctx, "gate");
    return;
  }
  const state = ctx.state;
  if (state.servicesStarted || state.bootRefusal) return;
  const cfg = getConfig(ctx);
  reportConfig(ctx, cfg);
  if (!cfg.ok) {
    state.bootRefusal = "config_invalid";
    const count = Array.isArray(cfg.errors) ? cfg.errors.length : 0;
    ctx.logger.log(`boot: not starting services - config_invalid (${count} error(s))`);
    return;
  }
  if (!cfg.config.enabled) {
    state.bootRefusal = "disabled_by_config";
    const from = (cfg.sources && cfg.sources.enabled) || "unknown";
    ctx.logger.log(`boot: not starting services - disabled_by_config (disabled by config, enabled=false from ${from})`);
    return;
  }
  ctx.config = cfg.config;
  state.servicesStarted = true;
  state.bootGate = gate;
  ctx.bootWorld = world;
  try {
    runProbe(ctx);
    reportProjection(ctx);
    reportSiteProjection(ctx);
    reportCampaignSpread(ctx);
    reportEssRepositoryFast(ctx);
    reportDbsKillmailCache(ctx);
    reportEssCollapse(ctx);
    reportStallDiag(ctx);
    reportSitePolicyHubs(ctx);
    reportEmpireBelts(ctx);
  } catch (err) {
    ctx.logger.logError("probe failed - continuing", err);
  }
  try {
    reportBuildInputs(ctx);
  } catch (err) {
    ctx.logger.logError("probe failed - continuing", err);
  }
  try {
    installSiteNavy(ctx);
  } catch (err) {
    ctx.state.siteNavy = "refused";
    ctx.logger.logError("siteNavy: install failed - anomalies stay pirate", err);
  }
  try {
    installMiningEncounters(ctx);
  } catch (err) {
    ctx.state.miningEncounters = "refused";
    ctx.logger.logError("miningEncounters: install failed - mining without waves", err);
  }
  try {
    ctx.startServices(world, ctx);
  } catch (err) {
    ctx.logger.logError("service start failed - mod not running", err);
  }
  try {
    checkStallTimers(ctx);
  } catch (err) {
    ctx.logger.logError("stallDiag: timer check failed", err);
  }
  try {
    startCampaignSpreadRetry(ctx);
  } catch (err) {
    ctx.logger.logError("sovCampaignSpread: start retry not started - window jobs keep the vendor time", err);
  }
  publishCapitalLive(ctx);
  publishBuildInputs(ctx);
}

function projectionEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.world) && c.world.projectionEnabled === true;
}

function standingsEnabled(c) {
  const on = (name) => Boolean(c.modules && c.modules[name]) && c.modules[name].enabled === true;
  return Boolean(c) && c.enabled === true && on("world") && on("scheduler") && on("persistence")
    && Boolean(c.standings) && c.standings.enabled === true;
}

function playerActivityEnabled(c) {
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.strategy)
    && c.modules.strategy.enabled === true && Boolean(c.strategy) && c.strategy.playerActivityEnabled === true;
}

function frontJobsEnabled(c) {
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.occupation) && c.occupation.enabled === true && Boolean(c.frontJobs) && c.frontJobs.enabled === true;
}

function bountyLiveEnabled(c) {
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.bountyHunters) && c.bountyHunters.enabled === true && c.bountyHunters.liveEnabled === true;
}

function situationKillsEnabled(c) {
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.situations) && c.situations.enabled === true;
}

function seasonKillsEnabled(c) {
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.seasons) && c.seasons.enabled === true;
}

function liveLossImportEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.materialization) && c.modules.materialization.enabled === true
    && Boolean(c.battle && c.battle.liveLossImport) && c.battle.liveLossImport.enabled === true;
}

function shipAiLossEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.shipAi) && c.shipAi.enabled === true
    && c.shipAi.proactiveEnabled === true;
}

function capsuleFxEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.capsuleFx) && c.capsuleFx.enabled === true;
}

function shipAiKillsEnabled(c) {
  return Boolean(c) && c.enabled === true && Boolean(c.shipAi) && c.shipAi.enabled === true
    && c.shipAi.proactiveEnabled === true && c.shipAi.triggersEnabled === true && c.shipAi.killLinesEnabled === true;
}

function materializationEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.materialization) && c.modules.materialization.enabled === true;
}

function capitalLiveEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return materializationEnabled(ctx) && Boolean(c.materialization) && c.materialization.capitalLiveEnabled === true;
}

function factionProfilesEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.materialization)
    && c.materialization.factionProfilesEnabled === true;
}

function bountyFreightersEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.bountyHunters) && c.bountyHunters.enabled === true && c.bountyHunters.smugglerEnabled === true;
}

function civilianHullsEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.highsecLife) && c.highsecLife.enabled === true && c.highsecLife.civilianHullsEnabled === true;
}

function pilotHullsEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return civilianHullsEnabled(ctx) && Boolean(c.population) && c.population.enabled === true
    && Boolean(c.population.hulls) && c.population.hulls.enabled === true;
}

function noteFactionProfiles(ctx, outcome, detail) {
  if (outcome === "built") {
    ctx.logger.log(`factionLiveProfiles: ${ctx.state.factionProfiles} - ${detail.rowsInjected} NPC profile row(s) `
      + "injected");
  } else {
    ctx.logger.log(`factionLiveProfiles: build failed (${detail.reason}) - vendor NPC tables only`);
    const err = detail.error;
    if (err !== undefined) ctx.logger.debug(`factionLiveProfiles build failure: ${(err && err.stack) || err}`);
  }
}

function sentriesEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.modules && c.modules.strategy)
    && c.modules.strategy.enabled === true && Boolean(c.sentries) && c.sentries.enabled === true;
}

function runSentryHook(ctx, group, install, exports, request, parent) {
  if (!ctx.state.sentrySeams) ctx.state.sentrySeams = {};
  if (!sentriesEnabled(ctx)) {
    ctx.state.sentrySeams[group] = "disabled";
    ctx.logger.debug(`sentries: ${group} not wrapped - disabled by config`);
    return;
  }
  let filename = "";
  try {
    filename = ctx.moduleApi._resolveFilename(request, parent);
  } catch (_err) {
    filename = "";
  }
  const r = install(exports, { cache: ctx.moduleApi._cache, filename });
  if (!r.ok) {
    ctx.state.sentrySeams[group] = "refused";
    ctx.logger.log(`sentries: ${group} wrap refused - ${r.reason} ${r.detail || ""}`.trim());
    return;
  }
  ctx.state.sentrySeams[group] = r.alreadyInstalled ? "already_installed" : "wrapped";
}

function buildCapitalLiveRows(ctx) {
  const c = getConfig(ctx).config;
  const authorityExports = ctx.state.capitalNpcAuthority;
  const authority = authorityExports && Array.isArray(authorityExports.CAPITAL_NPC_AUTHORITY)
    ? authorityExports.CAPITAL_NPC_AUTHORITY : [];
  const { FACTION_HULL_CLASSES, classTypeOf } = require("./lib/strategy/data/factionHullClasses");
  const { parseHullGroupList } = require("./lib/fleets/schema");
  const { buildCapitalProfileRows } = require("./lib/adapter/capitalProfiles");
  return buildCapitalProfileRows({
    authority,
    classTypeOf,
    factionIds: Object.keys(FACTION_HULL_CLASSES).map(Number),
    classes: parseHullGroupList(String(c.materialization.capitalClassesLive)) || [],
    fighters: c.materialization.capitalFightersEnabled === true,
    superweapons: c.materialization.capitalSuperweaponsEnabled === true,
    data: require("./lib/adapter/data/capitalLiveProfiles"),
  });
}

function publishCapitalLive(ctx) {
  const telemetry = ctx.telemetry;
  const live = ctx.state.capitalLive;
  if (!telemetry || typeof telemetry.gauge !== "function" || (live !== "wrapped" && live !== "already_installed")) return;
  const s = require("./lib/adapter/capitalProfiles").stats();
  try {
    telemetry.gauge("capitalLive.rowsInjected", s.rowsInjected);
    telemetry.gauge("capitalLive.skipped", s.skipped);
    const fresh = s.buildFailed - (ctx.state.capitalLiveFailedReported || 0);
    if (fresh > 0 && typeof telemetry.count === "function") {
      ctx.state.capitalLiveFailedReported = s.buildFailed;
      telemetry.count("capitalLive.buildFailed", fresh);
    }
  } catch (_err) {
  }
}

function reportBuildInputs(ctx) {
  if (ctx.state.buildInputs) return;
  const knobs = (ctx.config && ctx.config.buildInputs) || {};
  const { evaluateBuildInputs, formatBuildInputsLine } = require("./lib/runtime/buildInputsCheck");
  if (knobs.enabled !== true) {
    ctx.state.buildInputs = { state: "skipped", reason: "disabled_by_config", degraded: false };
    ctx.logger.log(formatBuildInputsLine(ctx.state.buildInputs));
    return;
  }
  const started = process.hrtime.bigint();
  let read;
  try {
    read = ctx.adapter && typeof ctx.adapter.readBuildInputs === "function"
      ? ctx.adapter.readBuildInputs({ maxFiles: knobs.maxFiles })
      : { ok: false, reason: "SEAM_UNAVAILABLE", detail: "no_adapter" };
  } catch (err) {
    read = { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err) };
  }
  const result = evaluateBuildInputs({ read, requireManifest: knobs.requireManifest === true,
    listLimit: knobs.listLimit });
  result.checkMs = Number(process.hrtime.bigint() - started) / 1e6;
  ctx.state.buildInputs = result;
  ctx.logger.log(formatBuildInputsLine(result, { requireManifest: knobs.requireManifest === true }));
}

function publishBuildInputs(ctx) {
  const telemetry = ctx.telemetry;
  const result = ctx.state.buildInputs;
  if (!telemetry || !result || result.state === "skipped" || ctx.state.buildInputsPublished) return;
  ctx.state.buildInputsPublished = true;
  try {
    if (typeof telemetry.count === "function") {
      telemetry.count("buildInputs.missing", result.missing || 0);
      telemetry.count("buildInputs.sizeMismatch", result.sizeMismatch || 0);
    }
    if (typeof telemetry.gauge === "function") {
      telemetry.gauge("buildInputs.unverified", result.state === "unverified" ? 1 : 0);
    }
    if (typeof telemetry.observe === "function" && Number.isFinite(result.checkMs)) {
      telemetry.observe("buildInputs.checkMs", result.checkMs);
    }
  } catch (_err) {
  }
}

function noteCapitalLive(ctx, outcome, detail) {
  if (outcome === "built") {
    ctx.logger.log(`capitalLive: ${detail.rowsInjected} NPC row(s) injected, ${detail.skipped} class(es) skipped`);
  } else {
    ctx.logger.log(`capitalLive: build failed (${detail.reason}) - vendor NPC tables only`);
    const err = detail.error;
    if (err !== undefined) ctx.logger.debug(`capitalLive build failure: ${(err && err.stack) || err}`);
  }
  publishCapitalLive(ctx);
}

function capitalFighterDamageEnabled(ctx) {
  if (!capitalLiveEnabled(ctx)) return false;
  const m = getConfig(ctx).config.materialization;
  return m.capitalFightersEnabled === true && m.capitalFighterDamageEnabled === true;
}

const FIGHTER_COUNTER_METRICS = Object.freeze({ strikes: "capitalLive.fighterStrikes", hits: "capitalLive.fighterHits",
  kills: "capitalLive.fighterKills", skipped: "capitalLive.fighterSkipped", errors: "capitalLive.fighterErrors" });

function noteCapitalFighterCounts(ctx, delta) {
  const telemetry = ctx.telemetry;
  if (!telemetry || typeof telemetry.count !== "function") return;
  for (const key of Object.keys(FIGHTER_COUNTER_METRICS)) {
    if (delta[key] > 0) telemetry.count(FIGHTER_COUNTER_METRICS[key], delta[key]);
  }
}

function noteCapitalFighterGate(ctx, gate) {
  ctx.state.capitalFighterGate = gate;
  const telemetry = ctx.telemetry;
  if (telemetry && typeof telemetry.gauge === "function") {
    telemetry.gauge("capitalLive.fighterGateFixed", gate === "fixed" ? 1 : 0);
    telemetry.gauge("capitalLive.fighterGateUnknown", gate === "unknown" ? 1 : 0);
  }
  if (gate === "ok") ctx.logger.log("capitalFighterStrike: vendor NPC fighter gate closed - the mod runs the cycle");
  else if (gate === "fixed") ctx.logger.log("capitalFighterStrike: off - the vendor lets NPC fighters act");
  else ctx.logger.log("capitalFighterStrike: off - vendor NPC fighter gate unknown (canPlayerCompanionActOnTarget)");
}

function noteCapitalFighterError(ctx, err) {
  if (ctx.state.capitalFighterErrorLogged) return;
  ctx.state.capitalFighterErrorLogged = true;
  ctx.logger.logError("capitalFighterStrike: strike failed - counted in capitalLive.fighterErrors, further only counted",
    err);
}

function capitalFighterDeps(ctx) {
  let classIndex = null;
  let catalog = null;
  return {
    tools: () => (ctx.adapter && typeof ctx.adapter.capitalFighterTools === "function"
      ? ctx.adapter.capitalFighterTools() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    classIndex: () => {
      if (classIndex) return classIndex;
      const read = require("./lib/adapter/capitalProfiles").readIndex();
      if (!read.ok) return read;
      classIndex = { ok: true, index: require("./lib/adapter/fighterStrikePlan").reverseIndex(read.index) };
      return classIndex;
    },
    rowDps: (typeId, cls) => {
      if (!catalog) {
        catalog = { TYPES: require("./lib/battle/data/strengthCatalog").TYPES,
          CAPITAL_STRENGTH_ROWS: require("./lib/battle/data/capitalStrengthRows").CAPITAL_STRENGTH_ROWS };
      }
      return require("./lib/adapter/fighterStrikePlan").rowDpsOf(typeId, cls, catalog);
    },
    tubes: (cls) => {
      const tubes = require("./lib/adapter/data/capitalLiveProfiles").FIGHTER_TUBES;
      return Object.prototype.hasOwnProperty.call(tubes, cls) ? tubes[cls] : 0;
    },
  };
}

function capitalFaxRepairEnabled(ctx) {
  if (!capitalLiveEnabled(ctx)) return false;
  return getConfig(ctx).config.materialization.capitalFaxRepairEnabled === true;
}

const FAX_COUNTER_METRICS = Object.freeze({ cycles: "capitalLive.faxRepairCycles", hp: "capitalLive.faxRepairHp",
  idle: "capitalLive.faxRepairIdle", refused: "capitalLive.faxRepairRefused",
  vendorActive: "capitalLive.faxRepairVendorActive", errors: "capitalLive.faxRepairErrors" });

function noteCapitalFaxCounts(ctx, delta) {
  const telemetry = ctx.telemetry;
  if (!telemetry || typeof telemetry.count !== "function") return;
  for (const key of Object.keys(FAX_COUNTER_METRICS)) {
    if (delta[key] > 0) telemetry.count(FAX_COUNTER_METRICS[key], delta[key]);
  }
}

function noteCapitalFaxError(ctx, err) {
  if (ctx.state.capitalFaxErrorLogged) return;
  ctx.state.capitalFaxErrorLogged = true;
  ctx.logger.logError("capitalFaxRepair: repair failed - counted in capitalLive.faxRepairErrors, further only counted",
    err);
}

function capitalFaxDeps(ctx) {
  let classIndex = null;
  let catalog = null;
  return {
    tools: () => (ctx.adapter && typeof ctx.adapter.capitalFaxTools === "function"
      ? ctx.adapter.capitalFaxTools() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    classIndex: () => {
      if (classIndex) return classIndex;
      const read = require("./lib/adapter/capitalProfiles").readIndex();
      if (!read.ok) return read;
      classIndex = { ok: true, index: require("./lib/adapter/fighterStrikePlan").reverseIndex(read.index) };
      return classIndex;
    },
    remoteRep: (typeId) => {
      if (!catalog) {
        catalog = { TYPES: require("./lib/battle/data/strengthCatalog").TYPES,
          CAPITAL_STRENGTH_ROWS: require("./lib/battle/data/capitalStrengthRows").CAPITAL_STRENGTH_ROWS };
      }
      return require("./lib/adapter/faxRepairPlan").rowRemoteRepOf(typeId, catalog);
    },
    liveSideOf: (entityId) => {
      const m = ctx.materialization;
      return m && typeof m.liveSideOf === "function" ? m.liveSideOf(entityId) : { ok: false, reason: "NOT_LIVE" };
    },
  };
}

function localPilotsEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.localPilots) && c.localPilots.enabled === true
    && !(c.modules && c.modules.world && c.modules.world.enabled === false);
}

function noteProjection(ctx, outcome, reason) {
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.projection.${outcome}`, 1);
  if (outcome === "failed" && !ctx.state.projectionFailureLogged) {
    ctx.state.projectionFailureLogged = true;
    ctx.logger.log(`pirateFactionProjection: controller read failed (${reason}) - vendor faction used; `
      + "further failures only counted");
  }
}

function reportProjection(ctx) {
  if (!projectionEnabled(ctx) || ctx.state.projection === "wrapped") return;
  ctx.logger.log(`pirateFactionProjection: not wrapped at boot (${ctx.state.projection || "hook_not_fired"}) `
    + "- belt rats use the vendor faction");
}

function siteProjectionEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.world) && c.world.siteProjectionEnabled === true;
}

function noteSiteProjection(ctx, outcome, reason) {
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.siteProjection.${outcome}`, 1);
  if (outcome === "failed" && !ctx.state.siteProjectionFailureLogged) {
    ctx.state.siteProjectionFailureLogged = true;
    ctx.logger.log(`siteFactionProjection: failed (${reason}) - vendor site faction used; `
      + "further failures only counted");
  }
}

function reportSiteProjection(ctx) {
  if (!siteProjectionEnabled(ctx) || ctx.state.siteProjection === "wrapped") return;
  ctx.logger.log(`siteFactionProjection: not wrapped at boot (${ctx.state.siteProjection || "hook_not_fired"}) `
    + "- universe sites use the vendor faction");
}

function campaignSpreadMsOf(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const sov = c && c.enabled === true && c.world && c.world.sovProjection;
  if (!sov || sov.campaignSpreadEnabled !== true) return 0;
  const spreadMs = Number(sov.campaignSpreadMs);
  return Number.isSafeInteger(spreadMs) && spreadMs > 0 ? spreadMs : 0;
}

function noteCampaignSpread(ctx, outcome, names) {
  if (!names.includes(outcome)) return;
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`sovProjection.campaignSpread.${outcome}`, 1);
  if (outcome === "failed" && !ctx.state.sovCampaignSpreadFailureLogged) {
    ctx.state.sovCampaignSpreadFailureLogged = true;
    ctx.logger.log("sovCampaignSpread: spread failed - vendor due time used; further failures only counted");
  }
}

function reportCampaignSpread(ctx) {
  if (campaignSpreadMsOf(ctx) <= 0 || ctx.state.sovCampaignSpread === "wrapped") return;
  ctx.logger.log(`sovCampaignSpread: not wrapped at boot (${ctx.state.sovCampaignSpread || "hook_not_fired"}) `
    + "- LNE sov hub window ticks are not spread");
}

function essRepositoryKnobsOf(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const e = c && c.enabled === true && c.world && c.world.essRepository;
  const int = (value) => (Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : 0);
  if (!e) return { fast: false, stats: false, parityEvery: 0, statsLogMinutes: 0 };
  return { fast: e.fastReadEnabled === true, stats: e.statsEnabled === true, parityEvery: int(e.parityEvery),
    statsLogMinutes: int(e.statsLogMinutes) };
}

function noteEssRepository(ctx, name, names) {
  if (!names.includes(name)) return;
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.essRepository.${name}`, 1);
}

function armEssRepositoryStats(ctx, core, essExports, minutes) {
  const { statsPeriodMs } = require("./lib/adapter/essRepositoryFast");
  const periodMs = statsPeriodMs(minutes);
  if (periodMs <= 0) return;
  const setTimer = ctx.setTimer || require("./lib/presence/poller").defaultSetTimer;
  const fire = () => {
    try {
      if (core.hasActivity()) ctx.logger.log(core.statsLine(essExports));
      core.resetWindow();
    } catch (err) {
      ctx.logger.logError("essRepositoryFast: stats line failed", err);
    }
    setTimer(fire, periodMs);
  };
  setTimer(fire, periodMs);
}

function installEssRepositoryFast(ctx, essExports) {
  const knobs = essRepositoryKnobsOf(ctx);
  if (!knobs.fast && !knobs.stats) {
    ctx.state.essRepositoryFast = "disabled";
    ctx.logger.debug("essRepositoryFast: not wrapped - disabled by config");
    return;
  }
  const fs = require("node:fs");
  const { install, COUNTER_NAMES } = require("./lib/adapter/essRepositoryFast");
  const readFile = ctx.readFile || ((absPath) => {
    try {
      return fs.readFileSync(absPath, "utf8");
    } catch (_err) {
      return null;
    }
  });
  const out = install(essExports, {
    requireCache: ctx.moduleApi && ctx.moduleApi._cache,
    readFile,
    config: knobs,
    log: (line) => ctx.logger.log(line),
    onCount: (name) => noteEssRepository(ctx, name, COUNTER_NAMES),
  });
  const core = out.ok ? out.core : out.statsCore;
  if (!core) {
    ctx.state.essRepositoryFast = "refused";
    ctx.logger.log(`essRepositoryFast: not wrapped - ${out.reason}${out.detail ? ` (${out.detail})` : ""}`
      + " - vendor full table clones");
    return;
  }
  ctx.state.essRepositoryFastCore = core;
  ctx.state.essRepositoryFast = core.state();
  if (out.alreadyInstalled) return;
  ctx.logger.log(`essRepositoryFast: ${core.state()} parityEvery=${knobs.parityEvery}`);
  armEssRepositoryStats(ctx, core, essExports, knobs.statsLogMinutes);
}

function essCollapseKnobsOf(ctx) {
  if (ctx.isMainThread !== true || ctx.env[ENV_ROLE_KEY] !== "world") return null;
  if (/\.worker\.js$/.test(mainFilename() || "")) return null;
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const k = c && c.enabled === true && c.world && c.world.essCollapse;
  if (!k || k.enabled !== true) return null;
  return { pumpIntervalMs: k.pumpIntervalMs, maxSystemsPerTick: k.maxSystemsPerTick, tickBudgetMs: k.tickBudgetMs,
    startDelayMs: k.startDelayMs, maxHoldMs: k.maxHoldMs, retryDelayMs: k.retryDelayMs, maxRetries: k.maxRetries,
    maxPending: k.maxPending };
}

function essGameExportsOf(ctx, srcDir, rel, opts) {
  const absPath = srcDir === null ? null : require("node:path").join(srcDir, ...rel.split("/"));
  const cache = ctx.moduleApi && ctx.moduleApi._cache;
  if (cache && absPath !== null) {
    const entry = cache[absPath];
    if (entry && entry.exports) return entry.exports;
  }
  const adapter = ctx.adapter;
  if (adapter && typeof adapter.requireGame === "function") {
    const r = adapter.requireGame(rel.replace(/\.js$/, ""));
    if (r && r.ok === true && r.exports) return r.exports;
  }
  if (opts && opts.load === true && absPath !== null && ctx.moduleApi && typeof ctx.moduleApi._load === "function") {
    try {
      const parentEntry = cache
        ? cache[require("node:path").join(srcDir, "services", "dynamic", "essSettlementRuntime.js")] : null;
      const parent = parentEntry && parentEntry.filename ? parentEntry : null;
      return ctx.moduleApi._load(absPath, parent, false) || null;
    } catch (_err) {
      return null;
    }
  }
  return null;
}

function installEssCollapse(ctx, settlementExports) {
  const knobs = essCollapseKnobsOf(ctx);
  if (knobs === null) {
    ctx.state.essCollapseInstall = "disabled";
    return;
  }
  const path = require("node:path");
  const { performance } = require("node:perf_hooks");
  const mod = require("./lib/adapter/essCollapse");
  const srcDir = mod.locateSrcDir(settlementExports, ctx.moduleApi && ctx.moduleApi._cache);
  const text = srcDir === null ? null
    : readFileOf(ctx)(path.join(srcDir, "services", "dynamic", "essSettlementRuntime.js"));
  const out = mod.install({
    settlementExports,
    sourceText: typeof text === "string" ? text : null,
    deps: {
      recoverLosses: () => {
        const dbs = ctx.state.dbsExports
          || essGameExportsOf(ctx, srcDir, "services/dynamic/dynamicBountyRuntime.js", { load: true });
        if (!dbs || typeof dbs.recoverLosses !== "function") throw new Error("dynamicBountyRuntime not loaded");
        dbs.recoverLosses();
      },
      listBankSystemIds: () => {
        const st = essGameExportsOf(ctx, srcDir, "services/dynamic/dynamicResourceState.js", { load: true });
        if (!st || typeof st.listSystemStates !== "function") return { ok: false, reason: "dynamicResourceState" };
        return { ok: true, ids: st.listSystemStates().map((bank) => Number(bank && bank.solarSystemID)) };
      },
      now: () => Date.now(),
      perfNow: () => performance.now(),
      setTimer: ctx.setTimer || require("./lib/presence/poller").defaultSetTimer,
      log: (line) => ctx.logger.log(line),
      onCount: (name, n) => {
        const hooks = ctx.telemetry && ctx.telemetry.hooks;
        if (mod.COUNTER_NAMES.includes(name) && hooks && typeof hooks.onCount === "function") {
          hooks.onCount(`world.essCollapse.${name}`, n);
        }
      },
    },
    config: knobs,
  });
  if (!out.ok) {
    ctx.state.essCollapseInstall = out.reason;
    ctx.logger.log(`essCollapse: not wrapped - ${out.reason} - vendor ESS jobs`);
    return;
  }
  ctx.state.essCollapse = out.core;
  ctx.state.essCollapseInstall = out.core.state();
}

function reportEssCollapse(ctx) {
  if (essCollapseKnobsOf(ctx) === null) return;
  const core = ctx.state.essCollapse;
  if (!core) {
    ctx.logger.log(`essCollapse: not active at boot (${ctx.state.essCollapseInstall || "hook_not_fired"}) `
      + "- vendor ESS jobs");
    return;
  }
  const disabled = ctx.adapter && typeof ctx.adapter.getDisabledModules === "function"
    ? ctx.adapter.getDisabledModules() : null;
  if (disabled && Object.prototype.hasOwnProperty.call(disabled, "essCollapse")) {
    core.disable("probe", String(disabled.essCollapse));
  }
}

function installEssSettlementJobs(ctx, settlementExports) {
  try {
    installEssCollapse(ctx, settlementExports);
  } catch (err) {
    ctx.state.essCollapseInstall = "error";
    ctx.logger.logError("essCollapse: install failed - vendor ESS jobs", err);
  }
  const core = ctx.state.essRepositoryFastCore;
  if (!core) {
    ctx.state.essSettlementJobs = ctx.state.essRepositoryFast === "disabled" ? "disabled" : "no_core";
    return;
  }
  const { wrapHandleJob } = require("./lib/adapter/essRepositoryFast");
  const wrap = wrapHandleJob(settlementExports, core);
  ctx.state.essSettlementJobs = wrap.ok ? "wrapped" : wrap.reason;
}

function reportEssRepositoryFast(ctx) {
  const knobs = essRepositoryKnobsOf(ctx);
  if (!knobs.fast && !knobs.stats) return;
  const st = ctx.state.essRepositoryFast;
  if (st === "on" || st === "stats" || (typeof st === "string" && st.startsWith("disabled:"))) return;
  ctx.logger.log(`essRepositoryFast: not wrapped at boot (${st || "hook_not_fired"}) - vendor full table clones`);
}

function dbsKillmailCacheKnobsOf(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const k = c && c.enabled === true && c.world && c.world.dbsKillmailCache;
  if (!k || k.enabled !== true) return null;
  return { maxRecords: k.maxRecords, statsLogMinutes: essRepositoryKnobsOf(ctx).statsLogMinutes };
}

function readFileOf(ctx) {
  if (ctx.readFile) return ctx.readFile;
  const fs = require("node:fs");
  return (absPath) => {
    try {
      return fs.readFileSync(absPath, "utf8");
    } catch (_err) {
      return null;
    }
  };
}

function dbsKillmailCacheOf(ctx, exportsObj) {
  if (ctx.state.dbsKillmailCacheCore) return ctx.state.dbsKillmailCacheCore;
  const knobs = dbsKillmailCacheKnobsOf(ctx);
  if (knobs === null) return null;
  const mod = require("./lib/adapter/dbsKillmailCache");
  const core = mod.createDbsKillmailCache({ maxRecords: knobs.maxRecords, onCount: (name) => {
    const hooks = ctx.telemetry && ctx.telemetry.hooks;
    if (mod.COUNTER_NAMES.includes(name) && hooks && typeof hooks.onCount === "function") {
      hooks.onCount(`world.dbsKillmailCache.${name}`, 1);
    }
  } });
  ctx.state.dbsKillmailCacheCore = core;
  const srcDir = mod.locateSrcDir(exportsObj, ctx.moduleApi && ctx.moduleApi._cache);
  ctx.state.dbsKillmailCacheSrcDir = srcDir;
  const obsolete = srcDir === null ? null : mod.obsoleteDetail(srcDir, readFileOf(ctx));
  const drift = obsolete !== null ? null
    : srcDir === null ? "locate" : mod.checkFingerprints(srcDir, readFileOf(ctx));
  if (obsolete !== null) {
    core.disable("obsolete", obsolete);
    ctx.logger.log(`dbsKillmailCache: disabled:obsolete (${obsolete}) - the vendor walks killmails without a copy`);
    return core;
  }
  if (drift !== null) {
    core.disable("drift", drift);
    ctx.logger.log(`dbsKillmailCache: disabled:drift (${drift}) - vendor killmail copies in DBS`);
  } else if (ctx.state.dbsKillmailCacheProbe !== null) {
    core.disable("probe", ctx.state.dbsKillmailCacheProbe);
  } else {
    ctx.logger.log(`dbsKillmailCache: armed maxRecords=${knobs.maxRecords}`);
  }
  const periodMs = mod.statsPeriodMs(knobs.statsLogMinutes);
  if (periodMs > 0 && drift === null) {
    const setTimer = ctx.setTimer || require("./lib/presence/poller").defaultSetTimer;
    const fire = () => {
      try {
        if (core.hasActivity()) ctx.logger.log(core.statsLine());
        core.resetWindow();
      } catch (err) {
        ctx.logger.logError("dbsKillmailCache: stats line failed", err);
      }
      setTimer(fire, periodMs);
    };
    setTimer(fire, periodMs);
  }
  return core;
}

function installDbsKillmailGetAll(ctx, exports) {
  const core = dbsKillmailCacheOf(ctx, exports);
  if (core === null) {
    ctx.state.dbsKillmailGetAll = "disabled";
    return;
  }
  if (core.state().startsWith("disabled:")) {
    ctx.state.dbsKillmailGetAll = core.state();
    return;
  }
  const { installGetAll } = require("./lib/adapter/dbsKillmailCache");
  const src = ctx.state.dbsKillmailCacheSrcDir;
  const text = readFileOf(ctx)(require("node:path").join(src, "services", "killmail", "killmailState.js"));
  const out = installGetAll(core, exports, typeof text === "string" ? text : "");
  ctx.state.dbsKillmailGetAll = out.ok ? "wrapped" : out.reason;
  if (!out.ok) {
    core.disable("error", `getAll ${out.reason}${out.detail ? ` ${out.detail}` : ""}`);
    ctx.logger.log(`dbsKillmailCache: getAllKillmailRecords not wrapped - ${out.reason} - vendor killmail copies`);
  }
}

function installDbsKillmailScope(ctx, exports) {
  const core = dbsKillmailCacheOf(ctx, exports);
  if (core === null) {
    ctx.state.dbsKillmailScope = "disabled";
    return;
  }
  if (core.state().startsWith("disabled:")) {
    ctx.state.dbsKillmailScope = core.state();
    return;
  }
  const out = require("./lib/adapter/dbsKillmailCache").installScope(core, exports);
  ctx.state.dbsKillmailScope = out.ok ? "wrapped" : out.reason;
  if (!out.ok) ctx.logger.log(`dbsKillmailCache: DBS scope not wrapped - ${out.reason} - vendor killmail copies`);
}

function reportDbsKillmailCache(ctx) {
  if (dbsKillmailCacheKnobsOf(ctx) === null) return;
  const disabled = ctx.adapter && typeof ctx.adapter.getDisabledModules === "function"
    ? ctx.adapter.getDisabledModules() : null;
  const core = ctx.state.dbsKillmailCacheCore;
  if (disabled && Object.prototype.hasOwnProperty.call(disabled, "dbsKillmailCache")) {
    ctx.state.dbsKillmailCacheProbe = String(disabled.dbsKillmailCache);
    if (core) core.disable("probe", ctx.state.dbsKillmailCacheProbe);
    ctx.logger.log(`dbsKillmailCache: disabled:probe (${ctx.state.dbsKillmailCacheProbe}) - vendor killmail copies`);
    return;
  }
  if (ctx.state.dbsKillmailGetAll === "wrapped" && ctx.state.dbsKillmailScope === "wrapped") return;
  if (core && core.state() === "disabled:obsolete") return;
  ctx.logger.log(`dbsKillmailCache: not active at boot (getAll=${ctx.state.dbsKillmailGetAll || "hook_not_fired"} `
    + `scope=${ctx.state.dbsKillmailScope || "hook_not_fired"}) - vendor killmail copies in DBS`);
}

function stallDiagOf(ctx) {
  if (ctx.isMainThread !== true || ctx.env[ENV_ROLE_KEY] !== "world") return null;
  if (/\.worker\.js$/.test(mainFilename() || "")) return null;
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const t = c && c.enabled === true && c.modules && c.modules.telemetry && c.modules.telemetry.enabled === true
    ? c.telemetry : null;
  if (!t || t.spikeAttribution !== true || !t.stallDiag || t.stallDiag.enabled !== true) return null;
  return t.stallDiag;
}

function stallSinkOf(ctx) {
  return {
    noteForeign: (label, startMs, ms) => {
      const t = ctx.telemetry;
      if (t && typeof t.noteForeign === "function") t.noteForeign(label, startMs, ms);
    },
    noteJob: (type, atMs, ms) => {
      const t = ctx.telemetry;
      if (t && typeof t.noteJob === "function") t.noteJob(type, atMs, ms);
    },
  };
}

function serverRootOf(ctx) {
  return require("node:path").resolve(ctx.modDir, "..", "..");
}

function installStallTimers(ctx) {
  const sd = stallDiagOf(ctx);
  if (sd === null || sd.timerTags !== true) {
    ctx.state.stallDiagTimers = "disabled";
    return;
  }
  const path = require("node:path");
  const { performance } = require("node:perf_hooks");
  const { installTimerTags } = require("./lib/telemetry/timerTags");
  const out = installTimerTags({
    globalObj: ctx.globalObj,
    timersModule: require("node:timers"),
    now: () => performance.now(),
    sink: stallSinkOf(ctx),
    slowCallbackMs: sd.slowCallbackMs,
    stackDepth: sd.stackDepth,
    captureMaxPerSec: sd.captureMaxPerSec,
    maxMinutes: sd.maxMinutes,
    excludeDirs: [path.join(ctx.modDir, "lib", "telemetry")],
    rootDir: serverRootOf(ctx),
  });
  if (!out.ok) {
    ctx.state.stallDiagTimers = out.reason;
    ctx.logger.log(`stallDiag: timer tags not installed - ${out.reason}`);
    return;
  }
  ctx.stallTimers = out;
  ctx.state.stallDiagTimers = "installed";
}

function dropStallTimers(ctx, why) {
  const timers = ctx.stallTimers;
  if (!timers) return;
  ctx.stallTimers = null;
  const out = timers.uninstall();
  ctx.state.stallDiagTimers = out.ok ? `uninstalled:${why}` : `${out.reason}:${why}`;
}

function installStallSeam(ctx, which, exports) {
  const sd = stallDiagOf(ctx);
  const key = which === "jobs" ? "stallDiagScheduler" : "stallDiagKillmail";
  if (sd === null || sd[which] !== true) {
    ctx.state[key] = "disabled";
    return;
  }
  const seams = require("./lib/adapter/stallSeams");
  const out = which === "jobs"
    ? seams.wrapDurableSchedulerExports(exports, stallSinkOf(ctx), { slowMs: sd.slowCallbackMs })
    : seams.wrapKillmailExports(exports, stallSinkOf(ctx), { slowMs: sd.slowCallbackMs, stackDepth: sd.stackDepth,
      rootDir: serverRootOf(ctx) });
  ctx.state[key] = out.ok ? "wrapped" : out.reason;
  if (!out.ok) ctx.logger.log(`stallDiag: ${which} seam not wrapped - ${out.reason}`);
}

function installStarmapKillsArm(ctx, exports) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const igm = c && c.enabled === true ? c.inGameMap : null;
  if (!igm || igm.enabled !== true || igm.starmapKillsEnabled !== true) {
    ctx.state.starmapKills = "disabled";
    return;
  }
  const out = require("./lib/adapter/starmapOverlay").armKills(exports, { maxSynthetic: igm.starmapMaxSyntheticKills,
    fallbackTypeId: igm.starmapFallbackShipTypeId });
  ctx.state.starmapKills = out.ok ? "armed" : out.reason;
  if (!out.ok) ctx.logger.log(`inGameMap: star map Kills forEach not wrapped - ${out.reason}`);
}

function reportStallDiag(ctx) {
  if (stallDiagOf(ctx) === null) return;
  const disabled = ctx.adapter && typeof ctx.adapter.getDisabledModules === "function"
    ? ctx.adapter.getDisabledModules() : null;
  const drift = disabled && Object.prototype.hasOwnProperty.call(disabled, "telemetry.stallDiag")
    ? ` probe=${disabled["telemetry.stallDiag"]}` : "";
  ctx.logger.log(`stallDiag: timers=${ctx.state.stallDiagTimers || "hook_not_fired"} `
    + `jobs=${ctx.state.stallDiagScheduler || "hook_not_fired"} killmail=${ctx.state.stallDiagKillmail || "hook_not_fired"}`
    + drift);
}

function checkStallTimers(ctx) {
  if (!ctx.stallTimers) return;
  let on = false;
  try {
    const st = ctx.telemetry && typeof ctx.telemetry.getStatus === "function" ? ctx.telemetry.getStatus() : null;
    on = Boolean(st && st.stallDiag);
  } catch (_err) {
    on = false;
  }
  if (!on) dropStallTimers(ctx, "no_telemetry");
}

function sitePolicyHubFastPathEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.world) && c.world.sitePolicyHubFastPathEnabled === true;
}

function sitePolicyHubScopeOf(ctx) {
  if (!ctx.state.sitePolicyHubScopeObject) {
    const { createSitePolicyHubScope } = require("./lib/adapter/sitePolicyHubs");
    ctx.state.sitePolicyHubScopeObject = createSitePolicyHubScope();
  }
  return ctx.state.sitePolicyHubScopeObject;
}

function noteSitePolicyHubs(ctx, outcome, names) {
  if (!names.includes(outcome)) return;
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.sitePolicyHubs.${outcome}`, 1);
}

function reportSitePolicyHubs(ctx) {
  if (!sitePolicyHubFastPathEnabled(ctx)) return;
  const upgrades = ctx.state.sitePolicyHubs || "hook_not_fired";
  const scope = ctx.state.sitePolicyHubScope || "hook_not_fired";
  if (upgrades === "wrapped" && scope === "wrapped") return;
  ctx.logger.log(`sitePolicyHubs: not wrapped at boot (getHubUpgrades ${upgrades}, policy scope ${scope}) `
    + "- every player entry settles the fuel of all hubs per sov system");
}

function campaignSpreadRetryOf(ctx) {
  const cfg = getConfig(ctx);
  const sov = cfg.ok && cfg.config.world ? cfg.config.world.sovProjection : null;
  const num = (value, fallback) => (Number.isSafeInteger(Number(value)) ? Number(value) : fallback);
  const max = sov ? num(sov.campaignSpreadRetryMax, 0) : 0;
  return {
    max,
    batch: sov ? num(sov.campaignSpreadRetryBatch, 1) : 1,
    delayMs: sov ? num(sov.campaignSpreadRetryDelayMs, 1000) : 1000,
    provisional: Boolean(sov) && sov.campaignSpreadProvisionalEnabled === true && max > 0,
  };
}

function servicesStopped(ctx) {
  try {
    const services = ctx.services;
    return Boolean(services && typeof services.getStatus === "function" && services.getStatus().stopped === true);
  } catch (_err) {
    return false;
  }
}

function startCampaignSpreadRetry(ctx) {
  const retry = ctx.state.sovCampaignSpreadRetry;
  if (!retry || ctx.state.sovCampaignSpread !== "wrapped") return;
  const vc = ctx.virtualCorps;
  const knobs = campaignSpreadRetryOf(ctx);
  if (knobs.max <= 0) {
    retry.clear();
    return;
  }
  const hasReady = Boolean(vc) && typeof vc.whenReady === "function";
  if (!hasReady && !knobs.provisional) {
    retry.clear();
    return;
  }
  const { runCampaignRetry } = require("./lib/adapter/sovCampaignSpread");
  const { defaultSetTimer } = require("./lib/presence/poller");
  runCampaignRetry(retry, {
    whenReady: () => (hasReady ? vc.whenReady() : Promise.reject(new Error("virtualCorps unavailable"))),
    nowMs: () => Date.now(),
    wait: (ms) => new Promise((resolve) => { defaultSetTimer(resolve, ms); }),
    batch: knobs.batch,
    delayMs: knobs.delayMs,
    isStopped: () => ctx.virtualCorps !== vc || servicesStopped(ctx),
  }).then((out) => {
    if (out.ok) {
      if (out.slices > 0) {
        ctx.logger.log(`sovCampaignSpread: start retry spread ${out.spread} window job(s), skipped ${out.skipped}, `
          + `kept ${out.kept}, restored ${out.restored}`);
      }
      return;
    }
    ctx.logger.log(`sovCampaignSpread: start retry ended (${out.reason}) - restored ${out.restored || 0} provisional `
      + "window job(s)");
  }, () => {});
}

function allianceOfSystemVia(ctx) {
  let reader = null;
  let readerOf = null;
  return (systemId) => {
    const adapter = ctx.adapter;
    if (!adapter || typeof adapter.getSovClaims !== "function") return null;
    if (readerOf !== adapter) {
      reader = adapter.getSovClaims();
      readerOf = adapter;
    }
    const claim = reader.claimOf(systemId);
    return claim && claim.ok === true ? claim.allianceId : null;
  };
}

function readControllerVia(ctx) {
  return (systemId) => {
    const world = ctx.world;
    if (!world || typeof world.getController !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    return world.getController(systemId);
  };
}

function readControllerMemoVia(ctx) {
  return (systemId) => {
    const world = ctx.world;
    if (world && typeof world.getControllerMemo === "function") return world.getControllerMemo(systemId);
    if (!world || typeof world.getController !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    return world.getController(systemId);
  };
}

function empireBeltsEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.world) && c.world.empireBeltsEnabled === true;
}

function beltPatrolEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return empireBeltsEnabled(ctx) && Boolean(c.world.beltNavy) && c.world.beltNavy.patrolFactionsEnabled === true;
}

function noteEmpireBelts(ctx, outcome, reason) {
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.empireBelts.${outcome}`, 1);
  if (outcome === "noScore" && !ctx.state.empireBeltsNoScoreLogged) {
    ctx.state.empireBeltsNoScoreLogged = true;
    ctx.logger.log("empireBeltNavy: no occupation score (occupation off?) - vendor belt rats used; only counted now");
  } else if (outcome === "failed" && !ctx.state.empireBeltsFailureLogged) {
    ctx.state.empireBeltsFailureLogged = true;
    ctx.logger.log(`empireBeltNavy: failed (${reason}) - vendor belt rats used; further failures only counted`);
  } else if (outcome === "fallback" && !ctx.state.empireBeltsFallbackLogged) {
    ctx.state.empireBeltsFallbackLogged = true;
    ctx.logger.log(`empireBeltNavy: fallback (${reason}) - vendor belt rats used; further fallbacks only counted`);
  }
}

function reportEmpireBelts(ctx) {
  if (beltPatrolEnabled(ctx) && ctx.state.factionProfiles !== "wrapped"
    && ctx.state.factionProfiles !== "already_installed") {
    ctx.logger.log("beltPatrol: faction profiles not injected - belts stay pirate");
  }
  if (!empireBeltsEnabled(ctx) || ctx.state.empireBelts === "wrapped") return;
  ctx.logger.log(`empireBeltNavy: not wrapped at boot (${ctx.state.empireBelts || "hook_not_fired"}) `
    + "- belt rats stay pirate");
}

function siteNavyEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return empireBeltsEnabled(ctx) && Boolean(c.world.siteNavy) && c.world.siteNavy.enabled === true;
}

function noteSiteNavy(ctx, outcome, reason) {
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.siteNavy.${outcome}`, 1);
  if (outcome === "failed" && !ctx.state.siteNavyFailureLogged) {
    ctx.state.siteNavyFailureLogged = true;
    ctx.logger.log(`siteNavy: failed (${reason}) - vendor anomaly pirates used; further failures only counted`);
  } else if (outcome === "fallback" && !ctx.state.siteNavyFallbackLogged) {
    ctx.state.siteNavyFallbackLogged = true;
    ctx.logger.log(`siteNavy: fallback (${reason}) - vendor anomaly pirates used; further fallbacks only counted`);
  }
}

function installSiteNavy(ctx) {
  if (!siteNavyEnabled(ctx)) {
    ctx.state.siteNavy = "disabled";
    return;
  }
  const adapter = ctx.adapter;
  const tools = adapter && typeof adapter.getSiteNavyTools === "function" ? adapter.getSiteNavyTools()
    : { ok: false, reason: "ADAPTER_UNAVAILABLE" };
  const spawnTools = tools.ok ? adapter.getNpcSpawnTools() : tools;
  if (!tools.ok || !spawnTools.ok || typeof spawnTools.resolveNpcBounty !== "function") {
    ctx.state.siteNavy = "refused";
    ctx.logger.log(`siteNavy: not wrapped - ${tools.ok ? (spawnTools.reason || "NO_BOUNTY_READER") : tools.reason} `
      + "- anomalies stay pirate");
    return;
  }
  const { wrapSiteSpawnForNavy } = require("./lib/adapter/siteNavy");
  const { selectNavyProfiles } = require("./lib/adapter/empireBelts");
  const c = getConfig(ctx).config;
  const beltNavy = c.world.beltNavy || {};
  const navyProfiles = selectNavyProfiles(c.world.empireNavyFactions);
  const navyTypeIds = new Set();
  for (const byHull of Object.values(navyProfiles)) {
    for (const profileId of Object.values(byHull)) {
      const definition = spawnTools.buildNpcDefinition(profileId);
      const typeId = Math.trunc(Number(definition && definition.profile && definition.profile.shipTypeID));
      if (Number.isSafeInteger(typeId) && typeId > 0) navyTypeIds.add(typeId);
    }
  }
  const installed = tools.install((original) => wrapSiteSpawnForNavy(original, {
    enabled: () => siteNavyEnabled(ctx),
    readSummary: tools.readSummary,
    readInstanceRef: tools.readInstanceRef,
    readTemplate: tools.readTemplate,
    navyProfiles,
    navyTypeIds,
    readController: readControllerVia(ctx),
    resolveSecurityProfile: tools.resolveSecurityProfile,
    buildNpcDefinition: spawnTools.buildNpcDefinition,
    resolveNpcBounty: spawnTools.resolveNpcBounty,
    bountyMultiplier: beltNavy.bountyMultiplier,
    rewardsEnabled: beltNavy.rewardsEnabled === true,
    decideSite: (input) => (ctx.beltNavyRoll && typeof ctx.beltNavyRoll.decideSite === "function"
      ? ctx.beltNavyRoll.decideSite(input) : { ok: false, reason: "UNAVAILABLE" }),
    getAggroSink: () => ctx.beltNavy || null,
    standingAggroEnabled: beltNavy.standingAggroEnabled === true,
    maxTrackedSites: c.world.siteNavy.maxTrackedSites,
    nowMs: () => (ctx.clock ? ctx.clock.now() : 0),
    onOutcome: (outcome, reason) => noteSiteNavy(ctx, outcome, reason),
  }));
  if (!installed.ok) {
    ctx.state.siteNavy = "refused";
    ctx.logger.log(`siteNavy: not wrapped - ${installed.reason} - anomalies stay pirate`);
    return;
  }
  ctx.state.siteNavy = installed.noop ? "already_installed" : "wrapped";
  ctx.logger.log(`siteNavy: ${ctx.state.siteNavy} - empire navy in combat anomalies of empire nullsec`);
}

function miningEncountersEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(c.miningEncounters) && c.miningEncounters.enabled === true;
}

function installMiningEncounters(ctx) {
  if (!miningEncountersEnabled(ctx)) {
    ctx.state.miningEncounters = "disabled";
    return;
  }
  const adapter = ctx.adapter;
  const tools = adapter && typeof adapter.getMiningEncounterTools === "function" ? adapter.getMiningEncounterTools()
    : { ok: false, reason: "ADAPTER_UNAVAILABLE" };
  if (!tools.ok) {
    ctx.state.miningEncounters = "refused";
    const missing = Array.isArray(tools.missing) && tools.missing.length > 0 ? ` (${tools.missing.join(", ")})` : "";
    ctx.logger.log(`miningEncounters: not wrapped - ${tools.reason}${missing} - mining without waves`);
    return;
  }
  const { wrapLedgerForEncounters } = require("./lib/adapter/miningEncounters");
  const installed = tools.install((original) => wrapLedgerForEncounters(original, {
    getSink: () => ctx.miningEncounters || null,
    onError: () => {
      const hooks = ctx.telemetry && ctx.telemetry.hooks;
      if (hooks && typeof hooks.onCount === "function") hooks.onCount("world.miningEncounters.hookError", 1);
    },
  }));
  if (!installed.ok) {
    ctx.state.miningEncounters = "refused";
    ctx.logger.log(`miningEncounters: not wrapped - ${installed.reason} - mining without waves`);
    return;
  }
  ctx.state.miningEncounters = "installed";
  ctx.logger.log(`miningEncounters: ${installed.noop ? "already installed" : "installed"} - mining ledger wrapped`);
}

function playerSovDeployGateEnabled(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  const p = c && c.playerSov;
  return Boolean(c) && c.enabled === true
    && Boolean(c.modules && c.modules.world) && c.modules.world.enabled === true
    && Boolean(p) && p.enabled === true && Boolean(p.deployGate) && p.deployGate.enabled === true;
}

function notePlayerSovGate(ctx, name) {
  const hooks = ctx.telemetry && ctx.telemetry.hooks;
  if (hooks && typeof hooks.onCount === "function") hooks.onCount(`world.playerSov.${name}`, 1);
}

function installPlayerSovDeployGate(ctx, exportsObject) {
  if (!playerSovDeployGateEnabled(ctx)) {
    ctx.state.playerSovDeployGate = "disabled";
    ctx.logger.debug("playerSovDeployGate: not wrapped - disabled by config");
    return;
  }
  const gate = require("./lib/adapter/sovDeployGate");
  const installed = gate.installDeployGate(exportsObject, (original) => gate.wrapDeployForGate(original, {
    ...gate.lazyToolDeps(() => {
      const adapter = ctx.adapter;
      const r = adapter && typeof adapter.getPlayerSovDeployGateTools === "function"
        ? adapter.getPlayerSovDeployGateTools() : null;
      return r && r.ok === true ? r.tools : null;
    }),
    getSink: () => ctx.playerSov || null,
    hubTypeId: gate.HUB_TYPE_ID,
    nowMs: () => (ctx.clock ? ctx.clock.now() : 0),
    onError: () => notePlayerSovGate(ctx, "gateError"),
    onOutcome: (name) => notePlayerSovGate(ctx, name),
  }));
  if (!installed.ok) {
    ctx.state.playerSovDeployGate = "refused";
    ctx.logger.log(`playerSovDeployGate: not wrapped - ${installed.reason} - hub deploys without the LNE gate`);
    return;
  }
  ctx.state.playerSovDeployGate = "wrapped";
  ctx.logger.log(`playerSovDeployGate: ${installed.alreadyInstalled ? "already wrapped" : "wrapped"} - `
    + "Sovereignty Hub deploys checked against live faction sov structures");
}

function capsuleSweepFlag(ctx, name) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.capsuleSweep) && c.capsuleSweep[name] === true;
}

function capsuleSweepLogIntervalMs(ctx) {
  const cfg = getConfig(ctx);
  const v = cfg.ok && cfg.config.capsuleSweep ? cfg.config.capsuleSweep.logIntervalMs : null;
  return Number.isSafeInteger(v) && v > 0 ? v : 60000;
}

function installCapsuleSweepHook(ctx, exportsObject) {
  if (!capsuleSweepFlag(ctx, "enabled")) {
    ctx.state.capsuleSweep = "disabled";
    ctx.logger.debug("capsuleSweep: not wrapped - disabled by config");
    return;
  }
  const sweep = require("./lib/adapter/capsuleSweep");
  const logLine = sweep.createLogLimiter((text) => ctx.logger.log(text), () => capsuleSweepLogIntervalMs(ctx),
    () => Date.now());
  const installed = sweep.installCapsuleSweep(exportsObject, (original) => sweep.wrapBoardForCapsuleSweep(original, {
    getTools: () => {
      const adapter = ctx.adapter;
      const r = adapter && typeof adapter.getCapsuleSweepTools === "function" ? adapter.getCapsuleSweepTools() : null;
      return r && r.ok === true ? r.tools : null;
    },
    isEnabled: () => capsuleSweepFlag(ctx, "enabled"),
    resendEnabled: () => capsuleSweepFlag(ctx, "resendRemoval"),
    count: (name) => {
      const hooks = ctx.telemetry && ctx.telemetry.hooks;
      if (hooks && typeof hooks.onCount === "function") hooks.onCount(`capsuleSweep.${name}`, 1);
    },
    logLine,
  }));
  if (!installed.ok) {
    ctx.state.capsuleSweep = "refused";
    ctx.logger.log(`capsuleSweep: not wrapped - ${installed.reason} - boards without the capsule ghost fix`);
    return;
  }
  ctx.state.capsuleSweep = "wrapped";
  ctx.logger.log(`capsuleSweep: ${installed.alreadyInstalled ? "already wrapped" : "wrapped"} - board out of a `
    + `capsule resends RemoveBalls to a forgotten observer (resend=${capsuleSweepFlag(ctx, "resendRemoval")})`);
}

function bookmarkSiteWarpFlag(ctx) {
  const cfg = getConfig(ctx);
  const c = cfg.ok ? cfg.config : null;
  return Boolean(c) && c.enabled === true && Boolean(c.bookmarkSiteWarp) && c.bookmarkSiteWarp.enabled === true;
}

function bookmarkSiteWarpRangeMeters(ctx) {
  const cfg = getConfig(ctx);
  const v = cfg.ok && cfg.config.bookmarkSiteWarp ? cfg.config.bookmarkSiteWarp.rangeMeters : null;
  return Number.isSafeInteger(v) && v > 0 ? v : 300000;
}

function bookmarkSiteWarpLogIntervalMs(ctx) {
  const cfg = getConfig(ctx);
  const v = cfg.ok && cfg.config.bookmarkSiteWarp ? cfg.config.bookmarkSiteWarp.logIntervalMs : null;
  return Number.isSafeInteger(v) && v > 0 ? v : 60000;
}

function installBookmarkSiteWarpHook(ctx, serviceClass) {
  if (!bookmarkSiteWarpFlag(ctx)) {
    ctx.state.bookmarkSiteWarp = "disabled";
    ctx.logger.log("bookmarkSiteWarp: disabled - bookmark warps without the universe site materialization");
    return;
  }
  const bsw = require("./lib/adapter/bookmarkSiteWarp");
  const { createLogLimiter } = require("./lib/adapter/capsuleSweep");
  const logLine = createLogLimiter((text) => ctx.logger.log(text), () => bookmarkSiteWarpLogIntervalMs(ctx),
    () => Date.now());
  const installed = bsw.installBookmarkSiteWarp(serviceClass, (original) => bsw.wrapWarpForBookmarkSites(original, {
    isEnabled: () => bookmarkSiteWarpFlag(ctx),
    rangeMetersOf: () => bookmarkSiteWarpRangeMeters(ctx),
    toolsOf: () => {
      const adapter = ctx.adapter;
      const r = adapter && typeof adapter.getBookmarkSiteWarpTools === "function"
        ? adapter.getBookmarkSiteWarpTools() : null;
      return r || { ok: false, reason: "BOOKMARK_SITE_WARP_UNAVAILABLE" };
    },
    count: (name) => {
      const hooks = ctx.telemetry && ctx.telemetry.hooks;
      if (hooks && typeof hooks.onCount === "function") hooks.onCount(`bookmarkSiteWarp.${name}`, 1);
    },
    logLine,
  }));
  if (!installed.ok) {
    ctx.state.bookmarkSiteWarp = "refused";
    ctx.logger.log(`bookmarkSiteWarp: refused - ${installed.reason} - bookmark warps without the site materialization`);
    return;
  }
  ctx.state.bookmarkSiteWarp = "wrapped";
  ctx.logger.log(`bookmarkSiteWarp: ${installed.alreadyInstalled ? "already wrapped" : "wrapped"} - a warp to a `
    + `coordinate bookmark materializes the universe site within ${bookmarkSiteWarpRangeMeters(ctx)} m`);
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
      ctx.logger.log(`boot: services not started - ${reason}`);
      if (err !== undefined) ctx.logger.debug(`boot failure detail: ${(err && err.stack) || err}`);
    },
    onHandlerError: (message, err) => ctx.logger.logError(`${message} - mod not running`, err),
  });
  if (!result.ok) ctx.logger.log(`bootWorld not wrapped - ${result.reason}; services will not start`);
}

function buildHooks(ctx) {
  let npcService = null;
  const beltRatTargeting = require("./lib/adapter/beltRatTargets").createBeltRatTargeting(
    () => npcService, Math.random, () => getConfig(ctx).config.population?.simulation || {});
  return [
    {
      name: "beltRatTargetControllers",
      match(request, exports) {
        return request.includes("npcService") && exportHas(exports, "getControllerByEntityID", "function")
          && exportHas(exports, "setBehaviorOverrides", "function");
      },
      run(exports) {
        npcService = exports;
      },
    },
    {
      name: "beltRatTargetSpawn",
      match(request, exports) {
        return request.includes("nativeNpcService") && exportHas(exports, "spawnNativeDefinitionsInContext", "function");
      },
      run(exports) {
        exports.spawnNativeDefinitionsInContext = beltRatTargeting.wrapSpawn(exports.spawnNativeDefinitionsInContext);
      },
    },
    {
      name: "beltRatTargetCleanup",
      match(request, exports) {
        return request.includes("beltRatRuntime") && exportHas(exports, "tickScene", "function");
      },
      run(exports) {
        const tick = exports.tickScene;
        exports.tickScene = function tickWithBeltTargets(scene, ...args) {
          beltRatTargeting.prune(scene);
          return tick.call(this, scene, ...args);
        };
      },
    },
    {
      name: "stallDiagTimers",
      match() {
        return true;
      },
      run() {
        installStallTimers(ctx);
      },
    },
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
    {
      name: "pirateFactionProjection",
      match(request, exports) {
        return request.includes("pirateFactionPolicy")
          && exportHas(exports, "resolvePirateFactionKeyForSystem", "function")
          && exportHas(exports, "PIRATE_FACTION_BY_FACTION_ID", "object");
      },
      run(exports) {
        ctx.state.pirateFactionPolicy = exports;
        if (!projectionEnabled(ctx)) {
          ctx.state.projection = "disabled";
          ctx.logger.debug("pirateFactionProjection: not wrapped - disabled by config");
          return;
        }
        const { wrapPirateFactionKey } = require("./lib/adapter/projection");
        const wrap = wrapPirateFactionKey(exports.resolvePirateFactionKeyForSystem, {
          pirateKeyByFactionId: exports.PIRATE_FACTION_BY_FACTION_ID,
          readController: readControllerVia(ctx),
          onOutcome: (outcome, reason) => noteProjection(ctx, outcome, reason),
        });
        if (!wrap.ok) {
          ctx.state.projection = "refused";
          ctx.logger.log(`pirateFactionProjection wrap refused - ${wrap.reason}`);
          return;
        }
        exports.resolvePirateFactionKeyForSystem = wrap.wrapped;
        ctx.state.projection = "wrapped";
      },
    },
    {
      name: "siteFactionProjection",
      match(request, exports) {
        return request.includes("dungeonSiteSpawnPolicy")
          && exportHas(exports, "buildRuntimeSystemPolicyContext", "function");
      },
      run(exports) {
        if (!siteProjectionEnabled(ctx)) {
          ctx.state.siteProjection = "disabled";
          ctx.logger.debug("siteFactionProjection: not wrapped - disabled by config");
          return;
        }
        const policy = ctx.state.pirateFactionPolicy;
        if (!policy || typeof policy.resolvePirateFactionForSystem !== "function") {
          ctx.state.siteProjection = "refused";
          ctx.logger.log("siteFactionProjection wrap refused - PIRATE_POLICY_UNAVAILABLE");
          return;
        }
        const { wrapSitePolicyContext } = require("./lib/adapter/siteProjection");
        const wrap = wrapSitePolicyContext(exports.buildRuntimeSystemPolicyContext, {
          pirateKeyByFactionId: policy.PIRATE_FACTION_BY_FACTION_ID,
          readController: readControllerMemoVia(ctx),
          resolveVendorFaction: (id) => policy.resolvePirateFactionForSystem(id),
          onOutcome: (outcome, reason) => noteSiteProjection(ctx, outcome, reason),
        });
        if (!wrap.ok) {
          ctx.state.siteProjection = "refused";
          ctx.logger.log(`siteFactionProjection wrap refused - ${wrap.reason}`);
          return;
        }
        exports.buildRuntimeSystemPolicyContext = wrap.wrapped;
        ctx.state.siteProjection = "wrapped";
      },
    },
    {
      name: "sitePolicyHubUpgrades",
      match(request, exports) {
        return request.includes("sovModernState")
          && exportHas(exports, "getHubUpgrades", "function")
          && exportHas(exports, "getHubUpgradesPendingPersistence", "function");
      },
      run(exports) {
        if (!sitePolicyHubFastPathEnabled(ctx)) {
          ctx.state.sitePolicyHubs = "disabled";
          ctx.logger.debug("sitePolicyHubUpgrades: not wrapped - disabled by config");
          return;
        }
        const { wrapHubUpgrades, COUNTER_NAMES } = require("./lib/adapter/sitePolicyHubs");
        const wrap = wrapHubUpgrades(exports.getHubUpgrades,
          (hubID) => exports.getHubUpgradesPendingPersistence(hubID),
          sitePolicyHubScopeOf(ctx),
          (outcome) => noteSitePolicyHubs(ctx, outcome, COUNTER_NAMES));
        if (!wrap.ok) {
          ctx.state.sitePolicyHubs = "refused";
          ctx.logger.log(`sitePolicyHubUpgrades wrap refused - ${wrap.reason}`);
          return;
        }
        exports.getHubUpgrades = wrap.wrapped;
        ctx.state.sitePolicyHubs = "wrapped";
      },
    },
    {
      name: "sitePolicyHubScope",
      match(request, exports) {
        return request.includes("dungeonSiteSpawnPolicy")
          && exportHas(exports, "buildRuntimeSystemPolicyContext", "function");
      },
      run(exports) {
        if (!sitePolicyHubFastPathEnabled(ctx)) {
          ctx.state.sitePolicyHubScope = "disabled";
          ctx.logger.debug("sitePolicyHubScope: not wrapped - disabled by config");
          return;
        }
        const { wrapPolicyScope } = require("./lib/adapter/sitePolicyHubs");
        const wrap = wrapPolicyScope(exports.buildRuntimeSystemPolicyContext, sitePolicyHubScopeOf(ctx));
        if (!wrap.ok) {
          ctx.state.sitePolicyHubScope = "refused";
          ctx.logger.log(`sitePolicyHubScope wrap refused - ${wrap.reason}`);
          return;
        }
        exports.buildRuntimeSystemPolicyContext = wrap.wrapped;
        ctx.state.sitePolicyHubScope = "wrapped";
      },
    },
    {
      name: "sovCampaignSpread",
      match(request, exports) {
        return request.includes("sovCampaignState")
          && exportHas(exports, "bindDurableScheduler", "function")
          && exportHas(exports, "unbindDurableScheduler", "function");
      },
      run(exports) {
        const spreadMs = campaignSpreadMsOf(ctx);
        if (spreadMs <= 0) {
          ctx.state.sovCampaignSpread = "disabled";
          ctx.logger.debug("sovCampaignSpread: not wrapped - disabled by config");
          return;
        }
        const { wrapCampaignBinding, COUNTER_NAMES } = require("./lib/adapter/sovCampaignSpread");
        const retryKnobs = campaignSpreadRetryOf(ctx);
        const wrap = wrapCampaignBinding(exports, {
          spreadMs,
          retryMax: retryKnobs.max,
          provisional: retryKnobs.provisional,
          allianceOfSystem: allianceOfSystemVia(ctx),
          isVirtualAlliance: (allianceId) => {
            const vc = ctx.virtualCorps;
            return Boolean(vc) && typeof vc.isVirtualAlliance === "function" && vc.isVirtualAlliance(allianceId) === true;
          },
          onOutcome: (outcome) => noteCampaignSpread(ctx, outcome, COUNTER_NAMES),
        });
        if (!wrap.ok) {
          ctx.state.sovCampaignSpread = "refused";
          ctx.logger.log(`sovCampaignSpread wrap refused - ${wrap.reason}`);
          return;
        }
        ctx.state.sovCampaignSpread = "wrapped";
        ctx.state.sovCampaignSpreadRetry = wrap.retry || null;
      },
    },
    {
      name: "essRepositoryFast",
      match(request, exports) {
        return request.includes("essRepository") && exportHas(exports, "mutate", "function")
          && exportHas(exports, "read", "function") && exportHas(exports, "write", "function");
      },
      run(exports) {
        installEssRepositoryFast(ctx, exports);
      },
    },
    {
      name: "essSettlementJobs",
      match(request, exports) {
        return request.includes("essSettlementRuntime") && exportHas(exports, "handleJob", "function");
      },
      run(exports) {
        installEssSettlementJobs(ctx, exports);
      },
    },
    {
      name: "stallDiagScheduler",
      match(request, exports) {
        return request.includes("durableScheduler") && exportHas(exports, "createDurableScheduler", "function");
      },
      run(exports) {
        installStallSeam(ctx, "jobs", exports);
      },
    },
    {
      name: "stallDiagKillmail",
      match(request, exports) {
        return request.includes("killmailState") && exportHas(exports, "getAllKillmailRecords", "function");
      },
      run(exports) {
        try {
          installDbsKillmailGetAll(ctx, exports);
        } catch (err) {
          ctx.state.dbsKillmailGetAll = "error";
          ctx.logger.logError("dbsKillmailCache: install failed - vendor killmail copies", err);
        }
        installStallSeam(ctx, "killmailClone", exports);
        try {
          installStarmapKillsArm(ctx, exports);
        } catch (err) {
          ctx.state.starmapKills = "error";
          ctx.logger.logError("inGameMap: star map Kills arm failed - vendor kills only", err);
        }
      },
    },
    {
      name: "dbsKillmailScope",
      match(request, exports) {
        return request.includes("dynamicBountyRuntime") && exportHas(exports, "recoverLosses", "function")
          && exportHas(exports, "maintain", "function");
      },
      run(exports) {
        ctx.state.dbsExports = exports;
        installDbsKillmailScope(ctx, exports);
      },
    },
    {
      name: "playerSovDeployGate",
      match(request, exports) {
        return request.includes("sovPlayerDeployment")
          && exportHas(exports, "deployStructureFromInventoryItem", "function");
      },
      run(exports) {
        installPlayerSovDeployGate(ctx, exports);
      },
    },
    {
      name: "capsuleSweep",
      match(request, exports) {
        return request.includes("transitions") && exportHas(exports, "boardSpaceShip", "function")
          && exportHas(exports, "ejectSession", "function");
      },
      run(exports) {
        installCapsuleSweepHook(ctx, exports);
      },
    },
    {
      name: "bookmarkSiteWarp",
      match(request, exports) {
        return request.includes("beyonceService") && typeof exports === "function"
          && Boolean(exports.prototype) && typeof exports.prototype.Handle_CmdWarpToStuff === "function";
      },
      run(exports) {
        installBookmarkSiteWarpHook(ctx, exports);
      },
    },
    {
      name: "empireBeltNavy",
      match(request, exports) {
        return request.includes("beltRatRuntime")
          && exportHas(exports, "maybeSpawnForSessionArrival", "function")
          && exportHas(exports, "resolveSecurityProfile", "function");
      },
      run(exports) {
        if (!empireBeltsEnabled(ctx)) {
          ctx.state.empireBelts = "disabled";
          ctx.logger.debug("empireBeltNavy: not wrapped - disabled by config");
          return;
        }
        const { wrapBeltSpawnForNavy, selectNavyProfiles } = require("./lib/adapter/empireBelts");
        const c = getConfig(ctx).config;
        const beltNavy = c.world.beltNavy || {};
        const patrol = beltPatrolEnabled(ctx) ? require("./lib/adapter/factionProfiles").selectNavyTable(
          beltNavy.patrolFactions, require("./lib/adapter/data/factionLiveProfiles")) : {};
        const wrap = wrapBeltSpawnForNavy(exports.maybeSpawnForSessionArrival, {
          navyProfiles: Object.keys(patrol).length === 0 ? selectNavyProfiles(c.world.empireNavyFactions)
            : Object.freeze({ ...selectNavyProfiles(c.world.empireNavyFactions), ...patrol }),
          fullReplaceFactionIds: Object.keys(patrol).map(Number),
          rewardsEnabled: beltNavy.rewardsEnabled === true,
          bountyMultiplier: beltNavy.bountyMultiplier,
          shareEnabled: beltNavy.shareEnabled === true,
          decideSpawn: (input) => (ctx.beltNavyRoll ? ctx.beltNavyRoll.decide(input)
            : { ok: false, reason: "UNAVAILABLE" }),
          nowMs: () => (ctx.clock ? ctx.clock.now() : 0),
          standingAggroEnabled: beltNavy.standingAggroEnabled === true,
          getAggroSink: () => ctx.beltNavy || null,
          readController: readControllerVia(ctx),
          resolveSecurityProfile: (systemId) => exports.resolveSecurityProfile(systemId),
          getNpcSpawnTools: () => (ctx.adapter && typeof ctx.adapter.getNpcSpawnTools === "function"
            ? ctx.adapter.getNpcSpawnTools() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          onOutcome: (outcome, reason) => noteEmpireBelts(ctx, outcome, reason),
        });
        if (!wrap.ok) {
          ctx.state.empireBelts = "refused";
          ctx.logger.log(`empireBeltNavy wrap refused - ${wrap.reason}`);
          return;
        }
        exports.maybeSpawnForSessionArrival = wrap.wrapped;
        ctx.state.empireBelts = "wrapped";
      },
    },
    {
      name: "npcKillLiberation",
      match(request, exports) {
        return request.includes("factionKillStandingRuntime")
          && exportHas(exports, "recordNpcFactionStandingLoss", "function");
      },
      run(exports, request, parent) {
        const cfg = getConfig(ctx);
        const c = cfg.ok ? cfg.config : null;
        const liberationOn = Boolean(c)
          && !(c.modules && c.modules.world && c.modules.world.enabled === false)
          && Boolean(c.occupation) && c.occupation.enabled === true
          && Boolean(c.liberation) && c.liberation.enabled === true;
        if (!liberationOn && !standingsEnabled(c) && !playerActivityEnabled(c) && !frontJobsEnabled(c)
          && !shipAiKillsEnabled(c) && !bountyLiveEnabled(c) && !situationKillsEnabled(c) && !seasonKillsEnabled(c)) {
          return;
        }
        const { wrapNpcKillStandingLoss, setNavyKillsLiberate, setKillWrapMounted } =
          require("./lib/adapter/killObservation");
        setNavyKillsLiberate(Boolean(c.world && c.world.beltNavy) && c.world.beltNavy.liberationKills === true);
        const wrap = wrapNpcKillStandingLoss(exports.recordNpcFactionStandingLoss, {
          resolveVictimFactionID: (victimEntity) => exports.resolveVictimFactionID(victimEntity),
        });
        if (wrap.ok) {
          exports.recordNpcFactionStandingLoss = wrap.wrapped;
          setKillWrapMounted(true);
        } else {
          ctx.logger.log(`npcKillLiberation wrap refused - ${wrap.reason}`);
        }
      },
    },
    {
      name: "frontJobsScan",
      match(request, exports) {
        return request.includes("probeScanRuntime") && exportHas(exports, "buildSignatureScanResults", "function");
      },
      run(exports) {
        const cfg = getConfig(ctx);
        const c = cfg.ok ? cfg.config : null;
        if (!frontJobsEnabled(c) || c.frontJobs.scanEnabled !== true) {
          ctx.state.frontJobsScan = "disabled";
          return;
        }
        const { wrapSignatureScanResults, setScanWrapMounted } = require("./lib/adapter/scanObservation");
        const wrap = wrapSignatureScanResults(exports.buildSignatureScanResults);
        if (!wrap.ok) {
          ctx.state.frontJobsScan = "refused";
          ctx.logger.log(`frontJobsScan wrap refused - ${wrap.reason}`);
          return;
        }
        exports.buildSignatureScanResults = wrap.wrapped;
        ctx.state.frontJobsScan = "wrapped";
        setScanWrapMounted(true);
      },
    },
    {
      name: "liveLossImport",
      match(request, exports) {
        return request.includes("killmailTracker")
          && exportHas(exports, "enqueueKillmailFromDestruction", "function");
      },
      run(exports) {
        if (!liveLossImportEnabled(ctx) && !shipAiLossEnabled(ctx) && !capsuleFxEnabled(ctx)) {
          ctx.state.liveLossImport = "disabled";
          ctx.logger.debug("liveLossImport: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/liveLossHook").install(exports);
        if (!r.ok) {
          ctx.state.liveLossImport = "refused";
          ctx.logger.log(`liveLossImport wrap refused - ${r.reason}`);
          return;
        }
        ctx.state.liveLossImport = r.alreadyInstalled ? "already_installed" : "wrapped";
      },
    },
    {
      name: "dormancyGuard",
      match(request, exports) {
        return request.includes("npcCombatDormancy")
          && exportHas(exports, "canDematerializeDormantCombatController", "function");
      },
      run(exports) {
        if (!materializationEnabled(ctx)) {
          ctx.state.dormancyGuard = "disabled";
          ctx.logger.debug("dormancyGuard: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/dormancyGuard").install(exports);
        if (!r.ok) {
          ctx.state.dormancyGuard = "refused";
          ctx.logger.log(`dormancyGuard wrap refused - ${r.reason}`);
          return;
        }
        ctx.state.dormancyGuard = r.alreadyInstalled ? "already_installed" : "wrapped";
        ctx.logger.log(`dormancyGuard: ${ctx.state.dormancyGuard} - live battle ships kept awake near players`);
      },
    },
    {
      name: "capitalNpcAuthority",
      match(request, exports) {
        return request.includes("capitalNpcAuthority") && exportHas(exports, "CAPITAL_NPC_AUTHORITY", "object");
      },
      run(exports) {
        ctx.state.capitalNpcAuthority = exports;
      },
    },
    {
      name: "capitalLiveProfiles",
      match(request, exports) {
        return request.includes("capitalNpcCatalog") && exportHas(exports, "getCapitalNpcGeneratedRows", "function");
      },
      run(exports) {
        if (!capitalLiveEnabled(ctx)) {
          ctx.state.capitalLive = "disabled";
          ctx.logger.debug("capitalLive: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/capitalProfiles").install(exports, {
          build: () => buildCapitalLiveRows(ctx),
          onOutcome: (outcome, detail) => noteCapitalLive(ctx, outcome, detail),
        });
        if (!r.ok) {
          ctx.state.capitalLive = "refused";
          ctx.logger.log(`capitalLive wrap refused - ${r.reason}`);
          return;
        }
        ctx.state.capitalLive = r.alreadyInstalled ? "already_installed" : "wrapped";
      },
    },
    {
      name: "factionLiveProfiles",
      match(request, exports) {
        return request.includes("capitalNpcCatalog") && exportHas(exports, "getCapitalNpcGeneratedRows", "function");
      },
      run(exports) {
        const factions = factionProfilesEnabled(ctx);
        const freighters = bountyFreightersEnabled(ctx);
        const civilians = civilianHullsEnabled(ctx);
        if (!factions && !freighters && !civilians) {
          ctx.state.factionProfiles = "disabled";
          ctx.logger.debug("factionLiveProfiles: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/factionProfiles").install(exports, {
          build: () => require("./lib/adapter/factionProfiles").buildFactionProfileRows({
            data: require("./lib/adapter/data/factionLiveProfiles"), includeFactions: factions,
            bountyFreighters: freighters,
            ...(civilians ? { civilianRows: true, civilianData: require("./lib/adapter/data/civilianLiveProfiles")
              .civilianDataOf({ pilotHulls: pilotHullsEnabled(ctx) }) } : {}) }),
          onOutcome: (outcome, detail) => noteFactionProfiles(ctx, outcome, detail),
        });
        if (!r.ok) {
          ctx.state.factionProfiles = "refused";
          ctx.logger.log(`factionLiveProfiles wrap refused - ${r.reason}`);
          return;
        }
        const partial = freighters && civilians ? "bounty_civilian" : freighters ? "bounty_only" : "civilian_only";
        ctx.state.factionProfiles = !factions ? partial : r.alreadyInstalled ? "already_installed" : "wrapped";
      },
    },
    {
      name: "capitalFighterStrike",
      match(request, exports) {
        return request.includes("npcSupercarrierDirector")
          && exportHas(exports, "syncNpcSupercarrierSystems", "function");
      },
      run(exports) {
        if (!capitalFighterDamageEnabled(ctx)) {
          ctx.state.capitalFighterStrike = "disabled";
          ctx.logger.debug("capitalFighterStrike: not wrapped - disabled by config");
          return;
        }
        const m = getConfig(ctx).config.materialization;
        const r = require("./lib/adapter/npcFighterStrike").install(exports, {
          enabled: true,
          params: { dpsPermille: m.capitalFighterDpsPermille, scaleMaxPermille: m.capitalFighterScaleMaxPermille },
          deps: capitalFighterDeps(ctx),
          onGate: (gate) => noteCapitalFighterGate(ctx, gate),
          onCounts: (delta) => noteCapitalFighterCounts(ctx, delta),
          onError: (err) => noteCapitalFighterError(ctx, err),
        });
        if (!r.ok) {
          ctx.state.capitalFighterStrike = "refused";
          ctx.logger.log(`capitalFighterStrike wrap refused - ${r.reason}`);
          return;
        }
        ctx.state.capitalFighterStrike = r.alreadyInstalled ? "already_installed" : "wrapped";
      },
    },
    {
      name: "capitalFaxRepair",
      match(request, exports) {
        return request.includes("capitalNpcMovement") && exportHas(exports, "syncCapitalNpcMovement", "function");
      },
      run(exports) {
        if (!capitalFaxRepairEnabled(ctx)) {
          ctx.state.capitalFaxRepair = "disabled";
          ctx.logger.debug("capitalFaxRepair: not wrapped - disabled by config");
          return;
        }
        const m = getConfig(ctx).config.materialization;
        const r = require("./lib/adapter/npcFaxRepair").install(exports, {
          enabled: true,
          params: { permille: m.capitalFaxRepairPermille, cycleMs: m.capitalFaxRepairCycleMs,
            rangeMeters: m.capitalFaxRepairRangeMeters },
          deps: capitalFaxDeps(ctx),
          onCounts: (delta) => noteCapitalFaxCounts(ctx, delta),
          onError: (err) => noteCapitalFaxError(ctx, err),
        });
        if (!r.ok) {
          ctx.state.capitalFaxRepair = "refused";
          ctx.logger.log(`capitalFaxRepair wrap refused - ${r.reason}`);
          return;
        }
        ctx.state.capitalFaxRepair = r.alreadyInstalled ? "already_installed" : "wrapped";
      },
    },
    {
      name: "localPilots",
      match(request, exports) {
        return request.includes("chatRuntime") && exportHas(exports, "on", "function")
          && exportHas(exports, "publishLocalMembershipListForSession", "function");
      },
      run(exports) {
        if (!localPilotsEnabled(ctx)) {
          ctx.state.localPilots = "disabled";
          ctx.logger.debug("localPilots: no listener - disabled by config");
          return;
        }
        const r = require("./lib/adapter/localPilots").install(exports);
        ctx.state.localPilots = !r.ok ? "refused" : (r.alreadyInstalled ? "already_installed" : "installed");
        if (!r.ok) ctx.logger.log(`localPilots listener refused - ${r.reason}`);
      },
    },
    {
      name: "localPilotsXmpp",
      match(request, exports) {
        return request.includes("xmppStubServer") && exportHas(exports, "handleSocketForEdge", "function");
      },
      run(exports) {
        const cfg = getConfig(ctx);
        const c = cfg.ok ? cfg.config : null;
        if (!localPilotsEnabled(ctx) || !c.localPilots || c.localPilots.xmppEnabled !== true) {
          ctx.state.localPilotsXmpp = "disabled";
          ctx.logger.debug("localPilotsXmpp: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/localPilotsXmpp").install(exports, {
          maxBatchBytes: c.localPilots.xmppMaxBatchBytes, logDebug: (line) => ctx.logger.debug(line) });
        ctx.state.localPilotsXmpp = !r.ok ? "refused" : (r.alreadyInstalled ? "already_installed" : "installed");
        if (!r.ok) ctx.logger.log(`localPilotsXmpp wrap refused - ${r.reason}`);
      },
    },
    {
      name: "shipAiXmpp",
      match(request, exports) {
        return request.includes("xmppStubServer") && exportHas(exports, "handleSocketForEdge", "function");
      },
      run(exports) {
        const cfg = getConfig(ctx);
        const c = cfg.ok ? cfg.config : null;
        const s = c && c.shipAi;
        if (!c || c.enabled !== true || !s || s.enabled !== true || s.channel !== "private"
          || (c.modules && c.modules.world && c.modules.world.enabled === false)) {
          ctx.state.shipAiXmpp = "disabled";
          ctx.logger.debug("shipAiXmpp: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/shipAiXmpp").install(exports, { maxBatchBytes: s.xmppMaxBatchBytes });
        ctx.state.shipAiXmpp = !r.ok ? "refused" : (r.alreadyInstalled ? "already_installed" : "installed");
        if (!r.ok) ctx.logger.log(`shipAiXmpp wrap refused - ${r.reason}`);
      },
    },
    {
      name: "shipAiMail",
      match(request, exports) {
        return request.includes("mailNotifications") && exportHas(exports, "sendMailSentNotification", "function");
      },
      run(exports) {
        const cfg = getConfig(ctx);
        const c = cfg.ok ? cfg.config : null;
        const s = c && c.shipAi;
        if (!c || c.enabled !== true || !s || s.enabled !== true || s.mailEnabled !== true
          || (c.modules && c.modules.world && c.modules.world.enabled === false)) {
          ctx.state.shipAiMail = "disabled";
          ctx.logger.debug("shipAiMail: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/shipAiMailHook").install(exports);
        ctx.state.shipAiMail = !r.ok ? "refused" : (r.alreadyInstalled ? "already_installed" : "installed");
        if (!r.ok) ctx.logger.log(`shipAiMail wrap refused - ${r.reason}`);
      },
    },
    {
      name: "fameMarket",
      match(request, exports) {
        return request.includes("marketRules") && exportHas(exports, "getMarketContext", "function")
          && exportHas(exports, "computeSalesTaxAmount", "function");
      },
      run(exports) {
        const cfg = getConfig(ctx);
        const c = cfg.ok ? cfg.config : null;
        const f = c && c.fame;
        if (!c || c.enabled !== true || !f || f.enabled !== true
          || (f.marketTaxEnabled !== true && f.marketBrokerEnabled !== true)
          || (c.modules && c.modules.world && c.modules.world.enabled === false)) {
          ctx.state.fameMarket = "disabled";
          ctx.logger.debug("fameMarket: not wrapped - disabled by config");
          return;
        }
        const r = require("./lib/adapter/fameMarketHook").install(exports);
        ctx.state.fameMarket = !r.ok ? "refused" : (r.alreadyInstalled ? "already_installed" : "installed");
        if (!r.ok) ctx.logger.log(`fameMarket wrap refused - ${r.reason}`);
      },
    },
    {
      name: "sentryModuleRuntime",
      match(request, exports) {
        return request.includes("starbaseModuleRuntime") && exportHas(exports, "startAnchorTransition", "function")
          && exportHas(exports, "reconcileStarbaseModule", "function") && exportHas(exports, "setOnlineState", "function");
      },
      run(exports, request, parent) {
        runSentryHook(ctx, "moduleRuntime", require("./lib/adapter/sentrySeams").installModuleRuntime, exports, request,
          parent);
      },
    },
    {
      name: "sentryDefenseRuntime",
      match(request, exports) {
        return request.includes("starbaseDefenseRuntime") && exportHas(exports, "validateBatteryOperation", "function");
      },
      run(exports, request, parent) {
        runSentryHook(ctx, "defenseRuntime", require("./lib/adapter/sentrySeams").installDefenseRuntime, exports,
          request, parent);
        runSentryHook(ctx, "defensePresentation", require("./lib/adapter/sentrySeams").installDefensePresentation,
          exports, request, parent);
      },
    },
    {
      name: "sentryInventoryRuntime",
      match(request, exports) {
        return request.includes("starbaseInventoryRuntime")
          && exportHas(exports, "validateBatteryAmmoInventoryAccess", "function");
      },
      run(exports, request, parent) {
        runSentryHook(ctx, "inventoryRuntime", require("./lib/adapter/sentrySeams").installInventoryRuntime, exports,
          request, parent);
      },
    },
    {
      name: "sentryDogmaErrors",
      match(request, exports) {
        return request.includes("dogmaService") && typeof exports === "function" && exports.prototype !== null
          && typeof exports.prototype === "object"
          && Object.prototype.hasOwnProperty.call(exports.prototype, "_formatStarbaseModuleUserError");
      },
      run(exports, request, parent) {
        runSentryHook(ctx, "dogmaErrors", require("./lib/adapter/sentrySeams").installDogmaErrors, exports, request,
          parent);
      },
    },
    {
      name: "sentryPosMgrErrors",
      match(request, exports) {
        return /planet[\\/]posMgrService/.test(request) && typeof exports === "function" && exports.prototype !== null
          && typeof exports.prototype === "object"
          && Object.prototype.hasOwnProperty.call(exports.prototype, "Handle_AnchorStructure");
      },
      run(exports, request, parent) {
        runSentryHook(ctx, "posMgrErrors", require("./lib/adapter/sentrySeams").installPosMgrErrors, exports, request,
          parent);
      },
    },
  ];
}

function installModuleHook(moduleApi, hooks, logger = defaultLogger) {
  const originalLoad = moduleApi._load;
  const pending = hooks.map((hook) => ({ hook, done: false }));

  moduleApi._load = function livingNewEdenHookedLoad(request, parent) {
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
  if (!isMainThread) {
    logger.debug("preload skipped: not_main_thread");
    return { ok: false, reason: "not_main_thread" };
  }
  if (globalObj[INSTALL_FLAG]) {
    logger.log("already installed - ignoring second preload");
    return { ok: false, reason: "already_installed" };
  }
  globalObj[INSTALL_FLAG] = true;

  const ctx = {
    modDir: MOD_DIR,
    moduleApi,
    logger,
    env,
    isMainThread,
    globalObj,
    stallTimers: null,
    startServices: deps.startServices || defaultStartServices,
    loadConfig: deps.loadConfig || (() => require("./config").loadConfig({ env })),
    config: null,
    adapterDeps: Object.fromEntries(["gameModules", "requireFn", "existsSync", "config"]
      .filter((key) => deps[key] !== undefined).map((key) => [key, deps[key]])),
    adapterInstance: null,
    adapter: null,
    telemetry: null,
    persistence: null,
    beltNavyRoll: null,
    beltNavy: null,
    governor: null,
    services: null,
    clock: null,
    ids: null,
    streams: null,
    disabledModules: null,
    views: null,
    observer: null,
    modVersion: MOD_VERSION,
    state: {
      readinessSeen: false, readinessGate: null, bootGate: null, servicesStarted: false,
      configResult: null, configReported: false, bootRefusal: null,
      serverSrc: null, bootstrapFile: null,
      projection: null, projectionFailureLogged: false,
      pirateFactionPolicy: null, siteProjection: null, siteProjectionFailureLogged: false,
      sovCampaignSpread: null, sovCampaignSpreadFailureLogged: false,
      sovCampaignSpreadRetry: null,
      sitePolicyHubs: null, sitePolicyHubScope: null, sitePolicyHubScopeObject: null,
      empireBelts: null, empireBeltsFailureLogged: false, empireBeltsFallbackLogged: false,
      liveLossImport: null,
      dormancyGuard: null,
      capitalNpcAuthority: null, capitalLive: null, capitalLiveFailedReported: 0,
      capitalFighterStrike: null, capitalFighterGate: null, capitalFighterErrorLogged: false,
      capitalFaxRepair: null, capitalFaxErrorLogged: false,
      localPilots: null,
      localPilotsXmpp: null,
      shipAiXmpp: null,
      siteNavy: null, siteNavyFailureLogged: false, siteNavyFallbackLogged: false,
      miningEncounters: null,
      playerSovDeployGate: null,
      capsuleSweep: null,
      bookmarkSiteWarp: null,
      starmapKills: null,
      essRepositoryFast: null, essRepositoryFastCore: null, essSettlementJobs: null,
      stallDiagTimers: null, stallDiagScheduler: null, stallDiagKillmail: null,
      dbsKillmailCacheCore: null, dbsKillmailGetAll: null, dbsKillmailScope: null, dbsKillmailCacheSrcDir: null,
      dbsKillmailCacheProbe: null,
      dbsExports: null, essCollapse: null, essCollapseInstall: null,
    },
  };
  const pending = installModuleHook(moduleApi, buildHooks(ctx), logger);
  logger.debug(`armed v${MOD_VERSION} - ${pending.length} hook(s), loaded from ${MOD_DIR}`);
  return { ok: true, reason: null };
}

module.exports = { MOD_VERSION, INSTALL_FLAG, NO_INSTALL_ENV, exportHas, buildHooks, installModuleHook, install,
  essGameExportsOf };

if (process.env[NO_INSTALL_ENV] !== "1") {
  try {
    install();
  } catch (err) {
    defaultLogger.logError("loader failed to install - mod not running", err);
  }
}
