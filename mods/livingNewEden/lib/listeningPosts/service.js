"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const { watchedOf, crossingsOfLeg, sizeClassOf, shipCountOf, sightingLineOf, noticeKindOf, corpSystemsOf,
  recipientsOf } = require("./rules");

const PAYLOAD_KEYS = Object.freeze(["check", "enterAt", "fleetId", "legSeq", "systemId", "systemIndex"]);
const MAX_DETAIL = 120;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length > 0 && v.length <= S.MAX_FLEET_ID;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parsePayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== PAYLOAD_KEYS.join()) return null;
  if (!isId(p.systemId) || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0
    || !Number.isSafeInteger(p.systemIndex) || p.systemIndex < 0 || !isTime(p.enterAt)
    || !Number.isSafeInteger(p.check) || p.check < 0 || p.check > S.MAX_CHECK) return null;
  return { check: p.check, enterAt: p.enterAt, fleetId: p.fleetId, legSeq: p.legSeq, systemId: p.systemId,
    systemIndex: p.systemIndex };
}

function createListeningPostService(deps) {
  const { store, scheduler, fleetRepository, repo } = deps;
  const C = deps.settings;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const perfNow = typeof deps.perfNow === "function" ? deps.perfNow : () => performance.now();
  const counters = Object.fromEntries(S.COUNTER_NAMES.map((n) => [n, 0]));
  const staleByReason = Object.create(null);
  let stopped = false;
  let lastRefusal = null;
  let watched = new Map();
  let watchedAt = null;
  let posts = Object.freeze([]);
  let lastWatchReason = null;
  let memo = { now: null, members: new Map() };
  let factionNames = null;
  const budget = { seq: null, used: 0 };

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `listeningPost.${name}`, n);
  }

  function noteStale(reason) {
    const k = S.STALE_REASONS.includes(reason) ? reason : "ROUTE_CHANGED";
    staleByReason[k] = (staleByReason[k] || 0) + 1;
    bump("stale");
    if (k === "LEG_CHANGED") bump("staleLegChanged");
  }

  function neighborsFn() {
    if (C.rangeJumps < 1 || typeof deps.getGraph !== "function") return null;
    try {
      const g = deps.getGraph();
      const r = g && typeof g.getGraph === "function" ? g.getGraph() : null;
      const graph = r && r.ok === true ? r.graph : null;
      return graph && typeof graph.getNeighbors === "function" ? (id) => graph.getNeighbors(id) : null;
    } catch (_err) {
      return null;
    }
  }

  function watchFailed(reason) {
    bump("watchErrors");
    lastRefusal = `WATCH:${reason}`;
    if (reason !== lastWatchReason) logger.log(`listeningPost: watch refresh failed - ${reason}`);
    lastWatchReason = reason;
  }

  function refreshWatch() {
    if (stopped) return;
    try {
      const sentries = typeof deps.getSentries === "function" ? deps.getSentries() : null;
      if (!sentries || typeof sentries.listLiveOfKind !== "function" || typeof sentries.isArmed !== "function") {
        watched = new Map();
        posts = Object.freeze([]);
        watchFailed("NO_SENTRIES");
      } else {
        const list = sentries.listLiveOfKind(S.KIND).map((ref) => Object.freeze({ systemId: ref.systemId,
          ownerCorpId: ref.ownerCorpId, armed: sentries.isArmed(ref.itemId) === true }));
        const nb = C.rangeJumps >= 1 ? neighborsFn() : null;
        if (C.rangeJumps >= 1 && !nb) {
          bump("watchNoGraph");
          lastRefusal = "WATCH:NO_GRAPH";
        }
        watched = watchedOf(list, nb, C.rangeJumps).watched;
        posts = Object.freeze(list);
        lastWatchReason = null;
      }
      watchedAt = clock.now();
      bump("watchRefreshes");
      metric("gauge", "listeningPost.watchedSystems", watched.size);
    } catch (err) {
      watchFailed(messageOf(err));
    }
  }

  function onDeparture(tx, d) {
    if (stopped || !d || !d.leg || !Array.isArray(d.leg.systems)) return;
    try {
      bump("legsSeen");
      const t0 = perfNow();
      const first = crossingsOfLeg(d.leg, watched, 1)[0];
      if (first) enqueueFirst(tx, d, first);
      metric("observe", "listeningPost.listenerMs", perfNow() - t0);
    } catch (err) {
      if (tx && tx.inTransaction === false) throw err;
      bump("listenerErrors");
      lastRefusal = `LISTENER:${messageOf(err)}`;
    }
  }

  function enqueueFirst(tx, d, c) {
    const seq = store.getTxSeq();
    if (seq !== budget.seq) {
      budget.seq = seq;
      budget.used = 0;
    }
    if (budget.used >= C.maxEnqueuesPerTransaction) {
      bump("listenerBudgetPass");
      lastRefusal = "BUDGET";
      return;
    }
    const payload = { check: 0, enterAt: c.enterAt, fleetId: d.fleetId, legSeq: d.legSeq, systemId: c.systemId,
      systemIndex: c.systemIndex };
    const r = scheduler.enqueue(S.EVENT_TYPE, String(c.systemId), c.enterAt, payload,
      S.sightingKey(c.systemId, d.fleetId, d.legSeq), { tx, chained: d.chained === true });
    if (!r || r.ok !== true) {
      bump("enqueueRefused");
      lastRefusal = String((r && r.reason) || "ENQUEUE_FAILED");
      return;
    }
    if (!r.duplicate) {
      budget.used += 1;
      bump("sightingsQueued");
    }
  }

  function nextOf(route, p) {
    if (!route || p.check + 1 >= C.maxChecksPerLeg) return null;
    return crossingsOfLeg(route, watched, 1, p.systemIndex + 1)[0] || null;
  }

  function readSighting(db, p) {
    const f = fleetRepository.getFleet(db, p.fleetId);
    if (!f || f.ok !== true) return f || { ok: false, reason: "FLEET_READ_FAILED" };
    const fleet = f.fleet || null;
    if (!fleet) return { ok: true, outcome: "STALE", reason: "FLEET_GONE" };
    if (fleet.legSeq !== p.legSeq) return { ok: true, outcome: "STALE", reason: "LEG_CHANGED" };
    const route = fleet.route && Array.isArray(fleet.route.systems) ? fleet.route : null;
    const ended = !route && p.systemIndex > 0 && fleet.currentSystemId === p.systemId;
    if (!ended && (!route || route.systems[p.systemIndex] !== p.systemId)) {
      return { ok: true, outcome: "STALE", reason: "ROUTE_CHANGED" };
    }
    const next = ended ? null : nextOf(route, p);
    if (!watched.has(p.systemId)) return { ok: true, outcome: "NO_POST", next };
    const row = { systemId: p.systemId, fleetId: p.fleetId, legSeq: p.legSeq, systemIndex: p.systemIndex,
      factionId: fleet.factionId, fleetRole: fleet.fleetRole, sizeClass: sizeClassOf(shipCountOf(fleet.composition), C),
      fromSystemId: !ended && p.systemIndex > 0 ? route.systems[p.systemIndex - 1] : null,
      toSystemId: !ended && p.systemIndex + 1 < route.systems.length ? route.systems[p.systemIndex + 1] : null,
      seenAt: p.enterAt };
    const seen = repo.findInTx(db, row);
    if (!seen || seen.ok !== true) return seen || { ok: false, reason: "SIGHTING_READ_FAILED" };
    return { ok: true, outcome: "SIGHTED", row, known: seen.sighting !== null, next,
      corpIds: watched.get(p.systemId) || [] };
  }

  function runningNotices() {
    try {
      const n = typeof deps.getNotices === "function" ? deps.getNotices() : null;
      if (!n || typeof n.enqueueItemsInTx !== "function" || typeof n.getStatus !== "function") return null;
      const st = n.getStatus();
      return st && st.state === "running" ? n : null;
    } catch (_err) {
      return null;
    }
  }

  function membersOf(corpId, now) {
    if (memo.now !== now) memo = { now, members: new Map() };
    if (memo.members.has(corpId)) return memo.members.get(corpId);
    let r;
    try {
      const seam = deps.adapter ? deps.adapter.playerStructures : null;
      r = seam && typeof seam.listOwnerMemberIds === "function"
        ? seam.listOwnerMemberIds(corpId, { max: C.mailMaxRecipients }) : null;
    } catch (_err) {
      r = null;
    }
    const v = r && r.ok === true && Array.isArray(r.characterIds) ? r : { ok: false };
    memo.members.set(corpId, v);
    return v;
  }

  function factionNamesNow() {
    if (factionNames) return factionNames;
    try {
      const a = deps.adapter;
      const r = a && typeof a.readFactionNames === "function" ? a.readFactionNames() : null;
      if (r && r.ok === true && r.names instanceof Map) factionNames = r.names;
    } catch (_err) {
    }
    return factionNames || new Map();
  }

  function systemNamesOf(row) {
    const out = new Map();
    let graph = null;
    try {
      const g = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      const r = g && typeof g.getGraph === "function" ? g.getGraph() : null;
      graph = r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
    } catch (_err) {
      graph = null;
    }
    if (!graph) return out;
    for (const id of [row.systemId, row.fromSystemId, row.toSystemId]) {
      if (!isId(id) || out.has(id)) continue;
      try {
        const sys = graph.getSystem(id);
        if (sys && typeof sys.name === "string") out.set(id, sys.name);
      } catch (_err) {
      }
    }
    return out;
  }

  function mailOf(read, now) {
    if (C.mailEnabled !== true || read.known) return null;
    const notices = runningNotices();
    if (!notices) return { notices: null, items: [], off: 1, refused: 0 };
    const rec = recipientsOf(read.corpIds, (corpId) => membersOf(corpId, now), C.maxCorpsPerSighting);
    const row = read.row;
    if (rec.characterIds.length === 0) return { notices, items: [], off: 0, refused: rec.refused };
    const line = sightingLineOf(row, { systems: systemNamesOf(row), factions: factionNamesNow() });
    const eventKey = S.noticeKey(row.systemId, row.fleetId, row.legSeq);
    const kind = noticeKindOf(row);
    const items = rec.characterIds.map((characterId) => ({ eventKey, characterId, kind, systemId: row.systemId, line,
      eventAt: row.seenAt }));
    return { notices, items, off: 0, refused: rec.refused };
  }

  function chainNext(etx, p, next) {
    if (!next) return { ok: true, queued: false };
    const payload = { check: p.check + 1, enterAt: next.enterAt, fleetId: p.fleetId, legSeq: p.legSeq,
      systemId: next.systemId, systemIndex: next.systemIndex };
    const r = scheduler.enqueue(S.EVENT_TYPE, String(next.systemId), next.enterAt, payload,
      S.sightingKey(next.systemId, p.fleetId, p.legSeq), { tx: etx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: String((r && r.reason) || "ENQUEUE_FAILED") };
    return { ok: true, queued: r.duplicate !== true };
  }

  function sightEffect(etx, p, read, now, mail) {
    const ins = repo.insertInTx(etx, read.row, now);
    if (!ins || ins.ok !== true) {
      const r = ins || { ok: false, reason: "SIGHTING_WRITE_FAILED" };
      return r.reason === "INVALID_INPUT" ? { ...r, permanent: true } : r;
    }
    const pr = repo.pruneInTx(etx, { before: Math.max(0, now - C.sightingRetentionMs), batch: C.pruneBatch });
    if (!pr || pr.ok !== true) return pr || { ok: false, reason: "PRUNE_FAILED" };
    let noticed = null;
    if (mail && mail.notices && mail.items.length > 0) {
      const nr = mail.notices.enqueueItemsInTx(etx, mail.items, now);
      noticed = nr && nr.ok === true ? { inserted: Number(nr.inserted) || 0, refused: false }
        : { inserted: 0, refused: true };
    }
    const c = chainNext(etx, p, read.next);
    if (!c.ok) return c;
    return { ok: true, duplicate: ins.duplicate === true, pruned: pr.deleted, queued: c.queued,
      ...(noticed ? { noticed: noticed.inserted, noticeRefused: noticed.refused } : {}) };
  }

  function onSighting(ev, hctx) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "LISTENING_POST_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: true, outcome: "OFF", onCommitted: () => bump("off") };
      const now = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const tx = store.transaction("listeningPost.sightingRead", (db) => readSighting(db, p));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        lastRefusal = String((read && read.reason) || "READ_FAILED");
        return { ok: false, reason: String((read && read.reason) || "LISTENING_POST_READ_FAILED") };
      }
      if (read.outcome === "STALE") return { ok: true, outcome: "STALE", onCommitted: () => noteStale(read.reason) };
      if (read.outcome === "NO_POST") {
        return { ok: true, outcome: "NO_POST", effect: (etx) => chainNext(etx, p, read.next), onCommitted: (v) => {
          bump("noPost");
          if (v && v.queued === true) bump("chainQueued");
        } };
      }
      const mail = mailOf(read, now);
      return { ok: true, outcome: "SIGHTED", effect: (etx) => sightEffect(etx, p, read, now, mail), onCommitted: (v) => {
        if (!v) return;
        bump(v.duplicate ? "duplicates" : "sightings");
        bump("pruned", v.pruned);
        if (v.queued === true) bump("chainQueued");
        if (mail) {
          bump("noticesOff", mail.off);
          bump("recipientsUnavailable", mail.refused);
        }
        bump("noticesQueued", v.noticed);
        if (v.noticeRefused === true) bump("noticesRefused");
      } };
    } catch (err) {
      return { ok: false, reason: `LISTENING_POST_SIGHTING_FAILED: ${messageOf(err)}` };
    }
  }

  function markersRefused(reason, detail) {
    bump("markersRefused");
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  }

  function markersFor(q) {
    try {
      if (stopped) return { ok: false, reason: "LISTENING_POST_OFF" };
      const o = isPlain(q) ? q : {};
      if (!isId(o.corpId)) return markersRefused("INVALID_INPUT", "corpId");
      if (!isTime(o.now)) return markersRefused("INVALID_INPUT", "now");
      if (o.systemIds !== undefined && (!Array.isArray(o.systemIds) || o.systemIds.length > S.MAX_QUERY_SYSTEMS
        || !o.systemIds.every(isId))) return markersRefused("INVALID_INPUT", "systemIds");
      const only = o.systemIds === undefined ? null : new Set(o.systemIds);
      const mine = (corpSystemsOf(watched).get(o.corpId) || []).filter((id) => !only || only.has(id))
        .slice(0, S.MAX_QUERY_SYSTEMS);
      if (mine.length === 0) {
        bump("markersServed");
        return { ok: true, markers: [], truncated: false };
      }
      const tx = store.transaction("listeningPost.markers", (db) => repo.listMarkersInTx(db, { systemIds: mine,
        since: Math.max(0, o.now - C.mapWindowMs), limit: C.mapMaxMarkers + 1 }));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return markersRefused("LISTENING_POST_READ_FAILED", String((read && read.reason) || "READ_FAILED"));
      }
      bump("markersServed");
      return { ok: true, markers: read.markers.slice(0, C.mapMaxMarkers),
        truncated: read.markers.length > C.mapMaxMarkers };
    } catch (err) {
      return markersRefused("LISTENING_POST_READ_FAILED", messageOf(err));
    }
  }

  const modeNow = () => (stopped ? "off" : "on");

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", mode: modeNow(), watchedSystems: watched.size,
      watchedAt, counters: Object.freeze({ ...counters }), staleByReason: Object.freeze({ ...staleByReason }),
      lastRefusal });
  }

  return Object.freeze({ onDeparture, onSighting, refreshWatch, watchedSystems: () => [...watched.keys()],
    markersFor, postsSnapshot: () => posts, getStatus, getMode: modeNow, isStopped: () => stopped,
    stop() {
      if (stopped) return;
      stopped = true;
      logger.log("listeningPost: stopped");
    } });
}

module.exports = { createListeningPostService, parsePayload, PAYLOAD_KEYS };
