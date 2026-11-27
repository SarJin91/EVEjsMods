"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { CAPSULEER_LIVE_PROFILES } = require("../../lib/adapter/data/capsuleerLiveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID, EMPIRE_FACTION_IDS, HULL_CLASSES } = require("../../lib/adapter/empireNavyCatalog");
const { classifyHull } = require("../../lib/adapter/empireBelts");

const { npcSetupTables } = require("../_support/setupTables");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const CAPSULEERS = 500018;
const PREFIX = "parity_irregular_entities_";

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

module.exports = ({ test, skip }) => {
  const lm1 = "LM1 vendor facts: ownerIDOverride -> entity.ownerID, no pilot, killmail corp from ownerID, no faction";
  if (!fs.existsSync(SERVER_SRC)) skip(lm1, "server/src not found");
  else {
    test(lm1, () => {
      const native = readSource("space/npc/nativeNpcService.js");
      for (const line of ["const ownerIDOverride = toPositiveInt(options.ownerIDOverride, 0);",
        "ownerID: ownerIDOverride || identity.ownerID || toPositiveInt(options.fallbackOwnerID, 0),", "entity.ownerID = entityRecord.ownerID;",
        "    characterID: 0,\n", "entity.characterID = 0;",
        "return spawnNativeNpcEntityInContext(contextResult.data, definition, {\n    ...options,"]) {
        assert.ok(native.includes(line), `nativeNpcService: ${line}`);
      }
      assert.ok(readSource("space/npc/npcPresentation.js")
        .includes("corporationID: toPositiveInt(profile.corporationID, 0),"), "npcPresentation corporationID");

      const km = readSource("space/combat/killmailTracker.js");
      assert.ok(km.includes("toPositiveInt(attackerEntity.corporationID, toPositiveInt(attackerEntity.ownerID, null))"),
        "attacker corporation falls back to ownerID");
      assert.ok(km.includes("const characterID = isNpcVictimEntity(targetEntity)\n    ? null"), "NPC victim: no pilot");
      const vStart = km.indexOf("victimCorporationID: toPositiveInt(");
      const vEnd = km.indexOf("victimAllianceID:", vStart);
      assert.ok(vStart >= 0 && vEnd > vStart, "victim corporation block");
      assert.ok(km.slice(vStart, vEnd).includes("toPositiveInt(targetEntity.ownerID, null),"),
        "victim corporation falls back to ownerID");
      assert.match(km, /function toPositiveInt\(value, fallback = null\) \{\n\s*const numericValue = toInteger\(value, 0\);\n\s*return numericValue > 0 \? numericValue : fallback;/,
        "corporationID 0 -> fallback");

      const standing = readSource("services/character/factionKillStandingRuntime.js");
      const start = standing.indexOf("\nfunction resolveVictimFactionID(");
      assert.ok(start >= 0, "resolveVictimFactionID");
      const body = standing.slice(start, standing.indexOf("\n}\n", start));
      assert.ok(body.includes("warFactionID") && body.includes("corporationID"), "reads warFactionID / corporationID");
      assert.ok(!body.includes("ownerID"), "The owner is never read");
    });
  }

  const lm2 = "LM2 capsuleer live profiles exist in EveJS data; 500018 not a navy / empire faction";
  const setup = npcSetupTables();
  if (!setup.ok) skip(lm2, setup.reason);
  else {
    test(lm2, () => {
      assert.ok(!Object.prototype.hasOwnProperty.call(NAVY_PROFILES_BY_FACTION_ID, String(CAPSULEERS)));
      assert.ok(!EMPIRE_FACTION_IDS.includes(CAPSULEERS));
      const byHull = CAPSULEER_LIVE_PROFILES[CAPSULEERS];
      assert.deepStrictEqual(Object.keys(byHull).sort(), [...HULL_CLASSES].sort());
      const profiles = new Map(setup.tables.npcProfiles.profiles.map((p) => [p.profileID, p]));
      const behaviors = new Set(setup.tables.npcBehaviorProfiles.behaviorProfiles.map((b) => b.behaviorProfileID));
      for (const hull of HULL_CLASSES) {
        const id = byHull[hull];
        const row = profiles.get(id);
        assert.ok(row, `${hull}: ${id} exists`);
        assert.ok(id.startsWith(PREFIX), id);
        assert.strictEqual(row.shipTypeID, Number(id.slice(PREFIX.length).split("_")[0]), id);
        assert.strictEqual(row.entityType, "npc", id);
        assert.strictEqual(row.corporationID, 0, id);
        assert.strictEqual(row.hardwareFamily, "sdeEntityNpc", id);
        assert.ok(behaviors.has(row.behaviorProfileID), `${id}: behavior ${row.behaviorProfileID}`);
        if (["frigate", "cruiser", "battleship"].includes(hull)) {
          assert.strictEqual(classifyHull({ profile: row }), hull, id);
        }
      }
    });
  }
};
