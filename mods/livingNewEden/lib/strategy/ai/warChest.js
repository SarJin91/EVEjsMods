"use strict";

const DAY_MS = 86400000;
const MAX_ISK = 1e15;
const PERMILLE = 1000;

const nat = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const sat = (v) => Math.min(MAX_ISK, v);

function permilleOf(value, permille) {
  return Math.floor(value / PERMILLE) * permille + Math.floor(((value % PERMILLE) * permille) / PERMILLE);
}

function shareOf(v, num, den) {
  const q = Math.floor(v / den);
  const r = v % den;
  return q * num + Math.floor((r * num) / den);
}

function adminDailyOf(captured, T) {
  const c = nat(captured);
  const a = nat(T && T.adminIskPerCapturedSystemPerDay);
  const S = nat(T && T.adminSprawlSystems);
  if (c === 0 || a === 0) return 0;
  if (a > MAX_ISK / c) return MAX_ISK;
  const linear = a * c;
  if (S === 0) return linear;
  const q = Math.floor(linear / S);
  const r = linear % S;
  if (q > 0 && c > MAX_ISK / q) return MAX_ISK;
  return sat(linear + sat(q * c + Math.floor((r * c) / S)));
}

function warRoomOf(x, T) {
  const dayBudget = dayBudgetOf(x, T);
  const accrued = shareOf(dayBudget, nat(x.at) % DAY_MS, DAY_MS);
  const spentToday = spentOf(x.today, T);
  return { dayBudget, accrued, spentToday, room: Math.max(0, accrued - spentToday) };
}

function dayBudgetOf(x, T) {
  const balance = sat(nat(x.balanceIsk));
  const draw = permilleOf(balance, nat(T.savingsDrawPermillePerDay));
  const net = nat(x.incomeDaily) - nat(x.fleetUpkeepDaily) - nat(x.adminDaily);
  return sat(Math.max(0, net + draw));
}

function spentOf(row, T) {
  return row ? sat(nat(row.warSpend) + nat(row.productionFees) + nat(row.tradeOut)
    + permilleOf(sat(nat(row.losses)), nat(T.lossesInRoomPermille))) : 0;
}

function warRoomRollingOf(x, T) {
  const dayBudget = dayBudgetOf(x, T);
  const spentToday = spentOf(x.today, T);
  const spentYesterdayShare = shareOf(spentOf(x.yesterday, T), DAY_MS - (nat(x.at) % DAY_MS), DAY_MS);
  const spentWindow = sat(spentToday + spentYesterdayShare);
  return { dayBudget, accrued: dayBudget, spentToday, spentYesterdayShare, spentWindow,
    room: Math.max(0, dayBudget - spentWindow) };
}

function fitIskOf(composition, valueByGroup, permille) {
  let total = 0;
  for (const e of Array.isArray(composition) ? composition : []) {
    const v = valueByGroup && e ? nat(valueByGroup[e.hullGroup]) : 0;
    const n = e ? nat(e.count) : 0;
    total = sat(total + (v > 0 && n > MAX_ISK / v ? MAX_ISK : n * v));
  }
  return sat(permilleOf(total, nat(permille)));
}

module.exports = { adminDailyOf, warRoomOf, warRoomRollingOf, fitIskOf, DAY_MS, MAX_ISK };
