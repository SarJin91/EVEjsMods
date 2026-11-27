#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const Database = require("better-sqlite3");

const YIELD_SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);
const MINERALS = Object.freeze({
  34: "Tritanium", 35: "Pyerite", 36: "Mexallon", 37: "Isogen", 38: "Nocxium", 39: "Zydrine", 40: "Megacyte"
});
const MINERAL_KEYS = Object.freeze(Object.keys(MINERALS).map((id) => `type:${id}`));
const MS_PER_DAY = 86400000;
const MS_PER_HOUR = 3600000;
const PERMILLE = 1000;

const BOOSTER_GROUPS = Object.freeze(["porpoise", "orca", "rorqual"]);
const BARGE_EXHUMER_GROUPS = Object.freeze(["mining_barge", "exhumer"]);

const USAGE = `usage: node tools/measure/mining-capital.js <db-path> --since <ms> [--json] [--top <n>]

Arguments:
  <db-path>     Path to readonly SQLite database copy (world.sqlite)
  --since <ms>  Lower bound timestamp (ms since epoch) for ended_at/created_at (required, >= 48h window)
  --json        Output JSON (default: ASCII table)
  --top <n>     Top N belts per faction for detail (default: 5)
`;

function parseArgs(argv) {
  const args = { dbPath: null, since: null, json: false, top: 5, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--top") {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--top needs a positive integer\n${USAGE}`);
      args.top = n;
      i += 1;
    } else if (a === "--since") {
      const ms = Number(argv[i + 1]);
      if (!Number.isSafeInteger(ms) || ms <= 0) throw new Error(`--since needs a positive integer (ms)\n${USAGE}`);
      args.since = ms;
      i += 1;
    } else if (!a.startsWith("-") && args.dbPath === null) {
      args.dbPath = a;
    } else {
      throw new Error(`unknown argument ${a}\n${USAGE}`);
    }
  }
  if (args.help) return args;
  if (!args.dbPath) throw new Error(`missing <db-path>\n${USAGE}`);
  if (args.since === null) throw new Error(`missing --since <ms>\n${USAGE}`);
  return args;
}

function openDbReadonly(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`database not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

function getActiveFactions(db) {
  return db.prepare("SELECT faction_id FROM world_factions WHERE status = 'ACTIVE' ORDER BY faction_id").all()
    .map((r) => r.faction_id);
}

function parseFleetComposition(compJson) {
  if (!compJson) return [];
  try {
    const arr = JSON.parse(compJson);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function parseCargo(cargoJson) {
  if (!cargoJson) return {};
  try {
    const obj = JSON.parse(cargoJson);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}

function computeM1_tripsPerFleetPerDay(db, since, factions) {
  const out = {};
  for (const f of factions) {
    const row = db.prepare(`
      SELECT
        COUNT(*) AS trips,
        COUNT(DISTINCT fleet_id) AS fleets,
        MIN(ended_at) AS minEnded,
        MAX(ended_at) AS maxEnded
      FROM world_mining_trips
      WHERE faction_id = ? AND state = 'DELIVERED' AND ended_at IS NOT NULL AND ended_at >= ?
    `).get(f, since);
    if (row.fleets > 0 && row.maxEnded > row.minEnded) {
      const days = (row.maxEnded - row.minEnded) / MS_PER_DAY;
      out[f] = row.trips / row.fleets / days;
    } else {
      out[f] = 0;
    }
  }
  return out;
}

function computeM2_fleetComposition(db, since, factions) {
  const out = { boosterSharePermille: {}, bargeExhumerSharePermille: {}, avgMinersPerFleet: {} };
  for (const f of factions) {
    const fleets = db.prepare(`
      SELECT fleet_id, composition_json, fleet_role
      FROM virtual_fleets
      WHERE faction_id = ? AND state <> 'DESTROYED'
    `).all(f);

    let totalFleets = 0;
    let fleetsWithBooster = 0;
    let totalBargeExhumer = 0;
    let totalMiners = 0;
    let miningFleets = 0;

    for (const fl of fleets) {
      const comp = parseFleetComposition(fl.composition_json);
      const hasBooster = comp.some((c) => BOOSTER_GROUPS.includes(c.hullGroup));
      const bargeExhumerCount = comp
        .filter((c) => BARGE_EXHUMER_GROUPS.includes(c.hullGroup))
        .reduce((s, c) => s + c.count, 0);
      const minerCount = comp
        .filter((c) => ["mining_frigate", "mining_barge", "exhumer"].includes(c.hullGroup))
        .reduce((s, c) => s + c.count, 0);

      if (fl.fleet_role === "mining") {
        totalFleets += 1;
        if (hasBooster) fleetsWithBooster += 1;
        totalBargeExhumer += bargeExhumerCount;
        totalMiners += minerCount;
        miningFleets += 1;
      } else if (hasBooster) {
        totalFleets += 1;
        fleetsWithBooster += 1;
      }
    }

    out.boosterSharePermille[f] = totalFleets > 0 ? Math.round((fleetsWithBooster / totalFleets) * PERMILLE) : 0;
    out.bargeExhumerSharePermille[f] = totalFleets > 0 ? Math.round((totalBargeExhumer / totalFleets) * PERMILLE) : 0;
    out.avgMinersPerFleet[f] = miningFleets > 0 ? Number((totalMiners / miningFleets).toFixed(1)) : 0;
  }
  return out;
}

function computeM3_mineralYield(db, since, factions) {
  const out = { mineralUnitsPerDay: {}, mineralUnitsPerDayBySec: {}, bindingMineral: {} };

  const totals = db.prepare(`
    SELECT faction_id, mineral_units, updated_at
    FROM world_mining_totals
    WHERE faction_id IN (${factions.map(() => "?").join(",")})
  `).all(...factions);

  const totalMap = new Map();
  for (const r of totals) totalMap.set(r.faction_id, r.mineral_units);

  const trips = db.prepare(`
    SELECT faction_id, sec_class, delivered_json, ended_at
    FROM world_mining_trips
    WHERE faction_id IN (${factions.map(() => "?").join(",")})
      AND state = 'DELIVERED' AND ended_at IS NOT NULL AND ended_at >= ?
  `).all(...factions, since);

  const byFactionSec = new Map();
  const windowBounds = new Map();
  for (const r of trips) {
    const delivered = parseCargo(r.delivered_json);
    if (!byFactionSec.has(r.faction_id)) byFactionSec.set(r.faction_id, {});
    if (!byFactionSec.get(r.faction_id)[r.sec_class]) byFactionSec.get(r.faction_id)[r.sec_class] = {};
    const secMap = byFactionSec.get(r.faction_id)[r.sec_class];
    for (const [key, val] of Object.entries(delivered)) {
      secMap[key] = (secMap[key] || 0) + val;
    }
    const bounds = windowBounds.get(r.faction_id) || { minEnded: r.ended_at, maxEnded: r.ended_at };
    if (r.ended_at < bounds.minEnded) bounds.minEnded = r.ended_at;
    if (r.ended_at > bounds.maxEnded) bounds.maxEnded = r.ended_at;
    windowBounds.set(r.faction_id, bounds);
  }

  for (const f of factions) {
    const secMap = byFactionSec.get(f) || {};
    out.mineralUnitsPerDayBySec[f] = {};
    let totalMinerals = 0;
    const bounds = windowBounds.get(f);
    const windowDays = bounds && bounds.maxEnded > bounds.minEnded
      ? (bounds.maxEnded - bounds.minEnded) / MS_PER_DAY
      : Math.max(1, (Date.now() - since) / MS_PER_DAY);
    for (const sec of YIELD_SEC_CLASSES) {
      const minerals = secMap[sec] || {};
      let secTotal = 0;
      for (const k of MINERAL_KEYS) {
        const v = minerals[k] || 0;
        secTotal += v;
      }
      out.mineralUnitsPerDayBySec[f][sec] = Math.round(secTotal / windowDays);
      totalMinerals += out.mineralUnitsPerDayBySec[f][sec];
    }
    out.mineralUnitsPerDay[f] = totalMinerals;

    const titanRecipe = {
      "type:34": 315015000, "type:35": 1114500000, "type:36": 299377500,
      "type:37": 84337500, "type:38": 9041400, "type:39": 4541150, "type:40": 2268300
    };
    let worstRatio = Infinity;
    let binding = "type:34";
    for (const k of MINERAL_KEYS) {
      let available = 0;
      for (const sec of YIELD_SEC_CLASSES) {
        available += secMap[sec]?.[k] || 0;
      }
      available = available / windowDays;
      const needed = titanRecipe[k];
      if (available > 0) {
        const ratio = available / needed;
        if (ratio < worstRatio) {
          worstRatio = ratio;
          binding = k;
        }
      }
    }
    out.bindingMineral[f] = binding;
  }

  return { ...out, byFactionSec };
}

function computeM4_industryLeadTime(db, since, factions) {
  const out = { leadTimeMs: {}, industryNoMineralsPerDay: {}, industryJobCompletePerDay: {} };

  for (const f of factions) {
    const jobs = db.prepare(`
      SELECT job_id, hull_group, created_at, ended_at, state
      FROM world_production_jobs
      WHERE faction_id = ? AND hull_group IN ('porpoise','orca','rorqual')
        AND created_at >= ?
      ORDER BY created_at
    `).all(f, since);

    if (jobs.length === 0) {
      out.leadTimeMs[f] = null;
      out.industryNoMineralsPerDay[f] = 0;
      out.industryJobCompletePerDay[f] = 0;
      continue;
    }

    const firstJob = jobs[0];
    const deliveredJobs = jobs.filter((j) => j.state === "DELIVERED" && j.ended_at);
    let leadTimeMs = null;
    if (deliveredJobs.length > 0) {
      const firstDelivered = deliveredJobs.reduce((a, b) => a.ended_at < b.ended_at ? a : b);
      leadTimeMs = firstDelivered.ended_at - firstJob.created_at;
    }
    out.leadTimeMs[f] = leadTimeMs;

    const notes = db.prepare(`
      SELECT json_extract(payload, '$.note') AS note
      FROM world_event_journal
      WHERE aggregate_type = 'world_faction' AND aggregate_id = ?
        AND json_extract(payload, '$.note') IS NOT NULL
        AND created_at >= ?
    `).all(f, since);

    let noMinerals = 0;
    let jobComplete = 0;
    for (const n of notes) {
      if (n.note && n.note.startsWith("INDUSTRY_NO_MINERALS")) noMinerals += 1;
      if (n.note && n.note.startsWith("INDUSTRY_JOB_COMPLETE")) jobComplete += 1;
    }
    const minCreated = jobs[0].created_at;
    const maxCreated = jobs[jobs.length - 1].created_at;
    const windowDays = maxCreated > minCreated
      ? (maxCreated - minCreated) / MS_PER_DAY
      : Math.max(1, (Date.now() - since) / MS_PER_DAY);
    out.industryNoMineralsPerDay[f] = Math.round(noMinerals / windowDays);
    out.industryJobCompletePerDay[f] = Math.round(jobComplete / windowDays);
  }

  return out;
}

function computeM5_bufferPermille(db, factions) {
  const out = {};

  const MAX_FLEETS_PER_FACTION = 10;
  const MINERS_PER_FLEET_BASE = 3;
  const BOOSTED_MINERS_ORCA = 10;
  const BOOSTED_MINERS_RORQUAL = 15;

  const YIELD_FRIGATE = 390;
  const _YIELD_BARGE = 1410;
  const YIELD_EXHUMER = 1950;

  const AVG_FLEET_MINERALS_PER_TRIP =
    0.5 * (MINERS_PER_FLEET_BASE * YIELD_FRIGATE) +
    0.3 * (BOOSTED_MINERS_ORCA * YIELD_EXHUMER) +
    0.2 * (BOOSTED_MINERS_RORQUAL * YIELD_EXHUMER);
  const TRIPS_PER_DAY = 8;
  const BUFFER_DAYS = 7;

  for (const f of factions) {
    const mineralStock = db.prepare(`
      SELECT coalesce(sum(k.quantity), 0) AS total
      FROM world_station_stock k
      JOIN world_stations s ON s.station_id = k.station_id
      WHERE s.owner_faction_id = ? AND s.state = 'ONLINE' AND k.item_kind = 'mineral'
    `).get(f).total;

    const desired = MAX_FLEETS_PER_FACTION * AVG_FLEET_MINERALS_PER_TRIP * TRIPS_PER_DAY * BUFFER_DAYS;
    const permille = desired > 0 ? Math.min(PERMILLE, Math.round((mineralStock / desired) * PERMILLE)) : 0;

    out[f] = permille;
  }

  return out;
}

function computeDaysToHull(factions, mineralUnitsPerDayBySec, bindingMineral, byFactionSec) {
  const titanRecipe = {
    "type:34": 315015000, "type:35": 1114500000, "type:36": 299377500,
    "type:37": 84337500, "type:38": 9041400, "type:39": 4541150, "type:40": 2268300
  };
  const carrierRecipe = {
    "type:34": 2254500, "type:35": 8083500, "type:36": 2254500,
    "type:37": 630000, "type:38": 62402, "type:39": 31601, "type:40": 15771
  };

  const out = { daysToTitan: {}, daysToCarrier: {} };

  for (const f of factions) {
    out.daysToTitan[f] = {};
    out.daysToCarrier[f] = {};
    const binding = bindingMineral[f];
    const bindingTitan = titanRecipe[binding];
    const bindingCarrier = carrierRecipe[binding];
    const secMap = byFactionSec.get(f) || {};

    for (const sec of YIELD_SEC_CLASSES) {
      const dailyMinerals = mineralUnitsPerDayBySec[f]?.[sec] || 0;
      if (dailyMinerals > 0 && bindingTitan > 0) {
        const minerals = secMap[sec] || {};
        let bindingAmount = 0;
        let totalAmount = 0;
        for (const [k, v] of Object.entries(minerals)) {
          totalAmount += v;
          if (k === binding) bindingAmount += v;
        }
        const share = totalAmount > 0 ? bindingAmount / totalAmount : 1 / MINERAL_KEYS.length;
        const effectiveDaily = dailyMinerals * share;
        out.daysToTitan[f][sec] = Math.round(bindingTitan / effectiveDaily);
        out.daysToCarrier[f][sec] = Math.round(bindingCarrier / effectiveDaily);
      } else {
        out.daysToTitan[f][sec] = null;
        out.daysToCarrier[f][sec] = null;
      }
    }
  }

  return out;
}

function computeRiskScore(db, since, factions) {
  const out = {};
  for (const f of factions) {
    const destroyed = db.prepare(`
      SELECT count(*) AS n FROM virtual_fleets
      WHERE faction_id = ? AND fleet_role = 'mining' AND state = 'DESTROYED'
        AND (ended_at >= ? OR (ended_at IS NULL AND updated_at >= ?))
    `).get(f, since, since).n;

    const totalTrips = db.prepare(`
      SELECT count(*) AS n FROM world_mining_trips
      WHERE faction_id = ? AND ended_at IS NOT NULL AND ended_at >= ?
    `).get(f, since).n;

    out[f] = totalTrips > 0 ? Number((destroyed / totalTrips).toFixed(3)) : 0;
  }
  return out;
}

function computeFactionEconomyImpact(db, since, factions, mineralUnitsPerDay) {
  const out = {};
  for (const f of factions) {
    out[f] = { treasuryDrain: 0, mineralUnitsPerDay: mineralUnitsPerDay[f] || 0 };
  }
  return out;

}

function computeISKPerHour(db, since, factions, mineralUnitsPerDay) {
  const out = {};
  const avgISKPerMineral = 100;
  for (const f of factions) {
    out[f] = Math.round((mineralUnitsPerDay[f] || 0) * avgISKPerMineral / 24);
  }
  return out;
}

function computeOrePerHour(db, since, factions) {
  const out = { highsec: {}, lowsec: {}, nullsec: {} };
  for (const f of factions) {
    const bySec = db.prepare(`
      SELECT sec_class, sum(ore_units) AS ore, MIN(ended_at) AS minEnded, MAX(ended_at) AS maxEnded
      FROM world_mining_trips
      WHERE faction_id = ? AND state = 'DELIVERED' AND ended_at IS NOT NULL AND ended_at >= ?
      GROUP BY sec_class
    `).all(f, since);
    for (const r of bySec) {
      const windowHours = r.maxEnded > r.minEnded
        ? (r.maxEnded - r.minEnded) / MS_PER_HOUR
        : Math.max(1, (Date.now() - since) / MS_PER_HOUR);
      out[r.sec_class][f] = Math.round(r.ore / windowHours);
    }
    for (const sec of YIELD_SEC_CLASSES) {
      if (!out[sec][f]) out[sec][f] = 0;
    }
  }
  return out;
}

function evaluateRecommendations(M1, M2, M3, M4, M5, daysToTitan, daysToCarrier, factions) {
  const out = {};
  for (const f of factions) {
    const rec = {};
    rec.maxActiveIndustryJobsPerFaction = (M2.boosterSharePermille[f] || 0) >= 500 ? "PASS" : "FAIL";
    rec.maxIndustryJobsPerReview = (M4.industryJobCompletePerDay[f] || 0) > 0 ? "PASS" : "FAIL";
    rec.titanRecipePermille = (daysToTitan[f]?.nullsec || 999) <= 30 ? "PASS" : "FAIL";
    rec.supercarrierRecipePermille = (daysToCarrier[f]?.nullsec || 999) <= 7 ? "PASS" : "FAIL";
    rec.maxFleetsPerFaction = (M2.boosterSharePermille[f] >= 800 && (daysToTitan[f]?.nullsec || 999) > 30) ? "REVIEW" : "OK";
    out[f] = rec;
  }
  return out;
}

function printASCIITable(data) {
  console.log("=== MINING CAPITAL MEASUREMENT REPORT ===");
  console.log(`Scenario: ${data.scenario}`);
  console.log(`Duration: ${data.durationMinutes} minutes`);
  console.log(`Timestamp: ${data.timestamp}`);
  console.log("");

  console.log("--- M1: Trips per Fleet per Day ---");
  for (const [f, v] of Object.entries(data.M1_tripsPerFleetPerDay)) {
    console.log(`  Faction ${f}: ${v.toFixed(2)}`);
  }

  console.log("\n--- M2: Fleet Composition ---");
  for (const f of Object.keys(data.M2_boosterSharePermille)) {
    console.log(`  Faction ${f}: boosterShare=${(data.M2_boosterSharePermille[f]/10).toFixed(1)}%, bargeExhumerShare=${(data.M2_bargeExhumerSharePermille[f]/10).toFixed(1)}%, avgMiners=${data.M2_avgMinersPerFleet[f]}`);
  }

  console.log("\n--- M3: Mineral Yield per Day ---");
  for (const f of Object.keys(data.M3_mineralUnitsPerDay)) {
    console.log(`  Faction ${f}: total=${data.M3_mineralUnitsPerDay[f]}, binding=${data.M3_bindingMineral[f]}`);
    for (const sec of YIELD_SEC_CLASSES) {
      console.log(`    ${sec}: ${data.M3_mineralUnitsPerDayBySec[f]?.[sec] || 0}`);
    }
  }

  console.log("\n--- M4: Industry Lead Time ---");
  for (const f of Object.keys(data.M4_industryJobLeadTimeMs)) {
    const lt = data.M4_industryJobLeadTimeMs[f];
    console.log(`  Faction ${f}: leadTime=${lt ? (lt/MS_PER_HOUR).toFixed(1)+"h" : "none"}, noMinerals/day=${data.M4_industryNoMineralsPerDay[f]}, jobComplete/day=${data.M4_industryJobCompletePerDay[f]}`);
  }

  console.log("\n--- M5: Capital Ladder Buffer Permille ---");
  for (const [f, v] of Object.entries(data.M5_capitalLadderBufferPermille)) {
    console.log(`  Faction ${f}: ${v}‰`);
  }

  console.log("\n--- Days to Titan / Carrier (nullsec) ---");
  for (const f of Object.keys(data.daysToTitan)) {
    console.log(`  Faction ${f}: Titan=${data.daysToTitan[f].nullsec}d, Carrier=${data.daysToCarrier[f].nullsec}d`);
  }

  console.log("\n--- Recommendations ---");
  for (const [f, rec] of Object.entries(data.recommendations)) {
    console.log(`  Faction ${f}: ${JSON.stringify(rec)}`);
  }
}

function main(argv, opts = {}) {
  const print = opts.print || ((line) => process.stdout.write(`${line}\n`));
  const args = parseArgs(argv);
  if (args.help) { print(USAGE); return 0; }

  const MAX_SINCE = Date.now() - 172800000;
  if (args.since > MAX_SINCE) {
    console.error(`--since must be ≥ 48h ago (${new Date(MAX_SINCE).toISOString()})`);
    return 1;
  }

  const db = openDbReadonly(args.dbPath);
  const factions = getActiveFactions(db);
  const now = Date.now();
  const durationMinutes = Math.round((now - args.since) / 60000);

  const M1 = computeM1_tripsPerFleetPerDay(db, args.since, factions);
  const M2 = computeM2_fleetComposition(db, args.since, factions);
  const M3 = computeM3_mineralYield(db, args.since, factions);
  const M4 = computeM4_industryLeadTime(db, args.since, factions);
  const M5 = computeM5_bufferPermille(db, factions);
  const daysToHull = computeDaysToHull(factions, M3.mineralUnitsPerDayBySec, M3.bindingMineral, M3.byFactionSec);
  const riskScore = computeRiskScore(db, args.since, factions);
  const factionEconomyImpact = computeFactionEconomyImpact(db, args.since, factions, M3.mineralUnitsPerDay);
  const iskPerHour = computeISKPerHour(db, args.since, factions, M3.mineralUnitsPerDay);
  const orePerHour = computeOrePerHour(db, args.since, factions);
  const recommendations = evaluateRecommendations(M1, M2, M3, M4, M5, daysToHull.daysToTitan, daysToHull.daysToCarrier, factions);

  const output = {
    scenario: "mining-capital-measure",
    durationMinutes,
    iskPerHour,
    orePerHour,
    riskScore,
    factionEconomyImpact,
    M1_tripsPerFleetPerDay: M1,
    M2_boosterSharePermille: M2.boosterSharePermille,
    M2_bargeExhumerSharePermille: M2.bargeExhumerSharePermille,
    M2_avgMinersPerFleet: M2.avgMinersPerFleet,
    M3_mineralUnitsPerDay: M3.mineralUnitsPerDay,
    M3_mineralUnitsPerDayBySec: M3.mineralUnitsPerDayBySec,
    M3_bindingMineral: M3.bindingMineral,
    M4_industryJobLeadTimeMs: M4.leadTimeMs,
    M4_industryNoMineralsPerDay: M4.industryNoMineralsPerDay,
    M4_industryJobCompletePerDay: M4.industryJobCompletePerDay,
    M5_capitalLadderBufferPermille: M5,
    daysToTitan: daysToHull.daysToTitan,
    daysToCarrier: daysToHull.daysToCarrier,
    recommendations,
    timestamp: new Date().toISOString()
  };

  if (args.json) {
    print(JSON.stringify(output, null, 2));
  } else {
    printASCIITable(output);
  }

  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err && err.message) || err}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArgs };