"use strict";

const assert = require("node:assert");

const { buildIndustryCatalog } = require("../../tools/industry/buildCatalog");
const DATA = require("../../lib/economy/data/industryCatalog");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");

const bp = (blueprintTypeId, timeSec, materials, productQuantity = 1) => ({ blueprintTypeId, timeSec,
  materials: materials.map(([typeId, quantity]) => ({ typeId, quantity })), productQuantity });
const type = (typeId, groupId, extra = {}) => ({ typeId, groupId, published: true, name: `t${typeId}`,
  basePrice: null, capacity: null, volume: null, portionSize: null, mass: null, ...extra });

function fixture(componentPrice = 1000) {
  const types = new Map([
    [34, type(34, 18, { basePrice: 2 })],
    [35, type(35, 18, { basePrice: 8 })],
    [500, type(500, 334, { basePrice: componentPrice })],
    [101, type(101, 25, { capacity: 100, mass: 1000000 })],
    [102, type(102, 25, { capacity: 300, mass: 2000000 })],
    [103, type(103, 25, { capacity: 200, mass: 1000000 })],
    [1230, type(1230, 462, { name: "Veldspar", basePrice: 2000, volume: 0.1, portionSize: 100 })],
  ]);
  const blueprints = new Map([
    [101, bp(1101, 600, [[34, 100], [500, 1]])],
    [102, bp(1102, 900, [[101, 1], [35, 50]])],
    [103, bp(1103, 700, [[34, 200]])],
  ]);
  const dogma = new Map([[102, { 1556: 9000, 600: 3.5, 70: 1, 37: 150 }]]);
  const typeMaterials = new Map([[1230, [{ typeId: 34, quantity: 400 }]]]);
  return { sde: { buildNumber: 1, releaseDate: "2026-01-01" }, types, dogma, blueprints, typeMaterials };
}

const METHOD = {
  catalogVersion: 1,
  maxDepth: 6,
  minerals: [34, 35],
  attributes: { oreHold: 1556, warpSpeedMultiplier: 600, agility: 70, maxVelocity: 37 },
  hullClasses: {
    b: { typeIds: [102], representative: 102 },
    grp: { sourceGroups: [25], representative: 101 },
    med: { sourceGroups: [25], representative: "lowerMedian" },
  },
  structures: { kit: 103 },
  oreBands: { highsec: { Veldspar: 1000 } },
};

const within = (actual, expected, label, tol = 0.05) => assert.ok(Math.abs(actual - expected) <= expected * tol,
  `${label}: ${actual} not within ${tol * 100}% of ${expected}`);

module.exports = ({ test }) => {
  test("IC1 builder: recursive bill, component factor, explicit/lowerMedian, Veldspar band, sourceHash", () => {
    const r = buildIndustryCatalog(fixture(), METHOD);
    assert.ok(r.ok, JSON.stringify(r));
    const b = r.hulls.b;
    assert.deepStrictEqual(b.minerals, { "type:34": 100, "type:35": 50 });
    assert.strictEqual(b.mineralSum, 150);
    assert.strictEqual(b.mineralValueIsk, 100 * 2 + 50 * 8);
    assert.strictEqual(b.componentValueIsk, 1000);
    assert.strictEqual(b.componentFactorPermille, Math.floor((1000 * (100 * 2 + 50 * 8 + 1000)) / (100 * 2 + 50 * 8)));
    assert.strictEqual(b.unpricedLeaves, 0);
    assert.strictEqual(b.timeSec, 900);
    assert.strictEqual(b.oreHoldM3, 9000);
    assert.deepStrictEqual(b.travel, { warpSpeedAu: 3.5, alignSeconds: Math.round(Math.log(4) * 2 * 10) / 10,
      maxVelocityMs: 150 });
    assert.strictEqual(r.hulls.grp.representativeTypeId, 101);
    assert.strictEqual(r.hulls.med.representativeTypeId, 102, "lower median of 100 / 150 / 200");
    assert.strictEqual(r.hulls.med.sampleSize, 3);
    assert.strictEqual(r.hulls.med.cargoMedianM3, 200);
    assert.strictEqual(r.structures.kit.mineralSum, 200);
    assert.strictEqual(r.oreBands.highsec.mineralsPerMillionM3["type:34"], 40000000);
    assert.strictEqual(r.oreBands.highsec.mineralsPerMillionM3["type:35"], 0);
    assert.strictEqual(buildIndustryCatalog(fixture(), METHOD).source, r.source, "deterministic");
    const priced = buildIndustryCatalog(fixture(2000), METHOD);
    assert.notStrictEqual(priced.header.sourceHash, r.header.sourceHash, "basePrice is hashed");
    const lost = fixture();
    lost.types.delete(1230);
    assert.deepStrictEqual(buildIndustryCatalog(lost, METHOD), { ok: false, reason: "ORE_UNRESOLVED",
      detail: "Veldspar" });
  });

  test("IC2 generated catalogue: accessor ok, minerals within 5% of the reference table, ore holds exact", () => {
    const res = createIndustryCatalog();
    assert.ok(res.ok, JSON.stringify(res));
    const c = res.catalog;
    const pm = { mining_frigate: 28000, mining_barge: 2030000, exhumer: 2030000, porpoise: 4600000,
      orca: 23300000, rorqual: 60800000 };
    for (const [cls, v] of Object.entries(pm)) within(c.hull(cls).mineralSum, v, cls);
    const f = c.hull("freighter").mineralSum;
    assert.ok(f >= 18000000 * 0.95 && f <= 19400000 * 1.05, `freighter ${f}`);
    const jf = c.hull("jump_freighter").mineralSum;
    assert.ok(jf >= 29000000 * 0.95 && jf <= 30000000 * 1.05, `jump_freighter ${jf}`);
    for (const [fam, v] of Object.entries({ raitaru: 7700000, astrahus: 12200000, fortizar: 142000000 })) {
      within(c.kit(fam).mineralSum, v, fam);
    }
    const holds = { mining_frigate: 5000, mining_barge: 9000, exhumer: 11500, porpoise: 50000, orca: 150000,
      rorqual: 300000 };
    for (const [cls, v] of Object.entries(holds)) assert.strictEqual(c.hull(cls).oreHoldM3, v, cls);
    const fm = c.hull("freighter").cargoMedianM3;
    assert.ok(fm >= 435000 && fm <= 465000, `freighter cargoMedian ${fm}`);
    const jm = c.hull("jump_freighter").cargoMedianM3;
    assert.ok(jm >= 132000 && jm <= 144000, `jump_freighter cargoMedian ${jm}`);
    assert.strictEqual(c.version, 1);
    assert.strictEqual(c.hull("nope"), null);
    assert.ok(Object.isFrozen(c.hull("orca")));
  });

  test("IC3 accessor refuses broken copies with INDUSTRY_CATALOG_INVALID", () => {
    const copy = () => JSON.parse(JSON.stringify(DATA));
    const cases = [
      ["version", (d) => { d.HEADER.catalogVersion = 2; }],
      ["missing class", (d) => { delete d.HULLS.orca; }],
      ["mineral key", (d) => { d.HULLS.orca.minerals["type:41"] = 5; }],
      ["band mineral", (d) => { delete d.ORE_BANDS.lowsec.mineralsPerMillionM3["type:40"]; }],
      ["factor", (d) => { d.STRUCTURES.raitaru.componentFactorPermille = 999; }],
    ];
    for (const [label, mutate] of cases) {
      const d = copy();
      mutate(d);
      const r = createIndustryCatalog(d);
      assert.strictEqual(r.ok, false, label);
      assert.strictEqual(r.reason, "INDUSTRY_CATALOG_INVALID", label);
      assert.ok(typeof r.detail === "string" && r.detail.length > 0, label);
    }
    assert.strictEqual(createIndustryCatalog(null).reason, "INDUSTRY_CATALOG_INVALID");
  });

  test("IC4 invariants: 7 minerals > 0 per band, exhumer factor >= barge, industrial cargo", () => {
    const { catalog } = createIndustryCatalog();
    for (const band of ["highsec", "lowsec", "nullsec"]) {
      const m = catalog.oreBand(band).mineralsPerMillionM3;
      for (let id = 34; id <= 40; id += 1) assert.ok(m[`type:${id}`] > 0, `${band} type:${id}`);
    }
    assert.ok(catalog.hull("exhumer").componentFactorPermille >= catalog.hull("mining_barge").componentFactorPermille);
    assert.ok(catalog.hull("industrial").cargoM3 > 0);
  });
};
