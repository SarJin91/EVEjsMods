"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const rl = require("../../lib/adapter/rewardLoot");
const nw = require("../../lib/adapter/nativeWrecks");
const { harness: H } = require("./nativeWrecks.test");

const NPC_LOOT = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "npc", "npcLoot.js");

function spec(overrides = {}) {
  return {
    id: "angel_medium",
    sizeBand: "medium",
    itemPrefixes: ["Domination"],
    deadspacePrefixes: ["Gist"],
    factionAmmoWeight: 20,
    factionModuleWeight: 4,
    deadspaceModuleWeight: 2,
    minEntries: 2,
    maxEntries: 3,
    ...overrides,
  };
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

module.exports = ({ test }) => {
  test("RL1 rewardLoot: vendor rule table, selectors, size excludes, weight 0 left out, frozen; invalid spec", () => {
    const built = rl.buildRewardLootTable(spec());
    assert.strictEqual(built.ok, true);
    const t = built.table;
    assert.deepStrictEqual(
      [t.lootTableID, t.name, t.mode, t.minEntries, t.maxEntries, t.emptyChance, t.allowDuplicates],
      ["lne_reward_angel_medium", "LNE reward angel_medium", "rule", 2, 3, 0, false]);
    assert.ok(t.lootTableID.startsWith(rl.REWARD_TABLE_PREFIX));
    const shape = t.selectors.map((s) => [s.kind, s.tier || s.grade, s.sizeBand, s.weight]);
    assert.deepStrictEqual(shape, [
      ["ammo", "low", "medium", 40], ["module", "low", "medium", 15], ["utility", "low", "medium", 15],
      ["trash", "low", undefined, 15], ["ammo", "faction", "medium", 20], ["module", "faction", "medium", 4],
      ["module", "deadspace", "medium", 2]]);
    assert.deepStrictEqual([t.selectors[0].quantityMin, t.selectors[0].quantityMax], [30, 100]);
    assert.deepStrictEqual([t.selectors[3].quantityMin, t.selectors[3].quantityMax], [1, 5]);
    assert.deepStrictEqual([t.selectors[4].quantityMin, t.selectors[4].quantityMax], [10, 40]);
    assert.deepStrictEqual(t.selectors[4].nameIncludes, ["Domination"]);
    assert.deepStrictEqual(t.selectors[5].nameIncludes, ["Domination"]);
    assert.deepStrictEqual(t.selectors[6].nameIncludes, ["Gist"]);
    assert.deepStrictEqual(t.selectors[4].nameExcludes, [...rl.NAME_EXCLUDES]);
    assert.deepStrictEqual(t.selectors[1].nameExcludes, [...rl.SIZE_NAME_EXCLUDES.medium]);
    for (const i of [5, 6]) {
      assert.deepStrictEqual(t.selectors[i].nameExcludes, [...rl.NAME_EXCLUDES, ...rl.SIZE_NAME_EXCLUDES.medium]);
    }
    const large = rl.buildRewardLootTable(spec({ sizeBand: "large" })).table;
    const cut = large.selectors[5].nameExcludes;
    assert.strictEqual(cut.filter((n) => n === "X-Large").length, 1, "X-Large once (own + size list)");
    assert.strictEqual(new Set(cut).size, cut.length);
    assert.strictEqual(t.selectors[3].nameExcludes, undefined, "trash has no size cut");
    const lean = rl.buildRewardLootTable(spec({ factionAmmoWeight: 0, deadspacePrefixes: [], deadspaceModuleWeight: 9 }));
    assert.deepStrictEqual(lean.table.selectors.map((s) => `${s.kind}:${s.tier || s.grade}`),
      ["ammo:low", "module:low", "utility:low", "trash:low", "module:faction"]);
    assert.ok(Object.isFrozen(t) && Object.isFrozen(t.selectors) && Object.isFrozen(t.selectors[5].nameExcludes));
    assert.ok(!rl.NAME_EXCLUDES.includes("Quad "), "size list not pulled into the shared list");

    for (const [bad, field] of [[null, "spec"], [[], "spec"], [spec({ id: "AB" }), "id"], [spec({ id: "x".repeat(49) }), "id"],
      [spec({ sizeBand: "xl" }), "sizeBand"], [spec({ itemPrefixes: [] }), "itemPrefixes"],
      [spec({ itemPrefixes: ["a", "b", "c", "d", "e"] }), "itemPrefixes"], [spec({ itemPrefixes: [" "] }), "itemPrefixes"],
      [spec({ deadspacePrefixes: "Gist" }), "deadspacePrefixes"], [spec({ factionAmmoWeight: 1001 }), "factionAmmoWeight"],
      [spec({ factionModuleWeight: 1.5 }), "factionModuleWeight"], [spec({ deadspaceModuleWeight: -1 }), "deadspaceModuleWeight"],
      [spec({ minEntries: 0 }), "minEntries"], [spec({ maxEntries: 7 }), "maxEntries"],
      [spec({ minEntries: 3, maxEntries: 2 }), "maxEntries"],
      [spec({ id: "Angel_medium" }), "id"],
      [spec({ deadspacePrefixes: ["a", "b", "c", "d", "e"] }), "deadspacePrefixes"]]) {
      assert.deepStrictEqual(rl.buildRewardLootTable(bad), { ok: false, reason: "REWARD_LOOT_INVALID", detail: field },
        field);
    }
    assert.strictEqual(rl.buildRewardLootTable(spec({ deadspacePrefixes: ["a", "b", "c", "d"] })).ok, true,
      "4 deadspace prefixes = the limit");

    assert.strictEqual(rl.isFactionRewardName("Domination Large Armor Repairer", spec()), true);
    assert.strictEqual(rl.isFactionRewardName("Gist B-Type X-Large Shield Booster", spec()), true);
    assert.strictEqual(rl.isFactionRewardName("domination emp m", spec()), true, "lower-case includes, like the vendor");
    assert.strictEqual(rl.isFactionRewardName("Large Armor Repairer I", spec()), false);
    assert.strictEqual(rl.isFactionRewardName(undefined, spec()), false);
    assert.strictEqual(rl.isFactionRewardName("Domination X", null), false);
  });

  test("RL2 place with rewardLoot: table object rolled, extraRoll from the 2nd roll, factionItems; lootSource", () => {
    const reward = spec({ id: "guristas_medium", itemPrefixes: ["Dread Guristas"], deadspacePrefixes: ["Pith"] });
    const names = [["Dread Guristas Medium Shield Booster", "Scourge Heavy Missile"], ["Pith B-Type EM Ward Field"]];
    const a = H.makeMods({ rollEntries: (n) => names[n - 1].map((name, k) => (k === 0 && n === 1
      ? { itemType: { typeID: 10 * n + k, name }, name, quantity: 1, singleton: false }
      : { itemType: { typeID: 10 * n + k, name }, quantity: 50, singleton: false })) });
    const tables = [];
    const roll = a.mods.npcLoot.rollNpcLootEntries;
    a.mods.npcLoot.rollNpcLootEntries = (...args) => { tables.push(args[0]); return roll(...args); };
    let staticReads = 0;
    a.mods.npcData.getNpcLootTable = () => { staticReads += 1; return null; };

    const placed = nw.placeWreckFrom(a.mods, H.baseSpec({ lootTableId: undefined, rewardLoot: reward, lootRolls: 2 }));
    assert.deepStrictEqual({ ...placed, wreckId: 0 },
      { ok: true, adopted: false, wreckId: 0, items: 3, factionItems: 2, spawned: false, vendorWrites: 4 });
    assert.strictEqual(staticReads, 0, "no static table read");
    assert.strictEqual(tables.length, 2);
    assert.strictEqual(tables[0], tables[1], "one table object for both rolls");
    assert.deepStrictEqual(tables[0], rl.buildRewardLootTable(reward).table);
    assert.deepStrictEqual(a.calls.filter((c) => c[0] === "rollOptions"), [["rollOptions", { extraRoll: true }]]);
    assert.strictEqual(a.wrecks.get(placed.wreckId).lootTableID, "lne_reward_guristas_medium");

    const again = nw.placeWreckFrom(a.mods, H.baseSpec({ lootTableId: undefined, rewardLoot: reward, lootRolls: 2 }));
    assert.deepStrictEqual([again.ok, again.adopted, again.wreckId, again.items, again.factionItems],
      [true, true, placed.wreckId, 3, 0]);

    const z = H.makeMods();
    const empty = nw.placeWreckFrom(z.mods, H.baseSpec({ lootTableId: null, rewardLoot: reward, lootRolls: 0 }));
    assert.deepStrictEqual([empty.ok, empty.items, empty.factionItems], [true, 0, 0]);
    assert.ok(!H.names(z.calls).includes("roll"));

    for (const [extra, detail] of [[{ rewardLoot: reward }, "lootSource"], [{ lootTableId: null, rewardLoot: "x" }, "rewardLoot"],
      [{ lootTableId: null, rewardLoot: [] }, "rewardLoot"],
      [{ lootTableId: null, rewardLoot: spec({ sizeBand: "huge" }) }, "rewardLoot"]]) {
      const r = H.makeMods();
      const findSite = r.mods.dungeonRuntime.findInstanceBySiteKey;
      r.mods.dungeonRuntime.findInstanceBySiteKey = (key) => { r.calls.push(["findInstanceBySiteKey", key]);
        return findSite(key); };
      assert.deepStrictEqual(nw.placeWreckFrom(r.mods, H.baseSpec(extra)),
        { ok: false, reason: "SPEC_INVALID", detail, vendorWrites: 0 }, detail);
      assert.deepStrictEqual(r.calls, [], detail);
    }
    assert.deepStrictEqual([...nw.FACADE_METHODS], ["listOwn", "getOwn", "place", "remove", "flush", "checkLootTables",
      "checkWreckNames", "readGrid"]);
  });

  test("RL3 vendor facts: rollNpcLootEntries takes a table object, rule branch, special grades, rule pool", () => {
    const src = fs.readFileSync(NPC_LOOT, "utf8").replace(/\r\n/g, "\n");
    assert.match(src, /^function rollNpcLootEntries\(lootTable = null, options = \{\}\) \{$/m);
    assert.match(src, /^ {2}rollNpcLootEntries,$/m, "exported");
    const internal = functionBody(src, "rollNpcLootEntriesInternal");
    assert.ok(internal.includes("normalizeLowerText(lootTable.mode) === \"rule\" ||"), "rule branch by mode");
    assert.ok(internal.includes("Array.isArray(lootTable.selectors)"), "rule branch by selectors");
    assert.ok(internal.includes("...rollRuleLootEntries(lootTable),"));
    const grades = functionBody(src, "selectorAllowsSpecialGrade");
    for (const g of ["\"faction\"", "\"deadspace\""]) assert.ok(grades.includes(g), g);
    const eligible = functionBody(src, "isRuleEligibleBaseItem");
    for (const check of ["!isBlueprintType(itemType)", "!isTechTwoItem(itemType)",
      "(selectorAllowsSpecialGrade(selector) || !isSpecialGradeItem(itemType))"]) {
      assert.ok(eligible.includes(check), check);
    }
    const pool = functionBody(src, "getRuleCandidatePool");
    assert.ok(pool.includes("const cacheKey = getRuleSelectorCacheKey(selector);"));
    const rule = functionBody(src, "rollRuleLootEntries");
    assert.ok(rule.includes("weight: Math.max(1, toPositiveInt(selector.weight, 1)),"), "weight 0 still rolls");
    assert.ok(rule.includes(".filter((entry) => entry.pool.length > 0);"), "empty pool skipped");
    assert.ok(functionBody(src, "itemMatchesTextFilters").includes("nameIncludes.some((needle) => itemText.includes(needle))"));
  });
};
