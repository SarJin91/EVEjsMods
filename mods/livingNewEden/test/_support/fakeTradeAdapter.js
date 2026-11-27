"use strict";

const { buildWantToBuyCall, PERMANENT_REJECTIONS, grantSellStockFrom, readGrantReceiptFrom,
  createWantToSellFrom } = require("../../lib/adapter/tradeContracts");
const { placeAndAttachBuyOrderFrom, readBuyOrderFrom, findBuyOrderFrom, attachBuyEscrowFrom, detachEscrowFrom,
  cancelBuyOrderFrom, listCorpOrdersFrom, listTaggedEscrowsFrom, isBuyOrderDurationAllowedFrom,
  findSellOrderFrom, placeAndAttachSellOrderFrom, returnSellEscrowFrom } = require("../../lib/adapter/tradeMarket");

const TAG_PREFIX = "[LNE:";
const COMMAND_PREFIX = "lne:";

function walletRefOf(info, session) {
  if (info && info.forCorp === true) {
    return { kind: "corporation", ownerId: session.corporationID, accountKey: Number(session.corpAccountKey) };
  }
  return { kind: "character", ownerId: session.characterID, accountKey: 1000 };
}

const FLAG_HANGAR = 4;
const FLAG_CORP_DELIVERIES = 62;
const MAX_CHARACTER_BALANCE = 10_000_000_000_000;

let virtualCorpsIssuers = [];
let virtualCorpsNames = new Map();
let virtualCorpsFacade = null;

function setVirtualCorpsIssuers(issuers) {
  virtualCorpsIssuers = issuers || [];
  virtualCorpsFacade = null;
}

function setVirtualCorpsNames(names) {
  virtualCorpsNames = new Map(Object.entries(names || {}).map(([k, v]) => [Number(k), v]));
  virtualCorpsFacade = null;
}

function listTradeIssuers(factionId) {
  const issuers = virtualCorpsIssuers.filter(i => factionId === undefined || factionId === null || i.factionId === factionId);
  return { ok: true, ready: true, issuers: Object.freeze(issuers.slice()) };
}

function nameOf(corporationId) {
  return virtualCorpsNames.get(corporationId) || null;
}

function ownerOfSpec(spec) {
  const explicit = spec.flag === "hangar" ? FLAG_HANGAR : (spec.flag === "delivery" ? undefined : spec.flag);
  if (spec.ownerKind === "character") return { kind: "character", id: spec.ownerId, flag: explicit !== undefined ? explicit : FLAG_HANGAR };
  return { kind: "corporation", id: spec.ownerId ?? spec.corporationId, flag: explicit !== undefined ? explicit : FLAG_CORP_DELIVERIES };
}

function issuerOwnerOf(contract) {
  return contract.issuerOwnerId ?? contract.corporationId;
}

function createFakeTradeAdapter(initialState = {}, opts = {}) {
  const leaveDeletedRecord = opts.leaveDeletedRecord === true;
  const privateBrokerFee = Number.isSafeInteger(opts.privateBrokerFee) && opts.privateBrokerFee > 0 ? opts.privateBrokerFee : 0;
  const persistentState = {
    contracts: new Map(),
    receipts: new Set(),
    wallets: new Map(),
    escrows: new Map(),
    marketOrders: new Map(),
  };
  const transientState = {
    pendingCreates: new Map(),
    hangarStacks: new Map(),
    ...initialState,
  };
  let rejectNextCreate = null;
  let collideNextWallet = false;

  const state = {
    get contracts() { return persistentState.contracts; },
    get receipts() { return persistentState.receipts; },
    get pendingCreates() { return transientState.pendingCreates; },
    get wallets() { return persistentState.wallets; },
    get hangarStacks() { return transientState.hangarStacks; },
    get escrows() { return persistentState.escrows; },
    get marketOrders() { return persistentState.marketOrders; },
    get marketPlaceCalls() { return calls.tradeMarketPlace || 0; },
    set contracts(v) { persistentState.contracts = v; },
    set receipts(v) { persistentState.receipts = v; },
    set pendingCreates(v) { transientState.pendingCreates = v; },
    set wallets(v) { persistentState.wallets = v; },
    set hangarStacks(v) { transientState.hangarStacks = v; },
    set escrows(v) { persistentState.escrows = v; },
    set marketOrders(v) { persistentState.marketOrders = v; },
  };
  const calls = {};
  const countCall = (name) => { calls[name] = (calls[name] || 0) + 1; };
  const nowMs = typeof opts.now === "function" ? opts.now : Date.now;

  function balanceOf(ownerId, accountKey) {
    const wallet = state.wallets.get(ownerId) || {};
    return wallet[accountKey] || 0;
  }

  function addBalance(ownerId, accountKey, delta) {
    const wallet = state.wallets.get(ownerId) || {};
    wallet[accountKey] = (wallet[accountKey] || 0) + delta;
    state.wallets.set(ownerId, wallet);
  }

  function nextContractId() {
    return 1000000 + state.contracts.size + state.pendingCreates.size + 1;
  }

  function fingerprint(payload) {
    return JSON.stringify(payload);
  }

  const grantReceipts = new Map();
  let nextItemId = 900000001;
  let sellSeamsOn = true;
  let failNextGrant = null;
  let ambiguousNextReceipt = false;
  let failNextSellCreate = null;
  const stackMapOf = (ownerId, stationId) => {
    let stationMap = state.hangarStacks.get(ownerId);
    if (!stationMap) { stationMap = new Map(); state.hangarStacks.set(ownerId, stationMap); }
    let stacks = stationMap.get(stationId);
    if (!stacks) { stacks = new Map(); stationMap.set(stationId, stacks); }
    return stacks;
  };

  let marketDown = false;
  let losePlaceResponse = false;
  let rejectPlaceOrder = false;
  let marketSeamsOn = true;
  let nextMarketOrderId = 7000001;
  const daemonCalls = {};
  const placeParamsLog = [];
  let sellMarketSeamsOn = true;
  const sellLog = [];
  const daemonError = (message, details) => {
    const err = new Error(message);
    if (details.code) err.code = details.code;
    err.marketDaemonRequestSent = details.requestSent === true;
    err.marketDaemonOutcomeUnknown = details.outcomeUnknown === true;
    return err;
  };
  const rejectedError = (message) => daemonError(message, { code: "MARKET_DAEMON_RPC_REJECTED", requestSent: true, outcomeUnknown: false });
  const cloneJson = (v) => JSON.parse(JSON.stringify(v));
  const ownerOrderOf = (o) => ({
    order_id: o.orderId, owner_id: o.ownerId, is_corp: o.isCorp, state: o.state,
    row: { order_id: o.orderId, price: o.priceCents / 100, vol_remaining: o.volRemaining, type_id: o.typeId,
      range_value: -1, vol_entered: o.volEntered, min_volume: o.minVolume, bid: o.bid, issued_at: o.issuedAt,
      duration_days: o.durationDays, station_id: o.stationId, source: o.source },
  });
  function addLedgerOrder({ orderId, ownerId, stationId, typeId, priceCents, quantity, source = "player",
    minVolume = 1, durationDays = 7, isCorp = true, bid = true }) {
    state.marketOrders.set(orderId, { orderId, ownerId, isCorp, stationId, typeId, priceCents, volEntered: quantity,
      volRemaining: quantity, minVolume, durationDays, state: "open", bid: bid !== false, source,
      issuedAt: new Date(nowMs()).toISOString() });
  }
  const ESCROW_BASE = 9_200_000_000;
  const escrowLocOf = (orderId) => {
    const n = Math.trunc(Number(orderId) || 0);
    return Number.isSafeInteger(n) && n > 0 ? ESCROW_BASE + n : 0;
  };
  function moveAllStacks(ownerId, fromLoc, toOwner, toLoc, toFlag) {
    const from = stackMapOf(ownerId, fromLoc);
    const to = stackMapOf(toOwner, toLoc);
    let units = 0;
    for (const [itemId, s] of [...from]) {
      to.set(itemId, { ...s, flag: toFlag });
      from.delete(itemId);
      units += s.quantity;
    }
    return units;
  }
  function terminalOrder(orderId, kind) {
    const order = state.marketOrders.get(orderId);
    if (!order || order.state !== "open") return false;
    order.state = kind;
    const rec = state.escrows.get(orderId);
    if (rec && String(rec.escrowType || "").toLowerCase() === "buy") {
      addBalance(rec.walletOwnerId ?? rec.ownerId, rec.accountKey ?? 1000, rec.escrowAmount);
      state.escrows.delete(orderId);
    } else if (rec && String(rec.escrowType || "").toLowerCase() === "sell") {
      moveAllStacks(rec.sourceOwnerId, rec.escrowLocationID, rec.sourceOwnerId, rec.sourceLocationId, rec.sourceFlagId);
      state.escrows.delete(orderId);
    }
    return true;
  }
  const fakeMarketDaemon = {
    async call(method, params = {}) {
      daemonCalls[method] = (daemonCalls[method] || 0) + 1;
      if (marketDown) throw new Error("market daemon RPC connection is not ready");
      if (method === "PlaceOrder") {
        if (rejectPlaceOrder === true || (typeof rejectPlaceOrder === "number" && rejectPlaceOrder > 0)) {
          if (typeof rejectPlaceOrder === "number") rejectPlaceOrder -= 1;
          throw rejectedError("invalid order");
        }
        const orderId = String(nextMarketOrderId++);
        addLedgerOrder({ orderId, ownerId: params.owner_id, isCorp: params.is_corp === true, stationId: params.station_id,
          typeId: params.type_id, priceCents: Math.round(params.price * 100), quantity: params.quantity,
          source: params.source, minVolume: params.min_volume, durationDays: params.duration_days, bid: params.bid });
        placeParamsLog.push(cloneJson(params));
        if (losePlaceResponse) {
          losePlaceResponse = false;
          throw daemonError("market daemon RPC request timed out after 5000 ms",
            { code: "MARKET_DAEMON_RPC_TIMEOUT", requestSent: true, outcomeUnknown: true });
        }
        return { order_id: orderId };
      }
      if (method === "GetOrder" || method === "CancelOrder") {
        const orderId = String(params.order_id);
        const order = state.marketOrders.get(orderId);
        if (!order) throw rejectedError(`order ${orderId} not found`);
        if (method === "CancelOrder") terminalOrder(orderId, "cancelled");
        return ownerOrderOf(order);
      }
      if (method === "GetCorporationOrders") {
        return [...state.marketOrders.values()]
          .filter((o) => o.isCorp === (params.is_corp === true) && o.ownerId === params.owner_id)
          .map(ownerOrderOf);
      }
      throw rejectedError(`unknown method ${method}`);
    },
  };
  const fakeEscrowState = {
    getEscrowRecord(orderId) {
      const rec = state.escrows.get(String(orderId || "").trim());
      return rec ? cloneJson(rec) : null;
    },
    listEscrowRecords() {
      return [...state.escrows.values()].map(cloneJson);
    },
    putEscrowRecordDurable(record) {
      const key = String((record && record.orderId) || "").trim();
      if (!key) return { success: false, errorMsg: "ORDER_ID_REQUIRED" };
      state.escrows.set(key, { ...cloneJson(record), orderId: key });
      if (record && record.escrowType === "sell") sellLog.push(["put", key, record.escrowState]);
      return { success: true, errorMsg: null, flushed: true };
    },
    removeEscrowRecordDurable(orderId) {
      const key = String(orderId || "").trim();
      if (!key) return { success: false, errorMsg: "ORDER_ID_REQUIRED" };
      if (state.escrows.has(key) && state.escrows.get(key).escrowType === "sell") sellLog.push(["remove", key]);
      state.escrows.delete(key);
      return { success: true, errorMsg: null, flushed: true };
    },
  };
  const fakeItemCustody = Object.freeze({
    CUSTODY_REASON: Object.freeze({ MARKET_ESCROW_PLACE: "market-escrow-place", MARKET_ESCROW_RETURN: "market-escrow-return" }),
  });
  const custodyReceipts = new Set();
  let crashTransfer = null;
  const fakeMarketCustody = {
    MARKET_ESCROW_LOCATION_BASE: ESCROW_BASE,
    getEscrowLocationID: escrowLocOf,
    transferItem(command = {}) {
      const item = command.item || null;
      const escrowLoc = escrowLocOf(command.orderID);
      const key = String(command.idempotencyKey || "");
      if (crashTransfer === "before") { crashTransfer = null; throw new Error("crash before transfer"); }
      if (key && custodyReceipts.has(key)) return { success: true, duplicate: true, durable: true };
      if (!item || !item.itemID) return { success: false, errorMsg: "MARKET_CUSTODY_ROUTE_INVALID" };
      const ownerId = item.ownerID;
      const fromLoc = command.expectedSource ? command.expectedSource.locationID : item.locationID;
      const fromFlag = command.expectedSource ? command.expectedSource.flagID : item.flagID;
      const place = command.reason === fakeItemCustody.CUSTODY_REASON.MARKET_ESCROW_PLACE;
      const ret = command.reason === fakeItemCustody.CUSTODY_REASON.MARKET_ESCROW_RETURN;
      if (!(place && command.expectedSource && command.locationID === escrowLoc)
        && !(ret && item.locationID === escrowLoc)) return { success: false, errorMsg: "MARKET_CUSTODY_ROUTE_INVALID" };
      const from = stackMapOf(ownerId, fromLoc);
      const st = from.get(item.itemID);
      if (!st || st.flag !== fromFlag || item.locationID !== fromLoc) {
        return { success: false, errorMsg: "ITEM_CUSTODY_SOURCE_MISMATCH" };
      }
      const qty = command.quantity === undefined || command.quantity === null ? st.quantity : command.quantity;
      if (!(qty > 0) || qty > st.quantity) return { success: false, errorMsg: "ITEM_CUSTODY_QUANTITY_INVALID" };
      const to = stackMapOf(command.ownerID || ownerId, command.locationID);
      if (qty === st.quantity) {
        from.delete(item.itemID);
        to.set(item.itemID, { ...st, flag: command.flagID });
      } else {
        st.quantity -= qty;
        to.set(nextItemId++, { typeId: st.typeId, quantity: qty, flag: command.flagID });
      }
      if (key) custodyReceipts.add(key);
      sellLog.push([place ? "place" : "return", String(command.orderID), item.itemID, qty, key]);
      if (crashTransfer === "after") { crashTransfer = null; throw new Error("crash after transfer"); }
      return { success: true, duplicate: false, durable: true, data: { changes: [] } };
    },
  };
  function findItemRow(itemId) {
    for (const [ownerId, stationMap] of state.hangarStacks) {
      for (const [locationId, stacks] of stationMap) {
        const s = stacks.get(itemId);
        if (s) return { itemID: itemId, ownerID: ownerId, locationID: locationId, flagID: s.flag, typeID: s.typeId,
          quantity: s.quantity, stacksize: s.quantity, singleton: 0 };
      }
    }
    return null;
  }
  const ALLOWED_DURATIONS = new Set([0, 1, 3, 7, 14, 30, 90]);
  const fakeMarketRules = { isAllowedDuration: (days) => ALLOWED_DURATIONS.has(Number.isInteger(days) ? days : -1) };
  const fakeItemStore = {
    ITEM_FLAGS: Object.freeze({ HANGAR: FLAG_HANGAR, CORP_DELIVERIES: FLAG_CORP_DELIVERIES }),
    findItemById(itemId) {
      return findItemRow(Number(itemId));
    },
    listContainerItems(ownerId, locationId, flagId, typeIds) {
      const stacks = (state.hangarStacks.get(ownerId) || new Map()).get(locationId) || new Map();
      const types = typeIds ? new Set(typeIds) : null;
      const out = [];
      for (const [itemID, s] of stacks) {
        if (flagId !== null && flagId !== undefined && s.flag !== flagId) continue;
        if (types && !types.has(s.typeId)) continue;
        out.push({ itemID, ownerID: ownerId, locationID: locationId, flagID: s.flag, typeID: s.typeId,
          quantity: s.quantity, stacksize: s.quantity, singleton: 0 });
      }
      return out;
    },
    grantItemToOwnerLocationIdempotent(ownerId, locationId, flagId, typeId, quantity, options = {}) {
      const key = String(options.receiptKey || "").trim();
      if (!key || key.length > 512 || key.includes("/")) {
        return { success: false, ambiguous: false, errorMsg: "INVALID_IDEMPOTENCY_KEY" };
      }
      const existing = grantReceipts.get(key);
      if (existing) {
        const same = existing.ownerID === ownerId && existing.locationID === locationId && existing.flagID === flagId
          && existing.typeID === typeId && existing.quantity === quantity;
        if (!same) return { success: false, ambiguous: true, errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH" };
        return { success: true, duplicate: true, durable: true, receipt: JSON.parse(JSON.stringify(existing)),
          data: { itemIDs: existing.resultData.itemIDs.slice(), changes: [] } };
      }
      if (failNextGrant !== null) {
        const f = failNextGrant;
        failNextGrant = null;
        return { success: false, durable: false, ambiguous: f.ambiguous === true, errorMsg: f.errorMsg };
      }
      const stacks = stackMapOf(ownerId, locationId);
      let target = null;
      for (const [itemID, s] of [...stacks].sort((a, b) => a[0] - b[0])) {
        if (s.flag === flagId && s.typeId === typeId) { target = itemID; break; }
      }
      if (target === null) {
        target = nextItemId++;
        stacks.set(target, { typeId, quantity, flag: flagId });
      } else {
        stacks.get(target).quantity += quantity;
      }
      const receipt = { receiptKey: key, ownerID: ownerId, locationID: locationId, flagID: flagId, typeID: typeId,
        quantity, singleton: options.singleton, resultData: { itemIDs: [target] } };
      grantReceipts.set(key, receipt);
      return { success: true, duplicate: false, durable: true, receipt: JSON.parse(JSON.stringify(receipt)),
        data: { quantity, changes: [{ item: { itemID: target } }] } };
    },
    getIdempotentGrantReceipt(key) {
      if (ambiguousNextReceipt) {
        ambiguousNextReceipt = false;
        return { success: false, durable: false, ambiguous: true, errorMsg: "IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS",
          data: null };
      }
      const receipt = grantReceipts.get(String(key || "").trim()) || null;
      return { success: true, durable: Boolean(receipt), pending: false, found: Boolean(receipt),
        data: receipt ? JSON.parse(JSON.stringify(receipt)) : null };
    },
  };
  const fakeContractRuntime = {
    createContract(info, session) {
      if (failNextSellCreate !== null) {
        const msg = failNextSellCreate;
        failNextSellCreate = null;
        return Promise.reject(new Error(msg));
      }
      const ownerId = info.forCorp ? session.corporationID : session.characterID;
      const stacks = (state.hangarStacks.get(ownerId) || new Map()).get(info.startStationID) || new Map();
      for (const [itemID, qty] of info.itemList) {
        const s = stacks.get(itemID);
        if (!s) return Promise.reject(new Error(`Item ${itemID} could not be found.`));
        const flagOk = info.forCorp ? s.flag === FLAG_CORP_DELIVERIES && info.startStationDivision === FLAG_CORP_DELIVERIES
          : s.flag === FLAG_HANGAR;
        if (!flagOk) return Promise.reject(new Error(`Item ${itemID} cannot be added to a contract from its current hangar.`));
        if (s.quantity < qty) return Promise.reject(new Error(`Item ${itemID} does not have the requested quantity.`));
      }
      const itemTypes = new Map();
      for (const [itemID, qty] of info.itemList) {
        const s = stacks.get(itemID);
        itemTypes.set(itemID, s.typeId);
        s.quantity -= qty;
        if (s.quantity === 0) stacks.delete(itemID);
      }
      const contractId = nextContractId();
      const walletRef = walletRefOf(info, session);
      const match = String(info.description).match(/\[LNE:([^\]]+)\]/);
      state.contracts.set(contractId, {
        contractId, offerId: match ? match[1] : null, corporationId: session.corporationID,
        issuerOwnerId: info.forCorp ? session.corporationID : session.characterID, status: "OUTSTANDING",
        payload: { info: JSON.parse(JSON.stringify(info)), session }, createdAt: 0, escrowIsk: 0, walletRef,
        itemList: info.itemList.map((p) => p.slice()), itemTypes,
      });
      return Promise.resolve({ success: true, contractIDs: [contractId] });
    },
  };
  const sellSeams = { daemon: fakeMarketDaemon, escrowState: fakeEscrowState, itemStore: fakeItemStore,
    itemCustody: fakeItemCustody, marketCustody: fakeMarketCustody };

  const api = {
    checkTradeSeams() {
      return { ok: true };
    },

    tradePrivateContractFee() {
      return { ok: true, feeIsk: privateBrokerFee };
    },

    tradeCreateContract(payload) {
      const call = buildWantToBuyCall(payload);
      if (!call.ok) return Promise.resolve(call);

      const fp = fingerprint({ info: call.info, session: call.session });
      const existing = state.pendingCreates.get(fp);
      if (existing) {
        return Promise.resolve({ ok: true, contractId: existing.contractId, duplicate: true });
      }

      if (rejectNextCreate !== null) {
        const detail = rejectNextCreate;
        rejectNextCreate = null;
        return Promise.resolve({
          ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: PERMANENT_REJECTIONS.has(detail), rejected: true, detail,
        });
      }

      const walletRef = walletRefOf(call.info, call.session);
      const reward = call.info.reward;
      const fee = call.info.isPrivate && call.info.assignedToID ? privateBrokerFee : 0;
      if (balanceOf(walletRef.ownerId, walletRef.accountKey) < reward + fee) {
        return Promise.resolve({
          ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false,
          detail: `Contract reward escrow ${reward} ISK does not have enough funds.`,
        });
      }
      addBalance(walletRef.ownerId, walletRef.accountKey, -(reward + fee));

      const contractId = nextContractId();
      const infoForPayload = call.info.forCorp === false
        ? { ...call.info, session: call.session }
        : call.info;
      const contract = {
        contractId,
        offerId: payload.offerId,
        corporationId: payload.corporationId,
        issuerOwnerId: walletRef.kind === "character" ? walletRef.ownerId : payload.corporationId,
        status: "OUTSTANDING",
        payload: { info: infoForPayload, session: call.session },
        createdAt: Date.now(),
        escrowIsk: reward,
        walletRef,
      };
      state.contracts.set(contractId, contract);
      state.pendingCreates.set(fp, { contractId, payload: contract.payload });
      return Promise.resolve({ ok: true, contractId });
    },

    tradeFindContract({ ownerId, corporationId, offerId }) {
      const tag = `${TAG_PREFIX}${offerId}]`;
      const owner = ownerId ?? corporationId;
      for (const [, contract] of state.contracts) {
        if (issuerOwnerOf(contract) === owner && contract.payload.info.description.includes(tag)) {
          return Promise.resolve({ ok: true, found: "record", contractId: contract.contractId, status: 0, duplicates: 0 });
        }
      }
      for (const [, pending] of state.pendingCreates) {
        if (pending.payload.info.description.includes(tag)) {
          return Promise.resolve({ ok: true, found: "pending", contractId: pending.contractId });
        }
      }
      return Promise.resolve({ ok: true, found: null });
    },

    tradeReadContract(contractId) {
      const contract = state.contracts.get(contractId);
      if (!contract) return Promise.resolve({ ok: true, contract: null });
      let acceptorId = null;
      let acceptorKind = null;
      if (contract.acceptorId !== undefined && contract.acceptorWallet) {
        acceptorId = contract.acceptorId;
        acceptorKind = contract.acceptorWallet.kind;
      }
      return Promise.resolve({
        ok: true,
        contract: {
          status: contract.status,
          rawStatus: 0,
          acceptorId,
          acceptorKind,
          rewardEscrow: contract.payload?.info?.reward ?? 0,
          issuerOwnerId: issuerOwnerOf(contract),
          pendingKind: state.pendingCreates.has(fingerprint(contract.payload)) ? "create" : null,
        },
      });
    },

    tradeDeleteContract({ contractId, ceoId, corporationId }) {
      const contract = state.contracts.get(contractId);
      if (!contract) {
        return Promise.resolve({ ok: false, reason: "CONTRACT_DELETE_FAILED", permanent: false, pending: true, detail: "not_settled" });
      }
      const issuerId = contract.payload && contract.payload.session ? contract.payload.session.characterID : undefined;
      const hasIssuer = Number.isInteger(issuerId) && issuerId > 0;
      if (!hasIssuer && contract.corporationId !== corporationId) {
        return Promise.resolve({ ok: false, reason: "CONTRACT_DELETE_FAILED", pending: false, detail: "not_issuer" });
      }
      if (hasIssuer && ceoId !== issuerId) {
        return Promise.resolve({
          ok: false, reason: "CONTRACT_DELETE_FAILED", permanent: false, pending: false,
          detail: "Only the issuer can delete this contract.",
        });
      }
      const fp = fingerprint(contract.payload);
      if (state.pendingCreates.has(fp)) {
        return Promise.resolve({ ok: false, reason: "CONTRACT_DELETE_FAILED", pending: true, detail: "already pending" });
      }
      const refundable = contract.status === "OUTSTANDING" || contract.status === "REJECTED";
      if (refundable && contract.escrowIsk > 0 && contract.walletRef) {
        addBalance(contract.walletRef.ownerId, contract.walletRef.accountKey, contract.escrowIsk);
        contract.escrowIsk = 0;
      }
      if (refundable && Array.isArray(contract.itemList) && contract.itemList.length > 0) {
        const info = contract.payload.info;
        const stacks = stackMapOf(issuerOwnerOf(contract), info.startStationID);
        const flag = info.forCorp === true ? FLAG_CORP_DELIVERIES : FLAG_HANGAR;
        for (const [itemID, qty] of contract.itemList) {
          const s = stacks.get(itemID);
          if (s) s.quantity += qty;
          else stacks.set(itemID, { typeId: contract.itemTypes.get(itemID), quantity: qty, flag });
        }
        contract.itemList = [];
      }
      if (leaveDeletedRecord) contract.status = "DELETED";
      else state.contracts.delete(contractId);
      return Promise.resolve({ ok: true, deleted: true });
    },

    tradeAdjustWallet(spec) {
      const { deltaIsk, commandId } = spec;
      if (!commandId || !commandId.startsWith(COMMAND_PREFIX)) {
        return Promise.resolve({ ok: false, reason: "WALLET_KEY_INVALID", permanent: true });
      }
      const isCharacter = spec.ownerKind === "character";
      const ownerId = isCharacter ? spec.ownerId : spec.corporationId;
      const accountKey = isCharacter ? 1000 : spec.accountKey;
      if (isCharacter && !state.wallets.has(ownerId)) {
        return Promise.resolve({ ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true });
      }
      const corpWallet = state.wallets.get(ownerId) || {};
      const balance = corpWallet[accountKey] || 0;
      if (isCharacter && deltaIsk > 0 && balance + deltaIsk > MAX_CHARACTER_BALANCE) {
        return Promise.resolve({ ok: false, reason: "BALANCE_LIMIT", permanent: true });
      }
      if (collideNextWallet) {
        collideNextWallet = false;
        return Promise.resolve({ ok: true, duplicate: true, fingerprintMismatch: true });
      }
      if (state.receipts.has(commandId)) {
        return Promise.resolve({ ok: true, duplicate: true, fingerprintMismatch: false });
      }
      if (deltaIsk < 0 && balance + deltaIsk < 0) {
        return Promise.resolve({ ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
      }
      corpWallet[accountKey] = balance + deltaIsk;
      state.wallets.set(ownerId, corpWallet);
      state.receipts.add(commandId);
      return Promise.resolve({ ok: true, duplicate: false, fingerprintMismatch: false });
    },

    tradeReadWallet(corporationId, accountKey) {
      const corpWallet = state.wallets.get(corporationId) || {};
      const balance = corpWallet[accountKey] || 0;
      return { ok: true, balanceIsk: balance };
    },

    tradeReadCharacter(characterId) {
      return { ok: true, exists: state.wallets.has(characterId) };
    },

    tradeReadCharacterWallet(characterId) {
      if (!state.wallets.has(characterId)) return { ok: true, balanceIsk: null };
      return { ok: true, balanceIsk: state.wallets.get(characterId)[1000] || 0 };
    },

    tradeVirtualIssuerSeams() {
      return { ok: true };
    },

    getVirtualCorps() {
      if (!virtualCorpsFacade) {
        virtualCorpsFacade = { listTradeIssuers, nameOf };
      }
      return virtualCorpsFacade;
    },

    tradeReadIssuer(corporationId) {
      return Promise.resolve({
        ok: true,
        issuer: { corporationId, ceoId: 123456789, isNpc: corporationId < 1000000, hasRuntime: true },
      });
    },

    tradeListDeliveredStacks(spec) {
      const { npcStationId, typeId } = spec;
      const owner = ownerOfSpec(spec);
      const stationMap = state.hangarStacks.get(owner.id) || new Map();
      const stacks = stationMap.get(npcStationId) || new Map();
      const result = [];
      for (const [itemId, stack] of stacks) {
        if (stack.flag !== owner.flag) continue;
        if (!typeId || stack.typeId === typeId) {
          result.push({ itemId, quantity: stack.quantity });
        }
      }
      result.sort((a, b) => a.itemId - b.itemId);
      return Promise.resolve({ ok: true, stacks: result });
    },

    tradeVoidStack(spec) {
      const { npcStationId, itemId, quantity, key } = spec;
      if (!key || !key.startsWith(COMMAND_PREFIX)) {
        return Promise.resolve({ ok: false, reason: "CUSTODY_KEY_INVALID", permanent: true });
      }
      if (state.receipts.has(key)) {
        return Promise.resolve({ ok: true, outcome: "ALREADY_COMMITTED" });
      }
      const owner = ownerOfSpec(spec);
      const stationMap = state.hangarStacks.get(owner.id);
      if (!stationMap) return Promise.resolve({ ok: false, reason: "ITEM_MISSING", permanent: true });
      const stacks = stationMap.get(npcStationId);
      if (!stacks) return Promise.resolve({ ok: false, reason: "ITEM_MISSING", permanent: true });
      const stack = stacks.get(itemId);
      if (!stack || stack.flag !== owner.flag || stack.quantity < quantity) {
        return Promise.resolve({ ok: false, reason: "ITEM_MISSING", permanent: true });
      }
      stack.quantity -= quantity;
      if (stack.quantity === 0) stacks.delete(itemId);
      state.receipts.add(key);
      return Promise.resolve({ ok: true, outcome: "VOIDED" });
    },

    tradeListTaggedContracts(spec) {
      const { limit = 100, afterContractId = 0 } = spec;
      const ids = [...(spec.ownerIds || []), ...(spec.corporationIds || [])];
      const matches = [];
      for (const [, contract] of state.contracts) {
        if (!ids.includes(issuerOwnerOf(contract))) continue;
        if (contract.status !== "OUTSTANDING") continue;
        if (!(contract.contractId > (afterContractId || 0))) continue;
        const desc = contract.payload && contract.payload.info ? contract.payload.info.description : "";
        const match = String(desc || "").match(/\[LNE:([^\]]+)\]/);
        if (!match) continue;
        const session = contract.payload ? contract.payload.session : null;
        const ref = contract.walletRef;
        matches.push({
          contractId: contract.contractId,
          offerId: match[1],
          issuerOwnerId: issuerOwnerOf(contract),
          reward: contract.payload.info.reward,
          issuerId: session && Number.isInteger(session.characterID) && session.characterID > 0 ? session.characterID : 0,
          issuerWallet: ref
            ? { kind: ref.kind === "character" ? "character" : "corporation", ownerId: ref.ownerId, accountKey: Number.isInteger(ref.accountKey) && ref.accountKey > 0 ? ref.accountKey : null }
            : { kind: "corporation", ownerId: issuerOwnerOf(contract), accountKey: null },
        });
      }
      matches.sort((a, b) => a.contractId - b.contractId);
      return Promise.resolve({ ok: true, contracts: matches.slice(0, limit), truncated: matches.length > limit });
    },

    tradeMarketPlace(spec) {
      countCall("tradeMarketPlace");
      return placeAndAttachBuyOrderFrom(fakeMarketDaemon, fakeEscrowState, spec, nowMs());
    },
    tradeMarketRead(orderId) {
      countCall("tradeMarketRead");
      return readBuyOrderFrom(fakeMarketDaemon, fakeEscrowState, orderId);
    },
    tradeMarketFind(spec) {
      countCall("tradeMarketFind");
      return findBuyOrderFrom(fakeMarketDaemon, fakeEscrowState, spec);
    },
    tradeMarketAttachEscrow(spec) {
      countCall("tradeMarketAttachEscrow");
      return attachBuyEscrowFrom(fakeEscrowState, spec);
    },
    tradeMarketDetachEscrow(spec) {
      countCall("tradeMarketDetachEscrow");
      const s = spec || {};
      return detachEscrowFrom(fakeEscrowState, { ...s, escrowType: s.escrowType === undefined ? "buy" : s.escrowType });
    },
    tradeMarketSellSeams() {
      countCall("tradeMarketSellSeams");
      return sellMarketSeamsOn ? { ok: true } : { ok: false, detail: "marketItemCustody.transferItem" };
    },
    tradeMarketFindSell(spec) {
      countCall("tradeMarketFindSell");
      return findSellOrderFrom(fakeMarketDaemon, fakeEscrowState, spec);
    },
    tradeMarketPlaceSell(spec) {
      countCall("tradeMarketPlaceSell");
      return placeAndAttachSellOrderFrom(sellSeams, spec, nowMs());
    },
    tradeMarketReturnSellEscrow(spec) {
      countCall("tradeMarketReturnSellEscrow");
      return returnSellEscrowFrom(sellSeams, spec);
    },
    tradeMarketCancel(orderId) {
      countCall("tradeMarketCancel");
      return cancelBuyOrderFrom(fakeMarketDaemon, orderId);
    },
    tradeMarketListCorpOrders(corporationId) {
      countCall("tradeMarketListCorpOrders");
      return listCorpOrdersFrom(fakeMarketDaemon, fakeEscrowState, corporationId);
    },
    tradeMarketListTaggedEscrows(spec) {
      countCall("tradeMarketListTaggedEscrows");
      return listTaggedEscrowsFrom(fakeEscrowState, spec);
    },
    tradeMarketDurationAllowed(days) {
      countCall("tradeMarketDurationAllowed");
      return isBuyOrderDurationAllowedFrom(fakeMarketRules, days);
    },
    checkTradeMarketSeams() {
      countCall("checkTradeMarketSeams");
      return marketSeamsOn ? { ok: true } : { ok: false, reason: "TRADE_MARKET_SEAM_UNAVAILABLE", missing: ["services/market/marketEscrowState"] };
    },

    _addEscrow(orderId, lneOfferId, ownerId, stationId, typeId, price, remainingQuantity, pendingFill = null) {
      const key = String(orderId);
      const at = new Date(nowMs()).toISOString();
      if (!state.marketOrders.has(key)) {
        addLedgerOrder({ orderId: key, ownerId, stationId, typeId, priceCents: price, quantity: remainingQuantity });
      }
      state.escrows.set(key, {
        orderId: key, ownerId, isCorp: true, walletOwnerId: ownerId, accountKey: null, escrowType: "buy",
        typeId, stationId, price: price / 100, remainingQuantity,
        escrowAmount: Math.round(price * remainingQuantity) / 100,
        issuedAt: at, durationDays: 7, fillAttemptSequence: 0, pendingFill,
        createdAt: at, updatedAt: at, lneOfferId,
      });
    },
    _addCorpOrder(corporationId, orderId, stationId, typeId, volRemaining, source = "player", priceCents = 100) {
      addLedgerOrder({ orderId: String(orderId), ownerId: corporationId, stationId, typeId, priceCents,
        quantity: volRemaining, source });
    },
    _setPendingFill(orderId, fill) {
      const escrow = state.escrows.get(String(orderId));
      if (!escrow) return;
      escrow.pendingFill = fill === true ? { orderID: String(orderId) } : (fill === false ? null : fill);
    },
    _fill(orderId, qty) {
      const key = String(orderId);
      const order = state.marketOrders.get(key);
      if (!order || order.state !== "open") return false;
      const q = Math.min(qty, order.volRemaining);
      order.volRemaining -= q;
      const rec = state.escrows.get(key);
      if (rec) {
        const stacks = stackMapOf(rec.ownerId, order.stationId);
        stacks.set(nextItemId++, { typeId: order.typeId, quantity: q, flag: FLAG_HANGAR });
        rec.remainingQuantity = order.volRemaining;
        rec.escrowAmount = Math.round(order.priceCents * order.volRemaining) / 100;
      }
      if (order.volRemaining === 0) {
        order.state = "filled";
        state.escrows.delete(key);
      }
      return true;
    },
    _terminal(orderId, kind) {
      return terminalOrder(String(orderId), kind === "cancelled" ? "cancelled" : "expired");
    },
    _fillSell(orderId, qty, taxPermille = 80) {
      const key = String(orderId);
      const order = state.marketOrders.get(key);
      const rec = state.escrows.get(key);
      if (!order || order.state !== "open" || order.bid || !rec) return false;
      const q = Math.min(qty, order.volRemaining);
      let rest = q;
      const stacks = stackMapOf(rec.sourceOwnerId, rec.escrowLocationID);
      for (const [itemId, s] of [...stacks].sort((a, b) => a[0] - b[0])) {
        if (rest <= 0) break;
        const take = Math.min(s.quantity, rest);
        s.quantity -= take;
        if (s.quantity === 0) stacks.delete(itemId);
        rest -= take;
      }
      const gross = Math.round(order.priceCents * q) / 100;
      addBalance(rec.walletOwnerId, rec.accountKey, gross - Math.round(gross * taxPermille) / 1000);
      order.volRemaining -= q;
      rec.remainingQuantity = order.volRemaining;
      if (order.volRemaining === 0) {
        order.state = "filled";
        state.escrows.delete(key);
      }
      return true;
    },
    _reconcilePlacing() {
      for (const [key, rec] of [...state.escrows]) {
        if (rec.escrowType !== "sell" || rec.escrowState !== "placing") continue;
        if (stackMapOf(rec.sourceOwnerId, rec.escrowLocationID).size > 0) {
          rec.escrowState = "active";
          continue;
        }
        const order = state.marketOrders.get(key);
        if (order && order.state === "open") order.state = "cancelled";
        state.escrows.delete(key);
      }
    },
    _crashTransfer(mode) { crashTransfer = mode === "before" || mode === "after" ? mode : null; },
    _crashAfter(name) {
      const real = api[name];
      api[name] = async (...args) => {
        api[name] = real;
        await real(...args);
        throw new Error(`crash after ${name}`);
      };
    },
    _setSellMarketSeams(on) { sellMarketSeamsOn = on === true; },
    _escrowStacksOf(orderId) {
      const rec = state.escrows.get(String(orderId));
      const ownerId = rec ? rec.sourceOwnerId : null;
      const loc = escrowLocOf(orderId);
      const out = [];
      for (const [owner, stationMap] of state.hangarStacks) {
        if (ownerId !== null && owner !== ownerId) continue;
        for (const [itemId, s] of stationMap.get(loc) || new Map()) out.push({ itemId, quantity: s.quantity });
      }
      return out;
    },
    _placeParams: placeParamsLog,
    _sellSeams: sellSeams,
    _sellLog: sellLog,
    _marketDown(on) { marketDown = on === true; },
    _losePlaceResponse() { losePlaceResponse = true; },
    _rejectPlaceOrder(v) { rejectPlaceOrder = v === true || (Number.isSafeInteger(v) && v > 0) ? v : false; },
    _forget(orderId) { state.marketOrders.delete(String(orderId)); },
    _setMarketSeams(on) { marketSeamsOn = on === true; },
    _calls: calls,
    _daemonCalls: daemonCalls,
    _marketDaemon: fakeMarketDaemon,
    _escrowState: fakeEscrowState,

    reject(contractId) {
      const contract = state.contracts.get(contractId);
      const info = contract && contract.payload && contract.payload.info;
      if (!info || info.isPrivate !== true || contract.status !== "OUTSTANDING") return false;
      contract.status = "REJECTED";
      return true;
    },

    tradeSellSeams() {
      return sellSeamsOn ? { ok: true } : { ok: false, detail: "grantItemToOwnerLocationIdempotent" };
    },
    tradeGrantStock(spec) {
      return grantSellStockFrom(fakeItemStore, spec);
    },
    tradeGrantReceipt(key) {
      return readGrantReceiptFrom(fakeItemStore, key);
    },
    tradeCreateSellContract(payload) {
      return createWantToSellFrom(fakeContractRuntime, fakeItemStore, payload);
    },
    _finishSell(contractId, acceptorId) {
      const contract = state.contracts.get(contractId);
      if (!contract || contract.status !== "OUTSTANDING" || !Array.isArray(contract.itemList)) return false;
      addBalance(contract.walletRef.ownerId, contract.walletRef.accountKey, Number(contract.payload.info.price) || 0);
      contract.status = "FINISHED";
      contract.acceptorId = acceptorId;
      contract.acceptorWallet = { kind: "character", ownerId: acceptorId, accountKey: 1000 };
      contract.itemList = [];
      return true;
    },
    _setSellSeams(on) { sellSeamsOn = on === true; },
    _failNextGrant(errorMsg, ambiguous = false) { failNextGrant = { errorMsg, ambiguous }; },
    _ambiguousNextReceipt() { ambiguousNextReceipt = true; },
    _failNextSellCreate(message) { failNextSellCreate = String(message); },
    _grantReceipts: grantReceipts,
    _hangarStacksOf(ownerId, npcStationId) {
      const stacks = (state.hangarStacks.get(ownerId) || new Map()).get(npcStationId) || new Map();
      return [...stacks].sort((a, b) => a[0] - b[0]).map(([itemId, s]) => ({ itemId, typeId: s.typeId, quantity: s.quantity,
        flag: s.flag }));
    },

    _state: state,
    _persistentState: persistentState,
    _transientState: transientState,
    _reset() {
      transientState.pendingCreates.clear();
      transientState.hangarStacks.clear();
    },
    _setVirtualCorpsIssuers(issuers) {
      setVirtualCorpsIssuers(issuers);
    },
    _setVirtualCorpsNames(names) {
      setVirtualCorpsNames(names);
    },
    _rejectNextCreate(errorMsg = "INSUFFICIENT_FUNDS") {
      rejectNextCreate = String(errorMsg);
    },
    _collideNextWallet() {
      collideNextWallet = true;
    },
    _balance(ownerId, accountKey) {
      return balanceOf(ownerId, accountKey);
    },
    _addHangarStack(ownerId, npcStationId, itemId, typeId, quantity, flag = FLAG_CORP_DELIVERIES) {
      let stationMap = state.hangarStacks.get(ownerId);
      if (!stationMap) {
        stationMap = new Map();
        state.hangarStacks.set(ownerId, stationMap);
      }
      let stacks = stationMap.get(npcStationId);
      if (!stacks) {
        stacks = new Map();
        stationMap.set(npcStationId, stacks);
      }
      stacks.set(itemId, { typeId, quantity, flag });
    },
    _setWalletBalance(corporationId, accountKey, balance) {
      let corpWallet = state.wallets.get(corporationId);
      if (!corpWallet) {
        corpWallet = {};
        state.wallets.set(corporationId, corpWallet);
      }
      corpWallet[accountKey] = balance;
    },
  };
  if (opts.marketFillMode !== undefined) {
    const answer = opts.marketFillMode;
    api.tradeMarketFillMode = () => {
      countCall("tradeMarketFillMode");
      return typeof answer === "function" ? answer() : answer;
    };
  }
  return api;
}

module.exports = { createFakeTradeAdapter };