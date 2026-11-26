"use strict";

const MERGE_ROLES_ALLOWED = Object.freeze(["invasion", "garrison", "scout", "patrol", "wormhole", "reserve"]);
const IDLE = "IDLE";
const MERGE = "MERGE";

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function mergeFits(keeper, x, capital) {
  const classes = Array.isArray(capital.classes) ? capital.classes : [];
  const own = Array.isArray(x.composition) ? x.composition : [];
  if (own.some((e) => e && classes.includes(e.hullGroup))) return false;
  const groups = new Set([...(Array.isArray(keeper.composition) ? keeper.composition : []), ...own]
    .filter((e) => e).map((e) => e.hullGroup));
  return groups.size <= capital.maxGroups;
}

function planMerges(snapshot, params, used) {
  const none = { intents: [], notes: [] };
  const P = params && params.merge;
  if (!P || !Array.isArray(P.roles) || !Number.isSafeInteger(P.maxPerReview) || P.maxPerReview < 1) return none;
  if (!snapshot || snapshot.fleetsTruncated === true || !Array.isArray(snapshot.fleets)) return none;
  if (snapshot.doctrine && snapshot.doctrine.hive === true) return none;
  const roles = P.roles.filter((r) => MERGE_ROLES_ALLOWED.includes(r));
  const max = Number.isSafeInteger(P.maxShipsPerFleet) ? P.maxShipsPerFleet : 0;
  const groups = new Map();
  for (const f of snapshot.fleets) {
    if (f.state !== IDLE || f.operationId !== null || f.refitPending === true || used.has(f.fleetId)) continue;
    if (!roles.includes(f.fleetRole) || !Number.isSafeInteger(f.systemId) || !Number.isSafeInteger(f.shipCount)) {
      continue;
    }
    const key = `${f.systemId}|${f.fleetRole}`;
    if (!groups.has(key)) groups.set(key, { systemId: f.systemId, fleetRole: f.fleetRole, fleets: [] });
    groups.get(key).fleets.push(f);
  }
  const ordered = [...groups.values()].filter((g) => g.fleets.length >= 2)
    .sort((a, b) => a.systemId - b.systemId || (a.fleetRole < b.fleetRole ? -1 : (a.fleetRole > b.fleetRole ? 1 : 0)));
  const intents = [];
  const notes = new Set();
  for (const g of ordered) {
    const sorted = [...g.fleets].sort((a, b) => b.shipCount - a.shipCount || byFleetId(a, b));
    const keeper = sorted[0];
    const absorbed = sorted.slice(1).sort(byFleetId).find((x) => keeper.shipCount + x.shipCount <= max
      && (!P.capital || mergeFits(keeper, x, P.capital)));
    if (!absorbed) continue;
    if (intents.length >= P.maxPerReview) {
      notes.add("MERGE_LIMIT");
      break;
    }
    intents.push({ type: MERGE, systemId: g.systemId, fleetRole: g.fleetRole,
      keeper: { fleetId: keeper.fleetId, expectedVersion: keeper.version },
      absorbed: { fleetId: absorbed.fleetId, expectedVersion: absorbed.version } });
    used.add(keeper.fleetId);
    used.add(absorbed.fleetId);
    notes.add("MERGE");
  }
  return { intents, notes: [...notes].sort() };
}

module.exports = { planMerges, MERGE_ROLES_ALLOWED };
