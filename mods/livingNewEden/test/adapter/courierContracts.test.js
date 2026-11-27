"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");
const T = require("../../lib/adapter/tradeContracts");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const CONSUMER = "freeCorpsCouriers";
const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
const STATUS = Object.freeze({ OUTSTANDING: 0, IN_PROGRESS: 1, FINISHED_ISSUER: 2, FINISHED_CONTRACTOR: 3, FINISHED: 4,
  CANCELLED: 5, REJECTED: 6, FAILED: 7, DELETED: 8 });

function vendorError(info) {
  return Object.assign(new Error("Wrapped remote exception"), { name: "MachoWrappedException",
    machoErrorResponse: { errorCode: 10, payload: { type: "objectex1", header: [
      { type: "token", value: "eveexceptions.UserError" },
      ["CustomInfo", { type: "dict", entries: [["info", info]] }]] } } });
}

module.exports = ({ test }) => {
  test("CC1 vendor facts, buildCourierCall, createCourierFrom, failCourierFrom, the courier read "
    + "GAME_MODULES consumer freeCorpsCouriers, blind facade", async () => {
    const src = readSource("services/contracts/contractRuntimeState.js");
    const ensure = src.slice(src.indexOf("function ensureSupportedCreateInfo(info) {"));
    assert.ok(/info\.contractType === CONTRACT_TYPE\.COURIER && !info\.destinationID/.test(ensure.slice(0, 800)),
      "a courier needs destinationID");
    assert.ok(/info\.contractType === CONTRACT_TYPE\.COURIER && info\.itemList\.length === 0/.test(ensure.slice(0, 800)),
      "a courier needs items");
    assert.ok(src.includes("const COURIER_MAX_VOLUME = 1_200_000;"), "COURIER_MAX_VOLUME");
    assert.ok(/const CONTRACT_TYPE = Object\.freeze\(\{\n {2}ITEM_EXCHANGE: 1,\n {2}AUCTION: 2,\n {2}COURIER: 3,/.test(src),
      "CONTRACT_TYPE.COURIER 3");
    assert.ok(src.includes("const DAY_FILETIME_TICKS = 24n * 60n * 60n * 10_000_000n;"), "DAY_FILETIME_TICKS");
    assert.ok(src.includes("BigInt(Math.trunc(nowProvider())) * 10000n + 116444736000000000n"), "FILETIME epoch");
    const fail = src.slice(src.indexOf('} else if (normalizedOperation === "fail-courier") {'));
    assert.ok(fail.slice(0, 1500).includes("if (!actorIsAcceptor && !(actorIsIssuer && currentFileTime() > deadline)) {"),
      "the issuer fails only after the deadline");
    assert.ok(fail.slice(0, 1500).includes('"The issuer cannot fail this courier contract before its deadline."'));
    assert.ok(/legID: "fail:collateral-payment",\n {8}ref: contract\.issuerWallet,/.test(fail), "collateral -> issuer");
    assert.ok(/legID: "delete:reward-refund",\n {6}ref: contract\.issuerWallet,/.test(src), "delete refund -> issuer");
    assert.ok(/\} else if \(normalizedStatus === CONTRACT_STATUS\.FAILED\) \{\n {4}operation = "fail-courier";/.test(src),
      "completeContract FAILED -> fail-courier");
    const exportsAt = src.lastIndexOf("module.exports = {");
    assert.ok(exportsAt > 0 && /\n {2}completeContract,\n/.test(src.slice(exportsAt)), "completeContract exported");
    const issuer = src.slice(src.indexOf("function isIssuedBySessionWithCorpAuthority(contract, session) {"));
    assert.ok(/if \(!normalizeBoolean\(contract\.forCorp, false\)\) \{\n {4}return getSessionCharacterID\(session\) > 0 &&\n {6}toPositiveInteger\(contract\.issuerID, 0\) === getSessionCharacterID\(session\);/
      .test(issuer.slice(0, 500)), "a character contract: issuerID = session.characterID");
    assert.ok(/function throwContractError\(message\) \{\n {2}throwWrappedUserError\("CustomInfo", \{\n {4}info: /.test(src),
      "a contract refusal = CustomInfo {info}");
    const macho = readSource("common/machoErrors.js");
    assert.ok(macho.includes('super(message);') && macho.includes('constructor(payload, message = "Wrapped remote exception")'));
    assert.ok(macho.includes('[message, { type: "dict", entries: dictEntries }],'), "user error args = [name, dict]");

    const payload = { offerId: "fcc:3:1", corporationId: 98000003, ceoId: 98000004, npcStationId: 60000011,
      destinationStationId: 60000012, itemList: [[5001, 300]], rewardIsk: 450000, collateralIsk: 2000000, numDays: 3,
      minutesExpire: 4320, title: "Courier: Veldspar x300 to 30000012", description: "x [LNE:fcc:3:1]" };
    const call = T.buildCourierCall(payload);
    assert.ok(call.ok, JSON.stringify(call));
    assert.deepStrictEqual([call.info.contractType, call.info.startStationID, call.info.destinationID, call.info.reward,
      call.info.collateral, call.info.numDays, call.info.price, call.info.forCorp, call.info.startStationDivision,
      call.info.isPrivate], [3, 60000011, 60000012, 450000, 2000000, 3, 0, false, 4, false]);
    assert.deepStrictEqual(call.session, { characterID: 98000004, corporationID: 98000003 });
    assert.strictEqual(T.buildCourierCall({ ...payload, destinationStationId: 60000011 }).detail, "destination_is_start");
    assert.strictEqual(T.buildCourierCall({ ...payload, description: "no tag" }).detail, "tag_missing");
    assert.strictEqual(T.buildCourierCall({ ...payload, rewardIsk: 0 }).detail, "rewardIsk");

    const itemStore = { ITEM_FLAGS: { HANGAR: 4, CORP_DELIVERIES: 62 },
      listContainerItems: () => [{ itemID: 5001, ownerID: 98000004, typeID: 1230, stacksize: 300, singleton: 0 }] };
    const calls = [];
    const runtime = { createContract: async (info, session) => {
      calls.push([info, session]);
      const err = new Error("Wrapped remote exception");
      err.machoErrorResponse = { payload: { header: [{ type: "token" }, ["ConExceedsMaxVolume", { type: "dict",
        entries: [["max", 1200000]] }]] } };
      throw err;
    } };
    const created = await T.createCourierFrom(runtime, itemStore, { ...payload, itemList: undefined, typeId: 1230,
      quantity: 300, grantItemIds: [5001] });
    assert.deepStrictEqual([created.ok, created.reason, created.permanent], [false, "CONTRACT_CREATE_FAILED", true]);
    assert.deepStrictEqual(calls[0][0].itemList, [[5001, 300]]);

    const seen = [];
    const rt = (fn) => ({ CONTRACT_STATUS: STATUS, completeContract: async (...args) => { seen.push(args); return fn(); } });
    const spec = { contractId: 9001, ceoId: 98000004, corporationId: 98000003 };
    assert.deepStrictEqual(await T.failCourierFrom(rt(() => true), spec), { ok: true });
    assert.deepStrictEqual(seen[0], [9001, 7, { characterID: 98000004, corporationID: 98000003 }]);
    const pending = await T.failCourierFrom(rt(() => false), spec);
    assert.deepStrictEqual([pending.reason, pending.pending], ["COURIER_FAIL_FAILED", true]);
    const early = await T.failCourierFrom(rt(() => {
      throw vendorError("The issuer cannot fail this courier contract before its deadline.");
    }), spec);
    assert.deepStrictEqual([early.reason, early.pending, early.permanent], ["COURIER_FAIL_EARLY", false, false]);
    const busy = await T.failCourierFrom(rt(() => { throw vendorError("Another contract operation is already pending."); }),
      spec);
    assert.deepStrictEqual([busy.reason, busy.pending], ["COURIER_FAIL_FAILED", true]);
    assert.strictEqual((await T.failCourierFrom({ CONTRACT_STATUS: STATUS }, spec)).reason, "SEAM_UNAVAILABLE");

    const acceptedMs = 2000000000000;
    const dateAccepted = String(BigInt(acceptedMs) * 10000n + 116444736000000000n);
    const record = { contractID: 9001, type: 3, status: STATUS.IN_PROGRESS, dateAccepted, numDays: 3,
      endStationID: 60000012, issuerOwnerID: 98000004 };
    const records = new Map([[9001, record], [9002, { ...record, contractID: 9002, type: 1, status: STATUS.FINISHED }],
      [9003, { ...record, contractID: 9003, status: STATUS.OUTSTANDING, dateAccepted: "0" }]]);
    const cr = { CONTRACT_STATUS: STATUS, getContractRecord: (id) => records.get(id) || null };
    const cs = { getPendingContractSettlement: () => null };
    const r1 = T.readTradeContractFrom(cr, cs, 9001);
    assert.deepStrictEqual([r1.contract.status, r1.contract.courier], ["OTHER",
      { phase: "IN_PROGRESS", deadlineMs: acceptedMs + 3 * 86400000, destinationStationId: 60000012 }]);
    const r2 = T.readTradeContractFrom(cr, cs, 9002);
    assert.deepStrictEqual([r2.contract.status, r2.contract.courier], ["FINISHED", null]);
    assert.deepStrictEqual(T.readTradeContractFrom(cr, cs, 9003).contract.courier,
      { phase: "OUTSTANDING", deadlineMs: null, destinationStationId: 60000012 });

    assert.ok(!MODULE_NAMES.includes(CONSUMER), "freeCorpsCouriers is not a module name");
    const symOf = (rel, name) => GAME_MODULES.find((e) => e.path === rel).symbols.find((s) => s.name === name);
    const complete = symOf("services/contracts/contractRuntimeState", "completeContract");
    assert.deepStrictEqual([complete.consumers, complete.wrap === true, complete.firstLoad === true],
      [[CONSUMER], false, false]);
    for (const [rel, name] of [["services/contracts/contractRuntimeState", "createContract"],
      ["services/contracts/contractRuntimeState", "CONTRACT_STATUS"], ["services/account/walletState",
        "adjustCharacterBalanceAsync"], ["services/inventory/itemStore", "grantItemToOwnerLocationIdempotent"],
      ["services/inventory/itemCustody", "transfer"], ["services/inventory/itemTypeRegistry", "resolveItemByTypeID"]]) {
      assert.ok(symOf(rel, name).consumers.includes(CONSUMER), `${rel}.${name}`);
    }

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(blind.freeCorpsCourierSeams().reason, "SEAM_UNAVAILABLE");
    assert.strictEqual((await blind.tradeCreateCourierContract(payload)).ok, false);
    assert.strictEqual((await blind.tradeFailCourierContract(spec)).ok, false);
  });
};
