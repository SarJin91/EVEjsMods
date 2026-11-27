"use strict";

const path = require("node:path");
const { resolveConfig } = require("../../config");
const { createStrengthCatalog, expandStrengthGroups } = require("../../lib/battle/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { buildResolverParams } = require("../../lib/battle/resolverParams");
const { resolve } = require("../../lib/battle/resolverInternalV1");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");

const MOD_DIR = path.join(__dirname, "..", "..");
const TEMPLATE_DOCTRINE = "amarr-border-defense-v3";
const CLASSES = Object.freeze({ carrier: 23757, dreadnought: 19720, force_auxiliary: 37604, supercarrier: 23919,
  titan: 11567 });
const SEED_STEP = 7919;
const WIN_TARGET_PCT = 70;
const SCENARIO_K = Object.freeze([1, 3]);
const THRESHOLD_K = Object.freeze([1, 3, 6]);
const USAGE = "usage: node mods/livingNewEden/tools/calibration/capitalScenarios.js [--json] [--seeds <n>]";

function parseArgs(argv) {
  const args = { json: false, seeds: 50, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--seeds") {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--seeds needs a positive integer\n${USAGE}`);
      args.seeds = n;
      i += 1;
    } else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return args;
}

const entry = (hullGroup, count, typeId = null) => ({ hullGroup, typeId, count });

function merge(...lists) {
  const m = new Map();
  for (const list of lists) {
    for (const x of list) {
      const key = `${x.hullGroup}|${x.typeId}`;
      m.set(key, m.has(key) ? { ...x, count: m.get(key).count + x.count } : { ...x });
    }
  }
  return [...m.values()].filter((x) => x.count > 0);
}

function templateOf() {
  const doctrine = DOCTRINES_V1.find((d) => d.doctrineId === TEMPLATE_DOCTRINE);
  if (!doctrine || !doctrine.templates || !Array.isArray(doctrine.templates.invasion)) {
    throw new Error(`doctrine ${TEMPLATE_DOCTRINE} without an invasion template`);
  }
  return doctrine.templates.invasion.map((t) => [t.hullGroup, t.count]);
}

function contextOf(env) {
  const resolved = resolveConfig({ env: env || {}, settings: {}, envFile: {}, modDir: MOD_DIR });
  if (!resolved.ok) throw new Error(`config: ${resolved.errors.join("; ")}`);
  const config = resolved.config;
  const built = buildResolverParams(config);
  if (!built.ok) throw new Error(`resolver params: ${built.detail}`);
  const made = createStrengthCatalog(undefined, { groupConfidence: config.battle.strengthGroupConfidence,
    unknownTypeConfidence: config.battle.strengthUnknownTypeConfidence });
  if (!made.ok) throw new Error(`strength catalogue: ${made.detail}`);
  const off = buildPowerTable(expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf({ capitalPowerCalibrated: false })));
  const on = buildPowerTable(expandStrengthGroups(GROUPS, null,
    capitalPowerOverlayOf({ ...config.strategy, capitalPowerCalibrated: true })));
  return { config, catalog: made.catalog, params: built.params, tables: { off, on }, template: templateOf() };
}

function createRunner(ctx, seeds) {
  const tmpl = (k) => ctx.template.map(([g, c]) => entry(g, c * k));
  const maxShips = ctx.config.fleets.maxShipsPerFleet;
  function input(seed, compA, compB) {
    const side = (factionId, p, composition) => ({ factionId, fleets: [{ fleetId: `fleet_${p}0`, factionId,
      fleetRole: "patrol", doctrineId: null, supplyState: 100, composition }] });
    return { v: 1, battleId: "battle_1_0001_test", seed, systemId: 30000142, environment: "nullsec",
      sideA: side(500001, "a", compA), sideB: side(500002, "b", compB), objective: "capture", garrison: null,
      resolverVersion: "internal-v1", maxResolutionMs: ctx.config.battle.maxResolutionMs };
  }
  function run(compA, compB, capTypeId) {
    const s = { aWin: 0, bWin: 0, other: 0, lostA: 0, lostB: 0, rounds: 0, capLost: 0 };
    for (let i = 1; i <= seeds; i += 1) {
      const r = resolve(input(i * SEED_STEP, compA, compB), ctx.catalog, ctx.params);
      if (!r.ok) throw new Error(`resolve: ${r.reason} ${r.detail || ""}`);
      const res = r.result;
      if (res.outcome === "A_WIN") s.aWin += 1;
      else if (res.outcome === "B_WIN") s.bWin += 1;
      else s.other += 1;
      for (const d of res.destroyedShips) {
        if (d.fleetId === "fleet_a0") s.lostA += d.count;
        else s.lostB += d.count;
        if (d.fleetId === "fleet_a0" && capTypeId !== null && d.typeId === capTypeId) s.capLost += d.count;
      }
      s.rounds += res.diagnostics.rounds;
    }
    const pct = (v) => Math.round(100 * v / seeds);
    const avg = (v) => Number((v / seeds).toFixed(2));
    return { aWinPct: pct(s.aWin), bWinPct: pct(s.bWin), otherPct: pct(s.other), lostA: avg(s.lostA),
      lostB: avg(s.lostB), rounds: avg(s.rounds), capLostPct: pct(s.capLost) };
  }
  function fireShare(comp, typeId) {
    let all = 0;
    let cap = 0;
    for (const x of comp) {
      const row = ctx.catalog.lookup(x.hullGroup, x.typeId);
      const sig = row && row.strength ? row.strength.signatureRadius : 0;
      all += x.count * sig;
      if (x.typeId === typeId) cap += x.count * sig;
    }
    return all > 0 ? Number((cap / all).toFixed(3)) : 0;
  }
  const ratio = (a, b, table) => Number((strengthOf(a, table) / strengthOf(b, table)).toFixed(3));
  return { tmpl, run, fireShare, ratio, maxShips };
}

function scenarios(ctx, R) {
  const rows = [];
  for (const k of SCENARIO_K) {
    const base = R.tmpl(k);
    rows.push({ k, scenario: "T", ...R.run(base, base, null), capLostPct: null, fireShare: null, ratioOff: 1,
      ratioOn: 1 });
    for (const [cls, typeId] of Object.entries(CLASSES)) {
      const A = merge(base, [entry(cls, 1, typeId)]);
      rows.push({ k, scenario: `T+${cls}`, ...R.run(A, base, typeId), fireShare: R.fireShare(A, typeId),
        ratioOff: R.ratio(A, base, ctx.tables.off), ratioOn: R.ratio(A, base, ctx.tables.on) });
    }
  }
  return rows;
}

function thresholds(ctx, R) {
  const rows = [];
  for (const k of THRESHOLD_K) {
    const base = R.tmpl(k);
    const hi0 = R.maxShips - base.reduce((s, x) => s + x.count, 0);
    const winA = (A, n) => R.run(A, merge(base, [entry("cruiser", n)]), null).aWinPct;
    for (const [cls, typeId] of Object.entries(CLASSES)) {
      const A = merge(base, [entry(cls, 1, typeId)]);
      let lo = 0;
      let hi = hi0;
      let lastN = null;
      if (winA(A, 0) < WIN_TARGET_PCT) lastN = null;
      else if (winA(A, hi) >= WIN_TARGET_PCT) lastN = hi;
      else {
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (winA(A, mid) >= WIN_TARGET_PCT) lo = mid;
          else hi = mid;
        }
        lastN = lo;
      }
      const B = lastN === null ? null : merge(base, [entry("cruiser", lastN)]);
      rows.push({ k, cls, lastN, ratioOff: B ? R.ratio(A, B, ctx.tables.off) : null,
        ratioOn: B ? R.ratio(A, B, ctx.tables.on) : null });
    }
    let n = 0;
    while (n <= hi0 && R.run(merge(base, [entry("cruiser", n)]), base, null).aWinPct < WIN_TARGET_PCT) n += 1;
    const A = merge(base, [entry("cruiser", n)]);
    rows.push({ k, cls: "subcap", lastN: n, ratioOff: R.ratio(A, base, ctx.tables.off),
      ratioOn: R.ratio(A, base, ctx.tables.on) });
  }
  return rows;
}

const pad = (v, w) => String(v === null || v === undefined ? "-" : v).padStart(w);

function printReport(print, out) {
  print(`capitalScenarios: ${out.seeds} seeds, template ${TEMPLATE_DOCTRINE} invasion, nullsec, capture`);
  const P = out.power;
  print(`AI power (flag off / on): ${Object.keys(CLASSES).map((c) => `${c} ${P.off[c]} / ${P.on[c]}`).join(", ")}`);
  print("");
  print("4.1 T*k + class vs T*k");
  print(`${pad("k", 2)} ${"scenario".padEnd(20)} ${pad("A_WIN", 6)} ${pad("B_WIN", 6)} ${pad("other", 5)} `
    + `${pad("lossesA", 8)} ${pad("lossesB", 8)} ${pad("rounds", 6)} ${pad("cap%", 5)} ${pad("fire", 6)} `
    + `${pad("AI off", 7)} ${pad("AI on", 7)}`);
  for (const r of out.scenarios) {
    print(`${pad(r.k, 2)} ${r.scenario.padEnd(20)} ${pad(`${r.aWinPct}%`, 6)} ${pad(`${r.bWinPct}%`, 6)} `
      + `${pad(`${r.otherPct}%`, 5)} ${pad(r.lostA, 8)} ${pad(r.lostB, 8)} ${pad(r.rounds, 6)} `
      + `${pad(r.capLostPct === null ? null : `${r.capLostPct}%`, 5)} ${pad(r.fireShare, 6)} ${pad(r.ratioOff, 7)} `
      + `${pad(r.ratioOn, 7)}`);
  }
  print("");
  print(`5.2 threshold ${WIN_TARGET_PCT}%: A = T*k + class, B = T*k + n cruisers; AI power ratio A/B at the last n`);
  print(`${pad("k", 2)} ${"class".padEnd(16)} ${pad("n", 4)} ${pad("AI off", 7)} ${pad("AI on", 7)}`);
  for (const r of out.thresholds) {
    print(`${pad(r.k, 2)} ${r.cls.padEnd(16)} ${pad(r.lastN, 4)} ${pad(r.ratioOff, 7)} ${pad(r.ratioOn, 7)}`);
  }
}

function main(argv, opts = {}) {
  const print = opts.print || ((line) => process.stdout.write(`${line}\n`));
  const args = parseArgs(argv);
  if (args.help) {
    print(USAGE);
    return 0;
  }
  const ctx = contextOf(opts.env === undefined ? process.env : opts.env);
  const R = createRunner(ctx, args.seeds);
  const pick = (table) => Object.fromEntries([...Object.keys(CLASSES), "battleship", "cruiser"]
    .map((c) => [c, table[c]]));
  const out = { seeds: args.seeds, template: TEMPLATE_DOCTRINE, power: { off: pick(ctx.tables.off), on: pick(ctx.tables.on) },
    scenarios: scenarios(ctx, R), thresholds: thresholds(ctx, R) };
  if (args.json) print(JSON.stringify(out));
  else printReport(print, out);
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

module.exports = { main, parseArgs, CLASSES };
