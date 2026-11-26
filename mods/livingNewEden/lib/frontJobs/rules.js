"use strict";

const { KIND, MAX_DESCRIPTION } = require("./schema");
const { UNKNOWN } = require("../names/fallback");

const HOUR_MS = 3600000;
const DAY_MS = 86400000;
const MICRO = 1000000;

function boardDayOf(nowMs, resetHourUtc) {
  return Math.floor((nowMs - resetHourUtc * HOUR_MS) / DAY_MS);
}

function boardWindowOf(day, resetHourUtc) {
  const startMs = day * DAY_MS + resetHourUtc * HOUR_MS;
  return { startMs, endMs: startMs + DAY_MS };
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const REWARD_PREFIX = Object.freeze({ [KIND.KILL]: "kill", [KIND.CLEAR]: "clear", [KIND.DELIVER]: "deliver",
  [KIND.SCAN]: "scan", [KIND.ESCORT]: "escort" });

function issuerOf(front) {
  if (!front || !isId(front.controllerFactionId)) return null;
  if (isId(front.occupierFactionId) && front.occupierFactionId !== front.controllerFactionId) {
    return front.occupierFactionId;
  }
  if (isId(front.previousControllerFactionId) && front.previousControllerFactionId !== front.controllerFactionId) {
    return front.previousControllerFactionId;
  }
  return null;
}

function pickJobs(fronts, params, rng, hasLp) {
  const seen = new Set();
  const candidates = [];
  for (const f of Array.isArray(fronts) ? fronts : []) {
    if (!f || !isId(f.systemId) || seen.has(f.systemId)) continue;
    const issuer = issuerOf(f);
    if (issuer === null) continue;
    seen.add(f.systemId);
    candidates.push({ systemId: f.systemId, regionId: isId(f.regionId) ? f.regionId : null,
      issuerFactionId: issuer, targetFactionId: f.controllerFactionId,
      weight: hasLp(issuer) === true ? params.empireIssuerWeight : 1 });
  }
  candidates.sort((a, b) => a.systemId - b.systemId);
  const out = [];
  while (out.length < params.jobsPerDay && candidates.length > 0) {
    const total = candidates.reduce((s, c) => s + c.weight, 0);
    let r = rng.nextFloat() * total;
    let i = 0;
    while (i < candidates.length - 1 && r >= candidates[i].weight) {
      r -= candidates[i].weight;
      i += 1;
    }
    const c = candidates.splice(i, 1)[0];
    out.push({ slot: out.length, kind: KIND.KILL, issuerFactionId: c.issuerFactionId,
      targetFactionId: c.targetFactionId, systemId: c.systemId, regionId: c.regionId, targetCount: params.killTarget });
  }
  return out;
}

function rewardOf(kind, issuerFactionId, params) {
  const lpCorp = params.lpCorpOf(issuerFactionId);
  const lpCorporationId = isId(lpCorp) ? lpCorp : null;
  const amount = (name) => (Number.isSafeInteger(params[name]) && params[name] > 0 ? params[name] : 0);
  const prefix = REWARD_PREFIX[kind] || null;
  const isk = prefix ? amount(`${prefix}Isk`) : 0;
  const lp = prefix && lpCorporationId !== null ? amount(`${prefix}Lp`) : 0;
  return { iskAmount: isk, lpAmount: lp, lpCorporationId,
    standingMicro: Math.max(0, Math.round(params.standingRaw * MICRO)) };
}

function descriptionOf(job, names) {
  const nameOr = (fn, id) => {
    const n = typeof fn === "function" ? fn(id) : null;
    return typeof n === "string" && n !== "" ? n : String(id);
  };
  const system = nameOr(names && names.system, job.systemId);
  const issuer = nameOr(names && names.faction, job.issuerFactionId);
  if (job.kind === KIND.CLEAR) {
    const label = typeof job.label === "string" && job.label !== "" ? job.label : "a site";
    return `Clear ${label} in ${system} for ${issuer}`.slice(0, MAX_DESCRIPTION);
  }
  if (job.kind === KIND.DELIVER) {
    const n = typeof job.typeName === "string" && job.typeName !== "" ? job.typeName : UNKNOWN.item;
    return `Deliver ${job.quantity} ${n} to ${system} for ${issuer}`.slice(0, MAX_DESCRIPTION);
  }
  if (job.kind === KIND.SCAN) return `Scan a signature in ${system} for ${issuer}`.slice(0, MAX_DESCRIPTION);
  if (job.kind === KIND.ESCORT) {
    return `Escort ${job.targetCount} convoy jumps for ${issuer}`.slice(0, MAX_DESCRIPTION);
  }
  const target = nameOr(names && names.faction, job.targetFactionId);
  const text = `Kill ${job.targetCount} ${target} rats in ${system} for ${issuer}`;
  return text.slice(0, MAX_DESCRIPTION);
}

function drawUpTo(items, limit, rng) {
  const pool = [...items];
  const out = [];
  while (out.length < limit && pool.length > 0) out.push(pool.splice(rng.nextInt(0, pool.length - 1), 1)[0]);
  return out;
}

module.exports = { boardDayOf, boardWindowOf, issuerOf, pickJobs, rewardOf, descriptionOf, drawUpTo, DAY_MS };
