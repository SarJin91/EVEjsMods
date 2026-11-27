"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { createAttackLossRepository } = require("../../lib/strategy/attackLossRepository");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const COOLDOWN = 6 * HOUR;
const WINDOW = 24 * HOUR;
const LIMITS = Object.freeze({ attackLossThreshold: 3, attackLossCooldownMs: COOLDOWN, attackLossWindowMs: WINDOW,
  attackLossMaxMultiplier: 4, maxAttackLossRowsPerFaction: 128 });

const rowsOf = (env) => env.tx((db) => db.prepare("SELECT faction_id AS f, system_id AS s, losses, "
  + "last_loss_at AS last, cooldown_until AS until FROM world_faction_attack_losses ORDER BY faction_id, system_id")
  .all().map((r) => ({ f: Number(r.f), s: Number(r.s), losses: Number(r.losses), last: Number(r.last),
    until: Number(r.until) })));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const envOf = (reopen) => H.boot(reopen(), H.sharedOf());
  const recOf = (env, repo) => (f, s, at, key) => env.tx((db) => repo.recordLossInTx(db, { factionId: f, systemId: s,
    at, lostAttacks: 1 }, key));

  needsDriver("AR1 threshold 3: losses 1, 2 without a cooldown, 3rd -> last + 6 h, 4th -> last + 12 h; facade", () =>
    H.withStore(driver, async (reopen) => {
      const env = envOf(reopen);
      const counts = [];
      const repo = createAttackLossRepository({ journal: env.journal, limits: LIMITS,
        onCount: (name) => counts.push(name) });
      assert.deepStrictEqual(Object.keys(repo), ["recordLossInTx", "listActive", "limits"]);
      const rec = recOf(env, repo);
      const t = H.START_MS;
      const out = [1, 2, 3, 4].map((n) => rec(H.FACTION_A, H.S.N5, t + n * HOUR, `a:${n}`).record);
      assert.deepStrictEqual(out, [
        { losses: 1, lastLossAt: t + HOUR, cooldownUntil: 0 },
        { losses: 2, lastLossAt: t + 2 * HOUR, cooldownUntil: 0 },
        { losses: 3, lastLossAt: t + 3 * HOUR, cooldownUntil: t + 3 * HOUR + COOLDOWN },
        { losses: 4, lastLossAt: t + 4 * HOUR, cooldownUntil: t + 4 * HOUR + 2 * COOLDOWN }]);
      assert.deepStrictEqual([counts.filter((n) => n === "strategy.attackLoss.recorded").length,
        counts.filter((n) => n === "strategy.attackLoss.cooldowns").length], [4, 2]);
      assert.strictEqual(env.tx((db) => repo.recordLossInTx(db, { factionId: 1, systemId: 1, at: 0, lostAttacks: 0 },
        "x")).reason, "INVALID_INPUT");
    }));

  needsDriver("AR2 replay of a key -> duplicate, losses not doubled", () =>
    H.withStore(driver, async (reopen) => {
      const env = envOf(reopen);
      const rec = recOf(env, createAttackLossRepository({ journal: env.journal, limits: LIMITS }));
      rec(H.FACTION_A, H.S.N5, H.START_MS, "d:1");
      const before = rowsOf(env);
      const again = rec(H.FACTION_A, H.S.N5, H.START_MS, "d:1");
      assert.deepStrictEqual([again.ok, again.duplicate, again.evicted, again.record.losses], [true, true, 0, 1]);
      assert.deepStrictEqual(rowsOf(env), before);
    }));

  needsDriver("AR3 limit 2 rows: the dead row evicted; no dead row -> ATTACK_LOSS_LIMIT, rows unchanged", () =>
    H.withStore(driver, async (reopen) => {
      const env = envOf(reopen);
      const counts = [];
      const rec = recOf(env, createAttackLossRepository({ journal: env.journal,
        limits: { ...LIMITS, maxAttackLossRowsPerFaction: 2 }, onCount: (name) => counts.push(name) }));
      const t = H.START_MS;
      const late = t + 2 * WINDOW;
      rec(H.FACTION_B, H.S.N6, t, "l:1");
      rec(H.FACTION_B, H.S.N7, late, "l:2");
      const evict = rec(H.FACTION_B, H.S.N9, late, "l:3");
      assert.deepStrictEqual([evict.ok, evict.evicted], [true, 1]);
      assert.deepStrictEqual(rowsOf(env).map((r) => r.s), [H.S.N7, H.S.N9]);
      const full = rec(H.FACTION_B, H.S.N10, late, "l:4");
      assert.deepStrictEqual([full.ok, full.reason], [false, "ATTACK_LOSS_LIMIT"]);
      assert.deepStrictEqual(rowsOf(env).map((r) => r.s), [H.S.N7, H.S.N9]);
      assert.deepStrictEqual([counts.filter((n) => n === "strategy.attackLoss.evicted").length,
        counts.filter((n) => n === "strategy.attackLoss.limit").length], [1, 1]);
    }));

  needsDriver("AR4 listActive: in the window without a cooldown and on a cooldown listed, a dead row not", () =>
    H.withStore(driver, async (reopen) => {
      const env = envOf(reopen);
      const repo = createAttackLossRepository({ journal: env.journal, limits: LIMITS });
      const rec = recOf(env, repo);
      const t = H.START_MS;
      const now = t + 3 * WINDOW;
      rec(H.FACTION_A, H.S.N6, t, "w:dead");
      for (const n of [1, 2, 3]) rec(H.FACTION_A, H.S.N7, now - n * HOUR, `w:cd:${n}`);
      rec(H.FACTION_A, H.S.N9, now - HOUR, "w:win");
      const list = env.tx((db) => repo.listActive(db, H.FACTION_A, now, 128));
      assert.deepStrictEqual(list, { ok: true, records: [
        { systemId: H.S.N7, losses: 3, lastLossAt: now - HOUR, cooldownUntil: now - HOUR + COOLDOWN },
        { systemId: H.S.N9, losses: 1, lastLossAt: now - HOUR, cooldownUntil: 0 }] });
      assert.deepStrictEqual(env.tx((db) => repo.listActive(db, H.FACTION_B, now, 128)), { ok: true, records: [] });
      assert.strictEqual(env.tx((db) => repo.listActive(db, H.FACTION_A, now, 0)).reason, "INVALID_INPUT");
    }));

  needsDriver("AR5 row changes of a write with an eviction <= strategy.attackLossSettleRows (default)", () =>
    H.withStore(driver, async (reopen) => {
      const r0 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
      const reserve = r0.config.strategy.attackLossSettleRows;
      const env = envOf(reopen);
      const repo = createAttackLossRepository({ journal: env.journal,
        limits: { ...LIMITS, maxAttackLossRowsPerFaction: 1 } });
      const rec = recOf(env, repo);
      rec(H.FACTION_A, H.S.N6, H.START_MS, "r:1");
      const changes = env.tx((db) => {
        const before = Number(db.prepare("SELECT total_changes() AS n").get().n);
        const r = repo.recordLossInTx(db, { factionId: H.FACTION_A, systemId: H.S.N7, at: H.START_MS + 2 * WINDOW,
          lostAttacks: 1 }, "r:2");
        assert.deepStrictEqual([r.ok, r.evicted], [true, 1], JSON.stringify(r));
        return Number(db.prepare("SELECT total_changes() AS n").get().n) - before;
      });
      assert.ok(changes >= 3 && changes <= reserve, `${changes} rows > ${reserve}`);
    }));
};
