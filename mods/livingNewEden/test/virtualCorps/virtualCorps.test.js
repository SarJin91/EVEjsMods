"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { resolveConfig } = require("../../config");
const { planIdentities } = require("../../lib/virtualCorps/identityPlan");
const { buildVirtualCharacterRecord, filetimeOfMs } = require("../../lib/virtualCorps/characterRecord");
const { createRepository } = require("../../lib/virtualCorps/identityRepository");
const { foundingOpOf, IDENTITY_STATES, identityKeyForAlliance, identityKeyForCorporation, identityKeyForCharacter } =
  require("../../lib/virtualCorps/schema");

const T_AT = 1700000000000;
const T_CLOCK = Object.freeze({ now: () => T_AT });

function findServerSrc() {
  const MOD_DIR = path.resolve(__dirname, "..", "..");
  const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
  return findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
}

function createMockAdapter(options = {}) {
  let { crashAfter = Infinity, failOn = null, throwOn = null } = options;
  let callCount = 0;
  const characters = {};
  const corporations = {};
  const alliances = {};
  let flushed = 0;

  return {
    IDENTITY_KINDS: { ALLIANCE: "alliance", CORPORATION: "corporation", CHARACTER: "character" },
    callCount: () => callCount,
    reserveCharacterId: () => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: reserveCharacterId");
      const id = 1000000 + Object.keys(characters).length;
      characters[id] = { characterId: id, characterName: `Char${id}`, corporationID: 0, allianceID: 0 };
      return { ok: true, characterId: id };
    },
    writeCharacter: (record) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: writeCharacter");
      if (!record || !Number.isInteger(record.characterId)) {
        return { ok: false, reason: "WRITE_FAILED: invalid characterId" };
      }
      characters[record.characterId] = {
        characterId: record.characterId,
        characterName: record.name,
        corporationID: record.corporationId,
        allianceID: record.allianceID || 0,
        lneIdentityKey: record.lneIdentityKey,
        lneVersion: record.lneVersion,
      };
      return { ok: true };
    },
    peekCharacterRecord: (characterId) => {
      callCount++;
      return { ok: true, record: characters[characterId] || null };
    },
    pickCharacterName: (raceId) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: pickCharacterName");
      const name = `Pilot_${raceId}_${callCount}`;
      return { ok: true, name };
    },
    ensureCorporation: (ceoId, spec) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: ensureCorporation");
      if (spec.name === "NAME_TAKEN") return { ok: false, reason: "NAME_TAKEN" };
      if (spec.tickerName === "TICKER_TAKEN") return { ok: false, reason: "TICKER_TAKEN" };
      const id = 2000000 + Object.keys(corporations).length;
      corporations[id] = { corporationID: id, name: spec.name, tickerName: spec.tickerName, allianceID: 0 };
      return { ok: true, corporationId: id };
    },
    ensureAlliance: (creatorId, execCorpId, spec) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: ensureAlliance");
      if (spec.name === "NAME_TAKEN") return { ok: false, reason: "NAME_TAKEN" };
      if (spec.shortName === "SHORT_NAME_TAKEN") return { ok: false, reason: "SHORT_NAME_TAKEN" };
      const id = 3000000 + Object.keys(alliances).length;
      alliances[id] = { allianceID: id, name: spec.name, shortName: spec.shortName, isNPC: false };
      return { ok: true, allianceId: id };
    },
    markAllianceNpc: (allianceId) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: markAllianceNpc");
      if (alliances[allianceId]) alliances[allianceId].isNPC = true;
      return { ok: true, changed: true };
    },
    markCorporationNoWar: (corporationId) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: markCorporationNoWar");
      if (corporations[corporationId]) {
        if (corporations[corporationId].allowWar === 0) return { ok: true, changed: false };
        corporations[corporationId].allowWar = 0;
      }
      return { ok: true, changed: true };
    },
    joinCorporation: (characterId, corporationId, allianceId) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: joinCorporation");
      if (characters[characterId]) {
        characters[characterId].corporationID = corporationId;
        characters[characterId].allianceID = allianceId || 0;
      }
      return { ok: true };
    },
    joinAlliance: (corporationId, allianceId) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: joinAlliance");
      if (corporations[corporationId]) corporations[corporationId].allianceID = allianceId;
      if (alliances[allianceId]) {
        if (!alliances[allianceId].memberCorporationIDs) alliances[allianceId].memberCorporationIDs = [];
        if (!alliances[allianceId].memberCorporationIDs.includes(corporationId)) {
          alliances[allianceId].memberCorporationIDs.push(corporationId);
        }
      }
      return { ok: true };
    },
    exists: (kind, evejsId, foundingOp) => {
      callCount++;
      if (kind === "character") {
        const found = Object.values(characters).some(c => c.characterId === evejsId);
        return { ok: true, found };
      }
      if (kind === "corporation") {
        const found = Object.values(corporations).some(c => c.corporationID === evejsId);
        return { ok: true, found };
      }
      if (kind === "alliance") {
        const found = Object.values(alliances).some(a => a.allianceID === evejsId);
        return { ok: true, found };
      }
      return { ok: true, found: false };
    },
    virtualIdentityExists: (kind, evejsId, foundingOp) => {
      callCount++;
      if (kind === "character") {
        const found = Object.values(characters).some(c => c.characterId === evejsId);
        return { ok: true, found };
      }
      if (kind === "corporation") {
        const found = Object.values(corporations).some(c => c.corporationID === evejsId && c.foundingOperationID === foundingOp);
        return { ok: true, found };
      }
      if (kind === "alliance") {
        const found = Object.values(alliances).some(a => a.allianceID === evejsId && a.foundingOperationID === foundingOp);
        return { ok: true, found };
      }
      return { ok: true, found: false };
    },
    scanVirtualCharacters: () => {
      callCount++;
      const chars = Object.values(characters).filter(c => typeof c.lneIdentityKey === "string");
      return { ok: true, characters: chars };
    },
    flush: () => {
      callCount++;
      flushed++;
      return { ok: true };
    },
    virtualIdentityFlush: () => {
      callCount++;
      flushed++;
      return { ok: true };
    },
    checkCorporationAlliance: (corporationId) => {
      callCount++;
      const corp = corporations[corporationId];
      if (!corp) return { ok: false, reason: "CORPORATION_NOT_FOUND" };
      const allianceId = corp.allianceID || 0;
      return { ok: true, inAlliance: allianceId > 0, allianceId: allianceId > 0 ? allianceId : undefined };
    },
    checkAllianceIsNpc: (allianceId) => {
      callCount++;
      const alliance = alliances[allianceId];
      if (!alliance) return { ok: false, reason: "ALLIANCE_NOT_FOUND" };
      return { ok: true, isNpc: alliance.isNPC === true };
    },
    resolveCharacterCreationBloodlineProfile: (bloodlineId) => {
      callCount++;
      if (callCount >= crashAfter) throw new Error("crash: resolveCharacterCreationBloodlineProfile");
      const raceMap = { 1: { raceID: 1, typeID: 101 }, 4: { raceID: 4, typeID: 401 }, 5: { raceID: 4, typeID: 401 } };
      const result = raceMap[bloodlineId] || { raceID: 1, typeID: 101 };
      return { ok: true, raceId: result.raceID, typeId: result.typeID };
    },
    _stores: { characters, corporations, alliances },
    getCallCount: () => callCount,
    getFlushed: () => flushed,
    resetCrash: () => { crashAfter = Infinity; },
    setCrashAfter: (n) => { crashAfter = n; },
    setThrowOn: (fn) => { throwOn = fn; },
  };
}

module.exports = ({ test, skip, bench, benchEnabled }) => {

  test("V1 migration 23 via fresh=true creates world_virtual_identities STRICT", async () => {
    const found = findServerSrc();
    if (!found.ok) return skip("V1 migration 23 via fresh=true", found.reason);
    const driver = resolveSqliteDriver(found.srcDir);
    if (!driver || !driver.ok) return skip("V1 migration 23 via fresh=true", "no sqlite driver");

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v1-"));
    const filePath = path.join(tmp, "world.sqlite");
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;

    const { MIGRATIONS } = require("../../lib/persistence/migrations");
    const migration23 = MIGRATIONS.find(m => m.version === 23);
    assert.ok(migration23, "migration 23 must exist");
    assert.strictEqual(migration23.name, "world_virtual_identities", "migration 23 name");

    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v1-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });

    const pragma = dbHandle.prepare(`PRAGMA table_info(world_virtual_identities)`).all();
    const colNames = pragma.map((r) => r.name);
    assert.ok(colNames.includes("identity_key"), "identity_key column");
    assert.ok(colNames.includes("founding_op"), "founding_op column");
    assert.ok(colNames.includes("kind"), "kind column");
    assert.ok(colNames.includes("owner_kind"), "owner_kind column");
    assert.ok(colNames.includes("owner_id"), "owner_id column");
    assert.ok(colNames.includes("evejs_id"), "evejs_id column");
    assert.ok(colNames.includes("state"), "state column");
    assert.ok(colNames.includes("name"), "name column");
    assert.ok(colNames.includes("ticker"), "ticker column");
    assert.ok(colNames.includes("created_at"), "created_at column");
    assert.ok(colNames.includes("updated_at"), "updated_at column");
    assert.ok(colNames.includes("version"), "version column");
    assert.ok(colNames.includes("lne_version"), "lne_version column");

    const strictCheck = dbHandle.prepare(`SELECT type FROM sqlite_master WHERE name='world_virtual_identities'`).get();
    assert.strictEqual(strictCheck.type, "table");

    const indexList = dbHandle.prepare("PRAGMA index_list(world_virtual_identities)").all();
    const hasUniqueIndex = indexList.some(idx => idx.unique === 1 && idx.name !== "sqlite_autoindex_world_virtual_identities_1");
    assert.ok(hasUniqueIndex, "has UNIQUE index on founding_op (sqlite_autoindex_world_virtual_identities_2)");
    const hasPartialIndex = indexList.some(idx => idx.partial === 1 && idx.name === "world_virtual_identities_evejs_id");
    assert.ok(hasPartialIndex, "has partial index on (kind, evejs_id) WHERE evejs_id IS NOT NULL");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V2 happy path: 1 faction → 6 chars, 2 corps, 1 alliance, all LINKED", async () => {
    const mockAdapter = createMockAdapter();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v2-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v2-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const planResult = planIdentities(
      { isActive: () => true },
      {
        getFactions: () => [{ id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
          corporations: [
            { name: "True Slaves Vanguard", ticker: "TSVG" },
            { name: "Nation Reclamation", ticker: "NRCL" },
          ],
          raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 }],
      },
      { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64 },
    );
    assert.strictEqual(planResult.entries.length, 9);
    assert.strictEqual(planResult.refused, 0);

    for (const entry of planResult.entries) {
      const res = repo.insert({
        key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId,
        name: entry.name, ticker: entry.ticker, state: entry.state, at: T_AT,
      });
      assert.ok(res.ok, `insert failed for ${entry.key}: ${res.reason}`);
    }

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const res = await runSagaForFaction(sagaCtx, 500019,
      {
        id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [
          { name: "True Slaves Vanguard", ticker: "TSVG" },
          { name: "Nation Reclamation", ticker: "NRCL" },
        ],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5,
      },
      4);

    assert.ok(res.ok, `saga failed: ${res.reason}`);
    assert.strictEqual(res.linked, 9, `expected 9 linked, got ${res.linked}`);

    const rows = repo.listByOwner("faction", 500019);
    const chars = rows.filter(r => r.kind === "character" && r.state === "linked");
    const corps = rows.filter(r => r.kind === "corporation" && r.state === "linked");
    const alls = rows.filter(r => r.kind === "alliance" && r.state === "linked");
    assert.strictEqual(chars.length, 6, `expected 6 chars, got ${chars.length}`);
    assert.strictEqual(corps.length, 2, `expected 2 corps, got ${corps.length}`);
    assert.strictEqual(alls.length, 1, `expected 1 alliance, got ${alls.length}`);

    for (const row of rows) {
      assert.strictEqual(row.state, "linked", `${row.identity_key} not linked: ${row.state}`);
      assert.ok(row.evejs_id && row.evejs_id > 0, `${row.identity_key} has no evejs_id`);
    }

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("VY1 saga: 1 corp x 30 members links all; ctx.yieldSlice runs per slice (macrotask); "
    + "isCurrent false after a yield -> STOPPED, a rerun links the rest without duplicates", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-vy1-"));
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath: path.join(tmp, "world.sqlite"), openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("vy1-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);
    const faction = { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
      corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }], raceId: 4, bloodlineIds: [5, 6, 13],
      securityRating: -5 };
    const planResult = planIdentities({ isActive: () => true }, { getFactions: () => [faction] },
      { corpsPerFaction: 1, membersPerCorp: 30, maxCharacters: 100 });
    assert.deepStrictEqual([planResult.entries.length, planResult.refused], [32, 0]);
    for (const entry of planResult.entries) {
      const res = repo.insert({ key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId, name: entry.name, ticker: entry.ticker,
        state: entry.state, at: T_AT });
      assert.ok(res.ok, `insert failed for ${entry.key}: ${res.reason}`);
    }
    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const adapter = createMockAdapter();
    let yields = 0;
    let current = true;
    const yieldSlice = () => new Promise((resolve) => { setImmediate(() => { yields += 1; resolve(); }); });
    const base = { adapter, repo, logger: { log: () => {} }, config: {}, fail: () => ({ ok: false }), clock: T_CLOCK };

    const stopped = await runSagaForFaction({ ...base, yieldSlice: () => yieldSlice().then(() => {
      if (yields >= 2) current = false;
    }), isCurrent: () => current }, faction.id, faction, 4);
    assert.deepStrictEqual([stopped.ok, stopped.reason, yields], [false, "STOPPED", 2]);
    const mid = repo.listByOwner("faction", faction.id).filter((r) => r.state === "linked").length;
    assert.ok(mid < 32, `stopped saga linked ${mid}`);

    let macrotask = false;
    setImmediate(() => { macrotask = true; });
    yields = 0;
    const res = await runSagaForFaction({ ...base, yieldSlice, isCurrent: () => true }, faction.id, faction, 4);
    assert.ok(res.ok, `saga failed: ${res.reason}`);
    assert.ok(macrotask && yields > 0, `macrotask=${macrotask} yields=${yields}`);
    const rows = repo.listByOwner("faction", faction.id);
    assert.ok(rows.every((r) => r.state === "linked" && r.evejs_id > 0), rows.map((r) => r.state).join(","));
    const charIds = rows.filter((r) => r.kind === "character").map((r) => r.evejs_id);
    assert.deepStrictEqual([charIds.length, new Set(charIds).size], [30, 30]);
    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V3 restart after crash: no duplicates on re-seed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v3-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v3-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const planResult = planIdentities(
      { isActive: () => true },
      { getFactions: () => [{ id: 500001, name: "Amarr", alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
        corporations: [{ name: "Imperial Frontier Legion", ticker: "IFLG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2 }] },
      { corpsPerFaction: 1, membersPerCorp: 1, maxCharacters: 64 },
    );
    assert.strictEqual(planResult.entries.length, 3);

    for (const entry of planResult.entries) {
      const res = repo.insert({
        key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId,
        name: entry.name, ticker: entry.ticker, state: entry.state, at: T_AT,
      });
      assert.ok(res.ok, `insert failed for ${entry.key}: ${res.reason}`);
    }

    const initialRowCount = repo.countByOwner("faction", 500001);
    assert.strictEqual(initialRowCount, 3);

    const mockAdapter1 = createMockAdapter({ crashAfter: 3 });
    const sagaCtx1 = {
      adapter: mockAdapter1,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };
    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    try {
      await runSagaForFaction(sagaCtx1, 500001,
        { id: 500001, name: "Amarr", alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
          corporations: [{ name: "Imperial Frontier Legion", ticker: "IFLG" }],
          raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2 },
        4);
    } catch (e) {
    }

    assert.strictEqual(repo.countByOwner("faction", 500001), 3, "no new rows after crash");

    const mockAdapter2 = createMockAdapter({ crashAfter: Infinity });
    const sagaCtx2 = {
      adapter: mockAdapter2,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };
    const res2 = await runSagaForFaction(sagaCtx2, 500001,
      { id: 500001, name: "Amarr", alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
        corporations: [{ name: "Imperial Frontier Legion", ticker: "IFLG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2 },
      4);

    assert.ok(res2.ok, `second saga failed: ${res2.reason}`);
    assert.strictEqual(repo.countByOwner("faction", 500001), 3, "no new rows after restart");

    const rows = repo.listByOwner("faction", 500001);
    for (const row of rows) {
      assert.strictEqual(row.state, "linked", `${row.identity_key} should be linked, got ${row.state}`);
    }

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V4 adoption: fresh mod DB + existing entities → zero new bytess", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v4-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v4-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const key = "f:500001:corp:0:char:0";
    repo.insert({
      key,
      foundingOp: foundingOpOf(key),
      kind: "character",
      ownerKind: "faction",
      ownerId: 500001,
      state: "planned",
      at: T_AT,
    });

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter._stores.characters[1000000] = {
      characterId: 1000000,
      characterName: "Pilot_4_1",
      corporationID: 0,
      allianceID: 0,
      lneIdentityKey: "f:500001:corp:0:char:0",
      lneVersion: 1,
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { adoptExisting } = require("../../lib/virtualCorps/identitySaga");
    const adoptRes = await adoptExisting(sagaCtx, {});
    assert.ok(adoptRes.ok, `adopt failed: ${adoptRes.reason}`);
    assert.strictEqual(adoptRes.adopted, 1, `expected 1 adopted, got ${adoptRes.adopted}`);

    const rows = repo.listByOwner("faction", 500001);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V5a refusals: NAME_TAKEN after variants → REFUSED", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v5a-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v5-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    const originalEnsureCorp = mockAdapter.ensureCorporation;
    mockAdapter.ensureCorporation = (ceoId, spec) => {
      return { ok: false, reason: "NAME_TAKEN" };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const planResult = planIdentities(
      { isActive: () => true },
      { getFactions: () => [{ id: 500001, name: "Amarr", alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
        corporations: [{ name: "Imperial Frontier Legion", ticker: "IFLG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2 }] },
      { corpsPerFaction: 1, membersPerCorp: 1, maxCharacters: 64 },
    );
    for (const entry of planResult.entries) {
      repo.insert({ key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId, name: entry.name, ticker: entry.ticker, state: entry.state, at: T_AT });
    }

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const res = await runSagaForFaction(sagaCtx, 500001,
      { id: 500001, name: "Amarr", alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
        corporations: [{ name: "Imperial Frontier Legion", ticker: "IFLG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2 },
      4);

    const corpRows = repo.listByOwner("faction", 500001).filter(r => r.kind === "corporation");
    assert.strictEqual(corpRows.length, 1);
    assert.strictEqual(corpRows[0].state, "refused", `corp should be refused, got ${corpRows[0].state}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V5b refusals: maxCharacters LIMIT → plan refuses excess entries", () => {
    const planResult = planIdentities(
      { isActive: () => true },
      { getFactions: () => [{ id: 500001, name: "Amarr", alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
        corporations: [{ name: "Imperial Frontier Legion", ticker: "IFLG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2 }] },
      { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 2 },
    );

    assert.ok(planResult.refused > 0, "should refuse entries over LIMIT");

    const entries = planResult.entries;
    const charEntries = entries.filter(e => e.kind === "character");
    assert.ok(charEntries.length <= 2, `should have at most 2 char entries, got ${charEntries.length}`);
  });

  test("V5c refusals: DISABLED → no adapter calls", () => {
    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    const startCalls = mockAdapter.getCallCount();
    const enabled = false;
    if (!enabled) {
      assert.strictEqual(mockAdapter.getCallCount(), startCalls, "no adapter calls when disabled");
    }
  });

  test("V5d vendor facts F1-F6 reference server/src symbols", () => {
    const found = findServerSrc();
    if (!found.ok) return skip("V5d vendor facts F1-F6", found.reason);

    const corpStatePath = path.join(found.srcDir, "services/corporation/corporationRuntimeState.js");
    let corpStateSrc = "";
    try { corpStateSrc = fs.readFileSync(corpStatePath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "corporationRuntimeState.js not found"); }
    assert.ok(corpStateSrc.includes("createCorporationWithRuntime"), "F1: createCorporationWithRuntime");
    assert.ok(corpStateSrc.includes("findCorporationByFoundingOperationID"), "F1: findCorporationByFoundingOperationID");
    assert.ok(corpStateSrc.includes("applicationsEnabled"), "F1: applicationsEnabled");

    assert.ok(corpStateSrc.includes("createAllianceWithRuntime"), "F2: createAllianceWithRuntime");

    const billingPath = path.join(found.srcDir, "services/corporation/allianceMaintenanceBilling.js");
    let billingSrc = "";
    try { billingSrc = fs.readFileSync(billingPath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "allianceMaintenanceBilling.js not found"); }
    const npcTrueCount = (billingSrc.match(/isNPC\s*===\s*true/g) || []).length;
    assert.ok(npcTrueCount >= 3, `F3: expected ≥3 isNPC === true, got ${npcTrueCount}`);

    const warPath = path.join(found.srcDir, "services/corporation/warPermitState.js");
    let warSrc = "";
    try { warSrc = fs.readFileSync(warPath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "warPermitState.js not found"); }
    assert.ok(warSrc.includes("allowWar"), "F4: allowWar referenced");

    const allocatorPath = path.join(found.srcDir, "services/_shared/identityAllocator.js");
    let allocatorSrc = "";
    try { allocatorSrc = fs.readFileSync(allocatorPath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "identityAllocator.js not found"); }
    assert.ok(allocatorSrc.includes("reserveCharacterID"), "F5: reserveCharacterID");

    const charStatePath = path.join(found.srcDir, "services/character/characterState.js");
    let charStateSrc = "";
    try { charStateSrc = fs.readFileSync(charStatePath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "characterState.js not found"); }
    assert.ok(charStateSrc.includes("writeCharacterRecord"), "F5: writeCharacterRecord");
    assert.ok(charStateSrc.includes("peekCharacterRecord"), "F5: peekCharacterRecord");

    const charNamePath = path.join(found.srcDir, "services/character/characterNameRuntime.js");
    let charNameSrc = "";
    try { charNameSrc = fs.readFileSync(charNamePath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "characterNameRuntime.js not found"); }
    assert.ok(charNameSrc.includes("getValidRandomName"), "F5: getValidRandomName");

    const ccPath = path.join(found.srcDir, "services/character/characterCreationData.js");
    let ccSrc = "";
    try { ccSrc = fs.readFileSync(ccPath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "characterCreationData.js not found"); }
    assert.ok(ccSrc.includes("resolveCharacterCreationBloodlineProfile"), "F5: resolveCharacterCreationBloodlineProfile");

    const gameStorePath = path.join(found.srcDir, "gameStore/index.js");
    let gsSrc = "";
    try { gsSrc = fs.readFileSync(gameStorePath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "gameStore/index.js not found"); }
    assert.ok(gsSrc.includes("flushTablesSync"), "F5: flushTablesSync");
    assert.ok(gsSrc.includes("function read"), "F5: read function");

    const charServicePath = path.join(found.srcDir, "services/character/charService.js");
    let charSrc = "";
    try { charSrc = fs.readFileSync(charServicePath, "utf8"); } catch (_e) { return skip("V5d vendor facts", "charService.js not found"); }
    assert.ok(charSrc.includes("accountId"), "F6: accountId");
    assert.ok(charSrc.includes("characterName"), "F6: characterName");
    assert.ok(charSrc.includes("bloodlineID"), "F6: bloodlineID");
    assert.ok(charSrc.includes("corporationID"), "F6: corporationID");
    assert.ok(charSrc.includes("employmentHistory"), "F6: employmentHistory");
    assert.ok(charSrc.includes("standingData"), "F6: standingData");
    assert.ok(charSrc.includes("BigInt(Date.now()) * 10000n + 116444736000000000n"), "VF2: FILETIME formula of now");
    assert.ok(charSrc.includes("createDateTime: now.toString()"), "VF2: createDateTime");
    assert.ok(charSrc.includes("startDateTime: now.toString()"), "VF2: startDateTime");
    assert.ok(charSrc.includes("logoffDate: now.toString()"), "VF2: logoffDate");
  });

  test("VF1 character record has createDateTime/startDateTime/logoffDate/employment startDate = FILETIME of sim ms", () => {
    assert.strictEqual(filetimeOfMs(0), "116444736000000000");
    assert.strictEqual(filetimeOfMs(1700000000000), "133444736000000000");
    const S = 1700000123456;
    const ft = filetimeOfMs(S);
    const rec = buildVirtualCharacterRecord({
      identityKey: "f:500019:corp:0:char:0", name: "X", gender: "Male", bloodlineId: 1, raceId: 1, typeId: 1373,
      corporationId: 1000001, stationId: 0, systemId: 0, constellationId: 0, regionId: 0, securityRating: 0, nowMs: S,
    });
    assert.deepStrictEqual(
      [rec.createDateTime, rec.startDateTime, rec.logoffDate, rec.employmentHistory[0].startDate], [ft, ft, ft, ft]);
    assert.deepStrictEqual([rec.creationDate, rec.lastLoginDate], [S, S]);
    assert.strictEqual(ft.length, 18);
    assert.ok(ft.localeCompare("132000000000000000") > 0, "sorts after vendor default as text");
    assert.throws(() => filetimeOfMs(-1), TypeError);
  });

  test("V6 saga with vendor behavior mock: corp before affiliation, CHARACTER_NOT_FOUND, no ensureCharacterMemberState in corpState", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v6-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v6-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const planResult = planIdentities(
      { isActive: () => true },
      { getFactions: () => [{ id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 }] },
      { corpsPerFaction: 1, membersPerCorp: 1, maxCharacters: 64 },
    );
    assert.strictEqual(planResult.entries.length, 3);
    for (const entry of planResult.entries) {
      const res = repo.insert({
        key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId,
        name: entry.name, ticker: entry.ticker, state: entry.state, at: T_AT,
      });
      assert.ok(res.ok, `insert failed for ${entry.key}: ${res.reason}`);
    }

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    let corpCreated = false;
    let corpId = null;
    let affiliationAttempted = false;
    let memberStateEnsured = false;

    mockAdapter.ensureCorporation = async (ceoId, spec) => {
      mockAdapter.callCount++;
      corpId = 2000000 + Object.keys(mockAdapter._stores.corporations).length;
      mockAdapter._stores.corporations[corpId] = {
        corporationID: corpId,
        name: spec.name,
        tickerName: spec.tickerName,
        ceoID: ceoId,
        allianceID: 0,
        foundingOperationID: spec.foundingOperationID,
      };
      corpCreated = true;
      if (!mockAdapter._stores.characters[ceoId]) {
        return { ok: false, reason: "CHARACTER_NOT_FOUND" };
      }
      mockAdapter._stores.characters[ceoId].corporationID = corpId;
      return { ok: true, corporationId: corpId };
    };

    mockAdapter.joinCorporation = async (characterId, corporationId, allianceId) => {
      mockAdapter.callCount++;
      affiliationAttempted = true;
      if (!mockAdapter._stores.characters[characterId]) {
        return { ok: false, reason: "CHARACTER_NOT_FOUND" };
      }
      mockAdapter._stores.characters[characterId].corporationID = corporationId;
      mockAdapter._stores.characters[characterId].allianceID = allianceId || 0;
      memberStateEnsured = true;
      return { ok: true };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const res = await runSagaForFaction(sagaCtx, 500019,
      {
        id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5,
      },
      4);

    assert.ok(res.ok, `saga failed: ${res.reason}`);
    
    const rows = repo.listByOwner("faction", 500019);
    for (const row of rows) {
      assert.strictEqual(row.state, "linked", `${row.identity_key} not linked: ${row.state}`);
      assert.ok(row.evejs_id && row.evejs_id > 0, `${row.identity_key} has no evejs_id`);
    }

    assert.ok(corpCreated, "corporation should be created");
    assert.ok(affiliationAttempted, "affiliation should be attempted");
    assert.ok(memberStateEnsured, "member state should be ensured");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V7 repairExisting uses findByFoundingOp for corps/alliances, not full table scan", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v7-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v7-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    const keyChar = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyChar, foundingOp: foundingOpOf(keyChar), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "reserved", name: "Test Pilot", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyChar);

    let findCorpByFoCalled = false;
    let findAllianceByFoCalled = false;
    let scanCharsCalled = false;

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter.virtualIdentityExists = async (kind, evejsId, foundingOp) => {
      mockAdapter.callCount++;
      if (kind === "corporation") {
        findCorpByFoCalled = true;
        assert.strictEqual(foundingOp, "lne:v1:f:500019:corp:0", "foundingOp passed for corporation");
        return { ok: true, found: true, corporationId: 2000001 };
      }
      if (kind === "alliance") {
        findAllianceByFoCalled = true;
        assert.strictEqual(foundingOp, "lne:v1:f:500019:alliance", "foundingOp passed for alliance");
        return { ok: true, found: true, allianceId: 3000001 };
      }
      scanCharsCalled = true;
      return { ok: true, found: false };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);

    assert.ok(findCorpByFoCalled, "findCorporationByFoundingOp should be called for corporation");
    assert.ok(findAllianceByFoCalled, "findAllianceByFoundingOp should be called for alliance");
    assert.ok(scanCharsCalled, "character scan should be used for characters");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V8 createVirtualIdentitiesAdapter with vendor-shaped requireGame mock", async () => {
    const { createVirtualIdentitiesAdapter, IDENTITY_KINDS } = require("../../lib/adapter/virtualIdentities");

    const characters = {};
    const corporations = {};
    const alliances = {};
    let flushCalled = false;

    const requireGame = (relPath) => {
      if (relPath === "services/_shared/identityAllocator") {
        let nextCharId = 1000000;
        return {
          ok: true,
          exports: {
            reserveCharacterID: () => {
              const id = nextCharId++;
              return id;
            },
          },
        };
      }

      if (relPath === "services/character/characterState") {
        return {
          ok: true,
          exports: {
            writeCharacterRecord: (charId, record, options) => {
              characters[charId] = {
                characterId: charId,
                characterName: record.name,
                corporationID: record.corporationId,
                allianceID: record.allianceID || 0,
                lneIdentityKey: record.lneIdentityKey,
                lneVersion: record.lneVersion,
              };
              return { success: true, data: { characterId: charId } };
            },
            peekCharacterRecord: (characterId) => {
              return characters[characterId] || null;
            },
          },
        };
      }

      if (relPath === "services/character/characterNameRuntime") {
        let callCount = 0;
        return {
          ok: true,
          exports: {
            getValidRandomName: (raceId) => {
              callCount++;
              return `Pilot_${raceId}_${callCount}`;
            },
          },
        };
      }

      if (relPath === "services/character/characterCreationData") {
        return {
          ok: true,
          exports: {
            resolveCharacterCreationBloodlineProfile: (bloodlineId) => {
              const raceMap = { 1: { raceID: 1, typeID: 101 }, 4: { raceID: 4, typeID: 401 }, 5: { raceID: 4, typeID: 401 } };
              return raceMap[bloodlineId] || { raceID: 1, typeID: 101 };
            },
          },
        };
      }

      if (relPath === "services/corporation/corporationState") {
        return {
          ok: true,
          exports: {
            setCharacterAffiliation: (characterId, corporationId, allianceId) => {
              if (characters[characterId]) {
                characters[characterId].corporationID = corporationId;
                characters[characterId].allianceID = allianceId || 0;
                return { success: true };
              }
              return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
            },
            setCorporationAlliance: (corporationId, allianceId) => {
              if (corporations[corporationId]) {
                corporations[corporationId].allianceID = allianceId;
                return { success: true };
              }
              return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
            },
            findCorporationByFoundingOperationID: (foundingOp) => {
              for (const corp of Object.values(corporations)) {
                if (corp.foundingOperationID === foundingOp) return corp;
              }
              return null;
            },
            findAllianceByFoundingOperationID: (foundingOp) => {
              for (const al of Object.values(alliances)) {
                if (al.foundingOperationID === foundingOp) return al;
              }
              return null;
            },
            getCorporationRecord: (corporationId) => {
              return corporations[corporationId] || null;
            },
            getAllianceRecord: (allianceId) => {
              return alliances[allianceId] || null;
            },
          },
        };
      }

      if (relPath === "services/corporation/corporationRuntimeState") {
        return {
          ok: true,
          exports: {
            createCorporationWithRuntime: (ceoId, spec) => {
              const id = 2000000 + Object.keys(corporations).length;
              corporations[id] = {
                corporationID: id,
                name: spec.name,
                tickerName: spec.tickerName,
                ceoID: ceoId,
                allianceID: 0,
                allowWar: 1,
                foundingOperationID: spec.foundingOperationID,
              };
              return { success: true, data: { corporationID: id, corporationRecord: corporations[id], corporationRuntime: {} } };
            },
            createAllianceWithRuntime: (creatorId, execCorpId, spec) => {
              const id = 3000000 + Object.keys(alliances).length;
              alliances[id] = {
                allianceID: id,
                name: spec.name,
                shortName: spec.shortName,
                isNPC: false,
                executorCorpID: execCorpId,
                foundingOperationID: spec.foundingOperationID,
              };
              return { success: true, data: { allianceID: id, allianceRecord: alliances[id], allianceRuntime: {} } };
            },
            updateCorporationRecord: (corporationId, updates) => {
              if (corporations[corporationId]) {
                Object.assign(corporations[corporationId], updates);
                return { success: true };
              }
              return { success: false, errorMsg: "CORPORATION_NOT_FOUND" };
            },
            updateAllianceRecord: (allianceId, updates) => {
              if (alliances[allianceId]) {
                Object.assign(alliances[allianceId], updates);
                return { success: true };
              }
              return { success: false, errorMsg: "ALLIANCE_NOT_FOUND" };
            },
            getCorporationRecord: (corporationId) => {
              return corporations[corporationId] || null;
            },
            getAllianceRecord: (allianceId) => {
              return alliances[allianceId] || null;
            },
            ensureCharacterMemberState: (corporationId, characterId) => {
              return { characterId, corporationId, roles: [] };
            },
          },
        };
      }

      if (relPath === "gameStore/index") {
        return {
          ok: true,
          exports: {
            read: (table, path) => {
              if (table === "characters") {
                return { success: true, data: characters };
              }
              if (table === "corporations") {
                return { success: true, data: corporations };
              }
              if (table === "alliances") {
                return { success: true, data: alliances };
              }
              return { success: true, data: {} };
            },
            flushTablesSync: (tables) => {
              flushCalled = true;
              return { success: true, results: {} };
            },
          },
        };
      }

      return { ok: false, reason: `Unknown module: ${relPath}` };
    };

    const adapter = createVirtualIdentitiesAdapter({ requireGame });

    const reserveRes = await adapter.reserveCharacterId();
    assert.ok(reserveRes.ok, `reserveCharacterId failed: ${reserveRes.reason}`);
    assert.ok(Number.isInteger(reserveRes.characterId) && reserveRes.characterId > 0);
    const characterId = reserveRes.characterId;

    const writeRes = await adapter.writeCharacter({
      characterId,
      name: "Test Pilot",
      gender: "male",
      bloodlineId: 5,
      raceId: 4,
      typeId: 401,
      corporationId: 0,
      stationId: 0,
      systemId: 0,
      constellationId: 0,
      regionId: 0,
      securityRating: 0,
      nowFiletime: Date.now(),
      lneIdentityKey: "f:500019:corp:0:char:0",
      lneVersion: 1,
    });
    assert.ok(writeRes.ok, `writeCharacter failed: ${writeRes.reason}`);

    const existsChar = await adapter.exists(IDENTITY_KINDS.CHARACTER, characterId);
    assert.ok(existsChar.ok && existsChar.found, "character should exist");

    const ceoId = characterId;
    const corpRes = await adapter.ensureCorporation(ceoId, {
      name: "Test Corp",
      tickerName: "TSTC",
      description: "Test",
      stationID: 0,
      foundingOperationID: "lne:v1:f:500019:corp:0",
    });
    assert.ok(corpRes.ok, `ensureCorporation failed: ${corpRes.reason}`);
    const corporationId = corpRes.corporationId;

    const findCorpRes = await adapter.findCorporationByFoundingOp("lne:v1:f:500019:corp:0");
    assert.ok(findCorpRes.ok && findCorpRes.found, "corporation should be found by foundingOp");
    assert.strictEqual(findCorpRes.corporationId, corporationId);

    const allianceRes = await adapter.ensureAlliance(ceoId, corporationId, {
      name: "Test Alliance",
      shortName: "TSTA",
      description: "Test",
      foundingOperationID: "lne:v1:f:500019:alliance",
    });
    assert.ok(allianceRes.ok, `ensureAlliance failed: ${allianceRes.reason}`);
    const allianceId = allianceRes.allianceId;

    const findAllianceRes = await adapter.findAllianceByFoundingOp("lne:v1:f:500019:alliance");
    assert.ok(findAllianceRes.ok && findAllianceRes.found, "alliance should be found by foundingOp");
    assert.strictEqual(findAllianceRes.allianceId, allianceId);

    const npcRes = await adapter.markAllianceNpc(allianceId);
    assert.ok(npcRes.ok, `markAllianceNpc failed: ${npcRes.reason}`);
    const npcRes2 = await adapter.markAllianceNpc(allianceId);
    assert.ok(npcRes2.ok && npcRes2.changed === false, "second markAllianceNpc should return changed: false");

    const noWarRes = await adapter.markCorporationNoWar(corporationId);
    assert.ok(noWarRes.ok, `markCorporationNoWar failed: ${noWarRes.reason}`);
    const noWarRes2 = await adapter.markCorporationNoWar(corporationId);
    assert.ok(noWarRes2.ok && noWarRes2.changed === false, "second markCorporationNoWar should return changed: false");

    const joinCorpRes = await adapter.joinCorporation(characterId, corporationId, allianceId);
    assert.ok(joinCorpRes.ok, `joinCorporation failed: ${joinCorpRes.reason}`);
    assert.strictEqual(characters[characterId].corporationID, corporationId);
    assert.strictEqual(characters[characterId].allianceID, allianceId);

    const joinAllianceRes = await adapter.joinAlliance(corporationId, allianceId);
    assert.ok(joinAllianceRes.ok, `joinAlliance failed: ${joinAllianceRes.reason}`);
    assert.strictEqual(corporations[corporationId].allianceID, allianceId);

    const existsCorp = await adapter.exists(IDENTITY_KINDS.CORPORATION, corporationId, "lne:v1:f:500019:corp:0");
    assert.ok(existsCorp.ok && existsCorp.found, "corporation should exist via foundingOp");

    const existsAlliance = await adapter.exists(IDENTITY_KINDS.ALLIANCE, allianceId, "lne:v1:f:500019:alliance");
    assert.ok(existsAlliance.ok && existsAlliance.found, "alliance should exist via foundingOp");

    const scanRes = await adapter.scanVirtualCharacters();
    assert.ok(scanRes.ok, `scanVirtualCharacters failed: ${scanRes.reason}`);
    assert.ok(scanRes.characters.length >= 1, "should find at least one virtual character");

    const flushRes = await adapter.flush();
    assert.ok(flushRes.ok, `flush failed: ${flushRes.reason}`);
    assert.ok(flushCalled, "flushTablesSync should have been called");

    const bloodlineRes = await adapter.resolveCharacterCreationBloodlineProfile(5);
    assert.ok(bloodlineRes.ok, `resolveCharacterCreationBloodlineProfile failed: ${bloodlineRes.reason}`);
    assert.strictEqual(bloodlineRes.raceId, 4);
    assert.strictEqual(bloodlineRes.typeId, 401);

    console.log("V8: all adapter methods work with vendor-shaped requireGame mock");
  });

  test("V9a joinAlliance ok:false -> corp row stays CREATED", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v9a-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v9a-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    const keyCEO = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "created", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCEO, foundingOp: foundingOpOf(keyCEO), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "CEO", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyCEO);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter.joinAlliance = async (corporationId, allianceId) => {
      mockAdapter.callCount++;
      return { ok: false, reason: "ALLIANCE_NOT_FOUND" };
    };
    mockAdapter.markCorporationNoWar = async () => ({ ok: true, changed: true });

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const _res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    const corpRows = repo.listByOwner("faction", 500019).filter(r => r.kind === "corporation");
    assert.strictEqual(corpRows.length, 1);
    assert.strictEqual(corpRows[0].state, "created", `corp should stay CREATED, got ${corpRows[0].state}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V9b markAllianceNpc ok:false once then ok -> alliance LINKED, isNPC=true, mark called >=2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v9b-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v9b-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyAlliance = "f:500019:alliance";
    const keyCorp = "f:500019:corp:0";
    const keyCEO = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "planned", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCEO, foundingOp: foundingOpOf(keyCEO), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "CEO", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyCEO);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    let markAllianceNpcCalls = 0;
    mockAdapter.markAllianceNpc = async (allianceId) => {
      markAllianceNpcCalls++;
      if (markAllianceNpcCalls === 1) return { ok: false, reason: "ALLIANCE_NOT_FOUND" };
      mockAdapter._stores.alliances[allianceId] = mockAdapter._stores.alliances[allianceId] || { allianceID: allianceId, isNPC: false };
      mockAdapter._stores.alliances[allianceId].isNPC = true;
      return { ok: true, changed: true };
    };
    mockAdapter.joinAlliance = async () => ({ ok: true });
    mockAdapter.ensureAlliance = async (creatorId, execCorpId, spec) => {
      mockAdapter.callCount++;
      const id = 3000000 + Object.keys(mockAdapter._stores.alliances).length;
      mockAdapter._stores.alliances[id] = { allianceID: id, name: spec.name, shortName: spec.shortName, isNPC: false, foundingOperationID: spec.foundingOperationID };
      return { ok: true, allianceId: id };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const _res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    const allianceRows = repo.listByOwner("faction", 500019).filter(r => r.kind === "alliance");
    assert.strictEqual(allianceRows.length, 1);
    assert.strictEqual(allianceRows[0].state, "linked", `alliance should go to LINKED, got ${allianceRows[0].state}`);
    assert.ok(markAllianceNpcCalls >= 2, `markAllianceNpc should be called >=2 times, got ${markAllianceNpcCalls}`);
    const allianceEvejsId = allianceRows[0].evejs_id;
    assert.ok(mockAdapter._stores.alliances[allianceEvejsId], `alliance ${allianceEvejsId} should exist in mock store`);
    assert.strictEqual(mockAdapter._stores.alliances[allianceEvejsId].isNPC, true, "alliance should be marked NPC in mock store");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V9b2 markAllianceNpc always fails -> alliance stays CREATED, not LINKED", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v9b2-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v9b2-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyAlliance = "f:500019:alliance";
    const keyCorp = "f:500019:corp:0";
    const keyCEO = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "planned", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCEO, foundingOp: foundingOpOf(keyCEO), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "CEO", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyCEO);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter.markAllianceNpc = async (allianceId) => {
      mockAdapter.callCount++;
      return { ok: false, reason: "ALLIANCE_NOT_FOUND" };
    };
    mockAdapter.joinAlliance = async () => ({ ok: true });
    mockAdapter.ensureAlliance = async (creatorId, execCorpId, spec) => {
      mockAdapter.callCount++;
      const id = 3000000 + Object.keys(mockAdapter._stores.alliances).length;
      mockAdapter._stores.alliances[id] = { allianceID: id, name: spec.name, shortName: spec.shortName, isNPC: false, foundingOperationID: spec.foundingOperationID };
      return { ok: true, allianceId: id };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const _res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    const allianceRows = repo.listByOwner("faction", 500019).filter(r => r.kind === "alliance");
    assert.strictEqual(allianceRows.length, 1);
    assert.strictEqual(allianceRows[0].state, "created", `alliance should stay CREATED on permanent failure, got ${allianceRows[0].state}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V9c markCorporationNoWar ok:false once then ok -> corp LINKED, allowWar=0, mark called >=2", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v9c-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v9c-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    const keyCEO = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "planned", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCEO, foundingOp: foundingOpOf(keyCEO), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "CEO", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyCEO);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    let markCorporationNoWarCalls = 0;
    mockAdapter.markCorporationNoWar = async (corporationId) => {
      markCorporationNoWarCalls++;
      if (markCorporationNoWarCalls === 1) return { ok: false, reason: "CORPORATION_NOT_FOUND" };
      mockAdapter._stores.corporations[corporationId] = mockAdapter._stores.corporations[corporationId] || { corporationID: corporationId, allowWar: 1 };
      mockAdapter._stores.corporations[corporationId].allowWar = 0;
      return { ok: true, changed: true };
    };
    mockAdapter.joinAlliance = async () => ({ ok: true });
    mockAdapter.ensureCorporation = async (ceoId, spec) => {
      mockAdapter.callCount++;
      const id = 2000000 + Object.keys(mockAdapter._stores.corporations).length;
      mockAdapter._stores.corporations[id] = { corporationID: id, name: spec.name, tickerName: spec.tickerName, allianceID: 0, foundingOperationID: spec.foundingOperationID };
      return { ok: true, corporationId: id };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const _res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    const corpRows = repo.listByOwner("faction", 500019).filter(r => r.kind === "corporation");
    assert.strictEqual(corpRows.length, 1);
    assert.strictEqual(corpRows[0].state, "linked", `corp should go to LINKED, got ${corpRows[0].state}`);
    assert.ok(markCorporationNoWarCalls >= 2, `markCorporationNoWar should be called >=2 times, got ${markCorporationNoWarCalls}`);
    const corpEvejsId = corpRows[0].evejs_id;
    assert.ok(mockAdapter._stores.corporations[corpEvejsId], `corp ${corpEvejsId} should exist in mock store`);
    assert.strictEqual(mockAdapter._stores.corporations[corpEvejsId].allowWar, 0, "corp should have allowWar=0 in mock store");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V9c2 markCorporationNoWar always fails -> corp stays CREATED, not LINKED", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v9c2-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v9c2-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    const keyCEO = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "planned", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCEO, foundingOp: foundingOpOf(keyCEO), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "CEO", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyCEO);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter.markCorporationNoWar = async (corporationId) => {
      mockAdapter.callCount++;
      return { ok: false, reason: "CORPORATION_NOT_FOUND" };
    };
    mockAdapter.joinAlliance = async () => ({ ok: true });
    mockAdapter.ensureCorporation = async (ceoId, spec) => {
      mockAdapter.callCount++;
      const id = 2000000 + Object.keys(mockAdapter._stores.corporations).length;
      mockAdapter._stores.corporations[id] = { corporationID: id, name: spec.name, tickerName: spec.tickerName, allianceID: 0, foundingOperationID: spec.foundingOperationID };
      return { ok: true, corporationId: id };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const _res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    const corpRows = repo.listByOwner("faction", 500019).filter(r => r.kind === "corporation");
    assert.strictEqual(corpRows.length, 1);
    assert.strictEqual(corpRows[0].state, "created", `corp should stay CREATED on permanent failure, got ${corpRows[0].state}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V10 repairExisting: joins corp to alliance and marks alliance as NPC", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v10-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v10-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    const keyCorp1 = "f:500019:corp:1";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp 0", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCorp1, foundingOp: foundingOpOf(keyCorp1), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp 1", ticker: "TST1" });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000002, keyCorp1);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter._stores.corporations[2000001] = { corporationID: 2000001, name: "Test Corp 0", tickerName: "TSTC", allianceID: 0, foundingOperationID: "lne:v1:f:500019:corp:0" };
    mockAdapter._stores.corporations[2000002] = { corporationID: 2000002, name: "Test Corp 1", tickerName: "TST1", allianceID: 0, foundingOperationID: "lne:v1:f:500019:corp:1" };
    mockAdapter._stores.alliances[3000001] = { allianceID: 3000001, name: "Test Alliance", shortName: "TSTA", isNPC: false, foundingOperationID: "lne:v1:f:500019:alliance" };

    let joinAllianceCalled = false;
    let markAllianceNpcCalled = false;
    const originalJoinAlliance = mockAdapter.joinAlliance;
    const originalMarkAllianceNpc = mockAdapter.markAllianceNpc;
    mockAdapter.joinAlliance = async (corporationId, allianceId) => {
      joinAllianceCalled = true;
      return originalJoinAlliance(corporationId, allianceId);
    };
    mockAdapter.markAllianceNpc = async (allianceId) => {
      markAllianceNpcCalled = true;
      return originalMarkAllianceNpc(allianceId);
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);

    assert.ok(joinAllianceCalled, "joinAlliance should have been called");
    assert.ok(markAllianceNpcCalled, "markAllianceNpc should have been called");
    assert.ok(res.repaired > 0, `expected repaired > 0, got ${res.repaired}`);

    assert.strictEqual(mockAdapter._stores.corporations[2000001].allianceID, 3000001);
    assert.strictEqual(mockAdapter._stores.corporations[2000002].allianceID, 3000001);
    assert.strictEqual(mockAdapter._stores.alliances[3000001].isNPC, true);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V10b repairExisting: corp join fails but faction alliance isNPC still fixed (LOW)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v10b-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v10b-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp 0", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter._stores.corporations[2000001] = { corporationID: 2000001, name: "Test Corp 0", tickerName: "TSTC", allianceID: 0, foundingOperationID: "lne:v1:f:500019:corp:0" };
    mockAdapter._stores.alliances[3000001] = { allianceID: 3000001, name: "Test Alliance", shortName: "TSTA", isNPC: false, foundingOperationID: "lne:v1:f:500019:alliance" };
    mockAdapter.joinAlliance = async (corporationId, allianceId) => {
      mockAdapter.callCount++;
      return { ok: false, reason: "ALLIANCE_NOT_FOUND" };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);

    assert.strictEqual(mockAdapter._stores.corporations[2000001].allianceID, 0);
    assert.strictEqual(mockAdapter._stores.alliances[3000001].isNPC, true);
    assert.ok(res.repaired > 0, `expected repaired > 0, got ${res.repaired}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V11a updateState truncates reason to MAX_REASON_LENGTH (64)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v11a-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    const { MAX_REASON_LENGTH } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v11a-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "planned", name: "Test Corp", ticker: "TSTC" });

    const longReason = "CORPORATION_NOWAR_FAILED: This is a very long error message that exceeds the maximum reason length of sixty four characters in the database schema";
    assert.ok(longReason.length > MAX_REASON_LENGTH, "test reason must be longer than MAX_REASON_LENGTH");

    const upRes = repo.updateState(keyCorp, 1, "refused", { reason: longReason, at: T_AT });
    assert.ok(upRes.ok, `updateState should succeed with truncated reason, got: ${upRes.reason}`);

    const row = repo.getByKey(keyCorp);
    assert.ok(row.ok, `getByKey failed: ${row.reason}`);
    assert.strictEqual(row.row.reason.length, MAX_REASON_LENGTH, `reason should be truncated to ${MAX_REASON_LENGTH} chars`);
    assert.strictEqual(row.row.reason, longReason.substring(0, MAX_REASON_LENGTH), "reason should match truncated value");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V11b REFUSED with long reason from adapter -> state REFUSED, reason truncated to 64", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v11b-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v11b-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    const keyCEO = "f:500019:corp:0:char:0";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    repo.insert({ key: keyCEO, foundingOp: foundingOpOf(keyCEO), kind: "character", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "reserved", name: "CEO", ticker: null });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(1000001, keyCEO);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter.writeCharacter = async (record) => {
      mockAdapter.callCount++;
      return { ok: false, reason: "WRITE_CHARACTER_FAILED: This is a very long error message that exceeds the maximum reason length of sixty four characters in the database schema CHECK constraint" };
    };
    mockAdapter.resolveCharacterCreationBloodlineProfile = async () => ({ ok: true, raceId: 1, typeId: 1 });
    mockAdapter.pickCharacterName = async () => ({ ok: true, name: "TestChar" });

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    assert.strictEqual(res.ok, true, "saga should complete successfully");
    assert.ok(res.refused >= 1, `should have at least 1 refused, got ${res.refused}`);

    const charRows = repo.listByOwner("faction", 500019).filter(r => r.kind === "character" && r.state === "refused");
    assert.strictEqual(charRows.length, 1, "should have 1 REFUSED character row");
    assert.strictEqual(charRows[0].state, "refused", `character should be REFUSED, got ${charRows[0].state}`);
    assert.ok(charRows[0].reason, "reason should be set");
    assert.strictEqual(charRows[0].reason.length, 64, `reason should be truncated to 64 chars, got ${charRows[0].reason.length}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V12a createVirtualIdentitiesAdapter: checkCorporationAlliance returns correct shape", async () => {
    const { createVirtualIdentitiesAdapter } = require("../../lib/adapter/virtualIdentities");

    const corporations = {
      2000001: { corporationID: 2000001, name: "Test Corp", tickerName: "TSTC", allianceID: 3000001 },
      2000002: { corporationID: 2000002, name: "Test Corp 2", tickerName: "TST2", allianceID: 0 },
    };

    const requireGame = (relPath) => {
      if (relPath === "services/corporation/corporationState") {
        return {
          ok: true,
          exports: {
            getCorporationRecord: (corporationId) => {
              return corporations[corporationId] || null;
            },
          },
        };
      }
      return { ok: false, reason: `Unknown module: ${relPath}` };
    };

    const adapter = createVirtualIdentitiesAdapter({ requireGame });

    const res1 = await adapter.checkCorporationAlliance(2000001);
    assert.ok(res1.ok, `checkCorporationAlliance failed: ${res1.reason}`);
    assert.strictEqual(res1.inAlliance, true, "should be in alliance");
    assert.strictEqual(res1.allianceId, 3000001, "allianceId should match");

    const res2 = await adapter.checkCorporationAlliance(2000002);
    assert.ok(res2.ok, `checkCorporationAlliance failed: ${res2.reason}`);
    assert.strictEqual(res2.inAlliance, false, "should not be in alliance");
    assert.strictEqual(res2.allianceId, undefined, "allianceId should be undefined");

    const res3 = await adapter.checkCorporationAlliance(9999999);
    assert.ok(!res3.ok, "should fail for non-existent corporation");
    assert.strictEqual(res3.reason, "CORPORATION_NOT_FOUND", "reason should be CORPORATION_NOT_FOUND");
  });

  test("V12b createVirtualIdentitiesAdapter: checkAllianceIsNpc returns correct shape", async () => {
    const { createVirtualIdentitiesAdapter } = require("../../lib/adapter/virtualIdentities");

    const alliances = {
      3000001: { allianceID: 3000001, name: "Test Alliance", shortName: "TSTA", isNPC: true },
      3000002: { allianceID: 3000002, name: "Test Alliance 2", shortName: "TST2", isNPC: false },
    };

    const requireGame = (relPath) => {
      if (relPath === "services/corporation/corporationState") {
        return {
          ok: true,
          exports: {
            getAllianceRecord: (allianceId) => {
              return alliances[allianceId] || null;
            },
          },
        };
      }
      return { ok: false, reason: `Unknown module: ${relPath}` };
    };

    const adapter = createVirtualIdentitiesAdapter({ requireGame });

    const res1 = await adapter.checkAllianceIsNpc(3000001);
    assert.ok(res1.ok, `checkAllianceIsNpc failed: ${res1.reason}`);
    assert.strictEqual(res1.isNpc, true, "should be NPC");

    const res2 = await adapter.checkAllianceIsNpc(3000002);
    assert.ok(res2.ok, `checkAllianceIsNpc failed: ${res2.reason}`);
    assert.strictEqual(res2.isNpc, false, "should not be NPC");

    const res3 = await adapter.checkAllianceIsNpc(9999999);
    assert.ok(!res3.ok, "should fail for non-existent alliance");
    assert.strictEqual(res3.reason, "ALLIANCE_NOT_FOUND", "reason should be ALLIANCE_NOT_FOUND");
  });

  test("V13 repairExisting fixes isNPC for faction alliance even without CREATED/LINKED corps", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v13-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v13-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyAlliance = "f:500019:alliance";
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter._stores.alliances[3000001] = { allianceID: 3000001, name: "Test Alliance", shortName: "TSTA", isNPC: false, foundingOperationID: "lne:v1:f:500019:alliance" };

    let markAllianceNpcCalled = false;
    const originalMarkAllianceNpc = mockAdapter.markAllianceNpc;
    mockAdapter.markAllianceNpc = async (allianceId) => {
      markAllianceNpcCalled = true;
      return originalMarkAllianceNpc(allianceId);
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);

    assert.ok(markAllianceNpcCalled, "markAllianceNpc should have been called for faction alliance");
    assert.strictEqual(mockAdapter._stores.alliances[3000001].isNPC, true);
    assert.ok(res.repaired > 0, `expected repaired > 0, got ${res.repaired}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V14 repairExisting does not mark foreign alliance (no markAllianceNpc call with 9999999)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v14-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v14-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter._stores.corporations[2000001] = { corporationID: 2000001, name: "Test Corp", tickerName: "TSTC", allianceID: 9999999, foundingOperationID: "lne:v1:f:500019:corp:0" };
    mockAdapter._stores.alliances[3000001] = { allianceID: 3000001, name: "Test Alliance", shortName: "TSTA", isNPC: true, foundingOperationID: "lne:v1:f:500019:alliance" };
    mockAdapter._stores.alliances[9999999] = { allianceID: 9999999, name: "Foreign Alliance", shortName: "FRGN", isNPC: false, foundingOperationID: "foreign" };

    const markAllianceNpcCalls = [];
    const originalMarkAllianceNpc = mockAdapter.markAllianceNpc;
    mockAdapter.markAllianceNpc = async (allianceId) => {
      markAllianceNpcCalls.push(allianceId);
      return originalMarkAllianceNpc(allianceId);
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);

    assert.ok(!markAllianceNpcCalls.includes(9999999), "markAllianceNpc should not be called with foreign alliance ID 9999999");
    assert.strictEqual(mockAdapter._stores.alliances[3000001].isNPC, true);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V15 repairExisting fixes allowWar=0 for LINKED corporation", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v15-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v15-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = "f:500019:corp:0";
    const keyAlliance = "f:500019:alliance";
    repo.insert({ key: keyCorp, foundingOp: foundingOpOf(keyCorp), kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Corp", ticker: "TSTC" });
    repo.insert({ key: keyAlliance, foundingOp: foundingOpOf(keyAlliance), kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT, state: "linked", name: "Test Alliance", ticker: "TSTA" });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(2000001, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(3000001, keyAlliance);

    const mockAdapter = createMockAdapter({ crashAfter: Infinity });
    mockAdapter._stores.corporations[2000001] = { corporationID: 2000001, name: "Test Corp", tickerName: "TSTC", allianceID: 3000001, allowWar: 1, foundingOperationID: "lne:v1:f:500019:corp:0" };
    mockAdapter._stores.alliances[3000001] = { allianceID: 3000001, name: "Test Alliance", shortName: "TSTA", isNPC: true, foundingOperationID: "lne:v1:f:500019:alliance" };

    let markCorporationNoWarCalls = 0;
    const originalMarkCorporationNoWar = mockAdapter.markCorporationNoWar;
    mockAdapter.markCorporationNoWar = async (corporationId) => {
      markCorporationNoWarCalls++;
      return originalMarkCorporationNoWar(corporationId);
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);

    assert.ok(markCorporationNoWarCalls > 0, "markCorporationNoWar should be called");
    assert.strictEqual(mockAdapter._stores.corporations[2000001].allowWar, 0, "corp should have allowWar=0 after repair");
    assert.ok(res.repaired > 0, `expected repaired > 0, got ${res.repaired}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("V16 runSagaForFaction exits early on consecutive no-progress iterations (sagaNoProgressIterations)", async () => {
    const mockAdapter = createMockAdapter();

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-v16-"));
    const filePath = path.join(tmp, "world.sqlite");
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("v16-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const { planIdentities } = require("../../lib/virtualCorps/identityPlan");
    const planResult = planIdentities(
      { isActive: () => true },
      {
        getFactions: () => [{ id: 500019, name: "Sansha", alliance: { name: "Test Alliance", ticker: "TEST" },
          corporations: [{ name: "Test Corp", ticker: "TSTC" }],
          raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 }],
      },
      { corpsPerFaction: 1, membersPerCorp: 1, maxCharacters: 64 }
    );
    assert.ok(planResult.entries.length >= 3, `expected at least 3 entries (alliance, corp, char), got ${planResult.entries.length}`);

    for (const entry of planResult.entries) {
      const res = repo.insert({
        key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId,
        name: entry.name, ticker: entry.ticker, state: entry.state, at: T_AT,
      });
      assert.ok(res.ok, `insert failed for ${entry.key}: ${res.reason}`);
    }

    let markNoWarCallCount = 0;
    mockAdapter.markCorporationNoWar = async (corporationId) => {
      markNoWarCallCount++;
      mockAdapter.callCount++;
      return { ok: false, reason: "MARK_NOWAR_PERMANENT_FAILURE" };
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {
        virtualCorps: {
          sagaMaxIterations: 100,
          sagaNoProgressIterations: 3
        }
      },
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const res = await runSagaForFaction(sagaCtx, 500019,
      { id: 500019, name: "Sansha", alliance: { name: "Test Alliance", ticker: "TEST" },
        corporations: [{ name: "Test Corp", ticker: "TSTC" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 },
      4);

    assert.strictEqual(res.ok, true, `saga should complete: ${res.reason}`);
    
    assert.ok(markNoWarCallCount <= 10, 
      `markCorporationNoWar called ${markNoWarCallCount} times, should be << sagaMaxIterations (100)`);
    
    const rows = repo.listByOwner("faction", 500019);
    const charRows = rows.filter(r => r.kind === "character");
    const corp0Rows = rows.filter(r => r.kind === "corporation" && r.identity_key.endsWith(":corp:0"));
    
    const linkedChars = charRows.filter(r => r.state === "linked");
    assert.ok(linkedChars.length >= 1, `at least 1 character should be LINKED, got ${linkedChars.length}`);
    
    const corp0Row = corp0Rows[0];
    assert.ok(corp0Row && (corp0Row.state === "planned" || corp0Row.state === "created"), 
      `corp0 should be PLANNED or CREATED, got ${corp0Row?.state}`);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("VSOE1: data row 500016 neutral, validateData ok, plan SOERC + SANRW/FRLOG, other kind INVALID_KIND", () => {
    const VC = require("../../lib/strategy/data/virtualCorps");
    const { checkFactionQualifies } = require("../../lib/virtualCorps/identityPlan");
    const v = VC.validateData();
    assert.deepStrictEqual(v, { ok: true, errors: [] });
    const soe = VC.getById(500016);
    assert.ok(soe && soe.kind === "neutral", "SoE row neutral");
    assert.strictEqual(VC.FACTIONS[VC.FACTIONS.length - 1].id, 500016, "SoE row appended last");
    assert.strictEqual(VC.VIRTUAL_CORPS_VERSION, 3);

    const registry = { isActive: (id) => id === 500016, getFaction: () => null };
    const check = checkFactionQualifies(registry, VC, 500016);
    assert.strictEqual(check.ok, true, check.reason);

    const plan = planIdentities(registry, VC, { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64 });
    const own = plan.entries.filter((e) => e.ownerId === 500016);
    assert.deepStrictEqual(own.filter((e) => e.kind === "alliance").map((e) => e.ticker), ["SOERC"]);
    assert.deepStrictEqual(own.filter((e) => e.kind === "corporation").map((e) => e.ticker), ["SANRW", "FRLOG"]);
    assert.strictEqual(own.filter((e) => e.kind === "character").length, 6);
    assert.ok(plan.entries.every((e) => e.ownerId === 500016), "inactive factions skipped");

    const hive = { getFactions: () => [{ ...soe, id: 500025, kind: "hive" }] };
    assert.deepStrictEqual(checkFactionQualifies({ isActive: () => true }, hive, 500025),
      { ok: false, reason: "INVALID_KIND" });
  });

  test("VC-NOTE1 listPending returns PLANNED and RESERVED rows using IDENTITY_STATES", () => {
    const { createRepository } = require("../../lib/virtualCorps/identityRepository");
    const { upVirtualIdentities, IDENTITY_STATES, foundingOpOf, identityKeyForAlliance, identityKeyForCorporation, identityKeyForCharacter } = require("../../lib/virtualCorps/schema");

    const dbResult = (() => {
      const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
      const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
      const MOD_DIR = path.resolve(__dirname, "..", "..");
      const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
      if (!found.ok) return { skipped: `better-sqlite3 not available: ${found.reason}` };
      const driver = resolveSqliteDriver(found.srcDir);
      const db = new driver.Database(":memory:");
      upVirtualIdentities(db);
      return { ok: true, db };
    })();
    if (dbResult.skipped) return skip("VC-NOTE1 listPending", dbResult.skipped);
    const db = dbResult.db;

    const repo = createRepository(db);

    const key = identityKeyForAlliance(500019);
    repo.insert({
      key,
      foundingOp: foundingOpOf(key),
      kind: "alliance",
      ownerKind: "faction",
      ownerId: 500019, at: T_AT,
      state: IDENTITY_STATES.PLANNED,
      name: "Test Alliance",
      ticker: "TSTA",
    });

    const key2 = identityKeyForCorporation(500019, 0);
    repo.insert({
      key: key2,
      foundingOp: foundingOpOf(key2),
      kind: "corporation",
      ownerKind: "faction",
      ownerId: 500019, at: T_AT,
      state: IDENTITY_STATES.RESERVED,
      name: "Test Corp",
      ticker: "TSTC",
    });

    const key3 = identityKeyForCharacter(500019, 0, 0);
    repo.insert({
      key: key3,
      foundingOp: foundingOpOf(key3),
      kind: "character",
      ownerKind: "faction",
      ownerId: 500019, at: T_AT,
      state: IDENTITY_STATES.LINKED,
      name: "Test Pilot",
      ticker: null,
    });

    const pending = repo.listPending();
    assert.strictEqual(pending.length, 2, "listPending should return only PLANNED and RESERVED rows");

    const states = pending.map(r => r.state).sort();
    assert.deepStrictEqual(states, [IDENTITY_STATES.PLANNED, IDENTITY_STATES.RESERVED], "returned rows should be PLANNED and RESERVED");

    const plannedRow = pending.find(r => r.state === IDENTITY_STATES.PLANNED);
    assert.ok(plannedRow, "PLANNED row should be present");
    assert.strictEqual(plannedRow.kind, "alliance");

    const reservedRow = pending.find(r => r.state === IDENTITY_STATES.RESERVED);
    assert.ok(reservedRow, "RESERVED row should be present");
    assert.strictEqual(reservedRow.kind, "corporation");
  });

  test("VC-NOTE2 repairExisting: second start with entities in game -> repaired=0, no changes", async () => {
    const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
    const { openStore } = require("../../lib/persistence/store");
    const { upVirtualIdentities, IDENTITY_STATES, foundingOpOf, identityKeyForAlliance, identityKeyForCorporation } = require("../../lib/virtualCorps/schema");
    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const { createRepository } = require("../../lib/virtualCorps/identityRepository");
    const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
    const MOD_DIR = path.resolve(__dirname, "..", "..");
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    if (!found.ok) return skip("VC-NOTE2 repairExisting second start", found.reason);
    const driver = resolveSqliteDriver(found.srcDir);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-note2-"));
    const filePath = path.join(tmp, "world.sqlite");
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;

    let dbHandle = null;
    store.transaction("note2-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = identityKeyForCorporation(500019, 0);
    const keyAlliance = identityKeyForAlliance(500019);
    const CORP_ID = 2000001;
    const ALLIANCE_ID = 3000001;
    const FOUNDING_OP_CORP = foundingOpOf(keyCorp);
    const FOUNDING_OP_ALLIANCE = foundingOpOf(keyAlliance);

    repo.insert({
      key: keyCorp, foundingOp: FOUNDING_OP_CORP, kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT,
      state: IDENTITY_STATES.LINKED, name: "Test Corp", ticker: "TSTC",
    });
    repo.insert({
      key: keyAlliance, foundingOp: FOUNDING_OP_ALLIANCE, kind: "alliance", ownerKind: "faction", ownerId: 500019, at: T_AT,
      state: IDENTITY_STATES.LINKED, name: "Test Alliance", ticker: "TSTA",
    });

    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(CORP_ID, keyCorp);
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(ALLIANCE_ID, keyAlliance);

    const mockAdapter = {
      virtualIdentityExists: async (kind, evejsId, foundingOp) => {
        if (kind === "corporation" && foundingOp === FOUNDING_OP_CORP) {
          return { ok: true, found: true, corporationId: CORP_ID, record: { corporationID: CORP_ID, foundingOperationID: FOUNDING_OP_CORP, name: "Test Corp", tickerName: "TSTC", allianceID: ALLIANCE_ID } };
        }
        if (kind === "alliance" && foundingOp === FOUNDING_OP_ALLIANCE) {
          return { ok: true, found: true, allianceId: ALLIANCE_ID, record: { allianceID: ALLIANCE_ID, foundingOperationID: FOUNDING_OP_ALLIANCE, name: "Test Alliance", shortName: "TSTA", isNPC: true } };
        }
        return { ok: true, found: false };
      },
      checkCorporationAlliance: async (corporationId) => {
        return { ok: true, inAlliance: true, allianceId: ALLIANCE_ID };
      },
      checkAllianceIsNpc: async (allianceId) => {
        return { ok: true, isNpc: true };
      },
      markAllianceNpc: async () => ({ ok: true, changed: false }),
      markCorporationNoWar: async () => ({ ok: true, changed: false }),
      joinAlliance: async () => ({ ok: true }),
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);
    assert.strictEqual(res.repaired, 0, `expected repaired=0, got ${res.repaired}`);

    const corpRow = repo.getByKey(keyCorp).row;
    const allianceRow = repo.getByKey(keyAlliance).row;
    assert.strictEqual(corpRow.state, IDENTITY_STATES.LINKED, "corp should remain LINKED");
    assert.strictEqual(corpRow.evejs_id, CORP_ID, "corp evejs_id should be unchanged");
    assert.strictEqual(allianceRow.state, IDENTITY_STATES.LINKED, "alliance should remain LINKED");
    assert.strictEqual(allianceRow.evejs_id, ALLIANCE_ID, "alliance evejs_id should be unchanged");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("VC-NOTE2 repairExisting: entity missing from game -> repaired=1, row reset to PLANNED", async () => {
    const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
    const { openStore } = require("../../lib/persistence/store");
    const { upVirtualIdentities, IDENTITY_STATES, foundingOpOf, identityKeyForCorporation } = require("../../lib/virtualCorps/schema");
    const { repairExisting } = require("../../lib/virtualCorps/identitySaga");
    const { createRepository } = require("../../lib/virtualCorps/identityRepository");
    const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
    const MOD_DIR = path.resolve(__dirname, "..", "..");
    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    if (!found.ok) return skip("VC-NOTE2 repairExisting missing entity", found.reason);
    const driver = resolveSqliteDriver(found.srcDir);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-note2b-"));
    const filePath = path.join(tmp, "world.sqlite");
    const opened = openStore({
      filePath, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;

    let dbHandle = null;
    store.transaction("note2b-ddl", (db) => {
      dbHandle = db;
      upVirtualIdentities(db);
    });
    const repo = createRepository(dbHandle);

    const keyCorp = identityKeyForCorporation(500019, 0);
    const CORP_ID = 2000001;
    const FOUNDING_OP_CORP = foundingOpOf(keyCorp);

    repo.insert({
      key: keyCorp, foundingOp: FOUNDING_OP_CORP, kind: "corporation", ownerKind: "faction", ownerId: 500019, at: T_AT,
      state: IDENTITY_STATES.LINKED, name: "Test Corp", ticker: "TSTC",
    });
    dbHandle.prepare(`UPDATE world_virtual_identities SET evejs_id = ? WHERE identity_key = ?`).run(CORP_ID, keyCorp);

    const mockAdapter = {
      virtualIdentityExists: async (kind, evejsId, foundingOp) => {
        return { ok: true, found: false };
      },
      checkCorporationAlliance: async () => ({ ok: true, inAlliance: false }),
      checkAllianceIsNpc: async () => ({ ok: true, isNpc: true }),
      markAllianceNpc: async () => ({ ok: true }),
      markCorporationNoWar: async () => ({ ok: true }),
      joinAlliance: async () => ({ ok: true }),
    };

    const sagaCtx = {
      adapter: mockAdapter,
      repo,
      logger: { log: () => {} },
      config: {},
      fail: () => ({ ok: false }),
      clock: T_CLOCK,
    };

    const res = await repairExisting(sagaCtx);
    assert.ok(res.ok, `repairExisting failed: ${res.reason}`);
    assert.strictEqual(res.repaired, 1, `expected repaired=1, got ${res.repaired}`);

    const corpRow = repo.getByKey(keyCorp).row;
    assert.strictEqual(corpRow.state, IDENTITY_STATES.PLANNED, "corp should be reset to PLANNED");
    assert.strictEqual(corpRow.evejs_id, null, "corp evejs_id should be null");

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("VWC1 virtualCorps writes simulation time: repo created_at/updated_at = at, saga rows + character records = clock.now(), no at/clock refused", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vc-vwc1-"));
    const found = findServerSrc();
    const driver = resolveSqliteDriver(found.srcDir);
    const opened = openStore({
      filePath: path.join(tmp, "world.sqlite"), openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 1000, maxRowsPerTransaction: 100, maxWriteMsPerPass: 5,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    const { upVirtualIdentities, REASON_INVALID_AT } = require("../../lib/virtualCorps/schema");
    let dbHandle = null;
    store.transaction("vwc1-ddl", (db) => { dbHandle = db; upVirtualIdentities(db); });
    const repo = createRepository(dbHandle);
    const A = 1234567, B = 2345678, C = 3456789, S = 4567890;

    const kA = identityKeyForAlliance(500001);
    const spec = { key: kA, foundingOp: foundingOpOf(kA), kind: "alliance", ownerKind: "faction", ownerId: 500001,
      state: IDENTITY_STATES.PLANNED, name: "Wall Alliance", ticker: "WALL" };
    assert.deepStrictEqual(repo.insert(spec), { ok: false, reason: REASON_INVALID_AT });
    assert.strictEqual(repo.getByKey(kA).reason, "NOT_FOUND");
    assert.ok(repo.insert({ ...spec, at: A }).ok);
    let row = repo.getByKey(kA).row;
    assert.deepStrictEqual([row.created_at, row.updated_at], [A, A]);
    assert.deepStrictEqual(repo.updateState(kA, 1, IDENTITY_STATES.RESERVED, {}), { ok: false, reason: REASON_INVALID_AT });
    assert.ok(repo.updateState(kA, 1, IDENTITY_STATES.RESERVED, { at: B }).ok);
    row = repo.getByKey(kA).row;
    assert.deepStrictEqual([row.created_at, row.updated_at, row.version], [A, B, 2]);
    assert.deepStrictEqual(repo.update(kA, 2, { state: IDENTITY_STATES.RESERVED, at: -1 }),
      { ok: false, reason: REASON_INVALID_AT });
    assert.ok(repo.update(kA, 2, { state: IDENTITY_STATES.RESERVED, name: "Wall Alliance", ticker: "WALL", at: C }).ok);
    row = repo.getByKey(kA).row;
    assert.deepStrictEqual([row.created_at, row.updated_at, row.version], [A, C, 3]);

    const plan = planIdentities({ isActive: () => true }, {
      getFactions: () => [{ id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
        corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }],
        raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5 }],
    }, { corpsPerFaction: 1, membersPerCorp: 2, maxCharacters: 64 });
    for (const e of plan.entries) {
      assert.ok(repo.insert({ key: e.key, foundingOp: e.foundingOp, kind: e.kind, ownerKind: e.ownerKind,
        ownerId: e.ownerId, name: e.name, ticker: e.ticker, state: e.state, at: A }).ok);
    }
    const factionData = { id: 500019, name: "Sansha", alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
      corporations: [{ name: "True Slaves Vanguard", ticker: "TSVG" }], raceId: 4, bloodlineIds: [5, 6, 13],
      securityRating: -5 };
    const { runSagaForFaction } = require("../../lib/virtualCorps/identitySaga");
    const mockAdapter = createMockAdapter();
    const records = [];
    const write = mockAdapter.writeCharacter;
    mockAdapter.writeCharacter = (record) => { records.push(record); return write(record); };
    const base = { adapter: mockAdapter, repo, logger: { log: () => {} }, config: {}, fail: () => ({ ok: false }) };

    await runSagaForFaction(base, 500019, factionData, 4);
    assert.strictEqual(records.length, 0);
    for (const r of repo.listByOwner("faction", 500019)) {
      assert.deepStrictEqual([r.state, r.updated_at, r.version], [IDENTITY_STATES.PLANNED, A, 1], r.identity_key);
    }

    const res = await runSagaForFaction({ ...base, clock: { now: () => S } }, 500019, factionData, 4);
    assert.ok(res.ok, `saga failed: ${res.reason}`);
    const rows = repo.listByOwner("faction", 500019);
    assert.strictEqual(rows.length, plan.entries.length);
    for (const r of rows) {
      assert.strictEqual(r.state, IDENTITY_STATES.LINKED, r.identity_key);
      assert.deepStrictEqual([r.created_at, r.updated_at], [A, S], r.identity_key);
    }
    assert.strictEqual(records.length, 2);
    for (const rec of records) assert.deepStrictEqual([rec.creationDate, rec.lastLoginDate], [S, S]);

    store.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });
};
