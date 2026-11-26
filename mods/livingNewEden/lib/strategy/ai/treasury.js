"use strict";

const { adminDailyOf, warRoomOf, warRoomRollingOf } = require("./warChest");
const { homeYieldOf } = require("./invaderEconomy");

const DAY_MS = 86400000;
const MAX_ISK = 1e15;
const PERMILLE = 1000;
const AUSTERITY = "AUSTERITY";

function perPeriod(daily, P) {
  const q = Math.floor(daily / DAY_MS);
  const r = daily % DAY_MS;
  return q * P + Math.floor((r * P) / DAY_MS);
}

function permilleOf(value, permille) {
  return Math.floor(value / PERMILLE) * permille + Math.floor(((value % PERMILLE) * permille) / PERMILLE);
}

const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function feeOf(runs, value, permille) {
  return permilleOf(Math.min(MAX_ISK, count(runs) * count(value)), count(permille));
}

const capitalized = (kind) => `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;

function byKind(T, prefix, kind) {
  const v = typeof kind === "string" && kind !== "" ? T[`${prefix}${capitalized(kind)}`] : undefined;
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

function fleetValueOf(fleets, valueByGroup) {
  let total = 0;
  for (const fleet of Array.isArray(fleets) ? fleets : []) {
    for (const e of Array.isArray(fleet.composition) ? fleet.composition : []) {
      const v = valueByGroup && Number.isSafeInteger(valueByGroup[e.hullGroup]) ? valueByGroup[e.hullGroup] : 0;
      const n = Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 0;
      total = Math.min(MAX_ISK, total + Math.min(MAX_ISK, n * v));
    }
  }
  return total;
}

function readyOf(snapshot, params) {
  const T = params && params.treasury;
  const tr = snapshot && snapshot.treasury;
  return T && tr && tr.mode === "ready" ? { T, tr } : null;
}

const invaderOf = (params) => (params && params.invaderEconomy) || null;

function roundOf(snapshot, T, tr, E) {
  const P = T.periodMs;
  const at = snapshot.at;
  const notes = [];
  const seeded = tr.seeded === true;
  const anchor = !seeded || tr.paidUntil === null || tr.paidUntil === undefined;
  const paidUntilFrom = anchor ? null : tr.paidUntil;
  let periods = 0;
  let charged = 0;
  let paidUntilTo;
  if (anchor) {
    paidUntilTo = Math.floor(at / P) * P;
    notes.push("TREASURY_ANCHOR");
  } else {
    periods = Math.max(0, Math.floor((at - paidUntilFrom) / P));
    charged = Math.min(periods, T.maxCatchUpPeriods);
    if (periods > charged) notes.push(`TREASURY_FORGIVEN:${periods - charged}`);
    paidUntilTo = paidUntilFrom + periods * P;
  }
  const u = snapshot.upkeep;
  const territory = Boolean(u && u.mode === "ready");
  const base = E && Number.isSafeInteger(E.baseIncomeIskPerDay) && E.baseIncomeIskPerDay > 0
    ? E.baseIncomeIskPerDay : byKind(T, "baseIncomeIskPerDay", tr.kind);
  const daily = base + (territory
    ? T.incomeIskPerSystemPerDay * Math.max(0, u.controlledCount || 0)
      + T.incomeIskPerStationPerDay * Math.max(0, u.stationCount || 0) : 0)
    + (E ? homeYieldOf(u, E).iskDaily : 0);
  if (!territory && charged > 0) notes.push("TREASURY_NO_TERRITORY_READ");
  const incomeDaily = Math.min(MAX_ISK, daily);
  const incomePerPeriod = perPeriod(incomeDaily, P);
  const fleetValue = fleetValueOf(snapshot.fleets, tr.valueByGroup);
  const upkeepDaily = permilleOf(fleetValue, T.fleetUpkeepPermillePerDay);
  const upkeepPerPeriod = perPeriod(upkeepDaily, P);
  const out = { notes, seeded, anchor, paidUntilFrom, periods, charged, paidUntilTo, incomePerPeriod, upkeepPerPeriod,
    fleetValue, income: Math.min(MAX_ISK, incomePerPeriod * charged),
    fleetUpkeep: Math.min(MAX_ISK, upkeepPerPeriod * charged), incomeDaily, upkeepDaily };
  if (T.pressureEnabled === true) {
    const captured = territory && Array.isArray(u.captured) ? u.captured.length : 0;
    if (territory && u.capturedTruncated === true) notes.push("TREASURY_ADMIN_TRUNCATED");
    out.adminDaily = adminDailyOf(captured, T);
    out.adminPerPeriod = perPeriod(out.adminDaily, P);
    out.admin = Math.min(MAX_ISK, out.adminPerPeriod * charged);
  }
  return out;
}

function projectTreasury(snapshot, params) {
  const ready = readyOf(snapshot, params);
  if (!ready) return null;
  const { T, tr } = ready;
  const r = roundOf(snapshot, T, tr, invaderOf(params));
  const start = r.seeded ? count(tr.balanceIsk) : count(tr.initialIsk);
  const gross = Math.min(MAX_ISK, start + r.income);
  const costs = Math.min(MAX_ISK, r.fleetUpkeep + (r.admin || 0));
  const valueByGroup = tr.valueByGroup || {};
  return { austerity: tr.accountMode === AUSTERITY, projectedIsk: gross - Math.min(gross, costs),
    valueByGroup, feePermille: count(T.productionFeePermille),
    minJobsWhenBroke: count(T.minJobsWhenBroke), jobsPermille: count(T.austerityJobsPermille),
    austerityEnterIsk: permilleOf(count(tr.initialIsk), count(T.austerityEnterPermille)),
    war: warOf(snapshot, T, tr, r, start, valueByGroup) };
}

function warOf(snapshot, T, tr, r, start, valueByGroup) {
  if (T.pressureEnabled !== true) return null;
  const rolling = T.warRoomRollingEnabled === true;
  const x = { balanceIsk: start, incomeDaily: r.incomeDaily, fleetUpkeepDaily: r.upkeepDaily,
    adminDaily: r.adminDaily || 0, at: snapshot.at, today: tr.today || null };
  const w = rolling ? warRoomRollingOf({ ...x, yesterday: tr.yesterday || null }, T) : warRoomOf(x, T);
  return { room: w.room, dayBudget: w.dayBudget, spentToday: w.spentToday,
    ...(rolling ? { spentWindow: w.spentWindow } : {}), captureIsk: count(T.captureLaunchIsk),
    fitPermille: count(T.mobilizeFitPermille),
    productionCap: permilleOf(w.room, count(T.productionRoomSharePermille)), valueByGroup };
}

function cutJobs(m, permille) {
  return Number.isSafeInteger(m) && m > 0 ? Math.max(1, Math.floor((m * permille) / PERMILLE)) : m;
}

function austerityParams(params, proj) {
  if (!proj || proj.austerity !== true) return params;
  const out = { ...params };
  if (params.production) {
    out.production = { ...params.production,
      maxJobsPerReview: cutJobs(params.production.maxJobsPerReview, proj.jobsPermille) };
  }
  if (params.industry) {
    out.industry = { ...params.industry,
      maxIndustryJobsPerReview: cutJobs(params.industry.maxIndustryJobsPerReview, proj.jobsPermille) };
  }
  return out;
}

function createFeeLedger(proj, warCap) {
  if (!proj) return { cap: (plan) => plan, capOverRoom: (plan) => plan, used: () => 0 };
  let balance = Math.max(0, proj.projectedIsk);
  let remaining = typeof warCap === "number" && !Number.isNaN(warCap) ? Math.min(balance, Math.max(0, warCap)) : balance;
  let fees = 0;
  let kept = 0;
  let brokeNoted = false;
  let warNoted = false;
  const pay = (isk) => { balance = Math.max(0, balance - isk); };
  const warBound = (perRun) => perRun <= balance;
  const keep = (i) => { if (i.ladder !== true) kept += 1; };
  function cap(plan) {
    const intents = [];
    const notes = [];
    for (const i of plan.intents) {
      if (i.type !== "PRODUCE") {
        intents.push(i);
        continue;
      }
      const perRun = feeOf(1, proj.valueByGroup[i.hullGroup], proj.feePermille);
      if (perRun === 0 || perRun * i.runs <= remaining) {
        remaining -= perRun * i.runs;
        pay(perRun * i.runs);
        fees = Math.min(MAX_ISK, fees + perRun * i.runs);
        keep(i);
        intents.push(i);
        continue;
      }
      const affordable = Math.floor(remaining / perRun);
      if (affordable >= 1) {
        remaining -= perRun * affordable;
        pay(perRun * affordable);
        fees = Math.min(MAX_ISK, fees + perRun * affordable);
        keep(i);
        intents.push({ ...i, runs: affordable });
        notes.push(`TREASURY_FEE_CUT:${i.hullGroup}`);
      } else if (i.ladder === true) {
        if (warBound(perRun)) notes.push(`LADDER_WAR_ROOM_SHORT:${i.hullGroup}`);
        else notes.push(`LADDER_FEE_SHORT:${i.hullGroup}`);
      } else if (kept < proj.minJobsWhenBroke) {
        fees = Math.min(MAX_ISK, fees + perRun);
        remaining = 0;
        pay(perRun);
        kept += 1;
        intents.push({ ...i, runs: 1 });
      } else if (warBound(perRun)) {
        if (!warNoted) {
          warNoted = true;
          notes.push("TREASURY_WAR_ROOM_FEE_CAP");
        }
      } else if (!brokeNoted) {
        brokeNoted = true;
        notes.push("TREASURY_FEE_BROKE");
      }
    }
    return { ...plan, intents, notes: [...plan.notes, ...notes] };
  }
  const floor = count(proj.austerityEnterIsk);
  function capOverRoom(plan) {
    const intents = [];
    const notes = [];
    for (const i of plan.intents) {
      if (i.type !== "PRODUCE" || i.ladder !== true) {
        intents.push(i);
        continue;
      }
      const fee = Math.min(MAX_ISK, feeOf(1, proj.valueByGroup[i.hullGroup], proj.feePermille) * count(i.runs));
      if (fee <= Math.max(0, balance - floor)) {
        pay(fee);
        remaining = Math.max(0, remaining - fee);
        fees = Math.min(MAX_ISK, fees + fee);
        keep(i);
        intents.push(i);
        notes.push(`LADDER_OVER_ROOM:${i.hullGroup}`);
      } else {
        notes.push(`LADDER_FEE_UNREACHABLE:${i.hullGroup}`);
      }
    }
    return { ...plan, intents, notes: [...plan.notes, ...notes] };
  }
  return { cap, capOverRoom, used: () => fees };
}

function ladderFeeReachOf(proj, war, cls, T) {
  if (!proj || !war) return null;
  const perRun = feeOf(1, (proj.valueByGroup || {})[cls], proj.feePermille);
  if (perRun === 0) return null;
  const capFull = permilleOf(count(war.dayBudget), count((T || {}).productionRoomSharePermille));
  if (perRun <= capFull) return "ROOM";
  const floor = count(proj.austerityEnterIsk);
  return perRun <= Math.max(0, proj.projectedIsk - floor) ? "BALANCE" : "UNREACHABLE";
}

function planTreasury(snapshot, params, opts) {
  const ready = readyOf(snapshot, params);
  if (!ready) return { intents: [], notes: [], rates: null };
  const { T, tr } = ready;
  const r = roundOf(snapshot, T, tr, invaderOf(params));
  const notes = r.notes;
  const austerity = tr.accountMode === AUSTERITY;
  const produce = opts && Number.isSafeInteger(opts.produce) ? opts.produce : 0;

  let want = tr.tradeEligible === true && !austerity
    ? Math.max(0, T.tradeBudgetTargetIsk - (Number.isSafeInteger(tr.tradeHeldIsk) ? tr.tradeHeldIsk : 0)) : 0;
  const factionRoom = Math.max(0, T.tradeTransferMaxIskPerDay - (tr.factionTradeOutToday || 0));
  const galaxyRoom = Math.max(0, T.tradeTransferMaxIskPerDayGalaxy - (tr.galaxyTradeOutToday || 0));
  if (want > factionRoom) {
    want = factionRoom;
    notes.push("TREASURY_TRADE_LIMIT_FACTION");
  }
  if (want > galaxyRoom) {
    want = galaxyRoom;
    notes.push("TREASURY_TRADE_LIMIT_GALAXY");
  }
  if (austerity) notes.push("TREASURY_AUSTERITY");
  const roomLeft = opts && Number.isSafeInteger(opts.roomLeft) ? Math.max(0, opts.roomLeft) : null;
  if (roomLeft !== null && want > roomLeft) {
    want = roomLeft;
    notes.push("TREASURY_TRADE_LIMIT_WAR");
  }
  const war = opts && Number.isSafeInteger(opts.war) && opts.war > 0 ? opts.war : 0;

  const rates = { incomePerPeriod: r.incomePerPeriod, upkeepPerPeriod: r.upkeepPerPeriod, fleetValue: r.fleetValue };
  const pressure = T.pressureEnabled === true;
  if (pressure) rates.adminPerPeriod = r.adminPerPeriod;
  if (!(r.periods > 0 || want > 0 || r.anchor || produce > 0 || war > 0)) return { intents: [], notes, rates };
  return {
    intents: [{ type: "TREASURY", kind: tr.kind, seed: !r.seeded, periods: r.periods, charged: r.charged,
      paidUntilFrom: r.paidUntilFrom,
      paidUntilTo: r.periods > 0 || r.anchor ? r.paidUntilTo : r.paidUntilFrom,
      income: r.income, fleetUpkeep: r.fleetUpkeep, ...(pressure ? { admin: r.admin } : {}), tradeWantIsk: want }],
    notes,
    rates,
  };
}

module.exports = { planTreasury, projectTreasury, austerityParams, createFeeLedger, ladderFeeReachOf, feeOf,
  perPeriod };
