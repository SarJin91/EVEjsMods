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

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(SERVER_SRC)) {
    skip("HVF1-4 c1 hull contract vendor facts", "server/src not found");
    return;
  }
  const contracts = () => readSource("services/contracts/contractRuntimeState.js");

  test("HVF1 c1 vendor: findRequestedItems filters typeID + source flag, no singleton filter", () => {
    const body = bodyOf(contracts(), "findRequestedItems");
    assert.match(body, /item\.typeID|item && item\.typeID/);
    assert.match(body, /toPositiveInteger\(typeID, 0\)/);
    assert.match(body, /isAllowedContractSourceFlag\(item\.flagID/);
    assert.ok(!body.includes("singleton"), "a singleton filter appeared - assembled ships may no longer match");
  });

  test("HVF2 c1 vendor: getItemQuantity counts a singleton as 1", () => {
    const body = bodyOf(contracts(), "getItemQuantity");
    assert.match(body, /if \(toInteger\(item\.singleton, 0\) === 1\) \{\s*return 1;\s*\}/);
    assert.match(body, /return toPositiveInteger\(item\.stacksize \?\? item\.quantity, 0\);/);
  });

  test("HVF3 c1 vendor: the accept saga hands the ship contents to the issuer", () => {
    const src = contracts();
    const legs = bodyOf(src, "buildRequestedAcceptanceLegs");
    assert.match(legs, /findRequestedItems\(/);
    assert.match(legs, /contentLegs: quantity === getItemQuantity\(item\)\s*\? buildContractContentLegs\(/);
    const at = src.indexOf("\nasync function deliverItemExchangeAcceptance(");
    assert.ok(at >= 0, "deliverItemExchangeAcceptance not found");
    const deliver = src.slice(at, src.indexOf("\nfunction ", at + 1));
    assert.match(deliver, /item: leg\.escrowItem,\s*ownerID: contract\.issuerOwnerID,\s*locationID: contract\.startStationID,/);
    assert.match(deliver, /transferAcceptanceContentLegs\(\s*contractID,\s*"requestedLegs",\s*leg\.legID,\s*contract\.issuerOwnerID,\s*\)/);
    assert.ok(!src.includes("function transferRequestedItemsToIssuer("), "the old helper is gone");
  });

  test("HVF4 c1 vendor: consumeInventoryItemQuantity removes a singleton whole; custody removes contents by default",
    () => {
      const store = bodyOf(readSource("services/inventory/itemStore.js"), "consumeInventoryItemQuantity");
      assert.match(store, /if \(currentItem\.singleton === 1 \|\| consumeQuantity === availableQuantity\) \{\s*return removeInventoryItem\(itemId, options\);/);
      const custody = readSource("services/inventory/itemCustody.js");
      assert.match(custody, /if \(command\.options\.removeContents !== false\) \{/);
      assert.match(custody, /itemStore\.consumeInventoryItemQuantity\(\s*command\.itemSpec\.itemID,\s*command\.itemSpec\.quantity,\s*\{ removeContents: command\.options\.removeContents !== false \},/);
      assert.match(custody, /ITEM_CUSTODY_OWNER_CHANGE_NOT_SUPPORTED/);
    });
};
