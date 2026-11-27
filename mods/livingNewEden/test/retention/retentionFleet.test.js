"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { arrivalKey, refitKey, refitSeekKey } = require("../../lib/fleets/travelService");
const { createContactService, arrivalKey: contactArrivalKey } = require("../../lib/battle/contactService");
const { resolveConfig } = require("../../config");
const { startRetention } = require("../../lib/retention");
const R = require("../../lib/retention/schema");

const { S, FACTION_A } = H;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const DAY = 86400000;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const ON = Object.freeze({ EVEJS_LNE_RETENTION_ENABLED: "1", EVEJS_LNE_RETENTION_DRY_RUN: "0" });

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("J1 retention F: old DONE arrival/contact/refit rows and journal arrival rows go; the next plan gets "
    + "legSeq + 1, the old keys never come back; a re-inserted old key runs STALE (no second effect)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = H.boot(reopen(), shared);
      const clock = shared.clock;
      const contacts = createContactService({ scheduler: env.scheduler, isActive: () => true, bump: () => {} });
      assert.ok(env.fleets.travel.addArrivalListener(contacts.onArrival).ok);
      let checks = 0;
      assert.ok(env.scheduler.registerHandler("BATTLE_CONTACT_CHECK", () => {
        checks += 1;
        return { ok: true, outcome: "CHECKED" };
      }).ok);
      const drain = async (at) => {
        clock.set(Math.max(clock.now(), at));
        for (let i = 0; i < 12; i += 1) {
          const p = await env.scheduler.runPass();
          assert.ok(p.ok, JSON.stringify(p));
          if (p.jobs === 0) return;
        }
      };
      const ev = (key) => env.tx((db) => db.prepare("SELECT state, outcome FROM world_scheduled_events "
        + "WHERE idempotency_key = ?").get(key)) || null;
      const jrow = (key) => env.tx((db) => db.prepare("SELECT kind, state FROM world_event_journal "
        + "WHERE idempotency_key = ?").get(key)) || null;
      const fleetOf = (id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
      const counts = () => ({ events: H.n(env, "SELECT count(*) AS n FROM world_scheduled_events"),
        journal: H.n(env, "SELECT count(*) AS n FROM world_event_journal") });
      const passRetention = async () => {
        const on = startRetention({ config: configOf(ON), persistence: { ok: true, store: env.store,
          journal: env.journal }, scheduler: env.scheduler, clock, logger: { log() {} }, nowMs: () => 0 });
        assert.ok(on.ok, JSON.stringify(on));
        const due = env.tx((db) => db.prepare("SELECT due_at AS d FROM world_scheduled_events WHERE event_type = ? "
          + "AND state = 'QUEUED' ORDER BY due_at LIMIT 1").get(R.EVENT_TYPE));
        await drain(Number(due.d));
        const status = on.retention.getStatus();
        on.retention.stop();
        return status;
      };

      const fleetId = H.newFleet(env, "j1", FACTION_A, COMP, S.N0);
      const op = env.fleets.createOperation({ operationType: "patrol", factionId: FACTION_A, originSystemId: S.N0,
        targetSystemId: S.N5, objective: "patrol", dueAt: null, fleets: [{ fleetId, expectedVersion: 1 }] }, "j1:op");
      assert.ok(op.ok, JSON.stringify(op));
      const p1 = env.fleets.planTravel({ fleetId, targetSystemId: S.L2 }, "j1:plan");
      assert.ok(p1.ok, JSON.stringify(p1));
      const p2 = env.fleets.planTravel({ fleetId, targetSystemId: S.N5 }, "j1:replan");
      assert.ok(p2.ok, JSON.stringify(p2));
      assert.deepStrictEqual([p1.legSeq, p2.legSeq], [1, 2]);
      await drain(Math.max(p1.arriveAt, p2.arriveAt) + 1);
      const staged = fleetOf(fleetId);
      assert.deepStrictEqual([staged.state, staged.legSeq, staged.currentSystemId], ["STAGED", 2, S.N5]);
      assert.deepStrictEqual(ev(arrivalKey(fleetId, 1)), { state: "DONE", outcome: "STALE" });
      assert.strictEqual(ev(arrivalKey(fleetId, 2)).state, "DONE");
      assert.strictEqual(ev(contactArrivalKey(S.N5, fleetId, 2)).state, "DONE");
      assert.deepStrictEqual(jrow(arrivalKey(fleetId, 2)), { kind: "APPLY", state: "APPLIED" });
      assert.strictEqual(checks, 1);

      clock.set(clock.now() + 8 * DAY);
      const s1 = await passRetention();
      assert.deepStrictEqual([ev(arrivalKey(fleetId, 1)), ev(arrivalKey(fleetId, 2)),
        ev(contactArrivalKey(S.N5, fleetId, 2)), jrow(arrivalKey(fleetId, 2))], [null, null, null, null]);
      assert.deepStrictEqual([s1.classes["fleet-arrival"].deleted, s1.classes["contact-arrival"].deleted,
        s1.classes["journal-arrival"].deleted], [2, 1, 1]);
      assert.ok(jrow("j1:plan") && jrow("j1:replan"), "keys outside the classes stay");

      const r3 = env.fleets.retreat({ fleetId }, "j1:retreat");
      assert.ok(r3.ok, JSON.stringify(r3));
      assert.strictEqual(fleetOf(fleetId).legSeq, 3);
      assert.strictEqual(ev(arrivalKey(fleetId, 3)).state, "QUEUED");
      assert.deepStrictEqual([ev(arrivalKey(fleetId, 1)), ev(arrivalKey(fleetId, 2)), jrow(arrivalKey(fleetId, 2))],
        [null, null, null]);
      const leg3 = fleetOf(fleetId).route;
      await drain(leg3.arriveAt + 1);
      assert.strictEqual(fleetOf(fleetId).state, "REFITTING");
      assert.strictEqual(ev(refitKey(fleetId, 3)).state, "QUEUED");
      await drain(clock.now() + 2 * 3600000);
      const idle = fleetOf(fleetId);
      assert.deepStrictEqual([idle.state, idle.legSeq], ["IDLE", 3]);
      assert.strictEqual(ev(refitKey(fleetId, 3)).state, "DONE");
      assert.strictEqual(ev(contactArrivalKey(S.N0, fleetId, 3)).state, "DONE");
      const seekKey = refitSeekKey(fleetId, 1, 0);
      const seekPayload = { fleetId, legSeq: 1, round: 0, at: clock.now() };
      assert.ok(env.scheduler.enqueue("FLEET_REFIT_SEEK", fleetId, clock.now() + 365 * DAY, seekPayload, seekKey).ok);
      env.tx((db) => db.prepare("UPDATE world_scheduled_events SET state = 'DONE', finished_at = ?, outcome = 'STALE' "
        + "WHERE idempotency_key = ?").run(BigInt(clock.now()), seekKey));

      clock.set(clock.now() + 8 * DAY);
      const s2 = await passRetention();
      assert.deepStrictEqual([ev(arrivalKey(fleetId, 3)), ev(refitKey(fleetId, 3)), ev(seekKey),
        ev(contactArrivalKey(S.N0, fleetId, 3)), jrow(arrivalKey(fleetId, 3))], [null, null, null, null, null]);
      assert.deepStrictEqual([s2.classes["fleet-refit"].deleted, s2.classes["fleet-refitseek"].deleted], [1, 1]);
      assert.ok(jrow(`refit-done:${fleetId}:3`), "refit-done is outside the classes");

      const before = { fleet: fleetOf(fleetId), checks };
      const again = [
        ["FLEET_ARRIVAL", { fleetId, legSeq: 2 }, arrivalKey(fleetId, 2)],
        ["FLEET_ARRIVAL", { fleetId, legSeq: 3 }, arrivalKey(fleetId, 3)],
        ["FLEET_REFIT_COMPLETE", { fleetId, legSeq: 3 }, refitKey(fleetId, 3)],
        ["FLEET_REFIT_SEEK", seekPayload, seekKey],
      ];
      for (const [type, payload, key] of again) {
        const e = env.scheduler.enqueue(type, fleetId, clock.now(), payload, key);
        assert.deepStrictEqual([e.ok, e.duplicate], [true, false], JSON.stringify(e));
      }
      const rows = counts();
      await drain(clock.now() + 1);
      assert.deepStrictEqual(again.map(([, , key]) => ev(key)), again.map(() => ({ state: "DONE", outcome: "STALE" })));
      assert.deepStrictEqual(fleetOf(fleetId), before.fleet);
      assert.deepStrictEqual(counts(), rows);
      assert.deepStrictEqual([jrow(arrivalKey(fleetId, 2)), jrow(arrivalKey(fleetId, 3)),
        ev(contactArrivalKey(S.N5, fleetId, 2)), ev(contactArrivalKey(S.N0, fleetId, 3)), checks],
      [null, null, null, null, before.checks]);
    }));
};
