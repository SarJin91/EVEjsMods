"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");

const { MODULE_NAMES, resolveConfig } = require("../../config");
const { createViewRegistry } = require("../../lib/observer/views");
const { createRouter } = require("../../lib/observer/router");
const { buildStatusView, buildTelemetryView, buildJournalView } = require("../../lib/observer/builtinViews");
const { startObserver } = require("../../lib/observer");
const { createServiceRegistry } = require("../../lib/runtime/services");
const { buildSnapshot, deepFreeze } = require("../../lib/telemetry/snapshot");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const OBSERVER_DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config.observer;

function routerFor(views, extra = {}) {
  return createRouter({ views, assets: {}, config: { maxResponseBytes: 1000, refreshSeconds: 5 },
    modVersion: "t", now: () => 1234, telemetry: () => null, ...extra });
}

function get(router, url, host = "127.0.0.1:26410", method = "GET") {
  const r = router.route({ method, url, host });
  return { ...r, json: JSON.parse(String(r.body)) };
}

function httpGet(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path: urlPath, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers,
        body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
  });
}

async function waitFor(predicate, what) {
  for (let i = 0; i < 2000; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function plainConfig() {
  return { enabled: true, telemetry: { intervalSeconds: 5 }, testing: {},
    modules: Object.fromEntries(MODULE_NAMES.map((n) => [n, { enabled: true }])) };
}

module.exports = ({ test }) => {
  test("O1 views + router: register/unregister, 404/405/403/400, error isolation, async, cache, size", () => {
    const views = createViewRegistry();
    assert.strictEqual(views.registerView("Bad Id", { title: "x", getData: () => ({}) }).reason, "VIEW_ID_INVALID");
    assert.strictEqual(views.registerView("ok", { title: "x" }).reason, "VIEW_DEF_INVALID");
    const ok = views.registerView("ok", { title: "OK", order: 1, getData: () => ({ n: 1n }) });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(views.registerView("ok", { title: "again", getData: () => ({}) }).reason, "VIEW_EXISTS");
    let cachedCalls = 0;
    views.registerView("boom", { title: "Boom", getData: () => { throw new Error("view broke"); } });
    views.registerView("async", { title: "Async", getData: () => Promise.reject(new Error("never awaited")) });
    views.registerView("cached", { title: "Cached", cacheKey: () => 7,
      getData: () => { cachedCalls += 1; return {}; } });
    views.registerView("big", { title: "Big", getData: () => ({ s: "x".repeat(2000) }) });
    views.registerView("first", { title: "First", order: 0, getData: () => ({}) });
    const tmp = views.registerView("tmp", { title: "Tmp", getData: () => ({}) });
    tmp.unregister();
    assert.strictEqual(views.getView("tmp"), null);

    const router = routerFor(views);
    const list = get(router, "/api/views");
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.refreshMs, 5000);
    assert.deepStrictEqual(list.json.views.map((v) => v.id).slice(0, 2), ["first", "ok"]);
    assert.strictEqual(list.headers["Cache-Control"], "no-store");
    assert.ok(!Object.keys(list.headers).some((h) => h.toLowerCase().startsWith("access-control")), "no CORS");

    assert.strictEqual(get(router, "/nope").json.error.reason, "NOT_FOUND");
    assert.strictEqual(get(router, "/api/views/zzz").status, 404);
    const post = get(router, "/", "127.0.0.1", "POST");
    assert.strictEqual(post.status, 405);
    assert.strictEqual(post.headers.Allow, "GET");
    assert.strictEqual(get(router, "/api/views", "evil.example:26410").status, 403);
    assert.strictEqual(get(router, "/api/views", "").status, 403);
    assert.strictEqual(get(router, "/api/views/%E0%A4%A", "localhost").status, 400);
    const viaLocalhost = get(router, "/api/views/ok", "localhost:1234");
    assert.strictEqual(viaLocalhost.status, 200);
    assert.deepStrictEqual(viaLocalhost.json.data, { n: "1" }, "bigint as string");
    assert.strictEqual(get(router, "/api/views/ok", "[::1]:26410").status, 200);

    const boom = get(router, "/api/views/boom");
    assert.strictEqual(boom.status, 500);
    assert.strictEqual(boom.json.error.reason, "VIEW_FAILED");
    assert.strictEqual(boom.json.error.message, "view broke");
    assert.strictEqual(get(router, "/api/views/ok").status, 200, "the other view keeps working");
    assert.strictEqual(get(router, "/api/views/async").json.error.reason, "VIEW_ASYNC_UNSUPPORTED");
    const c1 = get(router, "/api/views/cached");
    const c2 = get(router, "/api/views/cached");
    assert.strictEqual(cachedCalls, 1);
    assert.deepStrictEqual([c1.json.cached, c2.json.cached], [false, true]);
    assert.strictEqual(get(router, "/api/views/big").json.error.reason, "VIEW_TOO_LARGE");
    const stats = router.getStats();
    assert.strictEqual(stats.viewErrors.boom, 1);
    assert.strictEqual(stats.lastError.id, "big");
  });

  test("O2 M1 views on fakes: refused/degraded/closed store, frozen snapshot untouched, journal tx", () => {
    const statusOf = (ctx) => buildStatusView({ ctx, config: OBSERVER_DEFAULTS, getObserverStats: () => ({}) })
      .getData({ nowMs: 0 });
    const refused = statusOf({ services: { getStatus: () => ({ refusal: "probe_core_drift", services: [] }) } });
    assert.strictEqual(refused.overall, "refused");

    const snap = deepFreeze({ seq: 3, capturedAtMs: 10, intervalMs: 10000, alarms: [],
      tick: { intervalMs: { max: 99 } },
      governor: { reason: "no_tick_samples", counts: { emergencySamples: 2, unplayableSamples: 0 } } });
    const before = JSON.parse(JSON.stringify(snap));
    const telemetry = { getSnapshot: () => snap };
    const running = { getStatus: () => ({ refusal: null, stopped: false,
      services: [{ name: "telemetry", state: "running" }] }) };
    const store = { isOpen: () => false, getState: () => "closed", getStateReason: () => "shutdown:SIGTERM",
      getSchemaVersion: () => 2, lockingMode: "exclusive", filePath: "/x/world.sqlite" };
    const degraded = statusOf({ services: running, telemetry, persistence: { ok: true, store } });
    assert.strictEqual(degraded.overall, "degraded");
    assert.deepStrictEqual(degraded.governor.warnings, ["no_tick_samples"]);
    assert.strictEqual(degraded.governor.perTick.emergencySamples, 2);
    assert.strictEqual(degraded.persistence.open, false, "ok:true is not enough");

    const tView = buildTelemetryView({ ctx: { telemetry } });
    const router = routerFor({ getView: () => ({ id: "telemetry", ...tView, cacheKey: tView.cacheKey }) },
      { config: { maxResponseBytes: 100000, refreshSeconds: 5 } });
    assert.strictEqual(get(router, "/api/views/telemetry").json.data.snapshot.seq, 3);
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.governor));
    assert.deepStrictEqual(snap, before);
    assert.deepStrictEqual(buildTelemetryView({ ctx: { telemetry: null } }).getData(),
      { available: false, reason: "telemetry_disabled" });

    const names = [];
    let inside = false;
    const calls = [];
    const fakeStore = (open) => ({
      isOpen: () => open, getStateReason: () => null,
      transaction(name, fn) {
        names.push(name);
        inside = true;
        try {
          return { ok: true, value: fn({ inTransaction: true }) };
        } finally {
          inside = false;
        }
      },
    });
    const journal = { listRecent(tx, opts) {
      calls.push({ inside, opts });
      return { ok: true, limit: opts.limit, entries: [{ journalId: 5, key: "k", kind: "APPLY", aggregateType: "a",
        aggregateId: "1", eventType: "e", state: "APPLIED", createdAt: 1, appliedAt: 2, error: null,
        payload: { text: "y".repeat(100) } }] };
    } };
    const jConfig = { journalLimit: 7, journalCacheMs: 2000, journalPayloadChars: 10 };
    const jView = buildJournalView({ ctx: { persistence: { ok: true, store: fakeStore(true), journal } },
      config: jConfig });
    const data = jView.getData({ nowMs: 0 });
    assert.deepStrictEqual(names, ["observer.journal"]);
    assert.deepStrictEqual(calls, [{ inside: true, opts: { limit: 7 } }]);
    assert.strictEqual(data.entries[0].payloadPreview.length, 10);
    assert.strictEqual(data.entries[0].payloadTruncated, true);
    assert.strictEqual(data.newestId, 5);
    assert.strictEqual(jView.cacheKey({ nowMs: 4100 }), 2);
    const closed = buildJournalView({ ctx: { persistence: { ok: true, store: fakeStore(false), journal } },
      config: jConfig }).getData({ nowMs: 0 });
    assert.strictEqual(closed.reason, "STORE_CLOSED");
    assert.strictEqual(names.length, 1, "no transaction on a closed store");
  });

  test("O3 server: port 0 serves JSON + CSP, EADDRINUSE -> fail, stop twice, refused after stop, unref", async () => {
    const keepAlive = setInterval(() => {}, 1000);
    const servers = [];
    const httpApi = { createServer(handler) {
      const server = http.createServer(handler);
      const entry = { server, unrefs: 0 };
      const unref = server.unref.bind(server);
      server.unref = () => { entry.unrefs += 1; return unref(); };
      servers.push(entry);
      return server;
    } };
    const observers = [];
    try {
      const lines = [];
      const fails = [];
      const logger = { log: (m) => lines.push(m) };
      const ctx = { modVersion: "t", state: {} };
      const config = { observer: { ...OBSERVER_DEFAULTS, host: "127.0.0.1", port: 0 } };
      const first = startObserver({ config, ctx, views: createViewRegistry(), logger, httpApi,
        fail: (...a) => fails.push(a) });
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      observers.push(first.observer);
      await waitFor(() => first.observer.address() !== null, "listening");
      const { port } = first.observer.address();
      assert.ok(lines.some((l) => l.startsWith(`observer: listening http://127.0.0.1:${port}/`)), lines.join("\n"));
      const res = await httpGet(port, "/api/views/status");
      assert.strictEqual(res.status, 200);
      assert.ok(res.headers["content-type"].startsWith("application/json"));
      assert.strictEqual(JSON.parse(res.body).ok, true);
      const page = await httpGet(port, "/");
      assert.strictEqual(page.status, 200);
      assert.ok(page.headers["content-security-policy"].includes("script-src 'self'"));
      assert.ok(page.body.includes("<script src=\"/app.js\">"));

      const second = startObserver({ config: { observer: { ...config.observer, port } }, ctx,
        views: createViewRegistry(), logger, httpApi, fail: (...a) => fails.push(a) });
      assert.strictEqual(second.ok, true);
      observers.push(second.observer);
      await waitFor(() => fails.length > 0, "listen failure");
      assert.strictEqual(fails[0][0], "OBSERVER_LISTEN_FAILED");
      assert.ok(fails[0][1].startsWith("EADDRINUSE"), fails[0][1]);
      assert.ok(lines.some((l) => l.includes("OBSERVER_LISTEN_FAILED (EADDRINUSE")), lines.join("\n"));

      first.observer.stop();
      first.observer.stop();
      await assert.rejects(httpGet(port, "/api/views"), /ECONNREFUSED|ECONNRESET/);
      const unrefs = servers.map((s) => s.unrefs);
      assert.ok(unrefs.length === 2 && unrefs.every((n) => n >= 1), JSON.stringify(unrefs));
      assert.strictEqual(startObserver({ config: { observer: { ...config.observer, enabled: false } } }).reason,
        "disabled_by_config");
      assert.strictEqual(startObserver({ config, ctx, views: createViewRegistry(), assetsDir: MOD_DIR }).reason,
        "OBSERVER_ASSETS_MISSING");
    } finally {
      for (const o of observers) o.stop();
      clearInterval(keepAlive);
    }
  });

  test("O4 registry: 4 services in order, deps.fail running -> failed, telemetry not orphaned", () => {
    const lines = [];
    const logger = { log: (m) => lines.push(m), logError: (m) => lines.push(m) };
    let telemetryStops = 0;
    let observerStops = 0;
    let fail = null;
    const starters = {
      startTelemetry: () => ({ ok: true, telemetry: { hooks: {}, stop: () => { telemetryStops += 1; },
        getStatus: () => { throw new Error("status boom"); }, getSnapshot: () => ({}) } }),
      startPersistence: () => ({ ok: true, worldSeed: 7, store: { close() {} } }),
      startGovernor: () => ({ ok: true, governor: { stop() {} } }),
      startGraph: () => ({ ok: true, graph: { stop() {} } }),
      startWorld: () => ({ ok: true, world: {} }),
      startPresence: () => ({ ok: true, presence: { stop() {} } }),
      startScheduler: () => ({ ok: true, scheduler: { stop() {},
        getStatus: () => ({ open: 0, recovered: { retried: 0, quarantined: 0 }, rebuildMs: 0 }) } }),
      startFleets: () => ({ ok: true, fleets: { stop() {}, countByState: () => ({ ok: true, active: 0 }) } }),
      startWrecks: () => ({ ok: true, wrecks: { stop() {}, countActive: () => ({ ok: true, count: 0 }) } }),
      startOccupation: () => ({ ok: true, occupation: { stop() {}, getStatus: () => ({ state: "ready" }) } }),
      startBattle: () => ({ ok: true, battle: { stop() {} } }),
      startStrategy: () => ({ ok: true, strategy: { stop() {} } }),
      startStations: () => ({ ok: true, stations: { stop() {}, getMode: () => "off" } }),
      startMining: () => ({ ok: true, mining: { stop() {}, getMode: () => "off" } }),
      startProduction: () => ({ ok: true, production: { stop() {}, getMode: () => "off" } }),
      startLogistics: () => ({ ok: true, logistics: { stop() {}, getMode: () => "off" } }),
      startConstruction: () => ({ ok: true, construction: { stop() {}, getMode: () => "off" } }),
      startTrade: () => ({ ok: true, trade: { stop() {}, getMode: () => "off" } }),
      startSiege: () => ({ ok: true, siege: { stop() {}, getMode: () => "off" } }),
      startSalvage: () => ({ ok: true, salvage: { stop() {} } }),
      startObserver: (deps) => {
        fail = deps.fail;
        assert.ok(deps.views && typeof deps.views.registerView === "function", "ctx.views before the observer");
        return { ok: true, observer: { stop: () => { observerStops += 1; } } };
      },
    };
    const adapter = { getProbeReport: () => ({}), getDisabledModules: () => ({}),
      registerShutdownHook: () => ({ ok: true, unregister() {} }) };
    const ctx = { config: plainConfig(), adapter, modDir: MOD_DIR };
    const registry = createServiceRegistry({ logger, starters, randomSeed: () => 1 });
    assert.strictEqual(registry.startAll(ctx).ok, true);
    assert.ok(lines.includes(
      "services: telemetry=running persistence=running governor=running graph=running world=running "
        + "presence=running scheduler=running fleets=running wormholes=disabled:disabled_by_config "
        + "wrecks=running occupation=running sovStructures=disabled:disabled_by_config "
        + "liberation=disabled:disabled_by_config "
        + "standings=disabled:disabled_by_config beltNavy=disabled:disabled_by_config battle=running strategy=running "
        + "stations=running mining=running production=running logistics=running construction=running trade=running "
        + "treasury=disabled:disabled_by_config siege=running "
        + "playerSiege=disabled:disabled_by_config "
        + "harvestRaid=disabled:disabled_by_config "
        + "sentries=disabled:disabled_by_config "
        + "hunt=disabled:disabled_by_config "
        + "lowsec=disabled:disabled_by_config "
        + "blockade=disabled:disabled_by_config "
        + "gridDefense=disabled:disabled_by_config "
        + "fortress=disabled:disabled_by_config "
        + "transit=disabled:disabled_by_config "
        + "listeningPost=disabled:disabled_by_config "
        + "expeditions=disabled:disabled_by_config "
        + "retention=disabled:disabled_by_config "
        + "backup=disabled:disabled_by_config "
        + "invasions=disabled:dependency_disabled:world|fleets|scheduler|strategy|occupation salvage=running "
        + "virtualCorps=failed:not_world_process sovProjection=disabled:dependency_disabled:virtualCorps "
        + "sovReconcile=disabled:dependency_disabled:virtualCorps "
        + "playerSov=disabled:dependency_disabled:virtualCorps "
        + "playerSovSiege=disabled:disabled_by_config "
        + "capsuleers=disabled:dependency_disabled:virtualCorps "
        + "structures=failed:STRUCTURES_START_FAILED sites=failed:SITES_START_FAILED events=failed:EVENTS_START_FAILED "
        + "salvageAnomaly=disabled:disabled_by_config "
        + "eventRewards=disabled:disabled_by_config "
        + "crews=disabled:disabled_by_config "
        + "playerHunt=disabled:dependency_disabled:persistence "
        + "fleetExposure=disabled:dependency_disabled:persistence "
        + "materialization=failed:MATERIALIZATION_START_FAILED "
        + "notices=disabled:disabled_by_config "
        + "escalations=disabled:disabled_by_config "
        + "frontJobs=disabled:disabled_by_config "
        + "battleAnnounce=disabled:dependency_disabled:notices "
        + "warContracts=disabled:disabled_by_config "
        + "frontChat=disabled:disabled_by_config "
        + "jobBoard=disabled:disabled_by_config "
        + "modsHelp=disabled:disabled_by_config "
        + "inGameMap=disabled:disabled_by_config "
        + "playerValue=disabled:disabled_by_config "
        + "modSettings=disabled:disabled_by_config "
        + "loyalty=running "
        + "fame=disabled:disabled_by_config "
        + "trigBridge=disabled:disabled_by_config "
        + "npcVoices=running "
        + "bountyHunters=disabled:disabled_by_config "
        + "localPilots=disabled:disabled_by_config "
        + "chatterAi=running "
        + "news=disabled:disabled_by_config "
        + "highsecLife=disabled:disabled_by_config "
        + "situations=disabled:disabled_by_config "
        + "freeCorps=disabled:disabled_by_config "
        + "miningEncounters=disabled:disabled_by_config "
        + "ambientRats=disabled:disabled_by_config "
        + "capsuleFx=disabled:disabled_by_config "
        + "officerSpawns=disabled:disabled_by_config "
        + "heavyEvents=disabled:dependency_disabled:sites "
        + "gameMaster=disabled:disabled_by_config "
        + "seasons=disabled:disabled_by_config "
        + "localContacts=disabled:disabled_by_config "
        + "shipAi=disabled:disabled_by_config "
        + "archaeology=disabled:disabled_by_config "
        + "abyssal=disabled:disabled_by_config "
        + "worldBosses=disabled:dependency_disabled:sites "
        + "killboard=disabled:disabled_by_config "
        + "devIndices=disabled:disabled_by_config "
        + "population=disabled:disabled_by_config "
        + "extraction=disabled:disabled_by_config "
        + "nativeIncursions=disabled:disabled_by_config "
        + "factionIncursions=disabled:disabled_by_config "
        + "alerts=disabled:disabled_by_config observer=running"),
      lines.join("\n"));
    assert.ok(lines.includes("telemetry: running (status line failed: status boom)"), lines.join("\n"));
    assert.ok(ctx.telemetry !== null && ctx.observer !== null);

    assert.deepStrictEqual(fail("OBSERVER_LISTEN_FAILED", "EADDRINUSE 0.0.0.0:26410"), { ok: true });
    const observer = registry.getStatus().services.find((s) => s.name === "observer");
    assert.deepStrictEqual([observer.state, observer.reason, observer.detail],
      ["failed", "OBSERVER_LISTEN_FAILED", "EADDRINUSE 0.0.0.0:26410"]);
    assert.strictEqual(ctx.observer, null);
    assert.strictEqual(observerStops, 1);
    assert.deepStrictEqual(fail("again"), { ok: false, reason: "not_running" });

    registry.stopAll("test");
    assert.strictEqual(telemetryStops, 1);
    assert.strictEqual(observerStops, 1, "a failed observer is not stopped again");
    assert.ok(lines.includes("services: stopped (test) chatterAi,npcVoices,loyalty,salvage,siege,trade,construction,logistics,production,mining,stations,strategy,battle,occupation,wrecks,fleets,scheduler,presence,world,graph,governor,persistence,telemetry"),
      lines.join("\n"));
  });

  test("O5 config observer.* + capture.writeErrors alarm only while failing", () => {
    const r = (env, settings) => resolveConfig({ modDir: MOD_DIR, env, settings });
    assert.strictEqual(OBSERVER_DEFAULTS.host, "127.0.0.1");
    assert.strictEqual(OBSERVER_DEFAULTS.port, 26410);
    assert.strictEqual(OBSERVER_DEFAULTS.enabled, true);
    assert.strictEqual(r({ EVEJS_LNE_OBSERVER_HOST: "0.0.0.0" }).config.observer.host, "0.0.0.0");
    const evil = r({ EVEJS_LNE_OBSERVER_HOST: "evil host" });
    assert.strictEqual(evil.config.observer.host, "127.0.0.1");
    const notHost = " is not an IP address or localhost - ignored";
    assert.ok(evil.warnings.includes(`EVEJS_LNE_OBSERVER_HOST="evil host"${notHost}`), evil.warnings.join("\n"));
    const fromJson = r({}, { observer: { host: "bad" } });
    assert.ok(fromJson.warnings.includes(`settings.json "observer.host"="bad"${notHost}`),
      fromJson.warnings.join("\n"));
    const empty = r({}, { observer: { host: "" } });
    assert.deepStrictEqual([empty.config.observer.host, empty.warnings], ["127.0.0.1", []], "empty = not set");
    assert.strictEqual(r({ EVEJS_LNE_OBSERVER_PORT: "70000" }).config.observer.port, 65535);
    assert.strictEqual(r({ EVEJS_LNE_OBSERVER_ENABLED: "0" }).config.observer.enabled, false);

    const state = (snapshotWrite) => ({
      seq: 1, capturedAtMs: 0, startedAtMs: 0, intervalMs: 1000, histogramSamples: 32, status: { snapshotWrite },
      process: {}, metrics: { counters: {}, gauges: {}, histograms: {} },
      tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
      gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 3, lastWriteError: "", path: null },
    });
    const ok = buildSnapshot(state("ok"));
    const failing = buildSnapshot(state("failing"));
    assert.strictEqual(ok.alarms.some((a) => a.id === "capture.writeErrors"), false);
    assert.strictEqual(failing.alarms.some((a) => a.id === "capture.writeErrors"), true);
    assert.deepStrictEqual([ok.capture.writeErrors, failing.capture.writeErrors], [3, 3]);
    assert.deepStrictEqual(ok.channels.observer, {});
  });

  test("O6 mark shape hexagon: hexagon is a valid mark shape, unknown -> ring", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const pure = sandbox.window.LneGalaxy._pure;
    assert.strictEqual(pure.markShape("hexagon"), "hexagon", "hexagon accepted");
    assert.strictEqual(pure.markShape("ring"), "ring", "ring accepted");
    assert.strictEqual(pure.markShape("triangle"), "triangle", "triangle accepted");
    assert.strictEqual(pure.markShape("square"), "square", "square accepted");
    assert.strictEqual(pure.markShape("versus"), "versus", "versus accepted");
    assert.strictEqual(pure.markShape("diamond"), "diamond", "diamond accepted");
    assert.strictEqual(pure.markShape("diamond2"), "diamond2", "diamond2 accepted");
    assert.strictEqual(pure.markShape("pip"), "pip", "pip accepted (layer-capsuleers)");
    assert.strictEqual(pure.markShape("bogus"), "ring", "unknown shape falls back to ring");
    assert.strictEqual(pure.markShape(null), "ring", "null shape falls back to ring");
    assert.strictEqual(pure.markShape(undefined), "ring", "undefined shape falls back to ring");
  });

  test("O6-LP layer-listening-posts: registers as a marks layer order 22, item shape, legend shapes known", () => {
    const { buildListeningPostsLayer, LAYER_ID } = require("../../lib/listeningPosts/view");
    const queries = [];
    const store = { isOpen: () => true, transaction: (name, fn) => ({ ok: true, value: fn({ name }) }) };
    const repo = { countBySystemSinceInTx: (db, q) => {
      queries.push([db.name, q]);
      return { ok: true, counts: new Map([[10, 3]]) };
    } };
    const posts = [{ systemId: 20, ownerCorpId: 8, armed: false }, { systemId: 10, ownerCorpId: 7, armed: true },
      { systemId: 10, ownerCorpId: 9, armed: false }];
    const def = buildListeningPostsLayer({ store, repo, getPosts: () => posts, clock: { now: () => 7200000 },
      settings: { mapWindowMs: 3600000, maxSystems: 200, refreshMs: 60000 } });
    const views = createViewRegistry();
    assert.strictEqual(views.registerView(LAYER_ID, def).ok, true);
    assert.deepStrictEqual([LAYER_ID, def.listed, def.mapLayer, def.cacheKey()],
      ["layer-listening-posts", false, { kind: "marks", order: 22 }, "k120"]);
    const data = def.getData();
    assert.deepStrictEqual(queries, [["observer.listeningPosts", { systemIds: [10, 20], since: 3600000 }]]);
    assert.deepStrictEqual(data.items, [
      [10, "post", "3", ["corp 7 armed", "corp 9 arming", "sightings 3 in 60 min"], null],
      [20, "post-arming", "0", ["corp 8 arming", "sightings 0 in 60 min"], null]]);
    assert.deepStrictEqual([data.available, data.note], [true, "3 post(s) in 2 system(s)"]);
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    const pure = sandbox.window.LneGalaxy._pure;
    assert.deepStrictEqual(data.legend.map((l) => [l[0], pure.markShape(l[3])]),
      [["post", "triangle"], ["post-arming", "triangle"]]);
  });
};
