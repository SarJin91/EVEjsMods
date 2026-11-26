"use strict";

const { isModuleEnabled } = require("../../../config");
const { createPoller } = require("../../presence/poller");
const { createKillboardRepository } = require("../../killboard/repository");
const S = require("./schema");
const { createDevIndicesRepository } = require("./repository");
const { createMemoryIndex } = require("./memoryIndex");
const { createSweep, COUNTER_NAMES } = require("./sweep");
const VIEW = require("./view");
const CMD = require("./command");
const { createInvest } = require("./invest");
const INV_CMD = require("./investCommand");
const R = require("./rules");
const { createDevHints, registerDevHints } = require("./gmHint");
const CP = require("./clientProjection");

const DEV_INDICES_METHODS = S.METHODS;
const EMPTY = Object.freeze([]);
const CLIENT_RANK_MS = 60000;

const messageOf = (err) => String((err && err.message) || err).slice(0, 200);

function call(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableDevIndices(reason) {
  const why = String(reason || "DEV_INDICES_UNAVAILABLE");
  const mode = why === "disabled_by_config" ? S.MODES.OFF : S.MODES.STOPPED;
  const status = Object.freeze({ mode, reason: why, tracked: 0, cursors: EMPTY, counters: Object.freeze({}),
    lastPass: null, lastRefresh: null });
  return Object.freeze({ getMode: () => mode, getStatus: () => status, levelsOf: () => null, listTop: () => EMPTY,
    effectsOf: () => S.NO_EFFECTS, stop() {} });
}

function registerViews(deps, memory, P, getStatus, systemNameOf, log) {
  const views = deps.views;
  if (!views || typeof views.registerView !== "function") return [];
  const defs = [[S.VIEW_ID, () => VIEW.buildDevPanel({ memory, settings: P, clock: deps.clock, getStatus,
    systemNameOf })]];
  if (deps.config.observer && deps.config.observer.galaxyEnabled === true && P.observerLayerEnabled) {
    defs.push([S.LAYER_ID, () => VIEW.buildDevLayer({ memory, settings: P, clock: deps.clock })]);
  }
  const out = [];
  for (const [id, build] of defs) {
    try {
      const r = views.registerView(id, build());
      if (r && r.ok === true && typeof r.unregister === "function") out.push(() => r.unregister());
      else log(`view ${id} not registered - ${(r && r.reason) || "no result"}`);
    } catch (err) {
      log(`view ${id} not registered - ${messageOf(err)}`);
    }
  }
  return out;
}

function startDevIndices(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const D = config && config.devIndices;
    if (!D || D.enabled !== true || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
    if (!store) return { ok: false, reason: "DEV_INDICES_START_FAILED", detail: "persistence" };
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "DEV_INDICES_START_FAILED", detail: "clock" };
    }
    const parsed = S.devIndicesSettingsOf(config);
    if (!parsed.ok) {
      return { ok: false, reason: "DEV_INDICES_START_FAILED", detail: `${parsed.reason}:${parsed.detail}` };
    }
    const P = parsed.settings;
    const rowLimit = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : config.persistence && config.persistence.maxRowsPerTransaction;
    if (Number.isSafeInteger(rowLimit) && S.rowBoundOf(P) > rowLimit) {
      return { ok: false, reason: "DEV_ROW_BOUND", detail: `${S.rowBoundOf(P)} > ${rowLimit}` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const log = (line) => call(() => logger.log(`devIndices: ${line}`));
    const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
    const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
    const graphSystem = (id) => {
      try {
        const g = getGraph();
        return g && typeof g.getSystem === "function" ? g.getSystem(id) : null;
      } catch (_err) {
        return null;
      }
    };
    const systemNameOf = (id) => {
      const sys = graphSystem(id);
      return sys && typeof sys.name === "string" ? sys.name : null;
    };
    const secClassOf = (id) => {
      const sys = graphSystem(id);
      return sys && typeof sys.secClass === "string" ? sys.secClass : null;
    };
    const getRegistry = () => {
      try {
        const reg = typeof deps.getStrategyRegistry === "function" ? deps.getStrategyRegistry() : null;
        return reg && typeof reg.listFactions === "function" ? reg : null;
      } catch (_err) {
        return null;
      }
    };
    const getFactionIds = () => {
      const reg = getRegistry();
      const list = reg ? reg.listFactions() : null;
      return Array.isArray(list) ? list.map((f) => f && f.factionId).filter((id) => Number.isSafeInteger(id) && id > 0)
        : null;
    };
    const repo = createDevIndicesRepository();
    const memory = createMemoryIndex({ P, clock, secClassOf });
    let hints = null;
    const sweep = createSweep({ store, repo, kbRepo: createKillboardRepository(), memory, settings: P, getGraph,
      getWorldRepository: deps.getWorldRepository, getGovernor: deps.getGovernor, telemetry: deps.telemetry || null,
      log, nowMs, getFactionIds, onWorldEvents: (events) => {
        if (hints) hints.push(events);
      } });
    if (P.gmHintEnabled) hints = createDevHints({ systemNameOf, bump: (name) => sweep.bump(name) });
    const adapter = deps.adapter || null;
    let invest = null;
    let investOff = "flag";
    if (P.investEnabled) {
      if (!adapter || typeof adapter.tradeAdjustWallet !== "function") investOff = "no_wallet_seam";
      else if (!deps.ids || typeof deps.ids.next !== "function") investOff = "no_ids";
      else {
        investOff = null;
        invest = createInvest({ store, repo, memory, settings: P, ids: deps.ids,
          tradeAdjustWallet: (spec) => adapter.tradeAdjustWallet(spec),
          sendCharacterSystemLine: typeof adapter.sendCharacterSystemLine === "function"
            ? (spec) => adapter.sendCharacterSystemLine(spec) : null,
          getWorldRepository: deps.getWorldRepository, systemNameOf, bump: (name, n) => sweep.bump(name, n),
          gauge: (name, value) => {
            if (deps.telemetry && typeof deps.telemetry.gauge === "function") call(() => deps.telemetry.gauge(name, value));
          },
          log });
      }
    }
    const controllerNameOf = (systemId) => {
      const world = typeof deps.getWorldRepository === "function" ? deps.getWorldRepository() : null;
      if (!world || typeof world.getSystem !== "function") return "unknown";
      const tx = store.transaction("devIndices.investPreview", (db) => world.getSystem(db, systemId));
      const r = tx && tx.ok ? tx.value : null;
      if (!r || r.ok !== true) return "unknown";
      const id = r.system ? r.system.controllerFactionId : null;
      if (!Number.isSafeInteger(id) || id <= 0) return "none";
      const reg = getRegistry();
      const f = reg && typeof reg.getFaction === "function" ? reg.getFaction(id) : null;
      return f && typeof f.name === "string" ? f.name : `faction ${id}`;
    };
    let mode = S.MODES.WARMING;
    let warmAfter = 0;
    let warmStartedMs = null;

    function warmStep() {
      if (warmStartedMs === null) warmStartedMs = nowMs();
      const tx = store.transaction("devIndices.warm", (db) => {
        const page = repo.listPageInTx(db, warmAfter, P.indexPageRows);
        const cursors = warmAfter === 0 ? repo.listCursorsInTx(db) : { ok: true, cursors: [] };
        return { page, cursors };
      });
      const v = tx && tx.ok ? tx.value : null;
      if (!v || !v.page.ok || !v.cursors.ok) {
        log(`warm load refused - ${(tx && tx.reason) || (v && !v.page.ok ? v.page.reason : "cursors")}`);
        return;
      }
      sweep.setCursors(v.cursors.cursors);
      const dropped = memory.loadPage(v.page.rows);
      if (dropped > 0) sweep.bump("capped.tracked", dropped);
      if (v.page.rows.length >= P.indexPageRows) {
        warmAfter = v.page.rows[v.page.rows.length - 1].systemId;
        poller.arm(0);
        return;
      }
      memory.markWarm();
      mode = S.MODES.ON;
      const ms = Math.max(0, nowMs() - warmStartedMs);
      if (deps.telemetry && typeof deps.telemetry.observe === "function") {
        call(() => deps.telemetry.observe("devIndices.warm.ms", ms));
      }
      sweep.gauges(clock.now());
      log(`warm - ${memory.size()} systems`);
      poller.arm(0);
    }

    function runPass() {
      if (mode === S.MODES.STOPPED) return;
      if (!memory.isWarm()) {
        warmStep();
        return;
      }
      const now = clock.now();
      sweep.runPass(now);
      sweep.runRefresh(now);
      sweep.gauges(now);
      if (invest) invest.pass(now);
    }

    const poller = createPoller({ runPass, intervalMs: P.sweepIntervalMs, now: () => clock.now(),
      setTimer: deps.setTimer, onError: (err) => log(`pass threw - ${messageOf(err)}`) });
    const started = poller.start();
    if (!started.ok) return { ok: false, reason: "DEV_INDICES_START_FAILED", detail: `poller ${started.reason}` };
    poller.arm(0);

    const getStatus = () => {
      const s = sweep.getStatus();
      return Object.freeze({ mode, tracked: memory.size(), cursors: s.cursors, counters: s.counters,
        lastPass: s.lastPass, lastRefresh: s.lastRefresh });
    };
    const levelsOf = (systemId) => (mode === S.MODES.STOPPED || !Number.isSafeInteger(systemId) ? null
      : memory.levelsOf(systemId));
    const listTop = (kind, opts) => (mode === S.MODES.STOPPED ? EMPTY : memory.listTop(kind, opts));
    const effectsOf = (systemId, use) => {
      if (mode === S.MODES.STOPPED || !Number.isSafeInteger(systemId) || systemId <= 0) return S.NO_EFFECTS;
      try {
        const lv = memory.levelsOf(systemId);
        if (!lv) return S.NO_EFFECTS;
        const e = R.effectsOf(lv, P);
        if (use === "garrison" && e.garrisonPoints > 0) sweep.bump("effects.garrison");
        if (use === "discount" && e.wtsDiscountPermille > 0) sweep.bump("effects.discount");
        return e;
      } catch (_err) {
        sweep.bump("effects.failed");
        return S.NO_EFFECTS;
      }
    };

    const unregister = registerViews(deps, memory, P, getStatus, systemNameOf, log);
    if (deps.telemetry && typeof deps.telemetry.registerMemoryProbe === "function") {
      const probe = deps.telemetry.registerMemoryProbe("devIndices.memory", () => ({ entries: memory.size() }));
      if (probe && probe.ok === true) unregister.push(() => probe.unregister());
    }
    let unregisterHint = null;
    if (hints) {
      const reg = registerDevHints(deps.gmSteps || null, hints);
      if (reg.ok) {
        unregisterHint = reg.unregister;
        sweep.bump("gm.registered");
      } else if (reg.reason !== "NO_REGISTRY") {
        sweep.bump("gm.refused");
        log(`gm hint not registered - ${reg.reason}`);
      }
    }
    let uninstallCommand = null;
    if (P.commandEnabled) {
      const chat = CMD.createDevChat({ levelsOf, settings: P, clock, isRunning: () => mode !== S.MODES.STOPPED,
        getGovernor: deps.getGovernor, systemNameOf, bump: (name) => sweep.bump(name), log });
      const installed = CMD.installDevCommand(deps.adapter || null, chat);
      if (installed.ok) uninstallCommand = installed.uninstall;
      else log(`!dev not installed - ${installed.reason}${installed.detail ? `:${installed.detail}` : ""}`);
    }
    let uninstallInvest = null;
    if (invest) {
      const investChat = INV_CMD.createInvestChat({ invest, settings: P, clock, ids: deps.ids,
        isRunning: () => mode !== S.MODES.STOPPED, systemNameOf, secClassOf, controllerNameOf, levelsOf,
        bump: (name) => sweep.bump(name), log });
      const installed = INV_CMD.installInvestCommand(adapter, investChat);
      if (installed.ok) uninstallInvest = installed.uninstall;
      else log(`!invest not installed - ${installed.reason}${installed.detail ? `:${installed.detail}` : ""}`);
    } else if (investOff !== "flag") {
      log(`!invest off - ${investOff}`);
    }
    let clientOn = false;
    if (P.clientIndicesEnabled) {
      let ranked = { key: null, rows: EMPTY };
      const rankedCached = () => {
        const now = clock.now();
        const key = `${memory.version()}:${Math.floor(now / CLIENT_RANK_MS)}`;
        if (ranked.key !== key) ranked = { key, rows: CP.rankRows(memory.decayedRows(now)) };
        return ranked.rows;
      };
      const provider = Object.freeze({
        projectSystem: (id, vendorIdx, K) => (mode === S.MODES.ON && Number.isSafeInteger(id) && id > 0
          ? CP.projectSystem(memory.levelsOf(id), vendorIdx, P, K) : null),
        projectAll: (vendor, claimed, K) => (mode === S.MODES.ON ? CP.mergeAll(vendor, claimed, rankedCached(), P, K)
          : null),
        onEvent: (name) => sweep.bump(`client.${name}`),
      });
      if (!adapter || typeof adapter.installDevIndexClient !== "function") {
        log("client projection off - no seam");
      } else {
        let r;
        try {
          r = adapter.installDevIndexClient(provider);
        } catch (err) {
          r = { ok: false, reason: "DEV_CLIENT_SEAM_UNAVAILABLE", detail: messageOf(err) };
        }
        if (r && r.ok === true) clientOn = true;
        else {
          if (r && r.reason === "DEV_CLIENT_DRIFT") sweep.bump("client.drift");
          log(`client projection off - ${(r && r.reason) || "no result"}${r && r.detail ? `:${r.detail}` : ""}`);
        }
      }
    }
    log(`running secClasses=${P.secClasses.join(",")} kills=${P.killmailsEnabled && P.ratKillMilPoints > 0 ? "on"
      : "off"} command=${uninstallCommand ? "on" : "off"} views=${unregister.length}`
      + `${P.investEnabled ? ` invest=${uninstallInvest ? "on" : "off"}` : ""}`
      + `${P.clientIndicesEnabled ? ` client=${clientOn ? "on" : "off"}` : ""}${P.stationsEnabled ? " stations=on" : ""}`);

    const facade = {
      getMode: () => mode,
      getStatus,
      levelsOf,
      listTop,
      effectsOf,
      stop(reason) {
        if (mode === S.MODES.STOPPED) return;
        mode = S.MODES.STOPPED;
        call(() => poller.stop());
        sweep.stop();
        for (const u of unregister) call(u);
        unregister.length = 0;
        if (uninstallCommand) call(uninstallCommand);
        uninstallCommand = null;
        if (uninstallInvest) call(uninstallInvest);
        uninstallInvest = null;
        if (unregisterHint) call(unregisterHint);
        unregisterHint = null;
        if (invest) call(() => invest.stop());
        if (clientOn) call(() => adapter.uninstallDevIndexClient());
        clientOn = false;
        log(`stopped (${reason || "stop"})`);
      },
    };
    return { ok: true, devIndices: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "DEV_INDICES_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startDevIndices, createUnavailableDevIndices, DEV_INDICES_METHODS, COUNTER_NAMES };
