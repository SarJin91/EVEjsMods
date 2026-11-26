"use strict";

const { STATE: SEED_STATE } = require("../world/controlSeed");
const { createAbortSentinel } = require("../persistence/store");

const SEED_PENDING_STATES = Object.freeze([SEED_STATE.IDLE, SEED_STATE.WAITING_GRAPH, SEED_STATE.RUNNING,
  SEED_STATE.DEFERRED]);
const GRANT_KEY_PREFIX = "strategy:core:grant:v1:";
const EVENT_TYPE = "CORE_GRANT";
const AGGREGATE_TYPE = "world_system";
const OUTCOMES = Object.freeze(["GRANTED", "OWNED", "DONE", "NO_ROW", "BUSY"]);
const GRANT_REFUSED = createAbortSentinel("strategy.coreGrant.refused");

const grantKey = (factionId, systemId) => `${GRANT_KEY_PREFIX}${factionId}:${systemId}`;

function grantPairs(cores, registry) {
  const active = new Set(registry.listActiveFactions().map((f) => f.factionId));
  const pairs = [];
  for (const core of cores || []) {
    if (!core || core.grantControl !== true || !active.has(core.factionId)) continue;
    for (const systemId of core.systemIds || []) pairs.push({ factionId: core.factionId, systemId });
  }
  return pairs;
}

function grantOne(deps, pair) {
  const { store, journal, worldRepository, settings } = deps;
  const { factionId: K, systemId } = pair;
  const key = grantKey(K, systemId);
  let refusal = null;
  let decided = null;
  const tx = store.transaction("strategy.coreGrant", (db) => {
    const r = journal.applyOnce(db, { key, aggregate: { type: AGGREGATE_TYPE, id: systemId }, eventType: EVENT_TYPE,
      payload: { factionId: K, systemId } }, (inner) => {
      const read = worldRepository.getSystem(inner, systemId);
      if (!read.ok) return read;
      const sys = read.system;
      if (!sys) return { ok: false, reason: "NO_ROW", outcome: "NO_ROW" };
      if (sys.occupationState !== "STABLE" || sys.occupierFactionId !== null) {
        return { ok: false, reason: "BUSY", outcome: "BUSY",
          detail: `state=${sys.occupationState} occupier=${sys.occupierFactionId === null ? "none" : sys.occupierFactionId}` };
      }
      if (sys.controllerFactionId === K && sys.homeFactionId === K) {
        decided = { outcome: "OWNED" };
        return { ok: true };
      }
      const prev = sys.controllerFactionId;
      const own = (sys.influence || []).find((i) => i.factionId === K);
      const score = Math.max(own ? own.influenceScore : 0, settings.baselineScore);
      const state = { controllerFactionId: K, occupierFactionId: null, capturedAt: null, detachedSinceAt: null };
      if (prev !== null && prev !== K) state.previousControllerFactionId = prev;
      const changed = worldRepository.applyChange(inner, { systemId, expectedVersion: sys.version, reason: EVENT_TYPE,
        state, influence: [{ factionId: K, influenceScore: score }] }, `${key}:world`);
      if (!changed.ok) return changed;
      const home = worldRepository.setHomeInTx(inner, systemId, K);
      if (!home.ok) return home;
      decided = { outcome: "GRANTED", previous: prev };
      return { ok: true };
    });
    if (!r.ok) {
      refusal = r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r;
      throw GRANT_REFUSED;
    }
    if (r.duplicate) decided = { outcome: "DONE" };
    return true;
  });
  if (!tx.ok) {
    if (tx.reason === "TX_ABORTED" && tx.error === GRANT_REFUSED && refusal) {
      if (refusal.outcome === "NO_ROW" || refusal.outcome === "BUSY") {
        return { ...pair, outcome: refusal.outcome, ...(refusal.detail ? { detail: refusal.detail } : {}) };
      }
      return { ...pair, reason: String(refusal.reason || "GRANT_REFUSED"),
        ...(refusal.detail ? { detail: String(refusal.detail) } : {}) };
    }
    return { ...pair, reason: String(tx.reason || "TX_FAILED"), ...(tx.detail ? { detail: String(tx.detail) } : {}) };
  }
  return { ...pair, ...decided };
}

function runCoreGrant(deps) {
  try {
    if (!deps || !deps.store || !deps.journal || !deps.registry) {
      return { ok: false, reason: "CORE_GRANT_INVALID_INPUT", detail: "store, journal and registry required" };
    }
    if (!deps.worldRepository) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const baseline = deps.settings && deps.settings.baselineScore;
    if (typeof baseline !== "number" || !Number.isFinite(baseline)) {
      return { ok: false, reason: "CORE_GRANT_INVALID_INPUT", detail: "settings.baselineScore" };
    }
    const out = { granted: 0, owned: 0, skipped: 0, results: [] };
    for (const pair of grantPairs(deps.cores, deps.registry)) {
      const res = grantOne(deps, pair);
      out.results.push(res);
      if (res.outcome === "GRANTED") out.granted += 1;
      else if (res.outcome === "OWNED") out.owned += 1;
      else if (res.outcome !== "DONE") out.skipped += 1;
    }
    return { ok: true, ...out };
  } catch (err) {
    return { ok: false, reason: "CORE_GRANT_THREW", detail: String((err && err.message) || err) };
  }
}

function coreGrantLogLine(r, seedState) {
  if (!r || r.outcome === "DONE" || r.outcome === "OWNED") return null;
  const head = `strategy: core grant ${r.factionId} ${r.systemId}`;
  if (r.outcome === "GRANTED") return `${head} GRANTED prev=${r.previous === null ? "none" : r.previous}`;
  if (r.outcome === "NO_ROW") {
    const state = typeof seedState === "string" && seedState !== "" ? seedState : "unknown";
    return SEED_PENDING_STATES.includes(state)
      ? `${head} NO_ROW (control seed ${state}: a fresh world gets the core from CONTROL_OVERRIDES; `
        + "the next start writes the marker)"
      : `${head} NO_ROW (control seed ${state}); next start retries`;
  }
  const what = r.outcome || `refused ${r.reason}`;
  return `${head} ${what}${r.detail ? ` (${r.detail})` : ""}; next start retries`;
}

module.exports = { runCoreGrant, grantKey, coreGrantLogLine, GRANT_KEY_PREFIX, OUTCOMES };
