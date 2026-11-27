"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createAdapter } = require("../../lib/adapter");
const { PUMP_METHODS } = require("../../lib/world/liberation/payoutPump");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function exported(source, name) {
  const at = source.lastIndexOf("module.exports = {");
  assert.ok(at >= 0, "module.exports not found");
  return new RegExp(`\\n {2}${name},`).test(source.slice(at));
}

module.exports = ({ test, skip }) => {
  const walletPath = path.join(SERVER_SRC, "services", "account", "walletState.js");
  if (!fs.existsSync(walletPath)) {
    skip("PRF1 reward wallet vendor facts", "server/src not found");
    return;
  }
  test("PRF1 reward wallet vendor facts: entry type 99, ISK fingerprint fields, receipt before balance, LP durable "
    + "flush + ambiguous + fingerprint; pump methods on the real adapter facade", () => {
    const wallet = readSource("services/account/walletState.js");
    assert.ok(/\n {2}CORPORATE_REWARD_PAYOUT: 99,/.test(wallet), "JOURNAL_ENTRY_TYPE.CORPORATE_REWARD_PAYOUT 99");
    assert.ok(/const MAX_WALLET_OPERATION_RECEIPTS = 512;/.test(wallet), "512 receipts per record");
    const fp = bodyOf(wallet, "buildWalletAdjustmentFingerprint");
    for (const field of ["referenceID", "entryTypeID", "ownerID1", "ownerID2", "description", "amount", "charId"]) {
      assert.ok(fp.includes(`${field}:`), `fingerprint field ${field}`);
    }
    const apply = bodyOf(wallet, "applyAdjustCharacterBalance");
    const receiptAt = apply.indexOf("findWalletOperationReceipt(");
    const balanceAt = apply.indexOf("getCharacterWallet(charId)");
    assert.ok(receiptAt > 0 && balanceAt > receiptAt, "the receipt is looked up before the balance");
    assert.ok(apply.includes("duplicate: true") && apply.includes("IDEMPOTENCY_KEY_REUSED"));
    assert.ok(bodyOf(wallet, "adjustCharacterBalanceAsync").includes("metadata"), "metadata goes to the command");
    assert.ok(exported(wallet, "adjustCharacterBalanceAsync") && exported(wallet, "getCharacterWallet"));

    const lp = readSource("services/corporation/lpWalletState.js");
    assert.ok(exported(lp, "adjustCharacterWalletLPBalanceDurable"), "durable LP export");
    const durable = bodyOf(lp, "adjustCharacterWalletLPBalanceDurable");
    assert.ok(durable.includes("flushTableSync(LP_WALLETS_TABLE)") && durable.includes("ambiguous: true"),
      "the durable call flushes lpWallets and answers ambiguous");
    const lpFp = bodyOf(lp, "adjustCharacterWalletLPBalance");
    for (const field of ["kind: \"character\"", "ownerID:", "issuerCorpID:", "delta:"]) {
      assert.ok(lpFp.includes(field), `LP fingerprint ${field}`);
    }
    const update = bodyOf(lp, "updateWalletBalance");
    assert.ok(update.includes("IDEMPOTENCY_KEY_REUSED") && update.includes("duplicate: true")
      && update.includes("INVALID_OWNER_OR_ISSUER"));

    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    for (const name of PUMP_METHODS) assert.strictEqual(typeof adapter[name], "function", `adapter.${name}`);
  });
};
