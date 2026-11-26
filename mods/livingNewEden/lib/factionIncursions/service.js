"use strict";

const S = require("./schema");
const { fingerprint } = require("../util/fingerprint");
const { createAbortSentinel } = require("../persistence/store");
const { placeAround } = require("./placement");
const { initialMilli, projectMilli } = require("./influence");
const { createProgress, refresh, validateRules } = require("./rules");
const { phaseOf } = require("./timeline");
const { rulesOf } = require("./data/catalog");
const { pickTargets, stepIncursion, settlementOf } = require("./decide");
const { holdPointsOf, systemIdsOfRow } = require("./consequence");
const { planConstellationDrops } = require("../nativeIncursions/consequence");
const N = require("../nativeIncursions/schema");

const COUNTER_NAMES = Object.freeze(["passes", "created", "noPlacement", "sitesPlanned", "sitePlanRefused",
  "siteCleared", "siteEnded", "clearsCapped", "rulesInvalid", "decidedDefeated", "decidedExpired", "decidedCancelled",
  "repelApplied", "settleRetry", "settleFailed",
  "effectsPublished", "effectsRefreshed", "effectsDrift",
  "rewardPoolPlanned", "rewardPoolSkipped",
  "dropsApplied", "dropsSkipped"]);
const PLAN_CLASS = "OPERATIONAL";
const SETTLE_CLASS = "SETTLEMENT";
const MODE = Object.freeze({ FULL: "running", DRAIN: "drain", STOPPED: "stopped" });
const HEAVY_FULL_STATE = "running";
const STALE = createAbortSentinel("factionIncursions.stale");
const REFUSED = createAbortSentinel("factionIncursions.refused");
const SAVEPOINT_ABORT = Symbol("factionIncursions.savepoint");

function writeGuard() {
  const g = { refusal: null,
    check(res, what) {
      if (res && res.ok === true) return;
      if (res && res.reason === "STALE") throw STALE;
      g.refusal = `${what} ${(res && res.reason) || "?"}${res && res.detail ? ` ${res.detail}` : ""}`;
      throw REFUSED;
    } };
  return g;
}
const MAX_DETAIL = 160;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function createFactionIncursionService(deps) {
  const { store, journal, repository: repo, settings: P, clock } = deps;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let mode = deps.mode === MODE.DRAIN ? MODE.DRAIN : MODE.FULL;
  let lastPassAt = null;
  let lastRefusal = null;
  let openCounts = { active: null, decided: null };
  let refusedInPass = false;
  let poolHolds = new Map();

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
    metric("count", `world.factionIncursions.${name}`, n);
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

  function refuse(line) {
    refusedInPass = true;
    if (line === lastRefusal) return;
    lastRefusal = line;
    logger.log(`factionIncursions: ${line}`);
  }

  const heavy = () => safe(() => deps.getHeavyEvents(), null);
  const hasMethod = (obj, name) => Boolean(obj) && typeof obj[name] === "function";
  const poolOn = P.rewardsPool === S.POOL_MODE.ON;

  function heavyReady() {
    const h = heavy();
    if (!hasMethod(h, "incursionParticipantsInTx") || !hasMethod(h, "planRewardPayoutsInTx")) return false;
    if (!hasMethod(h, "getStatus")) return true;
    const st = safe(() => h.getStatus(), null);
    return Boolean(st) && st.state === HEAVY_FULL_STATE;
  }

  function poolInTx(db, row, at) {
    if (!isId(row.beneficiaryFactionId)) return { ok: true, pool: { skipped: "NO_DEFENDER" } };
    const h = heavy();
    if (!hasMethod(h, "incursionParticipantsInTx") || !hasMethod(h, "planRewardPayoutsInTx")) {
      return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" };
    }
    const p = h.incursionParticipantsInTx(db, S.sitePrefixOf(row.incursionId, row.createdAt),
      P.rewards.maxPoolParticipants);
    if (!p || p.ok !== true) {
      if (p && p.reason === "INVALID_INPUT") return { ok: true, pool: { skipped: "INVALID_INPUT" } };
      return { ok: false, reason: (p && p.reason) || "HEAVY_EVENTS_UNAVAILABLE" };
    }
    if (p.characterIds.length === 0) return { ok: true, pool: { skipped: "NO_PARTICIPANT" } };
    const r = h.planRewardPayoutsInTx(db, { eventId: S.rewardEventIdOf(row.incursionId, row.createdAt),
      issuerFactionId: row.beneficiaryFactionId, systemId: row.targetSystemId, characterIds: p.characterIds,
      lpAmount: P.rewards.hqPoolLp, at });
    if (r && r.ok === true) return { ok: true, pool: { planned: r.planned } };
    const reason = (r && r.reason) || "HEAVY_EVENTS_UNAVAILABLE";
    return reason === "HEAVY_EVENTS_UNAVAILABLE" || reason === "TX_REQUIRED" ? { ok: false, reason }
      : { ok: true, pool: { skipped: reason } };
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let runIn = savepoints.get(tx);
    if (!runIn) {
      runIn = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "EFFECT_ERROR" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, runIn);
    }
    const holder = { refusal: null };
    try {
      return runIn(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      if (tx.inTransaction !== true) throw err;
      return { ok: false, reason: "EFFECT_ERROR", detail: messageOf(err) };
    }
  }

  function consequenceInTx(db2, row, effect) {
    const none = { ok: true, applied: 0, skipped: 0 };
    const C = P.consequences;
    const defeated = row.outcome === S.OUTCOME.DEFEATED;
    if (!defeated && row.outcome !== S.OUTCOME.EXPIRED) return none;
    const points = defeated ? C.defeatInfluencePoints : holdPointsOf(C.expireInfluencePoints, row.strengthMilli);
    if (!(points > 0)) return none;
    const ids = systemIdsOfRow(row.systems);
    if (ids.length === 0) return none;
    const world = safe(() => deps.getWorldRepository(), null);
    if (!hasMethod(world, "getSystems")) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const got = world.getSystems(db2, ids, { includeInfluence: false });
    if (!got || got.ok !== true) return { ok: false, reason: (got && got.reason) || "WORLD_READ_FAILED" };
    const plan = planConstellationDrops({ outcome: row.outcome, effect, targetSystemId: row.targetSystemId,
      systemIds: ids, systems: got.systems, claimantFactionId: row.factionId, claimStates: P.claimStates,
      defeatPoints: points, expirePoints: points, maxSystems: N.MAX_TALE_SYSTEMS });
    if (plan.length === 0) return none;
    const occ = safe(() => deps.getOccupation(), null);
    if (!hasMethod(occ, "dropInfluenceInTx")) return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
    let applied = 0;
    let skipped = 0;
    for (const p of plan) {
      const hold = p.kind === "hold";
      const key = (hold ? S.holdKeyOf : S.dropKeyOf)(row.incursionId, p.systemId);
      const r = inSavepoint(db2, () => occ.dropInfluenceInTx(db2, { systemId: p.systemId, factionId: p.factionId,
        points: p.points, at: row.decidedAt, reason: hold ? S.HOLD_REASON : S.DROP_REASON, allowNonController: true },
      key));
      if (r && r.ok === true) {
        if (r.written === true) applied += 1;
        else skipped += 1;
      } else if (r && N.RETRY_DROP_REFUSALS.includes(r.reason)) return { ok: false, reason: r.reason };
      else skipped += 1;
    }
    return { ok: true, applied, skipped };
  }

  function readOpen(limit, state) {
    const r = store.transaction("factionIncursions.read", (db) => {
      const listed = repo.listOpenInTx(db, state ? { limit, state } : { limit });
      if (!listed.ok) return listed;
      const count = repo.countOpenInTx(db);
      if (!count.ok) return count;
      return { ok: true, rows: listed.rows, count };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  function rulesHold(row) {
    if (!row.rules || safe(() => fingerprint(row.rules), null) !== row.rulesFingerprint) return false;
    return validateRules(row.rules).ok === true;
  }

  function stepOne(listed, at, planBudget, allowPlans) {
    const h = heavy();
    const guard = writeGuard();
    const r = store.transaction("factionIncursions.step", (db) => {
      const got = repo.getInTx(db, listed.incursionId);
      if (!got.ok) return got;
      const row = got.row;
      if (!row || row.state !== S.ROW_STATE.ACTIVE) return { ok: true, skipped: "STATE" };
      if (!rulesHold(row)) return { ok: true, skipped: "RULES" };
      const sites = repo.listSitesInTx(db, row.incursionId);
      if (!sites.ok) return sites;
      const facts = new Map();
      for (const site of sites.sites) {
        if (site.state !== S.SLOT_STATE.OPEN || typeof site.eventId !== "string") continue;
        const f = hasMethod(h, "getSiteInTx") ? h.getSiteInTx(db, site.eventId) : null;
        if (!f || f.ok !== true) return { ok: true, skipped: "SITE_READ", reason: (f && f.reason) || "HEAVY_UNAVAILABLE" };
        facts.set(site.eventId, f.site);
      }
      const d = stepIncursion(row, sites.sites, facts, at, { siteRespawnMs: P.siteRespawnMs, siteTtlMs: P.siteTtlMs,
        minSiteWindowMs: P.minSiteWindowMs, maxSiteClearsPerIncursion: P.maxSiteClearsPerIncursion,
        allowPlans: allowPlans && hasMethod(h, "planIncursionSiteInTx"), maxPlans: planBudget });
      const slots = new Map(d.slots.map((s) => [s.slotKey, s]));
      let planned = 0;
      let refused = 0;
      let cancelFailed = 0;
      const versionOf = new Map(sites.sites.map((s) => [s.slotKey, s.version]));
      for (const p of d.plans) {
        const site = sites.sites.find((s) => s.slotKey === p.slotKey);
        const r2 = h.planIncursionSiteInTx(db, { eventId: p.eventId, systemId: p.systemId, factionId: row.factionId,
          beneficiaryFactionId: row.beneficiaryFactionId, kind: p.kind, tier: p.tier, expiresAt: p.expiresAt, at });
        if (!r2 || r2.ok !== true) {
          refused += 1;
          refuse(`plan ${p.eventId} ${(r2 && (r2.detail || r2.reason)) || "?"}`);
          continue;
        }
        const base = slots.get(p.slotKey) || site;
        slots.set(p.slotKey, { slotKey: p.slotKey, version: versionOf.get(p.slotKey), state: S.SLOT_STATE.OPEN,
          dueAt: base.dueAt, clears: base.clears, incarnation: p.incarnation, eventId: p.eventId });
        planned += 1;
      }
      if (d.decide !== null) {
        for (const eventId of d.cancel) {
          const c = hasMethod(h, "cancelIncursionSiteInTx") ? h.cancelIncursionSiteInTx(db, { eventId, at }) : null;
          if (!c || c.ok !== true) cancelFailed += 1;
        }
      }
      for (const s of slots.values()) {
        guard.check(repo.updateSiteInTx(db, row.incursionId, s.slotKey, s.version, s), `site ${s.slotKey}`);
      }
      if (d.decide !== null) {
        guard.check(repo.decideInTx(db, row.incursionId, row.version, { outcome: d.decide.outcome,
          decidedAt: d.decide.at, hqEventId: d.decide.hqEventId, ...d.patch }), "decide");
      } else if (d.changed || planned > 0) {
        guard.check(repo.updateProgressInTx(db, row.incursionId, row.version, d.patch), "progress");
      }
      return { ok: true, d, planned, refused, cancelFailed };
    });
    if (!r.ok) {
      if (r.error === STALE) return { ok: true, stale: true, planned: 0 };
      if (r.error === REFUSED) return { ok: false, reason: "WRITE_REFUSED", detail: guard.refusal };
      return { ok: false, reason: r.reason, detail: r.error ? messageOf(r.error) : undefined };
    }
    const v = r.value;
    if (!v.ok) return v;
    if (v.skipped === "RULES") {
      bump("rulesInvalid");
      refuse(`incursion ${listed.incursionId} rules fingerprint or grammar invalid - skipped`);
    } else if (v.skipped === "SITE_READ") refuse(`incursion ${listed.incursionId} site read ${v.reason}`);
    if (!v.d) return { ok: true, planned: 0 };
    bump("siteCleared", v.d.clears.filter((c) => c.counted).length);
    bump("clearsCapped", v.d.clears.filter((c) => c.capped).length);
    bump("siteEnded", v.d.ended.length);
    bump("sitesPlanned", v.planned);
    bump("sitePlanRefused", v.refused);
    if (v.cancelFailed > 0) refuse(`incursion ${listed.incursionId} ${v.cancelFailed} site cancel(s) refused`);
    if (v.d.decide) {
      bump(v.d.decide.outcome === S.OUTCOME.DEFEATED ? "decidedDefeated" : "decidedExpired");
      logger.log(`factionIncursions: incursion ${listed.incursionId} ${v.d.decide.outcome} at ${v.d.decide.at}`);
    }
    return { ok: true, planned: v.planned, decided: v.d.decide ? 1 : 0 };
  }

  function stepPass(at) {
    const read = readOpen(P.maxIncursionsPerPass, S.ROW_STATE.ACTIVE);
    if (!read.ok) {
      refuse(`read ${read.reason}`);
      return { stepped: 0, planned: 0, decided: 0 };
    }
    const allowPlans = admits(PLAN_CLASS);
    let budget = P.maxSitePlansPerPass;
    let stepped = 0;
    let planned = 0;
    let decided = 0;
    for (const row of read.rows) {
      const r = stepOne(row, at, budget, allowPlans && budget > 0);
      if (!r.ok) {
        refuse(`step ${row.incursionId} ${r.reason}${r.detail ? ` ${r.detail}` : ""}`);
        continue;
      }
      stepped += 1;
      planned += r.planned || 0;
      decided += r.decided || 0;
      budget = Math.max(0, budget - (r.planned || 0));
    }
    return { stepped, planned, decided };
  }

  function settleOne(row, at, drain, poolSkip) {
    const exhausted = row.attempts >= P.settleMaxAttempts;
    let pool = null;
    const consOn = !drain && P.consequencesMode != null;
    const payload = consOn
      ? { incursionId: row.incursionId, outcome: row.outcome, targetSystemId: row.targetSystemId,
        factionId: row.factionId }
      : { incursionId: row.incursionId, outcome: row.outcome, targetSystemId: row.targetSystemId };
    let drops = null;
    const r = store.transaction("factionIncursions.settle", (db) => {
      let effect = S.EFFECT.RECORDED;
      pool = null;
      drops = null;
      const ap = journal.applyOnce(db, { key: S.settleKeyOf(row.incursionId),
        aggregate: { type: S.AGGREGATE, id: String(row.incursionId) }, eventType: S.EVENT_SETTLE, payload },
      (db2) => {
        if (drain) effect = S.EFFECT.DISABLED;
        else if (exhausted) effect = S.EFFECT.FAILED;
        else {
          let participants = [];
          if (row.outcome === S.OUTCOME.DEFEATED && typeof row.hqEventId === "string") {
            const h = heavy();
            const p = hasMethod(h, "siteParticipantsInTx") ? h.siteParticipantsInTx(db2, row.hqEventId, 1) : null;
            if (!p || p.ok !== true) return { ok: false, reason: (p && p.reason) || "HEAVY_EVENTS_UNAVAILABLE" };
            participants = p.characterIds;
          }
          const s = settlementOf(row, participants);
          if (s.kind === "RECORD") effect = s.effect;
          else {
            const occ = safe(() => deps.getOccupation(), null);
            if (!hasMethod(occ, "applyPlayerRepelInTx")) return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
            const rep = occ.applyPlayerRepelInTx(db2, { systemId: row.targetSystemId, factionId: row.factionId,
              huntId: S.huntIdOf(row.incursionId), characterId: s.characterId, at: row.decidedAt },
            S.repelKeyOf(row.incursionId));
            if (rep && rep.ok === true) effect = rep.outcome === "NO_INFLUENCE" ? S.EFFECT.NO_INFLUENCE : S.EFFECT.REPEL_APPLIED;
            else if (rep && S.FINAL_REPEL_REFUSALS.includes(rep.reason)) effect = rep.reason;
            else return { ok: false, reason: (rep && rep.reason) || "REPEL_FAILED" };
          }
          if (P.consequencesMode === S.CONSEQUENCES_MODE.ON) {
            const c = consequenceInTx(db2, row, effect);
            if (!c.ok) return c;
            drops = c;
          }
          if (poolOn && row.outcome === S.OUTCOME.DEFEATED && poolSkip) pool = { skipped: poolSkip };
          else if (poolOn && row.outcome === S.OUTCOME.DEFEATED) {
            const pl = poolInTx(db2, row, at);
            if (!pl.ok) return pl;
            pool = pl.pool;
          }
        }
        return repo.settleInTx(db2, row.incursionId, row.version, { effect, settledAt: at });
      });
      if (ap.ok) return { ok: true, effect: ap.duplicate === true ? null : effect };
      const reason = ap.reason === "APPLY_REFUSED" && ap.refusal ? ap.refusal.reason : ap.reason;
      if (reason === "STALE") return { ok: true, stale: true };
      const b = repo.bumpAttemptInTx(db, row.incursionId, row.version);
      return { ok: true, retry: true, reason, bumped: b.ok === true };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    const v = r.value;
    if (v.retry) {
      bump("settleRetry");
      refuse(`settle ${row.incursionId} retry ${v.reason}`);
    } else if (v.effect) {
      if (v.effect === S.EFFECT.REPEL_APPLIED) bump("repelApplied");
      if (v.effect === S.EFFECT.FAILED) bump("settleFailed");
      logger.log(`factionIncursions: incursion ${row.incursionId} settled ${row.outcome} effect=${v.effect}`
        + (P.consequencesMode === S.CONSEQUENCES_MODE.ON && !drain
          ? ` drops=${drops ? drops.applied : 0}/${drops ? drops.skipped : 0}` : ""));
      if (drops) {
        bump("dropsApplied", drops.applied);
        bump("dropsSkipped", drops.skipped);
      }
      if (pool && pool.skipped) {
        bump("rewardPoolSkipped");
        refuse(`rewards pool skipped ${pool.skipped}`);
      } else if (pool) bump("rewardPoolPlanned", pool.planned);
    }
    return v;
  }

  function settlePass(at, drain) {
    const read = readOpen(P.maxSettlementsPerPass, S.ROW_STATE.DECIDED);
    if (!read.ok) {
      refuse(`read ${read.reason}`);
      return 0;
    }
    const needsPool = (row) => poolOn && !drain && row.outcome === S.OUTCOME.DEFEATED
      && row.attempts < P.settleMaxAttempts;
    const waitingInPage = read.rows.some(needsPool);
    if (waitingInPage && !heavyReady()) return settleHeld(at);
    if (waitingInPage && poolHolds.size > 0) poolHolds = new Map();
    let settled = 0;
    for (const row of read.rows) {
      const r = settleOne(row, at, drain);
      if (!r.ok) refuse(`settle ${row.incursionId} ${r.reason}`);
      else if (r.effect) settled += 1;
    }
    return settled;
  }

  function settleHeld(at) {
    const max = P.maxSettlementsPerPass;
    const r = store.transaction("factionIncursions.readHeld", (db) => {
      const free = repo.listOpenInTx(db, { limit: max, state: S.ROW_STATE.DECIDED, poolWait: "exclude",
        maxAttempts: P.settleMaxAttempts });
      if (!free.ok) return free;
      const wait = repo.listOpenInTx(db, { limit: max, state: S.ROW_STATE.DECIDED, poolWait: "only",
        maxAttempts: P.settleMaxAttempts });
      if (!wait.ok) return wait;
      return { ok: true, free: free.rows, wait: wait.rows };
    });
    const read = r.ok ? r.value : null;
    if (!read || read.ok !== true) {
      refuse(`read ${(read && read.reason) || r.reason || "?"}`);
      return 0;
    }
    let budget = max;
    let settled = 0;
    const settle = (row, poolSkip) => {
      budget -= 1;
      const v = settleOne(row, at, false, poolSkip);
      if (!v.ok) refuse(`settle ${row.incursionId} ${v.reason}`);
      else if (v.effect) settled += 1;
    };
    for (const row of read.free) settle(row);
    const holds = new Map();
    let waiting = 0;
    for (const row of read.wait) {
      const n = poolHolds.get(row.incursionId) || 0;
      if (n >= P.rewards.poolMaxHoldPasses && budget > 0) {
        holds.set(row.incursionId, n);
        settle(row, "HEAVY_EVENTS_UNAVAILABLE");
        continue;
      }
      holds.set(row.incursionId, Math.min(n + 1, P.rewards.poolMaxHoldPasses));
      waiting += 1;
    }
    poolHolds = holds;
    if (waiting > 0) {
      bump("settleRetry", waiting);
      refuse("settle retry HEAVY_EVENTS_UNAVAILABLE");
    }
    return settled;
  }

  function readClaims(graph) {
    const world = safe(() => deps.getWorldRepository(), null);
    if (!hasMethod(world, "listByOccupier")) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const r = store.transaction("factionIncursions.claims", (db) => {
      const rows = [];
      for (const factionId of P.factionIds) {
        let after = 0;
        let read = 0;
        for (;;) {
          const page = world.listByOccupier(db, factionId, { limit: P.maxTargets, afterSystemId: after,
            includeInfluence: true });
          if (!page || page.ok !== true) return { ok: false, reason: (page && page.reason) || "CLAIMS_READ_FAILED" };
          for (const s of page.systems) {
            if (!P.claimStates.includes(s.occupationState)) continue;
            const vertex = safe(() => graph.getSystem(s.systemId), null);
            const inf = (Array.isArray(s.influence) ? s.influence : []).find((x) => x.factionId === factionId);
            rows.push({ systemId: s.systemId, factionId, phaseSeq: Number(s.phaseSeq) || 0,
              occupationState: s.occupationState, constellationId: vertex ? vertex.constellationId : 0,
              controllerFactionId: isId(s.controllerFactionId) ? s.controllerFactionId : null,
              score: inf && Number.isFinite(inf.influenceScore) ? inf.influenceScore : 0 });
          }
          read += page.systems.length;
          if (read >= P.maxTargets || page.nextAfterSystemId === null) break;
          after = page.nextAfterSystemId;
        }
      }
      const existing = new Set();
      for (const row of rows) {
        const key = S.idempotencyKeyOf(row.factionId, row.systemId, row.phaseSeq);
        const f = repo.findByKeyInTx(db, key);
        if (!f.ok) return f;
        if (f.incursionId !== null) existing.add(key);
      }
      const count = repo.countOpenInTx(db);
      if (!count.ok) return count;
      return { ok: true, rows, existing, count };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  function createOne(target, claim, placed, at) {
    const rules = rulesOf(target.factionId);
    if (!rules || !validateRules(rules).ok) return { ok: false, reason: "RULES_INVALID" };
    const I = P.influence;
    const influence = initialMilli(claim.score, I);
    const key = S.idempotencyKeyOf(target.factionId, target.systemId, target.phaseSeq);
    const progress = refresh(createProgress(rules), rules, { influenceMilli: influence, hqUnlockMilli: I.hqUnlockMilli });
    const systemOfRole = new Map(placed.systems.map((s) => [s.role, s.systemId]));
    const slots = [];
    for (const stage of rules.stages) {
      const systemId = systemOfRole.has(stage.role) ? systemOfRole.get(stage.role) : placed.systems[0].systemId;
      for (let i = 0; i < stage.slots; i += 1) {
        slots.push({ slotKey: S.slotKeyOf(stage.key, i, stage.slots), stageKey: stage.key, systemId, kind: stage.kind,
          tier: stage.tier });
      }
    }
    const mobilizingAt = at + P.establishedMs;
    const withdrawingAt = mobilizingAt + P.mobilizingMs;
    const spec = { idempotencyKey: key, factionId: target.factionId, constellationId: placed.constellationId,
      secClass: placed.secClass, targetSystemId: target.systemId, claimPhaseSeq: target.phaseSeq,
      beneficiaryFactionId: claim.controllerFactionId, strengthMilli: Math.min(1000, Math.max(0,
        Math.round(claim.score * 10))), systems: placed.systems, rules, rulesFingerprint: fingerprint(rules), progress,
      influenceMilli: influence, createdAt: at, graceMinutes: I.graceMinutes, decayMilliPerHour: I.decayMilliPerHour,
      perCompletionMilli: I.perCompletionMilli, hqUnlockMilli: I.hqUnlockMilli, mobilizingAt, withdrawingAt,
      expiresAt: withdrawingAt + P.withdrawingMs };
    const r = store.transaction("factionIncursions.create", (db) => {
      const count = repo.countOpenInTx(db);
      if (!count.ok) return count;
      if (count.count >= P.maxActive) return { ok: true, created: false, why: "LIMIT" };
      if ((count.byFaction.get(target.factionId) || 0) >= P.maxActivePerFaction) {
        return { ok: true, created: false, why: "LIMIT" };
      }
      if (count.constellations.has(placed.constellationId)) return { ok: true, created: false, why: "BUSY" };
      let incursionId = null;
      const ap = journal.applyOnce(db, { key: S.createKeyOf(key), aggregate: { type: S.AGGREGATE, id: key },
        eventType: S.EVENT_CREATE, payload: { factionId: target.factionId, systemId: target.systemId,
          phaseSeq: target.phaseSeq } }, (db2) => {
        const ins = repo.insertInTx(db2, spec, slots);
        if (ins.ok) incursionId = ins.incursionId;
        return ins;
      });
      if (!ap.ok) return ap.reason === "APPLY_REFUSED" && ap.refusal ? ap.refusal : ap;
      return { ok: true, created: ap.duplicate !== true, incursionId };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  function createPass(at) {
    if (P.maxCreatesPerPass <= 0 || P.maxActive <= 0 || !admits(PLAN_CLASS)) return 0;
    const g = safe(() => deps.getGraph(), null);
    const got = hasMethod(g, "getGraph") ? safe(() => g.getGraph(), null) : null;
    const graph = got && got.ok === true && got.graph ? got.graph : null;
    if (!graph) return 0;
    const claims = readClaims(graph);
    if (!claims.ok) {
      refuse(`claims ${claims.reason}`);
      return 0;
    }
    if (claims.count.count >= P.maxActive) return 0;
    const targets = pickTargets(claims.rows, { claimStates: P.claimStates, factionIds: P.factionIds,
      occupiedConstellations: claims.count.constellations, existingKeys: claims.existing, maxTargets: P.maxTargets });
    let created = 0;
    for (const target of targets) {
      if (created >= P.maxCreatesPerPass) break;
      const claim = claims.rows.find((c) => c.systemId === target.systemId && c.factionId === target.factionId);
      const placed = placeAround(graph, target.systemId, { systems: P.systems, minSystems: P.minSystems });
      if (!placed.ok) {
        bump("noPlacement");
        refuse(`no placement ${target.factionId}@${target.systemId} ${placed.reason}`);
        continue;
      }
      const r = createOne(target, claim, placed, at);
      if (!r.ok) {
        refuse(`create ${target.factionId}@${target.systemId} ${r.reason}`);
        continue;
      }
      if (r.why === "LIMIT") break;
      if (r.created) {
        created += 1;
        bump("created");
        logger.log(`factionIncursions: incursion ${r.incursionId} created faction=${target.factionId} `
          + `target=${target.systemId} constellation=${placed.constellationId} systems=${placed.systems.length}`);
      }
    }
    return created;
  }

  function cancelOne(listed, at) {
    const h = heavy();
    const guard = writeGuard();
    const r = store.transaction("factionIncursions.drain", (db) => {
      const got = repo.getInTx(db, listed.incursionId);
      if (!got.ok) return got;
      const row = got.row;
      if (!row || row.state !== S.ROW_STATE.ACTIVE) return { ok: true, cancelled: false };
      const sites = repo.listSitesInTx(db, row.incursionId);
      if (!sites.ok) return sites;
      let cancelFailed = 0;
      for (const site of sites.sites) {
        if (site.state === S.SLOT_STATE.OPEN && typeof site.eventId === "string") {
          const c = hasMethod(h, "cancelIncursionSiteInTx") ? h.cancelIncursionSiteInTx(db, { eventId: site.eventId, at })
            : null;
          if (!c || c.ok !== true) cancelFailed += 1;
        }
        if (site.state !== S.SLOT_STATE.CLOSED) {
          guard.check(repo.updateSiteInTx(db, row.incursionId, site.slotKey, site.version, { state: S.SLOT_STATE.CLOSED,
            dueAt: site.dueAt, clears: site.clears, incarnation: site.incarnation, eventId: site.eventId }),
          `site ${site.slotKey}`);
        }
      }
      guard.check(repo.decideInTx(db, row.incursionId, row.version, { outcome: S.OUTCOME.CANCELLED, decidedAt: at,
        hqEventId: null, influenceMilli: row.influenceMilli, influenceUpdatedAt: row.influenceUpdatedAt,
        progress: row.progress }), "decide");
      return { ok: true, cancelled: true, cancelFailed };
    });
    if (!r.ok) {
      if (r.error === STALE) return { ok: true, cancelled: false };
      if (r.error === REFUSED) return { ok: false, reason: "WRITE_REFUSED", detail: guard.refusal };
      return { ok: false, reason: r.reason };
    }
    if (r.value.ok && r.value.cancelled) bump("decidedCancelled");
    if (r.value.cancelFailed > 0) refuse(`drain ${listed.incursionId} ${r.value.cancelFailed} site cancel(s) refused`);
    return r.value;
  }

  function drainPass(at) {
    const read = readOpen(P.maxIncursionsPerPass, S.ROW_STATE.ACTIVE);
    if (!read.ok) {
      refuse(`drain read ${read.reason}`);
      return null;
    }
    for (const row of read.rows) {
      const r = cancelOne(row, at);
      if (!r.ok) refuse(`drain ${row.incursionId} ${r.reason}${r.detail ? ` ${r.detail}` : ""}`);
    }
    settlePass(at, true);
    const after = readOpen(1);
    if (!after.ok) return null;
    openCounts = { active: after.count.active, decided: after.count.decided };
    return after.count.count;
  }

  function runPass(now) {
    if (mode === MODE.STOPPED) return { ok: false, reason: "FACTION_INCURSIONS_STOPPED" };
    const t0 = nowMs();
    try {
      const at = Number.isSafeInteger(now) ? now : clock.now();
      refusedInPass = false;
      bump("passes");
      if (mode === MODE.DRAIN) {
        const left = drainPass(at);
        lastPassAt = at;
        if (!refusedInPass) lastRefusal = null;
        if (left === 0) {
          logger.log("factionIncursions: drain done - no open incursion left, service stops");
          stop();
          if (typeof deps.onDrained === "function") safe(() => deps.onDrained(), null);
        }
        return { ok: true, created: 0, stepped: 0, planned: 0, decided: 0, settled: 0, skipped: "DISABLED",
          left };
      }
      const step = stepPass(at);
      let settled = 0;
      let skipped;
      if (P.settle.enabled !== true) skipped = "DISABLED";
      else if (!admits(SETTLE_CLASS)) skipped = "GOVERNOR";
      else settled = settlePass(at, false);
      const created = createPass(at);
      const after = readOpen(1);
      if (after.ok) openCounts = { active: after.count.active, decided: after.count.decided };
      metric("gauge", "world.factionIncursions.active", openCounts.active || 0);
      lastPassAt = at;
      if (!refusedInPass) lastRefusal = null;
      if (typeof deps.onPassDone === "function") safe(() => deps.onPassDone(), null);
      return { ok: true, created, stepped: step.stepped, planned: step.planned, decided: step.decided, settled,
        ...(skipped ? { skipped } : {}) };
    } catch (err) {
      refuse(`pass threw - ${messageOf(err)}`);
      return { ok: false, reason: "FACTION_INCURSIONS_PASS_FAILED", detail: messageOf(err) };
    } finally {
      metric("observe", "world.factionIncursions.passMs", Math.max(0, nowMs() - t0));
    }
  }

  function listActive(opts) {
    if (mode === MODE.STOPPED) return { ok: false, reason: "FACTION_INCURSIONS_STOPPED" };
    const limit = opts && isId(opts.limit) ? opts.limit : P.maxActive || 1;
    if (typeof store.isInTransaction === "function" && store.isInTransaction()) return { ok: false, reason: "TX_ACTIVE" };
    const read = readOpen(limit);
    if (!read.ok) return { ok: false, reason: read.reason };
    const now = clock.now();
    return { ok: true, incursions: read.rows.map((row) => {
      const influence = projectMilli({ valueMilli: row.influenceMilli, updatedAt: row.influenceUpdatedAt,
        graceMinutes: row.graceMinutes, decayMilliPerHour: row.decayMilliPerHour }, now);
      return Object.freeze({ incursionId: row.incursionId, factionId: row.factionId,
        constellationId: row.constellationId, targetSystemId: row.targetSystemId, systems: row.systems,
        influenceMilli: influence === null ? row.influenceMilli : influence, state: row.state,
        phase: phaseOf(row, now), expiresAt: row.expiresAt,
        influenceRawMilli: row.influenceMilli, influenceUpdatedAt: row.influenceUpdatedAt,
        graceMinutes: row.graceMinutes, decayMilliPerHour: row.decayMilliPerHour });
    }) };
  }

  function getStatus() {
    return Object.freeze({ state: mode, active: openCounts.active, decided: openCounts.decided, lastPassAt,
      lastRefusal, settle: P.settle.enabled === true,
      ...(P.rewardsPool ? { rewards: P.rewardsPool } : {}),
      ...(P.consequencesMode ? { consequences: P.consequencesMode } : {}),
      counters: Object.freeze({ ...counters }) });
  }

  function stop() {
    mode = MODE.STOPPED;
  }

  return Object.freeze({ runPass, getStatus, listActive, stop, isStopped: () => mode === MODE.STOPPED, bump });
}

module.exports = { createFactionIncursionService, COUNTER_NAMES, MODE };
