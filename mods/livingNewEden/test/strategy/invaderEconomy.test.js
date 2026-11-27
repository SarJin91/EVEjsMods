"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { planUpkeep, upkeepRates } = require("../../lib/strategy/ai/upkeep");
const { planTreasury, perPeriod } = require("../../lib/strategy/ai/treasury");
const { homeYieldOf } = require("../../lib/strategy/ai/invaderEconomy");
const { INVADER_ECONOMY_FACTIONS, INVADER_ECONOMY_VERSION, INVADER_HOME_POOL_KEYS, INVADER_CONDUIT_KEYS,
  INVADER_RAID_KEYS, INVADER_UNIT_ONLY_FACTIONS } = require("../../lib/strategy/data/invaderEconomy");
const { treasuryParamsOf, invaderEconomyParamsOf, INVADER_ECONOMY_PARAM_KEYS } =
  require("../../lib/strategy/reviewService");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const TRIG = 500026;
const DTH = 500029;
const HOUR = 3600000;
const AT = 1760000000000 - (1760000000000 % HOUR) + 1234;
const ON = { EVEJS_LNE_INVADER_ECONOMY_ENABLED: "1" };

const resolve = (env) => {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
};

function paramsOf(cfg, factionId) {
  const E = invaderEconomyParamsOf(cfg, factionId);
  const base = { upkeep: Object.freeze({ ...cfg.upkeep, maxResourceUnits: 1000000000, maxUnpaidPeriods: 1000 }),
    treasury: treasuryParamsOf(cfg) };
  return { base, E, withE: E ? { ...base, invaderEconomy: E } : base };
}

function snap(factionId, o = {}) {
  const due = AT - (AT % HOUR) - HOUR;
  return {
    factionId, round: 3, at: AT, fleets: [],
    faction: { status: "ACTIVE", resourceUnits: 6000, reserveUnits: 0, version: 2 },
    upkeep: { mode: "ready", paidUntil: due, unpaidPeriods: 0, controlledCount: o.n === undefined ? 27 : o.n,
      captured: o.captured || [], capturedTruncated: o.truncated === true, liveShips: 0, stationCount: 0,
      tradeReady: false },
    treasury: { mode: "ready", seeded: true, paidUntil: due, kind: "invader", balanceIsk: 5e11, initialIsk: 5e11,
      valueByGroup: {}, tradeEligible: false, tradeHeldIsk: null, factionTradeOutToday: 0, galaxyTradeOutToday: 0,
      accountMode: "NORMAL" },
  };
}
const cap = (systemId) => ({ systemId, state: "STABLE", detachedSinceAt: null, factorPermille: 1000 });
const plans = (s, params) => [planUpkeep(s, null, params), planTreasury(s, params, {})];

module.exports = ({ test }) => {
  test("IE1 flag off: params.invaderEconomy null for 500026 / 500029, planUpkeep and planTreasury deepStrictEqual "
    + "with the params without the field", () => {
    const off = resolve({});
    assert.strictEqual(off.invaderEconomy.enabled, false);
    for (const f of [TRIG, DTH]) {
      const p = paramsOf(off, f);
      assert.strictEqual(p.E, null);
      for (const s of [snap(f), snap(f, { truncated: true, captured: [cap(1)] })]) {
        assert.deepStrictEqual(plans(s, { ...p.base, invaderEconomy: null }), plans(s, p.base));
        assert.deepStrictEqual(upkeepRates(s, { ...p.base, invaderEconomy: null }), upkeepRates(s, p.base));
      }
    }
  });

  test("IE2 Triglavian 27 home systems: UPKEEP income 81 + 54 (panel rates the same), TREASURY income of "
    + "3e9 + 27 x (2e8 + 3e8) per day", () => {
    const p = paramsOf(resolve(ON), TRIG);
    assert.deepStrictEqual({ ...p.E }, { baseIncomeIskPerDay: 3e9, iskPerHomeSystemPerDay: 3e8,
      unitsPerHomeSystemPerPeriod: 2 });
    const s = snap(TRIG);
    const [up, tr] = plans(s, p.withE);
    assert.strictEqual(up.intents[0].income, 81 + 54);
    assert.strictEqual(up.rates.income, 135);
    assert.strictEqual(upkeepRates(s, p.withE).income, 135, "the panel reads the same ratesOf");
    assert.strictEqual(tr.intents[0].income, perPeriod(3e9 + 27 * (2e8 + 3e8), HOUR));
    assert.strictEqual(tr.rates.incomePerPeriod, perPeriod(1.65e10, HOUR));
    const [upOff, trOff] = plans(s, p.base);
    assert.deepStrictEqual([upOff.intents[0].income, trOff.intents[0].income], [81, perPeriod(1e9 + 27 * 2e8, HOUR)]);
    assert.deepStrictEqual(Object.keys(up.intents[0]), Object.keys(upOff.intents[0]), "no new intent field");
    assert.deepStrictEqual(Object.keys(tr.intents[0]), Object.keys(trOff.intents[0]), "no new intent field");
  });

  test("IE3 Deathless with the defaults (all 0): the plan of the class invader", () => {
    const p = paramsOf(resolve(ON), DTH);
    assert.deepStrictEqual({ ...p.E }, { baseIncomeIskPerDay: 0, iskPerHomeSystemPerDay: 0,
      unitsPerHomeSystemPerPeriod: 0 });
    const s = snap(DTH, { n: 3, captured: [cap(30100001)] });
    assert.deepStrictEqual(plans(s, p.withE), plans(s, p.base));
    assert.strictEqual(invaderEconomyParamsOf(resolve(ON), 500021), null, "Sleepers have no entry");
  });

  test("IE4 capturedTruncated: per-system part 0 and the note INVADER_YIELD_TRUNCATED; the base still applies", () => {
    const p = paramsOf(resolve(ON), TRIG);
    const s = snap(TRIG, { n: 29, captured: [cap(1), cap(2)], truncated: true });
    const y = homeYieldOf(s.upkeep, p.E);
    assert.deepStrictEqual([y.iskDaily, y.unitsPerPeriod, y.notes], [0, 0, ["INVADER_YIELD_TRUNCATED"]]);
    assert.deepStrictEqual(homeYieldOf(s.upkeep, null), { iskDaily: 0, unitsPerPeriod: 0, homeSystems: 0, notes: [] });
    const [up, tr] = plans(s, p.withE);
    assert.strictEqual(up.intents[0].income, 3 * 29);
    assert.ok(up.notes.includes("INVADER_YIELD_TRUNCATED"));
    assert.strictEqual(tr.intents[0].income, perPeriod(3e9 + 29 * 2e8, HOUR));
    assert.ok(!plans(s, p.base)[0].notes.includes("INVADER_YIELD_TRUNCATED"), "off: no note");
  });

  test("IE5 closed set: INVADER_ECONOMY_PARAM_KEYS, SCHEMA invaderEconomy.*, .env.example, compose flag :-0", () => {
    assert.strictEqual(INVADER_ECONOMY_VERSION, 1);
    assert.deepStrictEqual({ ...INVADER_ECONOMY_FACTIONS }, { 500026: "triglavian", 500029: "deathless" });
    assert.deepStrictEqual([...INVADER_ECONOMY_PARAM_KEYS],
      ["baseIncomeIskPerDay", "iskPerHomeSystemPerDay", "unitsPerHomeSystemPerPeriod"]);
    const perPrefix = [...INVADER_ECONOMY_PARAM_KEYS, ...INVADER_HOME_POOL_KEYS, ...INVADER_CONDUIT_KEYS,
      ...INVADER_RAID_KEYS];
    const expected = ["invaderEconomy.enabled", "invaderEconomy.homePoolEnabled", "invaderEconomy.conduitEnabled",
      "invaderEconomy.raidsEnabled",
      "invaderEconomy.sleepersEnabled", "invaderEconomy.sleepers.baseUnitsPerPeriod",
      ...Object.values(INVADER_ECONOMY_FACTIONS)
        .flatMap((prefix) => perPrefix.map((k) => `invaderEconomy.${prefix}.${k}`))];
    const rows = config.SCHEMA.filter((row) => row.key.startsWith("invaderEconomy."));
    assert.deepStrictEqual(rows.map((row) => row.key).sort(), [...expected].sort());
    assert.ok(rows.every((row) => !row.launcher), "internal keys");
    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    assert.deepStrictEqual(rows.filter((row) => !example.includes(`# ${row.env}=`)).map((row) => row.env), []);
    const compose = fs.readFileSync(path.join(REPO_DIR, "compose.yaml"), "utf8");
    for (const flag of ["ENABLED", "HOME_POOL_ENABLED", "CONDUIT_ENABLED", "RAIDS_ENABLED"]) {
      const env = `EVEJS_LNE_INVADER_ECONOMY_${flag}`;
      assert.ok(compose.includes(`${env}: \${${env}:-0}`), env);
    }
    const values = rows.filter((row) => row.type !== "boolean")
      .filter((row) => !compose.includes(`${row.env}: \${${row.env}:-}`)).map((row) => row.env);
    assert.deepStrictEqual(values, [], "compose misses value keys");
    const set = resolve({ ...ON, EVEJS_LNE_INVADER_ECONOMY_TRIGLAVIAN_UNITS_PER_HOME_SYSTEM_PER_PERIOD: "5" });
    assert.strictEqual(invaderEconomyParamsOf(set, TRIG).unitsPerHomeSystemPerPeriod, 5, "env reaches the AI params");
  });

  const SLP = 500021;
  const SLEEPERS_ON = { ...ON, EVEJS_LNE_INVADER_ECONOMY_SLEEPERS_ENABLED: "1" };
  const SLEEPERS_E = Object.freeze({ baseIncomeIskPerDay: 0, iskPerHomeSystemPerDay: 0, unitsPerHomeSystemPerPeriod: 0,
    baseUnitsPerPeriod: 5 });

  test("IB1 homeYieldOf with E.baseUnitsPerPeriod: no home systems -> 5, capturedTruncated -> 5 + note, E without "
    + "the field -> as before", () => {
    const s = snap(SLP, { n: 1, captured: [cap(30005104)] });
    assert.deepStrictEqual(homeYieldOf(s.upkeep, SLEEPERS_E),
      { iskDaily: 0, unitsPerPeriod: 5, homeSystems: 0, notes: [] });
    const t = snap(SLP, { n: 1, captured: [cap(30005104)], truncated: true });
    assert.deepStrictEqual(homeYieldOf(t.upkeep, SLEEPERS_E),
      { iskDaily: 0, unitsPerPeriod: 5, homeSystems: 0, notes: ["INVADER_YIELD_TRUNCATED"] });
    const { baseUnitsPerPeriod, ...without } = SLEEPERS_E;
    assert.strictEqual(baseUnitsPerPeriod, 5);
    const d = snap(DTH, { n: 3, captured: [cap(1)] });
    assert.deepStrictEqual(homeYieldOf(d.upkeep, { ...without, unitsPerHomeSystemPerPeriod: 2 }),
      { iskDaily: 0, unitsPerPeriod: 4, homeSystems: 2, notes: [] });
  });

  test("IB2 planUpkeep: Sleepers 1 captured + 35 ships and Deathless Zarzakh + 1 detached + 25 ships -> income 8, "
    + "cost 6, delta +2 (net >= 0 with the doctrine fleet)", () => {
    const sp = paramsOf(resolve(SLEEPERS_ON), SLP);
    const s = snap(SLP, { n: 1, captured: [cap(30005104)] });
    s.upkeep.liveShips = 35;
    const up = planUpkeep(s, null, sp.withE).intents[0];
    assert.deepStrictEqual([up.income, up.cost, up.delta], [8, 6, 2]);
    const dp = paramsOf(resolve({ ...ON,
      EVEJS_LNE_INVADER_ECONOMY_DEATHLESS_UNITS_PER_HOME_SYSTEM_PER_PERIOD: "5" }), DTH);
    const d = snap(DTH, { n: 2, captured: [{ ...cap(30004575), detachedSinceAt: AT - HOUR }] });
    d.upkeep.liveShips = 25;
    const du = planUpkeep(d, null, dp.withE).intents[0];
    assert.deepStrictEqual([du.income, du.cost, du.delta], [8, 6, 2]);
  });

  test("IB3 invaderEconomyParamsOf: 500021 null with sleepersEnabled off, unit-only E with it; 500026 / 500029 the "
    + "same E as before", () => {
    assert.deepStrictEqual({ ...INVADER_UNIT_ONLY_FACTIONS }, { 500021: "sleepers" });
    assert.strictEqual(invaderEconomyParamsOf(resolve(ON), SLP), null);
    assert.strictEqual(invaderEconomyParamsOf(resolve({ EVEJS_LNE_INVADER_ECONOMY_SLEEPERS_ENABLED: "1" }), SLP), null,
      "needs invaderEconomy.enabled");
    const on = resolve({ ...SLEEPERS_ON, EVEJS_LNE_INVADER_ECONOMY_HOME_POOL_ENABLED: "1",
      EVEJS_LNE_INVADER_ECONOMY_RAIDS_ENABLED: "1" });
    assert.deepStrictEqual({ ...invaderEconomyParamsOf(on, SLP, 31000005) }, { ...SLEEPERS_E }, "no homePool, no raids");
    const before = resolve({ ...ON, EVEJS_LNE_INVADER_ECONOMY_HOME_POOL_ENABLED: "1",
      EVEJS_LNE_INVADER_ECONOMY_RAIDS_ENABLED: "1" });
    for (const f of [TRIG, DTH]) {
      const E = invaderEconomyParamsOf(on, f, 30100000);
      assert.ok(!("baseUnitsPerPeriod" in E), String(f));
      assert.deepStrictEqual(E, invaderEconomyParamsOf(before, f, 30100000), String(f));
    }
  });
};
