"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const H = require("./hunting.test").harness;
const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const membersModule = require("../../lib/freeCorps/membersRepository");
const { createFreeCorpRepository } = require("../../lib/freeCorps/repository");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const H1 = 30000001;
const HIGH = Object.freeze({ [H1]: { band: "highsec", links: [] } });
const RECHECK = 30000;
const INTERVAL = 60000;
const CEO_COUNTERS = ["ceoReleased", "ceoReleaseWaitContracts", "ceoReleaseWaitVc", "ceoReleaseNoIdentity",
  "ceoReleaseAnomaly", "ceoAdopted", "ceoAdoptFallback", "ceoReturnedRefused", "rcCeoCleanDone", "rcCeoCleanFailed"];

function cfgOf({ ceoReuse = true, recycle = {}, fc = {} } = {}) {
  const base = H.cfgOf({ hunting: { enabled: false } });
  const f = base.freeCorps;
  return { ...base, freeCorps: { ...f, foundingIntervalMs: INTERVAL, foundingRecheckMs: RECHECK, ...fc,
    recycle: { ...f.recycle, enabled: true, ceoReuse, ...recycle } } };
}

function fakeVc() {
  const vc = { owners: new Map(), holder: new Map(), ensures: [], next: 7000001,
    ensureOwnerIdentity(spec) {
      vc.ensures.push(spec);
      if (vc.owners.has(spec.ownerId)) return { ok: true, queued: false };
      let ceo = null;
      if (spec.ceoCharacterId !== undefined && vc.holder.has(spec.ceoCharacterId)) {
        ceo = spec.ceoCharacterId;
        const old = vc.owners.get(vc.holder.get(ceo));
        old.ceo = null;
        old.members = old.members.filter((id) => id !== ceo);
      }
      const adopted = ceo !== null;
      if (ceo === null) ceo = vc.next++;
      const list = [ceo];
      for (let i = 1; i < spec.members; i += 1) list.push(vc.next++);
      for (const id of list) vc.holder.set(id, spec.ownerId);
      vc.owners.set(spec.ownerId, { corporationId: 98000000 + spec.ownerId, ceo, members: list });
      return { ok: true, queued: true, ...(spec.ceoCharacterId !== undefined ? { ceoAdopted: adopted } : {}) };
    },
    getOwnerIdentity: (_kind, id) => {
      const o = vc.owners.get(id);
      if (!o || o.ceo === null) return { ok: true, state: "PENDING" };
      return { ok: true, state: "LINKED", corporationId: o.corporationId, ceoCharacterId: o.ceo,
        characterIds: o.members.slice(), refusedMemberCount: 0 };
    },
    countOwnerCharacters: () => ({ ok: true, ready: true, total: vc.holder.size,
      byKind: { capsuleer: 0, civilian: 0, free: vc.holder.size } }) };
  return vc;
}

const memberRows = (opened) => H.all(opened, "SELECT * FROM world_free_corp_members ORDER BY character_id");
const corpRows = (opened) => H.all(opened, "SELECT corp_id, state, open, ceo_character_id, ceo_source_corporation_id, "
  + "ceo_released, members_target, recruited FROM world_free_corps ORDER BY corp_id");

function dissolve(opened, at) {
  H.exec(opened, "UPDATE world_free_corps SET state = 'DISSOLVED', open = 0, ended_at = ?, end_reason = 'BANKRUPT', "
    + "version = version + 1 WHERE open = 1", at);
}

function cycles(opened, env, n) {
  const totals = [];
  for (let i = 0; i < n; i += 1) {
    const t = H.T0 + i * INTERVAL;
    env.clock.set(t);
    H.pass(env);
    env.clock.set(t + RECHECK);
    H.pass(env);
    dissolve(opened, t + RECHECK);
    env.clock.set(t + RECHECK + 1);
    H.pass(env);
    totals.push(env.fake.countOwnerCharacters().total);
  }
  return totals;
}

function bootCycle(opened, cfg) {
  const fake = fakeVc();
  const env = H.boot(opened, { cfg, spec: HIGH, stationSystems: [H1], extra: { getVirtualCorps: () => fake,
    freeCorpRecycleSeams: () => ({ ok: true }), moveFreeCharacter: () => ({ ok: false, reason: "NOT_IN_TEST" }),
    setCorporationDescription: () => ({ ok: false, reason: "NOT_IN_TEST" }) } });
  env.fake = fake;
  return env;
}

const ONE = Object.freeze({ targetCorps: 1, membersMin: 1, membersMax: 1, bandWeights: "highsec:100" });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CEO1 ceoReuse off =: founding -> dissolve -> founding, no CEO member row, ceo_character_id NULL "
    + "the spec without ceoCharacterId, ceo* counters 0, a new CEO per founding", () => {
    withStore(driver, (opened) => {
      const env = bootCycle(opened, cfgOf({ ceoReuse: false, fc: ONE }));
      const totals = cycles(opened, env, 2);
      env.clock.set(H.T0 + 2 * INTERVAL);
      const st = H.pass(env);
      assert.deepStrictEqual(totals, [1, 2], "one new CEO per founding");
      assert.strictEqual(memberRows(opened).length, 0, "no member row for a CEO");
      const rows = corpRows(opened);
      assert.strictEqual(rows.length, 3);
      assert.ok(rows.every((r) => r.ceo_character_id === null && r.ceo_source_corporation_id === null
        && r.ceo_released === 0), JSON.stringify(rows));
      assert.ok(env.fake.ensures.every((s) => !("ceoCharacterId" in s)), "the spec of before");
      for (const name of CEO_COUNTERS) assert.strictEqual(st.counters[name], 0, name);
      assert.strictEqual("ceoReuse" in st.recycle, false, "no status key with the flag off");
      env.fc.stop();
    });
  });

  needsDriver("CEO2 a DISSOLVED corporation with an open contract keeps its CEO (ceoReleaseWaitContracts) "
    + "the contract closed -> the CEO FREE, ceo_released 1; a replay doubles nothing", () => {
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "miner" });
      H.exec(opened, "UPDATE world_free_corps SET state = 'DISSOLVED', open = 0, ended_at = ?, end_reason = 'BANKRUPT' "
        + "WHERE corp_id = 1", H.T0 - 500);
      H.exec(opened, "INSERT INTO world_free_corp_contracts (contract_key, outbox_key, venture_id, corp_id, kind, goods, "
        + "state, open, type_id, station_id, system_id, issuer_character_id, issuer_corporation_id, lot_isk, "
        + "created_at, updated_at, version) VALUES ('fcc:1:1', 'lne:fc:ct:fcv:1:1', 'fcv:1:1', 1, 'WTS', 'ORE', "
        + "'OPEN', 1, 1230, 60000011, ?, 9801, 98000001, 1000000, ?, ?, 1)", H.L1, H.T0 - 900, H.T0 - 900);
      const env = H.boot(opened, { cfg: cfgOf({ fc: { targetCorps: 0 } }),
        extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
      env.vc.identities.set(1, { ok: true, state: "LINKED", corporationId: 98000001, ceoCharacterId: 9801,
        characterIds: [9801, 9802], refusedMemberCount: 0 });
      let st = H.pass(env);
      assert.strictEqual(memberRows(opened).length, 0, "the CEO waits for the contract");
      assert.strictEqual(st.counters.ceoReleaseWaitContracts, 1);
      assert.strictEqual(corpRows(opened)[0].ceo_released, 0);
      H.exec(opened, "UPDATE world_free_corp_contracts SET open = 0, state = 'CLOSED', ended_at = ?, "
        + "end_reason = 'EXPIRED' WHERE contract_key = 'fcc:1:1'", H.T0);
      env.clock.set(H.T0 + 1);
      st = H.pass(env);
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.origin_corp_id,
        m.vendor_corporation_id]), [[9801, "FREE", null, 1, 98000001]]);
      assert.strictEqual(corpRows(opened)[0].ceo_released, 1);
      assert.strictEqual(st.counters.ceoReleased, 1);
      assert.strictEqual(st.recycle.ceoReuse, true);
      env.clock.set(H.T0 + 2);
      st = H.pass(env);
      assert.strictEqual(memberRows(opened).length, 1, "replay: no second row");
      assert.strictEqual(st.counters.ceoReleased, 1);
      const plan = H.all(opened, "EXPLAIN QUERY PLAN SELECT corp_id, corporation_id, version FROM world_free_corps "
        + "WHERE open = 0 AND ceo_released = 0 AND state IN ('DISSOLVED','MERGED') ORDER BY ended_at, corp_id LIMIT 4")
        .map((r) => r.detail).join(" | ");
      assert.ok(plan.includes("world_free_corps_ceo_release"), plan);
      env.fc.stop();
    });
  });

  needsDriver("CEO3 the oldest of the pool is the CEO: ceo_character_id, the pool row deleted "
    + "pendingMembers = born - 1, spec.ceoCharacterId; REFUSED -> the CEO FREE with its vendor corporation", () => {
    withStore(driver, (opened) => {
      const members = membersModule.createFreeCorpMembersRepository();
      const r = opened.store.transaction("t.ceo", (db) => members.insertInTx(db, { character_id: 9901,
        origin_corp_id: 50, corp_id: null, state: "FREE", vendor_corporation_id: 98000050 }, H.T0 - 1000));
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      const env = H.boot(opened, { cfg: cfgOf({ fc: { targetCorps: 1, membersMin: 3, membersMax: 3,
        bandWeights: "highsec:100" } }), spec: HIGH, stationSystems: [H1],
      extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
      let st = H.pass(env);
      const row = corpRows(opened)[0];
      assert.deepStrictEqual([row.state, row.ceo_character_id, row.ceo_source_corporation_id, row.recruited,
        row.members_target], ["FOUNDING", 9901, 98000050, 0, 3]);
      assert.strictEqual(memberRows(opened).length, 0, "the pool row of the CEO is gone");
      assert.deepStrictEqual(env.vc.ensures.map((s) => [s.ceoCharacterId, s.members]), [[9901, 3]]);
      assert.strictEqual(st.ownerCharacters.used, 2, "the adopted CEO is no new character");
      const stats = opened.store.transaction("t.st", (db) => createFreeCorpRepository().statsInTx(db));
      assert.strictEqual(stats.value.pendingMembers, 2);
      const j = H.all(opened, "SELECT payload FROM world_event_journal WHERE idempotency_key = ?",
        `lne:fc:found:${row.corp_id}`);
      assert.strictEqual(JSON.parse(j[0].payload).ceoCharacterId, 9901);
      env.vc.identities.set(row.corp_id, { ok: true, state: "REFUSED", reason: "NAME_TAKEN" });
      env.clock.set(H.T0 + RECHECK);
      st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].state, "REFUSED");
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.origin_corp_id,
        m.vendor_corporation_id]), [[9901, "FREE", null, row.corp_id, 98000050]]);
      assert.strictEqual(st.counters.ceoReturnedRefused, 1);
      env.fc.stop();
    });
  });

  needsDriver("CEO8 the adoption falls back to a fresh CEO -> X FREE again once (the row lets it go), "
    + "the recheck spec without X, ACTIVATE without CEO_CLEAN", () => {
    withStore(driver, (opened) => {
      const members = membersModule.createFreeCorpMembersRepository();
      const seed = (id) => opened.store.transaction("t.ceo", (db) => members.insertInTx(db, { character_id: id,
        origin_corp_id: 50, corp_id: null, state: "FREE", vendor_corporation_id: 98000050 }, H.T0 - 1000));
      assert.ok(seed(9901).value.ok);
      const env = H.boot(opened, { cfg: cfgOf({ fc: { targetCorps: 1, membersMin: 3, membersMax: 3,
        bandWeights: "highsec:100" } }), spec: HIGH, stationSystems: [H1],
      extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
      env.vc.ensureOwnerIdentity = (spec) => {
        env.vc.ensures.push(spec);
        return { ok: true, queued: true, ...(spec.ceoCharacterId !== undefined ? { ceoAdopted: false } : {}) };
      };
      const pool = () => memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.origin_corp_id,
        m.vendor_corporation_id]);
      let st = H.pass(env);
      const corpId = corpRows(opened)[0].corp_id;
      assert.deepStrictEqual(pool(), [[9901, "FREE", null, corpId, 98000050]], "X back in the pool");
      assert.deepStrictEqual([corpRows(opened)[0].ceo_character_id, corpRows(opened)[0].ceo_source_corporation_id],
        [null, null], "the row lets X go");
      assert.deepStrictEqual([st.counters.ceoAdoptFallback, st.counters.ceoReturnedFallback], [1, 1]);
      env.clock.set(H.T0 + RECHECK);
      st = H.pass(env);
      assert.strictEqual(env.vc.ensures.length, 2);
      assert.strictEqual("ceoCharacterId" in env.vc.ensures[1], false, "the recheck spec without X");
      assert.strictEqual(pool().length, 1, "once");
      env.vc.identities.set(corpId, H.linked(3, 98000000 + corpId));
      env.clock.set(H.T0 + 2 * RECHECK);
      st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].state, "ACTIVE");
      const clean = () => H.all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_outbox WHERE kind = 'CEO_CLEAN'")[0].n;
      assert.strictEqual(clean(), 0, "no CEO_CLEAN for a CEO that is not X");
      assert.deepStrictEqual(pool(), [[9901, "FREE", null, corpId, 98000050]]);
      assert.strictEqual(st.counters.ceoReturnedFallback, 1);
      env.fc.stop();
    });
  });

  needsDriver("CEO9 a vc without ceoAdopted (no return after the ensure), LINKED with another CEO -> "
    + "ACTIVATE returns X in its transaction, no CEO_CLEAN", () => {
    withStore(driver, (opened) => {
      const members = membersModule.createFreeCorpMembersRepository();
      const r = opened.store.transaction("t.ceo", (db) => members.insertInTx(db, { character_id: 9901,
        origin_corp_id: 50, corp_id: null, state: "FREE", vendor_corporation_id: 98000050 }, H.T0 - 1000));
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      const env = H.boot(opened, { cfg: cfgOf({ fc: { targetCorps: 1, membersMin: 3, membersMax: 3,
        bandWeights: "highsec:100" } }), spec: HIGH, stationSystems: [H1],
      extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
      H.pass(env);
      const corpId = corpRows(opened)[0].corp_id;
      assert.strictEqual(memberRows(opened).length, 0, "X taken");
      env.vc.identities.set(corpId, H.linked(3, 98000000 + corpId));
      env.clock.set(H.T0 + RECHECK);
      const st = H.pass(env);
      const row = corpRows(opened)[0];
      assert.deepStrictEqual([row.state, row.ceo_character_id], ["ACTIVE", null]);
      assert.deepStrictEqual(memberRows(opened).map((m) => [m.character_id, m.state, m.origin_corp_id,
        m.vendor_corporation_id]), [[9901, "FREE", corpId, 98000050]]);
      assert.strictEqual(H.all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_outbox WHERE kind = 'CEO_CLEAN'")[0].n,
        0);
      assert.strictEqual(st.counters.ceoReturnedFallback, 1);
      env.fc.stop();
    });
  });

  needsDriver("CEO10 step A: getOwnerIdentity ok:false -> the row waits (ceo_released 0 "
    + "ceoReleaseWaitVc), LINKED later -> released", () => {
    withStore(driver, (opened) => {
      H.seedCorp(opened, { corpId: 1, archetype: "miner" });
      H.exec(opened, "UPDATE world_free_corps SET state = 'DISSOLVED', open = 0, ended_at = ?, end_reason = 'BANKRUPT' "
        + "WHERE corp_id = 1", H.T0 - 500);
      const env = H.boot(opened, { cfg: cfgOf({ fc: { targetCorps: 0 } }),
        extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
      env.vc.identities.set(1, { ok: false, reason: "NOT_STARTED" });
      let st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].ceo_released, 0, "no NONE on a failed read");
      assert.strictEqual(st.counters.ceoReleaseWaitVc, 1);
      assert.strictEqual(st.counters.ceoReleaseNoIdentity, 0);
      env.vc.identities.set(1, { ok: true, state: "LINKED", corporationId: 98000001, ceoCharacterId: 9801,
        characterIds: [9801], refusedMemberCount: 0 });
      env.clock.set(H.T0 + 1);
      st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].ceo_released, 1);
      assert.strictEqual(st.counters.ceoReleased, 1);
      env.fc.stop();
    });
  });

  const STALE = 60000;
  const peekCfg = (fc = {}) => cfgOf({ fc: { targetCorps: 2, maxFoundingOpen: 1, membersMin: 3, membersMax: 3,
    bandWeights: "highsec:100", foundingStaleMs: STALE, ...fc }, recycle: { maxRecruitsPerFounding: 0 } });
  const seedPool = (opened, id) => {
    const members = membersModule.createFreeCorpMembersRepository();
    const r = opened.store.transaction("t.ceo", (db) => members.insertInTx(db, { character_id: id, origin_corp_id: 50,
      corp_id: null, state: "FREE", vendor_corporation_id: 98000050 }, H.T0 - 1000));
    assert.ok(r.ok && r.value.ok, JSON.stringify(r));
  };
  const peekBoot = (opened, cfg, holder) => {
    const env = H.boot(opened, { cfg, spec: HIGH, stationSystems: [H1],
      extra: { freeCorpRecycleSeams: () => ({ ok: true }) } });
    env.vc.ensureOwnerIdentity = (spec) => {
      env.vc.ensures.push(spec);
      if (spec.ceoCharacterId === undefined) return { ok: true, queued: true };
      return holder.peekOk ? { ok: true, queued: true, ceoAdopted: true }
        : { ok: false, reason: "CEO_PEEK_FAILED", detail: "ADAPTER_UNAVAILABLE" };
    };
    return env;
  };
  const poolOf = (opened) => memberRows(opened).map((m) => [m.character_id, m.state, m.corp_id, m.origin_corp_id,
    m.vendor_corporation_id]);

  needsDriver("CEO11 peek always CEO_PEEK_FAILED, maxFoundingOpen 1: after foundingStaleMs "
    + "the FOUNDING returns X once and goes on with a fresh CEO, the founding does not stall", () => {
    withStore(driver, (opened) => {
      seedPool(opened, 9901);
      const env = peekBoot(opened, peekCfg(), { peekOk: false });
      let st = H.pass(env);
      assert.deepStrictEqual(corpRows(opened).map((r) => [r.corp_id, r.state, r.ceo_character_id]),
        [[1, "FOUNDING", 9901]]);
      assert.strictEqual(st.counters.ceoPeekFailed, 1);
      env.clock.set(H.T0 + RECHECK);
      st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].ceo_character_id, 9901, "not stale yet: no fallback");
      env.clock.set(H.T0 + STALE + 1);
      st = H.pass(env);
      assert.strictEqual(st.counters.foundingWaitOpen, 1, "the slot was held in this pass");
      assert.deepStrictEqual(poolOf(opened), [[9901, "FREE", null, 1, 98000050]], "X back in the pool");
      assert.deepStrictEqual([corpRows(opened)[0].ceo_character_id, corpRows(opened)[0].ceo_source_corporation_id],
        [null, null]);
      assert.strictEqual("ceoCharacterId" in env.vc.ensures[env.vc.ensures.length - 1], false, "a fresh CEO");
      assert.deepStrictEqual([st.counters.ceoPeekFallback, st.counters.casConflicts], [1, 0]);
      env.vc.identities.set(1, H.linked(3, 98000001));
      env.clock.set(H.T0 + STALE + 1 + INTERVAL);
      st = H.pass(env);
      const rows = corpRows(opened);
      assert.deepStrictEqual(rows.map((r) => [r.corp_id, r.state]), [[1, "ACTIVE"], [2, "FOUNDING"]],
        "the founding goes on");
      assert.strictEqual(rows[1].ceo_character_id, 9901, "the pause is over: X adopted again");
      assert.deepStrictEqual([st.counters.ceoPeekFallback, st.counters.ceoReturnedFallback, st.counters.casConflicts],
        [1, 0, 0], "once");
      env.fc.stop();
    });
  });

  needsDriver("CEO11b the pause founds without adoption; a restart (empty memory) falls back "
    + "one recheck later, once; a peek that recovers before foundingStaleMs keeps X", () => {
    withStore(driver, (opened) => {
      seedPool(opened, 9901);
      seedPool(opened, 9902);
      const holder = { peekOk: false };
      let env = peekBoot(opened, peekCfg({ maxFoundingOpen: 2 }), holder);
      H.pass(env);
      env.clock.set(H.T0 + RECHECK);
      H.pass(env);
      env.clock.set(H.T0 + INTERVAL);
      H.pass(env);
      const two = corpRows(opened);
      assert.deepStrictEqual(two.map((r) => [r.corp_id, r.ceo_character_id]), [[1, 9901], [2, null]],
        "paused: the second founding adopts nobody");
      assert.ok(env.vc.ensures.filter((s) => s.ownerId === 2).every((s) => !("ceoCharacterId" in s)));
      env.fc.stop();
      env = peekBoot(opened, peekCfg({ maxFoundingOpen: 2 }), holder);
      env.clock.set(H.T0 + INTERVAL + RECHECK);
      let st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].ceo_character_id, 9901, "after the restart the flag is set again first");
      assert.deepStrictEqual([st.counters.ceoPeekFailed, st.counters.ceoPeekFallback], [1, 0]);
      env.clock.set(H.T0 + INTERVAL + 2 * RECHECK);
      st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].ceo_character_id, null);
      assert.strictEqual(poolOf(opened).filter((m) => m[0] === 9901 && m[1] === "FREE").length, 1, "X FREE once");
      env.clock.set(H.T0 + INTERVAL + 3 * RECHECK);
      st = H.pass(env);
      assert.strictEqual(st.counters.ceoPeekFallback, 1, "once");
      env.fc.stop();
    });
    withStore(driver, (opened) => {
      seedPool(opened, 9901);
      const holder = { peekOk: false };
      const env = peekBoot(opened, peekCfg(), holder);
      H.pass(env);
      holder.peekOk = true;
      env.clock.set(H.T0 + RECHECK);
      H.pass(env);
      env.clock.set(H.T0 + 2 * RECHECK + 1);
      const st = H.pass(env);
      assert.strictEqual(corpRows(opened)[0].ceo_character_id, 9901, "recovered: X stays the CEO");
      assert.deepStrictEqual([st.counters.ceoPeekFailed, st.counters.ceoPeekFallback], [1, 0]);
      assert.strictEqual(memberRows(opened).length, 0);
      env.fc.stop();
    });
  });

  needsDriver("CEO5 steady state: 20 cycles founding + dissolve at targetCorps 1 -> the owner characters stay at the "
    + "value of the first cycle (adoption + release), CEO_CLEAN per adopted activation", () => {
    withStore(driver, (opened) => {
      const env = bootCycle(opened, cfgOf({ fc: ONE }));
      const totals = cycles(opened, env, 20);
      const st = env.fc.getStatus();
      assert.ok(totals.every((n) => n <= totals[0]), JSON.stringify(totals));
      assert.strictEqual(totals[0], 1);
      assert.strictEqual(st.counters.ceoAdopted, 19);
      assert.strictEqual(st.counters.ceoReleased, 20);
      assert.strictEqual(st.counters.ceoAdoptFallback, 0);
      const rows = corpRows(opened);
      assert.strictEqual(rows.length, 20);
      assert.ok(rows.slice(1).every((r) => r.ceo_character_id === 7000001), JSON.stringify(rows.slice(0, 3)));
      assert.ok(rows.every((r) => r.ceo_released === 1));
      const clean = H.all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_outbox WHERE kind = 'CEO_CLEAN'")[0].n;
      assert.strictEqual(clean, 19, "one CEO_CLEAN per adopted activation");
      env.fc.stop();
    });
  });

  test("CEO6 vendor facts: createCustomCorporation sets ceoID = characterID and affiliates without a check of "
    + "a former corporation; corporationRuntimeState exports createCorporationWithRuntime", () => {
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    if (!found.ok) return skip("CEO6 vendor facts", found.reason);
    const dir = path.join(found.srcDir, "services", "corporation");
    const state = fs.readFileSync(path.join(dir, "corporationState.js"), "utf8");
    const at = state.indexOf("function createCustomCorporation(characterID, name, options = {})");
    assert.ok(at >= 0, "createCustomCorporation");
    const end = state.indexOf("\nfunction ", at + 10);
    const body = state.slice(at, end > at ? end : undefined);
    assert.ok(body.includes("ceoID: normalizePositiveInteger(characterID, null)"), "ceoID = characterID");
    assert.ok(body.includes("setCharacterAffiliation(characterID, corporationID, null)"), "affiliation");
    assert.ok(!/ceoID\s*===|isCharacterCeo|alreadyCeo/.test(body), "no CEO guard");
    const runtime = fs.readFileSync(path.join(dir, "corporationRuntimeState.js"), "utf8");
    const exportsAt = runtime.lastIndexOf("module.exports");
    assert.ok(exportsAt >= 0 && runtime.slice(exportsAt).includes("createCorporationWithRuntime,"), "export");
    return undefined;
  });

  test("CEO7 config: ceoReuse false / maxCeoReleasesPerPass 4 / ceoReleaseScanRows 32, W37, W38; migration 81",
    () => {
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FREE_CORPS_ENABLED: "1",
      EVEJS_LNE_VIRTUALCORPS_ENABLED: "1", ...env } });
    const d = resolve({});
    assert.deepStrictEqual(d.errors, []);
    const rc = d.config.freeCorps.recycle;
    assert.deepStrictEqual([rc.ceoReuse, rc.maxCeoReleasesPerPass, rc.ceoReleaseScanRows], [false, 4, 32]);
    const w = (env) => resolve(env).warnings.filter((x) => x.startsWith("freeCorps.recycle.ceoReuse"));
    assert.strictEqual(w({}).length, 0, "quiet by default");
    assert.strictEqual(w({ EVEJS_LNE_FREE_CORPS_RECYCLE_CEO_REUSE: "1" }).length, 1, "W37");
    const on = { EVEJS_LNE_FREE_CORPS_RECYCLE_CEO_REUSE: "1", EVEJS_LNE_FREE_CORPS_RECYCLE_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_VENTURES_ENABLED: "1" };
    assert.strictEqual(w(on).length, 0);
    assert.strictEqual(w({ ...on, EVEJS_LNE_FREE_CORPS_RECYCLE_MAX_CEO_RELEASES_PER_PASS: "0" }).length, 1, "W38");
    assert.ok(LATEST_SCHEMA_VERSION >= 81);
  });
};
