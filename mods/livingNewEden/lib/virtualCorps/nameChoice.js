"use strict";

const { styleFor, pickName } = require("../names");

const MAX_VENDOR_ROUNDS = 3;
const GENDERS = Object.freeze(["Male", "Female"]);

const safeCall = (fn) => {
  try {
    return fn();
  } catch (err) {
    return { ok: false, reason: "ADAPTER_THREW", detail: String((err && err.message) || err).slice(0, 120) };
  }
};

function chooseCharacterName(deps, input, options) {
  try {
    const adapter = deps && deps.adapter;
    if (!adapter || !input || typeof input.identityKey !== "string" || input.identityKey === ""
      || !Number.isSafeInteger(input.characterId) || input.characterId <= 0 || !GENDERS.includes(input.gender)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const maxAttempts = deps.settings && deps.settings.maxAttempts;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return { ok: false, reason: "INVALID_INPUT" };

    if (!(options && options.reuse === false) && typeof adapter.peekCharacterRecord === "function") {
      const peek = safeCall(() => adapter.peekCharacterRecord(input.characterId));
      const record = peek && peek.ok === true ? peek.record : null;
      if (record && record.lneIdentityKey === input.identityKey
        && typeof record.characterName === "string" && record.characterName.trim() !== "") {
        return { ok: true, name: record.characterName, reused: true, attempt: 0 };
      }
    }

    if (!Number.isInteger(deps.worldSeed)) return { ok: false, reason: "NO_WORLD_SEED" };

    const keysRes = typeof adapter.characterNameKeys === "function" ? safeCall(() => adapter.characterNameKeys())
      : null;
    if (!keysRes || keysRes.ok !== true || !keysRes.keys || typeof keysRes.keys.has !== "function") {
      return { ok: false, reason: "NAME_KEYS_UNAVAILABLE" };
    }
    const keys = keysRes.keys;

    const style = styleFor({ factionId: input.ownerKind === "faction" ? input.ownerId : null, raceId: input.raceId,
      ownerKind: input.ownerKind });

    let startAttempt = 0;
    for (let round = 0; round < MAX_VENDOR_ROUNDS; round += 1) {
      const picked = pickName({ worldSeed: deps.worldSeed, entityKey: input.identityKey, style: style.style,
        nicknames: style.nicknames, gender: input.gender, isTaken: (key) => keys.has(key), maxAttempts,
        startAttempt });
      if (!picked.ok) return { ok: false, reason: picked.reason };
      const vendor = typeof adapter.validateCharacterName === "function"
        ? safeCall(() => adapter.validateCharacterName(picked.name)) : null;
      if (vendor && vendor.ok === true && vendor.valid === true) {
        if (typeof adapter.noteCharacterNameTaken === "function") {
          safeCall(() => adapter.noteCharacterNameTaken(picked.name));
        }
        return { ok: true, name: picked.name, reused: false, attempt: picked.attempt };
      }
      if (!vendor || vendor.ok !== true) return { ok: false, reason: "NAME_KEYS_UNAVAILABLE" };
      startAttempt = picked.attempt + 1;
    }
    return { ok: false, reason: "NAME_UNAVAILABLE" };
  } catch (_err) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
}

module.exports = { chooseCharacterName, MAX_VENDOR_ROUNDS };
