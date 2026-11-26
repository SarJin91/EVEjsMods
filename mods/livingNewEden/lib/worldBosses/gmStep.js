"use strict";

const S = require("./schema");
const M = require("./machine");

const OPEN_SCAN_LIMIT = 16;
const WON = "WON";
const LOST = "LOST";
const PROMPT_HINT = "BOSS: a roaming world boss near the anchor, defeated by anyone = won, gone = lost (no params)";

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function bossStepKind(env) {
  const { repo, settings: P } = env;
  const getGraph = () => safe(() => (typeof env.getGraph === "function" ? env.getGraph() : null), null);
  const pollDue = (now) => now + P.gm.pollMs;

  return Object.freeze({
    type: S.GM_STEP_TYPE,
    owner: S.GM_OWNER,
    version: 1,
    promptHint: PROMPT_HINT,
    maxPerThread: 1,
    duration: Object.freeze({ minMs: P.gm.pollMs, maxMs: Math.max(P.gm.pollMs, P.maxLifetimeMs) }),
    validate(params) {
      const p = params && typeof params === "object" ? params : {};
      if (Object.keys(p).length > 0) return { ok: false, reason: "UNKNOWN_PARAM" };
      return { ok: true, params: {} };
    },
    startInTx(tx, s) {
      const none = { ok: false, reason: "NO_BOSS", retry: false };
      if (typeof env.isRunning === "function" && env.isRunning() !== true) return none;
      const graph = getGraph();
      if (!graph || !Number.isSafeInteger(s.systemId) || s.systemId <= 0) return none;
      const open = safe(() => repo.listOpenInTx(tx, OPEN_SCAN_LIMIT), null);
      if (!open || open.ok !== true || open.rows.length === 0) return none;
      const dist = M.bfsFromMany(graph, [s.systemId], P.gm.rangeJumps, P.spawnMaxBfsSystems);
      let best = null;
      for (const row of open.rows) {
        const jumps = dist.get(row.systemId);
        if (jumps === undefined) continue;
        if (!best || jumps < best.jumps || (jumps === best.jumps && row.bossId < best.bossId)) {
          best = { bossId: row.bossId, jumps };
        }
      }
      if (!best) return none;
      return { ok: true, handle: { bossId: best.bossId }, dueAt: pollDue(s.now) };
    },
    pollInTx(tx, s) {
      const bossId = s.handle && typeof s.handle.bossId === "string" ? s.handle.bossId : null;
      if (!bossId) return { state: "DONE", outcome: LOST };
      const got = safe(() => repo.getInTx(tx, bossId), null);
      if (!got || got.ok !== true) return { state: "RUNNING", dueAt: pollDue(s.now) };
      const row = got.row;
      if (!row) return { state: "DONE", outcome: LOST };
      if (row.state === S.STATES.DEFEATED) return { state: "DONE", outcome: WON };
      if (row.state === S.STATES.EXPIRED || row.state === S.STATES.CANCELLED) return { state: "DONE", outcome: LOST };
      return { state: "RUNNING", dueAt: pollDue(s.now) };
    },
    cancelInTx() {
      return { ok: true };
    },
  });
}

module.exports = { bossStepKind, PROMPT_HINT };
