"use strict";

const assert = require("node:assert");

const { createTranscript, NO_NAME } = require("../../lib/npcVoices/talk/transcript");

const T0 = 1700000000000;
const A = 30000142;
const B = 30000144;
const C = 30002187;
const PLAYER = 90000001;
const NPC = 91000001;

function line(systemId, text, atMs, kind = "player", characterId = kind === "player" ? PLAYER : NPC) {
  return { kind, systemId, characterId, text, atMs };
}

module.exports = ({ test }) => {
  test("TR1 transcript: ring of maxLinesPerSystem, maxAgeMs, maxSystems, recent oldest first, lastPlayerLine", () => {
    const t = createTranscript({ maxLinesPerSystem: 3, maxSystems: 2, maxAgeMs: 60000, lineChars: 200,
      nameOf: (id) => (id === PLAYER ? "Bob" : "Kiri") });
    t.setSystems([A, B, C]);
    for (let i = 1; i <= 5; i += 1) assert.strictEqual(t.note(line(A, `a${i}`, T0 + i * 1000, i % 2 ? "npc" : "player")), true);
    assert.deepStrictEqual(t.recent(A, 10, T0 + 6000).map((l) => l.text), ["a3", "a4", "a5"], "the ring keeps 3");
    assert.deepStrictEqual(t.recent(A, 2, T0 + 6000).map((l) => l.text), ["a4", "a5"], "the last n, oldest first");
    assert.deepStrictEqual(t.lastPlayerLine(A, T0 + 6000),
      { kind: "player", characterId: PLAYER, name: "Bob", text: "a4", atMs: T0 + 4000 });
    assert.deepStrictEqual(t.recent(A, 10, T0 + 63500).map((l) => l.text), ["a4", "a5"], "older than maxAgeMs gone");
    assert.strictEqual(t.lastPlayerLine(A, T0 + 64000), null, "the player line aged out");

    assert.strictEqual(t.note(line(B, "b1", T0 + 7000)), true);
    assert.strictEqual(t.note(line(A, "a6", T0 + 8000)), true, "A active again");
    assert.strictEqual(t.note(line(C, "c1", T0 + 9000)), true);
    assert.deepStrictEqual([t.systems(), t.recent(B, 5, T0 + 9000).length, t.recent(A, 5, T0 + 9000).length],
      [2, 0, 3], "B (least recently active) dropped");
    assert.strictEqual(t.size(), 4);
    t.drop(A);
    assert.deepStrictEqual([t.systems(), t.size()], [1, 1]);
  });

  test("TR2 transcript: snapshot filter, sanitizing, `!`/`/` refused, sharePlayerText, lazy cached names", () => {
    let lookups = 0;
    const t = createTranscript({ maxLinesPerSystem: 24, maxSystems: 4, maxAgeMs: 1800000, lineChars: 12,
      nameOf: (id) => {
        lookups += 1;
        return id === NPC ? " Kiri " : null;
      } });
    assert.strictEqual(t.note(line(A, "hello", T0)), false, "no snapshot yet");
    t.setSystems(new Set([A]));
    assert.strictEqual(t.note(line(B, "hello", T0)), false, "outside the snapshot");
    assert.strictEqual(t.systems(), 0, "refused without memory");
    const zw = String.fromCharCode(0x200b);
    const shy = String.fromCharCode(0xad);
    assert.strictEqual(t.note(line(A, `<b>x</b>  y${zw}z${shy}\n\tw`, T0)), true);
    assert.strictEqual(t.note(line(A, "<color=0xff00ff00>abcdefghijklmnopq</color>", T0 + 1)), true);
    for (const text of ["!front", "  /me waves", "<b></b>", "   ", 7]) {
      assert.strictEqual(t.note(line(A, text, T0 + 2)), false, String(text));
    }
    assert.strictEqual(t.note({ ...line(A, "x", T0), kind: "system" }), false, "unknown kind");
    assert.strictEqual(t.note(line(A, "o7", T0 + 3, "npc")), true);
    const r = t.recent(A, 10, T0 + 10);
    assert.deepStrictEqual(r.map((l) => l.text), ["x yz w", "abcdefghijkl", "o7"], "tags, invisible signs, cut 12");
    assert.deepStrictEqual(r.map((l) => l.name), [NO_NAME, NO_NAME, "Kiri"]);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r[0]));
    const seen = lookups;
    t.recent(A, 10, T0 + 10);
    assert.strictEqual(lookups, seen + 2, "a found name is cached (the missing one asked again)");

    const quiet = createTranscript({ maxLinesPerSystem: 24, maxSystems: 4, maxAgeMs: 1800000, lineChars: 200,
      sharePlayerText: false, isSystem: (id) => id === A });
    assert.strictEqual(quiet.note(line(A, "secret", T0)), false, "sharePlayerText false: no player line");
    assert.strictEqual(quiet.note(line(A, "npc talk", T0, "npc")), true);
    assert.strictEqual(quiet.note(line(B, "npc talk", T0, "npc")), false, "predicate of the options");
    assert.strictEqual(quiet.lastPlayerLine(A, T0), null);
    quiet.clear();
    assert.strictEqual(quiet.size(), 0);
  });
};
