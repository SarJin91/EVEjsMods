"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const R = require("./standingsRules");

const COUNTER_NAMES = Object.freeze(["killsSeen", "granted", "debounced", "dailyCap", "notPirate", "notPirateSystem",
  "noBeneficiary", "noRow", "invalidKill", "applied", "duplicates", "expired", "failed", "keyReused", "transient",
  "txFailed", "invalidPayload", "staleKill", "navyCharged", "navyDebounced", "pirateSideGranted",
  "pirateSideDebounced", "pirateSideNoBeneficiary", "pirateSideNoRow", "pirateSideDailyCap", "pirateApplied",
  "convoyCharged", "convoyDebounced",
  "pirateKillCharged", "pirateKillDebounced"]);
const PARAM_KEYS = Object.freeze(["rawChangePerGrant", "debounceWindowMs", "maxGrantsPerCharacterDay",
  "maxGrantsPerPass", "grantMaxAgeMs", "navyPenaltyEnabled", "navyAttackRaw", "navyKillRaw", "navyAttackWindowMs",
  "pirateSideEnabled", "pirateSideRawChangePerGrant", "convoyPenaltyEnabled", "convoyAttackRaw", "convoyKillRaw",
  "pirateKillChargeRaw"]);
const OUTCOME_COUNTER = Object.freeze({ GRANTED: "granted", DEBOUNCED: "debounced", DAILY_CAP: "dailyCap",
  NOT_PIRATE: "notPirate", NOT_PIRATE_SYSTEM: "notPirateSystem", NO_BENEFICIARY: "noBeneficiary", NO_ROW: "noRow",
  KILL_INVALID_INPUT: "invalidKill" });
const PIRATE_OUTCOME_COUNTER = Object.freeze({ GRANTED: "pirateSideGranted", DEBOUNCED: "pirateSideDebounced",
  DAILY_CAP: "pirateSideDailyCap", NOT_ANTI_PIRATE: "pirateSideNoBeneficiary",
  NO_PIRATE_BENEFICIARY: "pirateSideNoBeneficiary", NO_ROW: "pirateSideNoRow", KILL_INVALID_INPUT: "invalidKill" });
const KEY_REUSED_DETAIL = "KEY_REUSED_APPLIED";
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err);
}

class Rollback extends Error {
  constructor(detail) {
    super(String(detail).slice(0, MAX_DETAIL));
    this.name = "StandingsRollback";
  }
}

function createStandingsService(deps) {
  const { store, journal, repository, scheduler, adapter, clock, config, pirateIds, data } = deps;
  const graph = deps.graph || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const params = Object.freeze(Object.fromEntries(PARAM_KEYS.map((k) => [k, config.standings[k]])));
  const rules = Object.freeze({ pirateIds, data, params });
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let stopped = false;
  let seq = 0;
  let lastRefusal = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] = (counters[name] || 0) + n;
    seq += 1;
  }

  function refuse(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
    seq += 1;
  }

  function log(message) {
    try {
      logger.log(message);
    } catch (_err) {
    }
  }

  function vertexOf(systemId) {
    try {
      const g = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      const ug = g && g.ok ? g.graph : null;
      return ug && typeof ug.getSystem === "function" ? ug.getSystem(systemId) : null;
    } catch (_err) {
      return null;
    }
  }

  function onNpcKill(kill) {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      if (!kill || !S.isId(kill.characterId) || !S.isId(kill.victimFactionId) || !S.isId(kill.systemId)
        || !S.isTime(kill.atMs)) {
        bump("invalidKill");
        return { ok: true, outcome: "INVALID" };
      }
      bump("killsSeen");
      if (S.isId(kill.convoyOwnerFactionId)) {
        const r = onConvoyPenalty({ kind: R.NAVY_KILL, characterId: kill.characterId,
          factionId: kill.convoyOwnerFactionId, systemId: kill.systemId, atMs: kill.atMs,
          ...(S.isId(kill.victimId) ? { victimId: kill.victimId } : {}) });
        if (params.pirateSideEnabled === true) onPirateSide(kill);
        return r;
      }
      if (kill.navy === true) {
        const r = onNavyPenalty({ kind: R.NAVY_KILL, characterId: kill.characterId, factionId: kill.victimFactionId,
          systemId: kill.systemId, atMs: kill.atMs, ...(S.isId(kill.victimId) ? { victimId: kill.victimId } : {}) });
        if (params.pirateSideEnabled === true) onPirateSide(kill);
        return r;
      }
      if (!pirateIds.has(kill.victimFactionId)) {
        if (params.pirateSideEnabled === true) return onPirateSide(kill);
        bump("notPirate");
        return { ok: true, outcome: "NOT_PIRATE" };
      }
      if (clock.now() - kill.atMs > S.STALE_KILL_MS) {
        bump("staleKill");
        return { ok: true, outcome: "STALE_KILL" };
      }
      if (params.pirateKillChargeRaw > 0) onPirateKillCharge(kill);
      const vertex = vertexOf(kill.systemId);
      const t0 = nowMs();
      let result;
      try {
        result = store.transaction("standings.kill", (tx) => {
          const got = repository.getSystem(tx, kill.systemId, { includeInfluence: false });
          if (!got.ok) throw new Rollback(got.reason);
          const plan = R.planGrant(kill, got.system, vertex, rules);
          if (!plan.ok) return { outcome: plan.reason };
          return decideGrantInTx(tx, kill, plan);
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        bump("txFailed");
        refuse("standings.kill", messageOf(err));
        return { ok: false, reason: "STANDINGS_TX_FAILED", detail: messageOf(err) };
      }
      const out = result && result.ok && result.value ? result.value : null;
      if (!out) {
        bump("txFailed");
        refuse("standings.kill", (result && result.reason) || "TX_FAILED");
        return { ok: false, reason: "STANDINGS_TX_FAILED", detail: (result && result.reason) || "TX_FAILED" };
      }
      bump(OUTCOME_COUNTER[out.outcome] || "invalidKill");
      const outcome = out.outcome === "KILL_INVALID_INPUT" ? "INVALID" : out.outcome;
      if (outcome === "GRANTED") metric("observe", "world.standings.killMs", Math.round((nowMs() - t0) * 100) / 100);
      return { ok: true, outcome, ...(outcome === "GRANTED" ? { key: out.key, factionId: out.factionId } : {}) };
    } catch (err) {
      bump("txFailed");
      refuse("standings.onNpcKill", messageOf(err));
      return { ok: false, reason: "STANDINGS_FAILED", detail: messageOf(err) };
    }
  }

  function decideGrantInTx(tx, kill, plan) {
    const seen = journal.findByKey(tx, plan.key);
    if (!seen.ok) throw new Rollback(seen.reason);
    if (seen.found) return { outcome: "DEBOUNCED" };
    if (plan.legacyKey) {
      const old = journal.findByKey(tx, plan.legacyKey);
      if (!old.ok) throw new Rollback(old.reason);
      if (old.found) return { outcome: "DEBOUNCED" };
    }
    const cap = params.maxGrantsPerCharacterDay;
    if (cap > 0) {
      const prefix = S.dayPrefix(kill.characterId, plan.day);
      const c = journal.countKeyRange(tx, prefix, S.dayRangeEnd(prefix), cap);
      if (!c.ok) throw new Rollback(c.detail ? `${c.reason}:${c.detail}` : c.reason);
      if (c.count >= cap) return { outcome: "DAILY_CAP" };
    }
    const out = journal.enqueueOutbox(tx, { key: plan.key, aggregate: { type: "character",
      id: String(kill.characterId) }, eventType: S.EVENT_TYPE, payload: { characterId: kill.characterId,
      factionId: plan.factionId, systemId: kill.systemId, victimFactionId: kill.victimFactionId, day: plan.day,
      window: plan.window, atMs: kill.atMs, ...(S.isId(kill.victimId) ? { victimId: kill.victimId } : {}),
      rawChange: plan.rawChange, basis: plan.basis,
      source: plan.source } });
    if (out.ok && out.duplicate) return { outcome: "DEBOUNCED" };
    if (!out.ok && out.reason === "IDEMPOTENCY_CONFLICT") return { outcome: "DEBOUNCED" };
    if (!out.ok) throw new Rollback(out.reason);
    const r = scheduler.enqueue(S.EVENT_TYPE, String(kill.characterId), clock.now(),
      { characterId: kill.characterId, factionId: plan.factionId, journalId: out.journalId,
        rawChange: plan.rawChange, systemId: kill.systemId }, plan.key, { tx });
    if (!r || !r.ok) throw new Rollback((r && r.reason) || "ENQUEUE_FAILED");
    return { outcome: "GRANTED", key: plan.key, factionId: plan.factionId };
  }

  function onPirateSide(kill) {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      if (params.pirateSideEnabled !== true) return { ok: true, outcome: "OFF" };
      if (!kill || !S.isId(kill.characterId) || !S.isId(kill.victimFactionId) || !S.isId(kill.systemId)
        || !S.isTime(kill.atMs)) {
        bump("invalidKill");
        return { ok: true, outcome: "INVALID" };
      }
      if (clock.now() - kill.atMs > S.STALE_KILL_MS) {
        bump("staleKill");
        return { ok: true, outcome: "STALE_KILL" };
      }
      const vertex = vertexOf(kill.systemId);
      const t0 = nowMs();
      let result;
      try {
        result = store.transaction("standings.pirate", (tx) => {
          const got = repository.getSystem(tx, kill.systemId, { includeInfluence: false });
          if (!got.ok) throw new Rollback(got.reason);
          const plan = R.planPirateGrant(kill, got.system, vertex, rules);
          if (!plan.ok) return { outcome: plan.reason };
          return decideGrantInTx(tx, kill, plan);
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        result = { ok: false, reason: messageOf(err) };
      }
      const out = result && result.ok && result.value ? result.value : null;
      if (!out) {
        bump("txFailed");
        const reason = (result && result.reason) || "TX_FAILED";
        refuse("standings.pirate", reason);
        return { ok: false, reason: "STANDINGS_TX_FAILED", detail: reason };
      }
      const counter = PIRATE_OUTCOME_COUNTER[out.outcome];
      if (counter) bump(counter);
      const outcome = out.outcome === "KILL_INVALID_INPUT" ? "INVALID" : out.outcome;
      if (outcome === "GRANTED") metric("observe", "world.standings.killMs", Math.round((nowMs() - t0) * 100) / 100);
      return { ok: true, outcome, ...(outcome === "GRANTED" ? { key: out.key, factionId: out.factionId } : {}) };
    } catch (err) {
      bump("txFailed");
      refuse("standings.onPirateSide", messageOf(err));
      return { ok: false, reason: "STANDINGS_FAILED", detail: messageOf(err) };
    }
  }

  function chargeInTx(tx, p, plan) {
    const seen = journal.findByKey(tx, plan.key);
    if (!seen.ok) throw new Rollback(seen.reason);
    if (seen.found) return "DEBOUNCED";
    const out = journal.enqueueOutbox(tx, { key: plan.key, aggregate: { type: "character", id: String(p.characterId) },
      eventType: S.EVENT_TYPE, payload: { characterId: p.characterId, factionId: p.factionId, systemId: p.systemId,
        day: plan.day, window: plan.window, atMs: p.atMs, ...(S.isId(p.victimId) ? { victimId: p.victimId } : {}),
        rawChange: plan.rawChange, kind: p.kind } });
    if (out.ok && out.duplicate) return "DEBOUNCED";
    if (!out.ok && out.reason === "IDEMPOTENCY_CONFLICT") return "DEBOUNCED";
    if (!out.ok) throw new Rollback(out.reason);
    const r = scheduler.enqueue(S.EVENT_TYPE, String(p.characterId), clock.now(),
      { characterId: p.characterId, factionId: p.factionId, journalId: out.journalId, rawChange: plan.rawChange,
        systemId: p.systemId }, plan.key, { tx });
    if (!r || !r.ok) throw new Rollback((r && r.reason) || "ENQUEUE_FAILED");
    return "CHARGED";
  }

  function onNavyPenalty(p) {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      if (params.navyPenaltyEnabled !== true) return { ok: true, outcome: "OFF" };
      const plan = R.planNavyPenalty(p, params);
      if (!plan.ok) {
        bump("invalidKill");
        return { ok: true, outcome: "INVALID" };
      }
      if (clock.now() - p.atMs > S.STALE_KILL_MS) {
        bump("staleKill");
        return { ok: true, outcome: "STALE_KILL" };
      }
      let result;
      try {
        result = store.transaction("standings.navy", (tx) => chargeInTx(tx, p, plan));
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        result = { ok: false, reason: messageOf(err) };
      }
      if (!result || !result.ok || typeof result.value !== "string") {
        bump("txFailed");
        const reason = (result && result.reason) || "TX_FAILED";
        refuse("standings.navy", reason);
        return { ok: false, reason: "STANDINGS_TX_FAILED", detail: reason };
      }
      bump(result.value === "CHARGED" ? "navyCharged" : "navyDebounced");
      return { ok: true, outcome: result.value };
    } catch (err) {
      bump("txFailed");
      refuse("standings.onNavyPenalty", messageOf(err));
      return { ok: false, reason: "STANDINGS_FAILED", detail: messageOf(err) };
    }
  }

  function onConvoyPenalty(p) {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      if (params.convoyPenaltyEnabled !== true) return { ok: true, outcome: "OFF" };
      const plan = R.planConvoyPenalty(p, params);
      if (!plan.ok) {
        bump("invalidKill");
        return { ok: true, outcome: "INVALID" };
      }
      if (clock.now() - p.atMs > S.STALE_KILL_MS) {
        bump("staleKill");
        return { ok: true, outcome: "STALE_KILL" };
      }
      let result;
      try {
        result = store.transaction("standings.convoy", (tx) => chargeInTx(tx, p, plan));
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        result = { ok: false, reason: messageOf(err) };
      }
      if (!result || !result.ok || typeof result.value !== "string") {
        bump("txFailed");
        const reason = (result && result.reason) || "TX_FAILED";
        refuse("standings.convoy", reason);
        return { ok: false, reason: "STANDINGS_TX_FAILED", detail: reason };
      }
      bump(result.value === "CHARGED" ? "convoyCharged" : "convoyDebounced");
      return { ok: true, outcome: result.value };
    } catch (err) {
      bump("txFailed");
      refuse("standings.onConvoyPenalty", messageOf(err));
      return { ok: false, reason: "STANDINGS_FAILED", detail: messageOf(err) };
    }
  }

  function onPirateKillCharge(kill) {
    try {
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      if (!(params.pirateKillChargeRaw > 0)) return { ok: true, outcome: "OFF" };
      const plan = R.planPirateKillCharge(kill, params);
      if (!plan.ok) {
        bump("invalidKill");
        return { ok: true, outcome: "INVALID" };
      }
      if (clock.now() - kill.atMs > S.STALE_KILL_MS) {
        bump("staleKill");
        return { ok: true, outcome: "STALE_KILL" };
      }
      const p = { kind: R.NAVY_KILL, characterId: kill.characterId, factionId: kill.victimFactionId,
        systemId: kill.systemId, atMs: kill.atMs, ...(S.isId(kill.victimId) ? { victimId: kill.victimId } : {}) };
      let result;
      try {
        result = store.transaction("standings.pirateKill", (tx) => chargeInTx(tx, p, plan));
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
        result = { ok: false, reason: messageOf(err) };
      }
      if (!result || !result.ok || typeof result.value !== "string") {
        bump("txFailed");
        const reason = (result && result.reason) || "TX_FAILED";
        refuse("standings.pirateKill", reason);
        return { ok: false, reason: "STANDINGS_TX_FAILED", detail: reason };
      }
      bump(result.value === "CHARGED" ? "pirateKillCharged" : "pirateKillDebounced");
      return { ok: true, outcome: result.value };
    } catch (err) {
      bump("txFailed");
      refuse("standings.onPirateKillCharge", messageOf(err));
      return { ok: false, reason: "STANDINGS_FAILED", detail: messageOf(err) };
    }
  }

  const markFailed = (journalId, detail) => (tx) => journal.markFailed(tx, journalId, detail);

  function handler(ev, hctx) {
    try {
      const p = S.parsePayload(ev && ev.payload);
      const key = ev && typeof ev.idempotencyKey === "string" ? ev.idempotencyKey : "";
      if (!p || key === "") {
        bump("invalidPayload");
        return { ok: false, reason: "STANDINGS_PAYLOAD_INVALID", permanent: true };
      }
      if (stopped) return { ok: false, reason: "STANDINGS_STOPPED" };
      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      const decidedAt = Number.isSafeInteger(ev.createdAt) ? ev.createdAt : ev.dueAt;
      const tag = `char=${p.characterId} faction=${p.factionId} system=${p.systemId} key=${key}`;
      if (now - decidedAt > params.grantMaxAgeMs) {
        return { ok: true, outcome: "EXPIRED", effect: markFailed(p.journalId, "EXPIRED"),
          onCommitted: () => {
            bump("expired");
            log(`standings: expired (age ${now - decidedAt} ms) ${tag}`);
          } };
      }
      const t0 = nowMs();
      const navy = p.rawChange < 0;
      const slot = (S.parseGrantKey(key) || {}).slot;
      const convoy = navy && S.isConvoySlot(slot);
      const pirateKill = navy && S.isPirateKillSlot(slot);
      const pirate = !navy && pirateIds.has(p.factionId);
      const grantReason = convoy ? S.REASON_CONVOY : pirateKill ? S.REASON_PIRATE_KILL : navy ? S.REASON_NAVY
        : pirate ? S.REASON_PIRATE_SIDE : S.REASON;
      const w = adapter.applyStandingGrant({ key, characterId: p.characterId, factionId: p.factionId,
        rawChange: p.rawChange, reason: grantReason },
      { eventTypeId: navy ? data.navyEventTypeId : data.eventTypeId, msgByReason: data.msgByReason });
      metric("observe", "world.standings.grantMs", Math.round((nowMs() - t0) * 100) / 100);
      if (w && w.ok === true) {
        const duplicate = w.outcome === "DUPLICATE";
        const change = navy ? String(p.rawChange) : `+${p.rawChange}`;
        return { ok: true, outcome: duplicate ? "DUPLICATE" : "APPLIED",
          effect: (tx) => journal.markApplied(tx, p.journalId),
          onCommitted: () => {
            bump(duplicate ? "duplicates" : pirate ? "pirateApplied" : "applied");
            log(duplicate ? `standings: ${change} duplicate ${tag}`
              : `standings: ${change} ${tag} standing ${w.previousStanding} -> ${w.standing}`);
          } };
      }
      const reason = (w && w.reason) || "STANDING_WRITE_FAILED";
      if (w && w.permanent === true) {
        const reused = reason === "IDEMPOTENCY_KEY_REUSED";
        const detail = reused ? KEY_REUSED_DETAIL : reason;
        return { ok: true, outcome: "FAILED", effect: markFailed(p.journalId, detail),
          onCommitted: () => {
            bump(reused ? "keyReused" : "failed");
            log(`standings: failed ${detail}${w.detail && !reused ? ` (${w.detail})` : ""} ${tag}`);
          } };
      }
      bump("transient");
      refuse("standings.handler", w && w.detail ? `${reason}:${w.detail}` : reason);
      return { ok: false, reason };
    } catch (err) {
      refuse("standings.handler", messageOf(err));
      return { ok: false, reason: `STANDINGS_GRANT_FAILED:${messageOf(err)}`.slice(0, MAX_DETAIL) };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "ready", seq, counters: Object.freeze({ ...counters }),
      lastRefusal });
  }

  return Object.freeze({
    onNpcKill,
    onNavyPenalty,
    onConvoyPenalty,
    onPirateKillCharge,
    handler,
    getStatus,
    params,
    stop() {
      stopped = true;
    },
    isStopped: () => stopped,
  });
}

module.exports = { createStandingsService, COUNTER_NAMES, KEY_REUSED_DETAIL };
