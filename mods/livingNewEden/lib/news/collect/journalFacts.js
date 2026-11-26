"use strict";

const { KIND, MAX_FACT_KEY, MAX_NAME_CHARS, DATA_VERSION } = require("../schema");
const { weightOf } = require("../data/kinds");
const { boundaryAtOrBefore, nextBoundary } = require("../cycle");
const ECONOMY = require("../../economy/schema");
const TREASURY = require("../../economy/treasury/schema");
const INVASIONS = require("../../world/invasions/schema");
const TRUCE = require("../../strategy/truce/schema");
const BASTIONS = require("../../world/bastions/schema");
const BOUNTY = require("../../bounty/schema");
const SIT = require("../../situations/schema");
const FAME = require("../../fame/schema");
const SEASONS = require("../../seasons/schema");
const GM = require("../../gameMaster/schema");
const WB = require("../../worldBosses/schema").NEWS;
const NIS = require("../../nativeIncursions/schema");
const FIS = require("../../factionIncursions/schema");

const BATTLE_AGGREGATE = "battle";
const BATTLE_SETTLED = "BATTLE_SETTLED";
const INVASION_SPAWNED = "INVASION_SPAWNED";
const JOB_DELIVERED = "DELIVERED";
const TAIL_AGGREGATE_TYPES = Object.freeze([BATTLE_AGGREGATE, ECONOMY.JOB_AGGREGATE, TREASURY.AGGREGATE,
  INVASIONS.AGGREGATE_INVASION, TRUCE.WAR_PAIR_AGGREGATE, BASTIONS.STATION_RETURN_AGGREGATE, BOUNTY.BOUNTY_AGGREGATE,
  SIT.AGGREGATE, SEASONS.AGGREGATE, GM.AGGREGATE, FAME.AGGREGATE, BOUNTY.REVENGE_AGGREGATE, WB.AGGREGATE,
  NIS.AGGREGATE, FIS.AGGREGATE]);
const NATIVE_INCURSION_KIND = Object.freeze({ [NIS.OUTCOME.DEFEATED]: KIND.NATIVE_INCURSION_DEFEATED,
  [NIS.OUTCOME.EXPIRED]: KIND.NATIVE_INCURSION_HELD });
const FACTION_INCURSION_KIND = Object.freeze({ [FIS.OUTCOME.DEFEATED]: KIND.FACTION_INCURSION_DEFEATED,
  [FIS.OUTCOME.EXPIRED]: KIND.FACTION_INCURSION_HELD });
const FAME_TIER_KIND = Object.freeze({ [FAME.TIER.LEGEND]: KIND.FAME_LEGEND,
  [FAME.TIER.PUBLIC_ENEMY]: KIND.FAME_PUBLIC_ENEMY });
const GM_FACTS = Object.freeze({
  [GM.EVENT_STARTED]: Object.freeze([KIND.GM_THREAD_STARTED, "gms"]),
  [GM.EVENT_ENDED]: Object.freeze([KIND.GM_THREAD_ENDED, "gme"]),
});
const SEASON_FACTS = Object.freeze({
  [SEASONS.JOURNAL.STARTED]: Object.freeze([KIND.SEASON_STARTED, "ss", false]),
  [SEASONS.JOURNAL.STAGE]: Object.freeze([KIND.SEASON_STAGE, "sg", true]),
  [SEASONS.JOURNAL.FINALE]: Object.freeze([KIND.SEASON_FINALE, "sf", false]),
  [SEASONS.JOURNAL.ENDED]: Object.freeze([KIND.SEASON_ENDED, "se", false]),
});
const TREASURY_MODE_KIND = Object.freeze({ AUSTERITY: KIND.TREASURY_CRISIS, NORMAL: KIND.TREASURY_RECOVERED });
const MERGE_BATTLE = "battle";

function isId(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isText(v) {
  return typeof v === "string" && v !== "" && v.length <= MAX_FACT_KEY;
}

function cleanName(v) {
  return typeof v === "string" && v.trim() !== "" ? v.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_CHARS) : null;
}

function periodEndOf(at, c) {
  if (!Number.isSafeInteger(c.cycleHours) || c.cycleHours <= 0 || !Number.isSafeInteger(c.publishHourUtc)
    || c.publishHourUtc < 0) return null;
  const s = { cycleHours: c.cycleHours, publishHourUtc: c.publishHourUtc };
  return nextBoundary(boundaryAtOrBefore(at, s), s);
}

const startKeyOfJob = (jobId) => `pj:${jobId}:start`;
const startKeyOfInvasion = (id) => `inv:${id}:start`;
const startKeyOfBoss = (bossId) => `${WB.START_PREFIX}:${bossId}`;

function refKeysOf(entries) {
  const keys = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e !== "object") continue;
    const p = e.payload && typeof e.payload === "object" ? e.payload : {};
    if (e.eventType === ECONOMY.EVENT_JOB_TRANSITION && p.to === JOB_DELIVERED && isText(p.jobId)) {
      keys.add(startKeyOfJob(p.jobId));
    } else if (e.eventType === INVASIONS.JOURNAL_EVENT_ENDED && isText(e.aggregateId)) {
      keys.add(startKeyOfInvasion(e.aggregateId));
    } else if (e.eventType === WB.ENDED && e.aggregateType === WB.AGGREGATE && isText(e.aggregateId)) {
      keys.add(startKeyOfBoss(e.aggregateId));
    }
  }
  return [...keys].filter((k) => k.length <= MAX_FACT_KEY);
}

function factsOfEntries(entries, ctx) {
  const c = ctx || {};
  const kinds = new Set(Array.isArray(c.kinds) ? c.kinds : []);
  const capital = new Set(Array.isArray(c.capitalClasses) ? c.capitalClasses : []);
  const refs = new Map(c.refs instanceof Map ? c.refs : []);
  const placeOf = (id) => {
    try {
      const p = typeof c.place === "function" && id !== null ? c.place(id) : null;
      return { systemName: cleanName(p && p.systemName), regionName: cleanName(p && p.regionName) };
    } catch (_err) {
      return { systemName: null, regionName: null };
    }
  };
  const factionOf = (id) => {
    try {
      return isId(id) && typeof c.factionName === "function" ? cleanName(c.factionName(id)) : null;
    } catch (_err) {
      return null;
    }
  };
  const facts = [];
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  const push = (fact) => {
    if (!kinds.has(fact.kind)) {
      skip("KIND_OFF");
      return;
    }
    if (fact.factKey.length > MAX_FACT_KEY) {
      skip("BAD_PAYLOAD");
      return;
    }
    fact.weight = weightOf(fact.kind, fact.data);
    facts.push(fact);
    refs.set(fact.factKey, fact);
  };

  for (const e of Array.isArray(entries) ? entries : []) {
    try {
      if (!e || typeof e !== "object" || !Number.isSafeInteger(e.createdAt) || e.createdAt < 0) {
        skip("BAD_PAYLOAD");
        continue;
      }
      const p = e.payload && typeof e.payload === "object" ? e.payload : null;
      const at = e.createdAt;
      if (e.eventType === BATTLE_SETTLED && e.aggregateType === BATTLE_AGGREGATE) {
        const a = p && p.sideA;
        const b = p && p.sideB;
        if (!p || !isId(p.systemId) || !a || !b || !isId(a.factionId) || !isId(b.factionId)
          || !Number.isSafeInteger(a.destroyed) || a.destroyed < 0 || !Number.isSafeInteger(b.destroyed)
          || b.destroyed < 0) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const periodEnd = periodEndOf(at, c);
        if (periodEnd === null) {
          skip("NO_CYCLE");
          continue;
        }
        const minF = Math.min(a.factionId, b.factionId);
        const maxF = Math.max(a.factionId, b.factionId);
        push({ factKey: `bt:${periodEnd}:${p.systemId}:${minF}:${maxF}`, kind: KIND.BATTLE, at, systemId: p.systemId,
          data: { v: DATA_VERSION, ...placeOf(p.systemId), factionA: factionOf(minF), factionB: factionOf(maxF),
            destroyed: a.destroyed + b.destroyed, battles: 1,
            outcome: typeof p.outcome === "string" ? p.outcome.slice(0, 32) : null },
          merge: MERGE_BATTLE });
      } else if (e.eventType === ECONOMY.EVENT_JOB_CREATED) {
        if (!p || !isText(p.jobId) || typeof p.hullGroup !== "string") {
          skip("BAD_PAYLOAD");
          continue;
        }
        if (!capital.has(p.hullGroup)) continue;
        push({ factKey: startKeyOfJob(p.jobId), kind: KIND.CAPITAL_STARTED, at, systemId: null,
          data: { v: DATA_VERSION, systemName: null, regionName: null, factionA: factionOf(p.factionId),
            factionB: null, hullClass: p.hullGroup } });
      } else if (e.eventType === ECONOMY.EVENT_JOB_TRANSITION) {
        if (!p || !isText(p.jobId) || typeof p.to !== "string") {
          skip("BAD_PAYLOAD");
          continue;
        }
        if (p.to !== JOB_DELIVERED) continue;
        const start = refs.get(startKeyOfJob(p.jobId));
        if (!start) {
          skip("REF_MISSING");
          continue;
        }
        push({ factKey: `pj:${p.jobId}:done`, kind: KIND.CAPITAL_DELIVERED, at, systemId: start.systemId,
          data: { ...start.data, v: DATA_VERSION } });
      } else if (e.eventType === TREASURY.EVENT_SETTLED) {
        if (!p || !isId(p.factionId) || !p.patch || typeof p.patch !== "object" || !isId(e.journalId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const kind = TREASURY_MODE_KIND[p.patch.mode];
        if (!kind) continue;
        push({ factKey: `tr:${e.journalId}`, kind, at, systemId: null,
          data: { v: DATA_VERSION, systemName: null, regionName: null, factionA: factionOf(p.factionId),
            factionB: null } });
      } else if (e.eventType === INVASION_SPAWNED) {
        if (!p || !isText(e.aggregateId) || !isId(p.targetSystemId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        push({ factKey: startKeyOfInvasion(e.aggregateId), kind: KIND.INVASION_STARTED, at,
          systemId: p.targetSystemId, data: { v: DATA_VERSION, ...placeOf(p.targetSystemId),
            factionA: factionOf(p.factionId), factionB: null } });
      } else if (e.eventType === INVASIONS.JOURNAL_EVENT_ENDED) {
        if (!isText(e.aggregateId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const start = refs.get(startKeyOfInvasion(e.aggregateId));
        if (!start) {
          skip("REF_MISSING");
          continue;
        }
        push({ factKey: `inv:${e.aggregateId}:end`, kind: KIND.INVASION_ENDED, at, systemId: start.systemId,
          data: { ...start.data, v: DATA_VERSION } });
      } else if (e.eventType === TRUCE.EVENT_WAR_PAIR_TRUCE && e.aggregateType === TRUCE.WAR_PAIR_AGGREGATE) {
        if (!p || !isId(p.lo) || !isId(p.hi) || p.lo >= p.hi || !Number.isSafeInteger(p.at) || p.at < 0
          || !Number.isSafeInteger(p.truceUntil) || p.truceUntil <= p.at
          || (p.initiator !== p.lo && p.initiator !== p.hi)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const other = p.initiator === p.lo ? p.hi : p.lo;
        push({ factKey: `tc:${p.lo}:${p.hi}:${p.truceUntil}`, kind: KIND.TRUCE_AGREED, at, systemId: null,
          data: { v: DATA_VERSION, systemName: null, regionName: null, factionA: factionOf(p.initiator),
            factionB: factionOf(other) } });
      } else if (e.eventType === BASTIONS.EVENT_STATION_RETURNED
        && e.aggregateType === BASTIONS.STATION_RETURN_AGGREGATE) {
        if (!p || !isText(p.stationId) || !isId(p.systemId) || !isId(p.fromFactionId) || !isId(p.toFactionId)
          || p.fromFactionId === p.toFactionId || !Number.isSafeInteger(p.at) || p.at < 0) {
          skip("BAD_PAYLOAD");
          continue;
        }
        push({ factKey: `bsr:${p.stationId}:${p.at}`, kind: KIND.STATION_RETURNED, at, systemId: p.systemId,
          data: { v: DATA_VERSION, ...placeOf(p.systemId), factionA: factionOf(p.toFactionId),
            factionB: factionOf(p.fromFactionId) } });
      } else if (e.eventType === BOUNTY.EVENT_BOUNTY_CLAIMED && e.aggregateType === BOUNTY.BOUNTY_AGGREGATE) {
        if (!p || !isText(p.wantedId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const periodEnd = periodEndOf(at, c);
        if (periodEnd === null) {
          skip("NO_CYCLE");
          continue;
        }
        push({ factKey: `bc:${periodEnd}`, kind: KIND.BOUNTY_CLAIMED, at, systemId: null,
          data: { v: DATA_VERSION, systemName: null, regionName: null, factionA: null, factionB: null, destroyed: 1,
            battles: 1, outcome: null },
          merge: MERGE_BATTLE });
      } else if (e.eventType === SIT.EVENT_RESOLVED && e.aggregateType === SIT.AGGREGATE) {
        if (!p || typeof p.kind !== "string" || p.kind === "" || !SIT.OUTCOMES.includes(p.outcome)
          || !Number.isSafeInteger(p.victims) || p.victims < 0 || !Number.isSafeInteger(p.saved) || p.saved < 0
          || p.saved > p.victims) {
          skip("BAD_PAYLOAD");
          continue;
        }
        let saved = 0;
        let lost = 0;
        if (p.outcome === SIT.STATES.RESCUED) {
          saved = p.saved;
          lost = p.victims - p.saved;
        } else if (p.outcome === SIT.STATES.LOST) {
          lost = p.victims;
        } else continue;
        if (saved + lost === 0) continue;
        const periodEnd = periodEndOf(at, c);
        if (periodEnd === null) {
          skip("NO_CYCLE");
          continue;
        }
        push({ factKey: `sr:${periodEnd}`, kind: KIND.SITUATION_RESOLVED, at, systemId: null,
          data: { v: DATA_VERSION, systemName: null, regionName: null, factionA: null, factionB: null,
            destroyed: saved, lost, battles: 1, outcome: null },
          merge: MERGE_BATTLE });
      } else if (e.aggregateType === SEASONS.AGGREGATE && SEASON_FACTS[e.eventType]) {
        const [kind, prefix, staged] = SEASON_FACTS[e.eventType];
        const stage = p && Number.isSafeInteger(p.stage) && p.stage >= 0 ? p.stage : null;
        if (!p || !isId(p.seasonNo) || (p.factionId !== null && !isId(p.factionId)) || (staged && stage === null)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        let regionName = null;
        if (Array.isArray(p.regionIds) && isId(p.regionIds[0]) && typeof c.regionName === "function") {
          try {
            regionName = cleanName(c.regionName(p.regionIds[0]));
          } catch (_err) {
            regionName = null;
          }
        }
        push({ factKey: staged ? `${prefix}:${p.seasonNo}:${stage}` : `${prefix}:${p.seasonNo}`, kind, at,
          systemId: null, data: { v: DATA_VERSION, systemName: null, regionName, factionA: factionOf(p.factionId),
            factionB: null, destroyed: p.seasonNo, lost: stage === null ? 0 : stage } });
      } else if (e.aggregateType === GM.AGGREGATE && GM_FACTS[e.eventType]) {
        const [kind, prefix] = GM_FACTS[e.eventType];
        if (!p || !isText(p.threadId) || !isId(p.systemId) || !isId(p.factionId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const ended = kind === KIND.GM_THREAD_ENDED;
        if (ended && (typeof p.outcome !== "string" || p.outcome === "")) continue;
        push({ factKey: `${prefix}:${p.threadId}`, kind, at, systemId: p.systemId,
          data: { v: DATA_VERSION, ...placeOf(p.systemId), factionA: factionOf(p.factionId), factionB: null,
            outcome: ended ? p.outcome.slice(0, 32) : null } });
      } else if ((e.eventType === FAME.EVENT_TIER_CHANGED && e.aggregateType === FAME.AGGREGATE)
        || (e.eventType === BOUNTY.EVENT_REVENGE_SWORN && e.aggregateType === BOUNTY.REVENGE_AGGREGATE)) {
        const bounty = e.eventType === BOUNTY.EVENT_REVENGE_SWORN;
        if (bounty && !(p && FAME.isFameWantedId(p.wantedId))) continue;
        const kind = bounty ? KIND.FAME_BOUNTY : FAME_TIER_KIND[p && p.tier];
        if (!p || !kind || !isId(p.factionId) || !isId(e.journalId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        push({ factKey: `fm:${e.journalId}`, kind, at, systemId: null,
          data: { v: DATA_VERSION, systemName: null, regionName: null, factionA: factionOf(p.factionId),
            factionB: null } });
      } else if (e.aggregateType === WB.AGGREGATE && (e.eventType === WB.SPAWNED || e.eventType === WB.ENDED)) {
        if (!p || !isText(e.aggregateId) || !isId(p.systemId) || !isId(p.factionId)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        if (e.eventType === WB.SPAWNED) {
          push({ factKey: startKeyOfBoss(e.aggregateId), kind: KIND.WORLD_BOSS_EMERGED, at, systemId: p.systemId,
            data: { v: DATA_VERSION, ...placeOf(p.systemId), factionA: factionOf(p.factionId), factionB: null } });
          continue;
        }
        if (p.outcome === WB.OUTCOMES.CANCELLED) continue;
        let kind = null;
        let data = null;
        if (p.outcome === WB.OUTCOMES.DEFEATED && p.mode === WB.LIVE_MODE) {
          kind = KIND.WORLD_BOSS_SLAIN;
          data = { factionA: factionOf(p.factionId), factionB: null };
        } else if (p.outcome === WB.OUTCOMES.DEFEATED) {
          kind = KIND.WORLD_BOSS_DEFEATED;
          data = { factionA: factionOf(p.topFactionId), factionB: factionOf(p.factionId) };
        } else if (p.outcome === WB.OUTCOMES.EXPIRED) {
          kind = KIND.WORLD_BOSS_WITHDREW;
          data = { factionA: factionOf(p.factionId), factionB: null };
        } else {
          skip("BAD_PAYLOAD");
          continue;
        }
        if (!refs.get(startKeyOfBoss(e.aggregateId))) {
          skip("REF_MISSING");
          continue;
        }
        push({ factKey: `${WB.END_PREFIX}:${e.aggregateId}`, kind, at, systemId: p.systemId,
          data: { v: DATA_VERSION, ...placeOf(p.systemId), ...data } });
      } else if (e.aggregateType === NIS.AGGREGATE && e.eventType === NIS.EVENT_SETTLE) {
        if (!p || !isId(p.taleId) || !isId(p.generation) || !isId(p.targetSystemId)
          || !Object.values(NIS.OUTCOME).includes(p.outcome)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const kind = NATIVE_INCURSION_KIND[p.outcome];
        if (!kind) continue;
        push({ factKey: NIS.newsKeyOf(p.taleId, p.generation), kind, at, systemId: p.targetSystemId,
          data: { v: DATA_VERSION, ...placeOf(p.targetSystemId), factionA: factionOf(NIS.NATIVE_FACTION_ID),
            factionB: null } });
      } else if (e.aggregateType === FIS.AGGREGATE && e.eventType === FIS.EVENT_SETTLE) {
        if (!p || !isId(p.incursionId) || !isId(p.targetSystemId)
          || !Object.values(FIS.OUTCOME).includes(p.outcome)) {
          skip("BAD_PAYLOAD");
          continue;
        }
        const kind = FACTION_INCURSION_KIND[p.outcome];
        if (!kind || !isId(p.factionId)) continue;
        push({ factKey: FIS.newsKeyOf(p.incursionId), kind, at, systemId: p.targetSystemId,
          data: { v: DATA_VERSION, ...placeOf(p.targetSystemId), factionA: factionOf(p.factionId), factionB: null } });
      }
    } catch (_err) {
      skip("BAD_PAYLOAD");
    }
  }
  return { facts, skipped };
}

module.exports = { refKeysOf, factsOfEntries, TAIL_AGGREGATE_TYPES, BATTLE_AGGREGATE, BATTLE_SETTLED,
  INVASION_SPAWNED, MERGE_BATTLE };
