"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const T = require("../../lib/adapter/tradeContracts");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

function limitError(max) {
  const entries = [["max", max]];
  return Object.assign(new Error("Wrapped remote exception"), { name: "MachoWrappedException",
    machoErrorResponse: { errorCode: 2, payload: { type: "objectex1", header: [
      { type: "token", value: "eveexceptions.UserError" },
      ["ConTooManyContractsMax", { type: "dict", entries }],
      { type: "dict", entries: [["msg", "ConTooManyContractsMax"], ["dict", { type: "dict", entries }]] }] } } });
}

const tableOf = (src, name) => {
  const m = new RegExp(`const ${name} = Object\\.freeze\\(\\[([0-9, ]+)\\]\\);`).exec(src);
  assert.ok(m, `${name} table`);
  return m[1].split(",").map((s) => Number(s.trim()));
};

const WTB = Object.freeze({ offerId: "clm-wtb", corporationId: 1000035, ceoId: 3004001, accountKey: 1000,
  npcStationId: 60003760, typeId: 34, quantity: 100, rewardIsk: 5000000, minutesExpire: 1440, title: "Buy Tritanium",
  description: "Wanted: Tritanium [LNE:clm-wtb]" });
const WTS = Object.freeze({ offerId: "clm-wts", corporationId: 1000035, ceoId: 3004001, accountKey: 1000,
  npcStationId: 60003760, typeId: 34, quantity: 300, priceIsk: 1100, minutesExpire: 1440, title: "Sells Tritanium",
  description: "x [LNE:clm-wts]", grantItemIds: [5001] });
const COURIER = Object.freeze({ offerId: "fcc:3:1", corporationId: 98000003, ceoId: 98000004, npcStationId: 60000011,
  destinationStationId: 60000012, typeId: 1230, quantity: 300, rewardIsk: 450000, collateralIsk: 2000000, numDays: 3,
  minutesExpire: 4320, title: "Courier: Veldspar x300", description: "x [LNE:fcc:3:1]", grantItemIds: [5001] });

const itemStoreOf = (ownerId, typeId = 34) => ({ ITEM_FLAGS: { HANGAR: 4, CORP_DELIVERIES: 62 },
  listContainerItems: () => [{ itemID: 5001, ownerID: ownerId, typeID: typeId, stacksize: 300, singleton: 0 }] });

const resolve = (env) => config.resolveConfig({ env, modDir: MOD_DIR });
const limitNotes = (r) => {
  const n = config.contractLimitNotes(r.config);
  return [...n.trade.map((x) => `trade: ${x}`), ...n.freeCorps.map((x) => `freeCorps: ${x}`)];
};

module.exports = ({ test }) => {
  test("CLM1 vendor facts: skill tables, assertOutstandingContractLimit before the saga, ConTooManyContractsMax; "
    + "the mod limits equal the level-0 entries", () => {
    const src = readSource("services/contracts/contractRuntimeState.js");
    const corp = tableOf(src, "NUM_CONTRACTS_BY_SKILL_CORP");
    const personal = tableOf(src, "NUM_CONTRACTS_BY_SKILL");
    const adv = tableOf(src, "NUM_CONTRACTS_BY_ADVSKILL");
    assert.deepStrictEqual([corp, personal, adv], [[10, 20, 30, 40, 50, 60], [1, 5, 9, 13, 17, 21], [0, 4, 8, 12, 16, 20]]);
    assert.strictEqual(config.VENDOR_CONTRACT_LIMIT_CORP, corp[0]);
    assert.strictEqual(config.VENDOR_CONTRACT_LIMIT_CHARACTER, personal[0] + adv[0]);

    const body = src.slice(src.indexOf("function assertOutstandingContractLimit(info, session) {"));
    const fn = body.slice(0, body.indexOf("\n}\n"));
    assert.ok(fn.includes("const limit = info.forCorp ? NUM_CONTRACTS_BY_SKILL_CORP[level(25233)]"), "corp by 25233");
    assert.ok(fn.includes(": NUM_CONTRACTS_BY_SKILL[level(25235)] + NUM_CONTRACTS_BY_ADVSKILL[level(73912)];"),
      "personal by 25235 + 73912");
    assert.ok(fn.includes("record.issuerID === getSessionCharacterID(session)"), "counted per issuing character");
    assert.ok(fn.includes("throwContractUserError(\"ConTooManyContractsMax\""), "the refusal");
    const call = src.indexOf("\n  assertOutstandingContractLimit(info, session);\n  validateCreationItems(info, ownerID, session);\n");
    assert.ok(call > 0, "called by the create before validateCreationItems");
    const dup = src.lastIndexOf("return { success: true, duplicate: true, data: existing };", call);
    assert.ok(dup > 0 && call - dup < 200, "right after the pending-duplicate return");
    assert.ok(/function throwContractUserError\(message, values = \{\}\) \{\n {2}throwWrappedUserError\(message, values\);/
      .test(src), "a wrapped user error with the name as message");
  });

  test("CLM2 WTB / WTS / courier create: ConTooManyContractsMax (thrown or errorMsg) -> CONTRACT_LIMIT permanent; "
    + "other refusals unchanged", async () => {
    const throwing = (err) => ({ CORP_ROLE_CONTRACT_MANAGER: 1n << 59n, createContract: async () => { throw err; } });
    const answering = (errorMsg) => ({ createContract: async () => ({ success: false, errorMsg }) });
    const shape = (r) => [r.ok, r.reason, r.permanent];
    const LIMIT = [false, "CONTRACT_LIMIT", true];

    const wtb = await T.createWantToBuyFrom(throwing(limitError(10)), WTB);
    assert.deepStrictEqual(shape(wtb), LIMIT);
    assert.ok(wtb.detail.includes("ConTooManyContractsMax"), wtb.detail);
    assert.deepStrictEqual(shape(await T.createWantToBuyFrom(answering("ConTooManyContractsMax"), WTB)), LIMIT);
    assert.deepStrictEqual(shape(await T.createWantToBuyFrom(answering("does not have enough funds"), WTB)),
      [false, "CONTRACT_CREATE_FAILED", false], "funds stay transient");

    const wtsCorp = await T.createWantToSellFrom(throwing(limitError(10)), itemStoreOf(WTS.corporationId), WTS);
    assert.deepStrictEqual(shape(wtsCorp), LIMIT);
    const char = { ...WTS, issuerKind: "character", ownerId: WTS.ceoId };
    assert.deepStrictEqual(shape(await T.createWantToSellFrom(throwing(limitError(1)), itemStoreOf(WTS.ceoId), char)),
      LIMIT);
    assert.deepStrictEqual(shape(await T.createWantToSellFrom(answering("ConTooManyContractsMax"),
      itemStoreOf(WTS.corporationId), WTS)), LIMIT);
    const busy = await T.createWantToSellFrom(throwing(new Error("Another contract operation is already pending.")),
      itemStoreOf(WTS.corporationId), WTS);
    assert.deepStrictEqual(shape(busy), [false, "CONTRACT_CREATE_FAILED", false], "pending stays transient");

    assert.deepStrictEqual(shape(await T.createCourierFrom(throwing(limitError(1)), itemStoreOf(COURIER.ceoId, 1230),
      COURIER)), LIMIT);
    assert.deepStrictEqual(shape(await T.createCourierFrom(answering("ConTooManyContractsMax"),
      itemStoreOf(COURIER.ceoId, 1230), COURIER)), LIMIT);
    assert.strictEqual(T.CONTRACT_LIMIT_ERROR, "ConTooManyContractsMax");
  });

  test("CLM3 contractLimitNotes: start lines over the vendor limits (faction offers > 10, offers per virtual issuer "
    + "> 1, free corp maxPerCorp > 1), quiet under them; defaults unchanged and the config warnings stay silent", () => {
    const d = resolve({});
    assert.deepStrictEqual([d.config.trade.maxOpenOffersPerFaction, d.config.trade.wtsMaxOpenPerFaction],
      [32, 8], "defaults stay");
    assert.ok(limitNotes(d).length >= 1, "the defaults are over the limit: the start line shows it");
    assert.deepStrictEqual(d.warnings.filter((w) => w.includes("ConTooManyContractsMax")), [],
      "not a config warning (a default config stays silent)");

    const on = { EVEJS_LNE_TRADE_ENABLED: "1", EVEJS_LNE_STRATEGY_ENABLED: "1", EVEJS_LNE_TRADE_WTS_ENABLED: "1",
      EVEJS_LNE_TRADE_MAX_OPEN_OFFERS_PER_FACTION: "32", EVEJS_LNE_TRADE_WTS_MAX_OPEN_PER_FACTION: "8",
      EVEJS_LNE_TRADE_VIRTUAL_ISSUERS: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1",
      EVEJS_LNE_VIRTUAL_CORPS_CORPS_PER_FACTION: "2" };
    const over = limitNotes(resolve(on));
    assert.ok(over.some((w) => w.startsWith("trade: open offers per faction (40) > 10 ")), over.join("\n"));
    assert.ok(over.some((w) => w.startsWith("trade: open offers per virtual issuer (40 over 2 heads) > 1 ")),
      over.join("\n"));

    const under = limitNotes(resolve({ ...on, EVEJS_LNE_TRADE_MAX_OPEN_OFFERS_PER_FACTION: "1",
      EVEJS_LNE_TRADE_WTS_ENABLED: "0", EVEJS_LNE_TRADE_VIRTUAL_ISSUERS: "0" }));
    assert.deepStrictEqual(under, [], "under the limits: quiet");
    const virtualOk = limitNotes(resolve({ ...on, EVEJS_LNE_TRADE_MAX_OPEN_OFFERS_PER_FACTION: "2",
      EVEJS_LNE_TRADE_WTS_ENABLED: "0" }));
    assert.deepStrictEqual(virtualOk, [], "2 offers over 2 heads = 1 per head");

    const fc = { EVEJS_LNE_TRADE_MAX_OPEN_OFFERS_PER_FACTION: "1", EVEJS_LNE_FREE_CORPS_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1", EVEJS_LNE_FREE_CORPS_CONTRACTS_ENABLED: "1" };
    const fcOver = limitNotes(resolve({ ...fc, EVEJS_LNE_FREE_CORPS_CONTRACTS_MAX_PER_CORP: "2" }));
    assert.deepStrictEqual(fcOver.map((w) => w.split(" > ")[0]), ["freeCorps: contracts.maxPerCorp=2"]);
    assert.deepStrictEqual(limitNotes(resolve({ ...fc, EVEJS_LNE_FREE_CORPS_CONTRACTS_MAX_PER_CORP: "1" })), []);
  });
};
