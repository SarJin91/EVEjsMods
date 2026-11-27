"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { startStandings } = require("../../lib/world/standings");
const S = require("../../lib/world/standings/schema");
const { planCharacterPrune } = require("../../lib/world/standings/pruneRules");
const { createStandingsService } = require("../../lib/world/standings/standingsService");
const { STANDINGS_DATA_V1 } = require("../../lib/world/standings/data/standingsData");
const { applyStandingGrantFrom } = require("../../lib/adapter/standingWrite");
const { listReceiptKeysFrom, pruneReceiptsFrom } = require("../../lib/adapter/receiptPrune");
const { createAdapter } = require("../../lib/adapter");
const killObservation = require("../../lib/adapter/killObservation");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const PIRATES = Object.freeze(new Set([500010, 500011, 500012, 500019, 500020, 500025]));
const GURISTAS = 500010;
const DAY = S.DAY_MS;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

function fakeVendor() {
  const records = new Map();
  const v = { calls: 0, updates: 0, writeError: false, records,
    applyStandingChanges(characterID, changes, options) {
      v.calls += 1;
      const rec = records.get(characterID) || { standingOperationReceipts: {} };
      records.set(characterID, rec);
      const key = options.idempotencyKey;
      const fp = JSON.stringify({ characterID, changes, disableDerived: options.disableDerived === true,
        preservePrecision: options.preservePrecision === true });
      const receipts = rec.standingOperationReceipts || {};
      if (receipts[key]) {
        if (receipts[key].fingerprint !== fp) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
        return { success: true, duplicate: true, data: { appliedChanges: [] } };
      }
      rec.standingOperationReceipts = { ...receipts, [key]: { fingerprint: fp, result: {}, createdAt: "t" } };
      return { success: true, data: { appliedChanges: [] } };
    },
    peekCharacterRecord: (id) => records.get(id) || null,
    updateCharacterRecord(id, updater) {
      v.updates += 1;
      const cur = records.get(id);
      if (!cur) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
      const next = updater(JSON.parse(JSON.stringify(cur)));
      if (v.writeError) return { success: false, errorMsg: "WRITE_ERROR" };
      records.set(id, next);
      return { success: true, data: next };
    },
    receipts: (id) => Object.keys((records.get(id) || {}).standingOperationReceipts || {}).sort() };
  return v;
}

function fakeAdapter(v) {
  return {
    applyStandingGrant: (grant, data) => applyStandingGrantFrom(v, grant, data),
    checkStandingWrite: () => ({ ok: true }),
    readPirateFactionIds: () => ({ ok: true, ids: PIRATES }),
    listStandingReceiptKeys: (c, prefix) => listReceiptKeysFrom(v, c, prefix),
    pruneStandingReceipts: (c, keys) => pruneReceiptsFrom(v, c, keys),
    checkReceiptPrune: () => ({ ok: true }),
  };
}

function bootP(opened, shared, v, envOver = {}) {
  const config = configOf(envOver);
  const env = H.boot(opened, shared);
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const captured = {};
  const scheduler = { ...env.scheduler, registerHandler(type, fn, opts) {
    captured[type] = fn;
    return env.scheduler.registerHandler(type, fn, opts);
  } };
  const lines = [];
  const r = startStandings({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, adapter: fakeAdapter(v),
    logger: { log: (l) => lines.push(l) }, nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...env, repo, standings: r.standings, captured, config, lines };
}

function seedSystem(env, systemId, controller) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: [{ factionId: controller, influenceScore: 60 }] }, `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const outboxRows = (env) => env.tx((db) => db.prepare(`SELECT journal_id AS id, idempotency_key AS k, state FROM
  world_event_journal WHERE event_type = ? ORDER BY idempotency_key`).all(S.EVENT_TYPE));
const eventsOf = (env, type) => env.tx((db) => db.prepare(`SELECT idempotency_key AS k, state, payload,
  created_at AS createdAt, due_at AS dueAt FROM world_scheduled_events WHERE event_type = ? ORDER BY idempotency_key`)
  .all(type));

async function passesAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

function functionBody(source, name) {
  const start = source.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, `${name} declared`);
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\}/m));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const { S: SYS } = H;

  test("P1 rules: prune matrix (pending, grace, open/closed day, orphans, undecided, foreign), keys, STALE_KILL edge",
    () => {
      const retentionMs = DAY;
      const receiptGraceMs = 600000;
      const now = S.dayEndMs(10) + DAY + 5;
      const k = (day, slot) => `lne:std:7:${day}:500001:30000001:${slot}`;
      const row = (key, state, appliedAt, extra = {}) => ({ journalId: key.length + Number(key.slice(-1)), key,
        kind: "OUTBOX", eventType: S.EVENT_TYPE, state, createdAt: appliedAt === null ? now - DAY : appliedAt - 1,
        appliedAt, ...extra });
      const pend = k(10, "k100.1");
      const fresh = k(11, "k200.1");
      const graceOpen = k(11, "k201.2");
      const closedR = k(10, "k101.3");
      const closedNoR = k(10, "k102.4");
      const orphanOld = k(10, "k103.5");
      const orphanNew = k(11, "k202.6");
      const foreign = k(10, "k104.7");
      const undecided = k(9, "k1.8");
      const rows = [row(pend, "PENDING", null), row(fresh, "APPLIED", now - 1000),
        row(graceOpen, "APPLIED", now - receiptGraceMs), row(closedR, "APPLIED", now - 2 * DAY),
        row(closedNoR, "FAILED", null), row(foreign, "APPLIED", now - 2 * DAY, { eventType: "OTHER" })];
      const plan = planCharacterPrune({ now, retentionMs, receiptGraceMs, rows, scanComplete: false,
        lastScannedKey: k(11, "k202.9"), receiptKeys: [pend, fresh, graceOpen, closedR, orphanOld, orphanNew,
          undecided] });
      assert.deepStrictEqual(plan.receiptsToDelete.sort(), [closedR, orphanOld, graceOpen].sort());
      assert.deepStrictEqual(plan.rowsIfReceiptGone.map((r) => r.key).sort(), [closedNoR, closedR].sort());
      assert.deepStrictEqual(plan.kept, { pending: 1, fresh: 1, openDay: 1, foreign: 1, unparsed: 0, undecided: 1 });
      assert.strictEqual(plan.orphans, 1);
      const cont = planCharacterPrune({ now, retentionMs, receiptGraceMs, rows: [], scanComplete: true,
        lastScannedKey: null, afterKey: k(10, "k999"), receiptKeys: [orphanOld, "lne:std:7:bad"] });
      assert.deepStrictEqual([cont.receiptsToDelete, cont.kept.undecided, cont.kept.unparsed], [[], 1, 1]);
      assert.deepStrictEqual(S.parseGrantKey(k(10, "1234")), { characterId: 7, day: 10, factionId: 500001,
        systemId: 30000001, slot: "1234" });
      assert.strictEqual(S.parseGrantKey(k(10, "k5.77")).slot, "k5.77");
      assert.strictEqual(S.parseGrantKey(k(10, "k5")).slot, "k5");
      for (const bad of ["lne:std:7:x", "lne:stdprune:300000:1", k(10, "k5.")]) {
        assert.strictEqual(S.parseGrantKey(bad), null, bad);
      }
      assert.ok(S.pruneKey(300000, 9) > S.KEY_RANGE_END && S.charRange(7).to === "lne:std:7;");
      assert.strictEqual(S.STALE_KILL_MS, DAY);
      let txCalls = 0;
      const svc = createStandingsService({ store: { transaction: () => {
        txCalls += 1;
        return { ok: false, reason: "FAKE" };
      } }, journal: {}, repository: {}, scheduler: {}, adapter: {}, clock: { now: () => 10 * DAY },
      config: configOf(), pirateIds: PIRATES, data: STANDINGS_DATA_V1 });
      const kill = (atMs) => svc.onNpcKill({ characterId: 7, victimFactionId: GURISTAS, systemId: 30000001, atMs });
      assert.strictEqual(kill(9 * DAY).reason, "STANDINGS_TX_FAILED");
      assert.deepStrictEqual([kill(9 * DAY - 1).outcome, txCalls], ["STALE_KILL", 1]);
      assert.strictEqual(svc.getStatus().counters.staleKill, 1);
    });

  test("P2 adapter receipt seam: own lne: keys only, no write without a change, refusals; vendor facts", () => {
    const v = fakeVendor();
    const a = "lne:std:7:1:500001:30000001:k1.1";
    const b = "lne:std:7:1:500001:30000001:k2.2";
    const vendorKey = "agent-mission-quit:42";
    v.records.set(7, { name: "x", standingOperationReceipts: { [a]: {}, [b]: {}, [vendorKey]: {} } });
    assert.deepStrictEqual(listReceiptKeysFrom(v, 7, "lne:std:7:"), { ok: true, found: true, keys: [a, b] });
    assert.strictEqual(listReceiptKeysFrom(v, 7, "agent-").reason, "PREFIX_FOREIGN");
    assert.deepStrictEqual(listReceiptKeysFrom(v, 99, "lne:std:"), { ok: true, found: false, keys: [] });
    assert.deepStrictEqual(pruneReceiptsFrom(v, 7, [a]), { ok: true, removed: 1, written: true });
    assert.deepStrictEqual([v.receipts(7), v.records.get(7).name], [[vendorKey, b].sort(), "x"]);
    const r = pruneReceiptsFrom(v, 7, [b, vendorKey]);
    assert.deepStrictEqual([r.reason, r.permanent, v.updates, v.receipts(7)], ["KEY_FOREIGN", true, 1,
      [vendorKey, b].sort()], "a foreign key refuses the whole call");
    assert.deepStrictEqual(pruneReceiptsFrom(v, 7, ["lne:std:7:none"]), { ok: true, removed: 0, written: false });
    assert.strictEqual(v.updates, 1, "nothing present -> no update call");
    const gone = { ...v, peekCharacterRecord: () => v.records.get(7),
      updateCharacterRecord: () => ({ success: false, errorMsg: "CHARACTER_NOT_FOUND" }) };
    assert.deepStrictEqual(pruneReceiptsFrom(gone, 7, [b]), { ok: false, reason: "CHARACTER_NOT_FOUND",
      permanent: true });
    const boom = { peekCharacterRecord: () => v.records.get(7), updateCharacterRecord: () => {
      throw new Error("boom");
    } };
    assert.deepStrictEqual([pruneReceiptsFrom(boom, 7, [b]).reason, pruneReceiptsFrom(boom, 7, [b]).permanent],
      ["RECEIPT_THREW", false]);
    assert.strictEqual(listReceiptKeysFrom({ peekCharacterRecord: () => {
      throw new Error("x");
    } }, 7, "lne:std:").reason, "RECEIPT_READ_THREW");
    assert.strictEqual(pruneReceiptsFrom({ peekCharacterRecord: v.peekCharacterRecord }, 7, [b]).reason,
      "SEAM_UNAVAILABLE");

    const cs = fs.readFileSync(path.join(SERVER_SRC, "services", "character", "characterState.js"), "utf8");
    const block = cs.slice(cs.search(/^module\.exports = \{/m));
    const exportsBlock = block.slice(0, block.search(/^\};/m));
    for (const name of ["peekCharacterRecord", "updateCharacterRecord"]) {
      assert.match(exportsBlock, new RegExp(`^ {2}${name},`, "m"), `${name} exported`);
    }
    assert.ok(functionBody(cs, "updateCharacterRecord").includes("updater(cloneValue(currentRecord))"));
    assert.ok(!functionBody(cs, "peekCharacterRecord").includes("cloneValue"), "peek is by reference");
    assert.ok(functionBody(cs, "normalizeCharacterRecord").includes("...record"), "receipts survive normalize");
    const sr = fs.readFileSync(path.join(SERVER_SRC, "services", "character", "standingRuntime.js"), "utf8");
    assert.ok(sr.includes("receipts[idempotencyKey]"), "a duplicate is recognised by the receipt only");
  });

  needsDriver("P3 life cycle: receipt after grace, rows after day + retention, STALE_KILL, chain, idle second run",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const v = fakeVendor();
      const env = bootP(reopen(), shared, v);
      seedSystem(env, SYS.N5, GURISTAS);
      const { pruneIntervalMs: I, receiptGraceMs: G, retentionMs: R } = env.config.standings;
      const base = shared.clock.now();
      const kill = { characterId: 7, victimFactionId: GURISTAS, systemId: SYS.N5, atMs: base, victimId: 501 };
      assert.strictEqual(env.standings.onNpcKill(kill).outcome, "GRANTED");
      await passesAt(env, shared, base);
      const key = outboxRows(env)[0].k;
      assert.deepStrictEqual([outboxRows(env)[0].state, v.receipts(7)], ["APPLIED", [key]]);
      await passesAt(env, shared, base + G + I);
      assert.deepStrictEqual(v.receipts(7), [], "receipt gone after the grace");
      assert.deepStrictEqual([outboxRows(env).length, eventsOf(env, S.EVENT_TYPE).map((e) => e.state)], [1, ["DONE"]]);
      const T = S.dayEndMs(S.dayOf(base)) + R + I;
      await passesAt(env, shared, T);
      assert.deepStrictEqual([outboxRows(env).length, eventsOf(env, S.EVENT_TYPE).length], [0, 0], "rows gone");
      const calls = v.calls;
      assert.strictEqual(env.standings.onNpcKill(kill).outcome, "STALE_KILL");
      assert.strictEqual(v.calls, calls, "the pruned kill never reaches the vendor again");
      const chain = eventsOf(env, S.PRUNE_EVENT_TYPE);
      assert.deepStrictEqual(chain.map((e) => e.state).sort(), ["DONE", "QUEUED"], JSON.stringify(chain));
      const next = chain.find((e) => e.state === "QUEUED");
      assert.deepStrictEqual([next.k, JSON.parse(next.payload)], [S.pruneKey(I, Math.floor(T / I) + 1),
        { intervalMs: I, round: Math.floor(T / I) + 1 }]);
      const st = env.standings.getStatus().prune;
      assert.deepStrictEqual([st.counters.receiptsPruned, st.counters.receiptWrites, st.counters.grantsPruned,
        st.counters.eventsPruned, st.counters.chainPurged], [1, 1, 1, 1, 1]);
      assert.ok(env.lines.some((l) => l.startsWith("standings: pruned receipts=0 writes=0 grants=1 chars=1")));
      const updates = v.updates;
      await passesAt(env, shared, T + I);
      const st2 = env.standings.getStatus().prune;
      assert.deepStrictEqual([v.updates, st2.counters.grantsPruned, st2.counters.passes], [updates, 1, 3]);
      env.standings.stop("test");
    }));

  needsDriver("P4 safety: PENDING/QUARANTINED untouched, failed vendor write keeps rows, guards, crash + restart",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const v = fakeVendor();
      const env = bootP(reopen(), shared, v);
      seedSystem(env, SYS.N5, GURISTAS);
      const { pruneIntervalMs: I, retentionMs: R } = env.config.standings;
      const base = shared.clock.now();
      const killOf = (characterId, victimId) => env.standings.onNpcKill({ characterId, victimFactionId: GURISTAS,
        systemId: SYS.N5, atMs: base, victimId }).outcome;
      assert.strictEqual(killOf(7, 1), "GRANTED");
      const quarantined = eventsOf(env, S.EVENT_TYPE)[0];
      const ev = { idempotencyKey: quarantined.k, payload: JSON.parse(quarantined.payload),
        createdAt: quarantined.createdAt, dueAt: quarantined.dueAt };
      assert.strictEqual(env.captured[S.EVENT_TYPE](ev, { now: base }).outcome, "APPLIED");
      env.tx((db) => db.prepare(`UPDATE world_scheduled_events SET state = 'QUARANTINED', last_error = 'x',
        finished_at = ? WHERE idempotency_key = ?`).run(base, quarantined.k));
      assert.strictEqual(killOf(8, 2), "GRANTED");
      await passesAt(env, shared, base);
      const keyA = quarantined.k;
      const keyB = outboxRows(env).find((r) => r.k !== keyA).k;
      v.writeError = true;
      const T1 = S.dayEndMs(S.dayOf(base)) + R + I;
      await passesAt(env, shared, T1);
      assert.deepStrictEqual([v.receipts(7), v.receipts(8)], [[keyA], [keyB]]);
      assert.deepStrictEqual(outboxRows(env).map((r) => [r.k, r.state]), [[keyA, "PENDING"], [keyB, "APPLIED"]]);
      assert.ok(env.standings.getStatus().prune.counters.receiptWriteFailed >= 1);
      v.writeError = false;
      const read = env.captured[S.PRUNE_EVENT_TYPE]({}, { now: T1 + 1, anchorAt: T1 + 1 });
      assert.ok(read.ok && typeof read.effect === "function");
      assert.deepStrictEqual([v.receipts(7), v.receipts(8)], [[keyA], []], "vendor first; the effect never ran");
      assert.strictEqual(outboxRows(env).length, 2);
      env.standings.stop("crash");
      env.store.close("crash");
      const env2 = bootP(reopen(), shared, v);
      await passesAt(env2, shared, T1 + 2 * I);
      assert.deepStrictEqual(outboxRows(env2).map((r) => [r.k, r.state]), [[keyA, "PENDING"]]);
      assert.deepStrictEqual(eventsOf(env2, S.EVENT_TYPE).map((e) => [e.k, e.state]), [[keyA, "QUARANTINED"]]);
      assert.deepStrictEqual(v.receipts(7), [keyA], "the receipt of a PENDING row stays");
      const idA = outboxRows(env2)[0].id;
      env2.tx((db) => {
        const seed = db.prepare("SELECT journal_id AS id FROM world_event_journal WHERE idempotency_key LIKE "
          + "'world:seed:%'").get().id;
        assert.deepStrictEqual(env2.journal.purgeTerminal(db, { fromKey: S.KEY_PREFIX, toKey: S.KEY_RANGE_END,
          journalIds: [idA, seed] }), { ok: true, deleted: 0 }, "PENDING and a key outside the range stay");
        assert.deepStrictEqual(env2.scheduler.purgeDone({ eventType: S.EVENT_TYPE, keys: [keyA] }, { tx: db }),
          { ok: true, deleted: 0, notDone: [keyA] });
        assert.strictEqual(env2.scheduler.purgeDone({ eventType: S.EVENT_TYPE, keys: [keyA] }).reason, "TX_REQUIRED");
        return true;
      });
      env2.standings.stop("test");
    }));

  test("P5 start: EXCEEDS_MAX_ROWS / prune off / no updateCharacterRecord -> grants on, no prune handler", () => {
    const NOW = 1760000000000;
    const start = (envOver, adapterOver = {}) => {
      const registered = [];
      const enqueued = [];
      const scheduler = { registerHandler(type, fn, opts) {
        registered.push([type, opts && opts.maxPerPass]);
        return { ok: true, unregister() {} };
      }, enqueue(...args) {
        enqueued.push(args);
        return { ok: true, duplicate: false };
      }, purgeDone: () => ({ ok: true, deleted: 0, notDone: [] }) };
      const store = { limits: { maxRowsPerTransaction: 500 }, transaction() {
        throw new Error("no I/O expected");
      } };
      const r = startStandings({ config: configOf(envOver), persistence: { ok: true, store,
        journal: { scanKeyRange() {}, purgeTerminal() {} } }, clock: { now: () => NOW }, scheduler,
      world: { repository: {} }, adapter: { ...fakeAdapter(fakeVendor()), ...adapterOver }, logger: { log() {} } });
      assert.ok(r.ok, JSON.stringify(r));
      return { standings: r.standings, registered, enqueued, prune: r.standings.getStatus().prune };
    };
    const on = start({});
    const I = configOf().standings.pruneIntervalMs;
    assert.deepStrictEqual(on.registered, [[S.EVENT_TYPE, 8], [S.PRUNE_EVENT_TYPE, 1]]);
    assert.deepStrictEqual(on.enqueued.map((a) => [a[0], a[2], a[4]]), [[S.PRUNE_EVENT_TYPE,
      (Math.floor(NOW / I) + 1) * I, S.pruneKey(I, Math.floor(NOW / I) + 1)]]);
    assert.strictEqual(on.prune.state, "on");
    on.standings.stop("test");
    const big = start({ EVEJS_LNE_STANDINGS_PRUNE_MAX_GRANTS_PER_PASS: "4998" });
    assert.deepStrictEqual([big.prune.reason, big.registered.length, big.enqueued.length],
      ["STANDINGS_PRUNE_EXCEEDS_MAX_ROWS", 1, 0]);
    big.standings.stop("test");
    const off = start({ EVEJS_LNE_STANDINGS_PRUNE_ENABLED: "false" });
    assert.deepStrictEqual([off.prune.reason, off.registered.length, off.enqueued.length],
      ["disabled_by_config", 1, 0]);
    assert.strictEqual(off.standings.onNpcKill({ characterId: 7, victimFactionId: GURISTAS, systemId: 30000001,
      atMs: NOW - DAY - 1 }).outcome, "STALE_KILL", "the guard stays with the prune off");
    off.standings.stop("test");
    const adapter = createAdapter({ moduleApi: { _cache: { [path.join("srv", "services/character/characterState.js")]:
      { exports: { peekCharacterRecord: () => null } } } } });
    adapter.setServerSrc("srv");
    assert.deepStrictEqual(adapter.checkReceiptPrune(), { ok: false, reason: "updateCharacterRecord_missing" });
    const noSeam = start({}, { checkReceiptPrune: adapter.checkReceiptPrune });
    assert.deepStrictEqual([noSeam.prune.reason, noSeam.registered.length], ["RECEIPT_SEAM_UNAVAILABLE", 1]);
    noSeam.standings.stop("test");
    killObservation.setStandings(null);
  });
};
