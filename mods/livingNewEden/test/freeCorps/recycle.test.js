"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const H = require("./hunting.test").harness;
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createManualClock } = require("../../lib/util/clock");
const membersModule = require("../../lib/freeCorps/membersRepository");
const outboxModule = require("../../lib/freeCorps/outboxRepository");
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const { createRecyclePump } = require("../../lib/freeCorps/recyclePump");
const { keyJoin, keyCeoClean } = require("../../lib/freeCorps/schema");
const { moveFreeCharacterWith } = require("../../lib/adapter/freeCorpRecycle");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const L3 = 30000013;
const DAY = "2033-05-18";

function cfgOf({ recycle = {}, fc = {}, lifecycle = {} } = {}) {
  const base = H.cfgOf({ hunting: { enabled: false } });
  const f = base.freeCorps;
  return { ...base, freeCorps: { ...f, membersMax: 10, ...fc, lifecycle: { ...f.lifecycle, ...lifecycle },
    recycle: { ...f.recycle, enabled: true, ...recycle } } };
}

function graphOf() {
  const sys = { [H.L1]: [10000002, [H.L2]], [H.L2]: [10000002, [H.L1]], [L3]: [10000099, []] };
  const byId = new Map(Object.entries(sys).map(([id, [regionId]]) => [Number(id), { id: Number(id), name: `S${id}`,
    regionId, constellationId: 20000020, secClass: "lowsec" }]));
  return { getSystem: (id) => byId.get(id) || null,
    getSystemsBySecClass: (band) => [...byId.values()].filter((v) => v.secClass === band).map((v) => v.id),
    getNeighbors: (id) => (sys[id] ? sys[id][1].slice() : null) };
}

const identity = (corporationId, ids) => ({ ok: true, state: "LINKED", corporationId, ceoCharacterId: ids[0],
  characterIds: ids.slice(), refusedMemberCount: 0 });
const members = membersModule.createFreeCorpMembersRepository();

function tx(opened, fn) {
  const r = opened.store.transaction("t.rc", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function addMember(opened, row, now = H.T0 - 1000) {
  const r = tx(opened, (db) => members.insertInTx(db, { origin_corp_id: 50, vendor_corporation_id: 98000050,
    corp_id: null, state: "FREE", ...row }, now));
  assert.ok(r.ok, JSON.stringify(r));
}

const memberRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_members ORDER BY character_id");
const outboxRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_outbox WHERE kind IN ('JOIN','CORP_CLOSE') "
  + "ORDER BY key");

function mergeScene(opened, cfg, { struggle = 8, partnerHome = H.L1, weakMembers = 4, extra = {} } = {}) {
  H.seedCorp(opened, { corpId: 1, archetype: "miner", isk: 0 });
  H.seedCorp(opened, { corpId: 2, archetype: "miner", isk: 5000000000, nextAt: H.T0 + 86400000 });
  H.exec(opened, "UPDATE world_free_corps SET state = 'STRUGGLING', struggle_count = ?, members_target = ? "
    + "WHERE corp_id = 1", struggle, weakMembers);
  H.exec(opened, "UPDATE world_free_corps SET members_target = 8, home_system_id = ? WHERE corp_id = 2", partnerHome);
  const graph = graphOf();
  const calls = { seam: 0 };
  const env = H.boot(opened, { cfg, extra: { getGraph: () => ({ ok: true, graph }),
    freeCorpRecycleSeams: () => { calls.seam += 1; return { ok: true }; },
    moveFreeCharacter: () => ({ ok: false, reason: "NOT_IN_TEST" }),
    setCorporationDescription: () => ({ ok: false, reason: "NOT_IN_TEST" }), ...extra } });
  env.vc.identities.set(1, identity(98000001, [9801, 9802, 9803, 9804]));
  env.vc.identities.set(2, identity(98000002, [9821, 9822, 9823, 9824, 9825, 9826, 9827, 9828]));
  env.calls = calls;
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("RC2 a merger is planned once: MERGED, 2 JOINING + 1 FREE, JOIN x2 + CORP_CLOSE, partner 10 "
    + "recruited 2, one journal entry; replay; another region -> no partner, dissolve -> 3 FREE", () => {
    withStore(driver, (opened) => {
      const env = mergeScene(opened, cfgOf());
      const st = H.pass(env);
      const weak = H.all(opened, "SELECT * FROM world_free_corps WHERE corp_id = 1")[0];
      assert.deepStrictEqual([weak.state, weak.open, weak.merged_into, weak.end_reason, weak.isk],
        ["MERGED", 0, 2, "MERGED", 0]);
      const partner = H.all(opened, "SELECT * FROM world_free_corps WHERE corp_id = 2")[0];
      assert.deepStrictEqual([partner.members_target, partner.recruited, partner.isk], [10, 2, 5000000000]);
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.moves,
        m.origin_corp_id, m.vendor_corporation_id]), [[9802, "JOINING", 2, 1, 1, 98000001],
        [9803, "JOINING", 2, 1, 1, 98000001], [9804, "FREE", null, 1, 1, 98000001]]);
      const ob = outboxRows(opened);
      assert.deepStrictEqual(ob.map((r) => [r.key, r.kind]), [["lne:fc:close:1", "CORP_CLOSE"],
        ["lne:fc:join:9802:1", "JOIN"], ["lne:fc:join:9803:1", "JOIN"]]);
      assert.deepStrictEqual(JSON.parse(ob[0].payload), { v: 1, corpId: 1, corporationId: 98000001,
        description: `Merged into Corp 2 ${DAY}` });
      assert.deepStrictEqual(JSON.parse(ob[1].payload), { v: 1, characterId: 9802, corpId: 2, seq: 1 });
      const j = H.all(opened, "SELECT COUNT(*) AS n FROM world_event_journal WHERE idempotency_key = 'lne:fc:merge:1'");
      assert.strictEqual(j[0].n, 1);
      assert.deepStrictEqual([st.counters.rcMerged, st.counters.rcFreed], [1, 1]);
      assert.strictEqual(env.calls.seam, 1, "the seam once per pass");
      assert.strictEqual(env.vc.ensures.length, 0, "no repair of the closed corporation");
      assert.deepStrictEqual(Object.keys(st.recycle).sort(), ["enabled", "free", "joining", "lastCallMs", "mode",
        "seam", "slowUntil"]);
      H.pass(env);
      assert.strictEqual(memberRows(opened).length, 3, "replay: no new member row");
      assert.strictEqual(outboxRows(opened).length, 3, "replay: no new outbox row");
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      const env = mergeScene(opened, cfgOf({ lifecycle: { dissolveEnabled: true } }), { struggle: 11,
        partnerHome: L3 });
      const st = H.pass(env);
      const weak = H.all(opened, "SELECT state, end_reason, merged_into FROM world_free_corps WHERE corp_id = 1")[0];
      assert.deepStrictEqual([weak.state, weak.end_reason, weak.merged_into], ["DISSOLVED", "BANKRUPT", null]);
      assert.strictEqual(st.counters.rcMergeNoPartner, 1);
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state]), [[9802, "FREE"],
        [9803, "FREE"], [9804, "FREE"]]);
      const ob = outboxRows(opened);
      assert.deepStrictEqual(ob.map((r) => r.key), ["lne:fc:close:1"]);
      assert.strictEqual(JSON.parse(ob[0].payload).description, `Disbanded ${DAY}`);
      env.fc.stop();
    });
  });

  needsDriver("RC3 recruitment before creation: founding of 5 with a pool of 3 -> recruited 3, ensure 2, budget "
    + "of the born; growth from a pool of 1 without ensure; empty pool -> ensure; REFUSE frees the recruits", () => {
    const H1 = 30000001;
    withStore(driver, (opened) => {
      for (const id of [9901, 9902, 9903]) addMember(opened, { character_id: id });
      const cfg = cfgOf({ fc: { targetCorps: 1, membersMin: 5, membersMax: 5, bandWeights: "highsec:100" } });
      const env = H.boot(opened, { cfg, spec: { [H1]: { band: "highsec", links: [] } }, stationSystems: [H1],
        extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
      const st = H.pass(env);
      const row = H.all(opened, "SELECT corp_id, state, members_target, recruited FROM world_free_corps")[0];
      assert.deepStrictEqual([row.state, row.members_target, row.recruited], ["FOUNDING", 5, 3]);
      assert.deepStrictEqual(env.vc.ensures.map((s) => s.members), [2], "the saga makes only the born");
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.moves]),
        [[9901, "JOINING", row.corp_id, 2], [9902, "JOINING", row.corp_id, 2], [9903, "JOINING", row.corp_id, 2]]);
      assert.strictEqual(outboxRows(opened).filter((r) => r.kind === "JOIN").length, 3);
      assert.strictEqual(st.counters.rcRecruitFounding, 3);
      assert.strictEqual(st.ownerCharacters.used, 2, "the budget counts the born only");
      env.fc.stop();
    });
    for (const pool of [1, 0]) {
      withStore(driver, (opened) => {
        if (pool > 0) addMember(opened, { character_id: 9911 });
        H.seedCorp(opened, { corpId: 1, archetype: "miner", isk: 3000000000, ventureSeq: 0 });
        const env = H.boot(opened, { cfg: cfgOf(), extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
        env.vc.identities.set(1, identity(98000001, [9001, 9002, 9003, 9004, 9005]));
        const st = H.pass(env);
        const row = H.all(opened, "SELECT members_target, recruited FROM world_free_corps WHERE corp_id = 1")[0];
        if (pool > 0) {
          assert.deepStrictEqual([row.members_target, row.recruited], [6, 1]);
          assert.strictEqual(env.vc.ensures.length, 0, "no ensure for a recruit");
          assert.deepStrictEqual(memberRows(opened).map((m) => [m.state, m.corp_id]), [["JOINING", 1]]);
          assert.strictEqual(st.counters.rcRecruitGrowth, 1);
        } else {
          assert.deepStrictEqual([row.members_target, row.recruited], [6, 0]);
          assert.deepStrictEqual(env.vc.ensures.map((s) => s.members), [6], "the growth of before");
          assert.strictEqual(st.counters.grew, 1);
        }
        env.fc.stop();
      });
    }
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "miner" });
      H.exec(opened, "UPDATE world_free_corps SET state = 'FOUNDING', corporation_id = NULL, recruited = 2 "
        + "WHERE corp_id = 1");
      for (const id of [9921, 9922]) addMember(opened, { character_id: id, corp_id: 1, state: "JOINING" });
      const env = H.boot(opened, { cfg: cfgOf({ recycle: { enabled: false } }) });
      env.vc.identities.set(1, { ok: true, state: "REFUSED", reason: "NAME_TAKEN" });
      const st = H.pass(env);
      assert.strictEqual(H.all(opened, "SELECT state FROM world_free_corps WHERE corp_id = 1")[0].state, "REFUSED");
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.moves]),
        [[9921, "FREE", null, 2], [9922, "FREE", null, 2]]);
      assert.strictEqual(st.counters.rcReleasedRefused, 2);
      env.fc.stop();
    });
  });

  needsDriver("RC4 pump: DONE + MEMBER, a crash after the move -> already -> DONE with one move, TARGET_PENDING "
    + "without an attempt, SUPERSEDED without a call, CHARACTER_MISSING -> LOST and recruited - 1, pool index", () => {
    withStore(driver, (opened) => {
      const S = { ...cfgOf().freeCorps.recycle };
      const clock = createManualClock(H.T0);
      const outbox = outboxModule.createFreeCorpOutboxRepository();
      const repo = createFreeCorpRepository();
      H.seedCorp(opened, { corpId: 2, archetype: "miner" });
      H.seedCorp(opened, { corpId: 3, archetype: "miner" });
      H.exec(opened, "UPDATE world_free_corps SET recruited = 3 WHERE corp_id = 2");
      H.exec(opened, "UPDATE world_free_corps SET state = 'FOUNDING', corporation_id = NULL, recruited = 1 "
        + "WHERE corp_id = 3");
      const corpOf = new Map([[9802, 98000001], [9803, 98000001], [9804, 98000001], [9805, 98000001]]);
      const moved = new Map();
      const mods = { characterState: { peekCharacterRecord: (id) => (corpOf.has(id)
        ? { corporationID: corpOf.get(id) } : null) },
      corporationState: { getCorporationRecord: (id) => ({ corporationID: id }),
        setCharacterAffiliation: (id, corp) => {
          corpOf.set(id, corp);
          moved.set(id, (moved.get(id) || 0) + 1);
          return { success: true };
        } },
      corporationRuntimeState: { ensureCharacterMemberState: () => ({}), getCorporationMember: () => null,
        updateCorporationRuntime: () => ({ success: true }) } };
      let calls = 0;
      const pumpOf = (ob = outbox) => createRecyclePump({ store: opened.store, outbox: ob, members, repo, clock,
        nowMs: () => 0, moveFreeCharacter: (spec) => { calls += 1; return moveFreeCharacterWith(mods, spec); },
        setCorporationDescription: () => ({ ok: true, changed: true }), freeCorpRecycleSeams: () => ({ ok: true }),
        getGovernor: () => null, workClass: "MAINTENANCE", isRunning: () => true, bump: () => {}, metric: () => {},
        log: () => {}, setTimer: () => ({ cancel() {}, hasRef: () => false }), S,
        retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 }, mode: "LIVE" });
      const join = (characterId, corpId, seq = 1) => tx(opened, (db) => outbox.enqueueInTx(db, {
        key: keyJoin(characterId, seq), kind: "JOIN", payload: { v: 1, characterId, corpId, seq }, now: clock.now() }));
      const member = (id) => H.all(opened, "SELECT * FROM world_free_corp_members WHERE character_id = ?", id)[0];
      const box = (id, seq = 1) => H.all(opened, "SELECT * FROM world_free_corp_outbox WHERE key = ?", keyJoin(id, seq))[0];
      const step = () => clock.set(clock.now() + S.joinSpacingMs);

      addMember(opened, { character_id: 9802, corp_id: 2, state: "JOINING", vendor_corporation_id: 98000001 });
      join(9802, 2);
      const r1 = pumpOf().runNow();
      assert.deepStrictEqual([r1.ok, r1.outcome], [true, "done"]);
      assert.deepStrictEqual([member(9802).state, member(9802).vendor_corporation_id], ["MEMBER", 98000002]);
      assert.deepStrictEqual([box(9802).state, box(9802).result_id], ["DONE", 98000002]);

      step();
      addMember(opened, { character_id: 9803, corp_id: 2, state: "JOINING", vendor_corporation_id: 98000001 });
      join(9803, 2);
      const broken = { ...outbox, completeInTx: () => { throw new Error("crash before settle"); } };
      assert.strictEqual(pumpOf(broken).runNow().reason, "SETTLE_FAILED");
      assert.deepStrictEqual([box(9803).state, box(9803).attempts, member(9803).state], ["PENDING", 1, "JOINING"]);
      step();
      const r2 = pumpOf().runNow();
      assert.deepStrictEqual([r2.outcome, r2.call.already], ["done", true]);
      assert.strictEqual(moved.get(9803), 1, "one move at the vendor");
      assert.strictEqual(member(9803).state, "MEMBER");

      step();
      addMember(opened, { character_id: 9804, corp_id: 3, state: "JOINING" });
      join(9804, 3);
      const before = calls;
      assert.strictEqual(pumpOf().runNow().outcome, "targetWait");
      assert.deepStrictEqual([box(9804).state, box(9804).attempts, box(9804).last_error, box(9804).next_at],
        ["PENDING", 0, "TARGET_PENDING", clock.now() + S.targetWaitMs]);
      assert.strictEqual(calls, before);

      addMember(opened, { character_id: 9805, corp_id: 2, state: "JOINING" });
      tx(opened, (db) => members.moveInTx(db, { characterId: 9805, expectedVersion: 1, corpId: 2, state: "JOINING",
        now: clock.now(), moves: 1 }));
      join(9805, 2, 1);
      assert.strictEqual(pumpOf().runNow().outcome, "superseded");
      assert.deepStrictEqual([box(9805).state, box(9805).last_error], ["FAILED", "SUPERSEDED"]);
      assert.strictEqual(calls, before);

      addMember(opened, { character_id: 9806, corp_id: 2, state: "JOINING" });
      join(9806, 2);
      assert.strictEqual(pumpOf().runNow().outcome, "failed");
      assert.deepStrictEqual([box(9806).state, member(9806).state, member(9806).corp_id], ["FAILED", "LOST", null]);
      assert.strictEqual(H.all(opened, "SELECT recruited FROM world_free_corps WHERE corp_id = 2")[0].recruited, 2);

      const plan = tx(opened, (db) => db.prepare("EXPLAIN QUERY PLAN SELECT character_id, origin_corp_id, corp_id, "
        + "state, vendor_corporation_id, moves, joined_at, left_at, updated_at, version FROM world_free_corp_members "
        + "WHERE state = 'FREE' ORDER BY left_at, character_id LIMIT ?").all(5).map((r) => r.detail).join(" | "));
      assert.ok(plan.includes("world_free_corp_members_pool"), plan);
    });
  });

  needsDriver("RC6 a dissolve without rc (flag off since / seam DRIFT) frees its 2 MEMBER recruits; a "
    + "JOIN to a closed target -> FAILED TARGET_CLOSED, the member FREE, no vendor call", () => {
    for (const variant of ["flagOff", "seamDrift"]) {
      withStore(driver, (opened) => {
        const cfg = cfgOf({ recycle: { enabled: variant === "seamDrift" }, lifecycle: { dissolveEnabled: true } });
        const extra = variant === "seamDrift" ? { freeCorpRecycleSeams: () => ({ ok: false, reason: "DRIFT" }) } : {};
        const env = mergeScene(opened, cfg, { struggle: 11, extra });
        H.exec(opened, "UPDATE world_free_corps SET recruited = 2 WHERE corp_id = 1");
        for (const id of [9931, 9932]) {
          addMember(opened, { character_id: id, corp_id: 1, state: "JOINING" });
          H.exec(opened, "UPDATE world_free_corp_members SET state = 'MEMBER', joined_at = ? WHERE character_id = ?",
            H.T0 - 900, id);
        }
        const st = H.pass(env);
        assert.strictEqual(H.all(opened, "SELECT state FROM world_free_corps WHERE corp_id = 1")[0].state, "DISSOLVED",
          variant);
        assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.moves]),
          [[9931, "FREE", null, 2], [9932, "FREE", null, 2]], variant);
        assert.strictEqual(st.counters.rcReleasedDissolved, 2, variant);
        assert.strictEqual(outboxRows(opened).length, 0, `${variant}: no JOIN / CORP_CLOSE without rc`);
        env.fc.stop();
      });
    }
    withStore(driver, (opened) => {
      const S = { ...cfgOf().freeCorps.recycle };
      const clock = createManualClock(H.T0);
      const outbox = outboxModule.createFreeCorpOutboxRepository();
      H.seedCorp(opened, { corpId: 4, archetype: "miner" });
      H.exec(opened, "UPDATE world_free_corps SET state = 'DISSOLVED', open = 0, ended_at = ?, end_reason = 'BANKRUPT', "
        + "recruited = 1 WHERE corp_id = 4", H.T0 - 500);
      addMember(opened, { character_id: 9941, corp_id: 4, state: "JOINING" });
      tx(opened, (db) => outbox.enqueueInTx(db, { key: keyJoin(9941, 1), kind: "JOIN",
        payload: { v: 1, characterId: 9941, corpId: 4, seq: 1 }, now: clock.now() }));
      let calls = 0;
      const bumps = [];
      const pump = createRecyclePump({ store: opened.store, outbox, members, repo: createFreeCorpRepository(), clock,
        nowMs: () => 0, moveFreeCharacter: () => { calls += 1; return { ok: true }; },
        setCorporationDescription: () => ({ ok: true }), freeCorpRecycleSeams: () => ({ ok: true }),
        getGovernor: () => null, workClass: "MAINTENANCE", isRunning: () => true, bump: (n) => bumps.push(n),
        metric: () => {}, log: () => {}, setTimer: () => ({ cancel() {}, hasRef: () => false }), S,
        retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 }, mode: "DRAIN" });
      const r = pump.runNow();
      assert.deepStrictEqual([r.ok, r.outcome], [true, "targetClosed"]);
      assert.strictEqual(calls, 0, "no vendor call");
      const box = H.all(opened, "SELECT state, last_error FROM world_free_corp_outbox WHERE key = ?", keyJoin(9941, 1))[0];
      assert.deepStrictEqual([box.state, box.last_error], ["FAILED", "TARGET_CLOSED"]);
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.state, m.corp_id, m.moves]), [["FREE", null, 2]]);
      assert.ok(bumps.includes("rcJoinTargetClosed"));
    });
  });

  needsDriver("RC7 CEO_CLEAN: moveFreeCharacter({cleanSource:true, fromHint}) of a CEO already in the target "
    + "-> no affiliation, the source entry deleted, DONE; a closed target -> FAILED TARGET_CLOSED without a call", () => {
    withStore(driver, (opened) => {
      const S = { ...cfgOf().freeCorps.recycle };
      const clock = createManualClock(H.T0);
      const outbox = outboxModule.createFreeCorpOutboxRepository();
      H.seedCorp(opened, { corpId: 5, archetype: "miner" });
      H.seedCorp(opened, { corpId: 6, archetype: "miner" });
      H.exec(opened, "UPDATE world_free_corps SET state = 'DISSOLVED', open = 0, ended_at = ?, end_reason = 'BANKRUPT' "
        + "WHERE corp_id = 6", H.T0 - 500);
      const affiliations = [];
      const cleaned = [];
      const mods = { characterState: { peekCharacterRecord: () => ({ corporationID: 98000005 }) },
        corporationState: { getCorporationRecord: (id) => ({ corporationID: id }),
          setCharacterAffiliation: (id, corp) => { affiliations.push([id, corp]); return { success: true }; } },
        corporationRuntimeState: { ensureCharacterMemberState: () => ({}),
          getCorporationMember: (corp) => (corp === 98000001 ? { characterID: 9951 } : {}),
          updateCorporationRuntime: (corp) => { cleaned.push(corp); return { success: true }; } } };
      const specs = [];
      const bumps = [];
      const pump = createRecyclePump({ store: opened.store, outbox, members, repo: createFreeCorpRepository(), clock,
        nowMs: () => 0, moveFreeCharacter: (spec) => { specs.push(spec); return moveFreeCharacterWith(mods, spec); },
        setCorporationDescription: () => ({ ok: true }), freeCorpRecycleSeams: () => ({ ok: true }),
        getGovernor: () => null, workClass: "MAINTENANCE", isRunning: () => true, bump: (n) => bumps.push(n),
        metric: () => {}, log: () => {}, setTimer: () => ({ cancel() {}, hasRef: () => false }), S,
        retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 }, mode: "LIVE" });
      const enqueue = (corpId) => tx(opened, (db) => outbox.enqueueInTx(db, { key: keyCeoClean(corpId),
        kind: "CEO_CLEAN", payload: { v: 1, characterId: 9951, corpId, fromCorporationId: 98000001 },
        now: clock.now() }));
      const box = (corpId) => H.all(opened, "SELECT state, result_id, last_error FROM world_free_corp_outbox "
        + "WHERE key = ?", keyCeoClean(corpId))[0];
      enqueue(5);
      const r = pump.runNow();
      assert.deepStrictEqual([r.ok, r.outcome, r.call.already, r.call.cleaned], [true, "done", true, true]);
      assert.deepStrictEqual(specs, [{ characterId: 9951, toCorporationId: 98000005, fromHint: 98000001,
        cleanSource: true }]);
      assert.deepStrictEqual([affiliations, cleaned], [[], [98000001]], "no affiliation, the source roster only");
      assert.deepStrictEqual(box(5), { state: "DONE", result_id: 98000005, last_error: null });
      assert.ok(bumps.includes("rcCeoCleanDone"));
      clock.set(clock.now() + S.joinSpacingMs);
      enqueue(6);
      assert.strictEqual(pump.runNow().outcome, "failed");
      assert.strictEqual(specs.length, 1, "no call for a closed target");
      assert.deepStrictEqual([box(6).state, box(6).last_error], ["FAILED", "TARGET_CLOSED"]);
      assert.ok(bumps.includes("rcCeoCleanFailed"));
    });
  });

  needsDriver("RC5 flag off = bit for bit: no member / JOIN / CORP_CLOSE row, no repository call in the pass "
    + "no seam call, the ensure of before; dissolve off-flag without rows; reset policy, migration 79, W29 / W30", () => {
    const real = membersModule.createFreeCorpMembersRepository;
    const calls = [];
    membersModule.createFreeCorpMembersRepository = () => {
      const r = real();
      return Object.fromEntries(Object.entries(r).map(([k, fn]) => [k, (...a) => { calls.push(k); return fn(...a); }]));
    };
    try {
      withStore(driver, (opened) => {
        const env = mergeScene(opened, cfgOf({ recycle: { enabled: false } }), { weakMembers: 5 });
        assert.deepStrictEqual(calls, ["countAnyInTx"], "one COUNT at the start");
        const st = H.pass(env);
        assert.deepStrictEqual(calls, ["countAnyInTx"], "no members call in the pass");
        assert.strictEqual(env.calls.seam, 0);
        assert.strictEqual(memberRows(opened).length, 0);
        assert.strictEqual(outboxRows(opened).length, 0);
        assert.strictEqual(H.all(opened, "SELECT state FROM world_free_corps WHERE corp_id = 1")[0].state, "STRUGGLING");
        assert.deepStrictEqual(env.vc.ensures.map((s) => [s.ownerId, s.members]), [[1, 5]], "the repair of before");
        assert.strictEqual("recycle" in st, false);
        env.fc.stop();
      });
      calls.length = 0;
      withStore(driver, (opened) => {
        const env = mergeScene(opened, cfgOf({ recycle: { enabled: false }, lifecycle: { dissolveEnabled: true } }),
          { struggle: 11 });
        H.pass(env);
        assert.strictEqual(H.all(opened, "SELECT state FROM world_free_corps WHERE corp_id = 1")[0].state, "DISSOLVED");
        assert.strictEqual(memberRows(opened).length, 0);
        assert.strictEqual(outboxRows(opened).length, 0);
        assert.deepStrictEqual(calls, ["countAnyInTx"]);
        env.fc.stop();
      });
    } finally {
      membersModule.createFreeCorpMembersRepository = real;
    }
    assert.strictEqual(TABLE_POLICY.world_free_corp_members, ACTION.KEEP);
    assert.ok(LATEST_SCHEMA_VERSION >= 79, "migration 80 (structures) after 79");
    const warn = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_ENABLED: "1",
      EVEJS_LNE_VIRTUALCORPS_ENABLED: "1", ...env } }).warnings.filter((w) => w.startsWith("freeCorps.recycle.enabled needs")
      || w.startsWith("freeCorps.lifecycle.dissolveEnabled without"));
    assert.strictEqual(warn({}).length, 0, "defaults are quiet");
    assert.strictEqual(warn({ EVEJS_LNE_FREE_CORPS_RECYCLE_ENABLED: "1" }).length, 1, "W29");
    assert.strictEqual(warn({ EVEJS_LNE_FREE_CORPS_LIFECYCLE_DISSOLVE_ENABLED: "1" }).length, 1, "W30");
    assert.strictEqual(warn({ EVEJS_LNE_FREE_CORPS_LIFECYCLE_DISSOLVE_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_RECYCLE_ENABLED: "1", EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1" }).length, 0);
  });
};
