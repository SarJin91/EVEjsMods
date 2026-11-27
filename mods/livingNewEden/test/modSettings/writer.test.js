"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SCHEMA, resolveConfig } = require("../../config");
const { overridePathOf, readOverrideFile, writeOverrideFileAtomic } = require("../../lib/modSettings/overrideFile");
const { AUDIT_FILE_NAME, auditPathOf, createAudit } = require("../../lib/modSettings/audit");
const { COUNTER_NAMES, createWriter } = require("../../lib/modSettings/writer");
const { createLocks, SHIP_WING_LOCKS } = require("../../lib/modSettings/locks");
const { createLneProvider } = require("../../lib/modSettings/providers/lne");
const { startModSettings } = require("../../lib/modSettings");
const { createRegistry, isMetricName } = require("../../lib/telemetry/registry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SHIP_WING_DIR = path.resolve(MOD_DIR, "..", "shipWing");
const NOW_MS = 1700000000000;
const ACTOR = Object.freeze({ characterId: 90000001, characterName: "Pilot\nOne", channel: "web" });

function withDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-modsettings-w-"));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function fakeAdapter() {
  return {
    listLoadedModDirs: () => ({ ok: true, dirs: Object.freeze(["livingNewEden", "shipWing"]) }),
    loadModConfig: (dir) => (dir === "shipWing"
      ? { ok: true, exports: require(path.join(SHIP_WING_DIR, "config.js")), modDir: SHIP_WING_DIR }
      : { ok: false, reason: "CONFIG_MISSING" }),
  };
}

function started(dir, extra = {}) {
  const env = { EVEJS_DATA_ROOT: dir };
  const lneDir = path.join(dir, "mods", "livingNewEden");
  const base = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR }).config;
  const config = { ...base, dataDir: lneDir, modSettings: { ...base.modSettings, enabled: true,
    mods: "livingNewEden,shipWing,npcKillsGiveSp", auditMaxBytes: extra.auditMaxBytes || 1048576 } };
  const registry = createRegistry({ histogramSamples: 8, maxMetrics: 64 });
  const lines = [];
  const r = startModSettings({ config, adapter: fakeAdapter(), env, modDir: MOD_DIR, clock: { now: () => NOW_MS },
    telemetry: registry, logger: { log: (line) => lines.push(line) } });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { ms: r.modSettings, registry, lines, env, lneDir, swDir: path.join(dir, "mods", "shipWing"),
    auditFile: auditPathOf(lneDir) };
}

function auditLines(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter((l) => l !== "").map(JSON.parse) : [];
}

function rowOf(key) {
  return SCHEMA.find((r) => r.key === key);
}

module.exports = ({ test }) => {
  test("MW1 writer refusals: one case per reason, never a write, writeRejected counted", () => withDir((dir) => {
    const s = started(dir);
    const set = (modId, key, value, expectedRevision = 0) => s.ms.set({ modId, key, value, expectedRevision,
      actor: ACTOR });
    const journalMax = rowOf("observer.journalLimit").max;
    const cases = [
      ["UNKNOWN_MOD", set("noSuchMod", "enabled", true)],
      ["NO_PROVIDER", set("npcKillsGiveSp", "enabled", true)],
      ["UNKNOWN_KEY", set("livingNewEden", "no.such.key", 1)],
      ["LOCKED", set("livingNewEden", "observer.port", 26412)],
      ["BAD_TYPE", set("livingNewEden", "observer.journalLimit", "60")],
      ["OUT_OF_RANGE", set("livingNewEden", "observer.journalLimit", journalMax + 1)],
      ["BAD_VALUE", set("shipWing", "droneDefaultMode", "always")],
      ["BAD_VALUE", set("shipWing", "hpCriticalPct", 95)],
      ["STALE_REVISION", set("livingNewEden", "observer.journalLimit", 60, 3)],
      ["CONFIG_ERROR", set("livingNewEden", "persistence.maxRowsPerTransaction", 50)],
    ];
    for (const [reason, r] of cases) assert.deepStrictEqual([r.ok, r.reason], [false, reason], JSON.stringify(r));
    assert.strictEqual(cases[3][1].detail, "BOOT_CRITICAL");
    assert.ok(cases[7][1].detail.includes("hpCriticalPct"), cases[7][1].detail);
    assert.strictEqual(cases[8][1].revision, 0);
    assert.ok(cases[9][1].detail.includes("battle.settleRowsReserve"), cases[9][1].detail);
    assert.strictEqual(s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 60, actor: ACTOR })
      .reason, "STALE_REVISION", "expectedRevision is required");
    assert.ok(!fs.existsSync(overridePathOf(s.lneDir)) && !fs.existsSync(overridePathOf(s.swDir)), "no write");
    assert.ok(!fs.existsSync(s.auditFile), "no audit");
    assert.strictEqual(s.registry.counter("modSettings.writeRejected"), cases.length + 1);

    fs.mkdirSync(s.lneDir, { recursive: true });
    fs.writeFileSync(overridePathOf(s.lneDir), "{broken");
    const broken = set("livingNewEden", "observer.journalLimit", 60);
    assert.deepStrictEqual([broken.ok, broken.reason], [false, "WRITE_FAILED"]);
    assert.strictEqual(fs.readFileSync(overridePathOf(s.lneDir), "utf8"), "{broken");
    fs.rmSync(overridePathOf(s.lneDir));

    const provider = createLneProvider({ env: s.env, modDir: MOD_DIR, config: { dataDir: s.lneDir } }).provider;
    const audits = [];
    const failing = { ...fs, renameSync: () => { throw Object.assign(new Error("x"), { code: "EPERM" }); } };
    const w = createWriter({ entryOf: () => ({ provider, running: {}, reason: null }), env: s.env,
      audit: { append: (rec) => audits.push(rec) && { ok: true } }, fsApi: failing });
    const failed = w.setSetting({ modId: "livingNewEden", key: "observer.journalLimit", value: 60,
      expectedRevision: 0, actor: ACTOR });
    assert.deepStrictEqual(failed, { ok: false, reason: "WRITE_FAILED", detail: "settings.override.json: EPERM" });
    assert.deepStrictEqual([fs.existsSync(overridePathOf(s.lneDir)), fs.existsSync(`${overridePathOf(s.lneDir)}.tmp`),
      audits.length], [false, false, 0]);
    const killed = createWriter({ entryOf: () => ({ provider, running: {}, reason: null }),
      env: { EVEJS_MOD_SETTINGS_OVERRIDES_IGNORE: "1" } }).setSetting({ modId: "livingNewEden",
      key: "observer.journalLimit", value: 60, expectedRevision: 0, actor: ACTOR });
    assert.deepStrictEqual([killed.ok, killed.reason], [false, "CONFIG_ERROR"]);
    assert.deepStrictEqual(createWriter({ entryOf: () => { throw new Error("boom"); } }).setSetting({ modId: "x" }),
      { ok: false, reason: "WRITE_FAILED", detail: "boom" }, "never throws");
  }));

  test("MW2 set: atomic write, fresh read, revision +1, updatedAtMs/updatedBy, changed:false without write or audit, "
    + "pending, new warnings, a stale .tmp is harmless", () => withDir((dir) => {
    const s = started(dir);
    const file = overridePathOf(s.lneDir);
    fs.mkdirSync(s.lneDir, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, "{left over");
    const r1 = s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 60, expectedRevision: 0,
      actor: ACTOR });
    assert.deepStrictEqual(r1, { ok: true, changed: true, revision: 1, apply: "restart", pending: true, warnings: [] });
    assert.ok(!fs.existsSync(`${file}.tmp`), "the .tmp is renamed over the file");
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual(doc, { schemaVersion: 1, revision: 1, updatedAtMs: NOW_MS, updatedBy: 90000001,
      values: { "observer.journalLimit": 60 } });
    const read = readOverrideFile(file, {});
    assert.deepStrictEqual([read.values, read.revision, read.warnings], [{ "observer.journalLimit": 60 }, 1, []]);
    const page = s.ms.describe("livingNewEden", { q: "observer.journallimit" });
    assert.deepStrictEqual([page.rows[0].next, page.rows[0].pending, page.overrideFile.revision], [60, true, 1]);

    const same = s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 60, expectedRevision: 1,
      actor: ACTOR });
    assert.deepStrictEqual(same, { ok: true, changed: false, revision: 1, apply: "restart", pending: true, warnings: [] });
    assert.strictEqual(auditLines(s.auditFile).length, 1, "changed:false = no audit");
    assert.strictEqual(readOverrideFile(file, {}).revision, 1, "changed:false = no write");

    const back = s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 50, expectedRevision: 1,
      actor: ACTOR });
    assert.deepStrictEqual([back.changed, back.revision, back.pending], [true, 2, false], "50 = the running value");
    fs.writeFileSync(`${file}.tmp`, "{left over again");
    assert.deepStrictEqual(readOverrideFile(file, {}).values, { "observer.journalLimit": 50 }, "the .tmp is never read");

    writeOverrideFileAtomic(file, { schemaVersion: 1, revision: 7, values: { "observer.journalLimit": 70 } });
    assert.strictEqual(s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 80, expectedRevision: 2,
      actor: ACTOR }).reason, "STALE_REVISION");
    const sw = s.ms.set({ modId: "shipWing", key: "clientWindowPollMs", value: 500, expectedRevision: 0, actor: ACTOR });
    assert.deepStrictEqual([sw.ok, sw.changed, sw.revision, sw.warnings], [true, true, 1,
      ["clientWindowPollMs raised to 1000"]], JSON.stringify(sw));
    assert.deepStrictEqual(readOverrideFile(overridePathOf(s.swDir), {}).values, { clientWindowPollMs: 500 });
    assert.ok(s.lines.includes("modSettings: livingNewEden.observer.journalLimit set by Pilot One (90000001, web) "
      + "revision 1 (restart)"), s.lines.join("\n"));
    assert.strictEqual(s.registry.counter("modSettings.writes"), 3);
    s.ms.stop("test");
    assert.deepStrictEqual(s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 1,
      expectedRevision: 7 }), { ok: false, reason: "STOPPED" });
  }));

  test("MW3 reset: removes the key (an empty map stays a file), also a locked or unknown key of the file; a key not "
    + "in the file = changed:false / LOCKED / UNKNOWN_KEY", () => withDir((dir) => {
    const s = started(dir);
    const file = overridePathOf(s.lneDir);
    writeOverrideFileAtomic(file, { schemaVersion: 1, revision: 4, values: { "observer.journalLimit": 60,
      "chatterAi.baseUrl": "https://evil.example/", "old.removed.key": 1 } });
    const reset = (key, expectedRevision) => s.ms.reset({ modId: "livingNewEden", key, expectedRevision, actor: ACTOR });
    assert.strictEqual(reset("observer.journalLimit", 3).reason, "STALE_REVISION");
    assert.deepStrictEqual(reset("observer.journalLimit", 4), { ok: true, changed: true, revision: 5, apply: "restart",
      pending: false, warnings: [] });
    const locked = reset("chatterAi.baseUrl", 5);
    assert.deepStrictEqual([locked.ok, locked.changed, locked.revision], [true, true, 6], JSON.stringify(locked));
    assert.deepStrictEqual([reset("old.removed.key", 6).changed, readOverrideFile(file, {}).revision], [true, 7]);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepStrictEqual([doc.values, doc.revision], [{}, 7], "an empty map stays as a file");
    assert.deepStrictEqual(reset("observer.journalLimit", 7), { ok: true, changed: false, revision: 7,
      apply: "restart", pending: false, warnings: [] });
    assert.deepStrictEqual([reset("observer.port", 7).reason, reset("old.removed.key", 7).reason],
      ["LOCKED", "UNKNOWN_KEY"]);
    const audit = auditLines(s.auditFile);
    assert.deepStrictEqual(audit.map((a) => [a.key, a.action, a.before, a.after, a.revision]), [
      ["observer.journalLimit", "reset", 60, 50, 5],
      ["chatterAi.baseUrl", "reset", "***", "***", 6],
      ["old.removed.key", "reset", null, null, 7]]);
    assert.ok(!fs.readFileSync(s.auditFile, "utf8").includes("evil"), "no value of a locked row in the audit");
    assert.strictEqual(s.registry.counter("modSettings.resets"), 3);
  }));

  test("MW4 audit: the record after the rename, rotation to.1 (old.1 removed), auditFailed", () =>
    withDir((dir) => {
      const s = started(dir);
      s.ms.set({ modId: "livingNewEden", key: "observer.journalLimit", value: 60, expectedRevision: 0, actor: ACTOR });
      const [rec] = auditLines(s.auditFile);
      assert.strictEqual(path.basename(s.auditFile), AUDIT_FILE_NAME);
      assert.deepStrictEqual(rec, { atMs: NOW_MS, characterId: 90000001, characterName: "Pilot One", channel: "web",
        mod: "livingNewEden", key: "observer.journalLimit", action: "set", before: 50, after: 60, revision: 1,
        apply: "restart" });

      const file = path.join(dir, "rot", AUDIT_FILE_NAME);
      const a = createAudit({ filePath: file, maxBytes: 40 });
      assert.deepStrictEqual(a.append({ n: 1, pad: "x".repeat(40) }), { ok: true, rotated: false });
      assert.deepStrictEqual(a.append({ n: 2 }), { ok: true, rotated: true });
      assert.deepStrictEqual([auditLines(`${file}.1`).map((r) => r.n), auditLines(file).map((r) => r.n)], [[1], [2]]);
      a.append({ n: 3, pad: "y".repeat(40) });
      assert.deepStrictEqual(a.append({ n: 4 }), { ok: true, rotated: true });
      assert.deepStrictEqual([auditLines(`${file}.1`).map((r) => r.n), auditLines(file).map((r) => r.n)], [[2, 3], [4]],
        "the old .1 is removed: two files at most");
      const bad = createAudit({ filePath: file, maxBytes: 1e9, fsApi: { ...fs, appendFileSync: () => {
        throw Object.assign(new Error("x"), { code: "ENOSPC" });
      } } });
      assert.deepStrictEqual(bad.append({ n: 5 }), { ok: false, reason: "AUDIT_FAILED",
        detail: "settings-audit.jsonl: ENOSPC" });

      const provider = createLneProvider({ env: s.env, modDir: MOD_DIR, config: { dataDir: s.lneDir } }).provider;
      const registry = createRegistry({ histogramSamples: 8, maxMetrics: 16 });
      const lines = [];
      const w = createWriter({ entryOf: () => ({ provider, running: {}, reason: null }), env: s.env,
        audit: { append: () => ({ ok: false, reason: "AUDIT_FAILED" }) }, telemetry: registry,
        log: (l) => lines.push(l) });
      const r = w.setSetting({ modId: "livingNewEden", key: "observer.journalLimit", value: 70, expectedRevision: 1,
        actor: ACTOR });
      assert.deepStrictEqual([r.ok, r.changed, r.revision, r.auditFailed], [true, true, 2, true]);
      assert.strictEqual(readOverrideFile(overridePathOf(s.lneDir), {}).values["observer.journalLimit"], 70);
      assert.strictEqual(registry.counter("modSettings.auditFailed"), 1);
      assert.ok(lines[0].endsWith(" - audit failed"), lines[0]);
      for (const name of COUNTER_NAMES) assert.ok(isMetricName(`modSettings.${name}`), name);
      assert.deepStrictEqual([s.registry.rejectedNames(), registry.rejectedNames()], [[], []], "no BAD_NAME");
    }));

  test("MW5 shipWing (): no row of the shipWing SCHEMA is locked while its config does not refuse "
    + "locked keys on read", () => {
    const { SCHEMA: SW_SCHEMA } = require(path.join(SHIP_WING_DIR, "config.js"));
    const locks = createLocks(SHIP_WING_LOCKS);
    assert.ok(SW_SCHEMA.length > 0);
    assert.deepStrictEqual(SW_SCHEMA.filter((row) => locks.locked(row).locked).map((row) => row.key), [],
      "a locked shipWing row needs the read-side refusal of LNE config.js in mods/shipWing/config.js first");
  });

  test("MW6 review: a file value the parser drops is BAD_VALUE, not changed:false; a throw "
    + "after the rename keeps ok:true with the new revision", () => withDir((dir) => {
    const s = started(dir);
    writeOverrideFileAtomic(overridePathOf(s.swDir), { schemaVersion: 1, revision: 2, values: { hpCriticalPct: 95 } });
    const dropped = s.ms.set({ modId: "shipWing", key: "hpCriticalPct", value: 95, expectedRevision: 2, actor: ACTOR });
    assert.deepStrictEqual([dropped.ok, dropped.reason], [false, "BAD_VALUE"], JSON.stringify(dropped));
    assert.strictEqual(readOverrideFile(overridePathOf(s.swDir), {}).revision, 2, "no write");

    const provider = createLneProvider({ env: s.env, modDir: MOD_DIR, config: { dataDir: s.lneDir } }).provider;
    const w = createWriter({ entryOf: () => ({ provider, running: {}, reason: null }), env: s.env,
      audit: { append: () => { throw new Error("disk gone"); } } });
    const r = w.setSetting({ modId: "livingNewEden", key: "observer.journalLimit", value: 60, expectedRevision: 0,
      actor: ACTOR });
    assert.deepStrictEqual([r.ok, r.changed, r.revision, r.auditFailed], [true, true, 1, true], JSON.stringify(r));
    assert.ok(r.warnings.includes("saved at revision 1; a step after the write failed - disk gone"), r.warnings);
    assert.strictEqual(readOverrideFile(overridePathOf(s.lneDir), {}).revision, 1);
  }));
};
