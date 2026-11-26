"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const R = require("./rules");
const M = require("./market");
const { planFameBounty } = require("./bounty");

const BOUNTY_WAIT_COUNTERS = Object.freeze({ DELAY: "bountyWaitDelay", NOT_IN_SPACE: "bountyWaitNotInSpace",
  SEC_CLASS: "bountyWaitSecClass" });
const BOUNTY_OUTCOME_COUNTERS = Object.freeze({ duplicate: "bountyDuplicate", skippedOpen: "bountyWaitOpen",
  gangNotReady: "bountyGangNotReady" });

const MS_DECIMALS = 10;
const NONE_RESULT = Object.freeze({ tier: S.TIER.NONE, standing: null });
const ALLOW = Object.freeze({ deny: false });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err);

function safeCall(fn, fallback = null) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function createFameService(deps) {
  const P = deps.settings;
  const { store, journal, clock } = deps;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const rp = Object.freeze({ legendMin: P.legendMin, enemyMax: P.enemyMax, hysteresis: R.effectiveHysteresis(P) });
  const counters = Object.fromEntries(S.FAME_COUNTER_NAMES.map((n) => [n, 0]));
  const lastTier = new Map();
  const cache = new Map();
  const enemySince = new Map();
  const bountyTriedAt = new Map();
  const bountyDoneFor = new Map();
  const noGangFactions = new Set();
  let cursor = 0;
  let stopped = false;
  let lastReviewAt = null;
  let factionNames = null;
  const policy = P.localEnabled === true ? Object.freeze({ permille: P.localRecognizePermille,
    cooldownMs: P.localRecognizeCooldownMs, maxCandidates: P.localMaxCandidates,
    contextOf: S.LOCAL_CONTEXT_OF_TIER }) : null;

  function metric(kind, name, v) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    safeCall(() => telemetry[kind](name, v));
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `fame.${name}`, n);
  }

  function admits(workClass) {
    const governor = safeCall(deps.getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    return safeCall(() => governor.admits(workClass) !== false, true);
  }

  function read(characterId, factionId) {
    const r = safeCall(() => deps.readStanding(characterId, factionId));
    if (!r || r.ok !== true) return { ok: false };
    const standing = Number(r.standing);
    return Number.isFinite(standing) ? { ok: true, standing } : { ok: false };
  }

  function setLastTier(k, tier) {
    if (lastTier.has(k)) {
      lastTier.delete(k);
    } else if (lastTier.size >= P.reviewMaxPairs) {
      lastTier.delete(lastTier.keys().next().value);
      bump("pairsEvicted");
    }
    lastTier.set(k, tier);
  }

  function cachePut(k, entry) {
    if (!cache.has(k) && cache.size >= P.cacheMaxEntries) cache.delete(cache.keys().next().value);
    cache.set(k, entry);
  }

  function tierOf(characterId, factionId) {
    try {
      if (stopped || !isId(characterId) || !isId(factionId)) return NONE_RESULT;
      const k = `${characterId}:${factionId}`;
      const at = clock.now();
      const hit = cache.get(k);
      if (hit && at - hit.at < P.cacheTtlMs) {
        bump("cacheHit");
        return { tier: hit.tier, standing: hit.standing };
      }
      bump("cacheMiss");
      const r = read(characterId, factionId);
      if (!r.ok) {
        bump("readFailed");
        return NONE_RESULT;
      }
      const tier = R.tierOf(r.standing, lastTier.get(k), rp);
      cachePut(k, { tier, standing: r.standing, at });
      return { tier, standing: r.standing };
    } catch (_err) {
      bump("errors");
      return NONE_RESULT;
    }
  }

  function factionNameOf(factionId, fallback = S.FACTION_FALLBACK) {
    if (factionNames === null) {
      const r = safeCall(deps.readFactionNames);
      factionNames = r && r.ok === true && r.names instanceof Map ? r.names : new Map();
    }
    const n = factionNames.get(factionId);
    return typeof n === "string" && n !== "" ? n : fallback;
  }

  function dockVerdict(q) {
    try {
      if (stopped || P.dockDenyEnabled !== true || !q || q.isCapsule === true || !isId(q.characterId)) return ALLOW;
      const seen = new Set();
      for (const factionId of Array.isArray(q.factionIds) ? q.factionIds : []) {
        if (!isId(factionId) || seen.has(factionId)) continue;
        seen.add(factionId);
        if (tierOf(q.characterId, factionId).tier !== S.TIER.PUBLIC_ENEMY) continue;
        bump("dockDenied");
        const name = factionNameOf(factionId, S.DOCK_FACTION_FALLBACK);
        return { deny: true, factionId, message: S.DOCK_DENY_TEMPLATE.replace("{faction}", name) };
      }
      return ALLOW;
    } catch (_err) {
      bump("dockFailOpen");
      return ALLOW;
    }
  }

  function marketSlot(context) {
    if (stopped || !context || typeof context !== "object") return context;
    const factionId = Number(context.station && context.station.factionID);
    const characterId = Number(context.characterID);
    if (context.isStation !== true || !isId(factionId) || !isId(characterId)) {
      bump("marketNoStation");
      return context;
    }
    const mod = M.marketModifierOf(tierOf(characterId, factionId).tier, P);
    const next = M.applyMarketModifier(context, mod, P);
    if (next !== context) bump("marketModified");
    return next;
  }

  function noticesNow() {
    if (P.noticesEnabled !== true) return null;
    const n = safeCall(deps.getNotices);
    if (!n || typeof n.enqueueItemsInTx !== "function" || typeof n.getStatus !== "function") return false;
    const st = safeCall(() => n.getStatus());
    return st && st.state === "running" ? n : false;
  }

  function playersNow() {
    const presence = safeCall(deps.getPresence);
    const list = presence && typeof presence.listPresence === "function" ? safeCall(() => presence.listPresence()) : null;
    const byId = new Map();
    for (const sys of Array.isArray(list) ? list : []) {
      if (!sys || !isId(sys.systemId) || !Array.isArray(sys.characters)) continue;
      for (const c of sys.characters) {
        if (c && isId(c.characterId) && !byId.has(c.characterId)) {
          byId.set(c.characterId, { systemId: sys.systemId, state: typeof c.state === "string" ? c.state : null });
        }
      }
    }
    return [...byId].map(([characterId, at]) => ({ characterId, systemId: at.systemId, state: at.state }))
      .sort((a, b) => a.characterId - b.characterId);
  }

  function factionsNow() {
    const registry = safeCall(deps.getRegistry);
    const list = registry && typeof registry.listActiveFactions === "function"
      ? safeCall(() => registry.listActiveFactions()) : null;
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((f) => (f ? f.factionId : null)).filter(isId))].sort((a, b) => a - b);
  }

  function announceInTx(tx, c, notices, now) {
    const key = S.tierKeyOf(c.characterId, c.factionId, c.tier, c.period);
    const spec = { key, aggregate: { type: S.AGGREGATE, id: `${c.characterId}:${c.factionId}` },
      eventType: S.EVENT_TIER_CHANGED,
      payload: { v: S.PAYLOAD_VERSION, characterId: c.characterId, factionId: c.factionId, tier: c.tier,
        period: c.period } };
    const r = journal.applyOnce(tx, spec, (tx2) => {
      if (notices === null) return { ok: true, mail: "off" };
      if (notices === false) return { ok: true, mail: "failed" };
      const line = S.MAIL_TEMPLATES[c.tier].replace("{faction}", factionNameOf(c.factionId));
      let q = null;
      try {
        q = notices.enqueueItemsInTx(tx2, [{ eventKey: key, characterId: c.characterId, kind: S.NOTICE_KIND,
          systemId: c.systemId, line, eventAt: now }], now);
      } catch (_err) {
        q = null;
      }
      if (q && q.ok === true) return { ok: true, mail: Number(q.inserted) > 0 ? "queued" : "duplicate" };
      return { ok: true, mail: "failed" };
    });
    if (r && r.ok === true && r.duplicate === true) return { outcome: "duplicate", mail: null };
    if (r && r.ok === true) return { outcome: "announced", mail: r.value ? r.value.mail : null };
    if (r && r.reason === "IDEMPOTENCY_CONFLICT") return { outcome: "duplicate", mail: null };
    return { outcome: "failed", mail: null, reason: (r && r.reason) || "no result" };
  }

  function announce(cands, now) {
    if (cands.length === 0) return 0;
    const notices = noticesNow();
    const r = store.transaction("fame.announce", (tx) => cands.map((c) => announceInTx(tx, c, notices, now)));
    if (!r || r.ok !== true || !Array.isArray(r.value)) {
      bump("errors");
      logger.log(`fame: announce failed - ${(r && r.reason) || "no result"}`);
      return 0;
    }
    let announced = 0;
    r.value.forEach((res, i) => {
      const c = cands[i];
      if (res.outcome === "failed") {
        bump("announceFailed");
        return;
      }
      setLastTier(c.k, c.tier);
      if (res.outcome === "duplicate") {
        bump("announceDuplicate");
        return;
      }
      announced += 1;
      bump("announced");
      if (res.mail === "queued") bump("noticesQueued");
      else if (res.mail === "failed") bump("noticesFailed");
    });
    return announced;
  }

  function noteEnemy(k, characterId, factionId, tier, standing, now) {
    if (P.bountyEnabled !== true) return;
    if (tier !== S.TIER.PUBLIC_ENEMY) {
      enemySince.delete(k);
      bountyTriedAt.delete(k);
      bountyDoneFor.delete(k);
      return;
    }
    const had = enemySince.get(k);
    if (had) {
      had.standing = standing;
      return;
    }
    if (enemySince.size >= P.reviewMaxPairs) {
      const oldest = enemySince.keys().next().value;
      enemySince.delete(oldest);
      bountyTriedAt.delete(oldest);
      bountyDoneFor.delete(oldest);
    }
    enemySince.set(k, { characterId, factionId, since: now, standing });
  }

  function graphNow() {
    const svc = safeCall(deps.getGraph);
    if (svc && typeof svc.getSystem === "function") return svc;
    const r = svc && typeof svc.getGraph === "function" ? safeCall(() => svc.getGraph()) : null;
    return r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
  }

  function bountyNotice(e, period, systemId, now) {
    const notices = noticesNow();
    if (notices === null) return;
    const line = S.BOUNTY_MAIL_TEMPLATE.replace("{faction}", factionNameOf(e.factionId));
    const r = notices === false ? null : store.transaction("fame.bountyNotice", (tx) => {
      try {
        return notices.enqueueItemsInTx(tx, [{ eventKey: S.bountyNoticeKeyOf(e.characterId, e.factionId, period),
          characterId: e.characterId, kind: S.NOTICE_KIND, systemId, line, eventAt: now }], now);
      } catch (_err) {
        return null;
      }
    });
    bump(r && r.ok === true && r.value && r.value.ok === true ? "bountyNoticesQueued" : "bountyNoticesFailed");
  }

  function bountyStep(players, now) {
    if (P.bountyEnabled !== true || enemySince.size === 0) return;
    const bounty = safeCall(deps.getBounty);
    if (!bounty || typeof bounty.postFameBounty !== "function") return;
    const graph = graphNow();
    const where = new Map(players.map((p) => [p.characterId, p]));
    const tried = (k) => (bountyTriedAt.has(k) ? bountyTriedAt.get(k) : -1);
    const order = [...enemySince].filter(([, e]) => !noGangFactions.has(e.factionId))
      .sort(([ka, a], [kb, b]) => tried(ka) - tried(kb) || a.since - b.since || (ka < kb ? -1 : ka > kb ? 1 : 0));
    let calls = 0;
    for (const [k, e] of order) {
      if (calls >= P.bountyChecksPerPass) break;
      const at = where.get(e.characterId);
      const located = at ? { systemId: at.systemId, state: at.state } : null;
      const sys = located && graph ? safeCall(() => graph.getSystem(located.systemId)) : null;
      const d = planFameBounty({ tier: S.TIER.PUBLIC_ENEMY, standing: e.standing, enemySince: e.since },
        { now, located, secClass: sys && typeof sys.secClass === "string" ? sys.secClass : null }, P);
      if (!d.post) {
        if (BOUNTY_WAIT_COUNTERS[d.wait]) bump(BOUNTY_WAIT_COUNTERS[d.wait]);
        continue;
      }
      if (bountyDoneFor.get(k) === d.period) continue;
      calls += 1;
      bountyTriedAt.set(k, now);
      const r = safeCall(() => bounty.postFameBounty({ characterId: e.characterId, factionId: e.factionId,
        period: d.period, level: d.level, systemId: d.systemId, at: now, delayMs: P.bountyDelayMs,
        windowMs: P.bountyWindowMs }));
      const outcome = r && typeof r.outcome === "string" ? r.outcome : "failed";
      if (outcome === "disabled") break;
      if (outcome === "created" || outcome === "duplicate") bountyDoneFor.set(k, d.period);
      if (outcome === "created") {
        bump("bountyPosted");
        bountyNotice(e, d.period, d.systemId, now);
      } else if (outcome === "noGang") {
        noGangFactions.add(e.factionId);
        bump("bountyNoGang");
      } else {
        bump(BOUNTY_OUTCOME_COUNTERS[outcome] || "bountyFailed");
      }
    }
  }

  function reviewNow(nowArg) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    try {
      if (!admits("MAINTENANCE")) {
        bump("deferredGovernor");
        return { ok: false, reason: "DEFERRED_GOVERNOR" };
      }
      const now = Number.isSafeInteger(nowArg) ? nowArg : clock.now();
      const factionIds = factionsNow();
      if (factionIds.length === 0) {
        bump("noRegistry");
        return { ok: false, reason: "NO_REGISTRY" };
      }
      const t0 = performance.now();
      bump("passes");
      const all = playersNow();
      const startAt = Math.max(0, all.findIndex((p) => p.characterId > cursor));
      const period = Math.floor(now / P.announcePeriodMs);
      const cands = [];
      let players = 0;
      let reads = 0;
      for (let i = 0; i < all.length; i += 1) {
        if (players >= P.reviewMaxPlayers) break;
        if (reads + factionIds.length > P.reviewMaxReadsPerPass) {
          if (players === 0) bump("readBudgetShort");
          break;
        }
        const p = all[(startAt + i) % all.length];
        players += 1;
        cursor = p.characterId;
        for (const factionId of factionIds) {
          reads += 1;
          bump("pairsRead");
          const r = read(p.characterId, factionId);
          if (!r.ok) {
            bump("readFailed");
            continue;
          }
          const k = `${p.characterId}:${factionId}`;
          const prev = lastTier.get(k);
          const next = R.tierOf(r.standing, prev, rp);
          cachePut(k, { tier: next, standing: r.standing, at: now });
          noteEnemy(k, p.characterId, factionId, next, r.standing, now);
          if (!R.changeOf(prev, next).announce) {
            setLastTier(k, next);
          } else if (cands.length < P.reviewMaxAnnouncesPerPass) {
            cands.push({ k, characterId: p.characterId, factionId, tier: next, period, systemId: p.systemId });
          }
        }
      }
      const announced = announce(cands, now);
      bountyStep(all, now);
      lastReviewAt = now;
      metric("observe", "fame.reviewMs", Math.round((performance.now() - t0) * MS_DECIMALS) / MS_DECIMALS);
      return { ok: true, players, reads, announced };
    } catch (err) {
      bump("errors");
      logger.log(`fame: review threw - ${messageOf(err)}`);
      return { ok: true, players: 0, reads: 0, announced: 0 };
    }
  }

  const marketFlagOn = P.marketTaxEnabled === true || P.marketBrokerEnabled === true;
  const wrapperFailOpen = () => {
    const st = marketFlagOn ? safeCall(deps.getMarketStatus) : null;
    const n = st ? Number(st.failOpen) : 0;
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };
  const marketFailOpenBase = wrapperFailOpen();
  const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  function marketHook() {
    const st = safeCall(deps.getMarketStatus);
    if (!st || typeof st !== "object") return null;
    return { state: typeof st.state === "string" ? st.state : "unknown", installed: st.installed === true,
      slot: st.slot === true, calls: countOf(st.calls), modified: countOf(st.modified) };
  }
  const MARKET_UNKNOWN = Object.freeze({ state: "unknown", installed: false, slot: false, calls: 0, modified: 0 });
  const marketStatus = () => (marketFlagOn ? Object.freeze(marketHook() || MARKET_UNKNOWN) : null);

  return Object.freeze({
    tierOf,
    localPolicy: () => (stopped ? null : policy),
    dockVerdict,
    marketSlot,
    reviewNow,
    getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", reason: null,
      counters: Object.freeze({ ...counters,
        marketFailOpen: counters.marketFailOpen + Math.max(0, wrapperFailOpen() - marketFailOpenBase) }),
      pairs: lastTier.size, cached: cache.size, lastReviewAt, market: marketStatus(),
      ...(P.bountyEnabled === true ? { enemies: enemySince.size, noGangFactions: [...noGangFactions] } : {}) }),
    isStopped: () => stopped,
    stop() {
      stopped = true;
      lastTier.clear();
      cache.clear();
      enemySince.clear();
      bountyTriedAt.clear();
      bountyDoneFor.clear();
      noGangFactions.clear();
    },
  });
}

module.exports = { createFameService };
