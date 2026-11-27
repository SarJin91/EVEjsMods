"use strict";

const assert = require("node:assert");

const {
  TAG_PREFIX,
  COMMAND_PREFIX,
  buildWantToBuyCall,
  findTradeContractFrom,
  readTradeContractFrom,
  readIssuerFrom,
  createWantToBuyFrom,
  deleteTradeContractFrom,
  adjustCorpDivisionFrom,
  divisionBalanceOf,
  listDeliveredStacksFrom,
  voidDeliveredStackFrom,
  listTaggedContractsFrom,
  adjustCharacterWalletFrom,
  MAX_CHARACTER_BALANCE,
} = require("../../lib/adapter/tradeContracts");
const { createAdapter } = require("../../lib/adapter");

const { readTradePricesFrom } = require("../../lib/adapter/marketPrices");

const PAYLOAD = Object.freeze({
  offerId: "offer-123",
  corporationId: 987654321,
  ceoId: 123456789,
  accountKey: 1000,
  npcStationId: 60003760,
  typeId: 34,
  quantity: 100,
  rewardIsk: 5000000,
  minutesExpire: 1440,
  title: "Buy Tritanium",
  description: "Wanted: Tritanium [LNE:offer-123]",
});

const CONTRACT_STATUS = Object.freeze({
  OUTSTANDING: 0,
  IN_PROGRESS: 1,
  FINISHED_ISSUER: 2,
  FINISHED_CONTRACTOR: 3,
  FINISHED: 4,
  CANCELLED: 5,
  REJECTED: 6,
  FAILED: 7,
  DELETED: 8,
  REVERSED: 9,
  BID_ON_BY: 10,
  REQUIRES_ATTENTION: -1,
});

function fakeContractRuntime(overrides = {}) {
  return {
    CONTRACT_STATUS,
    listContractRecords: () => overrides.records || [],
    getContractRecord: (id) => overrides.records?.find((r) => r.contractID === id) || null,
    createContract: overrides.createContract || (async () => ({ success: true, contractIDs: [12345] })),
    deleteContract: overrides.deleteContract || (async () => true),
    ...overrides,
  };
}

function vendorUserError(message, values) {
  const dictEntries = Object.entries(values);
  const payload = {
    type: "objectex1",
    header: [
      { type: "token", value: "eveexceptions.UserError" },
      [message, { type: "dict", entries: dictEntries }],
      { type: "dict", entries: [["msg", message], ["dict", { type: "dict", entries: dictEntries }]] },
    ],
    list: [],
    dict: [],
  };
  const err = new Error("Wrapped remote exception");
  err.name = "MachoWrappedException";
  err.machoErrorResponse = { errorCode: 2, payload };
  return err;
}

function fakeSettlementState(overrides = {}) {
  return {
    listPendingContractSettlements: () => overrides.pending || [],
    getPendingContractSettlement: (id) => overrides.pending?.find((p) => p.contractID === id) || null,
    ...overrides,
  };
}

function fakeCorporationState(overrides = {}) {
  return {
    getCorporationRecord: (id) => overrides.record || (id === 987654321 ? { corporationID: id, ceoID: 123456789, isNPC: true } : null),
    ...overrides,
  };
}

function fakeCorporationRuntime(overrides = {}) {
  return {
    getCorporationRuntime: (id) => overrides.runtime || (id === 987654321 ? { corporationID: id } : null),
    ...overrides,
  };
}

function fakeItemStore(overrides = {}) {
  return {
    ITEM_FLAGS: { CORP_DELIVERIES: 62, HANGAR: 4 },
    listContainerItems: (corpId, stationId, flagId, typeId) => overrides.items || [],
    ...overrides,
  };
}

function fakeItemCustody(overrides = {}) {
  return {
    CUSTODY_REASON: { INDUSTRY_MATERIAL_COMMIT: "industry-material-commit" },
    custodyRef: {
      ownerLocation: (corpId, stationId, flagId) => ({ kind: "owner-location", corporationId: corpId, stationId, flagId }),
      void: () => ({ kind: "void" }),
    },
    getCommittedReceipt: (key) => overrides.receipt || null,
    transfer: overrides.transfer || (async () => ({ success: true, durable: true })),
    ...overrides,
  };
}

function fakeWalletAuthority(overrides = {}) {
  return {
    adjustCorporationWalletDivisionBalanceAsync: overrides.adjust || (async () => ({ success: true })),
    ...overrides,
  };
}

function vendorWallet(balances) {
  const divisions = {};
  for (const [key, balance] of Object.entries(balances)) divisions[key] = { key: Number(key), name: "", balance };
  return { divisions, lpBalance: 0, billBalance: 0, authorityReceipts: [] };
}

function fakeWalletState(overrides = {}) {
  const getCorporationWallet = (id) => overrides.wallet || (id === 987654321 ? vendorWallet({ 1000: 1000000000 }) : null);
  return {
    getCorporationWallet,
    getCorporationWalletDivision: (id, accountKey = 1000) => {
      const wallet = getCorporationWallet(id);
      if (!wallet || !wallet.divisions || !wallet.divisions[String(accountKey)]) return null;
      return { ...wallet.divisions[String(accountKey)] };
    },
    getCorporationWalletBalance: (id, accountKey = 1000) => {
      const wallet = getCorporationWallet(id);
      const division = wallet && wallet.divisions && wallet.divisions[String(accountKey)];
      return division ? Number(division.balance) || 0 : 0;
    },
    ...overrides,
  };
}

function fakeMarketDaemon(overrides = {}) {
  return {
    call: overrides.call || (async (method, params) => {
      if (method === "GetOrders") {
        return { buys: [{ price: 5.5 }, { price: 5.3 }], sells: [{ price: 6.0 }, { price: 6.2 }] };
      }
      if (method === "GetRegionBest") {
        if (params.region_id === 10000002) throw new Error("daemon down");
        return [
          { type_id: 34, best_ask_price: 5.8 },
          { type_id: 35, best_ask_price: 5.9 },
        ];
      }
      return [];
    }),
    ...overrides,
  };
}

function fakeIndustryPricing(overrides = {}) {
  const base = overrides.basePrice !== undefined ? overrides.basePrice : 5.0;
  return {
    resolveAdjustedAverageTypePrice: (typeId) => base,
    ...overrides,
  };
}

module.exports = ({ test }) => {
  test("TA1 buildWantToBuyCall: deterministic, tag, forCorp, price=0, itemList=[], requestItemTypeList, no sendNotification", () => {
    const r1 = buildWantToBuyCall(PAYLOAD);
    assert.strictEqual(r1.ok, true);
    const r2 = buildWantToBuyCall(PAYLOAD);
    assert.deepStrictEqual(r1, r2);
    assert.strictEqual(JSON.stringify(r1), JSON.stringify(r2));
    assert.ok(r1.info.description.includes("[LNE:offer-123]"));
    assert.strictEqual(r1.info.forCorp, true);
    assert.strictEqual(r1.info.price, 0);
    assert.deepStrictEqual(r1.info.itemList, []);
    assert.deepStrictEqual(r1.info.requestItemTypeList, [[34, 100]]);
    assert.strictEqual(r1.session.sendNotification, undefined);
    const bad = buildWantToBuyCall({ ...PAYLOAD, description: "no tag" });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, "TRADE_CALL_INVALID");
    assert.strictEqual(bad.detail, "tag_missing");
  });

  test("TA2 findTradeContractFrom: other corp ignored, pending found, duplicates counted, readTradeContract maps statuses", () => {
    const cr = fakeContractRuntime({
      records: [
        { contractID: 100, issuerOwnerID: 987654321, description: "test [LNE:offer-123]", status: CONTRACT_STATUS.OUTSTANDING },
        { contractID: 101, issuerOwnerID: 987654321, description: "test [LNE:offer-123]", status: CONTRACT_STATUS.OUTSTANDING },
        { contractID: 102, issuerOwnerID: 111111111, description: "test [LNE:offer-123]", status: CONTRACT_STATUS.OUTSTANDING },
      ],
    });
    const cs = fakeSettlementState({
      pending: [
        { contractID: 200, kind: "create", payload: { info: { description: "pending [LNE:offer-123]" } } },
      ],
    });

    let r = findTradeContractFrom(cr, cs, { corporationId: 987654321, offerId: "offer-123" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.found, "record");
    assert.strictEqual(r.contractId, 100);
    assert.strictEqual(r.duplicates, 1);

    r = findTradeContractFrom(cr, cs, { corporationId: 111111111, offerId: "offer-123" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.found, "record");
    assert.strictEqual(r.contractId, 102);
    assert.strictEqual(r.duplicates, 0);

    const cr2 = fakeContractRuntime({ records: [] });
    r = findTradeContractFrom(cr2, cs, { corporationId: 987654321, offerId: "offer-123" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.found, "pending");
    assert.strictEqual(r.contractId, 200);

    r = findTradeContractFrom(cr2, fakeSettlementState({ pending: [] }), { corporationId: 987654321, offerId: "offer-999" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.found, null);

    const cr3 = fakeContractRuntime({
      records: [{ contractID: 100, issuerOwnerID: 987654321, description: "test [LNE:offer-123]", status: CONTRACT_STATUS.FINISHED, acceptorID: 555, acceptorWallet: { kind: "corporation" }, rewardEscrow: 5000000 }],
    });
    const cs3 = fakeSettlementState({ pending: [] });
    const rt = readTradeContractFrom(cr3, cs3, 100);
    assert.strictEqual(rt.ok, true);
    assert.strictEqual(rt.contract.status, "FINISHED");
    assert.strictEqual(rt.contract.rawStatus, CONTRACT_STATUS.FINISHED);
    assert.strictEqual(rt.contract.acceptorId, 555);
    assert.strictEqual(rt.contract.acceptorKind, "corporation");
    assert.strictEqual(rt.contract.rewardEscrow, 5000000);
    assert.strictEqual(rt.contract.issuerOwnerId, 987654321);
    assert.strictEqual(rt.contract.pendingKind, null);

    const cs4 = fakeSettlementState({ pending: [{ contractID: 100, kind: "create" }] });
    const rt2 = readTradeContractFrom(cr3, cs4, 100);
    assert.strictEqual(rt2.contract.pendingKind, "create");
  });

  test("TA2b findTradeContractFrom: a throwing listContractRecords -> ok:false CONTRACT_READ_FAILED "
    + "never found null", () => {
    const cr = { listContractRecords: () => { throw new Error("repo locked"); } };
    const r = findTradeContractFrom(cr, fakeSettlementState({ pending: [] }), { ownerId: 987654321,
      offerId: "offer-123" });
    assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, "CONTRACT_READ_FAILED", "repo locked"]);
  });

  test("TA2c findTradeContractFrom: a throwing listPendingContractSettlements (no record) -> ok:false "
    + "CONTRACT_READ_FAILED, never found null", () => {
    const cr = { listContractRecords: () => [] };
    const ss = { listPendingContractSettlements: () => { throw new Error("pending locked"); } };
    const r = findTradeContractFrom(cr, ss, { ownerId: 987654321, offerId: "offer-123" });
    assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, "CONTRACT_READ_FAILED", "pending locked"]);
  });

  test("TA3 async: wallet key validation, commandId prefix, error classification, create/delete errors", async () => {
    let r = await adjustCorpDivisionFrom(fakeWalletAuthority(), fakeWalletState(), {
      corporationId: 987654321, accountKey: 1000, deltaIsk: 1000, commandId: "bad-key", description: "test"
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "WALLET_KEY_INVALID");
    assert.strictEqual(r.permanent, true);

    let shortCalls = 0;
    const shortVendor = fakeWalletAuthority({ adjust: async () => {
      shortCalls += 1;
      return { success: false, errorMsg: "INSUFFICIENT_FUNDS", data: { corporationID: 987654321, accountKey: 1000, balance: 100 } };
    } });
    r = await adjustCorpDivisionFrom(shortVendor, fakeWalletState({ wallet: vendorWallet({ 1000: 100 }) }), {
      corporationId: 987654321, accountKey: 1000, deltaIsk: -2000, commandId: "lne:test-1", description: "test"
    });
    assert.deepStrictEqual(r, { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
    assert.strictEqual(shortCalls, 1, "the vendor is called, no adapter precheck");

    r = await adjustCorpDivisionFrom(fakeWalletAuthority({ adjust: async () => { throw new Error("boom"); } }), fakeWalletState(), {
      corporationId: 987654321, accountKey: 1000, deltaIsk: 1000, commandId: "lne:test-2", description: "test"
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "WALLET_FAILED");
    assert.strictEqual(r.permanent, false);

    const crFailStation = fakeContractRuntime({
      createContract: async () => ({ success: false, errorMsg: "Start location is not a station" }),
    });
    r = await createWantToBuyFrom(crFailStation, PAYLOAD);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "CONTRACT_CREATE_FAILED");
    assert.strictEqual(r.permanent, true);

    const crFailFunds = fakeContractRuntime({
      createContract: async () => ({ success: false, errorMsg: "does not have enough funds" }),
    });
    r = await createWantToBuyFrom(crFailFunds, PAYLOAD);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "CONTRACT_CREATE_FAILED");
    assert.strictEqual(r.permanent, false);

    const crDelete = fakeContractRuntime({
      deleteContract: async () => { throw new Error("Another contract operation is already pending."); },
    });
    r = await deleteTradeContractFrom(crDelete, { contractId: 100, ceoId: 123456789, corporationId: 987654321 });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "CONTRACT_DELETE_FAILED");
    assert.strictEqual(r.pending, true);
    assert.strictEqual(r.permanent, false);

    assert.ok(true, "all async functions returned structural results, no throws");
  });

  test("TA4 hangar: flag 62 filter/sort, void receipt committed, transfer params, durable=false ambiguous", async () => {
    const items = [
      { itemID: 300, typeID: 34, ownerID: 987654321, locationID: 60003760, flagID: 62, singleton: 0, stacksize: 50 },
      { itemID: 100, typeID: 34, ownerID: 987654321, locationID: 60003760, flagID: 62, singleton: 1 },
      { itemID: 200, typeID: 35, ownerID: 987654321, locationID: 60003760, flagID: 62, singleton: 0, stacksize: 25 },
    ];
    const is = fakeItemStore({ items });
    let r = listDeliveredStacksFrom(is, { corporationId: 987654321, npcStationId: 60003760, typeId: 34 });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.stacks, [
      { itemId: 100, quantity: 1 },
      { itemId: 300, quantity: 50 },
    ]);

    const ic = fakeItemCustody({ receipt: { committed: true } });
    r = voidDeliveredStackFrom(ic, is, { corporationId: 987654321, npcStationId: 60003760, itemId: 100, quantity: 1, key: "lne:void-1" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, "ALREADY_COMMITTED");

    let capturedTransfer = null;
    const ic2 = fakeItemCustody({
      transfer: (params) => { capturedTransfer = params; return { success: true, durable: true }; },
    });
    r = voidDeliveredStackFrom(ic2, is, { corporationId: 987654321, npcStationId: 60003760, itemId: 100, quantity: 1, key: "lne:void-2" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.outcome, "VOIDED");
    assert.strictEqual(capturedTransfer.reason, "industry-material-commit");
    assert.strictEqual(capturedTransfer.from.kind, "owner-location");
    assert.strictEqual(capturedTransfer.from.corporationId, 987654321);
    assert.strictEqual(capturedTransfer.from.flagId, 62);
    assert.strictEqual(capturedTransfer.to.kind, "void");
    assert.strictEqual(capturedTransfer.idempotencyKey, "lne:void-2");
    assert.strictEqual(capturedTransfer.actor, 987654321);

    const ic3 = fakeItemCustody({ transfer: async () => ({ success: true, durable: false }) });
    r = await voidDeliveredStackFrom(ic3, is, { corporationId: 987654321, npcStationId: 60003760, itemId: 100, quantity: 1, key: "lne:void-3" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "CUSTODY_FAILED");
    assert.strictEqual(r.ambiguous, true);
    assert.strictEqual(r.permanent, false);

    r = await voidDeliveredStackFrom(ic2, is, { corporationId: 987654321, npcStationId: 60003760, itemId: 100, quantity: 1, key: "bad" });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "CUSTODY_KEY_INVALID");
    assert.strictEqual(r.permanent, true);
  });

  test("TA5 readTradePricesFrom: bid=max buys, ask=min(sells,regionBest), base=resolveAdjustedAverageTypePrice, round*1000, demon error increments errors", async () => {
    const md = fakeMarketDaemon({
      call: async (method, params) => {
        if (method === "GetOrders") {
          return { buys: [{ price: 5.5 }, { price: 5.3 }], sells: [{ price: 6.0 }, { price: 6.2 }] };
        }
        if (method === "GetRegionBest") {
          if (params.region_id === 10000002) {
            throw Object.assign(new Error("daemon down"), { code: "MARKET_DAEMON_RPC_REJECTED" });
          }
          return [
            { type_id: 34, best_ask_price: 5.8 },
            { type_id: 35, best_ask_price: 5.9 },
          ];
        }
        return [];
      },
    });
    const ip = fakeIndustryPricing({ basePrice: 5.25 });
    const r = await readTradePricesFrom(md, ip, { typeIds: [34, 35], refRegionId: 10000002, regionIds: [10000002, 10000043], maxRegions: 10 });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.errors, 1);
    assert.strictEqual(r.aborted, null, "REJECTED does not end the read");
    const p34 = r.prices.get(34);
    assert.strictEqual(p34.bidMilli, 5500);
    assert.strictEqual(p34.askMilli, 5800);
    assert.strictEqual(p34.baseMilli, 5250);

    const ip2 = fakeIndustryPricing({ basePrice: 0 });
    const r2 = await readTradePricesFrom(md, ip2, { typeIds: [34], refRegionId: 10000002, regionIds: [], maxRegions: 10 });
    assert.strictEqual(r2.prices.get(34).baseMilli, null);

    const r3 = await readTradePricesFrom(md, ip, { typeIds: [], refRegionId: 10000002, regionIds: [], maxRegions: 10 });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(r3.reason, "PRICE_SPEC_INVALID");
  });

  test("TA5b EP2 readTradePricesFrom: first transport error aborts the read (1 call), REJECTED goes on", async () => {
    const calls = [];
    const timeoutDaemon = {
      call: async (method, params) => {
        calls.push(method);
        throw Object.assign(new Error("timeout"), { code: "MARKET_DAEMON_RPC_TIMEOUT" });
      },
    };
    const ip = fakeIndustryPricing({ basePrice: 5.25 });
    const spec = { typeIds: [34, 35, 36], refRegionId: 10000002, regionIds: [10000002, 10000043], maxRegions: 10 };
    const r = await readTradePricesFrom(timeoutDaemon, ip, spec);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 1, `one daemon call, got ${calls.join(",")}`);
    assert.strictEqual(r.aborted, "MARKET_DAEMON_RPC_TIMEOUT");
    assert.strictEqual(r.errors, 1);
    assert.deepStrictEqual([...r.prices.keys()], [34, 35, 36], "every type keeps an entry");
    for (const p of r.prices.values()) {
      assert.deepStrictEqual(p, { bidMilli: null, askMilli: null, baseMilli: 5250 });
    }

    const noCode = { call: async () => { throw new Error("market daemon RPC connection is not ready"); } };
    const r2 = await readTradePricesFrom(noCode, ip, { ...spec, regionIds: [] });
    assert.strictEqual(r2.aborted, "TRANSPORT");
    assert.strictEqual(r2.errors, 1);

    const rejectedCalls = [];
    const rejecting = {
      call: async (method, params) => {
        rejectedCalls.push(params.type_id);
        if (method === "GetOrders") throw Object.assign(new Error("no"), { code: "MARKET_DAEMON_RPC_REJECTED" });
        return [];
      },
    };
    const r3 = await readTradePricesFrom(rejecting, ip, { ...spec, regionIds: [] });
    assert.strictEqual(r3.aborted, null);
    assert.strictEqual(r3.errors, 3);
    assert.deepStrictEqual(rejectedCalls, [34, 35, 36]);
  });

  test("readIssuerFrom: ceoId, isNpc, hasRuntime", () => {
    const cs = fakeCorporationState({ record: { corporationID: 987654321, ceoID: 123456789, isNPC: true } });
    const cr = fakeCorporationRuntime({ runtime: { corporationID: 987654321 } });
    let r = readIssuerFrom(cs, cr, 987654321);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.issuer.corporationId, 987654321);
    assert.strictEqual(r.issuer.ceoId, 123456789);
    assert.strictEqual(r.issuer.isNpc, true);
    assert.strictEqual(r.issuer.hasRuntime, true);

    const cs2 = fakeCorporationState({ record: { corporationID: 987654321, ceoID: 0, isNPC: true } });
    r = readIssuerFrom(cs2, cr, 987654321);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "NO_ISSUER");
  });

  test("TA6 division balance: a debit goes to the vendor whatever the division holds, no wallet -> CORPORATION_NOT_FOUND without a call, divisionBalanceOf reads divisions[accountKey]", async () => {
    const CORP = 987654321;
    let calls = 0;
    const ws = fakeWalletState({ wallet: vendorWallet({ 1005: 50, 1006: 5000 }) });
    const authority = fakeWalletAuthority({ adjust: async (cid, key, delta) => {
      calls += 1;
      const balance = divisionBalanceOf(ws, cid, key) || 0;
      return balance + delta < -0.0001 ? { success: false, errorMsg: "INSUFFICIENT_FUNDS" } : { success: true };
    } });
    const spec = (accountKey, deltaIsk, n) => ({ corporationId: CORP, accountKey, deltaIsk, commandId: `lne:ta6-${n}`, description: "ta6" });

    let r = await adjustCorpDivisionFrom(authority, ws, spec(1006, -2000, 1));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(calls, 1);
    r = await adjustCorpDivisionFrom(authority, ws, spec(1005, -2000, 2));
    assert.deepStrictEqual(r, { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
    assert.strictEqual(calls, 2);
    r = await adjustCorpDivisionFrom(authority, { getCorporationWallet: () => null }, spec(1006, -2000, 3));
    assert.deepStrictEqual(r, { ok: false, reason: "CORPORATION_NOT_FOUND", permanent: true });
    assert.strictEqual(calls, 2);

    assert.strictEqual(divisionBalanceOf(ws, CORP, 1005), 50);
    assert.strictEqual(divisionBalanceOf(ws, CORP, 1006), 5000);
    assert.strictEqual(divisionBalanceOf(ws, CORP, 1003), null, "getCorporationWalletBalance gives 0 for a missing division");
    const bare = { getCorporationWallet: () => vendorWallet({ 1006: 7 }) };
    assert.strictEqual(divisionBalanceOf(bare, CORP, 1006), 7);
    assert.strictEqual(divisionBalanceOf(bare, CORP, 1000), null);
    assert.strictEqual(divisionBalanceOf({ getCorporationWallet: () => ({ balance: 1000000000 }) }, CORP, 1006), null);
    assert.strictEqual(divisionBalanceOf(fakeWalletState({ wallet: { balance: 1000000000 } }), CORP, 1006), null);
    assert.strictEqual(divisionBalanceOf({ getCorporationWallet: () => { throw new Error("x"); } }, CORP, 1006), null);
    assert.strictEqual(divisionBalanceOf(null, CORP, 1006), null);
  });

  test("TA7 createWantToBuyFrom: rejected saga -> CONTRACT_CREATE_FAILED (permanent only for missing issuer), success without id -> no_contract_id", async () => {
    const created = (result) => createWantToBuyFrom(fakeContractRuntime({ createContract: async () => result }), PAYLOAD);
    assert.deepStrictEqual(await created({ success: true, rejected: true, errorMsg: "INSUFFICIENT_FUNDS", contractIDs: [] }),
      { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, rejected: true, detail: "INSUFFICIENT_FUNDS" });
    assert.deepStrictEqual(await created({ success: true, rejected: true, errorMsg: "CORPORATION_NOT_FOUND", contractIDs: [] }),
      { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: true, rejected: true, detail: "CORPORATION_NOT_FOUND" });
    const character = await created({ success: true, rejected: true, errorMsg: "CHARACTER_NOT_FOUND", contractIDs: [] });
    assert.strictEqual(character.permanent, true);
    assert.deepStrictEqual(await created({ success: true, alreadySettled: true, contractIDs: [] }),
      { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "no_contract_id" });
    assert.deepStrictEqual(await created({ success: true, contractIDs: [1000123], contract: {}, inventoryChanges: [] }),
      { ok: true, contractId: 1000123 });
  });

  test("TA8 deleteTradeContractFrom maps the vendor boolean; listTaggedContractsFrom gives issuerId + issuerWallet", async () => {
    const del = (deleteContract) => deleteTradeContractFrom(fakeContractRuntime({ deleteContract }),
      { contractId: 100, ceoId: 123456789, corporationId: 987654321 });
    assert.deepStrictEqual(await del(async () => true), { ok: true, deleted: true });
    assert.deepStrictEqual(await del(async () => false),
      { ok: false, reason: "CONTRACT_DELETE_FAILED", permanent: false, pending: true, detail: "not_settled" });
    const pending = await del(async () => { throw new Error("Another contract operation is already pending."); });
    assert.strictEqual(pending.ok, false);
    assert.strictEqual(pending.pending, true);
    const notIssuer = await del(async () => { throw new Error("Only the issuer can delete this contract."); });
    assert.strictEqual(notIssuer.ok, false);
    assert.strictEqual(notIssuer.pending, false);
    const wrappedPending = await del(async () => { throw vendorUserError("CustomInfo",
      { info: "Another contract operation is already pending." }); });
    assert.strictEqual(wrappedPending.reason, "CONTRACT_DELETE_FAILED");
    assert.strictEqual(wrappedPending.pending, true);
    assert.strictEqual(wrappedPending.permanent, false);
    assert.ok(wrappedPending.detail.includes("already pending"), wrappedPending.detail);
    const wrappedOther = await del(async () => { throw vendorUserError("CustomInfo",
      { info: "Only the issuer can delete this contract." }); });
    assert.strictEqual(wrappedOther.pending, false);
    const wrappedStation = await createWantToBuyFrom(fakeContractRuntime({ createContract: async () => {
      throw vendorUserError("CustomInfo", { info: "Contract location is not a station or structure." }); } }), PAYLOAD);
    assert.strictEqual(wrappedStation.reason, "CONTRACT_CREATE_FAILED");
    assert.strictEqual(wrappedStation.permanent, true);

    const records = [
      { contractID: 501, status: CONTRACT_STATUS.OUTSTANDING, issuerID: 77, issuerOwnerID: 987654321, reward: 1100,
        description: "[LNE:o-1] x", issuerWallet: { kind: "corporation", ownerID: 987654321, accountKey: 1006 } },
      { contractID: 502, status: CONTRACT_STATUS.OUTSTANDING, issuerOwnerID: 987654321, reward: 900,
        description: "[LNE:o-2] y" },
    ];
    const listed = listTaggedContractsFrom(fakeContractRuntime({ records }), { corporationIds: [987654321], limit: 10 });
    assert.strictEqual(listed.ok, true);
    assert.deepStrictEqual(listed.contracts, [
      { contractId: 501, offerId: "o-1", issuerOwnerId: 987654321, reward: 1100, issuerId: 77,
        issuerWallet: { kind: "corporation", ownerId: 987654321, accountKey: 1006 } },
      { contractId: 502, offerId: "o-2", issuerOwnerId: 987654321, reward: 900, issuerId: 0,
        issuerWallet: { kind: "corporation", ownerId: 987654321, accountKey: null } },
    ]);
  });

  test("TA9 adjustCharacterWalletFrom: credit with key, missing character / over limit refused without a call, debit over balance + replayed defund decided by the vendor (36b), duplicate, vendor codes", async () => {
    const ws = fakeCharacterWalletState({ [CHAR]: 1000 });
    let r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: 500, commandId: "lne:trade:o-1:fund", description: "lne-trade fund o-1" });
    assert.deepStrictEqual(r, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.strictEqual(ws.calls.length, 1);
    const [charId, amount, options, metadata] = ws.calls[0];
    assert.strictEqual(charId, CHAR);
    assert.strictEqual(amount, 500);
    assert.strictEqual(options.idempotencyKey, "lne:trade:o-1:fund");
    assert.strictEqual(options.entryTypeID, 3);
    assert.strictEqual(options.description, "lne-trade fund o-1");
    assert.strictEqual(metadata.commandID, "lne:trade:o-1:fund");
    assert.strictEqual(ws.balance(CHAR), 1500);
    r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: 500, commandId: "lne:trade:o-1:fund", description: "lne-trade fund o-1" });
    assert.deepStrictEqual(r, { ok: true, duplicate: true, fingerprintMismatch: false });
    assert.strictEqual(ws.balance(CHAR), 1500);
    r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: 700, commandId: "lne:trade:o-1:fund", description: "lne-trade fund o-1" });
    assert.strictEqual(r.reason, "WALLET_KEY_INVALID");
    assert.strictEqual(r.permanent, true);
    r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: -2000, commandId: "lne:trade:o-2:defund" });
    assert.deepStrictEqual(r, { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
    r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: -1500, commandId: "lne:trade:o-6:defund", description: "lne-trade defund o-6" });
    assert.deepStrictEqual(r, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.strictEqual(ws.balance(CHAR), 0);
    r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: -1500, commandId: "lne:trade:o-6:defund", description: "lne-trade defund o-6" });
    assert.deepStrictEqual(r, { ok: true, duplicate: true, fingerprintMismatch: false });
    assert.strictEqual(ws.balance(CHAR), 0);
    ws.calls.length = 0;
    await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: 1500, commandId: "lne:trade:o-7:fund", description: "lne-trade fund o-7" });
    assert.strictEqual(ws.balance(CHAR), 1500);
    const before = ws.calls.length;
    r = await adjustCharacterWalletFrom(ws, { ownerId: 4242, deltaIsk: 10, commandId: "lne:trade:o-3:fund" });
    assert.deepStrictEqual(r, { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true });
    r = await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: MAX_CHARACTER_BALANCE, commandId: "lne:trade:o-4:fund" });
    assert.deepStrictEqual(r, { ok: false, reason: "BALANCE_LIMIT", permanent: true });
    assert.strictEqual((await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: 1, commandId: "x" })).reason, "WALLET_KEY_INVALID");
    assert.strictEqual((await adjustCharacterWalletFrom(ws, { ownerId: CHAR, deltaIsk: 1.5, commandId: "lne:x" })).reason, "WALLET_FAILED");
    assert.strictEqual(ws.calls.length, before, "refusals never reach the vendor");
    const odd = fakeCharacterWalletState({ [CHAR]: 10 });
    odd.getCharacterWallet = () => ({ characterID: CHAR, balance: "n/a" });
    r = await adjustCharacterWalletFrom(odd, { ownerId: CHAR, deltaIsk: -50, commandId: "lne:trade:o-5:defund" });
    assert.deepStrictEqual(r, { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
    assert.strictEqual(odd.calls.length, 1);
    assert.strictEqual((await adjustCharacterWalletFrom({}, { ownerId: CHAR, deltaIsk: 1, commandId: "lne:y" })).reason, "SEAM_UNAVAILABLE");
  });

  test("TA11 EveJS 261018.1 createWantToBuyFrom: forCorp session carries the vendor CORP_ROLE_CONTRACT_MANAGER as corprole, character and old vendor without it", async () => {
    const ROLE = 72057594037927936n;
    const sessions = [];
    const capture = async (_info, session) => { sessions.push(session); return { success: true, contractIDs: [12345] }; };
    assert.deepStrictEqual(await createWantToBuyFrom(fakeContractRuntime({ createContract: capture,
      CORP_ROLE_CONTRACT_MANAGER: ROLE }), { ...PAYLOAD, accountKey: 1006 }), { ok: true, contractId: 12345 });
    assert.strictEqual(sessions[0].corprole, ROLE);
    assert.strictEqual(sessions[0].corpAccountKey, 1006);
    await createWantToBuyFrom(fakeContractRuntime({ createContract: capture, CORP_ROLE_CONTRACT_MANAGER: ROLE }),
      { ...PAYLOAD, issuerKind: "character", ceoId: CHAR });
    assert.strictEqual("corprole" in sessions[1], false, "a character issuer needs no corp role");
    await createWantToBuyFrom(fakeContractRuntime({ createContract: capture }), { ...PAYLOAD, accountKey: 1006 });
    assert.strictEqual("corprole" in sessions[2], false, "vendor without the export: session unchanged");
  });

  test("TA12 EveJS 261028.1 NPC corporation issuer: the marked WTB / WTS / delete session gets a CEO authority from the wrap, nothing else changes", async () => {
    const { wrapCorpIssuerAuthority, SYNTHETIC_ISSUER } = require("../../lib/adapter/corpContractIssuer");
    const ROLE = 72057594037927936n;
    const NPC_CORP = PAYLOAD.corporationId;
    const records = { [NPC_CORP]: { corporationID: NPC_CORP, ceoID: PAYLOAD.ceoId, isNPC: true } };
    const player = { characterID: 1, corporationID: 98000001 };
    const authority = { getPersistedCorporationAuthority: (s) => (s && s.corporationID === 98000001 ? player : null) };
    const corpState = { getCorporationRecord: (id) => records[id] || null };
    assert.deepStrictEqual(wrapCorpIssuerAuthority(authority, corpState), { ok: true, alreadyInstalled: false });
    const wrapped = authority.getPersistedCorporationAuthority;
    assert.deepStrictEqual(wrapCorpIssuerAuthority(authority, corpState), { ok: true, alreadyInstalled: true });
    assert.strictEqual(authority.getPersistedCorporationAuthority, wrapped, "no second wrap");

    const sessions = [];
    const capture = async (_info, s) => { sessions.push(s); return { success: true, contractIDs: [12345] }; };
    await createWantToBuyFrom(fakeContractRuntime({ createContract: capture, CORP_ROLE_CONTRACT_MANAGER: ROLE }),
      { ...PAYLOAD, accountKey: 1006 });
    await deleteTradeContractFrom(fakeContractRuntime({ deleteContract: async (_id, s) => { sessions.push(s); return true; },
      CORP_ROLE_CONTRACT_MANAGER: ROLE }), { contractId: 100, ceoId: PAYLOAD.ceoId, corporationId: NPC_CORP });
    for (const s of sessions) {
      const a = authority.getPersistedCorporationAuthority(s);
      assert.strictEqual(a.corporationID, NPC_CORP);
      assert.strictEqual(a.characterID, PAYLOAD.ceoId);
      assert.ok(a.isCEO === true && a.isDirector === true && a.sessionCorporationRoles === ROLE);
      assert.strictEqual(s.corprole, ROLE);
    }
    const base = { characterID: PAYLOAD.ceoId, corporationID: NPC_CORP };
    assert.strictEqual(authority.getPersistedCorporationAuthority(base), null);
    assert.strictEqual(authority.getPersistedCorporationAuthority({ ...base,
      [Symbol("lne.syntheticCorpIssuer")]: { characterId: PAYLOAD.ceoId, corporationId: NPC_CORP } }), null);
    const marked = sessions[0];
    assert.strictEqual(authority.getPersistedCorporationAuthority({ ...marked, characterID: 5 }), null);
    assert.strictEqual(authority.getPersistedCorporationAuthority({ ...marked,
      [SYNTHETIC_ISSUER]: { ...marked[SYNTHETIC_ISSUER], characterId: 5 }, characterID: 5 }), null);
    records[NPC_CORP].deleted = true;
    assert.strictEqual(authority.getPersistedCorporationAuthority(marked), null);
    delete records[NPC_CORP].deleted;
    corpState.getCorporationRecord = () => { throw new Error("boom"); };
    assert.strictEqual(authority.getPersistedCorporationAuthority(marked), null);
    assert.strictEqual(authority.getPersistedCorporationAuthority({ characterID: 1, corporationID: 98000001 }), player);
    assert.deepStrictEqual(wrapCorpIssuerAuthority({}, corpState), { ok: false, reason: "AUTHORITY_SEAM_UNAVAILABLE" });

    const vendorAuthority = { getPersistedCorporationAuthority: () => null };
    const seen = [];
    const adapter = adapterOver({
      "services/contracts/contractRuntimeState": fakeContractRuntime({ CORP_ROLE_CONTRACT_MANAGER: ROLE,
        deleteContract: async (_id, s) => { seen.push(vendorAuthority.getPersistedCorporationAuthority(s)); return true; } }),
      "services/corporation/corporationAuthority": vendorAuthority,
      "services/corporation/corporationState": { getCorporationRecord: (id) => (id === NPC_CORP ? records[NPC_CORP] : null) },
    });
    assert.deepStrictEqual(await adapter.tradeDeleteContract({ contractId: 100, ceoId: PAYLOAD.ceoId, corporationId: NPC_CORP }),
      { ok: true, deleted: true });
    assert.strictEqual(seen[0].corporationID, NPC_CORP);
  });

  test("TA10 character issuer: buildWantToBuyCall forCorp:false without corpAccountKey, stacks / void in HANGAR 4, find / list by issuerOwnerID", () => {
    const call = buildWantToBuyCall({ ...PAYLOAD, issuerKind: "character", ceoId: CHAR });
    assert.strictEqual(call.ok, true, JSON.stringify(call));
    assert.strictEqual(call.info.forCorp, false);
    assert.strictEqual(call.info.startStationDivision, 4);
    assert.deepStrictEqual(call.session, { characterID: CHAR, corporationID: PAYLOAD.corporationId });
    assert.deepStrictEqual(buildWantToBuyCall({ ...PAYLOAD, issuerKind: "character", ceoId: CHAR, accountKey: 1006 }),
      { ok: false, reason: "TRADE_CALL_INVALID", detail: "accountKey" });
    assert.strictEqual(buildWantToBuyCall({ ...PAYLOAD, issuerKind: "alliance" }).detail, "issuerKind");
    const corp = buildWantToBuyCall({ ...PAYLOAD, accountKey: 1006 });
    assert.strictEqual(corp.info.forCorp, true);
    assert.strictEqual(corp.session.corpAccountKey, 1006);

    let listedWith = null;
    const items = [
      { itemID: 701, typeID: 34, ownerID: CHAR, locationID: 60003760, flagID: 4, singleton: 0, stacksize: 40 },
      { itemID: 702, typeID: 34, ownerID: 987654321, locationID: 60003760, flagID: 4, singleton: 0, stacksize: 9 },
    ];
    const is = fakeItemStore({ listContainerItems: (owner, station, flag, typeIds) => { listedWith = [owner, station, flag, typeIds]; return items; } });
    const stacks = listDeliveredStacksFrom(is, { ownerKind: "character", ownerId: CHAR, npcStationId: 60003760, typeId: 34 });
    assert.deepStrictEqual(stacks, { ok: true, stacks: [{ itemId: 701, quantity: 40 }] });
    assert.deepStrictEqual(listedWith, [CHAR, 60003760, 4, [34]]);
    listDeliveredStacksFrom(is, { corporationId: 987654321, npcStationId: 60003760, typeId: 34 });
    assert.strictEqual(listedWith[2], 62, "corporation keeps CORP_DELIVERIES");
    assert.strictEqual(listDeliveredStacksFrom(fakeItemStore({ ITEM_FLAGS: { CORP_DELIVERIES: 62 } }),
      { ownerKind: "character", ownerId: CHAR, npcStationId: 60003760, typeId: 34 }).reason, "SEAM_UNAVAILABLE");

    let transfer = null;
    const ic = fakeItemCustody({ transfer: (params) => { transfer = params; return { success: true, durable: true }; } });
    const v = voidDeliveredStackFrom(ic, is, { ownerKind: "character", ownerId: CHAR, npcStationId: 60003760, itemId: 701, quantity: 40, key: "lne:trade:o-1:void:701" });
    assert.deepStrictEqual(v, { ok: true, outcome: "VOIDED" });
    assert.deepStrictEqual(transfer.from, { kind: "owner-location", corporationId: CHAR, stationId: 60003760, flagId: 4 });
    assert.strictEqual(transfer.actor, CHAR);

    const records = [
      { contractID: 801, status: CONTRACT_STATUS.OUTSTANDING, issuerID: CHAR, issuerOwnerID: CHAR, reward: 50,
        description: "[LNE:offer-123] c", issuerWallet: { kind: "character", ownerID: CHAR, accountKey: 1000 } },
      { contractID: 802, status: CONTRACT_STATUS.OUTSTANDING, issuerID: 77, issuerOwnerID: 987654321, reward: 60,
        description: "[LNE:o-9] k", issuerWallet: { kind: "corporation", ownerID: 987654321, accountKey: 1006 } },
    ];
    const cr = fakeContractRuntime({ records });
    const found = findTradeContractFrom(cr, fakeSettlementState(), { ownerId: CHAR, offerId: "offer-123" });
    assert.deepStrictEqual(found, { ok: true, found: "record", contractId: 801, status: 0, duplicates: 0 });
    assert.strictEqual(findTradeContractFrom(cr, fakeSettlementState(), { corporationId: 987654321, offerId: "offer-123" }).found, null);
    const listed = listTaggedContractsFrom(cr, { ownerIds: [CHAR], corporationIds: [987654321], limit: 10 });
    assert.deepStrictEqual(listed.contracts.map((c) => [c.contractId, c.issuerOwnerId, c.issuerWallet]), [
      [801, CHAR, { kind: "character", ownerId: CHAR, accountKey: 1000 }],
      [802, 987654321, { kind: "corporation", ownerId: 987654321, accountKey: 1006 }],
    ]);
    assert.deepStrictEqual(listTaggedContractsFrom(cr, { corporationIds: [987654321], limit: 10 }).contracts.map((c) => c.contractId), [802]);
  });

  test("TA11 real createAdapter: tradeAdjustWallet routes by ownerKind, tradeReadCharacter / tradeReadCharacterWallet, tradeVirtualIssuerSeams", async () => {
    const corpCalls = [];
    const charWallet = fakeCharacterWalletState({ [CHAR]: 300 });
    const vendor = {
      "services/corporation/corpWalletState": {
        ...fakeWalletState(),
        adjustCorporationWalletDivisionBalanceAsync: async (...args) => { corpCalls.push(args); return { success: true }; },
      },
      "services/account/walletState": charWallet,
      "services/character/characterState": { peekCharacterRecord: (id) => (id === CHAR ? { characterID: CHAR } : null) },
    };
    const adapter = adapterOver(vendor);
    let r = await adapter.tradeAdjustWallet({ corporationId: 987654321, accountKey: 1006, deltaIsk: 5, commandId: "lne:a" });
    assert.strictEqual(r.ok, true);
    r = await adapter.tradeAdjustWallet({ ownerKind: "corporation", corporationId: 987654321, accountKey: 1006, deltaIsk: 5, commandId: "lne:b" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(corpCalls.length, 2);
    assert.strictEqual(charWallet.calls.length, 0);
    r = await adapter.tradeAdjustWallet({ ownerKind: "character", ownerId: CHAR, deltaIsk: -100, commandId: "lne:c", description: "lne-trade defund o-1" });
    assert.deepStrictEqual(r, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.strictEqual(corpCalls.length, 2);
    assert.strictEqual(charWallet.calls.length, 1);
    assert.deepStrictEqual(adapter.tradeReadCharacterWallet(CHAR), { ok: true, balanceIsk: 200 });
    assert.deepStrictEqual(adapter.tradeReadCharacterWallet(4242), { ok: true, balanceIsk: null });
    assert.deepStrictEqual(adapter.tradeReadCharacter(CHAR), { ok: true, exists: true });
    assert.deepStrictEqual(adapter.tradeReadCharacter(4242), { ok: true, exists: false });
    assert.deepStrictEqual(adapter.tradeVirtualIssuerSeams(), { ok: true });

    const bare = adapterOver({ ...vendor, "services/account/walletState": { getCharacterWallet: charWallet.getCharacterWallet } });
    assert.deepStrictEqual(bare.tradeVirtualIssuerSeams(), { ok: false, missing: ["services/account/walletState.adjustCharacterBalanceAsync"] });
    const peekThrows = adapterOver({ ...vendor, "services/character/characterState": { peekCharacterRecord: () => { throw new Error("db"); } } });
    assert.strictEqual(peekThrows.tradeReadCharacter(CHAR).ok, false, "never throws");
  });

  test("TA12 corp debit replay: the receipt answers duplicate below the amount, a failure receipt stays INSUFFICIENT_FUNDS", async () => {
    const CORP = 987654321;
    const authority = fakeCorpWalletAuthority({ 1000: 5000 });
    const spec = (deltaIsk, commandId) => ({ corporationId: CORP, accountKey: 1000, deltaIsk, commandId, description: "ta12" });

    let r = await adjustCorpDivisionFrom(authority, authority.walletState, spec(-2000, "lne:trade:ta12:proceeds"));
    assert.deepStrictEqual(r, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.strictEqual(authority.balance(1000), 3000);
    authority.setBalance(1000, 50);
    r = await adjustCorpDivisionFrom(authority, authority.walletState, spec(-2000, "lne:trade:ta12:proceeds"));
    assert.deepStrictEqual(r, { ok: true, duplicate: true, fingerprintMismatch: false });
    assert.strictEqual(authority.balance(1000), 50);
    r = await adjustCorpDivisionFrom(authority, authority.walletState, spec(-2000, "lne:trade:ta12:defund"));
    assert.deepStrictEqual(r, { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
    authority.setBalance(1000, 9000);
    r = await adjustCorpDivisionFrom(authority, authority.walletState, spec(-2000, "lne:trade:ta12:defund"));
    assert.deepStrictEqual(r, { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true, detail: "INSUFFICIENT_FUNDS" });
    assert.strictEqual(authority.balance(1000), 9000);
    assert.strictEqual(authority.calls.length, 4, "every leg reaches the vendor");
  });
};

function fakeCorpWalletAuthority(balances) {
  const CORP = 987654321;
  const wallet = vendorWallet(balances);
  const receipts = new Map();
  const calls = [];
  const execute = ({ accountKey, delta }) => {
    const division = wallet.divisions[String(accountKey)];
    const current = division ? Number(division.balance) || 0 : 0;
    const nextBalance = current + delta;
    if (nextBalance < -0.0001) {
      return { success: false, errorMsg: "INSUFFICIENT_FUNDS", data: { corporationID: CORP, accountKey, balance: current } };
    }
    division.balance = nextBalance;
    return { success: true, data: { corporationID: CORP, accountKey, balance: nextBalance } };
  };
  return {
    calls,
    balance: (key) => wallet.divisions[String(key)].balance,
    setBalance: (key, value) => { wallet.divisions[String(key)].balance = value; },
    walletState: fakeWalletState({ wallet }),
    async adjustCorporationWalletDivisionBalanceAsync(corporationID, accountKey, delta, options = {}, metadata = {}) {
      calls.push([corporationID, accountKey, delta, options, metadata]);
      const payload = { corporationID, accountKey, delta, options };
      const fingerprint = JSON.stringify(payload);
      const existing = receipts.get(metadata.commandID);
      if (existing) {
        return { ...existing.result, duplicate: true, fingerprintMismatch: existing.fingerprint !== fingerprint };
      }
      const result = execute(payload);
      receipts.set(metadata.commandID, { fingerprint, result });
      return result;
    },
  };
}

const CHAR = 90000123;

function fakeCharacterWalletState(balances) {
  const records = new Map(Object.entries(balances).map(([id, balance]) => [Number(id), { balance, receipts: new Map() }]));
  const calls = [];
  const getCharacterWallet = (charId) => {
    const rec = records.get(Number(charId));
    return rec ? { characterID: Number(charId), balance: rec.balance, aurBalance: 0, plexBalance: 0, balanceChange: 0 } : null;
  };
  return {
    calls,
    balance: (id) => records.get(id).balance,
    getCharacterWallet,
    async adjustCharacterBalanceAsync(charId, amount, options = {}, metadata = {}) {
      calls.push([charId, amount, options, metadata]);
      const rec = records.get(Number(charId));
      if (!rec) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
      const fingerprint = JSON.stringify([charId, amount, options.description]);
      const receipt = rec.receipts.get(options.idempotencyKey);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
        return { success: true, ...receipt.result, duplicate: true };
      }
      const next = rec.balance + amount;
      if (next < 0) return { success: false, errorMsg: "INSUFFICIENT_FUNDS" };
      const previousBalance = rec.balance;
      rec.balance = next;
      const result = { data: { ...getCharacterWallet(charId) }, previousBalance, delta: amount, journalEntry: {} };
      rec.receipts.set(options.idempotencyKey, { fingerprint, result });
      return { success: true, ...result, duplicate: false };
    },
  };
}

function adapterOver(vendorByRel) {
  const path = require("node:path");
  const SRC = path.join(path.sep, "x", "server", "src");
  const byAbs = {};
  for (const rel of Object.keys(vendorByRel)) byAbs[path.join(SRC, `${rel}.js`)] = vendorByRel[rel];
  const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true, requireFn: (abs) => byAbs[abs] || {} });
  adapter.setServerSrc(SRC);
  adapter.markBooted();
  return adapter;
}