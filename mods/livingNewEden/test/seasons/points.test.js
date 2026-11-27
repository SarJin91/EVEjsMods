"use strict";

const assert = require("node:assert");

const { createSeasonService } = require("../../lib/seasons/service");
const { createCrisisRegistry } = require("../../lib/seasons/registry");
const { createScoring } = require("../../lib/seasons/scoring");
const { observeKill } = require("../../lib/adapter/killObservation");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const { HOUR, T0 } = F;
const FAC = 500026;
const OTHER = 500001;
const REGION = 10000001;
const IN_SYS = 30000001;
const OUT_SYS = 30000011;
const PILOT = 90000001;
const regionOf = (systemId) => (systemId < 30000010 ? REGION : 10000002);

function bootActive(store, over) {
  const clock = { now: T0 };
  const journal = F.journalOf(clock);
  const scheduler = F.fakeScheduler();
  const registry = createCrisisRegistry();
  assert.ok(registry.register(F.stubKind("TEST_KIND", { propose: () => ({ ok: true,
    crisis: { factionId: FAC, regionIds: [REGION], params: {} } }) })).ok);
  F.tx(store, (db) => F.insertFaction(db, FAC, "ACTIVE"));
  const S = F.settingsOf({ durationMs: 4 * HOUR, firstStartDelayMs: 0, ...(over || {}) });
  const planned = [];
  const svc = createSeasonService({ store, journal, scheduler, worldSeed: 1, settings: S, registry, regionOf,
    clock: { now: () => clock.now }, onRewardsPlanned: (n) => planned.push(n) });
  assert.ok(svc.bootstrap().ok);
  assert.ok(F.runEvent(store, scheduler, svc.onStep, F.eventOf(scheduler, "season:1:step:PLANNED:0"), T0).committed);
  assert.strictEqual(svc.current().season.state, "ACTIVE");
  const score = (at) => {
    clock.now = at;
    const key = [...scheduler.events.keys()].filter((k) => k.startsWith("season:score:")).sort().pop();
    assert.ok(F.runEvent(store, scheduler, svc.onScore, F.eventOf(scheduler, key), at).committed);
  };
  const season = () => F.tx(store, (db) => db.prepare(`SELECT meter_defense AS d, payout_cursor_at AS a,
    payout_cursor_key AS k FROM world_seasons WHERE season_no = 1`).get());
  const scores = () => F.tx(store, (db) => db.prepare(`SELECT character_id AS c, points AS p, kills AS k,
    defenses AS d FROM world_season_scores ORDER BY character_id`).all()
    .map((r) => [Number(r.c), Number(r.p), Number(r.k), Number(r.d)]));
  return { svc, score, season, scores, S, scheduler, planned };
}

function insertPayout(db, key, characterId, systemId, plannedAt) {
  db.prepare(`INSERT INTO world_heavy_event_payouts (payout_key, event_id, character_id, issuer_faction_id, system_id,
    lp_corporation_id, isk_amount, lp_amount, standing_micro, description, isk_state, lp_state, std_state, state,
    attempts, next_attempt_at, last_error, planned_at, updated_at)
    VALUES (?, 'ev', ?, 500001, ?, NULL, 0, 0, 0, 'test', 'DONE', 'DONE', 'DONE', 'PAID', 0, 0, NULL, ?, ?)`)
    .run(key, characterId, systemId, plannedAt, plannedAt);
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("R1/R2 season points on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("R1 observeKill -> seasons listener: crisis F in region ok, other faction / outside / after the end NOT_CRISIS; "
    + "flush -> score row + meter_defense; ack only after the commit", () => {
    let row = { seasonNo: 1, state: "ACTIVE", startsAt: 0, endsAt: 100, crisis: { factionId: FAC, regionIds: [] } };
    const acc = createScoring({ getRow: () => row, regionOf, bump() {},
      settings: { maxPendingKeys: 64, killPoints: 2 } });
    assert.deepStrictEqual(acc.onNpcKill({ characterId: 7, victimFactionId: FAC, systemId: OUT_SYS, atMs: 5 }),
      { ok: true, queued: 1 });
    const peeked = acc.peekForFlush(8);
    assert.deepStrictEqual(peeked.map((e) => [e.characterId, e.points, e.kills]), [[7, 2, 1]]);
    acc.onNpcKill({ characterId: 7, victimFactionId: FAC, systemId: OUT_SYS, atMs: 6 });
    assert.strictEqual(acc.size(), 1, "no ack = nothing lost");
    acc.ack(peeked);
    assert.deepStrictEqual(acc.peekForFlush(8).map((e) => [e.points, e.kills]), [[2, 1]], "the later kill stays");
    row = null;
    assert.deepStrictEqual(acc.onNpcKill({ characterId: 7, victimFactionId: FAC, systemId: 1, atMs: 7 }),
      { ok: false, reason: "NO_SEASON" });

    withStore(driver, ({ store }) => {
      const r = bootActive(store, { minPointsForReward: 0 });
      const deps = { resolveVictimFactionID: (e) => e.factionID, getSeasons: () => ({ onNpcKill: r.svc.onNpcKill }) };
      const kill = (factionID, systemID, atMs, itemID) => observeKill(null, { itemID, typeID: 603, factionID,
        systemID }, PILOT, { systemID, nowMs: atMs }, deps);
      const startsAt = r.svc.current().season.startsAt;
      const endsAt = r.svc.current().season.endsAt;
      assert.deepStrictEqual(kill(FAC, IN_SYS, startsAt + 1000, 1).results.seasons, { ok: true, queued: 1 });
      assert.deepStrictEqual(kill(OTHER, IN_SYS, startsAt + 2000, 2).results.seasons,
        { ok: false, reason: "NOT_CRISIS" });
      assert.deepStrictEqual(kill(FAC, OUT_SYS, startsAt + 3000, 3).results.seasons,
        { ok: false, reason: "NOT_CRISIS" });
      assert.deepStrictEqual(kill(FAC, IN_SYS, endsAt, 4).results.seasons, { ok: false, reason: "NOT_CRISIS" });
      assert.deepStrictEqual(kill(FAC, IN_SYS, startsAt + 4000, 5).results.seasons, { ok: true, queued: 1 });
      r.score(startsAt + 60000);
      assert.deepStrictEqual(r.scores(), [[PILOT, 2 * r.S.killPoints, 2, 0]]);
      assert.strictEqual(Number(r.season().d), 2 * r.S.killPoints);
      assert.strictEqual(r.svc.pendingKills(), 0, "acked after the commit");
      const c = r.svc.getStatus().counters;
      assert.deepStrictEqual([c.killsQueued, c.killsNotCrisis], [2, 3]);
      r.score(startsAt + 120000);
      assert.deepStrictEqual(r.scores(), [[PILOT, 2 * r.S.killPoints, 2, 0]], "a second pass adds nothing");
      const mine = r.svc.scoreOf(PILOT);
      assert.deepStrictEqual([mine.ok, mine.seasonNo, mine.points, mine.rank, mine.titles], [true, 1, 2, 1, []]);
      kill(FAC, IN_SYS, endsAt - 1, 6);
      assert.ok(F.runEvent(store, r.scheduler, r.svc.onStep, F.eventOf(r.scheduler, "season:1:step:ACTIVE:0"),
        endsAt).committed);
      const reward = F.tx(store, (db) => db.prepare(`SELECT reward_key AS k, rank, points, tier, outcome, isk_amount AS i,
        isk_state AS si, item_state AS st, mail_state AS sm, state FROM world_season_rewards`).all());
      assert.deepStrictEqual(reward.map((x) => [x.k, Number(x.rank), Number(x.points), x.tier, x.outcome, Number(x.i),
        x.si, x.st, x.sm, x.state]), [["season:1:90000001", 1, 3, "CHAMPION", "WON", 75000000, "PENDING", "SKIPPED",
        "PENDING", "PENDING"]], "the last kill flushed before the ranking");
      assert.deepStrictEqual(r.planned, [1]);
      const after = r.svc.scoreOf(PILOT);
      assert.deepStrictEqual([after.seasonNo, after.points, after.rank, after.titles], [2, 0, null,
        [{ seasonNo: 1, tier: "CHAMPION" }]]);
    });
  });

  test("R2 heavy payout cursor: before starts_at / outside the regions / in the area -> +1 defense; second pass = "
    + "no change", () => {
    withStore(driver, ({ store }) => {
      const r = bootActive(store, { heavyDefensePoints: 5 });
      const startsAt = r.svc.current().season.startsAt;
      assert.deepStrictEqual([Number(r.season().a), r.season().k], [startsAt, ""], "cursor set at ACTIVE");
      F.tx(store, (db) => {
        insertPayout(db, "ev0:1", 91, IN_SYS, startsAt - 1000);
        insertPayout(db, "ev1:2", 92, OUT_SYS, startsAt + 1000);
        insertPayout(db, "ev2:3", 93, IN_SYS, startsAt + 2000);
      });
      r.score(startsAt + 60000);
      assert.deepStrictEqual(r.scores(), [[93, 5, 0, 1]]);
      assert.deepStrictEqual([Number(r.season().d), Number(r.season().a), r.season().k], [5, startsAt + 2000, "ev2:3"]);
      assert.strictEqual(r.svc.getStatus().counters.heavyDefenses, 1);
      r.score(startsAt + 120000);
      assert.deepStrictEqual(r.scores(), [[93, 5, 0, 1]], "the same payouts never count twice");
      assert.strictEqual(Number(r.season().d), 5);
    });
  });
};
