"use strict";

const { performance } = require("node:perf_hooks");
const { createRng, randomSeed } = require("../../util/rng");
const { TRAFFIC_METRICS, TRAFFIC_COUNTER_NAMES, AGGRO_COUNTER_NAMES, RAT_AGGRO_COUNTER_NAMES } = require("../schema");
const { SHIP_STATE, DESPAWN_REASON, SHIP_ROLE, MINER_LEG, PATROL_LEG, PATROL_ROLES, EXPLORER_LEG, WARP_MODE,
  planSpawns, pickRoute, pickProfile, landingPointOf, stepShip, pickRole, pickUndockRoute, pickIdleGate,
  pickMinerRoute, pickRatterRoute, pickExplorerRoute, pickSites, planPilot, outcomeOf, GONE, verifyPilotHulls,
  isExpired, PILOT_EXIT, arrivalPoseOf } = require("./plan");
const { FLEE_ROLES, noteAggression, fleeStepOf, fleeTargetOf, planAlarm } = require("./flee");
const { aggroSettingsOf, vendorRatSettingsOf, planAggro } = require("./aggro");
const { planBeams, applyBeams } = require("../../util/miningBeamPlan");

const SCENE_METHODS = Object.freeze(["readNodes", "readPlayers", "spawnCivilian", "warpTo", "readShips", "despawn",
  "listTrafficIds", "dockPointOf"]);
const AGGRO_SCENE_METHODS = Object.freeze(["readThreats", "armPilotTarget", "disarmPilotTarget"]);
const RAT_AGGRO_SCENE_METHODS = Object.freeze(["armPilotRatTarget", "releaseEngagedRats"]);
const WORK_CLASS = "OPERATIONAL";
const LEFT = "LEFT";
const MS_DECIMALS = 10;
const PERMILLE = 1000;
const MAX_DETAIL = 160;
const NAME_READ_MAX = 64;
const NAME_MIN = 3;
const NAME_MAX = 37;

function slimNameOf(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= NAME_MIN && name.length <= NAME_MAX && !/[<>]/.test(name) ? name : null;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createTraffic(deps) {
  const T = deps && deps.settings;
  const scene = deps && deps.scene;
  if (!T || typeof T !== "object") return { ok: false, reason: "MISSING_DEPS", detail: "settings" };
  const absent = SCENE_METHODS.filter((name) => !scene || typeof scene[name] !== "function");
  if (absent.length > 0) return { ok: false, reason: "MISSING_DEPS", detail: `scene.${absent.join(",")}` };
  for (const k of ["getPresence", "describeSystem", "wantedOf"]) {
    if (typeof deps[k] !== "function") return { ok: false, reason: "MISSING_DEPS", detail: k };
  }
  const profiles = Array.isArray(deps.profiles) ? deps.profiles : [];
  const byRole = deps.profilesByRole && typeof deps.profilesByRole === "object" ? deps.profilesByRole : null;
  const profilesOf = (role) => (byRole ? (Array.isArray(byRole[role]) ? byRole[role] : []) : profiles);
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const rng = typeof deps.rng === "function" ? deps.rng : createRng(randomSeed()).nextFloat;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;

  const counters = Object.fromEntries(TRAFFIC_COUNTER_NAMES.map((name) => [name, 0]));
  const ships = new Map();
  const PL = deps.populationLive && typeof deps.populationLive === "object" && deps.populationLive.settings
    && typeof deps.populationLive.getPopulation === "function" ? deps.populationLive : null;
  const PLS = PL ? PL.settings : null;
  const backoff = PL && PL.spawnBackoff && typeof PL.spawnBackoff.blocked === "function" ? PL.spawnBackoff : null;
  const failureReasonOf = PL && typeof PL.failureReasonOf === "function" ? PL.failureReasonOf : (reason) => reason;
  const pilotOf = new Map();
  const hullProfiles = PL && PL.hullProfiles instanceof Map && PL.hullProfiles.size > 0
    && typeof PL.readTypeLooks === "function" ? PL.hullProfiles : null;
  const GS = PL && PL.groupSpawn && Number.isFinite(PL.groupSpawn.spacingMeters) ? PL.groupSpawn : null;
  let hullsVerified = null;
  let hullsRejected = [];
  let hullsFailedPass = -1;
  let passNo = 0;
  const systems = new Map();
  const loggedFailures = new Set();
  let systemCursor = 0;
  let stopped = false;
  let lastPass = null;
  const AG = PL ? aggroSettingsOf(PLS) : null;
  const aggroCounters = AG ? Object.fromEntries(AGGRO_COUNTER_NAMES.map((name) => [name, 0])) : null;
  const armed = new Map();
  const isLiveBattleShip = PL && typeof PL.isLiveBattleShip === "function" ? PL.isLiveBattleShip : null;
  const cooldownUntil = new Map();
  let aggroOff = false;
  let aggroCursor = 0;
  const VR = AG ? vendorRatSettingsOf(PLS) : null;
  const ratCounters = VR ? Object.fromEntries(RAT_AGGRO_COUNTER_NAMES.map((name) => [name, 0])) : null;
  const ratWindow = new Map();
  let ratOff = false;
  let beamFxLeft = 0;
  let warpFxLeft = 0;
  let gateEventLeft = 0;
  let siteReadsLeft = 0;
  let alarmLeft = 0;
  const gateEventsOn = () => T.gateJumpFxEnabled === true && T.gateControllerEventsEnabled === true;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`highsecLife: traffic ${line}`);
    } catch (_err) {
    }
  }

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
  }

  function fail(kind, detail) {
    bump(`failed.${kind}`);
    if (loggedFailures.has(kind)) return;
    loggedFailures.add(kind);
    log(`${kind} failed (${String(detail || "NO_RESULT").slice(0, MAX_DETAIL)}); further failures only counted`);
  }

  function call(fn) {
    try {
      return fn();
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function presenceOf() {
    try {
      const p = deps.getPresence();
      return p && typeof p.observedSystems === "function" && typeof p.getSystemPresence === "function" ? p : null;
    } catch (_err) {
      return null;
    }
  }

  function spaceOf(presence, systemId) {
    try {
      const info = presence ? presence.getSystemPresence(systemId) : null;
      return info && Number.isFinite(info.space) ? info.space : 0;
    } catch (_err) {
      return 0;
    }
  }

  function governorAdmits() {
    try {
      const g = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function shipsBySystem() {
    const by = new Map();
    for (const ship of ships.values()) {
      if (!by.has(ship.systemId)) by.set(ship.systemId, []);
      by.get(ship.systemId).push(ship);
    }
    return by;
  }

  function liveIn(systemId) {
    let n = 0;
    for (const ship of ships.values()) if (ship.systemId === systemId) n += 1;
    return n;
  }

  function roleIn(systemId, role) {
    let n = 0;
    for (const ship of ships.values()) if (ship.systemId === systemId && ship.role === role) n += 1;
    return n;
  }

  function rattersIn(systemId) {
    return roleIn(systemId, SHIP_ROLE.RATTER);
  }

  function explorersIn(systemId) {
    return roleIn(systemId, SHIP_ROLE.EXPLORER);
  }

  function releaseMotion(ship) {
    if (ship.orbiting !== true) return;
    ship.orbiting = false;
    if (typeof scene.releasePatrolMotion !== "function") return;
    const r = call(() => scene.releasePatrolMotion(ship.systemId, ship.entityId));
    if (r && r.ok === true && r.released === true) bump("patrolReleased");
  }

  function dwell(ship, now) {
    const leg = ship.legs[ship.legIndex];
    ship.state = SHIP_STATE.DWELLING;
    ship.dwellUntil = now + leg.dwellMs;
    ship.warpAttempts = 0;
    if (ship.role === SHIP_ROLE.EXPLORER) {
      bump(leg.kind === EXPLORER_LEG.SITE ? "explorerSites" : "explorerScans");
      return;
    }
    if (leg.anomaly) return;
    bump("ratterBelts");
    if (typeof scene.presentPatrolOrbit !== "function") return;
    const r = call(() => scene.presentPatrolOrbit(ship.systemId, ship.entityId, leg.targetId,
      { meters: T.ratterOrbitMeters, speedFraction: T.ratterOrbitSpeedPermille / PERMILLE }));
    ship.orbiting = Boolean(r && r.ok === true && r.orbiting === true);
    bump(ship.orbiting ? "ratterOrbits" : "ratterOrbitRefused");
  }

  function nextLeg(ship, now) {
    releaseMotion(ship);
    const next = ship.legIndex + 1;
    ship.targetPoint = ship.legs[next].point;
    if (warp(ship, now)) ship.legIndex = next;
  }

  function leave(ship, now) {
    const patrol = PATROL_ROLES.includes(ship.role);
    if (patrol) releaseMotion(ship);
    ship.targetPoint = ship.exitPoint;
    ship.leg = patrol ? PATROL_LEG.EXIT : MINER_LEG.EXIT;
    warp(ship, now);
  }

  function explore(ship, seen, now) {
    if (T.explorerSiteReadsPerPass <= 0) {
      bump("explorerNoSite");
      leave(ship, now);
      return;
    }
    if (siteReadsLeft <= 0) {
      bump("explorerReadBudget");
      return;
    }
    if (typeof scene.readExplorerSites !== "function") {
      fail("sites", "SEAM_UNAVAILABLE");
      leave(ship, now);
      return;
    }
    siteReadsLeft -= 1;
    const r = call(() => scene.readExplorerSites(ship.systemId, { families: T.explorerFamilies,
      npcClearMeters: T.explorerNpcClearMeters, maxSites: T.explorerMaxSites }));
    if (!r || r.ok !== true || !Array.isArray(r.sites)) {
      fail("sites", r && r.reason);
      leave(ship, now);
      return;
    }
    bump("explorerNpcBlocked", Number.isSafeInteger(r.npcBlocked) ? r.npcBlocked : 0);
    const leg = ship.legs[ship.legIndex];
    if (leg.kind === EXPLORER_LEG.SAFE) {
      const picks = pickSites(r.sites, rng, T, seen.position || leg.point);
      if (picks.length === 0) {
        bump("explorerNoSite");
        leave(ship, now);
        return;
      }
      ship.legs = Object.freeze([leg, ...picks]);
      nextLeg(ship, now);
      return;
    }
    const open = new Set(r.sites.map((s) => s && s.siteId));
    let j = ship.legIndex + 1;
    while (j < ship.legs.length && !open.has(ship.legs[j].targetId)) {
      bump("explorerSiteGone");
      j += 1;
    }
    if (j >= ship.legs.length) {
      leave(ship, now);
      return;
    }
    ship.legIndex = j - 1;
    nextLeg(ship, now);
  }

  function despawnIds(systemId, ids) {
    if (ids.length === 0) return [];
    const res = call(() => scene.despawn(systemId, ids));
    let removed = ids;
    if (!res || res.ok !== true) {
      fail("despawn", res && res.reason);
      const failed = new Set(res && Array.isArray(res.failed) ? res.failed : ids);
      removed = ids.filter((id) => !failed.has(id));
    }
    if (removed.length > 0) metric("count", TRAFFIC_METRICS.despawned, removed.length);
    return removed;
  }

  function releasePilot(ship, outcome) {
    if (!PL || !ship || !Number.isSafeInteger(ship.pilotId)) return;
    if (pilotOf.get(ship.pilotId) === ship.entityId) pilotOf.delete(ship.pilotId);
    forgetAggro(ship.entityId);
    if (Number.isSafeInteger(ship.leaderPilotId)) {
      if (outcome !== "KILLED") return;
      bump("pilotKilled");
      try {
        const pop = PL.getPopulation();
        if (pop && typeof pop.releaseGroupMember === "function") {
          pop.releaseGroupMember(ship.pilotId, ship.leaderPilotId, ship.token, clock.now());
        }
      } catch (_err) {
      }
      return;
    }
    if (outcome === "KILLED") bump("pilotKilled");
    try {
      const pop = PL.getPopulation();
      if (pop && typeof pop.releaseLive === "function") pop.releaseLive(ship.pilotId, ship.token, outcome, clock.now());
    } catch (_err) {
    }
  }

  function withGroupShips(list) {
    if (!list.some((s) => s && Array.isArray(s.groupShips) && s.groupShips.length > 0)) return list;
    const listed = new Set(list.map((s) => s.entityId));
    const out = list.slice();
    for (const s of list) {
      for (const id of Array.isArray(s.groupShips) ? s.groupShips : []) {
        const m = ships.get(id);
        if (!m || listed.has(id) || m.systemId !== s.systemId) continue;
        listed.add(id);
        out.push(m);
      }
    }
    return out;
  }

  function presentDepartures(systemId, list, reason) {
    if (!gateEventsOn() || (reason !== DESPAWN_REASON.JUMPED && reason !== DESPAWN_REASON.ARRIVED)
      || typeof scene.presentGateDeparture !== "function") return;
    for (const s of list) {
      if (s.state !== SHIP_STATE.JUMPING || !Number.isSafeInteger(s.jumpGateId) || s.jumpGateId <= 0) continue;
      if (gateEventLeft <= 0) {
        bump("gateEventBudgetCut");
        continue;
      }
      gateEventLeft -= 1;
      const r = call(() => scene.presentGateDeparture(systemId, s.entityId, s.jumpGateId));
      if (!r || r.ok !== true) bump("gateEventFailed");
      else if (r.sent === true) bump("gateDepartureEvents");
    }
  }

  function despawnShips(systemId, shipList, reason) {
    const list = GS !== null ? withGroupShips(shipList) : shipList;
    presentDepartures(systemId, list, reason);
    const removed = despawnIds(systemId, list.map((s) => s.entityId));
    for (const id of removed) ships.delete(id);
    if (PL) {
      const byId = new Map(list.map((s) => [s.entityId, s]));
      for (const id of removed) releasePilot(byId.get(id), outcomeOf(byId.get(id), reason));
    }
    if (reason === DESPAWN_REASON.EXPIRED) bump("expired", removed.length);
    else if (reason === DESPAWN_REASON.STUCK) bump("stuck", removed.length);
    else if (reason === LEFT) bump("left", removed.length);
    else if (reason === DESPAWN_REASON.JUMPED) bump("gateIdle", removed.length);
    else if (reason === DESPAWN_REASON.ARRIVED) {
      const gone = new Set(removed);
      bump("docked", list.filter((s) => s.docking === true && gone.has(s.entityId)).length);
    }
  }

  function warp(ship, now, immediate) {
    const align = immediate !== true && T.alignBeforeWarpEnabled === true;
    const fx = T.visibleWarpEnabled === true && warpFxLeft > 0;
    if (T.visibleWarpEnabled === true && !fx) bump("visibleWarpFxCut");
    if (fx) warpFxLeft -= 1;
    const fxOpt = fx ? { warpFx: true } : {};
    const opts = immediate === true ? { clearAlignOrder: true, ...fxOpt } : align ? { align: true, ...fxOpt }
      : fx ? { warpFx: true } : undefined;
    if (immediate === true) {
      ship.warpMode = WARP_MODE.IMMEDIATE;
      bump("alignTimeouts");
    }
    const r = call(() => (opts === undefined ? scene.warpTo(ship.systemId, ship.entityId, ship.targetPoint)
      : scene.warpTo(ship.systemId, ship.entityId, ship.targetPoint, opts)));
    if (r && r.ok === true && r.warpFx === true) bump("visibleWarpFx");
    if (r && r.ok === true && r.warped === true) {
      if (ship.state !== SHIP_STATE.WARPING) ship.preWarpState = ship.state;
      ship.state = SHIP_STATE.WARPING;
      ship.warpAt = now;
      ship.warpMode = r.aligned === true ? WARP_MODE.ALIGN : WARP_MODE.IMMEDIATE;
      if (r.aligned === true) bump("alignWarps");
      else if (align) bump("alignFellBack");
      return true;
    }
    if (immediate === true && ship.state === SHIP_STATE.WARPING) {
      ship.state = typeof ship.preWarpState === "string" ? ship.preWarpState : SHIP_STATE.SPAWNED;
      ship.warpAt = null;
      ship.warpMode = null;
    }
    ship.warpAttempts += 1;
    bump("warpFailed");
    if (ship.warpAttempts >= T.maxWarpAttempts) despawnShips(ship.systemId, [ship], DESPAWN_REASON.STUCK);
    return false;
  }

  function nodeOf(nodes, target) {
    if (!target) return null;
    const list = target.kind === "stargate" ? nodes.gates : target.kind === "station" ? nodes.stations : null;
    const node = Array.isArray(list) ? list.find((n) => n && n.itemId === target.itemId) : null;
    return node ? { kind: target.kind, itemId: node.itemId, position: node.position, radius: node.radius } : null;
  }

  function exitLegOf(ship) {
    if (ship.role === SHIP_ROLE.MINER) return ship.leg !== MINER_LEG.EXIT ? MINER_LEG.EXIT : null;
    if (PATROL_ROLES.includes(ship.role)) return ship.leg !== PATROL_LEG.EXIT ? PATROL_LEG.EXIT : null;
    return null;
  }

  function flee(ship, seen, needTarget, nodesOf, now) {
    ship.fleeNextAt = now + T.fleeRetryMs;
    const exitLeg = exitLegOf(ship);
    if (needTarget || exitLeg !== null) {
      const nodes = nodesOf();
      if (nodes === null) return;
      const pick = fleeTargetOf(seen.position, nodes, nodeOf(nodes, ship.target), T);
      if (!pick.ok) {
        bump("fleeNoTarget");
        return;
      }
      ship.target = { kind: pick.target.kind, itemId: pick.target.itemId };
      ship.targetPoint = landingPointOf(seen.position, pick.target, T);
      ship.docking = false;
      if (!pick.keptRoute && Number.isSafeInteger(ship.pilotId)) ship.exit = PILOT_EXIT.NONE;
      if (exitLeg !== null) ship.leg = exitLeg;
    }
    releaseMotion(ship);
    if (ship.state === SHIP_STATE.IDLING) ship.idleUntil = null;
    if (warp(ship, now)) {
      ship.fleeOrdered = true;
      bump("fleeWarps");
    } else {
      bump("fleeRetry");
    }
  }

  function jumpOut(ship, gateId, reason, now) {
    const r = typeof scene.presentGateJumpOut === "function"
      ? call(() => scene.presentGateJumpOut(ship.systemId, ship.entityId, gateId)) : null;
    if (!r || r.ok !== true || r.sent !== true) {
      bump("jumpFxFailed");
      return false;
    }
    ship.state = SHIP_STATE.JUMPING;
    ship.jumpOutAt = now;
    ship.jumpReason = reason;
    ship.jumpGateId = gateId;
    bump("jumpOutFx");
    return true;
  }

  function jumpInSpec(spec) {
    if (T.gateJumpFxEnabled !== true || !spec || !Number.isSafeInteger(spec.gateId) || spec.undock === true) return {};
    if (!gateEventsOn()) return { jumpInMs: T.gateJumpInDurationMs };
    if (gateEventLeft <= 0) {
      bump("gateEventBudgetCut");
      return { jumpInMs: T.gateJumpInDurationMs };
    }
    gateEventLeft -= 1;
    return { jumpInMs: T.gateJumpInDurationMs, gateEvents: true };
  }

  function gateNodeOf(nodes, spec) {
    const gates = nodes && Array.isArray(nodes.gates) ? nodes.gates : [];
    return spec && Number.isSafeInteger(spec.gateId) ? gates.find((g) => g && g.itemId === spec.gateId) || null : null;
  }

  function arrivalSpec(plan, gateNode, offsetMeters) {
    if (T.gateArrivalPoseEnabled !== true || !plan || !plan.spec || !Number.isSafeInteger(plan.spec.gateId)
      || plan.spec.undock === true || !plan.targetPoint || !gateNode) {
      return {};
    }
    const radius = Number.isFinite(gateNode.radius) && gateNode.radius >= 0 ? gateNode.radius : 0;
    const pose = arrivalPoseOf(gateNode, plan.targetPoint, radius + offsetMeters, rng, T);
    if (!pose.ok) {
      bump("gateArrivalNoHeading");
      return {};
    }
    const rotate = gateEventLeft > 0;
    if (rotate) gateEventLeft -= 1;
    else bump("gateEventBudgetCut");
    return { arrivalPose: { position: pose.position, direction: pose.direction, rotate } };
  }

  function noteJumpIn(r, spec) {
    if (r.jumpIn === true) bump("jumpInFx");
    else if (r.jumpIn === false) bump("jumpFxFailed");
    if (r.arrival === true) bump("gateArrivalEvents");
    else if (r.arrival === false) bump("gateEventFailed");
    if (r.posed === true) bump("gateArrivalPoses");
    if (r.rotated === true) bump("gateArrivalRotations");
    else if (r.posed === true && spec && spec.arrivalPose && spec.arrivalPose.rotate === true) {
      bump("gateArrivalPoseFailed");
    }
  }

  function reclaimMembers(leader, now) {
    let pop = null;
    try {
      pop = PL.getPopulation();
    } catch (_err) {
      pop = null;
    }
    const dropped = [];
    for (const id of leader.groupShips) {
      const s = ships.get(id);
      if (!s || s.leaderPilotId !== leader.pilotId) continue;
      const c = pop && typeof pop.claimLive === "function"
        ? call(() => pop.claimLive(s.pilotId, s.systemId, now)) : null;
      if (c && c.ok === true && Number.isSafeInteger(c.token)) {
        s.token = c.token;
        s.leaderPilotId = null;
        bump("groupMembersReclaimed");
      } else {
        dropped.push(s);
      }
    }
    if (dropped.length === 0) return;
    const removed = despawnIds(leader.systemId, dropped.map((s) => s.entityId));
    for (const rid of removed) {
      const s = ships.get(rid);
      ships.delete(rid);
      if (s && pilotOf.get(s.pilotId) === rid) pilotOf.delete(s.pilotId);
      forgetAggro(rid);
    }
    bump("groupMembersDropped", removed.length);
  }

  function noteSystemAggression(list, live, seenOf, alarmOn, now) {
    const victims = [];
    for (const ship of list) {
      if (!ships.has(ship.entityId)) continue;
      const seenShip = live.get(ship.entityId);
      if (!seenShip || !noteAggression(ship, seenShip, now, T)) continue;
      bump("fleeTriggered");
      if (seenShip.position) victims.push({ entityId: ship.entityId, position: seenShip.position });
    }
    if (!alarmOn || victims.length === 0) return;
    bump("fleeAlarmVictims", victims.length);
    const candidates = list.filter((s) => ships.has(s.entityId)).map((ship) => ({ ship, seen: seenOf(ship) }));
    const plan = planAlarm({ now, T, victims, ships: candidates, budget: alarmLeft });
    for (const id of plan.alarmed) {
      const ship = ships.get(id);
      if (!ship) continue;
      ship.fleeUntil = now + T.fleeWindowMs;
      ship.alarmedAt = now;
      bump("fleeAlarmed");
      alarmLeft -= 1;
    }
    bump("fleeAlarmBudgetCut", plan.cut);
  }

  function runSystemLifecycle(systemId, list, now) {
    const fleeOn = T.fleeEnabled === true;
    const alarmOn = fleeOn && T.fleeAlarmEnabled === true;
    const ids = list.map((s) => s.entityId);
    const read = fleeOn && (alarmOn || list.some((s) => FLEE_ROLES.includes(s.role)))
      ? call(() => scene.readShips(systemId, ids, { aggression: true }))
      : call(() => scene.readShips(systemId, ids));
    if (!read || read.ok !== true) {
      fail("read", read && read.reason);
      return;
    }
    if (read.sceneLoaded !== true) {
      despawnShips(systemId, list, LEFT);
      return;
    }
    const live = new Map((Array.isArray(read.live) ? read.live : []).map((s) => [s.entityId, s]));
    const goneIds = [];
    let goneList = Array.isArray(read.gone) ? read.gone : [];
    if (GS !== null) {
      const isMemberShip = (id) => {
        const s = ships.get(id);
        return Boolean(s && Number.isSafeInteger(s.leaderPilotId));
      };
      goneList = [...goneList.filter(isMemberShip), ...goneList.filter((id) => !isMemberShip(id))];
    }
    for (const id of goneList) {
      const goneShip = ships.get(id);
      if (ships.delete(id)) {
        bump("gone");
        goneIds.push(id);
        releasePilot(goneShip, outcomeOf(goneShip, GONE));
        if (GS !== null && Array.isArray(goneShip.groupShips)) reclaimMembers(goneShip, now);
      }
    }
    if (goneIds.length > 0) call(() => scene.despawn(systemId, goneIds));
    let nodesRead = false;
    let nodesMemo = null;
    const nodesOf = () => {
      if (nodesRead) return nodesMemo;
      nodesRead = true;
      const r = call(() => scene.readNodes(systemId));
      if (r && r.ok === true) nodesMemo = r;
      else fail("read", r && r.reason);
      return nodesMemo;
    };
    const seenOf = (ship) => {
      const seenShip = live.get(ship.entityId);
      return seenShip ? { live: true, inWarp: seenShip.inWarp === true, position: seenShip.position || null }
        : { live: false, inWarp: false, position: null };
    };
    if (fleeOn) noteSystemAggression(list, live, seenOf, alarmOn, now);
    for (const ship of list) {
      if (!ships.has(ship.entityId)) continue;
      const seen = seenOf(ship);
      if (fleeOn) {
        if (!isExpired(ship, now, T)) {
          const f = fleeStepOf(ship, seen, now, T);
          if (f.kind === "hold") continue;
          if (f.kind === "flee") {
            flee(ship, seen, f.needTarget, nodesOf, now);
            continue;
          }
        }
      }
      const step = stepShip(ship, seen, now, T);
      if (step.kind === "run") ship.state = SHIP_STATE.RUNNING;
      else if (step.kind === "warp") warp(ship, now, step.immediate === true);
      else if (step.kind === "adoptWarp") {
        ship.preWarpState = ship.state;
        ship.state = SHIP_STATE.WARPING;
        ship.warpAt = now;
        ship.warpMode = WARP_MODE.IMMEDIATE;
      } else if (step.kind === "mine") {
        ship.state = SHIP_STATE.MINING;
        ship.mineUntil = now + ship.stayMs;
        ship.warpAttempts = 0;
      } else if (step.kind === "dwell") dwell(ship, now);
      else if (step.kind === "nextLeg") nextLeg(ship, now);
      else if (step.kind === "explore") explore(ship, seen, now);
      else if (step.kind === "leave") {
        const leg = ship.role === SHIP_ROLE.RATTER && ship.leg === PATROL_LEG.PATROL
          ? ship.legs[ship.legIndex] : null;
        if (leg?.anomaly && seen.position && !seen.inWarp
          && Math.hypot(seen.position.x - leg.point.x, seen.position.y - leg.point.y, seen.position.z - leg.point.z) <= T.arrivalMeters) {
          call(() => scene.closeRatterAnomaly(systemId, leg.anomaly, now));
        }
        leave(ship, now);
      }
      else if (step.kind === "arrived") {
        ship.state = SHIP_STATE.ARRIVED;
        ship.arrivedAt = now;
        bump("arrived");
        if (T.gateJumpFxEnabled === true && ship.target && ship.target.kind === "stargate") {
          jumpOut(ship, ship.target.itemId, DESPAWN_REASON.ARRIVED, now);
        }
      } else if (step.kind === "jumpOut") {
        if (!jumpOut(ship, step.gateId, step.reason, now)) despawnShips(systemId, [ship], step.reason);
      } else if (step.kind === "despawn") despawnShips(systemId, [ship], step.reason);
    }
    if (T.miningBeamsEnabled === true && typeof scene.presentMiningBeams === "function") {
      stepBeams(systemId, list, live, now);
    }
  }

  function stepBeams(systemId, list, live, now) {
    const st = systemOf(systemId, now);
    const miners = [];
    for (const ship of list) {
      if (!ships.has(ship.entityId) || ship.state !== SHIP_STATE.MINING) continue;
      const seen = live.get(ship.entityId);
      if (!seen || !seen.position || seen.inWarp === true) continue;
      miners.push({ entityId: ship.entityId, position: seen.position,
        beltId: Number.isSafeInteger(ship.beltId) ? ship.beltId : null });
    }
    const beams = st.beams || null;
    const pending = Boolean(beams && beams.approaching && beams.approaching.size > 0);
    if (miners.length === 0 && (!beams || beams.shown.size === 0) && !pending) return;
    if (beamFxLeft <= 0 && !pending) return;
    const read = call(() => scene.readPlayers(systemId));
    if (!read || read.ok !== true || !Array.isArray(read.ships)) {
      if (!(read && read.reason === "SCENE_NOT_LOADED")) fail("read", read && read.reason);
      return;
    }
    const players = read.ships.map((p) => ({ characterId: p && p.characterId, position: (p && p.position) || null,
      inWarp: Boolean(p && p.inWarp === true) }));
    const approachOn = T.miningBeamApproachEnabled === true;
    const plan = planBeams({ now, miners, players, state: beams, viewMeters: T.miningBeamViewMeters,
      refreshMs: T.miningBeamRefreshMs, ...(approachOn ? { retryMs: T.miningBeamRetryMs } : {}) });
    if (plan.start.length === 0 && plan.stop.length === 0 && plan.release.length === 0) {
      st.beams = applyBeams(beams, plan, { ok: true, started: [] });
      return;
    }
    const req = { start: plan.start, stop: plan.stop, rockRangeMeters: T.miningBeamRockMeters,
      maxFx: Math.max(0, beamFxLeft) };
    if (approachOn) {
      req.release = plan.release;
      req.approach = { startMeters: T.miningBeamStartMeters, followMeters: T.miningBeamApproachMeters };
    }
    const r = call(() => scene.presentMiningBeams(systemId, req));
    if (!r || r.ok !== true) {
      fail("beams", r && (r.detail ? `${r.reason} ${r.detail}` : r.reason));
      st.beams = applyBeams(beams, plan, r);
      return;
    }
    const sent = Number.isSafeInteger(r.fxSent) ? r.fxSent : 0;
    const orders = Number.isSafeInteger(r.ordersSent) ? r.ordersSent : 0;
    beamFxLeft -= sent + orders;
    bump("miningBeamFx", sent);
    bump("miningBeamBudgetCut", Number.isSafeInteger(r.budgetCut) ? r.budgetCut : 0);
    bump("miningBeamNoRock", Array.isArray(r.noRock) ? r.noRock.length : 0);
    if (approachOn) {
      bump("miningBeamApproachOrders", orders);
      bump("miningBeamApproaching", Array.isArray(r.approaching) ? r.approaching.length : 0);
      bump("miningBeamApproachBusy", Array.isArray(r.busy) ? r.busy.length : 0);
      bump("miningBeamApproachRefused", Number.isSafeInteger(r.refused) ? r.refused : 0);
      bump("miningBeamApproachReleased", Array.isArray(r.released) ? r.released.length : 0);
    }
    if (plan.full) bump("miningBeamRefresh");
    st.beams = applyBeams(beams, plan, r);
  }

  function runLifecycle(now) {
    for (const [systemId, list] of shipsBySystem()) {
      try {
        runSystemLifecycle(systemId, list, now);
      } catch (err) {
        fail("read", messageOf(err));
      }
    }
  }

  function systemOf(systemId, now) {
    let st = systems.get(systemId);
    if (!st) {
      st = { nextSpawnAt: now + Math.floor(rng() * T.spawnIntervalMs), emptySince: null, names: new Map() };
      systems.set(systemId, st);
    }
    return st;
  }

  function playersOf(systemId) {
    const r = call(() => scene.readPlayers(systemId));
    if (r && r.ok === true && Array.isArray(r.ships)) return r.ships.length;
    if (r && r.reason === "SCENE_NOT_LOADED") return 0;
    fail("read", r && r.reason);
    return null;
  }

  function runExit(now, presence) {
    for (const [systemId, list] of shipsBySystem()) {
      try {
        const st = systemOf(systemId, now);
        let empty = spaceOf(presence, systemId) <= 0;
        if (!empty) {
          const players = playersOf(systemId);
          if (players === null) continue;
          empty = players === 0;
        }
        if (!empty) {
          st.emptySince = null;
          continue;
        }
        if (st.emptySince === null) st.emptySince = now;
        if (now - st.emptySince >= T.exitGraceMs) despawnShips(systemId, list, LEFT);
      } catch (err) {
        fail("despawn", messageOf(err));
      }
    }
  }

  function despawnOrphans(systemId) {
    const listed = call(() => scene.listTrafficIds(systemId));
    if (!listed || listed.ok !== true || !Array.isArray(listed.ids)) {
      fail("read", listed && listed.reason);
      return;
    }
    const orphans = listed.ids.filter((id) => !ships.has(id)).slice(0, T.maxShipsGlobal);
    bump("orphans", despawnIds(systemId, orphans).length);
  }

  function pickName(systemId, st) {
    const sp = typeof deps.speakersOf === "function" ? call(() => deps.speakersOf(systemId)) : null;
    if (!sp || sp.ok !== true) return null;
    const ids = [];
    const seen = new Set();
    for (const id of [...(Array.isArray(sp.civilians) ? sp.civilians : []),
      ...(Array.isArray(sp.residents) ? sp.residents : [])]) {
      if (Number.isSafeInteger(id) && id > 0 && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    const cache = st.names;
    for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
    const missing = ids.filter((id) => !cache.has(id)).slice(0, NAME_READ_MAX);
    if (missing.length > 0 && typeof deps.readCharacterNames === "function") {
      const read = call(() => deps.readCharacterNames(missing));
      if (read && read.ok === true && read.names instanceof Map) {
        for (const id of missing) cache.set(id, slimNameOf(read.names.get(id)));
      } else {
        fail("names", read && read.reason);
      }
    }
    const inUse = new Set();
    for (const ship of ships.values()) if (ship.systemId === systemId && ship.slimName) inUse.add(ship.slimName);
    for (const id of ids) {
      const name = cache.get(id);
      if (typeof name === "string" && !inUse.has(name)) return name;
    }
    return null;
  }

  function planOne(systemId, nodes, now) {
    const role = pickRole(rng, nodes, T, { RATTER: rattersIn(systemId), EXPLORER: explorersIn(systemId) });
    if (role === SHIP_ROLE.RATTER) {
      const route = pickRatterRoute(nodes, rng, T);
      return route.ok ? ratterPlanOf(route, systemId) : null;
    }
    if (role === SHIP_ROLE.EXPLORER) {
      const route = pickExplorerRoute(nodes, rng, T);
      return route.ok ? explorerPlanOf(route) : null;
    }
    if (role === SHIP_ROLE.UNDOCK) {
      const route = pickUndockRoute(nodes, rng);
      if (!route.ok) return null;
      return { role, spec: { stationId: route.station.itemId, undock: true, undockRunMeters: T.undockRunMeters },
        state: SHIP_STATE.SPAWNED, startGateId: null, startStationId: route.station.itemId,
        target: { kind: route.target.kind, itemId: route.target.itemId },
        targetPoint: landingPointOf(route.station.position, route.target, T), docking: false, idleUntil: null };
    }
    if (role === SHIP_ROLE.GATE_IDLE) {
      const idle = pickIdleGate(nodes, rng, T);
      if (!idle.ok) return null;
      return { role, spec: { gateId: idle.gate.itemId }, state: SHIP_STATE.IDLING, startGateId: idle.gate.itemId,
        startStationId: null, target: null, targetPoint: null, docking: false,
        idleUntil: now + Math.min(idle.idleMs, T.maxLifetimeMs) };
    }
    if (role === SHIP_ROLE.MINER) {
      const route = pickMinerRoute(nodes, rng, T);
      if (!route.ok) return null;
      return minerPlanOf(route);
    }
    const route = pickRoute(nodes, rng, T);
    if (!route.ok) return null;
    return haulerPlanOf(systemId, route.startGate, route.target);
  }

  function minerPlanOf(route) {
    const fromStation = route.start.kind === "station";
    const spec = fromStation ? { stationId: route.start.node.itemId, undock: true, undockRunMeters: T.undockRunMeters }
      : { gateId: route.start.node.itemId };
    return { role: SHIP_ROLE.MINER, spec, state: SHIP_STATE.SPAWNED,
      startGateId: fromStation ? null : route.start.node.itemId,
      startStationId: fromStation ? route.start.node.itemId : null,
      target: { kind: route.exit.kind, itemId: route.exit.itemId }, targetPoint: route.beltPoint, docking: false,
      idleUntil: null, miner: { leg: MINER_LEG.BELT, beltId: route.belt.itemId, stayMs: route.stayMs,
        mineUntil: null, exitPoint: landingPointOf(route.beltPoint, route.exit, T) } };
  }

  function pickRatterAnomaly(systemId) {
    if (!(T.ratterAnomalyPermille > 0) || siteReadsLeft <= 0 || typeof scene.readRatterAnomalies !== "function"
      || typeof scene.closeRatterAnomaly !== "function" || rng() * PERMILLE >= T.ratterAnomalyPermille) return null;
    siteReadsLeft -= 1;
    const sites = call(() => scene.readRatterAnomalies(systemId));
    if (!Array.isArray(sites)) return null;
    const reserved = new Set();
    for (const ship of ships.values()) {
      if (ship.systemId !== systemId || ship.role !== SHIP_ROLE.RATTER || ship.leg !== PATROL_LEG.PATROL) continue;
      const anomaly = ship.legs?.[ship.legIndex]?.anomaly;
      if (anomaly) reserved.add(anomaly.instanceId);
    }
    const available = sites.filter((site) => !reserved.has(site.instanceId));
    return available.length > 0 ? available[Math.floor(rng() * available.length)] : null;
  }

  function ratterPlanOf(route, systemId) {
    const anomaly = pickRatterAnomaly(systemId);
    const legs = anomaly ? [{ anomaly, targetId: anomaly.siteId, point: anomaly.point, dwellMs: T.ratterAnomalyDwellMs }] : route.legs;
    const fromStation = route.start.kind === "station";
    const spec = fromStation ? { stationId: route.start.node.itemId, undock: true, undockRunMeters: T.undockRunMeters }
      : { gateId: route.start.node.itemId };
    const lastPoint = legs[legs.length - 1].point;
    return { role: SHIP_ROLE.RATTER, spec, state: SHIP_STATE.SPAWNED,
      startGateId: fromStation ? null : route.start.node.itemId,
      startStationId: fromStation ? route.start.node.itemId : null,
      target: { kind: route.exit.kind, itemId: route.exit.itemId }, targetPoint: legs[0].point,
      docking: false, idleUntil: null, patrol: { legs, legIndex: 0, leg: PATROL_LEG.PATROL,
        dwellUntil: null, orbiting: false, stayMs: anomaly ? T.ratterAnomalyDwellMs : route.stayMs, exitPoint: landingPointOf(lastPoint, route.exit, T) } };
  }

  function explorerPlanOf(route) {
    const fromStation = route.start.kind === "station";
    const spec = fromStation ? { stationId: route.start.node.itemId, undock: true, undockRunMeters: T.undockRunMeters }
      : { gateId: route.start.node.itemId };
    const safe = route.safePoint || null;
    const legs = Object.freeze([Object.freeze({ kind: EXPLORER_LEG.SAFE, targetId: 0, point: safe,
      dwellMs: T.explorerScanMs * T.explorerMaxSites })]);
    return { role: SHIP_ROLE.EXPLORER, spec, state: SHIP_STATE.SPAWNED,
      startGateId: fromStation ? null : route.start.node.itemId,
      startStationId: fromStation ? route.start.node.itemId : null,
      target: { kind: route.exit.kind, itemId: route.exit.itemId }, targetPoint: safe,
      docking: false, idleUntil: null, patrol: { legs, legIndex: 0, leg: PATROL_LEG.PATROL, dwellUntil: null,
        orbiting: false, stayMs: route.stayMs,
        exitPoint: landingPointOf(safe || route.start.node.position, route.exit, T) } };
  }

  function noteRole(plan) {
    if (plan.role === SHIP_ROLE.UNDOCK) bump("undocked");
    if (plan.role === SHIP_ROLE.MINER) bump("miners");
    if (plan.role === SHIP_ROLE.RATTER) bump("ratters");
    if (plan.role !== SHIP_ROLE.EXPLORER) return;
    bump("explorers");
    if (!plan.targetPoint) bump("explorerNoSafeSpot");
  }

  function haulerPlanOf(systemId, startGate, target) {
    let targetPoint = landingPointOf(startGate.position, target, T);
    let docking = false;
    if (target.kind === "station" && T.dockToPointEnabled === true) {
      const dock = call(() => scene.dockPointOf(systemId, target.itemId));
      if (dock && dock.ok === true && dock.point) {
        targetPoint = dock.point;
        docking = true;
      }
    }
    return { role: SHIP_ROLE.HAULER, spec: { gateId: startGate.itemId }, state: SHIP_STATE.SPAWNED,
      startGateId: startGate.itemId, startStationId: null,
      target: { kind: target.kind, itemId: target.itemId }, targetPoint, docking, idleUntil: null };
  }

  function spawnOne(systemId, nodes, now, st) {
    const plan = planOne(systemId, nodes, now);
    if (plan === null) {
      bump("noRoute");
      return;
    }
    const list = profilesOf(plan.role);
    const profileId = pickProfile(list, rng);
    if (profileId === null) {
      bump("noProfile");
      return;
    }
    const slimName = T.namesEnabled === true ? pickName(systemId, st) : null;
    const hull = plan.spec.undock === true ? list.find((p) => p.profileId === profileId) : null;
    const shipTypeId = hull && Number.isSafeInteger(hull.shipTypeId) && hull.shipTypeId > 0 ? hull.shipTypeId : null;
    const spec = { profileId, ...plan.spec,
      spawnOffsetMeters: T.spawnOffsetMeters, ...(slimName !== null ? { slimName } : {}),
      ...(shipTypeId !== null ? { shipTypeId } : {}), ...jumpInSpec(plan.spec),
      ...arrivalSpec(plan, gateNodeOf(nodes, plan.spec), T.spawnOffsetMeters) };
    const r = call(() => scene.spawnCivilian(systemId, spec));
    if (!r || r.ok !== true || !Number.isSafeInteger(r.entityId) || r.entityId <= 0) {
      fail("spawn", r && (r.detail ? `${r.reason} ${r.detail}` : r.reason));
      return;
    }
    noteJumpIn(r, spec);
    ships.set(r.entityId, { entityId: r.entityId, systemId, state: plan.state, role: plan.role, profileId,
      startGateId: plan.startGateId, startStationId: plan.startStationId, target: plan.target,
      targetPoint: plan.targetPoint, docking: plan.docking, idleUntil: plan.idleUntil, slimName,
      spawnedAt: now, warpAt: null, arrivedAt: null, warpAttempts: 0, ...(plan.miner || {}),
      ...(plan.patrol || {}) });
    bump("spawned");
    noteRole(plan);
    if (T.namesEnabled === true) bump(slimName !== null ? "named" : "noName");
    metric("count", TRAFFIC_METRICS.spawned, 1);
  }

  function populationOf() {
    if (!PL) return null;
    try {
      const pop = PL.getPopulation();
      if (!pop || typeof pop.getStatus !== "function" || typeof pop.liveCandidatesIn !== "function"
        || typeof pop.claimLive !== "function" || typeof pop.releaseLive !== "function") return null;
      const st = pop.getStatus();
      return st && st.state === "running" ? pop : null;
    } catch (_err) {
      return null;
    }
  }

  function pilotCandidates(systemId, now, pop) {
    let list = null;
    if (hullProfiles) {
      const v = verifiedHulls();
      if (v === null) return [];
      const acceptHull = (t) => {
        if (v.has(t)) return true;
        bump("pilotNoLiveProfile");
        return false;
      };
      list = call(() => pop.liveCandidatesIn(systemId, now - PLS.maxEventAgeMs, PLS.maxSpawnsPerSystemPass,
        acceptHull));
    } else {
      list = call(() => pop.liveCandidatesIn(systemId, now - PLS.maxEventAgeMs, PLS.maxSpawnsPerSystemPass));
    }
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const c of list) {
      if (!c || !Number.isSafeInteger(c.pilotId) || pilotOf.has(c.pilotId)) continue;
      if (backoff && backoff.blocked(`pop:${c.pilotId}`, now) !== null) {
        bump("pilotBackoff");
        continue;
      }
      out.push(c);
    }
    return out;
  }

  function pilotPlanOf(systemId, nodes, cand) {
    const route = planPilot(cand, nodes, rng, T);
    if (!route.ok) {
      bump(route.reason === "NO_GATE" ? "pilotNoGate" : "noRoute");
      return null;
    }
    if (route.role === SHIP_ROLE.MINER) return minerPlanOf(route.miner);
    if (route.role === SHIP_ROLE.RATTER) return ratterPlanOf(route.patrol, systemId);
    if (route.role === SHIP_ROLE.EXPLORER) return explorerPlanOf(route.explore);
    if (route.role === SHIP_ROLE.UNDOCK) {
      const station = route.start.node;
      return { role: SHIP_ROLE.UNDOCK, spec: { stationId: station.itemId, undock: true,
        undockRunMeters: T.undockRunMeters }, state: SHIP_STATE.SPAWNED, startGateId: null,
      startStationId: station.itemId, target: { kind: route.target.kind, itemId: route.target.itemId },
      targetPoint: landingPointOf(station.position, route.target, T), docking: false, idleUntil: null };
    }
    return haulerPlanOf(systemId, route.start.node, route.target);
  }

  function pilotName(systemId, st, pilotId) {
    const lease = typeof PL.leaseOf === "function" ? call(() => PL.leaseOf(pilotId)) : null;
    const characterId = lease && lease.ok === true && Number.isSafeInteger(lease.characterId)
      && lease.characterId > 0 ? lease.characterId : null;
    if (characterId === null) return null;
    if (!st.names.has(characterId) && typeof deps.readCharacterNames === "function") {
      const read = call(() => deps.readCharacterNames([characterId]));
      if (read && read.ok === true && read.names instanceof Map) {
        st.names.set(characterId, slimNameOf(read.names.get(characterId)));
      } else {
        fail("names", read && read.reason);
      }
    }
    const name = st.names.get(characterId);
    if (typeof name !== "string") return null;
    for (const ship of ships.values()) if (ship.systemId === systemId && ship.slimName === name) return null;
    return name;
  }

  function verifiedHulls() {
    if (hullsVerified !== null) return hullsVerified;
    if (hullsFailedPass === passNo) return null;
    const ids = new Set();
    for (const e of hullProfiles.values()) {
      ids.add(e.shipTypeId);
      ids.add(e.presentationTypeId);
    }
    const r = call(() => PL.readTypeLooks([...ids]));
    if (!r || r.ok !== true || !(r.looks instanceof Map)) {
      hullsFailedPass = passNo;
      bump("pilotHullsUnverified");
      return null;
    }
    const v = verifyPilotHulls(hullProfiles, r.looks);
    hullsVerified = v.verified;
    hullsRejected = v.rejected;
    bump("pilotHullLookRejected", v.rejected.length);
    if (v.rejected.length > 0) {
      log(`pilot hulls without an NPC type of their graphic (FAR only): ${v.rejected.join(",")}`);
    }
    return hullsVerified;
  }

  function spawnPilot(systemId, nodes, now, st, cand, pop, reserve) {
    if (pilotOf.has(cand.pilotId)) return 0;
    if (cand.role === SHIP_ROLE.RATTER && rattersIn(systemId) >= T.ratterMaxPerSystem) {
      bump("ratterCapped");
      return 0;
    }
    if (cand.role === SHIP_ROLE.EXPLORER && explorersIn(systemId) >= T.explorerMaxPerSystem) {
      bump("explorerCapped");
      return 0;
    }
    let hullOwn = null;
    if (hullProfiles) {
      const v = verifiedHulls();
      if (v === null) return 0;
      hullOwn = v.get(cand.shipTypeId) || null;
      if (!hullOwn) {
        bump("pilotNoLiveProfile");
        return 0;
      }
    }
    const plan = pilotPlanOf(systemId, nodes, cand);
    if (plan === null) return 0;
    const pf = hullOwn ? { list: null, profileId: hullOwn.profileId } : profileFor(plan.role, cand.shipTypeId);
    const list = pf.list;
    const profileId = pf.profileId;
    if (profileId === null) {
      bump("noProfile");
      return 0;
    }
    const claim = call(() => pop.claimLive(cand.pilotId, systemId, now));
    if (!claim || claim.ok !== true || !Number.isSafeInteger(claim.token)) return 0;
    const key = `pop:${cand.pilotId}`;
    let refused = true;
    try {
      const slimName = T.namesEnabled === true ? pilotName(systemId, st, cand.pilotId) : null;
      const hull = plan.spec.undock !== true ? null
        : hullOwn || list.find((p) => p.profileId === profileId);
      const shipTypeId = hull && Number.isSafeInteger(hull.shipTypeId) && hull.shipTypeId > 0 ? hull.shipTypeId : null;
      const gateNode = gateNodeOf(nodes, plan.spec);
      const spec = { profileId, ...plan.spec,
        spawnOffsetMeters: T.spawnOffsetMeters, ...(slimName !== null ? { slimName } : {}),
        ...(shipTypeId !== null ? { shipTypeId } : {}), ...jumpInSpec(plan.spec),
        ...arrivalSpec(plan, gateNode, T.spawnOffsetMeters) };
      const r = call(() => scene.spawnCivilian(systemId, spec));
      if (!r || r.ok !== true || !Number.isSafeInteger(r.entityId) || r.entityId <= 0) {
        const reason = r && r.reason;
        if (backoff && reason !== "SCENE_NPC_BUDGET") backoff.note(key, failureReasonOf(reason, r && r.detail), now);
        fail("spawn", r && (r.detail ? `${r.reason} ${r.detail}` : r.reason));
        return 0;
      }
      noteJumpIn(r, spec);
      const leaderShip = { entityId: r.entityId, systemId, state: plan.state, role: plan.role, profileId,
        startGateId: plan.startGateId, startStationId: plan.startStationId, target: plan.target,
        targetPoint: plan.targetPoint, docking: plan.docking, idleUntil: plan.idleUntil, slimName,
        spawnedAt: now, warpAt: null, arrivedAt: null, warpAttempts: 0, ...(plan.miner || {}),
        ...(plan.patrol || {}), pilotId: cand.pilotId, token: claim.token, exit: cand.exit };
      ships.set(r.entityId, leaderShip);
      pilotOf.set(cand.pilotId, r.entityId);
      refused = false;
      if (backoff) backoff.clear(key);
      bump("spawned");
      bump("pilotSpawned");
      noteRole(plan);
      if (T.namesEnabled === true) bump(slimName !== null ? "named" : "noName");
      metric("count", TRAFFIC_METRICS.spawned, 1);
      if (GS === null || typeof pop.liveGroupOf !== "function") return 1;
      try {
        return 1 + spawnMembers(systemId, now, st, cand, pop, plan, leaderShip, claim.token, reserve, gateNode);
      } catch (err) {
        fail("spawn", messageOf(err));
        return 1 + (Array.isArray(leaderShip.groupShips) ? leaderShip.groupShips.length : 0);
      }
    } finally {
      if (refused) call(() => pop.releaseLive(cand.pilotId, claim.token, "REFUSED", now));
    }
  }

  function profileFor(role, shipTypeId) {
    const list = profilesOf(role);
    const own = byRole ? list.find((p) => p && p.shipTypeId === shipTypeId) : null;
    if (!own) bump("pilotHullFallback");
    return { list, profileId: own ? own.profileId : pickProfile(list, rng) };
  }

  function spawnMembers(systemId, now, st, cand, pop, plan, leaderShip, token, reserve, gateNode) {
    const g = call(() => pop.liveGroupOf(cand.pilotId, systemId, now));
    if (!g || g.ok !== true || !Array.isArray(g.members) || g.members.length === 0) return 0;
    const capRoom = Math.min(T.maxShipsPerSystem - liveIn(systemId), T.maxShipsGlobal - ships.size);
    const shipRoom = Math.max(0, capRoom - (Number.isSafeInteger(reserve) && reserve > 0 ? reserve : 0));
    const roleRoom = plan.role === SHIP_ROLE.RATTER ? T.ratterMaxPerSystem - rattersIn(systemId)
      : plan.role === SHIP_ROLE.EXPLORER ? T.explorerMaxPerSystem - explorersIn(systemId) : shipRoom;
    const memberRoom = Math.min(shipRoom, Math.max(0, roleRoom));
    let k = 0;
    for (let i = 0; i < g.members.length; i += 1) {
      if (k >= memberRoom || ships.size >= T.maxShipsGlobal) {
        bump("groupMembersCapped", g.members.length - i);
        break;
      }
      const m = g.members[i];
      if (!m || !Number.isSafeInteger(m.pilotId) || pilotOf.has(m.pilotId)) continue;
      let profileId = null;
      let hull = null;
      if (hullProfiles) {
        const v = verifiedHulls();
        hull = v ? v.get(m.shipTypeId) || null : null;
        if (!hull) {
          bump("groupMemberNoProfile");
          continue;
        }
        profileId = hull.profileId;
      } else {
        const pf = profileFor(plan.role, m.shipTypeId);
        if (pf.profileId === null) {
          bump("noProfile");
          continue;
        }
        profileId = pf.profileId;
        hull = pf.list.find((p) => p && p.profileId === profileId) || null;
      }
      const slimName = T.namesEnabled === true ? pilotName(systemId, st, m.pilotId) : null;
      const shipTypeId = plan.spec.undock === true && hull && Number.isSafeInteger(hull.shipTypeId)
        && hull.shipTypeId > 0 ? hull.shipTypeId : null;
      const offset = T.spawnOffsetMeters + GS.spacingMeters * (k + 1);
      const spec = { profileId, ...plan.spec,
        spawnOffsetMeters: offset, ...(slimName !== null ? { slimName } : {}),
        ...(shipTypeId !== null ? { shipTypeId } : {}), ...jumpInSpec(plan.spec),
        ...arrivalSpec(plan, gateNode || null, offset) };
      const r = call(() => scene.spawnCivilian(systemId, spec));
      if (!r || r.ok !== true || !Number.isSafeInteger(r.entityId) || r.entityId <= 0) {
        fail("spawn", r && (r.detail ? `${r.reason} ${r.detail}` : r.reason));
        if (r && r.reason === "SCENE_NPC_BUDGET") break;
        continue;
      }
      noteJumpIn(r, spec);
      ships.set(r.entityId, { entityId: r.entityId, systemId, state: plan.state, role: plan.role, profileId,
        startGateId: plan.startGateId, startStationId: plan.startStationId, target: plan.target,
        targetPoint: plan.targetPoint, docking: plan.docking, idleUntil: plan.idleUntil, slimName,
        spawnedAt: now, warpAt: null, arrivedAt: null, warpAttempts: 0, ...(plan.miner || {}),
        ...(plan.patrol || {}), pilotId: m.pilotId, token, leaderPilotId: cand.pilotId, exit: cand.exit });
      if (!Array.isArray(leaderShip.groupShips)) leaderShip.groupShips = [];
      leaderShip.groupShips.push(r.entityId);
      pilotOf.set(m.pilotId, r.entityId);
      k += 1;
      bump("spawned");
      bump("groupMemberSpawned");
      noteRole(plan);
      if (T.namesEnabled === true) bump(slimName !== null ? "named" : "noName");
      metric("count", TRAFFIC_METRICS.spawned, 1);
    }
    return k;
  }

  function spawnPilotsIn(systemId, now, pop) {
    const st = systemOf(systemId, now);
    st.nextSpawnAt = now + PLS.spawnGapMs;
    st.emptySince = null;
    const cands = pilotCandidates(systemId, now, pop);
    if (cands.length === 0) return;
    const room = Math.min(T.maxShipsPerSystem - liveIn(systemId), T.maxShipsGlobal - ships.size);
    const count = Math.max(0, Math.min(cands.length, room));
    if (cands.length > count) bump("pilotCapRefused", cands.length - count);
    if (count === 0) return;
    despawnOrphans(systemId);
    const nodes = call(() => scene.readNodes(systemId));
    if (!nodes || nodes.ok !== true) {
      fail("read", nodes && nodes.reason);
      return;
    }
    for (let i = 0; i < count && ships.size < T.maxShipsGlobal; i += 1) {
      spawnPilot(systemId, nodes, now, st, cands[i], pop, count - i - 1);
    }
  }

  function spawnIn(systemId, count, now, pop) {
    const st = systemOf(systemId, now);
    st.nextSpawnAt = now + T.spawnIntervalMs;
    st.emptySince = null;
    despawnOrphans(systemId);
    const nodes = call(() => scene.readNodes(systemId));
    if (!nodes || nodes.ok !== true) {
      fail("read", nodes && nodes.reason);
      return;
    }
    let left = count;
    if (pop) {
      const cands = pilotCandidates(systemId, now, pop);
      const take = Math.min(cands.length, left);
      if (cands.length > take) bump("pilotCapRefused", cands.length - take);
      let extra = 0;
      for (let i = 0; i < take && ships.size < T.maxShipsGlobal; i += 1) {
        extra += Math.max(0, spawnPilot(systemId, nodes, now, st, cands[i], pop, take - i - 1) - 1);
      }
      left -= take;
      left = Math.max(0, left - extra);
    }
    for (let i = 0; i < left && ships.size < T.maxShipsGlobal; i += 1) spawnOne(systemId, nodes, now, st);
  }

  function secClassOf(systemId) {
    const d = call(() => deps.describeSystem(systemId));
    if (d && typeof d.secClass === "string") return d.secClass;
    if (typeof deps.secClassOf !== "function") return null;
    const s = call(() => deps.secClassOf(systemId));
    return typeof s === "string" ? s : null;
  }

  function runSpawn(now, presence) {
    if (!presence) return;
    let observed = [];
    try {
      observed = presence.observedSystems().map(Number);
    } catch (_err) {
      observed = [];
    }
    const candidates = observed.filter((id) => Number.isSafeInteger(id) && id > 0 && spaceOf(presence, id) > 0
      && T.bands.includes(secClassOf(id))).sort((a, b) => a - b);
    if (candidates.length === 0) return;
    if (!governorAdmits()) {
      bump("deferred.GOVERNOR");
      return;
    }
    if (ships.size >= T.maxShipsGlobal) {
      bump("deferred.GLOBAL_FULL");
      return;
    }
    let start = candidates.findIndex((id) => id > systemCursor);
    if (start < 0) start = 0;
    const pop = populationOf();
    const replace = pop !== null && PLS.trafficMode === "replace";
    const input = [];
    for (let i = 0; i < candidates.length && input.length < T.maxSystemsPerPass; i += 1) {
      const systemId = candidates[(start + i) % candidates.length];
      const st = systemOf(systemId, now);
      if (now < st.nextSpawnAt) continue;
      const players = playersOf(systemId);
      if (players === null) continue;
      if (replace) {
        input.push({ systemId, players });
        continue;
      }
      const wanted = Number(call(() => deps.wantedOf(systemId, now))) || 0;
      input.push({ systemId, wanted, players, live: liveIn(systemId), nextSpawnAt: st.nextSpawnAt });
    }
    if (input.length > 0) systemCursor = input[input.length - 1].systemId;
    if (replace) {
      for (const entry of input) {
        if (!(entry.players > 0)) continue;
        try {
          spawnPilotsIn(entry.systemId, now, pop);
        } catch (err) {
          fail("spawn", messageOf(err));
        }
      }
      return;
    }
    for (const entry of planSpawns({ now, globalLive: ships.size, candidates: input }, T)) {
      try {
        spawnIn(entry.systemId, entry.count, now, pop);
      } catch (err) {
        fail("spawn", messageOf(err));
      }
    }
  }

  function prune(presence) {
    let observed = new Set();
    try {
      observed = new Set(presence ? presence.observedSystems().map(Number) : []);
    } catch (_err) {
      observed = new Set();
    }
    const busy = new Set([...ships.values()].map((s) => s.systemId));
    for (const systemId of [...systems.keys()]) {
      if (!busy.has(systemId) && !observed.has(systemId)) systems.delete(systemId);
    }
  }

  function aggroBump(name, n = 1) {
    if (!aggroCounters || !(n > 0) || !Object.prototype.hasOwnProperty.call(aggroCounters, name)) return;
    aggroCounters[name] += n;
  }

  function failAggro(detail) {
    aggroBump("failed");
    if (loggedFailures.has("aggro")) return;
    loggedFailures.add("aggro");
    log(`aggro failed (${String(detail || "NO_RESULT").slice(0, MAX_DETAIL)}); further failures only counted`);
  }

  function countRelease(r) {
    if (!r || r.ok !== true) return;
    aggroBump("attackersReleased", Number.isSafeInteger(r.released) ? r.released : 0);
    aggroBump("attackersKept", Number.isSafeInteger(r.kept) ? r.kept : 0);
    aggroBump("releaseFailed", Number.isSafeInteger(r.releaseFailed) ? r.releaseFailed : 0);
  }

  function forgetAggro(entityId) {
    const a = armed.get(entityId);
    armed.delete(entityId);
    cooldownUntil.delete(entityId);
    if (!a || !Array.isArray(a.borrowed) || a.borrowed.length === 0 || aggroOff
      || typeof scene.disarmPilotTarget !== "function") return;
    countRelease(call(() => scene.disarmPilotTarget(a.systemId, entityId, a.borrowed)));
  }

  function aggroSceneReady() {
    if (aggroOff) return false;
    const absent = AGGRO_SCENE_METHODS.filter((name) => typeof scene[name] !== "function");
    if (absent.length === 0) return true;
    aggroOff = true;
    failAggro(`SEAM ${absent.join(",")}`);
    return false;
  }

  function ratBump(name, n = 1) {
    if (!ratCounters || !(n > 0) || !Object.prototype.hasOwnProperty.call(ratCounters, name)) return;
    ratCounters[name] += n;
  }

  function ratSceneReady() {
    if (VR === null || ratOff) return false;
    const absent = RAT_AGGRO_SCENE_METHODS.filter((name) => typeof scene[name] !== "function");
    if (absent.length === 0) return true;
    ratOff = true;
    failAggro(`SEAM ${absent.join(",")}`);
    return false;
  }

  function ratWindowCount(systemId, now) {
    const list = ratWindow.get(systemId);
    if (!list) return 0;
    const fresh = list.filter((t) => t > now - VR.windowMs);
    if (fresh.length === 0) ratWindow.delete(systemId);
    else ratWindow.set(systemId, fresh);
    return fresh.length;
  }

  function releaseEngaged(entityId, a) {
    const r = call(() => scene.releaseEngagedRats(a.systemId, entityId, a.borrowed));
    if (!r || r.ok !== true || !Array.isArray(r.keep)) {
      if (!(r && r.reason === "SCENE_NOT_LOADED")) failAggro(r && r.reason);
      return false;
    }
    a.borrowed = r.keep;
    const released = Number.isSafeInteger(r.released) ? r.released : 0;
    ratBump("engagedReleased", released);
    aggroBump("attackersReleased", released);
    return r.keep.length === 0;
  }

  function disarmDue(now) {
    const rats = VR !== null && ratSceneReady();
    for (const [entityId, a] of [...armed]) {
      if (!ships.has(entityId)) {
        forgetAggro(entityId);
        continue;
      }
      const noRatLeft = rats && a.vendor === true && releaseEngaged(entityId, a);
      if (!noRatLeft && now - a.armedAt < AG.holdMs) continue;
      const r = call(() => scene.disarmPilotTarget(a.systemId, entityId, a.borrowed));
      if (r && r.ok === true) {
        armed.delete(entityId);
        cooldownUntil.set(entityId, now + AG.cooldownMs);
        aggroBump("disarmed");
        countRelease(r);
      } else if (!(r && r.reason === "SCENE_NOT_LOADED")) {
        failAggro(r && r.reason);
      }
    }
  }

  function aggroSystems(now) {
    const by = new Map();
    for (const ship of ships.values()) {
      if (!Number.isSafeInteger(ship.pilotId) || armed.has(ship.entityId) || PATROL_ROLES.includes(ship.role)) continue;
      const until = cooldownUntil.get(ship.entityId);
      if (until !== undefined) {
        if (until > now) continue;
        cooldownUntil.delete(ship.entityId);
      }
      if (!by.has(ship.systemId)) by.set(ship.systemId, []);
      by.get(ship.systemId).push(ship.entityId);
    }
    return [...by.entries()].sort((a, b) => a[0] - b[0]);
  }

  function standingsOf() {
    const pop = populationOf();
    const st = pop && typeof pop.standings === "function" ? call(() => pop.standings()) : null;
    return st && typeof st.relationOf === "function" && typeof st.profileOf === "function" ? st : null;
  }

  function runAggro(now) {
    if (!aggroSceneReady()) return;
    aggroBump("passes");
    disarmDue(now);
    const st = standingsOf();
    if (st === null) {
      aggroBump("noStandings");
      return;
    }
    const relationOf = (pilotId, factionId) => {
      try {
        return st.relationOf(st.profileOf(pilotId), factionId);
      } catch (_err) {
        return -1;
      }
    };
    const pilotIdOf = (shipId) => {
      const s = ships.get(shipId);
      return s && Number.isSafeInteger(s.pilotId) ? s.pilotId : null;
    };
    const list = aggroSystems(now);
    const rats = VR !== null && ratSceneReady();
    if (rats) for (const systemId of [...ratWindow.keys()]) ratWindowCount(systemId, now);
    if (list.length === 0) return;
    const borrowedIds = new Set();
    if (rats) {
      for (const a of armed.values()) {
        for (const b of Array.isArray(a.borrowed) ? a.borrowed : []) if (b) borrowedIds.add(b.entityId);
      }
    }
    let borrowedHits = 0;
    const excludeRat = (id) => {
      if (borrowedIds.has(id)) {
        borrowedHits += 1;
        return true;
      }
      return isLiveBattleShip ? isLiveBattleShip(id) === true : false;
    };
    let start = list.findIndex(([systemId]) => systemId > aggroCursor);
    if (start < 0) start = 0;
    const take = Math.min(list.length, AG.maxSystemsPerPass);
    for (let i = 0; i < take; i += 1) {
      const [systemId, ids] = list[(start + i) % list.length];
      aggroCursor = systemId;
      borrowedHits = 0;
      const opts = rats ? { rangeMeters: AG.rangeMeters, maxCandidates: AG.maxCandidates, excludeOf: excludeRat,
        ...(VR.maxPerSystemWindow > 0 ? { vendorRats: true } : {}) }
        : { rangeMeters: AG.rangeMeters, maxCandidates: AG.maxCandidates,
          ...(isLiveBattleShip ? { excludeOf: isLiveBattleShip } : {}) };
      const read = call(() => scene.readThreats(systemId, ids, opts));
      if (!read || read.ok !== true || !Array.isArray(read.threats)) {
        if (!(read && read.reason === "SCENE_NOT_LOADED")) failAggro(read && read.reason);
        continue;
      }
      aggroBump("systemsRead");
      const excluded = Number.isSafeInteger(read.excluded) ? read.excluded : 0;
      if (rats) ratBump("borrowedSkipped", borrowedHits);
      aggroBump("liveBattleSkipped", rats ? Math.max(0, excluded - borrowedHits) : excluded);
      const left = rats ? Math.max(0, VR.maxPerSystemWindow - ratWindowCount(systemId, now)) : 0;
      const plan = planAggro({ threats: read.threats, pilotOf: pilotIdOf, relationOf, armed, cooldownUntil, now,
        maxAttackers: AG.maxAttackers, ...(rats ? { vendorOrdersLeft: left } : {}) });
      aggroBump("hostileSeen", plan.hostileSeen);
      aggroBump("friendlySkipped", plan.friendlySkipped);
      if (rats) ratBump("quotaSkipped", Number.isSafeInteger(plan.vendorQuotaSkipped) ? plan.vendorQuotaSkipped : 0);
      for (const order of plan.orders) {
        if (!ships.has(order.pilotShipId)) continue;
        const vendor = rats && order.vendor === true;
        const r = vendor
          ? call(() => scene.armPilotRatTarget(systemId, order.pilotShipId, order.attackerIds, order.kind))
          : call(() => scene.armPilotTarget(systemId, order.pilotShipId, order.attackerIds, order.kind));
        if (r && r.ok === true && vendor) {
          armed.set(order.pilotShipId, { kind: r.kind, armedAt: now, systemId,
            borrowed: Array.isArray(r.borrowed) ? r.borrowed : [], vendor: true });
          if (!ratWindow.has(systemId)) ratWindow.set(systemId, []);
          ratWindow.get(systemId).push(now);
          for (const b of armed.get(order.pilotShipId).borrowed) if (b) borrowedIds.add(b.entityId);
          aggroBump("armed");
          ratBump("orders");
          ratBump("ratsOrdered", Number.isSafeInteger(r.ordered) ? r.ordered : 0);
        } else if (r && r.ok === true) {
          armed.set(order.pilotShipId, { kind: r.kind, armedAt: now, systemId,
            borrowed: Array.isArray(r.borrowed) ? r.borrowed : [] });
          aggroBump("armed");
          aggroBump("attackersOrdered", Number.isSafeInteger(r.ordered) ? r.ordered : 0);
        } else {
          failAggro(r && (r.detail ? `${r.reason} ${r.detail}` : r.reason));
        }
      }
    }
  }

  function tick() {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = nowMs();
    passNo += 1;
    try {
      const now = clock.now();
      const presence = presenceOf();
      beamFxLeft = T.miningBeamMaxFxPerPass;
      warpFxLeft = T.visibleWarpMaxFxPerPass;
      gateEventLeft = T.gateControllerEventMaxPerPass;
      siteReadsLeft = T.explorerSiteReadsPerPass;
      alarmLeft = T.fleeAlarmEnabled === true ? T.fleeAlarmMaxPerPass : 0;
      runLifecycle(now);
      runExit(now, presence);
      runSpawn(now, presence);
      if (AG !== null) {
        const a0 = nowMs();
        try {
          runAggro(now);
        } catch (err) {
          failAggro(messageOf(err));
        }
        metric("observe", TRAFFIC_METRICS.aggroMs, Math.round((nowMs() - a0) * MS_DECIMALS) / MS_DECIMALS);
      }
      prune(presence);
      bump("passes");
      return { ok: true, ships: ships.size };
    } catch (err) {
      fail("read", messageOf(err));
      return { ok: false, reason: "PASS_FAILED", detail: messageOf(err) };
    } finally {
      metric("gauge", TRAFFIC_METRICS.live, ships.size);
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", TRAFFIC_METRICS.passMs, ms);
      if (PL) {
        const audit = pilotAuditOf(ships.values());
        metric("gauge", TRAFFIC_METRICS.pilotShips, audit.pilotShips);
        metric("gauge", TRAFFIC_METRICS.pilotDuplicates, audit.duplicates);
        metric("gauge", TRAFFIC_METRICS.maxPerSystem, audit.maxPerSystem);
      }
      lastPass = { ships: ships.size, ms };
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (AG !== null && !aggroOff && typeof scene.disarmPilotTarget === "function") {
      for (const [entityId, a] of armed) {
        countRelease(call(() => scene.disarmPilotTarget(a.systemId, entityId, a.borrowed)));
      }
    }
    armed.clear();
    cooldownUntil.clear();
    ratWindow.clear();
    for (const [systemId, list] of shipsBySystem()) {
      try {
        despawnIds(systemId, list.map((s) => s.entityId));
      } catch (err) {
        fail("despawn", messageOf(err));
      }
    }
    if (PL) for (const ship of ships.values()) releasePilot(ship, "LEFT");
    pilotOf.clear();
    ships.clear();
    systems.clear();
  }

  function status() {
    return Object.freeze({ ships: ships.size, systems: systems.size, lastPass,
      ...(PL ? { pilots: pilotOf.size } : {}),
      ...(hullProfiles ? { pilotHulls: Object.freeze({ verified: hullsVerified !== null,
        live: hullsVerified ? hullsVerified.size : 0, rejected: Object.freeze([...hullsRejected]) }) } : {}),
      ...(AG ? { aggro: Object.freeze({ armed: armed.size, counters: Object.freeze({ ...aggroCounters }),
        ...(VR ? { vendorRats: Object.freeze({ windowSystems: ratWindow.size,
          counters: Object.freeze({ ...ratCounters }) }) } : {}) }) } : {}),
      counters: Object.freeze({ ...counters }) });
  }

  function shipsIn(systemId) {
    const id = Number(systemId);
    return Number.isSafeInteger(id) && id > 0 ? liveIn(id) : 0;
  }

  return { ok: true, traffic: Object.freeze({ tick, stop, status, shipsIn }) };
}

function pilotAuditOf(shipList) {
  let pilotShips = 0;
  let maxPerSystem = 0;
  const pilots = new Set();
  const perSystem = new Map();
  for (const ship of shipList || []) {
    if (!ship) continue;
    const n = (perSystem.get(ship.systemId) || 0) + 1;
    perSystem.set(ship.systemId, n);
    if (n > maxPerSystem) maxPerSystem = n;
    if (Number.isSafeInteger(ship.pilotId)) {
      pilotShips += 1;
      pilots.add(ship.pilotId);
    }
  }
  return { pilotShips, duplicates: pilotShips - pilots.size, maxPerSystem };
}

module.exports = { createTraffic, SCENE_METHODS, AGGRO_SCENE_METHODS, RAT_AGGRO_SCENE_METHODS, pilotAuditOf };
