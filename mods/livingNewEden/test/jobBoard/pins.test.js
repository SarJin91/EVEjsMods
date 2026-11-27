"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { seedDbFile } = require("../_support/dbTemplate");
const { resolveConfig } = require("../../config");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { startFrontJobs } = require("../../lib/frontJobs");
const { payoutKeyOf } = require("../../lib/frontJobs/schema");
const { startWarContracts } = require("../../lib/warContracts");
const { createWarContractRepository } = require("../../lib/warContracts/repository");
const { startJobBoard } = require("../../lib/jobBoard");
const { createPinRepository } = require("../../lib/jobBoard/pinRepository");
const { buildSnapshot } = require("../../lib/jobBoard/readModel");
const { toWireV1, LEN } = require("../../lib/jobBoard/wire");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const CALDARI = 500001;
const GURISTAS = 500010;
const S1 = 30000001;
const S2 = 30000002;
const CHAR = 90000001;
const OTHER = 90000002;
const STEP = 1000;
const pins = createPinRepository();
const wcRepo = createWarContractRepository();

const front = (systemId, controller, occupier, previous) => ({ systemId, controllerFactionId: controller,
  occupierFactionId: occupier, previousControllerFactionId: previous, occupationState: "INVASION" });
const FRONTS = [front(S1, GURISTAS, CALDARI, null), front(S2, CALDARI, null, GURISTAS)];

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_JOB_BOARD_ENABLED: "1", EVEJS_LNE_FRONT_JOBS_ENABLED: "1",
    EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1", EVEJS_LNE_FRONT_JOBS_KILL_TARGET: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function fakeWorld() {
  return { repository: { listActiveOccupations(_tx, opts) {
    const rows = FRONTS.filter((f) => f.systemId > opts.afterSystemId).slice(0, opts.limit);
    return { ok: true, systems: rows, nextAfterSystemId: null };
  } } };
}

function fakeAdapter() {
  const adapter = {
    handlers: null,
    boardHookState: () => ({ status: "WRAPPED" }),
    publishBoardDelivery: () => ({ ok: true, bytes: 1, delivery: { setReady() {},
      stats: () => ({ ready: true, composed: 0, skipped: 0 }) } }),
    withdrawBoardDelivery: () => ({ ok: true }),
    registerClientService(_world, spec) {
      adapter.handlers = spec.handlers;
      return { ok: true, unregister() {} };
    },
    sendClientNotification: () => ({ ok: true }),
    installChatCommand: () => ({ ok: true }),
    uninstallChatCommand: () => ({ ok: true }),
    readFactionNames: () => ({ ok: true, names: new Map() }),
  };
  return adapter;
}

function rig(store, clock, env) {
  const config = configOf(env);
  const setTimer = () => ({ cancel() {}, hasRef: () => false });
  const ctx = { persistence: { ok: true, store, worldSeed: 4242 }, world: fakeWorld(),
    governor: { admits: () => true } };
  const fj = startFrontJobs({ config, ctx, clock, adapter: null, setTimer });
  assert.ok(fj.ok, JSON.stringify(fj));
  ctx.frontJobs = fj.frontJobs;
  const wc = startWarContracts({ config, ctx, clock, adapter: null, setTimer });
  assert.ok(wc.ok, JSON.stringify(wc));
  ctx.warContracts = wc.warContracts;
  const adapter = fakeAdapter();
  const jb = startJobBoard({ config, ctx, adapter, clock, world: {} });
  return { ctx, jb, h: adapter.handlers, stop() {
    if (jb.ok) jb.jobBoard.stop("test");
    wc.warContracts.stop("test");
    fj.frontJobs.stop("test");
  } };
}

const all = (store, sql, ...args) => {
  const r = store.transaction("t", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value.map((row) => ({ ...row }));
};
const pinRows = (store) => all(store, "SELECT character_id, job_ref, expires_at FROM world_job_board_pins "
  + "ORDER BY character_id, job_ref");
const jobIds = (store) => all(store, "SELECT job_id FROM world_front_jobs WHERE state = 'OPEN' ORDER BY slot")
  .map((r) => r.job_id);
const req = (args, characterId = CHAR) => ({ characterId, systemId: S1, args });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("JP1-JP3 pins on a real store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("JP1 Pin x2 -> one row + already; PIN_LIMIT; JOB_NOT_OPEN; BAD_REF; Unpin of nothing; migration + WIPE", () => {
      assert.deepStrictEqual([MIGRATIONS[100].version, MIGRATIONS[100].name], [101, "job_board_pins"]);
      assert.strictEqual(TABLE_POLICY.world_job_board_pins, ACTION.WIPE);
      withStore(driver, ({ store }) => {
        const clock = { t: AT, now() { return this.t; } };
        const r = rig(store, clock, { EVEJS_LNE_JOB_BOARD_MAX_PINS_PER_CHARACTER: "1" });
        try {
          const [a, b] = jobIds(store);
          assert.ok(a && b, "two OPEN jobs");
          const { Pin, Unpin } = r.h;
          assert.deepStrictEqual(Pin(req([a])), { ok: true, already: false });
          assert.deepStrictEqual(Pin(req([a])), { ok: false, reason: "RATE_LIMIT" }, "own window");
          clock.t += STEP;
          assert.deepStrictEqual(Pin(req([a])), { ok: true, already: true });
          assert.strictEqual(pinRows(store).length, 1);
          clock.t += STEP;
          assert.deepStrictEqual(Pin(req([b])), { ok: false, reason: "PIN_LIMIT" });
          clock.t += STEP;
          assert.deepStrictEqual(Pin(req([a])), { ok: true, already: true }, "repeat at the full limit");
          store.transaction("t", (db) => db.prepare("UPDATE world_front_jobs SET state = 'FILLED' WHERE job_id = ?")
            .run(b));
          for (const ref of [b, "fj:0:9:1"]) {
            clock.t += STEP;
            assert.deepStrictEqual(Pin(req([ref])), { ok: false, reason: "JOB_NOT_OPEN" }, ref);
          }
          for (const bad of [["wc:1"], ["ab"], [`fj:${"x".repeat(62)}`], [12345], "fj:x", null]) {
            assert.deepStrictEqual(Pin(req(bad)), { ok: false, reason: "BAD_REF" }, JSON.stringify(bad));
          }
          assert.deepStrictEqual(Pin({ ...req([a]), badArgs: true }), { ok: false, reason: "BAD_REF" });
          assert.deepStrictEqual(Pin(req([a], 0)), { ok: false, reason: "NO_CHARACTER" });
          clock.t += STEP;
          assert.deepStrictEqual(Unpin(req(["fj:0:9:1"])), { ok: true, already: true });
          clock.t += STEP;
          assert.deepStrictEqual(Unpin(req([a])), { ok: true, already: false });
          assert.deepStrictEqual(pinRows(store), []);
          const c = r.jb.jobBoard.getStatus().counters;
          assert.deepStrictEqual([c.pins, c.pinsAlready, c.unpins, c.pinRefused], [1, 2, 2, 12]);
          assert.strictEqual(r.jb.jobBoard.getStatus().pins, "on");
        } finally {
          r.stop();
        }
      });
    });

    test("JP2 restart sees the pin; expired pin goes at GetBoard; Pin prunes <= batch; refusal keeps pins; flags off",
      () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-pins-"));
        const file = path.join(tmp, "world.sqlite");
        const open = () => {
          const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
            busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
            migrations: MIGRATIONS });
          assert.ok(o.ok, JSON.stringify(o));
          return o.store;
        };
        const clock = { t: AT, now() { return this.t; } };
        try {
          seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
          let store = open();
          let r = rig(store, clock, { EVEJS_LNE_JOB_BOARD_PIN_PRUNE_BATCH: "10" });
          const [a, b] = jobIds(store);
          assert.deepStrictEqual(r.h.Pin(req([a])), { ok: true, already: false });
          r.stop();
          store.close("test_restart");
          store = open();
          r = rig(store, clock, { EVEJS_LNE_JOB_BOARD_PIN_PRUNE_BATCH: "10" });
          try {
            clock.t += STEP;
            const board = r.h.GetBoard(req([]));
            assert.strictEqual(board.ui.pins, true);
            assert.deepStrictEqual(board.mine.map((m) => [m.ref, m.pin]), [[a, 2]], "pin after the restart");
            assert.ok(!board.jobs.some((j) => j.ref === a), "not twice");
            assert.deepStrictEqual(board.jobs.map((j) => [j.ref, j.pin]), [[b, 1]]);
            store.transaction("t", (db) => {
              pins.insertInTx(db, { characterId: CHAR, jobRef: b, pinnedAt: AT, expiresAt: clock.t - 1 });
              for (let i = 0; i < 15; i += 1) {
                pins.insertInTx(db, { characterId: OTHER + i, jobRef: "fj:old", pinnedAt: AT, expiresAt: AT - i });
              }
            });
            clock.t += STEP;
            r.h.GetBoard(req([]));
            assert.deepStrictEqual(pinRows(store).filter((p) => p.character_id === CHAR).map((p) => p.job_ref), [a]);
            assert.strictEqual(r.jb.jobBoard.getStatus().counters.pinsPruned, 1);
            clock.t += STEP;
            assert.deepStrictEqual(r.h.Pin(req([a])), { ok: true, already: true });
            assert.strictEqual(pinRows(store).filter((p) => p.job_ref === "fj:old").length, 5);
            store.transaction("t", (db) => db.prepare("UPDATE world_front_jobs SET state = 'FILLED' WHERE job_id = ?")
              .run(a));
            const real = r.ctx.frontJobs;
            r.ctx.frontJobs = { ...real, listBoard: () => ({ ok: false, reason: "FRONT_JOBS_UNAVAILABLE" }) };
            clock.t += STEP;
            const refused = r.h.GetBoard(req([]));
            assert.ok(refused.refusals.includes("frontJobs:FRONT_JOBS_UNAVAILABLE"), JSON.stringify(refused.refusals));
            assert.ok(pinRows(store).some((p) => p.character_id === CHAR && p.job_ref === a), "kept on a refusal");
            r.ctx.frontJobs = real;
            clock.t += STEP;
            r.h.GetBoard(req([]));
            assert.ok(!pinRows(store).some((p) => p.character_id === CHAR), "FILLED pin dropped");
          } finally {
            r.stop();
            store.close("test_cleanup");
          }
          store = open();
          r = rig(store, clock, { EVEJS_LNE_JOB_BOARD_PINS_ENABLED: "0" });
          try {
            clock.t += STEP;
            assert.deepStrictEqual(r.h.Pin(req([b])), { ok: false, reason: "PINS_DISABLED" });
            const board = r.h.GetBoard(req([]));
            assert.strictEqual(board.ui.pins, false);
            assert.ok(Array.isArray(board.mine));
            assert.ok([...board.jobs, ...board.mine].every((j) => j.pin === 0));
            assert.strictEqual(r.jb.jobBoard.getStatus().pins, "off");
            assert.ok(!pinRows(store).some((p) => p.character_id === CHAR));
          } finally {
            r.stop();
          }
          r = rig(store, clock, { EVEJS_LNE_JOB_BOARD_ENABLED: "0" });
          try {
            assert.deepStrictEqual([r.jb.ok, r.jb.reason, r.h], [false, "disabled_by_config", null]);
            assert.ok(!pinRows(store).some((p) => p.character_id === CHAR));
          } finally {
            r.stop();
            store.close("test_cleanup");
          }
        } finally {
          try {
            fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
          } catch (_err) {
          }
        }
      });

    test("JP3 payouts unchanged with and without a pin (digest); listDoneForBoard payout state; Mine rewards", () => {
      const run = (withPin) => withStore(driver, ({ store }) => {
        const clock = { t: AT, now() { return this.t; } };
        const r = rig(store, clock, {});
        try {
          const [a] = jobIds(store);
          const job = all(store, "SELECT system_id, target_faction_id FROM world_front_jobs WHERE job_id = ?", a)[0];
          if (withPin) assert.deepStrictEqual(r.h.Pin(req([a])), { ok: true, already: false });
          clock.t += STEP;
          const kill = r.ctx.frontJobs.onNpcKill({ characterId: CHAR, victimFactionId: job.target_faction_id,
            systemId: job.system_id,
            atMs: clock.t, rewardable: true });
          assert.strictEqual(kill.outcome, "COMPLETED", JSON.stringify(kill));
          store.transaction("t", (db) => {
            assert.ok(wcRepo.insertOpenInTx(db, { offerId: "to_jp3", factionId: CALDARI, stationId: "npc-1",
              systemId: S2, itemKind: "hull", itemKey: "type:621", typeId: 621, quantity: 2, iskTotal: 1000,
              lpCorporationId: null, iskAmount: 0, lpAmount: 1500, standingMicro: 10000,
              description: "Living New Eden: war contract 2x Caracal for Caldari State", at: clock.t }).ok);
            assert.ok(wcRepo.settleInTx(db, { offerId: "to_jp3", expectedVersion: 1, to: "AWARDED", characterId: CHAR,
              legs: { isk: "SKIPPED", lp: "PENDING", std: "PENDING" }, payoutState: "PENDING", at: clock.t + 1 })
              .changed);
          });
          clock.t += STEP;
          const done = r.ctx.frontJobs.listDoneForBoard(null, { characterId: CHAR, sinceMs: AT, limit: 10 });
          const pay = all(store, "SELECT state FROM world_front_job_payouts WHERE payout_key = ?", payoutKeyOf(a, CHAR));
          assert.deepStrictEqual(done.rows.map((d) => [d.jobId, d.payoutState]), [[a, pay[0].state]]);
          const board = r.h.GetBoard(req([]));
          assert.deepStrictEqual(board.mine.map((m) => [m.ref, m.kind, m.state, m.progress, m.endsIn, m.pin]),
            [["wc:to_jp3", "WAR", "PENDING", "done", 0, 0], [a, "PAID", pay[0].state, "done", 0, 0]]);
          assert.ok(!board.jobs.some((j) => j.ref === a), "the DONE job only in Mine");
          if (withPin) {
            assert.deepStrictEqual(all(store, "SELECT state FROM world_front_jobs WHERE job_id = ?", a), [{ state: "OPEN" }]);
            assert.ok(!pinRows(store).some((p) => p.character_id === CHAR), "the pin of the DONE job is deleted");
            assert.strictEqual(r.jb.jobBoard.getStatus().counters.pinsPruned, 1);
            clock.t += STEP;
            assert.deepStrictEqual(r.h.Pin(req([a])), { ok: false, reason: "JOB_NOT_OPEN" });
            assert.deepStrictEqual(pinRows(store), []);
          }
          return JSON.stringify(["world_front_job_progress", "world_front_job_payouts", "world_war_contracts"]
            .map((t) => all(store, `SELECT * FROM ${t} ORDER BY 1, 2`)));
        } finally {
          r.stop();
        }
      });
      assert.strictEqual(run(true), run(false));
    });

    test("JP5 Pin prunes at most min(pinPruneBatch, maxRowsPerTransaction - maxPinsPerCharacter - 1)",
      () => {
        withStore(driver, ({ store }) => {
          const clock = { t: AT, now() { return this.t; } };
          const r = rig(store, clock, { EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "500",
            EVEJS_LNE_JOB_BOARD_PIN_PRUNE_BATCH: "5000" });
          try {
            const [a] = jobIds(store);
            for (let part = 0; part < 2; part += 1) {
              const w = store.transaction("t", (db) => {
                for (let i = 0; i < 300; i += 1) {
                  pins.insertInTx(db, { characterId: OTHER + part * 300 + i, jobRef: "fj:old", pinnedAt: AT,
                    expiresAt: AT - 1 });
                }
              });
              assert.ok(w.ok, JSON.stringify(w));
            }
            assert.deepStrictEqual(r.h.Pin(req([a])), { ok: true, already: false }, "no TX_ROW_LIMIT");
            const maxPins = configOf().jobBoard.maxPinsPerCharacter;
            assert.strictEqual(pinRows(store).filter((p) => p.job_ref === "fj:old").length, 600 - (500 - maxPins - 1));
          } finally {
            r.stop();
          }
        });
      });
  }

  test("JP4 read model: Mine groups, maxMineRows + more.mine, no duplicates, pin 0/1/2, rewards by time; wire", () => {
    const now = AT;
    const job = (over) => ({ jobId: "fj:1:0:1", kind: "KILL", state: "OPEN", systemId: S1, targetCount: 5,
      iskAmount: 1000000, lpAmount: 0, completions: 0, maxCompletions: 10, description: "Kill pirates",
      expiresAt: now + 7200000, myProgress: 0, myState: null, ...over });
    const jobs = { ok: true, jobs: [
      job({ jobId: "fj:1:0:1" }),
      job({ jobId: "fj:1:1:1", expiresAt: now + 3600000 }),
      job({ jobId: "fj:1:2:1", myProgress: 2, myState: "ACTIVE" }),
      job({ jobId: "fj:1:3:1", state: "FILLED" }),
      job({ jobId: "fj:1:4:1", myProgress: 5, myState: "DONE" }),
      job({ jobId: "fj:1:5:1", description: `Zaz ${"y".repeat(200)}` }),
    ] };
    const input = { now, viewer: { characterId: CHAR, systemId: S1 }, jobs, wars: { ok: true, rows: [] },
      jumpsOf: () => 0, names: { system: () => "Here", faction: () => null }, pinsOn: true,
      pins: { ok: true, rows: [{ jobRef: "fj:1:0:1" }, { jobRef: "fj:1:1:1" }] },
      done: { ok: true, rows: [{ jobId: "fj:1:4:1", kind: "KILL", description: "Kill pirates", systemId: S1,
        iskAmount: 1000000, lpAmount: 0, doneAt: now - 5000, payoutState: null }] },
      awards: { ok: true, rows: [{ offerId: "to_9", systemId: S2, description: "Living New Eden: war contract 1x Rifter",
        lpAmount: 100, iskAmount: 0, standingMicro: 0, awardedAt: now - 1000, payoutState: "PAID" }] },
      limits: { maxJobRows: 10, maxWarRows: 10, maxMineRows: 4 } };
    const s = buildSnapshot(input);
    assert.deepStrictEqual(s.mine.map((m) => [m.ref, m.pin, m.kind]), [["fj:1:1:1", 2, "KILL"], ["fj:1:0:1", 2, "KILL"],
      ["fj:1:2:1", 1, "KILL"], ["wc:to_9", 0, "WAR"]]);
    assert.strictEqual(s.more.mine, 1, "the front reward is cut");
    assert.deepStrictEqual(s.jobs.map((j) => [j.ref, j.pin]), [["fj:1:4:1", 0], ["fj:1:3:1", 0], ["fj:1:5:1", 1]]);
    assert.deepStrictEqual([s.mine[3].state, s.mine[3].title, s.mine[3].reward, s.mine[3].endsIn],
      ["PAID", "1x Rifter", "+100 LP", 0]);
    const wide = buildSnapshot({ ...input, limits: { ...input.limits, maxMineRows: 10 } });
    assert.deepStrictEqual(wide.mine.slice(3).map((m) => [m.ref, m.kind, m.state]),
      [["wc:to_9", "WAR", "PAID"], ["fj:1:4:1", "PAID", "PENDING"]]);
    assert.deepStrictEqual(wide.jobs.map((j) => j.ref), ["fj:1:3:1", "fj:1:5:1"]);
    const off = buildSnapshot({ ...input, pinsOn: false, awards: { ok: false, reason: "WAR_CONTRACTS_UNAVAILABLE" } });
    assert.ok([...off.jobs, ...off.mine].every((j) => j.pin === 0));
    assert.deepStrictEqual(off.mine.map((m) => m.ref), ["fj:1:2:1", "fj:1:4:1"]);
    assert.deepStrictEqual(off.refusals, ["mine:WAR_CONTRACTS_UNAVAILABLE"]);
    const wire = toWireV1(s, { pollMs: 15000, travel: true, contracts: true, pins: true });
    assert.deepStrictEqual([wire.v, wire.ui.pins, wire.more], [1, true, { jobs: 0, wars: 0, mine: 1 }]);
    assert.strictEqual(wire.mine.length, 4);
    const text = JSON.stringify(wire);
    assert.ok(/^[\x20-\x7e]*$/.test(text), "ASCII");
    for (const row of [...wire.jobs, ...wire.mine]) {
      assert.ok(row.title.length <= LEN.title && row.ref.length <= LEN.ref && [0, 1, 2].includes(row.pin));
    }
    const old = toWireV1(buildSnapshot({ ...input, pins: undefined, done: undefined, awards: undefined }), {});
    assert.ok(!("mine" in old) && !("mine" in old.more), "no Mine without its inputs");
  });
};
