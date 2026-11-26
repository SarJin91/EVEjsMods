// Port of the vendor spawn pool npc_mining_hauler_highsec (EveJS tools/DatabaseCreator/staticTables/npcSpawnPools/ data.json, the same profile ids and weights; CREDITS.md).

"use strict";

const TRAFFIC_HAULER_PROFILES = Object.freeze([
  Object.freeze({ profileId: "ore_mining_bestower_hauler", weight: 3 }),
  Object.freeze({ profileId: "ore_mining_badger_hauler", weight: 3 }),
  Object.freeze({ profileId: "ore_mining_mammoth_hauler", weight: 2 }),
  Object.freeze({ profileId: "ore_mining_bustard_hauler", weight: 1 }),
]);

const TRAFFIC_VENDOR_POOL_ID = "npc_mining_hauler_highsec";

module.exports = { TRAFFIC_HAULER_PROFILES, TRAFFIC_VENDOR_POOL_ID };
