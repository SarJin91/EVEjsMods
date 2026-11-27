"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startTrade } = require("../../lib/economy/trade");
const { createViewRegistry } = require("../../lib/observer/views");
const { readTradePricesFrom } = require("../../lib/adapter/marketPrices");
const { mergePriceRefs } = require("../../lib/economy/trade/priceMerge");
const { quote } = require("../../lib/economy/trade/pricing");
const { loadSnapshotSync } = require("../../lib/economy/trade/externalPriceStore");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");

const driver = H.loadDriver();
const MOD_DIR = path.join(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const HOUR = 3600000;

function localSeam() {
  const marketDaemon = {
    call: async (method) => (method === "GetOrders" ? { buys: [{ price: 3.5 }], sells: [{ price: 100 }] } : []),
  };
  const industryPricing = { resolveAdjustedAverageTypePrice: () => 4 };
  return (spec) => readTradePricesFrom(marketDaemon, industryPricing, spec);
}

function fakeFetch() {
  const ctl = { calls: [], pending: [] };
  ctl.fetch = (spec) => {
    ctl.calls.push(spec);
    return new Promise((resolve) => ctl.pending.push(resolve));
  };
  ctl.resolveLast = (value) => ctl.pending.pop()(value);
  return ctl;
}

function jita(entries, rejected = []) {
  return { ok: true, prices: new Map(entries), rejected: new Map(rejected) };
}

async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(cond, what) {
  for (let i = 0; i < 400; i += 1) {
    if (cond()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timeout waiting for ${what}`);
}

function boot(opened, shared, adapter, tradeOverrides, extra = {}) {
  const views = createViewRegistry();
  const timers = [];
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const cfg = { ...DEFAULTS, ...(extra.dataDir ? { dataDir: extra.dataDir } : {}),
    trade: { ...DEFAULTS.trade, enabled: true, hullOffersEnabled: false, ...tradeOverrides } };
  const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
    clock: shared.clock, ids: shared.ids, views, adapter, logger: { log() {} },
    getStations: () => ({ getMode: () => "ready" }), getGraph: () => null,
    setTimer: (fn) => { const t = { fn, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; } });
  assert.ok(started.ok, JSON.stringify(started));
  const firePass = async () => {
    const t = timers.filter((x) => !x.cancelled).pop();
    assert.ok(t, "executor armed");
    t.cancelled = true;
    await t.fn();
  };
  return { trade: started.trade, view: views.getView("trade"), firePass };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lne-ext-prices-"));
}

module.exports = ({ test, skip }) => {
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("EP3 mergePriceRefs: ext + local, DEVIATION, ext null, local without ask, both without ask", () => {
    const P = { maxRatio: 10 };
    const local = { bidMilli: 3500, askMilli: 100000, baseMilli: 4000 };
    assert.deepStrictEqual(mergePriceRefs(local, { bidMilli: 3780, askMilli: 3950 }, P), {
      refs: { bidMilli: 3780, askMilli: 100000, baseMilli: 4000, origin: "external" }, extRejected: null });
    assert.strictEqual(mergePriceRefs({ ...local, askMilli: 3000 }, { bidMilli: 3780, askMilli: 3950 }, P)
      .refs.askMilli, 3000);
    for (const bid of [40001, 399]) {
      assert.deepStrictEqual(mergePriceRefs(local, { bidMilli: bid, askMilli: 50000 }, P), {
        refs: { ...local, origin: "local" }, extRejected: "DEVIATION" });
    }
    assert.deepStrictEqual(mergePriceRefs(local, null, P), { refs: { ...local, origin: "local" }, extRejected: null });
    const CLEAN = { ...P, localClean: true };
    assert.deepStrictEqual(mergePriceRefs({ bidMilli: null, askMilli: null, baseMilli: null },
      { bidMilli: 3780, askMilli: 3950 }, CLEAN),
    { refs: { bidMilli: 3780, askMilli: 3950, baseMilli: null, origin: "external" }, extRejected: null });
    assert.deepStrictEqual(mergePriceRefs(null, { bidMilli: 3780, askMilli: 3950 }, CLEAN).refs.origin, "external");
    for (const params of [P, { ...P, localClean: false }]) {
      assert.deepStrictEqual(mergePriceRefs({ bidMilli: null, askMilli: null, baseMilli: 4000 },
        { bidMilli: 3780, askMilli: 3950 }, params), { refs: null, extRejected: null });
      assert.deepStrictEqual(mergePriceRefs(null, { bidMilli: 3780, askMilli: 3950 }, params),
        { refs: null, extRejected: null });
    }
    assert.deepStrictEqual(mergePriceRefs({ bidMilli: 3500, askMilli: null, baseMilli: 4000 }, null, P),
      { refs: null, extRejected: null });
    assert.deepStrictEqual(mergePriceRefs(null, null, P), { refs: null, extRejected: null });
  });

  test("ASK1 askCapIncludesExternal: false/absent = local ask, true = min(local, Jita); in both; quote", () => {
    const local = { bidMilli: 3500, askMilli: 100000, baseMilli: 4000 };
    const jitaRef = { bidMilli: 3780, askMilli: 3950 };
    for (const P of [{ maxRatio: 10 }, { maxRatio: 10, askCapIncludesExternal: false }]) {
      assert.strictEqual(mergePriceRefs(local, jitaRef, P).refs.askMilli, 100000);
    }
    const INC = { maxRatio: 10, askCapIncludesExternal: true };
    assert.deepStrictEqual(mergePriceRefs(local, jitaRef, INC), {
      refs: { bidMilli: 3780, askMilli: 3950, baseMilli: 4000, origin: "external" }, extRejected: null });
    assert.strictEqual(mergePriceRefs({ ...local, askMilli: 3000 }, jitaRef, INC).refs.askMilli, 3000);
    for (const inc of [false, true]) {
      const clean = { maxRatio: 10, localClean: true, askCapIncludesExternal: inc };
      const dirty = { maxRatio: 10, localClean: false, askCapIncludesExternal: inc };
      const noAsk = { bidMilli: null, askMilli: null, baseMilli: null };
      assert.deepStrictEqual(mergePriceRefs(noAsk, jitaRef, clean),
        { refs: { bidMilli: 3780, askMilli: 3950, baseMilli: null, origin: "external" }, extRejected: null });
      assert.deepStrictEqual(mergePriceRefs(noAsk, jitaRef, dirty), { refs: null, extRejected: null });
    }
    const D = DEFAULTS.trade;
    const q = quote(mergePriceRefs(local, jitaRef, { maxRatio: 10 }).refs, { premiumPermille: D.premiumPermille,
      askCapPermille: D.askCapPermille, maxUnitPriceMilli: D.maxUnitPriceMilli });
    assert.ok(q.ok, JSON.stringify(q));
    assert.strictEqual(q.unitMilli, Math.floor((3780 * D.premiumPermille) / 1000));
    assert.strictEqual(q.unitMilli, 4158);
    assert.strictEqual(q.capped, false);
  });

  needsDriver("EP4 run: fetch without waiting, origin external, cap under local ask, file, restart, failure, stale",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const dataDir = tmpDir();
      const file = path.join(dataDir, "trade", "external-prices.json");
      const OVR = { externalPriceEnabled: true, externalPriceRefreshMs: 6 * HOUR, externalPriceRetryMs: HOUR,
        externalPriceMaxAgeMs: 48 * HOUR };
      try {
        const net = fakeFetch();
        const adapter = { ...createFakeTradeAdapter(), readTradePrices: localSeam(), fetchExternalPrices: net.fetch };
        const a = boot(opened, shared, adapter, OVR, { dataDir });
        assert.strictEqual(a.trade.getStatus().executor.config.externalPriceEnabled, true);

        await a.firePass();
        assert.strictEqual(net.calls.length, 1);
        assert.strictEqual(net.calls[0].stationId, 60003760);
        assert.deepStrictEqual(net.calls[0].typeIds, [34, 35, 36, 37, 38, 39, 40]);
        assert.strictEqual(a.trade.getStatus().externalPrices.state, "fetching");
        assert.strictEqual(a.trade.getPriceCache().peek(34, shared.clock.now()).origin, "local");

        net.resolveLast(jita([[34, { bidMilli: 3780, askMilli: 3950 }]], [[35, "MISSING"]]));
        await settle();
        const keyBefore = a.view.cacheKey();
        let ext = a.trade.getStatus().externalPrices;
        assert.strictEqual(ext.state, "ready");
        assert.strictEqual(ext.fetched, 1);
        assert.deepStrictEqual(ext.rejectedByReason, { MISSING: 1 });
        const fetchedAt = ext.fetchedAt;

        shared.clock.advance(60000);
        await a.firePass();
        assert.strictEqual(net.calls.length, 1, "no second fetch");
        const refs34 = a.trade.getPriceCache().peek(34, shared.clock.now());
        assert.deepStrictEqual(refs34, { bidMilli: 3780, askMilli: 100000, baseMilli: 4000, origin: "external" });
        assert.strictEqual(a.trade.getPriceCache().peek(35, shared.clock.now()).origin, "local");
        const prices = a.trade.getStatus().executor.prices;
        assert.strictEqual(prices.lastExternal, 1);
        assert.strictEqual(prices.lastReadAborted, null);
        const q = opened.store.transaction("test.review", (db) => a.trade.readForReview(db, F,
          { stations: [], at: shared.clock.now(), limit: 10 }));
        assert.ok(q.ok && q.value.ok, JSON.stringify(q));
        const q34 = q.value.trade.quotes["type:34"];
        assert.strictEqual(q34.capMilli, Math.floor((100000 * DEFAULTS.trade.askCapPermille) / 1000),
          "Cap from the local 100 ISK, not from the Jita ask");
        assert.strictEqual(q34.unitMilli, Math.floor((3780 * DEFAULTS.trade.premiumPermille) / 1000), JSON.stringify(q34));
        assert.notStrictEqual(a.view.cacheKey(), keyBefore, "price refresh changes the panel key");
        const panel = a.view.getData();
        assert.strictEqual(panel.externalPrices.fetchedAt, fetchedAt);
        assert.strictEqual(panel.priceRefresh.lastExternal, 1);

        await waitFor(() => fs.existsSync(file), "snapshot file");
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        assert.deepStrictEqual(saved, { schemaVersion: 1, source: "fuzzwork", stationId: 60003760, fetchedAt,
          prices: { 34: { bidMilli: 3780, askMilli: 3950 } } });
        a.trade.stop();

        const net2 = fakeFetch();
        const b = boot(opened, shared, { ...createFakeTradeAdapter(), readTradePrices: localSeam(),
          fetchExternalPrices: net2.fetch }, OVR, { dataDir });
        await b.firePass();
        assert.strictEqual(net2.calls.length, 0, "no fetch after restart before refreshMs");
        ext = b.view.getData().externalPrices;
        assert.strictEqual(ext.fetchedAt, fetchedAt);
        assert.strictEqual(ext.ageMs, shared.clock.now() - fetchedAt);
        assert.strictEqual(ext.nextFetchAt, fetchedAt + 6 * HOUR);
        assert.strictEqual(b.trade.getPriceCache().peek(34, shared.clock.now()).origin, "external");

        shared.clock.advance(48 * HOUR + 1);
        await b.firePass();
        assert.strictEqual(net2.calls.length, 1);
        net2.resolveLast({ ok: false, reason: "EXT_TRANSPORT", detail: "ENOTFOUND" });
        await settle();
        ext = b.trade.getStatus().externalPrices;
        assert.strictEqual(ext.stale, true);
        assert.deepStrictEqual(ext.failuresByReason, { EXT_TRANSPORT: 1 });
        assert.strictEqual(ext.lastError, "EXT_TRANSPORT ENOTFOUND");
        assert.strictEqual(b.trade.getPriceCache().peek(34, shared.clock.now()).origin, "local");
        shared.clock.advance(HOUR - 1);
        await b.firePass();
        assert.strictEqual(net2.calls.length, 1, "no fetch before retryMs");
        shared.clock.advance(1);
        await b.firePass();
        assert.strictEqual(net2.calls.length, 2, "fetch again after retryMs");
        b.trade.stop();
        assert.strictEqual(b.trade.getStatus().externalPrices.state, "stopped");
        net2.resolveLast(jita([[34, { bidMilli: 1, askMilli: 2 }]]));
        await settle();
        assert.strictEqual(b.trade.getStatus().externalPrices.fetched, 0, "result after stop ignored");
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }));

  needsDriver("EP5 default on; explicit false never fetches; default + no seam -> no_seam; cleanup mode off",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      assert.strictEqual(DEFAULTS.trade.externalPriceEnabled, true, "default on");
      const net = fakeFetch();
      const adapter = { ...createFakeTradeAdapter(), readTradePrices: localSeam(), fetchExternalPrices: net.fetch };
      const a = boot(opened, shared, adapter, { externalPriceEnabled: false });
      await a.firePass();
      shared.clock.advance(7 * 24 * HOUR);
      await a.firePass();
      assert.strictEqual(net.calls.length, 0, "no fetch with the flag off");
      assert.deepStrictEqual(a.trade.getStatus().externalPrices, { state: "off", reason: "disabled" });
      assert.strictEqual(a.trade.getPriceCache().peek(34, shared.clock.now()).origin, "local");
      a.trade.stop();

      const n = boot(opened, shared, { ...createFakeTradeAdapter(), readTradePrices: localSeam() }, {});
      await n.firePass();
      assert.deepStrictEqual(n.trade.getStatus().externalPrices, { state: "off", reason: "no_seam" });
      n.trade.stop();

      const dataDir = tmpDir();
      try {
        const d = boot(opened, shared, adapter, {}, { dataDir });
        await d.firePass();
        assert.strictEqual(net.calls.length, 1, "default config fetches once");
        assert.strictEqual(d.trade.getStatus().externalPrices.state, "fetching");
        d.trade.stop();
        net.resolveLast({ ok: false, reason: "EXT_TRANSPORT", detail: "offline" });
        await settle();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }

      for (const [flag, reason] of [[false, "disabled"], [true, "mode_not_run"]]) {
        const c = boot(opened, shared, adapter, { enabled: false, cleanupOnDisable: true, externalPriceEnabled: flag });
        assert.strictEqual(c.trade.getMode(), "cleanup");
        await c.firePass();
        assert.deepStrictEqual(c.trade.getStatus().externalPrices, { state: "off", reason });
        c.trade.stop();
      }
      assert.strictEqual(net.calls.length, 1, "cleanup mode never fetches");
    }));

  needsDriver("EP6 aborted local read keeps the cached local cap (no Jita-only entry)",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const dataDir = tmpDir();
      try {
        let down = false;
        const marketDaemon = {
          call: async (method) => {
            if (down) throw Object.assign(new Error("timeout"), { code: "MARKET_DAEMON_RPC_TIMEOUT" });
            return method === "GetOrders" ? { buys: [{ price: 2.5 }], sells: [{ price: 3 }] } : [];
          },
        };
        const industryPricing = { resolveAdjustedAverageTypePrice: () => 4 };
        const net = fakeFetch();
        const adapter = { ...createFakeTradeAdapter(), fetchExternalPrices: net.fetch,
          readTradePrices: (spec) => readTradePricesFrom(marketDaemon, industryPricing, spec) };
        const a = boot(opened, shared, adapter, { externalPriceEnabled: true }, { dataDir });
        await a.firePass();
        assert.deepStrictEqual(a.trade.getPriceCache().peek(34, shared.clock.now()),
          { bidMilli: 2500, askMilli: 3000, baseMilli: 4000, origin: "local" });
        net.resolveLast(jita([[34, { bidMilli: 3780, askMilli: 3950 }]]));
        await settle();
        assert.strictEqual(a.trade.getStatus().externalPrices.state, "ready");

        down = true;
        shared.clock.advance(60000);
        await a.firePass();
        const prices = a.trade.getStatus().executor.prices;
        assert.strictEqual(prices.lastReadAborted, "MARKET_DAEMON_RPC_TIMEOUT");
        assert.strictEqual(prices.lastExternal, 0);
        const refs34 = a.trade.getPriceCache().peek(34, shared.clock.now());
        assert.strictEqual(refs34.askMilli, 3000, "cap stays the local ask, not the Jita ask 3950");
        assert.strictEqual(refs34.origin, "local");
        a.trade.stop();
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }));

  test("EP7 snapshot file: CROSSED / TOO_HIGH refused on load, valid entry loaded", () => {
    const fakeFs = (prices) => {
      const text = JSON.stringify({ schemaVersion: 1, source: "fuzzwork", stationId: 60003760, fetchedAt: 1000, prices });
      return { statSync: () => ({ size: text.length }), readFileSync: () => text };
    };
    const opts = (prices) => ({ stationId: 60003760, now: 2000, maxBytes: 1 << 20, maxUnitPriceMilli: 1000000,
      fs: fakeFs(prices) });
    const ok = loadSnapshotSync("x.json", opts({ 34: { bidMilli: 3780, askMilli: 3950 } }));
    assert.ok(ok.ok && ok.snapshot.prices.get(34).askMilli === 3950, JSON.stringify(ok));
    assert.deepStrictEqual(loadSnapshotSync("x.json", opts({ 34: { bidMilli: 3951, askMilli: 3950 } })),
      { ok: false, reason: "EXT_FILE_BAD_SHAPE", detail: "type 34 CROSSED" });
    assert.deepStrictEqual(loadSnapshotSync("x.json", opts({ 34: { bidMilli: 3780, askMilli: 1000001 } })),
      { ok: false, reason: "EXT_FILE_BAD_SHAPE", detail: "type 34 TOO_HIGH" });
    assert.deepStrictEqual(loadSnapshotSync("x.json",
      opts({ 34: { bidMilli: Number.MAX_SAFE_INTEGER - 1, askMilli: Number.MAX_SAFE_INTEGER } })),
    { ok: false, reason: "EXT_FILE_BAD_SHAPE", detail: "type 34 TOO_HIGH" });
  });
};
