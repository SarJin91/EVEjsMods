"use strict";

const LOCK = Object.freeze({ SECRET: "SECRET", SELF: "SELF", BOOT_CRITICAL: "BOOT_CRITICAL", TEST_ONLY: "TEST_ONLY",
  UNSUPPORTED_TYPE: "UNSUPPORTED_TYPE", READ_ONLY: "READ_ONLY" });

const LNE_LOCKS = Object.freeze({
  secretKeys: Object.freeze(["chatterAi.baseUrl", "chatterAi.dailyTokenBudget", "chatterAi.voiceTokenSharePermille",
    "chatterAi.talkTokenSharePermille", "chatterAi.newsTokenSharePermille", "chatterAi.plotTokenSharePermille",
    "shipAi.baseUrl", "shipAi.dailyTokenBudget", "shipAi.voicePiperUrl"]),
  keys: Object.freeze({
    enabled: LOCK.BOOT_CRITICAL,
    "persistence.dbFile": LOCK.BOOT_CRITICAL,
    "observer.enabled": LOCK.BOOT_CRITICAL,
    "observer.host": LOCK.BOOT_CRITICAL,
    "observer.port": LOCK.BOOT_CRITICAL,
    "inGameMap.observerUrl": LOCK.BOOT_CRITICAL,
  }),
  prefixes: Object.freeze([["modSettings.", LOCK.SELF], ["testing.", LOCK.TEST_ONLY]]),
});

const SHIP_WING_LOCKS = Object.freeze({ secretKeys: Object.freeze([]), keys: Object.freeze({}),
  prefixes: Object.freeze([]) });

const NO_LOCKS = SHIP_WING_LOCKS;

const MOD_LOCKS = Object.freeze({
  hotPathPerf: NO_LOCKS,
  scenePerfFix: Object.freeze({ secretKeys: Object.freeze([]),
    keys: Object.freeze({ inertKinds: LOCK.UNSUPPORTED_TYPE }), prefixes: Object.freeze([]) }),
  npcKillsGiveSp: NO_LOCKS,
  "EveJS-AdvancedUtilityDrones-1.0.3": Object.freeze({ secretKeys: Object.freeze([]),
    keys: Object.freeze({ playersFile: LOCK.BOOT_CRITICAL }), prefixes: Object.freeze([]) }),
  autopilotJumpZero: NO_LOCKS,
  dailyGoalsPersist: NO_LOCKS,
  marketAllRegions: NO_LOCKS,
  industryOrphanCleanup: NO_LOCKS,
  missionStructureRestore: NO_LOCKS,
  skyhookOrphanFix: NO_LOCKS,
  customTypes: NO_LOCKS,
  moonOreAnomalies: NO_LOCKS,
  soloProgressionBalance: NO_LOCKS,
  planetaryDrill: Object.freeze({ secretKeys: Object.freeze([]),
    keys: Object.freeze({ launchTypeID: LOCK.BOOT_CRITICAL }), prefixes: Object.freeze([]) }),
  blueprintDrops: Object.freeze({ secretKeys: Object.freeze([]),
    keys: Object.freeze({ resonatorChance: LOCK.UNSUPPORTED_TYPE, resonatorQuantity: LOCK.UNSUPPORTED_TYPE,
      componentCtrChance: LOCK.UNSUPPORTED_TYPE }), prefixes: Object.freeze([]) }),
  droneClassBalance: Object.freeze({ secretKeys: Object.freeze([]), keys: Object.freeze({}),
    prefixes: Object.freeze([["", LOCK.READ_ONLY]]) }),
});

function staticLockOf(spec, row) {
  if (!row || typeof row.key !== "string") return null;
  if (row.secret === true || row.envOnly === true || spec.secretKeys.includes(row.key)) return LOCK.SECRET;
  if (Object.prototype.hasOwnProperty.call(spec.keys, row.key)) return spec.keys[row.key];
  const hit = spec.prefixes.find(([prefix]) => row.key.startsWith(prefix));
  return hit ? hit[1] : null;
}

module.exports = { LOCK, LNE_LOCKS, SHIP_WING_LOCKS, MOD_LOCKS, staticLockOf };
