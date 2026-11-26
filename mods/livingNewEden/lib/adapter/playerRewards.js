"use strict";

const { COMMAND_PREFIX, MAX_CHARACTER_BALANCE, characterWalletOf } = require("./tradeContracts");

const CORPORATE_REWARD_PAYOUT = 99;
const CHARACTERS_TABLE = "characters";
const MAX_KEY_LENGTH = 320;
const MAX_DESCRIPTION = 120;
const MAX_DETAIL = 120;
const SOURCE = "lne-liberation";
const MAX_SOURCE = 64;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const sourceOf = (s) => (typeof s === "string" && s !== "" && s.length <= MAX_SOURCE ? s : SOURCE);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function validKey(commandId) {
  return typeof commandId === "string" && commandId.startsWith(COMMAND_PREFIX) && commandId.length <= MAX_KEY_LENGTH;
}

function keyRefusal(errorMsg) {
  return errorMsg === "IDEMPOTENCY_KEY_INVALID" || errorMsg === "IDEMPOTENCY_KEY_REUSED"
    ? { ok: false, reason: "WALLET_KEY_INVALID", permanent: true, detail: errorMsg } : null;
}

async function creditRewardIskFrom(walletState, gameStore, spec) {
  try {
    const { characterId, amountIsk, commandId, issuerCorporationId, systemId, description } = spec || {};
    if (!validKey(commandId)) return { ok: false, reason: "WALLET_KEY_INVALID", permanent: true };
    if (!walletState || typeof walletState.adjustCharacterBalanceAsync !== "function"
      || typeof walletState.getCharacterWallet !== "function"
      || !gameStore || typeof gameStore.flushTableSync !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
    }
    if (!isId(characterId)) return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_character" };
    if (!isId(amountIsk)) return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_amount" };
    if (!isId(systemId)) return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_system" };
    if (typeof description !== "string" || description === "") {
      return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_description" };
    }

    const wallet = characterWalletOf(walletState, characterId);
    if (!wallet.exists) return { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true };
    if (wallet.balance !== null && wallet.balance + amountIsk > MAX_CHARACTER_BALANCE) {
      return { ok: false, reason: "BALANCE_LIMIT", permanent: true };
    }

    const options = {
      idempotencyKey: commandId,
      entryTypeID: CORPORATE_REWARD_PAYOUT,
      ownerID1: isId(issuerCorporationId) ? issuerCorporationId : 0,
      ownerID2: characterId,
      referenceID: systemId,
      description: description.slice(0, MAX_DESCRIPTION),
    };
    const metadata = { commandID: commandId, source: sourceOf(spec.source) };
    let result;
    try {
      result = await walletState.adjustCharacterBalanceAsync(characterId, amountIsk, options, metadata);
    } catch (err) {
      return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    if (!result) return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: "no_result" };
    if (result.success !== true) {
      const errorMsg = String(result.errorMsg || "");
      if (errorMsg === "CHARACTER_NOT_FOUND") return { ok: false, reason: errorMsg, permanent: true, detail: errorMsg };
      return keyRefusal(errorMsg) || { ok: false, reason: "WALLET_FAILED", permanent: false, detail: errorMsg };
    }
    try {
      const flushed = gameStore.flushTableSync(CHARACTERS_TABLE);
      if (!flushed || flushed.success !== true) {
        return { ok: false, reason: "FLUSH_FAILED", permanent: false,
          detail: String((flushed && flushed.errorMsg) || "no_result").slice(0, MAX_DETAIL) };
      }
    } catch (err) {
      return { ok: false, reason: "FLUSH_FAILED", permanent: false, detail: messageOf(err) };
    }
    return { ok: true, duplicate: result.duplicate === true, fingerprintMismatch: result.fingerprintMismatch === true };
  } catch (err) {
    return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
  }
}

function creditRewardLpFrom(lpWalletState, spec) {
  try {
    const { characterId, amountLp, issuerCorporationId, commandId } = spec || {};
    if (!validKey(commandId)) return { ok: false, reason: "WALLET_KEY_INVALID", permanent: true };
    if (!lpWalletState || typeof lpWalletState.adjustCharacterWalletLPBalanceDurable !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
    }
    if (!isId(characterId) || !isId(issuerCorporationId)) {
      return { ok: false, reason: "INVALID_OWNER_OR_ISSUER", permanent: true };
    }
    if (!isId(amountLp)) return { ok: false, reason: "LP_FAILED", permanent: true, detail: "invalid_amount" };
    let result;
    try {
      result = lpWalletState.adjustCharacterWalletLPBalanceDurable(characterId, issuerCorporationId, amountLp,
        { idempotencyKey: commandId, changeType: "reward" });
    } catch (err) {
      return { ok: false, reason: "LP_FAILED", permanent: false, detail: messageOf(err) };
    }
    if (!result) return { ok: false, reason: "LP_FAILED", permanent: false, detail: "no_result" };
    if (result.success === true) return { ok: true, duplicate: result.duplicate === true };
    const errorMsg = String(result.errorMsg || "");
    if (result.ambiguous === true) return { ok: false, reason: "LP_AMBIGUOUS", permanent: false, detail: errorMsg };
    if (errorMsg === "INVALID_OWNER_OR_ISSUER") return { ok: false, reason: errorMsg, permanent: true, detail: errorMsg };
    return keyRefusal(errorMsg) || { ok: false, reason: "LP_FAILED", permanent: false, detail: errorMsg };
  } catch (err) {
    return { ok: false, reason: "LP_FAILED", permanent: false, detail: messageOf(err) };
  }
}

module.exports = { creditRewardIskFrom, creditRewardLpFrom, CORPORATE_REWARD_PAYOUT, CHARACTERS_TABLE, SOURCE };
