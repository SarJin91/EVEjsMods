"use strict";

const assert = require("node:assert");

const { createViewRegistry } = require("../../lib/observer/views");
const { createRouter } = require("../../lib/observer/router");
const { startObserver } = require("../../lib/observer");
const path = require("node:path");
const { resolveConfig } = require("../../config");
const { VIEW_ID, SOURCE_IDS, buildFactionOverviewView, buildNameIndex, idOf } =
  require("../../lib/observer/views/factionOverview");
const { CALDARI, GURISTAS, SOURCES, factionNames } = require("./fixtures/factionOverviewSources");

const DEFAULTS = resolveConfig({ modDir: path.resolve(__dirname, "..", ".."), env: {} }).config;
const SETTINGS = Object.freeze({ refreshMs: 15000, maxFactions: 32, maxNotes: 12, maxJobs: 16, maxStations: 16 });
const fakeHttp = { createServer: () => ({ on() {}, listen() {}, unref() {}, close() {}, address: () => null }) };

function fakeSources() {
  const calls = {};
  const keys = {};
  const defs = new Map();
  const define = (id, getData) => {
    defs.set(id, { id, title: id, getData, cacheKey: () => (keys[id] === undefined ? `k-${id}` : keys[id]) });
  };
  for (const id of SOURCE_IDS) {
    define(id, () => {
      calls[id] = (calls[id] || 0) + 1;
      return SOURCES[id]();
    });
  }
  const views = { getView: (id) => defs.get(id) || null };
  return { views, calls, keys, defs, define };
}

function build(views, extra = {}) {
  const t = { now: 1793352069212 };
  const view = buildFactionOverviewView({ views, clock: { now: () => t.now }, factionNames: factionNames(),
    getGovernor: () => null, telemetry: null, nowMs: () => 0, settings: SETTINGS, ...extra });
  return { view, t, get: () => view.getData({ nowMs: t.now }) };
}

module.exports = ({ test }) => {
  test("FO3 faction-overview card: isk, production, mining, territory, notes; join by id and ambiguous name", () => {
    const s = fakeSources();
    const { view, get } = build(s.views);
    assert.strictEqual(view.title, "Factions — overview");
    const data = get();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    assert.deepStrictEqual(Object.keys(data.sources), [...SOURCE_IDS]);
    assert.deepStrictEqual(data.factions.slice(0, 2).map((f) => f.factionId), [CALDARI, GURISTAS],
      "factions source order first");
    const cal = data.factions[0];
    assert.strictEqual(cal.name, "Caldari State");
    assert.strictEqual(cal.isk.treasury.balanceIsk, 4990112550000);
    assert.deepStrictEqual(Object.keys(cal.isk.treasury.today),
      ["income", "fleetUpkeep", "productionFees", "losses", "tradeOut", "tradeIn"]);
    assert.strictEqual(cal.isk.trade.availableIsk, 9673139075);
    assert.strictEqual(cal.isk.trade.openOffers, 2);
    assert.deepStrictEqual(cal.isk.trade.contracts, { open: 9, tiers: [1, 7, 1], cap: 25 });
    assert.deepStrictEqual(cal.isk.resources, { units: 24281, reserves: 1000, unpaidPeriods: 0,
      perPeriod: { income: 71, cost: 49, net: 22 } });
    assert.deepStrictEqual(cal.production.lines, { used: 3, total: 20 }, "'bad' line format skipped");
    assert.deepStrictEqual(cal.production.jobs.map((j) => j.dueAt), [1793353785082, 1793355000000, 1793358285082]);
    assert.strictEqual(cal.production.jobsTotal, 3);
    assert.deepStrictEqual(cal.mining.miners, { live: 10, idle: 0, onTrip: 10 });
    assert.deepStrictEqual(cal.mining.mineralStock.minerals[0], ["Tritanium", 1662750155]);
    assert.strictEqual(cal.territory.controlledSystems, 7);
    assert.strictEqual(cal.territory.borderSystems, 347);
    assert.strictEqual(cal.territory.stations.total, 3);
    assert.deepStrictEqual(cal.logistics, { open: 1, last24h: { delivered: 0, lost: 0 },
      totals: { delivered: 98, lost: 0 } });
    assert.strictEqual(cal.fleets.fleets, 26);
    assert.strictEqual(cal.fleets.factionId, undefined);
    assert.deepStrictEqual(cal.strategy.notes.map((n) => n.category),
      ["blokada", "oczekiwane", "oczekiwane", "informacja"]);
    assert.deepStrictEqual(cal.strategy.notes.slice(1, 3).map((n) => n.code), ["INDUSTRY_JOB_LIMIT", "INSUFFICIENT_FORCE"],
      "stable inside a category");
    assert.deepStrictEqual(cal.strategy.lastReview, { round: 1992613, outcome: "REVIEWED", target: 30000863 });
    assert.strictEqual(cal.strategy.plans.target.name, "C2X-M5");
    assert.strictEqual(cal.verdict.code, "BLOCKED");
    const gur = data.factions[1];
    assert.strictEqual(gur.isk.trade.availableIsk, 1000);
    assert.strictEqual(gur.isk.trade.contracts, null);
    assert.strictEqual(gur.isk.treasury, null);
    assert.strictEqual(gur.logistics, null, "absent in the source -> null");
    assert.strictEqual(data.sources.trade.unmatched, 1);
    assert.strictEqual(data.sources.production.unmatched, 0);
    assert.strictEqual(data.factions.some((f) => f.factionId === 500098 || f.factionId === 500099), false);
    assert.strictEqual(data.factions[2].factionId, 500025, "a faction of another source after the factions rows");
    assert.strictEqual(data.factions[2].territory.controlledSystems, 688);
    assert.strictEqual(data.factionsTruncated, 0);
    const index = buildNameIndex([{ factionId: 1, name: "A" }], new Map([[2, "A"], [3, "B"]]));
    assert.deepStrictEqual([idOf("A", index), idOf("B", index), idOf(7, index), idOf("?", index)], [null, 3, 7, null]);
    const cut = build(s.views, { settings: { ...SETTINGS, maxFactions: 1, maxNotes: 1, maxJobs: 1, maxStations: 2 } });
    const one = cut.get();
    assert.deepStrictEqual([one.factions.length, one.factionsTruncated], [1, 2]);
    assert.deepStrictEqual([one.factions[0].strategy.notes.length, one.factions[0].strategy.notesTruncated], [1, 3]);
    assert.deepStrictEqual([one.factions[0].production.jobs.length, one.factions[0].production.jobsTotal], [1, 3]);
    assert.deepStrictEqual([one.factions[0].territory.stations.list.length, one.factions[0].territory.stations.truncated],
      [2, true]);
  });

  test("FO4 refusals per source, memo by cacheKey + getData identity, no transaction, flag off", () => {
    const s = fakeSources();
    const errors = [];
    const { get } = build(s.views, { telemetry: { observe() {}, count: (n) => errors.push(n) } });
    s.defs.delete("trade");
    s.define("production", () => {
      throw new Error("boom");
    });
    const data = get();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual([data.sources.trade.available, data.sources.trade.reason], [false, "VIEW_MISSING"]);
    assert.deepStrictEqual([data.sources.production.reason, data.sources.production.message], ["SOURCE_FAILED", "boom"]);
    assert.deepStrictEqual(errors, ["observer.factionOverviewSourceErrors"]);
    const cal = data.factions[0];
    assert.deepStrictEqual([cal.isk.trade, cal.production], [null, null]);
    assert.ok(cal.isk.treasury && cal.mining && cal.fleets && cal.territory.stations, "the rest of the card is full");

    const m = fakeSources();
    const memo = build(m.views);
    memo.get();
    const second = memo.get();
    assert.strictEqual(m.calls.factions, 1);
    assert.strictEqual(second.sources.factions.cached, true);
    m.keys.mining = "k-mining-2";
    memo.get();
    assert.deepStrictEqual([m.calls.mining, m.calls.factions], [2, 1]);
    m.define("factions", () => {
      m.calls.factions += 1;
      return SOURCES.factions();
    });
    memo.get();
    assert.strictEqual(m.calls.factions, 2, "re-registration (new getData) forces a rebuild");
    m.keys.control = null;
    memo.get();
    memo.get();
    assert.strictEqual(m.calls.control, 3, "null key = never memoized");
    const off = { available: false, reason: "STORE_CLOSED" };
    m.define("stations", () => off);
    m.keys.stations = "k-st";
    const closed = memo.get();
    assert.deepStrictEqual([closed.sources.stations.reason, closed.factions[0].territory.stations], ["STORE_CLOSED", null]);
    assert.strictEqual(m.views.store, undefined, "the fake registry has no store to open a transaction on");

    for (const [enabled, expected] of [[false, null], [true, VIEW_ID]]) {
      const views = createViewRegistry();
      const obs = startObserver({ config: { observer: { ...DEFAULTS.observer, port: 0, factionOverviewEnabled: enabled } },
        ctx: {}, views, httpApi: fakeHttp });
      assert.strictEqual(obs.ok, true, JSON.stringify(obs));
      const v = views.getView(VIEW_ID);
      assert.strictEqual(v ? v.id : null, expected);
      assert.strictEqual(views.listViews().some((x) => x.id === VIEW_ID), enabled);
      obs.observer.stop();
    }
    assert.strictEqual(DEFAULTS.observer.factionOverviewEnabled, true);
  });

  test("FO5 router: first answer fresh, governor hold in a new bucket -> stale:true with the first data", () => {
    const t = { now: 1793352069212 };
    const views = createViewRegistry();
    for (const id of SOURCE_IDS) {
      assert.strictEqual(views.registerView(id, { title: id, listed: false, getData: () => SOURCES[id](),
        cacheKey: () => `k-${id}` }).ok, true);
    }
    let admit = true;
    const view = buildFactionOverviewView({ views, clock: { now: () => t.now }, factionNames: factionNames(),
      getGovernor: () => ({ admits: () => admit }), nowMs: () => 0, settings: SETTINGS });
    assert.strictEqual(views.registerView(VIEW_ID, view).ok, true);
    const router = createRouter({ views, assets: {}, config: { maxResponseBytes: 4194304, refreshSeconds: 5 },
      modVersion: "t", now: () => t.now, telemetry: () => null });
    const get = () => {
      const r = router.route({ method: "GET", url: `/api/views/${VIEW_ID}`, host: "127.0.0.1:26410" });
      assert.strictEqual(r.status, 200, String(r.body));
      return JSON.parse(String(r.body));
    };
    const first = get();
    assert.deepStrictEqual([first.stale, first.data.available, first.data.factions[0].factionId], [false, true, CALDARI]);
    admit = false;
    assert.strictEqual(view.cacheKey({ nowMs: t.now }), null);
    t.now += 20000;
    const held = get();
    assert.strictEqual(held.stale, true);
    assert.strictEqual(held.data.reason, "GOVERNOR_HOLD");
    assert.deepStrictEqual(held.data.factions, first.data.factions);
    assert.strictEqual(held.data.staleAgeMs, 20000);
  });

  test("FO6 roles; an invader with an ACTIVE invasion gets the foothold and the withdrawal time", () => {
    const INVADER = 500019;
    const HIVE = 500025;
    const s = fakeSources();
    const { t, get } = build(s.views);
    s.define("factions", () => {
      const d = SOURCES.factions();
      d.factions.push({ factionId: INVADER, name: "Invader", kind: "invader", status: "ACTIVE" },
        { factionId: HIVE, name: "Rogue Drones", kind: "hive", status: "ACTIVE",
          treasury: { mode: "NORMAL", balanceIsk: 0, initialIsk: 0 } });
      return d;
    });
    const withdrawAt = new Date(t.now + 5 * 3600000 + 12 * 60000 + 30000).toISOString();
    s.define("invasions", () => ({ ...SOURCES.invasions(), open: [
      { invasion: "i1", system: "Jita", faction: INVADER, state: "ACTIVE", withdrawAt }] }));
    const data = get();
    const byId = new Map(data.factions.map((f) => [f.factionId, f]));
    assert.deepStrictEqual([CALDARI, INVADER, HIVE].map((id) => byId.get(id).role), ["ai", "invader", "hive"]);
    assert.strictEqual(byId.get(HIVE).isk.treasury, null, "the hive row of the treasury is ignored");
    assert.deepStrictEqual(byId.get(INVADER).verdict, { code: "WORKING", label: "invasion",
      sentence: "invasion active: Jita, withdrawal in 5 h 12 min" });
    s.define("invasions", () => SOURCES.invasions());
    t.now += 20000;
    assert.strictEqual(get().factions.find((f) => f.factionId === INVADER).verdict.sentence,
      "no invasion, next roll every 6 h");
    const { roleOf } = require("../../lib/observer/views/factionOverview");
    assert.deepStrictEqual([roleOf(500018, null, true), roleOf(500005, null, true), roleOf(500005, null, false)],
      ["capsuleers", "sde-only", null]);
  });

  test("FO7 treasury full day (observer.treasuryFullDayEnabled): off = card of before; on = netOf fields + avg7d", () => {
    const { createTreasuryService, netOf } = require("../../lib/economy/treasury/treasuryService");
    const DAY = 20767;
    const day = (d, over) => ({ day: d, income: 0, fleetUpkeep: 0, productionFees: 0, losses: 0, lossValue: 0,
      shipsLost: 0, tradeOut: 0, tradeIn: 0, unpaid: 0, balanceEnd: 0, updatedAt: 0, mercFees: 0, mercRefunds: 0,
      admin: 0, warSpend: 0, ...over });
    const days = [day(DAY, { income: 62183333306, admin: 49249541653, warSpend: 363506934, fleetUpkeep: 1500000000,
      productionFees: 600000000, mercFees: 1000, mercRefunds: 400 }),
    day(DAY - 1, { income: 60000000000, admin: 48000000000, warSpend: 400000000 }),
    day(DAY - 2, { income: 59000000000, admin: 47000000000, losses: 3000000000 })];
    const row = { factionId: CALDARI, mode: "NORMAL", modeChangedAt: null, kind: "empire", balanceIsk: 4990112550000,
      initialIsk: 5000000000000, totals: {} };
    const svc = createTreasuryService({ store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
      repository: { listInDb: () => ({ ok: true, rows: [row] }), daysInDb: () => ({ ok: true, days }) },
      config: DEFAULTS, clock: { now: () => DAY * 86400000 + 3600000 }, hullValues: {} });
    const panel = svc.listForPanel();
    assert.strictEqual(panel.ok, true, JSON.stringify(panel));
    const x = panel.rows[0];
    const treasury = { ...x.treasury, today: x.today, yesterday: x.yesterday, avg7dNetIsk: x.avg7dNetIsk,
      forecast: x.forecast };
    const cardOf = (settings, tre) => {
      const s = fakeSources();
      s.define("factions", () => {
        const d = SOURCES.factions();
        if (tre) d.factions[0] = { ...d.factions[0], treasury: tre };
        return d;
      });
      return build(s.views, { settings }).get().factions.find((f) => f.factionId === CALDARI).isk.treasury;
    };
    const before = { mode: "NORMAL", balanceIsk: 4990112550000, initialIsk: 5000000000000,
      today: { income: 0, fleetUpkeep: 0, productionFees: 0, losses: 0, tradeOut: 9887450000, tradeIn: 0 },
      forecast: { trend: "FLAT", daysToZero: null, daysToAusterity: null } };
    assert.strictEqual(JSON.stringify(cardOf(SETTINGS)), JSON.stringify(before));
    assert.strictEqual(JSON.stringify(cardOf({ ...SETTINGS, treasuryFullDay: false })), JSON.stringify(before));
    const offFull = cardOf(SETTINGS, treasury);
    assert.deepStrictEqual(Object.keys(offFull), ["mode", "balanceIsk", "initialIsk", "today", "forecast"]);
    assert.deepStrictEqual(Object.keys(offFull.today),
      ["income", "fleetUpkeep", "productionFees", "losses", "tradeOut", "tradeIn"]);
    const on = cardOf({ ...SETTINGS, treasuryFullDay: true }, treasury);
    assert.deepStrictEqual(on.today, { income: 62183333306, fleetUpkeep: 1500000000, productionFees: 600000000,
      losses: 0, tradeOut: 0, tradeIn: 0, admin: 49249541653, warSpend: 363506934, mercFees: 1000, mercRefunds: 400,
      net: 10470284119 });
    assert.strictEqual(on.today.net, netOf(days[0]));
    assert.strictEqual(on.yesterday.net, netOf(days[1]));
    assert.strictEqual(on.avg7dNetIsk, x.avg7dNetIsk);
    assert.strictEqual(on.avg7dNetIsk, Math.floor((netOf(days[1]) + netOf(days[2])) / 2));
    assert.deepStrictEqual(on.forecast, { trend: x.forecast.trend, daysToZero: x.forecast.daysToZero,
      daysToAusterity: x.forecast.daysToAusterity });
  });
};
