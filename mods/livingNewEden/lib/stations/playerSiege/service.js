"use strict";

const S = require("./schema");
const { planPlayerStart, decidePlayerStep, targetOf, siegeFactionsOf } = require("./machine");
const { holdOf } = require("../siege/siegeMachine");
const { SIEGE_ROLES, HOLD_STATES, READ_FLEET_STATES } = require("../siege/schema");
const { targetRefOf, gridScopeOf, gridHoldOf, moversOf: gridMoversOf } = require("../siege/gridScope");
const { relationOf, huntThresholds } = require("../../playerHunt/policy");
const { parseNeutralPolicy } = require("../../playerHunt/schema");
const { STATE: EVENT_STATE } = require("../../scheduler/schema");

const NULLSEC = "nullsec";
const LAYERS = Object.freeze(["shield", "armor", "hull"]);
const MS_PER_S = 1000;
const MAX_DETAIL = 120;
const RECONCILE_CHUNK = 64;
const MAX_DECISIONS = 6;
const COUNTER_NAMES = Object.freeze(["checks", "started", "scans", "noTarget", "notHostile", "contested",
  "insufficientForce", "cooldown", "hits", "hitMismatch", "hitRefused", "flushFailed", "advanced", "waits", "lagWaits",
  "destroyed", "repelled", "halted", "aborted", "stale", "enqueueRefused", "reconciled", "stepLost", "gridMoves",
  "gridMoveRefused", "gridGathers", "gridApproach", "gridFallback", "gridNoAnchor",
  "scanChainJoined"]);
const SIEGE_PURPOSE = "SIEGE";
const WHY_GATHER = "GATHER";
const LOST_EVENT_STATES = Object.freeze([EVENT_STATE.DONE, EVENT_STATE.QUARANTINED]);
const STEP_LOST = "STEP_LOST";
const lostKey = (siegeId, phaseSeq, round) => `psiege:lost:${siegeId}:${phaseSeq}:${round}`;

class Rollback {
  constructor(reason) {
    this.reason = String(reason || "REFUSED");
  }
}
const NO_START_COUNTER = Object.freeze({ NOT_NULLSEC: "noTarget", ENGAGED: "contested", NO_TARGET: "noTarget",
  NOT_HOSTILE: "notHostile", BUSY: "noTarget", COOLDOWN: "cooldown", LIMIT: "noTarget", CONTESTED: "contested",
  INSUFFICIENT_FORCE: "insufficientForce" });
const END_COUNTER = Object.freeze({ DESTROYED: "destroyed", REPELLED: "repelled", HALTED: "halted",
  ABORTED: "aborted" });
const CHECK_KEYS = Object.freeze(["at", "systemId", "triggerFleetId"]);
const STEP_KEYS = Object.freeze(["phaseSeq", "round", "siegeId"]);
const SCAN_KEYS = Object.freeze(["afterSystemId", "bucket"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const keysOf = (p) => Object.keys(p).sort().join();

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parseCheckPayload(p) {
  if (!isPlain(p) || keysOf(p) !== CHECK_KEYS.join() || !isId(p.systemId) || !isTime(p.at)) return null;
  if (p.triggerFleetId !== null && (typeof p.triggerFleetId !== "string" || p.triggerFleetId === "")) return null;
  return { systemId: p.systemId, at: p.at, triggerFleetId: p.triggerFleetId };
}

function parseStepPayload(p) {
  if (!isPlain(p) || keysOf(p) !== STEP_KEYS.join()) return null;
  if (typeof p.siegeId !== "string" || p.siegeId === "" || p.siegeId.length > S.MAX_ID_LENGTH
    || !isTime(p.phaseSeq) || !isTime(p.round)) return null;
  return { siegeId: p.siegeId, phaseSeq: p.phaseSeq, round: p.round };
}

function parseScanPayload(p) {
  if (!isPlain(p) || keysOf(p) !== SCAN_KEYS.join() || !isTime(p.bucket) || !isTime(p.afterSystemId)) return null;
  return { bucket: p.bucket, afterSystemId: p.afterSystemId };
}

function familiesOf(text) {
  return [...new Set(String(text || "").split(",").map((p) => p.trim()).filter((p) => p !== ""))];
}

function createPlayerSiegeService(deps) {
  const { store, sieges, scheduler, fleetRepository, registry, seam, config, groups, clock } = deps;
  const C = config.playerSiege;
  const SG = config.siege || {};
  const gridEnabled = SG.gridEnabled === true;
  const gridMaxMovers = Number.isSafeInteger(SG.gridMaxMovers) && SG.gridMaxMovers > 0 ? SG.gridMaxMovers : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const families = familiesOf(C.targetFamilies);
  const hunt = config.playerHunt || {};
  const thresholds = huntThresholds(hunt);
  const neutralPolicy = parseNeutralPolicy(hunt.neutralPolicy) || {};
  const params = Object.freeze({ targetFamilies: families, structureCooldownMs: C.structureCooldownMs,
    maxOpen: C.maxOpen, maxOpenPerFaction: C.maxOpenPerFaction, maxOpenPerOwner: C.maxOpenPerOwner,
    assaultMinMs: C.assaultMinMs, assaultMaxMs: C.assaultMaxMs });

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "ready";
  let lastRefusal = null;
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
    metric("count", `stations.playerSiege.${name}`, n);
  }

  function setOpen(n) {
    openCount = Math.max(0, n);
    metric("gauge", "stations.playerSiege.open", openCount);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state === "stopped";
  const isHostileFaction = (a, b) => isId(a) && isId(b) && a !== b && call(() => deps.hostility(a, b) === true, false);
  const isActive = (f) => call(() => registry.isActive(f) === true, false);
  const kindOf = (f) => call(() => {
    const entry = registry.getFaction(f);
    return entry && typeof entry.kind === "string" && entry.kind !== "" ? entry.kind : null;
  }, null);

  function graphNow() {
    const r = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    return r && r.ok === true && r.graph ? r.graph : null;
  }

  function secClassOf(graph, systemId) {
    const sys = graph && typeof graph.getSystem === "function" ? call(() => graph.getSystem(systemId), null) : null;
    return sys ? sys.secClass : null;
  }

  function virtualOf(corpId, unknownAs) {
    const vc = typeof deps.getVirtualCorps === "function" ? call(deps.getVirtualCorps, null) : null;
    if (!vc || typeof vc.isVirtualCorporation !== "function") return unknownAs;
    return call(() => vc.isVirtualCorporation(corpId) === true, unknownAs);
  }

  function seamCall(name, ...args) {
    if (!seam || typeof seam[name] !== "function") return { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE" };
    return call(() => seam[name](...args) || { ok: false, reason: "SEAM_ERROR" },
      { ok: false, reason: "SEAM_ERROR" });
  }

  function candidates() {
    return seamCall("listCandidates", { nowMs: call(() => clock.now(), 0), ttlMs: C.indexTtlMs, families,
      maxStructures: C.maxIndexStructures });
  }

  function getMode() {
    if (stopped()) return "off";
    return graphNow() ? "ready" : "pending";
  }

  function readFleets(tx, systemId) {
    const listed = fleetRepository.listFleetsInSystem(tx, systemId, { states: [...READ_FLEET_STATES],
      limit: C.maxFleetsReadPerCheck + 1 });
    if (!listed || !listed.ok) return listed || { ok: false, reason: "FLEETS_READ_FAILED" };
    const truncated = listed.fleets.length > C.maxFleetsReadPerCheck || listed.nextAfterFleetId !== null;
    return { ok: true, fleets: listed.fleets.slice(0, C.maxFleetsReadPerCheck), truncated };
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

  function gridOn() {
    if (!gridEnabled || !deps.grid) return false;
    return call(() => deps.grid.isEnabled() === true && deps.grid.movesEnabled() === true, false);
  }

  function positionsIn(tx, systemId, fleets, at) {
    if (!gridEnabled) return { positions: null, fallback: false };
    if (!gridOn()) return { positions: null, fallback: true };
    const pos = deps.grid.positionsOf(tx, systemId, fleets, at);
    if (!pos || pos.ok !== true || pos.anchorsReason !== null || !(pos.positions instanceof Map)) {
      return { positions: null, fallback: true };
    }
    return { positions: pos.positions, fallback: false };
  }

  function scopeOf(systemId, positions, structureIds) {
    const sg = call(() => deps.grid.readSystemGrid(systemId), null);
    if (!sg || sg.ok !== true) return null;
    return gridScopeOf({ positions, grids: sg.grids, targets: structureIds.map((id) => ({ targetId: id,
      ref: targetRefOf({ kind: "player", structureId: id }) })) });
  }

  function siegeMovesInTx(tx, scope, fleets, attackerFactionId, structureId, systemId, at) {
    const out = { moved: 0, refused: 0, arriveMax: null, refusal: null };
    const tg = scope.targetGridOf.get(structureId);
    const to = scope.anchorOf.get(structureId);
    if (typeof tg !== "string" || !to) return out;
    for (const m of gridMoversOf(fleets, attackerFactionId, scope.gridOfFleet, tg, gridMaxMovers)) {
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

  function onArrival(tx, arrival) {
    try {
      if (stopped() || !arrival) return;
      if (!HOLD_STATES.includes(arrival.state) || !SIEGE_ROLES.includes(arrival.fleetRole)) return;
      if (secClassOf(graphNow(), arrival.systemId) !== NULLSEC) return;
      const index = candidates();
      if (!index.ok || !(index.bySystem instanceof Map) || !index.bySystem.has(arrival.systemId)) return;
      const r = enqueueCheck(tx, arrival.systemId, arrival.at,
        S.arrivalCheckKey(arrival.systemId, arrival.fleetId, arrival.legSeq), arrival.fleetId);
      if (!r.ok) bump("enqueueRefused");
    } catch (_err) {
      bump("enqueueRefused");
    }
  }

  const bucketOf = (t) => Math.floor(t / C.scanIntervalMs);

  function scanEffect(tx, systems, bucket, at) {
    let enqueued = 0;
    for (const systemId of systems) {
      const listed = fleetRepository.listFleetsInSystem(tx, systemId, { states: [...HOLD_STATES],
        limit: C.maxFleetsReadPerCheck });
      if (!listed || !listed.ok) return listed || { ok: false, reason: "FLEETS_READ_FAILED" };
      if (!listed.fleets.some((f) => SIEGE_ROLES.includes(f.fleetRole))) continue;
      const e = enqueueCheck(tx, systemId, at, S.scanCheckKey(systemId, bucket), null);
      if (!e.ok) return e;
      enqueued += 1;
    }
    return { ok: true, enqueued };
  }

  function onScan(ev, hctx) {
    try {
      const p = parseScanPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "PLAYER_SIEGE_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_STOPPED" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const index = candidates();
      const all = index.ok && index.bySystem instanceof Map ? [...index.bySystem.keys()]
        .filter((id) => secClassOf(graph, id) === NULLSEC).sort((a, b) => a - b) : [];
      const after = all.filter((id) => id > p.afterSystemId);
      const systems = after.slice(0, C.maxSystemsPerScan);
      const nextAfter = after.length > systems.length ? systems[systems.length - 1] : 0;
      const next = Math.max(p.bucket, bucketOf(at)) + 1;
      if (!index.ok) lastRefusal = String(index.reason || "INDEX_FAILED");
      return { ok: true, outcome: index.ok ? "SCAN" : "NO_INDEX",
        effect: (tx) => scanEffect(tx, systems, p.bucket, at),
        reschedule: { eventType: S.SCAN_EVENT_TYPE, aggregateId: S.SCAN_AGGREGATE_ID, dueAt: next * C.scanIntervalMs,
          payload: { bucket: next, afterSystemId: nextAfter }, idempotencyKey: S.scanKey(next) },
        onCommitted: () => bump("scans") };
    } catch (err) {
      return { ok: false, reason: `PLAYER_SIEGE_SCAN_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_UNAVAILABLE" };
      const bucket = bucketOf(clock.now()) + 1;
      const t = store.transaction("psiege.bootstrap", (db) => {
        const live = scheduler.findLiveOfType(S.SCAN_EVENT_TYPE, { tx: db });
        if (!live || live.ok !== true) return live || { ok: false, reason: "FIND_LIVE_FAILED" };
        if (live.found) return { ok: true, joined: true };
        return scheduler.enqueue(S.SCAN_EVENT_TYPE, S.SCAN_AGGREGATE_ID, bucket * C.scanIntervalMs,
          { bucket, afterSystemId: 0 }, S.scanKey(bucket), { tx: db });
      });
      if (!t || !t.ok) return { ok: false, reason: (t && t.reason) || "TX_FAILED" };
      const r = t.value;
      if (r && r.ok === true && r.joined === true) {
        bump("scanChainJoined");
        return { ok: true, duplicate: true, joined: true, bucket };
      }
      if (r && r.ok === false && r.reason === "IDEMPOTENCY_CONFLICT") return { ok: true, duplicate: true, bucket };
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, duplicate: r.duplicate === true, bucket };
    } catch (err) {
      return { ok: false, reason: `PLAYER_SIEGE_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function readCheck(tx, p, summaries) {
    const fl = readFleets(tx, p.systemId);
    if (!fl.ok) return fl;
    const total = sieges.countOpen(tx);
    if (!total.ok) return total;
    const open = sieges.listOpenInSystem(tx, p.systemId);
    if (!open.ok) return open;
    const openByFaction = new Map();
    for (const f of siegeFactionsOf(fl.fleets)) {
      const c = sieges.countOpen(tx, { attackerFactionId: f });
      if (!c.ok) return c;
      openByFaction.set(f, c.count);
    }
    const openByOwner = new Map();
    const lastByStructure = new Map();
    for (const s of summaries) {
      if (!openByOwner.has(s.ownerCorpId)) {
        const c = sieges.countOpen(tx, { ownerCorpId: s.ownerCorpId });
        if (!c.ok) return c;
        openByOwner.set(s.ownerCorpId, c.count);
      }
      const last = sieges.getLastByStructure(tx, s.structureId);
      if (!last.ok) return last;
      if (last.siege) lastByStructure.set(s.structureId, { open: last.siege.open, endedAt: last.siege.endedAt });
    }
    const pos = positionsIn(tx, p.systemId, fl.fleets, p.at);
    return { ok: true, fleets: fl.fleets, truncated: fl.truncated, openTotal: total.count, openByFaction, openByOwner,
      lastByStructure, openStructureIds: new Set(open.sieges.map((s) => s.structureId)), positions: pos.positions,
      gridFallback: pos.fallback };
  }

  function relationsOf(views, factions) {
    const faces = new Map();
    const out = new Map();
    let reads = 0;
    for (const v of views) {
      if (!faces.has(v.ownerCorpId)) {
        const face = seamCall("readOwnerFace", v.ownerCorpId);
        faces.set(v.ownerCorpId, face.ok === true && face.npc !== true && isId(face.ceoId) ? face.ceoId : null);
      }
      const ceoId = faces.get(v.ownerCorpId);
      for (const f of factions) {
        const key = `${v.structureId}:${f}`;
        if (ceoId === null || !isActive(f) || reads >= C.maxStandingReadsPerCheck) {
          out.set(key, null);
          continue;
        }
        reads += 1;
        const r = typeof deps.readStanding === "function" ? call(() => deps.readStanding(ceoId, f), null) : null;
        const standing = r && r.ok === true && typeof r.standing === "number" ? r.standing : null;
        out.set(key, standing === null ? null : relationOf(standing, kindOf(f), thresholds, neutralPolicy));
      }
    }
    return out;
  }

  function startEffect(tx, p, start, view, grid) {
    const open = sieges.getOpenByStructure(tx, view.structureId);
    if (!open.ok) return open;
    if (open.siege) return { ok: true, started: false, reason: "BUSY" };
    const total = sieges.countOpen(tx);
    if (!total.ok) return total;
    const byFaction = sieges.countOpen(tx, { attackerFactionId: start.attackerFactionId });
    if (!byFaction.ok) return byFaction;
    const byOwner = sieges.countOpen(tx, { ownerCorpId: view.ownerCorpId });
    if (!byOwner.ok) return byOwner;
    if (total.count >= C.maxOpen || byFaction.count >= C.maxOpenPerFaction || byOwner.count >= C.maxOpenPerOwner) {
      return { ok: true, started: false, reason: "LIMIT" };
    }
    const no = sieges.nextSiegeNo(tx, view.structureId);
    if (!no.ok) return no;
    const m = grid && grid.scope ? siegeMovesInTx(tx, grid.scope, grid.fleets, start.attackerFactionId,
      view.structureId, p.systemId, p.at) : null;
    const phaseEndsAt = m && m.arriveMax !== null ? Math.max(start.phaseEndsAt, m.arriveMax) : start.phaseEndsAt;
    const startKey = S.startKey(view.structureId, no.siegeNo);
    const created = sieges.createSiege(tx, { structureId: view.structureId, siegeNo: no.siegeNo,
      systemId: p.systemId, structureTypeId: view.typeId, structureFamily: view.family,
      ownerCorpId: view.ownerCorpId, ownerAllianceId: isId(view.allianceId) ? view.allianceId : null,
      attackerFactionId: start.attackerFactionId, state: S.SHIELD_ASSAULT, phaseEndsAt,
      vendorState: view.state, vendorEndsAt: isTime(view.stateEndsAt) ? view.stateEndsAt : null,
      attackerShips: start.attackerShips, attackerStrength: start.attackerStrength, at: p.at }, startKey);
    if (!created.ok) return created;
    if (created.duplicate) {
      if (m && m.moved > 0) return { ok: false, reason: "NESTED_KEY_REUSED", detail: startKey };
      return { ok: true, started: false, reason: "DUPLICATE" };
    }
    if (C.pruneBatch > 0) {
      const pruned = sieges.pruneEnded(tx, { before: Math.max(0, p.at - C.retentionMs), limit: C.pruneBatch });
      if (!pruned.ok) return pruned;
    }
    const e = enqueueStep(tx, created.siegeId, 0, 0, phaseEndsAt);
    if (!e.ok) return e;
    const out = { ok: true, started: true, siegeId: created.siegeId, structureId: view.structureId,
      systemId: p.systemId, attackerFactionId: start.attackerFactionId, ownerCorpId: view.ownerCorpId };
    if (m) Object.assign(out, { gridMoves: m.moved, gridMoveRefused: m.refused, gridMoveRefusal: m.refusal });
    return out;
  }

  function onCheck(ev) {
    try {
      const p = parseCheckPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "PLAYER_SIEGE_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_STOPPED" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      const noStart = (reason, gridNote) => ({ ok: true, outcome: reason, onCommitted: () => {
        bump("checks");
        bump(NO_START_COUNTER[reason] || "noTarget");
        bumpGrid(gridNote);
      } });
      if (secClassOf(graph, p.systemId) !== NULLSEC) return noStart("NOT_NULLSEC");
      const index = candidates();
      if (!index.ok) return { ok: false, reason: String(index.reason || "INDEX_FAILED") };
      const summaries = (index.bySystem.get(p.systemId) || []).slice(0, C.maxStructuresPerCheck);
      if (summaries.length === 0) return noStart("NO_TARGET");
      const tx = store.transaction("psiege.checkRead", (db) => readCheck(db, p, summaries));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "PLAYER_SIEGE_READ_FAILED" };
      const views = [];
      for (const s of summaries) {
        const r = seamCall("readStructure", s.structureId);
        if (!r.ok || !r.view || r.view.systemId !== p.systemId) continue;
        views.push(Object.freeze({ ...r.view, virtualOwner: virtualOf(r.view.ownerCorpId, true) }));
      }
      const targets = views.filter((v) => targetOf(v, params));
      const relations = relationsOf(targets, siegeFactionsOf(read.fleets));
      const scope = read.positions ? scopeOf(p.systemId, read.positions, targets.map((v) => v.structureId)) : null;
      const gridNote = { gridFallback: read.gridFallback === true || (read.positions !== null && scope === null),
        gridNoAnchor: scope !== null && targets.some((v) => scope.targetGridOf.get(v.structureId) === null) };
      const plan = planPlayerStart({ system: { systemId: p.systemId, secClass: NULLSEC }, structures: targets,
        fleets: read.fleets, truncated: read.truncated, openStructureIds: read.openStructureIds,
        openTotal: read.openTotal, openByFaction: read.openByFaction, openByOwner: read.openByOwner,
        lastByStructure: read.lastByStructure, triggerFleetId: p.triggerFleetId, at: p.at,
        relation: (f, v) => relations.get(`${v.structureId}:${f}`) || null, isActive, isHostileFaction, groups,
        params, ...(scope ? { grid: { gridOfFleet: scope.gridOfFleet, targetGridOf: scope.targetGridOf } } : {}) });
      const grid = scope ? { scope, fleets: read.fleets } : null;
      if (!plan.start && plan.approach && grid) {
        const a = plan.approach;
        return { ok: true, outcome: "APPROACH", effect: (etx) => {
          const m = siegeMovesInTx(etx, scope, read.fleets, a.attackerFactionId, a.structureId, p.systemId, p.at);
          return { ok: true, approach: true, gridMoves: m.moved, gridMoveRefused: m.refused,
            gridMoveRefusal: m.refusal };
        }, onCommitted: (v) => {
          bump("checks");
          bump("gridApproach");
          bumpGrid({ ...gridNote, ...v });
        } };
      }
      if (!plan.start) return noStart(plan.reason, gridNote);
      const view = targets.find((v) => v.structureId === plan.start.structureId);
      return { ok: true, outcome: "START", effect: (etx) => startEffect(etx, p, plan.start, view, grid),
        onCommitted: (v) => {
          bump("checks");
          bumpGrid({ ...gridNote, ...(v || {}) });
          if (!v || v.started !== true) {
            bump("stale");
            return;
          }
          bump("started");
          setOpen(openCount + 1);
          log(`playerSiege: ${v.siegeId} SHIELD_ASSAULT structure=${v.structureId} system=${v.systemId} attacker=`
            + `${v.attackerFactionId} owner=${v.ownerCorpId}`);
        } };
    } catch (err) {
      return { ok: false, reason: `PLAYER_SIEGE_CHECK_FAILED: ${messageOf(err)}` };
    }
  }

  function readStep(tx, p, at) {
    const g = sieges.getSiege(tx, p.siegeId);
    if (!g.ok) return g;
    const siege = g.siege;
    if (!siege || siege.open !== true || siege.phaseSeq !== p.phaseSeq || siege.waitRound !== p.round) {
      return { ok: true, siege: null };
    }
    const fl = readFleets(tx, siege.systemId);
    if (!fl.ok) return fl;
    const pos = positionsIn(tx, siege.systemId, fl.fleets, at);
    const scope = pos.positions ? scopeOf(siege.systemId, pos.positions, [siege.structureId]) : null;
    const tg = scope ? scope.targetGridOf.get(siege.structureId) : null;
    const gridded = typeof tg === "string";
    const hold = gridded ? gridHoldOf(fl.fleets, siege.attackerFactionId, isHostileFaction, groups,
      scope.gridOfFleet, tg, { attackersAnywhere: false }) : holdOf(fl.fleets, siege.attackerFactionId,
      isHostileFaction, groups);
    if (fl.truncated) hold.contested = true;
    const grid = gridEnabled ? { scope: gridded ? scope : null, fleets: fl.fleets,
      gridFallback: pos.fallback || (pos.positions !== null && scope === null), gridNoAnchor: scope !== null
        && !gridded, gridAway: gridded ? hold.awayShips : null } : null;
    return { ok: true, siege, hold, grid };
  }

  function viewOf(structureId) {
    const r = seamCall("readStructure", structureId);
    if (r.ok) return { ok: true, view: r.view || null };
    if (r.reason === "NOT_FOUND") return { ok: true, view: null };
    return r;
  }

  function decide(siege, hold, p, at, grid) {
    const read = viewOf(siege.structureId);
    if (!read.ok) return read;
    let view = read.view;
    const facts = { at, phaseSeq: p.phaseSeq, round: p.round, maxWaitRounds: C.maxWaitRounds, recheckMs: C.recheckMs,
      lagRecheckMs: C.lagRecheckMs, maxLagRounds: C.maxLagRounds, timerExitDelayMs: C.timerExitDelayMs,
      hitMarginMs: C.hitMarginMs, assaultMinMs: C.assaultMinMs, assaultMaxMs: C.assaultMaxMs,
      destroyEnabled: C.destroyEnabled === true, ownerActive: null, ownerUnknown: false,
      virtualOwner: view ? virtualOf(view.ownerCorpId, false) : false };
    if (grid && grid.scope) facts.gridAway = grid.gridAway;
    let hits = 0;
    let mismatched = false;
    for (let i = 0; i < MAX_DECISIONS; i += 1) {
      const d = decidePlayerStep(siege, view, hold, facts);
      if (d.action === "NEED_OWNER") {
        if (facts.ownerActive !== null) {
          return { ok: true, d: { action: "END", to: S.HALTED,
            reason: facts.ownerUnknown === true ? "OWNER_UNKNOWN" : "OWNER_OFFLINE" }, view, hits };
        }
        const a = seamCall("readOwnerActivity", siege.ownerCorpId, { maxMembers: C.maxMembersRead });
        facts.ownerUnknown = a.ok !== true;
        facts.ownerActive = a.ok === true && (a.onlineNow === true
          || (isTime(a.lastSeenMs) && at - a.lastSeenMs <= C.ownerOnlineWindowMs));
        continue;
      }
      if (d.action !== "HIT") return { ok: true, d, view, hits };
      if (hits > 0) return { ok: true, d: { action: "END", to: S.ABORTED, reason: "HIT_NO_EFFECT" }, view, hits };
      const h = seamCall("applySiegeHit", siege.structureId, d.layer);
      if (h.ok) {
        hits += 1;
        bump("hits");
        if (h.flushed !== true) bump("flushFailed");
        const again = h.view ? { ok: true, view: h.view } : viewOf(siege.structureId);
        if (!again.ok) return again;
        view = again.view;
        continue;
      }
      if (h.reason === "STATE_MISMATCH" && !mismatched) {
        mismatched = true;
        bump("hitMismatch");
        const again = viewOf(siege.structureId);
        if (!again.ok) return again;
        view = again.view;
        continue;
      }
      bump("hitRefused");
      return { ok: true, d: { action: "END", to: S.ABORTED, reason: "VENDOR_REFUSED" }, view, hits };
    }
    return { ok: true, d: { action: "END", to: S.ABORTED, reason: "VENDOR_REFUSED" }, view, hits };
  }

  function stepEffect(tx, ev, p, siegeSeen, hold, out, grid) {
    const k = ev.idempotencyKey;
    const at = ev.dueAt;
    const g = sieges.getSiege(tx, p.siegeId);
    if (!g.ok) return g;
    const siege = g.siege;
    if (!siege || siege.open !== true || siege.phaseSeq !== p.phaseSeq || siege.waitRound !== p.round
      || siege.version !== siegeSeen.version) {
      return { ok: true, stale: true, action: "STALE" };
    }
    const d = out.d;
    const view = out.view;
    const hits = Math.min(Number.MAX_SAFE_INTEGER, siege.hits + out.hits);
    const base = { ok: true, stale: false, action: d.action, siegeId: siege.siegeId, systemId: siege.systemId,
      structureId: siege.structureId, attackerFactionId: siege.attackerFactionId, ownerCorpId: siege.ownerCorpId };
    if (grid) Object.assign(base, { gridFallback: grid.gridFallback, gridNoAnchor: grid.gridNoAnchor });
    const regroup = () => {
      if (!grid || !grid.scope) return;
      const m = siegeMovesInTx(tx, grid.scope, grid.fleets, siege.attackerFactionId, siege.structureId,
        siege.systemId, at);
      Object.assign(base, { gridMoves: m.moved, gridMoveRefused: m.refused, gridMoveRefusal: m.refusal });
    };
    if (d.action === "WAIT") {
      const w = sieges.noteWait(tx, { siege, waitRound: d.round, dueAt: d.dueAt, why: d.why, at }, `${k}:siege`);
      if (!w.ok) return w;
      if (w.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:siege` };
      regroup();
      const e = enqueueStep(tx, siege.siegeId, siege.phaseSeq, d.round, d.dueAt);
      return e.ok ? { ...base, why: d.why } : e;
    }
    const vendor = { vendorState: view ? view.state : null,
      vendorEndsAt: view && isTime(view.stateEndsAt) ? view.stateEndsAt : null };
    if (d.action === "ADVANCE") {
      const t = sieges.transition(tx, { siege, to: d.to, at, patch: { phaseSeq: siege.phaseSeq + 1, waitRound: 0,
        phaseStartedAt: at, phaseEndsAt: d.phaseEndsAt, vendorState: d.vendorState, vendorEndsAt: d.vendorEndsAt,
        attackerShips: hold.attackerShips, attackerStrength: Math.max(0, Math.round(hold.attackerStrength)), hits } },
      `${k}:siege`);
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:siege` };
      regroup();
      const e = enqueueStep(tx, siege.siegeId, siege.phaseSeq + 1, 0, d.phaseEndsAt);
      return e.ok ? { ...base, to: d.to } : e;
    }
    if (d.action === "END") {
      const t = sieges.transition(tx, { siege, to: d.to, at, patch: { phaseSeq: siege.phaseSeq + 1, endedAt: at,
        endReason: d.reason, hits, ...vendor } }, `${k}:siege`);
      if (!t.ok) return t;
      if (t.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:siege` };
      const c = enqueueCheck(tx, siege.systemId, at, S.endCheckKey(siege.systemId, siege.siegeId), null);
      return c.ok ? { ...base, to: d.to, reason: d.reason } : c;
    }
    return { ok: false, reason: "UNKNOWN_ACTION", permanent: true };
  }

  function onStepCommitted(v) {
    if (!v || v.ok !== true) return;
    if (v.stale === true) {
      bump("stale");
      return;
    }
    bumpGrid(v);
    if (v.action === "WAIT") {
      bump("waits");
      if (v.why === "LAG") bump("lagWaits");
      if (v.why === "CONTESTED") bump("contested");
      if (v.why === WHY_GATHER) bump("gridGathers");
      return;
    }
    if (v.action === "ADVANCE") {
      bump("advanced");
      return;
    }
    if (v.action !== "END") return;
    bump(END_COUNTER[v.to]);
    setOpen(openCount - 1);
    log(`playerSiege: ${v.siegeId} ${v.to} ${v.reason} structure=${v.structureId} system=${v.systemId} attacker=`
      + `${v.attackerFactionId} owner=${v.ownerCorpId}`);
  }

  function onStep(ev) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "PLAYER_SIEGE_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_STOPPED" };
      const tx = store.transaction("psiege.stepRead", (db) => readStep(db, p, ev.dueAt));
      if (!tx.ok) return { ok: false, reason: tx.reason || "TX_FAILED" };
      const read = tx.value;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "PLAYER_SIEGE_READ_FAILED" };
      if (!read.siege) return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      const at = ev.dueAt;
      const out = decide(read.siege, read.hold, p, at, read.grid);
      if (!out.ok) {
        lastRefusal = String(out.reason || "SEAM_ERROR");
        return { ok: false, reason: lastRefusal, deferUntil: call(() => clock.now(), at) + C.recheckMs };
      }
      if (out.d.action === "STALE") return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      return { ok: true, outcome: out.d.action, effect: (etx, event) => {
        const r = stepEffect(etx, event, p, read.siege, read.hold, out, read.grid);
        if (!r || r.ok !== true) lastRefusal = String((r && r.reason) || "STEP_FAILED");
        return r;
      }, onCommitted: onStepCommitted };
    } catch (err) {
      return { ok: false, reason: `PLAYER_SIEGE_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function listOpenFor(tx, opts) {
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : C.maxOpen;
    return sieges.listOpen(tx, { limit });
  }

  const attackingOf = (list, factionId) => list.filter((s) => s.attackerFactionId === factionId)
    .map((s) => ({ siegeId: s.siegeId, systemId: s.systemId, structureId: s.structureId, state: s.state,
      phaseEndsAt: s.phaseEndsAt }));

  function readForFaction(tx, factionId, opts) {
    if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
    const l = listOpenFor(tx, opts);
    if (!l || !l.ok) return l || { ok: false, reason: "PLAYER_SIEGE_READ_FAILED" };
    return { ok: true, attacking: attackingOf(l.sieges, factionId), truncated: l.truncated === true };
  }

  function readForFactions(tx, factionIds, opts) {
    if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!Array.isArray(factionIds) || !factionIds.every(isId)) return { ok: false, reason: "INVALID_INPUT" };
    const l = listOpenFor(tx, opts);
    if (!l || !l.ok) return l || { ok: false, reason: "PLAYER_SIEGE_READ_FAILED" };
    const byFaction = new Map(factionIds.map((f) => [f, { attacking: attackingOf(l.sieges, f) }]));
    return { ok: true, byFaction, truncated: l.truncated === true };
  }

  function requiredDpsOf(view) {
    let need = 0;
    for (const l of LAYERS) {
      const ehp = Number(view.ehp && view.ehp[l]);
      const limit = Number(view.damageLimit && view.damageLimit[l]);
      if (!Number.isFinite(ehp) || ehp < 0) return null;
      const layerNeed = Math.ceil((MS_PER_S * ehp) / C.assaultMaxMs);
      if (Number.isFinite(limit) && limit > 0 && limit < layerNeed) return null;
      need = Math.max(need, layerNeed);
    }
    return Math.max(1, need);
  }

  function readTargetsForFaction(tx, factionId, opts) {
    if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
    if (opts && opts.systems != null && !(opts.systems instanceof Set) && !Array.isArray(opts.systems)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit >= 0 ? opts.limit : C.maxOpen;
    const at = opts && isTime(opts.at) ? opts.at : call(() => clock.now(), 0);
    const none = { ok: true, targets: [], truncated: false };
    if (limit === 0 || !isActive(factionId)) return none;
    const graph = graphNow();
    if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
    const total = sieges.countOpen(tx);
    if (!total.ok) return total;
    const mine = sieges.countOpen(tx, { attackerFactionId: factionId });
    if (!mine.ok) return mine;
    if (total.count >= C.maxOpen || mine.count >= C.maxOpenPerFaction) return none;
    const index = candidates();
    if (!index.ok) return { ok: false, reason: String(index.reason || "INDEX_FAILED") };
    const reach = opts && opts.systems instanceof Set ? opts.systems
      : opts && Array.isArray(opts.systems) ? new Set(opts.systems) : null;
    const systems = [...index.bySystem.keys()].filter((id) => (reach === null || reach.has(id))
      && secClassOf(graph, id) === NULLSEC).sort((a, b) => a - b);
    const kind = kindOf(factionId);
    const faces = new Map();
    const relations = new Map();
    const byOwner = new Map();
    const targets = [];
    let views = 0;
    let reads = 0;
    let truncated = index.truncated === true;
    const hostileTo = (ownerCorpId) => {
      if (relations.has(ownerCorpId)) return relations.get(ownerCorpId);
      if (!faces.has(ownerCorpId)) {
        const face = seamCall("readOwnerFace", ownerCorpId);
        faces.set(ownerCorpId, face.ok === true && face.npc !== true && isId(face.ceoId) ? face.ceoId : null);
      }
      const ceoId = faces.get(ownerCorpId);
      if (ceoId === null || reads >= C.maxStandingReadsPerCheck) return false;
      reads += 1;
      const r = typeof deps.readStanding === "function" ? call(() => deps.readStanding(ceoId, factionId), null) : null;
      const standing = r && r.ok === true && typeof r.standing === "number" ? r.standing : null;
      const hostile = standing !== null && relationOf(standing, kind, thresholds, neutralPolicy) === "hostile";
      relations.set(ownerCorpId, hostile);
      return hostile;
    };
    for (const systemId of systems) {
      for (const s of [...index.bySystem.get(systemId)].sort((a, b) => a.structureId - b.structureId)) {
        if (targets.length >= limit || views >= C.maxStructuresPerCheck) {
          truncated = true;
          break;
        }
        const last = sieges.getLastByStructure(tx, s.structureId);
        if (!last.ok) return last;
        if (last.siege && (last.siege.open === true || (isTime(last.siege.endedAt)
          && last.siege.endedAt + C.structureCooldownMs > at))) continue;
        if (!byOwner.has(s.ownerCorpId)) {
          const c = sieges.countOpen(tx, { ownerCorpId: s.ownerCorpId });
          if (!c.ok) return c;
          byOwner.set(s.ownerCorpId, c.count);
        }
        if (byOwner.get(s.ownerCorpId) >= C.maxOpenPerOwner) continue;
        views += 1;
        const r = seamCall("readStructure", s.structureId);
        if (!r.ok || !r.view || r.view.systemId !== systemId) continue;
        const view = { ...r.view, virtualOwner: virtualOf(r.view.ownerCorpId, true) };
        if (!targetOf(view, params) || !hostileTo(view.ownerCorpId)) continue;
        const requiredDps = requiredDpsOf(view);
        if (requiredDps === null) continue;
        targets.push({ systemId, structureId: view.structureId, ownerCorpId: view.ownerCorpId, requiredDps });
      }
      if (truncated && (targets.length >= limit || views >= C.maxStructuresPerCheck)) break;
    }
    return { ok: true, targets, truncated };
  }

  function listOpen(tx, opts) {
    if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_UNAVAILABLE", detail: "stopped" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    return listOpenFor(tx, opts);
  }

  function lostEffect(tx, seen, at) {
    const g = sieges.getSiege(tx, seen.siegeId);
    if (!g.ok) throw new Rollback(g.reason);
    const siege = g.siege;
    if (!siege || siege.open !== true || siege.phaseSeq !== seen.phaseSeq || siege.waitRound !== seen.waitRound
      || siege.version !== seen.version) {
      return { ok: true, stale: true };
    }
    const t = sieges.transition(tx, { siege, to: S.ABORTED, at, patch: { phaseSeq: siege.phaseSeq + 1, endedAt: at,
      endReason: STEP_LOST } }, lostKey(siege.siegeId, siege.phaseSeq, siege.waitRound));
    if (!t.ok) throw new Rollback(t.reason || "TRANSITION_FAILED");
    if (t.duplicate) return { ok: true, stale: true };
    const c = enqueueCheck(tx, siege.systemId, at, S.endCheckKey(siege.systemId, siege.siegeId), null);
    if (!c.ok) throw new Rollback(c.reason);
    return { ok: true, stale: false, siege };
  }

  function closeLost(list) {
    let closed = 0;
    for (const s of list) {
      const found = scheduler.findByKey(S.stepKey(s.siegeId, s.phaseSeq, s.waitRound));
      if (!found || found.ok !== true || found.found !== true || !LOST_EVENT_STATES.includes(found.event.state)) {
        continue;
      }
      const at = call(() => clock.now(), s.phaseEndsAt);
      const tx = store.transaction("psiege.stepLost", (db) => lostEffect(db, s, at));
      if (!tx.ok) {
        log(`playerSiege: step lost ${s.siegeId} refused ${tx.error instanceof Rollback ? tx.error.reason
          : (tx.reason || "TX_FAILED")}`);
        continue;
      }
      if (tx.value.stale === true) continue;
      closed += 1;
      bump(END_COUNTER[S.ABORTED]);
      bump("stepLost");
      setOpen(openCount - 1);
      log(`playerSiege: ${s.siegeId} ${S.ABORTED} ${STEP_LOST} event=${found.event.state} structure=${s.structureId} `
        + `system=${s.systemId} attacker=${s.attackerFactionId} owner=${s.ownerCorpId}`);
    }
    return { closed };
  }

  function reconcile() {
    try {
      if (stopped()) return { ok: false, reason: "PLAYER_SIEGE_UNAVAILABLE" };
      const read = store.transaction("psiege.reconcileRead", (db) => {
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
          log(`playerSiege: reconcile refused ${e.refusal.reason || "?"}`);
          break;
        }
      }
      bump("reconciled", enqueued);
      const lost = closeLost(r.sieges);
      return { ok: true, open: Math.max(0, r.count - lost.closed), enqueued, duplicates, lost: lost.closed };
    } catch (err) {
      return { ok: false, reason: `RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state, seq, mode: getMode(), open: openCount, counters: Object.freeze({ ...counters }),
      lastRefusal });
  }

  return Object.freeze({
    getMode,
    getStatus,
    onArrival,
    onScan,
    onCheck,
    onStep,
    bootstrap,
    reconcile,
    readForFaction,
    readForFactions,
    readTargetsForFaction,
    listOpen,
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: stopped,
  });
}

module.exports = { createPlayerSiegeService, parseCheckPayload, parseStepPayload, parseScanPayload, familiesOf,
  COUNTER_NAMES };
