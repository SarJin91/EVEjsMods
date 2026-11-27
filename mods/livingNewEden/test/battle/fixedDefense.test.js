"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { validateInput, validateResult, hashInput, HASH_LIMITS, MAX_FIXED_DEFENSES } =
  require("../../lib/battle/contract");
const { makeInput, ships, SCENARIOS } = require("./scenarios");

const MOD_DIR = path.join(__dirname, "..", "..");
const PINNED_SIMILAR_HASH = "0063515699b5c12fb6e02364dce2017d14f1afa5d0fb65292d1cdb733582f85b";
const RESULT_LIMITS = Object.freeze({ maxResultBytes: 65536 });
const SENTRY_EHP = 500000;

let cached = null;
function setup() {
  if (cached) return cached;
  const config = require("../../config");
  const { createStrengthCatalog } = require("../../lib/battle/strength");
  const { buildResolverParams } = require("../../lib/battle/resolverParams");
  const resolver = require("../../lib/battle/resolverInternalV1");
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
  const made = createStrengthCatalog(undefined, { groupConfidence: 0.9, unknownTypeConfidence: 0.6 });
  assert.strictEqual(made.ok, true, JSON.stringify(made));
  const built = buildResolverParams(resolved.config);
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  cached = { catalog: made.catalog, params: built.params, resolver };
  return cached;
}

const DAMAGED_EHP = 150000;
const sentry = (i, hp = SENTRY_EHP) => ({ sentryId: `sentry_${String(i).padStart(2, "0")}`, itemId: 990000000 + i,
  typeId: 340501, ownerKind: "player", ownerId: 90000001, hp, ehp: hp, dps: 67.7, signature: 6000, designSig: 125 });

function fixedInput(n, { seed = 1, hp = SENTRY_EHP, permille = 300 } = {}) {
  const base = makeInput({ seed, sideA: [{ ships: [ships("cruiser", 10)] }], sideB: [{ ships: [ships("cruiser", 1)] }] });
  const entries = [];
  for (let i = n; i >= 1; i -= 1) entries.push(sentry(i, hp));
  return { ...base, sideB: { factionId: null, fleets: [] },
    fixedDefenses: { attackerRetreatLossPermille: permille, entries } };
}

function resolveOk(input) {
  const { resolver, catalog, params } = setup();
  const r = resolver.resolve(input, catalog, params);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.result;
}

const lost = (r) => r.destroyedShips.reduce((n, g) => n + g.count, 0);

module.exports = ({ test }) => {
  test("FD-R1 resolver fixed pool: 10 cruisers vs 1 / 6 / 2 sentries at default params, same seed = same result", () => {
    const one = resolveOk(fixedInput(1, { hp: DAMAGED_EHP }));
    assert.strictEqual(one.outcome, "A_WIN", JSON.stringify(one.diagnostics));
    assert.deepStrictEqual(one.fixedDefenseOutcome, [{ sentryId: "sentry_01", damage: DAMAGED_EHP, destroyed: true }]);
    assert.ok(lost(one) >= 1, `A lost ${lost(one)}`);
    assert.strictEqual(one.diagnostics.fixedDestroyed, 1);
    assert.strictEqual(one.diagnostics.fixedRemainingPermille, 0);

    const six = resolveOk(fixedInput(6));
    assert.ok(six.diagnostics.endReason === "RETREAT_A" && six.outcome === "B_WIN", JSON.stringify(six.diagnostics));
    assert.strictEqual(six.fixedDefenseOutcome.length, 6);
    assert.ok(six.fixedDefenseOutcome.every((o) => !o.destroyed), JSON.stringify(six.fixedDefenseOutcome));
    assert.deepStrictEqual(six.fixedDefenseOutcome.map((o) => o.sentryId),
      ["sentry_01", "sentry_02", "sentry_03", "sentry_04", "sentry_05", "sentry_06"]);

    const two = resolveOk(fixedInput(2));
    assert.strictEqual(two.diagnostics.endReason, "RETREAT_A", JSON.stringify(two.diagnostics));
    assert.strictEqual(two.outcome, "B_WIN");
    assert.ok(two.diagnostics.lossFractionA * 1000 >= 300 - 1e-6, JSON.stringify(two.diagnostics));
    assert.strictEqual(lost(two), 3, JSON.stringify(two.diagnostics));
    assert.strictEqual(two.diagnostics.fixedDestroyed, 0);
    assert.ok(two.fixedDefenseOutcome[0].damage > 0 && two.fixedDefenseOutcome[1].damage === 0,
      JSON.stringify(two.fixedDefenseOutcome));
    const noCap = resolveOk(fixedInput(2, { permille: 1000 }));
    assert.strictEqual(noCap.diagnostics.endReason, "ROUND_LIMIT", JSON.stringify(noCap.diagnostics));

    assert.deepStrictEqual(resolveOk(fixedInput(2)), two);
    assert.deepStrictEqual(resolveOk(fixedInput(1, { hp: DAMAGED_EHP })), one);
  });

  test("FD-R2 contract: fixedDefenses only with sideB {null, []}, entry ranges, outcome checks, hash unchanged", () => {
    const limits = HASH_LIMITS;
    const plain = SCENARIOS.similar(4242);
    assert.strictEqual(hashInput(plain), PINNED_SIMILAR_HASH);
    assert.strictEqual(hashInput({ ...plain, fixedDefenses: null }), PINNED_SIMILAR_HASH);
    const noFixed = { ...fixedInput(1) };
    delete noFixed.fixedDefenses;
    assert.strictEqual(validateInput(noFixed, limits).reason, "INPUT_INVALID");

    const good = validateInput(fixedInput(3), limits);
    assert.strictEqual(good.ok, true, JSON.stringify(good));
    assert.deepStrictEqual(good.input.fixedDefenses.entries.map((e) => e.sentryId),
      ["sentry_01", "sentry_02", "sentry_03"]);
    assert.deepStrictEqual(good.input.sideB, { factionId: null, fleets: [] });

    const bad = (mutate) => {
      const input = fixedInput(3);
      mutate(input);
      return validateInput(input, limits);
    };
    const tooMany = [];
    for (let i = 1; i <= MAX_FIXED_DEFENSES + 1; i += 1) tooMany.push(sentry(i));
    const cases = [
      ["sideB with faction", (x) => { x.sideB.factionId = 500002; }],
      ["sideB with fleets", (x) => { x.sideB.fleets = plain.sideB.fleets; }],
      ["garrison", (x) => { x.garrison = { side: "A", factionId: 500001, strength: 1 }; }],
      ["structure", (x) => { Object.assign(x, { structureId: 1, structureTypeId: 2, structureSide: "B" }); }],
      ["permille low", (x) => { x.fixedDefenses.attackerRetreatLossPermille = 49; }],
      ["permille high", (x) => { x.fixedDefenses.attackerRetreatLossPermille = 1001; }],
      ["no entries", (x) => { x.fixedDefenses.entries = []; }],
      ["too many", (x) => { x.fixedDefenses.entries = tooMany; }],
      ["duplicate sentryId", (x) => { x.fixedDefenses.entries[1].sentryId = x.fixedDefenses.entries[0].sentryId; }],
      ["duplicate itemId", (x) => { x.fixedDefenses.entries[1].itemId = x.fixedDefenses.entries[0].itemId; }],
      ["hp 0", (x) => { x.fixedDefenses.entries[0].hp = 0; }],
      ["ehp fraction", (x) => { x.fixedDefenses.entries[0].ehp = 1.5; }],
      ["ownerKind", (x) => { x.fixedDefenses.entries[0].ownerKind = "corp"; }],
      ["extra field", (x) => { x.fixedDefenses.entries[0].shield = 1; }],
      ["signature 0", (x) => { x.fixedDefenses.entries[0].signature = 0; }],
    ];
    for (const [name, mutate] of cases) assert.strictEqual(bad(mutate).reason, "INPUT_INVALID", name);

    const r = resolveOk(fixedInput(1));
    const inp = validateInput(fixedInput(1), limits).input;
    assert.strictEqual(validateResult(inp, r, RESULT_LIMITS).ok, true);
    const withOutcome = (outcome) => ({ ...r, fixedDefenseOutcome: outcome });
    const missing = { ...r };
    delete missing.fixedDefenseOutcome;
    const id = "sentry_01";
    for (const [name, res] of [["missing", missing], ["destroyed mismatch", withOutcome([{ sentryId: id,
      damage: SENTRY_EHP - 1, destroyed: true }])], ["over ehp", withOutcome([{ sentryId: id, damage: SENTRY_EHP + 1,
      destroyed: false }])], ["wrong id", withOutcome([{ sentryId: "sentry_02", damage: 0, destroyed: false }])],
    ["two entries", withOutcome([{ sentryId: id, damage: 0, destroyed: false },
      { sentryId: id, damage: 0, destroyed: false }])]]) {
      assert.strictEqual(validateResult(inp, res, RESULT_LIMITS).reason, "RESULT_INVALID", name);
    }
    const plainInput = validateInput(plain, limits).input;
    const plainResult = resolveOk(plain);
    assert.strictEqual(validateResult(plainInput, plainResult, RESULT_LIMITS).ok, true);
    assert.strictEqual(validateResult(plainInput, { ...plainResult, fixedDefenseOutcome: [] }, RESULT_LIMITS).reason,
      "RESULT_INVALID");
    assert.ok(!("fixedDefenseOutcome" in plainResult) && !("fixedDestroyed" in plainResult.diagnostics));
  });
};
