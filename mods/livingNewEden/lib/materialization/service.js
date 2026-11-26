// Ported from X-Eve livingUniverseRuntime.js materializeConflictEncounter:3406-3508 (all or nothing, one publication; CREDITS.md) on the battle side and the seam.

"use strict";

const { performance } = require("node:perf_hooks");
const { createRegistry } = require("./registry");
const { classifyLiveEnd } = require("../battle/liveEndMonitor");
const { structureOf } = require("../battle/structureOutcome");
const { GARRISON_FLEET_ID } = require("../battle/schema");
const { createCapitalRules, CAPITAL_NO_PROFILE_DETAIL } = require("./capitalRules");
const { planWave, pickRefill } = require("./wavePlan");
const { fallbackChainOf } = require("./profileFallback");
const { createLossTracker } = require("./lossTracker");
const { createHuntStep } = require("./huntStep");
const { createSpawnBackoff } = require("./spawnBackoff");
const { createGarrisonStep } = require("./garrisonStep");
const { createExposureStep } = require("./exposureStep");
const { createYieldingBudget } = require("./yieldingBudget");
const { createPresenceStep, RESERVATION_PREFIX: PRESENCE_RESERVATION_PREFIX } = require("./presenceStep");
const { createRelationPainter } = require("./relationPaint");
const { createSentryStep } = require("./sentryStep");
const { createSentryHoldStep } = require("./sentryHoldStep");
const { huntThresholds } = require("../playerHunt/policy");
const { parseNeutralPolicy } = require("../playerHunt/schema");
const { sceneRefusalOf } = require("./sceneBudget");

const SCENE_SOURCE = "materialization";

const COUNTER_NAMES = Object.freeze(["passes", "passErrors", "attempted", "materialized", "shipsSpawned",
  "refusedBudget", "refusedGovernor", "refusedScene", "refusedState", "unsupported", "skippedFailed", "spawnFailed",
  "publishFailed", "orphanClaim", "reverted", "revertFailed", "exited", "exitFailed", "despawnMissing",
  "despawnFailed", "despawnAbandoned", "retargeted", "battleEndDetected", "battleEndTimeout", "lossImported",
  "lossStale", "lossFailed", "externallyEnded", "structureExited", "structureReadFailed", "ownerUnknown",
  "garrisonMaterialized", "garrisonShipsSpawned", "despawnPurged", "capitalSpawned", "capitalNoProfile",
  "relationRepainted", "relationUnknown", "relationFailed", "relationDeferred",
  "relationUnchanged",
  "gridAnchorUsed", "gridAnchorFallback",
  "wavesStarted", "waveShipsSpawned", "waveSpawnFailed", "waveDeferred", "waveTooLarge", "profileFallback",
  "governorIdlePasses"]);
const GARRISON_ANCHOR = Object.freeze({ prefer: "station" });

const LIVE_MODE = "LIVE_EVEJS";
const WORK_CLASS_NEW = "OPERATIONAL";
const WORK_CLASS_PLAYER_BATTLE = "LIVE";
const EXIT_REASON = "EXIT";
const STRUCTURE_REASON = "STRUCTURE_DESTROYED";
const TIMEOUT_CAUSE = "TIMEOUT";
const LOSS_STALE = Object.freeze(["NOT_LIVE", "BATTLE_NOT_FOUND"]);
const LOG_LINES_PER_MIN = 10;
const MINUTE_MS = 60000;
const MAX_DETAIL = 120;
const MAX_LIST_LIMIT = 500;
const RECENT_FAILED_SHOWN = 20;
const MS_DECIMALS = 1000;
const PERMANENT_PLAN = Object.freeze(["LIVE_TOO_LARGE", "NO_PROFILE", "NO_ANCHOR", "GARRISON_UNSUPPORTED",
  "INPUT_INVALID"]);
const PERMANENT_EXIT = Object.freeze(["BATTLE_NOT_FOUND", "LIVE_INVALID_INPUT"]);
const REVERT_GONE = Object.freeze(["NOT_MATERIALIZING", "BATTLE_NOT_FOUND"]);

class StepError extends Error {
  constructor(reason, kind, detail) {
    super(reason);
    this.reason = String(reason);
    this.kind = kind;
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

function createLineLimit(perMin) {
  let windowStart = -Infinity;
  let used = 0;
  return (now) => {
    if (now - windowStart >= MINUTE_MS) {
      windowStart = now;
      used = 0;
    }
    if (used >= perMin) return false;
    used += 1;
    return true;
  };
}

function createMaterializationService(deps) {
  const { store, battleLive, npcSpawn, budget, clock } = deps;
  const S = deps.settings;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const hooks = deps.hooks && typeof deps.hooks === "object" ? deps.hooks : {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const readDormancyGuardStats = typeof deps.readDormancyGuardStats === "function" ? deps.readDormancyGuardStats : null;
  const registry = createRegistry({ maxFailedBattlesRemembered: S.maxFailedBattlesRemembered,
    maxStrayShipsRemembered: S.maxStrayShipsRemembered });
  const bootAt = clock.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const unsupportedLog = createLineLimit(LOG_LINES_PER_MIN);
  const errorLog = createLineLimit(LOG_LINES_PER_MIN);
  const garrisonLog = createLineLimit(LOG_LINES_PER_MIN);
  const gridLog = createLineLimit(LOG_LINES_PER_MIN);
  const garrisonLive = S.garrisonLive && typeof S.garrisonLive === "object" ? S.garrisonLive : null;
  let passes = 0;
  let stopped = false;
  let stopReason = null;
  let cursor = 0;
  let lastRefusal = null;
  const lossTracker = deps.lossTracker || createLossTracker({ maxPending: 0 });
  const lossImportOn = deps.lossImportOn === true;
  const liveEnd = deps.liveEnd && deps.liveEnd.enabled === true
    ? { enabled: true, timeoutMs: deps.liveEnd.timeoutMs } : { enabled: false, timeoutMs: 0 };

  const structureSeam = deps.structureSeam && typeof deps.structureSeam.getStructure === "function"
    ? deps.structureSeam : null;

  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
  const ownerFactions = new Set((Array.isArray(deps.ownerFactionIds) ? deps.ownerFactionIds : [])
    .filter((id) => Number.isSafeInteger(id) && id > 0));

  const capital = createCapitalRules({ settings: S, count: (name, n) => bump(name, n),
    log: (line) => logger.log(line) });

  const huntDeps = deps.hunt && typeof deps.hunt === "object" && deps.hunt.settings ? deps.hunt : null;
  const preemptBackoffMs = deps.exposure && deps.exposure.settings ? deps.exposure.settings.preemptBackoffMs : 0;
  const handOver = (fleetId) => (presenceStep ? presenceStep.handOver(fleetId) : null);
  const fightBudget = createYieldingBudget(budget, () => [presenceStep, exposure], clock,
    { backoffMs: preemptBackoffMs, onFleetReserve: handOver });
  const lowBudget = createYieldingBudget(budget, () => [presenceStep], clock,
    { backoffMs: preemptBackoffMs, onFleetReserve: handOver });
  const hunt = huntDeps === null ? null : createHuntStep({ ...huntDeps, store, clock, npcSpawn, budget: fightBudget,
    maxRetargetsPerPass: S.maxRetargetsPerPass, lossImportOn: deps.lossImportOn === true,
    despawnAll: (systemId, ids) => despawnAll(systemId, ids), admits: (wc) => admits(wc), telemetry, logger,
    hooks, nowMs, getOwnedShipIds: () => registry.ownedEntityIds(null), capital,
    getLneGroups: () => combatGroups(),
    attackLockOn: S.attackLockEnabled === true,
    spawnBackoff: createSpawnBackoff(S.spawnBackoff) });
  const patrolDeps = deps.patrol && typeof deps.patrol === "object" && deps.patrol.settings ? deps.patrol : null;
  const patrol = patrolDeps === null ? null : createGarrisonStep({ ...patrolDeps, store, clock, npcSpawn,
    budget: lowBudget, maxRetargetsPerPass: S.maxRetargetsPerPass, lossImportOn: deps.lossImportOn === true,
    despawnAll: (systemId, ids) => despawnAll(systemId, ids), admits: (wc) => admits(wc), telemetry, logger,
    hooks, nowMs, capital, getLneGroups: () => combatGroups(),
    attackLockOn: S.attackLockEnabled === true,
    spawnBackoff: createSpawnBackoff(S.spawnBackoff) });
  const exposureDeps = deps.exposure && typeof deps.exposure === "object" && deps.exposure.settings
    ? deps.exposure : null;
  const exposure = exposureDeps === null ? null : createExposureStep({ ...exposureDeps, store, clock, npcSpawn,
    budget: lowBudget, exitGraceMs: S.exitGraceMs, industryProfiles: S.industryProfilesEnabled === true,
    lossImportOn: deps.lossImportOn === true, despawnAll: (systemId, ids) => despawnAll(systemId, ids),
    admits: (wc) => admits(wc), telemetry, logger,
    spawnBackoff: createSpawnBackoff(S.spawnBackoff), ambushSpawnBackoff: createSpawnBackoff(S.spawnBackoff) });
  const rc = deps.relationColors && typeof deps.relationColors === "object"
    && typeof npcSpawn.setRelation === "function" ? deps.relationColors : null;
  const painter = rc === null ? null : createRelationPainter({
    readPlayerShips: (systemId) => {
      const seam = safeCall(rc.getHuntScene);
      return seam && typeof seam.readPlayerShips === "function" ? seam.readPlayerShips(systemId)
        : { ok: false, reason: "SEAM_UNAVAILABLE" };
    },
    readStanding: typeof rc.readStanding === "function" ? rc.readStanding : () => ({ ok: false }),
    getFactionKind: typeof rc.getFactionKind === "function" ? rc.getFactionKind : () => null,
    thresholds: huntThresholds(rc.huntSettings || {}),
    neutralPolicy: parseNeutralPolicy((rc.huntSettings || {}).neutralPolicy) || {},
    setRelation: (systemId, ids, relation) => npcSpawn.setRelation(systemId, ids, relation),
    maxStandingReadsPerPass: rc.maxStandingReadsPerPass, maxRepaintsPerPass: rc.maxRepaintsPerPass,
    bump: (name, n) => bump(name, n) });
  const sd = deps.sentries && typeof deps.sentries === "object" && deps.sentries.settings ? deps.sentries : null;
  const sentryStep = sd === null ? null : createSentryStep({ getSentries: sd.getSentries, getSeam: sd.getSeam,
    readStanding: typeof sd.readStanding === "function" ? sd.readStanding : () => ({ ok: false }),
    getFactionKind: sd.getFactionKind, isFactionEnemy: sd.isFactionEnemy,
    thresholds: huntThresholds(sd.huntSettings || {}),
    neutralPolicy: parseNeutralPolicy((sd.huntSettings || {}).neutralPolicy) || {},
    relationGroups: () => combatGroups(), settings: sd.settings, pumpMs: S.pumpMs, telemetry, nowMs,
    strengthGroups: sd.strengthGroups || null,
    lneEntityIdsAll: () => lneEntityIdsOf(relationGroups()) });
  const hd = sentryStep !== null && deps.sentryHold && typeof deps.sentryHold === "object" && deps.sentryHold.settings
    ? deps.sentryHold : null;
  const sentryHold = hd === null ? null : createSentryHoldStep({ store, clock, npcSpawn, budget: lowBudget,
    lossTracker: hd.lossTracker || createLossTracker({ maxPending: 0 }), lossImportOn: deps.lossImportOn === true,
    despawnAll: (systemId, ids) => despawnAll(systemId, ids), admits: (wc) => admits(wc),
    getFleetExposure: hd.getFleetExposure, getFleets: hd.getFleets, getSentries: hd.getSentries,
    getSentrySeam: hd.getSentrySeam, getHuntScene: hd.getHuntScene,
    hostility: { readStanding: typeof hd.readStanding === "function" ? hd.readStanding : () => ({ ok: false }),
      getFactionKind: hd.getFactionKind, thresholds: huntThresholds(hd.huntSettings || {}),
      neutralPolicy: parseNeutralPolicy((hd.huntSettings || {}).neutralPolicy) || {},
      isFactionEnemy: typeof hd.isFactionEnemy === "function" ? hd.isFactionEnemy : null,
      maxReads: hd.maxStandingReads },
    strengthGroups: hd.strengthGroups || {}, settings: hd.settings, retreatLossPermille: hd.retreatLossPermille,
    exitGraceMs: S.exitGraceMs, invaderProfiles: S.invaderProfilesEnabled === true,
    gridEnabled: hd.gridEnabled === true, telemetry, logger, nowMs,
    spawnBackoff: createSpawnBackoff(S.spawnBackoff) });
  const pd = deps.presence && typeof deps.presence === "object" && deps.presence.settings ? deps.presence : null;
  const presenceStep = pd === null ? null : createPresenceStep({ store, clock, npcSpawn, budget,
    settings: pd.settings, heldSettings: pd.heldSettings || {}, capital,
    lossTracker: pd.lossTracker || createLossTracker({ maxPending: 0 }), lossImportOn: deps.lossImportOn === true,
    despawnAll: (systemId, ids) => despawnAll(systemId, ids), admits: (wc) => admits(wc),
    getFleetExposure: pd.getFleetExposure, getFleets: pd.getFleets, getHuntScene: pd.getHuntScene,
    getBeltNavyScene: pd.getBeltNavyScene, worldSeed: pd.worldSeed, getOwnedFleetIds: () => ownedFleetIds(),
    ownerFactionIds: [...ownerFactions], invaderProfiles: S.invaderProfilesEnabled === true,
    industryProfiles: S.industryProfilesEnabled === true, maxFleetReads: pd.maxFleetReads,
    readStanding: pd.readStanding, getFactionKind: pd.getFactionKind, huntSettings: pd.huntSettings,
    excludedFactionIds: pd.excludedFactionIds, getGraph: pd.getGraph, telemetry, logger, nowMs,
    spawnBackoff: createSpawnBackoff(S.spawnBackoff) });

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`materialization.${name}`, n);
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
    let liveBattles = 0;
    let liveShips = 0;
    for (const e of registry.list()) {
      if (e.state !== "LIVE") continue;
      liveBattles += 1;
      if (!e.despawned) liveShips += e.spawned.length;
    }
    const sizes = registry.sizes();
    gauge("materialization.liveBattles", liveBattles);
    gauge("materialization.liveShips", liveShips);
    gauge("materialization.revertPending", sizes.revertPending);
    gauge("materialization.strayShips", sizes.strays);
    gauge("materialization.failedBattles", sizes.failedBattles);
    let reserveLeftTotal = 0;
    for (const e of registry.list()) if (e.state === "LIVE") reserveLeftTotal += reserveLeft(e);
    gauge("materialization.waveReserveLeft", reserveLeftTotal);
    const dormancy = dormancyStats();
    if (dormancy.protected !== null) gauge("materialization.dormancyProtected", dormancy.protected);
  }

  function dormancyStats() {
    const stats = readDormancyGuardStats === null ? null : safeCall(readDormancyGuardStats);
    const num = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
    return { protected: stats ? num(stats.protected) : null, blocked: stats ? num(stats.blocked) : null };
  }

  function tx(name, fn) {
    const r = store.transaction(`materialization.${name}`, fn);
    if (r && r.ok) return r.value;
    return { ok: false, reason: (r && r.reason) || "TX_FAILED",
      ...(r && r.error ? { detail: messageOf(r.error) } : {}) };
  }

  function refuse(out, reason, battleId) {
    const key = String(reason);
    out.refused[key] = (out.refused[key] || 0) + 1;
    lastRefusal = { reason: key, battleId: battleId || null, at: clock.now() };
  }

  function sceneAdmits(systemId, n) {
    return sceneRefusalOf(npcSpawn, systemId, n, SCENE_SOURCE);
  }

  function admits(workClass) {
    const governor = safeCall(getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    try {
      return governor.admits(workClass) !== false;
    } catch (_err) {
      return true;
    }
  }

  function newBattleWorkClass() {
    return S.playerBattlesLiveWorkEnabled === true ? WORK_CLASS_PLAYER_BATTLE : WORK_CLASS_NEW;
  }

  function usablePresence() {
    const p = safeCall(getPresence);
    if (!p || typeof p.getStatus !== "function" || typeof p.isObserved !== "function"
      || typeof p.observedSystems !== "function" || typeof p.getSystemPresence !== "function") return null;
    const st = safeCall(() => p.getStatus());
    return st && st.available === true && st.stale !== true ? p : null;
  }

  const idsOf = (e) => e.spawned.map((s) => s.entityId);
  const reserveLeft = (e) => (e && e.reserve ? e.reserve.A.length + e.reserve.B.length : 0);

  function rememberStray(entityId, systemId) {
    if (S.despawnRetryPasses === 0) {
      bump("despawnAbandoned");
      return;
    }
    const dropped = registry.addStray(entityId, systemId);
    if (dropped > 0) bump("despawnAbandoned", dropped);
  }

  function despawnAll(systemId, entityIds) {
    if (entityIds.length === 0) return;
    let r;
    try {
      r = npcSpawn.despawn(systemId, entityIds);
    } catch (err) {
      r = { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
    }
    if (r && Number.isSafeInteger(r.purged) && r.purged > 0) bump("despawnPurged", r.purged);
    if (r && r.ok === true) {
      if (r.missing > 0) bump("despawnMissing", r.missing);
      return;
    }
    bump("despawnFailed");
    const failed = r && r.reason === "DESPAWN_FAILED" && Array.isArray(r.failed) ? r.failed : entityIds;
    if (r && r.missing > 0) bump("despawnMissing", r.missing);
    for (const id of failed) rememberStray(id, systemId);
  }

  function logLimited(limit, now, line) {
    if (limit(now)) logger.log(line);
  }

  function revertTx(battleId, claimSeq, reason) {
    return tx("revert", (db) => {
      const read = battleLive.readLiveInTx(db, battleId);
      if (!read.ok) return read;
      const b = read.battle;
      if (b.state !== "CLAIMED" || b.mode !== LIVE_MODE || b.claimSeq !== claimSeq) {
        return { ok: false, reason: "NOT_MATERIALIZING", state: b.state, mode: b.mode };
      }
      return battleLive.revertLiveClaimInTx(db, { battleId, expectedVersion: b.version, claimSeq, at: clock.now(),
        reason });
    });
  }

  function rollback(entry, reason, kind, now, out) {
    const others = registry.ownedEntityIds(entry.battleId);
    despawnAll(entry.systemId, idsOf(entry).filter((id) => !others.has(id)));
    budget.release(entry.reservationId);
    lossTracker.untrack(entry.battleId);
    registry.remove(entry.battleId);
    const r = revertTx(entry.battleId, entry.claimSeq, reason);
    if (r && r.ok === true) {
      bump("reverted");
      out.reverted.push(entry.battleId);
    } else if (r && REVERT_GONE.includes(r.reason)) {
      logLimited(errorLog, now, `materialization: rollback ${entry.battleId} - battle no longer claimed (${r.reason})`);
    } else {
      registry.addRevertPending(entry.battleId, { systemId: entry.systemId, claimSeq: entry.claimSeq, reason,
        attempts: 1 });
      bump("revertFailed");
      logLimited(errorLog, now, `materialization: revert ${entry.battleId} pending - `
        + `${(r && r.reason) || "no result"}`);
    }
    registry.setFailed(entry.battleId, entry.systemId, now + S.retryAfterFailMs, reason);
    bump(kind);
  }

  function stepPendingReverts(now, out) {
    for (const p of registry.revertPendingList()) {
      const r = revertTx(p.battleId, p.claimSeq, p.reason);
      if (r && r.ok === true) {
        registry.removeRevertPending(p.battleId);
        bump("reverted");
        out.reverted.push(p.battleId);
      } else if (r && REVERT_GONE.includes(r.reason)) {
        registry.removeRevertPending(p.battleId);
        logLimited(errorLog, now, `materialization: pending revert ${p.battleId} dropped - ${r.reason}`);
      } else {
        const entry = registry.getRevertPending(p.battleId);
        if (entry) entry.attempts += 1;
        bump("revertFailed");
      }
    }
  }

  function stepStrays(now) {
    for (const s of registry.strayList()) {
      let r;
      try {
        r = npcSpawn.despawn(s.systemId, [s.entityId]);
      } catch (err) {
        r = { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
      }
      if (r && r.ok === true) {
        registry.removeStray(s.entityId);
        continue;
      }
      const stray = registry.getStray(s.entityId);
      stray.attempts += 1;
      if (stray.attempts >= S.despawnRetryPasses) {
        registry.removeStray(s.entityId);
        bump("despawnAbandoned");
        logLimited(errorLog, now, `materialization: stray ship ${s.entityId} in ${s.systemId} abandoned - `
          + `${(r && (r.detail || r.reason)) || "no result"}`);
      }
    }
  }

  function exitCondition(e, presence) {
    if (e.despawned) return true;
    if (presence.isObserved(e.systemId) !== true) return true;
    if (npcSpawn.isSceneLoaded(e.systemId) !== true) return true;
    return npcSpawn.countAlive(e.systemId, idsOf(e)) === 0 && reserveLeft(e) === 0;
  }

  function despawnAndRelease(e) {
    if (e.despawned) return;
    despawnAll(e.systemId, idsOf(e));
    budget.release(e.reservationId);
    e.despawned = true;
  }

  function forget(e) {
    lossTracker.untrack(e.battleId);
    registry.remove(e.battleId);
  }

  function stepLosses(now) {
    const losses = lossTracker.drain();
    if (losses.length === 0) return;
    const r = tx("losses", (db) => {
      const n = { imported: 0, stale: 0, failed: 0, lost: [] };
      for (const l of losses) {
        const m = battleLive.markDestroyedInTx(db, { battleId: l.battleId, memberKey: l.memberKey });
        if (m && m.ok === true) {
          n.lost.push(l);
          if (m.duplicate !== true) n.imported += 1;
        } else if (m && LOSS_STALE.includes(m.reason)) n.stale += 1;
        else n.failed += 1;
      }
      return { ok: true, ...n };
    });
    if (!r || r.ok !== true) {
      bump("lossFailed", losses.length);
      logLimited(errorLog, now, `materialization: losses not imported (${losses.length}) - `
        + `${(r && r.reason) || "no result"}`);
      return;
    }
    for (const l of r.lost) {
      const entry = registry.get(l.battleId);
      if (!entry) continue;
      if (!entry.lostKeys) entry.lostKeys = new Set();
      entry.lostKeys.add(l.memberKey);
    }
    bump("lossImported", r.imported);
    bump("lossStale", r.stale);
    bump("lossFailed", r.failed);
  }

  function stepOwnership() {
    const live = registry.list().filter((e) => e.state === "LIVE");
    if (live.length === 0) return;
    const r = tx("ownership", (db) => {
      const gone = [];
      for (const e of live) {
        const read = battleLive.readLiveInTx(db, e.battleId);
        if (!read || read.ok !== true) {
          if (read && read.reason === "BATTLE_NOT_FOUND") gone.push(e.battleId);
          continue;
        }
        if (read.battle.state !== "LIVE" || read.battle.mode !== LIVE_MODE) gone.push(e.battleId);
      }
      return { ok: true, gone };
    });
    if (!r || r.ok !== true) return;
    for (const battleId of r.gone) {
      const e = registry.get(battleId);
      if (!e) continue;
      despawnAndRelease(e);
      forget(e);
      bump("externallyEnded");
    }
  }

  function stepStructures(now) {
    if (structureSeam === null) return;
    for (const e of registry.list()) {
      if (e.state !== "LIVE" || e.structure === null || e.structureDestroyed) continue;
      let v;
      try {
        v = structureSeam.getStructure(e.structure.structureId);
      } catch (err) {
        v = { ok: false, reason: "SEAM_THREW", detail: messageOf(err) };
      }
      if (!v || v.ok !== true) {
        bump("structureReadFailed");
        logLimited(errorLog, now, `materialization: structure ${e.structure.structureId} of ${e.battleId} not read - `
          + `${(v && v.reason) || "no result"}`);
        continue;
      }
      if (!v.row || !v.row.destroyedAt) continue;
      e.structureDestroyed = true;
      if (e.exitReason !== null) continue;
      e.exitReason = STRUCTURE_REASON;
      e.exitCause = null;
      e.exitSince = now;
    }
  }

  function stepWaves(now, presence) {
    let spawnedThisPass = 0;
    for (const e of registry.list()) {
      if (spawnedThisPass >= S.waveMaxSpawnsPerPass) break;
      if (e.state !== "LIVE" || e.despawned || reserveLeft(e) === 0) continue;
      if (e.exitReason !== null || now < e.waveBlockedUntil) continue;
      if (!admits(newBattleWorkClass()) || presence.isObserved(e.systemId) !== true
        || npcSpawn.isSceneLoaded(e.systemId) !== true) {
        bump("waveDeferred");
        continue;
      }
      const alive = new Set(npcSpawn.listAlive(e.systemId, idsOf(e)));
      const hullOf = (id) => ({ hullGroup: e.hullGroupOf instanceof Map ? e.hullGroupOf.get(id) : undefined });
      const aliveOf = (ids) => ids.filter((id) => alive.has(id));
      const aliveSlots = { A: capital.slotsOf(aliveOf(e.sideA).map(hullOf)),
        B: capital.slotsOf(aliveOf(e.sideB).map(hullOf)) };
      const pick = pickRefill({ reserve: e.reserve, quota: e.quota, aliveSlots },
        { budget: S.waveMaxSpawnsPerPass - spawnedThisPass, slotsOf: capital.slotsOf });
      const okA = aliveOf(e.sideB).length > 0 || pick.B.length > 0;
      const okB = aliveOf(e.sideA).length > 0 || pick.A.length > 0;
      if (!okA) pick.A = [];
      if (!okB) pick.B = [];
      const n = pick.A.length + pick.B.length;
      if (n === 0) continue;
      if (sceneAdmits(e.systemId, n) !== null) {
        bump("waveDeferred");
        continue;
      }
      spawnedThisPass += n;
      refillWave(e, pick, alive, now);
    }
  }

  function refillWave(e, pick, alive, now) {
    const added = { A: [], B: [] };
    const newIds = [];
    try {
      for (const side of ["A", "B"]) {
        for (const m of pick[side]) {
          const r = npcSpawn.spawnShip(e.systemId, spawnSpecOf(m, e.anchor, e.owners, e.anchorRadiusMeters));
          if (!r || r.ok !== true) throw new StepError((r && r.reason) || "SPAWN_FAILED", "spawnFailed", r && r.detail);
          if (registry.ownedEntityIds(e.battleId).has(r.entityId) || idsOf(e).includes(r.entityId)
            || newIds.includes(r.entityId)) {
            throw new StepError("ENTITY_REUSED", "spawnFailed", `entity ${r.entityId}`);
          }
          newIds.push(r.entityId);
          added[side].push({ m, entityId: r.entityId });
        }
      }
      const targetsOf = { A: [...e.sideB.filter((id) => alive.has(id)), ...added.B.map((x) => x.entityId)],
        B: [...e.sideA.filter((id) => alive.has(id)), ...added.A.map((x) => x.entityId)] };
      for (const side of ["A", "B"]) {
        if (added[side].length === 0) continue;
        const ids = added[side].map((x) => x.entityId);
        const capitalIds = new Set(added[side].filter((x) => capital.isCapital(x.m.hullGroup)).map((x) => x.entityId));
        const engaged = npcSpawn.engage(e.systemId, ids, targetsOf[side], { aggroPlayers: S.aggroPlayers === true,
          targetMode: S.targetMode, attackersOnly: true, ...(capitalIds.size > 0 ? { capitalIds } : {}) });
        if (!engaged || engaged.ok !== true) {
          throw new StepError((engaged && engaged.reason) || "ENGAGE_FAILED", "spawnFailed", engaged && engaged.detail);
        }
      }
      const pub = npcSpawn.publish(e.systemId, newIds);
      if (!pub || pub.ok !== true) throw new StepError("PUBLISH_FAILED", "publishFailed", pub && (pub.detail || pub.reason));
      if (!(pub.published >= newIds.length)) {
        throw new StepError("PUBLISH_PARTIAL", "publishFailed", `published ${pub.published} of ${newIds.length}`);
      }
      const spawned = [...added.A, ...added.B].map((x) => ({ memberKey: x.m.memberKey, entityId: x.entityId }));
      const w = tx("wave", (db) => battleLive.spawnReserveInTx(db, { battleId: e.battleId, claimSeq: e.claimSeq,
        bootAt, spawned }));
      if (!w || w.ok !== true) throw new StepError((w && w.reason) || "WAVE_FAILED", "spawnFailed", w && w.detail);
      for (const side of ["A", "B"]) {
        const own = side === "A" ? e.sideA : e.sideB;
        const targets = targetsOf[side];
        added[side].forEach((x, i) => {
          e.spawned.push({ memberKey: x.m.memberKey, entityId: x.entityId });
          own.push(x.entityId);
          noteMember(e, x.m, x.entityId);
          e.targetOf.set(x.entityId, targets[i % targets.length]);
        });
        const gone = new Set(added[side].map((x) => x.m));
        e.reserve[side] = e.reserve[side].filter((m) => !gone.has(m));
      }
      e.lastWaveAt = now;
      lossTracker.track(e.battleId, spawned);
      bump("waveShipsSpawned", spawned.length);
      capital.noteSpawned(capital.countOf([...added.A, ...added.B].map((x) => x.m)));
      return true;
    } catch (err) {
      despawnAll(e.systemId, newIds);
      e.waveBlockedUntil = now + S.retryAfterFailMs;
      bump("waveSpawnFailed");
      const reason = err instanceof StepError ? err.reason : "WAVE_THREW";
      const detail = err instanceof StepError ? err.detail : messageOf(err);
      logLimited(errorLog, now, `materialization: wave ${e.battleId} not spawned - ${reason}${detail ? ` ${detail}` : ""}`);
      return false;
    }
  }

  function exitReasonOf(e, presence, now) {
    if (e.structureDestroyed === true) return { reason: STRUCTURE_REASON, cause: null };
    if (exitCondition(e, presence)) return { reason: EXIT_REASON, cause: null };
    const waiting = reserveLeft(e) > 0;
    if (!liveEnd.enabled) {
      if (!waiting || (e.reserve.A.length > 0 && e.reserve.B.length > 0)) return null;
      return npcSpawn.countAlive(e.systemId, idsOf(e)) === 0 ? { reason: EXIT_REASON, cause: null } : null;
    }
    const alive = new Set(npcSpawn.listAlive(e.systemId, idsOf(e)));
    const since = e.lastWaveAt === null || e.liveSince === null ? e.liveSince : Math.max(e.liveSince, e.lastWaveAt);
    return classifyLiveEnd({ aliveA: e.sideA.filter((id) => alive.has(id)).length + e.reserve.A.length,
      aliveB: e.sideB.filter((id) => alive.has(id)).length + e.reserve.B.length, liveSince: since, now,
      timeoutMs: liveEnd.timeoutMs });
  }

  function stepExits(now, presence, out) {
    let exits = 0;
    for (const e of registry.list()) {
      if (exits >= S.maxExitsPerPass) break;
      if (e.state !== "LIVE") continue;
      const why = exitReasonOf(e, presence, now);
      if (why === null) {
        e.exitSince = null;
        e.exitReason = null;
        e.exitCause = null;
        continue;
      }
      if (e.exitSince === null) {
        e.exitSince = now;
        e.exitReason = why.reason;
        e.exitCause = why.cause;
      }
      if (!e.despawned && !e.structureDestroyed && now - e.exitSince < S.exitGraceMs) continue;
      exits += 1;
      despawnAndRelease(e);
      const reason = e.exitReason;
      const req = e.structure === null ? { battleId: e.battleId, at: clock.now(), reason }
        : { battleId: e.battleId, at: clock.now(), reason, structure: { destroyed: e.structureDestroyed === true } };
      const r = tx("exit", (db) => battleLive.exitLiveInTx(db, req));
      if (r && r.ok === true) {
        forget(e);
        bump("exited");
        if (reason === STRUCTURE_REASON) {
          if (r.duplicate !== true && r.outcome === "COMPLETED") bump("structureExited");
        } else if (reason !== EXIT_REASON) {
          bump(e.exitCause === TIMEOUT_CAUSE ? "battleEndTimeout" : "battleEndDetected");
        }
        out.exited.push(e.battleId);
      } else if (r && (r.permanent === true || PERMANENT_EXIT.includes(r.reason))) {
        forget(e);
        bump("exitFailed");
        logger.log(`materialization: exit ${e.battleId} refused - ${r.reason} (left to the restart recovery)`);
      } else {
        bump("exitFailed");
        logLimited(errorLog, now, `materialization: exit ${e.battleId} failed - ${(r && r.reason) || "no result"}`);
      }
    }
  }

  function stepRetarget() {
    let orders = 0;
    for (const e of registry.list()) {
      if (orders >= S.maxRetargetsPerPass) return orders;
      if (e.state !== "LIVE" || e.despawned) continue;
      const alive = new Set(npcSpawn.listAlive(e.systemId, idsOf(e)));
      for (const [own, opposite] of [[e.sideA, e.sideB], [e.sideB, e.sideA]]) {
        const enemies = opposite.filter((id) => alive.has(id));
        if (enemies.length === 0) continue;
        for (let i = 0; i < own.length; i += 1) {
          const ship = own[i];
          if (!alive.has(ship) || alive.has(e.targetOf.get(ship))) continue;
          if (orders >= S.maxRetargetsPerPass) return orders;
          orders += 1;
          const target = enemies[i % enemies.length];
          const r = npcSpawn.orderAttack(e.systemId, ship, target);
          if (r && r.ok === true) {
            e.targetOf.set(ship, target);
            bump("retargeted");
          }
        }
      }
    }
    return orders;
  }

  function unsupported(b, systemId, reason, detail, now) {
    if (b.state === "PENDING") {
      const r = tx("unsupported", (db) => battleLive.markUnsupportedInTx(db, { battleId: b.battleId,
        expectedVersion: b.version, reason }));
      if (!r || r.ok !== true) {
        logLimited(errorLog, now, `materialization: unsupported ${b.battleId} not marked - ${(r && r.reason)}`);
        return;
      }
    } else {
      registry.setFailed(b.battleId, systemId, Infinity, reason);
    }
    bump("unsupported");
    const text = detail === undefined || detail === null || detail === "" ? "-" : String(detail).slice(0, MAX_DETAIL);
    logLimited(unsupportedLog, now, `materialization: unsupported ${b.battleId} ${reason} ${text}`);
  }

  function profilesOf(b, members) {
    const options = { seedPrefix: b.battleId, invaders: S.invaderProfilesEnabled === true,
      industry: S.industryProfilesEnabled === true };
    let profiles = npcSpawn.resolveProfiles(members.map((m) => ({ memberKey: m.memberKey,
      factionId: m.factionId, hullGroup: m.hullGroup, typeId: m.typeId })), options);
    if (profiles && profiles.ok === true) return { ok: true, profiles: profiles.profiles, fallbacks: 0 };
    if (S.profileFallbackEnabled === true && profiles && profiles.reason === "NO_PROFILE"
      && profiles.detail !== CAPITAL_NO_PROFILE_DETAIL) {
      const fb = fallbackProfilesOf(members, options);
      if (fb.ok === true) return fb;
      profiles = fb.refusal;
    }
    capital.noteRefused(profiles, `battle ${b.battleId}`);
    const reason = (profiles && profiles.reason) || "NO_PROFILE";
    const detail = profiles && (profiles.detail
      || (profiles.factionId !== undefined ? `faction ${profiles.factionId} ${profiles.hullGroup}` : null));
    return { ok: false, permanent: PERMANENT_PLAN.includes(reason), reason, detail };
  }

  function fallbackProfilesOf(members, options) {
    const profiles = [];
    let fallbacks = 0;
    for (const m of members) {
      let found = null;
      let refusal = null;
      for (const hullGroup of [m.hullGroup, ...fallbackChainOf(m.hullGroup)]) {
        const own = hullGroup === m.hullGroup;
        const r = npcSpawn.resolveProfiles([{ memberKey: m.memberKey, factionId: m.factionId, hullGroup,
          typeId: own ? m.typeId : null }], options);
        if (r && r.ok === true && Array.isArray(r.profiles) && typeof r.profiles[0] === "string") {
          found = { profileId: r.profiles[0], own };
          break;
        }
        if (refusal === null) refusal = r;
        if (!r || r.reason !== "NO_PROFILE" || r.detail === CAPITAL_NO_PROFILE_DETAIL) break;
      }
      if (found === null) return { ok: false, refusal: refusal || { ok: false, reason: "NO_PROFILE" } };
      profiles.push(found.profileId);
      if (!found.own) fallbacks += 1;
    }
    return { ok: true, profiles, fallbacks };
  }

  function planBattle(b, systemId) {
    const fixed = planFixed(b, systemId);
    if (fixed.ok === true || fixed.reason !== "LIVE_TOO_LARGE" || S.wavesEnabled !== true) return fixed;
    return planWaves(b, systemId);
  }

  function planWaves(b, systemId) {
    const tooLarge = (detail) => {
      bump("waveTooLarge");
      return { ok: false, permanent: true, reason: "LIVE_TOO_LARGE", detail };
    };
    const plan = battleLive.planMembers(b.input, { maxShips: S.waveMaxMembers });
    if (!plan.ok) {
      if (plan.reason === "LIVE_TOO_LARGE") return tooLarge(`ships ${plan.ships} > waveMaxMembers ${plan.limit}`);
      return { ok: false, permanent: true, reason: plan.reason, detail: plan.detail };
    }
    const hasGarrison = Boolean(b.input && b.input.garrison !== null && b.input.garrison !== undefined);
    let garrison = { members: [], ships: 0 };
    if (hasGarrison) {
      const gp = battleLive.planGarrison(b.input, { maxShips: garrisonLive.maxShips,
        pointsPerShip: garrisonLive.pointsPerShip, hullGroup: garrisonLive.hullGroup,
        room: S.waveMaxMembers - plan.ships });
      if (!gp || gp.ok !== true) {
        const reason = (gp && gp.reason) || "INPUT_INVALID";
        if (reason === "LIVE_TOO_LARGE") return tooLarge(`garrison ${gp.ships} > room ${gp.limit}`);
        return { ok: false, permanent: PERMANENT_PLAN.includes(reason), reason, detail: gp && gp.detail };
      }
      garrison = gp;
    }
    const all = [...plan.members, ...garrison.members];
    const profiles = profilesOf(b, all);
    if (profiles.ok !== true) return profiles;
    const members = all.map((m, i) => ({ ...m, profileId: profiles.profiles[i] }));
    const wp = planWave(members, { maxShips: Math.min(S.waveMaxShips, S.maxShipsPerBattle),
      maxSlots: S.maxLiveMaterializationsPerSystem, slotsOf: capital.slotsOf });
    if (!wp.ok) return { ok: false, permanent: true, reason: "LIVE_TOO_LARGE", detail: wp.detail };
    const anchor = anchorFor(b, systemId, garrison.ships > 0);
    if (!anchor || anchor.ok !== true) {
      const reason = (anchor && anchor.reason) || "NO_ANCHOR";
      return { ok: false, permanent: PERMANENT_PLAN.includes(reason), reason, detail: anchor && anchor.detail };
    }
    const waveGarrison = wp.wave.filter((m) => m.fleetId === GARRISON_FLEET_ID).length;
    return { ok: true, members, wave: wp.wave, reserve: wp.reserve, quota: wp.quota, slots: wp.slots,
      ships: wp.wave.length, garrisonShips: waveGarrison, capitals: capital.countOf(wp.wave),
      fallbacks: profiles.fallbacks, anchor: anchor.anchorDescriptor, anchorRadiusMeters: anchor.radiusMeters,
      anchorFallback: anchor.fallback, anchorFromGrid: anchor.fromGrid };
  }

  function planFixed(b, systemId) {
    const hasGarrison = Boolean(b.input && b.input.garrison !== null && b.input.garrison !== undefined);
    if (hasGarrison && !(garrisonLive && garrisonLive.enabled === true)) {
      return { ok: false, permanent: true, reason: "GARRISON_UNSUPPORTED", detail: null };
    }
    const plan = battleLive.planMembers(b.input, { maxShips: S.maxShipsPerBattle });
    if (!plan.ok) {
      return { ok: false, permanent: true, reason: plan.reason,
        detail: plan.reason === "LIVE_TOO_LARGE" ? `ships ${plan.ships} > ${plan.limit}` : plan.detail };
    }
    const slots = capital.slotsOf(plan.members);
    if (slots > S.maxLiveMaterializationsPerSystem) {
      if (capital.countOf(plan.members) > 0) {
        const refused = profilesOf(b, plan.members);
        if (refused.ok !== true) return refused;
      }
      return { ok: false, permanent: true, reason: "LIVE_TOO_LARGE",
        detail: `ships ${slots} > limits.maxLiveMaterializationsPerSystem ${S.maxLiveMaterializationsPerSystem}` };
    }
    let garrison = { members: [], ships: 0 };
    if (hasGarrison) {
      const room = Math.min(S.maxShipsPerBattle - plan.ships, S.maxLiveMaterializationsPerSystem - slots);
      const gp = battleLive.planGarrison(b.input, { maxShips: garrisonLive.maxShips,
        pointsPerShip: garrisonLive.pointsPerShip, hullGroup: garrisonLive.hullGroup, room });
      if (!gp || gp.ok !== true) {
        const reason = (gp && gp.reason) || "INPUT_INVALID";
        return { ok: false, permanent: PERMANENT_PLAN.includes(reason), reason,
          detail: reason === "LIVE_TOO_LARGE" ? `garrison ${gp.ships} > room ${gp.limit}` : gp && gp.detail };
      }
      garrison = gp;
    }
    const all = [...plan.members, ...garrison.members];
    const profiles = profilesOf(b, all);
    if (profiles.ok !== true) return profiles;
    const anchor = anchorFor(b, systemId, garrison.ships > 0);
    if (!anchor || anchor.ok !== true) {
      const reason = (anchor && anchor.reason) || "NO_ANCHOR";
      return { ok: false, permanent: PERMANENT_PLAN.includes(reason), reason, detail: anchor && anchor.detail };
    }
    const members = all.map((m, i) => ({ ...m, profileId: profiles.profiles[i] }));
    return { ok: true, members, ships: plan.ships + garrison.ships, garrisonShips: garrison.ships,
      slots: slots + garrison.ships, capitals: capital.countOf(plan.members), fallbacks: profiles.fallbacks,
      anchor: anchor.anchorDescriptor,
      anchorRadiusMeters: anchor.radiusMeters, anchorFallback: anchor.fallback, anchorFromGrid: anchor.fromGrid };
  }

  function anchorFor(b, systemId, withGarrison) {
    let fallback = null;
    if (S.gridAnchorEnabled === true && b.grid) {
      if (typeof npcSpawn.pickGridAnchor === "function") {
        const g = npcSpawn.pickGridAnchor(systemId, b.grid);
        if (g && g.ok === true) {
          return { ok: true, anchorDescriptor: g.anchorDescriptor, radiusMeters: g.radiusMeters, fallback: null,
            fromGrid: true };
        }
        fallback = (g && g.reason) || "GRID_ANCHOR_UNKNOWN";
      } else fallback = "SEAM_UNAVAILABLE";
    }
    const a = withGarrison ? npcSpawn.pickAnchor(systemId, GARRISON_ANCHOR) : npcSpawn.pickAnchor(systemId);
    if (!a || a.ok !== true) return a;
    return { ok: true, anchorDescriptor: a.anchorDescriptor, radiusMeters: 0, fallback, fromGrid: false };
  }

  function ownersInTx(db, battle) {
    const owners = new Map();
    if (ownerFactions.size === 0) return owners;
    try {
      const maxShips = S.wavesEnabled === true ? Math.max(S.waveMaxMembers, S.maxShipsPerBattle) : S.maxShipsPerBattle;
      const plan = battleLive.planMembers(battle.input, { maxShips });
      if (!plan || plan.ok !== true) return owners;
      const ids = [...new Set(plan.members.filter((m) => ownerFactions.has(m.factionId)).map((m) => m.fleetId))];
      if (ids.length === 0) return owners;
      const fleets = safeCall(getFleets);
      const repo = fleets && fleets.repository;
      if (!repo || typeof repo.getFleets !== "function") return owners;
      const r = repo.getFleets(db, ids);
      if (!r || r.ok !== true || !Array.isArray(r.fleets)) return owners;
      for (const f of r.fleets) {
        if (f && ownerFactions.has(f.factionId) && Number.isSafeInteger(f.corporationId) && f.corporationId > 0) {
          owners.set(f.fleetId, f.corporationId);
        }
      }
      return owners;
    } catch (_err) {
      return new Map();
    }
  }

  function spawnSpecOf(m, anchor, owners, radiusMeters) {
    const radius = Number.isFinite(radiusMeters) && radiusMeters > 0 ? radiusMeters : 0;
    const isCapital = capital.isCapital(m.hullGroup) && capital.distanceMeters !== null;
    const base = isCapital ? capital.distanceMeters : S.anchorDistanceMeters;
    const distance = (m.side === "B" ? base : base + S.sideSeparationMeters) + radius;
    const spec = { profileId: m.profileId, anchorDescriptor: anchor, spawnDistanceMeters: distance,
      source: SCENE_SOURCE };
    if (m.fleetId !== GARRISON_FLEET_ID && ownerFactions.has(m.factionId)) {
      const ownerId = owners instanceof Map ? owners.get(m.fleetId) : undefined;
      if (ownerId !== undefined) spec.ownerId = ownerId;
      else bump("ownerUnknown");
    }
    return spec;
  }

  function noteMember(entry, m, entityId) {
    if (entry.factionOf instanceof Map && Number.isSafeInteger(m.factionId)) entry.factionOf.set(entityId, m.factionId);
    if (typeof m.hullGroup === "string") {
      if (!(entry.hullGroupOf instanceof Map)) entry.hullGroupOf = new Map();
      entry.hullGroupOf.set(entityId, m.hullGroup);
    }
    if (m.fleetId !== GARRISON_FLEET_ID && typeof m.fleetId === "string") {
      if (!entry.fleetOfMember) entry.fleetOfMember = new Map();
      entry.fleetOfMember.set(m.memberKey, m.fleetId);
    }
  }

  function spawnAndGoLive(entry, members, anchor, owners, radiusMeters = 0, reserveKeys = undefined) {
    const capitalIds = new Set();
    for (const m of members) {
      const spec = spawnSpecOf(m, anchor, owners, radiusMeters);
      const r = npcSpawn.spawnShip(entry.systemId, spec);
      if (!r || r.ok !== true) throw new StepError((r && r.reason) || "SPAWN_FAILED", "spawnFailed", r && r.detail);
      if (registry.ownedEntityIds(entry.battleId).has(r.entityId) || idsOf(entry).includes(r.entityId)) {
        throw new StepError("ENTITY_REUSED", "spawnFailed", `entity ${r.entityId}`);
      }
      entry.spawned.push({ memberKey: m.memberKey, entityId: r.entityId });
      if (capital.isCapital(m.hullGroup)) capitalIds.add(r.entityId);
      noteMember(entry, m, r.entityId);
      (m.side === "A" ? entry.sideA : entry.sideB).push(r.entityId);
    }
    const engaged = npcSpawn.engage(entry.systemId, entry.sideA, entry.sideB, { aggroPlayers: S.aggroPlayers === true,
      targetMode: S.targetMode, ...(capitalIds.size > 0 ? { capitalIds } : {}) });
    if (!engaged || engaged.ok !== true) {
      throw new StepError((engaged && engaged.reason) || "ENGAGE_FAILED", "spawnFailed", engaged && engaged.detail);
    }
    for (const [own, opposite] of [[entry.sideA, entry.sideB], [entry.sideB, entry.sideA]]) {
      own.forEach((id, i) => entry.targetOf.set(id, opposite[i % opposite.length]));
    }
    const ids = idsOf(entry);
    const pub = npcSpawn.publish(entry.systemId, ids);
    if (!pub || pub.ok !== true) {
      throw new StepError("PUBLISH_FAILED", "publishFailed", pub && (pub.detail || pub.reason));
    }
    if (!(pub.published >= ids.length)) {
      throw new StepError("PUBLISH_PARTIAL", "publishFailed", `published ${pub.published} of ${ids.length}`);
    }
    const live = tx("live", (db) => battleLive.markLiveInTx(db, { battleId: entry.battleId,
      expectedVersion: entry.version, claimSeq: entry.claimSeq, bootAt,
      spawned: entry.spawned.map((s) => ({ ...s })), ...(reserveKeys === undefined ? {} : { reserve: reserveKeys }) }));
    if (!live || live.ok !== true) {
      throw new StepError((live && live.reason) || "LIVE_FAILED", "spawnFailed", live && live.detail);
    }
    entry.state = "LIVE";
    if (Number.isSafeInteger(live.version)) entry.version = live.version;
    lossTracker.track(entry.battleId, entry.spawned);
  }

  function materialize(b, systemId, now, out, owners) {
    const planned = planBattle(b, systemId);
    if (!planned.ok) {
      if (planned.permanent) unsupported(b, systemId, planned.reason, planned.detail, now);
      else {
        if (planned.reason === "SCENE_NOT_LOADED") bump("refusedScene");
        refuse(out, planned.reason, b.battleId);
      }
      return false;
    }
    const t0 = nowMs();
    const reservationId = `mat:battle:${b.battleId}:${b.claimSeq + 1}`;
    const sceneRefusal = sceneAdmits(systemId, (Array.isArray(planned.wave) ? planned.wave : planned.members).length);
    if (sceneRefusal !== null) {
      bump("refusedBudget");
      refuse(out, sceneRefusal, b.battleId);
      return false;
    }
    if (presenceStep) {
      const fleetIds = [...new Set(planned.members.map((m) => m.fleetId)
        .filter((id) => typeof id === "string" && id !== GARRISON_FLEET_ID))];
      if (fleetIds.some((id) => presenceStep.hasPendingLoss(id))) {
        refuse(out, "PRESENCE_PENDING_LOSS", b.battleId);
        return false;
      }
      presenceStep.releaseFleets(fleetIds);
    }
    const reserved = fightBudget.reserve({ reservationId, ownerKind: "battle", ownerId: b.battleId, systemId,
      shipCount: planned.slots, metadata: { systemId } });
    if (!reserved || reserved.ok !== true) {
      bump("refusedBudget");
      refuse(out, (reserved && reserved.reason) || "BUDGET", b.battleId);
      return false;
    }
    const claimed = tx("claim", (db) => {
      const c = battleLive.claimLiveInTx(db, { battleId: b.battleId, expectedVersion: b.version }, planned.members);
      if (!c || c.ok !== true || c.duplicate !== true) return c;
      const again = battleLive.readLiveInTx(db, b.battleId);
      return { ...c, reread: again && again.ok ? again.battle : null };
    });
    if (!claimed || claimed.ok !== true) {
      budget.release(reservationId);
      bump("refusedState");
      refuse(out, (claimed && claimed.reason) || "CLAIM_FAILED", b.battleId);
      return false;
    }
    if (claimed.duplicate === true) {
      budget.release(reservationId);
      const x = claimed.reread;
      if (x && x.state === "CLAIMED" && x.mode === LIVE_MODE && x.updatedAt >= bootAt && !registry.has(b.battleId)
        && !registry.getRevertPending(b.battleId)) {
        registry.addRevertPending(b.battleId, { systemId, claimSeq: x.claimSeq, reason: "ORPHAN_CLAIM", attempts: 0 });
        bump("orphanClaim");
      }
      return false;
    }
    bump("attempted");
    if (typeof hooks.afterClaim === "function" && hooks.afterClaim(b.battleId) === false) return true;
    const entry = registry.addSpawning({ battleId: b.battleId, systemId, claimSeq: claimed.claimSeq,
      version: claimed.version, reservationId, structure: structureOf(b.input) });
    const waves = Array.isArray(planned.wave);
    if (waves) {
      entry.reserve = { A: [...planned.reserve.A], B: [...planned.reserve.B] };
      entry.quota = { A: planned.quota.A, B: planned.quota.B };
      entry.anchor = planned.anchor;
      entry.anchorRadiusMeters = planned.anchorRadiusMeters;
      entry.owners = owners instanceof Map ? owners : new Map();
    }
    try {
      if (waves) {
        spawnAndGoLive(entry, planned.wave, planned.anchor, owners, planned.anchorRadiusMeters,
          [...planned.reserve.A, ...planned.reserve.B].map((m) => m.memberKey));
      } else spawnAndGoLive(entry, planned.members, planned.anchor, owners, planned.anchorRadiusMeters);
    } catch (err) {
      const reason = err instanceof StepError ? err.reason : "SPAWN_THREW";
      const detail = err instanceof StepError ? err.detail : messageOf(err);
      logLimited(errorLog, now, `materialization: ${b.battleId} rolled back - ${reason}${detail ? ` ${detail}` : ""}`);
      rollback(entry, reason, err instanceof StepError ? err.kind : "spawnFailed", now, out);
      refuse(out, reason, b.battleId);
      return false;
    }
    entry.liveSince = now;
    bump("materialized");
    bump("shipsSpawned", entry.spawned.length);
    capital.noteSpawned(planned.capitals);
    if (waves) {
      entry.lastWaveAt = now;
      if (reserveLeft(entry) > 0) bump("wavesStarted");
    }
    if (Number.isSafeInteger(planned.fallbacks) && planned.fallbacks > 0) bump("profileFallback", planned.fallbacks);
    if (planned.anchorFromGrid === true) bump("gridAnchorUsed");
    else if (planned.anchorFallback) {
      bump("gridAnchorFallback");
      const g = b.grid || {};
      logLimited(gridLog, now, `materialization: grid anchor fallback ${b.battleId} ${g.kind}:${g.id} `
        + `${planned.anchorFallback}`);
    }
    if (planned.garrisonShips > 0) {
      bump("garrisonMaterialized");
      bump("garrisonShipsSpawned", planned.garrisonShips);
      const a = planned.anchor || {};
      logLimited(garrisonLog, now, `materialization: garrison ${b.battleId} ships=${planned.ships - planned.garrisonShips}`
        + `+${planned.garrisonShips} anchor=${a.kind}:${a.itemID}`);
    }
    observe("materialization.spawnMs", nowMs() - t0);
    out.materialized.push(b.battleId);
    return false;
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
    const at = systems.findIndex((id) => id > cursor);
    return at <= 0 ? systems : [...systems.slice(at), ...systems.slice(0, at)];
  }

  function stepNew(now, presence, out) {
    if (!admits(newBattleWorkClass())) {
      bump(candidateSystems(presence).length > 0 ? "refusedGovernor" : "governorIdlePasses");
      refuse(out, "GOVERNOR");
      return false;
    }
    let started = 0;
    for (const systemId of candidateSystems(presence)) {
      if (started >= S.maxBattlesPerPass) break;
      cursor = systemId;
      const limit = Math.min(MAX_LIST_LIMIT, S.maxBattlesPerPass + registry.failedCountInSystem(systemId));
      const read = tx("read", (db) => {
        const listed = battleLive.listMaterializableInTx(db, systemId, { limit });
        if (!listed || listed.ok !== true) return listed;
        const battles = [];
        const owners = new Map();
        let skipped = 0;
        for (const x of listed.battles) {
          if (battles.length >= S.maxBattlesPerPass - started) break;
          if (registry.has(x.battleId) || registry.getRevertPending(x.battleId)) continue;
          if (registry.isFailedBlocked(x.battleId, now)) {
            skipped += 1;
            continue;
          }
          const one = battleLive.readLiveInTx(db, x.battleId);
          if (one && one.ok) {
            battles.push(one.battle);
            owners.set(one.battle.battleId, ownersInTx(db, one.battle));
          }
        }
        return { ok: true, battles, skipped, owners };
      });
      if (!read || read.ok !== true) {
        refuse(out, (read && read.reason) || "READ_FAILED");
        continue;
      }
      bump("skippedFailed", read.skipped);
      for (const b of read.battles) {
        if (started >= S.maxBattlesPerPass) break;
        started += 1;
        if (materialize(b, systemId, now, out, read.owners.get(b.battleId))) return true;
      }
    }
    return false;
  }

  function relationGroups() {
    return collectRelationGroups(registry.list(), [[hunt, "hunt"], [patrol, "patrol"], [exposure, "exposure"],
      [sentryHold, "sentryHold"], [presenceStep, "presence"]], S.aggroPlayers === true);
  }

  function combatGroups() {
    return combatGroupsOf(relationGroups());
  }

  function ownedFleetIds() {
    const out = new Set();
    try {
      const st = budget.getStatus({ includeReservations: true });
      for (const r of (st && st.reservations) || []) {
        if (r.ownerKind === "fleet" && !String(r.reservationId).startsWith(PRESENCE_RESERVATION_PREFIX)) {
          out.add(r.ownerId);
        }
      }
      for (const e of registry.list()) {
        if (e.fleetOfMember instanceof Map) for (const id of e.fleetOfMember.values()) out.add(id);
      }
    } catch (_err) {
    }
    return out;
  }

  function runPass(nowArg) {
    const now = Number.isSafeInteger(nowArg) ? nowArg : clock.now();
    const out = { passes: passes + 1, materialized: [], exited: [], reverted: [], refused: {},
      ...(hunt ? { huntsStarted: [], huntsEnded: [] } : {}) };
    if (stopped) {
      refuse(out, "SERVICE_STOPPED");
      return out;
    }
    passes += 1;
    bump("passes");
    const t0 = nowMs();
    try {
      stepStrays(now);
      for (const e of registry.list()) {
        if (e.state === "SPAWNING") rollback(e, "ORPHAN_SPAWNING", "spawnFailed", now, out);
      }
      stepPendingReverts(now, out);
      stepLosses(now);
      if (hunt) hunt.stepPending(now, out);
      if (patrol) patrol.stepPending(now, out);
      if (exposure) exposure.stepPending(now, out);
      if (sentryHold) sentryHold.stepPending(now, out);
      if (presenceStep) presenceStep.stepPending(now, out);
      const presence = usablePresence();
      if (!presence) {
        refuse(out, "PRESENCE_UNAVAILABLE");
        return out;
      }
      stepOwnership();
      stepStructures(now);
      stepWaves(now, presence);
      stepExits(now, presence, out);
      const retargets = S.targetMode === "manual" ? stepRetarget() : 0;
      if (stepNew(now, presence, out)) {
        out.aborted = true;
        return out;
      }
      let retargetsLeft = S.maxRetargetsPerPass - retargets;
      if (hunt) {
        const h = hunt.step(now, presence, out, retargetsLeft);
        if (h.aborted) {
          out.aborted = true;
          return out;
        }
        retargetsLeft -= Number.isSafeInteger(h.retargets) ? h.retargets : 0;
      }
      if (patrol && patrol.step(now, presence, out, retargetsLeft).aborted) {
        out.aborted = true;
        return out;
      }
      if (exposure) exposure.step(now, presence, out);
      if (sentryHold) sentryHold.step(now, presence, out);
      if (presenceStep) presenceStep.step(now, presence, out);
      if (sentryStep) sentryStep.step(now, presence, out);
      if (painter) {
        try {
          painter.paint(relationGroups());
        } catch (_err) {
          bump("relationFailed");
        }
      }
      return out;
    } finally {
      publishGauges();
      observe("materialization.passMs", nowMs() - t0);
    }
  }

  function notePassError(err) {
    bump("passErrors");
    logLimited(errorLog, clock.now(), `materialization: pass threw - ${messageOf(err)}`);
  }

  function getStatus(opts) {
    const withAlive = Boolean(opts && opts.alive === true);
    const live = [];
    let spawning = 0;
    for (const e of registry.list()) {
      if (e.state === "SPAWNING") {
        spawning += 1;
        continue;
      }
      live.push({ battleId: e.battleId, systemId: e.systemId, ships: e.spawned.length,
        ...(withAlive ? { alive: e.despawned ? 0 : safeCall(() => npcSpawn.countAlive(e.systemId, idsOf(e))) } : {}),
        liveSince: e.liveSince, exitSince: e.exitSince, despawned: e.despawned,
        reserve: reserveLeft(e) });
    }
    const budgetStatus = safeCall(() => budget.getStatus());
    const failed = registry.failedList();
    return {
      state: stopped ? "stopped" : "running",
      reason: stopReason,
      bootAt,
      passes,
      budget: budgetStatus,
      live,
      spawning,
      revertPending: registry.revertPendingList(),
      strays: registry.sizes().strays,
      failedBattles: failed.length,
      failedRecent: failed.slice(-RECENT_FAILED_SHOWN).map((f) => ({ battleId: f.battleId, reason: f.reason,
        retryAt: Number.isFinite(f.retryAt) ? f.retryAt : null })),
      counters: { ...counters },
      lastRefusal,
      lossImport: lossImportOn ? "on" : "off",
      lossTracker: lossTracker.sizes(),
      hunts: hunt ? hunt.getStatus() : { state: "off" },
      exposures: exposure ? exposure.getStatus() : { state: "off" },
      sentryHolds: sentryHold ? sentryHold.getStatus() : { state: "off" },
      presence: presenceStep ? presenceStep.getStatus() : { state: "off" },
      patrols: patrol ? patrol.getStatus() : { state: "off" },
      sentries: sentryStep ? sentryStep.stats() : { state: "off" },
      dormancy: dormancyStats(),
    };
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    stopReason = reason === undefined ? null : String(reason);
    if (exposure) exposure.stop();
    if (sentryHold) sentryHold.stop();
    if (presenceStep) presenceStep.stop();
    if (patrol) patrol.stop();
    if (sentryStep) sentryStep.stop();
  }

  function liveLossesByFleet() {
    const out = new Map();
    try {
      for (const e of registry.list()) {
        if (!e.lostKeys || !e.fleetOfMember || e.despawned) continue;
        for (const key of e.lostKeys) {
          const fleetId = e.fleetOfMember.get(key);
          if (fleetId !== undefined) out.set(fleetId, (out.get(fleetId) || 0) + 1);
        }
      }
      if (hunt && typeof hunt.addLiveLosses === "function") hunt.addLiveLosses(out);
      if (patrol && typeof patrol.addLiveLosses === "function") patrol.addLiveLosses(out);
    } catch (_err) {
    }
    return out;
  }

  function liveSideOf(entityId) {
    try {
      return registry.liveSideOf(entityId);
    } catch (_err) {
      return { ok: false, reason: "NOT_LIVE" };
    }
  }

  function inboundFleets(systemId, nowMs, max) {
    if (!presenceStep) return { ok: false, reason: "TRANSIT_OFF" };
    try {
      return presenceStep.inboundFleets(systemId, nowMs, max);
    } catch (_err) {
      return { ok: false, reason: "INBOUND_FAILED" };
    }
  }

  return Object.freeze({ runPass, getStatus, stop, notePassError, liveLossesByFleet, liveSideOf, inboundFleets });
}

function collectRelationGroups(entries, steps, aggroPlayers) {
  const groups = [];
  for (const e of entries) {
    if (e.state !== "LIVE" || e.despawned || !(e.factionOf instanceof Map)) continue;
    const byFaction = new Map();
    for (const s of e.spawned) {
      const factionId = e.factionOf.get(s.entityId);
      if (factionId === undefined) continue;
      if (!byFaction.has(factionId)) byFaction.set(factionId, []);
      byFaction.get(factionId).push(s.entityId);
    }
    for (const [factionId, entityIds] of byFaction) {
      const hulls = e.hullGroupOf instanceof Map
        ? { hullGroups: entityIds.map((id) => (e.hullGroupOf.has(id) ? e.hullGroupOf.get(id) : null)) } : {};
      groups.push({ systemId: e.systemId, factionId, entityIds, ...hulls, aggressors: null, primaryCharacterId: null,
        forced: aggroPlayers ? "hostile" : null, source: "battle" });
    }
  }
  for (const [step, source] of steps) {
    if (!step || typeof step.relationGroups !== "function") continue;
    const more = step.relationGroups();
    if (!Array.isArray(more)) continue;
    for (const g of more) groups.push(g && typeof g === "object" ? { ...g, source } : g);
  }
  return groups;
}

function combatGroupsOf(groups) {
  return (Array.isArray(groups) ? groups : []).filter((g) => !g || g.source !== "presence");
}

function lneEntityIdsOf(groups) {
  const out = new Set();
  for (const g of Array.isArray(groups) ? groups : []) {
    if (!g || !Array.isArray(g.entityIds)) continue;
    for (const id of g.entityIds) if (Number.isSafeInteger(id) && id > 0) out.add(id);
  }
  return out;
}

module.exports = { createMaterializationService, collectRelationGroups, combatGroupsOf, COUNTER_NAMES, LIVE_MODE };
