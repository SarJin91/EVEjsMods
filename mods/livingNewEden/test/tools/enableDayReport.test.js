"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { resolveConfig } = require("../../config");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { upFleets } = require("../../lib/fleets/schema");
const { upBattles } = require("../../lib/battle/schema");
const { upProductionJobs } = require("../../lib/economy/schema");
const { upTreasury, upTreasuryPressure } = require("../../lib/economy/treasury/schema");
const { upStations } = require("../../lib/stations/schema");
const { feeOf } = require("../../lib/economy/treasury/austerity");
const { main, parseArgs, mineralParamsOf, DAY_MS } = require("../../tools/measure/enableDayReport");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1763013600000;
const DAY_11_12 = Math.floor((AT - DAY_MS) / DAY_MS);
const DAY_11_13 = DAY_11_12 + 1;
const HASH = "a".repeat(64);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function battle(id, at, state, outcome) {
  const result = outcome ? `'{"outcome":"${outcome}"}'` : "NULL";
  return `INSERT INTO battle_records (battle_id, idempotency_key, system_id, environment, objective, mode, state,
    resolver_version, input_hash, seed, input_json, fleet_ids, result_json, claim_seq, created_at, updated_at, version)
    VALUES ('${id}', 'k-${id}', 30000001, 'nullsec', 'destroy', 'VIRTUAL', '${state}', 'internal-v1', '${HASH}', 1,
    '{}', '[]', ${result}, 0, ${at}, ${at}, 1);`;
}

const side = (battleId, fleetId, s, f) => `INSERT INTO battle_participants (battle_id, fleet_id, side, faction_id)
  VALUES ('${battleId}', '${fleetId}', '${s}', ${f});`;

const op = (id, type, f, state, at) => `INSERT INTO world_operations (operation_id, idempotency_key, operation_type,
  faction_id, origin_system_id, target_system_id, fleet_ids, objective, state, planned_at, seed, updated_at, version)
  VALUES ('${id}', 'k-${id}', '${type}', ${f}, 30000001, 30000002, '[]', 'x', '${state}', ${at}, 1, ${at}, 1);`;

const job = (id, f, group, state, endReason, runs, at) => `INSERT INTO world_production_jobs (job_id, idempotency_key,
  faction_id, station_id, system_id, hull_group, item_key, runs, recipes_version, consumed_json, run_ms, started_at,
  due_at, state, end_reason, created_at, updated_at, version) VALUES ('${id}', 'k-${id}', ${f}, 'st-1', 30000001,
  '${group}', 'hull:${group}', ${runs}, 1, '{}', 1000, ${at}, ${at + 1000}, '${state}', ${endReason ? `'${endReason}'`
  : "NULL"}, ${at}, ${at}, 1);`;

const day = (f, d, v) => `INSERT INTO world_faction_treasury_days (faction_id, day, income, fleet_upkeep, admin,
  war_spend, production_fees, trade_out, losses, balance_end, updated_at) VALUES (${f}, ${d}, ${v.income}, 0, 0,
  ${v.warSpend || 0}, 0, 0, ${v.losses || 0}, ${v.balance}, ${AT});`;

const station = (id, f, kind, state) => `INSERT INTO world_stations (station_id, kind, system_id, owner_faction_id,
  owner_corporation_id, state, origin, created_at, updated_at, version) VALUES ('${id}', '${kind}', 30000001, ${f},
  1000001, '${state}', 'seed', ${AT}, ${AT}, 1);`;

const stock = (id, minerals) => Object.keys(minerals).map((k) => `INSERT INTO world_station_stock (station_id,
  item_kind, item_key, quantity, updated_at) VALUES ('${id}', 'mineral', '${k}', ${minerals[k]}, ${AT});`).join("\n");

const FRIGATE = { "type:34": 32000, "type:35": 6000, "type:36": 2500, "type:37": 500, "type:38": 30, "type:39": 20,
  "type:40": 10 };
const ST_A = { ...FRIGATE, "type:35": 3000, "type:40": 3 };

function buildDb(Database, file) {
  const db = new Database(file);
  try {
    db.exec("PRAGMA foreign_keys = OFF");
    MIGRATIONS.find((m) => m.version === 2).up(db);
    upFleets(db);
    upBattles(db);
    upProductionJobs(db);
    upTreasury(db);
    upTreasuryPressure(db);
    upStations(db);
    db.exec([
      station("st-a", 500011, "npc", "ONLINE"), stock("st-a", ST_A), station("st-b", 500011, "npc", "ONLINE"),
      station("st-c", 500016, "upwell", "ONLINE"), stock("st-c", { "type:34": 5 }),
      station("st-d", 500016, "npc", "DESTROYED"), station("st-e", 500020, "npc", "ONLINE"),
      `INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, payload,
        payload_hash, state, created_at, applied_at) VALUES ('j1', 'APPLY', 'x', 'x', 'X', '{}', '${HASH}', 'APPLIED',
        ${AT - 5000}, ${AT - 5000});`,
      `INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, payload,
        payload_hash, state, created_at, applied_at) VALUES ('j2', 'APPLY', 'x', 'x', 'X', '{}', '${HASH}', 'APPLIED',
        ${AT}, ${AT});`,
      battle("b1", AT - 1000, "COMPLETED", "B_WIN"), side("b1", "f1", "B", 500019), side("b1", "f2", "B", 500019),
      side("b1", "f3", "A", 500001),
      battle("b2", AT - 2000, "COMPLETED", "A_WIN"), side("b2", "f1", "B", 500019),
      battle("b3", AT - DAY_MS - 1, "COMPLETED", "B_WIN"), side("b3", "f1", "B", 500019),
      battle("b4", AT - 500, "PENDING", null), side("b4", "f4", "B", 500026),
      battle("b5", AT - 500, "PENDING", null), side("b5", "f5", "A", 500029),
      op("o1", "raid", 500026, "ACTIVE", AT - 1000), op("o2", "gank", 500026, "COMPLETED", AT - 2000),
      op("o3", "raid", 500026, "PLANNED", AT - DAY_MS - 5), op("o4", "raid", 500026, "COMPLETED", AT - 7 * 3600000),
      op("o5", "invasion", 500001, "ACTIVE", AT - 1000), op("o6", "recon", 500001, "COMPLETED", AT - 2000),
      op("o7", "invasion", 500001, "FAILED", AT - 3000), op("o8", "invasion", 500003, "ACTIVE", AT - DAY_MS - 5),
      job("j1", 500012, "titan", "ACTIVE", null, 1, AT - 1000), job("j2", 500001, "cruiser", "ACTIVE", null, 5, AT - 1000),
      job("j3", 500002, "carrier", "DONE", "DELIVERED", 1, AT - DAY_MS - 1),
      job("j4", 500002, "dreadnought", "DONE", "DELIVERED", 2, AT - 5000),
      day(500012, DAY_11_12 - 1, { income: 5, balance: 5 }),
      day(500012, DAY_11_12, { income: 1e12, balance: 1e12, warSpend: 1e11, losses: 1e10 }),
      day(500020, DAY_11_13, { income: 0, balance: 0 }),
    ].join("\n"));
  } finally {
    db.close();
  }
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("EDR1 enableDayReport", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("EDR1 enableDayReport: six sections on a small database, default window, --since, missing file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-edr1-"));
    try {
      const file = path.join(dir, "world.sqlite");
      buildDb(driver.Database, file);
      const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
      const config = { production: { ...base.production, linesPerUpwellStation: 0 }, treasury: { ...base.treasury, productionFeePermille: 100,
        savingsDrawPermillePerDay: 3, productionRoomSharePermille: 500, lossesInRoomPermille: 300,
        warRoomRollingEnabled: true } };
      const lines = [];
      const code = main(["--db", file, "--json"], { out: (s) => lines.push(s), err: (s) => assert.fail(s),
        Database: driver.Database, config });
      assert.strictEqual(code, 0);
      const r = JSON.parse(lines[0]);
      assert.strictEqual(r.at, AT);
      assert.strictEqual(r.since, AT - DAY_MS);
      assert.strictEqual(r.sinceSource, "journal");

      assert.deepStrictEqual(r.defense.factions, [
        { factionId: 500019, battles: 2, completed: 2, bWin: 1, aWin: 1 },
        { factionId: 500021, battles: 0, completed: 0, bWin: 0, aWin: 0 },
        { factionId: 500026, battles: 1, completed: 0, bWin: 0, aWin: 0 },
        { factionId: 500029, battles: 0, completed: 0, bWin: 0, aWin: 0 }]);

      assert.deepStrictEqual(r.raids.days, [
        { day: DAY_11_12, operationType: "raid", count: 1 },
        { day: DAY_11_13, operationType: "gank", count: 1 },
        { day: DAY_11_13, operationType: "raid", count: 1 }]);
      assert.deepStrictEqual(r.raids.open, [{ operationType: "raid", count: 2 }]);
      assert.strictEqual(r.raids.openRaids, 2);

      assert.deepStrictEqual(r.capitalJobs.jobs, [
        { factionId: 500002, hullGroup: "dreadnought", state: "DONE", endReason: "DELIVERED", jobs: 1, runs: 2 },
        { factionId: 500012, hullGroup: "titan", state: "ACTIVE", endReason: null, jobs: 1, runs: 1 }]);

      assert.strictEqual(r.warRoom.ok, true);
      assert.ok(r.warRoom.titanValue > 0);
      assert.strictEqual(r.warRoom.titanFee, feeOf(1, r.warRoom.titanValue, 100));
      assert.deepStrictEqual(r.warRoom.days.map(({ titanFits, ...d }) => d), [
        { factionId: 500012, day: DAY_11_12, dayBudget: 1003000000000, spent: 103000000000, capFull: 501500000000,
          capLeft: 450000000000 },
        { factionId: 500020, day: DAY_11_13, dayBudget: 0, spent: 0, capFull: 0, capLeft: 0 }]);
      assert.strictEqual(r.warRoom.days[0].titanFits, 501500000000 >= r.warRoom.titanFee);
      assert.strictEqual(r.warRoom.days[1].titanFits, false);

      assert.deepStrictEqual(r.empireLaunches.factions, [
        { factionId: 500001, types: [{ operationType: "invasion", count: 2 }, { operationType: "recon", count: 1 }],
          strategic: 3 },
        { factionId: 500002, types: [], strategic: 0 }, { factionId: 500003, types: [], strategic: 0 },
        { factionId: 500004, types: [], strategic: 0 }]);
      assert.strictEqual(r.until, AT);
      assert.strictEqual(r.warRoom.configErrors, undefined);

      const mp = mineralParamsOf(config);
      assert.deepStrictEqual(mp.recipes.frigate, FRIGATE);
      assert.strictEqual(r.bindingMinerals.ok, true);
      assert.deepStrictEqual(r.bindingMinerals.factions.map((f) => [f.factionId, f.stations.map((s) => s.stationId)]),
        [[500011, ["st-a", "st-b"]], [500020, ["st-e"]]]);
      const [stA, stB] = r.bindingMinerals.factions[0].stations;
      assert.deepStrictEqual(stA.minerals, ST_A);
      assert.strictEqual(stA.lines, base.production.linesPerNpcStation);
      assert.deepStrictEqual(stA.blocked.find((b) => b.hullGroup === "frigate"), { hullGroup: "frigate",
        mineral: "type:40", stock: 3, need: 10, permille: 300, missing: 7 });
      assert.ok(stA.blocked.every((b) => !mp.freeGroups.includes(b.hullGroup)), JSON.stringify(stA.blocked));
      assert.ok(mp.freeGroups.length > 0);
      const groups = Object.keys(mp.recipes).filter((g) => !mp.freeGroups.includes(g));
      assert.deepStrictEqual(stB.blocked.map((b) => [b.hullGroup, b.mineral, b.permille]),
        groups.map((g) => [g, Object.keys(mp.recipes[g])[0], 0]));
      assert.strictEqual(r.bindingMinerals.factions[0].binding["type:40"] >= 1, true);

      const off = [];
      assert.strictEqual(main(["--db", file, "--json", "--until", String(AT - 1500)], { out: (s) => off.push(s),
        Database: driver.Database, loadConfig: () => ({ ok: false, errors: ["settings.json: not valid JSON (x)"],
          config: { ...config, treasury: { ...config.treasury, warRoomRollingEnabled: false } } }) }), 0);
      const o = JSON.parse(off[0]);
      assert.strictEqual(o.until, AT - 1500);
      assert.strictEqual(o.since, AT - 1500 - DAY_MS);
      assert.deepStrictEqual(o.defense.factions[0], { factionId: 500019, battles: 2, completed: 2, bWin: 1, aWin: 1 });
      assert.deepStrictEqual(o.warRoom.configErrors, ["settings.json: not valid JSON (x)"]);
      assert.strictEqual(o.warRoom.params.warRoomRollingEnabled, false);
      assert.deepStrictEqual(o.warRoom.days.map(({ titanFits, ...d }) => d), [
        { factionId: 500012, day: DAY_11_12, dayBudget: 1003000000000, spent: 103000000000, capFull: 501499994195,
          capLeft: 449999994195 },
        { factionId: 500020, day: DAY_11_13, dayBudget: 0, spent: 0, capFull: 0, capLeft: 0 }]);

      const text = [];
      assert.strictEqual(main(["--db", file, "--since", "2025-11-11T00:00:00Z"], { out: (s) => text.push(s),
        Database: driver.Database, config }), 0);
      assert.ok(text[0].startsWith("window [2025-11-11T00:00:00Z, 2025-11-13T06:00:00Z] since=argument"), text[0]);
      assert.ok(text.includes("  500003 invasion=1"), text.join("\n"));
      assert.ok(text.includes("  500003 strategic(invasion+recon+raid)=1"), text.join("\n"));
      assert.ok(text.includes("[5] operations of the empires per type (LAUNCH + services)"), text.join("\n"));
      assert.ok(text.includes("    frigate binding=Megacyte 3/10 permille=300 missing=7"), text.join("\n"));
      assert.ok(text.includes("  500011 st-b sys=30000001 npc lines=4 (no minerals)"), text.join("\n"));
      assert.strictEqual(parseArgs(["--db", "x", "--since", "1000"]).since, 1000);

      const sel = [];
      assert.strictEqual(main(["--db", file, "--json", "--factions", "500016,500011"], { out: (s) => sel.push(s),
        Database: driver.Database, config }), 0);
      assert.deepStrictEqual(JSON.parse(sel[0]).bindingMinerals.factions.map((f) => f.factionId), [500011]);
      const badFactions = [];
      assert.strictEqual(main(["--db", file, "--factions", "5000x1"], { out: () => {},
        err: (s) => badFactions.push(s) }), 1);
      assert.strictEqual(badFactions.length, 1);

      const u = [];
      assert.strictEqual(main(["--db", file, "--json", "--until", String(AT - 3000)], { out: (s) => u.push(s),
        Database: driver.Database, config }), 0);
      const uw = JSON.parse(u[0]);
      assert.deepStrictEqual([uw.since, uw.until, uw.sinceSource], [AT - 3000 - DAY_MS, AT - 3000, "until"]);
      const late = [];
      assert.strictEqual(main(["--db", file, "--since", String(AT + 1)], { out: (s) => assert.fail(s),
        err: (s) => late.push(s), Database: driver.Database, config }), 1);
      assert.strictEqual(late.length, 1);
      assert.ok(late[0].includes("is before --since"), late[0]);
      const bad = [];
      const badText = [];
      assert.strictEqual(main(["--db", file], { out: (s) => badText.push(s), err: (s) => bad.push(s),
        Database: driver.Database, loadConfig: () => ({ ok: false, errors: ["e1", "e2"], config: {} }) }), 0);
      assert.deepStrictEqual(bad, []);
      assert.ok(badText.includes("  configErrors=e1; e2"), badText.join("\n"));

      const errs = [];
      assert.strictEqual(main(["--db", path.join(dir, "missing.sqlite")], { out: () => {}, err: (s) => errs.push(s) }), 1);
      assert.strictEqual(errs.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
};
