"use strict";

const { performance } = require("node:perf_hooks");
const { hashInput } = require("./contract");
const { classifyResolverRefusal, SETTLEMENT_VERSION } = require("./settlementPlan");
const { coolKey } = require("./contactService");

const TERMINAL = Object.freeze(["COMPLETED", "FAILED", "QUARANTINED"]);
const HOLDABLE = Object.freeze(["PENDING", "CLAIMED"]);
const RACE_REASONS = Object.freeze(["ALREADY_SETTLED", "BATTLE_TERMINAL", "MODE_MISMATCH"]);
const RETREAT_DISPOSITIONS = Object.freeze(["RETREATING", "REFITTING"]);
const AWAITING_LIVE = "AWAITING_LIVE";
const LIVE_UNSUPPORTED = "LIVE_UNSUPPORTED";
const RESOLVE = Object.freeze({ hold: false, tag: null });
const VIRTUAL = "VIRTUAL";
const LIVE_MODE = "LIVE_EVEJS";
const MAX_REASON_LENGTH = 64;
const MAX_DETAIL_LENGTH = 1000;
const LOG_WINDOW_MS = 60000;
const RECENT_SETTLED = 10;
const MS_DECIMALS = 100;

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const holdKey = (battleId, bucket) => `battle:${battleId}:hold:${bucket}`;
const cooldownKey = (battleId) => `battle:${battleId}:fail:v1:cooldown`;

function messageOf(err) {
  return String((err && err.message) || err);
}

const detailText = (v) => {
  if (v === undefined || v === null) return undefined;
  const text = String(v);
  return text.length === 0 ? undefined : text.slice(0, MAX_DETAIL_LENGTH);
};

function createResolutionService(deps) {
  const { store, battleRepository, settlement, cooldownRepository, contacts, resolver, catalog, params, settings,
    bump, observe, slowLog, logger } = deps;
  const hooks = deps.hooks || {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  let logWindow = null;
  let logged = 0;

  function holdDecision(systemId, battle, now) {
    const unknown = { hold: settings.holdWhenPresenceUnknown === true, tag: null };
    if (battle && battle.holdReason === LIVE_UNSUPPORTED) return { hold: false, tag: "unsupportedVirtual" };
    let presence = null;
    try {
      presence = deps.getPresence();
    } catch (_err) {
      presence = null;
    }
    if (!presence || typeof presence.getStatus !== "function") return RESOLVE;
    let st = null;
    try {
      st = presence.getStatus();
    } catch (_err) {
      st = null;
    }
    if (st && st.reason === "PRESENCE_DISABLED") return RESOLVE;
    if (!st || st.available !== true || st.stale === true) return unknown;
    if (settings.materializationEnabled !== true || !battle) {
      try {
        return { hold: presence.isObserved(systemId) === true, tag: null };
      } catch (_err) {
        return unknown;
      }
    }
    let d = null;
    try {
      d = presence.distanceToObserved(systemId, settings.holdRadius);
    } catch (_err) {
      d = null;
    }
    if (!d || d.ok !== true) return unknown;
    if (d.distance === 0) return { hold: true, tag: null };
    if (!Number.isSafeInteger(d.distance) || d.distance < 0) return RESOLVE;
    const createdAt = Number(battle.createdAt);
    const at = isTime(now) ? now : createdAt;
    return at - createdAt < settings.neighborHoldMaxMs ? { hold: true, tag: "heldNeighbor" } : RESOLVE;
  }

  const observedPolicy = (systemId, battle, now) => holdDecision(systemId, battle, now).hold;

  function cancelInTx(tx, battleId, at, reason, detail) {
    const read = battleRepository.getBattle(tx, battleId);
    if (!read.ok) return read;
    const b = read.battle;
    if (!b || TERMINAL.includes(b.state) || b.state === "LIVE" || b.mode === LIVE_MODE) {
      bump("resolution.raceNoop");
      return { ok: true, kind: "noop" };
    }
    const req = { battleId, at, reason: String(reason).slice(0, MAX_REASON_LENGTH) };
    const d = detailText(detail);
    if (d !== undefined) req.detail = d;
    const c = settlement.cancel(tx, req, SETTLEMENT_VERSION);
    if (!c.ok) {
      if (RACE_REASONS.includes(c.reason)) {
        bump("resolution.raceNoop");
        return { ok: true, kind: "noop" };
      }
      return c;
    }
    if (b.input.sideB.factionId === null) return { ok: true, kind: "cancelled", battleId, reason: req.reason };
    const untilAt = at + settings.recontactCooldownMs;
    const cd = cooldownRepository.recordInTx(tx, { systemId: b.systemId, factionA: b.input.sideA.factionId,
      factionB: b.input.sideB.factionId, untilAt, battleId }, cooldownKey(battleId));
    if (!cd.ok) return cd;
    const ev = contacts.requestContactCheckInTx(tx, { systemId: b.systemId, at: untilAt, key: coolKey(b.systemId, battleId) });
    if (!ev.ok) return ev;
    return { ok: true, kind: "cancelled", battleId, reason: req.reason };
  }

  function quarantineInTx(tx, battleId, reason, detail) {
    const req = { battleId, reason: String(reason).slice(0, MAX_REASON_LENGTH) };
    const d = detailText(detail);
    if (d !== undefined) req.detail = d;
    const q = settlement.quarantine(tx, req, SETTLEMENT_VERSION);
    if (!q.ok) {
      if (RACE_REASONS.includes(q.reason)) {
        bump("resolution.raceNoop");
        return { ok: true, kind: "noop" };
      }
      return q;
    }
    return { ok: true, kind: "quarantined", battleId, reason: req.reason };
  }

  function counted(value) {
    if (!value) return;
    if (value.kind === "cancelled") bump("resolution.cancelled");
    else if (value.kind === "quarantined") bump("resolution.quarantined");
    else if (value.kind === "exhausted") {
      bump("resolution.retriesExhausted");
      bump("resolution.cancelled");
    }
  }

  function cancelResult(battleId, at, reason, detail, kind) {
    return { ok: true, outcome: kind === "exhausted" ? "RETRIES_EXHAUSTED" : "CANCELLED",
      effect: (tx) => {
        const r = cancelInTx(tx, battleId, at, reason, detail);
        return r.ok && r.kind === "cancelled" && kind === "exhausted" ? { ...r, kind: "exhausted" } : r;
      },
      onCommitted: counted };
  }

  function logSettled(line, demo) {
    const now = nowMs();
    if (logWindow === null || now - logWindow >= LOG_WINDOW_MS) {
      logWindow = now;
      logged = 0;
    }
    if (!demo && logged >= settings.logSettledPerMin) return;
    if (!demo) logged += 1;
    logger.log(line);
  }

  function onSettledCommitted(battle, value, demo) {
    if (!value || value.kind !== "settled") {
      counted(value);
      return;
    }
    const s = value.settle;
    if (s.duplicate) return;
    bump("resolution.settled");
    bump(`outcome.${value.outcome}`);
    const sideOf = new Map();
    for (const f of battle.input.sideA.fleets) sideOf.set(f.fleetId, "A");
    for (const f of battle.input.sideB.fleets) sideOf.set(f.fleetId, "B");
    const lost = { A: 0, B: 0 };
    let retreats = 0;
    for (const f of s.fleets || []) {
      lost[sideOf.get(f.fleetId) || "B"] += f.lost || 0;
      if (RETREAT_DISPOSITIONS.includes(f.disposition)) retreats += 1;
    }
    if (retreats > 0) bump("retreats", retreats);
    deps.onSettled(Object.freeze({ battleId: battle.battleId, systemId: battle.systemId, outcome: value.outcome,
      destroyedA: lost.A, destroyedB: lost.B, at: value.at }));
    logSettled(`battle: settled ${battle.battleId} system=${battle.systemId} outcome=${value.outcome}`
      + ` destroyed=${lost.A}/${lost.B}${demo ? " demo" : ""}`, demo);
  }

  function resolveEffect(battle, p, inputHash, result, demo) {
    return (tx) => {
      const id = battle.battleId;
      let version = battle.version;
      let state = battle.state;
      let claimSeq = battle.claimSeq;
      const reread = () => {
        const g = battleRepository.getBattle(tx, id);
        if (!g.ok || !g.battle) return g.ok ? { ok: false, reason: "BATTLE_NOT_FOUND" } : g;
        version = g.battle.version;
        state = g.battle.state;
        claimSeq = g.battle.claimSeq;
        return { ok: true };
      };
      if (state === "PENDING" || (state === "CLAIMED" && battle.mode !== VIRTUAL)) {
        const c = battleRepository.claim(tx, { battleId: id, expectedVersion: version, mode: VIRTUAL },
          `battle:${id}:claim:${claimSeq + 1}:${VIRTUAL}`);
        if (!c.ok) return c;
        if (c.duplicate) {
          const r = reread();
          if (!r.ok) return r;
        } else {
          version = c.version;
          state = "CLAIMED";
          claimSeq = c.claimSeq;
        }
      }
      if (state === "CLAIMED") {
        const t = battleRepository.transition(tx, { battleId: id, expectedVersion: version, from: "CLAIMED",
          to: "RESOLVING" }, `battle:${id}:resolving:${claimSeq}`);
        if (!t.ok) return t;
        if (t.duplicate) {
          const r = reread();
          if (!r.ok) return r;
        } else version = t.version;
      }
      if (typeof hooks.beforeSettle === "function") hooks.beforeSettle(id);
      const s = settlement.settle(tx, { battleId: id, expectedVersion: version, inputHash, result, at: p.at },
        SETTLEMENT_VERSION);
      if (s.ok) {
        if (s.outcome === "QUARANTINED") return { ok: true, kind: "quarantined", battleId: id };
        return { ok: true, kind: "settled", settle: s, outcome: result.outcome, at: p.at, demo };
      }
      if (RACE_REASONS.includes(s.reason)) {
        bump("resolution.raceNoop");
        return { ok: true, kind: "noop" };
      }
      if (s.reason === "SETTLEMENT_TOO_LARGE") return cancelInTx(tx, id, p.at, "SETTLEMENT_TOO_LARGE");
      if (s.permanent === true) return quarantineInTx(tx, id, `SETTLE_REFUSED_${s.reason}`, s.detail);
      return s;
    };
  }

  function onResolution(ev, hctx) {
    try {
      const p = ev.payload;
      if (!p || typeof p.battleId !== "string" || p.battleId === "" || !isTime(p.at)) {
        return { ok: false, reason: "RESOLUTION_PAYLOAD_INVALID", permanent: true };
      }
      const now = hctx && isTime(hctx.now) ? hctx.now : ev.dueAt;
      const last = ev.attempts >= settings.maxAttempts;
      const tx = store.transaction("battle.resolutionRead", (db) => battleRepository.getBattle(db, p.battleId));
      const read = tx.ok ? tx.value : tx;
      if (!read || !read.ok) {
        if (last) return cancelResult(p.battleId, p.at, "RESOLUTION_RETRIES_EXHAUSTED", ev.lastError, "exhausted");
        return { ok: false, reason: (read && read.reason) || "TX_FAILED" };
      }
      const battle = read.battle;
      if (!battle) return { ok: false, reason: "BATTLE_NOT_FOUND", permanent: true };
      if (TERMINAL.includes(battle.state)) {
        bump("resolution.stale");
        return { ok: true, outcome: "STALE" };
      }
      if (battle.state === "LIVE" || battle.mode === LIVE_MODE) {
        bump("resolution.staleLive");
        return { ok: true, outcome: "STALE_LIVE" };
      }
      const decision = HOLDABLE.includes(battle.state) ? holdDecision(battle.systemId, battle, now) : RESOLVE;
      if (decision.tag === "unsupportedVirtual") bump("resolution.unsupportedVirtual");
      if (decision.hold) {
        const bucket = Math.floor(Math.max(ev.dueAt, now) / settings.holdRecheckMs) + 1;
        const dueAt = bucket * settings.holdRecheckMs;
        const mark = battle.state === "PENDING" && battle.holdReason !== AWAITING_LIVE;
        return { ok: true, outcome: AWAITING_LIVE,
          effect: mark ? (etx) => battleRepository.transition(etx, { battleId: battle.battleId,
            expectedVersion: battle.version, from: "PENDING", to: "PENDING", patch: { holdReason: AWAITING_LIVE } },
          `battle:${battle.battleId}:await:${battle.version}`) : undefined,
          reschedule: { dueAt, payload: { battleId: battle.battleId, at: dueAt },
            idempotencyKey: holdKey(battle.battleId, bucket) },
          onCommitted: () => {
            bump("resolution.held");
            if (decision.tag === "heldNeighbor") bump("resolution.heldNeighbor");
          } };
      }
      if (last && ev.attempts > 1) {
        return cancelResult(battle.battleId, p.at, "RESOLUTION_RETRIES_EXHAUSTED", ev.lastError, "exhausted");
      }
      let inputHash;
      try {
        inputHash = hashInput(battle.input);
      } catch (err) {
        return { ok: true, outcome: "QUARANTINED", effect: (etx) => quarantineInTx(etx, battle.battleId,
          "INPUT_HASH_FAILED", messageOf(err)), onCommitted: counted };
      }
      const t0 = nowMs();
      const r = resolver.resolve(battle.input, catalog, params);
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      observe("resolveMs", ms);
      if (slowLog.isSlow(ms)) slowLog.log(`battle: slow resolve ${battle.battleId} ${ms}ms`);
      if (!r || r.ok !== true) {
        const reason = (r && r.reason) || "RESOLVER_INTERNAL";
        if (classifyResolverRefusal(reason) === "FAIL") {
          return cancelResult(battle.battleId, p.at, reason, r && r.detail, "cancelled");
        }
        return { ok: true, outcome: "QUARANTINED", effect: (etx) => quarantineInTx(etx, battle.battleId, reason,
          r && r.detail), onCommitted: counted };
      }
      const diag = r.result.diagnostics;
      if (diag && Number.isFinite(diag.workUnits)) observe("workUnits", diag.workUnits);
      const demo = p.demo === true;
      return { ok: true, outcome: "RESOLVED", effect: resolveEffect(battle, p, inputHash, r.result, demo),
        onCommitted: (value) => onSettledCommitted(battle, value, demo) };
    } catch (err) {
      return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({ onResolution, observedPolicy, RECENT_SETTLED });
}

module.exports = { createResolutionService, holdKey, AWAITING_LIVE, RECENT_SETTLED };
