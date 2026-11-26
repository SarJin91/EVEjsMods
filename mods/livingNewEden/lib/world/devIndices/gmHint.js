"use strict";

const S = require("./schema");

const INDEX_LABEL = Object.freeze({ mil: "military", ind: "industry", trade: "trade" });
const NAME_RE = /^[\x20-\x7e]+$/;

function createDevHints(deps) {
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const buffer = [];

  function nameOf(systemId) {
    try {
      const n = typeof deps.systemNameOf === "function" ? deps.systemNameOf(systemId) : null;
      return typeof n === "string" && NAME_RE.test(n) ? n : null;
    } catch (_err) {
      return null;
    }
  }

  function lineOf(e) {
    const name = nameOf(e.systemId);
    if (!name) return null;
    const text = e.kind === "boom" ? `Boom: ${name} ${INDEX_LABEL[e.index]} ${e.level}`
      : `Collapse: ${name} ${INDEX_LABEL[e.index]} fell to ${e.level}`;
    return text.slice(0, S.GM_HINT_MAX_CHARS);
  }

  function push(events) {
    for (const e of Array.isArray(events) ? events : []) {
      if (!e || !INDEX_LABEL[e.index] || !Number.isSafeInteger(e.systemId)) continue;
      buffer.unshift(Object.freeze({ kind: e.kind === "boom" ? "boom" : "collapse", systemId: e.systemId,
        index: e.index, level: e.level }));
    }
    buffer.length = Math.min(buffer.length, S.GM_HINT_BUFFER);
  }

  function read() {
    try {
      bump("gm.reads");
      const lines = [];
      for (const e of buffer) {
        if (lines.length >= S.GM_HINT_MAX_LINES) break;
        const line = lineOf(e);
        if (line && !lines.includes(line)) lines.push(line);
      }
      return lines.length > 0 ? { lines } : null;
    } catch (_err) {
      return null;
    }
  }

  return Object.freeze({ push, read, size: () => buffer.length });
}

function registerDevHints(registry, hints) {
  if (!registry || typeof registry.registerHintSource !== "function") return { ok: false, reason: "NO_REGISTRY" };
  let r;
  try {
    r = registry.registerHintSource({ key: S.GM_HINT_KEY, read: () => hints.read() });
  } catch (_err) {
    return { ok: false, reason: "REGISTER_THREW" };
  }
  if (!r || r.ok !== true || typeof r.unregister !== "function") {
    return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
  }
  return { ok: true, unregister: () => r.unregister() };
}

module.exports = { createDevHints, registerDevHints, INDEX_LABEL };
