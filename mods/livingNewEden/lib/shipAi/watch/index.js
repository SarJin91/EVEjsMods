"use strict";

const { DeadlineQueue } = require("../../scheduler/deadlineQueue");
const { createPoller } = require("../../presence/poller");
const { skillEvents, missionEvents, jobEvents, orderEvents, orderEvent, walletEvents,
  queueEvents } = require("./sources");
const { METRIC, WATCH_KINDS } = require("../schema");

const WORK_CLASS = "MAINTENANCE";
const MS_PER_MINUTE = 60000;
const SOURCES = Object.freeze({ skills: Object.freeze({ kinds: Object.freeze(["SKILL_DONE"]) }),
  missions: Object.freeze({ kinds: Object.freeze(["MISSION_EXPIRING", "MISSION_OBJECTIVE"]) }),
  jobs: Object.freeze({ kinds: Object.freeze(["JOB_READY"]) }),
  orders: Object.freeze({ kinds: Object.freeze(["ORDER_FILLED"]), async: true }),
  wallet: Object.freeze({ kinds: Object.freeze(["BOUNTY_PAID", "ISK_IN"]), flag: "walletWatchEnabled" }),
  queue: Object.freeze({ kinds: Object.freeze(["SKILL_QUEUE_EMPTY"]), flag: "queueWatchEnabled" }) });
const SOURCE_NAMES = Object.freeze(Object.keys(SOURCES));
const COUNTER_NAMES = Object.freeze(["passes", "reads", "readRefused", "events", "duplicates", "budgetCut",
  "skippedGovernor", "marketBusy", "orderCancelled", "orderUnknown", "dbReadSlow",
  "walletBelowMin", "walletForeign", "queueEmpty", "missionObjective", "missionRearm"]);
const WATCH_DB_METHODS = Object.freeze(["skillHistory", "orderState", "walletIncome"]);
const ALL_ROWS = Number.MAX_SAFE_INTEGER;

function noop() {}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, 60);
const valueOf = (res) => (res && res.ok && res.value && res.value.ok ? res.value : null);
const keyOf = (playerId, source) => `${playerId}:${source}`;

function disabledKindsOf(S) {
  const disabled = new Set();
  const unknown = [];
  for (const part of String((S && S.watchDisabledKinds) || "").split(",")) {
    const name = part.trim().toUpperCase();
    if (name === "") continue;
    if (WATCH_KINDS.includes(name)) disabled.add(name);
    else unknown.push(name);
  }
  return { disabled, unknown };
}

function createShipAiWatch(deps) {
  const d = deps;
  const S = d.S;
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : { log: noop };
  const telemetry = d.telemetry && typeof d.telemetry.count === "function" ? d.telemetry : null;
  const perfNow = typeof d.perfNow === "function" ? d.perfNow : () => d.nowMs();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const { disabled } = disabledKindsOf(S);
  const active = SOURCE_NAMES.filter((src) => (!SOURCES[src].flag || S[SOURCES[src].flag] !== false)
    && SOURCES[src].kinds.some((k) => !disabled.has(k)));
  const enabled = S.watchEnabled === true && S.proactiveEnabled === true && active.length > 0;
  const objectiveOn = !disabled.has("MISSION_OBJECTIVE");
  const queue = new DeadlineQueue();
  const known = new Map();
  let stopped = false;
  let started = false;
  let marketInflight = false;

  const log = (line) => {
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const metric = (name, n) => {
    if (!telemetry || n <= 0) return;
    try {
      telemetry.count(name, n);
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
  const tx = (name, fn) => {
    const res = d.store.transaction(name, fn);
    const v = valueOf(res);
    if (!v) log(`shipAi watch: ${name} failed - ${codeOf(res && (res.ok ? res.value && res.value.reason : res.reason))}`);
    return v;
  };

  function drop(playerId) {
    for (const src of SOURCE_NAMES) queue.remove(keyOf(playerId, src));
    known.delete(playerId);
  }

  function reload(playerId, now) {
    const v = tx("shipAi.watch.pending", (db) => d.eventsRepo.listUnmentioned(db, playerId, WATCH_KINDS,
      now - S.watchPendingMaxAgeMs, S.watchMaxPending));
    if (!v || v.rows.length === 0) return;
    const events = v.rows.filter((r) => !disabled.has(r.kind)).map((r) => {
      const left = r.kind === "MISSION_EXPIRING" && Number.isSafeInteger(r.payload.minutesLeft)
        ? r.occurredAt + r.payload.minutesLeft * MS_PER_MINUTE : null;
      return { kind: r.kind, key: r.key, payload: r.payload, occurredAt: r.occurredAt, notedAt: r.occurredAt,
        expiresAt: left };
    });
    if (events.length > 0) d.offer(playerId, events);
  }

  function onlinePlayers() {
    const res = typeof d.readPresence === "function" ? d.readPresence() : null;
    const out = new Map();
    for (const rec of res && res.ok && Array.isArray(res.characters) ? res.characters : []) {
      const id = rec ? rec.characterId : null;
      if (!isId(id) || out.has(id) || !d.isWatched(id) || !d.isAllowed(id) || d.isQuiet(id)) continue;
      out.set(id, isId(rec.systemId) ? rec.systemId : null);
    }
    return out;
  }

  function scheduleEntry(playerId, source, at, login) {
    queue.schedule(keyOf(playerId, source), at, { playerId, source, login });
    const st = known.get(playerId);
    if (st && source === "missions") st.missionsDue = { at, login };
  }

  function rearmMissions(playerId, st, systemId, now) {
    const moved = systemId !== st.systemId;
    st.systemId = systemId;
    if (!moved || !objectiveOn || !active.includes("missions") || !isId(systemId)
      || !st.missionSystems.includes(systemId) || !st.missionsDue) return;
    const soon = now + S.missionObjectivePollMs;
    if (st.missionsDue.at <= soon) return;
    scheduleEntry(playerId, "missions", soon, st.missionsDue.login);
    counters.missionRearm += 1;
  }

  function readEntry(entry, now) {
    const { playerId, source, login } = entry.payload;
    const st = known.get(playerId);
    counters.reads += 1;
    if (source === "skills") {
      const cursor = login ? null : st.skillCursor;
      const since = Math.max(cursor === null ? -Infinity : cursor, now - S.watchLookbackMs);
      const r = d.toolDeps.skillHistory(playerId, since, S.watchMaxPending);
      if (!r || r.ok !== true || !Array.isArray(r.entries)) return { refused: true, next: now + S.watchRescanMs };
      const out = skillEvents(r.entries, cursor, (typeId) => d.toolDeps.typeName(typeId));
      return { events: out.events, cursor: out.cursor === null ? cursor : out.cursor, next: now + S.skillWatchMs };
    }
    if (source === "jobs") {
      const t = perfNow();
      const r = d.toolDeps.jobsRaw(playerId, ALL_ROWS);
      if (perfNow() - t > S.dbReadSlowMs) {
        counters.dbReadSlow += 1;
        metric(METRIC.dbReadSlow, 1);
      }
      if (!r || r.ok !== true || !Array.isArray(r.jobs)) return { refused: true, next: now + S.watchRescanMs };
      const out = jobEvents(r.jobs, now, S.watchLookbackMs, (typeId) => d.toolDeps.typeName(typeId));
      const due = out.nextDueAt === null ? now + S.watchRescanMs : Math.min(out.nextDueAt, now + S.watchRescanMs);
      return { events: out.events, next: Math.max(due, now + S.watchPollMs) };
    }
    if (source === "wallet") {
      const r = d.toolDeps.walletIncome(playerId);
      if (!r || r.ok !== true || !Array.isArray(r.entries)) return { refused: true, next: now + S.watchRescanMs };
      const out = walletEvents(r.entries, login ? null : st.wallet, now, S);
      return { events: out.events, wallet: out.cursor, belowMin: out.belowMin, foreign: out.foreign,
        next: now + S.walletRescanMs };
    }
    if (source === "queue") {
      const out = queueEvents(st.queueEmpty, d.toolDeps.skillQueueRaw(playerId), now, login);
      if (out.empty === null) return { refused: true, next: now + S.watchRescanMs };
      return { events: out.events, queueEmpty: out.empty, next: now + S.skillWatchMs };
    }
    const r = d.toolDeps.missionsRaw(playerId, S.toolMaxRows);
    if (!r || r.ok !== true || !Array.isArray(r.missions)) return { refused: true, next: now + S.watchRescanMs };
    const opts = objectiveOn ? { prevDone: login ? null : st.missions, playerSystemId: st.systemId,
      pollMs: S.missionObjectivePollMs, complete: r.more === 0 } : undefined;
    const out = missionEvents(r.missions, now, S.missionWarnMs, (id) => d.toolDeps.systemName(id), opts);
    const due = out.nextDueAt === null ? now + S.watchRescanMs : Math.min(out.nextDueAt, now + S.watchRescanMs);
    const res = { events: out.events, next: Math.max(due, now + S.watchPollMs) };
    if (opts) Object.assign(res, { missions: out.done, missionSystems: out.hotSystems });
    return res;
  }

  const alive = (playerId, st) => !stopped && known.get(playerId) === st;
  const scheduleOrders = (playerId, at) => queue.schedule(keyOf(playerId, "orders"), at,
    { playerId, source: "orders", login: false });

  async function askVanished(playerId, st, out) {
    const events = [];
    for (const [i, orderId] of out.vanished.entries()) {
      const prev = st.orders.get(orderId);
      if (i >= S.watchMaxPerLine) {
        out.open.set(orderId, prev);
        continue;
      }
      const s = await d.toolDeps.orderState(playerId, orderId);
      if (!alive(playerId, st)) return null;
      if (s && s.ok === true && s.state === "open") {
        out.open.set(orderId, prev);
      } else if (s && s.ok === true && s.state === "cancelled") {
        counters.orderCancelled += 1;
      } else if (s && s.ok === true && s.state !== "unknown") {
        const at = d.nowMs();
        const e = orderEvent({ ...s, orderId, changedAtMs: Number.isSafeInteger(s.changedAtMs)
          ? Math.min(s.changedAtMs, at) : at }, at, S.watchLookbackMs, (typeId) => d.toolDeps.typeName(typeId));
        if (e) events.push(e);
      } else if (s && (s.ok === true || s.reason === "NOT_FOUND" || s.reason === "NOT_OWNER")) {
        counters.orderUnknown += 1;
      } else {
        counters.readRefused += 1;
        out.open.set(orderId, prev);
      }
    }
    return events;
  }

  async function readOrders(entry) {
    const { playerId } = entry.payload;
    const st = known.get(playerId);
    const r = await d.toolDeps.ordersRaw(playerId, ALL_ROWS);
    if (!alive(playerId, st)) return;
    let at = d.nowMs();
    if (!r || r.ok !== true || !Array.isArray(r.orders) || !Array.isArray(r.closed)) {
      counters.readRefused += 1;
      scheduleOrders(playerId, at + S.watchRescanMs);
      return;
    }
    const out = orderEvents(st.orders, r, at, S.watchLookbackMs, (typeId) => d.toolDeps.typeName(typeId));
    counters.orderCancelled += out.cancelled;
    const more = out.vanished.length > 0 ? await askVanished(playerId, st, out) : [];
    if (more === null || !alive(playerId, st)) return;
    const events = [...out.events, ...more];
    at = d.nowMs();
    const v = events.length === 0 ? { inserted: [] } : tx("shipAi.watch.orders", (db) => {
      const inserted = [];
      for (const e of events) {
        const res = d.eventsRepo.noteEventInTx(db, { playerId, kind: e.kind, key: e.key, payload: e.payload,
          nowMs: at });
        if (!res.ok) return res;
        inserted.push(res.inserted);
      }
      return { ok: true, inserted };
    });
    if (!v) {
      scheduleOrders(playerId, at + S.watchPollMs);
      return;
    }
    st.orders = out.open;
    const offered = [];
    events.forEach((e, i) => {
      if (!v.inserted[i]) {
        counters.duplicates += 1;
        return;
      }
      counters.events += 1;
      offered.push({ ...e, notedAt: at });
    });
    metric(METRIC.watchEvents, offered.length);
    scheduleOrders(playerId, at + (out.open.size > 0 ? S.marketWatchMs : S.watchRescanMs));
    if (offered.length === 0) return;
    try {
      d.offer(playerId, offered);
    } catch (err) {
      log(`shipAi watch: offer failed - ${codeOf(err && (err.code || err.name))}`);
    }
  }

  function startOrders(entry) {
    marketInflight = true;
    const { playerId } = entry.payload;
    const st = known.get(playerId);
    let p;
    try {
      p = readOrders(entry);
    } catch (err) {
      p = Promise.reject(err);
    }
    p.catch((err) => {
      log(`shipAi watch: orders read failed - ${codeOf(err && (err.code || err.name))}`);
      if (alive(playerId, st)) scheduleOrders(playerId, d.nowMs() + S.watchRescanMs);
    }).then(() => {
      marketInflight = false;
    });
  }

  function commitState(st, source, res) {
    const count = (kind) => (res.events || []).filter((e) => e.kind === kind && !disabled.has(kind)).length;
    if (source === "wallet" && res.wallet) {
      st.wallet = res.wallet;
      counters.walletBelowMin += res.belowMin || 0;
      counters.walletForeign += res.foreign || 0;
    } else if (source === "queue" && typeof res.queueEmpty === "boolean") {
      st.queueEmpty = res.queueEmpty;
      counters.queueEmpty += count("SKILL_QUEUE_EMPTY");
    } else if (source === "missions" && res.missions instanceof Map) {
      st.missions = res.missions;
      st.missionSystems = Array.isArray(res.missionSystems) ? res.missionSystems : [];
      counters.missionObjective += count("MISSION_OBJECTIVE");
    }
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
    for (const id of [...known.keys()]) if (!online.has(id)) drop(id);
    const t0 = perfNow();
    let loaded = 0;
    for (const [id, systemId] of online) {
      const st = known.get(id);
      if (st) rearmMissions(id, st, systemId, now);
    }
    for (const [id, systemId] of online) {
      if (known.has(id)) continue;
      if (loaded >= S.watchReadsPerPass || perfNow() - t0 >= S.watchPassBudgetMs) {
        counters.budgetCut += 1;
        break;
      }
      loaded += 1;
      known.set(id, { skillCursor: null, orders: null, wallet: null, queueEmpty: null, missions: null,
        missionSystems: [], systemId, missionsDue: null });
      for (const src of active) scheduleEntry(id, src, now + S.watchLoginDelayMs, true);
      try {
        reload(id, now);
      } catch (err) {
        log(`shipAi watch: reload failed - ${codeOf(err && (err.code || err.name))}`);
      }
    }
    const done = [];
    const busy = [];
    let reads = 0;
    while (loaded + reads < S.watchReadsPerPass) {
      const head = queue.peek();
      if (!head || head.dueAtMs > now) break;
      if (perfNow() - t0 >= S.watchPassBudgetMs) {
        counters.budgetCut += 1;
        break;
      }
      const entry = queue.popDue(now);
      if (SOURCES[entry.payload.source] && SOURCES[entry.payload.source].async === true) {
        if (marketInflight) {
          counters.marketBusy += 1;
          busy.push(entry);
          continue;
        }
        reads += 1;
        counters.reads += 1;
        startOrders(entry);
        continue;
      }
      reads += 1;
      let res;
      try {
        res = readEntry(entry, now);
      } catch (err) {
        log(`shipAi watch: read failed - ${codeOf(err && (err.code || err.name))}`);
        res = { refused: true, next: now + S.watchRescanMs };
      }
      if (res.refused) counters.readRefused += 1;
      done.push({ entry, res });
    }
    for (const entry of busy) queue.schedule(entry.key, now + S.watchPollMs, entry.payload);
    metric(METRIC.watchReads, reads);
    const specs = [];
    for (const { entry, res } of done) {
      for (const e of res.events || []) {
        if (!disabled.has(e.kind)) specs.push({ playerId: entry.payload.playerId, event: e });
      }
    }
    const v = specs.length === 0 ? { inserted: [] } : tx("shipAi.watch.note", (db) => {
      const inserted = [];
      for (const s of specs) {
        const r = d.eventsRepo.noteEventInTx(db, { playerId: s.playerId, kind: s.event.kind, key: s.event.key,
          payload: s.event.payload, nowMs: now });
        if (!r.ok) return r;
        inserted.push(r.inserted);
      }
      return { ok: true, inserted };
    });
    const offers = new Map();
    if (v) {
      let insertedNow = 0;
      specs.forEach((s, i) => {
        if (!v.inserted[i]) {
          counters.duplicates += 1;
          return;
        }
        counters.events += 1;
        insertedNow += 1;
        if (!offers.has(s.playerId)) offers.set(s.playerId, []);
        offers.get(s.playerId).push({ ...s.event, notedAt: now });
      });
      metric(METRIC.watchEvents, insertedNow);
    }
    for (const { entry, res } of done) {
      const { playerId, source } = entry.payload;
      const st = known.get(playerId);
      if (!st) continue;
      if (v && source === "skills" && res.cursor !== undefined) st.skillCursor = res.cursor;
      if (v && !res.refused) commitState(st, source, res);
      scheduleEntry(playerId, source, v ? res.next : now + S.watchPollMs,
        (!v || res.refused === true) && entry.payload.login === true);
    }
    for (const [playerId, events] of offers) {
      try {
        d.offer(playerId, events);
      } catch (err) {
        log(`shipAi watch: offer failed - ${codeOf(err && (err.code || err.name))}`);
      }
    }
  }

  const poller = createPoller({ runPass, intervalMs: S.watchPollMs, now: () => d.nowMs(), setTimer: d.setTimer,
    onError: (err) => log(`shipAi watch: pass failed - ${codeOf(err && (err.code || err.name))}`) });

  function start() {
    if (!enabled || stopped) return { ok: true, running: false };
    if (!started) {
      started = true;
      poller.start();
    }
    return { ok: true, running: true };
  }

  function setQuiet(playerId, quiet) {
    if (quiet === true) drop(playerId);
  }

  function forget(playerId) {
    drop(playerId);
  }

  function getStatus() {
    return { state: stopped ? "stopped" : (enabled ? (started ? "running" : "idle") : "off"), queued: queue.size,
      sources: enabled ? [...active] : [], counters: { ...counters } };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    poller.stop();
    queue.clear();
    known.clear();
  }

  return Object.freeze({ start, stop, setQuiet, forget, runPass, getStatus });
}

module.exports = { createShipAiWatch, disabledKindsOf, SOURCES, WATCH_DB_METHODS, COUNTER_NAMES, WORK_CLASS };
