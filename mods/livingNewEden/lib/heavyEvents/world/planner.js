"use strict";

const { deriveSeed, createRng } = require("../../util/rng");
const { hullDeltas } = require("../../stations/stockKeys");
const { STATION_STATES } = require("../../stations/schema");
const { OPEN_OPERATION_STATES, OPERATION_TYPES, CAPITAL_HULL_GROUPS } = require("../../fleets/schema");
const H = require("../schema");
const P = require("../power/schema");
const PC = require("../power/catalog");
const { capPeak } = require("../power/planner");
const { nearSystems, stationsRepoOf, stockFactsOf, refusalOf, Rollback } = require("../planner");
const { LAYER, layerOfEventId } = require("../layer");
const W = require("./schema");
const { chooseWorld, labelOf } = require("./choose");

const STATION_ONLINE = STATION_STATES[0];
const SITE_SLOT = 0;
const FUND_REASON = "heavy_event_fund";
const SEED_PREFIX = "hwa:";
const FLAGWRECK_HULL_GROUPS = Object.freeze(["capital", ...CAPITAL_HULL_GROUPS]);
const SALVAGE_DISABLED = "SALVAGE_ANOMALY_DISABLED";

const THREW = Symbol("threw");

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
};

const chooseConfigOf = (env) => ({ ...env.world, maxUpscaleSteps: env.settings.maxUpscaleSteps });

function sumLosses(rows, wanted, keep) {
  const sums = new Map();
  for (const l of rows) {
    if (!l || !wanted.has(l.systemId) || !Number.isSafeInteger(l.factionId) || !Number.isSafeInteger(l.count)
      || !keep(l)) {
      continue;
    }
    const key = `${l.systemId}:${l.factionId}`;
    const cur = sums.get(key) || { systemId: l.systemId, factionId: l.factionId, count: 0 };
    cur.count += l.count;
    sums.set(key, cur);
  }
  return [...sums.values()].sort((a, b) => a.systemId - b.systemId || a.factionId - b.factionId);
}

function lossesInTx(tx, env, systemIds, now) {
  const ws = env.world;
  const none = { losses: [], capitalLosses: [], refused: false, truncated: false };
  const warcamp = ws.warcampWeight > 0;
  const flagwreck = ws.flagwreckWeight > 0;
  if (!warcamp && !flagwreck) return none;
  const repo = safe(() => env.getBattleRepository(), null);
  if (!repo || typeof repo.listVirtualLossesSince !== "function") return { ...none, refused: true };
  const windowMs = Math.max(warcamp ? ws.warcampWindowMs : 0, flagwreck ? ws.flagwreckWindowMs : 0);
  const r = repo.listVirtualLossesSince(tx, { sinceMs: Math.max(0, now - windowMs), limit: ws.maxLossRows });
  if (!r || r.ok !== true || !Array.isArray(r.losses)) return { ...none, refused: true };
  const wanted = new Set(systemIds);
  const since = (ms) => (l) => Number.isSafeInteger(l.settledAt) && l.settledAt >= Math.max(0, now - ms);
  const inWarcamp = flagwreck ? since(ws.warcampWindowMs) : () => true;
  const inFlagwreck = since(ws.flagwreckWindowMs);
  const losses = warcamp ? sumLosses(r.losses, wanted, inWarcamp) : [];
  const capitalLosses = flagwreck ? sumLosses(r.losses, wanted, (l) => FLAGWRECK_HULL_GROUPS.includes(l.hullGroup)
    && inFlagwreck(l)) : [];
  return { losses, capitalLosses, refused: false, truncated: r.truncated === true };
}

function beachheadsInTx(tx, env, systemIds) {
  const none = { beachheads: [], refused: false };
  if (!(env.world.stagingWeight > 0) || systemIds.length === 0) return none;
  const invasions = typeof env.getInvasions === "function" ? safe(() => env.getInvasions(), null) : null;
  if (!invasions || typeof invasions.listBeachheadsInTx !== "function") return { ...none, refused: true };
  const r = safe(() => invasions.listBeachheadsInTx(tx, { limit: systemIds.length, systems: systemIds }), null);
  if (!r || r.ok !== true || !Array.isArray(r.beachheads)) return { ...none, refused: true };
  const wanted = new Set(systemIds);
  const beachheads = r.beachheads.filter((b) => b && wanted.has(b.systemId) && Number.isSafeInteger(b.factionId)
    && b.factionId > 0).map((b) => ({ invasionId: String(b.invasionId), factionId: b.factionId,
    systemId: b.systemId }));
  return { beachheads, refused: false };
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const sortedIds = (ids) => [...new Set(ids)].filter(isId).sort((a, b) => a - b);
const facadeOf = (env, name) => (typeof env[name] === "function" ? safe(() => env[name](), null) : null);

function treasuryInTx(tx, env, systems, kindOf, now) {
  const ws = env.world;
  const none = { treasury: new Map(), refused: false };
  if (!(ws.desertersWeight > 0) || systems.length === 0) return none;
  const kinds = H.parseFactionKinds(ws.desertersFactionKinds) || [];
  const ids = sortedIds(systems.map((s) => s.controllerFactionId)).filter((id) => kinds.includes(kindOf(id)));
  if (ids.length === 0) return none;
  const treasury = facadeOf(env, "getTreasury");
  if (!treasury || typeof treasury.readUnpaidDaysInDb !== "function") return { ...none, refused: true };
  const out = new Map();
  for (const factionId of ids) {
    const r = safe(() => treasury.readUnpaidDaysInDb(tx, factionId, { days: ws.desertersWindowDays, at: now }), null);
    if (!r || r.ok !== true) return { ...none, refused: true };
    if (r.mode === "ready" && Number.isSafeInteger(r.unpaidDays) && r.unpaidDays >= 0) {
      out.set(factionId, { unpaidDays: r.unpaidDays });
    }
  }
  return { treasury: out, refused: false };
}

function starvedInTx(tx, env, stations, worldRepo, systems, kindOf) {
  const ws = env.world;
  const none = { starved: [], neighborControllers: new Map(), refused: false };
  if (!(ws.smugglingWeight > 0) || systems.length === 0) return none;
  if (!W.SMUGGLING_STATION_METHODS.every((m) => typeof stations[m] === "function")) return { ...none, refused: true };
  const victimKinds = H.parseFactionKinds(ws.smugglingVictimKinds) || [];
  const starved = [];
  for (const sys of systems) {
    const listed = safe(() => stations.listStationsInSystem(tx, sys.systemId), null);
    if (!listed || listed.ok !== true || !Array.isArray(listed.records)) return { ...none, refused: true };
    const victims = listed.records.filter((r) => r && r.state === STATION_ONLINE && isId(r.ownerFactionId)
      && victimKinds.includes(kindOf(r.ownerFactionId)));
    if (victims.length === 0) continue;
    const stocks = safe(() => stations.getStocks(tx, victims.map((r) => r.stationId)), null);
    if (!stocks || stocks.ok !== true || !(stocks.byStation instanceof Map)) return { ...none, refused: true };
    const seen = new Set();
    for (const r of victims) {
      const st = stocks.byStation.get(r.stationId);
      if (seen.has(r.ownerFactionId) || stockFactsOf(st ? st.items : []).mineralUnits >= ws.smugglingMaxMineralUnits) {
        continue;
      }
      seen.add(r.ownerFactionId);
      starved.push({ systemId: sys.systemId, factionId: r.ownerFactionId });
    }
  }
  const g = facadeOf(env, "getGraph");
  const graph = g && typeof g.getGraph === "function" ? safe(() => g.getGraph(), null) : null;
  const universe = graph && graph.ok === true && graph.graph && typeof graph.graph.getNeighbors === "function"
    ? graph.graph : null;
  const neighborControllers = new Map();
  let reads = 0;
  for (const systemId of sortedIds(starved.map((x) => x.systemId))) {
    const listed = universe ? safe(() => universe.getNeighbors(systemId), null) : null;
    const controllers = new Set();
    for (const n of sortedIds(Array.isArray(listed) ? listed : [])) {
      if (reads >= ws.smugglingMaxNeighborReads) break;
      reads += 1;
      const w = safe(() => worldRepo.getSystem(tx, n, { includeInfluence: false }), THREW);
      if (w === THREW) return { ...none, refused: true };
      const id = w && w.ok === true && w.system ? w.system.controllerFactionId : null;
      if (isId(id)) {
        kindOf(id);
        controllers.add(id);
      }
    }
    neighborControllers.set(systemId, sortedIds([...controllers]));
  }
  return { starved, neighborControllers, refused: false };
}

function frontsInTx(tx, env, systemIds) {
  const ws = env.world;
  const none = { fronts: [], refused: false };
  if (!(ws.frontdepotWeight > 0) || systemIds.length === 0) return none;
  const types = (W.parseOperationTypes(ws.frontdepotOperationTypes) || []).filter((t) => OPERATION_TYPES.includes(t));
  if (types.length === 0) return none;
  const repo = facadeOf(env, "getFleetRepository");
  if (!repo || typeof repo.listOperationsByTarget !== "function") return { ...none, refused: true };
  const fronts = [];
  for (const systemId of systemIds) {
    for (const operationType of types) {
      const r = safe(() => repo.listOperationsByTarget(tx, systemId, { states: [...OPEN_OPERATION_STATES],
        operationType, limit: ws.frontdepotMaxOpsPerSystem }), null);
      if (!r || r.ok !== true || !Array.isArray(r.operations)) return { ...none, refused: true };
      for (const op of r.operations) {
        if (!op || op.operationType !== operationType || !isId(op.factionId)) continue;
        fronts.push({ systemId, factionId: op.factionId, originSystemId: isId(op.originSystemId) ? op.originSystemId
          : null, operationId: String(op.operationId) });
      }
    }
  }
  return { fronts, refused: false };
}

function lostConvoysInTx(tx, env, systemIds, now) {
  const ws = env.world;
  const none = { lostConvoys: [], refused: false };
  if (!(ws.wreckedconvoyWeight > 0) || systemIds.length === 0) return none;
  const logistics = facadeOf(env, "getLogistics");
  if (!logistics || typeof logistics.listLostInTx !== "function") return { ...none, refused: true };
  const r = safe(() => logistics.listLostInTx(tx, { sinceMs: Math.max(0, now - ws.wreckedconvoyWindowMs),
    limit: ws.wreckedconvoyMaxRows }), null);
  if (!r || r.ok !== true || !Array.isArray(r.convoys)) return { ...none, refused: true };
  const wanted = new Set(systemIds);
  const sums = new Map();
  for (const c of r.convoys) {
    if (!c || !wanted.has(c.systemId) || !isId(c.factionId) || !Number.isSafeInteger(c.lostUnits)) continue;
    const key = `${c.systemId}:${c.factionId}`;
    const cur = sums.get(key) || { systemId: c.systemId, factionId: c.factionId, lostUnits: 0 };
    cur.lostUnits = Math.min(Number.MAX_SAFE_INTEGER, cur.lostUnits + Math.max(0, c.lostUnits));
    sums.set(key, cur);
  }
  const lostConvoys = [...sums.values()].sort((a, b) => a.systemId - b.systemId || a.factionId - b.factionId);
  return { lostConvoys, refused: false };
}

function pressureInTx(env, systems) {
  const none = { pressure: new Map(), refused: false };
  if (!(env.world.breachWeight > 0) || systems.length === 0) return none;
  const abyssal = facadeOf(env, "getAbyssal");
  if (!abyssal || !W.BREACH_ABYSSAL_METHODS.every((m) => typeof abyssal[m] === "function")) {
    return { ...none, refused: true };
  }
  const g = facadeOf(env, "getGraph");
  const graph = g && typeof g.getGraph === "function" ? safe(() => g.getGraph(), null) : null;
  const universe = graph && graph.ok === true && graph.graph && typeof graph.graph.getSystem === "function"
    ? graph.graph : null;
  if (!universe) return { ...none, refused: true };
  const byRegion = new Map();
  const pressure = new Map();
  for (const sys of systems) {
    const vertex = safe(() => universe.getSystem(sys.systemId), null);
    const regionId = vertex && isId(vertex.regionId) ? vertex.regionId : null;
    if (regionId === null) continue;
    if (!byRegion.has(regionId)) {
      const r = safe(() => abyssal.pressureOf(regionId), null);
      if (!r || r.ok !== true) return { ...none, refused: true };
      byRegion.set(regionId, r.milli);
    }
    const milli = byRegion.get(regionId);
    if (Number.isSafeInteger(milli) && milli >= 0) pressure.set(sys.systemId, milli);
  }
  return { pressure, refused: false };
}

function salvageFieldsOf(env, systemIds) {
  const none = { systems: new Set(), refused: false };
  if (!(env.world.flagwreckWeight > 0) || systemIds.length === 0) return none;
  const salvage = facadeOf(env, "getSalvageAnomaly");
  if (!salvage || !W.FLAGWRECK_SALVAGE_METHODS.every((m) => typeof salvage[m] === "function")) {
    return { ...none, refused: true };
  }
  const r = safe(() => salvage.listBoardRows({ systemIds: new Set(systemIds),
    limit: env.world.flagwreckSalvageMaxRows }), null);
  if (r && r.ok !== true && r.reason === SALVAGE_DISABLED) return none;
  if (!r || r.ok !== true || !Array.isArray(r.rows) || r.truncated === true) return { ...none, refused: true };
  return { systems: new Set(r.rows.filter((row) => row && isId(row.systemId)).map((row) => row.systemId)),
    refused: false };
}

function readFactsInTx(tx, env, near, eventIds, now, salvage) {
  for (const eventId of eventIds) {
    const existing = env.repo.getInTx(tx, eventId);
    if (!existing.ok) throw new Rollback("OTHER", existing.reason);
    if (existing.row) return { duplicate: true };
  }
  const stations = stationsRepoOf(env);
  if (!stations) throw new Rollback("STATIONS_NOT_READY");
  const worldRepo = safe(() => env.getWorldRepository(), null);
  if (!worldRepo || typeof worldRepo.getSystem !== "function") throw new Rollback("OTHER", "WORLD_NOT_READY");
  const ws = env.world;
  const systems = [];
  for (const sys of near) {
    if (systems.length >= ws.maxCandidateSystems) break;
    const w = worldRepo.getSystem(tx, sys.systemId, { includeInfluence: false });
    const system = w && w.ok === true && w.system ? w.system : null;
    if (!system) continue;
    const id = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);
    systems.push({ systemId: sys.systemId, band: sys.band, controllerFactionId: id(system.controllerFactionId),
      occupationState: typeof system.occupationState === "string" ? system.occupationState : null,
      occupierFactionId: id(system.occupierFactionId),
      previousControllerFactionId: id(system.previousControllerFactionId) });
  }
  const read = lossesInTx(tx, env, systems.map((s) => s.systemId), now);
  const staging = beachheadsInTx(tx, env, systems.map((s) => s.systemId));
  const kindMemo = new Map();
  const memoKind = (factionId) => {
    if (!kindMemo.has(factionId)) kindMemo.set(factionId, safe(() => env.getFactionKind(factionId), null));
    const kind = kindMemo.get(factionId);
    return typeof kind === "string" ? kind : null;
  };
  const systemIds = systems.map((s) => s.systemId);
  const deserters = treasuryInTx(tx, env, systems, memoKind, now);
  const smuggling = starvedInTx(tx, env, stations, worldRepo, systems, memoKind);
  const frontdepot = frontsInTx(tx, env, systemIds);
  const wrecked = lostConvoysInTx(tx, env, systemIds, now);
  const breach = pressureInTx(env, systems);
  const fundIds = new Set();
  for (const l of read.losses) fundIds.add(l.factionId);
  for (const s of systems) if (s.occupierFactionId !== null) fundIds.add(s.occupierFactionId);
  for (const factionId of deserters.treasury.keys()) fundIds.add(factionId);
  const smugglingKinds = H.parseFactionKinds(env.world.smugglingFactionKinds) || [];
  for (const ids of smuggling.neighborControllers.values()) {
    for (const id of ids) if (smugglingKinds.includes(memoKind(id))) fundIds.add(id);
  }
  for (const f of frontdepot.fronts) fundIds.add(f.factionId);
  for (const c of wrecked.lostConvoys) fundIds.add(c.factionId);
  const kindIds = new Set(fundIds);
  for (const l of read.capitalLosses) kindIds.add(l.factionId);
  const withBeachhead = new Set(staging.beachheads.map((b) => b.systemId));
  for (const s of systems) {
    if (!withBeachhead.has(s.systemId)) continue;
    if (s.controllerFactionId !== null) kindIds.add(s.controllerFactionId);
    if (s.previousControllerFactionId !== null) kindIds.add(s.previousControllerFactionId);
  }
  for (const x of smuggling.starved) kindIds.add(x.factionId);
  for (const id of kindMemo.keys()) kindIds.add(id);
  const sorted = [...fundIds].sort((a, b) => a - b);
  const kindOf = new Map();
  for (const factionId of [...kindIds].sort((a, b) => a - b)) {
    const kind = kindMemo.has(factionId) ? kindMemo.get(factionId) : safe(() => env.getFactionKind(factionId), null);
    if (typeof kind === "string") kindOf.set(factionId, kind);
  }
  const factions = new Map();
  if (ws.fundFromStock === true) {
    for (const factionId of sorted) {
      const listed = stations.listStationsOfFaction(tx, factionId, { states: [STATION_ONLINE] });
      if (!listed || listed.ok !== true) throw new Rollback("OTHER", (listed && listed.reason) || "STATION_READ_FAILED");
      const records = listed.records.filter((r) => r.state === STATION_ONLINE);
      const stocks = records.length > 0 ? stations.getStocks(tx, records.map((r) => r.stationId)) : null;
      if (stocks && stocks.ok !== true) throw new Rollback("OTHER", stocks.reason || "STOCK_READ_FAILED");
      factions.set(factionId, { stations: records.map((r) => {
        const st = stocks ? stocks.byStation.get(r.stationId) : null;
        return { stationId: r.stationId, state: r.state, systemId: r.systemId, ...stockFactsOf(st ? st.items : []) };
      }) });
    }
  }
  const lastWorldEndedAt = new Map();
  for (const sys of systems) {
    const ended = env.repo.lastEndedInSystemInTx(tx, sys.systemId, { types: P.POWER_TYPES, layer: LAYER.WORLD });
    if (!ended.ok) throw new Rollback("OTHER", ended.reason);
    if (ended.endedAt !== null) lastWorldEndedAt.set(sys.systemId, ended.endedAt);
  }
  const open = env.repo.listOpenInTx(tx, { limit: H.OPEN_SCAN_LIMIT });
  if (!open.ok) throw new Rollback("OTHER", open.reason);
  const readRefused = {};
  const salvageRefused = Boolean(salvage && salvage.refused);
  for (const [kind, refused] of [[W.KIND.WARCAMP, read.refused && env.world.warcampWeight > 0],
    [W.KIND.STAGING, staging.refused], [W.KIND.DESERTERS, deserters.refused], [W.KIND.SMUGGLING, smuggling.refused],
    [W.KIND.FRONTDEPOT, frontdepot.refused], [W.KIND.WRECKEDCONVOY, wrecked.refused],
    [W.KIND.FLAGWRECK, (read.refused && env.world.flagwreckWeight > 0) || salvageRefused],
    [W.KIND.BREACH, breach.refused]]) {
    if (refused) readRefused[kind] = true;
  }
  return { duplicate: false, lossesTruncated: read.truncated, readRefused,
    facts: { now, systems, kindOf, losses: read.losses, beachheads: staging.beachheads, factions, lastWorldEndedAt,
      treasury: deserters.treasury, starved: smuggling.starved, neighborControllers: smuggling.neighborControllers,
      fronts: frontdepot.fronts, lostConvoys: wrecked.lostConvoys,
      capitalLosses: salvageRefused ? [] : read.capitalLosses,
      pressure: breach.pressure, salvageSystems: salvage ? salvage.systems : new Set(),
      readRefusedKinds: new Set(Object.keys(readRefused)),
      open: open.rows.map((r) => ({ systemId: r.systemId, factionId: r.factionId, eventType: r.eventType,
        variant: r.variant, state: r.state, layer: layerOfEventId(r.eventId) })) } };
}

function writePlanInTx(tx, env, plan, now) {
  const { eventId, planKey, candidate, members, seed, expiresAt, label, siteKind } = plan;
  const existing = env.repo.getInTx(tx, eventId);
  if (!existing.ok) throw new Rollback("OTHER", existing.reason);
  if (existing.row) return { duplicate: true };
  if (candidate.funded) {
    const stations = stationsRepoOf(env);
    if (!stations) throw new Rollback("STATIONS_NOT_READY");
    const deltas = hullDeltas(candidate.composition, -1);
    if (!deltas.ok) throw new Rollback("OTHER", deltas.reason);
    const fund = stations.applyStockChange(tx, { stationId: candidate.stationId, key: H.fundKeyOf(eventId),
      reason: FUND_REASON, at: now, deltas: deltas.deltas });
    if (!fund || fund.ok !== true) throw new Rollback((fund && fund.reason) || "OTHER");
  }
  const planned = env.repo.planInTx(tx, { eventId, planKey, eventType: candidate.eventType, tier: candidate.tier,
    systemId: candidate.systemId, factionId: candidate.factionId,
    beneficiaryFactionId: Number.isSafeInteger(candidate.beneficiaryFactionId) ? candidate.beneficiaryFactionId : null,
    stationId: candidate.stationId, members, funded: candidate.funded, integrity: null, seed, at: now, expiresAt,
    dueAt: expiresAt, variant: candidate.kind, affix: W.AFFIX_NONE });
  if (!planned.ok) throw new Rollback("OTHER", planned.reason);
  if (planned.duplicate) throw new Rollback("OTHER", "PLAN_DUPLICATE");
  const sites = safe(() => env.getSites(), null);
  if (!sites || typeof sites.createSiteInTx !== "function") throw new Rollback("OTHER", "SITES_UNAVAILABLE");
  const site = sites.createSiteInTx(tx, { eventId, slot: SITE_SLOT, systemId: candidate.systemId,
    templateId: env.settings.beaconTemplateId, label, factionId: candidate.factionId,
    expiresAt: expiresAt + env.settings.engagedMaxMs + env.settings.aftermathMs, siteKind });
  if (!site || site.ok !== true) throw new Rollback((site && site.reason) || "OTHER");
  return { duplicate: false };
}

function takeIntoFacts(facts, candidate) {
  facts.open.push({ systemId: candidate.systemId, factionId: candidate.factionId, eventType: candidate.eventType,
    variant: candidate.kind, state: H.STATE.PLANNED, layer: LAYER.WORLD });
  if (!candidate.funded) return;
  const entry = facts.factions.get(candidate.factionId);
  const station = entry ? entry.stations.find((st) => st.stationId === candidate.stationId) : null;
  if (!station) return;
  const stock = { ...station.hullStock };
  for (const x of candidate.composition) stock[x.hullGroup] = (stock[x.hullGroup] || 0) - x.count;
  station.hullStock = stock;
}

function planWorldPass(env, now, bucket) {
  try {
    return planWorld(env, now, bucket);
  } catch (err) {
    return { ok: false, reason: "OTHER", detail: String((err && err.message) || err).slice(0, 160) };
  }
}

function planWorld(env, now, bucket) {
  const ws = env.world;
  if (!ws || typeof ws !== "object") return { ok: false, reason: "OTHER", detail: "NO_CONFIG" };
  const slots = [];
  for (let slot = 0; slot < ws.maxPlansPerPass; slot += 1) {
    slots.push({ eventId: W.eventIdOf(bucket, slot), planKey: W.planKeyOf(ws.planIntervalMs, bucket, slot) });
  }
  const bands = H.parseSecurityBands(ws.securityBands) || [];
  const near = nearSystems({ ...env, settings: ws }, bands);
  if (!near.ok) return { ok: false, reason: near.reason };
  if (!stationsRepoOf(env)) return { ok: false, reason: "STATIONS_NOT_READY" };
  const sites = safe(() => env.getSites(), null);
  const live = sites && typeof sites.countLive === "function" ? safe(() => sites.countLive(), null) : null;
  if (!live || live.ok !== true || !Number.isSafeInteger(live.count)) {
    return { ok: false, reason: "OTHER", detail: `SITES_COUNT ${(live && live.reason) || "UNAVAILABLE"}` };
  }
  let liveSites = live.count;
  const free = () => env.maxActiveSites - liveSites;
  if (free() < ws.minFreeSiteSlots) return { ok: false, reason: "SITES_HEADROOM" };

  const salvage = salvageFieldsOf(env, near.systems.map((s) => s.systemId));
  const read = env.store.transaction("heavyEvents.worldPlanRead", (tx) => readFactsInTx(tx, env, near.systems,
    slots.map((x) => x.eventId), now, salvage));
  if (!read.ok) return refusalOf(read);
  if (read.value.duplicate) {
    return { ok: true, outcome: "DUPLICATE", planned: 0, refused: {}, lossesTruncated: false, plans: [],
      readRefused: {} };
  }
  const facts = read.value.facts;
  const cfg = chooseConfigOf(env);
  const refused = {};
  const plans = [];
  const note = (reason) => {
    refused[reason] = (refused[reason] || 0) + 1;
  };
  for (const { eventId, planKey } of slots) {
    if (free() < ws.minFreeSiteSlots) {
      note("SITES_HEADROOM");
      break;
    }
    const seed = deriveSeed(env.worldSeed, `${SEED_PREFIX}${planKey}`);
    const choice = chooseWorld(facts, cfg, createRng(seed));
    if (!choice.ok) {
      if (choice.reason === "NO_CANDIDATE" && facts.readRefusedKinds.size > 0) break;
      note(W.WORLD_REASON_RANK.includes(choice.reason) ? choice.reason : "OTHER");
      break;
    }
    const entry = facts.factions.get(choice.candidate.factionId);
    const station = entry ? entry.stations.find((st) => st.stationId === choice.candidate.stationId) : null;
    const candidate = capPeak(choice.candidate, cfg, station);
    if (!candidate) {
      note("SHIPS_CAP");
      continue;
    }
    const members = PC.membersOf(candidate.eventType, candidate.tier, candidate.kind, cfg.maxUpscaleSteps, cfg);
    const siteKind = PC.visibilityOfPocket(candidate.eventType, candidate.tier, candidate.kind, 0, cfg);
    if (!members.ok || siteKind === null) {
      note("OTHER");
      continue;
    }
    const plan = { eventId, planKey, candidate, members: members.members, seed, expiresAt: now + candidate.ttlMs,
      siteKind, label: labelOf(safe(() => env.factionName(candidate.factionId), null), candidate.kind) };
    const write = env.store.transaction("heavyEvents.worldPlan", (tx) => writePlanInTx(tx, env, plan, now));
    if (!write.ok) {
      note(refusalOf(write).reason);
      continue;
    }
    if (write.value.duplicate) continue;
    liveSites += 1;
    takeIntoFacts(facts, candidate);
    plans.push({ eventId, kind: candidate.kind, eventType: candidate.eventType, tier: candidate.tier,
      systemId: candidate.systemId, total: candidate.funded ? candidate.total : 0,
      beneficiaryFactionId: Number.isSafeInteger(candidate.beneficiaryFactionId) ? candidate.beneficiaryFactionId
        : null });
  }
  return { ok: true, outcome: "PLANNED", planned: plans.length, refused, lossesTruncated: read.value.lossesTruncated,
    plans, readRefused: { ...read.value.readRefused } };
}

module.exports = { planWorldPass, chooseConfigOf, STAGING_INVASION_METHODS: W.STAGING_INVASION_METHODS };
