"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

function exportsBlock(source) {
  const start = source.indexOf("\nmodule.exports = {");
  assert.ok(start >= 0, "module.exports not found");
  return source.slice(start, source.indexOf("\n};", start));
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(SERVER_SRC)) {
    skip("SVF1-8 d2 WTS vendor facts", "server/src not found");
    return;
  }
  const store = () => readSource("services/inventory/itemStore.js");
  const contracts = () => readSource("services/contracts/contractRuntimeState.js");

  test("SVF1 d2 vendor: grantItemToOwnerLocationIdempotent exported, key <= 512 without '/', replay duplicate + itemIDs",
    () => {
      const src = store();
      assert.match(exportsBlock(src), /\n {2}grantItemToOwnerLocationIdempotent,\n/);
      assert.match(bodyOf(src, "normalizeIdempotentGrantReceiptKey"),
        /receiptKey && receiptKey\.length <= 512 && !receiptKey\.includes\("\/"\)/);
      const body = bodyOf(src, "grantItemToOwnerLocationIdempotent");
      assert.match(body, /errorMsg: "IDEMPOTENCY_RECEIPT_MISMATCH"/);
      assert.match(body, /success: true,\s*duplicate: true,/);
      assert.match(body, /itemIDs: readReceiptItemIDs\(receiptResult\.data\)/);
      assert.match(body, /"IDEMPOTENT_GRANT_WRITE_OUTCOME_AMBIGUOUS"/);
      assert.match(bodyOf(src, "attachIdempotentGrantReceiptForEntries"), /receipt\.resultData = \{[\s\S]*itemIDs,/);
    });

  test("SVF2 d2 vendor: getIdempotentGrantReceipt exported, answers found", () => {
    const src = store();
    assert.match(exportsBlock(src), /\n {2}getIdempotentGrantReceipt,\n/);
    const body = bodyOf(src, "getIdempotentGrantReceipt");
    assert.match(body, /found: Boolean\(receipt\)/);
    assert.match(body, /data: receipt/);
  });

  test("SVF3 d2 vendor: corp contract flags have CORP_DELIVERIES, character HANGAR only, same division flag", () => {
    const src = contracts();
    assert.match(src, /const CORP_CONTRACT_ITEM_FLAGS = new Set\(\[\s*ITEM_FLAGS\.CORP_DELIVERIES,/);
    assert.match(store(), /\n {2}CORP_DELIVERIES: 62,\n/);
    assert.match(bodyOf(src, "isAllowedContractSourceFlag"), /\n {2}return normalizedFlagID === ITEM_FLAGS\.HANGAR;\n/);
    const same = bodyOf(src, "sameContractDivisionFlag");
    assert.match(same, /if \(normalizedItemFlagID === normalizedSelectedFlagID\) \{\s*return true;\s*\}/);
    assert.match(same, /flagID === ITEM_FLAGS\.HANGAR \|\| flagID === 115/);
    assert.match(bodyOf(src, "validateCreationItems"), /info\.forCorp,\s*info\.startStationDivision,/);
  });

  test("SVF4 d2 vendor: accepted ITEM_EXCHANGE credits contract.price to contract.issuerWallet", () => {
    assert.match(contracts(), /legID: "accept:price-credit",\s*ref: contract\.issuerWallet,\s*delta: contract\.price,/);
  });

  test("SVF5 d2 vendor: delete of an ITEM_EXCHANGE returns the escrow with getOwnerDeliveryFlag(forCorp, division)",
    () => {
      const src = contracts();
      const start = src.indexOf('} else if (normalizedOperation === "delete") {');
      assert.ok(start >= 0, "delete branch not found");
      const branch = src.slice(start, src.indexOf("} else if (", start + 10));
      assert.match(branch, /const destinationFlagID = getOwnerDeliveryFlag\(normalizeBoolean\(contract\.forCorp, false\)\);/);
      assert.match(branch, /contract\.type === CONTRACT_TYPE\.ITEM_EXCHANGE \|\| contract\.type === CONTRACT_TYPE\.AUCTION\) \{\s*payload\.itemLegs = buildTerminalEscrowItemLegs\(\s*contract,\s*"delete-item-exchange",\s*contract\.issuerOwnerID,\s*contract\.startStationID,\s*destinationFlagID,\s*CUSTODY_REASON\.CONTRACT_ESCROW_RETURN,/);
      const flag = bodyOf(src, "getOwnerDeliveryFlag");
      assert.match(flag, /return forCorp \? ITEM_FLAGS\.CORP_DELIVERIES : ITEM_FLAGS\.HANGAR;/);
    });

  test("SVF6 d2 vendor: a stackable grant merges into an existing stack of the same owner/location/flag/type", () => {
    const src = store();
    const stackable = bodyOf(src, "applyStackableGrant");
    assert.match(stackable, /const existingStack = findStackWithAvailableCapacity\(\s*stackIndex,\s*ownerID,\s*locationID,\s*flagID,\s*metadata\.typeID,\s*options\.careerBoundCharacterID \|\| 0,\s*\);/);
    assert.match(bodyOf(src, "findStackWithAvailableCapacity"),
      /Number\(candidate\.careerBoundCharacterID \|\| 0\) === Number\(careerBoundCharacterID \|\| 0\)/);
    assert.match(stackable, /quantity: currentQuantity \+ mergedQuantity,/);
    assert.match(bodyOf(src, "findStackWithAvailableCapacity"), /buildStackKey\(ownerID, locationID, flagID, typeID\)/);
    assert.match(bodyOf(src, "grantItemsToOwnerLocation"), /applyStackableGrant\(\{/);
  });

  test("SVF7 d2 vendor: a ship defaults to singleton, options.singleton overrides", () => {
    const src = store();
    assert.match(bodyOf(src, "shouldItemDefaultToSingleton"), /return categoryID === SHIP_CATEGORY_ID \|\|/);
    assert.match(src, /\nconst SHIP_CATEGORY_ID = 6;\n/);
    const owner = bodyOf(src, "grantItemsToOwnerLocation");
    assert.match(owner, /options\.singleton === undefined \|\| options\.singleton === null\s*\? shouldItemDefaultToSingleton\(metadata\)\s*: toNumber\(options\.singleton, 0\) > 0/);
  });

  test("SVF8 d2 vendor: no sales tax / broker fee on ITEM_EXCHANGE in services/contracts; reward 0 = rewardApplied",
    () => {
      const dir = path.join(SERVER_SRC, "services", "contracts");
      const fee = /salestax|brokerfee|broker_fee|contracttax/i;
      const hits = fs.readdirSync(dir).filter((f) => f.endsWith(".js"))
        .filter((f) => fee.test(fs.readFileSync(path.join(dir, f), "utf8")));
      assert.deepStrictEqual(hits.filter((f) => f !== "contractAuctionClaims.js" && f !== "contractRuntimeState.js"),
        [], "a contract fee appeared - the WTS price is no longer the whole proceeds");
      const src = contracts();
      const feeLines = src.split(/\r?\n/).filter((l) => fee.test(l) && !/privateBrokerFee|PRIVATE_CONTRACT_BROKER_FEE/.test(l));
      assert.ok(feeLines.every((l) => /auction(BrokerFee|SalesTax)|auction-broker/.test(l)),
        `a non-auction fee in contractRuntimeState: ${feeLines.filter((l) => !/auction/i.test(l)).join(" | ")}`);
      assert.ok(src.includes("\nconst PRIVATE_CONTRACT_BROKER_FEE = 10000;\n"), "private broker fee 10000");
      assert.match(bodyOf(src, "prepareContractCreationRequest"), /const isPrivate = resolveAvailability\(info, session\) !== CONTRACT_AVAILABILITY\.PUBLIC;\s*const privateBrokerFee = isPrivate && info\.contractType !== CONTRACT_TYPE\.AUCTION\s*\? PRIVATE_CONTRACT_BROKER_FEE\s*: 0;/);
      assert.match(bodyOf(src, "resolveAvailability"), /if \(!info\.isPrivate \|\| !info\.assignedToID\) \{\s*return CONTRACT_AVAILABILITY\.PUBLIC;/);
      assert.match(src, /if \(info\.contractType === CONTRACT_TYPE\.AUCTION\) \{\s*walletLegs\.push\(\s*buildContractWalletLeg\(\{ legID: "create:auction-broker"/);
      assert.match(src, /\} else if \(privateBrokerFee > 0\) \{\s*walletLegs\.push\(\{\s*\.\.\.buildContractWalletLeg\(\{\s*legID: "create:broker-fee",/);
      assert.match(bodyOf(src, "prepareContractCreationRequest"),
        /if \(info\.contractType === CONTRACT_TYPE\.AUCTION\) \{[^}]*terms\.auctionBrokerFee/);
      const claims = fs.readFileSync(path.join(dir, "contractAuctionClaims.js"), "utf8");
      assert.match(claims, /if \(!record \|\| record\.type !== p\.CONTRACT_TYPE\.AUCTION\) return fail\("CONTRACT_NOT_FOUND"\);/,
        "the sales tax claim refuses every non-auction contract");
      assert.match(src, /rewardApplied: info\.reward <= 0,/);
    });

  test("PF1: parsePrivateContractFee on the vendor source = 10000; drift details; facade cached",
    () => {
      const { parsePrivateContractFee } = require("../../lib/adapter/tradeContracts");
      const { createAdapter } = require("../../lib/adapter/index");
      const src = contracts();
      assert.deepStrictEqual(parsePrivateContractFee(src), { ok: true, feeIsk: 10000 });
      const drift = (detail) => ({ ok: false, reason: "PRIVATE_FEE_DRIFT", detail });
      assert.deepStrictEqual(parsePrivateContractFee(src.replace("\nconst PRIVATE_CONTRACT_BROKER_FEE = 10000;\n", "\n")),
        drift("constant"));
      assert.deepStrictEqual(parsePrivateContractFee(src.replace("const PRIVATE_CONTRACT_BROKER_FEE = 10000;",
        "const PRIVATE_CONTRACT_BROKER_FEE = 0;")), drift("constant"));
      assert.deepStrictEqual(parsePrivateContractFee(src.replace("info.contractType !== CONTRACT_TYPE.AUCTION\n    ? PRIVATE_CONTRACT_BROKER_FEE",
        "info.reward > 0\n    ? PRIVATE_CONTRACT_BROKER_FEE")), drift("rule"));
      assert.deepStrictEqual(parsePrivateContractFee(src.replace("if (!info.isPrivate || !info.assignedToID) {",
        "if (!info.isPrivate) {")), drift("availability"));
      assert.deepStrictEqual(parsePrivateContractFee(src.replace("info.reward + privateBrokerFee,", "info.reward,")),
        drift("funds"));
      assert.deepStrictEqual(parsePrivateContractFee(null), drift("constant"));
      let reads = 0;
      const adapter = createAdapter({ readFileSync: (p, enc) => { reads += 1; return fs.readFileSync(p, enc); } });
      assert.deepStrictEqual(adapter.tradePrivateContractFee(), { ok: false, reason: "SERVER_SRC_UNKNOWN" });
      adapter.setServerSrc(SERVER_SRC);
      assert.deepStrictEqual(adapter.tradePrivateContractFee(), { ok: true, feeIsk: 10000 });
      adapter.tradePrivateContractFee();
      assert.strictEqual(reads, 1, "cached");
      const broken = createAdapter({ readFileSync: () => { throw new Error("EACCES"); } });
      broken.setServerSrc(SERVER_SRC);
      assert.deepStrictEqual(broken.tradePrivateContractFee(), { ok: false, reason: "SOURCE_UNREADABLE" });
    });
};
