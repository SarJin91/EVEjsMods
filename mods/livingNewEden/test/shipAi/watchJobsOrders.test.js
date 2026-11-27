"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { readMarketOrdersFrom, readOrderStateFrom } = require("../../lib/adapter/shipAiDbRead");
const { createShipAiEventsRepository, watchKeepMsOf } = require("../../lib/shipAi/events");
const { createShipAiWatch } = require("../../lib/shipAi/watch");
const { jobEvents, orderEvents } = require("../../lib/shipAi/watch/sources");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OTHER = 9002;
const T0 = 1700000000000;
const MINUTE = 60000;
const HOUR = 3600000;
const RIFTER = 587;
const TRIT = 34;
const NAMES = { [RIFTER]: "Rifter", [TRIT]: "Tritanium" };
const nameOf = (t) => NAMES[t] || null;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const NOTIMER = () => ({ cancel() {}, hasRef: () => false });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

function ordersRig(store) {
  const M = settings({ watchDisabledKinds: "SKILL_DONE,MISSION_EXPIRING,JOB_READY,MISSION_OBJECTIVE",
    walletWatchEnabled: false, queueWatchEnabled: false });
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const online = new Set();
  const asks = [];
  const states = [];
  const offers = [];
  const toolDeps = {
    ordersRaw: (playerId, max) => {
      const d = deferred();
      asks.push({ playerId, max, d });
      return d.promise;
    },
    orderState: (playerId, orderId) => {
      states.push([playerId, orderId]);
      return Promise.resolve({ ok: true, state: "filled", side: "sell", typeId: TRIT, total: 100, changedAtMs: null });
    },
    typeName: nameOf,
  };
  const watch = createShipAiWatch({ S: M, store, eventsRepo: createShipAiEventsRepository(M), toolDeps,
    readPresence: () => ({ ok: true, characters: [...online].map((characterId) => ({ characterId })) }),
    isWatched: () => true, isAllowed: () => true, isQuiet: () => false,
    offer: (playerId, events) => {
      offers.push([playerId, events.map((e) => e.key)]);
      return { queued: events.length };
    },
    nowMs: clock.now, perfNow: () => 0, setTimer: NOTIMER });
  assert.deepStrictEqual(watch.start(), { ok: true, running: true });
  return { M, watch, clock, online, asks, states, offers };
}

module.exports = ({ test, skip }) => {
  test("WJ1 jobEvents: ready in the window -> JOB_READY; ready older than the lookback, paused, not ready -> none; "
    + "nextDueAt = the nearest future end + 1 s", () => {
    const lookback = 6 * HOUR;
    const job = (jobId, over) => ({ jobId, activityId: 1, productTypeId: RIFTER, runs: 3, ready: false,
      endAtMs: T0, ...over });
    const out = jobEvents([job(1, { ready: true, endAtMs: T0 - 10 * MINUTE }),
      job(2, { ready: true, endAtMs: T0 - lookback - 1 }), job(3, { endAtMs: T0 - 5 * MINUTE }),
      job(4, { endAtMs: T0 + 40 * MINUTE }), job(5, { endAtMs: T0 + 20 * MINUTE }),
      job(6, { ready: true, endAtMs: null }), job(null, { ready: true, endAtMs: T0 - MINUTE })], T0, lookback, nameOf);
    assert.deepStrictEqual(out.events, [{ kind: "JOB_READY", key: "job:1", payload: { activity: "manufacturing",
      product: "Rifter", runs: 3 }, occurredAt: T0 - 10 * MINUTE }], "2 too old, 3 paused, 6/7 no end / no ID");
    assert.strictEqual(out.nextDueAt, T0 + 20 * MINUTE + 1000, "the nearest future end + 1 s");
    assert.deepStrictEqual(jobEvents([job(1, { endAtMs: T0 - MINUTE })], T0, lookback, nameOf),
      { events: [], nextDueAt: null });
  });

  test("WO1 orderEvents: baseline = 0 vanished and the closed of the window give events; a gone order = vanished; "
    + "cancelled = no event; a cut list = no vanished", () => {
    const lookback = 6 * HOUR;
    const closed = [
      { orderId: 11, side: "sell", typeId: TRIT, total: 100, state: "filled", changedAtMs: T0 - 5 * MINUTE },
      { orderId: 12, side: "buy", typeId: RIFTER, total: 2, state: "expired", changedAtMs: T0 - HOUR },
      { orderId: 13, side: "sell", typeId: TRIT, total: 5, state: "cancelled", changedAtMs: T0 - MINUTE },
      { orderId: 14, side: "sell", typeId: TRIT, total: 5, state: "filled", changedAtMs: T0 - lookback - 1 },
      { orderId: 15, side: "sell", typeId: TRIT, total: 5, state: "filled", changedAtMs: null }];
    const first = orderEvents(null, { orders: [{ orderId: 21, remaining: 5 }, { orderId: 22, remaining: 1 }], closed,
      more: 0 }, T0, lookback, nameOf);
    assert.deepStrictEqual(first.events, [
      { kind: "ORDER_FILLED", key: "order:12:expired", payload: { side: "buy", item: "Rifter", total: 2,
        state: "expired" }, occurredAt: T0 - HOUR },
      { kind: "ORDER_FILLED", key: "order:11:filled", payload: { side: "sell", item: "Tritanium", total: 100,
        state: "filled" }, occurredAt: T0 - 5 * MINUTE }], "13 cancelled, 14 too old, 15 no change time");
    assert.deepStrictEqual([first.vanished, [...first.open.keys()], first.cancelled], [[], [21, 22], 0]);
    const second = orderEvents(first.open, { orders: [], closed: [...closed, { orderId: 21, side: "sell", typeId: TRIT,
      total: 5, state: "cancelled", changedAtMs: T0 }], more: 0 }, T0, lookback, nameOf);
    assert.deepStrictEqual([second.vanished, second.open.size, second.cancelled], [[22], 0, 1],
      "22 gone from both lists; 21 cancelled (no event)");
    assert.ok(!second.events.some((e) => e.key.startsWith("order:21:")));
    const cut = orderEvents(first.open, { orders: [{ orderId: 21, remaining: 5 }], closed: [], more: 3 }, T0, lookback,
      nameOf);
    assert.deepStrictEqual([cut.vanished, [...cut.open.keys()].sort()], [[], [21, 22]], "a cut list keeps 22");
  });

  test("WO3 adapter: includeClosed -> orders as without it, closed own only; readOrderStateFrom NOT_OWNER, TIMEOUT, "
    + "NOT_FOUND, an own filled order", async () => {
    const iso = new Date(T0 - MINUTE).toISOString();
    const answer = [
      { order_id: "1", state: "open", owner_id: PLAYER, is_corp: false, row: { order_id: "1", type_id: TRIT,
        station_id: 60003760, bid: false, price: 5, vol_entered: 100, vol_remaining: 40 } },
      { order_id: "2", state: "filled", owner_id: PLAYER, is_corp: false, last_state_change_at: iso,
        row: { order_id: "2", type_id: RIFTER, bid: true, price: 1, vol_entered: 2, vol_remaining: 0 } },
      { order_id: "3", state: "filled", owner_id: OTHER, is_corp: false, last_state_change_at: iso,
        row: { order_id: "3", type_id: TRIT, price: 1, vol_entered: 1, vol_remaining: 0 } },
      { order_id: "4", state: "expired", owner_id: PLAYER, is_corp: true, last_state_change_at: iso,
        row: { order_id: "4", type_id: TRIT, price: 1, vol_entered: 1, vol_remaining: 1 } },
      { order_id: "5", state: "cancelled", owner_id: PLAYER, is_corp: false, last_state_change_at: "nonsense",
        row: { order_id: "5", type_id: TRIT, price: 1, vol_entered: 7, vol_remaining: 7 } }];
    const daemon = { call: (method) => Promise.resolve(method === "GetCharOrders" ? answer : null) };
    const opts = { maxRows: 8, timeoutMs: 3000, setTimeoutFn: () => {} };
    const plain = await readMarketOrdersFrom({ marketDaemon: daemon }, PLAYER, opts);
    const withClosed = await readMarketOrdersFrom({ marketDaemon: daemon }, PLAYER, { ...opts, includeClosed: true });
    assert.deepStrictEqual(plain, { ok: true, more: 0, orders: [{ side: "sell", typeId: TRIT, priceIsk: 5,
      remaining: 40, total: 100, stationId: 60003760, orderId: 1 }] });
    assert.ok(!("closed" in plain), "no closed list without includeClosed");
    assert.deepStrictEqual(withClosed.orders, plain.orders, "orders unchanged");
    assert.deepStrictEqual(withClosed.closed, [
      { orderId: 2, side: "buy", typeId: RIFTER, total: 2, state: "filled", changedAtMs: T0 - MINUTE },
      { orderId: 5, side: "sell", typeId: TRIT, total: 7, state: "cancelled", changedAtMs: null }],
    "foreign owner_id and is_corp out");

    const asked = [];
    const one = (o) => ({ call: (method, params) => {
      asked.push([method, params]);
      return typeof o === "function" ? o() : Promise.resolve(o);
    } });
    const own = { order_id: "7", state: "filled", owner_id: PLAYER, is_corp: false, last_state_change_at: iso,
      row: { order_id: "7", type_id: TRIT, bid: false, vol_entered: 50 } };
    assert.deepStrictEqual(await readOrderStateFrom({ marketDaemon: one(own) }, PLAYER, 7, opts), { ok: true,
      state: "filled", side: "sell", typeId: TRIT, total: 50, changedAtMs: T0 - MINUTE });
    assert.deepStrictEqual(asked, [["GetOrder", { order_id: "7" }]], "the order_id text of fetchOrderById");
    assert.deepStrictEqual(await readOrderStateFrom({ marketDaemon: one({ ...own, owner_id: OTHER }) }, PLAYER, 7,
      opts), { ok: false, reason: "NOT_OWNER" });
    assert.deepStrictEqual(await readOrderStateFrom({ marketDaemon: one({ ...own, is_corp: true }) }, PLAYER, 7,
      opts), { ok: false, reason: "NOT_OWNER" });
    assert.deepStrictEqual(await readOrderStateFrom({ marketDaemon: one(() => Promise.reject(
      new Error("order 7 not found"))) }, PLAYER, 7, opts), { ok: false, reason: "NOT_FOUND" });
    assert.deepStrictEqual(await readOrderStateFrom({ marketDaemon: one({ state: "filled" }) }, PLAYER, 7, opts),
      { ok: false, reason: "SEAM_UNAVAILABLE" }, "another shape");
    let fire = null;
    const pending = readOrderStateFrom({ marketDaemon: one(() => new Promise(() => {})) }, PLAYER, 7,
      { timeoutMs: 3000, setTimeoutFn: (cb) => { fire = cb; } });
    await flush();
    fire();
    assert.deepStrictEqual(await pending, { ok: false, reason: "TIMEOUT" });
  });

  test("WO4 vendor facts: mapOwnerOrderStateCode, call(\"GetOrder\", the open filter of Handle_GetCharOrders, jobID "
    + "of listJobsByOwner; marketWatchMs default", () => {
    const src = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const from = (text, head, len) => {
      const at = text.indexOf(head);
      assert.ok(at >= 0, head);
      return text.slice(at, at + len);
    };
    const mp = src(path.join("services", "market", "marketProxyService.js"));
    const codes = from(mp, "function mapOwnerOrderStateCode(state) {", 300);
    for (const s of ["\"filled\"", "\"expired\"", "\"cancelled\""]) assert.ok(codes.includes(`case ${s}:`), s);
    assert.ok(from(mp, "async function fetchOrderById(orderID) {", 160).includes("marketDaemonClient.call(\"GetOrder\""));
    assert.ok(/order_id: normalizeOrderId\(orderID\)/.test(from(mp, "async function fetchOrderById(orderID) {", 160)));
    assert.ok(mp.includes("`order ${normalizeOrderId(orderID)} not found`"), "the text of a missing order");
    const handler = from(mp, "async Handle_GetCharOrders(args, session) {", 900);
    assert.ok(/state : "open"\)\.toLowerCase\(\) === "open"/.test(handler), "the open filter (the daemon sends more)");
    const ir = src(path.join("services", "industry", "industryRuntimeState.js"));
    assert.ok(from(ir, "function listJobsByOwner(ownerID, includeCompleted = false) {", 1000)
      .includes(".sort((left, right) => left.jobID - right.jobID)"), "jobID");
    assert.strictEqual(base.shipAi.marketWatchMs, 300000);
  });

  const driver = SH.loadDriver();
  const names = {
    wo2: "WO2 watch async: a pending ordersRaw blocks the second read (marketBusy), the vanished order + orderState "
      + "filled -> one ORDER_FILLED row and offer; stop() before the answer -> no row",
    w7: "W7: a watch row older than watchKeepMsOf and past the newest eventsKeep watch rows "
      + "is deleted, the others stay",
  };
  if (!driver.ok) {
    for (const n of [names.wo2, names.w7]) skip(n, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test(names.wo2, () => SH.withStoreAsync(driver, async ({ store }) => {
    const r = ordersRig(store);
    assert.strictEqual(r.M.marketWatchMs, 300000, "marketWatchMs reaches the model settings");
    const repo = createShipAiEventsRepository(r.M);
    const rows = () => {
      const res = store.transaction("t.wo2", (db) => repo.listRecent(db, PLAYER, 50));
      assert.ok(res.ok && res.value.ok);
      return res.value.rows.map((x) => x.key);
    };
    r.online.add(PLAYER);
    r.online.add(OTHER);
    r.watch.runPass();
    r.clock.advance(r.M.watchLoginDelayMs);
    r.watch.runPass();
    assert.deepStrictEqual(r.asks.map((a) => a.playerId), [PLAYER], "one daemon request at a time");
    assert.deepStrictEqual([r.watch.getStatus().counters.reads, r.watch.getStatus().counters.marketBusy], [1, 1]);
    r.watch.runPass();
    assert.strictEqual(r.asks.length, 1, "still in flight: no second read");
    r.asks[0].d.resolve({ ok: true, orders: [{ orderId: 31, remaining: 10 }], closed: [], more: 0 });
    await flush();
    assert.deepStrictEqual([r.offers, rows()], [[], []], "the baseline gives no event");
    r.clock.advance(r.M.watchPollMs);
    r.watch.runPass();
    assert.deepStrictEqual(r.asks.map((a) => a.playerId), [PLAYER, OTHER], "OTHER read after the flag cleared");
    r.asks[1].d.resolve({ ok: true, orders: [], closed: [], more: 0 });
    await flush();
    r.clock.advance(r.M.marketWatchMs - r.M.watchPollMs - 1);
    r.watch.runPass();
    assert.strictEqual(r.asks.length, 2, "not before marketWatchMs");
    r.clock.advance(1);
    r.watch.runPass();
    assert.strictEqual(r.asks.length, 3);
    r.asks[2].d.resolve({ ok: true, orders: [], closed: [], more: 0 });
    await flush();
    assert.deepStrictEqual(r.states, [[PLAYER, 31]]);
    assert.deepStrictEqual(r.offers, [[PLAYER, ["order:31:filled"]]]);
    assert.deepStrictEqual(rows(), ["order:31:filled"]);
    assert.strictEqual(r.watch.getStatus().counters.events, 1);
    r.clock.advance(r.M.watchRescanMs);
    r.watch.runPass();
    assert.strictEqual(r.asks.length, 4);
    r.watch.stop();
    r.asks[3].d.resolve({ ok: true, orders: [], more: 0, closed: [{ orderId: 41, side: "sell", typeId: TRIT,
      total: 1, state: "filled", changedAtMs: r.clock.now() - MINUTE }] });
    await flush();
    assert.deepStrictEqual([r.offers.length, rows()], [1, ["order:31:filled"]], "a late answer is dropped");
  }));

  test(names.w7, () => SH.withStore(driver, ({ store }) => {
    const M = settings({ eventsKeep: 2 });
    const repo = createShipAiEventsRepository(M);
    const keepMs = watchKeepMsOf(M);
    assert.strictEqual(keepMs, M.watchLookbackMs, "6 h at the defaults");
    const note = (key, nowMs) => {
      const res = store.transaction("t.w7", (db) => repo.noteEventInTx(db, { playerId: PLAYER, kind: "JOB_READY", key,
        payload: {}, nowMs }));
      assert.ok(res.ok && res.value.ok, JSON.stringify(res));
      return res.value.pruned;
    };
    const keys = () => store.transaction("t.w7", (db) => repo.listRecent(db, PLAYER, 50)).value.rows
      .map((x) => x.key).sort();
    for (const k of ["job:1", "job:2", "job:3"]) assert.strictEqual(note(k, T0), 0, "younger than keepMs");
    assert.deepStrictEqual(keys(), ["job:1", "job:2", "job:3"], "past eventsKeep but inside the window: kept");
    assert.strictEqual(note("job:4", T0 + keepMs + 1), 2, "older than keepMs and past the newest 2: deleted");
    assert.deepStrictEqual(keys(), ["job:3", "job:4"], "job:3 is one of the newest eventsKeep watch rows");
  }));
};
