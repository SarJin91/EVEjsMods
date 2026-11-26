"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { BASE_HEADERS, createRouter, isAllowedHost } = require("./router");
const { buildStatusView, buildTelemetryView, buildJournalView } = require("./builtinViews");
const { VIEW_ID: MODULE_COST_ID, buildModuleCostView } = require("./views/moduleCost");
const { buildGalaxyView } = require("./galaxyView");
const { buildVirtualCorpsView } = require("../virtualCorps/view");
const { LAYER_ID: HUNTS_LAYER_ID, buildHuntsLayerView } = require("./views/huntsLayer");
const { PANEL_ID: HUNTS_PANEL_ID, buildHuntsPanelView } = require("./views/huntsPanel");
const { readFactionNames } = require("../world/sovProjection");
const { VIEW_ID: FACTION_OVERVIEW_ID, buildFactionOverviewView } = require("./views/factionOverview");
const { VIEW_ID: SYSTEM_CARD_ID, buildSystemCardView } = require("./views/systemCard");
const { VIEW_ID: SYSTEM_INTERIOR_ID, buildSystemInteriorView } = require("./views/systemInterior");
const { VIEW_ID: EFFECTIVE_CONFIG_ID, buildEffectiveConfigView } = require("./views/effectiveConfig");
const { SCHEMA } = require("../../config");

const ASSET_FILES = Object.freeze([
  Object.freeze({ route: "/", file: "index.html", contentType: "text/html; charset=utf-8" }),
  Object.freeze({ route: "/app.js", file: "app.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/app.css", file: "app.css", contentType: "text/css; charset=utf-8" }),
  Object.freeze({ route: "/galaxy.js", file: "galaxy.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/systemCard.js", file: "systemCard.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/systemInterior.js", file: "systemInterior.js",
    contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/tabs.js", file: "tabs.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/factions.js", file: "factions.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/settings.html", file: "settings.html", contentType: "text/html; charset=utf-8" }),
  Object.freeze({ route: "/settings.js", file: "settings.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/settings.css", file: "settings.css", contentType: "text/css; charset=utf-8" }),
  Object.freeze({ route: "/shipai-voice.html", file: "shipai-voice.html", contentType: "text/html; charset=utf-8" }),
  Object.freeze({ route: "/shipaiVoice.js", file: "shipaiVoice.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/killboard.html", file: "killboard.html", contentType: "text/html; charset=utf-8" }),
  Object.freeze({ route: "/killboard.js", file: "killboard.js", contentType: "text/javascript; charset=utf-8" }),
  Object.freeze({ route: "/killboard.css", file: "killboard.css", contentType: "text/css; charset=utf-8" }),
]);
const ALL_INTERFACES = Object.freeze(["0.0.0.0", "::"]);
const MAX_URL_LABEL = 80;
const INTERNAL_ERROR_HEADERS = Object.freeze({
  "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
});
const ROUTE_JSON_TYPE = "application/json; charset=utf-8";

function noop() {}

function pathnameOf(url) {
  try {
    return new URL(String(url), "http://localhost").pathname;
  } catch (_err) {
    return null;
  }
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function persistenceStore(ctx) {
  const p = ctx && ctx.persistence;
  return p && p.ok === true && p.store ? p.store : null;
}

function urlHost(host) {
  return String(host).includes(":") ? `[${host}]` : String(host);
}

function readAssets(dir) {
  const assets = {};
  for (const a of ASSET_FILES) {
    try {
      assets[a.route] = { body: fs.readFileSync(path.join(dir, a.file)), contentType: a.contentType };
    } catch (err) {
      return { ok: false, reason: "OBSERVER_ASSETS_MISSING", detail: `${a.file}: ${messageOf(err)}` };
    }
  }
  return { ok: true, assets };
}

function startObserver(deps) {
  const registered = [];
  const unregisterViews = () => {
    while (registered.length > 0) {
      try {
        registered.pop().unregister();
      } catch (_err) {
      }
    }
  };
  try {
    const config = (deps && deps.config) || {};
    const settings = config.observer;
    if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    const ctx = deps.ctx || {};
    const views = deps.views;
    const logger = deps.logger || { log: noop };
    const fail = typeof deps.fail === "function" ? deps.fail : noop;
    const now = typeof deps.now === "function" ? deps.now : Date.now;
    if (!views || typeof views.registerView !== "function") {
      return { ok: false, reason: "OBSERVER_START_FAILED", detail: "no view registry" };
    }
    const read = readAssets(deps.assetsDir || path.join(__dirname, "..", "..", "web"));
    if (!read.ok) return read;

    let router = null;
    let listening = null;
    let stopped = false;
    let journalLastMs = null;
    const getObserverStats = () => ({
      ...(router ? router.getStats() : {}), listening: listening ? { ...listening } : null, journalLastMs,
    });
    const builtins = [
      ["status", buildStatusView({ ctx, config: settings, getObserverStats })],
      ["telemetry", buildTelemetryView({ ctx })],
      ["journal", buildJournalView({ ctx, config: settings, onJournalMs: (ms) => { journalLastMs = ms; } })],
      [MODULE_COST_ID, buildModuleCostView({ ctx })],
    ];
    if (settings.galaxyEnabled === true) builtins.push(["galaxy", buildGalaxyView({ views, config: settings })]);
    if (ctx.virtualCorps && typeof ctx.virtualCorps.listIdentities === "function") {
      builtins.push(["virtual-corps", buildVirtualCorpsView({
        virtualCorps: ctx.virtualCorps, strategy: ctx.strategy, config: ctx.config || {},
        factionNames: readFactionNames(ctx.adapter, logger),
      })]);
    }
    if (settings.galaxyEnabled === true && ctx.world && ctx.world.repository) {
      const r = views.registerView(HUNTS_LAYER_ID, buildHuntsLayerView({
        store: persistenceStore(ctx),
        repository: require("../strategy/hunt/pinRepository"),
        getStaticView: () => views.getView("galaxy-static"),
        config,
        factionNames: readFactionNames(ctx.adapter, logger),
        getGovernor: () => ctx.governor || null,
        telemetry: ctx.telemetry || null,
        clock: ctx.clock,
        nowMs: typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now(),
        settings: {
          maxSystems: settings.galaxyHuntsMaxSystems,
          refreshMs: settings.galaxyHuntsRefreshMs,
        }
      }));
      if (r && r.ok) registered.push(r);
      else logger.log(`observer: view ${HUNTS_LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    if (ctx.strategy && typeof ctx.strategy.getStatus === "function") {
      builtins.push([HUNTS_PANEL_ID, buildHuntsPanelView({
        store: persistenceStore(ctx),
        repository: require("../strategy/hunt/pinRepository"),
        config,
        factionNames: readFactionNames(ctx.adapter, logger),
        getGovernor: () => ctx.governor || null,
        telemetry: ctx.telemetry || null,
        clock: ctx.clock,
        nowMs: typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now(),
        settings: {
          maxRows: settings.huntsPanelMaxRows,
          refreshMs: settings.huntsPanelRefreshMs || settings.journalCacheMs,
        }
      })]);
    }
    if (settings.galaxyEnabled === true && settings.sovProjectionEnabled === true && ctx.world && ctx.world.repository) {
      const { LAYER_ID, buildSovProjectionLayerView } = require("../observer/layers/layer-sov-projection");
      const { readFactionNames } = require("../world/sovProjection");
      const r = views.registerView(LAYER_ID, buildSovProjectionLayerView({
        store: persistenceStore(ctx),
        repository: require("../world/sovProjection/repository"),
        getStaticView: () => views.getView("galaxy-static"),
        config,
        factionNames: readFactionNames(ctx.adapter, logger),
        getGovernor: () => ctx.governor || null,
        telemetry: ctx.telemetry || null,
        clock: ctx.clock,
        nowMs: typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now(),
        settings: {
          maxSystems: settings.sovProjectionMaxSystems,
          refreshMs: settings.sovProjectionRefreshMs,
          radius: 50
        }
      }));
      if (r && r.ok) registered.push(r);
      else logger.log(`observer: view ${LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    if (settings.factionOverviewEnabled === true) {
      builtins.push([FACTION_OVERVIEW_ID, buildFactionOverviewView({
        views,
        clock: ctx.clock && typeof ctx.clock.now === "function" ? ctx.clock : { now },
        graph: ctx.graph || null,
        factionNames: readFactionNames(ctx.adapter, logger),
        getGovernor: () => ctx.governor || null,
        telemetry: ctx.telemetry || null,
        nowMs: typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now(),
        settings: {
          refreshMs: settings.factionOverviewRefreshMs,
          maxFactions: settings.factionOverviewMaxFactions,
          maxNotes: settings.factionOverviewMaxNotes,
          maxJobs: settings.factionOverviewMaxJobs,
          maxStations: settings.factionOverviewMaxStations,
          treasuryFullDay: settings.treasuryFullDayEnabled === true,
        },
      })]);
    }
    if (settings.galaxyEnabled === true && settings.systemCardEnabled === true) {
      builtins.push([SYSTEM_CARD_ID, buildSystemCardView({
        ctx,
        store: persistenceStore(ctx),
        clock: ctx.clock && typeof ctx.clock.now === "function" ? ctx.clock : { now },
        getGovernor: () => ctx.governor || null,
        telemetry: ctx.telemetry || null,
        nowMs: typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now(),
        factionNames: readFactionNames(ctx.adapter, logger),
        settings: {
          refreshMs: settings.systemCardRefreshMs,
          maxRows: settings.systemCardMaxRows,
          maxFleets: settings.systemCardMaxFleets,
          recentBattles: settings.systemCardRecentBattles,
          crewsMaxPilots: config.crews ? config.crews.observerMaxPilots : undefined,
          crewsMaxFleets: config.crews ? config.crews.maxFleetsPerPass : undefined,
        },
      })]);
    }
    if (settings.galaxyEnabled === true && settings.systemInteriorEnabled === true) {
      builtins.push([SYSTEM_INTERIOR_ID, buildSystemInteriorView({
        ctx,
        store: persistenceStore(ctx),
        clock: ctx.clock && typeof ctx.clock.now === "function" ? ctx.clock : { now },
        getGovernor: () => ctx.governor || null,
        telemetry: ctx.telemetry || null,
        nowMs: typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now(),
        factionNames: readFactionNames(ctx.adapter, logger),
        settings: {
          refreshMs: settings.systemInteriorRefreshMs,
          staticCacheSystems: settings.systemInteriorStaticCacheSystems,
          maxObjects: settings.systemInteriorMaxObjects,
          maxFleets: settings.systemInteriorMaxFleets,
          maxOperations: settings.systemInteriorMaxOperations,
          maxBattles: settings.systemInteriorMaxBattles,
          maxSites: settings.systemInteriorMaxSites,
        },
      })]);
    }
    if (settings.effectiveConfigEnabled === true) {
      builtins.push([EFFECTIVE_CONFIG_ID, buildEffectiveConfigView({
        ctx,
        schema: SCHEMA,
        store: () => persistenceStore(ctx),
        settings: {
          refreshMs: settings.effectiveConfigRefreshMs,
          originChars: settings.effectiveConfigOriginChars,
        },
      })]);
    }
    for (const [id, def] of builtins) {
      const r = views.registerView(id, def);
      if (r && r.ok) registered.push(r);
      else logger.log(`observer: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    }
    router = createRouter({ views, assets: read.assets, config: settings, modVersion: ctx.modVersion, now,
      telemetry: () => ctx.telemetry || null, governor: () => ctx.governor || null,
      getGovernor: () => ctx.governor || null });

    const countSafe = (name) => {
      try {
        if (ctx.telemetry) ctx.telemetry.count(name);
      } catch (_e) {
      }
    };
    const noteSafe = (url, at) => {
      try {
        const t = ctx.telemetry;
        if (t && typeof t.noteOp === "function") {
          t.noteOp("observer", String(url).slice(0, MAX_URL_LABEL), at, performance.now() - at);
        }
      } catch (_err) {
      }
    };
    const maxBodyBytes = config.modSettings && Number.isSafeInteger(config.modSettings.maxBodyBytes)
      ? config.modSettings.maxBodyBytes : 0;
    const routeOf = (url) => {
      try {
        const routes = ctx.httpRoutes;
        if (!routes || typeof routes.match !== "function") return null;
        const pathname = pathnameOf(url);
        return pathname === null ? null : routes.match(pathname);
      } catch (_err) {
        return null;
      }
    };
    const serveRoute = (route, req, res) => {
      const startAt = performance.now();
      countSafe("observer.requests");
      let done = false;
      const refuse = (status, reason, extra) => {
        done = true;
        const body = JSON.stringify({ ok: false, reason });
        try {
          res.writeHead(status, { ...BASE_HEADERS, "Content-Type": ROUTE_JSON_TYPE,
            "Content-Length": Buffer.byteLength(body), ...(extra || {}) });
          res.end(body);
        } catch (_err) {
          try {
            res.destroy();
          } catch (_e) {
          }
        }
      };
      try {
        for (const [name, value] of Object.entries(BASE_HEADERS)) res.setHeader(name, value);
        if (!isAllowedHost(req.headers && req.headers.host)) {
          refuse(403, "HOST_NOT_ALLOWED");
          return;
        }
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > maxBodyBytes) {
          refuse(413, "BODY_TOO_LARGE", { Connection: "close" });
          return;
        }
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
          if (done) return;
          size += chunk.length;
          if (size > maxBodyBytes) {
            refuse(413, "BODY_TOO_LARGE", { Connection: "close" });
            return;
          }
          chunks.push(chunk);
        });
        req.on("error", () => {
          done = true;
        });
        req.on("end", () => {
          if (done) return;
          done = true;
          const at = performance.now();
          try {
            route.handle(req, res, Buffer.concat(chunks));
          } catch (_err) {
            countSafe("observer.errors");
            if (res.headersSent) {
              try {
                res.destroy();
              } catch (_e) {
              }
            } else {
              refuse(500, "internal");
            }
          }
          noteSafe(req.url, at);
        });
      } catch (_err) {
        countSafe("observer.errors");
        if (!done) refuse(500, "internal");
      } finally {
        noteSafe(req.url, startAt);
      }
    };

    const httpApi = deps.httpApi || http;
    const server = httpApi.createServer((req, res) => {
      const route = routeOf(req.url);
      if (route) {
        serveRoute(route, req, res);
        return;
      }
      const requestAt = performance.now();
      let r;
      try {
        r = router.route({ method: req.method, url: req.url, host: req.headers.host });
      } catch (_err) {
        r = { status: 500, headers: INTERNAL_ERROR_HEADERS, body: "internal" };
        try {
          if (ctx.telemetry) ctx.telemetry.count("observer.errors");
        } catch (_e) {
        }
      }
      try {
        res.writeHead(r.status, { ...r.headers, "Content-Length": Buffer.byteLength(r.body) });
        res.end(r.body);
      } catch (_err) {
        try {
          res.destroy();
        } catch (_e) {
        }
      }
      try {
        const t = ctx.telemetry;
        if (t && typeof t.noteOp === "function") {
          t.noteOp("observer", String(req.url).slice(0, MAX_URL_LABEL), requestAt, performance.now() - requestAt);
        }
      } catch (_err) {
      }
    });
    server.requestTimeout = settings.requestTimeoutMs;
    server.headersTimeout = settings.requestTimeoutMs;
    server.keepAliveTimeout = settings.requestTimeoutMs;
    server.timeout = settings.requestTimeoutMs;
    server.maxConnections = settings.maxConnections;

    const where = `${settings.host}:${settings.port}`;
    function stop() {
      if (stopped) return;
      stopped = true;
      listening = null;
      try {
        server.close();
        if (typeof server.closeAllConnections === "function") server.closeAllConnections();
      } catch (_err) {
      }
      try {
        if (router && typeof router.stop === "function") router.stop();
      } catch (_err) {
      }
      unregisterViews();
    }

    server.on("error", (err) => {
      if (stopped) return;
      const code = (err && err.code) || messageOf(err);
      if (listening === null) {
        logger.log(`observer: failed - OBSERVER_LISTEN_FAILED (${code} ${where}) - the mod keeps running without `
          + "the observer");
        stop();
        try {
          fail("OBSERVER_LISTEN_FAILED", `${code} ${where}`);
        } catch (_err) {
        }
        return;
      }
      logger.log(`observer: error - ${code}`);
    });
    server.on("clientError", (_err, socket) => {
      try {
        socket.destroy();
      } catch (_e) {
      }
    });
    server.on("listening", () => {
      if (stopped) return;
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : settings.port;
      listening = { host: settings.host, port };
      const all = ALL_INTERFACES.includes(settings.host)
        ? " (all interfaces; Docker publishes it on 127.0.0.1 only)" : "";
      logger.log(`observer: listening http://${urlHost(settings.host)}:${port}/ `
        + `- open http://127.0.0.1:${port}/${all}`);
    });

    try {
      server.listen(settings.port, settings.host);
    } catch (err) {
      stop();
      return { ok: false, reason: "OBSERVER_START_FAILED", detail: `${messageOf(err)} ${where}` };
    }
    if (typeof server.unref === "function") server.unref();

    const observer = Object.freeze({
      stop,
      address: () => (listening ? { ...listening } : null),
      getStatus: () => ({ stopped, ...getObserverStats() }),
    });
    return { ok: true, observer };
  } catch (err) {
    unregisterViews();
    return { ok: false, reason: "OBSERVER_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { ASSET_FILES, startObserver };
