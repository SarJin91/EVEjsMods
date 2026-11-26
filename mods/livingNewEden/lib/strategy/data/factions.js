"use strict";

const FACTION_REGISTRY_VERSION = 19;

const FACTIONS_V1 = Object.freeze([
  Object.freeze({
    factionId: 500003,
    kind: "empire",
    ownerCorporationId: 1000084,
    hqSystemId: 30002187,
    homeRegionIds: Object.freeze([10000043, 10000020]),
    doctrineId: "amarr-border-defense-v3",
    maxActiveFronts: 6,
    initialResourceUnits: 20000,
    initialReserveUnits: 300,
    allies: Object.freeze([500006]),
    tributeTo: 500006,
    startStations: Object.freeze([
      Object.freeze({ kind: "upwell", systemId: 30001721, structureFamily: "astrahus" }),
      Object.freeze({ kind: "npc", stationId: 60006658, systemId: 30003563, corporationId: 1000067 }),
      Object.freeze({ kind: "npc", stationId: 60006673, systemId: 30004299, corporationId: 1000067 }),
      Object.freeze({ kind: "npc", stationId: 60007948, systemId: 30004309, corporationId: 1000080 }),
      Object.freeze({ kind: "npc", stationId: 60006448, systemId: 30003562, corporationId: 1000065 }),
    ]),
    corporationRoles: Object.freeze({ mining: 1000063 }),
    origin: "SDE factions.jsonl 500003 Amarr Empire: corporationID 1000084 Amarr Navy, hq 30002187 Amarr; " +
      "home regions Domain 10000043 + Tash-Murkon 10000020; defender of k3-stain from Saminer. " +
      "v14: 4 NPC start stations of rule R-B (Misaba, Sakht, Hophib, Ziriert; candidates.border 1-4, one " +
      "per system), Saminer Upwell stays first (k3 defender)",
  }),
  Object.freeze({
    factionId: 500006,
    kind: "police",
    ownerCorporationId: 1000137,
    hqSystemId: 30005204,
    homeRegionIds: Object.freeze([10000020]),
    doctrineId: "concord-border-police-v1",
    maxActiveFronts: 2,
    initialResourceUnits: 1000,
    initialReserveUnits: 100,
    allies: Object.freeze([500001, 500002, 500003, 500004]),
    startStations: Object.freeze([
      Object.freeze({ kind: "upwell", systemId: 30001718, structureFamily: "astrahus" }),
    ]),
    origin: "SDE factions.jsonl 500006 CONCORD Assembly: corporationID 1000137 DED, hq 30005204 Yulai; " +
      "home region Tash-Murkon 10000020; police belt 4 jumps from highsec, base Astrahus in Paye 30001718",
  }),
  Object.freeze({
    factionId: 500019,
    kind: "pirate",
    ownerCorporationId: 1000162,
    hqSystemId: 30001868,
    homeRegionIds: Object.freeze([10000022]),
    doctrineId: "sansha-incursion-v1",
    maxActiveFronts: 6,
    initialResourceUnits: 10000,
    initialReserveUnits: 200,
    allies: Object.freeze([]),
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60014284, systemId: 30001868, corporationId: 1000162 }),
      Object.freeze({ kind: "npc", stationId: 60014149, systemId: 30001868, corporationId: 1000161 }),
      Object.freeze({ kind: "npc", stationId: 60014257, systemId: 30001901, corporationId: 1000161 }),
      Object.freeze({ kind: "npc", stationId: 60014185, systemId: 30001894, corporationId: 1000161 }),
      Object.freeze({ kind: "npc", stationId: 60014248, systemId: 30001951, corporationId: 1000161 }),
    ]),
    origin: "SDE factions.jsonl 500019 Sansha's Nation: corporationID 1000162 True Power, hq 30001868 37S-KO " +
      "(Stain 10000022); stations npcStations.jsonl owners 1000161 True Creations / 1000162 True Power",
  }),
  Object.freeze({
    factionId: 500020,
    kind: "pirate",
    ownerCorporationId: 1000135,
    hqSystemId: 30004518,
    homeRegionIds: Object.freeze([10000057]),
    doctrineId: "serpentis-territorial-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 8000,
    initialReserveUnits: 150,
    allies: Object.freeze([500011]),
    startStations: Object.freeze([
      Object.freeze({ kind: "upwell", systemId: 30004518, structureFamily: "astrahus" }),
      Object.freeze({ kind: "npc", stationId: 60012859, systemId: 30004623, corporationId: 1000135 }),
      Object.freeze({ kind: "npc", stationId: 60012862, systemId: 30004619, corporationId: 1000135 }),
    ]),
    origin: "SDE factions.jsonl 500020 Serpentis: corporationID 1000135 Serpentis Corporation; SDE hq is " +
      "30004623 Serpentis Prime (Fountain, player null) - the mod base is NM-OEA 30004518 in Outer Ring 10000057 " +
      "(not 4C-B7X: ORE headquarters); ally Angel Cartel 500011 as in battle/data/hostility.js. " +
      "v17: 2 NPC start stations of Serpentis Corporation 1000135 in Fountain (60012859 Serpentis Prime " +
      "60012862 A-1CON, the nearest of the 24 to NM-OEA, 19 jumps, one per system) for trade; the NM-OEA " +
      "Upwell stays first",
  }),
  Object.freeze({
    factionId: 500010,
    kind: "pirate",
    ownerCorporationId: 1000127,
    hqSystemId: 30001290,
    homeRegionIds: Object.freeze([10000015]),
    doctrineId: "pirate-territorial-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 8000,
    initialReserveUnits: 150,
    allies: Object.freeze([]),
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60012556, systemId: 30001290, corporationId: 1000127 }),
      Object.freeze({ kind: "npc", stationId: 60013261, systemId: 30001290, corporationId: 1000141 }),
      Object.freeze({ kind: "npc", stationId: 60012559, systemId: 30001291, corporationId: 1000127 }),
      Object.freeze({ kind: "npc", stationId: 60012568, systemId: 30001269, corporationId: 1000127 }),
      Object.freeze({ kind: "npc", stationId: 60012571, systemId: 30001269, corporationId: 1000127 }),
    ]),
    origin: "SDE 3396210 factions.jsonl 500010 Guristas Pirates: corporationID 1000127 Guristas; ( " +
      ") rule R-N: base 30001290 6NJ8-V (= SDE hq, Venal 10000015), 8 nullsec candidates, 5 start stations " +
      "(Guristas 1000127, Guristas Production 1000141); budget 8000/150 and 1 front = Serpentis parity",
  }),
  Object.freeze({
    factionId: 500011,
    kind: "pirate",
    ownerCorporationId: 1000138,
    hqSystemId: 30001045,
    homeRegionIds: Object.freeze([10000012]),
    doctrineId: "pirate-territorial-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 8000,
    initialReserveUnits: 150,
    allies: Object.freeze([500020]),
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60013069, systemId: 30001045, corporationId: 1000138 }),
      Object.freeze({ kind: "npc", stationId: 60012238, systemId: 30001047, corporationId: 1000124 }),
      Object.freeze({ kind: "npc", stationId: 60012241, systemId: 30001044, corporationId: 1000124 }),
      Object.freeze({ kind: "npc", stationId: 60012778, systemId: 30001048, corporationId: 1000133 }),
      Object.freeze({ kind: "npc", stationId: 60012781, systemId: 30001047, corporationId: 1000133 }),
    ]),
    origin: "SDE 3396210 factions.jsonl 500011 Angel Cartel: corporationID 1000138 Dominations " +
      "rule R-N: base 30001045 Utopia (= SDE hq, Curse 10000012), 8 nullsec candidates, 5 start stations " +
      "(Dominations 1000138, Archangels 1000124, Salvation Angels 1000133); ally Serpentis 500020 (hostility v3)",
  }),
  Object.freeze({
    factionId: 500012,
    kind: "pirate",
    ownerCorporationId: 1000134,
    hqSystemId: 30004709,
    homeRegionIds: Object.freeze([10000060]),
    doctrineId: "pirate-territorial-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 8000,
    initialReserveUnits: 150,
    allies: Object.freeze([]),
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60014942, systemId: 30004709, corporationId: 1000134 }),
      Object.freeze({ kind: "npc", stationId: 60014943, systemId: 30004709, corporationId: 1000134 }),
      Object.freeze({ kind: "npc", stationId: 60014941, systemId: 30004707, corporationId: 1000134 }),
      Object.freeze({ kind: "npc", stationId: 60014940, systemId: 30004706, corporationId: 1000134 }),
      Object.freeze({ kind: "npc", stationId: 60014944, systemId: 30004708, corporationId: 1000134 }),
    ]),
    origin: "SDE 3396210 factions.jsonl 500012 Blood Raider Covenant: corporationID 1000134 Blood Raiders; SDE hq " +
      "30003088 Oyonata has no nullsec station - rule R-N: base 30004709 KFIE-Z (the most " +
      "nullsec stations), region Delve 10000060 from SDE mapSolarSystems.jsonl (catalog ownRegionIds is empty), " +
      "8 nullsec candidates, 5 start stations (Blood Raiders 1000134)",
  }),
  Object.freeze({
    factionId: 500001,
    kind: "empire",
    ownerCorporationId: 1000035,
    hqSystemId: 30000145,
    homeRegionIds: Object.freeze([10000002, 10000016, 10000069]),
    doctrineId: "empire-border-defense-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 20000,
    initialReserveUnits: 300,
    allies: Object.freeze([500006]),
    tributeTo: 500006,
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60015106, systemId: 30045307, corporationId: 1000035 }),
      Object.freeze({ kind: "npc", stationId: 60000826, systemId: 30001447, corporationId: 1000008 }),
      Object.freeze({ kind: "npc", stationId: 60000946, systemId: 30001429, corporationId: 1000009 }),
      Object.freeze({ kind: "npc", stationId: 60000964, systemId: 30000205, corporationId: 1000009 }),
      Object.freeze({ kind: "npc", stationId: 60003172, systemId: 30000200, corporationId: 1000028 }),
    ]),
    corporationRoles: Object.freeze({ mining: 1000005, logistics: 1000002 }),
    origin: "SDE 3396210 factions.jsonl 500001 Caldari State: corporationID 1000035 Caldari Navy, hq 30000145 New " +
      "Caldari (The Forge); border regions The Forge 10000002 + Lonetrek 10000016 + Black Rise " +
      "10000069, 5 start stations of rule R-B (Okagaiken, Taisy, Torrinos, Obe, Akkio); budget 20000/300 and 1 " +
      "front = Amarr parity",
  }),
  Object.freeze({
    factionId: 500002,
    kind: "empire",
    ownerCorporationId: 1000051,
    hqSystemId: 30002544,
    homeRegionIds: Object.freeze([10000028, 10000042]),
    doctrineId: "empire-border-defense-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 20000,
    initialReserveUnits: 300,
    allies: Object.freeze([500006]),
    tributeTo: 500006,
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60004870, systemId: 30002420, corporationId: 1000051 }),
      Object.freeze({ kind: "npc", stationId: 60004489, systemId: 30003466, corporationId: 1000046 }),
      Object.freeze({ kind: "npc", stationId: 60004723, systemId: 30002086, corporationId: 1000050 }),
      Object.freeze({ kind: "npc", stationId: 60005806, systemId: 30003471, corporationId: 1000061 }),
      Object.freeze({ kind: "npc", stationId: 60004882, systemId: 30002419, corporationId: 1000051 }),
    ]),
    corporationRoles: Object.freeze({ mining: 1000055, logistics: 1000053 }),
    origin: "SDE 3396210 factions.jsonl 500002 Minmatar Republic: corporationID 1000051 Republic Fleet, hq 30002544 " +
      "Pator (Heimatar, not a border region); border regions Molden Heath 10000028 + Metropolis " +
      "10000042, 5 start stations of rule R-B (Egbinger, Eurgrana, Turnur, Konora, Aeditide); budget 20000/300 and " +
      "1 front = Amarr parity",
  }),
  Object.freeze({
    factionId: 500004,
    kind: "empire",
    ownerCorporationId: 1000120,
    hqSystemId: 30004993,
    homeRegionIds: Object.freeze([10000044, 10000048, 10000068]),
    doctrineId: "empire-border-defense-v2",
    maxActiveFronts: 6,
    initialResourceUnits: 20000,
    initialReserveUnits: 300,
    allies: Object.freeze([500006]),
    tributeTo: 500006,
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60011773, systemId: 30003820, corporationId: 1000120 }),
      Object.freeze({ kind: "npc", stationId: 60011824, systemId: 30003830, corporationId: 1000120 }),
      Object.freeze({ kind: "npc", stationId: 60011896, systemId: 30005328, corporationId: 1000120 }),
      Object.freeze({ kind: "npc", stationId: 60009496, systemId: 30003573, corporationId: 1000097 }),
      Object.freeze({ kind: "npc", stationId: 60010966, systemId: 30003793, corporationId: 1000110 }),
    ]),
    corporationRoles: Object.freeze({ mining: 1000098 }),
    origin: "SDE 3396210 factions.jsonl 500004 Gallente Federation: corporationID 1000120 Federation Navy, hq " +
      "30004993 Villore (Essence, not a border region); border regions Solitude 10000044 + Placid " +
      "10000048 + Verge Vendor 10000068, 5 start stations of rule R-B (Vestouve, Orvolle, Reblier, Pertnineere, " +
      "Harroule); budget 20000/300 and 1 front = Amarr parity",
  }),
  Object.freeze({
    factionId: 500016,
    kind: "neutral",
    ownerCorporationId: 1000130,
    hqSystemId: 30001978,
    homeRegionIds: Object.freeze([10000023]),
    doctrineId: "soe-territorial-v1",
    maxActiveFronts: 6,
    initialResourceUnits: 8000,
    initialReserveUnits: 150,
    allies: Object.freeze([]),
    startStations: Object.freeze([
      Object.freeze({ kind: "npc", stationId: 60012595, systemId: 30001978, corporationId: 1000130 }),
      Object.freeze({ kind: "npc", stationId: 60013075, systemId: 30001978, corporationId: 1000139 }),
      Object.freeze({ kind: "npc", stationId: 60014056, systemId: 30001978, corporationId: 1000159 }),
      Object.freeze({ kind: "npc", stationId: 60012598, systemId: 30001977, corporationId: 1000130 }),
      Object.freeze({ kind: "npc", stationId: 60012601, systemId: 30001983, corporationId: 1000130 }),
    ]),
    origin: "SDE 3396210 factions.jsonl 500016 Servant Sisters of EVE: corporationID 1000130 Sisters of EVE, hq " +
      "30001978 X-7OMU (Pure Blind 10000023, nullsec); rule R-N: 5 start " +
      "stations = candidates.nullsec 1-5 (Sisters of EVE 1000130, Food Relief 1000139, The Sanctuary 1000159); " +
      "no high/lowsec station (Q-b); budget 8000/150 and 6 fronts = pirate parity; hostility v5",
  }),
  Object.freeze({
    factionId: 500005,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000149,
    origin: "SDE 3396210 factions.jsonl 500005 Jove Empire: " +
      "corporationID 1000149 Jove Navy; passive",
  }),
  Object.freeze({
    factionId: 500007,
    kind: "empire",
    activity: "passive",
    ownerCorporationId: 1000123,
    origin: "SDE 3396210 factions.jsonl 500007 Ammatar Mandate: " +
      "corporationID 1000123 Ammatar Fleet; passive",
  }),
  Object.freeze({
    factionId: 500008,
    kind: "empire",
    activity: "passive",
    ownerCorporationId: 1000156,
    origin: "SDE 3396210 factions.jsonl 500008 Khanid Kingdom: " +
      "corporationID 1000156 Royal Khanid Navy; passive",
  }),
  Object.freeze({
    factionId: 500009,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000146,
    origin: "SDE 3396210 factions.jsonl 500009 The Syndicate: " +
      "corporationID 1000146 Intaki Space Police; passive",
  }),
  Object.freeze({
    factionId: 500013,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000148,
    origin: "SDE 3396210 factions.jsonl 500013 EverMore: " +
      "corporationID 1000148 InterBus; passive",
  }),
  Object.freeze({
    factionId: 500014,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000129,
    origin: "SDE 3396210 factions.jsonl 500014 ORE: " +
      "corporationID 1000129 Outer Ring Excavations; passive",
  }),
  Object.freeze({
    factionId: 500015,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000163,
    origin: "SDE 3396210 factions.jsonl 500015 Thukker Tribe: " +
      "corporationID 1000163 Trust Partners; passive",
  }),
  Object.freeze({
    factionId: 500017,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000131,
    origin: "SDE 3396210 factions.jsonl 500017 The Society of Conscious Thought: " +
      "corporationID 1000131 Society of Conscious Thought; passive",
  }),
  Object.freeze({
    factionId: 500018,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000128,
    origin: "SDE 3396210 factions.jsonl 500018 Mordu's Legion Command: " +
      "corporationID 1000128 Mordu's Legion; passive",
  }),
  Object.freeze({
    factionId: 500021,
    kind: "invader",
    ownerCorporationId: null,
    hqSystemId: null,
    homeRegionIds: Object.freeze([]),
    doctrineId: "sleeper-invader-v1",
    maxActiveFronts: 0,
    initialResourceUnits: 3000,
    initialReserveUnits: 50,
    allies: Object.freeze([]),
    startStations: Object.freeze([]),
    origin: "SDE 3396210 factions.jsonl 500021 Unknown (EveJS Sleeper NPCs): " +
      "corporationID 0 in npcProfiles; label Sleepers from vendor fact (pirateFactionPolicy.js:22-24); " +
      "active invader, no home, no stations, sleeper-invader-v1",
  }),
  Object.freeze({
    factionId: 500024,
    kind: "invader",
    requiresFlag: "drifters",
    ownerCorporationId: 1000274,
    hqSystemId: null,
    homeRegionIds: Object.freeze([]),
    doctrineId: "drifter-invader-v1",
    maxActiveFronts: 1,
    initialResourceUnits: 3000,
    initialReserveUnits: 50,
    allies: Object.freeze([]),
    startStations: Object.freeze([]),
    origin: "SDE 3396210 factions.jsonl 500024 Drifters: " +
      "corporationID 1000274 Vigilant Tyrannos; passive " +
      "active invader behind flag drifters, no home, no stations " +
      "drifter-invader-v1",
  }),
  Object.freeze({
    factionId: 500025,
    kind: "hive",
    requiresFlag: "hive",
    ownerCorporationId: 1000287,
    hqSystemId: 30001051,
    homeRegionIds: Object.freeze([10000013, 10000018, 10000021, 10000027, 10000034, 10000040, 10000053, 10000066]),
    doctrineId: "rogue-hive-v1",
    maxActiveFronts: 3,
    initialResourceUnits: 20000,
    initialReserveUnits: 200,
    allies: Object.freeze([]),
    startStations: Object.freeze([]),
    origin: "SDE 3396210 factions.jsonl 500025 Rogue Drones: " +
      "corporationID 1000287 Infested Regions Hiveminds; passive " +
      "kind hive, no stations, 8 home regions of " +
      "pirateFactionPolicy.js:113-120, hq TD-4XL 30001051, rogue-hive-v1; budgets a hypothesis",
  }),
  Object.freeze({
    factionId: 500026,
    kind: "invader",
    ownerCorporationId: 1000298,
    hqSystemId: 30002797,
    homeRegionIds: Object.freeze([10000070]),
    doctrineId: "triglavian-invader-v1",
    maxActiveFronts: 1,
    initialResourceUnits: 6000,
    initialReserveUnits: 100,
    allies: Object.freeze([]),
    startStations: Object.freeze([]),
    origin: "SDE 3396210 factions.jsonl 500026 Triglavian Collective: " +
      "corporationID 1000298 The Convocation of Triglav; " +
      "active invader, hq Kaunokka 30002797, home Pochven 10000070, triglavian-invader-v1",
  }),
  Object.freeze({
    factionId: 500027,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000297,
    origin: "SDE 3396210 factions.jsonl 500027 EDENCOM: " +
      "corporationID 1000297 AEGIS; passive",
  }),
  Object.freeze({
    factionId: 500028,
    kind: "neutral",
    activity: "passive",
    ownerCorporationId: 1000413,
    origin: "SDE 3396210 factions.jsonl 500028 Association for Interdisciplinary Research: " +
      "corporationID 1000413 AIR Laboratories; passive",
  }),
  Object.freeze({
    factionId: 500029,
    kind: "invader",
    ownerCorporationId: 1000441,
    hqSystemId: 30100000,
    homeRegionIds: Object.freeze([10001000]),
    doctrineId: "deathless-invader-v1",
    maxActiveFronts: 1,
    initialResourceUnits: 4000,
    initialReserveUnits: 100,
    allies: Object.freeze([]),
    startStations: Object.freeze([]),
    origin: "SDE 3396210 factions.jsonl 500029 Deathless Circle: " +
      "corporationID 1000441 Deathless Wraiths; " +
      "active invader, hq Zarzakh 30100000, home Zarzakh 10001000, deathless-invader-v1",
  }),
]);

module.exports = { FACTION_REGISTRY_VERSION, FACTIONS_V1 };