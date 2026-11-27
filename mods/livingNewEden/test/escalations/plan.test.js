"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { rollOf, targetCandidatesOf, templatesFor, planEscalation, formatLeadLine, MAX_LINE } =
  require("../../lib/escalations/plan");
const { DED_TEMPLATES } = require("../../lib/escalations/catalog");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 123456789;
const GURISTAS = 500010;

function chainGraph() {
  const sec = { 1: "highsec", 2: "highsec", 3: "lowsec", 4: "lowsec", 5: "nullsec", 6: "nullsec", 7: "highsec",
    8: "wormhole" };
  const links = { 1: [2], 2: [1, 3, 8], 3: [2, 4], 4: [3, 5], 5: [4, 6], 6: [5, 7], 7: [6], 8: [2] };
  return {
    getNeighbors: (id) => (links[id] ? links[id] : null),
    getSystem: (id) => (sec[id] ? { systemId: id, secClass: sec[id] } : null),
  };
}

module.exports = ({ test }) => {
  test("ESP1 plan: same seed same result, chance 0/1, candidates in [min,max] without wormhole, cap 0 drops a band, "
    + "matchFaction with fallback, NO_TARGET, line <= 400", () => {
    const resolved = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(resolved.errors || [], []);
    const defaults = resolved.config.escalations;
    assert.deepStrictEqual([defaults.enabled, defaults.chance, defaults.minJumps, defaults.maxJumps,
      defaults.maxDedHighsec, defaults.maxDedLowsec, defaults.maxDedNullsec, defaults.matchFaction, defaults.siteKind],
    [false, 0.07, 1, 5, 4, 5, 6, true, "template"]);
    const c = { instanceId: 4242, systemId: 1, factionId: GURISTAS, completedAtMs: 1700000000000 };
    const r1 = rollOf(SEED, c, 0.5);
    assert.deepStrictEqual(rollOf(SEED, c, 0.5), r1);
    assert.ok(r1.unit >= 0 && r1.unit < 1);
    assert.strictEqual(rollOf(SEED, c, 0).hit, false);
    assert.strictEqual(rollOf(SEED, c, 1).hit, true);
    assert.notStrictEqual(rollOf(SEED, { ...c, completedAtMs: c.completedAtMs + 1 }, 0.5).seed, r1.seed);
    let hits = 0;
    for (let i = 0; i < 400; i += 1) if (rollOf(SEED, { instanceId: 1000 + i, completedAtMs: 1 }, 0.07).hit) hits += 1;
    assert.ok(hits >= 12 && hits <= 48, `hits ${hits}`);

    const g = chainGraph();
    const P = { ...defaults, minJumps: 2, maxJumps: 4 };
    assert.deepStrictEqual(targetCandidatesOf(g, 1, P).map((t) => [t.systemId, t.jumps, t.secClass]),
      [[3, 2, "lowsec"], [4, 3, "lowsec"], [5, 4, "nullsec"]]);
    assert.deepStrictEqual(targetCandidatesOf(g, 1, { ...defaults, minJumps: 0, maxJumps: 1 }).map((t) => t.systemId),
      [2], "no source, no wormhole");
    assert.deepStrictEqual(targetCandidatesOf(g, 1, { ...P, maxDedLowsec: 0 }).map((t) => t.systemId), [5]);
    assert.deepStrictEqual(targetCandidatesOf(g, 99, P), [], "source outside the graph");
    assert.deepStrictEqual(targetCandidatesOf(null, 1, P), []);
    assert.deepStrictEqual(targetCandidatesOf(g, 1, { ...defaults, minJumps: 9, maxJumps: 6 }).map((t) => t.systemId),
      [7], "min above max -> min = max");

    const hs = templatesFor(DED_TEMPLATES, GURISTAS, "highsec", defaults);
    assert.ok(hs.length > 0 && hs.every((t) => t.factionId === GURISTAS && t.dedRating <= 4 && t.bands.includes("highsec")));
    const anyHs = templatesFor(DED_TEMPLATES, GURISTAS, "highsec", { ...defaults, matchFaction: false });
    assert.ok(anyHs.length > hs.length && anyHs.every((t) => t.dedRating <= 4));
    const fallback = templatesFor(DED_TEMPLATES, 999, "lowsec", defaults);
    assert.strictEqual(fallback.length, templatesFor(DED_TEMPLATES, null, "lowsec", defaults).length,
      "a faction without templates -> the whole band");
    assert.deepStrictEqual(templatesFor(DED_TEMPLATES, GURISTAS, "nullsec", { ...defaults, maxDedNullsec: 0 }), []);
    assert.deepStrictEqual(templatesFor(DED_TEMPLATES, GURISTAS, "wormhole", defaults), []);
    const ids = anyHs.map((t) => t.templateId);
    assert.deepStrictEqual(ids, [...ids].sort());

    const plan = planEscalation(g, DED_TEMPLATES, c, r1.seed, defaults);
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual(planEscalation(g, DED_TEMPLATES, c, r1.seed, defaults), plan);
    assert.strictEqual(plan.attempts.length, 3);
    assert.strictEqual(new Set(plan.attempts.map((a) => a.systemId)).size, 3, "no system twice");
    for (const a of plan.attempts) {
      assert.ok(a.jumps >= 1 && a.jumps <= 5 && a.systemId !== 1 && a.systemId !== 8, JSON.stringify(a));
      const t = DED_TEMPLATES.find((x) => x.templateId === a.templateId);
      assert.ok(t.bands.includes(a.secClass) && t.factionId === GURISTAS && t.name === a.name, JSON.stringify(a));
    }
    assert.deepStrictEqual(planEscalation(g, DED_TEMPLATES, c, r1.seed,
      { ...defaults, maxDedHighsec: 0, maxDedLowsec: 0, maxDedNullsec: 0 }), { ok: false, reason: "NO_TARGET" });
    assert.deepStrictEqual(planEscalation(g, [], c, r1.seed, defaults), { ok: false, reason: "NO_TARGET" });

    const a = { systemId: 3, jumps: 3, secClass: "lowsec", dedRating: 4, name: "Guristas Scout Outpost" };
    const at = Date.UTC(2026, 10, 18, 9, 5);
    assert.strictEqual(formatLeadLine(a, "Jita", "Tama", at), "Escalation lead (DED 4): Guristas Scout Outpost in Tama "
      + "(lowsec, 3 jumps from Jita). Scan the signature down before 2026-11-18 09:05 EVE time.");
    assert.ok(formatLeadLine(a, 30000142, null, at).includes("in an unknown system (lowsec, 3 jumps from an unknown system)"));
    const long = formatLeadLine({ ...a, name: "X".repeat(600) }, "Jita", "Tama", at);
    assert.strictEqual(long.length, MAX_LINE);
    assert.ok(long.endsWith("..."));
  });
};
