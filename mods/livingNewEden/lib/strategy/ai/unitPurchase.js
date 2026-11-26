"use strict";

const PERMILLE = 1000;
const UPKEEP = "UPKEEP";

const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function permilleOf(value, permille) {
  return Math.floor(value / PERMILLE) * permille + Math.floor(((value % PERMILLE) * permille) / PERMILLE);
}

function kindsOf(value) {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? value.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : [];
}

function planUnitPurchase(snapshot, upkeep, proj, params) {
  const same = { upkeep, proj, notes: [], purchase: null };
  const P = params ? params.upkeep : null;
  if (!P || P.iskTopUpEnabled !== true || !proj || !upkeep || !Array.isArray(upkeep.intents)) return same;
  const kind = snapshot && snapshot.entry ? snapshot.entry.kind : null;
  if (!kindsOf(P.iskTopUpKinds).includes(kind)) return same;
  const at = upkeep.intents.findIndex((i) => i && i.type === UPKEEP && Number.isSafeInteger(i.charged)
    && i.charged >= 1);
  if (at < 0 || upkeep.offensiveAllowed !== false) return same;
  const noted = (note) => ({ ...same, notes: [note] });
  if (upkeep.unpaidPeriods > 0) return noted("UNIT_PURCHASE_DEBT");
  if (proj.austerity === true) return noted("UNIT_PURCHASE_AUSTERITY");
  const cost = upkeep.rates ? upkeep.rates.cost : null;
  const price = P.iskPerUnit;
  const res = upkeep.projected ? upkeep.projected.resourceUnits : null;
  if (!Number.isSafeInteger(cost) || cost <= 0 || !Number.isSafeInteger(price) || price < 1
    || !Number.isSafeInteger(res)) return same;
  const need = (count(P.offensiveReservePeriods) + count(P.iskTopUpHeadroomPeriods)) * cost - res;
  const initial = snapshot && snapshot.treasury ? count(snapshot.treasury.initialIsk) : 0;
  const floorIsk = Math.max(count(proj.austerityEnterIsk), permilleOf(initial, count(P.iskTopUpFloorPermille)));
  let spare = Math.max(0, count(proj.projectedIsk) - floorIsk);
  if (proj.war) spare = Math.min(spare, permilleOf(count(proj.war.room), count(P.iskTopUpRoomSharePermille)));
  const byIsk = Math.floor(spare / price);
  const perPeriod = count(P.iskTopUpMaxUnitsPerPeriod);
  const capRoom = Math.max(0, count(P.maxResourceUnits) - res);
  const units = Math.min(need, perPeriod, byIsk, capRoom);
  if (!(units > 0)) {
    return need > 0 && perPeriod > 0 && capRoom > 0 && byIsk <= 0 ? noted("UNIT_PURCHASE_NO_ISK") : same;
  }
  const isk = units * price;
  if (!Number.isSafeInteger(isk)) return same;
  const purchase = { units, isk };
  const resourceUnits = res + units;
  const intents = upkeep.intents.map((i, n) => (n === at ? { ...i, purchase } : i));
  const bought = { ...upkeep, intents, notes: [...upkeep.notes],
    projected: { ...upkeep.projected, resourceUnits },
    offensiveAllowed: upkeep.unpaidPeriods === 0 && resourceUnits >= count(P.offensiveReservePeriods) * cost };
  const room = proj.war ? proj.war.room - isk : null;
  const projOut = { ...proj, projectedIsk: proj.projectedIsk - isk,
    ...(proj.war ? { war: { ...proj.war, room, productionCap: Math.min(proj.war.productionCap, room) } } : {}) };
  return { upkeep: bought, proj: projOut, notes: [`UNIT_PURCHASE:${units}`], purchase };
}

module.exports = { planUnitPurchase };
