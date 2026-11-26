"use strict";

const { VIEW_ID, PANEL_ORDER } = require("./schema");
const { arcOf } = require("./data/arcs");

const WORK_CLASS = "MAINTENANCE";
const ROWS = 7;
const SECOND_MS = 1000;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function threadRowOf(t, now) {
  const steps = t.plan && Array.isArray(t.plan.steps) ? t.plan.steps : [];
  const step = steps[t.stepNo] || null;
  const arc = arcOf(t.arc);
  return { threadId: t.threadId, arc: t.arc, label: arc ? arc.labelNoun : t.arc, factionId: t.factionId,
    systemId: t.anchorSystemId, state: t.state, outcome: t.outcome, source: t.source, stepNo: t.stepNo,
    steps: steps.length, kind: step ? step.kind : null, stepState: t.stepState,
    dueIn: t.state === "ACTIVE" ? Math.max(0, Math.round((t.stepDueAt - now) / SECOND_MS)) : null };
}

function buildGameMasterPanel(deps) {
  const { store, repo, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const bucketMs = Math.max(1, Math.trunc(Number(deps.settings && deps.settings.passIntervalMs) || 1));

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function cacheKey() {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    return `g${Math.floor(clock.now() / bucketMs)}`;
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const tx = store.transaction("observer.gameMaster", (db) => ({ cycles: repo.listCyclesInTx(db, { limit: ROWS }),
      threads: repo.listThreadsInTx(db, { limit: ROWS }) }));
    const read = tx && tx.ok ? tx.value : null;
    const bad = !read ? null : [read.cycles, read.threads].find((x) => !x || x.ok !== true);
    if (!read || bad !== undefined) {
      return { available: false, reason: String((bad && bad.reason) || (tx && tx.reason) || "TX_FAILED") };
    }
    const v = { cycles: read.cycles.rows, threads: read.threads.rows };
    const status = typeof deps.getStatus === "function" ? call(deps.getStatus, null) : null;
    return { available: true,
      cycles: v.cycles.map((c) => ({ cycleAt: c.cycleAt, state: c.state, source: c.source, reason: c.reason,
        attempts: c.attempts })),
      threads: v.threads.map((t) => threadRowOf(t, now)),
      counters: status && status.counters ? status.counters : null, generatedAt: now };
  }

  return { title: "Game Master", order: PANEL_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ID, PANEL_ORDER, threadRowOf, buildGameMasterPanel };
