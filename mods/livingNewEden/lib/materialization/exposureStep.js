"use strict";

const R = require("../fleetExposure/rules");
const { evacuationPending } = require("../adapter/civilianAlert");
const { exposureIdOf } = require("../fleetExposure/schema");
const { parseHullGroupList } = require("../fleets/schema");
const { createYieldingBudget } = require("./yieldingBudget");
const { planCarrierLoot } = require("../fleetExposure/cargoLoot");
const { createConvoyAmbush } = require("./convoyAmbush");
const F = require("../fleetExposure/factionEscortRules");
const { createConvoyEscort } = require("./convoyEscort");
const { createSpawnBackoff, failureReasonOf } = require("./spawnBackoff");
const { isSceneRefusal } = require("./sceneBudget");
const { planBeams, applyBeams, followMetersOf } = require("../util/miningBeamPlan");

const COUNTER_NAMES = Object.freeze(["scans", "scanRefused", "startedConvoy", "startedMiner", "refusedGovernor",
  "refusedBudget", "refusedProfile", "refusedNoGate", "refusedCooldown", "spawnFailed",
  "transitDone", "despawned", "claimed", "claimFailed", "lossImported", "lossDropped", "exited", "ended", "endFailed",
  "wiped", "exposureTrimmed", "profileFallback", "anchorFallback", "refusedMaxVisible", "preempted", "preemptedShips",
  "cargoSeeded", "cargoSeedUnits", "cargoSeedFailed", "cargoLootHullSkipped", "cargoLootNoMinerals",
  "cargoLootUnrecorded",
  "convoyMarkFailed", "convoyAttackCharged", "convoyAttackRefused",
  "escortCrossings", "escortRefused", "escortTrackFull",
  "ambushRolled", "ambushStarted", "ambushNoFaction", "ambushNoGate", "ambushNoProfile", "ambushSpawnFailed",
  "ambushRefusedBudget", "ambushRefusedGovernor", "ambushEngaged", "ambushEngageFailed", "ambushRetargeted",
  "ambushCleared", "ambushCarriersLost",
  "factionEscortShips", "factionEscortTrimmed", "factionEscortNoProfile", "factionEscortWakes", "factionEscortOrders",
  "factionEscortOrderFailed", "factionEscortLost", "factionEscortTargetsFull",
  "refusedBackoff", "ambushRefusedBackoff",
  "minerBeamRefresh", "minerBeamFx", "minerBeamBudgetCut", "minerBeamNoRock",
  "minerBeamApproachOrders", "minerBeamApproaching", "minerBeamApproachBusy", "minerBeamApproachRefused",
  "minerBeamApproachReleased"]);

const WORK_CLASS_NEW = "OPERATIONAL";
const CONVOY = "CONVOY";
const MINER = "MINER";
const MINING_BEAM_REFRESH_MS = 30000;
const MINING_VIEW_DISTANCE_SQ = 150000 ** 2;
const PHASE = Object.freeze({ VISIBLE: "VISIBLE", HELD: "HELD", EXITING: "EXITING", ENDING: "ENDING" });
const ESCORT_CREDIT_ENDS = Object.freeze(["TRANSIT_DONE", "QUIET"]);
const PERMANENT_END = Object.freeze(["EXPOSURE_NOT_FOUND", "FLEET_NOT_FOUND", "FLEET_NOT_MATERIALIZED",
  "FLEET_EXPOSURE_INVALID_INPUT"]);
const FLEET_METHODS = Object.freeze(["getFleet", "getFleets", "listFleetsInSystems", "getOperation"]);
const MINING_TYPE = "mining";
const MINING_OBJECTIVE = "mine";
const CONVOY_ROLE = "logistics";
const MINER_ROLE = "mining";
const RECENT_ENDS_SHOWN = 20;
const MAX_DETAIL = 120;
const MINUTE_MS = 60000;
const LOG_LINES_PER_MIN = 10;
const FALLBACK_FACTION_ID = 500014;
const FALLBACK_HULL = Object.freeze({ [CONVOY]: "industrial", [MINER]: "mining_barge" });
const MINER_ANCHOR_KINDS = Object.freeze(["asteroidBelt", "planet", "sun", "station", "stargate"]);
const CONVOY_ANCHOR_KINDS = Object.freeze(["stargate", "station", "sun"]);
const PERMANENT_CLAIM = Object.freeze(["EXPOSURE_OPEN", "FLEET_EXPOSURE_INVALID_INPUT", "FLEET_NOT_EXPOSABLE",
  "FLEET_NOT_FOUND", "HALT_ALREADY_APPLIED", "LOCK_ALREADY_APPLIED"]);
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

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

class StepError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = String(reason);
    this.detail = detail === undefined || detail === null ? null : String(detail).slice(0, MAX_DETAIL);
  }
}

function createExposureStep(deps) {
  const { store, clock, npcSpawn, budget, lossTracker } = deps;
  const S = deps.settings;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const getFleetExposure = typeof deps.getFleetExposure === "function" ? deps.getFleetExposure : () => null;
  const getLogistics = typeof deps.getLogistics === "function" ? deps.getLogistics : () => null;
  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
  const getHuntScene = typeof deps.getHuntScene === "function" ? deps.getHuntScene : () => null;
  const getBeltNavyScene = typeof deps.getBeltNavyScene === "function" ? deps.getBeltNavyScene : () => null;
  const getStandings = typeof deps.getStandings === "function" ? deps.getStandings : () => null;
  const getFrontJobs = typeof deps.getFrontJobs === "function" ? deps.getFrontJobs : () => null;
  const escortOn = deps.escortEnabled === true;
  const despawnAll = deps.despawnAll;
  const admits = typeof deps.admits === "function" ? deps.admits : () => true;
  const lossImportOn = deps.lossImportOn === true;
  const industry = deps.industryProfiles === true;
  const worldSeed = deps.worldSeed;
  const spawnBackoff = deps.spawnBackoff && typeof deps.spawnBackoff.blocked === "function" ? deps.spawnBackoff
    : createSpawnBackoff(null);
  const P = { exitGraceMs: deps.exitGraceMs, maxHeldMs: S.maxHeldMs, holdQuietMs: S.holdQuietMs,
    exitWarpMaxMs: S.exitWarpMaxMs, transitMinRemainingMs: S.transitMinRemainingMs,
    transitEndMarginMs: S.transitEndMarginMs };
  const hullGroups = { [CONVOY]: parseHullGroupList(S.convoyHullGroups) || [],
    [MINER]: parseHullGroupList(S.minerHullGroups) || [] };
  const cargoGroups = Array.isArray(deps.cargoCarrierGroups)
    ? hullGroups[CONVOY].filter((g) => deps.cargoCarrierGroups.includes(g)) : hullGroups[CONVOY];
  const escortsOn = S.convoyEscortsEnabled === true;
  const escortGroups = escortsOn ? F.escortGroupsOf(S) : [];
  const exposeGroups = { [CONVOY]: F.exposeGroupsOf(hullGroups[CONVOY], escortGroups, escortsOn),
    [MINER]: hullGroups[MINER] };
  const warpSpread = Math.min(S.spawnDistanceMeters, Math.floor(R.EXIT_LAND_METERS / 2));

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const entries = new Map();
  const cooldown = new Map();
  const crossingsDone = new Map();
  const crossingKeyOf = (x) => `${x.legSeq}:${x.systemIndex}`;
  const recentEnds = [];
  let cursor = 0;
  let convoyCursor = null;
  let lastScanAt = null;
  let lastRefusal = null;
  let stopped = false;
  const loggedOnce = new Set();
  let errorWindow = -Infinity;
  let errorLines = 0;
  let pass = { at: null, players: new Map() };
  let minerFxLeft = 0;
  const ambushOn = S.ambushEnabled === true;
  const ambush = createConvoyAmbush({ npcSpawn, budget, settings: S, worldSeed, admits,
    secClassOf: deps.secClassOf, pirateFactionOf: deps.pirateFactionOf, carrierGroups: hullGroups[CONVOY],
    bump, logLimited, spawnDistanceOf, despawnAll: (systemId, ids) => despawnAll(systemId, ids),
    spawnBackoff: deps.ambushSpawnBackoff || null });
  const escort = createConvoyEscort({ settings: S, escortGroups, ambush, bump, logLimited });

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`fleetExposure.${name}`, n);
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
    const key = `exposure:${reason}`;
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

  function logistics() {
    const l = safeCall(getLogistics);
    return l && typeof l.listInTransitInTx === "function" ? l : null;
  }

  const liveIdsOf = (e) => e.members.filter((m) => !m.destroyed && !e.pendingDestroyed.includes(m.memberKey))
    .map((m) => m.entityId);
  const allIdsOf = (e) => e.members.map((m) => m.entityId);

  function despawnAndRelease(e) {
    if (e.despawned) return;
    if (e.kind === CONVOY && typeof npcSpawn.forgetConvoyShips === "function") {
      safeCall(() => npcSpawn.forgetConvoyShips(allIdsOf(e)));
    }
    despawnAll(e.systemId, [...allIdsOf(e), ...ambush.idsOf(e)]);
    budget.release(e.reservationId);
    ambush.release(e);
    e.despawned = true;
  }

  function forget(e) {
    entries.delete(e.key);
    lossTracker.untrack(e.key);
  }

  function noteEnd(e, now, reason, outcome, losses) {
    recentEnds.push({ fleetId: e.fleetId, kind: e.kind, systemId: e.systemId, exposureId: e.exposureId, reason,
      outcome, losses, at: now });
    if (recentEnds.length > RECENT_ENDS_SHOWN) recentEnds.splice(0, recentEnds.length - RECENT_ENDS_SHOWN);
  }

  function hasIntactCarrier(e) {
    return e.members.some((m) => !m.destroyed && hullGroups[CONVOY].includes(m.hullGroup)
      && !e.lossQueue.includes(m.memberKey) && !e.pendingDestroyed.includes(m.memberKey));
  }

  function creditEscort(e, now, reason) {
    if (!e.escort || e.escort.credited) return;
    if (!ESCORT_CREDIT_ENDS.includes(reason) || !hasIntactCarrier(e)) return;
    e.escort.credited = true;
    if (e.escort.aggressorsFull) return;
    const { samples, aggressors, aggressorShips, shipOf } = e.escort;
    const characterIds = [...samples.entries()]
      .filter(([id, n]) => n >= S.escortMinSamples && !aggressors.has(id) && id !== e.characterId
        && !aggressorShips.has(shipOf.get(id)))
      .map(([id]) => id).sort((a, b) => a - b).slice(0, S.escortMaxCharactersPerCrossing);
    if (characterIds.length === 0) return;
    bump("escortCrossings");
    const jobs = safeCall(getFrontJobs);
    const r = jobs && typeof jobs.onEscortCrossing === "function" ? safeCall(() => jobs.onEscortCrossing({
      ownerFactionId: e.factionId, systemId: e.systemId, characterIds, atMs: now })) : null;
    if (!r || r.ok !== true) bump("escortRefused");
  }

  function noteAggressor(e, set, id) {
    if (!e.escort || !Number.isSafeInteger(id) || id <= 0 || set.has(id)) return;
    if (e.escort.aggressors.size + e.escort.aggressorShips.size >= S.escortMaxTracked) {
      if (!e.escort.aggressorsFull) bump("escortTrackFull");
      e.escort.aggressorsFull = true;
      return;
    }
    set.add(id);
  }

  function sampleEscort(e, facts, seam) {
    if (!e.escort || e.escort.credited || facts.sceneLoaded !== true) return;
    const { samples, aggressors, aggressorShips } = e.escort;
    for (const a of facts.aggressors) {
      if (a.aggressorKind !== "player" && a.aggressorKind !== "gone") continue;
      const ch = facts.playerChar.get(a.aggressorId);
      if (Number.isSafeInteger(ch)) noteAggressor(e, aggressors, ch);
      else noteAggressor(e, aggressorShips, a.aggressorId);
    }
    noteAggressor(e, aggressors, e.characterId);
    if (facts.alive.length === 0) return;
    const players = playersOf(e.systemId, seam);
    if (!players || players.ok !== true || !Array.isArray(players.ships)) return;
    const seen = new Set();
    for (const p of players.ships) {
      const ch = p && p.characterId;
      if (!Number.isSafeInteger(ch) || ch <= 0 || seen.has(ch) || aggressors.has(ch) || !p.position) continue;
      if (aggressorShips.has(p.entityId)) {
        noteAggressor(e, aggressors, ch);
        continue;
      }
      if (!inEscortRange(facts, p.position)) continue;
      if (!samples.has(ch) && samples.size >= S.escortMaxTracked) {
        bump("escortTrackFull");
        continue;
      }
      seen.add(ch);
      samples.set(ch, (samples.get(ch) || 0) + 1);
      e.escort.shipOf.set(ch, p.entityId);
    }
  }

  function inEscortRange(facts, position) {
    const rangeSq = S.escortRangeMeters * S.escortRangeMeters;
    return facts.alive.some((s) => s.position && distanceSq(s.position, position) <= rangeSq);
  }

  function nearCharactersOf(e, facts, seam) {
    if (facts.sceneLoaded !== true || facts.alive.length === 0) return 0;
    const players = playersOf(e.systemId, seam);
    if (!players || players.ok !== true || !Array.isArray(players.ships)) return 0;
    const esc = e.escort;
    const seen = new Set();
    for (const p of players.ships) {
      const ch = p && p.characterId;
      if (!Number.isSafeInteger(ch) || ch <= 0 || seen.has(ch) || !p.position) continue;
      if (esc && (esc.aggressors.has(ch) || esc.aggressorShips.has(p.entityId))) continue;
      if (inEscortRange(facts, p.position)) seen.add(ch);
    }
    return seen.size;
  }

  function despawnVisible(e, reason, now) {
    creditEscort(e, now, reason);
    despawnAndRelease(e);
    forget(e);
    if (reason === "TRANSIT_DONE" && e.kind === CONVOY && e.crossing) {
      crossingsDone.set(e.fleetId, { key: crossingKeyOf(e.crossing), until: e.crossing.windowEnd });
    }
    bump(reason === "TRANSIT_DONE" ? "transitDone" : "despawned");
    noteEnd(e, now, reason, "DESPAWNED", 0);
  }

  function tryEnd(e, now) {
    const fe = facade();
    const r = fe ? tx("exposureEnd", (db) => fe.endInTx(db, { exposureId: e.exposureId, at: now,
      reason: e.endReason })) : { ok: false, reason: "FLEET_EXPOSURE_UNAVAILABLE" };
    if (r && r.ok === true) {
      forget(e);
      bump("ended");
      if (e.endReason === "WIPED") bump("wiped");
      const losses = (r.losses || []).reduce((n, g) => n + g.count, 0);
      const reason = typeof r.endReason === "string" ? r.endReason : e.endReason;
      if (e.endReason === reason) creditEscort(e, now, reason);
      if (e.kind === CONVOY && e.crossing) {
        crossingsDone.set(e.fleetId, { key: crossingKeyOf(e.crossing), until: e.crossing.windowEnd });
      }
      noteEnd(e, now, reason, r.outcome, losses);
      logLimited(now, `fleetExposure: ${e.exposureId} ended ${reason} outcome=${r.outcome} losses=${losses}`
        + `${r.duplicate ? " (duplicate)" : ""}`);
      return;
    }
    bump("endFailed");
    if (r && PERMANENT_END.includes(r.reason)) {
      forget(e);
      logger.log(`fleetExposure: end ${e.exposureId} refused - ${r.reason} (left to the restart recovery)`);
      return;
    }
    logLimited(now, `fleetExposure: end ${e.exposureId} failed - ${(r && r.reason) || "no result"}`);
  }

  function endEntry(e, reason, now) {
    despawnAndRelease(e);
    e.phase = PHASE.ENDING;
    e.endReason = reason;
    tryEnd(e, now);
  }

  function writeHeldLosses(now) {
    const held = [...entries.values()].filter((e) => e.lossQueue.length > 0);
    if (held.length === 0) return;
    const fe = facade();
    if (!fe) return;
    const r = tx("exposureLosses", (db) => {
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
      logLimited(now, `fleetExposure: losses not written - ${(r && r.reason) || "no result"} (retry)`);
      return;
    }
    for (const d of r.done) {
      const member = d.e.members.find((x) => x.memberKey === d.memberKey);
      if (d.ok) {
        if (member) member.destroyed = true;
        if (!d.duplicate) bump("lossImported");
        d.e.lastAggressionAt = now;
      } else bump("lossDropped");
    }
    for (const e of held) e.lossQueue = [];
  }

  function stepPending(now, out) {
    if (stopped || (entries.size === 0 && lossTracker.sizes().pending === 0)) return;
    for (const l of lossTracker.drain()) {
      const e = entries.get(l.battleId);
      const m = e ? e.members.find((x) => x.memberKey === l.memberKey) : null;
      if (e && e.escort && !e.escort.credited) noteAggressor(e, e.escort.aggressors, l.killerCharacterId);
      if (e) escort.noteKiller(e, l.killerCharacterId);
      if (!e || !m || m.destroyed) {
        bump("lossDropped");
        continue;
      }
      let queue = null;
      if (e.phase === PHASE.VISIBLE) queue = e.pendingDestroyed;
      else if (e.phase === PHASE.HELD || e.phase === PHASE.EXITING) queue = e.lossQueue;
      if (!queue) {
        bump("lossDropped");
        continue;
      }
      if (queue.includes(l.memberKey)) continue;
      queue.push(l.memberKey);
      if (hullGroups[CONVOY].includes(m.hullGroup)) ambush.noteCarrierLoss(e);
      escort.noteLoss(e, m);
    }
    writeHeldLosses(now);
    for (const e of [...entries.values()]) if (e.phase === PHASE.ENDING) tryEnd(e, now);
  }

  function beginPass(now) {
    if (pass.at === now) return;
    pass = { at: now, players: new Map() };
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

  function sceneFacts(e, seam) {
    const gone = { sceneLoaded: false, alive: [], aggressors: [], playerChar: new Map(), playerSeen: false,
      players: [] };
    if (safeCall(() => npcSpawn.isSceneLoaded(e.systemId)) !== true) return gone;
    const players = playersOf(e.systemId, seam);
    if (!players || players.ok !== true) return players && players.reason === "SCENE_NOT_LOADED" ? gone : null;
    const ids = liveIdsOf(e);
    let alive = [];
    if (ids.length > 0) {
      const own = seam.readShips(e.systemId, ids, { civilianAlert: true });
      if (!own || own.ok !== true) return null;
      alive = own.ships;
    }
    let aggressors = [];
    if (alive.length > 0) {
      const ag = seam.readAggressors(e.systemId, alive.map((s) => s.entityId));
      if (ag && ag.ok === true) aggressors = ag.aggressors;
    }
    const playerChar = new Map(players.ships.map((p) => [p.entityId, p.characterId]));
    return { sceneLoaded: true, alive, aggressors, playerChar, playerSeen: players.ships.length > 0,
      players: players.ships };
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
      logOnce("group", "fleetExposure: no aggression read (belt navy scene seam unavailable) - held ships leave after "
        + "holdQuietMs");
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

  function readExposable(visible) {
    const map = new Map();
    if (visible.length === 0) return map;
    const repo = fleetRepo();
    if (!repo) return map;
    const r = tx("exposureFleets", (db) => repo.getFleets(db, visible.map((e) => e.fleetId)));
    if (!r || r.ok !== true) return map;
    const byId = new Map(r.fleets.map((f) => [f.fleetId, f]));
    for (const e of visible) {
      const f = byId.get(e.fleetId) || null;
      const ok = f !== null && (e.kind === CONVOY
        ? f.state === "TRAVELLING" && f.legSeq === e.crossing.legSeq
        : f.state === "STAGED" && f.operationId === e.operationId && f.currentSystemId === e.systemId);
      map.set(e.fleetId, ok);
    }
    return map;
  }

  function failClaim(e, reason, detail, now, out) {
    bump("claimFailed");
    bump("lossDropped", e.pendingDestroyed.length);
    if (e.cargoSeeded > 0 && e.pendingDestroyed.length > 0) {
      bump("cargoLootUnrecorded", e.members.filter((m) => m.cargoSeeded === true
        && e.pendingDestroyed.includes(m.memberKey)).length);
    }
    refuse(out, reason, null, detail);
    if (e.kind === MINER && e.evacuating) {
      e.evacuationClaimFailure = `CLAIM_${reason}`;
      return;
    }
    despawnAndRelease(e);
    forget(e);
    cooldown.set(e.fleetId, { at: now, ms: PERMANENT_CLAIM.includes(reason) ? S.permanentRefusalCooldownMs
      : S.respawnCooldownMs });
    noteEnd(e, now, `CLAIM_${reason}`, "DESPAWNED", 0);
    logLimited(now, `fleetExposure: claim ${e.fleetId} refused - ${reason}${detail ? ` ${detail}` : ""}`);
  }

  function chargeConvoyAttack(e, characterId, now) {
    const standings = safeCall(getStandings);
    if (!standings || typeof standings.onConvoyPenalty !== "function") return;
    const r = safeCall(() => standings.onConvoyPenalty({ kind: "ATTACK", characterId, factionId: e.factionId,
      systemId: e.systemId, atMs: now }));
    if (r && r.ok === true && r.outcome === "CHARGED") bump("convoyAttackCharged");
    else if (!r || r.ok !== true) bump("convoyAttackRefused");
  }

  function claimEntry(e, characterId, now, out) {
    const fe = facade();
    const repo = fleetRepo();
    if (!fe || !repo) {
      failClaim(e, fe ? "FLEETS_UNAVAILABLE" : "FLEET_EXPOSURE_UNAVAILABLE", null, now, out);
      return;
    }
    const r = tx("exposureClaim", (db) => {
      const got = repo.getFleet(db, e.fleetId);
      if (!got || got.ok !== true) return got;
      const f = got.fleet;
      if (!f) return { ok: false, reason: "FLEET_NOT_FOUND" };
      if (e.kind === CONVOY && f.legSeq !== e.crossing.legSeq) return { ok: false, reason: "STALE_LEG" };
      const at = e.kind === CONVOY ? Math.min(Math.max(now, e.crossing.windowStart), e.crossing.windowEnd - 1) : now;
      const exposureId = exposureIdOf(e.fleetId, f.version);
      const c = fe.claimInTx(db, { exposureId, fleetId: e.fleetId, expectedVersion: f.version, kind: e.kind,
        systemId: e.systemId, operationId: e.operationId, at, characterId,
        members: e.members.map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId })),
        destroyed: [...e.pendingDestroyed],
        crossing: e.kind === CONVOY ? { legSeq: e.crossing.legSeq, systemIndex: e.crossing.systemIndex } : null });
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
    bump("lossImported", e.pendingDestroyed.length);
    e.pendingDestroyed = [];
    bump("claimed");
    if (e.kind === CONVOY && characterId) chargeConvoyAttack(e, characterId, now);
    logLimited(now, `fleetExposure: ${e.exposureId} held ${e.kind} in ${e.systemId} character=${characterId}`);
  }

  function exitPointOf(e, seam, alive) {
    let listed;
    try {
      listed = seam.listSystemObjects(e.systemId, e.kind === CONVOY ? ["stargate"] : ["station", "stargate"]);
    } catch (_err) {
      listed = null;
    }
    const objects = listed && listed.ok === true && Array.isArray(listed.objects) ? listed.objects : [];
    if (e.kind === CONVOY) {
      const gate = objects.find((o) => o.toSystemId === e.crossing.toSystemId);
      return gate ? gate.position : null;
    }
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
    if (escortsOn && e.factionEscort) escort.beforeExit(e, seam, alive, now);
    const w = seam.warpShips(e.systemId, alive.map((s) => s.entityId), point, { spreadMeters: warpSpread });
    if (!w || w.ok !== true) logLimited(now, `fleetExposure: exit warp ${e.exposureId} - ${(w && w.reason) || "?"}`);
    e.phase = PHASE.EXITING;
    e.exitAt = now;
    e.exitPoint = { ...point };
    bump("exited");
  }


  function refreshMinerPresentation(e, facts, seam, now) {
    if (e.kind !== MINER || typeof seam.refreshMiningBeams !== "function") return;
    const previous = e.miningBeamTargets || new Map();
    const nearby = new Set();
    if (e.phase === PHASE.VISIBLE && facts.sceneLoaded && facts.aggressors.length === 0) {
      for (const player of facts.players) {
        if (player.position && player.inWarp !== true && facts.alive.some((ship) => ship.position
          && distanceSq(player.position, ship.position) <= MINING_VIEW_DISTANCE_SQ)) nearby.add(player.characterId);
      }
    }
    const arrived = [...nearby].some((id) => !e.miningViewers?.has(id));
    e.miningViewers = nearby;
    if (nearby.size === 0 && previous.size === 0) return;
    if (nearby.size > 0 && !arrived && now < (e.nextMiningBeamsAt || 0)) return;
    const ids = nearby.size > 0 ? facts.alive.map((ship) => ship.entityId) : [];
    try {
      e.miningBeamTargets = seam.refreshMiningBeams(e.systemId, ids, previous);
    } catch (err) {
      logLimited(now, "fleetExposure: mining presentation - " + messageOf(err));
    }
    e.nextMiningBeamsAt = now + (e.miningBeamTargets instanceof Map && e.miningBeamTargets.size < ids.length ? 5000 : MINING_BEAM_REFRESH_MS);
  }

  function stepEntries(now, out) {
    const seam = safeCall(getHuntScene);
    const list = [...entries.values()].filter((e) => e.phase !== PHASE.ENDING)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const exposable = readExposable(list.filter((e) => e.phase === PHASE.VISIBLE));
    minerFxLeft = S.minerBeamMaxFxPerPass;
    for (const e of list) {
      if (!seam) {
        if (e.phase === PHASE.VISIBLE) despawnVisible(e, "SCENE_GONE", now);
        else endEntry(e, "SCENE_GONE", now);
        continue;
      }
      let facts;
      try {
        facts = sceneFacts(e, seam);
      } catch (err) {
        logLimited(now, `fleetExposure: read ${e.key} threw - ${messageOf(err)}`);
        continue;
      }
      if (facts === null) continue;
      if (facts.playerSeen) e.lastPlayerSeenAt = now;
      if (S.minerBeamsEnabled !== true) refreshMinerPresentation(e, facts, seam, now);
      if (e.escort) sampleEscort(e, facts, seam);
      if (ambushOn && e.kind === CONVOY) {
        try {
          ambush.step(e, facts, nearCharactersOf(e, facts, seam), now);
        } catch (err) {
          logLimited(now, `fleetExposure: ambush ${e.key} threw - ${messageOf(err)}`);
        }
      }
      const alert = facts.alive.find((ship) => ship.civilianAlert)?.civilianAlert;
      if (e.kind === MINER && alert && !e.evacuating) {
        e.evacuating = true;
        cooldown.set(e.fleetId, { at: now, ms: S.permanentRefusalCooldownMs });
      }
      if (e.evacuationClaimFailure) {
        if (!facts.alive.some((ship) => evacuationPending(ship, now))) {
          despawnVisible(e, e.evacuationClaimFailure, now);
        }
        continue;
      }
      if (e.phase === PHASE.VISIBLE) {
        if (alert) {
          const directVictim = e.members.some((member) => member.entityId === alert.targetId);
          claimEntry(e, directVictim ? alert.characterId : null, now, out);
          continue;
        }
        const sig = aggressionSigOf(facts);
        const d = R.decideVisible({ now, kind: e.kind, pendingKill: e.pendingDestroyed.length > 0,
          playerAggression: sig !== "" && sig !== e.aggressionSig,
          despawnAt: e.crossing ? ambush.despawnAt(e, e.crossing.despawnAt) : null,
          fleetExposable: exposable.get(e.fleetId) !== false,
          lastPlayerSeenAt: e.lastPlayerSeenAt, sceneLoaded: facts.sceneLoaded }, P);
        if (d.action === R.ACTION.CLAIM) claimEntry(e, aggressorCharacterOf(facts), now, out);
        else if (d.action === R.ACTION.DESPAWN) despawnVisible(e, d.reason, now);
        stepMinerBeams(e, facts, seam, now);
        stepFactionEscort(e, facts, seam, now);
        continue;
      }
      const newAggression = facts.sceneLoaded ? newAggressionOf(e, facts.alive) : false;
      if (newAggression) e.lastAggressionAt = now;
      if (e.evacuating) {
        if (facts.alive.some((ship) => evacuationPending(ship, now))) continue;
        if (facts.alive.length > 0) {
          endEntry(e, "QUIET", now);
          continue;
        }
      }
      const d = R.decideHeld({ now, phase: e.phase, allDestroyed: e.members.every((m) => m.destroyed),
        sceneLoaded: facts.sceneLoaded, alive: facts.alive, lastPlayerSeenAt: e.lastPlayerSeenAt,
        claimedAt: e.claimedAt, lastAggressionAt: e.lastAggressionAt, newAggression, exitAt: e.exitAt,
        exitPoint: e.exitPoint }, P);
      if (d.action === R.ACTION.END) endEntry(e, d.reason, now);
      else if (e.kind === MINER && e.phase === PHASE.HELD && facts.alive.length > 0 &&
          e.members.some((member) => member.destroyed)) {
        cooldown.set(e.fleetId, { at: now, ms: S.permanentRefusalCooldownMs });
        startExit(e, seam, facts.alive, now);
      }
      else if (d.action === R.ACTION.EXIT) startExit(e, seam, facts.alive, now);
      else if (e.phase === PHASE.EXITING && newAggression) {
        e.phase = PHASE.HELD;
        e.exitAt = null;
        e.exitPoint = null;
      }
      stepMinerBeams(e, facts, seam, now);
      stepFactionEscort(e, facts, seam, now);
    }
  }

  function stepMinerBeams(e, facts, seam, now) {
    if (S.minerBeamsEnabled !== true || e.kind !== MINER || e.despawned || facts.sceneLoaded !== true
      || typeof seam.presentMiningBeams !== "function") return;
    const miners = facts.alive.filter((s) => s && s.position && s.inWarp !== true)
      .map((s) => ({ entityId: s.entityId, position: s.position, beltId: e.minerBeltId }));
    const pending = Boolean(e.beams && e.beams.approaching && e.beams.approaching.size > 0);
    if (miners.length === 0 && (!e.beams || e.beams.shown.size === 0) && !pending) return;
    if (minerFxLeft <= 0 && !pending) return;
    try {
      const approachOn = S.minerBeamApproachEnabled === true;
      const players = (Array.isArray(facts.players) ? facts.players : []).map((p) => ({
        characterId: p && p.characterId, position: (p && p.position) || null, inWarp: Boolean(p && p.inWarp === true) }));
      const plan = planBeams({ now, miners, players, state: e.beams,
        suppress: e.phase !== PHASE.VISIBLE || facts.aggressors.length > 0,
        viewMeters: S.minerBeamViewMeters, refreshMs: S.minerBeamRefreshMs,
        ...(approachOn ? { retryMs: S.minerBeamRetryMs } : {}) });
      if (plan.start.length === 0 && plan.stop.length === 0 && plan.release.length === 0) {
        e.beams = applyBeams(e.beams, plan, { ok: true, started: [] });
        return;
      }
      const req = { start: plan.start, stop: plan.stop, rockRangeMeters: S.minerBeamRockMeters,
        maxFx: Math.max(0, minerFxLeft) };
      if (approachOn) {
        req.release = plan.release;
        req.approach = { startMeters: S.minerBeamStartMeters,
          followMeters: followMetersOf(S.minerBeamApproachMeters, S.minerBeamStartMeters) };
      }
      const r = seam.presentMiningBeams(e.systemId, req);
      e.beams = applyBeams(e.beams, plan, r);
      if (!r || r.ok !== true) {
        logLimited(now, `fleetExposure: miner beams ${e.key} - ${(r && r.reason) || "no result"}`);
        return;
      }
      const sent = Number.isSafeInteger(r.fxSent) ? r.fxSent : 0;
      const orders = Number.isSafeInteger(r.ordersSent) ? r.ordersSent : 0;
      minerFxLeft -= sent + orders;
      bump("minerBeamFx", sent);
      bump("minerBeamBudgetCut", Number.isSafeInteger(r.budgetCut) ? r.budgetCut : 0);
      bump("minerBeamNoRock", Array.isArray(r.noRock) ? r.noRock.length : 0);
      if (approachOn) {
        bump("minerBeamApproachOrders", orders);
        bump("minerBeamApproaching", Array.isArray(r.approaching) ? r.approaching.length : 0);
        bump("minerBeamApproachBusy", Array.isArray(r.busy) ? r.busy.length : 0);
        bump("minerBeamApproachRefused", Number.isSafeInteger(r.refused) ? r.refused : 0);
        bump("minerBeamApproachReleased", Array.isArray(r.released) ? r.released.length : 0);
      }
      if (plan.full) bump("minerBeamRefresh");
    } catch (err) {
      logLimited(now, `fleetExposure: miner beams ${e.key} threw - ${messageOf(err)}`);
    }
  }

  function stepFactionEscort(e, facts, seam, now) {
    if (!escortsOn || !e.factionEscort || e.despawned) return;
    if (e.phase !== PHASE.VISIBLE && e.phase !== PHASE.HELD) return;
    try {
      escort.step(e, facts, seam, playersOf(e.systemId, seam), now);
    } catch (err) {
      logLimited(now, `fleetExposure: faction escort ${e.key} threw - ${messageOf(err)}`);
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

  function readCandidates(systems, now, out) {
    const repo = fleetRepo();
    if (!repo) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    const lg = S.convoysEnabled === true ? logistics() : null;
    if (S.convoysEnabled === true && !lg) refuse(out, "LOGISTICS_UNAVAILABLE", "scanRefused");
    const observed = new Set(systems);
    return tx("exposureRead", (db) => {
      const candidates = [];
      let nextCursor = null;
      if (lg) {
        const page = lg.listInTransitInTx(db, { limit: S.scanMaxConvoys, ...(convoyCursor ? { after: convoyCursor }
          : {}) });
        if (page && page.ok === true) {
          if (page.truncated === true && page.convoys.length > 0) {
            nextCursor = page.convoys[page.convoys.length - 1].convoyId;
          }
          const ids = [...new Set(page.convoys.map((c) => c.fleetId).filter((id) => typeof id === "string"))];
          const cargoOf = new Map();
          for (const c of page.convoys) {
            if (typeof c.fleetId === "string" && !cargoOf.has(c.fleetId)) {
              cargoOf.set(c.fleetId, { cargo: c.cargo || null, carriersAtLoad: c.carriersAtLoad });
            }
          }
          const got = ids.length > 0 ? repo.getFleets(db, ids) : { ok: true, fleets: [] };
          if (!got || got.ok !== true) return got;
          for (const f of [...got.fleets].sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1))) {
            if (f.fleetRole !== CONVOY_ROLE || typeof f.operationId !== "string") continue;
            const crossing = R.pickCrossing(f, observed, now, P);
            if (crossing) {
              candidates.push({ kind: CONVOY, fleet: f, crossing, systemId: crossing.systemId,
                convoy: cargoOf.get(f.fleetId) || null });
            }
          }
        }
      }
      if (S.minersEnabled === true) {
        const listed = repo.listFleetsInSystems(db, systems, { states: ["STAGED"],
          limitPerSystem: S.scanMaxMinersPerSystem });
        if (!listed || listed.ok !== true) return listed;
        for (const sys of systems) {
          for (const f of listed.bySystem.get(sys) || []) {
            if (f.fleetRole !== MINER_ROLE || typeof f.operationId !== "string") continue;
            const op = repo.getOperation(db, f.operationId);
            if (!op || op.ok !== true || !op.operation || op.operation.operationType !== MINING_TYPE
              || op.operation.objective !== MINING_OBJECTIVE) continue;
            candidates.push({ kind: MINER, fleet: f, crossing: null, systemId: sys });
          }
        }
      }
      return { ok: true, candidates, nextCursor };
    });
  }

  function cooled(fleetId, now) {
    if (!cooldown.has(fleetId)) return false;
    const c = cooldown.get(fleetId);
    if (now - c.at < c.ms) return true;
    cooldown.delete(fleetId);
    return false;
  }

  function pruneCooldown(now) {
    for (const [fleetId, c] of cooldown) if (now - c.at >= c.ms) cooldown.delete(fleetId);
    for (const [fleetId, d] of crossingsDone) if (now >= d.until) crossingsDone.delete(fleetId);
    ambush.prune(now);
  }

  function crossingDone(c) {
    if (c.kind !== CONVOY || !crossingsDone.has(c.fleet.fleetId)) return false;
    return crossingsDone.get(c.fleet.fleetId).key === crossingKeyOf(c.crossing);
  }

  function anchorsOf(c, seam) {
    const kinds = c.kind === CONVOY ? CONVOY_ANCHOR_KINDS : MINER_ANCHOR_KINDS;
    const listed = seam.listSystemObjects(c.systemId, [...kinds]);
    const objects = listed && listed.ok === true && Array.isArray(listed.objects) ? listed.objects : [];
    const ofKind = (k) => objects.filter((o) => o && o.kind === k);
    if (c.kind === CONVOY) {
      const gates = ofKind("stargate");
      const entry = gates.find((o) => o.toSystemId === c.crossing.fromSystemId) || null;
      const exit = gates.find((o) => o.toSystemId === c.crossing.toSystemId) || null;
      if (entry) return { anchor: entry, exit, fallback: exit === null };
      const anchor = exit || gates[0] || ofKind("station")[0] || ofKind("sun")[0] || null;
      return anchor ? { anchor, exit, fallback: true } : null;
    }
    const belt = R.pickMinerAnchor(ofKind("asteroidBelt"), worldSeed, c.fleet.fleetId);
    if (belt) return { anchor: belt, exit: null, fallback: false };
    const anchor = R.pickMinerAnchor(ofKind("planet"), worldSeed, c.fleet.fleetId) || ofKind("sun")[0]
      || ofKind("station")[0] || ofKind("stargate")[0] || null;
    return anchor ? { anchor, exit: null, fallback: true } : null;
  }

  function spawnDistanceOf(anchor) {
    return R.spawnDistanceOf(anchor, S.spawnDistanceMeters, S.surfaceMarginMeters, S.stationDefaultRadiusMeters);
  }

  function seedCarriers(e, convoy, now) {
    try {
      if (typeof npcSpawn.seedCargo !== "function") {
        logOnce("seedCargo", "fleetExposure: no convoy cargo loot - npcSpawn.seedCargo unavailable");
        return;
      }
      const plan = planCarrierLoot(convoy.cargo, convoy.carriersAtLoad,
        { sharePermille: S.cargoLootSharePermille, maxM3PerCarrier: S.cargoLootMaxM3PerCarrier });
      if (plan.hullKeysSkipped > 0) bump("cargoLootHullSkipped", plan.hullKeysSkipped);
      if (!plan.ok) {
        if (plan.reason === "NO_MINERALS") bump("cargoLootNoMinerals");
        else logLimited(now, `fleetExposure: cargo loot ${e.fleetId} skipped - ${plan.reason}`);
        return;
      }
      for (const m of e.members) {
        if (!cargoGroups.includes(m.hullGroup)) continue;
        const r = npcSpawn.seedCargo(m.entityId, plan.items);
        if (r && r.ok === true) {
          m.cargoSeeded = true;
          e.cargoSeeded += 1;
          bump("cargoSeeded");
          bump("cargoSeedUnits", plan.units);
          continue;
        }
        bump("cargoSeedFailed");
        logLimited(now, `fleetExposure: cargo hold ${e.fleetId} ship ${m.entityId} refused - `
          + `${(r && r.reason) || "no result"}${r && r.detail ? ` ${r.detail}` : ""}`);
      }
    } catch (err) {
      bump("cargoSeedFailed");
      logLimited(now, `fleetExposure: cargo hold ${e.fleetId} threw - ${messageOf(err)}`);
    }
  }

  function startFactionEscort(e, fleet, noProfile) {
    escort.init(e);
    const spawned = e.members.filter((m) => escort.isEscort(m)).length;
    const inComposition = (Array.isArray(fleet.composition) ? fleet.composition : [])
      .filter((x) => x && escortGroups.includes(x.hullGroup) && Number.isSafeInteger(x.count) && x.count > 0)
      .reduce((n, x) => n + x.count, 0);
    bump("factionEscortShips", spawned);
    bump("factionEscortTrimmed", inComposition - spawned - noProfile);
  }

  function startEntry(c, membersIn, profilesIn, trimmed, seam, now, out, escortNoProfile = 0) {
    const fleet = c.fleet;
    const key = fleet.fleetId;
    let members = membersIn;
    let profiles = profilesIn;
    let cut = trimmed === true;
    const where = anchorsOf(c, seam);
    if (!where) {
      refuse(out, c.kind === CONVOY ? "NO_GATE" : "NO_BELT", "refusedNoGate", key);
      return false;
    }
    const reservationId = c.kind === CONVOY ? `fx:${key}:${c.crossing.legSeq}` : `fx:${key}:${fleet.version}`;
    const requestOf = (n) => ({ reservationId, ownerKind: "fleet", ownerId: key, systemId: c.systemId,
      shipCount: n, metadata: { systemId: c.systemId } });
    let n = members.length;
    for (let i = 0; i < BUDGET_PROBES; i += 1) {
      const p = budget.canReserve(requestOf(n));
      if (!p || p.ok === true || !LIMIT_REASONS.includes(p.reason) || !(p.available > 0) || p.available >= n) break;
      n = p.available;
    }
    if (n < members.length) {
      members = members.slice(0, n);
      profiles = profiles.slice(0, n);
      cut = true;
    }
    const reserved = budget.reserve(requestOf(members.length));
    if (!reserved || reserved.ok !== true) {
      refuse(out, (reserved && reserved.reason) || "BUDGET", "refusedBudget", key);
      return false;
    }
    const e = { key, kind: c.kind, phase: PHASE.VISIBLE, fleetId: key, factionId: fleet.factionId,
      systemId: c.systemId, operationId: fleet.operationId, crossing: c.crossing, reservationId,
      members: [], exitPoint: null, pendingDestroyed: [], lossQueue: [], exposureId: null, claimedAt: null,
      lastAggressionAt: null, aggressionSig: "", lastPlayerSeenAt: now, exitAt: null, endReason: null,
      characterId: null, despawned: false, groupStamps: new Map(), startedAt: now, cargoSeeded: 0,
      escort: escortOn && c.kind === CONVOY ? { samples: new Map(), aggressors: new Set(), aggressorShips: new Set(),
        shipOf: new Map(), aggressorsFull: false, credited: false } : null,
      exitGate: where.exit && Number.isSafeInteger(where.exit.itemId) && where.exit.position
        ? { kind: where.exit.kind, itemId: where.exit.itemId, position: { ...where.exit.position } } : null,
      ambush: null,
      factionEscort: null,
      minerBeltId: c.kind === MINER && where.anchor.kind === "asteroidBelt" && Number.isSafeInteger(where.anchor.itemId)
        ? where.anchor.itemId : null,
      beams: null };
    entries.set(key, e);
    try {
      const anchor = { kind: where.anchor.kind, itemID: where.anchor.itemId };
      const spawnDistanceMeters = spawnDistanceOf(where.anchor);
      for (let i = 0; i < members.length; i += 1) {
        const r = npcSpawn.spawnShip(c.systemId, { profileId: profiles[i], anchorDescriptor: anchor,
          spawnDistanceMeters, behavior: "search", civilianOperation: { fleetId: key } });
        if (!r || r.ok !== true) throw new StepError((r && r.reason) || "SPAWN_FAILED", r && r.detail);
        e.members.push({ ...members[i], entityId: r.entityId, profileId: profiles[i], destroyed: false });
      }
      const ids = allIdsOf(e);
      const pub = npcSpawn.publish(c.systemId, ids);
      if (!pub || pub.ok !== true) throw new StepError("PUBLISH_FAILED", pub && (pub.detail || pub.reason));
      if (!(pub.published >= ids.length)) throw new StepError("PUBLISH_PARTIAL", `${pub.published}/${ids.length}`);
      if (c.kind === CONVOY && typeof npcSpawn.markConvoyShips === "function") {
        const m = safeCall(() => npcSpawn.markConvoyShips(ids, { ownerFactionId: e.factionId, fleetId: key,
          cap: S.maxVisible * S.maxShipsPerExposure }));
        if (!m || m.ok !== true) bump("convoyMarkFailed");
      }
      if (where.exit) {
        const w = seam.warpShips(c.systemId, ids, where.exit.position,
          { spreadMeters: warpSpread, alignBeforeWarp: true, visibleDeparture: true });
        if (!w || w.ok !== true) throw new StepError((w && w.reason) || "WARP_FAILED", w && w.detail);
      }
      if (S.cargoLootEnabled === true && c.kind === CONVOY && c.convoy) seedCarriers(e, c.convoy, now);
    } catch (err) {
      const reason = err instanceof StepError ? err.reason : "SPAWN_THREW";
      const detail = err instanceof StepError ? err.detail : messageOf(err);
      despawnAndRelease(e);
      forget(e);
      refuse(out, reason, "spawnFailed", detail);
      const held = isSceneRefusal(reason) ? { first: true, failures: 0, retryAt: now }
        : spawnBackoff.note(key, failureReasonOf(reason, detail), now);
      if (held.first) {
        logLimited(now, `fleetExposure: spawn ${key} rolled back - ${reason}${detail ? ` ${detail}` : ""}`
          + `${held.failures > 0 ? ` backoff=${held.retryAt - now}ms failures=${held.failures}` : ""}`);
      }
      return false;
    }
    spawnBackoff.clear(key);
    lossTracker.track(key, e.members.map((m) => ({ memberKey: m.memberKey, entityId: m.entityId })));
    if (escortsOn && c.kind === CONVOY) startFactionEscort(e, fleet, escortNoProfile);
    bump(c.kind === CONVOY ? "startedConvoy" : "startedMiner");
    if (cut) bump("exposureTrimmed");
    if (where.fallback) bump("anchorFallback");
    logLimited(now, `fleetExposure: ${c.kind} ${key} visible in ${c.systemId} ships=${e.members.length}`
      + `${cut ? " (partial)" : ""}${c.crossing ? ` despawnAt=${c.crossing.despawnAt}` : ""}`);
    return true;
  }

  function stepNew(now, presence, out) {
    if (S.enabled !== true) return;
    const fe = facade();
    if (!fe || safeCall(() => fe.isEnabled()) !== true) {
      logOnce("facade", "fleetExposure: no new exposures - ctx.fleetExposure not enabled");
      return;
    }
    if (!lossImportOn) {
      logOnce("lossImport", "fleetExposure: no new exposures - battle.liveLossImport off");
      return;
    }
    if (!(S.maxVisible > 0)) return;
    if (lastScanAt !== null && now - lastScanAt < S.scanIntervalMs) return;
    lastScanAt = now;
    if (!admits(WORK_CLASS_NEW)) {
      refuse(out, "GOVERNOR", "refusedGovernor");
      return;
    }
    const seam = safeCall(getHuntScene);
    if (!seam) {
      logOnce("seam", "fleetExposure: no new exposures - hunt scene seam unavailable");
      refuse(out, "SEAM_UNAVAILABLE", "scanRefused");
      return;
    }
    const systems = candidateSystems(presence).slice(0, S.maxSystemsPerScan);
    if (systems.length === 0) return;
    cursor = systems[systems.length - 1];
    pruneCooldown(now);
    bump("scans");
    const read = readCandidates(systems, now, out);
    if (!read || read.ok !== true) {
      refuse(out, (read && read.reason) || "READ_FAILED", "scanRefused");
      return;
    }
    convoyCursor = read.nextCursor;
    const order = new Map(systems.map((s, i) => [s, i]));
    const list = read.candidates.map((c, i) => ({ c, i }))
      .sort((a, b) => (order.get(a.c.systemId) - order.get(b.c.systemId)) || (a.i - b.i)).map((x) => x.c);
    let attempts = 0;
    for (let k = 0; k < list.length; k += 1) {
      const c = list[k];
      const fleetId = c.fleet.fleetId;
      if (entries.has(fleetId) || crossingDone(c)) continue;
      if (entries.size >= S.maxVisible) {
        bump("refusedMaxVisible", list.slice(k).filter((x) => !entries.has(x.fleet.fleetId) && !crossingDone(x))
          .length);
        refuse(out, "MAX_VISIBLE", null, fleetId);
        break;
      }
      if (attempts >= S.maxNewPerPass) {
        const at = order.get(c.systemId);
        if (at > 0) cursor = systems[at - 1];
        break;
      }
      if (cooled(fleetId, now)) {
        refuse(out, "COOLDOWN", "refusedCooldown", fleetId);
        continue;
      }
      if (spawnBackoff.blocked(fleetId, now) !== null) {
        refuse(out, "SPAWN_BACKOFF", "refusedBackoff", fleetId);
        continue;
      }
      const members = R.exposableMembers(c.fleet, exposeGroups[c.kind], S.maxShipsPerExposure);
      if (!members.ok) continue;
      const profiles = profilesOf(c, members.members);
      if (!profiles.ok) {
        refuse(out, profiles.reason, "refusedProfile", fleetId);
        continue;
      }
      attempts += 1;
      startEntry(c, profiles.members, profiles.profiles, members.trimmed || profiles.dropped, seam, now, out,
        profiles.escortNoProfile || 0);
    }
  }

  function profilesOf(c, members) {
    const fleetId = c.fleet.fleetId;
    const reqOf = (m, factionId, hullGroup) => ({ memberKey: m.memberKey, factionId, hullGroup, typeId: m.typeId });
    const call = (reqs, ind) => safeCall(() => npcSpawn.resolveProfiles(reqs, { seedPrefix: fleetId, industry: ind }));
    const whole = call(members.map((m) => reqOf(m, c.fleet.factionId, m.hullGroup)), industry);
    if (whole && whole.ok === true) return { ok: true, members, profiles: whole.profiles, dropped: false };
    const kept = [];
    const profiles = [];
    let fallbacks = 0;
    let escortNoProfile = 0;
    for (const m of members) {
      const escortMember = c.kind === CONVOY && escortGroups.includes(m.hullGroup);
      const tries = [[reqOf(m, c.fleet.factionId, m.hullGroup), industry],
        [reqOf(m, c.fleet.factionId, m.hullGroup), true],
        ...(escortMember ? [] : [[reqOf(m, FALLBACK_FACTION_ID, FALLBACK_HULL[c.kind]), true]])];
      let got = false;
      for (let i = 0; i < tries.length; i += 1) {
        const r = call([tries[i][0]], tries[i][1]);
        if (!r || r.ok !== true || !Array.isArray(r.profiles) || typeof r.profiles[0] !== "string") continue;
        kept.push(m);
        profiles.push(r.profiles[0]);
        if (i > 0) fallbacks += 1;
        got = true;
        break;
      }
      if (!got && escortMember) escortNoProfile += 1;
    }
    bump("profileFallback", fallbacks);
    bump("factionEscortNoProfile", escortNoProfile);
    if (kept.length === 0) return { ok: false, reason: (whole && whole.reason) || "NO_PROFILE" };
    return { ok: true, members: kept, profiles, dropped: kept.length < members.length, escortNoProfile };
  }

  function step(now, presence, out) {
    if (stopped) return;
    beginPass(now);
    escort.beginPass(now);
    if (entries.size > 0) stepEntries(now, out);
    stepNew(now, presence, out);
  }

  function getStatus() {
    const by = (phase) => [...entries.values()].filter((e) => e.phase === phase).length;
    return {
      state: stopped ? "stopped" : (S.enabled === true ? "on" : "off"),
      lossImport: lossImportOn ? "on" : "off",
      visible: by(PHASE.VISIBLE),
      held: by(PHASE.HELD),
      exiting: by(PHASE.EXITING),
      ending: by(PHASE.ENDING),
      entries: [...entries.values()].map((e) => ({ fleetId: e.fleetId, kind: e.kind, phase: e.phase,
        systemId: e.systemId, factionId: e.factionId, exposureId: e.exposureId, ships: e.members.length,
        destroyed: e.members.filter((m) => m.destroyed).length, startedAt: e.startedAt, claimedAt: e.claimedAt,
        characterId: e.characterId, cargoSeeded: e.cargoSeeded, ambush: ambush.statusOf(e),
        factionEscort: escort.statusOf(e) })),
      counters: { ...counters },
      lastRefusal,
      recentEnds: recentEnds.map((x) => ({ ...x })),
      lossTracker: lossTracker.sizes(),
    };
  }

  function stop() {
    stopped = true;
  }

  function yieldShips(systemId, need, now) {
    const needSystem = need && need.system > 0 ? need.system : 0;
    const needGlobal = need && need.global > 0 ? need.global : 0;
    if (stopped || (needSystem === 0 && needGlobal === 0)) {
      return { ok: false, reason: "NOTHING_TO_YIELD", freeable: 0 };
    }
    const own = (e) => (e.systemId === systemId ? 0 : 1);
    const pool = yieldPool(systemId, needGlobal > 0)
      .sort((a, b) => (own(a) - own(b)) || (b.startedAt - a.startedAt)
        || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const ownFree = pool.filter((e) => e.systemId === systemId).reduce((s, e) => s + e.members.length, 0);
    const freeable = pool.reduce((s, e) => s + e.members.length, 0);
    if (ownFree < needSystem || freeable < needGlobal) return { ok: false, reason: "NOT_ENOUGH", freeable };
    let freed = 0;
    let freedOwn = 0;
    let count = 0;
    for (const e of pool) {
      if (freedOwn >= needSystem && freed >= needGlobal) break;
      freed += e.members.length;
      if (e.systemId === systemId) freedOwn += e.members.length;
      count += 1;
      despawnVisible(e, "PREEMPTED", now);
    }
    bump("preempted", count);
    bump("preemptedShips", freed);
    logLimited(now, `fleetExposure: ${count} exposure(s) / ${freed} ships yield to a LIVE fight in ${systemId}`);
    return { ok: true, freed, entries: count };
  }

  function yieldPool(systemId, global) {
    return [...entries.values()].filter((e) => e.phase === PHASE.VISIBLE && !e.despawned && !e.evacuating
      && e.pendingDestroyed.length === 0 && !ambush.blocksYield(e) && (global || e.systemId === systemId));
  }

  function freeable(systemId) {
    if (stopped) return { system: 0, global: 0 };
    let system = 0;
    let global = 0;
    for (const e of yieldPool(systemId, true)) {
      global += e.members.length;
      if (e.systemId === systemId) system += e.members.length;
    }
    return { system, global };
  }

  function relationGroups() {
    const out = [];
    for (const e of entries.values()) {
      if (e.despawned || (e.phase !== PHASE.VISIBLE && e.phase !== PHASE.HELD && e.phase !== PHASE.EXITING)) continue;
      const entityIds = liveIdsOf(e);
      if (entityIds.length === 0) continue;
      const hullOf = new Map(e.members.map((m) => [m.entityId, m.hullGroup]));
      out.push({ systemId: e.systemId, factionId: e.factionId, entityIds,
        hullGroups: entityIds.map((id) => (hullOf.has(id) ? hullOf.get(id) : null)), aggressors: null,
        primaryCharacterId: Number.isSafeInteger(e.characterId) ? e.characterId : null });
    }
    return out;
  }

  return Object.freeze({ stepPending, step, getStatus, stop, relationGroups, yieldShips, freeable });
}

module.exports = { createExposureStep, createYieldingBudget, COUNTER_NAMES };
