"use strict";

const { buildSystemCardView } = require("../observer/views/systemCard");
const { readFrontSnapshot } = require("../frontChat/snapshot");
const { formatFrontReply } = require("../frontChat/format");
const { LEN } = require("./wire");

const SOURCES = Object.freeze([["events", "events"], ["heavy", "heavyEvents"], ["salvage", "salvageAnomaly"],
  ["situations", "situations"], ["story", "gameMaster"]]);
const DISABLED_SUFFIX = "_DISABLED";
const NEWS_DISABLED = "NEWS_DISABLED";
const FRONT_LINE_BREAK = "\n";

function createNearby(deps) {
  const { settings, ctx, clock, storeOf, bump } = deps;
  const frontChatSettings = deps.frontChatSettings || {};
  const observerSettings = deps.observerSettings || {};
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const frontCache = new Map();
  let newsCache = null;
  let card = null;
  let cardStore = null;

  function readEvents(viewerSys, distances, now) {
    if (settings.eventsEnabled !== true) return null;
    if (viewerSys === null || !(distances instanceof Map)) {
      return { rows: [], refusals: ["nearby:NO_SYSTEM"], truncated: false, truncatedSources: 0, systemIds: new Set() };
    }
    const maxJumps = Math.min(settings.eventsNearbyJumps, settings.nearbyMaxJumps);
    const systemIds = new Set();
    for (const [id, jumps] of distances) if (jumps <= maxJumps) systemIds.add(id);
    const rows = [];
    const refusals = [];
    let truncatedSources = 0;
    for (const [name, key] of SOURCES) {
      const facade = ctx[key];
      if (!facade || typeof facade.listBoardRows !== "function") {
        bump("nearSourceOff");
        continue;
      }
      let r;
      try {
        r = facade.listBoardRows({ systemIds, limit: settings.eventsMaxRows, now });
      } catch (_err) {
        r = { ok: false, reason: "THREW" };
      }
      if (!r || r.ok !== true || !Array.isArray(r.rows)) {
        const reason = String((r && r.reason) || "NO_RESULT");
        if (reason.endsWith(DISABLED_SUFFIX)) {
          bump("nearSourceOff");
          continue;
        }
        bump("nearSourceRefused");
        refusals.push(`${name}:${reason}`);
        continue;
      }
      rows.push(...r.rows);
      if (r.truncated === true) truncatedSources += 1;
    }
    return { rows, refusals, truncated: truncatedSources > 0, truncatedSources, systemIds };
  }

  function cardView(store) {
    if (card && cardStore === store) return card;
    card = buildSystemCardView({ ctx, store, clock, getGovernor: () => ctx.governor || null,
      telemetry: deps.telemetry || null, nowMs: deps.nowMs, factionNames,
      settings: { refreshMs: observerSettings.systemCardRefreshMs, maxRows: frontChatSettings.maxRows,
        maxFleets: frontChatSettings.maxFleets, recentBattles: frontChatSettings.recentBattles } });
    cardStore = store;
    return card;
  }

  function readFront(viewerSys, now, graph) {
    if (settings.frontEnabled !== true) return null;
    if (viewerSys === null) return { ok: false, reason: "NO_SYSTEM" };
    const ttl = settings.frontCacheTtlMs;
    const hit = frontCache.get(viewerSys);
    if (ttl > 0 && hit && now >= hit.at && now - hit.at < ttl) {
      frontCache.delete(viewerSys);
      frontCache.set(viewerSys, hit);
      bump("frontCacheHits");
      return hit.value;
    }
    const store = storeOf();
    if (!store) {
      bump("frontRefused");
      return { ok: false, reason: "STORE_CLOSED" };
    }
    bump("frontReads");
    const snap = readFrontSnapshot({ card: cardView(store), store, ctx, graph, settings: frontChatSettings, now,
      names: factionNames }, viewerSys);
    if (!snap || snap.ok !== true) {
      bump("frontRefused");
      return { ok: false, reason: String((snap && snap.reason) || "NO_RESULT") };
    }
    const lines = formatFrontReply(snap.snapshot, { maxLines: settings.frontMaxLines,
      maxReplyChars: settings.frontMaxLines * LEN.frontLine, lineBreak: FRONT_LINE_BREAK })
      .slice(0, settings.frontMaxLines);
    const value = { ok: true, sys: viewerSys, lines };
    if (ttl > 0) {
      frontCache.delete(viewerSys);
      frontCache.set(viewerSys, { at: now, value });
      while (frontCache.size > settings.frontCacheSystems) frontCache.delete(frontCache.keys().next().value);
    }
    return value;
  }

  function readNews(now) {
    if (settings.newsEnabled !== true) return null;
    const ttl = settings.newsCacheTtlMs;
    if (ttl > 0 && newsCache && now >= newsCache.at && now - newsCache.at < ttl) {
      bump("newsCacheHits");
      return newsCache.value;
    }
    const news = ctx.news;
    if (!news || typeof news.latestHeadline !== "function") return null;
    bump("newsReads");
    let r;
    try {
      r = news.latestHeadline();
    } catch (_err) {
      r = { ok: false, reason: "THREW" };
    }
    let value;
    if (r && r.ok === true) value = { ok: true, edition: r.edition || null };
    else if (r && r.reason === NEWS_DISABLED) value = null;
    else {
      bump("newsRefused");
      return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
    }
    if (ttl > 0) newsCache = { at: now, value };
    return value;
  }

  function read(viewer, distances, now, graph) {
    const viewerSys = viewer && Number.isSafeInteger(viewer.systemId) && viewer.systemId > 0 ? viewer.systemId : null;
    const guard = (fn, fallback) => {
      try {
        return fn();
      } catch (_err) {
        return fallback;
      }
    };
    return {
      events: guard(() => readEvents(viewerSys, distances, now), { rows: [], refusals: ["nearby:FAILED"],
        truncated: false, truncatedSources: 0, systemIds: new Set() }),
      front: guard(() => readFront(viewerSys, now, graph), { ok: false, reason: "FAILED" }),
      news: guard(() => readNews(now), { ok: false, reason: "FAILED" }),
    };
  }

  function clear() {
    frontCache.clear();
    newsCache = null;
    card = null;
    cardStore = null;
  }

  return Object.freeze({ read, clear });
}

module.exports = { SOURCES, createNearby };
