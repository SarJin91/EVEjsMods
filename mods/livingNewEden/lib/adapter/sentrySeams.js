"use strict";

const path = require("node:path");
const { isSentryTypeId, LOOK_CANDIDATES } = require("./data/sentryTypes");
const combat = require("./sentryCombat");
const faction = require("./sentryFaction");

const MARKER = Symbol.for("livingNewEden.sentry");
const NOT_WRITABLE = "SEAM_NOT_WRITABLE";
const SEAM_MISSING = "SEAM_MISSING";
const UNAVAILABLE = "SENTRY_SEAM_UNAVAILABLE";
const MAX_DETAIL = 120;
const TYPE_MEMO_MAX = 4096;
const DEFAULT_ACCESS_RANGE_M = 2500;

const REL = Object.freeze({
  itemStore: "services/inventory/itemStore",
  anchoring: "services/starbase/starbaseAnchoringPolicy",
  corp: "services/corporation/corporationState",
  runtime: "space/runtime",
  macho: "common/machoErrors",
});

const WRAPS = Object.freeze({
  moduleRuntime: Object.freeze(["startAnchorTransition", "reconcileStarbaseModule", "setOnlineState"]),
  defenseRuntime: Object.freeze(["validateBatteryOperation"]),
  inventoryRuntime: Object.freeze(["validateBatteryAmmoInventoryAccess"]),
  dogmaErrors: Object.freeze(["_formatStarbaseModuleUserError"]),
  posMgrErrors: Object.freeze(["Handle_AnchorStructure"]),
  defensePresentation: Object.freeze(["hydrateBatteryActor"]),
});
const REQUIRED_WRAPS = Object.freeze(["moduleRuntime", "defenseRuntime", "inventoryRuntime"]);

const proc = {
  cache: null,
  srcDir: null,
  defense: null,
  policy: null,
  accessRangeM: DEFAULT_ACCESS_RANGE_M,
  messages: Object.freeze({}),
  installs: {},
  typeMemo: new Map(),
  inPosMgrAnchor: false,
  posMgrRefusal: null,
  look: null,
  lookStats: { applied: 0, skipped: 0 },
};

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const fail = (errorMsg) => ({ success: false, errorMsg });
const isObj = (v) => v !== null && typeof v === "object";

function cached(rel) {
  try {
    if (!proc.cache || !proc.srcDir) return null;
    const entry = proc.cache[path.join(proc.srcDir, `${rel}.js`)];
    return entry && entry.exports ? entry.exports : null;
  } catch (_err) {
    return null;
  }
}

function configure(opts) {
  if (!opts || !isObj(opts.cache)) return;
  if (proc.cache === null) proc.cache = opts.cache;
  if (proc.srcDir === null && typeof opts.filename === "string" && opts.filename !== "") {
    proc.srcDir = path.resolve(path.dirname(opts.filename), "..", "..");
  }
}

function findItem(itemID) {
  const store = cached(REL.itemStore);
  if (!store || typeof store.findItemById !== "function") return null;
  const item = store.findItemById(itemID);
  return isObj(item) ? item : null;
}

function idOf(itemOrID) {
  return Math.trunc(num(isObj(itemOrID) ? itemOrID.itemID : itemOrID));
}

function sentryItemOf(itemOrID) {
  const id = idOf(itemOrID);
  if (!isId(id)) return null;
  if (isObj(itemOrID) && itemOrID.typeID !== undefined && !isSentryTypeId(itemOrID.typeID)) return null;
  if (proc.typeMemo.get(id) === false) return null;
  const item = findItem(id);
  if (!item) return null;
  const sentry = isSentryTypeId(item.typeID);
  if (!sentry) {
    if (proc.typeMemo.size >= TYPE_MEMO_MAX) proc.typeMemo.clear();
    proc.typeMemo.set(id, false);
    return null;
  }
  return item;
}

function sessionOf(session) {
  const s = session || {};
  const space = isObj(s._space) ? s._space : {};
  return {
    characterID: Math.trunc(num(s.characterID || s.charid)),
    systemID: Math.trunc(num(space.systemID, num(s.solarsystemid2 || s.solarsystemid))),
    shipID: Math.trunc(num(space.shipID, num(s.shipID || s.shipid))),
  };
}

function policyCall(name, req) {
  const policy = proc.policy;
  if (!policy || typeof policy[name] !== "function") return null;
  try {
    const r = policy[name](req);
    return isObj(r) ? r : { ok: false, reason: "SENTRY_POLICY_FAILED" };
  } catch (_err) {
    return { ok: false, reason: "SENTRY_POLICY_FAILED" };
  }
}

function anchorSentry(item, session, itemID) {
  if (proc.policy === null) return fail("STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM");
  const access = accessRefusal(item, session);
  if (access !== null) return fail(access);
  const r = policyCall("anchor", { session, itemId: item.itemID });
  if (r === null) return fail("STARBASE_ANCHORING_RESTRICTED_IN_SYSTEM");
  if (r.ok !== true) return fail(String(r.reason || "SENTRY_POLICY_FAILED"));
  return { success: true, data: findItem(itemID) || item, delayMs: 0 };
}

function onlineSentry(item, session, itemID) {
  if (proc.policy === null) return fail("CONTROL_TOWER_NOT_ONLINE");
  const r = policyCall("online", { session, itemId: item.itemID });
  if (r === null) return fail("CONTROL_TOWER_NOT_ONLINE");
  if (r.ok !== true) return fail(String(r.reason || "SENTRY_POLICY_FAILED"));
  return { success: true, data: findItem(itemID) || item };
}

function batterySentry(item) {
  if (proc.policy === null) return fail("MODULE_NOT_ONLINE");
  const defense = proc.defense;
  if (!defense || typeof defense.hasUnavailableHealth !== "function"
    || typeof defense.getBatteryProfile !== "function") return fail("MODULE_NOT_ONLINE");
  if (defense.hasUnavailableHealth(item)) return fail("MODULE_INCAPACITATED");
  const state = item.spaceState || {};
  if (state.anchorState !== "anchored" || state.onlineState !== "online" || num(state.online) !== 1) {
    return fail("MODULE_NOT_ONLINE");
  }
  let armed = false;
  try {
    armed = proc.policy.isArmed(item.itemID) === true;
  } catch (_err) {
    armed = false;
  }
  if (!armed) return fail("SENTRY_NOT_ARMED");
  const profile = defense.getBatteryProfile(item);
  if (!profile || profile.passive || !profile.effectName) return fail("STARBASE_BATTERY_NOT_FOUND");
  return { success: true, data: { item, tower: null, profile } };
}

function surfaceDistance(scene, ship, module) {
  if (scene && typeof scene.getEntitySurfaceDistance === "function") {
    return num(scene.getEntitySurfaceDistance(ship, module), Infinity);
  }
  const a = ship.position || {};
  const b = module.position || {};
  const d = Math.sqrt((num(a.x) - num(b.x)) ** 2 + (num(a.y) - num(b.y)) ** 2 + (num(a.z) - num(b.z)) ** 2);
  return Math.max(0, d - Math.max(0, num(ship.radius)) - Math.max(0, num(module.radius)));
}

function accessRefusal(item, session) {
  const ctx = sessionOf(session);
  if (num(item.locationID) !== ctx.systemID || !isObj(item.spaceState)) return "STARBASE_MODULE_NOT_IN_SPACE";
  const runtime = cached(REL.runtime);
  if (!runtime || typeof runtime.getSceneForSession !== "function" || typeof runtime.getEntity !== "function") {
    return "STARBASE_MODULE_NOT_VISIBLE";
  }
  const scene = runtime.getSceneForSession(session);
  const ship = runtime.getEntity(session, ctx.shipID);
  const module = runtime.getEntity(session, item.itemID);
  if (!ship || !module) return "STARBASE_MODULE_NOT_VISIBLE";
  if (surfaceDistance(scene, ship, module) > proc.accessRangeM) return "STARBASE_STRUCTURE_TOO_FAR";
  return null;
}

function ammoSentry(item, session, operation) {
  const access = accessRefusal(item, session);
  if (access !== null) return fail(access);
  const corp = cached(REL.corp);
  const anchoring = cached(REL.anchoring);
  if (!corp || typeof corp.isNpcCorporationID !== "function" || !anchoring
    || typeof anchoring.validateCorporationAuthority !== "function") return fail("SENTRY_POLICY_FAILED");
  if (corp.isNpcCorporationID(item.ownerID) === true) return fail("STARBASE_PLAYER_CORPORATION_REQUIRED");
  const authority = anchoring.validateCorporationAuthority(session, item.ownerID, { operation });
  if (!authority || authority.success !== true) {
    return fail(String((authority && authority.errorMsg) || "STARBASE_CORPORATION_OWNER_REQUIRED"));
  }
  return { success: true };
}

function mark(wrapper, original, name) {
  Object.defineProperty(wrapper, "name", { value: `livingNewEden_sentry_${name}` });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== MARKER) wrapper[s] = original[s];
  }
  wrapper[MARKER] = name;
  return wrapper;
}

function sentryOrNull(itemOrID) {
  try {
    return sentryItemOf(itemOrID);
  } catch (_err) {
    return null;
  }
}

function guarded(fn) {
  try {
    return fn();
  } catch (_err) {
    return fail("SENTRY_POLICY_FAILED");
  }
}

const FACTORIES = Object.freeze({
  startAnchorTransition: (original) => function startAnchorTransition(session, itemID, effectName) {
    const item = sentryOrNull(itemID);
    if (item === null || String(effectName || "").toLowerCase().includes("lift")) {
      return original.apply(this, arguments);
    }
    const r = guarded(() => anchorSentry(item, session, itemID));
    if (proc.inPosMgrAnchor && !r.success) proc.posMgrRefusal = r.errorMsg;
    return r;
  },
  reconcileStarbaseModule: (original) => function reconcileStarbaseModule(itemOrID) {
    const item = sentryOrNull(itemOrID);
    if (item !== null) {
      const state = item.spaceState || {};
      const anchored = String(state.anchorState || "").toLowerCase() === "anchored";
      const online = String(state.onlineState || "").toLowerCase() === "online";
      if (anchored && online) return { success: true, data: item, completed: false };
    }
    return original.apply(this, arguments);
  },
  setOnlineState: (original) => function setOnlineState(session, itemID, online) {
    const item = online ? sentryOrNull(itemID) : null;
    if (item === null) return original.apply(this, arguments);
    return guarded(() => onlineSentry(item, session, itemID));
  },
  validateBatteryOperation: (original) => function validateBatteryOperation(itemOrID) {
    const item = sentryOrNull(itemOrID);
    if (item === null) return original.apply(this, arguments);
    return guarded(() => batterySentry(item));
  },
  validateBatteryAmmoInventoryAccess: (original) => function validateBatteryAmmoInventoryAccess(session, itemOrID,
    operation = "viewput") {
    const item = sentryOrNull(itemOrID);
    if (item === null) return original.apply(this, arguments);
    return guarded(() => ammoSentry(item, session, operation));
  },
  _formatStarbaseModuleUserError: (original) => function _formatStarbaseModuleUserError(errorMsg) {
    const messages = proc.messages;
    const key = String(errorMsg || "");
    if (proc.policy !== null && Object.prototype.hasOwnProperty.call(messages, key)) return messages[key];
    return original.apply(this, arguments);
  },
  Handle_AnchorStructure: (original) => function Handle_AnchorStructure() {
    proc.inPosMgrAnchor = true;
    proc.posMgrRefusal = null;
    try {
      return original.apply(this, arguments);
    } catch (err) {
      throw sentryNotifyOr(err, proc.posMgrRefusal);
    } finally {
      proc.inPosMgrAnchor = false;
      proc.posMgrRefusal = null;
    }
  },
  hydrateBatteryActor: (original) => function hydrateBatteryActor(entity, item) {
    const r = original.apply(this, arguments);
    applyLook(entity, item);
    return r;
  },
});

function applyLook(entity, item) {
  try {
    const look = proc.look;
    if (look === null) return;
    const typeId = Number((item && item.typeID) || (entity && entity.typeID));
    if (!look.typeIds.includes(typeId)) return;
    if (!isObj(entity) || !Object.isExtensible(entity)) {
      proc.lookStats.skipped += 1;
      return;
    }
    entity.slimGraphicID = look.graphicID;
    if (look.slimTypeID !== null) entity.slimTypeID = look.slimTypeID;
    proc.lookStats.applied += 1;
  } catch (_err) {
    proc.lookStats.skipped += 1;
  }
}

function sentryNotifyOr(err, code) {
  try {
    const key = String(code || "");
    if (key === "" || proc.policy === null || !Object.prototype.hasOwnProperty.call(proc.messages, key)) return err;
    const macho = cached(REL.macho);
    if (!macho || typeof macho.throwWrappedUserError !== "function") return err;
    try {
      macho.throwWrappedUserError("CustomNotify", { notify: proc.messages[key] });
    } catch (replacement) {
      return replacement;
    }
    return err;
  } catch (_err) {
    return err;
  }
}

function blockerOf(target, name) {
  if (target === null || (typeof target !== "object" && typeof target !== "function")) return SEAM_MISSING;
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (!d || typeof d.value !== "function") return SEAM_MISSING;
  if (d.value[MARKER] === name) return null;
  if (Object.isFrozen(target)) return NOT_WRITABLE;
  if (d.writable === true || d.configurable === true) return null;
  return NOT_WRITABLE;
}

function put(target, name, value) {
  const d = Object.getOwnPropertyDescriptor(target, name);
  if (d.writable === true) {
    target[name] = value;
  } else {
    Object.defineProperty(target, name, { value, writable: false, enumerable: d.enumerable, configurable: true });
  }
  if (target[name] !== value) throw new Error(`${name} not replaced`);
}

function installNames(group, target, names) {
  try {
    for (const name of names) {
      const why = blockerOf(target, name);
      if (why !== null) {
        proc.installs[group] = "refused";
        return { ok: false, reason: why, detail: name };
      }
    }
    const fresh = names.filter((name) => target[name][MARKER] !== name);
    for (const name of fresh) put(target, name, mark(FACTORIES[name](target[name]), target[name], name));
    proc.installs[group] = fresh.length === 0 ? "already_installed" : "wrapped";
    return { ok: true, installed: fresh, alreadyInstalled: fresh.length === 0 };
  } catch (err) {
    proc.installs[group] = "refused";
    return { ok: false, reason: NOT_WRITABLE, detail: detailOf(err) };
  }
}

function installModuleRuntime(exports, opts) {
  configure(opts);
  return installNames("moduleRuntime", exports, WRAPS.moduleRuntime);
}

function installDefenseRuntime(exports, opts) {
  configure(opts);
  const r = installNames("defenseRuntime", exports, WRAPS.defenseRuntime);
  if (r.ok) proc.defense = exports;
  return r;
}

function installDefensePresentation(exports, opts) {
  configure(opts);
  return installNames("defensePresentation", exports, WRAPS.defensePresentation);
}

function installInventoryRuntime(exports, opts) {
  configure(opts);
  return installNames("inventoryRuntime", exports, WRAPS.inventoryRuntime);
}

function installDogmaErrors(DogmaService, opts) {
  configure(opts);
  const proto = typeof DogmaService === "function" ? DogmaService.prototype : null;
  return installNames("dogmaErrors", proto, WRAPS.dogmaErrors);
}

function installPosMgrErrors(PosMgrService, opts) {
  configure(opts);
  const proto = typeof PosMgrService === "function" ? PosMgrService.prototype : null;
  return installNames("posMgrErrors", proto, WRAPS.posMgrErrors);
}

function bindPolicy(policy, opts) {
  if (policy !== null && (!isObj(policy) || typeof policy.anchor !== "function" || typeof policy.online !== "function"
    || typeof policy.isArmed !== "function")) {
    return { ok: false, reason: "POLICY_INVALID" };
  }
  proc.policy = policy;
  const o = opts || {};
  proc.accessRangeM = Number.isFinite(o.accessRangeM) && o.accessRangeM > 0 ? o.accessRangeM : DEFAULT_ACCESS_RANGE_M;
  proc.messages = policy !== null && isObj(o.messages) ? Object.freeze({ ...o.messages }) : Object.freeze({});
  proc.look = policy !== null ? lookOf(o.look) : null;
  return { ok: true };
}

function lookOf(look) {
  if (!isObj(look) || !Array.isArray(look.typeIds) || look.typeIds.length === 0 || !look.typeIds.every(isId)
    || !isId(look.graphicID) || !(look.slimTypeID === null || isId(look.slimTypeID))) {
    return null;
  }
  return Object.freeze({ typeIds: Object.freeze([...look.typeIds]), graphicID: look.graphicID,
    slimTypeID: look.slimTypeID });
}

function resolveLookTypeFrom(typeId) {
  try {
    if (!LOOK_CANDIDATES.includes(typeId)) return { ok: false, reason: "INVALID_INPUT", detail: String(typeId) };
    const registry = cached("services/inventory/itemTypeRegistry");
    if (!registry || typeof registry.resolveItemByTypeID !== "function") {
      return { ok: false, reason: SEAM_MISSING, detail: "itemTypeRegistry" };
    }
    const rec = registry.resolveItemByTypeID(typeId);
    if (!isObj(rec)) return { ok: false, reason: "NOT_FOUND", detail: String(typeId) };
    const graphicID = Number(rec.graphicID);
    if (!isId(graphicID)) return { ok: false, reason: "NO_GRAPHIC", detail: String(typeId) };
    return { ok: true, graphicID, groupID: num(rec.groupID), categoryID: num(rec.categoryID) };
  } catch (err) {
    return { ok: false, reason: "SEAM_ERROR", detail: detailOf(err) };
  }
}

function installState() {
  const out = {};
  for (const group of Object.keys(WRAPS)) out[group] = proc.installs[group] || "absent";
  return out;
}

function checkWraps() {
  const state = installState();
  for (const group of REQUIRED_WRAPS) {
    if (state[group] !== "wrapped" && state[group] !== "already_installed") {
      return { ok: false, reason: UNAVAILABLE, detail: `wrap ${group} ${state[group]}` };
    }
  }
  return { ok: true };
}

const PATHS = Object.freeze({
  itemStore: "services/inventory/itemStore",
  worldData: "space/worldData",
  structures: "services/structure/structureState",
  gm: "services/starbase/posGmState",
  defense: "services/starbase/starbaseDefenseRuntime",
  anchoring: "services/starbase/starbaseAnchoringPolicy",
  corp: "services/corporation/corporationState",
  runtime: "space/runtime",
});
const REQUIRED = Object.freeze({
  itemStore: Object.freeze(["findItemById", "listStarbaseItems"]),
  worldData: Object.freeze(["getStargatesForSystem", "getStationsForSystem"]),
  structures: Object.freeze(["peekStructures"]),
  gm: Object.freeze(["forcePosOnlineState"]),
  defense: Object.freeze(["hasUnavailableHealth"]),
  anchoring: Object.freeze(["validateCorporationAuthority"]),
  corp: Object.freeze(["isNpcCorporationID"]),
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
});
const SCENE_NOT_LOADED = "SENTRY_SCENE_NOT_LOADED";

const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail });
const posOf = (p) => (isObj(p) ? { x: num(p.x), y: num(p.y), z: num(p.z) } : null);

function checkSeamsFrom(vendor) {
  try {
    if (!isObj(vendor)) return refuse(UNAVAILABLE, "vendor");
    for (const key of Object.keys(PATHS)) {
      const mod = vendor[key];
      if (!isObj(mod)) return refuse(UNAVAILABLE, PATHS[key]);
      for (const name of REQUIRED[key]) {
        if (typeof mod[name] !== "function") return refuse(UNAVAILABLE, `${PATHS[key]}.${name}`);
      }
    }
    return { ok: true };
  } catch (err) {
    return refuse(UNAVAILABLE, detailOf(err));
  }
}

function itemViewOf(vendor, item) {
  const state = isObj(item.spaceState) ? item.spaceState : null;
  const systemId = Math.trunc(num(state && state.systemID, num(item.locationID)));
  return Object.freeze({
    itemId: Math.trunc(num(item.itemID)),
    typeId: Math.trunc(num(item.typeID)),
    ownerCorpId: Math.trunc(num(item.ownerID)),
    systemId,
    inSpace: state !== null && systemId > 0 && Math.trunc(num(item.locationID)) === systemId
      && Math.trunc(num(item.flagID, -1)) === 0,
    anchorState: String((state && state.anchorState) || "unanchored").toLowerCase(),
    onlineState: String((state && state.onlineState) || "offline").toLowerCase(),
    position: posOf(state && state.position),
    destroyed: vendor.defense.hasUnavailableHealth(item) === true,
    disabledReason: state && typeof state.starbaseDisabledReason === "string" && state.starbaseDisabledReason !== ""
      ? state.starbaseDisabledReason.slice(0, MAX_DETAIL) : null,
    disabledAtMs: state && Number.isSafeInteger(state.starbaseDisabledAtMs) ? state.starbaseDisabledAtMs : null,
    incapacitated: isObj(item.conditionState) && (item.conditionState.incapacitated === true
      || num(item.conditionState.armorDamage, 0) >= 1),
    ...hpFieldsOf(vendor, item),
  });
}

function hpFieldsOf(vendor, item) {
  try {
    const hp = combat.hpLeftOf(vendor, item);
    return hp === null ? { hp: null, hpMax: null } : { hp: hp.left, hpMax: hp.max };
  } catch (_err) {
    return { hp: null, hpMax: null };
  }
}

function readSentryItemFrom(vendor, itemId) {
  if (!isId(itemId)) return refuse("INVALID_INPUT", "itemId");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const item = vendor.itemStore.findItemById(itemId);
    if (!isObj(item)) return refuse("NOT_FOUND");
    if (!isSentryTypeId(item.typeID)) return refuse("NOT_SENTRY");
    return { ok: true, item: itemViewOf(vendor, item) };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function listSentryItemsFrom(vendor, query) {
  const q = query || {};
  const bySystem = isId(q.systemId);
  if (!bySystem && !(isId(q.typeId) && isSentryTypeId(q.typeId))) return refuse("INVALID_INPUT", "query");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const rows = vendor.itemStore.listStarbaseItems(bySystem ? { systemID: q.systemId } : { typeID: q.typeId });
    const items = [];
    for (const item of Array.isArray(rows) ? rows : []) {
      if (isObj(item) && isSentryTypeId(item.typeID)) items.push(itemViewOf(vendor, item));
    }
    return { ok: true, items };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function readAnchorsFrom(vendor, systemId, opts) {
  if (!isId(systemId)) return refuse("INVALID_INPUT", "systemId");
  const max = opts && isId(opts.maxAnchors) ? opts.maxAnchors : 0;
  if (max === 0) return refuse("INVALID_INPUT", "maxAnchors");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const anchors = [];
    const push = (a) => {
      if (isId(a.id) && a.position !== null) anchors.push(Object.freeze(a));
    };
    for (const g of vendor.worldData.getStargatesForSystem(systemId) || []) {
      push({ kind: "gate", id: Math.trunc(num(g && g.itemID)), position: posOf(g && g.position),
        radius: Math.max(0, num(g && g.radius)), ownerCorpId: null, lneStationId: null,
        toSystemId: Math.trunc(num(g && g.destinationSolarSystemID)) || null });
    }
    for (const s of vendor.worldData.getStationsForSystem(systemId) || []) {
      push({ kind: "station", id: Math.trunc(num(s && s.stationID)), position: posOf(s && s.position),
        radius: Math.max(0, num(s && s.radius)), ownerCorpId: Math.trunc(num(s && s.corporationID)) || null,
        lneStationId: null });
    }
    for (const r of vendor.structures.peekStructures({ includeDestroyed: false }) || []) {
      if (!isObj(r) || r.destroyedAt || Math.trunc(num(r.solarSystemID)) !== systemId) continue;
      const flags = isObj(r.devFlags) ? r.devFlags : {};
      push({ kind: "structure", id: Math.trunc(num(r.structureID)), position: posOf(r.position),
        radius: Math.max(0, num(r.radius)), ownerCorpId: Math.trunc(num(r.ownerCorpID)) || null,
        lneStationId: typeof flags.lneStationId === "string" && flags.lneStationId !== "" ? flags.lneStationId : null });
    }
    const truncated = anchors.length > max;
    return { ok: true, anchors: truncated ? anchors.slice(0, max) : anchors, truncated };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function standsOnline(vendor, itemId) {
  const item = vendor.itemStore.findItemById(itemId);
  if (!isObj(item) || !isSentryTypeId(item.typeID)) return false;
  const view = itemViewOf(vendor, item);
  return view.anchorState === "anchored" && view.onlineState === "online";
}

function forceOnlineFrom(vendor, itemId, opts) {
  if (!isId(itemId)) return refuse("INVALID_INPUT", "itemId");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    if (opts && opts.loadedSceneOnly === true) {
      const item = vendor.itemStore.findItemById(itemId);
      if (!isObj(item)) return refuse("NOT_FOUND");
      if (vendor.runtime.isSolarSystemSceneLoaded(itemViewOf(vendor, item).systemId) !== true) {
        return refuse(SCENE_NOT_LOADED);
      }
    }
    const r = vendor.gm.forcePosOnlineState(itemId, true);
    if (isObj(r) && r.success === true) return { ok: true, partial: false };
    const reason = String((r && r.errorMsg) || "VENDOR_REFUSED");
    if (standsOnline(vendor, itemId)) return { ok: true, partial: true, detail: reason.slice(0, MAX_DETAIL) };
    return refuse(reason);
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function isNpcCorporationFrom(vendor, corpId) {
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    return { ok: true, npc: vendor.corp.isNpcCorporationID(corpId) === true };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function readCorporationNameFrom(vendor, corpId) {
  if (!isId(corpId)) return refuse("INVALID_INPUT");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  if (typeof vendor.corp.getCorporationRecord !== "function") return refuse(UNAVAILABLE, `${PATHS.corp}.getCorporationRecord`);
  try {
    const record = vendor.corp.getCorporationRecord(corpId);
    const name = isObj(record) && typeof record.corporationName === "string" && record.corporationName !== ""
      ? record.corporationName.slice(0, MAX_DETAIL) : null;
    return { ok: true, name };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function validateAuthorityFrom(vendor, session, ownerCorpId, operation) {
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const r = vendor.anchoring.validateCorporationAuthority(session, ownerCorpId, { operation });
    return isObj(r) && r.success === true ? { ok: true }
      : refuse(String((r && r.errorMsg) || "STARBASE_CORPORATION_OWNER_REQUIRED"));
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function createSentrySeam(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  let vendor = null;
  const load = () => {
    if (vendor !== null) return vendor;
    if (requireGame === null) return null;
    const out = {};
    for (const key of Object.keys(PATHS)) {
      const r = requireGame(PATHS[key]);
      if (!r || r.ok !== true) return null;
      out[key] = r.exports;
    }
    vendor = out;
    return vendor;
  };
  const withVendor = (fn) => {
    try {
      const v = load();
      return v === null ? refuse(UNAVAILABLE, "requireGame") : fn(v);
    } catch (err) {
      return refuse(UNAVAILABLE, detailOf(err));
    }
  };
  let factionVendor = null;
  const loadFaction = () => {
    if (factionVendor !== null) return factionVendor;
    if (requireGame === null) return null;
    const out = {};
    for (const key of Object.keys(faction.FACTION_PATHS)) {
      const r = requireGame(faction.FACTION_PATHS[key]);
      if (!r || r.ok !== true) return null;
      out[key] = r.exports;
    }
    factionVendor = out;
    return factionVendor;
  };
  let defendVendor = null;
  const loadDefend = () => {
    if (defendVendor !== null) return defendVendor;
    if (requireGame === null) return null;
    const r = requireGame("space/npc/npcRegistry");
    if (!r || r.ok !== true || !isObj(r.exports)) return null;
    defendVendor = { registry: r.exports };
    return defendVendor;
  };
  const defendOf = () => {
    try {
      const d = loadDefend();
      return d === null ? null : d.registry;
    } catch (_err) {
      return null;
    }
  };
  let crimewatchVendor = null;
  const crimewatchOf = () => {
    try {
      if (crimewatchVendor !== null) return crimewatchVendor;
      if (requireGame === null) return null;
      const r = requireGame("services/security/crimewatchState");
      if (!r || r.ok !== true || !isObj(r.exports)) return null;
      crimewatchVendor = r.exports;
      return crimewatchVendor;
    } catch (_err) {
      return null;
    }
  };
  const combatMemo = new Map();
  const withFaction = (fn) => {
    try {
      const v = loadFaction();
      return v === null ? { ok: false, reason: faction.UNAVAILABLE, permanent: false, detail: "requireGame" } : fn(v);
    } catch (err) {
      return { ok: false, reason: faction.UNAVAILABLE, permanent: false, detail: detailOf(err) };
    }
  };
  return Object.freeze({
    checkSeams: () => withVendor((v) => checkSeamsFrom(v)),
    readAnchors: (systemId, opts) => withVendor((v) => readAnchorsFrom(v, systemId, opts)),
    readSentryItem: (itemId) => withVendor((v) => readSentryItemFrom(v, itemId)),
    listSentryItems: (query) => withVendor((v) => listSentryItemsFrom(v, query)),
    forceOnline: (itemId, opts) => withVendor((v) => forceOnlineFrom(v, itemId, opts)),
    isNpcCorporation: (corpId) => withVendor((v) => isNpcCorporationFrom(v, corpId)),
    validateAuthority: (session, ownerCorpId, operation) =>
      withVendor((v) => validateAuthorityFrom(v, session, ownerCorpId, operation)),
    checkCombat: () => withVendor((v) => combat.checkCombatFrom(v)),
    readSentryScene: (systemId, sentryItemIds, lneEntityIds, opts) => withVendor((v) => {
      const scan = isObj(opts) && Number.isSafeInteger(opts.defendScanMax) && opts.defendScanMax > 0;
      const pass = scan || (isObj(opts) && opts.defendPlayers === true);
      return combat.readSentrySceneFrom(scan ? { ...v, registry: defendOf() } : v, systemId, sentryItemIds,
        lneEntityIds, pass ? opts : undefined);
    }),
    hasLimitedEngagement: (firstCharacterId, secondCharacterId) =>
      combat.limitedEngagementFrom(crimewatchOf(), firstCharacterId, secondCharacterId),
    engage: (systemId, sentryItemId, targetEntityId) =>
      withVendor((v) => combat.engageFrom(v, systemId, sentryItemId, targetEntityId)),
    release: (systemId, sentryItemId, reason) => withVendor((v) => combat.releaseFrom(v, systemId, sentryItemId, reason)),
    applySentryDamage: (itemId, hp, opts) => withVendor((v) => combat.applySentryDamageFrom(v, itemId, hp, opts)),
    readSentryCombat: (typeId) => {
      if (combatMemo.has(typeId)) return combatMemo.get(typeId);
      const r = withVendor((v) => combat.readSentryCombatFrom(v, typeId));
      if (r.ok === true || r.reason === "NO_PROFILE") {
        if (combatMemo.size >= TYPE_MEMO_MAX) combatMemo.clear();
        combatMemo.set(typeId, Object.freeze(r));
      }
      return r;
    },
    readCorporationName: (corpId) => withVendor((v) => readCorporationNameFrom(v, corpId)),
    checkFactionAmmo: (pairs) => withFaction((v) => faction.checkFactionAmmoFrom(v, pairs)),
    deployFactionSentry: (spec) => withFaction((v) => faction.deployFactionSentryFrom(v, spec)),
    topUpAmmo: (spec) => withFaction((v) => faction.topUpAmmoFrom(v, spec)),
    readAmmo: (itemId, chargeTypeId) => withFaction((v) => faction.readAmmoFrom(v, itemId, chargeTypeId)),
    pruneReceipts: (isDead, maxRemove) => withFaction((v) => faction.pruneReceiptsFrom(v, isDead, maxRemove)),
    resolveLookType: (typeId) => resolveLookTypeFrom(typeId),
    lookStats: () => ({ applied: proc.lookStats.applied, skipped: proc.lookStats.skipped }),
  });
}

function resetForTests() {
  proc.cache = null;
  proc.srcDir = null;
  proc.defense = null;
  proc.policy = null;
  proc.accessRangeM = DEFAULT_ACCESS_RANGE_M;
  proc.messages = Object.freeze({});
  proc.installs = {};
  proc.typeMemo.clear();
  proc.inPosMgrAnchor = false;
  proc.posMgrRefusal = null;
  proc.look = null;
  proc.lookStats = { applied: 0, skipped: 0 };
}

module.exports = {
  MARKER,
  SCENE_NOT_LOADED,
  WRAPS,
  REQUIRED_WRAPS,
  PATHS,
  REQUIRED,
  installModuleRuntime,
  installDefenseRuntime,
  installInventoryRuntime,
  installDogmaErrors,
  installPosMgrErrors,
  installDefensePresentation,
  bindPolicy,
  installState,
  checkWraps,
  checkSeamsFrom,
  readSentryItemFrom,
  listSentryItemsFrom,
  readAnchorsFrom,
  forceOnlineFrom,
  createSentrySeam,
  resetForTests,
};
