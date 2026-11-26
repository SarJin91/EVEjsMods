"use strict";

const H = require("./sentryHoldRules");
const { EXIT_LAND_METERS } = require("../fleetExposure/rules");
const { exposureIdOf, ROLES_OF_KIND } = require("../fleetExposure/schema");
const { createSentryHostility } = require("../sentries/hostility");
const { sentryAnchorRef } = require("../sentries/gridScope");
const { gridOfRef } = require("../battle/gridContacts");
const { isPassiveKind } = require("../adapter/data/sentryTypes");
const { createSpawnBackoff, failureReasonOf } = require("./spawnBackoff");
const { isSceneRefusal } = require("./sceneBudget");

const COUNTER_NAMES = Object.freeze(["holdScans", "holdStarted", "holdRefusedGovernor", "holdRefusedBudget",
  "holdRefusedProfile", "holdRefusedNoAnchor", "holdSpawnFailed", "holdClaimFailed", "holdLossImported",
  "holdLossDropped", "holdExited", "holdEnded", "holdEndFailed", "holdWiped", "holdRetreated",
  "holdGridMiss", "holdGridFallback",
  "holdRefusedBackoff"]);
const METRIC_HOLD_STEP_MS = "sentries.holdStepMs";
const MS_DECIMALS = 1000;
const ALL_PERMILLE = 1001;

const KIND = "SENTRY";
const KIND_ANCHOR = "anchor";
const WORK_CLASS_NEW = "OPERATIONAL";
const PHASE = Object.freeze({ HELD: "HELD", EXITING: "EXITING", ENDING: "ENDING" });
const SIEGE_ROLES = ROLES_OF_KIND[KIND];
const PERMANENT_END = Object.freeze(["EXPOSURE_NOT_FOUND", "FLEET_NOT_FOUND", "FLEET_NOT_MATERIALIZED",
  "FLEET_EXPOSURE_INVALID_INPUT"]);
const FLEET_METHODS = Object.freeze(["listFleetsInSystems"]);
const EXIT_KINDS = Object.freeze(["station", "stargate"]);
const RECENT_ENDS_SHOWN = 20;
const MAX_DETAIL = 120;
const MINUTE_MS = 60000;
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

class StepError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = String(reason);
    this.detail = detail === undefined || detail === null ? null : String(detail).slice(0, MAX_DETAIL);
  }
}

function createSentryHoldStep(deps) {
  const { store, clock, npcSpawn, budget, lossTracker } = deps;
  const S = deps.settings;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => 0;
  const getFleetExposure = typeof deps.getFleetExposure === "function" ? deps.getFleetExposure : () => null;
  const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
  const getSentries = typeof deps.getSentries === "function" ? deps.getSentries : () => null;
  const getSentrySeam = typeof deps.getSentrySeam === "function" ? deps.getSentrySeam : () => null;
  const getHuntScene = typeof deps.getHuntScene === "function" ? deps.getHuntScene : () => null;
  const despawnAll = deps.despawnAll;
  const admits = typeof deps.admits === "function" ? deps.admits : () => true;
  const lossImportOn = deps.lossImportOn === true;
  const invaders = deps.invaderProfiles === true;
  const gridEnabled = deps.gridEnabled === true;
  const spawnBackoff = deps.spawnBackoff && typeof deps.spawnBackoff.blocked === "function" ? deps.spawnBackoff
    : createSpawnBackoff(null);
  const hostilityDeps = deps.hostility && typeof deps.hostility === "object" ? deps.hostility : {};
  const groups = deps.strengthGroups && typeof deps.strengthGroups === "object" ? deps.strengthGroups : {};
  const P = { retreatLossPermille: Number.isSafeInteger(deps.retreatLossPermille) ? deps.retreatLossPermille
    : ALL_PERMILLE, exitGraceMs: deps.exitGraceMs, maxHeldMs: S.maxHeldMs, exitWarpMaxMs: S.exitWarpMaxMs };
  const warpSpread = Math.floor(EXIT_LAND_METERS / 2);

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const entries = new Map();
  const cooldown = new Map();
  const recentEnds = [];
  let cursor = 0;
  let lastScanAt = null;
  let lastRefusal = null;
  let stopped = false;
  const loggedOnce = new Set();
  let errorWindow = -Infinity;
  let errorLines = 0;
  let pass = { at: null, players: new Map() };

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`sentries.${name}`, n);
    } catch (_err) {
    }
  }

  function observeStep(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_HOLD_STEP_MS, Math.max(0, Math.round(ms * MS_DECIMALS) / MS_DECIMALS));
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
    const key = `sentryHold:${reason}`;
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

  function sentriesOf() {
    const s = safeCall(getSentries);
    if (!s || typeof s.listLiveInSystem !== "function" || typeof s.getMode !== "function") return null;
    return safeCall(() => s.getMode()) === "ready" ? s : null;
  }

  function liveRefsOf(sentries, systemId) {
    if (!sentries) return [];
    const list = safeCall(() => sentries.listLiveInSystem(systemId));
    return Array.isArray(list) ? list : [];
  }

  const liveIdsOf = (e) => e.members.filter((m) => !m.destroyed).map((m) => m.entityId);
  const allIdsOf = (e) => e.members.map((m) => m.entityId);

  function despawnAndRelease(e) {
    if (e.despawned) return;
    const ids = allIdsOf(e);
    if (ids.length > 0) despawnAll(e.systemId, ids);
    budget.release(e.reservationId);
    e.despawned = true;
  }

  function forget(e) {
    entries.delete(e.key);
    lossTracker.untrack(e.key);
  }

  function noteEnd(e, now, reason, outcome, losses) {
    recentEnds.push({ fleetId: e.fleetId, systemId: e.systemId, exposureId: e.exposureId, reason, outcome, losses,
      at: now });
    if (recentEnds.length > RECENT_ENDS_SHOWN) recentEnds.splice(0, recentEnds.length - RECENT_ENDS_SHOWN);
  }

  function tryEnd(e, now) {
    const fe = facade();
    const r = fe ? tx("sentryHoldEnd", (db) => fe.endInTx(db, { exposureId: e.exposureId, at: now,
      reason: e.endReason })) : { ok: false, reason: "FLEET_EXPOSURE_UNAVAILABLE" };
    if (r && r.ok === true) {
      forget(e);
      cooldown.set(e.fleetId, now);
      bump("holdEnded");
      if (e.endReason === "WIPED") bump("holdWiped");
      if (e.endReason === "RETREAT") bump("holdRetreated");
      const losses = (r.losses || []).reduce((n, g) => n + g.count, 0);
      const reason = typeof r.endReason === "string" ? r.endReason : e.endReason;
      noteEnd(e, now, reason, r.outcome, losses);
      logLimited(now, `sentries: hold ${e.exposureId} ended ${reason} outcome=${r.outcome} losses=${losses}`
        + `${r.duplicate ? " (duplicate)" : ""}`);
      return;
    }
    bump("holdEndFailed");
    if (r && PERMANENT_END.includes(r.reason)) {
      forget(e);
      logger.log(`sentries: hold end ${e.exposureId} refused - ${r.reason} (left to the restart recovery)`);
      return;
    }
    logLimited(now, `sentries: hold end ${e.exposureId} failed - ${(r && r.reason) || "no result"}`);
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
    const r = tx("sentryHoldLosses", (db) => {
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
      logLimited(now, `sentries: hold losses not written - ${(r && r.reason) || "no result"} (retry)`);
      return;
    }
    for (const d of r.done) {
      const member = d.e.members.find((x) => x.memberKey === d.memberKey);
      if (d.ok) {
        if (member) member.destroyed = true;
        if (!d.duplicate) bump("holdLossImported");
      } else bump("holdLossDropped");
    }
    for (const e of held) e.lossQueue = [];
  }

  function stepPending(now, out) {
    if (stopped || (entries.size === 0 && lossTracker.sizes().pending === 0)) return;
    for (const l of lossTracker.drain()) {
      const e = entries.get(l.battleId);
      const m = e ? e.members.find((x) => x.memberKey === l.memberKey) : null;
      if (!e || !m || m.destroyed || (e.phase !== PHASE.HELD && e.phase !== PHASE.EXITING)) {
        bump("holdLossDropped");
        continue;
      }
      if (!e.lossQueue.includes(l.memberKey)) e.lossQueue.push(l.memberKey);
    }
    writeHeldLosses(now);
    for (const e of [...entries.values()]) if (e.phase === PHASE.ENDING) tryEnd(e, now);
    if (out && typeof out === "object" && out.sentryHolds === undefined) out.sentryHolds = entries.size;
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
    const gone = { sceneLoaded: false, alive: [], playerSeen: false };
    if (safeCall(() => npcSpawn.isSceneLoaded(e.systemId)) !== true) return gone;
    const players = playersOf(e.systemId, seam);
    if (!players || players.ok !== true) return players && players.reason === "SCENE_NOT_LOADED" ? gone : null;
    const ids = liveIdsOf(e);
    let alive = [];
    if (ids.length > 0) {
      const own = seam.readShips(e.systemId, ids);
      if (!own || own.ok !== true) return null;
      alive = own.ships;
    }
    return { sceneLoaded: true, alive, playerSeen: players.ships.length > 0 };
  }

  function hostileSentryLiveOf(e) {
    const refs = liveRefsOf(sentriesOf(), e.systemId);
    return refs.some((r) => r && e.hostileSentryIds.has(r.itemId));
  }

  function exitPointOf(e, seam, alive) {
    let listed;
    try {
      listed = seam.listSystemObjects(e.systemId, [...EXIT_KINDS]);
    } catch (_err) {
      listed = null;
    }
    const objects = listed && listed.ok === true && Array.isArray(listed.objects) ? listed.objects : [];
    const from = alive[0] && alive[0].position;
    if (!from || objects.length === 0) return null;
    let best = null;
    for (const o of objects) {
      if (best === null || distanceSq(o.position, from) < distanceSq(best.position, from)) best = o;
    }
    return best.position;
  }

  function startExit(e, seam, alive, now) {
    bump("holdExited");
    const point = exitPointOf(e, seam, alive);
    if (point === null) {
      endEntry(e, "RETREAT", now);
      return;
    }
    const w = seam.warpShips(e.systemId, alive.map((s) => s.entityId), point, { spreadMeters: warpSpread });
    if (!w || w.ok !== true) logLimited(now, `sentries: hold exit warp ${e.exposureId} - ${(w && w.reason) || "?"}`);
    e.phase = PHASE.EXITING;
    e.exitAt = now;
    e.exitPoint = { ...point };
  }

  function stepEntries(now) {
    const seam = safeCall(getHuntScene);
    const list = [...entries.values()].filter((e) => e.phase !== PHASE.ENDING)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const e of list) {
      if (!seam) {
        endEntry(e, "SCENE_GONE", now);
        continue;
      }
      let facts;
      try {
        facts = sceneFacts(e, seam);
      } catch (err) {
        logLimited(now, `sentries: hold read ${e.key} threw - ${messageOf(err)}`);
        continue;
      }
      if (facts === null) continue;
      if (facts.playerSeen) e.lastPlayerSeenAt = now;
      const d = H.decideHold({ now, phase: e.phase, allDestroyed: e.members.every((m) => m.destroyed),
        sceneLoaded: facts.sceneLoaded, alive: facts.alive, lostPermille: H.lostEhpPermille(e.members, groups),
        hostileSentryLive: facts.sceneLoaded ? hostileSentryLiveOf(e) : false, lastPlayerSeenAt: e.lastPlayerSeenAt,
        claimedAt: e.claimedAt, exitAt: e.exitAt, exitPoint: e.exitPoint }, P);
      if (d.action === H.ACTION.END) endEntry(e, d.reason, now);
      else if (d.action === H.ACTION.EXIT) startExit(e, seam, facts.alive, now);
    }
  }

  function candidateSystems(presence, sentries) {
    const systems = [];
    const observed = safeCall(() => presence.observedSystems());
    for (const id of Array.isArray(observed) || observed instanceof Set ? observed : []) {
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      if (liveRefsOf(sentries, id).length === 0) continue;
      const sp = safeCall(() => presence.getSystemPresence(id));
      if (!sp || !(sp.space > 0)) continue;
      if (safeCall(() => npcSpawn.isSceneLoaded(id)) !== true) continue;
      systems.push(id);
    }
    systems.sort((x, y) => x - y);
    const at = systems.findIndex((s) => s > cursor);
    return at <= 0 ? systems : [...systems.slice(at), ...systems.slice(0, at)];
  }

  function gridFacade() {
    if (!gridEnabled) return null;
    const f = safeCall(getFleets);
    const g = f && f.grid;
    if (!g || typeof g.positionsOf !== "function" || typeof g.readSystemGrid !== "function") return null;
    return safeCall(() => g.isEnabled()) === true ? g : null;
  }

  function gridOfSystem(db, g, sys, fleets, now) {
    try {
      const pos = g.positionsOf(db, sys, fleets, now);
      if (!pos || pos.ok !== true || pos.anchorsReason !== null || !(pos.positions instanceof Map)) return null;
      const sg = g.readSystemGrid(sys);
      if (!sg || sg.ok !== true) return null;
      return { positions: pos.positions, gridOf: gridOfRef(sg.grids) };
    } catch (err) {
      if (!db || db.inTransaction === false) throw err;
      return null;
    }
  }

  function readCandidates(systems, now) {
    const repo = fleetRepo();
    if (!repo) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    const g = gridFacade();
    return tx("sentryHoldRead", (db) => {
      const listed = repo.listFleetsInSystems(db, systems, { states: ["STAGED"],
        limitPerSystem: S.maxFleetsPerSystem });
      if (!listed || listed.ok !== true) return listed;
      const candidates = [];
      for (const sys of systems) {
        const fleets = listed.bySystem.get(sys) || [];
        const scope = g !== null && fleets.length > 0 ? gridOfSystem(db, g, sys, fleets, now) : null;
        for (const f of fleets) {
          if (!SIEGE_ROLES.includes(f.fleetRole) || typeof f.operationId !== "string") continue;
          if (!gridEnabled) {
            candidates.push({ fleet: f, systemId: sys });
          } else if (scope === null) {
            candidates.push({ fleet: f, systemId: sys, gridFallback: true });
          } else {
            const pos = scope.positions.get(f.fleetId);
            const gridKey = pos && pos.kind === KIND_ANCHOR && typeof pos.gridKey === "string" ? pos.gridKey : null;
            candidates.push({ fleet: f, systemId: sys, gridKey, gridOf: scope.gridOf });
          }
        }
      }
      return { ok: true, candidates };
    });
  }

  function cooled(fleetId, now) {
    if (!cooldown.has(fleetId)) return false;
    if (now - cooldown.get(fleetId) < S.respawnCooldownMs) return true;
    cooldown.delete(fleetId);
    return false;
  }

  function pruneCooldown(now) {
    for (const [fleetId, at] of cooldown) if (now - at >= S.respawnCooldownMs) cooldown.delete(fleetId);
  }

  function viewsOf(cache, systemId, refs) {
    if (cache.has(systemId)) return cache.get(systemId);
    const seam = safeCall(getSentrySeam);
    let views = null;
    if (seam && typeof seam.readSentryScene === "function") {
      const r = safeCall(() => seam.readSentryScene(systemId, refs.map((x) => x.itemId), []));
      if (r && r.ok === true && r.loaded === true && Array.isArray(r.sentries)) views = r.sentries;
    }
    cache.set(systemId, views);
    return views;
  }

  function startEntry(c, anchorItemId, hostileIds, members, profiles, now, out) {
    const fleet = c.fleet;
    const key = fleet.fleetId;
    const reservationId = `sh:${key}:${fleet.version}`;
    const reserved = budget.reserve({ reservationId, ownerKind: "fleet", ownerId: key, systemId: c.systemId,
      shipCount: members.length, metadata: { systemId: c.systemId } });
    if (!reserved || reserved.ok !== true) {
      refuse(out, (reserved && reserved.reason) || "BUDGET", "holdRefusedBudget", key);
      return false;
    }
    const e = { key, fleetId: key, factionId: fleet.factionId, systemId: c.systemId, operationId: fleet.operationId,
      phase: PHASE.HELD, reservationId, members: [], anchorItemId, hostileSentryIds: new Set(hostileIds),
      exposureId: null, claimedAt: null, engageAfter: null, lastPlayerSeenAt: now, exitAt: null, exitPoint: null,
      endReason: null, despawned: false, lossQueue: [], startedAt: now };
    try {
      const anchor = { kind: "entity", itemID: anchorItemId };
      for (let i = 0; i < members.length; i += 1) {
        const r = npcSpawn.spawnShip(c.systemId, { profileId: profiles[i], anchorDescriptor: anchor,
          spawnDistanceMeters: S.spawnDistanceM, behavior: "search" });
        if (!r || r.ok !== true) throw new StepError((r && r.reason) || "SPAWN_FAILED", r && r.detail);
        e.members.push({ ...members[i], entityId: r.entityId, destroyed: false });
      }
      const ids = allIdsOf(e);
      const pub = npcSpawn.publish(c.systemId, ids);
      if (!pub || pub.ok !== true) throw new StepError("PUBLISH_FAILED", pub && (pub.detail || pub.reason));
      if (!(pub.published >= ids.length)) throw new StepError("PUBLISH_PARTIAL", `${pub.published}/${ids.length}`);
    } catch (err) {
      const reason = err instanceof StepError ? err.reason : "SPAWN_THREW";
      const detail = err instanceof StepError ? err.detail : messageOf(err);
      despawnAndRelease(e);
      refuse(out, reason, detail === "ANCHOR_NOT_FOUND" ? "holdRefusedNoAnchor" : "holdSpawnFailed", detail);
      const held = isSceneRefusal(reason) ? { first: true, failures: 0, retryAt: now }
        : spawnBackoff.note(key, failureReasonOf(reason, detail), now);
      if (held.first) {
        logLimited(now, `sentries: hold spawn ${key} rolled back - ${reason}${detail ? ` ${detail}` : ""}`
          + `${held.failures > 0 ? ` backoff=${held.retryAt - now}ms failures=${held.failures}` : ""}`);
      }
      return false;
    }
    spawnBackoff.clear(key);
    const fe = facade();
    const exposureId = exposureIdOf(key, fleet.version);
    const r = fe ? tx("sentryHoldClaim", (db) => fe.claimInTx(db, { exposureId, fleetId: key,
      expectedVersion: fleet.version, kind: KIND, systemId: c.systemId, operationId: fleet.operationId, at: now,
      characterId: null, members: members.map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup,
        typeId: m.typeId })), destroyed: [], crossing: null })) : { ok: false, reason: "FLEET_EXPOSURE_UNAVAILABLE" };
    if (!r || r.ok !== true || r.duplicate === true) {
      const reason = (r && r.ok === true) ? "CLAIM_DUPLICATE" : ((r && r.reason) || "CLAIM_FAILED");
      despawnAndRelease(e);
      cooldown.set(key, now);
      refuse(out, reason, "holdClaimFailed", r && r.detail);
      noteEnd(e, now, `CLAIM_${reason}`, "DESPAWNED", 0);
      logLimited(now, `sentries: hold claim ${key} refused - ${reason}`);
      return false;
    }
    e.exposureId = exposureId;
    e.claimedAt = now;
    e.engageAfter = now + S.warningMs;
    entries.set(key, e);
    lossTracker.track(key, e.members.map((m) => ({ memberKey: m.memberKey, entityId: m.entityId })));
    bump("holdStarted");
    logLimited(now, `sentries: hold ${exposureId} in ${c.systemId} ships=${e.members.length} anchor=${anchorItemId}`
      + ` engageAfter=${e.engageAfter}`);
    return true;
  }

  function stepNew(now, presence, out) {
    if (S.enabled !== true) return;
    const fe = facade();
    if (!fe || typeof fe.isKindEnabled !== "function" || safeCall(() => fe.isKindEnabled(KIND)) !== true) {
      logOnce("facade", "sentries: no new holds - ctx.fleetExposure kind SENTRY not enabled");
      return;
    }
    if (!lossImportOn) {
      logOnce("lossImport", "sentries: no new holds - battle.liveLossImport off");
      return;
    }
    if (entries.size >= S.maxHeld) return;
    if (lastScanAt !== null && now - lastScanAt < S.scanIntervalMs) return;
    lastScanAt = now;
    const sentries = sentriesOf();
    if (!sentries) return;
    const systems = candidateSystems(presence, sentries).slice(0, S.maxSystemsPerScan);
    if (systems.length === 0) return;
    if (!admits(WORK_CLASS_NEW)) {
      refuse(out, "GOVERNOR", "holdRefusedGovernor");
      return;
    }
    if (!safeCall(getHuntScene)) {
      logOnce("seam", "sentries: no new holds - hunt scene seam unavailable");
      return;
    }
    cursor = systems[systems.length - 1];
    pruneCooldown(now);
    bump("holdScans");
    const read = readCandidates(systems, now);
    if (!read || read.ok !== true) {
      refuse(out, (read && read.reason) || "READ_FAILED", null);
      return;
    }
    const hostility = createSentryHostility({ ...hostilityDeps, maxReads: hostilityDeps.maxReads });
    const viewCache = new Map();
    const ownerOnline = new Map();
    const postAllowed = (r) => {
      const kind = typeof sentries.kindOf === "function" ? safeCall(() => sentries.kindOf(r)) : null;
      if (!isPassiveKind(kind)) return true;
      const corp = Number.isSafeInteger(r.ownerCorpId) ? r.ownerCorpId : 0;
      if (!ownerOnline.has(corp)) {
        ownerOnline.set(corp, typeof sentries.ownerOnlineOf === "function"
          && safeCall(() => sentries.ownerOnlineOf(r, now)) === true);
      }
      return ownerOnline.get(corp);
    };
    let attempts = 0;
    for (const c of read.candidates) {
      if (attempts >= S.maxNewPerPass || entries.size >= S.maxHeld) break;
      const fleetId = c.fleet.fleetId;
      if (entries.has(fleetId) || cooled(fleetId, now)) continue;
      if (spawnBackoff.blocked(fleetId, now) !== null) {
        refuse(out, "SPAWN_BACKOFF", "holdRefusedBackoff", fleetId);
        continue;
      }
      const refs = liveRefsOf(sentries, c.systemId);
      if (c.gridFallback === true) bump("holdGridFallback");
      const inGrid = c.gridOf instanceof Map ? refs.filter((r) => c.gridKey !== null
        && c.gridOf.get(sentryAnchorRef(r)) === c.gridKey) : refs;
      const hostileIds = inGrid.filter((r) => postAllowed(r) && hostility.isHostile(r, c.fleet.factionId))
        .map((r) => r.itemId);
      if (hostileIds.length === 0) {
        if (c.gridOf instanceof Map) bump("holdGridMiss");
        continue;
      }
      const anchorItemId = H.pickAnchorSentry(viewsOf(viewCache, c.systemId, refs), hostileIds);
      if (anchorItemId === null) {
        refuse(out, "NO_ANCHOR", "holdRefusedNoAnchor", fleetId);
        continue;
      }
      const members = H.pickHoldMembers(c.fleet, S.maxShipsPerHold);
      if (!members.ok) continue;
      const profiles = npcSpawn.resolveProfiles(members.members.map((m) => ({ memberKey: m.memberKey,
        factionId: c.fleet.factionId, hullGroup: m.hullGroup, typeId: m.typeId })), { seedPrefix: fleetId,
        invaders });
      if (!profiles || profiles.ok !== true) {
        refuse(out, (profiles && profiles.reason) || "NO_PROFILE", "holdRefusedProfile", fleetId);
        continue;
      }
      attempts += 1;
      startEntry(c, anchorItemId, hostileIds, members.members, profiles.profiles, now, out);
    }
  }

  function step(now, presence, out) {
    if (stopped) return;
    if (entries.size === 0 && S.enabled !== true) return;
    const t0 = nowMs();
    try {
      beginPass(now);
      if (entries.size > 0) stepEntries(now);
      stepNew(now, presence, out);
    } catch (err) {
      logLimited(now, `sentries: hold step threw - ${messageOf(err)}`);
    } finally {
      observeStep(nowMs() - t0);
    }
  }

  function getStatus() {
    const by = (phase) => [...entries.values()].filter((e) => e.phase === phase).length;
    return {
      state: stopped ? "stopped" : (S.enabled === true ? "on" : "off"),
      lossImport: lossImportOn ? "on" : "off",
      held: by(PHASE.HELD),
      exiting: by(PHASE.EXITING),
      ending: by(PHASE.ENDING),
      cursor,
      entries: [...entries.values()].map((e) => ({ fleetId: e.fleetId, phase: e.phase, systemId: e.systemId,
        factionId: e.factionId, exposureId: e.exposureId, anchorItemId: e.anchorItemId,
        hostileSentryIds: [...e.hostileSentryIds].sort((x, y) => x - y), ships: e.members.length,
        destroyed: e.members.filter((m) => m.destroyed).length, lostPermille: H.lostEhpPermille(e.members, groups),
        claimedAt: e.claimedAt, engageAfter: e.engageAfter })),
      counters: { ...counters },
      lastRefusal,
      recentEnds: recentEnds.map((x) => ({ ...x })),
      lossTracker: lossTracker.sizes(),
    };
  }

  function stop() {
    stopped = true;
  }

  function relationGroups() {
    const out = [];
    for (const e of entries.values()) {
      if (e.despawned || (e.phase !== PHASE.HELD && e.phase !== PHASE.EXITING)) continue;
      const live = e.members.filter((m) => !m.destroyed);
      if (live.length === 0) continue;
      out.push({ systemId: e.systemId, factionId: e.factionId, entityIds: live.map((m) => m.entityId),
        hullGroups: live.map((m) => m.hullGroup), engageAfter: e.engageAfter, aggressors: null,
        primaryCharacterId: null });
    }
    return out;
  }

  return Object.freeze({ stepPending, step, getStatus, stop, relationGroups });
}

module.exports = { createSentryHoldStep, COUNTER_NAMES, HOLD_COUNTER_NAMES: COUNTER_NAMES };
