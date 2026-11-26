"use strict";

const { postLevelOf } = require("./capitalLevel");
const { eligibleClassesOf, CAPITAL_LEVEL_TIER } = require("./capitalAttach");
const { isReplenishedRole } = require("./replenish");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const READY = "ready";
const HUNTER = "hunter";
const SUPER_TIER = 2;
const NOTE = "CAPITAL_REPLENISH";
const NOTE_NO_STOCK = "CAPITAL_REPLENISH_NO_STOCK";

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nonNegInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

const hasCapital = (composition) => composition.some((e) => e
  && Object.prototype.hasOwnProperty.call(CAPITAL_LEVEL_TIER, e.hullGroup));

function levelOf(snapshot, params, fleet) {
  const level = postLevelOf(snapshot, params, fleet.systemId, snapshot.doctrine.templates[fleet.fleetRole]).level;
  if (fleet.fleetRole !== HUNTER || !params.capitalLevel) return level;
  const cap = params.capitalLevel.huntMaxLevel;
  return Number.isSafeInteger(cap) && cap >= 0 ? Math.min(level, cap) : level;
}

function planCapitalReplenish(opts) {
  const cost = { resourceUnits: 0, reserveUnits: 0 };
  const intents = [];
  const notes = [];
  const fleetIds = [];
  const out = () => ({ intents, notes, cost, fleetIds });
  const { snapshot, params, ledger } = opts || {};
  const C = params && params.capitalReplenish;
  const R = params && params.replenish;
  const attach = params && params.capitalAttach;
  if (!C || !R || !attach || !Array.isArray(attach.roles) || !ledger || typeof ledger.available !== "function"
    || typeof ledger.take !== "function") return out();
  if (!snapshot || !snapshot.faction || snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== READY) return out();
  const pr = snapshot.production;
  if (!pr || pr.mode !== READY || pr.truncated === true || snapshot.fleetsTruncated === true
    || !Array.isArray(pr.stations)) return out();
  const limit = Math.min(nonNegInt(C.maxPerReview), nonNegInt(opts.room));
  if (limit === 0) return out();
  const skip = opts.skip instanceof Set ? opts.skip : new Set();
  const slotBase = nonNegInt(opts.slotBase);
  const classes = snapshot.capitalClasses && typeof snapshot.capitalClasses === "object" ? snapshot.capitalClasses : {};
  const perR = params.mobilizeResourcePerShip;
  const perV = params.mobilizeReservePerShip;
  const budget = opts.budget || { resourceUnits: 0, reserveUnits: 0 };
  let noStock = false;
  const candidates = snapshot.fleets.filter((x) => x.state === IDLE && x.refitPending !== true && !x.operationId
    && attach.roles.includes(x.fleetRole) && isReplenishedRole(snapshot, x.fleetRole) && Array.isArray(x.composition)
    && !hasCapital(x.composition) && !skip.has(x.fleetId))
    .sort((a, b) => byId(a.fleetId, b.fleetId));
  for (const fleet of candidates) {
    if (intents.length >= limit) break;
    const stations = pr.stations.filter((s) => s.systemId === fleet.systemId)
      .sort((a, b) => byId(a.stationId, b.stationId));
    if (stations.length === 0) continue;
    if (fleet.shipCount + 1 > R.maxShipsPerFleet) continue;
    const allowed = eligibleClassesOf({ template: fleet.composition, capitalClasses: classes, attach,
      level: levelOf(snapshot, params, fleet) })
      .filter((cls) => fleet.fleetRole !== HUNTER || CAPITAL_LEVEL_TIER[cls] !== SUPER_TIER);
    if (allowed.length === 0) continue;
    let pick = null;
    for (const s of stations) {
      const cls = allowed.find((c) => ledger.available(s.stationId, c) >= 1);
      if (cls) {
        pick = { station: s, cls };
        break;
      }
    }
    if (!pick) {
      noStock = true;
      continue;
    }
    const leftR = budget.resourceUnits - cost.resourceUnits;
    const leftV = budget.reserveUnits - cost.reserveUnits;
    if ((perR > 0 && leftR < perR) || (perV > 0 && leftV < perV)) continue;
    const unit = { resourceUnits: perR, reserveUnits: perV };
    cost.resourceUnits += unit.resourceUnits;
    cost.reserveUnits += unit.reserveUnits;
    ledger.take(pick.station.stationId, [{ itemKey: `group:${pick.cls}`, count: 1 }]);
    fleetIds.push(fleet.fleetId);
    intents.push({ type: "REPLENISH", slot: slotBase + intents.length, fleetId: fleet.fleetId,
      expectedVersion: fleet.version, stationId: pick.station.stationId, systemId: fleet.systemId,
      add: [{ hullGroup: pick.cls, typeId: classes[pick.cls], count: 1 }], cost: unit, capital: true });
  }
  if (intents.length > 0) notes.push(NOTE);
  if (noStock) notes.push(NOTE_NO_STOCK);
  return out();
}

module.exports = { planCapitalReplenish, CAPITAL_REPLENISH_NOTE: NOTE, CAPITAL_REPLENISH_NO_STOCK_NOTE: NOTE_NO_STOCK };
