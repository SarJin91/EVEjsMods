"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { membersOf } = require("../../lib/playerHunt/huntRepository");
const { createExposureRepository } = require("../../lib/fleetExposure/exposureRepository");
const X = require("../../lib/fleetExposure/schema");
const { harness: H } = require("../battle/settlement.test");
const { harness: L } = require("../economy/logistics.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const MINERAL = "mineral/type:34";

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FEX4 convoy with 2 carriers claimed in flight: WAIT EXPOSED without a round while HELD, 1 carrier "
    + "lost in endInTx, RESEEK at the next deadline, the destination stock +500 of 1000", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const env = await L.boot(reopen(), shared);
      const t0 = shared.clock.now();
      L.addStation(env, "st-a", S.N7, t0);
      L.addStation(env, "st-b", S.N5, t0);
      L.putStock(env, "st-b", [{ itemKind: "mineral", itemKey: "type:34", delta: 1000 }], "test:stock:b", t0);
      const fleetId = L.newConvoyFleet(env, "fex4", S.N5);
      const f0 = L.fleetOf(env, fleetId);
      const d = env.tx((db) => env.logistics.dispatchInTx(db, { factionId: H.FACTION_A, fleetId,
        expectedVersion: f0.version, purpose: "MINERALS_TO_FACTORY", sourceStationId: "st-b", destStationId: "st-a",
        items: [{ itemKind: "mineral", itemKey: "type:34", quantity: 1000 }], at: t0 }, "fex4:d"));
      assert.deepStrictEqual([d.ok, d.state, d.loaded], [true, "IN_TRANSIT", { [MINERAL]: 1000 }], JSON.stringify(d));
      const f1 = L.fleetOf(env, fleetId);
      assert.deepStrictEqual([f1.state, f1.route.systems], ["TRAVELLING", [S.N5, S.N6, S.N7]]);
      const c0 = L.convoyOf(env, d.convoyId);

      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const repo = createExposureRepository({ journal, fleetRepository: env.fleets.repository,
        getTravel: () => env.fleets.travel });
      const at = f1.route.departAt + f1.route.jumpMs;
      shared.clock.set(at);
      const exposureId = X.exposureIdOf(fleetId, f1.version);
      const carriers = membersOf(fleetId, f1.composition).filter((m) => m.hullGroup === "industrial")
        .map((m) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId }));
      assert.strictEqual(carriers.length, 2);
      const claim = env.tx((db) => repo.claimInTx(db, { exposureId, fleetId, expectedVersion: f1.version,
        kind: "CONVOY", systemId: S.N6, operationId: c0.operationId, at, characterId: 90000001, members: carriers,
        destroyed: [], crossing: { legSeq: f1.legSeq, systemIndex: 1 } }));
      assert.strictEqual(claim.ok, true, JSON.stringify(claim));
      assert.strictEqual(L.fleetOf(env, fleetId).state, "MATERIALIZED");

      await L.settleAt(env, shared, d.arriveAt + DEFAULTS.logistics.watchGraceMs);
      const c1 = L.convoyOf(env, d.convoyId);
      assert.deepStrictEqual([c1.state, c1.watchRound, c1.phaseSeq], ["IN_TRANSIT", c0.watchRound, c0.phaseSeq + 1],
        env.lines.join("\n"));
      const held = L.fleetOf(env, fleetId);
      assert.deepStrictEqual([held.state, held.currentSystemId, held.operationId], ["MATERIALIZED", S.N6,
        c0.operationId]);
      assert.deepStrictEqual(L.stockOf(env, "st-a"), {}, "nothing delivered while held");

      const now = shared.clock.now();
      const loss = env.tx((db) => repo.markDestroyedInTx(db, { exposureId, memberKey: carriers[0].memberKey,
        at: now }));
      assert.deepStrictEqual(loss, { ok: true, duplicate: false });
      const end = env.tx((db) => repo.endInTx(db, { exposureId, at: now, reason: "QUIET" }));
      assert.deepStrictEqual(end, { ok: true, duplicate: false, outcome: "RELEASED",
        losses: [{ hullGroup: "industrial", typeId: null, count: 1 }] });
      const released = L.fleetOf(env, fleetId);
      assert.deepStrictEqual([released.state, released.currentSystemId, released.operationId], ["STAGED", S.N6,
        c0.operationId]);

      const c = await L.untilEnded(env, shared, d.convoyId);
      assert.deepStrictEqual([c.state, c.deliveredStationId, c.delivered, c.lostUnits], ["DELIVERED", "st-a",
        { [MINERAL]: 500 }, 500], env.lines.join("\n"));
      assert.deepStrictEqual(L.stockOf(env, "st-a"), { [MINERAL]: 500 });
      assert.deepStrictEqual(L.stockOf(env, "st-b"), {}, "the source gave 1000 at the load");
      assert.strictEqual(env.tx((db) => repo.getInTx(db, exposureId)).exposure.state, "ENDED");
      env.logistics.stop("test");
    }, { fresh: true }));
};
