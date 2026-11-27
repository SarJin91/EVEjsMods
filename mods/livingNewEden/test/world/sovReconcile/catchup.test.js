"use strict";

const assert = require("node:assert");
const { pickNudges } = require("../../../lib/world/sovReconcile/catchup");
const { buildSovFactsView } = require("../../../lib/world/sovReconcile/factsView");
const { withHarness, loadDriver, settle } = require("./harness");

const SS = 30000301;
const F = 500016;
const A = 98000001;
const PLAYER = 99000050;
const IDS = [[F, A]];
const none = () => ({ claimed: false, allianceId: null });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => (driver.ok ? test(name, fn) : skip(name, `better-sqlite3 unavailable (${driver.detail})`));

  test("TE1 pickNudges: player claim -> playerHeld, isProjecting -> skipped, budget/max respected", () => {
    const rows = [{ systemId: 1 }, { systemId: 2 }, { systemId: 3 }];
    const claimOf = (sid) => (sid === 2 ? { claimed: true, allianceId: 99000001 } : none());
    const res = pickNudges({ rows, isProjecting: (sid) => sid === 3, claimOf, isModAlliance: () => false, tokens: 10, max: 4 });
    assert.deepStrictEqual(res.nudge, [1]);
    assert.deepStrictEqual(res.playerHeld, [2]);
    assert.strictEqual(res.skipped, 2);
  });

  const base = { rows: [{ systemId: 1 }, { systemId: 2 }], isProjecting: () => false, claimOf: none,
    isModAlliance: () => false };

  test("TE1 pickNudges: max=0 -> no nudges", () => {
    assert.deepStrictEqual(pickNudges({ ...base, tokens: 10, max: 0 }).nudge, []);
  });

  test("TE1 pickNudges: tokens=0 -> no nudges", () => {
    assert.deepStrictEqual(pickNudges({ ...base, tokens: 0, max: 4 }).nudge, []);
  });

  test("TE1 pickNudges: mod alliance claim -> not playerHeld, eligible for nudge", () => {
    const mod = pickNudges({ ...base, rows: [{ systemId: 1 }], claimOf: () => ({ claimed: true, allianceId: 77000001 }),
      isModAlliance: (a) => a === 77000001, tokens: 10, max: 4 });
    assert.deepStrictEqual([mod.nudge, mod.playerHeld], [[1], []]);
  });

  needsDriver("TE4b panel gate: real governor NORMAL -> available, CONSTRAINED (no MAINTENANCE) -> GOVERNOR_BELOW_MIN", async () => {
    await withHarness(async (h) => {
      const view = buildSovFactsView({ store: h.store, journal: h.journal, config: h.config, getGovernor: () => h.governor });
      assert.strictEqual(view.getData().available, true);
      assert.strictEqual(h.setLoad(125), "CONSTRAINED");
      assert.deepStrictEqual(view.getData(), { available: false, reason: "GOVERNOR_BELOW_MIN" });
    });
  });

  test("TE1 pickNudges: rotation - a permanent refusal does not block the others", () => {
    const rows = [{ systemId: 1 }, { systemId: 2 }, { systemId: 3 }];
    const state = { rotationIndex: 0 };
    const pick = () => pickNudges({ rows, isProjecting: () => false, claimOf: none, isModAlliance: () => false, tokens: 10, max: 1, state }).nudge;
    assert.deepStrictEqual([pick(), pick(), pick(), pick()], [[1], [2], [3], [1]]);
  });

  test("TE3 pickNudges: budget tokens and max cap", () => {
    const rows = [1, 2, 3, 4, 5].map((systemId) => ({ systemId }));
    const base = { rows, isProjecting: () => false, claimOf: none, isModAlliance: () => false };
    assert.strictEqual(pickNudges({ ...base, tokens: 2, max: 4 }).nudge.length, 2);
    assert.strictEqual(pickNudges({ ...base, tokens: 10, max: 3 }).nudge.length, 3);
  });

  needsDriver("TE2 CLAIM_LOST -> REPROJECT fact -> nudge in the same pass -> the real projection anchors again (GAIN)", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      const rec = await h.startReconcile();
      h.clock.advance(60000);
      h.vendor.claims.delete(SS);
      const anchors = h.vendor.calls.filter((x) => x[0] === "anchor").length;
      rec.runPass();
      await settle();
      const c = rec.getStatus().counters;
      assert.deepStrictEqual([c.markedForeign, c.factsApplied, c.dropApplied, c.nudged], [1, 1, 0, 1], JSON.stringify(c));
      assert.match(h.facts(`sov:native:${SS}:%`)[0].idempotency_key, /:CLAIM_LOST$/);
      assert.strictEqual(h.vendor.calls.filter((x) => x[0] === "anchor").length, anchors + 1);
      assert.deepStrictEqual([h.logOf(SS).last_action, h.logOf(SS).last_controller], ["GAIN", F]);
      assert.strictEqual(h.system(SS).controllerFactionId, F, "REPROJECT leaves the world unchanged");
    }, { identities: IDS });
  });

  needsDriver("TE3 nudges: log without controller vs world F -> one nudge per pass (maxProjectNudgesPerPass=1), player claim held", async () => {
    await withHarness(async (h) => {
      for (let i = 0; i < 3; i += 1) {
        h.seedSystem(SS + i, F);
        h.writeLog(SS + i, { action: "LOSS", seq: 1 });
      }
      h.seedSystem(SS + 3, F);
      h.writeLog(SS + 3, { action: "LOSS", seq: 1 });
      h.vendor.setClaim(SS + 3, PLAYER);
      const rec = await h.startReconcile();
      rec.runPass();
      await settle();
      const c = rec.getStatus().counters;
      assert.deepStrictEqual([c.nudged + c.nudgeFailed, c.playerHeld, c.markedForeign], [1, 1, 0], JSON.stringify(c));
    }, { identities: IDS, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_PROJECT_NUDGES_PER_PASS: "1" } });
  });

  needsDriver("TE4 panel: sov-facts shows the open (deferred) episode and the fact of a settled one; real governor admits", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      h.seedSystem(SS + 1, F);
      await h.gain(SS + 1);
      h.setState(SS, { occupationState: "CONTESTED" });
      const rec = await h.startReconcile();
      h.clock.advance(60000);
      h.vendor.setClaim(SS, PLAYER);
      h.vendor.destroyHub(SS + 1, A, h.clock.now() - 1);
      rec.runPass();
      const view = buildSovFactsView({ store: h.store, journal: h.journal, config: h.config, getGovernor: () => h.governor });
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.episodes.map((e) => e.systemId), [SS]);
      assert.deepStrictEqual(data.facts.map((f) => [f.eventType, f.payload.systemId, f.payload.kind]),
        [["NATIVE_LOSS", SS + 1, "HUB_DESTROYED"]]);
    }, { identities: IDS });
  });

  needsDriver("TE5 real wiring: budget from getStatus().budget, claims via adapter.getSovNative(): free -> nudge, player -> held", async () => {
    await withHarness(async (h) => {
      const sidFree = SS;
      const sidPlayer = SS + 1;
      for (const sid of [sidFree, sidPlayer]) {
        h.seedSystem(sid, F);
        h.writeLog(sid, { action: "LOSS", seq: 1 });
      }
      h.vendor.setClaim(sidPlayer, PLAYER);
      assert.strictEqual(typeof h.ctx.sovProjection.getStatus().budget.tokens, "number");
      const rec = await h.startReconcile();
      rec.runPass();
      await settle();
      const c = rec.getStatus().counters;
      assert.strictEqual(c.playerHeld, 1, JSON.stringify(c));
      assert.strictEqual(c.nudged + c.nudgeFailed, 1, JSON.stringify(c));
    }, { identities: IDS });
  });

  needsDriver("TE1 e2e: abandon outside handler -> nudge -> vendor loseSystemSovereignty -> log LOSS; next pass zero nudges", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      await h.gain(SS);
      assert.deepStrictEqual([h.logOf(SS).last_action, h.logOf(SS).last_controller], ["GAIN", F]);
      h.setState(SS, { controllerFactionId: null });
      const rec = await h.startReconcile();
      rec.runPass();
      await settle();
      let c = rec.getStatus().counters;
      assert.strictEqual(c.nudged, 1, "first pass should nudge");
      assert.strictEqual(c.nudgeFailed, 0);
      const loseCalls = h.vendor.calls.filter((x) => x[0] === "lose").length;
      assert.strictEqual(loseCalls, 1, "vendor loseSystemSovereignty called once");
      await settle(10);
      const logAfter = h.logOf(SS);
      assert.strictEqual(logAfter.last_action, "LOSS", `expected LOSS, got ${logAfter.last_action}`);
      assert.strictEqual(logAfter.last_controller, null);
      rec.runPass();
      await settle();
      c = rec.getStatus().counters;
      assert.strictEqual(c.nudged, 1, "second pass should not nudge again (total nudged stays 1)");
      assert.strictEqual(c.nudgeFailed, 0);
      const loseCallsAfter = h.vendor.calls.filter((x) => x[0] === "lose").length;
      assert.strictEqual(loseCallsAfter, 1, "no additional loseSystemSovereignty calls on second pass");
    }, { identities: IDS });
  });

  needsDriver("TE3a budget: 12 skirmishes, maxSovWritesPerWindow=8, maxProjectNudgesPerPass=4 -> nudged increments 4,4,0", async () => {
    await withHarness(async (h) => {
      for (let i = 0; i < 12; i += 1) {
        h.seedSystem(SS + i, F);
        h.writeLog(SS + i, { action: "LOSS", seq: 0 });
      }
      h.vendor.setClaim(SS + 11, PLAYER);

      const rec = await h.startReconcile();

      rec.runPass();
      await settle();
      let c = rec.getStatus().counters;
      assert.deepStrictEqual(c.nudged, 4, `pass 1 nudged=4, got ${c.nudged}`);
      assert.strictEqual(c.nudgeFailed, 0, `pass 1 nudgeFailed=0, got ${c.nudgeFailed}`);
      assert.strictEqual(c.playerHeld, 1, `pass 1 playerHeld=1, got ${c.playerHeld}`);
      const budgetAfter1 = h.ctx.sovProjection.getStatus().budget?.tokens ?? 0;
      assert.strictEqual(budgetAfter1, 4, `budget tokens=4 after pass 1, got ${budgetAfter1}`);

      rec.runPass();
      await settle();
      c = rec.getStatus().counters;
      assert.deepStrictEqual(c.nudged, 8, `pass 2 nudged=8 (increment 4), got ${c.nudged}`);
      assert.strictEqual(c.nudgeFailed, 0, `pass 2 nudgeFailed=0, got ${c.nudgeFailed}`);
      assert.strictEqual(c.playerHeld, 2, `pass 2 playerHeld=2, got ${c.playerHeld}`);
      const budgetAfter2 = h.ctx.sovProjection.getStatus().budget?.tokens ?? 0;
      assert.strictEqual(budgetAfter2, 0, `budget tokens=0 after pass 2, got ${budgetAfter2}`);

      rec.runPass();
      await settle();
      c = rec.getStatus().counters;
      assert.deepStrictEqual(c.nudged, 8, `pass 3 nudged=8 (increment 0), got ${c.nudged}`);
      assert.strictEqual(c.nudgeFailed, 0, `pass 3 nudgeFailed=0, got ${c.nudgeFailed}`);
      assert.strictEqual(c.playerHeld, 3, `pass 3 playerHeld=3, got ${c.playerHeld}`);
      const budgetAfter3 = h.ctx.sovProjection.getStatus().budget?.tokens ?? 0;
      assert.strictEqual(budgetAfter3, 0, `budget tokens=0 after pass 3, got ${budgetAfter3}`);
    }, { identities: IDS, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_PROJECT_NUDGES_PER_PASS: "4" } });
  });

  needsDriver("TE3b requestProject refusal -> nudgeFailed counter incremented, no exception thrown", async () => {
    await withHarness(async (h) => {
      h.seedSystem(SS, F);
      h.writeLog(SS, { action: "LOSS", seq: 1 });
      let refuse = true;
      const refusingProjection = {
        ...h.ctx.sovProjection,
        requestProject: async (systemId) => {
          if (refuse) {
            refuse = false;
            return { ok: false, reason: "BUDGET_EXCEEDED" };
          }
          return h.ctx.sovProjection.requestProject(systemId);
        },
        getStatus: () => h.ctx.sovProjection.getStatus(),
      };
      const rec = await h.startReconcile({ sovProjection: refusingProjection });
      rec.runPass();
      await settle();
      const c = rec.getStatus().counters;
      assert.strictEqual(c.nudgeFailed, 1, "nudgeFailed should be 1");
      assert.strictEqual(c.nudged, 0, "nudged should be 0");
      assert.strictEqual(c.failed, 0, "no failed passes");
    }, { identities: IDS });
  });

  needsDriver("TE6 factsView getData: order:recent, single tx for scan+findByKey, maxRows limit", async () => {
    await withHarness(async (h) => {
      let txCount = 0;
      const wrappedStore = {
        ...h.store,
        transaction: (name, fn) => {
          txCount += 1;
          return h.store.transaction(name, fn);
        },
        isOpen: () => h.store.isOpen(),
      };

      const view = buildSovFactsView({ store: wrappedStore, journal: h.journal, config: h.config, getGovernor: () => h.governor });

      const baseId = 30000305;
      for (let i = 5; i >= 3; i -= 1) {
        const sid = baseId + i;
        h.seedSystem(sid, F);
        await h.gain(sid);
        h.setState(sid, { occupationState: "STABLE" });
        h.vendor.destroyHub(sid, A, h.clock.now() - 1);
      }
      for (let i = 2; i >= 0; i -= 1) {
        const sid = baseId + i;
        h.seedSystem(sid, F);
        await h.gain(sid);
        h.setState(sid, { occupationState: "STABLE" });
        h.vendor.destroyHub(sid, A, h.clock.now() - 1);
      }
      const rec = await h.startReconcile();
      rec.runPass();
      await settle();

      let totalFacts = 0;
      for (let i = 0; i < 6; i += 1) {
        const factsForSystem = h.facts(`sov:native:${baseId + i}:%`);
        totalFacts += factsForSystem.length;
      }
      assert.strictEqual(totalFacts, 6, `expected 6 facts total, got ${totalFacts}`);

      const data = view.getData();
      assert.strictEqual(data.available, true);
      assert.strictEqual(data.facts.length, 2, `expected 2 facts (maxRows=2), got ${data.facts.length}`);

      const factSystemIds = data.facts.map((f) => f.payload.systemId).sort((a, b) => a - b);
      assert.deepStrictEqual(factSystemIds, [30000309, 30000310], `expected newest systems [30000309, 30000310], got ${factSystemIds}`);

      assert.ok(txCount <= 2, `transaction count ${txCount} should be <= 2`);
    }, { identities: IDS, env: { EVEJS_LNE_WORLD_SOVRECONCILE_MAX_PROJECT_NUDGES_PER_PASS: "6", EVEJS_LNE_OBSERVER_STATIONS_PANEL_MAX_ROWS: "2" } });
  });

  needsDriver("TE7 factsView cacheKey: null when store closed or governor denies, else key from latest journalId + count + maxVer", async () => {
    await withHarness(async (h) => {
      const view = buildSovFactsView({ store: h.store, journal: h.journal, config: h.config, getGovernor: () => h.governor });

      const key1 = view.cacheKey();
      const key2 = view.cacheKey();
      assert.strictEqual(key1, key2, "cacheKey should be stable without changes");
      assert.ok(key1.startsWith("sov-facts:"));

      h.seedSystem(SS + 10, F);
      await h.gain(SS + 10);
      h.setState(SS + 10, { occupationState: "STABLE" });
      h.vendor.destroyHub(SS + 10, A, h.clock.now() - 1);
      const rec = await h.startReconcile();
      rec.runPass();
      await settle();
      const key3 = view.cacheKey();
      assert.notStrictEqual(key3, key1, "cacheKey should change after new fact");

      h.seedSystem(SS + 11, F);
      await h.gain(SS + 11);
      const rec2 = await h.startReconcile();
      h.setState(SS + 11, { occupationState: "CONTESTED" });
      h.vendor.setClaim(SS + 11, 99000050);
      rec2.runPass();
      await settle();
      const key4 = view.cacheKey();
      assert.notStrictEqual(key4, key3, "cacheKey should change after episode version change");

      const updateRes = h.store.transaction("sovFactsView.testVersionUpdate", (tx) => {
        const stmt = tx.prepare(`UPDATE "world_sov_reconcile" SET version = version + 1 WHERE system_id = ?`);
        stmt.run(SS + 11);
        return { ok: true };
      });
      assert.strictEqual(updateRes.ok, true);
      const key5 = view.cacheKey();
      assert.notStrictEqual(key5, key4, "cacheKey should change after ONLY version update (no new fact, no new episode row)");

      const denyingGovernor = { admits: () => false };
      const denyingView = buildSovFactsView({ store: h.store, journal: h.journal, config: h.config, getGovernor: () => denyingGovernor });
      const key6 = denyingView.cacheKey();
      assert.strictEqual(key6, null, "cacheKey should be null when governor denies");

      h.store.close("test");
      const key7 = view.cacheKey();
      assert.strictEqual(key7, null, "cacheKey should be null when store closed");
    }, { identities: IDS });
  });
};
