"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { createStoreRepository } = require("../../lib/virtualCorps/identityRepository");
const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");
const virtualCorps = require("../../lib/virtualCorps");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FACTION = 500019;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function openMemoryStore(driver) {
  const opened = openStore({ filePath: ":memory:", openDatabase: () => new driver.Database(":memory:"),
    exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
    randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  return opened.store;
}

function fakeIdentityAdapter() {
  const characters = {};
  const corporations = {};
  const alliances = {};
  let next = 0;
  return {
    getProcessRole: () => "world",
    reserveCharacterId: () => {
      const id = 1000000 + (next += 1);
      characters[id] = { characterId: id, corporationID: 0, allianceID: 0 };
      return { ok: true, characterId: id };
    },
    writeCharacter: (record) => {
      characters[record.characterId] = { characterId: record.characterId, corporationID: record.corporationId,
        allianceID: record.allianceID || 0, lneIdentityKey: record.lneIdentityKey };
      return { ok: true };
    },
    pickCharacterName: (raceId) => ({ ok: true, name: `Pilot_${raceId}_${next += 1}` }),
    ensureCorporation: (_ceoId, spec) => {
      const id = 2000000 + Object.keys(corporations).length;
      corporations[id] = { corporationID: id, name: spec.name, allianceID: 0 };
      return { ok: true, corporationId: id };
    },
    ensureAlliance: (_creatorId, _execCorpId, spec) => {
      const id = 3000000 + Object.keys(alliances).length;
      alliances[id] = { allianceID: id, name: spec.name };
      return { ok: true, allianceId: id };
    },
    markAllianceNpc: () => ({ ok: true, changed: true }),
    markCorporationNoWar: () => ({ ok: true, changed: true }),
    joinCorporation: (characterId, corporationId, allianceId) => {
      if (characters[characterId]) Object.assign(characters[characterId], { corporationID: corporationId, allianceID: allianceId || 0 });
      return { ok: true };
    },
    joinAlliance: (corporationId, allianceId) => {
      if (corporations[corporationId]) corporations[corporationId].allianceID = allianceId;
      return { ok: true };
    },
    virtualIdentityExists: (kind, id) => ({ ok: true,
      found: Boolean((kind === "character" ? characters : kind === "corporation" ? corporations : alliances)[id]) }),
    scanVirtualCharacters: () => ({ ok: true,
      characters: Object.values(characters).filter((c) => typeof c.lneIdentityKey === "string") }),
    virtualIdentityFlush: () => ({ ok: true }),
    resolveCharacterCreationBloodlineProfile: () => ({ ok: true, raceId: 4, typeId: 401 }),
  };
}

function startOn(store, logs, counters) {
  return virtualCorps.startVirtualCorps({
    config: {
      modules: { virtualCorps: { enabled: true } },
      virtualCorps: { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64, seedOpsPerSlice: 4, fleetCorporations: true },
    },
    adapter: fakeIdentityAdapter(),
    persistence: { ok: true, store },
    logger: { log: (msg) => logs.push(msg) },
    fail: () => ({ ok: false }),
    clock: { now: () => 1000000 },
    telemetry: { count: (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n), gauge: () => {}, observe: () => {} },
    strategy: { registry: { isActive: (id) => id === FACTION } },
  });
}

function assertLinkedIdentity(logs) {
  const identity = virtualCorps.getFactionIdentity(FACTION);
  assert.strictEqual(identity.ok, true, `getFactionIdentity: ${JSON.stringify(identity)} logs=${logs.join(" | ")}`);
  assert.ok(identity.allianceId > 0, `allianceId: ${JSON.stringify(identity)}`);
  assert.strictEqual(identity.corporationIds.length, 2, JSON.stringify(identity));
  assert.strictEqual(identity.characterIds.length, 6, JSON.stringify(identity));
  return identity;
}

module.exports = ({ test, skip }) => {
  test("VS1 startVirtualCorps on the production store facade (no db) starts and links the faction", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("VS1 production store shape", "no sqlite driver");
    const store = openMemoryStore(driver);
    const logs = [];
    try {
      assert.strictEqual(Object.prototype.hasOwnProperty.call(store, "db"), false, "store facade must not expose db");
      const started = startOn(store, logs, new Map());
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      assert.notStrictEqual(started.reason, "NO_PERSISTENCE_DB");
      await started.whenReady();
      assertLinkedIdentity(logs);
      assert.ok(!logs.some((l) => l.includes("boot failed")), logs.join(" | "));
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("VS1");
    }
  });

  test("VS2 every repository read/write of the saga runs inside store.transaction", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("VS2 store.transaction only", "no sqlite driver");
    const real = openMemoryStore(driver);
    const names = [];
    const countingStore = {
      transaction(name, fn) {
        names.push(name);
        return real.transaction(name, (db) => {
          const { proxy, revoke } = Proxy.revocable(db, {
            get(target, key) {
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          try {
            return fn(proxy);
          } finally {
            revoke();
          }
        });
      },
      isInTransaction: () => real.isInTransaction(),
      limits: real.limits,
    };
    const logs = [];
    try {
      const started = startOn(countingStore, logs, new Map());
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      await started.whenReady();
      assertLinkedIdentity(logs);
      assert.ok(names.length > 0, "transaction must be called");
      assert.ok(names.every((n) => n.startsWith("virtualCorps.")), `foreign transaction names: ${names.join(",")}`);
      assert.ok(names.includes("virtualCorps.insert"), "plan rows are inserted through store.transaction");
      assert.ok(names.includes("virtualCorps.updateState"), "saga writes go through store.transaction");
      assert.ok(!logs.some((l) => /revoked|boot failed/.test(l)), logs.join(" | "));
    } finally {
      virtualCorps.stopVirtualCorps();
      real.close("VS2");
    }
  });

  test("VS3 facade reads inside an open store transaction: no TX_NESTED, outer tx commits", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("VS3 reads inside tx", "no sqlite driver");
    const store = openMemoryStore(driver);
    const logs = [];
    const counters = new Map();
    try {
      const started = startOn(store, logs, counters);
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      await started.whenReady();
      const before = assertLinkedIdentity(logs);

      const tx = store.transaction("vs3.outer", () => ({
        identity: virtualCorps.getFactionIdentity(FACTION),
        list: virtualCorps.listIdentities(),
        corp: virtualCorps.corporationForRole(FACTION, "patrol"),
        alliance: virtualCorps.isVirtualAlliance(before.allianceId),
        corporation: virtualCorps.isVirtualCorporation(before.corporationIds[0]),
      }));
      assert.strictEqual(tx.ok, true, JSON.stringify(tx));
      assert.deepStrictEqual(tx.value.identity, before);
      assert.strictEqual(tx.value.list.length, 9);
      assert.ok(tx.value.list.every((r) => r.state === IDENTITY_STATES.LINKED));
      assert.ok(before.corporationIds.includes(tx.value.corp), `corporationForRole: ${tx.value.corp}`);
      assert.strictEqual(tx.value.alliance, true);
      assert.strictEqual(tx.value.corporation, true);

      const repo = createStoreRepository(store, { telemetry: { count: (n) => counters.set(n, (counters.get(n) || 0) + 1) },
        logger: { log: (msg) => logs.push(msg) } });
      const nested = store.transaction("vs3.nested", () => ({
        list: repo.listByState(IDENTITY_STATES.LINKED),
        get: repo.getByKey("missing"),
      }));
      assert.strictEqual(nested.ok, true, JSON.stringify(nested));
      assert.deepStrictEqual(nested.value.list, []);
      assert.deepStrictEqual(nested.value.get, { ok: false, reason: "TX_NESTED" });
      assert.strictEqual(counters.get("virtualCorps.txNested"), 2);
      assert.strictEqual(repo.listByState(IDENTITY_STATES.LINKED).length, 9, "outside a tx the repository reads");
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("VS3");
    }
  });

  test("VS4 observer-readability: second start on the same store -> no insert failures, planExisting = plan size, no plan line; failed insert -> planFailed + reason", async () => {
    const driver = loadDriver();
    if (!driver || !driver.ok) return skip("VS4 plan existing on restart", "no sqlite driver");
    const store = openMemoryStore(driver);
    const firstLogs = [];
    const firstCounters = new Map();
    try {
      const first = startOn(store, firstLogs, firstCounters);
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      await first.whenReady();
      assertLinkedIdentity(firstLogs);
      assert.strictEqual(firstCounters.get("virtualCorps.planInserted"), 9, JSON.stringify([...firstCounters]));
      assert.ok(firstLogs.some((l) => l.startsWith("virtualCorps: plan inserted=9 existing=0 conflicts=0 failed=0")),
        firstLogs.join(" | "));
      virtualCorps.stopVirtualCorps();

      const logs = [];
      const counters = new Map();
      const second = startOn(store, logs, counters);
      assert.strictEqual(second.ok, true, JSON.stringify(second));
      await second.whenReady();
      assertLinkedIdentity(logs);
      assert.ok(!logs.some((l) => l.includes("insert failed") || l.startsWith("virtualCorps: plan ")), logs.join(" | "));
      assert.strictEqual(counters.get("virtualCorps.planExisting"), 9, JSON.stringify([...counters]));
      assert.strictEqual(counters.get("virtualCorps.planInserted"), undefined);
      assert.strictEqual(counters.get("virtualCorps.planConflicts"), undefined);
      assert.strictEqual(counters.get("virtualCorps.planFailed"), undefined);
    } finally {
      virtualCorps.stopVirtualCorps();
      store.close("VS4");
    }

    const failStore = openMemoryStore(driver);
    const failLogs = [];
    const failCounters = new Map();
    let refused = false;
    const wrapped = {};
    for (const key of Object.keys(failStore)) {
      const v = failStore[key];
      wrapped[key] = typeof v === "function" ? v.bind(failStore) : v;
    }
    wrapped.transaction = (label, fn) => {
      if (label === "virtualCorps.insert" && !refused) {
        refused = true;
        return { ok: false, reason: "DISK_FULL_TEST" };
      }
      return failStore.transaction(label, fn);
    };
    try {
      const started = startOn(wrapped, failLogs, failCounters);
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      await started.whenReady();
      assert.strictEqual(failCounters.get("virtualCorps.planFailed"), 1, JSON.stringify([...failCounters]));
      const line = failLogs.find((l) => l.startsWith("virtualCorps: plan inserted="));
      assert.ok(line && /failed=1 \(first failure \S+: DISK_FULL_TEST\)$/.test(line), failLogs.join(" | "));
    } finally {
      virtualCorps.stopVirtualCorps();
      failStore.close("VS4-fail");
    }
  });
};
