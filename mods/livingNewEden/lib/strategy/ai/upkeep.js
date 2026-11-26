"use strict";

const { homeYieldOf } = require("./invaderEconomy");

const PERMILLE = 1000;
const invaderOf = (params) => (params && params.invaderEconomy) || null;
const ABANDON_STATES = Object.freeze(["STABLE", "OCCUPIED", "CONSOLIDATING"]);
const EMPIRE_KIND = "empire";

function ratesOf(u, P, E) {
  const captured = Array.isArray(u.captured) ? u.captured : [];
  const detachedList = captured.filter((x) => x.detachedSinceAt !== null && x.detachedSinceAt !== undefined);
  const detached = detachedList.length;
  const plain = Math.max(0, (u.controlledCount || 0) - detached);
  const stations = Math.max(0, u.stationCount || 0);
  const factorSum = detachedList.reduce((n, x) => n + Math.max(PERMILLE, x.factorPermille || PERMILLE), 0);
  const income0 = P.incomePerSystem * plain + P.incomePerStation * stations + (E ? homeYieldOf(u, E).unitsPerPeriod : 0);
  const homeIncome = homeIncomeOf(u, P);
  const income = income0 + (homeIncome === null ? 0 : homeIncome);
  const cost = P.costPerSystem * plain + Math.ceil((P.costPerSystem * factorSum) / PERMILLE)
    + P.capturedCostPerSystem * captured.length
    + Math.floor((Math.max(0, u.liveShips || 0) * P.costPerShipPermille) / PERMILLE);
  const tradeUnits = u.tradeReady === true
    ? Math.min(Math.floor((income * P.tradeIncomeSharePermille) / PERMILLE), Math.max(0, income - cost)) : 0;
  return { income, cost, reserveIncome: P.reservePerStation * stations, tradeUnits, detached,
    ...(homeIncome === null ? {} : { homeIncome }) };
}

function homeIncomeOf(u, P) {
  const h = u.homeSpaceSystems;
  if (P.homeSpaceIncomeEnabled !== true || !Number.isSafeInteger(h) || h <= 0) return null;
  const per = Number.isSafeInteger(P.homeSpaceIncomePermille) ? Math.max(0, P.homeSpaceIncomePermille) : 0;
  return Math.floor((h * per) / PERMILLE);
}

function shipRoomOf(u, rates, P, truncated) {
  const per = P.costPerShipPermille;
  if (!Number.isSafeInteger(per) || per <= 0) return null;
  if (truncated === true) return 0;
  const live = Math.max(0, u.liveShips || 0);
  return Math.max(0, maxShipsOf(live, rates, per, P.shipCapMarginPermille) - live);
}

function maxShipsOf(live, rates, per, marginPermille) {
  const allowance = allowanceOf(live, rates, per, marginPermille);
  return allowance <= 0 ? 0 : Math.floor((allowance * PERMILLE) / per);
}

function allowanceOf(live, rates, per, marginPermille) {
  const shipCost = Math.floor((live * per) / PERMILLE);
  const base = rates.cost - shipCost;
  const margin = Number.isSafeInteger(marginPermille) ? Math.max(0, marginPermille) : 0;
  return rates.income - rates.tradeUnits - base - Math.ceil((rates.income * margin) / PERMILLE);
}

function reliefOf(snapshot, u, r, P, unpaid) {
  return reliefPick(snapshot, u, r, P, unpaid).ships;
}

function reliefPick(snapshot, u, r, P, unpaid) {
  const none = { ships: null, noGain: false };
  if (!P || P.deficitReliefEnabled !== true || !kindAllowed(snapshot, P)) return none;
  const per = P.costPerShipPermille;
  if (!Number.isSafeInteger(per) || per <= 0) return none;
  if (snapshot.fleetsTruncated === true) return none;
  const after = P.deficitReliefAfterUnpaidPeriods;
  if (!Number.isSafeInteger(after) || !(unpaid >= after)) return none;
  const live = Math.max(0, u.liveShips || 0);
  const margin = P.deficitReliefMarginPermille;
  if (allowanceOf(live, r, per, margin) <= 0) return { ships: null, noGain: live > 0 };
  return { ships: Math.max(0, live - maxShipsOf(live, r, per, margin)), noGain: false };
}

function gainOf(x, P) {
  const detached = x.detachedSinceAt !== null && x.detachedSinceAt !== undefined;
  if (detached) {
    return Math.ceil((P.costPerSystem * Math.max(PERMILLE, x.factorPermille || PERMILLE)) / PERMILLE)
      + P.capturedCostPerSystem;
  }
  return P.costPerSystem + P.capturedCostPerSystem - P.incomePerSystem;
}

function capKindsOf(value) {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? value.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : [];
}

function kindAllowed(snapshot, P) {
  const kind = snapshot && snapshot.entry ? snapshot.entry.kind : null;
  if (!capKindsOf(P.shipCapKinds).includes(kind)) return false;
  return !(kind === EMPIRE_KIND && P.homeSpaceIncomeEnabled !== true);
}

function upgradeGrowthOf(snapshot, plan, P) {
  if (!P || P.deficitReliefEnabled !== true) return undefined;
  if (plan.unpaidPeriods > 0) return 0;
  return Number.isSafeInteger(plan.shipRoom) && kindAllowed(snapshot, P) ? plan.shipRoom : null;
}

function shipCapOf(snapshot, plan, affordable, params) {
  const P = params ? params.upkeep : null;
  const room = plan ? plan.shipRoom : undefined;
  const same = { affordable, capped: false };
  if (!P || P.shipCapEnabled !== true || !Number.isSafeInteger(room) || !affordable) return same;
  if (!kindAllowed(snapshot, P)) return same;
  const perShip = params.mobilizeResourcePerShip;
  const perRes = params.mobilizeReservePerShip;
  const resourceUnits = perShip > 0 ? Math.min(affordable.resourceUnits, room * perShip) : affordable.resourceUnits;
  const reserveUnits = perRes > 0 ? Math.min(affordable.reserveUnits, room * perRes) : affordable.reserveUnits;
  if (!(resourceUnits < affordable.resourceUnits || reserveUnits < affordable.reserveUnits)) return same;
  const out = { affordable: { ...affordable, resourceUnits, reserveUnits }, capped: true };
  const n = P.shipCapScoutShips;
  if (!Number.isSafeInteger(n) || n <= 0) return out;
  return { ...out, scoutRoom: {
    resourceUnits: Math.max(0, Math.min(affordable.resourceUnits - resourceUnits, n * perShip)),
    reserveUnits: Math.max(0, Math.min(affordable.reserveUnits - reserveUnits, n * perRes)) } };
}

function publicRates(r) {
  return { income: r.income, cost: r.cost, reserveIncome: r.reserveIncome, tradeUnits: r.tradeUnits,
    ...(r.homeIncome === undefined ? {} : { homeIncome: r.homeIncome }) };
}

function upkeepRates(snapshot, params) {
  const P = params && params.upkeep !== undefined ? params.upkeep : params;
  const u = snapshot && snapshot.upkeep;
  if (!P || !u || u.mode !== "ready") return null;
  const r = ratesOf(u, P, params && params.upkeep !== undefined ? invaderOf(params) : null);
  return publicRates(r);
}

function hoardCapOf(doctrine, income, P) {
  const max = P.maxResourceUnits;
  const periods = P.hoardCapPeriods;
  if (!doctrine || doctrine.hoardCapped !== true) return max;
  if (!Number.isSafeInteger(periods) || periods <= 0) return max;
  if (!Number.isSafeInteger(income) || income < 0) return max;
  return Math.min(max, periods * income);
}

function abandonList(u, P) {
  return abandonPick(u, P, false).list;
}

function abandonPick(u, P, gainOnly) {
  const all = (u.captured || []).filter((x) => ABANDON_STATES.includes(x.state))
    .filter((x) => x.core !== true);
  const candidates = gainOnly ? all.filter((x) => gainOf(x, P) > 0) : all;
  const noGain = gainOnly && all.length > 0 && candidates.length === 0;
  const cut = candidates.filter((x) => x.detachedSinceAt !== null && x.detachedSinceAt !== undefined)
    .sort((a, b) => (b.factorPermille || 0) - (a.factorPermille || 0) || a.systemId - b.systemId);
  const rest = candidates.filter((x) => x.detachedSinceAt === null || x.detachedSinceAt === undefined)
    .sort((a, b) => b.systemId - a.systemId);
  return { list: [...cut, ...rest].slice(0, Math.max(0, P.maxAbandonsPerReview)).map((x) => x.systemId), noGain };
}

function planUpkeep(snapshot, supply, params) {
  const res = snapshot.faction.resourceUnits;
  const reserve = snapshot.faction.reserveUnits;
  const P = params ? params.upkeep : null;
  const u = snapshot.upkeep;
  const none = { intents: [], notes: [], projected: { resourceUnits: res, reserveUnits: reserve },
    offensiveAllowed: true, unpaidPeriods: 0, rates: null };
  if (!P || !u || u.mode !== "ready") return none;
  const E = invaderOf(params);
  const r = ratesOf(u, P, E);
  const yieldNotes = E ? homeYieldOf(u, E).notes : [];
  const rates = publicRates(r);
  const room = P.shipCapEnabled === true ? { shipRoom: shipRoomOf(u, r, P, snapshot.fleetsTruncated === true) } : {};
  const cap = P.maxResourceUnits;
  const at = snapshot.at;
  const period = P.periodMs;
  const allowed = (unpaid, resources) => unpaid === 0 && resources >= P.offensiveReservePeriods * r.cost;
  const unpaidNow = u.unpaidPeriods || 0;
  const base = { type: "UPKEEP", income: r.income, cost: r.cost, tradeUnits: r.tradeUnits };
  const reliefFor = (unpaid, abandon, notes) => {
    if (P.deficitReliefEnabled !== true || abandon.length > 0) return {};
    const pick = reliefPick(snapshot, u, r, P, unpaid);
    if (pick.noGain) notes.push("UPKEEP_DEMOBILIZE_NO_GAIN");
    return Number.isSafeInteger(pick.ships) && pick.ships > 0 ? { relief: { ships: pick.ships } } : {};
  };
  if (u.paidUntil === null || u.paidUntil === undefined) {
    const intent = { ...base, periods: 0, charged: 0, paidUntilFrom: null,
      paidUntilTo: Math.floor(at / period) * period, delta: 0, reserveDelta: 0, shortfall: 0,
      unpaidPeriodsTo: unpaidNow, abandon: [] };
    const anchorNotes = ["UPKEEP_ANCHOR", ...yieldNotes];
    const anchorRelief = reliefFor(unpaidNow, [], anchorNotes);
    return { intents: [intent], notes: anchorNotes,
      projected: { resourceUnits: res, reserveUnits: reserve },
      offensiveAllowed: allowed(unpaidNow, res), unpaidPeriods: unpaidNow, rates, ...room, ...anchorRelief };
  }
  const periods = Math.floor((at - u.paidUntil) / period);
  if (!(periods > 0)) {
    const idleNotes = [];
    const idleRelief = reliefFor(unpaidNow, [], idleNotes);
    return { ...none, notes: idleNotes, offensiveAllowed: allowed(unpaidNow, res), unpaidPeriods: unpaidNow, rates,
      ...room, ...idleRelief };
  }
  const notes = [...yieldNotes];
  const charged = Math.min(periods, P.maxCatchUpPeriods);
  if (periods > charged) notes.push(`UPKEEP_FORGIVEN:${periods - charged}`);
  const net = r.income - r.tradeUnits - r.cost;
  const total = net * charged;
  const capH = hoardCapOf(snapshot.doctrine, r.income, P);
  const baseDelta = Math.max(total, -res);
  const delta0 = Math.min(baseDelta, Math.max(0, cap - res));
  const delta = Math.min(baseDelta, Math.max(0, capH - res));
  if (delta0 - delta > 0) notes.push("UPKEEP_HOARD_CAP");
  const shortfall = Math.max(0, -(res + total));
  const unpaidAdd = shortfall > 0 ? Math.min(charged, Math.ceil(shortfall / Math.max(1, -net))) : 0;
  const grown = unpaidNow + unpaidAdd;
  const unpaid = shortfall > 0 ? (Number.isSafeInteger(P.maxUnpaidPeriods) ? Math.min(P.maxUnpaidPeriods, grown)
    : grown) : 0;
  const reserveDelta = Math.max(0, Math.min(r.reserveIncome * charged,
    Math.min(P.maxReserveUnits, cap) - reserve));
  let abandon = [];
  if (unpaid >= P.abandonAfterUnpaidPeriods) {
    if (u.capturedTruncated === true) notes.push("UPKEEP_ABANDON_TRUNCATED");
    else if (P.deficitReliefEnabled === true) {
      const pick = abandonPick(u, P, true);
      abandon = pick.list;
      if (pick.noGain) notes.push("UPKEEP_ABANDON_NO_GAIN");
    } else abandon = abandonList(u, P);
  }
  if (shortfall > 0) notes.push(`UPKEEP_SHORTFALL:${shortfall}`);
  const intent = { ...base, periods, charged, paidUntilFrom: u.paidUntil, paidUntilTo: u.paidUntil + periods * period,
    delta, reserveDelta, shortfall, unpaidPeriodsTo: unpaid, abandon };
  const projected = { resourceUnits: res + delta, reserveUnits: reserve + reserveDelta };
  const relief = reliefFor(unpaid, abandon, notes);
  return { intents: [intent], notes, projected, offensiveAllowed: allowed(unpaid, projected.resourceUnits),
    unpaidPeriods: unpaid, rates, ...room, ...relief };
}

module.exports = { planUpkeep, upkeepRates, hoardCapOf, shipRoomOf, shipCapOf, ABANDON_STATES, abandonList, gainOf,
  reliefOf, kindAllowed, upgradeGrowthOf };
