"use strict";

const assert = require("node:assert");
const path = require("node:path");

const fp = require("../../lib/adapter/factionProfiles");
const DATA = require("../../lib/adapter/data/factionLiveProfiles");
const CIV = require("../../lib/adapter/data/civilianLiveProfiles");
const loader = require("../../loader");
const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { pickRole, stepShip, civilianProfilesByRole } = require("../../lib/highsecLife/traffic/plan");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 19, 20, 0, 0);
const SYS = 30000144;

function T(over, hulls) {
  const traffic = { ...resolveConfig({ modDir: MOD_DIR, env: {} }).config.highsecLife.traffic, ...(over || {}) };
  const r = trafficSettingsOf({ highsecLife: { traffic, civilianHullsEnabled: hulls === true } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [node(60001, 5e8)],
  belts: [node(40001, 3e8)] });

function harness(settings, extra, nodes) {
  const specs = [];
  const alive = new Map();
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, ...(nodes || NODES) }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: (_id, spec) => {
      specs.push(spec);
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      return { ok: true, entityId: next };
    },
    warpTo: (_id, entityId, point) => {
      alive.set(entityId, point);
      return { ok: true, warped: true };
    },
    readShips: (_id, ids) => ({ ok: true, sceneLoaded: true,
      live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: false })),
      gone: ids.filter((e) => !alive.has(e)) }),
    despawn: (_id, ids) => {
      for (const e of ids) alive.delete(e);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: () => ({ ok: true, ids: [] }),
    dockPointOf: () => ({ ok: false, reason: "NO_STATION" }),
  };
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const made = createTraffic({ settings, scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: [{ profileId: "vendor", weight: 1 }],
    getGovernor: () => ({ admits: () => true }), ...(extra || {}) });
  assert.ok(made.ok, JSON.stringify(made));
  return { traffic: made.traffic, clock, specs, alive };
}

module.exports = ({ test }) => {
  test("CH1 civilianRows:true -> lne_civ_* rows (ORE owner, bounty 0, NPC presentation); off -> bit for bit", () => {
    const before = fp.buildFactionProfileRows({ data: DATA, bountyFreighters: true });
    const off = fp.buildFactionProfileRows({ data: DATA, bountyFreighters: true, civilianRows: false,
      civilianData: CIV });
    assert.deepStrictEqual(off, before, "civilianRows off = the build of today");
    const on = fp.buildFactionProfileRows({ data: DATA, bountyFreighters: true, civilianRows: true, civilianData: CIV });
    assert.strictEqual(on.ok, true);
    assert.deepStrictEqual(on.index, before.index);
    const civ = on.rows.npcProfiles.filter((r) => r.profileID.startsWith("lne_civ_"));
    assert.deepStrictEqual(on.rows.npcProfiles.slice(0, before.rows.npcProfiles.length), [...before.rows.npcProfiles],
      "civilian rows after the rows of today");
    assert.strictEqual(civ.length, CIV.CIVILIAN_HULLS.length);
    for (const [i, h] of CIV.CIVILIAN_HULLS.entries()) {
      const r = civ[i];
      assert.deepStrictEqual([r.profileID, r.shipTypeID, r.presentationTypeID, r.name, r.shipNameTemplate,
        r.presentationName, r.corporationID, r.factionID, r.bounty, r.lootTableID, r.loadoutID, r.behaviorProfileID,
        r.hardwareFamily, r.entityType],
      [`lne_civ_${h.key}`, h.shipTypeId, h.presentationTypeId, h.label, h.label, h.label, 1000129, 500014, 0,
        DATA.PLACEHOLDER_LOOT_TABLE_ID, "retail_empty_npc_entity_loadout", "npc_passive_idle", "miningOps", "npc"],
      h.key);
    }
    const only = fp.buildFactionProfileRows({ data: DATA, includeFactions: false, civilianRows: true,
      civilianData: CIV });
    assert.deepStrictEqual(only.rows.npcProfiles, civ, "only the civilians");
  });

  test("CH2 civilian data: >= 8 hulls of every class, presentation != hull, roles from the set, weights > 0; a bad "
    + "entry refuses the whole build", () => {
    const hulls = CIV.CIVILIAN_HULLS;
    assert.ok(hulls.length >= 8);
    for (const h of hulls) {
      assert.notStrictEqual(h.presentationTypeId, h.shipTypeId, h.key);
      assert.ok(h.roles.length > 0 && h.roles.every((r) => fp.CIVILIAN_ROLES.includes(r)), h.key);
      assert.ok(h.weight > 0, h.key);
    }
    for (const key of ["venture", "retriever", "badger", "astero", "catalyst", "stratios"]) {
      assert.ok(hulls.some((h) => h.key === key), key);
    }
    const build = (entry) => fp.buildFactionProfileRows({ data: DATA, civilianRows: true,
      civilianData: { ...CIV, CIVILIAN_HULLS: [...hulls.slice(1), entry] } });
    const good = hulls[0];
    assert.strictEqual(build(good).ok, true);
    for (const bad of [{ ...good, presentationTypeId: good.shipTypeId }, { ...good, roles: ["WARSHIP"] },
      { ...good, roles: [] }, { ...good, weight: 0 }, { ...good, key: hulls[1].key }, { ...good, label: "" },
      { ...good, loadoutId: undefined }]) {
      assert.deepStrictEqual(build(bad), { ok: false, reason: "INVALID_INPUT" }, JSON.stringify(bad));
    }
    assert.deepStrictEqual(fp.buildFactionProfileRows({ data: DATA, civilianRows: true }),
      { ok: false, reason: "INVALID_INPUT" }, "civilianRows without the data");
  });

  test("CH3 loader gate: three gates off -> no wrap; only civilianHullsEnabled -> civilian rows only", () => {
    const CATALOG = path.join(path.sep, "x", "server", "src", "space", "npc", "capitals", "capitalNpcCatalog");
    const PARENT = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "npcData.js") };
    const lines = [];
    const logger = { log: (l) => lines.push(l), logError: () => {}, debug: () => {} };
    const original = (t) => (t === "npcProfiles" ? [{ profileID: "vendor_row" }] : []);
    const run = (civilianHullsEnabled) => {
      const catalogExports = { getCapitalNpcGeneratedRows: original };
      const moduleApi = { _cache: {}, _load: (request) => (request === CATALOG ? catalogExports : {}) };
      const ctx = { state: {}, logger, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: true, debug: false, dataDir: "/x",
          modules: { materialization: { enabled: false }, world: { enabled: true } },
          materialization: { capitalLiveEnabled: false, factionProfilesEnabled: false },
          bountyHunters: { enabled: false, smugglerEnabled: false },
          highsecLife: { enabled: true, civilianHullsEnabled } } }) };
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), logger);
      moduleApi._load(CATALOG, PARENT);
      return { ctx, catalogExports };
    };
    try {
      fp._resetForTest();
      const off = run(false);
      assert.deepStrictEqual([off.ctx.state.factionProfiles, off.catalogExports.getCapitalNpcGeneratedRows === original],
        ["disabled", true]);
      fp._resetForTest();
      const on = run(true);
      assert.strictEqual(on.ctx.state.factionProfiles, "civilian_only");
      const rows = on.catalogExports.getCapitalNpcGeneratedRows("npcProfiles");
      assert.deepStrictEqual(rows.map((r) => r.profileID), ["vendor_row",
        ...CIV.CIVILIAN_HULLS.map((h) => `lne_civ_${h.key}`)]);
      assert.ok(lines.includes(`factionLiveProfiles: civilian_only - ${CIV.CIVILIAN_HULLS.length} NPC profile row(s) `
        + "injected"), lines.join("\n"));
    } finally {
      fp._resetForTest();
    }
  });

  test("CH3b loader gate: bounty_civilian, factions + civilians (wrapped), each part of the civilian gate off -> no "
    + "civilian rows", () => {
    const CATALOG = path.join(path.sep, "x", "server", "src", "space", "npc", "capitals", "capitalNpcCatalog");
    const PARENT = { filename: path.join(path.sep, "x", "server", "src", "space", "npc", "npcData.js") };
    const logger = { log: () => {}, logError: () => {}, debug: () => {} };
    const original = (t) => (t === "npcProfiles" ? [{ profileID: "vendor_row" }] : []);
    const CIV_IDS = CIV.CIVILIAN_HULLS.map((h) => `lne_civ_${h.key}`);
    const run = (over) => {
      const o = { master: true, world: true, hsl: true, civ: true, factions: false, bounty: false, ...over };
      const catalogExports = { getCapitalNpcGeneratedRows: original };
      const moduleApi = { _cache: {}, _load: (request) => (request === CATALOG ? catalogExports : {}) };
      const ctx = { state: {}, logger, loadConfig: () => ({ ok: true, sources: {}, warnings: [], errors: [],
        config: { enabled: o.master, debug: false, dataDir: "/x",
          modules: { materialization: { enabled: false }, world: { enabled: o.world } },
          materialization: { capitalLiveEnabled: false, factionProfilesEnabled: o.factions },
          bountyHunters: { enabled: o.bounty, smugglerEnabled: o.bounty },
          highsecLife: { enabled: o.hsl, civilianHullsEnabled: o.civ } } }) };
      fp._resetForTest();
      loader.installModuleHook(moduleApi, loader.buildHooks(ctx), logger);
      moduleApi._load(CATALOG, PARENT);
      const wrapped = catalogExports.getCapitalNpcGeneratedRows !== original;
      const ids = wrapped ? catalogExports.getCapitalNpcGeneratedRows("npcProfiles").map((r) => r.profileID) : [];
      return { state: ctx.state.factionProfiles, wrapped, ids };
    };
    try {
      const both = run({ bounty: true });
      assert.strictEqual(both.state, "bounty_civilian");
      assert.ok(CIV_IDS.every((id) => both.ids.includes(id)), "civilian rows");
      assert.ok(both.ids.some((id) => id.startsWith("lne_bounty_")), "smuggler freighter rows");
      const withFactions = run({ factions: true });
      assert.strictEqual(withFactions.state, "wrapped");
      assert.ok(CIV_IDS.every((id) => withFactions.ids.includes(id)), "civilian rows with the faction rows");
      assert.ok(withFactions.ids.some((id) => id !== "vendor_row" && !CIV_IDS.includes(id)), "faction rows");
      for (const part of ["master", "world", "hsl"]) {
        const off = run({ [part]: false });
        assert.deepStrictEqual([off.state, off.wrapped], ["disabled", false], part);
      }
      const noHsl = run({ factions: true, hsl: false });
      assert.deepStrictEqual([noHsl.state, noHsl.ids.some((id) => CIV_IDS.includes(id))], ["wrapped", false]);
    } finally {
      fp._resetForTest();
    }
  });

  test("CH4 MINER: SPAWNED -> WARPING (belt) -> MINING -> WARPING (exit) -> ARRIVED -> despawn; no belt -> no MINER", () => {
    const S = T({ minerEnabled: true, minerPermille: 1000, spawnIntervalMs: 3600000 }, true);
    assert.strictEqual(T().civilianHullsEnabled, false);
    assert.strictEqual(pickRole(() => 0, NODES, S), "MINER");
    assert.strictEqual(pickRole(() => 0, { ...NODES, belts: [] }, S), "HAULER", "a system without a belt");
    assert.strictEqual(pickRole(() => 0, NODES, T({ minerPermille: 1000 })), "HAULER", "minerEnabled off");
    const ship = { role: "MINER", state: "MINING", leg: "BELT", spawnedAt: 0, arrivedAt: null, warpAttempts: 0,
      stayMs: S.minerStayMaxMs, mineUntil: S.maxLifetimeMs + 10, targetPoint: { x: 0, y: 0, z: 0 } };
    const seen = { live: true, inWarp: false, position: { x: 0, y: 0, z: 0 } };
    assert.deepStrictEqual(stepShip(ship, seen, S.maxLifetimeMs, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(ship, seen, S.maxLifetimeMs + 10, S), { kind: "leave" });

    const byRole = civilianProfilesByRole(CIV);
    const h = harness(S, { profilesByRole: byRole });
    h.traffic.tick();
    assert.strictEqual(h.specs.length, 2);
    const minerIds = new Set(byRole.MINER.map((p) => p.profileId));
    assert.ok(h.specs.every((s) => minerIds.has(s.profileId) && s.gateId === 50001), JSON.stringify(h.specs));
    assert.strictEqual(h.traffic.status().counters.miners, 2);
    const belt = { x: 3e8 + S.minerAsteroidMeters, y: 0, z: 0 };
    h.clock.t += S.departDelayMs;
    h.traffic.tick();
    assert.deepStrictEqual([...h.alive.values()], [belt, belt]);
    h.clock.t += 1;
    h.traffic.tick();
    h.clock.t += S.minerStayMinMs - 1;
    h.traffic.tick();
    assert.deepStrictEqual([...h.alive.values()], [belt, belt], "still at the belt");
    h.clock.t += 1;
    h.traffic.tick();
    const exit = [...h.alive.values()][0];
    assert.ok(exit.x > 3e8 && exit.x < 5e8, JSON.stringify(exit));
    h.clock.t += 1;
    h.traffic.tick();
    h.clock.t += S.dockDelayMs;
    h.traffic.tick();
    const c = h.traffic.status().counters;
    assert.deepStrictEqual([c.arrived, c.expired, h.traffic.shipsIn(SYS)], [2, 0, 0]);

    const I = T({ gateIdleEnabled: true, gateIdlePermille: 1000, gateIdleMinMs: 600000, gateIdleMaxMs: 600000 });
    const g = harness(I);
    g.traffic.tick();
    g.clock.t += I.maxLifetimeMs;
    g.traffic.tick();
    assert.deepStrictEqual([g.traffic.status().counters.gateIdle, g.traffic.status().counters.expired], [2, 0]);

    const n = harness(T({ namesEnabled: true }), { speakersOf: () => ({ ok: true, civilians: [11], residents: [] }),
      readCharacterNames: () => ({ ok: false, reason: "SEAM_UNAVAILABLE" }) });
    n.traffic.tick();
    assert.deepStrictEqual([n.traffic.status().counters["failed.names"], n.traffic.status().counters["failed.read"]],
      [2, 0]);

    const U = T({ undockEnabled: true, undockPermille: 1000 }, true);
    const u = harness(U, { profilesByRole: byRole });
    u.traffic.tick();
    const hullOf = new Map(byRole.UNDOCK.map((p) => [p.profileId, p.shipTypeId]));
    assert.ok(u.specs.every((s) => s.undock === true && s.shipTypeId === hullOf.get(s.profileId)));
    const v = harness(U);
    v.traffic.tick();
    assert.ok(v.specs.every((s) => !("shipTypeId" in s)));
  });

  test("SC6 lne_civ_capsule: hull 670, presentation 27287, role POD in CIVILIAN_ROLES; never a traffic role", () => {
    const pod = CIV.CIVILIAN_HULLS.find((h) => h.key === "capsule");
    assert.ok(pod, "capsule entry");
    assert.deepStrictEqual([CIV.civilianProfileId(pod.key), pod.shipTypeId, pod.presentationTypeId, pod.roles],
      ["lne_civ_capsule", 670, 27287, ["POD"]]);
    assert.ok(fp.CIVILIAN_ROLES.includes("POD"));
    const row = fp.buildFactionProfileRows({ data: DATA, includeFactions: false, civilianRows: true,
      civilianData: CIV }).rows.npcProfiles.find((r) => r.profileID === "lne_civ_capsule");
    assert.deepStrictEqual([row.shipTypeID, row.presentationTypeID, row.factionID, row.bounty], [670, 27287, 500014, 0]);
    const byRole = civilianProfilesByRole(CIV);
    assert.ok(!("POD" in byRole), "POD is not a traffic role");
    for (const [role, list] of Object.entries(byRole)) {
      assert.ok(list.every((p) => p.profileId !== "lne_civ_capsule"), role);
    }
  });
};
