"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const FS = require("../../lib/factionIncursions/schema");
const { holdPointsOf, systemIdsOfRow, settleTxRowsBound } = require("../../lib/factionIncursions/consequence");
const { planConstellationDrops } = require("../../lib/nativeIncursions/consequence");
const { settingsOf, consequencesModeOf } = require("../../lib/factionIncursions");
const { JOURNAL_TABLE } = require("../../lib/persistence/migrations");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, TRIG, DEFENDER, TARGET, harness, boot, cfg } = require("./harness");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const OTHER = 500002;
const CONS = Object.freeze({ EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_ENABLED: "1" });
const HQ = Object.freeze({ EVEJS_LNE_FACTION_INCURSIONS_INFLUENCE_HQ_UNLOCK_MILLI: "600" });

const systemsOf = (h) => JSON.parse(h.run((tx) => tx.prepare(
  "SELECT systems_json AS j FROM world_faction_incursions WHERE incursion_id = 1").get().j)).map((s) => s.systemId);

function claimants(h, ids) {
  assert.strictEqual(ids.length, 4, JSON.stringify(ids));
  assert.ok(ids.includes(TARGET));
  const others = ids.filter((id) => id !== TARGET);
  h.systems[TARGET] = { occupierFactionId: TRIG, occupationState: "INVASION", controllerFactionId: DEFENDER };
  h.systems[others[0]] = { occupierFactionId: TRIG, occupationState: "CONTESTED", controllerFactionId: DEFENDER };
  h.systems[others[1]] = { occupierFactionId: TRIG, occupationState: "CONTESTED", controllerFactionId: DEFENDER };
  h.systems[others[2]] = { occupierFactionId: OTHER, occupationState: "CONTESTED", controllerFactionId: DEFENDER };
  return { claim: [TARGET, others[0], others[1]].sort((a, b) => a - b), outsider: others[2] };
}

const journalKeys = (h, like) => h.run((tx) => tx.prepare(
  `SELECT idempotency_key AS k FROM ${JOURNAL_TABLE} WHERE idempotency_key LIKE ? ORDER BY idempotency_key`)
  .all(like)).map((r) => r.k);
const settlePayload = (h) => {
  const row = h.run((tx) => tx.prepare(`SELECT payload FROM ${JOURNAL_TABLE} WHERE idempotency_key = ?`)
    .get(FS.settleKeyOf(1)));
  return row ? JSON.parse(row.payload) : null;
};
const expiresAtOf = (h) => Number(h.run((tx) => tx.prepare(
  "SELECT expires_at AS t FROM world_faction_incursions WHERE incursion_id = 1").get().t));

function toHqCleared(h, svc) {
  assert.strictEqual(svc.runPass(T0).created, 1, JSON.stringify(h.lines));
  svc.runPass(T0);
  h.clearSite(FS.siteEventIdOf(1, T0, "hq", 1), T0 + 1000, true);
}

module.exports = ({ test, skip }) => {
  test("FI22 holdPointsOf, systemIdsOfRow, the native planner with the faction effects, bound, consequencesModeOf", () => {
    assert.deepStrictEqual([[10, 1000], [10, 333], [10, 0], [0, 1000], [100, 1]].map(([p, s]) => holdPointsOf(p, s)),
      [10, 4, 1, 0, 1]);
    assert.deepStrictEqual(systemIdsOfRow([{ systemId: 5 }, { systemId: 5 }, { systemId: 0 }, null, { systemId: 6 },
      { systemId: 7.5 }, { systemId: 7 }, { systemId: 8 }, { systemId: 9 }]), [5, 6, 7, 8]);
    const sys = (systemId) => ({ systemId, occupierFactionId: TRIG, occupationState: "INVASION",
      controllerFactionId: DEFENDER });
    const plan = (effect) => planConstellationDrops({ outcome: FS.OUTCOME.DEFEATED, effect, targetSystemId: 1,
      systemIds: [1, 2], systems: [sys(1), sys(2)], claimantFactionId: TRIG, claimStates: ["INVASION"],
      defeatPoints: 10, expirePoints: 10, maxSystems: 4 }).map((p) => p.systemId);
    assert.deepStrictEqual(plan(FS.EFFECT.REPEL_APPLIED), [2], "the repel made its own drop: target out");
    assert.deepStrictEqual(plan(FS.EFFECT.NO_PARTICIPANT), [1, 2], "no repel drop: target in");
    const maxRows = cfg().persistence.maxRowsPerTransaction;
    assert.deepStrictEqual([settleTxRowsBound(8, 0), settleTxRowsBound(8, 64), settleTxRowsBound(32, 256)],
      [63, 127, 439]);
    assert.ok(settleTxRowsBound(32, 256) <= maxRows, `${maxRows}`);
    const S = (env) => {
      const p = settingsOf(cfg(env).factionIncursions);
      assert.ok(p.ok, JSON.stringify(p));
      return p.settings;
    };
    const F = cfg().world.maxFactionsPerSystem;
    const limits = { maxRowsPerTransaction: maxRows };
    assert.strictEqual(consequencesModeOf(S({}), limits, F).mode, null);
    assert.strictEqual(consequencesModeOf(S({ ...CONS, EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_DEFEAT_INFLUENCE_POINTS:
      "0", EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_EXPIRE_INFLUENCE_POINTS: "0" }), limits, F).mode, "off");
    const pooled = { ...S({ ...CONS, EVEJS_LNE_FACTION_INCURSIONS_REWARDS_ENABLED: "1" }), rewardsPool: "on" };
    assert.deepStrictEqual(consequencesModeOf(pooled, { maxRowsPerTransaction: 100 }, 8),
      { mode: "ROW_BOUND", bound: 127, maxRows: 100 });
    assert.deepStrictEqual(consequencesModeOf(S(CONS), limits, F), { mode: "on", bound: 63, maxRows });
    const w250 = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } })
      .warnings.filter((w) => w.includes("W250")).length;
    assert.deepStrictEqual([w250({ EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_NEWS_ENABLED: "1",
      EVEJS_LNE_NEWS_ENABLED: "0" }), w250({ EVEJS_LNE_FACTION_INCURSIONS_CONSEQUENCES_NEWS_ENABLED: "1",
      EVEJS_LNE_NEWS_ENABLED: "1" })], [1, 0]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FI23 FI24 faction incursion consequences", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FI23 defeated: 2 drops beside the repel, payload with factionId, replay / restart = no drop, row bound", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const settleRows = [];
      h.ctx.persistence = { ...h.ctx.persistence, store: { ...store, transaction: (name, fn) => {
        const r = store.transaction(name, fn);
        if (name === "factionIncursions.settle") settleRows.push(r.rows);
        return r;
      } } };
      const env = { ...HQ, ...CONS };
      const svc = boot(h, env);
      assert.strictEqual(svc.getStatus().consequences, "on");
      toHqCleared(h, svc);
      const { claim } = claimants(h, systemsOf(h));
      const p = svc.runPass(T0 + 2000);
      assert.deepStrictEqual([p.decided, p.settled], [1, 1], JSON.stringify({ p, lines: h.lines }));
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).effect], ["SETTLED", "REPEL_APPLIED"]);
      assert.strictEqual(h.occupation.repel.length, 1);
      const decidedAt = Number(h.incursion(1).decided_at);
      const expected = claim.filter((id) => id !== TARGET).map((systemId) => ({ key: `finc:drop:1:g1:${systemId}`,
        spec: { systemId, factionId: TRIG, points: 10, at: decidedAt, reason: "FACTION_INCURSION_DEFEAT",
          allowNonController: true } }));
      assert.deepStrictEqual(h.occupation.drops, expected);
      assert.strictEqual(svc.getStatus().counters.dropsApplied, 2);
      assert.ok(h.lines.includes("factionIncursions: incursion 1 settled defeated effect=REPEL_APPLIED drops=2/0"),
        h.lines.join("\n"));
      const payload = settlePayload(h);
      assert.deepStrictEqual(payload, { incursionId: 1, outcome: "defeated", targetSystemId: TARGET, factionId: TRIG });
      const bound = settleTxRowsBound(cfg(env).world.maxFactionsPerSystem, 0);
      assert.ok(settleRows.length === 1 && settleRows[0] <= bound, `settle rows ${settleRows} > ${bound}`);
      svc.runPass(T0 + 3000);
      svc.stop();
      const again = h.startFi(cfg(env));
      assert.ok(again.ok, JSON.stringify(again));
      again.factionIncursions.runPass(T0 + 4000);
      again.factionIncursions.stop();
      const replay = h.run((tx) => h.journal.applyOnce(tx, { key: FS.settleKeyOf(1),
        aggregate: { type: FS.AGGREGATE, id: "1" }, eventType: FS.EVENT_SETTLE, payload }, () => {
        throw new Error("applyFn of a duplicate");
      }));
      assert.deepStrictEqual([replay.ok, replay.duplicate], [true, true]);
      assert.strictEqual(h.occupation.drops.length, 2);
      assert.deepStrictEqual(journalKeys(h, "finc:drop:%").filter((k) => !k.includes(":aux:")),
        expected.map((e) => e.key));
    });
  });

  test("FI24 expired x strength, OCCUPATION_STOPPED rolls back, flag off = bit for bit, DRAIN no drop", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.claims[0].influence[0].influenceScore = 45;
      const svc = boot(h, CONS);
      assert.strictEqual(svc.runPass(T0).created, 1);
      svc.runPass(T0);
      const { claim } = claimants(h, systemsOf(h));
      svc.runPass(expiresAtOf(h) + 5000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).outcome, h.incursion(1).effect],
        ["SETTLED", "expired", "RECORDED"]);
      assert.deepStrictEqual(h.occupation.drops.map((d) => [d.key, d.spec.factionId, d.spec.points, d.spec.reason]),
        claim.map((id) => [`finc:hold:1:g1:${id}`, DEFENDER, 5, "FACTION_INCURSION_HOLD"]));
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, CONS);
      assert.strictEqual(svc.runPass(T0).created, 1);
      svc.runPass(T0);
      claimants(h, systemsOf(h));
      h.occupation.dropNext.push(null, { ok: false, reason: "OCCUPATION_STOPPED" });
      svc.runPass(expiresAtOf(h) + 5000);
      assert.deepStrictEqual([h.incursion(1).state, Number(h.incursion(1).attempts)], ["DECIDED", 1]);
      assert.deepStrictEqual([...journalKeys(h, "finc:drop:%"), ...journalKeys(h, "finc:hold:%"),
        ...journalKeys(h, "finc:settle:%")], []);
      assert.strictEqual(svc.getStatus().counters.dropsApplied, 0);
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, HQ);
      assert.ok(!("consequences" in svc.getStatus()));
      toHqCleared(h, svc);
      claimants(h, systemsOf(h));
      svc.runPass(T0 + 2000);
      assert.strictEqual(h.incursion(1).state, "SETTLED");
      assert.deepStrictEqual([h.getSystemsCalls, h.occupation.drops.length], [0, 0]);
      assert.deepStrictEqual(Object.entries(settlePayload(h)),
        [["incursionId", 1], ["outcome", "defeated"], ["targetSystemId", TARGET]]);
      assert.ok(!("consequences" in svc.getStatus()));
      assert.ok(!h.lines.some((l) => l.includes("drops=")), h.lines.join("\n"));
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const held = { ...HQ, ...CONS, EVEJS_LNE_FACTION_INCURSIONS_SETTLE_ENABLED: "0" };
      const svc = boot(h, held);
      toHqCleared(h, svc);
      claimants(h, systemsOf(h));
      svc.runPass(T0 + 2000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).outcome], ["DECIDED", "defeated"]);
      svc.stop();
      const drain = h.startFi(cfg({ ...CONS, EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "0" }));
      assert.ok(drain.ok, JSON.stringify(drain));
      drain.factionIncursions.runPass(T0 + 3000);
      assert.deepStrictEqual([h.incursion(1).state, h.incursion(1).effect], ["SETTLED", "DISABLED"]);
      assert.deepStrictEqual([h.getSystemsCalls, h.occupation.drops.length], [0, 0]);
      assert.deepStrictEqual(Object.keys(settlePayload(h)), ["incursionId", "outcome", "targetSystemId"]);
      drain.factionIncursions.stop();
    });
  });
};
