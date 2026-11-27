"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const loader = require("../../loader");
const {
  createDbsKillmailCache, installGetAll, installScope, checkFingerprints, obsoleteDetail, FILE_FINGERPRINTS,
  FUNCTION_FINGERPRINTS,
} = require("../../lib/adapter/dbsKillmailCache");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const SELF_TEXT = fs.readFileSync(__filename, "utf8");

const vendor = { fullRebuilds: 1, incrementalUpdates: 0, dirty: false, ready: true, rows: [], calls: 0 };

function getAllKillmailRecords() {
  vendor.calls += 1;
  return vendor.rows.map((r) => ({ ...r, attackers: [...(r.attackers || [])] }));
}

function getKillmailProjectionStats() {
  return { fullRebuilds: vendor.fullRebuilds, incrementalUpdates: vendor.incrementalUpdates, dirty: vendor.dirty,
    ready: vendor.ready };
}

function setVendor(rows) {
  Object.assign(vendor, { fullRebuilds: 1, incrementalUpdates: 0, dirty: false, ready: true, rows, calls: 0 });
}

function fixture(maxRecords = 1000) {
  const counts = [];
  const core = createDbsKillmailCache({ maxRecords, onCount: (n) => counts.push(n) });
  const km = { getAllKillmailRecords, getKillmailProjectionStats };
  assert.deepStrictEqual(installGetAll(core, km, SELF_TEXT), { ok: true });
  let seen = [];
  const dbs = {
    recoverLosses() {
      seen = km.getAllKillmailRecords();
      return seen.length;
    },
    maintain() {
      return dbs.recoverLosses();
    },
    boom() {
      throw new Error("boom");
    },
  };
  assert.deepStrictEqual(installScope(core, dbs), { ok: true });
  return { core, km, dbs, counts, seen: () => seen };
}

module.exports = ({ test }) => {
  test("DK1 dbs killmail cache: flag off = no wrap; on without server/src = disabled:drift, no wrap", () => {
    const config = resolveConfig({ modDir: MOD_DIR }).config;
    assert.strictEqual(config.world.dbsKillmailCache.enabled, false, "default off");
    assert.strictEqual(config.world.dbsKillmailCache.maxRecords, 200000);
    const boot = (env) => {
      const km = { getAllKillmailRecords, getKillmailProjectionStats };
      const maintain = () => 1;
      const recoverLosses = () => 2;
      const dbs = { maintain, recoverLosses };
      const lines = [];
      const moduleApi = { _cache: {}, _resolveFilename: (r) => r,
        _load: (request) => (request.includes("killmailState") ? km : request.includes("dynamicBountyRuntime") ? dbs : {}) };
      const out = loader.install({ moduleApi, globalObj: {}, env: {}, isMainThread: true,
        logger: { log: (l) => lines.push(l), debug() {}, logError() {} },
        loadConfig: () => resolveConfig({ modDir: MOD_DIR, env }) });
      assert.ok(out.ok);
      moduleApi._load("../killmail/killmailState", { filename: "/x/server/src/services/dynamic/a.js" });
      moduleApi._load("./dynamicBountyRuntime", { filename: "/x/server/src/services/dynamic/b.js" });
      return { km, dbs, maintain, recoverLosses, lines };
    };
    const off = boot({});
    assert.strictEqual(off.km.getAllKillmailRecords, getAllKillmailRecords);
    assert.strictEqual(off.dbs.maintain, off.maintain);
    assert.strictEqual(off.dbs.recoverLosses, off.recoverLosses);
    assert.ok(!off.lines.some((l) => l.includes("dbsKillmailCache")), off.lines.join("\n"));
    const on = boot({ EVEJS_LNE_WORLD_DBS_KILLMAIL_CACHE_ENABLED: "1" });
    assert.strictEqual(on.km.getAllKillmailRecords, getAllKillmailRecords, "no wrap without the fingerprint");
    assert.strictEqual(on.dbs.maintain, on.maintain);
    assert.ok(on.lines.includes("dbsKillmailCache: disabled:drift (locate) - vendor killmail copies in DBS"),
      on.lines.join("\n"));
  });

  test("DK2 dbs killmail cache: hit per version, incrementalUpdates / dirty invalidate, maxRecords bypass", () => {
    setVendor([{ killID: 3, attackers: [{ characterID: 9 }] }, { killID: 2 }]);
    const f = fixture();
    assert.strictEqual(f.dbs.maintain(), 2);
    const first = f.seen();
    assert.strictEqual(f.dbs.recoverLosses(), 2);
    assert.strictEqual(f.seen(), first, "the same array");
    assert.strictEqual(vendor.calls, 1, "one original call");
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first[0]) && Object.isFrozen(first[0].attackers));
    assert.deepStrictEqual(first, getAllKillmailRecords(), "parity with the vendor copy");
    vendor.calls = 1;
    vendor.incrementalUpdates = 1;
    vendor.rows = [{ killID: 4 }, ...vendor.rows];
    assert.strictEqual(f.dbs.recoverLosses(), 3);
    assert.strictEqual(vendor.calls, 2, "a new version = the original");
    assert.strictEqual(f.dbs.recoverLosses(), 3);
    assert.strictEqual(vendor.calls, 2, "and kept for that version");
    vendor.dirty = true;
    f.dbs.recoverLosses();
    f.dbs.recoverLosses();
    assert.strictEqual(vendor.calls, 4, "dirty = the original every time");
    assert.ok(!Object.isFrozen(f.seen()), "nothing kept for a dirty index");
    assert.deepStrictEqual(f.counts, ["miss", "hit", "miss", "hit", "miss", "miss"]);
    assert.strictEqual(f.core.status().cachedRecords, 0);

    setVendor([{ killID: 1 }, { killID: 2 }]);
    const small = fixture(1);
    small.dbs.recoverLosses();
    small.dbs.recoverLosses();
    assert.strictEqual(vendor.calls, 2, "above maxRecords: no cache");
    assert.deepStrictEqual(small.counts, ["miss", "bypass", "miss", "bypass"]);
    assert.ok(!Object.isFrozen(small.seen()));
    assert.match(small.core.statsLine(), /^dbsKillmailCache stats state=ready hit=0 miss=2 bypass=2 records=0 key=-$/);
  });

  test("DK3 dbs killmail cache: outside the scope = the original, a throw resets the depth", () => {
    setVendor([{ killID: 1 }]);
    const f = fixture();
    f.dbs.recoverLosses();
    const out1 = f.km.getAllKillmailRecords();
    const out2 = f.km.getAllKillmailRecords();
    assert.notStrictEqual(out1, out2);
    assert.ok(!Object.isFrozen(out1), "ensureSystem / achievementRuntime / mapService get the vendor copy");
    assert.strictEqual(vendor.calls, 3);
    const boom = f.core.wrapScope(f.dbs.boom);
    assert.throws(() => boom(), /boom/);
    assert.strictEqual(f.core.status().depth, 0);
    f.km.getAllKillmailRecords();
    assert.strictEqual(vendor.calls, 4, "still the original after the throw");
    assert.deepStrictEqual(f.counts, ["miss"]);
  });

  test("DK4 dbs killmail cache: drift detail, disabled = the original + counter drift, foreign getAll refused", () => {
    const files = new Map();
    const read = (abs) => (files.has(abs) ? files.get(abs) : null);
    const src = path.join(path.sep, "srv", "src");
    assert.strictEqual(checkFingerprints(src, read), "services/dynamic/dynamicBountyRuntime.js missing");
    const real = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(real.ok, "EveJS server/src not found above the mod");
    for (const rel of [...Object.keys(FILE_FINGERPRINTS), ...Object.keys(FUNCTION_FINGERPRINTS)]) {
      files.set(path.join(src, ...rel.split("/")), fs.readFileSync(path.join(real.srcDir, ...rel.split("/")), "utf8"));
    }
    assert.strictEqual(obsoleteDetail(src, read),
      "services/dynamic/dynamicBountyRuntime.js never calls getAllKillmailRecords", "today's vendor");
    const dbsPath = path.join(src, "services", "dynamic", "dynamicBountyRuntime.js");
    const fixed = files.get(dbsPath);
    files.set(dbsPath, fixed.replace(".getHighestKillmailID();", ".getAllKillmailRecords().length;"));
    assert.strictEqual(obsoleteDetail(src, read), null, "a getAll call again = not obsolete (the fingerprints decide)");
    files.set(dbsPath, fixed);
    const kmPath = path.join(src, "services", "killmail", "killmailState.js");
    files.set(kmPath, files.get(kmPath).replace("cloneValue(ensureKillmailIndexes().recordsDesc)",
      "ensureKillmailIndexes().recordsDesc"));
    assert.strictEqual(checkFingerprints(src, read), "services/killmail/killmailState.js#getAllKillmailRecords");

    setVendor([{ killID: 1 }]);
    const f = fixture();
    f.core.disable("drift", "services/killmail/killmailState.js#getAllKillmailRecords");
    f.dbs.recoverLosses();
    f.dbs.recoverLosses();
    assert.strictEqual(vendor.calls, 2, "disabled = the original every time");
    assert.ok(!Object.isFrozen(f.seen()));
    assert.deepStrictEqual(f.counts, ["drift"]);
    assert.strictEqual(f.core.status().state, "disabled:drift");

    const core = createDbsKillmailCache({ maxRecords: 10 });
    const foreign = { getAllKillmailRecords: () => [], getKillmailProjectionStats };
    assert.deepStrictEqual(installGetAll(core, foreign, SELF_TEXT),
      { ok: false, reason: "foreign", detail: "getAllKillmailRecords" });
    assert.deepStrictEqual(installGetAll(core, Object.freeze({ getAllKillmailRecords, getKillmailProjectionStats }),
      SELF_TEXT), { ok: false, reason: "not_writable" });
  });

  test("DK5 dbs killmail cache vendor facts 261115.2: the vendor walk replaces the copy -> obsolete, nothing wrapped",
    () => {
      const real = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
      assert.ok(real.ok, "EveJS server/src not found above the mod");
      const read = (...rel) => fs.readFileSync(path.join(real.srcDir, ...rel), "utf8").replace(/\r\n/g, "\n");
      const dbsText = read("services", "dynamic", "dynamicBountyRuntime.js");
      const body = (name) => {
        const m = new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`).exec(dbsText);
        assert.ok(m, name);
        return m[0];
      };
      assert.ok(!dbsText.includes("getAllKillmailRecords"), "no copy of the killmail index in DBS");
      assert.ok(dbsText.includes("const activationKillID = require(\"../killmail/killmailState\").getHighestKillmailID();"));
      const recover = body("recoverLosses");
      assert.ok(recover.includes("require(\"../killmail/killmailState\").forEachKillmailRecordDescending(record => {"));
      assert.ok(recover.includes("if (Number(record.killID) <= watermark) return false;"), "stops at the watermark");
      const km = read("services", "killmail", "killmailState.js");
      assert.match(km, /\nfunction forEachKillmailRecordDescending\(visitor\) \{\n {2}for \(const record of ensureKillmailIndexes\(\)\.recordsDesc\) \{\n {4}if \(visitor\(redactReservedAbyssalHostFromKillmail\(record\)\) === false\) \{/);
      assert.strictEqual(obsoleteDetail(real.srcDir, (abs) => fs.readFileSync(abs, "utf8")),
        "services/dynamic/dynamicBountyRuntime.js never calls getAllKillmailRecords");

      const kmFile = path.join(real.srcDir, "services", "killmail", "killmailState.js");
      const kmExports = { getAllKillmailRecords, getKillmailProjectionStats };
      const dbs = { maintain: () => 1, recoverLosses: () => 2 };
      const { maintain, recoverLosses } = dbs;
      const lines = [];
      const moduleApi = { _cache: { [kmFile]: { exports: kmExports } }, _resolveFilename: (r) => r,
        _load: (request) => (request.includes("killmailState") ? kmExports
          : request.includes("dynamicBountyRuntime") ? dbs : {}) };
      const out = loader.install({ moduleApi, globalObj: {}, env: {}, isMainThread: true,
        logger: { log: (l) => lines.push(l), debug() {}, logError: (l) => lines.push(l) },
        loadConfig: () => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WORLD_DBS_KILLMAIL_CACHE_ENABLED: "1" } }) });
      assert.ok(out.ok);
      moduleApi._load("../killmail/killmailState", { filename: path.join(real.srcDir, "services", "map", "mapService.js") });
      moduleApi._load("./dynamicBountyRuntime", { filename: path.join(real.srcDir, "services", "dynamic", "a.js") });
      assert.strictEqual(kmExports.getAllKillmailRecords, getAllKillmailRecords, "obsolete: getAll not wrapped");
      assert.deepStrictEqual([dbs.maintain, dbs.recoverLosses], [maintain, recoverLosses], "obsolete: no scope");
      assert.deepStrictEqual(lines.filter((l) => l.startsWith("dbsKillmailCache")), [
        "dbsKillmailCache: disabled:obsolete (services/dynamic/dynamicBountyRuntime.js never calls "
          + "getAllKillmailRecords) - the vendor walks killmails without a copy"]);
    });

  test("DK6 dbs killmail cache vendor facts: property callers, read-only loss path, pure abyssal redaction", () => {
    const real = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(real.ok, "EveJS server/src not found above the mod");
    const read = (...rel) => fs.readFileSync(path.join(real.srcDir, ...rel), "utf8").replace(/\r\n/g, "\n");
    const dbs = read("services", "dynamic", "dynamicBountyRuntime.js");
    const body = (name) => {
      const m = new RegExp(`\\nfunction ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}\\n`).exec(dbs);
      assert.ok(m, name);
      return m[0];
    };
    assert.ok(body("maintain").includes("\n  recoverLosses(systemID);\n"), "maintain calls recoverLosses locally");
    for (const name of ["recordLoss", "qualifyingLoss"]) {
      assert.doesNotMatch(body(name), /\brecord(\.\w+|\[[^\]]+\])\s*(=[^=]|\?\?=|\+=|-=)|delete record/, `${name} writes no record`);
    }
    const ess = read("services", "dynamic", "essSettlementRuntime.js");
    assert.ok(ess.includes("  require(\"./dynamicBountyRuntime\").maintain(systemID);\n"));
    assert.ok(ess.includes("  require(\"./dynamicBountyRuntime\").recoverLosses();\n"));
    const km = read("services", "killmail", "killmailState.js");
    assert.ok(km.includes("    dirty: killmailIndexesDirty,\n    ready: Boolean(killmailIndexes),\n"));
    assert.ok(km.includes("} = require(\"../../abyssal\").engineSupport.hostLocation;"));
    const host = read("abyssal", "domain", "abyssalHostLocation.js");
    assert.ok(!host.includes("require("), "the redaction is a pure function of the ID (fixed range, no state)");
    assert.match(host, /\nconst ABYSSAL_LOCATION_ID_MIN = 32000001;\nconst ABYSSAL_LOCATION_ID_COUNT = 200;\n/);
  });
};
