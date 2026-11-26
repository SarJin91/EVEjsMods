"use strict";

const { tagOfRow, fcTagOfRow, timeOrNull } = require("./structures");

const PATHS = Object.freeze({
  state: "services/structure/structureState",
  constants: "services/structure/structureConstants",
  assetSafety: "services/structure/structureAssetSafetyState",
  corp: "services/corporation/corporationState",
  corpRuntime: "services/corporation/corporationRuntimeState",
  control: "services/online/characterControlRuntime",
  character: "services/character/characterState",
  gameStore: "gameStore/index",
});

const REQUIRED = Object.freeze({
  state: Object.freeze(["peekStructures", "getStructureByID", "applyAdminStructureDamage",
    "resolveStructureEffectiveHitpoints", "resolveStructureLayerDamageLimits"]),
  constants: Object.freeze([]),
  assetSafety: Object.freeze(["isAssetSafetyDisabledForStructure"]),
  corp: Object.freeze(["getCorporationRecord", "isNpcCorporationID"]),
  corpRuntime: Object.freeze(["listCorporationMembers"]),
  control: Object.freeze(["getCharacterControlSnapshot"]),
  character: Object.freeze(["peekCharacterRecord"]),
  gameStore: Object.freeze(["flushTableSync"]),
});

const REQUIRED_CONSTANTS = Object.freeze({
  STRUCTURE_STATE: Object.freeze(["SHIELD_VULNERABLE", "ARMOR_VULNERABLE", "HULL_VULNERABLE"]),
  STRUCTURE_UPKEEP_STATE: Object.freeze(["ABANDONED"]),
  STRUCTURE_FAMILY: Object.freeze([]),
});

const REASONS = Object.freeze({
  UNAVAILABLE: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE",
  SEAM_ERROR: "SEAM_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  DESTROYED: "DESTROYED",
  TAGGED: "TAGGED",
  STATE_MISMATCH: "STATE_MISMATCH",
  ASSET_SAFETY_UNAVAILABLE: "ASSET_SAFETY_UNAVAILABLE",
  VENDOR_REFUSED: "VENDOR_REFUSED",
});

const CONTROL_UNAVAILABLE_CODE = "CHARACTER_CONTROL_UNAVAILABLE";

const LAYER_STATE = Object.freeze({ shield: "SHIELD_VULNERABLE", armor: "ARMOR_VULNERABLE", hull: "HULL_VULNERABLE" });
const SIEGE_HIT_AMOUNT = 1;
const FILETIME_EPOCH = 116444736000000000n;
const FILETIME_PER_MS = 10000n;
const MAX_DETAIL = 120;
const NOTICES_CONSUMER = "notices";
const { MARKER_KEY: TRIG_MARKER_KEY } = require("./trigBridge");
const MAX_INDEX_MEMOS = 4;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isFn = (o, name) => o !== null && typeof o === "object" && typeof o[name] === "function";
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason, detail });
const unavailable = (detail) => refuse(REASONS.UNAVAILABLE, detail);
const nonNegative = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function hasTrigMarker(row) {
  const flags = row && typeof row === "object" ? row.devFlags : null;
  const m = flags && typeof flags === "object" ? flags[TRIG_MARKER_KEY] : null;
  return Boolean(m && typeof m === "object");
}

function nameOf(table, value) {
  for (const key of Object.keys(table)) if (table[key] === value) return key;
  return null;
}

function checkSeamsFrom(vendor) {
  try {
    if (!vendor || typeof vendor !== "object") return unavailable("vendor");
    for (const key of Object.keys(PATHS)) {
      const mod = vendor[key];
      if (!mod || typeof mod !== "object") return unavailable(PATHS[key]);
      for (const name of REQUIRED[key]) if (!isFn(mod, name)) return unavailable(`${PATHS[key]}.${name}`);
    }
    if (typeof vendor.state.STRUCTURES_TABLE !== "string" || vendor.state.STRUCTURES_TABLE === "") {
      return unavailable("STRUCTURES_TABLE");
    }
    for (const table of Object.keys(REQUIRED_CONSTANTS)) {
      const obj = vendor.constants[table];
      if (!obj || typeof obj !== "object") return unavailable(table);
      for (const name of REQUIRED_CONSTANTS[table]) {
        if (!Number.isSafeInteger(obj[name])) return unavailable(`${table}.${name}`);
      }
    }
    return { ok: true };
  } catch (err) {
    return unavailable(detailOf(err));
  }
}

function stateNameOf(vendor, stateId) {
  return nameOf(vendor.constants.STRUCTURE_STATE, stateId) || `STATE_${String(stateId)}`;
}

function summaryOf(vendor, row) {
  const stateId = Number(row.state);
  return {
    structureId: Number(row.structureID),
    systemId: Number(row.solarSystemID),
    typeId: Number(row.typeID),
    family: String(row.structureFamily || ""),
    size: String(row.structureSize || ""),
    ownerCorpId: Number(row.ownerCorpID),
    allianceId: isId(row.allianceID) ? row.allianceID : null,
    state: stateNameOf(vendor, stateId),
    stateEndsAt: timeOrNull(row.stateEndsAt),
    trig: hasTrigMarker(row),
  };
}

function validIndexOpts(opts) {
  const o = opts || {};
  if (!isTime(o.nowMs)) return "nowMs";
  if (!isTime(o.ttlMs)) return "ttlMs";
  if (!Array.isArray(o.families) || o.families.some((f) => typeof f !== "string" || f === "")) return "families";
  if (!isId(o.maxStructures)) return "maxStructures";
  return null;
}

function buildCandidateIndexFrom(vendor, opts) {
  const bad = validIndexOpts(opts);
  if (bad !== null) return refuse(REASONS.INVALID_INPUT, bad);
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const families = new Set(opts.families);
    const rows = vendor.state.peekStructures({ includeDestroyed: false });
    const picked = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== "object" || timeOrNull(row.destroyedAt) !== null) continue;
      if (!isId(row.structureID) || !isId(row.solarSystemID) || !isId(row.ownerCorpID)) continue;
      if (!families.has(String(row.structureFamily || "")) || tagOfRow(row) !== null || fcTagOfRow(row) !== null) {
        continue;
      }
      if (vendor.corp.isNpcCorporationID(row.ownerCorpID) === true) continue;
      picked.push(Object.freeze(summaryOf(vendor, row)));
    }
    picked.sort((a, b) => a.systemId - b.systemId || a.structureId - b.structureId);
    const truncated = picked.length > opts.maxStructures;
    const kept = truncated ? picked.slice(0, opts.maxStructures) : picked;
    const groups = new Map();
    for (const s of kept) {
      if (!groups.has(s.systemId)) groups.set(s.systemId, []);
      groups.get(s.systemId).push(s);
    }
    const bySystem = new Map();
    for (const [systemId, list] of groups) bySystem.set(systemId, Object.freeze(list));
    return { ok: true, bySystem, total: kept.length, truncated, builtAt: opts.nowMs };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function readRow(vendor, structureId) {
  const row = vendor.state.getStructureByID(structureId, { refresh: false });
  return row && typeof row === "object" ? row : null;
}

function assetSafetyOf(vendor, row) {
  if (vendor.assetSafety.isAssetSafetyDisabledForStructure(row) === true) return false;
  return Number(row.upkeepState) !== vendor.constants.STRUCTURE_UPKEEP_STATE.ABANDONED;
}

function viewOf(vendor, row) {
  const ehp = vendor.state.resolveStructureEffectiveHitpoints(row) || {};
  const limits = vendor.state.resolveStructureLayerDamageLimits(row) || {};
  const upkeepId = Number(row.upkeepState);
  return Object.freeze({
    ...summaryOf(vendor, row),
    name: String(row.name || ""),
    stateId: Number(row.state),
    destroyedAt: timeOrNull(row.destroyedAt),
    upkeep: nameOf(vendor.constants.STRUCTURE_UPKEEP_STATE, upkeepId) || `UPKEEP_${String(upkeepId)}`,
    ehp: Object.freeze({ shield: nonNegative(ehp.effectiveShieldCapacity), armor: nonNegative(ehp.effectiveArmorHP),
      hull: nonNegative(ehp.effectiveStructureHP) }),
    damageLimit: Object.freeze({ shield: nonNegative(limits.shield), armor: nonNegative(limits.armor),
      hull: nonNegative(limits.structure) }),
    assetSafety: assetSafetyOf(vendor, row),
    tagged: tagOfRow(row) !== null || fcTagOfRow(row) !== null,
  });
}

function readStructureFrom(vendor, structureId) {
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const row = readRow(vendor, structureId);
    return row === null ? refuse(REASONS.NOT_FOUND) : { ok: true, view: viewOf(vendor, row) };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function applySiegeHitFrom(vendor, structureId, layer) {
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  if (typeof layer !== "string" || !hasOwn(LAYER_STATE, layer)) return refuse(REASONS.INVALID_INPUT, "layer");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  let result;
  try {
    const row = readRow(vendor, structureId);
    if (row === null) return refuse(REASONS.NOT_FOUND);
    if (timeOrNull(row.destroyedAt) !== null) return refuse(REASONS.DESTROYED);
    if (tagOfRow(row) !== null || fcTagOfRow(row) !== null) return refuse(REASONS.TAGGED);
    if (Number(row.state) !== vendor.constants.STRUCTURE_STATE[LAYER_STATE[layer]]) {
      return { ok: false, reason: REASONS.STATE_MISMATCH, state: stateNameOf(vendor, Number(row.state)) };
    }
    if (layer === "hull" && !assetSafetyOf(vendor, row)) return refuse(REASONS.ASSET_SAFETY_UNAVAILABLE);
    result = vendor.state.applyAdminStructureDamage(structureId, layer, SIEGE_HIT_AMOUNT, {});
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
  if (!result || result.success !== true) {
    return refuse(REASONS.VENDOR_REFUSED, String((result && result.errorMsg) || "UNKNOWN").slice(0, MAX_DETAIL));
  }
  const destroyed = Boolean(result.data && result.data.destroy === true);
  let flushed = false;
  try {
    const flush = vendor.gameStore.flushTableSync(vendor.state.STRUCTURES_TABLE);
    flushed = Boolean(flush && flush.success === true);
  } catch (err) {
    flushed = false;
  }
  const after = readStructureFrom(vendor, structureId);
  return { ok: true, view: after.ok ? after.view : null, destroyed, flushed };
}

function readOwnerFaceFrom(vendor, corpId) {
  if (!isId(corpId)) return refuse(REASONS.INVALID_INPUT, "corpId");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const npc = vendor.corp.isNpcCorporationID(corpId) === true;
    const record = vendor.corp.getCorporationRecord(corpId);
    if (!record || typeof record !== "object") return refuse(REASONS.NOT_FOUND);
    const ceo = Number(record.ceoID);
    return { ok: true, ceoId: isId(ceo) ? ceo : null, npc };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function filetimeToMs(value) {
  let ft;
  if (typeof value === "bigint") ft = value;
  else if (typeof value === "number" && Number.isSafeInteger(value)) ft = BigInt(value);
  else if (typeof value === "string" && /^\d{1,30}$/.test(value.trim())) ft = BigInt(value.trim());
  else return null;
  if (ft <= FILETIME_EPOCH) return null;
  const ms = Number((ft - FILETIME_EPOCH) / FILETIME_PER_MS);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}

function readOwnerActivityFrom(vendor, corpId, opts) {
  if (!isId(corpId)) return refuse(REASONS.INVALID_INPUT, "corpId");
  const maxMembers = opts && opts.maxMembers;
  if (!isId(maxMembers)) return refuse(REASONS.INVALID_INPUT, "maxMembers");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const all = vendor.corpRuntime.listCorporationMembers(corpId);
    const list = Array.isArray(all) ? all : [];
    const truncated = list.length > maxMembers;
    let onlineNow = false;
    let lastSeenMs = null;
    let members = 0;
    for (const member of truncated ? list.slice(0, maxMembers) : list) {
      const characterId = Number(member && member.characterID);
      if (!isId(characterId)) continue;
      members += 1;
      try {
        const snapshot = vendor.control.getCharacterControlSnapshot(characterId);
        if (snapshot && snapshot.online === true) onlineNow = true;
      } catch (err) {
        if (!err || err.code !== CONTROL_UNAVAILABLE_CODE) throw err;
        onlineNow = true;
      }
      const record = vendor.character.peekCharacterRecord(characterId);
      if (!record || typeof record !== "object") continue;
      for (const seen of [filetimeToMs(record.lastLogonDateTime), filetimeToMs(record.lastLogoffDateTime)]) {
        if (seen !== null && (lastSeenMs === null || seen > lastSeenMs)) lastSeenMs = seen;
      }
    }
    return { ok: true, onlineNow, lastSeenMs, members, truncated };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function listOwnerMemberIdsFrom(vendor, corpId, opts) {
  if (!isId(corpId)) return refuse(REASONS.INVALID_INPUT, "corpId");
  const max = opts && opts.max;
  if (!isId(max)) return refuse(REASONS.INVALID_INPUT, "max");
  if (!vendor || !isFn(vendor.corpRuntime, "listCorporationMembers")) {
    return unavailable("corporationRuntimeState.listCorporationMembers");
  }
  try {
    const all = vendor.corpRuntime.listCorporationMembers(corpId);
    const ids = [];
    const seen = new Set();
    for (const member of Array.isArray(all) ? all : []) {
      const characterId = Number(member && member.characterID);
      if (!isId(characterId) || seen.has(characterId)) continue;
      seen.add(characterId);
      ids.push(characterId);
    }
    ids.sort((a, b) => a - b);
    return { ok: true, characterIds: ids.slice(0, max), truncated: ids.length > max };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function createPlayerStructureSeam(deps) {
  let vendor = null;
  const memos = new Map();

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
        return unavailable(`${PATHS[key]}: ${detailOf(err)}`.slice(0, MAX_DETAIL));
      }
      if (!r || r.ok !== true || !r.exports || typeof r.exports !== "object") {
        return unavailable(`${PATHS[key]}: ${String((r && r.reason) || "not loaded")}`.slice(0, MAX_DETAIL));
      }
      loaded[key] = r.exports;
    }
    vendor = Object.freeze(loaded);
    return { ok: true };
  }

  const withVendor = (fn) => (...args) => {
    const l = load();
    return l.ok ? fn(...args) : l;
  };

  function listCandidates(opts) {
    const bad = validIndexOpts(opts);
    if (bad !== null) return refuse(REASONS.INVALID_INPUT, bad);
    const key = `${[...opts.families].sort().join(",")}|${opts.maxStructures}`;
    let memo = memos.get(key) || null;
    const fresh = memo !== null && opts.nowMs >= memo.builtAt && opts.nowMs - memo.builtAt < opts.ttlMs;
    if (!fresh) {
      const built = buildCandidateIndexFrom(vendor, opts);
      if (!built.ok) return built;
      memo = { builtAt: built.builtAt, index: built };
      memos.delete(key);
      memos.set(key, memo);
      while (memos.size > MAX_INDEX_MEMOS) memos.delete(memos.keys().next().value);
    }
    const index = memo.index;
    return { ok: true, bySystem: new Map(index.bySystem), total: index.total, truncated: index.truncated,
      builtAt: index.builtAt };
  }

  return Object.freeze({
    checkSeams: withVendor(() => checkSeamsFrom(vendor)),
    listCandidates: withVendor(listCandidates),
    readStructure: withVendor((id) => readStructureFrom(vendor, id)),
    applySiegeHit: withVendor((id, layer) => applySiegeHitFrom(vendor, id, layer)),
    readOwnerFace: withVendor((corpId) => readOwnerFaceFrom(vendor, corpId)),
    readOwnerActivity: withVendor((corpId, opts) => readOwnerActivityFrom(vendor, corpId, opts)),
    listOwnerMemberIds: withVendor((corpId, opts) => {
      let off = null;
      try {
        off = deps && typeof deps.disabledReason === "function" ? deps.disabledReason(NOTICES_CONSUMER) : null;
      } catch (err) {
        off = detailOf(err);
      }
      return off ? unavailable(String(off).slice(0, MAX_DETAIL)) : listOwnerMemberIdsFrom(vendor, corpId, opts);
    }),
  });
}

const SEAM_METHODS = Object.freeze(["checkSeams", "listCandidates", "readStructure", "applySiegeHit", "readOwnerFace",
  "readOwnerActivity", "listOwnerMemberIds"]);

module.exports = {
  PATHS,
  REQUIRED,
  REQUIRED_CONSTANTS,
  REASONS,
  LAYER_STATE,
  SIEGE_HIT_AMOUNT,
  SEAM_METHODS,
  TRIG_MARKER_KEY,
  filetimeToMs,
  checkSeamsFrom,
  buildCandidateIndexFrom,
  readStructureFrom,
  applySiegeHitFrom,
  readOwnerFaceFrom,
  readOwnerActivityFrom,
  listOwnerMemberIdsFrom,
  createPlayerStructureSeam,
};
