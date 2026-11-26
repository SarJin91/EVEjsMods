"use strict";

const { hullTargets, rankMobilizationStations, affordableRuns, poolCappedGroupsOf } = require("./production");

const READY = "ready";
const ACTIVE = "ACTIVE";
const HIGHSEC = "highsec";
const PERMILLE = 1000;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const hasOwn = (object, key) => Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);

function quotaKeyOf(cls) {
  return `ladderQuota${cls.split("_").map((w) => `${w.charAt(0).toUpperCase()}${w.slice(1)}`).join("")}`;
}

function parseFactionKindList(text, allowed) {
  if (typeof text !== "string" || !Array.isArray(allowed)) return null;
  const out = [];
  for (const raw of text.split(",")) {
    const name = raw.trim();
    if (!allowed.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return Object.freeze(out);
}

function kindsOf(value) {
  if (Array.isArray(value)) return value;
  return typeof value === "string" ? value.split(",").map((x) => x.trim()).filter((x) => x.length > 0) : [];
}

function recipePermilleOf(minerals, recipe) {
  let have = 0;
  let total = 0;
  for (const k of Object.keys(recipe.minerals)) {
    const r = count(recipe.minerals[k]);
    total += r;
    have += Math.min(Math.max(0, (minerals && minerals[k]) || 0), r);
  }
  return total > 0 ? Math.floor((have * PERMILLE) / total) : 0;
}

function reserveFrom(station, cls, recipe) {
  const minerals = {};
  let total = 0;
  for (const k of Object.keys(recipe.minerals).sort()) {
    const n = Math.min(Math.max(0, (station.minerals && station.minerals[k]) || 0), count(recipe.minerals[k]));
    minerals[k] = n;
    total += n;
  }
  return total > 0 ? { stationId: station.stationId, minerals, ladder: true, hullGroup: cls } : null;
}

function ladderReserveOf(production, stationId, cls) {
  const recipe = production && production.recipes ? production.recipes[cls] : null;
  const station = ((production && production.stations) || []).find((s) => s.stationId === stationId);
  return recipe && recipe.minerals && station ? reserveFrom(station, cls, recipe) : null;
}

function applyLadder(production, produce, reserve) {
  const recipes = (production && production.recipes) || {};
  const stations = ((production && production.stations) || []).map((s) => {
    const atProduce = produce && produce.stationId === s.stationId;
    const atReserve = reserve && reserve.stationId === s.stationId;
    if (!atProduce && !atReserve) return s;
    const minerals = { ...(s.minerals || {}) };
    const activeJobs = [...(s.activeJobs || [])];
    if (atProduce) {
      const r = recipes[produce.hullGroup];
      for (const k of Object.keys((r && r.minerals) || {})) {
        minerals[k] = Math.max(0, (minerals[k] || 0) - r.minerals[k] * count(produce.runs));
      }
      activeJobs.push({ hullGroup: produce.hullGroup, runs: count(produce.runs) });
    }
    if (atReserve) {
      for (const k of Object.keys(reserve.minerals || {})) {
        minerals[k] = Math.max(0, (minerals[k] || 0) - count(reserve.minerals[k]));
      }
    }
    return { ...s, minerals, activeJobs };
  });
  return { ...production, stations };
}

function ladderPlanOf(snapshot, params) {
  const off = (notes) => ({ on: false, cls: null, stationId: null, have: {}, quota: {}, bufferPermille: 0,
    reserve: null, produce: null, notes: notes || [] });
  const P = params && params.production;
  const pr = snapshot && snapshot.production;
  if (!P || P.capitalLadderEnabled !== true) return off();
  if (!snapshot.entry || !kindsOf(P.ladderFactionKinds).includes(snapshot.entry.kind)) return off();
  if (!pr || pr.mode !== READY || pr.truncated === true || snapshot.stationsMode !== READY) return off();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return off();
  const owned = snapshot.capitalClasses || {};
  const tiers = P.capitalTiers || {};
  const classes = (P.hullGroups || []).filter((g) => count(tiers[g]) > 0);
  if (!classes.some((c) => hasOwn(owned, c))) return off();
  if (snapshot.fleetsTruncated === true) return off(["LADDER_TRUNCATED"]);

  const have = {};
  const quota = {};
  for (const c of classes) {
    have[c] = 0;
    quota[c] = hasOwn(owned, c) ? count(P[quotaKeyOf(c)]) : 0;
  }
  for (const x of snapshot.fleets || []) {
    for (const e of (x && x.composition) || []) if (e && hasOwn(have, e.hullGroup)) have[e.hullGroup] += count(e.count);
  }
  const stations = pr.stations || [];
  for (const s of stations) {
    for (const c of classes) have[c] += count((s.hulls || {})[c]);
    for (const j of s.activeJobs || []) if (j && hasOwn(have, j.hullGroup)) have[j.hullGroup] += count(j.runs);
  }

  const desired = hullTargets(snapshot.doctrine, P);
  const recipes = pr.recipes || {};
  const chosen = rankMobilizationStations(stations, desired, recipes, new Map())
    .slice(0, Math.max(1, P.mobilizationStations || 1));
  const desiredSum = Object.keys(desired).reduce((n, g) => n + desired[g], 0) * chosen.length;
  const capped = P.ladderBufferPoolCapEnabled === true ? poolCappedGroupsOf(desired, stations, P) : null;
  const progress = chosen.reduce((n, s) => {
    let p = n + s.progress;
    if (capped) for (const g of capped) p += (s.deficit && s.deficit[g]) || 0;
    return p;
  }, 0);
  const bufferPermille = desiredSum > 0 ? Math.floor((progress * PERMILLE) / desiredSum) : PERMILLE;
  const base = { on: true, cls: null, stationId: null, have, quota, bufferPermille, reserve: null, produce: null };

  const rungs = [...new Set(classes.map((c) => tiers[c]))].sort((a, b) => a - b);
  let cls = null;
  if (bufferPermille >= P.ladderUnlockPermille) {
    for (const t of rungs) {
      const target = classes.find((c) => tiers[c] === t && have[c] < quota[c]);
      if (target) {
        cls = target;
        break;
      }
    }
  }
  if (cls === null) {
    const idleNote = classes.every((c) => have[c] >= quota[c]) ? "LADDER_FULL" : "LADDER_WAIT_BUFFER";
    return { ...base, notes: [idleNote] };
  }

  const notes = [];
  const recipe = recipes[cls];
  const byStation = new Map(stations.map((s) => [s.stationId, s]));
  const sites = chosen.map((r) => byStation.get(r.stationId))
    .filter((s) => s && (P.capitalHighsecAllowed !== false || s.secClass !== HIGHSEC));
  if (!recipe || !recipe.minerals || sites.length === 0) {
    notes.push(`LADDER_NO_SITE:${cls}`);
    return { ...base, cls, notes };
  }
  const jobOf = (s) => Number((s.activeJobs || []).some((j) => j && j.hullGroup === cls));
  const ranked = sites.map((s) => ({ s, job: jobOf(s), pm: recipePermilleOf(s.minerals, recipe) }))
    .sort((a, b) => b.job - a.job || b.pm - a.pm || byId(a.s.stationId, b.s.stationId));
  const mc = ranked[0];
  const free = count(mc.s.lines) - (mc.s.activeJobs || []).length > 0;
  const room = count(pr.activeJobsTotal) < count(P.maxActiveJobsPerFaction) && count(P.maxJobsPerReview) >= 1;
  if (free && room && affordableRuns(mc.s.minerals || {}, recipe, mc.s.advanced) >= 1) {
    notes.push(`LADDER_PRODUCE:${cls}`);
    return { ...base, cls, stationId: mc.s.stationId, notes,
      produce: { type: "PRODUCE", slot: 0, stationId: mc.s.stationId, systemId: mc.s.systemId, hullGroup: cls, runs: 1,
        recipesVersion: pr.recipesVersion, ladder: true } };
  }
  notes.push(`LADDER_SAVING:${cls}:${mc.pm}`);
  return { ...base, cls, stationId: mc.s.stationId, reserve: reserveFrom(mc.s, cls, recipe), notes };
}

module.exports = { ladderPlanOf, applyLadder, ladderReserveOf, parseFactionKindList, quotaKeyOf, recipePermilleOf };
