"use strict";

const assert = require("node:assert");

const { warQuoteAt, warQuoteOf } = require("../../lib/strategy/data/warPricePressure");
const { planTrade, planWarReprices } = require("../../lib/strategy/ai/trade");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { createStationAskDrain } = require("../../lib/economy/trade/stationAskCache");
const { fixtures: W } = require("./tradeWarPricing.test");

const NPC0 = 60003760;
const SIX = Array.from({ length: 6 }, (_, i) => ({ stationId: `npc-${i + 1}`, npcStationId: NPC0 + i,
  systemId: 30000001 + i, kind: "npc", ownerCorporationId: 1000001 }));
const GUARD = { warPricingEnabled: true, warStationAskGuardEnabled: true };

module.exports = ({ test }) => {
  test("SG3 warQuoteAt: five branches, public floor + stationCapped; step 5 takes the capped price and notes it", () => {
    const base = W.quoteOf(5000);
    const warQ = Object.freeze({ ...W.quoteOf(6000), warPermille: 500 });
    const k = "type:34";
    const t = (extra) => ({ quotes: { [k]: base }, warQuotes: { [k]: warQ }, ...extra });
    assert.strictEqual(warQuoteAt(t({}), "npc-1", k), warQuoteOf(t({}), k));
    assert.strictEqual(warQuoteAt(t({}), "npc-1", k), warQ);
    assert.strictEqual(warQuoteAt(t({ warQuotes: {}, stationWarCaps: { "npc-1": { [k]: 5500 } } }), "npc-1", k), base);
    assert.strictEqual(warQuoteAt(t({ stationWarCaps: {} }), "npc-1", k), base);
    assert.strictEqual(warQuoteAt(t({ stationWarCaps: { "npc-1": {} } }), "npc-1", k), base);
    assert.strictEqual(warQuoteAt(t({ stationWarCaps: { "npc-1": { [k]: null } } }), "npc-1", k), warQ);
    assert.strictEqual(warQuoteAt(t({ stationWarCaps: { "npc-1": { [k]: 7000 } } }), "npc-1", k), warQ);
    const cut = warQuoteAt(t({ stationWarCaps: { "npc-1": { [k]: 5500 } } }), "npc-1", k);
    assert.deepStrictEqual([cut.unitMilli, cut.stationCapped, cut.warPermille, cut.capMilli], [5500, true, 500,
      warQ.capMilli]);
    assert.deepStrictEqual([warQuoteAt(t({ stationWarCaps: { "npc-1": { [k]: 4000 } } }), "npc-1", k).unitMilli],
      [5000], "never below the public quote");

    const war = planTrade(W.makeSnapshot({ warPressurePermille: 500, warQuotes: { [k]: warQ },
      stationWarCaps: { "npc-1": { [k]: 5500 } } }), W.makeParams(), { intents: [] }, { intents: [] });
    const mob = war.intents.find((i) => i.type === "TRADE_OFFER" && i.purpose === "mobilization" && i.itemKey === k);
    assert.ok(mob, JSON.stringify(war.intents.map((i) => `${i.purpose}/${i.itemKey}`)));
    assert.deepStrictEqual([mob.stationId, mob.unitPriceMilli, mob.warPermille, mob.stationCapped],
      ["npc-1", 5500, 500, true]);
    assert.ok(war.notes.includes(`TRADE_WAR_STATION_CAPPED:${k}@npc-1`), JSON.stringify(war.notes));
    assert.strictEqual(describeNote(`TRADE_WAR_STATION_CAPPED:${k}@npc-1`).known, true);
  });

  test("SG5 reprice (step 1c) targets warQuoteAt: capped / unread station offers stay, cap null reprices", () => {
    const k = "type:34";
    const warQ = Object.freeze({ ...W.quoteOf(6000), warPermille: 500 });
    const T = { ...W.makeParams().trade, warPricingEnabled: true, warRepriceEnabled: true, warRepriceGapPermille: 50,
      warRepricePerReview: 4 };
    const offer = (offerId, stationId, unitPriceMilli) => ({ offerId, stationId, itemKey: k, typeId: 34, quantity: 10,
      state: "OPEN", expiresAt: W.AT + 86400000, version: 3, iskTotal: 10, unitPriceMilli,
      issuerCorporationId: 1000001, assigneeCharacterId: null });
    const trade = { quotes: { [k]: W.quoteOf(5000) }, warQuotes: { [k]: warQ },
      stationWarCaps: { "npc-1": { [k]: 5500 }, "npc-3": { [k]: null } },
      open: [offer("to_cut", "npc-1", 5500), offer("to_unread", "npc-2", 5000), offer("to_null", "npc-3", 5000)] };
    const r = planWarReprices(trade, T, W.AT, 4, new Set());
    assert.deepStrictEqual(r.intents.map((i) => [i.offerId, i.purpose]), [["to_null", "reprice"]]);
  });

  test("SG4 review queues the unread stations, the drain reads <= 4 and stops on TRANSPORT, a read station gets "
    + "caps; flag off = no key, no read", async () => {
    const svc = W.tradeServiceOf(GUARD);
    const read = () => svc.readForReview({}, W.F, { ...W.READ, stations: SIX, warPressurePermille: 500 });
    const r1 = read();
    assert.ok(r1.ok, JSON.stringify(r1));
    assert.deepStrictEqual(r1.trade.stationWarCaps, {});
    const cache = svc.getStationAskCache();
    assert.deepStrictEqual([cache.getStatus().pending, svc.getStatus().counters.stationAskUnread], [6, 6]);

    const calls = [];
    let failOn = 2;
    const readStationAsks = async (spec) => {
      calls.push(spec.stationId);
      if (calls.length === failOn) return { ok: false, reason: "TRANSPORT", detail: "down" };
      return { ok: true, asks: new Map(spec.typeIds.map((id) => [id, id === 34 ? 1060 : null])) };
    };
    const counts = [];
    const drainOf = (T) => createStationAskDrain({ T: { ...T, maxStationAskReadsPerPass: 4 }, cache, readStationAsks,
      clock: { now: () => W.AT }, count: (name, n) => counts.push([name, n]) });
    await drainOf(GUARD)();
    assert.deepStrictEqual(calls, [NPC0, NPC0 + 1]);
    assert.deepStrictEqual(cache.getStatus().pending, 5);
    assert.deepStrictEqual(counts, [["stationAskReads", 1], ["stationAskFailed", 1]]);
    failOn = 0;
    await drainOf(GUARD)();
    assert.deepStrictEqual(calls.slice(2), [NPC0 + 4, NPC0 + 5, NPC0 + 1, NPC0 + 2]);
    const caps = read().trade.stationWarCaps;
    assert.deepStrictEqual(caps["npc-1"], { "type:34": 1060, "type:35": null });
    assert.ok(!("npc-4" in caps), JSON.stringify(Object.keys(caps)));

    const off = W.tradeServiceOf({ warPricingEnabled: true });
    const r0 = off.readForReview({}, W.F, { ...W.READ, stations: SIX, warPressurePermille: 500 });
    assert.deepStrictEqual(["stationWarCaps" in r0.trade, off.getStationAskCache().getStatus().pending], [false, 0]);
    const before = calls.length;
    cache.want(NPC0, [34]);
    await drainOf({ warPricingEnabled: true, warStationAskGuardEnabled: false })();
    await drainOf({ warPricingEnabled: false, warStationAskGuardEnabled: true })();
    assert.strictEqual(calls.length, before);
  });
};
