"use strict";

const assert = require("node:assert");

const { FACTION_CORES_VERSION, FACTION_CORES } = require("../../lib/world/core/data");
const { buildCoreIndex, coreOwnerOf, isCoreStation, coreSystemIds, coreStationIds, auditCores,
  CORE_PROTECTED, CORE_VIOLATION_KINDS, CLAIM_STATES } = require("../../lib/world/core/coreIndex");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");

const SANSHA = 500019;
const AMARR = 500003;
const SYS_SANSHA_HQ = 30001868;
const SYS_AMARR_HQ = 30002187;
const STATION_SANSHA_HQ = "npc-60014284";
const STATION_AMARR_HQ = "upw-500003-30001721-1";

function getFaction(hqSystemId) {
  return FACTIONS_V1.find((f) => f.hqSystemId === hqSystemId);
}

module.exports = ({ test }) => {
  test("K1a core data: every faction with hqSystemId!== null has a core entry, Sleepers excluded", () => {
    const activeFactions = FACTIONS_V1.filter((f) => f.hqSystemId !== null && f.hqSystemId !== undefined);
    const coreFactionIds = new Set(FACTION_CORES.map((c) => c.factionId));
    for (const f of activeFactions.filter((x) => x.requiresFlag !== undefined)) {
      const core = FACTION_CORES.find((c) => c.factionId === f.factionId);
      assert.strictEqual(core && core.requiresFlag, f.requiresFlag, `faction ${f.factionId}: core requiresFlag`);
    }

    for (const f of activeFactions) {
      assert.ok(coreFactionIds.has(f.factionId), `faction ${f.factionId} (hq=${f.hqSystemId}) missing core entry`);
    }

    const sleepers = FACTIONS_V1.find((f) => f.factionId === 500021);
    assert.strictEqual(sleepers.hqSystemId, null, "Sleepers hq is null");
    assert.ok(!coreFactionIds.has(500021), "Sleepers should not have core entry");
  });

  test("K1b core data: systemIds[0] === hqSystemId (rule R-C)", () => {
    for (const core of FACTION_CORES) {
      const faction = getFaction(core.systemIds[0]);
      assert.ok(faction, `faction for hq ${core.systemIds[0]} not found in registry`);
      assert.strictEqual(core.systemIds[0], faction.hqSystemId, `core systemIds[0] must equal hqSystemId`);
    }
  });

  test("K1c core data: stationId follows R-C (first startStations in hq, else first startStations, else null)", () => {
    for (const core of FACTION_CORES) {
      const faction = FACTIONS_V1.find((f) => f.factionId === core.factionId);
      assert.ok(faction, `faction ${core.factionId} not found`);

      const hqStations = (faction.startStations || []).filter((s) => s.systemId === core.systemIds[0]);
      let expected = null;
      if (hqStations.length > 0) {
        const s = hqStations[0];
        expected = s.kind === "npc" ? `npc-${s.stationId}` : `upw-${faction.factionId}-${s.systemId}-1`;
      } else if (faction.startStations && faction.startStations.length > 0) {
        const s = faction.startStations[0];
        expected = s.kind === "npc" ? `npc-${s.stationId}` : `upw-${faction.factionId}-${s.systemId}-1`;
      }
      assert.strictEqual(core.stationId, expected, `faction ${core.factionId}: stationId=${core.stationId}, expected=${expected}`);
    }
  });

  test("K1d buildCoreIndex: duplicate systemId -> issues.length === 1, rest in index", () => {
    const badCores = [
      { factionId: 500003, systemIds: [30002187], stationId: "upw-500003-30001721-1" },
      { factionId: 500006, systemIds: [30002187], stationId: "upw-500006-30001718-1" },
      { factionId: 500019, systemIds: [30001868], stationId: "npc-60014284" },
    ];
    const idx = buildCoreIndex(badCores, { enabled: true, maxSystems: 3, version: 1 });
    assert.strictEqual(idx.issues.length, 1, `issues: ${JSON.stringify(idx.issues)}`);
    assert.ok(idx.issues[0].includes("duplicate systemId"));
    assert.strictEqual(idx.systems.size, 2, "two unique systems in index");
    assert.strictEqual(idx.byFaction.size, 2, "two factions in index");
  });

  test("K1e buildCoreIndex: flag off -> empty index, issues []", () => {
    const idx = buildCoreIndex(FACTION_CORES, { enabled: false, maxSystems: 3, version: 1 });
    assert.strictEqual(idx.enabled, false);
    assert.strictEqual(idx.systems.size, 0);
    assert.strictEqual(idx.stations.size, 0);
    assert.strictEqual(idx.byFaction.size, 0);
    assert.strictEqual(idx.issues.length, 0);
  });

  test("K1f auditCores: FOREIGN_CONTROLLER, NO_CONTROLLER, FOREIGN_CLAIM, HOME_MISMATCH, STATION_LOST, outOfScope, heldByFaction", () => {
    const idx = buildCoreIndex(FACTION_CORES, { enabled: true, maxSystems: 3, version: 1 });
    assert.ok(idx.enabled);

    const SYS_AMARR_HQ = 30002187;
    const SYS_CONCORD_HQ = 30005204;
    const SYS_SANS_HQ = 30001868;
    const STATION_AMARR = "upw-500003-30001721-1";
    const STATION_CONCORD = "upw-500006-30001718-1";
    const STATION_SANS = "npc-60014284";

    const rows = [
      { systemId: SYS_AMARR_HQ, controllerFactionId: SANSHA, occupierFactionId: SANSHA, occupationState: "CONTESTED", homeFactionId: SANSHA },
      { systemId: SYS_CONCORD_HQ, controllerFactionId: null, occupierFactionId: null, occupationState: "STABLE", homeFactionId: 500006 },
      { systemId: SYS_SANS_HQ, controllerFactionId: SANSHA, occupierFactionId: AMARR, occupationState: "INVASION", homeFactionId: SANSHA },
    ];
    const stations = [
      { stationId: STATION_AMARR, ownerFactionId: SANSHA, state: "ONLINE" },
      { stationId: STATION_CONCORD, ownerFactionId: 500006, state: "ONLINE" },
      { stationId: STATION_SANS, ownerFactionId: SANSHA, state: "ONLINE" },
    ];

    const audit = auditCores(idx, rows, stations);
    assert.strictEqual(audit.ok, true);

    const kinds = audit.violations.map((v) => v.kind).sort();
    assert.ok(kinds.includes("FOREIGN_CONTROLLER"), `FOREIGN_CONTROLLER missing, kinds: ${kinds.join(", ")}`);
    assert.ok(kinds.includes("NO_CONTROLLER"), "NO_CONTROLLER missing");
    assert.ok(kinds.includes("FOREIGN_CLAIM"), "FOREIGN_CLAIM missing");
    assert.ok(kinds.includes("HOME_MISMATCH"), "HOME_MISMATCH missing");
    assert.ok(kinds.includes("STATION_LOST"), "STATION_LOST missing");

    const heldSansha = audit.heldByFaction.get(SANSHA) || 0;
    assert.strictEqual(heldSansha, 1, "Sansha held=1");
  });

  test("K1f2 auditCores: home=null -> NO_CONTROLLER + HOME_MISMATCH; homeFactionId absent -> no HOME_MISMATCH", () => {
    const idx = buildCoreIndex(FACTION_CORES, { enabled: true, maxSystems: 3, version: 1 });
    const SYS_CONCORD_HQ = 30005204;
    const SYS_SANS_HQ = 30001868;
    const rows = [
      { systemId: SYS_CONCORD_HQ, controllerFactionId: null, occupierFactionId: null, occupationState: "STABLE",
        homeFactionId: null },
      { systemId: SYS_SANS_HQ, controllerFactionId: SANSHA, occupierFactionId: null, occupationState: "STABLE" },
    ];
    const audit = auditCores(idx, rows, null);
    const of = (sys) => audit.violations.filter((v) => v.ref === sys).map((v) => v.kind).sort();
    assert.deepStrictEqual(of(SYS_CONCORD_HQ), ["HOME_MISMATCH", "NO_CONTROLLER"]);
    assert.deepStrictEqual(of(SYS_SANS_HQ), []);
    assert.strictEqual(audit.heldByFaction.get(SANSHA), 1);
    assert.ok(!audit.violations.some((v) => v.kind === "STATION_MISSING"));
  });

  test("K1g auditCores: missing row -> outOfScope, missing station -> STATION_MISSING", () => {
    const idx = buildCoreIndex(FACTION_CORES, { enabled: true, maxSystems: 3, version: 1 });
    const SYS_AMARR_HQ = 30002187;
    const SYS_SANS_HQ = 30001868;
    const STATION_AMARR = "upw-500003-30001721-1";
    const STATION_SANS = "npc-60014284";

    const rows = [
      { systemId: SYS_AMARR_HQ, controllerFactionId: AMARR, occupierFactionId: null, occupationState: "STABLE", homeFactionId: AMARR },
    ];
    const stations = [
      { stationId: STATION_AMARR, ownerFactionId: AMARR, state: "ONLINE" },
    ];

    const audit = auditCores(idx, rows, stations);
    assert.ok(audit.outOfScope.includes(SYS_SANS_HQ), "Sansha HQ should be outOfScope");
    const stationMissing = audit.violations.find((v) => v.kind === "STATION_MISSING" && v.ref === STATION_SANS);
    assert.ok(stationMissing, `STATION_MISSING for Sansha base station, violations: ${JSON.stringify(audit.violations)}`);
  });

  test("K1h coreOwnerOf, isCoreStation, coreSystemIds, coreStationIds", () => {
    const idx = buildCoreIndex(FACTION_CORES, { enabled: true, maxSystems: 3, version: 1 });
    assert.strictEqual(coreOwnerOf(idx, SYS_SANSHA_HQ), SANSHA);
    assert.strictEqual(coreOwnerOf(idx, SYS_AMARR_HQ), AMARR);
    assert.strictEqual(coreOwnerOf(idx, 99999999), null);
    assert.strictEqual(isCoreStation(idx, STATION_SANSHA_HQ), true);
    assert.strictEqual(isCoreStation(idx, "npc-99999999"), false);

    const sysIds = coreSystemIds(idx);
    assert.ok(sysIds.includes(SYS_SANSHA_HQ));
    assert.ok(sysIds.includes(SYS_AMARR_HQ));
    assert.ok(sysIds.every((v, i, a) => i === 0 || a[i - 1] <= v), "coreSystemIds not sorted");

    const stIds = coreStationIds(idx);
    assert.ok(stIds.includes(STATION_SANSHA_HQ));
    assert.ok(stIds.includes(STATION_AMARR_HQ));
    assert.ok(stIds.every((v, i, a) => i === 0 || a[i - 1] <= v), "coreStationIds not sorted");
  });

  test("K-hive: getCoreIndex gates the hive core by hive.enabled, config has no issues", () => {
    const { getCoreIndex, coresFor } = require("../../lib/world/core");
    const { resolveConfig } = require("../../config");
    const HIVE_HQ = 30001051;
    const world = { coreProtectionEnabled: true, coreMaxSystemsPerFaction: 3 };
    const legacy = FACTION_CORES.filter((c) => c.requiresFlag === undefined);
    assert.strictEqual(legacy.length, 13, "13 cores without a flag (today)");

    const off = getCoreIndex({ world, hive: { enabled: false } });
    assert.strictEqual(coreOwnerOf(off, HIVE_HQ), null, "off: no TD-4XL core");
    const today = buildCoreIndex(legacy, { enabled: true, maxSystems: 3, version: FACTION_CORES_VERSION });
    assert.deepStrictEqual([...off.systems], [...today.systems], "off: same system map as today");
    assert.deepStrictEqual([...off.stations], [...today.stations], "off: same station map as today");
    assert.deepStrictEqual([...off.byFaction], [...today.byFaction], "off: same byFaction map as today");
    assert.deepStrictEqual(off.issues, []);
    assert.deepStrictEqual(coresFor({}), legacy, "no hive section = off");

    const on = getCoreIndex({ world, hive: { enabled: true } });
    assert.strictEqual(coreOwnerOf(on, HIVE_HQ), 500025, "on: TD-4XL core of the hive");
    assert.deepStrictEqual(on.issues, []);
    assert.strictEqual(coreOwnerOf(getCoreIndex({ world, hive: { enabled: false } }), HIVE_HQ), null, "memo key has the flag");

    const r = resolveConfig({ modDir: require("node:path").join(__dirname, "..", ".."),
      env: { EVEJS_LNE_HIVE_ENABLED: "1", EVEJS_LNE_WORLD_CORE_PROTECTION_ENABLED: "1" } });
    assert.strictEqual(r.config.hive.enabled, true);
    assert.deepStrictEqual(r.warnings.filter((w) => String(w).startsWith("world.core")), [], "config validation: no issues");
  });
};