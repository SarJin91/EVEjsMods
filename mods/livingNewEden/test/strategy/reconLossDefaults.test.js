"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");
const { createReconLossRepository } = require("../../lib/strategy/reconLossRepository");
const { createPlayerActivityRepository } = require("../../lib/strategy/playerActivityRepository");
const { resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
const windowWarnings = (r) => (r.warnings || []).filter((w) => w.startsWith("strategy.reconLossWindowMs="));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("RL4a config: default window 604800000; no window warning at defaults nor at a 1 h window", () => {
    const d = resolve({});
    assert.deepStrictEqual(d.errors || [], []);
    assert.strictEqual(d.config.strategy.reconLossWindowMs, 604800000);
    assert.deepStrictEqual(windowWarnings(d), []);
    assert.deepStrictEqual(windowWarnings(resolve({ EVEJS_LNE_STRATEGY_RECON_LOSS_WINDOW_MS: String(HOUR) })), []);
  });

  needsDriver("RL4b defaults: losses 24 h after each cooldown -> 72 / 144 / 216 / 288 h, the 6th stays at "
    + "288 h; a loss after cooldownUntil + window + 1 -> new series, next loss 72 h", () =>
    H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    const S = resolve({}).config.strategy;
    const limits = { reconLossThreshold: S.reconLossThreshold, reconLossCooldownMs: S.reconLossCooldownMs,
      reconLossWindowMs: S.reconLossWindowMs, reconLossMaxMultiplier: S.reconLossMaxMultiplier,
      maxReconLossRowsPerFaction: S.maxReconLossRowsPerFaction };
    const repo = createReconLossRepository({ journal: env.journal, limits });
    const rec = (at, n) => {
      const r = env.tx((db) => repo.recordLossInTx(db, { factionId: H.FACTION_A, systemId: H.S.N5, at,
        lostFleets: 1 }, `rl4:${n}`));
      assert.ok(r.ok, JSON.stringify(r));
      return r.record;
    };
    let last = rec(H.START_MS, 1);
    last = rec(H.START_MS + HOUR, 2);
    const cooldowns = [(last.cooldownUntil - last.lastLossAt) / HOUR];
    for (let n = 3; n <= 6; n += 1) {
      last = rec(last.cooldownUntil + 24 * HOUR, n);
      cooldowns.push((last.cooldownUntil - last.lastLossAt) / HOUR);
    }
    assert.deepStrictEqual(cooldowns, [72, 144, 216, 288, 288]);
    assert.strictEqual(last.losses, 6);
    const until = last.cooldownUntil;
    const reset = rec(until + S.reconLossWindowMs + 1, 7);
    assert.deepStrictEqual(reset, { losses: 1, lastLossAt: until + S.reconLossWindowMs + 1, cooldownUntil: until });
    const next = rec(reset.lastLossAt + HOUR, 8);
    assert.deepStrictEqual([next.losses, (next.cooldownUntil - next.lastLossAt) / HOUR], [2, 72]);
  }));

  needsDriver("RL5 real review: snapshot.reconCooldowns holds the cooldown target with reconLossEnabled, the "
    + "field is absent without it", async () => {
    const run = (enabled) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(59) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, null])) };
      const seen = [];
      const hooks = { beforeEffect: (d, snapshot) => {
        if (d.factionId === R.SANSHA) seen.push(snapshot);
        return d;
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA),
        EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
        EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
        EVEJS_LNE_STRATEGY_RECON_LOSS_ENABLED: enabled ? "1" : "0",
        EVEJS_LNE_STRATEGY_PLAYER_ACTIVITY_ENABLED: enabled ? "1" : "0" }, { hooks });
      const S = e.config.strategy;
      const repo = createReconLossRepository({ journal: e.journal, limits: { reconLossThreshold: 1,
        reconLossCooldownMs: S.reconLossCooldownMs, reconLossWindowMs: S.reconLossWindowMs,
        reconLossMaxMultiplier: S.reconLossMaxMultiplier, maxReconLossRowsPerFaction: S.maxReconLossRowsPerFaction } });
      const target = R.THEATRE[0];
      const r = e.tx((db) => repo.recordLossInTx(db, { factionId: R.SANSHA, systemId: target, at: R.START_MS,
        lostFleets: 1 }, "rl5:1"));
      assert.ok(r.ok && r.record.cooldownUntil > R.START_MS + R.I, JSON.stringify(r));
      const pa = createPlayerActivityRepository({ limits: { playerActivityWindowMs: S.playerActivityWindowMs,
        playerActivityMaxKills: S.playerActivityMaxKills,
        maxPlayerActivityRowsPerFaction: S.maxPlayerActivityRowsPerFaction } });
      const p = e.tx((db) => pa.recordKillInTx(db, { factionId: R.SANSHA, systemId: target, at: R.START_MS,
        victimId: 1 }));
      assert.ok(p.ok, JSON.stringify(p));
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      assert.ok(seen.length >= 1, "no review of Sansha");
      return { target, snapshot: seen[0] };
    });
    const on = await run(true);
    assert.deepStrictEqual(on.snapshot.reconCooldowns, [on.target]);
    assert.deepStrictEqual(on.snapshot.playerActivity, [{ systemId: on.target, kills: 1 }], "With the flag");
    const off = await run(false);
    assert.ok(!Object.prototype.hasOwnProperty.call(off.snapshot, "reconCooldowns"),
      JSON.stringify(off.snapshot.reconCooldowns));
    assert.ok(!Object.prototype.hasOwnProperty.call(off.snapshot, "playerActivity"),
      JSON.stringify(off.snapshot.playerActivity));
  });
};
