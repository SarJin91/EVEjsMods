"use strict";

const { performance } = require("node:perf_hooks");
const S = require("./schema");
const { systemYield } = require("./yield");
const { stationTarget, expandGross, conversionOrder, conversionStep, applyStep, planTransfers } = require("./demand");
const { parseHullGroupList } = require("../../fleets/schema");
const { capitalPermilleOf, recipeParamsOf } = require("../production/recipes");

const PERMILLE = 1000;
const TYPE_PREFIX = "type:";
const UPWELL = "upwell";
const NPC = "npc";
const MAX_DETAIL = 120;
const MODE_READY = "ready";
const MODE_PENDING = "pending";
const MODE_OFF = "off";
const STATIONS_READY = "ready";
const ONLINE = "ONLINE";
const COUNTER_NAMES = Object.freeze(["pulses", "factionsProcessed", "factionsMarked", "systemsYielding",
  "systemsTruncated", "claimedSystems", "moonUnits", "piUnits", "lostNoStation", "lostStockFull", "stationsTruncated",
  "rowsDeferred", "refused", "cacheFull",
  "conversions", "conversionUnits", "conversionsTruncated", "conversionsRefused", "fuelBurned", "unfueled",
  "demandStationsTruncated",
  "transfers", "transferUnits", "transfersRefused", "transfersTruncated", "transferNoDonor"]);
const SAVEPOINT_ABORT = Symbol("extraction-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function sumOf(bag) {
  let n = 0;
  for (const v of Object.values(bag)) n += v;
  return n;
}

function createExtractionService(deps) {
  const { journal, scheduler, clock, config, catalog } = deps;
  const X = config.extraction;
  const maxDeltas = config.stations && isId(config.stations.maxDeltasPerChange) ? config.stations.maxDeltasPerChange : 1;
  const maxQuantity = config.stations && isId(config.stations.maxStockQuantity) ? config.stations.maxStockQuantity
    : Number.MAX_SAFE_INTEGER;
  const params = Object.freeze({ maxMoonsPerSystem: X.maxMoonsPerSystem, maxPlanetsPerSystem: X.maxPlanetsPerSystem,
    moonPortionsPerMoonPerPeriod: X.moonPortionsPerMoonPerPeriod,
    piP1UnitsPerPlanetPerPeriod: X.piP1UnitsPerPlanetPerPeriod,
    bandPermille: Object.freeze({ highsec: X.highsecYieldPermille, lowsec: X.lowsecYieldPermille,
      nullsec: X.nullsecYieldPermille }),
    tierWeights: deps.tierWeights });
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const celestials = new Map();
  const p0ByPlanetType = new Map();
  const lastCycleByFaction = new Map();
  const systemUnits = new Map();
  let cursor = 0;
  let state = "ready";
  let lastRefusal = null;
  let seq = 0;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `extraction.${name}`, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function stationsNow() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const mode = st && typeof st.getMode === "function" ? call(() => st.getMode(), MODE_OFF) : MODE_OFF;
    const ready = mode === STATIONS_READY && st && st.repository;
    return { repository: ready ? st.repository : null };
  }

  function graphNow() {
    const g = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    return g && typeof g.getSystem === "function" && typeof g.getNeighbors === "function" ? g : null;
  }

  function getMode() {
    if (state === "stopped") return MODE_OFF;
    const st = stationsNow();
    return st.repository && graphNow() ? MODE_READY : MODE_PENDING;
  }

  const fuelPerPeriod = Object.freeze(catalog.fuelPerPeriod(X.fuelBlocksPerUpwellPerPeriod));
  const fuelOn = deps.demandDisabled !== true && X.fuelEnabled === true && fuelPerPeriod.length > 0;
  const transferOn = X.upwellTransferEnabled === true && deps.demandDisabled !== true;
  const transferTypes = Math.max(1, Math.min(Number(X.maxTransferTypesPerPair) || 1, maxDeltas));
  const maxTransferPairs = Math.max(0, Number(X.maxTransfersPerFaction) || 0);
  const fuelTypeSet = new Set(fuelPerPeriod.map(([t]) => t));
  const reserveGroups = Object.freeze(parseHullGroupList(X.advancedReserveGroups) || []);
  const P = config.production || {};
  const recipeParams = recipeParamsOf(P);
  const groupPermilleOf = (g) => call(() => capitalPermilleOf(g, recipeParams), PERMILLE);

  function advancedNow() {
    if (deps.demandDisabled === true) return null;
    const pr = typeof deps.getProduction === "function" ? call(deps.getProduction, null) : null;
    if (!pr || typeof pr.getAdvanced !== "function") return null;
    return call(() => pr.getAdvanced(), null) || null;
  }

  function nominalLines(kind) {
    if (kind === "npc") return Number(P.linesPerNpcStation) || 0;
    if (kind === "upwell") return Number(P.linesPerUpwellStation) || 0;
    return 0;
  }

  function targetParams(advancedOn) {
    return { fuelOn, advancedOn, fuel: fuelPerPeriod, fuelReservePeriods: X.fuelReservePeriods, reserveGroups,
      advancedReserveRuns: X.advancedReserveRuns, advancedInputsPermille: P.advancedInputsPermille, groupPermilleOf };
  }

  function activeGroupsOf(tx, f) {
    const pr = typeof deps.getProduction === "function" ? call(deps.getProduction, null) : null;
    const r = pr && typeof pr.activeGroupsByStation === "function"
      ? call(() => pr.activeGroupsByStation(tx, f), null) : null;
    return r && r.ok === true && r.byStation instanceof Map ? r.byStation : new Map();
  }

  function stockMapOf(items) {
    const out = new Map();
    for (const it of items || []) {
      if ((it.itemKind !== S.KIND_MOON && it.itemKind !== S.KIND_PI) || typeof it.itemKey !== "string") continue;
      const id = Number(it.itemKey.slice(TYPE_PREFIX.length));
      if (it.itemKey.startsWith(TYPE_PREFIX) && isId(id) && it.quantity > 0) out.set(id, it.quantity);
    }
    return out;
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "EXTRACTION_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      if (tx.inTransaction !== true) throw err;
      return { ok: false, reason: `EXTRACTION_THREW: ${messageOf(err)}` };
    }
  }

  function readCelestials(systemIds, store) {
    const bySystem = new Map();
    const missing = [];
    for (const id of systemIds) {
      if (celestials.has(id)) bySystem.set(id, celestials.get(id));
      else missing.push(id);
    }
    let cacheFull = 0;
    if (missing.length > 0) {
      const adapter = deps.adapter;
      if (!adapter || typeof adapter.readSystemCelestials !== "function") {
        return { ok: false, reason: "CELESTIALS_UNAVAILABLE", detail: "adapter" };
      }
      const r = call(() => adapter.readSystemCelestials(missing, { maxSystems: X.maxSystemsPerFaction }),
        { ok: false, reason: "CELESTIALS_UNAVAILABLE", detail: "threw" });
      if (!r || r.ok !== true || !(r.systems instanceof Map)) {
        return { ok: false, reason: "CELESTIALS_UNAVAILABLE", detail: String((r && (r.detail || r.reason)) || "") };
      }
      for (const id of missing) {
        const got = r.systems.get(id);
        const entry = Object.freeze({ moons: got && Array.isArray(got.moons) ? got.moons : [],
          planets: got && Array.isArray(got.planets) ? got.planets : [] });
        bySystem.set(id, entry);
        if (!store) continue;
        if (celestials.size < X.maxCachedSystems) celestials.set(id, entry);
        else cacheFull += 1;
      }
    }
    return { ok: true, bySystem, cacheFull };
  }

  function readP0(typeIds, store) {
    const map = new Map();
    const missing = [];
    for (const t of typeIds) {
      if (p0ByPlanetType.has(t)) map.set(t, p0ByPlanetType.get(t));
      else missing.push(t);
    }
    if (missing.length === 0) return { ok: true, map };
    const adapter = deps.adapter;
    if (!adapter || typeof adapter.readPlanetResources !== "function") {
      return { ok: false, reason: "PLANET_DATA_UNAVAILABLE", detail: "adapter" };
    }
    for (let i = 0; i < missing.length; i += S.PLANET_TYPES_PER_CALL) {
      const part = missing.slice(i, i + S.PLANET_TYPES_PER_CALL);
      const r = call(() => adapter.readPlanetResources(part), { ok: false, reason: "PLANET_DATA_UNAVAILABLE" });
      if (!r || r.ok !== true || !(r.byType instanceof Map)) {
        return { ok: false, reason: "PLANET_DATA_UNAVAILABLE", detail: String((r && (r.detail || r.reason)) || "") };
      }
      for (const t of part) {
        const list = Object.freeze([...(r.byType.get(t) || [])]);
        map.set(t, list);
        if (store && p0ByPlanetType.size < X.maxCachedSystems) p0ByPlanetType.set(t, list);
      }
    }
    return { ok: true, map };
  }

  function yieldOfSystem(graph, systemId, sys, p0) {
    const vertex = call(() => graph.getSystem(systemId), null);
    const secClass = vertex && typeof vertex.secClass === "string" ? vertex.secClass : "other";
    return systemYield({ systemId, secClass, moons: sys.moons, planets: sys.planets }, catalog,
      { p0ByPlanetType: p0 }, params);
  }

  function ownStations(tx, repository, factionId) {
    const listed = call(() => repository.listStationsOfFaction(tx, factionId, { states: [ONLINE] }),
      { ok: false, reason: "STATIONS_READ_FAILED" });
    if (!listed || listed.ok !== true || !Array.isArray(listed.records)) {
      return listed && listed.ok === false ? listed : { ok: false, reason: "STATIONS_READ_FAILED" };
    }
    const bySystem = new Map();
    const records = [];
    for (const s of listed.records) {
      if (!s || s.ownerFactionId !== factionId || s.state !== ONLINE || !isId(s.systemId)) continue;
      records.push(s);
      const prev = bySystem.get(s.systemId);
      if (prev === undefined || cmp(s.stationId, prev) < 0) bySystem.set(s.systemId, s.stationId);
    }
    records.sort((a, b) => cmp(a.stationId, b.stationId));
    return { ok: true, bySystem, records };
  }

  function deliveryMap(graph, own, wanted) {
    const out = new Map();
    if (own.size === 0 || wanted.size === 0) return out;
    const home = new Map();
    let frontier = [...own.keys()];
    let covered = 0;
    for (const id of frontier) {
      home.set(id, id);
      if (wanted.has(id)) covered += 1;
    }
    for (let jump = 1; jump <= X.maxDeliveryJumps && frontier.length > 0 && covered < wanted.size; jump += 1) {
      frontier.sort((a, b) => home.get(a) - home.get(b) || a - b);
      const next = [];
      for (const id of frontier) {
        const h = home.get(id);
        const nbs = call(() => graph.getNeighbors(id), null) || [];
        for (const nb of nbs) {
          if (home.has(nb)) continue;
          home.set(nb, h);
          next.push(nb);
          if (wanted.has(nb)) covered += 1;
        }
      }
      frontier = next;
    }
    for (const id of wanted) if (home.has(id)) out.set(id, own.get(home.get(id)));
    return out;
  }

  function addBag(into, bag, factor) {
    let units = 0;
    for (const [key, v] of Object.entries(bag)) {
      const n = factor === PERMILLE ? v : Math.floor((v * factor) / PERMILLE);
      if (!(n > 0)) continue;
      into[key] = (into[key] || 0) + n;
      units += n;
    }
    return units;
  }

  function planFaction(tx, f, st, graph) {
    const world = typeof deps.getWorld === "function" ? call(deps.getWorld, null) : null;
    if (!world || typeof world.listControlledByFaction !== "function") return { ok: false, reason: "WORLD_UNAVAILABLE" };
    const listed = world.listControlledByFaction(tx, f, { limit: X.maxSystemsPerFaction });
    if (!listed || listed.ok !== true) return listed || { ok: false, reason: "WORLD_READ_FAILED" };
    const systems = [...listed.systems].sort((a, b) => a.systemId - b.systemId);
    const plan = { ok: true, factionId: f, systems: systems.length, truncated: listed.nextAfterSystemId !== null
      && listed.nextAfterSystemId !== undefined, claimed: 0, yielding: 0, cacheFull: 0, lostNoStation: 0,
    stationsTruncated: 0, stations: [], bySystem: [], demand: null };
    const advanced = advancedNow();
    const demandFlags = fuelOn || advanced !== null;
    let own = null;
    if (demandFlags) {
      own = ownStations(tx, st.repository, f);
      if (!own.ok) return own;
      planDemand(tx, f, plan, own.records, advanced !== null, graph);
    }
    const demandRows = plan.demand ? plan.demand.rows : 0;
    if (systems.length === 0) {
      if (plan.demand) plan.rows = S.factionRowBound([]) + demandRows;
      return plan;
    }
    const cel = readCelestials(systems.map((s) => s.systemId), true);
    if (!cel.ok) return cel;
    plan.cacheFull = cel.cacheFull;
    const types = new Set();
    for (const s of cel.bySystem.values()) for (const p of s.planets) if (p && isId(p.typeId)) types.add(p.typeId);
    const p0 = readP0([...types].sort((a, b) => a - b), true);
    if (!p0.ok) return p0;
    if (!own) {
      own = ownStations(tx, st.repository, f);
      if (!own.ok) return own;
    }
    const yields = [];
    for (const sys of systems) {
      const y = yieldOfSystem(graph, sys.systemId, cel.bySystem.get(sys.systemId), p0.map);
      if (!y || y.ok !== true) continue;
      const claimed = sys.occupierFactionId !== null && sys.occupierFactionId !== undefined;
      const factor = claimed ? X.claimedYieldPermille : PERMILLE;
      const moon = {};
      const pi = {};
      const units = addBag(moon, y.moon, factor) + addBag(pi, y.pi, factor);
      if (units <= 0) continue;
      yields.push({ systemId: sys.systemId, claimed, moon, pi, units });
    }
    const homes = deliveryMap(graph, own.bySystem, new Set(yields.map((y) => y.systemId)));
    const perStation = new Map();
    for (const { systemId, claimed, moon, pi, units } of yields) {
      plan.yielding += 1;
      if (claimed) plan.claimed += 1;
      const home = homes.has(systemId) ? homes.get(systemId) : null;
      plan.bySystem.push([systemId, units]);
      if (home === null) {
        plan.lostNoStation += units;
        continue;
      }
      let entry = perStation.get(home);
      if (!entry) {
        entry = { stationId: home, moon: {}, pi: {}, units: 0 };
        perStation.set(home, entry);
      }
      addBag(entry.moon, moon, PERMILLE);
      addBag(entry.pi, pi, PERMILLE);
      entry.units += units;
    }
    const ranked = [...perStation.values()].sort((a, b) => b.units - a.units || cmp(a.stationId, b.stationId));
    for (const lost of ranked.slice(X.maxStationsPerFaction)) {
      plan.stationsTruncated += 1;
      plan.lostNoStation += lost.units;
    }
    plan.stations = ranked.slice(0, X.maxStationsPerFaction).map((s) => {
      const deltas = [];
      for (const [kind, bag] of [[S.KIND_MOON, s.moon], [S.KIND_PI, s.pi]]) {
        for (const [itemKey, n] of Object.entries(bag)) {
          deltas.push({ itemKind: kind, itemKey, delta: Math.min(n, maxQuantity) });
        }
      }
      deltas.sort((a, b) => cmp(a.itemKind, b.itemKind) || cmp(a.itemKey, b.itemKey));
      const chunks = [];
      for (let i = 0; i < deltas.length; i += maxDeltas) chunks.push(deltas.slice(i, i + maxDeltas));
      return { stationId: s.stationId, units: s.units, chunks };
    });
    plan.rows = S.factionRowBound(plan.stations.flatMap((s) => s.chunks.map((c) => c.length))) + demandRows;
    return plan;
  }

  function planDemand(tx, f, plan, records, advancedOn, graph) {
    const list = records.slice(0, X.maxStationsPerFaction);
    plan.demandStationsTruncated = Math.max(0, records.length - list.length);
    if (list.length === 0) return;
    const groups = advancedOn ? activeGroupsOf(tx, f) : new Map();
    const stations = list.map((s) => ({ stationId: s.stationId, systemId: s.systemId, kind: s.kind,
      lines: nominalLines(s.kind), activeGroups: groups.get(s.stationId) || [],
      fuel: fuelOn && s.kind === UPWELL }));
    const fuelStations = stations.filter((s) => s.fuel).length;
    const conversions = X.maxConversionsPerFaction > 0 ? X.maxConversionsPerFaction : 0;
    plan.demand = { advancedOn, stations, fuelStations,
      rows: S.demandRowBound({ conversions, maxSchematicDeltas: catalog.maxSchematicDeltas,
        fuelStations, fuelTypes: fuelPerPeriod.length }) };
    if (!transferOn) return;
    const donorOf = new Map();
    if (graph) {
      const npcBySystem = new Map();
      const recipientSystems = new Set();
      for (const s of stations) {
        if (s.kind === NPC && isId(s.systemId)) {
          const prev = npcBySystem.get(s.systemId);
          if (prev === undefined || cmp(s.stationId, prev) < 0) npcBySystem.set(s.systemId, s.stationId);
        } else if (s.kind === UPWELL && isId(s.systemId)) {
          recipientSystems.add(s.systemId);
        }
      }
      const homes = deliveryMap(graph, npcBySystem, recipientSystems);
      for (const s of stations) {
        if (s.kind === UPWELL && homes.has(s.systemId)) donorOf.set(s.stationId, homes.get(s.systemId));
      }
    }
    plan.demand.donorOf = donorOf;
    plan.demand.rows += S.transferRowBound({ pairs: Math.min(maxTransferPairs, donorOf.size), types: transferTypes });
  }

  function writeDemand(tx, plan, bucket, at, repository) {
    const d = plan.demand;
    const tally = { conversions: 0, conversionUnits: 0, conversionsTruncated: 0, conversionsRefused: 0, fuelBurned: 0,
      unfueled: 0 };
    const stocks = repository.getStocks(tx, d.stations.map((s) => s.stationId));
    if (!stocks || stocks.ok !== true) return stocks || { ok: false, reason: "STOCK_READ_FAILED" };
    const p = targetParams(d.advancedOn);
    const run = { attempts: 0, stopped: false, tally, tx, bucket, at, repository };
    const cellOf = (s) => {
      const got = stocks.byStation.get(s.stationId);
      const avail = stockMapOf(got && got.items);
      const target = stationTarget(catalog, s, p);
      return { s, avail, target, gross: expandGross(catalog, target, avail) };
    };
    if (!transferOn) {
      for (const s of d.stations) {
        const cell = cellOf(s);
        const refused = convertStation(cell, run) || burnStation(cell, run);
        if (refused) return refused;
      }
      return { ok: true, tally };
    }
    Object.assign(tally, { transfers: 0, transferUnits: 0, transfersRefused: 0, transfersTruncated: 0,
      transferNoDonor: 0 });
    const cells = d.stations.map(cellOf);
    for (const cell of cells) {
      const refused = convertStation(cell, run);
      if (refused) return refused;
    }
    const refused = transferStep(cells, d.donorOf, run);
    if (refused) return refused;
    for (const cell of cells) {
      const r = burnStation(cell, run);
      if (r) return r;
    }
    return { ok: true, tally };
  }

  function convertStation(cell, run) {
    const { s, gross } = cell;
    const { tally } = run;
    for (const t of run.stopped ? [] : conversionOrder(catalog, gross)) {
      const step = conversionStep(catalog, t, gross, cell.avail);
      if (!step) continue;
      if (run.attempts >= X.maxConversionsPerFaction) {
        run.stopped = true;
        tally.conversionsTruncated = X.maxConversionsPerFaction > 0 ? 1 : 0;
        break;
      }
      run.attempts += 1;
      const r = run.repository.applyStockChange(run.tx, { stationId: s.stationId,
        key: S.conversionKey(s.stationId, run.bucket, t), reason: S.CONVERSION_REASON, at: run.at, deltas: step.deltas });
      if (r && r.ok === true) {
        if (r.duplicate) continue;
        cell.avail = applyStep(cell.avail, step);
        tally.conversions += 1;
        tally.conversionUnits += step.deltas.find((x) => x.delta > 0).delta;
        continue;
      }
      const reason = (r && r.reason) || "STOCK_FAILED";
      if (!S.DEMAND_SOFT_REASONS.includes(reason)) return { ok: false, reason, stationId: s.stationId };
      tally.conversionsRefused += 1;
    }
    return null;
  }

  function burnStation(cell, run) {
    const { s } = cell;
    const { tally } = run;
    if (!s.fuel) return null;
    if (!fuelPerPeriod.every(([t, q]) => (cell.avail.get(t) || 0) >= q)) {
      tally.unfueled += 1;
      return null;
    }
    const deltas = fuelPerPeriod.map(([t, q]) => ({ itemKind: S.KIND_PI, itemKey: `${TYPE_PREFIX}${t}`, delta: -q }))
      .sort((a, b) => cmp(a.itemKey, b.itemKey));
    const r = run.repository.applyStockChange(run.tx, { stationId: s.stationId, key: S.fuelKey(s.stationId, run.bucket),
      reason: S.FUEL_REASON, at: run.at, deltas });
    if (r && r.ok === true) {
      tally.fuelBurned += 1;
      return null;
    }
    const reason = (r && r.reason) || "STOCK_FAILED";
    if (!S.DEMAND_SOFT_REASONS.includes(reason)) return { ok: false, reason, stationId: s.stationId };
    tally.unfueled += 1;
    return null;
  }

  function shortOf(target, avail) {
    const out = new Map();
    for (const [t, units] of target) {
      const n = units - (avail.get(t) || 0);
      if (n > 0) out.set(t, n);
    }
    return out;
  }

  function surplusOf(avail, gross) {
    const out = new Map();
    for (const [t, units] of avail) {
      const n = units - (gross.get(t) || 0);
      if (n > 0) out.set(t, n);
    }
    return out;
  }

  function transferInput(cells, donorOf) {
    const recipients = [];
    const surplus = new Map();
    for (const c of cells) {
      if (c.s.kind === UPWELL) {
        recipients.push({ stationId: c.s.stationId, donorId: donorOf.has(c.s.stationId) ? donorOf.get(c.s.stationId)
          : null, short: shortOf(c.target, c.avail) });
      } else if (c.s.kind === NPC) {
        surplus.set(c.s.stationId, surplusOf(c.avail, c.gross));
      }
    }
    return { recipients, surplus };
  }

  const deltasOf = (gives, sign) => gives.map((g) => ({ itemKind: catalog.kindOf(g.typeId),
    itemKey: `${TYPE_PREFIX}${g.typeId}`, delta: sign * g.units })).sort((a, b) => cmp(a.itemKey, b.itemKey));

  function transferStep(cells, donorOf, run) {
    const { tally, tx, bucket, at, repository } = run;
    const { recipients, surplus } = transferInput(cells, donorOf || new Map());
    const plan = planTransfers({ recipients, surplus, fuelTypes: fuelTypeSet, maxPairs: maxTransferPairs,
      maxTypes: transferTypes, rotate: bucket });
    tally.transferNoDonor += plan.noDonor;
    if (plan.truncated > 0) tally.transfersTruncated += 1;
    const cellBy = new Map(cells.map((c) => [c.s.stationId, c]));
    for (const pair of plan.pairs) {
      const r = inSavepoint(tx, () => {
        const out = repository.applyStockChange(tx, { stationId: pair.src,
          key: S.transferKey(pair.src, pair.dst, bucket, "out"), reason: S.TRANSFER_REASON, at,
          deltas: deltasOf(pair.gives, -1) });
        if (!out || out.ok !== true) return { ...(out || { ok: false, reason: "STOCK_FAILED" }), side: "out" };
        const inn = repository.applyStockChange(tx, { stationId: pair.dst,
          key: S.transferKey(pair.src, pair.dst, bucket, "in"), reason: S.TRANSFER_REASON, at,
          deltas: deltasOf(pair.gives, 1) });
        if (!inn || inn.ok !== true) return { ...(inn || { ok: false, reason: "STOCK_FAILED" }), side: "in" };
        if ((out.duplicate === true) !== (inn.duplicate === true)) return { ok: false, reason: "XFER_KEY_MIXED" };
        return { ok: true, duplicate: out.duplicate === true };
      });
      if (r && r.ok === true) {
        if (r.duplicate) continue;
        const src = cellBy.get(pair.src);
        const dst = cellBy.get(pair.dst);
        let units = 0;
        for (const g of pair.gives) {
          const left = (src.avail.get(g.typeId) || 0) - g.units;
          if (left > 0) src.avail.set(g.typeId, left);
          else src.avail.delete(g.typeId);
          dst.avail.set(g.typeId, (dst.avail.get(g.typeId) || 0) + g.units);
          units += g.units;
        }
        tally.transfers += 1;
        tally.transferUnits += units;
        continue;
      }
      const reason = (r && r.reason) || "STOCK_FAILED";
      if (!S.DEMAND_SOFT_REASONS.includes(reason)) return { ok: false, reason, stationId: r && r.side === "out" ? pair.src : pair.dst };
      tally.transfersRefused += 1;
    }
    return null;
  }

  function writeFaction(tx, plan, bucket, at, repository) {
    const f = plan.factionId;
    let moonUnits = 0;
    let piUnits = 0;
    let lostStockFull = 0;
    for (const s of plan.stations) {
      for (let i = 0; i < s.chunks.length; i += 1) {
        const chunk = s.chunks[i];
        const r = repository.applyStockChange(tx, { stationId: s.stationId, key: S.deliveryKey(f, bucket, s.stationId, i),
          reason: S.DELIVERY_REASON, at, deltas: chunk });
        const units = chunk.reduce((n, d) => n + d.delta, 0);
        if (r && r.ok === true) {
          if (r.duplicate) continue;
          for (const d of chunk) {
            if (d.itemKind === S.KIND_MOON) moonUnits += d.delta;
            else piUnits += d.delta;
          }
          continue;
        }
        const reason = (r && r.reason) || "STOCK_FAILED";
        if (S.LOSS_REASONS.includes(reason)) {
          lostStockFull += units;
          continue;
        }
        return { ok: false, reason, stationId: s.stationId };
      }
    }
    const lostUnits = plan.lostNoStation + lostStockFull;
    let demand = null;
    if (plan.demand) {
      const t0 = nowMs();
      demand = writeDemand(tx, plan, bucket, at, repository);
      if (!demand || demand.ok !== true) return demand || { ok: false, reason: "DEMAND_FAILED" };
      demand.ms = Math.max(0, nowMs() - t0);
    }
    const payload = { factionId: f, bucket, systems: plan.systems, stations: plan.stations.map((s) => s.stationId),
      moonUnits, piUnits, lostUnits };
    if (demand) Object.assign(payload, { conversions: demand.tally.conversions, fuelled: demand.tally.fuelBurned });
    if (demand && transferOn) payload.transfers = demand.tally.transfers;
    const marker = journal.applyOnce(tx, { key: S.markerKey(f, bucket),
      aggregate: { type: S.MARKER_AGGREGATE_TYPE, id: String(f) }, eventType: S.MARKER_EVENT, payload },
    () => ({ ok: true }));
    if (!marker || marker.ok !== true) return marker || { ok: false, reason: "MARKER_FAILED" };
    return { ok: true, moonUnits, piUnits, lostStockFull, lostUnits, demand };
  }

  function runPulse(tx, at) {
    const t0 = nowMs();
    const bucket = Math.floor(at / X.periodMs);
    const tally = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
    const out = { ok: true, bucket, skipped: null, cursor, cycles: [], tally, refusal: null, ms: 0, demandMs: null };
    const finish = () => {
      out.ms = Math.max(0, nowMs() - t0);
      return out;
    };
    const st = stationsNow();
    const graph = graphNow();
    if (!st.repository || !graph) {
      out.skipped = "PENDING";
      return finish();
    }
    const registry = typeof deps.getRegistry === "function" ? call(deps.getRegistry, null) : null;
    const listed = registry && typeof registry.listActiveFactions === "function"
      ? call(() => registry.listActiveFactions(), null) : null;
    if (!Array.isArray(listed)) {
      out.skipped = "REGISTRY_UNAVAILABLE";
      return finish();
    }
    const ids = [...new Set(listed.map((r) => r && r.factionId).filter(isId))].sort((a, b) => a - b);
    const start = ids.findIndex((id) => id > cursor);
    const order = start < 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
    let checks = 0;
    let processed = 0;
    let rowsUsed = 0;
    for (const f of order) {
      if (checks >= X.maxMarkerChecksPerPulse || processed >= X.maxFactionsPerPulse) break;
      checks += 1;
      const seen = journal.findByKey(tx, S.markerKey(f, bucket));
      if (!seen || seen.ok !== true) return seen || { ok: false, reason: "JOURNAL_READ_FAILED" };
      if (seen.found) {
        out.cursor = f;
        continue;
      }
      const plan = planFaction(tx, f, st, graph);
      if (!plan.ok) {
        tally.refused += 1;
        out.refusal = `${f}:${plan.reason}`;
        out.cursor = f;
        processed += 1;
        continue;
      }
      const rows = plan.rows === undefined ? S.MARKER_ROWS : plan.rows;
      if (rowsUsed + rows > deps.rowsCap) {
        if (rowsUsed === 0) {
          tally.refused += 1;
          out.refusal = `${f}:ROWS_OVER_BUDGET ${rows}>${deps.rowsCap}`;
          out.cursor = f;
          processed += 1;
          continue;
        }
        tally.rowsDeferred += 1;
        break;
      }
      processed += 1;
      out.cursor = f;
      const w = inSavepoint(tx, () => writeFaction(tx, plan, bucket, at, st.repository));
      rowsUsed += rows;
      if (!w || w.ok !== true) {
        tally.refused += 1;
        out.refusal = `${f}:${(w && w.reason) || "WRITE_FAILED"}`;
        continue;
      }
      tally.factionsProcessed += 1;
      tally.factionsMarked += 1;
      tally.systemsYielding += plan.yielding;
      if (plan.truncated) tally.systemsTruncated += 1;
      tally.claimedSystems += plan.claimed;
      tally.moonUnits += w.moonUnits;
      tally.piUnits += w.piUnits;
      tally.lostNoStation += plan.lostNoStation;
      tally.lostStockFull += w.lostStockFull;
      tally.stationsTruncated += plan.stationsTruncated;
      tally.cacheFull += plan.cacheFull;
      tally.demandStationsTruncated += plan.demandStationsTruncated || 0;
      if (w.demand) {
        for (const [name, n] of Object.entries(w.demand.tally)) tally[name] += n;
        out.demandMs = (out.demandMs || 0) + w.demand.ms;
      }
      out.cycles.push({ factionId: f, bucket, systems: plan.systems, moonUnits: w.moonUnits, piUnits: w.piUnits,
        lostUnits: w.lostUnits, bySystem: plan.bySystem });
    }
    return finish();
  }

  function onPulseCommitted(v) {
    bump("pulses");
    if (!v || v.ok !== true) return;
    for (const name of COUNTER_NAMES) if (name !== "pulses") bump(name, v.tally[name]);
    cursor = v.cursor;
    if (v.refusal) lastRefusal = String(v.refusal).slice(0, MAX_DETAIL);
    for (const c of v.cycles) {
      lastCycleByFaction.set(c.factionId, Object.freeze({ factionId: c.factionId, bucket: c.bucket,
        systems: c.systems, moonUnits: c.moonUnits, piUnits: c.piUnits, lostUnits: c.lostUnits }));
      for (const [systemId, units] of c.bySystem) {
        if (systemUnits.has(systemId) || systemUnits.size < X.maxCachedSystems) {
          systemUnits.set(systemId, Object.freeze({ factionId: c.factionId, units }));
        }
      }
    }
    seq += 1;
    metric("observe", "extraction.pulseMs", Math.round(v.ms * 100) / 100);
    if (v.demandMs !== null && v.demandMs !== undefined) {
      metric("observe", "extraction.demandMs", Math.round(v.demandMs * 100) / 100);
    }
  }

  function pulseHandler(ev, hctx) {
    try {
      if (state === "stopped") return { ok: false, reason: "EXTRACTION_STOPPED" };
      const now = hctx && isTime(hctx.now) ? hctx.now : clock.now();
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : now;
      const I = X.pulseIntervalMs;
      const n = Math.floor(at / I) + 1;
      return { ok: true, outcome: "PULSE", effect: (tx) => runPulse(tx, at),
        reschedule: { eventType: S.PULSE_EVENT, aggregateId: S.PULSE_AGGREGATE_ID, dueAt: n * I,
          payload: { intervalMs: I, round: n }, idempotencyKey: S.pulseKey(I, n) },
        onCommitted: onPulseCommitted };
    } catch (err) {
      return { ok: false, reason: `EXTRACTION_PULSE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      const I = X.pulseIntervalMs;
      const n = Math.floor(clock.now() / I) + 1;
      const r = scheduler.enqueue(S.PULSE_EVENT, S.PULSE_AGGREGATE_ID, n * I, { intervalMs: I, round: n },
        S.pulseKey(I, n));
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, duplicate: r.duplicate === true, dueAt: n * I };
    } catch (err) {
      return { ok: false, reason: `BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function yieldOf(systemId) {
    try {
      if (state === "stopped") return { ok: false, reason: "EXTRACTION_OFF" };
      const graph = graphNow();
      if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
      if (!isId(systemId) || !call(() => graph.getSystem(systemId), null)) return { ok: false, reason: "UNKNOWN_SYSTEM" };
      const cel = readCelestials([systemId], false);
      if (!cel.ok) return { ok: false, reason: "CELESTIALS_UNAVAILABLE" };
      const sys = cel.bySystem.get(systemId);
      const types = [...new Set(sys.planets.map((p) => p && p.typeId).filter(isId))].sort((a, b) => a - b);
      const p0 = readP0(types, false);
      if (!p0.ok) return { ok: false, reason: "CELESTIALS_UNAVAILABLE" };
      const y = yieldOfSystem(graph, systemId, sys, p0.map);
      if (!y || y.ok !== true) return { ok: false, reason: "CELESTIALS_UNAVAILABLE" };
      return { ok: true, moon: y.moon, pi: y.pi };
    } catch (_err) {
      return { ok: false, reason: "CELESTIALS_UNAVAILABLE" };
    }
  }

  function fuelledOf(tx, stationIds, at) {
    try {
      if (!fuelOn || getMode() !== MODE_READY) return { ok: true, enforced: false };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      const maxStations = config.stations && isId(config.stations.maxStations) ? config.stations.maxStations : 0;
      if (!Array.isArray(stationIds) || stationIds.length > maxStations || !isTime(at)
        || !stationIds.every((id) => typeof id === "string" && id.length > 0)) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const b = Math.floor(at / X.periodMs);
      const fuelled = new Set();
      for (const id of stationIds) {
        for (const bucket of [b, b - 1]) {
          if (bucket < 0) continue;
          const r = journal.findByKey(tx, S.fuelKey(id, bucket));
          if (!r || r.ok !== true) return r || { ok: false, reason: "JOURNAL_READ_FAILED" };
          if (r.found) {
            fuelled.add(id);
            break;
          }
        }
      }
      return { ok: true, enforced: true, fuelled };
    } catch (err) {
      return { ok: false, reason: `FUEL_READ_FAILED: ${messageOf(err)}` };
    }
  }

  function readNeeds(tx, factionId) {
    try {
      if (state === "stopped") return { ok: false, reason: "EXTRACTION_OFF" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (!isId(factionId)) return { ok: false, reason: "INVALID_INPUT" };
      const advanced = advancedNow();
      const enforced = { fuel: fuelOn, advanced: advanced !== null };
      if (!enforced.fuel && !enforced.advanced) {
        return { ok: true, enforced, stations: [], needs: [], truncated: false, shortKeys: [] };
      }
      const st = stationsNow();
      if (!st.repository) return { ok: false, reason: "STATIONS_NOT_READY" };
      const own = ownStations(tx, st.repository, factionId);
      if (!own.ok) return own;
      const plan = {};
      planDemand(tx, factionId, plan, own.records, enforced.advanced, transferOn ? graphNow() : null);
      if (!plan.demand) {
        return { ok: true, enforced, stations: [], needs: [], truncated: false, shortKeys: [], noDonorStations: 0 };
      }
      const list = plan.demand.stations;
      const stocks = st.repository.getStocks(tx, list.map((s) => s.stationId));
      if (!stocks || stocks.ok !== true) return stocks || { ok: false, reason: "STOCK_READ_FAILED" };
      const p = targetParams(enforced.advanced);
      const donorOf = transferOn && plan.demand.donorOf ? plan.demand.donorOf : new Map();
      const stations = [];
      const needs = [];
      const cells = [];
      const noDonor = new Set();
      for (const s of list) {
        const got = stocks.byStation.get(s.stationId);
        let avail = stockMapOf(got && got.items);
        const target = stationTarget(catalog, s, p);
        const gross = expandGross(catalog, target, avail);
        for (const t of conversionOrder(catalog, gross)) {
          const step = conversionStep(catalog, t, gross, avail);
          if (step) avail = applyStep(avail, step);
        }
        const reserve = [...gross.entries()].filter(([, units]) => units > 0).sort((a, b) => a[0] - b[0])
          .map(([typeId, units]) => ({ itemKind: catalog.kindOf(typeId), typeId, units }));
        stations.push({ stationId: s.stationId, systemId: s.systemId, kind: s.kind, reserve });
        if (transferOn) cells.push({ s, avail, target, gross });
        if (donorOf.has(s.stationId)) continue;
        for (const [typeId, units] of target) {
          const need = units - (avail.get(typeId) || 0);
          if (need > 0) {
            needs.push({ stationId: s.stationId, kind: s.kind, itemKind: catalog.kindOf(typeId), typeId, need });
            if (s.kind === UPWELL) noDonor.add(s.stationId);
          }
        }
      }
      if (donorOf.size > 0) substituteNeeds(cells, donorOf, stations, needs);
      needs.sort((a, b) => b.need - a.need || cmp(a.stationId, b.stationId) || a.typeId - b.typeId);
      const shortKeys = needs.map((n) => `${n.stationId}|type:${n.typeId}`).sort();
      return { ok: true, enforced, stations, needs: needs.slice(0, X.maxNeedsPerFaction),
        truncated: needs.length > X.maxNeedsPerFaction, shortKeys, noDonorStations: noDonor.size };
    } catch (err) {
      return { ok: false, reason: `NEEDS_READ_FAILED: ${messageOf(err)}` };
    }
  }

  function substituteNeeds(cells, donorOf, stations, needs) {
    const { recipients, surplus } = transferInput(cells, donorOf);
    const plan = planTransfers({ recipients, surplus, fuelTypes: fuelTypeSet, maxPairs: Infinity,
      maxTypes: Infinity, rotate: 0 });
    const byKey = new Map(needs.map((n) => [`${n.stationId}|${n.typeId}`, n]));
    for (const r of plan.rest) {
      if (r.donorId === null || r.donorId === undefined) continue;
      const key = `${r.donorId}|${r.typeId}`;
      const entry = byKey.get(key);
      if (entry) {
        entry.need += r.units;
        entry.viaTransfer = (entry.viaTransfer || 0) + r.units;
        continue;
      }
      const added = { stationId: r.donorId, kind: NPC, itemKind: catalog.kindOf(r.typeId), typeId: r.typeId,
        need: r.units, viaTransfer: r.units };
      byKey.set(key, added);
      needs.push(added);
    }
    const stationBy = new Map(stations.map((s) => [s.stationId, s]));
    for (const pair of plan.pairs) {
      const donor = stationBy.get(pair.src);
      if (!donor) continue;
      const reserve = new Map(donor.reserve.map((e) => [e.typeId, e.units]));
      for (const g of pair.gives) reserve.set(g.typeId, (reserve.get(g.typeId) || 0) + g.units);
      donor.reserve = [...reserve.entries()].sort((a, b) => a[0] - b[0])
        .map(([typeId, units]) => ({ itemKind: catalog.kindOf(typeId), typeId, units }));
    }
  }

  function getStatus() {
    return Object.freeze({ mode: getMode(), state, seq, lastRefusal, counters: Object.freeze({ ...counters }),
      lastCycleByFaction: [...lastCycleByFaction.values()].sort((a, b) => a.factionId - b.factionId),
      cachedSystems: celestials.size });
  }

  function topSystems(n) {
    return [...systemUnits.entries()].sort((a, b) => b[1].units - a[1].units || a[0] - b[0]).slice(0, n)
      .map(([systemId, e]) => ({ systemId, factionId: e.factionId, units: e.units }));
  }

  return Object.freeze({
    runPulse,
    pulseHandler,
    bootstrap,
    getMode,
    yieldOf,
    fuelledOf,
    readNeeds,
    getStatus,
    topSystems,
    stop(reason) {
      if (state === "stopped") return;
      state = "stopped";
      log(`extraction: stopped (${String(reason || "stop")})`);
    },
    isStopped: () => state === "stopped",
  });
}

module.exports = { createExtractionService, COUNTER_NAMES };
