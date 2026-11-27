"use strict";

const { characterIdOf } = require("./vendor");
const { createGuardErrorReporter } = require("./guards");

const BOARD_HOOKED = Symbol.for("shipWing.boardHook");
const HANDLER = "Handle_Board";
const SCOOP_HOOKED = Symbol.for("shipWing.scoopHook");
const SCOOP_HANDLER = "Handle_ScoopToSMA";
const SCOOP_REFUSED_TEXT = "That wing copy cannot return now.";
const SCOOP_RETURNING_TEXT = "That wing copy is already returning.";
const STOW_TOO_FAR = "TARGET_TOO_FAR";
const DIGITS = /^[0-9]{1,20}$/;
const VENDOR_LAUNCH_OFFSET_METERS = 275;
const VENDOR_MIN_OFFSET_METERS = 50;
const SCOPE_FIELD_RE = /^(abyssal|evejsAbyssal|airNpe)/;
const SCOPE_FLAGS = Object.freeze(["entityInteractionScopeInvalid", "playerCompanionScopeInvalid"]);

const COUNTER_NAMES = Object.freeze([
  "board.ok", "board.launchFailed", "board.vendorFailed", "board.error",
  "board.refused.ABYSSAL", "board.refused.SHIP_DEATH_PENDING",
  "board.refused.CONCORD_PURSUIT", "board.refused.FACTION_POLICE_PURSUIT",
  "board.server",
  "board.ghost.forgotten", "board.ghost.resent", "board.ghost.resendRefused",
  "board.back.stowed", "board.back.tooFar", "board.back.failed",
  "board.back.expired",
  "scoop.return", "scoop.refused", "scoop.ghostCleared", "scoop.error",
  "scoop.alreadyReturning",
  "board.scope.host", "board.scope.hull",
  "board.back.cargo.moved", "board.back.cargo.noRoom", "board.back.cargo.unmovable", "board.back.cargo.tooMany",
  "board.back.cargo.failed", "board.back.cargo.skipped",
]);
const CARGO_STOP = Object.freeze({ NO_ROOM: "board.back.cargo.noRoom", UNMOVABLE: "board.back.cargo.unmovable",
  TOO_MANY: "board.back.cargo.tooMany", MOVE_FAILED: "board.back.cargo.failed" });
const CARGO_EMPTY_IT = "Empty it and use Scoop to Ship Maintenance Bay.";

function m3Text(value) {
  const n = Math.round((Number(value) || 0) * 10) / 10;
  return String(n);
}

function cargoText(kind, result, config) {
  const name = (result && typeof result.name === "string" && result.name !== "") ? result.name : "The ship";
  switch (kind) {
    case "NO_ROOM": return `${name} has cargo that does not fit in this ship's ore hold and fleet hangar `
      + `(needs ${m3Text(result.neededM3)} m3, free ${m3Text(result.freeM3)} m3). ${CARGO_EMPTY_IT}`;
    case "UNMOVABLE": return `${name} has cargo that cannot be moved automatically. ${CARGO_EMPTY_IT}`;
    case "TOO_MANY": return `${name} has too many cargo stacks to move automatically `
      + `(max ${Number(config && config.boardBackCargoMaxStacks) || 0}). ${CARGO_EMPTY_IT}`;
    case "MOVE_FAILED": return `Part of the cargo of ${name} could not be moved. ${CARGO_EMPTY_IT}`;
    case "STORED": return `Moved ${m3Text(result.movedM3)} m3 of cargo from ${name} into this ship and stored `
      + `${name} in the maintenance bay.`;
    default: return `Moved ${m3Text(result.movedM3)} m3 of cargo from ${name} into this ship; ${name} stays in `
      + "space - use Scoop to Ship Maintenance Bay.";
  }
}
const SCOPE_PROBE_TWIN = Object.freeze({ position: Object.freeze({ x: 0, y: 0, z: 0 }),
  direction: Object.freeze({ x: 1, y: 0, z: 0 }) });
const SERVER_BOARD_FAILURE = Object.freeze(["LAUNCH_FAILED", "BOARD_FAILED", "BOARD_ERROR"]);

const LAUNCH_FAILED_TEXT = "The copy's ship could not be launched - it is back in the maintenance bay.";
const BOARD_FAILED_TEXT = "The copy's ship is in space next to you, but boarding it failed - board it from space.";
const NOT_AVAILABLE_TEXT = "That wing copy is not available to board.";
const FROM_HOST_TEXT = "Board the copy from the ship that launched it.";

function refusalText(reason, config) {
  switch (reason) {
    case "NOT_OWNER": return "That wing copy belongs to another pilot.";
    case "TWIN_DYING": return "That wing copy is being destroyed.";
    case "TOO_FAR": return "You are too far away from the wing copy to board it "
      + `(max ${(config && config.boardRangeMeters) || 0} m).`;
    case "HOST_CHANGED": case "NOT_IN_SPACE": case "SCENE_NOT_LOADED": return FROM_HOST_TEXT;
    case "OWNER_WARPING": return "You cannot board a wing copy while warping or docking.";
    case "MISSING_SKILLS": return "You do not have the skills to fly that ship.";
    case "NOT_IN_SMB": return "That ship is no longer in the maintenance bay.";
    case "COOLDOWN": return "Wait a moment before boarding again.";
    case "HOST_TOO_FAR": return `Move within ${(config && config.boardHostRangeMeters) || 0} m `
      + "of the ship that launched the copy.";
    case "HOST_GONE": return "The ship that launched the copy is gone.";
    case "ABYSSAL": return "You cannot eject, board, launch, or store ships inside Abyssal Deadspace.";
    case "SHIP_DEATH_PENDING": return "The ship is being destroyed.";
    case "CONCORD_PURSUIT": return "You cannot board another ship while CONCORD is pursuing you.";
    case "FACTION_POLICE_PURSUIT": return "You cannot board another ship while faction police are pursuing you.";
    case "SCOPE_INVALID": return "The copy's ship cannot be launched here - move away from this site and try again.";
    default: return NOT_AVAILABLE_TEXT;
  }
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function toId(value) {
  let n = null;
  if (typeof value === "number") n = Number.isFinite(value) ? Math.trunc(value) : null;
  else if (typeof value === "bigint") n = Number(value);
  else if (typeof value === "string" && DIGITS.test(value)) n = Number(value);
  return n !== null && Number.isSafeInteger(n) && n > 0 ? n : null;
}

function finiteVec(v) {
  return isObj(v) && Number.isFinite(Number(v.x)) && Number.isFinite(Number(v.y)) && Number.isFinite(Number(v.z));
}

function unit(v) {
  if (!finiteVec(v)) return { x: 1, y: 0, z: 0 };
  const x = Number(v.x);
  const y = Number(v.y);
  const z = Number(v.z);
  const length = Math.sqrt(x * x + y * y + z * z);
  if (!Number.isFinite(length) || length <= 0) return { x: 1, y: 0, z: 0 };
  return { x: x / length, y: y / length, z: z / length };
}

function boardAnchor(host, twin, offsetM = VENDOR_LAUNCH_OFFSET_METERS) {
  if (!isObj(twin) || !finiteVec(twin.position)) return null;
  const anchor = {};
  if (isObj(host)) {
    for (const name of Object.keys(host)) if (SCOPE_FIELD_RE.test(name)) anchor[name] = host[name];
    for (const name of SCOPE_FLAGS) if (host[name] !== undefined) anchor[name] = host[name];
    if (host.kind !== undefined) anchor.kind = host.kind;
    if (isObj(host.spaceState)) {
      const state = {};
      for (const name of Object.keys(host.spaceState)) {
        if (SCOPE_FIELD_RE.test(name)) state[name] = host.spaceState[name];
      }
      if (Object.keys(state).length > 0) anchor.spaceState = state;
    }
    if (host.systemID !== undefined) anchor.systemID = host.systemID;
  }
  const dir = unit(twin.direction);
  const offset = Math.max(VENDOR_MIN_OFFSET_METERS, Math.max(VENDOR_MIN_OFFSET_METERS, Number(offsetM) || 0));
  anchor.radius = 0;
  anchor.direction = dir;
  anchor.position = {
    x: Number(twin.position.x) - dir.x * offset,
    y: Number(twin.position.y) - dir.y * offset,
    z: Number(twin.position.z) - dir.z * offset,
  };
  return anchor;
}

function boardSteps(deps) {
  const { wing, adapter, counters } = deps;
  const config = isObj(deps.config) ? deps.config : {};
  const log = deps.log && typeof deps.log.log === "function" ? deps.log : { log() {} };
  const onError = typeof deps.onError === "function" ? deps.onError : () => {};
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const boardedOut = deps.boardedOut instanceof Map ? deps.boardedOut : new Map();
  const state = isObj(deps.state) ? deps.state : { stopped: false };
  const bump = (name) => {
    counters[name] = (counters[name] || 0) + 1;
  };
  const lastLogAt = new Map();
  function logThrottled(key, text) {
    try {
      const t = now();
      const last = lastLogAt.get(key);
      if (last !== undefined && t - last < (Number(config.guardErrorLogIntervalMs) || 0)) return;
      lastLogAt.set(key, t);
      log.log(text);
    } catch (_err) {
    }
  }
  const ghostTools = () => ["sceneOf", "entity", "knownBubbleOf", "resendRemoveBalls"]
    .every((k) => typeof adapter[k] === "function");

  function ghostPre(session) {
    try {
      if (!ghostTools()) return null;
      const scene = adapter.sceneOf(session);
      if (!scene) return null;
      const known = adapter.knownBubbleOf(scene, session);
      return { scene, known: known === undefined ? null : known };
    } catch (_err) {
      return null;
    }
  }

  function sweepGhosts(pre, session, ids) {
    try {
      if (!pre || !ghostTools()) return "SKIPPED";
      if (adapter.sceneOf(session) !== pre.scene) return "SKIPPED";
      const forgotten = pre.known !== null && adapter.knownBubbleOf(pre.scene, session) === null;
      if (forgotten) bump("board.ghost.forgotten");
      if (config.boardResendRemoval !== true) return "SKIPPED";
      const gone = (Array.isArray(ids) ? ids : []).map(toId)
        .filter((id) => id !== null && !adapter.entity(pre.scene, id));
      if (!forgotten || gone.length === 0) return "CLEAN";
      if (adapter.resendRemoveBalls(pre.scene, session, gone) === true) {
        bump("board.ghost.resent");
        return "RESENT";
      }
      bump("board.ghost.resendRefused");
      return "FORGOTTEN_NOT_RESENT";
    } catch (err) {
      onError(err);
      return "SKIPPED";
    }
  }

  function releasedIds(released) {
    return [released.twinEntityId, ...(Array.isArray(released.droneIds) ? released.droneIds : [])];
  }

  function expired(entry, t) {
    const maxAge = Number(config.boardBackStowMaxAgeMs) || 0;
    return maxAge > 0 && t - entry.atMs > maxAge;
  }

  function noteBoarded(charId, released) {
    if (!state.stopped && toId(charId) !== null) {
      const t = now();
      for (const [id, entry] of boardedOut) {
        if (expired(entry, t)) {
          boardedOut.delete(id);
          bump("board.back.expired");
        }
      }
      boardedOut.set(charId, { shipItemId: released.shipItemId, hostShipId: released.hostShipId, atMs: t });
    }
  }

  function activeOf(charId) {
    try {
      return typeof adapter.activeShipId === "function" ? Number(adapter.activeShipId(charId)) || 0 : 0;
    } catch (_err) {
      return 0;
    }
  }

  function hostCheck(host) {
    if (typeof adapter.launchScopeRefusal !== "function") return null;
    try {
      const part = adapter.launchScopeRefusal(host, boardAnchor(host, SCOPE_PROBE_TWIN));
      if (part !== "HOST" && part !== "HULL") return null;
      bump(part === "HOST" ? "board.scope.host" : "board.scope.hull");
      logThrottled(`scope:${part}`, `board: the launch scope of host ${toId(host && host.itemID)} is invalid `
        + `(${part}) - refused before the end, the copy stays`);
      return "SCOPE_INVALID";
    } catch (err) {
      onError(err);
      return null;
    }
  }

  function release(id, session, charId) {
    const vendorRefusal = adapter.boardVendorRefusal(session);
    if (vendorRefusal) {
      bump(`board.refused.${vendorRefusal}`);
      return { refused: vendorRefusal };
    }
    const pre = ghostPre(session);
    const released = wing.releaseForBoard(charId, id, { hostCheck });
    if (!released || released.ok !== true) return { refused: (released && released.reason) || "NOT_DEPLOYED" };
    return { released, charId, pre };
  }

  function decide(args, session) {
    const id = toId(Array.isArray(args) ? args[0] : null);
    if (id === null || !wing.boardOwnerOf(id)) return { pass: true };
    return release(id, session, characterIdOf(session));
  }

  function launch(session, released) {
    let host;
    try {
      const scene = adapter.sceneOf(session);
      host = scene ? adapter.hostEntity(scene, released.hostShipId) : null;
    } catch (err) {
      bump("board.launchFailed");
      log.log(`board of wing ${released.shipItemId}: host of the bay ${released.hostShipId} not read - `
        + `${String((err && err.message) || err).slice(0, 200)}; the ship stays in the bay`);
      return { ok: false };
    }
    const anchor = boardAnchor(host, released.twin);
    if (anchor && anchor.systemID === undefined) anchor.systemID = released.systemId;
    let launched;
    try {
      launched = adapter.launchFromBay(session, released.hostShipId, released.shipItemId, anchor);
    } catch (err) {
      bump("board.launchFailed");
      log.log(`board of wing ${released.shipItemId}: launch threw - `
        + `${String((err && err.message) || err).slice(0, 200)}`);
      return { ok: false, threw: true, err };
    }
    if (!launched || launched.ok !== true) {
      bump("board.launchFailed");
      log.log(`board of wing ${released.shipItemId}: launch from the bay of ${released.hostShipId} failed `
        + `(${(launched && launched.reason) || "unknown"}) - the ship stays in the bay`);
      return { ok: false };
    }
    return { ok: true };
  }

  function backPlan(args, session) {
    try {
      if (state.stopped || boardedOut.size === 0) return null;
      const charId = characterIdOf(session);
      const entry = charId ? boardedOut.get(charId) : undefined;
      if (!entry) return null;
      if (expired(entry, now())) {
        boardedOut.delete(charId);
        bump("board.back.expired");
        return null;
      }
      const target = toId(Array.isArray(args) ? args[0] : null);
      if (target === entry.hostShipId && activeOf(charId) === entry.shipItemId) return { charId, entry };
      boardedOut.delete(charId);
      return null;
    } catch (err) {
      bump("board.error");
      onError(err);
      return null;
    }
  }

  function notify(session, text) {
    try {
      if (typeof adapter.customNotify === "function") adapter.customNotify(session, text);
    } catch (err) {
      onError(err);
    }
  }

  function unloadCargo(entry, charId, session) {
    const stowCargo = deps.stowCargo;
    if (config.boardBackCargoUnloadEnabled !== true || !isObj(stowCargo)
      || typeof stowCargo.unloadForStow !== "function") return null;
    let u;
    try {
      const args = { ownerCharacterId: charId, hostShipId: entry.hostShipId, shipItemId: entry.shipItemId,
        maxStacks: Number(config.boardBackCargoMaxStacks) || 1 };
      if (isObj(deps.wing) && typeof deps.wing.hasLossRecord === "function") {
        args.isLocked = (id) => deps.wing.hasLossRecord(id) === true;
      }
      u = stowCargo.unloadForStow(args);
    } catch (err) {
      bump("board.back.cargo.skipped");
      onError(err);
      return null;
    }
    if (isObj(u) && u.ok === true) {
      if (!(Number(u.movedStacks) > 0)) return null;
      bump("board.back.cargo.moved");
      return u;
    }
    const reason = isObj(u) ? u.reason : undefined;
    if (Object.prototype.hasOwnProperty.call(CARGO_STOP, reason)) {
      bump(CARGO_STOP[reason]);
      notify(session, cargoText(reason, u, config));
      const detail = u.detail ? `:${String(u.detail).slice(0, 100)}` : "";
      logThrottled(`backCargo:${reason}`, `board back on ${entry.hostShipId}: ship ${entry.shipItemId} has cargo the `
        + `bay refuses (${reason}${detail}) - not stowed, it stays in space`);
      return "STOP";
    }
    bump("board.back.cargo.skipped");
    return null;
  }

  function stowBack(back, pre, session) {
    const { charId, entry } = back;
    try {
      if (config.boardBackStowEnabled !== true || typeof adapter.stowToActiveBay !== "function") {
        boardedOut.delete(charId);
        return;
      }
      if (activeOf(charId) !== entry.hostShipId) return;
      boardedOut.delete(charId);
      const unloaded = unloadCargo(entry, charId, session);
      if (unloaded === "STOP") return;
      let stowed;
      try {
        stowed = adapter.stowToActiveBay(session, entry.shipItemId);
      } catch (err) {
        stowed = { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
      }
      if (stowed && stowed.ok === true) {
        bump("board.back.stowed");
        sweepGhosts(pre, session, [entry.shipItemId]);
        if (unloaded) notify(session, cargoText("STORED", unloaded, config));
        return;
      }
      const reason = (stowed && stowed.reason) || "unknown";
      bump(reason === STOW_TOO_FAR ? "board.back.tooFar" : "board.back.failed");
      logThrottled(`back:${reason}`, `board back on ${entry.hostShipId}: ship ${entry.shipItemId} not stowed `
        + `(${reason}) - it stays in space for the native Scoop`);
      if (unloaded) notify(session, cargoText("STAYS", unloaded, config));
    } catch (err) {
      bump("board.back.failed");
      onError(err);
    }
  }
  return { log, onError, bump, release, decide, launch, ghostPre, sweepGhosts, releasedIds, noteBoarded, backPlan,
    stowBack, logThrottled, state };
}

function wrapBoardHandler(original, deps) {
  const { adapter, config } = deps;
  const { log, onError, bump, decide, launch, ghostPre, sweepGhosts, releasedIds, noteBoarded, backPlan, stowBack } =
    boardSteps(deps);
  function refuseWith(reason) {
    const text = refusalText(reason, config);
    deps.refuse(text);
    throw new Error(text);
  }

  function shipWingBoard(args, session, kwargs) {
    let plan;
    try {
      plan = decide(args, session);
    } catch (err) {
      bump("board.error");
      onError(err);
      plan = { pass: true };
    }
    if (plan.pass) {
      const back = backPlan(args, session);
      if (!back) return original.apply(this, arguments);
      const backPre = ghostPre(session);
      const backResult = original.apply(this, arguments);
      stowBack(back, backPre, session);
      return backResult;
    }
    if (plan.refused) return refuseWith(plan.refused);

    const { released, charId, pre } = plan;
    const launched = launch(session, released);
    if (!launched.ok) {
      if (launched.threw === true) throw launched.err;
      deps.refuse(LAUNCH_FAILED_TEXT);
      throw new Error(LAUNCH_FAILED_TEXT);
    }

    const rest = Array.isArray(args) ? args.slice(1) : [];
    let result;
    try {
      result = original.call(this, [released.shipItemId, ...rest], session, kwargs);
    } catch (err) {
      bump("board.vendorFailed");
      log.log(`board of wing ${released.shipItemId}: vendor board refused - `
        + `${String((err && err.message) || err).slice(0, 200)}; the ship stays empty in space`);
      throw err;
    } finally {
      sweepGhosts(pre, session, releasedIds(released));
    }
    let active = 0;
    if (result === null || result === undefined) {
      try {
        active = typeof adapter.activeShipId === "function" ? Number(adapter.activeShipId(charId)) || 0 : 0;
      } catch (_err) {
        active = 0;
      }
    }
    if ((result === null || result === undefined) && active !== released.shipItemId) {
      bump("board.vendorFailed");
      log.log(`board of wing ${released.shipItemId}: vendor board returned nothing - the ship stays empty in space`);
    } else {
      bump("board.ok");
      noteBoarded(charId, released);
    }
    return result;
  }
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    if (symbol !== BOARD_HOOKED) shipWingBoard[symbol] = original[symbol];
  }
  shipWingBoard[BOARD_HOOKED] = true;
  return shipWingBoard;
}

function createServerBoard(deps) {
  const { adapter, config } = deps;
  const { log, onError, bump, release, launch, sweepGhosts, releasedIds, noteBoarded } = boardSteps(deps);
  const fail = (reason, text) => ({ ok: false, reason, text: text || refusalText(reason, config) });
  return function serverBoard(charId, twinEntityId, sessionIn = null) {
    bump("board.server");
    let plan;
    let session;
    try {
      const id = toId(twinEntityId);
      if (id === null || !deps.wing.boardOwnerOf(id)) return fail("NOT_DEPLOYED");
      session = sessionIn || (typeof adapter.findSession === "function" ? adapter.findSession(charId) : null);
      if (!isObj(session) || characterIdOf(session) !== charId) return fail("NOT_IN_SPACE");
      plan = release(id, session, charId);
    } catch (err) {
      bump("board.error");
      onError(err);
      return fail("BOARD_ERROR", NOT_AVAILABLE_TEXT);
    }
    if (plan.refused) return fail(plan.refused);
    const { released } = plan;
    if (!launch(session, released).ok) return fail("LAUNCH_FAILED", LAUNCH_FAILED_TEXT);
    let boarded;
    try {
      boarded = adapter.boardFromServer(session, released.shipItemId);
    } catch (err) {
      boarded = { ok: false, reason: String((err && err.message) || err).slice(0, 200) };
    }
    sweepGhosts(plan.pre, session, releasedIds(released));
    if (!boarded || boarded.ok !== true) {
      bump("board.vendorFailed");
      log.log(`server board of wing ${released.shipItemId}: vendor board refused `
        + `(${(boarded && boarded.reason) || "unknown"}) - the ship stays empty in space`);
      return fail("BOARD_FAILED", BOARD_FAILED_TEXT);
    }
    bump("board.ok");
    noteBoarded(charId, released);
    return { ok: true, shipItemId: released.shipItemId };
  };
}

function wrapScoopHandler(original, deps) {
  const { wing, adapter } = deps;
  const config = isObj(deps.config) ? deps.config : {};
  const { onError, bump, logThrottled, state } = boardSteps(deps);

  function clearGhost(session, id) {
    try {
      if (config.boardResendRemoval !== true || typeof adapter.resendRemoveBalls !== "function"
        || typeof adapter.entity !== "function" || typeof adapter.sceneOf !== "function") return;
      const scene = adapter.sceneOf(session);
      if (!scene || adapter.entity(scene, id)) return;
      if (adapter.resendRemoveBalls(scene, session, [id]) === true) bump("scoop.ghostCleared");
    } catch (err) {
      bump("scoop.error");
      onError(err);
    }
  }

  function shipWingScoop(args, session, kwargs) {
    void kwargs;
    if (state.stopped) return original.apply(this, arguments);
    let plan;
    try {
      const id = toId(Array.isArray(args) ? args[0] : null);
      const owner = id === null ? null : wing.boardOwnerOf(id);
      const charId = characterIdOf(session);
      if (owner && owner.ownerCharacterId === charId) plan = { owner, charId };
      else plan = { ghostId: owner ? null : id };
    } catch (err) {
      bump("scoop.error");
      onError(err);
      plan = { ghostId: null };
    }
    if (plan.owner && plan.owner.state === "RETURNING") {
      bump("scoop.alreadyReturning");
      deps.refuse(SCOOP_RETURNING_TEXT);
      throw new Error(SCOOP_RETURNING_TEXT);
    }
    if (plan.owner) {
      let ordered;
      try {
        ordered = wing.orderCopy(plan.charId, plan.owner.shipItemId, "return", { source: "scoop" });
      } catch (err) {
        bump("scoop.error");
        onError(err);
        ordered = { ok: false, reason: "ERROR" };
      }
      if (ordered && ordered.ok === true) {
        bump("scoop.return");
        return null;
      }
      bump("scoop.refused");
      const reason = (ordered && ordered.reason) || "unknown";
      logThrottled(`scoop:${reason}`, `scoop of wing ${plan.owner.shipItemId}: return refused (${reason})`);
      deps.refuse(SCOOP_REFUSED_TEXT);
      throw new Error(SCOOP_REFUSED_TEXT);
    }
    if (plan.ghostId !== null) clearGhost(session, plan.ghostId);
    return original.apply(this, arguments);
  }
  for (const symbol of Object.getOwnPropertySymbols(original)) {
    if (symbol !== SCOOP_HOOKED) shipWingScoop[symbol] = original[symbol];
  }
  shipWingScoop[SCOOP_HOOKED] = true;
  return shipWingScoop;
}

function replaceMethod(proto, name, descriptor, wrapped) {
  try {
    if (descriptor.configurable) Object.defineProperty(proto, name, { ...descriptor, value: wrapped });
    else if (descriptor.writable) proto[name] = wrapped;
    else return "not_writable";
  } catch (_err) {
    return "wrap_failed";
  }
  return null;
}

function installBoardHook(ShipService, deps) {
  if (typeof ShipService !== "function" || !isObj(ShipService.prototype)) return { ok: false, reason: "no_class" };
  const src = isObj(deps) ? deps : {};
  if (!src.wing || typeof src.wing.boardOwnerOf !== "function" || typeof src.wing.releaseForBoard !== "function") {
    return { ok: false, reason: "no_wing_service" };
  }
  const a = src.adapter;
  if (!isObj(a) || !["boardVendorRefusal", "launchFromBay", "sceneOf", "hostEntity"]
    .every((k) => typeof a[k] === "function")) {
    return { ok: false, reason: "board_accessors_unavailable" };
  }
  if (typeof src.refuse !== "function") return { ok: false, reason: "no_throwWrappedUserError" };
  const proto = ShipService.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(proto, HANDLER);
  if (!descriptor || typeof descriptor.value !== "function") return { ok: false, reason: "no_handler" };
  if (descriptor.value[BOARD_HOOKED] === true) return { ok: false, reason: "BOARD_ALREADY_INSTALLED" };
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const boardedOut = new Map();
  const state = { stopped: false };
  const shared = { ...src, counters, boardedOut, state };
  const wrapped = wrapBoardHandler(descriptor.value, shared);
  try {
    if (descriptor.configurable) Object.defineProperty(proto, HANDLER, { ...descriptor, value: wrapped });
    else if (descriptor.writable) proto[HANDLER] = wrapped;
    else return { ok: false, reason: "not_writable" };
  } catch (_err) {
    return { ok: false, reason: "wrap_failed" };
  }
  const serverOn = typeof a.boardFromServer === "function" && typeof a.findSession === "function";
  const serverBoard = serverOn ? createServerBoard(shared) : null;
  const cfg = isObj(src.config) ? src.config : {};
  let ghostReason = null;
  if (!["knownBubbleOf", "resendRemoveBalls", "entity"].every((k) => typeof a[k] === "function")) {
    ghostReason = src.ghostReason || "board_ghost_unavailable";
  } else if (cfg.boardResendRemoval !== true) ghostReason = "off";
  let stowReason = null;
  if (typeof a.stowToActiveBay !== "function" || typeof a.activeShipId !== "function") {
    stowReason = src.stowReason || "board_stow_unavailable";
  } else if (cfg.boardBackStowEnabled !== true) stowReason = "off";
  let stowCargoReason = null;
  if (cfg.boardBackCargoUnloadEnabled !== true) stowCargoReason = "off";
  else if (!isObj(src.stowCargo) || typeof src.stowCargo.unloadForStow !== "function") {
    stowCargoReason = src.stowCargoReason || "board_cargo_unavailable";
  }
  let scoopReason = src.scoopReason || null;
  if (scoopReason === null && cfg.scoopReturnEnabled !== true) scoopReason = "off";
  if (scoopReason === null && typeof src.wing.orderCopy !== "function") scoopReason = "no_order_copy";
  if (scoopReason === null) {
    const scoop = Object.getOwnPropertyDescriptor(proto, SCOOP_HANDLER);
    if (!scoop || typeof scoop.value !== "function") scoopReason = "no_handler";
    else if (scoop.value[SCOOP_HOOKED] === true) scoopReason = "SCOOP_ALREADY_INSTALLED";
    else scoopReason = replaceMethod(proto, SCOOP_HANDLER, scoop, wrapScoopHandler(scoop.value, shared));
  }
  return { ok: true, hook: { stats: () => ({ counters: { ...counters } }), serverBoard,
    serverReason: serverOn ? null : (src.serverReason || "board_from_server_unavailable"),
    ghostReason, stowReason, stowCargoReason, scoopReason,
    stop() {
      state.stopped = true;
      boardedOut.clear();
    } } };
}

function installBoardHookFromGame(adapter, wing, config, options = {}) {
  const cfg = config || {};
  if (cfg.boardEnabled !== true) return { ok: false, reason: "off" };
  if (!adapter || typeof adapter.isConsumerAvailable !== "function" || !adapter.isConsumerAvailable("board")) {
    return { ok: false, reason: "probe_board_unavailable" };
  }
  const live = options.live;
  if (!isObj(live) || typeof live.boardVendorRefusal !== "function" || typeof live.launchFromBay !== "function") {
    return { ok: false, reason: options.boardReason || "board_accessors_unavailable" };
  }
  const ship = adapter.requireGame("services/ship/shipService");
  if (!ship.ok) return { ok: false, reason: `require_failed:services/ship/shipService:${ship.reason}` };
  const macho = adapter.requireGame("common/machoErrors");
  if (!macho.ok) return { ok: false, reason: `require_failed:common/machoErrors:${macho.reason}` };
  const throwWrapped = macho.exports && macho.exports.throwWrappedUserError;
  if (typeof throwWrapped !== "function") return { ok: false, reason: "no_throwWrappedUserError" };
  const report = createGuardErrorReporter({ log: options.log, intervalMs: cfg.guardErrorLogIntervalMs,
    now: options.now });
  const scoopReason = options.scoopReturnReason
    || (adapter.isConsumerAvailable("scoopReturn") ? null : "probe_scoopReturn_unavailable");
  return installBoardHook(ship.exports, {
    wing, adapter: live, config: cfg, log: options.log, serverReason: options.boardServerReason || null,
    ghostReason: options.boardGhostReason || null, stowReason: options.boardStowReason || null, scoopReason,
    stowCargo: options.stowCargo || null, stowCargoReason: options.stowCargoReason || null,
    now: options.now,
    refuse: (notify) => throwWrapped("CustomNotify", { notify }),
    onError: (err) => report(HANDLER, err),
  });
}

module.exports = {
  BOARD_HOOKED, SCOOP_HOOKED, COUNTER_NAMES, VENDOR_LAUNCH_OFFSET_METERS, SERVER_BOARD_FAILURE, refusalText, toId,
  boardAnchor, wrapBoardHandler, createServerBoard, wrapScoopHandler, installBoardHook, installBoardHookFromGame,
};
