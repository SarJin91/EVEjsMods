"use strict";

const MS_PER_MINUTE = 60000;
const BYTES_PER_MB = 1048576;
const DETAIL_MAX = 200;

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function dockedSystemOf(session) {
  if (session === null || typeof session !== "object") return 0;
  const structureID = toInt(session.structureid ?? session.structureID ?? session.structureId);
  const stationID = toInt(session.stationid ?? session.stationID ?? session.stationId);
  if (structureID <= 0 && stationID <= 0) return 0;
  const systemID = toInt(session.solarsystemid2 || session.solarsystemid);
  return systemID > 0 ? systemID : 0;
}

function isDocked(session) {
  if (session === null || typeof session !== "object") return false;
  return toInt(session.structureid ?? session.structureID ?? session.structureId) > 0 ||
    toInt(session.stationid ?? session.stationID ?? session.stationId) > 0;
}

function inSpaceSystemOf(session) {
  if (session === null || typeof session !== "object" || isDocked(session)) return 0;
  const space = session._space;
  if (space === null || typeof space !== "object") return 0;
  const systemID = toInt(space.systemID);
  return systemID > 0 ? systemID : 0;
}

function normalizeSystemIDs(value) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) out.push(n);
  }
  return out;
}

function emptyWindow() {
  return {
    sweeps: 0, sweepsWithPins: 0, pinnedMax: 0, dockedMax: 0, recentMax: 0, cappedMax: 0,
    released: 0, rssSkips: 0, computeMaxMs: 0, errors: 0,
  };
}

function hrNow() {
  return process.hrtime.bigint();
}

function createSceneRetention(options) {
  const config = options.config;
  const log = options.log;
  const rss = options.rss || (() => process.memoryUsage.rss());
  const priv = {
    sessionRegistry: null,
    vendorConfig: null,
    disabledReason: null,
    depth: 0,
    dockedSince: new Map(),
    lastSeen: null,
    prevPinned: new Set(),
    pinnedNow: [],
    window: emptyWindow(),
  };

  function depsReady() {
    return priv.sessionRegistry !== null && priv.vendorConfig !== null;
  }

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    if (reason === "error") priv.window.errors += 1;
    priv.dockedSince = new Map();
    priv.lastSeen = null;
    priv.prevPinned = new Set();
    priv.pinnedNow = [];
    const text = detail ? String(detail).slice(0, DETAIL_MAX) : "";
    log(`WARN sceneRetention disabled: ${reason}${text ? ` (${text})` : ""}`);
  }

  function setSessionRegistry(exportsValue) {
    if (priv.sessionRegistry) return true;
    if (exportsValue === null || typeof exportsValue !== "object" || typeof exportsValue.getSessions !== "function") return false;
    priv.sessionRegistry = exportsValue;
    return true;
  }

  function setVendorConfig(exportsValue) {
    if (priv.vendorConfig) return true;
    if (exportsValue === null || typeof exportsValue !== "object" ||
        !Object.prototype.hasOwnProperty.call(exportsValue, "saveConfig") ||
        typeof exportsValue.saveConfig !== "function") {
      return false;
    }
    priv.vendorConfig = exportsValue;
    return true;
  }

  function ordered(rankBySystem) {
    return [...rankBySystem].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0])).map(([systemID]) => systemID);
  }

  function computePins(runtime, nowMs, baseAlwaysOn) {
    if (!depsReady()) return { ok: false, reason: "NO_DEPS" };
    if (!runtime || typeof runtime.isSolarSystemSceneLoaded !== "function") return { ok: false, reason: "RUNTIME_DRIFT" };
    const sessions = priv.sessionRegistry.getSessions();
    const list = Array.isArray(sessions) ? sessions : [];
    const pinDocked = config.sceneRetentionPinDocked === true;
    const pinRecent = config.sceneRetentionPinRecent === true;
    const dockedMaxMs = config.sceneRetentionPinDockedMaxMinutes * MS_PER_MINUTE;
    const recentMs = config.sceneRetentionRecentMinutes * MS_PER_MINUTE;
    const perCharacter = Math.floor(config.sceneRetentionMaxPinnedPerCharacter);
    const maxTotal = Math.floor(config.sceneRetentionMaxPinnedTotal);

    if (pinRecent && !priv.lastSeen) priv.lastSeen = new Map();
    if (!pinRecent) priv.lastSeen = null;

    const seenDocked = new Map();
    const currentSpace = new Map();
    for (const session of list) {
      if (session === null || typeof session !== "object") continue;
      const charID = toInt(session.characterID || session.charid);
      if (charID <= 0) continue;
      const docked = dockedSystemOf(session);
      if (docked > 0) {
        const key = `${charID}:${docked}`;
        const since = priv.dockedSince.has(key) ? priv.dockedSince.get(key) : nowMs;
        seenDocked.set(key, { systemID: docked, since });
        continue;
      }
      const space = inSpaceSystemOf(session);
      if (space > 0 && pinRecent) {
        currentSpace.set(charID, space);
        let systems = priv.lastSeen.get(charID);
        if (!systems) {
          systems = new Map();
          priv.lastSeen.set(charID, systems);
        }
        systems.set(space, nowMs);
      }
    }
    priv.dockedSince = new Map([...seenDocked].map(([key, entry]) => [key, entry.since]));

    const dockedRank = new Map();
    if (pinDocked) {
      for (const { systemID, since } of seenDocked.values()) {
        if (dockedMaxMs > 0 && nowMs - since > dockedMaxMs) continue;
        if (!dockedRank.has(systemID) || since > dockedRank.get(systemID)) dockedRank.set(systemID, since);
      }
    }

    const recentRank = new Map();
    if (pinRecent) {
      for (const [charID, systems] of priv.lastSeen) {
        for (const [systemID, seen] of systems) if (nowMs - seen > recentMs) systems.delete(systemID);
        if (systems.size === 0) {
          priv.lastSeen.delete(charID);
          continue;
        }
        const newest = [...systems].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]));
        for (const [systemID] of newest.slice(perCharacter + 1)) systems.delete(systemID);
        const current = currentSpace.get(charID);
        let taken = 0;
        for (const [systemID, seen] of newest) {
          if (taken >= perCharacter) break;
          if (systemID === current || !systems.has(systemID)) continue;
          taken += 1;
          if (!recentRank.has(systemID) || seen > recentRank.get(systemID)) recentRank.set(systemID, seen);
        }
      }
    }

    const eligible = (systemID) => systemID > 0 && !baseAlwaysOn.has(systemID) && runtime.isSolarSystemSceneLoaded(systemID) === true;
    const dockedList = ordered(dockedRank).filter(eligible);
    const dockedSet = new Set(dockedList);
    const recentList = ordered(recentRank).filter((systemID) => !dockedSet.has(systemID) && eligible(systemID));
    const all = dockedList.concat(recentList);
    const capped = Math.max(0, all.length - maxTotal);
    let pinned = all.slice(0, maxTotal);
    let rssSkipped = false;
    const ceiling = config.sceneRetentionRssCeilingMb;
    if (ceiling > 0 && pinned.length > 0 && rss() / BYTES_PER_MB > ceiling) {
      pinned = [];
      rssSkipped = true;
    }
    return { ok: true, pinned, docked: dockedList.length, recent: recentList.length, capped, rssSkipped };
  }

  function recordStats(res, started) {
    const w = priv.window;
    const ms = Number(hrNow() - started) / 1e6;
    w.sweeps += 1;
    if (ms > w.computeMaxMs) w.computeMaxMs = ms;
    const pinned = res && res.ok ? res.pinned : [];
    if (res && res.ok) {
      if (res.docked > w.dockedMax) w.dockedMax = res.docked;
      if (res.recent > w.recentMax) w.recentMax = res.recent;
      if (res.capped > w.cappedMax) w.cappedMax = res.capped;
      if (res.rssSkipped) w.rssSkips += 1;
    }
    if (pinned.length > 0) w.sweepsWithPins += 1;
    if (pinned.length > w.pinnedMax) w.pinnedMax = pinned.length;
    const next = new Set(pinned);
    for (const systemID of priv.prevPinned) if (!next.has(systemID)) w.released += 1;
    priv.prevPinned = next;
    priv.pinnedNow = pinned.slice();
  }

  function wrapCollect(original) {
    const wrapped = function hotPathPerfSceneRetention(wallclockNowMs) {
      if (priv.disabledReason || priv.depth > 0 || !depsReady()) return original.apply(this, arguments);
      if (!this || typeof this.isSolarSystemSceneLoaded !== "function") {
        disable("drift", "isSolarSystemSceneLoaded");
        return original.apply(this, arguments);
      }
      const cfg = priv.vendorConfig;
      const started = hrNow();
      let res;
      try {
        const now = Number.isFinite(+wallclockNowMs) ? +wallclockNowMs : Date.now();
        const base = new Set(normalizeSystemIDs(cfg.alwaysOnSolarSystemIDs));
        res = computePins(this, now, base);
        recordStats(res, started);
      } catch (error) {
        disable("error", String(error && error.message || error));
        return original.apply(this, arguments);
      }
      if (!res.ok || res.pinned.length === 0) return original.apply(this, arguments);
      const had = Object.prototype.hasOwnProperty.call(cfg, "alwaysOnSolarSystemIDs");
      const before = cfg.alwaysOnSolarSystemIDs;
      priv.depth += 1;
      try {
        cfg.alwaysOnSolarSystemIDs = (Array.isArray(before) ? before : []).concat(res.pinned);
        return original.apply(this, arguments);
      } finally {
        priv.depth -= 1;
        if (had) cfg.alwaysOnSolarSystemIDs = before;
        else delete cfg.alwaysOnSolarSystemIDs;
      }
    };
    Object.defineProperty(wrapped, "__hotPathPerfRetention", { value: original });
    return wrapped;
  }

  function status() {
    return { disabledReason: priv.disabledReason, pinnedNow: priv.pinnedNow.slice(), depsReady: depsReady() };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window, depth: priv.depth, trackedDocked: priv.dockedSince.size,
      trackedRecentCharacters: priv.lastSeen ? priv.lastSeen.size : 0 };
  }

  function drainStatsLines() {
    const w = priv.window;
    const state = priv.disabledReason ? `disabled:${priv.disabledReason}` : (depsReady() ? "on" : "waiting");
    const line = `stats sceneRetention state=${state} sweeps=${w.sweeps} sweepsWithPins=${w.sweepsWithPins} ` +
      `pinnedMax=${w.pinnedMax} pinnedNow=${priv.pinnedNow.length} dockedMax=${w.dockedMax} recentMax=${w.recentMax} ` +
      `cappedMax=${w.cappedMax} released=${w.released} rssSkips=${w.rssSkips} computeMaxMs=${w.computeMaxMs.toFixed(1)} ` +
      `errors=${w.errors}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setSessionRegistry, setVendorConfig, wrapCollect, computePins, disable, status, statsSnapshot, drainStatsLines,
  };
}

module.exports = { createSceneRetention, dockedSystemOf, inSpaceSystemOf, normalizeSystemIDs };
