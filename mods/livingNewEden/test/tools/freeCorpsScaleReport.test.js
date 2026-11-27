"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { sampleLoop } = require("../../tools/scalingBench");
const { createFetcher } = require("../../tools/measure/freeCorpsScaleReport");
const { extractRow } = require("../../tools/measure/freeCorpsScale/extract");
const { THRESHOLDS, summarize, verdict, recommend, parseDockerStats, withThreshold } =
  require("../../tools/measure/freeCorpsScale/aggregate");
const { runCensus } = require("../../tools/measure/freeCorpsScale/census");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const H = 3600000;
const EVERY_S = 300;
const MB = 1024 * 1024;
const GIB = 1024 * MB;

const FLAGS_CORE = Object.freeze({ "freeCorps.enabled": true, "freeCorps.ventures.enabled": true,
  "freeCorps.local.enabled": true, "freeCorps.map.enabled": true, "freeCorps.chatter.enabled": true,
  "freeCorps.wormholes.enabled": true, "freeCorps.hunting.enabled": false, "freeCorps.wars.enabled": false,
  "freeCorps.killmails.enabled": false, "localPilots.enabled": true });
const SETTINGS = Object.freeze({ "freeCorps.targetCorps": 60, "limits.maxVirtualFleets": 1000,
  "capsuleers.minFleetHeadroom": 150, "capsuleers.maxFleetsTotal": 36, "virtualCorps.ownerCharacterBudget": 2048 });

function hist(prefix, h) {
  return { [`${prefix}.samples`]: h.samples, [`${prefix}.spanMs`]: h.spanMs, [`${prefix}.p95`]: h.p95,
    [`${prefix}.max`]: h.max, ...(h.avg === undefined ? {} : { [`${prefix}.avg`]: h.avg }) };
}

function segment(startedAtMs, hours, opts = {}) {
  const rows = [];
  const flags = opts.flags || FLAGS_CORE;
  const n = Math.round((hours * 3600) / EVERY_S);
  for (let i = 0; i <= n; i += 1) {
    const up = i * EVERY_S;
    const r = { type: "row", seq: i + 1, capturedAtMs: startedAtMs + up * 1000, startedAtMs,
      "process.uptimeSeconds": up, "process.rssBytes": 3 * GIB, "process.heap.afterMajor.lastUsedBytes": 500 * MB + i * 1000,
      ...hist("tick.intervalMs", { samples: 3000, spanMs: 299000, p95: 100, max: 150 }),
      "tick.sceneCount": 1,
      ...hist("persistence.checkpoint.ms", { samples: 50, spanMs: 299000, p95: 5, max: 9 }),
      ...hist("persistence.checkpoint.frames", { samples: 100, spanMs: 299000, avg: 500, p95: 900, max: 1000 }),
      "journal.conflicts": 0, "telemetry.rejectedMetrics": 0, "governor.counts.emergencySamples": 0,
      "channels.governor.modeChanges": 1,
      ...hist("channels.freeCorps.passMs", { samples: 3000, spanMs: 4 * H, p95: opts.passP95 || 3, max: 15 }),
      ...hist("channels.virtualCorps.freeSagaSliceMs",
        { samples: 50, spanMs: 4 * H, p95: opts.sagaP95 || 10, max: opts.sagaMax || 100 }),
      "channels.virtualCorps.seedMs.max": 1200,
      "channels.freeCorps.open": 60, "channels.freeCorps.founding": 0,
      "channels.freeCorps.passes": i * 60, "channels.freeCorps.ventureSteps": i * 10, "channels.freeCorps.passFailed": 0,
      "channels.freeCorps.founded": opts.foundedStep ? i * opts.foundedStep : 5,
      ...(opts.noCapsuleerFleets ? {} : { "channels.capsuleers.fleets": 30 }), "fleets.active": opts.fleetsActive || 500,
      "status.overall": "ok", "status.services.freeCorps.state": "running", alarms: [], viewErrors: 0 };
    for (const [k, v] of Object.entries(flags)) r[`status.flags.${k}`] = v;
    for (const [k, v] of Object.entries(SETTINGS)) r[`status.settings.${k}`] = v;
    rows.push(r);
  }
  return rows;
}

const CENSUS = (free) => ({ tool: "freeCorpsScaleReport", identities: { rows: [
  { ownerKind: "capsuleer", kind: "character", state: "linked", n: 60 },
  { ownerKind: "civilian", kind: "character", state: "linked", n: 400 },
  { ownerKind: "free", kind: "character", state: "linked", n: free },
  { ownerKind: "free", kind: "corporation", state: "linked", n: 60 },
  { ownerKind: "faction", kind: "character", state: "linked", n: 900 }] } });

const DOCKER_START = "evejs-init-1 0B / 0B 0.00%\nevejs-server-1 3.2GiB / 11.68GiB 10.5%\n";
const DOCKER_END = "evejs-server-1 6.1GiB / 11.68GiB 25.0%\n";

function input(over = {}) {
  const a = segment(T0, 10, over);
  const b = segment(T0 + 10 * H + 10 * 60000, 13, over);
  return { rows: [...a, ...b], headers: [{ everyS: EVERY_S }, { everyS: EVERY_S }], footers: [{ readErrors: 1 }],
    censusStart: CENSUS(250), censusEnd: CENSUS(300), dockerStart: DOCKER_START, dockerEnd: DOCKER_END,
    logText: "server  | freeCorps: running\n", audit: null, ...(over.input || {}) };
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

module.exports = ({ test, skip }) => {
  test("FCS1 freeCorpsScale: start GO over 2 segments, counterDelta across the restart, NEXT S1", () => {
    const s = summarize(input());
    assert.strictEqual(s.restarts, 1);
    assert.strictEqual(s.coverage.measuredHours, 22);
    assert.strictEqual(s.coverage.steadyHours, 22);
    assert.strictEqual(s.measuredRows, (121 - 6) + (157 - 6));
    assert.strictEqual(s.counters["channels.freeCorps.ventureSteps"].delta, (120 - 6) * 10 + (156 - 6) * 10);
    assert.strictEqual(s.counters["channels.freeCorps.kmDone"].delta, null, "absent counter = null");
    assert.strictEqual(s.histograms.passMs.p95Worst, 3);
    assert.strictEqual(s.histograms.killmailCallMs.state, "NO_DATA");
    assert.strictEqual(s.identities.end.owners, 760);
    assert.strictEqual(s.rss.containerEndBytes, 6.1 * GIB);
    assert.strictEqual(s.readErrors, 1);
    const v = verdict(s, { target: "start", phase: "core", step: "S0" });
    assert.deepStrictEqual(v.lines.filter((l) => l.startsWith("FAIL")), []);
    assert.strictEqual(v.verdict, "GO", v.lines.join("\n"));
    assert.strictEqual(v.gates.G9.status, "N/A");
    assert.ok(v.gates.G0.lines.some((l) => l.includes("no --audit")));
    const rec = recommend(s, v, { step: "S0" });
    assert.strictEqual(rec.action, "NEXT");
    assert.strictEqual(rec.next, "S1");
    assert.deepStrictEqual(rec.env, ["EVEJS_LNE_FREE_CORPS_TARGET_CORPS=150"]);
    assert.deepStrictEqual(summarize(input()), s);

    const s3 = summarize(input({ fleetsActive: 800 }));
    const v3 = verdict(s3, { target: "start", step: "S3" });
    assert.strictEqual(v3.verdict, "GO", v3.lines.join("\n"));
    const r3 = recommend(s3, v3, { step: "S3" });
    assert.strictEqual(r3.action, "HOLD");
    assert.strictEqual(r3.next, null);
    assert.ok(r3.lines.includes("ENTRY S4 not met: fleets.active max in S3 800 > 790"), r3.lines.join("\n"));
    const { entry, ...noEntry } = v3;
    assert.strictEqual(entry.ok, false);
    assert.strictEqual(recommend(s3, noEntry, { step: "S3" }).action, "HOLD", "computed without verdict.entry");
    const wt = withThreshold(THRESHOLDS, "entry.S4.fleetsActiveMax=800");
    assert.strictEqual(wt.ok, true);
    const r3t = recommend(s3, verdict(s3, { target: "start", step: "S3", thresholds: wt.thresholds }), { step: "S3" });
    assert.strictEqual(r3t.action, "NEXT");
    assert.strictEqual(r3t.next, "S4");
    const r2 = recommend(s, verdict(s, { target: "start", phase: "core", step: "S1" }), { step: "S1" });
    assert.strictEqual(r2.next, "S2");
    assert.ok(r2.lines.some((l) => l.startsWith("ENTRY S2: no GO for phase full")), r2.lines.join("\n"));
  });

  test("FCS2 freeCorpsScale: flag on without a metric = FAIL, off = N/A, short coverage / no docker end = INCOMPLETE",
    () => {
      const on = summarize(input({ flags: { ...FLAGS_CORE, "freeCorps.killmails.enabled": true } }));
      const va = verdict(on, { target: "start" });
      assert.strictEqual(va.verdict, "NO_GO");
      assert.strictEqual(va.gates.G9.status, "FAIL");
      assert.ok(va.lines.some((l) => l.startsWith("FAIL G9 freeCorps.killmailCallMs no data")), va.lines.join("\n"));
      const vb = verdict(summarize(input()), { target: "start" });
      assert.strictEqual(vb.gates.G9.status, "N/A");
      const short = summarize({ ...input(), rows: segment(T0, 15.5) });
      const vc = verdict(short, { target: "start" });
      assert.strictEqual(vc.verdict, "INCOMPLETE");
      assert.ok(vc.missing.some((m) => m.startsWith("steady-state coverage 15 h < 20 h")), vc.missing.join("\n"));
      const vd = verdict(summarize({ ...input(), dockerEnd: null }), { target: "start" });
      assert.strictEqual(vd.verdict, "INCOMPLETE");
      assert.ok(vd.missing.some((m) => m.includes("--docker-end")), vd.missing.join("\n"));
      assert.strictEqual(recommend(null, vd, { step: "S0" }).action, "REPEAT");
      const noGauge = { noCapsuleerFleets: true };
      const ve = verdict(summarize(input({ ...noGauge, flags: { ...FLAGS_CORE, "capsuleers.fleetBudgetEnabled": true } })),
        { target: "start" });
      assert.strictEqual(ve.gates.G8.status, "FAIL");
      assert.ok(ve.lines.some((l) => l.startsWith("FAIL G8 capsuleers.fleets no data")), ve.lines.join("\n"));
      assert.strictEqual(verdict(summarize(input(noGauge)), { target: "start" }).gates.G8.status, "PASS");
    });

  test("FCS3 freeCorpsScale: stretch NO_GO on passMs and saga, HOLD with the G4 row; --early 2.5 h -> ABORT", () => {
    const s = summarize(input({ passP95: 7, sagaP95: 900, sagaMax: 1900 }));
    const v = verdict(s, { target: "stretch", step: "S1" });
    assert.strictEqual(v.verdict, "NO_GO");
    assert.ok(v.lines.includes("FAIL G2 freeCorps.passMs p95 7 > 6 ms"), v.lines.join("\n"));
    assert.ok(v.lines.includes("FAIL G4 virtualCorps.freeSagaSliceMs p95 900 > 20 ms"), v.lines.join("\n"));
    const rec = recommend(s, v, { step: "S1" });
    assert.strictEqual(rec.action, "HOLD");
    assert.deepStrictEqual(rec.rows.map((r) => r.gate), ["G2", "G4"]);
    assert.ok(rec.rows[1].cause.includes("reserveCharacterID"));
    assert.ok(rec.lines.some((l) => l.startsWith("ROLLBACK: restore the env of step S0")));

    const early = summarize({ rows: segment(T0, 3, { sagaP95: 900, foundedStep: 1 }), headers: [{ everyS: EVERY_S }] });
    assert.strictEqual(early.coverage.measuredHours, 2.5);
    const ve = verdict(early, { target: "stretch", step: "S1", early: true });
    assert.strictEqual(ve.verdict, "ABORT");
    assert.ok(ve.lines.some((l) => l.startsWith("ABORT saga freeSagaSliceMs p95 900 > 20 ms")), ve.lines.join("\n"));
    assert.strictEqual(recommend(early, ve, { step: "S1" }).action, "HOLD");
  });

  test("FCS4 freeCorpsScale: sampler with a fake fetch; without new deps the scalingBench header", async () => {
    const snap = (seq) => ({ schemaVersion: 1, seq, capturedAtMs: T0 + seq, startedAtMs: T0,
      process: { uptimeSeconds: 100 }, channels: { freeCorps: { open: 3, passMs: { samples: 4, spanMs: 9, p95: 2,
        max: 3 } } } });
    const tele = [snap(1), snap(1), null, snap(2)];
    let teleCall = 0;
    const json = (status, body) => ({ status, json: async () => body });
    const env = (id, data) => ({ ok: true, id, data });
    const fakeFetch = async (url) => {
      if (url.endsWith("/api/views/telemetry")) {
        const s = tele[teleCall];
        teleCall += 1;
        if (s === null) throw new Error("ECONNREFUSED");
        return json(200, env("telemetry", { available: true, snapshot: s }));
      }
      if (url.endsWith("/api/views/status")) {
        return json(200, env("status", { overall: "ok", services: { services: [{ name: "freeCorps", state: "running" }] },
          config: { values: { freeCorps: { enabled: true, targetCorps: 60 } } } }));
      }
      if (url.endsWith("/api/views/fleets")) return json(200, env("fleets", { available: true, fleets: { active: 7, limit: 1000 } }));
      return json(503, {});
    };
    let t = 0;
    const fetcher = createFetcher({ fetch: fakeFetch, baseUrl: "http://x", viewsEveryMs: 1800000, now: () => t,
      timeoutSignal: () => undefined, timeoutMs: 10000 });
    const lines = [];
    const out = await sampleLoop({ appendLine: (l) => lines.push(JSON.parse(l)), now: () => t,
      sleep: async (ms) => { t += ms; }, file: "http://x", everyMs: 300000, durationMs: 900000,
      header: { label: "s0", baseUrl: "http://x", everyS: 300, viewsEveryS: 1800 }, extract: extractRow,
      readSnapshot: () => fetcher.readSnapshot(), tool: "freeCorpsScaleReport" });
    assert.deepStrictEqual({ rows: out.rows, readErrors: out.readErrors, unchangedReads: out.unchangedReads },
      { rows: 2, readErrors: 1, unchangedReads: 1 });
    assert.strictEqual(lines[0].tool, "freeCorpsScaleReport");
    assert.strictEqual(lines[0].everyS, 300);
    const [r1, r2] = lines.filter((l) => l.type === "row");
    assert.strictEqual(r1["channels.freeCorps.passMs.p95"], 2);
    assert.strictEqual(r1["status.flags.freeCorps.enabled"], true);
    assert.strictEqual(r1["status.flags.freeCorps.contracts.enabled"], null, "unknown flag = null");
    assert.strictEqual(r1["status.settings.freeCorps.targetCorps"], 60);
    assert.strictEqual(r1["fleets.active"], 7);
    assert.strictEqual(r1["freeCorpsView.state"], null);
    assert.strictEqual(r1.viewErrors, 1);
    assert.strictEqual(r2.seq, 2);
    assert.strictEqual(r2["status.overall"], null, "views not due on seq 2");
    assert.strictEqual(fetcher.stats.viewErrors, 1);
    assert.strictEqual(lines[lines.length - 1].type, "footer");

    const plain = [];
    const res = await sampleLoop({ readFile: async () => JSON.stringify({ schemaVersion: 1, seq: 1 }),
      appendLine: (l) => plain.push(JSON.parse(l)), now: () => 0, sleep: async () => {}, file: "latest.json",
      everyMs: 1000, durationMs: 0, header: { label: "x" } });
    assert.strictEqual(res.rows, 1);
    assert.strictEqual(plain[0].tool, "scalingBench");
  });

  const driver = loadDriver();
  const FS5 = "FCS5 freeCorpsScale: census readonly and --snapshot, missing tables null; docker stats parser";
  if (!driver.ok) {
    skip(FS5, `better-sqlite3 unavailable (${driver.detail || driver.reason})`);
    return;
  }
  test(FS5, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-fs5-"));
    try {
      const file = path.join(dir, "world.sqlite");
      const db = new driver.Database(file);
      db.exec(`CREATE TABLE lne_meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
        INSERT INTO lne_meta (key, value) VALUES ('schema_version', 78), ('world_seed', 1);
        CREATE TABLE world_virtual_identities (identity_key TEXT PRIMARY KEY, kind TEXT, owner_kind TEXT, state TEXT);
        CREATE TABLE world_free_corps (corp_id INTEGER PRIMARY KEY, archetype TEXT, state TEXT, open INTEGER);
        CREATE TABLE virtual_fleets (fleet_id TEXT PRIMARY KEY, faction_id INTEGER, state TEXT);`);
      const ins = db.prepare("INSERT INTO world_virtual_identities VALUES (?, ?, ?, ?)");
      for (let i = 0; i < 3; i += 1) ins.run(`free-${i}`, "character", "free", "linked");
      ins.run("free-x", "character", "free", "reserved");
      ins.run("cap-0", "character", "capsuleer", "linked");
      ins.run("civ-0", "character", "civilian", "linked");
      ins.run("civ-c", "corporation", "civilian", "linked");
      db.prepare("INSERT INTO world_free_corps VALUES (1, 'miner', 'ACTIVE', 1), (2, 'hunter', 'FOUNDING', 1), "
        + "(3, 'miner', 'DISSOLVED', 0)").run();
      db.prepare("INSERT INTO virtual_fleets VALUES ('f1', 500018, 'IDLE'), ('f2', 500010, 'TRAVELLING'), "
        + "('f3', 500018, 'DESTROYED')").run();
      db.close();

      for (const snapshot of [false, true]) {
        const tmpDir = path.join(dir, "tmp");
        const r = runCensus({ file, snapshot, tmpDir, driver, now: () => T0 });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        const c = r.census;
        assert.strictEqual(c.schemaVersion, 78);
        assert.strictEqual(c.takenAtMs, T0);
        assert.deepStrictEqual(c.freeCorps, { open: 2, byState: { ACTIVE: 1, DISSOLVED: 1, FOUNDING: 1 },
          byArchetypeOpen: { hunter: 1, miner: 1 } });
        assert.deepStrictEqual(c.fleets, { byState: { DESTROYED: 1, IDLE: 1, TRAVELLING: 1 }, active: 2,
          capsuleerActive: 1 });
        for (const k of ["ventures", "wars", "outbox", "contracts", "members", "structures"]) {
          assert.strictEqual(c[k], null, k);
        }
        const linked = summarize({ rows: [], censusEnd: c }).identities.end;
        assert.deepStrictEqual(linked, { capsuleer: 1, civilian: 1, free: 3, faction: 0, owners: 5 });
        if (snapshot) assert.deepStrictEqual(fs.readdirSync(tmpDir), [], "snapshot copy removed");
      }
      assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.startsWith("world.sqlite-")), [], "no side files left");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    const a = parseDockerStats("lne-other 1GiB / 2GiB 1%\nevejs-server-1 5.45GiB / 11.68GiB 30.1%\n");
    assert.strictEqual(a.name, "evejs-server-1");
    assert.strictEqual(a.usedBytes, 5.45 * GIB);
    assert.strictEqual(a.limitBytes, 11.68 * GIB);
    assert.strictEqual(a.cpuPercent, 30.1);
    assert.strictEqual(parseDockerStats("evejs-server-1 812MiB / 11.68GiB 2.0%").usedBytes, 812 * MB);
    assert.strictEqual(parseDockerStats("evejs-init-1 1GiB / 2GiB 0%"), null);
  });

  test("FCS6 (WC23) census: ventures.total / closed, the whCorps block (homes "
    + "stock of the open homes, WH_* ventures by kind|state|open, GAS contracts only); no homes table -> null", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-fcs6-"));
    try {
      const mk = (name, withHomes) => {
        const file = path.join(dir, name);
        const db = new driver.Database(file);
        db.exec(`CREATE TABLE lne_meta (key TEXT PRIMARY KEY NOT NULL, value INTEGER NOT NULL);
          INSERT INTO lne_meta (key, value) VALUES ('schema_version', 127), ('world_seed', 1);
          CREATE TABLE world_free_corp_ventures (venture_id TEXT PRIMARY KEY, kind TEXT, state TEXT, open INTEGER);
          INSERT INTO world_free_corp_ventures VALUES ('a', 'MINE', 'WORKING', 1), ('b', 'MINE', 'DONE', 0),
            ('c', 'WH_HAUL', 'TRAVEL', 1), ('d', 'WH_HAUL', 'DONE', 0), ('e', 'WH_HOME', 'DONE', 0),
            ('f', 'WH_HOME', 'DONE', 0);`);
        if (withHomes) {
          db.exec(`CREATE TABLE world_free_corp_wh_homes (corp_id INTEGER PRIMARY KEY, open INTEGER, end_reason TEXT,
              loot_isk INTEGER, gas_isk INTEGER, cargo_loot_isk INTEGER, cargo_gas_isk INTEGER, pi_isk_total INTEGER,
              sold_isk_total INTEGER, home_done INTEGER, haul_done INTEGER, raid_done INTEGER);
            INSERT INTO world_free_corp_wh_homes VALUES (1, 1, NULL, 100, 20, 7, 3, 50, 900, 2, 1, 0),
              (2, 0, 'CORP_CLOSED', 999, 999, 0, 0, 999, 999, 9, 9, 9);
            CREATE TABLE world_free_corp_contracts (contract_key TEXT PRIMARY KEY, goods TEXT, state TEXT);
            INSERT INTO world_free_corp_contracts VALUES ('k1', 'GAS', 'OPEN'), ('k2', 'GAS', 'SOLD'),
              ('k3', 'ORE', 'OPEN'), ('k4', 'GAS', 'OPEN');`);
        }
        db.close();
        const r = runCensus({ file, snapshot: false, tmpDir: path.join(dir, "tmp"), driver, now: () => T0 });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.census;
      };
      const c = mk("world.sqlite", true);
      assert.deepStrictEqual([c.ventures.open, c.ventures.total, c.ventures.closed], [2, 6, 4]);
      assert.deepStrictEqual(c.whCorps.homes, { open: 1, closed: 1, byEndReason: { CORP_CLOSED: 1 } });
      assert.deepStrictEqual(c.whCorps.stock, { lootIsk: 100, gasIsk: 20, cargoIsk: 10, piIskTotal: 50,
        soldIskTotal: 900, homeDone: 2, haulDone: 1, raidDone: 0 }, "open homes only");
      assert.deepStrictEqual(c.whCorps.ventures.byKindState, { "WH_HAUL|DONE|0": 1, "WH_HAUL|TRAVEL|1": 1,
        "WH_HOME|DONE|0": 2 });
      assert.deepStrictEqual(c.whCorps.gasContracts, { byState: { OPEN: 2, SOLD: 1 } });
      const old = mk("old.sqlite", false);
      assert.strictEqual(old.whCorps, null, "no homes table");
      assert.deepStrictEqual([old.ventures.total, old.ventures.closed], [6, 4]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("WM5: G3b measured from persistence.walPerTx "
    + "estimate without it; extract paths; config 4 keys, W45/W46", () => {
    const withWal = (fc, calibrated = true) => {
      const base = input();
      return { ...base, rows: base.rows.map((r) => ({ ...r, "persistence.walPerTx.calibrated": calibrated,
        "persistence.walPerTx.keys.freeCorps.frames": (r.seq - 1) * fc,
        "persistence.walPerTx.keys.virtualCorps.frames": (r.seq - 1) * 3000,
        "persistence.walPerTx.total.frames": (r.seq - 1) * 15000 })) };
    };
    const s = summarize(withWal(1500));
    assert.deepStrictEqual(s.wal.measured, { fcFramesPerS: 5, vcFramesPerS: 10, totalFramesPerS: 50, fcShare: 0.1,
      vcShare: 0.2, hours: 22 });
    const v = verdict(s, { target: "start" });
    assert.strictEqual(v.gates.G3b.status, "PASS");
    assert.ok(v.gates.G3b.lines.includes("G3b WAL freeCorps (measured) 5 frames/s"), v.gates.G3b.lines.join("\n"));
    assert.ok(v.gates.G3.lines.includes("G3 freeCorps 10% of frames, virtualCorps 20% (measured, 50 frames/s)"),
      v.gates.G3.lines.join("\n"));
    const hot = verdict(summarize(withWal(6000)), { target: "start" });
    assert.ok(hot.gates.G3b.lines.includes("FAIL G3b WAL freeCorps (measured) 20 > 10 frames/s"),
      hot.gates.G3b.lines.join("\n"));
    for (const s0 of [summarize(withWal(1500, false)), summarize(input())]) {
      assert.strictEqual(s0.wal.measured, null);
      const v0 = verdict(s0, { target: "start" });
      assert.ok(v0.gates.G3b.lines.some((l) => l.includes("(estimate)")), v0.gates.G3b.lines.join("\n"));
      assert.ok(!v0.gates.G3.lines.some((l) => l.includes("measured")));
    }

    const snap = (walPerTx) => ({ schemaVersion: 1, seq: 1, persistence: { walPerTx } });
    const row = extractRow(snap({ calibrated: true, total: { frames: 9, rows: 3, tx: 2 },
      keys: { freeCorps: { frames: 4, rows: 2, tx: 1 }, virtualCorps: { frames: 5, rows: 1, tx: 1 } } })).row;
    assert.deepStrictEqual([row["persistence.walPerTx.calibrated"], row["persistence.walPerTx.total.frames"],
      row["persistence.walPerTx.keys.freeCorps.frames"], row["persistence.walPerTx.keys.freeCorps.rows"],
      row["persistence.walPerTx.keys.freeCorps.tx"], row["persistence.walPerTx.keys.virtualCorps.frames"]],
    [true, 9, 4, 2, 1, 5]);
    const offRow = extractRow(snap(null)).row;
    assert.deepStrictEqual([offRow["persistence.walPerTx.calibrated"], offRow["persistence.walPerTx.total.frames"]],
      [null, null]);

    const config = require("../../config");
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const d = resolve({});
    assert.deepStrictEqual(d.config.persistence.walPerTx,
      { enabled: false, maxKeys: 128, detailModule: "freeCorps", maxDetailNames: 32 });
    assert.deepStrictEqual(d.warnings, []);
    const W45 = (w) => w.startsWith("persistence.walPerTx.enabled with persistence.managedCheckpoint off");
    const W46 = (w) => w === "persistence.walPerTx.enabled has no effect without modules.telemetry";
    const count = (env, pred) => resolve(env).warnings.filter(pred).length;
    const ON = { EVEJS_LNE_PERSISTENCE_WAL_PER_TX_ENABLED: "1" };
    assert.deepStrictEqual(resolve(ON).warnings, []);
    assert.strictEqual(count({ ...ON, EVEJS_LNE_PERSISTENCE_MANAGED_CHECKPOINT: "0" }, W45), 1);
    assert.strictEqual(count({ EVEJS_LNE_PERSISTENCE_MANAGED_CHECKPOINT: "0" }, W45), 0, "flag off: no W45");
    assert.strictEqual(count({ ...ON, EVEJS_LNE_TELEMETRY_ENABLED: "0" }, W46), 1);
    assert.strictEqual(count({ EVEJS_LNE_TELEMETRY_ENABLED: "0" }, W46), 0, "flag off: no W46");
    const bad = resolve({ EVEJS_LNE_PERSISTENCE_WAL_PER_TX_DETAIL_MODULE: "free.corps",
      EVEJS_LNE_PERSISTENCE_WAL_PER_TX_MAX_KEYS: "4" });
    assert.strictEqual(bad.config.persistence.walPerTx.detailModule, "freeCorps", "bad name -> default");
    assert.strictEqual(bad.config.persistence.walPerTx.maxKeys, 8, "clamped to 8");
  });
};
