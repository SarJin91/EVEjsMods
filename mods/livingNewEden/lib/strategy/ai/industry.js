"use strict";

const { affordableRuns } = require("./production");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const MINING_ROLE = "mining";
const LOGISTICS_ROLE = "logistics";
const INDUSTRIAL = "industrial";
const FREIGHTER = "freighter";
const JUMP_FREIGHTER = "jump_freighter";
const REQUIRED = "required";
const READY = "ready";
const UPGRADE = "FLEET_UPGRADE";
const GROUP_PREFIX = "group:";
const PERMILLE = 1000;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const count = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function orderOf(groups) {
  const index = new Map((Array.isArray(groups) ? groups : []).map((g, i) => [g, i]));
  const at = (g) => (index.has(g) ? index.get(g) : Number.MAX_SAFE_INTEGER);
  return (a, b) => at(a) - at(b) || byId(a, b);
}

function listOf(map, order) {
  return Object.keys(map).filter((g) => map[g] > 0).sort(order).map((g) => ({ hullGroup: g, count: map[g] }));
}

function mapOf(composition) {
  const out = {};
  for (const e of Array.isArray(composition) ? composition : []) {
    if (!e || typeof e.hullGroup !== "string" || count(e.count) === 0) continue;
    out[e.hullGroup] = (out[e.hullGroup] || 0) + e.count;
  }
  return out;
}

function composeMiningFleet(pool, p) {
  const have = (g) => count(pool && pool[g]);
  const paid = {};
  const booster = (p.boosterOrder || []).find((g) => have(g) >= 1) || null;
  if (booster) paid[booster] = 1;
  let slots = booster ? count(p.boostedMiners && p.boostedMiners[booster]) : count(p.minersPerFleetBase);
  for (const g of p.minerOrder || []) {
    if (slots <= 0) break;
    const n = Math.min(have(g), slots);
    if (n <= 0) continue;
    paid[g] = (paid[g] || 0) + n;
    slots -= n;
  }
  const all = { ...paid };
  if (slots > 0 && typeof p.freeMiner === "string") all[p.freeMiner] = (all[p.freeMiner] || 0) + slots;
  const composition = listOf(all, orderOf(p.hullGroups));
  return { composition, paid, ships: composition.reduce((n, e) => n + e.count, 0), booster };
}

function poolRate(pool, n, p) {
  const left = { ...pool };
  let sum = 0n;
  for (let i = 0; i < n; i += 1) {
    const c = composeMiningFleet(left, p);
    if (c.ships === 0) break;
    sum += p.fleetRate(c.composition);
    for (const g of Object.keys(c.paid)) left[g] = count(left[g]) - c.paid[g];
  }
  return sum;
}

function recipeCost(recipe) {
  let n = 0;
  for (const k of Object.keys((recipe && recipe.minerals) || {})) n += count(recipe.minerals[k]);
  return n;
}

function planIndustry(snapshot, params, combat, mining, opts) {
  const none = { intents: [], notes: [] };
  const X = params.industry;
  const P = params.production;
  const pr = snapshot.production;
  if (!X || !P || X.industryEnabled !== true || !(X.maxIndustryJobsPerReview > 0)) return none;
  if (!pr || pr.mode !== READY || pr.truncated === true || snapshot.stationsMode !== READY) return none;
  if (snapshot.faction.status !== ACTIVE) return none;
  const recipes = pr.recipes || {};
  const order = orderOf(P.hullGroups);
  const industry = new Set(X.industryGroups || []);
  const combatIntents = ((combat && combat.intents) || []).filter((i) => i.type === "PRODUCE");
  let factionJobs = count(pr.activeJobsTotal) + combatIntents.length;
  let industryJobs = combatIntents.filter((i) => industry.has(i.hullGroup)).length;
  const pool = {};
  const stations = (pr.stations || []).map((s) => {
    const jobs = s.activeJobs || [];
    for (const j of jobs) {
      if (industry.has(j.hullGroup)) industryJobs += 1;
      if (X.miningGroups.includes(j.hullGroup)) pool[j.hullGroup] = count(pool[j.hullGroup]) + count(j.runs);
    }
    for (const g of X.miningGroups) pool[g] = count(pool[g]) + count((s.hulls || {})[g]);
    return { stationId: s.stationId, systemId: s.systemId, free: Math.max(0, count(s.lines) - jobs.length),
      minerals: { ...(s.minerals || {}) },
      ...(s.advanced ? { advanced: { ...s.advanced } } : {}) };
  });
  const spendAdvanced = (s, r, runs) => {
    if (!s.advanced || !r || !r.advanced) return;
    for (const k of Object.keys(r.advanced)) s.advanced[k] = (s.advanced[k] || 0) - r.advanced[k] * runs;
  };
  const byStation = new Map(stations.map((s) => [s.stationId, s]));
  for (const i of combatIntents) {
    const s = byStation.get(i.stationId);
    const r = recipes[i.hullGroup];
    if (!s) continue;
    s.free = Math.max(0, s.free - 1);
    for (const k of Object.keys((r && r.minerals) || {})) s.minerals[k] = (s.minerals[k] || 0) - r.minerals[k] * i.runs;
    spendAdvanced(s, r, i.runs);
  }
  const free = new Set(P.freeHullGroups || []);
  const miners = snapshot.fleets.filter((x) => x.fleetRole === MINING_ROLE);
  for (const x of miners) {
    const m = mapOf(x.composition);
    for (const g of Object.keys(m)) if (!free.has(g) && X.miningGroups.includes(g)) pool[g] = count(pool[g]) + m[g];
  }
  const intents = [];
  const notes = [];
  const slotBase = opts && Number.isSafeInteger(opts.slotBase) && opts.slotBase > 0 ? opts.slotBase : 0;
  let slot = slotBase + ((combat && combat.intents) || []).length;
  const rankBy = (fleets) => {
    const at = (systemId) => fleets.filter((x) => x.systemId === systemId || x.homeSystemId === systemId).length;
    return stations.map((s) => ({ s, k: at(s.systemId) }))
      .sort((a, b) => b.k - a.k || byId(a.s.stationId, b.s.stationId)).map((x) => x.s);
  };
  const place = (g, site, recipe) => {
    for (const m of Object.keys(recipe.minerals)) site.minerals[m] -= recipe.minerals[m];
    spendAdvanced(site, recipe, 1);
    site.free -= 1;
    factionJobs += 1;
    industryJobs += 1;
    intents.push({ type: "PRODUCE", slot: slot++, stationId: site.stationId, systemId: site.systemId, hullGroup: g,
      runs: 1, recipesVersion: pr.recipesVersion });
  };
  let budget = X.maxIndustryJobsPerReview;

  const T = X.transport;
  if (T && params.logistics) {
    const logistics = snapshot.fleets.filter((x) => x.fleetRole === LOGISTICS_ROLE);
    const have = (g) => {
      let h = 0;
      for (const s of pr.stations || []) {
        h += count((s.hulls || {})[g]);
        for (const j of s.activeJobs || []) if (j.hullGroup === g) h += count(j.runs);
      }
      for (const x of logistics) h += count(mapOf(x.composition)[g]);
      for (const i of combatIntents) if (i.hullGroup === g) h += count(i.runs);
      return h;
    };
    const g = have(FREIGHTER) < count(T.freighterTargetPerFaction) ? FREIGHTER
      : have(JUMP_FREIGHTER) < count(T.jumpFreighterTargetPerFaction) ? JUMP_FREIGHTER : null;
    const recipe = g ? recipes[g] : null;
    if (g && recipe && recipeCost(recipe) > 0) {
      if (industryJobs >= X.maxActiveIndustryJobsPerFaction || factionJobs >= P.maxActiveJobsPerFaction) {
        notes.push("INDUSTRY_JOB_LIMIT");
      } else {
        const withLine = rankBy(logistics).filter((s) => s.free > 0);
        const site = withLine.find((s) => affordableRuns(s.minerals, recipe, s.advanced) >= 1);
        if (site) {
          place(g, site, recipe);
          budget -= 1;
          notes.push(`INDUSTRY_TRANSPORT:${g}`);
        } else notes.push(withLine.length === 0 ? "INDUSTRY_LINES_BUSY" : `INDUSTRY_NO_MINERALS:${g}`);
      }
    }
  }

  const n = Math.max(miners.length, count(mining && mining.fleetsWanted));
  if (n === 0) return { intents, notes: [...new Set(notes)] };
  const ranked = rankBy(miners);
  let minedJobs = 0;
  let blocked = null;
  for (let k = 0; k < budget; k += 1) {
    if (industryJobs >= X.maxActiveIndustryJobsPerFaction || factionJobs >= P.maxActiveJobsPerFaction) {
      notes.push("INDUSTRY_JOB_LIMIT");
      break;
    }
    const base = poolRate(pool, n, X);
    const scored = [];
    for (const g of X.miningGroups) {
      const cost = recipeCost(recipes[g]);
      if (cost <= 0) continue;
      const gain = poolRate({ ...pool, [g]: count(pool[g]) + 1 }, n, X) - base;
      if (gain > 0n) scored.push({ g, gain, cost: BigInt(cost) });
    }
    if (scored.length === 0) {
      notes.push("INDUSTRY_SATURATED");
      break;
    }
    scored.sort((a, b) => {
      const l = a.gain * b.cost;
      const r = b.gain * a.cost;
      return l > r ? -1 : l < r ? 1 : order(a.g, b.g);
    });
    let placed = null;
    const withLine = ranked.filter((s) => s.free > 0);
    if (withLine.length === 0) {
      notes.push("INDUSTRY_LINES_BUSY");
      break;
    }
    for (const c of scored) {
      const recipe = recipes[c.g];
      const site = withLine.find((s) => affordableRuns(s.minerals, recipe, s.advanced) >= 1);
      if (site) {
        placed = { g: c.g, site, recipe };
        break;
      }
    }
    if (!placed) {
      if (minedJobs === 0) {
        notes.push(`INDUSTRY_NO_MINERALS:${scored[0].g}`);
        blocked = { hullGroup: scored[0].g, stationId: withLine[0].stationId };
      }
      break;
    }
    const { g, site, recipe } = placed;
    place(g, site, recipe);
    minedJobs += 1;
    pool[g] = count(pool[g]) + 1;
    notes.push(`INDUSTRY_PRODUCE:${g}`);
  }
  return { intents, notes: [...new Set(notes)], ...(blocked ? { blocked } : {}) };
}

function minerPriorityOf(snapshot, params, mining) {
  const off = { on: false, paid: 0, slots: 0 };
  const X = params.industry;
  const P = params.production;
  const pr = snapshot.production;
  if (!X || !P || P.minerPriorityEnabled !== true || X.industryEnabled !== true) return off;
  if (!pr || pr.mode !== READY || pr.truncated === true) return off;
  if (!(X.maxIndustryJobsPerReview > 0) || snapshot.stationsMode !== READY) return off;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE || snapshot.fleetsTruncated === true) return off;
  const groups = new Set(X.miningGroups || []);
  const free = new Set(P.freeHullGroups || []);
  const paidGroup = (g) => groups.has(g) && !free.has(g);
  let paid = 0;
  for (const s of pr.stations || []) {
    for (const j of s.activeJobs || []) if (paidGroup(j.hullGroup)) paid += count(j.runs);
    const hulls = s.hulls || {};
    for (const g of Object.keys(hulls)) if (paidGroup(g)) paid += count(hulls[g]);
  }
  const miners = (snapshot.fleets || []).filter((x) => x.fleetRole === MINING_ROLE);
  for (const x of miners) {
    const m = mapOf(x.composition);
    for (const g of Object.keys(m)) if (paidGroup(g)) paid += m[g];
  }
  const slots = Math.max(miners.length, count(mining && mining.fleetsWanted)) * count(X.minersPerFleetBase);
  return { on: slots > 0 && paid * PERMILLE < slots * count(P.minerFloorPermille), paid, slots };
}

function reserveForIndustry(production, industryIntents, blocked, reserveRuns) {
  const recipes = (production && production.recipes) || {};
  const produce = (industryIntents || []).filter((i) => i && i.type === "PRODUCE");
  const runs = count(reserveRuns);
  const kept = blocked && runs > 0 ? recipes[blocked.hullGroup] : null;
  const reserve = [];
  const stations = ((production && production.stations) || []).map((s) => {
    const minerals = { ...(s.minerals || {}) };
    const activeJobs = [...(s.activeJobs || [])];
    for (const i of produce) {
      if (i.stationId !== s.stationId) continue;
      const r = recipes[i.hullGroup];
      for (const k of Object.keys((r && r.minerals) || {})) {
        minerals[k] = Math.max(0, (minerals[k] || 0) - r.minerals[k] * count(i.runs));
      }
      activeJobs.push({ hullGroup: i.hullGroup, runs: count(i.runs) });
    }
    if (kept && kept.minerals && s.stationId === blocked.stationId) {
      const held = {};
      let total = 0;
      for (const k of Object.keys(kept.minerals).sort()) {
        const n = Math.min(Math.max(0, minerals[k] || 0), count(kept.minerals[k]) * runs);
        held[k] = n;
        total += n;
        minerals[k] = Math.max(0, (minerals[k] || 0) - n);
      }
      if (total > 0) reserve.push({ stationId: s.stationId, minerals: held });
    }
    return { ...s, minerals, activeJobs };
  });
  return { production: { ...production, stations, activeJobsTotal: count(production && production.activeJobsTotal)
    + produce.length }, reserve };
}

function logisticsUpgradeOf(fleet, stationIds, V, ledger) {
  const have = mapOf(fleet.composition);
  const industrials = count(have[INDUSTRIAL]);
  const capitals = V.capitalCarrierGroups || [];
  if (industrials === 0 || capitals.some((g) => count(have[g]) > 0)) return null;
  const cap = (g) => count(V.capacityM3[g]);
  const sorted = [...(stationIds || [])].sort(byId);
  for (const capital of capitals) {
    const stationId = sorted.find((id) => ledger.available(id, capital) >= 1);
    if (stationId === undefined) continue;
    if (!(cap(capital) > industrials * cap(INDUSTRIAL))) return null;
    return { stationId, capital, industrials };
  }
  return null;
}

function planUpgrades(snapshot, params, ledger, opts) {
  const none = { intents: [], notes: [], fleetIds: [] };
  const X = params.industry;
  const P = params.production;
  const pr = snapshot.production;
  if (!X || !P || !(X.maxUpgradesPerReview > 0) || !ledger || ledger.policy !== REQUIRED) return none;
  if (snapshot.fleetsTruncated === true || snapshot.stationsMode !== READY || !pr || pr.mode !== READY) return none;
  const order = orderOf(P.hullGroups);
  const free = new Set(P.freeHullGroups || []);
  const busy = new Set((snapshot.mining && snapshot.mining.busyFleetIds) || []);
  const stationsBySystem = new Map();
  for (const s of pr.stations || []) {
    const list = stationsBySystem.get(s.systemId) || [];
    list.push(s.stationId);
    stationsBySystem.set(s.systemId, list);
  }
  const lg = snapshot.logistics;
  const L = params.logistics;
  const logisticsOk = Boolean(L && L.volumes && L.volumes.capacityM3 && lg && lg.mode === READY
    && lg.truncated !== true);
  const lgBusy = new Set((lg && lg.busyFleetIds) || []);
  const standing = (x) => x.state === IDLE && x.refitPending !== true
    && (x.operationId === null || x.operationId === undefined) && stationsBySystem.has(x.systemId);
  const candidates = snapshot.fleets.filter((x) => standing(x) && ((x.fleetRole === MINING_ROLE && !busy.has(x.fleetId))
    || (logisticsOk && x.fleetRole === LOGISTICS_ROLE && !lgBusy.has(x.fleetId))))
    .sort((a, b) => byId(a.fleetId, b.fleetId));
  const intents = [];
  const notes = [];
  const limited = Boolean(opts) && Number.isSafeInteger(opts.maxGrowth);
  let growthLeft = limited ? Math.max(0, opts.maxGrowth) : 0;
  for (const x of candidates) {
    if (x.fleetRole === LOGISTICS_ROLE) {
      const up = logisticsUpgradeOf(x, stationsBySystem.get(x.systemId), L.volumes, ledger);
      if (!up) continue;
      if (intents.length >= X.maxUpgradesPerReview) {
        notes.push("FLEET_UPGRADE_LIMIT");
        break;
      }
      ledger.take(up.stationId, [{ itemKey: `${GROUP_PREFIX}${up.capital}`, count: 1 }]);
      intents.push({ type: UPGRADE, slot: intents.length, fleetId: x.fleetId, expectedVersion: x.version,
        fleetRole: LOGISTICS_ROLE, stationId: up.stationId, systemId: x.systemId,
        add: [{ hullGroup: up.capital, count: 1 }], remove: [{ hullGroup: INDUSTRIAL, count: up.industrials }] });
      notes.push("FLEET_UPGRADE_LOGISTICS");
      continue;
    }
    const have = mapOf(x.composition);
    const kept = {};
    for (const g of Object.keys(have)) if (!free.has(g)) kept[g] = have[g];
    let best = null;
    for (const stationId of [...stationsBySystem.get(x.systemId)].sort(byId)) {
      const pool = { ...kept };
      for (const g of X.miningGroups) if (!free.has(g)) pool[g] = count(pool[g]) + ledger.available(stationId, g);
      const c = composeMiningFleet(pool, X);
      const target = mapOf(c.composition);
      for (const g of Object.keys(kept)) target[g] = Math.max(target[g] || 0, kept[g]);
      const ships = Object.keys(target).reduce((n, g) => n + target[g], 0);
      if (Number.isSafeInteger(X.maxShipsPerFleet) && ships > X.maxShipsPerFleet) continue;
      const rate = X.fleetRate(listOf(target, order));
      if (best === null || rate > best.rate) best = { stationId, target, rate };
    }
    if (!best || !(best.rate > X.fleetRate(listOf(have, order)))) continue;
    const add = {};
    const remove = {};
    for (const g of new Set([...Object.keys(have), ...Object.keys(best.target)])) {
      const d = (best.target[g] || 0) - (have[g] || 0);
      if (d > 0) add[g] = d;
      else if (d < 0) remove[g] = -d;
    }
    const paidAdd = listOf(add, order).filter((e) => !free.has(e.hullGroup));
    if (paidAdd.length === 0) continue;
    const sum = (m) => Object.keys(m).reduce((n, g) => n + m[g], 0);
    const growth = sum(add) - sum(remove);
    if (limited && growth > growthLeft) {
      if (!notes.includes("UPGRADE_DEFICIT")) notes.push("UPGRADE_DEFICIT");
      continue;
    }
    if (intents.length >= X.maxUpgradesPerReview) {
      notes.push("FLEET_UPGRADE_LIMIT");
      break;
    }
    if (limited && growth > 0) growthLeft -= growth;
    ledger.take(best.stationId, paidAdd.map((e) => ({ itemKey: `${GROUP_PREFIX}${e.hullGroup}`, count: e.count })));
    intents.push({ type: UPGRADE, slot: intents.length, fleetId: x.fleetId, expectedVersion: x.version,
      fleetRole: MINING_ROLE, stationId: best.stationId, systemId: x.systemId, add: listOf(add, order),
      remove: listOf(remove, order) });
    notes.push("FLEET_UPGRADE");
  }
  return { intents, notes, fleetIds: intents.map((i) => i.fleetId) };
}

module.exports = { composeMiningFleet, poolRate, planIndustry, planUpgrades, recipeCost, minerPriorityOf,
  reserveForIndustry };
