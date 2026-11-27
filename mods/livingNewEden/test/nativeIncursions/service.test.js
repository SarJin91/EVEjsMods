"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startNativeIncursions } = require("../../lib/nativeIncursions");
const { planConstellationDrops, settleRowsBound } = require("../../lib/nativeIncursions/consequence");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const TARGET = 30000014;
const OTHER = 30000099;
const TALE_A = 8000000000002;
const TALE_B = 8000000000004;
const CHAR = 91000001;
const BASE_ENV = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_NATIVE_INCURSIONS_ENABLED: "1",
  EVEJS_LNE_NATIVE_INCURSIONS_STEER_ENABLED: "1", EVEJS_LNE_NATIVE_INCURSIONS_SETTLE_ENABLED: "1" };

const configCache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { ...BASE_ENV, ...env } });
    assert.deepStrictEqual(r.errors || [], []);
    configCache.set(key, r.config);
  }
  return configCache.get(key);
}

function tale(taleId, extra = {}) {
  return { taleId, generation: (taleId - 8000000000000) / 2, constellationId: 20000002, band: "null",
    systemIds: [30000013, TARGET, 30000015, 30000011], selectionKey: null, createdAt: T0 - 1000,
    expiresAt: T0 + 5000, phase: 1, influence: 1, terminal: null, ...extra };
}

const terminal = (outcome, bossReceiptId = null) => ({ outcome, eventId: "sansha:x:terminal", decidedAt: T0 + 100,
  bossReceiptId });

function fakes() {
  const st = { tales: [], published: [], receipts: {}, repel: [], next: [], systems: {}, drops: [], dropNext: [],
    journal: null };
  const adapter = {
    nativeIncursionsSetTargets: (byBand) => {
      st.published.push(byBand);
      return { ok: true, installed: byBand !== null };
    },
    nativeIncursionsListTales: () => ({ ok: true, tales: [...st.tales].sort((a, b) => b.taleId - a.taleId),
      truncated: false }),
    nativeIncursionsBossParticipants: (id) => ({ ok: true, characterIds: st.receipts[id] || [] }),
    nativeIncursionsVendorBands: () => ({ ok: true, bands: { high: true, low: false, null: true } }),
    nativeIncursionsStats: () => ({ installed: true, drift: false, hits: 0, passthrough: 0, exclusiveNull: 0,
      errors: 0, steerLog: [] }),
  };
  const world = { listByOccupier: (_db, factionId) => ({ ok: true, nextAfterSystemId: null,
    systems: factionId === 500019 ? [{ systemId: TARGET, occupationState: "INVASION" },
      { systemId: OTHER, occupationState: "RECON" }] : [] }),
  getSystems: (db, ids, opts) => {
    assert.strictEqual(db.inTransaction, true);
    assert.deepStrictEqual(opts, { includeInfluence: false });
    const systems = ids.filter((id) => st.systems[id]).map((id) => ({ systemId: id, ...st.systems[id] }));
    return { ok: true, systems, missing: ids.filter((id) => !st.systems[id]) };
  } };
  const occupation = { applyPlayerRepelInTx: (tx, spec, key) => {
    assert.strictEqual(tx.inTransaction, true);
    st.repel.push({ spec, key });
    return st.next.length > 0 ? st.next.shift() : { ok: true, outcome: "APPLIED", state: "INVASION" };
  },
  dropInfluenceInTx: (tx, spec, key) => {
    assert.strictEqual(tx.inTransaction, true);
    st.drops.push({ spec, key });
    if (st.dropNext.length > 0) return st.dropNext.shift();
    const ap = st.journal.applyOnce(tx, { key, aggregate: { type: "world_system", id: String(spec.systemId) },
      eventType: "FAKE_INFLUENCE_DROP", payload: { ...spec } }, () => ({ ok: true }));
    if (!ap.ok) return { ok: false, reason: "OCCUPATION_DROP_FAILED" };
    return ap.duplicate ? { ok: true, outcome: "DUPLICATE" } : { ok: true, outcome: "APPLIED", written: true };
  } };
  return { st, adapter, world, occupation };
}

function boot(opened, f, env = {}, store = opened.store) {
  const clock = { now: () => T0 };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  f.st.journal = journal;
  const started = startNativeIncursions({ config: cfg(env), clock, adapter: f.adapter,
    persistence: { ok: true, store, journal }, getWorldRepository: () => f.world,
    getOccupation: () => f.occupation, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  return started.nativeIncursions;
}

function rowOf(opened, taleId) {
  const r = opened.store.transaction("t.read", (db) => db.prepare(
    "SELECT state, effect, outcome, attempts, target_system_id, steered FROM world_native_incursions WHERE tale_id = ?")
    .get(taleId) || null);
  assert.ok(r.ok);
  if (!r.value) return null;
  const v = r.value;
  return { state: v.state, effect: v.effect, outcome: v.outcome, attempts: Number(v.attempts),
    target: Number(v.target_system_id), steered: Number(v.steered) };
}

function journalKeys(opened, prefix) {
  const r = opened.store.transaction("t.keys", (db) => db.prepare(
    "SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE ? ORDER BY idempotency_key")
    .all(`${prefix}%`).map((row) => row.k));
  assert.ok(r.ok);
  return r.value;
}

const SANSHA = 500019;
const S13 = 30000013;
const S15 = 30000015;
const S11 = 30000011;
const claim = (state, controllerFactionId) => ({ occupierFactionId: SANSHA, occupationState: state,
  controllerFactionId });

module.exports = ({ test, skip }) => {
  test("NI6 planConstellationDrops: defeated / expired / vanished / points 0; settleRowsBound(8, 4) = 63", () => {
    const systems = [{ systemId: S13, ...claim("INVASION", 500001) }, { systemId: TARGET, ...claim("INVASION", null) },
      { systemId: S15, ...claim("RECON", 500002) }, { systemId: S11, occupierFactionId: 500010,
        occupationState: "INVASION", controllerFactionId: 500001 }, { systemId: OTHER, ...claim("CONTESTED", 500003) }];
    const base = { outcome: "defeated", effect: "REPEL_APPLIED", targetSystemId: TARGET,
      systemIds: [S15, S13, TARGET, S11, S13, OTHER], systems, claimantFactionId: SANSHA,
      claimStates: ["CONTESTED", "INVASION"], defeatPoints: 10, expirePoints: 7, maxSystems: 4 };
    assert.deepStrictEqual(planConstellationDrops(base), [{ systemId: S13, factionId: SANSHA, points: 10,
      kind: "drop" }]);
    assert.deepStrictEqual(planConstellationDrops({ ...base, maxSystems: 5 }).map((p) => p.systemId), [S13, OTHER]);
    assert.deepStrictEqual(planConstellationDrops({ ...base, effect: "REPEL_DISABLED" }).map((p) => p.systemId),
      [S13, TARGET], "REPEL_DISABLED: the target in the plan");
    assert.deepStrictEqual(planConstellationDrops({ ...base, outcome: "expired", effect: "RECORDED", maxSystems: 5 }),
      [{ systemId: S13, factionId: 500001, points: 7, kind: "hold" },
        { systemId: OTHER, factionId: 500003, points: 7, kind: "hold" }], "expired: the target with controller null skipped");
    const withTargetCtrl = systems.map((s) => (s.systemId === TARGET ? { ...s, controllerFactionId: 500004 } : s));
    assert.deepStrictEqual(planConstellationDrops({ ...base, outcome: "expired", effect: "RECORDED",
      systems: withTargetCtrl }).map((p) => [p.systemId, p.factionId]), [[S13, 500001], [TARGET, 500004]]);
    assert.deepStrictEqual(planConstellationDrops({ ...base, defeatPoints: 0 }), []);
    assert.deepStrictEqual(planConstellationDrops({ ...base, outcome: "expired", expirePoints: 0 }), []);
    assert.deepStrictEqual(planConstellationDrops({ ...base, outcome: "vanished" }), []);
    assert.deepStrictEqual(planConstellationDrops({ ...base, effect: "FAILED" }), []);
    assert.strictEqual(settleRowsBound(8, 4), 63);
    assert.ok(settleRowsBound(cfg().world.maxFactionsPerSystem, 4) <= cfg().persistence.maxRowsPerTransaction);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NI3-NI4, NI7-NI8 native incursions service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NI3 bind once, defeated -> one repel with nincursion:repel:<id>:g<gen>, SETTLED/REPEL_APPLIED; limit", () => {
    withStore(driver, (opened) => {
      const f = fakes();
      const svc = boot(opened, f);
      f.st.tales = [tale(TALE_A)];
      const p1 = svc.runPass(T0);
      assert.deepStrictEqual(p1, { ok: true, targets: 1, bound: 1, settled: 0 });
      assert.deepStrictEqual(f.st.published[0].null, [{ systemId: TARGET }], "INVASION target, RECON skipped");
      assert.deepStrictEqual(rowOf(opened, TALE_A), { state: "BOUND", effect: null, outcome: null, attempts: 0,
        target: TARGET, steered: 0 });
      assert.strictEqual(svc.runPass(T0).bound, 0, "second pass binds nothing");
      f.st.tales = [tale(TALE_A, { terminal: terminal("defeated", "rcpt-1") })];
      f.st.receipts["rcpt-1"] = [CHAR];
      assert.strictEqual(svc.runPass(T0 + 200).settled, 1);
      assert.strictEqual(f.st.repel.length, 1);
      assert.strictEqual(f.st.repel[0].key, `nincursion:repel:${TALE_A}:g1`);
      assert.deepStrictEqual(f.st.repel[0].spec, { systemId: TARGET, factionId: 500019, huntId: `incursion:${TALE_A}`,
        characterId: CHAR, at: T0 + 100 });
      assert.strictEqual(svc.runPass(T0 + 300).settled, 0);
      assert.strictEqual(svc.runPass(T0 + 400).settled, 0);
      assert.strictEqual(f.st.repel.length, 1, "later passes: no repel");
      assert.deepStrictEqual(rowOf(opened, TALE_A), { state: "SETTLED", effect: "REPEL_APPLIED", outcome: "defeated",
        attempts: 0, target: TARGET, steered: 0 });
      assert.strictEqual(svc.getStatus().counters.repelApplied, 1);
      svc.stop();
      assert.strictEqual(f.st.published[f.st.published.length - 1], null, "stop = passthrough");
    });
    withStore(driver, (opened) => {
      const f = fakes();
      const svc = boot(opened, f, { EVEJS_LNE_NATIVE_INCURSIONS_MAX_ACTIVE_BINDINGS: "1" });
      f.st.tales = [tale(TALE_A), tale(TALE_B, { constellationId: 20000005 })];
      assert.strictEqual(svc.runPass(T0).bound, 1);
      assert.ok(rowOf(opened, TALE_A), "older tale bound");
      assert.strictEqual(rowOf(opened, TALE_B), null, "maxActiveBindings 1: no second row");
      svc.stop();
    });
  });

  test("NI4 QUEUE_FULL -> rollback attempts 1, new instance settles once; NOT_CLAIMANT; expired; vanished", () => {
    withStore(driver, (opened) => {
      const f = fakes();
      const first = boot(opened, f);
      f.st.tales = [tale(TALE_A)];
      first.runPass(T0);
      f.st.tales = [tale(TALE_A, { terminal: terminal("defeated", "rcpt-1") })];
      f.st.receipts["rcpt-1"] = [CHAR];
      f.st.next.push({ ok: false, reason: "QUEUE_FULL" });
      assert.strictEqual(first.runPass(T0 + 200).settled, 0);
      assert.deepStrictEqual(rowOf(opened, TALE_A), { state: "BOUND", effect: null, outcome: null, attempts: 1,
        target: TARGET, steered: 0 });
      assert.strictEqual(first.getStatus().counters.settleRetry, 1);
      first.stop();
      const second = boot(opened, f);
      assert.strictEqual(second.runPass(T0 + 300).settled, 1);
      assert.strictEqual(second.runPass(T0 + 400).settled, 0);
      assert.strictEqual(f.st.repel.length, 2, "one refused + one applied");
      assert.strictEqual(rowOf(opened, TALE_A).effect, "REPEL_APPLIED");
      f.st.tales = [tale(TALE_B, { constellationId: 20000005 })];
      second.runPass(T0 + 500);
      f.st.tales = [tale(TALE_B, { constellationId: 20000005, terminal: terminal("defeated", "rcpt-2") })];
      f.st.receipts["rcpt-2"] = [CHAR];
      f.st.next.push({ ok: false, reason: "NOT_CLAIMANT" });
      second.runPass(T0 + 600);
      assert.deepStrictEqual(rowOf(opened, TALE_B), { state: "SETTLED", effect: "NOT_CLAIMANT", outcome: "defeated",
        attempts: 0, target: TARGET, steered: 0 });
      second.stop();
    });
    withStore(driver, (opened) => {
      const f = fakes();
      const svc = boot(opened, f);
      f.st.tales = [tale(TALE_A), tale(TALE_B, { constellationId: 20000005 })];
      assert.strictEqual(svc.runPass(T0).bound, 2);
      f.st.tales = [tale(TALE_A, { terminal: terminal("expired") })];
      svc.runPass(T0 + 6000);
      assert.deepStrictEqual(rowOf(opened, TALE_A), { state: "SETTLED", effect: "RECORDED", outcome: "expired",
        attempts: 0, target: TARGET, steered: 0 });
      assert.strictEqual(rowOf(opened, TALE_B).state, "BOUND", "inside vanishGraceMs");
      const grace = cfg().nativeIncursions.vanishGraceMs;
      svc.runPass(T0 + 5000 + grace + 1);
      assert.deepStrictEqual(rowOf(opened, TALE_B), { state: "SETTLED", effect: "RECORDED", outcome: "vanished",
        attempts: 0, target: TARGET, steered: 0 });
      assert.strictEqual(f.st.repel.length, 0, "expired / vanished: no repel");
      svc.stop();
    });
  });

  function constellation(f, targetController = null) {
    f.st.systems = { [S13]: claim("INVASION", 500001), [TARGET]: claim("INVASION", targetController),
      [S15]: claim("CONTESTED", 500002), [S11]: { occupierFactionId: 500010, occupationState: "INVASION",
        controllerFactionId: 500001 } };
  }

  function bindAndTerminate(svc, f, outcome) {
    f.st.tales = [tale(TALE_A)];
    assert.strictEqual(svc.runPass(T0).bound, 1);
    f.st.tales = [tale(TALE_A, { terminal: terminal(outcome, outcome === "defeated" ? "rcpt-1" : null) })];
    f.st.receipts["rcpt-1"] = [CHAR];
  }

  const dropKeys = (f) => f.st.drops.map((d) => d.key);

  test("NI7 defeated -> 1 repel + 2 drops nincursion:drop:<id>:g<gen>:<sys>; replays and a new instance drop nothing; "
    + "rows <= settleRowsBound", () => {
    withStore(driver, (opened) => {
      const f = fakes();
      constellation(f);
      const rows = [];
      const store = { ...opened.store, transaction: (name, fn) => {
        const r = opened.store.transaction(name, fn);
        if (name === "nativeIncursions.settle") rows.push(r.rows);
        return r;
      } };
      const svc = boot(opened, f, {}, store);
      bindAndTerminate(svc, f, "defeated");
      assert.strictEqual(svc.runPass(T0 + 200).settled, 1);
      assert.strictEqual(f.st.repel.length, 1);
      assert.deepStrictEqual(dropKeys(f), [`nincursion:drop:${TALE_A}:g1:${S13}`, `nincursion:drop:${TALE_A}:g1:${S15}`]);
      assert.deepStrictEqual(f.st.drops[0].spec, { systemId: S13, factionId: SANSHA, points: 10, at: T0 + 100,
        reason: "NATIVE_INCURSION_DEFEAT", allowNonController: true });
      assert.deepStrictEqual(rowOf(opened, TALE_A).effect, "REPEL_APPLIED");
      const status = svc.getStatus();
      assert.deepStrictEqual([status.consequences, status.counters.dropsApplied, status.counters.dropsSkipped],
        ["on", 2, 0]);
      const bound = settleRowsBound(cfg().world.maxFactionsPerSystem, 4);
      assert.strictEqual(rows.length, 1);
      assert.ok(rows[0] > 0 && rows[0] <= bound, `settle rows ${rows[0]} <= ${bound}`);
      assert.deepStrictEqual(journalKeys(opened, "nincursion:"), [`nincursion:bind:${TALE_A}:g1`,
        `nincursion:drop:${TALE_A}:g1:${S13}`, `nincursion:drop:${TALE_A}:g1:${S15}`, `nincursion:settle:${TALE_A}:g1`]);
      assert.strictEqual(svc.runPass(T0 + 300).settled, 0);
      svc.stop();
      const again = boot(opened, f);
      assert.strictEqual(again.runPass(T0 + 400).settled, 0);
      const manual = opened.store.transaction("t.replay", (db) => f.st.journal.applyOnce(db, {
        key: `nincursion:settle:${TALE_A}:g1`, aggregate: { type: "native_incursion", id: String(TALE_A) },
        eventType: "NATIVE_INCURSION_SETTLE", payload: { taleId: TALE_A, generation: 1, outcome: "defeated",
          targetSystemId: TARGET } }, () => assert.fail("applyFn of a duplicate")));
      assert.ok(manual.ok && manual.value.ok && manual.value.duplicate === true, JSON.stringify(manual.value));
      assert.strictEqual(f.st.drops.length, 2, "no new drop");
      assert.strictEqual(f.st.repel.length, 1, "no new repel");
      again.stop();
    });
  });

  test("NI8 OCCUPATION_STOPPED -> rollback attempts 1, no drop written; NO_SYSTEM_ROW -> SETTLED dropsSkipped 1; "
    + "expired -> drops of the controllers nincursion:hold:...", () => {
    withStore(driver, (opened) => {
      const f = fakes();
      constellation(f);
      const svc = boot(opened, f);
      bindAndTerminate(svc, f, "defeated");
      f.st.dropNext.push({ ok: false, reason: "OCCUPATION_STOPPED" });
      assert.strictEqual(svc.runPass(T0 + 200).settled, 0);
      assert.deepStrictEqual(rowOf(opened, TALE_A), { state: "BOUND", effect: null, outcome: null, attempts: 1,
        target: TARGET, steered: 0 });
      assert.deepStrictEqual(journalKeys(opened, "nincursion:drop:"), [], "no drop written");
      assert.strictEqual(svc.getStatus().counters.dropsApplied, 0);
      svc.stop();
    });
    withStore(driver, (opened) => {
      const f = fakes();
      constellation(f);
      const svc = boot(opened, f);
      bindAndTerminate(svc, f, "defeated");
      f.st.dropNext.push({ ok: false, reason: "NO_SYSTEM_ROW" });
      assert.strictEqual(svc.runPass(T0 + 200).settled, 1);
      assert.strictEqual(rowOf(opened, TALE_A).state, "SETTLED");
      assert.deepStrictEqual(journalKeys(opened, "nincursion:drop:"), [`nincursion:drop:${TALE_A}:g1:${S15}`]);
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c.dropsApplied, c.dropsSkipped], [1, 1]);
      svc.stop();
    });
    withStore(driver, (opened) => {
      const f = fakes();
      constellation(f, 500003);
      const svc = boot(opened, f);
      bindAndTerminate(svc, f, "expired");
      assert.strictEqual(svc.runPass(T0 + 6000).settled, 1);
      assert.strictEqual(f.st.repel.length, 0);
      assert.deepStrictEqual(f.st.drops.map((d) => [d.key, d.spec.factionId, d.spec.reason]), [
        [`nincursion:hold:${TALE_A}:g1:${S13}`, 500001, "NATIVE_INCURSION_HOLD"],
        [`nincursion:hold:${TALE_A}:g1:${TARGET}`, 500003, "NATIVE_INCURSION_HOLD"],
        [`nincursion:hold:${TALE_A}:g1:${S15}`, 500002, "NATIVE_INCURSION_HOLD"]]);
      assert.strictEqual(rowOf(opened, TALE_A).effect, "RECORDED");
      svc.stop();
    });
  });
};
