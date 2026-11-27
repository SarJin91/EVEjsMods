"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { filterReply, fixWords } = require("../../lib/shipAi/filter");
const { createConversation } = require("../../lib/shipAi/conversation");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { buildSystemPrompt } = require("../../lib/shipAi/persona");
const chatterFilter = require("../../lib/chatterAi/filter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

module.exports = ({ test }) => {
  test("C2 filter: sexual / meta / link / banned / charset -> refused; markdown off; \"ship AI\" allowed; a pl reply "
    + "with Polish letters and typography passes, split into <= maxLinesPerReply lines of <= maxLineChars", async () => {
    assert.deepStrictEqual(["bannedPatterns", "bannedHit", "hasLink"].map((k) => typeof chatterFilter[k]),
      ["function", "function", "function"], "additive chatterAi exports");
    const en = settings();
    const cases = [
      ["Let us talk about sex tonight, captain.", "SEXUAL"],
      ["You look so naked in that pod.", "SEXUAL"],
      ["Speaking out of character, this is a roleplay.", "META"],
      ["As a language model I cannot do that.", "BANNED"],
      ["Check www.example.com for routes.", "LINK"],
      ["That is fucking great.", "BANNED"],
      ["Price <b>100</b> ISK & more", "CHARSET"],
      ["   ", "EMPTY"],
    ];
    for (const [text, reason] of cases) assert.deepStrictEqual(filterReply(text, en, "en"), { ok: false, reason }, text);
    assert.deepStrictEqual(filterReply("**Hello** _captain_, I am your ship AI. \u{1F680}", en, "en"),
      { ok: true, lines: ["Hello captain, I am your ship AI."] });
    assert.deepStrictEqual(filterReply("Jita sits at 0.9 security. Fly safe.", en, "en").lines,
      ["Jita sits at 0.9 security. Fly safe."]);

    const pl = settings({ language: "pl", maxLineChars: 60, maxLinesPerReply: 2 });
    const text = "Witaj, kapitanie! To była długa podróż — „Jita” jest dziś zatłoczona. "
      + "Uważaj na bramach, bo w okolicy kręcą się piraci. Trzeci akapit już się nie zmieści.";
    const ok = filterReply(text, pl, "pl");
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.strictEqual(ok.lines.length, 2);
    assert.ok(ok.lines.every((l) => l.length <= 60), JSON.stringify(ok.lines));
    assert.ok(ok.lines.join(" ").includes("zatłoczona") && ok.lines.join(" ").includes("\"Jita\""), ok.lines[0]);
    assert.ok(!ok.lines.join(" ").includes("Trzeci"), "the rest is cut at a sentence");
    assert.deepStrictEqual(filterReply("Porozmawiajmy o seksie, kapitanie.", pl, "pl"),
      { ok: false, reason: "SEXUAL" });
    assert.deepStrictEqual(filterReply("Let us talk about sex.", pl, "pl"), { ok: false, reason: "SEXUAL" },
      "pl checks the en lists too");

    const sent = [];
    const saved = [];
    const metrics = [];
    const replies = ["You look so naked tonight, captain.", "Out of character: roleplay ends.",
      "Visit www.example.com now."];
    const store = { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) };
    const turnsRepo = { listRecent: () => ({ ok: true, rows: [] }),
      appendExchangeInTx: (_db, spec) => { saved.push(spec); return { ok: true }; } };
    const conv = createConversation({ S: settings({ minIntervalMs: 0 }), store, turnsRepo,
      client: { request: () => Promise.resolve({ ok: true, text: replies.shift(), toolCalls: null, totalTokens: 9 }) },
      nowMs: () => 1000, setTimer: () => ({ cancel() {}, hasRef: () => false }),
      telemetry: { count: (name) => metrics.push(name), observe() {} }, logger: { log() {} }, nameOf: () => "Jin",
      snapshot: () => ({ ok: true, json: "{}", presence: null }),
      deliver: (playerId, lines) => { sent.push(...lines); return { room: lines.length, system: 0, failed: 0 }; } });
    for (let i = 0; i < 3; i += 1) {
      conv.onMessage(9001, `line ${i}`);
      for (let k = 0; k < 4; k += 1) await new Promise((resolve) => setImmediate(resolve));
    }
    assert.strictEqual(sent.length, 3);
    assert.ok(sent.every((l) => STATIC.en.DEFLECT.includes(l)), JSON.stringify(sent));
    assert.deepStrictEqual(saved, []);
    assert.deepStrictEqual(metrics, ["shipAi.rejected", "shipAi.rejected", "shipAi.rejected"]);
    const c = conv.getStatus().counters;
    assert.deepStrictEqual([c.rejected, c.rejected_SEXUAL, c.rejected_META, c.rejected_LINK], [3, 1, 1, 1]);
    conv.stop();
  });

  test("CY1 persona: the pl / en prompt holds the space anime warship style, no cyber slang and no forbidden proper "
    + "name; the extended static lines pass filterReply as one line and hold no cyber slang", () => {
    const pl = buildSystemPrompt({ aiName: "Jin", playerName: "Pilot", language: "pl", maxLines: 3 });
    const en = buildSystemPrompt({ aiName: "Jin", playerName: "Pilot", language: "en", maxLines: 3 });
    assert.ok(pl.includes("Mówisz jak AI okrętu z kosmicznego anime") && pl.includes("członkini załogi na mostku")
      && pl.includes("„Kontakt na radarze”"), pl);
    assert.ok(en.includes("You sound like a warship AI in space anime") && en.includes("crew on the bridge")
      && en.includes("\"Contact on radar\""), en);
    const CYBER = { en: /cyber|ghost|\bshell\b|chrome|glitch|jack in|net noise|\bice\b|diving into the net/i,
      pl: /cyber|duch|powłok|chrom|glitch|szum sieci|\blód\b|\blodu\b|podpi|w sieć/i };
    assert.ok(!CYBER.pl.test(pl), pl);
    assert.ok(!CYBER.en.test(en), en);
    const forbidden = ["ghost in the shell", "cyberpunk 2077", "major", "kusanagi", "night city", "arasaka", "militech",
      "section 9", "yamato", "macross", "gundam", "nadesico", "evangelion", "galactic heroes"];
    for (const text of [pl, en]) {
      for (const name of forbidden) assert.ok(!text.toLowerCase().includes(name), name);
    }
    const STYLE_KINDS = ["TIRED", "SIGNAL_LOST", "DEFLECT", "GREETING", "ACK", "SHIP_CHANGE", "SILENCE", "THINKING"];
    for (const lang of ["pl", "en"]) {
      const S2 = settings({ language: lang, maxLineChars: 120, maxLinesPerReply: 1 });
      for (const kind of Object.keys(STATIC[lang])) {
        for (const line of STATIC[lang][kind]) assert.ok(!CYBER[lang].test(line), `${lang} ${kind}: ${line}`);
      }
      for (const kind of STYLE_KINDS) {
        assert.ok(STATIC[lang][kind].length >= 2, `${lang} ${kind}`);
        for (const line of STATIC[lang][kind]) {
          const r = filterReply(line, S2, lang);
          assert.ok(r.ok && r.lines.length === 1, `${lang} ${kind}: ${line} ${JSON.stringify(r)}`);
        }
      }
    }
  });

  test("PLS1 pl spelling: the EVE word list + the rule in the pl prompt of every preset (not in en), the invented words "
    + "of the example fixed on whole words with the case kept, en unchanged, temperatureMilli 650", () => {
    const WORDS = ["zadokować", "wydokować (wylecieć ze stacji)", "warp", "namierzyć cel", "wrak", "kapsuła",
      "osłony, pancerz, kadłub", "Używaj tylko istniejących polskich słów", "angielskiego terminu EVE"];
    for (const preset of ["default", "savage", "cold", "flirty", "captain"]) {
      const pl = buildSystemPrompt({ aiName: "Jin", playerName: "Pilot", language: "pl", maxLines: 3, preset });
      for (const w of WORDS) assert.ok(pl.includes(w), `${preset}: ${w}`);
      const en = buildSystemPrompt({ aiName: "Jin", playerName: "Pilot", language: "en", maxLines: 3, preset });
      assert.ok(!en.includes("Słowa EVE") && !en.includes("wydokować"), preset);
    }
    const pl = settings({ language: "pl", maxLineChars: 200, maxLinesPerReply: 3 });
    const r = filterReply("Silniki humlą, kapitanie. W końcu odkutowaliśmy. Odkotowanie gotowe, humlają dalej.",
      pl, "pl");
    assert.deepStrictEqual(r, { ok: true,
      lines: ["Silniki mruczą, kapitanie. W końcu wydokowaliśmy. Wydokowanie gotowe, mruczą dalej."] });
    assert.deepStrictEqual(fixWords("przyodkutowany humląc", "pl"), "przyodkutowany humląc");
    const enText = "Engines humli, we odkutowali.";
    assert.strictEqual(fixWords(enText, "en"), enText);
    assert.deepStrictEqual(filterReply(enText, settings(), "en"), { ok: true, lines: [enText] });
    assert.strictEqual(base.shipAi.temperatureMilli, 650);
  });
};
