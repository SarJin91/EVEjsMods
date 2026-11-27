"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { buildContractGoods } = require("../../lib/freeCorps/contractGoods");
const { planCourier, rewardOf, priceCourier } = require("../../lib/freeCorps/couriers");
const contractModule = require("../../lib/freeCorps/contractRepository");
const outboxModule = require("../../lib/freeCorps/outboxRepository");
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const { createFreeCorpVentureRepository } = require("../../lib/freeCorps/ventureRepository");
const { createContractPump } = require("../../lib/freeCorps/contractPump");
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
const HOME = 60000011;
const DEST = 60000012;
const CEO3 = 98000004;
const DAY = 86400000;

function courierVendor() {
  const v = { grants: [], funds: [], finds: 0, deletes: [], fails: 0, voids: [], receipts: new Map(), wallet: new Map(),
    walletKeys: new Set(), contracts: new Map(), hangar: new Map(), nextItem: 5001, nextContract: 9001, grantResult: null };
  const bal = (id) => v.wallet.get(id) || 0;
  const status = (c) => (["OUTSTANDING", "FINISHED", "DELETED"].includes(c.phase) ? c.phase : "OTHER");
  v.adapter = {
    readItemTypeFacts: (ids) => ({ ok: true, missing: [], facts: new Map(ids.map((id) => [id,
      { typeId: id, name: `Type ${id}`, volume: 1, portionSize: ORE_IDS.has(id) ? 100 : 1 }])) }),
    async tradeAdjustWallet({ ownerId, deltaIsk, commandId }) {
      v.funds.push(commandId);
      if (v.walletKeys.has(commandId)) return { ok: true, duplicate: true, fingerprintMismatch: false };
      if (bal(ownerId) + deltaIsk < 0) return { ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true };
      v.wallet.set(ownerId, bal(ownerId) + deltaIsk);
      v.walletKeys.add(commandId);
      return { ok: true, duplicate: false, fingerprintMismatch: false };
    },
    tradeGrantStock(spec) {
      v.grants.push(spec.key);
      if (v.grantResult) return v.grantResult;
      if (v.receipts.has(spec.key)) return { ok: true, duplicate: true, itemIds: v.receipts.get(spec.key).itemIds };
      const itemId = v.nextItem;
      v.nextItem += 1;
      v.hangar.set(itemId, { typeId: spec.typeId, quantity: spec.quantity, station: spec.npcStationId });
      v.receipts.set(spec.key, { quantity: spec.quantity, itemIds: [itemId] });
      return { ok: true, duplicate: false, itemIds: [itemId] };
    },
    tradeGrantReceipt: (key) => (v.receipts.has(key)
      ? { ok: true, found: true, quantity: v.receipts.get(key).quantity, itemIds: v.receipts.get(key).itemIds }
      : { ok: true, found: false, quantity: 0, itemIds: [] }),
    async tradeCreateCourierContract(p) {
      if (bal(p.ceoId) < p.rewardIsk) return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false };
      v.wallet.set(p.ceoId, bal(p.ceoId) - p.rewardIsk);
      const items = p.grantItemIds.filter((id) => v.hangar.has(id)).map((id) => [id, v.hangar.get(id)]);
      for (const [id] of items) v.hangar.delete(id);
      const id = v.nextContract;
      v.nextContract += 1;
      v.contracts.set(id, { kind: "COURIER", phase: "OUTSTANDING", offerId: p.offerId, items, ceo: p.ceoId,
        start: p.npcStationId, dest: p.destinationStationId, reward: p.rewardIsk, collateral: p.collateralIsk,
        deadlineMs: null, numDays: p.numDays });
      return { ok: true, contractId: id };
    },
    async tradeCreateSellContract(p) {
      const items = p.grantItemIds.filter((id) => v.hangar.has(id)).map((id) => [id, v.hangar.get(id)]);
      for (const [id] of items) v.hangar.delete(id);
      const id = v.nextContract;
      v.nextContract += 1;
      v.contracts.set(id, { kind: "WTS", phase: "OUTSTANDING", offerId: p.offerId, items, start: p.npcStationId });
      return { ok: true, contractId: id };
    },
    tradeFindContract({ offerId }) {
      v.finds += 1;
      for (const [id, c] of v.contracts) if (c.offerId === offerId) return { ok: true, found: "record", contractId: id };
      return { ok: true, found: null };
    },
    tradeReadContract(id) {
      const c = v.contracts.get(id);
      if (!c) return { ok: true, contract: null };
      return { ok: true, contract: { status: status(c), pendingKind: null, courier: c.kind === "COURIER"
        ? { phase: c.phase, deadlineMs: c.deadlineMs, destinationStationId: c.dest } : null } };
    },
    async tradeDeleteContract({ contractId }) {
      v.deletes.push(contractId);
      const c = v.contracts.get(contractId);
      c.phase = "DELETED";
      for (const [id, it] of c.items) v.hangar.set(id, { ...it, station: c.start });
      if (c.kind === "COURIER") v.wallet.set(c.ceo, bal(c.ceo) + c.reward);
      return { ok: true, deleted: true };
    },
    async tradeFailCourierContract({ contractId }) {
      v.fails += 1;
      const c = v.contracts.get(contractId);
      if (c.phase !== "IN_PROGRESS") return { ok: false, reason: "COURIER_FAIL_FAILED", permanent: false, pending: false };
      c.phase = "FAILED";
      v.wallet.set(c.ceo, bal(c.ceo) + c.reward + c.collateral);
      return { ok: true };
    },
    tradeListDeliveredStacks: ({ typeId, npcStationId }) => ({ ok: true, stacks: [...v.hangar]
      .filter(([, it]) => it.typeId === typeId && it.station === npcStationId)
      .map(([itemId, it]) => ({ itemId, quantity: it.quantity })).sort((a, b) => a.itemId - b.itemId) }),
    tradeVoidStack(spec) {
      v.voids.push(spec.key);
      const it = v.hangar.get(spec.itemId);
      if (!it || it.station !== spec.npcStationId) return { ok: false, reason: "ITEM_MISSING", permanent: true };
      v.hangar.delete(spec.itemId);
      return { ok: true, outcome: "VOIDED" };
    },
  };
  v.accept = (id, now) => {
    const c = v.contracts.get(id);
    c.phase = "IN_PROGRESS";
    c.deadlineMs = now + c.numDays * DAY;
  };
  v.deliver = (id) => {
    const c = v.contracts.get(id);
    c.phase = "FINISHED";
    for (const [, it] of c.items) {
      v.hangar.set(v.nextItem, { ...it, station: c.dest });
      v.nextItem += 1;
    }
  };
  return v;
}

function cfgCr({ courier = {}, contracts = {} } = {}) {
  const c = H.cfgOf();
  const ct = c.freeCorps.contracts;
  return { ...c, freeCorps: { ...c.freeCorps, contracts: { ...ct, enabled: true, issueChancePermille: 1000,
    ...contracts, courier: { ...ct.courier, enabled: true, issueChancePermille: 1000, ...courier } } } };
}

function seedVenture(opened, { corpId, kind, archetype }) {
  H.seedCorp(opened, { corpId, archetype, seed: 700 + corpId });
  const repo = createFreeCorpVentureRepository();
  const row = { venture_id: `fcv:${corpId}:1`, corp_id: corpId, seq: 1, kind, state: "RETURNING", open: 1,
    home_system_id: H.L1, system_id: H.L2, target_system_id: H.L2, target_station_id: kind === "HAUL" ? DEST : null,
    sec_band: "lowsec", jumps: 1, crew: 5, crew_lost: 0, step: 4, travel_steps: 1, work_steps: 3, steps_total: 5,
    holds: 0, yield_isk: 40000000, cost_isk: 0, started_at: H.T0 - 1000, step_due_at: H.T0, updated_at: H.T0 - 1000,
    ended_at: null, end_reason: null, version: 1, wh_route: null, wh_entry_system_id: null, stranded_steps: 0 };
  const r = opened.store.transaction("t.v", (db) => repo.insertInTx(db, row, row.updated_at));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function bootCr(opened, cfg) {
  const calls = { seams: 0, courierSeams: 0 };
  const vendor = courierVendor();
  const env = H.boot(opened, { cfg, extra: { contractGoods: () => GOODS, contractAdapter: () => vendor.adapter,
    freeCorpsContractSeams: () => { calls.seams += 1; return { ok: true }; },
    freeCorpsCourierSeams: () => { calls.courierSeams += 1; return { ok: true }; },
    addContractAcceptedListener: () => ({ ok: false, reason: "TEST" }) } });
  env.vc.identities.set(2, H.linked(5, 98000002));
  env.vc.identities.set(3, H.linked(5, 98000003));
  return { ...env, calls, vendor };
}

const ctRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_contracts ORDER BY contract_key");
const obRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_outbox ORDER BY key");
const corpOf = (opened, id) => H.all(opened, "SELECT * FROM world_free_corps WHERE corp_id = ?", id)[0];
const rowOf = (opened, key) => ctRows(opened).find((r) => r.contract_key === key);

function pumpOf(opened, { clock, vendor, S, contracts, courierMode = "RUN", counters = {} }) {
  return { counters, pump: createContractPump({ store: opened.store, outbox: outboxModule.createFreeCorpOutboxRepository(),
    contracts: contracts || contractModule.createFreeCorpContractRepository(), corps: createFreeCorpRepository(), clock,
    nowMs: () => 0, adapter: () => vendor.adapter, seams: () => ({ ok: true }), goods: () => GOODS.goods,
    courierSeams: () => ({ ok: true }), getGovernor: () => null, workClass: "MAINTENANCE", isRunning: () => true,
    bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, metric: () => {}, log: () => {},
    setTimer: () => ({ cancel() {}, hasRef: () => false }), S,
    retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 }, mode: "RUN", courierMode }) };
}

function plannedCr(opened, { wts = false, courier = {} } = {}) {
  seedVenture(opened, { corpId: 3, kind: "HAUL", archetype: "hauler" });
  if (wts) seedVenture(opened, { corpId: 2, kind: "MINE", archetype: "miner" });
  const cfg = cfgCr({ courier });
  const env = bootCr(opened, cfg);
  const st = H.pass(env);
  env.fc.stop();
  const c = rowOf(opened, "fcc:3:1");
  assert.ok(c && c.kind === "COURIER", JSON.stringify(st.counters));
  return { S: cfg.freeCorps.contracts, c, isk0: corpOf(opened, 3).isk, earned0: corpOf(opened, 3).isk_earned };
}

async function runs(pump, n) {
  for (let i = 0; i < n; i += 1) await pump.runNow();
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("CC2 planCourier deterministic, eligibility / destination refusals, rewardOf ceilings, priceCourier "
    + "volume cap and collateral, config defaults and W47-W49", () => {
    assert.ok(GOODS.ok, JSON.stringify(GOODS));
    const g = GOODS.goods;
    const S = cfgCr().freeCorps.contracts;
    const corp = { corp_id: 3, seed: 703, sec_band: "lowsec", home_station_id: HOME, home_system_id: H.L1 };
    const identity = H.linked(5, 98000003);
    const v = (kind, seq, over = {}) => ({ venture_id: `fcv:3:${seq}`, seq, kind, sec_band: "lowsec", jumps: 2,
      target_station_id: DEST, target_system_id: H.L2, ...over });
    const input = (venture) => ({ corp, venture, identity, goods: g, S, payout: 40000000, now: H.T0 });
    const p = planCourier(input(v("HAUL", 1)));
    assert.deepStrictEqual(p, planCourier(input(v("HAUL", 1))), "same input, same plan");
    assert.ok(p.ok, JSON.stringify(p));
    assert.deepStrictEqual([p.row.kind, p.row.station_id, p.row.dest_station_id, p.row.dest_system_id, p.row.reward_isk,
      p.outbox.kind, p.outbox.key], ["COURIER", HOME, DEST, H.L2, 600000, "CONTRACT_COURIER", "lne:fc:ct:fcv:3:1"]);
    assert.ok(["ORE", "MINERAL"].includes(p.row.goods));
    assert.deepStrictEqual(planCourier(input(v("MINE", 1))), { ok: false, reason: "NOT_ELIGIBLE" });
    assert.deepStrictEqual(planCourier(input(v("HAUL", 1, { target_station_id: HOME }))),
      { ok: false, reason: "NO_DESTINATION" });
    assert.deepStrictEqual(planCourier(input(v("HAUL", 1, { target_station_id: null }))),
      { ok: false, reason: "NO_DESTINATION" });

    const CS = S.courier;
    assert.strictEqual(rewardOf(0, CS), 450000, "max(1, jumps)");
    assert.strictEqual(rewardOf(5, CS), 1050000);
    assert.strictEqual(rewardOf(100, CS), CS.rewardMaxIsk, "the ceiling");
    assert.strictEqual(rewardOf(3, { rewardBaseIsk: 0, rewardPerJumpIsk: 0, rewardMaxIsk: 100000 }), 1, ">= 1");
    assert.strictEqual(rewardOf(3, { rewardBaseIsk: 1e8, rewardPerJumpIsk: 1e8, rewardMaxIsk: 1e8 }), 1e8);

    const ark = Object.values(g.ores).flat().find((r) => r.typeId === 22);
    assert.ok(ark, "Arkonor in the catalogue");
    const small = { ...S, courier: { ...CS, maxVolumeM3: 2000 } };
    const pc = priceCourier({ goods: "ORE", entry: ark, lotIsk: 10000000, portionSize: 100, volume: 16, S: small });
    assert.ok(pc.ok && pc.volumeCapped, JSON.stringify(pc));
    assert.strictEqual(pc.quantity % 100, 0);
    assert.ok(pc.quantity * 16 <= 2000);
    assert.ok(pc.collateralIsk * 1000 >= (pc.quantity / 100) * ark.portionPriceMilli, "collateral >= value");
    assert.deepStrictEqual(priceCourier({ goods: "ORE", entry: ark, lotIsk: 10000000, portionSize: 100, volume: 16,
      S: { ...S, courier: { ...CS, maxVolumeM3: 1000 } } }), { ok: false, reason: "SMALL_LOT" }, "not one portion");
    assert.strictEqual(priceCourier({ goods: "ORE", entry: ark, lotIsk: 1e7, portionSize: 100, volume: null, S }).reason,
      "NO_VOLUME");
    const min = g.minerals.lowsec[0];
    for (const [lotIsk, permille] of [[100000, 1000], [1000000000, 2000]]) {
      const SS = { ...S, courier: { ...CS, collateralPermille: permille, maxVolumeM3: 1200000 } };
      const m = priceCourier({ goods: "MINERAL", entry: min, lotIsk, portionSize: 1, volume: 0.01, S: SS });
      assert.ok(m.ok && Number.isSafeInteger(m.quantity) && Number.isSafeInteger(m.collateralIsk), JSON.stringify(m));
      assert.ok(m.collateralIsk * 1000 * 1000 >= m.quantity * min.unitPriceMilli * permille, "ceil(value x permille)");
    }

    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    assert.deepStrictEqual(def.config.freeCorps.contracts.courier, { enabled: false, maxOpen: 10,
      issueChancePermille: 500, rewardBaseIsk: 300000, rewardPerJumpIsk: 150000, rewardMaxIsk: 3000000,
      collateralPermille: 1000, days: 3, failGraceMs: 600000, maxVolumeM3: 60000 });
    const W = (r) => r.warnings.filter((w) => w.startsWith("freeCorps.contracts.courier."));
    assert.deepStrictEqual(W(def), []);
    assert.strictEqual(W(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_COURIER_ENABLED: "1" })).length, 1, "W47");
    assert.strictEqual(W(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_COURIER_MAX_OPEN: "40",
      EVEJS_LNE_FREE_CORPS_CONTRACTS_MAX_OPEN: "20" })).length, 1, "W48");
    assert.strictEqual(W(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_COURIER_REWARD_MAX_ISK: "400000" })).length, 1,
      "W49");
    assert.strictEqual(resolve({ EVEJS_LNE_FREE_CORPS_CONTRACTS_COURIER_COLLATERAL_PERMILLE: "500" }).config.freeCorps
      .contracts.courier.collateralPermille, 1000, "clamp: never below the value");
  });

  needsDriver("CC3 a DONE HAUL venture plans one courier + outbox row in the pass; replay; courier.maxOpen "
    + "courier off = no courier row and no courier seam call; the WTS plan of the same pass", () => {
    withStore(driver, (opened) => {
      seedVenture(opened, { corpId: 3, kind: "HAUL", archetype: "hauler" });
      seedVenture(opened, { corpId: 2, kind: "MINE", archetype: "miner" });
      const env = bootCr(opened, cfgCr());
      const st = H.pass(env);
      const c = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c.kind, c.state, c.open, c.station_id, c.dest_station_id, c.dest_system_id, c.reward_isk,
        c.collateral_isk, c.quantity, c.issuer_character_id], ["COURIER", "PLANNED", 1, HOME, DEST, H.L2, 450000, null,
        null, CEO3]);
      const w = rowOf(opened, "fcc:2:1");
      assert.deepStrictEqual([w.kind, w.state, w.dest_station_id, w.reward_isk], ["WTS", "PLANNED", null, null]);
      assert.deepStrictEqual(obRows(opened).map((r) => [r.key, r.kind, JSON.parse(r.payload).contractKey]),
        [["lne:fc:ct:fcv:2:1", "CONTRACT_WTS", "fcc:2:1"], ["lne:fc:ct:fcv:3:1", "CONTRACT_COURIER", "fcc:3:1"]]);
      assert.deepStrictEqual([st.counters.ctPlanned, st.counters.ctCourierPlanned, env.calls.courierSeams], [1, 1, 1]);
      assert.deepStrictEqual(st.contracts.courier, { mode: "RUN", seam: "OK", open: null });
      H.pass(env);
      assert.strictEqual(ctRows(opened).length, 2, "still one row each");
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      seedVenture(opened, { corpId: 3, kind: "HAUL", archetype: "hauler" });
      const repo = contractModule.createFreeCorpContractRepository();
      const w = opened.store.transaction("t.pre", (db) => repo.insertPlannedInTx(db, { contract_key: "fcc:9:9",
        outbox_key: "lne:fc:ct:fcv:9:9", venture_id: "fcv:9:9", corp_id: 9, kind: "COURIER", goods: "ORE",
        state: "PLANNED", open: 1, type_id: 1230, station_id: HOME, system_id: H.L1, issuer_character_id: 5,
        issuer_corporation_id: 6, lot_isk: 1000000, created_at: H.T0 - 1, dest_station_id: DEST, dest_system_id: H.L2,
        reward_isk: 1000 }));
      assert.ok(w.ok && w.value.ok, JSON.stringify(w));
      const env = bootCr(opened, cfgCr({ courier: { maxOpen: 1 } }));
      const st = H.pass(env);
      env.fc.stop();
      assert.strictEqual(ctRows(opened).length, 1, "no new row");
      assert.strictEqual(st.counters.ctCourierSkipFull, 1);
    });
    withStore(driver, (opened) => {
      seedVenture(opened, { corpId: 3, kind: "HAUL", archetype: "hauler" });
      seedVenture(opened, { corpId: 2, kind: "MINE", archetype: "miner" });
      const env = bootCr(opened, cfgCr({ courier: { enabled: false } }));
      const st = H.pass(env);
      env.fc.stop();
      assert.deepStrictEqual(ctRows(opened).map((r) => [r.contract_key, r.kind]), [["fcc:2:1", "WTS"]]);
      assert.deepStrictEqual(obRows(opened).map((r) => r.kind), ["CONTRACT_WTS"], "no CONTRACT_COURIER row");
      assert.deepStrictEqual([env.calls.courierSeams, st.counters.ctCourierPlanned || 0], [0, 0]);
      assert.strictEqual("courier" in st.contracts, false, "the status keys of before");
    });
  });

  needsDriver("CC4 pump: debit once, a crash after the create is found, fund once, accept -> ACCEPTED "
    + "delivery -> void at the destination -> CLOSED, treasury - R", async () => {
    await withStoreAsync(driver, async (opened) => {
      const { S, c: c0, isk0 } = plannedCr(opened);
      const R = c0.reward_isk;
      const clock = createManualClock(H.T0 + 1000);
      const vendor = courierVendor();
      const broken = { ...contractModule.createFreeCorpContractRepository(),
        openInTx: () => { throw new Error("crash before settle"); } };
      const r1 = await pumpOf(opened, { clock, vendor, S, contracts: broken }).pump.runNow();
      assert.strictEqual(r1.issued, "SETTLE_FAILED");
      const c1 = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c1.state, corpOf(opened, 3).isk, vendor.wallet.get(CEO3)], ["ISSUING", isk0 - R, 0],
        "debit once, the fund escrowed by the create");
      assert.ok(c1.quantity > 0 && c1.collateral_isk > 0 && c1.collateral_isk === c1.price_isk);
      const { pump, counters } = pumpOf(opened, { clock, vendor, S });
      clock.set(H.T0 + 1000 + S.issueSpacingMs);
      assert.strictEqual((await pump.runNow()).issued, "issued");
      const c2 = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c2.state, c2.vendor_contract_id, corpOf(opened, 3).isk, vendor.contracts.size,
        vendor.finds], ["OPEN", 9001, isk0 - R, 1, 1], "found, no second debit / create");
      assert.ok(vendor.funds.length <= 2 && vendor.funds.every((k) => k === "lne:fc:ct:fcv:3:1:fund"));
      assert.strictEqual(vendor.walletKeys.size, 1, "the CEO wallet +R once");
      const k = vendor.contracts.get(9001);
      assert.deepStrictEqual([k.start, k.dest, k.reward, k.collateral, k.numDays], [HOME, DEST, R, c1.collateral_isk,
        S.courier.days]);

      vendor.accept(9001, clock.now());
      pump.nudge(9001);
      await pump.runNow();
      const c3 = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c3.state, c3.open, c3.deadline_at, c3.next_check_at], ["ACCEPTED", 1,
        clock.now() + S.courier.days * DAY, clock.now() + S.pollMs]);
      vendor.deliver(9001);
      clock.set(c3.next_check_at);
      await runs(pump, 2);
      const c4 = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c4.state, c4.open, c4.end_reason, c4.refund_isk], ["CLOSED", 0, "DELIVERED", 0]);
      assert.deepStrictEqual(vendor.voids, ["lne:fc:ct:fcv:3:1:void:5002"]);
      assert.strictEqual(vendor.hangar.size, 0, "the delivered goods are gone");
      assert.strictEqual(corpOf(opened, 3).isk, isk0 - R, "treasury - R");
      assert.deepStrictEqual([counters.ctCourierAccepted, counters.ctCourierDelivered, counters.ctCourierRewardIsk,
        counters.ctCourierIssued], [1, 1, R, 1]);
      await pump.runNow();
      assert.deepStrictEqual([corpOf(opened, 3).isk, counters.ctCourierDelivered, vendor.voids.length], [isk0 - R, 1, 1]);
    });
  });

  needsDriver("CC5 refunds once: expiry, fail after the deadline, abort without a grant, defund short "
    + "WTS and courier rows keep their own paths", async () => {
    await withStoreAsync(driver, async (opened) => {
      const { S, c: c0, isk0, earned0 } = plannedCr(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = courierVendor();
      const { pump, counters } = pumpOf(opened, { clock, vendor, S });
      await pump.runNow();
      clock.set(rowOf(opened, "fcc:3:1").expires_at);
      await runs(pump, 2);
      const c = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c.state, c.end_reason, c.refund_isk, vendor.deletes], ["CLOSED", "EXPIRED", c0.reward_isk,
        [9001]]);
      assert.deepStrictEqual(vendor.voids, ["lne:fc:ct:fcv:3:1:void:5001"]);
      assert.deepStrictEqual([corpOf(opened, 3).isk, corpOf(opened, 3).isk_earned, vendor.wallet.get(CEO3)],
        [isk0, earned0, 0]);
      assert.strictEqual(counters.ctCourierRefundIsk, c0.reward_isk);
      await pump.runNow();
      assert.strictEqual(corpOf(opened, 3).isk, isk0, "no second credit");
    });
    await withStoreAsync(driver, async (opened) => {
      const { S, isk0, earned0 } = plannedCr(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = courierVendor();
      const { pump, counters } = pumpOf(opened, { clock, vendor, S });
      await pump.runNow();
      vendor.accept(9001, clock.now());
      pump.nudge(9001);
      await pump.runNow();
      const a = rowOf(opened, "fcc:3:1");
      clock.set(a.deadline_at + S.courier.failGraceMs - 1);
      await pump.runNow();
      assert.deepStrictEqual([vendor.fails, rowOf(opened, "fcc:3:1").state], [0, "ACCEPTED"], "not before the grace");
      clock.set(a.deadline_at + S.courier.failGraceMs);
      await runs(pump, 3);
      const c = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([vendor.fails, c.state, c.end_reason, JSON.parse(c.return_plan)],
        [1, "CLOSED", "COURIER_FAILED", []]);
      assert.strictEqual(c.refund_isk, a.reward_isk + a.collateral_isk);
      assert.deepStrictEqual([corpOf(opened, 3).isk, corpOf(opened, 3).isk_earned, vendor.wallet.get(CEO3)],
        [isk0 + a.collateral_isk, earned0 + a.collateral_isk, 0]);
      assert.deepStrictEqual([counters.ctCourierFailCalls, counters.ctCourierFailed, counters.ctCourierCollateralIsk],
        [1, 1, a.collateral_isk]);
    });
    await withStoreAsync(driver, async (opened) => {
      const { S, isk0 } = plannedCr(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = courierVendor();
      vendor.grantResult = { ok: false, reason: "GRANT_FAILED", permanent: true, ambiguous: false };
      const { pump } = pumpOf(opened, { clock, vendor, S });
      assert.strictEqual((await pump.runNow()).issued, "failed");
      await runs(pump, 2);
      const c = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c.state, c.end_reason, JSON.parse(c.return_plan)], ["CLOSED", "ISSUE_FAILED", []]);
      assert.deepStrictEqual(vendor.funds, ["lne:fc:ct:fcv:3:1:fund", "lne:fc:ct:fcv:3:1:fund",
        "lne:fc:ct:fcv:3:1:defund"], "the replay is a duplicate");
      assert.deepStrictEqual([corpOf(opened, 3).isk, vendor.wallet.get(CEO3)], [isk0, 0]);
    });
    await withStoreAsync(driver, async (opened) => {
      const { S, c: c0, isk0 } = plannedCr(opened);
      const clock = createManualClock(H.T0 + 1000);
      const vendor = courierVendor();
      const { pump, counters } = pumpOf(opened, { clock, vendor, S });
      await pump.runNow();
      clock.set(rowOf(opened, "fcc:3:1").expires_at);
      await pump.runNow();
      vendor.wallet.set(CEO3, 0);
      await pump.runNow();
      const c = rowOf(opened, "fcc:3:1");
      assert.deepStrictEqual([c.state, corpOf(opened, 3).isk, counters.ctCourierDefundShort], ["CLOSED",
        isk0 - c0.reward_isk, 1]);
    });
    await withStoreAsync(driver, async (opened) => {
      const { S } = plannedCr(opened, { wts: true });
      const clock = createManualClock(H.T0 + 1000);
      const vendor = courierVendor();
      const { pump } = pumpOf(opened, { clock, vendor, S });
      await pump.runNow();
      clock.set(H.T0 + 1000 + S.issueSpacingMs);
      await pump.runNow();
      assert.deepStrictEqual(ctRows(opened).map((r) => [r.contract_key, r.state]), [["fcc:2:1", "OPEN"],
        ["fcc:3:1", "OPEN"]], "one create a run, both issued");
      for (const id of vendor.contracts.keys()) vendor.accept(id, clock.now());
      clock.set(H.T0 + 1000 + S.issueSpacingMs + S.pollMs);
      await pump.runNow();
      assert.deepStrictEqual(ctRows(opened).map((r) => [r.contract_key, r.kind, r.state, r.end_reason]),
        [["fcc:2:1", "WTS", "RETURNING", "DELETED_EXTERNALLY"], ["fcc:3:1", "COURIER", "ACCEPTED", null]]);
    });
  });
};
