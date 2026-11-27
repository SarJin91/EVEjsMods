"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { startBounty, createUnavailableBounty } = require("../../lib/bounty");
const R = require("../../lib/bounty/repository");
const { LEVELS } = require("../../lib/bounty/data/levels");
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStore } = require("../notices/storeHelper");
const seamModule = require("../../lib/adapter/localPilots");
const LP = require("../localPilots/localPilots.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const HOUR = 3600000;
const POCHVEN = 10000070;
const BOSSES = Object.freeze([92000001, 92000002, 92000003]);
const SYSTEMS = Object.freeze({ 1: "nullsec", 2: "nullsec", 3: "nullsec", 4: "highsec", 5: "lowsec", 6: "lowsec",
  7: "lowsec", 8: "nullsec" });
const LINKS = Object.freeze({ 1: [2], 2: [1, 3, 6], 3: [2, 4], 4: [3, 5], 5: [4], 6: [2, 7], 7: [6, 8], 8: [7] });
const ON_ENV = { EVEJS_LNE_BOUNTY_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1", EVEJS_LNE_BOUNTY_MAX_GANGS: "2",
  EVEJS_LNE_BOUNTY_GANG_MEMBERS: "1", EVEJS_LNE_BOUNTY_MAX_ACTIVE: "1", EVEJS_LNE_BOUNTY_FACTION_IDS: "500010" };

const configCache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    assert.deepStrictEqual(r.errors || [], []);
    configCache.set(key, r.config);
  }
  return configCache.get(key);
}

function graph() {
  return {
    getSystem: (id) => (SYSTEMS[id] ? { id: Number(id), secClass: SYSTEMS[id], regionId: [4, 5, 8].includes(Number(id))
      ? POCHVEN : 10000001, constellationId: 20000001 } : null),
    getNeighbors: (id) => (LINKS[id] ? LINKS[id].slice() : null),
    getSystemIds: () => Object.keys(SYSTEMS).map(Number),
  };
}
const systemFactionsOf = (ids) => ({ ok: true, entries: ids.map((systemId) => ({ systemId, factionId: 500010 })) });

function fakeVc() {
  const vc = { ensures: [], states: new Map(),
    getOwnerIdentity(kind, slot) {
      assert.strictEqual(kind, "outlaw");
      const s = vc.states.get(slot) || "PENDING";
      return s === "LINKED" ? { ok: true, state: "LINKED", characterIds: BOSSES.map((x) => x + slot * 10),
        memberIndexes: [0, 1, 2], corporationId: 98000000 + slot } : { ok: true, state: s };
    },
    countOwnerCharacters: () => ({ ok: true, ready: true, total: 0 }),
    ensureOwnerIdentity(spec) {
      vc.ensures.push(spec);
      return { ok: true, queued: true };
    } };
  return vc;
}

function rig(opened, conf, opts = {}) {
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const vc = opts.vc || fakeVc();
  const timers = [];
  const logger = { lines: [], log(l) { this.lines.push(l); } };
  const g = graph();
  const started = startBounty({ config: conf, persistence: opened, clock, logger,
    setTimer: (fn, ms) => {
      timers.push(ms);
      return { cancel() {}, hasRef: () => false };
    },
    getGraph: () => ({ getGraph: () => ({ ok: true, graph: g }) }), getVirtualCorps: () => vc,
    homeStationOf: () => ({ stationId: 60000001, corporationId: 1000127, systemId: 1 }),
    bloodlinesOf: () => [1, 2, 11], excludedRegionIds: [POCHVEN], systemFactionsOf });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  const rows = () => {
    const r = opened.store.transaction("bh.test", (db) => db.prepare("SELECT wanted_id AS id, gang_slot AS slot, "
      + "cycle, character_id AS boss, level, archetype, smuggler, state, system_id AS sys, stay_index AS stay, "
      + "next_move_at AS nextAt, expires_at AS expAt, trace_system_id AS trace, ended_at AS endedAt, seed, version "
      + "FROM world_bounty_targets ORDER BY wanted_id").all().map((x) => ({ ...x })));
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { clock, vc, timers, logger, bounty: started.bounty, rows };
}

function scenario(opened) {
  const env = rig(opened, cfg(ON_ENV));
  const b = env.bounty;
  const trace = [];
  assert.strictEqual(b.runPassNow().ok, true);
  assert.deepStrictEqual(env.rows(), [], "PENDING gangs -> no target");
  assert.deepStrictEqual(env.vc.ensures.map((s) => [s.ownerKind, s.ownerId]), [["outlaw", 1]],
    "one gang in progress (maxEnsuringGangs 1)");
  b.runPassNow();
  assert.strictEqual(env.vc.ensures.length, 1, "gang 1 still in progress");
  assert.ok(b.getStatus().counters.ensureDeferred >= 1);
  env.vc.states.set(1, "LINKED");
  const created = b.runPassNow();
  assert.strictEqual(created.created, 1, JSON.stringify(created));
  const [first] = env.rows();
  assert.deepStrictEqual([first.id, first.slot, first.cycle, first.state, first.stay], ["bnt:1:1", 1, 1, "ROAMING", 0]);
  assert.strictEqual(first.boss, BOSSES[0] + 10, "boss of slot 1 = member 0 of gang 1");
  assert.deepStrictEqual(env.vc.ensures.map((s) => s.ownerId), [1, 2], "gang 1 done -> gang 2 (slot 2 free)");
  assert.ok(LEVELS[first.level].secClasses.includes(SYSTEMS[first.sys]), JSON.stringify(first));
  trace.push(env.rows());
  const res = b.residentsFor([first.sys, 4], env.clock.now());
  assert.deepStrictEqual(res, { ok: true, bySystem: new Map([[first.sys, [first.boss]]]) });

  env.clock.t = first.nextAt;
  const moved = b.runPassNow();
  assert.strictEqual(moved.moved, 1, JSON.stringify(moved));
  const [second] = env.rows();
  assert.strictEqual(second.stay, 1);
  assert.strictEqual(second.trace, first.sys);
  assert.ok(LINKS[first.sys].includes(second.sys), "a neighbour");
  assert.strictEqual(SYSTEMS[second.sys], SYSTEMS[first.sys], "class of the level");
  assert.deepStrictEqual(b.residentsFor([first.sys], env.clock.now()).bySystem, new Map());
  trace.push(env.rows());

  env.clock.t = first.expAt;
  const expired = b.runPassNow();
  assert.strictEqual(expired.expired, 1, JSON.stringify(expired));
  assert.strictEqual(env.rows()[0].state, "EXPIRED");
  assert.strictEqual(env.rows()[0].endedAt, first.expAt);
  assert.deepStrictEqual(b.residentsFor([second.sys], env.clock.now()).bySystem, new Map());
  b.runPassNow();
  assert.strictEqual(env.rows().length, 1, "cooldown: no new cycle");
  assert.deepStrictEqual(env.vc.ensures.map((s) => s.ownerId), [1, 2, 2], "gang 2 still PENDING: stale ensure again");
  env.clock.t = first.expAt + HOUR;
  assert.strictEqual(b.runPassNow().created, 1);
  const cycle2 = env.rows().find((r) => r.id === "bnt:1:2");
  assert.ok(cycle2, JSON.stringify(env.rows()));
  assert.strictEqual(cycle2.boss, first.boss, "The slot keeps its boss");
  trace.push(env.rows());
  b.stop();
  return trace;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("BH1 / BH5 bounty repository and service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("BH1 migration 106 empty + WIPE, UNIQUE(gang_slot, cycle), CAS of a move, recovery LIVE -> ROAMING, "
    + "retention keeps the last cycle", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 106);
    assert.strictEqual(TABLE_POLICY.world_bounty_targets, ACTION.WIPE);
    withStore(driver, (opened) => {
      const tx = (fn) => {
        const r = opened.store.transaction("bh1", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      assert.strictEqual(tx((db) => db.prepare("SELECT count(*) AS n FROM world_bounty_targets").get().n), 0);
      const row = { slot: 1, cycle: 1, factionId: 500010, characterId: 92000001, level: 3, archetype: "KITER",
        smuggler: 0, systemId: 2, nextMoveAt: T0 + HOUR, expiresAt: T0 + 36 * HOUR, rewardIsk: 25000000, seed: 77 };
      const created = tx((db) => R.createInTx(db, row, T0));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      assert.deepStrictEqual(tx((db) => R.createInTx(db, row, T0)), { ok: false, reason: "DUPLICATE" });
      assert.throws(() => tx((db) => db.prepare("INSERT INTO world_bounty_targets (wanted_id, gang_slot, cycle, "
        + "faction_id, character_id, level, archetype, state, system_id, next_move_at, expires_at, reward_isk, seed, "
        + "created_at, updated_at) VALUES ('x', 1, 1, 500010, 1, 1, 'RUNNER', 'ROAMING', 1, 0, 0, 0, 0, 0, 0)").run()),
      /UNIQUE|constraint/i);
      const t = created.target;
      const moved = tx((db) => R.moveInTx(db, t, 3, T0 + 2 * HOUR, T0 + HOUR));
      assert.strictEqual(moved.ok, true);
      assert.deepStrictEqual([moved.target.systemId, moved.target.stayIndex, moved.target.traceSystemId,
        moved.target.traceAt, moved.target.version], [3, 1, 2, T0 + HOUR, 2]);
      assert.deepStrictEqual(tx((db) => R.moveInTx(db, t, 1, T0 + 3 * HOUR, T0 + HOUR)),
        { ok: false, reason: "CAS_LOST" }, "stale version");
      tx((db) => db.prepare("UPDATE world_bounty_targets SET state = 'LIVE' WHERE wanted_id = 'bnt:1:1'").run());
      assert.deepStrictEqual(tx((db) => R.recoverLiveInTx(db, T0 + HOUR, 600000)), { ok: true, recovered: 1 });
      const back = tx((db) => R.lastOfSlotInTx(db, 1));
      assert.deepStrictEqual([back.state, back.nextMoveAt], ["ROAMING", T0 + 2 * HOUR], "max keeps the later move");
      tx((db) => db.prepare("UPDATE world_bounty_targets SET state = 'LIVE' WHERE wanted_id = 'bnt:1:1'").run());
      tx((db) => R.recoverLiveInTx(db, T0 + 3 * HOUR, 600000));
      assert.strictEqual(tx((db) => R.lastOfSlotInTx(db, 1)).nextMoveAt, T0 + 3 * HOUR + 600000);
      tx((db) => R.expireInTx(db, R.lastOfSlotInTx(db, 1), T0 + 4 * HOUR));
      assert.deepStrictEqual(tx((db) => R.pruneEndedInTx(db, T0 + 100 * HOUR, 20)), { ok: true, deleted: 0 });
      tx((db) => R.createInTx(db, { ...row, cycle: 2 }, T0 + 5 * HOUR));
      assert.deepStrictEqual(tx((db) => R.pruneEndedInTx(db, T0 + 100 * HOUR, 20)), { ok: true, deleted: 1 });
      assert.deepStrictEqual(tx((db) => R.listActiveInTx(db, 10)).map((r) => r.wantedId), ["bnt:1:2"]);
    }, { fresh: true });
  });

  test("BH5 service: flag off = nothing; on: ensure, create after LINKED, move, expire, cooldown, maxActive, "
    + "replay, restart; residentsFor + localPilots step above the limit only when running", () => {
    let txs = 0;
    let gets = 0;
    const off = startBounty({ config: cfg({}), persistence: { ok: true, worldSeed: 1, store: {
      transaction() { txs += 1; return { ok: true }; } } }, clock: { now: () => T0 },
    setTimer: () => { throw new Error("no timer when off"); },
    getGraph: () => { gets += 1; return null; }, getVirtualCorps: () => { gets += 1; return fakeVc(); },
    homeStationOf: () => { gets += 1; return null; }, bloodlinesOf: () => [1] });
    assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual([txs, gets], [0, 0]);
    assert.strictEqual(cfg({}).bountyHunters.enabled, false);
    assert.deepStrictEqual(startBounty({ config: cfg({ EVEJS_LNE_BOUNTY_ENABLED: "1" }), persistence: null,
      clock: { now: () => T0 } }), { ok: false, reason: "dependency_disabled:virtualCorps" });
    const stub = createUnavailableBounty("BOUNTY_DISABLED", "disabled_by_config");
    assert.deepStrictEqual(stub.residentsFor([1], T0), { ok: false, reason: "BOUNTY_DISABLED" });

    const a = withStore(driver, (opened) => scenario(opened));
    const b = withStore(driver, (opened) => scenario(opened));
    assert.deepStrictEqual(a, b);

    withStore(driver, (opened) => {
      const vc = fakeVc();
      vc.states.set(1, "LINKED");
      vc.states.set(2, "LINKED");
      const conf = cfg({ ...ON_ENV, EVEJS_LNE_BOUNTY_MAX_ACTIVE: "1" });
      const env = rig(opened, conf, { vc });
      assert.strictEqual(env.timers.length, 1, "one poller timer");
      env.bounty.runPassNow();
      assert.strictEqual(env.rows().length, 1);
      env.bounty.runPassNow();
      assert.strictEqual(env.rows().length, 1, "maxActive");
      env.bounty.stop();
      opened.store.transaction("bh5", (db) => db.prepare("UPDATE world_bounty_targets SET state = 'LIVE'").run());
      const again = rig(opened, conf, { vc, clock: { t: T0 + 1000, now() { return this.t; } } });
      const [row] = again.rows();
      assert.strictEqual(row.state, "ROAMING");
      assert.ok(row.nextAt >= T0 + 1000 + 600000);
      assert.strictEqual(again.bounty.getStatus().counters.recovered, 1);
      assert.ok(again.logger.lines.some((l) => l.startsWith("bounty: running")), again.logger.lines.join("\n"));
      again.bounty.stop();
    });

    const S = 30000142;
    const BOSS = 92000002;
    const run = (bounty, bountyConfig) => {
      try {
        const w = LP.world();
        w.records.set(BOSS, { corporationID: 98000001, allianceID: 0 });
        const env = LP.boot({ world: w, settings: { maxPilotsPerSystem: 1 }, presenceState: { observed: [S] },
          fleets: new Map([[S, [LP.fleet(LP.FACTION, null, 3)]]]), bounty, bountyConfig });
        assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
        const { ms: _ms, ...lastPass } = env.lp.getStatus().lastPass;
        return { setRoster: env.vendor.log.setRoster, lastPass };
      } finally {
        seamModule._resetForTest();
      }
    };
    const fake = (state) => {
      const f = { calls: 0, getStatus: () => ({ state }),
        residentsFor(systems, at) {
          f.calls += 1;
          assert.ok(Array.isArray(systems) && Number.isFinite(at));
          return { ok: true, bySystem: new Map([[S, [BOSS]]]) };
        } };
      return f;
    };
    const plain = run(undefined, undefined);
    const on = fake("running");
    const shown = run(on, { enabled: true });
    assert.deepStrictEqual(shown.setRoster, [[S, [BOSS, ...plain.setRoster[0][1]]]], "boss first, above the limit");
    assert.strictEqual(plain.setRoster[0][1].length, 1);
    assert.strictEqual(shown.lastPass.outlaws, 1);
    assert.strictEqual(on.calls, 1);
    for (const [name, bounty, bc] of [["flag off", fake("running"), { enabled: false }],
      ["no section", fake("running"), undefined], ["stopped", fake("stopped"), { enabled: true }],
      ["stub", createUnavailableBounty("BOUNTY_DISABLED"), { enabled: true }]]) {
      assert.deepStrictEqual(run(bounty, bc), plain, name);
      if (bounty.calls !== undefined) assert.strictEqual(bounty.calls, 0, name);
    }
  });

  test("BHN1: liveEnabled without the kill wrap -> live=no_wrap, no kill listener; the loader mounts the "
    + "wrap for bounty LIVE alone", () => {
    const K = require("../../lib/adapter/killObservation");
    const LIVE_ENV = { ...ON_ENV, EVEJS_LNE_BOUNTY_LIVE_ENABLED: "1" };
    try {
      K.setKillWrapMounted(false);
      K.setBounty(null);
      withStore(driver, (opened) => {
        const env = rig(opened, cfg(LIVE_ENV));
        assert.strictEqual(env.bounty.getStatus().liveState, "no_wrap");
        assert.ok(env.logger.lines.some((l) => / live=no_wrap$/.test(l)), env.logger.lines.join("\n"));
        assert.strictEqual(K.getBounty(), null, "no kill listener without the wrap");
        env.bounty.stop();
        K.setKillWrapMounted(true);
        const on = rig(opened, cfg(LIVE_ENV));
        assert.strictEqual(on.bounty.getStatus().liveState, "on");
        assert.notStrictEqual(K.getBounty(), null);
        on.bounty.stop();
        assert.strictEqual(K.getBounty(), null);
      });
      const { buildHooks } = require("../../loader");
      const silent = { log() {}, debug() {}, logError() {} };
      const wrapped = (liveEnabled) => {
        const c = { enabled: true, modules: { world: { enabled: true } },
          bountyHunters: { enabled: true, liveEnabled } };
        const ctx = { logger: silent, state: { configResult: { ok: true, config: c } } };
        const base = () => null;
        const exportsObj = { recordNpcFactionStandingLoss: base, resolveVictimFactionID: () => 0 };
        buildHooks(ctx).find((h) => h.name === "npcKillLiberation").run(exportsObj, "factionKillStandingRuntime", null);
        return exportsObj.recordNpcFactionStandingLoss !== base;
      };
      K.setKillWrapMounted(false);
      assert.deepStrictEqual([wrapped(false), K.killWrapMounted()], [false, false], "bounty without LIVE: no wrap");
      assert.deepStrictEqual([wrapped(true), K.killWrapMounted()], [true, true], "bounty LIVE: wrap + mounted");
    } finally {
      K.setKillWrapMounted(false);
      K.setBounty(null);
    }
  });
};
