"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const data = require("../../../lib/events/salvage/data");
const { planAnomaly, placeSpecOf } = require("../../../lib/events/salvage/plan");
const { isRandomAnyLootTable } = require("../../../lib/adapter/nativeWrecks");
const { createRng } = require("../../../lib/util/rng");
const { resolveConfig } = require("../../../config");
const { npcSetupTables } = require("../../_support/setupTables");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const NPC_LOOT_JS = path.join(REPO_ROOT, "server", "src", "space", "npc", "npcLoot.js");
const RANDOM_ANY = "generic_random_any";
const NO_ROW_FACTIONS = [500001, 500002, 500003, 500004, 500007, 500008, 500015, 500026, 500029, 500024];
const ROW_FACTIONS = [500010, 500011, 500012, 500019, 500020, 500025, 500021];
const RULE_KINDS = new Set(["ammo", "module", "utility", "trash"]);
const SEEDS = 200;

const oldLootTableFor = (f, hg, unusable, fallback) => {
  const id = data.lootTableOf(f, hg);
  return id && !unusable.has(id) ? id : fallback;
};

module.exports = ({ test, skip }) => {
  const hullGroups = Object.keys(data.HULL_SIZE);

  test("DL1 no-row factions -> loot_belt_normal_<size>; row factions unchanged; flag off = old lookup", () => {
    for (const f of NO_ROW_FACTIONS) assert.ok(!Object.prototype.hasOwnProperty.call(data.LOOT_TABLES, f), `${f}`);
    const on = { sizedDefault: true, fallbackId: RANDOM_ANY, unusable: new Set(), randomAny: new Set([RANDOM_ANY]) };
    for (const f of NO_ROW_FACTIONS) {
      for (const hg of hullGroups) {
        assert.strictEqual(data.resolveLootTable(f, hg, on), `loot_belt_normal_${data.sizeOf(hg)}`, `${f} ${hg}`);
      }
    }
    for (const f of ROW_FACTIONS) {
      for (const hg of hullGroups) assert.strictEqual(data.resolveLootTable(f, hg, on), data.lootTableOf(f, hg));
    }
    for (const unusable of [new Set(), new Set(["loot_belt_normal_small", "loot_sleeper_blue_large"])]) {
      for (const fallback of [RANDOM_ANY, null]) {
        for (const f of [...NO_ROW_FACTIONS, ...ROW_FACTIONS]) {
          for (const hg of hullGroups) {
            assert.strictEqual(data.resolveLootTable(f, hg, { sizedDefault: false, fallbackId: fallback, unusable,
              randomAny: new Set([RANDOM_ANY]) }), oldLootTableFor(f, hg, unusable, fallback), `${f} ${hg}`);
          }
        }
      }
    }
  });

  test("DL2 chain: default unusable -> fallback, random-any fallback -> null, flag off keeps the fallback", () => {
    const unusable = new Set(["loot_belt_normal_large"]);
    assert.strictEqual(data.resolveLootTable(500001, "battleship", { sizedDefault: true, fallbackId: "other_table",
      unusable }), "other_table");
    assert.strictEqual(data.resolveLootTable(500001, "battleship", { sizedDefault: true, fallbackId: RANDOM_ANY,
      unusable, randomAny: new Set([RANDOM_ANY]) }), null);
    assert.strictEqual(data.resolveLootTable(500001, "battleship", { sizedDefault: true, fallbackId: RANDOM_ANY,
      unusable: new Set(["loot_belt_normal_large", RANDOM_ANY]) }), null);
    assert.strictEqual(data.resolveLootTable(500001, "battleship", { sizedDefault: false, fallbackId: RANDOM_ANY,
      unusable, randomAny: new Set([RANDOM_ANY]) }), RANDOM_ANY);
    assert.strictEqual(data.resolveLootTable(500021, "frigate", { sizedDefault: true, fallbackId: RANDOM_ANY,
      unusable: new Set(["loot_sleeper_blue_small"]), randomAny: new Set([RANDOM_ANY]) }), "loot_belt_normal_small");
  });

  if (!fs.existsSync(NPC_LOOT_JS)) {
    skip("DL3-DL4 vendor loot facts", "server/src not on disk");
    return;
  }
  const setup = npcSetupTables();
  if (!setup.ok) {
    skip("DL3-DL4 vendor loot facts", setup.reason);
    return;
  }
  const tables = setup.tables.npcLootTables.lootTables;
  const byId = new Map(tables.map((t) => [t.lootTableID, t]));

  test("DL3 isRandomAnyLootTable on the vendor tables + npcLoot.js rule kinds", () => {
    assert.strictEqual(isRandomAnyLootTable(byId.get(RANDOM_ANY)), true);
    const ids = [...data.allLootTableIds(), ...Object.values(data.DEFAULT_LOOT_ROW)];
    for (const id of ids) {
      assert.ok(byId.has(id), `${id} in data.json`);
      assert.strictEqual(isRandomAnyLootTable(byId.get(id)), false, id);
    }
    const emptyRules = tables.filter((t) => t.emptyRule === true);
    assert.ok(emptyRules.length > 0);
    for (const t of emptyRules) assert.strictEqual(isRandomAnyLootTable(t), false, t.lootTableID);
    const src = fs.readFileSync(NPC_LOOT_JS, "utf8").replace(/\r\n/g, "\n");
    for (const kind of ["ammo", "module", "utility", "trash"]) assert.ok(src.includes(`kind === "${kind}"`), kind);
    assert.ok(src.includes("categoryID === 7") && src.includes("categoryID === 8"));
    const start = src.indexOf("\nfunction getGenericLootPool(");
    assert.ok(start >= 0);
    const body = src.slice(start, src.indexOf("\nfunction ", start + 1));
    assert.ok(body.includes("EXCLUDED_GROUP_NAMES") && !body.includes("categoryID"), "pool filters only groups");
  });

  test("DL4 belt_normal selectors are rule kinds; 200 seeded empire plans get belt_normal tables", () => {
    for (const id of Object.values(data.DEFAULT_LOOT_ROW)) {
      const t = byId.get(id);
      assert.strictEqual(String(t.mode).toLowerCase(), "rule", id);
      assert.ok(Array.isArray(t.selectors) && t.selectors.length > 0, id);
      for (const s of t.selectors) assert.ok(RULE_KINDS.has(s.kind), `${id} ${s.kind}`);
    }
    const r = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual(r.errors, []);
    const P = r.config.salvageAnomaly;
    assert.strictEqual(P.sizedDefaultLoot, true, "Default on");
    assert.strictEqual(P.fallbackLootTableId, RANDOM_ANY, "Default fallback kept");
    const lootTableFor = (f, hg) => data.resolveLootTable(f, hg, { sizedDefault: P.sizedDefaultLoot,
      fallbackId: P.fallbackLootTableId, unusable: new Set(), randomAny: new Set([RANDOM_ANY]) });
    const re = /^loot_belt_normal_(small|medium|large)$/;
    let specs = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const rng = createRng(seed);
      const composition = [0, 1, 2].map(() => [NO_ROW_FACTIONS[rng.nextInt(0, NO_ROW_FACTIONS.length - 1)],
        hullGroups[rng.nextInt(0, hullGroups.length - 1)], 0, rng.nextInt(1, 3)]);
      const ships = composition.reduce((n, c) => n + c[3], 0);
      const plan = planAnomaly({ composition, shipsLost: ships, salvageUnits: 4 * ships, lootUnits: 40 },
        { salvage: 4 * ships, loot: 40 }, P, seed);
      assert.ok(plan.ok, JSON.stringify(plan));
      const row = { anomalyId: `salv:${seed}`, systemId: 30000142, expiresAt: 2000000000000 };
      for (const w of plan.wrecks) {
        const spec = placeSpecOf(row, w, { siteKey: `lne:salv:${seed}:0`, nowMs: 1700000000000, lootTableFor });
        assert.ok(re.test(spec.lootTableId), `${seed} ${w.factionId} ${w.hullGroup} ${spec.lootTableId}`);
        specs += 1;
      }
    }
    assert.ok(specs >= SEEDS, `${specs} specs`);
  });
};
