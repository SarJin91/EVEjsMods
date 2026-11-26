"use strict";

const { performance } = require("node:perf_hooks");
const { parseSeedScope, indexOverrides, planSystemControl } = require("./controlPlan");
const {
  SEED_VERSION, SEED_DONE_EVENT, SEED_AGGREGATE_TYPE, SEED_AGGREGATE_ID, SEED_WORK_CLASS, systemSeedKey, seedDoneKey,
} = require("./data/seedData");
const { CONTROL_OVERRIDES, CONTROL_OVERRIDES_VERSION } = require("./data/controlOverrides");

const STATE = Object.freeze({
  IDLE: "idle", DISABLED: "disabled", WAITING_GRAPH: "waiting_graph", RUNNING: "running", DEFERRED: "deferred",
  DONE: "done", ALREADY_APPLIED: "already_applied", SKIPPED: "skipped", FAILED: "failed", STOPPED: "stopped",
});

const MAX_CONFLICT_LINES = 5;
const MAX_DETAIL_LENGTH = 200;
const MS_DECIMALS = 10;
const SLICE_REFUSED = Object.freeze({ sliceRefused: true });
const CLOSED_REASONS = Object.freeze(["STORE_CLOSED", "STORE_SUSPENDED"]);

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function round1(ms) {
  return Math.round(ms * MS_DECIMALS) / MS_DECIMALS;
}

function defaultDefer(fn) {
  const handle = setImmediate(fn);
  return { cancel: () => clearImmediate(handle) };
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return { cancel: () => clearTimeout(handle), hasRef: () => Boolean(handle && handle.hasRef && handle.hasRef()) };
}

function detailOf(result) {
  if (!result || typeof result !== "object") return "";
  const parts = [];
  if (result.detail !== undefined && result.detail !== null) parts.push(String(result.detail));
  if (result.rows !== undefined) parts.push(`rows=${result.rows}`);
  if (result.limit !== undefined) parts.push(`limit=${result.limit}`);
  if (result.code) parts.push(`code=${result.code}`);
  if (result.error && !result.code) parts.push(messageOf(result.error));
  if (result.systemId !== undefined) parts.push(`system=${result.systemId}`);
  return parts.join(" ").slice(0, MAX_DETAIL_LENGTH);
}

function createControlSeed(deps) {
  const { store, journal, repository, adapter } = deps;
  const graphService = deps.graph || null;
  const settings = deps.settings || {};
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const overrides = deps.overrides === undefined ? CONTROL_OVERRIDES : deps.overrides;
  const overridesVersion = deps.overridesVersion === undefined ? CONTROL_OVERRIDES_VERSION : deps.overridesVersion;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const defer = typeof deps.defer === "function" ? deps.defer : defaultDefer;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const wallNow = deps.clock && typeof deps.clock.now === "function" ? () => deps.clock.now() : () => 0;

  const status = {
    state: STATE.IDLE, reason: null, detail: null, scope: null,
    planned: 0, cursor: 0, created: 0, duplicates: 0, existing: 0, conflicts: 0,
    controlled: 0, uncontrolled: 0, slices: 0, deferrals: 0,
    sdeBuild: null, markerSdeBuild: null, startedAt: null, finishedAt: null, seq: 0,
  };
  let pending = null;
  let ids = [];
  let graph = null;
  let overrideIndex = null;
  let tag = null;
  let runStartedMs = 0;
  let conflictLines = 0;

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function setState(state, reason, detail) {
    status.state = state;
    status.reason = reason === undefined ? null : reason;
    status.detail = detail === undefined || detail === "" ? null : detail;
    status.seq += 1;
  }

  const stopped = () => status.state === STATE.STOPPED;

  function fail(reason, detail) {
    setState(STATE.FAILED, String(reason), detail);
    status.finishedAt = wallNow();
    metric("count", "world.seed.failures", 1);
    log(`control seed: failed ${reason}${detail ? ` (${detail})` : ""} after ${status.slices} slices; `
      + "next start resumes");
  }

  function schedule(fn, ms) {
    const guarded = () => {
      pending = null;
      if (stopped()) return;
      try {
        fn();
      } catch (err) {
        if (!stopped()) fail("SEED_SLICE_THREW", messageOf(err));
      }
    };
    pending = ms === undefined ? defer(guarded) : setTimer(guarded, ms);
  }

  function readSdeBuild() {
    let r;
    try {
      r = adapter.readSdeBuild();
    } catch (err) {
      r = { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: messageOf(err) };
    }
    if (r && r.ok) return r.build;
    log(`control seed: sdeBuild unavailable - ${(r && r.reason) || "no_result"}`
      + `${r && r.detail ? ` (${r.detail})` : ""}; recorded as null`);
    return null;
  }

  function systemsInScope(classes) {
    const out = [];
    for (const secClass of classes) out.push(...graph.getSystemsBySecClass(secClass));
    return out.sort((a, b) => a - b);
  }

  function onGraph(res) {
    if (stopped()) return;
    if (!res || res.ok !== true || !res.graph) {
      const reason = String((res && res.reason) || "GRAPH_UNAVAILABLE");
      setState(STATE.SKIPPED, reason, res && res.detail);
      log(`control seed: skipped ${reason}${res && res.detail ? ` (${res.detail})` : ""}`);
      return;
    }
    if (!adapter || typeof adapter.resolveSystemFactions !== "function" || typeof adapter.readSdeBuild !== "function") {
      setState(STATE.SKIPPED, "ADAPTER_UNAVAILABLE");
      log("control seed: skipped ADAPTER_UNAVAILABLE");
      return;
    }
    graph = res.graph;
    const scope = parseSeedScope(settings.seedScope);
    if (!scope.ok) {
      fail(scope.reason, scope.detail);
      return;
    }
    tag = scope.tag;
    status.scope = tag;
    const indexed = indexOverrides(overrides);
    if (!indexed.ok) {
      fail(indexed.reason, indexed.detail);
      return;
    }
    overrideIndex = indexed.index;
    ids = systemsInScope(scope.classes);
    status.planned = ids.length;
    metric("gauge", "world.seed.planned", ids.length);
    if (ids.length === 0) {
      fail("SEED_SCOPE_EMPTY", `scope=${tag}`);
      return;
    }
    status.sdeBuild = readSdeBuild();
    const found = store.transaction("world.seed.check", (tx) => journal.findByKey(tx, seedDoneKey(tag)));
    if (!found.ok || !found.value || !found.value.ok) {
      const r = found.ok ? found.value : found;
      fail((r && r.reason) || "TX_FAILED", detailOf(r));
      return;
    }
    if (found.value.found) {
      const payload = found.value.entry.payload || {};
      status.markerSdeBuild = Number.isSafeInteger(payload.sdeBuild) ? payload.sdeBuild : null;
      setState(STATE.ALREADY_APPLIED);
      log(`control seed: already applied (scope=${tag} systems=${payload.systems} sdeBuild=${status.markerSdeBuild})`);
      if (status.sdeBuild !== null && status.markerSdeBuild !== null && status.sdeBuild !== status.markerSdeBuild) {
        log(`control seed: sdeBuild changed ${status.markerSdeBuild} -> ${status.sdeBuild}; world state kept`);
      }
      return;
    }
    status.startedAt = wallNow();
    runStartedMs = nowMs();
    setState(STATE.RUNNING);
    log(`control seed: start scope=${tag} systems=${ids.length} slice=${settings.seedSliceSystems} `
      + `sdeBuild=${status.sdeBuild}`);
    schedule(slice);
  }

  function slice() {
    if (status.state !== STATE.RUNNING && status.state !== STATE.DEFERRED) return;
    const governor = getGovernor();
    if (governor && typeof governor.admits === "function" && governor.admits(SEED_WORK_CLASS) === false) {
      status.deferrals += 1;
      setState(STATE.DEFERRED, "GOVERNOR_HOLD");
      metric("count", "world.seed.deferrals", 1);
      schedule(slice, settings.seedDeferMs);
      return;
    }
    if (status.state === STATE.DEFERRED) setState(STATE.RUNNING);
    const batch = ids.slice(status.cursor, status.cursor + settings.seedSliceSystems);
    const resolved = adapter.resolveSystemFactions(batch);
    if (!resolved || resolved.ok !== true) {
      fail((resolved && resolved.reason) || "FACTION_POLICY_FAILED", detailOf(resolved));
      return;
    }
    const factions = new Map(resolved.entries.map((e) => [e.systemId, e]));
    const t0 = nowMs();
    const local = { processed: 0, created: 0, duplicates: 0, existing: 0, conflicts: 0, controlled: 0,
      uncontrolled: 0, conflictIds: [] };
    let refusal = null;
    const settingsOfPlan = { controllerInfluence: settings.seedControllerInfluence,
      sdeFactionInfluence: settings.seedSdeFactionInfluence,
      ...(typeof deps.bastionOf === "function" ? { bastionOf: deps.bastionOf } : {}) };
    const tx = store.transaction("world.seed", (db) => {
      for (const systemId of batch) {
        const vertex = graph.getSystem(systemId);
        if (!vertex) {
          refusal = { reason: "SEED_SYSTEM_MISSING", systemId };
          throw SLICE_REFUSED;
        }
        const { change } = planSystemControl(vertex, factions.get(systemId) || null, overrideIndex, settingsOfPlan);
        const r = repository.applyChange(db, change, systemSeedKey(systemId));
        if (r.ok && r.duplicate) local.duplicates += 1;
        else if (r.ok) local.created += 1;
        else if (r.reason === "SYSTEM_EXISTS") local.existing += 1;
        else if (r.reason === "IDEMPOTENCY_CONFLICT") {
          local.conflicts += 1;
          local.conflictIds.push(systemId);
        } else {
          refusal = { ...r, systemId };
          throw SLICE_REFUSED;
        }
        if (r.ok && change.state.controllerFactionId === null) local.uncontrolled += 1;
        else if (r.ok) local.controlled += 1;
        local.processed += 1;
        if (nowMs() - t0 >= settings.seedSliceMs) break;
      }
      return local.processed;
    });
    const sliceMs = nowMs() - t0;
    metric("observe", "world.seed.sliceMs", sliceMs);
    if (!tx.ok) {
      if (tx.error === SLICE_REFUSED && refusal) {
        fail(refusal.reason || "SEED_REFUSED", detailOf(refusal));
        return;
      }
      if (stopped() || CLOSED_REASONS.includes(tx.reason)) return;
      fail(tx.reason || "TX_FAILED", detailOf(tx));
      return;
    }
    for (const key of ["created", "duplicates", "existing", "conflicts", "controlled", "uncontrolled"]) {
      status[key] += local[key];
    }
    for (const key of ["created", "duplicates", "existing", "conflicts"]) {
      if (local[key] > 0) metric("count", `world.seed.${key}`, local[key]);
    }
    for (const systemId of local.conflictIds) {
      if (conflictLines >= MAX_CONFLICT_LINES) break;
      conflictLines += 1;
      log(`control seed: conflict system=${systemId} (state kept)`);
    }
    status.cursor += local.processed;
    status.slices += 1;
    status.seq += 1;
    metric("count", "world.seed.slices", 1);
    if (status.cursor < ids.length) {
      schedule(slice);
      return;
    }
    writeMarker();
  }

  function writeMarker() {
    const spec = {
      key: seedDoneKey(tag),
      aggregate: { type: SEED_AGGREGATE_TYPE, id: SEED_AGGREGATE_ID },
      eventType: SEED_DONE_EVENT,
      payload: { seedVersion: SEED_VERSION, scope: tag, systems: ids.length, sdeBuild: status.sdeBuild,
        overridesVersion },
    };
    const tx = store.transaction("world.seed.done", (db) => journal.applyOnce(db, spec, () => ({ ok: true })));
    const r = tx.ok ? tx.value : tx;
    if (!tx.ok || !r || !r.ok) {
      if (!tx.ok && (stopped() || CLOSED_REASONS.includes(tx.reason))) return;
      fail((r && r.reason) || "SEED_MARKER_FAILED", detailOf(r));
      return;
    }
    status.markerSdeBuild = status.sdeBuild;
    status.finishedAt = wallNow();
    setState(STATE.DONE);
    const ms = round1(nowMs() - runStartedMs);
    log(`control seed: ${ids.length} systems (created=${status.created} duplicates=${status.duplicates} `
      + `existing=${status.existing} conflicts=${status.conflicts}) controlled=${status.controlled} `
      + `uncontrolled=${status.uncontrolled} slices=${status.slices} deferrals=${status.deferrals} in ${ms}ms`);
  }

  function start() {
    if (status.state !== STATE.IDLE) return;
    try {
      if (settings.seedEnabled !== true) {
        setState(STATE.DISABLED, "disabled_by_config");
        log("control seed: disabled (world.seedEnabled=false)");
        return;
      }
      if (!graphService || typeof graphService.whenReady !== "function") {
        setState(STATE.SKIPPED, "GRAPH_UNAVAILABLE");
        log("control seed: skipped GRAPH_UNAVAILABLE");
        return;
      }
      setState(STATE.WAITING_GRAPH);
      Promise.resolve(graphService.whenReady())
        .then((res) => {
          try {
            onGraph(res);
          } catch (err) {
            if (!stopped()) fail("SEED_START_THREW", messageOf(err));
          }
        })
        .catch(noop);
    } catch (err) {
      fail("SEED_START_THREW", messageOf(err));
    }
  }

  function stop(reason) {
    if (stopped()) return;
    const handle = pending;
    pending = null;
    setState(STATE.STOPPED, reason === undefined ? null : String(reason));
    try {
      if (handle && typeof handle.cancel === "function") handle.cancel();
    } catch (_err) {
    }
  }

  function getStatus() {
    return Object.freeze({ ...status });
  }

  return Object.freeze({ start, stop, getStatus });
}

module.exports = { STATE, createControlSeed, defaultSetTimer };
