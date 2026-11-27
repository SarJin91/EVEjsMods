"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MOD_DIR = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(MOD_DIR, "..", "..");

const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");

function assertDeepFrozen(value, where) {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value), `${where} frozen`);
  for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${where}.${key}`);
}

module.exports = ({ test, skip }) => {
  test("S1 strength builder: deterministic, order independent, unmapped group, zero field, weapon layout", () => {
    const { buildCatalog, weaponLayout } = require("../../tools/strength/buildCatalog");
    const fixture = require("./fixtures/strengthInputs");
    const method = fixture.methodFor();

    const a = buildCatalog(fixture.inputs(), method);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    const b = buildCatalog(fixture.inputs(), method);
    assert.strictEqual(sha(a.source), sha(b.source));
    const shuffled = fixture.inputs();
    shuffled.types.reverse();
    shuffled.groups.reverse();
    const c = buildCatalog(shuffled, method);
    assert.strictEqual(sha(c.source), sha(a.source), "order of the inputs does not matter");
    assert.deepStrictEqual(Object.keys(a.catalog.GROUPS), fixture.HULL_GROUPS);
    assert.strictEqual(a.catalog.HEADER.typeCount, 11, "unpublished type skipped");
    assert.strictEqual(a.catalog.TYPES["650"], undefined);

    const unmapped = fixture.inputs();
    unmapped.groups.push({ groupId: 9999, categoryId: 6, published: true });
    assert.deepStrictEqual(buildCatalog(unmapped, method), { ok: false, reason: "UNMAPPED_SHIP_GROUP",
      detail: "group 9999" });

    const zero = fixture.inputs();
    delete zero.dogma["649"][1271];
    const z = buildCatalog(zero, method);
    assert.strictEqual(z.ok, false);
    assert.strictEqual(z.reason, "CATALOG_FIELD_ZERO");
    assert.deepStrictEqual(JSON.parse(z.detail), { hullGroup: "industrial", field: "dps" });
    assert.ok(a.catalog.GROUPS.industrial.dps > 0, "median 0 of [0, x] would fall back to the mean");

    assert.deepStrictEqual(weaponLayout(7, 4, 6), { turrets: 1, launchers: 6 }, "Raven: 6 launchers + 1 turret");
    assert.deepStrictEqual(weaponLayout(3, 3, 2), { turrets: 3, launchers: 0 });
    const perMbit = (1.6 * 20 / 4 / 5 + 1.6 * 32 / 4 / 10 + 1.6 * 64 / 4 / 25) / 3;
    const ravenDps = 6 * (360 / 30) + 1 * (3.675 * 48 / 7.875) + 75 * perMbit;
    assert.strictEqual(a.catalog.TYPES["638"].dps, Number(ravenDps.toFixed(1)));

    const lightSquadronDps = ((97.5 / 5 + 93 / 5) / 2) * 6;
    assert.strictEqual(a.catalog.TYPES["23757"].dps, Number((3 * lightSquadronDps).toFixed(1)));
    assert.strictEqual(a.catalog.TYPES["23757"].alpha, Number((3 * ((97.5 + 93) / 2) * 6).toFixed(1)));
    const noFighter = fixture.inputs();
    delete noFighter.dogma["23061"];
    assert.deepStrictEqual(buildCatalog(noFighter, method), { ok: false, reason: "REFERENCE_MISSING",
      detail: "light fighter type 23061 attribute 2226" });
  });

  test("S2 committed strength catalogue: deep frozen, HULL_GROUPS, field ranges, ranking", () => {
    const data = require("../../lib/battle/data/strengthCatalog");
    const { HULL_GROUPS_V1 } = require("../../lib/fleets/schema");
    const { STRENGTH_FIELDS } = require("../../lib/battle/strength");
    assertDeepFrozen(data, "catalog");
    const { GROUPS } = data;
    assert.deepStrictEqual(Object.keys(GROUPS), [...HULL_GROUPS_V1]);
    const mayBeZero = new Set(["ewarFactor", "tackleFactor", "remoteRepPerSec"]);
    for (const name of HULL_GROUPS_V1) {
      const g = GROUPS[name];
      for (const field of STRENGTH_FIELDS) {
        assert.ok(Number.isFinite(g[field]), `${name}.${field}`);
        assert.ok(mayBeZero.has(field) ? g[field] >= 0 : g[field] > 0, `${name}.${field}=${g[field]}`);
      }
      assert.ok(g.ewarFactor <= 1 && g.tackleFactor <= 1 && g.applicationFactor <= 1, name);
      assert.ok(Number.isInteger(g.speedClass) && g.speedClass >= 1 && g.speedClass <= 5, name);
    }
    assert.ok(GROUPS.battleship.ehp > GROUPS.cruiser.ehp && GROUPS.cruiser.ehp > GROUPS.frigate.ehp, "ehp ranking");
    assert.ok(GROUPS.capital.ehp > GROUPS.battleship.ehp, "capital ehp");
    assert.ok(GROUPS.logistics.remoteRepPerSec > 0, "logistics reps");
    assert.ok(GROUPS.ewar.ewarFactor > 0, "ewar");
    assert.ok(GROUPS.tackle.tackleFactor > 0, "tackle");
  });

  test("S3 strength lookup: type, group, unknown, mismatch, unknown group, invalid data, config params", () => {
    const { createStrengthCatalog } = require("../../lib/battle/strength");
    const config = require("../../config");
    const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    const params = { groupConfidence: resolved.config.battle.strengthGroupConfidence,
      unknownTypeConfidence: resolved.config.battle.strengthUnknownTypeConfidence };
    assert.deepStrictEqual(params, { groupConfidence: 0.9, unknownTypeConfidence: 0.6 });
    const made = createStrengthCatalog(undefined, params);
    assert.strictEqual(made.ok, true, JSON.stringify(made));
    const { catalog } = made;
    assert.ok(Object.isFrozen(catalog));

    const group = catalog.lookup("frigate", null);
    assert.strictEqual(group.source, "group");
    assert.strictEqual(group.confidence, 0.9);
    assert.strictEqual(group.note, null);
    assert.ok(Object.isFrozen(group) && Object.isFrozen(group.strength));
    const rifter = catalog.lookup("frigate", 587);
    assert.strictEqual(rifter.source, "type");
    assert.strictEqual(rifter.confidence, 1);
    const unknown = catalog.lookup("frigate", 999999999);
    assert.deepStrictEqual([unknown.source, unknown.confidence, unknown.note], ["group", 0.6, "UNKNOWN_TYPE"]);
    assert.strictEqual(unknown.strength, group.strength);
    const mismatch = catalog.lookup("cruiser", 587);
    assert.deepStrictEqual([mismatch.source, mismatch.note], ["group", "TYPE_GROUP_MISMATCH"]);
    const bad = catalog.lookup("no_such_hull", null);
    assert.deepStrictEqual(bad, { ok: false, reason: "UNKNOWN_HULL_GROUP", hullGroup: "no_such_hull" });
    assert.ok(Object.isFrozen(bad));

    const data = require("../../lib/battle/data/strengthCatalog");
    const noCapital = { ...data, GROUPS: { ...data.GROUPS } };
    delete noCapital.GROUPS.capital;
    assert.strictEqual(createStrengthCatalog(noCapital, params).reason, "STRENGTH_CATALOG_INVALID");
    assert.strictEqual(createStrengthCatalog(undefined, { groupConfidence: 0.5, unknownTypeConfidence: 0.7 })
      .reason, "STRENGTH_PARAMS_INVALID");

    const crossed = config.resolveConfig({ modDir: MOD_DIR, env: {
      EVEJS_LNE_BATTLE_STRENGTH_GROUP_CONFIDENCE: "0.5", EVEJS_LNE_BATTLE_STRENGTH_UNKNOWN_TYPE_CONFIDENCE: "0.8" } });
    assert.strictEqual(crossed.config.battle.strengthUnknownTypeConfidence, 0.5);
    assert.ok(crossed.warnings.some((w) => w.includes("strengthUnknownTypeConfidence")));
  });

  const entrypoint = path.join(REPO_ROOT, "docker", "entrypoint.sh");
  const serverPackage = path.join(REPO_ROOT, "server", "package.json");
  const vendorFacts = (header) => {
    const build = /SDE_BUILD="(\d+)"/.exec(fs.readFileSync(entrypoint, "utf8"));
    assert.ok(build, "SDE_BUILD in docker/entrypoint.sh");
    assert.strictEqual(header.sdeBuild, Number(build[1]), "catalogue built from the SDE build EveJS downloads");
    if (fs.existsSync(serverPackage)) {
      assert.strictEqual(header.evejsVersion, JSON.parse(fs.readFileSync(serverPackage, "utf8")).version);
    }
  };
  if (fs.existsSync(entrypoint)) {
    test("S4a strength catalogue vendor facts: SDE build, EveJS version", () => {
      vendorFacts(require("../../lib/battle/data/strengthCatalog").HEADER);
    });
  } else {
    skip("S4a strength catalogue vendor facts", "docker/entrypoint.sh not found");
  }

  test("S4b strength accessor isolation: requires only fleets/schema and the data files", () => {
    const requires = (rel) => [...fs.readFileSync(path.join(MOD_DIR, rel), "utf8")
      .matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]);
    assert.deepStrictEqual([...new Set(requires("lib/battle/strength.js"))].sort(),["../fleets/schema",
      "./data/capitalStrengthRows", "./data/strengthAliases", "./data/strengthCatalog"]);
    assert.deepStrictEqual(requires("lib/battle/data/strengthCatalog.js"), []);
    assert.deepStrictEqual(requires("lib/battle/data/strengthAliases.js"), []);
    assert.deepStrictEqual(requires("lib/battle/data/capitalStrengthRows.js"),
      ["./strengthCatalog", "../../fleets/data/capitalClasses"]);
    assert.deepStrictEqual(requires("lib/fleets/data/capitalClasses.js"), []);
  });

  test("S5 capital classes: titan alias -> capital type row / group row; power table = median racial "
    + "row, not the capital group", () => {
    const { createStrengthCatalog, expandStrengthGroups, STRENGTH_FIELDS } = require("../../lib/battle/strength");
    const { buildPowerTable } = require("../../lib/strategy/ai/strength");
    const { CAPITAL_STRENGTH_ROWS } = require("../../lib/battle/data/capitalStrengthRows");
    const { CAPITAL_HULL_GROUPS } = require("../../lib/fleets/schema");
    const data = require("../../lib/battle/data/strengthCatalog");
    const { catalog } = createStrengthCatalog(undefined, { groupConfidence: 0.9, unknownTypeConfidence: 0.6 });
    const avatar = catalog.lookup("titan", 11567);
    assert.deepStrictEqual([avatar.source, avatar.confidence, avatar.strength.ehp], ["type", 1, data.TYPES["11567"].ehp]);
    assert.strictEqual(catalog.lookup("titan", null), catalog.lookup("capital", null));
    const groups = expandStrengthGroups(data.GROUPS);
    const power = buildPowerTable(groups);
    const legacy = buildPowerTable(data.GROUPS).capital;
    const MEDIAN = { carrier: 23915, dreadnought: 19726, force_auxiliary: 37605, supercarrier: 23919, titan: 23773 };
    const POWER = { carrier: 10317, dreadnought: 1716, force_auxiliary: 11135, supercarrier: 17129, titan: 5469 };
    for (const cls of CAPITAL_HULL_GROUPS) {
      const type = data.TYPES[String(MEDIAN[cls])];
      assert.deepStrictEqual(CAPITAL_STRENGTH_ROWS[cls], Object.fromEntries(STRENGTH_FIELDS.map((f) => [f, type[f]])),
        cls);
      assert.strictEqual(groups[cls], CAPITAL_STRENGTH_ROWS[cls], cls);
      assert.strictEqual(power[cls], POWER[cls], cls);
    }
    assert.strictEqual(legacy, 2570, "capital group median");
    assert.notStrictEqual(power.titan, legacy, "titan is not the capital group median");
    assert.strictEqual(groups.capital, data.GROUPS.capital, "legacy capital row unchanged");
  });
};
