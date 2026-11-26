"use strict";

const S = require("./schema");
const { buildTargets, decideTale } = require("./decide");
const { planConstellationDrops, taleSystemIdsOf } = require("./consequence");
const { rewardDecisionOf } = require("./reward");

const COUNTER_NAMES = Object.freeze(["passes", "steerHits", "steerPassthrough", "steerExclusiveNull", "steerErrors",
  "drift", "bound", "settledDefeated", "settledExpired", "settledVanished", "repelApplied", "settleRetry",
  "settleFailed", "readFailed", "dropsApplied", "dropsSkipped",
  "rewardPlanned", "rewardSkipped", "rewardRetry"]);
const STEER_CLASS = "OPERATIONAL";
const SETTLE_CLASS = "SETTLEMENT";
const SAVEPOINT_ABORT = Symbol("nativeIncursions.savepoint");
const HEAVY_FULL_STATE = "running";

const messageOf = (err) => String((err && err.message) || err);

function createNativeIncursionService(deps) {
  const { store, journal, repository: repo, adapter, settings: P, clock } = deps;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let lastTargets = [];
  let lastPassAt = null;
  let lastRefusal = null;
  let lastPublish = null;
  let vendorBands = null;
  let boundCount = null;
  let driftCounted = false;
  let prevStats = { hits: 0, passthrough: 0, exclusiveNull: 0, errors: 0 };
  let rewardAfter = 0;

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
    metric("count", `world.nativeIncursions.${name}`, n);
  }

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  function admits(cls) {
    const g = typeof deps.getGovernor === "function" ? safe(() => deps.getGovernor(), null) : null;
    return !g || typeof g.admits !== "function" || safe(() => g.admits(cls), true) !== false;
  }

  let refusedInPass = false;
  function refuse(line) {
    refusedInPass = true;
    if (line === lastRefusal) return;
    lastRefusal = line;
    logger.log(`nativeIncursions: ${line}`);
  }

  function readClaims() {
    const world = safe(() => deps.getWorldRepository(), null);
    if (!world || typeof world.listByOccupier !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const r = store.transaction("nativeIncursions.claims", (db) => {
      const rows = [];
      let after = 0;
      for (;;) {
        const page = world.listByOccupier(db, S.NATIVE_FACTION_ID, { limit: P.steer.maxTargets, afterSystemId: after });
        if (!page || page.ok !== true) return { ok: false, reason: (page && page.reason) || "CLAIMS_READ_FAILED" };
        for (const s of page.systems) {
          if (P.claimStates.includes(s.occupationState)) rows.push({ systemId: s.systemId, occupationState: s.occupationState });
        }
        if (rows.length >= P.steer.maxTargets || page.nextAfterSystemId === null) break;
        after = page.nextAfterSystemId;
      }
      return { ok: true, rows };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  function steer() {
    if (P.steer.enabled !== true) {
      lastTargets = [];
      safe(() => adapter.nativeIncursionsSetTargets(null), null);
      return;
    }
    if (!admits(STEER_CLASS)) return;
    const claims = readClaims();
    if (!claims.ok) {
      bump("readFailed");
      refuse(`claims ${claims.reason}`);
      return;
    }
    lastTargets = buildTargets(claims.rows, { claimStates: P.claimStates, maxTargets: P.steer.maxTargets });
    const list = lastTargets;
    const pub = safe(() => adapter.nativeIncursionsSetTargets({ high: list, low: list, null: list }, P.steer.mode,
      P.steer.logSize), { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "threw" });
    lastPublish = pub && pub.ok === true ? "ok" : `${(pub && pub.reason) || "?"}${pub && pub.detail ? ` (${pub.detail})` : ""}`;
    if (pub && pub.reason === "INCURSION_STEER_DRIFT" && !driftCounted) {
      driftCounted = true;
      bump("drift");
      refuse(`steer disabled:drift ${pub.detail || ""}`.trim());
    }
  }

  function wrapperStats() {
    const st = safe(() => adapter.nativeIncursionsStats(), null);
    if (!st || typeof st !== "object") return null;
    const delta = (key) => (Number.isSafeInteger(st[key]) && st[key] > prevStats[key] ? st[key] - prevStats[key] : 0);
    bump("steerHits", delta("hits"));
    bump("steerPassthrough", delta("passthrough"));
    bump("steerExclusiveNull", delta("exclusiveNull"));
    bump("steerErrors", delta("errors"));
    prevStats = { hits: st.hits || 0, passthrough: st.passthrough || 0, exclusiveNull: st.exclusiveNull || 0,
      errors: st.errors || 0 };
    if (st.drift === true && !driftCounted) {
      driftCounted = true;
      bump("drift");
    }
    return st;
  }

  function bind(tale, decision, at) {
    const r = store.transaction("nativeIncursions.bind", (db) => {
      const count = repo.countBoundInTx(db);
      if (!count.ok) return count;
      if (count.count >= P.maxActiveBindings) return { ok: true, bound: false };
      const ap = journal.applyOnce(db, { key: S.bindKey(tale.taleId, tale.generation),
        aggregate: { type: S.AGGREGATE, id: String(tale.taleId) }, eventType: S.EVENT_BIND,
        payload: { taleId: tale.taleId, generation: tale.generation } }, (db2) => repo.insertBoundInTx(db2, {
        taleId: tale.taleId, generation: tale.generation, factionId: S.NATIVE_FACTION_ID,
        constellationId: tale.constellationId, band: tale.band, targetSystemId: decision.targetSystemId,
        steered: decision.steered, boundAt: at, expiresAt: tale.expiresAt }));
      if (!ap.ok) return ap.reason === "APPLY_REFUSED" && ap.refusal ? ap.refusal : ap;
      return { ok: true, bound: ap.duplicate !== true };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "EFFECT_ERROR" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      if (tx.inTransaction !== true) throw err;
      return { ok: false, reason: "EFFECT_ERROR", detail: messageOf(err) };
    }
  }

  function consequenceInTx(db2, row, outcome, effect, tale, at) {
    const none = { ok: true, applied: 0, skipped: 0 };
    if (P.consequences !== "on" || !tale) return none;
    const defeated = outcome === S.OUTCOME.DEFEATED;
    if (!defeated && outcome !== S.OUTCOME.EXPIRED) return none;
    if (!((defeated ? P.defeatInfluencePoints : P.expireInfluencePoints) > 0)) return none;
    const ids = taleSystemIdsOf(tale.systemIds, S.MAX_TALE_SYSTEMS);
    if (ids.length === 0) return none;
    const world = safe(() => deps.getWorldRepository(), null);
    if (!world || typeof world.getSystems !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const got = world.getSystems(db2, ids, { includeInfluence: false });
    if (!got || got.ok !== true) return { ok: false, reason: (got && got.reason) || "WORLD_READ_FAILED" };
    const plan = planConstellationDrops({ outcome, effect, targetSystemId: row.targetSystemId, systemIds: ids,
      systems: got.systems, claimantFactionId: row.factionId, claimStates: P.claimStates,
      defeatPoints: P.defeatInfluencePoints, expirePoints: P.expireInfluencePoints, maxSystems: S.MAX_TALE_SYSTEMS });
    if (plan.length === 0) return none;
    const occ = safe(() => deps.getOccupation(), null);
    if (!occ || typeof occ.dropInfluenceInTx !== "function") return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
    let applied = 0;
    let skipped = 0;
    for (const p of plan) {
      const hold = p.kind === "hold";
      const key = (hold ? S.holdKey : S.dropKey)(row.taleId, row.generation, p.systemId);
      const r = inSavepoint(db2, () => occ.dropInfluenceInTx(db2, { systemId: p.systemId, factionId: p.factionId,
        points: p.points, at, reason: hold ? S.HOLD_REASON : S.DROP_REASON, allowNonController: true }, key));
      if (r && r.ok === true) {
        if (r.outcome !== "DUPLICATE" && r.written !== false) applied += 1;
      } else if (r && S.RETRY_DROP_REFUSALS.includes(r.reason)) return { ok: false, reason: r.reason };
      else skipped += 1;
    }
    return { ok: true, applied, skipped };
  }

  function settle(row, outcome, tale, at) {
    const exhausted = row.attempts >= P.settleMaxAttempts;
    let characterId = null;
    if (outcome === S.OUTCOME.DEFEATED && !exhausted) {
      const receiptId = tale && tale.terminal ? tale.terminal.bossReceiptId : null;
      if (receiptId) {
        const p = safe(() => adapter.nativeIncursionsBossParticipants(receiptId, 1), null);
        if (!p || p.ok !== true) {
          const b = store.transaction("nativeIncursions.retry", (db) => repo.bumpAttemptInTx(db, row.taleId, row.version));
          bump("settleRetry");
          refuse(`settle ${row.taleId} receipt ${(p && p.reason) || "?"}${b.ok ? "" : ` bump ${b.reason}`}`);
          return { ok: true, retry: true };
        }
        characterId = p.characterIds.length > 0 ? p.characterIds[0] : null;
      }
    }
    const eventId = tale && tale.terminal && tale.terminal.eventId ? tale.terminal.eventId : null;
    const decidedAt = tale && tale.terminal && tale.terminal.decidedAt > 0 ? tale.terminal.decidedAt : at;
    const r = store.transaction("nativeIncursions.settle", (db) => {
      let effect = S.EFFECT.RECORDED;
      let drops = { applied: 0, skipped: 0 };
      const ap = journal.applyOnce(db, { key: S.settleKey(row.taleId, row.generation),
        aggregate: { type: S.AGGREGATE, id: String(row.taleId) }, eventType: S.EVENT_SETTLE,
        payload: { taleId: row.taleId, generation: row.generation, outcome, targetSystemId: row.targetSystemId } },
      (db2) => {
        if (exhausted) effect = S.EFFECT.FAILED;
        else if (outcome === S.OUTCOME.DEFEATED) {
          if (characterId === null) effect = S.EFFECT.NO_PARTICIPANT;
          else {
            const occ = safe(() => deps.getOccupation(), null);
            if (!occ || typeof occ.applyPlayerRepelInTx !== "function") return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
            const rep = occ.applyPlayerRepelInTx(db2, { systemId: row.targetSystemId, factionId: row.factionId,
              huntId: S.huntIdOf(row.taleId), characterId, at: decidedAt }, S.repelKey(row.taleId, row.generation));
            if (rep && rep.ok === true) effect = rep.outcome === "NO_INFLUENCE" ? S.EFFECT.NO_INFLUENCE : S.EFFECT.REPEL_APPLIED;
            else if (rep && S.FINAL_REPEL_REFUSALS.includes(rep.reason)) effect = rep.reason;
            else return { ok: false, reason: (rep && rep.reason) || "REPEL_FAILED" };
          }
        }
        if (!exhausted) {
          const c = consequenceInTx(db2, row, outcome, effect, tale, decidedAt);
          if (!c.ok) return c;
          drops = { applied: c.applied, skipped: c.skipped };
        }
        const rewardState = outcome === S.OUTCOME.DEFEATED && P.rewardsMode === "on" ? S.REWARD_STATE.PENDING : null;
        return repo.settleInTx(db2, row.taleId, row.version, { outcome, terminalEventId: eventId, effect, settledAt: at,
          rewardState });
      });
      if (ap.ok) {
        if (ap.duplicate === true) return { ok: true, effect: null };
        return { ok: true, effect, drops };
      }
      const reason = ap.reason === "APPLY_REFUSED" && ap.refusal ? ap.refusal.reason : ap.reason;
      if (reason === "STALE") return { ok: true, stale: true };
      const b = repo.bumpAttemptInTx(db, row.taleId, row.version);
      return { ok: true, retry: true, reason, bumped: b.ok === true };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    const v = r.value;
    if (v.retry) {
      bump("settleRetry");
      refuse(`settle ${row.taleId} retry ${v.reason}`);
    } else if (v.effect) {
      bump(outcome === S.OUTCOME.DEFEATED ? "settledDefeated" : outcome === S.OUTCOME.EXPIRED ? "settledExpired"
        : "settledVanished");
      if (v.effect === S.EFFECT.REPEL_APPLIED) bump("repelApplied");
      if (v.effect === S.EFFECT.FAILED) bump("settleFailed");
      if (v.drops) {
        bump("dropsApplied", v.drops.applied);
        bump("dropsSkipped", v.drops.skipped);
      }
    }
    return v;
  }

  function readRows(tales) {
    const r = store.transaction("nativeIncursions.read", (db) => {
      const bound = repo.listBoundInTx(db, P.maxTalesPerPass);
      if (!bound.ok) return bound;
      const byTale = new Map();
      for (const t of tales || []) {
        const got = repo.getInTx(db, t.taleId);
        if (!got.ok) return got;
        byTale.set(t.taleId, got.row);
      }
      const count = repo.countBoundInTx(db);
      if (!count.ok) return count;
      return { ok: true, bound: bound.rows, byTale, count: count.count };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  function settlePass(at) {
    const first = readRows(null);
    if (!first.ok) {
      bump("readFailed");
      refuse(`rows ${first.reason}`);
      return { bound: 0, settled: 0 };
    }
    const oldest = first.bound.reduce((m, row) => Math.min(m, row.boundAt), at);
    const listed = safe(() => adapter.nativeIncursionsListTales({ limit: P.maxTalesPerPass,
      sinceMs: Math.max(0, oldest - P.lookbackMs) }), null);
    if (!listed || listed.ok !== true) {
      bump("readFailed");
      refuse(`tales ${(listed && listed.reason) || "?"}`);
      return { bound: 0, settled: 0 };
    }
    const tales = [...listed.tales].sort((a, b) => a.taleId - b.taleId);
    const rows = readRows(tales);
    if (!rows.ok) {
      bump("readFailed");
      refuse(`rows ${rows.reason}`);
      return { bound: 0, settled: 0 };
    }
    const st = safe(() => adapter.nativeIncursionsStats(), null);
    const steerLog = new Map((st && Array.isArray(st.steerLog) ? st.steerLog : [])
      .map((e) => [e.selectionKey, e.systemId]));
    const ctx = { targetSet: new Set(lastTargets.map((t) => t.systemId)), steerLog, boundCount: rows.count,
      maxActiveBindings: P.maxActiveBindings };
    let bound = 0;
    let settled = 0;
    const work = [];
    for (const tale of tales) {
      const row = rows.byTale.get(tale.taleId) || null;
      const d = decideTale(tale, row, ctx);
      if (d.action === "BIND" && tale.band !== null && tale.constellationId > 0 && tale.generation > 0) {
        const b = bind(tale, d, at);
        if (!b.ok) refuse(`bind ${tale.taleId} ${b.reason}`);
        else if (b.bound) {
          bound += 1;
          ctx.boundCount += 1;
          bump("bound");
        }
      } else if (d.action === "SETTLE") work.push({ row, outcome: d.outcome, tale });
    }
    if (!listed.truncated) {
      const seen = new Set(tales.map((t) => t.taleId));
      for (const row of first.bound) {
        if (!seen.has(row.taleId) && at > row.expiresAt + P.vanishGraceMs) {
          work.push({ row, outcome: S.OUTCOME.VANISHED, tale: null });
        }
      }
    }
    for (const w of work.slice(0, P.maxSettlementsPerPass)) {
      const r = settle(w.row, w.outcome, w.tale, at);
      if (!r.ok) refuse(`settle ${w.row.taleId} ${r.reason}`);
      else if (r.effect) settled += 1;
    }
    const after = readRows(null);
    if (after.ok) boundCount = after.count;
    return { bound, settled };
  }

  function rewardOne(row, at) {
    const R = P.rewards;
    const parts = safe(() => adapter.nativeIncursionsParticipants(row.taleId, R.maxRewardedParticipants,
      R.maxReceipts), null) || { ok: false, reason: "INCURSION_READ_FAILED", detail: "no result" };
    if (!parts.ok && !S.FINAL_PARTICIPANT_REFUSALS.includes(parts.reason)) {
      return { kind: "RETRY", reason: parts.reason || "INCURSION_READ_FAILED" };
    }
    const key = S.rewardEventIdOf(row.taleId, row.generation);
    const r = store.transaction("nativeIncursions.reward", (db) => {
      let out = null;
      const skip = (reason) => {
        const w = repo.setRewardInTx(db, row.taleId, row.version, { rewardState: S.REWARD_STATE.SKIPPED,
          rewardReason: reason });
        if (w.ok) out = { kind: "SKIPPED", reason };
        return w;
      };
      const ap = journal.applyOnce(db, { key, aggregate: { type: S.AGGREGATE, id: String(row.taleId) },
        eventType: S.EVENT_REWARD, payload: { taleId: row.taleId, generation: row.generation } }, (db2) => {
        if (!parts.ok) return skip(parts.reason);
        const world = safe(() => deps.getWorldRepository(), null);
        if (!world || typeof world.getSystem !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
        const got = world.getSystem(db2, row.targetSystemId, { includeInfluence: false });
        if (!got || got.ok !== true) return { ok: false, reason: (got && got.reason) || "WORLD_READ_FAILED" };
        const d = rewardDecisionOf({ controllerFactionId: got.system ? got.system.controllerFactionId : null,
          participants: parts.characterIds, nativeFactionId: S.NATIVE_FACTION_ID });
        if (d.kind === "SKIP") return skip(d.reason);
        const heavy = typeof deps.getHeavyEvents === "function" ? safe(() => deps.getHeavyEvents(), null) : null;
        if (!heavy || typeof heavy.planRewardPayoutsInTx !== "function") {
          return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" };
        }
        const plan = heavy.planRewardPayoutsInTx(db2, { eventId: key, issuerFactionId: d.issuerFactionId,
          systemId: row.targetSystemId, characterIds: parts.characterIds, lpAmount: R.loyaltyPoints, at });
        if (!plan || plan.ok !== true) {
          const reason = (plan && plan.reason) || "HEAVY_EVENTS_UNAVAILABLE";
          return S.FINAL_PAYOUT_REFUSALS.includes(reason) ? skip(reason) : { ok: false, reason };
        }
        const w = repo.setRewardInTx(db2, row.taleId, row.version, { rewardState: S.REWARD_STATE.PLANNED,
          rewardReason: null });
        if (w.ok) out = { kind: "PLANNED", planned: plan.planned };
        return w;
      });
      if (ap.ok && ap.duplicate === true) {
        const w = repo.setRewardInTx(db, row.taleId, row.version, { rewardState: S.REWARD_STATE.PLANNED,
          rewardReason: S.REWARD_REASON.DUPLICATE });
        return w.ok ? { kind: "PLANNED", planned: 0 } : { kind: "STALE" };
      }
      if (ap.ok) return out || { kind: "RETRY", reason: "NO_OUTCOME" };
      const reason = ap.reason === "APPLY_REFUSED" && ap.refusal ? ap.refusal.reason : ap.reason;
      return reason === "STALE" ? { kind: "STALE" } : { kind: "RETRY", reason };
    });
    if (!r.ok) return { kind: "RETRY", reason: r.reason || "TX_FAILED" };
    return r.value;
  }

  function heavyReady() {
    const heavy = typeof deps.getHeavyEvents === "function" ? safe(() => deps.getHeavyEvents(), null) : null;
    if (!heavy || typeof heavy.planRewardPayoutsInTx !== "function") return false;
    if (typeof heavy.getStatus !== "function") return true;
    const st = safe(() => heavy.getStatus(), null);
    return Boolean(st) && st.state === HEAVY_FULL_STATE;
  }

  function rewardPass(at) {
    if (P.rewardsMode !== "on") return;
    const max = P.rewards.maxPerPass;
    const listed = store.transaction("nativeIncursions.rewardRead", (db) => {
      const page = repo.listRewardPendingInTx(db, max, rewardAfter);
      if (!page.ok || page.rows.length > 0 || rewardAfter === 0) return page;
      return repo.listRewardPendingInTx(db, max, 0);
    });
    const list = listed.ok ? listed.value : null;
    if (!list || list.ok !== true) {
      bump("readFailed");
      refuse(`rewards ${(list && list.reason) || listed.reason || "?"}`);
      return;
    }
    if (list.rows.length === 0) {
      rewardAfter = 0;
      return;
    }
    if (!heavyReady()) {
      bump("rewardRetry", list.rows.length);
      refuse("rewards retry HEAVY_EVENTS_UNAVAILABLE");
      return;
    }
    let firstRetry = null;
    for (const row of list.rows) {
      const v = rewardOne(row, at);
      if (v.kind === "PLANNED") bump("rewardPlanned", v.planned);
      else if (v.kind === "SKIPPED") bump("rewardSkipped");
      else if (v.kind === "RETRY") {
        bump("rewardRetry");
        if (firstRetry === null) firstRetry = v.reason;
      }
    }
    rewardAfter = list.rows.length < max ? 0 : list.rows[list.rows.length - 1].taleId;
    if (firstRetry !== null) refuse(`rewards retry ${firstRetry}`);
  }

  function runPass(now) {
    if (stopped) return { ok: false, reason: "NATIVE_INCURSIONS_STOPPED" };
    const t0 = nowMs();
    try {
      const at = Number.isSafeInteger(now) ? now : clock.now();
      refusedInPass = false;
      bump("passes");
      steer();
      metric("gauge", "world.nativeIncursions.targets", lastTargets.length);
      wrapperStats();
      const bands = safe(() => adapter.nativeIncursionsVendorBands(), null);
      if (bands && bands.ok === true) vendorBands = bands.bands;
      let out = { bound: 0, settled: 0 };
      let skipped;
      if (P.settle.enabled !== true) skipped = "DISABLED";
      else if (!admits(SETTLE_CLASS)) skipped = "GOVERNOR";
      else {
        out = settlePass(at);
        rewardPass(at);
      }
      lastPassAt = at;
      if (!refusedInPass) lastRefusal = null;
      return { ok: true, targets: lastTargets.length, bound: out.bound, settled: out.settled,
        ...(skipped ? { skipped } : {}) };
    } catch (err) {
      refuse(`pass threw - ${messageOf(err)}`);
      return { ok: false, reason: "NATIVE_INCURSIONS_PASS_FAILED", detail: messageOf(err) };
    } finally {
      metric("observe", "world.nativeIncursions.passMs", Math.max(0, nowMs() - t0));
    }
  }

  function getStatus() {
    const st = safe(() => adapter.nativeIncursionsStats(), null);
    return Object.freeze({ state: stopped ? "stopped" : "running", mode: P.steer.mode,
      steer: P.steer.enabled === true, settle: P.settle.enabled === true, vendorBands,
      installed: Boolean(st && st.installed), drift: Boolean(st && st.drift), bound: boundCount, lastPassAt,
      targets: lastTargets.length, lastPublish, lastRefusal, consequences: P.consequences || "off",
      rewards: P.rewardsMode || "off",
      counters: Object.freeze({ ...counters }) });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    safe(() => adapter.nativeIncursionsSetTargets(null), null);
  }

  return Object.freeze({ runPass, getStatus, stop, isStopped: () => stopped });
}

module.exports = { createNativeIncursionService, COUNTER_NAMES };
