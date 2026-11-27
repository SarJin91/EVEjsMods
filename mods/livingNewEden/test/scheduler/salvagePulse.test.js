"use strict";

const assert = require("node:assert");

const { startSalvage, createUnavailableSalvage } = require("../../lib/world/salvage");
const { createSalvageService, pulseRowBound } = require("../../lib/economy/salvageScheduler");
const S = require("../../lib/world/salvageSchema");
const { harness: H } = require("../battle/settlement.test");
const { harness: SV } = require("../economy/salvageScheduler.test");

function fakeScheduler() {
  const registered = [];
  return { registered, getStatus: () => ({ state: "ready" }), enqueue: () => ({ ok: true }), findByKey: () => ({
    ok: true, found: false }), registerHandler: (type) => {
    registered.push(type);
    return { ok: true, unregister() {} };
  } };
}

module.exports = ({ test, skip }) => {
  test("SV4a handlers (no database): pulse effect + next bucket, coalesced anchor; bad payload permanent "
    + "startSalvage off / row bound / no wrecks; unavailable stub", () => {
    const cfg = SV.salvageConfig();
    const calls = [];
    const salvage = { countActive: () => { calls.push("count"); return { ok: true, count: 0 }; },
      listCandidates: () => ({ ok: true, fields: [] }) };
    const service = createSalvageService({ store: {}, salvage, wrecks: {}, scheduler: fakeScheduler(),
      clock: { now: () => 0 }, config: cfg, getStations: () => null, getGraph: () => null });
    const I = cfg.salvage.pulseIntervalMs;
    const res = service.pulseHandler({ eventType: "SALVAGE_PULSE", payload: {} }, { now: 5 * I + 7, anchorAt: 3 * I });
    assert.strictEqual(res.ok, true);
    assert.deepStrictEqual(res.reschedule, { eventType: "SALVAGE_PULSE", aggregateId: "salvage", dueAt: 4 * I,
      payload: { intervalMs: I, round: 4 }, idempotencyKey: S.pulseKey(I, 4) });
    const value = res.effect({ inTransaction: true });
    assert.deepStrictEqual([value.ok, value.created, calls], [true, 0, ["count"]], "the effect is processSalvageJobs");
    const late = service.pulseHandler({ payload: {} }, { now: 9 * I + 1, anchorAt: 9 * I + 1 });
    assert.strictEqual(late.reschedule.dueAt, 10 * I, "a coalesced pulse chains from now, no replay of buckets");

    for (const payload of [null, {}, { jobId: "sj:x" }, { jobId: "sj:x", phaseSeq: 0 }, { jobId: "", phaseSeq: 1 },
      { jobId: "sj:x", phaseSeq: 1, extra: 1 }]) {
      for (const h of [service.advanceHandler, service.deliveryHandler]) {
        assert.deepStrictEqual(h({ payload }), { ok: false, reason: "SALVAGE_PAYLOAD_INVALID", permanent: true });
      }
    }

    const persistence = { ok: true, store: { limits: { maxRowsPerTransaction: 500 } }, journal: { applyOnce() {} } };
    const wrecks = { repository: { recordSalvageInTx() {}, get() {} } };
    const deps = (over) => ({ config: cfg, persistence, clock: { now: () => 0 }, scheduler: fakeScheduler(), wrecks,
      ...over });
    assert.strictEqual(startSalvage(deps({ config: SV.salvageConfig({}, false) })).reason, "disabled_by_config");
    const noWorld = { ...cfg, modules: { ...cfg.modules, world: { enabled: false } } };
    assert.strictEqual(startSalvage(deps({ config: noWorld })).reason, "disabled_by_config");
    assert.strictEqual(startSalvage(deps({ wrecks: { repository: null } })).reason, "dependency_disabled:wrecks");
    const tight = { ...persistence, store: { limits: { maxRowsPerTransaction: pulseRowBound(6) - 1 } } };
    assert.strictEqual(startSalvage(deps({ persistence: tight })).reason, "SALVAGE_EXCEEDS_MAX_ROWS");
    const sched = fakeScheduler();
    const ok = startSalvage(deps({ scheduler: sched, persistence: { ...persistence, store: { ...persistence.store,
      transaction: () => ({ ok: true, value: { ok: true, jobs: [], truncated: false } }) } } }));
    assert.strictEqual(ok.ok, true, JSON.stringify(ok));
    assert.deepStrictEqual(sched.registered, ["SALVAGE_PULSE", "SALVAGE_JOB_ADVANCE", "SALVAGE_DELIVERY"]);
    const stub = createUnavailableSalvage("SALVAGE_DISABLED");
    assert.deepStrictEqual([stub.getStatus().state, stub.reconcile().reason, stub.repository],
      ["unavailable", "SALVAGE_UNAVAILABLE", null]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SV4b SALVAGE_JOB_ADVANCE of another phase is STALE (no write); salvage.enabled=false parks the "
    + "salvage events (QUEUED, job untouched)", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await SV.boot(reopen(), shared);
    const t0 = shared.clock.now();
    SV.addStation(env, "st-a", H.S.N0, H.FACTION_A, t0);
    const f1 = SV.addField(env, "s1", H.S.N5, H.FACTION_A, t0);
    const t1 = SV.firstPulseAt(shared, env.cfg.salvage.pulseIntervalMs);
    await SV.settleAt(env, shared, t1);
    const id = S.jobIdOf(f1);
    const stale = env.scheduler.enqueue("SALVAGE_JOB_ADVANCE", id, t1, { jobId: id, phaseSeq: 7 }, "test:stale");
    assert.ok(stale.ok, JSON.stringify(stale));
    await SV.settleAt(env, shared, t1 + 1);
    assert.deepStrictEqual([H.eventOf(env, "test:stale").state, SV.jobOf(env, f1).state, SV.jobOf(env, f1).version],
      ["DONE", "OUTBOUND", 1]);
    env.salvage.stop("restart");
    env.store.close("restart");

    const off = await SV.boot(reopen(), shared, { enabled: false });
    assert.deepStrictEqual([off.started.ok, off.started.reason], [false, "disabled_by_config"]);
    await SV.settleAt(off, shared, t1 + SV.TRAVEL_1 + 1);
    assert.strictEqual(H.eventOf(off, S.dueKey(id, 1)).state, "QUEUED", "parked, not quarantined");
    assert.strictEqual(SV.jobOf(off, f1).state, "OUTBOUND");
  }));
};
