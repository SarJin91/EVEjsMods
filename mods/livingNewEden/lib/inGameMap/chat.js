"use strict";

const { createLiveRateLimiter } = require("../frontChat/rateLimit");
const { resolveObserverUrl, formatMapReply, formatMapRefusal, formatProbeReply, formatProbeRefusal,
  WINDOW_OPENED_REPLY } = require("./format");

const COMMAND_RE = /^!\s*(map|mapa)(?:\s[\s\S]*)?$/i;
const PROBE_RE = /^!\s*(?:map|mapa)\s+probe(?:\s+(\S+))?\s*$/i;
const LINK_RE = /^!\s*(?:map|mapa)\s+link\s*$/i;
const FAIL_REPLY = "LNE map unavailable (HANDLER_FAILED)";
const MAX_DETAIL = 120;

function matchMapCommand(text) {
  return COMMAND_RE.test(String(text));
}

function parseMapArgs(text, limits) {
  if (LINK_RE.test(String(text ?? "").trim())) return { cmd: "link" };
  const m = PROBE_RE.exec(String(text ?? "").trim());
  if (!m) return { cmd: "default" };
  const maxNodes = Math.max(1, Number.isSafeInteger(limits && limits.maxNodes) ? limits.maxNodes : 1);
  const clamp = (v) => Math.min(maxNodes, Math.max(1, v));
  const arg = m[1];
  if (arg === undefined) {
    return { cmd: "probe", mode: "nodes", n: clamp(Number.isSafeInteger(limits && limits.defaultNodes)
      ? limits.defaultNodes : 1) };
  }
  if (arg.toLowerCase() === "attrs") return { cmd: "probe", mode: "attrs", n: 0 };
  if (/^\d{1,15}$/.test(arg)) return { cmd: "probe", mode: "nodes", n: clamp(Number(arg)) };
  return { cmd: "default" };
}

function createMapChat(deps) {
  const { settings, graphOf, clock, isRunning, bump, log } = deps;
  const fc = deps.frontChatSettings || {};
  const liveSettings = typeof deps.liveSettings === "function" ? deps.liveSettings : () => settings;
  const liveVersion = typeof deps.liveVersion === "function" ? deps.liveVersion : () => 0;
  const limiter = createLiveRateLimiter(() => ({ cooldownMs: liveSettings().chatMinIntervalMs,
    maxPerMinute: fc.maxRepliesPerMinute, maxTracked: fc.maxTrackedCharacters }), liveVersion);
  const lineBreak = fc.lineBreak === "\\n" ? "\n" : String(fc.lineBreak ?? "\n");

  function systemNameOf(systemId) {
    if (systemId === null) return null;
    try {
      const graph = graphOf();
      const node = graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null;
      return node && node.name ? String(node.name) : null;
    } catch (_err) {
      return null;
    }
  }

  const probe = typeof deps.probe === "function" ? deps.probe : null;
  const open = typeof deps.open === "function" ? deps.open : null;

  function handle(rec, line) {
    try {
      if (!isRunning()) {
        bump("refused");
        return formatMapRefusal("UNAVAILABLE", { detail: "STOPPED" });
      }
      if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) {
        bump("refused");
        return formatMapRefusal("UNAVAILABLE", { detail: "NO_CHARACTER" });
      }
      const taken = limiter.take(rec.characterId, clock.now());
      if (!taken.ok) {
        bump("rateLimited");
        return formatMapRefusal("RATE_LIMITED", { waitMs: taken.waitMs });
      }
      if ((probe || open) && typeof line === "string") {
        const args = parseMapArgs(line, { defaultNodes: settings.probeDefaultNodes, maxNodes: settings.probeMaxNodes });
        if (open && args.cmd === "default") {
          const opened = open(rec.characterId);
          if (opened && opened.ok === true) {
            bump("replies");
            return WINDOW_OPENED_REPLY;
          }
        }
        if (probe && args.cmd === "probe") {
          const r = probe(rec.characterId, { mode: args.mode, n: args.n });
          if (r && r.ok === true) {
            bump("replies");
            return formatProbeReply(args);
          }
          bump("refused");
          return formatProbeRefusal((r && r.reason) || "NO_RESULT");
        }
      }
      const url = resolveObserverUrl(settings, deps.observerSettings);
      if (!url.ok) {
        bump("refused");
        return formatMapRefusal(url.reason);
      }
      const systemId = Number.isSafeInteger(rec.systemId) && rec.systemId > 0 ? rec.systemId : null;
      const text = formatMapReply({ url: url.url, systemId, systemName: systemNameOf(systemId), lineBreak });
      bump("replies");
      return text;
    } catch (err) {
      bump("errors");
      log(`chat reply failed - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
      return FAIL_REPLY;
    }
  }

  return Object.freeze({ handle });
}

module.exports = { COMMAND_RE, FAIL_REPLY, matchMapCommand, parseMapArgs, createMapChat };
