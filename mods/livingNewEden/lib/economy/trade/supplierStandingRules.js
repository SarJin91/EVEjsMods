"use strict";

const MICRO = 1e6;
const RAW_SCALE = 1e7;
const MAX_STANDING = 10;
const STEP = 0.1;

const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function rowValid(row, withGrants) {
  if (!row || typeof row !== "object") return false;
  if (!isNonNegInt(row.creditIsk) || !isNonNegInt(row.wtsIsk) || !isNonNegInt(row.gainMicro)) return false;
  return !withGrants || isNonNegInt(row.grants);
}

function paramsInvalid(p) {
  if (!p || typeof p !== "object") return "params";
  if (!isNum(p.iskPer01) || p.iskPer01 <= 0) return "iskPer01";
  if (!isNum(p.growthPermille) || p.growthPermille < 1000) return "growthPermille";
  if (!isNum(p.dailyCap) || p.dailyCap <= 0) return "dailyCap";
  if (!isNum(p.windowCap) || p.windowCap < 0) return "windowCap";
  if (!isNum(p.ceiling) || p.ceiling < 0 || p.ceiling > MAX_STANDING) return "ceiling";
  if (!isNum(p.minGrant) || p.minGrant < 0) return "minGrant";
  if (!isNonNegInt(p.maxGrantsPerDay)) return "maxGrantsPerDay";
  return null;
}

function planSupplierGrant(input, params) {
  if (!input || typeof input !== "object") return invalid("input");
  const s = input.standing;
  if (!isNum(s) || s < -MAX_STANDING || s > MAX_STANDING) return invalid("standing");
  if (!isNonNegInt(input.valueIsk)) return invalid("valueIsk");
  if (!rowValid(input.today, true)) return invalid("today");
  if (!rowValid(input.window, false)) return invalid("window");
  const bad = paramsInvalid(params);
  if (bad !== null) return invalid(bad);

  const V = input.valueIsk;
  const creditIsk = V;
  if (s >= params.ceiling || s >= MAX_STANDING) return { ok: true, outcome: "CEILING", creditIsk };
  if (params.maxGrantsPerDay > 0 && input.today.grants >= params.maxGrantsPerDay) {
    return { ok: true, outcome: "DAILY_COUNT", creditIsk };
  }

  const D = params.dailyCap;
  const iskPer01 = params.iskPer01 * Math.pow(params.growthPermille / 1000, Math.max(0, s));
  const k = STEP / iskPer01;
  const creditWindow = input.window.creditIsk + input.today.creditIsk;
  const wtsWindow = input.window.wtsIsk + input.today.wtsIsk;
  const net = Math.max(0, Math.min(input.today.creditIsk + V, creditWindow + V - wtsWindow));
  const gDay = D * (1 - Math.exp(-k * net / D));
  const gainToday = input.today.gainMicro / MICRO;
  const due = gDay - gainToday;
  const roomWindow = params.windowCap > 0 ? params.windowCap - input.window.gainMicro / MICRO - gainToday : Infinity;
  const roomCeil = params.ceiling - s;
  const delta = Math.min(due, roomWindow, roomCeil);

  const floor = Math.max(params.minGrant, 1 / MICRO);
  if (!(delta >= floor)) {
    if (roomWindow < floor && roomWindow <= due) return { ok: true, outcome: "WINDOW_CAP", creditIsk };
    if (roomCeil < floor && roomCeil <= due) return { ok: true, outcome: "CEILING", creditIsk };
    return { ok: true, outcome: "CARRY", creditIsk };
  }
  const gainMicro = Math.round(delta * MICRO);
  const rawChange = Math.round((delta / (MAX_STANDING - s)) * RAW_SCALE) / RAW_SCALE;
  if (!(gainMicro > 0) || !(rawChange > 0)) return { ok: true, outcome: "CARRY", creditIsk };
  return { ok: true, outcome: "GRANT", gainMicro, rawChange, creditIsk };
}

function maxRawOf(dailyCap, ceiling) {
  return dailyCap / Math.max(STEP, MAX_STANDING - ceiling) + 1 / RAW_SCALE;
}

module.exports = { planSupplierGrant, maxRawOf, MICRO };
