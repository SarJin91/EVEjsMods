"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createBountyService } = require("../../lib/bounty/service");
const { createJournal } = require("../../lib/persistence/journal");
const R = require("../../lib/bounty/repository");
const RR = require("../../lib/bounty/revengeRepository");
const S = require("../../lib/bounty/schema");
const { decideRevengeStart } = require("../../lib/bounty/revengePolicy");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const HOUR = 3600000;
const FACTION = 500010;
const KILLER = 42;
const EXCLUDED_REGION = 10000099;

let base = null;
function settings(over = {}) {
  if (!base) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config.bountyHunters;
  }
  return { ...base, enabled: true, liveEnabled: true, revengeEnabled: true, liveSpawnsPerPass: 4, ...over };
}

function line() {
  return {
    getSystem: (id) => (Number.isInteger(id) && id >= 1 && id <= 10 ? { id, secClass: id === 10 ? "highsec" : "lowsec",
      regionId: 10000001, constellationId: 20000001 } : null),
    getNeighbors: (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 10),
    getSystemIds: () => Array.from({ length: 10 }, (_v, i) => i + 1),
    findRoute: (a, b, c) => {
      const jumps = Math.abs(a - b);
      return c && Number.isInteger(c.maxJumps) && jumps > c.maxJumps ? { ok: false, reason: "UNREACHABLE" }
        : { ok: true, jumps };
    },
  };
}

function fakeScene() {
  let next = 5000000000;
  const s = { bossOf: new Map(), versionOf: new Map(), alive: new Set() };
  Object.assign(s, {
    isSceneLoaded: () => true,
    spawnGroup(spec) {
      const bossId = spec.boss ? (next += 1) : null;
      const escortIds = spec.escorts.map(() => (next += 1));
      for (const id of [bossId, ...escortIds]) if (id) s.alive.add(id);
      if (bossId) s.bossOf.set(spec.seedKey, bossId);
      return { ok: true, bossId, escortIds, anchorPoint: { x: 0, y: 0, z: 0 } };
    },
    readAggression: (_sys, ids) => ({ ok: true, ships: ids.map((entityId) => ({ entityId, alive: s.alive.has(entityId),
      aggressorId: null, inWarp: false })) }),
    warpOff: (_sys, ids) => ({ ok: true, ordered: ids.slice(), gone: [], failed: [] }),
    orderAttack: () => ({ ok: true }),
    despawn(_sys, ids) {
      for (const id of ids) s.alive.delete(id);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listAlive: (_sys, ids) => ids.filter((id) => s.alive.has(id)),
    markShips(ids, o) {
      if (o.role === "boss") s.versionOf.set(o.wantedId, o.version);
      return { ok: true, marked: ids.length, evicted: 0 };
    },
    forgetShips: (ids) => ({ ok: true, forgotten: ids.length }),
  });
  return s;
}

function fakePresence() {
  const p = { chars: new Map(), space: new Map() };
  p.observedSystems = () => [...new Set([...p.space.keys(), ...[...p.chars.values()].map((c) => c.systemId)])];
  p.getSystemPresence = (id) => ({ systemId: id, space: p.space.get(id) || 0, docked: 0, transit: 0,
    characters: [...p.chars].filter(([, c]) => c.systemId === id).map(([characterId, c]) => ({ characterId,
      state: c.state })) });
  return p;
}

let slotSeq = 0;
function seed(opened, rows) {
  const r = opened.store.transaction("rv.seed", (tx) => rows.map((row) => {
    slotSeq += 1;
    const made = R.createInTx(tx, { slot: slotSeq, cycle: 1, factionId: FACTION, characterId: 91000000 + slotSeq,
      level: 4, archetype: "BRAWLER", smuggler: 0, nextMoveAt: T0 + 10 * HOUR, expiresAt: T0 + 24 * HOUR,
      rewardIsk: 3000000, seed: 77 + slotSeq, ...row }, T0);
    assert.ok(made.ok, JSON.stringify(made));
    return made.target;
  }));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const sql = (opened, text, ...args) => {
  const r = opened.store.transaction("rv.sql", (db) => db.prepare(text).all(...args).map((x) => ({ ...x })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const exec = (opened, text, ...args) => {
  const r = opened.store.transaction("rv.exec", (db) => Number(db.prepare(text).run(...args).changes));
  assert.ok(r.ok && r.value === 1, JSON.stringify(r));
};

function rig(opened, P, at = T0) {
  const scene = fakeScene();
  const presence = fakePresence();
  const g = line();
  const changes = [];
  const store = { ...opened.store, transaction(name, fn) {
    return opened.store.transaction(name, (tx) => {
      const before = tx.prepare("SELECT total_changes() AS n").get().n;
      const value = fn(tx);
      changes.push([name, tx.prepare("SELECT total_changes() AS n").get().n - before]);
      return value;
    });
  } };
  const journal = createJournal({ clock: { now: () => at }, maxPayloadBytes: 4096, maxRows: 500 });
  const lines = [];
  const svc = createBountyService({ store, worldSeed: 7, logger: { log: (l) => lines.push(l) }, settings: P, factionIds: [FACTION], levels: LEVELS,
    getGraph: () => g, getVirtualCorps: () => null, journal, excludedRegionIds: [EXCLUDED_REGION],
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }), bloodlinesOf: () => [1],
    ownerCharacterBudget: 2048, systemFactionsOf: (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId,
      factionId: FACTION })) }), getPresence: () => presence, getBountyScene: () => scene,
    characterNameOf: () => "Viper" });
  assert.strictEqual(svc.boot(at).ok, true);
  const pass = (t) => {
    const r = svc.runPass(t);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    return r;
  };
  const kill = (target, killer, t) => svc.onNpcKill({ characterId: killer, victimId: scene.bossOf.get(target.wantedId),
    wantedId: target.wantedId, version: scene.versionOf.get(target.wantedId), role: "boss",
    systemId: target.systemId, atMs: t }, t);
  return { svc, presence, changes, pass, kill, lines };
}

function revengeRow(opened, wantedId, characterId, killedAt, over = {}) {
  const P = settings();
  const r = opened.store.transaction("rv.rev", (tx) => RR.createRevengeInTx(tx, { wantedId, characterId,
    factionId: FACTION, gangId: 1, bossCharacterId: 91000001, targetLevel: 4, killSystemId: 3, killedAt, seed: 5,
    delayMs: P.revengeDelayMs, windowMs: P.revengeWindowMs, ...over }, killedAt));
  assert.ok(r.ok && r.value.ok && r.value.created, JSON.stringify(r));
  return r.value.revenge;
}

module.exports = ({ test, skip }) => {
  test("R4 decideRevengeStart: NOT_DUE, NOT_IN_SPACE (docked / transit), SEC_CLASS, EXCLUDED_REGION, TOO_FAR, "
    + "GRAPH_NOT_READY, ready with jumps", () => {
    const row = { dueAt: 1000, expiresAt: 5000 };
    const params = { maxJumps: 5, excludedRegions: new Set([EXCLUDED_REGION]) };
    const ok = { now: 2000, located: { systemId: 7, state: "space" }, system: { secClass: "nullsec", regionId: 1 },
      route: { ok: true, jumps: 5 }, capsule: null };
    const why = (over) => {
      const d = decideRevengeStart(row, { ...ok, ...over }, params);
      return d.ready ? "ready" : d.reason;
    };
    assert.deepStrictEqual([why({ now: 999 }), why({ now: 5000 }), why({ located: null }),
      why({ located: { systemId: 7, state: "docked" } }), why({ located: { systemId: 7, state: "transit" } }),
      why({ system: { secClass: "highsec", regionId: 1 } }), why({ system: { secClass: "wormhole", regionId: 1 } }),
      why({ system: { secClass: "lowsec", regionId: EXCLUDED_REGION } }), why({ route: { ok: true, jumps: 6 } }),
      why({ route: { ok: false, reason: "UNREACHABLE" } }), why({ route: null }), why({ system: null }),
      why({ capsule: true })],
    ["NOT_DUE", "EXPIRED", "NOT_LOCATED", "NOT_IN_SPACE", "NOT_IN_SPACE", "SEC_CLASS", "SEC_CLASS", "EXCLUDED_REGION",
      "TOO_FAR", "TOO_FAR", "GRAPH_NOT_READY", "GRAPH_NOT_READY", "CAPSULE"]);
    assert.deepStrictEqual(decideRevengeStart(row, ok, params), { ready: true, systemId: 7, jumps: 5 });
    assert.deepStrictEqual(decideRevengeStart(row, { ...ok, route: { ok: true, jumps: 0 } }, params),
      { ready: true, systemId: 7, jumps: 0 }, "the kill system itself");
  });

  test("R5 config: defaults, clamp, W-B4 window within the delay", () => {
    const P = settings({});
    assert.deepStrictEqual([base.revengeEnabled, base.revengeMinLevel, base.revengeDelayMs, base.revengeWindowMs,
      base.revengeMaxJumps, base.revengeChecksPerPass, base.revengeCheckEveryMs],
    [false, 4, 14400000, 172800000, 5, 8, 30000]);
    assert.strictEqual(P.revengeEnabled, true);
    const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_BOUNTY_ENABLED: "1", EVEJS_LNE_BOUNTY_REVENGE_ENABLED: "1",
      EVEJS_LNE_BOUNTY_REVENGE_MIN_LEVEL: "1", EVEJS_LNE_BOUNTY_REVENGE_MAX_JUMPS: "99",
      EVEJS_LNE_BOUNTY_REVENGE_WINDOW_MS: "3600000", EVEJS_LNE_BOUNTY_REVENGE_DELAY_MS: "7200000" };
    const r = config.resolveConfig({ modDir: MOD_DIR, env });
    assert.deepStrictEqual(r.errors || [], []);
    const bh = r.config.bountyHunters;
    assert.deepStrictEqual([bh.revengeEnabled, bh.revengeMinLevel, bh.revengeMaxJumps], [true, 2, 15]);
    assert.strictEqual(r.warnings.filter((w) => w.includes("revenge never starts")).length, 1, r.warnings.join("; "));
    const quiet = config.resolveConfig({ modDir: MOD_DIR, env: { ...env, EVEJS_LNE_BOUNTY_REVENGE_ENABLED: "0" } });
    assert.strictEqual(quiet.warnings.filter((w) => w.includes("revenge never starts")).length, 0);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("R1/R2/R3 bounty revenge on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("R1 migration 109: world_bounty_revenge columns + 2 indexes on a fresh base; WIPE in the world reset map", () => {
    withStore(driver, (opened) => {
      const cols = sql(opened, "PRAGMA table_info(world_bounty_revenge)").map((c) => c.name);
      assert.deepStrictEqual(cols, ["revenge_id", "wanted_id", "character_id", "faction_id", "gang_id",
        "boss_character_id", "target_level", "hunter_level", "kill_system_id", "state", "system_id", "commander_id",
        "attempts", "due_at", "expires_at", "end_reason", "seed", "killed_at", "live_at", "ended_at", "created_at",
        "updated_at", "version", "nemesis_id"], "nemesis_id (migration 116)");
      const idx = sql(opened, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL"
        + " ORDER BY name", S.REVENGE_TABLE).map((x) => x.name);
      assert.deepStrictEqual(idx, ["idx_bounty_revenge_character", "idx_bounty_revenge_nemesis",
        "idx_bounty_revenge_state"]);
      assert.deepStrictEqual(MIGRATIONS.filter((m) => m.version === 109).map((m) => [m.name, m.up]),
        [["bounty_revenge", S.upBountyRevenge]]);
    }, { fresh: true });
    assert.strictEqual(TABLE_POLICY.world_bounty_revenge, ACTION.WIPE);
  });

  test("R2 kill L4 -> one WAITING revenge + journal bnty:rev:, replay no-op, L3 none, second L4 of the killer "
    + "skipped (kill + payout kept); flag off -> kill transaction changes as before", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const [a, b, c] = seed(opened, [{ systemId: 3, level: 4, slot: 7 }, { systemId: 4, level: 3 },
        { systemId: 5, level: 4 }]);
      const { svc, presence, changes, pass, kill, lines } = rig(opened, P);
      for (const s of [3, 4, 5]) presence.space.set(s, 1);
      pass(T0 + 1000);
      const at = T0 + 5000;
      assert.deepStrictEqual(kill(a, KILLER, at), { ok: true, outcome: "KILLED" });
      assert.deepStrictEqual(changes[changes.length - 1], ["bounty.kill", 5],
        `kill + payout + 2 journal + revenge; ${lines.join(" | ")}`);
      const rows = sql(opened, "SELECT * FROM world_bounty_revenge");
      assert.strictEqual(rows.length, 1);
      const [row] = rows;
      assert.deepStrictEqual([row.revenge_id, row.wanted_id, row.character_id, row.state, row.target_level,
        row.hunter_level, row.gang_id, row.kill_system_id, row.due_at, row.expires_at, row.killed_at, row.attempts],
      [`rev:${a.wantedId}`, a.wantedId, KILLER, "WAITING", 4, 3, 2, 3, at + P.revengeDelayMs, at + P.revengeWindowMs,
        at, 0]);
      const keys = sql(opened, "SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE "
        + "'bnty:rev:%'").map((x) => x.k);
      assert.deepStrictEqual(keys, [`bnty:rev:${a.wantedId}`]);
      assert.deepStrictEqual(kill(a, KILLER, at + 1000), { ok: true, outcome: "NOOP" });
      const again = opened.store.transaction("rv.again", (tx) => RR.createRevengeInTx(tx, { wantedId: a.wantedId,
        characterId: 77, factionId: FACTION, gangId: 2, bossCharacterId: a.characterId, targetLevel: 4,
        killSystemId: 3, killedAt: at, seed: 1, delayMs: 0, windowMs: HOUR }, at));
      assert.deepStrictEqual(again.value, { ok: true, created: false, reason: "DUPLICATE" });
      assert.deepStrictEqual(kill(b, KILLER, at + 2000), { ok: true, outcome: "KILLED" });
      assert.deepStrictEqual(kill(c, KILLER, at + 3000), { ok: true, outcome: "KILLED" });
      assert.strictEqual(sql(opened, "SELECT COUNT(*) AS n FROM world_bounty_revenge")[0].n, 1, "L3 none, one open");
      assert.deepStrictEqual(sql(opened, "SELECT state AS s, payout_state AS p FROM world_bounty_targets "
        + "WHERE wanted_id = ?", c.wantedId)[0], { s: "KILLED", p: "PENDING" });
      assert.strictEqual(sql(opened, "SELECT COUNT(*) AS n FROM world_bounty_payouts WHERE wanted_id = ?",
        c.wantedId)[0].n, 1);
      const st = svc.getStatus();
      assert.deepStrictEqual([st.counters.revengeCreated, st.counters.revengeSkippedOpen, st.counters.revengeCreateFailed],
        [1, 1, 0]);
      assert.deepStrictEqual(st.revenge, { open: 1, waiting: 1, live: 0, readyNow: 0, orphans: 0, squads: [] });
      svc.stop();
    });
    withStore(driver, (opened) => {
      const [a] = seed(opened, [{ systemId: 3, level: 4 }]);
      const { svc, presence, changes, pass, kill } = rig(opened, settings({ revengeEnabled: false }));
      presence.space.set(3, 1);
      pass(T0 + 1000);
      const before = changes.length;
      assert.deepStrictEqual(kill(a, KILLER, T0 + 5000), { ok: true, outcome: "KILLED" });
      assert.deepStrictEqual(changes.slice(before), [["bounty.kill", 3]], "kill + payout + claimed journal only");
      assert.strictEqual(sql(opened, "SELECT COUNT(*) AS n FROM world_bounty_revenge")[0].n, 0);
      assert.strictEqual(svc.getStatus().revenge, undefined);
      svc.stop();
    });
  });

  test("R3 pass: WAITING past expires_at -> EXPIRED (WINDOW); boot: LIVE -> WAITING without an attempt; prune of "
    + "old DONE / EXPIRED; ready only in space within maxJumps", () => {
    withStore(driver, (opened) => {
      const P = settings();
      const old = revengeRow(opened, "bnt:90:1", 501, T0 - 3 * 86400000);
      const fresh = revengeRow(opened, "bnt:91:1", 502, T0 - P.revengeDelayMs - 1000);
      revengeRow(opened, "bnt:92:1", 503, T0 - 1000);
      exec(opened, "UPDATE world_bounty_revenge SET state = 'LIVE', attempts = 2, due_at = 5 WHERE wanted_id = ?",
        "bnt:92:1");
      revengeRow(opened, "bnt:93:1", 504, T0 - 20 * 86400000);
      exec(opened, "UPDATE world_bounty_revenge SET state = 'DONE', ended_at = ? WHERE wanted_id = ?",
        T0 - P.retentionMs - 1, "bnt:93:1");
      const { svc, presence, pass } = rig(opened, P);
      const live = sql(opened, "SELECT state, attempts, due_at, version FROM world_bounty_revenge WHERE wanted_id = ?",
        "bnt:92:1")[0];
      assert.deepStrictEqual(live, { state: "WAITING", attempts: 2, due_at: T0, version: 2 });
      assert.strictEqual(svc.getStatus().counters.revengeRecovered, 1);
      presence.chars.set(502, { systemId: 4, state: "docked" });
      pass(T0 + 1000);
      const byId = new Map(sql(opened, "SELECT wanted_id AS w, state AS s, end_reason AS e FROM world_bounty_revenge")
        .map((x) => [x.w, [x.s, x.e]]));
      assert.deepStrictEqual(byId.get(old.wantedId), ["EXPIRED", "WINDOW"]);
      assert.strictEqual(byId.has("bnt:93:1"), false, "pruned");
      let st = svc.getStatus();
      assert.deepStrictEqual([st.counters.revengeExpired, st.counters.revengePruned, st.counters.revengeWaitNotInSpace,
        st.counters.revengeWaitNotLocated], [1, 1, 1, 1]);
      presence.chars.set(502, { systemId: 4, state: "space" });
      pass(T0 + 2000);
      assert.strictEqual(svc.getStatus().counters.revengeReady, 0, "not before revengeCheckEveryMs");
      pass(T0 + 1000 + P.revengeCheckEveryMs);
      st = svc.getStatus();
      assert.deepStrictEqual([st.counters.revengeReady, st.revenge.readyNow], [1, 1]);
      assert.strictEqual(sql(opened, "SELECT state AS s FROM world_bounty_revenge WHERE wanted_id = ?",
        fresh.wantedId)[0].s, "WAITING");
      presence.chars.set(502, { systemId: 9, state: "space" });
      pass(T0 + 1000 + 2 * P.revengeCheckEveryMs);
      st = svc.getStatus();
      assert.deepStrictEqual([st.counters.revengeWaitTooFar, st.revenge.readyNow, st.revenge.open], [1, 0, 2]);
      svc.stop();
    });
  });
};
