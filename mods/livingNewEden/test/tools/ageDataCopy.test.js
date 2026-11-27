"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tool = require("../../tools/downtime/ageDataCopy");
const rules = require("../../tools/downtime/ageRules");
const { loadDriver, findServerDir } = require("../../tools/measure/heapGrowthReport");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_DIR = findServerDir(MOD_DIR);
const NOW = 1795000000000;
const H = 3600000;
const D = 86400000;
const DAYS = 30;
const SHIFT = DAYS * D;
const FT_SHIFT = 25920000000000n;
const SEP = "\u001f";
const ESS_SYSTEM = 30000142;
const HUB = 1000000123456;
const ft = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const esc = (s) => String(s).replace(/'/g, "''");

const ESS_DUE = NOW + H;
const ESS_JOB_ID = `ess:${ESS_SYSTEM}:dbs:${NOW - 2 * H}:${ESS_DUE}`;
const SOV_JOB_ID = `sovereignty-campaign:${HUB}:owned-hub:30004711:${HUB}:1790000000000`;

function gamestoreRows(o) {
  return {
    scheduledJobs: [
      [ESS_JOB_ID, { jobID: ESS_JOB_ID, type: "ess.settlement", dueAtMs: ESS_DUE,
        payload: { systemID: ESS_SYSTEM, kind: "dbs", generation: String(NOW - 2 * H) }, state: "running", attempt: 1,
        leaseToken: "t", leaseUntilMs: NOW - 1000, lastError: null, deadLetteredAtMs: 0, createdAtMs: NOW - 2 * H,
        updatedAtMs: NOW - 2 * H }],
      [SOV_JOB_ID, { jobID: SOV_JOB_ID, type: "sovereignty.campaign-tick", dueAtMs: NOW + 5 * H,
        payload: { targetID: HUB, captureEpoch: `owned-hub:30004711:${HUB}:1790000000000`, windowEventMs: NOW + 5 * H },
        state: "pending", attempt: 0, leaseToken: null, leaseUntilMs: 0, createdAtMs: NOW - 3 * H }],
    ],
    dynamicResourceRuntime: [
      [`systems${SEP}${ESS_SYSTEM}`, { systemID: ESS_SYSTEM, autopayAtMs: NOW + H,
        dbs: { activatedAtMs: NOW - 2 * H, nextAtMs: NOW + 30 * 60000, periodIndex: 3 }, nextPulseAtMs: NOW + 2 * H,
        mainBankLink: { linkID: "l1", startedAt: ft(NOW - H), completesAt: ft(NOW + H) },
        reserveBankLastPulseInitiated: "0", durationMs: 360000 }],
    ],
    sovereignty: [
      [`systems${SEP}30004711`, { solarSystemID: 30004711, campaignStartTime: ft(NOW - H),
        structures: [{ itemID: HUB, devFlags: { sovereigntyOwnedHubCapture: { vulnerableStartMs: NOW + 5 * H,
          vulnerableEndMs: NOW + 23 * H, lastUpdatedMs: NOW - H } } }] }],
    ],
    characters: [["140000001", { createdAtMs: NOW - D, balance: 5 }]],
    ...(o.extraTables || {}),
  };
}

const WORLD_DDL = [
  `CREATE TABLE world_scheduled_events (event_id TEXT PRIMARY KEY, due_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL, claimed_at INTEGER, payload TEXT NOT NULL) STRICT`,
  `INSERT INTO world_scheduled_events VALUES ('ev1', ${NOW + H}, ${NOW - H}, NULL, '{"at":${NOW}}')`,
  "CREATE TABLE world_factions (faction_id INTEGER PRIMARY KEY, upkeep_paid_until INTEGER, "
    + "cooldown_until INTEGER NOT NULL DEFAULT 0) STRICT",
  `INSERT INTO world_factions VALUES (500001, ${NOW - H}, 0)`,
  "CREATE TABLE world_faction_treasury (faction_id INTEGER PRIMARY KEY, paid_until INTEGER) STRICT",
  `INSERT INTO world_faction_treasury VALUES (500001, ${NOW - 2 * H})`,
  "CREATE TABLE world_fleets (fleet_id TEXT PRIMARY KEY, arrive_at INTEGER, travel_ms INTEGER, credited_ms INTEGER, "
    + "pin_ms INTEGER) STRICT",
  `INSERT INTO world_fleets VALUES ('f1', ${NOW + H}, 600000, 120000, ${NOW})`,
  "CREATE TABLE world_wrecks (wreck_id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, "
    + "CHECK (expires_at > created_at)) STRICT",
  `INSERT INTO world_wrecks VALUES ('w1', ${NOW}, ${NOW - H})`,
];

function createDb(driver, file, statements) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = driver.open(file, { readOnly: false });
  try {
    for (const sql of statements) db.exec(sql);
  } finally {
    db.close();
  }
}

function makeSrc(driver, dir, o = {}) {
  const gs = [];
  for (const [table, rows] of Object.entries(gamestoreRows(o))) {
    const cols = o.driftTable === table ? "key TEXT PRIMARY KEY, value TEXT NOT NULL"
      : "key TEXT PRIMARY KEY, json TEXT NOT NULL";
    gs.push(`CREATE TABLE "${table}" (${cols})`);
    for (const [key, json] of rows) gs.push(`INSERT INTO "${table}" VALUES ('${esc(key)}', '${esc(JSON.stringify(json))}')`);
  }
  if (o.outboxPending) {
    gs.push("CREATE TABLE _persistence_outbox (operation_id INTEGER PRIMARY KEY, table_name TEXT NOT NULL UNIQUE, "
      + "upserts_json TEXT NOT NULL, state TEXT NOT NULL)");
    gs.push(`INSERT INTO _persistence_outbox VALUES (1, '${o.outboxPending}', '[]', 'pending')`);
  }
  createDb(driver, path.join(dir, "gameStore", "gamestore.sqlite"), gs);
  createDb(driver, path.join(dir, "mods", "livingNewEden", "world.sqlite"), [...WORLD_DDL, ...(o.worldExtra || [])]);
  fs.mkdirSync(path.join(dir, "gameStore", "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "gameStore", "data", "static.json"), "{\"a\":1}\n");
  fs.writeFileSync(path.join(dir, "settings.json"), "{}\n");
  return dir;
}

function hashTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
    }
  };
  walk(dir);
  return out;
}

function readTable(driver, file, sql) {
  const db = driver.open(file, { readOnly: true });
  try {
    return db.all(sql);
  } finally {
    db.close();
  }
}

const vendorRows = (driver, dir, table) => Object.fromEntries(readTable(driver,
  path.join(dir, "gameStore", "gamestore.sqlite"), `SELECT key, json FROM "${table}"`).map((r) => [r.key, r.json]));
const worldRow = (driver, dir, table) => readTable(driver, path.join(dir, "mods", "livingNewEden", "world.sqlite"),
  `SELECT * FROM ${table}`)[0];

function exec(argv, env = {}) {
  const lines = [];
  const code = tool.main(argv, env, { serverDir: SERVER_DIR, now: () => NOW, print: (t) => lines.push(t),
    warn: (t) => lines.push(t) });
  return { code, text: lines.join("\n") };
}

const ageTmpDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("lne-age-")));

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ag-test-"));
  try {
    return fn(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

const read = (rel) => fs.readFileSync(path.join(SERVER_DIR, "src", rel), "utf8");

module.exports = ({ test, skip }) => {
  const driver = loadDriver(SERVER_DIR);
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `no SQLite driver (${driver.detail})`);
  };

  needsDriver("AG1 ageDataCopy --days 30: ms keys and LNE time columns - 30 d, FILETIME - 30 d exact (BigInt "
    + "string), 0 / \"0\" / NULL / durations / generation / row keys / other tables unchanged, src read-only, "
    + "marker, staleIdentity, lneSuspects; --dry-run = the same report, no out, no temp dir left", () => withTmp((tmp) => {
    const src = makeSrc(driver, path.join(tmp, "src"));
    const out = path.join(tmp, "out");
    const before = hashTree(src);
    const jsonFile = path.join(tmp, "age.json");
    const r = exec(["--src", src, "--out", out, "--days", String(DAYS), "--json", jsonFile]);
    assert.strictEqual(r.code, 0, r.text);
    assert.deepStrictEqual(hashTree(src), before, "source files byte for byte unchanged");
    assert.ok(fs.existsSync(path.join(out, tool.MARKER_FILE)), "marker written");
    assert.ok(fs.existsSync(path.join(out, "gameStore", "data", "static.json")), "the whole tree copied");
    const report = JSON.parse(fs.readFileSync(jsonFile, "utf8"));

    const jobs = vendorRows(driver, out, "scheduledJobs");
    assert.deepStrictEqual(Object.keys(jobs).sort(), [ESS_JOB_ID, SOV_JOB_ID].sort(), "row keys / jobIDs unchanged");
    const ess = JSON.parse(jobs[ESS_JOB_ID]);
    assert.deepStrictEqual([ess.jobID, ess.dueAtMs, ess.leaseUntilMs, ess.createdAtMs, ess.updatedAtMs,
      ess.deadLetteredAtMs, ess.payload.generation, ess.attempt],
    [ESS_JOB_ID, ESS_DUE - SHIFT, NOW - 1000 - SHIFT, NOW - 2 * H - SHIFT, NOW - 2 * H - SHIFT, 0, String(NOW - 2 * H), 1]);
    const sov = JSON.parse(jobs[SOV_JOB_ID]);
    assert.deepStrictEqual([sov.dueAtMs, sov.payload.windowEventMs, sov.leaseUntilMs, sov.payload.captureEpoch],
      [NOW + 5 * H - SHIFT, NOW + 5 * H - SHIFT, 0, `owned-hub:30004711:${HUB}:1790000000000`]);

    const bank = JSON.parse(vendorRows(driver, out, "dynamicResourceRuntime")[`systems${SEP}${ESS_SYSTEM}`]);
    assert.deepStrictEqual([bank.autopayAtMs, bank.dbs.activatedAtMs, bank.dbs.nextAtMs, bank.dbs.periodIndex,
      bank.nextPulseAtMs, bank.reserveBankLastPulseInitiated, bank.durationMs, bank.systemID],
    [NOW + H - SHIFT, NOW - 2 * H - SHIFT, NOW + 30 * 60000 - SHIFT, 3, NOW + 2 * H - SHIFT, "0", 360000, ESS_SYSTEM]);
    assert.strictEqual(typeof bank.mainBankLink.completesAt, "string");
    assert.strictEqual(BigInt(bank.mainBankLink.completesAt), BigInt(ft(NOW + H)) - FT_SHIFT);
    assert.strictEqual(BigInt(bank.mainBankLink.startedAt), BigInt(ft(NOW - H)) - FT_SHIFT);

    const sovRow = JSON.parse(vendorRows(driver, out, "sovereignty")[`systems${SEP}30004711`]);
    const cap = sovRow.structures[0].devFlags.sovereigntyOwnedHubCapture;
    assert.deepStrictEqual([cap.vulnerableStartMs, cap.vulnerableEndMs, cap.lastUpdatedMs, sovRow.structures[0].itemID],
      [NOW + 5 * H - SHIFT, NOW + 23 * H - SHIFT, NOW - H - SHIFT, HUB]);
    assert.strictEqual(BigInt(sovRow.campaignStartTime), BigInt(ft(NOW - H)) - FT_SHIFT);
    assert.deepStrictEqual(vendorRows(driver, out, "characters"), vendorRows(driver, src, "characters"),
      "a table outside the list byte for byte unchanged");

    const ev = worldRow(driver, out, "world_scheduled_events");
    assert.deepStrictEqual([Number(ev.due_at), Number(ev.created_at), ev.claimed_at, ev.payload, ev.event_id],
      [NOW + H - SHIFT, NOW - H - SHIFT, null, `{"at":${NOW}}`, "ev1"]);
    const fac = worldRow(driver, out, "world_factions");
    assert.deepStrictEqual([Number(fac.upkeep_paid_until), Number(fac.cooldown_until), Number(fac.faction_id)],
      [NOW - H - SHIFT, 0, 500001]);
    assert.strictEqual(Number(worldRow(driver, out, "world_faction_treasury").paid_until), NOW - 2 * H - SHIFT);
    const fleet = worldRow(driver, out, "world_fleets");
    assert.deepStrictEqual([Number(fleet.arrive_at), Number(fleet.travel_ms), Number(fleet.credited_ms),
      Number(fleet.pin_ms)], [NOW + H - SHIFT, 600000, 120000, NOW]);
    const wreck = worldRow(driver, out, "world_wrecks");
    assert.deepStrictEqual([Number(wreck.expires_at), Number(wreck.created_at)], [NOW - SHIFT, NOW - H - SHIFT],
      "Both columns of a CHECK pair moved in one UPDATE");

    assert.deepStrictEqual(report.jobs.byType["ess.settlement"], { total: 1, dueAfter: 1, staleIdentity: 1 });
    assert.deepStrictEqual(report.jobs.byType["sovereignty.campaign-tick"], { total: 1, dueAfter: 1, staleIdentity: 0 });
    assert.deepStrictEqual(report.lneSuspects, { "world_fleets.pin_ms": 1 });
    assert.deepStrictEqual(report.lne.world_scheduled_events, { due_at: 1, created_at: 1 });
    assert.strictEqual(report.vendor.sovereignty.shifted["structures.*.devFlags.sovereigntyOwnedHubCapture."
      + "vulnerableStartMs"], 1);
    assert.strictEqual(report.vendor.dynamicResourceRuntime.shifted["mainBankLink.completesAt"], 1);
    assert.strictEqual(report.vendor.characters, undefined);
    const text = JSON.stringify(report);
    assert.ok(!text.includes("140000001") && !text.includes(ESS_JOB_ID), "no row keys / IDs in the report");

    const tmpBefore = ageTmpDirs();
    const dryOut = path.join(tmp, "dry-out");
    const dryJson = path.join(tmp, "dry.json");
    const dry = exec(["--src", src, "--out", dryOut, "--days", String(DAYS), "--dry-run", "--json", dryJson]);
    assert.strictEqual(dry.code, 0, dry.text);
    const dr = JSON.parse(fs.readFileSync(dryJson, "utf8"));
    assert.deepStrictEqual([dr.vendor, dr.jobs, dr.lne, dr.lneSuspects, dr.dryRun],
      [report.vendor, report.jobs, report.lne, report.lneSuspects, true]);
    assert.strictEqual(fs.existsSync(dryOut), false);
    assert.deepStrictEqual([...ageTmpDirs()].filter((n) => !tmpBefore.has(n)), [], "no lne-age- dir left");
    assert.deepStrictEqual(hashTree(src), before);
  }));

  needsDriver("AG2 ageDataCopy path refusals before any write: LIVE_DATA_ROOT (src, out inside), LIVE_VOLUME_PATH, "
    + "OUT_EXISTS, PATH_OVERLAP, ALREADY_AGED, --days 0 / 366 / missing -> exit 1", () => withTmp((tmp) => {
    const src = makeSrc(driver, path.join(tmp, "src"));
    const before = hashTree(src);
    const out = path.join(tmp, "out");
    const days = ["--days", String(DAYS)];
    const expect = (argv, env, code, reason) => {
      const r = exec(argv, env);
      assert.strictEqual(r.code, code, `${reason}: ${r.text}`);
      if (reason) assert.ok(r.text.includes(reason), `${reason} in: ${r.text}`);
    };
    expect(["--src", src, "--out", out, ...days], { EVEJS_DATA_ROOT: src }, 2, "LIVE_DATA_ROOT");
    const live = path.join(tmp, "live");
    expect(["--src", src, "--out", path.join(live, "out"), ...days], { EVEJS_DATA_ROOT: live }, 2, "LIVE_DATA_ROOT");
    expect(["--src", "/var/lib/evejs/x", "--out", out, ...days], {}, 2, "LIVE_VOLUME_PATH");
    expect(["--src", src, "--out", "/var/lib/evejs", ...days], {}, 2, "LIVE_VOLUME_PATH");
    const existing = path.join(tmp, "exists");
    fs.mkdirSync(existing);
    expect(["--src", src, "--out", existing, ...days], {}, 2, "OUT_EXISTS");
    expect(["--src", src, "--out", path.join(src, "inner"), ...days], {}, 2, "PATH_OVERLAP");
    const aged = makeSrc(driver, path.join(tmp, "aged"));
    fs.writeFileSync(path.join(aged, tool.MARKER_FILE), "{}\n");
    expect(["--src", aged, "--out", out, ...days], {}, 2, "ALREADY_AGED");
    expect(["--src", src, "--out", out, "--days", "0"], {}, 1, "DAYS_INVALID");
    expect(["--src", src, "--out", out, "--days", "366"], {}, 1, "DAYS_INVALID");
    expect(["--src", src, "--out", out], {}, 1, "--days is required");
    const liveJson = path.join(live, "r.json");
    const srcJson = path.join(src, "r.json");
    expect(["--src", src, "--out", out, ...days, "--json", liveJson], { EVEJS_DATA_ROOT: live }, 2, "LIVE_DATA_ROOT");
    expect(["--src", src, "--out", out, ...days, "--json", "/var/lib/evejs/r.json"], {}, 2, "LIVE_VOLUME_PATH");
    expect(["--src", src, "--out", out, ...days, "--json", srcJson], {}, 2, "PATH_OVERLAP");
    const blocker = path.join(tmp, "blocker.txt");
    fs.writeFileSync(blocker, "x");
    expect(["--src", src, "--out", path.join(blocker, "out"), ...days], {}, 3, "FAILED");
    assert.strictEqual(fs.readFileSync(blocker, "utf8"), "x");
    for (const p of [out, path.join(live, "out"), path.join(src, "inner"), liveJson, srcJson]) {
      assert.strictEqual(fs.existsSync(p), false, p);
    }
    assert.deepStrictEqual(fs.readdirSync(existing), []);
    assert.deepStrictEqual(hashTree(src), before);
  }));

  needsDriver("AG3 ageDataCopy refusals on the copy: OUTBOX_PENDING (exit 2), SCHEMA_DRIFT (exit 3), CHECK_FAILED "
    + "with the table name (exit 3); out removed each time", () => withTmp((tmp) => {
    const cases = [
      ["OUTBOX_PENDING", 2, { outboxPending: "scheduledJobs" }],
      ["SCHEMA_DRIFT", 3, { driftTable: "scheduledJobs" }],
      ["CHECK_FAILED", 3, { worldExtra: [
        "CREATE TABLE world_checked (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, "
          + "CHECK (due_at >= created_at)) STRICT",
        `INSERT INTO world_checked VALUES ('c1', ${rules.MIN_EPOCH_MS - 1}, ${rules.MIN_EPOCH_MS + D})`] }],
    ];
    for (const [reason, code, o] of cases) {
      const src = makeSrc(driver, path.join(tmp, `src-${reason}`), o);
      const before = hashTree(src);
      const out = path.join(tmp, `out-${reason}`);
      const r = exec(["--src", src, "--out", out, "--days", String(DAYS)]);
      assert.strictEqual(r.code, code, `${reason}: ${r.text}`);
      assert.ok(r.text.includes(reason), r.text);
      if (reason === "CHECK_FAILED") assert.ok(r.text.includes("world_checked"), r.text);
      assert.strictEqual(fs.existsSync(out), false, `${reason}: out removed`);
      assert.deepStrictEqual(hashTree(src), before);
    }
    assert.deepStrictEqual(rules.shiftJson({ aMs: rules.MIN_EPOCH_MS - 1, b: "0", c: null }, SHIFT,
      { onShift() {}, onSuspect() {} }), { value: { aMs: rules.MIN_EPOCH_MS - 1, b: "0", c: null }, changed: 0 });
  }));

  const facts = (name, fn) => {
    if (SERVER_DIR && fs.existsSync(path.join(SERVER_DIR, "src"))) test(name, fn);
    else skip(name, "server/ not found");
  };
  facts("AG4 vendor and LNE facts the aging rules rely on (source text): scheduledJobs fields, key/json tables, "
    + "row groups, FILETIME offset, Ms names, LNE time columns by the rule, no CREATE TRIGGER in lib", () => {
    const worker = read(path.join("services", "scheduler", "durableSchedulerProcess.worker.js"));
    assert.ok(worker.includes("TABLE_NAME = \"scheduledJobs\""));
    for (const f of ["dueAtMs", "leaseUntilMs", "deadLetteredAtMs"]) assert.ok(worker.includes(f), f);
    const store = read(path.join("gameStore", "sqliteStore.js"));
    assert.ok(store.includes("(key TEXT PRIMARY KEY, json TEXT NOT NULL)"));
    assert.ok(store.includes("dynamicResourceRuntime: [") && store.includes("sovereignty: ["));
    assert.ok(read(path.join("services", "dynamic", "dynamicResourceState.js")).includes("116444736000000000n"));
    assert.strictEqual(rules.FILETIME_UNIX_OFFSET, 116444736000000000n);
    const vendorText = [
      read(path.join("services", "dynamic", "essSettlementRuntime.js")),
      read(path.join("services", "dynamic", "dynamicBountyRuntime.js")),
      read(path.join("services", "dynamic", "essReserveRuntime.js")),
      read(path.join("services", "sovereignty", "sovCampaignState.js")),
    ].join("\n");
    for (const n of ["autopayAtMs", "nextAtMs", "activatedAtMs", "nextPulseAtMs", "dbsInputAtMs", "vulnerableStartMs",
      "reinforcementExitMs"]) {
      assert.ok(vendorText.includes(n), n);
      assert.ok(n.endsWith("Ms"), `${n} matches the Ms rule`);
    }
    const lib = (rel) => fs.readFileSync(path.join(MOD_DIR, "lib", rel), "utf8");
    const declared = (text, col) => new RegExp(`\\b${col}\\s+INTEGER`).test(text);
    for (const [rel, col] of [["scheduler/schema.js", "due_at"], ["economy/treasury/schema.js", "paid_until"],
      ["strategy/schema.js", "upkeep_paid_until"]]) {
      assert.ok(declared(lib(rel), col), `${rel} ${col}`);
      assert.ok(rules.isLneTimeColumn(col, "INTEGER"), col);
    }
    for (const col of ["travel_ms", "credited_ms", "pin_ms"]) assert.strictEqual(rules.isLneTimeColumn(col, "INTEGER"), false, col);
    let triggers = 0;
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js") && fs.readFileSync(p, "utf8").includes("CREATE TRIGGER")) triggers += 1;
      }
    };
    walk(path.join(MOD_DIR, "lib"));
    assert.strictEqual(triggers, 0, "no CREATE TRIGGER in lib");
  });
};
