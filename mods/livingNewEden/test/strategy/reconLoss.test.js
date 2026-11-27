"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { lazyIntelConsequence } = require("../../lib/battle");
const { startStrategy } = require("../../lib/strategy");
const { createReconLossRepository } = require("../../lib/strategy/reconLossRepository");
const { createReconLossConsequence } = require("../../lib/strategy/reconLoss");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const COOLDOWN = 72 * HOUR;
const WINDOW = 7 * 24 * HOUR;
const LIMITS = Object.freeze({ reconLossThreshold: 2, reconLossCooldownMs: COOLDOWN, reconLossWindowMs: WINDOW,
  reconLossMaxMultiplier: 4, maxReconLossRowsPerFaction: 128 });
const ONE = Object.freeze([{ hullGroup: "frigate", count: 1 }]);
const GUARD = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);

const rowsOf = (env) => env.tx((db) => db.prepare("SELECT faction_id AS f, system_id AS s, losses, "
  + "last_loss_at AS last, cooldown_until AS until FROM world_faction_recon_losses ORDER BY faction_id, system_id")
  .all().map((r) => ({ f: Number(r.f), s: Number(r.s), losses: Number(r.losses), last: Number(r.last),
    until: Number(r.until) })));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const envOf = (reopen) => {
    const shared = H.sharedOf();
    const opened = reopen();
    const env = H.boot(opened, shared);
    env.now = () => shared.clock.now();
    return { env, opened, shared };
  };

  needsDriver("RL1 recon loss series for two factions -> cooldown at2 + cooldownMs; replay of a key -> duplicate, row "
    + "unchanged; a new repository instance on the same db reads the same cooldowns", () =>
    H.withStore(driver, async (reopen) => {
      const { env } = envOf(reopen);
      const counts = [];
      const repo = createReconLossRepository({ journal: env.journal, limits: LIMITS,
        onCount: (name, n) => counts.push([name, n]) });
      assert.deepStrictEqual(Object.keys(repo), ["recordLossInTx", "listCooldowns", "limits"]);
      const at1 = H.START_MS;
      const at2 = at1 + HOUR;
      const rec = (f, s, at, key) => env.tx((db) => repo.recordLossInTx(db, { factionId: f, systemId: s, at,
        lostFleets: 1 }, key));
      for (const [f, s] of [[H.FACTION_A, H.S.N5], [H.FACTION_B, H.S.N6]]) {
        const r1 = rec(f, s, at1, `k:${f}:1`);
        assert.deepStrictEqual(r1, { ok: true, record: { losses: 1, lastLossAt: at1, cooldownUntil: 0 }, evicted: 0 });
        const r2 = rec(f, s, at2, `k:${f}:2`);
        assert.deepStrictEqual(r2, { ok: true, record: { losses: 2, lastLossAt: at2, cooldownUntil: at2 + COOLDOWN },
          evicted: 0 });
      }
      const before = rowsOf(env);
      const again = rec(H.FACTION_A, H.S.N5, at2, `k:${H.FACTION_A}:2`);
      assert.deepStrictEqual([again.ok, again.duplicate, again.evicted], [true, true, 0]);
      assert.deepStrictEqual(rowsOf(env), before);
      assert.deepStrictEqual(counts.filter(([n]) => n === "strategy.reconLoss.cooldowns").length, 2);
      assert.deepStrictEqual(counts.filter(([n]) => n === "strategy.reconLoss.recorded").length, 4);

      const fresh = createReconLossRepository({ journal: env.journal, limits: LIMITS });
      const list = (f, at) => env.tx((db) => fresh.listCooldowns(db, f, at, 128));
      assert.deepStrictEqual(list(H.FACTION_A, at2), { ok: true, systemIds: [H.S.N5] });
      assert.deepStrictEqual(list(H.FACTION_B, at2), { ok: true, systemIds: [H.S.N6] });
      assert.deepStrictEqual(list(H.FACTION_A, at2 + COOLDOWN), { ok: true, systemIds: [] }, "expired");
      assert.deepStrictEqual(env.tx((db) => fresh.recordLossInTx(db, { factionId: 0, systemId: 1, at: 0,
        lostFleets: 1 }, "x")).reason, "INVALID_INPUT");
    }));

  needsDriver("RL2 escalation: 3rd loss in the window -> multiplier 2; loss after the window -> new series, cooldown "
    + "kept; row limit: one dead row evicted, none dead -> RECON_LOSS_LIMIT", () =>
    H.withStore(driver, async (reopen) => {
      const { env } = envOf(reopen);
      const counts = [];
      const repo = createReconLossRepository({ journal: env.journal, limits: LIMITS,
        onCount: (name) => counts.push(name) });
      const rec = (f, s, at, key) => env.tx((db) => repo.recordLossInTx(db, { factionId: f, systemId: s, at,
        lostFleets: 1 }, key));
      const t = H.START_MS;
      rec(H.FACTION_A, H.S.N5, t, "e:1");
      rec(H.FACTION_A, H.S.N5, t + HOUR, "e:2");
      const third = rec(H.FACTION_A, H.S.N5, t + 2 * HOUR, "e:3");
      assert.deepStrictEqual(third.record, { losses: 3, lastLossAt: t + 2 * HOUR,
        cooldownUntil: t + 2 * HOUR + 2 * COOLDOWN });
      const late = third.record.cooldownUntil + WINDOW + 1;
      const fourth = rec(H.FACTION_A, H.S.N5, late, "e:4");
      assert.deepStrictEqual(fourth.record, { losses: 1, lastLossAt: late, cooldownUntil: t + 2 * HOUR + 2 * COOLDOWN });

      const small = createReconLossRepository({ journal: env.journal, limits: { ...LIMITS,
        maxReconLossRowsPerFaction: 2 }, onCount: (name) => counts.push(name) });
      const recS = (s, at, key) => env.tx((db) => small.recordLossInTx(db, { factionId: H.FACTION_B, systemId: s, at,
        lostFleets: 1 }, key));
      recS(H.S.N6, t, "l:1");
      recS(H.S.N7, late, "l:2");
      const evict = recS(H.S.N9, late, "l:3");
      assert.deepStrictEqual([evict.ok, evict.evicted], [true, 1]);
      assert.deepStrictEqual(rowsOf(env).filter((r) => r.f === H.FACTION_B).map((r) => r.s), [H.S.N7, H.S.N9]);
      const full = recS(H.S.N10, late, "l:4");
      assert.deepStrictEqual([full.ok, full.reason], [false, "RECON_LOSS_LIMIT"]);
      assert.deepStrictEqual(rowsOf(env).filter((r) => r.f === H.FACTION_B).map((r) => r.s), [H.S.N7, H.S.N9]);
      assert.deepStrictEqual([counts.filter((n) => n === "strategy.reconLoss.evicted").length,
        counts.filter((n) => n === "strategy.reconLoss.limit").length], [1, 1]);
    }));

  needsDriver("RL3 consequence: dead scout of A recorded, dead patrol of B not; inactive faction skipped; a throwing "
    + "recon read through the strategy facade -> intel result ok:true with reconLoss, settlement COMPLETED", () =>
    H.withStore(driver, async (reopen) => {
      const { env, opened, shared } = envOf(reopen);
      const make = (tag, factionId, fleetRole, composition) => {
        const r = env.fleets.createFleet({ factionId, currentSystemId: H.S.N0, homeSystemId: H.S.N0, fleetRole,
          composition }, `${tag}:create`);
        assert.ok(r.ok, JSON.stringify(r));
        return r.fleetId;
      };
      const scout = make("rl3s", H.FACTION_A, "scout", ONE);
      const patrol = make("rl3p", H.FACTION_B, "patrol", ONE);
      const at = H.START_MS + HOUR;
      const settled = { systemId: H.S.N5, at, sides: { A: { factionId: H.FACTION_A }, B: { factionId: H.FACTION_B } },
        fleets: [{ fleetId: scout, side: "A", factionId: H.FACTION_A, disposition: "DESTROYED" },
          { fleetId: patrol, side: "B", factionId: H.FACTION_B, disposition: "DESTROYED" }] };
      const repo = createReconLossRepository({ journal: env.journal, limits: LIMITS });
      const active = new Set([H.FACTION_A, H.FACTION_B]);
      const registry = { getFaction: () => ({ allies: [] }), isActive: (f) => active.has(f) };
      const c = createReconLossConsequence({ reconLossRepository: repo, fleetRepository: env.fleets.repository,
        registry });
      const r = env.tx((db) => c.apply(db, settled, "battle:rl3:settle:v1:c:intel"));
      assert.deepStrictEqual(r, { ok: true, recorded: 1, skipped: 0 });
      assert.deepStrictEqual(rowsOf(env), [{ f: H.FACTION_A, s: H.S.N5, losses: 1, last: at, until: 0 }]);
      active.delete(H.FACTION_A);
      const off = env.tx((db) => c.apply(db, settled, "battle:rl3b:settle:v1:c:intel"));
      assert.deepStrictEqual(off, { ok: true, recorded: 0, skipped: 0 });
      assert.strictEqual(rowsOf(env)[0].losses, 1, "inactive faction not written");

      const r0 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
      assert.deepStrictEqual(r0.errors || [], []);
      let deadId = null;
      const realRepo = env.fleets.repository;
      const fleets = { ...env.fleets, repository: { ...realRepo, getFleets(tx, ids) {
        if (ids.includes(deadId)) throw new Error("boom");
        return realRepo.getFleets(tx, ids);
      } } };
      const counts = [];
      const st = startStrategy({ config: r0.config, persistence: { ok: true, store: opened.store, journal: env.journal,
        worldSeed: opened.worldSeed }, clock: { now: () => shared.clock.now() }, fleets,
      world: { repository: { getSystem: () => ({ ok: true, system: null }) } }, logger: { log() {} },
      telemetry: { hooks: { onCount: (name, n) => counts.push([name, n]) } } });
      assert.ok(st.ok, JSON.stringify(st));
      env.settlement = env.makeSettlement({ consequences: [lazyIntelConsequence(() => st.strategy)] });
      deadId = H.newFleet(env, "rl3d", H.FACTION_A, ONE);
      const guard = H.newFleet(env, "rl3g", H.FACTION_B, GUARD);
      const battle = H.battleOfFleets(env, "rl3", [deadId], [guard]);
      const result = H.resultFor(battle.input, "B_WIN", { [deadId]: (e) => ({ d: e.count, e: 0 }),
        [guard]: () => ({ d: 1, e: 0 }) });
      const settledOut = H.settleIn(env, env.settlement, battle, result);
      assert.strictEqual(settledOut.outcome, "COMPLETED", JSON.stringify(settledOut));
      assert.deepStrictEqual(settledOut.consequences, { applied: ["intel"], refused: [] });
      assert.ok(H.n(env, "SELECT count(*) AS n FROM world_faction_intel") >= 1, "intel kept");
      assert.deepStrictEqual(counts.filter(([n]) => n === "strategy.reconLoss.failed"), [["strategy.reconLoss.failed",
        1]]);
      const direct = env.tx((db) => st.strategy.intelConsequence.apply(db, { systemId: H.S.N5, at,
        sides: { A: { factionId: H.FACTION_A }, B: { factionId: H.FACTION_B } },
        fleets: [{ fleetId: deadId, side: "A", factionId: H.FACTION_A, disposition: "DESTROYED" }] }, "rl3:direct"));
      assert.deepStrictEqual([direct.ok, direct.reconLoss], [true, "RECON_LOSS_THREW"]);
      st.strategy.stop("test");
    }));
};
