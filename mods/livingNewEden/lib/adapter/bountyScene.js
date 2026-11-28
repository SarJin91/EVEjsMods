"use strict";

const { emitGateAnimation } = require("./gateAnimation");

const data = require("./data/liveProfiles");
const dormancyGuard = require("./dormancyGuard");
const bountyVictims = require("./bountyVictims");
const { factionKeyOf } = require("./officerSpawn");
const freighters = require("./data/factionLiveProfiles");
const { admitOrPass } = require("./sceneNpcBudget");
const { GATE_EVENT, broadcastGateEvent } = require("./gateJumpFx");

const MAX_DETAIL = 120;
const SITE_PREFIX = "lneBounty";
const COMMANDER_KIND = "commander";
const FREIGHTER_KIND = "freighter";
const ESCORT_ARCHETYPE = "ESCORT";
const BOSS_KINDS = Object.freeze(["hull", "commander", "capital", FREIGHTER_KIND]);
const HUNTER_ARCHETYPE = "HUNTER";
const ARCHETYPES = Object.freeze(["RUNNER", "BRAWLER", "KITER", "AMBUSH", "SMUGGLER", HUNTER_ARCHETYPE]);
const MAX_CARGO = 32;
const HULL_LADDER = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]);
const CAPITAL_ORDER = Object.freeze(["dreadnought", "carrier", "force_auxiliary"]);
const WARP_OFF_ORDER = "warpOff";
const MAX_ESCORTS = 16;
const MAX_PROFILE_ID = 128;

const PATHS = Object.freeze({
  runtime: "space/runtime",
  npc: "space/npc/npcService",
  belt: "space/npc/beltRatRuntime",
});
const FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  npc: Object.freeze(["getControllerByEntityID", "issueManualOrder", "wakeNpcController"]),
});

const SEAM_METHODS = Object.freeze(["isSceneLoaded", "spawnGroup", "readAggression", "warpOff", "orderAttack",
  "despawn", "listAlive", "markShips", "forgetShips", "fleeToGate", "jumpAtGate", "presentGateDeparture"]);
const ALIGN_ORDER = "align";
const JUMP_OUT_FX = "effects.JumpOut";
const JUMP_IN_FX = "effects.JumpIn";
const JUMP_IN_DURATION_MS = 5000;
const WARP_TOO_CLOSE = "WARP_DISTANCE_TOO_CLOSE";

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function toPositiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

const isIdList = (list) => Array.isArray(list) && list.every(isPositiveInt);
const lowerOf = (hullClass) => {
  const at = HULL_LADDER.indexOf(hullClass);
  return at > 0 ? HULL_LADDER[at - 1] : null;
};

function checkBountySceneFrom(requireGame) {
  const missing = [];
  for (const key of Object.keys(FUNCTIONS)) {
    let r = null;
    try {
      r = typeof requireGame === "function" ? requireGame(PATHS[key]) : null;
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !r.exports) {
      missing.push(PATHS[key]);
      continue;
    }
    for (const name of FUNCTIONS[key]) {
      if (typeof r.exports[name] !== "function") missing.push(`${PATHS[key]}.${name}`);
    }
    if (key === "runtime" && !(r.exports.scenes instanceof Map)) missing.push(`${PATHS.runtime}.scenes`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

function specOf(spec) {
  if (!spec || typeof spec !== "object" || !isPositiveInt(spec.systemId) || !isPositiveInt(spec.factionId)) return null;
  const a = spec.anchor;
  if (!a || typeof a !== "object") return null;
  if (a.kind === "belt") {
    if (!Number.isSafeInteger(a.index) || a.index < 0) return null;
    if (a.gateFallback !== undefined && typeof a.gateFallback !== "boolean") return null;
  } else if (a.kind === "gate") {
    if (!Number.isSafeInteger(a.index) || a.index < 0) return null;
  } else if (a.kind === "gateTo") {
    if (!isPositiveInt(a.systemId) || !Number.isSafeInteger(a.index) || a.index < 0) return null;
    if (a.gateFallback !== undefined && typeof a.gateFallback !== "boolean") return null;
  } else if (a.kind !== "entity" || !isPositiveInt(a.entityId)) {
    return null;
  }
  const boss = spec.boss === null || spec.boss === undefined ? null : spec.boss;
  if (boss !== null && (!BOSS_KINDS.includes(boss.kind) || !HULL_LADDER.includes(boss.hullClass))) return null;
  if (!Array.isArray(spec.escorts) || spec.escorts.length > MAX_ESCORTS
    || !spec.escorts.every((e) => e && HULL_LADDER.includes(e.hullClass) && (e.profileId === undefined
      || (typeof e.profileId === "string" && e.profileId !== "" && e.profileId.length <= MAX_PROFILE_ID)))) return null;
  if (boss === null && spec.escorts.length === 0) return null;
  const slimName = spec.slimName === undefined || spec.slimName === null ? null : spec.slimName;
  if (boss !== null && (!ARCHETYPES.includes(spec.archetype) || (slimName !== null && typeof slimName !== "string"))) {
    return null;
  }
  if (typeof spec.seedKey !== "string" || spec.seedKey.length === 0) return null;
  if (boss !== null && boss.jump !== undefined && typeof boss.jump !== "boolean") return null;
  const cargo = spec.cargo === undefined || spec.cargo === null ? [] : spec.cargo;
  if (!Array.isArray(cargo) || cargo.length > MAX_CARGO
    || !cargo.every((it) => it && isPositiveInt(it.typeId) && isPositiveInt(it.quantity))) return null;
  if (spec.gateEvents !== undefined && typeof spec.gateEvents !== "boolean") return null;
  return { systemId: spec.systemId, factionId: spec.factionId, anchor: a, boss, escorts: spec.escorts,
    archetype: spec.archetype, slimName, seedKey: spec.seedKey, cargo, gateEvents: spec.gateEvents === true };
}

function createBountyScene(deps) {
  const requireGame = deps && deps.requireGame;
  const getSpawn = deps && deps.getSpawn;
  const getSpawnTools = deps && deps.getSpawnTools;
  const admit = admitOrPass(deps && deps.admit);
  const isEwarProfile = (id, factionId, hullClass) => {
    try {
      return Boolean(deps && typeof deps.isEwarProfile === "function"
        && deps.isEwarProfile(id, factionId, hullClass) === true);
    } catch (_err) {
      return false;
    }
  };
  let seq = 0;

  const moduleOf = (key) => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS[key]);
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    if (!mod) return null;
    return (FUNCTIONS[key] || []).every((name) => typeof mod[name] === "function") ? mod : null;
  };

  const sceneOf = (systemId) => {
    const runtime = moduleOf("runtime");
    if (!runtime || !(runtime.scenes instanceof Map)) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    return { ok: true, scene };
  };

  const spawnFacade = (names) => {
    const f = typeof getSpawn === "function" ? getSpawn() : null;
    return f && names.every((name) => typeof f[name] === "function") ? f : null;
  };

  const staticsOfKind = (scene, kind) => (Array.isArray(scene.staticEntities) ? scene.staticEntities : [])
    .filter((e) => e && String(e.kind || "").trim() === kind && toPositiveInt(e.itemID) > 0
      && pointOf(e.position) !== null)
    .sort((x, y) => toPositiveInt(x.itemID) - toPositiveInt(y.itemID));

  const gateToOf = (scene, systemId) => staticsOfKind(scene, "stargate")
    .find((g) => toPositiveInt(g.destinationSolarSystemID) === systemId) || null;

  const radiusOf = (e) => {
    const r = Number(e && e.radius);
    return Number.isFinite(r) && r >= 0 ? r : 0;
  };

  const distanceOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const fleeOptsOf = (o) => {
    const landing = Number(o && o.landingMeters);
    const range = Number(o && o.jumpRangeMeters);
    return Number.isFinite(landing) && landing >= 0 && Number.isFinite(range) && range >= 0
      ? { landingMeters: landing, jumpRangeMeters: range } : null;
  };

  const isSceneLoaded = (systemId) => {
    try {
      return isPositiveInt(systemId) && sceneOf(systemId).ok === true;
    } catch (_err) {
      return false;
    }
  };

  const anchorEntityOf = (scene, anchor) => {
    if (anchor.kind === "entity") return scene.getEntityByID(anchor.entityId) || null;
    const ofKind = (kind) => staticsOfKind(scene, kind);
    if (anchor.kind === "gateTo") {
      const gate = gateToOf(scene, anchor.systemId);
      if (gate) return gate;
      return anchorEntityOf(scene, { kind: "belt", index: anchor.index, gateFallback: anchor.gateFallback });
    }
    if (anchor.kind === "gate") {
      const gates = ofKind("stargate");
      return gates.length > 0 ? gates[anchor.index % gates.length] : null;
    }
    const belts = ofKind("asteroidBelt");
    if (belts.length > 0) return belts[anchor.index % belts.length];
    if (anchor.gateFallback !== true) return null;
    let best = null;
    let bestDistance = -1;
    for (const gate of ofKind("stargate")) {
      const p = pointOf(gate.position);
      const d = Math.hypot(p.x, p.y, p.z);
      if (d > bestDistance) {
        best = gate;
        bestDistance = d;
      }
    }
    return best;
  };

  const hullProfileOf = (spawn, factionId, hullClass, seedPrefix, memberKey) => {
    for (let cls = hullClass; cls !== null; cls = lowerOf(cls)) {
      const r = spawn.resolveProfiles([{ memberKey, factionId, hullGroup: cls }], { seedPrefix });
      if (r && r.ok === true && Array.isArray(r.profiles) && typeof r.profiles[0] === "string") return r.profiles[0];
      if (r && r.reason === "SEAM_UNAVAILABLE") return null;
    }
    return null;
  };

  const capitalProfileOf = (spawn, factionId, seedPrefix) => {
    for (const cls of CAPITAL_ORDER) {
      const r = spawn.resolveProfiles([{ memberKey: "boss", factionId, hullGroup: cls }], { seedPrefix });
      if (r && r.ok === true && Array.isArray(r.profiles) && typeof r.profiles[0] === "string") return r.profiles[0];
    }
    return null;
  };

  const spawnProfile = (spawn, s, profileId, anchorEntity, extra) => {
    const r = spawn.spawnShip(s.systemId, { profileId, anchorDescriptor: { kind: "entity",
      itemID: toPositiveInt(anchorEntity.itemID) }, purpose: "bounty", ...extra });
    return r && r.ok === true && isPositiveInt(r.entityId) ? r.entityId : 0;
  };

  const spawnCommander = (s, scene, anchorEntity) => {
    const belt = typeof requireGame === "function" ? requireGame(PATHS.belt) : null;
    const plans = belt && belt.ok === true && belt.exports ? belt.exports : null;
    const tools = typeof getSpawnTools === "function" ? getSpawnTools() : null;
    const key = factionKeyOf(s.factionId);
    if (!plans || typeof plans.buildBeltRatSpawnPlan !== "function" || !tools || tools.ok !== true
      || typeof tools.spawnNativeDefinitionsInContext !== "function" || key === null) {
      return { entityId: 0, detail: "COMMANDER_SEAM" };
    }
    const plan = plans.buildBeltRatSpawnPlan(s.systemId, { skipSpecialSpawns: true,
      forceSpecialSpawnKind: COMMANDER_KIND, factionKey: key });
    const planData = plan && plan.success === true && plan.data ? plan.data : null;
    if (!planData || planData.specialSpawnKind !== COMMANDER_KIND || !Array.isArray(planData.definitions)
      || planData.definitions.length === 0) {
      return { entityId: 0, detail: String((plan && plan.errorMsg) || "NO_PLAN").slice(0, MAX_DETAIL) };
    }
    seq += 1;
    const anchorId = toPositiveInt(anchorEntity.itemID);
    const anchorKind = String(anchorEntity.kind || "anchor");
    const anchorName = String(anchorEntity.itemName || anchorEntity.slimName || anchorKind);
    const selectionID = `${SITE_PREFIX}:${String(planData.selectionID || "")}`;
    const context = { systemID: s.systemId, scene, anchorEntity, anchorKind, anchorLabel: anchorName };
    const selection = { success: true, data: { selectionKind: data.BOUNTY_OPERATOR_KIND, selectionID,
      selectionName: String(planData.selectionName || selectionID), definitions: planData.definitions.slice(0, 1) } };
    const gate = admit(s.systemId, 1, "bounty");
    if (gate.ok !== true) return { entityId: 0, detail: gate.reason };
    const res = tools.spawnNativeDefinitionsInContext(context, selection, {
      entityType: "npc", transient: true, broadcast: false, deferGroupBehaviorTick: true,
      selectionKind: data.BOUNTY_OPERATOR_KIND, selectionID, selectionName: selection.data.selectionName,
      operatorKind: data.BOUNTY_OPERATOR_KIND, anchorKind, anchorID: anchorId, anchorName,
      spawnSiteID: `${SITE_PREFIX}:${s.seedKey}:${seq}`,
      behaviorOverrides: { ...data.BOUNTY_BEHAVIOR[s.archetype] },
      ...(s.slimName !== null ? { slimNameOverride: s.slimName } : {}),
    });
    const spawned = res && res.success === true && res.data && Array.isArray(res.data.spawned) ? res.data.spawned : [];
    const entityId = toPositiveInt(spawned[0] && spawned[0].entity && spawned[0].entity.itemID);
    if (!entityId) return { entityId: 0, detail: String((res && res.errorMsg) || "NO_RESULT").slice(0, MAX_DETAIL) };
    dormancyGuard.protect(entityId);
    return { entityId };
  };

  const spawnBoss = (spawn, s, scene, anchorEntity) => {
    const extra = { archetype: s.archetype, slimName: s.slimName };
    const seedPrefix = `bounty:${s.seedKey}`;
    let detail = null;
    if (s.boss.kind === FREIGHTER_KIND) {
      const known = Object.prototype.hasOwnProperty.call(freighters.BOUNTY_FREIGHTERS, String(s.factionId));
      const id = known ? spawnProfile(spawn, s, freighters.bountyFreighterProfileId(s.factionId, s.boss.jump === true),
        anchorEntity, extra) : 0;
      if (id) return { entityId: id };
      detail = known ? "FREIGHTER_SPAWN_FAILED" : "NO_FREIGHTER_FACTION";
    } else if (s.boss.kind === "commander") {
      const c = spawnCommander(s, scene, anchorEntity);
      if (c.entityId) return { entityId: c.entityId };
      detail = c.detail;
    } else if (s.boss.kind === "capital") {
      const profileId = capitalProfileOf(spawn, s.factionId, seedPrefix);
      const id = profileId ? spawnProfile(spawn, s, profileId, anchorEntity, { ...extra, capital: true }) : 0;
      if (id) return { entityId: id };
      detail = profileId ? "CAPITAL_SPAWN_FAILED" : "NO_CAPITAL_PROFILE";
    }
    const profileId = hullProfileOf(spawn, s.factionId, s.boss.hullClass, seedPrefix, "boss");
    if (!profileId) return { entityId: 0, reason: "NO_PROFILE", detail: detail || s.boss.hullClass };
    const id = spawnProfile(spawn, s, profileId, anchorEntity, extra);
    return id ? { entityId: id } : { entityId: 0, reason: "SPAWN_FAILED", detail: detail || profileId };
  };

  const wakeAggressive = (s, bossId, escortIds) => {
    const out = { woken: 0, failed: 0 };
    const aggressive = (archetype) => {
      const b = data.BOUNTY_BEHAVIOR[archetype];
      return Boolean(b && b.autoAggro === true);
    };
    const ids = [];
    if (bossId !== null && aggressive(s.archetype)) ids.push(bossId);
    if (aggressive(s.archetype === HUNTER_ARCHETYPE ? HUNTER_ARCHETYPE : ESCORT_ARCHETYPE)) ids.push(...escortIds);
    if (ids.length === 0) return out;
    let npc = null;
    try {
      npc = moduleOf("npc");
    } catch (_err) {
      npc = null;
    }
    for (const id of ids) {
      let r = null;
      try {
        r = npc ? npc.wakeNpcController(id, 0) : null;
      } catch (_err) {
        r = null;
      }
      if (r && r.success === true) out.woken += 1;
      else out.failed += 1;
    }
    return out;
  };

  const spawnGroup = (spec) => {
    const s = specOf(spec);
    if (!s) return { ok: false, reason: "INVALID_INPUT" };
    let spawn = null;
    const made = [];
    try {
      spawn = spawnFacade(["resolveProfiles", "spawnShip", "publish", "despawn"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(s.systemId);
      if (!sc.ok) return sc;
      const anchorEntity = anchorEntityOf(sc.scene, s.anchor);
      if (!anchorEntity || toPositiveInt(anchorEntity.itemID) === 0) return { ok: false, reason: "NO_ANCHOR" };
      const gate = admit(s.systemId, (s.boss !== null ? 1 : 0) + s.escorts.length, "bounty");
      if (gate.ok !== true) return gate;
      let bossId = null;
      if (s.boss !== null) {
        const b = spawnBoss(spawn, s, sc.scene, anchorEntity);
        if (!b.entityId) return { ok: false, reason: b.reason || "SPAWN_FAILED", detail: b.detail };
        bossId = b.entityId;
        made.push(bossId);
      }
      const cargo = { seeded: 0, skipped: 0 };
      if (bossId !== null && s.cargo.length > 0) {
        const hold = spawnFacade(["seedCargo"]);
        for (const it of s.cargo) {
          const r = hold ? hold.seedCargo(bossId, [{ typeId: it.typeId, quantity: it.quantity }]) : null;
          if (r && r.ok === true && r.written > 0) cargo.seeded += 1;
          else cargo.skipped += 1;
        }
      }
      const escortIds = [];
      s.escorts.forEach((e, i) => {
        const own = typeof e.profileId === "string" && isEwarProfile(e.profileId, s.factionId, e.hullClass)
          ? e.profileId : null;
        const profileId = own || hullProfileOf(spawn, s.factionId, e.hullClass, `bounty:${s.seedKey}`, `escort${i}`);
        const id = profileId ? spawnProfile(spawn, s, profileId, anchorEntity, {
          archetype: s.archetype === HUNTER_ARCHETYPE ? HUNTER_ARCHETYPE : ESCORT_ARCHETYPE }) : 0;
        if (id) {
          escortIds.push(id);
          made.push(id);
        }
      });
      if (made.length === 0) return { ok: false, reason: "SPAWN_FAILED", detail: "NO_ESCORT" };
      const pub = spawn.publish(s.systemId, made);
      if (!pub || pub.ok !== true) {
        spawn.despawn(s.systemId, made);
        return { ok: false, reason: "SPAWN_FAILED", detail: "PUBLISH_FAILED" };
      }
      const wake = wakeAggressive(s, bossId, escortIds);
      const arrivalGate = s.anchor.kind === "gateTo" && anchorEntity === gateToOf(sc.scene, s.anchor.systemId);
      if (arrivalGate && typeof sc.scene.broadcastSpecialFx === "function") {
        for (const id of made) {
          try {
            sc.scene.broadcastSpecialFx(id, JUMP_IN_FX, { duration: JUMP_IN_DURATION_MS }, sc.scene.getEntityByID(id));
            emitGateAnimation(sc.scene, anchorEntity, id, "Arrival");
          } catch (_err) {
          }
        }
      }
      if (!(arrivalGate && s.gateEvents)) {
        return { ok: true, bossId, escortIds, anchorPoint: pointOf(anchorEntity.position), cargo, wake, arrivalGate };
      }
      const gateId = toPositiveInt(anchorEntity.itemID);
      let arrivals = 0;
      for (const id of made) {
        const ev = broadcastGateEvent(sc.scene, gateId, id, GATE_EVENT.ARRIVAL);
        if (ev.ok === true && ev.sent === true) arrivals += 1;
      }
      return { ok: true, bossId, escortIds, anchorPoint: pointOf(anchorEntity.position), cargo, wake, arrivalGate,
        arrivals };
    } catch (err) {
      if (spawn && made.length > 0) {
        try {
          spawn.despawn(s.systemId, made);
        } catch (_err) {
        }
      }
      return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const readAggression = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const npc = moduleOf("npc");
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const ships = entityIds.map((entityId) => {
        const entity = sc.scene.getEntityByID(entityId);
        if (!entity) return { entityId, alive: false, aggressorId: null, inWarp: false, position: null };
        const controller = npc.getControllerByEntityID(entityId);
        const aggressorId = toPositiveInt(controller && controller.lastAggressorID) || null;
        return { entityId, alive: true, aggressorId, inWarp: String(entity.mode || "").toUpperCase() === "WARP",
          position: pointOf(entity.position) };
      });
      return { ok: true, ships };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const warpOff = (systemId, entityIds, awayFromEntityId) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)
      || (awayFromEntityId !== null && awayFromEntityId !== undefined && !isPositiveInt(awayFromEntityId))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = moduleOf("npc");
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const from = awayFromEntityId ? pointOf((sc.scene.getEntityByID(awayFromEntityId) || {}).position) : null;
      const out = { ok: true, ordered: [], gone: [], failed: [] };
      for (const id of entityIds) {
        if (!sc.scene.getEntityByID(id) || !npc.getControllerByEntityID(id)) {
          out.gone.push(id);
          continue;
        }
        const issued = npc.issueManualOrder(id, { type: WARP_OFF_ORDER, awayFromPosition: from });
        const woke = issued && issued.success === true ? npc.wakeNpcController(id, 0) : issued;
        (woke && woke.success === true ? out.ordered : out.failed).push(id);
      }
      return out;
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const orderAttack = (systemId, entityId, targetId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(targetId)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = moduleOf("npc");
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const order = npc.issueManualOrder(entityId, { type: "attack", targetID: targetId, ...data.ATTACK_LOCK_ORDER });
      const woke = order && order.success === true ? npc.wakeNpcController(entityId, 0) : order;
      if (!woke || woke.success !== true) {
        return { ok: false, reason: "ORDER_FAILED", detail: String((woke && woke.errorMsg) || "ORDER_FAILED")
          .slice(0, MAX_DETAIL) };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const fleeToGate = (systemId, entityId, toSystemId, o) => {
    const opts = fleeOptsOf(o);
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(toSystemId) || !opts) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = moduleOf("npc");
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      if (typeof sc.scene.warpDynamicEntityToPoint !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "warpDynamicEntityToPoint" };
      }
      const entity = sc.scene.getEntityByID(entityId);
      const ship = entity ? pointOf(entity.position) : null;
      if (!ship || !npc.getControllerByEntityID(entityId)) return { ok: false, reason: "GONE" };
      const gate = gateToOf(sc.scene, toSystemId);
      if (!gate) return { ok: false, reason: "NO_GATE" };
      const gateId = toPositiveInt(gate.itemID);
      const at = pointOf(gate.position);
      const radius = radiusOf(gate);
      const d = distanceOf(ship, at);
      if (d <= radius + opts.jumpRangeMeters) return { ok: true, gateId, mode: "atGate" };
      const k = (radius + opts.landingMeters) / d;
      const landing = { x: at.x + (ship.x - at.x) * k, y: at.y + (ship.y - at.y) * k, z: at.z + (ship.z - at.z) * k };
      const direction = { x: landing.x - ship.x, y: landing.y - ship.y, z: landing.z - ship.z };
      const issued = npc.issueManualOrder(entityId, { type: ALIGN_ORDER, direction });
      const woke = issued && issued.success === true ? npc.wakeNpcController(entityId, 0) : issued;
      if (!woke || woke.success !== true) {
        return { ok: false, reason: "ORDER_FAILED", detail: String((woke && woke.errorMsg) || "ALIGN_FAILED")
          .slice(0, MAX_DETAIL) };
      }
      const warp = sc.scene.warpDynamicEntityToPoint(entity, landing);
      if (warp && warp.success === true) return { ok: true, gateId, mode: "warp" };
      const why = String((warp && warp.errorMsg) || "WARP_FAILED").slice(0, MAX_DETAIL);
      if (why === WARP_TOO_CLOSE) return { ok: true, gateId, mode: "approach" };
      return { ok: false, reason: "ORDER_FAILED", detail: why };
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const jumpAtGate = (systemId, entityId, gateId, o) => {
    const range = Number(o && o.jumpRangeMeters);
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(gateId) || !Number.isFinite(range)
      || range < 0) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const entity = sc.scene.getEntityByID(entityId);
      const ship = entity ? pointOf(entity.position) : null;
      if (!ship) return { ok: false, reason: "GONE" };
      const gate = staticsOfKind(sc.scene, "stargate").find((g) => toPositiveInt(g.itemID) === gateId) || null;
      if (!gate) return { ok: false, reason: "NO_GATE" };
      const distanceMeters = Math.max(0, distanceOf(ship, pointOf(gate.position)) - radiusOf(gate));
      if (String(entity.mode || "").toUpperCase() === "WARP" || distanceMeters > range) {
        return { ok: true, jumped: false, distanceMeters };
      }
      if (typeof sc.scene.broadcastSpecialFx !== "function") return { ok: true, jumped: true, fx: false };
      try {
        sc.scene.broadcastSpecialFx(entityId, JUMP_OUT_FX, { targetID: gateId, graphicInfo: { type: "tuple",
          items: [toPositiveInt(gate.destinationSolarSystemID) || null, null] }, start: true, active: false }, entity);
        emitGateAnimation(sc.scene, gate, entityId, "Departure");
      } catch (_err) {
        return { ok: true, jumped: true, fx: false };
      }
      return { ok: true, jumped: true, fx: true };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const presentGateDeparture = (systemId, entityId, gateId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(gateId)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      return broadcastGateEvent(sc.scene, gateId, entityId, GATE_EVENT.DEPARTURE);
    } catch (err) {
      return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
    }
  };

  const despawn = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const spawn = spawnFacade(["despawn"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      if (entityIds.length === 0) return { ok: true, removed: 0, missing: 0 };
      const r = spawn.despawn(systemId, entityIds);
      return r && typeof r === "object" ? r : { ok: false, reason: "DESPAWN_FAILED" };
    } catch (err) {
      return { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const listAlive = (systemId, entityIds) => {
    try {
      const spawn = spawnFacade(["listAlive"]);
      return spawn ? spawn.listAlive(systemId, entityIds) : [];
    } catch (_err) {
      return [];
    }
  };

  const markShips = (entityIds, o) => bountyVictims.markBountyShips(entityIds, o);
  const forgetShips = (entityIds) => bountyVictims.forgetBountyShips(entityIds);

  return Object.freeze({ isSceneLoaded, spawnGroup, readAggression, warpOff, orderAttack, despawn, listAlive,
    markShips, forgetShips, fleeToGate, jumpAtGate, presentGateDeparture });
}

module.exports = { PATHS, FUNCTIONS, SEAM_METHODS, HULL_LADDER, CAPITAL_ORDER, createBountyScene,
  checkBountySceneFrom };
