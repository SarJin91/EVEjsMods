"use strict";

const SC = require("./schema");
const { createGameMasterRepository } = require("./repository");
const { cycleAtOrBefore, cycleMsOf, threadIdOf, stepKeyOf } = require("./cycle");
const { buildOffer } = require("./digest");
const { validateProposal } = require("./validate");
const { templateProposal } = require("./fallback");
const { nextThreadAction } = require("./machine");
const { sampleActivityInTx } = require("./activity");
const { threadRowsOf } = require("./boardRows");
const { readHints, factsOf, buildPlotPrompt, plotSpecOf } = require("./ai");
const { createAbortSentinel } = require("../persistence/store");
const { deriveSeed } = require("../util/rng");

const ABORT_DUPLICATE = createAbortSentinel("gameMaster.DUPLICATE");
const ABORT_ACTIVITY = createAbortSentinel("gameMaster.ACTIVITY");
const RECENT_LIMIT = 64;
const MAX_DETAIL = 120;
const FACT_OVERSAMPLE = 4;
const RECENT_FACTS_CAP = 256;
const CODE_RE = /^[A-Z0-9_]{1,40}$/;
const { STATE_CYCLE, STATE_THREAD, STEP_STATE, STEP_RESULT, OUTCOME, REASON, SOURCES, AI_REFUSALS,
  AI_PERMANENT_REFUSALS } = SC;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function safeCall(fn, fallback = null) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
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

function stepCtxOf(row, step, now) {
  return Object.freeze({ threadId: row.threadId, stepNo: row.stepNo, stepKey: stepKeyOf(row.threadId, row.stepNo),
    params: step ? step.params : {}, handle: row.stepHandle, factionId: row.factionId, systemId: row.anchorSystemId,
    now, seed: row.seed });
}

function payloadOf(row, extra) {
  return { threadId: row.threadId, arc: row.arc, factionId: row.factionId, systemId: row.anchorSystemId,
    source: row.source, ...(extra || {}) };
}

function journalSpec(key, row, eventType, extra) {
  return { key, aggregate: { type: SC.AGGREGATE, id: row.threadId }, eventType, payload: payloadOf(row, extra) };
}

function drainGameMaster(deps) {
  const { store, journal, registry, now, limit } = deps;
  const repo = deps.repository || createGameMasterRepository();
  const r = store.transaction("gameMaster.drain", (tx) => {
    if (!repo.hasActiveThreadInTx(tx)) return { drained: 0, more: false };
    const list = repo.listActiveThreadsInTx(tx, { limit: limit + 1 });
    if (!list.ok) throw new Error(`drain list ${list.reason}`);
    let drained = 0;
    for (const row of list.rows.slice(0, limit)) {
      const step = row.plan && Array.isArray(row.plan.steps) ? row.plan.steps[row.stepNo] : null;
      const kind = step && row.stepState === STEP_STATE.RUNNING ? registry.get(step.kind) : null;
      if (kind) inSavepoint(tx, () => kind.cancelInTx(tx, stepCtxOf(row, step, now), REASON.DISABLED));
      const u = repo.updateThreadInTx(tx, { threadId: row.threadId, version: row.version,
        patch: { state: STATE_THREAD.CANCELLED, endedAt: now }, now });
      if (!u.ok) throw new Error(`drain update ${u.reason}`);
      if (!u.changed) continue;
      const j = journal.applyOnce(tx, journalSpec(`gm:end:${row.threadId}`, row, SC.EVENT_ENDED, { outcome: null }),
        () => ({ ok: true }));
      if (!j || j.ok !== true) throw new Error(`drain journal ${(j && j.reason) || "no result"}`);
      drained += 1;
    }
    return { drained, more: list.rows.length > limit };
  });
  if (!r || r.ok !== true) {
    return { ok: false, reason: String((r && r.reason) || "NO_RESULT"), detail: r && r.error ? messageOf(r.error)
      : undefined };
  }
  return { ok: true, drained: r.value.drained, more: r.value.more };
}

function createGameMasterService(deps) {
  const { store, journal, worldSeed, settings: S, registry, sender } = deps;
  const getChatterAi = typeof deps.getChatterAi === "function" ? deps.getChatterAi : () => null;
  const getNews = typeof deps.getNews === "function" ? deps.getNews : () => null;
  const fieldS = deps.fieldSettings && typeof deps.fieldSettings === "object" ? deps.fieldSettings : null;
  const clockNow = typeof deps.clockNow === "function" ? deps.clockNow : null;
  const repo = deps.repository || createGameMasterRepository();
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const readFactionNames = typeof deps.readFactionNames === "function" ? deps.readFactionNames
    : () => ({ ok: false, reason: "NO_READER" });
  const counters = Object.fromEntries(SC.COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let passes = 0;
  let last = null;
  let open = 0;
  let aiFlight = null;
  let aiHold = null;
  let aiLast = null;

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
    metric("count", `gameMaster.${name}`, n);
  }

  function admits(workClass) {
    const governor = safeCall(getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    return safeCall(() => governor.admits(workClass) !== false, true);
  }

  function graphNow() {
    const g = safeCall(getGraph);
    return g && typeof g.getSystem === "function" && typeof g.getSystemsBySecClass === "function" ? g : null;
  }

  function factionNamesNow() {
    const r = safeCall(readFactionNames);
    return r && r.ok === true && r.names instanceof Map ? r.names : new Map();
  }

  function skipInTx(tx, cycleAt, reason, now) {
    const u = repo.updateCycleInTx(tx, { cycleAt, fromState: STATE_CYCLE.DRAFTING, toState: STATE_CYCLE.SKIPPED,
      reason, now });
    if (!u.ok) throw new Error(`cycle skip ${u.reason} ${u.detail || ""}`.trim());
    return { code: "SKIPPED", reason };
  }

  function noteCycleInTx(tx, cycleAt, reason, now) {
    const u = repo.updateCycleInTx(tx, { cycleAt, fromState: STATE_CYCLE.DRAFTING, toState: STATE_CYCLE.DRAFTING,
      reason, now });
    if (!u.ok) throw new Error(`cycle note ${u.reason} ${u.detail || ""}`.trim());
  }

  function offerInTx(tx, cycleAt, seed, graph, names, extra) {
    const cycleMs = cycleMsOf(S);
    const sums = new Map();
    for (const bucketAt of [cycleAt, cycleAt - cycleMs]) {
      if (bucketAt < 0) continue;
      const a = repo.readActivityInTx(tx, { bucketAt, limit: S.maxActivityRegions });
      if (!a.ok) throw new Error(`activity read ${a.reason}`);
      for (const row of a.rows) sums.set(row.regionId, (sums.get(row.regionId) || 0) + row.samples);
    }
    const activityRows = [...sums.entries()].map(([regionId, samples]) => ({ regionId, samples }));
    const cooldown = Math.max(S.arcCooldownCycles, S.systemCooldownCycles);
    const recent = repo.listRecentThreadsInTx(tx, { sinceCycleAt: cycleAt - cooldown * cycleMs, limit: RECENT_LIMIT });
    if (!recent.ok) throw new Error(`recent read ${recent.reason}`);
    return buildOffer({ cycleAt, seed, graph, factionNames: names, activityRows, recentThreads: recent.rows, registry,
      S, ...(extra || {}) });
  }

  function draftInTx(tx, cycleRow, proposalRaw, source, ctx) {
    const { offer, seed, now } = ctx;
    const cycleAt = cycleRow.cycleAt;
    const v = validateProposal(proposalRaw, offer, registry, S, source, fieldS);
    let plan = v.ok ? v.plan : null;
    let reason = v.ok ? null : String(v.reason);
    const planJson = plan ? JSON.stringify(plan) : null;
    if (plan && Buffer.byteLength(planJson, "utf8") > S.maxPlanBytes) {
      plan = null;
      reason = "TOO_LARGE";
    }
    if (!plan) {
      if (ctx.keepOnReject === true) noteCycleInTx(tx, cycleAt, reason, now);
      else skipInTx(tx, cycleAt, reason, now);
      return { code: "REJECTED", reason, rule: reason.split(":")[0], source };
    }
    const threadId = threadIdOf(cycleAt);
    const row = { threadId, cycleAt, arc: plan.arc, source, factionId: plan.factionId,
      actorFactionId: plan.actorFactionId, anchorSystemId: plan.systemId, planJson, stepDueAt: now,
      deadlineAt: now + S.maxThreadMs, seed, now };
    const ins = repo.insertThreadInTx(tx, row);
    if (!ins.ok && ins.reason === "DUPLICATE") throw ABORT_DUPLICATE;
    if (!ins.ok) throw new Error(`thread insert ${ins.reason} ${ins.detail || ""}`.trim());
    const cas = repo.updateCycleInTx(tx, { cycleAt, fromState: STATE_CYCLE.DRAFTING, toState: STATE_CYCLE.STARTED,
      source, threadId, now });
    if (!cas.ok) throw new Error(`cycle start ${cas.reason}`);
    if (!cas.changed) throw ABORT_DUPLICATE;
    const j = journal.applyOnce(tx, journalSpec(`gm:start:${threadId}`, { threadId, arc: plan.arc,
      factionId: plan.factionId, anchorSystemId: plan.systemId, source }, SC.EVENT_STARTED),
    (db) => sender.sendInTx(db, { eventKey: `gm:${threadId}:hook`, systemId: plan.systemId, line: plan.hook, now }));
    if (!j || j.ok !== true) throw new Error(`journal start ${(j && j.reason) || "no result"}`);
    return { code: "STARTED", threadId, arc: plan.arc, steps: plan.steps.length,
      notified: j.value && Number.isSafeInteger(j.value.n) ? j.value.n : 0, textFallback: plan.textFallback };
  }

  function cycleStep(now) {
    const c = cycleAtOrBefore(now, S);
    if (now < c + S.settleDelayMs) return;
    const a = store.transaction("gameMaster.cycle", (tx) => {
      const ins = repo.insertCycleInTx(tx, { cycleAt: c, now });
      if (!ins.ok) throw new Error(`cycle insert ${ins.reason}`);
      if (ins.inserted && repo.countActiveThreadsInTx(tx) >= S.maxOpenThreads) {
        const skipped = skipInTx(tx, c, REASON.OPEN_LIMIT, now);
        return { created: true, openLimit: skipped.code === "SKIPPED", row: repo.readCycleInTx(tx, c) };
      }
      return { created: ins.inserted, openLimit: false, row: repo.readCycleInTx(tx, c) };
    });
    if (!a || a.ok !== true) {
      bump("errors");
      logger.log(`gameMaster: cycle ${c} failed - ${(a && a.reason) || "no result"}`);
      return;
    }
    if (a.value.created) bump("cycles");
    if (a.value.openLimit) bump("skipped.OPEN_LIMIT");
    const cycleRow = a.value.row;
    if (!cycleRow || cycleRow.state !== STATE_CYCLE.DRAFTING) return;
    if (S.aiEnabled === true && aiStep(cycleRow, now)) return;
    let graph = null;
    let names = null;
    if (S.templateFallback === true) {
      graph = graphNow();
      if (!graph) {
        bump("skipped.NO_GRAPH");
        return;
      }
      names = factionNamesNow();
    }
    const b = store.transaction("gameMaster.draft", (tx) => {
      const cur = repo.readCycleInTx(tx, c);
      if (!cur || cur.state !== STATE_CYCLE.DRAFTING) throw ABORT_DUPLICATE;
      if (S.templateFallback !== true) return skipInTx(tx, c, REASON.FALLBACK_OFF, now);
      const seed = deriveSeed(worldSeed, "gm", c);
      const offered = offerInTx(tx, c, seed, graph, names);
      if (!offered.ok) return skipInTx(tx, c, offered.reason, now);
      const proposal = templateProposal(offered.offer, seed, S);
      if (!proposal.ok) return skipInTx(tx, c, REASON.NO_TEMPLATE, now);
      return draftInTx(tx, cur, proposal.raw, SOURCES.TEMPLATE, { offer: offered.offer, seed, now });
    });
    if (!b || b.ok !== true) {
      if (b && b.error === ABORT_DUPLICATE) {
        bump("skipped.DUPLICATE");
        return;
      }
      bump("errors");
      logger.log(`gameMaster: draft ${c} failed - ${(b && b.reason) || "no result"}`
        + `${b && b.error ? ` ${messageOf(b.error)}` : ""}`);
      return;
    }
    const v = b.value;
    if (v.code === "SKIPPED") {
      bump(`skipped.${v.reason}`);
      return;
    }
    bump("drafted");
    if (v.code === "REJECTED") {
      bump(`rejected.${v.rule}`);
      bump("skipped.REJECTED");
      if (v.source === SOURCES.TEMPLATE) {
        bump("errors");
        logger.log(`gameMaster: template proposal refused ${v.reason} (cycle ${c})`);
      }
      return;
    }
    bump(`threads.started.${SOURCES.TEMPLATE}`);
    for (const field of v.textFallback) bump(`textFallback.${field}`);
    logger.log(`gameMaster: thread ${v.threadId} started arc=${v.arc} source=template steps=${v.steps}`
      + ` notified=${v.notified}`);
  }

  function refusalCodeOf(reason) {
    const code = typeof reason === "string" ? reason : "";
    return AI_REFUSALS.includes(code) ? code : "OTHER";
  }

  function noteRefusal(cycleAt, code, now) {
    bump(`ai.refused.${code}`);
    aiLast = `REFUSED:${code}`;
    if (AI_PERMANENT_REFUSALS.includes(code)) aiHold = { cycleAt, until: Infinity };
    else if (code !== "ABORTED") aiHold = { cycleAt, until: now + S.aiRetryMs };
  }

  function recentFactsNow(since) {
    const news = safeCall(getNews);
    if (!news || typeof news.listRecentFacts !== "function") return [];
    const limit = Math.min(RECENT_FACTS_CAP, Math.max(1, S.maxFacts * FACT_OVERSAMPLE));
    const r = safeCall(() => news.listRecentFacts({ since: Math.max(0, since), limit }));
    return r && r.ok === true && Array.isArray(r.facts) ? r.facts : [];
  }

  function aiStep(cycleRow, now) {
    const c = cycleRow.cycleAt;
    if (aiFlight) return true;
    if (cycleRow.attempts >= S.aiAttemptsPerCycle || now >= c + S.draftWindowMs) return false;
    if (aiHold && aiHold.cycleAt === c) {
      if (aiHold.until === Infinity) return false;
      if (now < aiHold.until) return true;
    }
    if (cycleRow.attempts > 0 && now < cycleRow.updatedAt + S.aiRetryMs) return true;
    return askAi(c, now);
  }

  function askAi(c, now) {
    const chatter = safeCall(getChatterAi);
    if (!chatter || typeof chatter.complete !== "function") {
      noteRefusal(c, "OFF", now);
      return false;
    }
    const graph = graphNow();
    if (!graph) {
      bump("skipped.NO_GRAPH");
      return true;
    }
    const names = factionNamesNow();
    const facts = factsOf(recentFactsNow(c - S.factWindowCycles * cycleMsOf(S)), S);
    const hints = readHints(registry);
    const seed = deriveSeed(worldSeed, "gm", c);
    const o = store.transaction("gameMaster.offer", (tx) => {
      const cur = repo.readCycleInTx(tx, c);
      if (!cur || cur.state !== STATE_CYCLE.DRAFTING) throw ABORT_DUPLICATE;
      return { offered: offerInTx(tx, c, seed, graph, names, { hints, factSystemIds: facts.systemIds }) };
    });
    if (!o || o.ok !== true) {
      if (o && o.error === ABORT_DUPLICATE) return true;
      bump("errors");
      logger.log(`gameMaster: offer ${c} failed - ${(o && o.reason) || "no result"}`);
      return true;
    }
    const offered = o.value.offered;
    if (!offered.ok) return false;
    const offer = offered.offer;
    const prompt = buildPlotPrompt({ offer, factLines: facts.lines,
      regionName: (id) => graph.getRegionName(id) }, S);
    if (!prompt.ok) {
      noteRefusal(c, "PROMPT_TOO_LARGE", now);
      return false;
    }
    let accepted = false;
    const onAccepted = () => {
      const r = store.transaction("gameMaster.attempt", (tx) => {
        const cur = repo.readCycleInTx(tx, c);
        if (!cur || cur.state !== STATE_CYCLE.DRAFTING || cur.attempts >= S.aiAttemptsPerCycle) return false;
        const u = repo.updateCycleInTx(tx, { cycleAt: c, fromState: STATE_CYCLE.DRAFTING,
          toState: STATE_CYCLE.DRAFTING, attemptsDelta: 1, now });
        if (!u.ok) throw new Error(`cycle attempt ${u.reason}`);
        return u.changed;
      });
      accepted = Boolean(r && r.ok === true && r.value === true);
      if (accepted) bump("ai.requested");
      return accepted;
    };
    aiFlight = { cycleAt: c };
    const t0 = nowMs();
    let p;
    try {
      p = chatter.complete(plotSpecOf(prompt, S, onAccepted));
    } catch (_err) {
      p = null;
    }
    const done = (res) => onAiResult({ cycleAt: c, offer, seed, accepted, t0, askedAt: now }, res);
    Promise.resolve(p).then(done, () => done(null));
    return true;
  }

  function onAiResult(a, res) {
    aiFlight = null;
    if (stopped) return;
    try {
      const c = a.cycleAt;
      const now = clockNow ? clockNow() : a.askedAt;
      if (!a.accepted) {
        noteRefusal(c, refusalCodeOf(res && res.reason), now);
        return;
      }
      metric("observe", SC.METRICS.aiMs, Math.max(0, nowMs() - a.t0));
      if (!res || res.ok !== true || typeof res.text !== "string") {
        const why = res && typeof res.reason === "string" && CODE_RE.test(res.reason) ? res.reason : "NO_RESULT";
        bump("ai.failed");
        aiLast = `FAILED:${why}`;
        aiHold = { cycleAt: c, until: now + S.aiRetryMs };
        const n = store.transaction("gameMaster.aiNote", (tx) => noteCycleInTx(tx, c, aiLast, now));
        if (!n || n.ok !== true) bump("errors");
        logger.log(`gameMaster: plot request failed ${why} (cycle ${c})`);
        return;
      }
      const r = store.transaction("gameMaster.draft", (tx) => {
        const cur = repo.readCycleInTx(tx, c);
        if (!cur || cur.state !== STATE_CYCLE.DRAFTING) throw ABORT_DUPLICATE;
        return draftInTx(tx, cur, res.text, SOURCES.AI, { offer: a.offer, seed: a.seed, now, keepOnReject: true });
      });
      if (!r || r.ok !== true) {
        if (r && r.error === ABORT_DUPLICATE) {
          bump("skipped.DUPLICATE");
          return;
        }
        bump("errors");
        logger.log(`gameMaster: AI draft ${c} failed - ${(r && r.reason) || "no result"}`);
        return;
      }
      const v = r.value;
      bump("drafted");
      if (v.code === "REJECTED") {
        bump(`rejected.${v.rule}`);
        aiLast = `REJECTED:${v.rule}`;
        aiHold = { cycleAt: c, until: now + S.aiRetryMs };
        logger.log(`gameMaster: plot answer refused ${v.rule} (cycle ${c})`);
        return;
      }
      aiLast = "ACCEPTED";
      bump("ai.accepted");
      bump(`threads.started.${SOURCES.AI}`);
      for (const field of v.textFallback) bump(`textFallback.${field}`);
      logger.log(`gameMaster: thread ${v.threadId} started arc=${v.arc} source=ai steps=${v.steps}`
        + ` notified=${v.notified} textFallback=${v.textFallback.length}`);
    } catch (err) {
      bump("errors");
      logger.log(`gameMaster: plot result threw - ${messageOf(err)}`);
    }
  }

  function clampDue(row, dueAt, now) {
    const at = Number.isSafeInteger(dueAt) ? dueAt : now;
    return Math.min(Math.max(at, now), row.deadlineAt);
  }

  function nextStepPatch(row, result, now) {
    return { stepNo: row.stepNo + 1, stepState: STEP_STATE.PENDING, stepHandle: null, stepDueAt: now, stepRetries: 0,
      stepResults: [...row.stepResults, result] };
  }

  function advanceInTx(tx, threadId, now, budget) {
    const out = { transitions: 0, bumps: [], logs: [] };
    const update = (row, patch) => {
      const u = repo.updateThreadInTx(tx, { threadId: row.threadId, version: row.version, patch, now });
      if (!u.ok) throw new Error(`thread update ${u.reason} ${u.detail || ""}`.trim());
      if (!u.changed) out.bumps.push("skipped.CAS");
      return u.changed;
    };
    const fail = (row, step, reason) => {
      out.bumps.push(`steps.${STEP_RESULT.FAILED}`);
      return update(row, nextStepPatch(row, { kind: step ? step.kind : null, state: STEP_RESULT.FAILED, outcome: null,
        reason }, now));
    };
    const end = (row, outcome) => {
      const plan = row.plan || {};
      const line = plan.end ? (outcome === OUTCOME.WON || outcome === OUTCOME.NEUTRAL ? plan.end.won : plan.end.lost)
        : "";
      if (!update(row, { state: STATE_THREAD.ENDED, outcome, endedAt: now })) return false;
      const j = journal.applyOnce(tx, journalSpec(`gm:end:${row.threadId}`, row, SC.EVENT_ENDED, { outcome }),
        (db) => sender.sendInTx(db, { eventKey: `gm:${row.threadId}:end`, systemId: row.anchorSystemId, line, now }));
      if (!j || j.ok !== true) throw new Error(`journal end ${(j && j.reason) || "no result"}`);
      out.bumps.push(`threads.ended.${outcome}`);
      out.logs.push(`gameMaster: thread ${row.threadId} ended ${outcome}`);
      return false;
    };

    while (out.transitions < budget) {
      const row = repo.readThreadInTx(tx, threadId);
      if (!row || row.state !== STATE_THREAD.ACTIVE) break;
      const act = nextThreadAction(row, now, registry);
      if (act.action === "WAIT") break;
      out.transitions += 1;
      let more = false;
      if (act.action === "EXPIRE") {
        const steps = row.plan && Array.isArray(row.plan.steps) ? row.plan.steps : [];
        const step = steps[row.stepNo];
        const kind = step && row.stepState === STEP_STATE.RUNNING ? registry.get(step.kind) : null;
        if (kind) {
          const c = inSavepoint(tx, () => kind.cancelInTx(tx, stepCtxOf(row, step, now), REASON.DEADLINE));
          if (!c.ok) out.bumps.push("errors");
        }
        more = end(row, OUTCOME.EXPIRED);
      } else if (act.action === "END") {
        more = end(row, act.outcome);
      } else if (act.action === "SKIP_KIND") {
        out.bumps.push(`steps.${STEP_RESULT.SKIPPED}`, "steps.kindGone");
        more = update(row, nextStepPatch(row, { kind: act.step ? act.step.kind : null, state: STEP_RESULT.SKIPPED,
          outcome: null, reason: REASON.KIND_GONE }, now));
      } else if (act.action === "START") {
        const c = inSavepoint(tx, () => act.kind.startInTx(tx, stepCtxOf(row, act.step, now)));
        const r = c.ok ? c.value : null;
        if (!c.ok) {
          out.bumps.push("errors");
          out.logs.push(`gameMaster: step ${act.kind.type} of ${threadId} threw on start`);
          more = fail(row, act.step, REASON.THROW);
        } else if (r && r.ok === true) {
          const handle = r.handle === undefined ? null : r.handle;
          const bytes = Buffer.byteLength(JSON.stringify(handle), "utf8");
          more = bytes > SC.MAX_HANDLE_BYTES ? fail(row, act.step, REASON.HANDLE_TOO_LARGE)
            : update(row, { stepState: STEP_STATE.RUNNING, stepHandle: handle, stepDueAt: clampDue(row, r.dueAt, now) });
        } else if (r && r.retry === true && row.stepRetries < S.stepRetries) {
          out.bumps.push("steps.RETRY");
          update(row, { stepDueAt: clampDue(row, now + S.stepRetryMs, now), stepRetries: row.stepRetries + 1 });
        } else {
          more = fail(row, act.step, String((r && r.reason) || "NO_RESULT").slice(0, SC.MAX_REASON_LENGTH));
        }
      } else if (act.action === "POLL") {
        const c = inSavepoint(tx, () => act.kind.pollInTx(tx, stepCtxOf(row, act.step, now)));
        const p = c.ok ? c.value : null;
        if (!c.ok) {
          out.bumps.push("errors");
          out.logs.push(`gameMaster: step ${act.kind.type} of ${threadId} threw on poll`);
          more = fail(row, act.step, REASON.THROW);
        } else if (p && p.state === "DONE") {
          const outcome = [OUTCOME.WON, OUTCOME.LOST, OUTCOME.NEUTRAL].includes(p.outcome) ? p.outcome : OUTCOME.NEUTRAL;
          more = update(row, nextStepPatch(row, { kind: act.step.kind, state: STEP_RESULT.DONE, outcome, reason: null },
            now));
          if (more) {
            const j = journal.applyOnce(tx, journalSpec(`gm:step:${row.threadId}:${row.stepNo}`, row,
              SC.EVENT_STEP_DONE, { stepNo: row.stepNo, stepKind: act.step.kind, outcome }), () => ({ ok: true }));
            if (!j || j.ok !== true) throw new Error(`journal step ${(j && j.reason) || "no result"}`);
            out.bumps.push(`steps.${STEP_RESULT.DONE}`);
          }
        } else if (p && p.state === "RUNNING") {
          update(row, { stepDueAt: clampDue(row, p.dueAt, now) });
        } else {
          more = fail(row, act.step, "BAD_POLL");
        }
      }
      if (!more) break;
    }
    return out;
  }

  function pump(now) {
    const due = store.transaction("gameMaster.due", (tx) => {
      const list = repo.listDueThreadsInTx(tx, { now, limit: S.maxStepsPerPass });
      if (!list.ok) throw new Error(`due list ${list.reason}`);
      return { rows: list.rows, open: repo.countActiveThreadsInTx(tx) };
    });
    if (!due || due.ok !== true) {
      bump("errors");
      logger.log(`gameMaster: due list failed - ${(due && due.reason) || "no result"}`);
      return 0;
    }
    open = due.value.open;
    let budget = S.maxStepsPerPass;
    let transitions = 0;
    for (const t of due.value.rows) {
      if (budget <= 0) break;
      const r = store.transaction("gameMaster.step", (tx) => advanceInTx(tx, t.threadId, now, budget));
      if (!r || r.ok !== true) {
        bump("errors");
        logger.log(`gameMaster: thread ${t.threadId} failed - ${(r && r.reason) || "no result"}`
          + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
        budget -= 1;
        continue;
      }
      budget -= r.value.transitions;
      transitions += r.value.transitions;
      for (const name of r.value.bumps) bump(name);
      for (const line of r.value.logs) logger.log(line);
      if (r.value.bumps.some((n) => n.startsWith("threads.ended."))) open = Math.max(0, open - 1);
    }
    return transitions;
  }

  function retain(now) {
    const beforeAt = now - S.retentionMs;
    if (beforeAt <= 0) return;
    const r = store.transaction("gameMaster.retention", (tx) => repo.purgeInTx(tx, { beforeAt,
      limit: S.maxRetainPerPass }));
    if (r && r.ok === true && r.value && r.value.ok === true) {
      bump("retained", r.value.deleted);
      return;
    }
    bump("errors");
    logger.log(`gameMaster: retention failed - ${(r && (r.reason || (r.value && r.value.reason))) || "no result"}`);
  }

  function runPass(now) {
    if (stopped) return { ok: false, reason: "GAME_MASTER_STOPPED" };
    if (!admits("OPERATIONAL")) {
      bump("skipped.GOVERNOR");
      return { ok: false, reason: "GOVERNOR_HOLD" };
    }
    const t0 = nowMs();
    const maintenance = admits("MAINTENANCE");
    if (maintenance) {
      try {
        cycleStep(now);
      } catch (err) {
        bump("errors");
        logger.log(`gameMaster: cycle threw - ${messageOf(err)}`);
      }
    }
    let transitions = 0;
    try {
      transitions = pump(now);
    } catch (err) {
      bump("errors");
      logger.log(`gameMaster: pump threw - ${messageOf(err)}`);
    }
    if (maintenance) {
      try {
        retain(now);
      } catch (err) {
        bump("errors");
        logger.log(`gameMaster: retention threw - ${messageOf(err)}`);
      }
    }
    passes += 1;
    bump("passes");
    last = Object.freeze({ at: now, transitions });
    metric("observe", "gameMaster.passMs", Math.max(0, nowMs() - t0));
    metric("gauge", "gameMaster.threads.open", open);
    return { ok: true, transitions };
  }

  function runActivity(now) {
    if (stopped) return { ok: false, reason: "GAME_MASTER_STOPPED" };
    const presence = safeCall(getPresence);
    const st = presence && typeof presence.getStatus === "function" ? safeCall(() => presence.getStatus()) : null;
    if (!st || st.available !== true || st.stale) return { ok: true, regions: 0 };
    const observed = safeCall(() => presence.observedSystems(), []);
    const graph = graphNow();
    if (!graph || !Array.isArray(observed) || observed.length === 0) return { ok: true, regions: 0 };
    const bucketAt = cycleAtOrBefore(now, S);
    const r = store.transaction("gameMaster.activity", (tx) => {
      const s = sampleActivityInTx(tx, { observed, graph, bucketAt, maxRegions: S.maxActivityRegions }, repo);
      if (!s.ok) throw ABORT_ACTIVITY;
      return s;
    });
    if (!r || r.ok !== true) {
      bump("errors");
      logger.log(`gameMaster: activity sample failed - ${(r && r.reason) || "no result"}`);
      return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
    }
    bump("activity.samples", r.value.regions);
    return { ok: true, regions: r.value.regions };
  }

  function listBoardRows(opts) {
    if (stopped) return { ok: false, reason: "GAME_MASTER_STOPPED" };
    if (S.boardEnabled !== true) return { ok: false, reason: "GAME_MASTER_DISABLED" };
    const limit = opts && opts.limit;
    const systemIds = opts ? opts.systemIds : undefined;
    if (!Number.isSafeInteger(limit) || limit <= 0) return { ok: false, reason: "LIMIT_INVALID" };
    if (systemIds !== null && !(systemIds instanceof Set)) return { ok: false, reason: "SYSTEM_IDS_INVALID" };
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) return { ok: false, reason: "TX_ACTIVE" };
    const r = store.transaction("gameMaster.board", (tx) => {
      const list = repo.listActiveThreadsInTx(tx, { limit: Math.max(S.maxOpenThreads, limit) });
      if (!list.ok) throw new Error(`board list ${list.reason}`);
      return list.rows;
    });
    if (!r || r.ok !== true) return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
    const out = threadRowsOf(r.value, { systemIds, limit });
    return { ok: true, rows: out.rows, truncated: out.truncated };
  }

  return Object.freeze({
    runPass,
    runActivity,
    draftInTx,
    listBoardRows,
    getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", passes, last, open,
      ai: S.aiEnabled === true ? (aiFlight ? "in_flight" : "on") : "off", aiLast, arcs: S.arcs,
      counters: Object.freeze({ ...counters }) }),
    isStopped: () => stopped,
    stop() {
      stopped = true;
    },
  });
}

module.exports = { createGameMasterService, drainGameMaster, inSavepoint };
