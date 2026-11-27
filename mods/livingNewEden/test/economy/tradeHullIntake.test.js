"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { buildTradeCatalog } = require("../../lib/economy/trade/tradeCatalog");
const { stepAccepted, stepIntake } = require("../../lib/economy/trade/intake");
const { buildIssuePayload } = require("../../lib/economy/trade/executorRules");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const HULL_RECIPES = require("../../lib/economy/data/hullRecipes");
const S = require("../../lib/economy/trade/schema");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");

const driver = H.loadDriver();
const MOD_DIR = path.join(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500003;
const CORP = 999999;
const SYSTEM = 30000001;
const GRACE = 600000;
const CRUISER = HULL_TYPES.RACES["4"].cruiser;

function hullSpec(at, over = {}) {
  return { factionId: F, stationId: "st-h", systemId: SYSTEM, issuerCorporationId: CORP, itemKind: "hull",
    itemKey: "group:cruiser", typeId: CRUISER, quantity: 3, unitPriceMilli: 10000000000, iskTotal: 30000000,
    refPriceMilli: 10000000000, capPriceMilli: null, priceSource: "bid", expiresAt: at + 259200000, at,
    purpose: "hull", ...over };
}

module.exports = ({ test, skip }) => {
  if (!driver.ok) {
    skip("THI1 c1 hull WTB: validation, intake to hull stock once, STALE replay", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("THI1 c1 hull WTB: validation, intake to hull stock once, STALE replay", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const at = clock.now();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const budgets = createBudgetRepository({ journal, clock });
    const catalog = buildTradeCatalog({ hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES, hullOffersEnabled: true });
    const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock, catalog });
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    const funded = tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: at, iskPerUnit: 1000,
      capIsk: 1000000000, at }, `fund:${at}`));
    assert.ok(funded.ok, JSON.stringify(funded));
    tx((db) => db.prepare(`INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family,
      system_id, owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
      evejs_item_id, destroyed_at, created_at, updated_at, version) VALUES ('st-h', 'npc', 61000009, 35834, 'Amarr', ?,
      ?, ?, 'ONLINE', NULL, 'Test Station', '{"x":0,"y":0,"z":0}', 'seed', NULL, NULL, ?, ?, 1)`)
      .run(SYSTEM, F, CORP, at, at));

    const invalid = { ok: false, reason: "TRADE_INVALID_INPUT", detail: "hull" };
    const create = (over, key, repo = offers) => tx((db) => repo.createOfferInTx(db, hullSpec(at, over), key));
    assert.deepStrictEqual(create({ assigneeCharacterId: 90000001 }, "thi1:assignee"), invalid);
    assert.deepStrictEqual(create({ itemKey: "group:frigate" }, "thi1:group"), invalid);
    assert.deepStrictEqual(create({ typeId: 587 + 1000000 }, "thi1:type"), invalid);
    assert.deepStrictEqual(create({ channel: "market" }, "thi1:market"), invalid);
    const offRepo = createOfferRepository({ journal, budgets, ids: shared.ids, clock,
      catalog: buildTradeCatalog({ hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES, hullOffersEnabled: false }) });
    assert.deepStrictEqual(create({}, "thi1:off", offRepo), invalid, "flag off");

    const made = create({}, "thi1:ok");
    assert.ok(made.ok && !made.duplicate, JSON.stringify(made));
    const id = made.offer.offerId;
    assert.ok(id.startsWith("to_"), id);
    assert.deepStrictEqual([made.offer.itemKind, made.offer.itemKey, made.offer.typeId], ["hull", "group:cruiser",
      CRUISER]);

    const station = { stationId: 61000009, systemId: SYSTEM };
    const payload = buildIssuePayload({ ...made.offer, iskTotal: 30000000 }, station, { ceoId: 1 },
      { accountKey: 1000, contractTtlMs: 86400000 }, "Amarr");
    assert.strictEqual(payload.description, `[LNE:${id}] Amarr buys 3 ships of this type for its station. Deliver `
      + "packaged ships to this station; modules and cargo inside an assembled ship are consumed with it.");
    const mineral = buildIssuePayload({ ...made.offer, itemKind: "mineral", itemKey: "type:34", typeId: 34 }, station,
      { ceoId: 1 }, { accountKey: 1000, contractTtlMs: 86400000 }, "Amarr");
    assert.strictEqual(mineral.description, `[LNE:${id}] Amarr buys 3 units of this item for its station. Deliver to `
      + "this station.");

    const step = (v, from, to, dt, patch) => {
      const t = tx((db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: v, from, to, reason: "",
        at: at + dt, patch }, S.transitionKey(id, v, to)));
      assert.ok(t.ok, JSON.stringify(t));
    };
    step(1, S.PLANNED, S.ISSUING, 0, { expiresAt: at + 259200000 });
    step(2, S.ISSUING, S.OPEN, 1000, { contractId: 790001 });
    step(3, S.OPEN, S.ACCEPTED, 2000, { acceptorCharacterId: 999 });

    const adapter = createFakeTradeAdapter();
    adapter._addHangarStack(CORP, 61000009, 8001, CRUISER, 1);
    adapter._addHangarStack(CORP, 61000009, 8002, CRUISER, 2);
    const voided = new Map();
    const realVoid = adapter.tradeVoidStack;
    adapter.tradeVoidStack = (spec) => { voided.set(spec.itemId, (voided.get(spec.itemId) || 0) + 1); return realVoid(spec); };
    const counts = {};
    const telemetry = { count(name, n) { counts[name] = (counts[name] || 0) + n; } };
    const deps = { store: opened.store, journal, offers, adapter, clock, telemetry, logger: { log() {} }, catalog,
      config: { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, intakeGraceMs: GRACE } } };
    const offerOf = () => tx((db) => offers.getOffer(db, id)).offer;
    const stock = (kind, key) => tx((db) => db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = 'st-h'"
      + " AND item_kind = ? AND item_key = ?").get(kind, key));

    clock.advance(2000 + GRACE + 1);
    const acc = await stepAccepted(deps, offerOf(), { stationId: 61000009, kind: "npc", ownerCorporationId: CORP,
      systemId: SYSTEM, destroyed: false });
    assert.strictEqual(acc.action, "PLAN", JSON.stringify(acc));
    const del = await stepIntake(deps, offerOf());
    assert.deepStrictEqual(del, { action: "DELIVERED", deliveredQuantity: 3 });
    assert.strictEqual(stock("hull", "group:cruiser").quantity, 3);
    assert.strictEqual(stock("mineral", "group:cruiser"), undefined, "not credited as a mineral");
    assert.strictEqual(offerOf().state, S.DELIVERED);
    assert.strictEqual(counts["trade.hullsDelivered"], 3);
    assert.deepStrictEqual([...voided.entries()].sort((a, b) => a[0] - b[0]), [[8001, 1], [8002, 1]]);

    const again = await stepIntake(deps, offerOf());
    assert.strictEqual(again.action, "STALE");
    assert.strictEqual(stock("hull", "group:cruiser").quantity, 3, "replay: no second credit");
    assert.deepStrictEqual([...voided.values()], [1, 1], "replay: no new void");
    assert.strictEqual(counts["trade.hullsDelivered"], 3);
  }));
};
