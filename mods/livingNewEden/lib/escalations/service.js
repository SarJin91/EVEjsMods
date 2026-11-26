"use strict";

const S = require("./schema");
const defaultRepo = require("./repository");
const { rollOf, planEscalation, formatLeadLine } = require("./plan");
const { createAbortSentinel } = require("../persistence/store");

const SKIP_REASONS = Object.freeze(["NO_RECIPIENTS", "NO_TARGET", "LIMIT_DAY", "LIMIT_ACTIVE", "LIMIT_CHARACTER",
  "NOTICES", "SITE_REFUSED"]);
const COUNTER_NAMES = Object.freeze(["completions", "excluded", "queueOverflow", "queueStale", "deferred", "hits",
  "misses", "offered", "duplicate", "recipientsFromPresence", ...SKIP_REASONS.map((r) => `skipped.${r}`), "retained",
  "errors"]);
const RETRY_SITE_REFUSALS = Object.freeze(["SITES_FULL", "SYSTEM_WINDOW_FULL", "SITE_REQUEST_INVALID"]);
const SITE_SLOT = 0;
const MAX_DETAIL = 120;

const ABORTS = new Map(SKIP_REASONS.map((r) => [r, createAbortSentinel(`escalations.${r}`)]));
const REASON_OF = new Map([...ABORTS].map(([r, s]) => [s, r]));

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function safeCall(fn, fallback = null) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function createEscalationsService(deps) {
  const { store, worldSeed, catalog, settings: P, excludedOrigins, siteKind, clock } = deps;
  const repo = deps.repository || defaultRepo;
  const retentionLimit = deps.retentionLimit;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getSites = typeof deps.getSites === "function" ? deps.getSites : () => null;
  const getNotices = typeof deps.getNotices === "function" ? deps.getNotices : () => null;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const onQueued = typeof deps.onQueued === "function" ? deps.onQueued : () => {};
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const queue = [];
  let stopped = false;
  let passes = 0;
  let last = null;

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
    metric("count", `escalations.${name}`, n);
  }

  function admits(workClass) {
    const governor = safeCall(getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    return safeCall(() => governor.admits(workClass) !== false, true);
  }

  function noticesNow() {
    const n = safeCall(getNotices);
    if (!n || typeof n.enqueueItemsInTx !== "function" || typeof n.getStatus !== "function") return null;
    const st = safeCall(() => n.getStatus());
    return st && st.state === "running" ? n : null;
  }

  function sitesNow() {
    const s = safeCall(getSites);
    if (!s || typeof s.createSiteInTx !== "function") return null;
    if (typeof s.getStatus !== "function") return s;
    const st = safeCall(() => s.getStatus());
    return st && st.state === "running" ? s : null;
  }

  function graphNow() {
    const g = safeCall(getGraph);
    if (!g || typeof g.getGraph !== "function") return null;
    const r = safeCall(() => g.getGraph());
    return r && r.ok && r.graph ? r.graph : null;
  }

  function nameOf(graph, systemId) {
    const sys = safeCall(() => graph.getSystem(systemId));
    return sys && typeof sys.name === "string" && sys.name !== "" ? sys.name : systemId;
  }

  function onCompletion(c) {
    try {
      if (stopped || !c) return;
      bump("completions");
      if (c.own === true || excludedOrigins.has(String(c.siteOrigin || "").toLowerCase())) {
        bump("excluded");
        return;
      }
      if (queue.length >= P.queueMax) {
        bump("queueOverflow");
        return;
      }
      queue.push({ completion: c, receivedAt: clock.now() });
      onQueued();
    } catch (_err) {
      bump("errors");
    }
  }

  function recipientsOf(c) {
    let ids = Array.isArray(c.characterIds) ? c.characterIds.filter(isId) : [];
    if (ids.length === 0) {
      const presence = safeCall(getPresence);
      const st = presence && typeof presence.getStatus === "function" ? safeCall(() => presence.getStatus()) : null;
      const usable = presence && typeof presence.getSystemPresence === "function"
        && !(st && (st.available === false || st.stale === true));
      const here = usable ? safeCall(() => presence.getSystemPresence(c.systemId)) : null;
      const chars = here && Array.isArray(here.characters) ? here.characters : [];
      ids = chars.map((x) => x && x.characterId).filter(isId);
      if (ids.length > 0) bump("recipientsFromPresence");
    }
    return [...new Set(ids)].sort((a, b) => a - b).slice(0, P.maxRecipients);
  }

  function offerInTx(tx, o) {
    const { escalationId, c, roll, plan, recipients, graph, now, expiresAt } = o;
    if (repo.getByIdInTx(tx, escalationId)) return { duplicate: true };
    const since = Math.max(0, now - P.limitWindowMs);
    if (repo.countCreatedSinceInTx(tx, since) >= P.maxPerDay) throw ABORTS.get("LIMIT_DAY");
    if (repo.countActiveInTx(tx, now) >= P.maxActive) throw ABORTS.get("LIMIT_ACTIVE");
    const chosen = recipients.filter((id) => repo.countForCharacterSinceInTx(tx, id, since) < P.maxPerCharacterPerDay);
    if (chosen.length === 0) throw ABORTS.get("LIMIT_CHARACTER");
    const notices = noticesNow();
    if (!notices) throw ABORTS.get("NOTICES");
    const sites = sitesNow();
    if (!sites) throw ABORTS.get("SITE_REFUSED");
    let placed = null;
    for (const a of plan.attempts) {
      const req = { eventId: escalationId, slot: SITE_SLOT, systemId: a.systemId, templateId: a.templateId,
        label: a.name, factionId: null, expiresAt };
      if (siteKind !== null) req.siteKind = siteKind;
      const s = sites.createSiteInTx(tx, req);
      if (s && s.ok === true) {
        placed = { attempt: a, siteKey: s.siteKey };
        break;
      }
      if (!s || !RETRY_SITE_REFUSALS.includes(s.reason)) break;
    }
    if (!placed) throw ABORTS.get("SITE_REFUSED");
    const a = placed.attempt;
    const ins = repo.insertInTx(tx, { escalationId, sourceInstanceId: c.instanceId, sourceSystemId: c.systemId,
      sourceTemplateId: c.templateId, sourceFactionId: isId(c.factionId) ? c.factionId : null,
      targetSystemId: a.systemId, jumps: a.jumps, templateId: a.templateId, dedRating: a.dedRating,
      siteKey: placed.siteKey, seed: roll.seed, createdAt: now, expiresAt }, chosen);
    if (!ins.ok) throw new Error(`escalation insert ${ins.reason} ${ins.detail || ""}`.trim());
    const line = formatLeadLine(a, nameOf(graph, c.systemId), nameOf(graph, a.systemId), expiresAt);
    const items = chosen.map((characterId) => ({ eventKey: escalationId, characterId, kind: S.KIND_LEAD,
      systemId: a.systemId, line, eventAt: now }));
    const q = notices.enqueueItemsInTx(tx, items, now);
    if (q && q.ok === false && q.reason === "INVALID_INPUT") {
      throw new Error(`escalation notices INVALID_INPUT ${q.detail || ""}`.trim());
    }
    if (!q || q.ok !== true) throw ABORTS.get("NOTICES");
    return { duplicate: false, systemId: a.systemId, recipients: chosen.length };
  }

  function handle(c, now) {
    const roll = rollOf(worldSeed, c, P.chance);
    if (!roll.hit) {
      bump("misses");
      return "MISS";
    }
    bump("hits");
    const recipients = recipientsOf(c);
    if (recipients.length === 0) {
      bump("skipped.NO_RECIPIENTS");
      return "SKIPPED";
    }
    const graph = graphNow();
    const plan = graph ? planEscalation(graph, catalog, c, roll.seed, P) : { ok: false, reason: "NO_TARGET" };
    if (!plan.ok) {
      bump("skipped.NO_TARGET");
      return "SKIPPED";
    }
    const escalationId = S.escalationIdOf(c.instanceId, c.completedAtMs);
    const expiresAt = now + P.leadTtlMs;
    const t0 = nowMs();
    const r = store.transaction("escalations.offer", (tx) => offerInTx(tx, { escalationId, c, roll, plan, recipients,
      graph, now, expiresAt }));
    metric("observe", "escalations.txMs", Math.max(0, nowMs() - t0));
    if (r && r.ok === true) {
      if (r.value.duplicate) {
        bump("duplicate");
        return "DUPLICATE";
      }
      bump("offered");
      logger.log(`escalations: lead ${escalationId} -> system ${r.value.systemId} (${r.value.recipients} recipients)`);
      return "OFFERED";
    }
    const reason = r && REASON_OF.get(r.error);
    if (reason) {
      bump(`skipped.${reason}`);
      return "SKIPPED";
    }
    bump("errors");
    logger.log(`escalations: ${escalationId} failed - ${(r && r.reason) || "no result"}`
      + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
    return "ERROR";
  }

  function retain(now) {
    const before = now - Math.max(P.retentionMs, P.limitWindowMs);
    if (before <= 0) return;
    const r = store.transaction("escalations.retention", (tx) => repo.deleteExpiredInTx(tx, before, retentionLimit));
    if (r && r.ok === true && r.value && r.value.ok === true) bump("retained", r.value.deleted);
    else if (!r || r.ok !== true || !r.value || r.value.ok !== true) {
      bump("errors");
      logger.log(`escalations: retention failed - ${(r && (r.reason || (r.value && r.value.reason))) || "no result"}`);
    }
  }

  function runPass(now) {
    if (stopped) return { ok: false, reason: "ESCALATIONS_STOPPED" };
    if (!admits("OPERATIONAL")) {
      if (queue.length > 0) bump("deferred", queue.length);
      return { ok: false, reason: "GOVERNOR_HOLD" };
    }
    const t0 = nowMs();
    const out = { ok: true, processed: 0, offered: 0, skipped: 0, deferred: 0 };
    while (queue.length > 0 && out.processed < P.maxPerPass) {
      const item = queue.shift();
      out.processed += 1;
      if (now - item.receivedAt > P.queueMaxAgeMs) {
        bump("queueStale");
        out.skipped += 1;
        continue;
      }
      let res;
      try {
        res = handle(item.completion, now);
      } catch (err) {
        bump("errors");
        logger.log(`escalations: element dropped - ${messageOf(err)}`);
        res = "ERROR";
      }
      if (res === "OFFERED") out.offered += 1;
      else if (res !== "MISS") out.skipped += 1;
    }
    out.deferred = queue.length;
    if (admits("MAINTENANCE")) {
      try {
        retain(now);
      } catch (err) {
        bump("errors");
        logger.log(`escalations: retention threw - ${messageOf(err)}`);
      }
    }
    passes += 1;
    last = Object.freeze({ at: now, processed: out.processed, offered: out.offered, skipped: out.skipped });
    metric("observe", "escalations.passMs", Math.max(0, nowMs() - t0));
    return out;
  }

  return Object.freeze({
    onCompletion,
    runPass,
    getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", queued: queue.length, passes, last,
      catalogSize: catalog.length, counters: Object.freeze({ ...counters }) }),
    isStopped: () => stopped,
    stop() {
      if (stopped) return;
      stopped = true;
      queue.length = 0;
    },
  });
}

module.exports = { createEscalationsService, COUNTER_NAMES, SKIP_REASONS, RETRY_SITE_REFUSALS };
