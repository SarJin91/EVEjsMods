"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { createAttackLossRepository } = require("../../lib/strategy/attackLossRepository");
const { createAttackLossConsequence } = require("../../lib/strategy/attackLoss");

const HOUR = 3600000;
const LIMITS = Object.freeze({ attackLossThreshold: 3, attackLossCooldownMs: 6 * HOUR, attackLossWindowMs: 24 * HOUR,
  attackLossMaxMultiplier: 4, maxAttackLossRowsPerFaction: 128 });
const ONE = Object.freeze([{ hullGroup: "frigate", count: 1 }]);
const GUARD = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);

const rowsOf = (env) => env.tx((db) => db.prepare("SELECT faction_id AS f, system_id AS s, losses "
  + "FROM world_faction_attack_losses ORDER BY faction_id, system_id").all()
  .map((r) => ({ f: Number(r.f), s: Number(r.s), losses: Number(r.losses) })));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const opFleet = (env, tag, factionId, type, target, composition = ONE) => {
    const fleetId = H.newFleet(env, tag, factionId, composition);
    const op = env.fleets.createOperation({ operationType: type, factionId, originSystemId: H.S.N0,
      targetSystemId: target, objective: type === "defense" ? "hold" : "destroy", dueAt: H.START_MS + HOUR,
      fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
    assert.ok(op.ok, JSON.stringify(op));
    return fleetId;
  };
  const scene = (reopen) => {
    const shared = H.sharedOf();
    const env = H.boot(reopen(), shared);
    env.now = () => shared.clock.now();
    const repo = createAttackLossRepository({ journal: env.journal, limits: LIMITS });
    const registry = { getFaction: () => ({ allies: [] }), isActive: () => true };
    const c = createAttackLossConsequence({ attackLossRepository: repo, fleetRepository: env.fleets.repository,
      registry });
    return { env, c };
  };
  const settledOf = (winnerSide, a, b, systemId = H.S.N5) => ({ systemId, at: H.START_MS + HOUR, winnerSide,
    sides: { A: { factionId: H.FACTION_A }, B: { factionId: H.FACTION_B } },
    fleets: [...a.map((fleetId) => ({ fleetId, side: "A", factionId: H.FACTION_A, disposition: "DESTROYED" })),
      ...b.map((fleetId) => ({ fleetId, side: "B", factionId: H.FACTION_B, disposition: "STAY" }))] });

  needsDriver("AC1 B_WIN, A with a reinforce operation on the battle system -> recorded 1, one row losses 1", () =>
    H.withStore(driver, async (reopen) => {
      const { env, c } = scene(reopen);
      const a = opFleet(env, "ac1a", H.FACTION_A, "reinforce", H.S.N5);
      const a2 = opFleet(env, "ac1b", H.FACTION_A, "reinforce", H.S.N5);
      const b = H.newFleet(env, "ac1g", H.FACTION_B, GUARD);
      const r = env.tx((db) => c.apply(db, settledOf("B", [a, a2], [b]), "battle:ac1:settle:v1"));
      assert.deepStrictEqual(r, { ok: true, recorded: 1, skipped: 0 });
      assert.deepStrictEqual(rowsOf(env), [{ f: H.FACTION_A, s: H.S.N5, losses: 1 }], "one battle = +1");
      const again = env.tx((db) => c.apply(db, settledOf("B", [a, a2], [b]), "battle:ac1:settle:v1"));
      assert.deepStrictEqual([again, rowsOf(env)[0].losses], [{ ok: true, recorded: 0, skipped: 0 }, 1], "replay");
    }));

  needsDriver("AC2 A_WIN (side B without a raid) and DRAW -> no write", () =>
    H.withStore(driver, async (reopen) => {
      const { env, c } = scene(reopen);
      const a = opFleet(env, "ac2a", H.FACTION_A, "raid", H.S.N5);
      const b = H.newFleet(env, "ac2g", H.FACTION_B, GUARD);
      const none = { ok: true, recorded: 0, skipped: 0 };
      assert.deepStrictEqual(env.tx((db) => c.apply(db, settledOf("A", [a], [b]), "battle:ac2a:settle:v1")), none);
      assert.deepStrictEqual(env.tx((db) => c.apply(db, settledOf(null, [a], [b]), "battle:ac2b:settle:v1")), none);
      assert.deepStrictEqual(rowsOf(env), []);
    }));

  needsDriver("AC3 a defense operation on the system, or a raid on another system -> no write", () =>
    H.withStore(driver, async (reopen) => {
      const { env, c } = scene(reopen);
      const d = opFleet(env, "ac3d", H.FACTION_A, "defense", H.S.N5);
      const elsewhere = opFleet(env, "ac3r", H.FACTION_A, "raid", H.S.N9);
      const b = H.newFleet(env, "ac3g", H.FACTION_B, GUARD);
      const none = { ok: true, recorded: 0, skipped: 0 };
      assert.deepStrictEqual(env.tx((db) => c.apply(db, settledOf("B", [d], [b]), "battle:ac3a:settle:v1")), none);
      assert.deepStrictEqual(env.tx((db) => c.apply(db, settledOf("B", [elsewhere], [b]), "battle:ac3b:settle:v1")),
        none);
      assert.deepStrictEqual(rowsOf(env), []);
    }));

  needsDriver("AC4 a fleet DESTROYED by a real settlement keeps operationId and is counted", () =>
    H.withStore(driver, async (reopen) => {
      const { env, c } = scene(reopen);
      env.settlement = env.makeSettlement({ consequences: [] });
      const dead = opFleet(env, "ac4a", H.FACTION_A, "gank", H.S.N5);
      const guard = H.newFleet(env, "ac4g", H.FACTION_B, GUARD);
      const battle = H.battleOfFleets(env, "ac4", [dead], [guard]);
      const result = H.resultFor(battle.input, "B_WIN", { [dead]: (e) => ({ d: e.count, e: 0 }) });
      const out = H.settleIn(env, env.settlement, battle, result);
      assert.strictEqual(out.outcome, "COMPLETED", JSON.stringify(out));
      const row = env.tx((db) => env.fleets.repository.getFleets(db, [dead])).fleets[0];
      assert.deepStrictEqual([row.state, typeof row.operationId], ["DESTROYED", "string"]);
      const r = env.tx((db) => c.apply(db, settledOf("B", [dead], [guard], battle.systemId), "battle:ac4:settle:v1"));
      assert.deepStrictEqual(r, { ok: true, recorded: 1, skipped: 0 });
      assert.deepStrictEqual(rowsOf(env), [{ f: H.FACTION_A, s: battle.systemId, losses: 1 }]);
    }));
};
