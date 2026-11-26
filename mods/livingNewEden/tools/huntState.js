"use strict";

const fs = require("node:fs");
const os = require("node:os");

const { loadConfig } = require("../config");
const { readSchemaVersion } = require("../lib/persistence/migrations");
const { pickCandidate, hasScanner, classifyStanding, isTarget } = require("../lib/playerHunt/policy");
const PH = require("../lib/playerHunt/schema");
const { parseHullGroupList } = require("../lib/fleets/schema");
const { FACTIONS_V1 } = require("../lib/strategy/data/factions");
const { FACTION_CATALOG } = require("../lib/strategy/data/factionCatalog");
const { CAPSULEER_FACTION_ID } = require("../lib/strategy/data/capsuleers");
const { EXIT, MOD_DIR, LOCKED_MESSAGE, messageOf, loadDriver, resolveDbFile, openLocked, closeQuietly, sideFilesOf,
  removeCreatedSideFiles, takeSnapshot } = require("./offlineDb");

const DEFAULT_RECENT = 10;
const DEFAULT_TOP = 20;
const MAX_FLEETS_PER_SYSTEM = 500;
const USAGE = "usage: node mods/livingNewEden/tools/huntState.js [--db <file>] [--snapshot] [--system <systemId>] "
  + "[--recent <n>] [--top <n>] [--names <galaxy-static.json>]";
const VALUE_ARGS = Object.freeze(["--db", "--system", "--recent", "--top", "--names"]);

function parseArgs(argv) {
  const out = { db: null, snapshot: false, system: null, recent: DEFAULT_RECENT, top: DEFAULT_TOP, names: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--snapshot") {
      out.snapshot = true;
      continue;
    }
    if (!VALUE_ARGS.includes(arg)) return { ok: false, detail: `unknown argument ${arg}` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return { ok: false, detail: `${arg} needs a value` };
    }
    i += 1;
    if (arg === "--db") out.db = value;
    else if (arg === "--names") out.names = value;
    else {
      const n = Number(value);
      const min = arg === "--recent" ? 0 : 1;
      if (!Number.isSafeInteger(n) || n < min) return { ok: false, detail: `${arg} needs an integer >= ${min}` };
      if (arg === "--system") out.system = n;
      else if (arg === "--recent") out.recent = n;
      else out.top = n;
    }
  }
  return { ok: true, ...out };
}

function factionInfo() {
  const names = new Map(FACTION_CATALOG.map((f) => [f.factionId, f.name]));
  const kinds = new Map(FACTIONS_V1.map((f) => [f.factionId, f.kind]));
  return {
    kindOf: (id) => kinds.get(id) || null,
    label: (id) => `${names.get(id) || "?"}(${id}, ${kinds.get(id) || "no kind"})`,
  };
}

function readSystemNames(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const data = parsed && parsed.data && parsed.data.systems ? parsed.data : parsed;
    const s = data && data.systems;
    if (!s || !Array.isArray(s.id) || !Array.isArray(s.name)) return { ok: false, detail: "no systems.id / name" };
    const map = new Map();
    s.id.forEach((id, i) => map.set(id, s.name[i]));
    return { ok: true, names: map };
  } catch (err) {
    return { ok: false, detail: messageOf(err) };
  }
}

const HUNT_COLUMNS = "hunt_id, fleet_id, faction_id, system_id, character_id, mode, state, standing, members_json, "
  + "seed, started_at, live_at, ended_at, end_reason, losses_json, updated_at, version";
const FLEET_COLUMNS = "fleet_id, faction_id, current_system_id, fleet_role, composition_json, ship_count, state, "
  + "operation_id, refit_pending, version, updated_at";

function tablesOf(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
}

function parseJson(text, fallback) {
  try {
    return text === null || text === undefined ? fallback : JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function toFleet(row) {
  return { fleetId: row.fleet_id, factionId: row.faction_id, systemId: row.current_system_id,
    fleetRole: row.fleet_role, composition: parseJson(row.composition_json, []), shipCount: row.ship_count,
    state: row.state, operationId: row.operation_id, refitPending: row.refit_pending === 1, version: row.version,
    updatedAt: row.updated_at };
}

function readFleet(db, fleetId) {
  const row = db.prepare(`SELECT ${FLEET_COLUMNS} FROM virtual_fleets WHERE fleet_id = ?`).get(fleetId);
  return row ? toFleet(row) : null;
}

function journalOf(db, huntId) {
  const prefix = `phunt:${huntId}:`;
  const rows = db.prepare("SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key >= ? "
    + "AND idempotency_key < ?").all(prefix, `${prefix.slice(0, -1)};`);
  const out = { claim: 0, lock: 0, live: 0, loss: 0, settle: 0, losses: 0, release: 0, other: 0 };
  for (const r of rows) {
    const rest = r.k.slice(prefix.length);
    if (rest === "settle:v1") out.settle += 1;
    else if (rest.startsWith("loss:")) out.loss += 1;
    else if (Object.prototype.hasOwnProperty.call(out, rest)) out[rest] += 1;
    else out.other += 1;
  }
  return out;
}

const sumCounts = (groups) => (Array.isArray(groups) ? groups : []).reduce((n, g) => n + (Number(g.count) || 0), 0);

function checkEnded(hunt, journal, fleet) {
  const problems = [];
  const destroyed = hunt.members.filter((m) => m && m.state === "DESTROYED").length;
  const lost = sumCounts(hunt.losses);
  if (journal.settle !== 1) problems.push(`settle:v1 = ${journal.settle} (expected 1)`);
  if (lost !== destroyed) problems.push(`losses_json ${lost} != DESTROYED in members ${destroyed}`);
  if (journal.loss !== destroyed) problems.push(`loss keys: ${journal.loss} != DESTROYED ${destroyed}`);
  if ((lost > 0) !== (journal.losses === 1)) problems.push(`losses key = ${journal.losses} with losses ${lost}`);
  const fleetDestroyed = fleet !== null && fleet.state === "DESTROYED";
  if (fleetDestroyed === (journal.release === 1)) {
    problems.push(`release key = ${journal.release} with fleet ${fleet ? fleet.state : "missing"}`);
  }
  return problems;
}

function startMinusLosses(hunt) {
  const byKey = new Map();
  const keyOf = (g) => `${g.hullGroup}/${g.typeId === null || g.typeId === undefined ? "-" : g.typeId}`;
  for (const m of hunt.members) byKey.set(keyOf(m), (byKey.get(keyOf(m)) || 0) + 1);
  for (const g of Array.isArray(hunt.losses) ? hunt.losses : []) {
    byKey.set(keyOf(g), (byKey.get(keyOf(g)) || 0) - (Number(g.count) || 0));
  }
  return byKey;
}

function compositionMap(composition) {
  const out = new Map();
  for (const g of Array.isArray(composition) ? composition : []) {
    const k = `${g.hullGroup}/${g.typeId === null || g.typeId === undefined ? "-" : g.typeId}`;
    out.set(k, (out.get(k) || 0) + (Number(g.count) || 0));
  }
  return out;
}

const mapText = (m) => [...m.entries()].filter(([, n]) => n !== 0).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  .map(([k, n]) => `${k}x${n}`).join(", ") || "(empty)";

function sameMap(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) if ((a.get(k) || 0) !== (b.get(k) || 0)) return false;
  return true;
}

function huntSettings(config) {
  const S = (config && config.playerHunt) || {};
  return {
    S,
    roles: PH.parseRoleList(S.roles) || [],
    scanner: parseHullGroupList(S.scannerHullGroups) || [],
    neutral: PH.parseNeutralPolicy(S.neutralPolicy) || {},
    thresholds: { hostileMax: S.hostileStandingMax, friendlyMin: S.friendlyStandingMin },
  };
}

function refusalOf(f, H, kindOf) {
  if (f.state !== "IDLE") return `state ${f.state}`;
  if (f.operationId !== null && f.operationId !== undefined) return `operation ${f.operationId}`;
  if (f.refitPending) return "refit_pending";
  if (!H.roles.includes(f.fleetRole)) return `role ${f.fleetRole} not in playerHunt.roles`;
  if (!(f.shipCount > 0)) return "0 ships";
  if (H.S.oversizeDetachmentEnabled !== true && f.shipCount > H.S.maxShipsPerHunt) return `${f.shipCount} ships > maxShipsPerHunt ${H.S.maxShipsPerHunt}`;
  if (f.factionId === CAPSULEER_FACTION_ID) return "capsuleer faction (excluded)";
  if (!kindOf(f.factionId)) return "faction without a kind";
  return null;
}

function targetsText(kind, H) {
  if (!kind) return "nobody";
  const neutral = isTarget(classifyStanding(0, H.thresholds), kind, H.neutral);
  return neutral ? `hostiles (<= ${H.S.hostileStandingMax}) and neutrals` : `hostiles only (<= ${H.S.hostileStandingMax})`;
}

function timeText(ms, now) {
  if (!Number.isSafeInteger(ms)) return "-";
  const ago = Math.round((now - ms) / 1000);
  return `${new Date(ms).toISOString()} (${ago} s ago)`;
}

function printHunt(print, db, row, ctx) {
  const hunt = { huntId: row.hunt_id, fleetId: row.fleet_id, members: parseJson(row.members_json, []),
    losses: parseJson(row.losses_json, null) };
  const counts = { PLANNED: 0, SPAWNED: 0, DESTROYED: 0 };
  for (const m of hunt.members) if (m && Object.prototype.hasOwnProperty.call(counts, m.state)) counts[m.state] += 1;
  const fleet = readFleet(db, row.fleet_id);
  const journal = journalOf(db, row.hunt_id);
  print(`- ${row.hunt_id}  state ${row.state}  mode ${row.mode}  system ${ctx.systemLabel(row.system_id)}`);
  print(`    faction ${ctx.factions.label(row.faction_id)}  prey ${row.character_id}  standing ${row.standing}`);
  print(`    start ${timeText(row.started_at, ctx.now)}  live ${timeText(row.live_at, ctx.now)}`
    + `  end ${timeText(row.ended_at, ctx.now)}`);
  print(`    members: ${hunt.members.length} (PLANNED ${counts.PLANNED}, SPAWNED ${counts.SPAWNED}, `
    + `DESTROYED ${counts.DESTROYED})`);
  if (row.state === "ENDED") print(`    end_reason ${row.end_reason}  losses_json ${row.losses_json}`);
  print(`    journal: claim=${journal.claim} lock=${journal.lock} live=${journal.live} loss=${journal.loss} `
    + `settle:v1=${journal.settle} losses=${journal.losses} release=${journal.release}`
    + `${journal.other > 0 ? ` other=${journal.other}` : ""}`);
  if (fleet === null) print(`    fleet ${row.fleet_id}: MISSING from virtual_fleets`);
  else {
    print(`    fleet now: state ${fleet.state}  ships ${fleet.shipCount}  version ${fleet.version}  `
      + `composition ${mapText(compositionMap(fleet.composition))}`);
  }
  if (row.state === "ENDED") {
    const problems = checkEnded(hunt, journal, fleet);
    print(`    exactly once: ${problems.length === 0 ? "OK" : `ERROR - ${problems.join("; ")}`}`);
    if (fleet !== null) {
      const expected = startMinusLosses(hunt);
      const same = sameMap(expected, compositionMap(fleet.composition));
      print(`    start - losses: ${mapText(expected)} -> ${same ? "matches the current composition"
        : "DIFFERS from the current composition (the fleet may have changed later: refit, another battle, a new hunt)"}`);
    }
  } else if (fleet !== null && fleet.state !== "MATERIALIZED") {
    print(`    WARNING: open hunt, but the fleet is not MATERIALIZED (${fleet.state})`);
  }
}

function printSystem(print, db, systemId, ctx) {
  const rows = db.prepare(`SELECT ${FLEET_COLUMNS} FROM virtual_fleets WHERE current_system_id = ? `
    + "ORDER BY fleet_id LIMIT ?").all(systemId, MAX_FLEETS_PER_SYSTEM);
  print("");
  print(`Fleets in system ${ctx.systemLabel(systemId)}: ${rows.length}`);
  for (const row of rows) {
    const f = toFleet(row);
    const kind = ctx.factions.kindOf(f.factionId);
    const candidate = pickCandidate([f], { roles: ctx.H.roles, maxShips: ctx.H.S.maxShipsPerHunt,
      oversizeOk: ctx.H.S.oversizeDetachmentEnabled === true, excludedFactions: [CAPSULEER_FACTION_ID], factionKindOf: ctx.factions.kindOf }) !== null;
    const why = refusalOf(f, ctx.H, ctx.factions.kindOf);
    const mode = hasScanner(f.composition, ctx.H.scanner) ? "SCAN" : "SWEEP";
    print(`- ${f.fleetId}  ${ctx.factions.label(f.factionId)}  role ${f.fleetRole}  state ${f.state}  `
      + `ships ${f.shipCount}  composition ${mapText(compositionMap(f.composition))}`);
    print(`    ${candidate ? `CANDIDATE mode ${mode}, hunts ${targetsText(kind, ctx.H)}`
      : `not hunting: ${why || "?"}`}`);
  }
}

function printCandidateSystems(print, db, ctx, top) {
  const bySystem = new Map();
  for (const row of db.prepare(`SELECT ${FLEET_COLUMNS} FROM virtual_fleets WHERE state = 'IDLE' `
    + "ORDER BY current_system_id, fleet_id").iterate()) {
    const f = toFleet(row);
    if (pickCandidate([f], { roles: ctx.H.roles, maxShips: ctx.H.S.maxShipsPerHunt,
      oversizeOk: ctx.H.S.oversizeDetachmentEnabled === true, excludedFactions: [CAPSULEER_FACTION_ID], factionKindOf: ctx.factions.kindOf }) === null) continue;
    const s = bySystem.get(f.systemId) || { scan: [], sweep: [] };
    (hasScanner(f.composition, ctx.H.scanner) ? s.scan : s.sweep).push(f);
    bySystem.set(f.systemId, s);
  }
  const line = (id, list) => `- ${ctx.systemLabel(id)}: ${list.map((f) => `${f.fleetId} `
    + `${ctx.factions.label(f.factionId)} ${f.shipCount} ships`).join("; ")}`;
  const scan = [...bySystem.entries()].filter(([, s]) => s.scan.length > 0);
  const sweep = [...bySystem.entries()].filter(([, s]) => s.sweep.length > 0);
  print("");
  print(`Systems with an IDLE candidate fleet with a scanner hull (${ctx.H.scanner.join(",")}) -> SCAN: ${scan.length}`);
  for (const [id, s] of scan.slice(0, top)) print(line(id, s.scan));
  if (scan.length > top) print(`... ${scan.length - top} more (--top)`);
  print(`Systems with an IDLE candidate fleet without a scanner -> SWEEP: ${sweep.length}`);
  for (const [id, s] of sweep.slice(0, top)) print(line(id, s.sweep));
  if (sweep.length > top) print(`... ${sweep.length - top} more (--top)`);
  print("Details of one system: --system <id>.");
}

function report(db, print, args, ctx) {
  try {
    const version = readSchemaVersion(db);
    if (!version.ok || version.version === 0) {
      print(`REFUSED: this is not a Living New Eden database (${version.reason || "EMPTY"}: ${version.detail || "-"})`);
      return EXIT.REFUSED;
    }
    print(`Schema: ${version.version}`);
    const S = ctx.H.S;
    print(`playerHunt (config of this process): enabled=${S.enabled === true} hostileMax=${S.hostileStandingMax} `
      + `friendlyMin=${S.friendlyStandingMin} neutralPolicy=${S.neutralPolicy} roles=${S.roles} `
      + `scanner=${S.scannerHullGroups} maxShips=${S.maxShipsPerHunt} cooldownMs=${S.cooldownMs}`);
    const tables = tablesOf(db);
    if (!tables.has(PH.TABLE_NAME)) {
      print(`Missing table ${PH.TABLE_NAME} (migration 47) - old mod image.`);
      return EXIT.OK;
    }
    const open = db.prepare(`SELECT ${HUNT_COLUMNS} FROM ${PH.TABLE_NAME} WHERE state IN ('CLAIMED','LIVE') `
      + "ORDER BY hunt_id").all();
    print("");
    print(`Open hunts (CLAIMED/LIVE): ${open.length}`);
    for (const row of open) printHunt(print, db, row, ctx);
    const ended = args.recent > 0 ? db.prepare(`SELECT ${HUNT_COLUMNS} FROM ${PH.TABLE_NAME} WHERE state = 'ENDED' `
      + "ORDER BY ended_at DESC, hunt_id LIMIT ?").all(args.recent) : [];
    const total = db.prepare(`SELECT state, count(*) AS n FROM ${PH.TABLE_NAME} GROUP BY state ORDER BY state`).all();
    print("");
    print(`Recently ended (${ended.length} of --recent ${args.recent}); in the table: `
      + `${total.map((t) => `${t.state}=${t.n}`).join(" ") || "empty"}`);
    for (const row of ended) printHunt(print, db, row, ctx);
    if (args.system !== null) printSystem(print, db, args.system, ctx);
    else printCandidateSystems(print, db, ctx, args.top);
    return EXIT.OK;
  } catch (err) {
    print(`FAILED: ${messageOf(err)}`);
    return EXIT.FAILED;
  }
}

const SNAPSHOT_PREFIX = "lne-hunt-state-";

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const env = opts.env || process.env;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`huntState: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  const { file, warnings } = resolveDbFile(args.db, env);
  print(`huntState (read-only${args.snapshot ? ", copy" : ""}): database ${file}`);
  for (const w of warnings) print(`  warning (config): ${w}`);
  if (!fs.existsSync(file)) {
    print("No database file.");
    return EXIT.OK;
  }
  const config = opts.config || (loadConfig({ modDir: MOD_DIR, env }).config || {});
  let systemLabel = (id) => String(id);
  if (args.names) {
    const names = readSystemNames(args.names);
    if (names.ok) systemLabel = (id) => (names.names.has(id) ? `${names.names.get(id)}(${id})` : String(id));
    else print(`  warning: --names unreadable (${names.detail}) - ids only`);
  }
  const ctx = { now: typeof opts.now === "function" ? opts.now() : Date.now(), factions: factionInfo(),
    H: huntSettings(config), systemLabel };
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`huntState: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }
  let snap = null;
  let target = file;
  if (args.snapshot) {
    try {
      snap = takeSnapshot(file, opts.tmpDir || os.tmpdir(), SNAPSHOT_PREFIX);
      target = snap.file;
    } catch (err) {
      print(`huntState: copy failed: ${messageOf(err)}`);
      return EXIT.FAILED;
    }
  }
  const sideBefore = snap ? null : sideFilesOf(file);
  const opened = openLocked(driver, target, { readonly: true });
  if (!opened.ok) {
    if (snap) fs.rmSync(snap.dir, { recursive: true, force: true });
    if (opened.reason === "LOCKED") {
      print(`${LOCKED_MESSAGE} Or run with --snapshot (a copy of the database, works while the server runs).`);
      return EXIT.REFUSED;
    }
    print(`huntState: cannot open the database: ${opened.detail}${snap ? " (the copy may be torn - retry)" : ""}`);
    return EXIT.FAILED;
  }
  const { db } = opened;
  let code;
  try {
    code = report(db, print, args, ctx);
  } finally {
    if (snap) {
      closeQuietly(db);
      try {
        fs.rmSync(snap.dir, { recursive: true, force: true });
      } catch (err) {
        print(`  warning: copy left behind ${snap.dir} (${messageOf(err)})`);
      }
    } else {
      const first = removeCreatedSideFiles(file, sideBefore);
      closeQuietly(db);
      const after = first.failed.length > 0 ? removeCreatedSideFiles(file, sideBefore, { only: first.failed })
        : { kept: [] };
      const kept = [...first.kept.filter((k) => !first.failed.includes(k.file)), ...after.kept];
      for (const k of kept) print(`  warning: file left behind ${k.file} (${k.detail})`);
    }
  }
  return code;
}

module.exports = { main, parseArgs, checkEnded, journalOf, refusalOf, readSystemNames, EXIT };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
