"use strict";

const assert = require("node:assert");

const { createSeasonRepository } = require("../../lib/seasons/repository");
const { createSeasonRewardPump } = require("../../lib/seasons/rewards");
const { loadDriver, withStoreAsync } = require("../notices/storeHelper");
const F = require("./fixture");

const { HOUR, T0 } = F;
const DAY = 24 * HOUR;
const A = 101;
const B = 102;
const STATION = 60003760;

function fakeAdapter() {
  const calls = { isk: [], grant: [], receipt: [], station: [], send: [], find: [] };
  const adapter = {
    rewardCreditIsk: async (spec) => {
      calls.isk.push(spec);
      return { ok: true, duplicate: true };
    },
    seasonRewardStation: (characterId, fallback) => {
      calls.station.push([characterId, fallback]);
      return characterId === A ? { ok: true, stationId: STATION, source: "FALLBACK" } : { ok: false, reason: "NO_STATION" };
    },
    tradeGrantStock: (spec) => {
      calls.grant.push(spec);
      return { ok: false, reason: "GRANT_FAILED", permanent: false, ambiguous: true, detail: "flush" };
    },
    tradeGrantReceipt: (key) => {
      calls.receipt.push(key);
      return { ok: true, found: true, quantity: 1, itemIds: [5] };
    },
    defaultMailSender: () => ({ ok: true, senderId: 3000001 }),
    sendPlayerMail: (spec) => {
      calls.send.push(spec);
      return spec.toCharacterId === A ? { ok: false, reason: "MAIL_REFUSED", definite: false, detail: "push" }
        : { ok: true, messageId: 77 };
    },
    findPlayerMail: (spec) => {
      calls.find.push(spec);
      return { ok: true, found: true, messageId: 88 };
    },
  };
  return { adapter, calls };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("R4 reward pump on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("R4 pump: ISK duplicate DONE; ITEM ambiguous -> receipt -> DONE; MAIL definite:false -> find; NO_STATION -> "
    + "SKIPPED; prune keeps rewards and the open season", async () => {
    await withStoreAsync(driver, async ({ store }) => {
      const repo = createSeasonRepository();
      const P = F.settingsOf({ scoreRetentionMs: DAY, payoutRetryBaseMs: 60000 });
      const crisis = { factionId: null, regionIds: [], params: {} };
      F.tx(store, (db) => {
        const s1 = repo.insertPlannedInTx(db, { seasonNo: 1, crisisKind: "TEST_KIND", crisisOwner: "test",
          crisisVersion: 1, crisis, seed: 1, startsAt: T0 - 20 * DAY, endsAt: T0 - 10 * DAY, stageCount: 2,
          stageDueAt: T0 - 15 * DAY, now: T0 - 20 * DAY });
        assert.ok(s1.ok, JSON.stringify(s1));
        assert.ok(repo.updateInTx(db, 1, 1, { state: "ARCHIVED", outcome: "WON", closeReason: "FINISHED",
          closedAt: T0 - 10 * DAY, now: T0 - 10 * DAY }).ok);
        assert.ok(repo.insertPlannedInTx(db, { seasonNo: 2, crisisKind: "TEST_KIND", crisisOwner: "test",
          crisisVersion: 1, crisis, seed: 2, startsAt: T0, endsAt: T0 + DAY, stageCount: 2, stageDueAt: T0 + HOUR,
          now: T0 }).ok);
        const item = (characterId) => ({ characterId, points: 20, kills: 2, defenses: 0, lastAt: T0 - 11 * DAY });
        assert.ok(repo.upsertScoresInTx(db, 1, [item(A), item(B)], 100).ok);
        assert.ok(repo.upsertScoresInTx(db, 2, [item(A)], 100).ok);
        const ins = repo.insertRewardsInTx(db, [
          { characterId: A, rank: 1, points: 20, tier: "CHAMPION", iskAmount: 100, itemTypeId: 34, itemQty: 1 },
          { characterId: B, rank: 2, points: 20, tier: "HERO", iskAmount: 0, itemTypeId: 34, itemQty: 1 },
        ], { seasonNo: 1, outcome: "WON", mailEnabled: true, now: T0 });
        assert.deepStrictEqual([ins.ok, ins.inserted, ins.pending], [true, 2, 2]);
      });
      const counters = new Map();
      const { adapter, calls } = fakeAdapter();
      const pump = createSeasonRewardPump({ store, repo, settings: P, adapter, log() {}, isStopped: () => false,
        bump: (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n) });
      assert.deepStrictEqual(pump.boot(), { ok: true, pending: 2 });
      const rows = () => F.tx(store, (db) => db.prepare(`SELECT character_id AS c, isk_state AS i, item_state AS t,
        mail_state AS m, state AS s, attempts AS a, station_id AS st, mail_message_id AS mid
        FROM world_season_rewards ORDER BY character_id`).all()
        .map((r) => [Number(r.c), r.i, r.t, r.m, r.s, Number(r.a), r.st === null ? null : Number(r.st),
          r.mid === null ? null : Number(r.mid)]));

      const first = await pump.runPass(T0);
      assert.deepStrictEqual(first, { ok: true, done: 1, failed: 0, retried: 1 });
      assert.deepStrictEqual(rows(), [[A, "DONE", "PENDING", "PENDING", "PENDING", 1, STATION, null],
        [B, "SKIPPED", "SKIPPED", "DONE", "DONE", 0, null, 77]]);
      assert.deepStrictEqual(calls.isk.map((s) => [s.commandId, s.amountIsk, s.systemId, s.description]),
        [["lne:season:1:101:isk", 100, 1, "LNE Season 1 reward"]]);
      assert.deepStrictEqual(calls.grant.map((g) => [g.ownerKind, g.ownerId, g.npcStationId, g.typeId, g.key]),
        [["character", A, STATION, 34, "lne:season:1:101:item"]]);
      assert.ok(calls.send[0].body.includes("Item: no station") && /^[\x20-\x7e]*$/.test(calls.send[0].body));
      assert.strictEqual(calls.send[0].title, "LNE Season 1 Hero");
      const left = F.tx(store, (db) => db.prepare(`SELECT season_no AS n, count(*) AS c FROM world_season_scores
        GROUP BY season_no`).all().map((r) => [Number(r.n), Number(r.c)]));
      assert.deepStrictEqual(left, [[2, 1]]);

      const early = await pump.runPass(T0 + 1000);
      assert.deepStrictEqual(early, { ok: true, done: 0, failed: 0, retried: 0 }, "the backoff holds the row");
      const second = await pump.runPass(T0 + 60000);
      assert.deepStrictEqual(second, { ok: true, done: 1, failed: 0, retried: 0 });
      assert.strictEqual(calls.grant.length, 1, "no second grant: the receipt was found");
      assert.deepStrictEqual(calls.receipt, ["lne:season:1:101:item"]);
      assert.deepStrictEqual(rows(), [[A, "DONE", "DONE", "DONE", "DONE", 1, STATION, 88],
        [B, "SKIPPED", "SKIPPED", "DONE", "DONE", 0, null, 77]]);
      const sentA = calls.send.find((s) => s.toCharacterId === A);
      assert.deepStrictEqual(calls.find.map((f) => [f.characterId, f.senderId, f.sentDate, f.title]),
        [[A, 3000001, sentA.sentDate, "LNE Season 1 Champion"]]);
      assert.ok(sentA.body.includes(`delivered to your hangar in station ${STATION}`));
      assert.deepStrictEqual(["rewardLeg.isk.DONE", "rewardLeg.item.DONE", "rewardLeg.item.SKIPPED",
        "rewardLeg.mail.DONE", "rewardsDone", "rewardDuplicates"].map((n) => counters.get(n) || 0), [1, 1, 1, 2, 2, 2]);
      assert.strictEqual(pump.status().pending, 0);
      assert.strictEqual(F.tx(store, (db) => Number(db.prepare("SELECT count(*) AS n FROM world_season_rewards")
        .get().n)), 2);
    });
  });

  test("R6 pump: boot COUNT ok:false -> the first pass pays the PENDING row; the empty table is not read again",
    async () => {
      await withStoreAsync(driver, async ({ store }) => {
        const base = createSeasonRepository();
        let reads = 0;
        const repo = { ...base, countPendingRewardsInTx: () => ({ ok: false, reason: "STORE_ERROR" }),
          listDueRewardsInTx: (...args) => {
            reads += 1;
            return base.listDueRewardsInTx(...args);
          } };
        F.tx(store, (db) => {
          assert.ok(base.insertPlannedInTx(db, { seasonNo: 1, crisisKind: "TEST_KIND", crisisOwner: "test",
            crisisVersion: 1, crisis: { factionId: null, regionIds: [], params: {} }, seed: 1, startsAt: T0 - 2 * DAY,
            endsAt: T0 - DAY, stageCount: 2, stageDueAt: T0 - DAY, now: T0 - 2 * DAY }).ok);
          const ins = base.insertRewardsInTx(db, [{ characterId: A, rank: 1, points: 20, tier: "CHAMPION",
            iskAmount: 100, itemTypeId: 0, itemQty: 1 }], { seasonNo: 1, outcome: "WON", mailEnabled: false, now: T0 });
          assert.ok(ins.ok, JSON.stringify(ins));
        });
        const { adapter, calls } = fakeAdapter();
        const pump = createSeasonRewardPump({ store, repo, settings: F.settingsOf({}), adapter, log() {},
          isStopped: () => false, bump() {} });
        assert.deepStrictEqual(pump.boot(), { ok: false, reason: "STORE_ERROR" });
        const first = await pump.runPass(T0);
        assert.ok(first.ok && first.done === 1, JSON.stringify(first));
        assert.ok(calls.isk.length >= 1);
        assert.strictEqual(reads, 1);
        assert.strictEqual(pump.status().pending, 0);
        await pump.runPass(T0 + 60000);
        assert.strictEqual(reads, 1, "the empty table is not read again");
      });
    });
};
