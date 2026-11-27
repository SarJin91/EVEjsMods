"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { doctrineOf } = require("../../lib/nemesis/doctrine");
const DATA = require("../../lib/nemesis/data/doctrine");
const { profileOf } = require("../../lib/nemesis/policy");
const NS = require("../../lib/nemesis");
const { killboardProfileOf } = require("../../lib/nemesis/step");
const { createKillboardRepository } = require("../../lib/killboard/repository");
const { createNemesisEwar, PATHS } = require("../../lib/adapter/nemesisEwar");
const bountyScene = require("../../lib/adapter/bountyScene");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const os = require("node:os");
const config = require("../../config");

const { MODULE_NAMES } = config;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");
const { loadDriver, withStore } = require("../notices/storeHelper");
const R = require("./returns.test").helpers;

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
const typeOf = (group) => Object.values(TYPES).find((t) => Number.isSafeInteger(t.typeId) && t.hullGroup === group)
  .typeId;

function fakeVendor() {
  const calls = { pools: 0 };
  const attrs = { 11: { ecm: 1 }, 12: { web: 1 }, 13: {} };
  const modules = {
    [PATHS.pools]: { STANDARD_POOL_QUERY_BY_FACTION: { guristas: "guristas_standard" },
      listPoolCandidates: (pool, cls) => {
        calls.pools += 1;
        return pool === "guristas_standard" && cls === "cruiser"
          ? [{ profileID: "p_a", weight: 1 }, { profileID: "p_b", weight: 1 }, { profileID: "p_c", weight: 1 }] : [];
      } },
    [PATHS.npc]: { getNpcProfile: (id) => ({ profileID: id, shipTypeID: { p_a: 11, p_b: 12, p_c: 13 }[id] }) },
    [PATHS.fitting]: { getTypeAttributeMap: (typeId) => ({ ...attrs[typeId] }) },
    [PATHS.ewar]: { resolveEntityEwarSpecs: (m) => Object.keys(m).map((family) => ({ family, effectName: "x",
      activationChance: 0.5, rangeMeters: 0 })) },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
  return { modules, requireGame, calls };
}

module.exports = ({ test, skip }) => {
  test("ND1 doctrineOf: deterministic, empty profile -> base, class cap, EWAR <= min(maxEwarEscorts, rank)", () => {
    const P = { maxEwarEscorts: 2 };
    const input = { profile: { battleship: 3, frigate: 1 }, hunterLevel: 5, rank: 3, seed: 77, escortCount: 5 };
    const a = doctrineOf(input, DATA, P);
    assert.deepStrictEqual(a, doctrineOf(input, DATA, P));
    assert.deepStrictEqual([a.adapted, a.dominant, a.ewarFamily, a.escorts.length], [true, "battleship", "ecm", 5]);
    assert.ok(a.escorts.every((e) => e.hullClass === "battlecruiser"), JSON.stringify(a.escorts));
    assert.deepStrictEqual(a.escorts.map((e) => e.ewarFamily), ["ecm", "ecm", null, null, null]);
    assert.deepStrictEqual(doctrineOf({ ...input, rank: 1 }, DATA, P).escorts.filter((e) => e.ewarFamily).length, 1);
    assert.deepStrictEqual(doctrineOf(input, DATA, { maxEwarEscorts: 0 }).ewarFamily, null);
    const f = doctrineOf({ ...input, profile: { frigate: 2, cruiser: 2 } }, DATA, P);
    assert.deepStrictEqual([f.dominant, f.ewarFamily], ["cruiser", "scram"], "a tie -> the name first in order");
    for (const profile of [{}, null, { weird: 9 }]) {
      assert.strictEqual(doctrineOf({ ...input, profile }, DATA, P).adapted, false, JSON.stringify(profile));
    }
    assert.strictEqual(doctrineOf({ ...input, escortCount: 0 }, DATA, P).adapted, false);
    assert.deepStrictEqual(DATA.HULL_LADDER, bountyScene.HULL_LADDER);
    for (const [k, row] of Object.entries(DATA.DOCTRINE)) {
      assert.ok(DATA.EWAR_FAMILIES.includes(row.ewarFamily), k);
      assert.ok(row.escortClasses.every((c) => DATA.HULL_LADDER.includes(c)), k);
    }
    assert.deepStrictEqual(profileOf({ cruiser: 3, frigate: 1, destroyer: 1 }, "battleship", 3),
      { cruiser: 3, destroyer: 1, battleship: 1 });
    assert.deepStrictEqual(profileOf({ cruiser: 3 }, "cruiser", 1), { cruiser: 4 });
    const cfg = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const d = cfg({}).config.nemesis;
    assert.deepStrictEqual([d.adaptEnabled, d.killboardProfileEnabled, d.profileKills, d.profileMaxEntries,
      d.maxEwarEscorts], [false, false, 20, 8, 2]);
    const w = (env) => cfg({ EVEJS_LNE_NEMESIS_ENABLED: "1", ...env }).warnings.filter((x) => x.includes("W76")
      || x.includes("killboardProfileEnabled without killboard.enabled"));
    assert.strictEqual(w({ EVEJS_LNE_NEMESIS_KILLBOARD_PROFILE_ENABLED: "1" }).length, 1);
    assert.deepStrictEqual(w({ EVEJS_LNE_NEMESIS_KILLBOARD_PROFILE_ENABLED: "1", EVEJS_LNE_KILLBOARD_ENABLED: "1" }), []);
    assert.deepStrictEqual(w({}), []);
  });

  test("ND2 vendor facts: 4 exports, pool map, profile.shipTypeID (H4), EWAR families, nativeNpc (H3); GAME_MODULES",
    () => {
      const pools = readSource("space/npc/pirateHullProfiles.js");
      assert.match(pools, /^ {2}listPoolCandidates,$/m);
      assert.match(pools, /^ {2}STANDARD_POOL_QUERY_BY_FACTION,$/m);
      assert.match(pools, /^function listPoolCandidates\(poolQuery, hullClass\) \{$/m);
      assert.match(readSource("space/npc/npcData.js"), /^ {2}getNpcProfile,$/m);
      assert.match(readSource("services/fitting/liveFittingState.js"), /^ {2}getTypeAttributeMap,$/m);
      const ewar = readSource("space/npc/npcEntityEwarCatalog.js");
      assert.match(ewar, /^ {2}resolveEntityEwarSpecs,$/m);
      const families = [...ewar.matchAll(/^ {4}family: "([A-Za-z]+)",$/gm)].map((m) => m[1]);
      assert.deepStrictEqual(families, [...DATA.EWAR_FAMILIES]);
      assert.ok(readSource("space/npc/npcHullDamageability.js").includes("profile && profile.shipTypeID"), "H4");
      const native = readSource("space/npc/nativeNpcService.js");
      const inContext = native.slice(native.indexOf("function spawnNativeNpcEntityInContext("));
      assert.ok(inContext.slice(0, inContext.indexOf("\n}\n")).includes("nativeNpc: true"), "H3 nativeNpc");
      const inSystem = native.slice(native.indexOf("function spawnNativeNpcEntityInSystem("));
      assert.ok(inSystem.slice(0, inSystem.indexOf("\n}\n")).includes("spawnNativeNpcEntityInContext("), "H3 path");
      assert.ok(readSource("space/npc/npcEquipment.js").includes("const entityEwarModules = isNativeNpcEntity(entity)"),
        "H3 hull EWAR of a native NPC");
      assert.ok(!MODULE_NAMES.includes("nemesisEwar"));
      const has = (p, name) => GAME_MODULES.some((e) => e.path === p && e.symbols.some((s) => s.name === name
        && s.consumers.includes("nemesisEwar") && s.wrap !== true && s.firstLoad !== true));
      for (const [p, name] of [[PATHS.pools, "listPoolCandidates"], [PATHS.pools, "STANDARD_POOL_QUERY_BY_FACTION"],
        [PATHS.npc, "getNpcProfile"], [PATHS.fitting, "getTypeAttributeMap"], [PATHS.ewar, "resolveEntityEwarSpecs"]]) {
        assert.ok(has(p, name), `${p}.${name}`);
      }
    });

  test("ND3 ewarProfilesOf: family matched, NO_PROFILE, SEAM_UNAVAILABLE without a throw, cache per pair", () => {
    const v = fakeVendor();
    const e = createNemesisEwar({ requireGame: v.requireGame });
    assert.deepStrictEqual(e.ewarProfilesOf(500010, "cruiser", "ecm"), { ok: true, profileIds: ["p_a"] });
    assert.deepStrictEqual(e.ewarProfilesOf(500010, "cruiser", "web"), { ok: true, profileIds: ["p_b"] });
    assert.strictEqual(e.ewarProfilesOf(500010, "cruiser", "paint").reason, "NO_PROFILE");
    assert.strictEqual(v.calls.pools, 1, "one vendor read per (faction, class)");
    const known = (id) => e.isEwarProfile(id, 500010, "cruiser");
    assert.deepStrictEqual([known("p_a"), known("p_b"), known("p_c")], [true, true, false]);
    assert.deepStrictEqual([e.isEwarProfile("p_a", 500011, "cruiser"), e.isEwarProfile("p_a", 500010, "frigate"),
      e.isEwarProfile("p_a")], [false, false, false]);
    assert.strictEqual(e.ewarProfilesOf(999, "cruiser", "ecm").reason, "NO_PROFILE");
    assert.strictEqual(e.ewarProfilesOf(500010, "", "ecm").reason, "INVALID_INPUT");
    v.modules[PATHS.pools].listPoolCandidates = () => {
      throw new Error("vendor broke");
    };
    const t = createNemesisEwar({ requireGame: v.requireGame }).ewarProfilesOf(500010, "frigate", "ecm");
    assert.deepStrictEqual([t.ok, t.reason], [false, "SEAM_UNAVAILABLE"]);
    const gone = createNemesisEwar({ requireGame: (rel) => (rel === PATHS.ewar ? { ok: false } : v.requireGame(rel)) });
    assert.strictEqual(gone.ewarProfilesOf(500010, "cruiser", "ecm").reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(createNemesisEwar({}).ewarProfilesOf(500010, "cruiser", "ecm").reason, "SEAM_UNAVAILABLE");
  });

  test("ND4 spawnGroup escort profileId from the cache vs not; escortsFor only with adaptEnabled; counters", () => {
    const v = fakeVendor();
    const ewar = createNemesisEwar({ requireGame: v.requireGame });
    ewar.ewarProfilesOf(500010, "cruiser", "ecm");
    const SYSTEM = 30002510;
    const scenes = new Map([[SYSTEM, { staticEntities: [{ kind: "stargate", itemID: 50000001,
      position: { x: 1, y: 0, z: 0 } }], getEntityByID: () => null }]]);
    const modules = { "space/runtime": { isSolarSystemSceneLoaded: (id) => scenes.has(id), scenes },
      "space/npc/npcService": { getControllerByEntityID() {}, issueManualOrder() {}, wakeNpcController() {} } };
    const spawned = [];
    const spawn = { resolveProfiles: (req) => ({ ok: true, profiles: [`hull_${req[0].hullGroup}`] }),
      spawnShip: (_sys, spec) => {
        spawned.push(spec.profileId);
        return { ok: true, entityId: 8000000 + spawned.length };
      },
      publish: () => ({ ok: true }), despawn: () => ({ ok: true }) };
    const seam = bountyScene.createBountyScene({ requireGame: (rel) => (modules[rel] ? { ok: true,
      exports: modules[rel] } : { ok: false }), getSpawn: () => spawn, getSpawnTools: () => ({ ok: false }),
    isEwarProfile: ewar.isEwarProfile });
    const spec = { systemId: SYSTEM, anchor: { kind: "gate", index: 0 }, factionId: 500010,
      boss: { kind: "hull", hullClass: "cruiser" }, escorts: [{ hullClass: "cruiser", profileId: "p_a" },
        { hullClass: "cruiser", profileId: "p_z" }, { hullClass: "frigate" }], slimName: "Bo Hunter",
      archetype: "HUNTER", seedKey: "rev:nem:1:2:r1" };
    assert.strictEqual(seam.spawnGroup(spec).ok, true);
    assert.deepStrictEqual(spawned, ["hull_cruiser", "p_a", "hull_cruiser", "hull_frigate"]);
    assert.strictEqual(seam.spawnGroup({ ...spec, escorts: [{ hullClass: "cruiser", profileId: 7 }] }).reason,
      "INVALID_INPUT");

    const base = R.nemesisOn();
    const row = { nemesisId: R.NEM_ID, characterId: R.KILLER, commanderId: R.CAPTAIN, factionId: R.FACTION,
      gangId: 1, name: "Bo Hunter", rank: 2, baseLevel: 3, returns: 1, seed: 11, history: [], state: "HUNTING",
      openRevengeId: "rev:x", profile: { battleship: 2 }, createdAt: 0, lastEncounterAt: 0, nextReturnAt: 0,
      updatedAt: 0, originSystemId: 4, version: 1 };
    const rev = { nemesisId: R.NEM_ID, revengeId: "rev:x", hunterLevel: 5, seed: 99 };
    const ctx = { isWantedBusy: () => false, isSquadCommander: () => false,
      memberOf: () => ({ member: true, corpName: "G" }), ewarProfilesOf: () => ({ ok: false, reason: "NO_PROFILE" }) };
    const off = NS.createNemesisStep({ settings: base, store: {}, journal: null, worldSeed: 7 });
    off.load([row]);
    assert.ok(!("escortsFor" in off.squadOf(rev, ctx)), "adaptEnabled off -> the squad of");
    const on = NS.createNemesisStep({ settings: { ...base, adaptEnabled: true }, store: {}, journal: null,
      worldSeed: 7 });
    on.load([row]);
    const plain = [{ hullClass: "cruiser" }, { hullClass: "battlecruiser" }, { hullClass: "cruiser" }];
    const sq = on.squadOf(rev, ctx);
    const adapted = sq.escortsFor(plain);
    assert.deepStrictEqual(adapted, [{ hullClass: "battlecruiser" }, { hullClass: "battlecruiser" },
      { hullClass: "battlecruiser" }], "battleship profile capped at L5 battlecruiser, no EWAR profile");
    sq.onSpawn({ cargo: { seeded: 0, skipped: 0 } });
    assert.deepStrictEqual([on.status().counters.nemesisDoctrine, on.status().counters.nemesisEwarNoProfile], [1, 2]);
    on.load([{ ...row, profile: {} }]);
    const empty = on.squadOf(rev, ctx);
    assert.strictEqual(empty.escortsFor(plain), plain);
    empty.onSpawn({});
    assert.strictEqual(on.status().counters.nemesisDoctrine, 1);
  });

  const driver = loadDriver();
  test("ND5 killboard profile V / A / F (unknown skipped); a return with killboard + adapt spawns EWAR escorts", () => {
    const BS = typeOf("battleship");
    const CR = typeOf("cruiser");
    const rows = [{ role: "V", shipTypeId: BS, attackers: [] },
      { role: "A", shipTypeId: 1, attackers: [[9, 1, null, null, BS, 5], [42, 1, null, null, CR, 5]] },
      { role: "F", shipTypeId: 1, attackers: [[42, 1, null, null, BS, 5]] },
      { role: "V", shipTypeId: 1, attackers: [] }, { role: "A", shipTypeId: BS, attackers: [[9, 1, null, null, BS, 1]] }];
    assert.deepStrictEqual(killboardProfileOf(rows, 42, 8), { battleship: 2, cruiser: 1 });
    if (!driver.ok) {
      skip("ND5 store part", `better-sqlite3 unavailable (${driver.detail})`);
      return;
    }
    withStore(driver, (opened) => {
      const kb = createKillboardRepository();
      const ins = opened.store.transaction("nd.kb", (tx) => [1, 2].map((killId) => kb.insertKill(tx, { ok: true,
        row: { killId, killAt: 1000 + killId, systemId: 4, victimCharacterId: R.KILLER, victimCorporationId: null,
          victimAllianceId: null, victimFactionId: null, shipTypeId: BS, iskLost: 0, finalCharacterId: null,
          finalCorporationId: null, attackerCount: 0, attackersJson: "[]", cls: "PVP" },
        chars: [{ characterId: R.KILLER, role: "V" }], deltas: [] }, 1000)));
      assert.ok(ins.ok && ins.value.every((x) => x.ok && x.inserted), JSON.stringify(ins));
      const P = R.settings();
      const N = R.nemesisOn({ adaptEnabled: true, killboardProfileEnabled: true });
      R.nemesisRow(opened, N, { rank: 3 });
      const asked = [];
      const r = R.rig(opened, P, { nemesis: N, ewarProfilesOf: (factionId, hullClass, family) => {
        asked.push([factionId, hullClass, family]);
        return { ok: true, profileIds: ["ewar_x"] };
      } });
      R.returnAndStart(r, N);
      const spec = r.scene.of("spawnGroup")[0][1];
      assert.ok(spec.escorts.length >= 2);
      assert.ok(spec.escorts.every((e) => e.hullClass === "battlecruiser"), JSON.stringify(spec.escorts));
      assert.deepStrictEqual(spec.escorts.map((e) => e.profileId || null).slice(0, 3), ["ewar_x", "ewar_x", null]);
      assert.deepStrictEqual(asked[0], [R.FACTION, "battlecruiser", "ecm"]);
      const c = r.counters();
      assert.deepStrictEqual([c.nemesisKillboardRead, c.nemesisKillboardFailed, c.nemesisDoctrine,
        c.nemesisEwarNoProfile], [1, 0, 1, 0]);
      r.svc.stop();
    });
  });

  test("ND6 LOW: killboard only with adaptEnabled (W76b); SEAM_UNAVAILABLE counted apart, one log per pair "
    + "isEwarProfile of another faction / class -> the hull profile", () => {
    const cfg = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_NEMESIS_ENABLED: "1", ...env } }).warnings.filter((x) => x.includes("without adaptEnabled"));
    assert.strictEqual(cfg({ EVEJS_LNE_NEMESIS_KILLBOARD_PROFILE_ENABLED: "1" }).length, 1);
    assert.deepStrictEqual(cfg({ EVEJS_LNE_NEMESIS_KILLBOARD_PROFILE_ENABLED: "1",
      EVEJS_LNE_NEMESIS_ADAPT_ENABLED: "1" }), []);
    if (driver.ok) {
      withStore(driver, (opened) => {
        const N = R.nemesisOn({ killboardProfileEnabled: true });
        R.nemesisRow(opened, N, { rank: 3 });
        const r = R.rig(opened, R.settings(), { nemesis: N });
        R.returnAndStart(r, N);
        assert.deepStrictEqual([r.counters().nemesisKillboardRead, r.counters().nemesisKillboardFailed], [0, 0]);
        r.svc.stop();
      });
    } else {
      skip("ND6a store part", `better-sqlite3 unavailable (${driver.detail})`);
    }
    const logs = [];
    const step = NS.createNemesisStep({ settings: { ...R.nemesisOn(), adaptEnabled: true }, store: {}, journal: null,
      worldSeed: 7, log: (l) => logs.push(l) });
    step.load([{ nemesisId: R.NEM_ID, characterId: R.KILLER, commanderId: R.CAPTAIN, factionId: R.FACTION, gangId: 1,
      name: "Bo Hunter", rank: 2, baseLevel: 3, returns: 1, seed: 11, history: [], state: "HUNTING",
      openRevengeId: "rev:x", profile: { battleship: 2 }, createdAt: 0, lastEncounterAt: 0, nextReturnAt: 0,
      updatedAt: 0, originSystemId: 4, version: 1 }]);
    const ctx = { isWantedBusy: () => false, isSquadCommander: () => false,
      memberOf: () => ({ member: true, corpName: "G" }),
      ewarProfilesOf: () => ({ ok: false, reason: "SEAM_UNAVAILABLE", detail: "listPoolCandidates" }) };
    const plain = [{ hullClass: "cruiser" }, { hullClass: "battlecruiser" }, { hullClass: "cruiser" }];
    for (let i = 0; i < 2; i += 1) {
      const sq = step.squadOf({ nemesisId: R.NEM_ID, revengeId: "rev:x", hunterLevel: 5, seed: 99 }, ctx);
      sq.escortsFor(plain);
      sq.onSpawn({});
    }
    const c = step.status().counters;
    assert.deepStrictEqual([c.nemesisEwarSeamFailed, c.nemesisEwarNoProfile], [4, 0]);
    assert.deepStrictEqual(logs, [`nemesis EWAR seam failed ${R.FACTION}/battlecruiser - listPoolCandidates`]);
    const v = fakeVendor();
    const ewar = createNemesisEwar({ requireGame: v.requireGame });
    ewar.ewarProfilesOf(500010, "cruiser", "ecm");
    const SYSTEM = 30002510;
    const scenes = new Map([[SYSTEM, { staticEntities: [{ kind: "stargate", itemID: 50000001,
      position: { x: 1, y: 0, z: 0 } }], getEntityByID: () => null }]]);
    const modules = { "space/runtime": { isSolarSystemSceneLoaded: (id) => scenes.has(id), scenes },
      "space/npc/npcService": { getControllerByEntityID() {}, issueManualOrder() {}, wakeNpcController() {} } };
    const spawned = [];
    const spawn = { resolveProfiles: (req) => ({ ok: true, profiles: [`hull_${req[0].hullGroup}`] }),
      spawnShip: (_sys, spec) => {
        spawned.push(spec.profileId);
        return { ok: true, entityId: 8000000 + spawned.length };
      },
      publish: () => ({ ok: true }), despawn: () => ({ ok: true }) };
    const seam = bountyScene.createBountyScene({ requireGame: (rel) => (modules[rel] ? { ok: true,
      exports: modules[rel] } : { ok: false }), getSpawn: () => spawn, getSpawnTools: () => ({ ok: false }),
    isEwarProfile: ewar.isEwarProfile });
    const spec = { systemId: SYSTEM, anchor: { kind: "gate", index: 0 }, factionId: 500011, boss: null,
      escorts: [{ hullClass: "cruiser", profileId: "p_a" }], slimName: null, archetype: "HUNTER",
      seedKey: "rev:nem:1:2:r2" };
    assert.strictEqual(seam.spawnGroup(spec).ok, true);
    assert.strictEqual(seam.spawnGroup({ ...spec, factionId: 500010, escorts: [{ hullClass: "frigate",
      profileId: "p_a" }] }).ok, true);
    assert.deepStrictEqual(spawned, ["hull_cruiser", "hull_frigate"]);
  });
};
