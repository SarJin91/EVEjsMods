"use strict";

const S = require("./schema");
const { planStart, decideStep, decideNative, holdOf, familyOf } = require("./siegeMachine");
const { targetRefOf, gridScopeOf, gridHoldOf, moversOf: gridMoversOf } = require("./gridScope");
const { STRUCTURE_DEFENSE } = require("../data/structureDefense");
const { buildStructureWreckField } = require("../../world/wreckPool");
const { placeFieldInTx } = require("../../world/wreckConsequence");
const { isCoreStation, bastionOwnerOf, getCoreIndex } = require("../../world/core");

const STATION_MODE_READY = "ready";
const STATION_MODE_PENDING = "pending";
const STATION_ONLINE = "ONLINE";
const STATION_ANCHORING = "ANCHORING";
const STATION_DESTROYED = "DESTROYED";
const KIND_NPC = "npc";
const STATION_ROLE = "station";
const SIEGE_REASON = "SIEGE";
const CAPTURE_REASON = "SIEGE_CAPTURED";
const CAPTURE_LIMIT_REASONS = Object.freeze(["SYSTEM_FACTION_STATION_LIMIT", "FACTION_STATION_LIMIT"]);
const MAX_DETAIL = 120;
const RECONCILE_CHUNK = 64;
const COUNTER_NAMES = Object.freeze(["checks", "started", "noTarget", "contested", "insufficientForce", "advanced",
  "waits", "repelled", "destroyed", "captured", "sacked", "anchorKilled", "stale", "aborted", "occupationRefused",
  "buildFailRefused", "enqueueRefused", "reconciled", "checkAfterBattle", "consequenceSkipped", "wreckRefused",
  "coreProtected", "nativeEnded", "gridMoves", "gridMoveRefused", "gridGathers", "gridApproach", "gridFallback",
  "gridNoAnchor", "repelCooldown"]);
const SIEGE_PURPOSE = "SIEGE";
const NATIVE = Object.freeze({ DESTROYED: "DESTROYED", DUPLICATE: "DUPLICATE", NO_SIEGE: "NO_SIEGE",
  NOT_ASSAULT: "NOT_ASSAULT", STATION_STATE_CHANGED: "STATION_STATE_CHANGED", SIEGE_OFF: "SIEGE_OFF",
  OWNER_CHANGED: "OWNER_CHANGED", CORE_PROTECTED: "CORE_PROTECTED", STALE_DESTRUCTION: "STALE_DESTRUCTION" });
const STAY_DISPOSITIONS = Object.freeze(["STAGED", "IDLE"]);
const CONSEQUENCE_CHECK_SUFFIX = ":c:siege:check";
const CHECK_KEYS = Object.freeze(["at", "systemId", "triggerFleetId"]);
const STEP_KEYS = Object.freeze(["phaseSeq", "round", "siegeId"]);
const NO_START_COUNTER = Object.freeze({ HIGHSEC: "noTarget", ENGAGED: "contested", NO_TARGET: "noTarget",
  CONTESTED: "contested", LIMIT: "noTarget", INSUFFICIENT_FORCE: "insufficientForce", BUSY: "noTarget",
  CORE_PROTECTED: "coreProtected", REPEL_COOLDOWN: "repelCooldown" });
const END_COUNTER = Object.freeze({ DESTROYED: "destroyed", CAPTURED: "captured", SACKED: "sacked" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function wreckRefusalOf(placed) {
  const p = isPlain(placed) ? placed : {};
  const inner = p.reason === "APPLY_REFUSED" && isPlain(p.refusal) ? p.refusal : p;
  const err = p.reason === "APPLY_FAILED" ? p.error : inner.error;
  const errText = err === undefined || err === null ? null
    : (err instanceof Error ? `${err.name}: ${messageOf(err)}` : messageOf(err));
  const code = typeof inner.code === "string" ? inner.code : (typeof p.code === "string" ? p.code : null);
  const stage = typeof inner.stage === "string" ? inner.stage : (p.reason === "APPLY_FAILED" ? "exception" : null);
  const reason = typeof inner.reason === "string" && inner.reason ? inner.reason : "WRECK_REFUSED";
  return Object.freeze({ reason: String(reason).slice(0, MAX_DETAIL), stage, code, error: errText });
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parseCheckPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== CHECK_KEYS.join()) return null;
  if (!isId(p.systemId) || !isTime(p.at)) return null;
  if (p.triggerFleetId !== null && (typeof p.triggerFleetId !== "string" || p.triggerFleetId === "")) return null;
  return { systemId: p.systemId, at: p.at, triggerFleetId: p.triggerFleetId };
}

function parseStepPayload(p) {
  if (!isPlain(p) || Object.keys(p).sort().join() !== STEP_KEYS.join()) return null;
  if (typeof p.siegeId !== "string" || p.siegeId === "" || p.siegeId.length > S.MAX_ID_LENGTH
    || !isTime(p.phaseSeq) || !isTime(p.round)) return null;
  return { siegeId: p.siegeId, phaseSeq: p.phaseSeq, round: p.round };
}

const unitsOf = (lost) => Math.min(S.MAX_TOTAL, (lost || []).reduce((n, e) => n + Math.max(0, e.quantity || 0), 0));
const nested = (detail) => ({ ok: false, reason: "NESTED_KEY_REUSED", detail });

function createSiegeService(deps) {
  const { store, sieges, scheduler, fleetRepository, registry, config, groups } = deps;
  const C = config.siege;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const params = Object.freeze({ allowHighsec: C.allowHighsec === true, maxOpenSieges: C.maxOpenSieges,
    maxOpenSiegesPerFaction: C.maxOpenSiegesPerFaction, timerScale: C.timerScale, assaultMinMs: C.assaultMinMs,
    assaultMaxMs: C.assaultMaxMs, sackCooldownMs: C.sackCooldownMs, repelCooldownMs: C.repelCooldownMs });
  const coreIndex = deps.coreIndex || getCoreIndex(config);
  const protectedStation = (stationId, systemId, ownerFactionId) => isCoreStation(coreIndex, stationId)
    || (Number.isSafeInteger(ownerFactionId) && bastionOwnerOf(coreIndex, systemId) === ownerFactionId);

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "ready";
  let lastRefusal = null;
  let lastWreckRefusal = null;
  let seq = 0;
  let openCount = 0;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !own(counters, name)) return;
    counters[name] += n;
    seq += 1;
    metric("count", `stations.siege.${name}`, n);
  }

  function setOpen(n) {
    openCount = Math.max(0, n);
    metric("gauge", "stations.siege.open", openCount);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state === "stopped";
  const isHostile = (a, b) => isId(a) && isId(b) && a !== b && call(() => deps.hostility(a, b) === true, false);
  const isActive = (f) => call(() => registry.isActive(f) === true, false);

  function stationsNow() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), "off") : "off";
    return { mode, repository: mode === STATION_MODE_READY && st ? st.repository : null };
  }

  function graphNow() {
    const r = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function getMode() {
    if (stopped()) return "off";
    const mode = stationsNow().mode;
    if (mode === STATION_MODE_PENDING) return STATION_MODE_PENDING;
    if (mode !== STATION_MODE_READY) return "off";
    return graphNow() ? STATION_MODE_READY : STATION_MODE_PENDING;
  }

  function captureOf(factionId) {
    return call(() => {
      const entry = registry.getFaction(factionId);
      const doctrine = entry && entry.doctrineId !== null && entry.doctrineId !== undefined
        && typeof registry.getDoctrine === "function" ? registry.getDoctrine(entry.doctrineId) : null;
      const corp = typeof registry.corporationFor === "function" ? registry.corporationFor(factionId, STATION_ROLE)
        : null;
      return { canCapture: Boolean(doctrine && doctrine.canOccupy === true && doctrine.capturesStations !== false) && isId(corp), corporationId: corp };
    }, { canCapture: false, corporationId: null });
  }

  function readFleets(tx, systemId) {
    const listed = fleetRepository.listFleetsInSystem(tx, systemId, { states: [...S.READ_FLEET_STATES],
      limit: C.maxFleetsReadPerCheck + 1 });
    if (!listed || !listed.ok) return listed || { ok: false, reason: "FLEETS_READ_FAILED" };
    const truncated = listed.fleets.length > C.maxFleetsReadPerCheck || listed.nextAfterFleetId !== null;
    return { ok: true, fleets: listed.fleets.slice(0, C.maxFleetsReadPerCheck), truncated };
  }

  function gridOn() {
    if (C.gridEnabled !== true || !deps.grid) return false;
    return call(() => deps.grid.isEnabled() === true && deps.grid.movesEnabled() === true, false);
  }

  function gridScopeIn(tx, systemId, fleets, at, records) {
    if (C.gridEnabled !== true) return { scope: null, fallback: false, noAnchor: false };
    if (!gridOn()) return { scope: null, fallback: true, noAnchor: false };
    const pos = deps.grid.positionsOf(tx, systemId, fleets, at);
    if (!pos || pos.ok !== true || pos.anchorsReason !== null || !(pos.positions instanceof Map)) {
      return { scope: null, fallback: true, noAnchor: false };
    }
    const sg = deps.grid.readSystemGrid(systemId);
    if (!sg || sg.ok !== true) return { scope: null, fallback: true, noAnchor: false };
    const scope = gridScopeOf({ positions: pos.positions, grids: sg.grids,
      targets: records.map((r) => ({ targetId: r.stationId, ref: targetRefOf({ kind: "lne", record: r }) })) });
    const noAnchor = records.some((r) => scope.targetGridOf.get(r.stationId) === null);
    return { scope, fallback: false, noAnchor };
  }

  function siegeMovesInTx(tx, scope, fleets, attackerFactionId, stationId, systemId, at) {
    const out = { moved: 0, refused: 0, arriveMax: null, refusal: null };
    const tg = scope.targetGridOf.get(stationId);
    const to = scope.anchorOf.get(stationId);
    if (typeof tg !== "string" || !to) return out;
    for (const m of gridMoversOf(fleets, attackerFactionId, scope.gridOfFleet, tg, C.gridMaxMovers)) {
      let r;
      try {
        r = deps.grid.moveInTx(tx, { fleetId: m.fleetId, systemId, legSeq: m.legSeq, at, to,
          purpose: SIEGE_PURPOSE }, { chained: true });
      } catch (err) {
        if (!tx || tx.inTransaction === false) throw err;
        r = { ok: false, reason: "MOVE_FAILED" };
      }
      if (r && r.ok === true && r.moved === true) {
        out.moved += 1;
        out.arriveMax = out.arriveMax === null ? r.arriveAt : Math.max(out.arriveMax, r.arriveAt);
      } else if (!r || r.ok !== true) {
        out.refused += 1;
        out.refusal = `GRID_MOVE_${String((r && r.reason) || "REFUSED")}`;
      }
    }
    return out;
  }

  function bumpGrid(v) {
    if (!v) return;
    if (v.gridFallback) bump("gridFallback");
    if (v.gridNoAnchor) bump("gridNoAnchor");
    bump("gridMoves", v.gridMoves || 0);
    bump("gridMoveRefused", v.gridMoveRefused || 0);
    if (v.gridMoveRefusal) lastRefusal = v.gridMoveRefusal;
  }

  function enqueueCheck(tx, systemId, at, key, triggerFleetId) {
    const r = scheduler.enqueue(S.CHECK_EVENT_TYPE, String(systemId), at, { systemId, at,
      triggerFleetId: triggerFleetId === undefined ? null : triggerFleetId }, key, { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "check" };
    return { ok: true, duplicate: r.duplicate === true };
  }

  function enqueueStep(tx, siegeId, phaseSeq, round, dueAt) {
    const r = scheduler.enqueue(S.STEP_EVENT_TYPE, siegeId, dueAt, { siegeId, phaseSeq, round },
      S.stepKey(siegeId, phaseSeq, round), { tx, chained: true });
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", stage: "step" };
    return { ok: true };
  }

  function onArrival(tx, arrival) {
    if (stopped() || !arrival) return;
    if (!S.HOLD_STATES.includes(arrival.state) || !S.SIEGE_ROLES.includes(arrival.fleetRole)) return;
    const repository = stationsNow().repository;
    if (!repository) return;
    const c = repository.countLiveBySystem(tx, [arrival.systemId]);
    if (!c || c.ok !== true) return;
    if (!c.rows.some((r) => r.count > 0 && isHostile(arrival.factionId, r.factionId))) return;
    const r = enqueueCheck(tx, arrival.systemId, arrival.at,
      S.arrivalCheckKey(arrival.systemId, arrival.fleetId, arrival.legSeq), arrival.fleetId);
    if (!r.ok) bump("enqueueRefused");
  }

  function requestCheckInTx(tx, spec) {
    if (stopped()) return { ok: false, reason: "SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isPlain(spec) || !isId(spec.systemId) || !isTime(spec.at) || typeof spec.key !== "string"
      || spec.key === "" || (spec.triggerFleetId !== undefined && spec.triggerFleetId !== null
        && typeof spec.triggerFleetId !== "string")) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    return enqueueCheck(tx, spec.systemId, spec.at, spec.key, spec.triggerFleetId);
  }

  function applyConsequence(tx, settled, ck) {
    const skipped = () => {
      bump("consequenceSkipped");
      return { ok: true, skipped: "SIEGE_OFF" };
    };
    if (stopped()) return skipped();
    if (!isPlain(settled) || !isId(settled.systemId) || !isTime(settled.at) || typeof ck !== "string" || ck === "") {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const stay = [...new Set((Array.isArray(settled.fleets) ? settled.fleets : [])
      .filter((f) => f && STAY_DISPOSITIONS.includes(f.disposition)).map((f) => f.factionId))];
    if (stay.length === 0) return { ok: true, skipped: "NONE_LEFT" };
    const mode = getMode();
    const check = () => requestCheckInTx(tx, { systemId: settled.systemId, at: settled.at, key: `${ck}:check`,
      triggerFleetId: null });
    if (mode === STATION_MODE_PENDING) return check();
    if (mode !== STATION_MODE_READY) return skipped();
    const repository = stationsNow().repository;
    if (!repository) return skipped();
    const c = repository.countLiveBySystem(tx, [settled.systemId]);
    if (!c || c.ok !== true) return c || { ok: false, reason: "STATIONS_READ_FAILED" };
    if (!c.rows.some((r) => r.count > 0 && stay.some((f) => isHostile(f, r.factionId)))) {
      return { ok: true, skipped: "NO_STATION" };
    }
    return check();
  }

  function readForFaction(tx, factionId, opts) {
    if (stopped()) return { ok: false, reason: "SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
    const l = listOpenFor(tx, opts);
    if (!l || !l.ok) return l || { ok: false, reason: "SIEGE_READ_FAILED" };
    return { ok: true, ...splitFor(l.sieges, factionId), truncated: l.truncated === true };
  }

  function readForFactions(tx, factionIds, opts) {
    if (stopped()) return { ok: false, reason: "SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!Array.isArray(factionIds) || !factionIds.every(isId)) return { ok: false, reason: "INVALID_INPUT" };
    const l = listOpenFor(tx, opts);
    if (!l || !l.ok) return l || { ok: false, reason: "SIEGE_READ_FAILED" };
    const byFaction = new Map(factionIds.map((f) => [f, splitFor(l.sieges, f)]));
    return { ok: true, byFaction, truncated: l.truncated === true };
  }

  function listOpenFor(tx, opts) {
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : C.maxOpenSieges;
    return sieges.listOpen(tx, { limit });
  }

  function splitFor(list, factionId) {
    const attacking = list.filter((s) => s.attackerFactionId === factionId).map((s) => ({ siegeId: s.siegeId,
      systemId: s.systemId, stationId: s.stationId, state: s.state }));
    const defending = list.filter((s) => s.ownerFactionId === factionId).map((s) => ({ siegeId: s.siegeId,
      stationId: s.stationId, systemId: s.systemId, state: s.state, phaseEndsAt: s.phaseEndsAt,
      attackerFactionId: s.attackerFactionId, attackerStrength: s.attackerStrength }));
    return { attacking, defending };
  }

  function readCheck(tx, repository, p, system) {
    const listed = repository.listStationsInSystem(tx, p.systemId);
    if (!listed.ok) return listed;
    const fl = readFleets(tx, p.systemId);
    if (!fl.ok) return fl;
    const open = sieges.listOpenInSystem(tx, p.systemId);
    if (!open.ok) return open;
    const total = sieges.countOpen(tx);
    if (!total.ok) return total;
    const openByAttacker = new Map();
    for (const f of [...new Set(fl.fleets.map((x) => x.factionId))]) {
      const c = sieges.countOpen(tx, { attackerFactionId: f });
      if (!c.ok) return c;
      openByAttacker.set(f, c.count);
    }
    const lastSieges = new Map();
    for (const st of listed.records) {
      const last = sieges.getLastByStation(tx, st.stationId);
      if (!last.ok) return last;
      if (last.siege) lastSieges.set(st.stationId, last.siege);
    }
    let lastByPair = null;
    if (Number.isSafeInteger(params.repelCooldownMs) && params.repelCooldownMs > 0) {
      lastByPair = new Map();
      const factionsHere = [...new Set(fl.fleets.map((x) => x.factionId))].sort((a, b) => a - b);
      for (const st of listed.records) {
        const m = new Map();
        const last = lastSieges.get(st.stationId);
        for (const f of factionsHere) {
          if (f === st.ownerFactionId) continue;
          if (last && last.attackerFactionId === f) {
            m.set(f, last);
            continue;
          }
          const r = sieges.getLastByStationAttacker(tx, st.stationId, f);
          if (!r.ok) return r;
          if (r.siege) m.set(f, r.siege);
        }
        lastByPair.set(st.stationId, m);
      }
    }
    const g = gridScopeIn(tx, p.systemId, fl.fleets, p.at, listed.records);
    const plan = planStart({ system: { systemId: p.systemId, secClass: system.secClass }, stations: listed.records,
      fleets: fl.fleets, openSieges: open.sieges, openTotal: total.count, openByAttacker,
      triggerFleetId: p.triggerFleetId, at: p.at, isHostile, isActive, groups, params, truncated: fl.truncated,
      lastSieges, isCoreStation: (id) => {
        const st = listed.records.find((s) => s.stationId === id);
        return protectedStation(id, p.systemId, st ? st.ownerFactionId : null);
      }, ...(lastByPair ? { lastByPair } : {}),
      ...(g.scope ? { grid: { gridOfFleet: g.scope.gridOfFleet, targetGridOf: g.scope.targetGridOf } } : {}) });
    const station = plan.start ? listed.records.find((s) => s.stationId === plan.start.stationId) : null;
    return { ok: true, plan, station, scope: g.scope, fleets: fl.fleets,
      gridNote: { gridFallback: g.fallback, gridNoAnchor: g.noAnchor } };
  }

  function approachEffect(tx, p, read) {
    const a = read.plan.approach;
    const m = siegeMovesInTx(tx, read.scope, read.fleets, a.attackerFactionId, a.stationId, p.systemId, p.at);
    return { ok: true, approach: true, gridMoves: m.moved, gridMoveRefused: m.refused, gridMoveRefusal: m.refusal };
  }

  function startEffect(tx, ev, p, plan, seen, read) {
    const repository = stationsNow().repository;
    if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const g = repository.getStation(tx, seen.stationId);
    if (!g.ok) return g;
    const st = g.record;
    if (!st || st.version !== seen.version || st.state !== seen.state || st.ownerFactionId !== seen.ownerFactionId) {
      return { ok: true, started: false, reason: "STALE" };
    }
    const open = sieges.getOpenByStation(tx, st.stationId);
    if (!open.ok) return open;
    if (open.siege) return { ok: true, started: false, reason: "BUSY" };
    const no = sieges.nextSiegeNo(tx, st.stationId);
    if (!no.ok) return no;
    const s = plan.start;
    const key = S.startKey(st.stationId, no.siegeNo);
    const m = read && read.scope ? siegeMovesInTx(tx, read.scope, read.fleets, s.attackerFactionId, st.stationId,
      st.systemId, p.at) : null;
    const phaseEndsAt = m && m.arriveMax !== null ? Math.max(s.phaseEndsAt, m.arriveMax) : s.phaseEndsAt;
    const created = sieges.createSiege(tx, { stationId: st.stationId, siegeNo: no.siegeNo, systemId: st.systemId,
      ownerFactionId: st.ownerFactionId, attackerFactionId: s.attackerFactionId, state: s.state,
      phaseEndsAt, plan: s.plan, attackerShips: s.attackerShips, attackerStrength: s.attackerStrength,
      at: p.at }, key);
    if (!created.ok) return created;
    if (created.duplicate) return nested(key);
    const pruned = sieges.pruneEnded(tx, { before: Math.max(0, ev.dueAt - C.retentionMs), limit: C.pruneBatch });
    if (!pruned.ok) return pruned;
    const e = enqueueStep(tx, created.siegeId, 0, 0, phaseEndsAt);
    if (!e.ok) return e;
    const out = { ok: true, started: true, siegeId: created.siegeId, stationId: st.stationId, systemId: st.systemId,
      attackerFactionId: s.attackerFactionId, ownerFactionId: st.ownerFactionId, state: s.state };
    if (m) Object.assign(out, { gridMoves: m.moved, gridMoveRefused: m.refused, gridMoveRefusal: m.refusal });
    return out;
  }

  function onCheck(ev) {
    try {
      const p = parseCheckPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SIEGE_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "SIEGE_STOPPED" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      const afterBattle = typeof ev.idempotencyKey === "string" && ev.idempotencyKey.endsWith(CONSEQUENCE_CHECK_SUFFIX);
      const counted = () => {
        bump("checks");
        if (afterBattle) bump("checkAfterBattle");
      };
      const system = typeof graph.getSystem === "function" ? graph.getSystem(p.systemId) : null;
      if (!system) return { ok: true, outcome: "UNKNOWN_SYSTEM", onCommitted: counted };
      const repository = stationsNow().repository;
      if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      const tx = store.transaction("siege.checkRead", (db) => readCheck(db, repository, p, system));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "SIEGE_READ_FAILED" };
      const plan = read.plan;
      const note = read.gridNote;
      if (!plan.start && plan.approach && read.scope) {
        return { ok: true, outcome: "APPROACH", effect: (etx) => approachEffect(etx, p, read), onCommitted: (v) => {
          counted();
          bump("gridApproach");
          bumpGrid({ ...note, ...v });
        } };
      }
      if (!plan.start) {
        return { ok: true, outcome: plan.reason, onCommitted: () => {
          counted();
          bump(NO_START_COUNTER[plan.reason] || "noTarget");
          bumpGrid(note);
        } };
      }
      const seen = read.station;
      return { ok: true, outcome: "START", effect: (etx, event) => startEffect(etx, event, p, plan, seen, read),
        onCommitted: (v) => {
          counted();
          bumpGrid({ ...note, ...(v || {}) });
          if (!v || v.started !== true) {
            bump("stale");
            return;
          }
          bump("started");
          setOpen(openCount + 1);
          log(`siege: ${v.siegeId} ${v.state} station=${v.stationId} system=${v.systemId} attacker=`
            + `${v.attackerFactionId} owner=${v.ownerFactionId}`);
        } };
    } catch (err) {
      return { ok: false, reason: `SIEGE_CHECK_FAILED: ${messageOf(err)}` };
    }
  }

  function moversOf(tx, repository, k, at, station, siege) {
    const moveStation = (from, to, patch, wipe) => {
      const change = { stationId: station.stationId, expectedVersion: station.version, from, to, key: `${k}:station`,
        reason: SIEGE_REASON, at };
      if (patch) change.patch = patch;
      if (wipe) change.wipeStock = true;
      const r = repository.transitionStation(tx, change);
      if (!r.ok) return r;
      if (r.duplicate) return nested(`${k}:station`);
      return r;
    };
    const moveSiege = (to, patch) => {
      const r = sieges.transitionSiege(tx, { siegeId: siege.siegeId, expectedVersion: siege.version,
        from: siege.state, to, at, patch: { phaseSeq: siege.phaseSeq + 1, ...patch } }, `${k}:siege`);
      if (!r.ok) return r;
      if (r.duplicate) return nested(`${k}:siege`);
      return r;
    };
    return { moveStation, moveSiege };
  }

  function step(tx, ev, p) {
    const k = ev.idempotencyKey;
    const at = ev.dueAt;
    const g = sieges.getSiege(tx, p.siegeId);
    if (!g.ok) return g;
    const siege = g.siege;
    const out = { action: "STALE", siegeId: p.siegeId };
    if (!siege || siege.open !== true || siege.phaseSeq !== p.phaseSeq || siege.waitRound !== p.round) {
      return { ok: true, ...out };
    }
    const repository = stationsNow().repository;
    if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
    const sr = repository.getStation(tx, siege.stationId);
    if (!sr.ok) return sr;
    const station = sr.record;
    const fl = readFleets(tx, siege.systemId);
    if (!fl.ok) return fl;
    const gs = gridScopeIn(tx, siege.systemId, fl.fleets, at, station ? [station] : []);
    const tg = gs.scope ? gs.scope.targetGridOf.get(siege.stationId) : null;
    const gridded = typeof tg === "string";
    const hold = gridded ? gridHoldOf(fl.fleets, siege.attackerFactionId, isHostile, groups, gs.scope.gridOfFleet, tg,
      { attackersAnywhere: false }) : holdOf(fl.fleets, siege.attackerFactionId, isHostile, groups);
    if (fl.truncated) hold.contested = true;
    const cap = captureOf(siege.attackerFactionId);
    const coreProtected = protectedStation(siege.stationId, siege.systemId, siege.ownerFactionId);
    const d = decideStep(siege, station, hold, { at, phaseSeq: p.phaseSeq, round: p.round,
      maxWaitRounds: C.maxWaitRounds, canCapture: cap.canCapture, captureUpwell: C.captureUpwell === true,
      coreProtected, ...(gridded ? { gridAway: hold.awayShips } : {}) });
    Object.assign(out, { action: d.action, reason: d.reason || null, systemId: siege.systemId,
      stationId: siege.stationId, attackerFactionId: siege.attackerFactionId, ownerFactionId: siege.ownerFactionId });
    if (C.gridEnabled === true) Object.assign(out, { gridFallback: gs.fallback, gridNoAnchor: gs.noAnchor });
    const regroup = () => {
      if (!gridded) return;
      const m = siegeMovesInTx(tx, gs.scope, fl.fleets, siege.attackerFactionId, siege.stationId, siege.systemId, at);
      Object.assign(out, { gridMoves: m.moved, gridMoveRefused: m.refused, gridMoveRefusal: m.refusal });
    };

    const { moveStation, moveSiege } = moversOf(tx, repository, k, at, station, siege);
    const closeWith = (to, reason, stationTo) => {
      if (stationTo) {
        const m = moveStation(station.state, stationTo, { stateUntilAt: null }, false);
        if (!m.ok) return m;
      }
      const t = moveSiege(to, { endedAt: at, endReason: reason });
      if (!t.ok) return t;
      const c = enqueueCheck(tx, siege.systemId, at, S.endCheckKey(siege.systemId, siege.siegeId), null);
      return c.ok ? { ok: true, ...out, to } : c;
    };

    switch (d.action) {
      case "STALE":
        return { ok: true, ...out };
      case "WAIT":
      case "GATHER": {
        const w = sieges.noteWait(tx, { siegeId: siege.siegeId, expectedVersion: siege.version, waitRound: d.round,
          at }, `${k}:siege`);
        if (!w.ok) return w;
        if (w.duplicate) return nested(`${k}:siege`);
        regroup();
        const e = enqueueStep(tx, siege.siegeId, siege.phaseSeq, d.round, at + C.recheckMs);
        return e.ok ? { ok: true, ...out } : e;
      }
      case "ADVANCE": {
        if (d.station) {
          const m = moveStation(d.station.from, d.station.to, { stateUntilAt: d.station.stateUntilAt }, false);
          if (!m.ok) return m;
        }
        const t = moveSiege(d.to, { waitRound: 0, phaseStartedAt: at, phaseEndsAt: d.phaseEndsAt,
          attackerShips: hold.attackerShips, attackerStrength: hold.attackerStrength });
        if (!t.ok) return t;
        regroup();
        const e = enqueueStep(tx, siege.siegeId, siege.phaseSeq + 1, 0, d.phaseEndsAt);
        return e.ok ? { ok: true, ...out, to: d.to } : e;
      }
      case "REPEL":
        return closeWith(S.REPELLED, d.reason, d.stationTo);
      case "ABORT":
        return closeWith(S.ABORTED, d.reason, station && station.state !== STATION_DESTROYED ? d.stationTo : null);
      case "END":
        return endSiege(tx, k, at, siege, station, d, cap, out, moveStation, moveSiege);
      default:
        return { ok: false, reason: "UNKNOWN_ACTION", permanent: true };
    }
  }

  function endSiege(tx, k, at, siege, station, d, cap, out, moveStation, moveSiege, opts) {
    const repository = stationsNow().repository;
    const skipWreck = Boolean(opts && opts.skipWreck === true);
    let to = d.to;
    let endReason = opts && typeof opts.endReason === "string" ? opts.endReason : d.to;
    let lost = [];
    let buildRefused = false;
    if (d.anchoring) {
      const m = moveStation(STATION_ANCHORING, STATION_DESTROYED, null, false);
      if (!m.ok) return m;
      lost = m.lostStock;
      const construction = typeof deps.getConstruction === "function" ? call(deps.getConstruction, null) : null;
      const f = construction && typeof construction.failBuildInTx === "function"
        ? construction.failBuildInTx(tx, { stationId: station.stationId, at, reason: STATION_DESTROYED }, `${k}:build`)
        : { ok: false, reason: "CONSTRUCTION_UNAVAILABLE" };
      if (!f || f.ok !== true) buildRefused = true;
    } else {
      if (to === S.CAPTURED) {
        const c = repository.captureStation(tx, { stationId: station.stationId, expectedVersion: station.version,
          from: station.state, ownerFactionId: siege.attackerFactionId, ownerCorporationId: cap.corporationId,
          key: `${k}:capture`, reason: CAPTURE_REASON, at });
        if (!c.ok && CAPTURE_LIMIT_REASONS.includes(c.reason)) {
          to = station.kind === KIND_NPC ? S.SACKED : S.DESTROYED;
          endReason = "CAPTURE_LIMIT";
        } else if (!c.ok) return c;
        else if (c.duplicate) return nested(`${k}:capture`);
        else lost = c.lostStock;
      }
      if (to === S.DESTROYED) {
        const m = moveStation(station.state, STATION_DESTROYED, null, false);
        if (!m.ok) return m;
        lost = m.lostStock;
      } else if (to === S.SACKED) {
        const m = moveStation(station.state, STATION_ONLINE, { stateUntilAt: null }, true);
        if (!m.ok) return m;
        lost = m.lostStock;
      }
    }
    const occupation = typeof deps.getOccupation === "function" ? call(deps.getOccupation, null) : null;
    const o = occupation && typeof occupation.applyStructureOutcomeInTx === "function"
      ? occupation.applyStructureOutcomeInTx(tx, { systemId: siege.systemId, siegeId: siege.siegeId,
        winnerFactionId: siege.attackerFactionId, loserFactionId: siege.ownerFactionId, at }, `${k}:occ`)
      : { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
    const occupationRefused = !o || o.ok !== true;

    let wreckRefused = false;
    let wreckRefusal = null;
    if (!skipWreck && to === S.DESTROYED && config.wrecks && config.wrecks.enabled !== false) {
      const family = familyOf(station);
      if (family && Object.prototype.hasOwnProperty.call(STRUCTURE_DEFENSE, family)) {
        const wrecks = typeof deps.getWrecks === "function" ? deps.getWrecks() : null;
        const wreckRepo = wrecks && wrecks.repository;
        const journal = deps.journal;
        if (wreckRepo && (!journal || typeof journal.applyOnce !== "function")) {
          wreckRefused = true;
          wreckRefusal = Object.freeze({ reason: "JOURNAL_UNAVAILABLE", stage: "journal", code: null, error: null });
        }
        else if (wreckRepo) {
          const wreckSettings = { ...config.wrecks };
          const placed = journal.applyOnce(tx, { key: `${k}:wreck`,
            aggregate: { type: S.SIEGE_AGGREGATE, id: siege.siegeId }, eventType: S.EVENT_SIEGE_WRECK,
            payload: { siegeId: siege.siegeId, stationId: station.stationId, at } }, (tx2) => {
            const built = buildStructureWreckField({
              stationId: station.stationId,
              siegeNo: siege.siegeNo,
              systemId: siege.systemId,
              environment: station.kind === KIND_NPC ? "highsec" : "nullsec",
              ownerFactionId: siege.ownerFactionId,
              winnerFactionId: siege.attackerFactionId,
              typeId: station.typeId || 0,
              family,
              lostUnits: unitsOf(lost),
              at,
            }, wreckSettings);
            if (!built.ok) return built;
            return placeFieldInTx(tx2, built.field, `${k}:wreck`, {
              repository: wreckRepo,
              scheduler: deps.scheduler,
              settings: wreckSettings,
              onCount: (name) => { try { deps.telemetry?.hooks?.onCount?.(name, 1); } catch (_) {} },
              settled: { systemId: siege.systemId, at },
              ck: k,
            });
          });
          if (!placed || placed.ok !== true) {
            wreckRefused = true;
            wreckRefusal = wreckRefusalOf(placed);
          }
        }
      }
    }

    const t = moveSiege(to, { endedAt: at, endReason, lostItems: lost.length, lostUnits: unitsOf(lost) });
    if (!t.ok) return t;
    const c = enqueueCheck(tx, siege.systemId, at, S.endCheckKey(siege.systemId, siege.siegeId), null);
    if (!c.ok) return c;
    return { ok: true, ...out, to, anchoring: d.anchoring === true, lostUnits: unitsOf(lost), occupationRefused,
      buildRefused, wreckRefused, wreckRefusal, occupationOutcome: o && o.ok ? o.outcome : (o && o.reason) || null };
  }

  function onStepCommitted(v) {
    if (!v || v.ok !== true) return;
    bumpGrid(v);
    switch (v.action) {
      case "STALE": bump("stale"); return;
      case "WAIT": bump("waits"); return;
      case "GATHER":
        bump("waits");
        bump("gridGathers");
        return;
      case "ADVANCE": bump("advanced"); return;
      case "REPEL":
        bump("repelled");
        if (v.reason === "CORE_PROTECTED") bump("coreProtected");
        break;
      case "ABORT": bump("aborted"); break;
      case "END":
        bump(END_COUNTER[v.to]);
        if (v.anchoring) bump("anchorKilled");
        if (v.occupationRefused) bump("occupationRefused");
        if (v.buildRefused) bump("buildFailRefused");
        if (v.wreckRefused) {
          bump("wreckRefused");
          lastWreckRefusal = Object.freeze({ siegeId: v.siegeId, stationId: v.stationId, ...(v.wreckRefusal
            || { reason: "WRECK_REFUSED", stage: null, code: null, error: null }) });
          lastRefusal = `WRECK_${lastWreckRefusal.reason}`;
        }
        break;
      default: return;
    }
    setOpen(openCount - 1);
    const w = v.action === "END" && v.wreckRefused ? lastWreckRefusal : null;
    log(`siege: ${v.siegeId} ${v.to} ${v.reason || ""} station=${v.stationId} system=${v.systemId} attacker=`
      + `${v.attackerFactionId} owner=${v.ownerFactionId}${v.action === "END" ? ` lostUnits=${v.lostUnits}` : ""}`
      + (w ? ` WARN wreck=${w.reason} stage=${w.stage || "?"}${w.code ? ` code=${w.code}` : ""}`
        + `${w.error ? ` error=${JSON.stringify(w.error)}` : ""}` : ""));
  }

  function onStep(ev) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SIEGE_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "SIEGE_STOPPED" };
      if (!stationsNow().repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      return { ok: true, outcome: "STEP", effect: (tx, event) => {
        const r = step(tx, event, p);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted: onStepCommitted };
    } catch (err) {
      return { ok: false, reason: `SIEGE_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function nativeInTx(tx, repository, spec) {
    const g = repository.getStation(tx, spec.stationId);
    if (!g.ok) return g;
    const station = g.record;
    if (!station) return { ok: true, outcome: NATIVE.NO_SIEGE };
    if (station.state === STATION_DESTROYED) {
      const last = sieges.getLastByStation(tx, station.stationId);
      if (!last.ok) return last;
      const done = last.siege && last.siege.endReason === S.END_REASON_NATIVE;
      return { ok: true, outcome: done ? NATIVE.DUPLICATE : NATIVE.NO_SIEGE };
    }
    const o = sieges.getOpenByStation(tx, station.stationId);
    if (!o.ok) return o;
    const siege = o.siege;
    if (!siege) return { ok: true, outcome: NATIVE.NO_SIEGE };
    const v = decideNative(siege, station, { destroyedAt: spec.destroyedAt,
      coreProtected: protectedStation(siege.stationId, siege.systemId, siege.ownerFactionId) });
    if (v !== null) return { ok: true, outcome: v };
    const k = S.nativeKey(siege.siegeId);
    const at = spec.at;
    const anchoring = siege.state === S.ANCHOR_ASSAULT;
    const out = { action: "END", reason: S.END_REASON_NATIVE, siegeId: siege.siegeId, systemId: siege.systemId,
      stationId: siege.stationId, attackerFactionId: siege.attackerFactionId, ownerFactionId: siege.ownerFactionId };
    const a = deps.journal.applyOnce(tx, { key: k, aggregate: { type: S.SIEGE_AGGREGATE, id: siege.siegeId },
      eventType: S.EVENT_SIEGE_NATIVE, payload: { siegeId: siege.siegeId, stationId: station.stationId,
        structureId: spec.structureId } }, (tx2) => {
      const { moveStation, moveSiege } = moversOf(tx2, repository, k, at, station, siege);
      return endSiege(tx2, k, at, siege, station, { action: "END", to: S.DESTROYED, anchoring }, captureOf(
        siege.attackerFactionId), out, moveStation, moveSiege, { skipWreck: true, endReason: S.END_REASON_NATIVE });
    });
    if (!a || a.ok !== true) {
      const inner = a && a.reason === "APPLY_REFUSED" && isPlain(a.refusal) ? a.refusal : a;
      return { ok: false, reason: String((inner && inner.reason) || "NATIVE_REFUSED") };
    }
    if (a.duplicate) return { ok: true, outcome: NATIVE.DUPLICATE };
    return { ok: true, outcome: NATIVE.DESTROYED, ended: a.value };
  }

  function applyNativeDestruction(spec) {
    try {
      if (stopped()) return { ok: true, outcome: NATIVE.SIEGE_OFF };
      if (!isPlain(spec) || typeof spec.stationId !== "string" || spec.stationId === ""
        || spec.stationId.length > S.MAX_ID_LENGTH || !isId(spec.structureId) || !isTime(spec.at)
        || !isTime(spec.destroyedAt)) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const repository = stationsNow().repository;
      if (!repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      if (!deps.journal || typeof deps.journal.applyOnce !== "function") {
        return { ok: false, reason: "JOURNAL_UNAVAILABLE" };
      }
      const tx = store.transaction("siege.native", (db) => nativeInTx(db, repository, spec));
      const r = tx.ok ? tx.value : tx;
      if (!r || r.ok !== true) {
        lastRefusal = `NATIVE_${String((r && r.reason) || "TX_FAILED")}`;
        return { ok: false, reason: String((r && r.reason) || "TX_FAILED") };
      }
      if (r.outcome === NATIVE.DESTROYED) {
        bump("nativeEnded");
        onStepCommitted(r.ended);
      }
      return { ok: true, outcome: r.outcome };
    } catch (err) {
      return { ok: false, reason: `SIEGE_NATIVE_FAILED: ${messageOf(err)}` };
    }
  }

  function reconcile() {
    try {
      if (stopped()) return { ok: false, reason: "SIEGE_UNAVAILABLE" };
      const read = store.transaction("siege.reconcileRead", (db) => {
        const l = sieges.listOpen(db, { limit: C.reconcileMaxSieges });
        if (!l.ok) return l;
        const c = sieges.countOpen(db);
        if (!c.ok) return c;
        return { ok: true, sieges: l.sieges, count: c.count };
      });
      const r = read.ok ? read.value : read;
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
      setOpen(r.count);
      const specs = r.sieges.map((s) => ({ eventType: S.STEP_EVENT_TYPE, aggregateId: s.siegeId,
        dueAt: s.phaseEndsAt, payload: { siegeId: s.siegeId, phaseSeq: s.phaseSeq, round: s.waitRound },
        idempotencyKey: S.stepKey(s.siegeId, s.phaseSeq, s.waitRound) }));
      let enqueued = 0;
      let duplicates = 0;
      for (let i = 0; i < specs.length; i += RECONCILE_CHUNK) {
        const e = scheduler.enqueueMany(specs.slice(i, i + RECONCILE_CHUNK));
        if (!e || !e.ok) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", enqueued, duplicates };
        enqueued += e.enqueued;
        duplicates += e.duplicates;
        if (e.refusal) {
          log(`siege: reconcile refused ${e.refusal.reason || "?"}`);
          break;
        }
      }
      bump("reconciled", enqueued);
      return { ok: true, open: r.count, enqueued, duplicates };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state, seq, mode: getMode(), open: openCount, counters: Object.freeze({ ...counters }),
      lastRefusal, lastWreckRefusal });
  }

  return Object.freeze({
    getMode,
    onArrival,
    onCheck,
    onStep,
    requestCheckInTx,
    applyConsequence,
    readForFaction,
    readForFactions,
    applyNativeDestruction,
    reconcile,
    getStatus,
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: stopped,
  });
}

module.exports = { createSiegeService, parseCheckPayload, parseStepPayload, COUNTER_NAMES };
