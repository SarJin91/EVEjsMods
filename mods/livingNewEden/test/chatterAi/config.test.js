"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { SCHEMA, resolveConfig } = require("../../config");
const { isSecretRow } = require("../../lib/observer/effectiveConfig");
const { chatterAiSettingsOf, apiKeyOf } = require("../../lib/chatterAi/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const KEY_TEXT = "nvapi-TEST";

function resolved(settings = {}, env = {}) {
  return resolveConfig({ env, settings, envFile: {}, modDir: MOD_DIR });
}

module.exports = ({ test }) => {
  test("C1 chatterAi defaults: enabled false, apiKey empty, settings valid without the key", () => {
    const r = resolved();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.config.chatterAi.enabled, false);
    assert.strictEqual(r.config.chatterAi.apiKey, "");
    assert.strictEqual(apiKeyOf(r.config), "");
    assert.deepStrictEqual(r.warnings, []);
    const s = chatterAiSettingsOf(r.config);
    assert.strictEqual(s.ok, true, JSON.stringify(s));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(s.settings, "apiKey"), false);
    const { baseUrl, model, linesPerRequest, bannedWordList } = s.settings;
    assert.deepStrictEqual([baseUrl, model, linesPerRequest, bannedWordList],
      ["https://integrate.api.nvidia.com/v1", "nvidia/nemotron-3.5-super-vl-120b-a12b", 8, []]);
  });

  test("C4: reasoningOff default true, not a boolean -> INVALID_SETTINGS; maxTokens fits the lines", () => {
    const r = resolved();
    const S = chatterAiSettingsOf(r.config).settings;
    assert.strictEqual(S.reasoningOff, true);
    assert.strictEqual(resolved({}, { EVEJS_LNE_CHATTER_AI_REASONING_OFF: "0" }).config.chatterAi.reasoningOff, false);
    assert.deepStrictEqual(chatterAiSettingsOf({ chatterAi: { ...r.config.chatterAi, reasoningOff: "yes" } }),
      { ok: false, reason: "INVALID_SETTINGS", detail: "chatterAi.reasoningOff: not a boolean" });
    const CHARS_PER_TOKEN = 3;
    const need = S.linesPerRequest * (Math.ceil(S.maxTemplateChars / CHARS_PER_TOKEN) + 1);
    assert.ok(S.maxTokens >= need, `maxTokens ${S.maxTokens} < ${need}`);
    assert.ok(S.maxTokens * 100 <= S.dailyTokenBudget, "100 requests a day at the worst case at least");
  });

  test("C2 apiKey env-only: settings.json value ignored with a warning without it; env accepted; secret row", () => {
    const fromFile = resolved({ chatterAi: { apiKey: KEY_TEXT } });
    assert.strictEqual(fromFile.config.chatterAi.apiKey, "");
    assert.strictEqual(fromFile.sources["chatterAi.apiKey"], "default");
    assert.deepStrictEqual(fromFile.warnings,
      ['settings.json "chatterAi.apiKey" is env-only (set EVEJS_LNE_CHATTER_AI_API_KEY) - ignored']);
    assert.ok(!JSON.stringify(fromFile.warnings).includes(KEY_TEXT));

    const fromEnv = resolved({}, { EVEJS_LNE_CHATTER_AI_API_KEY: KEY_TEXT });
    assert.deepStrictEqual(fromEnv.warnings, []);
    assert.strictEqual(fromEnv.config.chatterAi.apiKey, KEY_TEXT);
    assert.strictEqual(fromEnv.sources["chatterAi.apiKey"], "environment");
    assert.strictEqual(apiKeyOf(fromEnv.config), KEY_TEXT);
    const s = chatterAiSettingsOf(fromEnv.config);
    assert.ok(s.ok && !JSON.stringify(s).includes(KEY_TEXT), "the settings never hold the key");

    const row = SCHEMA.find((x) => x.key === "chatterAi.apiKey");
    assert.deepStrictEqual([row.secret, row.envOnly, isSecretRow(row)], [true, true, true]);
  });

  test("C3 baseUrl http:// -> INVALID_SETTINGS, the detail holds no URL; config layer refuses it too", () => {
    const base = resolved().config;
    const bad = chatterAiSettingsOf({ chatterAi: { ...base.chatterAi, baseUrl: "http://leak.example.test/v1" } });
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.reason, "INVALID_SETTINGS");
    assert.ok(bad.detail.startsWith("chatterAi.baseUrl:"), bad.detail);
    assert.ok(!bad.detail.includes("leak.example"), bad.detail);
    const layered = resolved({}, { EVEJS_LNE_CHATTER_AI_BASE_URL: "http://leak.example.test/v1" });
    assert.strictEqual(layered.config.chatterAi.baseUrl, "https://integrate.api.nvidia.com/v1");
    assert.strictEqual(layered.warnings.length, 1);
    const order = chatterAiSettingsOf({ chatterAi: { ...base.chatterAi, lowWaterPerBucket: 20, poolPerBucket: 10 } });
    assert.deepStrictEqual([order.ok, order.detail],
      [false, "chatterAi.lowWaterPerBucket above chatterAi.poolPerBucket"]);
  });

  test("C5 talk keys: defaults, env layer; talkReservedPerMinute not below maxRequestsPerMinute -> INVALID_SETTINGS", () => {
    const r = resolved();
    const S = chatterAiSettingsOf(r.config).settings;
    assert.deepStrictEqual([S.talkMaxTokens, S.talkTokenSharePermille, S.talkReservedPerMinute, S.talkMaxInFlight,
      S.talkMaxPromptChars], [160, 500, 4, 2, 8000]);
    assert.strictEqual(resolved({}, { EVEJS_LNE_CHATTER_AI_TALK_MAX_IN_FLIGHT: "1" }).config.chatterAi.talkMaxInFlight, 1);
    const over = chatterAiSettingsOf({ chatterAi: { ...r.config.chatterAi, maxRequestsPerMinute: 3 } });
    const RULE = "chatterAi.talkReservedPerMinute not below chatterAi.maxRequestsPerMinute";
    assert.deepStrictEqual([over.ok, over.detail], [false, RULE]);
    const equal = chatterAiSettingsOf({ chatterAi: { ...r.config.chatterAi, maxRequestsPerMinute: 4 } });
    assert.deepStrictEqual([equal.ok, equal.detail], [false, RULE]);
    const none = chatterAiSettingsOf({ chatterAi: { ...r.config.chatterAi, maxRequestsPerMinute: 0,
      talkReservedPerMinute: 0 } });
    assert.strictEqual(none.ok, true);
  });

  test("C6 news keys: defaults 1200 / 50 / 8000 / 60000, env layer", () => {
    const S = chatterAiSettingsOf(resolved().config).settings;
    assert.deepStrictEqual([S.newsMaxTokens, S.newsTokenSharePermille, S.newsMaxPromptChars, S.newsTimeoutMs],
      [1200, 50, 8000, 60000]);
    assert.strictEqual(resolved({}, { EVEJS_LNE_CHATTER_AI_NEWS_TIMEOUT_MS: "9000" }).config.chatterAi.newsTimeoutMs,
      9000);
  });
};
