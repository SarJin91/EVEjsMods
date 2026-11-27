"use strict";

const assert = require("node:assert");

const { generateName, nameKey } = require("../../lib/freeCorps/names");
const { planFounding } = require("../../lib/freeCorps/plan");
const { ARCHETYPES, parseBandWeights, parseArchetypeWeights } = require("../../lib/freeCorps/schema");
const { ARCHETYPE_DATA } = require("../../lib/freeCorps/data/archetypes");
const { PREFIXES, NOUNS, SUFFIXES } = require("../../lib/freeCorps/data/nameParts");

const SEED = 123456789;
const longest = (list) => Math.max(...list.map((s) => s.length));

function input(over = {}) {
  return { worldSeed: SEED, corpId: 1, salt: 0, now: 1000, archetypes: ARCHETYPE_DATA,
    S: { archetypeWeights: parseArchetypeWeights("miner:1"), bandWeights: parseBandWeights("highsec:1"),
      membersMin: 3, membersMax: 8, maxHomeAttempts: 8, maxCorpsPerHomeSystem: 3, maxNameAttempts: 8,
      initialIsk: 5, foundingRecheckMs: 30000 },
    systemsOf: () => [30000001], stationsOf: () => [{ stationId: 60000001, corporationId: 1000001 }],
    homeCount: () => 0, nameTaken: () => false, reserved: { names: new Set(), tickers: new Set() },
    raceSourceFactionIds: [500001, 500002], memberRoom: 100, ...over };
}

module.exports = ({ test }) => {
  test("FC2-2 names: deterministic, ASCII <= 50, tickers 2..5, parts fit by data; planFounding attempts, "
    + "NAME_EXHAUSTED, reserved name in another case refused", () => {
    const p = { worldSeed: SEED, corpId: 42, archetype: "hauler", attempt: 3 };
    assert.deepStrictEqual(generateName(p), generateName({ ...p }), "deterministic");
    assert.notDeepStrictEqual(generateName(p), generateName({ ...p, attempt: 4 }), "attempt changes the pair");
    for (let corpId = 1; corpId <= 1000; corpId += 1) {
      for (const archetype of ARCHETYPES) {
        for (const attempt of [0, 1]) {
          const n = generateName({ worldSeed: SEED, corpId, archetype, attempt });
          assert.ok(n.name.length >= 1 && n.name.length <= 50 && /^[A-Za-z ]+$/.test(n.name), n.name);
          assert.ok(/^[A-Z0-9]{2,5}$/.test(n.ticker), `${n.name} ${n.ticker}`);
        }
      }
    }
    for (const a of ARCHETYPES) {
      assert.ok(SUFFIXES[a].length >= 12, a);
      assert.ok(longest(PREFIXES) + 1 + longest(NOUNS) + 1 + longest(SUFFIXES[a]) <= 50, `longest ${a}`);
    }
    assert.ok(PREFIXES.length >= 60 && NOUNS.length >= 30);
    assert.ok([...PREFIXES, ...NOUNS, ...Object.values(SUFFIXES).flat()].every((s) => /^[A-Za-z ]+$/.test(s)));

    const free = planFounding(input());
    assert.strictEqual(free.ok, true, JSON.stringify(free));
    assert.strictEqual(free.row.name_attempt, 0);
    assert.deepStrictEqual(planFounding(input()), free, "plan deterministic");
    let calls = 0;
    const two = planFounding(input({ nameTaken: () => { calls += 1; return calls <= 2; } }));
    assert.strictEqual(two.ok, true);
    assert.strictEqual(two.row.name_attempt, 2);
    assert.deepStrictEqual(planFounding(input({ nameTaken: () => true })), { ok: false, reason: "NAME_EXHAUSTED" });
    assert.strictEqual(planFounding(input({ salt: 1 })).row.name_attempt, 8);
    const reserved = planFounding(input({ reserved: { names: new Set([nameKey(free.row.name.toUpperCase())]),
      tickers: new Set() } }));
    assert.strictEqual(reserved.ok, true);
    assert.ok(reserved.row.name_attempt > 0 && reserved.row.name !== free.row.name, "reserved name refused");
    assert.strictEqual(nameKey("  Crimson Haulage "), "crimson haulage");
  });
};
