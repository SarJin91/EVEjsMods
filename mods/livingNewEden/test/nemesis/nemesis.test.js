"use strict";

const assert = require("node:assert");

const S = require("../../lib/nemesis/schema");
const { decideNemesisOnEnd, profileOf, historyPush } = require("../../lib/nemesis/policy");
const { MIGRATIONS, runMigrations } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver } = require("../notices/storeHelper");

const nemesisInsert = (db, characterId, commanderId, state, id = `nem:${characterId}:${commanderId}`) => db.prepare(
  `INSERT INTO world_nemesis (nemesis_id, character_id, commander_id, faction_id, gang_id, rank, base_level, state,
  next_return_at, last_encounter_at, origin_revenge_id, origin_system_id, seed, created_at, updated_at)
  VALUES (?, ?, ?, 500010, 1, 1, 3, ?, 0, 0, 'rev:x', 4, 1, 0, 0)`).run(id, characterId, commanderId, state);

module.exports = ({ test, skip }) => {
  test("NM2 decideNemesisOnEnd: every reason in order, CREATE (WIN vs WIN_OR_SURVIVE)", () => {
    const o = { revengeId: "rev:bnt:1:1", nemesisId: null, state: "DONE", reason: "TARGET_DOWN", engaged: true,
      bossKilled: false, commanderId: 7002, commanderName: "Bo Hunter", characterId: 42, factionId: 500010,
      gangId: 1, hunterLevel: 3, systemId: 4, killSystemId: 3, quarryTypeId: null, quarryGroupId: null };
    const c = { openForPlayer: 0, openTotal: 0, commanderOpen: false, pairKnown: false };
    const p = { createOn: "WIN_OR_SURVIVE", maxActivePerPlayer: 2, maxActiveTotal: 64 };
    const rows = [
      [null, { ...o, nemesisId: "nem:42:7001" }, c, p, "NEMESIS_ROW"],
      [null, { ...o, state: "EXPIRED" }, c, p, "NOT_DONE"],
      [null, { ...o, engaged: false }, c, p, "NOT_ENGAGED"],
      [null, { ...o, bossKilled: true }, c, p, "BOSS_KILLED"],
      [null, { ...o, reason: "WIPED" }, c, p, "BOSS_KILLED"],
      [null, { ...o, commanderId: null }, c, p, "NO_COMMANDER"],
      [null, { ...o, commanderName: null }, c, p, "NO_NAME"],
      [null, { ...o, reason: "RETREATED" }, c, { ...p, createOn: "WIN" }, "CREATE_ON"],
      [null, o, { ...c, openForPlayer: 2 }, p, "LIMIT_PLAYER"],
      [null, o, { ...c, openTotal: 64 }, p, "LIMIT_TOTAL"],
      [null, o, { ...c, pairKnown: true, commanderOpen: true }, p, "KNOWN"],
      [null, o, { ...c, commanderOpen: true }, p, "COMMANDER_OPEN"],
    ];
    for (const [nem, out, counts, params, reason] of rows) {
      assert.deepStrictEqual(decideNemesisOnEnd(nem, out, counts, params), { action: "NONE", reason }, reason);
    }
    const create = { action: "CREATE", reason: "OK" };
    assert.deepStrictEqual(decideNemesisOnEnd(null, o, c, { ...p, createOn: "WIN" }), create, "WIN on TARGET_DOWN");
    assert.deepStrictEqual(decideNemesisOnEnd(null, { ...o, reason: "RETREATED" }, c, p), create,
      "WIN_OR_SURVIVE on RETREATED");
    assert.deepStrictEqual(profileOf(null, "cruiser"), { cruiser: 1 });
    assert.deepStrictEqual(profileOf({ cruiser: 1 }, "capsule"), { cruiser: 1 });
    assert.deepStrictEqual(historyPush([1, 2, 3], 4, 3), [2, 3, 4]);
    assert.deepStrictEqual([S.nemesisIdOf(42, 7002), S.encounterKeyOf("rev:bnt:1:1")],
      ["nem:42:7002", "nem:enc:rev:bnt:1:1"]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NM1 migration 116", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NM1 migration 116: world_nemesis, partial unique open captain, nemesis_id NULL on old rows, WIPE", () => {
    const idx = MIGRATIONS.findIndex((m) => m.version === 116);
    assert.ok(idx > 0 && MIGRATIONS[idx].name === "nemesis" && MIGRATIONS[idx].up === S.upNemesis, "registered");
    assert.strictEqual(MIGRATIONS[idx - 1].version, 115);
    assert.strictEqual(TABLE_POLICY.world_nemesis, ACTION.WIPE);
    const db = new driver.Database(":memory:");
    try {
      const ctx = { randomSeed: () => 1 };
      const before = runMigrations(db, MIGRATIONS.slice(0, idx), ctx);
      assert.ok(before.ok && before.to === 115, JSON.stringify(before));
      db.prepare(`INSERT INTO world_bounty_revenge (revenge_id, wanted_id, character_id, faction_id, gang_id,
        boss_character_id, target_level, hunter_level, kill_system_id, state, due_at, expires_at, seed, killed_at,
        created_at, updated_at) VALUES ('rev:a', 'a', 42, 500010, 1, 7000, 4, 3, 3, 'WAITING', 1, 2, 1, 0, 0, 0)`).run();
      const up = runMigrations(db, MIGRATIONS, ctx);
      assert.deepStrictEqual([up.ok, up.applied], [true, MIGRATIONS.length - idx]);
      assert.strictEqual(db.prepare("SELECT nemesis_id FROM world_bounty_revenge").get().nemesis_id, null);
      const index = db.prepare("PRAGMA index_list('world_nemesis')").all()
        .find((r) => r.name === "idx_nemesis_commander_open");
      assert.deepStrictEqual([index.unique, index.partial], [1, 1]);
      nemesisInsert(db, 42, 7002, "ACTIVE");
      assert.throws(() => nemesisInsert(db, 43, 7002, "HUNTING"), /UNIQUE/, "a second open row of the captain");
      nemesisInsert(db, 44, 7002, "RETIRED");
      assert.throws(() => nemesisInsert(db, 42, 7002, "RETIRED", "nem:other"), /UNIQUE/, "one row per pair");
      assert.throws(() => nemesisInsert(db, 45, 7003, "LOST"), /CHECK/);
    } finally {
      db.close();
    }
  });
};
