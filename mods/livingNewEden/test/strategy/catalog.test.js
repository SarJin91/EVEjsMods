"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { readFactionInputs } = require("../../tools/factions/sdeFactions");
const { buildCatalog, secClassOf } = require("../../tools/factions/buildCatalog");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");

const FIXTURE = path.join(__dirname, "fixtures", "sde-mini");
const CATALOG_FILE = path.join(__dirname, "..", "..", "lib", "strategy", "data", "factionCatalog.js");
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
const plain = (v) => JSON.parse(JSON.stringify(v));

const EXPECTED_MINI = [
  { factionId: 900001, name: "Mini Empire", corporationId: 910001, militiaCorporationId: 910003,
    sdeHqSystemId: 30000001, ownRegionIds: [10000001], borderRegionIds: [10000001],
    corporations: [
      { corporationId: 910001, name: "Empire Navy", ticker: "EN", ceoId: 3910001, stationCount: 3 },
      { corporationId: 910002, name: "Empire Industry", ticker: "EI", ceoId: 3910002, stationCount: 3 },
      { corporationId: 910003, name: "Empire Militia", ticker: "EM", ceoId: null, stationCount: 0 }],
    stations: [[60000001, 30000001, 910001], [60000002, 30000002, 910002], [60000003, 30000002, 910001],
      [60000004, 30000004, 910002], [60000005, 30000005, 910001], [60000006, 30000006, 910002]],
    candidates: { border: [[60000004, 30000004, 910002, 1], [60000003, 30000002, 910001, 3],
      [60000001, 30000001, 910001, 4]], nullsec: [[60000005, 30000005, 910001, 0]], suggestedBaseSystemId: 30000005 } },
  { factionId: 900002, name: "Mini Pirates", corporationId: 920001, militiaCorporationId: null,
    sdeHqSystemId: 30000020, ownRegionIds: [10000002], borderRegionIds: [],
    corporations: [
      { corporationId: 920001, name: "Pirate Command", ticker: "PC", ceoId: 3920001, stationCount: 1 },
      { corporationId: 920002, name: "Pirate Works", ticker: "PW", ceoId: 3920002, stationCount: 2 }],
    stations: [[60000021, 30000021, 920002], [60000022, 30000021, 920001], [60000023, 30000022, 920002]],
    candidates: { border: [], nullsec: [[60000022, 30000021, 920001, 0], [60000021, 30000021, 920002, 0],
      [60000023, 30000022, 920002, 1]], suggestedBaseSystemId: 30000021 } },
  { factionId: 900003, name: "Mini Lonely", corporationId: null, militiaCorporationId: null, sdeHqSystemId: 30000003,
    ownRegionIds: [], borderRegionIds: [], corporations: [], stations: [],
    candidates: { border: [], nullsec: [], suggestedBaseSystemId: 30000003 } },
];

module.exports = ({ test, skip }) => {
  test("C1 catalog builder on sde-mini: corporations, stations, border regions, R-B (1 per system, by jumps) "
    + "R-N base = most stations, faction without corporations, deterministic, sec -0.04 = nullsec", async () => {
    const inputs = await readFactionInputs(FIXTURE);
    assert.strictEqual(inputs.deletedCorporations, 1);
    const a = buildCatalog(inputs);
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(plain(a.catalog), EXPECTED_MINI);
    assert.deepStrictEqual(a.header, { buildNumber: 1, releaseDate: "2026-01-01T00:00:00Z", catalogVersion: 1 });
    const b = buildCatalog(await readFactionInputs(FIXTURE));
    assert.strictEqual(b.source, a.source, "two runs = the same text");
    const m = { exports: {} };
    vm.runInNewContext(a.source, { module: m });
    assert.deepStrictEqual(plain(m.exports.FACTION_CATALOG), EXPECTED_MINI);
    assert.ok(Object.isFrozen(m.exports.FACTION_CATALOG[0].candidates.border[0]));
    assert.deepStrictEqual([secClassOf(30000005, -0.04), secClassOf(30000004, 0.03), secClassOf(30000001, 0.45),
      secClassOf(30000001, 0.44), secClassOf(31000001, -1)], ["nullsec", "lowsec", "highsec", "lowsec", "wormhole"]);
    await assert.rejects(readFactionInputs(path.join(FIXTURE, "missing")), /missing SDE files/);
  });

  if (!fs.existsSync(CATALOG_FILE)) {
    skip("C2 registry v4 vs SDE catalog", "lib/strategy/data/factionCatalog.js not generated yet "
      + "(node mods/livingNewEden/tools/buildFactionCatalog.js on a machine with the SDE)");
    return;
  }
  test("C2 registry v4 vs SDE catalog: ok, 27 = 27, owners and NPC start stations in the catalog "
    + "fake stationId / ownerCorporationId -> REGISTRY_INVALID with the path", () => {
    const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const built = createFactionRegistry(REGISTRY_DATA_V1, CTX);
    assert.ok(built.ok, JSON.stringify(built));
    const reg = built.registry;
    assert.strictEqual(FACTION_CATALOG.length, 27);
    assert.deepStrictEqual(reg.listFactions().map((f) => f.factionId), FACTION_CATALOG.map((e) => e.factionId));
    const byId = new Map(FACTION_CATALOG.map((e) => [e.factionId, e]));
    for (const f of reg.listFactions()) {
      const e = byId.get(f.factionId);
      if (f.ownerCorporationId !== null) {
        assert.ok(e.corporations.some((c) => c.corporationId === f.ownerCorporationId), `${f.factionId} owner`);
        assert.strictEqual(reg.getCorporation(f.ownerCorporationId).factionId, f.factionId);
      }
      for (const s of f.startStations.filter((x) => x.kind === "npc")) {
        assert.ok(e.stations.some(([st, sys, corp]) => st === s.stationId && sys === s.systemId
          && corp === s.corporationId), `${f.factionId} station ${s.stationId}`);
      }
    }
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const sansha = REGISTRY_DATA_V1.factions.findIndex((f) => f.factionId === 500019);
    const badStation = clone(REGISTRY_DATA_V1);
    badStation.factions[sansha].startStations[0].stationId += 1000000;
    const badOwner = clone(REGISTRY_DATA_V1);
    badOwner.factions[sansha].ownerCorporationId = badOwner.factions[0].ownerCorporationId;
    for (const [data, detail] of [[badStation, `factions[${sansha}].startStations[0].stationId`],
      [badOwner, `factions[${sansha}].ownerCorporationId`]]) {
      assert.deepStrictEqual(createFactionRegistry(data, CTX), { ok: false, reason: "REGISTRY_INVALID", detail });
    }
  });

  const AMARR_NPC = [[60006658, 30003563, 1000067], [60006673, 30004299, 1000067], [60007948, 30004309, 1000080],
    [60006448, 30003562, 1000065]];
  test("T1 registry v14: Amarr = Saminer Upwell first + candidates.border 1-4 (one per system), origin R-B "
    + "CONCORD keeps 1 Upwell, 0 NPC (Serpentis: T4)", () => {
    const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const built = createFactionRegistry(REGISTRY_DATA_V1, CTX);
    assert.ok(built.ok, JSON.stringify(built));
    const reg = built.registry;
    assert.strictEqual(reg.version.factions, 19);
    const amarr = reg.getFaction(500003);
    const [upwell, ...npc] = amarr.startStations;
    assert.deepStrictEqual(plain(upwell), { kind: "upwell", systemId: 30001721, structureFamily: "astrahus" });
    const border = FACTION_CATALOG.find((e) => e.factionId === 500003).candidates.border.slice(0, 4);
    assert.deepStrictEqual(npc.map((s) => [s.kind, s.stationId, s.systemId, s.corporationId]),
      border.map(([st, sys, corp]) => ["npc", st, sys, corp]));
    assert.deepStrictEqual(npc.map((s) => [s.stationId, s.systemId, s.corporationId]), AMARR_NPC);
    const systems = new Set(npc.map((s) => s.systemId));
    assert.strictEqual(systems.size, 4, "one station per system");
    assert.ok(!systems.has(30001721), "no NPC station in Saminer");
    assert.ok(amarr.origin.includes("R-B"), amarr.origin);
    for (const id of [500006]) {
      const st = reg.getFaction(id).startStations;
      assert.deepStrictEqual([st.length, st.filter((s) => s.kind === "npc").length], [1, 0], String(id));
      assert.strictEqual(st[0].kind, "upwell");
    }
  });

  test("T3 vendor fact (catalog text, no EveJS): the 4 Amarr NPC stations are rows of the catalog with an "
    + "Amarr corporation, systems in known space", () => {
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const entry = FACTION_CATALOG.find((e) => e.factionId === 500003);
    const corps = new Set(entry.corporations.map((c) => c.corporationId));
    for (const [st, sys, corp] of AMARR_NPC) {
      assert.ok(entry.stations.some(([s, y, c]) => s === st && y === sys && c === corp), `station ${st}`);
      assert.ok(corps.has(corp), `corporation ${corp} of Amarr`);
      assert.ok(sys >= 30000000 && sys <= 30999999, `system ${sys} in known space`);
    }
  });

  test("T4 registry v17: Serpentis = NM-OEA Upwell first + 2 NPC stations of 1000135 in Fountain, one per "
    + "system", () => {
    const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const built = createFactionRegistry(REGISTRY_DATA_V1, CTX);
    assert.ok(built.ok, JSON.stringify(built));
    const reg = built.registry;
    assert.strictEqual(reg.version.factions, 19);
    const serp = reg.getFaction(500020);
    assert.deepStrictEqual(serp.startStations.map(plain), [
      { kind: "upwell", systemId: 30004518, structureFamily: "astrahus" },
      { kind: "npc", stationId: 60012859, systemId: 30004623, corporationId: 1000135 },
      { kind: "npc", stationId: 60012862, systemId: 30004619, corporationId: 1000135 },
    ]);
    assert.deepStrictEqual([...serp.homeRegionIds], [10000057]);
    assert.deepStrictEqual([...serp.allies], [500011]);
    const entry = FACTION_CATALOG.find((e) => e.factionId === 500020);
    assert.ok(entry.corporations.some((c) => c.corporationId === 1000135), "1000135 is a Serpentis corporation");
    for (const [st, sys, corp] of [[60012859, 30004623, 1000135], [60012862, 30004619, 1000135]]) {
      assert.ok(entry.stations.some(([s, y, c]) => s === st && y === sys && c === corp), `station ${st}`);
      assert.ok(entry.candidates.nullsec.some(([s, y, c]) => s === st && y === sys && c === corp), `nullsec ${st}`);
    }
  });

  test("C5 registry v18: 500016 active neutral, hq X-7OMU, 5 NPC start stations = the first 5 "
    + "rows of candidates.nullsec of the catalog (SDE fact on the catalog text), owner = catalog corporation, core "
    + "X-7OMU", () => {
    const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
    const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");
    const { FACTION_CORES } = require("../../lib/world/core/data");
    const built = createFactionRegistry(REGISTRY_DATA_V1, CTX);
    assert.ok(built.ok, JSON.stringify(built));
    const reg = built.registry;
    assert.strictEqual(reg.version.factions, 19);
    const soe = reg.getFaction(500016);
    assert.deepStrictEqual([soe.activity, soe.kind, soe.hqSystemId, soe.doctrineId, [...soe.homeRegionIds]],
      ["active", "neutral", 30001978, "soe-territorial-v1", [10000023]]);
    const rows = soe.startStations.map((s) => [s.kind, s.stationId, s.systemId, s.corporationId]);
    assert.deepStrictEqual(rows, [["npc", 60012595, 30001978, 1000130], ["npc", 60013075, 30001978, 1000139],
      ["npc", 60014056, 30001978, 1000159], ["npc", 60012598, 30001977, 1000130], ["npc", 60012601, 30001983, 1000130]]);
    const entry = FACTION_CATALOG.find((e) => e.factionId === 500016);
    const corps = new Set(entry.corporations.map((c) => c.corporationId));
    for (const corp of [1000130, 1000139, 1000159]) assert.ok(corps.has(corp), `corporation ${corp} of 500016`);
    for (const [, st, sys, corp] of rows) {
      assert.ok(entry.stations.some(([s, y, c]) => s === st && y === sys && c === corp), `station ${st}`);
    }
    assert.deepStrictEqual(rows.map((r) => r.slice(1)), entry.candidates.nullsec.slice(0, 5).map((r) => r.slice(0, 3)));
    assert.strictEqual(soe.hqSystemId, entry.candidates.suggestedBaseSystemId);
    assert.deepStrictEqual([soe.ownerCorporationId, entry.corporationId], [1000130, 1000130]);
    assert.ok(!soe.origin.includes("1000131"), soe.origin);
    const core = FACTION_CORES.find((c) => c.factionId === 500016);
    assert.deepStrictEqual(core && [[...core.systemIds], core.stationId], [[30001978], "npc-60012595"]);
  });
};
