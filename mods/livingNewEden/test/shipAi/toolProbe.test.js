"use strict";

const assert = require("node:assert");

const { main } = require("../../tools/shipAiToolProbe");
const { toolsFor } = require("../../lib/shipAi/tools/catalog");
const S = require("../../lib/shipAi/schema");
const { resolveConfig } = require("../../config");
const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const KEY = "probe-test-key-not-real-0123";
const ENV = Object.freeze({ EVEJS_LNE_SHIP_AI_ENABLED: "1", EVEJS_LNE_SHIP_AI_API_KEY: KEY });

function fakeTransport(replies) {
  const posts = [];
  return { posts, post(spec) {
    posts.push({ host: spec.url.host, apiKey: spec.apiKey, timeoutMs: spec.timeoutMs, body: JSON.parse(spec.body) });
    return Promise.resolve(replies.shift() || { ok: false, reason: "NET_ERROR" });
  } };
}

async function run(argv, replies, env = ENV) {
  const transport = fakeTransport(replies);
  const lines = [];
  const code = await main(argv, { env, transport, log: (l) => lines.push(l), nowMs: () => 0 });
  return { code, lines, posts: transport.posts, out: lines.join("\n") };
}

const ok = (message) => ({ ok: true, status: 200, json: { choices: [{ message, finish_reason: "stop" }] } });

module.exports = ({ test }) => {
  test("STP1 probe: tool_calls -> yes with names, exit 0, runtime catalogue in the body, key never printed",
    async () => {
      const r = await run([], [ok({ content: "", tool_calls: [{ id: "c1", type: "function",
        function: { name: "route", arguments: "{\"to\":\"Jita\"}" } }] })]);
      assert.strictEqual(r.code, 0, r.out);
      assert.strictEqual(r.posts.length, 1);
      const M = S.shipAiModelSettingsOf(resolveConfig({ env: ENV, modDir: MOD_DIR }).config).settings;
      const want = toolsFor(M).map((t) => t.name);
      const body = r.posts[0].body;
      assert.deepStrictEqual(body.tools.map((t) => t.function.name), want);
      assert.ok(want.length > 11, `db-read tools in the runtime catalogue: ${want.length}`);
      assert.deepStrictEqual([body.tool_choice, body.stream, body.chat_template_kwargs, r.posts[0].apiKey],
        ["auto", false, { enable_thinking: false }, KEY]);
      assert.ok(r.lines.some((l) => l === "shipAiToolProbe: tool_calls: yes (route) - shipAi.toolMode=native may be set"),
        r.out);
      assert.ok(r.lines.some((l) => l.endsWith(` tools=${want.length}`)), r.out);
      assert.ok(!r.out.includes(KEY), "the key is never printed");
    });

  test("STP2 probe: no tool_calls -> no, exit 0; HTTP 400 -> refused with the toolMode=text advice, exit 1",
    async () => {
      const no = await run([], [ok({ content: "Seven jumps." })]);
      assert.strictEqual(no.code, 0);
      assert.ok(no.lines.includes("shipAiToolProbe: tool_calls: no - keep shipAi.toolMode=text"), no.out);
      assert.ok(!no.out.includes("Seven jumps"), "no text of the model");
      const bad = await run([], [{ ok: false, reason: "HTTP_STATUS", status: 400 }]);
      assert.strictEqual(bad.code, 1);
      assert.ok(bad.lines.some((l) => l.startsWith("shipAiToolProbe: refused - HTTP_STATUS HTTP 400 ")
        && l.includes("keep shipAi.toolMode=text")), bad.out);
    });

  test("STP3 probe: no key -> exit 1 without a request; --thinking -> enable_thinking true, numbers only", async () => {
    const none = await run([], [], { EVEJS_LNE_SHIP_AI_ENABLED: "1", EVEJS_LNE_SHIP_AI_API_KEY: "",
      EVEJS_LNE_CHATTER_AI_API_KEY: "" });
    assert.deepStrictEqual([none.code, none.posts.length], [1, 0]);
    assert.ok(none.out.includes("no API key"), none.out);
    const th = await run(["--thinking"], [ok({ content: "SECRET-ANSWER", reasoning_content: "SECRET-REASONING" })]);
    assert.strictEqual(th.code, 0, th.out);
    assert.deepStrictEqual([th.posts.length, th.posts[0].body.chat_template_kwargs, "tools" in th.posts[0].body],
      [1, { enable_thinking: true }, false]);
    assert.ok(th.lines.includes("shipAiToolProbe --thinking: reasoning field: reasoning_content (16 chars)"), th.out);
    assert.ok(!th.out.includes("SECRET") && !th.out.includes(KEY), "never a text of the model or the key");
  });
};
