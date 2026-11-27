"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { chatterAiSettingsOf } = require("../../lib/chatterAi/schema");
const { buildBucketSpecs } = require("../../lib/chatterAi/buckets");
const { createBreaker } = require("../../lib/chatterAi/limits");
const { startChatterAi } = require("../../lib/chatterAi");
const { createRegistry, REJECTED } = require("../../lib/telemetry/registry");
const fcData = require("../../lib/freeCorps/data/chatterLines");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const KEY = "nvapi-SECRET-TEST-KEY";
const T0 = 1700000000000;
const TEXT = ["quiet shift out in the belt today", "ore holds filling up nicely this run",
  "anyone else hauling to the hub later"].join("\n");

function configOf(env) {
  const r = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
  assert.strictEqual(r.ok, true);
  return r.config;
}

function onConfig(extra = {}) {
  return configOf({ EVEJS_LNE_CHATTER_AI_ENABLED: "1", EVEJS_LNE_CHATTER_AI_API_KEY: KEY, ...extra });
}

function bucketsOf(config) {
  const S = chatterAiSettingsOf(config).settings;
  const r = buildBucketSpecs({ civilian: null, resident: { ...fcData, CONTEXTS: fcData.CONTEXTS.slice(0, 2) } }, S);
  assert.strictEqual(r.ok, true);
  return r.buckets;
}

function fakeTimers() {
  const list = [];
  return {
    setTimer(fn, ms) {
      const t = { fn, ms, live: true };
      list.push(t);
      return { cancel: () => { t.live = false; }, hasRef: () => false };
    },
    live: () => list.filter((t) => t.live),
    fire() {
      const t = list.filter((x) => x.live).pop();
      assert.ok(t, "no armed timer");
      t.live = false;
      t.fn();
    },
  };
}

function fakeTransport() {
  const calls = [];
  return { calls, post: (spec) => new Promise((resolve) => calls.push({ spec, resolve })) };
}

const okJson = (text = TEXT) => ({ ok: true, status: 200,
  json: { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { total_tokens: 120 } } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function rig(config, over = {}) {
  const clock = { t: T0 };
  const timers = fakeTimers();
  const transport = fakeTransport();
  const registry = createRegistry({ histogramSamples: 16, maxMetrics: 64 });
  const lines = [];
  const r = startChatterAi({ config, clock: { now: () => clock.t }, nowMs: () => clock.t,
    logger: { log: (l) => lines.push(l) }, telemetry: registry, setTimer: timers.setTimer, transport,
    buckets: over.buckets || bucketsOf(config), getGovernor: () => null, talkEnabled: over.talkEnabled,
    newsEnabled: over.newsEnabled });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { ai: r.chatterAi, clock, timers, transport, registry, lines };
}

module.exports = ({ test }) => {
  test("S1 off / no key: no timer; on: one request in flight (maxInFlight 1), templates in the pool, overlay ok", async () => {
    const off = rig(configOf({}));
    assert.deepStrictEqual(off.ai.getStatus(), { state: "off" });
    assert.deepStrictEqual([off.timers.live().length, off.transport.calls.length], [0, 0]);
    assert.deepStrictEqual(off.ai.overlay(), { ok: false, reason: "OFF" });
    const noKey = rig(configOf({ EVEJS_LNE_CHATTER_AI_ENABLED: "1" }));
    assert.deepStrictEqual([noKey.ai.getStatus().state, noKey.ai.getStatus().lastError, noKey.ai.getStatus().apiKeySet],
      ["disabled", "NO_API_KEY", false]);
    assert.deepStrictEqual([noKey.timers.live().length, noKey.transport.calls.length], [0, 0]);

    const on = rig(onConfig());
    assert.deepStrictEqual([on.timers.live().length, on.timers.live()[0].ms, on.transport.calls.length], [1, 15000, 0],
      "first pass after the first interval");
    assert.deepStrictEqual(on.ai.overlay(), { ok: false, reason: "EMPTY" });
    on.timers.fire();
    on.timers.fire();
    assert.strictEqual(on.transport.calls.length, 1, "maxInFlight 1");
    const { spec } = on.transport.calls[0];
    assert.deepStrictEqual([spec.url.href, spec.apiKey, spec.timeoutMs, spec.maxBytes],
      ["https://integrate.api.nvidia.com/v1/chat/completions", KEY, 15000, 32768]);
    assert.strictEqual(on.ai.getStatus().inFlight, 1);
    on.clock.t += 250;
    on.transport.calls[0].resolve(okJson());
    await flush();
    const st = on.ai.getStatus();
    assert.deepStrictEqual([st.inFlight, st.buckets, st.counters.ok, st.counters.linesAccepted, st.tokensToday],
      [0, { total: 2, filled: 1, lines: 3 }, 1, 3, 120]);
    const ov = on.ai.overlay();
    assert.deepStrictEqual([ov.ok, ov.permille, ov.linesOf("fc.WORK_MINE").length, ov.linesOf("fc.NOPE").length],
      [true, 500, 3, 0]);
    on.timers.fire();
    assert.strictEqual(on.transport.calls[1].spec.body.includes("Topic:"), true);
    assert.ok(on.transport.calls[1].spec.body.length > 0 && on.ai.getStatus().inFlight === 1, "next: the empty bucket");
    assert.strictEqual(on.registry.counter(REJECTED), 0, JSON.stringify(on.registry.rejectedNames()));
    assert.deepStrictEqual([on.registry.counter("chatterAi.requests"), on.registry.counter("chatterAi.tokens")], [2, 120]);
    on.ai.stop("test");
  });

  test("S2 breaker: 3 NET_ERROR -> open, no request; after the cooldown one probe; success -> closed", async () => {
    const r = rig(onConfig());
    for (let i = 0; i < 3; i += 1) {
      r.timers.fire();
      r.transport.calls[i].resolve({ ok: false, reason: "NET_ERROR", code: "ECONNRESET" });
      await flush();
    }
    assert.deepStrictEqual([r.ai.getStatus().breaker, r.ai.getStatus().lastError, r.ai.getStatus().counters.netErrors],
      ["open", "NET_ERROR", 3]);
    r.timers.fire();
    assert.deepStrictEqual([r.transport.calls.length, r.ai.getStatus().counters.breakerBlocked], [3, 1]);
    r.clock.t += 60000;
    r.timers.fire();
    r.timers.fire();
    assert.deepStrictEqual([r.transport.calls.length, r.ai.getStatus().breaker], [4, "half_open"], "one probe");
    r.transport.calls[3].resolve(okJson());
    await flush();
    assert.strictEqual(r.ai.getStatus().breaker, "closed");
    assert.strictEqual(r.registry.counter("chatterAi.breakerOpened"), 1);
    r.ai.stop("test");

    const b = createBreaker({ breakerFailures: 1, breakerCooldownMs: 1000, breakerMaxCooldownMs: 10000 });
    b.failure(0, 5000);
    assert.deepStrictEqual([b.state(4999), b.allow(4999), b.state(5000)], ["open", false, "half_open"], "Retry-After");
    assert.deepStrictEqual([b.allow(5000), b.allow(5000)], [true, false], "one probe");
    b.failure(5000, null);
    assert.deepStrictEqual([b.state(6999), b.state(7000), b.opened], ["open", "half_open", 2], "cooldown doubled");
  });

  test("S3 401 -> disabled AUTH_REJECTED, no more requests or timers; the key in no status", async () => {
    const r = rig(onConfig());
    r.timers.fire();
    r.transport.calls[0].resolve({ ok: false, reason: "HTTP_STATUS", status: 401, retryAfterMs: null });
    await flush();
    const st = r.ai.getStatus();
    assert.deepStrictEqual([st.state, st.lastError, st.apiKeySet, st.host, st.model],
      ["disabled", "AUTH_REJECTED", true, "integrate.api.nvidia.com", "nvidia/nemotron-3.5-super-vl-120b-a12b"]);
    assert.deepStrictEqual([r.timers.live().length, r.transport.calls.length, r.ai.overlay().reason], [0, 1, "DISABLED"]);
    const text = JSON.stringify(st) + r.lines.join("\n");
    assert.ok(!text.includes(KEY) && !text.includes("SECRET"), text);
    assert.ok(!text.includes("/v1"), "host only, no path");
  });

  test("S4 daily budget below maxTokens -> no request; stop() in flight -> abort, a late result changes nothing", async () => {
    const poor = rig(onConfig({ EVEJS_LNE_CHATTER_AI_DAILY_TOKEN_BUDGET: "100" }));
    poor.timers.fire();
    assert.deepStrictEqual([poor.transport.calls.length, poor.ai.getStatus().counters.budgetExhausted > 0,
      poor.ai.getStatus().requestsLastMinute], [0, true, 0]);
    poor.ai.stop("test");

    const r = rig(onConfig());
    r.timers.fire();
    const before = r.ai.getStatus().buckets;
    r.ai.stop("shutdown");
    assert.deepStrictEqual([r.transport.calls[0].spec.signal.aborted, r.timers.live().length, r.ai.getStatus().state],
      [true, 0, "stopped"]);
    r.transport.calls[0].resolve(okJson());
    await flush();
    assert.deepStrictEqual(r.ai.getStatus().buckets, before);
    assert.strictEqual(r.ai.getStatus().counters.ok, 0);
    assert.deepStrictEqual(r.ai.overlay(), { ok: false, reason: "DISABLED" });
  });

  test("S5: bucket A always ALL_REJECTED, B accepted -> B reaches lowWater, A backs off x2, breaker closed", async () => {
    const config = onConfig();
    const buckets = bucketsOf(config);
    const [A, B] = buckets.map((b) => b.key);
    const r = rig(config, { buckets });
    const bad = okJson(["price is 1234567 isk today", "selling at 9999999 isk", "buy 55555 units now"].join("\n"));
    const more = okJson(["the gate camp moved off finally", "long haul back to the station tonight",
      "nice and calm around the moons"].join("\n"));
    const send = async (i, res) => {
      r.transport.calls[i].resolve(res);
      await flush();
    };
    r.timers.fire();
    await send(0, bad);
    let st = r.ai.getStatus();
    assert.deepStrictEqual([st.breaker, st.lastError, st.counters.bucketBackoffs, st.counters.rejected_DIGITS],
      ["closed", "ALL_REJECTED", 1, 3]);
    r.timers.fire();
    await send(1, okJson());
    r.timers.fire();
    await send(2, more);
    r.timers.fire();
    assert.strictEqual(r.transport.calls.length, 3, "B at lowWater 6, A backed off -> no request");
    const ov = r.ai.overlay();
    assert.deepStrictEqual([ov.linesOf(A).length, ov.linesOf(B).length], [0, 6]);

    r.clock.t += 60000;
    r.timers.fire();
    assert.strictEqual(r.transport.calls.length, 4, "A again after breakerCooldownMs");
    await send(3, bad);
    r.clock.t += 60000;
    r.timers.fire();
    assert.strictEqual(r.transport.calls.length, 4, "second failure in a row -> 120 s");
    r.clock.t += 60000;
    r.timers.fire();
    await send(4, bad);
    st = r.ai.getStatus();
    assert.deepStrictEqual([st.breaker, st.counters.bucketBackoffs, st.counters.ok, st.counters.failed],
      ["closed", 3, 2, 3]);
    assert.strictEqual(r.registry.counter("chatterAi.breakerOpened"), 0);
    r.ai.stop("test");
  });

  test("S6: a throw while reading the HALF_OPEN probe result reopens the breaker (no probe stuck)", async () => {
    const config = onConfig();
    const broken = [{ ...bucketsOf(config)[0], staticNormalized: 7 }];
    const r = rig(config, { buckets: broken });
    for (let i = 0; i < 3; i += 1) {
      r.timers.fire();
      r.transport.calls[i].resolve({ ok: false, reason: "NET_ERROR" });
      await flush();
    }
    r.clock.t += 60000;
    r.timers.fire();
    assert.deepStrictEqual([r.transport.calls.length, r.ai.getStatus().breaker], [4, "half_open"]);
    r.transport.calls[3].resolve(okJson());
    await flush();
    assert.deepStrictEqual([r.ai.getStatus().breaker, r.ai.getStatus().lastError], ["open", "RESULT_FAILED"]);
    assert.strictEqual(r.ai.getStatus().counters.bucketBackoffs, 1, "The bucket of the throw backs off");
    r.clock.t += 120000;
    r.timers.fire();
    assert.strictEqual(r.transport.calls.length, 5, "next probe after the doubled cooldown");
    r.ai.stop("test");
  });

  test("S7 SWEEP: every bucket always EMPTY -> tokensToday grows, then budgetExhausted and no request", async () => {
    const r = rig(onConfig({ EVEJS_LNE_CHATTER_AI_DAILY_TOKEN_BUDGET: "3000",
      EVEJS_LNE_CHATTER_AI_BREAKER_COOLDOWN_MS: "1000", EVEJS_LNE_CHATTER_AI_BREAKER_MAX_COOLDOWN_MS: "1000" }));
    const empty = (i) => ({ ok: true, status: 200, json: i % 2 === 0
      ? { choices: [{ message: { content: null }, finish_reason: "length" }], usage: { total_tokens: 450 } }
      : { choices: [{ message: { content: "   " } }] } });
    let prev = 0;
    let answered = 0;
    for (let round = 0; round < 20 && r.ai.getStatus().counters.budgetExhausted === 0; round += 1) {
      r.clock.t += 61000;
      r.timers.fire();
      for (; answered < r.transport.calls.length; answered += 1) r.transport.calls[answered].resolve(empty(answered));
      await flush();
      const used = r.ai.getStatus().tokensToday;
      if (r.ai.getStatus().counters.budgetExhausted === 0) assert.ok(used > prev, `round ${round}: ${used} > ${prev}`);
      prev = used;
    }
    const st = r.ai.getStatus();
    assert.ok(answered >= 2, `${answered} EMPTY answers`);
    assert.ok(st.counters.budgetExhausted > 0 && st.tokensToday > 0, JSON.stringify(st.counters));
    assert.deepStrictEqual([st.breaker, st.counters.ok, st.counters.failed], ["closed", 0, answered]);
    const calls = r.transport.calls.length;
    for (let i = 0; i < 3; i += 1) {
      r.clock.t += 61000;
      r.timers.fire();
    }
    assert.strictEqual(r.transport.calls.length, calls, "budget spent -> no more requests today");
    assert.strictEqual(r.registry.counter("chatterAi.tokens"), st.tokensToday);
    r.ai.stop("test");
  });

  const MESSAGES = [{ role: "system", content: "You are Kaede Rin, a pilot in Local." },
    { role: "user", content: "Recent Local chat (oldest first):\nSay something." }];
  const talkSpec = (over = {}) => ({ lane: "talk", key: "30000142", messages: MESSAGES, maxChars: 180, minChars: 4,
    speakerName: "Kaede Rin", ...over });

  test("S8 complete: success line, body = talkMaxTokens + spec messages, byLane.talk; off / BAD_SPEC / in flight", async () => {
    const off = rig(configOf({}));
    assert.deepStrictEqual(await off.ai.complete(talkSpec()), { ok: false, reason: "OFF" });
    const r = rig(onConfig());
    const p = r.ai.complete(talkSpec());
    assert.strictEqual(r.transport.calls.length, 1);
    const body = JSON.parse(r.transport.calls[0].spec.body);
    assert.deepStrictEqual([body.max_tokens, body.messages, body.stream, body.chat_template_kwargs],
      [160, MESSAGES, false, { enable_thinking: false }]);
    r.clock.t += 250;
    r.transport.calls[0].resolve(okJson("Kaede Rin: \"o7 all, quiet out here tonight\""));
    assert.deepStrictEqual(await p, { ok: true, line: "o7 all, quiet out here tonight", tokens: 120, ms: 250 });
    const st = r.ai.getStatus();
    assert.deepStrictEqual([st.byLane.talk, st.talkTokensToday, st.tokensToday, st.talkInFlight, st.inFlight],
      [{ requests: 1, linesAccepted: 1, tokens: 120 }, 120, 120, 0, 0]);
    assert.deepStrictEqual([r.registry.counter("chatterAi.talkRequests"), r.registry.counter(REJECTED)], [1, 0]);
    for (const bad of [talkSpec({ lane: "voice" }), talkSpec({ messages: [...MESSAGES, MESSAGES[1]] }),
      talkSpec({ messages: [{ role: "assistant", content: "x" }] }),
      talkSpec({ messages: [{ role: "user", content: "x".repeat(8001) }] }), talkSpec({ maxChars: 0 }), null]) {
      assert.deepStrictEqual(await r.ai.complete(bad), { ok: false, reason: "BAD_SPEC" });
    }
    assert.strictEqual(r.transport.calls.length, 1, "BAD_SPEC without HTTP");
    const a = r.ai.complete(talkSpec());
    const b = r.ai.complete(talkSpec());
    assert.deepStrictEqual(await r.ai.complete(talkSpec()), { ok: false, reason: "TALK_IN_FLIGHT" });
    r.ai.stop("test");
    assert.deepStrictEqual([await a, await b, r.transport.calls[1].spec.signal.aborted],
      [{ ok: false, reason: "STOPPED" }, { ok: false, reason: "STOPPED" }, true]);
    assert.deepStrictEqual(await r.ai.complete(talkSpec()), { ok: false, reason: "STOPPED" });
    const text = JSON.stringify(r.ai.getStatus()) + r.lines.join("\n");
    assert.ok(!text.includes(KEY) && !text.includes("quiet out here") && !text.includes("Kaede"), text);
  });

  test("S9 complete: 3 filter refusals -> REJECTED_DIGITS, breaker closed, tokens counted; TALK_BUDGET", async () => {
    const r = rig(onConfig());
    for (let i = 0; i < 3; i += 1) {
      const p = r.ai.complete(talkSpec());
      r.transport.calls[i].resolve(okJson("my wallet holds 1234567 isk right now"));
      assert.deepStrictEqual(await p, { ok: false, reason: "REJECTED_DIGITS" });
    }
    const st = r.ai.getStatus();
    assert.deepStrictEqual([st.breaker, st.counters.talkRejected, st.talkTokensToday, st.byLane.talk.linesAccepted],
      ["closed", 3, 360, 0]);
    r.ai.stop("test");

    const poor = rig(onConfig({ EVEJS_LNE_CHATTER_AI_TALK_TOKEN_SHARE_PERMILLE: "0" }));
    assert.deepStrictEqual(await poor.ai.complete(talkSpec()), { ok: false, reason: "TALK_BUDGET" });
    assert.deepStrictEqual([poor.transport.calls.length, poor.ai.getStatus().counters.talkBudgetExhausted,
      poor.ai.getStatus().requestsLastMinute], [0, 1, 0]);
    poor.ai.stop("test");
  });

  test("S10 RPM reserve: with talkEnabled the refill leaves the slot to complete(); without it the refill takes it", async () => {
    const env = { EVEJS_LNE_CHATTER_AI_MAX_REQUESTS_PER_MINUTE: "5", EVEJS_LNE_CHATTER_AI_TALK_RESERVED_PER_MINUTE: "4" };
    for (const talkEnabled of [true, undefined]) {
      const r = rig(onConfig(env), { talkEnabled });
      const p = r.ai.complete(talkSpec());
      r.transport.calls[0].resolve(okJson("o7 all, quiet out here tonight"));
      assert.strictEqual((await p).ok, true);
      r.timers.fire();
      r.timers.fire();
      const st = r.ai.getStatus();
      if (talkEnabled) {
        assert.deepStrictEqual([r.transport.calls.length, st.counters.rateLimited > 0, st.inFlight], [1, true, 0],
          "window 1 = max 5 - reserve 4: no refill");
        r.ai.complete(talkSpec());
        assert.strictEqual(r.transport.calls.length, 2, "complete takes the reserved slot");
      } else {
        assert.deepStrictEqual([r.transport.calls.length, st.counters.rateLimited, st.inFlight], [2, 0, 1], "as today");
      }
      r.ai.stop("test");
    }
  });

  test("S11 NO_BUCKETS: with talkEnabled RUNNING without a refill timer (buckets=0), complete works; else disabled", async () => {
    const r = rig(onConfig(), { buckets: [], talkEnabled: true });
    assert.deepStrictEqual([r.ai.getStatus().state, r.timers.live().length], ["running", 0]);
    assert.ok(r.lines.some((l) => l.includes("buckets=0") && l.includes("talk=on")), r.lines.join("\n"));
    const p = r.ai.complete(talkSpec());
    r.transport.calls[0].resolve(okJson("o7 all, quiet out here tonight"));
    assert.strictEqual((await p).ok, true);
    r.ai.stop("test");
    const none = rig(onConfig(), { buckets: [] });
    assert.deepStrictEqual([none.ai.getStatus().state, none.ai.getStatus().lastError, none.timers.live().length],
      ["disabled", "NO_BUCKETS", 0]);
    assert.deepStrictEqual(await none.ai.complete(talkSpec()), { ok: false, reason: "DISABLED" });
  });

  const NEWS_MESSAGES = [{ role: "system", content: "You are the editor of Scope." },
    { role: "user", content: "FACTS 2026-11-14 17:00 - 2026-11-15 17:00 UTC\nF1 | System captured | x | 16:00 UTC" }];
  const newsSpec = (over = {}) => ({ lane: "news", messages: NEWS_MESSAGES, minChars: 20, maxChars: 4000, ...over });
  const NEWS_TEXT = "TITLE: Jita falls\n\nThe Caldari State took Jita today.\n\nThe Forge is quiet.";

  test("S12 complete news: multi-line text, max_tokens / timeout of the news lane, byLane.news; NEWS_BUDGET, "
    + "NEWS_IN_FLIGHT, BAD_SPEC without HTTP; onAccepted before the transport", async () => {
    const r = rig(onConfig(), { buckets: [], newsEnabled: true });
    assert.deepStrictEqual([r.ai.getStatus().state, r.timers.live().length], ["running", 0], "news alone: RUNNING");
    let acceptedAt = -1;
    const p = r.ai.complete(newsSpec({ onAccepted: () => {
      acceptedAt = r.transport.calls.length;
      return true;
    } }));
    assert.deepStrictEqual([acceptedAt, r.transport.calls.length], [0, 1], "onAccepted before the request");
    const { spec } = r.transport.calls[0];
    const body = JSON.parse(spec.body);
    assert.deepStrictEqual([body.max_tokens, body.messages, spec.timeoutMs], [1200, NEWS_MESSAGES, 60000]);
    assert.deepStrictEqual(await r.ai.complete(newsSpec()), { ok: false, reason: "NEWS_IN_FLIGHT" });
    r.clock.t += 500;
    r.transport.calls[0].resolve(okJson(NEWS_TEXT));
    assert.deepStrictEqual(await p, { ok: true, text: NEWS_TEXT, tokens: 120, ms: 500 });
    const st = r.ai.getStatus();
    assert.deepStrictEqual([st.byLane.news, st.newsTokensToday, st.newsInFlight, st.counters.newsInFlightBlocked],
      [{ requests: 1, linesAccepted: 1, tokens: 120 }, 120, 0, 1]);
    assert.deepStrictEqual([r.registry.counter("chatterAi.newsRequests"), r.registry.counter(REJECTED)], [1, 0]);
    for (const bad of [newsSpec({ messages: [{ role: "assistant", content: "x" }] }),
      newsSpec({ messages: [{ role: "user", content: "x".repeat(8001) }] }), newsSpec({ onAccepted: 1 })]) {
      assert.deepStrictEqual(await r.ai.complete(bad), { ok: false, reason: "BAD_SPEC" });
    }
    assert.deepStrictEqual(await r.ai.complete(newsSpec({ onAccepted: () => false })), { ok: false, reason: "ABORTED" });
    assert.strictEqual(r.transport.calls.length, 1, "BAD_SPEC / ABORTED without HTTP");
    const text = JSON.stringify(r.ai.getStatus()) + r.lines.join("\n");
    assert.ok(!text.includes(KEY) && !text.includes("Jita") && !text.includes("editor"), text);
    r.ai.stop("test");

    const poor = rig(onConfig({ EVEJS_LNE_CHATTER_AI_NEWS_TOKEN_SHARE_PERMILLE: "0" }), { newsEnabled: true });
    let called = false;
    assert.deepStrictEqual(await poor.ai.complete(newsSpec({ onAccepted: () => {
      called = true;
    } })), { ok: false, reason: "NEWS_BUDGET" });
    assert.deepStrictEqual([poor.transport.calls.length, called, poor.ai.getStatus().counters.newsBudgetExhausted],
      [0, false, 1]);
    poor.ai.stop("test");
  });
};
