"use strict";

const { decideHuntStep, PHASES } = require("../playerHunt/phases");
const { relationOf, sweepOrder, dscanOrder, placeAnomalies, pickCandidate, pickClaimCandidates,
  compareHuntCandidates, hasScanner, buildGroupIndex, hullClassOf, huntSizeFor, huntThresholds, currentObjectOf,
  HULL_RANK, compareHeavyCandidates, heatOf, escalatedApproachJumps, escalatedCap }
  = require("../playerHunt/policy");
const { QUIET_REASONS } = require("../playerHunt/repel");
const { membersOf, pickDetachment, pickMatchedDetachment } = require("../playerHunt/huntRepository");
const { TYPES: STRENGTH_TYPES } = require("../battle/data/strengthCatalog");
const { locateCharacter, decidePursuit, constraintsOf, arrivalGateIndex, stateInSystem }
  = require("../playerHunt/pursuit");
const { pickExitObject, watchedBy, pickCampStation } = require("../playerHunt/exit");
const { approachSystems, orderApproachCandidates } = require("../playerHunt/approach");
const PH = require("../playerHunt/schema");
const { parseHullGroupList } = require("../fleets/schema");
const { ONE_AU_M } = require("../fleets/data/travelProfiles");
const { NO_CAPITAL_RULES } = require("./capitalRules");
const { createSpawnBackoff, failureReasonOf } = require("./spawnBackoff");
const { sceneRefusalOf, isSceneRefusal } = require("./sceneBudget");

const SCENE_SOURCE = "npcSpawn";

const COUNTER_NAMES = Object.freeze(["started", "refusedBudget", "refusedStanding", "refusedCooldown",
  "refusedNoCandidate", "refusedProfile", "refusedObjects", "refusedClaim", "refusedGovernor", "spawnFailed",
  "engaged", "retaliated", "retargeted", "objectsVisited", "scanCycles", "scanHits", "orderFailed", "readFailed",
  "lossImported", "lossStale", "lossFailed", "ended", "endFailed", "warpNoStart", "spawnNotVisible",
  "orderLost",
  "pursuitStarted", "pursuitHops", "pursuitRematerialized", "pursuitGaveUp", "pursuitLost", "pursuitDropped",
  "pursuitRefused",
  "exitStarted", "exitLanded", "exitForced", "retreated", "returnStarted", "returnRefused",
  "campStarted", "campEngaged", "campEnded",
  "npcTargeted", "npcRetaliated", "dscanRanked",
  "approachStarted", "approachRefused", "approachNoCandidate",
  "claimStarted", "claimUnstaged", "claimRefusedSize", "repelApplied", "repelRefused",
  "scaled", "scaleUnknownHull",
  "warningSent", "warningUndelivered", "warningSuppressed", "warningLapsed", "warningGone", "warningSpawned",
  "anomaliesInSweep", "anomalySourceSkipped",
  "warmScanHits",
  "sweepRetargets",
  "returnAfterPursuit",
  "lneRetaliated", "lneArmed", "lneArmFailed", "lneArmDeferred",
  "detachmentOversize",
  "escalationHeatReads", "escalationHeated", "escalationReadFailed", "detachmentMatched",
  "officerSpawned", "officerRefused",
  "refusedBackoff"]);
const { QUIET_REASONS: OFFICER_QUIET } = require("../officers/schema");

const WORK_CLASS_NEW = "OPERATIONAL";
const HEAT_ROWS_PER_POINT = 4;
const SPAWN_FAILED = "SPAWN_FAILED";
const SPAWN_NOT_VISIBLE = "SPAWN_NOT_VISIBLE";
const MODE_SWEEP = "SWEEP";
const MODE_SCAN = "SCAN";
const PURSUIT = "PURSUIT";
const TARGET_GONE = "TARGET_GONE";
const RETREATED = PH.RETREATED_END_REASON;
const TARGET_DOCKED = PH.TARGET_DOCKED_END_REASON;
const WARNING_LEAD = "WARNING_LEAD";
const HUNT_WARNING = "HUNT_WARNING";
const PURSUIT_EN_ROUTE = Object.freeze(["PLANNED", "TRAVELLING", "STAGED"]);
const LOSS_STALE = Object.freeze(["NOT_LIVE", "HUNT_NOT_FOUND"]);
const PERMANENT_END = Object.freeze(["HUNT_NOT_FOUND", "FLEET_NOT_FOUND", "FLEET_NOT_MATERIALIZED",
  "PLAYER_HUNT_INVALID_INPUT"]);
const MAX_DETAIL = 120;
const MINUTE_MS = 60000;
const LOG_LINES_PER_MIN = 10;
const MS_DECIMALS = 1000;

class StepError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = String(reason);
    this.detail = detail === undefined || detail === null ? null : String(detail).slice(0, MAX_DETAIL);
  }
}

function noop() {}

function compositionOf(members) {
  const counts = new Map();
  for (const m of members) counts.set(m.hullGroup, (counts.get(m.hullGroup) || 0) + 1);
  return [...counts].map(([hullGroup, count]) => ({ hullGroup, count }));
}

function sameMembers(stored, planned) {
  return Array.isArray(stored) && stored.length === planned.length
    && stored.every((m, i) => m && m.memberKey === planned[i].memberKey);
}

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

function createHuntStep(deps) {
  const { store, clock, npcSpawn, budget, lossTracker } = deps;
  const S = deps.settings;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const hooks = deps.hooks && typeof deps.hooks === "object" ? deps.hooks : {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
  const getPlayerHunt = typeof deps.getPlayerHunt === "function" ? deps.getPlayerHunt : () => null;
  const getFactionKind = typeof deps.getFactionKind === "function" ? deps.getFactionKind : () => null;
  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
  const getHuntScene = typeof deps.getHuntScene === "function" ? deps.getHuntScene : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const getOccupation = typeof deps.getOccupation === "function" ? deps.getOccupation : () => null;
  const getNotices = typeof deps.getNotices === "function" ? deps.getNotices : () => null;
  const getOfficerSpawns = typeof deps.getOfficerSpawns === "function" ? deps.getOfficerSpawns : () => null;
  const readStanding = typeof deps.readStanding === "function" ? deps.readStanding : null;
  const getOwnedShipIds = typeof deps.getOwnedShipIds === "function" ? deps.getOwnedShipIds : () => null;
  const spawnBackoff = deps.spawnBackoff && typeof deps.spawnBackoff.blocked === "function" ? deps.spawnBackoff
    : createSpawnBackoff(null);
  const getLneGroups = typeof deps.getLneGroups === "function" ? deps.getLneGroups : null;
  const isFactionEnemy = typeof deps.isFactionEnemy === "function" ? deps.isFactionEnemy : null;
  const lneOn = S.lneRetaliationEnabled === true && getLneGroups !== null && isFactionEnemy !== null;
  const lneArmMax = Number.isSafeInteger(S.lneArmMaxPerPass) ? S.lneArmMaxPerPass : 0;
  const attackLockOn = deps.attackLockOn === true;
  const despawnAll = deps.despawnAll;
  const capital = deps.capital && typeof deps.capital.slotsOf === "function" ? deps.capital : NO_CAPITAL_RULES;
  const admits = typeof deps.admits === "function" ? deps.admits : () => true;
  const lossImportOn = deps.lossImportOn === true;
  const excluded = Array.isArray(deps.excludedFactionIds) ? [...deps.excludedFactionIds] : [];
  const retargetLimit = Number.isSafeInteger(deps.maxRetargetsPerPass) ? deps.maxRetargetsPerPass : 0;
  const neutralPolicy = PH.parseNeutralPolicy(S.neutralPolicy) || {};
  const roles = PH.parseRoleList(S.roles) || [];
  const oversizeOk = S.oversizeDetachmentEnabled === true;
  const objectKinds = PH.parseObjectKinds(S.objectKinds) || [];
  const scannerHullGroups = parseHullGroupList(S.scannerHullGroups) || [];
  const scaleTable = PH.parseScaleTable(S.scaleTable) || {};
  const groupIndex = buildGroupIndex(STRENGTH_TYPES);
  const thresholds = huntThresholds(S);
  const claimParams = Object.freeze({ ...S, retreatEnabled: true, retreatLossPermille: S.claimRepelLossPermille });
  const escalationOn = S.escalationEnabled === true;
  const matchOn = S.detachmentMatchEnabled === true;
  const heatParams = Object.freeze({ lossPermille: S.claimRepelLossPermille, maxHeat: S.escalationMaxHeat });

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const entries = new Map();
  const pursuits = new Map();
  const approachNextAt = new Map();
  const pendingHops = new Map();
  const chainEnds = new Map();
  let firstSeen = new Map();
  const warnings = new Map();
  const quietUntil = new Map();
  let cursor = 0;
  let lastRefusal = null;
  const loggedOnce = new Set();
  let errorWindow = -Infinity;
  let errorLines = 0;
  let pass = newPass(null);
  const armedIds = new Set();

  function newPass(at) {
    return { at, standing: new Map(), reads: 0, players: new Map(), routes: new Map(), lneShips: null,
      warned: 0, lneFaction: null, arms: 0, heat: new Map() };
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`playerHunt.${name}`, n);
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

  function publishGauges() {
    let ships = 0;
    for (const e of entries.values()) if (!e.despawned) ships += e.spawned.length;
    gauge("playerHunt.active", entries.size);
    gauge("playerHunt.ships", ships);
    if (S.pursuitEnabled === true || S.approachEnabled === true || pursuits.size > 0) {
      gauge("playerHunt.pursuits", pursuits.size);
    }
    if (S.warningEnabled === true || warnings.size > 0) gauge("playerHunt.warnings", warnings.size);
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
    const key = `hunt:${reason}`;
    if (out && out.refused) out.refused[key] = (out.refused[key] || 0) + 1;
    lastRefusal = { reason: String(reason), detail: detail || null, at: clock.now() };
  }

  function tx(name, fn) {
    const r = store.transaction(`materialization.${name}`, fn);
    if (r && r.ok) return r.value;
    return { ok: false, reason: (r && r.reason) || "TX_FAILED",
      ...(r && r.error ? { detail: messageOf(r.error) } : {}) };
  }

  const idsOf = (e) => e.spawned.map((s) => s.entityId);
  const hullGroupsOf = (e) => (e.hullGroupOf instanceof Map
    ? { hullGroups: idsOf(e).map((id) => (e.hullGroupOf.has(id) ? e.hullGroupOf.get(id) : null)) } : {});

  function playerHunt() {
    const ph = safeCall(getPlayerHunt);
    return ph && typeof ph.isEnabled === "function" ? ph : null;
  }

  function beginPass(now) {
    if (pass.at === now) return;
    pass = newPass(now);
  }

  function standingOf(characterId, factionId) {
    const key = `${characterId}:${factionId}`;
    if (pass.standing.has(key)) return pass.standing.get(key);
    if (readStanding === null || pass.reads >= S.maxStandingReadsPerPass) return null;
    pass.reads += 1;
    let r;
    try {
      r = readStanding(characterId, factionId);
    } catch (err) {
      r = { ok: false, reason: "STANDING_READ_THREW", detail: messageOf(err) };
    }
    const value = r && r.ok === true && typeof r.standing === "number" && Number.isFinite(r.standing)
      ? r.standing : null;
    pass.standing.set(key, value);
    return value;
  }

  function kindOf(factionId) {
    try {
      const kind = getFactionKind(factionId);
      return typeof kind === "string" && kind !== "" ? kind : null;
    } catch (_err) {
      return null;
    }
  }

  function targetByStanding(characterId, factionId) {
    const standing = standingOf(characterId, factionId);
    if (standing === null) return { target: false, standing: null };
    return { target: relationOf(standing, kindOf(factionId), thresholds, neutralPolicy) === "hostile", standing };
  }

  function stepLosses(now, ph) {
    const losses = lossTracker.drain();
    if (losses.length === 0) return;
    if (!ph) {
      bump("lossFailed", losses.length);
      return;
    }
    const r = tx("huntLosses", (db) => {
      const n = { imported: 0, stale: 0, failed: 0, huntIds: new Set(), lost: [] };
      for (const l of losses) {
        const m = ph.markDestroyedInTx(db, { huntId: l.battleId, memberKey: l.memberKey });
        if (m && m.ok === true) {
          n.lost.push(l);
          if (m.duplicate !== true) {
            n.imported += 1;
            n.huntIds.add(l.battleId);
          }
        } else if (m && LOSS_STALE.includes(m.reason)) n.stale += 1;
        else n.failed += 1;
      }
      return { ok: true, ...n };
    });
    if (!r || r.ok !== true) {
      bump("lossFailed", losses.length);
      logLimited(now, `playerHunt: losses not imported (${losses.length}) - ${(r && r.reason) || "no result"}`);
      return;
    }
    for (const huntId of r.huntIds) {
      const e = entries.get(huntId);
      if (e) e.spawnConfirmed = true;
    }
    for (const l of r.lost) {
      const e = entries.get(l.battleId);
      if (e && e.lostKeys) e.lostKeys.add(l.memberKey);
    }
    bump("lossImported", r.imported);
    bump("lossStale", r.stale);
    bump("lossFailed", r.failed);
  }

  function despawnAndRelease(e) {
    if (e.despawned) return;
    despawnAll(e.systemId, idsOf(e));
    budget.release(e.reservationId);
    e.despawned = true;
  }

  function countRepel(r) {
    const repel = r && r.repel;
    if (!repel || typeof repel !== "object") return;
    if (repel.applied === true) bump("repelApplied");
    else if (!QUIET_REASONS.includes(repel.reason)) bump("repelRefused");
  }

  function tryEnd(e, now, out) {
    const ph = playerHunt();
    const r = ph ? tx("huntEnd", (db) => ph.endInTx(db, { huntId: e.huntId, at: clock.now(), reason: e.endReason }))
      : { ok: false, reason: "PLAYER_HUNT_UNAVAILABLE" };
    if (r && r.ok === true) {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      if (e.endReason !== SPAWN_FAILED) bump("ended");
      countRepel(r);
      if (out && Array.isArray(out.huntsEnded)) out.huntsEnded.push(e.huntId);
      logLimited(now, `playerHunt: ${e.huntId} ended ${e.endReason} outcome=${r.outcome}`
        + ` losses=${(r.losses || []).reduce((n, g) => n + g.count, 0)}${r.duplicate ? " (duplicate)" : ""}`);
      return true;
    }
    bump("endFailed");
    if (r && PERMANENT_END.includes(r.reason)) {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      logger.log(`playerHunt: end ${e.huntId} refused - ${r.reason} (left to the restart recovery)`);
      return true;
    }
    logLimited(now, `playerHunt: end ${e.huntId} failed - ${(r && r.reason) || "no result"}`);
    return false;
  }

  const chainCooldownOn = () => Number.isSafeInteger(S.pursuitChainCooldownMs) && S.pursuitChainCooldownMs > 0;

  function noteChainEnd(characterId, now) {
    if (chainCooldownOn() && Number.isSafeInteger(characterId)) chainEnds.set(characterId, now);
  }

  function pruneChainEnds(now) {
    if (chainEnds.size === 0) return;
    for (const [characterId, at] of chainEnds) {
      if (!chainCooldownOn() || now - at >= S.pursuitChainCooldownMs) chainEnds.delete(characterId);
    }
  }

  function chainCooled(characterId, now) {
    if (!chainCooldownOn() || !chainEnds.has(characterId)) return false;
    if (now - chainEnds.get(characterId) < S.pursuitChainCooldownMs) return true;
    chainEnds.delete(characterId);
    return false;
  }

  function endHunt(e, reason, now, out) {
    if (e.chain && reason !== PURSUIT) noteChainEnd(e.characterId, now);
    despawnAndRelease(e);
    e.state = "ENDING";
    e.endReason = reason;
    tryEnd(e, now, out);
  }

  function returnTargetOf(e, reason) {
    const chained = Boolean(e.chain) && !e.claim;
    const origin = e.chain && Number.isSafeInteger(e.chain.originSystemId) ? e.chain.originSystemId : null;
    const home = e.homeSystemId !== null ? e.homeSystemId : origin;
    if (reason === RETREATED && chained) return home === null || home === e.systemId ? null : home;
    if (reason === RETREATED && (S.retreatEnabled === true || Boolean(e.claim)) && e.homeSystemId !== null
      && e.homeSystemId !== e.systemId) return e.homeSystemId;
    if ((S.returnHomeEnabled === true || chained) && !e.claim && PH.RETURN_REASONS.includes(reason)) {
      return home === null || home === e.systemId ? null : home;
    }
    return null;
  }

  function finishEnd(e, reason, now, out) {
    if (e.chain && reason !== PURSUIT) noteChainEnd(e.characterId, now);
    despawnAndRelease(e);
    e.state = "ENDING";
    e.endReason = reason;
    const target = returnTargetOf(e, reason);
    if (target === null) {
      tryEnd(e, now, out);
      return;
    }
    const ph = playerHunt();
    const r = ph && typeof ph.endWithReturnInTx === "function"
      ? tx("huntReturn", (db) => ph.endWithReturnInTx(db, { huntId: e.huntId, at: clock.now(), reason,
        targetSystemId: target, constraints: { maxJumps: S.returnMaxJumps } }))
      : { ok: false, reason: "PURSUIT_UNAVAILABLE" };
    if (r && r.ok === true) {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      bump("ended");
      bump("returnStarted");
      if (e.chain) bump("returnAfterPursuit");
      countRepel(r);
      if (out && Array.isArray(out.huntsEnded)) out.huntsEnded.push(e.huntId);
      logLimited(now, `playerHunt: ${e.huntId} ended ${reason} return -> ${target} arriveAt=${r.arriveAt}`
        + ` jumps=${r.jumps} losses=${(r.losses || []).reduce((n, g) => n + g.count, 0)}`);
      return;
    }
    if (r && r.reason === "ALREADY_ENDED") {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      logger.log(`playerHunt: return ${e.huntId} refused - ALREADY_ENDED (the hunt row is ended)`);
      return;
    }
    bump("returnRefused");
    logLimited(now, `playerHunt: return ${e.huntId} refused - ${(r && r.reason) || "no result"} (plain end)`);
    tryEnd(e, now, out);
  }

  function stepPending(now, out) {
    if (entries.size === 0 && lossTracker.sizes().pending === 0) return;
    stepLosses(now, playerHunt());
    for (const e of [...entries.values()]) {
      if (e.state === "SPAWNING") {
        bump("spawnFailed");
        endHunt(e, SPAWN_FAILED, now, out);
      } else if (e.state === "ENDING") tryEnd(e, now, out);
    }
  }

  function playersOf(systemId, seam) {
    if (pass.players.has(systemId)) return pass.players.get(systemId);
    let r;
    try {
      r = seam.readPlayerShips(systemId);
    } catch (err) {
      r = { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
    pass.players.set(systemId, r);
    return r;
  }

  function quarryPosOf(systemId, characterId, seam) {
    if (!seam || typeof seam.readPlayerShips !== "function") return null;
    const r = playersOf(systemId, seam);
    if (!r || r.ok !== true || !Array.isArray(r.ships)) return null;
    const ship = r.ships.find((p) => p && p.characterId === characterId);
    return ship && ship.position ? ship.position : null;
  }

  function hostilesOf(e, own, players, npc) {
    const gridSq = S.gridRadiusMeters * S.gridRadiusMeters;
    const lead = own[0];
    const out = [];
    for (const p of players) {
      if (p.inWarp || p.cloaked || p.capsule) continue;
      if (e.aggressors.has(p.entityId)) {
        if (own.some((s) => !s.inWarp && distanceSq(s.position, p.position) <= gridSq)) out.push(p.entityId);
        continue;
      }
      if (!lead || lead.inWarp || distanceSq(lead.position, p.position) > gridSq) continue;
      if (targetByStanding(p.characterId, e.factionId).target) out.push(p.entityId);
    }
    if (npc) {
      for (const [id, a] of npc) {
        if (a.inWarp === true || !a.position || out.includes(id)) continue;
        if (own.some((s) => !s.inWarp && distanceSq(s.position, a.position) <= gridSq)) out.push(id);
      }
    }
    return out.sort((a, b) => a - b);
  }

  function lneShipsOfPass() {
    if (pass.lneShips !== null) return pass.lneShips;
    const set = new Set();
    const owned = safeCall(getOwnedShipIds);
    if (owned && typeof owned[Symbol.iterator] === "function") for (const id of owned) set.add(id);
    for (const other of entries.values()) for (const id of idsOf(other)) set.add(id);
    pass.lneShips = set;
    return set;
  }

  function isNpcAggressorOf(e, a) {
    if (S.npcAggressorsEnabled !== true || a.aggressorKind !== "npc") return false;
    const factionId = a.aggressorFactionId;
    if (!Number.isSafeInteger(factionId) || factionId <= 0 || factionId === e.factionId) return false;
    return !lneShipsOfPass().has(a.aggressorId);
  }

  const LNE_SOURCES = Object.freeze(["hunt", "patrol"]);

  function isEnemy(f, g) {
    if (f === g || isFactionEnemy === null) return false;
    return safeCall(() => isFactionEnemy(f, g)) === true;
  }

  function lneFactionOfPass() {
    if (pass.lneFaction !== null) return pass.lneFaction;
    const map = new Map();
    pass.lneFaction = map;
    const groups = safeCall(getLneGroups);
    if (!Array.isArray(groups)) return map;
    for (const g of groups) {
      if (!g || !LNE_SOURCES.includes(g.source) || !Number.isSafeInteger(g.factionId)
        || !Array.isArray(g.entityIds)) continue;
      for (const id of g.entityIds) {
        if (Number.isSafeInteger(id) && id > 0 && !map.has(id)) map.set(id, g.factionId);
      }
    }
    return map;
  }

  function isLneEnemyAggressorOf(e, a) {
    if (!lneOn || a.aggressorKind !== "npc") return false;
    const lneFaction = lneFactionOfPass();
    return lneFaction.has(a.aggressorId) && isEnemy(e.factionId, lneFaction.get(a.aggressorId));
  }

  function armFor(e, own, hostiles, lneIds, seam, now) {
    const targets = hostiles.filter((id) => lneIds.has(id));
    if (targets.length === 0) return hostiles;
    const need = [...new Set([...own.map((s) => s.entityId), ...targets])].filter((id) => !armedIds.has(id));
    if (need.length === 0) return hostiles;
    const without = (drop) => hostiles.filter((id) => !drop.has(id));
    if (pass.arms >= lneArmMax) {
      bump("lneArmDeferred", targets.length);
      return without(new Set(targets));
    }
    pass.arms += 1;
    let r;
    try {
      r = typeof seam.armNpcCombat === "function" ? seam.armNpcCombat(e.systemId, need)
        : { ok: false, reason: "SEAM_UNAVAILABLE" };
    } catch (err) {
      r = { ok: false, reason: "ARM_THREW", detail: messageOf(err) };
    }
    if (!r || r.ok !== true) {
      bump("lneArmFailed", targets.length);
      logLimited(now, `playerHunt: ${e.huntId} arm refused - ${(r && (r.detail || r.reason)) || "no result"}`);
      return without(new Set(targets));
    }
    const failed = new Set(Array.isArray(r.failed) ? r.failed : []);
    for (const id of need) if (!failed.has(id)) armedIds.add(id);
    bump("lneArmed", Number.isSafeInteger(r.armed) ? r.armed : 0);
    const dropped = targets.filter((id) => failed.has(id));
    if (dropped.length === 0) return hostiles;
    bump("lneArmFailed", dropped.length);
    logLimited(now, `playerHunt: ${e.huntId} arm failed [${dropped.join(",")}] - ${r.detail || "failed"}`);
    return without(new Set(dropped));
  }

  function pruneArmed() {
    if (armedIds.size === 0) return;
    const keep = new Set(pass.lneFaction === null ? [] : pass.lneFaction.keys());
    for (const e of entries.values()) if (!e.despawned) for (const id of idsOf(e)) keep.add(id);
    for (const id of [...armedIds]) if (!keep.has(id)) armedIds.delete(id);
  }

  function factsOf(e, now, seam, presence) {
    const players = playersOf(e.systemId, seam);
    if (!players || players.ok !== true) {
      if (players && players.reason === "SCENE_NOT_LOADED") {
        return { now, sceneLoaded: false, quarry: { state: "absent", ship: null }, ownAlive: [], hostilesOnGrid: [] };
      }
      bump("readFailed");
      return null;
    }
    const own = seam.readShips(e.systemId, idsOf(e));
    if (!own || own.ok !== true) {
      bump("readFailed");
      return null;
    }
    const ownAlive = own.ships;
    dropLostOrders(e, ownAlive, now);
    e.aggressorOf.clear();
    const npc = new Map();
    const lneIds = new Set();
    if (ownAlive.length > 0) {
      const ag = seam.readAggressors(e.systemId, ownAlive.map((s) => s.entityId));
      if (ag && ag.ok === true) {
        const playerIds = new Set(players.ships.map((p) => p.entityId));
        for (const a of ag.aggressors) {
          if (playerIds.has(a.aggressorId)) {
            e.aggressors.add(a.aggressorId);
            e.aggressorOf.set(a.entityId, a.aggressorId);
          } else if (isLneEnemyAggressorOf(e, a)) {
            npc.set(a.aggressorId, { position: a.aggressorPosition || null, inWarp: a.aggressorInWarp === true });
            lneIds.add(a.aggressorId);
            e.aggressorOf.set(a.entityId, a.aggressorId);
          } else if (isNpcAggressorOf(e, a)) {
            npc.set(a.aggressorId, { position: a.aggressorPosition || null, inWarp: a.aggressorInWarp === true });
            e.aggressorOf.set(a.entityId, a.aggressorId);
          }
        }
      }
    }
    const quarryShip = players.ships.find((p) => p.characterId === e.characterId) || null;
    const facts = { now, sceneLoaded: true, quarry: quarryShip ? { state: "space", ship: quarryShip }
      : { state: "absent", ship: null }, ownAlive,
    hostilesOnGrid: ownAlive.length > 0 ? hostilesOf(e, ownAlive, players.ships, npc) : [] };
    if (lneIds.size > 0) {
      facts.hostilesOnGrid = armFor(e, ownAlive, facts.hostilesOnGrid, lneIds, seam, now);
      const kept = new Set(facts.hostilesOnGrid);
      for (const id of lneIds) if (!kept.has(id)) npc.delete(id);
    }
    e.npcNow = npc.size === 0 ? null : new Set(facts.hostilesOnGrid.filter((id) => npc.has(id)));
    if (e.npcNow) for (const id of e.npcNow) {
      const lne = lneIds.has(id);
      const seen = lne ? e.lneSeen : e.npcSeen;
      if (seen.has(id)) continue;
      seen.add(id);
      bump(lne ? "lneRetaliated" : "npcTargeted");
    }
    facts.warmScan = Boolean(e.chain) && S.pursuitWarmScan === true && (e.scanCycle || 0) === 0;
    facts.members = e.spawned.length;
    const aliveIds = new Set(ownAlive.map((s) => s.entityId));
    for (const id of aliveIds) e.seenAlive.add(id);
    facts.lost = e.spawned.filter((s) => e.lostKeys.has(s.memberKey)
      || (e.seenAlive.has(s.entityId) && !aliveIds.has(s.entityId))).length;
    if (quarryShip && quarryShip.position) e.lastQuarryPos = { ...quarryShip.position };
    const exiting = e.phase === PHASES.EXITING;
    if (quarryShip === null && ownAlive.length > 0 && S.pursuitEnabled === true && !exiting && !e.claim
      && e.oversize !== true) {
      facts.pursuitTarget = pursuitTargetOf(e, presence, now);
    }
    if (quarryShip === null && ownAlive.length > 0 && S.dockCampEnabled === true && !exiting) {
      facts.quarryDocked = stateInSystem(presence, e.systemId, e.characterId) === "docked";
      facts.campPoint = null;
      if (facts.quarryDocked && e.phase !== PHASES.CAMP) {
        const station = pickCampStation(exitObjectsOf(e, seam), e.lastQuarryPos, S.gridRadiusMeters);
        if (station) {
          facts.campPoint = station.position;
          e.campStation = station.itemId;
        }
      }
    }
    facts.watched = S.exitEnabled === true && ownAlive.length > 0
      && watchedBy(ownAlive, players.ships, S.gridRadiusMeters);
    facts.exitPoint = null;
    e.exitVia = null;
    if (facts.watched && !exiting) {
      const pick = pickExitObject(exitObjectsOf(e, seam), {
        preferToSystemId: Number.isSafeInteger(facts.pursuitTarget) ? facts.pursuitTarget : homeNextOf(e),
        awayFrom: e.lastQuarryPos || ownAlive[0].position || null });
      if (pick) {
        facts.exitPoint = pick.position;
        e.exitVia = `${pick.kind}:${pick.itemId}`;
        const lead = ownAlive[0];
        facts.exitOnGrid = Boolean(lead && lead.inWarp !== true && lead.position
          && distanceSq(lead.position, pick.position) <= S.gridRadiusMeters * S.gridRadiusMeters);
      }
    }
    return facts;
  }

  function exitObjectsOf(e, seam) {
    if (e.exitObjects !== null && e.exitObjects !== undefined) return e.exitObjects;
    let r;
    try {
      r = seam.listSystemObjects(e.systemId, PH.EXIT_OBJECT_KINDS);
    } catch (_err) {
      r = null;
    }
    e.exitObjects = r && r.ok === true && Array.isArray(r.objects) ? r.objects : [];
    return e.exitObjects;
  }

  function homeNextOf(e) {
    if (e.homeNext !== undefined) return e.homeNext;
    e.homeNext = null;
    if (e.homeSystemId === null || e.homeSystemId === undefined || e.homeSystemId === e.systemId) return null;
    const graph = graphOf();
    const route = graph ? safeCall(() => graph.findRoute(e.systemId, e.homeSystemId,
      { maxJumps: S.returnMaxJumps })) : null;
    if (route && route.ok === true && Array.isArray(route.route) && route.route.length > 1
      && Number.isSafeInteger(route.route[1])) e.homeNext = route.route[1];
    return e.homeNext;
  }

  function graphOf() {
    const g = safeCall(getGraph);
    const r = g && typeof g.getGraph === "function" ? safeCall(() => g.getGraph()) : null;
    return r && r.ok === true && r.graph && typeof r.graph.findRoute === "function" ? r.graph : null;
  }

  function routeOf(from, to) {
    const key = `${from}:${to}`;
    if (pass.routes.has(key)) return pass.routes.get(key);
    const graph = graphOf();
    const route = graph ? safeCall(() => graph.findRoute(from, to, constraintsOf(S))) : null;
    pass.routes.set(key, route);
    return route;
  }

  function pursuitDecision(fromSystemId, located, contact, hops, activePursuits, chainCooldown) {
    const input = { fromSystemId, located, contact, hops, activePursuits, route: null,
      chainCooldown: chainCooldown === true };
    const first = decidePursuit(input, S);
    if (first.pursue || first.reason !== "GRAPH_NOT_READY") return first;
    return decidePursuit({ ...input, route: routeOf(fromSystemId, located.systemId) }, S);
  }

  function pursuitTargetOf(e, presence, now) {
    const located = locateCharacter(presence, e.characterId);
    const cooled = !e.chain && chainCooled(e.characterId, now);
    const d = pursuitDecision(e.systemId, located, e.contact === true, e.chain ? e.chain.hops : 0, pursuits.size,
      cooled);
    return d.pursue ? d.targetSystemId : null;
  }

  function pursueHunt(e, targetSystemId, now, out) {
    despawnAndRelease(e);
    e.state = "ENDING";
    e.endReason = TARGET_GONE;
    const ph = playerHunt();
    const r = ph && typeof ph.pursueInTx === "function"
      ? tx("huntPursue", (db) => ph.pursueInTx(db, { huntId: e.huntId, at: clock.now(), targetSystemId,
        constraints: constraintsOf(S) }))
      : { ok: false, reason: "PURSUIT_UNAVAILABLE" };
    if (r && r.ok === true) {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      bump("ended");
      bump("pursuitStarted");
      countRepel(r);
      if (out && Array.isArray(out.huntsEnded)) out.huntsEnded.push(e.huntId);
      const hops = (e.chain ? e.chain.hops : 0) + 1;
      pursuits.set(r.fleetId, { kind: "pursuit", chainId: e.chain ? e.chain.chainId : e.huntId, fleetId: r.fleetId,
        factionId: e.factionId, characterId: e.characterId, quarryName: e.quarryName, fromSystemId: e.systemId,
        targetSystemId, operationId: r.operationId, arriveAt: r.arriveAt, hops, startedAt: now,
        originSystemId: e.chain && Number.isSafeInteger(e.chain.originSystemId) ? e.chain.originSystemId
          : e.systemId });
      logLimited(now, `playerHunt: ${e.huntId} pursuit -> ${targetSystemId} jumps=${r.jumps} arriveAt=${r.arriveAt}`
        + ` hop=${hops} losses=${(r.losses || []).reduce((n, g) => n + g.count, 0)}`);
      return;
    }
    if (r && r.reason === "ALREADY_ENDED") {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      logger.log(`playerHunt: pursuit ${e.huntId} refused - ALREADY_ENDED (the hunt row is ended)`);
      return;
    }
    bump("pursuitRefused");
    logLimited(now, `playerHunt: pursuit ${e.huntId} refused - ${(r && r.reason) || "no result"} (TARGET_GONE)`);
    finishEnd(e, TARGET_GONE, now, out);
  }

  function dropPursuit(p, counter, now, why) {
    pursuits.delete(p.fleetId);
    pendingHops.delete(p.fleetId);
    noteChainEnd(p.characterId, now);
    bump(counter);
    logLimited(now, `playerHunt: pursuit ${p.chainId} fleet ${p.fleetId} ${counter} - ${why}`);
  }

  function giveUp(p, fleet, ph, now, why) {
    if (now - p.arriveAt < S.pursuitArrivalWaitMs) return false;
    returnAfterPursuit(p, fleet, ph, now);
    dropPursuit(p, "pursuitGaveUp", now, why);
    return true;
  }

  function returnAfterPursuit(p, fleet, ph, now) {
    const home = Number.isSafeInteger(fleet.homeSystemId) && fleet.homeSystemId > 0 ? fleet.homeSystemId
      : Number.isSafeInteger(p.originSystemId) ? p.originSystemId : null;
    if (home === null || home === fleet.currentSystemId) return;
    const r = ph && typeof ph.returnHomeInTx === "function"
      ? tx("huntReturnHome", (db) => ph.returnHomeInTx(db, { chainId: p.chainId, fleetId: p.fleetId,
        expectedVersion: fleet.version, fromSystemId: fleet.currentSystemId, targetSystemId: home,
        at: clock.now(), constraints: { maxJumps: S.returnMaxJumps } }))
      : { ok: false, reason: "PURSUIT_UNAVAILABLE" };
    if (r && r.ok === true) {
      bump("returnStarted");
      bump("returnAfterPursuit");
      logLimited(now, `playerHunt: pursuit ${p.chainId} fleet ${p.fleetId} return -> ${home}`
        + ` arriveAt=${r.arriveAt} jumps=${r.jumps}`);
    } else {
      bump("returnRefused");
      logLimited(now, `playerHunt: pursuit ${p.chainId} fleet ${p.fleetId} return refused - `
        + `${(r && r.reason) || "no result"}`);
    }
  }

  function waitOver(p, now, counter, why) {
    if (now - p.arriveAt < S.pursuitArrivalWaitMs) return false;
    dropPursuit(p, counter, now, why);
    return true;
  }

  function rematerialize(p, fleet, ph, seam, now, out, quarryName) {
    const sys = p.targetSystemId;
    if (p.kind === "approach" && Number.isSafeInteger(p.warnedAt) && now - p.warnedAt < S.warningLeadMs) {
      return { started: false, aborted: false, reason: WARNING_LEAD };
    }
    if (!seam) return { started: false, aborted: false, reason: "NO_SEAM" };
    if (npcSpawn.isSceneLoaded(sys) !== true) return { started: false, aborted: false, reason: "SCENE_NOT_LOADED" };
    if (!admits(WORK_CLASS_NEW)) return { started: false, aborted: false, reason: "GOVERNOR" };
    if (entries.size >= S.maxActiveHunts || huntsInSystem(sys) >= S.maxHuntsPerSystem) {
      return { started: false, aborted: false, reason: "HUNT_LIMIT" };
    }
    const opts = { roles, maxShips: S.maxShipsPerHunt, oversizeOk: false, excludedFactions: excluded,
      factionKindOf: kindOf };
    if (pickCandidate([fleet], opts) === null) return { started: false, aborted: false, reason: "NOT_A_CANDIDATE" };
    const t = targetByStanding(p.characterId, fleet.factionId);
    if (!t.target) return { started: false, aborted: false, reason: "STANDING" };
    const before = counters.started;
    const aborted = startHunt(ph, seam, fleet, p.characterId, t.standing, sys, now, out, quarryName,
      { pursuit: p, quarryPos: quarryPosOf(sys, p.characterId, seam) });
    return { started: counters.started > before, aborted, reason: "START_REFUSED" };
  }

  function nextLeg(p, fleet, ph, targetSystemId, now) {
    const hop = p.hops + 1;
    pendingHops.set(p.fleetId, hop);
    const r = tx("huntPursueNext", (db) => ph.pursueNextInTx(db, { chainId: p.chainId, hop, fleetId: p.fleetId,
      expectedVersion: fleet.version, fromSystemId: p.targetSystemId, targetSystemId, at: clock.now(),
      constraints: constraintsOf(S) }));
    if (!r || r.ok !== true) {
      pendingHops.delete(p.fleetId);
      bump("pursuitRefused");
      logLimited(now, `playerHunt: pursuit ${p.chainId} hop ${hop} refused - ${(r && r.reason) || "no result"}`);
      return false;
    }
    pendingHops.delete(p.fleetId);
    p.fromSystemId = p.targetSystemId;
    p.targetSystemId = targetSystemId;
    p.operationId = r.operationId;
    p.arriveAt = r.arriveAt;
    p.hops = hop;
    bump("pursuitHops");
    logLimited(now, `playerHunt: pursuit ${p.chainId} hop ${hop} -> ${targetSystemId} jumps=${r.jumps}`
      + ` arriveAt=${r.arriveAt}`);
    return true;
  }

  function adoptLeg(p, fleet) {
    const hop = pendingHops.get(p.fleetId);
    if (hop !== p.hops + 1 || !PURSUIT_EN_ROUTE.includes(fleet.state) || !fleet.route
      || !Number.isSafeInteger(fleet.route.arriveAt) || !Number.isSafeInteger(fleet.targetSystemId)) return false;
    pendingHops.delete(p.fleetId);
    p.fromSystemId = p.targetSystemId;
    p.targetSystemId = fleet.targetSystemId;
    p.operationId = fleet.operationId;
    p.arriveAt = fleet.route.arriveAt;
    p.hops = hop;
    return true;
  }

  function stepPursuits(now, presence, out) {
    pruneChainEnds(now);
    if (pursuits.size === 0) return false;
    const ph = playerHunt();
    const on = S.pursuitEnabled === true && S.pursuitMaxActive > 0 && Boolean(ph)
      && safeCall(() => ph.isEnabled()) === true;
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    let reads = 0;
    const due = [...pursuits.values()].filter((p) => now >= p.arriveAt)
      .sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
    if (due.length === 0) return false;
    beginPass(now);
    const seam = on ? safeCall(getHuntScene) : null;
    for (const p of due) {
      if (!on) {
        dropPursuit(p, "pursuitDropped", now, "pursuit or hunts off");
        continue;
      }
      if (reads >= S.pursuitMaxActive) break;
      reads += 1;
      const got = repo && typeof repo.getFleet === "function"
        ? tx("pursuitRead", (db) => repo.getFleet(db, p.fleetId)) : { ok: false, reason: "FLEETS_UNAVAILABLE" };
      if (!got || got.ok !== true) {
        bump("readFailed");
        waitOver(p, now, "pursuitLost", `fleet read failed (${(got && got.reason) || "no result"})`);
        continue;
      }
      const fleet = got.fleet;
      if (!fleet || fleet.state === "DESTROYED" || fleet.state === "ENGAGED") {
        dropPursuit(p, "pursuitLost", now, fleet ? fleet.state : "fleet gone");
        continue;
      }
      if (fleet.operationId !== null && fleet.operationId !== undefined && fleet.operationId !== p.operationId) {
        if (!adoptLeg(p, fleet)) dropPursuit(p, "pursuitLost", now, `operation ${fleet.operationId}`);
        continue;
      }
      if (PURSUIT_EN_ROUTE.includes(fleet.state)) {
        waitOver(p, now, "pursuitLost", `still ${fleet.state}`);
        continue;
      }
      if (fleet.state !== "IDLE" || fleet.currentSystemId !== p.targetSystemId) {
        if (fleet.state === "IDLE") returnAfterPursuit(p, fleet, ph, now);
        dropPursuit(p, "pursuitLost", now, `${fleet.state} in ${fleet.currentSystemId}`);
        continue;
      }
      const located = locateCharacter(presence, p.characterId);
      if (located && located.systemId === p.targetSystemId && located.state === "space") {
        const sp = safeCall(() => presence.getSystemPresence(p.targetSystemId));
        const who = sp && Array.isArray(sp.characters) ? sp.characters.find((c) => c
          && c.characterId === p.characterId) : null;
        const r = rematerialize(p, fleet, ph, seam, now, out, who && who.name ? who.name : p.quarryName);
        if (r.started) {
          pursuits.delete(p.fleetId);
          pendingHops.delete(p.fleetId);
          bump("pursuitRematerialized");
          logLimited(now, `playerHunt: pursuit ${p.chainId} fleet ${p.fleetId} rematerialized in ${p.targetSystemId}`
            + ` hop=${p.hops}`);
        } else if (!r.aborted && r.reason !== WARNING_LEAD) {
          giveUp(p, fleet, ph, now, `no new hunt (${r.reason})`);
        }
        if (r.aborted) return true;
        continue;
      }
      const d = pursuitDecision(p.targetSystemId, located, true, p.hops, pursuits.size - 1);
      if (d.pursue && nextLeg(p, fleet, ph, d.targetSystemId, now)) continue;
      giveUp(p, fleet, ph, now, d.pursue ? "next leg refused" : d.reason);
    }
    return false;
  }

  function noteOrder(r, now, what, e) {
    if (r && r.ok === true && (!Array.isArray(r.failed) || r.failed.length === 0)) return;
    bump("orderFailed");
    logLimited(now, `playerHunt: ${what} ${e.huntId} - ${(r && (r.detail || r.reason)) || "no result"}`);
  }

  function dropLostOrders(e, ownAlive, now) {
    noteBeyondLeash(e, ownAlive, now, "playerHunt");
    const lost = [];
    for (const s of ownAlive) {
      const want = e.targetOf.get(s.entityId);
      const v = s.vendorOrder;
      if (want === undefined || !v || typeof v !== "object") continue;
      const locked = !attackLockOn || (v.keepLock === true && v.allowWeapons === true);
      if (v.attackTargetId === want && v.weapons !== false && locked) continue;
      e.targetOf.delete(s.entityId);
      lost.push(`${s.entityId}:want=${want}:vendor=${v.attackTargetId}:weapons=${v.weapons !== false}`
        + (attackLockOn ? `:lock=${locked}` : ""));
    }
    if (lost.length === 0) return;
    bump("orderLost", lost.length);
    logLimited(now, `playerHunt: ${e.huntId} order lost (${lost.length}) [${lost.join(",")}] phase=${e.phase}`
      + " - reorder");
  }

  function noteBeyondLeash(e, ownAlive, now, label) {
    if (e.leashLogged === true) return;
    const beyond = [];
    for (const s of ownAlive) {
      const v = s.vendorOrder;
      if (v && typeof v === "object" && v.beyondLeash === true) {
        beyond.push(`${s.entityId}:home=${v.homeDistanceMeters}:leash=${v.leashMeters}`);
      }
    }
    if (beyond.length === 0) return;
    e.leashLogged = true;
    logLimited(now, `${label}: ${e.huntId} beyondLeash=true (${beyond.length}) [${beyond.join(",")}] phase=${e.phase}`);
  }

  function desiredTarget(e, ship, i, targets, current) {
    const aggressor = e.aggressorOf.get(ship);
    if (aggressor !== undefined && current.has(aggressor)) return aggressor;
    const now = e.targetOf.get(ship);
    return current.has(now) ? now : targets[i % targets.length];
  }

  function orderTargets(e, alive, targets, seam, now, limit) {
    const current = new Set(targets);
    let used = 0;
    for (let i = 0; i < alive.length; i += 1) {
      const ship = alive[i];
      const target = desiredTarget(e, ship, i, targets, current);
      if (e.targetOf.get(ship) === target) continue;
      if (used >= limit) break;
      used += 1;
      const r = e.capitalIds.has(ship)
        ? seam.attackTargets(e.systemId, [ship], [target], { capitalIds: new Set([ship]) })
        : seam.attackTargets(e.systemId, [ship], [target]);
      noteOrder(r, now, "attack", e);
      if (!r || r.ok !== true || r.failed.includes(ship)) continue;
      e.targetOf.set(ship, target);
      if (e.aggressorOf.get(ship) === target) bump(e.npcNow && e.npcNow.has(target) ? "npcRetaliated" : "retaliated");
    }
    return used;
  }

  function applyDecision(e, d, facts, seam, now, retargetsLeft) {
    const alive = facts.ownAlive.map((s) => s.entityId);
    let attacked = false;
    for (const a of d.actions) {
      if (a.type === "search") {
        noteOrder(seam.setSearch(e.systemId, alive), now, "search", e);
        e.targetOf.clear();
      } else if (a.type === "warp") {
        noteOrder(seam.warpShips(e.systemId, alive, a.point, { spreadMeters: S.landingSpreadMeters }), now, "warp", e);
        if (Number.isSafeInteger(a.objectIndex) || a.retarget === true) bump("objectsVisited");
        if (a.retarget === true) bump("sweepRetargets");
      } else if (a.type === "attack") {
        attacked = true;
        bump("engaged");
        e.targetOf.clear();
        orderTargets(e, alive, a.targets, seam, now, alive.length);
        logLimited(now, `playerHunt: ${e.huntId} attack ships=${alive.length} ordered=`
          + `${alive.filter((id) => e.targetOf.has(id)).length} targets=[${a.targets.join(",")}]`);
      }
    }
    if (d.phase !== PHASES.ENGAGED || attacked || facts.hostilesOnGrid.length === 0) return 0;
    const used = orderTargets(e, alive, facts.hostilesOnGrid, seam, now, retargetsLeft);
    bump("retargeted", used);
    return used;
  }

  function noteNotVisible(e, facts, seam, now) {
    bump("spawnNotVisible");
    const spawned = idsOf(e);
    const read = facts.ownAlive.map((s) => s.entityId);
    let explain = "n/a";
    try {
      const x = typeof seam.explainShips === "function" ? seam.explainShips(e.systemId, spawned) : null;
      if (x && x.ok === true && Array.isArray(x.ships)) {
        explain = x.ships.map((s) => `${s.entityId}:scene=${s.inScene ? 1 : 0},ctl=${s.controller ? 1 : 0}`)
          .join(";");
      }
    } catch (_err) {
      explain = "n/a";
    }
    logLimited(now, `playerHunt: ${e.huntId} spawn not visible in ${e.systemId} spawned=[${spawned.join(",")}]`
      + ` read=[${read.join(",")}] explain=${explain}`);
  }

  function rollOfficer(e, now) {
    const o = safeCall(getOfficerSpawns);
    if (!o || typeof o.tryHunt !== "function") return;
    let r;
    try {
      r = o.tryHunt({ huntId: e.huntId, systemId: e.systemId, characterId: e.characterId, factionId: e.factionId });
    } catch (err) {
      bump("officerRefused");
      logLimited(now, `playerHunt: ${e.huntId} officer roll threw - ${messageOf(err)}`);
      return;
    }
    if (r && r.ok === true) bump("officerSpawned");
    else if (r && !OFFICER_QUIET.includes(r.reason)) bump("officerRefused");
  }

  function stepHunts(now, presence, out, retargetsLeftArg) {
    if (entries.size === 0) return 0;
    beginPass(now);
    let retargetsLeft = Number.isSafeInteger(retargetsLeftArg) ? Math.max(0, retargetsLeftArg) : retargetLimit;
    let used = 0;
    const ph = playerHunt();
    const enabled = Boolean(ph && safeCall(() => ph.isEnabled()) === true);
    const seam = safeCall(getHuntScene);
    const live = [...entries.values()].filter((e) => e.state === "LIVE")
      .sort((a, b) => (a.huntId < b.huntId ? -1 : a.huntId > b.huntId ? 1 : 0));
    for (const e of live) {
      if (!enabled) {
        endHunt(e, "DISABLED", now, out);
        continue;
      }
      if (!seam) {
        endHunt(e, "SCENE_GONE", now, out);
        continue;
      }
      let facts;
      let d;
      try {
        facts = factsOf(e, now, seam, presence);
        if (facts === null) continue;
        if (facts.ownAlive.length > 0) e.spawnConfirmed = true;
        d = decideHuntStep(e, facts, e.claim ? claimParams : S);
      } catch (err) {
        bump("readFailed");
        logLimited(now, `playerHunt: step ${e.huntId} threw - ${messageOf(err)}`);
        continue;
      }
      e.alive = facts.ownAlive.length;
      if (d.phase === PHASES.EXITING && e.phase !== PHASES.EXITING) {
        bump("exitStarted");
        logLimited(now, `playerHunt: ${e.huntId} exiting ${d.exitReason} via ${e.exitVia || "?"}`);
      }
      if (d.phase === PHASES.CAMP && e.phase !== PHASES.CAMP) {
        bump("campStarted");
        logLimited(now, `playerHunt: ${e.huntId} camping station ${e.campStation === null ? "?" : e.campStation}`);
      } else if (e.phase === PHASES.CAMP && d.phase === PHASES.ENGAGED) bump("campEngaged");
      if (d.end && d.end.reason === TARGET_DOCKED) bump("campEnded");
      e.exitReason = d.exitReason === undefined ? null : d.exitReason;
      e.exitPursuitTarget = d.exitPursuitTarget === undefined ? null : d.exitPursuitTarget;
      e.phase = d.phase;
      e.phaseSince = d.phaseSince;
      e.objectIndex = d.objectIndex;
      e.visited = d.visited;
      e.quarryAbsentSince = d.quarryAbsentSince;
      e.noTargetSince = d.noTargetSince;
      e.scanCycle = d.scanCycle;
      e.warpSeen = d.warpSeen === true;
      if (d.warpEnd === "grace") bump("warpNoStart");
      if (d.scan) {
        bump("scanCycles");
        if (d.scan.found) bump("scanHits");
        if (d.scan.found && facts.warmScan === true) bump("warmScanHits");
      }
      const quarryId = facts.quarry && facts.quarry.ship ? facts.quarry.ship.entityId : null;
      if ((d.phase === PHASES.ENGAGED && quarryId !== null && facts.hostilesOnGrid.includes(quarryId))
        || (d.scan && d.scan.found)) e.contact = true;
      if (e.officerRolled !== true && d.phase === PHASES.ENGAGED && quarryId !== null
        && facts.hostilesOnGrid.includes(quarryId)) {
        e.officerRolled = true;
        rollOfficer(e, now);
      }
      if (d.end && d.exitWarp === "landed") bump("exitLanded");
      else if (d.end && (d.exitWarp === "grace" || d.exitWarp === "timeout")) bump("exitForced");
      if (d.end && d.end.reason === PURSUIT) {
        if (pursuits.size < S.pursuitMaxActive) pursueHunt(e, d.pursuitTarget, now, out);
        else {
          bump("pursuitRefused");
          finishEnd(e, TARGET_GONE, now, out);
        }
        continue;
      }
      if (d.end && d.end.reason === RETREATED) {
        bump("retreated");
        finishEnd(e, RETREATED, now, out);
        continue;
      }
      if (d.end) {
        if (d.end.reason === SPAWN_NOT_VISIBLE) noteNotVisible(e, facts, seam, now);
        if (PH.RETURN_REASONS.includes(d.end.reason)) finishEnd(e, d.end.reason, now, out);
        else endHunt(e, d.end.reason, now, out);
        continue;
      }
      const n = applyDecision(e, d, facts, seam, now, retargetsLeft);
      used += n;
      retargetsLeft -= n;
    }
    if (lneOn) pruneArmed();
    return used;
  }

  function candidateSystems(presence) {
    const systems = [];
    for (const id of presence.observedSystems()) {
      const sp = safeCall(() => presence.getSystemPresence(id));
      if (!sp || !(sp.space > 0)) continue;
      if (npcSpawn.isSceneLoaded(id) !== true) continue;
      systems.push({ systemId: id, presence: sp });
    }
    systems.sort((x, y) => x.systemId - y.systemId);
    const at = systems.findIndex((s) => s.systemId > cursor);
    return at <= 0 ? systems : [...systems.slice(at), ...systems.slice(0, at)];
  }

  function notice(systems, now) {
    const next = new Map();
    for (const s of systems) {
      for (const c of Array.isArray(s.presence.characters) ? s.presence.characters : []) {
        if (!c || c.state !== "space" || !Number.isSafeInteger(c.characterId)) continue;
        const key = `${s.systemId}:${c.characterId}`;
        next.set(key, firstSeen.has(key) ? firstSeen.get(key) : now);
      }
    }
    firstSeen = next;
    for (const key of [...warnings.keys()]) {
      if (firstSeen.has(key)) continue;
      warnings.delete(key);
      bump("warningGone");
    }
    for (const [characterId, until] of [...quietUntil]) if (until <= now) quietUntil.delete(characterId);
    if (approachNextAt.size > 0) {
      const present = new Set(systems.map((s) => s.systemId));
      for (const systemId of [...approachNextAt.keys()]) if (!present.has(systemId)) approachNextAt.delete(systemId);
    }
  }

  function huntsInSystem(systemId) {
    let n = 0;
    for (const e of entries.values()) if (e.systemId === systemId) n += 1;
    return n;
  }

  function approachWarned(systemId, characterId) {
    for (const p of pursuits.values()) {
      if (p.kind === "approach" && Number.isSafeInteger(p.warnedAt) && p.targetSystemId === systemId
        && p.characterId === characterId) return true;
    }
    return false;
  }

  function warningsIn(systemId) {
    let n = 0;
    for (const w of warnings.values()) if (w.systemId === systemId) n += 1;
    return n;
  }

  function sendWarning(systemId, characterId, factionId, now) {
    if (quietUntil.has(characterId) && quietUntil.get(characterId) > now) {
      bump("warningSuppressed");
      return "suppressed";
    }
    quietUntil.set(characterId, now + S.warningRepeatMs);
    const bucket = S.warningRepeatMs > 0 ? Math.floor(now / S.warningRepeatMs) : now;
    let r;
    try {
      const notices = safeCall(getNotices);
      r = notices && typeof notices.sendUrgent === "function"
        ? notices.sendUrgent({ eventKey: `phwarn:${characterId}:${bucket}`, characterId, kind: HUNT_WARNING, systemId,
          factionId, at: now }, now)
        : { ok: false, reason: "NOTICES_UNAVAILABLE" };
    } catch (err) {
      r = { ok: false, reason: "SEND_THREW", detail: messageOf(err) };
    }
    if (r && r.ok === true && r.sent === true) {
      bump("warningSent");
      return "sent";
    }
    if (r && r.ok === true && r.duplicate === true) return "duplicate";
    bump("warningUndelivered");
    logLimited(now, `playerHunt: warning to ${characterId} in ${systemId} undelivered - `
      + `${(r && (r.reason || r.detail)) || "no result"}`);
    return "undelivered";
  }

  function warn(systemId, characterId, factionId, fleetId, now) {
    if (pass.warned >= S.warningMaxPerPass) return false;
    pass.warned += 1;
    const delivered = sendWarning(systemId, characterId, factionId, now);
    warnings.set(`${systemId}:${characterId}`, { systemId, characterId, factionId, fleetId, warnedAt: now,
      delivered });
    logLimited(now, `playerHunt: warning ${characterId} in ${systemId} faction=${factionId} fleet=${fleetId}`
      + ` ${delivered}`);
    return true;
  }

  function stepDueWarnings(ph, seam, systems, now, out) {
    let attempts = 0;
    if (warnings.size === 0) return { attempts, aborted: false };
    const bySystem = new Map(systems.map((s) => [s.systemId, s]));
    const due = [...warnings.values()].filter((w) => now - w.warnedAt >= S.warningLeadMs)
      .sort((a, b) => a.systemId - b.systemId || a.characterId - b.characterId);
    for (const w of due) {
      if (attempts >= S.maxNewHuntsPerPass) break;
      const key = `${w.systemId}:${w.characterId}`;
      if (now - w.warnedAt > S.warningLeadMs + S.warningGraceMs) {
        warnings.delete(key);
        bump("warningLapsed");
        continue;
      }
      if (entries.size + warnings.size - 1 >= S.maxActiveHunts) break;
      if (huntsInSystem(w.systemId) + warningsIn(w.systemId) - 1 >= S.maxHuntsPerSystem) continue;
      const s = bySystem.get(w.systemId);
      if (!s) continue;
      const read = readCandidates(ph, w.systemId, [w.characterId], now);
      if (!read || read.ok !== true) {
        refuse(out, (read && read.reason) || "READ_FAILED", "readFailed");
        continue;
      }
      const ordered = [...read.claimCandidates.map((fleet) => ({ fleet, claim: read.claim })),
        ...read.candidates.map((fleet) => ({ fleet, claim: null }))].filter((c) => c.fleet.factionId === w.factionId);
      const own = ordered.findIndex((c) => c.fleet.fleetId === w.fleetId);
      if (own > 0) ordered.unshift(...ordered.splice(own, 1));
      let pick = null;
      let held = false;
      for (const c of ordered) {
        if (spawnBackoff.blocked(c.fleet.fleetId, now) !== null) {
          refuse(out, "SPAWN_BACKOFF", "refusedBackoff", c.fleet.fleetId);
          held = true;
          continue;
        }
        const last = read.lastEnded.get(`${w.characterId}:${c.fleet.factionId}`);
        if (last !== null && last !== undefined && now - last < S.cooldownMs) continue;
        const t = targetByStanding(w.characterId, c.fleet.factionId);
        if (t.target) {
          pick = { ...c, standing: t.standing };
          break;
        }
      }
      if (!pick && held) continue;
      if (!pick) {
        warnings.delete(key);
        bump("warningLapsed");
        continue;
      }
      attempts += 1;
      warnings.delete(key);
      const before = counters.started;
      const who = (Array.isArray(s.presence.characters) ? s.presence.characters : [])
        .find((c) => c && c.characterId === w.characterId);
      const aborted = startHunt(ph, seam, pick.fleet, w.characterId, pick.standing, w.systemId, now, out,
        who ? who.name : null, { quarryPos: quarryPosOf(w.systemId, w.characterId, seam), claim: pick.claim });
      if (counters.started > before) bump("warningSpawned");
      else if (!aborted) warnings.set(key, w);
      if (aborted) return { attempts, aborted: true };
    }
    return { attempts, aborted: false };
  }

  function claimOf(db, systemId) {
    if (S.claimHuntsEnabled !== true) return null;
    const occ = safeCall(getOccupation);
    if (!occ || typeof occ.claimOfInTx !== "function") return null;
    try {
      const r = occ.claimOfInTx(db, systemId);
      const c = r && r.ok === true ? r.claim : null;
      return c && Number.isSafeInteger(c.occupierFactionId) ? { occupierFactionId: c.occupierFactionId, state: c.state }
        : null;
    } catch (_err) {
      return null;
    }
  }

  function heatInTx(ph, db, characterId, factionId, now) {
    const key = `${characterId}:${factionId}`;
    if (pass.heat.has(key)) return pass.heat.get(key);
    let heat = 0;
    if (typeof ph.recentEndedInTx !== "function") {
      bump("escalationReadFailed");
    } else {
      bump("escalationHeatReads");
      let r = null;
      try {
        r = ph.recentEndedInTx(db, characterId, factionId, Math.max(0, now - S.escalationWindowMs),
          S.escalationMaxHeat * HEAT_ROWS_PER_POINT);
      } catch (err) {
        if (!db || db.inTransaction !== true) throw err;
      }
      if (r && r.ok === true) {
        heat = heatOf(r.rows, heatParams);
        bump("escalationReadFailed", Number.isSafeInteger(r.skipped) ? r.skipped : 0);
      } else {
        bump("escalationReadFailed");
      }
    }
    pass.heat.set(key, heat);
    return heat;
  }

  function maxHeatInTx(ph, db, characters, fleetList, now) {
    if (!escalationOn) return 0;
    let max = 0;
    for (const factionId of new Set(fleetList.map((f) => f.factionId))) {
      for (const characterId of characters) max = Math.max(max, heatInTx(ph, db, characterId, factionId, now));
    }
    return max;
  }

  function heatOfPair(ph, characterId, factionId, now) {
    if (!escalationOn) return 0;
    const key = `${characterId}:${factionId}`;
    if (pass.heat.has(key)) return pass.heat.get(key);
    const v = tx("huntHeat", (db) => heatInTx(ph, db, characterId, factionId, now));
    return Number.isSafeInteger(v) ? v : 0;
  }

  function readCandidates(ph, systemId, characters, now) {
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    if (!repo || typeof repo.listFleetsInSystem !== "function") return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    return tx("huntRead", (db) => {
      const claim = claimOf(db, systemId);
      const listed = repo.listFleetsInSystem(db, systemId, { states: claim ? ["IDLE", "STAGED"] : ["IDLE"],
        limit: S.fleetScanMax });
      if (!listed || listed.ok !== true) return listed;
      const opts = { roles, maxShips: S.maxShipsPerHunt, oversizeOk, excludedFactions: excluded, factionKindOf: kindOf };
      const claimCandidates = claim ? pickClaimCandidates(listed.fleets, claim, { ...opts, maxShips: S.claimMaxShips })
        : [];
      const claimOversize = claim !== null && claimCandidates.length === 0 && pickClaimCandidates(listed.fleets, claim,
        { ...opts, maxShips: Number.MAX_SAFE_INTEGER }).length > 0;
      const claimIds = new Set(claimCandidates.map((f) => f.fleetId));
      const candidates = listed.fleets.filter((f) => !claimIds.has(f.fleetId) && pickCandidate([f], opts) !== null)
        .sort(compareHuntCandidates);
      const lastEnded = new Map();
      for (const factionId of new Set([...claimCandidates, ...candidates].map((f) => f.factionId))) {
        for (const characterId of characters) {
          lastEnded.set(`${characterId}:${factionId}`, ph.lastEndedAtInTx(db, characterId, factionId));
        }
      }
      if (maxHeatInTx(ph, db, characters, candidates, now) >= 1) candidates.sort(compareHeavyCandidates);
      return { ok: true, candidates, claimCandidates, claim, claimOversize, lastEnded };
    });
  }

  function spawnAndGoLive(e, members, profiles, ph, now) {
    const first = e.objects[0];
    const anchor = { kind: first.kind, itemID: first.itemId };
    const owned = new Set();
    for (const other of entries.values()) if (other !== e) for (const id of idsOf(other)) owned.add(id);
    for (let i = 0; i < members.length; i += 1) {
      const spread = capital.isCapital(members[i].hullGroup) && capital.distanceMeters !== null
        ? capital.distanceMeters : S.landingSpreadMeters;
      const r = npcSpawn.spawnShip(e.systemId, { profileId: profiles[i], anchorDescriptor: anchor,
        spawnDistanceMeters: spread, behavior: "search", keepMaterialized: true });
      if (!r || r.ok !== true) throw new StepError((r && r.reason) || SPAWN_FAILED, r && r.detail);
      if (owned.has(r.entityId) || idsOf(e).includes(r.entityId)) {
        throw new StepError("ENTITY_REUSED", `entity ${r.entityId}`);
      }
      e.spawned.push({ memberKey: members[i].memberKey, entityId: r.entityId });
      if (capital.isCapital(members[i].hullGroup)) e.capitalIds.add(r.entityId);
      if (!(e.hullGroupOf instanceof Map)) e.hullGroupOf = new Map();
      e.hullGroupOf.set(r.entityId, members[i].hullGroup);
    }
    const ids = idsOf(e);
    const pub = npcSpawn.publish(e.systemId, ids);
    if (!pub || pub.ok !== true) throw new StepError("PUBLISH_FAILED", pub && (pub.detail || pub.reason));
    if (!(pub.published >= ids.length)) {
      throw new StepError("PUBLISH_PARTIAL", `published ${pub.published} of ${ids.length}`);
    }
    const live = tx("huntLive", (db) => ph.markLiveInTx(db, { huntId: e.huntId, expectedVersion: e.version,
      at: clock.now() }));
    if (!live || live.ok !== true) throw new StepError((live && live.reason) || "LIVE_FAILED", live && live.detail);
    e.state = "LIVE";
    if (Number.isSafeInteger(live.version)) e.version = live.version;
    e.liveSince = now;
    e.phase = e.mode === MODE_SCAN ? PHASES.SCAN : PHASES.SWEEP_DWELL;
    e.phaseSince = now;
    e.warpSeen = false;
    e.alive = e.spawned.length;
    lossTracker.track(e.huntId, e.spawned);
  }

  function huntCapOf(systemId, characterId, seam, fleetShips) {
    const r = playersOf(systemId, seam);
    const ship = r && r.ok === true && Array.isArray(r.ships)
      ? r.ships.find((p) => p && p.characterId === characterId) || null : null;
    const size = huntSizeFor(hullClassOf(ship, STRENGTH_TYPES, groupIndex), scaleTable,
      { defaultShips: S.scaleDefaultShips, maxShips: S.maxShipsPerHunt, fleetShips });
    if (!size.known) bump("scaleUnknownHull");
    return size.cap;
  }

  function quarryClassOf(systemId, characterId, seam) {
    const r = playersOf(systemId, seam);
    const ship = r && r.ok === true && Array.isArray(r.ships)
      ? r.ships.find((p) => p && p.characterId === characterId) || null : null;
    const cls = hullClassOf(ship, STRENGTH_TYPES, groupIndex);
    return typeof cls === "string" && Object.prototype.hasOwnProperty.call(HULL_RANK, cls) ? cls : null;
  }

  function startHunt(ph, seam, fleet, characterId, standing, systemId, now, out, quarryName, opts) {
    if (spawnBackoff.blocked(fleet.fleetId, now) !== null) {
      refuse(out, "SPAWN_BACKOFF", "refusedBackoff", fleet.fleetId);
      return false;
    }
    const huntId = PH.huntIdOf(fleet.fleetId, fleet.version);
    const all = membersOf(fleet.fleetId, fleet.composition);
    const isClaim = Boolean(opts && opts.claim);
    const heat = escalationOn && !isClaim ? heatOfPair(ph, characterId, fleet.factionId, now) : 0;
    const baseCap = S.scaleEnabled === true && !isClaim ? huntCapOf(systemId, characterId, seam, all.length) : null;
    const scaleCap = baseCap !== null && heat >= 1
      ? escalatedCap(baseCap, heat, S.escalationScalePermille, S.maxShipsPerHunt) : baseCap;
    const limit = oversizeOk ? (isClaim ? S.claimMaxShips : S.maxShipsPerHunt) : null;
    const oversizeCut = limit !== null && limit < all.length && (scaleCap === null || limit < scaleCap);
    const cap = oversizeCut ? limit : scaleCap;
    const quarryClass = matchOn && !isClaim && cap !== null && cap < all.length
      ? quarryClassOf(systemId, characterId, seam) : null;
    const members = cap !== null && cap < all.length
      ? (quarryClass !== null ? pickMatchedDetachment(all, quarryClass, cap) : pickDetachment(all, cap)) : all;
    const trimmed = members.length < all.length;
    const mode = hasScanner(compositionOf(members), scannerHullGroups) ? MODE_SCAN : MODE_SWEEP;
    const profiles = npcSpawn.resolveProfiles(members.map((m) => ({ memberKey: m.memberKey,
      factionId: fleet.factionId, hullGroup: m.hullGroup, typeId: m.typeId })), { seedPrefix: huntId });
    if (!profiles || profiles.ok !== true) {
      capital.noteRefused(profiles, `hunt ${fleet.fleetId}`);
      refuse(out, (profiles && profiles.reason) || "NO_PROFILE", "refusedProfile", fleet.fleetId);
      return false;
    }
    const listed = seam.listSystemObjects(systemId, objectKinds);
    if (!listed || listed.ok !== true || listed.objects.length === 0) {
      refuse(out, (listed && listed.ok !== true && listed.reason) || "NO_OBJECTS", "refusedObjects", fleet.fleetId);
      return false;
    }
    if (Array.isArray(listed.skipped) && listed.skipped.includes("anomaly")) bump("anomalySourceSkipped");
    if (listed.objects.every((o) => o && o.kind === "anomaly")) {
      refuse(out, "NO_ANCHOR", "refusedObjects", fleet.fleetId);
      return false;
    }
    const scene = sceneRefusalOf(npcSpawn, systemId, members.length, SCENE_SOURCE);
    if (scene !== null) {
      refuse(out, scene, "refusedBudget", fleet.fleetId);
      return false;
    }
    const reservationId = `mat:phunt:${huntId}`;
    const reserved = budget.reserve({ reservationId, ownerKind: "fleet", ownerId: fleet.fleetId, systemId,
      shipCount: capital.slotsOf(members), metadata: { systemId } });
    if (!reserved || reserved.ok !== true) {
      refuse(out, (reserved && reserved.reason) || "BUDGET", "refusedBudget", fleet.fleetId);
      return false;
    }
    const claim = opts && opts.claim ? { occupierFactionId: opts.claim.occupierFactionId, state: opts.claim.state }
      : null;
    const claimed = tx("huntClaim", (db) => {
      const c = ph.claimInTx(db, { fleetId: fleet.fleetId, expectedVersion: fleet.version, characterId, systemId,
        mode, standing, at: clock.now(), ...(claim ? { unstage: fleet.state === "STAGED" } : {}),
        ...(trimmed ? { maxMembers: members.length } : {}),
        ...(trimmed && quarryClass !== null ? { quarryClass } : {}) });
      if (!c || c.ok !== true || c.duplicate === true) return c;
      const read = ph.readInTx(db, c.huntId);
      return { ...c, seed: read && read.ok === true && read.hunt ? read.hunt.seed : 0 };
    });
    if (!claimed || claimed.ok !== true || claimed.duplicate === true) {
      budget.release(reservationId);
      refuse(out, (claimed && claimed.duplicate ? "DUPLICATE" : claimed && claimed.reason) || "CLAIM_FAILED",
        "refusedClaim", fleet.fleetId);
      return false;
    }
    const e = { huntId: claimed.huntId, fleetId: fleet.fleetId, factionId: fleet.factionId, characterId,
      quarryName: typeof quarryName === "string" && quarryName !== "" ? quarryName : null, systemId, mode,
      seed: Number.isSafeInteger(claimed.seed) ? claimed.seed : 0, state: "SPAWNING", version: claimed.version,
      reservationId, spawned: [], objects: listed.objects, objectIndex: 0, visited: 1, phase: PHASES.SWEEP_DWELL,
      phaseSince: now, liveSince: null, quarryAbsentSince: null, noTargetSince: null, scanCycle: 0, warpSeen: false,
      alive: 0, spawnConfirmed: false, contact: false, officerRolled: false, chain: null,
      targetOf: new Map(), aggressors: new Set(), aggressorOf: new Map(), despawned: false, endReason: null,
      homeSystemId: Number.isSafeInteger(fleet.homeSystemId) && fleet.homeSystemId > 0 ? fleet.homeSystemId : null,
      exitReason: null, exitPursuitTarget: null, exitObjects: null, homeNext: undefined, lastQuarryPos: null,
      exitVia: null,
      seenAlive: new Set(), lostKeys: new Set(),
      heldBack: all.length - members.length,
      oversize: limit !== null && all.length > limit,
      campStation: null,
      npcSeen: new Set(), npcNow: null,
      lneSeen: new Set(),
      capitalIds: new Set(),
      claim };
    entries.set(e.huntId, e);
    const byKey = new Map(listed.objects.map((o) => [`${o.kind}:${o.itemId}`, o]));
    e.objects = sweepOrder(listed.objects, objectKinds, claimed.seed).map((o) => byKey.get(`${o.kind}:${o.itemId}`));
    const pursuit = opts && opts.pursuit ? opts.pursuit : null;
    if (pursuit) {
      const i = arrivalGateIndex(e.objects, pursuit.fromSystemId);
      if (i > 0) e.objects = [e.objects[i], ...e.objects.slice(0, i), ...e.objects.slice(i + 1)];
      e.chain = { chainId: pursuit.chainId, hops: pursuit.hops,
        originSystemId: Number.isSafeInteger(pursuit.originSystemId) ? pursuit.originSystemId : null };
    }
    const placed = placeAnomalies(e.objects, (opts && opts.quarryPos) || null, S.maxAnomaliesPerHunt);
    if (placed.anchorless !== true) e.objects = placed.objects;
    if (e.objects.some((o) => o && o.kind === "anomaly")) bump("anomaliesInSweep");
    const inSweep = new Set(e.objects);
    e.retargetExtra = listed.objects.filter((o) => o && o.kind === "anomaly" && !inSweep.has(o));
    if (S.dscanEnabled === true && opts && opts.quarryPos) {
      const ranked = dscanOrder(e.objects, opts.quarryPos, e.seed,
        { rangeMeters: S.dscanRangeAu * ONE_AU_M, noisePermille: S.dscanNoisePermille });
      if (ranked.length === e.objects.length && ranked.some((o, i) => o !== e.objects[i])) {
        e.objects = ranked;
        bump("dscanRanked");
      }
    }
    const objects = e.objects;
    if (typeof hooks.afterHuntClaim === "function" && hooks.afterHuntClaim(e.huntId) === false) return true;
    try {
      if (trimmed && !sameMembers(claimed.members, members)) throw new StepError("MEMBERS_MISMATCH");
      spawnAndGoLive(e, members, profiles.profiles, ph, now);
    } catch (err) {
      const reason = err instanceof StepError ? err.reason : "SPAWN_THREW";
      const detail = err instanceof StepError ? err.detail : messageOf(err);
      const held = isSceneRefusal(reason) ? { first: true, failures: 0, retryAt: now }
        : spawnBackoff.note(fleet.fleetId, failureReasonOf(reason, detail), now);
      if (held.first) {
        logLimited(now, `playerHunt:${e.huntId} rolled back - ${reason}${detail ? ` ${detail}` : ""}`
          + `${held.failures > 0 ? ` backoff=${held.retryAt - now}ms failures=${held.failures}` : ""}`);
      }
      refuse(out, reason, "spawnFailed", detail);
      endHunt(e, SPAWN_FAILED, now, out);
      return false;
    }
    spawnBackoff.clear(fleet.fleetId);
    bump("started");
    capital.noteSpawned(capital.countOf(members));
    if (oversizeCut) bump("detachmentOversize");
    else if (trimmed) bump("scaled");
    if (heat >= 1) bump("escalationHeated");
    if (trimmed && quarryClass !== null) bump("detachmentMatched");
    if (claim) {
      bump("claimStarted");
      if (claimed.unstaged === true) bump("claimUnstaged");
    }
    if (out && Array.isArray(out.huntsStarted)) out.huntsStarted.push(e.huntId);
    logLimited(now, `playerHunt: ${e.huntId} live in ${systemId} quarry=${characterId} standing=${standing}`
      + ` ships=${e.spawned.length}${trimmed ? `/${all.length}` : ""} objects=${objects.length}`
      + `${claim ? ` claim=${claim.state}` : ""}`);
    return false;
  }

  const approachOn = () => S.approachEnabled === true && S.pursuitEnabled === true && S.pursuitMaxActive > 0
    && graphOf() !== null;

  function approachRefuse(out, systemId, now, reason, counter, detail) {
    refuse(out, reason, counter, detail);
    approachNextAt.set(systemId, now + S.approachRetryMs);
  }

  function readApproachCandidates(ph, jumpsOf, characters, now) {
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    if (!repo || typeof repo.listFleetsInSystems !== "function") return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    return tx("huntApproachRead", (db) => {
      const listed = repo.listFleetsInSystems(db, [...jumpsOf.keys()], { states: ["IDLE"],
        limitPerSystem: S.fleetScanMax });
      if (!listed || listed.ok !== true) return listed;
      const opts = { roles, maxShips: S.maxShipsPerHunt, oversizeOk: false, excludedFactions: excluded,
        factionKindOf: kindOf };
      const filtered = new Map();
      for (const [systemId, list] of listed.bySystem) {
        filtered.set(systemId, list.filter((f) => pickCandidate([f], opts) !== null));
      }
      const candidates = orderApproachCandidates(filtered, jumpsOf);
      const lastEnded = new Map();
      for (const factionId of new Set(candidates.map((f) => f.factionId))) {
        for (const characterId of characters) {
          lastEnded.set(`${characterId}:${factionId}`, ph.lastEndedAtInTx(db, characterId, factionId));
        }
      }
      return { ok: true, candidates, lastEnded, heat: maxHeatInTx(ph, db, characters, candidates, now) };
    });
  }

  function tryApproach(ph, s, characters, now, out) {
    const sys = s.systemId;
    if (approachNextAt.has(sys) && approachNextAt.get(sys) > now) return false;
    for (const p of pursuits.values()) {
      if (p.targetSystemId === sys || characters.includes(p.characterId)) return false;
    }
    if (pursuits.size >= S.pursuitMaxActive) {
      approachRefuse(out, sys, now, "PURSUIT_LIMIT", "approachRefused");
      return false;
    }
    if (characters.every((c) => chainCooled(c, now))) {
      approachRefuse(out, sys, now, "CHAIN_COOLDOWN", "approachRefused");
      return false;
    }
    const avoidSecClasses = constraintsOf(S).avoidSecClasses;
    const reach = escalationOn
      ? escalatedApproachJumps(S.approachMaxJumps, S.escalationMaxHeat, S.escalationMaxApproachJumps)
      : S.approachMaxJumps;
    const found = approachSystems(graphOf(), sys, { maxJumps: reach, maxSystems: S.approachMaxSystems,
      avoidSecClasses });
    if (!found.ok || found.systems.length === 0) {
      approachRefuse(out, sys, now, "APPROACH_NO_CANDIDATE", "approachNoCandidate", found.ok ? "NO_SYSTEM"
        : found.reason);
      return false;
    }
    const jumpsOf = new Map(found.systems.map((x) => [x.systemId, x.jumps]));
    const read = readApproachCandidates(ph, jumpsOf, characters, now);
    if (!read || read.ok !== true) {
      approachRefuse(out, sys, now, (read && read.reason) || "READ_FAILED", "readFailed");
      return false;
    }
    const maxJumps = escalationOn
      ? escalatedApproachJumps(S.approachMaxJumps, read.heat, S.escalationMaxApproachJumps) : S.approachMaxJumps;
    const inReach = escalationOn
      ? read.candidates.filter((f) => jumpsOf.get(f.currentSystemId) <= maxJumps) : read.candidates;
    let pick = null;
    let cooled = false;
    for (const fleet of inReach) {
      for (const characterId of characters) {
        const last = read.lastEnded.get(`${characterId}:${fleet.factionId}`);
        if (last !== null && last !== undefined && now - last < S.cooldownMs) {
          cooled = true;
          continue;
        }
        if (targetByStanding(characterId, fleet.factionId).target) {
          pick = { fleet, characterId };
          break;
        }
      }
      if (pick) break;
    }
    if (!pick) {
      const reason = inReach.length === 0 ? "APPROACH_NO_CANDIDATE"
        : cooled ? "APPROACH_COOLDOWN" : "APPROACH_STANDING";
      approachRefuse(out, sys, now, reason, "approachNoCandidate");
      return false;
    }
    const f = pick.fleet;
    const chainId = PH.approachChainIdOf(f.fleetId, f.version);
    const r = typeof ph.approachInTx === "function"
      ? tx("huntApproach", (db) => ph.approachInTx(db, { chainId, fleetId: f.fleetId, expectedVersion: f.version,
        fromSystemId: f.currentSystemId, targetSystemId: sys, at: clock.now(),
        constraints: { maxJumps, avoidSecClasses } }))
      : { ok: false, reason: "PURSUIT_UNAVAILABLE" };
    if (!r || r.ok !== true) {
      const reason = (r && r.reason) || "APPROACH_FAILED";
      approachRefuse(out, sys, now, reason, "approachRefused", f.fleetId);
      logLimited(now, `playerHunt: approach ${chainId} ${f.currentSystemId} -> ${sys} refused - ${reason}`);
      return true;
    }
    const who = (Array.isArray(s.presence.characters) ? s.presence.characters : [])
      .find((c) => c && c.characterId === pick.characterId);
    const warnOn = S.warningEnabled === true;
    pursuits.set(f.fleetId, { kind: "approach", chainId, fleetId: f.fleetId, factionId: f.factionId,
      characterId: pick.characterId, quarryName: who && who.name ? who.name : null, fromSystemId: f.currentSystemId,
      targetSystemId: sys, operationId: r.operationId, arriveAt: r.arriveAt, hops: 1, startedAt: now,
      originSystemId: f.currentSystemId, ...(warnOn ? { warnedAt: now } : {}) });
    bump("approachStarted");
    if (warnOn) sendWarning(sys, pick.characterId, f.factionId, now);
    logLimited(now, `playerHunt: approach ${chainId} ${f.currentSystemId} -> ${sys} jumps=${r.jumps}`
      + ` arriveAt=${r.arriveAt}`);
    return true;
  }

  function stepNewHunts(now, presence, out) {
    const ph = playerHunt();
    if (!ph || safeCall(() => ph.isEnabled()) !== true) return false;
    if (!lossImportOn) {
      logOnce("lossImport", "playerHunt: no new hunts - battle.liveLossImport off");
      return false;
    }
    if (readStanding === null) {
      logOnce("standing", "playerHunt: no new hunts - no standing read in the adapter");
      return false;
    }
    const seam = safeCall(getHuntScene);
    if (!seam) {
      logOnce("seam", "playerHunt: no new hunts - hunt scene seam unavailable");
      return false;
    }
    if (!admits(WORK_CLASS_NEW)) {
      refuse(out, "GOVERNOR", "refusedGovernor");
      return false;
    }
    beginPass(now);
    const systems = candidateSystems(presence);
    notice(systems, now);
    const warnOn = S.warningEnabled === true;
    let attempts = 0;
    let approaches = 0;
    if (warnOn) {
      const due = stepDueWarnings(ph, seam, systems, now, out);
      if (due.aborted) return true;
      attempts = due.attempts;
    }
    for (const s of systems) {
      if (attempts >= S.maxNewHuntsPerPass || entries.size + warnings.size >= S.maxActiveHunts) break;
      if (warnOn && pass.warned >= S.warningMaxPerPass
        && !(approaches < S.approachMaxPerPass && approachOn())) break;
      if (huntsInSystem(s.systemId) + warningsIn(s.systemId) >= S.maxHuntsPerSystem) continue;
      const characters = [];
      for (const [key, at] of firstSeen) {
        const [sys, chr] = key.split(":").map(Number);
        if (sys === s.systemId && now - at >= S.noticeDelayMs && !warnings.has(key)
          && !(warnOn && approachWarned(sys, chr))) characters.push(chr);
      }
      if (characters.length === 0) continue;
      characters.sort((a, b) => a - b);
      cursor = s.systemId;
      const read = readCandidates(ph, s.systemId, characters, now);
      if (!read || read.ok !== true) {
        refuse(out, (read && read.reason) || "READ_FAILED", "readFailed");
        continue;
      }
      if (read.claimOversize === true) bump("claimRefusedSize");
      if (read.candidates.length === 0 && read.claimCandidates.length === 0) {
        refuse(out, "NO_CANDIDATE", "refusedNoCandidate");
        if (approaches < S.approachMaxPerPass && approachOn() && tryApproach(ph, s, characters, now, out)) {
          approaches += 1;
        }
        continue;
      }
      let pick = null;
      let cooled = false;
      let held = false;
      const ordered = [...read.claimCandidates.map((fleet) => ({ fleet, claim: read.claim })),
        ...read.candidates.map((fleet) => ({ fleet, claim: null }))];
      for (const { fleet, claim } of ordered) {
        if (spawnBackoff.blocked(fleet.fleetId, now) !== null) {
          refuse(out, "SPAWN_BACKOFF", "refusedBackoff", fleet.fleetId);
          held = true;
          continue;
        }
        for (const characterId of characters) {
          const last = read.lastEnded.get(`${characterId}:${fleet.factionId}`);
          if (last !== null && last !== undefined && now - last < S.cooldownMs) {
            cooled = true;
            continue;
          }
          const t = targetByStanding(characterId, fleet.factionId);
          if (t.target) {
            pick = { fleet, characterId, standing: t.standing, claim };
            break;
          }
        }
        if (pick) break;
      }
      if (!pick && held && ordered.every((c) => spawnBackoff.blocked(c.fleet.fleetId, now) !== null)) continue;
      if (!pick) {
        refuse(out, cooled ? "COOLDOWN" : "STANDING", cooled ? "refusedCooldown" : "refusedStanding");
        continue;
      }
      if (warnOn) {
        if (warn(s.systemId, pick.characterId, pick.fleet.factionId, pick.fleet.fleetId, now)) attempts += 1;
        continue;
      }
      attempts += 1;
      const who = (Array.isArray(s.presence.characters) ? s.presence.characters : [])
        .find((c) => c && c.characterId === pick.characterId);
      if (startHunt(ph, seam, pick.fleet, pick.characterId, pick.standing, s.systemId, now, out,
        who ? who.name : null, { quarryPos: quarryPosOf(s.systemId, pick.characterId, seam), claim: pick.claim })) {
        return true;
      }
    }
    return false;
  }

  function step(now, presence, out, retargetsLeft) {
    const t0 = nowMs();
    try {
      const retargets = stepHunts(now, presence, out, retargetsLeft);
      if (stepPursuits(now, presence, out)) return { retargets, aborted: true };
      const aborted = stepNewHunts(now, presence, out);
      return { retargets, aborted };
    } finally {
      publishGauges();
      if (entries.size > 0 || counters.started > 0) observe("playerHunt.stepMs", nowMs() - t0);
    }
  }

  function getStatus() {
    const ph = playerHunt();
    const list = [...entries.values()].map((e) => ({ huntId: e.huntId, systemId: e.systemId, fleetId: e.fleetId,
      factionId: e.factionId, characterId: e.characterId, quarryName: e.quarryName, mode: e.mode, state: e.state,
      phase: e.phase, phaseSince: e.phaseSince, objectIndex: e.objectIndex, visited: e.visited,
      objects: e.objects.length, scanCycle: e.scanCycle, ships: e.spawned.length,
      alive: e.despawned ? 0 : e.alive, liveSince: e.liveSince, aggressors: e.aggressors.size,
      despawned: e.despawned, endReason: e.endReason, exitReason: e.exitReason, claim: Boolean(e.claim),
      object: currentObjectOf(e) }));
    let ships = 0;
    for (const e of entries.values()) if (!e.despawned) ships += e.spawned.length;
    return {
      enabled: Boolean(ph && safeCall(() => ph.isEnabled()) === true),
      lossImport: lossImportOn ? "on" : "off",
      active: entries.size,
      ships,
      hunts: list,
      noticed: firstSeen.size,
      counters: { ...counters },
      lastRefusal,
      lossTracker: lossTracker.sizes(),
      warnings: [...warnings.values()].map((w) => ({ ...w })),
      pursuits: [...pursuits.values()].map((p) => ({ kind: p.kind, chainId: p.chainId, fleetId: p.fleetId,
        factionId: p.factionId,
        characterId: p.characterId, quarryName: p.quarryName, fromSystemId: p.fromSystemId,
        targetSystemId: p.targetSystemId, operationId: p.operationId, arriveAt: p.arriveAt, hops: p.hops,
        startedAt: p.startedAt })),
    };
  }

  function addLiveLosses(into) {
    for (const e of entries.values()) {
      const held = Number.isSafeInteger(e.heldBack) && e.heldBack > 0 ? e.heldBack : 0;
      const n = (e.lostKeys ? e.lostKeys.size : 0) + held;
      if (n > 0) into.set(e.fleetId, (into.get(e.fleetId) || 0) + n);
    }
    return into;
  }

  function relationGroups() {
    const out = [];
    for (const e of entries.values()) {
      if (e.state !== "LIVE" || e.despawned) continue;
      out.push({ systemId: e.systemId, factionId: e.factionId, entityIds: idsOf(e), ...hullGroupsOf(e),
        aggressors: e.aggressors, primaryCharacterId: Number.isSafeInteger(e.characterId) ? e.characterId : null,
        groupId: e.huntId });
    }
    return out;
  }

  return Object.freeze({ stepPending, stepHunts, stepNewHunts, step, getStatus, addLiveLosses, relationGroups });
}

module.exports = { createHuntStep, COUNTER_NAMES };
