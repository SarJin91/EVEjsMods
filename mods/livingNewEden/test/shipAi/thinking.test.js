"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig, SCHEMA } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { createShipAiClient } = require("../../lib/shipAi/client");
const { createToolRunner } = require("../../lib/shipAi/tools/loop");
const { createConversation } = require("../../lib/shipAi/conversation");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { thinkingShapeLines } = require("../../tools/shipAiToolProbe");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const KEY = "test-key-not-real-0123";
const NOW = 1700000000000;
const SECRET_REASONING = "SECRET-REASONING-TEXT";
const SECRET_ANSWER = "SECRET-ANSWER-TEXT";

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const reply = (message, finish = "stop", usage = { total_tokens: 120 }) => ({ ok: true, status: 200,
  json: { choices: [{ message, finish_reason: finish }], usage } });
const text = (content) => reply({ content });
const answer = (t) => ({ ok: true, text: t, toolCalls: null, totalTokens: 10, thinking: true, finishReason: "stop" });
const PROMPT = Object.freeze([{ role: "system", content: "persona" }, { role: "user", content: "how far?" }]);

function scriptedTransport(replies) {
  const posts = [];
  return { posts, post(spec) {
    posts.push({ timeoutMs: spec.timeoutMs, body: JSON.parse(spec.body) });
    return Promise.resolve(replies.shift() || text("Fourteen seconds, captain."));
  } };
}

function rig(over, replies) {
  const M = settings(over);
  const transport = scriptedTransport(replies || []);
  const logs = [];
  const client = createShipAiClient({ S: M, apiKey: KEY, transport, nowMs: () => NOW,
    logger: { log: (line) => logs.push(String(line)) } });
  const runner = createToolRunner({ client, S: M, deps: {}, nowMs: () => NOW });
  return { M, transport, logs, client, runner };
}

module.exports = ({ test }) => {
  test("TH1 body: defaults = the old key set, max_tokens and result; think:true = enable_thinking, "
    + "thinkingMaxTokens, thinkingTimeoutMs; reasoning_effort only when set; probe --thinking prints no text", async () => {
    const r = rig({}, [text("Hello."), text("Hello."), reply({ content: "Hi.", reasoning: "x" })]);
    const spec = { playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 };
    const plain = await r.client.request(spec);
    const off = await r.client.request({ ...spec, think: false });
    assert.deepStrictEqual(plain, { ok: true, text: "Hello.", toolCalls: null, totalTokens: 120 }, "old result shape");
    assert.deepStrictEqual(off, plain);
    const [a, b] = r.transport.posts;
    assert.deepStrictEqual(Object.keys(a.body).sort(), ["chat_template_kwargs", "max_tokens", "messages", "model",
      "stream", "temperature", "top_p"]);
    assert.deepStrictEqual([a.body.chat_template_kwargs, a.body.max_tokens, a.timeoutMs], [{ enable_thinking: false },
      400, 20000]);
    assert.deepStrictEqual(b, a, "think:false = the same body and timeout");

    const thought = await r.client.request({ ...spec, think: true });
    const c = r.transport.posts[2];
    assert.deepStrictEqual([c.body.chat_template_kwargs, c.body.max_tokens, c.timeoutMs, "reasoning_effort" in c.body],
      [{ enable_thinking: true }, 3072, 90000, false]);
    assert.deepStrictEqual([thought.ok, thought.text, thought.thinking, thought.finishReason], [true, "Hi.", true,
      "stop"]);

    const low = rig({ reasoningEffort: "low", thinkingMaxTokens: 1024, thinkingTimeoutMs: 5000 });
    await low.client.request({ ...spec, think: true });
    assert.deepStrictEqual([low.transport.posts[0].body.reasoning_effort, low.transport.posts[0].body.max_tokens,
      low.transport.posts[0].timeoutMs], ["low", 1024, 5000]);

    const specs = [];
    const fake = { request: (s) => {
      specs.push(s);
      return Promise.resolve({ ok: true, text: "Done.", toolCalls: null, totalTokens: 1 });
    } };
    const runner = createToolRunner({ client: fake, S: settings(), deps: {}, nowMs: () => NOW });
    await runner.request(spec);
    await runner.request({ ...spec, lane: "proactive" });
    assert.ok(specs.every((s) => !("think" in s) && !("thinkingRetry" in s)), JSON.stringify(specs.map(Object.keys)));

    const lines = thinkingShapeLines({ choices: [{ message: { content: SECRET_ANSWER, reasoning: SECRET_REASONING },
      finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 900, total_tokens: 940,
      completion_tokens_details: { reasoning_tokens: 870 } } });
    assert.deepStrictEqual(lines, ["finish_reason: stop", `content: yes (${SECRET_ANSWER.length} chars)`,
      `reasoning field: reasoning (${SECRET_REASONING.length} chars)`, "<think> in content: no",
      "usage: prompt=40 completion=900 total=940", "reasoning_tokens: 870"]);
    assert.ok(!lines.join("\n").includes("SECRET"), "never a text of the model");
  });

  test("TH2 EMPTY reasoning reply (finish_reason length) -> the same chat round once without reasoning; "
    + "thinkingRetryEmpty false -> one request, EMPTY", async () => {
    const empty = () => reply({ content: null, reasoning: SECRET_REASONING }, "length",
      { total_tokens: 3100, completion_tokens_details: { reasoning_tokens: 3072 } });
    const r = rig({ thinkingChat: true }, [empty(), text("Fourteen seconds, captain.")]);
    const res = await r.runner.request({ playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 });
    assert.deepStrictEqual([res.ok, res.text], [true, "Fourteen seconds, captain."], JSON.stringify(res));
    assert.strictEqual(r.transport.posts.length, 2);
    const [first, second] = r.transport.posts;
    assert.deepStrictEqual([first.body.chat_template_kwargs, first.body.max_tokens, first.timeoutMs],
      [{ enable_thinking: true }, 3072, 90000]);
    assert.deepStrictEqual([second.body.chat_template_kwargs, second.body.max_tokens, second.timeoutMs],
      [{ enable_thinking: false }, 400, 20000], "the retry without reasoning, the plain limits");
    const th = r.client.getStatus().thinking;
    assert.deepStrictEqual([th.requests, th.empty, th.cut, th.retried, th.rejected, th.reasoningTokens],
      [1, 1, 1, 1, 0, 3072]);
    assert.strictEqual(r.runner.getStatus().counters.thinkingRetried, 1);

    const once = rig({ thinkingChat: true, thinkingRetryEmpty: false }, [empty()]);
    const res2 = await once.runner.request({ playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 });
    assert.deepStrictEqual([res2.ok, res2.reason, once.transport.posts.length], [false, "EMPTY", 1]);
    assert.strictEqual(once.client.getStatus().thinking.retried, 0);

    const kw = (p) => p.body.chat_template_kwargs.enable_thinking;
    const fin = rig({ thinkingChat: true, thinkingToolRounds: false }, [text("ASK: wallet {}"), text("Plain."),
      text("Thought through, captain.")]);
    const res3 = await fin.runner.request({ playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 });
    assert.deepStrictEqual([res3.ok, res3.text], [true, "Thought through, captain."], JSON.stringify(res3));
    assert.deepStrictEqual(fin.transport.posts.map(kw), [false, false, true]);
    assert.ok(fin.transport.posts[2].body.messages.at(-1).content.startsWith("Answer the pilot now"));
    assert.strictEqual(fin.runner.getStatus().counters.thinkingFinalAsked, 1);
    const back = rig({ thinkingChat: true, thinkingToolRounds: false }, [text("Plain."), empty()]);
    const res4 = await back.runner.request({ playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 });
    assert.deepStrictEqual([res4.ok, res4.text, back.transport.posts.map(kw)], [true, "Plain.", [false, true]]);
  });

  test("TH3 HTTP 400 to a reasoning request -> client running, thinking disabled, the same round without "
    + "reasoning, one log line without a text; a later think:true thinks no more", async () => {
    const r = rig({ thinkingChat: true }, [{ ok: false, reason: "HTTP_STATUS", status: 400 },
      text("Fourteen seconds, captain."), text("Still here.")]);
    const res = await r.runner.request({ playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 });
    assert.deepStrictEqual([res.ok, res.text], [true, "Fourteen seconds, captain."], JSON.stringify(res));
    const st = r.client.getStatus();
    assert.deepStrictEqual([st.state, st.thinking.disabled, st.thinking.rejected, st.thinking.chat], ["running", true,
      1, true]);
    assert.deepStrictEqual(r.transport.posts.map((p) => p.body.chat_template_kwargs),
      [{ enable_thinking: true }, { enable_thinking: false }]);
    assert.deepStrictEqual(r.logs, ["shipAi client: thinking off - HTTP_400"]);

    await r.runner.request({ playerId: PLAYER, messages: PROMPT, lane: "chat", maxTokens: 400 });
    const later = r.transport.posts[2];
    assert.deepStrictEqual([later.body.chat_template_kwargs, later.body.max_tokens, later.timeoutMs],
      [{ enable_thinking: false }, 400, 20000]);
    assert.deepStrictEqual([r.client.getStatus().state, r.client.getStatus().thinking.requests], ["running", 1]);
  });

  test("TH4 notice: a reasoning chat answer longer than thinkingNoticeMs -> ONE THINKING line before the "
    + "answer, never in ship_ai_turns; thinkingNoticeMs 0 -> none", async () => {
    function convRig(over) {
      const M = settings({ thinkingChat: true, ...over });
      const timers = [];
      const setTimer = (fn, ms) => {
        const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; }, hasRef: () => false };
        timers.push(t);
        return t;
      };
      const pending = [];
      const client = { request: () => new Promise((resolve) => pending.push(resolve)) };
      const lines = [];
      const saved = [];
      const conv = createConversation({ S: M, client, nowMs: () => NOW, setTimer,
        store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
        turnsRepo: { listRecent: () => ({ ok: true, rows: [] }), appendExchangeInTx: (_db, row) => {
          saved.push(row.aiText);
          return { ok: true };
        } },
        nameOf: () => "Jin", snapshot: () => ({ json: "{}", presence: null }),
        deliver: (_id, ls) => {
          lines.push(...ls);
          return { room: ls.length, system: 0, failed: 0 };
        } });
      return { M, timers, pending, lines, saved, conv,
        notices: () => timers.filter((t) => t.ms === M.thinkingNoticeMs && M.thinkingNoticeMs !== M.pumpIntervalMs) };
    }
    const r = convRig({});
    r.conv.onMessage(PLAYER, "how far is the frigate ahead?");
    const notice = r.notices();
    assert.strictEqual(notice.length, 1, "one notice timer per request");
    notice[0].fn();
    notice[0].fn();
    r.pending[0](answer("Fourteen seconds, captain."));
    await flush();
    assert.strictEqual(r.lines.length, 2, JSON.stringify(r.lines));
    assert.ok(STATIC.en.THINKING.includes(r.lines[0]), r.lines[0]);
    assert.strictEqual(r.lines[1], "Fourteen seconds, captain.");
    assert.deepStrictEqual(r.saved, ["Fourteen seconds, captain."], "THINKING is not a turn");

    const fast = convRig({});
    fast.conv.onMessage(PLAYER, "hi");
    fast.pending[0](answer("Hello, captain."));
    await flush();
    assert.deepStrictEqual([fast.notices()[0].cancelled, fast.lines], [true, ["Hello, captain."]], "cancelled");

    const never = convRig({ thinkingNoticeMs: 0 });
    never.conv.onMessage(PLAYER, "hi");
    never.timers.filter((t) => t.ms !== never.M.pumpIntervalMs).forEach((t) => t.fn());
    never.pending[0](answer("Hello, captain."));
    await flush();
    assert.deepStrictEqual(never.lines, ["Hello, captain."]);
    r.conv.stop();
    fast.conv.stop();
    never.conv.stop();
  });

  test("TH5 config: defaults and ranges of the thinking keys, env THINKING_CHAT=1, a bad REASONING_EFFORT", () => {
    const c = base.shipAi;
    assert.deepStrictEqual([c.thinkingChat, c.thinkingProactive, c.thinkingMaxTokens, c.thinkingTimeoutMs,
      c.reasoningEffort, c.thinkingToolRounds, c.thinkingRetryEmpty, c.thinkingNoticeMs],
    [false, false, 3072, 90000, "", true, true, 15000]);
    const row = (k) => SCHEMA.find((x) => x.key === `shipAi.${k}`);
    assert.deepStrictEqual([["thinkingMaxTokens", 256, 16384], ["thinkingTimeoutMs", 1000, 180000],
      ["thinkingNoticeMs", 0, 120000]].map(([k]) => [k, row(k).min, row(k).max]),
    [["thinkingMaxTokens", 256, 16384], ["thinkingTimeoutMs", 1000, 180000], ["thinkingNoticeMs", 0, 120000]]);
    assert.ok(["THINKING_CHAT", "THINKING_PROACTIVE", "THINKING_MAX_TOKENS", "THINKING_TIMEOUT_MS",
      "REASONING_EFFORT", "THINKING_TOOL_ROUNDS", "THINKING_RETRY_EMPTY", "THINKING_NOTICE_MS"]
      .every((e, i) => row(["thinkingChat", "thinkingProactive", "thinkingMaxTokens", "thinkingTimeoutMs",
        "reasoningEffort", "thinkingToolRounds", "thinkingRetryEmpty", "thinkingNoticeMs"][i]).env
        === `EVEJS_LNE_SHIP_AI_${e}`));

    const on = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_THINKING_CHAT: "1",
      EVEJS_LNE_SHIP_AI_THINKING_MAX_TOKENS: "99999", EVEJS_LNE_SHIP_AI_REASONING_EFFORT: "medium" } }).config.shipAi;
    assert.deepStrictEqual([on.thinkingChat, on.thinkingMaxTokens, on.reasoningEffort], [true, 16384, "medium"]);

    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_REASONING_EFFORT: "max" } });
    assert.ok(bad.warnings.some((w) => w.includes("REASONING_EFFORT") && w.endsWith("- ignored")),
      JSON.stringify(bad.warnings));
    assert.strictEqual(bad.config.shipAi.reasoningEffort, "");
    assert.deepStrictEqual(S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, reasoningEffort: "max" } }),
      { ok: false, reason: "INVALID_SETTINGS", detail: "reasoningEffort" });
    assert.deepStrictEqual(S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, thinkingChat: "yes" } }),
      { ok: false, reason: "INVALID_SETTINGS", detail: "thinkingChat" });
    assert.ok(S.STATIC_KINDS.includes("THINKING") && STATIC.pl.THINKING.length > 0);
    assert.ok(S.METRICS.includes(S.METRIC.thinkingRequests) && S.METRICS.includes(S.METRIC.thinkingEmpty));
  });
};
