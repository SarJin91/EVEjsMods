"use strict";

const assert = require("node:assert");
const { EventEmitter } = require("node:events");

const { createChatTransport, createDefaultChatTransport } = require("../../lib/chatterAi/transport");

const KEY = "nvapi-SECRETKEY";
const URL_OF = () => new URL("https://integrate.api.nvidia.com/v1/chat/completions");

function fakeRequest(respond) {
  const calls = [];
  const request = (url, opts, cb) => {
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = () => { req.destroyed = true; };
    req.end = (payload) => {
      calls.push({ url, opts, body: payload.toString("utf8"), req });
      setImmediate(() => respond(cb, req));
    };
    return req;
  };
  return { request, calls };
}

function respondWith(status, headers, chunks) {
  return (cb) => {
    const res = new EventEmitter();
    res.statusCode = status;
    res.headers = headers;
    res.resumed = false;
    res.resume = () => { res.resumed = true; };
    cb(res);
    setImmediate(() => {
      for (const c of chunks) res.emit("data", Buffer.from(c, "utf8"));
      res.emit("end");
    });
  };
}

function spec(over = {}) {
  return { url: URL_OF(), apiKey: KEY, body: '{"q":1}', timeoutMs: 1000, maxBytes: 64, ...over };
}

function noKey(result) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes("SECRETKEY") && !text.includes("Bearer"), `key leaked: ${text}`);
}

module.exports = ({ test }) => {
  test("T1 200 + JSON -> ok with the json; POST, Bearer header, the given body, content-length", async () => {
    const fake = fakeRequest(respondWith(200, { "content-type": "application/json" }, ['{"choices":', "[]}"]));
    const t = createChatTransport({ request: fake.request });
    const r = await t.post(spec());
    assert.deepStrictEqual(r, { ok: true, status: 200, json: { choices: [] } });
    noKey(r);
    const call = fake.calls[0];
    assert.strictEqual(call.opts.method, "POST");
    assert.strictEqual(call.opts.headers.authorization, `Bearer ${KEY}`);
    assert.strictEqual(call.opts.headers["content-type"], "application/json");
    assert.strictEqual(call.opts.headers["content-length"], 7);
    assert.strictEqual(call.body, '{"q":1}');
    assert.strictEqual(call.url.href, "https://integrate.api.nvidia.com/v1/chat/completions");
  });

  test("T2 429 + retry-after 30 -> HTTP_STATUS, retryAfterMs 30000, body not returned; 302 / bad header", async () => {
    const fake = fakeRequest(respondWith(429, { "retry-after": "30" }, ['{"error":"rate SECRETBODY"}']));
    const r = await createChatTransport({ request: fake.request }).post(spec());
    assert.deepStrictEqual(r, { ok: false, reason: "HTTP_STATUS", status: 429, retryAfterMs: 30000 });
    assert.ok(!JSON.stringify(r).includes("SECRETBODY"));
    noKey(r);
    const moved = await createChatTransport({ request: fakeRequest(respondWith(302,
      { "retry-after": "Wed, 21 Oct 2015 07:28:00 GMT", location: "https://x.test/" }, [])).request }).post(spec());
    assert.deepStrictEqual(moved, { ok: false, reason: "HTTP_STATUS", status: 302, retryAfterMs: null });
  });

  test("T3 TIMEOUT (fake signal), TOO_LARGE, request throws -> NET_ERROR code, ABORTED, BAD_JSON; no key", async () => {
    const results = [];
    const ctl = new AbortController();
    const hang = fakeRequest(() => {});
    const pending = createChatTransport({ request: hang.request, timeoutSignal: () => ctl.signal }).post(spec());
    await new Promise((resolve) => setImmediate(resolve));
    ctl.abort();
    const timedOut = await pending;
    assert.deepStrictEqual(timedOut, { ok: false, reason: "TIMEOUT" });
    assert.strictEqual(hang.calls[0].req.destroyed, true);
    results.push(timedOut);

    const big = fakeRequest(respondWith(200, {}, ["x".repeat(40), "y".repeat(40)]));
    const tooLarge = await createChatTransport({ request: big.request }).post(spec());
    assert.deepStrictEqual(tooLarge, { ok: false, reason: "TOO_LARGE" });
    assert.strictEqual(big.calls[0].req.destroyed, true);
    results.push(tooLarge);

    const throwing = () => { throw Object.assign(new Error(`connect failed ${KEY}`), { code: "ECONNREFUSED" }); };
    const thrown = await createChatTransport({ request: throwing }).post(spec());
    assert.deepStrictEqual(thrown, { ok: false, reason: "NET_ERROR", code: "ECONNREFUSED" });
    results.push(thrown);

    const stop = new AbortController();
    const aborting = createChatTransport({ request: fakeRequest(() => {}).request })
      .post(spec({ signal: stop.signal }));
    stop.abort();
    const aborted = await aborting;
    assert.deepStrictEqual(aborted, { ok: false, reason: "ABORTED" });
    results.push(aborted);

    const badJson = await createChatTransport({ request: fakeRequest(respondWith(200, {}, ["not json"])).request })
      .post(spec());
    assert.deepStrictEqual(badJson, { ok: false, reason: "BAD_JSON" });
    results.push(badJson);

    const blocked = await createDefaultChatTransport().post(spec());
    assert.deepStrictEqual(blocked, { ok: false, reason: "NET_ERROR" });
    results.push(blocked);
    for (const r of results) noKey(r);
  });
};
