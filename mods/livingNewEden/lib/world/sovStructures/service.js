"use strict";

const S = require("./schema");
const { INVASION } = require("../occupation/schema");

const SCHEDULER_READY = "ready";
const MAX_DETAIL = 120;
const STEP_PAYLOAD_KEYS = "structureId";
const COUNTER_NAMES = Object.freeze(["anchorRequested", "anchorRefused", "anchorUnfunded", "anchorFree", "online",
  "destroyedFieldLost", "endedClaimLost", "endedControlLost", "endedAbandoned", "stepStale",
  "siegeStarted", "siegeLifted", "destroyedSiege", "controlReleased", "siegeObserved", "adopted", "healed",
  "healRefused", "pruned", "reconcileRuns"]);
const RECONCILE_PAYLOAD_KEYS = "after,bucket,phase";
const HEAL_SAVEPOINT_ABORT = Symbol("sov-heal-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function refOf(s) {
  return Object.freeze({ structureId: s.structureId, factionId: s.factionId, state: s.state, version: s.version,
    attackerFactionId: s.attackerFactionId, attackStartedAt: s.attackStartedAt, dueAt: s.dueAt });
}

function createSovStructureService(deps) {
  const { store, repository, scheduler, clock } = deps;
  const C = deps.config.sovStructures;
  const { pageRows, healRows } = deps;
  if (!isId(pageRows) || !isId(healRows)) throw new TypeError("sovStructures: pageRows / healRows");
  const telemetry = deps.telemetry || null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let live = null;
  let lastRefusal = null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  let adoptBootTotal = 0;
  let adoptBootLogged = false;

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
    metric("count", `world.sovStructures.${name}`, n);
  }

  function noteRefusal(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
  }

  function occupation() {
    return typeof deps.getOccupation === "function" ? call(deps.getOccupation, null) : null;
  }

  function treasury() {
    return typeof deps.getTreasury === "function" ? call(deps.getTreasury, null) : null;
  }

  function observedNow(systemId) {
    const p = typeof deps.getPresence === "function" ? call(deps.getPresence, null) : null;
    if (!p || typeof p.distanceToObserved !== "function") return false;
    const d = call(() => p.distanceToObserved(systemId, 0), null);
    return d !== null && typeof d === "object" && d.ok === true && d.distance === 0;
  }

  function needs(factionId) {
    return typeof deps.needsSovStructureOf === "function"
      ? call(() => deps.needsSovStructureOf(factionId) !== false, true) : true;
  }

  function refreshLive() {
    const r = call(() => store.transaction("sovStructures.live", (db) => repository.countLive(db)), null);
    const v = r && r.ok ? r.value : null;
    if (v && v.ok) {
      live = v.live;
      metric("gauge", S.LIVE_GAUGE, live);
    }
  }

  function readForOccupationInTx(db, systemId) {
    if (stopped) return { ok: true, sov: null };
    const r = repository.listLiveInSystem(db, systemId);
    if (!r.ok) return r;
    let adoptPending = false;
    if (r.structures.length === 0) {
      const a = repository.adoptPendingOf(db, systemId);
      if (!a.ok) return a;
      adoptPending = a.factionId !== null && needs(a.factionId);
    }
    return { ok: true, sov: Object.freeze({ structures: Object.freeze(r.structures.map(refOf)),
      siegeHoldMs: C.siegeHoldMs, pauseWhenObserved: C.siegePausedWhenObserved === true,
      observed: r.structures.length > 0 ? observedNow(systemId) : false, anchorMs: C.anchorMs, adoptPending,
      earlyTimers: C.earlyTimersEnabled === true }) };
  }

  function result(op, outcome, extra) {
    return { op, outcome, ...(extra || {}) };
  }

  function anchorInTx(db, systemId, op, at) {
    if (!isId(op.factionId) || !isCount(op.claimSeq)) return { ok: false, reason: "SOV_OP_INVALID", detail: "anchor" };
    const listed = repository.listLiveInSystem(db, systemId);
    if (!listed.ok) return listed;
    const mine = listed.structures.find((s) => s.factionId === op.factionId);
    if (mine) return result(S.OP.ANCHOR, S.OUTCOME.DUPLICATE, { structureId: mine.structureId });
    if (listed.structures.length > 0) return result(S.OP.ANCHOR, S.OUTCOME.REFUSED, { reason: S.CODES.FOREIGN });
    const tried = repository.countAttempts(db, systemId, op.factionId, op.claimSeq);
    if (!tried.ok) return tried;
    const attempt = tried.count + 1;
    if (attempt > C.maxAttemptsPerClaim) return result(S.OP.ANCHOR, S.OUTCOME.REFUSED, { reason: S.CODES.ATTEMPTS });
    const limits = repository.countLimits(db, op.factionId);
    if (!limits.ok) return limits;
    if (limits.anchoringOfFaction >= C.maxAnchoringPerFaction) {
      return result(S.OP.ANCHOR, S.OUTCOME.REFUSED, { reason: S.CODES.LIMIT_FACTION });
    }
    if (limits.live >= C.maxLive) return result(S.OP.ANCHOR, S.OUTCOME.REFUSED, { reason: S.CODES.LIMIT_TOTAL });
    const structureId = S.structureIdOf(systemId, op.factionId, op.claimSeq, attempt);
    let costIsk = 0;
    let free = false;
    if (C.costIsk > 0) {
      const t = treasury();
      if (!t || typeof t.chargeWarSpendInTx !== "function") free = true;
      else {
        const paid = t.chargeWarSpendInTx(db, { factionId: op.factionId, isk: C.costIsk, at }, S.feeKey(structureId));
        if (paid && paid.ok === true) costIsk = C.costIsk;
        else if (paid && S.FREE_TREASURY_REASONS.includes(paid.reason)) free = true;
        else if (paid && S.UNFUNDED_TREASURY_REASONS.includes(paid.reason)) {
          return result(S.OP.ANCHOR, S.OUTCOME.REFUSED, { reason: paid.reason });
        } else {
          return { ok: false, reason: (paid && paid.reason) || "TREASURY_FAILED",
            ...(paid && paid.detail ? { detail: String(paid.detail) } : {}) };
        }
      }
    }
    const dueAt = at + C.anchorMs;
    const ins = repository.insertAnchoring(db, { structureId, systemId, factionId: op.factionId,
      claimSeq: op.claimSeq, attempt, costIsk, dueAt, at });
    if (!ins.ok) return ins;
    const e = scheduler.enqueue(S.STEP_EVENT_TYPE, structureId, dueAt, { structureId }, S.stepKey(structureId),
      { tx: db, chained: true });
    if (!e || e.ok !== true) return { ok: false, reason: (e && e.reason) || "ENQUEUE_FAILED", detail: "step" };
    return result(S.OP.ANCHOR, S.OUTCOME.APPLIED, { structureId, ...(free ? { free: true } : {}) });
  }

  function liveOfOp(db, systemId, op) {
    const got = repository.getById(db, op.structureId);
    if (!got.ok) return got;
    const s = got.structure;
    if (!s || s.systemId !== systemId || !S.LIVE_STATES.includes(s.state)) return { ok: true, stale: true };
    if (op.version !== undefined && s.version !== op.version) {
      return { ok: false, reason: "VERSION_CONFLICT", structureId: s.structureId };
    }
    return { ok: true, stale: false, structure: s };
  }

  function siegeInTx(db, systemId, op, at) {
    const attack = op.op === S.OP.ATTACK;
    if (typeof op.structureId !== "string" || !isId(op.version) || (attack && !isId(op.factionId))) {
      return { ok: false, reason: "SOV_OP_INVALID", detail: op.op };
    }
    const live = liveOfOp(db, systemId, op);
    if (!live.ok) return live;
    if (live.stale) return result(op.op, S.OUTCOME.STALE, { structureId: op.structureId });
    const s = live.structure;
    const attacker = attack ? op.factionId : null;
    if (s.attackerFactionId === attacker) return result(op.op, S.OUTCOME.DUPLICATE, { structureId: s.structureId });
    const w = repository.setSiege(db, s, attacker, at);
    if (!w.ok) return w;
    return result(op.op, S.OUTCOME.APPLIED, { structureId: s.structureId });
  }

  function endInTx(db, systemId, op, at) {
    const destroy = op.op === S.OP.DESTROY;
    const reasons = destroy ? [S.REASON.FIELD_LOST, S.REASON.SIEGE] : [S.REASON.CLAIM_LOST, S.REASON.CONTROL_LOST];
    if (typeof op.structureId !== "string" || !reasons.includes(op.reason)
      || (op.byFactionId !== null && op.byFactionId !== undefined && !isId(op.byFactionId))
      || (op.reason === S.REASON.SIEGE && (!isId(op.byFactionId) || !isId(op.version)))) {
      return { ok: false, reason: "SOV_OP_INVALID", detail: op.op };
    }
    const live = liveOfOp(db, systemId, op);
    if (!live.ok) return live;
    if (live.stale) return result(op.op, S.OUTCOME.STALE, { structureId: op.structureId });
    const s = live.structure;
    const t = repository.transition(db, { structure: s, to: destroy ? S.DESTROYED : S.ENDED, at, reason: op.reason,
      byFactionId: op.byFactionId === undefined ? null : op.byFactionId });
    if (!t.ok) {
      if (t.reason === S.CODES.TRANSITION_DENIED) {
        return result(op.op, S.OUTCOME.REFUSED, { reason: t.reason, structureId: s.structureId });
      }
      return t;
    }
    return result(op.op, S.OUTCOME.APPLIED, { structureId: s.structureId, reason: op.reason });
  }

  function bindInTx(db, systemId, op, at) {
    if (typeof op.structureId !== "string" || !isTime(op.capturedAt)) {
      return { ok: false, reason: "SOV_OP_INVALID", detail: "bind" };
    }
    const got = repository.getById(db, op.structureId);
    if (!got.ok) return got;
    const s = got.structure;
    if (!s || s.systemId !== systemId || s.state !== S.ONLINE) {
      return result(S.OP.BIND, S.OUTCOME.STALE, { structureId: op.structureId });
    }
    const b = repository.bindCapture(db, s, op.capturedAt, at);
    if (!b.ok) return b;
    return result(S.OP.BIND, S.OUTCOME.APPLIED, { structureId: s.structureId });
  }

  function applyOpsInTx(db, spec, keyBase) {
    try {
      if (stopped) return { ok: false, reason: "SOV_STRUCTURES_STOPPED" };
      if (!db || db.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!isPlain(spec) || !isId(spec.systemId) || !Array.isArray(spec.ops) || !isTime(spec.at)
        || typeof keyBase !== "string" || keyBase === "") {
        return { ok: false, reason: "SOV_INPUT_INVALID" };
      }
      const results = [];
      for (const op of spec.ops) {
        if (!isPlain(op)) return { ok: false, reason: "SOV_OP_INVALID" };
        let r;
        if (op.op === S.OP.ANCHOR) r = anchorInTx(db, spec.systemId, op, spec.at);
        else if (op.op === S.OP.END || op.op === S.OP.DESTROY) r = endInTx(db, spec.systemId, op, spec.at);
        else if (op.op === S.OP.BIND) r = bindInTx(db, spec.systemId, op, spec.at);
        else if (op.op === S.OP.ATTACK || op.op === S.OP.LIFT) r = siegeInTx(db, spec.systemId, op, spec.at);
        else return { ok: false, reason: "SOV_OP_INVALID", detail: String(op.op) };
        if (r.ok === false) return r;
        results.push(r);
      }
      return { ok: true, results };
    } catch (err) {
      return { ok: false, reason: "SOV_APPLY_FAILED", detail: messageOf(err) };
    }
  }

  function noteCommitted(results, notes) {
    if (Array.isArray(notes) && notes.includes(S.NOTES.SIEGE_OBSERVED)) bump("siegeObserved");
    if (!Array.isArray(results) || results.length === 0) return;
    for (const r of results) {
      if (!isPlain(r)) continue;
      if (r.op === S.OP.ANCHOR && r.outcome === S.OUTCOME.APPLIED) {
        bump("anchorRequested");
        if (r.free === true) bump("anchorFree");
      } else if (r.op === S.OP.ANCHOR && r.outcome === S.OUTCOME.REFUSED) {
        bump("anchorRefused");
        if (S.UNFUNDED_TREASURY_REASONS.includes(r.reason)) bump("anchorUnfunded");
        noteRefusal("anchor", r.reason);
      } else if (r.outcome === S.OUTCOME.APPLIED && r.op === S.OP.ATTACK) bump("siegeStarted");
      else if (r.outcome === S.OUTCOME.APPLIED && r.op === S.OP.LIFT) bump("siegeLifted");
      else if (r.outcome === S.OUTCOME.APPLIED && r.op === S.OP.DESTROY && r.reason === S.REASON.SIEGE) {
        bump("destroyedSiege");
        if (Array.isArray(notes) && notes.includes(S.NOTES.CONTROL_RELEASED)) bump("controlReleased");
      } else if (r.outcome === S.OUTCOME.APPLIED && r.op === S.OP.DESTROY) bump("destroyedFieldLost");
      else if (r.outcome === S.OUTCOME.APPLIED && r.op === S.OP.END) {
        bump(r.reason === S.REASON.CONTROL_LOST ? "endedControlLost" : "endedClaimLost");
      }
    }
    if (results.some((r) => isPlain(r) && r.outcome === S.OUTCOME.APPLIED)) refreshLive();
  }

  function endOfFactionInTx(db, spec, key) {
    try {
      if (stopped) return { ok: true, ended: 0 };
      if (!db || db.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!isPlain(spec) || !isId(spec.systemId) || !isId(spec.factionId) || spec.reason !== S.REASON.ABANDONED
        || !isTime(spec.at) || typeof key !== "string" || key === "") {
        return { ok: false, reason: "SOV_INPUT_INVALID" };
      }
      const listed = repository.listLiveInSystem(db, spec.systemId);
      if (!listed.ok) return listed;
      let ended = 0;
      for (const s of listed.structures) {
        if (s.factionId !== spec.factionId) continue;
        const t = repository.transition(db, { structure: s, to: S.ENDED, at: spec.at, reason: S.REASON.ABANDONED,
          byFactionId: null });
        if (!t.ok) return t;
        ended += 1;
      }
      bump("endedAbandoned", ended);
      return { ok: true, ended };
    } catch (err) {
      return { ok: false, reason: "SOV_ABANDON_FAILED", detail: messageOf(err) };
    }
  }

  function parseStepPayload(p) {
    if (!isPlain(p) || Object.keys(p).sort().join() !== STEP_PAYLOAD_KEYS) return null;
    return typeof p.structureId === "string" && p.structureId.length >= 1 && p.structureId.length <= S.MAX_ID_LENGTH
      ? { structureId: p.structureId } : null;
  }

  function onStep(ev, hctx) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SOV_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "SOV_STRUCTURES_STOPPED" };
      const occ = occupation();
      if (!occ || typeof occ.sovClaimOfInTx !== "function" || typeof occ.nudgeForSovInTx !== "function") {
        return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
      }
      const read = store.transaction("sovStructures.stepRead", (db) => repository.getById(db, p.structureId));
      const got = read.ok ? read.value : read;
      if (!got || !got.ok) return { ok: false, reason: (got && got.reason) || "TX_FAILED" };
      if (!got.structure) return { ok: true, outcome: "NO_ROW", onCommitted: () => bump("stepStale") };
      if (got.structure.state !== S.ANCHORING) {
        return { ok: true, outcome: "STALE", onCommitted: () => bump("stepStale") };
      }
      const at = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      let out = null;
      return { ok: true, outcome: "STEPPED",
        effect: (tx) => {
          const again = repository.getById(tx, p.structureId);
          if (!again.ok) return again;
          const s = again.structure;
          if (!s || s.state !== S.ANCHORING) {
            out = "stale";
            return { ok: true };
          }
          const claim = occ.sovClaimOfInTx(tx, s.systemId);
          if (!claim || claim.ok !== true) return claim || { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
          const c = claim.claim;
          if (c && c.state === INVASION && c.occupierFactionId === s.factionId) {
            const t = repository.transition(tx, { structure: s, to: S.ONLINE, at });
            if (!t.ok) return t;
            const n = occ.nudgeForSovInTx(tx, { systemId: s.systemId, structureId: s.structureId, at });
            if (!n || n.ok !== true) return n || { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
            out = "online";
            return { ok: true };
          }
          const t = repository.transition(tx, { structure: s, to: S.ENDED, at, reason: S.REASON.CLAIM_LOST,
            byFactionId: null });
          if (!t.ok) return t;
          out = "claimLost";
          return { ok: true };
        },
        onCommitted: () => {
          if (out === "stale") bump("stepStale");
          else if (out === "online") bump("online");
          else if (out === "claimLost") bump("endedClaimLost");
          if (out === "online" || out === "claimLost") refreshLive();
        } };
    } catch (err) {
      return { ok: false, reason: `SOV_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "SOV_STRUCTURES_STOPPED" };
      const ready = call(() => scheduler.getStatus().state === SCHEDULER_READY, false);
      if (!ready || typeof scheduler.enqueueMany !== "function") return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
      let after = "";
      let enqueued = 0;
      let duplicates = 0;
      for (;;) {
        const read = store.transaction("sovStructures.bootstrapRead", (db) => repository.listAnchoringPage(db, after,
          C.bootstrapPageRows));
        const page = read.ok ? read.value : read;
        if (!page || !page.ok) return { ok: false, reason: (page && page.reason) || "TX_FAILED" };
        if (page.structures.length === 0) break;
        const specs = page.structures.map((s) => ({ eventType: S.STEP_EVENT_TYPE, aggregateId: s.structureId,
          dueAt: s.dueAt, payload: { structureId: s.structureId }, idempotencyKey: S.stepKey(s.structureId) }));
        const r = scheduler.enqueueMany(specs);
        if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
        enqueued += r.enqueued;
        duplicates += r.duplicates;
        if (page.structures.length < C.bootstrapPageRows) break;
        after = page.structures[page.structures.length - 1].structureId;
      }
      refreshLive();
      return { ok: true, enqueued, duplicates };
    } catch (err) {
      return { ok: false, reason: `SOV_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  const bucketOf = (t) => Math.floor(t / C.reconcileMs);

  function parseReconcilePayload(p) {
    if (!isPlain(p) || Object.keys(p).sort().join() !== RECONCILE_PAYLOAD_KEYS) return null;
    if (!isCount(p.bucket) || !S.PHASES.includes(p.phase) || typeof p.after !== "string"
      || p.after.length > S.MAX_ID_LENGTH) return null;
    if ((p.phase === S.PHASE.ADOPT || p.phase === S.PHASE.PRUNE) && p.after !== "" && !/^\d+$/.test(p.after)) {
      return null;
    }
    return { bucket: p.bucket, phase: p.phase, after: p.after };
  }

  function enqueueReconcile(db, bucket, phase, after, dueAt) {
    const payload = { bucket, phase, after };
    const key = S.reconcileKey(bucket, phase, after);
    const r = db
      ? scheduler.enqueue(S.RECONCILE_EVENT_TYPE, S.RECONCILE_AGGREGATE_ID, dueAt, payload, key, { tx: db, chained: true })
      : scheduler.enqueue(S.RECONCILE_EVENT_TYPE, S.RECONCILE_AGGREGATE_ID, dueAt, payload, key);
    if (r && r.ok === false && r.reason === "IDEMPOTENCY_CONFLICT" && !db) return { ok: true, duplicate: true };
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED", detail: "reconcile" };
    return { ok: true, duplicate: r.duplicate === true };
  }

  function controlPhase(db, after, at, tally) {
    const page = repository.listControlPage(db, after, pageRows);
    if (!page.ok) return page;
    for (const { structure: s, claim } of page.rows) {
      const claims = claim.state === INVASION && claim.occupierFactionId === s.factionId;
      if (claims) continue;
      let reason = null;
      if (s.state === S.ONLINE && claim.controllerFactionId !== s.factionId) reason = S.REASON.CONTROL_LOST;
      else if (s.state === S.ANCHORING) reason = S.REASON.CLAIM_LOST;
      if (reason === null) continue;
      const t = repository.transition(db, { structure: s, to: S.ENDED, at, reason, byFactionId: null });
      if (!t.ok) return t;
      if (reason === S.REASON.CONTROL_LOST) tally.endedControlLost += 1;
      else tally.endedClaimLost += 1;
    }
    const n = page.rows.length;
    return { ok: true, full: n >= pageRows, last: n > 0 ? page.rows[n - 1].structure.structureId : after };
  }

  function healOne(db, occ, s, at) {
    let run = healSavepoints.get(db);
    if (!run) {
      run = db.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "SOV_HEAL_FAILED" };
          throw HEAL_SAVEPOINT_ABORT;
        }
        return r;
      });
      healSavepoints.set(db, run);
    }
    const holder = { refusal: null };
    try {
      return run(() => occ.abandonInTx(db, { systemId: s.systemId, factionId: s.factionId, at, allowClaim: true },
        S.abandonKey(s.structureId)), holder);
    } catch (err) {
      if (err === HEAL_SAVEPOINT_ABORT && db.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function healPhase(db, after, at, tally) {
    const page = repository.listHealPage(db, after, healRows);
    if (!page.ok) return page;
    const occ = page.structures.length > 0 ? occupation() : null;
    if (page.structures.length > 0 && (!occ || typeof occ.abandonInTx !== "function")) {
      return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
    }
    let processed = 0;
    let last = after;
    for (const s of page.structures) {
      const r = healOne(db, occ, s, at);
      if (r && r.ok === true) tally.healed += 1;
      else {
        tally.healRefused += 1;
        tally.refusal = `heal:${s.structureId}:${(r && r.reason) || "?"}`;
      }
      processed += 1;
      last = s.structureId;
    }
    return { ok: true, full: processed >= healRows, last };
  }

  function adoptPhase(db, after, at, tally) {
    const from = after === "" ? 0 : Number(after);
    const page = repository.listAdoptPage(db, from, pageRows);
    if (!page.ok) return page;
    for (const sys of page.systems) {
      if (!needs(sys.factionId)) continue;
      const r = repository.insertGrandfathered(db, { systemId: sys.systemId, factionId: sys.factionId,
        capturedAt: sys.capturedAt, at });
      if (!r.ok) return r;
      if (r.inserted) tally.adopted += 1;
    }
    const n = page.systems.length;
    return { ok: true, full: n >= pageRows, last: n > 0 ? String(page.systems[n - 1].systemId) : after };
  }

  function prunePhase(db, after, at, tally) {
    const r = repository.pruneTerminal(db, Math.max(0, at - C.retentionMs), after === "" ? 0 : Number(after),
      pageRows);
    if (!r.ok) return r;
    tally.pruned += r.deleted;
    return { ok: true, full: r.read >= pageRows, last: r.read > 0 ? String(r.lastRowId) : after };
  }

  const PHASE_FNS = Object.freeze({ [S.PHASE.CONTROL]: controlPhase, [S.PHASE.HEAL]: healPhase,
    [S.PHASE.ADOPT]: adoptPhase, [S.PHASE.PRUNE]: prunePhase });
  const healSavepoints = new WeakMap();

  function onReconcile(ev, hctx) {
    try {
      const p = parseReconcilePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SOV_RECONCILE_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "SOV_STRUCTURES_STOPPED" };
      const at = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const tally = { endedControlLost: 0, endedClaimLost: 0, healed: 0, healRefused: 0, adopted: 0, pruned: 0,
        refusal: null };
      let adoptEnded = false;
      return { ok: true, outcome: "RECONCILED",
        effect: (tx) => {
          const done = PHASE_FNS[p.phase](tx, p.after, at, tally);
          if (!done || done.ok !== true) return done || { ok: false, reason: "SOV_RECONCILE_FAILED" };
          adoptEnded = p.phase === S.PHASE.ADOPT && !done.full;
          let next;
          if (done.full) next = [p.bucket, p.phase, done.last, p.bucket * C.reconcileMs];
          else if (p.phase !== S.PHASE.PRUNE) {
            next = [p.bucket, S.PHASES[S.PHASES.indexOf(p.phase) + 1], "", p.bucket * C.reconcileMs];
          } else {
            const b = Math.max(p.bucket, bucketOf(at)) + 1;
            next = [b, S.PHASE.CONTROL, "", b * C.reconcileMs];
          }
          const e = enqueueReconcile(tx, ...next);
          return e.ok ? { ok: true } : e;
        },
        onCommitted: () => {
          bump("reconcileRuns");
          for (const name of ["endedControlLost", "endedClaimLost", "healed", "healRefused", "adopted", "pruned"]) {
            bump(name, tally[name]);
          }
          if (tally.refusal !== null) noteRefusal("reconcile", tally.refusal);
          if (tally.endedControlLost + tally.endedClaimLost + tally.adopted > 0) refreshLive();
          if (p.phase === S.PHASE.ADOPT && !adoptBootLogged) {
            adoptBootTotal += tally.adopted;
            if (adoptEnded) {
              adoptBootLogged = true;
              if (logger) call(() => logger.log(`sovStructures: running adopted=${adoptBootTotal}`), null);
            }
          }
        } };
    } catch (err) {
      return { ok: false, reason: `SOV_RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrapReconcile() {
    try {
      if (stopped) return { ok: false, reason: "SOV_STRUCTURES_STOPPED" };
      const bucket = bucketOf(clock.now()) + 1;
      const r = enqueueReconcile(null, bucket, S.PHASE.CONTROL, "", bucket * C.reconcileMs);
      return r.ok ? { ok: true, duplicate: r.duplicate, bucket } : r;
    } catch (err) {
      return { ok: false, reason: `SOV_RECONCILE_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "ready", enabled: !stopped,
      counters: Object.freeze({ ...counters }), live, lastRefusal });
  }

  return Object.freeze({
    readForOccupationInTx,
    applyOpsInTx,
    noteCommitted,
    endOfFactionInTx,
    onStep,
    bootstrap,
    onReconcile,
    bootstrapReconcile,
    getStatus,
    refreshLive,
    stop() {
      stopped = true;
    },
    isStopped: () => stopped,
  });
}

module.exports = { createSovStructureService, refOf, COUNTER_NAMES };
