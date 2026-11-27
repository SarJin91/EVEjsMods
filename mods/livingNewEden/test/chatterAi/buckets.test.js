"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { chatterAiSettingsOf } = require("../../lib/chatterAi/schema");
const { buildBucketSpecs } = require("../../lib/chatterAi/buckets");
const { buildMessages, buildRequestBody } = require("../../lib/chatterAi/prompt");
const { BUCKET_HINTS } = require("../../lib/chatterAi/data/bucketHints");
const hsData = require("../../lib/highsecLife/data/chatterLines");
const { PLACEHOLDERS: HS_PLACEHOLDERS } = require("../../lib/highsecLife/chatter");
const fcData = require("../../lib/freeCorps/data/chatterLines");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function settings() {
  const r = resolveConfig({ env: {}, settings: {}, envFile: {}, modDir: MOD_DIR });
  return chatterAiSettingsOf(r.config).settings;
}

module.exports = ({ test }) => {
  test("B1 both catalogues: one bucket per category / rumour kind / context, own hint, placeholders in the set", () => {
    const S = settings();
    const civilian = { ...hsData, PLACEHOLDERS: HS_PLACEHOLDERS };
    const r = buildBucketSpecs({ civilian, resident: fcData }, S);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const expectedKeys = [
      ...hsData.BACKGROUND_CATEGORIES.map((c) => `hs.bg.${c}`),
      ...Object.keys(hsData.RUMOURS).map((k) => `hs.rumour.${k}`),
      ...fcData.CONTEXTS.map((c) => `fc.${c}`),
    ];
    assert.deepStrictEqual(r.buckets.map((b) => b.key), expectedKeys);
    for (const b of r.buckets) {
      assert.ok(Object.prototype.hasOwnProperty.call(BUCKET_HINTS, b.key), `no own hint ${b.key}`);
      assert.strictEqual(b.hint, BUCKET_HINTS[b.key]);
      const set = b.lane === "civilian" ? HS_PLACEHOLDERS : fcData.PLACEHOLDERS;
      assert.ok(b.placeholders.every((p) => set.includes(p)), `${b.key} placeholders ${b.placeholders}`);
      assert.ok(b.examples.length <= S.promptExamples && b.examples.length > 0, b.key);
      assert.ok(/^[\x20-\x7e]+$/.test(b.hint) && !/[{}]/.test(b.hint), `hint ${b.key}`);
    }
    const trade = r.buckets[0];
    assert.deepStrictEqual([trade.kind, trade.placeholders, trade.staticNormalized.has("wtb item in bulk paying well")],
      ["background", ["system", "region", "item"], true]);
    const unknown = buildBucketSpecs({ civilian: null, resident: { ...fcData, CONTEXTS: ["NEW_CTX"] } }, S);
    assert.deepStrictEqual(unknown, { ok: false, reason: "BAD_CATALOGUE", detail: "no hint for fc.NEW_CTX" });
    assert.strictEqual(buildBucketSpecs({ civilian: null, resident: null }, S).reason, "NO_BUCKETS");
  });

  test("B2 buildMessages of one bucket: user text = hint + placeholders + examples only (snapshot); body", () => {
    const S = settings();
    const resident = { CONTEXTS: ["GENERIC"], PLACEHOLDERS: ["system", "corp", "isk"],
      LINES: { GENERIC: [{ text: "o7 from {corp}" }, { text: "fly safe everyone" },
        { text: "{corp} says hi to {system}" }, { text: "fourth line not shown" }] } };
    const r = buildBucketSpecs({ civilian: null, resident }, S);
    const msgs = buildMessages(r.buckets[0], S);
    assert.deepStrictEqual(msgs.map((m) => m.role), ["system", "user"]);
    assert.strictEqual(msgs[1].content, [
      `Topic: ${BUCKET_HINTS["fc.GENERIC"]}`,
      "Placeholders: {system} {corp}",
      "Examples:",
      "- o7 from {corp}",
      "- fly safe everyone",
      "- {corp} says hi to {system}",
      "Write 8 new varied lines.",
    ].join("\n"));
    assert.ok(msgs[0].content.includes("at most 160 characters") && !msgs[0].content.includes("o7"));
    const body = JSON.parse(buildRequestBody(r.buckets[0], S));
    assert.deepStrictEqual([body.model, body.temperature, body.top_p, body.max_tokens, body.stream],
      ["nvidia/nemotron-3.5-super-vl-120b-a12b", 0.9, 0.95, 512, false]);
    assert.deepStrictEqual(body.messages, msgs);
    assert.deepStrictEqual(body.chat_template_kwargs, { enable_thinking: false });
    const plain = JSON.parse(buildRequestBody(r.buckets[0], { ...S, reasoningOff: false }));
    assert.deepStrictEqual(Object.keys(plain), ["model", "messages", "temperature", "top_p", "max_tokens", "stream"]);
  });
};
