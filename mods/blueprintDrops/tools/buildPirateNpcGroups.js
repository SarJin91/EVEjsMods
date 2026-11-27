"use strict";

const fs = require("node:fs");
const path = require("node:path");

const SDE_BUILD = "3396210";
const DEFAULT_GROUPS = path.resolve(__dirname, "../../..", "_local", "sde", `eve-online-static-data-${SDE_BUILD}-jsonl`, "groups.jsonl");
const OUT = path.resolve(__dirname, "..", "data", "pirateNpcGroups.json");
const NPC_CATEGORY_ID = 11;

const FACTIONS = {
  500011: { resonatorTypeID: 83467, label: "Angel Cartel" },
  500012: { resonatorTypeID: 83468, label: "Blood Raider Covenant" },
  500010: { resonatorTypeID: 83469, label: "Guristas Pirates" },
  500018: { resonatorTypeID: 83470, label: "Mordu's Legion" },
  500019: { resonatorTypeID: 83471, label: "Sansha's Nation" },
  500020: { resonatorTypeID: 83472, label: "Serpentis" },
  500016: { resonatorTypeID: 83473, label: "Sisters of EVE" },
};

const FACTION_RULES = [
  [/\b(angel|domination)\b/i, 500011],
  [/\bblood raiders?\b/i, 500012],
  [/\bguristas\b/i, 500010],
  [/\bsansha'?s?\b/i, 500019],
  [/\bserpentis\b/i, 500020],
  [/\bmordu/i, 500018],
];
const BAND_RULES = [
  [/battle ?cruiser/i, "battlecruiser"],
  [/battleship/i, "battleship"],
  [/destroyer/i, "destroyer"],
  [/frigate/i, "frigate"],
  [/cruiser/i, "cruiser"],
  [/dreadnought|titan|carrier|capital/i, "capital"],
  [/hauler|industrial/i, "hauler"],
];
const SKIP = /\b(other|sentry|sentries|structure|tower|bunker|stargate|station)\b/i;
const ELITE = /\b(commander|officer)\b/i;
const OVERRIDES = {
  553: { band: "battleship", tier: "elite" },
  559: { band: "battleship", tier: "elite" },
  564: { band: "battleship", tier: "elite" },
  569: { band: "battleship", tier: "elite" },
  574: { band: "battleship", tier: "elite" },
};

function classify(name, groupID) {
  if (!name || SKIP.test(name)) return null;
  const faction = FACTION_RULES.find(([re]) => re.test(name));
  if (!faction) return null;
  const override = OVERRIDES[groupID];
  if (override) return { factionID: faction[1], band: override.band, tier: override.tier };
  const band = BAND_RULES.find(([re]) => re.test(name));
  if (!band) return null;
  return { factionID: faction[1], band: band[1], tier: ELITE.test(name) ? "elite" : "normal" };
}

function build(lines) {
  const groups = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.categoryID !== NPC_CATEGORY_ID) continue;
    const name = row.name && row.name.en;
    const hit = classify(name, row._key);
    if (hit) groups.push({ groupID: row._key, ...hit, name });
  }
  groups.sort((a, b) => a.groupID - b.groupID);
  const factions = {};
  for (const [id, f] of Object.entries(FACTIONS)) factions[id] = { ...f };
  return { schemaVersion: 1, sdeBuild: SDE_BUILD, factions, groups };
}

if (require.main === module) {
  const file = process.argv[2] || DEFAULT_GROUPS;
  const data = build(fs.readFileSync(file, "utf8").split(/\r?\n/));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote ${OUT}: ${data.groups.length} groups`);
}

module.exports = { build, classify, FACTIONS, OVERRIDES };
