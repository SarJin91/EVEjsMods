"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { INVADER_LIVE_PROFILES, INVADER_FACTION_IDS } = require("../../lib/adapter/data/invaderLiveProfiles");
const { CAPSULEER_LIVE_PROFILES } = require("../../lib/adapter/data/capsuleerLiveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID, HULL_CLASSES } = require("../../lib/adapter/empireNavyCatalog");
const { PIRATE_KEY_BY_FACTION_ID } = require("../../lib/adapter/data/liveProfiles");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const PREFIX_BY_FACTION = Object.freeze({ 500026: "parity_trig_", 500024: "parity_drifter_" });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

const SPECS_BY_FACTION = Object.freeze({
  500024: "const DRIFTER_VARIANT_SPECS = Object.freeze([",
  500026: "const TRIG_VARIANT_SPECS = Object.freeze([",
});

function sliceBetween(text, startMarker, endMarker = "\n]);") {
  const startIdx = text.indexOf(startMarker);
  if (startIdx < 0) assert.fail(`vendor fact: start marker not found: ${startMarker}`);
  const endIdx = text.indexOf(endMarker, startIdx);
  if (endIdx < 0) assert.fail(`vendor fact: end marker ${JSON.stringify(endMarker)} not found after ${startMarker}`);
  return { ok: true, text: text.slice(startIdx, endIdx) };
}

module.exports = ({ test, skip }) => {
  const il1 = "IL1 vendor facts: Triglavian / Drifter faction ids, profile id patterns, variant keys, npcData merge";
  if (!fs.existsSync(SERVER_SRC)) skip(il1, "server/src not found");
  else {
    test(il1, () => {
      const catalog = readSource("space/npc/trigDrifter/trigDrifterNpcCatalog.js");
      assert.ok(readSource("space/pochvenPolicy.js").includes("const TRIGLAVIAN_FACTION_ID = 500026;"),
        "pochvenPolicy: TRIGLAVIAN_FACTION_ID");
      assert.ok(/const \{\n {2}TRIGLAVIAN_FACTION_ID: TRIG_FACTION_ID,[\s\S]*?\} = require\("\.\.\/\.\.\/pochvenPolicy"\);/
        .test(catalog), "trigDrifterNpcCatalog: TRIG_FACTION_ID from pochvenPolicy");
      for (const line of ["const DRIFTER_FACTION_ID = 500024;",
        "return `parity_trig_${variant.key}`;", "return `parity_drifter_${variant.key}`;",
        "factionID: TRIG_FACTION_ID,", "factionID: DRIFTER_FACTION_ID,",
        "TRIG_VARIANTS.map((variant) => buildTrigDefinition(variant))",
        "DRIFTER_VARIANTS.map((variant) => buildDrifterDefinition(variant))"]) {
        assert.ok(catalog.includes(line), `trigDrifterNpcCatalog: ${line}`);
      }
      for (const line of ["const TRIG_VARIANTS = Object.freeze(TRIG_VARIANT_SPECS.map(buildTrigAuthorityVariant));",
        "const DRIFTER_VARIANTS = Object.freeze(DRIFTER_VARIANT_SPECS.map(buildDrifterAuthorityVariant));"]) {
        assert.ok(catalog.includes(line), `trigDrifterNpcCatalog: ${line}`);
      }
      for (const [factionId, byHull] of Object.entries(INVADER_LIVE_PROFILES)) {
        const specs = sliceBetween(catalog, SPECS_BY_FACTION[factionId]).text;
        for (const id of Object.values(byHull)) {
          const key = id.slice(PREFIX_BY_FACTION[factionId].length);
          assert.ok(specs.includes(`key: "${key}",`), `${factionId}: variant key ${key} in ${SPECS_BY_FACTION[factionId]}`);
        }
      }
      const npcData = readSource("space/npc/npcData.js");
      assert.ok(npcData.includes("getTrigDrifterGeneratedRows,"), "npcData imports getTrigDrifterGeneratedRows");
      assert.ok(npcData.includes("getTrigDrifterGeneratedRows(tableName)"), "npcData merges the generated rows");
    });
  }

  test("IL2 invader live profiles: hull classes, faction ids disjoint from navy / capsuleer / pirate", () => {
    assert.deepStrictEqual([...INVADER_FACTION_IDS], [500024, 500026]);
    assert.deepStrictEqual(Object.keys(INVADER_LIVE_PROFILES).map(Number).sort(), [...INVADER_FACTION_IDS]);
    for (const factionId of INVADER_FACTION_IDS) {
      const key = String(factionId);
      for (const table of [NAVY_PROFILES_BY_FACTION_ID, CAPSULEER_LIVE_PROFILES, PIRATE_KEY_BY_FACTION_ID]) {
        assert.ok(!Object.prototype.hasOwnProperty.call(table, key), `${factionId} in another table`);
      }
      const byHull = INVADER_LIVE_PROFILES[key];
      assert.deepStrictEqual(Object.keys(byHull).sort(), [...HULL_CLASSES].sort(), key);
      for (const id of Object.values(byHull)) {
        assert.ok(typeof id === "string" && id.startsWith(PREFIX_BY_FACTION[key]), id);
      }
    }
  });
};
