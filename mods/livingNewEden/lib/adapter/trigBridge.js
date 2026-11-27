"use strict";

const crypto = require("node:crypto");
const { functionBody } = require("./essRepositoryFast");

const JUMP_MGR_PATH = "services/structure/structureJumpBridgeMgrService";
const LINKS_PATH = "services/structure/structureJumpBridgeLinks";
const SCOPE_METHOD = "Handle_CmdJumpThroughStructureStargate";
const PENDING_STATIC = "findPendingJumpBridgeSettlementForCharacter";
const SYSTEM_GETTER = "getSolarSystemByID";
const MARKER_KEY = "lneTrigBridge";
const VENDOR_RANGE_LY = 5;
const VENDOR_MAX_MASS_KG = 1480000000;
const LIGHT_YEAR_METERS = 9460730472580800;
const METHOD_SHA1 = "ca11d24c424b7eaaba5c6ff0a1b07f25cb839176";
const FUNCTION_SHA1 = Object.freeze({
  getSolarSystemDistanceLy: "08308f00434f7458bf255cb044f9299415931cc9",
  calculateLiquidOzoneRequired: "1af788ee89dee90b0c9136de8f921779ad0da060",
});
const MARKER = Symbol.for("livingNewEden.trigBridge.jumpScope");
const DETAIL_MAX = 120;
const FAIL_LOG_INTERVAL_MS = 60000;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const lf = (text) => String(text).replace(/\r\n/g, "\n");
const sha1Of = (text) => (text === null ? null : crypto.createHash("sha1").update(text).digest("hex"));
const fit = (text) => String(text).slice(0, DETAIL_MAX);
const messageOf = (err) => fit((err && err.message) || err);

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function toFiniteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function vectorOf(p) {
  if (!p || typeof p !== "object") return null;
  const v = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z) ? v : null;
}

function methodBody(sourceText, name) {
  const text = lf(sourceText || "");
  const start = new RegExp(`^ {2}(async )?${name}\\(`, "m").exec(text);
  if (!start) return null;
  const end = /\n {2}\}(\n|$)/g;
  end.lastIndex = start.index;
  const hit = end.exec(text);
  return hit ? text.slice(start.index + 2, hit.index + 4) : null;
}

function driftDetail(serviceClass, sourceText) {
  const file = `${JUMP_MGR_PATH}.js`;
  if (typeof sourceText !== "string") return `${file}:missing`;
  const text = lf(sourceText);
  const body = methodBody(text, SCOPE_METHOD);
  if (sha1Of(body) !== METHOD_SHA1) return `${file}:${SCOPE_METHOD}`;
  const current = serviceClass.prototype[SCOPE_METHOD];
  if (!current[MARKER] && lf(Function.prototype.toString.call(current)) !== body) {
    return `${file}:${SCOPE_METHOD} not the vendor method`;
  }
  const testing = serviceClass._testing;
  if (!testing || typeof testing !== "object") return `${file}:_testing`;
  for (const name of Object.keys(FUNCTION_SHA1)) {
    const fnBody = functionBody(text, name);
    if (sha1Of(fnBody) !== FUNCTION_SHA1[name]) return `${file}:${name}`;
    if (typeof testing[name] !== "function" || lf(Function.prototype.toString.call(testing[name])) !== fnBody) {
      return `${file}:_testing.${name}`;
    }
  }
  if (testing.MAX_ANSIBLEX_RANGE_LY !== VENDOR_RANGE_LY) return `${file}:MAX_ANSIBLEX_RANGE_LY`;
  if (typeof serviceClass[PENDING_STATIC] !== "function") return `${file}:${PENDING_STATIC}`;
  return null;
}

function seamProblem(seam) {
  const s = seam || {};
  const cls = s.serviceClass;
  if (typeof cls !== "function" || !cls.prototype || typeof cls.prototype[SCOPE_METHOD] !== "function") {
    return `jumpBridgeMgr_${SCOPE_METHOD}`;
  }
  if (!s.worldData || typeof s.worldData[SYSTEM_GETTER] !== "function"
    || typeof s.worldData.getMovementAttributesForType !== "function") return "worldData";
  if (!s.runtime || typeof s.runtime.getEntity !== "function") return "runtime_getEntity";
  if (!s.structureState || typeof s.structureState.getStructureByID !== "function"
    || typeof s.structureState.listStructures !== "function") return "structureState";
  if (!s.links || typeof s.links.findReciprocalJumpBridge !== "function") return "links_findReciprocalJumpBridge";
  if (!s.characterState || typeof s.characterState.getActiveShipRecord !== "function") return "characterState";
  if (typeof s.throwUserError !== "function") return "machoErrors_throwWrappedUserError";
  return null;
}

function checkJumpScope(seam) {
  try {
    const problem = seamProblem(seam);
    if (problem) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: problem };
    const drift = driftDetail(seam.serviceClass, seam.sourceText);
    return drift === null ? { ok: true } : { ok: false, reason: "TRIG_BRIDGE_DRIFT", detail: fit(drift) };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
  }
}

function hasMarker(row) {
  const flags = row && typeof row === "object" ? row.devFlags : null;
  const m = flags && typeof flags === "object" ? flags[MARKER_KEY] : null;
  return Boolean(m && typeof m === "object");
}

function summaryOf(row) {
  const m = row.devFlags[MARKER_KEY];
  return Object.freeze({ structureId: toPositiveInt(row.structureID), systemId: toPositiveInt(row.solarSystemID),
    devFlags: Object.freeze({ [MARKER_KEY]: Object.freeze({ v: m.v, installedAt: m.installedAt,
      installedBy: m.installedBy, coreTypeId: m.coreTypeId }) }) });
}

function createJumpScope(deps) {
  const d = deps || {};
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => Date.now();
  const driftCheck = typeof d.driftCheck === "function" ? d.driftCheck : driftDetail;
  const stats = { scoped: 0, passthrough: 0, refused: 0, scopeErrors: 0, restoreErrors: 0 };
  let installed = false;
  let active = false;
  let proto = null;
  let original = null;
  let wrapper = null;
  let lastFailLogAt = -Infinity;

  const log = (line) => {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  };
  const event = (name) => {
    if (typeof d.onEvent !== "function") return;
    try {
      d.onEvent(name);
    } catch (_err) {
    }
  };
  const noteError = (where, err) => {
    stats.scopeErrors += 1;
    event("scopeErrors");
    const now = nowMs();
    if (now - lastFailLogAt < FAIL_LOG_INTERVAL_MS) return;
    lastFailLogAt = now;
    log(`trigBridge: ${where} failed, vanilla jump (scopeErrors=${stats.scopeErrors}) - ${messageOf(err)}`);
  };

  const realMassOf = (ship, item) => {
    const direct = toFiniteNumber(ship && ship.mass, toFiniteNumber(item && item.mass, 0));
    if (direct > 0) return direct;
    const movement = d.worldData.getMovementAttributesForType(toPositiveInt(item && (item.typeID || item.shipTypeID)));
    return Math.max(0, toFiniteNumber(movement && movement.mass, 0));
  };

  const planOf = (args, session) => {
    const characterId = toPositiveInt(session && session.characterID);
    if (!characterId || !session._space) return { kind: "pass" };
    const structureId = toPositiveInt(Array.isArray(args) ? args[0] : null);
    const pending = d.serviceClass[PENDING_STATIC](characterId);
    if (pending) {
      if (!structureId || toPositiveInt(pending.sourceStructureID) !== structureId) return { kind: "pass" };
      const s = d.structureState.getStructureByID(structureId, { refresh: false });
      if (!hasMarker(s)) return { kind: "pass" };
      const t = d.links.findReciprocalJumpBridge(s, d.structureState.listStructures({ includeDestroyed: false,
        refresh: false }));
      return hasMarker(t) ? { kind: "pass", resume: { characterId, at: NaN, realMass: 0 } } : { kind: "pass" };
    }
    const src = structureId ? d.structureState.getStructureByID(structureId, { refresh: false }) : null;
    if (!hasMarker(src)) return { kind: "pass" };
    const dst = d.links.findReciprocalJumpBridge(src,
      d.structureState.listStructures({ includeDestroyed: false, refresh: false }));
    if (!hasMarker(dst)) return { kind: "pass" };
    const source = summaryOf(src);
    const destination = summaryOf(dst);
    const a = d.worldData[SYSTEM_GETTER](source.systemId);
    const b = d.worldData[SYSTEM_GETTER](destination.systemId);
    const sourcePosition = vectorOf(a && a.position);
    const destinationPosition = vectorOf(b && b.position);
    const realLy = sourcePosition && destinationPosition
      ? Math.hypot(destinationPosition.x - sourcePosition.x, destinationPosition.y - sourcePosition.y,
        destinationPosition.z - sourcePosition.z) / LIGHT_YEAR_METERS
      : NaN;
    const verdict = d.decide({ characterId, realLy, source, destination, sourcePosition, destinationPosition });
    if (!verdict || verdict.pass === true) return { kind: "pass" };
    if (verdict.ok === false) {
      return { kind: "refuse", reason: String(verdict.reason), message: String(verdict.message || "") };
    }
    const position = vectorOf(verdict.position);
    if (verdict.ok !== true || !position) return { kind: "pass" };
    const activeShip = d.characterState.getActiveShipRecord(characterId);
    const shipId = toPositiveInt(activeShip && activeShip.itemID);
    const ship = shipId ? d.runtime.getEntity(session, shipId) : null;
    const realMass = ship ? realMassOf(ship, activeShip) : 0;
    return { kind: "scope", characterId, at: verdict.at, sourceSystemId: source.systemId,
      systemId: destination.systemId, position,
      ship: ship && typeof ship === "object" ? ship : null, realMass };
  };

  const apply = (plan, st) => {
    const wd = d.worldData;
    st.hadOwnGetter = hasOwn(wd, SYSTEM_GETTER);
    st.prevGetter = wd[SYSTEM_GETTER];
    const prev = st.prevGetter;
    const { sourceSystemId, systemId, position } = plan;
    // Only the source-then-destination lookup of the range check sees the moved destination; the capacitor zone reads the real one.
    let lastId = 0;
    const scoped = function getSolarSystemByID(solarSystemID) {
      const row = prev.apply(this, arguments);
      const id = Number(solarSystemID);
      const pairLookup = lastId === sourceSystemId && id === systemId;
      lastId = id;
      return row && pairLookup ? { ...row, position: { ...position } } : row;
    };
    st.getterSet = true;
    wd[SYSTEM_GETTER] = scoped;
    if (wd[SYSTEM_GETTER] !== scoped) throw new Error(`worldData.${SYSTEM_GETTER} not writable`);
    const ship = plan.ship;
    if (!ship || !(plan.realMass > 0)) return;
    const desc = Object.getOwnPropertyDescriptor(ship, "mass");
    if (desc && (!hasOwn(desc, "value") || desc.writable !== true)) return;
    if (!desc && !Object.isExtensible(ship)) return;
    st.ship = ship;
    st.massHad = Boolean(desc);
    st.massValue = desc ? desc.value : undefined;
    st.massSet = true;
    ship.mass = Math.min(plan.realMass, VENDOR_MAX_MASS_KG);
  };

  const restore = (st) => {
    if (st.massSet) {
      try {
        if (st.massHad) st.ship.mass = st.massValue;
        else delete st.ship.mass;
      } catch (_err) {
        stats.restoreErrors += 1;
      }
    }
    if (st.getterSet) {
      try {
        if (st.hadOwnGetter) d.worldData[SYSTEM_GETTER] = st.prevGetter;
        else delete d.worldData[SYSTEM_GETTER];
      } catch (_err) {
        stats.restoreErrors += 1;
      }
    }
  };

  const afterJump = (plan, result) => {
    if (!result || typeof result.then !== "function" || typeof d.onJump !== "function") return;
    const heavy = plan.realMass > VENDOR_MAX_MASS_KG;
    result.then(() => {
      try {
        d.onJump({ characterId: plan.characterId, at: plan.at, heavy });
      } catch (_err) {
      }
    }, () => {});
  };

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const problem = seamProblem(d);
    if (problem) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: problem };
    if (typeof d.decide !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "decide" };
    const target = d.serviceClass.prototype;
    if (target[SCOPE_METHOD][MARKER]) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    let drift;
    try {
      drift = driftCheck(d.serviceClass, d.sourceText);
    } catch (err) {
      drift = `check threw: ${messageOf(err)}`;
    }
    if (drift !== null) return { ok: false, reason: "TRIG_BRIDGE_DRIFT", detail: fit(drift) };
    const base = target[SCOPE_METHOD];
    const wrapped = function Handle_CmdJumpThroughStructureStargate() {
      if (!active) return base.apply(this, arguments);
      let plan;
      try {
        plan = planOf(arguments[0], arguments[1]);
      } catch (err) {
        noteError("plan", err);
        plan = { kind: "pass" };
      }
      if (plan.kind === "pass") {
        stats.passthrough += 1;
        event("passthroughVanilla");
        const passed = base.apply(this, arguments);
        if (plan.resume) afterJump(plan.resume, passed);
        return passed;
      }
      if (plan.kind === "refuse") {
        stats.refused += 1;
        event(plan.reason === "COOLDOWN" ? "refusedCooldown" : "refusedRange");
        d.throwUserError("CustomNotify", { notify: plan.message });
        return base.apply(this, arguments);
      }
      const st = { getterSet: false, massSet: false };
      try {
        apply(plan, st);
      } catch (err) {
        restore(st);
        noteError("scope", err);
        return base.apply(this, arguments);
      }
      let result;
      try {
        result = base.apply(this, arguments);
      } finally {
        restore(st);
      }
      stats.scoped += 1;
      afterJump(plan, result);
      return result;
    };
    Object.defineProperty(wrapped, MARKER, { value: true });
    target[SCOPE_METHOD] = wrapped;
    if (target[SCOPE_METHOD] !== wrapped) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${SCOPE_METHOD} not writable` };
    }
    proto = target;
    original = base;
    wrapper = wrapped;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    try {
      if (installed && proto && proto[SCOPE_METHOD] === wrapper) proto[SCOPE_METHOD] = original;
    } catch (_err) {
    }
    installed = false;
  }

  return Object.freeze({ install, uninstall, isActive: () => active, getStats: () => ({ ...stats }) });
}

module.exports = { JUMP_MGR_PATH, LINKS_PATH, SCOPE_METHOD, PENDING_STATIC, MARKER_KEY, VENDOR_RANGE_LY,
  VENDOR_MAX_MASS_KG, LIGHT_YEAR_METERS, METHOD_SHA1, FUNCTION_SHA1, MARKER, methodBody, driftDetail, checkJumpScope,
  createJumpScope };
