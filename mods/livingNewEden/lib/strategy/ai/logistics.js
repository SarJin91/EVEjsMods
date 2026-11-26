"use strict";

const { bfs } = require("./bfs");
const { hullTargets, rankMobilizationStations, focusOf, affordableRuns } = require("./production");
const { fleetDeficit, isReplenishedRole } = require("./replenish");
const { planTribute } = require("./tribute");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const LOGISTICS_ROLE = "logistics";
const HULLS_TO_MOBILIZATION = "HULLS_TO_MOBILIZATION";
const MINERALS_TO_FACTORY = "MINERALS_TO_FACTORY";
const HULLS_TO_FRONT = "HULLS_TO_FRONT";
const CONSTRUCTION = "CONSTRUCTION";
const TRIBUTE = "TRIBUTE";
const FRONT_DEMAND_STATES = Object.freeze(["IDLE", "REFITTING", "REPLENISHING", "HOLDING"]);
const HULL_PREFIX = "hull/group:";
const MINERAL_PREFIX = "mineral/";
const JUMP_FREIGHTER = "jump_freighter";

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function volumeOf(kindKey, V) {
  if (kindKey.startsWith(MINERAL_PREFIX)) return V.mineral;
  if (kindKey.startsWith(HULL_PREFIX)) {
    const v = V.hulls[kindKey.slice(HULL_PREFIX.length)];
    return Number.isSafeInteger(v) && v > 0 ? v : null;
  }
  return null;
}

function carriersOf(composition, V) {
  let n = 0;
  for (const e of Array.isArray(composition) ? composition : []) {
    if (e && V.carrierGroups.includes(e.hullGroup) && Number.isSafeInteger(e.count) && e.count > 0) n += e.count;
  }
  return n;
}

function capacityOfFleet(composition, P, V, carriers) {
  if (!V.capacityM3) return carriers() * P.carrierCapacityM3 * V.unitsPerM3;
  let units = 0;
  for (const e of Array.isArray(composition) ? composition : []) {
    if (!e || !Number.isSafeInteger(e.count) || e.count <= 0) continue;
    const cap = V.capacityM3[e.hullGroup];
    if (Number.isSafeInteger(cap) && cap > 0) units += e.count * cap * V.unitsPerM3;
  }
  return units;
}

const hasJumpFreighter = (fleet) => (fleet.composition || []).some((e) => e && e.hullGroup === JUMP_FREIGHTER
  && e.count > 0);
const jfReachOf = (P) => (Number.isSafeInteger(P.jumpFreighterReachJumps)
  ? Math.max(P.maxConvoyJumps, P.jumpFreighterReachJumps) : P.maxConvoyJumps);

function fit(items, capacity, V, maxItems) {
  let room = capacity;
  let volume = 0;
  const out = [];
  for (const it of items) {
    if (out.length >= maxItems) break;
    const v = volumeOf(`${it.itemKind}/${it.itemKey}`, V);
    if (v === null) continue;
    const n = Math.min(it.quantity, Math.floor(room / v));
    if (n <= 0) continue;
    out.push({ itemKind: it.itemKind, itemKey: it.itemKey, quantity: n });
    room -= n * v;
    volume += n * v;
  }
  return { items: out, volume };
}

function subtractReserve(minerals, production, stationId) {
  const own = ((production && production.reserve) || []).filter((x) => x && x.stationId === stationId);
  for (const x of own) for (const k of Object.keys(x.minerals || {})) minerals[k] = (minerals[k] || 0) - x.minerals[k];
  return minerals;
}

function mineralsLessReserve(s, production) {
  const has = ((production && production.reserve) || []).some((x) => x && x.stationId === s.stationId);
  return has ? subtractReserve({ ...(s.minerals || {}) }, production, s.stationId) : s.minerals;
}

function planLogistics(snapshot, supply, params, production, ledger, replenish) {
  const cost = { resourceUnits: 0, reserveUnits: 0 };
  const none = (note) => ({ intents: [], notes: note ? [note] : [], cost, localLedger: ledger });
  const lg = snapshot.logistics;
  const P = params.logistics;
  const PP = params.production;
  const pr = snapshot.production;
  if (!lg || !P || !PP) return none(null);
  if (lg.mode !== "ready") return none("LOGISTICS_OFF");
  if (snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== "ready") return none("LOGISTICS_INACTIVE");
  if (!pr || pr.mode !== "ready" || pr.truncated === true) return none("LOGISTICS_NO_PRODUCTION");
  if (lg.truncated === true || snapshot.fleetsTruncated === true) return none("LOGISTICS_TRUNCATED");
  const V = P.volumes;
  const desired = hullTargets(snapshot.doctrine, PP);
  const recipes = pr.recipes || {};
  const focus = focusOf(snapshot, supply);
  const dist = focus.length > 0 && typeof snapshot.neighbors === "function"
    ? bfs(focus, snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems })
    : new Map();
  const ranked = rankMobilizationStations(pr.stations, desired, recipes, dist);
  const prodByStation = new Map();
  for (const i of (production && production.intents) || []) {
    if (i.type !== "PRODUCE") continue;
    const m = prodByStation.get(i.stationId) || {};
    m[i.hullGroup] = (m[i.hullGroup] || 0) + i.runs;
    prodByStation.set(i.stationId, m);
  }
  if (ranked.length === 0 || Object.keys(desired).length === 0) {
    const early = constructionPlans(snapshot, pr, production, [], V);
    const tribute = planTribute(snapshot, pr, production, early, params);
    const res = dispatchPlans(snapshot, supply, params, ledger, tribute.plan ? [...early, tribute.plan] : early, cost,
      prodByStation);
    return tribute.notes.length > 0 ? { ...res, notes: [...tribute.notes, ...res.notes] } : res;
  }
  const chosen = new Set(ranked.slice(0, Math.max(1, PP.mobilizationStations || 1)).map((s) => s.stationId));
  const M = ranked[0];

  const localLedger = ledger && typeof ledger.fork === "function" ? ledger.fork() : ledger;

  const incoming = {};
  const add = (k, n) => { incoming[k] = (incoming[k] || 0) + n; };
  for (const c of lg.open || []) {
    if (c.destStationId !== M.stationId) continue;
    for (const k of Object.keys(c.items || {})) add(k, c.items[k]);
  }
  const minerals = { ...M.minerals };
  for (const i of (production && production.intents) || []) {
    if (i.type !== "PRODUCE") continue;
    if (i.stationId !== M.stationId) continue;
    add(`${HULL_PREFIX}${i.hullGroup}`, i.runs);
    const r = recipes[i.hullGroup];
    for (const k of Object.keys((r && r.minerals) || {})) minerals[k] = (minerals[k] || 0) - r.minerals[k] * i.runs;
  }
  subtractReserve(minerals, production, M.stationId);
  for (const k of Object.keys(incoming)) {
    if (k.startsWith(MINERAL_PREFIX)) {
      const key = k.slice(MINERAL_PREFIX.length);
      minerals[key] = (minerals[key] || 0) + incoming[k];
    }
  }
  const deficit = {};
  for (const g of PP.hullGroups) {
    const d = (M.deficit[g] || 0) - (incoming[`${HULL_PREFIX}${g}`] || 0);
    if (d > 0) deficit[g] = d;
  }
  const hullsAt = (s, g) => (localLedger && typeof localLedger.available === "function" ? localLedger.available(s.stationId, g)
    : ((s.hulls || {})[g] || 0));
  const sourcesFor = (dest) => pr.stations.filter((s) => !chosen.has(s.stationId) && s.systemId !== dest.systemId)
    .sort((a, b) => byId(a.stationId, b.stationId));
  const sources = sourcesFor(M);
  const best = (scoreOf, list = sources) => {
    let pick = null;
    for (const s of list) {
      const score = scoreOf(s);
      if (score > 0 && (pick === null || score > pick.score)) pick = { station: s, score };
    }
    return pick ? pick.station : null;
  };
  const plans = [];
  const frontInfo = frontDemand(snapshot, supply, params, pr, M, replenish);
  const frontReserve = (s, g) => (frontInfo && s.stationId === frontInfo.F.stationId ? frontInfo.demand[g] || 0 : 0);
  const hullsFree = (s, g) => Math.max(0, hullsAt(s, g) - frontReserve(s, g));

  const maxHullConvoys = P.maxHullConvoysPerReview;
  let hullConvoysThisReview = 0;

  const prodSources = [];
  for (const [stationId, groups] of prodByStation) {
    if (chosen.has(stationId)) continue;
    const st = pr.stations.find(s => s.stationId === stationId);
    if (st) prodSources.push({ station: st, groups });
  }
  prodSources.sort((a, b) => byId(a.station.stationId, b.station.stationId));

  for (const ps of prodSources) {
    if (hullConvoysThisReview >= maxHullConvoys) break;

    const items = PP.hullGroups.filter((g) => (ps.groups[g] || 0) > 0 && (deficit[g] || 0) > 0)
      .map((g) => {
        const qty = Math.min(ps.groups[g], deficit[g] || 0);
        return { itemKind: "hull", itemKey: `group:${g}`, quantity: qty };
      });
    if (items.length > 0) {
      plans.push({ purpose: HULLS_TO_MOBILIZATION, source: ps.station, dest: M, items });
      for (const it of items) deficit[it.itemKey.slice("group:".length)] = Math.max(0, (deficit[it.itemKey.slice("group:".length)] || 0) - it.quantity);
      hullConvoysThisReview += 1;
    }
  }

  if (Object.keys(deficit).some(g => deficit[g] > 0) && hullConvoysThisReview < maxHullConvoys) {
    const src = best((s) => Object.keys(deficit).reduce((n, g) => n + Math.min(deficit[g], hullsFree(s, g)), 0));
    if (src) {
      const items = PP.hullGroups.filter((g) => deficit[g] > 0 && hullsFree(src, g) > 0)
        .map((g) => ({ itemKind: "hull", itemKey: `group:${g}`, quantity: Math.min(deficit[g], hullsFree(src, g)) }));
      if (items.length > 0) {
        plans.push({ purpose: HULLS_TO_MOBILIZATION, source: src, dest: M, items });
        for (const it of items) deficit[it.itemKey.slice("group:".length)] -= it.quantity;
        hullConvoysThisReview += 1;
      }
    }
  }

  function plannedMineralConsumption(stationId) {
    const out = {};
    for (const i of (production && production.intents) || []) {
      if (i.type !== "PRODUCE" || i.stationId !== stationId) continue;
      const r = recipes[i.hullGroup];
      if (!r || !r.minerals) continue;
      for (const k of Object.keys(r.minerals)) {
        out[k] = (out[k] || 0) + r.minerals[k] * i.runs;
      }
    }
    for (const x of (production && production.reserve) || []) {
      if (!x || x.stationId !== stationId) continue;
      for (const k of Object.keys(x.minerals || {})) out[k] = (out[k] || 0) + x.minerals[k];
    }
    return out;
  }

  const mineralSurplusThreshold = P.mineralSurplusThreshold;
  const maxMineralConvoys = P.maxMineralConvoysPerReview;
  const mineralConvoyMinLoad = P.mineralConvoyMinLoad;
  let mineralConvoysThisReview = 0;

  const stationsNeedingMinerals = [];
  const desiredGroups = Object.keys(desired);
  for (const s of pr.stations) {
    if (s.stationId === M.stationId) continue;
    const freeLines = (s.lines || 0) - (s.activeJobs?.length || 0);
    if (freeLines <= 0) continue;
    const own = mineralsLessReserve(s, production);
    let canRunAny = false;
    for (const g of desiredGroups) {
      const r = recipes[g];
      if (!r || !r.minerals) continue;
      let canRun = true;
      for (const k of Object.keys(r.minerals)) {
        if ((own[k] || 0) < r.minerals[k]) { canRun = false; break; }
      }
      if (canRun) { canRunAny = true; break; }
    }
    if (canRunAny) continue;
    let deficitSum = 0;
    for (const g of desiredGroups) deficitSum += ((s.deficit && s.deficit[g]) || 0);
    stationsNeedingMinerals.push({ station: s, deficit: deficitSum });
  }
  stationsNeedingMinerals.sort((a, b) => b.deficit - a.deficit || byId(a.station.stationId, b.station.stationId));

  for (const { station: dest } of stationsNeedingMinerals) {
    if (mineralConvoysThisReview >= maxMineralConvoys) break;
    const needed = {};
    const destOwn = mineralsLessReserve(dest, production);
    for (const g of desiredGroups) {
      const r = recipes[g];
      if (!r || !r.minerals) continue;
      for (const k of Object.keys(r.minerals)) {
        const have = destOwn[k] || 0;
        const n = Math.max(0, r.minerals[k] - have);
        if (n > 0) needed[k] = Math.max(needed[k] || 0, n);
      }
    }
    if (Object.keys(needed).length === 0) continue;
    const sources = pr.stations.filter((s) => s.stationId !== dest.stationId
      && s.systemId !== dest.systemId
      && (s.lines || 0) - (s.activeJobs?.length || 0) <= 0);
    let bestSource = null;
    let bestScore = -1;
    for (const src of sources) {
      const planned = plannedMineralConsumption(src.stationId);
      const score = Object.keys(needed).reduce((n, k) => {
        const available = Math.max(0, (src.minerals[k] || 0) - (planned[k] || 0));
        return n + Math.max(0, available - mineralSurplusThreshold);
      }, 0);
      if (score > bestScore) { bestScore = score; bestSource = src; }
    }
    if (!bestSource || bestScore <= 0) continue;
    const plannedForBest = plannedMineralConsumption(bestSource.stationId);
    const convoyItems = [];
    let totalVolume = 0;
    for (const k of Object.keys(needed).sort()) {
      const have = bestSource.minerals[k] || 0;
      const available = Math.max(0, have - (plannedForBest[k] || 0));
      const surplus = available - mineralSurplusThreshold;
      const quantity = Math.min(needed[k], Math.max(0, surplus));
      if (quantity <= 0) continue;
      const v = V.mineral * quantity;
      convoyItems.push({ itemKind: "mineral", itemKey: k, quantity });
      totalVolume += v;
    }
    if (convoyItems.length === 0) continue;
    if (totalVolume < mineralConvoyMinLoad * V.mineral) continue;
    plans.push({
      purpose: MINERALS_TO_FACTORY,
      source: bestSource,
      dest,
      items: convoyItems
    });
    mineralConvoysThisReview += 1;
  }
  const left = PP.hullGroups.filter((g) => deficit[g] > 0 && recipes[g] && recipes[g].minerals)
    .sort((a, b) => deficit[b] - deficit[a] || PP.hullGroups.indexOf(a) - PP.hullGroups.indexOf(b));
  if (left.length > 0) {
    const recipe = recipes[left[0]];
    if (affordableRuns(minerals, recipe) < P.factoryRunsTarget) {
      const need = {};
      for (const k of Object.keys(recipe.minerals)) {
        const n = recipe.minerals[k] * P.factoryRunsTarget - Math.max(0, minerals[k] || 0);
        if (n > 0) need[k] = n;
      }
      const src = best((s) => Object.keys(need).reduce((n, k) => {
        const available = Math.max(0, (s.minerals[k] || 0) - (plannedMineralConsumption(s.stationId)[k] || 0));
        return n + Math.min(need[k], available);
      }, 0));
      if (src) {
        const plannedForSrc = plannedMineralConsumption(src.stationId);
        const items = Object.keys(need).sort().filter((k) => {
          const available = Math.max(0, (src.minerals[k] || 0) - (plannedForSrc[k] || 0));
          return available > 0;
        })
          .map((k) => {
            const available = Math.max(0, (src.minerals[k] || 0) - (plannedForSrc[k] || 0));
            return { itemKind: "mineral", itemKey: k, quantity: Math.min(need[k], available) };
          });
        if (items.length > 0) {
          plans.push({ purpose: MINERALS_TO_FACTORY, source: src, dest: M, items });
        }
      }
    }
  }
  const front = frontPlan(frontInfo, params, pr, M, desired, hullsAt, sourcesFor, best, lg.open || []);
  if (front) plans.push(front);
  plans.push(...constructionPlans(snapshot, pr, production, plans, V));
  const lad = ((production && production.reserve) || []).find((x) => x && x.ladder === true);
  const ladRecipe = lad ? recipes[lad.hullGroup] : null;
  const mc = lad ? pr.stations.find((s) => s.stationId === lad.stationId) : null;
  if (mc && ladRecipe && ladRecipe.minerals && mineralConvoysThisReview < maxMineralConvoys) {
    const inc = {};
    const addInc = (k, n) => { inc[k] = (inc[k] || 0) + n; };
    for (const c of lg.open || []) {
      if (c.destStationId !== mc.stationId) continue;
      for (const k of Object.keys(c.items || {})) {
        if (k.startsWith(MINERAL_PREFIX)) addInc(k.slice(MINERAL_PREFIX.length), c.items[k]);
      }
    }
    for (const p of plans) {
      if (p.dest.stationId !== mc.stationId) continue;
      for (const it of p.items) if (it.itemKind === "mineral") addInc(it.itemKey, it.quantity);
    }
    const need = {};
    for (const k of Object.keys(ladRecipe.minerals)) {
      const n = ladRecipe.minerals[k] - (((mc.minerals || {})[k] || 0) + (inc[k] || 0));
      if (n > 0) need[k] = n;
    }
    if (Object.keys(need).length > 0) {
      const takenFrom = (stationId) => {
        const out = {};
        for (const p of plans) {
          if (p.source.stationId !== stationId) continue;
          for (const it of p.items) {
            if (it.itemKind === "mineral") out[it.itemKey] = (out[it.itemKey] || 0) + it.quantity;
          }
        }
        return out;
      };
      const surplusOf = (s) => {
        const planned = plannedMineralConsumption(s.stationId);
        const taken = takenFrom(s.stationId);
        return (k) => Math.max(0, ((s.minerals || {})[k] || 0) - (planned[k] || 0) - (taken[k] || 0)
          - mineralSurplusThreshold);
      };
      const src = best((s) => {
        const surplus = surplusOf(s);
        return Object.keys(need).reduce((n, k) => n + Math.min(need[k], surplus(k)), 0);
      }, sourcesFor(mc));
      if (src) {
        const surplus = surplusOf(src);
        const items = Object.keys(need).sort().map((k) => ({ itemKind: "mineral", itemKey: k,
          quantity: Math.min(need[k], surplus(k)) })).filter((it) => it.quantity > 0);
        if (items.length > 0) {
          plans.push({ purpose: MINERALS_TO_FACTORY, source: src, dest: mc, items });
          mineralConvoysThisReview += 1;
        }
      }
    }
  }
  const tribute = planTribute(snapshot, pr, production, plans, params);
  if (tribute.plan) plans.push(tribute.plan);
  const result = dispatchPlans(snapshot, supply, params, localLedger, plans, cost, prodByStation);
  return tribute.notes.length > 0 ? { ...result, notes: [...tribute.notes, ...result.notes], localLedger }
    : { ...result, localLedger };
}

function constructionPlans(snapshot, pr, production, earlier, V) {
  const sc = snapshot.construction;
  if (!sc || sc.mode !== "ready" || !Array.isArray(sc.open)) return [];
  const lg = snapshot.logistics;
  const recipes = pr.recipes || {};
  const left = new Map(pr.stations.map((s) => [s.stationId, { ...(s.minerals || {}) }]));
  const take = (stationId, key, n) => {
    const m = left.get(stationId);
    if (m) m[key] = (m[key] || 0) - n;
  };
  for (const i of (production && production.intents) || []) {
    if (i.type !== "PRODUCE") continue;
    const r = recipes[i.hullGroup];
    for (const k of Object.keys((r && r.minerals) || {})) take(i.stationId, k, r.minerals[k] * i.runs);
  }
  for (const x of (production && production.reserve) || []) {
    if (!x) continue;
    for (const k of Object.keys(x.minerals || {})) take(x.stationId, k, x.minerals[k]);
  }
  const takePlan = (p) => {
    for (const it of p.items) if (it.itemKind === "mineral") take(p.source.stationId, it.itemKey, it.quantity);
  };
  earlier.forEach(takePlan);
  const out = [];
  for (const b of sc.open) {
    if (b.state !== "SUPPLYING" || (lg.open || []).some((c) => c.destStationId === b.stationId)) continue;
    const need = {};
    for (const key of Object.keys(b.remaining || {}).sort()) {
      if (key.startsWith(MINERAL_PREFIX) && b.remaining[key] > 0) {
        need[key.slice(MINERAL_PREFIX.length)] = b.remaining[key];
      }
    }
    if (Object.keys(need).length === 0) continue;
    const have = (s, k) => Math.max(0, left.get(s.stationId)[k] || 0);
    let source = null;
    let score = 0;
    for (const s of [...pr.stations].sort((a, c) => byId(a.stationId, c.stationId))) {
      if (s.systemId === b.systemId) continue;
      const n = Object.keys(need).reduce((sum, k) => sum + Math.min(need[k], have(s, k)), 0);
      if (n > score) {
        source = s;
        score = n;
      }
    }
    if (!source) continue;
    const items = Object.keys(need).filter((k) => have(source, k) > 0)
      .map((k) => ({ itemKind: "mineral", itemKey: k, quantity: Math.min(need[k], have(source, k)) }));
    const needVolume = Object.keys(need).reduce((sum, k) => sum + need[k] * V.mineral, 0);
    const plan = { purpose: CONSTRUCTION, source, dest: { stationId: b.stationId, systemId: b.systemId }, items,
      needVolume };
    takePlan(plan);
    out.push(plan);
  }
  return out;
}

function dispatchPlans(snapshot, supply, params, ledger, plans, cost, prodByStation) {
  if (plans.length === 0) return { intents: [], notes: [], cost };
  const lg = snapshot.logistics;
  const P = params.logistics;
  const V = P.volumes;
  const minLoad = (plan) => {
    if (Number.isSafeInteger(plan.minLoad)) return plan.minLoad;
    if (plan.purpose === CONSTRUCTION) return Math.min(P.minLoadVolume, plan.needVolume);
    if (plan.purpose === MINERALS_TO_FACTORY) return Math.min(P.minLoadVolume, P.mineralConvoyMinLoad * V.mineral);
    return P.minLoadVolume;
  };

  const notes = [];
  const intents = [];
  const busy = new Set(lg.busyFleetIds || []);
  const own = snapshot.fleets.filter((x) => x.fleetRole === LOGISTICS_ROLE);
  const carriers = (x) => (lg.carriers && Number.isSafeInteger(lg.carriers[x.fleetId]) ? lg.carriers[x.fleetId] : 0);
  if (own.some((x) => carriers(x) === 0)) notes.push("LOGISTICS_NO_CARRIERS");
  const free = own.filter((x) => x.state === IDLE && x.refitPending !== true && !busy.has(x.fleetId) && carriers(x) > 0)
    .sort((a, b) => byId(a.fleetId, b.fleetId));
  let live = own.filter((x) => carriers(x) > 0).length;
  let room = Math.max(0, Math.min(P.maxDispatchesPerReview, P.maxOpenConvoysPerFaction - (lg.open || []).length));
  if (room === 0) notes.push("LOGISTICS_CONVOY_LIMIT");
  const used = new Set();
  let mobilized = 0;
  let slot = 0;
  const template = snapshot.doctrine.templates && snapshot.doctrine.templates[LOGISTICS_ROLE];
  const hasTribute = plans.some((p) => p.purpose === TRIBUTE);
  const reserved = hasTribute && P.tributeReserveSlot === true ? 1 : 0;
  let tributeReached = false;
  for (const plan of plans) {
    if (room <= 0) break;
    if (plan.purpose === TRIBUTE) tributeReached = true;
    const src = plan.source;
    let planItems;
    if (plan.purpose === HULLS_TO_MOBILIZATION && prodByStation && prodByStation.has(src.stationId)) {
      const prodGroups = prodByStation.get(src.stationId);
      planItems = plan.items.map((it) => {
        if (it.itemKind !== "hull") return it;
        const group = it.itemKey.slice("group:".length);
        const produced = prodGroups[group] || 0;
        return { ...it, quantity: Math.min(it.quantity, produced) };
      }).filter((it) => it.quantity > 0);
    } else {
      planItems = !ledger || typeof ledger.available !== "function" ? plan.items : plan.items
        .map((it) => (it.itemKind === "hull" ? { ...it,
          quantity: Math.min(it.quantity, ledger.available(src.stationId, it.itemKey.slice("group:".length))) } : it))
        .filter((it) => it.quantity > 0);
    }
    if (planItems.length === 0) continue;
    const reachOf = (x) => (hasJumpFreighter(x) ? jfReachOf(P) : P.maxConvoyJumps);
    const candidates = free.filter((x) => !used.has(x.fleetId));
    const maxJumps = candidates.some(hasJumpFreighter) ? jfReachOf(P) : P.maxConvoyJumps;
    const near = bfs([src.systemId], snapshot.neighbors, { maxJumps, maxSystems: params.maxBfsSystems });
    const fleet = candidates.filter((x) => near.has(x.systemId) && near.get(x.systemId) <= reachOf(x))
      .sort((a, b) => near.get(a.systemId) - near.get(b.systemId) || byId(a.fleetId, b.fleetId))[0];
    if (fleet) {
      if (plan.purpose !== TRIBUTE && room <= reserved) continue;
      const cargo = fit(planItems, capacityOfFleet(fleet.composition, P, V, () => carriers(fleet)), V,
        P.maxCargoItems);
      if (cargo.items.length === 0 || cargo.volume < minLoad(plan)) {
        notes.push(plan.purpose === TRIBUTE ? "TRIBUTE_SMALL_LOAD" : "LOGISTICS_SMALL_LOAD");
        continue;
      }
      used.add(fleet.fleetId);
      room -= 1;
      if (near.get(fleet.systemId) > P.maxConvoyJumps) notes.push("LOGISTICS_JF_REACH");
      intents.push({ type: "CONVOY_DISPATCH", slot: slot++, fleetId: fleet.fleetId, expectedVersion: fleet.version,
        purpose: plan.purpose, sourceStationId: src.stationId, destStationId: plan.dest.stationId,
        items: cargo.items,
        ...(Number.isSafeInteger(plan.tributeBucket) ? { tributeBucket: plan.tributeBucket } : {}) });
      if (plan.purpose === TRIBUTE) notes.push("TRIBUTE_DISPATCHED");
      const hulls = cargo.items.filter((it) => it.itemKind === "hull")
        .map((it) => ({ itemKey: it.itemKey, count: it.quantity }));
      const isProductionConvoy = plan.purpose === HULLS_TO_MOBILIZATION && prodByStation && prodByStation.has(src.stationId);
      if (ledger && hulls.length > 0 && !isProductionConvoy) ledger.take(src.stationId, hulls);
      continue;
    }
    if (plan.noMobilize === true) {
      notes.push("TRIBUTE_NO_FLEET");
      continue;
    }
    if (!Array.isArray(template) || template.length === 0) {
      notes.push("LOGISTICS_NO_TEMPLATE");
      continue;
    }
    const capacity = capacityOfFleet(template, P, V, () => carriersOf(template, V));
    if (fit(planItems, capacity, V, P.maxCargoItems).volume < minLoad(plan)) {
      notes.push("LOGISTICS_SMALL_LOAD");
      continue;
    }
    if (live >= P.maxFleetsPerFaction || mobilized >= P.maxMobilizationsPerReview) {
      notes.push("LOGISTICS_NO_FLEET");
      continue;
    }
    const ships = template.reduce((n, e) => n + e.count, 0);
    const unit = { resourceUnits: ships * params.mobilizeResourcePerShip,
      reserveUnits: ships * params.mobilizeReservePerShip };
    if (cost.resourceUnits + unit.resourceUnits > supply.affordable.resourceUnits
      || cost.reserveUnits + unit.reserveUnits > supply.affordable.reserveUnits) {
      notes.push("LOGISTICS_INSUFFICIENT_RESOURCES");
      continue;
    }
    let hulls = { stationId: null, hulls: [] };
    if (ledger && ledger.needs(LOGISTICS_ROLE)) {
      const inProduction = (snapshot.production && snapshot.production.inProduction) || {};
      const result = ledger.pickWithNote(template, [{ stationId: src.stationId, systemId: src.systemId }], inProduction);
      if (!result.picked) {
        notes.push(result.note);
        continue;
      }
      hulls = { stationId: result.picked.stationId, hulls: result.picked.hulls };
      ledger.take(result.picked.stationId, result.picked.hulls);
    }
    cost.resourceUnits += unit.resourceUnits;
    cost.reserveUnits += unit.reserveUnits;
    live += 1;
    mobilized += 1;
    notes.push("LOGISTICS_MOBILIZE");
    intents.push({ type: "MOBILIZE", slot: slot++, role: LOGISTICS_ROLE, systemId: src.systemId,
      homeSystemId: src.systemId, composition: template.map((e) => ({ hullGroup: e.hullGroup, typeId: null,
        count: e.count })), cost: { ...unit }, stationId: hulls.stationId, hulls: hulls.hulls });
  }
  if (hasTribute && !tributeReached) notes.push("TRIBUTE_DISPATCH_LIMIT");
  return { intents, notes, cost };
}

function frontDemand(snapshot, supply, params, pr, M, replenish) {
  const P = params.logistics;
  const targets = supply && Array.isArray(supply.frontTargets) ? supply.frontTargets : [];
  if (targets.length === 0 || typeof snapshot.neighbors !== "function") return null;
  const near = bfs(targets, snapshot.neighbors, { maxJumps: P.frontStationMaxJumps, maxSystems: params.maxBfsSystems });
  const F = pr.stations.filter((s) => s.systemId !== M.systemId && near.has(s.systemId))
    .sort((a, b) => near.get(a.systemId) - near.get(b.systemId) || byId(a.stationId, b.stationId))[0];
  if (!F) return null;
  const given = new Map();
  for (const i of (replenish && replenish.intents) || []) given.set(i.fleetId, i.add);
  const demand = {};
  for (const x of snapshot.fleets) {
    if (x.systemId !== F.systemId || !FRONT_DEMAND_STATES.includes(x.state) || !isReplenishedRole(snapshot, x.fleetRole)) {
      continue;
    }
    const d = fleetDeficit(x, snapshot.doctrine.templates[x.fleetRole]);
    for (const a of given.get(x.fleetId) || []) if (d[a.hullGroup]) d[a.hullGroup] -= a.count;
    for (const g of Object.keys(d)) if (d[g] > 0) demand[g] = (demand[g] || 0) + d[g];
  }
  return { F, demand };
}

function frontPlan(info, params, pr, M, desired, hullsAt, sourcesFor, best, open) {
  if (!info) return null;
  const PP = params.production;
  const F = info.F;
  const demand = { ...info.demand };
  for (const c of open) {
    if (c.destStationId !== F.stationId) continue;
    for (const k of Object.keys(c.items || {})) {
      if (k.startsWith(HULL_PREFIX)) {
        const g = k.slice(HULL_PREFIX.length);
        if (demand[g]) demand[g] -= c.items[k];
      }
    }
  }
  for (const g of Object.keys(demand)) {
    demand[g] -= hullsAt(F, g);
    if (!(demand[g] > 0)) delete demand[g];
  }
  if (Object.keys(demand).length === 0) return null;
  const groups = PP.hullGroups.filter((g) => demand[g] > 0);
  const Ms = pr.stations.find((s) => s.stationId === M.stationId) || M;
  const surplus = (g) => Math.max(0, hullsAt(Ms, g) - (desired[g] || 0));
  const fromM = groups.reduce((n, g) => n + Math.min(demand[g], surplus(g)), 0);
  let source = null;
  let give = null;
  if (fromM > 0) {
    source = Ms;
    give = surplus;
  } else {
    source = best((s) => groups.reduce((n, g) => n + Math.min(demand[g], hullsAt(s, g)), 0),
      sourcesFor(F).filter((s) => s.stationId !== M.stationId));
    give = (g) => hullsAt(source, g);
  }
  if (!source) return null;
  const items = groups.filter((g) => give(g) > 0)
    .map((g) => ({ itemKind: "hull", itemKey: `group:${g}`, quantity: Math.min(demand[g], give(g)) }));
  return items.length > 0 ? { purpose: HULLS_TO_FRONT, source, dest: F, items } : null;
}

module.exports = { planLogistics, hasJumpFreighter, jfReachOf };
