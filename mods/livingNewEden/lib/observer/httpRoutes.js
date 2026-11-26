"use strict";

const PREFIX_RE = /^\/api\/[a-z][a-z0-9-]{0,31}\/$/;
const RESERVED_PREFIXES = Object.freeze(["/api/views/"]);

function createHttpRoutes() {
  const routes = new Map();

  function register(def) {
    if (!def || typeof def.handle !== "function") return { ok: false, reason: "ROUTE_DEF_INVALID" };
    const prefix = def.prefix;
    if (typeof prefix !== "string" || !PREFIX_RE.test(prefix) || RESERVED_PREFIXES.includes(prefix)) {
      return { ok: false, reason: "ROUTE_PREFIX_INVALID" };
    }
    if (routes.has(prefix)) return { ok: false, reason: "ROUTE_EXISTS" };
    const entry = Object.freeze({ prefix, handle: def.handle });
    routes.set(prefix, entry);
    return { ok: true, unregister: () => {
      if (routes.get(prefix) === entry) routes.delete(prefix);
    } };
  }

  function match(pathname) {
    if (typeof pathname !== "string") return null;
    for (const entry of routes.values()) {
      if (pathname.startsWith(entry.prefix)) return entry;
    }
    return null;
  }

  function list() {
    return [...routes.keys()].sort();
  }

  return Object.freeze({ register, match, list });
}

module.exports = { createHttpRoutes };
