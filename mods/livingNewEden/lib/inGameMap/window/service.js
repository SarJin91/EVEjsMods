"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createRateLimiter, WINDOW_MS } = require("../../frontChat/rateLimit");
const S = require("./schema");
const W = require("./wire");
const { LAYER_IDS } = require("./marks");
const { factionRgb } = require("./colors");
const { indexStatic, buildRegionScope, buildGalaxyScope, buildState } = require("./builder");
const { createSources, STATE_ID } = require("./sources");
const { createCorpMarks, mergeCorpMarks } = require("./corpMarks");

const CLIENT_SOURCE = path.join(__dirname, "..", "..", "..", "client", "mapProbe.py");
const MAP_SOURCE = path.join(__dirname, "..", "..", "..", "client", "map.py");
const HOOK_OK = Object.freeze(["HOOKED", "WRAPPED"]);
const UNAVAILABLE = "IN_GAME_MAP_UNAVAILABLE";
const MAX_DETAIL = 120;
const STATE = Object.freeze({ OFF: "off", ON: "on", STOPPED: "stopped" });
const STATIC_ID = "galaxy-static";
const MS_PER_S = 1000;
const MS_DECIMALS = 10;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function reportLimiter(settings) {
  const cooldownMs = Math.max(1, settings.reportMinIntervalMs);
  const maxTracked = Math.max(1, settings.windowMaxTrackedCharacters);
  return createRateLimiter({ cooldownMs, maxPerMinute: maxTracked * Math.ceil(WINDOW_MS / cooldownMs), maxTracked });
}

function mapLimiter(settings) {
  return createRateLimiter({ cooldownMs: settings.windowMinIntervalMs, maxPerMinute: settings.windowMaxReadsPerMinute,
    maxTracked: settings.windowMaxTrackedCharacters });
}

function createGetMap(deps) {
  const { settings, ctx, clock, bump } = deps;
  let limiter = mapLimiter(settings);
  const sources = createSources({ views: { getView: (id) => (ctx.views && typeof ctx.views.getView === "function"
    ? ctx.views.getView(id) : null) }, clock, stateMinRefreshMs: settings.windowStateMinRefreshMs });
  const cache = new Map();
  let indexMemo = null;
  const corpMarks = createCorpMarks({ getListeningPosts: () => ctx.listeningPosts || null, clock, bump,
    refreshMs: settings.windowCorpMarksRefreshMs, maxTracked: settings.windowMaxTrackedCharacters });
  const lpMaxMarkers = deps.lpMaxMarkers;
  const ui = Object.freeze({ pollMs: settings.windowPollMs, cacheRegions: settings.windowClientCacheRegions,
    maxLabels: settings.windowMaxLabels });

  function refuse(reason, retryMs) {
    if (reason === "RATE_LIMIT") bump("mapRateLimited");
    else if (reason === "BUSY") bump("mapBusy");
    else bump("mapRefused");
    return W.refusal(reason, retryMs);
  }

  function admitted() {
    const g = ctx.governor;
    return !g || typeof g.admits !== "function" || g.admits(S.MAP_WORK_CLASS) !== false;
  }

  function indexOf(read) {
    if (!indexMemo || indexMemo.key !== read.key) indexMemo = { key: read.key, index: indexStatic(read.data) };
    return indexMemo.index;
  }

  function observeBuild(ms) {
    if (!deps.telemetry || typeof deps.telemetry.observe !== "function") return;
    try {
      deps.telemetry.observe("inGameMap.window.mapBuildMs", Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  function remember(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    const max = Math.max(1, settings.windowCacheEntries);
    while (cache.size > max) cache.delete(cache.keys().next().value);
  }

  function withCorpMarks(req, scope, id, entry, st) {
    const corpId = req.corporationId;
    const lps = ctx.listeningPosts;
    if (!Number.isSafeInteger(corpId) || corpId <= 0 || !lps || typeof lps.markersFor !== "function") {
      return { view: entry, st };
    }
    const read = corpMarks.read(corpId, scope, id, scope === "galaxy" ? null : entry.static.ids);
    if (!read.ok || read.bySystem.size === 0) return { view: entry, st };
    const merged = mergeCorpMarks(entry, read.bySystem, { maxMarkers: settings.windowMaxMarkers,
      lpMaxMarkers: Number.isSafeInteger(lpMaxMarkers) ? lpMaxMarkers : settings.windowMaxMarkers });
    if (merged.added.length === 0) return { view: entry, st };
    const view = { static: entry.static, state: merged.state, trunc: { sys: entry.trunc.sys, mk: merged.truncMk } };
    return { view, st: W.keyOf([st, "lp", JSON.stringify(merged.added)]) };
  }

  function getMap(req) {
    try {
      if (settings.windowEnabled !== true || deps.isStopped()) return refuse("DISABLED");
      const args = req && req.badArgs !== true && Array.isArray(req.args) ? req.args : null;
      if (!args || args[0] !== S.PROTO || !S.SCOPES.includes(args[1]) || !Number.isSafeInteger(args[2])
        || typeof args[3] !== "string" || typeof args[4] !== "string") {
        return refuse("BAD_ARGS");
      }
      const characterId = req.characterId;
      if (!Number.isSafeInteger(characterId) || characterId <= 0) return refuse("NO_CHARACTER");
      const taken = limiter.take(characterId, clock.now());
      if (!taken.ok) return refuse("RATE_LIMIT", Number.isSafeInteger(taken.waitMs) ? taken.waitMs : 0);
      if (!admitted()) return refuse("BUSY", settings.windowMinIntervalMs);

      const staticRead = sources.read(STATIC_ID);
      if (!staticRead.ok) return refuse("NO_DATA");
      let stale = staticRead.stale ? 1 : 0;
      const index = indexOf(staticRead);
      let scope = args[1];
      let id = args[2];
      let ri = -1;
      if (scope === "here" && index.idIndex.get(req.systemId) === undefined) scope = "galaxy";
      if (scope === "here") {
        const gi = index.idIndex.get(req.systemId);
        ri = staticRead.data.systems.region[gi];
        scope = "region";
        id = staticRead.data.regions[ri][0];
      } else if (scope === "region") {
        ri = index.regionIndex.has(id) ? index.regionIndex.get(id) : -1;
        if (ri === -1) return refuse("NOT_ON_MAP");
      } else {
        id = 0;
      }
      const sk = W.keyOf(["v1", staticRead.key, scope, id, settings.windowNeighborJumps, settings.windowMaxSystems]);
      const miss = [];
      const stateRead = sources.read(STATE_ID);
      if (!stateRead.ok) miss.push(STATE_ID);
      else if (stateRead.stale) stale += 1;
      const layers = {};
      const layerKeys = [];
      for (const layerId of LAYER_IDS) {
        const r = sources.read(layerId);
        if (!r.ok) {
          miss.push(layerId);
          layers[layerId] = null;
          layerKeys.push("-");
          continue;
        }
        if (r.stale) stale += 1;
        layers[layerId] = r.data;
        layerKeys.push(r.key);
      }
      bump("mapStaleSources", stale);
      const st = W.keyOf(["v1", sk, stateRead.ok ? stateRead.key : "-", ...layerKeys, settings.windowMaxMarkers]);
      const cacheKey = `${scope}|${id}|${sk}|${st}`;
      let entry = cache.get(cacheKey);
      if (entry) {
        bump("mapCacheHits");
        remember(cacheKey, entry);
      } else {
        const t0 = deps.nowMs();
        const built = scope === "galaxy" ? buildGalaxyScope(index, { maxSystems: settings.windowMaxSystems })
          : buildRegionScope(index, ri, { neighborJumps: settings.windowNeighborJumps,
            maxSystems: settings.windowMaxSystems });
        const state = buildState(index, built, stateRead.ok ? stateRead.data : null,
          { layers, maxMarkers: settings.windowMaxMarkers, miss }, factionRgb);
        entry = { static: built.static, state: state.state, trunc: { sys: built.trunc, mk: state.truncMk },
          nodeOf: built.nodeOf };
        observeBuild(deps.nowMs() - t0);
        if (entry.trunc.sys > 0) bump("mapTruncSys");
        if (entry.trunc.mk > 0) bump("mapTruncMk");
        remember(cacheKey, entry);
      }
      const out = withCorpMarks(req, scope, id, entry, st);
      const at = Math.floor(clock.now() / MS_PER_S);
      const answer = W.toAnswer({ scope, id, at, sk, st: out.st, ui, ...out.view },
        { knownStatic: args[3], knownState: args[4] });
      bump("mapReads");
      if (answer.static) bump("mapStaticSent");
      if (answer.state) bump("mapStateSent");
      if (!answer.static && !answer.state) bump("mapUnchanged");
      return answer;
    } catch (err) {
      bump("errors");
      deps.log(`map GetMap failed - ${messageOf(err)}`);
      return W.refusal(UNAVAILABLE);
    }
  }

  function clear() {
    sources.clear();
    cache.clear();
    corpMarks.clear();
    indexMemo = null;
    limiter = mapLimiter(settings);
  }

  return { getMap, clear, status: () => ({ enabled: settings.windowEnabled === true, cached: cache.size }) };
}

function createMapWindow(deps) {
  const config = deps && deps.config;
  const settings = config && config.inGameMap;
  const probeWanted = Boolean(settings && settings.clientProbeEnabled === true);
  const windowWanted = Boolean(settings && settings.windowEnabled === true);
  if (!settings || settings.enabled !== true || (!probeWanted && !windowWanted)) {
    return { ok: false, reason: "disabled_by_config" };
  }
  const adapter = deps.adapter || null;
  if (!adapter || typeof adapter.registerMapClientService !== "function"
    || typeof adapter.publishClientPart !== "function" || typeof adapter.sendMapNotification !== "function") {
    return { ok: false, reason: "adapter_unavailable" };
  }
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(S.COUNTER_NAMES.map((name) => [name, 0]));
  const ready = new Map();
  let limiter = reportLimiter(settings);
  let state = STATE.OFF;

  function log(line) {
    try {
      if (typeof deps.log === "function") deps.log(line);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!S.COUNTER_NAMES.includes(name) || !(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`inGameMap.window.${name}`, n);
    } catch (_err) {
    }
  }

  const hook = (() => {
    try {
      return typeof adapter.boardHookState === "function" ? adapter.boardHookState() : { status: "ABSENT" };
    } catch (_err) {
      return { status: "ABSENT" };
    }
  })();
  let refusal = null;
  const parts = new Map();
  let payloadBytes = 0;
  const wantedParts = [
    ...(probeWanted ? [{ name: S.PART_PROBE, names: S.PROBE_NAMES, file: CLIENT_SOURCE, read: deps.readProbeSource }]
      : []),
    ...(windowWanted ? [{ name: S.PART_MAP, names: S.MAP_NAMES, file: MAP_SOURCE, read: deps.readMapSource }] : []),
  ];

  function publishPart(spec) {
    let source = null;
    try {
      source = typeof spec.read === "function" ? spec.read() : fs.readFileSync(spec.file, "utf8");
    } catch (err) {
      return `CLIENT_SOURCE:${messageOf(err)}`;
    }
    let published;
    try {
      published = adapter.publishClientPart(spec.name, { source: String(source),
        maxOwnBytes: settings.maxClientPayloadBytes, names: spec.names, log: { debug: (line) => log(line) } });
    } catch (err) {
      published = { ok: false, reason: "CLIENT_SOURCE", detail: messageOf(err) };
    }
    if (published && published.ok === true) {
      parts.set(spec.name, published.delivery);
      payloadBytes += Number.isSafeInteger(published.bytes) ? published.bytes : 0;
      return null;
    }
    return `${(published && published.reason) || "CLIENT_SOURCE"}`
      + `${published && published.detail ? `:${published.detail}` : ""}`;
  }

  if (!HOOK_OK.includes(hook.status)) {
    refusal = `hook:${hook.status}`;
    log(`${S.LOG_TAG}:UNAVAILABLE:${refusal}${hook.line ? ` ${hook.line}` : ""}`);
  } else {
    const refused = [];
    for (const spec of wantedParts) {
      const why = publishPart(spec);
      if (why === null) continue;
      refused.push(spec.name === S.PART_PROBE ? why : `${spec.name}:${why}`);
      log(`${S.LOG_TAG}:UNAVAILABLE:${refused[refused.length - 1]}`);
    }
    if (refused.length > 0) refusal = refused.join(",");
  }

  function markReady(characterId, partName) {
    const had = ready.get(characterId);
    const set = had ? had.parts : new Set();
    set.add(partName);
    ready.delete(characterId);
    ready.set(characterId, { parts: set, atMs: clock.now() });
    const max = Math.max(1, settings.windowMaxTrackedCharacters);
    while (ready.size > max) ready.delete(ready.keys().next().value);
  }

  function clearReady(characterId, partName) {
    const had = ready.get(characterId);
    if (!had) return;
    had.parts.delete(partName);
    if (had.parts.size === 0) ready.delete(characterId);
  }

  function partsOfItem(item) {
    const hit = Object.keys(S.ITEM_PREFIX).filter((name) => item.startsWith(S.ITEM_PREFIX[name]));
    return hit.length > 0 ? hit : Object.keys(S.ITEM_PREFIX);
  }

  function report(req) {
    try {
      const characterId = req && req.characterId;
      if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: false, reason: "NO_CHARACTER" };
      const args = Array.isArray(req.args) ? req.args : [];
      const proto = Number.isSafeInteger(args[0]) ? args[0] : 0;
      const build = Number.isSafeInteger(args[1]) ? args[1] : 0;
      const items = (Array.isArray(args[2]) ? args[2] : []).slice(0, S.MAX_REPORT_ITEMS)
        .map((item) => S.asciiOf(item, S.MAX_REPORT_ITEM_CHARS)).filter((t) => t !== "");
      if (items.includes(S.READY_ITEM)) markReady(characterId, S.PART_PROBE);
      if (items.includes(S.MAP_READY_ITEM)) markReady(characterId, S.PART_MAP);
      for (const t of items) {
        if (t.endsWith(S.UNSUPPORTED_BUILD)) for (const name of partsOfItem(t)) clearReady(characterId, name);
        const failed = S.MAP_BUILD_FAIL_STEPS.some((step) => t.startsWith(`m.ui.${step}=0:`));
        if (failed) clearReady(characterId, S.PART_MAP);
      }
      const taken = limiter.take(characterId, clock.now());
      if (!taken.ok) {
        bump("reportSuppressed");
        return { ok: false, reason: "RATE_LIMIT", retryMs: Number.isSafeInteger(taken.waitMs) ? taken.waitMs : 0 };
      }
      bump("reports");
      log(`${S.LOG_TAG}:PROBE ${characterId} proto=${proto} build=${build} ${items.join(" ")}`.trimEnd());
      return { ok: true };
    } catch (err) {
      bump("errors");
      log(`map report failed - ${messageOf(err)}`);
      return { ok: false, reason: UNAVAILABLE };
    }
  }

  const mapReader = createGetMap({ settings, ctx: deps.ctx || {}, clock, telemetry, bump, log,
    lpMaxMarkers: config.listeningPost ? config.listeningPost.mapMaxMarkers : undefined,
    nowMs: typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now(),
    isStopped: () => state === STATE.STOPPED });

  let service = null;
  let svcStatus = "off";
  try {
    const registered = adapter.registerMapClientService(deps.world || null, { name: S.SERVICE_NAME,
      handlers: { Report: report, GetMap: mapReader.getMap }, log: (line) => log(line), detachedReason: UNAVAILABLE });
    if (registered && registered.ok === true) {
      service = registered;
      svcStatus = "ok";
    } else {
      svcStatus = String((registered && registered.reason) || "NO_RESULT");
      log(`${S.LOG_TAG}:UNAVAILABLE:${svcStatus}${registered && registered.detail ? ` ${registered.detail}` : ""}`);
    }
  } catch (err) {
    svcStatus = "REGISTER_FAILED";
    log(`${S.LOG_TAG}:UNAVAILABLE:REGISTER_FAILED ${messageOf(err)}`);
  }
  if (!service && refusal === null) refusal = `svc:${svcStatus}`;
  if (service) for (const p of parts.values()) p.setReady(true);
  state = refusal === null ? STATE.ON : `refused:${refusal}`;

  const partSeen = new Map();
  function syncDelivery() {
    for (const [name, p] of parts) {
      try {
        const s = p.stats();
        const seen = partSeen.get(name) || { composed: 0, skipped: 0 };
        bump("composed", s.composed - seen.composed);
        bump("composeSkipped", s.skipped - seen.skipped);
        partSeen.set(name, { composed: s.composed, skipped: s.skipped });
      } catch (_err) {
      }
    }
  }

  function isReady(characterId, partName) {
    const p = parts.get(partName);
    const had = ready.get(characterId);
    if (state === STATE.STOPPED || !service || !p || !had || !had.parts.has(partName)) return false;
    try {
      return p.isReady() === true;
    } catch (_err) {
      return false;
    }
  }

  function open(characterId) {
    const refuse = (reason, detail) => {
      bump("openFallbackLink");
      if (reason === "NO_SESSION") bump("openNoSession");
      return detail ? { ok: false, reason, detail: String(detail).slice(0, MAX_DETAIL) } : { ok: false, reason };
    };
    if (state === STATE.STOPPED || !windowWanted) return refuse("OFF");
    try {
      syncDelivery();
      if (!isReady(characterId, S.PART_MAP)) return refuse("NOT_DELIVERED");
      const sent = adapter.sendMapNotification(characterId, S.NOTIFY_OPEN, { v: S.PROTO });
      if (sent && sent.ok === true) {
        bump("opens");
        return { ok: true };
      }
      return refuse(sent && sent.reason === "NO_SESSION" ? "NO_SESSION" : "SEND_FAILED", sent && sent.detail);
    } catch (err) {
      bump("errors");
      log(`map open failed - ${messageOf(err)}`);
      return refuse("SEND_FAILED", messageOf(err));
    }
  }

  function openProbe(characterId, spec) {
    if (state === STATE.STOPPED) return { ok: false, reason: "STOPPED" };
    try {
      syncDelivery();
      if (!isReady(characterId, S.PART_PROBE)) {
        bump("probeRefused");
        return state === STATE.ON ? { ok: false, reason: "NOT_DELIVERED" }
          : { ok: false, reason: "NOT_DELIVERED", detail: state.slice("refused:".length) };
      }
      const mode = spec && S.PROBE_MODES.includes(spec.mode) ? spec.mode : "nodes";
      const max = Math.max(1, settings.probeMaxNodes);
      const n = mode === "attrs" ? 0
        : Math.min(max, Math.max(1, Number.isSafeInteger(spec && spec.n) ? spec.n : settings.probeDefaultNodes));
      const sent = adapter.sendMapNotification(characterId, S.NOTIFY_PROBE, { v: S.PROTO, mode, n });
      if (sent && sent.ok === true) {
        bump("probesSent");
        return { ok: true };
      }
      bump("probeRefused");
      const reason = sent && sent.reason === "NO_SESSION" ? "NO_SESSION" : "SEND_FAILED";
      return sent && sent.detail ? { ok: false, reason, detail: String(sent.detail).slice(0, MAX_DETAIL) }
        : { ok: false, reason };
    } catch (err) {
      bump("errors");
      log(`map probe failed - ${messageOf(err)}`);
      return { ok: false, reason: "SEND_FAILED", detail: messageOf(err) };
    }
  }

  function status() {
    syncDelivery();
    let delivery = null;
    try {
      const probe = parts.get(S.PART_PROBE);
      const map = parts.get(S.PART_MAP);
      if (probe || map) delivery = { ...(probe ? probe.stats() : {}), ...(map ? { map: map.stats() } : {}) };
    } catch (_err) {
      delivery = null;
    }
    return { state, hook: hook.status, svc: svcStatus, payloadBytes, delivery, readyCharacters: ready.size,
      counters: { ...counters }, map: mapReader.status() };
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    for (const [name, p] of parts) {
      try {
        p.setReady(false);
        if (typeof adapter.withdrawClientPart === "function") adapter.withdrawClientPart(name, p);
      } catch (err) {
        log(`map ${name} part withdraw failed (${reason || "stop"}) - ${messageOf(err)}`);
      }
    }
    try {
      if (service) service.unregister();
    } catch (err) {
      log(`map service detach failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    ready.clear();
    limiter = reportLimiter(settings);
    mapReader.clear();
  }

  log(`map window=${state} hook:${hook.status} svc:${svcStatus} payload=${payloadBytes}`
    + ` probe=${probeWanted ? "on" : "off"} getMap=${windowWanted ? "on" : "off"}`);
  return { ok: true, window: Object.freeze({ status, openProbe, open, isReady, stop }) };
}

module.exports = { CLIENT_SOURCE, MAP_SOURCE, createMapWindow };
