"use strict";

const assert = require("node:assert");

const N = require("../../lib/nativeIncursions/schema");
const S = require("../../lib/factionIncursions/schema");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, TRIG, CHAR, TARGET, SYS, harness, boot, cfg } = require("./harness");

const UNLOCK_NOW = { EVEJS_LNE_FACTION_INCURSIONS_INFLUENCE_HQ_UNLOCK_MILLI: "600" };
const W = T0.toString(36);

function createAndPlan(h, svc, at = T0) {
  const p1 = svc.runPass(at);
  assert.strictEqual(p1.created, 1, JSON.stringify({ p1, lines: h.lines }));
  const p2 = svc.runPass(at);
  assert.strictEqual(p2.created, 0);
  return 1;
}

function toDefeated(h, svc) {
  const id = createAndPlan(h, svc);
  h.clearSite(S.siteEventIdOf(id, T0, "hq", 1), T0 + 1000, true);
  return id;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("FI3-FI4 faction incursions service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FI3 one incursion, 3 sites, +250 per clear once, hq at 1000 -> defeated -> one repel", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h);
      const id = createAndPlan(h, svc);
      assert.strictEqual(h.count(), 1);
      assert.deepStrictEqual(h.slots(id).map((s) => [s.slot, s.state, s.eventId]), [
        ["assault", "OPEN", `hin:1:${W}:assault:1`], ["hq", "WAITING", null], ["staging", "OPEN", `hin:1:${W}:staging:1`],
        ["vanguard", "OPEN", `hin:1:${W}:vanguard:1`]]);
      const st = h.heavyRow(`hin:1:${W}:staging:1`);
      assert.deepStrictEqual([st.state, st.variant, st.affix, st.systemId, st.beneficiaryFactionId, st.factionId],
        ["PLANNED", "staging", "none", SYS[3], 500001, TRIG]);
      assert.deepStrictEqual([h.heavyRow(`hin:1:${W}:assault:1`).systemId, h.heavyRow(`hin:1:${W}:vanguard:1`).variant],
        [SYS[1], "breach"]);
      assert.strictEqual(h.sites.calls.filter((c) => c[0] === "create").length, 3);
      assert.ok(h.sites.calls[0][2].includes("Incursion:"), h.sites.calls[0][2]);
      assert.strictEqual(svc.runPass(T0 + 1000).created, 0, "second pass: no new incursion");
      assert.strictEqual(h.count(), 1);

      h.clearSite(`hin:1:${W}:staging:1`, T0 + 60000);
      svc.runPass(T0 + 70000);
      assert.strictEqual(h.incursion(id).influence_milli, 850);
      svc.runPass(T0 + 80000);
      assert.strictEqual(h.incursion(id).influence_milli, 850, "the same receipt: no second influence");
      h.clearSite(`hin:1:${W}:vanguard:1`, T0 + 120000);
      svc.runPass(T0 + 150000);
      assert.strictEqual(h.incursion(id).influence_milli, 1000);
      const hq = h.slots(id).find((s) => s.slot === "hq");
      assert.deepStrictEqual([hq.state, hq.eventId], ["OPEN", `hin:1:${W}:hq:1`], "hq opens at 1000");
      assert.strictEqual(h.occupation.drops.length, 0, "a hin: clear drops no territory influence");

      h.clearSite(`hin:1:${W}:hq:1`, T0 + 200000, true);
      const p = svc.runPass(T0 + 210000);
      assert.deepStrictEqual([p.decided, p.settled], [1, 1], JSON.stringify(p));
      const row = h.incursion(id);
      assert.deepStrictEqual([row.state, row.outcome, row.effect, Number(row.decided_at), row.hq_event_id],
        ["SETTLED", "defeated", "REPEL_APPLIED", T0 + 200000, `hin:1:${W}:hq:1`]);
      assert.deepStrictEqual(h.heavyRow(`hin:1:${W}:assault:1`).state, "CANCELLED", "the open site cancelled");
      assert.strictEqual(h.occupation.repel.length, 1);
      assert.deepStrictEqual(h.occupation.repel[0], { key: "finc:repel:1:g1", spec: { systemId: TARGET,
        factionId: TRIG, huntId: "finc:1", characterId: CHAR, at: T0 + 200000 } });
      svc.runPass(T0 + 300000);
      svc.runPass(T0 + 400000);
      assert.strictEqual(h.occupation.repel.length, 1, "later passes: no repel");
      assert.strictEqual(svc.getStatus().counters.repelApplied, 1);
      assert.strictEqual(svc.getStatus().counters.siteCleared, 3);
      svc.stop();
    });
  });

  test("FI4 QUEUE_FULL retry + restart settles once; NOT_CLAIMANT; expired; kill switch drain; effect set", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const first = boot(h, UNLOCK_NOW);
      const id = toDefeated(h, first);
      h.occupation.next.push({ ok: false, reason: "QUEUE_FULL" });
      first.runPass(T0 + 2000);
      const r1 = h.incursion(id);
      assert.deepStrictEqual([r1.state, r1.outcome, Number(r1.attempts), r1.effect], ["DECIDED", "defeated", 1, null]);
      first.stop();
      const second = boot(h, UNLOCK_NOW);
      assert.strictEqual(second.runPass(T0 + 3000).settled, 1);
      assert.strictEqual(second.runPass(T0 + 4000).settled, 0);
      assert.strictEqual(h.occupation.repel.length, 2, "one refused + one applied");
      assert.strictEqual(h.incursion(id).effect, "REPEL_APPLIED");
      second.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h, UNLOCK_NOW);
      const id = toDefeated(h, svc);
      h.occupation.next.push({ ok: false, reason: "NOT_CLAIMANT" });
      svc.runPass(T0 + 2000);
      const row = h.incursion(id);
      assert.deepStrictEqual([row.state, row.effect, Number(row.attempts)], ["SETTLED", "NOT_CLAIMANT", 0]);
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = boot(h);
      const id = createAndPlan(h, svc);
      const expiresAt = Number(h.run((tx) => tx.prepare(
        "SELECT expires_at AS t FROM world_faction_incursions WHERE incursion_id = ?").get(id).t));
      const cleanups = () => h.sites.calls.filter((c) => c[0] === "cleanup").length;
      svc.runPass(expiresAt + 5000);
      const row = h.incursion(id);
      assert.deepStrictEqual([row.state, row.outcome, row.effect, Number(row.decided_at)],
        ["SETTLED", "expired", "RECORDED", expiresAt]);
      assert.strictEqual(cleanups(), 3, "the 3 open sites cancelled");
      svc.runPass(expiresAt + 6000);
      assert.strictEqual(cleanups(), 3, "once");
      assert.strictEqual(h.occupation.repel.length, 0);
      svc.stop();
    });
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const on = boot(h);
      const id = createAndPlan(h, on);
      on.stop();
      const off = h.startFi(cfg({ EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "0" }));
      assert.ok(off.ok, JSON.stringify(off));
      assert.strictEqual(off.factionIncursions.getStatus().state, "drain");
      off.factionIncursions.runPass(T0 + 5000);
      const row = h.incursion(id);
      assert.deepStrictEqual([row.state, row.outcome, row.effect], ["SETTLED", "cancelled", "DISABLED"]);
      assert.deepStrictEqual(h.heavyOpen().map((r) => r.eventId), [], "the hin: sites cancelled");
      assert.strictEqual(h.occupation.repel.length, 0, "no territory change");
      assert.strictEqual(off.factionIncursions.getStatus().state, "stopped");
      assert.deepStrictEqual(h.startFi(cfg({ EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "0" })),
        { ok: false, reason: "disabled_by_config" });
    });
    assert.deepStrictEqual(Object.values(S.EFFECT).sort(), [...Object.values(N.EFFECT), "DISABLED"].sort());
  });
};
