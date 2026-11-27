"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");
const {
  FUZZWORK_HOST, parseFuzzworkAggregates, createHttpsGetter, fetchExternalPricesWith,
} = require("../../lib/adapter/externalPrices");

const LIMITS = { maxUnitPriceMilli: 1000000000000 };

function agg(buyPercentile, sellPercentile) {
  return {
    buy: { weightedAverage: "3.5", max: "3.9", min: "0.01", stddev: "1", median: "3.6", volume: "1e10",
      orderCount: "100", percentile: buyPercentile },
    sell: { weightedAverage: "4.2", max: "100", min: "3.95", stddev: "1", median: "4.1", volume: "1e10",
      orderCount: "100", percentile: sellPercentile },
  };
}

function fakeHttps() {
  const calls = [];
  return {
    calls,
    get(opts, cb) {
      const req = new EventEmitter();
      req.destroyed = 0;
      req.destroy = () => { req.destroyed += 1; };
      const call = { opts, req, respond(statusCode) {
        const res = new EventEmitter();
        res.statusCode = statusCode;
        res.resumed = 0;
        res.resume = () => { res.resumed += 1; };
        cb(res);
        return res;
      } };
      calls.push(call);
      return req;
    },
  };
}

function manualTimeouts() {
  const made = [];
  return { made, timeoutSignal: (ms) => { const c = new AbortController(); made.push({ ms, c }); return c.signal; } };
}

function track(promise) {
  const t = { settled: 0, value: undefined };
  promise.then((v) => { t.settled += 1; t.value = v; });
  return t;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

module.exports = ({ test }) => {
  test("EP1a parser: percentiles -> milli, MISSING / NO_ASK / CROSSED / TOO_HIGH, bad JSON / shape", () => {
    const body = JSON.stringify({
      34: agg("3.78", "3.95"),
      35: agg("7.1", "0"),
      36: agg("50", "40"),
      37: agg("2000000000", "2000000001"),
      38: { buy: { percentile: "0" }, sell: { percentile: "12" } },
    });
    const r = parseFuzzworkAggregates(body, [34, 35, 36, 37, 38, 39], { maxUnitPriceMilli: 1000000000000 });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([...r.prices.entries()], [[34, { bidMilli: 3780, askMilli: 3950 }]]);
    assert.deepStrictEqual(Object.fromEntries(r.rejected), {
      35: "NO_ASK", 36: "CROSSED", 37: "TOO_HIGH", 38: "NO_BID", 39: "MISSING",
    });
    assert.deepStrictEqual(parseFuzzworkAggregates("{not json", [34], LIMITS), { ok: false, reason: "EXT_BAD_JSON" });
    assert.deepStrictEqual(parseFuzzworkAggregates("[1,2]", [34], LIMITS), { ok: false, reason: "EXT_BAD_SHAPE" });
    assert.deepStrictEqual(parseFuzzworkAggregates("null", [34], LIMITS), { ok: false, reason: "EXT_BAD_SHAPE" });
  });

  test("EP1b getter: 503 -> EXT_HTTP_STATUS, too large -> EXT_TOO_LARGE + destroy, timeout -> EXT_TIMEOUT, once",
    async () => {
      const https = fakeHttps();
      const timers = manualTimeouts();
      const get = createHttpsGetter({ https, timeoutSignal: timers.timeoutSignal });
      const req = { hostname: FUZZWORK_HOST, path: "/aggregates/?station=60003760&types=34", timeoutMs: 10000,
        maxBytes: 16 };

      const a = track(get(req));
      const resA = https.calls[0].respond(503);
      resA.emit("data", Buffer.from("busy"));
      resA.emit("end");
      https.calls[0].req.emit("error", Object.assign(new Error("late"), { code: "ECONNRESET" }));
      timers.made[0].c.abort();
      await tick();
      assert.strictEqual(a.settled, 1);
      assert.deepStrictEqual(a.value, { ok: false, reason: "EXT_HTTP_STATUS", detail: "503" });
      assert.strictEqual(resA.resumed, 1);
      assert.strictEqual(timers.made[0].ms, 10000, "timeout signal from timeoutMs");
      assert.deepStrictEqual(https.calls[0].opts.headers, { accept: "application/json",
        "user-agent": "LivingNewEden-EveJS-mod" });

      const b = track(get(req));
      const resB = https.calls[1].respond(200);
      resB.emit("data", Buffer.from("0123456789"));
      resB.emit("data", Buffer.from("0123456789"));
      resB.emit("end");
      await tick();
      assert.strictEqual(b.settled, 1);
      assert.strictEqual(b.value.ok, false);
      assert.strictEqual(b.value.reason, "EXT_TOO_LARGE");
      assert.ok(https.calls[1].req.destroyed >= 1, "request destroyed");

      const c = track(get(req));
      const resC = https.calls[2].respond(200);
      resC.emit("data", Buffer.from("{}"));
      timers.made[2].c.abort();
      resC.emit("end");
      await tick();
      assert.strictEqual(c.settled, 1);
      assert.deepStrictEqual(c.value, { ok: false, reason: "EXT_TIMEOUT" });
      assert.ok(https.calls[2].req.destroyed >= 1);

      const d = track(get(req));
      const resD = https.calls[3].respond(200);
      resD.emit("data", Buffer.from("{\"a\":1}"));
      resD.emit("end");
      const e = track(get(req));
      https.calls[4].req.emit("error", Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }));
      await tick();
      assert.deepStrictEqual(d.value, { ok: true, body: "{\"a\":1}" });
      assert.deepStrictEqual(e.value, { ok: false, reason: "EXT_TRANSPORT", detail: "ENOTFOUND" });
    });

  test("EP1c fetchExternalPricesWith: one request for all types on the constant host, spec refusals", async () => {
    const seen = [];
    const getter = async (req) => {
      seen.push(req);
      return { ok: true, body: JSON.stringify({ 34: agg("3.78", "3.95"), 35: agg("7", "8") }) };
    };
    const r = await fetchExternalPricesWith(getter, { typeIds: [35, 34, 35, -1], stationId: 60003760,
      timeoutMs: 10000, maxResponseBytes: 65536, maxUnitPriceMilli: 1000000000000 });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].hostname, "market.fuzzwork.co.uk");
    assert.strictEqual(seen[0].path, "/aggregates/?station=60003760&types=34,35");
    assert.strictEqual(seen[0].maxBytes, 65536);
    assert.deepStrictEqual(r.prices.get(35), { bidMilli: 7000, askMilli: 8000 });

    assert.deepStrictEqual(await fetchExternalPricesWith(getter, { typeIds: [], stationId: 60003760,
      timeoutMs: 1, maxResponseBytes: 1 }), { ok: false, reason: "EXT_SPEC_INVALID" });
    assert.deepStrictEqual(await fetchExternalPricesWith(async () => ({ ok: false, reason: "EXT_TIMEOUT" }),
      { typeIds: [34], stationId: 60003760, timeoutMs: 1, maxResponseBytes: 1 }), { ok: false, reason: "EXT_TIMEOUT" });
    const thrown = await fetchExternalPricesWith(async () => { throw new Error("boom"); },
      { typeIds: [34], stationId: 60003760, timeoutMs: 1, maxResponseBytes: 1 });
    assert.strictEqual(thrown.reason, "EXT_THREW");
  });
};
