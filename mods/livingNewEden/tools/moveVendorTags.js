"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { EXIT, LOCKED_MESSAGE, messageOf, loadDriver, resolveDbFile, openLocked, closeQuietly, sizeOnDisk }
  = require("./offlineDb");
const { MIGRATIONS, runMigrations } = require("../lib/persistence/migrations");
const { importTagsInTx, isOrderId } = require("../lib/persistence/vendorTags");
const { ESCROW_OFFER, WRECK_ANOMALY, WRECK_SLOT } = require("../lib/adapter/vendorTagFields");

const NEEDED = 4;
const VENDOR_FILE = "gamestore.sqlite";
const WORLD_BACKUP_FILE = "world.sqlite";
const BACKUP_SUFFIX = "-pre-lne-tags";
const SPACE_MARGIN = 1.1;
const MAX_JSON_PATHS = 100;
const MAX_OWNER_ID = 128;
const ROW_KEY_SEP = "\u001f";
const WRECK_GROUP = "wrecks";
const META_KEY = "_meta";
const USAGE = "usage: node mods/livingNewEden/tools/moveVendorTags.js [--dry-run | --apply | --check] "
  + "[--store-root <dir>] [--db <world.sqlite>] [--skip-space-check]";

const OFFER_PATH = `$.${ESCROW_OFFER}`;
const ANOMALY_PATH = `$.${WRECK_ANOMALY}`;
const SLOT_PATH = `$.${WRECK_SLOT}`;

function parseArgs(argv, env) {
  const out = { mode: null, storeRoot: null, db: null, skipSpaceCheck: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--apply" || arg === "--check") {
      if (out.mode !== null && out.mode !== arg) return { ok: false, detail: "pick one of --dry-run, --apply, --check" };
      out.mode = arg;
    } else if (arg === "--skip-space-check") {
      out.skipSpaceCheck = true;
    } else if (arg === "--store-root" || arg === "--db") {
      const value = argv[i + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) {
        return { ok: false, detail: `${arg} needs a value` };
      }
      if (arg === "--store-root") out.storeRoot = value;
      else out.db = value;
      i += 1;
    } else {
      return { ok: false, detail: `unknown argument ${arg}` };
    }
  }
  if (out.mode === null) out.mode = "--dry-run";
  if (out.storeRoot === null) {
    const root = env && typeof env.EVEJS_DATA_ROOT === "string" && env.EVEJS_DATA_ROOT ? env.EVEJS_DATA_ROOT : null;
    if (root === null) return { ok: false, detail: "no --store-root and no EVEJS_DATA_ROOT" };
    out.storeRoot = path.join(root, "gameStore");
  }
  return { ok: true, ...out };
}

function canonicalOrderId(key) {
  try {
    const big = BigInt(String(key).trim());
    const text = big > 0n ? big.toString() : null;
    return text !== null && isOrderId(text) ? text : null;
  } catch (_err) {
    return null;
  }
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function pragmaNumber(db, name) {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row ? Number(Object.values(row)[0]) : 0;
}

function isOwnerText(type, value) {
  return type === "text" && typeof value === "string" && value.length >= 1 && value.length <= MAX_OWNER_ID;
}

function wreckIdOf(text) {
  if (!/^[1-9][0-9]*$/.test(String(text))) return 0;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : 0;
}

function wreckEntry(where, key, id, row) {
  const wreckId = wreckIdOf(id);
  const valid = wreckId > 0 && isOwnerText(row.ta, row.anomaly);
  const slot = row.ts === "integer" && Number.isSafeInteger(Number(row.slot)) ? Number(row.slot) : -1;
  return { where, key, id: String(id), valid, tag: valid ? { wreckId, anomalyId: row.anomaly, slot } : null };
}

function scan(db) {
  const out = { escrows: [], wrecks: [] };
  if (hasTable(db, "marketEscrow")) {
    const rows = db.prepare("SELECT key, json_extract(json, ?) AS offer, json_type(json, ?) AS t FROM marketEscrow "
      + "WHERE key <> ? AND json_type(json, ?) IS NOT NULL ORDER BY key").all(OFFER_PATH, OFFER_PATH, META_KEY, OFFER_PATH);
    for (const row of rows) {
      const orderId = canonicalOrderId(row.key);
      const valid = orderId !== null && isOwnerText(row.t, row.offer);
      out.escrows.push({ key: row.key, valid, tag: valid ? { orderId, offerId: row.offer } : null });
    }
  }
  if (hasTable(db, "npcWrecks")) {
    const grouped = db.prepare("SELECT e.key AS id, json_extract(e.value, ?) AS anomaly, json_type(e.value, ?) AS ta, "
      + "json_extract(e.value, ?) AS slot, json_type(e.value, ?) AS ts FROM npcWrecks AS w, json_each(w.json) AS e "
      + "WHERE w.key = ? AND json_type(w.json) = 'object' AND e.type = 'object' "
      + "AND (json_type(e.value, ?) IS NOT NULL OR json_type(e.value, ?) IS NOT NULL) ORDER BY e.key")
      .all(ANOMALY_PATH, ANOMALY_PATH, SLOT_PATH, SLOT_PATH, WRECK_GROUP, ANOMALY_PATH, SLOT_PATH);
    for (const row of grouped) out.wrecks.push(wreckEntry("group", WRECK_GROUP, row.id, row));
    const prefix = `${WRECK_GROUP}${ROW_KEY_SEP}`;
    const split = db.prepare("SELECT key, json_extract(json, ?) AS anomaly, json_type(json, ?) AS ta, "
      + "json_extract(json, ?) AS slot, json_type(json, ?) AS ts FROM npcWrecks "
      + "WHERE substr(key, 1, ?) = ? AND (json_type(json, ?) IS NOT NULL OR json_type(json, ?) IS NOT NULL) ORDER BY key")
      .all(ANOMALY_PATH, ANOMALY_PATH, SLOT_PATH, SLOT_PATH, prefix.length, prefix, ANOMALY_PATH, SLOT_PATH);
    for (const row of split) out.wrecks.push(wreckEntry("row", row.key, row.key.slice(prefix.length), row));
  }
  const valid = (list) => list.filter((c) => c.valid).length;
  out.counts = {
    escrows: valid(out.escrows),
    wrecks: valid(out.wrecks),
    invalid: out.escrows.length + out.wrecks.length - valid(out.escrows) - valid(out.wrecks),
  };
  out.total = out.escrows.length + out.wrecks.length;
  return out;
}

function leaseRefusal(db, nowMs) {
  if (hasTable(db, "_persistence_owners") && db.prepare(
    "SELECT 1 AS x FROM _persistence_owners WHERE active = 1 AND lease_expires_at > ? LIMIT 1").get(nowMs)) {
    return "the game store has an active writer (stop the server and market first)";
  }
  if (hasTable(db, "_persistence_outbox") && db.prepare(
    "SELECT 1 AS x FROM _persistence_outbox WHERE state IS NOT 'applied' LIMIT 1").get()) {
    return "the game store has unapplied persistence operations (start and stop the old server once to recover them)";
  }
  return null;
}

function stripInTx(db) {
  const before = scan(db);
  const escrow = db.prepare("UPDATE marketEscrow SET json = json_remove(json, ?) WHERE key = ?");
  for (const c of before.escrows) escrow.run(OFFER_PATH, c.key);
  const groupPaths = [];
  for (const c of before.wrecks) {
    if (c.where === "row") {
      db.prepare("UPDATE npcWrecks SET json = json_remove(json, ?, ?) WHERE key = ?").run(ANOMALY_PATH, SLOT_PATH, c.key);
    } else if (!/["\\]/.test(c.id)) {
      groupPaths.push(`$."${c.id}".${WRECK_ANOMALY}`, `$."${c.id}".${WRECK_SLOT}`);
    }
  }
  for (let i = 0; i < groupPaths.length; i += MAX_JSON_PATHS) {
    const chunk = groupPaths.slice(i, i + MAX_JSON_PATHS);
    db.prepare(`UPDATE npcWrecks SET json = json_remove(json, ${chunk.map(() => "?").join(", ")}) WHERE key = ?`)
      .run(...chunk, WRECK_GROUP);
  }
  const after = scan(db);
  if (after.total !== 0) throw new Error(`${after.total} LNE fields still present after the strip`);
  return before.total;
}

function stampOf(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
}

function freeBytes(statfs, dir) {
  const s = statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

function backupInto(db, file) {
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
}

function report(print, label, counts) {
  print(`${label}: escrows=${counts.escrows} wrecks=${counts.wrecks} invalid=${counts.invalid}`);
}

function main(argv, deps = {}) {
  const print = typeof deps.print === "function" ? deps.print : (line) => console.log(line);
  const env = deps.env || process.env;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const statfs = typeof deps.statfs === "function" ? deps.statfs : fs.statfsSync;
  const args = parseArgs(argv, env);
  if (!args.ok) {
    print(`${USAGE}\n${args.detail}`);
    return EXIT.USAGE;
  }
  const vendorFile = path.join(path.resolve(args.storeRoot), VENDOR_FILE);
  if (!fs.existsSync(vendorFile)) {
    print(`OK: no save at ${vendorFile} - nothing to move`);
    return EXIT.OK;
  }
  const driver = deps.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`FAILED: no SQLite driver (${(driver && (driver.reason || driver.detail)) || "unknown"})`);
    return EXIT.FAILED;
  }

  const ro = openLocked(driver, vendorFile, { readonly: true });
  if (!ro.ok) {
    print(ro.reason === "LOCKED" ? LOCKED_MESSAGE : `FAILED: cannot open ${vendorFile}: ${ro.detail}`);
    return ro.reason === "LOCKED" ? EXIT.REFUSED : EXIT.FAILED;
  }
  let found;
  try {
    if (pragmaNumber(ro.db, "application_id") !== 0 || pragmaNumber(ro.db, "user_version") !== 0) {
      print("OK: the save is already in the shared schema - no LNE fields can be left in it");
      return EXIT.OK;
    }
    if (!hasTable(ro.db, "_migrations")) {
      print(`FAILED: ${vendorFile} is not an EveJS game store (no _migrations table)`);
      return EXIT.FAILED;
    }
    const refused = leaseRefusal(ro.db, now());
    if (refused) {
      print(`REFUSED: ${refused} - nothing changed`);
      return EXIT.REFUSED;
    }
    found = scan(ro.db);
  } catch (err) {
    print(`FAILED: scan: ${messageOf(err)}`);
    return EXIT.FAILED;
  } finally {
    closeQuietly(ro.db);
  }

  report(print, "LNE fields in vendor records", found.counts);
  if (args.mode === "--check") {
    if (found.total > 0) {
      print("NEEDED: run with --apply before upgrading the save");
      return NEEDED;
    }
    return EXIT.OK;
  }
  if (args.mode === "--dry-run") {
    print("Dry run: nothing changed (--apply moves the tags).");
    return EXIT.OK;
  }
  if (found.total === 0) {
    print("OK: nothing to do");
    return EXIT.OK;
  }
  return apply(args, { driver, print, env, now, statfs, vendorFile });
}

function apply(args, ctx) {
  const { driver, print, env, now, statfs, vendorFile } = ctx;
  const resolved = resolveDbFile(args.db, env);
  for (const w of resolved.warnings || []) print(`warning: ${w}`);
  const worldFile = resolved.file;
  if (!fs.existsSync(worldFile)) {
    print(`FAILED: LNE world database not found at ${worldFile} (pass --db) - nothing changed`);
    return EXIT.FAILED;
  }
  const lne = openLocked(driver, worldFile);
  if (!lne.ok) {
    print(lne.reason === "LOCKED" ? LOCKED_MESSAGE : `FAILED: cannot open ${worldFile}: ${lne.detail}`);
    return lne.reason === "LOCKED" ? EXIT.REFUSED : EXIT.FAILED;
  }
  const vendor = openLocked(driver, vendorFile);
  if (!vendor.ok) {
    closeQuietly(lne.db);
    print(vendor.reason === "LOCKED" ? LOCKED_MESSAGE : `FAILED: cannot open ${vendorFile}: ${vendor.detail}`);
    return vendor.reason === "LOCKED" ? EXIT.REFUSED : EXIT.FAILED;
  }
  try {
    const refused = leaseRefusal(vendor.db, now());
    if (refused) {
      print(`REFUSED: ${refused} - nothing changed`);
      return EXIT.REFUSED;
    }
    const found = scan(vendor.db);
    if (found.total === 0) {
      print("OK: nothing to do");
      return EXIT.OK;
    }
    const storeRoot = path.resolve(args.storeRoot);
    if (args.skipSpaceCheck) {
      print("Space: check skipped (--skip-space-check).");
    } else {
      const need = Math.ceil((sizeOnDisk(vendorFile) + sizeOnDisk(worldFile)) * SPACE_MARGIN);
      let free;
      try {
        free = freeBytes(statfs, storeRoot);
      } catch (err) {
        print(`REFUSED: cannot check free space (${messageOf(err)}); skip the check with --skip-space-check`);
        return EXIT.REFUSED;
      }
      if (!(free >= need)) {
        print(`REFUSED: not enough space for the backup (need ${need} B in ${storeRoot}, free ${free} B)`);
        return EXIT.REFUSED;
      }
    }
    const backupDir = path.join(storeRoot, `backup-${stampOf(now())}${BACKUP_SUFFIX}`);
    if (fs.existsSync(backupDir)) {
      print(`REFUSED: backup ${backupDir} already exists (backups are never overwritten) - nothing changed`);
      return EXIT.REFUSED;
    }
    try {
      fs.mkdirSync(backupDir, { recursive: true });
      backupInto(vendor.db, path.join(backupDir, VENDOR_FILE));
      backupInto(lne.db, path.join(backupDir, WORLD_BACKUP_FILE));
    } catch (err) {
      print(`FAILED: backup not created: ${messageOf(err)} - nothing changed`);
      return EXIT.FAILED;
    }
    print(`Backup: ${backupDir}`);

    const migrated = runMigrations(lne.db, MIGRATIONS, { randomSeed: () => {
      throw new Error("world_seed must already exist");
    } });
    if (!migrated.ok) {
      print(`FAILED: LNE migrations: ${migrated.reason} ${migrated.detail || ""} - nothing changed in the save`);
      return migrated.reason === "DB_LOCKED" ? EXIT.REFUSED : EXIT.FAILED;
    }
    let imported;
    try {
      const at = now();
      imported = lne.db.transaction(() => importTagsInTx(lne.db, {
        escrows: found.escrows.filter((c) => c.valid).map((c) => c.tag),
        wrecks: found.wrecks.filter((c) => c.valid).map((c) => c.tag),
        at,
      })).immediate();
    } catch (err) {
      print(`FAILED: tag import: ${messageOf(err)} - nothing changed in the save`);
      return EXIT.FAILED;
    }
    let stripped;
    try {
      stripped = vendor.db.transaction(() => stripInTx(vendor.db)).immediate();
    } catch (err) {
      print(`FAILED: strip: ${messageOf(err)} - the save is unchanged; the tags are already in the LNE database, `
        + "run --apply again");
      return EXIT.FAILED;
    }
    print(`Moved: imported=${imported.inserted} present=${imported.present} conflicts=${imported.conflicts} `
      + `stripped=${stripped} invalid=${found.counts.invalid} backupDir=${backupDir}`);
    if (imported.conflicts > 0) {
      print(`warning: ${imported.conflicts} tags differed from the LNE database; the LNE value was kept, `
        + "the vendor value is in the backup");
    }
    return EXIT.OK;
  } finally {
    closeQuietly(vendor.db);
    closeQuietly(lne.db);
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { NEEDED, USAGE, parseArgs, scan, main };
