"use strict";

const { createLneProvider } = require("./lne");
const { createShipWingProvider } = require("./shipWing");
const hotPathPerf = require("./hotPathPerf");
const scenePerfFix = require("./scenePerfFix");
const npcKillsGiveSp = require("./npcKillsGiveSp");
const aud = require("./aud");
const simpleMods = require("./simpleMods");
const solo = require("./solo");
const blueprintDrops = require("./blueprintDrops");
const droneClassBalance = require("./droneClassBalance");

const simple = (modId) => Object.freeze({ need: simpleMods.SPECS[modId].need,
  create: (deps) => simpleMods.createSimpleModProvider(modId, deps) });

const FLAT_PROVIDERS = Object.freeze({
  [aud.MOD_ID]: Object.freeze({ need: aud.NEED, create: aud.createAudProvider }),
  [hotPathPerf.MOD_ID]: Object.freeze({ need: hotPathPerf.NEED, create: hotPathPerf.createHotPathPerfProvider }),
  [scenePerfFix.MOD_ID]: Object.freeze({ need: scenePerfFix.NEED, create: scenePerfFix.createScenePerfFixProvider }),
  [npcKillsGiveSp.MOD_ID]: Object.freeze({ need: npcKillsGiveSp.NEED,
    create: npcKillsGiveSp.createNpcKillsGiveSpProvider }),
  moonOreAnomalies: simple("moonOreAnomalies"),
  [solo.MOD_ID]: Object.freeze({ need: solo.NEED, create: solo.createSoloProvider }),
  autopilotJumpZero: simple("autopilotJumpZero"),
  [droneClassBalance.MOD_ID]: Object.freeze({ need: droneClassBalance.NEED,
    create: droneClassBalance.createDroneClassBalanceProvider }),
  [blueprintDrops.MOD_ID]: Object.freeze({ need: blueprintDrops.NEED,
    create: blueprintDrops.createBlueprintDropsProvider }),
  marketAllRegions: simple("marketAllRegions"),
  dailyGoalsPersist: simple("dailyGoalsPersist"),
  industryOrphanCleanup: simple("industryOrphanCleanup"),
  skyhookOrphanFix: simple("skyhookOrphanFix"),
  customTypes: simple("customTypes"),
  planetaryDrill: simple("planetaryDrill"),
  missionStructureRestore: simple("missionStructureRestore"),
});
const PROVIDER_MODS = Object.freeze(["livingNewEden", "shipWing", ...Object.keys(FLAT_PROVIDERS)]);
const MAX_DETAIL = 120;

function createProvider(modId, deps) {
  try {
    if (modId === "livingNewEden") {
      return createLneProvider({ modDir: deps.modDir, env: deps.env, config: deps.config });
    }
    const flat = Object.prototype.hasOwnProperty.call(FLAT_PROVIDERS, modId) ? FLAT_PROVIDERS[modId] : null;
    if (modId !== "shipWing" && !flat) return { ok: false, reason: "NO_PROVIDER" };
    const adapter = deps.adapter;
    if (!adapter || typeof adapter.loadModConfig !== "function") return { ok: false, reason: "adapter_unavailable" };
    if (modId === "shipWing") {
      return createShipWingProvider({ loaded: adapter.loadModConfig("shipWing"), env: deps.env });
    }
    return flat.create({ loaded: adapter.loadModConfig(modId, { need: flat.need, manifest: true }), env: deps.env });
  } catch (err) {
    return { ok: false, reason: "PROVIDER_FAILED", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
}

module.exports = { PROVIDER_MODS, createProvider };
