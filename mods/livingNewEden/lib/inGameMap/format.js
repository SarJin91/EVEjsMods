"use strict";

const COMMAND = "!map";
const DEFAULT_HOST = "127.0.0.1";
const MS_PER_SECOND = 1000;
const ENTITIES = Object.freeze({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" });

function escapeChatText(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

function resolveObserverUrl(settings, observer) {
  if (!observer || observer.enabled !== true) return { ok: false, reason: "OBSERVER_OFF" };
  const configured = String((settings && settings.observerUrl) || "");
  const base = configured || `http://${DEFAULT_HOST}:${observer.port}/`;
  return { ok: true, url: base.endsWith("/") ? base : `${base}/` };
}

function formatMapReply(input) {
  const i = input || {};
  const id = Number.isSafeInteger(i.systemId) && i.systemId > 0 ? i.systemId : null;
  const href = `${String(i.url || "")}#map${id === null ? "" : `/${id}`}`;
  const name = id !== null && i.systemName ? ` - ${escapeChatText(i.systemName)}` : "";
  const lineBreak = String(i.lineBreak ?? "\n");
  return `LNE map: <a href="${href}">Living New Eden map${name}</a>${lineBreak}(${href} - opens in your browser)`;
}

function formatMapRefusal(reason, opts = {}) {
  switch (reason) {
    case "RATE_LIMITED":
      return `LNE map: wait ${Math.max(1, Math.ceil((Number(opts.waitMs) || 0) / MS_PER_SECOND))} s before the next `
        + COMMAND;
    case "OBSERVER_OFF":
      return "LNE map: the observer is off (observer.enabled)";
    default:
      return `LNE map unavailable (${String(opts.detail || reason)})`;
  }
}

function formatProbeReply(spec) {
  const s = spec || {};
  return `LNE map probe sent (${String(s.mode || "nodes")}, ${Number.isSafeInteger(s.n) ? s.n : 0})`;
}

function formatProbeRefusal(reason) {
  const r = String(reason || "UNAVAILABLE").replace(/[^A-Z0-9_:]/gi, "_").slice(0, 60);
  return `LNE map probe unavailable (${r})${r === "NOT_DELIVERED" ? " - relog after enabling" : ""}`;
}

const WINDOW_OPENED_REPLY = "LNE map window opened";

module.exports = { COMMAND, WINDOW_OPENED_REPLY, escapeChatText, resolveObserverUrl, formatMapReply, formatMapRefusal,
  formatProbeReply, formatProbeRefusal };
