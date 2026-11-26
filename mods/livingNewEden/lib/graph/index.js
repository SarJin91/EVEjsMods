"use strict";

const { performance } = require("node:perf_hooks");
const { buildUniverseGraph } = require("./universeGraph");
const { createRouteFinder } = require("./routes");
const { bfsFrom, pickSources } = require("./diameter");
const { buildGalaxyStatic, LAYOUT: GALAXY_LAYOUT } = require("./galaxyStatic");

const GALAXY_WORK_CLASS = "MAINTENANCE";

const STATE = Object.freeze({
  LOADING: "loading", READY: "ready", FAILED: "failed", DISABLED: "disabled", STOPPED: "stopped",
});

const REASON = Object.freeze({
  DISABLED: "GRAPH_DISABLED",
  UNAVAILABLE: "GRAPH_UNAVAILABLE",
  LOADING: "GRAPH_LOADING",
  LOAD_FAILED: "GRAPH_LOAD_FAILED",
  STOPPED: "GRAPH_STOPPED",
});

const BUILD_THREW = "GRAPH_BUILD_THREW";
const MAX_DETAIL_LENGTH = 200;
const MS_DECIMALS = 10;
const PERCENT = 100;

const GAUGES = Object.freeze([
  ["graph.systems", "systems"], ["graph.edges", "edges"], ["graph.regions", "regions"],
  ["graph.constellations", "constellations"], ["graph.invalidSystems", "invalidSystems"],
  ["graph.invalidEdges", "invalidEdges"], ["graph.oneSidedEdges", "oneSidedEdges"],
  ["graph.regionsWithoutName", "regionsWithoutName"], ["graph.constellationsWithoutName", "constellationsWithoutName"],
  ["graph.systemsWithoutPosition", "systemsWithoutPosition"],
]);

const GALAXY_BUILD = Object.freeze({ BUILD: "BUILD", FORCED: "FORCED", HOLD: "HOLD" });

function decideGalaxyStaticBuild(input) {
  if (input.admitted) return GALAXY_BUILD.BUILD;
  return !input.anyMemo && input.firstBuildBypass ? GALAXY_BUILD.FORCED : GALAXY_BUILD.HOLD;
}

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function round1(ms) {
  return Math.round(ms * MS_DECIMALS) / MS_DECIMALS;
}

function defaultDefer(fn) {
  const handle = setImmediate(fn);
  return { cancel: () => clearImmediate(handle) };
}

function refusal(reason, detail) {
  return Object.freeze({ ok: false, reason, ...(detail ? { detail } : {}) });
}

function buildSummary(state, reason, stats, timings) {
  const s = stats || {};
  const t = timings || {};
  return Object.freeze({
    state,
    reason: reason || null,
    systems: s.systems || 0,
    edges: s.edges || 0,
    regions: s.regions || 0,
    constellations: s.constellations || 0,
    regionsWithoutName: s.regionsWithoutName || 0,
    constellationsWithoutName: s.constellationsWithoutName || 0,
    invalidSystems: s.invalidSystems || 0,
    invalidEdges: s.invalidEdges || 0,
    oneSidedEdges: s.oneSidedEdges || 0,
    systemsWithoutPosition: s.systemsWithoutPosition || 0,
    bySecClass: s.bySecClass || null,
    readMs: t.readMs === undefined ? null : t.readMs,
    buildMs: t.buildMs === undefined ? null : t.buildMs,
    totalMs: t.totalMs === undefined ? null : t.totalMs,
    slow: t.slow === true,
    diameterSample: null,
  });
}

function formatBuiltLine(stats, timings, buildWarnMs) {
  const namedRegions = stats.regions - stats.regionsWithoutName;
  const namedConstellations = stats.constellations - stats.constellationsWithoutName;
  return `graph built: ${stats.systems} systems, ${stats.edges} edges, ${timings.totalMs}ms `
    + `(read ${timings.readMs}ms, build ${timings.buildMs}ms) regions=${stats.regions} `
    + `constellations=${stats.constellations} invalidSystems=${stats.invalidSystems} `
    + `invalidEdges=${stats.invalidEdges} oneSidedEdges=${stats.oneSidedEdges} `
    + `namedRegions=${namedRegions}/${stats.regions} namedConstellations=${namedConstellations}/${stats.constellations}`
    + `${timings.slow ? ` SLOW>=${buildWarnMs}ms` : ""}`;
}

function createUnavailableGraph(reason, detail) {
  const result = refusal(reason === REASON.DISABLED ? REASON.DISABLED : REASON.UNAVAILABLE,
    detail ? String(detail) : undefined);
  const state = Object.freeze({ state: STATE.DISABLED, reason: result.reason, detail: result.detail || null });
  const summary = buildSummary(STATE.DISABLED, result.reason, null, null);
  return Object.freeze({
    getGraph: () => result,
    whenReady: () => Promise.resolve(result),
    getState: () => state,
    getSummary: () => summary,
    stop: noop,
  });
}

function startGraph(deps = {}) {
  const adapter = deps.adapter;
  if (!adapter || typeof adapter.readStaticMap !== "function") return { ok: false, reason: "adapter_unavailable" };
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const telemetry = deps.telemetry || null;
  const fail = typeof deps.fail === "function" ? deps.fail : noop;
  const defer = typeof deps.defer === "function" ? deps.defer : defaultDefer;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const buildWarnMs = deps.config.graph.buildWarnMs;

  let state = STATE.LOADING;
  let reason = REASON.LOADING;
  let detail = null;
  let graph = null;
  let summary = buildSummary(state, reason, null, null);
  let resolveReady = null;
  let samplePending = null;
  let disposeFinder = null;
  let viewHandle = null;
  let galaxyHandle = null;
  let galaxyMemo = null;
  let galaxySeq = 0;
  const ready = new Promise((resolve) => { resolveReady = resolve; });

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry) return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function getGraph() {
    if (state === STATE.READY) return { ok: true, graph };
    return refusal(reason, detail);
  }

  function settle() {
    if (resolveReady === null) return;
    const resolve = resolveReady;
    resolveReady = null;
    resolve(getGraph());
  }

  function failBuild(sourceReason, sourceDetail) {
    const text = sourceDetail ? String(sourceDetail).slice(0, MAX_DETAIL_LENGTH) : "";
    state = STATE.FAILED;
    reason = REASON.LOAD_FAILED;
    detail = `${sourceReason}${text ? `:${text}` : ""}`;
    summary = buildSummary(state, reason, null, null);
    log(`graph failed: ${sourceReason}${text ? ` (${text})` : ""}`);
    if (telemetry) {
      try {
        telemetry.count("graph.buildFailures");
      } catch (_err) {
      }
    }
    settle();
    try {
      fail(REASON.LOAD_FAILED, detail);
    } catch (_err) {
    }
  }

  function logTransitAversion(target, aversion) {
    const ids = Array.isArray(aversion.systemIds) ? aversion.systemIds : [];
    const counts = ids.map((id) => (target.hasSystem(id) ? target.getNeighbors(id).length : 0));
    log(`graph: transit aversion systems=${ids.join(",")} neighbours=${counts.join(",")} `
      + `detour=${aversion.detourMaxJumps}`);
    ids.forEach((id, i) => {
      if (counts[i] === 0) log(`graph: WARNING transit aversion system ${id} has no gate neighbours - no effect`);
    });
  }

  function build() {
    if (state !== STATE.LOADING) return;
    try {
      const startedAt = nowMs();
      const read = adapter.readStaticMap();
      const readAt = nowMs();
      if (!read || read.ok !== true) {
        failBuild(String((read && read.reason) || "no_result"), read && read.detail);
        return;
      }
      const warning = read.map && read.map.namesWarning;
      if (warning) {
        log(`graph: map names unavailable - ${warning.reason}${warning.detail ? ` (${warning.detail})` : ""}; `
          + "using station names");
      }
      const built = buildUniverseGraph(read.map);
      const builtAt = nowMs();
      if (!built.ok) {
        failBuild(built.reason);
        return;
      }
      const totalMs = round1(builtAt - startedAt);
      const timings = { readMs: round1(readAt - startedAt), buildMs: round1(builtAt - readAt), totalMs,
        slow: totalMs >= buildWarnMs };
      const finder = createRouteFinder(built.graph, { cacheSize: deps.config.graph.routeCacheSize,
        maxJumps: deps.config.graph.routeMaxJumps, telemetry, nowMs,
        ...(deps.transitAversion ? { transitAversion: deps.transitAversion } : {}) });
      disposeFinder = typeof finder.dispose === "function" ? finder.dispose : null;
      if (deps.transitAversion) logTransitAversion(built.graph, deps.transitAversion);
      graph = Object.freeze({ ...built.graph, ...finder.publicApi });
      state = STATE.READY;
      reason = null;
      detail = null;
      summary = buildSummary(state, null, built.stats, timings);
      metric("gauge", "graph.readMs", timings.readMs);
      metric("gauge", "graph.buildMs", timings.buildMs);
      for (const [name, key] of GAUGES) metric("gauge", name, built.stats[key]);
      log(formatBuiltLine(built.stats, timings, buildWarnMs));
      settle();
      startDiameterSample(graph);
    } catch (err) {
      if (state === STATE.LOADING) failBuild(BUILD_THREW, messageOf(err));
    }
  }

  function startDiameterSample(target) {
    const count = deps.config.graph.diameterSampleSources;
    if (!Number.isSafeInteger(count) || count <= 0) return;
    const limit = deps.config.graph.routeMaxJumps;
    const sources = pickSources(target, count);
    if (sources.length === 0) return;
    const run = { queue: [...sources], swept: false, best: null, reached: 0, overLimit: 0, bfs: 0, workMs: 0 };
    const step = () => {
      samplePending = null;
      if (state !== STATE.READY) return;
      try {
        const sourceId = run.queue.shift();
        const t0 = nowMs();
        const r = bfsFrom(target, sourceId, limit);
        run.workMs += nowMs() - t0;
        run.bfs += 1;
        run.reached += r.reached;
        run.overLimit += r.overLimit;
        if (!run.best || r.maxDist > run.best.maxDist) {
          run.best = { maxDist: r.maxDist, from: sourceId, to: r.farthestId };
        }
        if (run.queue.length === 0 && !run.swept) {
          run.swept = true;
          if (!sources.includes(run.best.to)) run.queue.push(run.best.to);
        }
        if (run.queue.length > 0) {
          samplePending = defer(step);
          return;
        }
        finishSample(run, limit);
      } catch (err) {
        log(`graph diameter sample failed: ${messageOf(err)}`);
      }
    };
    samplePending = defer(step);
  }

  function finishSample(run, limit) {
    const overLimitPct = run.reached > 0 ? round1((run.overLimit * PERCENT) / run.reached) : 0;
    const sample = Object.freeze({ done: true, maxJumps: run.best.maxDist, fromId: run.best.from,
      toId: run.best.to, sources: run.bfs, reached: run.reached, overLimit: run.overLimit, overLimitPct,
      routeMaxJumps: limit, workMs: round1(run.workMs) });
    summary = Object.freeze({ ...summary, diameterSample: sample });
    metric("gauge", "graph.diameterMaxJumps", sample.maxJumps);
    log(`graph diameter sample: max ${sample.maxJumps} jumps (${sample.fromId} -> ${sample.toId}) `
      + `sources=${sample.sources} reached=${sample.reached} overLimit=${overLimitPct}% `
      + `(routeMaxJumps=${limit}) in ${sample.workMs}ms`);
  }

  const pending = defer(build);

  function stop() {
    if (state === STATE.STOPPED) return;
    for (const handle of [pending, samplePending]) {
      try {
        if (handle && typeof handle.cancel === "function") handle.cancel();
      } catch (_err) {
      }
    }
    samplePending = null;
    if (disposeFinder !== null) {
      try {
        disposeFinder();
      } catch (_err) {
      }
      disposeFinder = null;
    }
    for (const view of [viewHandle, galaxyHandle]) {
      if (!view) continue;
      try {
        view.unregister();
      } catch (_err) {
      }
    }
    viewHandle = null;
    galaxyHandle = null;
    galaxyMemo = null;
    state = STATE.STOPPED;
    reason = REASON.STOPPED;
    detail = null;
    graph = null;
    summary = buildSummary(state, reason, null, null);
    settle();
  }

  const service = Object.freeze({
    getGraph,
    whenReady: () => ready,
    getState: () => Object.freeze({ state, reason: state === STATE.READY ? null : reason, detail }),
    getSummary: () => summary,
    stop,
  });
  registerGraphView(deps.views);
  registerGalaxyStaticView(deps.views);
  return { ok: true, graph: service };

  function registerGalaxyStaticView(views) {
    const settings = deps.config.observer || {};
    if (settings.galaxyEnabled !== true || !views || typeof views.registerView !== "function") return;
    const gridSize = settings.galaxyGridSize;
    const firstBuildBypass = settings.galaxyFirstBuildBypassesGovernor === true;
    const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
    const currentMemo = () => (galaxyMemo && state === STATE.READY && galaxyMemo.graph === graph ? galaxyMemo : null);
    const admitted = () => {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
    };
    const getData = () => {
      if (state !== STATE.READY || !graph) return { available: false, reason: "GRAPH_NOT_READY" };
      const memo = currentMemo();
      if (memo) return memo.data;
      const decision = decideGalaxyStaticBuild({ anyMemo: galaxyMemo !== null, admitted: admitted(),
        firstBuildBypass });
      if (decision === GALAXY_BUILD.HOLD) {
        metric("count", "observer.galaxy.deferrals", 1);
        return { available: false, reason: "GOVERNOR_HOLD" };
      }
      if (decision === GALAXY_BUILD.FORCED) metric("count", "observer.galaxy.forcedFirstBuilds", 1);
      const t0 = nowMs();
      const built = buildGalaxyStatic(graph, { gridSize });
      const ms = round1(nowMs() - t0);
      metric("observe", "observer.galaxy.staticBuildMs", ms);
      galaxySeq += 1;
      const key = `g${galaxySeq}|${GALAXY_LAYOUT}|${gridSize}`;
      const data = { ...built, key };
      galaxyMemo = { graph, key, data };
      const stats = built.stats;
      const forcedNote = decision === GALAXY_BUILD.FORCED ? " (first build under governor hold)" : "";
      log(`graph: galaxy static built in ${ms}ms${forcedNote}`
        + (built.available ? ` systems=${stats.systems} edges=${stats.edges} skippedNoPosition=`
          + `${stats.skippedNoPosition} skippedEdges=${stats.skippedEdges}` : ` - ${built.reason}`)
        + (ms >= buildWarnMs ? ` SLOW>=${buildWarnMs}ms` : ""));
      return data;
    };
    const r = views.registerView("galaxy-static", {
      title: "Galaxy static", listed: false, getData,
      cacheKey: () => {
        const memo = currentMemo();
        return memo ? memo.key : null;
      },
    });
    if (r && r.ok) galaxyHandle = r;
    else log(`graph: view galaxy-static not registered - ${(r && r.reason) || "no result"}`);
  }

  function registerGraphView(views) {
    if (!views || typeof views.registerView !== "function") return;
    const routeStats = () => (state === STATE.READY && graph ? graph.getRouteStats() : null);
    const r = views.registerView("graph", {
      title: "Universe graph",
      order: 20,
      getData: () => ({ ...summary, routeMaxJumps: deps.config.graph.routeMaxJumps, routeStats: routeStats() }),
      cacheKey: () => {
        const stats = routeStats();
        const overlay = stats && stats.wormholeVersion > 0 ? `|wh${stats.wormholeVersion}:${stats.wormholeEdges}` : "";
        return `${state}|${summary.diameterSample ? 1 : 0}|${stats ? stats.searches + stats.hits : "-"}${overlay}`;
      },
    });
    if (r && r.ok) viewHandle = r;
    else log(`graph: view graph not registered - ${(r && r.reason) || "no result"}`);
  }
}

module.exports = { REASON, GALAXY_BUILD, startGraph, createUnavailableGraph, formatBuiltLine,
  decideGalaxyStaticBuild };
