"use strict";

const { createPoller } = require("../presence/poller");
const S = require("./schema");

const METRIC_POLL_MS = "abyssal.poll.ms";
const METRIC_POLL_READS = "abyssal.poll.reads";
const METRIC_RUNS_ACTIVE = "abyssal.runs.active";
const METRIC_RUNS_FINISHED = "abyssal.runs.finished";
const METRIC_RUNS_LOST = "abyssal.runs.lost";
const METRIC_HOOK_EXITED = "abyssal.hook.exited";
const METRIC_HOOK_ERRORS = "abyssal.hook.errors";
const METRIC_READ_ERRORS = "abyssal.read.errors";
const COUNTER_NAMES = Object.freeze(["passes", "reads", "readErrors", "observed", "exited", "lost", "finished",
  "pruned", "dropped", "writeErrors", "budgetCut", "skippedFinished"]);
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function fingerprintOf(r) {
  const people = (r.participants || []).map((p) => `${p.characterId}:${p.shipTypeId}:${p.status}`).join(",");
  return [r.ownerCharacterId, r.sourceSystemId, r.hostLocationId, r.tier, r.weather || "", r.shipClass || "", people,
    r.roomIndex, r.pocketsCompleted, r.expiresAtMs, r.vendorOutcome || ""].join("|");
}

function createAbyssalObserver(deps) {
  const settings = deps.settings;
  const seam = deps.seam;
  const store = deps.store;
  const repository = deps.repository;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const now = deps.now;
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const open = new Map();
  const pending = new Map();
  const finished = new Set();
  let presenceState = "unknown";
  let lastPassMs = null;
  let lastError = null;
  let subscription = null;
  let stopped = false;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function rememberFinished(id) {
    if (finished.size >= settings.maxRows) finished.clear();
    finished.add(id);
  }

  const poller = createPoller({ runPass: () => { runPass(); }, intervalMs: settings.pollMs, now,
    setTimer: deps.setTimer, onError: (err) => { lastError = messageOf(err); },
    pacing: false });

  function load() {
    const r = repository.listActive();
    if (!r || r.ok !== true) return { ok: false, reason: String((r && r.reason) || "LIST_FAILED") };
    const startMs = now();
    for (const run of r.runs) {
      open.set(run.instanceId, { key: { instanceId: run.instanceId, activatedAtMs: run.activatedAtMs },
        state: run.state, lastSeenMs: Math.max(run.lastSeenMs, startMs), fp: fingerprintOf(run) });
    }
    return { ok: true, open: open.size };
  }

  function onExited(snapshot) {
    if (stopped || !snapshot || !Number.isSafeInteger(snapshot.instanceId)) return;
    if (!pending.has(snapshot.instanceId) && pending.size >= settings.maxPendingExits) {
      counters.dropped += 1;
      metric("count", METRIC_HOOK_ERRORS, 1);
      return;
    }
    pending.set(snapshot.instanceId, snapshot);
    metric("count", METRIC_HOOK_EXITED, 1);
    poller.arm(0);
  }

  function readRuns() {
    const out = { seen: new Map(), reads: 0, cut: false, failed: false, sweep: false };
    const presence = getPresence();
    const st = presence && typeof presence.getStatus === "function" ? presence.getStatus() : null;
    if (!st || st.available !== true) {
      presenceState = "PRESENCE_UNAVAILABLE";
      return out;
    }
    presenceState = st.stale ? "STALE" : "ok";
    const hosts = presence.observedSystems().filter((id) => seam.isAbyssalHost(id));
    const read = new Set();
    for (const host of hosts) {
      const sp = presence.getSystemPresence(host);
      if (!sp) continue;
      if (sp.truncated) out.cut = true;
      for (const c of sp.characters) {
        if (read.has(c.characterId)) continue;
        if (out.reads >= settings.maxReadsPerPoll) {
          out.cut = true;
          break;
        }
        out.reads += 1;
        const r = seam.readActiveRun(c.characterId);
        if (!r || r.ok !== true) {
          out.failed = true;
          counters.readErrors += 1;
          metric("count", METRIC_READ_ERRORS, 1);
          continue;
        }
        read.add(c.characterId);
        if (!r.run) continue;
        for (const p of r.run.participants) read.add(p.characterId);
        out.seen.set(r.run.instanceId, r.run);
      }
    }
    if (out.cut) counters.budgetCut += 1;
    out.sweep = !st.stale && !out.cut && !out.failed;
    return out;
  }

  function runPass() {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = now();
    counters.passes += 1;
    const runs = readRuns();
    counters.reads += runs.reads;
    const nowMs = now();
    const exits = [...pending.values()];
    const observe = [];
    for (const [id, s] of runs.seen) {
      const entry = open.get(id);
      if (entry) entry.lastSeenMs = nowMs;
      if (pending.has(id)) continue;
      if (finished.has(id)) {
        counters.skippedFinished += 1;
        continue;
      }
      if (!entry || entry.fp !== fingerprintOf(s)) observe.push(s);
    }
    const lost = [];
    if (runs.sweep) {
      for (const [id, entry] of open) {
        if (lost.length >= settings.maxPendingExits) break;
        if (!runs.seen.has(id) && !pending.has(id) && nowMs - entry.lastSeenMs >= settings.lostGraceMs) {
          lost.push(entry.key);
        }
      }
    }
    if (exits.length > 0 || observe.length > 0 || lost.length > 0) write(exits, observe, lost, nowMs);
    lastPassMs = now() - t0;
    metric("observe", METRIC_POLL_MS, lastPassMs);
    metric("count", METRIC_POLL_READS, runs.reads);
    metric("gauge", METRIC_RUNS_ACTIVE, open.size);
    return { ok: true, reads: runs.reads, seen: runs.seen.size, exits: exits.length, observed: observe.length,
      lost: lost.length };
  }

  function write(exits, observe, lost, nowMs) {
    const tx = store.transaction("abyssal.poll", (db) => {
      const out = { exits: [], observed: [], lost: [], errors: 0, pruned: 0 };
      for (const s of exits) {
        const r = repository.markExitedInTx(db, s, nowMs);
        if (r.ok) out.exits.push({ s, changed: r.changed });
        else out.errors += 1;
      }
      for (const s of observe) {
        const r = repository.observeInTx(db, s, nowMs);
        if (r.ok) out.observed.push({ s, r });
        else if (r.reason === "FINISHED") out.observed.push({ s, r });
        else out.errors += 1;
      }
      for (const key of lost) {
        const r = repository.markLostInTx(db, key, nowMs);
        if (r.ok) out.lost.push({ key, changed: r.changed });
        else out.errors += 1;
      }
      const ended = out.exits.some((e) => e.changed) || out.lost.some((e) => e.changed)
        || out.observed.some((e) => e.r.ok && !S.OPEN_STATES.includes(e.r.state));
      if (ended) {
        const p = repository.pruneInTx(db, settings.maxRows, settings.pruneBatch);
        if (p.ok) out.pruned = p.pruned;
        else out.errors += 1;
      }
      return out;
    });
    if (!tx.ok) {
      counters.writeErrors += 1;
      lastError = String(tx.reason || "TX_FAILED");
      return;
    }
    const out = tx.value;
    counters.writeErrors += out.errors;
    counters.pruned += out.pruned;
    let ended = 0;
    let lostNow = 0;
    for (const { s, changed } of out.exits) {
      pending.delete(s.instanceId);
      const wasOpen = open.delete(s.instanceId);
      if (changed && (wasOpen || !finished.has(s.instanceId))) ended += 1;
      rememberFinished(s.instanceId);
      if (changed) counters.exited += 1;
    }
    for (const { s, r } of out.observed) {
      if (!r.ok) {
        open.delete(s.instanceId);
        rememberFinished(s.instanceId);
        continue;
      }
      counters.observed += r.changed ? 1 : 0;
      if (S.OPEN_STATES.includes(r.state)) {
        open.set(s.instanceId, { key: r.key, state: r.state, lastSeenMs: nowMs, fp: fingerprintOf(s) });
      } else {
        open.delete(s.instanceId);
        rememberFinished(s.instanceId);
        ended += 1;
      }
    }
    for (const { key, changed } of out.lost) {
      open.delete(key.instanceId);
      if (changed) {
        lostNow += 1;
        rememberFinished(key.instanceId);
      }
    }
    counters.finished += ended + lostNow;
    counters.lost += lostNow;
    if (ended + lostNow > 0) metric("count", METRIC_RUNS_FINISHED, ended + lostNow);
    if (lostNow > 0) metric("count", METRIC_RUNS_LOST, lostNow);
  }

  function start() {
    const loaded = load();
    if (!loaded.ok) return loaded;
    const presence = getPresence();
    if (presence && typeof presence.onSystemObserved === "function") {
      const r = presence.onSystemObserved((systemId) => {
        if (seam.isAbyssalHost(systemId)) poller.arm(0);
      });
      if (r && r.ok) subscription = r;
    }
    poller.start();
    return { ok: true, open: open.size };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    poller.stop();
    if (subscription) {
      try {
        subscription.unsubscribe();
      } catch (_err) {
      }
      subscription = null;
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", presence: presenceState, open: open.size,
      pending: pending.size, passes: poller.getPasses(), lastPassMs, lastError, counters: Object.freeze({ ...counters }) });
  }

  return Object.freeze({ start, stop, onExited, runPass, getStatus });
}

module.exports = { COUNTER_NAMES, fingerprintOf, createAbyssalObserver };
