"use strict";

const { createPoller } = require("../presence/poller");
const { createKillboardRepository } = require("./repository");
const { createBattleProjector } = require("./battleProjector");
const { buildKbBattlesView, VIEW_ID, buildKbBattleView, buildKbFactionView, buildKbFactionsView, BATTLE_VIEW_ID,
  FACTION_VIEW_ID, FACTIONS_VIEW_ID } = require("./views/battles");
const { createKillProjector } = require("./killProjector");
const { buildKbKillsView, buildKbKillView, buildKbCharacterView, KILLS_VIEW_ID, KILL_VIEW_ID,
  CHARACTER_VIEW_ID } = require("./views/kills");

const INT_KEYS = Object.freeze(["passMs", "maxBattlesPerPass", "maxScanRowsPerPass", "maxPassMs", "battleOverlapMs",
  "battleBackfillMs", "maxPriceTypesPerPass", "maxBattleRows", "pruneBatch", "pageRows", "relatedKillsMax",
  "relatedKillSlackMs", "relatedScanRows"]);
const KILL_INT_KEYS = Object.freeze(["maxKillsPerPass", "killMinAgeMs", "killHoleLookahead", "killBackfillMs",
  "maxKillRows", "maxAttackersStored", "maxNamesPerPass", "pendingMaxAgeMs"]);
const MIN_ROWS_CAP = 6;
const NAMES_REFRESH_PASSES = 20;
const UNAVAILABLE = "KILLBOARD_UNAVAILABLE";

function noop() {}

function settingsOf(config) {
  const k = config && config.killboard;
  if (!k || typeof k.enabled !== "boolean" || !INT_KEYS.every((key) => Number.isSafeInteger(k[key]) && k[key] >= 0)) {
    return null;
  }
  if (k.killmailsEnabled === true && !KILL_INT_KEYS.every((key) => Number.isSafeInteger(k[key]) && k[key] >= 0)) {
    return null;
  }
  return k;
}

function createUnavailableKillboard(reason) {
  return Object.freeze({
    getStatus: () => Object.freeze({ available: false, reason: String(reason || UNAVAILABLE) }),
    runPassNow: () => ({ ok: false, reason: UNAVAILABLE }),
    stop: noop,
  });
}

function startKillboard(deps) {
  const k = deps && deps.config && deps.config.killboard;
  if (!k || k.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const P = settingsOf(deps.config);
  if (!P) return { ok: false, reason: "KILLBOARD_START_FAILED", detail: "settings" };
  const ctx = deps.ctx || {};
  const store = ctx.persistence && ctx.persistence.store;
  if (!store || typeof store.transaction !== "function") {
    return { ok: false, reason: "KILLBOARD_DEPENDENCY_UNAVAILABLE", detail: "persistence" };
  }
  const maxRows = deps.config.persistence && deps.config.persistence.maxRowsPerTransaction;
  const storeRows = store.limits && store.limits.maxRowsPerTransaction;
  const rowsCap = Number.isSafeInteger(storeRows) ? Math.min(maxRows || storeRows, storeRows) : maxRows;
  if (!Number.isSafeInteger(rowsCap) || rowsCap < MIN_ROWS_CAP) {
    return { ok: false, reason: "KILLBOARD_START_FAILED", detail: `rowsCap ${String(rowsCap)} < ${MIN_ROWS_CAP}` };
  }
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const count = (name, n) => {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(name, n === undefined ? 1 : n);
    } catch (_err) {
    }
  };
  const gauge = (name, value) => {
    if (!telemetry || typeof telemetry.gauge !== "function") return;
    try {
      telemetry.gauge(name, value);
    } catch (_err) {
    }
  };
  const adapter = deps.adapter || null;
  const repo = createKillboardRepository();
  let stopped = false;
  let writeVersion = 0;

  const projector = createBattleProjector({ store, repo, P, rowsCap, clock, count, gauge, log,
    getBattleRepository: () => (ctx.battle && ctx.battle.repository) || null,
    readItemTypeFacts: (ids) => (adapter && typeof adapter.readItemTypeFacts === "function"
      ? adapter.readItemTypeFacts(ids) : { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" }),
    getGovernor: () => ctx.governor || null,
    onWrite: () => {
      writeVersion += 1;
    },
    isRunning: () => !stopped });

  let names = new Map();
  let namesVersion = 0;
  let namesAt = null;
  const refreshNames = () => {
    namesAt = clock.now();
    try {
      const r = adapter && typeof adapter.readFactionNames === "function" ? adapter.readFactionNames() : null;
      if (r && r.ok === true && r.names instanceof Map) {
        names = r.names;
        namesVersion += 1;
      }
    } catch (_err) {
    }
  };
  const factionName = (id) => {
    if (namesAt === null || clock.now() - namesAt >= P.passMs * NAMES_REFRESH_PASSES) refreshNames();
    const n = names.get(id);
    return typeof n === "string" && n !== "" ? n : null;
  };
  const systemOf = (id) => {
    try {
      const res = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
      const v = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
      if (!v) return null;
      return { name: typeof v.name === "string" && v.name !== "" ? v.name : null,
        security: Number.isFinite(v.security) ? v.security : null };
    } catch (_err) {
      return null;
    }
  };
  refreshNames();

  const call = (name, fallback) => (...args) => (adapter && typeof adapter[name] === "function"
    ? adapter[name](...args) : fallback);
  const killProjector = createKillProjector({ store, repo, P, rowsCap, clock, count, gauge, log,
    getGovernor: () => ctx.governor || null,
    killboardSeams: call("killboardSeams", { ok: false, reason: "SEAM_UNAVAILABLE", missing: ["adapter"] }),
    readVendorKillsAfter: call("readVendorKillsAfter", { ok: false, reason: "SEAM_UNAVAILABLE" }),
    readCharacterNames: call("readCharacterNames", { ok: false, reason: "SEAM_UNAVAILABLE" }),
    readPlayerOrgNames: (spec) => (adapter && typeof adapter.readPlayerOrgNames === "function"
      ? adapter.readPlayerOrgNames(spec, "killboard.names") : { ok: false, reason: "SEAM_UNAVAILABLE" }),
    readItemTypeFacts: call("readItemTypeFacts", { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" }),
    isLneNpcCorporation: (id) => typeof deps.isLneNpcCorporation === "function" && deps.isLneNpcCorporation(id) === true,
    onWrite: () => {
      writeVersion += 1;
    },
    isRunning: () => !stopped });
  const runBoth = () => {
    const now = clock.now();
    const battles = projector.runPass(now);
    let kills;
    try {
      kills = killProjector.runPass(now);
    } catch (err) {
      kills = { ok: false, reason: "PASS_FAILED", detail: String((err && err.message) || err).slice(0, 200) };
    }
    return { ...battles, kills };
  };

  const poller = createPoller({ runPass: runBoth, intervalMs: P.passMs,
    now: () => clock.now(), setTimer: deps.setTimer,
    onError: (err) => log(`killboard: pass failed - ${String((err && err.message) || err)}`) });

  const registered = [];
  const views = ctx.views;
  if (views && typeof views.registerView === "function") {
    const getGovernor = () => ctx.governor || null;
    const cacheVersion = () => `kb${writeVersion}:${namesVersion}:${projector.getStatus().passes}:`
      + `${killProjector.getStatus().passes}`;
    const common = { store, repo, pageRows: P.pageRows, getGovernor, factionName, systemOf, cacheVersion,
      relatedKillsMax: P.relatedKillsMax, relatedKillSlackMs: P.relatedKillSlackMs, relatedScanRows: P.relatedScanRows };
    const defs = [[VIEW_ID, buildKbBattlesView({ ...common, projectorStatus: () => projector.getStatus() })],
      [BATTLE_VIEW_ID, buildKbBattleView({ ...common,
        getBattleRepository: () => (ctx.battle && ctx.battle.repository) || null })],
      [FACTION_VIEW_ID, buildKbFactionView(common)],
      [FACTIONS_VIEW_ID, buildKbFactionsView(common)]];
    if (P.killmailsEnabled === true) {
      defs.push([KILLS_VIEW_ID, buildKbKillsView(common)], [KILL_VIEW_ID, buildKbKillView(common)],
        [CHARACTER_VIEW_ID, buildKbCharacterView(common)]);
    }
    for (const [id, def] of defs) {
      const r = views.registerView(id, def);
      if (r && r.ok) registered.push(r);
      else log(`killboard: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    }
  }
  const unregisterViews = () => {
    for (const r of registered.splice(0)) r.unregister();
  };
  const started = poller.start();
  if (!started.ok) {
    unregisterViews();
    return { ok: false, reason: "KILLBOARD_START_FAILED", detail: String(started.reason) };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    poller.stop();
    unregisterViews();
  }

  function getStatus() {
    return Object.freeze({ available: !stopped, reason: stopped ? UNAVAILABLE : null, rowsCap,
      view: registered.length > 0, views: registered.length, writeVersion, projector: projector.getStatus(),
      killProjector: killProjector.getStatus() });
  }

  const killboard = Object.freeze({
    getStatus,
    runPassNow: () => (stopped ? { ok: false, reason: UNAVAILABLE } : runBoth()),
    stop,
  });
  log(`killboard: running passMs=${P.passMs} rowsCap=${rowsCap} view=${registered.length > 0} `
    + `killmails=${P.killmailsEnabled === true}`);
  return { ok: true, killboard };
}

module.exports = { startKillboard, createUnavailableKillboard, settingsOf };
