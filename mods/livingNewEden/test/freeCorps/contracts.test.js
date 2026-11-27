"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createManualClock } = require("../../lib/util/clock");
const { buildContractGoods } = require("../../lib/freeCorps/contractGoods");
const { planContract, priceLot } = require("../../lib/freeCorps/contracts");
const contractModule = require("../../lib/freeCorps/contractRepository");
const outboxModule = require("../../lib/freeCorps/outboxRepository");
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const { createFreeCorpVentureRepository } = require("../../lib/freeCorps/ventureRepository");
const { createContractPump } = require("../../lib/freeCorps/contractPump");
const { createKillmailPump } = require("../../lib/freeCorps/killmailPump");
const { runOrphanScan } = require("../../lib/economy/trade/orphans");
const { findTradeContractFrom } = require("../../lib/adapter/tradeContracts");
const { loadDriver, withStore, withStoreAsync } = require("../notices/storeHelper");
const H = require("./hunting.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const IC = require("../../lib/economy/data/industryCatalog");
const MP = require("../../lib/economy/data/mineralRefPrices");
const HT = require("../../lib/economy/data/hullTradeTypes");
const GOODS = buildContractGoods({ oreBands: IC.ORE_BANDS, oreTypes: require("../../lib/economy/data/oreTypes").ORE_TYPES,
  refPriceMilli: MP.REF_PRICE_MILLI, hullValueFactorPermille: MP.HULL_VALUE_FACTOR_PERMILLE,
  hullGroups: require("../../lib/economy/data/hullRecipes").GROUPS, hullRaces: HT.RACES, factionRace: HT.FACTION_RACE,
  hullGroupKeys: ["frigate", "destroyer"] });
const ORE_IDS = new Set(Object.values(GOODS.ok ? GOODS.goods.ores : {}).flat().map((r) => r.typeId));
const portionOf = (typeId) => (ORE_IDS.has(typeId) ? 100 : 1);
const CEO = 98000003;

function fakeVendor() {
  const v = { grants: [], creates: [], finds: 0, reads: 0, deletes: [], voids: [], receipts: new Map(),
    contracts: new Map(), hangar: new Map(), nextItem: 5001, nextContract: 9001, createResult: null };
  v.adapter = {
    readItemTypeFacts: (ids) => ({ ok: true, missing: [], facts: new Map(ids.map((id) => [id,
      { typeId: id, name: `Type ${id}`, volume: 1, portionSize: portionOf(id) }])) }),
    tradeGrantStock(spec) {
      v.grants.push(spec.key);
      if (v.receipts.has(spec.key)) return { ok: true, duplicate: true, itemIds: v.receipts.get(spec.key).itemIds };
      const itemId = v.nextItem;
      v.nextItem += 1;
      v.hangar.set(itemId, { typeId: spec.typeId, quantity: spec.quantity });
      v.receipts.set(spec.key, { quantity: spec.quantity, itemIds: [itemId] });
      return { ok: true, duplicate: false, itemIds: [itemId] };
    },
    tradeGrantReceipt: (key) => (v.receipts.has(key)
      ? { ok: true, found: true, quantity: v.receipts.get(key).quantity, itemIds: v.receipts.get(key).itemIds }
      : { ok: true, found: false, quantity: 0, itemIds: [] }),
    async tradeCreateSellContract(p) {
      v.creates.push(p);
      if (v.createResult) return v.createResult;
      const items = p.grantItemIds.filter((id) => v.hangar.has(id)).map((id) => [id, v.hangar.get(id)]);
      for (const [id] of items) v.hangar.delete(id);
      const id = v.nextContract;
      v.nextContract += 1;
      v.contracts.set(id, { status: "OUTSTANDING", offerId: p.offerId, items, price: p.priceIsk });
      return { ok: true, contractId: id };
    },
    tradeFindContract({ offerId }) {
      v.finds += 1;
      for (const [id, c] of v.contracts) if (c.offerId === offerId) return { ok: true, found: "record", contractId: id };
      return { ok: true, found: null };
    },
    tradeReadContract(id) {
      v.reads += 1;
      const c = v.contracts.get(id);
      return { ok: true, contract: c ? { status: c.status, pendingKind: null } : null };
    },
    async tradeDeleteContract({ contractId }) {
      v.deletes.push(contractId);
      const c = v.contracts.get(contractId);
      c.status = "DELETED";
      for (const [id, it] of c.items) v.hangar.set(id, it);
      return { ok: true, deleted: true };
    },
    tradeListDeliveredStacks: ({ typeId }) => ({ ok: true, stacks: [...v.hangar].filter(([, it]) => it.typeId === typeId)
      .map(([itemId, it]) => ({ itemId, quantity: it.quantity })).sort((a, b) => a.itemId - b.itemId) }),
    tradeVoidStack(spec) {
      v.voids.push(spec.key);
      if (!v.hangar.has(spec.itemId)) return { ok: false, reason: "ITEM_MISSING", permanent: true, ambiguous: false };
      v.hangar.delete(spec.itemId);
      return { ok: true, outcome: "VOIDED" };
    },
  };
  return v;
}

function cfgCt(over = {}) {
  const c = H.cfgOf();
  return { ...c, freeCorps: { ...c.freeCorps, contracts: { ...c.freeCorps.contracts, enabled: true,
    issueChancePermille: 1000, ...over } } };
}

function seedMiner(opened, { yieldIsk = 40000000, kind = "MINE" } = {}) {
  H.seedCorp(opened, { corpId: 2, archetype: kind === "BUILD" ? "industrialist" : "miner", seed: 777 });
  const repo = createFreeCorpVentureRepository();
  const row = { venture_id: "fcv:2:1", corp_id: 2, seq: 1, kind, state: "RETURNING", open: 1, home_system_id: H.L1,
    system_id: H.L2, target_system_id: H.L2, target_station_id: null, sec_band: "lowsec", jumps: 1, crew: 5,
    crew_lost: 0, step: 4, travel_steps: 1, work_steps: 3, steps_total: 5, holds: 0, yield_isk: yieldIsk,
    cost_isk: 0, started_at: H.T0 - 1000, step_due_at: H.T0, updated_at: H.T0 - 1000, ended_at: null, end_reason: null,
    version: 1, wh_route: null, wh_entry_system_id: null, stranded_steps: 0 };
  const r = opened.store.transaction("t.v", (db) => repo.insertInTx(db, row, row.updated_at));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function bootCt(opened, cfg, extra = {}) {
  const calls = { seams: 0 };
  const vendor = fakeVendor();
  const env = H.boot(opened, { cfg, extra: { contractGoods: () => GOODS, contractAdapter: () => vendor.adapter,
    freeCorpsContractSeams: () => { calls.seams += 1; return { ok: true }; },
    addContractAcceptedListener: () => ({ ok: false, reason: "TEST" }), ...extra } });
  env.vc.identities.set(2, H.linked(5, 98000002));
  return { ...env, calls, vendor };
}

const ctRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_contracts ORDER BY contract_key");
const obRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_outbox ORDER BY key");
const corpOf = (opened, id) => H.all(opened, "SELECT * FROM world_free_corps WHERE corp_id = ?", id)[0];

function pumpOf(opened, { clock, vendor, S, contracts, mode = "RUN", counters = {} }) {
  return { counters, pump: createContractPump({ store: opened.store, outbox: outboxModule.createFreeCorpOutboxRepository(),
    contracts: contracts || contractModule.createFreeCorpContractRepository(), corps: createFreeCorpRepository(), clock,
    nowMs: () => 0, adapter: () => vendor.adapter, seams: () => ({ ok: true }), goods: () => GOODS.goods,
    getGovernor: () => null, workClass: "MAINTENANCE", isRunning: () => true,
    bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, metric: () => {}, log: () => {},
    setTimer: () => ({ cancel() {}, hasRef: () => false }), S,
    retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 }, mode }) };
}

function planned(opened, over = {}) {
  seedMiner(opened, over.seed || {});
  const cfg = cfgCt(over.contracts || {});
  const env = bootCt(opened, cfg);
  H.pass(env);
  env.fc.stop();
  const rows = ctRows(opened);
  assert.strictEqual(rows.length, 1, JSON.stringify(env.fc.getStatus().counters));
  return { S: cfg.freeCorps.contracts, row: rows[0], cfg };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("CT2 goods catalogue on the economy data, planContract deterministic per kind, priceLot bounds", () => {
    assert.ok(GOODS.ok, JSON.stringify(GOODS));
    const g = GOODS.goods;
    assert.ok(g.typeIds.length > 0 && g.typeIds.length <= 64, String(g.typeIds.length));
    const all = [...Object.values(g.ores).flat().map((r) => r.portionPriceMilli),
      ...Object.values(g.minerals).flat().map((r) => r.unitPriceMilli),
      ...Object.values(g.hulls).flat().map((r) => r.unitPriceMilli)];
    assert.ok(all.length > 0 && all.every((p) => Number.isSafeInteger(p) && p > 0));
    const veld = g.ores.highsec.find((r) => r.typeId === 1230);
    const unitIsk = veld.portionPriceMilli / 100 / 1000;
    assert.ok(unitIsk >= 5 && unitIsk <= 50, `Veldspar ${unitIsk} ISK a unit`);
    assert.strictEqual(g.ores.wormhole, undefined, "no ores in J-space");

    const S = { ...H.cfgOf().freeCorps.contracts, issueChancePermille: 1000 };
    const corp = { corp_id: 2, seed: 777, sec_band: "lowsec", home_station_id: 60000011, home_system_id: H.L1,
      race_faction_id: 500001 };
    const identity = H.linked(5, 98000002);
    const v = (kind, seq) => ({ venture_id: `fcv:2:${seq}`, seq, kind, sec_band: "lowsec" });
    const input = (kind, seq, payout = 40000000, c = corp) => ({ corp: c, venture: v(kind, seq), identity, goods: g, S,
      payout, now: H.T0 });
    assert.deepStrictEqual(planContract(input("MINE", 1)), planContract(input("MINE", 1)));
    const mined = new Set();
    for (let seq = 1; seq <= 40; seq += 1) {
      const p = planContract(input("MINE", seq));
      assert.ok(p.ok, JSON.stringify(p));
      mined.add(p.row.goods);
      assert.strictEqual(p.row.lot_isk, 10000000, "min(lotMaxIsk, 40 M x 250 / 1000)");
      assert.deepStrictEqual([p.row.contract_key, p.outbox.key, p.outbox.kind], [`fcc:2:${seq}`, `lne:fc:ct:fcv:2:${seq}`,
        "CONTRACT_WTS"]);
    }
    assert.deepStrictEqual([...mined].sort(), ["MINERAL", "ORE"]);
    const b = planContract(input("BUILD", 3));
    assert.ok(b.ok && b.row.goods === "HULL" && g.hulls["1"].some((h) => h.typeId === b.row.type_id));
    const odd = planContract(input("BUILD", 3, 40000000, { ...corp, race_faction_id: 123 }));
    assert.ok(odd.ok && g.hulls["1"].some((h) => h.typeId === odd.row.type_id), "unknown race -> the lowest race");
    assert.deepStrictEqual(planContract(input("RAT", 1)), { ok: false, reason: "NOT_ELIGIBLE" });
    assert.deepStrictEqual(planContract(input("MINE", 1, 1000000)), { ok: false, reason: "SMALL_LOT" });
    assert.deepStrictEqual(planContract({ ...input("MINE", 1), identity: { ok: true, state: "PENDING" } }),
      { ok: false, reason: "NO_IDENTITY" });

    for (const [lotIsk, factor] of [[100000, 500], [10000000, 950], [1000000000, 2000]]) {
      const SS = { ...S, priceFactorPermille: factor };
      for (const [goods, entry, portion] of [["ORE", veld, 100],
        ["MINERAL", g.minerals.highsec.find((r) => r.typeId === 34), 1], ["HULL", g.hulls["1"][0], 1]]) {
        const p = priceLot({ goods, entry, lotIsk, portionSize: portion, S: SS });
        if (goods === "HULL" && lotIsk < entry.unitPriceMilli / 1000) {
          assert.deepStrictEqual(p, { ok: false, reason: "SMALL_LOT" }, "a lot below one hull");
          continue;
        }
        assert.ok(p.ok, `${goods} ${lotIsk} ${JSON.stringify(p)}`);
        assert.ok(Number.isSafeInteger(p.quantity) && Number.isSafeInteger(p.priceIsk) && p.priceIsk > 0);
        assert.ok(p.priceIsk <= Math.floor(lotIsk * factor / 1000) + 1, `${goods} price ${p.priceIsk}`);
        if (goods === "ORE") assert.strictEqual(p.quantity % 100, 0);
      }
    }
    assert.strictEqual(priceLot({ goods: "ORE", entry: veld, lotIsk: 1000, portionSize: 100, S }).reason, "SMALL_LOT");
    assert.strictEqual(priceLot({ goods: "ORE", entry: veld, lotIsk: 1e7, portionSize: null, S }).reason, "NO_PORTION");
  });

  needsDriver("CT3 a DONE MINE venture plans one contract + outbox row in the pass; replay; maxOpen / maxPerCorp "
    + "flag off = no row, no seam call", () => {
    withStore(driver, (opened) => {
      seedMiner(opened);
      const env = bootCt(opened, cfgCt());
      const st = H.pass(env);
      const rows = ctRows(opened);
      assert.strictEqual(rows.length, 1, JSON.stringify(st.counters));
      const c = rows[0];
      assert.deepStrictEqual([c.contract_key, c.outbox_key, c.state, c.open, c.station_id, c.issuer_character_id,
        c.issuer_corporation_id, c.lot_isk, c.quantity, c.price_isk], ["fcc:2:1", "lne:fc:ct:fcv:2:1", "PLANNED", 1,
        60000011, CEO, 98000002, 10000000, null, null]);
      const ob = obRows(opened);
      assert.deepStrictEqual(ob.map((r) => [r.key, r.kind, r.state, JSON.parse(r.payload)]),
        [["lne:fc:ct:fcv:2:1", "CONTRACT_WTS", "PENDING", { v: 1, contractKey: "fcc:2:1" }]]);
      assert.deepStrictEqual([st.counters.ctPlanned, env.calls.seams], [1, 1]);
      assert.deepStrictEqual(Object.keys(st.contracts).sort(), ["enabled", "hook", "lastIssueMs", "mode", "open", "seam"]);
      H.pass(env);
      assert.strictEqual(ctRows(opened).length, 1, "still one row");
      env.fc.stop();
    });
    const limited = (contracts, preCorp, typeId) => withStore(driver, (opened) => {
      seedMiner(opened);
      const repo = contractModule.createFreeCorpContractRepository();
      const pre = { contract_key: `fcc:${preCorp}:9`, outbox_key: `lne:fc:ct:fcv:${preCorp}:9`,
        venture_id: `fcv:${preCorp}:9`, corp_id: preCorp, kind: "WTS", goods: "ORE", state: "PLANNED", open: 1,
        type_id: typeId, station_id: 60000011, system_id: H.L1, issuer_character_id: 5, issuer_corporation_id: 6,
        lot_isk: 1000000, created_at: H.T0 - 1 };
      const w = opened.store.transaction("t.pre", (db) => repo.insertPlannedInTx(db, pre));
      assert.ok(w.ok && w.value.ok, JSON.stringify(w));
      const env = bootCt(opened, cfgCt(contracts));
      const st = H.pass(env);
      env.fc.stop();
      assert.strictEqual(ctRows(opened).length, 1, "no new row");
      return st.counters;
    });
    assert.strictEqual(limited({ maxOpen: 1 }, 9, 34).ctSkipFull, 1);
    assert.strictEqual(limited({ maxPerCorp: 1 }, 2, 999999).ctSkipCorpFull, 1);
    const real = contractModule.createFreeCorpContractRepository;
    let created = 0;
    let calls = 0;
    contractModule.createFreeCorpContractRepository = () => {
      created += 1;
      const r = real();
      return Object.fromEntries(Object.entries(r).map(([k, fn]) => [k, (...a) => { calls += 1; return fn(...a); }]));
    };
    try {
      withStore(driver, (opened) => {
        seedMiner(opened);
        const env = bootCt(opened, cfgCt({ enabled: false }));
        const atStart = calls;
        const st = H.pass(env);
        env.fc.stop();
        assert.deepStrictEqual([ctRows(opened).length, obRows(opened).length], [0, 0]);
        assert.deepStrictEqual([created, atStart, calls, env.calls.seams], [1, 1, 1, 0], "one COUNT at the start");
        assert.strictEqual("contracts" in st, false);
        assert.strictEqual(st.counters.ventureDone, 1, "the venture closed as before");
      });
    } finally {
      contractModule.createFreeCorpContractRepository = real;
    }
  });

  needsDriver("CT4 pump: OPEN without find, a crash after the create is found by the next pump, a permanent "
    + "refusal returns the granted goods; the killmail pump ignores contract rows; queue indexes", async () => {
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      const p1 = pumpOf(opened, { clock, vendor, S });
      return p1.pump.runNow().then((r) => {
        assert.deepStrictEqual([r.ok, r.issued], [true, "issued"], JSON.stringify(r));
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, c.vendor_contract_id, c.expires_at, c.next_check_at],
          ["OPEN", 9001, H.T0 + 1000 + S.contractTtlMs, H.T0 + 1000 + S.pollMs]);
        assert.ok(c.quantity > 0 && c.price_isk > 0 && c.price_isk <= Math.floor(c.lot_isk * S.priceFactorPermille
          / 1000) + 1);
        assert.strictEqual(vendor.finds, 0, "attempts 1: no find");
        assert.deepStrictEqual([obRows(opened)[0].state, obRows(opened)[0].result_id], ["DONE", 9001]);
        const p = vendor.creates[0];
        assert.deepStrictEqual([p.issuerKind, p.ownerId, p.accountKey, p.npcStationId, p.minutesExpire],
          ["character", CEO, 1000, 60000011, Math.ceil(S.contractTtlMs / 60000)]);
        assert.ok(p.description.endsWith("[LNE:fcc:2:1]"), p.description);
      });
    });
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      const real = contractModule.createFreeCorpContractRepository();
      const broken = { ...real, openInTx: () => { throw new Error("crash before settle"); } };
      const counters = {};
      return pumpOf(opened, { clock, vendor, S, contracts: broken }).pump.runNow().then((r1) => {
        assert.strictEqual(r1.issued, "SETTLE_FAILED");
        assert.deepStrictEqual([ctRows(opened)[0].state, obRows(opened)[0].attempts], ["ISSUING", 1]);
        const fresh = pumpOf(opened, { clock, vendor, S, counters }).pump;
        return fresh.runNow().then((r2) => {
          assert.strictEqual(r2.issued, null, "the gap issueSpacingMs");
          assert.strictEqual(counters.ctSpacing, 1);
          clock.set(H.T0 + 1000 + S.issueSpacingMs);
          return fresh.runNow();
        }).then((r3) => {
          assert.strictEqual(r3.issued, "issued");
          assert.deepStrictEqual([ctRows(opened)[0].state, ctRows(opened)[0].vendor_contract_id], ["OPEN", 9001]);
          assert.deepStrictEqual([vendor.contracts.size, vendor.finds, counters.ctFound], [1, 1, 1]);
          assert.ok(vendor.grants.length <= 2 && vendor.grants.every((k) => k === "lne:fc:ct:fcv:2:1:grant"));
        });
      });
    });
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      vendor.createResult = { ok: false, reason: "SELL_STACK_SHORT", permanent: true, detail: "short:1" };
      const { pump, counters } = pumpOf(opened, { clock, vendor, S });
      return pump.runNow().then((r) => {
        assert.strictEqual(r.issued, "failed");
        assert.deepStrictEqual([ctRows(opened)[0].state, obRows(opened)[0].state], ["ISSUING", "FAILED"]);
        return pump.runNow();
      }).then(() => {
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, JSON.parse(c.return_plan)], ["RETURNING", [{ itemId: 5001,
          quantity: c.quantity }]]);
        return pump.runNow();
      }).then(() => {
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, c.open, c.end_reason], ["CLOSED", 0, "ISSUE_FAILED"]);
        assert.deepStrictEqual(vendor.voids, ["lne:fc:ct:fcv:2:1:void:5001"]);
        assert.strictEqual(vendor.hangar.size, 0, "the granted goods are gone");
        assert.deepStrictEqual([counters.ctIssueFailed, counters.ctReturned, counters.ctClosed], [1, 1, 1]);
      });
    });
    withStore(driver, (opened) => {
      planned(opened);
      const km = createKillmailPump({ store: opened.store, outbox: outboxModule.createFreeCorpOutboxRepository(),
        clock: createManualClock(H.T0 + 1000), nowMs: () => 0, writeVirtualKillmail: () => { throw new Error("never"); },
        virtualKillmailSeams: () => ({ ok: true }), getGovernor: () => null, workClass: "MAINTENANCE",
        isRunning: () => true, S: { ...H.cfgOf().freeCorps.killmails, enabled: true },
        retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 },
        setTimer: () => ({ cancel() {}, hasRef: () => false }) });
      assert.strictEqual(km.runNow().reason, "IDLE");
      assert.deepStrictEqual([obRows(opened)[0].state, obRows(opened)[0].attempts], ["PENDING", 0]);
      const ob = outboxModule.createFreeCorpOutboxRepository();
      const ct = contractModule.createFreeCorpContractRepository();
      const plans = opened.store.transaction("t.plan", (db) => {
        const seen = [];
        const spy = { prepare: (sql) => { seen.push(sql); return db.prepare(sql); } };
        ob.nextDueInTx(spy, { kind: "CONTRACT_WTS", now: H.T0 });
        ct.listDueChecksInTx(spy, { now: H.T0, limit: 8 });
        const plan = (sql, args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(" | ");
        return { next: plan(seen.find((s) => s.includes("next_at <= ?")), ["CONTRACT_WTS", H.T0]),
          last: plan(seen.find((s) => s.includes("MAX(attempted_at)")), ["CONTRACT_WTS"]),
          check: plan(seen.find((s) => s.includes("next_check_at <= ?")), [H.T0, 8]) };
      });
      assert.ok(plans.ok, JSON.stringify(plans));
      assert.ok(plans.value.next.includes("world_free_corp_outbox_kind_due"), plans.value.next);
      assert.ok(plans.value.last.includes("world_free_corp_outbox_kind_attempted"), plans.value.last);
      assert.ok(plans.value.check.includes("world_free_corp_contracts_check"), plans.value.check);
    });
  });

  needsDriver("CT5 revenue once (nudge + poll), expiry -> delete -> void -> CLOSED, CLEANUP closes and stops, no "
    + "tier 2 CEO in the trade orphan sweep, reset policy, migration 78, config", async () => {
    await new Promise((resolve, reject) => {
      try {
        withStoreAsync(driver, (opened) => {
          const { S } = planned(opened);
          const clock = createManualClock(H.T0 + 1000);
          const vendor = fakeVendor();
          const { pump, counters } = pumpOf(opened, { clock, vendor, S });
          const isk0 = corpOf(opened, 2).isk;
          return pump.runNow().then(() => {
            vendor.contracts.get(9001).status = "FINISHED";
            clock.set(H.T0 + 1000 + S.pollMs);
            pump.nudge(9001);
            return pump.runNow();
          }).then(() => {
            const c = ctRows(opened)[0];
            assert.deepStrictEqual([c.state, c.open, c.revenue_isk], ["SOLD", 0, c.price_isk]);
            assert.strictEqual(corpOf(opened, 2).isk, isk0 + c.price_isk, "the price once");
            assert.deepStrictEqual([counters.ctSold, counters.ctRevenueIsk, counters.ctNudges], [1, c.price_isk, 1]);
            pump.nudge(9001);
            return pump.runNow();
          }).then(() => {
            assert.strictEqual(corpOf(opened, 2).isk, isk0 + ctRows(opened)[0].price_isk, "a second run: no credit");
            assert.strictEqual(counters.ctSold, 1);
            resolve();
          }).catch(reject);
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
    await new Promise((resolve, reject) => {
      try {
        withStoreAsync(driver, (opened) => {
          const { S } = planned(opened);
          const clock = createManualClock(H.T0 + 1000);
          const vendor = fakeVendor();
          const { pump, counters } = pumpOf(opened, { clock, vendor, S });
          return pump.runNow().then(() => {
            clock.set(ctRows(opened)[0].expires_at);
            return pump.runNow();
          }).then(() => {
            assert.deepStrictEqual(vendor.deletes, [9001]);
            assert.strictEqual(ctRows(opened)[0].state, "RETURNING");
            return pump.runNow();
          }).then(() => {
            const c = ctRows(opened)[0];
            assert.deepStrictEqual([c.state, c.end_reason], ["CLOSED", "EXPIRED"]);
            assert.deepStrictEqual(vendor.voids, ["lne:fc:ct:fcv:2:1:void:5001"]);
            assert.deepStrictEqual([counters.ctClosed, counters.ctVoidedUnits], [1, c.quantity]);
            resolve();
          }).catch(reject);
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
    await new Promise((resolve, reject) => {
      try {
        withStoreAsync(driver, (opened) => {
          const { S } = planned(opened);
          const clock = createManualClock(H.T0 + 1000);
          const vendor = fakeVendor();
          return pumpOf(opened, { clock, vendor, S }).pump.runNow().then(() => {
            const repo = contractModule.createFreeCorpContractRepository();
            const ob = outboxModule.createFreeCorpOutboxRepository();
            const w = opened.store.transaction("t.pre", (db) => [repo.insertPlannedInTx(db, { contract_key: "fcc:7:1",
              outbox_key: "lne:fc:ct:fcv:7:1", venture_id: "fcv:7:1", corp_id: 7, kind: "WTS", goods: "ORE",
              state: "PLANNED", open: 1, type_id: 1230, station_id: 60000011, system_id: H.L1, issuer_character_id: 5,
              issuer_corporation_id: 6, lot_isk: 1000000, created_at: H.T0 }), ob.enqueueInTx(db, {
              key: "lne:fc:ct:fcv:7:1", kind: "CONTRACT_WTS", payload: { v: 1, contractKey: "fcc:7:1" }, now: H.T0 })]);
            assert.ok(w.ok && w.value.every((x) => x.ok), JSON.stringify(w));
            const off = bootCt(opened, cfgCt({ enabled: false }));
            const st = off.fc.getStatus();
            off.fc.stop();
            assert.deepStrictEqual([st.contracts.enabled, st.contracts.mode], [false, "CLEANUP"]);
            const cleanup = pumpOf(opened, { clock, vendor, S, mode: "CLEANUP" });
            const loop = (n) => (n === 0 ? Promise.resolve() : cleanup.pump.runNow().then((r) => (r.cleanupDone
              ? undefined : loop(n - 1))));
            return loop(6).then(() => cleanup.counters);
          }).then((counters) => {
            const rows = ctRows(opened);
            assert.deepStrictEqual(rows.map((r) => [r.contract_key, r.state, r.end_reason]),
              [["fcc:2:1", "CLOSED", "DISABLED"], ["fcc:7:1", "CANCELLED", "DISABLED"]]);
            assert.deepStrictEqual(obRows(opened).map((r) => [r.key, r.state]),
              [["lne:fc:ct:fcv:2:1", "DONE"], ["lne:fc:ct:fcv:7:1", "FAILED"]]);
            assert.deepStrictEqual([vendor.deletes, vendor.hangar.size, counters.ctCleanupDone], [[9001], 0, 1]);
            resolve();
          }).catch(reject);
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });

    const vcSrc = fs.readFileSync(path.join(MOD_DIR, "lib", "virtualCorps", "index.js"), "utf8");
    const issuerMap = vcSrc.slice(vcSrc.indexOf("function buildIssuerMap(linked) {"));
    assert.ok(issuerMap.slice(0, 300).includes("row.owner_kind !== \"faction\""), "issuers = faction rows only");
    let spec = null;
    const vc = { listTradeIssuers: () => ({ ok: true, issuers: [{ factionId: 500001, slot: 1, corporationId: 98100001,
      characterId: 98100002 }] }), getOwnerIdentity: () => H.linked(5, 98000002) };
    await runOrphanScan({ store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
      offers: { listIssuerCorporationIds: () => ({ ok: true, corporationIds: [] }),
        listIssuerCharacterIds: () => ({ ok: true, characterIds: [] }) },
      adapter: { tradeVirtualIssuerSeams: () => ({ ok: true }), getVirtualCorps: () => vc,
        tradeListTaggedContracts: async (s) => { spec = s; return { ok: true, contracts: [], truncated: false }; } },
      config: { trade: {} }, clock: { now: () => H.T0 }, telemetry: null, logger: null, getStations: () => ({}),
      getGovernor: () => null }, true, 0);
    assert.ok(spec && spec.ownerIds.includes(98100002), JSON.stringify(spec));
    assert.ok(!spec.ownerIds.includes(CEO) && !spec.corporationIds.includes(98000002), "no tier 2 CEO / corporation");

    assert.strictEqual(TABLE_POLICY.world_free_corp_contracts, ACTION.KEEP);
    assert.ok(LATEST_SCHEMA_VERSION >= 78, "migration 79 (members) after 78");
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    const { courier: _courier, ...wtsDefaults } = def.config.freeCorps.contracts;
    assert.deepStrictEqual(wtsDefaults, { enabled: false, maxOpen: 40, maxPerCorp: 2,
      lotMaxIsk: 10000000, lotMinIsk: 500000, lotSharePermille: 250, issueChancePermille: 500,
      mineralSharePermille: 300, priceFactorPermille: 950, maxPlansPerPass: 2, contractTtlMs: 259200000,
      pumpMs: 60000, issueSpacingMs: 120000, pollMs: 600000, maxPollsPerRun: 8, maxReturnStacks: 8, maxAttempts: 5,
      backoffBaseMs: 300000, backoffMaxMs: 21600000, maxIssueAgeMs: 21600000 });
    const W = (r) => r.warnings.filter((w) => w.startsWith("freeCorps.contracts."));
    assert.deepStrictEqual(W(def), []);
    assert.strictEqual(W(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_ENABLED: "1" })).length, 1, "W25");
    assert.strictEqual(W(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_LOT_MIN_ISK: "20000000" })).length, 1, "W26");
    assert.strictEqual(W(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_BACKOFF_BASE_MS: "86400000",
      EVEJS_LNE_FREE_CORPS_CONTRACTS_BACKOFF_MAX_MS: "60000" })).length, 1, "W27");
  });

  needsDriver("CT6 a failed read (contract null) of a live contract keeps it OPEN (find confirms), the "
    + "sale is credited once later; a truly missing one -> RETURNING; CLEANUP keeps the delete backoff", async () => {
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      const read = vendor.adapter.tradeReadContract;
      let flaky = 0;
      vendor.adapter.tradeReadContract = (id) => {
        if (flaky <= 0) return read(id);
        flaky -= 1;
        return { ok: true, contract: null };
      };
      const { pump, counters } = pumpOf(opened, { clock, vendor, S });
      const isk0 = corpOf(opened, 2).isk;
      return pump.runNow().then(() => {
        flaky = 1;
        clock.set(H.T0 + 1000 + S.pollMs);
        return pump.runNow();
      }).then(() => {
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, c.vendor_contract_id, c.next_check_at, vendor.finds, counters.ctFound],
          ["OPEN", 9001, H.T0 + 1000 + 2 * S.pollMs, 1, 1], "a failed read is no proof");
        vendor.contracts.get(9001).status = "FINISHED";
        clock.set(H.T0 + 1000 + 2 * S.pollMs);
        return pump.runNow();
      }).then(() => {
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, corpOf(opened, 2).isk, counters.ctSold], ["SOLD", isk0 + c.price_isk, 1]);
      });
    });
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      const { pump } = pumpOf(opened, { clock, vendor, S });
      return pump.runNow().then(() => {
        vendor.contracts.delete(9001);
        clock.set(H.T0 + 1000 + S.pollMs);
        return pump.runNow();
      }).then(() => {
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, c.end_reason, vendor.finds], ["RETURNING", "CONTRACT_MISSING", 1]);
      });
    });
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      const { pump } = pumpOf(opened, { clock, vendor, S });
      return pump.runNow().then(() => {
        vendor.adapter.tradeReadContract = () => ({ ok: true, contract: null });
        vendor.adapter.tradeFindContract = (spec) => {
          vendor.finds += 1;
          return findTradeContractFrom({ listContractRecords: () => { throw new Error("repo locked"); } },
            { listPendingContractSettlements: () => [] }, spec);
        };
        clock.set(H.T0 + 1000 + S.pollMs);
        return pump.runNow();
      }).then(() => {
        const c = ctRows(opened)[0];
        assert.deepStrictEqual([c.state, c.end_reason, vendor.finds], ["OPEN", null, 1], "a failed find is no proof");
      });
    });
    await withStoreAsync(driver, (opened) => {
      const { S } = planned(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = fakeVendor();
      const del = vendor.adapter.tradeDeleteContract;
      let refuse = true;
      vendor.adapter.tradeDeleteContract = async (p) => {
        if (!refuse) return del(p);
        vendor.deletes.push(p.contractId);
        return { ok: false, reason: "TEST_REFUSED" };
      };
      return pumpOf(opened, { clock, vendor, S }).pump.runNow().then(() => {
        const cleanup = pumpOf(opened, { clock, vendor, S, mode: "CLEANUP" });
        return cleanup.pump.runNow().then(() => {
          const c = ctRows(opened)[0];
          assert.deepStrictEqual([c.state, c.close_attempts, vendor.deletes], ["OPEN", 1, [9001]]);
          return cleanup.pump.runNow().then(() => {
            assert.deepStrictEqual(vendor.deletes, [9001], "the backoff holds in CLEANUP");
            refuse = false;
            clock.set(ctRows(opened)[0].next_check_at);
            return cleanup.pump.runNow();
          });
        });
      }).then(() => {
        assert.deepStrictEqual([ctRows(opened)[0].state, vendor.deletes], ["RETURNING", [9001, 9001]]);
      });
    });
  });
};
