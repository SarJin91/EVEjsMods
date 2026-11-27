"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { planIdentities } = require("../../lib/virtualCorps/identityPlan");
const strategyData = require("../../lib/strategy/data/virtualCorps");
const virtualCorps = require("../../lib/virtualCorps");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FACTION = 500019;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function fakeAdapter() {
  const characters = {};
  const corporations = {};
  const alliances = {};
  const calls = { ensureAlliance: 0, joinAlliance: [], ensureCorporation: [] };
  let next = 0;
  const out = { calls, corporations, failJoins: false, records: new Set() };
  out.adapter = {
    peekCharacterRecord: (id) => ({ ok: true, record: characters[id] || (out.records.has(id) ? { characterId: id }
      : null) }),
    getProcessRole: () => "world",
    reserveCharacterId: () => {
      const id = 1000000 + (next += 1);
      characters[id] = { characterId: id, corporationID: 0, allianceID: 0 };
      return { ok: true, characterId: id };
    },
    writeCharacter: (record) => {
      characters[record.characterId] = { characterId: record.characterId, corporationID: record.corporationId,
        allianceID: 0, lneIdentityKey: record.lneIdentityKey };
      return { ok: true };
    },
    pickCharacterName: (raceId) => ({ ok: true, name: `Pilot_${raceId}_${next += 1}` }),
    ensureCorporation: (ceoId, spec) => {
      const id = 2000000 + Object.keys(corporations).length;
      calls.ensureCorporation.push({ ceoId, name: spec.name, ticker: spec.tickerName, description: spec.description,
        stationID: spec.stationID });
      corporations[id] = { corporationID: id, name: spec.name, allianceID: 0 };
      return { ok: true, corporationId: id };
    },
    ensureAlliance: (_creatorId, _execCorpId, spec) => {
      calls.ensureAlliance += 1;
      const id = 3000000 + Object.keys(alliances).length;
      alliances[id] = { allianceID: id, name: spec.name, isNPC: true };
      return { ok: true, allianceId: id };
    },
    markAllianceNpc: () => ({ ok: true, changed: false }),
    markCorporationNoWar: () => ({ ok: true, changed: false }),
    joinCorporation: (characterId, corporationId, allianceId) => {
      if (out.failJoins) return { ok: false, reason: "JOIN_FAILED" };
      if (characters[characterId]) Object.assign(characters[characterId], { corporationID: corporationId,
        allianceID: allianceId || 0 });
      return { ok: true };
    },
    joinAlliance: (corporationId, allianceId) => {
      calls.joinAlliance.push(corporationId);
      if (corporations[corporationId]) corporations[corporationId].allianceID = allianceId;
      return { ok: true };
    },
    virtualIdentityExists: (kind, id) => ({ ok: true,
      found: Boolean((kind === "character" ? characters : kind === "corporation" ? corporations : alliances)[id]) }),
    scanVirtualCharacters: () => ({ ok: true,
      characters: Object.values(characters).filter((c) => typeof c.lneIdentityKey === "string") }),
    virtualIdentityFlush: () => ({ ok: true }),
    resolveCharacterCreationBloodlineProfile: () => ({ ok: true, raceId: 1, typeId: 101 }),
    checkCorporationAlliance: (corporationId) => {
      const c = corporations[corporationId];
      return { ok: true, inAlliance: Boolean(c && c.allianceID), allianceId: c ? c.allianceID || 0 : 0 };
    },
    checkAllianceIsNpc: () => ({ ok: true, isNpc: true }),
  };
  return out;
}

function startOn(store, adapter, logs) {
  return virtualCorps.startVirtualCorps({
    config: { modules: { virtualCorps: { enabled: true } },
      virtualCorps: { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64, seedOpsPerSlice: 4 } },
    adapter, persistence: { ok: true, store }, logger: { log: (m) => logs.push(m) }, fail: () => ({ ok: false }),
    clock: { now: () => 1000000 }, telemetry: null, strategy: { registry: { isActive: (id) => id === FACTION } },
  });
}

async function until(fn) {
  for (let i = 0; i < 400; i += 1) {
    if (fn()) return true;
    await new Promise((resolve) => setImmediate(resolve));
  }
  return false;
}

const SPEC = Object.freeze({ ownerKind: "capsuleer", ownerId: 1,
  corporation: Object.freeze({ name: "Iron Wardens", ticker: "IROW", description: "Independent capsuleer corporation" }),
  members: 3, stationId: 60000011, stationCorporationId: 1000123, systemId: 30000203, constellationId: 20000201,
  regionId: 10000001, bloodlineIds: Object.freeze([1, 2, 11]), securityRating: 2 });

const methodsOf = (o) => Object.keys(o).filter((k) => typeof o[k] === "function").sort();

module.exports = ({ test, skip }) => {
  test("C4 ensureOwnerIdentity: c:1 corp + members LINKED without alliance (also after the boot repair) "
    + "faction path unchanged; facade method list equal on the running facade, 4 stubs and createUnavailable",
  async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("C4 owner identity", "no sqlite driver");
    const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
      randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const fake = fakeAdapter();
    const logs = [];
    const rows = () => store.transaction("c4.rows", (db) => db.prepare("SELECT identity_key, kind, owner_kind, "
      + "owner_id, state, evejs_id, name, ticker FROM world_virtual_identities WHERE owner_kind = 'capsuleer' "
      + "ORDER BY identity_key").all()).value;
    try {
      const plan = planIdentities({ isActive: (id) => id === FACTION }, strategyData,
        { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64 });
      const chars = (slot) => [0, 1, 2].map((n) => [`f:${FACTION}:corp:${slot}:char:${n}`, "character", "faction",
        null, null]);
      assert.deepStrictEqual(plan.entries.map((e) => [e.key, e.kind, e.ownerKind, e.name || null, e.ticker || null]), [
        [`f:${FACTION}:alliance`, "alliance", "faction", "Kuvakei Dominion", "KUVAD"],
        [`f:${FACTION}:corp:0`, "corporation", "faction", "True Slaves Vanguard", "TSVG"], ...chars(0),
        [`f:${FACTION}:corp:1`, "corporation", "faction", "Nation Reclamation", "NRCL"], ...chars(1)]);

      const started = startOn(store, fake.adapter, logs);
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      assert.deepStrictEqual(virtualCorps.getOwnerIdentity("capsuleer", 1).state, "PENDING");
      await started.whenReady();
      const faction = virtualCorps.getFactionIdentity(FACTION);
      assert.ok(faction.ok && faction.allianceId > 0 && faction.corporationIds.length === 2
        && faction.characterIds.length === 6, JSON.stringify(faction));
      const alliancesBefore = { ensureAlliance: fake.calls.ensureAlliance, join: fake.calls.joinAlliance.length };

      assert.deepStrictEqual(started.ensureOwnerIdentity(SPEC), { ok: true, queued: true });
      assert.ok(await until(() => virtualCorps.getOwnerIdentity("capsuleer", 1).state === "LINKED"), logs.join("|"));
      const id = virtualCorps.getOwnerIdentity("capsuleer", 1);
      const r = rows();
      assert.deepStrictEqual(r.map((x) => [x.identity_key, x.kind, x.owner_id, x.state]), [
        ["c:1:corp:0", "corporation", 1, "linked"], ["c:1:corp:0:char:0", "character", 1, "linked"],
        ["c:1:corp:0:char:1", "character", 1, "linked"], ["c:1:corp:0:char:2", "character", 1, "linked"]]);
      assert.deepStrictEqual(id, { ok: true, state: "LINKED", corporationId: r[0].evejs_id,
        ceoCharacterId: r[1].evejs_id, characterIds: r.slice(1).map((x) => x.evejs_id),
        memberNames: r.slice(1).map((x) => x.name || null), memberIndexes: [0, 1, 2], name: "Iron Wardens",
        ticker: "IROW", refusedMemberCount: 0 });
      const corpCall = fake.calls.ensureCorporation.find((c) => c.name === "Iron Wardens");
      assert.deepStrictEqual(corpCall, { ceoId: r[1].evejs_id, name: "Iron Wardens", ticker: "IROW",
        description: "Independent capsuleer corporation", stationID: 60000011 });
      assert.strictEqual(virtualCorps.isVirtualCorporation(id.corporationId), true);
      assert.strictEqual(virtualCorps.nameOf(id.corporationId), "Iron Wardens");
      assert.deepStrictEqual(virtualCorps.getFactionIdentity(FACTION), faction, "faction identity unchanged");
      assert.strictEqual(started.ensureOwnerIdentity(SPEC).ok, true);
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(rows(), r);
      assert.ok(!logs.some((l) => l.includes("owner saga")), logs.join("|"));
      fake.failJoins = true;
      assert.strictEqual(started.ensureOwnerIdentity({ ...SPEC, ownerId: 2,
        corporation: { ...SPEC.corporation, name: "Void Reavers", ticker: "VOIR" } }).ok, true);
      assert.ok(await until(() => rows().filter((x) => x.owner_id === 2 && x.kind === "corporation"
        && x.state === "linked").length === 1));
      for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(virtualCorps.getOwnerIdentity("capsuleer", 2), { ok: true, state: "PENDING" });
      fake.failJoins = false;

      virtualCorps.stopVirtualCorps();
      const again = startOn(store, fake.adapter, logs);
      assert.strictEqual(again.ok, true, JSON.stringify(again));
      await again.whenReady();
      assert.ok(!logs.some((l) => l.includes("boot failed")), logs.join("|"));
      assert.ok(!logs.some((l) => l.includes(`corporation ${id.corporationId}`)), logs.join("|"));
      assert.deepStrictEqual({ ensureAlliance: fake.calls.ensureAlliance, join: fake.calls.joinAlliance.length },
        alliancesBefore, `alliance calls ${JSON.stringify(fake.calls.joinAlliance)}`);
      assert.strictEqual(fake.corporations[id.corporationId].allianceID, 0);
      assert.deepStrictEqual(virtualCorps.getOwnerIdentity("capsuleer", 1), id);
      assert.deepStrictEqual(virtualCorps.getFactionIdentity(FACTION), faction);

      const upd = store.transaction("c4.refuse", (db) => db.prepare("UPDATE world_virtual_identities SET state = "
        + "'refused', reason = 'TEST_REFUSED' WHERE identity_key = 'c:1:corp:0:char:2'").run().changes);
      assert.ok(upd.ok && upd.value === 1, JSON.stringify(upd));
      virtualCorps.rebuildMaps();
      assert.deepStrictEqual(virtualCorps.getOwnerIdentity("capsuleer", 1), { ...id,
        characterIds: id.characterIds.filter((x) => x !== r[3].evejs_id),
        memberNames: id.memberNames.filter((_x, i) => id.characterIds[i] !== r[3].evejs_id),
        memberIndexes: [0, 1], refusedMemberCount: 1 });

      const real = methodsOf(again);
      const stubs = {
        disabled: virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: false } } } }),
        gateway: virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: true } } },
          adapter: { getProcessRole: () => "gateway" } }),
        noStore: virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: true } } },
          adapter: { getProcessRole: () => "world" }, persistence: {} }),
        thrown: virtualCorps.startVirtualCorps({}),
        unavailable: virtualCorps.createUnavailableVirtualCorps("X", "y"),
      };
      for (const [name, s] of Object.entries(stubs)) {
        assert.deepStrictEqual(methodsOf(s), real, name);
        assert.strictEqual(s.ensureOwnerIdentity(SPEC).ok, false, name);
        assert.strictEqual(s.getOwnerIdentity("capsuleer", 1).ok, false, name);
        assert.strictEqual(s.listPilotCandidates().ok, false, name);
      }
      assert.ok(real.includes("ensureOwnerIdentity") && real.includes("getOwnerIdentity"), real.join(","));
      assert.ok(real.includes("listPilotCandidates"), real.join(","));
      assert.strictEqual(again.listPilotCandidates().ok, true, "running facade lists the candidates");
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("C4");
    }
  });

  test("VST1 facade.stop during the first seed yield: the saga ends STOPPED, no further vendor writes "
    + "no 'seed complete', ready not resolved; the stop of an old facade leaves a newer start running", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("VST1 virtualCorps stop", "no sqlite driver");
    const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
      randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const fake = fakeAdapter();
    const WRITES = ["reserveCharacterId", "writeCharacter", "ensureCorporation", "ensureAlliance", "joinCorporation",
      "joinAlliance", "markAllianceNpc", "markCorporationNoWar", "virtualIdentityFlush"];
    let writes = 0;
    let flushes = 0;
    const holder = { facade: null, writesAtStop: null };
    for (const name of WRITES) {
      const orig = fake.adapter[name];
      fake.adapter[name] = (...args) => {
        writes += 1;
        if (name === "virtualIdentityFlush" && (flushes += 1) === 1) {
          setImmediate(() => { holder.writesAtStop = writes; holder.facade.stop("SIGTERM"); });
        }
        return orig(...args);
      };
    }
    const logs = [];
    try {
      const started = startOn(store, fake.adapter, logs);
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      holder.facade = started;
      let readySettled = false;
      started.whenReady().then(() => { readySettled = true; });
      assert.ok(await until(() => holder.writesAtStop !== null), "first flush reached");
      for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(writes, holder.writesAtStop, "no vendor write after the stop");
      assert.ok(!logs.some((l) => l.includes("seed complete")), logs.join("|"));
      assert.strictEqual(readySettled, false, "ready not resolved as complete");
      assert.strictEqual(virtualCorps.getFactionIdentity(FACTION).reason, "NOT_STARTED");

      const again = startOn(store, fake.adapter, logs);
      assert.strictEqual(again.ok, true, JSON.stringify(again));
      started.stop("late");
      await again.whenReady();
      assert.ok(logs.some((l) => l.includes("seed complete")), logs.join("|"));
      assert.strictEqual(virtualCorps.getFactionIdentity(FACTION).ok, true);
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("VST1");
    }
  });

  test("FSS1 virtualCorps.freeSagaSliceMs: observed only for the owner kind free (every slice + the last one), "
    + "never for a capsuleer saga", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("FSS1 freeSagaSliceMs", "no sqlite driver");
    const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
      randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const fake = fakeAdapter();
    const logs = [];
    const observed = [];
    const telemetry = { count() {}, gauge() {}, observe: (name, value, at) => observed.push({ name, value, at }) };
    try {
      const started = virtualCorps.startVirtualCorps({
        config: { modules: { virtualCorps: { enabled: true } },
          virtualCorps: { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64, seedOpsPerSlice: 4 } },
        adapter: fake.adapter, persistence: { ok: true, store }, logger: { log: (m) => logs.push(m) },
        fail: () => ({ ok: false }), clock: { now: () => 1000000 }, telemetry,
        strategy: { registry: { isActive: (id) => id === FACTION } } });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      await started.whenReady();
      const slices = () => observed.filter((o) => o.name === "virtualCorps.freeSagaSliceMs");
      assert.strictEqual(started.ensureOwnerIdentity(SPEC).ok, true);
      assert.ok(await until(() => virtualCorps.getOwnerIdentity("capsuleer", 1).state === "LINKED"), logs.join("|"));
      assert.strictEqual(slices().length, 0, "no observation for a capsuleer saga");
      assert.strictEqual(started.ensureOwnerIdentity({ ...SPEC, ownerKind: "free", ownerId: 7,
        corporation: { name: "Free Seven", ticker: "FRSV", description: "Independent mining corporation" } }).ok, true);
      assert.ok(await until(() => virtualCorps.getOwnerIdentity("free", 7).state === "LINKED"), logs.join("|"));
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
      const free = slices();
      assert.ok(free.length >= 2, `slices ${free.length}`);
      assert.ok(free.every((o) => typeof o.value === "number" && o.value >= 0 && o.at === 1000000), JSON.stringify(free));
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("FSS1");
    }
  });

  test("CEO4 ceo-reuse adoptCharacter: the source linked -> released, the target created with evejs_id X, the owner "
    + "count unchanged after LINKED, the saga without reserveCharacterId / writeCharacter for the CEO and "
    + "ensureCorporation(X); a second ensure -> duplicate; no source -> PLANNED + adopted false", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("CEO4 ceo-reuse adoption", "no sqlite driver");
    const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
      exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
      randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const fake = fakeAdapter();
    const writes = { reserveCharacterId: 0, writeCharacter: 0 };
    for (const name of Object.keys(writes)) {
      const orig = fake.adapter[name];
      fake.adapter[name] = (...args) => {
        writes[name] += 1;
        return orig(...args);
      };
    }
    const logs = [];
    const freeSpec = (ownerId, name, ticker, extra = {}) => ({ ...SPEC, ownerKind: "free", ownerId,
      corporation: { name, ticker, description: "Independent mining corporation" }, ...extra });
    const row = (key) => store.transaction("ceo4.row", (db) => db.prepare("SELECT identity_key, state, evejs_id "
      + "FROM world_virtual_identities WHERE identity_key = ?").get(key)).value;
    try {
      const started = startOn(store, fake.adapter, logs);
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      await started.whenReady();
      assert.strictEqual(started.ensureOwnerIdentity(freeSpec(1, "Free One", "FRON", { members: 2 })).ok, true);
      assert.ok(await until(() => virtualCorps.getOwnerIdentity("free", 1).state === "LINKED"), logs.join("|"));
      const x = virtualCorps.getOwnerIdentity("free", 1).ceoCharacterId;
      const total = virtualCorps.countOwnerCharacters().total;
      const before = { ...writes };
      const r = started.ensureOwnerIdentity(freeSpec(2, "Free Two", "FRTW", { members: 1, ceoCharacterId: x }));
      assert.deepStrictEqual(r, { ok: true, queued: true, ceoAdopted: true });
      assert.deepStrictEqual(row("i:1:corp:0:char:0"), { identity_key: "i:1:corp:0:char:0", state: "released",
        evejs_id: x });
      assert.deepStrictEqual(row("i:2:corp:0:char:0"), { identity_key: "i:2:corp:0:char:0", state: "created",
        evejs_id: x });
      assert.ok(await until(() => virtualCorps.getOwnerIdentity("free", 2).state === "LINKED"), logs.join("|"));
      assert.strictEqual(virtualCorps.getOwnerIdentity("free", 2).ceoCharacterId, x);
      assert.strictEqual(virtualCorps.getOwnerIdentity("free", 1).state, "PENDING", "the old owner has no CEO");
      assert.strictEqual(virtualCorps.countOwnerCharacters().total, total, "the character is counted once");
      assert.deepStrictEqual(writes, before, "no reserveCharacterId / writeCharacter for the adopted CEO");
      const corpCall = fake.calls.ensureCorporation.find((c) => c.name === "Free Two");
      assert.strictEqual(corpCall.ceoId, x, "ensureCorporation(X)");
      assert.deepStrictEqual(started.ensureOwnerIdentity(freeSpec(2, "Free Two", "FRTW", { members: 1,
        ceoCharacterId: x })), { ok: true, queued: true, ceoAdopted: true, ceoAdoptDuplicate: true });
      fake.records.add(4242);
      assert.deepStrictEqual(started.ensureOwnerIdentity(freeSpec(3, "Free Three", "FRTH", { members: 1,
        ceoCharacterId: 4242 })), { ok: true, queued: true, ceoAdopted: false });
      assert.ok(await until(() => virtualCorps.getOwnerIdentity("free", 3).state === "LINKED"), logs.join("|"));
      assert.notStrictEqual(virtualCorps.getOwnerIdentity("free", 3).ceoCharacterId, 4242);
      assert.strictEqual(writes.reserveCharacterId, before.reserveCharacterId + 1, "the fallback makes a fresh CEO");
      const peek = fake.adapter.peekCharacterRecord;
      fake.adapter.peekCharacterRecord = () => ({ ok: false, reason: "SEAM_DRIFT" });
      assert.deepStrictEqual(started.ensureOwnerIdentity(freeSpec(5, "Free Five", "FRFI", { members: 1,
        ceoCharacterId: 4242 })), { ok: false, reason: "CEO_PEEK_FAILED", detail: "SEAM_DRIFT" });
      fake.adapter.peekCharacterRecord = () => { throw new Error("boom"); };
      assert.deepStrictEqual(started.ensureOwnerIdentity(freeSpec(5, "Free Five", "FRFI", { members: 1,
        ceoCharacterId: 4242 })), { ok: false, reason: "CEO_PEEK_FAILED", detail: "boom" });
      assert.strictEqual(row("i:5:corp:0:char:0"), undefined, "no CEO row: the founding recheck retries");
      fake.adapter.peekCharacterRecord = peek;
      assert.deepStrictEqual(started.ensureOwnerIdentity(freeSpec(4, "Free Four", "FRFO", { ceoCharacterId: 0 })),
        { ok: false, reason: "INVALID_SPEC", detail: "ceoCharacterId" });
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("CEO4");
    }
    return undefined;
  });
};
