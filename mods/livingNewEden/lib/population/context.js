"use strict";

const { BANDS } = require("./schema");

const MAX_STATIONS = 32767;

function buildSystemTable({ graph, stationCountOf, hubDistance, S }) {
  const ids = [];
  const bandCodes = [];
  for (let b = 0; b < BANDS.length; b += 1) {
    for (const id of graph.getSystemsBySecClass(BANDS[b]) || []) {
      ids.push(id);
      bandCodes.push(b);
    }
  }
  const n = ids.length;
  const systemIds = new Int32Array(n);
  const band = new Uint8Array(n);
  const stations = new Int16Array(n);
  const regionId = new Int32Array(n);
  const hubJumps = new Int16Array(n);
  const homeWeight = new Float32Array(n);
  const indexOf = new Map();
  const hubSet = new Set(S.hubSystemIds);
  const maxHub = Math.max(1, S.maxHubJumps);
  const byRegion = new Map();
  const homesByBand = BANDS.map(() => []);
  for (let i = 0; i < n; i += 1) {
    const id = ids[i];
    const v = graph.getSystem(id);
    const count = Math.max(0, Math.min(MAX_STATIONS, Math.floor(Number(stationCountOf(id)) || 0)));
    const jumps = hubDistance && hubDistance.has(id) ? hubDistance.get(id) : -1;
    systemIds[i] = id;
    band[i] = bandCodes[i];
    stations[i] = count;
    regionId[i] = v && Number.isSafeInteger(v.regionId) ? v.regionId : 0;
    hubJumps[i] = jumps;
    indexOf.set(id, i);
    homeWeight[i] = count * (jumps >= 0 ? 1 + (maxHub - Math.min(maxHub, jumps)) / maxHub : 1);
    if (count > 0) {
      homesByBand[bandCodes[i]].push(i);
      const list = byRegion.get(regionId[i]);
      if (list) list.push(id);
      else byRegion.set(regionId[i], [id]);
    }
  }
  const homes = homesByBand.map((list) => {
    const idx = Int32Array.from(list);
    const cum = new Float64Array(idx.length);
    let sum = 0;
    for (let k = 0; k < idx.length; k += 1) {
      sum += homeWeight[idx[k]];
      cum[k] = sum;
    }
    return Object.freeze({ idx, cum, total: sum });
  });
  const stationSystemsByRegion = new Map();
  for (const [r, list] of byRegion) stationSystemsByRegion.set(r, Int32Array.from(list.sort((a, b) => a - b)));
  const hubIds = Object.freeze(S.hubSystemIds.filter((id) => indexOf.has(id)));

  function sys(systemId) {
    const i = indexOf.get(systemId);
    if (i === undefined) return null;
    return { systemId, band: BANDS[band[i]], stations: stations[i], regionId: regionId[i], isHub: hubSet.has(systemId) };
  }

  function bandOf(systemId) {
    const i = indexOf.get(systemId);
    return i === undefined ? null : BANDS[band[i]];
  }

  return Object.freeze({ size: n, systemIds, band, stations, regionId, hubJumps, homeWeight, indexOf, homes,
    stationSystemsByRegion, hubIds, sys, bandOf });
}

module.exports = { buildSystemTable };
