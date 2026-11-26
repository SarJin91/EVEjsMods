"use strict";

const { performance } = require("node:perf_hooks");
const { deriveSeed } = require("../util/rng");
const { chooseEvents } = require("./director");
const { STATE, RESULT } = require("./eventMachine");
const { gatherPulseContext, buildDirectorInput } = require("./context");
const { getEventType } = require("./catalog");
const { createPresenceTrigger } = require("./presenceTrigger");
const { defaultSetTimer } = require("../presence/poller");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../strategy/data/expansion");
const defaultRepository = require("./eventRepository");
const S = require("./schema");
const { eventRowsOf } = require("./boardRows");

const METRIC_WAITING = "events.waiting";

const COUNTER_NAMES = Object.freeze(["pulses", "bootPulses", "nudgePulses", "pulseFailed",
  "pulseSkipped.WORLD_UNAVAILABLE", "pulseSkipped.GRAPH_NOT_READY", "pulseSkipped.READ_FAILED",
  "pulseSkipped.CONTEXT_INVALID", "pulseSkipped.RECENT_TRUNCATED",
  "planned", "duplicatePlans", "systemFull",
  "activated", "aftermath", "cleared", "expired", "cancelled.CAUSE_GONE", "cancelled.EXPIRED_UNSTARTED",
  "cancelled.UNOBSERVED", "activatedByPresence", "presenceUnknown",
  "quarantined", "versionConflict", "transitionFailed", "rowCorrupt",
  "siteRequested", "siteCreated", "siteRefused.SITES_DISABLED", "siteRefused.SITES_UNAVAILABLE",
  "siteRefused.SITES_FULL", "siteRefused.SYSTEM_WINDOW_FULL", "siteRefused.IDEMPOTENCY_CONFLICT",
  "siteRefused.SITE_REQUEST_INVALID", "siteRefused.SITES_ERROR", "siteRefused.OTHER", "siteReadRefused",
  "readRefused",
  "cleanupRequested", "cleanupPending", "cleanupRetried",
  "skipped.REGION_EXCLUDED", "skipped.NO_TEMPLATE", "skipped.SEC_CLASS", "skipped.STATE_MISMATCH",
  "skipped.DUPLICATE", "skipped.SYSTEM_BUSY", "skipped.COOLDOWN", "skipped.WINDOW_FULL", "skipped.ROOM",
  "skipped.PASS_SYSTEM_TAKEN", "skipped.NOT_OBSERVED", "skipped.OTHER",
  "candidatesTruncated", "deleted", "templatesMissing", "catalogUnchecked",
  "planRefused", "retentionRefused", "failureLogSuppressed",
  "refusal.EFFECT_ERROR", "refusal.REPO_INVALID_INPUT", "refusal.TRANSITION_INVALID", "refusal.PLAN_INVALID",
  "refusal.TX_REQUIRED", "refusal.OTHER",
  "consequence.APPLIED", "consequence.UNCHANGED", "consequence.DUPLICATE", "consequence.NOT_CONTROLLER",
  "consequence.OTHER",
  "aftermath.read", "aftermath.refused", "aftermath.truncated", "aftermath.systemsTruncated", "aftermath.causes",
  "liberated.read", "liberated.refused", "liberated.truncated", "liberated.causes", "richVeins.capped",
  "front.causes",
  "developedCauses", "developedCapped", "developedRead", "developedRefused", "developedTruncated",
  "developedNoRatFaction", "developedRatRefused"]);
const NAME_SET = new Set(COUNTER_NAMES);

const ACTION_COUNTERS = Object.freeze({ ACTIVATE: "activated", START_AFTERMATH: "aftermath", FINISH: "cleared",
  EXPIRE: "expired", QUARANTINE: "quarantined" });
const CONFLICT_REASONS = Object.freeze(["VERSION_CONFLICT", "ROW_NOT_FOUND"]);
const SAVEPOINT_ABORT = Symbol("events-savepoint-abort");
const MS_DECIMALS = 1000;
const PERMILLE = 1000;
const MAX_DETAIL = 120;

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function oneLine(v) {
  return String(v).replace(/\s+/g, " ").slice(0, MAX_DETAIL);
}

function failureOf(r, action, id) {
  const reason = r && typeof r.reason === "string" && r.reason !== "" ? oneLine(r.reason) : "EFFECT_ERROR";
  const detail = r && r.detail !== undefined && r.detail !== null ? oneLine(r.detail) : null;
  return { action, id: id === null || id === undefined ? null : String(id), reason, detail };
}

function isTime(v) {
  return Number.isSafeInteger(v) && v >= 0;
}

function get(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function contentOf(row) {
  const c = row && row.reason && typeof row.reason === "object" ? row.reason.contentFactionId : undefined;
  return Number.isSafeInteger(c) && c > 0 ? c : row.factionId;
}

function add(map, key, n = 1) {
  map[key] = (map[key] || 0) + n;
}

function readOnly() {
  throw new TypeError("richVeinSystems: read-only set");
}

function systemSetOf(ids) {
  const set = new Set(ids);
  set.add = readOnly;
  set.delete = readOnly;
  set.clear = readOnly;
  return Object.freeze(set);
}

const EMPTY_SYSTEM_SET = systemSetOf([]);

function createEventService(deps) {
  const { config, store, clock, ids, scheduler, catalog } = deps;
  const P = config.events;
  const repo = deps.repository || defaultRepository;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const worldSeed = deps.worldSeed >>> 0;
  const aftermath = deps.aftermath || null;
  const liberated = deps.liberated || null;
  const front = deps.front || null;
  const developed = deps.developed || null;
  const veinTypes = new Set([...(liberated ? liberated.eventTypes : []), ...(front ? front.eventTypes : [])]);
  let richVeins = EMPTY_SYSTEM_SET;
  const maxCooldownMs = Math.max(0, ...catalog.types.map((t) => t.cooldownMs));
  const lookbackMs = Math.max(maxCooldownMs, config.sites.newSiteWindowMs);
  const limits = Object.freeze({
    maxNewEventsPerPass: P.maxNewEventsPerPass,
    maxOpenEvents: P.maxOpenEvents,
    maxOpenEventsPerSystem: P.maxOpenEventsPerSystem,
    maxNewSitesPerSystemPerWindow: config.limits.maxNewSitesPerSystemPerWindow,
    siteWindowMs: config.sites.newSiteWindowMs,
    presenceRadius: P.presenceRadius,
    presenceBonus: Math.round(P.presenceBonus * PERMILLE),
    maxSkipped: P.debugMaxSkipped,
    observeRadius: Math.min(P.activationRadius, P.presenceRadius),
    maxUnobservedOpen: P.presenceActivation === true ? P.maxUnobservedOpenEvents : null,
  });
  let state = "running";
  let cursor = 0;
  const status = { open: null, cleanupPending: null, lastPulseAt: null, lastBootPulseAt: null, lastSkip: null,
    lastNudgeAt: null, waiting: null };
  const presenceMode = P.presenceActivation === true;
  const trigger = presenceMode ? createPresenceTrigger({ getPresence: () => get(deps.presence), scheduler, clock, P,
    telemetry, logger: deps.logger, setTimer: typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer })
    : null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !NAME_SET.has(name)) return;
    metric("count", `events.${name}`, n);
  }

  function bumpReason(prefix, reason, n = 1) {
    const name = `${prefix}.${reason}`;
    if (NAME_SET.has(name)) bump(name, n);
    else bump(`${prefix}.OTHER`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
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

  function sitesNow() {
    const s = get(deps.sites);
    return s && typeof s === "object" ? s : null;
  }

  function callSites(sites, method, args) {
    if (!sites || typeof sites[method] !== "function") return { ok: false, reason: "SITES_UNAVAILABLE" };
    try {
      return sites[method](...args) || { ok: false, reason: "SITES_ERROR" };
    } catch (_err) {
      return { ok: false, reason: "SITES_ERROR" };
    }
  }

  function occupationNow() {
    const o = get(deps.occupation);
    return o && typeof o === "object" && typeof o.dropInfluenceInTx === "function" ? o : null;
  }

  function isClearing(row, decision) {
    return row.state === STATE.ACTIVE && (decision.action === "START_AFTERMATH"
      || (decision.action === "FINISH" && decision.result === RESULT.CLEARED));
  }

  function clearConsequence(tx, row, at) {
    if (!(P.clearedInfluencePoints > 0)) return null;
    const type = getEventType(catalog, row.eventType);
    if (type && type.clearedConsequence === false) return null;
    const occupation = occupationNow();
    if (!occupation) return null;
    let r;
    try {
      r = inSavepoint(tx, () => occupation.dropInfluenceInTx(tx, { systemId: row.systemId, factionId: contentOf(row),
        points: P.clearedInfluencePoints, at, reason: S.CLEARED_REASON, allowNonController: true },
      S.clearedKey(row.eventId)));
    } catch (err) {
      if (tx.inTransaction !== true) throw err;
      r = { ok: false, reason: "EFFECT_ERROR", detail: messageOf(err) };
    }
    if (r && r.ok === true) {
      if (r.outcome === "DUPLICATE") return { outcome: "DUPLICATE" };
      return { outcome: "APPLIED", written: r.written === true, before: r.before, next: r.next };
    }
    const f = failureOf(r, "CONSEQUENCE", row.eventId);
    return { outcome: "REFUSED", reason: f.reason, detail: f.detail };
  }

  function activate(tx, row, at, sites, local, activation) {
    const refusals = [];
    let created = 0;
    for (let slot = 0; slot < row.templateIds.length; slot += 1) {
      local.sitesRequested += 1;
      const r = callSites(sites, "createSiteInTx", [tx, { eventId: row.eventId, slot, systemId: row.systemId,
        templateId: row.templateIds[slot], label: row.label, factionId: contentOf(row), expiresAt: row.expiresAt }]);
      if (r.ok === true) created += 1;
      else refusals.push(String(r.reason || "SITES_ERROR"));
    }
    const patch = { state: STATE.ACTIVE, sites_created: created };
    if (activation && typeof activation === "object") {
      patch.result_json = { activation: { trigger: "presence", distance: activation.distance },
        ...(refusals.length > 0 ? { siteRefusals: refusals } : {}) };
    } else if (refusals.length > 0) patch.result_json = { siteRefusals: refusals };
    const tr = repo.transitionInTx(tx, row.eventId, row.version, patch, at);
    if (!tr.ok) return tr;
    local.sitesCreated = created;
    local.refusals = refusals;
    return { ok: true };
  }

  function finish(tx, row, decision, at, sites, local) {
    const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) && !row.corrupt
      ? { ...row.result } : {};
    let pending = null;
    if (decision.cleanup !== null && row.sitesCreated > 0) {
      local.cleanupRequested += 1;
      const r = callSites(sites, "cleanupSitesInTx", [tx, row.eventId, decision.cleanup]);
      if (r.ok === true) result.sitesReleased = Number(r.released) || 0;
      else {
        pending = decision.cleanup;
        local.cleanupPending += 1;
      }
    }
    const patch = { state: decision.to, result_reference: decision.result, ended_at: at, cleanup_pending: pending };
    if (Object.keys(result).length > 0) patch.result_json = result;
    const tr = repo.transitionInTx(tx, row.eventId, row.version, patch, at);
    if (tr && tr.ok === true && isClearing(row, decision)) local.consequence = clearConsequence(tx, row, at);
    return tr;
  }

  function applyDecision(tx, row, decision, at, sites, local, activation) {
    switch (decision.action) {
      case "ACTIVATE": return activate(tx, row, at, sites, local, activation);
      case "START_AFTERMATH": {
        const tr = repo.transitionInTx(tx, row.eventId, row.version, { state: STATE.COMPLETING,
          due_at: decision.dueAt }, at);
        if (tr && tr.ok === true && isClearing(row, decision)) local.consequence = clearConsequence(tx, row, at);
        return tr;
      }
      default: return finish(tx, row, decision, at, sites, local);
    }
  }

  function activeVeinSystems(facts, after) {
    const ids = [];
    for (const { row } of facts) {
      if (row.corrupt || !veinTypes.has(row.eventType)) continue;
      const st = after.has(row.eventId) ? after.get(row.eventId) : row.state;
      if (st === STATE.ACTIVE || st === STATE.COMPLETING) ids.push(row.systemId);
    }
    return ids;
  }

  function runEffect(tx, plan) {
    const t0 = nowMs();
    const { at, boot } = plan;
    const sites = sitesNow();
    const out = { ok: true, boot, skipped: null, transitions: {}, closed: 0, planned: [], duplicatePlans: 0,
      systemFull: 0, planRefused: 0, sitesRequested: 0, sitesCreated: 0, siteRefusals: {}, cleanupRequested: 0,
      cleanupPending: 0, cleanupRetried: 0, deleted: 0, versionConflict: 0, transitionFailed: 0,
      retentionRefused: 0, failures: [], open: 0, effectMs: 0, activations: [], consequence: {}, cleared: [] };
    const refused = (r, action, id) => {
      if (r && CONFLICT_REASONS.includes(r.reason)) {
        out.versionConflict += 1;
        return;
      }
      out.transitionFailed += 1;
      out.failures.push(failureOf(r, action, id));
    };
    const after = veinTypes.size > 0 ? new Map() : null;
    for (const { row, decision, activation } of plan.facts) {
      if (decision.action === "NONE") continue;
      const local = { sitesRequested: 0, sitesCreated: 0, refusals: [], cleanupRequested: 0, cleanupPending: 0,
        consequence: null };
      const byPresence = decision.action === "ACTIVATE" && activation && typeof activation === "object"
        ? activation : null;
      const r = inSavepoint(tx, () => applyDecision(tx, row, decision, at, sites, local, byPresence));
      if (!r || r.ok !== true) {
        refused(r, decision.action, row.eventId);
        continue;
      }
      if (after && decision.to !== null) after.set(row.eventId, decision.to);
      if (byPresence) {
        out.activations.push({ eventId: row.eventId, systemId: row.systemId, distance: byPresence.distance,
          eventType: row.eventType, cause: row.cause, factionId: row.factionId });
      }
      const key = decision.action === "CANCEL" ? `cancelled.${decision.result}` : ACTION_COUNTERS[decision.action];
      add(out.transitions, key || "OTHER");
      if (decision.to !== null && decision.to !== STATE.ACTIVE && decision.to !== STATE.COMPLETING) out.closed += 1;
      out.sitesRequested += local.sitesRequested;
      out.sitesCreated += local.sitesCreated;
      for (const reason of local.refusals) add(out.siteRefusals, reason);
      out.cleanupRequested += local.cleanupRequested;
      out.cleanupPending += local.cleanupPending;
      const c = local.consequence;
      if (c && c.outcome === "REFUSED") {
        add(out.consequence, c.reason);
        out.failures.push({ ...failureOf(c, "CONSEQUENCE", row.eventId), counted: false });
      } else if (c) {
        add(out.consequence, c.outcome === "APPLIED" && c.next === c.before ? "UNCHANGED" : c.outcome);
        if (c.outcome === "APPLIED") {
          out.cleared.push({ eventId: row.eventId, systemId: row.systemId, factionId: row.factionId,
            contentFactionId: contentOf(row), before: c.before, next: c.next, written: c.written });
        }
      }
    }
    for (const row of plan.pending) {
      const r = inSavepoint(tx, () => {
        const c = callSites(sites, "cleanupSitesInTx", [tx, row.eventId, row.cleanupPending]);
        if (c.ok !== true) return { ok: true, retried: false };
        const result = row.result && typeof row.result === "object" && !Array.isArray(row.result) ? row.result : {};
        const tr = repo.transitionInTx(tx, row.eventId, row.version, { cleanup_pending: null,
          result_json: { ...result, sitesReleased: Number(c.released) || 0 } }, at);
        return tr.ok ? { ok: true, retried: true } : tr;
      });
      if (r && r.ok === true && r.retried) out.cleanupRetried += 1;
      else if (!r || r.ok !== true) refused(r, "CLEANUP_RETRY", row.eventId);
    }
    for (const p of plan.plans) {
      const r = inSavepoint(tx, () => {
        const c = repo.countOpenInSystem(tx, p.systemId);
        if (!c.ok) return c;
        if (c.count >= P.maxOpenEventsPerSystem) return { ok: true, full: true };
        return repo.insertPlannedInTx(tx, p, { eventId: ids.next("event"), now: at });
      });
      if (!r || r.ok !== true) {
        out.planRefused += 1;
        out.failures.push(failureOf(r, "PLAN", p.planKey));
      } else if (r.full) out.systemFull += 1;
      else if (r.inserted) out.planned.push(p);
      else out.duplicatePlans += 1;
    }
    const del = inSavepoint(tx, () => repo.deleteEndedBefore(tx, at - P.rowRetentionMs, P.maxDeletesPerPass));
    if (del && del.ok === true) out.deleted = del.deleted;
    else {
      out.retentionRefused += 1;
      out.failures.push(failureOf(del, "RETENTION", null));
    }
    out.open = Math.max(0, plan.openCount - out.closed + out.planned.length);
    if (after) out.richVeinSystems = activeVeinSystems(plan.facts, after);
    out.effectMs = nowMs() - t0;
    return out;
  }

  const failureLoggedAt = new Map();

  function logFailures(failures, at) {
    if (!Array.isArray(failures) || failures.length === 0) return;
    for (const [sig, t] of failureLoggedAt) {
      if (at < t || at - t >= P.failureLogRepeatMs) failureLoggedAt.delete(sig);
    }
    let logged = 0;
    let suppressed = 0;
    for (const f of failures) {
      if (f.counted !== false) bumpReason("refusal", f.reason);
      const sig = `${f.action}|${f.id}|${f.reason}`;
      if (failureLoggedAt.has(sig) || logged >= P.maxFailureLogsPerPulse) {
        suppressed += 1;
        continue;
      }
      logged += 1;
      if (P.failureLogRepeatMs > 0) failureLoggedAt.set(sig, at);
      const idText = f.id === null ? "" : ` ${f.action === "PLAN" ? "planKey" : "eventId"}=${f.id}`;
      log(`events: refused ${f.action}${idText} reason=${f.reason}`
        + `${f.detail === null ? "" : ` detail=${f.detail}`}`);
    }
    bump("failureLogSuppressed", suppressed);
  }

  function committedPresence(ctx, v) {
    bump("activatedByPresence", v.activations.length);
    for (const a of v.activations) {
      log(`events: activate eventId=${a.eventId} sys=${a.systemId} trigger=presence distance=${a.distance} `
        + `type=${a.eventType} cause=${a.cause} faction=${a.factionId}`);
    }
    if (ctx.presenceUnknown) bump("presenceUnknown");
    const waiting = Array.isArray(ctx.waiting) ? ctx.waiting : [];
    status.waiting = waiting.length;
    metric("gauge", METRIC_WAITING, waiting.length);
    if (P.debug) {
      for (const w of waiting.slice(0, P.debugMaxSkipped)) {
        log(`events: wait eventId=${w.eventId} sys=${w.systemId} reason=${w.reason}`);
      }
    }
    if (trigger) {
      trigger.ensureSubscribed();
      trigger.setPlanned([...waiting.map((w) => w.systemId), ...v.planned.map((p) => p.systemId)]);
    }
  }

  function onCommittedOf(ctx) {
    return (v) => {
      bump(ctx.boot ? "bootPulses" : ctx.nudge ? "nudgePulses" : "pulses");
      if (ctx.boot) status.lastBootPulseAt = ctx.at;
      else if (ctx.nudge) status.lastNudgeAt = ctx.at;
      else status.lastPulseAt = ctx.at;
      if (!v || v.ok !== true) return;
      if (v.skipped) {
        status.lastSkip = v.skipped;
        bumpReason("pulseSkipped", v.skipped);
        log(`events: pulse skipped ${v.skipped}${ctx.boot ? " (boot)" : ctx.nudge ? " (nudge)" : ""}`);
        return;
      }
      if (Array.isArray(v.richVeinSystems)) richVeins = systemSetOf(v.richVeinSystems);
      const stats = ctx.stats;
      bump("readRefused", stats.readRefused);
      bump("siteReadRefused", stats.siteReadRefused);
      bump("rowCorrupt", ctx.corrupt);
      if (ctx.candidatesTruncated) bump("candidatesTruncated");
      if (ctx.aftermathStats) {
        bump("aftermath.read", ctx.aftermathStats.read);
        bump("aftermath.refused", ctx.aftermathStats.refused);
        bump("aftermath.truncated", ctx.aftermathStats.truncated);
        bump("aftermath.systemsTruncated", ctx.aftermathStats.systemsTruncated);
      }
      bump("aftermath.causes", ctx.aftermathCauses);
      if (ctx.liberatedStats) {
        bump("liberated.read", ctx.liberatedStats.read);
        bump("liberated.refused", ctx.liberatedStats.refused);
        bump("liberated.truncated", ctx.liberatedStats.truncated);
      }
      bump("liberated.causes", ctx.liberatedCauses);
      bump("front.causes", ctx.frontCauses);
      bump("richVeins.capped", ctx.richVeinsCapped);
      if (ctx.developedStats) {
        bump("developedRead", ctx.developedStats.read);
        bump("developedRefused", ctx.developedStats.refused);
        bump("developedTruncated", ctx.developedStats.truncated);
        bump("developedNoRatFaction", ctx.developedStats.noRatFaction);
        bump("developedRatRefused", ctx.developedStats.ratRefused);
      }
      bump("developedCauses", ctx.developedCauses);
      bump("developedCapped", ctx.developedCapped);
      if (ctx.planSkip) {
        status.lastSkip = ctx.planSkip;
        bumpReason("pulseSkipped", ctx.planSkip);
      }
      for (const [reason, n] of Object.entries(ctx.skippedByReason || {})) bumpReason("skipped", reason, n);
      let transitions = 0;
      for (const [name, n] of Object.entries(v.transitions)) {
        transitions += n;
        bump(name, n);
      }
      bump("versionConflict", v.versionConflict);
      bump("transitionFailed", v.transitionFailed);
      bump("planned", v.planned.length);
      bump("duplicatePlans", v.duplicatePlans);
      bump("systemFull", v.systemFull);
      bump("siteRequested", v.sitesRequested);
      bump("siteCreated", v.sitesCreated);
      for (const [reason, n] of Object.entries(v.siteRefusals)) bumpReason("siteRefused", reason, n);
      bump("cleanupRequested", v.cleanupRequested);
      bump("cleanupPending", v.cleanupPending);
      bump("cleanupRetried", v.cleanupRetried);
      bump("deleted", v.deleted);
      bump("planRefused", v.planRefused);
      bump("retentionRefused", v.retentionRefused);
      for (const [k, n] of Object.entries(v.consequence || {})) bumpReason("consequence", k, n);
      for (const c of v.cleared || []) {
        log(`events: cleared eventId=${c.eventId} sys=${c.systemId} faction=${c.factionId} content=${c.contentFactionId} `
          + `points=${P.clearedInfluencePoints} before=${c.before} next=${c.next} written=${c.written}`);
      }
      logFailures(v.failures, ctx.at);
      metric("gauge", "events.open", v.open);
      metric("observe", "events.pulseMs", Math.round((ctx.readMs + v.effectMs) * MS_DECIMALS) / MS_DECIMALS);
      status.open = v.open;
      status.cleanupPending = Math.max(0, ctx.pendingCount - v.cleanupRetried) + v.cleanupPending;
      if (!ctx.boot && !ctx.nudge && ctx.nextCursor !== undefined) cursor = ctx.nextCursor;
      if (presenceMode) committedPresence(ctx, v);
      if (P.debug) {
        for (const p of v.planned) {
          log(`events: plan ${p.eventType} sys=${p.systemId} faction=${p.factionId} cause=${p.cause} `
            + `score=${p.score} template=${p.templateIds[0]}`);
        }
        for (const s of (ctx.skippedList || []).slice(0, P.debugMaxSkipped)) {
          log(`events: skip sys=${s.systemId} ${s.eventType} ${s.reason}`);
        }
      }
      if (ctx.boot) {
        log(`events: boot reconcile open=${v.open} transitions=${transitions} cleanupPending=${status.cleanupPending}`);
      } else if (ctx.nudge) {
        if (transitions > 0) log(`events: nudge pulse slot=${ctx.slot} transitions=${transitions} open=${v.open}`);
      } else if (v.planned.length + transitions + v.cleanupRetried > 0) {
        log(`events: pulse round=${ctx.round} planned=${v.planned.length} transitions=${transitions} `
          + `cleanupRetried=${v.cleanupRetried} open=${v.open}`);
      }
    };
  }

  function pulseHandler(ev, hctx) {
    try {
      if (state === "stopped") return { ok: false, reason: "EVENTS_STOPPED" };
      const t0 = nowMs();
      const now = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : now;
      const I = P.refreshIntervalMs;
      const round = Math.floor(at / I);
      const bucket = round + 1;
      const boot = Boolean(ev && ev.payload && ev.payload.boot === true);
      const nudge = !boot && Number.isSafeInteger(ev && ev.payload ? ev.payload.nudge : undefined);
      const slot = nudge ? ev.payload.nudge : null;
      const noPlan = boot || nudge;
      const outcome = boot ? "BOOT" : nudge ? "NUDGE" : "PULSE";
      const reschedule = { eventType: S.PULSE_EVENT, aggregateId: S.PULSE_AGGREGATE_ID, dueAt: bucket * I,
        payload: { intervalMs: I, round: bucket }, idempotencyKey: S.pulseKey(I, bucket) };
      const skip = (reason) => ({ ok: true, outcome, effect: () => ({ ok: true, skipped: reason, boot }), reschedule,
        onCommitted: onCommittedOf({ boot, nudge, slot, at, round }) });

      const world = get(deps.world);
      const wr = world && world.repository && typeof world.repository.getSystems === "function"
        ? world.repository : null;
      if (!wr) return skip("WORLD_UNAVAILABLE");
      const g = get(deps.graph);
      const gr = g && typeof g.getGraph === "function" ? get(() => g.getGraph()) : null;
      const graph = gr && gr.ok === true && gr.graph && typeof gr.graph.getSystem === "function" ? gr.graph : null;
      const maxBatchReadIds = wr.limits && Number.isSafeInteger(wr.limits.maxBatchReadIds)
        ? wr.limits.maxBatchReadIds : config.world.maxBatchReadIds;

      const tx = store.transaction("events.read", (db) => gatherPulseContext(db, { repo, worldRepository: wr,
        sites: sitesNow(), strategy: get(deps.strategy), P, maxBatchReadIds, lookbackMs, cursor,
        ...(aftermath ? { aftermath, catalog, graph } : {}), ...(liberated ? { liberated } : {}),
        ...(developed ? { developed } : {}) },
      { at, boot: noPlan }));
      const read = tx.ok ? tx.value : null;
      if (!read || read.ok !== true) return skip("READ_FAILED");

      const seed = deriveSeed(worldSeed, "events", I, round);
      const input = buildDirectorInput(read, { catalog, P, limits, graph, presence: get(deps.presence),
        excludedRegionIds: EXPANSION_EXCLUDED_REGION_IDS, ...(aftermath ? { aftermath } : {}),
        ...(liberated ? { liberated } : {}), ...(front ? { front } : {}), ...(developed ? { developed } : {}) },
      { at, seed, round, intervalMs: I, boot: noPlan });
      if (input.capRoundsBound) log("events: cap rounds bound");
      let plans = [];
      let planSkip = null;
      let skippedByReason = null;
      let skippedList = null;
      if (!noPlan) {
        if (!graph) planSkip = "GRAPH_NOT_READY";
        else {
          const chosen = chooseEvents(input.context);
          if (chosen.ok) {
            plans = chosen.plans;
            skippedByReason = chosen.skippedByReason;
            skippedList = chosen.skipped;
          } else planSkip = chosen.reason;
        }
      }
      const ctx = { boot, nudge, slot, at, round, stats: read.stats, aftermathStats: read.aftermathStats || null,
        aftermathCauses: input.aftermathCauses || 0, liberatedStats: read.liberatedStats || null,
        liberatedCauses: input.liberatedCauses || 0, frontCauses: input.frontCauses || 0, richVeinsCapped: input.richVeinsCapped || 0, corrupt: input.corrupt,
        developedStats: read.developedStats || null, developedCauses: input.developedCauses || 0,
        developedCapped: input.developedCapped || 0,
        presenceUnknown: input.presenceUnknown, waiting: input.waiting,
        candidatesTruncated: input.candidatesTruncated, planSkip, skippedByReason, skippedList,
        pendingCount: read.pending.events.length, readMs: nowMs() - t0,
        nextCursor: read.occ ? (read.occ.nextAfterSystemId === null ? 0 : read.occ.nextAfterSystemId) : undefined };
      const effectPlan = { at, boot, facts: input.facts, pending: read.pending.events, plans,
        openCount: read.open.events.length };
      return { ok: true, outcome, effect: (etx) => runEffect(etx, effectPlan), reschedule,
        onCommitted: onCommittedOf(ctx) };
    } catch (err) {
      bump("pulseFailed");
      return { ok: false, reason: `EVENTS_PULSE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      const now = clock.now();
      const I = P.refreshIntervalMs;
      const round = Math.floor(now / I);
      const bucket = round + 1;
      const chain = scheduler.enqueue(S.PULSE_EVENT, S.PULSE_AGGREGATE_ID, bucket * I, { intervalMs: I, round: bucket },
        S.pulseKey(I, bucket));
      if (!chain || !chain.ok) {
        return { ok: false, reason: (chain && chain.reason) || "ENQUEUE_FAILED", stage: "chain" };
      }
      const bootR = scheduler.enqueue(S.PULSE_EVENT, S.PULSE_AGGREGATE_ID, now, { intervalMs: I, round, boot: true },
        S.bootKey(I, round));
      if (!bootR || !bootR.ok) return { ok: false, reason: (bootR && bootR.reason) || "ENQUEUE_FAILED", stage: "boot" };
      return { ok: true, chainDuplicate: chain.duplicate === true, bootDuplicate: bootR.duplicate === true,
        dueAt: bucket * I };
    } catch (err) {
      return { ok: false, reason: `BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function read(name, tx, fn) {
    if (tx) return tx.inTransaction === true ? fn(tx) : { ok: false, reason: "TX_REQUIRED" };
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
      return { ok: false, reason: "TX_ACTIVE" };
    }
    const r = store.transaction(name, fn);
    if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED" };
    return r.value;
  }

  function listOpenEvents(opts, tx) {
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : P.maxOpenEvents;
    return read("events.list", tx, (db) => repo.listOpen(db, { limit }));
  }

  function listBoardRows(opts) {
    try {
      const limit = opts && opts.limit;
      const systemIds = opts ? opts.systemIds : undefined;
      if (!Number.isSafeInteger(limit) || limit <= 0) return { ok: false, reason: "LIMIT_INVALID" };
      if (systemIds !== null && !(systemIds instanceof Set)) return { ok: false, reason: "SYSTEM_IDS_INVALID" };
      const listed = read("events.board", null, (db) => repo.listOpen(db, { limit: P.maxOpenEvents }));
      if (!listed || listed.ok !== true) return { ok: false, reason: String((listed && listed.reason) || "NO_RESULT") };
      const out = eventRowsOf(listed.events, { systemIds, limit });
      return { ok: true, rows: out.rows, truncated: out.truncated };
    } catch (err) {
      return { ok: false, reason: "EVENTS_BOARD_FAILED", detail: messageOf(err) };
    }
  }

  function getEvent(eventId, tx) {
    if (typeof eventId !== "string" || eventId === "") return { ok: false, reason: "EVENT_ID_INVALID" };
    return read("events.get", tx, (db) => repo.getEvent(db, eventId));
  }

  function getStatus() {
    const factions = new Set();
    for (const t of catalog.types) for (const f of Object.keys(t.templatesByFaction)) factions.add(f);
    return Object.freeze({ state, open: status.open, cleanupPending: status.cleanupPending,
      catalogVersion: catalog.version, types: catalog.types.length, factions: factions.size,
      templates: deps.templates || "unchecked", templatesMissing: deps.templatesMissing || 0,
      lastPulseAt: status.lastPulseAt, lastBootPulseAt: status.lastBootPulseAt, lastSkip: status.lastSkip,
      presenceActivation: presenceMode, waiting: status.waiting, trigger: trigger ? trigger.getStatus() : null,
      lastNudgeAt: status.lastNudgeAt,
      warnings: Object.freeze([...(deps.warnings || [])]) });
  }

  if (trigger) trigger.ensureSubscribed();

  return Object.freeze({
    pulseHandler,
    bootstrap,
    listOpenEvents,
    listBoardRows,
    getEvent,
    getStatus,
    richVeinSystems: () => richVeins,
    stop() {
      state = "stopped";
      if (trigger) trigger.stop();
    },
  });
}

module.exports = { createEventService, COUNTER_NAMES, EMPTY_SYSTEM_SET };
