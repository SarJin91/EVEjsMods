"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { ID_PREFIXES, isId } = require("../../lib/util/ids");
const { createJournal } = require("../../lib/persistence/journal");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { harness: H } = require("../battle/settlement.test");

const LIB_DIR = path.resolve(__dirname, "..", "..", "lib");
const CALL_RE = /\bids\.next\(\s*["'`]([^"'`]*)["'`]/g;
const F = 500019;

function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.isFile() && e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

module.exports = ({ test, skip }) => {
  test("IP1 createOfferInTx with the real createIdGenerator: ok, offerId is a \"to\" id", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const at = shared.clock.now();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock: shared.clock });
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const funded = tx((db) => budgets.fundInTx(db, { factionId: F, units: 100, paidUntilTo: at, iskPerUnit: 1000,
        capIsk: 1000000, at }, "ip:fund"));
      assert.ok(funded.ok, JSON.stringify(funded));
      const spec = { factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
        itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 1000, unitPriceMilli: 1100,
        iskTotal: 1100, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid",
        expiresAt: at + 86400000, at };
      const r = tx((db) => offers.createOfferInTx(db, spec, "ip:1:offer"));
      assert.ok(r.ok && !r.duplicate && r.offer, JSON.stringify(r));
      assert.ok(isId(r.offer.offerId, "to"), `offerId ${r.offer.offerId}`);
    });
  });

  test("IP2 every literal ids.next(\"<x>\") in lib/ has its prefix in ID_PREFIXES", () => {
    const used = new Map();
    for (const file of jsFiles(LIB_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      for (const m of src.matchAll(CALL_RE)) {
        if (!used.has(m[1])) used.set(m[1], path.relative(LIB_DIR, file));
      }
    }
    assert.ok(used.has("to") && used.has("fleet"), `scan found: ${[...used.keys()].join(",")}`);
    const missing = [...used].filter(([p]) => !ID_PREFIXES.includes(p)).map(([p, f]) => `${p} (${f})`);
    assert.deepStrictEqual(missing, [], `prefixes missing from ID_PREFIXES: ${missing.join(", ")}`);
  });
};
