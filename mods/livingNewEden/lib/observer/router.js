"use strict";

const { createStaleOnHold, isHold } = require("./staleOnHold");
const { createForcedRefreshLimiter } = require("./forcedRefresh");
const { redactPaths } = require("./effectiveConfig");

const MOD_ID = "livingNewEden";
const ALLOWED_HOSTS = Object.freeze(["127.0.0.1", "localhost", "[::1]"]);
const MAX_ERROR_MESSAGE_CHARS = 200;
const VIEW_PATH_PREFIX = "/api/views/";
const JSON_TYPE = "application/json; charset=utf-8";
const PARAM_VALUE_RE = /^[1-9][0-9]{0,15}$/;
const DEFAULT_PARAM_SLOTS = 1;

const BASE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
});
const HTML_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function bigintReplacer(_key, value) {
  if (typeof value === "string") return redactPaths(value);
  return typeof value === "bigint" ? value.toString() : value;
}

function hostName(header) {
  if (typeof header !== "string" || header === "") return "";
  const text = header.trim().toLowerCase();
  if (text.startsWith("[")) {
    const end = text.indexOf("]");
    return end === -1 ? "" : text.slice(0, end + 1);
  }
  const colon = text.lastIndexOf(":");
  return colon === -1 ? text : text.slice(0, colon);
}

function isAllowedHost(header) {
  return ALLOWED_HOSTS.includes(hostName(header));
}

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && typeof value.then === "function";
}

function createRouter(deps) {
  const views = deps.views;
  const assets = deps.assets || {};
  const maxResponseBytes = deps.config.maxResponseBytes;
  const refreshMs = deps.config.refreshSeconds * 1000;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const telemetry = typeof deps.telemetry === "function" ? deps.telemetry : () => null;
  const governor = typeof deps.governor === "function" ? deps.governor : () => null;
  const cache = new Map();
  const lastGood = createStaleOnHold();
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const forced = createForcedRefreshLimiter({ maxStaleMs: deps.config.maxStaleMs,
    maxPerMinute: deps.config.maxForcedRefreshesPerMinute });
  const maxParamSlots = Number.isSafeInteger(deps.config.systemCardCacheSlots) && deps.config.systemCardCacheSlots >= 1
    ? deps.config.systemCardCacheSlots : DEFAULT_PARAM_SLOTS;
  const paramSlots = new Set();
  const stats = { requests: 0, byStatus: {}, viewErrors: {}, lastError: null };
  let probeHandle = null;
  try {
    const t = telemetry();
    if (t && typeof t.registerMemoryProbe === "function") {
      const r = t.registerMemoryProbe("observer.viewCache", () => {
        let chars = 0;
        for (const entry of cache.values()) chars += typeof entry.json === "string" ? entry.json.length : 0;
        return { entries: cache.size, approxBytes: chars };
      });
      if (r && r.ok === true) probeHandle = r;
    }
  } catch (_err) {
  }

  function stop() {
    const h = probeHandle;
    probeHandle = null;
    if (h === null) return;
    try {
      h.unregister();
    } catch (_err) {
    }
  }

  function count(name) {
    try {
      const t = telemetry();
      if (t && typeof t.count === "function") t.count(name);
    } catch (_err) {
    }
  }

  function governorStatus() {
    try {
      const g = governor();
      return g && typeof g.getStatus === "function" ? g.getStatus() : null;
    } catch (_err) {
      return null;
    }
  }

  function respond(status, body, contentType, extra) {
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    if (status >= 500) count("observer.errors");
    return { status, headers: { ...BASE_HEADERS, "Content-Type": contentType, ...(extra || {}) }, body };
  }

  function json(status, value, extra) {
    return respond(status, JSON.stringify(value, bigintReplacer), JSON_TYPE, extra);
  }

  function error(status, reason, extra) {
    return json(status, { ok: false, error: { reason } }, extra);
  }

  function viewError(id, reason, message) {
    stats.viewErrors[id] = (stats.viewErrors[id] || 0) + 1;
    const text = String(message || reason).slice(0, MAX_ERROR_MESSAGE_CHARS);
    stats.lastError = { id, reason, message: text, atMs: now() };
    return json(500, { ok: false, id, error: { reason, message: text } });
  }

  function touchSlot(slot) {
    paramSlots.delete(slot);
    paramSlots.add(slot);
    while (paramSlots.size > maxParamSlots) {
      const oldest = paramSlots.values().next().value;
      paramSlots.delete(oldest);
      cache.delete(oldest);
      lastGood.forget(oldest);
      forced.forget(oldest);
    }
  }

  function forceRefresh(slot, view, req, nowMs) {
    if (!forced.enabled) return { ok: false };
    if (!forced.check(slot, lastGood.lastAtMs(slot, view.getData), nowMs).ok) return { ok: false };
    let governor = null;
    try {
      governor = getGovernor();
    } catch (_err) {
      governor = null;
    }
    if (!governor || typeof governor.runAdmitted !== "function") return { ok: false };
    const r = governor.runAdmitted(() => {
      forced.commit(slot, nowMs);
      count("observer.staleForcedRefreshes");
      return view.getData(req);
    });
    return r && r.ok === true ? { ok: true, value: r.value } : { ok: false };
  }

  function renderView(id, query) {
    const view = views.getView(id);
    if (!view) {
      lastGood.forget(id);
      forced.forget(id);
      return error(404, "VIEW_NOT_FOUND");
    }
    const nowMs = now();
    let slot = id;
    let req = Object.freeze({ nowMs, query });
    let paramField = "";
    if (view.param) {
      const raw = query.get(view.param);
      if (raw === null || !PARAM_VALUE_RE.test(raw) || !Number.isSafeInteger(Number(raw))) {
        return error(400, "BAD_PARAM");
      }
      slot = `${id}?${raw}`;
      req = Object.freeze({ nowMs, param: Number(raw), query });
      paramField = `"param":${raw},`;
      if (!view.optParams) touchSlot(slot);
    }
    let paramsField = "";
    if (view.optParams) {
      const params = {};
      const pairs = [];
      if (view.param) {
        params[view.param] = req.param;
        pairs.push(`${view.param}=${req.param}`);
      }
      for (const name of view.optParams) {
        const raw = query.get(name);
        if (raw === null) continue;
        if (!PARAM_VALUE_RE.test(raw) || !Number.isSafeInteger(Number(raw))) return error(400, "BAD_PARAM");
        params[name] = Number(raw);
        pairs.push(`${name}=${raw}`);
      }
      slot = pairs.length === 0 ? id : `${id}?${pairs.join("&")}`;
      req = Object.freeze({ ...req, params: Object.freeze(params) });
      paramsField = `"params":${JSON.stringify(params)},`;
      if (slot !== id) touchSlot(slot);
    }
    let key = null;
    let dataJson;
    let cached = false;
    let stale = false;
    try {
      if (view.cacheKey) {
        const k = view.cacheKey(req);
        key = k === undefined ? null : k;
      }
      const hit = cache.get(slot);
      if (key !== null && hit && hit.key === key && hit.getData === view.getData) {
        dataJson = hit.json;
        cached = true;
        lastGood.touch(slot, view.getData, dataJson, nowMs);
      } else {
        let data = view.getData(req);
        if (isHold(data)) {
          const f = forceRefresh(slot, view, req, nowMs);
          if (f.ok) data = f.value;
        }
        if (isThenable(data)) {
          try {
            data.then(undefined, noop);
          } catch (_err) {
          }
          return viewError(id, "VIEW_ASYNC_UNSUPPORTED", "getData must be synchronous");
        }
        const staleJson = isHold(data)
          ? lastGood.serve(slot, view.getData, data, nowMs, governorStatus()) : null;
        if (staleJson !== null && Buffer.byteLength(staleJson) <= maxResponseBytes) {
          cache.delete(slot);
          stale = true;
          dataJson = staleJson;
        } else {
          try {
            dataJson = JSON.stringify(data === undefined ? null : data, bigintReplacer);
          } catch (err) {
            return viewError(id, "VIEW_NOT_SERIALIZABLE", messageOf(err));
          }
          if (Buffer.byteLength(dataJson) > maxResponseBytes) {
            return viewError(id, "VIEW_TOO_LARGE", `data over ${maxResponseBytes} bytes`);
          }
          lastGood.remember(slot, view.getData, data, dataJson, nowMs);
          if (key !== null) cache.set(slot, { key, json: dataJson, getData: view.getData });
          else cache.delete(slot);
        }
      }
    } catch (err) {
      return viewError(id, "VIEW_FAILED", messageOf(err));
    }
    const body = `{"ok":true,"id":${JSON.stringify(id)},"title":${JSON.stringify(view.title)},`
      + `"generatedAtMs":${JSON.stringify(nowMs)},"cached":${cached},"stale":${stale},${paramField}${paramsField}"data":${dataJson}}`;
    return respond(200, body, JSON_TYPE);
  }

  function route(req) {
    stats.requests += 1;
    count("observer.requests");
    if (!isAllowedHost(req && req.host)) return error(403, "HOST_NOT_ALLOWED");
    if (req.method !== "GET") return error(405, "METHOD_NOT_ALLOWED", { Allow: "GET" });
    let url;
    try {
      url = new URL(String(req.url), "http://localhost");
    } catch (_err) {
      return error(400, "BAD_REQUEST");
    }
    const { pathname } = url;
    if (Object.prototype.hasOwnProperty.call(assets, pathname)) {
      const asset = assets[pathname];
      const extra = asset.contentType.startsWith("text/html") ? { "Content-Security-Policy": HTML_CSP } : null;
      return respond(200, asset.body, asset.contentType, extra);
    }
    if (pathname === "/api/views") {
      return json(200, { ok: true, mod: MOD_ID, version: deps.modVersion || null, refreshMs,
        views: views.listViews() });
    }
    if (pathname.startsWith(VIEW_PATH_PREFIX)) {
      let id;
      try {
        id = decodeURIComponent(pathname.slice(VIEW_PATH_PREFIX.length));
      } catch (_err) {
        return error(400, "BAD_REQUEST");
      }
      return renderView(id, url.searchParams);
    }
    return error(404, "NOT_FOUND");
  }

  function getStats() {
    return {
      requests: stats.requests,
      byStatus: { ...stats.byStatus },
      viewErrors: { ...stats.viewErrors },
      lastError: stats.lastError ? { ...stats.lastError } : null,
    };
  }

  return Object.freeze({ route, getStats, stop });
}

module.exports = { ALLOWED_HOSTS, BASE_HEADERS, HTML_CSP, hostName, isAllowedHost, createRouter };
