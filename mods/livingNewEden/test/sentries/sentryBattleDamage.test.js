"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const seams = require("../../lib/adapter/sentrySeams");
const { startSentries, createUnavailableSentries } = require("../../lib/sentries");
const { createSentryRepository } = require("../../lib/sentries/repository");
const { lazySentriesConsequence } = require("../../lib/battle");
const S = require("../../lib/sentries/schema");
const { harness: H } = require("../battle/settlement.test");
const { fakeVendor } = require("./factionSentries.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SYS = 30002000;
const CORP = 1000125;
const FULL_HP = 3000;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(reopen, count) {
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...DEFAULTS.sentries, enabled: true,
      battle: { ...DEFAULTS.sentries.battle, enabled: true } } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const v = fakeVendor();
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: v.modules[rel] }) });
    const adapter = { sentrySeams: () => ({ ok: true, seam, optional: {} }), bindSentryPolicy: () => ({ ok: true }) };
    const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
      scheduler: sr.scheduler, adapter,
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) } });
    assert.ok(started.ok, JSON.stringify(started));
    const repository = createSentryRepository({ journal });
    for (let n = 1; n <= count; n += 1) {
      const itemId = 7000 + n;
      v.items.set(itemId, Object.freeze({ itemID: itemId, typeID: 340501, ownerID: CORP, locationID: SYS, flagID: 0,
        categoryID: 23, groupID: 449, singleton: 1, quantity: 1,
        spaceState: { systemID: SYS, anchorState: "anchored", onlineState: "online" } }));
      tx((db) => assert.ok(repository.insertActive(db, { sentryId: `sf-${n}`, ownerKind: "faction", factionId: 500020,
        ownerCorpId: CORP, characterId: null, itemId, typeId: 340501, systemId: SYS, anchorKind: "gate",
        anchorId: 50000001, armedAt: 0, at: 0 }).ok));
    }
    assert.ok(started.service.rebuildArmed().ok);
    const hpOf = (n) => seam.readSentryItem(7000 + n).item.hp;
    const row = (n) => tx((db) => db.prepare("SELECT state, end_reason FROM world_sentries WHERE sentry_id = ?")
      .get(`sf-${n}`));
    const journaled = (battleId) => tx((db) => journal.findByKey(db, S.battleJournalKey(battleId))).found;
    const counters = () => started.service.getStatus().counters;
    const run = (battleId, hits) => started.service.onBattleDamage({ payload: { battleId, systemId: SYS, hits },
      dueAt: clock.now() }, { now: clock.now() });
    const commit = (r) => {
      const value = tx((db) => r.effect(db));
      r.onCommitted(value);
      return value;
    };
    const hit = (n, targetHp) => ({ sentryId: `sf-${n}`, itemId: 7000 + n, targetHp });
    return { clock, tx, v, sentries: started.sentries, service: started.service, hpOf, row, journaled, counters, run,
      commit, hit };
  }

  needsDriver("FD-D1 slot `sentries` through lazySentriesConsequence on the real facade: skipped, SENTRY_BATTLE_DAMAGE "
    + "once on sbdmg:<id>, targetHp, stub / bare function -> SENTRIES_OFF + counter", () => H.withStore(driver,
    async (reopen) => {
    const env = rig(reopen, 2);
    let off = 0;
    const cons = lazySentriesConsequence(() => env.sentries, () => { off += 1; });
    const at = env.clock.now();
    const empty = env.tx((db) => cons.apply(db, { battleId: "b-0", systemId: SYS, at, fixedDefenses: [] },
      "b-0:c:sentries"));
    assert.deepStrictEqual(empty, { ok: true, skipped: true });
    const settled = { battleId: "b-1", systemId: SYS, at, fixedDefenses: [
      { sentryId: "sf-1", itemId: 7001, hp: FULL_HP, ehp: 6000, damage: 1500, destroyed: false },
      { sentryId: "sf-2", itemId: 7002, hp: FULL_HP, ehp: 6000, damage: 7000, destroyed: true },
      { sentryId: "sf-3", itemId: 7003, hp: FULL_HP, damage: 500, destroyed: false },
      { sentryId: "sf-4", itemId: 7004, hp: FULL_HP, ehp: 6000, damage: 0, destroyed: false }] };
    const first = env.tx((db) => cons.apply(db, settled, "b-1:c:sentries"));
    const again = env.tx((db) => cons.apply(db, settled, "b-1:c:sentries"));
    assert.deepStrictEqual([first, again], [{ ok: true, duplicate: false, enqueued: "sbdmg:b-1" },
      { ok: true, duplicate: true, enqueued: "sbdmg:b-1" }]);
    const events = env.tx((db) => db.prepare("SELECT event_type, due_at, payload FROM world_scheduled_events "
      + "WHERE idempotency_key = ?").all("sbdmg:b-1"));
    assert.strictEqual(events.length, 1);
    assert.deepStrictEqual([events[0].event_type, events[0].due_at, JSON.parse(events[0].payload)],
      ["SENTRY_BATTLE_DAMAGE", at, { battleId: "b-1", systemId: SYS, hits: [
        { sentryId: "sf-1", itemId: 7001, targetHp: FULL_HP - Math.floor(1500 * FULL_HP / 6000) },
        { sentryId: "sf-2", itemId: 7002, targetHp: 0 }] }]);
    assert.strictEqual(off, 0);

    const stub = createUnavailableSentries("test");
    assert.strictEqual(stub.battleConsequence, null);
    const bare = { battleConsequence: () => ({ ok: true, enqueued: "never" }) };
    for (const facade of [stub, bare]) {
      const r = lazySentriesConsequence(() => facade, () => { off += 1; }).apply({}, settled, "b-1:c:sentries");
      assert.deepStrictEqual(r, { ok: true, skipped: "SENTRIES_OFF" });
    }
    assert.strictEqual(off, 2);
    env.sentries.stop("test");
  }));

  needsDriver("FD-D2 SENTRY_BATTLE_DAMAGE: delta to the target once, journal, replay STALE with battleDamageStale",
    () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen, 1);
    const r = env.run("b-2", [env.hit(1, 2000)]);
    assert.deepStrictEqual([r.ok, r.outcome], [true, "DAMAGE"], JSON.stringify(r));
    env.commit(r);
    const replay = env.run("b-2", [env.hit(1, 2000)]);
    assert.deepStrictEqual(replay, { ok: true, outcome: "STALE" });
    assert.deepStrictEqual([env.hpOf(1), env.v.updates, env.journaled("b-2"), env.row(1).state,
      env.counters().battleDamageApplied, env.counters().battleDamageStale], [2000, 1, true, S.ACTIVE, 1, 1]);
    env.sentries.stop("test");
  }));

  needsDriver("FD-D3 crash after the vendor write, before the commit: replay without a second write, killed row ends "
    + "BATTLE; hits already at target -> NO_EFFECT with the journal", () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen, 2);
    const hits = [env.hit(1, 1500), env.hit(2, 0)];
    const crashed = env.run("b-3", hits);
    assert.deepStrictEqual([crashed.ok, crashed.outcome, env.hpOf(1), env.hpOf(2), env.v.updates],
      [true, "DAMAGE", 1500, 0, 2]);
    const replay = env.run("b-3", hits);
    assert.deepStrictEqual([replay.ok, replay.outcome, env.v.updates], [true, "DAMAGE", 2], JSON.stringify(replay));
    env.commit(replay);
    assert.deepStrictEqual([env.row(1), env.row(2), env.journaled("b-3"), env.hpOf(1), env.counters().battleKills],
      [{ state: S.ACTIVE, end_reason: null }, { state: S.DESTROYED, end_reason: "BATTLE" }, true, 1500, 1]);
    assert.deepStrictEqual(env.run("b-3", hits), { ok: true, outcome: "STALE" });

    const atTarget = env.run("b-3b", [env.hit(1, 1500)]);
    assert.deepStrictEqual([atTarget.ok, atTarget.outcome], [true, "NO_EFFECT"], JSON.stringify(atTarget));
    env.commit(atTarget);
    assert.deepStrictEqual([env.journaled("b-3b"), env.v.updates, env.hpOf(1)], [true, 2, 1500]);
    env.sentries.stop("test");
  }));

  needsDriver("FD-D4 targetHp 0 -> DESTROYED/BATTLE once, the row leaves the live index", () => H.withStore(driver,
    async (reopen) => {
    const env = rig(reopen, 1);
    assert.ok(S.END_REASONS.includes("BATTLE") && S.LIVE_END_REASONS.includes("BATTLE"));
    const r = env.run("b-4", [env.hit(1, 0)]);
    assert.deepStrictEqual([r.ok, r.outcome], [true, "DAMAGE"]);
    const value = env.commit(r);
    assert.deepStrictEqual(value.ended, [{ sentryId: "sf-1", itemId: 7001 }]);
    assert.deepStrictEqual([env.row(1), env.hpOf(1), env.sentries.listLiveInSystem(SYS).length,
      env.counters().battleKills], [{ state: S.DESTROYED, end_reason: "BATTLE" }, 0, 0, 1]);
    assert.deepStrictEqual(env.run("b-4", [env.hit(1, 0)]), { ok: true, outcome: "STALE" });
    env.sentries.stop("test");
  }));

  needsDriver("FD-D5 a row no longer live -> hit skipped, NO_EFFECT with the journal, no vendor write",
    () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen, 1);
    assert.strictEqual(env.sentries.markEnded("sf-1", "LIVE_KILL").ok, true);
    const r = env.run("b-5", [env.hit(1, 0)]);
    assert.deepStrictEqual([r.ok, r.outcome], [true, "NO_EFFECT"], JSON.stringify(r));
    env.commit(r);
    assert.deepStrictEqual([env.journaled("b-5"), env.v.updates, env.hpOf(1), env.row(1).end_reason],
      [true, 0, FULL_HP, "LIVE_KILL"]);
    env.sentries.stop("test");
  }));

  needsDriver("FD-D6 EveJS refuses the only hit with work -> NO_HITS_LANDED without the journal, the retry lands",
    () => H.withStore(driver, async (reopen) => {
    const env = rig(reopen, 1);
    env.v.failUpdate = true;
    const refused = env.run("b-6", [env.hit(1, 2500)]);
    assert.deepStrictEqual(refused, { ok: false, reason: "NO_HITS_LANDED" });
    assert.deepStrictEqual([env.journaled("b-6"), env.hpOf(1)], [false, FULL_HP]);
    env.v.failUpdate = false;
    const retry = env.run("b-6", [env.hit(1, 2500)]);
    assert.deepStrictEqual([retry.ok, retry.outcome], [true, "DAMAGE"]);
    env.commit(retry);
    assert.deepStrictEqual([env.journaled("b-6"), env.hpOf(1)], [true, 2500]);
    env.sentries.stop("test");
  }));

  needsDriver("FD-D7 EveJS refuses one of two hits -> NO_HITS_LANDED without journal, battleDamageRefused=1; retry "
    + "lands the other hit, the refused one does not get a second vendor write", () => H.withStore(driver,
    async (reopen) => {
    const baseVendor = fakeVendor();
    const failUpdateFor = new Set([7002]);
    const originalItemStore = baseVendor.modules["services/inventory/itemStore"];
    const customItemStore = {
      ...originalItemStore,
      updateInventoryItem: (id, fn) => {
        if (failUpdateFor.has(id)) {
          failUpdateFor.delete(id);
          return { success: false, errorMsg: "ITEM_UPDATE_FAILED" };
        }
        return originalItemStore.updateInventoryItem(id, fn);
      },
    };
    const v = {
      ...baseVendor,
      modules: { ...baseVendor.modules, "services/inventory/itemStore": customItemStore },
      get updates() { return baseVendor.updates; },
    };
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      sentries: { ...DEFAULTS.sentries, enabled: true,
      battle: { ...DEFAULTS.sentries.battle, enabled: true } } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: v.modules[rel] }) });
    const adapter = { sentrySeams: () => ({ ok: true, seam, optional: {} }), bindSentryPolicy: () => ({ ok: true }) };
    const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
      scheduler: sr.scheduler, adapter,
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) } });
    assert.ok(started.ok, JSON.stringify(started));
    const repository = createSentryRepository({ journal });
    for (let n = 1; n <= 2; n += 1) {
      const itemId = 7000 + n;
      v.items.set(itemId, Object.freeze({ itemID: itemId, typeID: 340501, ownerID: CORP, locationID: SYS, flagID: 0,
        categoryID: 23, groupID: 449, singleton: 1, quantity: 1,
        spaceState: { systemID: SYS, anchorState: "anchored", onlineState: "online" } }));
      tx((db) => assert.ok(repository.insertActive(db, { sentryId: `sf-${n}`, ownerKind: "faction", factionId: 500020,
        ownerCorpId: CORP, characterId: null, itemId, typeId: 340501, systemId: SYS, anchorKind: "gate",
        anchorId: 50000001, armedAt: 0, at: 0 }).ok));
    }
    assert.ok(started.service.rebuildArmed().ok);
    const hpOf = (n) => seam.readSentryItem(7000 + n).item.hp;
    const row = (n) => tx((db) => db.prepare("SELECT state, end_reason FROM world_sentries WHERE sentry_id = ?")
      .get(`sf-${n}`));
    const journaled = (battleId) => tx((db) => journal.findByKey(db, S.battleJournalKey(battleId))).found;
    const counters = () => started.service.getStatus().counters;
    const run = (battleId, hits) => started.service.onBattleDamage({ payload: { battleId, systemId: SYS, hits },
      dueAt: clock.now() }, { now: clock.now() });
    const commit = (r) => {
      const value = tx((db) => r.effect(db));
      r.onCommitted(value);
      return value;
    };
    const hit = (n, targetHp) => ({ sentryId: `sf-${n}`, itemId: 7000 + n, targetHp });
    const env = { clock, tx, v, sentries: started.sentries, service: started.service, hpOf, row, journaled, counters, run,
      commit, hit };
    const refused = env.run("b-7", [env.hit(1, 2500), env.hit(2, 2500)]);
    assert.deepStrictEqual(refused, { ok: false, reason: "NO_HITS_LANDED" }, JSON.stringify(refused));
    assert.deepStrictEqual([env.journaled("b-7"), env.counters().battleDamageRefused], [false, 1]);
    assert.deepStrictEqual([env.hpOf(1), env.hpOf(2)], [2500, FULL_HP]);
    const retry = env.run("b-7", [env.hit(1, 2500), env.hit(2, 2500)]);
    assert.deepStrictEqual([retry.ok, retry.outcome], [true, "DAMAGE"], JSON.stringify(retry));
    env.commit(retry);
    const hp1 = env.hpOf(1);
    const hp2 = env.hpOf(2);
    const updates = env.v.updates;
    const journaledResult = env.journaled("b-7");
    const battleDamageApplied = env.counters().battleDamageApplied;
    assert.strictEqual(hp1, 2500, `hp1=${hp1}`);
    assert.strictEqual(hp2, 2500, `hp2=${hp2}`);
    assert.strictEqual(updates, 2, `updates=${updates}`);
    assert.strictEqual(journaledResult, true, `journaled=${journaledResult}`);
    assert.strictEqual(battleDamageApplied, 1, `battleDamageApplied=${battleDamageApplied}`);
    env.sentries.stop("test");
  }));
};
