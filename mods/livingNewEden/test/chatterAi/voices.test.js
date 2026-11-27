"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { chatterAiSettingsOf, LANGUAGE_CODES } = require("../../lib/chatterAi/schema");
const { filterTemplates, normalizeLine, effectiveProfanity, charsetOf } = require("../../lib/chatterAi/filter");
const { buildMessages } = require("../../lib/chatterAi/prompt");
const { buildBucketSpecs } = require("../../lib/chatterAi/buckets");
const { BANNED, BANNED_WORDS } = require("../../lib/chatterAi/data/bannedWords");
const { LANGUAGES } = require("../../lib/chatterAi/data/languages");
const { startChatterAi, createUnavailableChatterAi } = require("../../lib/chatterAi");
const { createRegistry } = require("../../lib/telemetry/registry");
const hsData = require("../../lib/highsecLife/data/chatterLines");
const fcData = require("../../lib/freeCorps/data/chatterLines");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const KEY = "nvapi-TEST-KEY";
const T0 = 1700000000000;
const OLD_CHARSET_RE = /^[A-Za-z0-9 .,!?'":;()\-/%+*{}\[\]]+$/;
const oldNormalize = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const OLD_BANNED_WORDS = ["ai", "a i", "artificial intelligence", "language model", "assistant", "prompt", "openai",
  "nvidia", "chatgpt", "gpt", "llm", "llama", "chatbot", "as a bot", "ccp", "discord", "reddit", "twitch", "youtube",
  "twitter", "facebook", "fuck", "fucking", "fucker", "shit", "cunt", "bitch", "bastard", "whore", "slut", "rape",
  "nigger", "nigga", "faggot", "fag", "retard", "retarded", "nazi", "kys", "kill yourself"];
const OLD_SYSTEM_TEXT = "You write short lines spoken by NPC pilots in the Local chat channel of a science fiction game "
  + "in the style of EVE Online. Casual tone, English only. Write one line per row, with no numbering, no quotes, no "
  + "emoji and no links. Never mention AI, prompts, real people or real brands. Every line has at most 160 characters. "
  + "Placeholders are words in curly braces, written exactly like {name}, and only from the given list; a line may use "
  + "none of them.";

function resolved(env = {}) {
  return resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
}

function settings(env = {}) {
  const s = chatterAiSettingsOf(resolved(env).config);
  assert.strictEqual(s.ok, true, JSON.stringify(s));
  return s.settings;
}

const residentOne = { CONTEXTS: ["GENERIC"], PLACEHOLDERS: ["system", "corp", "isk"],
  LINES: { GENERIC: [{ text: "o7 from {corp}" }, { text: "fly safe everyone" }] } };

function voiceEntry(over = {}) {
  return { key: "fv.GURISTAS.CHATTER", lane: "voice", hint: "pirate crew talk on Local", style: "cocky pirates",
    profanityCap: "full", onDemand: true, placeholders: ["system", "pilot"],
    lines: [{ text: "{system} belongs to us today" }, { text: "keep the guns warm, boys" }], ...over };
}

function fakeTimers() {
  const list = [];
  return {
    setTimer(fn, ms) {
      const t = { fn, ms, live: true };
      list.push(t);
      return { cancel: () => { t.live = false; }, hasRef: () => false };
    },
    fire() {
      const t = list.filter((x) => x.live).pop();
      assert.ok(t, "no armed timer");
      t.live = false;
      t.fn();
    },
  };
}

function rig(env, buckets) {
  const clock = { t: T0 };
  const timers = fakeTimers();
  const calls = [];
  const transport = { post: (spec) => new Promise((resolve) => calls.push({ spec, resolve })) };
  const registry = createRegistry({ histogramSamples: 16, maxMetrics: 64 });
  const config = resolved({ EVEJS_LNE_CHATTER_AI_ENABLED: "1", EVEJS_LNE_CHATTER_AI_API_KEY: KEY, ...env }).config;
  const r = startChatterAi({ config, clock: { now: () => clock.t }, nowMs: () => clock.t, logger: { log: () => {} },
    telemetry: registry, setTimer: timers.setTimer, transport, buckets, getGovernor: () => null });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { ai: r.chatterAi, clock, timers, calls, registry };
}

const okJson = (text) => ({ ok: true, status: 200,
  json: { choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { total_tokens: 120 } } });
const flush = () => new Promise((resolve) => setImmediate(resolve));

module.exports = ({ test }) => {
  test("V1 en + mild bit for bit: system prompt snapshot, CHARSET U+0000-U+00FF, normalizeLine of static lines", () => {
    const S = settings();
    assert.deepStrictEqual([S.language, S.profanity, S.demandWindowMs, S.voiceTokenSharePermille],
      ["en", "mild", 3600000, 500]);
    assert.deepStrictEqual(Object.keys(LANGUAGES), [...LANGUAGE_CODES]);
    const bucket = buildBucketSpecs({ civilian: null, resident: residentOne }, S).buckets[0];
    const msgs = buildMessages(bucket, S);
    assert.strictEqual(msgs[0].content, OLD_SYSTEM_TEXT);
    assert.ok(!msgs[1].content.includes("Style:") && !msgs[1].content.includes("Swearing")
      && !msgs[1].content.includes("Polish"), msgs[1].content);
    const en = charsetOf("en");
    for (let code = 0; code <= 0xff; code += 1) {
      const ch = String.fromCharCode(code);
      assert.strictEqual(en.test(ch), OLD_CHARSET_RE.test(ch), `U+${code.toString(16)}`);
    }
    const texts = [
      ...Object.values(hsData.BACKGROUND).flat(), ...Object.values(hsData.RUMOURS).flat(),
      ...Object.values(fcData.LINES).flat(),
    ].map((x) => x.text);
    assert.ok(texts.length > 100, `static lines ${texts.length}`);
    for (const t of texts) assert.strictEqual(normalizeLine(t), oldNormalize(t), t);
  });

  test("V2 pl: Polish letters pass CHARSET, typography folded first, < > & refused; prompt rows; bad enum refused", () => {
    const S = settings({ EVEJS_LNE_CHATTER_AI_LANGUAGE: "pl" });
    const bucket = { key: "hs.bg.TRADE", placeholders: ["system"] };
    const text = [
      "Załoga mówi, że w {system} jest źle",
      "„Tu jest spokojnie – może jutro…”",
      "Rozkaz: <b>uciekamy</b> z pasa teraz",
      "Ruda & gaz na bramie od rana",
    ].join("\n");
    const r = filterTemplates(text, bucket, S, new Set());
    assert.deepStrictEqual(r.accepted.map((x) => x.text),
      ["Załoga mówi, że w {system} jest źle", "Tu jest spokojnie - może jutro..."]);
    assert.strictEqual(r.rejected.CHARSET, 2);
    const asEn = filterTemplates(text, bucket, settings(), new Set());
    assert.deepStrictEqual([asEn.accepted.length, asEn.rejected.CHARSET], [0, 4]);

    const msgs = buildMessages(buildBucketSpecs({ civilian: null, resident: residentOne }, S).buckets[0], S);
    assert.ok(msgs[0].content.includes("Casual tone, Polish only.") && !msgs[0].content.includes("English only"));
    const rows = msgs[1].content.split("\n");
    assert.deepStrictEqual(rows.slice(-2),
      ["Write the lines in Polish; the examples are in English.", "Write 8 new varied lines."]);

    const bad = resolved({ EVEJS_LNE_CHATTER_AI_LANGUAGE: "de", EVEJS_LNE_CHATTER_AI_PROFANITY: "extreme" });
    assert.deepStrictEqual([bad.config.chatterAi.language, bad.config.chatterAi.profanity, bad.warnings.length],
      ["en", "mild", 2]);
    const base = bad.config.chatterAi;
    assert.deepStrictEqual(chatterAiSettingsOf({ chatterAi: { ...base, language: "de" } }),
      { ok: false, reason: "INVALID_SETTINGS", detail: "chatterAi.language: not one of en, pl" });
    assert.deepStrictEqual(chatterAiSettingsOf({ chatterAi: { ...base, profanity: "extreme" } }),
      { ok: false, reason: "INVALID_SETTINGS", detail: "chatterAi.profanity: not one of off, mild, full" });
  });

  test("V3 profanity matrix: min(global, cap ?? mild) x word category, en and pl; BANNED_WORDS = old list", () => {
    assert.deepStrictEqual([...BANNED_WORDS].sort(), [...OLD_BANNED_WORDS].sort());
    assert.deepStrictEqual(new Set([...BANNED.en.meta, ...BANNED.en.slurs, ...BANNED.en.strong]),
      new Set(OLD_BANNED_WORDS));
    assert.deepStrictEqual(
      [["off", "full"], ["full", undefined], ["full", "full"], ["mild", "full"], ["full", "off"], ["bad", "full"]]
        .map(([g, c]) => effectiveProfanity(g, c)), ["off", "mild", "full", "mild", "off", "mild"]);
    const words = {
      en: { meta: "chatgpt", slurs: "kys", strong: "shit", mild: "damn" },
      pl: { meta: "nvidia", slurs: "dziwką", strong: "wkurwiony", mild: "cholerny" },
    };
    const table = [
      ["off", "full", "mild", true], ["off", "full", "strong", true],
      ["mild", undefined, "mild", false], ["mild", "full", "strong", true],
      ["full", undefined, "strong", true], ["full", "mild", "strong", true], ["full", "full", "strong", false],
      ["full", "full", "mild", false], ["full", "off", "mild", true],
      ["full", "full", "meta", true], ["full", "full", "slurs", true], ["off", "off", "meta", true],
    ];
    for (const lang of ["en", "pl"]) {
      for (const [global, cap, cat, banned] of table) {
        const S = settings({ EVEJS_LNE_CHATTER_AI_LANGUAGE: lang, EVEJS_LNE_CHATTER_AI_PROFANITY: global });
        const bucket = { key: "fv.X.CHATTER", placeholders: [], profanityCap: cap };
        const r = filterTemplates(`we flew past the ${words[lang][cat]} gate today`, bucket, S, new Set());
        assert.strictEqual(r.rejected.BANNED, banned ? 1 : 0, `${lang} ${global} ${cap} ${cat}`);
      }
    }
    const pl = settings({ EVEJS_LNE_CHATTER_AI_LANGUAGE: "pl", EVEJS_LNE_CHATTER_AI_PROFANITY: "full" });
    const full = { key: "fv.X.CHATTER", placeholders: [], profanityCap: "full" };
    assert.strictEqual(filterTemplates("lecimy dalej, a fucking gate today", full, pl, new Set()).rejected.BANNED, 0);
    assert.strictEqual(filterTemplates("as an assistant I fly to the gate", full, pl, new Set()).rejected.BANNED, 1,
      "en meta at pl");
    assert.strictEqual(filterTemplates("we said hello at the gate today", full, settings(), new Set()).rejected.BANNED,
      0, "whole word: ai does not hit said");
  });

  test("V4 voice buckets: spec fields; onDemand skipped without demand, picked after demand; voice token share", async () => {
    const S = settings();
    const plain = buildBucketSpecs({ civilian: null, resident: residentOne }, S);
    const withVoice = buildBucketSpecs({ civilian: null, resident: residentOne, voice: [voiceEntry()] }, S);
    assert.strictEqual(withVoice.ok, true, JSON.stringify(withVoice));
    assert.deepStrictEqual(withVoice.buckets[0], plain.buckets[0], "hs / fc specs unchanged");
    assert.deepStrictEqual(buildBucketSpecs({ civilian: null, resident: residentOne, voice: null }, S), plain);
    const v = withVoice.buckets[1];
    assert.deepStrictEqual([v.key, v.lane, v.kind, v.style, v.profanityCap, v.onDemand, v.placeholders],
      ["fv.GURISTAS.CHATTER", "voice", "voice", "cocky pirates", "full", true, ["system"]]);
    const user = buildMessages(v, S)[1].content.split("\n");
    assert.deepStrictEqual(user.slice(0, 3), ["Topic: pirate crew talk on Local", "Style: cocky pirates",
      "Swearing: mild words at most, no strong swearing."]);
    assert.strictEqual(buildBucketSpecs({ civilian: null, resident: null, voice: [voiceEntry({ lane: "civilian" })] },
      S).reason, "BAD_CATALOGUE");
    assert.strictEqual(buildBucketSpecs({ civilian: null, resident: null,
      voice: [voiceEntry(), voiceEntry()] }, S).detail, "duplicate bucket key fv.GURISTAS.CHATTER");

    const r = rig({}, [v]);
    r.timers.fire();
    assert.strictEqual(r.calls.length, 0, "no demand -> no request");
    r.ai.demand(v.key);
    r.ai.demand("fv.UNKNOWN.CHATTER");
    r.timers.fire();
    assert.strictEqual(r.calls.length, 1, "demand -> request");
    assert.ok(r.calls[0].spec.body.includes("Style: cocky pirates"));
    r.calls[0].resolve(okJson("we own {system} this week\nnobody warps in here alive\nguns hot and ready now"));
    await flush();
    let st = r.ai.getStatus();
    assert.deepStrictEqual(st.byLane, { civilian: { requests: 0, linesAccepted: 0, tokens: 0 },
      resident: { requests: 0, linesAccepted: 0, tokens: 0 }, voice: { requests: 1, linesAccepted: 3, tokens: 120 },
      talk: { requests: 0, linesAccepted: 0, tokens: 0 }, news: { requests: 0, linesAccepted: 0, tokens: 0 },
      plot: { requests: 0, linesAccepted: 0, tokens: 0 } });
    assert.deepStrictEqual([r.registry.counter("chatterAi.voiceRequests"), st.voiceTokensToday], [1, 120]);
    r.clock.t += 3600001;
    r.timers.fire();
    assert.strictEqual(r.calls.length, 1, "demand older than demandWindowMs -> skipped");
    r.ai.overlay().linesOf(v.key);
    r.timers.fire();
    assert.strictEqual(r.calls.length, 2, "linesOf is a demand too");
    r.ai.stop("test");

    const fc = buildBucketSpecs({ civilian: null, resident: residentOne }, S).buckets[0];
    const poor = rig({ EVEJS_LNE_CHATTER_AI_DAILY_TOKEN_BUDGET: "4000", EVEJS_LNE_CHATTER_AI_VOICE_TOKEN_SHARE_PERMILLE:
      "100" }, [v, fc]);
    poor.ai.demand(v.key);
    poor.timers.fire();
    st = poor.ai.getStatus();
    assert.deepStrictEqual([poor.calls.length, st.counters.voiceBudgetExhausted, st.byLane.resident.requests,
      st.byLane.voice.requests, st.counters.budgetExhausted], [1, 1, 1, 0, 0]);
    assert.ok(poor.calls[0].spec.body.includes("Topic: ") && !poor.calls[0].spec.body.includes("Style:"));
    poor.ai.stop("test");
  });

  test("V5 real facades running / off / unavailable: method lists hold demand, demand never throws", () => {
    const running = rig({}, buildBucketSpecs({ civilian: null, resident: residentOne }, settings()).buckets).ai;
    const off = startChatterAi({ config: resolved().config, clock: { now: () => T0 } }).chatterAi;
    const unavailable = createUnavailableChatterAi("stopped");
    for (const [name, f] of [["running", running], ["off", off], ["unavailable", unavailable]]) {
      assert.deepStrictEqual(Object.keys(f).sort(), ["complete", "demand", "getStatus", "overlay", "stop"], name);
      for (const key of ["fc.GENERIC", undefined, null, 7, {}]) assert.strictEqual(f.demand(key), undefined, name);
    }
    running.stop("test");
  });
};
