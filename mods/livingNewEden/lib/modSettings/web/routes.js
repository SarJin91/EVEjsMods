"use strict";

const { isAllowedHost } = require("../../observer/router");
const { redactPaths } = require("../../observer/effectiveConfig");

const PREFIX = "/api/settings/";
const COOKIE_NAME = "lne_settings";
const COOKIE_ATTRS = "HttpOnly; SameSite=Strict; Path=/api/settings";
const CSRF_HEADER = "x-lne-csrf";
const JSON_TYPE = "application/json; charset=utf-8";
const CHANNEL = "web";
const MOD_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_QUERY_CHARS = 64;
const OFFSET_RE = /^[0-9]{1,9}$/;
const COUNTER_NAMES = Object.freeze(["sessions"]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function replacer(_key, value) {
  if (typeof value === "string") return redactPaths(value);
  return typeof value === "bigint" ? value.toString() : value;
}

function originAllowed(origin) {
  try {
    const url = new URL(String(origin));
    return (url.protocol === "http:" || url.protocol === "https:") && isAllowedHost(url.host);
  } catch (_err) {
    return false;
  }
}

function cookieOf(header, name) {
  if (typeof header !== "string") return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function headerOf(req, name) {
  const v = req && req.headers ? req.headers[name] : undefined;
  return Array.isArray(v) ? v[0] : v;
}

function createSettingsRoutes(deps) {
  const sessions = deps.sessions;
  const telemetry = deps.telemetry || null;
  const log = typeof deps.log === "function" ? deps.log : () => {};

  function count(name) {
    if (!COUNTER_NAMES.includes(name) || !telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`modSettings.${name}`, 1);
    } catch (_err) {
    }
  }

  function send(res, status, value, extra) {
    const body = JSON.stringify(value, replacer);
    res.writeHead(status, { "Content-Type": JSON_TYPE, "Content-Length": Buffer.byteLength(body), ...(extra || {}) });
    res.end(body);
  }

  function fail(res, status, reason, extra) {
    send(res, status, { ok: false, reason }, extra);
  }

  function bodyOf(body) {
    const text = body === null || body === undefined ? "" : String(body);
    if (text.trim() === "") return { ok: true, value: {} };
    try {
      const value = JSON.parse(text);
      return isPlainObject(value) ? { ok: true, value } : { ok: false };
    } catch (_err) {
      return { ok: false };
    }
  }

  function routeOf(rest) {
    if (rest === "session") return { name: "session", method: "POST" };
    if (rest === "logout") return { name: "logout", method: "POST" };
    if (rest === "mods") return { name: "list", method: "GET" };
    const parts = rest.split("/");
    if (parts[0] !== "mods" || parts.length < 2 || parts.length > 3) return null;
    let modId;
    try {
      modId = decodeURIComponent(parts[1]);
    } catch (_err) {
      return { bad: true };
    }
    if (!MOD_ID_RE.test(modId)) return { bad: true };
    if (parts.length === 2) return { name: "describe", method: "GET", modId };
    if (parts[2] === "set" || parts[2] === "reset") return { name: parts[2], method: "POST", modId };
    return null;
  }

  function queryOf(params) {
    const text = (name) => {
      const v = params.get(name);
      return typeof v === "string" ? v.slice(0, MAX_QUERY_CHARS) : undefined;
    };
    const offset = params.get("offset");
    return { group: text("group"), q: text("q"),
      offset: typeof offset === "string" && OFFSET_RE.test(offset) ? Number(offset) : undefined };
  }

  function actorOf(session) {
    return { characterId: session.actor.characterId, characterName: session.actor.characterName, channel: CHANNEL };
  }

  function handle(req, res, body) {
    let url;
    try {
      url = new URL(String(req.url), "http://localhost");
    } catch (_err) {
      fail(res, 400, "BAD_REQUEST");
      return;
    }
    const route = routeOf(url.pathname.slice(PREFIX.length));
    if (route === null) {
      fail(res, 404, "NOT_FOUND");
      return;
    }
    if (route.bad) {
      fail(res, 400, "BAD_MOD_ID");
      return;
    }
    if (req.method !== route.method) {
      fail(res, 405, "METHOD_NOT_ALLOWED", { Allow: route.method });
      return;
    }
    const isPost = route.method === "POST";
    const origin = headerOf(req, "origin");
    if (isPost && origin !== undefined && !originAllowed(origin)) {
      fail(res, 403, "ORIGIN_NOT_ALLOWED");
      return;
    }
    const service = deps.getModSettings();
    if (!service) {
      fail(res, 503, "UNAVAILABLE");
      return;
    }
    let parsed = { ok: true, value: {} };
    if (isPost) {
      parsed = bodyOf(body);
      if (!parsed.ok) {
        fail(res, 400, "BAD_JSON");
        return;
      }
    }
    if (route.name === "session") {
      const r = sessions.redeem(parsed.value.token);
      if (!r.ok) {
        fail(res, 401, r.reason);
        return;
      }
      count("sessions");
      log(`panel session opened by ${r.actor.characterName || "?"} (${r.actor.characterId || "?"})`);
      send(res, 200, { ok: true, csrf: r.csrf, character: r.actor },
        { "Set-Cookie": `${COOKIE_NAME}=${r.sid}; ${COOKIE_ATTRS}` });
      return;
    }
    const sid = cookieOf(headerOf(req, "cookie"), COOKIE_NAME);
    const session = sid === null ? null : sessions.sessionOf(sid);
    if (!session) {
      fail(res, 401, "NO_SESSION");
      return;
    }
    if (isPost && !sessions.csrfMatches(session, headerOf(req, CSRF_HEADER))) {
      fail(res, 403, "BAD_CSRF");
      return;
    }
    const v = parsed.value;
    switch (route.name) {
      case "logout":
        sessions.end(sid);
        send(res, 200, { ok: true }, { "Set-Cookie": `${COOKIE_NAME}=; ${COOKIE_ATTRS}; Max-Age=0` });
        return;
      case "list":
        send(res, 200, { ok: true, character: session.actor, mods: service.listMods() });
        return;
      case "describe":
        send(res, 200, service.describe(route.modId, queryOf(url.searchParams)));
        return;
      case "set":
        send(res, 200, service.set({ modId: route.modId, key: v.key, value: v.value,
          expectedRevision: v.expectedRevision, actor: actorOf(session) }));
        return;
      default:
        send(res, 200, service.reset({ modId: route.modId, key: v.key, expectedRevision: v.expectedRevision,
          actor: actorOf(session) }));
    }
  }

  return Object.freeze({ prefix: PREFIX, handle });
}

module.exports = { COUNTER_NAMES, PREFIX, COOKIE_NAME, CSRF_HEADER, originAllowed, cookieOf, createSettingsRoutes };
