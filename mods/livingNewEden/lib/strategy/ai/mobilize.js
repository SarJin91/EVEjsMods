"use strict";

function stagingOf(snapshot, supply, distT, target) {
  if (snapshot.doctrine && snapshot.doctrine.hive === true) {
    const nodes = (supply.footholdSystems || []).filter((id) => id !== target && distT.has(id))
      .sort((a, b) => distT.get(a) - distT.get(b) || a - b);
    return nodes.length > 0 ? nodes[0] : null;
  }
  const stations = supply.stationSystems.filter((id) => id !== target && distT.has(id))
    .sort((a, b) => distT.get(a) - distT.get(b) || a - b);
  if (stations.length > 0) return stations[0];
  const home = snapshot.faction.homeSystemId;
  return home !== null && home !== target && distT.has(home) ? home : null;
}

function stationCandidates(snapshot, distT, target) {
  return (snapshot.stations || []).filter((x) => x.systemId !== target && distT.has(x.systemId))
    .sort((a, b) => distT.get(a.systemId) - distT.get(b.systemId) || a.systemId - b.systemId
      || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
}

module.exports = { stagingOf, stationCandidates };
