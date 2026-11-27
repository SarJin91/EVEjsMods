"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");

const F = 500019;
const CORP = 999999;
const CHAR = 90000123;
const VCORP = 98000001;
const AT = 1000000;
const CLOCK = { now: () => AT };

let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

function repos() {
  const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: CLOCK });
  const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
  return { journal, budgets, offers };
}

function offerSpec(itemKey, typeId) {
  return {
    factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: CORP, itemKind: "mineral",
    itemKey, typeId, quantity: 1000, unitPriceMilli: 1100, iskTotal: 1100, refPriceMilli: 1000,
    capPriceMilli: 1960, priceSource: "bid", expiresAt: AT + 259200000, at: AT,
  };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("MI1 migration 31: 30 -> 31 keeps old offer rows with NULL issuer columns; from zero columns + issuer_open index", async () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 31);
    assert.deepStrictEqual([MIGRATIONS[30].version, MIGRATIONS[30].name], [31, "world_trade_issuer"]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m31-"));
    const file = path.join(tmp, "world.sqlite");
    const stores = [];
    const open = (migrations) => {
      const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      stores.push(o.store);
      return o;
    };
    const tx = (store, fn) => { const r = store.transaction("t", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    try {
      const old = open(MIGRATIONS.slice(0, 30));
      assert.strictEqual(old.schemaVersion, 30);
      const offerId = "to_mi1";
      tx(old.store, (db) => db.prepare(`INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id,
          issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli,
          cap_price_milli, price_source, state, state_seq, end_reason, contract_id, acceptor_character_id,
          assignee_character_id, standing_bonus_permille, delivered_quantity, created_at, expires_at, updated_at,
          ended_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        offerId, F, "npc-1", 30000001, CORP, "mineral", "type:34", 34, 1000, 1100, 1100, 1000,
        1960, "bid", "OPEN", 2, null, 777001, null,
        null, 0, 0, AT, AT + 259200000, AT,
        null, 3));
      old.store.close("upgrade");

      const up = open(MIGRATIONS);
      assert.deepStrictEqual([up.schemaVersion, up.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 30]);
      const row = tx(up.store, (db) => db.prepare(
        "SELECT issuer_character_id, issuer_character_corp_id FROM world_trade_offers WHERE offer_id = ?").get(offerId));
      assert.deepStrictEqual({ ...row }, { issuer_character_id: null, issuer_character_corp_id: null });
      const r1 = repos();
      const offer = tx(up.store, (db) => r1.offers.getOffer(db, offerId)).offer;
      assert.deepStrictEqual([offer.issuerCharacterId, offer.issuerCharacterCorpId], [null, null]);
      const index = tx(up.store, (db) => db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'world_trade_offers_issuer_open'").get());
      assert.ok(index && /issuer_character_id IS NOT NULL/.test(index.sql), JSON.stringify(index));
      up.store.close("test");
    } finally {
      for (const s of stores) { try { s.close("test"); } catch (_err) {} }
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }

    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      assert.strictEqual(opened.schemaVersion, LATEST_SCHEMA_VERSION);
      const info = tx(opened.store, (db) => ({
        cols: db.prepare("PRAGMA table_info(world_trade_offers)").all().map((c) => c.name),
        idx: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'world_trade_offers'").all()
          .map((r) => r.name),
        ddl: db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'world_trade_offers'").get().sql,
      }));
      assert.ok(info.cols.includes("issuer_character_id") && info.cols.includes("issuer_character_corp_id"), info.cols.join(","));
      assert.ok(info.idx.includes("world_trade_offers_issuer_open"), info.idx.join(","));
      assert.ok(info.ddl.includes("issuer_character_id IS NULL OR issuer_character_id > 0"), "CHECK > 0");
      assert.ok(info.ddl.includes("issuer_character_corp_id IS NULL OR issuer_character_corp_id > 0"), "CHECK > 0");
    }, { fresh: true });
  });

  needsDriver("MI2 repository: issuer patch with one field -> TRADE_INVALID_INPUT, both -> stored, listIssuerCharacterIds", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const tx = (fn) => { const r = opened.store.transaction("t", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    const { budgets, offers } = repos();
    tx((db) => budgets.fundInTx(db, { factionId: F, units: 100, paidUntilTo: AT, iskPerUnit: 1000, capIsk: 1000000, at: AT }, "fund:1"));
    const offer = tx((db) => offers.createOfferInTx(db, offerSpec("type:35", 35), "ik:mi2:offer")).offer;
    const issue = (patch, seqKey) => tx((db) => offers.transitionOfferInTx(db, { offerId: offer.offerId, expectedVersion: 1,
      from: S.PLANNED, to: S.ISSUING, reason: "", at: AT, patch: { expiresAt: AT + 1000, ...patch } }, seqKey));

    const one = issue({ issuerCharacterId: CHAR }, "k1");
    assert.deepStrictEqual([one.ok, one.reason, one.detail], [false, "TRADE_INVALID_INPUT", "issuer_character_pair"]);
    const other = issue({ issuerCharacterId: null, issuerCharacterCorpId: VCORP }, "k2");
    assert.deepStrictEqual([other.ok, other.reason], [false, "TRADE_INVALID_INPUT"]);
    const bad = issue({ issuerCharacterId: -5, issuerCharacterCorpId: VCORP }, "k3");
    assert.deepStrictEqual([bad.ok, bad.reason, bad.detail], [false, "TRADE_INVALID_INPUT", "issuer_character_ids"]);
    assert.strictEqual(tx((db) => offers.getOffer(db, offer.offerId)).offer.state, S.PLANNED, "refusals wrote nothing");

    const both = issue({ issuerCharacterId: CHAR, issuerCharacterCorpId: VCORP }, S.transitionKey(offer.offerId, 1, S.ISSUING));
    assert.ok(both.ok, JSON.stringify(both));
    assert.deepStrictEqual([both.offer.state, both.offer.issuerCharacterId, both.offer.issuerCharacterCorpId,
      both.offer.issuerCorporationId], [S.ISSUING, CHAR, VCORP, CORP]);
    assert.deepStrictEqual(tx((db) => offers.listIssuerCharacterIds(db)), { ok: true, characterIds: [CHAR] });
  }));
};
