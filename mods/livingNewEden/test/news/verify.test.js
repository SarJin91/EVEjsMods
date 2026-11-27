"use strict";

const assert = require("node:assert");

const { buildNewsMessages } = require("../../lib/news/prompt");
const { verifyNewsText } = require("../../lib/news/verify");

const B = Date.UTC(2026, 10, 15, 17, 0, 0);
const H = 3600000;
const SETTINGS = Object.freeze({ minBodyChars: 60, maxBodyChars: 3000, minParagraphs: 2, maxParagraphs: 8,
  maxTitleChars: 100 });
const KNOWN = Object.freeze(["Jita", "Amarr", "Dodixie", "The Forge", "Domain", "Amarr Empire", "Caldari State",
  "Gallente Federation"]);

module.exports = ({ test }) => {
  test("V1 news verify: ok; NUMBER_UNSOURCED; NAME_UNSOURCED; Amarr inside Amarr Empire; SHAPE; COVERAGE; prompt",
    () => {
      const facts = [
        { factKey: "w:1", kind: "SYSTEM_CAPTURED", at: B - 2 * H, systemId: 1, weight: 80,
          data: { systemName: "Dodixie", regionName: "Sinq Laison", factionA: "Amarr Empire",
            factionB: "Gallente Federation" } },
        { factKey: "bt:1", kind: "BATTLE", at: B - 3 * H, systemId: 2, weight: 32,
          data: { systemName: "Amamake", regionName: "Heimatar", factionA: "Amarr Empire",
            factionB: "Gallente Federation", destroyed: 12 } },
      ];
      const built = buildNewsMessages(facts, { language: "en", boundaryAt: B, cycleHours: 24, maxPromptChars: 8000 });
      assert.deepStrictEqual(built.messages.map((m) => m.role), ["system", "user"]);
      assert.strictEqual(built.factLines.length, 2);
      assert.ok(built.factLines[0].startsWith("F1 | System captured | ") && built.factLines[0].endsWith("| 15:00 UTC"),
        built.factLines[0]);
      assert.ok(built.numbers.has("12") && built.numbers.has("15") && built.numbers.has("0"));
      assert.deepStrictEqual([...built.factNames].sort(), ["Amamake", "Amarr Empire", "Dodixie", "Gallente Federation",
        "Heimatar", "Sinq Laison"]);
      const cut = buildNewsMessages(facts, { language: "en", boundaryAt: B, cycleHours: 24,
        maxPromptChars: built.messages[1].content.length - 1 });
      assert.strictEqual(cut.factLines.length, 1, "the lowest weight goes first");

      const ctx = { numbers: built.numbers, factNames: built.factNames, knownNames: KNOWN,
        topSystemNames: ["Dodixie", "Amamake"], settings: SETTINGS };
      const good = "TITLE: Dodixie falls to the Amarr Empire\n\nThe Amarr Empire took Dodixie in Sinq Laison from "
        + "the Gallente Federation at 15:00 UTC.\n\nIn Amamake 12 ships were destroyed in a long battle.";
      const ok = verifyNewsText(good, ctx);
      assert.deepStrictEqual([ok.ok, ok.title, ok.paragraphs.length], [true, "Dodixie falls to the Amarr Empire", 2]);
      assert.deepStrictEqual(verifyNewsText(good.replace("12 ships", "13 ships"), ctx),
        { ok: false, reason: "NUMBER_UNSOURCED" });
      assert.deepStrictEqual(verifyNewsText(good.replace("a long battle", "a battle near Jita"), ctx),
        { ok: false, reason: "NAME_UNSOURCED" });
      assert.strictEqual(verifyNewsText(good, ctx).ok, true);
      assert.deepStrictEqual(verifyNewsText(good.replace("a long battle", "a battle near Amarr"), ctx),
        { ok: false, reason: "NAME_UNSOURCED" }, "the system Amarr alone is refused");
      assert.deepStrictEqual(verifyNewsText(good.replace("TITLE: ", ""), ctx), { ok: false, reason: "SHAPE" });
      assert.deepStrictEqual(verifyNewsText("TITLE: x\n\nonly one paragraph here, long enough to pass the length.",
        ctx), { ok: false, reason: "SHAPE" });
      assert.deepStrictEqual(verifyNewsText(good.replace("In Amamake 12", "Elsewhere 12"), ctx),
        { ok: false, reason: "COVERAGE" });
      const pl = verifyNewsText(good.replace("TITLE:", "TYTUŁ:"), ctx);
      assert.strictEqual(pl.ok, true, "the pl title marker");
      assert.deepStrictEqual(verifyNewsText(null, ctx), { ok: false, reason: "SHAPE" });

      const ctxN = { ...ctx, knownNames: [...KNOWN, "Fade", "Tribute"] };
      assert.strictEqual(verifyNewsText(good.replace("a long battle", "a long battle that will not fade, a tribute "
        + "to the fallen"), ctxN).ok, true, "common words are not region names");
      assert.deepStrictEqual(verifyNewsText(good.replace("a long battle", "a battle in Fade"), ctxN),
        { ok: false, reason: "NAME_UNSOURCED" }, "the region Fade is a proper name");
      assert.deepStrictEqual(verifyNewsText(good.replace("a long battle", "a battle in the Forge"), ctxN),
        { ok: false, reason: "NAME_UNSOURCED" }, "The Forge inside a sentence");
      const ctxAmarr = { ...ctx, factNames: [...built.factNames.filter((n) => n !== "Amarr Empire"), "Amarr"] };
      assert.deepStrictEqual(verifyNewsText(good, ctxAmarr), { ok: false, reason: "NAME_UNSOURCED" },
        "Amarr Empire outside the facts is not the fact system Amarr");
      const declined = good.replace("In Amamake 12", "W Amamace 12").replace("a long battle", "a battle near Jicie");
      const ctxPl = { ...ctx, factNames: [...built.factNames, "Jita"], language: "pl" };
      assert.strictEqual(verifyNewsText(declined, ctxPl).ok, true, "pl: a declined fact name");
      assert.deepStrictEqual(verifyNewsText(declined, { ...ctxPl, language: "en" }),
        { ok: false, reason: "COVERAGE" }, "en: no declension");
      assert.deepStrictEqual(verifyNewsText(good.replace("a long battle", "a battle near Jita"),
        { ...ctxPl, factNames: built.factNames }), { ok: false, reason: "NAME_UNSOURCED" }, "pl: Jita outside the facts");
    });
};
