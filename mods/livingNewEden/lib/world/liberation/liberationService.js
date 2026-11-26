"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const R = require("./liberationRules");
const RS = require("./rewardSchema");
const RR = require("./rewardRules");
const { createRewardRepository } = require("./rewardRepository");
const { STANDINGS_DATA_V1 } = require("../standings/data/standingsData");

const COUNTER_NAMES = Object.freeze(["killsSeen", "applied", "duplicates", "noRow", "notController", "noController",
  "rateLimited", "invalidKill", "checks", "recovered", "stale", "inProgress", "liberated", "abandonRefused",
  "txFailed", "invalidPayload", "coreProtected", "contributions", "contributionsCapped", "rewardsPlanned",
  "rewardRecipients", "rewardNoContributors", "rewardCooldown", "rewardNoIssuer", "rewardDuplicates",
  "payoutsPaid", "payoutsFailed", "payoutRetries", "payoutDuplicates", "payoutFingerprintMismatch", "payoutDeferred",
  "payoutsPruned", "contributionsPruned",
  "virtualKillsScaled",
  "nonControllerApplied"]);
const PARAM_KEYS = Object.freeze(["killInfluencePoints", "minControllerScore", "holdMs", "maxKillsPerPlayerSystemHour",
  "rateMapSweep", "rewardsEnabled", "rewardIskPerSystem", "rewardLpPerSystem", "rewardMinKills", "rewardMaxRecipients",
  "rewardMaxContributorsPerSystem", "rewardContributionWindowMs", "rewardSystemCooldownMs",
  "virtualKillPacingEnabled", "virtualKillInfluencePermille",
  "nonControllerKillsEnabled", "nonControllerKillInfluencePoints", "nonControllerVirtualKillPermille"]);
const ISSUER_DATA = Object.freeze({ eligible: STANDINGS_DATA_V1.eligibleBeneficiaries,
  rivalByPirate: STANDINGS_DATA_V1.rivalByPirate, lpCorpByFaction: RS.LP_CORP_BY_FACTION });
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err);
}

class Rollback extends Error {
  constructor(detail) {
    super(String(detail).slice(0, MAX_DETAIL));
    this.name = "LiberationRollback";
  }
}

function createLiberationService(deps) {
  const { store, repository, scheduler, occupation, clock, config } = deps;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const params = Object.freeze(Object.fromEntries(PARAM_KEYS.map((k) => [k, config.liberation[k]])));
  const journal = deps.journal && typeof deps.journal.applyOnce === "function" ? deps.journal : null;
  const graph = deps.graph || null;
  const rewards = deps.rewardRepository || createRewardRepository();
  const rewardsActive = params.rewardsEnabled === true && journal !== null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const rateCounts = new Map();
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

  function noteRate(kill, used, bucket) {
    if (rateCounts.size >= params.rateMapSweep) {
      for (const [k, v] of rateCounts) if (v.bucket !== bucket) rateCounts.delete(k);
    }
    rateCounts.set(R.rateKey(kill.characterId, kill.systemId), { bucket, n: used + 1 });
  }

  function onNpcKill(kill) {
    try {
      if (stopped) return { ok: false, reason: "LIBERATION_STOPPED" };
      if (!kill || !S.isId(kill.characterId) || !S.isId(kill.victimFactionId) || !S.isId(kill.systemId)
        || !S.isTime(kill.atMs)) {
        bump("invalidKill");
        return { ok: true, outcome: "INVALID" };
      }
      bump("killsSeen");
      const rk = R.rateKey(kill.characterId, kill.systemId);
      const bucket = R.rateBucket(kill.atMs);
      const entry = rateCounts.get(rk);
      const used = entry && entry.bucket === bucket ? entry.n : 0;
      if (used >= params.maxKillsPerPlayerSystemHour) {
        bump("rateLimited");
        return { ok: true, outcome: "RATE_LIMITED" };
      }
      const key = S.killKey(kill.systemId, kill.characterId, kill.victimFactionId, kill.atMs, kill.victimId);
      const legacy = S.legacyKillKey(kill.systemId, kill.characterId, kill.victimFactionId, kill.atMs, kill.victimId);
      const scaled = params.virtualKillPacingEnabled === true && kill.virtual === true;
      const points = scaled ? params.killInfluencePoints * params.virtualKillInfluencePermille / 1000
        : params.killInfluencePoints;
      const ncPoints = params.nonControllerKillsEnabled !== true ? 0 : kill.virtual === true
        ? params.nonControllerKillInfluencePoints * params.nonControllerVirtualKillPermille / 1000
        : params.nonControllerKillInfluencePoints;
      const ncOpts = { nonController: ncPoints > 0 };
      const t0 = nowMs();
      const result = store.transaction("liberation.kill", (tx) => {
        for (const k of legacy ? [key, legacy] : [key]) {
          const applied = repository.isApplied(tx, k);
          if (!applied.ok) throw new Rollback(applied.reason);
          if (applied.applied) return { outcome: "DUPLICATE" };
        }
        const got = repository.getSystem(tx, kill.systemId, { includeInfluence: true });
        if (!got.ok) throw new Rollback(got.reason);
        if (!got.system) return { outcome: "NO_ROW" };
        const plan = R.planKillDrop(kill, got.system, ncOpts);
        if (!plan.ok) return { outcome: plan.reason };
        if (plan.nonController) {
          const nd = occupation.dropInfluenceInTx(tx, { systemId: kill.systemId, factionId: plan.target,
            points: ncPoints, at: kill.atMs, reason: "NONCONTROLLER_KILL", allowNonController: true }, key);
          if (!nd || !nd.ok || nd.outcome !== "APPLIED") {
            throw new Rollback((nd && (nd.reason || nd.outcome)) || "DROP_FAILED");
          }
          return { outcome: "APPLIED", nonController: true, nextScore: nd.next, check: false, drifted: nd.drifted,
            contribution: null };
        }
        const d = occupation.dropInfluenceInTx(tx, { systemId: kill.systemId, factionId: plan.controller,
          points, at: kill.atMs, reason: "LIBERATION_KILL" }, key);
        if (!d || !d.ok || d.outcome !== "APPLIED") {
          throw new Rollback((d && (d.reason || d.outcome)) || "DROP_FAILED");
        }
        let contribution = null;
        if (rewardsActive && kill.rewardable === true && kill.navy !== true) {
          const c = rewards.recordContributionInTx(tx, { systemId: kill.systemId, controllerFactionId: plan.controller,
            characterId: kill.characterId, at: kill.atMs, windowStart: kill.atMs - params.rewardContributionWindowMs,
            maxPerSystem: params.rewardMaxContributorsPerSystem });
          if (!c || !c.ok) throw new Rollback((c && (c.detail || c.reason)) || "CONTRIBUTION_FAILED");
          contribution = c.outcome;
        }
        let check = false;
        if (d.next < params.minControllerScore) {
          const dueAt = kill.atMs + params.holdMs;
          const bucket = S.bucketOf(dueAt);
          const payload = { systemId: kill.systemId, seq: d.phaseSeq, bucket };
          const r = scheduler.enqueue(S.EVENT_TYPE, String(kill.systemId), dueAt, payload,
            S.checkKeyOfBucket(kill.systemId, d.phaseSeq, bucket), { tx });
          if (!r || !r.ok) throw new Rollback((r && r.reason) || "ENQUEUE_FAILED");
          check = true;
        }
        return { outcome: "APPLIED", nextScore: d.next, check, drifted: d.drifted, contribution };
      });
      if (result && result.ok === false && result.error instanceof Rollback) {
        bump("txFailed");
        refuse("liberation.kill", messageOf(result.error));
        return { ok: false, reason: "LIBERATION_TX_FAILED", detail: messageOf(result.error) };
      }
      const out = result && result.ok && result.value ? result.value : null;
      if (!out) {
        bump("txFailed");
        refuse("liberation.kill", (result && result.reason) || "TX_FAILED");
        return { ok: false, reason: (result && result.reason) || "TX_FAILED" };
      }
      bump(out.outcome === "APPLIED" ? (out.nonController === true ? "nonControllerApplied" : "applied")
        : out.outcome === "DUPLICATE" ? "duplicates"
          : out.outcome === "NO_ROW" ? "noRow"
            : out.outcome === "NOT_CONTROLLER" ? "notController"
              : out.outcome === "NO_CONTROLLER" ? "noController" : "invalidKill");
      if (out.outcome === "APPLIED") {
        noteRate(kill, used, bucket);
        if (scaled && out.nonController !== true) bump("virtualKillsScaled");
        if (out.contribution === "CAPPED") bump("contributionsCapped");
        else if (out.contribution !== null) bump("contributions");
        if (out.drifted > 0 && typeof occupation.count === "function") {
          try {
            occupation.count("stableDrift");
          } catch (_err) {
          }
        }
        metric("observe", "world.liberation.killMs", Math.round((nowMs() - t0) * 100) / 100);
      }
      return { ok: true, outcome: out.outcome, ...(out.outcome === "APPLIED"
        ? { ...(out.nonController === true ? { nonController: true } : {}), nextScore: out.nextScore,
          checkScheduled: out.check } : {}) };
    } catch (err) {
      bump("txFailed");
      refuse("liberation.onNpcKill", messageOf(err));
      return { ok: false, reason: "LIBERATION_FAILED", detail: messageOf(err) };
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

  function planRewardInTx(tx, { sys, phaseSeq, at }) {
    const systemId = sys.systemId;
    const controller = sys.controllerFactionId;
    const windowStart = at - params.rewardContributionWindowMs;
    const win = { systemId, controllerFactionId: controller, windowStart,
      limit: params.rewardMaxContributorsPerSystem };
    const clear = () => {
      const c = rewards.clearContributionsInTx(tx, win);
      if (!c || !c.ok) throw new Rollback((c && (c.detail || c.reason)) || "CONTRIBUTION_CLEAR_FAILED");
    };
    const last = rewards.lastPayoutAtInTx(tx, systemId);
    if (!last || !last.ok) throw new Rollback((last && (last.detail || last.reason)) || "PAYOUT_READ_FAILED");
    if (last.lastPlannedAt !== null && at - last.lastPlannedAt < params.rewardSystemCooldownMs) {
      clear();
      return { outcome: "COOLDOWN", recipients: 0 };
    }
    const list = rewards.listContributionsInTx(tx, win);
    if (!list || !list.ok) throw new Rollback((list && (list.detail || list.reason)) || "CONTRIBUTION_READ_FAILED");
    const vertex = vertexOf(systemId);
    const issuer = RR.resolveRewardIssuer({ controllerFactionId: controller, homeFactionId: sys.homeFactionId },
      vertex, ISSUER_DATA);
    const plan = RR.planShares(list.rows, { iskPool: params.rewardIskPerSystem,
      lpPool: issuer.lpCorporationId !== null ? params.rewardLpPerSystem : 0, minKills: params.rewardMinKills,
      maxRecipients: params.rewardMaxRecipients });
    if (!plan.ok) throw new Rollback(plan.reason);
    if (plan.shares.length === 0) {
      clear();
      return { outcome: "NO_CONTRIBUTORS", recipients: 0 };
    }
    const libKey = RS.libpayKey(systemId, phaseSeq, at);
    const description = RS.descriptionOf(vertex && vertex.name, systemId);
    const rows = plan.shares.map((s) => ({ payoutKey: RS.payoutKeyOf(libKey, s.characterId), liberationKey: libKey,
      systemId, characterId: s.characterId, controllerFactionId: controller, beneficiaryFactionId: issuer.factionId,
      lpCorporationId: issuer.lpCorporationId, kills: s.kills, iskAmount: s.isk, lpAmount: s.lp, description }));
    const r = journal.applyOnce(tx, { key: libKey, aggregate: { type: RS.AGGREGATE_TYPE, id: systemId },
      eventType: RS.LIBERATION_REWARD, payload: { systemId, seq: phaseSeq, at, controller,
        beneficiary: issuer.factionId, lpCorp: issuer.lpCorporationId,
        shares: plan.shares.map((s) => ({ c: s.characterId, k: s.kills, isk: s.isk, lp: s.lp })) } }, (db) => {
      const ins = rewards.insertPayoutsInTx(db, rows, at);
      if (!ins || !ins.ok) return ins || { ok: false, reason: "PAYOUT_INSERT_FAILED" };
      const c = rewards.clearContributionsInTx(db, win);
      if (!c || !c.ok) return c || { ok: false, reason: "CONTRIBUTION_CLEAR_FAILED" };
      return { ok: true, inserted: ins.inserted };
    });
    if (!r || !r.ok) {
      const why = r && r.refusal ? (r.refusal.detail || r.refusal.reason) : null;
      throw new Rollback(`${(r && r.reason) || "REWARD_PLAN_FAILED"}${why ? `:${why}` : ""}`);
    }
    if (r.duplicate) return { outcome: "DUPLICATE", recipients: 0 };
    return { outcome: "PLANNED", recipients: rows.length, noIssuer: issuer.source === "NONE" };
  }

  function handler(ev, hctx) {
    try {
      const p = S.parsePayload(ev && ev.payload);
      if (!p) {
        bump("invalidPayload");
        return { ok: false, reason: "LIBERATION_PAYLOAD_INVALID", permanent: true };
      }
      if (stopped) return { ok: false, reason: "LIBERATION_STOPPED" };
      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : clock.now();
      const key = ev && typeof ev.idempotencyKey === "string" && ev.idempotencyKey !== "" ? ev.idempotencyKey
        : S.checkKeyOfBucket(p.systemId, p.seq, p.bucket);
      const read = store.transaction("liberation.checkRead", (tx) => repository.getSystem(tx, p.systemId,
        { includeInfluence: true }));
      const got = read.ok ? read.value : read;
      if (!got || !got.ok) return { ok: false, reason: (got && got.reason) || "TX_FAILED" };
      const sys = got.system;
      if (!sys) return { ok: true, outcome: "NO_ROW", onCommitted: () => bump("noRow") };
      if (sys.phaseSeq !== p.seq) return { ok: true, outcome: "STALE", onCommitted: () => bump("stale") };
      const controller = sys.controllerFactionId;
      const plan = R.planLiberationCheck(occupation.effectiveScoreOf(sys, controller, now), params);
      if (!plan.liberate) return { ok: true, outcome: plan.reason, onCommitted: () => bump("recovered") };
      const written = store.transaction("liberation.check", (tx) => {
        const a = occupation.abandonInTx(tx, { systemId: p.systemId, at: now, factionId: controller },
          `${key}:abandon`);
        if (!a || !a.ok || a.changed !== true || !rewardsActive) return a;
        return { ...a, reward: planRewardInTx(tx, { sys, phaseSeq: p.seq, at: now }) };
      });
      if (written && written.ok === false && written.error instanceof Rollback) {
        bump("txFailed");
        refuse("liberation.reward", messageOf(written.error));
        return { ok: false, reason: `LIBERATION_REWARD_FAILED:${messageOf(written.error)}`.slice(0, MAX_DETAIL) };
      }
      const w = written.ok ? written.value : written;
      if (!w || !w.ok) {
        const reason = (w && w.reason) || "LIBERATION_CHECK_FAILED";
        if (reason === "OCCUPATION_IN_PROGRESS") {
          return { ok: true, outcome: "IN_PROGRESS", onCommitted: () => bump("inProgress") };
        }
        if (reason === "CORE_PROTECTED") {
          return { ok: true, outcome: "CORE_PROTECTED", onCommitted: () => bump("coreProtected") };
        }
        bump("abandonRefused");
        refuse("liberation.check", reason);
        return { ok: false, reason };
      }
      const changed = w.changed === true;
      const reward = w.reward || null;
      return { ok: true, outcome: changed ? "LIBERATED" : "NOOP",
        ...(reward ? { reward: { outcome: reward.outcome, recipients: reward.recipients } } : {}),
        onCommitted: () => {
          bump("checks");
          if (changed) {
            bump("liberated");
            log(`liberation: system ${p.systemId} freed (controller ${controller} -> null)`
              + `${reward ? ` reward=${reward.outcome} recipients=${reward.recipients}` : ""}`);
            metric("observe", "world.liberation.liberated", 1);
          }
          if (!reward) return;
          if (reward.outcome === "PLANNED") {
            bump("rewardsPlanned");
            bump("rewardRecipients", reward.recipients);
            if (reward.noIssuer) bump("rewardNoIssuer");
          } else if (reward.outcome === "NO_CONTRIBUTORS") bump("rewardNoContributors");
          else if (reward.outcome === "COOLDOWN") bump("rewardCooldown");
          else if (reward.outcome === "DUPLICATE") bump("rewardDuplicates");
        } };
    } catch (err) {
      refuse("liberation.handler", messageOf(err));
      return { ok: false, reason: `LIBERATION_CHECK_FAILED:${messageOf(err)}`.slice(0, MAX_DETAIL) };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "ready", seq, counters: Object.freeze({ ...counters }),
      lastRefusal });
  }

  function count(name, n = 1) {
    if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
    bump(name, n);
  }

  return Object.freeze({
    onNpcKill,
    handler,
    getStatus,
    count,
    params,
    stop() {
      stopped = true;
    },
    isStopped: () => stopped,
  });
}

module.exports = { createLiberationService, COUNTER_NAMES };

