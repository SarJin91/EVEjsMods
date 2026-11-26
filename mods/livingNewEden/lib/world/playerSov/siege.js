"use strict";

const S = require("./schema");
const { createPlayerSovClockRepository, CODES: CLOCK_CODES } = require("./clock");
const { createOwnerOnline } = require("./ownerOnline");
const { createRetakePump } = require("./retakePump");
const { PLAYER_OP, PLAYER_NOTES } = require("../occupation/machine");
const { relationOf, huntThresholds } = require("../../playerHunt/policy");
const { parseNeutralPolicy } = require("../../playerHunt/schema");

const AGGREGATE = "player_sov";
const EVENT = Object.freeze({ SIEGED: "PLAYER_SOV_SIEGED", REINFORCED: "PLAYER_SOV_REINFORCED",
  LIFTED: "PLAYER_SOV_LIFTED", LOST: "PLAYER_SOV_LOST" });
const OUTCOME = Object.freeze({ APPLIED: "APPLIED", DUPLICATE: "DUPLICATE", STALE: "STALE", REFUSED: "REFUSED" });
const MAX_DETAIL = 160;
const SIEGE_STATES = Object.freeze([S.SIEGED, S.REINFORCED, S.RETAKING]);
const COUNT_KEYS = Object.freeze(["siegeSampleMs", "ownerMembersMax", "siegeHoldMs", "reinforceMs", "reconcileMs",
  "retakeRetryMs", "maxRetakesPerPass"]);

const COUNTER_NAMES = Object.freeze(["attacks", "reinforced", "retakes", "lifts", "samples", "creditedMs",
  "friendlySkips", "pausedOffline", "pausedObserved", "retakeReleased", "retakeAlreadyGone", "retakeOwnerChanged",
  "retakeFailed", "retakeOwnerOffline", "opsStale", "opsDuplicate", "opsRefused", "clockPruned", "membersReadFailed",
  "membersTruncated", "presenceStale"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

const journalKeyOf = (claim) => `psovj:${claim.claimId}:${claim.createdAt}:${claim.version}`;

function journalEdgeInTx(journal, db, before, after, eventType, reinforceMs) {
  const payload = { systemId: after.systemId, claimId: after.claimId, allianceId: after.allianceId,
    corpId: after.corpId, attackerFactionId: after.attackerFactionId ?? before.attackerFactionId ?? null,
    to: after.state, endReason: after.endReason ?? null, reinforcedUntil: after.reinforcedUntil ?? null,
    reinforceMs };
  const j = journal.applyOnce(db, { key: journalKeyOf(after), aggregate: { type: AGGREGATE, id: after.claimId },
    eventType, payload }, () => ({ ok: true }));
  if (!j || j.ok !== true) return { ok: false, reason: (j && j.reason) || "JOURNAL_FAILED", technical: true };
  return { ok: true };
}

function createPlayerSovSiege(deps) {
  const { journal, clockRepo, ownerOnline } = deps;
  const C = deps.config.playerSov;
  const hunt = deps.config.playerHunt || {};
  const thresholds = huntThresholds(hunt);
  const neutralPolicy = parseNeutralPolicy(hunt.neutralPolicy) || {};
  const telemetry = deps.telemetry || null;
  const counters = deps.counters || Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const hostileMemo = new Map();
  const activityMemo = new Map();
  const params = Object.freeze({ siegeHoldMs: C.siegeHoldMs, reinforceMs: C.reinforceMs,
    siegeSampleMs: C.siegeSampleMs, pauseWhenObserved: C.pauseWhenObserved === true });
  let stopped = false;

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
    metric("count", `world.playerSov.${name}`, n);
  }

  function repository() {
    const ps = typeof deps.getPlayerSov === "function" ? call(deps.getPlayerSov, null) : null;
    const repo = ps && typeof ps.getRepository === "function" ? call(() => ps.getRepository(), null) : null;
    return repo && typeof repo.transition === "function" ? repo : null;
  }

  function observedNow(systemId) {
    const p = typeof deps.getPresence === "function" ? call(deps.getPresence, null) : null;
    if (!p || typeof p.distanceToObserved !== "function") return false;
    const d = call(() => p.distanceToObserved(systemId, 0), null);
    return d !== null && typeof d === "object" && d.ok === true && d.distance === 0;
  }

  function kindOf(factionId) {
    const registry = typeof deps.getRegistry === "function" ? call(deps.getRegistry, null) : null;
    const entry = registry && typeof registry.getFaction === "function"
      ? call(() => registry.getFaction(factionId), null) : null;
    return entry && typeof entry.kind === "string" && entry.kind !== "" ? entry.kind : null;
  }

  function hostileTo(corpId, factionId, at) {
    if (!isId(corpId) || !isId(factionId)) return false;
    const key = `${corpId}:${factionId}`;
    const hit = hostileMemo.get(key);
    if (hit && at - hit.at >= 0 && at - hit.at < C.reconcileMs) return hit.hostile;
    const adapter = deps.adapter || null;
    const seam = adapter ? call(() => adapter.playerStructures, null) : null;
    const face = seam && typeof seam.readOwnerFace === "function" ? call(() => seam.readOwnerFace(corpId), null) : null;
    const ceoId = face && face.ok === true && face.npc !== true && isId(face.ceoId) ? face.ceoId : null;
    let hostile = false;
    if (ceoId !== null && adapter && typeof adapter.readCharacterStanding === "function") {
      const r = call(() => adapter.readCharacterStanding(ceoId, factionId), null);
      const standing = r && r.ok === true && typeof r.standing === "number" ? r.standing : null;
      hostile = standing !== null && relationOf(standing, kindOf(factionId), thresholds, neutralPolicy) === "hostile";
    }
    hostileMemo.set(key, { at, hostile });
    return hostile;
  }

  function ownerSeen(corpId, at) {
    if (C.targetOwnerSeenMs === 0) return true;
    if (!isId(corpId)) return false;
    const hit = activityMemo.get(corpId);
    let a = hit && at - hit.at >= 0 && at - hit.at < C.reconcileMs ? hit.activity : undefined;
    if (a === undefined) {
      const adapter = deps.adapter || null;
      const seam = adapter ? call(() => adapter.playerStructures, null) : null;
      const r = seam && typeof seam.readOwnerActivity === "function"
        ? call(() => seam.readOwnerActivity(corpId, { maxMembers: C.ownerMembersMax }), null) : null;
      a = r && r.ok === true ? { onlineNow: r.onlineNow === true,
        lastSeenMs: Number.isSafeInteger(r.lastSeenMs) ? r.lastSeenMs : null } : null;
      activityMemo.set(corpId, { at, activity: a });
    }
    if (a === null) return false;
    return a.onlineNow || (a.lastSeenMs !== null && a.lastSeenMs >= at - C.targetOwnerSeenMs);
  }

  function listForReviewInTx(db, factionId, at) {
    try {
      if (stopped) return { ok: false, reason: "PLAYER_SOV_SIEGE_STOPPED" };
      if (!isId(factionId) || !isTime(at)) return { ok: false, reason: "PLAYER_SOV_INPUT_INVALID" };
      const repo = repository();
      if (repo === null || typeof repo.countSiegesOf !== "function") return { ok: false, reason: S.CODES.UNAVAILABLE };
      const live = repo.listLive(db);
      if (!live.ok) return live;
      const sieges = repo.countSiegesOf(db, factionId);
      if (!sieges.ok) return sieges;
      const bySystem = new Map();
      for (const c of live.claims) {
        const besieged = SIEGE_STATES.includes(c.state) && isId(c.attackerFactionId);
        bySystem.set(c.systemId, Object.freeze({ hostile: hostileTo(c.corpId, factionId, at),
          ownerSeen: ownerSeen(c.corpId, at), siegedByOther: besieged && c.attackerFactionId !== factionId,
          siegedBySelf: besieged && c.attackerFactionId === factionId }));
      }
      return { ok: true, bySystem, siegesOfFaction: sieges.count };
    } catch (err) {
      return { ok: false, reason: "PLAYER_SOV_REVIEW_READ_FAILED", detail: messageOf(err) };
    }
  }

  function readForOccupationInTx(db, systemId, at) {
    if (stopped) return { ok: true, claim: null };
    const repo = repository();
    if (repo === null) return { ok: true, claim: null };
    const r = repo.getLiveInSystem(db, systemId);
    if (!r.ok) return r;
    const c = r.claim;
    if (!c) return { ok: true, claim: null };
    let clock = null;
    if (c.state === S.SIEGED || c.state === S.REINFORCED) {
      const k = clockRepo.get(db, c.claimId);
      if (!k.ok) return k;
      if (k.clock) {
        clock = Object.freeze({ phase: k.clock.phase, phaseKey: k.clock.phaseKey, creditedMs: k.clock.creditedMs,
          lastSampleAt: k.clock.lastSampleAt, version: k.clock.version });
      }
    }
    const when = isTime(at) ? at : 0;
    const online = ownerOnline.ownerOnline(c.corpId, when);
    return { ok: true, claim: Object.freeze({ claimId: c.claimId, state: c.state, baseState: c.baseState,
      allianceId: c.allianceId, corpId: c.corpId, attackerFactionId: c.attackerFactionId,
      attackStartedAt: c.attackStartedAt, reinforcedUntil: c.reinforcedUntil, version: c.version,
      observed: observedNow(systemId), ownerOnline: Boolean(online && online.online === true), clock,
      hostileTo: (f) => hostileTo(c.corpId, f, when), params }) };
  }

  function transitionInTx(db, claim, change, eventType) {
    const repo = repository();
    if (repo === null) return { ok: false, reason: S.CODES.UNAVAILABLE };
    const t = repo.transition(db, { claim, ...change });
    if (!t.ok || eventType === null) return t;
    const j = journalEdgeInTx(journal, db, claim, t.claim, eventType, C.reinforceMs);
    return j.ok ? t : j;
  }

  const result = (op, claimId, outcome, extra) => ({ op, claimId, outcome, ...(extra || {}) });

  function edgeOutcome(op, claimId, t) {
    if (t.ok) return null;
    if (t.reason === S.CODES.VERSION_CONFLICT) return result(op, claimId, OUTCOME.STALE, { reason: t.reason });
    if (t.reason === S.CODES.TRANSITION_DENIED) return result(op, claimId, OUTCOME.REFUSED, { reason: t.reason });
    return { ok: false, reason: t.reason || "PLAYER_SOV_TRANSITION_FAILED", ...(t.detail ? { detail: t.detail } : {}) };
  }

  function startClock(db, claimId, phase, phaseKey, at) {
    const k = clockRepo.put(db, { claimId, phase, phaseKey, creditedMs: 0, sampledAt: at, expectVersion: null });
    return k.ok || k.reason === CLOCK_CODES.VERSION_CONFLICT ? { ok: true } : k;
  }

  function sampleInTx(db, c, op) {
    if (typeof op.phase !== "string" || !isId(op.phaseKey) || !isTime(op.creditedMs) || !isTime(op.sampledAt)
      || !(op.expectVersion === null || isId(op.expectVersion))) {
      return { ok: false, reason: "PLAYER_SOV_OP_INVALID", detail: op.op };
    }
    if (c.state !== op.phase || c.attackStartedAt !== op.phaseKey) return result(op.op, c.claimId, OUTCOME.STALE);
    const prev = clockRepo.get(db, c.claimId);
    if (!prev.ok) return prev;
    const before = prev.clock && prev.clock.phase === op.phase && prev.clock.phaseKey === op.phaseKey
      ? prev.clock.creditedMs : 0;
    const k = clockRepo.put(db, { claimId: c.claimId, phase: op.phase, phaseKey: op.phaseKey,
      creditedMs: op.creditedMs, sampledAt: op.sampledAt, expectVersion: op.expectVersion });
    if (!k.ok) {
      return k.reason === CLOCK_CODES.VERSION_CONFLICT ? result(op.op, c.claimId, OUTCOME.STALE, { reason: k.reason })
        : k;
    }
    return result(op.op, c.claimId, OUTCOME.APPLIED, { creditedDeltaMs: Math.max(0, op.creditedMs - before) });
  }

  function attackInTx(db, c, op, at) {
    if (!isId(op.factionId) || !isId(op.version)) return { ok: false, reason: "PLAYER_SOV_OP_INVALID", detail: op.op };
    if (c.state === S.SIEGED && c.attackerFactionId === op.factionId) {
      return result(op.op, c.claimId, OUTCOME.DUPLICATE);
    }
    if (c.version !== op.version) return result(op.op, c.claimId, OUTCOME.STALE);
    const t = transitionInTx(db, c, { to: S.SIEGED, at, attackerFactionId: op.factionId }, EVENT.SIEGED);
    const bad = edgeOutcome(op.op, c.claimId, t);
    if (bad !== null) return bad;
    const k = startClock(db, c.claimId, S.SIEGED, t.claim.attackStartedAt, at);
    return k.ok ? result(op.op, c.claimId, OUTCOME.APPLIED) : k;
  }

  function reinforceInTx(db, c, op, at) {
    if (!isId(op.version) || !isTime(op.until)) return { ok: false, reason: "PLAYER_SOV_OP_INVALID", detail: op.op };
    if (c.state === S.REINFORCED) return result(op.op, c.claimId, OUTCOME.DUPLICATE);
    if (c.version !== op.version) return result(op.op, c.claimId, OUTCOME.STALE);
    const t = transitionInTx(db, c, { to: S.REINFORCED, at, reinforcedUntil: op.until }, EVENT.REINFORCED);
    const bad = edgeOutcome(op.op, c.claimId, t);
    if (bad !== null) return bad;
    const k = startClock(db, c.claimId, S.REINFORCED, t.claim.attackStartedAt, at);
    return k.ok ? result(op.op, c.claimId, OUTCOME.APPLIED) : k;
  }

  function endStageInTx(db, c, op, at) {
    const retake = op.op === PLAYER_OP.RETAKE;
    if (!isId(op.version) || (retake && !isId(op.factionId))) {
      return { ok: false, reason: "PLAYER_SOV_OP_INVALID", detail: op.op };
    }
    if (retake ? c.state === S.RETAKING : (c.state !== S.SIEGED && c.state !== S.REINFORCED)) {
      return result(op.op, c.claimId, OUTCOME.DUPLICATE);
    }
    if (c.version !== op.version) return result(op.op, c.claimId, OUTCOME.STALE);
    const t = transitionInTx(db, c, { to: retake ? S.RETAKING : c.baseState, at }, retake ? null : EVENT.LIFTED);
    const bad = edgeOutcome(op.op, c.claimId, t);
    if (bad !== null) return bad;
    const rm = clockRepo.remove(db, c.claimId);
    return rm.ok ? result(op.op, c.claimId, OUTCOME.APPLIED) : rm;
  }

  function applyOpsInTx(db, spec, keyBase) {
    try {
      if (stopped) return { ok: false, reason: "PLAYER_SOV_SIEGE_STOPPED" };
      if (!db || db.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!isPlain(spec) || !isId(spec.systemId) || !Array.isArray(spec.ops) || !isTime(spec.at)
        || typeof keyBase !== "string" || keyBase === "") {
        return { ok: false, reason: "PLAYER_SOV_INPUT_INVALID" };
      }
      const repo = repository();
      if (repo === null) return { ok: false, reason: S.CODES.UNAVAILABLE };
      const results = [];
      for (const op of spec.ops) {
        if (!isPlain(op) || typeof op.claimId !== "string") return { ok: false, reason: "PLAYER_SOV_OP_INVALID" };
        const got = repo.getById(db, op.claimId);
        if (!got.ok) return got;
        const c = got.claim;
        let r;
        if (!c || c.systemId !== spec.systemId || c.state === S.LOST) r = result(op.op, op.claimId, OUTCOME.STALE);
        else if (op.op === PLAYER_OP.SAMPLE) r = sampleInTx(db, c, op);
        else if (op.op === PLAYER_OP.ATTACK) r = attackInTx(db, c, op, spec.at);
        else if (op.op === PLAYER_OP.REINFORCE) r = reinforceInTx(db, c, op, spec.at);
        else if (op.op === PLAYER_OP.RETAKE || op.op === PLAYER_OP.LIFT) r = endStageInTx(db, c, op, spec.at);
        else return { ok: false, reason: "PLAYER_SOV_OP_INVALID", detail: String(op.op) };
        if (r.ok === false) return r;
        results.push(r);
      }
      return { ok: true, results };
    } catch (err) {
      return { ok: false, reason: "PLAYER_SOV_APPLY_FAILED", detail: messageOf(err) };
    }
  }

  function noteCommitted(results, notes) {
    const list = Array.isArray(notes) ? notes : [];
    if (list.includes(PLAYER_NOTES.FRIENDLY)) bump("friendlySkips");
    if (list.includes(PLAYER_NOTES.PAUSED_OFFLINE)) bump("pausedOffline");
    if (list.includes(PLAYER_NOTES.SIEGE_OBSERVED) || list.includes(PLAYER_NOTES.REINFORCED_OBSERVED)) {
      bump("pausedObserved");
    }
    for (const r of Array.isArray(results) ? results : []) {
      if (!isPlain(r)) continue;
      if (r.outcome === OUTCOME.STALE) bump("opsStale");
      else if (r.outcome === OUTCOME.DUPLICATE) bump("opsDuplicate");
      else if (r.outcome === OUTCOME.REFUSED) bump("opsRefused");
      else if (r.outcome !== OUTCOME.APPLIED) continue;
      else if (r.op === PLAYER_OP.SAMPLE) {
        bump("samples");
        bump("creditedMs", r.creditedDeltaMs);
      } else if (r.op === PLAYER_OP.ATTACK) bump("attacks");
      else if (r.op === PLAYER_OP.REINFORCE) bump("reinforced");
      else if (r.op === PLAYER_OP.RETAKE) bump("retakes");
      else if (r.op === PLAYER_OP.LIFT) bump("lifts");
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", counters: Object.freeze({ ...counters }) });
  }

  function stop() {
    stopped = true;
    hostileMemo.clear();
    activityMemo.clear();
  }

  return Object.freeze({ readForOccupationInTx, applyOpsInTx, noteCommitted, getStatus, transitionInTx,
    listForReviewInTx, bump, stop });
}

function createUnavailablePlayerSovSiege(reason) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  return Object.freeze({ readForOccupationInTx: () => ({ ok: true, claim: null }),
    applyOpsInTx: () => ({ ok: false, reason: "PLAYER_SOV_SIEGE_UNAVAILABLE" }), noteCommitted() {},
    listForReviewInTx: () => ({ ok: false, reason: "PLAYER_SOV_SIEGE_UNAVAILABLE" }),
    getStatus: () => status, stop() {} });
}

function startPlayerSovSiege(deps) {
  try {
    const { config, persistence, playerSov, clock } = deps || {};
    const C = config && config.playerSov;
    if (!C || C.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    const repo = playerSov && typeof playerSov.getRepository === "function"
      ? call(() => playerSov.getRepository(), null) : null;
    if (!repo) return { ok: false, reason: "dependency_disabled:playerSov" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "PLAYER_SOV_SIEGE_START_FAILED",
      detail: "clock" };
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 1) {
        return { ok: false, reason: "PLAYER_SOV_SIEGE_START_FAILED", detail: `playerSov.${key}` };
      }
    }
    const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
    const clockRepo = createPlayerSovClockRepository();
    const box = { siege: null };
    const ownerOnline = createOwnerOnline({ getPresence: deps.getPresence, adapter: deps.adapter || null, config,
      now: () => clock.now(), bump: (name) => box.siege && box.siege.bump(name) });
    const siege = createPlayerSovSiege({ journal: persistence.journal, getPlayerSov: () => playerSov, clockRepo,
      ownerOnline, adapter: deps.adapter || null, getRegistry: deps.getRegistry, getPresence: deps.getPresence, config,
      telemetry: deps.telemetry || null, counters });
    box.siege = siege;
    const pump = createRetakePump({ store: persistence.store, getRepository: () => playerSov.getRepository(),
      clockRepo, ownerOnline, adapter: deps.adapter || null, config, clock, transitionInTx: siege.transitionInTx,
      bump: (name, n) => siege.bump(name, n), logger: deps.logger || null, getGovernor: deps.getGovernor,
      setTimer: deps.setTimer });
    const started = pump.start();
    if (!started || !started.ok) {
      pump.stop();
      return { ok: false, reason: "PLAYER_SOV_SIEGE_START_FAILED", detail: (started && started.reason) || "pump" };
    }
    const facade = {
      readForOccupationInTx: siege.readForOccupationInTx,
      applyOpsInTx: siege.applyOpsInTx,
      noteCommitted: siege.noteCommitted,
      listForReviewInTx: siege.listForReviewInTx,
      getStatus: () => Object.freeze({ ...siege.getStatus(), retake: pump.getStatus() }),
      runRetakePass: () => pump.runPass(),
      stop() {
        pump.stop();
        siege.stop();
        ownerOnline.clear();
      },
    };
    return { ok: true, playerSovSiege: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "PLAYER_SOV_SIEGE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { createPlayerSovSiege, createUnavailablePlayerSovSiege, startPlayerSovSiege, journalKeyOf,
  journalEdgeInTx, COUNTER_NAMES, AGGREGATE, EVENT, OUTCOME };
