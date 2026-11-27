"use strict";

const assert = require("node:assert");

const M = require("../../lib/worldBosses/machine");
const S = require("../../lib/worldBosses/schema");
const { CATALOG_V1, validateCatalog } = require("../../lib/worldBosses/catalog");
const { createWorldBossRepository } = require("../../lib/worldBosses/repository");
const { createWorldBossService } = require("../../lib/worldBosses/service");
const { decideReward } = require("../../lib/worldBosses/rewards");
const { createWorldBossPayoutPump } = require("../../lib/worldBosses/payouts");
const { startWorldBosses } = require("../../lib/worldBosses");
const { bossStepKind } = require("../../lib/worldBosses/gmStep");
const { createStepRegistry } = require("../../lib/gameMaster/registry");
const { factsOfEntries, refKeysOf } = require("../../lib/news/collect/journalFacts");
const { KIND, newsSettingsOf } = require("../../lib/news/schema");
const { createJournal } = require("../../lib/persistence/journal");
const { loadDriver, withStore, withStoreAsync } = require("../notices/storeHelper");
const F = require("./fixture");

const KINDS = validateCatalog(CATALOG_V1).kinds;
const DRIFTER = KINDS.get("drifter_swarm");
const PILOT = 90000001;
const AFTERMATH = 1800000;
const ENV = Object.freeze({ EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "0", EVEJS_LNE_WORLD_BOSSES_LIVE_ENABLED: "1",
  EVEJS_LNE_WORLD_BOSSES_DWELL_MS: "3600000", EVEJS_LNE_WORLD_BOSSES_REWARDS_ENABLED: "1" });
const GRAPH = Object.freeze({ ...F.makeGraph(), getRegionName: (id) => (id === 100 ? "Delve" : null) });

const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeSeam(players) {
  const s = { players, alive: new Set(), next: 100 };
  s.seam = {
    readGrid: () => ({ ok: true, players: s.players.slice(), copies: 0 }),
    spawnPhase: (systemId, input) => ({ ok: true, unspawnable: [], spawned: input.members.map((m) => {
      s.next += 1;
      s.alive.add(s.next);
      return { memberKey: m.memberKey, entityId: s.next, hullGroup: m.hullGroup };
    }) }),
    readMembers: (systemId, ids) => ({ ok: true, live: ids.filter((id) => s.alive.has(id))
      .map((entityId) => ({ entityId, position: null })), gone: ids.filter((id) => !s.alive.has(id)) }),
    despawn: (systemId, ids) => ({ ok: true, removed: ids.length, missing: 0 }),
  };
  return s;
}

function fakeWrecks() {
  const w = { placed: new Map(), calls: [], next: 9000 };
  w.place = (spec) => {
    w.calls.push(spec);
    const key = `${spec.anomalyId}:${spec.slot}`;
    if (spec.adopt === true && w.placed.has(key)) return { ok: true, adopted: true, wreckId: w.placed.get(key) };
    w.next += 1;
    w.placed.set(key, w.next);
    return { ok: true, adopted: false, wreckId: w.next, vendorWrites: 0 };
  };
  return w;
}

function rig(store, clock, opts = {}) {
  const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 2000 });
  const repo = createWorldBossRepository({ journal });
  const fk = F.fakes([5]);
  const scene = fakeSeam(opts.players || [{ characterId: PILOT, entityId: 1 }]);
  const beacon = { active: true };
  const sites = { ...fk.sites, listSitesByEvent: (eventId) => ({ ok: true, sites: beacon.active ? [{ slot: 0,
    state: "ACTIVE", siteKey: `${eventId}:0`, position: { x: 1, y: 2, z: 3 }, eventId }] : [] }) };
  const presence = { observedSystems: () => [5], isObserved: (id) => id === 5, listPresence: () => [] };
  const wrecks = fakeWrecks();
  const wallet = { calls: [], answer: () => ({ ok: true }) };
  const failOnce = new Set();
  const tstore = { ...store, transaction: (name, fn) => {
    if (failOnce.has(name)) {
      failOnce.delete(name);
      return { ok: false, reason: "TX_FAILED" };
    }
    return store.transaction(name, fn);
  } };
  const make = (bootAt, env) => createWorldBossService({ store: tstore, journal, repo, worldSeed: 1, bootAt,
    settings: F.settingsFor({ ...ENV, ...(opts.env || {}), ...(env || {}) }), kinds: KINDS, getGraph: () => GRAPH,
    getPresence: () => presence, getOccupation: () => fk.occupation, getSites: () => sites,
    getWorldRepository: () => fk.worldRepository, getScene: () => scene.seam, getNotices: () => null,
    getGovernor: () => ({ admits: () => true }), getWrecks: () => wrecks,
    rewardCreditIsk: (spec) => {
      wallet.calls.push(spec);
      return Promise.resolve(wallet.answer(spec));
    } });
  const svc = make(1000);
  const made = store.transaction("test.wbr.spawn", (tx) => svc.spawnInTx(tx, { kind: "drifter_swarm",
    originKind: "admin", originRef: "pm:1", systemId: 5, at: clock.now }, "admin:pm:1"));
  assert.strictEqual(made.value.ok, true, JSON.stringify(made));
  return { svc, repo, journal, fk, scene, beacon, wrecks, wallet, failOnce, make, bossId: made.value.bossId };
}

function raw(store) {
  const r = store.transaction("test.wbr.raw", (db) => db.prepare("SELECT * FROM world_bosses").get());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function all(store, sql) {
  const r = store.transaction("test.wbr.all", (db) => db.prepare(sql).all());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function patchRow(store, R, to, patch, key) {
  const r = store.transaction("test.wbr.patch", (tx) => {
    const row = R.repo.getInTx(tx, R.bossId).row;
    return R.repo.transitionInTx(tx, { bossId: R.bossId, expectedVersion: row.version, from: row.state, to,
      now: Math.max(row.updatedAt, patch.endedAt || 0), patch }, { key, eventType: S.EVENT.LIVE, payload: {} });
  });
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function defeatLive(store, R, clock) {
  patchRow(store, R, "DWELL", { phase: 3, unitsJson: JSON.stringify(M.phaseUnits(DRIFTER.phases[2])) }, "test:p3");
  R.svc.livePass(clock.now);
  assert.strictEqual(raw(store).mode, "LIVE");
  R.scene.alive.clear();
  clock.now += 5000;
  R.svc.livePass(clock.now);
  assert.strictEqual(raw(store).state, "DEFEATED");
}

const counters = (svc) => svc.getStatus().counters;
const rewardKeys = (store) => all(store, "SELECT idempotency_key, payload AS payload_json FROM world_event_journal "
  + "WHERE idempotency_key LIKE 'wbrwd:%'");

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("WBR1-WBR3, WBR5-WBR7, WBR9 world boss rewards on a store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("WBR1 chest once: beacon kept, place adopted after a failed tx, one PLACED, release after aftermath; off = "
      + "cleanup", () => {
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        defeatLive(store, R, clock);
        const eventId = S.beaconEventIdOf(R.bossId, 1);
        let b = raw(store);
        assert.deepStrictEqual([b.reward_state, b.site_event_id, R.fk.cleanups], ["PENDING", eventId, []]);
        R.failOnce.add("worldBosses.rewardPlaced");
        clock.now += 1000;
        R.svc.runPass(clock.now);
        assert.deepStrictEqual([raw(store).reward_state, R.wrecks.calls.length, rewardKeys(store).length],
          ["PENDING", 1, 0]);
        clock.now += 1000;
        R.svc.runPass(clock.now);
        b = raw(store);
        assert.deepStrictEqual([b.reward_state, b.site_event_id, R.wrecks.calls.length, R.wrecks.placed.size],
          ["PLACED", eventId, 2, 1]);
        const spec = R.wrecks.calls[1];
        assert.deepStrictEqual([spec.anomalyId, spec.slot, spec.siteKey, spec.adopt, spec.lootRolls, spec.hullGroup],
          [eventId, 0, `${eventId}:0`, true, 4, "dreadnought"]);
        assert.deepStrictEqual(R.wrecks.calls[0].offset, spec.offset, "the same spot on a second place");
        const keys = rewardKeys(store);
        assert.strictEqual(keys.length, 1);
        assert.deepStrictEqual(JSON.parse(keys[0].payload_json), { bossId: R.bossId, outcome: "PLACED", wreckId: 9001,
          payouts: 1, amountIsk: 100000000 });
        assert.strictEqual(counters(R.svc).rewardPlaced, 1);
        clock.now += 1000;
        R.svc.runPass(clock.now);
        assert.deepStrictEqual([R.wrecks.calls.length, R.fk.cleanups], [2, []], "no second chest, beacon kept");
        R.svc.runPass(b.ended_at + AFTERMATH + 1);
        assert.deepStrictEqual([raw(store).site_event_id, R.fk.cleanups, counters(R.svc).rewardReleased],
          [null, [[eventId, "EVENT_END"]], 1]);
      });
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock, { env: { EVEJS_LNE_WORLD_BOSSES_REWARDS_ENABLED: "0" } });
        defeatLive(store, R, clock);
        const b = raw(store);
        assert.deepStrictEqual([b.reward_state, b.site_event_id, R.fk.cleanups],
          ["PENDING", null, [[S.beaconEventIdOf(R.bossId, 1), "EVENT_END"]]]);
        R.svc.runPass(clock.now + 1000);
        assert.deepStrictEqual([raw(store).reward_state, R.wrecks.calls.length], ["PENDING", 0], "flag off: no pass");
      });
    });

    test("WBR2 payouts: 3 participants -> 3 rows capped, duplicate -> PAID, permanent -> FAILED; none -> SKIPPED",
      async () => {
        await withStoreAsync(driver, async ({ store }) => {
          const clock = { now: F.T0 };
          const players = [PILOT, PILOT + 1, PILOT + 2].map((characterId, i) => ({ characterId, entityId: i + 1 }));
          const R = rig(store, clock, { players });
          R.wallet.answer = (spec) => (spec.characterId === PILOT ? { ok: true, duplicate: true }
            : spec.characterId === PILOT + 1 ? { ok: false, reason: "CHARACTER_NOT_FOUND" } : { ok: true });
          defeatLive(store, R, clock);
          clock.now += 1000;
          R.svc.runPass(clock.now);
          await tick();
          await tick();
          const rows = all(store, "SELECT payout_key, character_id, amount_isk, state FROM world_boss_payouts "
            + "ORDER BY character_id");
          assert.deepStrictEqual(rows.map((r) => [r.payout_key, r.amount_isk, r.state]), [
            [S.payoutKeyOf(R.bossId, PILOT), 100000000, "PAID"],
            [S.payoutKeyOf(R.bossId, PILOT + 1), 100000000, "FAILED"],
            [S.payoutKeyOf(R.bossId, PILOT + 2), 100000000, "PAID"]]);
          assert.ok(rows.reduce((a, r) => a + r.amount_isk, 0) <= 500000000);
          assert.deepStrictEqual(R.wallet.calls.map((c) => [c.commandId, c.source]).slice(0, 1),
            [[`lne:${S.payoutKeyOf(R.bossId, PILOT)}:isk`, "lne-worldbosses"]]);
          assert.deepStrictEqual([counters(R.svc).payoutsPaid, counters(R.svc).payoutsFailed], [2, 1]);
          await R.svc.payoutPass(clock.now + 1000);
          assert.strictEqual(R.wallet.calls.length, 3, "nothing paid twice");
        });
        withStore(driver, ({ store }) => {
          const clock = { now: F.T0 };
          const R = rig(store, clock);
          patchRow(store, R, "DEFEATED", { endedAt: clock.now, endReason: "DEFEATED", rewardState: "PENDING" },
            "test:defeated");
          R.svc.runPass(clock.now + 1000);
          const b = raw(store);
          assert.deepStrictEqual([b.reward_state, b.site_event_id], ["SKIPPED", null]);
          assert.deepStrictEqual(JSON.parse(rewardKeys(store)[0].payload_json).reason, "NO_PARTICIPANTS");
          assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_boss_payouts")[0].n, 0);
          assert.deepStrictEqual(R.fk.cleanups, [[S.beaconEventIdOf(R.bossId, 1), "EVENT_END"]]);
          assert.strictEqual(R.wrecks.calls.length, 0);
        });
      });

    test("WBR3 step BOSS: NO_BOSS / RUNNING / WON / LOST; FULL registry -> gmRefused, start ok; hint lines", () => {
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        const P = F.settingsFor(ENV);
        const kind = bossStepKind({ repo: R.repo, settings: P, getGraph: () => GRAPH, isRunning: () => true });
        assert.deepStrictEqual(kind.validate({}), { ok: true, params: {} });
        assert.deepStrictEqual(kind.validate({ x: 1 }), { ok: false, reason: "UNKNOWN_PARAM" });
        assert.ok(/^[\x20-\x7E]{1,160}$/.test(kind.promptHint));
        assert.strictEqual(kind.maxPerThread, 1);
        const inTx = (fn) => store.transaction("test.wbr.gm", fn).value;
        assert.deepStrictEqual(inTx((tx) => kind.startInTx(tx, { systemId: 12, now: clock.now })),
          { ok: false, reason: "NO_BOSS", retry: false });
        const started = inTx((tx) => kind.startInTx(tx, { systemId: 7, now: clock.now }));
        assert.deepStrictEqual(started, { ok: true, handle: { bossId: R.bossId }, dueAt: clock.now + 600000 });
        const s = { handle: started.handle, now: clock.now };
        assert.deepStrictEqual(inTx((tx) => kind.pollInTx(tx, s)), { state: "RUNNING", dueAt: clock.now + 600000 });
        assert.deepStrictEqual(inTx((tx) => kind.cancelInTx(tx, s)), { ok: true });
        R.svc.runPass(clock.now);
        const hint = R.svc.hintRead();
        assert.deepStrictEqual(hint, { lines: ["A Drifter Swarm Nexus roams Delve."] });
        assert.ok(hint.lines.length <= 3 && hint.lines.every((l) => /^[\x20-\x7E]{1,160}$/.test(l)));
        patchRow(store, R, "DEFEATED", { endedAt: clock.now, endReason: "DEFEATED" }, "test:won");
        assert.deepStrictEqual(inTx((tx) => kind.pollInTx(tx, s)), { state: "DONE", outcome: "WON" });
        assert.deepStrictEqual(inTx((tx) => kind.pollInTx(tx, { handle: { bossId: "wb-none" }, now: clock.now })),
          { state: "DONE", outcome: "LOST" });
      });
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        const P = F.settingsFor(ENV);
        const kind = bossStepKind({ repo: R.repo, settings: P, getGraph: () => GRAPH, isRunning: () => true });
        patchRow(store, R, "EXPIRED", { endedAt: clock.now, endReason: "MAX_HOPS" }, "test:lost");
        assert.deepStrictEqual(store.transaction("t", (tx) => kind.pollInTx(tx, { handle: { bossId: R.bossId },
          now: clock.now })).value, { state: "DONE", outcome: "LOST" });

        const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
        const config = F.configOf({ ...F.FAST_ENV, EVEJS_LNE_WORLD_BOSSES_ROLL_ENABLED: "0",
          EVEJS_LNE_WORLD_BOSSES_GM_ENABLED: "1" }).config;
        const setTimer = () => ({ cancel() {}, hasRef: () => false });
        const base = { config, persistence: { ok: true, store, journal, worldSeed: 1 }, clock: { now: () => clock.now },
          getGraph: () => GRAPH, getSites: () => R.fk.sites, setTimer };
        const full = { register: () => ({ ok: false, reason: "FULL" }),
          registerHintSource: () => ({ ok: false, reason: "FULL" }) };
        const refused = startWorldBosses({ ...base, gmSteps: full });
        assert.strictEqual(refused.ok, true, JSON.stringify(refused));
        assert.deepStrictEqual([refused.worldBosses.getStatus().counters.gmRefused,
          refused.worldBosses.getStatus().counters.hintRefused], [1, 1]);
        refused.worldBosses.stop();
        const registry = createStepRegistry();
        const ok = startWorldBosses({ ...base, gmSteps: registry });
        assert.strictEqual(ok.worldBosses.getStatus().counters.gmRegistered, 1);
        assert.deepStrictEqual([registry.get("BOSS").owner, registry.listHintSources().map((h) => h.key)],
          ["worldBosses", ["worldBosses"]]);
        ok.worldBosses.stop();
        assert.deepStrictEqual([registry.get("BOSS"), registry.listHintSources().length], [null, 0]);
        const absent = startWorldBosses({ ...base, gmSteps: null });
        assert.strictEqual(absent.worldBosses.getStatus().counters.gmAbsent, 1);
        absent.worldBosses.stop();
      });
    });

    test("WBR5 end replay: a new service tells a recent DEFEATED end once with replay:true; endReplayMs 0 = none",
      () => {
        withStore(driver, ({ store }) => {
          const clock = { now: F.T0 };
          const R = rig(store, clock, { env: { EVEJS_LNE_WORLD_BOSSES_REWARDS_ENABLED: "0" } });
          patchRow(store, R, "DEFEATED", { endedAt: clock.now, endReason: "DEFEATED", rewardState: "PENDING" },
            "test:end");
          const off = R.make(3000, { EVEJS_LNE_WORLD_BOSSES_END_REPLAY_MS: "0" });
          const none = [];
          off.addEndListener((e) => none.push(e));
          off.runPass(clock.now + 1000);
          assert.deepStrictEqual(none, []);
          const next = R.make(2000);
          const got = [];
          next.addEndListener((e) => got.push([e.bossId, e.outcome, e.replay]));
          next.runPass(clock.now + 1000);
          next.runPass(clock.now + 2000);
          assert.deepStrictEqual(got, [[R.bossId, "DEFEATED", true]]);
          assert.strictEqual(counters(next).endsReplayed, 1);
          const late = R.make(4000);
          const old = [];
          late.addEndListener((e) => old.push(e));
          late.runPass(clock.now + 600001);
          assert.deepStrictEqual(old, [], "older than endReplayMs");
        });
      });

    test("WBR6 a LIVE exit participant, the boss defeated virtually -> SKIPPED VIRTUAL, no payouts, no chest", () => {
      const P = F.settingsFor(ENV);
      const row = { endedAt: F.T0, rewardAttempts: 0 };
      const facts = { now: F.T0 + 1000, keyFound: false, participants: 1, siteActive: true };
      assert.deepStrictEqual(decideReward(row, { ...facts, liveEnd: false }, P), { action: "SKIP", reason: "VIRTUAL" });
      assert.deepStrictEqual(decideReward(row, facts, P), { action: "SKIP", reason: "VIRTUAL" }, "no fact = no pay");
      assert.deepStrictEqual(decideReward(row, { ...facts, liveEnd: true }, P), { action: "PLACE" });
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        R.svc.livePass(clock.now);
        assert.strictEqual(raw(store).mode, "LIVE");
        R.scene.players = [];
        clock.now += P.live.abandonGraceMs + 5000;
        R.svc.livePass(clock.now);
        assert.strictEqual(raw(store).mode, "VIRTUAL");
        assert.strictEqual(all(store, `SELECT count(*) AS n FROM ${S.PARTICIPANTS_TABLE}`)[0].n, 1);
        patchRow(store, R, "DEFEATED", { endedAt: clock.now, endReason: "DEFEATED", rewardState: "PENDING",
          siteEventId: null }, S.keyEnd(R.bossId));
        R.svc.runPass(clock.now + 1000);
        const b = raw(store);
        assert.deepStrictEqual([b.reward_state, b.site_event_id], ["SKIPPED", null]);
        assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_boss_payouts")[0].n, 0);
        const keys = rewardKeys(store);
        assert.strictEqual(keys.length, 1);
        assert.deepStrictEqual(JSON.parse(keys[0].payload_json), { bossId: R.bossId, outcome: "SKIPPED",
          reason: "VIRTUAL", payouts: 0, amountIsk: 0 });
        assert.strictEqual(R.wrecks.calls.length, 0);
      });
    });

    test("WBR7 a refused replay read -> no event, the next pass replays once", () => {
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock, { env: { EVEJS_LNE_WORLD_BOSSES_REWARDS_ENABLED: "0" } });
        patchRow(store, R, "DEFEATED", { endedAt: clock.now, endReason: "DEFEATED", rewardState: "PENDING" },
          "test:end");
        const next = R.make(2000);
        const got = [];
        next.addEndListener((e) => got.push([e.bossId, e.replay]));
        R.failOnce.add("worldBosses.replay");
        next.runPass(clock.now + 1000);
        assert.deepStrictEqual(got, []);
        next.runPass(clock.now + 2000);
        assert.deepStrictEqual(got, [[R.bossId, true]]);
        assert.strictEqual(counters(next).endsReplayed, 1);
      });
    });

    test("WBR9 a LIVE exit participant, an old virtual defeat -> SKIPPED STALE, no payouts, no chest", () => {
      const P = F.settingsFor(ENV);
      const row = { endedAt: F.T0, rewardAttempts: 0 };
      assert.deepStrictEqual(decideReward(row, { now: F.T0 + P.rewards.maxAgeMs + 1, keyFound: false, participants: 1,
        siteActive: true, liveEnd: false }, P), { action: "SKIP", reason: "STALE" });
      withStore(driver, ({ store }) => {
        const clock = { now: F.T0 };
        const R = rig(store, clock);
        R.svc.livePass(clock.now);
        assert.strictEqual(raw(store).mode, "LIVE");
        R.scene.players = [];
        clock.now += P.live.abandonGraceMs + 5000;
        R.svc.livePass(clock.now);
        assert.strictEqual(raw(store).mode, "VIRTUAL");
        assert.strictEqual(all(store, `SELECT count(*) AS n FROM ${S.PARTICIPANTS_TABLE}`)[0].n, 1);
        patchRow(store, R, "DEFEATED", { endedAt: clock.now, endReason: "DEFEATED", rewardState: "PENDING",
          siteEventId: null }, S.keyEnd(R.bossId));
        R.svc.runPass(clock.now + P.rewards.maxAgeMs + 1000);
        const b = raw(store);
        assert.deepStrictEqual([b.reward_state, b.site_event_id], ["SKIPPED", null]);
        assert.strictEqual(all(store, "SELECT count(*) AS n FROM world_boss_payouts")[0].n, 0, "No LIVE end");
        const keys = rewardKeys(store);
        assert.strictEqual(keys.length, 1);
        assert.deepStrictEqual(JSON.parse(keys[0].payload_json), { bossId: R.bossId, outcome: "SKIPPED",
          reason: "STALE", payouts: 0, amountIsk: 0 });
        assert.strictEqual(R.wrecks.calls.length, 0);
      });
    });
  }

  test("WBR8 a refused payout boot count -> logged, the first pass reads the table and pays", async () => {
    const reads = [];
    const logs = [];
    const credits = [];
    const row = { payoutKey: "wb:x:pay:1", bossId: "x", characterId: 1, systemId: 5, amountIsk: 10, attempts: 0 };
    const repo = {
      countPendingPayoutsInTx: () => ({ ok: false, reason: "X" }),
      listDuePayoutsInTx: () => {
        reads.push(1);
        return { ok: true, payouts: reads.length === 1 ? [row] : [], waiting: 0, nextDueAt: null };
      },
      markPayoutInTx: () => ({ ok: true }),
      prunePayoutsInTx: () => ({ ok: true, deleted: 0 }),
    };
    const store = { transaction: (name, fn) => ({ ok: true, value: fn({}) }) };
    const pump = createWorldBossPayoutPump({ store, repo, settings: F.settingsFor(ENV), bump: () => {},
      log: (l) => logs.push(l), isStopped: () => false,
      rewardCreditIsk: (spec) => {
        credits.push(spec.commandId);
        return Promise.resolve({ ok: true });
      } });
    assert.deepStrictEqual(pump.boot(), { ok: false, reason: "X" });
    assert.ok(logs.some((l) => l.includes("payout boot read failed")), JSON.stringify(logs));
    const r = await pump.runPayoutPass(F.T0);
    assert.deepStrictEqual([r.ok, r.paid, reads.length, credits], [true, 1, 1, ["lne:wb:x:pay:1:isk"]]);
  });

  test("WBR4 news: EMERGED + DEFEATED ({a} = winner), SLAIN (LIVE), WITHDREW, CANCELLED nothing; flag off", () => {
    const on = newsSettingsOf(F.configOf({ ...F.FAST_ENV, EVEJS_LNE_WORLD_BOSSES_NEWS_ENABLED: "1" }).config);
    assert.ok(on.ok, JSON.stringify(on));
    const wbKinds = [KIND.WORLD_BOSS_EMERGED, KIND.WORLD_BOSS_DEFEATED, KIND.WORLD_BOSS_SLAIN, KIND.WORLD_BOSS_WITHDREW];
    assert.ok(wbKinds.every((k) => on.settings.kinds.includes(k)));
    const off = newsSettingsOf(F.configOf({ ...F.FAST_ENV }).config);
    assert.ok(wbKinds.every((k) => !off.settings.kinds.includes(k)), "newsEnabled off");
    const spawned = (id, at) => ({ journalId: at, createdAt: at, aggregateType: "world_boss", aggregateId: id,
      eventType: "WORLD_BOSS_SPAWNED", payload: { bossId: id, kind: "drifter_swarm", factionId: 500024, systemId: 5,
        regionId: 100, originKind: "roll" } });
    const ended = (id, at, outcome, extra) => ({ journalId: at, createdAt: at, aggregateType: "world_boss",
      aggregateId: id, eventType: "WORLD_BOSS_ENDED", payload: { bossId: id, kind: "drifter_swarm", factionId: 500024,
        systemId: 6, regionId: 100, outcome, reason: outcome, topFactionId: 500001, ...(extra || {}) } });
    const entries = [spawned("wb1", 10), ended("wb1", 11, "DEFEATED"), spawned("wb2", 12),
      ended("wb2", 13, "DEFEATED", { mode: "LIVE" }), spawned("wb3", 14), ended("wb3", 15, "EXPIRED"),
      spawned("wb4", 16), ended("wb4", 17, "CANCELLED")];
    assert.deepStrictEqual(refKeysOf(entries), ["wbs:wb1", "wbs:wb2", "wbs:wb3", "wbs:wb4"]);
    const ctx = { kinds: on.settings.kinds, capitalClasses: [], refs: new Map(), cycleHours: 24, publishHourUtc: 12,
      place: (id) => ({ systemName: `S${id}`, regionName: "Delve" }), factionName: (id) => `F${id}` };
    const r = factsOfEntries(entries, ctx);
    assert.deepStrictEqual(r.skipped, {});
    assert.deepStrictEqual(r.facts.map((f) => [f.factKey, f.kind, f.data.factionA, f.data.factionB]), [
      ["wbs:wb1", "WORLD_BOSS_EMERGED", "F500024", null], ["wbe:wb1", "WORLD_BOSS_DEFEATED", "F500001", "F500024"],
      ["wbs:wb2", "WORLD_BOSS_EMERGED", "F500024", null], ["wbe:wb2", "WORLD_BOSS_SLAIN", "F500024", null],
      ["wbs:wb3", "WORLD_BOSS_EMERGED", "F500024", null], ["wbe:wb3", "WORLD_BOSS_WITHDREW", "F500024", null],
      ["wbs:wb4", "WORLD_BOSS_EMERGED", "F500024", null]]);
    assert.deepStrictEqual(r.facts[1].data.systemName, "S6");
    const offFacts = factsOfEntries(entries, { ...ctx, kinds: off.settings.kinds });
    assert.deepStrictEqual(offFacts.facts, []);
  });
};
