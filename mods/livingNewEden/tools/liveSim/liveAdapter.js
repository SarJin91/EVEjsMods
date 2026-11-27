"use strict";

const { createBenchAdapter, realAdapterMethodNames, BENCH_UNSUPPORTED } = require("../campaign/benchAdapter");
const { registerShutdown } = require("../../lib/adapter/gameStoreHooks");
const { readGridAnchorsFrom } = require("../../lib/adapter/gridAnchors");
const { readSystemInteriorFrom } = require("../../lib/adapter/systemInterior");
const { listNpcStationsInSystemFrom } = require("../../lib/adapter/npcStations");

function createLiveAdapter(deps) {
  const { world, driver, policy, band, shutdown } = deps;
  const bench = createBenchAdapter({ world, driver, policy, band });
  const names = realAdapterMethodNames();
  const unsupported = new Map();
  const own = {
    registerShutdownHook: (name, handler) => registerShutdown(shutdown.gameStoreLike, name, handler),
  };
  if (world && world.statics !== null && typeof world.statics === "object") {
    const gridVendor = Object.freeze({ worldData: world.worldData,
      structures: Object.freeze({ peekStructuresForSystem: () => [] }),
      itemStore: Object.freeze({ listStarbaseItems: () => [] }) });
    own.readGridAnchors = (systemId, opts) => readGridAnchorsFrom(gridVendor, systemId, opts);
    own.readSystemInterior = (systemId, opts) => readSystemInteriorFrom(world.worldData, systemId, opts);
    if (deps.stationsFromStatics === true) {
      own.listNpcStationsInSystem = (systemId) => listNpcStationsInSystemFrom(world.worldData, systemId);
    }
  }
  for (const name of Object.keys(own)) {
    if (!names.includes(name)) throw new Error(`liveSim adapter: ${name} not in createAdapter`);
  }
  const adapter = {};
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(own, name)) {
      adapter[name] = own[name];
      continue;
    }
    const method = bench[name];
    adapter[name] = (...args) => {
      const r = method(...args);
      if (r === BENCH_UNSUPPORTED) unsupported.set(name, (unsupported.get(name) || 0) + 1);
      return r;
    };
  }
  return { adapter: Object.freeze(adapter), getUnsupported: () => Object.fromEntries(unsupported) };
}

module.exports = { createLiveAdapter };
