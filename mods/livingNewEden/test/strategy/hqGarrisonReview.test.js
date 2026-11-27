"use strict";

const assert = require("node:assert");

const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const SANSHA = R.SANSHA;
const HQ = 30001868;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("HQR1: hqGarrisonEnabled=1 -> the review snapshot entry has the registry HQ and the HQ garrison "
    + "is pinned (HQ_HOLD); off -> entry without hqSystemId, no HQ_ note", async () => {
    const run = (on) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map(R.THEATRE.map((id) => [id, SANSHA]));
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(), controllers };
      const seen = { d: null, entry: null };
      const hooks = { beforeEffect: (d, snapshot) => {
        if (seen.d === null && d.factionId === SANSHA && d.outcome === "REVIEWED") {
          seen.d = d;
          seen.entry = snapshot.entry;
        }
        return d;
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
        EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED: on ? "1" : "0" }, { hooks });
      const g = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: HQ, homeSystemId: HQ,
        fleetRole: "garrison", composition: [{ hullGroup: "frigate", count: 1 }] }, "hqr1:g");
      assert.ok(g.ok, JSON.stringify(g));
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      assert.ok(seen.d, "a Sansha review ran");
      return { entry: seen.entry, notes: seen.d.notes };
    });
    const on = await run(true);
    assert.strictEqual(on.entry.hqSystemId, HQ, JSON.stringify(on.entry));
    assert.ok(on.notes.includes("HQ_HOLD"), JSON.stringify(on.notes));
    const off = await run(false);
    assert.ok(!("hqSystemId" in off.entry), JSON.stringify(off.entry));
    assert.ok(!off.notes.some((n) => n.startsWith("HQ_")), JSON.stringify(off.notes));
  });

  needsDriver("HQC1: an IDLE garrison in the HQ -> strategy.review.hqHold = 1; no fleet in the HQ and a free "
    + "fleet in reach -> hqReturnPlanned = 1; flag off -> the 3 HQ counters 0", async () => {
    const NAMES = ["strategy.review.hqHold", "strategy.review.hqUnheld", "strategy.review.hqReturnPlanned"];
    const run = (on, systemId) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map(R.THEATRE.map((id) => [id, SANSHA]));
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(), controllers };
      const counts = Object.fromEntries(NAMES.map((n) => [n, 0]));
      const telemetry = { count: (name, n) => {
        if (name in counts) counts[name] += n;
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
        EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED: on ? "1" : "0" }, { telemetry });
      const g = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: systemId, homeSystemId: systemId,
        fleetRole: "garrison", composition: [{ hullGroup: "frigate", count: 1 }] }, "hqc1:g");
      assert.ok(g.ok, JSON.stringify(g));
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      return counts;
    });
    const NEAR = R.THEATRE.find((id) => id !== HQ);
    const hold = await run(true, HQ);
    assert.strictEqual(hold["strategy.review.hqHold"], 1, JSON.stringify(hold));
    const back = await run(true, NEAR);
    assert.strictEqual(back["strategy.review.hqReturnPlanned"], 1, JSON.stringify(back));
    assert.strictEqual(back["strategy.review.hqHold"], 0, JSON.stringify(back));
    for (const systemId of [HQ, NEAR]) {
      const off = await run(false, systemId);
      assert.deepStrictEqual(Object.values(off), [0, 0, 0], JSON.stringify(off));
    }
  });
};
