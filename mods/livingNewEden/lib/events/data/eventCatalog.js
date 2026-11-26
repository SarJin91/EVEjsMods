"use strict";

const CATALOG_VERSION = 2;

const CAUSE = Object.freeze({
  OCCUPATION_CLAIM: "OCCUPATION_CLAIM",
  OCCUPATION_HELD: "OCCUPATION_HELD",
  CAMPAIGN_THEATRE: "CAMPAIGN_THEATRE",
  BATTLE_AFTERMATH: "BATTLE_AFTERMATH",
  LIBERATED: "LIBERATED",
  FRONT_LINE: "FRONT_LINE",
  DEVELOPED_INDUSTRY: "DEVELOPED_INDUSTRY",
  DEVELOPED_MILITARY: "DEVELOPED_MILITARY",
});

const CONTENT = Object.freeze({ SELF: "SELF", OPPONENT: "OPPONENT", NEUTRAL: "NEUTRAL" });
const NEUTRAL_CONTENT_KEY = 0;

const DENIED_TEMPLATE_IDS = Object.freeze([
  "client-dungeon:5524",
  "client-dungeon:5525",
  "client-dungeon:5526",
  "client-dungeon:5527",
  "client-dungeon:5528",
  "client-dungeon:5529",
]);

const FACTION_LABELS = Object.freeze({
  500010: "Guristas",
  500011: "Angel",
  500012: "Blood Raider",
  500019: "Sansha",
  500020: "Serpentis",
  500021: "Sleeper",
  500025: "Rogue Drone",
});

const SECURITY_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole"]);

const OCCUPATION_STATES = Object.freeze([
  "STABLE",
  "RECON",
  "CONTESTED",
  "INVASION",
  "OCCUPIED",
  "CONSOLIDATING",
]);

const EMPIRES = Object.freeze([500001, 500002, 500003, 500004]);
const INSURGENTS = Object.freeze([...EMPIRES, 500016, 500024, 500026, 500029]);

const INCURSION_TEMPLATES = Object.freeze({
  500010: Object.freeze(["client-dungeon:2203", "client-dungeon:2328", "client-dungeon:2121", "client-dungeon:2161"]),
  500011: Object.freeze(["client-dungeon:2200", "client-dungeon:2326", "client-dungeon:2113", "client-dungeon:2159"]),
  500012: Object.freeze(["client-dungeon:2205", "client-dungeon:2332", "client-dungeon:2163"]),
  500019: Object.freeze(["client-dungeon:2206", "client-dungeon:2329", "client-dungeon:2125", "client-dungeon:2165"]),
  500020: Object.freeze(["client-dungeon:2204", "client-dungeon:2331", "client-dungeon:2123", "client-dungeon:2162"]),
  500021: Object.freeze(["client-dungeon:3707", "client-dungeon:3708", "client-dungeon:3714", "client-dungeon:3715"]),
  500025: Object.freeze(["client-dungeon:2341", "client-dungeon:2354", "client-dungeon:2345", "client-dungeon:2357"]),
});

const STRONGHOLD_TEMPLATES = Object.freeze({
  500010: Object.freeze(["client-dungeon:2148", "client-dungeon:2184"]),
  500011: Object.freeze(["client-dungeon:2146", "client-dungeon:2172"]),
  500012: Object.freeze(["client-dungeon:2151", "client-dungeon:2187"]),
  500019: Object.freeze(["client-dungeon:2149", "client-dungeon:2185"]),
  500020: Object.freeze(["client-dungeon:2150", "client-dungeon:2186"]),
  500021: Object.freeze(["client-dungeon:3710", "client-dungeon:3713"]),
  500025: Object.freeze(["client-dungeon:2198", "client-dungeon:2216"]),
});

const OUTPOST_TEMPLATES = Object.freeze({
  500010: Object.freeze(["client-dungeon:2134", "client-dungeon:2154", "client-dungeon:2217", "client-dungeon:2226"]),
  500011: Object.freeze(["client-dungeon:2132", "client-dungeon:2153", "client-dungeon:2209", "client-dungeon:2224"]),
  500012: Object.freeze(["client-dungeon:2141", "client-dungeon:2156", "client-dungeon:2219", "client-dungeon:2229"]),
  500019: Object.freeze(["client-dungeon:2135", "client-dungeon:2157", "client-dungeon:2220", "client-dungeon:5466"]),
  500020: Object.freeze(["client-dungeon:2140", "client-dungeon:2155", "client-dungeon:2218", "client-dungeon:2228"]),
});

const selfFactionsOf = (templatesByFaction) => Object.freeze(Object.keys(templatesByFaction).map(Number));

const EVENT_CATALOG = Object.freeze([
  Object.freeze({
    eventType: "pirate_incursion",
    cause: CAUSE.OCCUPATION_CLAIM,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(INCURSION_TEMPLATES),
    startStates: Object.freeze(["RECON", "CONTESTED", "INVASION"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Incursion Staging",
    weight: 3,
    slots: 1,
    durationMs: 4 * 3600000,
    cooldownMs: 6 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: INCURSION_TEMPLATES,
  }),
  Object.freeze({
    eventType: "pirate_stronghold",
    cause: CAUSE.OCCUPATION_HELD,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(STRONGHOLD_TEMPLATES),
    startStates: Object.freeze(["OCCUPIED", "CONSOLIDATING"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Stronghold",
    weight: 2,
    slots: 1,
    durationMs: 6 * 3600000,
    cooldownMs: 12 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: STRONGHOLD_TEMPLATES,
  }),
  Object.freeze({
    eventType: "pirate_outpost",
    cause: CAUSE.CAMPAIGN_THEATRE,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(OUTPOST_TEMPLATES),
    startStates: Object.freeze(["STABLE"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Outpost",
    weight: 1,
    slots: 1,
    durationMs: 3 * 3600000,
    cooldownMs: 8 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: OUTPOST_TEMPLATES,
  }),
  Object.freeze({
    eventType: "insurgent_resistance",
    cause: CAUSE.OCCUPATION_CLAIM,
    content: CONTENT.OPPONENT,
    causeFactions: INSURGENTS,
    startStates: Object.freeze(["RECON", "CONTESTED", "INVASION"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Resistance",
    weight: 3,
    slots: 1,
    durationMs: 4 * 3600000,
    cooldownMs: 6 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: INCURSION_TEMPLATES,
  }),
  Object.freeze({
    eventType: "insurgent_holdout",
    cause: CAUSE.OCCUPATION_HELD,
    content: CONTENT.OPPONENT,
    causeFactions: INSURGENTS,
    startStates: Object.freeze(["OCCUPIED", "CONSOLIDATING"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Holdout",
    weight: 2,
    slots: 1,
    durationMs: 6 * 3600000,
    cooldownMs: 12 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: STRONGHOLD_TEMPLATES,
  }),
  Object.freeze({
    eventType: "frontier_outpost",
    cause: CAUSE.CAMPAIGN_THEATRE,
    content: CONTENT.OPPONENT,
    causeFactions: EMPIRES,
    startStates: Object.freeze(["STABLE"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Outpost",
    weight: 1,
    slots: 1,
    durationMs: 3 * 3600000,
    cooldownMs: 8 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: OUTPOST_TEMPLATES,
  }),
]);

const REWARD_PROFILES = Object.freeze({
  depot: Object.freeze({ sizeBand: "medium", hullGroup: "cruiser", rollsKey: "depotRolls" }),
  vault: Object.freeze({ sizeBand: "large", hullGroup: "battleship", rollsKey: "vaultRolls" }),
});
const REWARD_FACTIONS = Object.freeze({
  500010: Object.freeze({ itemPrefixes: Object.freeze(["Dread Guristas"]),
    deadspacePrefixes: Object.freeze(["Pith"]) }),
  500011: Object.freeze({ itemPrefixes: Object.freeze(["Domination"]), deadspacePrefixes: Object.freeze(["Gist"]) }),
  500012: Object.freeze({ itemPrefixes: Object.freeze(["Dark Blood"]), deadspacePrefixes: Object.freeze(["Corp"]) }),
  500019: Object.freeze({ itemPrefixes: Object.freeze(["True Sansha"]), deadspacePrefixes: Object.freeze(["Cent"]) }),
  500020: Object.freeze({ itemPrefixes: Object.freeze(["Shadow Serpentis"]),
    deadspacePrefixes: Object.freeze(["Core"]) }),
});

function rewardLootIdOf(profile, factionId) {
  return `${profile}_${factionId}`;
}

function templatesOfKeys(templatesByFaction, keysOf) {
  const out = {};
  for (const key of Object.keys(keysOf)) {
    if (Object.prototype.hasOwnProperty.call(templatesByFaction, key)) out[key] = templatesByFaction[key];
  }
  return Object.freeze(out);
}

const WAR_DEPOT_TEMPLATES = templatesOfKeys(OUTPOST_TEMPLATES, REWARD_FACTIONS);
const WAR_VAULT_TEMPLATES = templatesOfKeys(STRONGHOLD_TEMPLATES, REWARD_FACTIONS);

const REWARD_EVENT_CATALOG = Object.freeze([
  Object.freeze({
    eventType: "pirate_war_depot",
    cause: CAUSE.OCCUPATION_CLAIM,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(WAR_DEPOT_TEMPLATES),
    startStates: Object.freeze(["CONTESTED", "INVASION"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Supply Depot",
    weight: 2,
    slots: 1,
    durationMs: 3 * 3600000,
    cooldownMs: 8 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: WAR_DEPOT_TEMPLATES,
    reward: "depot",
  }),
  Object.freeze({
    eventType: "pirate_war_vault",
    cause: CAUSE.OCCUPATION_HELD,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(WAR_VAULT_TEMPLATES),
    startStates: Object.freeze(["OCCUPIED", "CONSOLIDATING"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "War Vault",
    weight: 1,
    slots: 1,
    durationMs: 4 * 3600000,
    cooldownMs: 12 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: WAR_VAULT_TEMPLATES,
    reward: "vault",
  }),
]);

const DED_COMPLEX_TEMPLATES = Object.freeze({
  500010: Object.freeze(["client-dungeon:2265", "client-dungeon:5233", "client-dungeon:2262", "client-dungeon:2257"]),
  500011: Object.freeze(["client-dungeon:2477", "client-dungeon:2246", "client-dungeon:2261", "client-dungeon:2256"]),
  500012: Object.freeze(["client-dungeon:2245", "client-dungeon:5237", "client-dungeon:5221", "client-dungeon:2260"]),
  500019: Object.freeze(["client-dungeon:2243", "client-dungeon:5239", "client-dungeon:5235", "client-dungeon:2258"]),
  500020: Object.freeze(["client-dungeon:2455", "client-dungeon:5238", "client-dungeon:5236", "client-dungeon:2259"]),
});

const BATTLE_RELIC_TEMPLATES = Object.freeze({
  500010: Object.freeze(["client-dungeon:1808", "client-dungeon:1814", "client-dungeon:1819", "client-dungeon:1825",
    "client-dungeon:1763", "client-dungeon:1793", "client-dungeon:1852", "client-dungeon:1860"]),
  500011: Object.freeze(["client-dungeon:1737", "client-dungeon:1738", "client-dungeon:1739", "client-dungeon:1741",
    "client-dungeon:1706", "client-dungeon:1775", "client-dungeon:1850", "client-dungeon:1857"]),
  500012: Object.freeze(["client-dungeon:1811", "client-dungeon:1817", "client-dungeon:1822", "client-dungeon:1828",
    "client-dungeon:1743", "client-dungeon:1791", "client-dungeon:1853", "client-dungeon:1859"]),
  500019: Object.freeze(["client-dungeon:1809", "client-dungeon:1815", "client-dungeon:1820", "client-dungeon:1826",
    "client-dungeon:1768", "client-dungeon:1792", "client-dungeon:1849", "client-dungeon:1861"]),
  500020: Object.freeze(["client-dungeon:1810", "client-dungeon:1816", "client-dungeon:1821", "client-dungeon:1827",
    "client-dungeon:1773", "client-dungeon:1830", "client-dungeon:1835", "client-dungeon:1862"]),
  500025: Object.freeze(["client-dungeon:12204", "client-dungeon:12225", "client-dungeon:12239",
    "client-dungeon:12240"]),
});

const ANOMALY_EVENT_CATALOG = Object.freeze([
  Object.freeze({
    eventType: "ded_complex",
    cause: CAUSE.OCCUPATION_HELD,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(DED_COMPLEX_TEMPLATES),
    startStates: Object.freeze(["OCCUPIED", "CONSOLIDATING"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Deadspace Complex",
    weightKey: "dedComplexWeight",
    slots: 1,
    durationMs: 6 * 3600000,
    cooldownMs: 12 * 3600000,
    aftermathMs: 30 * 60000,
    templatesByFaction: DED_COMPLEX_TEMPLATES,
  }),
  Object.freeze({
    eventType: "battle_relics",
    cause: CAUSE.BATTLE_AFTERMATH,
    content: CONTENT.SELF,
    causeFactions: selfFactionsOf(BATTLE_RELIC_TEMPLATES),
    startStates: OCCUPATION_STATES,
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Battlefield Ruins",
    weightKey: "battleRelicsWeight",
    slots: 1,
    durationMs: 3 * 3600000,
    cooldownMs: 6 * 3600000,
    aftermathMs: 10 * 60000,
    templatesByFaction: BATTLE_RELIC_TEMPLATES,
    clearedConsequence: false,
  }),
]);

const RICH_VEIN_TEMPLATES = Object.freeze(["client-dungeon:1562", "client-dungeon:1564", "client-dungeon:1559",
  "client-dungeon:1555", "client-dungeon:1556"]);

const RICH_VEIN_FRONT_TEMPLATES = Object.freeze(["client-dungeon:1527", "client-dungeon:1505", "client-dungeon:1563",
  "client-dungeon:1557"]);

const MOON_VEIN_TEMPLATES = Object.freeze(["evejs-mod:moon-ore:r16:v1", "evejs-mod:moon-ore:r32:v1",
  "evejs-mod:moon-ore:r64:v1"]);

const RICH_VEIN_EVENT_CATALOG = Object.freeze([
  Object.freeze({
    eventType: "rich_vein_liberated",
    cause: CAUSE.LIBERATED,
    content: CONTENT.NEUTRAL,
    causeFactions: null,
    startStates: Object.freeze(["STABLE"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Rich Ore Vein",
    weightKey: "liberatedWeight",
    slots: 1,
    durationMs: 36 * 3600000,
    cooldownMs: 48 * 3600000,
    aftermathMs: 10 * 60000,
    templatesByFaction: Object.freeze({ [NEUTRAL_CONTENT_KEY]: RICH_VEIN_TEMPLATES }),
    clearedConsequence: false,
  }),
  Object.freeze({
    eventType: "rich_vein_front",
    cause: CAUSE.FRONT_LINE,
    content: CONTENT.NEUTRAL,
    causeFactions: null,
    startStates: Object.freeze(["CONTESTED", "INVASION"]),
    securityClasses: Object.freeze(["nullsec"]),
    labelNoun: "Frontline Ore Vein",
    weightKey: "frontWeight",
    slots: 1,
    durationMs: 36 * 3600000,
    cooldownMs: 48 * 3600000,
    aftermathMs: 10 * 60000,
    templatesByFaction: Object.freeze({ [NEUTRAL_CONTENT_KEY]: RICH_VEIN_FRONT_TEMPLATES }),
    clearedConsequence: false,
  }),
]);

const cd = (ids) => Object.freeze(ids.map((n) => `client-dungeon:${n}`));
const DEV_ORE_HIGHSEC_TEMPLATES = cd([1345, 1349, 1413, 1347, 1448, 1456]);
const DEV_ORE_LOWSEC_TEMPLATES = cd([1466, 1464, 1465, 1482, 1499, 1505, 1521, 1540, 1527, 1533, 1555, 1348, 1344,
  1350]);
const DEV_ORE_NULLSEC_TEMPLATES = cd([1565, 1455, 1564, 1562, 1558, 1563, 1559]);

const DEV_RATS_HIGHSEC_TEMPLATES = Object.freeze({
  500010: cd([2203, 2328, 2312, 2322]),
  500011: cd([2200, 2326, 2114, 2317]),
  500012: cd([2205, 2332, 2316, 2325]),
  500019: cd([2206, 2329, 2313, 2323]),
  500020: cd([2204, 2331, 2315, 2324]),
});
const DEV_RATS_FRONTIER_TEMPLATES = Object.freeze({
  500010: cd([2121, 2161, 2128, 2168]),
  500011: cd([2113, 2159, 2126, 2166]),
  500012: cd([2124, 2163, 2130, 2171]),
  500019: cd([2125, 2165, 2131, 2169]),
  500020: cd([2123, 2162, 2129, 2170]),
  500025: INCURSION_TEMPLATES[500025],
});

const devType = (eventType, cause, content, securityClasses, labelNoun, weightKey, durationMs, templatesByFaction) =>
  Object.freeze({
    eventType,
    cause,
    content,
    causeFactions: content === CONTENT.SELF ? selfFactionsOf(templatesByFaction) : null,
    startStates: Object.freeze(["STABLE"]),
    securityClasses: Object.freeze(securityClasses),
    labelNoun,
    weightKey,
    slots: 1,
    durationMs,
    cooldownMs: 24 * 3600000,
    aftermathMs: 10 * 60000,
    templatesByFaction,
    clearedConsequence: false,
  });
const neutralOf = (list) => Object.freeze({ [NEUTRAL_CONTENT_KEY]: list });
const DEVELOPED_EVENT_CATALOG = Object.freeze([
  devType("developed_ore_highsec", CAUSE.DEVELOPED_INDUSTRY, CONTENT.NEUTRAL, ["highsec"], "Prospect Field",
    "anomalyOreWeight", 24 * 3600000, neutralOf(DEV_ORE_HIGHSEC_TEMPLATES)),
  devType("developed_ore_lowsec", CAUSE.DEVELOPED_INDUSTRY, CONTENT.NEUTRAL, ["lowsec"], "Prospect Field",
    "anomalyOreWeight", 24 * 3600000, neutralOf(DEV_ORE_LOWSEC_TEMPLATES)),
  devType("developed_ore_nullsec", CAUSE.DEVELOPED_INDUSTRY, CONTENT.NEUTRAL, ["nullsec"], "Prospect Field",
    "anomalyOreWeight", 24 * 3600000, neutralOf(DEV_ORE_NULLSEC_TEMPLATES)),
  devType("developed_rats_highsec", CAUSE.DEVELOPED_MILITARY, CONTENT.SELF, ["highsec"], "Raider Den",
    "anomalyRatsWeight", 4 * 3600000, DEV_RATS_HIGHSEC_TEMPLATES),
  devType("developed_rats_frontier", CAUSE.DEVELOPED_MILITARY, CONTENT.SELF, ["lowsec", "nullsec"], "Raider Den",
    "anomalyRatsWeight", 4 * 3600000, DEV_RATS_FRONTIER_TEMPLATES),
]);

module.exports = {
  CATALOG_VERSION,
  CAUSE,
  CONTENT,
  FACTION_LABELS,
  DENIED_TEMPLATE_IDS,
  SECURITY_CLASSES,
  OCCUPATION_STATES,
  INCURSION_TEMPLATES,
  STRONGHOLD_TEMPLATES,
  OUTPOST_TEMPLATES,
  EVENT_CATALOG,
  REWARD_PROFILES,
  REWARD_FACTIONS,
  REWARD_EVENT_CATALOG,
  DED_COMPLEX_TEMPLATES,
  BATTLE_RELIC_TEMPLATES,
  ANOMALY_EVENT_CATALOG,
  NEUTRAL_CONTENT_KEY,
  RICH_VEIN_TEMPLATES,
  RICH_VEIN_FRONT_TEMPLATES,
  MOON_VEIN_TEMPLATES,
  RICH_VEIN_EVENT_CATALOG,
  DEV_ORE_HIGHSEC_TEMPLATES,
  DEV_ORE_LOWSEC_TEMPLATES,
  DEV_ORE_NULLSEC_TEMPLATES,
  DEV_RATS_HIGHSEC_TEMPLATES,
  DEV_RATS_FRONTIER_TEMPLATES,
  DEVELOPED_EVENT_CATALOG,
  rewardLootIdOf,
};
