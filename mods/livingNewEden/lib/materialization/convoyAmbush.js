"use strict";

const R = require("../fleetExposure/rules");
const A = require("../fleetExposure/ambushRules");
const { createSpawnBackoff, failureReasonOf } = require("./spawnBackoff");
const { isSceneRefusal } = require("./sceneBudget");

const STATE = Object.freeze({ MISS: "MISS", WAITING: "WAITING", ENGAGED: "ENGAGED", CLEARED: "CLEARED",
  SKIPPED: "SKIPPED" });
const WORK_CLASS = "OPERATIONAL";
const CONVOY = "CONVOY";
const VISIBLE = "VISIBLE";
const ENDING = "ENDING";
const MAX_DETAIL = 120;
const BUDGET_PROBES = 2;
const LIMIT_REASONS = Object.freeze(["GLOBAL_LIMIT", "SYSTEM_LIMIT"]);

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

class AmbushError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = String(reason);
    this.detail = detail === undefined || detail === null ? null : String(detail).slice(0, MAX_DETAIL);
  }
}

function createConvoyAmbush(deps) {
  const { npcSpawn, budget } = deps;
  const S = deps.settings;
  const admits = typeof deps.admits === "function" ? deps.admits : () => true;
  const secClassOf = typeof deps.secClassOf === "function" ? deps.secClassOf : () => null;
  const pirateFactionOf = typeof deps.pirateFactionOf === "function" ? deps.pirateFactionOf : () => null;
  const carrierGroups = Array.isArray(deps.carrierGroups) ? deps.carrierGroups : [];
  const bump = typeof deps.bump === "function" ? deps.bump : noop;
  const logLimited = typeof deps.logLimited === "function" ? deps.logLimited : noop;
  const spawnDistanceOf = typeof deps.spawnDistanceOf === "function" ? deps.spawnDistanceOf : () => 0;
  const despawnAll = typeof deps.despawnAll === "function" ? deps.despawnAll
    : (systemId, ids) => npcSpawn.despawn(systemId, ids);
  const spawnBackoff = deps.spawnBackoff && typeof deps.spawnBackoff.blocked === "function" ? deps.spawnBackoff
    : createSpawnBackoff(null);
  const groups = A.ambushGroupsOf(S);
  const rolled = new Map();
  let pass = { at: null, starts: 0 };

  const keyOf = (e) => `${e.fleetId}:${e.crossing.legSeq}:${e.crossing.systemIndex}`;

  function carriersOf(e, facts) {
    const groupOf = new Map(e.members.map((m) => [m.entityId, m.hullGroup]));
    return facts.alive.filter((s) => s && carrierGroups.includes(groupOf.get(s.entityId)));
  }

  function liveIdsOf(e) {
    const r = safeCall(() => npcSpawn.listAlive(e.systemId, e.ambush.ids));
    return Array.isArray(r) ? r : [];
  }

  function releaseOf(a) {
    if (!a || a.reservationId === null) return;
    const id = a.reservationId;
    a.reservationId = null;
    safeCall(() => budget.release(id));
  }

  function skip(e, base, reason, counter) {
    e.ambush = { ...base, state: STATE.SKIPPED, skipReason: reason };
    bump(counter);
  }

  function profilesOf(key, factionId) {
    const reqs = A.ambushRequests(groups, S.ambushShips, factionId);
    if (reqs.length === 0) return [];
    const opts = { seedPrefix: `cab:${key}` };
    const whole = safeCall(() => npcSpawn.resolveProfiles(reqs, opts));
    if (whole && whole.ok === true && Array.isArray(whole.profiles) && whole.profiles.length === reqs.length) {
      return whole.profiles;
    }
    const out = [];
    for (const req of reqs) {
      const r = safeCall(() => npcSpawn.resolveProfiles([req], opts));
      if (r && r.ok === true && Array.isArray(r.profiles) && typeof r.profiles[0] === "string") out.push(r.profiles[0]);
    }
    return out;
  }

  function reserveFor(e, reservationId, wanted) {
    const requestOf = (n) => ({ reservationId, ownerKind: "fleet", ownerId: e.fleetId, systemId: e.systemId,
      shipCount: n, metadata: { systemId: e.systemId } });
    let n = wanted;
    for (let i = 0; i < BUDGET_PROBES; i += 1) {
      const p = budget.canReserve(requestOf(n));
      if (!p || p.ok === true || !LIMIT_REASONS.includes(p.reason) || !(p.available > 0) || p.available >= n) break;
      n = p.available;
    }
    const r = budget.reserve(requestOf(n));
    return r && r.ok === true ? n : 0;
  }

  function start(e, facts, nearCharacters, now) {
    if (e.phase !== VISIBLE || facts.sceneLoaded !== true || !(nearCharacters >= 1)) return;
    if (!(now - e.startedAt >= S.ambushDelayMs)) return;
    const key = keyOf(e);
    if (rolled.has(key)) return;
    if (pass.at !== now) pass = { at: now, starts: 0 };
    if (pass.starts >= S.ambushMaxStartsPerPass) return;
    if (!admits(WORK_CLASS)) {
      bump("ambushRefusedGovernor");
      return;
    }
    pass.starts += 1;
    const roll = A.rollAmbush({ worldSeed: deps.worldSeed, fleetId: e.fleetId, legSeq: e.crossing.legSeq,
      systemIndex: e.crossing.systemIndex, chancePermille: A.chancePermilleOf(safeCall(() => secClassOf(e.systemId)),
        S) });
    rolled.set(key, e.crossing.windowEnd + S.ambushFightMs);
    bump("ambushRolled");
    const base = { state: STATE.MISS, key, factionId: null, reservationId: null, ids: [], rolledAt: now,
      engagedAt: null, targetsSig: "", skipReason: null, draw: roll.draw };
    if (!roll.hit) {
      e.ambush = base;
      return;
    }
    if (!e.exitGate) {
      skip(e, base, "NO_GATE", "ambushNoGate");
      return;
    }
    const factionId = safeCall(() => pirateFactionOf(e.systemId));
    if (!Number.isSafeInteger(factionId) || factionId <= 0 || factionId === e.factionId) {
      skip(e, base, "NO_FACTION", "ambushNoFaction");
      return;
    }
    if (spawnBackoff.blocked(e.fleetId, now) !== null) {
      skip(e, { ...base, factionId }, "SPAWN_BACKOFF", "ambushRefusedBackoff");
      return;
    }
    const profiles = profilesOf(key, factionId);
    if (profiles.length === 0) {
      skip(e, { ...base, factionId }, "NO_PROFILE", "ambushNoProfile");
      return;
    }
    const reservationId = `fxa:${key}`;
    const n = reserveFor(e, reservationId, profiles.length);
    if (n === 0) {
      skip(e, { ...base, factionId }, "BUDGET", "ambushRefusedBudget");
      return;
    }
    const a = { ...base, state: STATE.WAITING, factionId, reservationId };
    const ids = [];
    try {
      const anchorDescriptor = { kind: "stargate", itemID: e.exitGate.itemId };
      const spawnDistanceMeters = spawnDistanceOf(e.exitGate);
      for (let i = 0; i < n; i += 1) {
        const r = npcSpawn.spawnShip(e.systemId, { profileId: profiles[i], anchorDescriptor, spawnDistanceMeters });
        if (!r || r.ok !== true) throw new AmbushError((r && r.reason) || "SPAWN_FAILED", r && r.detail);
        ids.push(r.entityId);
      }
      const pub = npcSpawn.publish(e.systemId, ids);
      if (!pub || pub.ok !== true) throw new AmbushError("PUBLISH_FAILED", pub && (pub.detail || pub.reason));
      if (!(pub.published >= ids.length)) throw new AmbushError("PUBLISH_PARTIAL", `${pub.published}/${ids.length}`);
    } catch (err) {
      const reason = err instanceof AmbushError ? err.reason : "SPAWN_THREW";
      if (ids.length > 0) safeCall(() => despawnAll(e.systemId, ids));
      releaseOf(a);
      e.ambush = { ...a, state: STATE.SKIPPED, skipReason: reason, ids: [] };
      bump("ambushSpawnFailed");
      const detail = err instanceof AmbushError ? err.detail : messageOf(err);
      const held = isSceneRefusal(reason) ? { first: true, failures: 0, retryAt: now }
        : spawnBackoff.note(e.fleetId, failureReasonOf(reason, detail), now);
      if (held.first) {
        logLimited(now, `fleetExposure: ambush ${key} rolled back - ${reason}`
          + `${err instanceof AmbushError && err.detail ? ` ${err.detail}` : (err instanceof AmbushError ? ""
            : ` ${messageOf(err)}`)}`
          + `${held.failures > 0 ? ` backoff=${held.retryAt - now}ms failures=${held.failures}` : ""}`);
      }
      return;
    }
    spawnBackoff.clear(e.fleetId);
    e.ambush = { ...a, ids };
    bump("ambushStarted");
    logLimited(now, `fleetExposure: ambush ${key} faction=${factionId} ships=${ids.length} at gate `
      + `${e.exitGate.itemId}`);
  }

  function engage(e, pirates, carriers) {
    return safeCall(() => npcSpawn.engage(e.systemId, pirates, carriers.map((s) => s.entityId),
      { targetMode: "manual", attackersOnly: true, aggroPlayers: S.ambushAggroPlayers === true }));
  }

  function clear(e, now) {
    e.ambush.state = STATE.CLEARED;
    releaseOf(e.ambush);
    bump("ambushCleared");
    logLimited(now, `fleetExposure: ambush ${e.ambush.key} cleared`);
  }

  function holdFight(e, now) {
    if (e.phase !== VISIBLE) e.lastAggressionAt = now;
  }

  function stepWaiting(e, facts, now) {
    const carriers = carriersOf(e, facts);
    if (carriers.length === 0 || !e.exitGate || !R.landed(carriers, e.exitGate.position)) return;
    const pirates = liveIdsOf(e);
    e.ambush.alive = pirates;
    if (pirates.length === 0) {
      clear(e, now);
      return;
    }
    const r = engage(e, pirates, carriers);
    if (!r || r.ok !== true) {
      bump("ambushEngageFailed");
      logLimited(now, `fleetExposure: ambush ${e.ambush.key} engage failed - ${(r && r.reason) || "no result"}`);
      return;
    }
    e.ambush.state = STATE.ENGAGED;
    e.ambush.engagedAt = now;
    e.ambush.targetsSig = A.targetsSig(carriers.map((s) => s.entityId));
    bump("ambushEngaged");
    holdFight(e, now);
  }

  function stepEngaged(e, facts, now) {
    const pirates = liveIdsOf(e);
    e.ambush.alive = pirates;
    if (pirates.length === 0) {
      clear(e, now);
      return;
    }
    const carriers = carriersOf(e, facts);
    if (carriers.length === 0) return;
    const sig = A.targetsSig(carriers.map((s) => s.entityId));
    if (sig !== e.ambush.targetsSig) {
      const r = engage(e, pirates, carriers);
      if (r && r.ok === true) {
        e.ambush.targetsSig = sig;
        bump("ambushRetargeted");
      } else {
        bump("ambushEngageFailed");
        logLimited(now, `fleetExposure: ambush ${e.ambush.key} retarget failed - ${(r && r.reason) || "no result"}`);
      }
    }
    holdFight(e, now);
  }

  function step(e, facts, nearCharacters, now) {
    try {
      if (!e || e.kind !== CONVOY || !e.crossing || e.phase === ENDING || e.despawned || !facts) return;
      if (e.ambush === null || e.ambush === undefined) start(e, facts, nearCharacters, now);
      if (!e.ambush) return;
      if (e.ambush.state === STATE.WAITING) stepWaiting(e, facts, now);
      else if (e.ambush.state === STATE.ENGAGED) stepEngaged(e, facts, now);
    } catch (err) {
      logLimited(now, `fleetExposure: ambush ${e && e.fleetId} threw - ${messageOf(err)}`);
    }
  }

  function despawnAt(e, base) {
    const a = e && e.ambush;
    if (!a || a.state !== STATE.ENGAGED || !Number.isSafeInteger(base) || !(S.ambushFightMs > 0)) return base;
    return Math.max(base, a.engagedAt + S.ambushFightMs);
  }

  function idsOf(e) {
    return e && e.ambush && Array.isArray(e.ambush.ids) ? [...e.ambush.ids] : [];
  }

  function release(e) {
    if (e && e.ambush) releaseOf(e.ambush);
  }

  function blocksYield(e) {
    const a = e && e.ambush;
    return Boolean(a) && (a.state === STATE.WAITING || a.state === STATE.ENGAGED);
  }

  function noteCarrierLoss(e) {
    if (e && e.ambush && e.ambush.state === STATE.ENGAGED) bump("ambushCarriersLost");
  }

  function engagedPiratesOf(e) {
    const a = e && e.ambush;
    return a && a.state === STATE.ENGAGED && Array.isArray(a.alive) ? [...a.alive] : [];
  }

  function statusOf(e) {
    const a = e && e.ambush;
    if (!a) return null;
    return { state: a.state, key: a.key, factionId: a.factionId, ships: a.ids.length, draw: a.draw,
      rolledAt: a.rolledAt, engagedAt: a.engagedAt, skipReason: a.skipReason };
  }

  function prune(now) {
    for (const [key, until] of rolled) if (now >= until) rolled.delete(key);
  }

  return Object.freeze({ step, despawnAt, idsOf, release, blocksYield, noteCarrierLoss, engagedPiratesOf, statusOf,
    prune });
}

module.exports = { createConvoyAmbush, AMBUSH_STATES: STATE };
