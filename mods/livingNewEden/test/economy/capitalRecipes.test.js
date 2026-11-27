"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const CAPITAL = require("../../lib/economy/data/capitalRecipes");
const STRENGTH = require("../../lib/battle/data/strengthCatalog");
const { CAPITAL_HULL_GROUPS } = require("../../lib/fleets/schema");
const { CLASS_SDE_GROUPS, CLASS_SOURCE_TYPES, CLASS_TIERS } = require("../../lib/fleets/data/capitalClasses");
const { FACTION_HULL_CLASSES, classTypeOf } = require("../../lib/strategy/data/factionHullClasses");
const { buildCapitalRecipes, CAPITAL_METHOD } = require("../../tools/production/buildCapitalRecipes");
const { DEFAULT_SDE, DEFAULT_OUT } = require("../../tools/buildCapitalRecipes");

const MINERAL_KEYS = ["type:34", "type:35", "type:36", "type:37", "type:38", "type:39", "type:40"];

const bp = (blueprintTypeId, timeSec, materials) => ({ blueprintTypeId, timeSec,
  materials: materials.map(([typeId, quantity]) => ({ typeId, quantity })), productQuantity: 1 });

module.exports = ({ test, skip }) => {
  test("CAP1 capitalRecipes HEADER: strengthSourceHash = strength catalogue sourceHash, version 1, depth 4, SDE build",
    () => {
      assert.strictEqual(CAPITAL.HEADER.strengthSourceHash, STRENGTH.HEADER.sourceHash);
      assert.deepStrictEqual([CAPITAL.HEADER.recipesVersion, CAPITAL.HEADER.maxDepth, CAPITAL.HEADER.sdeBuild],
        [1, 4, STRENGTH.HEADER.sdeBuild]);
      assert.deepStrictEqual(Object.keys(CAPITAL.GROUPS), [...CAPITAL_HULL_GROUPS]);
      assert.ok(Object.isFrozen(CAPITAL.GROUPS.titan.minerals));
    });

  if (fs.existsSync(path.join(DEFAULT_SDE, "blueprints.jsonl"))) {
    test("CAP2 generator on the local SDE = the committed capitalRecipes.js (byte for byte)", () => {
      const { buildFromSde } = require("../../tools/buildCapitalRecipes");
      const made = buildFromSde(DEFAULT_SDE);
      assert.strictEqual(made.ok, true, JSON.stringify(made));
      assert.strictEqual(made.source, fs.readFileSync(DEFAULT_OUT, "utf8"));
    });
  } else {
    skip("CAP2 generator on the local SDE = capitalRecipes.js", "no local SDE blueprints.jsonl");
  }

  test("CAP3 sizes: titan mineralSum > 100 x carrier, every class has the 7 minerals 34-40, tiers, representative "
    + "is a source type", () => {
    assert.ok(CAPITAL.GROUPS.titan.mineralSum > 100 * CAPITAL.GROUPS.carrier.mineralSum,
      `${CAPITAL.GROUPS.titan.mineralSum} vs ${CAPITAL.GROUPS.carrier.mineralSum}`);
    for (const cls of CAPITAL_HULL_GROUPS) {
      const g = CAPITAL.GROUPS[cls];
      assert.deepStrictEqual(Object.keys(g.minerals), MINERAL_KEYS, cls);
      for (const k of MINERAL_KEYS) assert.ok(Number.isSafeInteger(g.minerals[k]) && g.minerals[k] > 0, `${cls}.${k}`);
      assert.strictEqual(Object.values(g.minerals).reduce((a, b) => a + b, 0), g.mineralSum, cls);
      assert.ok(Object.values(CLASS_SOURCE_TYPES[cls]).includes(g.representativeTypeId), cls);
      assert.ok(Number.isSafeInteger(g.timeSec) && g.timeSec > 0, cls);
    }
    assert.deepStrictEqual(Object.keys(CLASS_TIERS), [...CAPITAL_HULL_GROUPS]);
  });

  test("CAP4 every typeId of FACTION_HULL_CLASSES and CLASS_SOURCE_TYPES is a TYPES row of its class SDE group; "
    + "classTypeOf; generator refusals on a fixture", () => {
    const checkType = (cls, typeId, where) => {
      const row = STRENGTH.TYPES[String(typeId)];
      assert.ok(row, `${where} ${typeId} in TYPES`);
      assert.ok(CLASS_SDE_GROUPS[cls].includes(row.groupId), `${where} ${typeId} group ${row.groupId}`);
    };
    for (const cls of CAPITAL_HULL_GROUPS) {
      assert.deepStrictEqual(Object.keys(CLASS_SOURCE_TYPES[cls]).sort(), ["amarr", "caldari", "gallente", "minmatar"]);
      for (const [race, typeId] of Object.entries(CLASS_SOURCE_TYPES[cls])) checkType(cls, typeId, `${cls}.${race}`);
    }
    for (const [factionId, row] of Object.entries(FACTION_HULL_CLASSES)) {
      for (const [cls, typeId] of Object.entries(row)) {
        assert.ok(CAPITAL_HULL_GROUPS.includes(cls), `${factionId}.${cls}`);
        checkType(cls, typeId, `${factionId}.${cls}`);
      }
    }
    assert.strictEqual(classTypeOf(500001, "titan"), CLASS_SOURCE_TYPES.titan.caldari);
    assert.strictEqual(classTypeOf(500003, "carrier"), CLASS_SOURCE_TYPES.carrier.amarr);
    for (const id of [500001, 500002, 500003, 500004]) {
      assert.deepStrictEqual(Object.keys(FACTION_HULL_CLASSES[id]), [...CAPITAL_HULL_GROUPS], String(id));
    }
    assert.strictEqual(classTypeOf(500012, "titan"), 42241);
    assert.strictEqual(classTypeOf(500012, "carrier"), null, "pirates have no carriers");
    assert.strictEqual(classTypeOf(500006, "dreadnought"), null, "CONCORD has no capital class");
    assert.strictEqual(classTypeOf(500001, "capital"), null);

    const types = { 1: { typeId: 1, groupId: 30 }, 2: { typeId: 2, groupId: 30 }, 3: { typeId: 3, groupId: 30 },
      4: { typeId: 4, groupId: 27 } };
    const method = { ...CAPITAL_METHOD, classSdeGroups: { titan: [30] }, classSourceTypes: { titan: { a: 1, b: 2,
      c: 3 } } };
    const blueprints = new Map([[1, bp(101, 500, [[34, 100], [35, 10]])], [2, bp(102, 900, [[34, 50]])]]);
    const inputs = { sde: { buildNumber: 1, releaseDate: "x" }, blueprints, types, strengthSourceHash: "h" };
    const made = buildCapitalRecipes(inputs, method);
    assert.strictEqual(made.ok, true, JSON.stringify(made));
    assert.deepStrictEqual(made.groups.titan, { minerals: { "type:34": 50 }, timeSec: 900, representativeTypeId: 2,
      sampleSize: 2, mineralSum: 50 });
    assert.deepStrictEqual([made.header.missingBlueprints, made.header.strengthSourceHash], [1, "h"]);
    assert.strictEqual(buildCapitalRecipes(inputs, method).source, made.source, "deterministic");
    const refusal = (m) => {
      const r = buildCapitalRecipes(inputs, { ...method, ...m });
      return [r.ok, r.reason];
    };
    assert.deepStrictEqual(refusal({ classSourceTypes: { titan: { a: 4 } } }), [false, "CLASS_TYPE_MISMATCH"]);
    assert.deepStrictEqual(refusal({ classSourceTypes: { titan: { a: 99 } } }), [false, "CLASS_TYPE_MISMATCH"]);
    assert.deepStrictEqual(refusal({ classSourceTypes: { titan: { c: 3 } } }), [false, "EMPTY_CLASS"]);
    assert.strictEqual(buildCapitalRecipes({ ...inputs, strengthSourceHash: "" }, method).reason, "INPUT_INVALID");
  });
};
