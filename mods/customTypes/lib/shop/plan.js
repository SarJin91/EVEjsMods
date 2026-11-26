"use strict";

const CAUSE_PRIORITY = Object.freeze({
  EXPIRING: 1, DELIST: 1, CREATE: 2, STALE_PRICE: 3, STALE_KIND: 3, STALE_STATION: 3, EXCESS: 4,
});

const MAX_TITLE_LENGTH = 200;

function titleOf(entry) {
  const suffix = entry.runs === null || entry.runs === undefined ? "(BPO)" : `(BPC ${entry.runs})`;
  const name = String(entry.name || `Blueprint ${entry.typeID}`);
  const room = MAX_TITLE_LENGTH - suffix.length - 1;
  return `${name.slice(0, Math.max(0, room))} ${suffix}`;
}

const pairKey = (stationID, typeID) => `${stationID}:${typeID}`;

function planPass(input) {
  const stations = Array.isArray(input.stations) ? input.stations : [];
  const stationSet = new Set(stations);
  const catalog = Array.isArray(input.catalog) ? input.catalog : [];
  const catalogByType = new Map(catalog.map((entry) => [entry.typeID, entry]));
  const busy = input.busyStations instanceof Set ? input.busyStations : new Set();
  const stationsByType = new Map(catalog.map((entry) => [entry.typeID, Array.isArray(entry.stations)
    ? new Set(stations.filter((stationID) => entry.stations.includes(stationID))) : stationSet]));
  const perTypeOf = (entry) => (Number.isSafeInteger(entry.perType) ? entry.perType : input.perType);
  const stats = {
    target: catalog.reduce((sum, entry) => sum + stationsByType.get(entry.typeID).size * perTypeOf(entry), 0),
    live: 0,
    deficit: 0,
    unknownType: 0,
    skippedBusy: stations.filter((stationID) => busy.has(stationID)).length,
    budgetCut: false,
  };
  const candidates = [];
  const push = (cause, action) => candidates.push({ priority: CAUSE_PRIORITY[cause], order: candidates.length, action });

  const outstanding = (Array.isArray(input.ours) ? input.ours : [])
    .filter((contract) => contract && contract.status === input.outstandingStatus)
    .sort((left, right) => left.contractID - right.contractID);

  const live = new Map();
  const held = new Map();
  const addTo = (map, key, contract) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(contract);
  };

  for (const contract of outstanding) {
    const entry = catalogByType.get(contract.typeID);
    const key = pairKey(contract.stationID, contract.typeID);
    const configured = (entry ? stationsByType.get(contract.typeID) : stationSet).has(contract.stationID);
    if (contract.pending || busy.has(contract.stationID)) {
      if (!entry) {
        stats.unknownType += 1;
      } else if (configured) {
        addTo(live, key, contract);
        stats.live += 1;
      }
      continue;
    }
    if (input.delist) {
      push("DELIST", { kind: "delete", contractID: contract.contractID, cause: "DELIST" });
      if (entry) stats.live += 1;
      else stats.unknownType += 1;
      continue;
    }
    if (!entry) {
      stats.unknownType += 1;
      continue;
    }
    if (!configured) {
      push("STALE_STATION", { kind: "delete", contractID: contract.contractID, cause: "STALE_STATION" });
      continue;
    }
    if (contract.dateExpiredFt - input.nowFt < input.renewLeadFt) {
      push("EXPIRING", { kind: "delete", contractID: contract.contractID, cause: "EXPIRING" });
      continue;
    }
    const wantedTag = entry.kindTag || input.kindTag;
    if (contract.price !== entry.price) {
      push("STALE_PRICE", { kind: "delete", contractID: contract.contractID, cause: "STALE_PRICE" });
      addTo(held, key, contract);
      continue;
    }
    if (contract.kindTag !== wantedTag) {
      push("STALE_KIND", { kind: "delete", contractID: contract.contractID, cause: "STALE_KIND" });
      addTo(held, key, contract);
      continue;
    }
    addTo(live, key, contract);
    stats.live += 1;
  }

  if (!input.delist) {
    for (const stationID of stations) {
      if (busy.has(stationID)) continue;
      for (const entry of catalog) {
        if (!stationsByType.get(entry.typeID).has(stationID)) continue;
        const perType = perTypeOf(entry);
        const key = pairKey(stationID, entry.typeID);
        const liveHere = live.get(key) || [];
        const heldHere = (held.get(key) || []).length;
        const deficit = Math.max(0, perType - liveHere.length - heldHere);
        stats.deficit += deficit;
        for (let index = 0; index < deficit; index += 1) {
          push("CREATE", { kind: "create", stationID, typeID: entry.typeID, price: entry.price, title: titleOf(entry) });
        }
        if (liveHere.length > perType) {
          const excess = liveHere.slice(perType).reverse();
          for (const contract of excess) {
            push("EXCESS", { kind: "delete", contractID: contract.contractID, cause: "EXCESS" });
          }
        }
      }
    }
  }

  candidates.sort((left, right) => left.priority - right.priority || left.order - right.order);
  const maxActions = Math.max(0, input.maxActions);
  stats.budgetCut = candidates.length > maxActions;
  const deletes = [];
  const creates = [];
  for (const { action } of candidates.slice(0, maxActions)) {
    if (action.kind === "delete") deletes.push({ contractID: action.contractID, cause: action.cause });
    else creates.push({ stationID: action.stationID, typeID: action.typeID, price: action.price, title: action.title });
  }
  return { deletes, creates, stats };
}

module.exports = {
  CAUSE_PRIORITY,
  MAX_TITLE_LENGTH,
  planPass,
  titleOf,
};
