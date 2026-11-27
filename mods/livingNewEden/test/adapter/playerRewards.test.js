"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { creditRewardIskFrom, creditRewardLpFrom } = require("../../lib/adapter/playerRewards");
const { MAX_CHARACTER_BALANCE } = require("../../lib/adapter/tradeContracts");
const { createAdapter } = require("../../lib/adapter");

const CHAR = 90000001;
const CORP = 1000035;
const SYS = 30000142;
const KEY = "lne:libpay:30000142:0:1000:90000001:isk";

function fakeWallet(balances) {
  const receipts = new Map();
  const calls = [];
  const api = {
    mode: "ok",
    getCharacterWallet: (id) => (balances.has(id) ? { characterID: id, balance: balances.get(id) } : null),
    async adjustCharacterBalanceAsync(charId, amount, options = {}, metadata = {}) {
      calls.push({ charId, amount, options: { ...options }, metadata: { ...metadata } });
      if (api.mode === "fail") return { success: false, errorMsg: "WRITE_ERROR" };
      const fp = JSON.stringify([charId, amount, options.referenceID || options.ownerID2 || 0, options.entryTypeID,
        options.ownerID1 || charId, options.ownerID2 || 0, options.description]);
      const r = receipts.get(options.idempotencyKey);
      if (r) return r.fp === fp ? { success: true, data: r.data, duplicate: true }
        : { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
      if (!balances.has(charId)) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
      balances.set(charId, balances.get(charId) + amount);
      const data = { balance: balances.get(charId) };
      receipts.set(options.idempotencyKey, { fp, data });
      return { success: true, data };
    },
  };
  return { api, calls };
}

function fakeGameStore() {
  const flushes = [];
  const api = {
    mode: "ok",
    flushTableSync(table) {
      flushes.push(table);
      if (api.mode === "throw") throw new Error("role may not flush");
      return api.mode === "fail" ? { success: false, errorMsg: "SQLITE_BUSY" } : { success: true };
    },
  };
  return { api, flushes };
}

function fakeLp() {
  const receipts = new Map();
  const balances = new Map();
  const api = {
    mode: "ok",
    adjustCharacterWalletLPBalanceDurable(characterID, issuerCorpID, delta, options = {}) {
      if (issuerCorpID === 4242) return { success: false, errorMsg: "INVALID_OWNER_OR_ISSUER" };
      const fp = JSON.stringify({ kind: "character", ownerID: characterID, issuerCorpID, delta });
      const r = receipts.get(options.idempotencyKey);
      if (r) {
        if (r.fp !== fp) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
        return api.mode === "flushFail" ? { success: false, ambiguous: true, errorMsg: "LP_WALLET_FLUSH_FAILED" }
          : { success: true, data: r.data, duplicate: true };
      }
      const k = `${characterID}:${issuerCorpID}`;
      balances.set(k, (balances.get(k) || 0) + delta);
      receipts.set(options.idempotencyKey, { fp, data: { amount: balances.get(k) }, changeType: options.changeType });
      if (api.mode === "flushFail") return { success: false, ambiguous: true, errorMsg: "LP_WALLET_FLUSH_FAILED" };
      return { success: true, data: { amount: balances.get(k) } };
    },
  };
  return { api, balances, receipts };
}

const iskSpec = (over = {}) => ({ characterId: CHAR, amountIsk: 5000, commandId: KEY, issuerCorporationId: CORP,
  systemId: SYS, description: "Living New Eden: liberation of Jita", ...over });

module.exports = ({ test }) => {
  test("PRW1 ISK reward: vendor options + metadata.commandID, flush after success and duplicate, one credit, codes "
    + "mapped; the same through the real adapter facade", async () => {
    const balances = new Map([[CHAR, 100]]);
    const w = fakeWallet(balances);
    const gs = fakeGameStore();
    let r = await creditRewardIskFrom(w.api, gs.api, iskSpec());
    assert.deepStrictEqual(r, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.deepStrictEqual(w.calls[0], { charId: CHAR, amount: 5000, options: { idempotencyKey: KEY, entryTypeID: 99,
      ownerID1: CORP, ownerID2: CHAR, referenceID: SYS, description: "Living New Eden: liberation of Jita" },
    metadata: { commandID: KEY, source: "lne-liberation" } });
    assert.deepStrictEqual(gs.flushes, ["characters"]);
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec());
    assert.deepStrictEqual([r.ok, r.duplicate, balances.get(CHAR), gs.flushes.length], [true, true, 5100, 2]);
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ amountIsk: 6000 }));
    assert.deepStrictEqual([r.ok, r.reason, r.permanent, r.detail], [false, "WALLET_KEY_INVALID", true,
      "IDEMPOTENCY_KEY_REUSED"]);
    const n = w.calls.length;
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ characterId: 4242, commandId: "lne:libpay:x:isk" }));
    assert.deepStrictEqual([r.reason, r.permanent], ["CHARACTER_NOT_FOUND", true]);
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ amountIsk: MAX_CHARACTER_BALANCE, commandId: "lne:y" }));
    assert.deepStrictEqual([r.reason, r.permanent], ["BALANCE_LIMIT", true]);
    assert.strictEqual(w.calls.length, n, "prechecks never call the vendor");
    assert.deepStrictEqual(await creditRewardIskFrom(w.api, gs.api, iskSpec({ commandId: "libpay:1" })),
      { ok: false, reason: "WALLET_KEY_INVALID", permanent: true });
    assert.deepStrictEqual(await creditRewardIskFrom({}, gs.api, iskSpec()),
      { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false });
    gs.api.mode = "fail";
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ commandId: "lne:z:isk" }));
    assert.deepStrictEqual([r.reason, r.permanent, r.detail], ["FLUSH_FAILED", false, "SQLITE_BUSY"]);
    gs.api.mode = "throw";
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ commandId: "lne:z:isk" }));
    assert.deepStrictEqual([r.reason, r.permanent], ["FLUSH_FAILED", false]);
    gs.api.mode = "ok";
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ commandId: "lne:z:isk" }));
    assert.deepStrictEqual([r.ok, r.duplicate, balances.get(CHAR)], [true, true, 10100]);
    w.api.mode = "fail";
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ commandId: "lne:w:isk" }));
    assert.deepStrictEqual([r.reason, r.permanent, r.detail], ["WALLET_FAILED", false, "WRITE_ERROR"]);

    const SRC = path.join(path.sep, "x", "server", "src");
    const at = (rel) => path.join(SRC, `${rel}.js`);
    const w2 = fakeWallet(new Map([[CHAR, 0]]));
    const gs2 = fakeGameStore();
    const lp2 = fakeLp();
    const adapter = createAdapter({ moduleApi: { _cache: { [at("services/account/walletState")]: { exports: w2.api },
      [at("gameStore/index")]: { exports: gs2.api },
      [at("services/corporation/lpWalletState")]: { exports: lp2.api } } } });
    assert.deepStrictEqual(adapter.rewardSeams().ok, false, "no server src -> seams missing");
    assert.strictEqual((await adapter.rewardCreditIsk(iskSpec())).reason, "SEAM_UNAVAILABLE");
    assert.ok(adapter.setServerSrc(SRC).ok);
    assert.deepStrictEqual(adapter.rewardSeams(), { ok: true });
    assert.deepStrictEqual(await adapter.rewardCreditIsk(iskSpec()), { ok: true, duplicate: false,
      fingerprintMismatch: false });
    assert.deepStrictEqual(adapter.rewardCreditLp({ characterId: CHAR, amountLp: 40, issuerCorporationId: CORP,
      commandId: "lne:a:lp" }), { ok: true, duplicate: false });
    assert.deepStrictEqual(gs2.flushes, ["characters"]);
  });

  test("PRW2 LP reward: duplicate, ambiguous -> transient LP_AMBIGUOUS, key reuse -> permanent, bad issuer -> "
    + "permanent", () => {
    const lp = fakeLp();
    const spec = { characterId: CHAR, amountLp: 300, issuerCorporationId: CORP, commandId: "lne:libpay:1:0:5:9:lp" };
    assert.deepStrictEqual(creditRewardLpFrom(lp.api, spec), { ok: true, duplicate: false });
    assert.strictEqual(lp.receipts.get(spec.commandId).changeType, "reward");
    assert.deepStrictEqual(creditRewardLpFrom(lp.api, spec), { ok: true, duplicate: true });
    assert.strictEqual(lp.balances.get(`${CHAR}:${CORP}`), 300, "one credit");
    lp.api.mode = "flushFail";
    let r = creditRewardLpFrom(lp.api, { ...spec, commandId: "lne:b:lp" });
    assert.deepStrictEqual([r.ok, r.reason, r.permanent], [false, "LP_AMBIGUOUS", false]);
    lp.api.mode = "ok";
    assert.deepStrictEqual(creditRewardLpFrom(lp.api, { ...spec, commandId: "lne:b:lp" }), { ok: true,
      duplicate: true }, "the retry of an ambiguous write is a duplicate");
    assert.strictEqual(lp.balances.get(`${CHAR}:${CORP}`), 600);
    r = creditRewardLpFrom(lp.api, { ...spec, amountLp: 301 });
    assert.deepStrictEqual([r.reason, r.permanent, r.detail], ["WALLET_KEY_INVALID", true, "IDEMPOTENCY_KEY_REUSED"]);
    r = creditRewardLpFrom(lp.api, { ...spec, issuerCorporationId: 4242, commandId: "lne:c:lp" });
    assert.deepStrictEqual([r.reason, r.permanent], ["INVALID_OWNER_OR_ISSUER", true]);
    r = creditRewardLpFrom(lp.api, { ...spec, issuerCorporationId: null });
    assert.deepStrictEqual([r.reason, r.permanent], ["INVALID_OWNER_OR_ISSUER", true]);
    assert.deepStrictEqual(creditRewardLpFrom(null, spec), { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false });
  });

  test("FP5: spec.source -> metadata.source, default lne-liberation; vendor fact: "
    + "metadata is not in the ISK fingerprint", async () => {
    const w = fakeWallet(new Map([[CHAR, 0]]));
    const gs = fakeGameStore();
    let r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ commandId: "lne:fj:1:0:5:9:isk",
      source: "lne-frontjobs", issuerCorporationId: null }));
    assert.deepStrictEqual(r, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.deepStrictEqual([w.calls[0].metadata, w.calls[0].options.ownerID1],
      [{ commandID: "lne:fj:1:0:5:9:isk", source: "lne-frontjobs" }, 0]);
    r = await creditRewardIskFrom(w.api, gs.api, iskSpec({ source: "" }));
    assert.ok(r.ok);
    assert.strictEqual(w.calls[1].metadata.source, "lne-liberation", "empty source -> default");
    const wallet = path.join(__dirname, "..", "..", "..", "..", "server", "src", "services", "account",
      "walletState.js");
    if (!fs.existsSync(wallet)) return;
    const text = fs.readFileSync(wallet, "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("\nfunction buildWalletAdjustmentFingerprint(");
    assert.ok(start >= 0, "buildWalletAdjustmentFingerprint");
    const body = text.slice(start, text.indexOf("\nfunction ", start + 1));
    assert.ok(body.includes("JSON.stringify({") && !/metadata|source/.test(body),
      "the ISK fingerprint has no metadata / source field");
  });
};
