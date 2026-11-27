"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { resolveConfig } = require("../../config");
const tool = require("../../tools/huntState");
const { seedDbFile } = require("../_support/dbTemplate");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const HASH = "b".repeat(64);
const SYS = 30000001;
const GURISTAS = 500010;
const AMARR = 500003;
const CONFIG = { playerHunt: { ...resolveConfig({ modDir: MOD_DIR, env: {} }).config.playerHunt } };

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function insertFleet(db, fleetId, factionId, role, composition, state) {
  const ships = composition.reduce((n, g) => n + g.count, 0);
  db.prepare("INSERT INTO virtual_fleets (fleet_id, faction_id, current_system_id, leg_seq, fleet_role, "
    + "composition_json, ship_count, supply_state, state, created_at, updated_at, version) "
    + "VALUES (?, ?, ?, 0, ?, ?, ?, 100, ?, 1, 1, 1)")
    .run(fleetId, factionId, SYS, role, JSON.stringify(composition), ships, state);
}

function insertHunt(db, h) {
  db.prepare("INSERT INTO world_player_hunts (hunt_id, fleet_id, faction_id, system_id, character_id, mode, state, "
    + "standing, members_json, seed, started_at, live_at, ended_at, end_reason, losses_json, updated_at, version) "
    + "VALUES (?, ?, ?, ?, 90000001, ?, ?, -6, ?, 7, ?, ?, ?, ?, ?, ?, 1)")
    .run(h.huntId, h.fleetId, GURISTAS, SYS, h.mode, h.state, JSON.stringify(h.members), NOW - 600000,
      NOW - 590000, h.endedAt === undefined ? null : h.endedAt, h.endReason || null,
      h.losses === undefined ? null : JSON.stringify(h.losses), NOW - 1000);
}

function insertKeys(db, huntId, suffixes) {
  for (const s of suffixes) {
    db.prepare("INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, "
      + "payload, payload_hash, state, created_at, applied_at) VALUES (?, 'APPLY', 'player_hunt', ?, 'TEST', '{}', ?, "
      + "'APPLIED', 1, 1)").run(`phunt:${huntId}:${s}`, huntId, HASH);
  }
}

const member = (key, hullGroup, state) => ({ memberKey: key, hullGroup, typeId: null, state });

function seed(driver, file) {
  seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
  const db = new driver.Database(file);
  try {
    insertFleet(db, "fleet_a", GURISTAS, "patrol", [{ hullGroup: "frigate", typeId: null, count: 3 }], "IDLE");
    insertFleet(db, "fleet_b", GURISTAS, "patrol", [{ hullGroup: "cruiser", typeId: null, count: 2 },
      { hullGroup: "ewar", typeId: null, count: 1 }], "IDLE");
    insertFleet(db, "fleet_c", GURISTAS, "hunter", [{ hullGroup: "frigate", typeId: null, count: 2 }], "IDLE");
    insertFleet(db, "fleet_d", AMARR, "patrol", [{ hullGroup: "frigate", typeId: null, count: 12 }], "IDLE");
    insertFleet(db, "fleet_m", GURISTAS, "garrison", [{ hullGroup: "frigate", typeId: null, count: 2 }],
      "MATERIALIZED");
    insertFleet(db, "fleet_e", GURISTAS, "garrison", [{ hullGroup: "frigate", typeId: null, count: 2 }], "IDLE");
    insertFleet(db, "fleet_x", GURISTAS, "garrison", [{ hullGroup: "frigate", typeId: null, count: 1 }], "IDLE");
    insertHunt(db, { huntId: "ph:fleet_m:3", fleetId: "fleet_m", mode: "SWEEP", state: "LIVE",
      members: [member("m1", "frigate", "SPAWNED"), member("m2", "frigate", "SPAWNED")] });
    insertKeys(db, "ph:fleet_m:3", ["claim", "lock", "live"]);
    insertHunt(db, { huntId: "ph:fleet_e:5", fleetId: "fleet_e", mode: "SCAN", state: "ENDED", endedAt: NOW - 5000,
      endReason: "TARGET_GONE", losses: [{ hullGroup: "frigate", typeId: null, count: 1 }],
      members: [member("e1", "frigate", "DESTROYED"), member("e2", "frigate", "SPAWNED"),
        member("e3", "frigate", "SPAWNED")] });
    insertKeys(db, "ph:fleet_e:5", ["claim", "lock", "live", "loss:e1", "settle:v1", "losses", "release"]);
    insertHunt(db, { huntId: "ph:fleet_x:2", fleetId: "fleet_x", mode: "SWEEP", state: "ENDED", endedAt: NOW - 9000,
      endReason: "RESTART", losses: [{ hullGroup: "frigate", typeId: null, count: 1 }],
      members: [member("x1", "frigate", "DESTROYED"), member("x2", "frigate", "SPAWNED")] });
    insertKeys(db, "ph:fleet_x:2", ["claim", "lock", "live", "settle:v1", "release"]);
  } finally {
    db.close();
  }
}

function blockOf(lines, id) {
  const at = lines.findIndex((l) => l.startsWith(`- ${id} `));
  if (at === -1) return "";
  const end = lines.findIndex((l, i) => i > at && (l.startsWith("- ") || l === ""));
  return lines.slice(at, end === -1 ? undefined : end).join("\n");
}

function withLockHolder(driver, file, fn) {
  const holder = new driver.Database(file);
  try {
    holder.pragma("locking_mode = EXCLUSIVE");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("COMMIT");
    fn();
  } finally {
    holder.close();
  }
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const name1 = "PHT1 huntState: open/ended hunts, exactly-once check, --system verdicts, candidate systems, read only";
  const name2 = "PHT2 huntState: lock -> 2, --snapshot reads a copy under the lock and removes it, usage -> 1";
  if (!driver.ok) {
    skip(name1, `better-sqlite3 unavailable (${driver.detail})`);
    skip(name2, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test(name1, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hs1-"));
    const file = path.join(tmp, "world.sqlite");
    try {
      seed(driver, file);
      const before = sha256(file);
      const list = fs.readdirSync(tmp).sort();
      const run = (...argv) => {
        const lines = [];
        const code = tool.main({ argv: ["--db", file, ...argv], env: {}, driver, config: CONFIG, now: () => NOW,
          print: (l) => lines.push(l) });
        return { code, lines, text: lines.join("\n") };
      };

      const r = run("--system", String(SYS));
      assert.strictEqual(r.code, tool.EXIT.OK, r.text);
      assert.ok(r.lines.includes("Open hunts (CLAIMED/LIVE): 1"), r.text);
      const live = blockOf(r.lines, "ph:fleet_m:3");
      assert.ok(live.includes("state LIVE") && live.includes("Guristas Pirates(500010, pirate)"), live);
      assert.ok(live.includes("SPAWNED 2") && live.includes("fleet now: state MATERIALIZED"), live);
      assert.ok(!live.includes("WARNING") && !live.includes("exactly once"), live);
      const ok = blockOf(r.lines, "ph:fleet_e:5");
      assert.ok(ok.includes("end_reason TARGET_GONE") && ok.includes("exactly once: OK"), ok);
      assert.ok(ok.includes("loss=1 settle:v1=1 losses=1 release=1"), ok);
      assert.ok(ok.includes("start - losses: frigate/-x2 -> matches the current composition"), ok);
      const bad = blockOf(r.lines, "ph:fleet_x:2");
      assert.ok(bad.includes("exactly once: ERROR") && bad.includes("loss keys: 0 != DESTROYED 1")
        && bad.includes("losses key = 0 with losses 1"), bad);
      assert.ok(r.text.indexOf("ph:fleet_e:5") < r.text.indexOf("ph:fleet_x:2"), "recent: newest end first");

      assert.ok(r.text.includes(`Fleets in system ${SYS}: 7`), r.text);
      const verdict = (id) => r.lines[r.lines.findIndex((l) => l.startsWith(`- ${id} `)) + 1];
      assert.match(verdict("fleet_a"), /CANDIDATE mode SWEEP, hunts hostiles \(<= -5\) and neutrals/);
      assert.match(verdict("fleet_b"), /CANDIDATE mode SCAN/);
      assert.match(verdict("fleet_c"), /not hunting: role hunter not in playerHunt\.roles/);
      assert.match(verdict("fleet_d"), /CANDIDATE mode/);
      assert.match(verdict("fleet_m"), /not hunting: state MATERIALIZED/);

      const all = run("--recent", "0");
      assert.strictEqual(all.code, tool.EXIT.OK, all.text);
      assert.ok(all.text.includes("Recently ended (0 of --recent 0); in the table: ENDED=2 LIVE=1"), all.text);
      const scanAt = all.lines.findIndex((l) => l.includes("-> SCAN: 1"));
      const sweepAt = all.lines.findIndex((l) => l.includes("-> SWEEP: 1"));
      assert.ok(scanAt !== -1 && sweepAt > scanAt, all.text);
      assert.ok(all.lines[scanAt + 1].startsWith(`- ${SYS}: fleet_b `), all.text);
      assert.ok(all.lines[sweepAt + 1].includes("fleet_a") && all.lines[sweepAt + 1].includes("fleet_e")
        && all.lines[sweepAt + 1].includes("fleet_d"), all.text);

      assert.strictEqual(sha256(file), before, "huntState must not change the file");
      assert.deepStrictEqual(fs.readdirSync(tmp).sort(), list, "no new side files next to the database");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(name2, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hs2-"));
    const snaps = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hs2s-"));
    const file = path.join(tmp, "world.sqlite");
    try {
      seed(driver, file);
      const lines = [];
      const run = (...argv) => tool.main({ argv: ["--db", file, ...argv], env: {}, driver, config: CONFIG,
        now: () => NOW, tmpDir: snaps, print: (l) => lines.push(l) });
      withLockHolder(driver, file, () => {
        assert.strictEqual(run(), tool.EXIT.REFUSED, lines.join("\n"));
        assert.ok(lines.some((l) => l.startsWith("REFUSED") && l.includes("--snapshot")), lines.join("\n"));
        lines.length = 0;
        assert.strictEqual(run("--snapshot"), tool.EXIT.OK, lines.join("\n"));
        assert.ok(lines.includes("Open hunts (CLAIMED/LIVE): 1"), lines.join("\n"));
      });
      assert.deepStrictEqual(fs.readdirSync(snaps), [], "the snapshot copy is removed");
      assert.strictEqual(run("--system"), tool.EXIT.USAGE);
      assert.strictEqual(run("--recent", "-1"), tool.EXIT.USAGE);
      assert.strictEqual(run("--bogus"), tool.EXIT.USAGE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(snaps, { recursive: true, force: true });
    }
  });
};
