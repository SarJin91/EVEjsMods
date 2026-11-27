#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const rules = require("./ageRules");
const { loadDriver, findServerDir } = require("../measure/heapGrowthReport");

const EXIT = Object.freeze({ OK: 0, USAGE: 1, REFUSED: 2, FAILED: 3 });
const MARKER_FILE = "lne-aged-copy.json";
const MARKER_SCHEMA_VERSION = 1;
const DEFAULT_GAMESTORE_REL = path.join("gameStore", "gamestore.sqlite");
const DEFAULT_WORLD_REL = path.join("mods", "livingNewEden", "world.sqlite");
const SQLITE_SIDECARS = Object.freeze(["", "-wal", "-shm"]);
const LIVE_VOLUME_ROOT = "/var/lib/evejs";
const OUTBOX_TABLE = "_persistence_outbox";
const OWNERS_TABLE = "_persistence_owners";
const JOBS_TABLE = "scheduledJobs";
const VENDOR_COLUMNS = "key,json";
const TMP_PREFIX = "lne-age-";
const RM_RETRIES = 5;
const RM_RETRY_DELAY_MS = 50;
const UNKNOWN_TYPE = "unknown";

const USAGE = "usage: ageDataCopy.js --src <dir> --out <dir> --days <1..365> [--dry-run] [--server <serverDir>] "
  + "[--vendor-tables a,b,c] [--gamestore <rel>] [--world <rel>] [--json <file>]";

const quoteIdent = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;
const messageOf = (err) => String((err && err.message) || err);

function fail(exit, reason, detail) {
  const err = new Error(`${reason}${detail ? `: ${detail}` : ""}`);
  err.refusal = { ok: false, exit, reason, ...(detail ? { detail } : {}) };
  return err;
}

function canonical(p, platform = process.platform) {
  let resolved;
  try {
    resolved = fs.realpathSync.native(p);
  } catch (_err) {
    resolved = path.resolve(p);
  }
  const slashed = resolved.replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

const isInside = (child, parent) => child === parent || child.startsWith(`${parent}/`);

function isLiveVolume(p) {
  const raw = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const resolved = path.resolve(p).replace(/\\/g, "/").replace(/^[A-Za-z]:/, "").replace(/\/+$/, "");
  return [raw, resolved].some((x) => isInside(x, LIVE_VOLUME_ROOT));
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_DELAY_MS });
  } catch (_err) {
  }
  return !fs.existsSync(dir);
}

function refusePaths(o) {
  const root = typeof o.env.EVEJS_DATA_ROOT === "string" ? o.env.EVEJS_DATA_ROOT.trim() : "";
  const targets = [o.src, ...(o.out ? [o.out] : []), ...(o.json ? [o.json] : [])];
  if (root) {
    const rootKey = canonical(root);
    const hit = targets.find((p) => isInside(canonical(p), rootKey));
    if (hit) return { ok: false, exit: EXIT.REFUSED, reason: "LIVE_DATA_ROOT", detail: hit };
  }
  const live = targets.find((p) => isLiveVolume(p));
  if (live) return { ok: false, exit: EXIT.REFUSED, reason: "LIVE_VOLUME_PATH", detail: live };
  const srcKey = canonical(o.src);
  if (!o.dryRun) {
    if (fs.existsSync(o.out)) return { ok: false, exit: EXIT.REFUSED, reason: "OUT_EXISTS", detail: o.out };
    const outKey = canonical(o.out);
    if (isInside(outKey, srcKey) || isInside(srcKey, outKey)) {
      return { ok: false, exit: EXIT.REFUSED, reason: "PATH_OVERLAP", detail: `${o.src} / ${o.out}` };
    }
  }
  if (o.json && isInside(canonical(o.json), srcKey)) {
    return { ok: false, exit: EXIT.REFUSED, reason: "PATH_OVERLAP", detail: `--json ${o.json} inside --src` };
  }
  const gs = path.join(o.src, o.gamestoreRel);
  if (!fs.existsSync(gs) || !fs.statSync(gs).isFile()) {
    return { ok: false, exit: EXIT.REFUSED, reason: "SRC_INCOMPLETE", detail: o.gamestoreRel };
  }
  if (fs.existsSync(path.join(o.src, MARKER_FILE))) {
    return { ok: false, exit: EXIT.REFUSED, reason: "ALREADY_AGED", detail: MARKER_FILE };
  }
  return null;
}

function copySqlite(srcFile, dir, name) {
  if (!fs.existsSync(srcFile)) return null;
  for (const suffix of SQLITE_SIDECARS) {
    if (fs.existsSync(`${srcFile}${suffix}`)) fs.copyFileSync(`${srcFile}${suffix}`, path.join(dir, `${name}${suffix}`));
  }
  return path.join(dir, name);
}

function openCopy(driver, file) {
  const db = driver.open(file, { readOnly: false });
  db.exec("PRAGMA busy_timeout = 0");
  return db;
}

const tableNames = (db) => new Set(db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name));
const columnsOf = (db, table) => db.all(`PRAGMA table_info(${quoteIdent(table)})`);
const bump = (map, key, n = 1) => {
  map[key] = (map[key] || 0) + n;
};

function rollback(db) {
  try {
    db.exec("ROLLBACK");
  } catch (_err) {
  }
}

function closeQuietly(db) {
  try {
    db.close();
  } catch (_err) {
  }
}

function ageGameStore(driver, file, ctx) {
  const { report, shiftMs, now } = ctx;
  const db = openCopy(driver, file);
  try {
    const present = tableNames(db);
    const tables = ctx.vendorTables.filter((t) => {
      if (present.has(t)) return true;
      report.warnings.push(`TABLE_MISSING:${t}`);
      return false;
    });
    for (const t of tables) {
      const cols = columnsOf(db, t).map((c) => c.name).join(",");
      if (cols !== VENDOR_COLUMNS) throw fail(EXIT.FAILED, "SCHEMA_DRIFT", `${t}(${cols})`);
    }
    if (present.has(OUTBOX_TABLE)) {
      const listed = new Set(tables);
      const pending = db.all(`SELECT table_name FROM ${OUTBOX_TABLE} WHERE state = 'pending'`)
        .map((r) => r.table_name).filter((t) => listed.has(t));
      if (pending.length > 0) throw fail(EXIT.REFUSED, "OUTBOX_PENDING", pending.join(","));
    }
    if (present.has(OWNERS_TABLE)) {
      try {
        const row = db.get(`SELECT count(*) AS n FROM ${OWNERS_TABLE} WHERE active = 1`);
        if (row && Number(row.n) > 0) report.warnings.push("OWNER_ACTIVE");
      } catch (err) {
        report.warnings.push(`OWNER_UNREADABLE:${messageOf(err).split("\n")[0]}`);
      }
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of tables) ageVendorTable(db, t, shiftMs, now, report);
      db.exec("COMMIT");
    } catch (err) {
      rollback(db);
      throw err;
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    closeQuietly(db);
  }
}

function ageVendorTable(db, table, shiftMs, now, report) {
  const stat = { rows: 0, rowsChanged: 0, shifted: {}, suspects: {} };
  report.vendor[table] = stat;
  const updates = [];
  let unparsed = 0;
  for (const row of db.iterate(`SELECT key, json FROM ${quoteIdent(table)}`)) {
    stat.rows += 1;
    let value;
    try {
      value = JSON.parse(row.json);
    } catch (_err) {
      unparsed += 1;
      continue;
    }
    const originals = [];
    const out = rules.shiftJson(value, shiftMs, {
      onShift(where, _kind, original) {
        bump(stat.shifted, where);
        originals.push(original);
      },
      onSuspect(where) {
        bump(stat.suspects, where);
      },
    });
    if (table === JOBS_TABLE) noteJob(report, row.key, value, out.value, originals, now);
    if (out.changed > 0) updates.push([JSON.stringify(out.value), row.key]);
  }
  if (unparsed > 0) report.warnings.push(`ROW_UNPARSED:${table}:${unparsed}`);
  for (const [json, key] of updates) {
    db.get(`UPDATE ${quoteIdent(table)} SET json = ? WHERE key = ? RETURNING key`, json, key);
    stat.rowsChanged += 1;
  }
}

function noteJob(report, key, before, after, originals, now) {
  const job = after && typeof after === "object" ? after : {};
  const type = typeof job.type === "string" && job.type ? job.type : UNKNOWN_TYPE;
  const entry = report.jobs.byType[type] || (report.jobs.byType[type] = { total: 0, dueAfter: 0, staleIdentity: 0 });
  entry.total += 1;
  if (Number.isFinite(job.dueAtMs) && job.dueAtMs <= now) entry.dueAfter += 1;
  const jobID = before && typeof before.jobID === "string" ? before.jobID : String(key);
  if (rules.hasStaleIdentity(jobID, originals)) entry.staleIdentity += 1;
}

function ageLne(driver, file, ctx) {
  const { report, shiftMs } = ctx;
  const lo = rules.MIN_EPOCH_MS;
  const hi = rules.MAX_EPOCH_MS - 1;
  const inWindow = (c) => `${quoteIdent(c)} BETWEEN ${lo} AND ${hi}`;
  const db = openCopy(driver, file);
  try {
    const tables = db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' "
      + "ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").map((r) => r.name);
    const plan = [];
    for (const t of tables) {
      const cols = columnsOf(db, t);
      const time = cols.filter((c) => rules.isLneTimeColumn(c.name, c.type)).map((c) => c.name);
      for (const c of cols) {
        if (time.includes(c.name) || !/INT/i.test(String(c.type || ""))) continue;
        const n = Number(db.get(`SELECT count(*) AS n FROM ${quoteIdent(t)} WHERE ${inWindow(c.name)}`).n);
        if (n > 0) report.lneSuspects[`${t}.${c.name}`] = n;
      }
      if (time.length > 0) plan.push({ table: t, time });
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const { table, time } of plan) {
        const sums = time.map((c, i) => `sum(CASE WHEN ${inWindow(c)} THEN 1 ELSE 0 END) AS c${i}`).join(", ");
        const counts = db.get(`SELECT ${sums} FROM ${quoteIdent(table)}`);
        const per = {};
        time.forEach((c, i) => {
          const n = Number((counts && counts[`c${i}`]) || 0);
          if (n > 0) per[c] = n;
        });
        if (Object.keys(per).length === 0) continue;
        const moved = Object.keys(per);
        const sets = moved.map((c) => `${quoteIdent(c)} = CASE WHEN ${inWindow(c)} THEN ${quoteIdent(c)} - ${shiftMs} `
          + `ELSE ${quoteIdent(c)} END`).join(", ");
        try {
          db.exec(`UPDATE ${quoteIdent(table)} SET ${sets} WHERE ${moved.map(inWindow).join(" OR ")}`);
        } catch (err) {
          throw fail(EXIT.FAILED, "CHECK_FAILED", `${table}: ${messageOf(err).split("\n")[0]}`);
        }
        report.lne[table] = per;
      }
      db.exec("COMMIT");
    } catch (err) {
      rollback(db);
      throw err;
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    closeQuietly(db);
  }
}

function run(o) {
  const shift = rules.shiftOf(o.days);
  if (!shift.ok) return { ok: false, exit: EXIT.USAGE, reason: shift.reason, detail: `--days ${o.days}` };
  if (!o.src) return { ok: false, exit: EXIT.USAGE, reason: "USAGE", detail: "--src is required" };
  if (!o.dryRun && !o.out) return { ok: false, exit: EXIT.USAGE, reason: "USAGE", detail: "--out is required" };
  const opts = { ...o, env: o.env || {}, json: o.json || null };
  const refusal = refusePaths(opts);
  if (refusal) return refusal;
  const driver = loadDriver(o.serverDir || null);
  if (!driver.ok) return { ok: false, exit: EXIT.FAILED, reason: "NO_SQLITE_DRIVER", detail: driver.detail };
  const log = typeof o.log === "function" ? o.log : () => {};
  const report = { days: o.days, shiftMs: shift.shiftMs, driver: driver.name, dryRun: o.dryRun === true, vendor: {},
    jobs: { byType: {} }, lne: {}, lneSuspects: {}, warnings: [...driver.warnings] };
  const ctx = { report, shiftMs: shift.shiftMs, now: o.now(), vendorTables: o.vendorTables };

  let work = null;
  try {
    let gsFile;
    let worldFile;
    if (o.dryRun) {
      work = fs.mkdtempSync(path.join(os.tmpdir(), TMP_PREFIX));
      gsFile = copySqlite(path.join(o.src, o.gamestoreRel), work, "gamestore.sqlite");
      worldFile = copySqlite(path.join(o.src, o.worldRel), work, "world.sqlite");
    } else {
      fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
      try {
        fs.mkdirSync(o.out);
      } catch (err) {
        if (err && err.code === "EEXIST") throw fail(EXIT.REFUSED, "OUT_EXISTS", o.out);
        throw err;
      }
      work = o.out;
      log(`ageDataCopy: copying ${o.src} -> ${o.out}`);
      fs.cpSync(o.src, o.out, { recursive: true, errorOnExist: true, force: false });
      gsFile = path.join(o.out, o.gamestoreRel);
      worldFile = fs.existsSync(path.join(o.out, o.worldRel)) ? path.join(o.out, o.worldRel) : null;
    }
    ageGameStore(driver, gsFile, ctx);
    if (worldFile) ageLne(driver, worldFile, ctx);
    else report.warnings.push("LNE_DB_MISSING");
    if (!o.dryRun) {
      const counts = { vendorRowsChanged: Object.fromEntries(Object.entries(report.vendor)
        .map(([t, s]) => [t, s.rowsChanged])),
      lneValues: Object.values(report.lne).reduce((n, per) => n + Object.values(per).reduce((a, b) => a + b, 0), 0) };
      fs.writeFileSync(path.join(o.out, MARKER_FILE), `${JSON.stringify({ tool: "ageDataCopy",
        schemaVersion: MARKER_SCHEMA_VERSION, days: o.days, shiftMs: shift.shiftMs, agedAtMs: o.now(),
        driver: driver.name, counts }, null, 2)}\n`);
    }
  } catch (err) {
    const out = err && err.refusal ? { ...err.refusal }
      : { ok: false, exit: EXIT.FAILED, reason: "FAILED", detail: messageOf(err) };
    if (work !== null && !removeDir(work)) {
      out.outNotRemoved = work;
      out.detail = `${out.detail ? `${out.detail}; ` : ""}OUT_NOT_REMOVED ${work}`;
    }
    work = null;
    return out;
  } finally {
    if (o.dryRun && work !== null) removeDir(work);
  }
  return { ok: true, report };
}

function parseArgs(argv, defaultServerDir = null) {
  const args = argv.slice();
  const o = { ok: true, src: null, out: null, days: null, dryRun: false, serverDir: defaultServerDir,
    vendorTables: [...rules.DEFAULT_VENDOR_TABLES], gamestoreRel: DEFAULT_GAMESTORE_REL, worldRel: DEFAULT_WORLD_REL,
    json: null };
  const value = (flag) => {
    if (args.length === 0) throw new Error(`${flag} needs a value`);
    return args.shift();
  };
  try {
    while (args.length > 0) {
      const a = args.shift();
      if (a === "--src") o.src = value(a);
      else if (a === "--out") o.out = value(a);
      else if (a === "--days") {
        const raw = value(a);
        o.days = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      } else if (a === "--dry-run") o.dryRun = true;
      else if (a === "--server") o.serverDir = path.resolve(value(a));
      else if (a === "--vendor-tables") {
        o.vendorTables = value(a).split(",").map((t) => t.trim()).filter(Boolean);
        if (o.vendorTables.length === 0) throw new Error("--vendor-tables needs at least one table");
      } else if (a === "--gamestore") o.gamestoreRel = value(a);
      else if (a === "--world") o.worldRel = value(a);
      else if (a === "--json") o.json = value(a);
      else throw new Error(`unknown argument ${a}`);
    }
  } catch (err) {
    return { ok: false, reason: "USAGE", detail: messageOf(err) };
  }
  if (o.days === null) return { ok: false, reason: "USAGE", detail: "--days is required" };
  return o;
}

const countRows = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

function renderReport(r) {
  const L = [`# ageDataCopy - ${r.dryRun ? "dry run" : "aged copy"}`, "",
    `days ${r.days}, shift ${r.shiftMs} ms, driver ${r.driver}`, ""];
  L.push("## vendor tables", "");
  for (const [t, s] of Object.entries(r.vendor)) {
    L.push(`### ${t}: rows ${s.rows}, changed ${s.rowsChanged}`);
    for (const [p, n] of countRows(s.shifted)) L.push(`- shifted ${p}: ${n}`);
    for (const [p, n] of countRows(s.suspects)) L.push(`- SUSPECT ${p}: ${n}`);
    L.push("");
  }
  L.push("## jobs by type (dueAfter = due at the first worker pass)", "", "| type | total | dueAfter | staleIdentity |",
    "|---|---|---|---|");
  for (const [t, j] of Object.entries(r.jobs.byType)) L.push(`| ${t} | ${j.total} | ${j.dueAfter} | ${j.staleIdentity} |`);
  L.push("", "## LNE columns", "");
  for (const [t, per] of Object.entries(r.lne)) {
    L.push(`- ${t}: ${Object.entries(per).map(([c, n]) => `${c} ${n}`).join(", ")}`);
  }
  L.push("", "## LNE suspects (INTEGER columns outside the rule with values in the ms window, not changed)", "");
  for (const [c, n] of countRows(r.lneSuspects)) L.push(`- ${c}: ${n}`);
  L.push("", `warnings: ${r.warnings.length > 0 ? r.warnings.join(", ") : "none"}`);
  return L.join("\n");
}

function main(argv, env = process.env, deps = {}) {
  const print = deps.print || ((text) => process.stdout.write(`${text}\n`));
  const warn = deps.warn || ((text) => process.stderr.write(`${text}\n`));
  const o = parseArgs(argv, deps.serverDir !== undefined ? deps.serverDir : findServerDir(__dirname));
  if (!o.ok) {
    warn(`${USAGE}\n${o.detail}`);
    return EXIT.USAGE;
  }
  const r = run({ ...o, env, now: deps.now || Date.now, log: warn });
  if (!r.ok) {
    warn(`${r.exit === EXIT.USAGE ? `${USAGE}\n` : ""}${r.exit === EXIT.REFUSED ? "refused" : "failed"}: ${r.reason}`
      + `${r.detail ? ` (${r.detail})` : ""}`);
    return r.exit;
  }
  if (o.json) fs.writeFileSync(o.json, `${JSON.stringify(r.report, null, 2)}\n`);
  print(renderReport(r.report));
  return EXIT.OK;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main, run, parseArgs, renderReport, EXIT, MARKER_FILE, isLiveVolume };
