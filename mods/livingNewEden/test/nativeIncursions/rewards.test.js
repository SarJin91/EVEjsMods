"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS, validateMigrations } = require("../../lib/persistence/migrations");
const { createAdapter } = require("../../lib/adapter");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { startNativeIncursions, settingsOf, rewardsModeOf } = require("../../lib/nativeIncursions");
const NIS = require("../../lib/nativeIncursions/schema");
const { startHeavyEvents, createUnavailableHeavyEvents } = require("../../lib/heavyEvents");
const { lpCorporationOf } = require("../../lib/heavyEvents/payoutRepository");
const { heavyConfigOf } = require("../factionIncursions/harness");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SRC = path.join(path.sep, "x", "server", "src");
const T0 = 1760000000000;
const TARGET = 30000014;
const SANSHA = 500019;
const CALDARI = 500001;
const NO_CORP_FACTION = 599999;
const C1 = 91000001;
const C2 = 91000002;
const C3 = 91000003;
const REWARD_ENV = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_NATIVE_INCURSIONS_ENABLED: "1",
  EVEJS_LNE_NATIVE_INCURSIONS_STEER_ENABLED: "1", EVEJS_LNE_NATIVE_INCURSIONS_SETTLE_ENABLED: "1",
  EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_ENABLED: "1", EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_LOYALTY_POINTS: "250",
  EVEJS_LNE_FACTION_INCURSIONS_ENABLED: "1" };

const configCache = new Map();
function resolved(env) {
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env });
    assert.deepStrictEqual(r.errors || [], []);
    configCache.set(key, r);
  }
  return configCache.get(key);
}
const cfg = (env = {}) => resolved({ ...REWARD_ENV, ...env }).config;

const noTimer = () => ({ cancel() {}, hasRef: () => false });

const tale = (taleId, terminal = null) => ({ taleId, generation: 1, constellationId: 20000002, band: "null",
  systemIds: [30000013, TARGET], selectionKey: null, createdAt: T0 - 1000, expiresAt: T0 + 5000, phase: 1,
  influence: 1, terminal });
const term = (outcome) => ({ outcome, eventId: "sansha:x:terminal", decidedAt: T0 + 100, bossReceiptId: null });

function fakes() {
  const st = { tales: [], parts: {}, partCalls: [], controller: CALDARI };
  const adapter = {
    nativeIncursionsSetTargets: () => ({ ok: true, installed: true }),
    nativeIncursionsListTales: () => ({ ok: true, tales: [...st.tales], truncated: false }),
    nativeIncursionsBossParticipants: () => ({ ok: true, characterIds: [] }),
    nativeIncursionsVendorBands: () => ({ ok: true, bands: { high: true, low: true, null: true } }),
    nativeIncursionsStats: () => ({ installed: true, drift: false, hits: 0, passthrough: 0, exclusiveNull: 0,
      errors: 0, steerLog: [] }),
    nativeIncursionsParticipants: (taleId, limit, maxReceipts) => {
      st.partCalls.push([taleId, limit, maxReceipts]);
      return st.parts[taleId] || { ok: false, reason: "TALE_NOT_FOUND" };
    },
  };
  const world = {
    listByOccupier: (_db, factionId) => ({ ok: true, nextAfterSystemId: null,
      systems: factionId === SANSHA ? [{ systemId: TARGET, occupationState: "INVASION" }] : [] }),
    getSystems: (_db, ids) => ({ ok: true, systems: [], missing: ids }),
    getSystem: (db, id, opts) => {
      assert.strictEqual(db.inTransaction, true);
      assert.deepStrictEqual(opts, { includeInfluence: false });
      return { ok: true, system: { systemId: id, controllerFactionId: st.controller } };
    },
  };
  return { st, adapter, world };
}

function boot(store, f, env = {}, heavyRef = { current: null }, extra = {}) {
  const clock = { now: () => T0 };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const lines = [];
  const started = startNativeIncursions({ config: cfg(env), clock, adapter: f.adapter,
    persistence: { ok: true, store, journal }, getWorldRepository: () => f.world, getOccupation: () => null,
    getHeavyEvents: () => heavyRef.current, setTimer: noTimer, logger: { log: (l) => lines.push(l) }, ...extra });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  return { svc: started.nativeIncursions, journal, lines };
}

function heavyOf(store) {
  const clock = { now: () => T0 };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const started = startHeavyEvents({ config: heavyConfigOf(cfg()), clock, setTimer: noTimer, logger: { log() {} },
    getFactionKind: () => "faction",
    ctx: { persistence: { ok: true, store, journal, worldSeed: 7 }, stations: { getMode: () => "ready" } } });
  assert.ok(started.ok, JSON.stringify(started));
  return started.heavyEvents;
}

const one = (store, sql, ...args) => {
  const r = store.transaction("t.read", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const rewardOf = (store, taleId) => {
  const rows = one(store, "SELECT state, outcome, reward_state, reward_reason FROM world_native_incursions "
    + "WHERE tale_id = ?", taleId);
  return rows.length === 1 ? [rows[0].state, rows[0].outcome, rows[0].reward_state, rows[0].reward_reason] : null;
};
const payouts = (store) => one(store, "SELECT payout_key, event_id, character_id, issuer_faction_id, system_id, "
  + "lp_corporation_id, isk_amount, lp_amount, standing_micro, description, isk_state, lp_state, std_state, state "
  + "FROM world_heavy_event_payouts WHERE event_id LIKE 'nincursion:reward:%' ORDER BY payout_key");

function bindThen(svc, f, taleId, outcome) {
  f.st.tales = [tale(taleId)];
  assert.strictEqual(svc.runPass(T0).bound, 1);
  f.st.tales = [tale(taleId, term(outcome))];
}

module.exports = ({ test, skip }) => {
  test("NI13 nativeIncursionsParticipants via real createAdapter + GAME_MODULES: dedup, netLP order, truncated, "
    + "NOT_DEFEATED, TALE_NOT_FOUND", () => {
    const lifecycleEntry = GAME_MODULES.find((e) => e.path === "services/incursion/incursionLifecycle");
    assert.ok(lifecycleEntry.symbols.some((s) => s.name === "getTale" && s.kind === "export" && !s.wrap
      && s.consumers.includes("nativeIncursions")), "getTale in GAME_MODULES (export, no wrap)");
    const storeEntry = GAME_MODULES.find((e) => e.path === "services/incursion/incursionRewardStore");
    assert.ok(storeEntry.symbols.some((s) => s.name === "read" && !s.wrap), "read in GAME_MODULES");
    const receipts = {
      "/receipts/r-a": { participants: [{ characterID: C1, netLP: 10 }, { characterID: C2, netLP: 40 }] },
      "/receipts/r-b": { participants: [{ characterID: C1, netLP: 50 }, { characterID: C3, netLP: 60 }] },
      "/receipts/r-c": { participants: [{ characterID: C3, netLP: 0 }] },
    };
    const tales = {
      7: { taleID: 7, terminal: { outcome: "defeated", receipts: [{ receiptID: "r-a" }, { receiptID: "r-b" },
        { receiptID: "r-c" }, { receiptID: "r-gone" }] } },
      9: { taleID: 9, terminal: { outcome: "expired", receipts: [{ receiptID: "r-a" }] } },
    };
    const abs = (rel) => path.join(SRC, ...`${rel}.js`.split("/"));
    const moduleApi = { _cache: {
      [abs("services/incursion/incursionLifecycle")]: { exports: { listTales: () => [],
        getTale: (id) => (tales[id] ? structuredClone(tales[id]) : null) } },
      [abs("services/incursion/incursionRewardStore")]: { exports: { read: (p) => (receipts[p]
        ? structuredClone(receipts[p]) : undefined) } },
    } };
    const adapter = createAdapter({ moduleApi, existsSync: () => false });
    assert.deepStrictEqual(adapter.setServerSrc(SRC), { ok: true, reason: null });
    assert.deepStrictEqual(adapter.nativeIncursionsParticipants(7, 64, 128),
      { ok: true, characterIds: [C1, C3, C2], truncated: false, receipts: 3 });
    assert.deepStrictEqual(adapter.nativeIncursionsParticipants(7, 2, 128),
      { ok: true, characterIds: [C1, C3], truncated: true, receipts: 3 });
    assert.deepStrictEqual(adapter.nativeIncursionsParticipants(7, 64, 1),
      { ok: true, characterIds: [C2, C1], truncated: true, receipts: 1 }, "maxReceipts: only r-a");
    assert.deepStrictEqual(adapter.nativeIncursionsParticipants(9, 64, 128), { ok: false, reason: "NOT_DEFEATED" });
    assert.deepStrictEqual(adapter.nativeIncursionsParticipants(8, 64, 128), { ok: false, reason: "TALE_NOT_FOUND" });
    assert.strictEqual(adapter.nativeIncursionsParticipants(7, 0, 128).reason, "INCURSION_READ_FAILED");
    const drift = createAdapter({ moduleApi: { _cache: { [abs("services/incursion/incursionLifecycle")]:
      { exports: { listTales: () => [] } } } }, existsSync: () => false });
    drift.setServerSrc(SRC);
    const refused = drift.nativeIncursionsParticipants(7, 64, 128);
    assert.deepStrictEqual([refused.reason, refused.detail], ["INCURSION_RUNTIME_UNAVAILABLE", "getTale missing"]);
    assert.notStrictEqual(adapter.requireGame("services/incursion/incursionLifecycle").reason, "not_in_game_modules");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("NI14-NI16 native incursion rewards", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("NI14 defeated -> PENDING; HEAVY_EVENTS_UNAVAILABLE keeps PENDING; LP rows once, PLANNED; restart = 0 rows",
    () => {
      withStore(driver, (opened) => {
        const store = opened.store;
        const f = fakes();
        const TALE = 8000000000002;
        f.st.parts[TALE] = { ok: true, characterIds: [C2, C1], truncated: false, receipts: 2 };
        const heavyRef = { current: createUnavailableHeavyEvents("stopped") };
        const first = boot(store, f, {}, heavyRef);
        assert.strictEqual(first.svc.getStatus().rewards, "on");
        bindThen(first.svc, f, TALE, "defeated");
        assert.strictEqual(first.svc.runPass(T0 + 200).settled, 1);
        assert.deepStrictEqual(rewardOf(store, TALE), ["SETTLED", "defeated", "PENDING", null]);
        assert.deepStrictEqual(payouts(store), [], "transient refusal: no row");
        assert.deepStrictEqual(f.st.partCalls, [], "Heavy not ready = no vendor read");
        assert.strictEqual(first.svc.getStatus().counters.rewardRetry, 1);

        heavyRef.current = heavyOf(store);
        first.svc.runPass(T0 + 300);
        assert.deepStrictEqual(f.st.partCalls, [[TALE, 64, 128]], "participants read with the config limits");
        const key = NIS.rewardEventIdOf(TALE, 1);
        assert.strictEqual(key, `nincursion:reward:${TALE}:g1`);
        const corp = lpCorporationOf(CALDARI);
        assert.ok(corp > 0);
        const row = (c) => ({ payout_key: `${key}:${c}`, event_id: key, character_id: c, issuer_faction_id: CALDARI,
          system_id: TARGET, lp_corporation_id: corp, isk_amount: 0, lp_amount: 250, standing_micro: 0,
          description: "Living New Eden: incursion defense", isk_state: "SKIPPED", lp_state: "PENDING",
          std_state: "SKIPPED", state: "PENDING" });
        assert.deepStrictEqual(payouts(store).map((r) => ({ ...r, character_id: Number(r.character_id),
          issuer_faction_id: Number(r.issuer_faction_id), system_id: Number(r.system_id),
          lp_corporation_id: Number(r.lp_corporation_id), isk_amount: Number(r.isk_amount),
          lp_amount: Number(r.lp_amount), standing_micro: Number(r.standing_micro) })), [row(C1), row(C2)]);
        assert.deepStrictEqual(rewardOf(store, TALE), ["SETTLED", "defeated", "PLANNED", null]);
        assert.strictEqual(one(store, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", key)
          .map((r) => Number(r.n))[0], 1);
        const c = first.svc.getStatus().counters;
        assert.deepStrictEqual([c.rewardPlanned, c.rewardSkipped, c.rewardRetry], [2, 0, 1]);

        first.svc.runPass(T0 + 400);
        first.svc.stop();
        const second = boot(store, f, {}, heavyRef);
        second.svc.runPass(T0 + 500);
        assert.strictEqual(payouts(store).length, 2, "no new payout row");
        assert.strictEqual(f.st.partCalls.length, 1, "PLANNED is not read again");
        const again = store.transaction("t.replay", (db) => heavyRef.current.planRewardPayoutsInTx(db, {
          eventId: key, issuerFactionId: CALDARI, systemId: TARGET, characterIds: [C1, C2], lpAmount: 250, at: T0 }));
        assert.deepStrictEqual(again.value, { ok: true, planned: 0, lpCorporationId: corp });
        assert.strictEqual(store.transaction("t.bad", (db) => heavyRef.current.planRewardPayoutsInTx(db, {
          eventId: "hev:1", issuerFactionId: CALDARI, systemId: TARGET, characterIds: [C1], lpAmount: 1, at: T0 }))
          .value.reason, "INVALID_INPUT", "prefix white list");
        second.svc.stop();
        heavyRef.current.stop();
      });
    });

  test("NI15 final refusals SKIPPED + reason; expired -> NULL without a participants read", () => {
    withStore(driver, (opened) => {
      const store = opened.store;
      const f = fakes();
      const heavyRef = { current: heavyOf(store) };
      const { svc } = boot(store, f, {}, heavyRef);
      const cases = [
        [8000000000102, null, [C1], "NO_CONTROLLER"],
        [8000000000104, SANSHA, [C1], "SANSHA_CONTROLLER"],
        [8000000000106, NO_CORP_FACTION, [C1], "NO_LP_CORPORATION"],
        [8000000000108, CALDARI, [], "NO_PARTICIPANT"],
        [8000000000110, CALDARI, null, "TALE_NOT_FOUND"],
      ];
      assert.strictEqual(lpCorporationOf(NO_CORP_FACTION), null);
      let at = T0 + 1000;
      for (const [taleId, controller, chars, reason] of cases) {
        f.st.controller = controller;
        if (chars) f.st.parts[taleId] = { ok: true, characterIds: chars, truncated: false, receipts: 1 };
        bindThen(svc, f, taleId, "defeated");
        at += 100;
        svc.runPass(at);
        assert.deepStrictEqual(rewardOf(store, taleId), ["SETTLED", "defeated", "SKIPPED", reason], reason);
      }
      assert.deepStrictEqual(payouts(store), [], "no payout row");
      assert.strictEqual(svc.getStatus().counters.rewardSkipped, cases.length);
      const calls = f.st.partCalls.length;
      bindThen(svc, f, 8000000000112, "expired");
      svc.runPass(T0 + 6000);
      assert.deepStrictEqual(rewardOf(store, 8000000000112), ["SETTLED", "expired", null, null]);
      assert.strictEqual(f.st.partCalls.length, calls, "expired: no participants read");
      svc.stop();
      heavyRef.current.stop();
    });
  });

  test("NI17: heavy not ready = one log line, no vendor read; standing refusals do not block the queue", () => {
    withStore(driver, (opened) => {
      const store = opened.store;
      const f = fakes();
      const [A, B, C] = [8000000000302, 8000000000304, 8000000000306];
      f.st.parts[A] = { ok: false, reason: "INCURSION_READ_FAILED" };
      f.st.parts[B] = { ok: false, reason: "INCURSION_READ_FAILED" };
      f.st.parts[C] = { ok: true, characterIds: [C1], truncated: false, receipts: 1 };
      const heavyRef = { current: createUnavailableHeavyEvents("stopped") };
      const { svc, lines } = boot(store, f, {}, heavyRef);
      let at = T0 + 1000;
      for (const taleId of [A, B, C]) {
        bindThen(svc, f, taleId, "defeated");
        at += 100;
        svc.runPass(at);
        assert.deepStrictEqual(rewardOf(store, taleId), ["SETTLED", "defeated", "PENDING", null]);
      }
      const rewardLines = () => lines.filter((l) => l.includes("reward"));
      const before = rewardLines().length;
      for (let i = 0; i < 3; i += 1) {
        at += 100;
        svc.runPass(at);
      }
      assert.ok(rewardLines().length - before <= 1, JSON.stringify(rewardLines()));
      assert.ok(rewardLines().every((l) => !l.includes(String(A)) && !l.includes(String(B))), "no taleId");
      assert.deepStrictEqual(f.st.partCalls, [], "heavy not ready: no vendor read");

      heavyRef.current = heavyOf(store);
      for (let i = 0; i < 2; i += 1) {
        at += 100;
        svc.runPass(at);
      }
      assert.deepStrictEqual(rewardOf(store, C), ["SETTLED", "defeated", "PLANNED", null]);
      assert.deepStrictEqual([rewardOf(store, A)[2], rewardOf(store, B)[2]], ["PENDING", "PENDING"]);
      svc.stop();
      heavyRef.current.stop();
    });
  });

  test("NI16 migration 123 on a row, flags off = NULL and no read, 5 keys, W247, ROW_BOUND, compose", () => {
    assert.deepStrictEqual(validateMigrations(MIGRATIONS), { ok: true });
    assert.deepStrictEqual([MIGRATIONS[122].version, MIGRATIONS[122].name], [123, "native-incursion-rewards"]);
    const db = new driver.Database(":memory:");
    try {
      NIS.upNativeIncursions(db);
      db.prepare("INSERT INTO world_native_incursions (tale_id, generation, faction_id, constellation_id, "
        + "security_band, target_system_id, steered, state, bound_at, expires_at, outcome, effect, settled_at) "
        + "VALUES (5, 1, 500019, 20000002, 'null', 30000014, 1, 'SETTLED', 1, 2, 'defeated', 'RECORDED', 3)").run();
      NIS.upNativeIncursionRewards(db);
      const r = db.prepare("SELECT reward_state, reward_reason FROM world_native_incursions WHERE tale_id = 5").get();
      assert.deepStrictEqual([r.reward_state, r.reward_reason], [null, null]);
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get("world_native_incursions_reward"), "partial index");
    } finally {
      db.close();
    }

    const rows = config.SCHEMA.filter((row) => row.key.startsWith("nativeIncursions.rewards."));
    assert.deepStrictEqual(rows.map((row) => [row.key.slice(25), row.default, row.min, row.max]), [
      ["enabled", false, undefined, undefined], ["loyaltyPoints", 0, 0, 1000000],
      ["maxRewardedParticipants", 64, 1, 256], ["maxReceipts", 128, 1, 512], ["maxPerPass", 2, 1, 8]]);
    const w = (env) => resolved({ EVEJS_DATA_ROOT: os.tmpdir(), ...env }).warnings.filter((x) => x.includes("W247"));
    const on = { EVEJS_LNE_NATIVE_INCURSIONS_ENABLED: "1", EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_ENABLED: "1",
      EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_LOYALTY_POINTS: "10" };
    assert.strictEqual(w(on).length, 1);
    const pump = { ...on, EVEJS_LNE_HEAVY_EVENTS_ENABLED: "1", EVEJS_LNE_SITES_ENABLED: "1" };
    assert.strictEqual(w(pump).length, 0);
    assert.strictEqual(w({ ...pump, EVEJS_LNE_HEAVY_EVENTS_PAYOUT_ENABLED: "0" }).length, 1);
    assert.strictEqual(w({ ...pump, EVEJS_LNE_SITES_ENABLED: "0" }).length, 1, "sites off");
    assert.strictEqual(w({ ...pump, EVEJS_LNE_WORLD_ENABLED: "0" }).length, 1, "world off");
    assert.strictEqual(w({ ...on, EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_LOYALTY_POINTS: "0" }).length, 0);
    const S = settingsOf(cfg().nativeIncursions).settings;
    assert.deepStrictEqual(rewardsModeOf(S, { maxRowsPerTransaction: 10 }), { mode: "ROW_BOUND", bound: 66, maxRows: 10 });
    assert.strictEqual(rewardsModeOf(S, { maxRowsPerTransaction: 500 }).mode, "on");
    assert.strictEqual(rewardsModeOf(settingsOf(cfg({ EVEJS_LNE_NATIVE_INCURSIONS_SETTLE_ENABLED: "0" })
      .nativeIncursions).settings, null).mode, "off");

    withStore(driver, (opened) => {
      for (const env of [{ EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_ENABLED: "0" },
        { EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_LOYALTY_POINTS: "0" }]) {
        const f = fakes();
        delete f.adapter.nativeIncursionsParticipants;
        const taleId = env.EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_ENABLED ? 8000000000202 : 8000000000204;
        const { svc, lines } = boot(opened.store, f, env);
        assert.strictEqual(svc.getStatus().rewards, "off");
        assert.ok(!lines.some((l) => l.includes("rewards=")), "start line as");
        bindThen(svc, f, taleId, "defeated");
        svc.runPass(T0 + 200);
        assert.deepStrictEqual(rewardOf(opened.store, taleId), ["SETTLED", "defeated", null, null]);
        assert.strictEqual(svc.getStatus().counters.rewardRetry, 0);
        svc.stop();
      }
      const f = fakes();
      const limited = { ...opened.store, limits: { ...opened.store.limits, maxRowsPerTransaction: 10 } };
      const { svc, lines } = boot(limited, f);
      assert.strictEqual(svc.getStatus().rewards, "ROW_BOUND");
      assert.strictEqual(lines.filter((l) => l.includes("rewards off - ROW_BOUND 66")).length, 1);
      svc.stop();
    });

    const composeFile = findCompose();
    if (!composeFile) return;
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    for (const suffix of ["ENABLED", "LOYALTY_POINTS", "MAX_REWARDED_PARTICIPANTS", "MAX_RECEIPTS", "MAX_PER_PASS"]) {
      const key = `EVEJS_LNE_NATIVE_INCURSIONS_REWARDS_${suffix}`;
      assert.ok(Object.prototype.hasOwnProperty.call(env, key), `compose env ${key}`);
      assert.ok(text.includes(`\${${key}:-}`), `compose \${${key}:-}`);
    }
  });
};
