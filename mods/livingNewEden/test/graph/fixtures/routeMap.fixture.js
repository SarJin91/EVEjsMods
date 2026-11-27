"use strict";

const R1 = 10000001;
const R2 = 10000002;
const S = Object.freeze({
  N0: 30000201, H1: 30000202, L1: 30000203, L2: 30000204, N5: 30000205,
  N6: 30000206, N7: 30000207, N9: 30000208, N10: 30000209, ISO: 30000210,
});
const OUTSIDE = 30009999;

const SYSTEM_ROWS = [
  [S.N0, R1, -0.3], [S.H1, R1, 0.9], [S.L1, R1, 0.3], [S.L2, R1, 0.2], [S.N5, R2, -0.4],
  [S.N6, R2, -0.5], [S.N7, R2, -0.6], [S.N9, R1, -0.2], [S.N10, R1, -0.1], [S.ISO, R1, 0.1],
];

const BOTH_WAYS = [[S.N0, S.H1], [S.H1, S.N9], [S.N0, S.L1], [S.L1, S.L2], [S.N0, S.N5], [S.N5, S.N6],
  [S.N6, S.N7], [S.N7, S.N9], [S.N9, S.N10]];
const ONE_WAY = [[S.L2, S.N9], [S.N10, OUTSIDE]];

function rawWorld() {
  const solarSystems = SYSTEM_ROWS.map(([id, regionID, security]) => ({
    regionID, constellationID: regionID === R1 ? 20000201 : 20000202, solarSystemID: id,
    solarSystemName: `S${id}`, security, factionID: 0, radius: 1,
  }));
  const stargates = [];
  let itemID = 50000201;
  const gate = (from, to) => {
    stargates.push({ itemID, solarSystemID: from, destinationSolarSystemID: to, destinationID: itemID + 1 });
    itemID += 1;
  };
  for (const [a, b] of BOTH_WAYS) {
    gate(a, b);
    gate(b, a);
  }
  for (const [a, b] of ONE_WAY) gate(a, b);
  return { solarSystems, stargates, stations: [] };
}

module.exports = { R1, R2, S, OUTSIDE, rawWorld };
