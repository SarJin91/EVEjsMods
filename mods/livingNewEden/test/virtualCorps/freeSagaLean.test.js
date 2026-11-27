"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { createVirtualIdentitiesAdapter } = require("../../lib/adapter/virtualIdentities");
const { FREE_SAGA_FLUSH_TABLES } = require("../../lib/virtualCorps/identitySaga");
const virtualCorps = require("../../lib/virtualCorps");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T = "133000000000000000";
const STATION_CORP = 1000123;

function serverSrc() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function loadDriver() {
  const src = serverSrc();
  return src ? resolveSqliteDriver(src) : null;
}

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function fakeVendor() {
  const v = { chars: {}, corps: {}, runtime: {}, calls: [], index: null, nextChar: 90000000, nextCorp: 98000000,
    names: 0 };
  const note = (name, args) => v.calls.push([name, ...args]);
  const evidence = (r) => Number(r && r.careerActivityEvidence && r.careerActivityEvidence.metrics
    && r.careerActivityEvidence.metrics["social:corporation"] && r.careerActivityEvidence.metrics["social:corporation"]
      .value) > 0;
  const indexOf = () => {
    if (v.index === null) {
      const m = new Map();
      for (const [id, r] of Object.entries(v.chars)) {
        const c = Number(r.corporationID) || 0;
        if (!m.has(c)) m.set(c, []);
        m.get(c).push(Number(id));
      }
      v.index = m;
    }
    return v.index;
  };
  const writeRuntime = (corpId, updater) => {
    note("updateCorporationRuntime", [corpId]);
    const base = updater(clone(v.runtime[corpId] || { members: {} }));
    const members = {};
    for (const id of (indexOf().get(corpId) || []).slice().sort((a, b) => a - b)) {
      members[id] = base.members[id] || { characterID: id, roles: "0" };
    }
    v.runtime[corpId] = { ...base, members };
  };
  const affiliate = (charId, corpId, allianceId) => {
    note("setCharacterAffiliation", [charId, corpId, allianceId === undefined ? null : allianceId]);
    const r = v.chars[charId];
    if (!r || !(corpId > 0)) return { success: false, errorMsg: "INVALID_AFFILIATION" };
    let staged = evidence(r);
    const changed = (Number(r.corporationID) || 0) !== corpId;
    const up = { ...r, corporationID: corpId, allianceID: allianceId || 0, allianceMemberStartDate: 0,
      startDateTime: changed ? T : r.startDateTime };
    const history = Array.isArray(r.employmentHistory) ? r.employmentHistory.slice() : [];
    const last = history.length ? history[history.length - 1] : null;
    if (changed && (!last || Number(last.corporationID) !== corpId)) history.push({ corporationID: corpId,
      startDate: T, deleted: 0 });
    up.employmentHistory = history;
    if (changed && (Number(r.corporationID) || 0) > 0 && v.corps[corpId] && v.corps[corpId].isNPC === false) {
      up.careerActivityEvidence = { metrics: { "social:corporation": { value: 1 } } };
      staged = true;
    }
    v.chars[charId] = up;
    if (staged) note("flushTableSync", ["characters"]);
    v.index = null;
    return { success: true, data: { characterID: charId } };
  };
  const characterState = {
    writeCharacterRecord: (id, record) => {
      note("writeCharacterRecord", [id]);
      v.chars[id] = clone(record);
      return { success: true, data: {} };
    },
    peekCharacterRecord: (id) => v.chars[id] || null,
  };
  const memberOf = (corpId, charId) => {
    const rt = v.runtime[corpId];
    return rt && rt.members[charId] ? clone(rt.members[charId]) : null;
  };
  const runtime = {
    createCorporationWithRuntime: (ceoId, options) => {
      note("createCorporationWithRuntime", [ceoId]);
      const found = Object.values(v.corps).find((c) => c.foundingOperationID === options.foundingOperationID);
      const corpId = found ? found.corporationID : (v.nextCorp += 1);
      if (!found) {
        v.corps[corpId] = { corporationID: corpId, corporationName: options.name, tickerName: options.tickerName,
          isNPC: false, ceoID: ceoId, allowWar: 1, foundingOperationID: options.foundingOperationID };
        affiliate(ceoId, corpId, null);
      }
      const again = affiliate(ceoId, corpId, null);
      if (!again.success) return again;
      Object.assign(v.corps[corpId], { description: options.description, stationID: options.stationID });
      writeRuntime(corpId, (rt) => ({ ...rt, applicationsEnabled: 1 }));
      return { success: true, data: { corporationID: corpId, corporationRecord: clone(v.corps[corpId]) } };
    },
    updateCorporationRecord: (id, patch) => {
      note("updateCorporationRecord", [id]);
      if (!v.corps[id]) return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
      Object.assign(v.corps[id], patch);
      return { success: true, data: {} };
    },
    getCorporationMember: memberOf,
    ensureCharacterMemberState: (corpId, charId) => {
      note("ensureCharacterMemberState", [corpId, charId]);
      if (v.failEnsure && v.failEnsure(corpId, charId)) throw new Error(`ensure boom ${charId}`);
      const current = memberOf(corpId, charId);
      if (current) return current;
      writeRuntime(corpId, (rt) => {
        rt.members[charId] = { characterID: charId, roles: "0" };
        return rt;
      });
      return memberOf(corpId, charId);
    },
  };
  const state = {
    setCharacterAffiliation: affiliate,
    getCorporationRecord: (id) => (v.corps[id] ? clone(v.corps[id]) : null),
    findCorporationByFoundingOperationID: (op) => Object.values(v.corps).find((c) => c.foundingOperationID === op)
      || null,
  };
  v.modules = {
    "services/_shared/identityAllocator": { reserveCharacterID: () => (v.nextChar += 1) },
    "services/character/characterState": characterState,
    "services/character/characterNameRuntime": { getValidRandomName: (raceId) => `Pilot ${raceId}-${v.names += 1}` },
    "services/character/characterCreationData": { resolveCharacterCreationBloodlineProfile: () => ({ raceID: 1,
      typeID: 101 }) },
    "services/corporation/corporationRuntimeState": runtime,
    "services/corporation/corporationState": state,
    "gameStore/index": {
      flushTablesSync: (tables) => {
        note("flushTablesSync", [tables]);
        return { success: true, results: [] };
      },
      read: () => ({ success: true, data: v.chars }),
    },
  };
  v.requireGame = (rel) => (v.modules[rel] ? { ok: true, exports: v.modules[rel] }
    : { ok: false, reason: `MISSING ${rel}` });
  return v;
}

function mainAdapter(vendor, log, opts = {}) {
  const ids = createVirtualIdentitiesAdapter({ requireGame: vendor.requireGame });
  const base = {
    reserveCharacterId: ids.reserveCharacterId, writeCharacter: ids.writeCharacter,
    peekCharacterRecord: ids.peekCharacterRecord, pickCharacterName: ids.pickCharacterName,
    ensureCorporation: ids.ensureCorporation, ensureAlliance: ids.ensureAlliance,
    markAllianceNpc: ids.markAllianceNpc, markCorporationNoWar: ids.markCorporationNoWar,
    joinCorporation: ids.joinCorporation, virtualIdentityEnsureMemberStates: ids.ensureMemberStates,
    joinAlliance: ids.joinAlliance, virtualIdentityExists: ids.exists,
    scanVirtualCharacters: ids.scanVirtualCharacters, virtualIdentityFlush: ids.flush,
    resolveCharacterCreationBloodlineProfile: ids.resolveCharacterCreationBloodlineProfile,
    checkCorporationAlliance: ids.checkCorporationAlliance, checkAllianceIsNpc: ids.checkAllianceIsNpc,
  };
  const out = { getProcessRole: () => "world",
    freeSagaLeanSeams: () => opts.seams || { ok: true } };
  for (const [name, fn] of Object.entries(base)) {
    out[name] = (...args) => {
      if (opts.before) opts.before(name, args, log);
      log.push({ name, args: clone(args) });
      return fn(...args);
    };
  }
  return out;
}

function openMemory(driver) {
  const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
    exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
    randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  return opened.store;
}

const OWNER_ID = 7;
const specOf = (ownerKind) => ({ ownerKind, ownerId: OWNER_ID,
  corporation: { name: "Free Seven", ticker: "FRSV", description: "Independent mining corporation" },
  members: 4, stationId: 60000011, stationCorporationId: STATION_CORP, systemId: 30000203,
  constellationId: 20000201, regionId: 10000001, bloodlineIds: [1, 2, 11], securityRating: 2 });

const tick = () => new Promise((resolve) => { setImmediate(resolve); });

async function scenario(driver, opts) {
  const ownerKind = opts.ownerKind || "free";
  const store = openMemory(driver);
  const vendor = fakeVendor();
  if (opts.vendor) opts.vendor(vendor);
  const log = [];
  const counters = new Map();
  const observed = [];
  const logs = [];
  const telemetry = { count: (n, k = 1) => counters.set(n, (counters.get(n) || 0) + k), gauge() {},
    observe: (n) => observed.push(n) };
  const rows = () => store.transaction("fl.rows", (db) => db.prepare("SELECT identity_key, state, evejs_id FROM "
    + "world_virtual_identities ORDER BY identity_key").all()).value;
  try {
    const started = virtualCorps.startVirtualCorps({
      config: { modules: { virtualCorps: { enabled: true } }, virtualCorps: { corpsPerFaction: 2, membersPerCorp: 3,
        maxCharacters: 64, seedOpsPerSlice: 4, freeSaga: { lean: opts.lean === true,
          membersStartInCorp: opts.start === true } } },
      adapter: mainAdapter(vendor, log, opts), persistence: { ok: true, store },
      logger: { log: (m) => logs.push(m) }, fail: () => ({ ok: false }), clock: { now: () => 1000000 }, telemetry,
      strategy: { registry: { isActive: () => false } } });
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    await started.whenReady();
    log.length = 0;
    vendor.calls.length = 0;
    counters.clear();
    observed.length = 0;
    const runs = opts.ensures || 1;
    for (let i = 0; i < runs; i += 1) {
      assert.strictEqual(started.ensureOwnerIdentity(specOf(ownerKind)).ok, true);
      for (let k = 0; k < 400 && !rows().every((r) => r.state === "linked"); k += 1) await tick();
      for (let k = 0; k < 10; k += 1) await tick();
    }
    return { log, vendor, counters, observed, logs, rows: rows() };
  } finally {
    virtualCorps.stopVirtualCorps();
    store.close("FL");
  }
}

const joins = (log) => log.filter((c) => c.name === "joinCorporation");
const flushes = (log) => log.filter((c) => c.name === "virtualIdentityFlush");
const asCapsuleer = (log) => JSON.parse(JSON.stringify(log).replace(/\bi:7:/g, "c:7:"));
const vendorState = (v) => ({ chars: clone(v.chars), runtime: clone(v.runtime), corps: clone(v.corps) });
const count = (v, name) => v.calls.filter((c) => c[0] === name).length;

function bodyOf(source, name) {
  const at = source.indexOf(`\nfunction ${name}(`);
  if (at < 0) return null;
  const next = source.indexOf("\nfunction ", at + 1);
  return source.slice(at, next < 0 ? source.length : next);
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver || !driver.ok) {
    skip("FL1/FL3/FL4 free saga lean", "no sqlite driver");
  } else {
    test("FL1 flags off: the free saga = the capsuleer saga (joinCorporation 4 x with 3 args, flush() without "
      + "argument, members in stationCorporationId); a capsuleer saga with both flags on = off", async () => {
      const free = await scenario(driver, { ownerKind: "free" });
      const caps = await scenario(driver, { ownerKind: "capsuleer" });
      const capsOn = await scenario(driver, { ownerKind: "capsuleer", lean: true, start: true });
      assert.deepStrictEqual(asCapsuleer(free.log), caps.log, "free off = the path");
      assert.deepStrictEqual(capsOn.log, caps.log, "capsuleer: the flags change nothing");
      assert.deepStrictEqual(vendorState(capsOn.vendor), vendorState(caps.vendor));
      assert.strictEqual(joins(free.log).length, 4);
      assert.ok(joins(free.log).every((c) => c.args.length === 3), JSON.stringify(joins(free.log)));
      assert.ok(flushes(free.log).length > 0 && flushes(free.log).every((c) => c.args.length === 1
        && c.args[0] === null), JSON.stringify(flushes(free.log)));
      assert.ok(!free.log.some((c) => c.name === "virtualIdentityEnsureMemberStates"));
      const members = free.log.filter((c) => c.name === "writeCharacter" && !c.args[0].lneIdentityKey.endsWith(":0"));
      assert.strictEqual(members.length, 3);
      assert.ok(members.every((c) => c.args[0].corporationID === STATION_CORP), JSON.stringify(members));
      assert.ok(free.rows.every((r) => r.state === "linked"), JSON.stringify(free.rows));
      assert.strictEqual(free.counters.get("virtualCorps.freeAffiliations"), 4);
      assert.strictEqual(free.counters.get("virtualCorps.freeCeoJoinSkipped"), undefined);
      assert.ok(free.observed.includes("virtualCorps.freeSagaFlushMs"));
      assert.ok(!caps.observed.includes("virtualCorps.freeSagaFlushMs") && !caps.counters.has(
        "virtualCorps.freeAffiliations"));
    });

    test("FL3 lean: CEO without affiliation, members {memberState:false}, ensureMemberStates "
      + "(never empty) right before a flush of 3 tables, all LINKED, vendor state = without the flag; DRIFT -> off",
    async () => {
      const off = await scenario(driver, { ownerKind: "free" });
      const lean = await scenario(driver, { ownerKind: "free", lean: true });
      assert.ok(lean.rows.every((r) => r.state === "linked"), JSON.stringify(lean.rows));
      const ceo = lean.rows.find((r) => r.identity_key === "i:7:corp:0:char:0").evejs_id;
      const j = joins(lean.log);
      assert.deepStrictEqual(j.find((c) => c.args[0] === ceo).args.slice(3), [{ skipWhenAffiliated: true }]);
      const memberJoins = j.filter((c) => c.args[0] !== ceo);
      assert.strictEqual(memberJoins.length, 3);
      assert.ok(memberJoins.every((c) => JSON.stringify(c.args[3]) === JSON.stringify({ memberState: false })));
      assert.strictEqual(lean.counters.get("virtualCorps.freeCeoJoinSkipped"), 1);
      assert.strictEqual(lean.counters.get("virtualCorps.freeAffiliations"), 3);
      assert.strictEqual(lean.counters.get("virtualCorps.freeMemberStatesDeferred"), 3);
      assert.strictEqual(lean.counters.get("virtualCorps.freeMemberStateFailed"), undefined);
      const ceoAffils = (v) => v.calls.filter((c) => c[0] === "setCharacterAffiliation" && c[1] === ceo).length;
      assert.deepStrictEqual([ceoAffils(off.vendor), ceoAffils(lean.vendor)], [3, 2]);
      const ensures = lean.log.map((c, i) => [c, i]).filter(([c]) => c.name === "virtualIdentityEnsureMemberStates");
      assert.ok(ensures.length >= 1);
      const drained = [];
      for (const [c, i] of ensures) {
        assert.ok(c.args[0].length > 0, "never an empty list");
        assert.strictEqual(lean.log[i + 1] && lean.log[i + 1].name, "virtualIdentityFlush", "drain right before");
        drained.push(...c.args[0].map((e) => e.characterId));
      }
      assert.deepStrictEqual(drained.sort(), memberJoins.map((c) => c.args[0]).sort());
      assert.ok(flushes(lean.log).every((c) => JSON.stringify(c.args[0]) === JSON.stringify(FREE_SAGA_FLUSH_TABLES)));
      assert.deepStrictEqual(FREE_SAGA_FLUSH_TABLES, ["characters", "corporations", "corporationRuntime"]);
      assert.deepStrictEqual(vendorState(lean.vendor), vendorState(off.vendor));
      assert.ok(count(lean.vendor, "flushTableSync") < count(off.vendor, "flushTableSync"));
      assert.ok(count(lean.vendor, "updateCorporationRuntime") < count(off.vendor, "updateCorporationRuntime"));
      const drift = await scenario(driver, { ownerKind: "free", lean: true,
        seams: { ok: false, reason: "SEAM_UNAVAILABLE", detail: "DRIFT getCorporationMember" } });
      assert.deepStrictEqual(drift.log, off.log);
      assert.ok(drift.logs.some((l) => l.startsWith("virtualCorps: freeSaga.lean off - SEAM_UNAVAILABLE")),
        drift.logs.join("|"));
    });

    test("FL4 membersStartInCorp: members written in corp 0, the CEO record unchanged, the vendor ends in the "
      + "same affiliations without the member career flushes; a resume from RESERVED writes the same record",
    async () => {
      const off = await scenario(driver, { ownerKind: "free" });
      const start = await scenario(driver, { ownerKind: "free", start: true });
      const corp0 = start.rows.find((r) => r.identity_key === "i:7:corp:0").evejs_id;
      const writes = (s) => s.log.filter((c) => c.name === "writeCharacter");
      const ceoWrite = (s) => writes(s).find((c) => c.args[0].lneIdentityKey.endsWith("char:0"));
      assert.deepStrictEqual(ceoWrite(start), ceoWrite(off), "the CEO record is written before corp 0, unchanged");
      const members = writes(start).filter((c) => c !== ceoWrite(start));
      assert.strictEqual(members.length, 3);
      assert.ok(members.every((c) => c.args[0].corporationID === corp0
        && c.args[0].employmentHistory[0].corporationID === corp0), JSON.stringify(members.map((c) => c.args[0])));
      const pick = (v) => Object.fromEntries(Object.entries(v.chars).map(([id, r]) => [id, [r.corporationID,
        r.allianceID]]));
      assert.deepStrictEqual(pick(start.vendor), pick(off.vendor));
      assert.deepStrictEqual(start.vendor.runtime, off.vendor.runtime);
      assert.deepStrictEqual([count(off.vendor, "flushTableSync"), count(start.vendor, "flushTableSync")], [6, 3]);
      const both = await scenario(driver, { ownerKind: "free", start: true, lean: true });
      assert.strictEqual(count(both.vendor, "flushTableSync"), 2, "lean + start: only the two of the creation");
      let crash = true;
      const resumed = await scenario(driver, { ownerKind: "free", start: true, ensures: 2,
        before: (name, args) => {
          if (crash && name === "writeCharacter" && args[0].lneIdentityKey === "i:7:corp:0:char:1") {
            crash = false;
            throw new Error("crash after RESERVED");
          }
        } });
      assert.strictEqual(crash, false);
      assert.ok(resumed.rows.every((r) => r.state === "linked"), JSON.stringify(resumed.rows));
      const strip = (r) => {
        const rest = { ...r };
        delete rest.characterName;
        return rest;
      };
      const of = (s) => writes(s).filter((c) => c.args[0].lneIdentityKey === "i:7:corp:0:char:1").map((c) =>
        strip(c.args[0]));
      assert.deepStrictEqual(of(resumed).slice(-1), of(start), "the resumed record = the record of a clean saga");
    });

    test("FL6 of the saga review: a throw after a deferred member "
      + "affiliation still drains its member state; a throwing skip-check read = full path + freeCeoJoinReadFallback",
    async () => {
      let memberJoins = 0;
      let crashAt = -1;
      let deferredBefore = [];
      const isDeferredJoin = (name, args) => name === "joinCorporation" && Boolean(args[3])
        && args[3].memberState === false;
      const s = await scenario(driver, { ownerKind: "free", lean: true, ensures: 2,
        before: (name, args, log) => {
          if (!isDeferredJoin(name, args)) return;
          memberJoins += 1;
          if (memberJoins === 2 && crashAt < 0) {
            crashAt = log.length;
            const lastDrain = log.map((c) => c.name).lastIndexOf("virtualIdentityEnsureMemberStates");
            deferredBefore = log.slice(lastDrain + 1).filter((c) => isDeferredJoin(c.name, c.args))
              .map((c) => c.args[0]);
            throw new Error("crash after a deferred affiliation");
          }
        } });
      assert.ok(crashAt >= 0, "the crash ran");
      assert.ok(deferredBefore.length > 0, "a member affiliation waits for its member state at the crash");
      assert.ok(s.rows.every((r) => r.state === "linked"), JSON.stringify(s.rows));
      const next = s.log[crashAt];
      assert.strictEqual(next && next.name, "virtualIdentityEnsureMemberStates", JSON.stringify(next));
      assert.deepStrictEqual(next.args[0].map((e) => e.characterId), deferredBefore);

      let armed = false;
      const fb = await scenario(driver, { ownerKind: "free", lean: true,
        vendor: (v) => {
          const peek = v.modules["services/character/characterState"].peekCharacterRecord;
          v.modules["services/character/characterState"].peekCharacterRecord = (id) => {
            if (armed) {
              armed = false;
              throw new Error("peek boom");
            }
            return peek(id);
          };
        },
        before: (name, args) => {
          if (name === "joinCorporation" && args[3] && args[3].skipWhenAffiliated === true) armed = true;
        } });
      assert.ok(fb.rows.every((r) => r.state === "linked"), JSON.stringify(fb.rows));
      assert.strictEqual(fb.counters.get("virtualCorps.freeCeoJoinReadFallback"), 1);
      assert.strictEqual(fb.counters.get("virtualCorps.freeCeoJoinSkipped"), undefined);
      assert.strictEqual(fb.counters.get("virtualCorps.freeAffiliations"), 4, "the CEO affiliated again");
    });
  }

  test("FL2 adapter on injected modules: skipWhenAffiliated / memberState:false / ensureMemberStates "
    + "no options = affiliation + member state", () => {
    const setup = () => {
      const v = fakeVendor();
      v.chars[11] = { characterId: 11, corporationID: 500, allianceID: 0 };
      v.corps[500] = { corporationID: 500, isNPC: false };
      v.corps[600] = { corporationID: 600, isNPC: false };
      return { v, a: createVirtualIdentitiesAdapter({ requireGame: v.requireGame }) };
    };
    const names = (v) => v.calls.map((c) => c[0]);
    let s = setup();
    s.v.runtime[500] = { members: { 11: { characterID: 11 } } };
    assert.deepStrictEqual(s.a.joinCorporation(11, 500, 0, { skipWhenAffiliated: true }), { ok: true, already: true });
    assert.deepStrictEqual(names(s.v), []);
    s = setup();
    assert.deepStrictEqual(s.a.joinCorporation(11, 500, 0, { skipWhenAffiliated: true }),
      { ok: true, already: true, memberStateEnsured: true });
    assert.deepStrictEqual(names(s.v), ["ensureCharacterMemberState", "updateCorporationRuntime"]);
    s = setup();
    assert.deepStrictEqual(s.a.joinCorporation(11, 600, 0, { skipWhenAffiliated: true }), { ok: true });
    assert.deepStrictEqual(names(s.v).filter((n) => n !== "flushTableSync"), ["setCharacterAffiliation",
      "ensureCharacterMemberState", "updateCorporationRuntime"]);
    s = setup();
    assert.deepStrictEqual(s.a.joinCorporation(11, 500, 77, { skipWhenAffiliated: true }), { ok: true });
    assert.strictEqual(names(s.v)[0], "setCharacterAffiliation");
    s = setup();
    delete s.v.modules["services/corporation/corporationRuntimeState"].getCorporationMember;
    assert.deepStrictEqual(s.a.joinCorporation(11, 500, 0, { skipWhenAffiliated: true }), { ok: true });
    assert.deepStrictEqual(names(s.v).slice(0, 2), ["setCharacterAffiliation", "ensureCharacterMemberState"]);
    s = setup();
    assert.deepStrictEqual(s.a.joinCorporation(11, 600, 0, { memberState: false }),
      { ok: true, memberStateDeferred: true });
    assert.deepStrictEqual(names(s.v).filter((n) => n !== "flushTableSync"), ["setCharacterAffiliation"]);
    s = setup();
    assert.deepStrictEqual(s.a.joinCorporation(11, 500, 0), { ok: true });
    assert.deepStrictEqual(names(s.v).slice(0, 2), ["setCharacterAffiliation", "ensureCharacterMemberState"]);
    s = setup();
    s.v.chars[12] = { characterId: 12, corporationID: 500 };
    s.v.chars[13] = { characterId: 13, corporationID: 500 };
    s.v.failEnsure = (_corp, charId) => charId === 12;
    const r = s.a.ensureMemberStates([{ corporationId: 500, characterId: 11 }, { corporationId: 500, characterId: 12 },
      { corporationId: 500, characterId: 13 }]);
    assert.deepStrictEqual(r, { ok: true, ensured: 2, failed: 1, firstReason: "MEMBER_STATE_FAILED: ensure boom 12" });
    assert.deepStrictEqual(s.a.ensureMemberStates([]), { ok: true, ensured: 0, failed: 0 });
    s = setup();
    s.v.chars[12] = { characterId: 12, corporationID: 500 };
    assert.deepStrictEqual(s.a.ensureMemberStates([{ corporationId: 500, characterId: 11 },
      { corporationId: 500, characterId: 12 }]), { ok: true, ensured: 2, failed: 0 });
    assert.strictEqual(names(s.v).filter((n) => n === "updateCorporationRuntime").length, 1);
  });

  test("FL5 vendor facts (source text) + config: 2 keys default false, W44", () => {
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const d = resolve({});
    assert.deepStrictEqual(d.config.virtualCorps.freeSaga, { lean: false, membersStartInCorp: false });
    const W44 = "virtualCorps.freeSaga.* has no effect without freeCorps.enabled";
    const has = (env) => resolve(env).warnings.filter((w) => w === W44).length;
    assert.strictEqual(has({ EVEJS_LNE_VIRTUAL_CORPS_FREE_SAGA_LEAN: "1" }), 1, "W44 lean");
    assert.strictEqual(has({ EVEJS_LNE_VIRTUAL_CORPS_FREE_SAGA_MEMBERS_START_IN_CORP: "1" }), 1, "W44 start");
    assert.strictEqual(has({ EVEJS_LNE_VIRTUAL_CORPS_FREE_SAGA_LEAN: "1", EVEJS_LNE_FREE_CORPS_ENABLED: "1" }), 0);
    assert.strictEqual(has({}), 0);
    const on = resolve({ EVEJS_LNE_VIRTUAL_CORPS_FREE_SAGA_LEAN: "1",
      EVEJS_LNE_VIRTUAL_CORPS_FREE_SAGA_MEMBERS_START_IN_CORP: "1" });
    assert.deepStrictEqual(on.config.virtualCorps.freeSaga, { lean: true, membersStartInCorp: true });

    const src = serverSrc();
    if (!src) return;
    const read = (rel) => fs.readFileSync(path.join(src, rel), "utf8");
    const runtime = read("services/corporation/corporationRuntimeState.js");
    const create = bodyOf(runtime, "createCorporationWithRuntime");
    assert.ok(create, "createCorporationWithRuntime");
    const iCreate = create.indexOf("createCustomCorporation(");
    const iAffil = create.indexOf("setCharacterAffiliation(", iCreate);
    const iRuntime = create.indexOf("updateCorporationRuntime(", iAffil);
    assert.ok(iCreate > 0 && iAffil > iCreate && iRuntime > iAffil, "create -> affiliation -> runtime write");
    assert.ok(bodyOf(runtime, "normalizeCorporationRuntime").includes("getCharacterIDsInCorporation("));
    const ensure = bodyOf(runtime, "ensureCharacterMemberState");
    assert.ok(/^\s*function ensureCharacterMemberState\([^)]*\) \{\s*const \w+ = getCorporationMember\(/.test(ensure),
      ensure);
    const state = read("services/corporation/corporationState.js");
    const affil = bodyOf(state, "setCharacterAffiliation");
    assert.ok(affil.includes("stagedCareer") && affil.includes("flushTableSync(CHARACTERS_TABLE)"));
    assert.ok(affil.includes("markCorporationMembersIndexDirty()"));
    const custom = bodyOf(state, "createCustomCorporation");
    assert.ok(custom && custom.includes("setCharacterAffiliation("), "createCustomCorporation affiliates the CEO");
    const write = bodyOf(read("services/character/characterState.js"), "writeCharacterRecord");
    assert.ok(write, "writeCharacterRecord");
    assert.ok(!write.includes("markCorporationMembersIndexDirty"), "writeCharacterRecord keeps the members index");
    return undefined;
  });
};
