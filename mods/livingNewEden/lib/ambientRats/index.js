"use strict";

const { performance } = require("node:perf_hooks");
const { createRng, randomSeed } = require("../util/rng");
const { defaultSetTimer } = require("../presence/poller");
const { relationOf, huntThresholds } = require("../playerHunt/policy");
const { parseNeutralPolicy } = require("../playerHunt/schema");
const { WORK_CLASS, REFUSAL, COUNTER_NAMES, HIGHSEC_EXCLUDED_FACTION_IDS } = require("./schema");
const { decideEligibility } = require("./eligibility");
const { resolveEmpireFaction } = require("./highsecFaction");
const { pickAnchor } = require("./anchors");
const { planAmbientGroup } = require("./groupPlan");
const { parseGatePicketTiers, gatePicketCount, GATE_PICKET_ANCHOR_KIND } = require("./gatePickets");

const SEAM_METHODS = Object.freeze(["bandOf", "snapshot", "spawnGroup", "classifyIds", "setAggro"]);
const FACADE_METHODS = Object.freeze({
  hunt: Object.freeze(["readPlayerShips"]),
  scene: Object.freeze(["readGroup", "orderGroup"]),
  spawn: Object.freeze(["despawn", "setRelation"]),
});
const ADAPTER_METHODS = Object.freeze(["getAmbientRatTools", "checkAmbientRatSeams", "getHuntScene", "checkHuntScene",
  "getBeltNavyScene", "checkBeltNavyScene", "getNpcSpawn", "checkNpcSpawn", "readCharacterStanding",
  "checkStandingRead"]);

const METRIC_GROUPS = "world.ambientRats.groups";
const METRIC_SHIPS_LIVE = "world.ambientRats.shipsLive";
const METRIC_PASS_MS = "world.ambientRats.passMs";
const SCENE_NOT_LOADED = "SCENE_NOT_LOADED";
const SEAM_UNAVAILABLE = "SEAM_UNAVAILABLE";
const READ_FAILED = "READ_FAILED";
const MS_DECIMALS = 10;
const MAX_DETAIL = 160;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function hasMethods(obj, names) {
  return Boolean(obj) && names.every((name) => typeof obj[name] === "function");
}

function createUnavailableAmbientRats(reason) {
  const why = String(reason || "AMBIENT_RATS_UNAVAILABLE");
  return Object.freeze({
    runPass: () => ({ ok: false, reason: why }),
    getStatus: () => Object.freeze({ state: "unavailable", reason: why }),
    stop: () => {},
  });
}

function ambientRatDepsFromAdapter(adapter) {
  try {
    const absent = adapter ? ADAPTER_METHODS.filter((name) => typeof adapter[name] !== "function") : ADAPTER_METHODS;
    if (absent.length > 0) return { ok: false, reason: SEAM_UNAVAILABLE, detail: absent.join(",") };
    for (const check of [adapter.checkAmbientRatSeams(), adapter.checkBeltNavyScene(), adapter.checkHuntScene(),
      adapter.checkNpcSpawn(), adapter.checkStandingRead()]) {
      if (!check || check.ok !== true) {
        return { ok: false, reason: SEAM_UNAVAILABLE,
          detail: String((check && (Array.isArray(check.missing) ? check.missing.join(",") : check.reason)) || "") };
      }
    }
    const tools = adapter.getAmbientRatTools();
    if (!tools || tools.ok !== true) return { ok: false, reason: SEAM_UNAVAILABLE, detail: (tools && tools.reason) || "" };
    const readConcordGateAggro = typeof adapter.readConcordGateNpcAggro === "function"
      ? () => adapter.readConcordGateNpcAggro() : null;
    return { ok: true, seam: tools.seam, hunt: adapter.getHuntScene(), scene: adapter.getBeltNavyScene(),
      spawn: adapter.getNpcSpawn(), readStanding: (c, f) => adapter.readCharacterStanding(c, f), readConcordGateAggro };
  } catch (err) {
    return { ok: false, reason: SEAM_UNAVAILABLE, detail: messageOf(err) };
  }
}

function readConcordGateFlag(reader) {
  if (typeof reader !== "function") return null;
  try {
    const read = reader();
    if (read && read.ok === true && typeof read.enabled === "boolean") return read.enabled;
  } catch (_err) {
  }
  return null;
}

function startAmbientRats(deps) {
  const config = deps && deps.config;
  const S = config && config.ambientRats;
  if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  let parts = deps;
  if (deps.seam === undefined && deps.adapter !== undefined) {
    parts = ambientRatDepsFromAdapter(deps.adapter);
    if (!parts.ok) return parts;
  }
  const { seam, hunt, scene, spawn, readStanding } = parts;
  if (!hasMethods(seam, SEAM_METHODS) || !hasMethods(hunt, FACADE_METHODS.hunt)
    || !hasMethods(scene, FACADE_METHODS.scene) || !hasMethods(spawn, FACADE_METHODS.spawn)
    || typeof readStanding !== "function") {
    return { ok: false, reason: SEAM_UNAVAILABLE, detail: "SEAM_METHODS" };
  }
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getWorld = typeof deps.getWorld === "function" ? deps.getWorld : () => null;
  const getFactionKind = typeof deps.getFactionKind === "function" ? deps.getFactionKind : () => null;
  const getGraphFacade = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const baseTables = deps.tables && typeof deps.tables === "object" ? deps.tables : {};
  const highsecNavy = S.highsecNavy === true;
  const concordGateAggro = highsecNavy ? readConcordGateFlag(parts.readConcordGateAggro) : null;
  const tables = highsecNavy ? { ...baseTables, concordGateAggroNpcs: concordGateAggro } : baseTables;
  const S_PASSIVE = Object.freeze({ ...S, passive: true });
  const highsecFactions = new Map();
  const picketsWanted = S.gatePicketsEnabled === true;
  const picketTiers = picketsWanted ? parseGatePicketTiers(S.gatePicketTiers) : null;
  const pickets = picketsWanted && picketTiers !== null && Number.isSafeInteger(S.gatePicketMaxGates)
    && S.gatePicketMaxGates > 0;
  const getTransit = typeof deps.getTransit === "function" ? deps.getTransit : () => null;
  const regularKinds = pickets ? new Set(String(S.anchorKinds || "").split(",").map((k) => k.trim().toLowerCase())
    .filter(Boolean)) : null;
  const picketSnapshotKinds = pickets ? [...new Set([...regularKinds, GATE_PICKET_ANCHOR_KIND])] : null;
  const rng = typeof deps.rng === "function" ? deps.rng : createRng(randomSeed()).nextFloat;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const hunting = config.playerHunt || {};
  const thresholds = huntThresholds(hunting);
  const neutralPolicy = parseNeutralPolicy(hunting.neutralPolicy) || {};
  const bootSeq = Math.trunc(clock.now()).toString(36);

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const groups = new Map();
  const systems = new Map();
  const loggedFailures = new Set();
  const subscriptions = [];
  let groupSeq = 0;
  let groupCursor = 0;
  let systemCursor = 0;
  let timer = null;
  let stopped = false;
  let lastPass = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`ambientRats: ${line}`);
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
    metric("count", `world.ambientRats.${name}`, n);
  }

  function fail(kind, detail) {
    bump(`failed.${kind}`);
    if (loggedFailures.has(kind)) return;
    loggedFailures.add(kind);
    log(`${kind} failed (${String(detail || "NO_RESULT").slice(0, MAX_DETAIL)}); further failures only counted`);
  }

  function refusalOf(reason) {
    return REFUSAL.includes(reason) ? reason : READ_FAILED;
  }

  function call(fn) {
    try {
      return fn();
    } catch (err) {
      return { ok: false, reason: READ_FAILED, detail: messageOf(err) };
    }
  }

  function stateOf(systemId) {
    let st = systems.get(systemId);
    if (!st) {
      st = { lastSpawnAt: -Infinity, cooldownUntil: -Infinity, emptySince: null, elig: null };
      systems.set(systemId, st);
    }
    return st;
  }

  function presenceOf() {
    try {
      const p = getPresence();
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

  function shipsLive() {
    let n = 0;
    for (const g of groups.values()) n += g.entityIds.length;
    return n;
  }

  function governorAdmits() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function highsecFactionOf(systemId) {
    let entry = highsecFactions.get(systemId);
    if (entry === undefined) {
      let graph = null;
      try {
        const facade = getGraphFacade();
        const got = facade && typeof facade.getGraph === "function" ? facade.getGraph() : null;
        graph = got && got.ok === true && got.graph ? got.graph : null;
      } catch (_err) {
        graph = null;
      }
      if (graph === null) return { read: false, reason: READ_FAILED };
      entry = resolveEmpireFaction(graph, systemId, HIGHSEC_EXCLUDED_FACTION_IDS);
      highsecFactions.set(systemId, entry);
    }
    return { read: true, factionId: entry.ok === true ? entry.factionId : null };
  }

  function eligibilityOf(systemId, now) {
    const st = stateOf(systemId);
    if (st.elig && now < st.elig.until) return { read: true, result: st.elig.result };
    const band = call(() => seam.bandOf(systemId));
    if (!band || band.ok !== true) return { read: false, reason: refusalOf(band && band.reason) };
    const world = getWorld();
    if (!world || typeof world.getControllerMemo !== "function") return { read: false, reason: READ_FAILED };
    const ctl = call(() => world.getControllerMemo(systemId));
    if (!ctl || ctl.ok !== true) return { read: false, reason: READ_FAILED };
    let controllerFactionId = Number.isSafeInteger(ctl.controllerFactionId) ? ctl.controllerFactionId : null;
    let controllerSource = "world";
    let homeFactionId = null;
    if (controllerFactionId === null && highsecNavy && band.band === "highsec" && concordGateAggro === false) {
      const sde = highsecFactionOf(systemId);
      if (!sde.read) return sde;
      controllerSource = "sde";
      controllerFactionId = sde.factionId;
      if (S.scope === "captured") homeFactionId = controllerFactionId;
    } else if (S.scope === "captured" && controllerFactionId !== null) {
      const row = typeof world.getControlState === "function" ? call(() => world.getControlState(systemId)) : null;
      if (!row || row.ok !== true) return { read: false, reason: READ_FAILED };
      homeFactionId = row.system && Number.isSafeInteger(row.system.homeFactionId) ? row.system.homeFactionId : null;
    }
    let kind = null;
    try {
      kind = controllerFactionId === null ? null : getFactionKind(controllerFactionId);
    } catch (_err) {
      kind = null;
    }
    const input = { band: band.band, eligible: band.eligible, controllerFactionId, homeFactionId, kind };
    if (highsecNavy) input.controllerSource = controllerSource;
    const result = decideEligibility(input, tables, S);
    st.elig = { until: now + S.eligibilityCacheMs, result };
    return { read: true, result };
  }

  function playersOf(systemId, pass) {
    if (pass.players.has(systemId)) return pass.players.get(systemId);
    const read = call(() => hunt.readPlayerShips(systemId));
    let players = null;
    if (read && read.ok === true && Array.isArray(read.ships)) players = read.ships;
    else if (read && read.reason === SCENE_NOT_LOADED) players = [];
    else fail("read", `players ${(read && read.reason) || "NO_RESULT"}`);
    pass.players.set(systemId, players);
    return players;
  }

  function presenceIdsOf(systemId, pass) {
    if (pass.presenceIds.has(systemId)) return pass.presenceIds.get(systemId);
    const out = { ids: new Set(), certain: true };
    const presence = presenceOf();
    try {
      const info = presence ? presence.getSystemPresence(systemId) : null;
      if (info && info.truncated === true) out.certain = false;
      for (const c of info && Array.isArray(info.characters) ? info.characters : []) {
        const id = Number(c && c.characterId);
        if (Number.isSafeInteger(id) && id > 0) out.ids.add(id);
      }
    } catch (_err) {
      out.certain = false;
    }
    pass.presenceIds.set(systemId, out);
    return out;
  }

  function pilotsOf(systemId, players, pass) {
    if (pass.pilots.has(systemId)) return pass.pilots.get(systemId);
    const ids = new Set(presenceIdsOf(systemId, pass).ids);
    for (const p of players) {
      const id = Number(p && p.characterId);
      if (Number.isSafeInteger(id) && id > 0) ids.add(id);
    }
    const list = [...ids].sort((a, b) => a - b);
    pass.pilots.set(systemId, list);
    return list;
  }

  function relationReader(factionId, pass) {
    let kind = null;
    try {
      kind = getFactionKind(factionId);
    } catch (_err) {
      kind = null;
    }
    return (characterId) => {
      const key = `${characterId}:${factionId}`;
      if (pass.relations.has(key)) return pass.relations.get(key);
      if (pass.standingReads >= S.maxStandingReadsPerPass) return null;
      pass.standingReads += 1;
      const read = call(() => readStanding(characterId, factionId));
      const standing = read && read.ok === true && Number.isFinite(read.standing) ? read.standing : null;
      if (standing === null) fail("read", `standing ${(read && read.reason) || "NO_RESULT"}`);
      const relation = relationOf(standing, kind, thresholds, neutralPolicy);
      pass.relations.set(key, relation);
      return relation;
    };
  }

  function despawnGroup(group, counter) {
    const res = call(() => spawn.despawn(group.systemId, group.entityIds));
    if (!res || res.ok !== true) {
      fail("despawn", res && res.reason);
      return false;
    }
    groups.delete(group.groupKey);
    bump(counter);
    return true;
  }

  function anyoneInRange(ships, players) {
    if (ships.length === 0) return false;
    const center = ships[0].position;
    return players.some((p) => p && p.position && distanceBetween(center, p.position) <= S.aggroRangeMeters);
  }

  function disarm(group, ids) {
    if (group.armedFor === null || ids.length === 0) return;
    const set = call(() => seam.setAggro(group.systemId, ids, false, S.aggroRangeMeters));
    if (set && set.ok === true) {
      group.armedFor = null;
      bump("disarmed", set.changed);
    } else if (!set || set.reason !== SCENE_NOT_LOADED) {
      fail("aggro", set && set.reason);
    }
  }

  function sweepArmed(visited, pass) {
    for (const group of [...groups.values()]) {
      if (visited.has(group.groupKey) || group.armedFor === null) continue;
      try {
        const seen = presenceIdsOf(group.systemId, pass);
        if (!seen.certain || [...seen.ids].some((id) => !group.armedFor.has(id))) disarm(group, group.entityIds);
      } catch (err) {
        fail("aggro", messageOf(err));
      }
    }
  }

  function runGroup(group, now, pass) {
    const cls = call(() => seam.classifyIds(group.systemId, group.entityIds));
    if (!cls || cls.ok !== true) {
      fail("read", `classify ${(cls && cls.reason) || "NO_RESULT"}`);
      disarm(group, group.entityIds);
      return;
    }
    const kept = [...cls.live, ...cls.dormant];
    if (kept.length === 0) {
      groups.delete(group.groupKey);
      stateOf(group.systemId).cooldownUntil = now + S.respawnCooldownMs;
      bump("wiped");
      return;
    }
    group.entityIds = kept;
    group.shipCount = kept.length;
    const players = playersOf(group.systemId, pass);
    if (players === null) {
      disarm(group, cls.live);
      return;
    }
    const read = call(() => scene.readGroup(group.systemId, group.entityIds));
    if (!read || read.ok !== true) {
      fail("read", `group ${(read && read.reason) || "NO_RESULT"}`);
      disarm(group, cls.live);
      return;
    }
    const ships = Array.isArray(read.ships) ? read.ships : [];
    const pilots = pilotsOf(group.systemId, players, pass);
    const passive = highsecNavy && group.band === "highsec";
    const plan = planAmbientGroup(group, { ships, players, pilots }, relationReader(group.factionId, pass),
      passive ? S_PASSIVE : S, now);
    for (const [entityId, stamp] of plan.seen) group.seenAggressedAt.set(entityId, stamp);
    for (const characterId of plan.attacks) group.provoked.add(characterId);
    bump("attacks", plan.attacks.length);
    const armed = plan.armed === true && !presenceIdsOf(group.systemId, pass).certain ? false : plan.armed;
    if (armed !== null && cls.live.length > 0) {
      if (armed) group.armedFor = new Set(pilots);
      const set = call(() => seam.setAggro(group.systemId, cls.live, armed, S.aggroRangeMeters));
      if (set && set.ok === true) {
        if (!armed) group.armedFor = null;
        bump(armed ? "armed" : "disarmed", set.changed);
      } else if (!set || set.reason !== SCENE_NOT_LOADED) {
        fail("aggro", set && set.reason);
      }
    }
    if (plan.orders.length > 0) {
      const done = call(() => scene.orderGroup(group.systemId, plan.orders));
      if (done && done.ok === true) {
        const failed = Array.isArray(done.failed) ? done.failed.length : 0;
        bump("orders", plan.orders.length - failed);
        if (failed > 0) fail("order", done.detail || "ORDER_FAILED");
      } else if (!done || done.reason !== SCENE_NOT_LOADED) {
        fail("order", done && done.reason);
      }
    }
    if (plan.relation !== null && cls.live.length > 0 && cls.live.length <= pass.repaintBudget) {
      pass.repaintBudget -= cls.live.length;
      const painted = call(() => spawn.setRelation(group.systemId, cls.live, plan.relation));
      if (painted && painted.ok === true) bump("repainted", painted.changed);
      else if (!painted || painted.reason !== SCENE_NOT_LOADED) fail("paint", painted && painted.reason);
    }
    if (plan.expire) {
      despawnGroup(group, "expired");
      return;
    }
    if (anyoneInRange(ships, players)) return;
    const elig = eligibilityOf(group.systemId, now);
    if (!elig.read) return;
    const factionId = elig.result.ok === true ? elig.result.factionId : null;
    if (factionId !== group.factionId) despawnGroup(group, "stale");
  }

  function groupsBySystem() {
    const by = new Map();
    for (const g of groups.values()) {
      if (!by.has(g.systemId)) by.set(g.systemId, []);
      by.get(g.systemId).push(g);
    }
    return by;
  }

  function runExit(now, pass, presence) {
    for (const [systemId, list] of groupsBySystem()) {
      try {
        const st = stateOf(systemId);
        let empty = spaceOf(presence, systemId) <= 0;
        if (!empty) {
          const players = playersOf(systemId, pass);
          if (players === null) continue;
          empty = players.length === 0;
        }
        if (!empty) {
          st.emptySince = null;
          continue;
        }
        if (st.emptySince === null) st.emptySince = now;
        if (now - st.emptySince < S.exitGraceMs) continue;
        for (const group of list) despawnGroup(group, "left");
      } catch (err) {
        fail("despawn", messageOf(err));
      }
    }
  }

  function despawnOrphans(systemId, ambientIds) {
    const known = new Set();
    for (const g of groups.values()) for (const id of g.entityIds) known.add(id);
    const orphans = (Array.isArray(ambientIds) ? ambientIds : []).filter((id) => !known.has(id))
      .slice(0, S.maxGroupsPerPass);
    if (orphans.length === 0) return;
    const res = call(() => spawn.despawn(systemId, orphans));
    if (res && res.ok === true) bump("orphans", orphans.length);
    else fail("despawn", res && res.reason);
  }

  function deferred(reason) {
    bump(`deferred.${reason}`);
    return false;
  }

  function picketTargetOf(systemId, result) {
    if (!pickets || result.band !== "nullsec") return 0;
    let risk = null;
    try {
      const transit = getTransit();
      risk = transit && typeof transit.riskOf === "function" ? transit.riskOf(systemId) : null;
    } catch (_err) {
      risk = null;
    }
    if (!risk || risk.controllerFactionId !== result.factionId) return 0;
    return gatePicketCount(risk.chanceBase, picketTiers, S.gatePicketMaxGates);
  }

  const kindOf = (anchor) => String((anchor && anchor.kind) || "").trim().toLowerCase();

  function trySpawn(systemId, now, pass) {
    const elig = eligibilityOf(systemId, now);
    if (!elig.read) {
      bump(`refused.${elig.reason}`);
      return false;
    }
    if (elig.result.ok !== true) {
      bump(`refused.${elig.result.reason}`);
      return false;
    }
    const st = stateOf(systemId);
    const mine = [...groups.values()].filter((g) => g.systemId === systemId);
    const picketTarget = picketTargetOf(systemId, elig.result);
    const picketsHere = mine.filter((g) => g.picket === true).length;
    const wantPicket = picketsHere < picketTarget;
    const wantRegular = mine.length - picketsHere < elig.result.groupsTarget;
    if (!wantPicket && !wantRegular) return deferred("SYSTEM_FULL");
    if (now < st.lastSpawnAt + S.spawnIntervalMs) return deferred("SPAWN_INTERVAL");
    if (now < st.cooldownUntil) return deferred("COOLDOWN");
    const players = playersOf(systemId, pass);
    if (players === null) return false;
    if (players.length === 0) return deferred("NO_PLAYER_IN_SPACE");
    const snap = call(() => seam.snapshot(systemId, { anchorKinds: wantPicket ? picketSnapshotKinds : S.anchorKinds }));
    if (!snap || snap.ok !== true) {
      bump(`refused.${refusalOf(snap && snap.reason)}`);
      return false;
    }
    despawnOrphans(systemId, snap.ambientIds);
    const scene = { usedAnchorIds: new Set(mine.map((g) => g.anchorId)), blockers: snap.blockers,
      players: players.map((p) => p.position) };
    const anchors = Array.isArray(snap.anchors) ? snap.anchors : [];
    let picket = false;
    let picked = { ok: false };
    if (wantPicket) {
      picked = pickAnchor({ ...scene, anchors: anchors.filter((a) => kindOf(a) === GATE_PICKET_ANCHOR_KIND) }, S, rng);
      picket = picked.ok === true;
    }
    if (!picked.ok && wantRegular) {
      picked = pickAnchor({ ...scene, anchors: wantPicket ? anchors.filter((a) => regularKinds.has(kindOf(a)))
        : snap.anchors }, S, rng);
    }
    if (!picked.ok) {
      if (wantPicket) st.lastSpawnAt = now;
      return deferred("NO_ANCHOR");
    }
    groupSeq += 1;
    const groupKey = `amb:${bootSeq}:${groupSeq}`;
    const { factionId, source, band } = elig.result;
    st.lastSpawnAt = now;
    const res = call(() => seam.spawnGroup({ systemId, anchorId: picked.anchor.itemId, factionId, source,
      minCount: undefined, maxCount: S.maxShipsPerGroup, distanceFromSurfaceMeters: S.distanceFromSurfaceMeters,
      groupKey, random: rng }));
    if (!res || res.ok !== true || !Array.isArray(res.entityIds) || res.entityIds.length === 0) {
      if (res && res.reason === SCENE_NOT_LOADED) bump(`refused.${SCENE_NOT_LOADED}`);
      else fail("spawn", res && (res.detail ? `${res.reason} ${res.detail}` : res.reason));
      return true;
    }
    const entityIds = [...res.entityIds];
    groups.set(groupKey, { groupKey, systemId, factionId, band, anchorId: picked.anchor.itemId,
      anchorKind: picked.anchor.kind, entityIds, shipCount: entityIds.length, spawnedAt: now, provoked: new Set(),
      seenAggressedAt: new Map(), armedFor: null, ...(picket ? { picket: true } : {}) });
    st.emptySince = null;
    bump("spawned");
    bump("ships", entityIds.length);
    if (picket) bump("gatePicketsSpawned");
    return true;
  }

  function runSpawn(now, pass, presence) {
    if (!presence) return;
    const candidates = presence.observedSystems().map(Number)
      .filter((id) => Number.isSafeInteger(id) && id > 0 && spaceOf(presence, id) > 0)
      .sort((a, b) => a - b);
    if (candidates.length === 0) return;
    if (!governorAdmits()) {
      bump("deferred.GOVERNOR");
      return;
    }
    let start = candidates.findIndex((id) => id > systemCursor);
    if (start < 0) start = 0;
    const taken = Math.min(S.maxSystemsPerPass, candidates.length);
    let spawns = 0;
    for (let i = 0; i < taken && spawns < S.maxSpawnsPerPass; i += 1) {
      if (groups.size >= S.maxGroupsGlobal || shipsLive() >= S.maxShipsGlobal) {
        bump("deferred.GLOBAL_FULL");
        return;
      }
      const systemId = candidates[(start + i) % candidates.length];
      systemCursor = systemId;
      try {
        if (trySpawn(systemId, now, pass)) spawns += 1;
      } catch (err) {
        fail("spawn", messageOf(err));
      }
    }
  }

  function prune(now) {
    const busy = new Set([...groups.values()].map((g) => g.systemId));
    for (const [systemId, st] of systems) {
      if (busy.has(systemId) || now < st.cooldownUntil || now < st.lastSpawnAt + S.spawnIntervalMs) continue;
      systems.delete(systemId);
    }
  }

  function runPass() {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = nowMs();
    const pass = { players: new Map(), pilots: new Map(), presenceIds: new Map(), relations: new Map(),
      standingReads: 0, repaintBudget: S.maxRepaintsPerPass };
    try {
      const now = clock.now();
      const list = [...groups.values()];
      const taken = Math.min(S.maxGroupsPerPass, list.length);
      const visited = new Set();
      for (let i = 0; i < taken; i += 1) {
        const group = list[(groupCursor + i) % list.length];
        visited.add(group.groupKey);
        if (!groups.has(group.groupKey)) continue;
        try {
          runGroup(group, now, pass);
        } catch (err) {
          fail("read", messageOf(err));
        }
      }
      groupCursor = list.length > 0 ? (groupCursor + taken) % list.length : 0;
      sweepArmed(visited, pass);
      const presence = presenceOf();
      runExit(now, pass, presence);
      runSpawn(now, pass, presence);
      prune(now);
      bump("passes");
      return { ok: true, groups: groups.size, shipsLive: shipsLive() };
    } catch (err) {
      fail("read", messageOf(err));
      return { ok: false, reason: "PASS_FAILED", detail: messageOf(err) };
    } finally {
      metric("gauge", METRIC_GROUPS, groups.size);
      metric("gauge", METRIC_SHIPS_LIVE, shipsLive());
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", METRIC_PASS_MS, ms);
      lastPass = { groups: groups.size, ms };
    }
  }

  function wanted() {
    if (groups.size > 0) return true;
    const presence = presenceOf();
    try {
      return Boolean(presence) && presence.observedSystems().length > 0;
    } catch (_err) {
      return false;
    }
  }

  function arm() {
    if (stopped || timer !== null || !wanted()) return;
    try {
      timer = setTimer(fire, S.pollMs);
    } catch (err) {
      timer = null;
      log(`timer failed - ${messageOf(err)}`);
    }
  }

  function fire() {
    timer = null;
    if (stopped) return;
    runPass();
    arm();
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", groups: groups.size, shipsLive: shipsLive(),
      systems: systems.size, timer: timer !== null, lastPass, counters: Object.freeze({ ...counters }),
      highsec: Object.freeze({ navy: highsecNavy, concordGateAggro, factionsMemo: highsecFactions.size }),
      ...(picketsWanted ? { gatePickets: Object.freeze({ active: pickets,
        groups: [...groups.values()].filter((g) => g.picket === true).length }) } : {}) });
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      const handle = timer;
      timer = null;
      try {
        handle.cancel();
      } catch (_err) {
      }
    }
    for (const unsubscribe of subscriptions.splice(0)) {
      try {
        unsubscribe();
      } catch (_err) {
      }
    }
    for (const group of [...groups.values()]) {
      const res = call(() => spawn.despawn(group.systemId, group.entityIds));
      if (!res || res.ok !== true) fail("despawn", res && res.reason);
    }
    groups.clear();
    systems.clear();
    highsecFactions.clear();
    log(`stopped (${reason || "stop"})`);
  }

  const presence = presenceOf();
  if (presence && typeof presence.onSystemObserved === "function") {
    try {
      const sub = presence.onSystemObserved(() => arm());
      if (sub && sub.ok === true && typeof sub.unsubscribe === "function") subscriptions.push(sub.unsubscribe);
    } catch (err) {
      log(`presence subscription refused - ${messageOf(err)}`);
    }
  }
  arm();
  log(`running (poll ${S.pollMs}ms, bands ${S.bands}, scope ${S.scope})`);
  if (picketsWanted) {
    log(pickets ? `gate pickets on (tiers ${S.gatePicketTiers}, max gates ${S.gatePicketMaxGates}, from the transit `
      + "risk index; cold index = none)" : `gate pickets refused (tiers "${String(S.gatePicketTiers)}", max gates `
      + `${S.gatePicketMaxGates})`);
  }
  if (highsecNavy && concordGateAggro !== false) {
    log(`highsec navy refused: vendor gate CONCORD aggro NPC ${concordGateAggro === true ? "true" : "unknown"}`);
  }
  return { ok: true, ambientRats: Object.freeze({ runPass, getStatus, stop }) };
}

module.exports = { startAmbientRats, createUnavailableAmbientRats, ambientRatDepsFromAdapter, SEAM_METHODS,
  FACADE_METHODS, ADAPTER_METHODS };
