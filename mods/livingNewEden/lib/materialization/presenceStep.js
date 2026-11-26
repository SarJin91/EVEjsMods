"use strict";

const { performance } = require("node:perf_hooks");
const R = require("../fleetExposure/rules");
const PR = require("../fleetExposure/presenceRules");
const T = require("../fleetExposure/transitRules");
const { exposureIdOf, parseHostileClaimStates } = require("../fleetExposure/schema");
const { parseOperationTypeList } = require("../fleets/schema");
const { createTransitSweep } = require("./presenceTransit");
const PH = require("./presenceHostility");
const { relationOf, huntThresholds } = require("../playerHunt/policy");
const { parseNeutralPolicy, parseSecClassList } = require("../playerHunt/schema");
const { createSpawnBackoff, failureReasonOf } = require("./spawnBackoff");
const { isSceneRefusal } = require("./sceneBudget");

const COUNTER_NAMES = Object.freeze(["presenceScans", "presenceScanRefused", "presenceScanTruncated",
  "presenceStarted", "presenceShips", "presenceTrimmed", "presenceRefusedGovernor", "presenceRefusedBudget",
  "presenceRefusedProfile", "presenceRefusedNoAnchor", "presenceAnchorFallback", "presenceSpawnFailed",
  "presenceYielded", "presenceHandedOver", "presenceUnclaimable", "presenceClaimed", "presenceClaimFailed",
  "presenceLossImported", "presenceLossDropped", "presenceDespawned", "presenceExited", "presenceEnded",
  "presenceEndFailed", "presenceWiped", "presenceTransitPages", "presenceTransitIndexed", "presenceTransitIndexFull",
  "presenceStartedTransit", "presenceTransitDone", "presenceTransitMissed", "presenceScanSystemsSkipped",
  "presenceTransitRefused", "presencePendingExpired", "presenceHostileWakes", "presenceHostileRefusedLimit",
  "presenceHostileRefusedSec", "presenceHostileNoSecClass", "presenceHostileRefusedGovernor",
  "presenceHostileSkippedState", "presenceHostileCooled", "presenceHostileStandingUnknown", "presenceHostileOrders",
  "presenceHostileOrderFailed", "presenceHostileRetaliations", "presenceHostileEnded", "presenceHostileWithdrawn",
  "presenceRefusedBackoff"]);
const WAKE_REFUSAL_COUNTER = Object.freeze({ NO_SEC_CLASS: "presenceHostileNoSecClass",
  SEC_CLASS: "presenceHostileRefusedSec", PASS_LIMIT: "presenceHostileRefusedLimit",
  SYSTEM_LIMIT: "presenceHostileRefusedLimit", GLOBAL_LIMIT: "presenceHostileRefusedLimit" });
const HIDDEN_REASONS = Object.freeze(["BUDGET", "CAP", "GOVERNOR", "YIELD_HOLD", "NO_ANCHOR", "NO_PROFILE",
  "COOLDOWN", "SPAWN_FAILED", "PASS_LIMIT", "WIPE_HOLD", "SPAWN_BACKOFF"]);

const KIND = "PRESENCE";
const WORK_CLASS_NEW = "OPERATIONAL";
const PHASE = Object.freeze({ VISIBLE: "VISIBLE", HELD: "HELD", EXITING: "EXITING", ENDING: "ENDING" });
const PERMANENT_END = Object.freeze(["EXPOSURE_NOT_FOUND", "FLEET_NOT_FOUND", "FLEET_NOT_MATERIALIZED",
  "FLEET_EXPOSURE_INVALID_INPUT"]);
const FLEET_METHODS = Object.freeze(["getFleet", "getFleets", "listFleetsInSystems", "getOperation"]);
const RESERVATION_PREFIX = "pr:";
const PROFILE_TRIES = 3;
const EXIT_KINDS = Object.freeze(["station", "stargate"]);
const CONVOY_ROLE = "logistics";
const TRAVELLING = "TRAVELLING";
const RECENT_ENDS_SHOWN = 20;
const MAX_DETAIL = 120;
const MINUTE_MS = 60000;
const MS_DECIMALS = 1000;
const LOG_LINES_PER_MIN = 10;

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

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function cursorAfterCut(window, systems, i, whole) {
  const pos = new Map(window.map((s, k) => [s, k]));
  let m = window.length;
  for (let j = i; j < systems.length; j += 1) m = Math.min(m, pos.get(systems[j]));
  if (m === 0 && whole === true) return window[0];
  return m > 0 && m < window.length ? window[m - 1] : window[window.length - 1];
}

function createPresenceStep(deps) {
  const { store, clock, npcSpawn, budget, lossTracker } = deps;
  const S = deps.settings;
  const H = deps.heldSettings || {};
  const capital = deps.capital && typeof deps.capital.slotsOf === "function" ? deps.capital : null;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const getFleetExposure = typeof deps.getFleetExposure === "function" ? deps.getFleetExposure : () => null;
  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
  const getHuntScene = typeof deps.getHuntScene === "function" ? deps.getHuntScene : () => null;
  const getBeltNavyScene = typeof deps.getBeltNavyScene === "function" ? deps.getBeltNavyScene : () => null;
  const getOwnedFleetIds = typeof deps.getOwnedFleetIds === "function" ? deps.getOwnedFleetIds : () => new Set();
  const despawnAll = deps.despawnAll;
  const admits = typeof deps.admits === "function" ? deps.admits : () => true;
  const lossImportOn = deps.lossImportOn === true;
  const invaders = deps.invaderProfiles === true;
  const industry = deps.industryProfiles === true;
  const worldSeed = deps.worldSeed;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const ownerFactions = new Set((Array.isArray(deps.ownerFactionIds) ? deps.ownerFactionIds : [])
    .filter((id) => Number.isSafeInteger(id) && id > 0));
  const P = { exitGraceMs: S.exitGraceMs, maxHeldMs: H.maxHeldMs, holdQuietMs: H.holdQuietMs,
    exitWarpMaxMs: H.exitWarpMaxMs };
  const warpSpread = Math.min(S.spawnDistanceMeters, Math.floor(R.EXIT_LAND_METERS / 2));
  const slotsOf = (m) => (capital ? capital.slotsOf([m]) : 1);
  const TP = { transitMinRemainingMs: H.transitMinRemainingMs, transitEndMarginMs: H.transitEndMarginMs };
  const transitClaimTypes = parseOperationTypeList(S.transitClaimOperationTypes) || [];
  const stagedClaimTypes = parseOperationTypeList(S.claimStagedOperationTypes) || [];
  const pendingMaxAgeMs = Number.isSafeInteger(S.pendingLossMaxAgeMs) && S.pendingLossMaxAgeMs > 0
    ? S.pendingLossMaxAgeMs : Infinity;
  const maxFleetReads = Number.isSafeInteger(deps.maxFleetReads) && deps.maxFleetReads > 0 ? deps.maxFleetReads
    : Infinity;
  const transitOn = () => S.transitEnabled === true;
  const hostileOn = () => S.hostileEnabled === true && lossImportOn;
  const readStanding = typeof deps.readStanding === "function" ? deps.readStanding : null;
  const getFactionKind = typeof deps.getFactionKind === "function" ? deps.getFactionKind : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const excludedFactions = new Set(Array.isArray(deps.excludedFactionIds) ? deps.excludedFactionIds : []);
  const huntSettings = deps.huntSettings && typeof deps.huntSettings === "object" ? deps.huntSettings : {};
  const spawnBackoff = deps.spawnBackoff && typeof deps.spawnBackoff.blocked === "function" ? deps.spawnBackoff
    : createSpawnBackoff(null);
  let lastSpawnError = null;
  const hostileClaimStates = parseHostileClaimStates(S.hostileClaimStates) || [];
  let hostileRule = null;
  const hostileCooldown = new Map();
  const standingCache = new Map();
  let hostilePass = { reads: 0, orders: 0, wakes: 0 };
  let lastWake = null;

  const counters =Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const entries = new Map();
  const yieldHoldUntil = new Map();
  const unclaimableUntil = new Map();
  const wipeHoldUntil = new Map();
  const msOrZero = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
  const fleetCursor = new Map();
  let lastHidden = new Map();
  const recentEnds = [];
  let cursor = 0;
  let lastScanAt = null;
  let lastRefusal = null;
  let stopped = false;
  const loggedOnce = new Set();
  let errorWindow = -Infinity;
  let errorLines = 0;
  let hiddenCount = 0;
  const sweep = createTransitSweep({ settings: S, heldSettings: H, telemetryBump: (name, n) => bump(name, n) });

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`fleetExposure.${name}`, n);
    } catch (_err) {
    }
  }

  function gauge(name, value) {
    if (!telemetry || typeof telemetry.gauge !== "function") return;
    try {
      telemetry.gauge(name, value);
    } catch (_err) {
    }
  }

  function observe(name, ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(name, Math.max(0, Math.round(ms * MS_DECIMALS) / MS_DECIMALS));
    } catch (_err) {
    }
  }

  function logOnce(key, line) {
    if (loggedOnce.has(key)) return;
    loggedOnce.add(key);
    logger.log(line);
  }

  function logLimited(now, line) {
    if (now - errorWindow >= MINUTE_MS) {
      errorWindow = now;
      errorLines = 0;
    }
    if (errorLines >= LOG_LINES_PER_MIN) return;
    errorLines += 1;
    logger.log(line);
  }

  function refuse(out, reason, name, detail) {
    if (name) bump(name);
    const key = `presence:${reason}`;
    if (out && out.refused) out.refused[key] = (out.refused[key] || 0) + 1;
    lastRefusal = { reason: String(reason), detail: detail || null, at: clock.now() };
  }

  function tx(name, fn) {
    const r = store.transaction(`materialization.${name}`, fn);
    if (r && r.ok) return r.value;
    return { ok: false, reason: (r && r.reason) || "TX_FAILED",
      ...(r && r.error ? { detail: messageOf(r.error) } : {}) };
  }

  function facade() {
    const f = safeCall(getFleetExposure);
    return f && typeof f.claimInTx === "function" && typeof f.endInTx === "function"
      && typeof f.markDestroyedInTx === "function" ? f : null;
  }

  function fleetRepo() {
    const f = safeCall(getFleets);
    const repo = f && f.repository;
    return repo && FLEET_METHODS.every((m) => typeof repo[m] === "function") ? repo : null;
  }

  const liveIdsOf = (e) => e.members.filter((m) => !m.destroyed && !e.pendingDestroyed.includes(m.memberKey))
    .map((m) => m.entityId);
  const allIdsOf = (e) => e.members.map((m) => m.entityId);
  const slotsIn = (e) => e.members.reduce((n, m) => n + m.slots, 0);

  function dropMember(e, m, despawn) {
    if (despawn) despawnAll(e.systemId, [m.entityId]);
    budget.release(m.reservationId);
    lossTracker.forgetEntities([m.entityId]);
    e.members = e.members.filter((x) => x !== m);
    e.pendingDestroyed = e.pendingDestroyed.filter((k) => k !== m.memberKey);
    e.pendingSince.delete(m.memberKey);
  }

  function despawnEntry(e) {
    if (e.despawned) return;
    despawnAll(e.systemId, allIdsOf(e));
    for (const m of e.members) budget.release(m.reservationId);
    e.despawned = true;
  }

  function forget(e) {
    entries.delete(e.fleetId);
    lossTracker.untrack(e.fleetId);
  }

  function noteEnd(e, now, reason, outcome, losses) {
    recentEnds.push({ fleetId: e.fleetId, systemId: e.systemId, exposureId: e.exposureId, reason, outcome, losses,
      at: now });
    if (recentEnds.length > RECENT_ENDS_SHOWN) recentEnds.splice(0, recentEnds.length - RECENT_ENDS_SHOWN);
  }

  function despawnVisible(e, reason, now, counter) {
    bump("presenceLossDropped", e.pendingDestroyed.length);
    despawnEntry(e);
    forget(e);
    bump(counter || "presenceDespawned");
    noteEnd(e, now, reason, "DESPAWNED", 0);
  }

  function despawnUnclaimable(e, now) {
    unclaimableUntil.set(e.fleetId, now + S.unclaimableCooldownMs);
    despawnVisible(e, "UNCLAIMABLE", now, "presenceUnclaimable");
  }

  function tryEnd(e, now) {
    const fe = facade();
    const r = fe ? tx("presenceEnd", (db) => fe.endInTx(db, { exposureId: e.exposureId, at: now,
      reason: e.endReason })) : { ok: false, reason: "FLEET_EXPOSURE_UNAVAILABLE" };
    if (r && r.ok === true) {
      forget(e);
      hostileEnded(e, now);
      bump("presenceEnded");
      if (e.endReason === "WIPED") bump("presenceWiped");
      const losses = (r.losses || []).reduce((n, g) => n + g.count, 0);
      const reason = typeof r.endReason === "string" ? r.endReason : e.endReason;
      noteEnd(e, now, reason, r.outcome, losses);
      logLimited(now, `fleetExposure: presence ${e.exposureId} ended ${reason} outcome=${r.outcome} losses=${losses}`
        + `${r.duplicate ? " (duplicate)" : ""}`);
      return;
    }
    bump("presenceEndFailed");
    if (r && PERMANENT_END.includes(r.reason)) {
      forget(e);
      hostileEnded(e, now);
      logger.log(`fleetExposure: presence end ${e.exposureId} refused - ${r.reason} (left to the restart recovery)`);
      return;
    }
    logLimited(now, `fleetExposure: presence end ${e.exposureId} failed - ${(r && r.reason) || "no result"}`);
  }

  function coolAfterEnd(e, reason, now) {
    const lost = reason === "WIPED" || e.lossQueue.length > 0 || e.members.some((m) => m.destroyed);
    if (!lost) return;
    const until = now + msOrZero(S.wipedCooldownMs);
    if (until > (unclaimableUntil.get(e.fleetId) || 0)) unclaimableUntil.set(e.fleetId, until);
    if (reason !== "WIPED") return;
    const hold = now + msOrZero(S.systemWipeHoldMs);
    if (hold > (wipeHoldUntil.get(e.systemId) || 0)) wipeHoldUntil.set(e.systemId, hold);
  }

  function endEntry(e, reason, now) {
    coolAfterEnd(e, reason, now);
    despawnEntry(e);
    e.phase = PHASE.ENDING;
    e.endReason = reason;
    tryEnd(e, now);
  }

  function writeHeldLosses(now) {
    const held = [...entries.values()].filter((e) => e.lossQueue.length > 0);
    if (held.length === 0) return;
    const fe = facade();
    if (!fe) return;
    const r = tx("presenceLosses", (db) => {
      const done = [];
      for (const e of held) {
        for (const memberKey of e.lossQueue) {
          const m = fe.markDestroyedInTx(db, { exposureId: e.exposureId, memberKey, at: now });
          done.push({ e, memberKey, ok: Boolean(m && m.ok === true), duplicate: Boolean(m && m.duplicate) });
        }
      }
      return { ok: true, done };
    });
    if (!r || r.ok !== true) {
      logLimited(now, `fleetExposure: presence losses not written - ${(r && r.reason) || "no result"} (retry)`);
      return;
    }
    for (const d of r.done) {
      const member = d.e.members.find((x) => x.memberKey === d.memberKey);
      if (d.ok) {
        if (member) member.destroyed = true;
        if (!d.duplicate) bump("presenceLossImported");
        d.e.lastAggressionAt = now;
      } else bump("presenceLossDropped");
    }
    for (const e of held) e.lossQueue = [];
  }

  function expirePending(now) {
    for (const e of [...entries.values()]) {
      if (e.phase !== PHASE.VISIBLE || e.pendingDestroyed.length === 0) continue;
      for (const key of [...e.pendingDestroyed]) {
        const since = e.pendingSince.has(key) ? e.pendingSince.get(key) : now;
        if (now - since < pendingMaxAgeMs) continue;
        const m = e.members.find((x) => x.memberKey === key);
        if (m) dropMember(e, m, false);
        else e.pendingDestroyed = e.pendingDestroyed.filter((k) => k !== key);
        e.pendingSince.delete(key);
        bump("presencePendingExpired");
      }
      if (e.members.length === 0) {
        forget(e);
        noteEnd(e, now, "PENDING_EXPIRED", "DESPAWNED", 0);
        logLimited(now, `fleetExposure: presence ${e.fleetId} - pending kill expired, no ship left`);
      }
    }
  }

  function stepPending(now, out) {
    if (stopped || (entries.size === 0 && lossTracker.sizes().pending === 0)) return;
    for (const l of lossTracker.drain()) {
      const e = entries.get(l.battleId);
      const m = e ? e.members.find((x) => x.memberKey === l.memberKey) : null;
      if (!e || !m || m.destroyed) {
        bump("presenceLossDropped");
        continue;
      }
      if (e.phase === PHASE.VISIBLE) {
        if (canClaim(e)) {
          if (!e.pendingDestroyed.includes(l.memberKey)) e.pendingDestroyed.push(l.memberKey);
          if (!e.pendingSince.has(l.memberKey)) e.pendingSince.set(l.memberKey, now);
        } else {
          bump("presenceLossDropped");
          dropMember(e, m, false);
          despawnUnclaimable(e, now);
        }
      } else if (e.phase === PHASE.HELD || e.phase === PHASE.EXITING) {
        if (!e.lossQueue.includes(l.memberKey)) e.lossQueue.push(l.memberKey);
      } else bump("presenceLossDropped");
    }
    expirePending(now);
    writeHeldLosses(now);
    for (const e of [...entries.values()]) if (e.phase === PHASE.ENDING) tryEnd(e, now);
  }

  function systemFacts(systemId, group, seam) {
    const gone = { sceneLoaded: false, alive: new Map(), aggressors: [], playerChar: new Map(), playerSeen: false,
      players: [] };
    if (safeCall(() => npcSpawn.isSceneLoaded(systemId)) !== true) return gone;
    let players;
    try {
      players = seam.readPlayerShips(systemId);
    } catch (err) {
      players = { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
    if (!players || players.ok !== true) return players && players.reason === "SCENE_NOT_LOADED" ? gone : null;
    const ids = group.flatMap(liveIdsOf);
    let alive = [];
    if (ids.length > 0) {
      const own = seam.readShips(systemId, ids);
      if (!own || own.ok !== true) return null;
      alive = own.ships;
    }
    let aggressors = [];
    if (alive.length > 0) {
      const ag = seam.readAggressors(systemId, alive.map((s) => s.entityId));
      if (ag && ag.ok === true) aggressors = ag.aggressors;
    }
    return { sceneLoaded: true, alive: new Map(alive.map((s) => [s.entityId, s])), aggressors,
      playerChar: new Map(players.ships.map((p) => [p.entityId, p.characterId])), playerSeen: players.ships.length > 0,
      players: players.ships };
  }

  function entryFacts(e, sys) {
    const ids = new Set(liveIdsOf(e));
    const alive = [...ids].filter((id) => sys.alive.has(id)).map((id) => sys.alive.get(id));
    return { sceneLoaded: sys.sceneLoaded, alive, aggressors: sys.aggressors.filter((a) => ids.has(a.entityId)),
      playerChar: sys.playerChar, playerSeen: sys.playerSeen, players: sys.players };
  }

  function aggressionSigOf(facts) {
    return facts.aggressors.filter((a) => a.aggressorKind === "player")
      .map((a) => `${a.entityId}>${a.aggressorId}`).sort().join(",");
  }

  function aggressorCharacterOf(facts) {
    const ids = facts.aggressors.filter((a) => a.aggressorKind === "player").map((a) => a.aggressorId)
      .sort((a, b) => a - b);
    for (const id of ids) if (facts.playerChar.has(id)) return facts.playerChar.get(id);
    return null;
  }

  function newAggressionOf(e, alive) {
    if (alive.length === 0) return false;
    const scene = safeCall(getBeltNavyScene);
    if (!scene || typeof scene.readGroup !== "function") {
      logOnce("group", "fleetExposure: presence - no aggression read (belt navy scene seam unavailable), held ships "
        + "leave after holdQuietMs");
      return false;
    }
    let r;
    try {
      r = scene.readGroup(e.systemId, alive.map((s) => s.entityId));
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !Array.isArray(r.ships)) return false;
    let changed = false;
    for (const s of r.ships) {
      const stamp = `${s.aggressorEntityId}:${s.aggressedAtMs}`;
      const prev = e.groupStamps.get(s.entityId);
      if (prev !== undefined && prev !== stamp && s.aggressedAtMs > 0) changed = true;
      e.groupStamps.set(s.entityId, stamp);
    }
    return changed;
  }

  function failClaim(e, reason, detail, now, out) {
    bump("presenceClaimFailed");
    bump("presenceLossDropped", e.pendingDestroyed.length);
    refuse(out, reason, null, detail);
    despawnEntry(e);
    forget(e);
    unclaimableUntil.set(e.fleetId, now + S.unclaimableCooldownMs);
    noteEnd(e, now, `CLAIM_${reason}`, "DESPAWNED", 0);
    logLimited(now, `fleetExposure: presence claim ${e.fleetId} refused - ${reason}${detail ? ` ${detail}` : ""}`);
  }

  function operationTypeInTx(db, repo, f) {
    if (f.state !== "STAGED" || typeof f.operationId !== "string") return null;
    const op = repo.getOperation(db, f.operationId);
    return op && op.ok === true && op.operation ? op.operation.operationType : null;
  }

  function claimEntry(e, characterId, now, out) {
    const fe = facade();
    const repo = fleetRepo();
    if (!fe || !repo) {
      failClaim(e, fe ? "FLEETS_UNAVAILABLE" : "FLEET_EXPOSURE_UNAVAILABLE", null, now, out);
      return;
    }
    const hostileStates = hostileClaim(e) ? hostileClaimStates : [];
    const r = tx("presenceClaim", (db) => {
      const got = repo.getFleet(db, e.fleetId);
      if (!got || got.ok !== true) return got;
      const f = got.fleet;
      if (!f) return { ok: false, reason: "FLEET_NOT_FOUND" };
      const x = e.transit;
      if (x ? (f.state !== TRAVELLING || f.legSeq !== x.legSeq) : !(PR.claimableOf(f.state,
        operationTypeInTx(db, repo, f), stagedClaimTypes) || PR.hostileClaimableOf(f.state, hostileStates))) {
        return { ok: false, reason: "FLEET_NOT_EXPOSABLE", detail: "state" };
      }
      const exposureId = exposureIdOf(e.fleetId, f.version);
      const at = x ? Math.min(Math.max(now, x.windowStart), x.windowEnd - 1) : now;
      const c = fe.claimInTx(db, { exposureId, fleetId: e.fleetId, expectedVersion: f.version, kind: KIND,
        systemId: e.systemId, operationId: typeof f.operationId === "string" ? f.operationId : null, at,
        characterId, members: e.members.map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup,
          typeId: m.typeId })), destroyed: [...e.pendingDestroyed],
        crossing: x ? { legSeq: x.legSeq, systemIndex: x.systemIndex } : null });
      return c && c.ok === true ? { ...c, exposureId } : c;
    });
    if (!r || r.ok !== true) {
      failClaim(e, (r && r.reason) || "CLAIM_FAILED", r && r.detail, now, out);
      return;
    }
    e.phase = PHASE.HELD;
    e.exposureId = r.exposureId;
    e.claimedAt = now;
    e.lastAggressionAt = now;
    e.characterId = characterId;
    for (const key of e.pendingDestroyed) {
      const m = e.members.find((x) => x.memberKey === key);
      if (m) m.destroyed = true;
    }
    bump("presenceLossImported", e.pendingDestroyed.length);
    e.pendingDestroyed = [];
    e.pendingSince.clear();
    bump("presenceClaimed");
    logLimited(now, `fleetExposure: presence ${e.exposureId} held in ${e.systemId} character=${characterId}`);
  }

  function exitPointOf(e, seam, alive) {
    let listed;
    try {
      listed = seam.listSystemObjects(e.systemId, [...EXIT_KINDS]);
    } catch (_err) {
      listed = null;
    }
    const objects = listed && listed.ok === true && Array.isArray(listed.objects) ? listed.objects : [];
    const gate = e.transit ? objects.find((o) => o && o.kind === "stargate" && o.toSystemId === e.transit.toSystemId)
      : null;
    if (gate && gate.position) return gate.position;
    const from = alive[0] && alive[0].position;
    if (!from || objects.length === 0) return null;
    let best = null;
    for (const o of objects) {
      if (best === null || distanceSq(o.position, from) < distanceSq(best.position, from)) best = o;
    }
    return best.position;
  }

  function startExit(e, seam, alive, now) {
    const point = exitPointOf(e, seam, alive);
    if (point === null) {
      endEntry(e, "QUIET", now);
      return;
    }
    const w = seam.warpShips(e.systemId, alive.map((s) => s.entityId), point, { spreadMeters: warpSpread });
    if (!w || w.ok !== true) {
      logLimited(now, `fleetExposure: presence exit warp ${e.exposureId} - ${(w && w.reason) || "?"}`);
    }
    e.phase = PHASE.EXITING;
    e.exitAt = now;
    e.exitPoint = { ...point };
    bump("presenceExited");
  }

  function ruleOf() {
    if (hostileRule === null) {
      hostileRule = { thresholds: huntThresholds(huntSettings),
        neutralPolicy: parseNeutralPolicy(huntSettings.neutralPolicy) || {},
        secClasses: parseSecClassList(S.hostileSecClasses) || [] };
    }
    return hostileRule;
  }

  function kindOf(factionId) {
    try {
      const kind = getFactionKind(factionId);
      return typeof kind === "string" && kind !== "" ? kind : null;
    } catch (_err) {
      return null;
    }
  }

  const factionMayBeHostile = (factionId) => !excludedFactions.has(factionId) && kindOf(factionId) !== null;

  const hostileClaim = (e) => e.transit === null && hostileOn()
    && PR.hostileClaimableOf(e.fleetState, hostileClaimStates) && factionMayBeHostile(e.factionId);
  const canClaim = (e) => e.claimable === true || hostileClaim(e);

  function withdrawIfDue(e, now) {
    if (e.wakeSeenAt === null) e.wakeSeenAt = now;
    if (now - e.wakeSeenAt < S.hostileWakeDelayMs) return false;
    unclaimableUntil.set(e.fleetId, now + S.unclaimableCooldownMs);
    despawnVisible(e, "WITHDRAWN", now, "presenceHostileWithdrawn");
    logLimited(now, `fleetExposure: presence ${e.fleetId} (${e.fleetState}) withdrew from ${e.systemId} - hostile `
      + "player in range");
    return true;
  }

  function standingOf(characterId, factionId, now) {
    const key = `${characterId}:${factionId}`;
    const hit = standingCache.get(key);
    if (hit && now - hit.at < S.hostileStandingTtlMs) return hit.value;
    if (readStanding === null || hostilePass.reads >= S.hostileMaxStandingReadsPerPass) return null;
    hostilePass.reads += 1;
    let r;
    try {
      r = readStanding(characterId, factionId);
    } catch (_err) {
      r = null;
    }
    const value = r && r.ok === true && typeof r.standing === "number" && Number.isFinite(r.standing)
      ? r.standing : null;
    if (value !== null) standingCache.set(key, { value, at: now });
    return value;
  }

  function isHostileCharacter(characterId, factionId, now) {
    if (!factionMayBeHostile(factionId)) return false;
    const standing = standingOf(characterId, factionId, now);
    if (standing === null) {
      bump("presenceHostileStandingUnknown");
      return false;
    }
    const rule = ruleOf();
    return relationOf(standing, kindOf(factionId), rule.thresholds, rule.neutralPolicy) === "hostile";
  }

  function targetsFor(e, facts, rangeMeters, now) {
    const aggressorEntityIds = new Set(facts.aggressors.filter((a) => a.aggressorKind === "player")
      .map((a) => a.aggressorId));
    return PH.targetsOf({ ships: facts.alive, players: facts.players || [], aggressorEntityIds,
      isHostile: (characterId) => isHostileCharacter(characterId, e.factionId, now), rangeMeters });
  }

  function secClassOf(systemId) {
    const g = safeCall(getGraph);
    const r = g && typeof g.getGraph === "function" ? safeCall(() => g.getGraph()) : null;
    const graph = r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
    const v = graph ? safeCall(() => graph.getSystem(systemId)) : null;
    return v && typeof v.secClass === "string" && v.secClass !== "" ? v.secClass : null;
  }

  function engagedCounts(systemId) {
    let inSystem = 0;
    let global = 0;
    for (const x of entries.values()) {
      if (!x.hostile) continue;
      global += 1;
      if (x.systemId === systemId) inSystem += 1;
    }
    return { inSystem, global };
  }

  function hostileOrders(e, seam, alive, targets, now) {
    if (!seam || typeof seam.attackTargets !== "function") return;
    const ships = alive.map((s) => ({ entityId: s.entityId,
      attackTargetId: s.vendorOrder ? s.vendorOrder.attackTargetId : 0 }));
    const plan = PH.orderPlan(ships, targets, S.hostileMaxOrdersPerPass - hostilePass.orders);
    const hullOf = new Map(e.members.map((m) => [m.entityId, m.hullGroup]));
    for (const o of plan) {
      hostilePass.orders += 1;
      const hull = hullOf.get(o.entityId);
      const isCapital = Boolean(capital) && typeof capital.isCapital === "function" && typeof hull === "string"
        && capital.isCapital(hull) === true;
      let r;
      try {
        r = isCapital
          ? seam.attackTargets(e.systemId, [o.entityId], [o.targetId], { capitalIds: new Set([o.entityId]) })
          : seam.attackTargets(e.systemId, [o.entityId], [o.targetId]);
      } catch (err) {
        r = { ok: false, reason: "ORDER_THREW", detail: messageOf(err) };
      }
      if (r && r.ok === true && !(Array.isArray(r.failed) && r.failed.length > 0)) {
        bump("presenceHostileOrders");
        continue;
      }
      bump("presenceHostileOrderFailed");
      logLimited(now, `fleetExposure: presence attack order ${e.fleetId} ship ${o.entityId} failed - `
        + `${(r && (r.detail || r.reason)) || "?"}`);
    }
  }

  function hostileEnded(e, now) {
    if (!e.hostile) return;
    hostileCooldown.set(e.fleetId, now + S.hostileRewakeCooldownMs);
    bump("presenceHostileEnded");
  }

  function tryWake(e, facts, seam, now, out) {
    if (!facts.sceneLoaded || !factionMayBeHostile(e.factionId)) {
      e.wakeSeenAt = null;
      return false;
    }
    const targets = targetsFor(e, facts, S.hostileAggroRangeMeters, now);
    if (targets.length === 0) {
      e.wakeSeenAt = null;
      return false;
    }
    if (e.transit !== null || !canClaim(e)) {
      if (!e.hostileSkipped) bump("presenceHostileSkippedState");
      e.hostileSkipped = true;
      const keep = canClaim(e) || (e.transit === null && PR.HOSTILE_EXTRA_CLAIM_STATES.includes(e.fleetState));
      return keep ? false : withdrawIfDue(e, now);
    }
    if ((hostileCooldown.get(e.fleetId) || 0) > now) {
      bump("presenceHostileCooled");
      return false;
    }
    if (e.wakeSeenAt === null) e.wakeSeenAt = now;
    if (now - e.wakeSeenAt < S.hostileWakeDelayMs) return false;
    const engaged = engagedCounts(e.systemId);
    const gate = PH.admitWake({ secClass: secClassOf(e.systemId), secClasses: ruleOf().secClasses,
      engagedInSystem: engaged.inSystem, engagedGlobal: engaged.global, wakesThisPass: hostilePass.wakes }, S);
    if (!gate.ok) {
      bump(WAKE_REFUSAL_COUNTER[gate.reason] || "presenceHostileRefusedLimit");
      return false;
    }
    if (!admits(WORK_CLASS_NEW)) {
      bump("presenceHostileRefusedGovernor");
      return false;
    }
    const aggressor = aggressorCharacterOf(facts);
    const characterId = aggressor !== null ? aggressor : targets[0].characterId;
    hostilePass.wakes += 1;
    claimEntry(e, characterId, now, out);
    if (e.phase !== PHASE.HELD) return true;
    e.hostile = { characterId, since: now, wake: true };
    bump("presenceHostileWakes");
    lastWake = { fleetId: e.fleetId, systemId: e.systemId, characterId, at: now };
    logLimited(now, `fleetExposure: presence ${e.fleetId} woke in ${e.systemId} - hostile character=${characterId}`);
    hostileOrders(e, seam, facts.alive, targets, now);
    return true;
  }

  function decideEntry(e, facts, seam, now, out) {
    if (facts.playerSeen) e.lastPlayerSeenAt = now;
    if (e.phase === PHASE.VISIBLE) {
      if (hostileOn() && tryWake(e, facts, seam, now, out)) return;
      const sig = aggressionSigOf(facts);
      const d = R.decideVisible({ now, kind: KIND, pendingKill: e.pendingDestroyed.length > 0,
        playerAggression: sig !== "" && sig !== e.aggressionSig, despawnAt: e.transit ? e.transit.despawnAt : null,
        fleetExposable: true, lastPlayerSeenAt: e.lastPlayerSeenAt, sceneLoaded: facts.sceneLoaded }, P);
      if (d.action === R.ACTION.CLAIM) {
        if (canClaim(e)) {
          claimEntry(e, aggressorCharacterOf(facts), now, out);
          if (e.phase === PHASE.HELD && hostileOn() && factionMayBeHostile(e.factionId)) {
            e.hostile = { characterId: e.characterId, since: now, wake: false };
            bump("presenceHostileRetaliations");
            hostileOrders(e, seam, facts.alive, targetsFor(e, facts, S.hostileChaseRangeMeters, now), now);
          }
        } else despawnUnclaimable(e, now);
      } else if (d.action === R.ACTION.DESPAWN) {
        despawnVisible(e, d.reason, now, d.reason === "TRANSIT_DONE" ? "presenceTransitDone" : undefined);
      }
      return;
    }
    const newAggression = facts.sceneLoaded ? newAggressionOf(e, facts.alive) : false;
    let targets = [];
    if (e.hostile && hostileOn() && facts.sceneLoaded && facts.alive.length > 0) {
      targets = targetsFor(e, facts, S.hostileChaseRangeMeters, now);
    }
    const engaged = newAggression || targets.length > 0;
    if (engaged) e.lastAggressionAt = now;
    const d = R.decideHeld({ now, phase: e.phase, allDestroyed: e.members.every((m) => m.destroyed),
      sceneLoaded: facts.sceneLoaded, alive: facts.alive, lastPlayerSeenAt: e.lastPlayerSeenAt,
      claimedAt: e.claimedAt, lastAggressionAt: e.lastAggressionAt, newAggression: engaged, exitAt: e.exitAt,
      exitPoint: e.exitPoint }, P);
    if (d.action === R.ACTION.END) endEntry(e, d.reason, now);
    else if (d.action === R.ACTION.EXIT) startExit(e, seam, facts.alive, now);
    else if (e.phase === PHASE.EXITING && engaged) {
      e.phase = PHASE.HELD;
      e.exitAt = null;
      e.exitPoint = null;
    }
    if (targets.length > 0 && e.phase === PHASE.HELD) hostileOrders(e, seam, facts.alive, targets, now);
  }

  function stepEntries(now, out) {
    const seam = safeCall(getHuntScene);
    const list = [...entries.values()].filter((e) => e.phase !== PHASE.ENDING)
      .sort((a, b) => byKey(a.fleetId, b.fleetId));
    const bySystem = new Map();
    for (const e of list) {
      if (!bySystem.has(e.systemId)) bySystem.set(e.systemId, []);
      bySystem.get(e.systemId).push(e);
    }
    for (const [systemId, group] of bySystem) {
      if (!seam) {
        for (const e of group) {
          if (e.phase === PHASE.VISIBLE) despawnVisible(e, "SCENE_GONE", now);
          else endEntry(e, "SCENE_GONE", now);
        }
        continue;
      }
      let sys;
      try {
        sys = systemFacts(systemId, group, seam);
      } catch (err) {
        logLimited(now, `fleetExposure: presence read ${systemId} threw - ${messageOf(err)}`);
        continue;
      }
      if (sys === null) continue;
      for (const e of group) {
        if (entries.get(e.fleetId) !== e || e.phase === PHASE.ENDING) continue;
        try {
          decideEntry(e, entryFacts(e, sys), seam, now, out);
        } catch (err) {
          logLimited(now, `fleetExposure: presence ${e.fleetId} threw - ${messageOf(err)}`);
        }
      }
    }
  }

  function candidateSystems(presence) {
    const systems = [];
    for (const id of presence.observedSystems()) {
      const sp = safeCall(() => presence.getSystemPresence(id));
      if (!sp || !(sp.space > 0)) continue;
      if (npcSpawn.isSceneLoaded(id) !== true) continue;
      systems.push(id);
    }
    systems.sort((x, y) => x - y);
    const at = systems.findIndex((s) => s > cursor);
    return at <= 0 ? systems : [...systems.slice(at), ...systems.slice(0, at)];
  }

  function scanSystems(all, transit) {
    const window = all.slice(0, S.maxSystemsPerScan);
    const systems = transit ? [...window.filter((s) => sweep.hasLegsIn(s)), ...window.filter((s) => !sweep.hasLegsIn(s))]
      : window;
    return { systems, window, skipped: all.length - window.length };
  }

  function prune(now) {
    for (const [id, until] of unclaimableUntil) if (now >= until) unclaimableUntil.delete(id);
    for (const [id, until] of yieldHoldUntil) if (now >= until) yieldHoldUntil.delete(id);
    for (const [id, until] of wipeHoldUntil) if (now >= until) wipeHoldUntil.delete(id);
    for (const [id, until] of hostileCooldown) if (now >= until) hostileCooldown.delete(id);
    for (const [key, hit] of standingCache) if (now - hit.at >= S.hostileStandingTtlMs) standingCache.delete(key);
  }

  function transitCandidatesInTx(db, repo, systems, owned, now) {
    const sw = sweep.sweepInTx(db, repo, now);
    if (!sw || sw.ok !== true) return { ids: [], refused: (sw && sw.reason) || "READ_FAILED" };
    const ids = sweep.candidateIds(systems, now).filter((id) => !owned.has(id)
      && !((unclaimableUntil.get(id) || 0) > now)
      && !(entries.has(id) && entries.get(id).phase !== PHASE.VISIBLE));
    return { ids, refused: null };
  }

  function readScan(repo, systems, owned, now) {
    const visible = [...entries.values()].filter((e) => e.phase === PHASE.VISIBLE).map((e) => e.fleetId);
    const transit = transitOn();
    return tx("presenceRead", (db) => {
      const bySystem = new Map();
      const fleets = new Map();
      if (systems.length > 0) {
        const listed = repo.listFleetsInSystems(db, systems, { states: [...PR.PRESENCE_STATES],
          limitPerSystem: S.scanMaxFleetsPerSystem });
        if (!listed || listed.ok !== true) return listed;
        for (const sys of systems) {
          const list = listed.bySystem.get(sys) || [];
          bySystem.set(sys, list);
          for (const f of list) fleets.set(f.fleetId, f);
        }
      }
      const missing = visible.filter((id) => !fleets.has(id));
      let transitIds = [];
      let transitRefused = null;
      let truncated = false;
      if (transit) {
        const c = transitCandidatesInTx(db, repo, systems, owned, now);
        transitRefused = c.refused;
        const needed = new Set(missing);
        const extra = c.ids.filter((id) => !needed.has(id) && !fleets.has(id));
        const room = Math.max(0, maxFleetReads - needed.size);
        truncated = extra.length > room;
        const kept = new Set(extra.slice(0, room));
        transitIds = c.ids.filter((id) => needed.has(id) || fleets.has(id) || kept.has(id));
        for (const id of kept) missing.push(id);
      }
      if (missing.length > 0) {
        const got = repo.getFleets(db, missing);
        if (!got || got.ok !== true) return got;
        for (const f of got.fleets) fleets.set(f.fleetId, f);
      }
      const opTypes = new Map();
      for (const e of entries.values()) {
        if (e.phase !== PHASE.VISIBLE || e.transit) continue;
        const f = fleets.get(e.fleetId);
        const opId = f && typeof f.operationId === "string" ? f.operationId : null;
        if (opId === null || opTypes.has(opId) || (opId === e.operationId && e.operationType !== null)) continue;
        const op = repo.getOperation(db, opId);
        opTypes.set(opId, op && op.ok === true && op.operation ? op.operation.operationType : null);
      }
      return { ok: true, bySystem, fleets, transitIds, transitRefused, truncated, opTypes };
    });
  }

  function refreshTransit(fleets, now) {
    for (const e of [...entries.values()]) {
      if (e.phase !== PHASE.VISIBLE || !e.transit) continue;
      const f = fleets.get(e.fleetId) || null;
      const systems = f && f.route && Array.isArray(f.route.systems) ? f.route.systems : null;
      if (!f || f.state !== e.fleetState || f.legSeq !== e.transit.legSeq || !systems
        || systems[e.transit.systemIndex] !== e.systemId) {
        despawnVisible(e, "FLEET_MOVED", now);
        continue;
      }
      const keys = new Set(PR.detachmentOrder(f).map((m) => m.memberKey));
      e.order = PR.detachmentOrder(f);
      for (const m of [...e.members]) if (!keys.has(m.memberKey)) dropMember(e, m, true);
      if (e.members.length === 0) {
        forget(e);
        noteEnd(e, now, "MEMBERS_GONE", "DESPAWNED", 0);
      }
    }
  }

  function transitCrossings(read, systems, now) {
    const bySys = new Map();
    const observed = new Set(systems);
    const fe = facade();
    const convoyPath = H.convoysEnabled === true && Boolean(fe) && typeof fe.isKindEnabled === "function"
      && safeCall(() => fe.isKindEnabled("CONVOY")) === true;
    for (const id of read.transitIds) {
      const f = read.fleets.get(id) || null;
      if (!f || !T.TRANSIT_STATES.includes(f.state)) {
        sweep.forget(id);
        continue;
      }
      sweep.refresh(f, now);
      if (entries.has(id)) continue;
      const x = T.pickTransit(f, observed, now, TP);
      if (x === null || sweep.wasShown(id, x)) continue;
      if (convoyPath && f.fleetRole === CONVOY_ROLE) continue;
      if (PR.detachmentOrder(f).length === 0) continue;
      if (!bySys.has(x.systemId)) bySys.set(x.systemId, []);
      bySys.get(x.systemId).push({ fleet: f, x });
    }
    return bySys;
  }

  function refreshShown(fleets, opTypes, now) {
    for (const e of [...entries.values()]) {
      if (e.phase !== PHASE.VISIBLE || e.transit) continue;
      const f = fleets.get(e.fleetId) || null;
      const opId = f && typeof f.operationId === "string" ? f.operationId : null;
      const operationType = opId === null ? null
        : (opTypes.has(opId) ? opTypes.get(opId) : (opId === e.operationId ? e.operationType : null));
      const v = PR.stillShown(e, f, now, { operationType, stagedTypes: stagedClaimTypes });
      if (v.action === "DESPAWN") {
        despawnVisible(e, v.reason, now);
        continue;
      }
      e.fleetState = v.fleetState;
      e.operationId = v.operationId;
      e.operationType = operationType;
      e.claimable = v.claimable;
      e.spot = v.spot;
      e.corporationId = f && Number.isSafeInteger(f.corporationId) ? f.corporationId : null;
      e.order = PR.detachmentOrder(f);
      for (const key of v.lostKeys) {
        const m = e.members.find((x) => x.memberKey === key);
        if (m) dropMember(e, m, true);
      }
      if (e.members.length === 0) {
        forget(e);
        noteEnd(e, now, "MEMBERS_GONE", "DESPAWNED", 0);
      }
    }
  }

  function planSystem(sys, list, owned, room, frozen, now, crossings) {
    const shown = [...entries.values()].filter((e) => e.systemId === sys && e.phase === PHASE.VISIBLE)
      .sort((a, b) => byKey(a.fleetId, b.fleetId));
    const transitFresh = (crossings || []).filter((c) => !entries.has(c.fleet.fleetId) && !owned.has(c.fleet.fleetId));
    const heldSlots = [...entries.values()].filter((e) => e.systemId === sys && e.phase !== PHASE.VISIBLE)
      .reduce((n, e) => n + slotsIn(e), 0);
    const shownSlots = shown.reduce((n, e) => n + slotsIn(e), 0);
    const byId = new Map(list.map((f) => [f.fleetId, f]));
    const fresh = list.filter((f) => !entries.has(f.fleetId) && !owned.has(f.fleetId) && f.currentSystemId === sys
      && PR.presenceSpot(f, now) !== null && PR.detachmentOrder(f).length > 0)
      .sort((a, b) => byKey(a.fleetId, b.fleetId));
    const after = fleetCursor.get(sys);
    const at = after === undefined ? -1 : fresh.findIndex((f) => f.fleetId > after);
    const rotated = at <= 0 ? fresh : [...fresh.slice(at), ...fresh.slice(0, at)];
    const cooled = (id) => (unclaimableUntil.get(id) || 0) > now;
    const held = new Set();
    const backoffOf = (id, want, have) => {
      if (want <= have || spawnBackoff.blocked(id, now) === null) return want;
      held.add(id);
      return have;
    };
    const wantOf = (f, e) => {
      const n = f ? PR.detachmentOrder(f).length : e.members.length;
      return Math.min(S.maxShipsPerFleet, n);
    };
    const transitOrder = [
      ...shown.filter((e) => e.transit).map((e) => ({ fleetId: e.fleetId, despawnAt: e.transit.despawnAt,
        want: backoffOf(e.fleetId, Math.min(S.maxShipsPerFleet, e.order.length), e.members.length) })),
      ...transitFresh.map((c) => ({ fleetId: c.fleet.fleetId, despawnAt: c.x.despawnAt,
        want: backoffOf(c.fleet.fleetId, wantOf(c.fleet, null), 0) })),
    ].sort((a, b) => (a.despawnAt - b.despawnAt) || byKey(a.fleetId, b.fleetId))
      .map((o) => ({ fleetId: o.fleetId, want: o.want }));
    const order = [...transitOrder,
      ...shown.filter((e) => !e.transit).map((e) => ({ fleetId: e.fleetId,
        want: backoffOf(e.fleetId, wantOf(byId.get(e.fleetId), e), e.members.length) })),
      ...rotated.map((f) => ({ fleetId: f.fleetId,
        want: cooled(f.fleetId) ? 0 : backoffOf(f.fleetId, wantOf(f, null), 0) }))];
    const budgetCap = heldSlots + shownSlots + Math.max(0, room);
    const cap = Math.min(S.maxShipsPerSystem, budgetCap);
    let targets;
    if (frozen) {
      targets = new Map(order.map((o) => [o.fleetId, entries.has(o.fleetId) ? entries.get(o.fleetId).members.length
        : 0]));
    } else targets = PR.allocate(order, Math.max(0, cap - heldSlots));
    const reasons = new Map();
    for (const f of [...transitFresh.map((c) => c.fleet), ...rotated]) {
      if (targets.get(f.fleetId) > 0) continue;
      if (cooled(f.fleetId)) reasons.set(f.fleetId, "COOLDOWN");
      else if (held.has(f.fleetId)) reasons.set(f.fleetId, "SPAWN_BACKOFF");
      else if (frozen) reasons.set(f.fleetId, frozen);
      else reasons.set(f.fleetId, budgetCap < S.maxShipsPerSystem ? "BUDGET" : "CAP");
    }
    return { sys, shown, fresh: rotated, byId, order, targets, reasons, held: frozen ? [] : [...held],
      transitById: new Map(transitFresh.map((c) => [c.fleet.fleetId, c])) };
  }

  function readOperations(repo, plans) {
    const ids = [];
    for (const p of plans) {
      for (const c of p.transitById.values()) {
        if (ids.length >= S.maxNewShipsPerPass) break;
        if (p.targets.get(c.fleet.fleetId) > 0 && c.fleet.state === TRAVELLING && c.x.systemIndex > 0
          && typeof c.fleet.operationId === "string") ids.push(c.fleet.operationId);
      }
    }
    for (const p of plans) {
      for (const f of p.fresh) {
        if (ids.length >= S.maxNewShipsPerPass) break;
        if (p.targets.get(f.fleetId) > 0 && typeof f.operationId === "string") ids.push(f.operationId);
      }
    }
    const types = new Map();
    if (ids.length === 0) return types;
    const r = tx("presenceOps", (db) => {
      const out = new Map();
      for (const id of [...new Set(ids)]) {
        const op = repo.getOperation(db, id);
        if (op && op.ok === true && op.operation) out.set(id, op.operation.operationType);
      }
      return { ok: true, out };
    });
    return r && r.ok === true ? r.out : types;
  }

  function profileOf(e, m) {
    if (e.profileCache.has(m.memberKey)) return e.profileCache.get(m.memberKey);
    const req = [{ memberKey: m.memberKey, factionId: e.factionId, hullGroup: m.hullGroup, typeId: m.typeId }];
    let profile = null;
    for (const ind of industry ? [true] : [false, true]) {
      const r = safeCall(() => npcSpawn.resolveProfiles(req, { seedPrefix: e.fleetId, invaders, industry: ind }));
      if (r && r.ok === true && Array.isArray(r.profiles) && typeof r.profiles[0] === "string") {
        profile = r.profiles[0];
        break;
      }
    }
    e.profileCache.set(m.memberKey, profile);
    return profile;
  }

  function addShip(e, added) {
    const have = new Set(e.members.map((m) => m.memberKey));
    let tries = 0;
    for (const m of e.order) {
      if (have.has(m.memberKey) || (e.profileCache.has(m.memberKey) && e.profileCache.get(m.memberKey) === null)) {
        continue;
      }
      if (tries >= PROFILE_TRIES) break;
      tries += 1;
      const profileId = profileOf(e, m);
      if (profileId === null) continue;
      const slots = slotsOf(m);
      const reservationId = `${RESERVATION_PREFIX}${m.memberKey}`;
      const reserved = budget.reserve({ reservationId, ownerKind: "fleet", ownerId: e.fleetId, systemId: e.systemId,
        shipCount: slots, metadata: { systemId: e.systemId } });
      if (!reserved || reserved.ok !== true) return "BUDGET";
      const spec = { profileId, anchorDescriptor: { kind: e.anchor.kind, itemID: e.anchor.itemId },
        spawnDistanceMeters: e.spawnDistanceMeters, behavior: "search" };
      if (ownerFactions.has(e.factionId) && Number.isSafeInteger(e.corporationId) && e.corporationId > 0) {
        spec.ownerId = e.corporationId;
      }
      let r;
      try {
        r = npcSpawn.spawnShip(e.systemId, spec);
      } catch (err) {
        r = { ok: false, reason: "SPAWN_THREW", detail: messageOf(err) };
      }
      if (!r || r.ok !== true) {
        budget.release(reservationId);
        if (r && isSceneRefusal(r.reason)) return "BUDGET";
        lastSpawnError = { reason: (r && r.reason) || "SPAWN_FAILED", detail: (r && r.detail) || null };
        return "SPAWN_FAILED";
      }
      const member = { memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId, profileId,
        entityId: r.entityId, reservationId, slots, destroyed: false };
      e.members.push(member);
      added.push(member);
      return "OK";
    }
    return "NO_PROFILE";
  }

  function newEntry(f, sys, objects, operationType, now) {
    const spot = PR.presenceSpot(f, now);
    const where = PR.pickAnchorObject(objects, PR.anchorChainOf(f.state, operationType, spot), worldSeed, f.fleetId);
    if (!where) return null;
    return baseEntry(f, sys, where, operationType, PR.claimableOf(f.state, operationType || null, stagedClaimTypes),
      spot, now);
  }

  function newTransitEntry(c, sys, objects, operationTypes, now) {
    const f = c.fleet;
    const x = c.x;
    const where = T.transitAnchorsOf(objects, x, worldSeed, f.fleetId);
    if (!where) return null;
    const operationType = typeof f.operationId === "string" ? operationTypes.get(f.operationId) || null : null;
    const claimable = T.transitClaimable(f.state, x.systemIndex, operationType, transitClaimTypes);
    const e = baseEntry(f, sys, where, operationType, claimable, null, now);
    e.transit = { legSeq: x.legSeq, systemIndex: x.systemIndex, fromSystemId: x.fromSystemId, toSystemId: x.toSystemId,
      windowStart: x.windowStart, windowEnd: x.windowEnd, despawnAt: x.despawnAt, claimable, operationType,
      exit: where.exit && where.exit.position ? { itemId: where.exit.itemId, position: { ...where.exit.position } }
        : null };
    return e;
  }

  function baseEntry(f, sys, where, operationType, claimable, spot, now) {
    const a = where.anchor;
    const anchor = { kind: a.kind, itemId: a.itemId, position: a.position ? { ...a.position } : null,
      ...(Number.isFinite(a.radius) ? { radius: a.radius } : {}) };
    return {
      key: f.fleetId, fleetId: f.fleetId, factionId: f.factionId,
      corporationId: Number.isSafeInteger(f.corporationId) ? f.corporationId : null, systemId: sys,
      fleetState: f.state, operationId: typeof f.operationId === "string" ? f.operationId : null,
      operationType: operationType || null, claimable, phase: PHASE.VISIBLE, transit: null,
      anchor, anchorFallback: where.fallback === true,
      spawnDistanceMeters: R.spawnDistanceOf(a, S.spawnDistanceMeters, H.surfaceMarginMeters,
        H.stationDefaultRadiusMeters),
      order: PR.detachmentOrder(f), members: [], profileCache: new Map(), pendingDestroyed: [], pendingSince: new Map(),
      lossQueue: [],
      exposureId: null, claimedAt: null, lastAggressionAt: null, aggressionSig: "", lastPlayerSeenAt: now,
      exitAt: null, exitPoint: null, endReason: null, characterId: null, despawned: false, groupStamps: new Map(),
      startedAt: now, spot,
      wakeSeenAt: null, hostile: null, hostileSkipped: false,
    };
  }

  function noteSpawnFailure(fleetId, err, now, log) {
    const reason = err && typeof err.reason === "string" && err.reason !== "" ? err.reason : "SPAWN_FAILED";
    const detail = err && typeof err.detail === "string" && err.detail !== "" ? err.detail : null;
    if (isSceneRefusal(reason)) return;
    const held = spawnBackoff.note(fleetId, failureReasonOf(reason, detail), now);
    if (log && spawnBackoff.enabled && held.first) {
      logLimited(now, `fleetExposure: presence ${log} ${fleetId} rolled back - ${reason}${detail ? ` ${detail}` : ""}`
        + ` backoff=${held.retryAt - now}ms failures=${held.failures}`);
    }
  }

  function applySystem(p, seam, operationTypes, spawnsLeft, now, out) {
    for (const e of p.shown) {
      if (entries.get(e.fleetId) !== e) continue;
      const target = p.targets.has(e.fleetId) ? p.targets.get(e.fleetId) : e.members.length;
      while (e.members.length > target) {
        dropMember(e, e.members[e.members.length - 1], true);
        bump("presenceTrimmed");
      }
      if (e.members.length === 0) {
        forget(e);
        noteEnd(e, now, "TRIMMED", "DESPAWNED", 0);
        p.reasons.set(e.fleetId, "CAP");
      }
    }
    let objects = null;
    const objectsOf = () => {
      if (objects !== null) return objects;
      let listed;
      try {
        listed = seam.listSystemObjects(p.sys, [...PR.ANCHOR_KINDS]);
      } catch (_err) {
        listed = null;
      }
      objects = listed && listed.ok === true && Array.isArray(listed.objects) ? listed.objects : [];
      return objects;
    };
    const work = p.order.filter((o) => p.targets.get(o.fleetId) > 0);
    const pending = new Map();
    const added = new Map();
    const failed = new Set();
    let spawned = 0;
    let budgetBlocked = false;
    let lastStarted = null;
    const maxTarget = work.reduce((m, o) => Math.max(m, p.targets.get(o.fleetId)), 0);
    for (let r = 1; r <= maxTarget && !budgetBlocked; r += 1) {
      for (const o of work) {
        if (budgetBlocked || spawned >= spawnsLeft) break;
        if (failed.has(o.fleetId) || p.targets.get(o.fleetId) < r) continue;
        let e = entries.get(o.fleetId) || pending.get(o.fleetId) || null;
        if (e && (e.phase !== PHASE.VISIBLE || e.members.length >= r)) continue;
        if (!e) {
          const c = p.transitById.get(o.fleetId);
          const f = c ? null : p.byId.get(o.fleetId);
          const opType = f && typeof f.operationId === "string" ? operationTypes.get(f.operationId) || null : null;
          if (c) e = newTransitEntry(c, p.sys, objectsOf(), operationTypes, now);
          else e = f ? newEntry(f, p.sys, objectsOf(), opType, now) : null;
          if (!e) {
            failed.add(o.fleetId);
            p.reasons.set(o.fleetId, "NO_ANCHOR");
            refuse(out, "NO_ANCHOR", "presenceRefusedNoAnchor", o.fleetId);
            continue;
          }
          pending.set(o.fleetId, e);
        }
        if (!added.has(e.fleetId)) added.set(e.fleetId, []);
        const res = addShip(e, added.get(e.fleetId));
        if (res === "OK") {
          spawned += 1;
          if (pending.has(e.fleetId) && e.members.length === 1 && !e.transit) lastStarted = e.fleetId;
          continue;
        }
        failed.add(e.fleetId);
        if (res === "BUDGET") {
          budgetBlocked = true;
          refuse(out, "BUDGET", "presenceRefusedBudget", e.fleetId);
          if (e.members.length === 0) p.reasons.set(e.fleetId, "BUDGET");
        } else if (res === "NO_PROFILE") {
          if (e.members.length === 0) {
            refuse(out, "NO_PROFILE", "presenceRefusedProfile", e.fleetId);
            p.reasons.set(e.fleetId, "NO_PROFILE");
          }
        } else {
          for (const m of added.get(e.fleetId)) dropMember(e, m, true);
          spawned -= added.get(e.fleetId).length;
          added.set(e.fleetId, []);
          refuse(out, "SPAWN_FAILED", "presenceSpawnFailed", e.fleetId);
          if (e.members.length === 0) p.reasons.set(e.fleetId, "SPAWN_FAILED");
          noteSpawnFailure(e.fleetId, lastSpawnError, now, "spawn");
        }
      }
      if (spawned >= spawnsLeft) break;
    }
    if (spawned >= spawnsLeft && lastStarted !== null) fleetCursor.set(p.sys, lastStarted);
    for (const o of work) {
      const e = entries.get(o.fleetId) || pending.get(o.fleetId);
      if ((!e || e.members.length === 0) && !p.reasons.has(o.fleetId)) {
        p.reasons.set(o.fleetId, budgetBlocked ? "BUDGET" : "PASS_LIMIT");
      }
    }
    const newIds = [...added.values()].flat().map((m) => m.entityId);
    if (newIds.length > 0) {
      let pub;
      try {
        pub = npcSpawn.publish(p.sys, newIds);
      } catch (err) {
        pub = { ok: false, reason: "PUBLISH_FAILED", detail: messageOf(err) };
      }
      if (!pub || pub.ok !== true || !(pub.published >= newIds.length)) {
        for (const [fleetId, list] of added) {
          const e = entries.get(fleetId) || pending.get(fleetId);
          for (const m of list) dropMember(e, m, true);
          if (list.length > 0 && e.members.length === 0) p.reasons.set(fleetId, "SPAWN_FAILED");
          if (list.length > 0) {
            noteSpawnFailure(fleetId, pub && pub.ok !== true ? pub : { reason: "PUBLISH_PARTIAL" }, now, null);
          }
        }
        bump("presenceSpawnFailed");
        logLimited(now, `fleetExposure: presence publish in ${p.sys} failed - ${(pub && (pub.detail || pub.reason))
          || "partial"}`);
        for (const [fleetId] of pending) if (!entries.has(fleetId)) p.reasons.set(fleetId, "SPAWN_FAILED");
        return 0;
      }
    }
    for (const [fleetId, list] of added) {
      const e = entries.get(fleetId) || pending.get(fleetId);
      if (list.length === 0 || !e.transit || !e.transit.exit) continue;
      let w;
      try {
        w = seam.warpShips(p.sys, list.map((m) => m.entityId), e.transit.exit.position, { spreadMeters: warpSpread });
      } catch (err) {
        w = { ok: false, reason: "WARP_THREW", detail: messageOf(err) };
      }
      if (w && w.ok === true) continue;
      for (const m of list) dropMember(e, m, true);
      added.set(fleetId, []);
      if (e.members.length === 0) p.reasons.set(fleetId, "SPAWN_FAILED");
      refuse(out, "SPAWN_FAILED", "presenceSpawnFailed", fleetId);
      logLimited(now, `fleetExposure: presence transit warp ${fleetId} failed - ${(w && (w.detail || w.reason)) || "?"}`);
      noteSpawnFailure(fleetId, w ? { reason: w.reason || "WARP_FAILED", detail: w.detail || null } : null, now, null);
    }
    let ships = 0;
    for (const [fleetId, list] of added) {
      if (list.length === 0) continue;
      const e = entries.get(fleetId) || pending.get(fleetId);
      spawnBackoff.clear(fleetId);
      if (!entries.has(fleetId)) {
        entries.set(fleetId, e);
        if (e.transit) {
          sweep.noteShown(fleetId, e.transit);
          bump("presenceStartedTransit");
        } else bump("presenceStarted");
        if (e.anchorFallback) bump("presenceAnchorFallback");
        logLimited(now, `fleetExposure: presence ${fleetId} (${e.fleetState}) visible in ${p.sys}`
          + ` ships=${e.members.length}${e.transit ? ` transit -> ${e.transit.toSystemId} despawnAt=`
            + `${e.transit.despawnAt}` : ""}`);
      }
      lossTracker.track(fleetId, list.map((m) => ({ memberKey: m.memberKey, entityId: m.entityId })));
      ships += list.length;
    }
    bump("presenceShips", ships);
    return ships;
  }

  function stepScan(now, presence, out) {
    if (S.enabled !== true || !(S.maxShipsPerSystem > 0)) return;
    const fe = facade();
    if (!fe || typeof fe.isKindEnabled !== "function" || safeCall(() => fe.isKindEnabled(KIND)) !== true) {
      logOnce("facade", "fleetExposure: no presence - ctx.fleetExposure PRESENCE not enabled");
      return;
    }
    if (!lossImportOn) {
      logOnce("lossImport", "fleetExposure: no presence - battle.liveLossImport off");
      return;
    }
    if (lastScanAt !== null && now - lastScanAt < S.scanIntervalMs) return;
    lastScanAt = now;
    const seam = safeCall(getHuntScene);
    if (!seam) {
      logOnce("seam", "fleetExposure: no presence - hunt scene seam unavailable");
      refuse(out, "SEAM_UNAVAILABLE", "presenceScanRefused");
      return;
    }
    const repo = fleetRepo();
    if (!repo) {
      refuse(out, "FLEETS_UNAVAILABLE", "presenceScanRefused");
      return;
    }
    const all = candidateSystems(presence);
    const transit = transitOn();
    if (transit) sweep.observe(all, now);
    const sel = scanSystems(all, transit);
    const systems = sel.systems;
    if (sel.window.length > 0) cursor = sel.window[sel.window.length - 1];
    prune(now);
    bump("presenceScans");
    bump("presenceScanSystemsSkipped", sel.skipped);
    const owned = safeCall(getOwnedFleetIds) || new Set();
    const read = readScan(repo, systems, owned, now);
    if (!read || read.ok !== true) {
      refuse(out, (read && read.reason) || "READ_FAILED", "presenceScanRefused");
      return;
    }
    for (const list of read.bySystem.values()) {
      if (list.length >= S.scanMaxFleetsPerSystem) bump("presenceScanTruncated");
    }
    if (read.truncated) bump("presenceScanTruncated");
    if (read.transitRefused) {
      refuse(out, read.transitRefused, "presenceTransitRefused");
      logLimited(now, `fleetExposure: presence transit page refused - ${read.transitRefused}`);
    }
    refreshShown(read.fleets, read.opTypes, now);
    refreshTransit(read.fleets, now);
    for (const e of [...entries.values()]) {
      if (e.phase === PHASE.VISIBLE && owned.has(e.fleetId)) releaseFleet(e.fleetId);
    }
    const crossings = transit ? transitCrossings(read, systems, now) : new Map();
    if (transit) gauge("fleetExposure.presenceTransitLegs", sweep.getStatus().legs);
    const governorOk = admits(WORK_CLASS_NEW);
    if (!governorOk) refuse(out, "GOVERNOR", "presenceRefusedGovernor");
    const status = budget.getStatus();
    const limits = budget.getLimits();
    let globalRoom = limits.global - status.reservedShips;
    const plans = [];
    for (const sys of systems) {
      const room = Math.min(limits.perSystem - (status.reservedBySystem[sys] || 0), globalRoom);
      const frozen = !governorOk ? "GOVERNOR" : ((yieldHoldUntil.get(sys) || 0) > now ? "YIELD_HOLD"
        : ((wipeHoldUntil.get(sys) || 0) > now ? "WIPE_HOLD" : null));
      const p = planSystem(sys, read.bySystem.get(sys) || [], owned, room, frozen, now, crossings.get(sys) || []);
      for (const id of p.held) refuse(out, "SPAWN_BACKOFF", "presenceRefusedBackoff", id);
      const before = p.shown.reduce((n, e) => n + e.members.length, 0);
      const after = [...p.targets.values()].reduce((n, t) => n + t, 0);
      globalRoom -= Math.max(0, after - before);
      plans.push(p);
    }
    const operationTypes = readOperations(repo, plans);
    let spawnsLeft = S.maxNewShipsPerPass;
    const hidden = new Map();
    let hiddenFleets = 0;
    for (let i = 0; i < plans.length; i += 1) {
      const p = plans[i];
      const left = spawnsLeft;
      spawnsLeft -= applySystem(p, seam, operationTypes, Math.max(0, spawnsLeft), now, out);
      if (left > 0 && spawnsLeft <= 0) cursor = cursorAfterCut(sel.window, systems, i, sel.skipped === 0);
      const list = [];
      for (const o of p.order) {
        const e = entries.get(o.fleetId);
        if (e && e.members.length > 0) continue;
        const reason = p.reasons.get(o.fleetId) || (left > 0 ? "CAP" : "PASS_LIMIT");
        list.push({ fleetId: o.fleetId, reason: HIDDEN_REASONS.includes(reason) ? reason : "CAP" });
      }
      hiddenFleets += list.length;
      if (list.length > 0) hidden.set(p.sys, { at: now, fleets: list });
    }
    lastHidden = hidden;
    hiddenCount = hiddenFleets;
    gauge("fleetExposure.presenceHiddenFleets", hiddenFleets);
  }

  function step(now, presence, out) {
    if (stopped || (S.enabled !== true && entries.size === 0)) return;
    const t0 = nowMs();
    hostilePass = { reads: 0, orders: 0, wakes: 0 };
    if (entries.size > 0) stepEntries(now, out);
    if (presence) stepScan(now, presence, out);
    let live = 0;
    for (const e of entries.values()) live += liveIdsOf(e).length;
    gauge("fleetExposure.presenceShipsLive", live);
    observe("fleetExposure.presenceStepMs", nowMs() - t0);
  }

  function releaseFleet(fleetId) {
    const e = entries.get(fleetId);
    if (!e || e.phase !== PHASE.VISIBLE) return { ok: true, released: 0 };
    const n = e.members.length;
    despawnVisible(e, "HANDED_OVER", clock.now(), "presenceHandedOver");
    return { ok: true, released: n };
  }

  function hasPendingLoss(fleetId) {
    const e = entries.get(fleetId);
    return Boolean(e && e.phase === PHASE.VISIBLE && e.pendingDestroyed.length > 0);
  }

  function handOver(fleetId) {
    if (hasPendingLoss(fleetId)) return { ok: false, reason: "PRESENCE_PENDING_LOSS" };
    return releaseFleet(fleetId);
  }

  function releaseFleets(ids) {
    let released = 0;
    for (const id of Array.isArray(ids) ? ids : []) released += releaseFleet(id).released;
    return { ok: true, released };
  }

  const yieldPool = () => [...entries.values()].filter((e) => e.phase === PHASE.VISIBLE && !e.despawned
    && e.pendingDestroyed.length === 0 && e.members.length > 0);

  function freeable(systemId) {
    if (stopped) return { system: 0, global: 0 };
    let system = 0;
    let global = 0;
    for (const e of yieldPool()) {
      const n = slotsIn(e);
      global += n;
      if (e.systemId === systemId) system += n;
    }
    return { system, global };
  }

  function yieldShips(systemId, need, now) {
    const needSystem = need && need.system > 0 ? need.system : 0;
    const needGlobal = need && need.global > 0 ? need.global : 0;
    if (stopped || (needSystem === 0 && needGlobal === 0)) {
      return { ok: false, reason: "NOTHING_TO_YIELD", freeable: 0 };
    }
    const f = freeable(systemId);
    const usable = needGlobal > 0 ? f.global : f.system;
    if (f.system < needSystem || usable < needGlobal) return { ok: false, reason: "NOT_ENOUGH", freeable: usable };
    let freed = 0;
    let freedOwn = 0;
    const touched = new Set();
    const emptied = new Set();
    const biggest = (list) => list.sort((a, b) => (b.members.length - a.members.length)
      || byKey(b.fleetId, a.fleetId))[0];
    while (freedOwn < needSystem || freed < needGlobal) {
      const pool = yieldPool();
      const own = pool.filter((e) => e.systemId === systemId);
      let from = own;
      if (own.length === 0) {
        if (freedOwn < needSystem) break;
        const bySys = new Map();
        for (const e of pool) bySys.set(e.systemId, (bySys.get(e.systemId) || 0) + slotsIn(e));
        const top = [...bySys.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0];
        from = top ? pool.filter((e) => e.systemId === top[0]) : [];
      }
      if (from.length === 0) break;
      const e = biggest(from);
      const m = e.members[e.members.length - 1];
      dropMember(e, m, true);
      freed += m.slots;
      if (e.systemId === systemId) freedOwn += m.slots;
      touched.add(e.systemId);
      if (e.members.length === 0) {
        emptied.add(e.fleetId);
        forget(e);
        noteEnd(e, now, "YIELDED", "DESPAWNED", 0);
      }
    }
    for (const sys of touched) yieldHoldUntil.set(sys, now + S.yieldHoldMs);
    bump("presenceYielded", freed);
    logLimited(now, `fleetExposure: presence yields ${freed} ships to a higher path in ${systemId}`);
    return { ok: true, freed, entries: emptied.size };
  }

  function relationGroups() {
    const groups = [];
    for (const e of entries.values()) {
      if (e.despawned || (e.phase !== PHASE.VISIBLE && e.phase !== PHASE.HELD && e.phase !== PHASE.EXITING)) continue;
      const entityIds = liveIdsOf(e);
      if (entityIds.length === 0) continue;
      const hullOf = new Map(e.members.map((m) => [m.entityId, m.hullGroup]));
      groups.push({ systemId: e.systemId, factionId: e.factionId, entityIds,
        hullGroups: entityIds.map((id) => (hullOf.has(id) ? hullOf.get(id) : null)), aggressors: null,
        primaryCharacterId: Number.isSafeInteger(e.characterId) ? e.characterId : null });
    }
    return groups;
  }

  function hostileStatus() {
    const bySystem = {};
    let engaged = 0;
    for (const e of entries.values()) {
      if (!e.hostile) continue;
      engaged += 1;
      bySystem[e.systemId] = (bySystem[e.systemId] || 0) + 1;
    }
    const now = clock.now();
    const cooled = [...hostileCooldown.values()].filter((until) => until > now).length;
    return { enabled: hostileOn(), engaged, bySystem, cooled, lastWake: lastWake ? { ...lastWake } : null };
  }

  function getStatus() {
    const by =(phase) => [...entries.values()].filter((e) => e.phase === phase).length;
    let ships = 0;
    for (const e of entries.values()) ships += liveIdsOf(e).length;
    const hidden = {};
    for (const [sys, h] of lastHidden) hidden[sys] = h.fleets.map((x) => ({ ...x }));
    return {
      state: stopped ? "stopped" : (S.enabled === true ? "on" : "off"),
      lossImport: lossImportOn ? "on" : "off",
      visible: by(PHASE.VISIBLE),
      held: by(PHASE.HELD),
      exiting: by(PHASE.EXITING),
      ending: by(PHASE.ENDING),
      ships,
      hiddenFleets: hiddenCount,
      entries: [...entries.values()].map((e) => ({ fleetId: e.fleetId, systemId: e.systemId, factionId: e.factionId,
        phase: e.phase, fleetState: e.fleetState, claimable: e.claimable, ships: e.members.length,
        memberKeys: e.members.map((m) => m.memberKey), entityIds: liveIdsOf(e),
        destroyed: e.members.filter((m) => m.destroyed).length, state: "LIVE", mode: KIND, startedAt: e.startedAt,
        exposureId: e.exposureId, anchorKind: e.anchor.kind,
        object: { kind: e.anchor.kind, itemId: e.anchor.itemId, point: e.anchor.position },
        transit: e.transit ? { systemIndex: e.transit.systemIndex, despawnAt: e.transit.despawnAt,
          toSystemId: e.transit.toSystemId } : null,
        hostileCharacterId: e.hostile && Number.isSafeInteger(e.hostile.characterId) ? e.hostile.characterId : null })),
      hostile: hostileStatus(),
      transit: sweep.getStatus(),
      hidden,
      counters: { ...counters },
      lastRefusal,
      recentEnds: recentEnds.map((x) => ({ ...x })),
      lossTracker: lossTracker.sizes(),
    };
  }

  function stop() {
    stopped = true;
    sweep.stop();
  }

  function inboundFleets(systemId, nowMs, max) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    if (S.enabled !== true || !transitOn()) return { ok: false, reason: "TRANSIT_OFF" };
    if (!Number.isSafeInteger(systemId) || systemId <= 0 || !Number.isSafeInteger(nowMs)
      || !Number.isSafeInteger(max) || max < 1) return { ok: false, reason: "INVALID_INPUT" };
    return { ok: true, fleets: sweep.inboundTo(systemId, nowMs, max) };
  }

  return Object.freeze({ stepPending, step, getStatus, stop, relationGroups, freeable, yieldShips, releaseFleet,
    releaseFleets, hasPendingLoss, handOver, inboundFleets });
}

module.exports = { createPresenceStep, COUNTER_NAMES, PRESENCE_COUNTER_NAMES: COUNTER_NAMES, HIDDEN_REASONS,
  RESERVATION_PREFIX, cursorAfterCut };
