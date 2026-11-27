"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { parseCampaigns, resolveActiveFactions, enabledFlagsOf } = require("../../lib/strategy");
const { OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { CAMPAIGNS_V1 } = require("../../lib/strategy/data/campaigns");
const { coreOwnerOf, getCoreIndex } = require("../../lib/world/core");
const { deriveSeed, createRng } = require("../../lib/util/rng");
const P = require("../../lib/world/invasions/rollPlanner");
const { buildSdeWorld, loadSecurityBand } = require("./sdeWorld");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_SDE_DIR = path.resolve(MOD_DIR, "..", "..", "_local", "sde", "eve-online-static-data-3396210-jsonl");
const DEFAULTS = Object.freeze({ rounds: 2000, weights: [1, 8, 16, 32, 64, 100], samples: [32, 64, 128],
  invader: 500021 });
const MAX_SAMPLE = 256;
const RULE = Object.freeze({ weights: [8, 16, 32, 64, 100], samples: [32, 64, 128], threshold: 0.4,
  fallback: { weight: 100, sample: 128 } });

function list(text, name) {
  const out = String(text).split(",").map((v) => Number(v.trim()));
  if (out.length === 0 || !out.every((v) => Number.isSafeInteger(v) && v >= 0)) throw new Error(`${name}: bad list`);
  return out;
}

function parseArgs(argv) {
  const opts = { db: null, sde: DEFAULT_SDE_DIR, seed: null, rounds: DEFAULTS.rounds, weights: DEFAULTS.weights,
    samples: DEFAULTS.samples, invader: DEFAULTS.invader, md: null, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--db") opts.db = next();
    else if (a === "--sde") opts.sde = next();
    else if (a === "--seed") opts.seed = Number(next());
    else if (a === "--rounds") opts.rounds = Number(next());
    else if (a === "--weights") opts.weights = list(next(), a);
    else if (a === "--samples") opts.samples = list(next(), a).map((k) => Math.max(1, k));
    else if (a === "--invader") opts.invader = Number(next());
    else if (a === "--md") opts.md = next();
    else if (a === "--json") opts.json = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.db) throw new Error("--db is required");
  if (opts.seed !== null && !(Number.isSafeInteger(opts.seed) && opts.seed >= 0)) throw new Error("--seed needs a uint");
  if (!Number.isSafeInteger(opts.rounds) || opts.rounds < 1) throw new Error("--rounds needs a positive integer");
  if (!Number.isSafeInteger(opts.invader) || opts.invader <= 0) throw new Error("--invader needs an id");
  return opts;
}

function buildRegistry(config) {
  const settings = config.strategy;
  const ctx = { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
    hostility: createHostility(), maxFactions: settings.maxRegistryFactions, maxCampaignSystems: settings.maxCampaignSystems,
    maxShipsPerFleet: config.fleets.maxShipsPerFleet, maxCompositionEntries: config.fleets.maxCompositionEntries,
    maxResourceUnits: settings.maxResourceUnits, activeCampaignIds: parseCampaigns(settings.campaigns),
    enabledFlags: enabledFlagsOf(config) };
  let built = createFactionRegistry(REGISTRY_DATA_V1, ctx);
  if (!built.ok) return built;
  const act = resolveActiveFactions(built.registry, settings.activeFactions, settings.maxActiveFactions,
    ctx.enabledFlags);
  if (!act.ok) return { ok: false, reason: "ACTIVE_FACTIONS_INVALID", detail: act.detail };
  if (act.wanted !== "registry") built = createFactionRegistry(REGISTRY_DATA_V1, { ...ctx, activeFactionIds: act.wanted });
  return built;
}

function recommend(table) {
  for (const k of RULE.samples) {
    const row = table[k];
    if (!row) continue;
    for (const w of RULE.weights) {
      if (row[w] && row[w].pActive >= RULE.threshold) return { weight: w, sample: k, note: null };
    }
  }
  return { weight: RULE.fallback.weight, sample: RULE.fallback.sample,
    note: `no (W, k) of the grid reaches P(active | target) >= ${RULE.threshold}fallback of` };
}

function computeTable(input) {
  const { pool, entries, eligible, defensible, seed, rounds, weights, samples, params } = input;
  const table = {};
  let oldRuleMismatch = 0;
  for (const k0 of samples) {
    const k = Math.min(k0, MAX_SAMPLE);
    const acc = Object.fromEntries(weights.map((w) => [w, { noTarget: 0, free: 0, active: 0, defensible: 0, other: 0 }]));
    let oldNoTarget = 0;
    let oldActive = 0;
    for (let r = 0; r < rounds; r += 1) {
      const sampled = P.sampleTargets(pool, createRng(deriveSeed(seed, "invasions", "sample", r)), k);
      let a = 0;
      let aDef = 0;
      let f = 0;
      let o = 0;
      let oldSum = 0;
      let oldA = 0;
      for (const id of sampled) {
        if (!eligible.has(id)) continue;
        const e = entries.get(id);
        if (e.category === P.CATEGORY_FREE) f += 1;
        else if (e.category === P.CATEGORY_ACTIVE) {
          a += 1;
          if (defensible.has(id)) aDef += 1;
        } else o += 1;
        const wOld = P.targetWeight({ row: e.row }, params);
        oldSum += wOld;
        if (e.category === P.CATEGORY_ACTIVE) oldA += wOld;
      }
      if (oldSum === 0) oldNoTarget += 1;
      else oldActive += oldA / oldSum;
      for (const w of weights) {
        const t = acc[w];
        const wf = P.targetWeight({ row: { controllerFactionId: null }, category: P.CATEGORY_FREE }, params);
        const wa = P.targetWeight({ row: { controllerFactionId: 0 }, category: P.CATEGORY_ACTIVE },
          { ...params, weightActive: w });
        const wo = P.targetWeight({ row: { controllerFactionId: 0 }, category: P.CATEGORY_OTHER }, params);
        const denom = wa * a + wf * f + wo * o;
        if (denom === 0) {
          t.noTarget += 1;
          continue;
        }
        t.free += (wf * f) / denom;
        t.active += (wa * a) / denom;
        t.defensible += (wa * aDef) / denom;
        t.other += (wo * o) / denom;
      }
    }
    const row = {};
    for (const w of weights) {
      const t = acc[w];
      const hit = rounds - t.noTarget;
      const cond = (v) => (hit > 0 ? v / hit : 0);
      row[w] = { pNoTarget: t.noTarget / rounds, pFree: cond(t.free), pActive: cond(t.active),
        pActiveDefensible: cond(t.defensible), pOther: cond(t.other) };
    }
    const oldHit = rounds - oldNoTarget;
    const oldP = oldHit > 0 ? oldActive / oldHit : 0;
    if (row[1] && (Math.abs(row[1].pActive - oldP) > 1e-12 || row[1].pNoTarget !== oldNoTarget / rounds)) {
      oldRuleMismatch += 1;
    }
    row.oldRule = { pNoTarget: oldNoTarget / rounds, pActive: oldP };
    table[k0] = row;
  }
  return { table, oldRuleMismatch };
}

function probe(opts) {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, reason: "SERVER_SRC_NOT_FOUND" };
  const driver = resolveSqliteDriver(found.srcDir);
  if (!driver || !driver.ok) return { ok: false, reason: "SQLITE_DRIVER_UNAVAILABLE" };
  const sde = buildSdeWorld(opts.sde);
  if (!sde.ok) return sde;
  const band = loadSecurityBand(found.srcDir);
  if (!band.ok) return band;
  const map = readStaticMapFrom(sde.world.worldData, band.band, {});
  if (!map.ok) return map;
  const built = buildUniverseGraph(map.map);
  if (!built.ok) return { ok: false, reason: "GRAPH_INVALID", detail: built.reason };
  const graph = built.graph;
  const resolved = resolveConfig({ modDir: MOD_DIR, env: {} });
  if (!resolved.ok) return { ok: false, reason: "CONFIG_INVALID" };
  const config = resolved.config;
  const reg = buildRegistry(config);
  if (!reg.ok) return { ok: false, reason: "REGISTRY_INVALID", detail: reg.detail };
  const registry = reg.registry;
  const inv = config.invasions;
  const params = { weightFree: inv.weightFree, weightActive: inv.weightActive, weightControlled: inv.weightControlled,
    avoidObservedSystems: inv.avoidObservedSystems, avoidStationSystems: inv.avoidStationSystems,
    avoidCampaignTheatres: inv.avoidCampaignTheatres };
  const cores = getCoreIndex(config);
  const defenseKind = OPERATION_KINDS_V1.find((k) => k.kind === "defense");
  const defenseRoles = defenseKind ? [...defenseKind.fleetRoles] : [];
  const pool = P.candidatePool(graph);
  const theatre = new Set(CAMPAIGNS_V1.filter((c) => parseCampaigns(config.strategy.campaigns).includes(c.campaignId))
    .flatMap((c) => c.systemIds));
  const db = new driver.Database(opts.db, { readonly: true, fileMustExist: true });
  try {
    const metaSeed = db.prepare("SELECT value FROM lne_meta WHERE key = 'world_seed'").get();
    const seed = opts.seed !== null ? opts.seed : metaSeed ? Number(metaSeed.value) : 0;
    const rows = new Map(db.prepare(`SELECT system_id AS id, occupation_state AS state,
      controller_faction_id AS controller FROM world_system_state`).all()
      .map((r) => [r.id, { occupationState: r.state, controllerFactionId: r.controller }]));
    const stations = new Map(db.prepare(`SELECT system_id AS id, count(*) AS n FROM world_stations
      WHERE state <> 'DESTROYED' GROUP BY 1`).all().map((r) => [r.id, r.n]));
    const beachheads = new Set(db.prepare("SELECT beachhead_system_id AS id FROM world_invasions WHERE open = 1").all()
      .map((r) => r.id));
    const roleIn = defenseRoles.map((r) => `'${r}'`).join(", ") || "''";
    const idleDefense = new Map();
    for (const r of db.prepare(`SELECT faction_id AS f, current_system_id AS s FROM virtual_fleets WHERE state = 'IDLE'
      AND fleet_role IN (${roleIn})`).all()) {
      if (!idleDefense.has(r.f)) idleDefense.set(r.f, new Set());
      idleDefense.get(r.f).add(r.s);
    }
    const combatFleets = new Map(db.prepare(`SELECT faction_id AS f, count(*) AS n FROM virtual_fleets
      WHERE state <> 'DESTROYED' AND fleet_role IN (${roleIn}) GROUP BY 1`).all().map((r) => [r.f, r.n]));
    const entries = new Map();
    const eligible = new Set();
    const defensible = new Set();
    const neighbors = (id) => graph.getNeighbors(id) || [];
    const perCategory = { free: 0, active: 0, other: 0 };
    const perActive = {};
    let eligibleInTheatre = 0;
    for (const id of pool) {
      const row = rows.get(id) || null;
      const e = { systemId: id, row, liveStations: stations.get(id) || 0, observed: false, claimed: false,
        inTheatre: false, openBeachhead: beachheads.has(id), core: coreOwnerOf(cores, id) !== null,
        category: P.controllerCategoryOf(row ? row.controllerFactionId : null, registry) };
      entries.set(id, e);
      if (!P.eligibleTarget(e, opts.invader, params)) continue;
      eligible.add(id);
      if (theatre.has(id)) eligibleInTheatre += 1;
      perCategory[e.category] += 1;
      if (e.category !== P.CATEGORY_ACTIVE) continue;
      const c = row.controllerFactionId;
      const idle = idleDefense.get(c);
      let def = false;
      if (idle) {
        const reach = bfs([id], neighbors, { maxJumps: config.strategy.maxAssemblyJumps,
          maxSystems: config.strategy.maxBfsSystems });
        def = [...idle].some((s) => reach.has(s));
      }
      if (def) defensible.add(id);
      const pa = perActive[c] || (perActive[c] = { eligibleSystems: 0, defensibleSystems: 0, combatFleets: 0 });
      pa.eligibleSystems += 1;
      if (def) pa.defensibleSystems += 1;
      pa.combatFleets = combatFleets.get(c) || 0;
    }
    const { table, oldRuleMismatch } = computeTable({ pool, entries, eligible, defensible, seed, rounds: opts.rounds,
      weights: opts.weights, samples: opts.samples, params });
    return { ok: true, db: opts.db, seed, rounds: opts.rounds, invader: opts.invader, poolSize: pool.length,
      eligible: eligible.size, eligibleInTheatre, theatreSystems: theatre.size, perCategory, perActive,
      params: { weightFree: params.weightFree, weightControlled: params.weightControlled,
        configWeightActive: params.weightActive, targetSampleSize: inv.targetSampleSize },
      defenseRoles, maxAssemblyJumps: config.strategy.maxAssemblyJumps, openBeachheads: [...beachheads].sort(),
      weights: opts.weights, samples: opts.samples, table, oldRuleMismatch, recommendation: recommend(table) };
  } finally {
    db.close();
  }
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

function formatMd(r) {
  const lines = [`### Roll probe: P(target category) on ${r.db}`, "",
    `- seed ${r.seed}, rounds ${r.rounds}, invader ${r.invader}; weightFree ${r.params.weightFree}, `
      + `weightControlled ${r.params.weightControlled} (config weightActive ${r.params.configWeightActive}, `
      + `targetSampleSize ${r.params.targetSampleSize})`,
    `- pool ${r.poolSize} systems; eligible now ${r.eligible}: free ${r.perCategory.free}, active ${r.perCategory.active}, `
      + `other ${r.perCategory.other}; open beachheads ${r.openBeachheads.join(", ") || "-"}`,
    "- observed = false (bench: presence off); claimed = false (bench adapter sovClaims.claimOf -> claimed:false)",
    `- theatre: inTheatre = false as in the service (listActiveCampaigns returns {ok, campaigns}; the for..of throws, `
      + `the catch gives false); eligible systems inside an active theatre (${r.theatreSystems} theatre systems): `
      + `${r.eligibleInTheatre}`,
    `- defensible = controller has an IDLE fleet of role ${r.defenseRoles.join("/")} within ${r.maxAssemblyJumps} `
      + "jumps of the target (refitPending not modelled)",
    `W = 1 equals the rule before (no category): ${r.oldRuleMismatch === 0 ? "yes" : `NO (${r.oldRuleMismatch} k)`}`,
    "", "P(...) below = conditional on a roll with a target; P(NO_TARGET) = share of rounds without any weight.", "",
    "| k | W | P(NO_TARGET) | P(free) | P(active) | P(active and defensible) | P(other) |",
    "|---|---|---|---|---|---|---|"];
  for (const k of r.samples) {
    for (const w of r.weights) {
      const c = r.table[k][w];
      lines.push(`| ${k} | ${w} | ${pct(c.pNoTarget)} | ${pct(c.pFree)} | ${pct(c.pActive)} | ${pct(c.pActiveDefensible)} `
        + `| ${pct(c.pOther)} |`);
    }
  }
  lines.push("", "| active controller | eligible systems | defensible systems | combat fleets (defense roles, live) |",
    "|---|---|---|---|");
  for (const [f, a] of Object.entries(r.perActive)) {
    lines.push(`| ${f} | ${a.eligibleSystems} | ${a.defensibleSystems} | ${a.combatFleets} |`);
  }
  const rec = r.recommendation;
  lines.push("", `Recommendation: weightActive = ${rec.weight}, targetSampleSize = ${rec.sample}`
    + `${rec.note ? ` - ${rec.note}` : ""}`);
  return `${lines.join("\n")}\n`;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`rollProbe: FAIL ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const r = probe(opts);
  if (!r.ok) {
    process.stdout.write(`rollProbe: FAIL ${r.reason}${r.detail ? ` ${r.detail}` : ""}\n`);
    process.exitCode = 1;
    return;
  }
  const md = formatMd(r);
  if (opts.md) fs.writeFileSync(opts.md, md);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(r, null, 2));
  process.stdout.write(md);
}

if (require.main === module) main();

module.exports = { probe, computeTable, recommend, formatMd, parseArgs };
