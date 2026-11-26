"use strict";

const path = require("node:path");

const { markShopIssuer, wrapShopIssuerAuthority } = require("./issuer");

const TAG_PREFIX = "[customTypes:shop:v1:";
const TAG_PATTERN = /\[customTypes:shop:v1:(o|c[1-9]\d*)\]/u;
const CORP_DELIVERIES_FALLBACK = 62;
const ITEM_EXCHANGE = 1;
const BPO_SINGLETON = 1;
const BPC_SINGLETON = 2;

const MODULES = Object.freeze({
  contracts: "services/contracts/contractRuntimeState",
  settlements: "services/contracts/contractSettlementState",
  authority: "services/corporation/corporationAuthority",
  corporations: "services/corporation/corporationState",
  industry: "services/industry/industryRuntimeState",
  items: "services/inventory/itemStore",
  world: "space/worldData",
  store: "gameStore/index",
});

function tagOf(kindTag) {
  return `${TAG_PREFIX}${kindTag}]`;
}

function messageOf(error) {
  return String((error && error.message) || error || "unknown error").slice(0, 300);
}

const toId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
};

function createShopVendor(options = {}) {
  const runtimeRoot = options.runtimeRoot;
  const liveContractRead = options.liveContractRead === true;
  const requireModule = options.requireModule
    || ((relative) => require(path.join(runtimeRoot, "server", "src", ...relative.split("/"))));
  const cache = new Map();

  function mod(kind) {
    if (!cache.has(kind)) cache.set(kind, requireModule(MODULES[kind]));
    return cache.get(kind);
  }

  function corpDeliveries() {
    const flags = mod("items").ITEM_FLAGS;
    return flags && Number.isSafeInteger(flags.CORP_DELIVERIES) ? flags.CORP_DELIVERIES : CORP_DELIVERIES_FALLBACK;
  }

  function ensureAuthority() {
    try {
      return wrapShopIssuerAuthority(mod("authority"), mod("corporations"));
    } catch (error) {
      return { ok: false, reason: "AUTHORITY_SEAM_UNAVAILABLE", detail: messageOf(error) };
    }
  }

  function contractStatusOf(contracts, names) {
    const source = (contracts && contracts.CONTRACT_STATUS) || {};
    const status = {};
    for (const name of names) {
      const value = source[name];
      if (!Number.isSafeInteger(value)) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "CONTRACT_STATUS" };
      status[name] = value;
    }
    return { ok: true, status };
  }

  function firstItemRow(record) {
    const rows = Array.isArray(record.items) ? record.items : [];
    return rows.find((row) => row && row.inCrate !== false) || rows[0] || null;
  }

  function isOurRecord(record, issuerCorpID) {
    return Boolean(record) && record.forCorp === true && toId(record.issuerCorpID) === issuerCorpID
      && typeof record.description === "string" && TAG_PATTERN.test(record.description);
  }

  function liveContractRows(contracts) {
    if (!liveContractRead) return null;
    try {
      const table = contracts.TABLE;
      const store = mod("store");
      if (typeof table !== "string" || table === "" || !store || typeof store.read !== "function") return null;
      const res = store.read(table, "/");
      const root = res && res.success === true ? res.data : null;
      if (!root || typeof root !== "object" || Array.isArray(root)) return null;
      const rows = [];
      for (const key of Object.keys(root)) {
        const value = root[key];
        if (key !== "_meta" && value && typeof value === "object") rows.push(value);
      }
      return rows;
    } catch (_error) {
      return null;
    }
  }

  function readOurs(issuerCorpID) {
    try {
      const contracts = mod("contracts");
      const st = contractStatusOf(contracts, ["OUTSTANDING"]);
      if (!st.ok) return st;
      const records = liveContractRows(contracts) || contracts.listContractRecords();
      const ours = [];
      const byID = new Map();
      for (const record of Array.isArray(records) ? records : []) {
        if (!isOurRecord(record, issuerCorpID)) continue;
        const row = firstItemRow(record);
        const contract = {
          contractID: toId(record.contractID),
          stationID: toId(record.startStationID),
          typeID: toId(row && row.typeID),
          price: Number(record.price),
          kindTag: TAG_PATTERN.exec(record.description)[1],
          status: Number(record.status),
          dateExpiredFt: contracts.toFileTimeBigInt(record.dateExpired),
          pending: false,
        };
        ours.push(contract);
        byID.set(contract.contractID, contract);
      }
      const busyStations = new Set();
      const pending = mod("settlements").listPendingContractSettlements();
      for (const settlement of Array.isArray(pending) ? pending : []) {
        if (!settlement) continue;
        const own = byID.get(toId(settlement.contractID));
        if (own) {
          own.pending = true;
          if (own.stationID) busyStations.add(own.stationID);
          continue;
        }
        const base = settlement.payload && settlement.payload.baseRecord;
        if (base && isOurRecord(base, issuerCorpID) && toId(base.startStationID)) {
          busyStations.add(toId(base.startStationID));
        }
      }
      return { ok: true, ours, busyStations, outstandingStatus: st.status.OUTSTANDING };
    } catch (error) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(error) };
    }
  }

  function validateIssuer(corporationID) {
    try {
      const record = mod("corporations").getCorporationRecord(corporationID);
      if (!record || record.deleted) return { ok: false, reason: "ISSUER_NOT_FOUND" };
      const ceoID = toId(record.ceoID ?? record.ceoId);
      if (!ceoID) return { ok: false, reason: "ISSUER_NO_CEO" };
      return { ok: true, ceoID, name: String(record.corporationName || `Corporation ${corporationID}`) };
    } catch (error) {
      return { ok: false, reason: "ISSUER_NOT_FOUND", detail: messageOf(error) };
    }
  }

  function validateStation(stationID) {
    try {
      const station = mod("world").getStationByID(stationID);
      if (!station) return { ok: false, reason: "STATION_NOT_FOUND" };
      if (station.isStructure === true) return { ok: false, reason: "STATION_IS_STRUCTURE" };
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "STATION_NOT_FOUND", detail: messageOf(error) };
    }
  }

  function matchesKind(item, state, runs) {
    if (!state) return false;
    if (runs === null || runs === undefined) {
      return Number(item.singleton) === BPO_SINGLETON && state.original === true;
    }
    return Number(item.singleton) === BPC_SINGLETON && state.original === false && Number(state.runsRemaining) === runs;
  }

  function takeStock({ issuer, stationID, typeID, runs = null }) {
    try {
      const items = mod("items").listContainerItems(issuer, stationID, corpDeliveries(), [typeID]) || [];
      const industry = mod("industry");
      let best = null;
      let stale = 0;
      for (const item of items) {
        const itemID = toId(item && item.itemID);
        if (!itemID) continue;
        if (matchesKind(item, industry.getBlueprintState(itemID), runs)) {
          if (best === null || itemID < best) best = itemID;
        } else {
          stale += 1;
        }
      }
      return { ok: true, itemID: best, stale };
    } catch (error) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(error) };
    }
  }

  function grantBlueprint({ issuer, stationID, typeID, runs = null }) {
    try {
      const original = runs === null || runs === undefined;
      const result = mod("industry").seedBlueprintForOwner(issuer, stationID, {
        blueprintTypeID: typeID,
        original,
        runsRemaining: original ? -1 : runs,
        isCorporation: true,
        flagID: corpDeliveries(),
      });
      const itemID = toId(result && result.data && result.data.item && result.data.item.itemID);
      if (result && result.success === true && itemID) return { ok: true, itemID };
      return { ok: false, reason: "GRANT_FAILED", detail: String((result && result.errorMsg) || "no_item") };
    } catch (error) {
      return { ok: false, reason: "GRANT_FAILED", detail: messageOf(error) };
    }
  }

  async function createListing({ issuer, ceoID, accountKey, stationID, itemID, price, minutesExpire, title, description }) {
    try {
      const contracts = mod("contracts");
      const session = markShopIssuer(
        { characterID: ceoID, corporationID: issuer, corpAccountKey: accountKey },
        contracts.CORP_ROLE_CONTRACT_MANAGER,
      );
      const info = {
        contractType: ITEM_EXCHANGE,
        isPrivate: false,
        assignedToID: 0,
        minutesExpire,
        numDays: 0,
        startStationID: stationID,
        destinationID: 0,
        price,
        reward: 0,
        collateral: 0,
        title,
        description,
        itemList: [[itemID, 1]],
        startStationDivision: corpDeliveries(),
        requestItemTypeList: [],
        forCorp: true,
        multiContract: false,
      };
      const result = await contracts.createContract(info, session);
      if (!result) return { ok: false, reason: "CONTRACT_CREATE_FAILED", detail: "no_result" };
      if (result.success === true) {
        if (result.rejected === true) {
          return { ok: false, reason: "CONTRACT_CREATE_FAILED", rejected: true,
            detail: String(result.errorMsg || "CONTRACT_CREATION_REJECTED") };
        }
        const contractID = Array.isArray(result.contractIDs) ? result.contractIDs[0] : undefined;
        if (Number.isSafeInteger(contractID) && contractID > 0) return { ok: true, contractID };
        return { ok: false, reason: "CONTRACT_CREATE_FAILED", detail: "no_contract_id" };
      }
      return { ok: false, reason: "CONTRACT_CREATE_FAILED", detail: String(result.errorMsg || "create_failed") };
    } catch (error) {
      return { ok: false, reason: "CONTRACT_CREATE_FAILED", detail: messageOf(error) };
    }
  }

  async function deleteListing({ issuer, ceoID, contractID }) {
    try {
      const contracts = mod("contracts");
      const session = markShopIssuer({ characterID: ceoID, corporationID: issuer }, contracts.CORP_ROLE_CONTRACT_MANAGER);
      const result = await contracts.deleteContract(contractID, session);
      if (result === true) return { ok: true };
      return { ok: false, reason: "CONTRACT_DELETE_FAILED", pending: true, detail: "not_settled" };
    } catch (error) {
      const detail = messageOf(error);
      return { ok: false, reason: "CONTRACT_DELETE_FAILED", pending: detail.includes("already pending"), detail };
    }
  }

  function countOutstandingHolding(typeIDs) {
    try {
      const contracts = mod("contracts");
      const st = contractStatusOf(contracts, ["OUTSTANDING", "IN_PROGRESS"]);
      if (!st.ok) return st;
      const S = st.status;
      let outstanding = 0;
      let inProgress = 0;
      for (const record of contracts.listContractRecords() || []) {
        if (!record) continue;
        const status = Number(record.status);
        if (status !== S.OUTSTANDING && status !== S.IN_PROGRESS) continue;
        const rows = Array.isArray(record.items) ? record.items : [];
        if (!rows.some((row) => row && row.inCrate !== false && typeIDs.has(Number(row.typeID)))) continue;
        if (status === S.OUTSTANDING) outstanding += 1;
        else inProgress += 1;
      }
      return { ok: true, count: outstanding + inProgress, outstanding, inProgress };
    } catch (error) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(error) };
    }
  }

  return {
    countOutstandingHolding,
    createListing,
    deleteListing,
    ensureAuthority,
    grantBlueprint,
    readOurs,
    takeStock,
    validateIssuer,
    validateStation,
  };
}

module.exports = {
  MODULES,
  TAG_PATTERN,
  createShopVendor,
  tagOf,
};
