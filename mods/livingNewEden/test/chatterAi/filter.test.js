"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { chatterAiSettingsOf } = require("../../lib/chatterAi/schema");
const { filterTemplates, parseCompletion, normalizeLine, filterTalkLine } = require("../../lib/chatterAi/filter");
const { stableHash32 } = require("../../lib/util/rng");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function settings(env = {}) {
  const r = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
  const s = chatterAiSettingsOf(r.config);
  assert.strictEqual(s.ok, true);
  return s.settings;
}

module.exports = ({ test }) => {
  test("F1 numbered answer: one valid template, each reject reason counted, ids from the normalised hash", () => {
    const S = settings({ EVEJS_LNE_CHATTER_AI_BANNED_WORDS: "Spaghetti, " });
    const bucket = { key: "hs.bg.TRADE", placeholders: ["item", "system", "ticker"] };
    const known = new Set([normalizeLine("WTB {item} in bulk, paying well")]);
    const text = [
      "1. WTS {item} cheap, convo me in {system}",
      "2) short",
      "",
      "3. selling ore at a great price ~ today",
      "- buying {ship} at a great price today",
      "* check my shop at evebargains.com today",
      "\"price is 1234567 isk, convo me now\"",
      "/join my channel for cheap deals now",
      "as an AI I cannot sell you {item}",
      "I love spaghetti more than {item} trading",
      "WTB {item} in bulk, paying well",
      "wts {item} cheap!! convo me in {system}",
      "{item and {system} for sale cheap",
      "[{ticker}] selling {item} cheap today",
      "[docs](https://x.example)",
    ].join("\n");
    const r = filterTemplates(text, bucket, S, known);
    const idOf = (t) => `ai-hs.bg.TRADE-${stableHash32(normalizeLine(t)).toString(16)}`;
    const good = ["WTS {item} cheap, convo me in {system}", "[{ticker}] selling {item} cheap today"];
    assert.deepStrictEqual(r.accepted, good.map((t) => ({ id: idOf(t), text: t })));
    assert.deepStrictEqual(r.rejected, { LENGTH: 1, CHARSET: 1, PLACEHOLDER: 2, LINK: 2, DIGITS: 1, COMMAND: 1,
      BANNED: 2, DUPLICATE: 2 });
    const capped = filterTemplates("a fine line number one\nanother fine line two", bucket,
      { ...S, linesPerRequest: 1 }, new Set());
    assert.deepStrictEqual(capped.accepted.map((x) => x.text), ["a fine line number one"]);
  });

  test("F2 parseCompletion: content null -> EMPTY, no usage -> totalTokens null, bad shapes", () => {
    const EMPTY = { ok: false, reason: "EMPTY", totalTokens: null };
    assert.deepStrictEqual(parseCompletion({ choices: [{ message: { content: null } }] }), EMPTY);
    assert.deepStrictEqual(parseCompletion({ choices: [{ message: { content: "  " } }] }), EMPTY);
    assert.deepStrictEqual(parseCompletion({ choices: [{ message: { content: null } }], usage: { total_tokens: 401 } }),
      { ok: false, reason: "EMPTY", totalTokens: 401 }, "EMPTY keeps the usage for the budget");
    assert.deepStrictEqual(parseCompletion({ choices: [{ message: { content: "a\nb" }, finish_reason: "stop" }] }),
      { ok: true, text: "a\nb", finishReason: "stop", totalTokens: null });
    assert.strictEqual(parseCompletion({ choices: [{ message: { content: "a" } }], usage: { total_tokens: 42 } })
      .totalTokens, 42);
    assert.strictEqual(parseCompletion({ choices: [{ message: { content: "a" } }], usage: { total_tokens: -1 } })
      .totalTokens, null);
    for (const bad of [null, [], {}, { choices: [] }, { choices: [{}] }, { choices: [{ message: { content: 7 } }] }]) {
      assert.deepStrictEqual(parseCompletion(bad), { ok: false, reason: "BAD_SHAPE" }, JSON.stringify(bad));
    }
  });

  test("F3 reasoning: <think> blocks cut from content, reasoning / reasoning_content fields ignored", () => {
    const THOUGHT = "the user wants lines, let me think about {secret} www.leak.com";
    const ok = (message, usage) => parseCompletion({ choices: [{ message, finish_reason: "stop" }], usage });
    for (const field of ["reasoning", "reasoning_content"]) {
      assert.deepStrictEqual(ok({ [field]: THOUGHT, content: "o7 from {corp}\nfly safe" }),
        { ok: true, text: "o7 from {corp}\nfly safe", finishReason: "stop", totalTokens: null }, field);
      assert.deepStrictEqual(ok({ [field]: THOUGHT, content: null }, { total_tokens: 512 }),
        { ok: false, reason: "EMPTY", totalTokens: 512 }, `${field}: only reasoning -> EMPTY with the usage`);
    }
    assert.strictEqual(ok({ content: `<think>${THOUGHT}\nmore</think>\no7 from {corp}\nfly safe` }).text,
      "\no7 from {corp}\nfly safe");
    assert.strictEqual(ok({ content: `<THINK>a</THINK>line one<think>b</think>\nline two` }).text,
      "line one\nline two");
    assert.strictEqual(ok({ content: `${THOUGHT}\n</think>\nline one` }).text, "\nline one", "lone </think>");
    assert.deepStrictEqual(ok({ content: `<think>${THOUGHT} cut by max_tokens` }, { total_tokens: 600 }),
      { ok: false, reason: "EMPTY", totalTokens: 600 }, "unclosed <think> -> EMPTY");
    assert.strictEqual(ok({ content: `line one\n<think>${THOUGHT}` }).text, "line one\n");
    const S = settings();
    const bucket = { key: "fc.GENERIC", placeholders: ["corp", "system"] };
    const lines = filterTemplates(ok({ content: `<think>${THOUGHT}</think>\nfly safe out there {corp}` }).text,
      bucket, S, new Set());
    assert.deepStrictEqual([lines.accepted.map((x) => x.text), Object.values(lines.rejected).reduce((a, b) => a + b)],
      [["fly safe out there {corp}"], 0], "no reasoning text reaches the filter");
  });

  test("F4 filterTalkLine: speaker prefix and quotes off, names masked, PLACEHOLDER, DUPLICATE, profanity cap", () => {
    const S = settings();
    const base = { maxChars: 180, minChars: 4, speakerName: "Kaede Rin" };
    assert.deepStrictEqual(filterTalkLine("\n kaede rin: \"hold the gate, I am coming\"\nsecond line", base, S),
      { ok: true, line: "hold the gate, I am coming" });
    const named = { ...base, names: ["Pilot 12345"] };
    assert.deepStrictEqual(filterTalkLine("o7 Pilot 12345, nice ship you have", named, S),
      { ok: true, line: "o7 Pilot 12345, nice ship you have" }, "a name with digits passes thanks to the mask");
    assert.deepStrictEqual(filterTalkLine("o7 Pilot 12345, nice ship you have", base, S),
      { ok: false, reason: "DIGITS" }, "the same text outside the names");
    assert.deepStrictEqual(filterTalkLine("{system} is quiet tonight", base, S), { ok: false, reason: "PLACEHOLDER" });
    assert.deepStrictEqual(filterTalkLine("hold the gate, I am coming", { ...base, recent: ["Hold the gate! I am coming."] },
      S), { ok: false, reason: "DUPLICATE" });
    assert.deepStrictEqual(filterTalkLine("this one is far too long", { ...base, maxChars: 10 }, S),
      { ok: false, reason: "LENGTH" });
    assert.deepStrictEqual(filterTalkLine("  \n \n", base, S), { ok: false, reason: "EMPTY" });
    assert.deepStrictEqual(filterTalkLine(null, base, S), { ok: false, reason: "EMPTY" });
    const mild = "damn this belt is empty again";
    assert.strictEqual(filterTalkLine(mild, { ...base, profanityCap: "mild" }, S).ok, true);
    assert.deepStrictEqual(filterTalkLine(mild, { ...base, profanityCap: "off" }, S), { ok: false, reason: "BANNED" });
    const full = settings({ EVEJS_LNE_CHATTER_AI_PROFANITY: "full" });
    const strong = "shit, this belt is empty again";
    assert.strictEqual(filterTalkLine(strong, { ...base, profanityCap: "full" }, full).ok, true);
    assert.deepStrictEqual(filterTalkLine(strong, base, full), { ok: false, reason: "BANNED" }, "no cap = mild");
    assert.deepStrictEqual(filterTalkLine(strong, { ...base, names: ["Shi"] }, full), { ok: false, reason: "BANNED" },
      "name Shi does not mask shit");
    const digits = { ...base, names: ["Bob 12345"] };
    assert.strictEqual(filterTalkLine("o7 bob 12345, the belt is empty", digits, S).ok, true, "whole name masked");
    assert.deepStrictEqual(filterTalkLine("o7 bob 123456, the belt is empty", digits, S), { ok: false, reason: "DIGITS" },
      "a longer run of digits is not the name");
  });
};
