"use strict";

const assert = require("node:assert");

const R = require("../../lib/world/devIndices/rules");
const { createDevIndicesRepository } = require("../../lib/world/devIndices/repository");
const { createMemoryIndex } = require("../../lib/world/devIndices/memoryIndex");
const { createInvest, backoffMs, iskText } = require("../../lib/world/devIndices/invest");
const IC = require("../../lib/world/devIndices/investCommand");
const { startDevIndices } = require("../../lib/world/devIndices");
const { loadDriver, withStoreAsync } = require("../notices/storeHelper");
const F = require("./fixture");

const A = 500001;
const CHAR = 90000001;
const INVEST_ENV = Object.freeze({ EVEJS_LNE_DEV_INDICES_INVEST_ENABLED: "1" });

function fakeIds(tag = "t") {
  let n = 0;
  return { next: (prefix) => `${prefix}_${tag}_${String((n += 1)).padStart(4, "0")}_aaaa` };
}

function wallet(script) {
  const calls = [];
  return { calls, adjust: async (spec) => {
    calls.push(spec);
    return script[Math.min(calls.length - 1, script.length - 1)];
  } };
}

function rig(store, opts = {}) {
  const P = F.settingsFor({ ...INVEST_ENV, ...(opts.env || {}) });
  const memory = opts.memory || createMemoryIndex({ P, clock: { now: () => F.T0 } });
  memory.markWarm();
  const world = opts.world || F.makeWorld({ 1: { controllerFactionId: A, occupationState: "STABLE" } });
  const w = wallet(opts.script || [{ ok: true, duplicate: false }]);
  const lines = [];
  const counts = {};
  const invest = createInvest({ store, repo: createDevIndicesRepository(), memory, settings: P, ids: opts.ids || fakeIds(),
    tradeAdjustWallet: w.adjust, sendCharacterSystemLine: (spec) => {
      lines.push(spec);
      return { ok: true };
    }, getWorldRepository: () => world, systemNameOf: (id) => `Sys${id}`,
    bump: (name, n = 1) => {
      counts[name] = (counts[name] || 0) + n;
    } });
  return { P, invest, memory, wallet: w, lines, counts };
}

function q(store, sql, ...args) {
  const r = store.transaction("test.di7.q", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const ask = (h, spec) => h.invest.request({ characterId: CHAR, systemId: 1, kind: "mil", amount: 10000000,
  nonce: "n1", now: F.T0, ...spec });

module.exports = ({ test, skip }) => {
  test("DI8 !invest: parser table, UNSAFE_TRANSPORT, yes without a request / expired, second yes DUPLICATE, install", () => {
    const table = [["50m", 50000000], ["1.5b", 1500000000], ["2000000", 2000000], ["10k", 10000], ["2.5M", 2500000],
      [" 7k ", 7000], ["1.5", null], ["-5m", null], ["abc", null], ["0", null], ["1.2345k", null], ["5 m", null],
      ["9999999999999999b", null], ["", null], [null, null]];
    assert.deepStrictEqual(table.map(([t]) => R.parseInvestAmount(t)), table.map(([, v]) => v));
    const P = F.settingsFor(INVEST_ENV);
    assert.strictEqual(R.investPoints(10000000, P), 200);

    const now = { t: F.T0 };
    const seen = new Set();
    const requests = [];
    const sagas = [];
    const counts = {};
    const fakeInvest = { iskText,
      request: (spec) => {
        requests.push(spec);
        if (seen.has(spec.nonce)) return { ok: false, reason: "DUPLICATE" };
        seen.add(spec.nonce);
        return { ok: true, investId: `di_${requests.length}`, points: 200 };
      },
      runSaga: (id) => {
        sagas.push(id);
        return Promise.resolve({ ok: true, state: "APPLIED" });
      } };
    const chat = IC.createInvestChat({ invest: fakeInvest, settings: P, clock: { now: () => now.t }, ids: fakeIds(),
      isRunning: () => true, systemNameOf: (id) => `Sys${id}`, controllerNameOf: () => "Amarr Empire",
      secClassOf: (id) => (id === 4 ? "wormhole" : "highsec"), bump: (name) => {
        counts[name] = (counts[name] || 0) + 1;
      } });
    const rec = { characterId: CHAR, systemId: 1 };
    const xmpp = { transport: "xmpp" };
    assert.strictEqual(chat.handle(rec, "!invest", xmpp), IC.TEXT.usage);
    assert.strictEqual(chat.handle(rec, "!invest mil 10m", { transport: "gateway" }), IC.TEXT.unsafe);
    assert.strictEqual(chat.handle(rec, "!invest mil 10m", undefined), IC.TEXT.unsafe, "no ctx = not private");
    assert.strictEqual(counts["invest.unsafeTransport"], 2);
    assert.strictEqual(chat.handle(rec, "!invest yes", xmpp), IC.TEXT.noRequest);
    assert.strictEqual(chat.handle(rec, "!invest foo 10m", xmpp), IC.TEXT.usage);
    assert.strictEqual(chat.handle(rec, "!invest mil xyz", xmpp), IC.TEXT.usage);
    assert.strictEqual(chat.handle({ characterId: CHAR, systemId: 4 }, "!invest mil 10m", xmpp), IC.TEXT.secClass);
    assert.match(chat.handle(rec, "!invest mil 500k", xmpp), /^Invest: at least 1,000,000 ISK$/);
    assert.match(chat.handle(rec, "!invest mil 200m", xmpp), /^Invest: at most 100,000,000 ISK per command$/);

    const offer = chat.handle(rec, "!INVEST Mil 10m", xmpp);
    assert.strictEqual(offer, "Invest 10,000,000 ISK in Sys1 (controller Amarr Empire) for MIL +200 points? "
      + "Type !invest yes within 60s. ISK is spent, no refund.");
    assert.strictEqual(chat.handle({ characterId: CHAR, systemId: 2 }, "!invest yes", xmpp), IC.TEXT.moved);
    assert.strictEqual(chat.handle(rec, "!invest yes", xmpp), "Invest: 10,000,000 ISK for MIL in Sys1 - processing");
    assert.deepStrictEqual([requests.length, sagas], [1, ["di_1"]]);
    assert.deepStrictEqual({ ...requests[0], nonce: typeof requests[0].nonce },
      { characterId: CHAR, systemId: 1, kind: "mil", amount: 10000000, nonce: "string", now: F.T0 });
    assert.strictEqual(chat.handle(rec, "!invest yes", xmpp), "Invest refused (DUPLICATE)", "same nonce again");
    assert.strictEqual(requests[1].nonce, requests[0].nonce);
    now.t += P.investConfirmMs + 1;
    assert.strictEqual(chat.handle(rec, "!invest yes", xmpp), IC.TEXT.noRequest, "expired");
    assert.deepStrictEqual([counts["invest.requested"], counts["invest.limit"], sagas.length], [1, 2, 1]);

    const installs = [];
    const adapter = { installChatCommand: (o) => {
      installs.push(o.name);
      return { ok: true };
    }, uninstallChatCommand: (name) => installs.push(`-${name}`), tradeAdjustWallet: async () => ({ ok: true }) };
    const timers = { setTimer: () => ({ cancel() {}, hasRef: () => false }) };
    const start = (env, ids) => startDevIndices({ config: F.configOf(env).config, persistence: { ok: true, store: {} },
      clock: { now: () => F.T0 }, setTimer: timers.setTimer, adapter, ids });
    const on = start(INVEST_ENV, fakeIds());
    assert.strictEqual(on.ok, true, JSON.stringify(on));
    on.devIndices.stop("test");
    assert.deepStrictEqual(installs, ["dev", "invest", "-dev", "-invest"]);
    installs.length = 0;
    start(INVEST_ENV, null).devIndices.stop("test");
    assert.deepStrictEqual(installs, ["dev", "-dev"], "no ids -> no !invest");
  });

  test("DI10!invest headroom: at maximum refused before any request, over the headroom capped ()", () => {
    const P = F.settingsFor({ ...INVEST_ENV, EVEJS_LNE_DEV_INDICES_INVEST_MIN_ISK: "100000" });
    const requests = [];
    const sagas = [];
    const counts = {};
    let levels = null;
    const fakeInvest = { iskText, request: (spec) => {
      requests.push(spec);
      return { ok: true, investId: "di_x", points: spec.amount / P.investIskPerPoint };
    }, runSaga: (idOf) => {
      sagas.push(idOf);
      return Promise.resolve({ ok: true, state: "APPLIED" });
    } };
    const chat = IC.createInvestChat({ invest: fakeInvest, settings: P, clock: { now: () => F.T0 }, ids: fakeIds(),
      isRunning: () => true, systemNameOf: (sid) => `Sys${sid}`, controllerNameOf: () => "Amarr Empire",
      secClassOf: () => "highsec", levelsOf: () => levels, bump: (name) => {
        counts[name] = (counts[name] || 0) + 1;
      } });
    const rec = { characterId: CHAR, systemId: 1 };
    const xmpp = { transport: "xmpp" };
    levels = { milPoints: 0, indPoints: 0, tradePoints: P.maxPoints };
    assert.strictEqual(chat.handle(rec, "!invest trade 10m", xmpp), "Invest: TRADE in Sys1 is at maximum");
    assert.deepStrictEqual([chat.pendingCount(), counts["invest.atMax"], chat.handle(rec, "!invest yes", xmpp)],
      [0, 1, IC.TEXT.noRequest]);
    assert.deepStrictEqual([requests.length, sagas.length], [0, 0], "no request, no saga, no debit");
    levels = { milPoints: 0, indPoints: 0, tradePoints: P.maxPoints - 5 };
    const offer = chat.handle(rec, "!invest trade 1m", xmpp);
    assert.strictEqual(offer, `Invest ${iskText(5 * P.investIskPerPoint)} ISK in Sys1 (controller Amarr Empire) for `
      + "TRADE +5 points (capped at index maximum)? Type !invest yes within 60s. ISK is spent, no refund.");
    assert.strictEqual(counts["invest.capped"], 1);
    chat.handle(rec, "!invest yes", xmpp);
    assert.deepStrictEqual([requests[0].amount, requests[0].kind], [5 * P.investIskPerPoint, "trade"]);
    levels = null;
    assert.match(chat.handle(rec, "!invest mil 1m", xmpp), /MIL \+20 points\?/);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("DI7 invest saga on a store", `better-sqlite3 unavailable (${driver.detail})`);
    skip("DI10 APPLIED line with the real gain", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("DI10 saga at maxPoints - 2: the APPLIED line tells the real gain +2 ()", async () => {
    await withStoreAsync(driver, async ({ store }) => {
      const h = rig(store);
      const repo = createDevIndicesRepository();
      const seed = Object.freeze({ ...R.emptyRow(1, F.T0), mil: h.P.maxPoints - 2, controllerFactionId: A });
      const put = store.transaction("test.di10.seed", (db) => repo.upsertInTx(db, seed, F.T0));
      assert.ok(put.ok && put.value.ok, JSON.stringify(put));
      h.memory.put(put.value.row);
      const r = ask(h, { nonce: "cap" });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(await h.invest.runSaga(r.investId, F.T0), { ok: true, state: "APPLIED" });
      assert.deepStrictEqual(h.lines.map((l) => l.text), ["Invest: 10,000,000 ISK spent, MIL +2 (index maximum) in Sys1"]);
      assert.deepStrictEqual(q(store, "SELECT mil_points FROM world_system_dev"), [{ mil_points: h.P.maxPoints }]);
    });
  });

  test("DI7 saga: APPLIED once across a restart, REFUSED, transient retry with backoff, limits, prune", async () => {
    await withStoreAsync(driver, async ({ store }) => {
      const h = rig(store);
      const r1 = ask(h, {});
      assert.deepStrictEqual(r1, { ok: true, investId: "di_t_0001_aaaa", points: 200 });
      assert.deepStrictEqual(await h.invest.runSaga(r1.investId, F.T0), { ok: true, state: "APPLIED" });
      assert.deepStrictEqual(h.wallet.calls, [{ ownerKind: "character", ownerId: CHAR, deltaIsk: -10000000,
        commandId: "lne:dev:di_t_0001_aaaa", description: "LNE development investment" }]);
      assert.deepStrictEqual(q(store, "SELECT system_id, mil_points, invested_isk_total, controller_faction_id FROM "
        + "world_system_dev"), [{ system_id: 1, mil_points: 200, invested_isk_total: 10000000, controller_faction_id: A }]);
      assert.strictEqual(h.memory.levelsOf(1).milPoints, 200);
      assert.deepStrictEqual(h.lines.map((l) => l.text), ["Invest: 10,000,000 ISK spent, MIL +200 in Sys1"]);
      assert.deepStrictEqual(await h.invest.runSaga(r1.investId, F.T0), { ok: true, state: "APPLIED" });
      assert.strictEqual(h.wallet.calls.length, 1, "an APPLIED row is not debited again");
      assert.deepStrictEqual(ask(h, {}), { ok: false, reason: "DUPLICATE" }, "the same nonce");

      const broken = { getSystem: () => ({ ok: false, reason: "BOOM" }) };
      const h1 = rig(store, { world: broken, ids: { next: () => "di_restart" } });
      assert.strictEqual(ask(h1, { nonce: "n2", kind: "ind" }).ok, true);
      assert.deepStrictEqual(await h1.invest.runSaga("di_restart", F.T0),
        { ok: false, state: "PENDING", reason: "TX_ABORTED" });
      assert.strictEqual(h1.wallet.calls.length, 1);
      const h2 = rig(store, { script: [{ ok: true, duplicate: true }] });
      assert.deepStrictEqual(await h2.invest.resumeDue(F.T0 + 1000), { ok: true, resumed: 1 });
      assert.deepStrictEqual(await h2.invest.resumeDue(F.T0 + 2000), { ok: true, resumed: 0 });
      assert.deepStrictEqual(h2.wallet.calls.map((c) => c.commandId), ["lne:dev:di_restart"], "the same key");
      assert.deepStrictEqual(q(store, "SELECT state, attempts FROM world_dev_investments WHERE invest_id = ?",
        "di_restart"), [{ state: "APPLIED", attempts: 1 }]);
      assert.deepStrictEqual(q(store, "SELECT ind_points, invested_isk_total FROM world_system_dev"),
        [{ ind_points: 200, invested_isk_total: 20000000 }], "points once");

      const h3 = rig(store, { ids: { next: () => "di_poor" }, script: [{ ok: false, reason: "INSUFFICIENT_FUNDS",
        permanent: true }] });
      assert.strictEqual(ask(h3, { nonce: "n3", kind: "trade" }).ok, true);
      assert.deepStrictEqual(await h3.invest.runSaga("di_poor", F.T0),
        { ok: false, state: "REFUSED", reason: "INSUFFICIENT_FUNDS" });
      assert.deepStrictEqual(q(store, "SELECT state, end_reason FROM world_dev_investments WHERE invest_id = ?",
        "di_poor"), [{ state: "REFUSED", end_reason: "INSUFFICIENT_FUNDS" }]);
      assert.deepStrictEqual(q(store, "SELECT trade_points FROM world_system_dev"), [{ trade_points: 0 }]);
      assert.deepStrictEqual([h3.counts["invest.refused"], h3.lines[0].text],
        [1, "Invest refused (INSUFFICIENT_FUNDS) - no ISK taken"]);

      const h4 = rig(store, { ids: { next: () => "di_flaky" }, script: [{ ok: false, reason: "WALLET_FAILED",
        permanent: false }] });
      assert.strictEqual(ask(h4, { nonce: "n4", characterId: CHAR + 1 }).ok, true);
      assert.deepStrictEqual(await h4.invest.runSaga("di_flaky", F.T0),
        { ok: false, state: "PENDING", reason: "WALLET_FAILED" });
      const row = () => q(store, "SELECT state, attempts, next_attempt_at FROM world_dev_investments WHERE invest_id = ?",
        "di_flaky")[0];
      assert.deepStrictEqual(row(), { state: "PENDING", attempts: 1, next_attempt_at: F.T0 + 60000 });
      assert.deepStrictEqual(await h4.invest.resumeDue(F.T0 + 59999), { ok: true, resumed: 0 }, "not due yet");
      assert.deepStrictEqual(await h4.invest.resumeDue(F.T0 + 60000), { ok: true, resumed: 1 });
      assert.deepStrictEqual(row(), { state: "PENDING", attempts: 2, next_attempt_at: F.T0 + 60000 + 120000 });
      assert.strictEqual(h4.counts["invest.retry"], 2);
      assert.strictEqual(backoffMs(40, h4.P), h4.P.investRetryMaxMs, "capped");

      const h5 = rig(store, { env: { EVEJS_LNE_DEV_INDICES_INVEST_MAX_ISK_PER_CHARACTER_PER_DAY: "25000000",
        EVEJS_LNE_DEV_INDICES_INVEST_MAX_POINTS_PER_SYSTEM_PER_DAY: "1000" }, ids: fakeIds("L") });
      const L = (spec) => h5.invest.request({ characterId: 90000005, systemId: 3, kind: "ind", amount: 10000000,
        now: F.T0, ...spec }).reason || "OK";
      assert.deepStrictEqual([L({ nonce: "a", amount: 500000 }), L({ nonce: "b", amount: 200000000 }),
        L({ nonce: "c", amount: 20000000 }), L({ nonce: "d" }), L({ nonce: "e", characterId: 90000006, amount: 25000000 }),
        L({ nonce: "f", characterId: 90000007 }), L({ nonce: "g", now: F.T0 + 86400001 })],
      ["LIMIT_MIN", "LIMIT_COMMAND", "OK", "LIMIT_CHARACTER_DAY", "OK", "LIMIT_SYSTEM_DAY", "OK"]);
      assert.deepStrictEqual([h5.counts["invest.limit"], h5.counts["invest.confirmed"]], [4, 3]);

      const pruned = store.transaction("test.di7.prune", (db) => h.invest.pruneInTx(db,
        F.T0 + h.P.investRetentionMs + 10000));
      assert.deepStrictEqual(pruned.value, { ok: true, pruned: 3 });
      assert.deepStrictEqual(q(store, "SELECT state, count(*) AS n FROM world_dev_investments GROUP BY state"),
        [{ state: "PENDING", n: 4 }]);
    });
  });
};
