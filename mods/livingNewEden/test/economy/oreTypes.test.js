"use strict";

const assert = require("node:assert");

const { buildOreTypes } = require("../../tools/mining/buildOreTypes");
const DATA = require("../../lib/economy/data/oreTypes");
const { ORE_BANDS } = require("../../lib/economy/data/industryCatalog");

const mats = (pairs) => pairs.map(([typeId, quantity]) => ({ typeId, quantity }));

function fixture(extra = {}) {
  const dogma = new Map([
    [1230, { 2711: 1230, 2699: 1 }],
    [17470, { 2711: 1230, 2699: 2 }],
    [28432, { 2711: 1230, 2699: 1 }],
    [11396, { 2711: 11396, 2699: 1 }],
    [16262, { 2711: 16262, 2699: 1 }],
    [46689, { 2711: 46689, 2699: 4 }],
  ]);
  const typeMaterials = new Map([
    [1230, mats([[34, 400]])],
    [17470, mats([[34, 420]])],
    [28432, mats([[34, 400]])],
    [11396, mats([[11399, 140]])],
    [16262, mats([[16272, 69], [16273, 35]])],
    [46689, mats([[34, 460]])],
  ]);
  const compressible = new Set([1230, 17470, 11396, 16262, 46689]);
  const names = new Map([[1230, "Veldspar"], [1228, "Scordite"]]);
  const inputs = { sde: { buildNumber: 1, releaseDate: "2026-01-01" }, dogma, typeMaterials, compressible, names };
  return { ...inputs, ...extra };
}

module.exports = ({ test }) => {
  test("OT1 tiers-2 ore types: builder filters / refusals / determinism; generated table invariants", () => {
    const r = buildOreTypes(fixture());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(r.oreTypes), ["1230", "17470"], "28432 not compressible, 11396/16262 no minerals");
    assert.deepStrictEqual(r.oreTypes["1230"], { typeId: 1230, baseTypeId: 1230, grade: 1, family: "Veldspar",
      minerals: { "type:34": 400 } });
    assert.deepStrictEqual(r.oreTypes["17470"].grade, 2);
    assert.deepStrictEqual(r.baseTypeIds, [1230]);
    assert.deepStrictEqual(r.familyByBase, { 1230: "Veldspar" }, "only names of bases in the table");
    assert.deepStrictEqual(r.header.selfBasedExcluded, [46689], "self-based grade 4 stays out (D-prop-1)");
    assert.strictEqual(r.header.oreCount, 2);
    assert.match(r.header.sourceHash, /^[0-9a-f]{64}$/);
    assert.strictEqual(buildOreTypes(fixture()).source, r.source, "deterministic byte for byte");
    const orphan = fixture();
    orphan.dogma.set(99, { 2711: 98, 2699: 2 });
    orphan.typeMaterials.set(99, mats([[35, 10]]));
    orphan.compressible.add(99);
    const missing = buildOreTypes(orphan);
    assert.strictEqual(missing.ok, false);
    assert.strictEqual(missing.reason, "ORE_BASE_MISSING");
    const dup = fixture();
    dup.dogma.set(17471, { 2711: 1230, 2699: 2 });
    dup.typeMaterials.set(17471, mats([[34, 440]]));
    dup.compressible.add(17471);
    assert.strictEqual(buildOreTypes(dup).reason, "ORE_DUPLICATE_GRADE");
    const empty = fixture({ compressible: new Set([16262]) });
    assert.strictEqual(buildOreTypes(empty).reason, "ORE_SET_EMPTY");
    assert.strictEqual(buildOreTypes({}).reason, "INPUT_INVALID");

    const { HEADER, ORE_TYPES, BASE_TYPE_IDS, FAMILY_BY_BASE } = DATA;
    assert.strictEqual(HEADER.sdeBuild, 3724492);
    assert.ok(Object.isFrozen(ORE_TYPES) && Object.isFrozen(ORE_TYPES["1230"].minerals));
    assert.strictEqual(ORE_TYPES["1230"].baseTypeId, 1230);
    assert.strictEqual(ORE_TYPES["1230"].grade, 1);
    assert.ok(ORE_TYPES["1230"].minerals["type:34"] > 0);
    assert.strictEqual(ORE_TYPES["17470"].baseTypeId, 1230);
    assert.strictEqual(ORE_TYPES["17470"].grade, 2);
    for (const absent of [11396, 28432, 62516]) assert.strictEqual(ORE_TYPES[String(absent)], undefined, `${absent}`);
    for (const row of Object.values(ORE_TYPES)) {
      assert.ok(row.grade >= 1, `${row.typeId} grade`);
      const keys = Object.keys(row.minerals);
      assert.ok(keys.length >= 1, `${row.typeId} minerals`);
      for (const k of keys) {
        const id = Number(k.slice(5));
        assert.ok(k.startsWith("type:") && id >= 34 && id <= 40 && row.minerals[k] > 0, `${row.typeId} ${k}`);
      }
      assert.strictEqual(row.family, FAMILY_BY_BASE[String(row.baseTypeId)] || null);
    }
    const names = {};
    for (const band of Object.values(ORE_BANDS)) for (const o of band.ores) names[String(o.typeId)] = o.name;
    assert.deepStrictEqual({ ...FAMILY_BY_BASE }, names, "FAMILY_BY_BASE = the 15 industryCatalog pairs");
    assert.strictEqual(Object.keys(FAMILY_BY_BASE).length, 15);
    assert.deepStrictEqual([...BASE_TYPE_IDS], [...BASE_TYPE_IDS].sort((a, b) => a - b));
    assert.deepStrictEqual([...BASE_TYPE_IDS],
      [...new Set(Object.values(ORE_TYPES).map((r) => r.baseTypeId))].sort((a, b) => a - b));
    assert.strictEqual(HEADER.baseCount, BASE_TYPE_IDS.length);
    assert.strictEqual(HEADER.oreCount, Object.keys(ORE_TYPES).length);
  });
};
