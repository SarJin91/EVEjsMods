"use strict";

const { bfs } = require("./bfs");

const ACTIVE = "ACTIVE";
const MINING_ROLE = "mining";
const LOGISTICS_ROLE = "logistics";
const PERMILLE = 1000;

function stockTemplatesOf(doctrine) {
  if (!doctrine) return {};
  const s = doctrine.stockTemplates;
  if (s !== null && typeof s === "object" && !Array.isArray(s)) return s;
  return doctrine.templates || {};
}

function hullRoles(doctrine, params) {
  return Object.keys(stockTemplatesOf(doctrine)).sort()
    .filter((role) => (role !== MINING_ROLE || params.miningNeedsHulls === true)
      && (role !== LOGISTICS_ROLE || params.logisticsNeedsHulls === true));
}

function huntersNeedHullsOf(config) {
  return Boolean(config && config.production && config.production.hunterHulls === true && config.hunt
    && config.hunt.enabled === true && config.hunt.maxHuntersPerFaction > 0);
}

function tributeOnOf(config) {
  return Boolean(config && config.tribute && config.tribute.enabled === true && config.logistics
    && config.logistics.enabled === true && config.logistics.convoysEnabled === true);
}

function hullsRequiredOf(doctrine, tribute, isRecipient) {
  return doctrine.hullsRequired !== false || (tribute !== null && tribute !== undefined
    && tribute.recipientBuildsHulls === true && isRecipient() === true);
}

function hullTargets(doctrine, params) {
  if (doctrine && doctrine.hullsRequired === false) return {};
  const out = {};
  const free = Array.isArray(params.freeHullGroups) ? params.freeHullGroups : [];
  const add = (template) => {
    for (const e of template) {
      if (!params.hullGroups.includes(e.hullGroup) || free.includes(e.hullGroup)) continue;
      out[e.hullGroup] = (out[e.hullGroup] || 0) + e.count * params.targetStockFleets;
    }
  };
  const source = stockTemplatesOf(doctrine);
  for (const role of hullRoles(doctrine, params)) {
    const template = source[role];
    if (!Array.isArray(template)) continue;
    add(template);
  }
  if (params.huntersNeedHulls === true && doctrine && doctrine.fieldsHunters === true
    && Array.isArray(doctrine.hunterTemplate)) add(doctrine.hunterTemplate);
  for (const g of Object.keys(out)) if (!(out[g] > 0)) delete out[g];
  return out;
}

function templateNeedOf(doctrine, params) {
  if (doctrine && doctrine.hullsRequired === false) return {};
  const out = {};
  const groups = Array.isArray(params.hullGroups) ? params.hullGroups : [];
  const free = Array.isArray(params.freeHullGroups) ? params.freeHullGroups : [];
  const add = (template) => {
    const one = {};
    for (const e of template) {
      if (!e || !groups.includes(e.hullGroup) || free.includes(e.hullGroup)) continue;
      one[e.hullGroup] = (one[e.hullGroup] || 0) + e.count;
    }
    for (const g of Object.keys(one)) if (one[g] > (out[g] || 0)) out[g] = one[g];
  };
  const source = stockTemplatesOf(doctrine);
  for (const role of hullRoles(doctrine, params)) {
    const template = source[role];
    if (!Array.isArray(template)) continue;
    add(template);
  }
  if (params.huntersNeedHulls === true && doctrine && doctrine.fieldsHunters === true
    && Array.isArray(doctrine.hunterTemplate)) add(doctrine.hunterTemplate);
  for (const g of Object.keys(out)) if (!(out[g] > 0)) delete out[g];
  return out;
}

function stationDeficit(desired, hulls, jobs) {
  const have = {};
  for (const g of Object.keys(hulls || {})) have[g] = (have[g] || 0) + hulls[g];
  for (const j of jobs || []) have[j.hullGroup] = (have[j.hullGroup] || 0) + j.runs;
  let progress = 0;
  const deficit = {};
  for (const g of Object.keys(desired)) {
    progress += Math.min(have[g] || 0, desired[g]);
    const d = desired[g] - (have[g] || 0);
    if (d > 0) deficit[g] = d;
  }
  return { have, progress, deficit };
}

function affordableRuns(minerals, recipe, advanced) {
  const keys = Object.keys(recipe.minerals);
  const runs = Math.min(...keys.map((k) => Math.floor((minerals[k] || 0) / recipe.minerals[k])));
  const adv = advanced && recipe.advanced ? Object.keys(recipe.advanced) : [];
  if (adv.length === 0) return runs;
  return Math.min(runs, ...adv.map((k) => Math.floor((advanced[k] || 0) / recipe.advanced[k])));
}

function spendAdvanced(s, recipe, runs) {
  if (!s.advanced || !recipe.advanced) return;
  for (const k of Object.keys(recipe.advanced)) s.advanced[k] = (s.advanced[k] || 0) - recipe.advanced[k] * runs;
}

function rankMobilizationStations(stations, desired, recipes, dist) {
  const far = Number.MAX_SAFE_INTEGER;
  return stations.filter((s) => s.lines > 0).map((s) => {
    const jobs = s.activeJobs || [];
    const sd = stationDeficit(desired, s.hulls, jobs);
    const x = { stationId: s.stationId, systemId: s.systemId, free: Math.max(0, s.lines - jobs.length),
      minerals: { ...(s.minerals || {}) }, progress: sd.progress, deficit: sd.deficit,
      jumps: dist && dist.has(s.systemId) ? dist.get(s.systemId) : far,
      ...(s.advanced ? { advanced: { ...s.advanced } } : {}) };
    const affordable = Object.keys(x.deficit).some((g) => recipes[g] && recipes[g].minerals
      && affordableRuns(x.minerals, recipes[g], x.advanced) >= 1);
    x.alive = jobs.length > 0 || affordable || Object.keys(x.deficit).length === 0;
    x.canBuild = x.free > 0 && affordable;
    return x;
  }).sort((a, b) => Number(b.alive) - Number(a.alive) || b.progress - a.progress
    || Number(b.canBuild) - Number(a.canBuild) || a.jumps - b.jumps
    || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0));
}

function poolCappedDeficit(totalDeficit, desired, stations, P, releaseOf) {
  if (!P || P.poolCapEnabled !== true || !(Number.isSafeInteger(P.poolCapStations) && P.poolCapStations >= 1)) {
    return { deficit: totalDeficit, capped: [], released: [], reach: null };
  }
  const list = Array.isArray(stations) ? stations : [];
  const ownOf = (s, g) => {
    let n = 0;
    const hulls = (s && s.hulls) || {};
    if (hulls[g] > 0) n += hulls[g];
    for (const j of (s && Array.isArray(s.activeJobs)) ? s.activeJobs : []) {
      if (j && j.hullGroup === g && j.runs > 0) n += j.runs;
    }
    return n;
  };
  const have = {};
  for (const s of list) {
    const hulls = (s && s.hulls) || {};
    for (const g of Object.keys(hulls)) if (hulls[g] > 0) have[g] = (have[g] || 0) + hulls[g];
    for (const j of (s && Array.isArray(s.activeJobs)) ? s.activeJobs : []) {
      if (j && j.runs > 0) have[j.hullGroup] = (have[j.hullGroup] || 0) + j.runs;
    }
  }
  const releaseOn = P.poolCapReleaseEnabled === true && typeof releaseOf === "function";
  let ctx = null;
  const deficit = {};
  const capped = [];
  const released = [];
  for (const g of Object.keys(totalDeficit)) {
    if (!(totalDeficit[g] > 0)) continue;
    const cap = (desired[g] || 0) * P.poolCapStations;
    const out = Math.min(totalDeficit[g], Math.max(0, cap - (have[g] || 0)));
    if (out > 0) {
      deficit[g] = out;
      continue;
    }
    if (releaseOn) {
      if (ctx === null) ctx = releaseOf();
      const need = Math.max(1, (ctx && ctx.need && ctx.need[g]) || 1);
      const reach = ctx ? ctx.reach : null;
      const holder = list.some((s) => (reach === null || reach === undefined || reach.has(s && s.stationId))
        && ownOf(s, g) >= need);
      if (!holder) {
        deficit[g] = totalDeficit[g];
        released.push(g);
        continue;
      }
    }
    capped.push(g);
  }
  const order = Array.isArray(P.hullGroups) ? P.hullGroups : [];
  const rank = (g) => (order.indexOf(g) < 0 ? order.length : order.indexOf(g));
  const byOrder = (a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  capped.sort(byOrder);
  released.sort(byOrder);
  return { deficit, capped, released, reach: ctx && ctx.reach instanceof Set ? ctx.reach : null };
}

function poolCappedGroupsOf(desired, stations, P) {
  const out = new Set();
  if (!P || P.poolCapEnabled !== true || !(Number.isSafeInteger(P.poolCapStations) && P.poolCapStations >= 1)) {
    return out;
  }
  const have = {};
  for (const s of Array.isArray(stations) ? stations : []) {
    const hulls = (s && s.hulls) || {};
    for (const g of Object.keys(hulls)) if (hulls[g] > 0) have[g] = (have[g] || 0) + hulls[g];
    for (const j of (s && Array.isArray(s.activeJobs)) ? s.activeJobs : []) {
      if (j && j.runs > 0) have[j.hullGroup] = (have[j.hullGroup] || 0) + j.runs;
    }
  }
  for (const g of Object.keys(desired || {})) {
    if (desired[g] > 0 && (have[g] || 0) >= desired[g] * P.poolCapStations) out.add(g);
  }
  return out;
}

function focusOf(snapshot, supply) {
  if (supply && Array.isArray(supply.frontTargets) && supply.frontTargets.length > 0) return supply.frontTargets;
  const home = snapshot.faction && snapshot.faction.homeSystemId;
  return home === null || home === undefined ? [] : [home];
}

function planProduction(snapshot, supply, params, opts) {
  const none = (note) => ({ intents: [], notes: note ? [note] : [] });
  const pr = snapshot.production;
  const P = params.production;
  if (!pr || !P) return none(null);
  if (pr.mode !== "ready") return none("PRODUCTION_OFF");
  if (snapshot.stationsMode !== "ready" || snapshot.faction.status !== ACTIVE) return none("PRODUCTION_INACTIVE");
  if (pr.truncated === true) return none("PRODUCTION_TRUNCATED");
  if (P.maxJobsPerReview <= 0) return none(null);
  const groups = P.hullGroups;
  const desired = hullTargets(snapshot.doctrine, P);
  if (Object.keys(desired).length === 0) return none(null);
  const recipes = pr.recipes || {};
  const focus = focusOf(snapshot, supply);
  const dist = focus.length > 0 && typeof snapshot.neighbors === "function"
    ? bfs(focus, snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems })
    : new Map();
  const stations = rankMobilizationStations(pr.stations, desired, recipes, dist);

  if (stations.length === 0) {
    const notes = [];
    for (const g of groups) {
      if (desired[g] > 0) notes.push(`PRODUCTION_NO_SITE:${g}`);
    }
    return { intents: [], notes };
  }

  const chosen = stations.slice(0, Math.max(1, P.mobilizationStations || 1));
  const chosenDeficit = {};
  for (const m of chosen) {
    for (const g of groups) {
      if (!(m.deficit[g] > 0)) continue;
      chosenDeficit[g] = (chosenDeficit[g] || 0) + m.deficit[g];
    }
  }
  const releaseOf = P.poolCapEnabled === true && P.poolCapReleaseEnabled === true ? () => {
    const need = templateNeedOf(snapshot.doctrine, P);
    let reach = null;
    if (focus.length > 0 && typeof snapshot.neighbors === "function"
      && Number.isSafeInteger(params.mobilizeFallbackJumps) && params.mobilizeFallbackJumps >= 0) {
      const far = bfs(focus, snapshot.neighbors, { maxJumps: params.mobilizeFallbackJumps,
        maxSystems: params.mobilizeFallbackMaxSystems ?? params.maxBfsSystems });
      reach = new Set(pr.stations.filter((s) => far.has(s.systemId)).map((s) => s.stationId));
    }
    return { need, reach };
  } : null;
  const pc = poolCappedDeficit(chosenDeficit, desired, pr.stations, P, releaseOf);
  const totalDeficit = pc.deficit;
  const releasedSet = new Set(pc.released);
  const reach = pc.reach;
  const outOfReach = (g, s) => releasedSet.has(g) && reach !== null && !reach.has(s.stationId);
  const capNotes = pc.capped.map((g) => `PRODUCTION_POOL_CAP:${g}`);
  if (Object.keys(totalDeficit).length === 0) {
    return capNotes.length > 0 ? { intents: [], notes: capNotes } : none(null);
  }

  const eligible = stations.filter((s) => s.free > 0);

  const groupOrder = groups.slice().sort((a, b) => {
    const da = totalDeficit[a] || 0;
    const db = totalDeficit[b] || 0;
    return Math.floor((db * PERMILLE) / desired[b]) - Math.floor((da * PERMILLE) / desired[a])
      || groups.indexOf(a) - groups.indexOf(b);
  });

  let factionJobs = pr.activeJobsTotal;
  const intents = [];
  const notes = capNotes;
  let slot = opts && Number.isSafeInteger(opts.slotBase) && opts.slotBase > 0 ? opts.slotBase : 0;

   const mineralsInAnyStation = new Map();
   const mineralsInEligibleStation = new Map();
   for (const g of groupOrder) {
     if (!(totalDeficit[g] > 0)) continue;
     const recipe = recipes[g];
     if (!recipe || !recipe.minerals) continue;

     let anyStationHasMinerals = false;
     for (const s of stations) {
       if (affordableRuns(s.minerals, recipe, s.advanced) >= 1) {
         anyStationHasMinerals = true;
         break;
       }
     }
     mineralsInAnyStation.set(g, anyStationHasMinerals);

     let eligibleStationHasMinerals = false;
     for (const s of eligible) {
       if (affordableRuns(s.minerals, recipe, s.advanced) >= 1) {
         eligibleStationHasMinerals = true;
         break;
       }
     }
     mineralsInEligibleStation.set(g, eligibleStationHasMinerals);
   }

  const producedGroups = new Set();

  for (let rank = 0; rank < eligible.length; rank += 1) {
    if (intents.length >= P.maxJobsPerReview) break;
    if (factionJobs >= P.maxActiveJobsPerFaction) {
      notes.push("PRODUCTION_FACTION_LIMIT");
      break;
    }
    const s = eligible[rank];
    for (const g of groupOrder) {
      if (intents.length >= P.maxJobsPerReview) break;
      if (!(totalDeficit[g] > 0)) continue;
      const recipe = recipes[g];
      if (!recipe || !recipe.minerals) continue;
      if (outOfReach(g, s)) continue;
      const can = s.free > 0 ? affordableRuns(s.minerals, recipe, s.advanced) : 0;
      if (!(can >= 1)) continue;
      const runs = Math.min(totalDeficit[g], can, P.maxRunsPerJob);
      if (runs < 1) continue;
      totalDeficit[g] -= runs;
      for (const k of Object.keys(recipe.minerals)) s.minerals[k] -= recipe.minerals[k] * runs;
      spendAdvanced(s, recipe, runs);
      s.free -= 1;
      factionJobs += 1;
      intents.push({ type: "PRODUCE", slot: slot++, stationId: s.stationId, systemId: s.systemId,
        hullGroup: g, runs, recipesVersion: pr.recipesVersion });
      producedGroups.add(g);
    }
  }

  for (const g of groupOrder) {
    if (!(totalDeficit[g] > 0)) continue;
    const recipe = recipes[g];
    if (!recipe || !recipe.minerals) continue;
    if (releasedSet.has(g) && reach !== null && !stations.some((s) => reach.has(s.stationId))) {
      notes.push(`PRODUCTION_NO_SITE:${g}`);
      continue;
    }

    const mineralsInStation = mineralsInAnyStation.get(g) === true;
    const mineralsInEligible = mineralsInEligibleStation.get(g) === true;
    const hasStationsWithLines = stations.length > 0;
    const hasFreeLines = eligible.length > 0;

    if (!hasStationsWithLines) {
      notes.push(`PRODUCTION_NO_SITE:${g}`);
    } else if (!hasFreeLines) {
      if (mineralsInStation) {
        notes.push(`PRODUCTION_LINES_BUSY:${g}`);
      } else {
        notes.push(`PRODUCTION_NO_MINERALS:${g}`);
      }
    } else if (!mineralsInEligible) {
      notes.push(mineralsInStation ? `PRODUCTION_LINES_BUSY:${g}` : `PRODUCTION_NO_MINERALS:${g}`);
    } else if (producedGroups.has(g)) {
      notes.push(`PRODUCTION_PARTIAL:${g}`);
    } else if (intents.length >= P.maxJobsPerReview || factionJobs >= P.maxActiveJobsPerFaction) {
      notes.push(`PRODUCTION_JOB_LIMIT:${g}`);
    } else if (stations.some((s) => s.free <= 0 && affordableRuns(s.minerals, recipe, s.advanced) >= 1)) {
      notes.push(`PRODUCTION_LINES_BUSY:${g}`);
    } else {
      notes.push(`PRODUCTION_MINERALS_SPENT:${g}`);
    }
  }

  return { intents, notes };
}

module.exports = { planProduction, hullTargets, hullRoles, stationDeficit, rankMobilizationStations, focusOf,
  affordableRuns, poolCappedDeficit, poolCappedGroupsOf, templateNeedOf, huntersNeedHullsOf, tributeOnOf, hullsRequiredOf };