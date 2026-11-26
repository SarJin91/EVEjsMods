"use strict";

const { createPoller } = require("../../presence/poller");
const { deriveSeed } = require("../../util/rng");
const { DESTROYED_STATION_STATE } = require("../schema");
const { OPS, REMOVE_REASONS, SEAM_REASONS, projectionKey } = require("./schema");
const { desiredStructure, desiredFingerprint, planPass, placementCandidates } = require("./projection");

const MODE = Object.freeze({ PROJECT: "project", CLEANUP: "cleanup", OFF: "off" });
const STATE = Object.freeze({ RUNNING: "running", STOPPED: "stopped" });
const UPWELL_KIND = "upwell";
const WORK_CLASS = "OPERATIONAL";
const STATIONS_READY = "ready";
const PLACEMENT_SEED_KIND = "structurePlacement";
const COUNTER_NAMES = Object.freeze(["created", "adopted", "updated", "destroyed", "removed", "foreignChange",
  "placementFailed", "skipped", "seamError", "flushFailed", "passDeferred", "recordRefused", "createRefused",
  "nativeDestroyed", "nativeIgnored", "nativeRefused", "destroyMarkFailed"]);
const MARK_FAILED = "MARK_FAILED";
const NATIVE_TAKEN = Object.freeze(["DESTROYED", "DUPLICATE"]);
const NATIVE_OP = "NATIVE";
const METRIC_PASS_MS = "structures.passMs";
const MS_DECIMALS = 1000;
const MAX_DETAIL = 120;
const ALL_OPS = Number.MAX_SAFE_INTEGER;
const RELIST_REASONS = Object.freeze([SEAM_REASONS.TAG_MISMATCH, SEAM_REASONS.NOT_FOUND, SEAM_REASONS.DESTROYED,
  SEAM_REASONS.ALREADY_TAGGED]);
const SEAM_FAULTS = Object.freeze([SEAM_REASONS.SEAM_ERROR, SEAM_REASONS.UNAVAILABLE]);
const BLOCKING_CREATE_REASONS = Object.freeze([SEAM_REASONS.INVALID_INPUT, SEAM_REASONS.TAG_REQUIRED,
  SEAM_REASONS.TYPE_UNKNOWN]);
const WAITING_CREATE_REASONS = Object.freeze([SEAM_REASONS.WRITE_FAILED]);
const REDO_REMOVE_REASONS = Object.freeze([REMOVE_REASONS.RECREATE, REMOVE_REASONS.NOT_PROJECTED]);
const OUTCOME = Object.freeze({ DONE: "done", FAILED: "failed", WAIT: "wait" });
const CLEANUP_STATUS = Object.freeze({ RUNNING: "running", DONE: "done" });

const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const reasonOf = (r) => String((r && r.reason) || "NO_RESULT");
const isLiveView = (v) => Boolean(v) && v.destroyedAt === null;
const byStructureId = (a, b) => a.structureId - b.structureId;

function createStructuresService(deps) {
  const { seam, states, store, clock, worldSeed, settings, mode } = deps;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getStations = typeof deps.getStations === "function" ? deps.getStations : () => null;
  const getSiege = typeof deps.getSiege === "function" ? deps.getSiege : () => null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const cfg = Object.freeze({ dockingAccess: settings.dockingAccess, quantumCore: settings.quantumCore === true });

  const applied = new Map();
  const dirty = new Set();
  const placementBlocked = new Set();
  const placementCursor = new Map();
  const createWait = new Set();
  const placementRetry = new Set();
  const bindings = new Map();
  const removeHold = new Map();
  let needFull = true;
  let projected = 0;
  let poller = null;
  let unsubscribe = null;
  const status = { state: STATE.RUNNING, seq: 0, passes: 0, lastPassAt: null, lastFullAt: null, lastPeriodicAt: null,
    lastError: null, remaining: null, cleanup: null, lastChecks: 0, lastWrites: 0,
    counters: Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0])) };

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function count(name, n = 1) {
    status.counters[name] += n;
    status.seq += 1;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`structures.${name}`, n);
    } catch (_err) {
    }
  }

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_PASS_MS, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  function note(stationId, patch) {
    const cur = bindings.get(stationId) || { structureId: null, lastOp: null, lastError: null, at: null };
    bindings.set(stationId, Object.freeze({ ...cur, ...patch }));
    status.seq += 1;
  }

  function refused(stationId, op, r) {
    const reason = reasonOf(r);
    if (SEAM_FAULTS.includes(reason)) count("seamError");
    if (RELIST_REASONS.includes(reason) || SEAM_FAULTS.includes(reason)) needFull = true;
    status.lastError = `${op}:${reason}`;
    if (stationId) note(stationId, { lastOp: op, lastError: reason, at: clock.now() });
    return OUTCOME.FAILED;
  }

  function admitted() {
    let governor = null;
    try {
      governor = getGovernor();
    } catch (_err) {
      governor = null;
    }
    if (!governor || typeof governor.admits !== "function") return true;
    try {
      return governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function currentStations() {
    try {
      const s = getStations();
      return s && typeof s.getMode === "function" && s.getMode() === STATIONS_READY && s.repository ? s : null;
    } catch (_err) {
      return null;
    }
  }

  const fingerprintOf = (rec, now) => desiredFingerprint(desiredStructure(rec, now, cfg, states));

  function readStations(repository, extraIds) {
    const tx = store.transaction("structures.read", (db) => {
      const r = repository.listLiveStations(db);
      if (!r.ok) return r;
      const live = r.records.filter((rec) => rec.kind === UPWELL_KIND);
      const liveIds = new Set(live.map((rec) => rec.stationId));
      const extra = [];
      const missing = [];
      for (const id of extraIds) {
        if (liveIds.has(id)) continue;
        const g = repository.getStation(db, id);
        if (!g.ok) return g;
        if (g.record) extra.push(g.record);
        else missing.push(id);
      }
      return { ok: true, records: live.concat(extra), extraIds: extra.map((rec) => rec.stationId), missing,
        truncated: r.truncated === true };
    });
    if (!tx.ok) return { ok: false, reason: tx.reason };
    const value = tx.value;
    if (!value || !value.ok) return { ok: false, reason: reasonOf(value) };
    if (value.truncated) log("structures: listLiveStations truncated (stations.maxStations) - missing rows looked up");
    return value;
  }

  function fullInput(repository) {
    const listed = seam.listTaggedStructures();
    if (!listed.ok) return listed;
    const tagged = new Map();
    let live = 0;
    for (const view of listed.rows) {
      if (!view || !view.tag) continue;
      if (!tagged.has(view.tag.stationId)) tagged.set(view.tag.stationId, []);
      tagged.get(view.tag.stationId).push(view);
      if (isLiveView(view)) live += 1;
    }
    const extraIds = new Set(applied.keys());
    for (const [id, views] of tagged) if (views.some(isLiveView)) extraIds.add(id);
    const read = readStations(repository, [...extraIds].sort());
    if (!read.ok) return read;
    projected = live;
    return { ok: true, full: true, records: read.records, missing: read.missing, tagged, dirty: null };
  }

  function incrementalInput(repository, now, pending) {
    const read = readStations(repository, [...applied.keys()].sort());
    if (!read.ok) return read;
    const scope = new Set();
    for (const id of pending) if (!placementBlocked.has(id)) scope.add(id);
    for (const id of read.extraIds) scope.add(id);
    for (const id of read.missing) scope.add(id);
    for (const rec of read.records) {
      if (rec.state === DESTROYED_STATION_STATE || placementBlocked.has(rec.stationId)) continue;
      if (applied.get(rec.stationId) !== fingerprintOf(rec, now)) scope.add(rec.stationId);
    }
    const byId = new Map(read.records.map((rec) => [rec.stationId, rec]));
    const tagged = new Map();
    for (const id of scope) {
      const rec = byId.get(id);
      if (createWait.has(id) && rec && rec.state !== DESTROYED_STATION_STATE) {
        tagged.set(id, []);
        continue;
      }
      const bound = bindings.get(id);
      const structureId = (bound && bound.structureId) || (rec && rec.evejsItemId) || null;
      if (!structureId) return { ok: true, unknown: true };
      const g = seam.getStructure(structureId);
      if (!g.ok) return g;
      const view = g.row;
      if (!view || !view.tag || view.tag.stationId !== id || view.tag.world !== worldSeed) {
        return { ok: true, unknown: true };
      }
      tagged.set(id, [view]);
    }
    return { ok: true, full: false, records: read.records, missing: read.missing, tagged, dirty: scope };
  }

  function forgetGone(input) {
    const known = new Set(input.records.map((rec) => rec.stationId));
    for (const map of [applied, placementCursor, bindings]) {
      for (const id of [...map.keys()]) if (!known.has(id)) map.delete(id);
    }
    for (const set of [placementRetry, placementBlocked, createWait]) {
      for (const id of [...set]) if (!known.has(id)) set.delete(id);
    }
  }

  function choosePosition(op, rec, budget) {
    const candidates = rec && rec.position ? [rec.position] : [];
    let anchorsRead = false;
    for (let i = placementCursor.get(op.stationId) || 0; ; i += 1) {
      if (i >= candidates.length) {
        if (anchorsRead) return { ok: false, reason: "NO_POSITION" };
        anchorsRead = true;
        const anchors = seam.listPlacementAnchors(op.desired.systemId);
        if (!anchors.ok) return anchors;
        candidates.push(...placementCandidates({ seed: deriveSeed(worldSeed, PLACEMENT_SEED_KIND, op.stationId),
          anchors: anchors.anchors, clearanceM: settings.placementClearanceM, attempts: settings.placementAttempts }));
        if (i >= candidates.length) return { ok: false, reason: "NO_POSITION" };
      }
      if (budget.checks <= 0) {
        placementCursor.set(op.stationId, i);
        return { ok: false, reason: "CHECK_BUDGET" };
      }
      budget.checks -= 1;
      status.lastChecks += 1;
      const v = seam.validatePlacement({ systemId: op.desired.systemId, typeId: op.desired.typeId,
        position: candidates[i] });
      if (!v.ok) {
        placementCursor.set(op.stationId, i);
        return v;
      }
      if (v.valid) return { ok: true, position: candidates[i] };
    }
  }

  function forgetPlacement(stationId) {
    placementCursor.delete(stationId);
    createWait.delete(stationId);
    placementRetry.delete(stationId);
  }

  function block(stationId, reason, now) {
    placementBlocked.add(stationId);
    placementCursor.delete(stationId);
    createWait.delete(stationId);
    note(stationId, { lastOp: OPS.CREATE, lastError: reason, at: now });
    return OUTCOME.WAIT;
  }

  function waitCreate(stationId, reason, now) {
    createWait.add(stationId);
    if (reason) note(stationId, { lastOp: OPS.CREATE, lastError: reason, at: now });
    return OUTCOME.WAIT;
  }

  function nativeDestruction(op, now, ctx) {
    let siege = null;
    try {
      siege = getSiege();
    } catch (_err) {
      siege = null;
    }
    let r = { ok: true, outcome: "SIEGE_OFF" };
    if (siege && typeof siege.applyNativeDestruction === "function") {
      ctx.writes += 1;
      try {
        r = siege.applyNativeDestruction({ stationId: op.stationId, structureId: op.foreignDestroyed.structureId,
          destroyedAt: op.foreignDestroyed.destroyedAt, at: now });
      } catch (err) {
        r = { ok: false, reason: `THREW:${detailOf(err)}` };
      }
    }
    if (!r || r.ok !== true) {
      count("nativeRefused");
      status.lastError = `${NATIVE_OP}:${reasonOf(r)}`;
      note(op.stationId, { lastOp: NATIVE_OP, lastError: reasonOf(r), at: now });
      dirty.add(op.stationId);
      return OUTCOME.WAIT;
    }
    if (NATIVE_TAKEN.includes(r.outcome)) {
      if (r.outcome === "DESTROYED") count("nativeDestroyed");
      note(op.stationId, { lastOp: NATIVE_OP, lastError: null, at: now });
      return OUTCOME.DONE;
    }
    count("nativeIgnored");
    return null;
  }

  function execCreate(op, rec, now, ctx) {
    if (op.foreignDestroyed && settings.nativeDestructionEnabled === true) {
      const native = nativeDestruction(op, now, ctx);
      if (native !== null) return native;
      if (ctx.writes >= settings.maxWritesPerPass) return waitCreate(op.stationId, null, now);
    }
    if (projected >= settings.maxProjected) {
      count("skipped");
      return block(op.stationId, "MAX_PROJECTED", now);
    }
    const known = seam.isStructureTypeKnown(op.desired.typeId);
    if (!known.ok) {
      if (BLOCKING_CREATE_REASONS.includes(reasonOf(known))) {
        count("createRefused");
        status.lastError = `${OPS.CREATE}:${reasonOf(known)}`;
        return block(op.stationId, reasonOf(known), now);
      }
      return refused(op.stationId, OPS.CREATE, known);
    }
    if (!known.known) {
      count("createRefused");
      status.lastError = `${OPS.CREATE}:${SEAM_REASONS.TYPE_UNKNOWN}`;
      return block(op.stationId, SEAM_REASONS.TYPE_UNKNOWN, now);
    }
    const place = choosePosition(op, rec, ctx.budget);
    if (!place.ok) {
      if (place.reason === "CHECK_BUDGET") {
        count("skipped");
        return waitCreate(op.stationId, "CHECK_BUDGET", now);
      }
      if (place.reason !== "NO_POSITION") return refused(op.stationId, OPS.CREATE, place);
      count("placementFailed");
      placementRetry.add(op.stationId);
      return block(op.stationId, "NO_POSITION", now);
    }
    const d = op.desired;
    const r = seam.createTaggedStructure({ tag: op.tag, typeId: d.typeId, systemId: d.systemId,
      ownerCorpId: d.ownerCorpId, name: d.name, position: place.position, state: d.state, stateEndsAt: d.stateEndsAt,
      condition: d.condition, docking: d.docking, quantumCore: d.quantumCore, at: now });
    if (r.ok) {
      ctx.writes += 1;
      projected += 1;
      count("created");
      if (ctx.foreign(op.stationId)) count("foreignChange");
      ctx.records.set(op.stationId, { structureId: r.structureId, position: place.position });
      forgetPlacement(op.stationId);
      note(op.stationId, { structureId: r.structureId, lastOp: OPS.CREATE, lastError: null, at: now });
      return OUTCOME.DONE;
    }
    const reason = reasonOf(r);
    if (reason === SEAM_REASONS.ALREADY_TAGGED && Number.isSafeInteger(r.structureId)) {
      const g = seam.getStructure(r.structureId);
      if (g.ok && g.row) {
        count("adopted");
        ctx.records.set(op.stationId, { structureId: r.structureId, position: g.row.position });
        note(op.stationId, { structureId: r.structureId, lastOp: "ADOPT", lastError: null, at: now });
      }
      needFull = true;
      return OUTCOME.WAIT;
    }
    if (BLOCKING_CREATE_REASONS.includes(reason)) {
      count("createRefused");
      status.lastError = `${OPS.CREATE}:${reason}`;
      return block(op.stationId, reason, now);
    }
    if (WAITING_CREATE_REASONS.includes(reason)) {
      status.lastError = `${OPS.CREATE}:${reason}`;
      return waitCreate(op.stationId, reason, now);
    }
    return refused(op.stationId, OPS.CREATE, r);
  }

  function execUpdate(op, now, ctx) {
    const r = seam.updateTaggedStructure(op.structureId, op.tag, { ...op.patch, at: now });
    if (!r.ok) return refused(op.stationId, OPS.UPDATE, r);
    ctx.writes += 1;
    count("updated");
    if (ctx.foreign(op.stationId)) count("foreignChange");
    note(op.stationId, { structureId: op.structureId, lastOp: OPS.UPDATE, lastError: null, at: now });
    return OUTCOME.DONE;
  }

  function execDestroy(op, now, ctx) {
    const r = seam.destroyTaggedStructure(op.structureId, op.tag, now);
    if (!r.ok) return refused(op.stationId, OPS.DESTROY, r);
    if (!r.alreadyDestroyed) {
      ctx.writes += 1;
      projected = Math.max(0, projected - 1);
      count("destroyed");
    }
    if (r.markFailed === true) {
      count("destroyMarkFailed");
      status.lastError = `${OPS.DESTROY}:${MARK_FAILED}`;
      log(`structures: destroy mark failed station=${op.stationId} structure=${op.structureId}`);
    }
    note(op.stationId, { structureId: op.structureId, lastOp: OPS.DESTROY, lastError: null, at: now });
    return OUTCOME.DONE;
  }

  function execRemove(op, now, ctx) {
    const held = removeHold.get(op.structureId);
    if (held !== undefined) {
      if (now - held < settings.fullReconcileMs) return OUTCOME.WAIT;
      removeHold.delete(op.structureId);
    }
    const r = seam.removeTaggedStructure(op.structureId, op.tag);
    if (r.ok) {
      ctx.writes += 1;
      projected = Math.max(0, projected - 1);
      count("removed");
      const bound = bindings.get(op.stationId);
      const structureId = bound && bound.structureId === op.structureId ? null : (bound ? bound.structureId : null);
      note(op.stationId, { structureId, lastOp: `${OPS.REMOVE}:${op.reason || "CLEANUP"}`, lastError: null, at: now });
      if (REDO_REMOVE_REASONS.includes(op.reason)) {
        dirty.add(op.stationId);
        return OUTCOME.WAIT;
      }
      return OUTCOME.DONE;
    }
    if (reasonOf(r) === SEAM_REASONS.NOT_EMPTY) {
      ctx.writes += 1;
      note(op.stationId, { lastOp: `${OPS.REMOVE}:${op.reason || "CLEANUP"}`, lastError: SEAM_REASONS.NOT_EMPTY,
        at: now });
      const destroyed = execDestroy(op, now, ctx);
      if (destroyed !== OUTCOME.DONE) {
        removeHold.set(op.structureId, now);
        return destroyed;
      }
      if (REDO_REMOVE_REASONS.includes(op.reason)) {
        dirty.add(op.stationId);
        return OUTCOME.WAIT;
      }
      return OUTCOME.DONE;
    }
    return refused(op.stationId, OPS.REMOVE, r);
  }

  function execOp(op, rec, now, ctx) {
    if (op.op === OPS.CREATE) return execCreate(op, rec, now, ctx);
    if (op.op === OPS.UPDATE) return execUpdate(op, now, ctx);
    if (op.op === OPS.DESTROY) return execDestroy(op, now, ctx);
    return execRemove(op, now, ctx);
  }

  function readInput(repository, now, pending) {
    const periodic = status.lastPeriodicAt === null || now - status.lastPeriodicAt >= settings.fullReconcileMs;
    let full = needFull || periodic;
    let input = null;
    if (!full) {
      input = incrementalInput(repository, now, pending);
      if (input.ok && input.unknown) full = true;
    }
    if (!full) return input;
    if (periodic) placementBlocked.clear();
    input = fullInput(repository);
    if (input.ok) {
      createWait.clear();
      forgetGone(input);
      needFull = false;
      status.lastFullAt = now;
      if (periodic) status.lastPeriodicAt = now;
    }
    return input;
  }

  function adoptions(input, plan, recordOf, ctx) {
    for (const [id, views] of input.tagged) {
      const rec = recordOf.get(id);
      const own = views.filter((v) => isLiveView(v) && v.tag.world === worldSeed).sort(byStructureId);
      if (!rec || rec.state === DESTROYED_STATION_STATE || own.length === 0 || ctx.records.has(id)) continue;
      const keep = own[0];
      if (plan.ops.some((op) => op.stationId === id && op.structureId === keep.structureId && op.op !== OPS.UPDATE)) {
        continue;
      }
      const bound = bindings.get(id);
      if (!bound || bound.structureId !== keep.structureId) note(id, { structureId: keep.structureId });
      if (rec.evejsItemId === keep.structureId && rec.position !== null) continue;
      count("adopted");
      ctx.records.set(id, { structureId: keep.structureId, position: keep.position });
    }
  }

  function projectPass() {
    const stations = currentStations();
    if (!stations) {
      status.lastError = "STATIONS_NOT_READY";
      return;
    }
    const repository = stations.repository;
    const now = clock.now();
    const pending = [...dirty];
    dirty.clear();
    const input = readInput(repository, now, pending);
    if (!input.ok) {
      for (const id of pending) dirty.add(id);
      refused(null, "READ", input);
      needFull = true;
      return;
    }
    const recordOf = new Map(input.records.map((rec) => [rec.stationId, rec]));
    const appliedView = new Map(applied);
    for (const id of placementBlocked) {
      const rec = recordOf.get(id);
      if (rec) appliedView.set(id, fingerprintOf(rec, now));
    }
    const plan = planPass({ live: input.records, tagged: input.tagged, dirty: input.dirty, applied: appliedView, now,
      cfg, states, world: worldSeed, maxWrites: ALL_OPS });
    if (plan.needsFullReconcile) needFull = true;

    const outcome = new Map();
    const mark = (id, o) => {
      const cur = outcome.get(id);
      if (cur !== OUTCOME.FAILED && cur !== OUTCOME.WAIT) outcome.set(id, o);
    };
    const ctx = { writes: 0, records: new Map(), budget: { checks: settings.placementChecksPerPass },
      foreign: (id) => {
        const rec = recordOf.get(id);
        return Boolean(rec) && applied.has(id) && applied.get(id) === fingerprintOf(rec, now);
      } };
    const isRetry = (op) => op.op === OPS.CREATE && placementRetry.has(op.stationId);
    const ops = plan.ops.filter((op) => !isRetry(op)).concat(plan.ops.filter(isRetry));
    for (const op of ops) {
      if (status.state !== STATE.RUNNING) return;
      if (op.op === OPS.CREATE && placementBlocked.has(op.stationId)) {
        mark(op.stationId, OUTCOME.WAIT);
        continue;
      }
      if (ctx.writes >= settings.maxWritesPerPass) {
        mark(op.stationId, op.op === OPS.CREATE ? waitCreate(op.stationId, null, now) : OUTCOME.WAIT);
        continue;
      }
      mark(op.stationId, execOp(op, recordOf.get(op.stationId), now, ctx));
    }
    for (const id of plan.unknown) mark(id, OUTCOME.WAIT);
    if (input.full) adoptions(input, plan, recordOf, ctx);
    status.lastWrites = ctx.writes;

    if (ctx.writes > 0 || ctx.records.size > 0) {
      const flushed = seam.flushStructures();
      if (!flushed.ok) {
        count("flushFailed");
        needFull = true;
        status.lastError = `FLUSH:${reasonOf(flushed)}`;
        log(`structures: flush failed (${reasonOf(flushed)}) - nothing recorded, full reconcile next`);
        return;
      }
    }
    recordAll(repository, ctx.records, now);

    for (const rec of input.records) {
      const id = rec.stationId;
      const o = outcome.get(id);
      if (o === OUTCOME.FAILED || o === OUTCOME.WAIT) continue;
      if (rec.state === DESTROYED_STATION_STATE || rec.kind !== UPWELL_KIND) {
        applied.delete(id);
        forgetPlacement(id);
      } else applied.set(id, fingerprintOf(rec, now));
    }
    for (const id of input.missing) {
      const o = outcome.get(id);
      if (o === OUTCOME.FAILED || o === OUTCOME.WAIT) continue;
      applied.delete(id);
      bindings.delete(id);
      forgetPlacement(id);
    }
  }

  function recordAll(repository, records, now) {
    if (records.size === 0) return;
    const tx = store.transaction("structures.record", (db) => {
      const out = [];
      for (const [stationId, r] of records) {
        out.push([stationId, repository.recordProjection(db, { stationId, evejsItemId: r.structureId,
          position: { x: r.position.x, y: r.position.y, z: r.position.z },
          key: projectionKey(stationId, r.structureId), at: now })]);
      }
      return out;
    });
    if (!tx.ok) {
      count("recordRefused");
      status.lastError = `RECORD:${tx.reason}`;
      log(`structures: recordProjection transaction failed (${tx.reason}) - retried at the next full reconcile`);
      return;
    }
    for (const [stationId, r] of tx.value) {
      if (r.ok) continue;
      count("recordRefused");
      note(stationId, { lastError: `RECORD_${reasonOf(r)}` });
      log(`structures: recordProjection ${stationId} refused (${reasonOf(r)})`);
    }
  }

  function cleanupPass() {
    const listed = seam.listTaggedStructures();
    if (!listed.ok) {
      refused(null, "LIST", listed);
      return;
    }
    const live = listed.rows.filter((v) => v && v.tag && isLiveView(v)).sort(byStructureId);
    const now = clock.now();
    const ctx = { writes: 0 };
    let handled = 0;
    for (const view of live) {
      if (ctx.writes >= settings.maxWritesPerPass) break;
      const op = { stationId: view.tag.stationId, structureId: view.structureId, tag: view.tag };
      if (execRemove(op, now, ctx) === OUTCOME.DONE) handled += 1;
    }
    status.remaining = live.length - handled;
    status.cleanup = status.remaining === 0 ? CLEANUP_STATUS.DONE : CLEANUP_STATUS.RUNNING;
    status.lastWrites = ctx.writes;
    projected = status.remaining;
    if (ctx.writes > 0) {
      const flushed = seam.flushStructures();
      if (!flushed.ok) {
        count("flushFailed");
        status.lastError = `FLUSH:${reasonOf(flushed)}`;
        log(`structures: cleanup flush failed (${reasonOf(flushed)})`);
      }
    }
  }

  function runPass() {
    if (status.state !== STATE.RUNNING) return;
    const t0 = nowMs();
    status.lastChecks = 0;
    status.lastWrites = 0;
    try {
      if (!admitted()) {
        count("passDeferred");
        return;
      }
      if (mode === MODE.CLEANUP) cleanupPass();
      else projectPass();
    } catch (err) {
      count("seamError");
      needFull = true;
      status.lastError = `THREW:${detailOf(err)}`;
      log(`structures: pass failed - ${detailOf(err)}`);
    } finally {
      status.passes += 1;
      status.lastPassAt = clock.now();
      status.seq += 1;
      observe(nowMs() - t0);
    }
  }

  function nudge() {
    if (poller && status.state === STATE.RUNNING) poller.arm(0);
  }

  function start() {
    poller = createPoller({ runPass, intervalMs: settings.passMs, now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => log(`structures: timer error - ${detailOf(err)}`) });
    if (mode === MODE.PROJECT) {
      const sub = seam.subscribeStructureChanges((evt) => {
        if (status.state !== STATE.RUNNING) return;
        for (const id of (evt && evt.stationIds) || []) if (typeof id === "string") dirty.add(id);
        nudge();
      });
      if (sub && sub.ok) unsubscribe = sub.unsubscribe;
      else log(`structures: no change listener (${reasonOf(sub)}) - foreign changes wait for the full reconcile`);
    }
    const started = poller.start();
    if (started && started.ok === false) return { ok: false, reason: `poller ${reasonOf(started)}` };
    nudge();
    return { ok: true };
  }

  function stop() {
    if (status.state === STATE.STOPPED) return;
    status.state = STATE.STOPPED;
    status.seq += 1;
    if (poller) poller.stop();
    if (unsubscribe) {
      const off = unsubscribe;
      unsubscribe = null;
      try {
        off();
      } catch (_err) {
      }
    }
  }

  function getStatus() {
    return Object.freeze({ state: status.state, mode, seq: status.seq, passes: status.passes,
      lastPassAt: status.lastPassAt, lastFullAt: status.lastFullAt, projected, pending: dirty.size,
      blocked: placementBlocked.size, waiting: createWait.size, remaining: status.remaining, cleanup: status.cleanup,
      lastChecks: status.lastChecks, lastWrites: status.lastWrites, lastError: status.lastError,
      tracked: Object.freeze({ applied: applied.size, bindings: bindings.size, cursor: placementCursor.size,
        retry: placementRetry.size }),
      counters: Object.freeze({ ...status.counters }) });
  }

  function getProjection(stationId) {
    const b = bindings.get(stationId);
    return { ok: true, structureId: b ? b.structureId : null, lastOp: b ? b.lastOp : null,
      lastError: b ? b.lastError : null };
  }

  function listBindings(limit) {
    return [...bindings.keys()].sort().slice(0, Math.max(0, limit))
      .map((id) => Object.freeze({ stationId: id, ...bindings.get(id) }));
  }

  return Object.freeze({ start, stop, nudge, runPass, getStatus, getProjection, listBindings, getMode: () => mode });
}

module.exports = { createStructuresService, MODE, COUNTER_NAMES };
