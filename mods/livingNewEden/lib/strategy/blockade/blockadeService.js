"use strict";

const { performance } = require("node:perf_hooks");
const { crossingOf } = require("../../fleets/crossing");
const { parseOperationTypeList } = require("../../fleets/schema");
const { pairKeyOf } = require("../../battle/contacts");
const { gridOfRef } = require("../../battle/gridContacts");
const { transitTimelineOf, gatesOf, gateGridsOf, outCatchAtOf } = require("../../fleets/grid/transit");
const { rankPosts, relationOfControllers } = require("../gridDefense/posts");
const { fingerprint } = require("../../util/fingerprint");
const { crossingsOfLeg, decideIntercept, decidePosition, nextArrivalOf, BLOCKADE_OPERATION_TYPE, STALE_REASONS,
  GATE_STALE_REASONS, POSITION_STALE_REASONS, MODE } = require("./rules");

const INTERCEPT_EVENT = "BLOCKADE_INTERCEPT";
const RESOLVED_EVENT = "BLOCKADE_INTERCEPT_RESOLVED";
const POSITION_EVENT = "BLOCKADE_POSITION";
const AGGREGATE_TYPE = "blockade";
const OPEN_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const PAYLOAD_KEYS = Object.freeze(["at", "fleetId", "legSeq", "operationId", "systemIndex"]);
const GATE_OUT = "out";
const PAYLOAD_GATE_KEYS = Object.freeze([...PAYLOAD_KEYS, "gate"].sort());
const POSITION_X_KEYS = Object.freeze(["at", "fleetId", "legSeq", "mode", "operationId", "round", "systemIndex"]);
const POSITION_P_KEYS = Object.freeze(["at", "mode", "operationId", "round"]);
const STAGED = "STAGED";
const KIND_ANCHOR = "anchor";
const PURPOSE_POST = "POST";
const RETRY_MOVE_REASONS = Object.freeze(["MOVE_FAILED", "ENQUEUE_FAILED", "FLEET_READ_FAILED"]);
const POSITION_STALE_KEYS = Object.freeze([...POSITION_STALE_REASONS, "GATE_OFF", "OTHER"]);
const MS_DECIMALS = 10;
const SPEC_KEYS = Object.freeze(["at", "dueAt", "factionId", "fleetIds", "operationId", "systemId"]);
const STALE_INTERCEPT = Object.freeze(["STALE_LEG", "NOT_CROSSING", "LEG_HAS_WORMHOLES", "FLEET_NOT_FOUND"]);
const PERMANENT_INTERCEPT = Object.freeze(["FLEET_INVALID_INPUT"]);
const STALE_OTHER = "OTHER";
const SERVICE_STALE = Object.freeze(["BATTLE_UNAVAILABLE"]);
const STALE_KEYS = Object.freeze([...new Set([...STALE_REASONS, ...GATE_STALE_REASONS, ...SERVICE_STALE,
  ...STALE_INTERCEPT, STALE_OTHER])]);
const COUNTER_NAMES = Object.freeze(["crossingsQueued", "intercepts", "escaped", "stale", "listenerSkippedLong",
  "activationScanTruncated", "enqueueRefused", "positionsQueued", "positioned", "positionInPlace", "positionRechecks",
  "positionStale", "positionRefused", "positionLate", "positionPreempted", "positionEnqueueRefused", "gateIn",
  "gateOut", "gateDeferred", "gateUnknown"]);
const MAX_DETAIL = 120;
const MAX_ID = 64;

const isText = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

const crossingKey = (operationId, fleetId, legSeq) => `blockade:${operationId}:x:${fleetId}:${legSeq}`;
const HALT_HASH_HEX = 40;
const haltKeyOf = (hitKey) => `bkh:${fingerprint(`${hitKey}:halt`).slice(0, HALT_HASH_HEX)}`;

function staleKeyOf(reason) {
  const why = String(reason);
  return STALE_KEYS.includes(why) ? why : STALE_OTHER;
}

function parsePayload(p) {
  if (!isPlain(p)) return null;
  const keys = Object.keys(p).sort().join();
  const deferred = keys === PAYLOAD_GATE_KEYS.join() && p.gate === GATE_OUT;
  if (keys !== PAYLOAD_KEYS.join() && !deferred) return null;
  if (!isText(p.operationId) || !isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0
    || !Number.isSafeInteger(p.systemIndex) || p.systemIndex < 1 || !isTime(p.at)) return null;
  return { operationId: p.operationId, fleetId: p.fleetId, legSeq: p.legSeq, systemIndex: p.systemIndex, at: p.at,
    ...(deferred ? { gate: GATE_OUT } : {}) };
}

function positionKey(p, round) {
  return p.mode === MODE.CROSSING ? `bkpos:${p.operationId}:x:${p.fleetId}:${p.legSeq}:${round}`
    : `bkpos:${p.operationId}:p:${round}`;
}

function parsePositionPayload(p) {
  if (!isPlain(p)) return null;
  const keys = Object.keys(p).sort().join();
  if (!isText(p.operationId) || !isTime(p.at) || !Number.isSafeInteger(p.round) || p.round < 0) return null;
  if (p.mode === MODE.CROSSING && keys === POSITION_X_KEYS.join()) {
    if (!isText(p.fleetId) || !Number.isSafeInteger(p.legSeq) || p.legSeq < 0 || !Number.isSafeInteger(p.systemIndex)
      || p.systemIndex < 1) return null;
    return { at: p.at, fleetId: p.fleetId, legSeq: p.legSeq, mode: p.mode, operationId: p.operationId,
      round: p.round, systemIndex: p.systemIndex };
  }
  if (p.mode === MODE.POST && keys === POSITION_P_KEYS.join()) {
    return { at: p.at, mode: p.mode, operationId: p.operationId, round: p.round };
  }
  return null;
}

function gateSettingsOf(config) {
  const cr = config && config.grid && config.grid.crossings ? config.grid.crossings : null;
  const tf = config && config.fleets ? config.fleets.travelTimeFactor : undefined;
  if (!cr || cr.blockadeGateEnabled !== true || !Number.isSafeInteger(cr.blockadePositionLeadMs)
    || cr.blockadePositionLeadMs < 0 || !Number.isSafeInteger(cr.blockadePositionMaxRounds)
    || cr.blockadePositionMaxRounds < 1 || !(typeof tf === "number" && Number.isFinite(tf) && tf > 0)) {
    return Object.freeze({ enabled: false, leadMs: 0, maxRounds: 1, timeFactor: 1 });
  }
  return Object.freeze({ enabled: true, leadMs: cr.blockadePositionLeadMs, maxRounds: cr.blockadePositionMaxRounds,
    timeFactor: tf });
}

function paramsOf(st) {
  const types = parseOperationTypeList(st && st.blockadeInterceptOperationTypes);
  if (!types) return null;
  return { interceptChancePermille: st.blockadeInterceptChancePermille, interceptOperationTypes: types,
    listenerMaxSystems: st.blockadeListenerMaxSystems, opsPerSystemRead: st.blockadeOpsPerSystemRead,
    maxCrossingsPerLeg: st.blockadeMaxCrossingsPerLeg, activationScanMaxFleets: st.blockadeActivationScanMaxFleets };
}

function createBlockadeService(deps) {
  const { store, journal, scheduler, fleetRepository, travel, params: P } = deps;
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const staleByReason = Object.create(null);
  const positionStaleByReason = Object.create(null);
  const grid = deps.grid || null;
  const G = deps.gate || gateSettingsOf(null);
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  let stopped = false;
  let lastRefusal = null;
  const hostile = (a, b) => {
    try {
      return deps.isHostile(Number(a), Number(b)) === true;
    } catch (_err) {
      return false;
    }
  };

  function gateOn() {
    try {
      return G.enabled === true && Boolean(grid) && grid.isEnabled() === true && grid.movesEnabled() === true;
    } catch (_err) {
      return false;
    }
  }

  function leadOf() {
    const raw = Math.round(G.timeFactor * G.leadMs);
    try {
      const c = deps.clock;
      const v = c && typeof c.travelDurationMs === "function" ? c.travelDurationMs(raw, { observed: false }) : raw;
      return Number.isFinite(v) ? Math.max(0, Math.round(v)) : raw;
    } catch (_err) {
      return raw;
    }
  }

  function battleNow() {
    try {
      const b = typeof deps.getBattle === "function" ? deps.getBattle() : null;
      return b && typeof b.readCooldownsInTx === "function" ? b : null;
    } catch (_err) {
      return null;
    }
  }

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
    metric("count", `blockade.${name}`, n);
  }

  function noteStale(reason) {
    const k = staleKeyOf(reason);
    staleByReason[k] = (staleByReason[k] || 0) + 1;
    bump("stale");
  }

  function notePositionStale(reason) {
    const why = String(reason);
    const k = POSITION_STALE_KEYS.includes(why) ? why : STALE_OTHER;
    positionStaleByReason[k] = (positionStaleByReason[k] || 0) + 1;
    bump("positionStale");
  }

  function enqueuePosition(tx, payload, chained, tally) {
    const r = scheduler.enqueue(POSITION_EVENT, payload.operationId, payload.at, payload, positionKey(payload, 0),
      { tx, chained: chained === true });
    if (!r || r.ok !== true) {
      if (tally) tally.positionRefused += 1;
      else bump("positionEnqueueRefused");
      lastRefusal = String((r && r.reason) || "ENQUEUE_FAILED");
      return;
    }
    if (r.duplicate) return;
    if (tally) tally.positions += 1;
    else bump("positionsQueued");
  }

  function enqueueCrossing(tx, c, chained, tally) {
    const payload = { operationId: c.operationId, fleetId: c.fleetId, legSeq: c.legSeq, systemIndex: c.systemIndex,
      at: c.at };
    const r = scheduler.enqueue(INTERCEPT_EVENT, c.operationId, c.at, payload,
      crossingKey(c.operationId, c.fleetId, c.legSeq), { tx, chained: chained === true });
    if (!r || r.ok !== true) {
      if (tally) tally.refused += 1;
      else bump("enqueueRefused");
      lastRefusal = String((r && r.reason) || "ENQUEUE_FAILED");
      return 0;
    }
    if (r.duplicate) return 0;
    if (gateOn() && isTime(c.scanAt)) {
      enqueuePosition(tx, { at: Math.max(c.scanAt, c.at - leadOf()), fleetId: c.fleetId, legSeq: c.legSeq,
        mode: MODE.CROSSING, operationId: c.operationId, round: 0, systemIndex: c.systemIndex }, chained, tally);
    }
    if (!tally) bump("crossingsQueued");
    return 1;
  }

  function countScan(scan) {
    if (!scan || scan.ok !== true) return;
    bump("crossingsQueued", Number.isSafeInteger(scan.queued) ? scan.queued : 0);
    bump("enqueueRefused", Number.isSafeInteger(scan.refused) ? scan.refused : 0);
    if (scan.truncated === true) bump("activationScanTruncated");
    bump("positionsQueued", Number.isSafeInteger(scan.positions) ? scan.positions : 0);
    bump("positionEnqueueRefused", Number.isSafeInteger(scan.positionRefused) ? scan.positionRefused : 0);
  }

  function blockadesIn(tx, systemId) {
    const r = fleetRepository.listOperationsByTarget(tx, systemId, { states: [...OPEN_STATES],
      limit: P.opsPerSystemRead, operationType: BLOCKADE_OPERATION_TYPE });
    if (!r || r.ok !== true) return [];
    return r.operations.filter((op) => op.operationType === BLOCKADE_OPERATION_TYPE)
      .map((op) => ({ operationId: op.operationId, factionId: op.factionId, dueAt: op.dueAt }));
  }

  function operationTypeOf(tx, operationId) {
    if (operationId === null || operationId === undefined) return null;
    const r = fleetRepository.getOperation(tx, operationId);
    return r && r.ok === true && r.operation ? r.operation.operationType : null;
  }

  function onDeparture(tx, d) {
    if (stopped || !d || d.operationId === null || d.operationId === undefined || d.wormholes === true) return;
    if (!d.leg || !Array.isArray(d.leg.systems) || d.leg.systems.length < 3) return;
    const type = operationTypeOf(tx, d.operationId);
    if (!P.interceptOperationTypes.includes(type)) return;
    const found = crossingsOfLeg(d.leg, (systemId) => blockadesIn(tx, systemId), hostile,
      { factionId: d.factionId, maxSystems: P.listenerMaxSystems, maxCrossings: P.maxCrossingsPerLeg });
    if (found.truncated) bump("listenerSkippedLong");
    for (const c of found.crossings) {
      enqueueCrossing(tx, { operationId: c.operationId, fleetId: d.fleetId, legSeq: d.legSeq,
        systemIndex: c.systemIndex, at: c.at, scanAt: d.leg.departAt }, d.chained);
    }
  }

  function validSpec(spec) {
    if (!isPlain(spec)) return false;
    for (const k of Object.keys(spec)) if (!SPEC_KEYS.includes(k)) return false;
    if (!isText(spec.operationId) || !isId(spec.systemId) || !isId(spec.factionId) || !isTime(spec.dueAt)
      || !isTime(spec.at)) return false;
    if (spec.fleetIds !== undefined && (!Array.isArray(spec.fleetIds) || !spec.fleetIds.every(isText))) return false;
    return true;
  }

  function registerBlockadeInTx(tx, spec, opts) {
    try {
      if (stopped) return { ok: false, reason: "BLOCKADE_STOPPED" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!validSpec(spec)) return { ok: false, reason: "BLOCKADE_INVALID_INPUT" };
      const chained = Boolean(opts && opts.chained === true);
      const maxFleets = opts ? opts.maxFleets : undefined;
      if (maxFleets !== undefined && !(Number.isSafeInteger(maxFleets) && maxFleets >= 0)) {
        return { ok: false, reason: "BLOCKADE_INVALID_INPUT" };
      }
      if (maxFleets === 0) return { ok: true, queued: 0, truncated: false, refused: 0 };
      let fleets;
      let truncated = false;
      if (spec.fleetIds !== undefined) {
        const r = fleetRepository.getFleets(tx, spec.fleetIds);
        if (!r || r.ok !== true) return r || { ok: false, reason: "FLEETS_READ_FAILED" };
        fleets = r.fleets;
      } else {
        const page = maxFleets === undefined ? P.activationScanMaxFleets
          : Math.min(P.activationScanMaxFleets, maxFleets);
        const r = fleetRepository.listFleetsByState(tx, "TRAVELLING", { limit: page });
        if (!r || r.ok !== true) return r || { ok: false, reason: "FLEETS_READ_FAILED" };
        fleets = r.fleets;
        truncated = r.nextAfterFleetId !== null && r.nextAfterFleetId !== undefined;
      }
      const types = new Map();
      const tally = { refused: 0, positions: 0, positionRefused: 0 };
      let queued = 0;
      for (const fleet of [...fleets].sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1))) {
        if (fleet.operationId === null || fleet.operationId === undefined) continue;
        if (!hostile(spec.factionId, fleet.factionId)) continue;
        const x = crossingOf(fleet, spec.systemId);
        if (!x || x.from < spec.at || x.from >= spec.dueAt) continue;
        if (!types.has(fleet.operationId)) types.set(fleet.operationId, operationTypeOf(tx, fleet.operationId));
        if (!P.interceptOperationTypes.includes(types.get(fleet.operationId))) continue;
        queued += enqueueCrossing(tx, { operationId: spec.operationId, fleetId: fleet.fleetId, legSeq: fleet.legSeq,
          systemIndex: x.i, at: x.from, scanAt: spec.at }, chained, tally);
      }
      const gate = gateOn();
      if (gate && spec.fleetIds === undefined) {
        enqueuePosition(tx, { at: spec.at, mode: MODE.POST, operationId: spec.operationId, round: 0 }, chained, tally);
      }
      return { ok: true, queued, truncated, refused: tally.refused,
        ...(gate ? { positions: tally.positions, positionRefused: tally.positionRefused } : {}) };
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      return { ok: false, reason: `BLOCKADE_REGISTER_FAILED: ${messageOf(err)}` };
    }
  }

  function readIntercept(db, p, battle) {
    const o = fleetRepository.getOperation(db, p.operationId);
    if (!o.ok) return o;
    const operation = o.operation;
    if (!operation) return { ok: true, operation: null };
    const m = fleetRepository.listFleetsOfOperation(db, p.operationId);
    if (!m.ok) return m;
    const f = fleetRepository.getFleet(db, p.fleetId);
    if (!f.ok) return f;
    const target = f.fleet;
    let targetOperationType = null;
    if (target && target.operationId !== null && target.operationId !== undefined) {
      const t = fleetRepository.getOperation(db, target.operationId);
      if (!t.ok) return t;
      targetOperationType = t.operation ? t.operation.operationType : null;
    }
    let cooldownUntil = null;
    let cooldowns = false;
    if (battle && target) {
      const cd = battle.readCooldownsInTx(db, operation.targetSystemId);
      if (cd && cd.ok === true && cd.cooldowns instanceof Map) {
        cooldowns = true;
        const u = cd.cooldowns.get(pairKeyOf(operation.factionId, target.factionId));
        cooldownUntil = Number.isFinite(u) ? u : null;
      }
    }
    return { ok: true, operation, postFleets: m.fleets, target, targetOperationType, cooldownUntil, cooldowns };
  }

  function systemGridOf(systemId) {
    try {
      const r = grid.readSystemGrid(systemId);
      if (!r || r.ok !== true || !Array.isArray(r.anchors)) return null;
      return { anchors: r.anchors, gridOf: gridOfRef(r.grids) };
    } catch (_err) {
      return null;
    }
  }

  function gridKeysAt(db, systemId, fleets, at) {
    if (fleets.length === 0) return new Set();
    const r = grid.positionsOf(db, systemId, fleets, at);
    if (!r || r.ok !== true || r.anchorsReason !== null || !(r.positions instanceof Map)) return null;
    const out = new Set();
    for (const pos of r.positions.values()) if (pos && pos.kind === KIND_ANCHOR) out.add(pos.gridKey);
    return out;
  }

  function readGate(db, p, read) {
    const op = read.operation;
    const T = op.targetSystemId;
    const tl = transitTimelineOf(read.target.route, p.systemIndex, read.target.composition);
    if (!tl.ok) return null;
    const sg = systemGridOf(T);
    if (!sg) return null;
    const grids = gateGridsOf(sg.anchors, sg.gridOf, read.target.route, p.systemIndex);
    if (!grids.in && !grids.out) return { timeline: tl, grids, inGridKeys: new Set(), outGridKeys: new Set() };
    const catchers = (read.postFleets || []).filter((f) => f && f.state === STAGED && f.currentSystemId === T
      && f.operationId === op.operationId);
    const inGridKeys = p.gate === GATE_OUT ? new Set() : gridKeysAt(db, T, catchers, p.at);
    const outGridKeys = gridKeysAt(db, T, catchers, outCatchAtOf(tl, p.at));
    if (!inGridKeys || !outGridKeys) return null;
    return { timeline: tl, grids, inGridKeys, outGridKeys };
  }

  function deferEffect(etx, p, k, d) {
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, applied: false, action: "DUPLICATE" };
    const key = `${crossingKey(p.operationId, p.fleetId, p.legSeq)}:o`;
    const payload = { at: d.catchAt, fleetId: p.fleetId, gate: GATE_OUT, legSeq: p.legSeq, operationId: p.operationId,
      systemIndex: p.systemIndex };
    const e = scheduler.enqueue(INTERCEPT_EVENT, p.operationId, d.catchAt, payload, key, { tx: etx, chained: true });
    if (!e || e.ok !== true) return { ok: false, reason: String((e && e.reason) || "ENQUEUE_FAILED") };
    return { ok: true, applied: false, action: "DEFER", duplicate: e.duplicate === true };
  }

  function interceptEffect(etx, p, read, d) {
    const k = `${crossingKey(p.operationId, p.fleetId, p.legSeq)}:hit`;
    if (d.action === "DEFER") return deferEffect(etx, p, k, d);
    const seen = journal.findByKey(etx, k);
    if (!seen.ok) return seen;
    if (seen.found) return { ok: true, applied: false, action: "DUPLICATE" };
    const r = journal.applyOnce(etx, { key: k, aggregate: { type: AGGREGATE_TYPE, id: p.operationId },
      eventType: RESOLVED_EVENT, payload: { ...p, outcome: d.action, roll: d.roll } }, (db) => {
      if (d.action === "ESCAPED") return { ok: true, action: "ESCAPED", operationId: p.operationId, fleetId: p.fleetId };
      const h = travel.interceptInTx(db, { fleetId: p.fleetId, expectedVersion: read.target.version,
        legSeq: p.legSeq, systemIndex: p.systemIndex, at: p.at }, haltKeyOf(k), { chained: true });
      if (!h || h.ok !== true) return h || { ok: false, reason: "INTERCEPT_FAILED" };
      if (d.gate === GATE_OUT && h.duplicate !== true) {
        const pl = grid.placeInTx(db, { fleetId: p.fleetId, systemId: h.systemId, legSeq: p.legSeq, at: p.at,
          anchor: d.anchor });
        if (!pl || pl.ok !== true || pl.placed !== true) {
          return { ok: false, reason: "GATE_PLACE_FAILED", permanent: true,
            detail: String((pl && pl.reason) || "NOT_PLACED") };
        }
      }
      return { ok: true, action: "INTERCEPT", operationId: p.operationId, fleetId: p.fleetId, systemId: h.systemId };
    });
    if (r.ok) return r.duplicate ? { ok: true, applied: false, action: "DUPLICATE" } : { ok: true, applied: true,
      ...r.value };
    if (r.reason === "APPLY_REFUSED") {
      const why = String((r.refusal && r.refusal.reason) || "REFUSED");
      if (STALE_INTERCEPT.includes(why)) return { ok: true, applied: false, action: "STALE", reason: why };
      if (PERMANENT_INTERCEPT.includes(why)) return { ...r.refusal, ok: false, reason: why, permanent: true };
      return r.refusal || { ok: false, reason: why };
    }
    return { ok: false, reason: r.reason || "APPLY_FAILED", detail: r.error ? messageOf(r.error) : undefined };
  }

  function onIntercept(ev) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "BLOCKADE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "BLOCKADE_STOPPED" };
      const stale = (reason) => ({ ok: true, outcome: "STALE", onCommitted: () => noteStale(reason) });
      const battle = battleNow();
      const tx = store.transaction("blockade.interceptRead", (db) => readIntercept(db, p, battle));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "BLOCKADE_READ_FAILED") };
      }
      const facts = { p, operation: read.operation, postFleets: read.postFleets || [],
        target: read.target || null, targetOperationType: read.targetOperationType || null,
        hostile: Boolean(read.operation && read.target && hostile(read.operation.factionId, read.target.factionId)),
        cooldownUntil: read.operation ? read.cooldownUntil : null, worldSeed };
      let d = decideIntercept(facts, P);
      if (d.action === "STALE") return stale(d.reason);
      if (!read.cooldowns) return stale("BATTLE_UNAVAILABLE");
      let gateUnknown = false;
      if (gateOn()) {
        const g = store.transaction("blockade.gateRead", (db) => readGate(db, p, read));
        const gate = g.ok ? g.value : null;
        if (gate && (gate.grids.in || gate.grids.out)) d = decideIntercept({ ...facts, gate }, P);
        else gateUnknown = true;
        if (d.action === "STALE") return stale(d.reason);
      }
      return { ok: true, outcome: d.action, effect: (etx) => interceptEffect(etx, p, read, d),
        onCommitted: (v) => {
          if (gateUnknown) bump("gateUnknown");
          if (v && v.action === "DEFER") bump("gateDeferred");
          if (!v || v.applied !== true) {
            if (v && v.action === "STALE") noteStale(v.reason);
            return;
          }
          if (d.gate === "in") bump("gateIn");
          if (d.gate === GATE_OUT) bump("gateOut");
          if (v.action === "ESCAPED") bump("escaped");
          if (v.action === "INTERCEPT") {
            bump("intercepts");
            logger.log(`blockade: operation ${v.operationId} intercepted fleet ${v.fleetId} system=${v.systemId}`);
          }
        } };
    } catch (err) {
      return { ok: false, reason: `BLOCKADE_INTERCEPT_FAILED: ${messageOf(err)}` };
    }
  }

  function postGateOf(db, factionId, sg) {
    const targets = [...new Set(sg.anchors.filter((a) => a && a.kind === "gate" && isId(a.toSystemId))
      .map((a) => a.toSystemId))];
    let relationOf = new Map();
    let world = null;
    try {
      world = typeof deps.getWorld === "function" ? deps.getWorld() : null;
    } catch (_err) {
      world = null;
    }
    if (world && world.repository && typeof world.repository.getSystems === "function" && targets.length > 0) {
      try {
        const r = world.repository.getSystems(db, targets);
        relationOf = relationOfControllers(r && r.ok === true ? r.systems : [], factionId, hostile);
      } catch (err) {
        if (!db || db.inTransaction !== true) throw err;
      }
    }
    return rankPosts({ anchors: sg.anchors, gridOf: sg.gridOf, cp: null, factionId, relationOf,
      ownStationRefs: new Set() }).find((a) => a.kind === "gate") || null;
  }

  function readPosition(db, p) {
    const o = fleetRepository.getOperation(db, p.operationId);
    if (!o.ok) return o;
    const operation = o.operation;
    const empty = { p, operation, members: [], posted: [], crossing: null, target: null, claims: new Map(),
      nextArrivalAt: null };
    if (!operation) return { ok: true, facts: empty };
    const T = operation.targetSystemId;
    const m = fleetRepository.listFleetsOfOperation(db, p.operationId);
    if (!m.ok) return m;
    const members = m.fleets;
    let crossing = null;
    let leg = null;
    if (p.mode === MODE.CROSSING) {
      const f = fleetRepository.getFleet(db, p.fleetId);
      if (!f.ok) return f;
      const fl = f.fleet;
      const x = fl && fl.state === "TRAVELLING" && fl.legSeq === p.legSeq ? crossingOf(fl, T) : null;
      if (x && x.i === p.systemIndex) {
        crossing = { from: x.from, until: x.from + x.jumpMs };
        leg = x.leg;
      }
    }
    const sg = systemGridOf(T);
    let anchor = null;
    if (sg) anchor = p.mode === MODE.CROSSING ? (leg ? gatesOf(sg.anchors, leg, p.systemIndex).in : null)
      : postGateOf(db, operation.factionId, sg);
    let target = anchor ? { kind: anchor.kind, id: anchor.id,
      gridKey: sg.gridOf.get(`${anchor.kind}:${anchor.id}`) || `${anchor.kind}:${anchor.id}` } : null;
    const stagedHere = members.filter((f) => f && f.state === STAGED && f.currentSystemId === T);
    const posted = [];
    const claims = new Map();
    if (target && stagedHere.length > 0) {
      const r = grid.positionsOf(db, T, stagedHere, p.at, { withVisit: true });
      if (!r || r.ok !== true || r.anchorsReason !== null || !(r.positions instanceof Map)) {
        target = null;
      } else {
        for (const f of stagedHere) {
          const position = r.positions.get(f.fleetId) || null;
          posted.push({ fleetId: f.fleetId, legSeq: f.legSeq, position, visit: position ? position.visit : null });
        }
        const ids = [...new Set(posted.map((x) => x.visit).filter((v) => v && v.purpose === PURPOSE_POST
          && isText(v.targetFleetId) && v.targetFleetId !== p.fleetId).map((v) => v.targetFleetId))].sort();
        if (ids.length > 0) {
          const c = fleetRepository.getFleets(db, ids);
          if (!c.ok) return c;
          for (const fl of c.fleets) {
            const x = crossingOf(fl, T);
            claims.set(fl.fleetId, x ? { from: x.from, until: x.from + x.jumpMs } : null);
          }
        }
      }
    }
    return { ok: true, facts: { p, operation, members, posted, crossing, target, claims,
      nextArrivalAt: nextArrivalOf(members, T) } };
  }

  function positionEffect(etx, p, f, d) {
    if (d.action === "RECHECK") {
      const next = { ...p, at: d.at, round: p.round + 1 };
      const e = scheduler.enqueue(POSITION_EVENT, p.operationId, d.at, next, positionKey(p, p.round + 1),
        { tx: etx, chained: true });
      if (!e || e.ok !== true) return { ok: false, reason: String((e && e.reason) || "ENQUEUE_FAILED") };
      return { ok: true, action: "RECHECK" };
    }
    const r = grid.moveGroupInTx(etx, { systemId: f.operation.targetSystemId, at: p.at,
      to: { kind: f.target.kind, id: f.target.id }, purpose: PURPOSE_POST,
      targetFleetId: p.mode === MODE.CROSSING ? p.fleetId : null, members: d.members }, { chained: true });
    if (r && r.ok === true) {
      const late = p.mode === MODE.CROSSING && Number.isSafeInteger(r.arriveAt) && r.arriveAt > f.crossing.from;
      return { ok: true, action: "MOVE", moved: r.moved.length, late };
    }
    const reason = String((r && r.reason) || "MOVE_FAILED");
    if (RETRY_MOVE_REASONS.includes(reason)) return { ok: false, reason };
    return { ok: true, action: "REFUSED", reason };
  }

  function onPosition(ev) {
    const t0 = nowMs();
    try {
      const p = parsePositionPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "BLOCKADE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "BLOCKADE_STOPPED" };
      if (!gateOn()) return { ok: true, outcome: "STALE", onCommitted: () => notePositionStale("GATE_OFF") };
      const tx = store.transaction("blockade.positionRead", (db) => readPosition(db, p));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        return { ok: false, reason: String((read && read.reason) || "BLOCKADE_READ_FAILED") };
      }
      const f = read.facts;
      const d = decidePosition(f, { maxRounds: G.maxRounds });
      if (d.action === "STALE") return { ok: true, outcome: "STALE", onCommitted: () => notePositionStale(d.reason) };
      if (d.action === "IN_PLACE") return { ok: true, outcome: "IN_PLACE", onCommitted: () => bump("positionInPlace") };
      return { ok: true, outcome: d.action, effect: (etx) => positionEffect(etx, p, f, d), onCommitted: (v) => {
        if (!v) return;
        if (v.action === "RECHECK") bump("positionRechecks");
        if (v.action === "REFUSED") {
          bump("positionRefused");
          lastRefusal = `POSITION_${v.reason}`;
        }
        if (v.action === "MOVE") {
          bump("positioned");
          if (v.late) bump("positionLate");
          if (d.preempted) bump("positionPreempted");
        }
      } };
    } catch (err) {
      return { ok: false, reason: `BLOCKADE_POSITION_FAILED: ${messageOf(err)}` };
    } finally {
      metric("observe", "blockade.positionMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", counters: Object.freeze({ ...counters }),
      staleByReason: Object.freeze({ ...staleByReason }), lastRefusal,
      positionStaleByReason: Object.freeze({ ...positionStaleByReason }), gate: gateOn() });
  }

  return Object.freeze({ onDeparture, registerBlockadeInTx, countScan, onIntercept, onPosition, getStatus,
    getMode: () => (stopped ? "off" : "on"), isStopped: () => stopped, stop() {
      stopped = true;
    } });
}

module.exports = { createBlockadeService, crossingKey, haltKeyOf, staleKeyOf, paramsOf, gateSettingsOf, positionKey,
  INTERCEPT_EVENT, POSITION_EVENT, COUNTER_NAMES };
