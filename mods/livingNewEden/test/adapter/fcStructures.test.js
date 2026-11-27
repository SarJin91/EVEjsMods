"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const structures = require("../../lib/adapter/structures");
const ps = require("../../lib/adapter/playerStructures");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");
const { createFakeStructureSeam } = require("../_support/fakeStructureSeam");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const CONSUMER = "freeCorpsStructures";
const TAG = Object.freeze({ fcKey: "lne:fc:st:7:1", world: 42 });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.search(new RegExp(`\\nfunction ${name}\\(`));
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function fakeVendor() {
  let rows = [];
  let nextId = 1040000000000;
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const state = {
    STRUCTURES_TABLE: "structures",
    getStructureTypeByID: (id) => (id === 35832 ? { typeID: id } : null),
    listStructures: () => rows.map(clone),
    getStructureByID: (id) => rows.find((r) => r.structureID === id) || null,
    createStructure(record) {
      const row = { ...clone(record), structureID: nextId, destroyedAt: 0 };
      nextId += 1;
      rows.push(row);
      return { success: true, data: clone(row) };
    },
    updateStructureRecord(id, updater) {
      const cur = rows.find((r) => r.structureID === id);
      if (!cur) return { success: false, errorMsg: "STRUCTURE_NOT_FOUND" };
      const next = updater(clone(cur)) || cur;
      rows = rows.map((r) => (r.structureID === id ? next : r));
      return { success: true, data: clone(next) };
    },
    destroyStructure(id, o) {
      rows = rows.map((r) => (r.structureID === id ? { ...r, destroyedAt: o.nowMs } : r));
      return { success: true };
    },
    removeStructure(id) {
      rows = rows.filter((r) => r.structureID !== id);
      return { success: true };
    },
  };
  const constants = { STRUCTURE_STATE: { ANCHORING: 2, ONLINING_VULNERABLE: 102, SHIELD_VULNERABLE: 110,
    ARMOR_REINFORCE: 111, ARMOR_VULNERABLE: 112, HULL_REINFORCE: 113, HULL_VULNERABLE: 114, ANCHOR_VULNERABLE: 115 },
  STRUCTURE_UPKEEP_STATE: { FULL_POWER: 1, LOW_POWER: 2, ABANDONED: 3 } };
  return { vendor: { state, constants }, rows: () => rows };
}

const CREATE = Object.freeze({ tag: TAG, typeId: 35832, systemId: 30002000, ownerCorpId: 98000007,
  name: "S30002000 - Corp 7", position: { x: 1e7, y: 0, z: 0 }, state: 115, stateEndsAt: 9000,
  condition: { damage: 0 }, docking: "none", quantumCore: false, at: 5000 });

function playerModules(rows) {
  const byId = () => new Map(rows.map((r) => [r.structureID, r]));
  const modules = {
    "services/structure/structureState": { STRUCTURES_TABLE: "structures",
      peekStructures: () => rows.filter((r) => !r.destroyedAt),
      getStructureByID: (id) => byId().get(id) || null,
      applyAdminStructureDamage: () => ({ success: true, data: { changed: true } }),
      resolveStructureEffectiveHitpoints: () => ({ effectiveShieldCapacity: 1, effectiveArmorHP: 1,
        effectiveStructureHP: 1 }),
      resolveStructureLayerDamageLimits: () => ({ shield: 1, armor: 1, structure: 1 }) },
    "services/structure/structureConstants": { STRUCTURE_STATE: { SHIELD_VULNERABLE: 110, ARMOR_REINFORCE: 111,
      ARMOR_VULNERABLE: 112, HULL_REINFORCE: 113, HULL_VULNERABLE: 114 },
    STRUCTURE_UPKEEP_STATE: { FULL_POWER: 1, LOW_POWER: 2, ABANDONED: 3 },
    STRUCTURE_FAMILY: { CITADEL: "citadel" } },
    "services/structure/structureAssetSafetyState": { isAssetSafetyDisabledForStructure: () => false },
    "services/corporation/corporationState": { getCorporationRecord: () => null,
      isNpcCorporationID: (id) => id >= 1000000 && id < 2000000 },
    "services/corporation/corporationRuntimeState": { listCorporationMembers: () => [] },
    "services/online/characterControlRuntime": { getCharacterControlSnapshot: (id) => ({ characterID: id }) },
    "services/character/characterState": { peekCharacterRecord: () => null },
    "gameStore/index": { flushTableSync: () => ({ success: true }) },
  };
  return ps.createPlayerStructureSeam({ requireGame: (rel) => (modules[rel] ? { ok: true, exports: modules[rel] }
    : { ok: false, reason: "missing" }) });
}

module.exports = ({ test }) => {
  test("FST1 vendor facts (owner, devFlags, ONLINING without a core, destroyedAt), GAME_MODULES consumer "
    + "the free corp tag writer, psiege skips FC rows, facade / adapter methods", () => {
    const ss = readSource("services/structure/structureState.js");
    assert.ok(ss.includes("ownerCorpID: toPositiveInt(entry.ownerCorpID || entry.ownerID, 1)"), "owner field");
    assert.ok(ss.includes("devFlags: entry.devFlags && typeof entry.devFlags === \"object\" ? "
      + "cloneValue(entry.devFlags) : {}"), "devFlags kept");
    assert.match(bodyOf(ss, "buildOnliningVulnerableStructure"), /stateEndsAt: hasCore/);
    assert.match(bodyOf(ss, "destroyStructure"), /destroyedAt: nowMs/);

    assert.ok(!MODULE_NAMES.includes(CONSUMER), "freeCorpsStructures is not a module name");
    const want = [["services/structure/structureState", ["createStructure", "updateStructureRecord",
      "destroyStructure", "removeStructure", "listStructures", "getStructureTypeByID", "getStructureByID",
      "STRUCTURES_TABLE"]], ["services/structure/structureConstants", ["STRUCTURE_STATE", "STRUCTURE_UPKEEP_STATE"]],
    ["services/structure/structureDeploymentPlacement", ["validateDeploymentPlacement"]],
    ["space/worldData", ["getCelestialsForSystem"]], ["gameStore/index", ["flushTableSync"]]];
    for (const [p, names] of want) {
      for (const name of names) {
        const syms = GAME_MODULES.filter((e) => e.path === p).flatMap((e) => e.symbols)
          .filter((s) => s.name === name && s.consumers.includes(CONSUMER));
        assert.strictEqual(syms.length, 1, `${p}.${name}`);
        assert.ok(syms[0].wrap !== true && syms[0].firstLoad !== true, name);
      }
    }

    const f = fakeVendor();
    const c = structures.createFcTaggedStructureFrom(f.vendor, CREATE);
    assert.strictEqual(c.ok, true, JSON.stringify(c));
    const row = f.rows()[0];
    assert.deepStrictEqual(row.devFlags, { lneFreeCorpStructureKey: TAG.fcKey, lneWorld: 42 });
    assert.deepStrictEqual([row.ownerCorpID, row.hasQuantumCore, row.accessProfile.docking], [98000007, false, "none"]);
    assert.deepStrictEqual(structures.createFcTaggedStructureFrom(f.vendor, CREATE),
      { ok: false, reason: "ALREADY_TAGGED", structureId: c.structureId });
    assert.strictEqual(structures.tagOfRow(row), null);
    assert.strictEqual(structures.sovTagOfRow(row), null);
    assert.deepStrictEqual(structures.fcTagOfRow(row), TAG);
    assert.strictEqual(structures.fcTagOfRow({ devFlags: { lneStationId: "st-1", lneWorld: 42 } }), null);
    assert.strictEqual(structures.listTaggedStructuresFrom(f.vendor).rows.length, 0, "the station pump sees nothing");
    assert.strictEqual(structures.listFcTaggedStructuresFrom(f.vendor).rows[0].tag.fcKey, TAG.fcKey);
    for (const fcKey of ["lne:fc:st:0:1", "lne:fc:st:7", "st-1", "lne:fc:st:7:1:2"]) {
      assert.deepStrictEqual(structures.createFcTaggedStructureFrom(f.vendor, { ...CREATE, tag: { fcKey, world: 42 } }),
        { ok: false, reason: "TAG_REQUIRED" }, fcKey);
    }
    assert.deepStrictEqual(structures.createFcTaggedStructureFrom(f.vendor, { ...CREATE,
      tag: { fcKey: "lne:fc:st:7:2", world: 42 }, ownerCorpId: 0 }),
    { ok: false, reason: "INVALID_INPUT", detail: "ownerCorpId" });
    assert.strictEqual(structures.updateFcTaggedStructureFrom(f.vendor, c.structureId, { ...TAG, world: 43 },
      { upkeepState: 1, at: 6000 }).reason, "TAG_MISMATCH");
    assert.deepStrictEqual(structures.destroyFcTaggedStructureFrom(f.vendor, c.structureId, TAG, 7000),
      { ok: true, alreadyDestroyed: false });
    const destroyed = structures.getFcStructureFrom(f.vendor, c.structureId).row;
    assert.deepStrictEqual([destroyed.destroyedAt, destroyed.modDestroyed], [7000, true]);

    const fcRow = { structureID: 501, solarSystemID: 30002000, typeID: 35832, structureFamily: "citadel",
      structureSize: "STRUCTURE_SIZE_MEDIUM", ownerCorpID: 98000007, allianceID: null, state: 110, stateEndsAt: 0,
      upkeepState: 1, destroyedAt: 0, name: "fc", devFlags: { lneFreeCorpStructureKey: TAG.fcKey, lneWorld: 42 } };
    const player = { ...fcRow, structureID: 502, name: "player", devFlags: {} };
    const pseam = playerModules([fcRow, player]);
    const idx = pseam.listCandidates({ nowMs: 1, ttlMs: 1, families: ["citadel"], maxStructures: 10 });
    assert.strictEqual(idx.ok, true, JSON.stringify(idx));
    assert.deepStrictEqual(idx.bySystem.get(30002000).map((s) => s.structureId), [502]);
    assert.deepStrictEqual(pseam.applySiegeHit(501, "shield"), { ok: false, reason: "TAGGED" });
    assert.deepStrictEqual([pseam.readStructure(501).view.tagged, pseam.readStructure(502).view.tagged], [true, false],
      "playerSiege targetOf refuses the tagged view");

    const real = structures.createStructureSeam({ requireGame: () => ({ ok: false, reason: "test" }) });
    for (const m of structures.FC_SEAM_METHODS) assert.strictEqual(typeof real[m], "function", m);
    assert.deepStrictEqual(structures.FC_SEAM_METHODS.filter((m) => !structures.SEAM_METHODS.includes(m)), []);
    const fake = createFakeStructureSeam().seam;
    for (const m of structures.FC_SEAM_METHODS) assert.strictEqual(typeof fake[m], "function", `fake ${m}`);
    const blind = createAdapter({ moduleApi: { _cache: {} } });
    const s = blind.freeCorpStructureSeams();
    assert.strictEqual(s.ok, true);
    const st = s.seam.readStructureStates();
    assert.deepStrictEqual([st.ok, st.reason], [false, "STRUCTURES_SEAM_UNAVAILABLE"]);
    assert.strictEqual(s.seam.listFcTaggedStructures().ok, false);
  });
};
