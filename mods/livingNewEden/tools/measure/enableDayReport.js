#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { parseBackupName } = require("../../lib/persistence/backupRules");
const { MINERALS } = require("../../lib/economy/data/mineralYield");

const DAY_MS = 86400000;
const PERMILLE = 1000;
const NATIVE_BS_FACTIONS = Object.freeze([500019, 500021, 500026, 500029]);
const RAID_FACTION = 500026;
const EMPIRE_FACTIONS = Object.freeze([500001, 500002, 500003, 500004]);
const CAPITAL_GROUPS = Object.freeze(["carrier", "dreadnought", "force_auxiliary", "supercarrier", "titan"]);
const TITAN = "titan";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const STRATEGIC_TYPES = Object.freeze(["invasion", "recon", "raid"]);
const MINERAL_KIND = "mineral";
const STATION_ONLINE = "ONLINE";
const USAGE = "usage: enableDayReport.js --db <file> [--since <ms|ISO>] [--until <ms|ISO>] [--factions <id,id>]"
  + " [--json]";
const MOD_DIR = path.resolve(__dirname, "..", "..");

class UsageError extends Error {}

const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
const dateOf = (day) => isoOf(day * DAY_MS).slice(0, 10);
const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const nat = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const marks = (list) => list.map(() => "?").join(",");
const messageOf = (e) => String((e && e.message) || e);

function permilleOf(value, permille) {
  const v = nat(value);
  const p = nat(permille);
  return Math.floor(v / PERMILLE) * p + Math.floor(((v % PERMILLE) * p) / PERMILLE);
}

function section(fn) {
  try {
    return { ok: true, ...fn() };
  } catch (e) {
    return { ok: false, reason: "READ_FAILED", detail: messageOf(e) };
  }
}

function readDefense(db, since, until) {
  const rows = db.prepare(`SELECT p.faction_id AS faction_id, COUNT(DISTINCT b.battle_id) AS battles,
      COUNT(DISTINCT CASE WHEN b.state = 'COMPLETED' THEN b.battle_id END) AS completed,
      COUNT(DISTINCT CASE WHEN json_extract(b.result_json, '$.outcome') = 'B_WIN' THEN b.battle_id END) AS b_win,
      COUNT(DISTINCT CASE WHEN json_extract(b.result_json, '$.outcome') = 'A_WIN' THEN b.battle_id END) AS a_win
    FROM battle_participants p JOIN battle_records b ON b.battle_id = p.battle_id
    WHERE p.side = 'B' AND p.faction_id IN (${marks(NATIVE_BS_FACTIONS)}) AND b.created_at >= ? AND b.created_at <= ?
    GROUP BY p.faction_id`).all(...NATIVE_BS_FACTIONS, since, until);
  const byId = new Map(rows.map((r) => [num(r.faction_id), r]));
  return { factions: NATIVE_BS_FACTIONS.map((f) => {
    const r = byId.get(f);
    return { factionId: f, battles: num(r && r.battles), completed: num(r && r.completed), bWin: num(r && r.b_win),
      aWin: num(r && r.a_win) };
  }) };
}

function readRaids(db, since, until) {
  const days = db.prepare(`SELECT planned_at / ${DAY_MS} AS day, operation_type, COUNT(*) AS n FROM world_operations
    WHERE faction_id = ? AND planned_at >= ? AND planned_at <= ? GROUP BY day, operation_type
    ORDER BY day, operation_type`)
    .all(RAID_FACTION, since, until).map((r) => ({ day: num(r.day), operationType: r.operation_type, count: num(r.n) }));
  const open = db.prepare(`SELECT operation_type, COUNT(*) AS n FROM world_operations
    WHERE faction_id = ? AND state IN (${marks(OPEN_OPERATION_STATES)}) GROUP BY operation_type ORDER BY operation_type`)
    .all(RAID_FACTION, ...OPEN_OPERATION_STATES).map((r) => ({ operationType: r.operation_type, count: num(r.n) }));
  const raid = open.find((o) => o.operationType === "raid");
  return { factionId: RAID_FACTION, days, open, openRaids: raid ? raid.count : 0 };
}

function readCapitalJobs(db, since, until) {
  const jobs = db.prepare(`SELECT faction_id, hull_group, state, end_reason, COUNT(*) AS jobs, SUM(runs) AS runs
    FROM world_production_jobs WHERE hull_group IN (${marks(CAPITAL_GROUPS)}) AND started_at >= ? AND started_at <= ?
    GROUP BY faction_id, hull_group, state, end_reason ORDER BY faction_id, hull_group, state, end_reason`)
    .all(...CAPITAL_GROUPS, since, until).map((r) => ({ factionId: num(r.faction_id), hullGroup: r.hull_group, state: r.state,
      endReason: r.end_reason === undefined ? null : r.end_reason, jobs: num(r.jobs), runs: num(r.runs) }));
  return { jobs };
}

function readTreasuryDays(db, since, until) {
  const rows = db.prepare(`SELECT faction_id, day, income, fleet_upkeep, admin, war_spend, production_fees, trade_out,
      losses, balance_end FROM world_faction_treasury_days WHERE day >= ? AND day <= ? ORDER BY faction_id, day`)
    .all(Math.floor(since / DAY_MS), Math.floor(until / DAY_MS)).map((r) => ({ factionId: num(r.faction_id), day: num(r.day), income: num(r.income),
      fleetUpkeep: num(r.fleet_upkeep), admin: num(r.admin), warSpend: num(r.war_spend),
      productionFees: num(r.production_fees), tradeOut: num(r.trade_out), losses: num(r.losses),
      balanceEnd: num(r.balance_end) }));
  return { rows };
}

function readEmpireLaunches(db, since, until) {
  const rows = db.prepare(`SELECT faction_id, operation_type, COUNT(*) AS n FROM world_operations
    WHERE faction_id IN (${marks(EMPIRE_FACTIONS)}) AND planned_at >= ? AND planned_at <= ?
    GROUP BY faction_id, operation_type ORDER BY faction_id, operation_type`)
    .all(...EMPIRE_FACTIONS, since, until).map((r) => ({ factionId: num(r.faction_id), operationType: r.operation_type,
      count: num(r.n) }));
  return { factions: EMPIRE_FACTIONS.map((f) => {
    const types = rows.filter((r) => r.factionId === f).map(({ operationType, count }) => ({ operationType, count }));
    const strategic = types.filter((t) => STRATEGIC_TYPES.includes(t.operationType)).reduce((s, t) => s + t.count, 0);
    return { factionId: f, types, strategic };
  }) };
}

function readStationMinerals(db, factions) {
  const only = Array.isArray(factions) && factions.length > 0;
  const rows = db.prepare(`SELECT s.owner_faction_id AS faction_id, s.station_id, s.system_id, s.kind, k.item_key,
      k.quantity FROM world_stations s LEFT JOIN world_station_stock k ON k.station_id = s.station_id
      AND k.item_kind = ? WHERE s.state = ?${only ? ` AND s.owner_faction_id IN (${marks(factions)})` : ""}
    ORDER BY s.owner_faction_id, s.station_id, k.item_key`)
    .all(MINERAL_KIND, STATION_ONLINE, ...(only ? factions : []));
  const stations = [];
  let cur = null;
  for (const r of rows) {
    if (!cur || cur.stationId !== r.station_id) {
      cur = { factionId: num(r.faction_id), stationId: r.station_id, systemId: num(r.system_id), kind: r.kind,
        minerals: {} };
      stations.push(cur);
    }
    if (r.item_key !== null && r.item_key !== undefined) cur.minerals[r.item_key] = num(r.quantity);
  }
  return { stations };
}

function windowOf(at, journalAt, opts) {
  const untilGiven = Number.isSafeInteger(opts.until);
  const until = untilGiven ? opts.until : at;
  if (Number.isSafeInteger(opts.since)) return { since: opts.since, until, sinceSource: "argument" };
  if (untilGiven) return { since: until - DAY_MS, until, sinceSource: "until" };
  return { since: at - DAY_MS, until, sinceSource: journalAt !== null ? "journal" : "fallback" };
}

function readJournalAt(db) {
  const row = db.prepare("SELECT created_at FROM world_event_journal ORDER BY journal_id DESC LIMIT 1").get();
  return row ? num(row.created_at) : null;
}

function readReport(dbFile, opts = {}) {
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    let journalAt = null;
    try {
      journalAt = readJournalAt(db);
    } catch (_e) {
      journalAt = null;
    }
    const at = journalAt !== null ? journalAt : opts.fallbackAt;
    const { since, until, sinceSource } = windowOf(at, journalAt, opts);
    if (since > until) return { at, since, until, sinceSource, windowError: true, sections: null };
    return { at, since, until, sinceSource, sections: {
      defense: section(() => readDefense(db, since, until)),
      raids: section(() => readRaids(db, since, until)),
      capitalJobs: section(() => readCapitalJobs(db, since, until)),
      treasuryDays: section(() => readTreasuryDays(db, since, until)),
      empireLaunches: section(() => readEmpireLaunches(db, since, until)),
      stationMinerals: section(() => readStationMinerals(db, opts.factions)),
    } };
  } finally {
    db.close();
  }
}

function warParamsOf(config) {
  try {
    const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
    const { createHullValueTable } = require("../../lib/economy/treasury/hullValues");
    const { REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE } = require("../../lib/economy/data/mineralRefPrices");
    const { feeOf } = require("../../lib/economy/treasury/austerity");
    const recipes = createRecipeTable(require("../../lib/economy/data/hullRecipes"), recipeParamsOf(config.production));
    const values = createHullValueTable(recipes, REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE);
    const T = config.treasury || {};
    const titanValue = values.valueOf(TITAN);
    if (!Number.isSafeInteger(titanValue)) return { ok: false, reason: "NO_TITAN_VALUE", detail: String(titanValue) };
    return { ok: true, titanValue, titanFee: feeOf(1, titanValue, T.productionFeePermille), T: {
      pressureEnabled: T.pressureEnabled === true, warRoomRollingEnabled: T.warRoomRollingEnabled === true,
      productionFeePermille: T.productionFeePermille, savingsDrawPermillePerDay: T.savingsDrawPermillePerDay,
      productionRoomSharePermille: T.productionRoomSharePermille, lossesInRoomPermille: T.lossesInRoomPermille } };
  } catch (e) {
    return { ok: false, reason: "WAR_PARAMS_FAILED", detail: messageOf(e) };
  }
}

function warRoomDays(rows, war, warChest) {
  const rolling = war.T.warRoomRollingEnabled === true;
  return rows.map((r) => {
    const x = { balanceIsk: r.balanceEnd, incomeDaily: r.income, fleetUpkeepDaily: r.fleetUpkeep,
      adminDaily: r.admin, at: (r.day + 1) * DAY_MS - 1,
      today: { warSpend: r.warSpend, productionFees: r.productionFees, tradeOut: r.tradeOut, losses: r.losses } };
    const w = rolling ? warChest.warRoomRollingOf({ ...x, yesterday: null }, war.T) : warChest.warRoomOf(x, war.T);
    const capFull = permilleOf(w.accrued, war.T.productionRoomSharePermille);
    const capLeft = permilleOf(w.room, war.T.productionRoomSharePermille);
    return { factionId: r.factionId, day: r.day, dayBudget: w.dayBudget, spent: w.spentToday, capFull, capLeft,
      titanFits: capFull >= war.titanFee };
  });
}

function mineralParamsOf(config) {
  try {
    const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
    const { parseHullGroupList } = require("../../lib/fleets/schema");
    const P = config.production || {};
    const table = createRecipeTable(require("../../lib/economy/data/hullRecipes"), recipeParamsOf(P));
    const recipes = {};
    for (const g of table.groups) {
      const r = table.lookup(g);
      if (r) recipes[g] = r.minerals;
    }
    return { ok: true, recipes, lines: { npc: nat(P.linesPerNpcStation), upwell: nat(P.linesPerUpwellStation) },
      freeGroups: parseHullGroupList(P.freeHullGroups) || [] };
  } catch (e) {
    return { ok: false, reason: "MINERAL_PARAMS_FAILED", detail: messageOf(e) };
  }
}

function bindingMinerals(stations, mp) {
  const byFaction = new Map();
  for (const s of stations) {
    const lines = s.kind === "npc" ? mp.lines.npc : (s.kind === "upwell" ? mp.lines.upwell : 0);
    if (!(lines > 0)) continue;
    const blocked = [];
    for (const g of Object.keys(mp.recipes)) {
      if (mp.freeGroups.includes(g)) continue;
      const recipe = mp.recipes[g];
      const keys = Object.keys(recipe);
      if (keys.length === 0 || keys.every((k) => (s.minerals[k] || 0) >= recipe[k])) continue;
      let pick = null;
      for (const k of keys) {
        const stock = s.minerals[k] || 0;
        const permille = Math.floor((stock * PERMILLE) / recipe[k]);
        if (!pick || permille < pick.permille) pick = { mineral: k, stock, need: recipe[k], permille };
      }
      blocked.push({ hullGroup: g, ...pick, missing: pick.need - pick.stock });
    }
    if (!byFaction.has(s.factionId)) byFaction.set(s.factionId, { factionId: s.factionId, stations: [], binding: {} });
    const f = byFaction.get(s.factionId);
    f.stations.push({ stationId: s.stationId, systemId: s.systemId, kind: s.kind, lines, minerals: { ...s.minerals },
      blocked });
    for (const b of blocked) f.binding[b.mineral] = (f.binding[b.mineral] || 0) + 1;
  }
  return [...byFaction.values()];
}

function buildReport(raw, war, warChest, configErrors = [], mineral = null) {
  const s = raw.sections;
  let bindingSection;
  if (!s.stationMinerals || !s.stationMinerals.ok) {
    bindingSection = s.stationMinerals || { ok: false, reason: "READ_FAILED", detail: "no section" };
  } else if (!mineral || !mineral.ok) {
    bindingSection = { ok: false, reason: (mineral && mineral.reason) || "MINERAL_PARAMS_FAILED",
      detail: (mineral && mineral.detail) || "" };
  } else {
    bindingSection = section(() => ({ factions: bindingMinerals(s.stationMinerals.stations, mineral) }));
  }
  let warRoomSection;
  if (!s.treasuryDays.ok) warRoomSection = s.treasuryDays;
  else if (!war.ok) warRoomSection = { ok: false, reason: war.reason, detail: war.detail };
  else {
    warRoomSection = { ok: true, titanValue: war.titanValue, titanFee: war.titanFee, params: war.T,
      days: warRoomDays(s.treasuryDays.rows, war, warChest) };
  }
  if (configErrors.length > 0) warRoomSection = { ...warRoomSection, configErrors: [...configErrors] };
  return { at: raw.at, since: raw.since, until: raw.until, sinceSource: raw.sinceSource, defense: s.defense,
    raids: s.raids, capitalJobs: s.capitalJobs, warRoom: warRoomSection, empireLaunches: s.empireLaunches,
    bindingMinerals: bindingSection };
}

const mineralName = (k) => {
  const m = /^type:(\d+)$/.exec(k);
  return (m && MINERALS[m[1]]) || k;
};

const failLine = (sec) => `  READ FAILED ${sec.reason}${sec.detail ? ` - ${sec.detail}` : ""}`;

function formatReport(r) {
  const out = [`window [${isoOf(r.since)}, ${isoOf(r.until)}] since=${r.sinceSource}`
    + `${r.until !== r.at ? ` at=${isoOf(r.at)}` : ""}`];
  out.push("[1] defense battles of the native BS factions (side B)");
  if (!r.defense.ok) out.push(failLine(r.defense));
  else {
    for (const f of r.defense.factions) {
      out.push(`  ${f.factionId} battles=${f.battles} completed=${f.completed} B_WIN=${f.bWin} A_WIN=${f.aWin}`);
    }
  }
  out.push(`[2] operations of ${RAID_FACTION} per day and type`);
  if (!r.raids.ok) out.push(failLine(r.raids));
  else {
    const days = [...new Set(r.raids.days.map((d) => d.day))];
    if (days.length === 0) out.push("  (none)");
    for (const day of days) {
      out.push(`  ${dateOf(day)} ${r.raids.days.filter((d) => d.day === day).map((d) => `${d.operationType}=${d.count}`)
        .join(" ")}`);
    }
    out.push(`  open raids=${r.raids.openRaids} open: ${r.raids.open.map((o) => `${o.operationType}=${o.count}`).join(" ")
      || "(none)"}`);
  }
  out.push("[3] capital production jobs started since the window start");
  if (!r.capitalJobs.ok) out.push(failLine(r.capitalJobs));
  else {
    if (r.capitalJobs.jobs.length === 0) out.push("  (none)");
    for (const j of r.capitalJobs.jobs) {
      out.push(`  ${j.factionId} ${j.hullGroup} ${j.state}${j.endReason ? `/${j.endReason}` : ""} jobs=${j.jobs} `
        + `runs=${j.runs}`);
    }
  }
  out.push("[4] war room of the day rows vs the fee of one titan run (estimate, capFull = upper bound)");
  if (r.warRoom.configErrors) out.push(`  configErrors=${r.warRoom.configErrors.join("; ")}`);
  if (!r.warRoom.ok) out.push(failLine(r.warRoom));
  else {
    const p = r.warRoom.params;
    out.push(`  titanValue=${r.warRoom.titanValue} titanFee=${r.warRoom.titanFee} pressure=${p.pressureEnabled}`
      + ` rolling=${p.warRoomRollingEnabled} feePermille=${p.productionFeePermille}`
      + ` roomSharePermille=${p.productionRoomSharePermille} drawPermille=${p.savingsDrawPermillePerDay}`);
    if (r.warRoom.days.length === 0) out.push("  (none)");
    for (const d of r.warRoom.days) {
      out.push(`  ${d.factionId} ${dateOf(d.day)} dayBudget=${d.dayBudget} spent=${d.spent} capFull=${d.capFull}`
        + ` capLeft=${d.capLeft} titanFits=${d.titanFits ? "yes" : "no"}`);
    }
  }
  out.push("[5] operations of the empires per type (LAUNCH + services)");
  if (!r.empireLaunches.ok) out.push(failLine(r.empireLaunches));
  else {
    for (const f of r.empireLaunches.factions) {
      out.push(`  ${f.factionId} ${f.types.map((t) => `${t.operationType}=${t.count}`).join(" ") || "(none)"}`);
      out.push(`  ${f.factionId} strategic(${STRATEGIC_TYPES.join("+")})=${f.strategic}`);
    }
  }
  out.push("[6] binding mineral per production station (state of the copy, raw stock, 1 run per blocked group)");
  if (!r.bindingMinerals.ok) out.push(failLine(r.bindingMinerals));
  else {
    if (r.bindingMinerals.factions.length === 0) out.push("  (none)");
    for (const f of r.bindingMinerals.factions) {
      for (const st of f.stations) {
        const stock = Object.keys(st.minerals).map((k) => `${mineralName(k)}=${st.minerals[k]}`).join(" ");
        out.push(`  ${f.factionId} ${st.stationId} sys=${st.systemId} ${st.kind} lines=${st.lines}`
          + ` ${stock || "(no minerals)"}`);
        for (const b of st.blocked) {
          out.push(`    ${b.hullGroup} binding=${mineralName(b.mineral)} ${b.stock}/${b.need} permille=${b.permille}`
            + ` missing=${b.missing}`);
        }
      }
      const counts = Object.keys(f.binding).sort().map((k) => `${mineralName(k)}=${f.binding[k]}`).join(" ");
      out.push(`  ${f.factionId} binding: ${counts || "(none blocked)"}`);
    }
  }
  return out;
}

function parseTime(flag, v) {
  if (v === undefined) throw new UsageError(`${flag} needs ms or an ISO time`);
  if (/^\d+$/.test(v)) {
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw new UsageError(`${flag} ${v} out of range`);
    return n;
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new UsageError(`${flag} ${v} is neither ms nor an ISO time`);
  return t;
}

function parseFactions(v) {
  if (v === undefined) throw new UsageError("--factions needs a list of faction ids");
  const ids = v.split(",").map((x) => x.trim());
  if (ids.some((x) => !/^\d+$/.test(x) || !(nat(Number(x)) > 0))) {
    throw new UsageError(`--factions ${v} is not a list of faction ids`);
  }
  return [...new Set(ids.map(Number))];
}

function parseArgs(argv) {
  const out = { db: null, since: null, until: null, factions: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--db") {
      out.db = argv[i + 1];
      i += 1;
      if (!out.db) throw new UsageError("--db needs a file");
    } else if (a === "--since") {
      out.since = parseTime("--since", argv[i + 1]);
      i += 1;
    } else if (a === "--until") {
      out.until = parseTime("--until", argv[i + 1]);
      i += 1;
    } else if (a === "--factions") {
      out.factions = parseFactions(argv[i + 1]);
      i += 1;
    } else if (a === "--json") {
      out.json = true;
    } else {
      throw new UsageError(`unknown argument ${a}`);
    }
  }
  if (!out.db) throw new UsageError("--db is required");
  if (out.since !== null && out.until !== null && out.until < out.since) {
    throw new UsageError("--until is before --since");
  }
  return out;
}

function loadModConfig() {
  const { loadConfig } = require("../../config");
  return loadConfig({ modDir: MOD_DIR, env: process.env });
}

function configOf(loaded) {
  const l = loaded || {};
  const errors = l.ok === false ? (Array.isArray(l.errors) && l.errors.length > 0 ? l.errors : ["ok=false"]) : [];
  return { config: l.config || {}, errors: errors.map(String) };
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
    if (!fs.existsSync(args.db)) throw new UsageError(`--db ${args.db} not found`);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`enableDayReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const parsed = parseBackupName(path.basename(args.db));
  const fallbackAt = parsed.ok ? parsed.atMs : (io.now ? io.now() : Date.now());
  let raw;
  try {
    raw = readReport(args.db, { Database: io.Database, since: args.since, until: args.until, fallbackAt,
      factions: args.factions });
  } catch (e) {
    err(`enableDayReport: open failed - ${messageOf(e)}`);
    return 2;
  }
  if (raw.windowError) {
    err(`enableDayReport: --until ${isoOf(raw.until)} is before --since ${isoOf(raw.since)} (${USAGE})`);
    return 1;
  }
  let war;
  let mineral;
  let configErrors = [];
  try {
    const c = configOf(io.config ? { ok: true, config: io.config } : (io.loadConfig || loadModConfig)());
    configErrors = c.errors;
    war = warParamsOf(c.config);
    mineral = mineralParamsOf(c.config);
  } catch (e) {
    war = { ok: false, reason: "CONFIG_FAILED", detail: messageOf(e) };
    mineral = war;
  }
  const report = buildReport(raw, war, require("../../lib/strategy/ai/warChest"), configErrors, mineral);
  if (args.json) out(JSON.stringify({ db: args.db, ...report }));
  else for (const line of formatReport(report)) out(line);
  return 0;
}

module.exports = { readReport, warParamsOf, mineralParamsOf, bindingMinerals, warRoomDays, buildReport, formatReport,
  parseArgs, main, DAY_MS,
  NATIVE_BS_FACTIONS, EMPIRE_FACTIONS, RAID_FACTION, CAPITAL_GROUPS };

if (require.main === module || module.id === "[stdin]") process.exitCode = main(process.argv.slice(2));
