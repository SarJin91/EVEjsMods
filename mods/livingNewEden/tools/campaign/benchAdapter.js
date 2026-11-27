"use strict";

const { createAdapter } = require("../../lib/adapter");
const { loadMapNames } = require("../../lib/adapter/mapNames");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { resolveSystemFactionsFrom } = require("../../lib/adapter/factionPolicy");
const { readNpcStationsFrom } = require("../../lib/adapter/npcStations");
const { readSystemBeltsFrom } = require("../../lib/adapter/asteroidBelts");
const { readPirateFactionIdsFrom } = require("../../lib/adapter/standingWrite");

const BENCH_UNSUPPORTED = Object.freeze({ ok: false, reason: "BENCH_UNSUPPORTED" });

function realAdapterMethodNames() {
  const real = createAdapter({ requireFn: () => {
    throw new Error("bench: no game modules");
  }, existsSync: () => false });
  return Object.keys(real).filter((k) => typeof real[k] === "function").sort();
}

function createBenchAdapter(deps) {
  const { world, driver, policy, band } = deps;
  const probeReport = Object.freeze({ modules: Object.freeze([]), passed: true,
    counts: Object.freeze({ ok: 0, drift: 0, missing: 0 }), disabledModules: Object.freeze({}), error: null });
  const sovClaims = Object.freeze({ claimOf: () => ({ ok: true, claimed: false, allianceId: null }) });

  const own = {
    getProcessRole: () => "world",
    runProbe: () => probeReport,
    getProbeReport: () => probeReport,
    getDisabledModules: () => Object.freeze({}),
    getLoadedOutsideCache: () => [],
    loadSqliteDriver: () => driver,
    readStaticMap: () => (band ? readStaticMapFrom(world.worldData, band, { mapNames: loadMapNames({}) })
      : { ok: false, reason: "SECURITY_BAND_UNAVAILABLE" }),
    resolveSystemFactions: (systemIds) => (policy ? resolveSystemFactionsFrom(policy, systemIds)
      : { ok: false, reason: "FACTION_POLICY_UNAVAILABLE" }),
    readPirateFactionIds: () => (policy ? readPirateFactionIdsFrom(policy)
      : { ok: false, reason: "PIRATE_SET_UNAVAILABLE" }),
    readFactionNames: () => {
      const names = loadMapNames({});
      return names.ok ? { ok: true, names: names.factions } : names;
    },
    readSdeBuild: () => (world.sdeBuild ? { ok: true, build: world.sdeBuild }
      : { ok: false, reason: "SDE_BUILD_UNAVAILABLE", detail: "_sde.jsonl" }),
    readNpcStations: (stationIds) => readNpcStationsFrom(world.worldData, stationIds),
    readSystemBelts: (systemIds) => readSystemBeltsFrom(world.asteroidData, systemIds),
    getSovClaims: () => sovClaims,
  };

  const adapter = {};
  for (const name of realAdapterMethodNames()) {
    adapter[name] = Object.prototype.hasOwnProperty.call(own, name) ? own[name] : () => BENCH_UNSUPPORTED;
  }
  for (const name of Object.keys(own)) {
    if (!Object.prototype.hasOwnProperty.call(adapter, name)) throw new Error(`bench adapter: ${name} not in createAdapter`);
  }
  return Object.freeze(adapter);
}

module.exports = { createBenchAdapter, realAdapterMethodNames, BENCH_UNSUPPORTED };
