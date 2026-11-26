"use strict";

const vendorNameKey = (name) => String(name).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

const IDENTITY_ALLOCATOR = "services/_shared/identityAllocator";
const CHARACTER_STATE = "services/character/characterState";
const CHARACTER_NAME_RUNTIME = "services/character/characterNameRuntime";
const CHARACTER_CREATION_DATA = "services/character/characterCreationData";
const CORPORATION_RUNTIME = "services/corporation/corporationRuntimeState";
const CORPORATION_STATE = "services/corporation/corporationState";
const GAMESTORE = "gameStore/index";
const READ_FALLBACK = Object.freeze({ readFallback: true });

const IDENTITY_KINDS = Object.freeze({
  ALLIANCE: "alliance",
  CORPORATION: "corporation",
  CHARACTER: "character",
});

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function loadModule(requireGame, relPath) {
  const loaded = requireGame(relPath);
  if (!loaded.ok) return { ok: false, reason: loaded.reason };
  return { ok: true, exports: loaded.exports };
}

function mapVendorResult(result) {
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "VENDOR_INVALID_RESULT" };
  }
  if (result.success === true) {
    return { ok: true, data: result.data };
  }
  return { ok: false, reason: result.errorMsg || "VENDOR_FAILED" };
}

function createVirtualIdentitiesAdapter(deps) {
  const { requireGame, config } = deps;
  const CHARACTER_SCAN_CACHE_TTL = (config && config.virtualCorps && typeof config.virtualCorps.characterScanCacheTtlMs === "number")
    ? config.virtualCorps.characterScanCacheTtlMs
    : 5000;
  let characterScanCache = null;
  let characterScanCacheTime = 0;
  let nameKeysCache = null;
  let nameKeysCacheTime = 0;

  function reserveCharacterId() {
    try {
      const mod = loadModule(requireGame, IDENTITY_ALLOCATOR);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.reserveCharacterID;
      if (typeof fn !== "function") return { ok: false, reason: "reserveCharacterID_not_a_function" };
      const characterId = fn();
      if (!Number.isInteger(characterId) || characterId <= 0) {
        return { ok: false, reason: "NAME_UNAVAILABLE" };
      }
      return { ok: true, characterId };
    } catch (err) {
      return { ok: false, reason: `NAME_UNAVAILABLE: ${String((err && err.message) || err)}` };
    }
  }

  function writeCharacter(record) {
    try {
      const mod = loadModule(requireGame, CHARACTER_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.writeCharacterRecord;
      if (typeof fn !== "function") return { ok: false, reason: "writeCharacterRecord_not_a_function" };
      const charId = record && record.characterId;
      if (!Number.isInteger(charId) || charId <= 0) {
        return { ok: false, reason: "WRITE_FAILED: invalid characterId" };
      }
      const result = fn(charId, record, {});
      return mapVendorResult(result);
    } catch (err) {
      return { ok: false, reason: `WRITE_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function peekCharacterRecord(characterId) {
    try {
      const mod = loadModule(requireGame, CHARACTER_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.peekCharacterRecord;
      if (typeof fn !== "function") return { ok: false, reason: "peekCharacterRecord_not_a_function" };
      const record = fn(characterId);
      return { ok: true, record };
    } catch (err) {
      return { ok: false, reason: `PEEK_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function pickCharacterName(raceId) {
    try {
      const mod = loadModule(requireGame, CHARACTER_NAME_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.getValidRandomName;
      if (typeof fn !== "function") return { ok: false, reason: "getValidRandomName_not_a_function" };
      const name = fn(raceId);
      if (typeof name !== "string" || name === "") return { ok: false, reason: "NAME_UNAVAILABLE" };
      return { ok: true, name };
    } catch (err) {
      return { ok: false, reason: `NAME_UNAVAILABLE: ${String((err && err.message) || err)}` };
    }
  }

  function characterNameKeys() {
    try {
      const now = Date.now();
      if (nameKeysCache && now - nameKeysCacheTime <= CHARACTER_SCAN_CACHE_TTL) return { ok: true, keys: nameKeysCache };
      const mod = loadModule(requireGame, CHARACTER_NAME_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.getExistingCharacterNameKeys;
      if (typeof fn !== "function") return { ok: false, reason: "getExistingCharacterNameKeys_not_a_function" };
      const keys = fn();
      if (!(keys instanceof Set)) return { ok: false, reason: "NAME_KEYS_NOT_A_SET" };
      nameKeysCache = new Set(keys);
      nameKeysCacheTime = now;
      return { ok: true, keys: nameKeysCache };
    } catch (err) {
      return { ok: false, reason: `NAME_KEYS_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function noteCharacterNameTaken(name) {
    if (typeof name !== "string" || name.trim() === "") return { ok: false, reason: "INVALID_NAME" };
    if (nameKeysCache) nameKeysCache.add(vendorNameKey(name));
    return { ok: true };
  }

  function validateCharacterName(name) {
    try {
      const mod = loadModule(requireGame, CHARACTER_NAME_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.validateCharacterName;
      const codes = mod.exports.VALIDATION_CODE;
      if (typeof fn !== "function") return { ok: false, reason: "validateCharacterName_not_a_function" };
      if (!codes || typeof codes !== "object" || !Number.isInteger(codes.VALID)) {
        return { ok: false, reason: "VALIDATION_CODE_MISSING" };
      }
      const code = fn(name);
      return { ok: true, valid: code === codes.VALID, code };
    } catch (err) {
      return { ok: false, reason: `VALIDATE_NAME_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function resolveCharacterCreationBloodlineProfile(bloodlineId) {
    try {
      const mod = loadModule(requireGame, CHARACTER_CREATION_DATA);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.resolveCharacterCreationBloodlineProfile;
      if (typeof fn !== "function") return { ok: false, reason: "resolveCharacterCreationBloodlineProfile_not_a_function" };
      const result = fn(bloodlineId);
      if (!result || typeof result !== "object") {
        return { ok: false, reason: "resolveCharacterCreationBloodlineProfile_no_result" };
      }
      if (!Number.isInteger(result.raceID) || result.raceID <= 0) {
        return { ok: false, reason: "resolveCharacterCreationBloodlineProfile_bad_race" };
      }
      return { ok: true, raceId: result.raceID, typeId: result.typeID || result.raceID };
    } catch (err) {
      return { ok: false, reason: `resolveCharacterCreationBloodlineProfile_failed: ${String((err && err.message) || err)}` };
    }
  }

  function ensureCorporation(ceoId, spec) {
    try {
      const mod = loadModule(requireGame, CORPORATION_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.createCorporationWithRuntime;
      if (typeof fn !== "function") return { ok: false, reason: "createCorporationWithRuntime_not_a_function" };
      const result = fn(ceoId, spec);
      const mapped = mapVendorResult(result);
      if (!mapped.ok) {
        const reason = String(mapped.reason || "");
        if (reason.includes("NAME_TAKEN") || reason.includes("CORPORATION_NAME_TAKEN")) return { ok: false, reason: "NAME_TAKEN" };
        if (reason.includes("TICKER_TAKEN") || reason.includes("CORPORATION_TICKER_TAKEN")) return { ok: false, reason: "TICKER_TAKEN" };
        return { ok: false, reason: mapped.reason || "CORPORATION_FAILED" };
      }
      const corporationId = mapped.data?.corporationID;
      if (!Number.isInteger(corporationId) || corporationId <= 0) {
        return { ok: false, reason: "CORPORATION_NO_ID" };
      }
      return { ok: true, corporationId };
    } catch (err) {
      return { ok: false, reason: `CORPORATION_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function ensureAlliance(creatorId, execCorpId, spec) {
    try {
      const mod = loadModule(requireGame, CORPORATION_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.createAllianceWithRuntime;
      if (typeof fn !== "function") return { ok: false, reason: "createAllianceWithRuntime_not_a_function" };
      const result = fn(creatorId, execCorpId, spec);
      const mapped = mapVendorResult(result);
      if (!mapped.ok) {
        const reason = String(mapped.reason || "");
        if (reason.includes("ALLIANCE_NAME_TAKEN")) return { ok: false, reason: "NAME_TAKEN" };
        if (reason.includes("ALLIANCE_SHORT_NAME_TAKEN")) return { ok: false, reason: "SHORT_NAME_TAKEN" };
        return { ok: false, reason: mapped.reason || "ALLIANCE_FAILED" };
      }
      const allianceId = mapped.data?.allianceID;
      if (!Number.isInteger(allianceId) || allianceId <= 0) {
        return { ok: false, reason: "ALLIANCE_NO_ID" };
      }
      return { ok: true, allianceId };
    } catch (err) {
      return { ok: false, reason: `ALLIANCE_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function markAllianceNpc(allianceId) {
    try {
      const mod = loadModule(requireGame, CORPORATION_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const state = loadModule(requireGame, CORPORATION_STATE);
      if (!state.ok) return { ok: false, reason: state.reason };
      const getFn = state.exports.getAllianceRecord;
      const updateFn = mod.exports.updateAllianceRecord;
      if (typeof getFn !== "function" || typeof updateFn !== "function") {
        return { ok: false, reason: "ALLIANCE_STATE_MISSING_FUNCTION" };
      }
      const current = getFn(allianceId);
      if (current && current.isNPC === true) return { ok: true, changed: false };
      const result = updateFn(allianceId, { isNPC: true });
      return mapVendorResult(result);
    } catch (err) {
      return { ok: false, reason: `ALLIANCE_NPC_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function markCorporationNoWar(corporationId) {
    try {
      const mod = loadModule(requireGame, CORPORATION_RUNTIME);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const state = loadModule(requireGame, CORPORATION_STATE);
      if (!state.ok) return { ok: false, reason: state.reason };
      const getFn = state.exports.getCorporationRecord;
      const updateFn = mod.exports.updateCorporationRecord;
      if (typeof getFn !== "function" || typeof updateFn !== "function") {
        return { ok: false, reason: "CORPORATION_STATE_MISSING_FUNCTION" };
      }
      const current = getFn(corporationId);
      if (current && current.allowWar === 0) return { ok: true, changed: false };
      const result = updateFn(corporationId, { allowWar: 0 });
      return mapVendorResult(result);
    } catch (err) {
      return { ok: false, reason: `CORPORATION_NOWAR_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function joinWhenAffiliated(characterId, corporationId, allianceId) {
    const charMod = loadModule(requireGame, CHARACTER_STATE);
    const runtimeMod = loadModule(requireGame, CORPORATION_RUNTIME);
    if (!charMod.ok || !runtimeMod.ok) return null;
    const peekFn = charMod.exports.peekCharacterRecord;
    const memberFn = runtimeMod.exports.getCorporationMember;
    const ensureFn = runtimeMod.exports.ensureCharacterMemberState;
    if (typeof peekFn !== "function" || typeof memberFn !== "function" || typeof ensureFn !== "function") return null;
    let member;
    try {
      const rec = peekFn(characterId);
      if (!rec || typeof rec !== "object") return null;
      if (Number(rec.corporationID) !== Number(corporationId)) return null;
      if ((Number(rec.allianceID) || 0) !== (Number(allianceId) || 0)) return null;
      member = memberFn(corporationId, characterId);
    } catch (_err) {
      return READ_FALLBACK;
    }
    if (member !== null && member !== undefined) return { ok: true, already: true };
    try {
      ensureFn(corporationId, characterId);
    } catch (err) {
      return { ok: false, reason: `MEMBER_STATE_FAILED: ${String((err && err.message) || err)}` };
    }
    return { ok: true, already: true, memberStateEnsured: true };
  }

  function joinCorporation(characterId, corporationId, allianceId, options) {
    try {
      let readFallback = false;
      if (options && options.skipWhenAffiliated === true) {
        const skipped = joinWhenAffiliated(characterId, corporationId, allianceId);
        if (skipped === READ_FALLBACK) readFallback = true;
        else if (skipped !== null) return skipped;
      }
      const deferMemberState = Boolean(options && options.memberState === false);
      const stateMod = loadModule(requireGame, CORPORATION_STATE);
      if (!stateMod.ok) return { ok: false, reason: stateMod.reason };
      const setFn = stateMod.exports.setCharacterAffiliation;
      if (typeof setFn !== "function") {
        return { ok: false, reason: "setCharacterAffiliation_not_a_function" };
      }
      const runtimeMod = loadModule(requireGame, CORPORATION_RUNTIME);
      if (!runtimeMod.ok) return { ok: false, reason: runtimeMod.reason };
      const ensureFn = runtimeMod.exports.ensureCharacterMemberState;
      if (typeof ensureFn !== "function") {
        return { ok: false, reason: "ensureCharacterMemberState_not_a_function" };
      }
      const result = setFn(characterId, corporationId, allianceId || 0);
      const mapped = mapVendorResult(result);
      if (!mapped.ok) return { ok: false, reason: mapped.reason || "AFFILIATE_FAILED" };
      if (deferMemberState) return { ok: true, memberStateDeferred: true };
      try {
        ensureFn(corporationId, characterId);
      } catch (err) {
        return { ok: false, reason: `MEMBER_STATE_FAILED: ${String((err && err.message) || err)}` };
      }
      return readFallback ? { ok: true, readFallback: true } : { ok: true };
    } catch (err) {
      return { ok: false, reason: `AFFILIATE_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function ensureMemberStates(entries) {
    try {
      if (!Array.isArray(entries)) return { ok: false, reason: "INVALID_ENTRIES" };
      if (entries.length === 0) return { ok: true, ensured: 0, failed: 0 };
      const runtimeMod = loadModule(requireGame, CORPORATION_RUNTIME);
      if (!runtimeMod.ok) return { ok: false, reason: runtimeMod.reason };
      const ensureFn = runtimeMod.exports.ensureCharacterMemberState;
      if (typeof ensureFn !== "function") return { ok: false, reason: "ensureCharacterMemberState_not_a_function" };
      let ensured = 0;
      let failed = 0;
      let firstReason;
      for (const e of entries) {
        try {
          ensureFn(e.corporationId, e.characterId);
          ensured += 1;
        } catch (err) {
          failed += 1;
          if (firstReason === undefined) firstReason = `MEMBER_STATE_FAILED: ${String((err && err.message) || err)}`;
        }
      }
      return firstReason === undefined ? { ok: true, ensured, failed } : { ok: true, ensured, failed, firstReason };
    } catch (err) {
      return { ok: false, reason: `MEMBER_STATE_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function joinAlliance(corporationId, allianceId) {
    try {
      const mod = loadModule(requireGame, CORPORATION_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.setCorporationAlliance;
      if (typeof fn !== "function") return { ok: false, reason: "setCorporationAlliance_not_a_function" };
      const result = fn(corporationId, allianceId);
      return mapVendorResult(result);
    } catch (err) {
      return { ok: false, reason: `ALLIANCE_JOIN_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function findCorporationByFoundingOp(foundingOp) {
    try {
      const mod = loadModule(requireGame, CORPORATION_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.findCorporationByFoundingOperationID;
      if (typeof fn !== "function") return { ok: false, reason: "findCorporationByFoundingOperationID_not_a_function" };
      const record = fn(foundingOp);
      if (!record) return { ok: true, found: false };
      return { ok: true, found: true, corporationId: record.corporationID, record };
    } catch (err) {
      return { ok: false, reason: `FIND_CORP_BY_FO_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function findAllianceByFoundingOp(foundingOp) {
    try {
      const mod = loadModule(requireGame, CORPORATION_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.findAllianceByFoundingOperationID;
      if (typeof fn !== "function") return { ok: false, reason: "findAllianceByFoundingOperationID_not_a_function" };
      const record = fn(foundingOp);
      if (!record) return { ok: true, found: false };
      return { ok: true, found: true, allianceId: record.allianceID, record };
    } catch (err) {
      return { ok: false, reason: `FIND_ALLIANCE_BY_FO_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function exists(kind, evejsId, foundingOp) {
    try {
      if (kind === IDENTITY_KINDS.CORPORATION) {
        if (!foundingOp) return { ok: false, reason: "foundingOp_required_for_corporation" };
        return findCorporationByFoundingOp(foundingOp);
      }
      if (kind === IDENTITY_KINDS.ALLIANCE) {
        if (!foundingOp) return { ok: false, reason: "foundingOp_required_for_alliance" };
        return findAllianceByFoundingOp(foundingOp);
      }
      const now = Date.now();
      if (!characterScanCache || now - characterScanCacheTime > CHARACTER_SCAN_CACHE_TTL) {
        const store = loadModule(requireGame, GAMESTORE);
        if (!store.ok) return { ok: false, reason: store.reason };
        const result = store.exports.read("characters", "/");
        if (!result || result.success !== true || !result.data) return { ok: false, reason: "STORE_READ_FAILED" };
        const records = result.data;
        const map = new Map();
        for (const idStr of Object.keys(records)) {
          const rec = records[idStr];
          if (rec && typeof rec.lneIdentityKey === "string") {
            const recEvejsId = rec.characterId || Number(idStr);
            map.set(recEvejsId, rec);
          }
        }
        characterScanCache = map;
        characterScanCacheTime = now;
      }
      const rec = characterScanCache.get(evejsId);
      return { ok: true, found: !!rec, record: rec };
    } catch (err) {
      return { ok: false, reason: `EXISTS_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function scanVirtualCharacters() {
    try {
      const store = loadModule(requireGame, GAMESTORE);
      if (!store.ok) return { ok: false, reason: store.reason };
      const result = store.exports.read("characters", "/");
      if (!result || result.success !== true || !result.data) return { ok: false, reason: "STORE_READ_FAILED" };
      const records = result.data;
      const characters = [];
      for (const idStr of Object.keys(records)) {
        const rec = records[idStr];
        if (rec && typeof rec.lneIdentityKey === "string") {
          characters.push({
            characterId: rec.characterId || Number(idStr),
            lneIdentityKey: rec.lneIdentityKey,
            name: rec.characterName,
            corporationId: rec.corporationID,
            allianceId: rec.allianceID,
          });
        }
      }
      return { ok: true, characters };
    } catch (err) {
      return { ok: false, reason: `SCAN_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function renameCharacter(characterId, name, identityMarker) {
    if (!Number.isSafeInteger(characterId) || characterId <= 0 || typeof name !== "string" || name.trim() === ""
      || typeof identityMarker !== "string" || identityMarker === "") {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const mod = loadModule(requireGame, CHARACTER_STATE);
      if (!mod.ok) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String(mod.reason) };
      const peekFn = mod.exports.peekCharacterRecord;
      const writeFn = mod.exports.writeCharacterRecord;
      if (typeof peekFn !== "function" || typeof writeFn !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "characterState symbols missing" };
      }
      const current = peekFn(characterId);
      if (!current || typeof current !== "object") return { ok: false, reason: "NO_RECORD" };
      if (current.lneIdentityKey !== identityMarker) return { ok: false, reason: "NOT_LNE" };
      if (current.characterName === name) return { ok: true, changed: false };
      const result = writeFn(characterId, { ...current, characterName: name }, {});
      if (result && result.success === true) {
        characterScanCache = null;
        return { ok: true, changed: true };
      }
      const errorMsg = String((result && result.errorMsg) || "VENDOR_INVALID_RESULT");
      return { ok: false, reason: "VENDOR_FAILED", detail: errorMsg.slice(0, 120) };
    } catch (err) {
      return { ok: false, reason: "VENDOR_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
    }
  }

  function flush(tables) {
    try {
      const store = loadModule(requireGame, GAMESTORE);
      if (!store.ok) return { ok: false, reason: store.reason };
      const fn = store.exports.flushTablesSync;
      if (typeof fn !== "function") return { ok: false, reason: "flushTablesSync_not_a_function" };
      const tableList = tables || ["characters", "corporations", "alliances", "corporationRuntime", "skills"];
      const result = fn(tableList);
      return mapVendorResult(result);
    } catch (err) {
      return { ok: false, reason: `FLUSH_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function checkCorporationAlliance(corporationId) {
    try {
      const mod = loadModule(requireGame, CORPORATION_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.getCorporationRecord;
      if (typeof fn !== "function") return { ok: false, reason: "getCorporationRecord_not_a_function" };
      const record = fn(corporationId);
      if (!record) return { ok: false, reason: "CORPORATION_NOT_FOUND" };
      const allianceId = record.allianceID || 0;
      return { ok: true, inAlliance: allianceId > 0, allianceId: allianceId > 0 ? allianceId : undefined };
    } catch (err) {
      return { ok: false, reason: `CHECK_CORP_ALLIANCE_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  function checkAllianceIsNpc(allianceId) {
    try {
      const mod = loadModule(requireGame, CORPORATION_STATE);
      if (!mod.ok) return { ok: false, reason: mod.reason };
      const fn = mod.exports.getAllianceRecord;
      if (typeof fn !== "function") return { ok: false, reason: "getAllianceRecord_not_a_function" };
      const record = fn(allianceId);
      if (!record) return { ok: false, reason: "ALLIANCE_NOT_FOUND" };
      return { ok: true, isNpc: record.isNPC === true };
    } catch (err) {
      return { ok: false, reason: `CHECK_ALLIANCE_NPC_FAILED: ${String((err && err.message) || err)}` };
    }
  }

  return {
    IDENTITY_KINDS,
    reserveCharacterId,
    writeCharacter,
    peekCharacterRecord,
    pickCharacterName,
    characterNameKeys,
    noteCharacterNameTaken,
    validateCharacterName,
    ensureCorporation,
    ensureAlliance,
    markAllianceNpc,
    markCorporationNoWar,
    joinCorporation,
    ensureMemberStates,
    joinAlliance,
    findCorporationByFoundingOp,
    findAllianceByFoundingOp,
    exists,
    scanVirtualCharacters,
    renameCharacter,
    flush,
    resolveCharacterCreationBloodlineProfile,
    checkCorporationAlliance,
    checkAllianceIsNpc,
  };
}

module.exports = { createVirtualIdentitiesAdapter, IDENTITY_KINDS };