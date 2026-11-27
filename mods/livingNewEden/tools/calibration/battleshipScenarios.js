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
const SIDES = Object.freeze({ empire: "amarr-border-defense-v3", pirate: "pirate-territorial-v2" });
const C1_PAIRS = Object.freeze([["empire", "pirate"], ["pirate", "empire"], ["empire", "empire"]]);
const GARRISON_M = Object.freeze([1, 3]);
const C2_K = Object.freeze([1, 3]);
const C2_BATTLESHIPS = 2;
const SEED_STEP = 7919;
const C1_MIN_WIN_PCT = 60;
const C1_MAX_DROP_PCT = 10;
const C2_WIN_TARGET_PCT = 70;
const C2_RATIO = Object.freeze([1.0, 1.08]);
const C3_WIN_PCT = Object.freeze([35, 65]);
const BS_PERMILLE_RANGE = Object.freeze([100, 2000]);
const USAGE = "usage: node mods/livingNewEden/tools/calibration/battleshipScenarios.js [--json] [--seeds <n>] "
  + "[--bs-permille <n>] [--scan-c2 <from>:<to>:<step>]";

const entry = (hullGroup, count) => ({ hullGroup, typeId: null, count });

const GARRISON_BS_CANDIDATES = Object.freeze([
  Object.freeze({ id: "4cr+1BC+1BS", template: Object.freeze([entry("cruiser", 4), entry("battlecruiser", 1),
    entry("battleship", 1)]) }),
  Object.freeze({ id: "3cr+1BC+2BS", template: Object.freeze([entry("cruiser", 3), entry("battlecruiser", 1),
    entry("battleship", 2)]) }),
  Object.freeze({ id: "4cr+2BS", template: Object.freeze([entry("cruiser", 4), entry("battleship", 2)]) }),
  Object.freeze({ id: "3cr+2BC+1BS", template: Object.freeze([entry("cruiser", 3), entry("battlecruiser", 2),
    entry("battleship", 1)]) }),
]);

function parseArgs(argv) {
  const args = { json: false, seeds: 50, help: false, bsPermille: null, scanC2: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--seeds") {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n < 1) throw new Error(`--seeds needs a positive integer\n${USAGE}`);
      args.seeds = n;
      i += 1;
    } else if (a === "--bs-permille") {
      const n = Number(argv[i + 1]);
      if (!Number.isSafeInteger(n) || n < BS_PERMILLE_RANGE[0] || n > BS_PERMILLE_RANGE[1]) {
        throw new Error(`--bs-permille needs an integer ${BS_PERMILLE_RANGE.join("-")}\n${USAGE}`);
      }
      args.bsPermille = n;
      i += 1;
    } else if (a === "--scan-c2") {
      const parts = String(argv[i + 1] === undefined ? "" : argv[i + 1]).split(":").map(Number);
      const [from, to, step] = parts;
      if (parts.length !== 3 || !parts.every(Number.isSafeInteger) || from < 1 || to < from || step < 1) {
        throw new Error(`--scan-c2 needs <from>:<to>:<step> (integers, 1 <= from <= to, step >= 1)\n${USAGE}`);
      }
      args.scanC2 = { from, to, step };
      i += 1;
    } else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return args;
}

function merge(...lists) {
  const m = new Map();
  for (const list of lists) {
    for (const x of list) m.set(x.hullGroup, m.has(x.hullGroup) ? { ...x, count: m.get(x.hullGroup).count + x.count }
      : { ...x });
  }
  return [...m.values()].filter((x) => x.count > 0);
}

const times = (template, k) => template.map((t) => entry(t.hullGroup, t.count * k));

function templatesOf() {
  const out = {};
  for (const [side, doctrineId] of Object.entries(SIDES)) {
    const d = DOCTRINES_V1.find((x) => x.doctrineId === doctrineId);
    if (!d || !d.templates || !d.battleshipTemplates) throw new Error(`doctrine ${doctrineId} without an overlay`);
    out[side] = { overlay: {} };
    for (const role of ["garrison", "invasion"]) {
      const v18 = d.templates[role];
      if (!Array.isArray(v18)) throw new Error(`doctrine ${doctrineId} without ${role}`);
      const own = Array.isArray(d.battleshipTemplates[role]);
      out[side].overlay[role] = own;
      out[side][role] = { v18, bs: own ? d.battleshipTemplates[role] : v18 };
    }
  }
  return out;
}

function garrisonOverlaySidesOf(templates) {
  return Object.keys(templates).filter((side) => Boolean(templates[side].overlay && templates[side].overlay.garrison));
}

function c1LabelOf(templates, def) {
  return templates[def] && templates[def].overlay && templates[def].overlay.garrison ? "bs/bs" : "bs/v18";
}

function tableOf(on, permille) {
  return buildPowerTable(expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf({ capitalPowerCalibrated: false,
    battleshipPowerCalibrated: on === true, battleshipPowerPermille: permille })));
}

function c2RatioOf(row, table) {
  if (!row || !Array.isArray(row.compA) || !Array.isArray(row.compB)) return null;
  const b = strengthOf(row.compB, table);
  if (b <= 0) return null;
  return Number((strengthOf(row.compA, table) / b).toFixed(3));
}

function contextOf(env, bsPermille) {
  const resolved = resolveConfig({ env: env || {}, settings: {}, envFile: {}, modDir: MOD_DIR });
  if (!resolved.ok) throw new Error(`config: ${resolved.errors.join("; ")}`);
  const config = resolved.config;
  const built = buildResolverParams(config);
  if (!built.ok) throw new Error(`resolver params: ${built.detail}`);
  const made = createStrengthCatalog(undefined, { groupConfidence: config.battle.strengthGroupConfidence,
    unknownTypeConfidence: config.battle.strengthUnknownTypeConfidence });
  if (!made.ok) throw new Error(`strength catalogue: ${made.detail}`);
  const override = bsPermille !== null && bsPermille !== undefined;
  const on = override || config.strategy.battleshipPowerCalibrated === true;
  const permille = override ? bsPermille : config.strategy.battleshipPowerPermille;
  return { config, catalog: made.catalog, params: built.params, table: tableOf(on, permille),
    templates: templatesOf(), battleshipPermille: on ? permille : null };
}

function createRunner(ctx, seeds) {
  const maxShips = ctx.config.fleets.maxShipsPerFleet;
  function input(seed, compA, compB) {
    const side = (factionId, p, composition) => ({ factionId, fleets: [{ fleetId: `fleet_${p}0`, factionId,
      fleetRole: "patrol", doctrineId: null, supplyState: 100, composition }] });
    return { v: 1, battleId: "battle_1_0001_test", seed, systemId: 30000142, environment: "nullsec",
      sideA: side(500001, "a", compA), sideB: side(500002, "b", compB), objective: "capture", garrison: null,
      resolverVersion: "internal-v1", maxResolutionMs: ctx.config.battle.maxResolutionMs };
  }
  function run(compA, compB) {
    const s = { aWin: 0, bWin: 0, other: 0, lostA: 0, lostB: 0 };
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
      }
    }
    const pct = (v) => Math.round(100 * v / seeds);
    const avg = (v) => Number((v / seeds).toFixed(2));
    return { aWinPct: pct(s.aWin), bWinPct: pct(s.bWin), otherPct: pct(s.other), lostA: avg(s.lostA),
      lostB: avg(s.lostB) };
  }
  const power = (comp) => strengthOf(comp, ctx.table);
  const ratio = (a, b) => Number((power(a) / power(b)).toFixed(3));
  return { run, power, ratio, maxShips };
}

function c1(ctx, R) {
  const attackRatio = ctx.config.strategy.attackStrengthRatio;
  const rows = [];
  for (const [att, def] of C1_PAIRS) {
    for (const m of GARRISON_M) {
      const byVariant = {};
      for (const variant of ["v18", "bs"]) {
        const B = times(ctx.templates[def].garrison[variant], m);
        const inv = ctx.templates[att].invasion[variant];
        let k = 1;
        while (R.power(times(inv, k)) < attackRatio * R.power(B)) k += 1;
        const A = times(inv, k);
        byVariant[variant] = { k, ratio: R.ratio(A, B), ...R.run(A, B) };
      }
      const accepted = byVariant.bs.aWinPct >= byVariant.v18.aWinPct - C1_MAX_DROP_PCT
        && byVariant.bs.aWinPct >= C1_MIN_WIN_PCT;
      rows.push({ pair: `${att}->${def}`, m, label: c1LabelOf(ctx.templates, def), v18: byVariant.v18,
        bs: byVariant.bs, accepted });
    }
  }
  return rows;
}

function c2(ctx, R) {
  const rows = [];
  for (const side of Object.keys(SIDES)) {
    for (const k of C2_K) {
      const base = times(ctx.templates[side].invasion.v18, k);
      const A = merge(base, [entry("battleship", C2_BATTLESHIPS)]);
      const hi0 = R.maxShips - base.reduce((s, x) => s + x.count, 0);
      const winA = (n) => R.run(A, merge(base, [entry("cruiser", n)])).aWinPct;
      let lastN = null;
      let lo = 0;
      let hi = hi0;
      if (winA(0) < C2_WIN_TARGET_PCT) lastN = null;
      else if (winA(hi) >= C2_WIN_TARGET_PCT) lastN = hi;
      else {
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (winA(mid) >= C2_WIN_TARGET_PCT) lo = mid;
          else hi = mid;
        }
        lastN = lo;
      }
      const compB = lastN === null ? null : merge(base, [entry("cruiser", lastN)]);
      const ratio = compB === null ? null : R.ratio(A, compB);
      rows.push({ side, k, lastN, ratio, accepted: inC2Range(ratio), compA: A, compB });
    }
  }
  return rows;
}

const inC2Range = (ratio) => ratio !== null && ratio >= C2_RATIO[0] && ratio <= C2_RATIO[1];

function scanC2(c2Rows, scan) {
  const steps = [];
  for (let p = scan.from; p <= scan.to; p += scan.step) {
    const table = tableOf(true, p);
    const ratios = c2Rows.map((r) => c2RatioOf(r, table));
    steps.push({ permille: p, battleship: table.battleship, ratios, ok: ratios.every(inC2Range) });
  }
  const passing = steps.filter((s) => s.ok).map((s) => s.permille);
  const range = passing.length === 0 ? null : [passing[0], passing[passing.length - 1]];
  const contiguous = range === null
    || steps.filter((s) => s.permille >= range[0] && s.permille <= range[1]).every((s) => s.ok);
  return { steps, range, contiguous };
}

const inC3Range = (r) => r.aWinPct >= C3_WIN_PCT[0] && r.aWinPct <= C3_WIN_PCT[1];

function c3(ctx, R) {
  const sides = garrisonOverlaySidesOf(ctx.templates);
  if (sides.length === 0) return [{ skipped: "NO_GARRISON_OVERLAY" }];
  const rows = [];
  for (const side of sides) {
    const g = ctx.templates[side].garrison;
    for (const m of GARRISON_M) {
      const v18 = times(g.v18, m);
      const bs = times(g.bs, m);
      const ref = R.run(v18, v18);
      rows.push({ side, m, scenario: "ref G_v18 vs G_v18", ratio: 1, ...ref, accepted: null });
      const ab = R.run(bs, v18);
      rows.push({ side, m, scenario: "G_bs vs G_v18", ratio: R.ratio(bs, v18), ...ab, accepted: inC3Range(ab) });
      const ba = R.run(v18, bs);
      rows.push({ side, m, scenario: "G_v18 vs G_bs", ratio: R.ratio(v18, bs), ...ba, accepted: inC3Range(ba) });
    }
  }
  return rows;
}

function c3k(ctx, R) {
  const rows = [];
  const candidates = [];
  for (const cand of GARRISON_BS_CANDIDATES) {
    const sides = {};
    for (const side of Object.keys(SIDES)) {
      const v18Template = ctx.templates[side].garrison.v18;
      const power = R.power(cand.template);
      const v18Power = R.power(v18Template);
      let resolverOk = true;
      for (const m of GARRISON_M) {
        const c = times(cand.template, m);
        const v = times(v18Template, m);
        const ab = R.run(c, v);
        const ba = R.run(v, c);
        rows.push({ side, candidate: cand.id, m, scenario: "cand vs G_v18", ratio: R.ratio(c, v), ...ab,
          accepted: inC3Range(ab) });
        rows.push({ side, candidate: cand.id, m, scenario: "G_v18 vs cand", ratio: R.ratio(v, c), ...ba,
          accepted: inC3Range(ba) });
        resolverOk = resolverOk && inC3Range(ab) && inC3Range(ba);
      }
      sides[side] = { power, v18Power, weakPostOk: power <= v18Power, resolverOk };
    }
    const ok = Object.values(sides).every((s) => s.weakPostOk && s.resolverOk);
    candidates.push({ id: cand.id, sides, ok });
  }
  const first = candidates.find((c) => c.ok);
  return { rows, candidates, garrisonProposal: first ? first.id : null };
}

const pad = (v, w) => String(v === null || v === undefined ? "-" : v).padStart(w);
const yes = (v) => (v === null ? "-" : (v ? "OK" : "NO"));

function powerLine(out) {
  const others = Object.entries(out.power).filter(([g]) => g !== "battleship").map(([g, p]) => `${g} ${p}`);
  const bs = `battleship ${out.power.battleship} (permille ${out.battleshipPermille === null ? "off"
    : out.battleshipPermille})`;
  return `AI power: ${[...others, bs].join(", ")}`;
}

function printScan(print, out) {
  print(`battleshipScenarios --scan-c2: ${out.seeds} seeds; lastN from the resolver once, A/B per permille; `
    + `acceptance A/B in [${C2_RATIO.join(", ")}]`);
  print(`C2 lastN: ${out.c2.map((r) => `${r.side} k${r.k} n=${r.lastN === null ? "-" : r.lastN}`).join(", ")}`);
  print(`${pad("permille", 8)} ${pad("BS", 5)} ${out.c2.map((r) => pad(`${r.side[0]}k${r.k}`, 6)).join(" ")} ok`);
  for (const s of out.scan.steps) {
    print(`${pad(s.permille, 8)} ${pad(s.battleship, 5)} ${s.ratios.map((v) => pad(v, 6)).join(" ")} ${yes(s.ok)}`);
  }
  const r = out.scan.range;
  print(r === null ? "range: no permille at which all 4 pass"
    : `range: ${r[0]}..${r[1]} permille${out.scan.contiguous ? "" : " (not contiguous)"}, `
      + `middle ${Math.round((r[0] + r[1]) / 20) * 10}`);
}

function printReport(print, out) {
  print(`battleshipScenarios: ${out.seeds} seeds, empire ${SIDES.empire}, pirate ${SIDES.pirate}, nullsec, capture`);
  print(powerLine(out));
  print("");
  print(`C1 invasion vs garrison (A = k invasion templates >= ${out.attackStrengthRatio} x B)`);
  print(`${"pair".padEnd(14)} ${pad("m", 2)} | ${pad("k", 2)} ${pad("A/B", 6)} ${pad("A_WIN", 6)} ${pad("strA", 6)} `
    + `${pad("strB", 6)} | ${pad("k", 2)} ${pad("A/B", 6)} ${pad("A_WIN", 6)} ${pad("strA", 6)} ${pad("strB", 6)} | ok`);
  print(`${"".padEnd(14)} ${"".padEnd(2)} | ${"v18/v18".padEnd(31)} | ${out.c1Label.padEnd(31)} |`);
  for (const r of out.c1) {
    const cols = (v) => `${pad(v.k, 2)} ${pad(v.ratio, 6)} ${pad(`${v.aWinPct}%`, 6)} ${pad(v.lostA, 6)} ${pad(v.lostB, 6)}`;
    print(`${r.pair.padEnd(14)} ${pad(r.m, 2)} | ${cols(r.v18)} | ${cols(r.bs)} | ${yes(r.accepted)} ${r.label}`);
  }
  print("");
  print(`C2 threshold ${C2_WIN_TARGET_PCT}%: A = I_v18*k + ${C2_BATTLESHIPS} BS, B = I_v18*k + n cruisers; `
    + `acceptance A/B in [${C2_RATIO.join(", ")}]`);
  print(`${"side".padEnd(8)} ${pad("k", 2)} ${pad("n", 4)} ${pad("A/B", 6)} ok`);
  for (const r of out.c2) print(`${r.side.padEnd(8)} ${pad(r.k, 2)} ${pad(r.lastN, 4)} ${pad(r.ratio, 6)} ${yes(r.accepted)}`);
  print("");
  if (out.c3.length === 1 && out.c3[0].skipped) print("C3 skipped: garrison without an overlay");
  else {
    print(`C3 garrison: acceptance A_WIN ${C3_WIN_PCT[0]}-${C3_WIN_PCT[1]}%`);
    print(`${"side".padEnd(7)} ${pad("m", 2)} ${"scenario".padEnd(20)} ${pad("A/B", 6)} ${pad("A_WIN", 6)} `
      + `${pad("B_WIN", 6)} ${pad("other", 5)} ${pad("strA", 6)} ${pad("strB", 6)} ok`);
    for (const r of out.c3) {
      print(`${r.side.padEnd(7)} ${pad(r.m, 2)} ${r.scenario.padEnd(20)} ${pad(r.ratio, 6)} ${pad(`${r.aWinPct}%`, 6)} `
        + `${pad(`${r.bWinPct}%`, 6)} ${pad(`${r.otherPct}%`, 5)} ${pad(r.lostA, 6)} ${pad(r.lostB, 6)} `
        + `${yes(r.accepted)}`);
    }
  }
  print("");
  print(`C3K garrison proposal with BS (vs G_v18, A_WIN ${C3_WIN_PCT[0]}-${C3_WIN_PCT[1]}%, AI power <= v18)`);
  print(`${"side".padEnd(7)} ${"candidate".padEnd(12)} ${pad("m", 2)} ${"scenario".padEnd(14)} ${pad("A/B", 6)} `
    + `${pad("A_WIN", 6)} ${pad("B_WIN", 6)} ${pad("other", 5)} ok`);
  for (const r of out.c3k.rows) {
    print(`${r.side.padEnd(7)} ${r.candidate.padEnd(12)} ${pad(r.m, 2)} ${r.scenario.padEnd(14)} ${pad(r.ratio, 6)} `
      + `${pad(`${r.aWinPct}%`, 6)} ${pad(`${r.bWinPct}%`, 6)} ${pad(`${r.otherPct}%`, 5)} ${yes(r.accepted)}`);
  }
  for (const c of out.c3k.candidates) {
    const sides = Object.entries(c.sides).map(([side, s]) => `${side} power ${s.power}/${s.v18Power} `
      + `weak-post ${yes(s.weakPostOk)} resolver ${yes(s.resolverOk)}`).join("; ");
    print(`${c.id.padEnd(12)} ${sides} -> ${yes(c.ok)}`);
  }
  print(out.c3k.garrisonProposal === null ? "proposal: no candidate"
    : `proposal: ${out.c3k.garrisonProposal}`);
  print("");
  print(`acceptance: C1 ${yes(out.accepted.c1)}, C2 ${yes(out.accepted.c2)}, C3 ${yes(out.accepted.c3)}; `
    + `verdict (C1 + C2 + C3) ${yes(out.ok)}; proposal ${yes(out.proposalOk)}`);
}

function main(argv, opts = {}) {
  const print = opts.print || ((line) => process.stdout.write(`${line}\n`));
  const args = parseArgs(argv);
  if (args.help) {
    print(USAGE);
    return 0;
  }
  const ctx = contextOf(opts.env === undefined ? process.env : opts.env, args.bsPermille);
  const R = createRunner(ctx, args.seeds);
  if (args.scanC2) {
    const rowsC2 = c2(ctx, R);
    const out = { seeds: args.seeds, c2: rowsC2, scan: scanC2(rowsC2, args.scanC2) };
    if (args.json) print(JSON.stringify(out));
    else printScan(print, out);
    return 0;
  }
  const power = Object.fromEntries(["cruiser", "battlecruiser", "battleship", "logistics", "ewar", "tackle"]
    .map((g) => [g, ctx.table[g]]));
  const rows = { c1: c1(ctx, R), c2: c2(ctx, R), c3: c3(ctx, R), c3k: c3k(ctx, R) };
  const all = (list) => list.filter((r) => r.accepted !== null).every((r) => r.accepted === true);
  const c3Skipped = rows.c3.length === 1 && Boolean(rows.c3[0].skipped);
  const accepted = { c1: all(rows.c1), c2: all(rows.c2), c3: c3Skipped ? null : all(rows.c3) };
  const labels = [...new Set(rows.c1.map((r) => r.label))];
  const out = { seeds: args.seeds, sides: SIDES, attackStrengthRatio: ctx.config.strategy.attackStrengthRatio, power,
    battleshipPermille: ctx.battleshipPermille, c1Label: labels.length === 1 ? labels[0] : "mixed", ...rows,
    accepted, ok: accepted.c1 && accepted.c2 && accepted.c3 !== false,
    proposalOk: rows.c3k.garrisonProposal !== null };
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

module.exports = { main, parseArgs, SIDES, GARRISON_BS_CANDIDATES, c2RatioOf, c1LabelOf, garrisonOverlaySidesOf };
