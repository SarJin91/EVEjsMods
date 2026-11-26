"use strict";

const PATHS = Object.freeze({
  state: "services/structure/structureState",
  constants: "services/structure/structureConstants",
  placement: "services/structure/structureDeploymentPlacement",
  worldData: "space/worldData",
  gameStore: "gameStore/index",
});

const SOV_PLACEMENT_PATH = "services/sovereignty/sovHubPlacement";

const REQUIRED_FUNCTIONS = Object.freeze({
  state: Object.freeze(["createStructure", "updateStructureRecord", "destroyStructure", "removeStructure",
    "listStructures", "getStructureByID", "getStructureTypeByID", "registerStructureChangeListener"]),
  constants: Object.freeze([]),
  placement: Object.freeze(["validateDeploymentPlacement"]),
  worldData: Object.freeze(["getCelestialsForSystem"]),
  gameStore: Object.freeze(["flushTableSync"]),
});

const STATE_NAMES = Object.freeze(["ANCHOR_VULNERABLE", "SHIELD_VULNERABLE", "ARMOR_REINFORCE", "ARMOR_VULNERABLE",
  "HULL_REINFORCE", "HULL_VULNERABLE"]);
const OPTIONAL_STATE_NAMES = Object.freeze(["ANCHORING", "ONLINING_VULNERABLE"]);
const UPKEEP_NAMES = Object.freeze(["FULL_POWER"]);

const REASONS = Object.freeze({
  UNAVAILABLE: "STRUCTURES_SEAM_UNAVAILABLE",
  SEAM_ERROR: "SEAM_ERROR",
  TAG_REQUIRED: "TAG_REQUIRED",
  TAG_MISMATCH: "TAG_MISMATCH",
  ALREADY_TAGGED: "ALREADY_TAGGED",
  TYPE_UNKNOWN: "TYPE_UNKNOWN",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  DESTROYED: "DESTROYED",
  NOT_EMPTY: "NOT_EMPTY",
  WRITE_FAILED: "WRITE_FAILED",
  FLUSH_FAILED: "FLUSH_FAILED",
});
const SOV_REASONS = Object.freeze({ NO_SUN: "NO_SUN" });

const DOCKING_POLICIES = Object.freeze(["public", "alliance", "corp", "owner", "none"]);
const TETHERING_NONE = "none";
const PROFILE_ID = 1;
const ROTATION = Object.freeze([0, 0, 0]);
const MAX_DETAIL = 120;
const MAX_STATION_ID_LENGTH = 64;
const MOD_DESTROYED_FLAG = "lneModDestroyedAt";
const SOV_TAG_KEY = "lneSovStructureId";
const WORLD_KEY = "lneWorld";
const MAX_SOV_ID_LENGTH = 64;
const FC_TAG_KEY = "lneFreeCorpStructureKey";
const FC_KEY_RE = /^lne:fc:st:[1-9][0-9]{0,9}:[1-9][0-9]{0,5}$/;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isFn = (o, name) => o !== null && typeof o === "object" && typeof o[name] === "function";
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail });
const unavailable = (detail) => refuse(REASONS.UNAVAILABLE, detail);
const runDirect = (fn) => fn();

function isTag(tag, allowNullWorld = false) {
  return tag !== null && typeof tag === "object" && typeof tag.stationId === "string" && tag.stationId !== ""
    && tag.stationId.length <= MAX_STATION_ID_LENGTH
    && ((Number.isSafeInteger(tag.world) && tag.world >= 0) || (allowNullWorld && tag.world === null));
}

function isVector(p) {
  return p !== null && typeof p === "object" && [p.x, p.y, p.z].every(Number.isFinite);
}

function tagOfRow(row) {
  const flags = row && row.devFlags;
  if (!flags || typeof flags !== "object" || typeof flags.lneStationId !== "string" || flags.lneStationId === "") {
    return null;
  }
  return Object.freeze({ stationId: flags.lneStationId,
    world: Number.isSafeInteger(flags.lneWorld) ? flags.lneWorld : null });
}

function isSovTag(tag, allowNullWorld = false) {
  return tag !== null && typeof tag === "object" && typeof tag.sovStructureId === "string"
    && tag.sovStructureId !== "" && tag.sovStructureId.length <= MAX_SOV_ID_LENGTH
    && ((Number.isSafeInteger(tag.world) && tag.world >= 0) || (allowNullWorld && tag.world === null));
}

function sovTagOfRow(row) {
  const flags = row && row.devFlags;
  if (!flags || typeof flags !== "object" || typeof flags[SOV_TAG_KEY] !== "string" || flags[SOV_TAG_KEY] === "") {
    return null;
  }
  return Object.freeze({ sovStructureId: flags[SOV_TAG_KEY],
    world: Number.isSafeInteger(flags[WORLD_KEY]) ? flags[WORLD_KEY] : null });
}

function isFcTag(tag, allowNullWorld = false) {
  return tag !== null && typeof tag === "object" && typeof tag.fcKey === "string" && FC_KEY_RE.test(tag.fcKey)
    && ((Number.isSafeInteger(tag.world) && tag.world >= 0) || (allowNullWorld && tag.world === null));
}

function fcTagOfRow(row) {
  const flags = row && row.devFlags;
  if (!flags || typeof flags !== "object" || typeof flags[FC_TAG_KEY] !== "string" || flags[FC_TAG_KEY] === "") {
    return null;
  }
  return Object.freeze({ fcKey: flags[FC_TAG_KEY],
    world: Number.isSafeInteger(flags[WORLD_KEY]) ? flags[WORLD_KEY] : null });
}

const STATION_KIND = Object.freeze({
  isTag,
  tagOf: tagOfRow,
  same: (a, b) => a.stationId === b.stationId && a.world === b.world,
  flagsOf: (tag) => ({ lneStationId: tag.stationId, [WORLD_KEY]: tag.world }),
});
const SOV_KIND = Object.freeze({
  isTag: isSovTag,
  tagOf: sovTagOfRow,
  same: (a, b) => a.sovStructureId === b.sovStructureId && a.world === b.world,
  flagsOf: (tag) => ({ [SOV_TAG_KEY]: tag.sovStructureId, [WORLD_KEY]: tag.world }),
});
const FC_KIND = Object.freeze({
  isTag: isFcTag,
  tagOf: fcTagOfRow,
  same: (a, b) => a.fcKey === b.fcKey && a.world === b.world,
  flagsOf: (tag) => ({ [FC_TAG_KEY]: tag.fcKey, [WORLD_KEY]: tag.world }),
});

function tagMatches(row, tag, kind = STATION_KIND) {
  const own = kind.tagOf(row);
  return own !== null && kind.same(own, tag);
}

const timeOrNull = (v) => {
  const n = typeof v === "number" ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
};

function toView(row, kind = STATION_KIND) {
  const position = row.position && typeof row.position === "object" ? row.position : {};
  const access = row.accessProfile && typeof row.accessProfile === "object" ? row.accessProfile : {};
  return Object.freeze({
    structureId: Number(row.structureID),
    tag: kind.tagOf(row),
    typeId: Number(row.typeID),
    systemId: Number(row.solarSystemID),
    ownerCorpId: Number(row.ownerCorpID),
    allianceId: isId(row.allianceID) ? row.allianceID : null,
    state: Number(row.state),
    stateEndsAt: timeOrNull(row.stateEndsAt),
    upkeepState: Number(row.upkeepState),
    hasQuantumCore: row.hasQuantumCore === true,
    docking: String(access.docking || ""),
    tethering: String(access.tethering || ""),
    destroyedAt: timeOrNull(row.destroyedAt),
    modDestroyed: timeOrNull(row.devFlags && row.devFlags[MOD_DESTROYED_FLAG]) !== null,
    position: Object.freeze({ x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 }),
    name: String(row.name || ""),
  });
}

function vendorRefusal(result, map = {}) {
  const msg = String((result && result.errorMsg) || "UNKNOWN").slice(0, MAX_DETAIL);
  return Object.prototype.hasOwnProperty.call(map, msg) ? refuse(map[msg], msg) : refuse(REASONS.WRITE_FAILED, msg);
}

function checkStructureSeamsFrom(vendor) {
  try {
    if (!vendor || typeof vendor !== "object") return unavailable("vendor");
    for (const key of Object.keys(PATHS)) {
      const mod = vendor[key];
      if (!mod || typeof mod !== "object") return unavailable(PATHS[key]);
      for (const name of REQUIRED_FUNCTIONS[key]) if (!isFn(mod, name)) return unavailable(`${PATHS[key]}.${name}`);
    }
    if (typeof vendor.state.STRUCTURES_TABLE !== "string" || vendor.state.STRUCTURES_TABLE === "") {
      return unavailable("STRUCTURES_TABLE");
    }
    const states = readStructureStatesFrom(vendor);
    return states.ok ? { ok: true } : states;
  } catch (err) {
    return unavailable(detailOf(err));
  }
}

function readStructureStatesFrom(vendor) {
  try {
    const c = vendor && vendor.constants;
    const table = c && c.STRUCTURE_STATE;
    const upkeepTable = c && c.STRUCTURE_UPKEEP_STATE;
    if (!table || typeof table !== "object") return unavailable("STRUCTURE_STATE");
    if (!upkeepTable || typeof upkeepTable !== "object") return unavailable("STRUCTURE_UPKEEP_STATE");
    const states = {};
    for (const name of STATE_NAMES) {
      if (!Number.isSafeInteger(table[name])) return unavailable(`STRUCTURE_STATE.${name}`);
      states[name] = table[name];
    }
    for (const name of OPTIONAL_STATE_NAMES) if (Number.isSafeInteger(table[name])) states[name] = table[name];
    const upkeep = {};
    for (const name of UPKEEP_NAMES) {
      if (!Number.isSafeInteger(upkeepTable[name])) return unavailable(`STRUCTURE_UPKEEP_STATE.${name}`);
      upkeep[name] = upkeepTable[name];
    }
    return { ok: true, states: Object.freeze(states), upkeep: Object.freeze(upkeep) };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function listRows(state) {
  const rows = state.listStructures({ includeDestroyed: true, refresh: false });
  return Array.isArray(rows) ? rows : [];
}

function listTaggedStructuresFrom(vendor, kind = STATION_KIND) {
  const state = vendor && vendor.state;
  if (!isFn(state, "listStructures")) return unavailable("listStructures");
  try {
    return { ok: true, rows: listRows(state).filter((row) => kind.tagOf(row) !== null).map((row) => toView(row, kind)) };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function readRow(state, structureId) {
  const row = state.getStructureByID(structureId, { refresh: false });
  return row && typeof row === "object" ? row : null;
}

function getStructureFrom(vendor, structureId, kind = STATION_KIND) {
  const state = vendor && vendor.state;
  if (!isFn(state, "getStructureByID")) return unavailable("getStructureByID");
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  try {
    const row = readRow(state, structureId);
    return { ok: true, row: row === null ? null : toView(row, kind) };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function isStructureTypeKnownFrom(vendor, typeId) {
  const state = vendor && vendor.state;
  if (!isFn(state, "getStructureTypeByID")) return unavailable("getStructureTypeByID");
  if (!isId(typeId)) return refuse(REASONS.INVALID_INPUT, "typeId");
  try {
    const type = state.getStructureTypeByID(typeId);
    return { ok: true, known: Boolean(type && typeof type === "object") };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function listPlacementAnchorsFrom(vendor, systemId) {
  const worldData = vendor && vendor.worldData;
  if (!isFn(worldData, "getCelestialsForSystem")) return unavailable("getCelestialsForSystem");
  if (!isId(systemId)) return refuse(REASONS.INVALID_INPUT, "systemId");
  try {
    const rows = worldData.getCelestialsForSystem(systemId);
    const anchors = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || !isId(row.itemID) || !isId(row.typeID) || !isVector(row.position)) continue;
      const radius = Number.isFinite(row.radius) && row.radius > 0 ? row.radius : 0;
      anchors.push(Object.freeze({ itemId: row.itemID,
        position: Object.freeze({ x: row.position.x, y: row.position.y, z: row.position.z }), radius }));
    }
    anchors.sort((a, b) => a.itemId - b.itemId);
    return { ok: true, anchors };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function validatePlacementFrom(vendor, input) {
  const placement = vendor && vendor.placement;
  if (!isFn(placement, "validateDeploymentPlacement")) return unavailable("validateDeploymentPlacement");
  const { systemId, typeId, position } = input || {};
  if (!isId(systemId) || !isId(typeId) || !isVector(position)) return refuse(REASONS.INVALID_INPUT, "placement");
  try {
    const result = placement.validateDeploymentPlacement({ solarSystemID: systemId, typeID: typeId,
      position: { x: position.x, y: position.y, z: position.z } });
    if (result && result.success === true) return { ok: true, valid: true };
    const msg = String((result && result.errorMsg) || "UNKNOWN").slice(0, MAX_DETAIL);
    if (msg === "DEPLOYMENT_CONFLICT") {
      const data = (result && result.data) || {};
      const blocker = isId(data.blockerItemID) ? data.blockerItemID : data.ballTypeID;
      return { ok: true, valid: false, conflict: `DEPLOYMENT_CONFLICT:${String(blocker)}`.slice(0, MAX_DETAIL) };
    }
    return { ok: true, valid: false, conflict: msg };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function validCreateInput(input) {
  const i = input || {};
  if (!isId(i.typeId)) return "typeId";
  if (!isId(i.systemId)) return "systemId";
  if (!isId(i.ownerCorpId)) return "ownerCorpId";
  if (!isVector(i.position)) return "position";
  if (!Number.isSafeInteger(i.state)) return "state";
  if (i.stateEndsAt !== null && !isTime(i.stateEndsAt)) return "stateEndsAt";
  if (!i.condition || typeof i.condition !== "object") return "condition";
  if (!DOCKING_POLICIES.includes(i.docking)) return "docking";
  if (typeof i.quantumCore !== "boolean") return "quantumCore";
  if (i.name !== null && i.name !== undefined && (typeof i.name !== "string" || i.name === "")) return "name";
  if (!isTime(i.at)) return "at";
  return null;
}

function createTaggedStructureFrom(vendor, input, guard = runDirect) {
  return createWithKind(STATION_KIND, vendor, input, guard);
}

function createWithKind(kind, vendor, input, guard) {
  if (!input || !kind.isTag(input.tag)) return refuse(REASONS.TAG_REQUIRED);
  const state = vendor && vendor.state;
  for (const name of ["createStructure", "getStructureTypeByID", "listStructures"]) {
    if (!isFn(state, name)) return unavailable(name);
  }
  const upkeep = readStructureStatesFrom(vendor);
  if (!upkeep.ok) return upkeep;
  const bad = validCreateInput(input);
  if (bad !== null) return refuse(REASONS.INVALID_INPUT, bad);
  try {
    if (!state.getStructureTypeByID(input.typeId)) return refuse(REASONS.TYPE_UNKNOWN, String(input.typeId));
    const existing = listRows(state).find((row) => !row.destroyedAt && tagMatches(row, input.tag, kind));
    if (existing) return { ok: false, reason: REASONS.ALREADY_TAGGED, structureId: Number(existing.structureID) };
    const record = {
      typeID: input.typeId,
      ownerCorpID: input.ownerCorpId,
      allianceID: null,
      solarSystemID: input.systemId,
      position: { x: input.position.x, y: input.position.y, z: input.position.z },
      rotation: [...ROTATION],
      state: input.state,
      stateStartedAt: input.at,
      stateEndsAt: input.stateEndsAt,
      upkeepState: upkeep.upkeep.FULL_POWER,
      hasQuantumCore: input.quantumCore,
      profileID: PROFILE_ID,
      accessProfile: { docking: input.docking, tethering: TETHERING_NONE },
      conditionState: { ...input.condition },
      devFlags: kind.flagsOf(input.tag),
    };
    if (typeof input.name === "string") {
      record.name = input.name;
      record.itemName = input.name;
    }
    const result = guard(() => state.createStructure(record));
    if (!result || result.success !== true) return vendorRefusal(result);
    const id = Number(result.data && result.data.structureID);
    return isId(id) ? { ok: true, structureId: id } : refuse(REASONS.WRITE_FAILED, "structureID");
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

const PATCH_KEYS = Object.freeze(["state", "stateEndsAt", "condition", "ownerCorpId", "allianceId", "upkeepState",
  "docking", "quantumCore", "at"]);

function validPatch(patch) {
  if (!patch || typeof patch !== "object") return "patch";
  for (const key of Object.keys(patch)) if (!PATCH_KEYS.includes(key)) return key;
  if (!isTime(patch.at)) return "at";
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  if (has("state") && !Number.isSafeInteger(patch.state)) return "state";
  if (has("stateEndsAt") && patch.stateEndsAt !== null && !isTime(patch.stateEndsAt)) return "stateEndsAt";
  if (has("condition") && (!patch.condition || typeof patch.condition !== "object")) return "condition";
  if (has("ownerCorpId") && !isId(patch.ownerCorpId)) return "ownerCorpId";
  if (has("allianceId") && patch.allianceId !== null && !isId(patch.allianceId)) return "allianceId";
  if (has("upkeepState") && !Number.isSafeInteger(patch.upkeepState)) return "upkeepState";
  if (has("docking") && !DOCKING_POLICIES.includes(patch.docking)) return "docking";
  if (has("quantumCore") && typeof patch.quantumCore !== "boolean") return "quantumCore";
  return null;
}

function applyPatch(cur, patch) {
  const has = (k) => Object.prototype.hasOwnProperty.call(patch, k);
  const next = { ...cur, devFlags: { ...(cur.devFlags || {}) } };
  if (has("state") && patch.state !== cur.state) {
    next.state = patch.state;
    next.stateStartedAt = patch.at;
  }
  if (has("stateEndsAt")) next.stateEndsAt = patch.stateEndsAt;
  if (has("condition")) next.conditionState = { ...patch.condition };
  if (has("ownerCorpId")) {
    next.ownerCorpID = patch.ownerCorpId;
    next.ownerID = patch.ownerCorpId;
  }
  if (has("allianceId")) next.allianceID = patch.allianceId;
  if (has("upkeepState")) next.upkeepState = patch.upkeepState;
  if (has("docking")) next.accessProfile = { ...(cur.accessProfile || {}), docking: patch.docking };
  if (has("quantumCore")) next.hasQuantumCore = patch.quantumCore;
  return next;
}

function ownRow(state, structureId, tag, kind = STATION_KIND) {
  const row = readRow(state, structureId);
  if (row === null) return refuse(REASONS.NOT_FOUND);
  if (!tagMatches(row, tag, kind)) return refuse(REASONS.TAG_MISMATCH);
  return { ok: true, row };
}

function updateTaggedStructureFrom(vendor, structureId, tag, patch, guard = runDirect) {
  return updateWithKind(STATION_KIND, vendor, structureId, tag, patch, guard);
}

function updateWithKind(kind, vendor, structureId, tag, patch, guard) {
  if (!kind.isTag(tag)) return refuse(REASONS.TAG_REQUIRED);
  const state = vendor && vendor.state;
  for (const name of ["updateStructureRecord", "getStructureByID"]) if (!isFn(state, name)) return unavailable(name);
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  const bad = validPatch(patch);
  if (bad !== null) return refuse(REASONS.INVALID_INPUT, bad);
  try {
    const own = ownRow(state, structureId, tag, kind);
    if (!own.ok) return own;
    if (own.row.destroyedAt) return refuse(REASONS.DESTROYED);
    let mismatch = false;
    const result = guard(() => state.updateStructureRecord(structureId, (cur) => {
      if (!tagMatches(cur, tag, kind) || cur.destroyedAt) {
        mismatch = true;
        return cur;
      }
      return applyPatch(cur, patch);
    }));
    if (mismatch) return refuse(REASONS.TAG_MISMATCH, "updater");
    if (!result || result.success !== true) return vendorRefusal(result, { STRUCTURE_NOT_FOUND: REASONS.NOT_FOUND });
    return { ok: true };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function destroyTaggedStructureFrom(vendor, structureId, tag, at, guard = runDirect) {
  return destroyWithKind(STATION_KIND, vendor, structureId, tag, at, guard);
}

function destroyWithKind(kind, vendor, structureId, tag, at, guard) {
  if (!kind.isTag(tag, true)) return refuse(REASONS.TAG_REQUIRED);
  const state = vendor && vendor.state;
  for (const name of ["destroyStructure", "getStructureByID"]) if (!isFn(state, name)) return unavailable(name);
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  if (!isTime(at)) return refuse(REASONS.INVALID_INPUT, "at");
  try {
    const own = ownRow(state, structureId, tag, kind);
    if (!own.ok) return own;
    if (own.row.destroyedAt) return { ok: true, alreadyDestroyed: true };
    const result = guard(() => state.destroyStructure(structureId, { nowMs: at }));
    if (!result || result.success !== true) return vendorRefusal(result, { STRUCTURE_NOT_FOUND: REASONS.NOT_FOUND });
    return markModDestroyed(state, structureId, at, guard)
      ? { ok: true, alreadyDestroyed: false }
      : { ok: true, alreadyDestroyed: false, markFailed: true };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function markModDestroyed(state, structureId, at, guard) {
  try {
    if (!isFn(state, "updateStructureRecord")) return false;
    const marked = guard(() => state.updateStructureRecord(structureId, (cur) => ({ ...cur,
      devFlags: { ...(cur.devFlags || {}), [MOD_DESTROYED_FLAG]: at } }), { nowMs: at }));
    return Boolean(marked && marked.success === true);
  } catch (err) {
    return false;
  }
}

function removeTaggedStructureFrom(vendor, structureId, tag, guard = runDirect) {
  return removeWithKind(STATION_KIND, vendor, structureId, tag, guard);
}

function removeWithKind(kind, vendor, structureId, tag, guard) {
  if (!kind.isTag(tag, true)) return refuse(REASONS.TAG_REQUIRED);
  const state = vendor && vendor.state;
  for (const name of ["removeStructure", "getStructureByID"]) if (!isFn(state, name)) return unavailable(name);
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  try {
    const own = ownRow(state, structureId, tag, kind);
    if (!own.ok) return own;
    const result = guard(() => state.removeStructure(structureId, {}));
    if (!result || result.success !== true) {
      return vendorRefusal(result, { STRUCTURE_NOT_EMPTY: REASONS.NOT_EMPTY, STRUCTURE_NOT_FOUND: REASONS.NOT_FOUND });
    }
    return { ok: true };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function flushStructuresFrom(vendor) {
  const failed = (detail) => ({ ok: false, reason: REASONS.FLUSH_FAILED, ambiguous: true, detail });
  try {
    const store = vendor && vendor.gameStore;
    const table = vendor && vendor.state && vendor.state.STRUCTURES_TABLE;
    if (!isFn(store, "flushTableSync") || typeof table !== "string" || table === "") return failed("seam");
    const result = store.flushTableSync(table);
    if (!result || result.success !== true) {
      return failed(String((result && result.errorMsg) || "UNKNOWN").slice(0, MAX_DETAIL));
    }
    return { ok: true };
  } catch (err) {
    return failed(detailOf(err));
  }
}

function listSovTaggedStructuresFrom(vendor) {
  return listTaggedStructuresFrom(vendor, SOV_KIND);
}

function getSovStructureFrom(vendor, structureId) {
  return getStructureFrom(vendor, structureId, SOV_KIND);
}

function createSovTaggedStructureFrom(vendor, input, guard = runDirect) {
  return createWithKind(SOV_KIND, vendor, input, guard);
}

function updateSovTaggedStructureFrom(vendor, structureId, tag, patch, guard = runDirect) {
  return updateWithKind(SOV_KIND, vendor, structureId, tag, patch, guard);
}

function destroySovTaggedStructureFrom(vendor, structureId, tag, at, guard = runDirect) {
  return destroyWithKind(SOV_KIND, vendor, structureId, tag, at, guard);
}

function removeSovTaggedStructureFrom(vendor, structureId, tag, guard = runDirect) {
  return removeWithKind(SOV_KIND, vendor, structureId, tag, guard);
}

function listFcTaggedStructuresFrom(vendor) {
  return listTaggedStructuresFrom(vendor, FC_KIND);
}

function getFcStructureFrom(vendor, structureId) {
  return getStructureFrom(vendor, structureId, FC_KIND);
}

function createFcTaggedStructureFrom(vendor, input, guard = runDirect) {
  return createWithKind(FC_KIND, vendor, input, guard);
}

function updateFcTaggedStructureFrom(vendor, structureId, tag, patch, guard = runDirect) {
  return updateWithKind(FC_KIND, vendor, structureId, tag, patch, guard);
}

function destroyFcTaggedStructureFrom(vendor, structureId, tag, at, guard = runDirect) {
  return destroyWithKind(FC_KIND, vendor, structureId, tag, at, guard);
}

function removeFcTaggedStructureFrom(vendor, structureId, tag, guard = runDirect) {
  return removeWithKind(FC_KIND, vendor, structureId, tag, guard);
}

function sovPositionFrom(vendor, systemId, offsetM) {
  const placement = vendor && vendor.sovPlacement;
  if (!isFn(placement, "getDefaultHubPosition")) return unavailable("getDefaultHubPosition");
  if (!isId(systemId)) return refuse(REASONS.INVALID_INPUT, "systemId");
  if (!Number.isFinite(offsetM) || offsetM < 0) return refuse(REASONS.INVALID_INPUT, "offsetM");
  try {
    const p = placement.getDefaultHubPosition(systemId);
    if (!isVector(p)) return refuse(SOV_REASONS.NO_SUN, String(systemId));
    return { ok: true, position: Object.freeze({ x: p.x + offsetM, y: p.y, z: p.z }) };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function changedStationIds(payload) {
  if (!payload || typeof payload !== "object") return [];
  const systems = new Set(Array.isArray(payload.systemIDs) ? payload.systemIDs : []);
  if (systems.size === 0) return [];
  const tagged = (rows) => {
    const map = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (row && tagOfRow(row) !== null && isId(row.structureID)) map.set(row.structureID, row);
    }
    return map;
  };
  const prev = tagged(payload.previousRows);
  const next = tagged(payload.nextRows);
  const ids = new Set();
  for (const [id, row] of [...prev, ...next]) {
    if (!systems.has(row.solarSystemID)) continue;
    const a = prev.get(id);
    const b = next.get(id);
    if (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b)) continue;
    if (a !== undefined) ids.add(tagOfRow(a).stationId);
    if (b !== undefined) ids.add(tagOfRow(b).stationId);
  }
  return [...ids].sort();
}

function createStructureSeam(deps) {
  let vendor = null;
  let selfWrite = false;
  const subscribers = new Set();
  let unregisterVendor = null;

  function load() {
    if (vendor !== null) return { ok: true };
    const requireGame = deps && deps.requireGame;
    if (typeof requireGame !== "function") return unavailable("requireGame");
    const loaded = {};
    for (const key of Object.keys(PATHS)) {
      let r;
      try {
        r = requireGame(PATHS[key]);
      } catch (err) {
        return unavailable(`${PATHS[key]}: ${detailOf(err)}`);
      }
      if (!r || r.ok !== true || !r.exports || typeof r.exports !== "object") {
        return unavailable(`${PATHS[key]}: ${String((r && r.reason) || "not loaded")}`.slice(0, MAX_DETAIL));
      }
      loaded[key] = r.exports;
    }
    vendor = Object.freeze(loaded);
    return { ok: true };
  }

  function guard(fn) {
    const outer = selfWrite;
    selfWrite = true;
    try {
      return fn();
    } finally {
      selfWrite = outer;
    }
  }

  function onVendorChange(payload) {
    if (selfWrite || subscribers.size === 0) return;
    try {
      const stationIds = changedStationIds(payload);
      if (stationIds.length === 0) return;
      for (const fn of [...subscribers]) {
        try {
          fn({ stationIds: [...stationIds] });
        } catch (err) {
        }
      }
    } catch (err) {
    }
  }

  const withVendor = (fn) => (...args) => {
    const l = load();
    return l.ok ? fn(...args) : l;
  };

  let sovPlacement = null;
  function sovPosition(systemId, offsetM) {
    const l = load();
    if (!l.ok) return l;
    if (sovPlacement === null) {
      let r;
      try {
        r = deps.requireGame(SOV_PLACEMENT_PATH);
      } catch (err) {
        return unavailable(`${SOV_PLACEMENT_PATH}: ${detailOf(err)}`);
      }
      if (!r || r.ok !== true || !r.exports || typeof r.exports !== "object") {
        return unavailable(`${SOV_PLACEMENT_PATH}: ${String((r && r.reason) || "not loaded")}`.slice(0, MAX_DETAIL));
      }
      sovPlacement = r.exports;
    }
    return sovPositionFrom({ ...vendor, sovPlacement }, systemId, offsetM);
  }

  function subscribeStructureChanges(fn) {
    if (typeof fn !== "function") return refuse(REASONS.INVALID_INPUT, "listener");
    const l = load();
    if (!l.ok) return l;
    if (unregisterVendor === null) {
      if (!isFn(vendor.state, "registerStructureChangeListener")) return unavailable("registerStructureChangeListener");
      try {
        const off = vendor.state.registerStructureChangeListener(onVendorChange);
        unregisterVendor = typeof off === "function" ? off : () => {};
      } catch (err) {
        return refuse(REASONS.SEAM_ERROR, detailOf(err));
      }
    }
    const entry = (evt) => fn(evt);
    subscribers.add(entry);
    let active = true;
    return {
      ok: true,
      unsubscribe() {
        if (!active) return;
        active = false;
        subscribers.delete(entry);
        if (subscribers.size === 0 && unregisterVendor !== null) {
          const off = unregisterVendor;
          unregisterVendor = null;
          try {
            off();
          } catch (err) {
          }
        }
      },
    };
  }

  return Object.freeze({
    checkStructureSeams: withVendor(() => checkStructureSeamsFrom(vendor)),
    readStructureStates: withVendor(() => readStructureStatesFrom(vendor)),
    listTaggedStructures: withVendor(() => listTaggedStructuresFrom(vendor)),
    getStructure: withVendor((id) => getStructureFrom(vendor, id)),
    isStructureTypeKnown: withVendor((typeId) => isStructureTypeKnownFrom(vendor, typeId)),
    listPlacementAnchors: withVendor((systemId) => listPlacementAnchorsFrom(vendor, systemId)),
    validatePlacement: withVendor((input) => validatePlacementFrom(vendor, input)),
    createTaggedStructure: withVendor((input) => createTaggedStructureFrom(vendor, input, guard)),
    updateTaggedStructure: withVendor((id, tag, patch) => updateTaggedStructureFrom(vendor, id, tag, patch, guard)),
    destroyTaggedStructure: withVendor((id, tag, at) => destroyTaggedStructureFrom(vendor, id, tag, at, guard)),
    removeTaggedStructure: withVendor((id, tag) => removeTaggedStructureFrom(vendor, id, tag, guard)),
    flushStructures() {
      const l = load();
      return l.ok ? flushStructuresFrom(vendor)
        : { ok: false, reason: REASONS.FLUSH_FAILED, ambiguous: true, detail: l.detail };
    },
    subscribeStructureChanges,
    listSovTaggedStructures: withVendor(() => listSovTaggedStructuresFrom(vendor)),
    getSovStructure: withVendor((id) => getSovStructureFrom(vendor, id)),
    createSovTaggedStructure: withVendor((input) => createSovTaggedStructureFrom(vendor, input, guard)),
    updateSovTaggedStructure: withVendor((id, tag, patch) => updateSovTaggedStructureFrom(vendor, id, tag, patch,
      guard)),
    destroySovTaggedStructure: withVendor((id, tag, at) => destroySovTaggedStructureFrom(vendor, id, tag, at, guard)),
    removeSovTaggedStructure: withVendor((id, tag) => removeSovTaggedStructureFrom(vendor, id, tag, guard)),
    sovPosition,
    listFcTaggedStructures: withVendor(() => listFcTaggedStructuresFrom(vendor)),
    getFcStructure: withVendor((id) => getFcStructureFrom(vendor, id)),
    createFcTaggedStructure: withVendor((input) => createFcTaggedStructureFrom(vendor, input, guard)),
    updateFcTaggedStructure: withVendor((id, tag, patch) => updateFcTaggedStructureFrom(vendor, id, tag, patch,
      guard)),
    destroyFcTaggedStructure: withVendor((id, tag, at) => destroyFcTaggedStructureFrom(vendor, id, tag, at, guard)),
    removeFcTaggedStructure: withVendor((id, tag) => removeFcTaggedStructureFrom(vendor, id, tag, guard)),
  });
}

const STATION_SEAM_METHODS = Object.freeze(["checkStructureSeams", "readStructureStates", "listTaggedStructures",
  "getStructure", "isStructureTypeKnown", "listPlacementAnchors", "validatePlacement", "createTaggedStructure",
  "updateTaggedStructure", "destroyTaggedStructure", "removeTaggedStructure", "flushStructures",
  "subscribeStructureChanges"]);
const SOV_SEAM_METHODS = Object.freeze(["listSovTaggedStructures", "getSovStructure", "createSovTaggedStructure",
  "updateSovTaggedStructure", "destroySovTaggedStructure", "removeSovTaggedStructure", "sovPosition"]);
const FC_SEAM_METHODS = Object.freeze(["listFcTaggedStructures", "getFcStructure", "createFcTaggedStructure",
  "updateFcTaggedStructure", "destroyFcTaggedStructure", "removeFcTaggedStructure"]);
const SEAM_METHODS = Object.freeze([...STATION_SEAM_METHODS, ...SOV_SEAM_METHODS, ...FC_SEAM_METHODS]);

module.exports = {
  PATHS,
  REQUIRED_FUNCTIONS,
  REASONS,
  SEAM_METHODS,
  STATION_SEAM_METHODS,
  SOV_SEAM_METHODS,
  FC_SEAM_METHODS,
  FC_TAG_KEY,
  SOV_REASONS,
  SOV_TAG_KEY,
  SOV_PLACEMENT_PATH,
  MOD_DESTROYED_FLAG,
  tagOfRow,
  sovTagOfRow,
  isSovTag,
  fcTagOfRow,
  isFcTag,
  timeOrNull,
  isTag,
  isVector,
  validCreateInput,
  validPatch,
  changedStationIds,
  checkStructureSeamsFrom,
  readStructureStatesFrom,
  listTaggedStructuresFrom,
  getStructureFrom,
  isStructureTypeKnownFrom,
  listPlacementAnchorsFrom,
  validatePlacementFrom,
  createTaggedStructureFrom,
  updateTaggedStructureFrom,
  destroyTaggedStructureFrom,
  removeTaggedStructureFrom,
  flushStructuresFrom,
  listSovTaggedStructuresFrom,
  getSovStructureFrom,
  createSovTaggedStructureFrom,
  updateSovTaggedStructureFrom,
  destroySovTaggedStructureFrom,
  removeSovTaggedStructureFrom,
  sovPositionFrom,
  listFcTaggedStructuresFrom,
  getFcStructureFrom,
  createFcTaggedStructureFrom,
  updateFcTaggedStructureFrom,
  destroyFcTaggedStructureFrom,
  removeFcTaggedStructureFrom,
  createStructureSeam,
};
