"use strict";

const { DeadlineQueue } = require("../../scheduler/deadlineQueue");
const { createPoller } = require("../../presence/poller");
const { classifyEntries } = require("./summary");
const { buildScanReading } = require("./seen");
const { sanitizeGameText } = require("../context");
const { UNKNOWN } = require("../../names/fallback");

const WORK_CLASS = "MAINTENANCE";
const KEY_SUFFIX = "dscan";
const MAX_NAME_CHARS = 60;
const COUNTER_NAMES = Object.freeze(["passes", "scans", "refused", "failed", "backoff", "budgetCut", "playersCapped",
  "newObjects", "offered", "skippedGovernor"]);
const STATE_REASONS = Object.freeze(["DOCKED", "IN_WARP", "NO_SHIP", "NO_SESSION"]);
const ABYSSAL = "ABYSSAL_BLOCKED";

function noop() {}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);
const keyOf = (playerId) => `${playerId}:${KEY_SUFFIX}`;

function createDscanWatch(deps) {
  const d = deps;
  const S = d.S;
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const perfNow = typeof d.perfNow === "function" ? d.perfNow : () => d.nowMs();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const enabled = S.dscanAutoEnabled === true && S.proactiveEnabled === true && S.calloutEnabled === true;
  const queue = new DeadlineQueue();
  const members = new Map();
  const seen = new Map();
  const dueOf = new Map();
  let poller = null;
  let stopped = false;
  let msMax = 0;
  let msSum = 0;
  let lagMsMax = 0;
  let seamFailLogged = false;

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const governorAdmits = () => {
    try {
      const g = typeof d.getGovernor === "function" ? d.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  };
  const call = (name, ...args) => {
    try {
      return typeof d.toolDeps[name] === "function" ? d.toolDeps[name](...args) : null;
    } catch (_err) {
      return null;
    }
  };
  const factionName = (factionId) => {
    if (!isId(factionId)) return null;
    const name = sanitizeGameText(call("factionName", factionId), MAX_NAME_CHARS);
    return name !== "" && name !== UNKNOWN.faction ? name : null;
  };

  function drop(playerId) {
    queue.remove(keyOf(playerId));
    members.delete(playerId);
    seen.delete(playerId);
    dueOf.delete(playerId);
  }

  function schedule(playerId, at) {
    queue.schedule(keyOf(playerId), at, { playerId });
    dueOf.set(playerId, at);
  }

  function onlinePlayers() {
    const res = typeof d.readPresence === "function" ? d.readPresence() : null;
    const out = new Map();
    for (const rec of res && res.ok && Array.isArray(res.characters) ? res.characters : []) {
      const id = rec ? rec.characterId : null;
      if (!isId(id) || out.has(id) || !isId(rec.systemId) || !d.isWatched(id) || !d.isAllowed(id)
        || !d.isDscanAllowed(id)) continue;
      out.set(id, { systemId: rec.systemId, state: rec.state });
    }
    return out;
  }

  function contextOf(playerId, r, now) {
    const ids = [];
    const uniq = new Set();
    const pilots = r.entries.filter((x) => x && x.isPlayer === true).slice(0, S.dscanMaxPilotsChecked);
    for (const e of pilots) {
      for (const id of [e.characterId, e.corporationId, e.allianceId]) {
        if (isId(id) && !uniq.has(id)) {
          uniq.add(id);
          ids.push(id);
        }
      }
    }
    let contacts = new Map();
    if (ids.length > 0) {
      const c = call("contactStandings", playerId, ids);
      contacts = c && c.ok && c.standings instanceof Map ? c.standings : null;
    }
    const own = r.own || {};
    const pirates = call("pirates");
    const invaders = call("invaderFactions", now);
    const standings = new Map();
    return { pirates: pirates instanceof Set ? pirates : null, invaders: invaders instanceof Set ? invaders : null,
      standing: (factionId) => {
        if (standings.has(factionId)) return standings.get(factionId);
        const v = call("standing", playerId, factionId);
        const out = typeof v === "number" ? v : null;
        standings.set(factionId, out);
        return out;
      },
      contacts, ownCorporationId: own.corporationId || null, ownAllianceId: own.allianceId || null,
      classOf: (typeId) => call("typeClass", typeId) };
  }

  function scanEntry(playerId, rec, now) {
    if (rec.state !== "space") return now + S.dscanIntervalMs;
    const mem = seen.get(playerId);
    if (mem && mem.systemId !== rec.systemId) seen.delete(playerId);
    const t = perfNow();
    const r = call("dscan", playerId, { rangeMeters: null, maxEntries: S.dscanMaxEntries });
    const ms = Math.max(0, perfNow() - t);
    counters.scans += 1;
    msMax = Math.max(msMax, ms);
    msSum += ms;
    if (!r || r.ok !== true || !Array.isArray(r.entries)) {
      const reason = r && r.reason;
      if (STATE_REASONS.includes(reason)) {
        counters.refused += 1;
        return now + S.dscanIntervalMs;
      }
      if (reason !== ABYSSAL) {
        counters.failed += 1;
        if (!seamFailLogged) {
          seamFailLogged = true;
          log(`shipAi dscan: seam failed - ${codeOf(reason)} (retry every ${S.dscanRefusedBackoffMs} ms)`);
        }
      }
      counters.backoff += 1;
      return now + S.dscanRefusedBackoffMs;
    }
    seamFailLogged = false;
    const systemId = isId(r.systemId) ? r.systemId : rec.systemId;
    const classified = classifyEntries(r.entries, contextOf(playerId, r, now), S);
    const out = buildScanReading(seen.get(playerId) || null, { systemId, classified,
      known: d.calloutGroupsOf(playerId, systemId), nowMs: now }, S, factionName);
    seen.set(playerId, out.seen);
    counters.newObjects += out.newObjects;
    if (out.reading.groups.length > 0) counters.offered += 1;
    d.offer(playerId, out.reading);
    return now + S.dscanIntervalMs;
  }

  function runPass() {
    if (stopped || !enabled) return;
    if (!governorAdmits()) {
      counters.skippedGovernor += 1;
      return;
    }
    counters.passes += 1;
    const now = d.nowMs();
    const online = onlinePlayers();
    for (const id of [...members.keys()]) if (!online.has(id)) drop(id);
    for (const [id, rec] of online) {
      if (members.has(id)) {
        members.set(id, rec);
        continue;
      }
      if (members.size >= S.dscanMaxPlayers) {
        counters.playersCapped += 1;
        continue;
      }
      members.set(id, rec);
      schedule(id, now + S.dscanLoginDelayMs);
    }
    const t0 = perfNow();
    let scans = 0;
    for (;;) {
      const head = queue.peek();
      if (!head || head.dueAtMs > now) break;
      if (scans >= S.dscanScansPerPass || perfNow() - t0 >= S.dscanPassBudgetMs) {
        counters.budgetCut += 1;
        break;
      }
      const entry = queue.popDue(now);
      const playerId = entry.payload.playerId;
      const rec = members.get(playerId);
      if (!rec) continue;
      lagMsMax = Math.max(lagMsMax, now - entry.dueAtMs);
      if (rec.state === "space") scans += 1;
      let next;
      try {
        next = scanEntry(playerId, rec, now);
      } catch (err) {
        counters.failed += 1;
        counters.backoff += 1;
        log(`shipAi dscan: scan failed - ${codeOf(err && (err.code || err.name))}`);
        next = now + S.dscanRefusedBackoffMs;
      }
      if (members.has(playerId)) schedule(playerId, next);
      else dueOf.delete(playerId);
    }
  }

  function start() {
    if (!enabled || stopped) return { ok: true, running: false };
    if (poller === null) {
      poller = createPoller({ runPass, intervalMs: S.dscanPollMs, now: () => d.nowMs(), setTimer: d.setTimer,
        onError: (err) => log(`shipAi dscan: pass failed - ${codeOf(err && (err.code || err.name))}`) });
      poller.start();
      log(`shipAi: dscan watch on interval=${S.dscanIntervalMs} players<=${S.dscanMaxPlayers}`);
    }
    return { ok: true, running: true };
  }

  function forget(playerId) {
    drop(playerId);
  }

  function getStatus() {
    const now = d.nowMs();
    let due = 0;
    for (const at of dueOf.values()) if (at <= now) due += 1;
    return { state: stopped ? "stopped" : (enabled ? (poller ? "running" : "idle") : "off"), players: members.size,
      due, counters: { ...counters }, msMax, msSum, lagMsMax };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (poller) poller.stop();
    queue.clear();
    members.clear();
    seen.clear();
    dueOf.clear();
  }

  return Object.freeze({ start, stop, forget, runPass, getStatus });
}

module.exports = { createDscanWatch, COUNTER_NAMES, WORK_CLASS };
