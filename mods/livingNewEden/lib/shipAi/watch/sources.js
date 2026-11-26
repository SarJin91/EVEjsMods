"use strict";

const { ACTIVITIES } = require("../tools/catalogDb");

const MS_PER_MINUTE = 60000;
const JOB_DUE_SLACK_MS = 1000;
const FILLED_STATES = Object.freeze(["filled", "expired"]);
const CANCELLED = "cancelled";
const ACCEPTED = "accepted";
const MS_PER_DAY = 86400000;
const JOURNAL_IDS_MAX = 100;
const BOUNTY_SOURCE = "bounty";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const textOrNull = (v) => (typeof v === "string" && v !== "" ? v : null);

function skillEvents(entries, cursorMs, nameOf) {
  const list = Array.isArray(entries) ? entries : [];
  const fresh = list.filter((e) => e && isId(e.typeId) && Number.isSafeInteger(e.atMs)
    && (cursorMs === null || cursorMs === undefined || e.atMs > cursorMs));
  let cursor = Number.isSafeInteger(cursorMs) ? cursorMs : null;
  for (const e of fresh) if (cursor === null || e.atMs > cursor) cursor = e.atMs;
  const events = fresh.sort((a, b) => a.atMs - b.atMs || a.typeId - b.typeId).map((e) => ({ kind: "SKILL_DONE",
    key: `skill:${e.typeId}:${e.atMs}`, payload: { skill: textOrNull(nameOf(e.typeId)) }, occurredAt: e.atMs }));
  return { events, cursor };
}

function missionEvents(missions, nowMs, warnMs, systemOf, opts) {
  const events = [];
  let nextDueAt = null;
  const withObjective = Boolean(opts) && typeof opts === "object";
  const prevDone = withObjective && opts.prevDone instanceof Map ? opts.prevDone : null;
  const done = new Map();
  const hotSystems = [];
  for (const m of Array.isArray(missions) ? missions : []) {
    if (withObjective && m && m.status === ACCEPTED && isId(m.agentId)) {
      const exp = Number.isSafeInteger(m.expiresAtMs) ? m.expiresAtMs : 0;
      const key = `${m.agentId}:${exp}`;
      const isDone = m.done === true;
      done.set(key, isDone);
      const wasOpen = prevDone && (prevDone.get(key) === false || (opts.complete === true && !prevDone.has(key)));
      if (isDone && wasOpen) {
        events.push({ kind: "MISSION_OBJECTIVE", key: `mission:${m.agentId}:done:${exp}`,
          payload: { title: textOrNull(m.title), system: isId(m.systemId) ? textOrNull(systemOf(m.systemId)) : null },
          occurredAt: nowMs });
      }
      if (!isDone && isId(m.systemId) && !hotSystems.includes(m.systemId)) hotSystems.push(m.systemId);
    }
    if (!m || m.status !== ACCEPTED || m.done === true || !isId(m.agentId) || !Number.isSafeInteger(m.expiresAtMs)) {
      continue;
    }
    const exp = m.expiresAtMs;
    if (exp > nowMs && exp <= nowMs + warnMs) {
      events.push({ kind: "MISSION_EXPIRING", key: `mission:${m.agentId}:${exp}`,
        payload: { title: textOrNull(m.title), system: isId(m.systemId) ? textOrNull(systemOf(m.systemId)) : null,
          minutesLeft: Math.floor((exp - nowMs) / MS_PER_MINUTE) }, occurredAt: nowMs, expiresAt: exp });
    } else if (exp - warnMs > nowMs && (nextDueAt === null || exp - warnMs < nextDueAt)) {
      nextDueAt = exp - warnMs;
    }
  }
  if (!withObjective) return { events, nextDueAt };
  if (isId(opts.playerSystemId) && hotSystems.includes(opts.playerSystemId) && Number.isSafeInteger(opts.pollMs)) {
    const soon = nowMs + opts.pollMs;
    if (nextDueAt === null || soon < nextDueAt) nextDueAt = soon;
  }
  return { events, nextDueAt, done, hotSystems };
}

function walletEvents(entries, cursor, nowMs, S) {
  const slack = Number.isSafeInteger(S.walletCursorSlackMs) && S.walletCursorSlackMs > 0 ? S.walletCursorSlackMs : 0;
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && Number.isSafeInteger(e.transactionId)
    && Number.isSafeInteger(e.atMs) && typeof e.source === "string" && Number.isFinite(e.amountIsk));
  const prev = cursor && Number.isSafeInteger(cursor.atMs) ? cursor : null;
  let newest = prev ? prev.atMs : 0;
  for (const e of list) if (e.atMs > newest) newest = e.atMs;
  const ids = list.filter((e) => e.atMs >= newest - slack).sort((a, b) => b.atMs - a.atMs)
    .slice(0, JOURNAL_IDS_MAX).map((e) => e.transactionId);
  const next = { atMs: newest, ids };
  const out = { events: [], cursor: next, belowMin: 0, foreign: 0 };
  if (!prev) return out;
  const seen = new Set(Array.isArray(prev.ids) ? prev.ids : []);
  const groups = new Map();
  for (const e of list) {
    if (e.atMs <= prev.atMs - slack || seen.has(e.transactionId)) continue;
    seen.add(e.transactionId);
    if (e.own !== true) {
      out.foreign += 1;
      continue;
    }
    const g = groups.get(e.source) || { sum: 0, count: 0, maxId: e.transactionId, atMs: e.atMs };
    g.sum += e.amountIsk;
    g.count += 1;
    if (e.transactionId > g.maxId) g.maxId = e.transactionId;
    if (e.atMs > g.atMs) g.atMs = e.atMs;
    groups.set(e.source, g);
  }
  for (const [source, g] of groups) {
    const bounty = source === BOUNTY_SOURCE;
    if (g.sum < (bounty ? S.bountyMinIsk : S.iskInMinIsk)) {
      out.belowMin += 1;
      continue;
    }
    const isk = Math.round(g.sum);
    out.events.push(bounty
      ? { kind: "BOUNTY_PAID", key: `bounty:${g.maxId}`, payload: { isk, payouts: g.count },
        occurredAt: Math.min(g.atMs, nowMs) }
      : { kind: "ISK_IN", key: `isk:${source}:${g.maxId}`, payload: { source, isk },
        occurredAt: Math.min(g.atMs, nowMs) });
  }
  out.events.sort((a, b) => a.occurredAt - b.occurredAt || (a.key < b.key ? -1 : 1));
  return out;
}

function queueEvents(prevEmpty, read, nowMs, login) {
  if (!read || read.ok !== true || !Array.isArray(read.queue)) return { events: [], empty: null };
  const empty = read.queue.length === 0 && !(Number.isSafeInteger(read.more) && read.more > 0);
  const events = [];
  if (empty && login === true) {
    events.push({ kind: "SKILL_QUEUE_EMPTY", key: `queue:empty:login:${Math.floor(nowMs / MS_PER_DAY)}`,
      payload: { login: 1 }, occurredAt: nowMs });
  } else if (empty && login !== true && prevEmpty === false) {
    events.push({ kind: "SKILL_QUEUE_EMPTY", key: `queue:empty:${Math.floor(nowMs / MS_PER_MINUTE)}`,
      payload: { login: 0 }, occurredAt: nowMs });
  }
  return { events, empty };
}

function jobEvents(jobs, nowMs, lookbackMs, nameOf) {
  const events = [];
  let nextDueAt = null;
  for (const j of Array.isArray(jobs) ? jobs : []) {
    if (!j || !isId(j.jobId) || !Number.isSafeInteger(j.endAtMs)) continue;
    const end = j.endAtMs;
    if (j.ready === true && end <= nowMs && end >= nowMs - lookbackMs) {
      events.push({ kind: "JOB_READY", key: `job:${j.jobId}`, payload: { activity: ACTIVITIES.get(j.activityId)
        || `activity ${j.activityId}`, product: isId(j.productTypeId) ? textOrNull(nameOf(j.productTypeId)) : null,
      runs: Number.isSafeInteger(j.runs) ? j.runs : 0 }, occurredAt: end });
    } else if (j.ready !== true && end > nowMs && (nextDueAt === null || end + JOB_DUE_SLACK_MS < nextDueAt)) {
      nextDueAt = end + JOB_DUE_SLACK_MS;
    }
  }
  events.sort((a, b) => a.occurredAt - b.occurredAt || (a.key < b.key ? -1 : 1));
  return { events, nextDueAt };
}

function orderEvent(o, nowMs, lookbackMs, nameOf) {
  if (!FILLED_STATES.includes(o.state) || !Number.isSafeInteger(o.changedAtMs) || o.changedAtMs > nowMs
    || o.changedAtMs < nowMs - lookbackMs) {
    return null;
  }
  return { kind: "ORDER_FILLED", key: `order:${o.orderId}:${o.state}`, payload: { side: o.side,
    item: isId(o.typeId) ? textOrNull(nameOf(o.typeId)) : null, total: Number.isSafeInteger(o.total) ? o.total : 0,
    state: o.state }, occurredAt: o.changedAtMs };
}

function orderEvents(prevOpen, now, nowMs, lookbackMs, nameOf) {
  const open = new Map();
  for (const o of now && Array.isArray(now.orders) ? now.orders : []) {
    if (o && isId(o.orderId)) open.set(o.orderId, { remaining: Number.isSafeInteger(o.remaining) ? o.remaining : 0 });
  }
  const closedIds = new Set();
  const events = [];
  let cancelled = 0;
  for (const o of now && Array.isArray(now.closed) ? now.closed : []) {
    if (!o || !isId(o.orderId) || closedIds.has(o.orderId)) continue;
    closedIds.add(o.orderId);
    if (o.state === CANCELLED && prevOpen && prevOpen.has(o.orderId)) cancelled += 1;
    const e = orderEvent(o, nowMs, lookbackMs, nameOf);
    if (e) events.push(e);
  }
  const cut = Boolean(now) && Number.isSafeInteger(now.more) && now.more > 0;
  const vanished = [];
  for (const [id, v] of prevOpen || []) {
    if (open.has(id) || closedIds.has(id)) continue;
    if (cut) open.set(id, v);
    else vanished.push(id);
  }
  events.sort((a, b) => a.occurredAt - b.occurredAt || (a.key < b.key ? -1 : 1));
  return { events, vanished, open, cancelled };
}

module.exports = { skillEvents, missionEvents, jobEvents, orderEvents, orderEvent, walletEvents, queueEvents,
  ACCEPTED, FILLED_STATES, JOB_DUE_SLACK_MS };
