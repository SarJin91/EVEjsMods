"use strict";

const { markSyntheticIssuer } = require("./corpContractIssuer");

const TAG_PREFIX = "[LNE:";
const COMMAND_PREFIX = "lne:";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

const CHARACTER_ACCOUNT_KEY = 1000;
const MAX_CHARACTER_BALANCE = 10_000_000_000_000;
const GM_CASH_TRANSFER = 3;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, 120);
}

function ownerOf(spec) {
  const kind = spec.ownerKind === undefined || spec.ownerKind === null ? "corporation" : spec.ownerKind;
  if (kind === "character") return { kind, id: toPositiveInteger(spec.ownerId, 0) };
  if (kind === "corporation") return { kind, id: toPositiveInteger(spec.ownerId ?? spec.corporationId, 0) };
  return null;
}

function deliveryFlagOf(itemStore, kind) {
  const flags = itemStore && itemStore.ITEM_FLAGS;
  if (!flags || !isId(flags.HANGAR) || !isId(flags.CORP_DELIVERIES)) return null;
  return kind === "character" ? flags.HANGAR : flags.CORP_DELIVERIES;
}

function resolveStackFlag(itemStore, ownerKind, flag) {
  const invalid = { ok: false, reason: "TRADE_FLAG_INVALID", permanent: true };
  if (flag !== undefined && flag !== null && flag !== "delivery" && flag !== "hangar" && !Number.isSafeInteger(flag)) {
    return invalid;
  }
  const flags = itemStore && itemStore.ITEM_FLAGS;
  if (!flags || !isId(flags.HANGAR) || !isId(flags.CORP_DELIVERIES)) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }
  if (flag === undefined || flag === null || flag === "delivery") return { ok: true, flag: deliveryFlagOf(itemStore, ownerKind) };
  if (flag === "hangar") return { ok: true, flag: flags.HANGAR };
  if (flag === flags.HANGAR || flag === flags.CORP_DELIVERIES) return { ok: true, flag };
  return invalid;
}

function buildWantToBuyCall(payload) {
  const bad = (detail) => ({ ok: false, reason: "TRADE_CALL_INVALID", detail });

  if (!payload || typeof payload !== "object") return bad("payload");
  const issuerKind = payload.issuerKind === undefined ? "corporation" : payload.issuerKind;
  if (issuerKind !== "corporation" && issuerKind !== "character") return bad("issuerKind");
  const offerId = String(payload.offerId || "").trim();
  if (!offerId) return bad("offerId");
  if (!isId(payload.corporationId)) return bad("corporationId");
  if (!isId(payload.ceoId)) return bad("ceoId");
  const accountKey = Number(payload.accountKey);
  if (!Number.isInteger(accountKey) || accountKey < 1000 || accountKey > 1006) return bad("accountKey");
  if (issuerKind === "character" && accountKey !== CHARACTER_ACCOUNT_KEY) return bad("accountKey");
  if (!isId(payload.npcStationId)) return bad("npcStationId");
  if (!isId(payload.typeId)) return bad("typeId");
  if (!isId(payload.quantity)) return bad("quantity");
  const rewardIsk = Math.trunc(Number(payload.rewardIsk) || 0);
  if (rewardIsk < 1) return bad("rewardIsk");
  const minutesExpire = Math.max(1, Math.trunc(Number(payload.minutesExpire) || 0));
  if (!minutesExpire) return bad("minutesExpire");
  const title = String(payload.title || "").slice(0, 200);
  if (!title) return bad("title");
  const description = String(payload.description || "").slice(0, 4000);
  if (!description.includes(`[LNE:${offerId}]`)) return bad("tag_missing");

  let isPrivate = false;
  let assignedToID = 0;
  if (payload.assigneeCharacterId !== undefined && payload.assigneeCharacterId !== 0) {
    if (!isId(payload.assigneeCharacterId)) return bad("assigneeCharacterId");
    isPrivate = true;
    assignedToID = payload.assigneeCharacterId;
  }

  const info = {
    contractType: 1,
    isPrivate,
    assignedToID,
    minutesExpire,
    numDays: 0,
    startStationID: payload.npcStationId,
    destinationID: 0,
    price: 0,
    reward: rewardIsk,
    collateral: 0,
    title,
    description,
    itemList: [],
    startStationDivision: 4,
    requestItemTypeList: [[payload.typeId, payload.quantity]],
    forCorp: issuerKind !== "character",
    multiContract: false,
  };

  const session = issuerKind === "character"
    ? { characterID: payload.ceoId, corporationID: payload.corporationId }
    : { characterID: payload.ceoId, corporationID: payload.corporationId, corpAccountKey: accountKey };

  return { ok: true, info, session };
}

function findTradeContractFrom(contractRuntime, settlementState, { ownerId, corporationId, offerId }) {
  if (!contractRuntime || typeof contractRuntime.listContractRecords !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  if (!settlementState || typeof settlementState.listPendingContractSettlements !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }

  const tag = `[LNE:${String(offerId).trim()}]`;
  if (tag === "[LNE:]") return { ok: true, found: null };

  let bestRecord = null;
  let duplicates = 0;
  const issuerOwnerId = toPositiveInteger(ownerId ?? corporationId, 0);

  try {
    const records = contractRuntime.listContractRecords() || [];
    for (const record of records) {
      if (!issuerOwnerId || toPositiveInteger(record.issuerOwnerID, 0) !== issuerOwnerId) continue;
      const desc = String(record.description || "");
      if (!desc.includes(tag)) continue;
      const cid = toPositiveInteger(record.contractID, 0);
      if (!cid) continue;
      if (bestRecord === null || cid < bestRecord.contractID) {
        bestRecord = record;
      }
      duplicates++;
    }
  } catch (err) {
    return { ok: false, reason: "CONTRACT_READ_FAILED", detail: messageOf(err) };
  }

  if (bestRecord) {
    return {
      ok: true,
      found: "record",
      contractId: bestRecord.contractID,
      status: toStatus(bestRecord.status),
      duplicates: Math.max(0, duplicates - 1),
    };
  }

  try {
    const pending = settlementState.listPendingContractSettlements() || [];
    for (const settlement of pending) {
      if (settlement.kind !== "create") continue;
      const payload = settlement.payload || {};
      const info = payload.info || {};
      const desc = String(info.description || "");
      if (!desc.includes(tag)) continue;
      return { ok: true, found: "pending", contractId: toPositiveInteger(settlement.contractID, 0) };
    }
  } catch (err) {
    return { ok: false, reason: "CONTRACT_READ_FAILED", detail: messageOf(err) };
  }

  return { ok: true, found: null };
}

function readTradeContractFrom(contractRuntime, settlementState, contractId) {
  if (!contractRuntime || typeof contractRuntime.getContractRecord !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  if (!settlementState || typeof settlementState.getPendingContractSettlement !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }

  const cid = toPositiveInteger(contractId, 0);
  if (!cid) return { ok: true, contract: null };

  let record = null;
  try {
    record = contractRuntime.getContractRecord(cid);
  } catch (_err) {
    return { ok: true, contract: null };
  }

  if (!record) return { ok: true, contract: null };

  const CONTRACT_STATUS = contractRuntime.CONTRACT_STATUS || {};
  const rawStatus = toStatus(record.status);

  let status = "OTHER";
  if (rawStatus === CONTRACT_STATUS.OUTSTANDING) status = "OUTSTANDING";
  else if (rawStatus === CONTRACT_STATUS.FINISHED || rawStatus === CONTRACT_STATUS.FINISHED_ISSUER || rawStatus === CONTRACT_STATUS.FINISHED_CONTRACTOR) status = "FINISHED";
  else if (rawStatus === CONTRACT_STATUS.DELETED) status = "DELETED";
  else if (Number.isInteger(CONTRACT_STATUS.REJECTED) && rawStatus === CONTRACT_STATUS.REJECTED) status = "REJECTED";

  const acceptorId = toPositiveInteger(record.acceptorID, 0) || null;
  let acceptorKind = null;
  if (acceptorId) {
    const wallet = record.acceptorWallet;
    if (wallet && wallet.kind === "corporation") acceptorKind = "corporation";
    else acceptorKind = "character";
  }

  const rewardEscrow = Number(record.rewardEscrow || 0);
  const issuerOwnerId = toPositiveInteger(record.issuerOwnerID, 0);

  let pendingKind = null;
  try {
    const pending = settlementState.getPendingContractSettlement(cid);
    if (pending) {
      const kind = String(pending.kind || "");
      if (kind === "create") pendingKind = "create";
      else if (kind.startsWith("accept-")) pendingKind = "accept";
      else if (kind.startsWith("terminal-")) pendingKind = "terminal";
    }
  } catch (_err) {
  }

  return {
    ok: true,
    contract: {
      status,
      rawStatus,
      acceptorId,
      acceptorKind,
      rewardEscrow,
      issuerOwnerId,
      pendingKind,
      courier: courierOf(record, CONTRACT_STATUS, rawStatus),
    },
  };
}

function readIssuerFrom(corporationState, corporationRuntime, corporationId) {
  if (!corporationState || typeof corporationState.getCorporationRecord !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  if (!corporationRuntime || typeof corporationRuntime.getCorporationRuntime !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }

  const cid = toPositiveInteger(corporationId, 0);
  if (!cid) return { ok: false, reason: "NO_ISSUER", detail: "invalid_corporation_id" };

  let record = null;
  try {
    record = corporationState.getCorporationRecord(cid);
  } catch (_err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }

  if (!record) return { ok: false, reason: "NO_ISSUER", detail: "record_not_found" };

  const ceoId = toPositiveInteger(record.ceoID || record.ceoId, 0);
  if (ceoId <= 0) return { ok: false, reason: "NO_ISSUER", detail: "no_ceo" };

  const isNpc = record.isNPC === true || record.isNpc === true || cid < 1000000;
  let hasRuntime = false;
  try {
    const runtime = corporationRuntime.getCorporationRuntime(cid);
    hasRuntime = !!runtime;
  } catch (_err) {
    hasRuntime = false;
  }

  return { ok: true, issuer: { corporationId: cid, ceoId, isNpc, hasRuntime } };
}

const PERMANENT_REJECTIONS = new Set(["CORPORATION_NOT_FOUND", "CHARACTER_NOT_FOUND"]);

const CONTRACT_LIMIT_ERROR = "ConTooManyContractsMax";

function contractLimitRefusal(text) {
  const t = String(text || "");
  return t.includes(CONTRACT_LIMIT_ERROR)
    ? { ok: false, reason: "CONTRACT_LIMIT", permanent: true, detail: t.slice(0, 200) }
    : null;
}

async function createWantToBuyFrom(contractRuntime, payload) {
  const call = buildWantToBuyCall(payload);
  if (!call.ok) return { ok: false, reason: "TRADE_CALL_INVALID", permanent: true, detail: call.detail };

  if (!contractRuntime || typeof contractRuntime.createContract !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }
  const role = contractRuntime.CORP_ROLE_CONTRACT_MANAGER;
  const session = call.info.forCorp ? markSyntheticIssuer(call.session, role) : call.session;

  try {
    const result = await contractRuntime.createContract(call.info, session);
    if (!result) return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_result" };
    if (result.success === true) {
      if (result.rejected === true) {
        const detail = String(result.errorMsg || "CONTRACT_CREATION_REJECTED");
        return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: PERMANENT_REJECTIONS.has(detail), rejected: true, detail };
      }
      const id = Array.isArray(result.contractIDs) ? result.contractIDs[0] : undefined;
      if (Number.isSafeInteger(id) && id > 0) return { ok: true, contractId: id };
      return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_contract_id" };
    }
    const errorMsg = String(result.errorMsg || "");
    const limited = contractLimitRefusal(errorMsg);
    if (limited) return limited;
    const isPermanent = errorMsg.includes("is not a station") || errorMsg.includes("UNSUPPORTED");
    return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: isPermanent, detail: errorMsg };
  } catch (err) {
    const text = contractErrorTextOf(err);
    const limited = contractLimitRefusal(text);
    if (limited) return limited;
    const isPermanent = text.includes("is not a station") || text.includes("UNSUPPORTED");
    return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: isPermanent, detail: text.slice(0, 200) };
  }
}

async function deleteTradeContractFrom(contractRuntime, { contractId, ceoId, corporationId }) {
  if (!contractRuntime || typeof contractRuntime.deleteContract !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", pending: false };
  }

  const cid = toPositiveInteger(contractId, 0);
  if (!cid) return { ok: false, reason: "CONTRACT_DELETE_FAILED", permanent: true, pending: false, detail: "invalid_contract_id" };

  const session = markSyntheticIssuer({
    characterID: toPositiveInteger(ceoId, 0),
    corporationID: toPositiveInteger(corporationId, 0),
  }, contractRuntime.CORP_ROLE_CONTRACT_MANAGER);

  try {
    const result = await contractRuntime.deleteContract(cid, session);
    if (result === true) return { ok: true, deleted: true };
    return { ok: false, reason: "CONTRACT_DELETE_FAILED", permanent: false, pending: true, detail: "not_settled" };
  } catch (err) {
    const text = contractErrorTextOf(err);
    const pending = text.includes("already pending");
    return { ok: false, reason: "CONTRACT_DELETE_FAILED", permanent: false, pending, detail: text.slice(0, 200) };
  }
}

function divisionBalanceOf(walletState, corporationId, accountKey) {
  if (!walletState) return null;
  const finite = (value) => {
    if (value === null || value === undefined || value === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  try {
    if (typeof walletState.getCorporationWalletDivision === "function") {
      const division = walletState.getCorporationWalletDivision(corporationId, accountKey);
      if (!division || typeof division !== "object") return null;
      if (typeof walletState.getCorporationWalletBalance === "function") {
        return finite(walletState.getCorporationWalletBalance(corporationId, accountKey));
      }
      return finite(division.balance);
    }
    if (typeof walletState.getCorporationWallet !== "function") return null;
    const wallet = walletState.getCorporationWallet(corporationId);
    const divisions = wallet && wallet.divisions;
    if (!divisions || typeof divisions !== "object") return null;
    const division = divisions[String(Number(accountKey))];
    if (!division || typeof division !== "object") return null;
    return finite(division.balance);
  } catch (_err) {
    return null;
  }
}

async function adjustCorpDivisionFrom(corpWallet, walletState, { corporationId, accountKey, deltaIsk, commandId, description }) {
  if (!commandId || typeof commandId !== "string" || !commandId.startsWith(COMMAND_PREFIX)) {
    return { ok: false, reason: "WALLET_KEY_INVALID", permanent: true };
  }

  if (!corpWallet || typeof corpWallet.adjustCorporationWalletDivisionBalanceAsync !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }
  if (!walletState || typeof walletState.getCorporationWallet !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }

  const cid = toPositiveInteger(corporationId, 0);
  const key = Number(accountKey);
  const delta = Number(deltaIsk);

  if (!cid) return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_corporation_id" };
  if (!Number.isInteger(key) || key < 1000 || key > 1006) {
    return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_account_key" };
  }
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_delta" };
  }

  if (delta < 0) {
    try {
      const wallet = walletState.getCorporationWallet(cid);
      if (!wallet) return { ok: false, reason: "CORPORATION_NOT_FOUND", permanent: true };
    } catch (_err) {
    }
  }

  const options = {
    idempotencyKey: commandId,
    ownerID1: cid,
    ownerID2: 0,
    referenceID: 0,
    entryTypeID: 3,
    description: String(description || "lne-trade").slice(0, 120),
  };
  const metadata = { commandID: commandId, source: "lne-trade" };

  try {
    const result = await corpWallet.adjustCorporationWalletDivisionBalanceAsync(cid, key, delta, options, metadata);
    if (!result) return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: "no_result" };
    if (result.success === true) {
      return { ok: true, duplicate: result.duplicate === true, fingerprintMismatch: result.fingerprintMismatch === true };
    }
    const errorMsg = String(result.errorMsg || "");
    if (errorMsg === "INSUFFICIENT_FUNDS" || errorMsg === "CORPORATION_NOT_FOUND") {
      return { ok: false, reason: errorMsg, permanent: true, detail: errorMsg };
    }
    if (errorMsg === "IDEMPOTENCY_KEY_INVALID" || errorMsg === "IDEMPOTENCY_KEY_REUSED") {
      return { ok: false, reason: "WALLET_KEY_INVALID", permanent: true, detail: errorMsg };
    }
    return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: errorMsg };
  } catch (err) {
    return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
  }
}

function characterWalletOf(walletState, characterId) {
  if (!walletState || typeof walletState.getCharacterWallet !== "function") return { exists: true, balance: null };
  try {
    const wallet = walletState.getCharacterWallet(characterId);
    if (wallet === null || wallet === undefined) return { exists: false, balance: null };
    const raw = wallet.balance;
    if (raw === null || raw === undefined || raw === "") return { exists: true, balance: null };
    const n = Number(raw);
    return { exists: true, balance: Number.isFinite(n) ? n : null };
  } catch (_err) {
    return { exists: true, balance: null };
  }
}

function characterBalanceOf(walletState, characterId) {
  return characterWalletOf(walletState, characterId).balance;
}

async function adjustCharacterWalletFrom(walletState, spec) {
  const { ownerId, deltaIsk, commandId, description } = spec || {};
  if (!commandId || typeof commandId !== "string" || !commandId.startsWith(COMMAND_PREFIX)) {
    return { ok: false, reason: "WALLET_KEY_INVALID", permanent: true };
  }
  if (!walletState || typeof walletState.adjustCharacterBalanceAsync !== "function"
      || typeof walletState.getCharacterWallet !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }
  if (!isId(ownerId)) return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_owner_id" };
  if (!Number.isSafeInteger(deltaIsk) || deltaIsk === 0) {
    return { ok: false, reason: "WALLET_FAILED", permanent: true, detail: "invalid_delta" };
  }

  const wallet = characterWalletOf(walletState, ownerId);
  if (!wallet.exists) return { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true };
  if (wallet.balance !== null && deltaIsk > 0 && wallet.balance + deltaIsk > MAX_CHARACTER_BALANCE) {
    return { ok: false, reason: "BALANCE_LIMIT", permanent: true };
  }

  const options = {
    idempotencyKey: commandId,
    ownerID1: ownerId,
    ownerID2: 0,
    referenceID: 0,
    entryTypeID: GM_CASH_TRANSFER,
    description: String(description || "lne-trade").slice(0, 120),
  };
  const metadata = { commandID: commandId, source: "lne-trade" };

  try {
    const result = await walletState.adjustCharacterBalanceAsync(ownerId, deltaIsk, options, metadata);
    if (!result) return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: "no_result" };
    if (result.success === true) {
      const ok = { ok: true, duplicate: result.duplicate === true, fingerprintMismatch: result.fingerprintMismatch === true };
      if (result.capped === true) ok.capped = true;
      return ok;
    }
    const errorMsg = String(result.errorMsg || "");
    if (errorMsg === "INSUFFICIENT_FUNDS" || errorMsg === "CHARACTER_NOT_FOUND") {
      return { ok: false, reason: errorMsg, permanent: true, detail: errorMsg };
    }
    if (errorMsg === "IDEMPOTENCY_KEY_INVALID" || errorMsg === "IDEMPOTENCY_KEY_REUSED") {
      return { ok: false, reason: "WALLET_KEY_INVALID", permanent: true, detail: errorMsg };
    }
    return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: errorMsg };
  } catch (err) {
    return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
  }
}

function readCharacterFrom(characterState, characterId) {
  if (!characterState || typeof characterState.peekCharacterRecord !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  const id = toPositiveInteger(characterId, 0);
  if (!id) return { ok: true, exists: false };
  try {
    const record = characterState.peekCharacterRecord(id);
    return { ok: true, exists: record !== null && record !== undefined };
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
  }
}

function listDeliveredStacksFrom(itemStore, spec) {
  const { npcStationId, typeId, flag: explicitFlag } = spec;
  if (!itemStore || typeof itemStore.listContainerItems !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  const owner = ownerOf(spec);
  const resolved = resolveStackFlag(itemStore, owner ? owner.kind : "corporation", explicitFlag);
  if (!resolved.ok) return resolved.reason === "TRADE_FLAG_INVALID" ? resolved : { ok: false, reason: "SEAM_UNAVAILABLE" };
  const flag = resolved.flag;

  const cid = owner ? owner.id : 0;
  const stationId = toPositiveInteger(npcStationId, 0);
  const filterTypeId = toPositiveInteger(typeId, 0) || null;

  if (!cid || !stationId) return { ok: true, stacks: [] };

  try {
    const typeIdsArg = filterTypeId ? [filterTypeId] : null;
    const items = itemStore.listContainerItems(cid, stationId, flag, typeIdsArg) || [];
    const stacks = items
      .filter((item) => item && toPositiveInteger(item.ownerID, 0) === cid)
      .filter((item) => !filterTypeId || toPositiveInteger(item.typeID, 0) === filterTypeId)
      .map((item) => ({
        itemId: toPositiveInteger(item.itemID, 0),
        quantity: toPositiveInteger(item.singleton === 1 ? 1 : (item.stacksize ?? item.quantity), 0),
      }))
      .filter((s) => s.itemId > 0 && s.quantity > 0)
      .sort((a, b) => a.itemId - b.itemId);
    return { ok: true, stacks };
  } catch (_err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
}

function voidDeliveredStackFrom(itemCustody, itemStore, spec) {
  const { npcStationId, itemId, quantity, key, flag: explicitFlag } = spec;
  if (!key || typeof key !== "string" || !key.startsWith(COMMAND_PREFIX)) {
    return { ok: false, reason: "CUSTODY_KEY_INVALID", permanent: true };
  }

  if (!itemCustody || typeof itemCustody.getCommittedReceipt !== "function" ||
      typeof itemCustody.transfer !== "function" || !itemCustody.custodyRef ||
      typeof itemCustody.custodyRef.ownerLocation !== "function" ||
      typeof itemCustody.custodyRef.void !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  }
  const owner = ownerOf(spec);
  const resolved = resolveStackFlag(itemStore, owner ? owner.kind : "corporation", explicitFlag);
  if (!resolved.ok) {
    return resolved.reason === "TRADE_FLAG_INVALID"
      ? { ok: false, reason: "TRADE_FLAG_INVALID", permanent: true, ambiguous: false }
      : { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  }
  const flag = resolved.flag;
  if (!itemCustody.CUSTODY_REASON || !itemCustody.CUSTODY_REASON.INDUSTRY_MATERIAL_COMMIT) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  }

  const cid = owner ? owner.id : 0;
  const stationId = toPositiveInteger(npcStationId, 0);
  const iid = toPositiveInteger(itemId, 0);
  const qty = toPositiveInteger(quantity, 0);

  if (!cid || !stationId || !iid || !qty) {
    return { ok: false, reason: "ITEM_MISSING", permanent: true };
  }

  try {
    const receipt = itemCustody.getCommittedReceipt(key);
    if (receipt && receipt.committed === true) {
      return { ok: true, outcome: "ALREADY_COMMITTED" };
    }
  } catch (_err) {
  }

  const fromRef = itemCustody.custodyRef.ownerLocation(cid, stationId, flag);
  const toRef = itemCustody.custodyRef.void();

  try {
    const result = itemCustody.transfer({
      items: { itemID: iid, quantity: qty },
      from: fromRef,
      to: toRef,
      reason: itemCustody.CUSTODY_REASON.INDUSTRY_MATERIAL_COMMIT,
      actor: cid,
      idempotencyKey: key,
    });

    if (!result) return { ok: false, reason: "CUSTODY_FAILED", permanent: false, ambiguous: true, detail: "no_result" };
    if (result.success === true) {
      return { ok: true, outcome: result.duplicate === true ? "DUPLICATE" : "VOIDED" };
    }
    const errorMsg = String(result.errorMsg || "");
    const ambiguous = result.durable !== true || result.ambiguous === true;
    if (errorMsg === "ITEM_NOT_FOUND" || errorMsg === "ITEM_MISSING") {
      return { ok: false, reason: "ITEM_MISSING", permanent: true, ambiguous: false, detail: errorMsg };
    }
    return { ok: false, reason: "CUSTODY_FAILED", permanent: false, ambiguous, detail: errorMsg };
  } catch (err) {
    return { ok: false, reason: "CUSTODY_FAILED", permanent: false, ambiguous: true, detail: messageOf(err) };
  }
}

function listTaggedContractsFrom(contractRuntime, { ownerIds, corporationIds, limit, afterContractId }, deps = {}) {
  if (!contractRuntime || typeof contractRuntime.listContractRecords !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  if (deps && deps.gameStore) {
    const live = liveContractRows(contractRuntime, deps.gameStore);
    if (live !== null) {
      try {
        return taggedContractsOf(live, contractRuntime, { ownerIds, corporationIds, limit, afterContractId });
      } catch (_err) {
      }
    }
  }
  try {
    return taggedContractsOf(contractRuntime.listContractRecords() || [], contractRuntime,
      { ownerIds, corporationIds, limit, afterContractId });
  } catch (_err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
}

function liveContractRows(contractRuntime, gameStore) {
  try {
    if (!gameStore || typeof gameStore.read !== "function") return null;
    const table = contractRuntime.TABLE;
    if (typeof table !== "string" || table === "") return null;
    const res = gameStore.read(table, "/");
    const root = res && res.success === true ? res.data : null;
    if (!root || typeof root !== "object" || Array.isArray(root)) return null;
    const rows = [];
    for (const key of Object.keys(root)) {
      const value = root[key];
      if (key !== "_meta" && value && typeof value === "object") rows.push(value);
    }
    return rows;
  } catch (_err) {
    return null;
  }
}

function taggedContractsOf(records, contractRuntime, { ownerIds, corporationIds, limit, afterContractId }) {
  const ids = [
    ...(Array.isArray(ownerIds) ? ownerIds.filter(isId) : []),
    ...(Array.isArray(corporationIds) ? corporationIds.filter(isId) : []),
  ];
  const lim = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 100)));
  const after = toPositiveInteger(afterContractId, 0);
  const outstanding = contractRuntime.CONTRACT_STATUS && Number.isInteger(contractRuntime.CONTRACT_STATUS.OUTSTANDING)
    ? contractRuntime.CONTRACT_STATUS.OUTSTANDING : 0;

  const matches = [];
  for (const record of records) {
    const issuerOwnerId = toPositiveInteger(record.issuerOwnerID, 0);
    if (!ids.includes(issuerOwnerId)) continue;
    if (toStatus(record.status) !== outstanding) continue;
    const contractId = toPositiveInteger(record.contractID, 0);
    if (!contractId || contractId <= after) continue;
    const desc = String(record.description || "");
    const match = desc.match(/\[LNE:([^\]]+)\]/);
    if (!match) continue;
    const wallet = record.issuerWallet && typeof record.issuerWallet === "object" ? record.issuerWallet : null;
    matches.push({
      contractId,
      offerId: match[1],
      issuerOwnerId,
      reward: Number(record.reward || 0),
      issuerId: toPositiveInteger(record.issuerID, 0),
      issuerWallet: wallet
        ? {
            kind: wallet.kind === "corporation" ? "corporation" : "character",
            ownerId: toPositiveInteger(wallet.ownerID, 0),
            accountKey: toPositiveInteger(wallet.accountKey, 0) || null,
          }
        : { kind: "corporation", ownerId: issuerOwnerId, accountKey: null },
    });
  }
  matches.sort((a, b) => a.contractId - b.contractId);
  const contracts = matches.slice(0, lim);
  return { ok: true, contracts, truncated: matches.length > lim };
}

const MAX_SELL_ITEM_PAIRS = 16;
const MAX_GRANT_KEY_LENGTH = 512;
const GRANT_AMBIGUOUS_ERRORS = new Set(["IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS", "IDEMPOTENCY_RECEIPT_MISMATCH"]);
const GRANT_PERMANENT_ERRORS = new Set(["ITEM_TYPE_NOT_FOUND", "ITEM_QUANTITY_OUT_OF_RANGE", "INVALID_GRANT_DESTINATION",
  "INVALID_IDEMPOTENCY_KEY"]);
const SELL_ITEM_PERMANENT_MESSAGES = Object.freeze(["could not be found", "is not owned", "is not at the contract start location",
  "cannot be added", "does not have the requested quantity"]);

const grantKeyOk = (key) => typeof key === "string" && key.startsWith(COMMAND_PREFIX)
  && key.length <= MAX_GRANT_KEY_LENGTH && !key.includes("/") && key.trim() === key;

function itemIdsOf(list) {
  const out = [];
  for (const v of Array.isArray(list) ? list : []) {
    const id = toPositiveInteger(v, 0);
    if (id > 0 && !out.includes(id)) out.push(id);
  }
  return out;
}

function buildWantToSellCall(payload) {
  const bad = (detail) => ({ ok: false, reason: "TRADE_CALL_INVALID", detail });

  if (!payload || typeof payload !== "object") return bad("payload");
  const issuerKind = payload.issuerKind === undefined ? "corporation" : payload.issuerKind;
  if (issuerKind !== "corporation" && issuerKind !== "character") return bad("issuerKind");
  const offerId = String(payload.offerId || "").trim();
  if (!offerId) return bad("offerId");
  if (!isId(payload.corporationId)) return bad("corporationId");
  if (!isId(payload.ceoId)) return bad("ceoId");
  const accountKey = Number(payload.accountKey);
  if (!Number.isInteger(accountKey) || accountKey < 1000 || accountKey > 1006) return bad("accountKey");
  if (issuerKind === "character" && accountKey !== CHARACTER_ACCOUNT_KEY) return bad("accountKey");
  if (!isId(payload.npcStationId)) return bad("npcStationId");
  const list = payload.itemList;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SELL_ITEM_PAIRS) return bad("itemList");
  const itemList = [];
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isId(pair[0]) || !isId(pair[1])) return bad("itemList");
    itemList.push([pair[0], pair[1]]);
  }
  if (!Number.isSafeInteger(payload.priceIsk) || payload.priceIsk < 1) return bad("priceIsk");
  const minutesExpire = Math.max(1, Math.trunc(Number(payload.minutesExpire) || 0));
  const title = String(payload.title || "").slice(0, 200);
  if (!title) return bad("title");
  const description = String(payload.description || "").slice(0, 4000);
  if (!description.includes(`[LNE:${offerId}]`)) return bad("tag_missing");

  const character = issuerKind === "character";
  const info = {
    contractType: 1,
    isPrivate: false,
    assignedToID: 0,
    minutesExpire,
    numDays: 0,
    startStationID: payload.npcStationId,
    destinationID: 0,
    price: payload.priceIsk,
    reward: 0,
    collateral: 0,
    title,
    description,
    itemList,
    startStationDivision: character ? 4 : 62,
    requestItemTypeList: [],
    forCorp: !character,
    multiContract: false,
  };
  const session = character
    ? { characterID: payload.ceoId, corporationID: payload.corporationId }
    : { characterID: payload.ceoId, corporationID: payload.corporationId, corpAccountKey: accountKey };
  return { ok: true, info, session };
}

function grantSellStockFrom(itemStore, spec) {
  const s = spec || {};
  if (!grantKeyOk(s.key)) return { ok: false, reason: "GRANT_KEY_INVALID", permanent: true, ambiguous: false };
  if (!itemStore || typeof itemStore.grantItemToOwnerLocationIdempotent !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  }
  const owner = ownerOf(s);
  if (owner === null) return { ok: false, reason: "GRANT_FAILED", permanent: true, ambiguous: false, detail: "ownerKind" };
  let flag;
  if (s.flag === undefined) {
    flag = deliveryFlagOf(itemStore, owner.kind);
  } else {
    const resolved = resolveStackFlag(itemStore, owner.kind, s.flag);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason === "TRADE_FLAG_INVALID" ? "GRANT_FAILED" : "SEAM_UNAVAILABLE",
        permanent: resolved.permanent === true, ambiguous: false, detail: resolved.reason };
    }
    flag = resolved.flag;
  }
  if (flag === null) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, ambiguous: false };
  if (!owner.id || !isId(s.npcStationId) || !isId(s.typeId) || !isId(s.quantity)) {
    return { ok: false, reason: "GRANT_FAILED", permanent: true, ambiguous: false, detail: "spec" };
  }
  const options = s.packaged === true ? { receiptKey: s.key, singleton: 0 } : { receiptKey: s.key };
  let result;
  try {
    result = itemStore.grantItemToOwnerLocationIdempotent(owner.id, s.npcStationId, flag, s.typeId, s.quantity, options);
  } catch (err) {
    return { ok: false, reason: "GRANT_FAILED", permanent: false, ambiguous: true, detail: messageOf(err) };
  }
  if (!result || typeof result !== "object") {
    return { ok: false, reason: "GRANT_FAILED", permanent: false, ambiguous: true, detail: "no_result" };
  }
  if (result.success === true) {
    const data = result.data && typeof result.data === "object" ? result.data : {};
    let itemIds = itemIdsOf(data.itemIDs);
    if (itemIds.length === 0) {
      const receipt = result.receipt && result.receipt.resultData;
      itemIds = itemIdsOf(receipt && receipt.itemIDs);
    }
    if (itemIds.length === 0) {
      itemIds = itemIdsOf((Array.isArray(data.changes) ? data.changes : []).map((c) => c && c.item && c.item.itemID));
    }
    return { ok: true, duplicate: result.duplicate === true, itemIds };
  }
  const errorMsg = String(result.errorMsg || "IDEMPOTENT_GRANT_FAILED").slice(0, 120);
  if (result.ambiguous === true || GRANT_AMBIGUOUS_ERRORS.has(errorMsg)) {
    return { ok: false, reason: "GRANT_FAILED", permanent: false, ambiguous: true, detail: errorMsg };
  }
  return { ok: false, reason: "GRANT_FAILED", permanent: GRANT_PERMANENT_ERRORS.has(errorMsg), ambiguous: false,
    detail: errorMsg };
}

function readGrantReceiptFrom(itemStore, key) {
  if (!itemStore || typeof itemStore.getIdempotentGrantReceipt !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  let result;
  try {
    result = itemStore.getIdempotentGrantReceipt(key);
  } catch (err) {
    return { ok: false, reason: "GRANT_RECEIPT_AMBIGUOUS", detail: messageOf(err) };
  }
  if (!result || result.success !== true) {
    return { ok: false, reason: "GRANT_RECEIPT_AMBIGUOUS", detail: String((result && result.errorMsg) || "no_result") };
  }
  if (result.found !== true) return { ok: true, found: false, quantity: 0, itemIds: [] };
  const receipt = result.data && typeof result.data === "object" ? result.data : {};
  return {
    ok: true,
    found: true,
    quantity: toPositiveInteger(receipt.quantity, 0),
    itemIds: itemIdsOf(receipt.resultData && receipt.resultData.itemIDs),
  };
}

async function createWantToSellFrom(contractRuntime, itemStore, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (!contractRuntime || typeof contractRuntime.createContract !== "function"
      || !itemStore || typeof itemStore.listContainerItems !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }
  const character = p.issuerKind === "character";
  const ownerId = toPositiveInteger(character ? (p.ownerId ?? p.ceoId) : p.corporationId, 0);
  const flag = deliveryFlagOf(itemStore, character ? "character" : "corporation");
  if (flag === null) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  const quantity = toPositiveInteger(p.quantity, 0);
  if (!ownerId || !isId(p.npcStationId) || !isId(p.typeId) || !quantity) {
    return { ok: false, reason: "TRADE_CALL_INVALID", permanent: true, detail: "spec" };
  }
  const picked = grantedItemListOf(itemStore, { ownerId, stationId: p.npcStationId, flag, typeId: p.typeId, quantity,
    grantItemIds: p.grantItemIds });
  if (!picked.ok) return picked;
  const itemList = picked.itemList;

  const call = buildWantToSellCall({ ...p, itemList });
  if (!call.ok) return { ok: false, reason: "TRADE_CALL_INVALID", permanent: true, detail: call.detail };
  const role = contractRuntime.CORP_ROLE_CONTRACT_MANAGER;
  const session = call.info.forCorp ? markSyntheticIssuer(call.session, role) : call.session;
  const permanentMessage = (msg) => msg.includes("is not a station") || msg.includes("UNSUPPORTED")
    || SELL_ITEM_PERMANENT_MESSAGES.some((m) => msg.includes(m));

  try {
    const result = await contractRuntime.createContract(call.info, session);
    if (!result) return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_result" };
    if (result.success === true) {
      if (result.rejected === true) {
        const detail = String(result.errorMsg || "CONTRACT_CREATION_REJECTED");
        return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: PERMANENT_REJECTIONS.has(detail), rejected: true,
          detail };
      }
      const id = Array.isArray(result.contractIDs) ? result.contractIDs[0] : undefined;
      if (Number.isSafeInteger(id) && id > 0) return { ok: true, contractId: id };
      return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_contract_id" };
    }
    const errorMsg = String(result.errorMsg || "");
    const limited = contractLimitRefusal(errorMsg);
    if (limited) return limited;
    return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: permanentMessage(errorMsg), detail: errorMsg };
  } catch (err) {
    const text = contractErrorTextOf(err);
    const limited = contractLimitRefusal(text);
    if (limited) return limited;
    return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: permanentMessage(text), detail: text.slice(0, 200) };
  }
}

function grantedItemListOf(itemStore, { ownerId, stationId, flag, typeId, quantity, grantItemIds }) {
  const granted = new Set(itemIdsOf(grantItemIds));
  let items;
  try {
    items = itemStore.listContainerItems(ownerId, stationId, flag, [typeId]) || [];
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, detail: messageOf(err) };
  }
  const stacks = (Array.isArray(items) ? items : [])
    .filter((it) => it && toPositiveInteger(it.ownerID, 0) === ownerId && toPositiveInteger(it.typeID, 0) === typeId
      && granted.has(toPositiveInteger(it.itemID, 0)))
    .map((it) => ({
      itemId: toPositiveInteger(it.itemID, 0),
      quantity: toPositiveInteger(Number(it.singleton) === 1 ? 1 : (it.stacksize ?? it.quantity), 0),
    }))
    .filter((st) => st.quantity > 0)
    .sort((a, b) => a.itemId - b.itemId);
  const itemList = [];
  let rest = quantity;
  for (const st of stacks) {
    if (rest <= 0) break;
    const take = Math.min(st.quantity, rest);
    itemList.push([st.itemId, take]);
    rest -= take;
  }
  if (rest > 0) return { ok: false, reason: "SELL_STACK_SHORT", permanent: true, detail: `short:${rest}` };
  return { ok: true, itemList };
}

const COURIER_CONTRACT_TYPE = 3;
const DAY_FILETIME_TICKS = 24n * 60n * 60n * 10_000_000n;
const FILETIME_UNIX_EPOCH = 116444736000000000n;
const FILETIME_TICKS_PER_MS = 10000n;
const COURIER_PERMANENT_MESSAGES = Object.freeze(["ConExceedsMaxVolume", "CONTRACT_COURIER_VOLUME_TOO_LARGE",
  "Choose a destination", "is not a station", "UNSUPPORTED", ...SELL_ITEM_PERMANENT_MESSAGES]);

function contractErrorTextOf(err) {
  const parts = [messageOf(err)];
  try {
    const payload = err && err.machoErrorResponse && err.machoErrorResponse.payload;
    const args = payload && Array.isArray(payload.header) ? payload.header[1] : null;
    if (Array.isArray(args)) {
      if (typeof args[0] === "string") parts.push(args[0]);
      const entries = args[1] && Array.isArray(args[1].entries) ? args[1].entries : [];
      for (const e of entries) if (Array.isArray(e) && typeof e[1] === "string") parts.push(e[1]);
    }
  } catch (_err) {
  }
  return parts.join(" ").slice(0, 400);
}

function buildCourierCall(payload) {
  const bad = (detail) => ({ ok: false, reason: "TRADE_CALL_INVALID", detail });

  if (!payload || typeof payload !== "object") return bad("payload");
  const offerId = String(payload.offerId || "").trim();
  if (!offerId) return bad("offerId");
  if (!isId(payload.corporationId)) return bad("corporationId");
  if (!isId(payload.ceoId)) return bad("ceoId");
  if (!isId(payload.npcStationId)) return bad("npcStationId");
  if (!isId(payload.destinationStationId)) return bad("destinationStationId");
  if (payload.destinationStationId === payload.npcStationId) return bad("destination_is_start");
  const list = payload.itemList;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_SELL_ITEM_PAIRS) return bad("itemList");
  const itemList = [];
  for (const pair of list) {
    if (!Array.isArray(pair) || pair.length !== 2 || !isId(pair[0]) || !isId(pair[1])) return bad("itemList");
    itemList.push([pair[0], pair[1]]);
  }
  if (!Number.isSafeInteger(payload.rewardIsk) || payload.rewardIsk < 1) return bad("rewardIsk");
  if (!Number.isSafeInteger(payload.collateralIsk) || payload.collateralIsk < 0) return bad("collateralIsk");
  if (!Number.isSafeInteger(payload.numDays) || payload.numDays < 1) return bad("numDays");
  const minutesExpire = Math.max(1, Math.trunc(Number(payload.minutesExpire) || 0));
  const title = String(payload.title || "").slice(0, 200);
  if (!title) return bad("title");
  const description = String(payload.description || "").slice(0, 4000);
  if (!description.includes(`[LNE:${offerId}]`)) return bad("tag_missing");

  const info = {
    contractType: COURIER_CONTRACT_TYPE,
    isPrivate: false,
    assignedToID: 0,
    minutesExpire,
    numDays: payload.numDays,
    startStationID: payload.npcStationId,
    destinationID: payload.destinationStationId,
    price: 0,
    reward: payload.rewardIsk,
    collateral: payload.collateralIsk,
    title,
    description,
    itemList,
    startStationDivision: 4,
    requestItemTypeList: [],
    forCorp: false,
    multiContract: false,
  };
  return { ok: true, info, session: { characterID: payload.ceoId, corporationID: payload.corporationId } };
}

async function createCourierFrom(contractRuntime, itemStore, payload) {
  const p = payload && typeof payload === "object" ? payload : {};
  if (!contractRuntime || typeof contractRuntime.createContract !== "function"
      || !itemStore || typeof itemStore.listContainerItems !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  }
  const ownerId = toPositiveInteger(p.ceoId, 0);
  const flag = deliveryFlagOf(itemStore, "character");
  if (flag === null) return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
  const quantity = toPositiveInteger(p.quantity, 0);
  if (!ownerId || !isId(p.npcStationId) || !isId(p.typeId) || !quantity) {
    return { ok: false, reason: "TRADE_CALL_INVALID", permanent: true, detail: "spec" };
  }
  const picked = grantedItemListOf(itemStore, { ownerId, stationId: p.npcStationId, flag, typeId: p.typeId, quantity,
    grantItemIds: p.grantItemIds });
  if (!picked.ok) return picked;
  const call = buildCourierCall({ ...p, itemList: picked.itemList });
  if (!call.ok) return { ok: false, reason: "TRADE_CALL_INVALID", permanent: true, detail: call.detail };
  const permanentText = (text) => COURIER_PERMANENT_MESSAGES.some((m) => text.includes(m));

  try {
    const result = await contractRuntime.createContract(call.info, call.session);
    if (!result) return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_result" };
    if (result.success === true) {
      if (result.rejected === true) {
        const detail = String(result.errorMsg || "CONTRACT_CREATION_REJECTED");
        return { ok: false, reason: "CONTRACT_CREATE_FAILED", rejected: true, detail,
          permanent: PERMANENT_REJECTIONS.has(detail) || permanentText(detail) };
      }
      const id = Array.isArray(result.contractIDs) ? result.contractIDs[0] : undefined;
      if (Number.isSafeInteger(id) && id > 0) return { ok: true, contractId: id };
      return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_contract_id" };
    }
    const errorMsg = String(result.errorMsg || "");
    const limited = contractLimitRefusal(errorMsg);
    if (limited) return limited;
    return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: permanentText(errorMsg), detail: errorMsg };
  } catch (err) {
    const text = contractErrorTextOf(err);
    const limited = contractLimitRefusal(text);
    if (limited) return limited;
    return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: permanentText(text), detail: text.slice(0, 200) };
  }
}

async function failCourierFrom(contractRuntime, { contractId, ceoId, corporationId } = {}) {
  const status = contractRuntime && contractRuntime.CONTRACT_STATUS;
  if (!contractRuntime || typeof contractRuntime.completeContract !== "function" || !status
      || !Number.isInteger(status.FAILED)) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false, pending: false };
  }
  const cid = toPositiveInteger(contractId, 0);
  if (!cid) return { ok: false, reason: "COURIER_FAIL_FAILED", permanent: false, pending: false, detail: "invalid_contract_id" };
  const session = { characterID: toPositiveInteger(ceoId, 0), corporationID: toPositiveInteger(corporationId, 0) };
  try {
    const result = await contractRuntime.completeContract(cid, status.FAILED, session);
    if (result === true) return { ok: true };
    return { ok: false, reason: "COURIER_FAIL_FAILED", permanent: false, pending: true, detail: "not_settled" };
  } catch (err) {
    const text = contractErrorTextOf(err);
    if (text.includes("before its deadline")) {
      return { ok: false, reason: "COURIER_FAIL_EARLY", permanent: false, pending: false, detail: text.slice(0, 200) };
    }
    return { ok: false, reason: "COURIER_FAIL_FAILED", permanent: false, pending: text.includes("already pending"),
      detail: text.slice(0, 200) };
  }
}

function courierDeadlineMsOf(record) {
  try {
    const accepted = String(record.dateAccepted === undefined || record.dateAccepted === null ? "0" : record.dateAccepted);
    if (!/^\d+$/.test(accepted) || accepted === "0") return null;
    const days = Math.max(0, Math.trunc(Number(record.numDays) || 0));
    const ms = (BigInt(accepted) + BigInt(days) * DAY_FILETIME_TICKS - FILETIME_UNIX_EPOCH) / FILETIME_TICKS_PER_MS;
    const n = Number(ms);
    return Number.isSafeInteger(n) && n >= 0 ? n : null;
  } catch (_err) {
    return null;
  }
}

function courierOf(record, CONTRACT_STATUS, rawStatus) {
  if (toPositiveInteger(record.type, 0) !== COURIER_CONTRACT_TYPE) return null;
  let phase = "OTHER";
  if (rawStatus === CONTRACT_STATUS.OUTSTANDING) phase = "OUTSTANDING";
  else if (rawStatus === CONTRACT_STATUS.IN_PROGRESS) phase = "IN_PROGRESS";
  else if (rawStatus === CONTRACT_STATUS.FINISHED || rawStatus === CONTRACT_STATUS.FINISHED_ISSUER
    || rawStatus === CONTRACT_STATUS.FINISHED_CONTRACTOR) phase = "FINISHED";
  else if (rawStatus === CONTRACT_STATUS.FAILED) phase = "FAILED";
  else if (rawStatus === CONTRACT_STATUS.DELETED) phase = "DELETED";
  return { phase, deadlineMs: courierDeadlineMsOf(record),
    destinationStationId: toPositiveInteger(record.endStationID, 0) };
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function toStatus(value) {
  if (value === null || value === undefined || value === "") return -1;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return -1;
  const truncated = Math.trunc(numeric);
  return truncated >= 0 ? truncated : -1;
}

const PRIVATE_FEE_CONSTANT_RE = /^const PRIVATE_CONTRACT_BROKER_FEE = (\d+);$/m;
const PRIVATE_FEE_RULE_RE = /const isPrivate = resolveAvailability\(info, session\) !== CONTRACT_AVAILABILITY\.PUBLIC;\s*const privateBrokerFee = isPrivate && info\.contractType !== CONTRACT_TYPE\.AUCTION\s*\? PRIVATE_CONTRACT_BROKER_FEE\s*: 0;/;
const PRIVATE_FEE_AVAILABILITY_RE = /function resolveAvailability\(info, session\) \{\s*if \(!info\.isPrivate \|\| !info\.assignedToID\) \{\s*return CONTRACT_AVAILABILITY\.PUBLIC;/;
const PRIVATE_FEE_FUNDS_RE = /ensureWalletFunds\(\s*issuerWalletRef,\s*info\.reward \+ privateBrokerFee,/;

function parsePrivateContractFee(sourceText) {
  const drift = (detail) => ({ ok: false, reason: "PRIVATE_FEE_DRIFT", detail });
  if (typeof sourceText !== "string") return drift("constant");
  const m = PRIVATE_FEE_CONSTANT_RE.exec(sourceText);
  const feeIsk = m ? Number(m[1]) : NaN;
  if (!Number.isSafeInteger(feeIsk) || feeIsk <= 0) return drift("constant");
  if (!PRIVATE_FEE_RULE_RE.test(sourceText)) return drift("rule");
  if (!PRIVATE_FEE_AVAILABILITY_RE.test(sourceText)) return drift("availability");
  if (!PRIVATE_FEE_FUNDS_RE.test(sourceText)) return drift("funds");
  return { ok: true, feeIsk };
}

module.exports = {
  TAG_PREFIX,
  parsePrivateContractFee,
  PRIVATE_FEE_CONSTANT_RE,
  PRIVATE_FEE_RULE_RE,
  PRIVATE_FEE_AVAILABILITY_RE,
  PRIVATE_FEE_FUNDS_RE,
  COMMAND_PREFIX,
  PERMANENT_REJECTIONS,
  CONTRACT_LIMIT_ERROR,
  CHARACTER_ACCOUNT_KEY,
  MAX_CHARACTER_BALANCE,
  isId,
  buildWantToBuyCall,
  findTradeContractFrom,
  readTradeContractFrom,
  readIssuerFrom,
  createWantToBuyFrom,
  deleteTradeContractFrom,
  adjustCorpDivisionFrom,
  divisionBalanceOf,
  adjustCharacterWalletFrom,
  characterBalanceOf,
  characterWalletOf,
  readCharacterFrom,
  listDeliveredStacksFrom,
  voidDeliveredStackFrom,
  listTaggedContractsFrom,
  MAX_SELL_ITEM_PAIRS,
  buildWantToSellCall,
  grantSellStockFrom,
  readGrantReceiptFrom,
  createWantToSellFrom,
  buildCourierCall,
  createCourierFrom,
  failCourierFrom,
  contractErrorTextOf,
  courierDeadlineMsOf,
};