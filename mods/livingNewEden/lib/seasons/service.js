"use strict";

const SC = require("./schema");
const { planSeason, stageAt, nextDueOf } = require("./timeline");
const { applyDeltas, outcomeOf } = require("./meter");
const { createSeasonRepository } = require("./repository");
const { createScoring } = require("./scoring");
const { rankRows, planRewards } = require("./ranking");
const { weightedPick } = require("./crises/common");
const { createAbortSentinel } = require("../persistence/store");
const { createRng, deriveSeed } = require("../util/rng");
const { STATE: EVENT_STATE } = require("../scheduler/schema");

const { STATE } = SC;
const DEAD_STEP_STATES = Object.freeze([EVENT_STATE.QUARANTINED, EVENT_STATE.DONE]);
const HOOK_REFUSED = createAbortSentinel("seasons.HOOK_REFUSED");
const MAX_DETAIL = 120;

const COUNTER_NAMES = Object.freeze(["steps", "planned", "started", "stage", "stageSkipped", "finale", "closed.WON",
  "closed.LOST", "closed.DRAW", "crisisHook.THREW", "crisisHook.REFUSED", "crisisHook.KIND_GONE",
  "crisisHook.SCORE_THREW", "kindGone", "crisisRepicked", "startDeferred", "noCrisis", "stateDeferred", "stale",
  "scorePasses", "closeLagDropped", "stepFailed", "scoreFailed", "stepRecovered", "stepRecoveryExhausted",
  "killsQueued", "killsDropped.QUEUE_FULL", "killsDropped.CLOSED", "killsNotCrisis", "scoreRowCapped",
  "heavyDefenses", "rewardsPlanned", "iskScaled", "rewardLeg.isk.DONE", "rewardLeg.isk.FAILED", "rewardLeg.isk.SKIPPED",
  "rewardLeg.item.DONE", "rewardLeg.item.FAILED", "rewardLeg.item.SKIPPED", "rewardLeg.mail.DONE",
  "rewardLeg.mail.FAILED", "rewardLeg.mail.SKIPPED", "rewardsDone", "rewardsFailed", "rewardRetries",
  "rewardDuplicates", "rewardMarkFailed", "scoresPruned",
  "commandReplies", "commandErrors", "hintRefused"]);
const SCORE_TITLES_LIMIT = 20;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;

class StepError extends Error {}

function must(r, what) {
  if (!r || r.ok !== true) throw new StepError(`${what}: ${(r && r.reason) || "no result"}`);
  return r;
}

const savepoints = new WeakMap();
function inSavepoint(tx, fn) {
  let run = savepoints.get(tx);
  if (!run) {
    run = tx.transaction((body) => body());
    savepoints.set(tx, run);
  }
  try {
    return { ok: true, value: run(fn) };
  } catch (err) {
    if (tx.inTransaction !== true) throw err;
    return { ok: false, error: err };
  }
}

function createFx() {
  const notes = new Map();
  return { notes, note(name, n = 1) {
    if (n > 0) notes.set(name, (notes.get(name) || 0) + n);
  }, lag: null, noCrisis: false, hookReason: null, flushed: null, rewardsPending: 0 };
}

function parseStepPayload(p) {
  if (!p || typeof p !== "object" || !isId(p.seasonNo) || typeof p.state !== "string"
    || !Number.isSafeInteger(p.stage) || p.stage < 0 || !Number.isSafeInteger(p.retries) || p.retries < 0) return null;
  return p;
}

function createSeasonService(deps) {
  const { store, journal, scheduler, worldSeed, registry, clock } = deps;
  const S = deps.settings;
  const repo = createSeasonRepository();
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const regionOf = (systemId) => {
    try {
      const r = typeof deps.regionOf === "function" ? deps.regionOf(systemId) : null;
      return isId(r) ? r : null;
    } catch (_err) {
      return null;
    }
  };
  const rowsCap = store && store.limits && isId(store.limits.maxRowsPerTransaction)
    ? store.limits.maxRowsPerTransaction : S.journalBatch;
  const pageLimit = Math.max(1, Math.min(S.journalBatch, rowsCap));

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let cache = null;
  let lastArchivedNo = null;
  let nextPlanAt = 0;
  let journalLag = 0;
  let lastRefusal = null;
  let lastHookRefusal = null;
  let state = "running";
  const scoring = createScoring({ getRow: () => cache, regionOf, settings: S, bump });
  const onRewardsPlanned = typeof deps.onRewardsPlanned === "function" ? deps.onRewardsPlanned : () => {};

  function bump(name, n = 1) {
    if (!Object.prototype.hasOwnProperty.call(counters, name) || n <= 0) return;
    counters[name] += n;
    if (telemetry && typeof telemetry.count === "function") {
      try {
        telemetry.count(`seasons.${name}`, n);
      } catch (_err) {
      }
    }
  }

  function observe(name, t0) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      if (name === "step") telemetry.observe("seasons.stepMs", Math.max(0, nowMs() - t0));
      else telemetry.observe("seasons.scoreMs", Math.max(0, nowMs() - t0));
    } catch (_err) {
    }
  }

  function applyFx(v, now) {
    if (!v || !v.fx) return;
    for (const [name, n] of v.fx.notes) bump(name, n);
    if (v.fx.hookReason) lastHookRefusal = v.fx.hookReason;
    if (v.fx.lag !== null) journalLag = v.fx.lag;
    if (v.fx.noCrisis) {
      nextPlanAt = now + S.planRetryMs;
      bump("noCrisis");
    }
    if (Object.prototype.hasOwnProperty.call(v, "row")) cache = v.row;
    if (isId(v.archivedNo)) lastArchivedNo = v.archivedNo;
    if (v.fx.flushed) scoring.ack(v.fx.flushed);
    if (v.fx.rewardsPending > 0) {
      try {
        onRewardsPlanned(v.fx.rewardsPending);
      } catch (_err) {
      }
    }
  }

  function journalOnce(tx, key, eventType, seasonNo, payload) {
    const r = journal.applyOnce(tx, { key, aggregate: { type: SC.AGGREGATE, id: seasonNo }, eventType, payload },
      () => ({ ok: true }));
    must(r, `journal ${key}`);
  }

  function enqueueStep(tx, row, chained, fx, keySuffix) {
    const dueAt = nextDueOf(row);
    if (dueAt === null) return;
    const payload = { seasonNo: row.seasonNo, state: row.state, stage: row.stage, retries: row.plannedRetries };
    const base = SC.keyOfStep(row.seasonNo, row.state, row.stage, row.plannedRetries) + (keySuffix || "");
    for (let n = 0; n <= S.stepRecoveryMax; n += 1) {
      const key = n === 0 ? base : SC.keyOfStepRecovery(base, n);
      const r = scheduler.enqueue(SC.EVENT_STEP, String(row.seasonNo), dueAt, payload, key,
        { tx, chained: chained === true });
      if (r && r.ok === false && r.reason === "IDEMPOTENCY_CONFLICT") return;
      must(r, "enqueue SEASON_STEP");
      if (r.duplicate !== true || !DEAD_STEP_STATES.includes(r.state)) {
        if (n > 0) fx.note("stepRecovered");
        return;
      }
    }
    fx.note("stepRecoveryExhausted");
  }

  function sctxOf(row, now, extra) {
    return Object.freeze({ seasonNo: row.seasonNo, crisis: row.crisis, seed: row.seed, now, key: `season:${row.seasonNo}`,
      ...(extra || {}) });
  }

  function hook(tx, kind, name, sctx, fx) {
    if (!kind) {
      fx.note("crisisHook.KIND_GONE");
      return;
    }
    if (typeof kind[name] !== "function") return;
    let refusal = null;
    const r = inSavepoint(tx, () => {
      const out = kind[name](tx, sctx);
      if (!out || out.ok !== true) {
        refusal = String((out && out.reason) || "REFUSED").slice(0, 32);
        throw HOOK_REFUSED;
      }
      return out;
    });
    if (r.ok) return;
    if (r.error === HOOK_REFUSED) {
      fx.note("crisisHook.REFUSED");
      fx.hookReason = `${kind.kind}.${name}:${refusal}`;
    } else {
      fx.note("crisisHook.THREW");
      fx.hookReason = `${kind.kind}.${name}:${messageOf(r.error)}`;
    }
  }

  function cleanCrisis(r) {
    if (!r || r.ok !== true || !r.crisis || typeof r.crisis !== "object") return null;
    const c = r.crisis;
    const factionId = c.factionId === null || c.factionId === undefined ? null : c.factionId;
    if (factionId !== null && !isId(factionId)) return null;
    const regionIds = Array.isArray(c.regionIds) ? c.regionIds : null;
    if (!regionIds || regionIds.length > S.maxCrisisRegions || !regionIds.every(isId)
      || new Set(regionIds).size !== regionIds.length) return null;
    const params = c.params === undefined ? {} : c.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return null;
    let paramsJson;
    try {
      paramsJson = JSON.stringify(params);
    } catch (_err) {
      return null;
    }
    if (paramsJson.length > SC.MAX_PARAMS_JSON) return null;
    const crisis = { factionId, regionIds: [...regionIds], params: JSON.parse(paramsJson) };
    if (JSON.stringify(crisis).length > SC.MAX_CRISIS_JSON) return null;
    return crisis;
  }

  function chooseCrisis(tx, q) {
    let pool = registry.list().map((l) => registry.get(l.kind)).filter(Boolean)
      .map((k) => ({ id: k.kind, weight: k.weight, k }));
    const rng = createRng(deriveSeed(q.seed, "kind"));
    while (pool.length > 0) {
      const picked = weightedPick(pool, rng);
      if (!picked) break;
      pool = pool.filter((it) => it !== picked);
      let r = null;
      try {
        r = picked.k.propose(tx, q);
      } catch (_err) {
        r = null;
      }
      const crisis = cleanCrisis(r);
      if (crisis) return { ok: true, kind: picked.k, crisis };
    }
    return { ok: false, reason: "NO_CRISIS" };
  }

  function lastOf(row) {
    return row ? { kind: row.crisisKind, factionId: row.crisis.factionId } : null;
  }

  function crisisHoldsInTx(tx, row) {
    if (!registry.get(row.crisisKind)) return false;
    const f = row.crisis.factionId;
    if (f === null) return true;
    const r = tx.prepare("SELECT status FROM world_factions WHERE faction_id = ?").get(f);
    return Boolean(r && r.status === "ACTIVE");
  }

  function planNextInTx(tx, now, fx) {
    const open = must(repo.getOpenInTx(tx), "getOpen");
    if (open.row) return { planned: false, row: open.row };
    const last = must(repo.getLastInTx(tx), "getLast").row;
    const seasonNo = last ? last.seasonNo + 1 : 1;
    const seed = deriveSeed(worldSeed, SC.RNG_STREAM, seasonNo) >>> 0;
    const chosen = chooseCrisis(tx, { seasonNo, seed, now, last: lastOf(last) });
    if (!chosen.ok) {
      fx.noCrisis = true;
      return { planned: false, row: null };
    }
    const startsAt = last ? Math.max(last.endsAt + S.breakMs, now) : now + S.firstStartDelayMs;
    const plan = planSeason({ now: startsAt, durationMs: S.durationMs, stageCount: S.stageCount, startDelayMs: 0 });
    const ins = must(repo.insertPlannedInTx(tx, { seasonNo, crisisKind: chosen.kind.kind,
      crisisOwner: chosen.kind.owner, crisisVersion: chosen.kind.version, crisis: chosen.crisis, seed,
      startsAt: plan.startsAt, endsAt: plan.endsAt, stageCount: plan.stageCount, stageDueAt: plan.stageDueAt, now }),
    "insertPlanned");
    enqueueStep(tx, ins.row, true, fx);
    fx.note("planned");
    return { planned: true, row: ins.row };
  }

  function deferStart(tx, row, newStart, now, fx) {
    const shift = newStart - row.startsAt;
    const up = must(repo.updateInTx(tx, row.seasonNo, row.version, { startsAt: newStart, endsAt: row.endsAt + shift,
      stageDueAt: row.stageDueAt + shift, plannedRetries: row.plannedRetries + 1, now }), "defer");
    enqueueStep(tx, up.row, true, fx);
    fx.note("startDeferred");
    return up.row;
  }

  function startInTx(tx, row, now, fx) {
    if (now >= row.endsAt) return deferStart(tx, row, now + S.firstStartDelayMs, now, fx);
    let kind = registry.get(row.crisisKind);
    let crisisPatch = {};
    let crisis = row.crisis;
    if (!crisisHoldsInTx(tx, row)) {
      const seed = deriveSeed(row.seed, "repick", row.plannedRetries) >>> 0;
      const prev = row.seasonNo > 1 ? must(repo.getInTx(tx, row.seasonNo - 1), "getPrev").row : null;
      const chosen = chooseCrisis(tx, { seasonNo: row.seasonNo, seed, now, last: lastOf(prev) });
      if (!chosen.ok) return deferStart(tx, row, now + S.planRetryMs, now, fx);
      kind = chosen.kind;
      crisis = chosen.crisis;
      crisisPatch = { crisisKind: kind.kind, crisisOwner: kind.owner, crisisVersion: kind.version, crisis };
      fx.note("crisisRepicked");
    }
    const head = must(journal.headId(tx), "headId").headId;
    const st = stageAt(row, now);
    const next = st.final ? STATE.FINALE : STATE.ACTIVE;
    const up = must(repo.updateInTx(tx, row.seasonNo, row.version, { ...crisisPatch, state: next, stage: st.stage,
      stageDueAt: st.nextAt, journalCursor: head, payoutCursorAt: row.startsAt, payoutCursorKey: "", now }), "start");
    const r = up.row;
    journalOnce(tx, SC.keyOfStart(r.seasonNo), SC.JOURNAL.STARTED, r.seasonNo, { seasonNo: r.seasonNo,
      crisisKind: r.crisisKind, factionId: crisis.factionId, regionIds: crisis.regionIds, stage: r.stage,
      stageCount: r.stageCount,
      startsAt: r.startsAt, endsAt: r.endsAt });
    hook(tx, kind, "startInTx", sctxOf(r, now), fx);
    if (st.final) {
      journalOnce(tx, SC.keyOfFinale(r.seasonNo), SC.JOURNAL.FINALE, r.seasonNo, { seasonNo: r.seasonNo,
        stage: r.stage, stageCount: r.stageCount, factionId: crisis.factionId });
      fx.note("finale");
    }
    enqueueStep(tx, r, true, fx);
    fx.note("started");
    return r;
  }

  function advanceInTx(tx, row, now, fx) {
    const st = stageAt(row, now);
    const kind = registry.get(row.crisisKind);
    const skipped = Math.max(0, st.stage - row.stage - 1);
    if (st.final) {
      const up = must(repo.updateInTx(tx, row.seasonNo, row.version, { state: STATE.FINALE, stage: st.stage,
        stageDueAt: row.endsAt, now }), "finale");
      journalOnce(tx, SC.keyOfFinale(row.seasonNo), SC.JOURNAL.FINALE, row.seasonNo, { seasonNo: row.seasonNo,
        stage: st.stage, stageCount: row.stageCount, factionId: row.crisis.factionId });
      fx.note("finale");
      fx.note("stageSkipped", skipped);
      enqueueStep(tx, up.row, true, fx);
      return up.row;
    }
    if (st.stage <= row.stage) {
      const up = must(repo.updateInTx(tx, row.seasonNo, row.version, { stageDueAt: st.nextAt, now }), "due");
      enqueueStep(tx, up.row, true, fx, `:d${st.nextAt}`);
      return up.row;
    }
    const up = must(repo.updateInTx(tx, row.seasonNo, row.version, { stage: st.stage, stageDueAt: st.nextAt, now }),
      "stage");
    journalOnce(tx, SC.keyOfStage(row.seasonNo, st.stage), SC.JOURNAL.STAGE, row.seasonNo, { seasonNo: row.seasonNo,
      stage: st.stage, stageCount: row.stageCount, skipped, factionId: row.crisis.factionId });
    hook(tx, kind, "stageInTx", sctxOf(up.row, now, { stage: st.stage }), fx);
    fx.note("stage");
    fx.note("stageSkipped", skipped);
    enqueueStep(tx, up.row, true, fx);
    return up.row;
  }

  function meterPagesInTx(tx, row, maxPages, fx) {
    const head = must(journal.headId(tx), "headId").headId;
    let cursor = Math.min(row.journalCursor, head);
    let m = { meterDefense: row.meterDefense, meterCrisis: row.meterCrisis };
    const kind = registry.get(row.crisisKind);
    if (!kind || kind.journalAggregates.length === 0) {
      if (!kind && cursor < head) fx.note("kindGone");
      return { ...m, cursor: Math.max(cursor, head), head };
    }
    for (let page = 0; page < maxPages && cursor < head; page += 1) {
      const r = must(journal.listAfter(tx, { afterId: cursor, uptoId: head, aggregateTypes: [...kind.journalAggregates],
        limit: pageLimit }), "listAfter");
      let delta = null;
      try {
        let refs = new Map();
        if (typeof kind.refKeysOf === "function" && typeof kind.readRefsInTx === "function") {
          const keys = kind.refKeysOf(r.entries);
          if (Array.isArray(keys) && keys.length > 0) refs = kind.readRefsInTx(tx, keys.slice(0, pageLimit));
        }
        delta = kind.scoreEntries(r.entries, { crisis: row.crisis, refs: refs instanceof Map ? refs : new Map(),
          regionOf });
      } catch (_err) {
        delta = null;
        fx.note("crisisHook.SCORE_THREW");
      }
      if (delta && typeof delta === "object") m = applyDeltas(m, delta);
      cursor = Math.max(cursor, r.scannedUpTo);
    }
    return { ...m, cursor, head };
  }

  function flushInTx(tx, row, fx) {
    const out = { defense: 0, patch: {} };
    const peeked = scoring.peekForFlush(S.flushMaxRows);
    fx.flushed = peeked;
    const byChar = new Map();
    const add = (characterId, points, kills, defenses, lastAt) => {
      const e = byChar.get(characterId);
      if (!e) byChar.set(characterId, { characterId, points, kills, defenses, lastAt });
      else {
        e.points = Math.min(Number.MAX_SAFE_INTEGER, e.points + points);
        e.kills += kills;
        e.defenses += defenses;
        e.lastAt = Math.max(e.lastAt, lastAt);
      }
      out.defense = Math.min(Number.MAX_SAFE_INTEGER, out.defense + points);
    };
    for (const e of peeked) {
      if (e.seasonNo !== row.seasonNo) fx.note("killsDropped.CLOSED");
      else add(e.characterId, e.points, e.kills, 0, e.lastAt);
    }
    if (S.heavyDefensePoints > 0) {
      const h = must(repo.listHeavyPayoutsAfterInTx(tx, row.payoutCursorAt, row.payoutCursorKey, row.endsAt,
        S.payoutBatch), "heavyPayouts");
      if (h.rows.length > 0) {
        const last = h.rows[h.rows.length - 1];
        out.patch = { payoutCursorAt: last.plannedAt, payoutCursorKey: last.payoutKey };
        const regions = new Set(row.crisis.regionIds);
        for (const p of h.rows) {
          if (p.plannedAt < row.startsAt || !isId(p.characterId)) continue;
          if (regions.size > 0 && !regions.has(regionOf(p.systemId))) continue;
          add(p.characterId, S.heavyDefensePoints, 0, 1, p.plannedAt);
          fx.note("heavyDefenses");
        }
      }
    }
    if (byChar.size > 0) {
      const u = must(repo.upsertScoresInTx(tx, row.seasonNo, [...byChar.values()], S.maxScoreRowsPerSeason), "scores");
      fx.note("scoreRowCapped", u.capped);
    }
    return out;
  }

  function rewardsInTx(tx, row, outcome, now, fx) {
    const listed = must(repo.listRankedInTx(tx, row.seasonNo, S.maxRankedPlayers), "ranked");
    const plan = planRewards(rankRows(listed.rows), outcome, S);
    if (plan.rewards.length === 0) return;
    const ins = must(repo.insertRewardsInTx(tx, plan.rewards, { seasonNo: row.seasonNo, outcome,
      mailEnabled: S.mailEnabled, now }), "rewards");
    fx.note("rewardsPlanned", ins.inserted);
    if (plan.scaled) fx.note("iskScaled");
    fx.rewardsPending += ins.pending;
  }

  function closeInTx(tx, row, now, fx) {
    const kind = registry.get(row.crisisKind);
    const page = meterPagesInTx(tx, row, 1, fx);
    if (page.cursor < page.head) fx.note("closeLagDropped");
    const flushed = flushInTx(tx, row, fx);
    const m = { ...page, ...applyDeltas(page, { defense: flushed.defense }) };
    const outcome = outcomeOf(m.meterDefense, m.meterCrisis, S.winRatioPermille);
    hook(tx, kind, "endInTx", sctxOf(row, now, { outcome }), fx);
    must(repo.updateInTx(tx, row.seasonNo, row.version, { state: STATE.ARCHIVED, outcome,
      closeReason: SC.CLOSE_REASON.FINISHED, closedAt: now, meterDefense: m.meterDefense, meterCrisis: m.meterCrisis,
      journalCursor: m.cursor, ...flushed.patch, now }), "close");
    rewardsInTx(tx, row, outcome, now, fx);
    journalOnce(tx, SC.keyOfEnd(row.seasonNo), SC.JOURNAL.ENDED, row.seasonNo, { seasonNo: row.seasonNo,
      factionId: row.crisis.factionId, outcome, defense: m.meterDefense, crisis: m.meterCrisis });
    fx.note(`closed.${outcome}`);
    fx.lag = 0;
    return planNextInTx(tx, now, fx).row;
  }

  function stepEffect(tx, seen, now) {
    const fx = createFx();
    const cur = must(repo.getOpenInTx(tx), "getOpen").row;
    if (!cur || cur.seasonNo !== seen.seasonNo || cur.version !== seen.version) {
      return { ok: false, reason: "VERSION_CONFLICT" };
    }
    let row;
    let archivedNo = null;
    if (cur.state === STATE.PLANNED) row = startInTx(tx, cur, now, fx);
    else if (cur.state === STATE.FINALE || now >= cur.endsAt) {
      row = closeInTx(tx, cur, now, fx);
      archivedNo = cur.seasonNo;
    } else row = advanceInTx(tx, cur, now, fx);
    fx.note("steps");
    return { ok: true, fx, row, archivedNo };
  }

  function readOpen(name) {
    const t = store.transaction(name, (tx) => repo.getOpenInTx(tx));
    if (!t || !t.ok) return { ok: false, reason: (t && t.reason) || "TX_FAILED" };
    if (!t.value || t.value.ok !== true) return { ok: false, reason: (t.value && t.value.reason) || "READ_FAILED" };
    return { ok: true, row: t.value.row };
  }

  function onStep(ev, hctx) {
    try {
      const p = parseStepPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "SEASON_PAYLOAD_INVALID", permanent: true };
      if (state !== "running") return { ok: false, reason: "SEASONS_STOPPED" };
      const now = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const read = readOpen("seasons.stepRead");
      if (!read.ok) return { ok: false, reason: `SEASON_READ_FAILED: ${read.reason}` };
      const row = read.row;
      if (!row || row.seasonNo !== p.seasonNo || row.state !== p.state || row.stage !== p.stage
        || row.plannedRetries !== p.retries) {
        return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      }
      if (SC.DEFERRED_STATES.includes(row.state)) {
        return { ok: true, outcome: "STATE_DEFERRED", onCommitted: () => bump("stateDeferred") };
      }
      const due = nextDueOf(row);
      if (due === null) return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      if (now < due) return { ok: false, reason: "SEASON_NOT_DUE", deferUntil: due };
      const t0 = nowMs();
      return { ok: true, outcome: `STEP_${row.state}`,
        effect: (tx) => {
          try {
            return stepEffect(tx, row, now);
          } catch (err) {
            if (err instanceof StepError) return { ok: false, reason: messageOf(err) };
            throw err;
          }
        },
        onCommitted: (v) => {
          applyFx(v, now);
          observe("step", t0);
        } };
    } catch (err) {
      bump("stepFailed");
      lastRefusal = `SEASON_STEP: ${messageOf(err)}`;
      return { ok: false, reason: `SEASON_STEP_FAILED: ${messageOf(err)}` };
    }
  }

  const bucketOf = (t) => Math.floor(t / S.scoreIntervalMs);

  function scoreEffect(tx, now) {
    const fx = createFx();
    let row = must(repo.getOpenInTx(tx), "getOpen").row;
    if (!row) {
      fx.flushed = scoring.peekForFlush(S.flushMaxRows);
      fx.note("killsDropped.CLOSED", fx.flushed.length);
      if (now < nextPlanAt) return { ok: true, fx, row: null };
      return { ok: true, fx, row: planNextInTx(tx, now, fx).row };
    }
    if (row.state === STATE.ACTIVE || row.state === STATE.FINALE) {
      const page = meterPagesInTx(tx, row, S.journalPagesPerPass, fx);
      const flushed = flushInTx(tx, row, fx);
      const m = { ...page, ...applyDeltas(page, { defense: flushed.defense }) };
      if (m.cursor !== row.journalCursor || m.meterDefense !== row.meterDefense || m.meterCrisis !== row.meterCrisis
        || Object.keys(flushed.patch).length > 0) {
        row = must(repo.updateInTx(tx, row.seasonNo, row.version, { meterDefense: m.meterDefense,
          meterCrisis: m.meterCrisis, journalCursor: m.cursor, ...flushed.patch, now }), "meter").row;
      }
      fx.lag = Math.max(0, m.head - m.cursor);
    } else {
      fx.flushed = scoring.peekForFlush(S.flushMaxRows);
      fx.note("killsDropped.CLOSED", fx.flushed.length);
    }
    fx.note("scorePasses");
    return { ok: true, fx, row };
  }

  function onScore(ev, hctx) {
    try {
      const p = ev && ev.payload;
      if (!p || typeof p !== "object" || !Number.isSafeInteger(p.bucket) || p.bucket < 0) {
        return { ok: false, reason: "SEASON_PAYLOAD_INVALID", permanent: true };
      }
      if (state !== "running") return { ok: false, reason: "SEASONS_STOPPED" };
      const now = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const next = Math.max(p.bucket, bucketOf(at)) + 1;
      const t0 = nowMs();
      return { ok: true, outcome: "SCORED",
        reschedule: { eventType: SC.EVENT_SCORE, aggregateId: SC.SCORE_AGGREGATE_ID, dueAt: next * S.scoreIntervalMs,
          payload: { bucket: next }, idempotencyKey: SC.keyOfScore(next) },
        effect: (tx) => {
          try {
            return scoreEffect(tx, now);
          } catch (err) {
            if (err instanceof StepError) return { ok: false, reason: messageOf(err) };
            throw err;
          }
        },
        onCommitted: (v) => {
          applyFx(v, now);
          observe("score", t0);
        } };
    } catch (err) {
      bump("scoreFailed");
      lastRefusal = `SEASON_SCORE: ${messageOf(err)}`;
      return { ok: false, reason: `SEASON_SCORE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      const now = clock.now();
      const fx = createFx();
      const t = store.transaction("seasons.bootstrap", (tx) => {
        const open = must(repo.getOpenInTx(tx), "getOpen").row;
        let row = open;
        if (open && nextDueOf(open) !== null) enqueueStep(tx, open, false, fx);
        else if (!open) row = planNextInTx(tx, now, fx).row;
        const archived = must(repo.getLastArchivedNoInTx(tx), "lastArchived").seasonNo;
        const bucket = bucketOf(now) + 1;
        const r = scheduler.enqueue(SC.EVENT_SCORE, SC.SCORE_AGGREGATE_ID, bucket * S.scoreIntervalMs, { bucket },
          SC.keyOfScore(bucket), { tx });
        if (!(r && r.ok === false && r.reason === "IDEMPOTENCY_CONFLICT")) must(r, "enqueue SEASON_SCORE");
        return { row, archived };
      });
      if (!t || !t.ok) {
        const why = t && t.error instanceof StepError ? messageOf(t.error) : (t && t.reason) || "TX_FAILED";
        lastRefusal = `bootstrap: ${why}`;
        return { ok: false, reason: why };
      }
      applyFx({ fx, row: t.value.row, archivedNo: t.value.archived }, now);
      return { ok: true, row: cache };
    } catch (err) {
      lastRefusal = `bootstrap: ${messageOf(err)}`;
      return { ok: false, reason: `SEASON_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function seasonOf(row) {
    if (!row) return null;
    return Object.freeze({ seasonNo: row.seasonNo, state: row.state, crisisKind: row.crisisKind,
      factionId: row.crisis.factionId, regionIds: Object.freeze([...row.crisis.regionIds]), stage: row.stage,
      stageCount: row.stageCount, stageDueAt: row.stageDueAt, startsAt: row.startsAt, endsAt: row.endsAt,
      meterDefense: row.meterDefense, meterCrisis: row.meterCrisis });
  }

  function current() {
    return { ok: true, season: seasonOf(cache) };
  }

  function currentSeasonKey() {
    if (cache && (cache.state === STATE.ACTIVE || cache.state === STATE.FINALE)) return SC.seasonKeyOf(cache.seasonNo);
    return isId(lastArchivedNo) ? SC.seasonKeyOf(lastArchivedNo) : null;
  }

  function getStatus() {
    return Object.freeze({ state, reason: lastRefusal, counters: Object.freeze({ ...counters }),
      season: seasonOf(cache), journalLag, nextPlanAt, lastHookRefusal });
  }

  function stop() {
    state = "stopped";
  }

  function onNpcKill(kill) {
    if (state !== "running") return { ok: false, reason: "NO_SEASON" };
    try {
      return scoring.onNpcKill(kill);
    } catch (_err) {
      return { ok: false, reason: "INVALID_KILL" };
    }
  }

  function scoreOf(characterId) {
    if (!isId(characterId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const seasonNo = cache ? cache.seasonNo : null;
      const t = store.transaction("seasons.scoreOf",
        (tx) => repo.scoreOfInTx(tx, seasonNo, characterId, SCORE_TITLES_LIMIT));
      if (!t || !t.ok || !t.value || t.value.ok !== true) return { ok: false, reason: "READ_FAILED" };
      return { ok: true, seasonNo, points: t.value.points, rank: t.value.rank, titles: t.value.titles };
    } catch (_err) {
      return { ok: false, reason: "READ_FAILED" };
    }
  }

  return Object.freeze({ onStep, onScore, bootstrap, current, currentSeasonKey, getStatus, stop, onNpcKill, scoreOf,
    bump, isStopped: () => state !== "running", pendingKills: () => scoring.size() });
}

module.exports = { createSeasonService, COUNTER_NAMES };
