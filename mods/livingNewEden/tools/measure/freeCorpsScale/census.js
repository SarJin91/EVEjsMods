"use strict";

const fs = require("node:fs");

const offline = require("../../offlineDb");
const { readSchemaVersion } = require("../../../lib/persistence/migrations");

const TOOL = "freeCorpsScaleReport";
const FORMAT = 1;
const SNAPSHOT_PREFIX = "lne-fc-census-";
const GROUP_LIMIT = 500;
const CAPSULEER_FACTION_ID = 500018;
const FLEET_DESTROYED = "DESTROYED";

const T_IDENTITIES = "world_virtual_identities";
const T_FREE_CORPS = "world_free_corps";
const T_VENTURES = "world_free_corp_ventures";
const T_WARS = "world_free_corp_wars";
const T_OUTBOX = "world_free_corp_outbox";
const T_CONTRACTS = "world_free_corp_contracts";
const T_MEMBERS = "world_free_corp_members";
const T_STRUCTURES = "world_free_corp_structures";
const T_FLEETS = "virtual_fleets";
const T_WH_HOMES = "world_free_corp_wh_homes";
const WH_KINDS_SQL = "'WH_HOME', 'WH_RAID', 'WH_HAUL'";
const GAS_GOODS = "GAS";

const REASONS = Object.freeze({ LOCKED: "LOCKED", NOT_LNE: "NOT_LNE", OPEN_FAILED: "OPEN_FAILED",
  SNAPSHOT_FAILED: "SNAPSHOT_FAILED", READ_FAILED: "READ_FAILED" });

function tablesOf(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

function tally(rows, key) {
  const out = {};
  for (const r of rows) out[r[key]] = (out[r[key]] || 0) + r.n;
  return out;
}

const total = (rows) => rows.reduce((s, r) => s + r.n, 0);

function censusOf(db) {
  const tables = tablesOf(db);
  const all = (sql) => db.prepare(sql).all();
  const has = (t) => tables.has(t);

  const identities = has(T_IDENTITIES) ? { rows: all(`SELECT owner_kind AS ownerKind, kind, state, COUNT(*) AS n FROM `
    + `${T_IDENTITIES} GROUP BY owner_kind, kind, state ORDER BY owner_kind, kind, state LIMIT ${GROUP_LIMIT}`) } : null;

  let freeCorps = null;
  if (has(T_FREE_CORPS)) {
    const rows = all(`SELECT state, archetype, open, COUNT(*) AS n FROM ${T_FREE_CORPS} GROUP BY state, archetype, open `
      + `ORDER BY state, archetype, open LIMIT ${GROUP_LIMIT}`);
    const open = rows.filter((r) => r.open === 1);
    freeCorps = { open: total(open), byState: tally(rows, "state"), byArchetypeOpen: tally(open, "archetype") };
  }

  let ventures = null;
  if (has(T_VENTURES)) {
    const rows = all(`SELECT kind, state, COUNT(*) AS n FROM ${T_VENTURES} WHERE open = 1 GROUP BY kind, state `
      + `ORDER BY kind, state LIMIT ${GROUP_LIMIT}`);
    const sizes = db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(open = 0), 0) AS closed FROM ${T_VENTURES}`).get();
    ventures = { open: total(rows), byKind: tally(rows, "kind"), byState: tally(rows, "state"),
      total: Number(sizes.total), closed: Number(sizes.closed) };
  }

  let whCorps = null;
  if (has(T_WH_HOMES)) {
    const homeRows = all(`SELECT open, end_reason AS endReason, COUNT(*) AS n FROM ${T_WH_HOMES} `
      + `GROUP BY open, end_reason ORDER BY open, end_reason LIMIT ${GROUP_LIMIT}`);
    const byEndReason = {};
    let homesOpen = 0;
    let homesClosed = 0;
    for (const r of homeRows) {
      const n = Number(r.n);
      if (Number(r.open) === 1) {
        homesOpen += n;
      } else {
        homesClosed += n;
        byEndReason[String(r.endReason)] = (byEndReason[String(r.endReason)] || 0) + n;
      }
    }
    const s = db.prepare(`SELECT COALESCE(SUM(loot_isk), 0) AS loot, COALESCE(SUM(gas_isk), 0) AS gas, `
      + `COALESCE(SUM(cargo_loot_isk + cargo_gas_isk), 0) AS cargo, COALESCE(SUM(pi_isk_total), 0) AS pi, `
      + `COALESCE(SUM(sold_isk_total), 0) AS sold, COALESCE(SUM(home_done), 0) AS homeDone, `
      + `COALESCE(SUM(haul_done), 0) AS haulDone, COALESCE(SUM(raid_done), 0) AS raidDone `
      + `FROM ${T_WH_HOMES} WHERE open = 1`).get();
    let byKindState = null;
    if (has(T_VENTURES)) {
      byKindState = {};
      for (const r of all(`SELECT kind, state, open, COUNT(*) AS n FROM ${T_VENTURES} WHERE kind IN (${WH_KINDS_SQL}) `
        + `GROUP BY kind, state, open ORDER BY kind, state, open LIMIT ${GROUP_LIMIT}`)) {
        byKindState[`${r.kind}|${r.state}|${Number(r.open)}`] = Number(r.n);
      }
    }
    whCorps = {
      homes: { open: homesOpen, closed: homesClosed, byEndReason },
      stock: { lootIsk: Number(s.loot), gasIsk: Number(s.gas), cargoIsk: Number(s.cargo), piIskTotal: Number(s.pi),
        soldIskTotal: Number(s.sold), homeDone: Number(s.homeDone), haulDone: Number(s.haulDone),
        raidDone: Number(s.raidDone) },
      ventures: { byKindState },
      gasContracts: has(T_CONTRACTS) ? { byState: tally(all(`SELECT state, COUNT(*) AS n FROM ${T_CONTRACTS} `
        + `WHERE goods = '${GAS_GOODS}' GROUP BY state ORDER BY state LIMIT ${GROUP_LIMIT}`), "state") } : null,
    };
  }

  let wars = null;
  if (has(T_WARS)) {
    const rows = all(`SELECT state, COUNT(*) AS n FROM ${T_WARS} WHERE open = 1 GROUP BY state ORDER BY state `
      + `LIMIT ${GROUP_LIMIT}`);
    wars = { open: total(rows), byState: tally(rows, "state") };
  }

  const outbox = has(T_OUTBOX) ? { rows: all(`SELECT kind, state, COUNT(*) AS n FROM ${T_OUTBOX} GROUP BY kind, state `
    + `ORDER BY kind, state LIMIT ${GROUP_LIMIT}`) } : null;

  const byStateOf = (t) => (has(t) ? { byState: tally(all(`SELECT state, COUNT(*) AS n FROM ${t} GROUP BY state `
    + `ORDER BY state LIMIT ${GROUP_LIMIT}`), "state") } : null);

  let fleets = null;
  if (has(T_FLEETS)) {
    const rows = all(`SELECT state, faction_id = ${CAPSULEER_FACTION_ID} AS capsuleer, COUNT(*) AS n FROM ${T_FLEETS} `
      + `GROUP BY state, capsuleer ORDER BY state, capsuleer LIMIT ${GROUP_LIMIT}`);
    const live = rows.filter((r) => r.state !== FLEET_DESTROYED);
    fleets = { byState: tally(rows, "state"), active: total(live),
      capsuleerActive: total(live.filter((r) => r.capsuleer === 1)) };
  }

  return { identities, freeCorps, ventures, wars, outbox, contracts: byStateOf(T_CONTRACTS),
    members: byStateOf(T_MEMBERS), structures: byStateOf(T_STRUCTURES), fleets, whCorps };
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch (_err) {
    return 0;
  }
}

function readHandle(db, ctx) {
  let version;
  try {
    version = readSchemaVersion(db);
  } catch (err) {
    return { ok: false, reason: REASONS.READ_FAILED, detail: offline.messageOf(err) };
  }
  if (!version.ok || version.version === 0) {
    return { ok: false, reason: REASONS.NOT_LNE, detail: `${version.reason || "EMPTY"}: ${version.detail || "-"}` };
  }
  let body;
  try {
    body = censusOf(db);
  } catch (err) {
    return { ok: false, reason: REASONS.READ_FAILED, detail: offline.messageOf(err) };
  }
  return { ok: true, census: { tool: TOOL, format: FORMAT, kind: "census", takenAtMs: ctx.now(),
    schemaVersion: version.version, dbBytes: sizeOf(ctx.file), walBytes: sizeOf(`${ctx.file}-wal`),
    snapshot: ctx.snapshot, ...body } };
}

function runCensus(opts) {
  const { file, driver } = opts;
  const ctx = { file, snapshot: opts.snapshot === true, now: opts.now };
  if (!ctx.snapshot) {
    const before = offline.sideFilesOf(file);
    const opened = offline.openLocked(driver, file, { readonly: true });
    if (!opened.ok) return { ok: false, reason: opened.reason, detail: opened.detail };
    let out;
    try {
      out = readHandle(opened.db, ctx);
    } finally {
      const first = offline.removeCreatedSideFiles(file, before);
      offline.closeQuietly(opened.db);
      if (first.failed.length > 0) offline.removeCreatedSideFiles(file, before, { only: first.failed });
    }
    return out.ok ? { ...out, notes: [] } : out;
  }
  let snap;
  try {
    fs.mkdirSync(opts.tmpDir, { recursive: true });
    snap = offline.takeSnapshot(file, opts.tmpDir, SNAPSHOT_PREFIX);
  } catch (err) {
    return { ok: false, reason: REASONS.SNAPSHOT_FAILED, detail: offline.messageOf(err) };
  }
  const notes = [];
  try {
    const opened = offline.openLocked(driver, snap.file, { readonly: true });
    if (!opened.ok) return { ok: false, reason: REASONS.OPEN_FAILED, detail: opened.detail };
    try {
      const out = readHandle(opened.db, ctx);
      return out.ok ? { ...out, notes } : out;
    } finally {
      offline.closeQuietly(opened.db);
    }
  } finally {
    try {
      fs.rmSync(snap.dir, { recursive: true, force: true });
    } catch (err) {
      notes.push(`copy left behind ${snap.dir} (${offline.messageOf(err)})`);
    }
  }
}

module.exports = { TOOL, FORMAT, REASONS, CAPSULEER_FACTION_ID, censusOf, runCensus };
