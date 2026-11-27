"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createRattingService } = require("../../lib/strategy/capsuleers/rattingService");
const { harness: L } = require("./liberation.test");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const POINTS = Object.freeze({ EVEJS_LNE_LIBERATION_KILL_INFLUENCE_POINTS: "2.5" });
const PACING_ON = Object.freeze({ ...POINTS, EVEJS_LNE_LIBERATION_VIRTUAL_KILL_PACING_ENABLED: "1" });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const { S, FACTION_A, FACTION_B } = H;

  const killOnce = (envOver, extra) => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = L.bootLib(reopen(), shared, L.fakeStations([]), envOver);
    L.seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60, [FACTION_A]: 20 });
    const kill = { characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: shared.clock.now(), ...extra };
    const r = env.liberation.onNpcKill(kill);
    const again = env.liberation.onNpcKill(kill);
    return { r, again, score: L.scoreOf(L.systemOf(env, S.N5), FACTION_B),
      counters: env.liberation.getStatus().counters, config: env.config };
  });

  needsDriver("T1 pacing on: a virtual kill drops 0.75 (2.5 x 300 permille), virtualKillsScaled 1, redelivery "
    + "DUPLICATE", async () => {
    const o = await killOnce(PACING_ON, { virtual: true });
    assert.deepStrictEqual([o.r.ok, o.r.outcome, o.r.nextScore, o.again.outcome, o.score],
      [true, "APPLIED", 59.25, "DUPLICATE", 59.25], JSON.stringify(o.r));
    assert.deepStrictEqual([o.counters.applied, o.counters.duplicates, o.counters.virtualKillsScaled], [1, 1, 1]);
  });

  needsDriver("T2 pacing off (default): a virtual kill drops the full 2.5, no scaled counter", async () => {
    const o = await killOnce(POINTS, { virtual: true });
    assert.deepStrictEqual([o.config.liberation.virtualKillPacingEnabled,
      o.config.liberation.virtualKillInfluencePermille], [false, 300], "the defaults of the brief");
    assert.deepStrictEqual([o.r.outcome, o.r.nextScore, o.score, o.counters.virtualKillsScaled],
      ["APPLIED", 57.5, 57.5, 0], JSON.stringify(o.r));
  });

  needsDriver("T3 pacing on: a kill without `virtual` (player, vendor seam) drops the full 2.5", async () => {
    const o = await killOnce(PACING_ON, { rewardable: true });
    assert.deepStrictEqual([o.r.outcome, o.r.nextScore, o.score, o.counters.virtualKillsScaled],
      ["APPLIED", 57.5, 57.5, 0], JSON.stringify(o.r));
  });

  test("T4 rattingService.reportKills passes virtual:true to liberation.onNpcKill", () => {
    const cfg = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const seen = [];
    const svc = createRattingService({ config: cfg, clock: { now: () => 0 }, nowMs: () => 0,
      getLiberation: () => ({ onNpcKill: (k) => {
        seen.push(k);
        return { ok: true, outcome: "APPLIED" };
      } }) });
    const h = svc.handler({ payload: { tripId: "trip:1", phaseSeq: 0, round: 0 }, idempotencyKey: "cps:step" });
    assert.strictEqual(h.ok, true, JSON.stringify(h));
    const kill = { characterId: 90000001, victimFactionId: 500019, systemId: S.N0, atMs: 1000, victimId: 5 };
    h.onCommitted({ ok: true, action: "NONE", kills: [kill] });
    assert.deepStrictEqual(seen, [{ ...kill, virtual: true }]);
    assert.strictEqual(svc.getStatus().counters.killsApplied, 1);
  });
};
