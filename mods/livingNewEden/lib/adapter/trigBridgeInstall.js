"use strict";

const DELIVERY_PATH = "services/structure/structureCargoDeliveryService";
const DEPOSIT_METHOD = "Handle_DropOffItems";
const TYPE_ANSIBLEX = 35841;
const CORP_ROLE_STATION_MANAGER = 2048n;
const GROUP_FUEL_BLOCK = 1136;
const TYPE_LIQUID_OZONE = 16273;
const LIGHT_YEAR_METERS = 9460730472580800;
const MARKER_KEY = "lneTrigBridge";
const KEY_PREFIX = "lne:tbr:";
const DEST_FIELDS = Object.freeze(["destinationSolarsystemID", "sovereigntyJumpBridgeDestinationSolarsystemID"]);
const HOOK_MARKER = Symbol.for("livingNewEden.trigBridge.depositHook");
const DETAIL_MAX = 120;
const FAIL_LOG_INTERVAL_MS = 60000;
const FAIL_TEXT = "The Triglavian Conduit Core could not be installed now. The core stays in your cargo hold.";

const isFn = (o, k) => Boolean(o) && typeof o[k] === "function";
const fit = (text) => String(text).slice(0, DETAIL_MAX);
const messageOf = (err) => fit((err && err.message) || err);
const refuse = (reason, detail) => ({ ok: false, reason, ...(detail ? { detail: fit(detail) } : {}) });

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function summaryOf(row, systemNameOf) {
  const flags = row.devFlags && typeof row.devFlags === "object" ? row.devFlags : {};
  const m = flags[MARKER_KEY];
  const systemId = toPositiveInt(row.solarSystemID);
  let systemName = "";
  try {
    systemName = typeof systemNameOf === "function" ? String(systemNameOf(systemId) || "") : "";
  } catch (_err) {
    systemName = "";
  }
  return Object.freeze({ structureId: toPositiveInt(row.structureID), systemId, systemName,
    typeId: toPositiveInt(row.typeID), ownerCorpId: toPositiveInt(row.ownerCorpID || row.ownerID),
    allianceId: toPositiveInt(row.allianceID) || null, destroyed: Boolean(row.destroyedAt),
    destinationSystemId: toPositiveInt(flags[DEST_FIELDS[0]] || flags[DEST_FIELDS[1]]),
    devFlags: Object.freeze(m && typeof m === "object" && !Array.isArray(m)
      ? { [MARKER_KEY]: Object.freeze({ v: m.v, installedAt: m.installedAt, installedBy: m.installedBy,
        coreTypeId: m.coreTypeId }) } : {}) });
}

function seamProblem(v) {
  const s = v || {};
  const cls = s.deliveryClass;
  if (typeof cls !== "function" || !cls.prototype || typeof cls.prototype[DEPOSIT_METHOD] !== "function") {
    return `cargoDelivery_${DEPOSIT_METHOD}`;
  }
  if (!isFn(s.serviceHelpers, "unwrapMarshalValue")) return "serviceHelpers_unwrapMarshalValue";
  if (!isFn(s.itemStore, "findItemById") || !s.itemStore.ITEM_FLAGS
    || !Number.isSafeInteger(s.itemStore.ITEM_FLAGS.CARGO_HOLD)) return "itemStore";
  const c = s.itemCustody;
  if (!isFn(c, "transfer") || !isFn(c, "getCommittedReceipt") || !c.custodyRef || !isFn(c.custodyRef, "ownerLocation")
    || !isFn(c.custodyRef, "void") || !c.CUSTODY_REASON || !c.CUSTODY_REASON.ESS_KEY_CONSUME) return "itemCustody";
  if (!isFn(s.characterState, "syncInventoryItemForSession")) return "characterState_syncInventoryItemForSession";
  for (const name of ["getStructureByID", "listStructures", "updateStructureRecord"]) {
    if (!isFn(s.structureState, name)) return `structureState_${name}`;
  }
  if (!isFn(s.runtime, "syncStructureSceneState") || !isFn(s.runtime, "isSolarSystemSceneLoaded")) return "runtime";
  if (!isFn(s.worldData, "getSolarSystemByID")) return "worldData";
  if (!isFn(s.corpAuth, "getPersistedCorporationAuthority") || !isFn(s.corpAuth, "corporationAuthorityHasRole")) {
    return "corporationAuthority";
  }
  if (!isFn(s.itemTypes, "resolveItemByTypeID")) return "itemTypeRegistry";
  if (typeof s.throwUserError !== "function") return "machoErrors_throwWrappedUserError";
  return null;
}

function checkInstallSeams(v) {
  const problem = seamProblem(v);
  return problem === null ? { ok: true } : refuse("SEAM_UNAVAILABLE", problem);
}

const systemNameOf = (v) => (id) => {
  const row = v.worldData.getSolarSystemByID(id);
  return row && row.solarSystemName != null ? row.solarSystemName : "";
};

function readStructureFrom(v, structureId) {
  try {
    const row = toPositiveInt(structureId) ? v.structureState.getStructureByID(structureId, { refresh: false }) : null;
    return row && typeof row === "object" ? { ok: true, row: summaryOf(row, systemNameOf(v)) } : refuse("NOT_FOUND");
  } catch (err) {
    return refuse("SEAM_ERROR", messageOf(err));
  }
}

function listTrigBridgesFrom(v, opts) {
  try {
    const o = opts || {};
    const max = toPositiveInt(o.max);
    const allianceId = toPositiveInt(o.allianceId);
    const rows = [];
    let scanned = 0;
    let truncated = false;
    const nameOf = systemNameOf(v);
    for (const row of v.structureState.listStructures({ includeDestroyed: false, refresh: false }) || []) {
      if (!row || toPositiveInt(row.typeID) !== TYPE_ANSIBLEX || row.destroyedAt) continue;
      if (scanned >= max) {
        truncated = true;
        break;
      }
      scanned += 1;
      const flags = row.devFlags && typeof row.devFlags === "object" ? row.devFlags : null;
      if (!flags || !flags[MARKER_KEY] || typeof flags[MARKER_KEY] !== "object") continue;
      if (allianceId && toPositiveInt(row.allianceID) !== allianceId) continue;
      rows.push(summaryOf(row, nameOf));
    }
    return { ok: true, rows, truncated };
  } catch (err) {
    return refuse("SEAM_ERROR", messageOf(err));
  }
}

function distanceLyFrom(v, a, b) {
  try {
    const p = v.worldData.getSolarSystemByID(a);
    const q = v.worldData.getSolarSystemByID(b);
    const x = p && p.position;
    const y = q && q.position;
    if (!x || !y) return NaN;
    const d = Math.hypot(Number(y.x) - Number(x.x), Number(y.y) - Number(x.y), Number(y.z) - Number(x.z));
    return Number.isFinite(d) ? d / LIGHT_YEAR_METERS : NaN;
  } catch (_err) {
    return NaN;
  }
}

function coreTypeFrom(v, typeId) {
  try {
    const entry = v.itemTypes.resolveItemByTypeID(typeId);
    if (!entry || typeof entry !== "object") return { ok: true, found: false, fuel: false, name: null };
    const fuel = toPositiveInt(entry.groupID) === GROUP_FUEL_BLOCK || toPositiveInt(typeId) === TYPE_LIQUID_OZONE;
    return { ok: true, found: true, fuel, name: typeof entry.name === "string" ? entry.name : null };
  } catch (err) {
    return refuse("SEAM_ERROR", messageOf(err));
  }
}

function voidCoreFrom(v, spec) {
  const s = spec || {};
  if (typeof s.key !== "string" || !s.key.startsWith(KEY_PREFIX)) {
    return { ok: false, reason: "CUSTODY_KEY_INVALID", ambiguous: false };
  }
  const C = v.itemCustody;
  try {
    const prior = C.getCommittedReceipt(s.key);
    if (prior && prior.committed === true) return { ok: true, outcome: "ALREADY_COMMITTED", gone: false };
    if (prior && prior.success !== true && prior.ambiguous === true) {
      return { ok: false, reason: "CUSTODY_FAILED", ambiguous: true, detail: fit(prior.errorMsg || "receipt") };
    }
  } catch (err) {
    return { ok: false, reason: "CUSTODY_FAILED", ambiguous: true, detail: messageOf(err) };
  }
  let result;
  try {
    result = C.transfer({ items: { itemID: s.itemId, quantity: 1 },
      from: C.custodyRef.ownerLocation(s.characterId, s.shipId, s.flagId), to: C.custodyRef.void(),
      reason: C.CUSTODY_REASON.ESS_KEY_CONSUME, actor: s.characterId, idempotencyKey: s.key });
  } catch (err) {
    return { ok: false, reason: "CUSTODY_FAILED", ambiguous: true, detail: messageOf(err) };
  }
  if (!result || result.success !== true) {
    const errorMsg = String((result && result.errorMsg) || "no_result");
    if (errorMsg === "ITEM_NOT_FOUND" || errorMsg === "ITEM_CUSTODY_SOURCE_MISMATCH") {
      return { ok: false, reason: "ITEM_MISSING", ambiguous: false, detail: fit(errorMsg) };
    }
    return { ok: false, reason: "CUSTODY_FAILED", ambiguous: !result || result.ambiguous === true || result.durable !== true,
      detail: fit(errorMsg) };
  }
  const changes = result.data && Array.isArray(result.data.changes) ? result.data.changes : [];
  for (const change of changes) {
    if (!change || !change.item) continue;
    try {
      v.characterState.syncInventoryItemForSession(s.session, change.item, change.previousData || {},
        { emitCfgLocation: false });
    } catch (_err) {
    }
  }
  let gone = false;
  try {
    gone = !v.itemStore.findItemById(s.itemId);
  } catch (_err) {
    gone = false;
  }
  return { ok: true, outcome: result.duplicate === true ? "ALREADY_COMMITTED" : "VOIDED", gone };
}

function updateBridgeFrom(v, structureId, fn) {
  let verdict = null;
  const r = v.structureState.updateStructureRecord(structureId, (cur) => {
    if (!cur || toPositiveInt(cur.typeID) !== TYPE_ANSIBLEX) {
      verdict = "NOT_ANSIBLEX";
      return cur;
    }
    if (cur.destroyedAt) {
      verdict = "DESTROYED";
      return cur;
    }
    const next = fn(cur);
    return next || cur;
  });
  if (verdict) return refuse(verdict);
  if (!r || r.success !== true) return refuse(String((r && r.errorMsg) || "WRITE_FAILED"));
  return { ok: true };
}

function writeMarkerFrom(v, structureId, marker) {
  try {
    const row = v.structureState.getStructureByID(structureId, { refresh: false });
    if (!row) return refuse("NOT_FOUND");
    if (toPositiveInt(row.typeID) !== TYPE_ANSIBLEX) return refuse("NOT_ANSIBLEX");
    if (row.destroyedAt) return refuse("DESTROYED");
    if (row.devFlags && row.devFlags[MARKER_KEY]) return { ok: true, alreadySet: true };
    let already = false;
    const m = { v: marker.v, installedAt: marker.installedAt, installedBy: marker.installedBy,
      coreTypeId: marker.coreTypeId };
    const r = updateBridgeFrom(v, structureId, (cur) => {
      const flags = cur.devFlags && typeof cur.devFlags === "object" ? cur.devFlags : {};
      if (flags[MARKER_KEY]) {
        already = true;
        return null;
      }
      return { ...cur, devFlags: { ...flags, [MARKER_KEY]: m } };
    });
    return r.ok ? { ok: true, alreadySet: already } : r;
  } catch (err) {
    return refuse("SEAM_ERROR", messageOf(err));
  }
}

function writeDestinationFrom(v, structureId, destinationSystemId) {
  try {
    const dest = toPositiveInt(destinationSystemId);
    if (!dest) return refuse("INVALID_INPUT", "destinationSystemId");
    const row = v.structureState.getStructureByID(structureId, { refresh: false });
    if (!row) return refuse("NOT_FOUND");
    if (toPositiveInt(row.typeID) !== TYPE_ANSIBLEX) return refuse("NOT_ANSIBLEX");
    if (row.destroyedAt) return refuse("DESTROYED");
    const flags = row.devFlags && typeof row.devFlags === "object" ? row.devFlags : {};
    if (!flags[MARKER_KEY]) return refuse("NOT_MARKED");
    if (DEST_FIELDS.every((k) => toPositiveInt(flags[k]) === dest)) return { ok: true, written: false };
    let unmarked = false;
    const r = updateBridgeFrom(v, structureId, (cur) => {
      const f = cur.devFlags && typeof cur.devFlags === "object" ? cur.devFlags : {};
      if (!f[MARKER_KEY]) {
        unmarked = true;
        return null;
      }
      return { ...cur, devFlags: { ...f, [DEST_FIELDS[0]]: dest, [DEST_FIELDS[1]]: dest } };
    });
    if (unmarked) return refuse("NOT_MARKED");
    return r.ok ? { ok: true, written: true } : r;
  } catch (err) {
    return refuse("SEAM_ERROR", messageOf(err));
  }
}

function syncSceneFrom(v, systemId) {
  try {
    const id = toPositiveInt(systemId);
    if (!id || v.runtime.isSolarSystemSceneLoaded(id) !== true) return { ok: true, loaded: false };
    v.runtime.syncStructureSceneState(id);
    return { ok: true, loaded: true };
  } catch (err) {
    return refuse("SEAM_ERROR", messageOf(err));
  }
}

function authorityOf(v, session) {
  const authority = v.corpAuth.getPersistedCorporationAuthority(session);
  if (!authority || typeof authority !== "object") return { corporationId: 0, hasRole: false };
  const hasRole = authority.isCEO === true
    || v.corpAuth.corporationAuthorityHasRole(authority, CORP_ROLE_STATION_MANAGER) === true;
  return { corporationId: toPositiveInt(authority.corporationID), hasRole };
}

function sessionShipOf(session) {
  const s = session || {};
  return toPositiveInt((s._space && s._space.shipID) || s.shipID || s.shipid || s.activeShipID);
}

function itemIdsOf(v, raw) {
  const unwrapped = v.serviceHelpers.unwrapMarshalValue(raw);
  const values = Array.isArray(unwrapped) ? unwrapped
    : unwrapped && typeof unwrapped === "object" ? Object.values(unwrapped) : [unwrapped];
  return [...new Set(values.map(toPositiveInt).filter((id) => id > 0))];
}

function createDepositHook(deps) {
  const d = deps || {};
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => Date.now();
  const stats = { cores: 0, passthrough: 0, refused: 0, consumed: 0, errors: 0 };
  let installed = false;
  let active = false;
  let proto = null;
  let original = null;
  let wrapper = null;
  let lastFailLogAt = -Infinity;

  const noteError = (where, err) => {
    stats.errors += 1;
    if (typeof d.onEvent === "function") {
      try {
        d.onEvent("installErrors");
      } catch (_err) {
      }
    }
    const now = nowMs();
    if (!logger || now - lastFailLogAt < FAIL_LOG_INTERVAL_MS) return;
    lastFailLogAt = now;
    try {
      logger.log(`trigBridge: cargo deposit ${where} failed (errors=${stats.errors}) - ${messageOf(err)}`);
    } catch (_err) {
    }
  };

  const planOf = (args, session) => {
    if (!Array.isArray(args)) return null;
    const characterId = toPositiveInt(session && (session.characterID || session.charID || session.charid));
    const shipId = sessionShipOf(session);
    const structureId = toPositiveInt(d.serviceHelpers.unwrapMarshalValue(args[2]));
    if (!characterId || !shipId || !structureId) return null;
    const row = d.structureState.getStructureByID(structureId, { refresh: false });
    if (!row || toPositiveInt(row.typeID) !== TYPE_ANSIBLEX) return null;
    const cargo = d.itemStore.ITEM_FLAGS.CARGO_HOLD;
    const ids = itemIdsOf(d, args[0]);
    const cores = [];
    const rest = [];
    for (const id of ids) {
      const item = d.itemStore.findItemById(id);
      const core = item && toPositiveInt(item.typeID) === d.coreTypeId && toPositiveInt(item.ownerID) === characterId
        && toPositiveInt(item.locationID) === shipId && Number(item.flagID) === cargo;
      (core ? cores : rest).push(id);
    }
    if (cores.length === 0) return null;
    const auth = authorityOf(d, session);
    const itemId = cores[0];
    return { rest, query: { characterId, corporationId: auth.corporationId
      || toPositiveInt(session.corporationID || session.corpid), hasRole: auth.hasRole, shipId,
    structure: summaryOf(row, systemNameOf(d)), core: { itemId, typeId: d.coreTypeId },
    consume: (key) => voidCoreFrom(d, { characterId, shipId, itemId, flagId: cargo, key, session }) } };
  };

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const problem = seamProblem(d);
    if (problem) return refuse("SEAM_UNAVAILABLE", problem);
    if (typeof d.onCore !== "function" || !toPositiveInt(d.coreTypeId)) {
      return refuse("SEAM_UNAVAILABLE", "onCore_or_coreTypeId");
    }
    const target = d.deliveryClass.prototype;
    if (target[DEPOSIT_METHOD][HOOK_MARKER]) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    const base = target[DEPOSIT_METHOD];
    const wrapped = function Handle_DropOffItems() {
      if (!active) return base.apply(this, arguments);
      let plan;
      try {
        plan = planOf(arguments[0], arguments[1]);
      } catch (err) {
        noteError("plan", err);
        plan = null;
      }
      if (!plan) {
        stats.passthrough += 1;
        return base.apply(this, arguments);
      }
      stats.cores += 1;
      const callArgs = Array.prototype.slice.call(arguments);
      callArgs[0] = [plan.rest, ...arguments[0].slice(1)];
      const moved = base.apply(this, callArgs);
      let verdict;
      try {
        verdict = d.onCore(plan.query);
      } catch (err) {
        noteError("install", err);
        verdict = { ok: false, message: FAIL_TEXT };
      }
      if (!verdict || verdict.pass === true) return moved;
      if (verdict.ok !== true) {
        stats.refused += 1;
        d.throwUserError("CustomNotify", { notify: String(verdict.message || FAIL_TEXT) });
        return moved;
      }
      const consumed = toPositiveInt(verdict.consumedItemId);
      if (!consumed) return moved;
      stats.consumed += 1;
      return [...(Array.isArray(moved) ? moved : []), consumed];
    };
    Object.defineProperty(wrapped, HOOK_MARKER, { value: true });
    target[DEPOSIT_METHOD] = wrapped;
    if (target[DEPOSIT_METHOD] !== wrapped) return refuse("SEAM_UNAVAILABLE", `${DEPOSIT_METHOD} not writable`);
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
      if (installed && proto && proto[DEPOSIT_METHOD] === wrapper) proto[DEPOSIT_METHOD] = original;
    } catch (_err) {
    }
    installed = false;
  }

  return Object.freeze({ install, uninstall, isActive: () => active, getStats: () => ({ ...stats }) });
}

module.exports = { DELIVERY_PATH, DEPOSIT_METHOD, TYPE_ANSIBLEX, CORP_ROLE_STATION_MANAGER, GROUP_FUEL_BLOCK,
  TYPE_LIQUID_OZONE, MARKER_KEY, KEY_PREFIX, HOOK_MARKER, summaryOf, checkInstallSeams, readStructureFrom,
  listTrigBridgesFrom, distanceLyFrom, coreTypeFrom, voidCoreFrom, writeMarkerFrom, writeDestinationFrom, syncSceneFrom,
  createDepositHook };
