"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "server");
const SERVER_SRC = path.join(SERVER_ROOT, "src");

function readFrom(root, rel) {
  return fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
}

function readSource(rel) {
  return readFrom(SERVER_SRC, rel);
}

function bodyOf(source, name) {
  let start = source.indexOf(`\nfunction ${name}(`);
  if (start < 0) start = source.indexOf(`\nasync function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(SERVER_SRC)) {
    skip("CWF1-5 corp wallet receipt vendor facts", "server/src not found");
    return;
  }
  const receipts = () => readSource("services/account/walletAuthorityReceiptState.js");

  test("CWF1 vendor: executeIdempotently finds the receipt by commandID before execute, a hit is duplicate:true", () => {
    const body = bodyOf(receipts(), "executeIdempotently");
    assert.match(body, /const commandID = String\(metadata && metadata\.commandID \|\| ""\)\.trim\(\);/);
    assert.match(body, /\(receipt\) => receipt && receipt\.commandID === commandID/);
    const hit = body.indexOf("if (existing && !retryCapacityFailure)");
    const exec = body.indexOf("const result = execute(");
    assert.ok(hit >= 0 && exec >= 0, "receipt lookup and execute present");
    assert.ok(hit < exec, "receipt lookup comes before execute (balance check)");
    assert.ok(body.slice(hit, exec).includes("duplicate: true"), "a receipt hit answers duplicate:true");
    assert.strictEqual(body.slice(hit, exec).split("duplicate: true").length - 1, 2, "both hit branches duplicate");
    assert.match(body.slice(0, hit), /existing\.result\?\.success === false &&\s*existing\.result\.errorMsg === "WALLET_RECEIPT_LIMIT";/);
    assert.match(body.slice(exec), /appendReceipt\(target, \{[\s\S]*?\n\s+result,\n/);
  });

  test("CWF2 vendor: corporation.* commands have a corporation receipt target; CORPORATION_ADJUST_ISK type", () => {
    const body = bodyOf(receipts(), "resolveReceiptTarget");
    assert.match(body, /String\(commandType\)\.startsWith\("corporation\."\)\) \{\s*const corporationID = Math\.trunc\(Number\(payload\.corporationID\) \|\| 0\);/);
    assert.match(body, /\{ kind: "corporation", ownerID: corporationID \}/);
    assert.match(readSource("services/account/walletCommandAuthority.js"), /\n {2}CORPORATION_ADJUST_ISK: "corporation\.adjust-isk",\n/);
  });

  test("CWF3 vendor: worker handleCommand goes through executeIdempotently and returns tagReplayVerdict", () => {
    const src = readSource("services/account/walletAuthorityProcess.worker.js");
    const start = src.indexOf("handleCommand(commandType, payload, context) {");
    assert.ok(start >= 0, "handleCommand not found");
    const handler = src.slice(start, src.indexOf("\n  },", start));
    assert.match(handler, /receiptState\.executeIdempotently\(/);
    assert.match(handler, /return tagReplayVerdict\(outcome\);/);
    assert.match(bodyOf(src, "tagReplayVerdict"), /\.\.\.result,\s*duplicate: true,\s*fingerprintMismatch: outcome\.fingerprintMismatch === true,/);
  });

  test("CWF4 vendor: corp adjust async passes metadata and payload; INSUFFICIENT_FUNDS at nextBalance < -0.0001", () => {
    const src = readSource("services/corporation/corpWalletState.js");
    assert.match(bodyOf(src, "adjustCorporationWalletDivisionBalanceAsync"),
      /executeWalletCommandAsync\(\s*WALLET_COMMAND_TYPE\.CORPORATION_ADJUST_ISK,\s*\{ corporationID, accountKey, delta, options \},\s*metadata,\s*\)/);
    assert.match(bodyOf(src, "applyAdjustCorporationWalletDivisionBalance"),
      /if \(nextBalance < -0\.0001\) \{\s*return \{\s*success: false,\s*errorMsg: "INSUFFICIENT_FUNDS",/);
  });

  test("CWF5 vendor: bootWorld starts the production wallet authority runtime, which enables the process mode", () => {
    assert.match(readFrom(SERVER_ROOT, "bootstrap.js"), /await productionWalletAuthorityRuntime\.start\(\);/);
    assert.match(readSource("services/account/productionWalletAuthorityRuntime.js"),
      /await authority\.enableWalletAuthorityProcess\(\);/);
  });
};
