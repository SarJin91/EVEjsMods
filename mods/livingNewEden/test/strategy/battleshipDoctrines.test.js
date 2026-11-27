"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { DOCTRINES_VERSION, DOCTRINES_V1, BS_GARRISON } = require("../../lib/strategy/data/doctrines");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { hullTargets } = require("../../lib/strategy/ai/production");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { PIRATE_KEY_BY_FACTION_ID } = require("../../lib/adapter/data/liveProfiles");
const { startStrategy } = require("../../lib/strategy");
const { createManualClock } = require("../../lib/util/clock");
const { resolveConfig } = require("../../config");
const { npcSetupTables } = require("../_support/setupTables");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const NPC_SRC = path.join(REPO_ROOT, "server", "src", "space", "npc");
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
const OVERLAID = ["amarr-border-defense-v3", "empire-border-defense-v2", "pirate-territorial-v2",
  "serpentis-territorial-v2"];
const INVADER_DOCTRINES = ["triglavian-invader-v1", "deathless-invader-v1", "sleeper-invader-v1"];
const PIRATE_KEYS = ["guristas", "angels", "blood", "serpentis", "sanshas"];

const plain = (v) => JSON.parse(JSON.stringify(v));
const tableOf = (strategy) => buildPowerTable(expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf(strategy)));
const calTable = (permille) => tableOf({ battleshipPowerCalibrated: true, battleshipPowerPermille: permille });

function registryOf(mode, extra = {}) {
  const r = createFactionRegistry(REGISTRY_DATA_V1, mode === undefined ? { ...CTX, ...extra }
    : { ...CTX, battleshipDoctrines: mode, ...extra });
  assert.ok(r.ok, JSON.stringify(r));
  return r.registry;
}

function readSource(name) {
  return fs.readFileSync(path.join(NPC_SRC, name), "utf8").replace(/\r\n/g, "\n");
}

function isBattleshipProfile(profile) {
  const haystack = [profile.profileID, profile.name, profile.description, profile.shipNameTemplate,
    ...(Array.isArray(profile.aliases) ? profile.aliases : [])]
    .join(" ").toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ");
  return /(^|[^a-z])battleship([^a-z]|$)/.test(haystack);
}

module.exports = ({ test, skip }) => {
  test("BD1 battleshipDoctrines off = v18: templates of the data, stockTemplates = templates, version 23", () => {
    assert.strictEqual(DOCTRINES_VERSION, 25);
    const calOff = registryOf("off", { battleshipPowerCalibrated: true, powerTable: calTable(520) });
    assert.deepStrictEqual(plain(calOff.battleshipGarrison), { applied: [], dropped: [] });
    for (const reg of [registryOf(undefined), registryOf("off"), registryOf("off", { battleshipPowerCalibrated: false }),
      calOff]) {
      for (const d of DOCTRINES_V1) {
        const built = reg.getDoctrine(d.doctrineId);
        assert.deepStrictEqual(plain(built.templates), plain(d.templates), d.doctrineId);
        assert.deepStrictEqual(plain(built.stockTemplates), plain(built.templates), d.doctrineId);
      }
    }
    assert.deepStrictEqual(DOCTRINES_V1.filter((d) => d.battleshipTemplates !== undefined).map((d) => d.doctrineId)
      .sort(), OVERLAID);
  });

  test("BD2 stock / on apply the overlay in the 4 doctrines only; bad overlay or ctx mode -> REGISTRY_INVALID", () => {
    const off = registryOf("off");
    for (const mode of ["stock", "on"]) {
      const reg = registryOf(mode);
      for (const d of DOCTRINES_V1) {
        const built = reg.getDoctrine(d.doctrineId);
        if (d.battleshipTemplates === undefined) {
          assert.deepStrictEqual(plain(built), plain(off.getDoctrine(d.doctrineId)), `${mode} ${d.doctrineId}`);
          continue;
        }
        const merged = plain({ ...d.templates, ...d.battleshipTemplates });
        assert.deepStrictEqual(plain(built.stockTemplates), merged, `${mode} ${d.doctrineId}`);
        assert.deepStrictEqual(plain(built.templates), mode === "on" ? merged : plain(d.templates),
          `${mode} ${d.doctrineId}`);
        assert.deepStrictEqual(plain(built.battleshipTemplates), plain(d.battleshipTemplates));
      }
    }
    const at = REGISTRY_DATA_V1.doctrines.findIndex((d) => d.doctrineId === "empire-border-defense-v2");
    const bad = (mutate) => {
      const data = plain(REGISTRY_DATA_V1);
      mutate(data.doctrines[at].battleshipTemplates);
      return createFactionRegistry(data, CTX);
    };
    const invalid = (detail) => ({ ok: false, reason: "REGISTRY_INVALID", detail });
    assert.deepStrictEqual(bad((o) => { o.wormhole = [{ hullGroup: "battleship", count: 1 }]; }),
      invalid(`doctrines[${at}].battleshipTemplates.wormhole`));
    assert.deepStrictEqual(bad((o) => { o.garrison = [{ hullGroup: "titanic", count: 1 }]; }),
      invalid(`doctrines[${at}].battleshipTemplates.garrison[0].hullGroup`));
    assert.deepStrictEqual(bad((o) => { o.garrison = [{ hullGroup: "cruiser", count: 1 }]; }),
      invalid(`doctrines[${at}].battleshipTemplates.garrison`));
    assert.deepStrictEqual(createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, battleshipDoctrines: "x" }),
      invalid("ctx.battleshipDoctrines"));
  });

  test("BD3 hullTargets read stockTemplates (empire stock battleship 4, no overlay = off); no garrison overlay, "
    + "invader doctrines without an overlay", () => {
    const params = { targetStockFleets: 2, miningNeedsHulls: false, logisticsNeedsHulls: false,
      hullGroups: HULL_GROUPS };
    const stock = registryOf("stock");
    const off = registryOf("off");
    const empire = hullTargets(stock.getDoctrine("empire-border-defense-v2"), params);
    assert.strictEqual(empire.battleship, 2 * 2);
    assert.strictEqual(hullTargets(off.getDoctrine("empire-border-defense-v2"), params).battleship, undefined);
    assert.deepStrictEqual(hullTargets(stock.getDoctrine("concord-border-police-v1"), params),
      hullTargets(off.getDoctrine("concord-border-police-v1"), params));
    const table = buildPowerTable(GROUPS);
    for (const d of DOCTRINES_V1.filter((x) => x.battleshipTemplates && x.battleshipTemplates.garrison)) {
      assert.ok(strengthOf(d.battleshipTemplates.garrison, table) <= strengthOf(d.templates.garrison, table),
        `${d.doctrineId}overlay garrison stronger than v18`);
    }
    assert.deepStrictEqual(DOCTRINES_V1.filter((d) => d.battleshipTemplates
      && Object.prototype.hasOwnProperty.call(d.battleshipTemplates, "garrison")).map((d) => d.doctrineId), []);
    for (const id of INVADER_DOCTRINES) {
      const d = DOCTRINES_V1.find((x) => x.doctrineId === id);
      assert.ok(d, id);
      assert.strictEqual(d.battleshipTemplates, undefined, id);
    }
    const calibrated = DOCTRINES_V1.filter((d) => d.calibratedBattleshipTemplates !== undefined);
    assert.deepStrictEqual(calibrated.map((d) => d.doctrineId).sort(), OVERLAID);
    for (const d of calibrated) {
      assert.deepStrictEqual(Object.keys(d.calibratedBattleshipTemplates), ["garrison"], d.doctrineId);
      assert.deepStrictEqual(plain(d.calibratedBattleshipTemplates.garrison), plain(BS_GARRISON), d.doctrineId);
    }
    const v18 = DOCTRINES_V1.find((d) => d.doctrineId === "empire-border-defense-v2").templates.garrison;
    const at520 = calTable(520);
    const raw = tableOf({});
    assert.deepStrictEqual([strengthOf(BS_GARRISON, at520), strengthOf(v18, at520)], [7225, 7674]);
    assert.ok(strengthOf(BS_GARRISON, raw) > strengthOf(v18, raw), `${strengthOf(BS_GARRISON, raw)} uncalibrated`);
    assert.strictEqual(strengthOf(BS_GARRISON, raw), 8464);
  });

  test("BD6 registry: calibrated garrison overlay behind the weak-post guard", () => {
    const garrisonOf = (reg, id, field = "templates") => plain(reg.getDoctrine(id)[field].garrison);
    const v18 = (id) => plain(DOCTRINES_V1.find((d) => d.doctrineId === id).templates.garrison);
    const hasBs = (entries) => entries.some((e) => e.hullGroup === "battleship");
    const on = registryOf("on", { battleshipPowerCalibrated: true, powerTable: calTable(520) });
    assert.deepStrictEqual(plain(on.battleshipGarrison), { applied: OVERLAID, dropped: [] });
    for (const id of OVERLAID) {
      assert.deepStrictEqual(garrisonOf(on, id), plain(BS_GARRISON), id);
      assert.ok(hasBs(on.getDoctrine(id).templates.invasion), id);
    }
    assert.deepStrictEqual(garrisonOf(on, "sansha-incursion-v1"), v18("sansha-incursion-v1"));

    const uncal = registryOf("on", { powerTable: calTable(520) });
    assert.deepStrictEqual(plain(uncal.battleshipGarrison), { applied: [], dropped: [] });
    for (const id of OVERLAID) assert.deepStrictEqual(garrisonOf(uncal, id), v18(id), id);

    const stock = registryOf("stock", { battleshipPowerCalibrated: true, powerTable: calTable(520) });
    assert.deepStrictEqual(plain(stock.battleshipGarrison.applied), OVERLAID);
    for (const id of OVERLAID) {
      assert.deepStrictEqual(garrisonOf(stock, id, "stockTemplates"), plain(BS_GARRISON), id);
      assert.deepStrictEqual(garrisonOf(stock, id), v18(id), id);
    }

    const strong = registryOf("on", { battleshipPowerCalibrated: true, powerTable: calTable(800) });
    assert.deepStrictEqual(plain(strong.battleshipGarrison), { applied: [], dropped: OVERLAID });
    for (const id of OVERLAID) {
      assert.deepStrictEqual(garrisonOf(strong, id), v18(id), id);
      assert.ok(hasBs(strong.getDoctrine(id).templates.invasion), `${id} invasion overlay stays`);
    }

    const noTable = registryOf("on", { battleshipPowerCalibrated: true });
    assert.deepStrictEqual(plain(noTable.battleshipGarrison), { applied: [], dropped: OVERLAID });

    const invalid = (detail) => ({ ok: false, reason: "REGISTRY_INVALID", detail });
    assert.deepStrictEqual(createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, battleshipPowerCalibrated: 1 }),
      invalid("ctx.battleshipPowerCalibrated"));
    assert.deepStrictEqual(createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, powerTable: [] }), invalid("ctx.powerTable"));
    const at = REGISTRY_DATA_V1.doctrines.findIndex((d) => d.doctrineId === "empire-border-defense-v2");
    const data = plain(REGISTRY_DATA_V1);
    data.doctrines[at].calibratedBattleshipTemplates.garrison = [{ hullGroup: "cruiser", count: 4 }];
    assert.deepStrictEqual(createFactionRegistry(data, CTX),
      invalid(`doctrines[${at}].calibratedBattleshipTemplates.garrison`));
  });

  test("BD7 startStrategy: start line with the calibration and the guard", () => {
    const linesOf = (env) => {
      const lines = [];
      const started = startStrategy({ config: resolveConfig({ modDir: MOD_DIR,
        env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } }).config,
      persistence: { ok: true, store: {}, journal: { applyOnce: () => ({ ok: false }), findByKey: () => null } },
      clock: createManualClock(1760000000000), logger: { log: (line) => lines.push(line) } });
      assert.ok(started.ok, JSON.stringify(started));
      return lines.filter((l) => l.startsWith("strategy: battleship"));
    };
    const on = { EVEJS_LNE_STRATEGY_BATTLESHIP_DOCTRINES: "on", EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_CALIBRATED: "1" };
    assert.deepStrictEqual(linesOf(on), ["strategy: battleshipDoctrines=on calibrated=on garrisonOverlay=4"]);
    assert.deepStrictEqual(linesOf({ ...on, EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_PERMILLE: "800" }), [
      "strategy: battleshipDoctrines=on calibrated=on garrisonOverlay=0",
      `strategy: battleship garrison overlay dropped (stronger than v18): ${OVERLAID.join(",")}`]);
    assert.deepStrictEqual(linesOf({}), []);
  });

  test("BD4 config strategy.battleshipDoctrines: default off, env on, bad value ignored; startStrategy stock", () => {
    const configOf = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    assert.strictEqual(configOf({}).config.strategy.battleshipDoctrines, "off");
    assert.strictEqual(configOf({ EVEJS_LNE_STRATEGY_BATTLESHIP_DOCTRINES: "on" }).config.strategy.battleshipDoctrines,
      "on");
    const badValue = configOf({ EVEJS_LNE_STRATEGY_BATTLESHIP_DOCTRINES: "always" });
    assert.strictEqual(badValue.config.strategy.battleshipDoctrines, "off");
    assert.ok(badValue.warnings.some((w) => w.includes("BATTLESHIP_DOCTRINES") || w.includes("battleshipDoctrines")),
      JSON.stringify(badValue.warnings));
    const lines = [];
    const started = startStrategy({ config: configOf({ EVEJS_LNE_STRATEGY_BATTLESHIP_DOCTRINES: "stock" }).config,
      persistence: { ok: true, store: {}, journal: { applyOnce: () => ({ ok: false }), findByKey: () => null } },
      clock: createManualClock(1760000000000),
      logger: { log: (line) => lines.push(line) } });
    assert.ok(started.ok, JSON.stringify(started));
    const empire = started.strategy.registry.getDoctrine("empire-border-defense-v2");
    assert.ok(empire.stockTemplates.invasion.some((e) => e.hullGroup === "battleship"));
    assert.ok(!empire.templates.invasion.some((e) => e.hullGroup === "battleship"));
    assert.ok(lines.includes("strategy: battleshipDoctrines=stock calibrated=off garrisonOverlay=0"),
      JSON.stringify(lines));
  });

  const bd5 = "BD5 vendor fact: the *_standard pool of every pirate faction has a battleship profile";
  const setup = npcSetupTables();
  if (!fs.existsSync(NPC_SRC)) skip(bd5, "server/src not found");
  else if (!setup.ok) skip(bd5, setup.reason);
  else {
    test(bd5, () => {
      assert.deepStrictEqual(PIRATE_KEYS.map((k) => Object.values(PIRATE_KEY_BY_FACTION_ID).includes(k)),
        PIRATE_KEYS.map(() => true));
      const hull = readSource("pirateHullProfiles.js");
      for (const k of PIRATE_KEYS) assert.ok(hull.includes(`  ${k}: "${k}_standard",`), `pool query ${k}`);
      for (const line of [".replace(/[_-]+/g, \" \")", ".replace(/\\s+/g, \" \");",
        "const pattern = new RegExp(`(^|[^a-z])${normalizedHullClass}([^a-z]|$)`);"]) {
        assert.ok(hull.includes(line), `pirateHullProfiles: ${line}`);
      }
      const npc = readSource("npcData.js");
      const exclusion = "const STANDARD_POOL_EXCLUDED_PROFILE_PATTERN = /commander|officer|domination|dread_guristas|"
        + "dark_blood|true_sansha|shadow_serpentis|overseer/i;";
      assert.ok(npc.includes(exclusion), "exclusion pattern");
      const excluded = /commander|officer|domination|dread_guristas|dark_blood|true_sansha|shadow_serpentis|overseer/i;
      for (const k of PIRATE_KEYS) {
        assert.ok(npc.includes(`  ${k}_standard: {\n    basePoolID: "${k}",\n    poolID: "${k}_standard",`),
          `spec ${k}`);
      }
      const pools = new Map(setup.tables.npcSpawnPools.spawnPools.map((p) => [p.spawnPoolID, p]));
      const profiles = new Map(setup.tables.npcProfiles.profiles.map((p) => [p.profileID, p]));
      const missing = PIRATE_KEYS.filter((k) => {
        const base = pools.get(k);
        const entries = base && Array.isArray(base.entries) ? base.entries : [];
        return !entries.some((e) => Number(e.weight) > 0 && !excluded.test(String(e.profileID))
          && profiles.has(e.profileID) && isBattleshipProfile(profiles.get(e.profileID)));
      });
      assert.deepStrictEqual(missing, [], `no battleship in the standard pool of: ${missing.join(", ")}`);
    });
  }
};
