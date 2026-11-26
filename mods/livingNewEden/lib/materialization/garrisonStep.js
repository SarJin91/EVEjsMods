"use strict";

const { decidePatrolStep, PHASES } = require("../garrisonPatrol/phases");
const { pickPatrolFleets, chooseMode, pickCampGate, patrolRoute, standoffPoint, campPoint, rotateToNearest }
  = require("../garrisonPatrol/policy");
const { parsePatrolObjectKinds, parseCampPermille, parseKindList, parseLneTargetSources, TRIGGER_ARRIVAL,
  TRIGGER_EXIT, TRIGGER_LNE, TRIGGER_REINFORCE } = require("../garrisonPatrol/schema");
const { ownerOf, arrivalGateOf, exitGateOf, pickDefenseFleets, neighboursOf, gateTowards, pickReinforcements }
  = require("../garrisonPatrol/defense");
const { parseOperationTypeList } = require("../fleets/schema");
const { relationOf, huntThresholds, currentObjectOf } = require("../playerHunt/policy");
const { membersOf, pickDetachment } = require("../playerHunt/huntRepository");
const PH = require("../playerHunt/schema");
const { deriveSeed } = require("../util/rng");
const { NO_CAPITAL_RULES } = require("./capitalRules");
const { createSpawnBackoff, failureReasonOf } = require("./spawnBackoff");
const { sceneRefusalOf, isSceneRefusal } = require("./sceneBudget");

const SCENE_SOURCE = "npcSpawn";

const COUNTER_NAMES = Object.freeze(["started", "startedPatrol", "startedCamp", "refusedGovernor", "refusedBudget",
  "refusedProfile", "refusedObjects", "refusedClaim", "spawnFailed", "engaged", "retaliated", "retargeted",
  "objectsVisited", "warpNoStart", "lossImported", "lossStale", "lossFailed", "ended", "endFailed", "readFailed",
  "scans", "crewFallback",
  "orderLost",
  "defenseArrivals", "defenseStarted", "defenseUnstaged", "defenseRefusedGovernor", "defenseExpired", "defenseNoGate",
  "defenseNotOwner", "defenseNotHostile", "defenseGateFull", "defenseNoFleet",
  "defenseAttempts", "defenseSkippedProfile",
  "defenseExitSeen", "defenseExitStarted", "defenseExitCovered", "defenseExitNoFleet", "defenseRelocated",
  "defenseRelocateLanded", "defenseRelocateFailed",
  "refusedForeignSystem",
  "lneTargeted", "lneRetaliated", "lneArmed", "lneArmFailed", "lneArmDeferred",
  "defenseLneSeen", "defenseLneStarted", "defenseLneCovered", "defenseLneRelocated", "defenseLneNoGate",
  "defenseLneNoFleet", "defenseLneExpired",
  "defenseReinforceSent", "defenseReinforceNoCandidate", "defenseReinforceLimited", "defenseReinforceRefused",
  "defenseReinforceStarted", "defenseReinforceStayed", "defenseReinforceLost",
  "refusedBackoff", "lneArmBackoff"]);
const GARRISON_STEP_METHODS = Object.freeze(["stepPending", "step", "getStatus", "stop", "addLiveLosses",
  "relationGroups"]);

const WORK_CLASS_NEW = "OPERATIONAL";
const SPAWN_FAILED = "SPAWN_FAILED";
const MODE_PATROL = "PATROL";
const MODE_CAMP = "GATE_CAMP";
const STARGATE = "stargate";
const POLICY_RANDOM = "random";
const TRIGGER_ANY = "any";
const RELATION_HOSTILE = "hostile";
const OWNER_READ_FAILED = Symbol("ownerReadFailed");
const WORLD_STATE_UNAVAILABLE = "unavailable";
const DEFENSE_STATES = Object.freeze(["IDLE", "STAGED"]);
const REINFORCE_EN_ROUTE = Object.freeze(["PLANNED", "TRAVELLING", "STAGED"]);
const HOUR_MS = 3600000;
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

function sameMembers(stored, planned) {
  return Array.isArray(stored) && stored.length === planned.length
    && stored.every((m, i) => m && m.memberKey === planned[i].memberKey);
}

function createGarrisonStep(deps) {
  const { store, clock, npcSpawn, budget, lossTracker } = deps;
  const G = deps.settings;
  const HS = deps.huntSettings && typeof deps.huntSettings === "object" ? deps.huntSettings : {};
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const hooks = deps.hooks && typeof deps.hooks === "object" ? deps.hooks : {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
  const getPlayerHunt = typeof deps.getPlayerHunt === "function" ? deps.getPlayerHunt : () => null;
  const getFactionKind = typeof deps.getFactionKind === "function" ? deps.getFactionKind : () => null;
  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
  const getHuntScene = typeof deps.getHuntScene === "function" ? deps.getHuntScene : () => null;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const getCrews = typeof deps.getCrews === "function" ? deps.getCrews : () => null;
  const getWorld = typeof deps.getWorld === "function" ? deps.getWorld : () => null;
  const readStanding = typeof deps.readStanding === "function" ? deps.readStanding : null;
  const despawnAll = deps.despawnAll;
  const admits = typeof deps.admits === "function" ? deps.admits : () => true;
  const lossImportOn = deps.lossImportOn === true;
  const excluded = Array.isArray(deps.excludedFactionIds) ? [...deps.excludedFactionIds] : [];
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed >>> 0 : 0;
  const retargetLimit = Number.isSafeInteger(deps.maxRetargetsPerPass) ? deps.maxRetargetsPerPass : 0;
  const capital = deps.capital && typeof deps.capital.slotsOf === "function" ? deps.capital : NO_CAPITAL_RULES;
  const spawnBackoff = deps.spawnBackoff && typeof deps.spawnBackoff.blocked === "function" ? deps.spawnBackoff
    : createSpawnBackoff(null);
  const roles = PH.parseRoleList(G.roles) || [];
  const objectKinds = parsePatrolObjectKinds(G.objectKinds) || [];
  const listKinds = objectKinds.includes(STARGATE) ? [...objectKinds] : [...objectKinds, STARGATE];
  const campPermille = parseCampPermille(G.campPermilleByKind) || {};
  const neutralPolicy = PH.parseNeutralPolicy(HS.neutralPolicy) || {};
  const thresholds = huntThresholds(HS);
  const maxStandingReads = Number.isSafeInteger(HS.maxStandingReadsPerPass) ? HS.maxStandingReadsPerPass : 0;
  const params = Object.freeze({ objectDwellMs: G.objectDwellMs, warpTimeoutMs: G.warpTimeoutMs,
    warpStartGraceMs: G.warpStartGraceMs, reacquireGraceMs: G.reacquireGraceMs, exitGraceMs: G.exitGraceMs,
    maxLiveMs: G.maxLiveMs });
  const defenseRoles = PH.parseRoleList(G.defenseRoles) || [];
  const defenseUnstageTypes = parseOperationTypeList(G.defenseUnstageOperationTypes) || [];
  const defenseKinds = parseKindList(G.defenseKinds) || [];
  const getLneGroups = typeof deps.getLneGroups === "function" ? deps.getLneGroups : null;
  const isFactionEnemy = typeof deps.isFactionEnemy === "function" ? deps.isFactionEnemy : null;
  const lneOn = G.lneTargetsEnabled === true && getLneGroups !== null && isFactionEnemy !== null;
  const lneSources = parseLneTargetSources(G.lneTargetSources) || [];
  const lneArmMax = Number.isSafeInteger(G.lneArmMaxPerPass) ? G.lneArmMaxPerPass : 0;
  const reinforceRoles = PH.parseRoleList(G.defenseReinforceRoles) || [];
  const attackLockOn = deps.attackLockOn === true;
  const campCloakOn = G.campCloakOrderEnabled === true;

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const entries = new Map();
  let firstSeen = new Map();
  const nextScanAt = new Map();
  const arrivals = new Map();
  const exitMemo = new Map();
  const lneMemo = new Map();
  const reinforcements = new Map();
  const reinforceCooldown = new Map();
  const reinforceSent = new Map();
  let seeded = false;
  let cursor = 0;
  let lastRefusal = null;
  let stopped = false;
  const loggedOnce = new Set();
  let errorWindow = -Infinity;
  let errorLines = 0;
  let pass = newPass(null);
  const armedIds = new Set();

  function newPass(at) {
    return { at, standing: new Map(), reads: 0, players: new Map(), lne: null, lneOk: false, lneFaction: new Map(),
      lnePos: new Map(), arms: 0 };
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`garrisonPatrol.${name}`, n);
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

  function shipsOut() {
    let ships = 0;
    for (const e of entries.values()) if (!e.despawned) ships += e.spawned.length;
    return ships;
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
    const key = `patrol:${reason}`;
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
    if (!ph || typeof ph.claimInTx !== "function" || typeof ph.endInTx !== "function") return null;
    const st = safeCall(() => ph.getStatus());
    return st && st.state === "ready" ? ph : null;
  }

  function crewsOf() {
    const c = safeCall(getCrews);
    if (!c || typeof c.seatsForMaterializationInTx !== "function" || typeof c.recordLiveLossInTx !== "function") {
      return null;
    }
    const st = safeCall(() => c.getStatus());
    return st && st.state === "running" ? c : null;
  }

  function beginPass(now) {
    if (pass.at === now) return;
    pass = newPass(now);
  }

  function standingOf(characterId, factionId) {
    const key = `${characterId}:${factionId}`;
    if (pass.standing.has(key)) return pass.standing.get(key);
    if (readStanding === null || pass.reads >= maxStandingReads) return null;
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

  function hostileByStanding(characterId, factionId) {
    const standing = standingOf(characterId, factionId);
    if (standing === null) return false;
    return relationOf(standing, kindOf(factionId), thresholds, neutralPolicy) === "hostile";
  }

  function stepLosses(now, ph) {
    const losses = lossTracker.drain();
    if (losses.length === 0) return;
    if (!ph) {
      bump("lossFailed", losses.length);
      return;
    }
    const r = tx("patrolLosses", (db) => {
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
      logLimited(now, `garrisonPatrol: losses not imported (${losses.length}) - ${(r && r.reason) || "no result"}`);
      return;
    }
    for (const huntId of r.huntIds) {
      const e = entries.get(huntId);
      if (e) e.spawnConfirmed = true;
    }
    for (const l of r.lost) {
      const e = entries.get(l.battleId);
      if (e) e.lostKeys.add(l.memberKey);
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

  function crewLossInTx(db, e, at) {
    if (e.seatOf.size === 0) return { done: false };
    const characterIds = [...e.lostKeys].map((k) => e.seatOf.get(k)).filter((id) => Number.isSafeInteger(id));
    if (characterIds.length === 0) return { done: false };
    const crews = crewsOf();
    if (!crews) return { done: false, fallback: true };
    try {
      const r = crews.recordLiveLossInTx(db, { fleetId: e.fleetId, characterIds, at }, `${e.huntId}:liveLoss:v1`);
      return { done: true, fallback: !(r && r.ok === true) };
    } catch (err) {
      if (!db || db.inTransaction !== true) throw err;
      return { done: true, fallback: true };
    }
  }

  function tryEnd(e, now, out) {
    const ph = playerHunt();
    let crew = { done: false };
    const r = ph ? tx("patrolEnd", (db) => {
      const at = clock.now();
      const ended = ph.endInTx(db, { huntId: e.huntId, at, reason: e.endReason });
      if (ended && ended.ok === true && ended.duplicate !== true) crew = crewLossInTx(db, e, at);
      return ended;
    }) : { ok: false, reason: "PLAYER_HUNT_UNAVAILABLE" };
    if (r && r.ok === true) {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      if (e.endReason !== SPAWN_FAILED) bump("ended");
      if (crew.fallback) bump("crewFallback");
      logLimited(now, `garrisonPatrol: ${e.huntId} ended ${e.endReason} outcome=${r.outcome}`
        + ` losses=${(r.losses || []).reduce((n, g) => n + g.count, 0)}${r.duplicate ? " (duplicate)" : ""}`);
      return true;
    }
    bump("endFailed");
    if (r && PERMANENT_END.includes(r.reason)) {
      entries.delete(e.huntId);
      lossTracker.untrack(e.huntId);
      logger.log(`garrisonPatrol: end ${e.huntId} refused - ${r.reason} (left to the restart recovery)`);
      return true;
    }
    logLimited(now, `garrisonPatrol: end ${e.huntId} failed - ${(r && r.reason) || "no result"}`);
    return false;
  }

  function endPatrol(e, reason, now, out) {
    despawnAndRelease(e);
    e.state = "ENDING";
    e.endReason = reason;
    tryEnd(e, now, out);
  }

  function stepPending(now, out) {
    if (stopped) return;
    if (entries.size === 0 && lossTracker.sizes().pending === 0) return;
    stepLosses(now, playerHunt());
    for (const e of [...entries.values()]) {
      if (e.state === "SPAWNING") {
        bump("spawnFailed");
        endPatrol(e, SPAWN_FAILED, now, out);
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

  function jumpCloakTarget(e, p) {
    return campCloakOn && e.mode === MODE_CAMP && p.jumpCloaked === true;
  }

  function hostilesOf(e, own, players, lne) {
    const gridSq = G.gridRadiusMeters * G.gridRadiusMeters;
    const lead = own[0];
    const out = [];
    for (const p of players) {
      if (p.inWarp || p.capsule) continue;
      if (p.cloaked && !jumpCloakTarget(e, p)) continue;
      if (e.aggressors.has(p.entityId)) {
        if (own.some((s) => !s.inWarp && distanceSq(s.position, p.position) <= gridSq)) out.push(p.entityId);
        continue;
      }
      if (!lead || lead.inWarp || distanceSq(lead.position, p.position) > gridSq) continue;
      if (hostileByStanding(p.characterId, e.factionId)) out.push(p.entityId);
    }
    if (lne) {
      const seen = new Set(out);
      for (const [id, a] of lne.aggressors) {
        if (seen.has(id) || a.inWarp === true || !a.position) continue;
        if (own.some((s) => !s.inWarp && distanceSq(s.position, a.position) <= gridSq)) {
          out.push(id);
          seen.add(id);
        }
      }
      if (lead && !lead.inWarp) {
        for (const s of lne.ships) {
          if (seen.has(s.entityId) || s.inWarp === true || !s.position) continue;
          if (distanceSq(lead.position, s.position) > gridSq) continue;
          out.push(s.entityId);
          seen.add(s.entityId);
        }
      }
    }
    return out.sort((a, b) => a - b);
  }

  function isEnemy(f, g) {
    if (f === g || isFactionEnemy === null) return false;
    return safeCall(() => isFactionEnemy(f, g)) === true;
  }

  function lneOfPass() {
    if (pass.lne !== null) return pass.lne;
    const bySystem = new Map();
    pass.lne = bySystem;
    const groups = safeCall(getLneGroups);
    if (!Array.isArray(groups)) return bySystem;
    pass.lneOk = true;
    for (const g of groups) {
      if (!g || !lneSources.includes(g.source) || !Number.isSafeInteger(g.systemId)
        || !Number.isSafeInteger(g.factionId) || !Array.isArray(g.entityIds)) continue;
      if (!bySystem.has(g.systemId)) bySystem.set(g.systemId, []);
      const list = bySystem.get(g.systemId);
      const groupId = typeof g.groupId === "string" ? g.groupId : null;
      for (const entityId of g.entityIds) {
        if (!Number.isSafeInteger(entityId) || entityId <= 0 || pass.lneFaction.has(entityId)) continue;
        list.push({ entityId, factionId: g.factionId, source: g.source, groupId });
        pass.lneFaction.set(entityId, g.factionId);
      }
    }
    return bySystem;
  }

  function lnePositions(systemId, seam) {
    if (pass.lnePos.has(systemId)) return pass.lnePos.get(systemId);
    const out = new Map();
    pass.lnePos.set(systemId, out);
    const ids = (lneOfPass().get(systemId) || []).map((x) => x.entityId);
    if (ids.length === 0) return out;
    let r;
    try {
      r = seam.readShips(systemId, ids);
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !Array.isArray(r.ships)) return out;
    for (const s of r.ships) {
      if (s && s.position) out.set(s.entityId, { position: s.position, inWarp: s.inWarp === true });
    }
    return out;
  }

  function lneShipsFor(e, own, seam) {
    const lead = own[0];
    if (e.ownSystem !== true || !lead || lead.inWarp) return [];
    const enemies = (lneOfPass().get(e.systemId) || []).filter((x) => isEnemy(e.factionId, x.factionId));
    if (enemies.length === 0) return [];
    const pos = lnePositions(e.systemId, seam);
    const ships = [];
    for (const x of enemies) {
      const p = pos.get(x.entityId);
      if (p) ships.push({ entityId: x.entityId, position: p.position, inWarp: p.inWarp, factionId: x.factionId });
    }
    return ships;
  }

  function armFor(e, own, hostiles, seam, now) {
    const lneIds = hostiles.filter((id) => pass.lneFaction.has(id));
    if (lneIds.length === 0) return hostiles;
    let need = [...new Set([...own.map((s) => s.entityId), ...lneIds])].filter((id) => !armedIds.has(id));
    if (need.length === 0) return hostiles;
    const held = new Set(need.filter((id) => spawnBackoff.blocked(`arm:${id}`, now) !== null));
    if (held.size > 0) {
      bump("lneArmBackoff", held.size);
      need = need.filter((id) => !held.has(id));
    }
    const without = (drop) => hostiles.filter((id) => !drop.has(id) && !held.has(id));
    if (need.length === 0) return without(new Set());
    if (pass.arms >= lneArmMax) {
      bump("lneArmDeferred", lneIds.length);
      return without(new Set(lneIds));
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
      bump("lneArmFailed", lneIds.length);
      logLimited(now, `garrisonPatrol: ${e.huntId} arm refused - ${(r && (r.detail || r.reason)) || "no result"}`);
      return without(new Set(lneIds));
    }
    const failed = new Set(Array.isArray(r.failed) ? r.failed : []);
    for (const id of need) {
      if (!failed.has(id)) armedIds.add(id);
      else spawnBackoff.note(`arm:${id}`, "ARM_FAILED", now, { escalate: false });
    }
    bump("lneArmed", Number.isSafeInteger(r.armed) ? r.armed : 0);
    const dropped = lneIds.filter((id) => failed.has(id));
    if (dropped.length === 0) return held.size > 0 ? without(new Set()) : hostiles;
    bump("lneArmFailed", dropped.length);
    logLimited(now, `garrisonPatrol: ${e.huntId} arm failed [${dropped.join(",")}] - ${r.detail || "failed"}`);
    return without(new Set(dropped));
  }

  function pruneArmed() {
    if (armedIds.size === 0) return;
    const keep = new Set(pass.lneFaction.keys());
    for (const e of entries.values()) if (!e.despawned) for (const id of idsOf(e)) keep.add(id);
    for (const id of [...armedIds]) if (!keep.has(id)) armedIds.delete(id);
  }

  function presentIn(presence, systemId) {
    const sp = safeCall(() => presence.getSystemPresence(systemId));
    return Boolean(sp) && ((Number(sp.space) || 0) + (Number(sp.docked) || 0)) > 0;
  }

  function factsOf(e, now, seam, presence) {
    const players = playersOf(e.systemId, seam);
    if (!players || players.ok !== true) {
      if (players && players.reason === "SCENE_NOT_LOADED") {
        return { now, sceneLoaded: false, ownAlive: [], hostilesOnGrid: [], present: false };
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
    dropLostOrders(e, ownAlive, now, players.ships);
    e.aggressorOf.clear();
    const lne = lneOn && ownAlive.length > 0 ? { ships: [], aggressors: new Map() } : null;
    if (lne) lneOfPass();
    if (ownAlive.length > 0) {
      const ag = seam.readAggressors(e.systemId, ownAlive.map((s) => s.entityId));
      if (ag && ag.ok === true) {
        const playerIds = new Set(players.ships.map((p) => p.entityId));
        for (const a of ag.aggressors) {
          if (playerIds.has(a.aggressorId)) {
            e.aggressors.add(a.aggressorId);
            e.aggressorOf.set(a.entityId, a.aggressorId);
          } else if (lne && a.aggressorKind === "npc" && pass.lneFaction.has(a.aggressorId)
            && isEnemy(e.factionId, pass.lneFaction.get(a.aggressorId))) {
            lne.aggressors.set(a.aggressorId, { position: a.aggressorPosition || null,
              inWarp: a.aggressorInWarp === true });
            e.aggressorOf.set(a.entityId, a.aggressorId);
          }
        }
      }
    }
    if (lne) lne.ships = lneShipsFor(e, ownAlive, seam);
    let hostilesOnGrid = ownAlive.length > 0 ? hostilesOf(e, ownAlive, players.ships, lne) : [];
    if (lne) {
      hostilesOnGrid = armFor(e, ownAlive, hostilesOnGrid, seam, now);
      for (const id of hostilesOnGrid) {
        if (!pass.lneFaction.has(id) || e.lneSeen.has(id)) continue;
        e.lneSeen.add(id);
        bump("lneTargeted");
      }
    }
    return { now, sceneLoaded: true, ownAlive, present: presentIn(presence, e.systemId), hostilesOnGrid };
  }

  function noteOrder(r, now, what, e) {
    if (r && r.ok === true && (!Array.isArray(r.failed) || r.failed.length === 0)) return;
    logLimited(now, `garrisonPatrol: ${what} ${e.huntId} - ${(r && (r.detail || r.reason)) || "no result"}`);
  }

  function dropLostOrders(e, ownAlive, now, players) {
    noteBeyondLeash(e, ownAlive, now, "garrisonPatrol");
    const lost = [];
    const cloaked = new Set((Array.isArray(players) ? players : []).filter((p) => p && p.cloaked
      && jumpCloakTarget(e, p)).map((p) => p.entityId));
    for (const s of ownAlive) {
      const want = e.targetOf.get(s.entityId);
      const v = s.vendorOrder;
      if (want === undefined || !v || typeof v !== "object") continue;
      const locked = !attackLockOn || (v.keepLock === true && v.allowWeapons === true);
      if (v.attackTargetId === want && v.weapons !== false && locked) continue;
      e.targetOf.delete(s.entityId);
      if (cloaked.has(want)) continue;
      lost.push(`${s.entityId}:want=${want}:vendor=${v.attackTargetId}:weapons=${v.weapons !== false}`
        + (attackLockOn ? `:lock=${locked}` : ""));
    }
    if (lost.length === 0) return;
    bump("orderLost", lost.length);
    logLimited(now, `garrisonPatrol: ${e.huntId} order lost (${lost.length}) [${lost.join(",")}] phase=${e.phase}`
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
      if (e.aggressorOf.get(ship) === target) {
        bump("retaliated");
        if (pass.lneFaction.has(target)) bump("lneRetaliated");
      }
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
        noteOrder(seam.warpShips(e.systemId, alive, a.point, { spreadMeters: G.landingSpreadMeters }), now, "warp", e);
        bump("objectsVisited");
      } else if (a.type === "attack") {
        attacked = true;
        bump("engaged");
        e.targetOf.clear();
        orderTargets(e, alive, a.targets, seam, now, alive.length);
        logLimited(now, `garrisonPatrol: ${e.huntId} attack ships=${alive.length} ordered=`
          + `${alive.filter((id) => e.targetOf.has(id)).length} targets=[${a.targets.join(",")}]`);
      }
    }
    if (d.phase !== PHASES.ENGAGED || attacked || facts.hostilesOnGrid.length === 0) return 0;
    const used = orderTargets(e, alive, facts.hostilesOnGrid, seam, now, retargetsLeft);
    bump("retargeted", used);
    return used;
  }

  function stepPatrols(now, presence, out, retargetsLeftArg) {
    if (entries.size === 0) return 0;
    beginPass(now);
    let retargetsLeft = Number.isSafeInteger(retargetsLeftArg) ? Math.max(0, retargetsLeftArg) : retargetLimit;
    let used = 0;
    const seam = safeCall(getHuntScene);
    const live = [...entries.values()].filter((e) => e.state === "LIVE")
      .sort((a, b) => (a.huntId < b.huntId ? -1 : a.huntId > b.huntId ? 1 : 0));
    for (const e of live) {
      if (G.enabled !== true) {
        endPatrol(e, "DISABLED", now, out);
        continue;
      }
      if (!seam) {
        endPatrol(e, "SCENE_GONE", now, out);
        continue;
      }
      let facts;
      let d;
      try {
        facts = factsOf(e, now, seam, presence);
        if (facts === null) continue;
        if (facts.ownAlive.length > 0) e.spawnConfirmed = true;
        d = decidePatrolStep(e, facts, params);
      } catch (err) {
        bump("readFailed");
        logLimited(now, `garrisonPatrol: step ${e.huntId} threw - ${messageOf(err)}`);
        continue;
      }
      e.alive = facts.ownAlive.length;
      const wasWarp = e.phase === PHASES.CAMP_WARP;
      e.phase = d.phase;
      e.phaseSince = d.phaseSince;
      e.objectIndex = d.objectIndex;
      e.absentSince = d.absentSince;
      e.noTargetSince = d.noTargetSince;
      e.warpSeen = d.warpSeen === true;
      e.relocateTo = d.relocateTo === undefined ? null : d.relocateTo;
      if (d.relocated !== null && d.relocated !== undefined) {
        logLimited(now, `garrisonPatrol: ${e.huntId} relocate gate=${d.relocated} system=${e.systemId}`);
      }
      if (d.relocateCancelled === true || (wasWarp && d.warpEnd === "grace")) restoreGate(e);
      if (wasWarp && d.warpEnd === "landed") bump("defenseRelocateLanded");
      if (wasWarp && d.warpEnd === "grace") bump("defenseRelocateFailed");
      if (wasWarp && d.phase !== PHASES.CAMP_WARP) e.relocateFrom = null;
      if (d.warpEnd === "grace") bump("warpNoStart");
      if (d.end) {
        endPatrol(e, d.end.reason, now, out);
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
    const here = new Set(systems.map((s) => s.systemId));
    for (const systemId of [...nextScanAt.keys()]) if (!here.has(systemId)) nextScanAt.delete(systemId);
  }

  function observeArrivals(now, presence) {
    const systems = candidateSystems(presence);
    const before = firstSeen;
    notice(systems, now);
    if (G.defenseEnabled === true) {
      if (seeded) {
        for (const key of firstSeen.keys()) {
          if (before.has(key) || arrivals.has(key)) continue;
          const [systemId, characterId] = key.split(":").map(Number);
          arrivals.set(key, { key, systemId, characterId, at: now });
          bump("defenseArrivals");
        }
      }
      for (const key of [...arrivals.keys()]) if (!firstSeen.has(key)) arrivals.delete(key);
    }
    seeded = true;
    return systems;
  }

  function countAtGate(systemId, gateId) {
    let n = 0;
    for (const e of entries.values()) {
      if (e.systemId === systemId && e.mode === MODE_CAMP && e.campGate === gateId && e.state !== "ENDING") n += 1;
    }
    return n;
  }

  function ownerOfSystem(systemId) {
    const world = safeCall(getWorld);
    const status = world && typeof world.getStatus === "function" ? safeCall(() => world.getStatus()) : null;
    const hasRead = Boolean(world) && typeof world.getControlState === "function"
      && !(status && status.state === WORLD_STATE_UNAVAILABLE);
    const read = hasRead ? safeCall(() => world.getControlState(systemId)) : null;
    if (hasRead && !(read && read.ok === true)) return OWNER_READ_FAILED;
    const controller = read && read.ok === true && read.system ? read.system.controllerFactionId : null;
    const graph = graphOf();
    const sde = graph ? systemInfo(graph, systemId) : null;
    return ownerOf({ controllerFactionId: controller, sdeFactionId: sde ? sde.factionId : null });
  }

  function readDefenseFleets(systemId, ownerFactionId) {
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    if (!repo || typeof repo.listFleetsInSystem !== "function" || typeof repo.getOperation !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    return tx("patrolDefenseRead", (db) => {
      const listed = repo.listFleetsInSystem(db, systemId, { states: [...DEFENSE_STATES], limit: G.fleetScanMax });
      if (!listed || listed.ok !== true) return listed;
      const operations = new Map();
      for (const f of listed.fleets) {
        if (f.state !== "STAGED" || typeof f.operationId !== "string" || operations.has(f.operationId)) continue;
        const got = repo.getOperation(db, f.operationId);
        operations.set(f.operationId, got && got.ok === true ? got.operation : null);
      }
      return { ok: true, fleets: pickDefenseFleets(listed.fleets, operations, { ownerFactionId, roles: defenseRoles,
        kinds: defenseKinds, unstageOperationTypes: defenseUnstageTypes, excludedFactions: excluded,
        factionKindOf: kindOf }) };
    });
  }

  function gatesOf(systemId, seam, cache) {
    if (cache.has(systemId)) return cache.get(systemId);
    let listed;
    try {
      listed = seam.listSystemObjects(systemId, [STARGATE]);
    } catch (err) {
      listed = { ok: false, reason: "LIST_THREW", detail: messageOf(err) };
    }
    const gates = listed && listed.ok === true && Array.isArray(listed.objects) ? listed.objects : null;
    cache.set(systemId, gates);
    return gates;
  }

  function newDefensePass() {
    return { started: 0, attempts: 0, admitted: null, gateCache: new Map(), ownerCache: new Map(), reinforceCalls: 0 };
  }

  function admitOnce(dp) {
    if (dp.admitted === null) {
      dp.admitted = admits(G.defenseWorkClass) === true;
      if (!dp.admitted) bump("defenseRefusedGovernor");
    }
    return dp.admitted;
  }

  function ownerAndHostility(dp, out, systemId, characterId) {
    if (!dp.ownerCache.has(systemId)) dp.ownerCache.set(systemId, ownerOfSystem(systemId));
    const owner = dp.ownerCache.get(systemId);
    if (owner === OWNER_READ_FAILED) {
      refuse(out, "WORLD_READ_FAILED", "readFailed");
      return { status: "wait", reason: "WORLD_READ_FAILED" };
    }
    const ownerKind = owner === null ? null : kindOf(owner);
    if (owner === null || !defenseKinds.includes(ownerKind)) return { status: "drop", counter: "defenseNotOwner" };
    if (G.defenseTrigger !== TRIGGER_ANY) {
      const standing = standingOf(characterId, owner);
      if (standing === null) return { status: "wait", reason: "STANDING_UNKNOWN" };
      if (relationOf(standing, ownerKind, thresholds, neutralPolicy) !== RELATION_HOSTILE) {
        return { status: "drop", counter: "defenseNotHostile" };
      }
    }
    return { status: "ok", owner, ownerKind };
  }

  function tryStartDefense(dp, ph, seam, now, out, t) {
    const read = readDefenseFleets(t.systemId, t.owner);
    if (!read || read.ok !== true) {
      refuse(out, (read && read.reason) || "READ_FAILED", "readFailed");
      return { result: "wait", fleetsLeft: 0 };
    }
    const busy = new Set([...entries.values()].map((e) => e.fleetId));
    const noProfile = t.memo.noProfile instanceof Set ? t.memo.noProfile : new Set();
    const free = read.fleets.filter((p) => !busy.has(p.fleet.fleetId) && !noProfile.has(p.fleet.fleetId));
    if (free.length === 0) return { result: "noFleet", fleetsLeft: 0 };
    let startedFleet = null;
    for (const cand of free) {
      if (dp.attempts >= G.defenseMaxAttemptsPerPass) break;
      if (spawnBackoff.blocked(cand.fleet.fleetId, now) !== null) {
        refuse(out, "SPAWN_BACKOFF", "refusedBackoff", cand.fleet.fleetId);
        continue;
      }
      dp.attempts += 1;
      bump("defenseAttempts");
      const before = { started: counters.defenseStarted, profile: counters.refusedProfile,
        budget: counters.refusedBudget, claim: counters.refusedClaim };
      if (startPatrol(ph, seam, cand.fleet, t.characterId, t.systemId, t.gates, now, out,
        { mode: MODE_CAMP, gate: t.gate, unstage: cand.unstage, trigger: t.trigger, groupId: t.groupId || null })) {
        return { result: "aborted", fleetsLeft: 0 };
      }
      if (counters.defenseStarted > before.started) {
        startedFleet = cand.fleet.fleetId;
        break;
      }
      if (counters.refusedProfile > before.profile) {
        noProfile.add(cand.fleet.fleetId);
        t.memo.noProfile = noProfile;
        bump("defenseSkippedProfile");
        continue;
      }
      if (counters.refusedBudget === before.budget && counters.refusedClaim === before.claim) break;
    }
    if (startedFleet === null) return { result: "wait", fleetsLeft: 0 };
    const left = free.filter((p) => p.fleet.fleetId !== startedFleet && !noProfile.has(p.fleet.fleetId)).length;
    return { result: "started", fleetsLeft: left };
  }

  function stepDefense(now, ph, seam, out, dp) {
    if (arrivals.size === 0) return false;
    if (!admitOnce(dp)) return false;
    const list = [...arrivals.values()].sort((a, b) => (a.at - b.at) || (a.systemId - b.systemId)
      || (a.characterId - b.characterId));
    for (const a of list) {
      if (now - a.at > G.defenseArrivalWindowMs) {
        arrivals.delete(a.key);
        bump("defenseExpired");
        continue;
      }
      if (dp.started >= G.defenseMaxNewPerPass || dp.attempts >= G.defenseMaxAttemptsPerPass
        || entries.size >= G.maxActive) continue;
      if (countIn(a.systemId) >= G.maxPerSystem) continue;
      const players = playersOf(a.systemId, seam);
      const ship = players && players.ok === true && Array.isArray(players.ships)
        ? players.ships.find((p) => p && p.characterId === a.characterId) || null : null;
      if (!ship || !ship.position) continue;
      const gates = gatesOf(a.systemId, seam, dp.gateCache);
      if (gates === null) continue;
      const gate = arrivalGateOf(gates, ship.position, G.defenseArrivalMatchMeters);
      if (gate === null) {
        arrivals.delete(a.key);
        bump("defenseNoGate");
        continue;
      }
      const oh = ownerAndHostility(dp, out, a.systemId, a.characterId);
      if (oh.status === "wait") continue;
      if (oh.status === "drop") {
        arrivals.delete(a.key);
        bump(oh.counter);
        continue;
      }
      if (countAtGate(a.systemId, gate.itemId) >= G.defenseFleetsPerGate) {
        arrivals.delete(a.key);
        bump("defenseGateFull");
        continue;
      }
      const r = tryStartDefense(dp, ph, seam, now, out, { systemId: a.systemId, characterId: a.characterId,
        owner: oh.owner, gates, gate, trigger: TRIGGER_ARRIVAL, memo: a });
      if (r.result === "aborted") return true;
      if (r.result === "noFleet") {
        arrivals.delete(a.key);
        bump("defenseNoFleet");
        if (G.defenseReinforceEnabled === true) callReinforcement(dp, ph, now, out, a, oh.owner, gates);
        continue;
      }
      if (r.result !== "started") continue;
      dp.started += 1;
      if (countAtGate(a.systemId, gate.itemId) >= G.defenseFleetsPerGate || r.fleetsLeft === 0) {
        arrivals.delete(a.key);
      }
    }
    return false;
  }

  function sentInHour(factionId, now) {
    const kept = (reinforceSent.get(factionId) || []).filter((t) => now - t < HOUR_MS);
    if (kept.length === 0) reinforceSent.delete(factionId);
    else reinforceSent.set(factionId, kept);
    return kept;
  }

  function hasCapital(fleet) {
    return capital.countOf(membersOf(fleet.fleetId, Array.isArray(fleet.composition) ? fleet.composition : [])) > 0;
  }

  function callReinforcement(dp, ph, now, out, a, owner, gates) {
    const key = `${a.systemId}:${a.characterId}`;
    for (const [k, until] of reinforceCooldown) if (until <= now) reinforceCooldown.delete(k);
    let toTarget = 0;
    for (const r of reinforcements.values()) if (r.targetSystemId === a.systemId) toTarget += 1;
    if (reinforceCooldown.has(key) || toTarget >= G.defenseReinforcePerSystem
      || reinforcements.size >= G.defenseReinforceMaxActive || dp.reinforceCalls >= G.defenseReinforceMaxPerPass
      || sentInHour(owner, now).length >= G.defenseReinforceMaxPerFactionHour) {
      refuse(out, "REINFORCE_LIMIT", "defenseReinforceLimited", key);
      return;
    }
    const neighbours = neighboursOf(gates, a.systemId);
    if (neighbours.length === 0) {
      refuse(out, "REINFORCE_NO_CANDIDATE", "defenseReinforceNoCandidate", key);
      return;
    }
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    const busy = new Set([...entries.values()].map((e) => e.fleetId));
    for (const id of reinforcements.keys()) busy.add(id);
    const read = repo && typeof repo.listFleetsInSystems === "function"
      ? tx("patrolReinforceRead", (db) => {
        const listed = repo.listFleetsInSystems(db, neighbours, { states: ["IDLE"], limitPerSystem: G.fleetScanMax });
        if (!listed || listed.ok !== true) return listed;
        return { ok: true, candidates: pickReinforcements(gates, a.systemId, listed.bySystem, { ownerFactionId: owner,
          roles: reinforceRoles, kinds: defenseKinds, excludedFactions: excluded, factionKindOf: kindOf,
          keepPerSystem: G.defenseReinforceKeepPerSystem, busy, hasCapital }) };
      })
      : { ok: false, reason: "FLEETS_UNAVAILABLE" };
    if (!read || read.ok !== true) {
      refuse(out, (read && read.reason) || "READ_FAILED", "readFailed");
      return;
    }
    if (read.candidates.length === 0) {
      refuse(out, "REINFORCE_NO_CANDIDATE", "defenseReinforceNoCandidate", key);
      return;
    }
    const c = read.candidates[0];
    const f = c.fleet;
    const chainId = PH.reinforceChainIdOf(f.fleetId, f.version);
    dp.reinforceCalls += 1;
    const r = typeof ph.approachInTx === "function"
      ? tx("patrolReinforce", (db) => ph.approachInTx(db, { chainId, fleetId: f.fleetId, expectedVersion: f.version,
        fromSystemId: c.fromSystemId, targetSystemId: a.systemId, at: clock.now(),
        constraints: { maxJumps: G.defenseReinforceMaxJumps } }))
      : { ok: false, reason: "PURSUIT_UNAVAILABLE" };
    if (!r || r.ok !== true) {
      const reason = (r && r.reason) || "REINFORCE_FAILED";
      refuse(out, reason, "defenseReinforceRefused", f.fleetId);
      logLimited(now, `garrisonPatrol: reinforce ${chainId} ${c.fromSystemId} -> ${a.systemId} refused - ${reason}`);
      return;
    }
    reinforcements.set(f.fleetId, { fleetId: f.fleetId, factionId: f.factionId, chainId, operationId: r.operationId,
      fromSystemId: c.fromSystemId, targetSystemId: a.systemId, characterId: a.characterId,
      arriveAt: Number.isFinite(r.arriveAt) ? r.arriveAt : now, sentAt: now });
    reinforceCooldown.set(key, now + G.defenseReinforceCooldownMs);
    reinforceSent.set(owner, [...sentInHour(owner, now), now]);
    bump("defenseReinforceSent");
    logLimited(now, `garrisonPatrol: reinforce ${chainId} ${c.fromSystemId} -> ${a.systemId} trigger=${a.characterId}`
      + ` arriveAt=${r.arriveAt}`);
  }

  function endReinforcement(r, name, now, why) {
    reinforcements.delete(r.fleetId);
    bump(name);
    if (name !== "defenseReinforceStarted") {
      logLimited(now, `garrisonPatrol: reinforce ${r.chainId} ${name} - ${why}`);
    }
  }

  function stepReinforcements(now, ph, seam, out, dp) {
    const due = [...reinforcements.values()].filter((r) => now >= r.arriveAt)
      .sort((a, b) => (a.arriveAt - b.arriveAt) || (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
    if (due.length === 0) return false;
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    let reads = 0;
    for (const r of due) {
      if (reads >= G.defenseReinforceMaxReadsPerPass) break;
      reads += 1;
      const over = now > r.arriveAt + G.defenseReinforceArrivalWaitMs;
      const waitOrStay = (why) => {
        if (over) endReinforcement(r, "defenseReinforceStayed", now, why);
      };
      const got = repo && typeof repo.getFleet === "function"
        ? tx("patrolReinforceFleet", (db) => repo.getFleet(db, r.fleetId)) : { ok: false, reason: "FLEETS_UNAVAILABLE" };
      if (!got || got.ok !== true) {
        refuse(out, (got && got.reason) || "READ_FAILED", "readFailed");
        if (over) endReinforcement(r, "defenseReinforceLost", now, "fleet read failed");
        continue;
      }
      const fleet = got.fleet;
      const opId = fleet ? fleet.operationId : null;
      if (!fleet || fleet.state === "DESTROYED" || fleet.state === "ENGAGED"
        || (opId !== null && opId !== undefined && opId !== r.operationId)) {
        endReinforcement(r, "defenseReinforceLost", now, fleet ? `${fleet.state} operation=${opId}` : "fleet gone");
        continue;
      }
      if (REINFORCE_EN_ROUTE.includes(fleet.state)) {
        if (over) endReinforcement(r, "defenseReinforceLost", now, `still ${fleet.state}`);
        continue;
      }
      if (fleet.state !== "IDLE" || fleet.currentSystemId !== r.targetSystemId) {
        endReinforcement(r, "defenseReinforceLost", now, `${fleet.state} in ${fleet.currentSystemId}`);
        continue;
      }
      if (!firstSeen.has(`${r.targetSystemId}:${r.characterId}`)) {
        endReinforcement(r, "defenseReinforceStayed", now, "trigger gone");
        continue;
      }
      const oh = ownerAndHostility(dp, out, r.targetSystemId, r.characterId);
      if (oh.status === "drop") {
        endReinforcement(r, "defenseReinforceStayed", now, oh.counter);
        continue;
      }
      if (oh.status === "wait" || !admitOnce(dp) || dp.started >= G.defenseMaxNewPerPass
        || dp.attempts >= G.defenseMaxAttemptsPerPass || entries.size >= G.maxActive
        || countIn(r.targetSystemId) >= G.maxPerSystem) {
        waitOrStay("limits");
        continue;
      }
      const gates = gatesOf(r.targetSystemId, seam, dp.gateCache);
      if (gates === null) {
        waitOrStay("gates not read");
        continue;
      }
      const gate = gateTowards(gates, r.fromSystemId);
      if (gate === null || countAtGate(r.targetSystemId, gate.itemId) >= G.defenseFleetsPerGate) {
        endReinforcement(r, "defenseReinforceStayed", now, gate === null ? "no arrival gate" : "gate full");
        continue;
      }
      dp.attempts += 1;
      bump("defenseAttempts");
      const before = { started: counters.defenseStarted, profile: counters.refusedProfile };
      if (startPatrol(ph, seam, fleet, r.characterId, r.targetSystemId, gates, now, out,
        { mode: MODE_CAMP, gate, unstage: false, trigger: TRIGGER_REINFORCE })) {
        return true;
      }
      if (counters.defenseStarted > before.started) {
        dp.started += 1;
        endReinforcement(r, "defenseReinforceStarted", now, "started");
      } else if (counters.refusedProfile > before.profile) {
        endReinforcement(r, "defenseReinforceStayed", now, "no profile");
      } else {
        waitOrStay("start refused");
      }
    }
    return false;
  }

  function exitDone(key, now) {
    exitMemo.set(key, { state: "done", until: now + G.defenseExitCooldownMs });
  }

  function pickRelocation(systemId, owner, gateId) {
    const list = [...entries.values()].filter((e) => e.defense !== null && e.defense !== undefined
      && e.systemId === systemId && e.factionId === owner && e.state === "LIVE" && e.phase === PHASES.CAMP_HOLD
      && (e.relocateTo === null || e.relocateTo === undefined) && (e.relocations || 0) < G.defenseMaxRelocations
      && e.campGate !== gateId);
    list.sort((a, b) => (countAtGate(b.systemId, b.campGate) - countAtGate(a.systemId, a.campGate))
      || ((a.liveSince || 0) - (b.liveSince || 0)) || (a.huntId < b.huntId ? -1 : a.huntId > b.huntId ? 1 : 0));
    return list.length > 0 ? list[0] : null;
  }

  function relocate(e, gate, point) {
    e.relocateFrom = { kind: STARGATE, itemId: e.campGate, point: e.objects[0] ? e.objects[0].point : null };
    e.relocateTo = { itemId: gate.itemId, point };
    e.relocations = (e.relocations || 0) + 1;
    e.campGate = gate.itemId;
    e.objects = [{ kind: STARGATE, itemId: gate.itemId, point }];
  }

  function restoreGate(e) {
    if (!e.relocateFrom) return;
    e.campGate = e.relocateFrom.itemId;
    e.objects = [e.relocateFrom];
    e.relocateFrom = null;
  }

  function stepExits(now, ph, seam, out, dp) {
    for (const [key, m] of [...exitMemo]) {
      if (m.state === "done" ? m.until <= now : now - m.firstAt > G.defenseArrivalWindowMs) exitMemo.delete(key);
    }
    const systems = new Set();
    for (const e of entries.values()) {
      if (e.defense !== null && e.defense !== undefined && e.state !== "ENDING") systems.add(e.systemId);
    }
    for (const a of arrivals.values()) systems.add(a.systemId);
    if (systems.size === 0) return false;
    const has = (v) => v !== null && v !== undefined;
    for (const systemId of [...systems].sort((x, y) => x - y)) {
      const players = playersOf(systemId, seam);
      if (!players || players.ok !== true || !Array.isArray(players.ships)) continue;
      const ships = players.ships.filter((p) => p && Number.isSafeInteger(p.characterId)
        && (has(p.warpTarget) || has(p.warpTargetEntityId)) && p.cloaked !== true && p.capsule !== true)
        .sort((a, b) => a.characterId - b.characterId);
      if (ships.length === 0) continue;
      const gates = gatesOf(systemId, seam, dp.gateCache);
      if (gates === null) continue;
      for (const ship of ships) {
        const gate = exitGateOf(gates, ship, G.defenseExitMatchMeters);
        if (gate === null) continue;
        const key = `${systemId}:${ship.characterId}:${gate.itemId}`;
        let memo = exitMemo.get(key);
        if (memo && memo.state === "done") continue;
        if (!memo) {
          memo = { state: "pending", firstAt: now, noProfile: new Set() };
          exitMemo.set(key, memo);
          bump("defenseExitSeen");
        }
        if (countAtGate(systemId, gate.itemId) >= 1) {
          exitDone(key, now);
          bump("defenseExitCovered");
          continue;
        }
        if (!admitOnce(dp)) return false;
        const oh = ownerAndHostility(dp, out, systemId, ship.characterId);
        if (oh.status === "wait") continue;
        if (oh.status === "drop") {
          exitDone(key, now);
          bump(oh.counter);
          continue;
        }
        const full = entries.size >= G.maxActive || countIn(systemId) >= G.maxPerSystem;
        if (!full) {
          if (dp.started >= G.defenseMaxNewPerPass || dp.attempts >= G.defenseMaxAttemptsPerPass) continue;
          const r = tryStartDefense(dp, ph, seam, now, out, { systemId, characterId: ship.characterId,
            owner: oh.owner, gates, gate, trigger: TRIGGER_EXIT, memo });
          if (r.result === "aborted") return true;
          if (r.result === "wait") continue;
          if (r.result === "started") {
            dp.started += 1;
            exitDone(key, now);
            bump("defenseExitStarted");
            continue;
          }
        }
        const e = pickRelocation(systemId, oh.owner, gate.itemId);
        const point = e ? campPoint(gate, G.campStandoffMeters) : null;
        if (e === null || point === null) {
          exitDone(key, now);
          bump("defenseExitNoFleet");
          continue;
        }
        relocate(e, gate, point);
        exitDone(key, now);
        bump("defenseRelocated");
      }
    }
    return false;
  }

  function lneDefenseWork() {
    if (firstSeen.size === 0) return [];
    const bySystem = lneOfPass();
    if (pass.lneOk) {
      const live = new Set();
      for (const [systemId, list] of bySystem) {
        for (const x of list) if (x.groupId !== null) live.add(`${systemId}:${x.groupId}`);
      }
      for (const key of [...lneMemo.keys()]) if (!live.has(key)) lneMemo.delete(key);
    }
    const playerOf = new Map();
    for (const key of firstSeen.keys()) {
      const [systemId, characterId] = key.split(":").map(Number);
      if (!playerOf.has(systemId) || characterId < playerOf.get(systemId)) playerOf.set(systemId, characterId);
    }
    const work = [];
    for (const [systemId, characterId] of playerOf) {
      const groups = new Map();
      for (const x of bySystem.get(systemId) || []) {
        if (x.groupId === null) continue;
        if (!groups.has(x.groupId)) {
          groups.set(x.groupId, { systemId, characterId, groupId: x.groupId, factionId: x.factionId, ids: [] });
        }
        groups.get(x.groupId).ids.push(x.entityId);
      }
      work.push(...groups.values());
    }
    return work.sort((a, b) => (a.systemId - b.systemId)
      || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0));
  }

  function stepLneDefense(now, ph, seam, out, dp) {
    const work = lneDefenseWork();
    const done = (key) => lneMemo.set(key, { state: "done" });
    for (const g of work) {
      const key = `${g.systemId}:${g.groupId}`;
      let memo = lneMemo.get(key);
      if (memo && memo.state === "done") continue;
      if (memo && now - memo.firstAt > G.defenseArrivalWindowMs) {
        done(key);
        bump("defenseLneExpired");
        continue;
      }
      if (!dp.ownerCache.has(g.systemId)) dp.ownerCache.set(g.systemId, ownerOfSystem(g.systemId));
      const owner = dp.ownerCache.get(g.systemId);
      if (owner === OWNER_READ_FAILED) {
        refuse(out, "WORLD_READ_FAILED", "readFailed");
        continue;
      }
      if (owner === null || !defenseKinds.includes(kindOf(owner)) || excluded.includes(owner)
        || !isEnemy(owner, g.factionId)) {
        done(key);
        continue;
      }
      if (!memo) {
        memo = { state: "pending", firstAt: now, noProfile: new Set(), noGate: false };
        lneMemo.set(key, memo);
        bump("defenseLneSeen");
      }
      if (!admitOnce(dp)) return false;
      const pos = lnePositions(g.systemId, seam);
      let lead = null;
      for (const id of [...g.ids].sort((a, b) => a - b)) {
        const p = pos.get(id);
        if (p && p.inWarp !== true) {
          lead = p;
          break;
        }
      }
      if (lead === null) continue;
      const gates = gatesOf(g.systemId, seam, dp.gateCache);
      if (gates === null) continue;
      const gate = arrivalGateOf(gates, lead.position, G.defenseLneMatchMeters);
      if (gate === null) {
        if (!memo.noGate) {
          memo.noGate = true;
          bump("defenseLneNoGate");
        }
        continue;
      }
      if (countAtGate(g.systemId, gate.itemId) >= 1) {
        done(key);
        bump("defenseLneCovered");
        continue;
      }
      const full = entries.size >= G.maxActive || countIn(g.systemId) >= G.maxPerSystem;
      if (!full) {
        if (dp.started >= G.defenseMaxNewPerPass || dp.attempts >= G.defenseMaxAttemptsPerPass) continue;
        const r = tryStartDefense(dp, ph, seam, now, out, { systemId: g.systemId, characterId: g.characterId, owner,
          gates, gate, trigger: TRIGGER_LNE, memo, groupId: g.groupId });
        if (r.result === "aborted") return true;
        if (r.result === "wait") continue;
        if (r.result === "started") {
          dp.started += 1;
          done(key);
          bump("defenseLneStarted");
          continue;
        }
      }
      const e = pickRelocation(g.systemId, owner, gate.itemId);
      const point = e ? campPoint(gate, G.campStandoffMeters) : null;
      if (e === null || point === null) {
        done(key);
        bump("defenseLneNoFleet");
        continue;
      }
      relocate(e, gate, point);
      done(key);
      bump("defenseLneRelocated");
    }
    return false;
  }

  function countIn(systemId, mode) {
    let n = 0;
    for (const e of entries.values()) if (e.systemId === systemId && (mode === undefined || e.mode === mode)) n += 1;
    return n;
  }

  function readFleets(systemId) {
    const fleets = safeCall(getFleets);
    const repo = fleets && fleets.repository;
    if (!repo || typeof repo.listFleetsInSystem !== "function") return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    return tx("patrolRead", (db) => {
      const listed = repo.listFleetsInSystem(db, systemId, { states: ["IDLE"], limit: G.fleetScanMax });
      if (!listed || listed.ok !== true) return listed;
      return { ok: true, fleets: pickPatrolFleets(listed.fleets, { roles, maxShips: G.maxShipsPerFleet,
        excludedFactions: excluded, factionKindOf: kindOf }) };
    });
  }

  function ownFleetsOf(systemId, fleets, out) {
    if (fleets.every((f) => f.homeSystemId === systemId)) return fleets;
    const owner = ownerOfSystem(systemId);
    if (owner === OWNER_READ_FAILED) {
      refuse(out, "WORLD_READ_FAILED", "readFailed");
      return null;
    }
    const kept = [];
    for (const f of fleets) {
      if (f.homeSystemId === systemId || (owner !== null && f.factionId === owner)) kept.push(f);
      else refuse(out, "FOREIGN_SYSTEM", "refusedForeignSystem", `${f.fleetId} faction=${f.factionId} owner=${owner}`);
    }
    return kept;
  }

  function graphOf() {
    const g = safeCall(getGraph);
    const r = g && typeof g.getGraph === "function" ? safeCall(() => g.getGraph()) : null;
    return r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
  }

  function systemInfo(graph, id) {
    const v = safeCall(() => graph.getSystem(id));
    return v ? { secClass: v.secClass, factionId: v.factionId === undefined ? null : v.factionId } : null;
  }

  function campGateOf(gates, systemId, fleetSeed, triggerPos) {
    const graph = graphOf();
    const here = graph ? systemInfo(graph, systemId) : null;
    const policy = graph && here ? G.campGatePolicy : POLICY_RANDOM;
    return pickCampGate(gates, { policy, here: here || { secClass: null, factionId: null },
      systemOf: (id) => (graph ? systemInfo(graph, id) : null), triggerPos, gridRadiusMeters: G.gridRadiusMeters },
    fleetSeed);
  }

  function seatsOf(e, members) {
    const crews = crewsOf();
    const seats = new Map();
    if (!crews) {
      bump("crewFallback");
      return seats;
    }
    const r = tx("patrolSeats", (db) => {
      const got = crews.seatsForMaterializationInTx(db, { fleetId: e.fleetId, at: clock.now(),
        members: members.map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId })) });
      if (!got || got.ok !== true) throw new StepError((got && got.reason) || "SEATS_REFUSED");
      return got;
    });
    if (!r || r.ok !== true || !Array.isArray(r.seats)) {
      bump("crewFallback");
      logLimited(clock.now(), `garrisonPatrol: ${e.huntId} crews seats refused - ${(r && (r.detail || r.reason))
        || "no result"} (no owner)`);
      return seats;
    }
    for (const s of r.seats) {
      if (s && typeof s.memberKey === "string") seats.set(s.memberKey, { ownerId: s.ownerId, characterId: s.characterId });
    }
    if (seats.size < members.length) bump("crewFallback");
    return seats;
  }

  function spawnAndGoLive(e, members, profiles, ph, now, anchorPoint, seats) {
    const anchor = { kind: "coordinates", position: { ...anchorPoint } };
    const owned = new Set();
    for (const other of entries.values()) if (other !== e) for (const id of idsOf(other)) owned.add(id);
    for (let i = 0; i < members.length; i += 1) {
      const seat = seats.get(members[i].memberKey);
      const ownerId = seat && Number.isSafeInteger(seat.ownerId) && seat.ownerId > 0 ? seat.ownerId : null;
      const spread = capital.isCapital(members[i].hullGroup) && capital.distanceMeters !== null
        ? capital.distanceMeters : G.landingSpreadMeters;
      const r = npcSpawn.spawnShip(e.systemId, { profileId: profiles[i], anchorDescriptor: anchor,
        spawnDistanceMeters: spread, behavior: "search", keepMaterialized: true,
        ...(ownerId !== null ? { ownerId } : {}) });
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
    const live = tx("patrolLive", (db) => ph.markLiveInTx(db, { huntId: e.huntId, expectedVersion: e.version,
      at: clock.now() }));
    if (!live || live.ok !== true) throw new StepError((live && live.reason) || "LIVE_FAILED", live && live.detail);
    e.state = "LIVE";
    if (Number.isSafeInteger(live.version)) e.version = live.version;
    e.liveSince = now;
    e.phase = e.mode === MODE_CAMP ? PHASES.CAMP_HOLD : PHASES.PATROL_DWELL;
    e.phaseSince = now;
    e.warpSeen = false;
    e.alive = e.spawned.length;
    lossTracker.track(e.huntId, e.spawned);
  }

  function startPatrol(ph, seam, fleet, characterId, systemId, objects, now, out, defense) {
    if (spawnBackoff.blocked(fleet.fleetId, now) !== null) {
      refuse(out, "SPAWN_BACKOFF", "refusedBackoff", fleet.fleetId);
      return false;
    }
    const def = defense && typeof defense === "object" ? defense : null;
    const huntId = PH.huntIdOf(fleet.fleetId, fleet.version);
    const all = membersOf(fleet.fleetId, fleet.composition);
    const trimmed = all.length > G.maxShipsPerFleet;
    const members = trimmed ? pickDetachment(all, G.maxShipsPerFleet) : all;
    const fleetSeed = deriveSeed(worldSeed, "garrisonPatrol", fleet.fleetId);
    const gates = objects.filter((o) => o.kind === STARGATE);
    const routeObjects = objects.filter((o) => objectKinds.includes(o.kind));
    let mode = def ? def.mode : chooseMode({ fleetSeed, kind: kindOf(fleet.factionId), gates,
      campsInSystem: countIn(systemId, MODE_CAMP) }, { campPermille, maxCampsPerSystem: G.maxCampsPerSystem });
    let gate = def ? def.gate : null;
    let triggerPos;
    const triggerPosOf = () => {
      if (triggerPos !== undefined) return triggerPos;
      const players = playersOf(systemId, seam);
      const ship = players && players.ok === true && Array.isArray(players.ships)
        ? players.ships.find((p) => p && p.characterId === characterId) || null : null;
      triggerPos = ship && ship.position ? ship.position : null;
      return triggerPos;
    };
    if (def) {
      if (!gate || campPoint(gate, G.campStandoffMeters) === null) {
        refuse(out, "NO_OBJECTS", "refusedObjects", fleet.fleetId);
        return false;
      }
    } else if (mode === MODE_CAMP) {
      gate = campGateOf(gates, systemId, fleetSeed, triggerPosOf());
      if (gate === null || campPoint(gate, G.campStandoffMeters) === null) mode = MODE_PATROL;
    }
    if (mode === MODE_PATROL && routeObjects.length === 0) {
      refuse(out, "NO_OBJECTS", "refusedObjects", fleet.fleetId);
      return false;
    }
    const profiles = npcSpawn.resolveProfiles(members.map((m) => ({ memberKey: m.memberKey,
      factionId: fleet.factionId, hullGroup: m.hullGroup, typeId: m.typeId })), { seedPrefix: huntId });
    if (!profiles || profiles.ok !== true) {
      capital.noteRefused(profiles, `patrol ${fleet.fleetId}`);
      refuse(out, (profiles && profiles.reason) || "NO_PROFILE", "refusedProfile", fleet.fleetId);
      return false;
    }
    const scene = sceneRefusalOf(npcSpawn, systemId, members.length, SCENE_SOURCE);
    if (scene !== null) {
      refuse(out, scene, "refusedBudget", fleet.fleetId);
      return false;
    }
    const reservationId = `mat:gpatrol:${huntId}`;
    const reserved = budget.reserve({ reservationId, ownerKind: "fleet", ownerId: fleet.fleetId, systemId,
      shipCount: capital.slotsOf(members), metadata: { systemId } });
    if (!reserved || reserved.ok !== true) {
      refuse(out, (reserved && reserved.reason) || "BUDGET", "refusedBudget", fleet.fleetId);
      return false;
    }
    const standing = standingOf(characterId, fleet.factionId);
    const ownSystem = lneOn && ownerOfSystem(systemId) === fleet.factionId;
    const claimed = tx("patrolClaim", (db) => {
      const c = ph.claimInTx(db, { fleetId: fleet.fleetId, expectedVersion: fleet.version, characterId, systemId,
        mode, standing: standing === null ? 0 : standing, at: clock.now(),
        ...(def && def.unstage === true ? { unstage: true } : {}),
        ...(trimmed ? { maxMembers: members.length } : {}) });
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
    const e = { huntId: claimed.huntId, fleetId: fleet.fleetId, factionId: fleet.factionId, characterId, systemId,
      mode, state: "SPAWNING", version: claimed.version, reservationId, spawned: [], objects: [], objectIndex: 0,
      phase: mode === MODE_CAMP ? PHASES.CAMP_HOLD : PHASES.PATROL_DWELL, phaseSince: now, liveSince: null,
      absentSince: null, noTargetSince: null, warpSeen: false, spawnConfirmed: false, alive: 0,
      targetOf: new Map(), aggressors: new Set(), aggressorOf: new Map(), campGate: gate ? gate.itemId : null,
      despawned: false, endReason: null, lostKeys: new Set(), seatOf: new Map(),
      heldBack: all.length - members.length,
      capitalIds: new Set(),
      defense: def ? def.trigger : null,
      relocations: 0, relocateTo: null, relocateFrom: null,
      ownSystem, lneSeen: new Set() };
    entries.set(e.huntId, e);
    if (mode === MODE_CAMP) {
      e.objects = [{ kind: STARGATE, itemId: gate.itemId, point: campPoint(gate, G.campStandoffMeters) }];
    } else {
      const seed = Number.isSafeInteger(claimed.seed) ? claimed.seed : 0;
      const mapped = patrolRoute(routeObjects, objectKinds, seed).map((o) => ({ kind: o.kind, itemId: o.itemId,
        point: o.kind === STARGATE ? campPoint(o, G.campStandoffMeters) : standoffPoint(o, G.objectClearanceMeters) }))
        .filter((o) => o.point !== null);
      e.objects = rotateToNearest(mapped, triggerPosOf()).slice(0, G.maxRouteObjects);
    }
    if (typeof hooks.afterPatrolClaim === "function" && hooks.afterPatrolClaim(e.huntId) === false) return true;
    try {
      if (e.objects.length === 0) throw new StepError("NO_OBJECTS");
      if (trimmed && !sameMembers(claimed.members, members)) throw new StepError("MEMBERS_MISMATCH");
      const seats = seatsOf(e, members);
      for (const [memberKey, s] of seats) if (Number.isSafeInteger(s.characterId)) e.seatOf.set(memberKey, s.characterId);
      spawnAndGoLive(e, members, profiles.profiles, ph, now, e.objects[0].point, seats);
    } catch (err) {
      const reason = err instanceof StepError ? err.reason : "SPAWN_THREW";
      const detail = err instanceof StepError ? err.detail : messageOf(err);
      const held = isSceneRefusal(reason) ? { first: true, failures: 0, retryAt: now }
        : spawnBackoff.note(fleet.fleetId, failureReasonOf(reason, detail), now);
      if (held.first) {
        logLimited(now, `garrisonPatrol: ${e.huntId} rolled back - ${reason}${detail ? ` ${detail}` : ""}`
          + `${held.failures > 0 ? ` backoff=${held.retryAt - now}ms failures=${held.failures}` : ""}`);
      }
      refuse(out, reason, "spawnFailed", detail);
      endPatrol(e, SPAWN_FAILED, now, out);
      return false;
    }
    spawnBackoff.clear(fleet.fleetId);
    bump("started");
    capital.noteSpawned(capital.countOf(members));
    bump(mode === MODE_CAMP ? "startedCamp" : "startedPatrol");
    if (def) {
      bump("defenseStarted");
      if (claimed.unstaged === true) bump("defenseUnstaged");
      logLimited(now, `garrisonPatrol: ${e.huntId} defense ${def.trigger} gate=${gate.itemId}`
        + `${def.groupId ? ` group=${def.groupId}` : ""} system=${systemId}`
        + ` trigger=${characterId} ships=${e.spawned.length} unstaged=${claimed.unstaged === true ? 1 : 0}`);
      return false;
    }
    logLimited(now, `garrisonPatrol: ${e.huntId} live in ${systemId} mode=${mode} trigger=${characterId}`
      + ` ships=${e.spawned.length}${trimmed ? `/${all.length}` : ""} objects=${e.objects.length}`
      + `${gate ? ` gate=${gate.itemId}` : ""}`);
    return false;
  }

  function stepNew(now, presence, out) {
    if (G.enabled !== true) return false;
    const defenseOn = G.defenseEnabled === true;
    let systems = defenseOn ? observeArrivals(now, presence) : null;
    if (!lossImportOn) {
      logOnce("lossImport", "garrisonPatrol: no new patrols - battle.liveLossImport off");
      return false;
    }
    const ph = playerHunt();
    if (!ph) {
      logOnce("playerHunt", "garrisonPatrol: no new patrols - ctx.playerHunt not running");
      return false;
    }
    const seam = safeCall(getHuntScene);
    if (!seam) {
      logOnce("seam", "garrisonPatrol: no new patrols - hunt scene seam unavailable");
      return false;
    }
    if (defenseOn) {
      beginPass(now);
      const dp = newDefensePass();
      if (G.defenseReinforceEnabled === true && reinforcements.size > 0
        && stepReinforcements(now, ph, seam, out, dp)) return true;
      if (stepDefense(now, ph, seam, out, dp)) return true;
      if (G.defenseExitEnabled === true && stepExits(now, ph, seam, out, dp)) return true;
      if (G.defenseLneEnabled === true && lneOn && stepLneDefense(now, ph, seam, out, dp)) return true;
    }
    if (!admits(WORK_CLASS_NEW)) {
      refuse(out, "GOVERNOR", "refusedGovernor");
      return false;
    }
    beginPass(now);
    if (systems === null) systems = observeArrivals(now, presence);
    let started = 0;
    let scanned = 0;
    for (const s of systems) {
      if (started >= G.maxNewPerPass || entries.size >= G.maxActive || scanned >= G.maxSystemsPerPass) break;
      if (countIn(s.systemId) >= G.maxPerSystem) continue;
      if (nextScanAt.has(s.systemId) && nextScanAt.get(s.systemId) > now) continue;
      const characters = [];
      for (const [key, at] of firstSeen) {
        const [sys, chr] = key.split(":").map(Number);
        if (sys === s.systemId && now - at >= G.startDelayMs) characters.push(chr);
      }
      if (characters.length === 0) continue;
      characters.sort((a, b) => a - b);
      cursor = s.systemId;
      scanned += 1;
      nextScanAt.set(s.systemId, now + G.scanIntervalMs);
      bump("scans");
      const read = readFleets(s.systemId);
      if (!read || read.ok !== true) {
        refuse(out, (read && read.reason) || "READ_FAILED", "readFailed");
        continue;
      }
      if (read.fleets.length === 0) continue;
      const owned = ownFleetsOf(s.systemId, read.fleets, out);
      if (owned === null || owned.length === 0) continue;
      const own = owned.filter((f) => {
        if (spawnBackoff.blocked(f.fleetId, now) === null) return true;
        refuse(out, "SPAWN_BACKOFF", "refusedBackoff", f.fleetId);
        return false;
      });
      if (own.length === 0) continue;
      let listed;
      try {
        listed = seam.listSystemObjects(s.systemId, listKinds);
      } catch (err) {
        listed = { ok: false, reason: "LIST_THREW", detail: messageOf(err) };
      }
      if (!listed || listed.ok !== true || !Array.isArray(listed.objects)) {
        refuse(out, (listed && listed.reason) || "NO_OBJECTS", "refusedObjects");
        continue;
      }
      let tried = 0;
      for (const fleet of own) {
        if (started >= G.maxNewPerPass || entries.size >= G.maxActive || countIn(s.systemId) >= G.maxPerSystem) break;
        started += 1;
        tried += 1;
        if (startPatrol(ph, seam, fleet, characters[0], s.systemId, listed.objects, now, out)) return true;
      }
      if (tried < own.length && countIn(s.systemId) < G.maxPerSystem) nextScanAt.delete(s.systemId);
    }
    return false;
  }

  function step(now, presence, out, retargetsLeft) {
    if (stopped) return { retargets: 0, aborted: false };
    const t0 = nowMs();
    try {
      const retargets = stepPatrols(now, presence, out, retargetsLeft);
      const aborted = stepNew(now, presence, out);
      return { retargets, aborted };
    } finally {
      if (entries.size > 0 || counters.started > 0) {
        gauge("garrisonPatrol.active", entries.size);
        gauge("garrisonPatrol.ships", shipsOut());
        observe("garrisonPatrol.stepMs", nowMs() - t0);
      }
    }
  }

  function getStatus() {
    const list = [...entries.values()].map((e) => ({ huntId: e.huntId, systemId: e.systemId, fleetId: e.fleetId,
      factionId: e.factionId, characterId: e.characterId, mode: e.mode, state: e.state, phase: e.phase,
      phaseSince: e.phaseSince, objectIndex: e.objectIndex, objects: e.objects.length, campGate: e.campGate,
      ships: e.spawned.length, alive: e.despawned ? 0 : e.alive, liveSince: e.liveSince,
      aggressors: e.aggressors.size, despawned: e.despawned, endReason: e.endReason, defense: e.defense || null,
      relocations: e.relocations || 0, relocateTo: e.relocateTo ? e.relocateTo.itemId : null,
      object: currentObjectOf(e) }));
    return {
      state: stopped ? "stopped" : "running",
      enabled: G.enabled === true,
      lossImport: lossImportOn ? "on" : "off",
      active: entries.size,
      ships: shipsOut(),
      list,
      noticed: firstSeen.size,
      arrivals: arrivals.size,
      exits: exitMemo.size,
      lneDefense: lneMemo.size,
      reinforcements: reinforcements.size,
      counters: { ...counters },
      lastRefusal,
      lossTracker: lossTracker.sizes(),
    };
  }

  function stop() {
    stopped = true;
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
        aggressors: e.aggressors, primaryCharacterId: null, groupId: e.huntId });
    }
    return out;
  }

  return Object.freeze({ stepPending, step, getStatus, stop, addLiveLosses, relationGroups });
}

module.exports = { createGarrisonStep, COUNTER_NAMES, GARRISON_STEP_METHODS };
