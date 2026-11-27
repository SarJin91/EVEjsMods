"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const H = require("./hunting.test").harness;
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createManualClock } = require("../../lib/util/clock");
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const outboxModule = require("../../lib/freeCorps/outboxRepository");
const structureModule = require("../../lib/freeCorps/structureRepository");
const { createStructurePump } = require("../../lib/freeCorps/structurePump");
const { placementCandidates } = require("../../lib/stations/structures/projection");
const { CONDITION_FULL, CONDITION_ARMOR_STAGE } = require("../../lib/stations/structures/schema");
const { createFakeStructureSeam, DEFAULT_STATES } = require("../_support/fakeStructureSeam");
const { loadDriver, withStore, withStoreAsync } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = H.T0;
const HOMES = Object.freeze({ 1: 30000011, 2: 30000012, 3: 30000013, 4: 30000014 });
const STATES = Object.freeze({ ...DEFAULT_STATES, ANCHORING: 2, ONLINING_VULNERABLE: 102 });
const RETENTION = Object.freeze({ ventureRetentionMs: 7 * 86400000, pruneBatch: 50 });

const baseS = () => H.cfgOf({ hunting: { enabled: false } }).freeCorps.structures;
const anchorsOf = () => Object.fromEntries(Object.values(HOMES).map((id) => [id,
  [{ itemId: 40000000 + (id % 100), position: { x: 1e9, y: 0, z: 0 }, radius: 1000 }]]));

function corp(opened, corpId, { band = "nullsec", isk = 9000000000 } = {}) {
  H.seedCorp(opened, { corpId, archetype: "miner", isk });
  H.exec(opened, "UPDATE world_free_corps SET sec_band = ?, home_system_id = ? WHERE corp_id = ?", band, HOMES[corpId],
    corpId);
}

function pumpOf(opened, { S = {}, fake = createFakeStructureSeam({ anchors: anchorsOf(), states: STATES }),
  blocked = () => ({ ok: true, blocked: null }), clock = createManualClock(T0), isRunning = () => true } = {}) {
  const counters = {};
  const logs = [];
  const pump = createStructurePump({ store: opened.store, repo: createFreeCorpRepository(),
    srepo: structureModule.createFreeCorpStructureRepository(), outbox: outboxModule.createFreeCorpOutboxRepository(),
    clock, nowMs: () => 0, freeCorpStructureSeams: () => ({ ok: true, seam: fake.seam }),
    structureKit: { placementCandidates, CONDITION_FULL, CONDITION_ARMOR_STAGE },
    systemBlockedInTx: (_tx, id) => blocked(id), systemNameOf: (id) => `S${id}`, getGovernor: () => null,
    workClass: "MAINTENANCE", worldSeed: opened.worldSeed, isRunning,
    bump: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, metric: () => {},
    log: (line) => logs.push(line), S: { ...baseS(), enabled: true, maxAnchorsPerPlan: 8, ...S },
    retention: RETENTION });
  const run = (advanceMs = 0) => {
    clock.advance(advanceMs);
    const r = pump.runNow();
    assert.deepStrictEqual(r, { ok: true, ran: true }, JSON.stringify({ r, logs, st: pump.status() }));
    return r;
  };
  return { pump, fake, counters, clock, run, logs };
}

const structureRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_structures ORDER BY structure_key");
const anchorRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_outbox WHERE kind = 'ANCHOR' ORDER BY key");
const corpRow = (opened, id) => H.all(opened, "SELECT * FROM world_free_corps WHERE corp_id = ?", id)[0];
const SPACING = 600000;

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FST2 plan with the limits: band / ISK / ISK order, PLANNED + ANCHOR + debit + structure_seq "
    + "maxPerCorp, maxTotal, SOV / STATION / cooldown skips, EXPLAIN _open_system", () => {
    withStore(driver, (opened) => {
      corp(opened, 1, { band: "nullsec", isk: 9000000000 });
      corp(opened, 2, { band: "lowsec", isk: 6000000000 });
      corp(opened, 3, { band: "highsec", isk: 9000000000 });
      corp(opened, 4, { band: "nullsec", isk: 4000000000 });
      const p = pumpOf(opened, { fake: createFakeStructureSeam({ anchors: anchorsOf(), states: STATES,
        createRefusal: "WRITE_FAILED" }) });
      p.run();
      assert.deepStrictEqual(structureRows(opened).map((r) => [r.structure_key, r.state, r.system_id, r.cost_isk]),
        [["lne:fc:st:1:1", "PLANNED", HOMES[1], 1000000000], ["lne:fc:st:2:1", "PLANNED", HOMES[2], 1000000000]]);
      assert.deepStrictEqual(anchorRows(opened).map((r) => [r.key, r.state, JSON.parse(r.payload)]),
        [["lne:fc:st:1:1", "PENDING", { v: 1, structureKey: "lne:fc:st:1:1" }],
          ["lne:fc:st:2:1", "PENDING", { v: 1, structureKey: "lne:fc:st:2:1" }]]);
      assert.deepStrictEqual([corpRow(opened, 1).isk, corpRow(opened, 1).structure_seq], [8000000000, 1]);
      assert.deepStrictEqual([corpRow(opened, 3).isk, corpRow(opened, 4).isk], [9000000000, 4000000000]);
      assert.strictEqual(p.counters.stPlanned, 2);
      p.run(3600000);
      assert.strictEqual(structureRows(opened).length, 2, "maxPerCorp: nothing new");
      const ex = H.all(opened, "EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM world_free_corp_structures "
        + "WHERE open = 1 AND system_id = ?", HOMES[1]).map((r) => r.detail).join(" | ");
      assert.match(ex, /world_free_corp_structures_open_system/);
    });
    withStore(driver, (opened) => {
      corp(opened, 1);
      corp(opened, 2, { isk: 8000000000 });
      pumpOf(opened, { S: { maxTotal: 1 } }).run();
      assert.deepStrictEqual(structureRows(opened).map((r) => r.structure_key), ["lne:fc:st:1:1"]);
    });
    withStore(driver, (opened) => {
      corp(opened, 1);
      corp(opened, 2);
      corp(opened, 3, { band: "lowsec" });
      H.exec(opened, "INSERT INTO world_free_corp_structures (structure_key, corp_id, n, system_id, type_id, state, "
        + "open, evejs_item_id, cost_isk, planned_at, ended_at, end_reason, updated_at, version) VALUES "
        + "('lne:fc:st:3:1', 3, 1, ?, 35832, 'LOST', 0, NULL, 0, ?, ?, 'DESTROYED', ?, 2)", HOMES[3], T0 - 5000,
      T0 - 1000, T0 - 1000);
      const p = pumpOf(opened, { blocked: (id) => ({ ok: true,
        blocked: id === HOMES[1] ? "SOV" : id === HOMES[2] ? "STATION" : null }) });
      p.run();
      assert.deepStrictEqual(structureRows(opened).filter((r) => r.open === 1), []);
      assert.deepStrictEqual([p.counters.stBlockedSov, p.counters.stBlockedStation, p.counters.stSkipCooldown],
        [1, 1, 1]);
    });
  });

  needsDriver("FST3 anchor: create spec, ANCHORING + DONE; crash of the record -> adoption by the tag; bad "
    + "flush -> adoption at the next claim; foreign world orphan removed; TYPE_UNKNOWN -> FAILED + refund", () => {
    withStore(driver, (opened) => {
      corp(opened, 1);
      const p = pumpOf(opened);
      p.run();
      p.run();
      const [s] = p.fake.fcRows();
      assert.deepStrictEqual([s.ownerCorpId, s.docking, s.hasQuantumCore, s.state, s.stateEndsAt, s.systemId, s.name],
        [98000001, "none", false, DEFAULT_STATES.ANCHOR_VULNERABLE, T0 + 900000, HOMES[1], `S${HOMES[1]} - Corp 1`]);
      assert.deepStrictEqual(s.tag, { fcKey: "lne:fc:st:1:1", world: opened.worldSeed });
      const [row] = structureRows(opened);
      assert.deepStrictEqual([row.state, row.evejs_item_id, row.anchored_at], ["ANCHORING", s.structureId, T0]);
      const [ob] = anchorRows(opened);
      assert.deepStrictEqual([ob.state, ob.result_id, ob.attempts], ["DONE", s.structureId, 1]);
      assert.deepStrictEqual([p.counters.stCalls, p.counters.stAnchored], [1, 1]);
    });
    withStore(driver, (opened) => {
      corp(opened, 1);
      const fake = createFakeStructureSeam({ anchors: anchorsOf(), states: STATES });
      const p = pumpOf(opened, { fake });
      p.run();
      H.exec(opened, "CREATE TEMP TRIGGER fst3_crash BEFORE UPDATE ON world_free_corp_structures "
        + "BEGIN SELECT RAISE(ABORT, 'fst3 crash'); END");
      assert.deepStrictEqual(p.pump.runNow(), { ok: true, ran: true });
      assert.strictEqual(structureRows(opened)[0].state, "PLANNED", "the record rolled back");
      H.exec(opened, "DROP TRIGGER fst3_crash");
      p.pump.stop();
      const again = pumpOf(opened, { fake, clock: p.clock });
      again.run(1000);
      assert.strictEqual(fake.fcRows().length, 1, "one structure");
      assert.deepStrictEqual([structureRows(opened)[0].state, anchorRows(opened)[0].state], ["ANCHORING", "DONE"]);
      assert.strictEqual(again.counters.stAdopted, 1);
    });
    withStore(driver, (opened) => {
      corp(opened, 1);
      const fake = createFakeStructureSeam({ anchors: anchorsOf(), states: STATES, flushFails: true });
      const p = pumpOf(opened, { fake });
      p.run();
      p.run();
      assert.deepStrictEqual([structureRows(opened)[0].state, anchorRows(opened)[0].state,
        anchorRows(opened)[0].last_error], ["PLANNED", "PENDING", "FLUSH_FAILED"]);
      assert.strictEqual(p.counters.stFlushFailed, 1);
      fake.options.flushFails = false;
      p.run(SPACING);
      assert.strictEqual(fake.fcRows().length, 1, "still one structure");
      assert.deepStrictEqual([structureRows(opened)[0].state, anchorRows(opened)[0].state], ["ANCHORING", "DONE"]);
      assert.strictEqual(p.counters.stAdopted, 1);
    });
    withStore(driver, (opened) => {
      const fake = createFakeStructureSeam({ anchors: anchorsOf(), states: STATES });
      fake.seed({ fcTag: { fcKey: "lne:fc:st:99:1", world: opened.worldSeed + 1 }, tag: null, typeId: 35832,
        systemId: HOMES[1], ownerCorpId: 98000099, state: 110, stateEndsAt: null });
      const p = pumpOf(opened, { fake });
      p.run();
      assert.deepStrictEqual([fake.fcRows().length, p.counters.stOrphanRemoved], [0, 1]);
    });
    withStore(driver, (opened) => {
      corp(opened, 1);
      const p = pumpOf(opened, { fake: createFakeStructureSeam({ anchors: anchorsOf(), states: STATES,
        knownTypes: [] }) });
      p.run();
      assert.strictEqual(corpRow(opened, 1).isk, 8000000000);
      p.run();
      const [row] = structureRows(opened);
      assert.deepStrictEqual([row.state, row.end_reason, row.open], ["FAILED", "TYPE_UNKNOWN", 0]);
      assert.deepStrictEqual([anchorRows(opened)[0].state, anchorRows(opened)[0].attempts], ["FAILED", 1]);
      assert.strictEqual(corpRow(opened, 1).isk, 9000000000, "the refund");
      assert.deepStrictEqual([p.counters.stFailed, p.counters.stRefund], [1, 1]);
    });
  });

  needsDriver("FST4 cycle and losses: ONLINING -> PATCH SHIELD -> ONLINE, LOW_POWER -> FULL_POWER, DESTROYED "
    + "once (25 %, STRUGGLING), CORP_CLOSED removed, VANISHED without a penalty", () => {
    withStore(driver, (opened) => {
      corp(opened, 1);
      corp(opened, 2);
      corp(opened, 3);
      const p = pumpOf(opened);
      p.run();
      p.run();
      p.run(SPACING);
      p.run(SPACING);
      const byKey = () => Object.fromEntries(structureRows(opened).map((r) => [r.structure_key, r]));
      assert.deepStrictEqual(Object.values(byKey()).map((r) => r.state), ["ANCHORING", "ANCHORING", "ANCHORING"]);
      const id = (c) => byKey()[`lne:fc:st:${c}:1`].evejs_item_id;
      p.fake.patch(id(1), { state: STATES.ONLINING_VULNERABLE, stateEndsAt: null });
      p.run(1000);
      assert.strictEqual(p.fake.fcRows().find((s) => s.structureId === id(1)).state, STATES.SHIELD_VULNERABLE);
      assert.strictEqual(byKey()["lne:fc:st:1:1"].state, "ANCHORING");
      p.run(1000);
      assert.strictEqual(byKey()["lne:fc:st:1:1"].state, "ONLINE");
      p.fake.patch(id(1), { upkeepState: 2 });
      p.run(1000);
      assert.strictEqual(p.fake.fcRows().find((s) => s.structureId === id(1)).upkeepState, 1);
      assert.deepStrictEqual([p.counters.stPatched, p.counters.stUpkeepRestored, p.counters.stOnline], [2, 1, 1]);
      const before = corpRow(opened, 1);
      p.fake.patch(id(1), { destroyedAt: p.clock.now() });
      p.run(1000);
      const after = corpRow(opened, 1);
      const lost = byKey()["lne:fc:st:1:1"];
      assert.deepStrictEqual([lost.state, lost.end_reason, lost.penalty_isk], ["LOST", "DESTROYED", 2000000000]);
      assert.deepStrictEqual([after.isk, after.isk_lost - before.isk_lost, after.state, after.struggle_count],
        [6000000000, 2000000000, "STRUGGLING", before.struggle_count]);
      p.run(1000);
      p.run(1000);
      assert.strictEqual(corpRow(opened, 1).version, after.version, "one settlement");
      assert.strictEqual(p.counters.stLostDestroyed, 1);
      H.exec(opened, "UPDATE world_free_corps SET state = 'DISSOLVED', open = 0, ended_at = ?, end_reason = 'BANKRUPT' "
        + "WHERE corp_id = 2", p.clock.now());
      const isk2 = corpRow(opened, 2).isk;
      p.run(1000);
      assert.deepStrictEqual([byKey()["lne:fc:st:2:1"].state, byKey()["lne:fc:st:2:1"].end_reason],
        ["REMOVED", "CORP_CLOSED"]);
      assert.ok(!p.fake.fcRows().some((s) => s.tag.fcKey === "lne:fc:st:2:1"), "removed from the vendor");
      assert.strictEqual(corpRow(opened, 2).isk, isk2);
      const isk3 = corpRow(opened, 3).isk;
      p.fake.drop(id(3));
      p.run(1000);
      assert.deepStrictEqual([byKey()["lne:fc:st:3:1"].state, byKey()["lne:fc:st:3:1"].end_reason,
        byKey()["lne:fc:st:3:1"].penalty_isk], ["LOST", "VANISHED", 0]);
      assert.deepStrictEqual([corpRow(opened, 3).isk, corpRow(opened, 3).state], [isk3, "ACTIVE"]);
    });
  });

  needsDriver("FST6 /: cleanup never adopts (FAILED CLEANUP + REMOVED CLEANUP, no LOST) "
    + "maxTotal 0 still watches every open row; one failing record does not roll back the others", () => {
    withStore(driver, (opened) => {
      corp(opened, 1);
      corp(opened, 2);
      const p = pumpOf(opened);
      p.run();
      p.run();
      H.exec(opened, "CREATE TEMP TRIGGER fst6_crash BEFORE UPDATE ON world_free_corp_structures "
        + "BEGIN SELECT RAISE(ABORT, 'fst6 crash'); END");
      p.run(SPACING);
      H.exec(opened, "DROP TRIGGER fst6_crash");
      assert.deepStrictEqual([structureRows(opened).map((r) => r.state), p.fake.fcRows().length],
        [["ANCHORING", "PLANNED"], 2]);
      p.pump.stop();
      const c = pumpOf(opened, { fake: p.fake, clock: p.clock, S: { mode: "cleanup" } });
      c.run(1000);
      assert.deepStrictEqual(structureRows(opened).map((r) => [r.state, r.end_reason, r.open]),
        [["REMOVED", "CLEANUP", 0], ["FAILED", "CLEANUP", 0]]);
      assert.deepStrictEqual(p.fake.fcRows(), [], "both vendor structures removed");
      assert.strictEqual(corpRow(opened, 2).isk, 9000000000, "the refund");
      c.run(1000);
      assert.deepStrictEqual([c.counters.stLostVanished, c.counters.stRecordConflict, c.counters.stAdopted,
        c.counters.stOrphanRemoved, c.counters.stRemoved], [undefined, undefined, undefined, 1, 1]);
    });
    withStore(driver, (opened) => {
      corp(opened, 1);
      corp(opened, 2);
      corp(opened, 3);
      const p = pumpOf(opened);
      p.run();
      p.run();
      p.run(SPACING);
      p.run(SPACING);
      const rows = structureRows(opened);
      assert.deepStrictEqual(rows.map((r) => r.state), ["ANCHORING", "ANCHORING", "ANCHORING"]);
      p.pump.stop();
      const q = pumpOf(opened, { fake: p.fake, clock: p.clock, S: { maxTotal: 0 } });
      H.exec(opened, "CREATE TEMP TRIGGER fst6_one BEFORE UPDATE ON world_free_corp_structures "
        + "WHEN OLD.structure_key = 'lne:fc:st:1:1' BEGIN SELECT RAISE(ABORT, 'fst6 one'); END");
      const isk1 = corpRow(opened, 1).isk;
      p.fake.patch(rows[0].evejs_item_id, { destroyedAt: p.clock.now() });
      p.fake.patch(rows[2].evejs_item_id, { destroyedAt: p.clock.now() });
      q.run(1000);
      H.exec(opened, "DROP TRIGGER fst6_one");
      assert.deepStrictEqual(structureRows(opened).map((r) => [r.state, r.end_reason]),
        [["ANCHORING", null], ["ANCHORING", null], ["LOST", "DESTROYED"]]);
      assert.strictEqual(corpRow(opened, 1).isk, isk1, "the failed record rolled back alone");
      assert.deepStrictEqual([q.counters.stLostDestroyed, q.counters.stRecordFailed], [1, 1]);
      q.run(1000);
      assert.deepStrictEqual(structureRows(opened).map((r) => r.state), ["LOST", "ANCHORING", "LOST"]);
    });
  });

  needsDriver("FST7 durable flush: runNow waits for it, BUSY while it is in flight, recorded after it; stopped or "
    + "module no longer running before it settles -> NOT_RUNNING, nothing recorded, the next pump adopts", async () => {
    const run = (halt) => withStoreAsync(driver, async (opened) => {
      corp(opened, 1);
      const live = { running: true };
      const fake = createFakeStructureSeam({ anchors: anchorsOf(), states: STATES });
      let release = null;
      const slow = { ...fake, seam: Object.freeze({ ...fake.seam, flushStructures: () => {
        const r = fake.seam.flushStructures();
        return new Promise((resolve) => { release = () => resolve(r); });
      } }) };
      const p = pumpOf(opened, { fake: slow, isRunning: () => live.running });
      p.run();
      const pending = p.pump.runNow();
      assert.ok(pending && typeof pending.then === "function", "the anchor pass waits for the flush");
      assert.deepStrictEqual(p.pump.runNow(), { ok: true, ran: false, reason: "BUSY" });
      assert.strictEqual(structureRows(opened)[0].state, "PLANNED");
      if (halt === "stop") p.pump.stop();
      if (halt === "notRunning") live.running = false;
      release();
      const r = await pending;
      const state = structureRows(opened)[0].state;
      if (halt) {
        const again = pumpOf(opened, { fake, clock: p.clock });
        again.run(1000);
        return [r, state, structureRows(opened)[0].state, again.counters.stAdopted, fake.fcRows().length];
      }
      return [r, state];
    });
    assert.deepStrictEqual(await run(null), [{ ok: true, ran: true }, "ANCHORING"]);
    for (const halt of ["stop", "notRunning"]) {
      assert.deepStrictEqual(await run(halt), [{ ok: true, ran: false, reason: "NOT_RUNNING" }, "PLANNED", "ANCHORING",
        1, 1], halt);
    }
  });

  needsDriver("FST5 flag off: no row, no repository / seam call, no status key, panel {enabled:false} "
    + "migration 80, KEEP, W33-W36", () => {
    withStore(driver, (opened) => {
      corp(opened, 1);
      const real = structureModule.createFreeCorpStructureRepository;
      let repos = 0;
      let seamCalls = 0;
      structureModule.createFreeCorpStructureRepository = (...a) => { repos += 1; return real(...a); };
      let view = null;
      try {
        const env = H.boot(opened, { cfg: H.cfgOf({ hunting: { enabled: false } }), extra: {
          freeCorpStructureSeams: () => { seamCalls += 1; return { ok: false, reason: "SPY" }; },
          views: { registerView: (id, def) => { view = def; return { ok: true, unregister() {} }; } } } });
        const st = H.pass(env);
        assert.ok(!Object.prototype.hasOwnProperty.call(st, "structures"), "no status key");
        assert.deepStrictEqual(view.getData().structures, { enabled: false });
        env.fc.stop();
      } finally {
        structureModule.createFreeCorpStructureRepository = real;
      }
      assert.deepStrictEqual([repos, seamCalls, structureRows(opened).length, anchorRows(opened).length], [0, 0, 0, 0]);
    });
    assert.ok(LATEST_SCHEMA_VERSION >= 80, "CEO reuse migration 81 after 80");
    assert.strictEqual(TABLE_POLICY.world_free_corp_structures, ACTION.KEEP);
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_STRUCTURES_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_STRUCTURES_ANCHOR_COST_ISK: "6000000000",
      EVEJS_LNE_FREE_CORPS_STRUCTURES_BACKOFF_BASE_MS: "86400000",
      EVEJS_LNE_FREE_CORPS_STRUCTURES_BACKOFF_MAX_MS: "60000" } });
    assert.deepStrictEqual(r.errors, []);
    assert.strictEqual(r.config.freeCorps.structures.enabled, true);
    const w = r.warnings.join("\n");
    assert.match(w, /freeCorps\.structures\.enabled needs freeCorps\.enabled/);
    assert.match(w, /freeCorps\.structures\.anchorCostIsk=6000000000 above minCorpIsk/);
    assert.match(w, /freeCorps\.structures\.backoffBaseMs=86400000 above backoffMaxMs=60000/);
    const off = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_STRUCTURES_MODE: "cleanup" } });
    assert.match(off.warnings.join("\n"), /structures\.mode=cleanup with freeCorps\.structures\.enabled false/);
    const bad = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_STRUCTURES_ANCHOR_MODE: "fast" } });
    assert.strictEqual(bad.config.freeCorps.structures.anchorMode, "native", "an unknown anchorMode is ignored");
    assert.ok(bad.warnings.some((x) => /ANCHOR_MODE="fast" is not native or instant/.test(x)), "anchorMode checked");
  });
};
