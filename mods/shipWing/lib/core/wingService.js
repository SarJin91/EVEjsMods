"use strict";

const { ALL_VERBS, REFUSAL, END_REASON, SETTLE_OUTCOME, BOARD_REFUSAL, VENDOR_BOARD_REFUSAL } = require("./reasons");
const { FLYING_STATES, transition } = require("./states");
const { buildTwinSpec, launchSlot } = require("./twinSpec");
const { createWingTasks, TASK_VERBS } = require("./wingTasks");
const { runningOf } = require("./twinRunning");
const { LOSS_DEFAULTS } = require("../store/wingStore");
const { FORMATIONS, normalizeFormation, slotPoint } = require("./formation");
const { distance: vecDistance } = require("../util/vec");

const FORMATION_RANGE = -1;
const NO_FORMATION = "none";

const RELAUNCH_REASONS = Object.freeze(["WARP", "JUMPED"]);
const RELAUNCH_WAIT = Object.freeze(["NOT_IN_SPACE", "OWNER_WARPING", "SCENE_NOT_LOADED", "TICK_UNAVAILABLE",
  "GUARDS_UNAVAILABLE", "LOSS_UNAVAILABLE", "DERIVED_GUARD_UNAVAILABLE"]);
const RELAUNCH_HOLD = Object.freeze([...RELAUNCH_WAIT, "COOLDOWN"]);
const RELAUNCH_STOP = Object.freeze(["SPAWN_FAILED", "STORE_WRITE_FAILED"]);

const VERB_FLAGS = Object.freeze({
  mine: ["miningEnabled"], hold: ["miningEnabled", "combatEnabled", "salvageEnabled"], attack: ["combatEnabled"],
  salvage: ["salvageEnabled"],
});

function enabledVerbs(config, taskReady, tasks) {
  return ALL_VERBS.filter((verb) => {
    if (!TASK_VERBS.includes(verb)) return true;
    const flagOn = (VERB_FLAGS[verb] || []).some((key) => config[key] === true);
    let ready = false;
    try {
      ready = taskReady(verb) === true && tasks.supports(verb) === true;
    } catch (_err) {
      ready = false;
    }
    return flagOn && ready;
  });
}

const FIXED_COUNTERS = Object.freeze([
  "lost", "badTransition", "tick.maxMs", "tick.overBudget", "tick.error", "end.removeRetry",
  "end.storeWriteFailed", "listener.error",
  "loss.destroyed", "loss.missing", "loss.settleFailed", "loss.settleStuck", "loss.hullInUse", "loss.hookError",
  "loss.storeWriteFailed", "loss.purged", "condition.written", "condition.writeFailed", "entity.error",
  "loss.strayRemoved", "loss.strayRetry",
  "guard.derivedSkipped", "guard.derivedError",
  "orderAccepted.error",
  "launch.noSkills",
  "formation.goto", "formation.gotoFailed", "formation.repointSkipped", "formation.fallbackFollow", "formation.set",
  "formation.relaunch.noted", "formation.relaunch.launched", "formation.relaunch.wait", "formation.relaunch.waitCloak",
  "formation.relaunch.timeout", "formation.relaunch.dropped.HOST_CHANGED", "formation.relaunch.dropped.FORMATION_NONE",
  "formation.relaunch.dropped.DOCKED", "formation.relaunch.dropped.LOGOFF",
  "board.released",
  "board.orphan.begin", "board.orphan.cleared", "board.orphan.timeout",
  "board.pendingEnd",
  "cargo.moved", "cargo.refused",
]);
const COUNTER_NAMES = Object.freeze([
  ...FIXED_COUNTERS,
  ...BOARD_REFUSAL.filter((r) => !VENDOR_BOARD_REFUSAL.includes(r)).map((r) => `board.refused.${r}`),
  ...REFUSAL.map((reason) => `formation.relaunch.dropped.${reason}`),
  ...SETTLE_OUTCOME.map((outcome) => `loss.settled.${outcome}`),
  ...ALL_VERBS.map((verb) => `orderCopy.ok.${verb}`),
  ...REFUSAL.map((reason) => `orderCopy.refused.${reason}`),
  ...END_REASON.map((reason) => `end.${reason}`),
]);

const NO_CONDITION_END = Object.freeze(["SCENE_GONE", "RESTART"]);
const NEVER_MS = Number.MAX_SAFE_INTEGER;

const NO_POSITION = null;

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

const PERMILLE = 1000;

function hpPermille(condition) {
  if (!condition || typeof condition !== "object") return null;
  const shield = Number(condition.shieldCharge);
  const armorDamage = Number(condition.armorDamage);
  const damage = Number(condition.damage);
  if (![shield, armorDamage, damage].every(Number.isFinite)) return null;
  const clamp = (n) => Math.min(PERMILLE, Math.max(0, Math.round(n * PERMILLE)));
  return [clamp(shield), clamp(1 - armorDamage), clamp(1 - damage)];
}

function refusal(reason) {
  return { ok: false, reason };
}

function emptyPilot(pilotId) {
  return pilotId === 0 || pilotId === null || pilotId === undefined;
}

function orphanState(record, runtime, ctx) {
  const c = ctx || {};
  if (c.enabled !== true) return { orphan: false, reason: "HOST_CHANGED" };
  if (!c.space || !record || c.space.sceneKey !== record.sceneKey) return { orphan: false, reason: "JUMPED" };
  if (!c.host) return { orphan: false, reason: "HOST_GONE" };
  if (!emptyPilot(c.hostStatus ? c.hostStatus.pilotId : null)) return { orphan: false, reason: "HOST_CHANGED" };
  if (!c.active) return { orphan: false, reason: "HOST_CHANGED" };
  const status = c.activeStatus || {};
  if (status.docking === true) return { orphan: false, reason: "DOCKED" };
  if (status.warping === true) return { orphan: false, reason: "WARP" };
  const since = runtime ? runtime.orphanSinceMs : null;
  if (Number.isFinite(since) && Number.isFinite(c.nowMs) && Number.isFinite(c.graceMs) && c.nowMs - since >= c.graceMs) {
    return { orphan: false, reason: "HOST_CHANGED", timeout: true };
  }
  return { orphan: true };
}

function createWingService(deps) {
  const adapter = deps.adapter || null;
  const store = deps.store;
  const config = deps.config || {};
  const liveConfig = deps.liveConfig && typeof deps.liveConfig.get === "function" ? deps.liveConfig : null;
  const cooldownMs = () => (liveConfig ? liveConfig.get().commandCooldownMs : config.commandCooldownMs);
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const log = deps.log || { log() {}, debug() {}, logError() {} };
  const guardsReady = typeof deps.guardsReady === "function" ? deps.guardsReady : () => false;
  const lossReady = typeof deps.lossReady === "function" ? deps.lossReady : () => false;
  const derivedReady = typeof deps.derivedReady === "function" ? deps.derivedReady : () => false;
  const tickReady = typeof deps.tickReady === "function" ? deps.tickReady : () => false;
  const hrNow = typeof deps.hrNow === "function" ? deps.hrNow : () => Number(process.hrtime.bigint()) / 1e6;
  const tasks = deps.tasks || createWingTasks({ engines: deps.taskEngines, sidecars: deps.taskSidecars, config, clock,
    log });
  const planActive = typeof deps.planActive === "function" ? deps.planActive : null;
  const taskReady = typeof deps.taskReady === "function" ? deps.taskReady : () => false;
  const onOrderAccepted = typeof deps.onOrderAccepted === "function" ? deps.onOrderAccepted : null;
  const SUPPORTED_VERBS = Object.freeze(enabledVerbs(config, taskReady, tasks));
  const droneSidecar = (Array.isArray(deps.taskSidecars) ? deps.taskSidecars : [])
    .find((s) => s && s.name === "drones" && typeof s.setMode === "function") || null;
  const DRONES_ON = config.dronesEnabled === true && droneSidecar !== null;
  const mirrorEngageOnDep = typeof deps.mirrorEngageOn === "function" ? deps.mirrorEngageOn : () => false;
  function mirrorEngageOn() {
    try {
      return mirrorEngageOnDep() === true;
    } catch (_err) {
      return false;
    }
  }

  const formations = deps.formations && typeof deps.formations.get === "function"
    && typeof deps.formations.set === "function" ? deps.formations : null;
  let formationProbe = false;
  try {
    formationProbe = typeof deps.formationReady === "function" && deps.formationReady() === true;
  } catch (_err) {
    formationProbe = false;
  }
  const FORMATION_ON = config.formationEnabled === true && formationProbe && adapter !== null
    && typeof adapter.gotoPoint === "function" && typeof adapter.motionOf === "function";
  const formationMem = new Map();
  const formationCache = new Map();
  const RELAUNCH_ON = FORMATION_ON && config.formationRelaunchEnabled === true;
  const relaunch = new Map();
  let relaunchSeq = 0;

  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const listeners = new Set();
  const blocked = new Set();
  const byOwner = new Map();
  const live = new Map();
  const byTwin = new Map();
  const pending = new Map();
  const lossTwins = new Map();
  const lastLaunch = new Map();
  const boardCooldownUntil = new Map();
  const cargoStore = new Map();
  const cargo = deps.cargo && typeof deps.cargo.listBayCargo === "function"
    && typeof deps.cargo.moveCargo === "function" ? deps.cargo : null;
  const CARGO_ON = config.cargoPanelEnabled === true && cargo !== null;
  const lastCargoMove = new Map();
  const boardReadyDep = typeof deps.boardReady === "function" ? deps.boardReady : () => false;
  function orphanOn() {
    if (config.boardEnabled !== true || config.boardOrphanEnabled !== true) return false;
    try {
      return boardReadyDep() === true;
    } catch (_err) {
      return false;
    }
  }
  let stopped = false;

  function bump(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += by;
  }

  function call(name, ...args) {
    try {
      return { ok: true, value: adapter[name](...args) };
    } catch (err) {
      log.debug(`adapter.${name} threw - ${(err && err.message) || err}`);
      return { ok: false, value: undefined };
    }
  }

  function value(name, ...args) {
    return call(name, ...args).value;
  }

  function dockedAt(session) {
    if (!session || typeof adapter.dockedAt !== "function") return 0;
    const id = Number(value("dockedAt", session));
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
  }

  function index(record) {
    blocked.add(record.shipItemId);
    let set = byOwner.get(record.ownerCharacterId);
    if (!set) {
      set = new Set();
      byOwner.set(record.ownerCharacterId, set);
    }
    set.add(record.shipItemId);
  }

  function dropTask(shipItemId, reason, ctx) {
    try {
      tasks.drop(shipItemId, reason, ctx || {});
    } catch (err) {
      log.debug(`task drop of wing ${shipItemId} threw - ${(err && err.message) || err}`);
    }
  }

  function forgetTwin(shipItemId, reason = "FORGOTTEN") {
    const runtime = live.get(shipItemId);
    if (runtime && byTwin.get(runtime.twinEntityId) === shipItemId) byTwin.delete(runtime.twinEntityId);
    live.delete(shipItemId);
    dropTask(shipItemId, reason, { record: null, scene: runtime ? runtime.scene : null });
  }

  function track(shipItemId, runtime) {
    forgetTwin(shipItemId);
    live.set(shipItemId, runtime);
    if (posInt(runtime.twinEntityId)) byTwin.set(runtime.twinEntityId, shipItemId);
  }

  function unindex(shipItemId, ownerCharacterId) {
    blocked.delete(shipItemId);
    forgetTwin(shipItemId);
    const set = byOwner.get(ownerCharacterId);
    if (set) {
      set.delete(shipItemId);
      if (set.size === 0) byOwner.delete(ownerCharacterId);
    }
  }

  function rebuildIndex() {
    blocked.clear();
    byOwner.clear();
    byTwin.clear();
    pending.clear();
    for (const record of store.list()) {
      if (record.state === "LOST" || record.state === "SETTLED") pending.set(record.shipItemId, record);
      if (record.state !== "SETTLED") index(record);
    }
  }

  function recordOf(shipItemId) {
    const kept = pending.get(shipItemId);
    return kept ? { ...kept } : store.get(shipItemId);
  }

  function twinLookup(scene, twinEntityId) {
    const found = call("entity", scene, twinEntityId);
    if (!found.ok) {
      bump("entity.error");
      return { present: true, entity: null, unknown: true };
    }
    return { present: Boolean(found.value), entity: found.value || null, unknown: false };
  }

  function notify(charId) {
    for (const fn of [...listeners]) {
      try {
        fn(charId);
      } catch (err) {
        bump("listener.error");
        log.debug(`onWingChanged listener threw - ${(err && err.message) || err}`);
      }
    }
  }

  function flyingCount(charId) {
    let n = 0;
    for (const id of byOwner.get(charId) || []) {
      const record = recordOf(id);
      if (record && FLYING_STATES.includes(record.state)) n += 1;
    }
    return n;
  }

  function activeTwinsOf(charId) {
    if (stopped) return [];
    const out = [];
    for (const id of byOwner.get(Number(charId)) || []) {
      const runtime = live.get(id);
      if (!runtime || runtime.aborted === true || !posInt(runtime.twinEntityId)) continue;
      const record = store.get(id);
      if (!record || record.state !== "ACTIVE" || record.twinEntityId !== runtime.twinEntityId) continue;
      out.push({ shipItemId: id, twinEntityId: runtime.twinEntityId });
    }
    return out.sort((a, b) => a.shipItemId - b.shipItemId);
  }

  function step(record, event, extra = {}) {
    const moved = transition(record ? record.state : null, event);
    if (!moved.ok) {
      bump("badTransition");
      return moved;
    }
    if (moved.next === null) return { ok: true, next: null };
    const nowMs = clock.now();
    return {
      ok: true,
      next: { ...record, ...extra, state: moved.next, version: (record ? record.version : 0) + 1,
        stateChangedAtMs: nowMs },
    };
  }

  function refuse(reason) {
    bump(`orderCopy.refused.${reason}`);
    return refusal(reason);
  }

  function ownerContext(charId) {
    const ctx = { session: null, space: null, scene: null, host: null, refusal: null };
    if (stopped || config.enabled !== true || !adapter) {
      ctx.refusal = "DISABLED";
      return ctx;
    }
    const noGuards = !guardsReady();
    const noLoss = !lossReady();
    const noDerived = !derivedReady();
    const noTick = !tickReady();
    const first = (reason) => {
      if (noGuards) ctx.refusal = "GUARDS_UNAVAILABLE";
      else if (noLoss) ctx.refusal = "LOSS_UNAVAILABLE";
      else if (noDerived) ctx.refusal = "DERIVED_GUARD_UNAVAILABLE";
      else ctx.refusal = noTick ? "TICK_UNAVAILABLE" : reason;
      return ctx;
    };
    ctx.session = value("findSession", charId) || null;
    ctx.space = ctx.session ? value("spaceOf", ctx.session) || null : null;
    if (!ctx.space || !posInt(ctx.space.shipId)) {
      ctx.space = null;
      return first("NOT_IN_SPACE");
    }
    ctx.scene = value("sceneOf", ctx.session) || null;
    ctx.host = ctx.scene ? value("hostEntity", ctx.scene, ctx.space.shipId) || null : null;
    const status = ctx.host ? value("hostStatus", ctx.scene, ctx.host) : null;
    if (status && (status.warping === true || status.docking === true)) return first("OWNER_WARPING");
    if (!ctx.scene || !ctx.host || value("isSceneLoaded", ctx.space.sceneKey, ctx.scene) !== true) {
      return first("SCENE_NOT_LOADED");
    }
    return first(null);
  }

  function shipRefusal(charId, ship) {
    if (Number(ship.ownerID) !== charId) return "NOT_OWNER";
    if (Number(ship.singleton) !== 1) return "SHIP_NOT_ASSEMBLED";
    const existing = recordOf(Number(ship.itemID));
    if (existing) {
      return existing.state === "LOST" || existing.state === "SETTLED" ? "LOST_UNSETTLED" : "ALREADY_DEPLOYED";
    }
    if (flyingCount(charId) >= config.maxWingPerPilot) return "LIMIT";
    const missing = call("missingSkills", charId, ship.typeID);
    if (!missing.ok || !Array.isArray(missing.value) || missing.value.length > 0) return "MISSING_SKILLS";
    return null;
  }

  function bayShips(hostShipId) {
    const list = value("listBayShips", hostShipId);
    return Array.isArray(list) ? list.filter((s) => s && posInt(Number(s.itemID))) : [];
  }

  function launch(charId, shipItemId, opts) {
    const relaunched = opts.source === "relaunch";
    const deny = (reason) => (relaunched ? refusal(reason) : refuse(reason));
    if (stopped || config.enabled !== true || !adapter) return deny("DISABLED");
    if (!guardsReady()) return deny("GUARDS_UNAVAILABLE");
    if (!lossReady()) return deny("LOSS_UNAVAILABLE");
    if (!derivedReady()) return deny("DERIVED_GUARD_UNAVAILABLE");
    if (!tickReady()) return deny("TICK_UNAVAILABLE");
    const last = lastLaunch.get(charId);
    const sameCommand = last && opts.commandId !== undefined && opts.commandId === last.commandId;
    if (last && !sameCommand && clock.now() - last.atMs < cooldownMs()) return deny("COOLDOWN");
    const ctx = ownerContext(charId);
    if (ctx.refusal) return deny(ctx.refusal);
    const ship = bayShips(ctx.space.shipId).find((s) => Number(s.itemID) === shipItemId);
    if (!ship) return deny("NOT_IN_SMB");
    const shipProblem = shipRefusal(charId, ship);
    if (shipProblem) return deny(shipProblem);

    const fit = value("readFit", shipItemId);
    const slot = launchSlot(ctx.host, flyingCount(charId), config.launchOffsetMeters);
    const skills = call("skillMap", charId);
    if (!skills.ok || !(skills.value instanceof Map)) {
      bump("launch.noSkills");
      log.log(`wing ${shipItemId}: skill map of character ${charId} not read (${skills.ok ? "not a Map" : "threw"}) `
        + "- the twin flies without skills");
    }
    const built = buildTwinSpec({
      ship, fit: Array.isArray(fit) ? fit : null, owner: value("ownerIdentity", ctx.session),
      skillMap: skills.value, position: slot.position, direction: slot.direction,
      allocId: () => adapter.allocId(), isCharge: typeof adapter.isCharge === "function" ? adapter.isCharge : undefined,
    });
    if (!built.ok) return deny("SPAWN_FAILED");
    let activePlan = null;
    if (planActive) {
      let planned;
      try {
        planned = planActive(built.spec, { ownerCharId: charId, systemID: ctx.space.systemId });
      } catch (err) {
        log.debug(`active plan of wing ${shipItemId} threw - ${(err && err.message) || err}`);
        planned = null;
      }
      if (planned && planned.ok === false && planned.reason === "CAP_UNSTABLE") return deny("CAP_UNSTABLE");
      if (planned && planned.ok === true) {
        activePlan = planned.plan || null;
        if (planned.passiveResourceState) built.spec.passiveResourceState = planned.passiveResourceState;
      }
    }

    const launching = step(null, "LAUNCH", {
      shipItemId, ownerCharacterId: charId, hostShipId: ctx.space.shipId, systemId: ctx.space.systemId,
      sceneKey: ctx.space.sceneKey, shipTypeId: Number(ship.typeID), twinEntityId: 0, fitDigest: built.fitDigest,
      launchedAtMs: Math.max(clock.now(), Number.isSafeInteger(opts.minLaunchedAtMs) ? opts.minLaunchedAtMs : 0),
      reason: null, ...LOSS_DEFAULTS,
    });
    const written = store.put(launching.next);
    if (!written.ok) return deny("STORE_WRITE_FAILED");
    index(launching.next);

    const spawned = call("spawn", ctx.scene, ctx.space.systemId, built.spec);
    if (!spawned.ok || !spawned.value || spawned.value.ok !== true || !spawned.value.entity) {
      if (twinLookup(ctx.scene, built.twinEntityId).present) {
        track(shipItemId, { scene: ctx.scene, twinEntityId: built.twinEntityId, aborted: true,
          lastFollowAtMs: clock.now(), followRange: null, outOfRangeSinceMs: null });
        return deny("SPAWN_FAILED");
      }
      const failed = step(launching.next, "SPAWN_FAILED");
      if (failed.ok) {
        store.remove(shipItemId);
        unindex(shipItemId, charId);
      }
      return deny("SPAWN_FAILED");
    }
    const entity = spawned.value.entity;
    const active = step(launching.next, "SPAWN_OK", { twinEntityId: built.twinEntityId });
    const activeWritten = store.put(active.next);
    if (!activeWritten.ok) {
      const removed = call("remove", ctx.scene, built.twinEntityId, clock.now());
      if (!(removed.ok && removed.value === true) && twinLookup(ctx.scene, built.twinEntityId).present) {
        track(shipItemId, { scene: ctx.scene, twinEntityId: built.twinEntityId, aborted: true,
          lastFollowAtMs: clock.now(), followRange: null, outOfRangeSinceMs: null });
        bump("end.removeRetry");
        return deny("STORE_WRITE_FAILED");
      }
      store.remove(shipItemId);
      unindex(shipItemId, charId);
      return deny("STORE_WRITE_FAILED");
    }
    const nowMs = clock.now();
    call("follow", ctx.scene, entity, ctx.space.shipId, config.followRangeMeters);
    track(shipItemId, { scene: ctx.scene, twinEntityId: built.twinEntityId, lastFollowAtMs: nowMs,
      followRange: config.followRangeMeters, outOfRangeSinceMs: null,
      formationPoint: null, formationAtMs: 0 });
    try {
      tasks.start(active.next, { syntheticToReal: built.syntheticToReal, active: activePlan });
    } catch (err) {
      log.debug(`task start of wing ${shipItemId} threw - ${(err && err.message) || err}`);
    }
    assistOnLaunch(active.next, entity, ctx.scene);
    lastLaunch.set(charId, { atMs: nowMs, commandId: opts.commandId });
    if (!relaunched) bump("orderCopy.ok.launch");
    notify(charId);
    return { ok: true, state: active.next.state };
  }

  function assistOnLaunch(record, twin, scene) {
    if (!SUPPORTED_VERBS.includes("attack") || config.combatAssistOnLaunch !== true) return;
    try {
      tasks.order(record, live.get(record.shipItemId), "attack", { mode: "ASSIST", source: "launch", twin, adapter,
        scene, record });
    } catch (err) {
      log.debug(`assist at launch of wing ${record.shipItemId} threw - ${(err && err.message) || err}`);
    }
  }

  function recall(charId, shipItemId) {
    if (stopped || config.enabled !== true || !adapter) return refuse("DISABLED");
    const record = recordOf(shipItemId);
    if (!record) return refuse("NOT_DEPLOYED");
    if (record.ownerCharacterId !== charId) return refuse("NOT_OWNER");
    if (record.state !== "ACTIVE") return refuse("NOT_DEPLOYED");
    const returning = step(record, "RETURN");
    if (!returning.ok) return refuse("NOT_DEPLOYED");
    const written = store.put(returning.next);
    if (!written.ok) return refuse("STORE_WRITE_FAILED");
    const runtime = live.get(shipItemId);
    try {
      tasks.suspend(shipItemId, "RETURN", { record: returning.next, scene: runtime ? runtime.scene : null });
    } catch (err) {
      log.debug(`task suspend of wing ${shipItemId} threw - ${(err && err.message) || err}`);
    }
    if (runtime) {
      const twin = value("entity", runtime.scene, record.twinEntityId);
      if (twin) call("follow", runtime.scene, twin, record.hostShipId, 0);
      runtime.lastFollowAtMs = clock.now();
      runtime.followRange = 0;
    }
    bump("orderCopy.ok.return");
    notify(charId);
    return { ok: true, state: returning.next.state };
  }

  function orderTask(charId, shipItemId, verb, opts) {
    const record = recordOf(shipItemId);
    if (!record) return refuse("NOT_DEPLOYED");
    if (record.ownerCharacterId !== charId) return refuse("NOT_OWNER");
    const runtime = live.get(shipItemId);
    if (record.state !== "ACTIVE" || !runtime) return refuse("NOT_DEPLOYED");
    if (verb !== "hold" && runtime.orphanSinceMs !== null && runtime.orphanSinceMs !== undefined) {
      return refuse("HOST_EMPTY");
    }
    const twin = verb === "hold" ? null : value("entity", runtime.scene, record.twinEntityId) || null;
    let ordered;
    try {
      ordered = tasks.order(record, runtime, verb, { targetId: opts.targetId, twin, adapter, scene: runtime.scene,
        record, mode: opts.mode, source: opts.source || "chat" });
    } catch (err) {
      log.debug(`task order of wing ${shipItemId} threw - ${(err && err.message) || err}`);
      ordered = null;
    }
    if (!ordered || ordered.ok !== true) {
      const reason = ordered && REFUSAL.includes(ordered.reason) ? ordered.reason : "TASK_UNAVAILABLE";
      return refuse(reason);
    }
    runtime.followRange = null;
    runtime.formationPoint = null;

    bump(`orderCopy.ok.${verb}`);
    notify(charId);
    return { ok: true, state: record.state, task: ordered.task };
  }

  function orderCopy(charId, shipItemId, verb, opts = {}) {
    if (stopped || config.enabled !== true || !adapter) return refuse("DISABLED");
    if (!SUPPORTED_VERBS.includes(verb)) return refuse("UNSUPPORTED_VERB");
    const character = Number(charId);
    const item = Number(shipItemId);
    const options = opts && typeof opts === "object" ? opts : {};
    let out;
    if (verb === "launch") {
      if (!posInt(character) || !posInt(item)) return refuse(posInt(character) ? "NOT_IN_SMB" : "NOT_IN_SPACE");
      out = launch(character, item, options);
    } else {
      if (!posInt(character) || !posInt(item)) return refuse("NOT_DEPLOYED");
      out = TASK_VERBS.includes(verb) ? orderTask(character, item, verb, options) : recall(character, item);
    }
    if (out && out.ok === true && onOrderAccepted) {
      try {
        onOrderAccepted(character, verb, options.source || "chat");
      } catch (_err) {
        bump("orderAccepted.error");
      }
    }
    return out;
  }

  function setDroneMode(charId, shipItemId, mode) {
    if (stopped || config.enabled !== true || !adapter) return refuse("DISABLED");
    const character = Number(charId);
    const item = Number(shipItemId);
    if (!posInt(character) || !posInt(item)) return refuse("NOT_DEPLOYED");
    const record = recordOf(item);
    if (!record) return refuse("NOT_DEPLOYED");
    if (record.ownerCharacterId !== character) return refuse("NOT_OWNER");
    const rt = record.state === "ACTIVE" && live.has(item) ? tasks.context(item) : null;
    if (!rt) return refuse("NOT_DEPLOYED");
    if (!DRONES_ON) return refuse("DRONES_UNAVAILABLE");
    let out;
    try {
      out = droneSidecar.setMode(rt, String(mode === undefined || mode === null ? "" : mode).trim().toLowerCase());
    } catch (err) {
      log.debug(`drone mode of wing ${item} threw - ${(err && err.message) || err}`);
      out = null;
    }
    if (!out || out.ok !== true) {
      return refuse(out && out.reason === "MODE_INVALID" ? "MODE_INVALID" : "DRONES_UNAVAILABLE");
    }
    notify(character);
    return { ok: true, state: record.state, mode: out.mode };
  }

  function setMirrorEngage(charId, shipItemId, on) {
    if (stopped || config.enabled !== true || !adapter) return refusal("DISABLED");
    const character = Number(charId);
    const item = Number(shipItemId);
    if (!posInt(character) || !posInt(item)) return refusal("NOT_DEPLOYED");
    const record = recordOf(item);
    if (!record) return refusal("NOT_DEPLOYED");
    if (record.ownerCharacterId !== character) return refusal("NOT_OWNER");
    const rt = record.state === "ACTIVE" && live.has(item) ? tasks.context(item) : null;
    if (!rt) return refusal("NOT_DEPLOYED");
    if (!mirrorEngageOn()) return refusal("ENGAGE_UNAVAILABLE");
    const out = typeof tasks.setMirrorEngage === "function" ? tasks.setMirrorEngage(item, on === true) : null;
    if (!out || out.ok !== true) return refusal("NOT_DEPLOYED");
    notify(character);
    return { ok: true, state: record.state, on: out.on };
  }

  function cargoStoreOf(hostShipId) {
    const id = cargoStore.get(Number(hostShipId)) || 0;
    return id > 0 && blocked.has(id) ? 0 : id;
  }

  function setCargoStore(charId, shipItemId) {
    if (stopped || config.enabled !== true || !adapter || config.miningRealCargoEnabled !== true
      || config.miningRealCargoStoreEnabled !== true) return refusal("DISABLED");
    const character = Number(charId);
    const session = posInt(character) ? value("findSession", character) || null : null;
    const space = session ? value("spaceOf", session) || null : null;
    if (!space || !posInt(Number(space.shipId))) return refusal("NOT_IN_SPACE");
    const hostShipId = Number(space.shipId);
    if (shipItemId === null || shipItemId === undefined) {
      cargoStore.delete(hostShipId);
      return { ok: true, hostShipId, storeShipItemId: null };
    }
    const item = Number(shipItemId);
    const ship = posInt(item) ? bayShips(hostShipId).find((s) => Number(s.itemID) === item) : null;
    if (!ship) return refusal("NOT_IN_SMB");
    if (Number(ship.ownerID) !== character) return refusal("NOT_OWNER");
    const record = recordOf(item);
    if (record) {
      return refusal(record.state === "LOST" || record.state === "SETTLED" ? "LOST_UNSETTLED" : "ALREADY_DEPLOYED");
    }
    cargoStore.set(hostShipId, item);
    return { ok: true, hostShipId, storeShipItemId: item };
  }

  function cargoHost(charId) {
    if (stopped || config.enabled !== true || !adapter || !CARGO_ON) return refusal("DISABLED");
    const character = Number(charId);
    const session = posInt(character) ? value("findSession", character) || null : null;
    const space = session ? value("spaceOf", session) || null : null;
    if (!space || !posInt(Number(space.shipId))) return refusal("NOT_IN_SPACE");
    return { ok: true, character, hostShipId: Number(space.shipId) };
  }

  function cargoOf(charId, firstShipItemId) {
    const ctx = cargoHost(charId);
    if (!ctx.ok) return ctx;
    let out;
    try {
      out = firstShipItemId > 0 ? cargo.listBayCargo(ctx.character, ctx.hostShipId, Number(firstShipItemId))
        : cargo.listBayCargo(ctx.character, ctx.hostShipId);
    } catch (err) {
      log.debug(`cargo list of character ${ctx.character} threw - ${(err && err.message) || err}`);
      out = null;
    }
    return out && typeof out === "object" ? out : refusal("HOST_INVALID");
  }

  function moveCargo(charId, input) {
    const ctx = cargoHost(charId);
    if (!ctx.ok) return { ...ctx, skipped: 0, results: [] };
    const args = input && typeof input === "object" ? input : {};
    const all = Array.isArray(args.items) ? args.items : [];
    if (all.length === 0) return { ok: false, reason: "QUANTITY_INVALID", skipped: 0, results: [] };
    const items = all.slice(0, config.cargoMoveMaxItems);
    const skipped = all.length - items.length;
    const now = clock.now();
    const last = lastCargoMove.get(ctx.character);
    if (last !== undefined && now - last < config.cargoMoveMinIntervalMs) {
      bump("cargo.refused");
      return { ok: false, reason: "COOLDOWN", skipped: 0, results: [] };
    }
    lastCargoMove.set(ctx.character, now);
    const results = [];
    let movedQty = 0;
    let movedM3 = 0;
    for (const entry of items) {
      const itemId = Number(entry && entry.itemId);
      let out;
      try {
        out = cargo.moveCargo({ ownerCharacterId: ctx.character, hostShipId: ctx.hostShipId, itemId,
          quantity: entry && entry.quantity !== undefined ? entry.quantity : null,
          toLocationId: Number(args.toShipItemId), toFlag: args.toFlag === undefined ? null : args.toFlag,
          isLocked: (shipItemId) => pending.has(Number(shipItemId)) });
      } catch (err) {
        log.debug(`cargo move of item ${itemId} threw - ${(err && err.message) || err}`);
        out = { ok: false, reason: "MOVE_FAILED" };
      }
      if (out && out.ok === true) {
        bump("cargo.moved");
        movedQty += out.movedQty;
        movedM3 += out.movedM3;
        const result = { itemId, ok: true, reason: null, typeId: out.typeId, name: out.name, movedQty: out.movedQty,
          leftQty: out.leftQty };
        if (typeof out.stopReason === "string" && out.stopReason !== "") {
          result.stopReason = out.stopReason;
          log.debug(`cargo move of item ${itemId}: the rest (${out.leftQty}) stopped - ${out.stopReason}`
            + `${out.stopDetail ? ` (${out.stopDetail})` : ""}`);
        }
        results.push(result);
        continue;
      }
      bump("cargo.refused");
      results.push({ itemId, ok: false, reason: (out && out.reason) || "MOVE_FAILED", typeId: null, name: null,
        movedQty: 0, leftQty: null });
    }
    if (movedQty > 0) return { ok: true, movedQty, movedM3, skipped, results };
    return { ok: false, reason: results[0].reason, skipped, results };
  }

  function formationOf(charId) {
    if (!FORMATION_ON) return NO_FORMATION;
    const character = Number(charId);
    if (formationMem.has(character)) return formationMem.get(character);
    if (!formations) return NO_FORMATION;
    try {
      const name = formations.get(character);
      return FORMATIONS.includes(name) ? name : NO_FORMATION;
    } catch (_err) {
      return NO_FORMATION;
    }
  }

  function setFormation(charId, name) {
    if (stopped || config.enabled !== true || !adapter) return refuse("DISABLED");
    if (!FORMATION_ON) return refuse("FORMATION_UNAVAILABLE");
    const character = Number(charId);
    const formation = normalizeFormation(name);
    if (!posInt(character) || formation === null) return refuse("FORMATION_INVALID");
    const storedNow = () => {
      try {
        return Boolean(formations) && formations.get(character) === formation;
      } catch (_err) {
        return false;
      }
    };
    if (formationOf(character) === formation) {
      return { ok: true, formation, persisted: !formationMem.has(character) && storedNow() };
    }
    let persisted = false;
    if (formations) {
      let written = null;
      try {
        written = formations.set(character, formation);
      } catch (err) {
        log.debug(`formation store set of character ${character} threw - ${(err && err.message) || err}`);
      }
      persisted = Boolean(written && written.ok === true);
    }
    if (persisted) formationMem.delete(character);
    else if (formations || formation !== NO_FORMATION) formationMem.set(character, formation);
    else formationMem.delete(character);
    for (const id of byOwner.get(character) || []) {
      const runtime = live.get(id);
      if (runtime) runtime.formationPoint = null;
    }
    formationCache.delete(character);
    if (formation === NO_FORMATION && relaunch.delete(character)) bump("formation.relaunch.dropped.FORMATION_NONE");
    bump("formation.set");
    notify(character);
    return { ok: true, formation, persisted };
  }

  function formationGroup(charId, host) {
    const cached = formationCache.get(charId);
    if (cached) return cached;
    const group = { host: null, order: new Map(), count: 0, maxRadius: 0, missing: new Set() };
    const hostMotion = host ? value("motionOf", host) : null;
    group.host = hostMotion || null;
    let maxRadius = hostMotion ? hostMotion.radius : 0;
    const members = [];
    for (const id of byOwner.get(charId) || []) {
      const runtime = live.get(id);
      if (!runtime || runtime.aborted === true) continue;
      const record = store.get(id);
      if (!record || record.state !== "ACTIVE") continue;
      members.push({ id, at: Number(record.launchedAtMs) || 0, runtime, twinEntityId: record.twinEntityId });
    }
    members.sort((a, b) => (a.at - b.at) || (a.id - b.id));
    members.forEach((m, index) => {
      group.order.set(m.id, index);
      const twin = value("entity", m.runtime.scene, m.twinEntityId);
      const motion = twin ? value("motionOf", twin) : null;
      if (!motion) group.missing.add(m.id);
      else maxRadius = Math.max(maxRadius, motion.radius);
    });
    group.count = members.length;
    group.maxRadius = Number.isFinite(maxRadius) ? maxRadius : 0;
    formationCache.set(charId, group);
    return group;
  }

  function formationSlot(record, checked) {
    const name = formationOf(record.ownerCharacterId);
    if (name === NO_FORMATION) return null;
    const group = formationGroup(record.ownerCharacterId, checked.host);
    const index = group.order.get(record.shipItemId);
    if (!group.host || index === undefined || group.missing.has(record.shipItemId)) return null;
    return slotPoint({ name, index, count: group.count, host: group.host, maxRadius: group.maxRadius, cfg: config });
  }

  function formationStep(record, runtime, checked, nowMs) {
    if (!FORMATION_ON || formationOf(record.ownerCharacterId) === NO_FORMATION) return false;
    const point = formationSlot(record, checked);
    if (!point) {
      bump("formation.fallbackFollow");
      runtime.formationPoint = null;
      return false;
    }
    if (runtime.formationPoint) {
      const due = nowMs - runtime.formationAtMs >= config.formationRetuneMs;
      const moved = vecDistance(point, runtime.formationPoint) > config.formationRepointMeters;
      const notGoto = !checked.twin || checked.twin.mode !== "GOTO";
      if (!(due && (moved || notGoto))) {
        bump("formation.repointSkipped");
        return true;
      }
    }
    const sent = call("gotoPoint", runtime.scene, checked.twin, point);
    if (!sent.ok || sent.value !== true) {
      bump("formation.gotoFailed");
      runtime.formationPoint = null;
      return false;
    }
    runtime.formationPoint = point;
    runtime.formationAtMs = nowMs;
    runtime.followRange = FORMATION_RANGE;
    bump("formation.goto");
    return true;
  }

  function viewOf(record, ship, eligible, refusalReason, ctx) {
    const runtime = record ? live.get(record.shipItemId) : null;
    let distanceM = null;
    const twin = runtime && record.twinEntityId > 0 ? value("entity", runtime.scene, record.twinEntityId) : null;
    if (twin && ctx.host) {
      const d = value("surfaceDistance", runtime.scene, twin, ctx.host);
      distanceM = Number.isFinite(d) ? d : null;
    }
    const typeId = ship ? Number(ship.typeID) : record.shipTypeId;
    const typeName = String(value("typeName", typeId) || "");
    const name = ship && ship.itemName ? String(ship.itemName) : typeName;
    const hpSource = twin || ship || null;
    const hp = hpSource ? hpPermille(value("conditionOf", hpSource)) : null;
    let task = null;
    let active = null;
    let drones = null;
    let mirrorEngage = null;
    let running = [];
    if (runtime && record.state === "ACTIVE") {
      try {
        if (ctx.mirrorEngageOn === true && typeof tasks.mirrorEngageOf === "function") {
          const on = tasks.mirrorEngageOf(record.shipItemId);
          mirrorEngage = typeof on === "boolean" ? on : null;
        }
        const side = DRONES_ON && typeof tasks.sidecarViews === "function" ? tasks.sidecarViews(record.shipItemId)
          : null;
        drones = side && side.drones && typeof side.drones === "object" ? side.drones : null;
        task = tasks.view(record.shipItemId);
        active = typeof tasks.activeOf === "function" ? tasks.activeOf(record.shipItemId) : null;
        if (active && Array.isArray(active.shedTypeIds)) {
          active.shedNames = active.shedTypeIds.map((id) => String(value("typeName", id) || id));
        }
        running = runningOf({ task, active, drones });
      } catch (_err) {
        task = null;
        running = [];
      }
    }
    let targetName = null;
    if (runtime && task && posInt(task.targetId)) {
      const target = value("entity", runtime.scene, task.targetId);
      const targetType = target ? Number(target.typeID) : 0;
      targetName = posInt(targetType) ? String(value("typeName", targetType) || "") || null : null;
    }
    const rowRefusal = record && record.state === "ACTIVE" && task && REFUSAL.includes(task.wait) ? task.wait
      : refusalReason;
    return {
      shipItemId: ship ? Number(ship.itemID) : record.shipItemId, typeId, name, typeName, hp, targetName,
      state: record ? record.state : "IN_BAY", eligible, refusal: rowRefusal,
      entityId: record && record.twinEntityId > 0 ? record.twinEntityId : null, distanceM,
      targetId: task && task.targetId !== null ? task.targetId : NO_POSITION,
      task: task ? task.task : null, holdM3: task ? task.holdM3 : null,
      taskSub: task && task.sub ? task.sub : null,
      active,
      drones,
      mirrorEngage,
      running,
    };
  }

  function listHost(ctx, charId) {
    if (ctx.space) return ctx.space.shipId;
    if (ctx.refusal !== "NOT_IN_SPACE" || !ctx.session || typeof adapter.activeShipId !== "function") return 0;
    // A session between two scenes of a jump has no dock and lists no bay.
    if (dockedAt(ctx.session) === 0) return 0;
    const active = Number(value("activeShipId", charId));
    return posInt(active) ? active : 0;
  }

  function listWing(charId) {
    const character = Number(charId);
    const ctx = { ...(adapter && posInt(character) ? ownerContext(character)
      : { refusal: "DISABLED", space: null, host: null }), mirrorEngageOn: mirrorEngageOn() };
    const view = {
      characterId: character, hostShipId: ctx.space ? ctx.space.shipId : null,
      limit: config.maxWingPerPilot, deployedCount: posInt(character) ? flyingCount(character) : 0,
      refusal: ctx.refusal || null, ships: [],
      formation: FORMATION_ON && posInt(character) ? formationOf(character) : null,
    };
    const seen = new Set();
    const host = listHost(ctx, character);
    const bay = host ? bayShips(host) : [];
    for (const ship of [...bay].sort((a, b) => Number(a.itemID) - Number(b.itemID))) {
      const id = Number(ship.itemID);
      seen.add(id);
      const record = recordOf(id);
      const foreign = ctx.refusal === "NOT_IN_SPACE" && Number(ship.ownerID) !== character;
      const reason = foreign ? "NOT_OWNER" : ctx.refusal || shipRefusal(character, ship);
      view.ships.push(viewOf(record, ship, reason === null, reason, ctx));
    }
    for (const id of [...(byOwner.get(character) || [])].sort((a, b) => a - b)) {
      if (seen.has(id)) continue;
      const record = recordOf(id);
      if (record) {
        view.ships.push(viewOf(record, null, false, record.state === "LOST" ? "LOST_UNSETTLED" : "ALREADY_DEPLOYED",
          ctx));
      }
    }
    return view;
  }

  function nearLeashAnchor(record, runtime, twin) {
    const anchorId = runtime.leashAnchorId;
    if (record.state !== "ACTIVE" || !Number.isSafeInteger(anchorId) || anchorId <= 0) return false;
    const anchor = value("entity", runtime.scene, anchorId);
    if (!anchor) return false;
    const d = value("surfaceDistance", runtime.scene, twin, anchor);
    return Number.isFinite(d) && d <= config.controlRangeMeters;
  }

  function forcedReason(record, runtime, nowMs) {
    const session = value("findSession", record.ownerCharacterId);
    if (!session) return { reason: "LOGOFF" };
    const space = value("spaceOf", session);
    if (!space) {
      const inTransit = RELAUNCH_ON && typeof adapter.dockedAt === "function" && dockedAt(session) === 0
        && formationOf(record.ownerCharacterId) !== NO_FORMATION;
      return { reason: inTransit ? "JUMPED" : "DOCKED" };
    }
    if (space.sceneKey !== record.sceneKey) return { reason: "JUMPED" };
    const orphanWindow = orphanOn();
    const activeShipId = typeof adapter.activeShipId === "function"
      ? value("activeShipId", record.ownerCharacterId) : 0;
    const hostLeft = space.shipId !== record.hostShipId
      || (posInt(activeShipId) && activeShipId !== record.hostShipId);
    if (hostLeft && !orphanWindow) return { reason: "HOST_CHANGED" };
    const host = value("hostEntity", runtime.scene, record.hostShipId);
    if (!host) return { reason: "HOST_GONE" };
    const status = value("hostStatus", runtime.scene, host) || {};
    const foreignPilot = Number.isSafeInteger(status.pilotId) && status.pilotId !== record.ownerCharacterId;
    let orphan = false;
    if (hostLeft || foreignPilot) {
      if (!orphanWindow) return { reason: "HOST_CHANGED" };
      const active = hostLeft ? value("hostEntity", runtime.scene, space.shipId) || null : host;
      const activeStatus = active && active !== host ? value("hostStatus", runtime.scene, active) || {} : status;
      const state = orphanState(record, runtime, { enabled: true, space, host, hostStatus: status, active,
        activeStatus, nowMs, graceMs: config.boardOrphanGraceMs });
      if (!state.orphan) {
        if (state.timeout) bump("board.orphan.timeout");
        return { reason: state.reason };
      }
      enterOrphan(record, runtime, nowMs);
      orphan = true;
    } else if (runtime.orphanSinceMs !== null && runtime.orphanSinceMs !== undefined) {
      runtime.orphanSinceMs = null;
      bump("board.orphan.cleared");
    }
    if (!orphan && status.docking === true) return { reason: "DOCKED" };
    if (!orphan && status.warping === true) return { reason: "WARP" };
    if (value("isSceneLoaded", record.sceneKey, runtime.scene) !== true) return { reason: "SCENE_GONE" };
    const looked = twinLookup(runtime.scene, record.twinEntityId);
    if (looked.unknown) return { unknown: true };
    const twin = looked.entity;
    if (!twin) return { lost: true };
    const distance = value("surfaceDistance", runtime.scene, twin, host);
    const inRange = Number.isFinite(distance) && distance <= config.controlRangeMeters;
    if (!inRange && !nearLeashAnchor(record, runtime, twin)) {
      if (runtime.outOfRangeSinceMs === null) runtime.outOfRangeSinceMs = nowMs;
      if (nowMs - runtime.outOfRangeSinceMs >= config.outOfRangeGraceMs) return { reason: "OUT_OF_RANGE" };
    } else {
      runtime.outOfRangeSinceMs = null;
    }
    return { twin, distance, host, orphan };
  }

  function enterOrphan(record, runtime, nowMs) {
    if (runtime.orphanSinceMs !== null && runtime.orphanSinceMs !== undefined) return;
    runtime.orphanSinceMs = nowMs;
    bump("board.orphan.begin");
    if (record.state !== "ACTIVE") return;
    try {
      tasks.order(record, runtime, "hold", { twin: null, adapter, scene: runtime.scene, record, source: "orphan" });
    } catch (err) {
      log.debug(`orphan hold of wing ${record.shipItemId} threw - ${(err && err.message) || err}`);
    }
    runtime.followRange = null;
    runtime.formationPoint = null;
  }

  function emitToOwner(ownerCharacterId, changes) {
    if (!Array.isArray(changes) || changes.length === 0) return;
    const session = value("findSession", ownerCharacterId);
    if (session) call("emitItemChanges", session, changes);
  }

  function writeBackCondition(record, runtime, reason) {
    if (config.conditionWriteBack !== true || runtime.conditionWritten === true) return;
    if (NO_CONDITION_END.includes(reason)) return;
    const twin = value("entity", runtime.scene, record.twinEntityId);
    if (!twin) return;
    runtime.conditionWritten = true;
    const condition = value("conditionOf", twin);
    const written = condition ? call("writeCondition", record.shipItemId, condition) : { ok: false };
    if (!written.ok || !written.value || written.value.ok !== true) {
      bump("condition.writeFailed");
      log.debug(`wing ${record.shipItemId}: condition not written back (${reason}) - `
        + `${(written.value && written.value.reason) || "adapter refused"}`);
      return;
    }
    bump("condition.written");
    emitToOwner(record.ownerCharacterId, written.value.changes);
  }

  function endRecord(record, runtime, reason, event, nowMs) {
    try {
      tasks.beforeEnd(record, runtime, reason);
    } catch (err) {
      bump("tick.error");
      log.debug(`task beforeEnd of wing ${record.shipItemId} threw - ${(err && err.message) || err}`);
    }
    writeBackCondition(record, runtime, reason);
    const removed = call("remove", runtime.scene, record.twinEntityId, nowMs);
    if (!(removed.ok && removed.value === true) && reason !== "SCENE_GONE"
      && twinLookup(runtime.scene, record.twinEntityId).present) {
      bump("end.removeRetry");
      return false;
    }
    const ended = step(record, event);
    if (!ended.ok) return false;
    const written = store.remove(record.shipItemId);
    if (!written.ok) {
      bump("end.storeWriteFailed");
      log.log(`wing ${record.shipItemId} ended (${reason}) - state file write failed (${written.reason}); `
        + "removed in memory, the next write carries it");
    }
    dropTask(record.shipItemId, reason, { record, scene: runtime.scene });
    unindex(record.shipItemId, record.ownerCharacterId);
    bump(`end.${reason}`);
    notify(record.ownerCharacterId);
    return true;
  }

  function liveTwinCount() {
    return byTwin.size;
  }

  function takeLossTwin(entity) {
    if (lossTwins.size === 0 || !entity || typeof entity !== "object") return false;
    const twinEntityId = Number(entity.itemID);
    for (const [shipItemId, kept] of lossTwins) {
      if (kept.twinEntityId === twinEntityId) {
        sweepLossTwin(shipItemId);
        return true;
      }
    }
    return false;
  }

  function claimTwin(entity) {
    if (stopped || !entity || typeof entity !== "object" || entity.kind !== "ship" || entity.nativeNpc === true) {
      return null;
    }
    const twinEntityId = Number(entity.itemID);
    const shipItemId = byTwin.get(twinEntityId);
    if (shipItemId === undefined) return null;
    const record = store.get(shipItemId);
    if (!record || Number(entity.pilotCharacterID) !== record.ownerCharacterId) return null;
    return { shipItemId, ownerCharacterId: record.ownerCharacterId, twinEntityId };
  }

  function boardOwnerOf(twinEntityId) {
    if (stopped || byTwin.size === 0) return null;
    const id = Number(twinEntityId);
    if (!posInt(id)) return null;
    const shipItemId = byTwin.get(id);
    if (shipItemId === undefined) return null;
    const record = store.get(shipItemId);
    return record ? { shipItemId, ownerCharacterId: record.ownerCharacterId, state: record.state } : null;
  }

  function boardRefuse(reason) {
    bump(`board.refused.${reason}`);
    return refusal(reason);
  }

  function plainVec(v) {
    if (!v || typeof v !== "object") return null;
    const out = { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) ? out : null;
  }

  function boardContextRefusal(charId, record, runtime) {
    const session = value("findSession", charId);
    const space = session ? value("spaceOf", session) : null;
    if (!space || !posInt(space.shipId)) return { reason: "NOT_IN_SPACE" };
    const scene = value("sceneOf", session) || null;
    if (space.sceneKey !== record.sceneKey || !scene || scene !== runtime.scene
      || value("isSceneLoaded", record.sceneKey, scene) !== true) {
      return { reason: "SCENE_NOT_LOADED" };
    }
    const orphanWindow = orphanOn();
    const activeShipId = typeof adapter.activeShipId === "function" ? value("activeShipId", charId) : 0;
    const hostLeft = space.shipId !== record.hostShipId || (posInt(activeShipId) && activeShipId !== record.hostShipId);
    if (hostLeft && !orphanWindow) return { reason: "HOST_CHANGED" };
    const host = value("hostEntity", scene, record.hostShipId) || null;
    if (!host) return { reason: orphanWindow ? "HOST_GONE" : "HOST_CHANGED" };
    const status = value("hostStatus", scene, host) || {};
    const foreignPilot = Number.isSafeInteger(status.pilotId) && status.pilotId !== record.ownerCharacterId;
    if (orphanWindow && (hostLeft || foreignPilot)) {
      const active = hostLeft ? value("hostEntity", scene, space.shipId) || null : host;
      const activeStatus = active && active !== host ? value("hostStatus", scene, active) || {} : status;
      const state = orphanState(record, runtime, { enabled: true, space, host, hostStatus: status, active,
        activeStatus, nowMs: clock.now(), graceMs: config.boardOrphanGraceMs });
      if (!state.orphan) {
        if (state.reason === "WARP" || state.reason === "DOCKED") return { reason: "OWNER_WARPING" };
        return { reason: state.reason === "HOST_GONE" ? "HOST_GONE" : "HOST_CHANGED" };
      }
      const hostDistance = active === host ? 0 : value("surfaceDistance", scene, active, host);
      if (!Number.isFinite(hostDistance) || hostDistance > config.boardHostRangeMeters) {
        return { reason: "HOST_TOO_FAR" };
      }
      return { reason: null, host, active };
    }
    if (status.warping === true || status.docking === true) return { reason: "OWNER_WARPING" };
    return { reason: null, host, active: host };
  }

  function releaseForBoard(charId, twinEntityId, opts = {}) {
    if (stopped || !adapter || config.boardEnabled !== true) return boardRefuse("DISABLED");
    const owner = boardOwnerOf(twinEntityId);
    if (!owner) return boardRefuse("NOT_DEPLOYED");
    if (owner.ownerCharacterId !== Number(charId)) return boardRefuse("NOT_OWNER");
    const record = store.get(owner.shipItemId);
    const runtime = live.get(owner.shipItemId);
    if (!record || !runtime || (record.state !== "ACTIVE" && record.state !== "RETURNING")) {
      return boardRefuse("NOT_FLYING");
    }
    const taskRt = tasks.context(owner.shipItemId);
    if (runtime.aborted === true || runtime.pendingEnd || (taskRt && taskRt.ending === true)) {
      return boardRefuse("ENDING");
    }
    const ctx = boardContextRefusal(owner.ownerCharacterId, record, runtime);
    if (ctx.reason) return boardRefuse(ctx.reason);
    const looked = twinLookup(runtime.scene, record.twinEntityId);
    if (!looked.entity) return boardRefuse("NOT_DEPLOYED");
    const twin = looked.entity;
    if (typeof adapter.isDestroying === "function" && value("isDestroying", twin) === true) {
      return boardRefuse("TWIN_DYING");
    }
    const distance = value("surfaceDistance", runtime.scene, twin, ctx.active);
    if (!Number.isFinite(distance) || distance > config.boardRangeMeters) return boardRefuse("TOO_FAR");
    const missing = call("missingSkills", owner.ownerCharacterId, record.shipTypeId);
    if (!missing.ok || !Array.isArray(missing.value) || missing.value.length > 0) return boardRefuse("MISSING_SKILLS");
    if (!bayShips(record.hostShipId).some((s) => Number(s.itemID) === record.shipItemId)) {
      return boardRefuse("NOT_IN_SMB");
    }
    const nowMs = Number.isFinite(opts && opts.nowMs) ? opts.nowMs : clock.now();
    const until = boardCooldownUntil.get(owner.ownerCharacterId);
    if (until !== undefined && nowMs < until) return boardRefuse("COOLDOWN");
    if (opts && typeof opts.hostCheck === "function" && opts.hostCheck(ctx.host) === "SCOPE_INVALID") {
      return boardRefuse("SCOPE_INVALID");
    }
    const spot = { position: plainVec(twin.position), direction: plainVec(twin.direction),
      radius: Number.isFinite(Number(twin.radius)) ? Number(twin.radius) : 0 };
    const releasedTwinId = record.twinEntityId;
    const drones = typeof adapter.controlledDroneIds === "function"
      ? value("controlledDroneIds", runtime.scene, releasedTwinId) : null;
    const droneIds = Array.isArray(drones) ? drones.filter((id) => posInt(id)) : [];
    if (!endRecord(record, runtime, "BOARDED", "BOARDED", nowMs)) {
      runtime.pendingEnd = "BOARDED";
      bump("board.pendingEnd");
      return boardRefuse("ENDING");
    }
    boardCooldownUntil.set(owner.ownerCharacterId, nowMs + config.boardCooldownMs);
    bump("board.released");
    return { ok: true, shipItemId: record.shipItemId, hostShipId: record.hostShipId, systemId: record.systemId,
      twin: spot, twinEntityId: releasedTwinId, droneIds };
  }

  function pruneBoardCooldowns(nowMs) {
    if (boardCooldownUntil.size === 0) return;
    for (const [charId, until] of boardCooldownUntil) if (nowMs >= until) boardCooldownUntil.delete(charId);
  }

  function beginLoss(shipItemId, opts) {
    const cause = opts && opts.cause === "MISSING" ? "MISSING" : "DESTROYED";
    const record = store.get(shipItemId);
    const runtime = live.get(shipItemId);
    const aborted = Boolean(record && record.state === "LAUNCHING" && runtime && runtime.aborted === true);
    if (!record || !(record.state === "ACTIVE" || record.state === "RETURNING" || aborted)) {
      return refusal("NOT_FLYING");
    }
    const nowMs = clock.now();
    const twinEntityId = runtime && posInt(runtime.twinEntityId) ? runtime.twinEntityId : record.twinEntityId;
    const lost = step(record, cause === "MISSING" ? "TWIN_MISSING" : "DESTROYED", {
      ...LOSS_DEFAULTS, twinEntityId, reason: null, lossCause: cause, lossAtMs: nowMs, nextSettleAtMs: nowMs,
    });
    if (!lost.ok) return refusal("BAD_TRANSITION");
    const written = store.put(lost.next);
    if (!written.ok) {
      bump("loss.storeWriteFailed");
      log.log(`wing ${shipItemId} LOST (${cause}) - state file write failed (${written.reason}); kept in memory, `
        + "settled now");
    }
    pending.set(shipItemId, lost.next);
    if (cause === "DESTROYED" && runtime && posInt(twinEntityId)) {
      lossTwins.set(shipItemId, { scene: runtime.scene, twinEntityId });
    }
    forgetTwin(shipItemId, "LOST");
    bump("lost");
    bump(cause === "MISSING" ? "loss.missing" : "loss.destroyed");
    notify(record.ownerCharacterId);
    return { ok: true, persisted: written.ok };
  }

  function persistPending(record) {
    pending.set(record.shipItemId, record);
    const written = store.put(record);
    if (!written.ok) bump("loss.storeWriteFailed");
    return written.ok;
  }

  function settleFailed(record, reason, boot = false) {
    bump("loss.settleFailed");
    if (reason === "HULL_IN_USE") bump("loss.hullInUse");
    const attempts = (Number(record.settleAttempts) || 0) + 1;
    const stuck = attempts >= config.lossSettleMaxAttempts;
    const nowMs = clock.now();
    persistPending({ ...record, settleAttempts: attempts,
      nextSettleAtMs: stuck ? NEVER_MS : nowMs + config.lossSettleRetryMs * attempts });
    if (stuck && (boot || record.nextSettleAtMs !== NEVER_MS)) {
      bump("loss.settleStuck");
      log.log(`LOSS NOT SETTLED${boot ? " at start" : ""}: wing ${record.shipItemId} of character `
        + `${record.ownerCharacterId} - ${reason} after ${attempts} attempt(s); the ship stays locked, next try at `
        + "the next server start");
    }
    return refusal(reason);
  }

  function sweepLossTwin(shipItemId) {
    const kept = lossTwins.get(shipItemId);
    if (!kept) return { pending: false };
    if (!adapter || value("isSceneLoaded", (recordOf(shipItemId) || {}).sceneKey, kept.scene) !== true) {
      lossTwins.delete(shipItemId);
      return { pending: false };
    }
    const looked = twinLookup(kept.scene, kept.twinEntityId);
    if (!looked.unknown && !looked.present) {
      lossTwins.delete(shipItemId);
      return { pending: false };
    }
    const removed = call("remove", kept.scene, kept.twinEntityId, clock.now());
    if ((removed.ok && removed.value === true) || !twinLookup(kept.scene, kept.twinEntityId).present) {
      lossTwins.delete(shipItemId);
      bump("loss.strayRemoved");
      log.log(`wing ${shipItemId}: the destroyed twin ${kept.twinEntityId} stayed in space after a failed `
        + "destruction - removed (no wreck, no killmail)");
      return { pending: false };
    }
    bump("loss.strayRetry");
    return { pending: true };
  }

  function settleLoss(shipItemId, opts = {}) {
    const record = recordOf(shipItemId);
    if (!record || record.state !== "LOST") return refusal("NOT_LOST");
    const wreckId = opts && posInt(opts.wreckId) ? opts.wreckId : record.wreckId || 0;
    const current = wreckId === record.wreckId ? record : { ...record, wreckId };
    const boot = Boolean(opts && opts.boot === true);
    if (!adapter) return settleFailed(current, "NO_ADAPTER", boot);
    const settled = call("settleShipLoss", { shipItemId, ownerCharacterId: record.ownerCharacterId, wreckId });
    const result = settled.ok ? settled.value : null;
    if (!result || result.ok !== true) {
      return settleFailed(current, result && result.reason === "HULL_IN_USE" ? "HULL_IN_USE" : "SETTLE_FAILED", boot);
    }
    const outcome = SETTLE_OUTCOME.includes(result.outcome) ? result.outcome : "HULL_DESTROYED";
    const next = step(current, "SETTLED", { settleOutcome: outcome, settledAtMs: clock.now() });
    if (!next.ok) return refusal("NOT_LOST");
    persistPending(next.next);
    unindex(shipItemId, record.ownerCharacterId);
    bump(`loss.settled.${outcome}`);
    if (outcome === "OWNER_CHANGED") {
      log.log(`wing ${shipItemId}: loss settled WITHOUT destroying the ship - it belongs to someone else now `
        + `(was character ${record.ownerCharacterId}); check by hand`);
    }
    const vendorChanges = opts && Array.isArray(opts.vendorChanges) ? opts.vendorChanges : [];
    emitToOwner(record.ownerCharacterId, [...vendorChanges, ...(Array.isArray(result.changes) ? result.changes : [])]);
    notify(record.ownerCharacterId);
    return { ok: true, outcome };
  }

  function purge(record) {
    const removed = store.remove(record.shipItemId);
    if (!removed.ok) bump("loss.storeWriteFailed");
    pending.delete(record.shipItemId);
    bump("loss.purged");
  }

  function settlePending() {
    const out = { settled: 0, purged: 0, failed: 0 };
    if (stopped || !adapter) return out;
    for (const [shipItemId, record] of [...pending.entries()]) {
      try {
        if (record.state === "LOST") {
          if (settleLoss(shipItemId, { boot: true }).ok) out.settled += 1;
          else out.failed += 1;
          continue;
        }
        const checked = call("settleShipLoss", { shipItemId, ownerCharacterId: record.ownerCharacterId, wreckId: 0 });
        if (checked.ok && checked.value && checked.value.ok === true) {
          purge(record);
          out.purged += 1;
        } else {
          out.failed += 1;
          log.log(`LOSS RECHECK FAILED at start: wing ${shipItemId} of character ${record.ownerCharacterId} - `
            + `${(checked.value && checked.value.reason) || "SETTLE_FAILED"}; the record is kept, checked again at the `
            + "next server start");
        }
      } catch (err) {
        out.failed += 1;
        log.log(`LOSS NOT SETTLED at start: wing ${shipItemId} - ${(err && err.message) || err}`);
      }
    }
    return out;
  }

  function tickPending(nowMs) {
    for (const [shipItemId, record] of [...pending.entries()]) {
      try {
        if (record.state === "LOST" && lossTwins.has(shipItemId)) continue;
        if (record.state === "LOST" && nowMs >= record.nextSettleAtMs) settleLoss(shipItemId);
        else if (record.state === "SETTLED" && nowMs - record.settledAtMs >= config.lossRecordRetentionMs) {
          purge(record);
        }
      } catch (err) {
        bump("tick.error");
        log.debug(`loss tick of wing ${shipItemId} threw - ${(err && err.message) || err}`);
      }
    }
  }

  function twinMissing(record, runtime, nowMs) {
    if (config.lossOnMissingTwin !== true) return endRecord(record, runtime, "TWIN_GONE", "FORCED_END", nowMs);
    if (beginLoss(record.shipItemId, { cause: "MISSING" }).ok) settleLoss(record.shipItemId);
    return false;
  }

  function stepTask(record, runtime, checked, nowMs) {
    runtime.leashAnchorId = null;
    try {
      const formation = FORMATION_ON && formationOf(record.ownerCharacterId) !== NO_FORMATION;
      const out = tasks.step(record, runtime, { twin: checked.twin, host: checked.host, nowMs, scene: runtime.scene,
        record, formation, formationSlot: formation ? () => formationSlot(record, checked) : null });
      if (out && Number.isSafeInteger(out.leashAnchorId) && out.leashAnchorId > 0) {
        runtime.leashAnchorId = out.leashAnchorId;
      }
      return Boolean(out && out.controlsMovement === true);
    } catch (err) {
      bump("tick.error");
      log.debug(`task step of wing ${record.shipItemId} threw - ${(err && err.message) || err}`);
      return false;
    }
  }

  function tickRecord(shipItemId, runtime, nowMs) {
    const record = store.get(shipItemId);
    if (record && record.state === "LAUNCHING" && runtime.aborted === true) {
      const reason = value("isSceneLoaded", record.sceneKey, runtime.scene) === true ? "LAUNCH_ABORTED" : "SCENE_GONE";
      return endRecord({ ...record, twinEntityId: runtime.twinEntityId }, runtime, reason, "FORCED_END", nowMs);
    }
    if (!record || (record.state !== "ACTIVE" && record.state !== "RETURNING")) {
      forgetTwin(shipItemId);
      return false;
    }
    if (runtime.pendingEnd) return endRecord(record, runtime, runtime.pendingEnd, "FORCED_END", nowMs);
    const checked = forcedReason(record, runtime, nowMs);
    if (checked.reason) {
      const wasActive = record.state === "ACTIVE";
      const ended = endRecord(record, runtime, checked.reason, "FORCED_END", nowMs);
      if (ended && wasActive) noteRelaunch(record, checked.reason, nowMs);
      return ended;
    }
    if (checked.unknown) return false;
    if (checked.lost) return twinMissing(record, runtime, nowMs);
    if (record.state === "RETURNING") {
      if (checked.distance <= config.recallRangeMeters) {
        return endRecord(record, runtime, "RECALL_DONE", "RECALL_DONE", nowMs);
      }
      if (nowMs - record.stateChangedAtMs >= config.recallTimeoutMs) {
        return endRecord(record, runtime, "RECALL_TIMEOUT", "RECALL_TIMEOUT", nowMs);
      }
    }
    if (record.state === "ACTIVE" && stepTask(record, runtime, checked, nowMs)) {
      runtime.formationPoint = null;
      return false;
    }
    if (record.state === "ACTIVE" && formationStep(record, runtime, checked, nowMs)) return false;
    const range = record.state === "RETURNING" ? 0 : config.followRangeMeters;
    if (range !== runtime.followRange || nowMs - runtime.lastFollowAtMs >= config.followRetuneMs) {
      call("follow", runtime.scene, checked.twin, record.hostShipId, range);
      runtime.followRange = range;
      runtime.lastFollowAtMs = nowMs;
    }
    return false;
  }

  function noteRelaunch(record, reason, nowMs) {
    if (!RELAUNCH_ON || !RELAUNCH_REASONS.includes(reason)) return;
    const charId = record.ownerCharacterId;
    if (formationOf(charId) === NO_FORMATION) return;
    let entry = relaunch.get(charId);
    if (!entry || entry.hostShipId !== record.hostShipId) {
      relaunchSeq += 1;
      entry = { hostShipId: record.hostShipId, ships: [], reason, sinceMs: nowMs, commandId: `relaunch-${relaunchSeq}`,
        lastAtMs: 0 };
      relaunch.set(charId, entry);
    }
    entry.reason = reason;
    if (!entry.ships.some((s) => s.shipItemId === record.shipItemId)) {
      entry.ships.push({ shipItemId: record.shipItemId, at: Number(record.launchedAtMs) || 0 });
      entry.ships.sort((a, b) => (a.at - b.at) || (a.shipItemId - b.shipItemId));
    }
    bump("formation.relaunch.noted");
  }

  function dropRelaunch(charId, counter) {
    relaunch.delete(charId);
    bump(`formation.relaunch.${counter}`);
  }

  function relaunchPilot(charId, entry, nowMs, budget) {
    if (nowMs - entry.sinceMs >= config.formationRelaunchTimeoutMs) {
      log.debug(`relaunch of character ${charId} dropped after ${config.formationRelaunchTimeoutMs} ms `
        + `(${entry.ships.length} ship(s), ${entry.reason})`);
      dropRelaunch(charId, "timeout");
      return 0;
    }
    if (formationOf(charId) === NO_FORMATION) {
      dropRelaunch(charId, "dropped.FORMATION_NONE");
      return 0;
    }
    const activeShipId = typeof adapter.activeShipId === "function" ? value("activeShipId", charId) : 0;
    if (posInt(activeShipId) && activeShipId !== entry.hostShipId) {
      dropRelaunch(charId, "dropped.HOST_CHANGED");
      return 0;
    }
    const session = value("findSession", charId);
    if (!session) {
      dropRelaunch(charId, "dropped.LOGOFF");
      return 0;
    }
    if (dockedAt(session) > 0) {
      dropRelaunch(charId, "dropped.DOCKED");
      return 0;
    }
    const ctx = ownerContext(charId);
    if (ctx.refusal) {
      const docking = ctx.refusal === "OWNER_WARPING" && ctx.host
        && (value("hostStatus", ctx.scene, ctx.host) || {}).docking === true;
      if (docking) dropRelaunch(charId, "dropped.DOCKED");
      else if (RELAUNCH_WAIT.includes(ctx.refusal)) bump("formation.relaunch.wait");
      else dropRelaunch(charId, `dropped.${ctx.refusal}`);
      return 0;
    }
    if (ctx.space.shipId !== entry.hostShipId) {
      dropRelaunch(charId, "dropped.HOST_CHANGED");
      return 0;
    }
    const status = value("hostStatus", ctx.scene, ctx.host) || {};
    if (status.cloaked === true) {
      bump("formation.relaunch.waitCloak");
      return 0;
    }
    let calls = 0;
    while (entry.ships.length > 0 && calls < budget) {
      const { shipItemId } = entry.ships[0];
      calls += 1;
      const out = launch(charId, shipItemId, { commandId: entry.commandId, source: "relaunch",
        minLaunchedAtMs: entry.lastAtMs + 1 });
      if (out.ok) {
        entry.ships.shift();
        const written = store.get(shipItemId);
        entry.lastAtMs = written ? Number(written.launchedAtMs) || entry.lastAtMs : entry.lastAtMs;
        bump("formation.relaunch.launched");
        continue;
      }
      if (RELAUNCH_HOLD.includes(out.reason)) {
        bump("formation.relaunch.wait");
        break;
      }
      entry.ships.shift();
      bump(`formation.relaunch.dropped.${out.reason}`);
      if (RELAUNCH_STOP.includes(out.reason)) break;
    }
    if (entry.ships.length === 0) relaunch.delete(charId);
    return calls;
  }

  function tickRelaunch(nowMs) {
    if (relaunch.size === 0) return;
    let budget = config.formationRelaunchPerTick;
    for (const [charId, entry] of [...relaunch.entries()]) {
      if (budget <= 0) break;
      try {
        budget -= relaunchPilot(charId, entry, nowMs, budget);
      } catch (err) {
        bump("tick.error");
        log.debug(`relaunch of character ${charId} threw - ${(err && err.message) || err}`);
      }
    }
  }

  function pruneCooldowns() {
    if (lastLaunch.size === 0) return;
    const nowMs = clock.now();
    for (const [charId, last] of lastLaunch) {
      if (nowMs - last.atMs >= cooldownMs()) lastLaunch.delete(charId);
    }
  }

  function tick(nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : clock.now();
    const started = hrNow();
    let processed = 0;
    let ended = 0;
    if (stopped || !adapter) return { processed, ended };
    formationCache.clear();
    for (const [shipItemId, runtime] of [...live.entries()]) {
      processed += 1;
      try {
        if (tickRecord(shipItemId, runtime, now)) ended += 1;
      } catch (err) {
        bump("tick.error");
        log.debug(`tick of wing ${shipItemId} threw - ${(err && err.message) || err}`);
      }
    }
    tickRelaunch(now);
    for (const shipItemId of [...lossTwins.keys()]) {
      try {
        sweepLossTwin(shipItemId);
      } catch (err) {
        bump("tick.error");
        log.debug(`loss twin sweep of wing ${shipItemId} threw - ${(err && err.message) || err}`);
      }
    }
    if (pending.size > 0) tickPending(now);
    pruneCooldowns();
    pruneBoardCooldowns(now);
    flushFormations();
    const tookMs = hrNow() - started;
    if (tookMs > counters["tick.maxMs"]) counters["tick.maxMs"] = tookMs;
    if (tookMs > config.tickBudgetMs) bump("tick.overBudget");
    return { processed, ended };
  }

  function flushFormations() {
    if (!formations || typeof formations.isDirty !== "function") return;
    try {
      if (formations.isDirty()) formations.flush();
    } catch (err) {
      bump("tick.error");
      log.debug(`formation store flush threw - ${(err && err.message) || err}`);
    }
  }

  function bootSweep() {
    const swept = store.bootSweep();
    try {
      tasks.dropAll("RESTART");
    } catch (err) {
      log.debug(`task drop at restart threw - ${(err && err.message) || err}`);
    }
    live.clear();
    relaunch.clear();
    lossTwins.clear();
    rebuildIndex();
    return { ok: swept.ok, cleared: swept.cleared, keptLost: swept.keptLost, reason: swept.reason };
  }

  function onWingChanged(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  function stats() {
    let taskStats = { tasks: 0, counters: {} };
    try {
      taskStats = tasks.stats();
    } catch (_err) {
    }
    let formationCounters = {};
    try {
      formationCounters = formations && typeof formations.stats === "function" ? formations.stats().counters || {} : {};
    } catch (_err) {
    }
    return { records: blocked.size, live: live.size, listeners: listeners.size, storeReadOnly: store.isReadOnly(),
      pending: pending.size, tasks: taskStats.tasks, cooldowns: lastLaunch.size,
      relaunchPending: relaunch.size,
      counters: { ...counters, ...taskStats.counters, ...formationCounters } };
  }

  function twinOf(entityOrId) {
    if (stopped || byTwin.size === 0) return null;
    const isEntity = entityOrId !== null && typeof entityOrId === "object";
    const twinEntityId = Number(isEntity ? entityOrId.itemID : entityOrId);
    if (!posInt(twinEntityId)) return null;
    const shipItemId = byTwin.get(twinEntityId);
    if (shipItemId === undefined) return null;
    const record = store.get(shipItemId);
    if (!record) return null;
    if (isEntity && entityOrId.pilotCharacterID !== undefined
      && Number(entityOrId.pilotCharacterID) !== record.ownerCharacterId) {
      return null;
    }
    return { shipItemId, ownerCharacterId: record.ownerCharacterId, twinEntityId };
  }

  function derivedTwinCount() {
    return stopped ? 0 : byTwin.size + lossTwins.size;
  }

  function derivedTwinOf(entityOrId) {
    const twin = twinOf(entityOrId);
    if (twin || stopped || lossTwins.size === 0) return twin;
    const isEntity = entityOrId !== null && typeof entityOrId === "object";
    const twinEntityId = Number(isEntity ? entityOrId.itemID : entityOrId);
    if (!posInt(twinEntityId)) return null;
    for (const [shipItemId, kept] of lossTwins) {
      if (kept.twinEntityId !== twinEntityId) continue;
      const record = recordOf(shipItemId);
      if (!record) return null;
      if (isEntity && entityOrId.pilotCharacterID !== undefined
        && Number(entityOrId.pilotCharacterID) !== record.ownerCharacterId) {
        return null;
      }
      return { shipItemId, ownerCharacterId: record.ownerCharacterId, twinEntityId };
    }
    return null;
  }

  function twinTaskContext(entity) {
    const twin = twinOf(entity);
    return twin ? tasks.context(twin.shipItemId) : null;
  }

  function noteDerivedGuard(kind, err) {
    if (kind === "skipped") {
      bump("guard.derivedSkipped");
      return;
    }
    bump("guard.derivedError");
    log.debug(`derived-state guard failed - ${(err && err.message) || err}`);
  }

  function noteLossHookError(err) {
    bump("loss.hookError");
    log.debug(`loss hook failed - ${(err && err.message) || err}`);
  }

  function stop() {
    stopped = true;
    if (typeof tasks.releaseEffects === "function") {
      try {
        tasks.releaseEffects((id) => {
          const runtime = live.get(id);
          return runtime && runtime.scene ? runtime.scene : null;
        });
      } catch (err) {
        log.debug(`effect release at stop threw - ${(err && err.message) || err}`);
      }
    }
    listeners.clear();
    relaunch.clear();
    boardCooldownUntil.clear();
    cargoStore.clear();
    lastCargoMove.clear();
  }

  rebuildIndex();

  return {
    SUPPORTED_VERBS,
    dronesOn: DRONES_ON,
    orderCopy,
    setDroneMode,
    setMirrorEngage,
    cargoStoreOn: config.miningRealCargoEnabled === true && config.miningRealCargoStoreEnabled === true,
    setCargoStore,
    cargoStoreOf,
    cargoOn: CARGO_ON,
    cargoOf,
    moveCargo,
    formationOn: FORMATION_ON,
    setFormation,
    formationOf,
    flushFormations,
    FORMATIONS,
    listWing,
    onWingChanged,
    isBlocked: (itemId) => blocked.has(itemId),
    hasLossRecord: (itemId) => pending.has(Number(itemId)),
    blockedCount: () => blocked.size,
    ownsBlocked: (charId) => {
      const set = byOwner.get(Number(charId));
      return Boolean(set && set.size > 0);
    },
    deployedCount: (charId) => flyingCount(Number(charId)),
    activeTwinsOf,
    tick,
    bootSweep,
    stats,
    stop,
    liveTwinCount,
    claimTwin,
    boardOwnerOf,
    releaseForBoard,
    beginLoss,
    settleLoss,
    settlePending,
    sweepLossTwin,
    takeLossTwin,
    noteLossHookError,
    twinOf,
    derivedTwinCount,
    derivedTwinOf,
    twinTaskContext,
    noteDerivedGuard,
  };
}

module.exports = { COUNTER_NAMES, VERB_FLAGS, enabledVerbs, hpPermille, orphanState, createWingService };
