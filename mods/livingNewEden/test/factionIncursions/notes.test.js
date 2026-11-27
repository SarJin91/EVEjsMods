"use strict";

const assert = require("node:assert");

const S = require("../../lib/factionIncursions/schema");
const R = require("../../lib/factionIncursions/rules");
const { rulesOf } = require("../../lib/factionIncursions/data/catalog");
const { settingsOf } = require("../../lib/factionIncursions");
const { createFactionIncursionService } = require("../../lib/factionIncursions/service");
const { createFactionIncursionRepository } = require("../../lib/factionIncursions/repository");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const config = require("../../config");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { T0, TRIG, DEFENDER, CHAR, TARGET, harness, boot, cfg } = require("./harness");

const UNLOCK_NOW = { EVEJS_LNE_FACTION_INCURSIONS_INFLUENCE_HQ_UNLOCK_MILLI: "600" };
const OLD_CHAR = 1000;
const DAY = 86400000;

function createAndPlan(svc, at) {
  assert.strictEqual(svc.runPass(at).created, 1);
  svc.runPass(at);
}

const payoutChars = (h, eventId) => h.run((tx) => tx.prepare(
  "SELECT character_id AS c FROM world_heavy_event_payouts WHERE event_id = ? ORDER BY character_id").all(eventId))
  .map((r) => Number(r.c));

function refusingRepository() {
  const real = createFactionIncursionRepository();
  const no = () => ({ ok: false, reason: "FACTION_INCURSION_INVALID_INPUT", detail: "progress" });
  return Object.freeze({ ...real, updateSiteInTx: no, updateProgressInTx: no, decideInTx: no });
}

module.exports = ({ test, skip }) => {
  test("FI7 recordClear caps a receipt past MAX_PROGRESS_JSON; config max 384", () => {
    const rules = rulesOf(TRIG);
    const base = R.refresh(R.createProgress(rules), rules, { influenceMilli: 0, hqUnlockMilli: 1000 });
    assert.strictEqual(base.stages.staging.active, true);
    const receipts = {};
    let i = 0;
    const filled = () => JSON.stringify({ ...base, receipts }).length;
    while (filled() < S.MAX_PROGRESS_JSON - 40) {
      receipts[`hin:1:${T0.toString(36)}:staging:${i}`] = 1;
      i += 1;
    }
    const progress = { ...base, receipts };
    const fit = R.recordClear(progress, rules, { stageKey: "staging", receiptId: "x", maxReceipts: 100000,
      maxJsonLength: S.MAX_PROGRESS_JSON });
    assert.strictEqual(fit.ok, true, "a receipt that fits is recorded");
    const big = R.recordClear(progress, rules, { stageKey: "staging", receiptId: `hin:99:${"y".repeat(56)}`,
      maxReceipts: 100000, maxJsonLength: S.MAX_PROGRESS_JSON });
    assert.deepStrictEqual(big, { ok: false, reason: "CLEARS_CAPPED" }, "past the column limit = capped");

    const over = config.resolveConfig({ modDir: require("node:path").resolve(__dirname, "..", ".."),
      env: { EVEJS_DATA_ROOT: require("node:os").tmpdir(),
        EVEJS_LNE_FACTION_INCURSIONS_MAX_SITE_CLEARS_PER_INCURSION: "1024" } });
    assert.ok((over.errors || []).length > 0 || over.config.factionIncursions.maxSiteClearsPerIncursion <= 384,
      JSON.stringify(over.errors));
    assert.strictEqual(cfg({ EVEJS_LNE_FACTION_INCURSIONS_MAX_SITE_CLEARS_PER_INCURSION: "384" })
      .factionIncursions.maxSiteClearsPerIncursion, 384);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("FI6-FI7 faction incursions on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FI6 world reset + the same incursion_id: new site ids, new payout, the new world's participant", () => {
    assert.deepStrictEqual([TABLE_POLICY.world_faction_incursions, TABLE_POLICY.world_faction_incursion_sites,
      TABLE_POLICY.world_heavy_events, TABLE_POLICY.world_heavy_event_payouts],
    [ACTION.WIPE, ACTION.WIPE, ACTION.WIPE, ACTION.KEEP]);
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const first = boot(h, UNLOCK_NOW);
      createAndPlan(first, T0);
      const oldHq = S.siteEventIdOf(1, T0, "hq", 1);
      h.clearSite(oldHq, T0 + 1000, true);
      assert.ok(h.run((tx) => h.payouts.planPayoutsInTx(tx, { eventId: oldHq, issuerFactionId: DEFENDER,
        systemId: TARGET, characterIds: [OLD_CHAR], iskAmount: 0, lpAmount: 0, standingMicro: 0, at: T0 + 1000 })).ok);
      first.runPass(T0 + 2000);
      assert.strictEqual(h.incursion(1).state, "SETTLED");
      first.stop();

      h.run((tx) => {
        for (const t of ["world_faction_incursion_sites", "world_faction_incursions", "world_heavy_events",
          "world_event_journal"]) tx.prepare(`DELETE FROM ${t}`).run();
      });
      h.ctx.heavyEvents = null;
      const t1 = T0 + DAY;
      h.now = t1;
      const second = boot(h, UNLOCK_NOW);
      createAndPlan(second, t1);
      assert.strictEqual(h.count(), 1);
      const newHq = S.siteEventIdOf(1, t1, "hq", 1);
      assert.notStrictEqual(newHq, oldHq, "the site id of the new world differs");
      assert.ok(newHq.length <= 64);
      assert.strictEqual(h.slots(1).find((s) => s.slot === "hq").eventId, newHq);
      h.clearSite(newHq, t1 + 1000, true);
      assert.deepStrictEqual(payoutChars(h, newHq), [CHAR], "the payout of the new world is planned");
      second.runPass(t1 + 2000);
      const row = h.incursion(1);
      assert.deepStrictEqual([row.state, row.effect], ["SETTLED", "REPEL_APPLIED"]);
      assert.strictEqual(h.occupation.repel[h.occupation.repel.length - 1].spec.characterId, CHAR,
        "the repel goes to the participant of the new world");
      second.stop();
    });
  });

  test("FI8 a write refusal other than STALE is reported in step and drain", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const real = boot(h);
      createAndPlan(real, T0);
      real.stop();
      const parsed = settingsOf(cfg().factionIncursions);
      assert.ok(parsed.ok);
      const make = (mode) => createFactionIncursionService({ store, journal: h.journal,
        repository: refusingRepository(), settings: parsed.settings, clock: h.clock, mode,
        getWorldRepository: () => h.worldRepository, getOccupation: () => h.occupation,
        getHeavyEvents: () => h.ctx.heavyEvents, getGraph: () => h.ctx.graph });
      h.clearSite(S.siteEventIdOf(1, T0, "staging", 1), T0 + 60000);
      const step = make("running");
      step.runPass(T0 + 70000);
      const line = step.getStatus().lastRefusal || "";
      assert.ok(line.includes("WRITE_REFUSED") && line.includes("FACTION_INCURSION_INVALID_INPUT"), line);
      assert.strictEqual(h.incursion(1).state, "ACTIVE", "rolled back");
      const drain = make("drain");
      drain.runPass(T0 + 80000);
      const dline = drain.getStatus().lastRefusal || "";
      assert.ok(dline.includes("drain 1 WRITE_REFUSED"), dline);
    });
  });
};
