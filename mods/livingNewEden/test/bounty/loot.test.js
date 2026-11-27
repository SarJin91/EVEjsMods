"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const LOOT = require("../../lib/bounty/data/loot");
const { planBountyLoot } = require("../../lib/bounty/loot");
const { rollOfficerLootFrom } = require("../../lib/adapter/bountyLoot");
const { buildFactionProfileRows } = require("../../lib/adapter/factionProfiles");
const DATA = require("../../lib/adapter/data/factionLiveProfiles");

const SDE_TYPES = path.resolve(__dirname, "..", "..", "..", "..", "_local", "sde",
  "eve-online-static-data-3396210-jsonl", "types.jsonl");
const NPC_FREIGHTERS = Object.freeze([2877, 2879, 2882, 32230]);
const SEEDS = Array.from({ length: 60 }, (_v, i) => 1000 + i * 7919);

const total = (items) => items.reduce((s, it) => s + it.quantity, 0);
const sumOver = (level, smuggler) => SEEDS.reduce((s, seed) => s + total(planBountyLoot(seed, level, smuggler, LOOT)),
  0);

module.exports = ({ test }) => {
  test("P3 planBountyLoot: deterministic, grows with the level, x3 smuggler, types of the list; officer roll", () => {
    assert.deepStrictEqual(planBountyLoot(77, 4, 0, LOOT), planBountyLoot(77, 4, 0, LOOT));
    const known = new Set(LOOT.CONTRABAND.map((c) => c.typeId));
    for (const seed of SEEDS.slice(0, 10)) {
      for (let level = 1; level <= 6; level += 1) {
        const items = planBountyLoot(seed, level, 1, LOOT);
        assert.ok(items.length <= LOOT.LEVEL_LOOT_ROLLS[level] * LOOT.SMUGGLER_MULTIPLIER);
        assert.ok(items.every((it, i) => known.has(it.typeId) && it.quantity > 0
          && (i === 0 || items[i - 1].typeId < it.typeId)), JSON.stringify(items));
      }
    }
    const byLevel = [1, 2, 3, 4, 5, 6].map((l) => sumOver(l, 0));
    assert.ok(byLevel.every((v, i) => i === 0 || v > byLevel[i - 1]), byLevel.join(","));
    const ratio = sumOver(4, 1) / sumOver(4, 0);
    assert.ok(ratio > 2.5 && ratio < 3.5, String(ratio));
    assert.deepStrictEqual(planBountyLoot(77, 9, 0, LOOT), []);

    if (fs.existsSync(SDE_TYPES)) {
      const published = new Map();
      for (const line of fs.readFileSync(SDE_TYPES, "utf8").split("\n")) {
        if (line === "") continue;
        const t = JSON.parse(line);
        const id = t._key !== undefined ? t._key : t.typeID;
        if (known.has(id)) published.set(id, t.published === true && [303, 313].includes(t.groupID));
      }
      for (const id of known) assert.strictEqual(published.get(id), true, `SDE ${id} published contraband`);
    } else {
      console.log(`     P3 SDE check skipped (no ${SDE_TYPES})`);
    }

    const seen = [];
    const npcData = { getNpcLootTable(id) {
      seen.push(id);
      return { lootTableID: id };
    } };
    const npcLoot = { rollNpcLootEntries: (table, opts) => [{ typeID: 20, quantity: opts.source.seed % 3 + 1 },
      { typeID: 10, quantity: 1 }, { typeID: 30, quantity: 1, singleton: 2 }] };
    const a = rollOfficerLootFrom(npcData, npcLoot, 500010, 41);
    assert.deepStrictEqual(a, { ok: true, items: [{ typeId: 10, quantity: 1 }, { typeId: 20, quantity: 3 }],
      skipped: 1 });
    assert.deepStrictEqual(seen, ["parity_guristas_officer"]);
    assert.deepStrictEqual(rollOfficerLootFrom(npcData, npcLoot, 500012, 41), { ok: true, items: [], skipped: 0 });
    assert.deepStrictEqual(rollOfficerLootFrom(null, npcLoot, 500011, 41).reason, "SEAM_UNAVAILABLE");
  });

  test("P4 buildFactionProfileRows: bountyFreighters -> 10 faction freighter rows (NPC presentation of group 875); off -> "
    + "none; freighters only -> no faction row", () => {
    const isFreighter = (r) => r.profileID.startsWith("lne_bounty_");
    const plain = buildFactionProfileRows({ data: DATA });
    assert.ok(plain.ok);
    assert.strictEqual(plain.rows.npcProfiles.filter(isFreighter).length, 0);
    const both = buildFactionProfileRows({ data: DATA, bountyFreighters: true });
    assert.deepStrictEqual(both.rows.npcProfiles.filter((r) => !isFreighter(r)), plain.rows.npcProfiles);
    assert.deepStrictEqual(both.index, plain.index);
    const only = buildFactionProfileRows({ data: DATA, bountyFreighters: true, includeFactions: false });
    const rows = only.rows.npcProfiles;
    assert.strictEqual(rows.length, 10);
    assert.deepStrictEqual(only.index, {});
    for (const r of rows) {
      assert.ok(NPC_FREIGHTERS.includes(r.presentationTypeID) && r.presentationTypeID !== r.shipTypeID,
        JSON.stringify(r));
      assert.strictEqual(r.loadoutID, DATA.BOUNTY_FREIGHTER_LOADOUT_ID);
    }
    const factions = [500010, 500011, 500012, 500019, 500020];
    assert.deepStrictEqual(rows.map((r) => r.profileID).sort(), factions
      .flatMap((f) => [DATA.bountyFreighterProfileId(f, false), DATA.bountyFreighterProfileId(f, true)]).sort());
    for (const r of rows) assert.ok(r.profileID.endsWith(`_${r.factionID}`), r.profileID);
    const pick = (id) => rows.filter((r) => r.profileID === id)
      .map((r) => [r.shipTypeID, r.name, r.factionID, r.corporationID, r.hardwareFamily]);
    assert.deepStrictEqual(pick("lne_bounty_freighter_500019"),
      [[20183, "Sansha's Nation Freighter", 500019, 1000162, "sanshasNation"]]);
    assert.deepStrictEqual(pick("lne_bounty_jump_freighter_500012"),
      [[28850, "Blood Raider Jump Freighter", 500012, 1000134, "bloodRaiders"]]);
    assert.deepStrictEqual(pick("lne_bounty_freighter_500010"),
      [[20185, "Guristas Freighter", 500010, 1000127, "guristasLaunchers"]]);
  });
};
