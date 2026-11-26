"use strict";

const { performance } = require("node:perf_hooks");
const { createPoller } = require("../presence/poller");
const { contractLimitNotes } = require("../../config");
const S = require("./schema");
const { ARCHETYPE_DATA } = require("./data/archetypes");
const plan = require("./plan");
const { createFreeCorpRepository } = require("./repository");
const { createFreeCorpVentureRepository } = require("./ventureRepository");
const ventures = require("./ventures");
const { registerFreeCorpsView } = require("./view");
const { pickResidents } = require("./residents");
const { MAP_STYLES, buildMapMarks } = require("./mapMarks");
const { createResidentReads } = require("./residentReads");
const { createChatterReads } = require("./chatterReads");
const { createWormholeIndex } = require("./wormholeIndex");
const { MODE: WH_MODE } = require("./wormholeVentures");
const { deriveSeed } = require("../util/rng");
const { createFreeCorpWarRepository } = require("./warRepository");
const warsRules = require("./wars");
const { defenderPatch } = require("./hunting");
const outboxModule = require("./outboxRepository");
const { planKillmail } = require("./killmails");
const { createKillmailPump } = require("./killmailPump");
const contractModule = require("./contractRepository");
const { planContract, planGasContract } = require("./contracts");
const WH_CT_COUNTERS = Object.freeze({ NOT_ELIGIBLE: "whContractSkipNoGoods", NO_IDENTITY: "whContractSkipNoIdentity",
  NO_FACTS: "whContractSkipNoFacts", CHANCE: "whContractSkipChance", NO_GOODS: "whContractSkipNoGoods",
  SMALL_LOT: "whContractSkipSmallLot" });
const contractPumpModule = require("./contractPump");
const { CONTRACT_PUMP_MODE } = contractPumpModule;
const CT_PLAN_COUNTERS = Object.freeze({ NOT_ELIGIBLE: "ctSkipNotEligible", CHANCE: "ctSkipChance",
  NO_IDENTITY: "ctSkipNoIdentity", NO_GOODS: "ctSkipNoGoods", SMALL_LOT: "ctSkipSmallLot" });
const { planCourier } = require("./couriers");
const CR_PLAN_COUNTERS = Object.freeze({ NOT_ELIGIBLE: "ctCourierSkipNotEligible", CHANCE: "ctCourierSkipChance",
  NO_IDENTITY: "ctCourierSkipNoIdentity", NO_GOODS: "ctCourierSkipNoGoods", SMALL_LOT: "ctCourierSkipSmallLot",
  NO_DESTINATION: "ctCourierSkipNoDestination" });
const membersModule = require("./membersRepository");
const recycleRules = require("./recycle");
const { createRecyclePump, RECYCLE_PUMP_MODE } = require("./recyclePump");
const structureModule = require("./structureRepository");
const { createStructurePump } = require("./structurePump");
const whCorpModule = require("./whCorpRepository");
const { pickWhHome } = require("./whCorps");

const WAR_SCAN_LIMIT = 200;
const WAR_PLAN_COUNTERS = Object.freeze({ LIMIT: "warLimit", NO_TARGET: "warNoTarget", AT_WAR: "warAtWar" });
const WAR_END_COUNTERS = Object.freeze({ TIMEOUT: "warsTimedOut", SURRENDER: "warsSurrendered",
  SIDE_CLOSED: "warsSideClosed" });

const MAX_DETAIL = 160;
const DEFAULT_LAST_MAX_AGE_MS = 21600000;
const MS_DECIMALS = 10;
const MAX_MAP_LINES = 50;
const REQUIRED_FUNCTIONS = Object.freeze(["getGraph", "getVirtualCorps", "getGovernor", "listStations",
  "bloodlinesOf", "reservedNames"]);
const NOTE_COUNTERS = Object.freeze({ STALE: "foundingStale", VC_UNAVAILABLE: "vcUnavailable",
  REPAIR: "identityRepairs", CORP_ID_CHANGED: "corporationIdChanged", REFUSED_ACTIVE: "refusedActive" });
const PLAN_COUNTERS = Object.freeze({ NO_ARCHETYPE: "foundingNoArchetype", NO_HOME: "foundingNoHome",
  NAME_EXHAUSTED: "foundingNameExhausted", NO_ROOM: "foundingNoRoom", NO_WH_HOME: "whQuotaNoHome" });

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createUnavailableFreeCorps(reason) {
  const why = String(reason || "FREE_CORPS_UNAVAILABLE");
  const facade = {};
  for (const name of S.FACADE_METHODS) facade[name] = () => ({ ok: false, reason: why });
  facade.getStatus = () => Object.freeze({ state: "unavailable", reason: why });
  facade.stop = () => {};
  return Object.freeze(facade);
}

function persistenceOf(p) {
  return p && p.store && typeof p.store.transaction === "function" && p.journal
    && typeof p.journal.applyOnce === "function" && typeof p.journal.findByKey === "function" ? p : null;
}

function reservedOf(r) {
  return r && r.names instanceof Set && r.tickers instanceof Set ? r : null;
}

function startFreeCorps(deps) {
  const config = deps && deps.config;
  const S0 = config && config.freeCorps;
  if (!S0 || S0.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const vcModule = config.modules && config.modules.virtualCorps;
  if (!vcModule || vcModule.enabled !== true) {
    return { ok: false, reason: "disabled_by_dependency", detail: "modules.virtualCorps" };
  }
  const persistence = persistenceOf(deps.persistence);
  if (!persistence) return { ok: false, reason: "NO_PERSISTENCE_STORE" };
  for (const name of REQUIRED_FUNCTIONS) {
    if (typeof deps[name] !== "function") return { ok: false, reason: "MISSING_DEPS", detail: name };
  }
  const clock = deps.clock;
  if (!clock || typeof clock.now !== "function") return { ok: false, reason: "MISSING_DEPS", detail: "clock" };
  const raceIds = Array.isArray(deps.raceSourceFactionIds) ? deps.raceSourceFactionIds.slice() : [];
  if (raceIds.length === 0) return { ok: false, reason: "MISSING_DEPS", detail: "raceSourceFactionIds" };
  if (!Array.isArray(deps.excludedRegionIds)) return { ok: false, reason: "MISSING_DEPS", detail: "excludedRegionIds" };
  const worldSeed = persistence.worldSeed;
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0) {
    return { ok: false, reason: "MISSING_DEPS", detail: "persistence.worldSeed" };
  }
  const bandWeights = S.parseBandWeights(S0.bandWeights);
  const archetypeWeights = S.parseArchetypeWeights(S0.archetypeWeights);
  if (!bandWeights || !archetypeWeights) {
    return { ok: false, reason: "MISSING_DEPS", detail: bandWeights ? "freeCorps.archetypeWeights" : "freeCorps.bandWeights" };
  }
  const reserved = reservedOf(safe(() => deps.reservedNames(), null));
  if (!reserved) return { ok: false, reason: "MISSING_DEPS", detail: "reservedNames" };
  const budget = config.virtualCorps && Number.isSafeInteger(config.virtualCorps.ownerCharacterBudget)
    ? config.virtualCorps.ownerCharacterBudget : 0;
  const P = Object.freeze({ ...S0, bandWeights, archetypeWeights });
  const membersLo = Math.min(P.membersMin, P.membersMax);
  const excluded = new Set(deps.excludedRegionIds);
  const store = persistence.store;
  const journal = persistence.journal;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const repo = createFreeCorpRepository();
  const vrepo = createFreeCorpVentureRepository();
  const V = P.ventures && P.lifecycle && P.retention && P.ventures.enabled === true ? P.ventures : null;
  const R = P.retention || null;
  const W = V && P.wormholes && P.wormholes.enabled === true ? P.wormholes : null;
  const whMinLifeMs = config.wormholes && Number.isSafeInteger(config.wormholes.minRemainingMs)
    ? config.wormholes.minRemainingMs : 0;
  const H = V && P.hunting && P.hunting.enabled === true ? P.hunting : null;
  const Wr = V && P.wars && P.wars.enabled === true ? P.wars : null;
  const PVP = H !== null || Wr !== null;
  const warRepo = PVP ? createFreeCorpWarRepository() : null;
  const stOn = Boolean(P.structures && P.structures.enabled === true);
  const foundArchetypes = H || stOn ? Object.freeze({ ...ARCHETYPE_DATA,
    ...(H ? { hunter: Object.freeze({ ...ARCHETYPE_DATA.hunter, available: true }) } : {}),
    ...(stOn ? { structure: Object.freeze({ ...ARCHETYPE_DATA.structure, available: true }) } : {}) })
    : ARCHETYPE_DATA;
  const PF = H && !stOn ? P : Object.freeze({ ...P, archetypeWeights: new Map([...archetypeWeights]
    .map(([k, w]) => [k, k === "structure" || (!H && k === "hunter") ? 0 : w])) });
  const PQ = H ? Object.freeze({ ...P, archetypeWeights: new Map([["hunter", 1]]) }) : null;
  const PQS = stOn ? Object.freeze({ ...P, archetypeWeights: new Map([["structure", 1]]),
    initialIsk: P.structures.foundingIsk }) : null;
  const WC = V && P.whCorps && P.whCorps.enabled === true ? P.whCorps : null;
  const whRepo = V ? whCorpModule.createFreeCorpWhCorpRepository() : null;
  const PQW = WC ? Object.freeze({ ...P, archetypeWeights: new Map([["explorer", 1]]) }) : null;
  let whSeen = null;
  let whCorpCount = null;
  let hunterCount = null;
  let structureQuota = null;
  let preyRowsLast = null;
  let openWarCount = null;
  const KM = PVP && P.killmails && P.killmails.enabled === true ? P.killmails : null;
  const C = V && P.contracts && P.contracts.enabled === true ? P.contracts : null;
  const CU = C && C.courier && C.courier.enabled === true ? C.courier : null;
  let outbox = KM || C ? outboxModule.createFreeCorpOutboxRepository() : null;
  let contractRepo = C ? contractModule.createFreeCorpContractRepository() : null;
  const contractGoodsOf = () => {
    const g = typeof deps.contractGoods === "function" ? safe(() => deps.contractGoods(), null) : null;
    return g && g.ok === true && g.goods ? g.goods : null;
  };
  const hullEhpOf = typeof deps.hullEhpOf === "function" ? deps.hullEhpOf : () => null;
  const RC = V && P.recycle && P.recycle.enabled === true ? P.recycle : null;
  const members = membersModule.createFreeCorpMembersRepository();
  let membersPresent = false;
  const mergeCap = Math.min(P.membersMax, S.MAX_MEMBERS);
  if (RC && !outbox) outbox = outboxModule.createFreeCorpOutboxRepository();
  const CR = RC && RC.ceoReuse === true ? RC : null;
  const ceoContracts = CR ? contractRepo || contractModule.createFreeCorpContractRepository() : null;
  const ceoPeekFailed = new Set();
  let ceoPeekPausedUntil = 0;

  function returnUnadoptedCeoInTx(tx, corpId, characterId, now) {
    const g = repo.getInTx(tx, corpId);
    if (!g.ok) throw new Error(`ceo fallback read ${corpId}: ${g.reason}`);
    const row = g.row;
    if (!row || row.open !== 1 || row.ceo_character_id !== characterId) return "NONE";
    const source = row.ceo_source_corporation_id;
    const c = repo.clearCeoInTx(tx, { corpId, characterId, at: now });
    if (!c.ok) throw new Error(`ceo fallback clear ${corpId}: ${c.reason}`);
    if (!c.cleared) return "NONE";
    const wc = members.insertInTx(tx, { character_id: characterId, origin_corp_id: corpId, corp_id: null,
      state: S.MEMBER_STATES.FREE, vendor_corporation_id: source }, now);
    if (!wc.ok && wc.reason === "DUPLICATE") return "ANOMALY";
    if (!wc.ok) throw new Error(`ceo fallback return ${characterId}: ${wc.reason}`);
    membersPresent = true;
    return "RETURNED";
  }

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`freeCorps: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      if (kind === "observe") telemetry.observe(name, value, clock.now());
      else telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  const counters = Object.fromEntries(S.COUNTER_NAMES.map((name) => [name, 0]));
  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `freeCorps.${name}`, n);
  }
  const kindCounters = Object.fromEntries(S.VENTURE_KIND_COUNTER_NAMES.map((name) => [name, 0]));
  function bumpKind(kind, event) {
    const name = `${kind}.${event}`;
    if (!Object.prototype.hasOwnProperty.call(kindCounters, name)) return;
    kindCounters[name] += 1;
    metric("count", `freeCorps.ventures.${kind}.${event}`, 1);
  }

  let state = S.SERVICE_STATE.STARTING;
  let inPass = false;
  let salt = 0;
  let nextFoundingCheckAt = 0;
  let writeVersion = 0;
  let lastPass = null;
  let population = null;
  let ownerCharacters = null;
  let lastError = null;
  let viewHandle = null;
  let openVentureCount = null;

  function vcOf() {
    const vc = safe(() => deps.getVirtualCorps(), null);
    return vc && typeof vc.ensureOwnerIdentity === "function" && typeof vc.getOwnerIdentity === "function"
      && typeof vc.countOwnerCharacters === "function" ? vc : null;
  }

  function graphOf() {
    const g = safe(() => deps.getGraph(), null);
    return g && g.ok === true && g.graph && typeof g.graph.getSystem === "function" ? g.graph : null;
  }

  let systemsGraph = null;
  const systemsMemo = new Map();
  function systemsOf(graph, band) {
    if (systemsGraph !== graph) {
      systemsGraph = graph;
      systemsMemo.clear();
    }
    if (!systemsMemo.has(band)) {
      const ids = safe(() => graph.getSystemsBySecClass(band), null) || [];
      const list = ids.filter((id) => {
        const v = safe(() => graph.getSystem(id), null);
        return Boolean(v) && !excluded.has(v.regionId);
      }).sort((a, b) => a - b);
      systemsMemo.set(band, Object.freeze(list));
    }
    return systemsMemo.get(band);
  }

  const stationsMemo = new Map();
  function stationsOf(systemId) {
    if (stationsMemo.has(systemId)) return stationsMemo.get(systemId);
    const r = safe(() => deps.listStations(systemId), null);
    if (!r || r.ok !== true || !Array.isArray(r.stations)) return [];
    const list = Object.freeze(r.stations.filter((st) => st && Number.isSafeInteger(st.stationId) && st.stationId > 0)
      .map((st) => Object.freeze({ stationId: st.stationId,
        corporationId: Number.isSafeInteger(st.corporationId) && st.corporationId > 0 ? st.corporationId : null })));
    stationsMemo.set(systemId, list);
    return list;
  }

  let reachGraph = null;
  const reachMemo = new Map();
  function reachOf(graph, home) {
    if (!V || !graph || typeof deps.bfs !== "function" || typeof graph.getNeighbors !== "function") return null;
    if (reachGraph !== graph) {
      reachGraph = graph;
      reachMemo.clear();
    }
    if (reachMemo.has(home)) return reachMemo.get(home);
    if (!safe(() => graph.getSystem(home), null)) return null;
    const found = safe(() => deps.bfs([home], (id) => graph.getNeighbors(id),
      { maxJumps: V.maxJumps, maxSystems: V.maxBfsSystems }), null);
    if (!(found instanceof Map)) return null;
    const list = [];
    for (const [systemId, jumps] of found) {
      const v = safe(() => graph.getSystem(systemId), null);
      if (v && !excluded.has(v.regionId)) list.push(Object.freeze({ systemId, jumps, secClass: v.secClass }));
    }
    list.sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId);
    if (reachMemo.size >= V.reachMemoMax) reachMemo.clear();
    const frozen = Object.freeze(list);
    reachMemo.set(home, frozen);
    return frozen;
  }

  const beltsMemo = new Map();
  function beltsOf(systemId) {
    if (beltsMemo.has(systemId)) return beltsMemo.get(systemId);
    if (typeof deps.readSystemBelts !== "function") return null;
    const r = safe(() => deps.readSystemBelts([systemId]), null);
    const n = r && r.ok === true && r.counts instanceof Map ? r.counts.get(systemId) : undefined;
    if (!Number.isSafeInteger(n) || n < 0) return null;
    beltsMemo.set(systemId, n);
    return n;
  }

  const whIndex = W ? createWormholeIndex({ graph: () => graphOf(), excluded, bfs: deps.bfs,
    settings: { maxWhJumps: W.maxWhJumps, maxBfsSystems: V.maxBfsSystems, maxExitCandidates: W.maxExitCandidates,
      maxReturnJumps: W.maxReturnJumps, indexRefreshMs: W.indexRefreshMs }, nowMs }) : null;
  let whMode = null;
  let whWaitSince = null;

  function whModeOf(now) {
    if (!W) return null;
    const whs = typeof deps.getWormholes === "function" ? safe(() => deps.getWormholes(), null) : null;
    if (!whs || typeof whs.isSynced !== "function") return WH_MODE.OFFLINE;
    const st = typeof whs.getStatus === "function" ? safe(() => whs.getStatus(), null) : null;
    if (st && st.vendorDisabled === true) return WH_MODE.OFFLINE;
    if (safe(() => whs.isSynced(), false) !== true) return WH_MODE.WAIT;
    const r = whIndex.refresh(now);
    if (!r.ok) {
      if (r.reason === "INDEX_FAILED") bump("whIndexFailed");
      return WH_MODE.WAIT;
    }
    if (r.rebuilt) {
      bump("whIndexBuilds");
      metric("observe", "freeCorps.whIndexMs", Math.round(r.ms * MS_DECIMALS) / MS_DECIMALS);
      if (WC) metric("gauge", "freeCorps.whKjPairs", whIndex.kjPairs());
    }
    return WH_MODE.LIVE;
  }

  function whEnvOf(mode, graph, waitSince) {
    if (mode === null) return undefined;
    let searches = 0;
    return Object.freeze({ mode, minLifeMs: whMinLifeMs, waitSince,
      entriesOf: (systemId) => whIndex.entriesOf(systemId),
      isLinked: (route) => whIndex.isLinked(route),
      findExit: (jSystemId, homeSystemId) => {
        if (searches >= W.maxExitSearchesPerPass) return { ok: false, reason: "DEFERRED" };
        searches += 1;
        return whIndex.findExit(jSystemId, homeSystemId, reachOf(graph, homeSystemId));
      } });
  }

  const haulWanted = Boolean(WC && W && WC.haul && WC.haul.enabled === true);
  const whHubIds = haulWanted ? S.parseWhHubSystemIds(WC.haul.hubSystemIds) : null;
  const HW = whHubIds ? WC.haul : null;
  if (haulWanted && !whHubIds) bump("whHaulBadHubs");
  const WCT = WC && HW && C && WC.contracts && WC.contracts.enabled === true ? WC.contracts : null;
  const HUB_DEFERRED = Object.freeze({ ok: false, reason: "DEFERRED" });
  const NO_HUB = Object.freeze({ ok: false, reason: "NO_HUB" });

  function haulEnvOf(graph) {
    if (!HW || !graph) return null;
    let searches = 0;
    const memo = new Map();
    const routeJumps = (from, to) => {
      if (from === to) return 0;
      const r = typeof graph.findRoute === "function"
        ? safe(() => graph.findRoute(from, to, { maxJumps: HW.maxHubJumps }), null) : null;
      return r && r.ok === true && Number.isSafeInteger(r.jumps) && r.jumps <= HW.maxHubJumps ? r.jumps : null;
    };
    return Object.freeze({ hubIds: whHubIds,
      hubOf: (exitSystemId) => {
        if (memo.has(exitSystemId)) return memo.get(exitSystemId);
        if (searches >= HW.maxHubSearchesPerPass) return HUB_DEFERRED;
        searches += 1;
        let best = null;
        for (const hub of whHubIds) {
          const jumps = routeJumps(exitSystemId, hub);
          if (jumps === null) continue;
          if (!best || jumps < best.jumps || (jumps === best.jumps && hub < best.hubSystemId)) {
            best = { hubSystemId: hub, jumps };
          }
        }
        const out = best ? Object.freeze({ ok: true, hubSystemId: best.hubSystemId, jumps: best.jumps }) : NO_HUB;
        memo.set(exitSystemId, out);
        return out;
      },
      bandOf: (systemId) => {
        const v = safe(() => graph.getSystem(systemId), null);
        return v && typeof v.secClass === "string" ? v.secClass : null;
      } });
  }

  const raidWanted = Boolean(WC && W && WC.raid && WC.raid.enabled === true);
  const raidBands = raidWanted ? S.parseRaidBands(WC.raid.bands) : null;
  const RW = raidBands ? WC.raid : null;
  if (raidWanted && !raidBands) bump("whRaidBadBands");
  const WH_GRAPH_WAIT = Object.freeze({ haul: HW !== null, raid: RW !== null });
  let areaGraph = null;
  const areaMemo = new Map();
  const AREA_DEFERRED = Object.freeze({ ok: false, reason: "DEFERRED" });
  const NO_CARGO_OPS = new Set(["haulDone", "raidDone"]);

  function raidEnvOf(graph) {
    if (!RW || !graph) return null;
    if (areaGraph !== graph) {
      areaGraph = graph;
      areaMemo.clear();
    }
    let plans = 0;
    let builds = 0;
    return Object.freeze({
      takePlan: () => {
        if (plans >= RW.maxPlansPerPass) return false;
        plans += 1;
        return true;
      },
      areaOf: (k) => {
        if (areaMemo.has(k)) return areaMemo.get(k);
        if (builds >= RW.maxAreaBuildsPerPass || typeof deps.bfs !== "function"
          || typeof graph.getNeighbors !== "function" || !safe(() => graph.getSystem(k), null)) return AREA_DEFERRED;
        builds += 1;
        const found = safe(() => deps.bfs([k], (id) => graph.getNeighbors(id),
          { maxJumps: RW.maxJumps, maxSystems: RW.maxBfsSystems }), null);
        if (!(found instanceof Map)) return AREA_DEFERRED;
        const list = [];
        for (const [systemId, jumps] of found) {
          const v = safe(() => graph.getSystem(systemId), null);
          if (v && !excluded.has(v.regionId) && raidBands.includes(v.secClass)) {
            list.push(Object.freeze({ systemId, jumps, secClass: v.secClass }));
          }
        }
        list.sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId);
        if (areaMemo.size >= RW.areaMemoMax) areaMemo.clear();
        const out = Object.freeze({ ok: true, systems: Object.freeze(list) });
        areaMemo.set(k, out);
        return out;
      },
      bandOf: (systemId) => {
        const v = safe(() => graph.getSystem(systemId), null);
        return v && typeof v.secClass === "string" ? v.secClass : null;
      } });
  }

  function once(tx, key, corpId, eventType, payload, fn) {
    const seen = journal.findByKey(tx, key);
    if (!seen.ok) throw new Error(`journal read ${key}: ${seen.reason}`);
    if (seen.found) return { ok: true, duplicate: true };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: corpId }, eventType, payload }, fn);
    if (r.ok) return { ok: true, duplicate: r.duplicate === true };
    if (r.reason === "APPLY_REFUSED") {
      return { ok: false, reason: String((r.refusal && r.refusal.reason) || "REFUSED") };
    }
    throw new Error(`journal ${key}: ${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`);
  }

  function runPassTx(tx, { now, t0, vc, graph, wh, km, ct, rc, cr, haul = null, raid = null, whGasKnown = null }) {
    const whGraphWait = wh && wh.mode !== WH_MODE.OFFLINE && !graph ? WH_GRAPH_WAIT : null;
    const tallies = {};
    const tally = (name) => { tallies[name] = (tallies[name] || 0) + 1; };
    const ensures = [];
    let wrote = false;
    let truncated = false;
    let processed = 0;
    let founded = 0;
    let activated = 0;
    let refused = 0;
    const due = repo.listDueInTx(tx, { now, limit: P.maxCorpsPerPass });
    if (!due.ok) return due;
    let whPresent = false;
    if (whRepo) {
      if (WC) {
        whPresent = true;
      } else if (whSeen !== false) {
        const a = whRepo.anyOpenInTx(tx);
        if (!a.ok) throw new Error(`wh homes: ${a.reason}`);
        whPresent = a.any;
      }
    }
    const whHomes = new Map();
    const whCorpOf = whPresent ? (corpId) => {
      if (!whHomes.has(corpId)) {
        const g = whRepo.getOpenInTx(tx, corpId);
        if (!g.ok) throw new Error(`wh home ${corpId}: ${g.reason}`);
        whHomes.set(corpId, g.row);
      }
      return whHomes.get(corpId);
    } : () => null;
    const applyWhPatch = (corpId, d, db = tx) => {
      const home = whCorpOf(corpId);
      if (!home) {
        tally("whHomeOrphan");
        return;
      }
      let patch;
      if (d.op === undefined) {
        const max = P.whCorps.home.stockMaxIsk;
        const lootWant = home.loot_isk + d.loot;
        const loot = Math.max(home.loot_isk, Math.min(lootWant, Math.max(0, max - home.gas_isk)));
        const gasWant = home.gas_isk + d.gas;
        const gas = Math.max(home.gas_isk, Math.min(gasWant, Math.max(0, max - loot)));
        if (loot < lootWant || gas < gasWant) tally("whStockCapped");
        patch = { loot_isk: loot, gas_isk: gas, pi_isk_total: home.pi_isk_total + d.pi,
          home_done: home.home_done + d.home_done };
      } else {
        const owner = d.op === "load" ? null : d.seq;
        if (!NO_CARGO_OPS.has(d.op) && home.cargo_venture_seq !== owner) {
          throw new Error(`wh home ${corpId} ${d.op}: CARGO_MISMATCH ${home.cargo_venture_seq}`);
        }
        const empty = { cargo_loot_isk: 0, cargo_gas_isk: 0, cargo_venture_seq: null };
        if (d.op === "load") {
          patch = { cargo_loot_isk: home.loot_isk, cargo_gas_isk: home.gas_isk, loot_isk: 0, gas_isk: 0,
            cargo_venture_seq: d.seq };
        } else if (d.op === "restore") {
          patch = { ...empty, loot_isk: Math.min(Number.MAX_SAFE_INTEGER, home.loot_isk + home.cargo_loot_isk),
            gas_isk: Math.min(Number.MAX_SAFE_INTEGER, home.gas_isk + home.cargo_gas_isk) };
        } else if (d.op === "drop") {
          patch = empty;
        } else if (d.op === "sell") {
          const sold = BigInt(home.sold_isk_total) + BigInt(d.sale);
          const cap = BigInt(Number.MAX_SAFE_INTEGER);
          patch = { ...empty, sold_isk_total: Number(sold > cap ? cap : sold) };
        } else if (d.op === "haulDone") {
          patch = { haul_done: home.haul_done + 1 };
        } else if (d.op === "raidDone") {
          patch = { raid_done: home.raid_done + 1 };
        } else {
          throw new Error(`wh home ${corpId}: unknown op ${d.op}`);
        }
      }
      const u = whRepo.updateInTx(db, { corpId, expectedVersion: home.version, now, patch });
      if (!u.ok) throw new Error(`wh home ${corpId} update: ${u.reason}`);
      whHomes.set(corpId, u.row);
    };
    const pushEnsure = (row) => {
      const spec = graph ? safe(() => plan.specOf(row, graph, deps.bloodlinesOf, ARCHETYPE_DATA), null) : null;
      if (spec) ensures.push(spec);
      else tally("specMissing");
    };
    let vcReady = null;
    const vcIsReady = () => {
      if (vcReady === null) {
        const oc = vc ? safe(() => vc.countOwnerCharacters(), null) : null;
        vcReady = Boolean(oc && oc.ok === true && oc.ready === true);
      }
      return vcReady;
    };
    let roomBase = null;
    let grownInPass = 0;
    const memberRoom = () => {
      if (roomBase === null) {
        const oc = vc ? safe(() => vc.countOwnerCharacters(), null) : null;
        if (!oc || oc.ok !== true || oc.ready !== true) {
          roomBase = 0;
        } else {
          const st = repo.statsInTx(tx);
          if (!st.ok) throw new Error(`stats: ${st.reason}`);
          roomBase = budget - (oc.total + st.pendingMembers);
        }
      }
      return roomBase - grownInPass;
    };
    let openStructureCorps = null;
    const structureHold = stPump && structureRepo ? Object.freeze({
      minIsk: Math.max(P.structures.minCorpIsk, P.structures.anchorCostIsk),
      hasOpen: (corpId) => {
        if (openStructureCorps === null) {
          const r = structureRepo.openCorpIdsInTx(tx);
          if (!r.ok) throw new Error(`open structures: ${r.reason}`);
          openStructureCorps = r.ids;
        }
        return openStructureCorps.has(corpId);
      } }) : null;
    let presenceMissing = false;
    const presence = V ? safe(() => (typeof deps.getPresence === "function" ? deps.getPresence() : null), null) : null;
    const isObserved = (systemId) => {
      if (!presence || typeof presence.isObserved !== "function") {
        if (!presenceMissing) tally("presenceUnavailable");
        presenceMissing = true;
        return false;
      }
      return safe(() => presence.isObserved(systemId), false) === true;
    };
    const kindEvents = [];
    const touched = new Set();
    const dirtySincePrey = new Set();
    const declaredNow = new Set();
    let fights = 0;
    let helds = 0;
    let declarations = 0;
    let preyRows = null;
    const warsById = new Map();
    let warIdx = null;
    if (Wr) {
      const lw = warRepo.listOpenInTx(tx, { limit: WAR_SCAN_LIMIT });
      if (!lw.ok) throw new Error(`wars read: ${lw.reason}`);
      for (const w of lw.rows) warsById.set(w.war_id, w);
      warIdx = warsRules.indexWars([...warsById.values()]);
    }
    const hp = P.hunting || {};
    const pvpEnv = PVP ? Object.freeze({ hunting: H !== null, wars: Wr !== null,
      warOf: (corpId) => (warIdx ? warIdx.byCorp.get(corpId) || null : null),
      prey: () => {
        if (preyRows === null) {
          const pr = vrepo.listPreyInTx(tx, { limit: hp.maxPreyRows });
          if (!pr.ok) throw new Error(`prey read: ${pr.reason}`);
          preyRows = pr.rows;
          dirtySincePrey.clear();
          tally("huntPreyBuilds");
          if (pr.truncated) tally("huntPreyTruncated");
        }
        return preyRows;
      },
      isExcluded: (corpId) => touched.has(corpId) || dirtySincePrey.has(corpId),
      budgetLeft: () => hp.maxSkirmishesPerPass - (fights + helds) }) : undefined;
    const regionOf = (systemId) => {
      const v = graph ? safe(() => graph.getSystem(systemId), null) : null;
      return v && Number.isSafeInteger(v.regionId) ? v.regionId : null;
    };
    const touch = (corpId) => {
      touched.add(corpId);
      dirtySincePrey.add(corpId);
    };
    const freshCorp = (corpId, what) => {
      const g = repo.getOpenInTx(tx, corpId);
      if (!g.ok) throw new Error(`${what} ${corpId} read: ${g.reason}`);
      return g.row;
    };
    const writeCorp = (corp, values, what) => {
      const w = repo.advanceCorpInTx(tx, { corpId: corp.corp_id, expectedVersion: corp.version,
        expectedState: corp.state, row: { ...values, corporation_id: null }, at: now });
      if (!w.ok) throw new Error(`${what} ${corp.corp_id} advance: ${w.reason}`);
    };
    const moneyValues = (corp, isk) => {
      const c = { ...ventures.corpValues(corp), next_at: corp.next_at };
      if (isk >= 0) {
        c.isk += isk;
        c.isk_earned += isk;
      } else {
        const paid = Math.min(c.isk, -isk);
        c.isk -= paid;
        c.isk_lost += paid;
      }
      return c;
    };

    let poolCount = null;
    let poolClaims = 0;
    let merges = 0;
    let freedUncounted = 0;
    const poolLeft = () => {
      if (poolCount === null) {
        const c = members.countFreeInTx(tx);
        if (!c.ok) throw new Error(`pool count: ${c.reason}`);
        poolCount = c.count - freedUncounted;
      }
      return poolCount - poolClaims;
    };
    const warPairOpen = (a, b) => {
      const w = warIdx ? warIdx.byCorp.get(a) : null;
      return Boolean(w && w.enemies.includes(b));
    };
    const recycleEnv = rc ? Object.freeze({ poolLeft,
      mergePartnerOf: (corp) => {
        if (merges >= RC.maxMergesPerPass) return { partner: null, budget: true };
        const pr = repo.mergePartnersInTx(tx, { archetype: corp.archetype, minIsk: RC.mergeMinPartnerIsk,
          limit: RC.mergeScanLimit });
        if (!pr.ok) throw new Error(`merge partners: ${pr.reason}`);
        const partner = recycleRules.pickMergePartner(corp, pr.rows, { regionOf,
          excluded: (id) => touched.has(id) || dirtySincePrey.has(id), warPairOpen, cap: mergeCap });
        if (partner) merges += 1;
        return { partner, budget: false };
      } }) : undefined;
    const enqueueJoin = (characterId, moves, corpId) => {
      const e = outbox.enqueueInTx(tx, { key: S.keyJoin(characterId, moves), kind: S.OUTBOX_KIND_JOIN,
        payload: { v: 1, characterId, corpId, seq: moves }, now });
      if (!e.ok) throw new Error(`join ${characterId}:${moves}: ${e.reason}`);
    };
    const recruitInto = (corpId, k) => {
      if (!(k > 0)) return;
      const lf = members.listFreeInTx(tx, { limit: k });
      if (!lf.ok) throw new Error(`pool read: ${lf.reason}`);
      if (lf.rows.length < k) throw new Error(`pool short: ${lf.rows.length} < ${k}`);
      for (const m of lf.rows) {
        const mv = members.moveInTx(tx, { characterId: m.character_id, expectedVersion: m.version, corpId,
          state: S.MEMBER_STATES.JOINING, now, moves: m.moves });
        if (!mv.ok) throw new Error(`recruit ${m.character_id}: ${mv.reason}`);
        enqueueJoin(m.character_id, mv.moves, corpId);
        poolClaims += 1;
      }
    };
    const applyClose = (row, r, identity) => {
      const lr = members.listByCorpInTx(tx, row.corp_id);
      if (!lr.ok) throw new Error(`recruits ${row.corp_id}: ${lr.reason}`);
      const partner = r.merge ? freshCorp(r.merge.partner.corp_id, "merge partner") : null;
      if (r.merge && !partner) throw new Error(`merge partner ${r.merge.partner.corp_id} not open`);
      const pc = recycleRules.planClose({ weak: row, identity, recruits: lr.rows, partner, cap: mergeCap });
      if (partner) {
        const pv = { ...ventures.corpValues(partner), next_at: partner.next_at };
        pv.members_target += pc.moved;
        pv.recruited = (pv.recruited || 0) + pc.moved;
        pv.isk += r.merge.isk;
        writeCorp(partner, pv, "merge partner");
        touch(partner.corp_id);
      }
      const vendorCorp = row.corporation_id || (identity && identity.corporationId) || null;
      for (const mv of pc.moves) {
        const state = mv.to === null ? S.MEMBER_STATES.FREE : S.MEMBER_STATES.JOINING;
        let moves;
        if (mv.existing) {
          const w = members.moveInTx(tx, { characterId: mv.characterId, expectedVersion: mv.existing.version,
            corpId: mv.to, state, now, moves: mv.existing.moves });
          if (!w.ok) throw new Error(`member ${mv.characterId}: ${w.reason}`);
          moves = w.moves;
        } else {
          const w = members.insertInTx(tx, { character_id: mv.characterId, origin_corp_id: row.corp_id, corp_id: mv.to,
            state, vendor_corporation_id: vendorCorp }, now);
          if (!w.ok && w.reason === "DUPLICATE") {
            tally("rcMemberAnomaly");
            continue;
          }
          if (!w.ok) throw new Error(`member ${mv.characterId}: ${w.reason}`);
          moves = w.moves;
        }
        membersPresent = true;
        if (mv.to === null) tally("rcFreed");
        else enqueueJoin(mv.characterId, moves, mv.to);
      }
      if (row.corporation_id) {
        const description = recycleRules.closeDescription(r.transition, now, partner ? partner.name : null);
        const e = outbox.enqueueInTx(tx, { key: S.keyClose(row.corp_id), kind: S.OUTBOX_KIND_CORP_CLOSE,
          payload: { v: 1, corpId: row.corp_id, corporationId: row.corporation_id, description }, now });
        if (!e.ok) throw new Error(`close ${row.corp_id}: ${e.reason}`);
      }
    };
    const releaseRecruits = (row, counter = "rcReleasedRefused") => {
      const lr = members.listByCorpInTx(tx, row.corp_id);
      if (!lr.ok) throw new Error(`recruits ${row.corp_id}: ${lr.reason}`);
      for (const m of lr.rows) {
        const w = members.moveInTx(tx, { characterId: m.character_id, expectedVersion: m.version, corpId: null,
          state: S.MEMBER_STATES.FREE, now, moves: m.moves });
        if (!w.ok) throw new Error(`release ${m.character_id}: ${w.reason}`);
        tally(counter);
      }
    };

    let kmPending = null;
    const identityOf = (corpId) => {
      const id = vc ? safe(() => vc.getOwnerIdentity(S.OWNER_KIND, corpId), null) : null;
      if (!membersPresent || !id || id.ok !== true || id.state !== "LINKED" || !Array.isArray(id.characterIds)) return id;
      const lm = members.listMembersOfCorpsInTx(tx, [corpId]);
      if (!lm.ok) throw new Error(`members ${corpId}: ${lm.reason}`);
      const extra = lm.byCorp.get(corpId) || [];
      return extra.length === 0 ? id : { ...id, characterIds: id.characterIds.concat(extra) };
    };
    function enqueueKillmail(row, defCorp, skRow) {
      if (kmPending === null) {
        const cp = outbox.countPendingInTx(tx, { kind: S.OUTBOX_KIND_KILLMAIL });
        if (!cp.ok) throw new Error(`outbox count: ${cp.reason}`);
        kmPending = cp.count;
      }
      if (kmPending >= KM.maxPending) {
        tally("kmBacklogDrop");
        return;
      }
      const pk = planKillmail({ skirmish: skRow, attacker: { archetype: row.archetype, identity: identityOf(row.corp_id) },
        defender: { archetype: defCorp.archetype, identity: identityOf(defCorp.corp_id) },
        maxAttackers: KM.maxAttackers, hullEhpOf });
      if (!pk.ok) {
        tally(pk.reason === "NO_PILOTS" ? "kmNoPilots" : "kmNoIdentity");
        return;
      }
      const e = outbox.enqueueInTx(tx, { key: S.killmailKeyOf(skRow.skirmish_id), kind: S.OUTBOX_KIND_KILLMAIL,
        payload: pk.payload, now });
      if (!e.ok) throw new Error(`killmail ${skRow.skirmish_id}: ${e.reason}`);
      kmPending += 1;
      tally("kmEnqueued");
    }

    let ctOpen = null;
    let ctPlans = 0;
    function planContractInTx(row, r, identity) {
      if (ctPlans >= C.maxPlansPerPass) {
        tally("ctSkipPassBudget");
        return;
      }
      const venture = r.venture.row;
      const p = planContract({ corp: { ...row, ...r.corp }, venture, identity, goods: ct, S: C, now,
        payout: ventures.payoutOf(venture, P.ventures) });
      if (!p.ok) {
        tally(CT_PLAN_COUNTERS[p.reason]);
        return;
      }
      if (ctOpen === null) {
        const co = contractRepo.countOpenInTx(tx);
        if (!co.ok) throw new Error(`contracts count: ${co.reason}`);
        ctOpen = co.count;
      }
      if (ctOpen >= C.maxOpen) {
        tally("ctSkipFull");
        return;
      }
      const cc = contractRepo.countOpenForCorpInTx(tx, row.corp_id);
      if (!cc.ok) throw new Error(`contracts corp count: ${cc.reason}`);
      if (cc.count >= C.maxPerCorp) {
        tally("ctSkipCorpFull");
        return;
      }
      const lt = contractRepo.lotTakenInTx(tx, { corpId: p.row.corp_id, stationId: p.row.station_id,
        typeId: p.row.type_id });
      if (!lt.ok) throw new Error(`contracts lot: ${lt.reason}`);
      if (lt.taken) {
        tally("ctSkipSameLot");
        return;
      }
      const ins = contractRepo.insertPlannedInTx(tx, p.row);
      if (!ins.ok) throw new Error(`contract ${p.row.contract_key}: ${ins.reason}`);
      const e = outbox.enqueueInTx(tx, { key: p.outbox.key, kind: p.outbox.kind, payload: p.outbox.payload, now });
      if (!e.ok) throw new Error(`contract outbox ${p.outbox.key}: ${e.reason}`);
      ctOpen += 1;
      ctPlans += 1;
      tally("ctPlanned");
    }

    const whOffers = new Map();
    function whContractOffer(row, identity, venture, whRow) {
      const skip = (counter) => {
        tally(counter);
        return { ok: false, reason: counter };
      };
      if (ctPlans >= C.maxPlansPerPass) return skip("whContractSkipLimit");
      const stations = stationsOf(venture.target_system_id).slice().sort((a, b) => a.stationId - b.stationId);
      if (stations.length === 0) return skip("whContractSkipNoStation");
      const p = planGasContract({ corp: row, venture, identity, goods: ct, known: whGasKnown, S: C, WS: WCT,
        gasIsk: whRow.cargo_gas_isk, stationId: stations[0].stationId, now });
      if (!p.ok) return skip(WH_CT_COUNTERS[p.reason] || "whContractSkipNoGoods");
      if (ctOpen === null) {
        const co = contractRepo.countOpenInTx(tx);
        if (!co.ok) throw new Error(`contracts count: ${co.reason}`);
        ctOpen = co.count;
      }
      if (ctOpen >= C.maxOpen) return skip("whContractSkipLimit");
      const cc = contractRepo.countOpenForCorpInTx(tx, row.corp_id);
      if (!cc.ok) throw new Error(`contracts corp count: ${cc.reason}`);
      if (cc.count >= C.maxPerCorp) return skip("whContractSkipLimit");
      const lt = contractRepo.lotTakenInTx(tx, { corpId: p.row.corp_id, stationId: p.row.station_id,
        typeId: p.row.type_id });
      if (!lt.ok) throw new Error(`contracts lot: ${lt.reason}`);
      if (lt.taken) return skip("whContractSkipLimit");
      whOffers.set(row.corp_id, p);
      return { ok: true, gasIsk: p.gasIsk, contractKey: p.row.contract_key };
    }

    let crOpen = null;
    function planCourierInTx(row, r, identity) {
      if (ctPlans >= C.maxPlansPerPass) {
        tally("ctSkipPassBudget");
        return;
      }
      const venture = r.venture.row;
      const p = planCourier({ corp: { ...row, ...r.corp }, venture, identity, goods: ct, S: C, now,
        payout: ventures.payoutOf(venture, P.ventures) });
      if (!p.ok) {
        tally(CR_PLAN_COUNTERS[p.reason]);
        return;
      }
      if (ctOpen === null) {
        const co = contractRepo.countOpenInTx(tx);
        if (!co.ok) throw new Error(`contracts count: ${co.reason}`);
        ctOpen = co.count;
      }
      if (ctOpen >= C.maxOpen) {
        tally("ctSkipFull");
        return;
      }
      if (crOpen === null) {
        const ko = contractRepo.countOpenByKindInTx(tx, "COURIER");
        if (!ko.ok) throw new Error(`courier count: ${ko.reason}`);
        crOpen = ko.count;
      }
      if (crOpen >= CU.maxOpen) {
        tally("ctCourierSkipFull");
        return;
      }
      const cc = contractRepo.countOpenForCorpInTx(tx, row.corp_id);
      if (!cc.ok) throw new Error(`contracts corp count: ${cc.reason}`);
      if (cc.count >= C.maxPerCorp) {
        tally("ctSkipCorpFull");
        return;
      }
      const lt = contractRepo.lotTakenInTx(tx, { corpId: p.row.corp_id, stationId: p.row.station_id,
        typeId: p.row.type_id });
      if (!lt.ok) throw new Error(`contracts lot: ${lt.reason}`);
      if (lt.taken) {
        tally("ctSkipSameLot");
        return;
      }
      const ins = contractRepo.insertPlannedInTx(tx, p.row);
      if (!ins.ok) throw new Error(`courier ${p.row.contract_key}: ${ins.reason}`);
      const e = outbox.enqueueInTx(tx, { key: p.outbox.key, kind: p.outbox.kind, payload: p.outbox.payload, now });
      if (!e.ok) throw new Error(`courier outbox ${p.outbox.key}: ${e.reason}`);
      ctOpen += 1;
      crOpen += 1;
      ctPlans += 1;
      tally("ctCourierPlanned");
    }

    function applySkirmish(row, attackerVenture, sk) {
      const prey = sk.prey;
      const defId = prey.corp_id;
      const defCorp = freshCorp(defId, "defender");
      if (!defCorp) throw new Error(`defender ${defId} not open`);
      const dv = vrepo.getOpenInTx(tx, defId);
      if (!dv.ok) throw new Error(`defender venture ${defId} read: ${dv.reason}`);
      const v = dv.venture;
      if (!v || v.venture_id !== prey.venture_id || v.version !== prey.version || v.state !== S.VENTURE_STATES.WORKING) {
        throw new Error(`prey ${prey.venture_id} changed`);
      }
      if (sk.kind === "FIGHT") {
        const res = sk.result;
        const skRow = { skirmish_id: sk.skirmishId, at: now, system_id: prey.system_id,
          sec_band: prey.sec_band, war_id: sk.warId, attacker_corp_id: row.corp_id,
          attacker_venture_id: attackerVenture.venture_id, attacker_kind: attackerVenture.kind,
          attacker_crew: attackerVenture.crew - attackerVenture.crew_lost, defender_corp_id: defId,
          defender_venture_id: prey.venture_id, defender_kind: prey.kind, defender_crew: prey.crew - prey.crew_lost,
          crew_lost_a: res.crewLostA, crew_lost_d: res.crewLostD, isk_lost_a: res.iskLostA, isk_lost_d: res.iskLostD,
          loot_isk: res.lootIsk, outcome: res.outcome, seed: sk.seed };
        const ins = warRepo.insertSkirmishInTx(tx, skRow);
        if (!ins.ok) throw new Error(`skirmish ${sk.skirmishId}: ${ins.reason}`);
        fights += 1;
        if (km) enqueueKillmail(row, defCorp, skRow);
      } else {
        helds += 1;
      }
      const dp = defenderPatch(defCorp, v, sk, now, P);
      if (dp.venture) {
        const w = vrepo.updateInTx(tx, { ventureId: v.venture_id, expectedVersion: dp.venture.expectedVersion,
          expectedState: dp.venture.expectedState, row: dp.venture.row, at: now });
        if (!w.ok) throw new Error(`defender venture ${v.venture_id}: ${w.reason}`);
      }
      if (dp.corp) writeCorp(defCorp, dp.corp, "defender");
      for (const t of dp.tallies) tally(t);
      for (const e of dp.kindEvents) kindEvents.push(e);
      if (sk.kind === "FIGHT" && sk.warId && warsById.has(sk.warId)) {
        const war = warsById.get(sk.warId);
        const next = warsRules.warAfterSkirmish(war, row.corp_id, sk.result);
        if (next) {
          const w = warRepo.updateWarInTx(tx, { warId: war.war_id, expectedVersion: war.version,
            expectedState: war.state, row: next, at: now });
          if (!w.ok) throw new Error(`war ${war.war_id} skirmish: ${w.reason}`);
          warsById.set(war.war_id, Object.freeze({ ...war, ...next, version: war.version + 1, updated_at: now }));
        }
      }
      touch(defId);
      wrote = true;
    }

    function declare(row, r) {
      const c = r.corp;
      if (c.state !== S.CORP_STATES.ACTIVE || c.open !== 1 || declarations >= Wr.maxDeclarationsPerPass
        || !(c.isk >= Wr.declareMinIsk + Wr.declareCostIsk)) {
        return;
      }
      const cands = repo.listOpenBriefInTx(tx, { limit: Wr.maxCandidateScan });
      if (!cands.ok) throw new Error(`war candidates: ${cands.reason}`);
      const corp = { ...row, ...c };
      const pd = warsRules.planDeclaration({ corp, regionOf, candidates: cands.rows,
        belligerents: new Set(warIdx.byCorp.keys()), openWars: warIdx.open, hunting: H !== null, now,
        seed: deriveSeed(row.seed, "fcwar", c.venture_seq, now), S: P });
      if (!pd.ok) {
        if (WAR_PLAN_COUNTERS[pd.reason]) tally(WAR_PLAN_COUNTERS[pd.reason]);
        return;
      }
      const a = Math.min(row.corp_id, pd.targetId);
      const b = Math.max(row.corp_id, pd.targetId);
      const lp = warRepo.lastOfPairInTx(tx, a, b);
      if (!lp.ok) throw new Error(`war pair ${a}:${b}: ${lp.reason}`);
      if (lp.last && lp.last.open === 1) {
        tally("warAtWar");
        return;
      }
      if (lp.last && lp.last.endedAt !== null && lp.last.endedAt + Wr.redeclareCooldownMs > now) {
        tally("warCooldown");
        return;
      }
      const ally = pd.allyId === null ? null : freshCorp(pd.allyId, "ally");
      if (pd.allyId !== null && !ally) throw new Error(`ally ${pd.allyId} not open`);
      const wrow = warsRules.warRowOf({ declarerId: row.corp_id, targetId: pd.targetId, allyId: pd.allyId,
        n: lp.last ? lp.last.n + 1 : 1, now, costIsk: pd.costIsk, feeIsk: pd.feeIsk, S: P });
      const ins = warRepo.insertWarInTx(tx, wrow, now);
      if (!ins.ok) throw new Error(`war ${wrow.war_id}: ${ins.reason}`);
      c.isk = Math.max(0, c.isk - pd.costIsk - pd.feeIsk);
      if (ally) {
        writeCorp(ally, moneyValues(ally, pd.feeIsk), "ally");
        touch(ally.corp_id);
        tally("warsAllied");
      }
      const target = cands.rows.find((x) => x.corp_id === pd.targetId);
      const homeOf = (id) => (id === row.corp_id ? row.home_system_id : id === pd.targetId && target
        ? target.home_system_id : ally && id === ally.corp_id ? ally.home_system_id : null);
      warsById.set(wrow.war_id, Object.freeze({ ...wrow, ended_at: null, kills_a: 0, kills_b: 0, isk_lost_a: 0,
        isk_lost_b: 0, skirmishes: 0, surrender_isk: 0, winner: null, end_reason: null, updated_at: now, version: 1,
        home_a: homeOf(wrow.corp_a), home_b: homeOf(wrow.corp_b),
        home_ally: wrow.ally_corp_id === null ? null : homeOf(wrow.ally_corp_id) }));
      warIdx = warsRules.indexWars([...warsById.values()].filter((w) => w.open === 1));
      declaredNow.add(wrow.war_id);
      declarations += 1;
      tally("warsDeclared");
      wrote = true;
    }

    for (const row of due.rows) {
      if (nowMs() - t0 > P.maxPassMs) {
        truncated = true;
        tally("passTruncated");
        break;
      }
      if (touched.has(row.corp_id)) {
        tally("touchedSkips");
        continue;
      }
      processed += 1;
      let identity = vc ? safe(() => vc.getOwnerIdentity(S.OWNER_KIND, row.corp_id), { ok: false, reason: "VC_THROW" })
        : { ok: false, reason: "VC_UNAVAILABLE" };
      if (row.state !== S.CORP_STATES.FOUNDING && identity && identity.ok === true && !vcIsReady()) {
        identity = { ok: false, reason: "VC_NOT_READY" };
      }
      const step = plan.stepCorp(row, identity, { now, S: P });
      if (step.note) tally(NOTE_COUNTERS[step.note]);
      const engine = V !== null && step.kind === "RESCHEDULE" && identity && identity.ok === true
        && identity.state === "LINKED"
        && (row.state === S.CORP_STATES.ACTIVE || row.state === S.CORP_STATES.STRUGGLING);
      if (engine) {
        const open = vrepo.getOpenInTx(tx, row.corp_id);
        if (!open.ok) throw new Error(`venture read ${row.corp_id}: ${open.reason}`);
        const env = { now, linkedCount: (Array.isArray(identity.characterIds) ? identity.characterIds.length : 0)
            + (Number.isSafeInteger(row.recruited) && row.recruited > 0 ? row.recruited : 0),
          get memberRoom() { return memberRoom(); },
          reachOf: (home) => reachOf(graph, home), beltsOf, stationsOf, isObserved, wh, pvp: pvpEnv,
          recycle: recycleEnv, structureHold, whCorpsOn: WC !== null, whCorp: whCorpOf, haul, raid, whGraphWait,
          ...(WCT && ct ? { whContract: (venture, whRow) => whContractOffer(row, identity, venture, whRow) } : {}) };
        const r = ventures.stepCorpVenture(row, open.venture, env, P);
        if (r.skirmish) applySkirmish(row, open.venture, r.skirmish);
        if (Wr && r.reviewed === true) declare(row, r);
        if (r.venture && r.venture.op === "insert") {
          const w1 = vrepo.insertInTx(tx, r.venture.row, now);
          if (!w1.ok) throw new Error(`venture insert ${row.corp_id}: ${w1.reason}`);
        } else if (r.venture) {
          const w1 = vrepo.updateInTx(tx, { ventureId: open.venture.venture_id, expectedVersion: open.venture.version,
            expectedState: r.venture.expectedState, row: r.venture.row, at: now });
          if (!w1.ok) throw new Error(`venture update ${open.venture.venture_id}: ${w1.reason}`);
        }
        if (r.venture) dirtySincePrey.add(row.corp_id);
        const w2 = repo.advanceCorpInTx(tx, { corpId: row.corp_id, expectedVersion: row.version,
          expectedState: row.state, row: { ...r.corp, next_at: r.nextAt, corporation_id: step.corporationId || null },
          at: now });
        if (!w2.ok) throw new Error(`corp ${row.corp_id} advance: ${w2.reason}`);
        if (r.sale && r.whPatch) {
          const s = r.sale;
          const ws = once(tx, S.keyWhSale(row.corp_id, s.seq), row.corp_id, S.EVENT_WH_SOLD,
            { corpId: row.corp_id, seq: s.seq, hubSystemId: s.hubSystemId, lootIsk: s.lootIsk, gasIsk: s.gasIsk,
              saleIsk: s.isk, staging: s.staging,
              ...(s.contractKey ? { contractGasIsk: s.contractGasIsk, contractKey: s.contractKey } : {}) },
            (db) => {
              applyWhPatch(row.corp_id, r.whPatch, db);
              if (s.contractKey) {
                const p = whOffers.get(row.corp_id);
                if (!p || p.row.contract_key !== s.contractKey || p.gasIsk !== s.contractGasIsk) {
                  throw new Error(`wh contract ${row.corp_id}:${s.seq}: OFFER_MISMATCH`);
                }
                const ins = contractRepo.insertPlannedInTx(db, p.row);
                if (!ins.ok) throw new Error(`wh contract ${p.row.contract_key}: ${ins.reason}`);
                const e = outbox.enqueueInTx(db, { key: p.outbox.key, kind: p.outbox.kind, payload: p.outbox.payload,
                  now });
                if (!e.ok) throw new Error(`wh contract outbox ${p.outbox.key}: ${e.reason}`);
                ctOpen += 1;
                ctPlans += 1;
                tally("whContractPlanned");
              }
              return { ok: true };
            });
          if (!ws.ok || ws.duplicate) {
            throw new Error(`wh sale ${row.corp_id}:${s.seq}: ${ws.ok ? "JOURNAL_DUPLICATE" : ws.reason}`);
          }
        } else if (r.whPatch) {
          applyWhPatch(row.corp_id, r.whPatch);
        }
        for (const j of r.journal) {
          const wj = once(tx, j.key, row.corp_id, j.eventType, j.payload, () => ({ ok: true }));
          if (!wj.ok) throw new Error(`journal ${j.key}: ${wj.reason}`);
        }
        if (rc && r.recruit > 0) {
          recruitInto(row.corp_id, r.recruit);
          membersPresent = true;
        }
        if (rc && (r.transition === "MERGED" || r.transition === "DISSOLVED")) applyClose(row, r, identity);
        if (!rc && r.corp.state === S.CORP_STATES.DISSOLVED && row.state !== S.CORP_STATES.DISSOLVED
          && Number.isSafeInteger(row.recruited) && row.recruited > 0) {
          releaseRecruits(row, "rcReleasedDissolved");
        }
        if (ct && r.venture && r.venture.op === "update" && r.venture.row.state === S.VENTURE_STATES.DONE) {
          planContractInTx(row, r, identity);
          if (CU && cr && r.venture.row.kind === "HAUL") planCourierInTx(row, r, identity);
        }
        wrote = true;
        for (const t of r.tallies) tally(t);
        for (const e of r.kindEvents) kindEvents.push(e);
        if (r.ensure) grownInPass += 1;
        if ((step.ensure || r.ensure) && !(rc && r.corp.open === 0)) {
          pushEnsure({ ...row, members_target: r.corp.members_target,
            recruited: r.corp.recruited === null || r.corp.recruited === undefined ? row.recruited : r.corp.recruited });
        }
        continue;
      }
      let w;
      if (step.kind === "ACTIVATE") {
        w = once(tx, S.keyActivate(row.corp_id), row.corp_id, S.EVENT_ACTIVATED,
          { corpId: row.corp_id, corporationId: step.corporationId },
          (db) => repo.activateInTx(db, { corpId: row.corp_id, expectedVersion: row.version,
            corporationId: step.corporationId, nextAt: step.nextAt, at: now }));
        if (w.ok && !w.duplicate) { activated += 1; tally("activated"); }
        const ceoMismatch = w.ok && !w.duplicate && row.ceo_character_id && identity && identity.ok === true
          && identity.ceoCharacterId !== row.ceo_character_id;
        if (ceoMismatch) {
          const back = returnUnadoptedCeoInTx(tx, row.corp_id, row.ceo_character_id, now);
          if (back === "RETURNED") tally("ceoReturnedFallback");
          else if (back === "ANOMALY") tally("rcMemberAnomaly");
        }
        if (w.ok && !w.duplicate && !ceoMismatch && row.ceo_character_id && row.ceo_source_corporation_id && rc
          && RC.cleanSourceRoster === true) {
          const e = outbox.enqueueInTx(tx, { key: S.keyCeoClean(row.corp_id), kind: S.OUTBOX_KIND_CEO_CLEAN,
            payload: { v: 1, characterId: row.ceo_character_id, corpId: row.corp_id,
              fromCorporationId: row.ceo_source_corporation_id }, now });
          if (!e.ok && e.reason !== "DUPLICATE") throw new Error(`ceo clean ${row.corp_id}: ${e.reason}`);
        }
      } else if (step.kind === "REFUSE") {
        w = once(tx, S.keyRefuse(row.corp_id), row.corp_id, S.EVENT_REFUSED, { corpId: row.corp_id, reason: step.reason },
          (db) => repo.refuseInTx(db, { corpId: row.corp_id, expectedVersion: row.version, reason: step.reason,
            at: now }));
        if (w.ok && !w.duplicate) { refused += 1; tally("refused"); }
        if (w.ok && !w.duplicate && Number.isSafeInteger(row.recruited) && row.recruited > 0) releaseRecruits(row);
        if (w.ok && !w.duplicate && row.ceo_character_id && row.ceo_source_corporation_id) {
          const wc = members.insertInTx(tx, { character_id: row.ceo_character_id, origin_corp_id: row.corp_id,
            corp_id: null, state: S.MEMBER_STATES.FREE, vendor_corporation_id: row.ceo_source_corporation_id }, now);
          if (!wc.ok && wc.reason === "DUPLICATE") tally("rcMemberAnomaly");
          else if (!wc.ok) throw new Error(`ceo return ${row.ceo_character_id}: ${wc.reason}`);
          else {
            membersPresent = true;
            tally("ceoReturnedRefused");
          }
        }
      } else {
        w = repo.rescheduleInTx(tx, { corpId: row.corp_id, expectedVersion: row.version, state: row.state,
          nextAt: step.nextAt, corporationId: step.corporationId, at: now });
      }
      if (!w.ok) {
        if (w.reason === "CAS_CONFLICT") {
          tally("casConflicts");
          continue;
        }
        throw new Error(`corp ${row.corp_id} ${step.kind}: ${w.reason}`);
      }
      wrote = true;
      if (step.kind === "RESCHEDULE" && row.state === S.CORP_STATES.FOUNDING && row.ceo_character_id
        && ceoPeekFailed.has(row.corp_id) && now - row.founded_at > P.foundingStaleMs) {
        ceoPeekFailed.delete(row.corp_id);
        const back = returnUnadoptedCeoInTx(tx, row.corp_id, row.ceo_character_id, now);
        if (back === "RETURNED") tally("ceoPeekFallback");
        else if (back === "ANOMALY") tally("rcMemberAnomaly");
        if (step.ensure) pushEnsure({ ...row, ceo_character_id: null, ceo_source_corporation_id: null });
        continue;
      }
      if (step.ensure) pushEnsure(row);
    }

    if (Wr && !truncated) {
      const dueWars = [...warsById.values()].filter((w) => w.open === 1 && w.next_at <= now
        && !declaredNow.has(w.war_id)).sort((x, y) => x.next_at - y.next_at
        || (x.war_id < y.war_id ? -1 : x.war_id > y.war_id ? 1 : 0));
      let reviews = 0;
      for (const war of dueWars) {
        if (reviews >= Wr.maxWarReviewsPerPass) break;
        if (nowMs() - t0 > P.maxPassMs) {
          truncated = true;
          tally("passTruncated");
          break;
        }
        reviews += 1;
        const a = freshCorp(war.corp_a, "war side");
        const b = freshCorp(war.corp_b, "war side");
        const rv = warsRules.reviewWar(war, a, b, now, P);
        const w = warRepo.updateWarInTx(tx, { warId: war.war_id, expectedVersion: war.version,
          expectedState: war.state, row: rv.row, at: now });
        if (!w.ok) throw new Error(`war ${war.war_id} review: ${w.reason}`);
        warsById.set(war.war_id, Object.freeze({ ...war, ...rv.row, version: war.version + 1, updated_at: now }));
        wrote = true;
        if (rv.op === "activate") tally("warsActivated");
        if (rv.op === "end") {
          tally("warsEnded");
          tally(WAR_END_COUNTERS[rv.reason]);
        }
        if (rv.transfer) {
          const from = rv.transfer.fromCorpId === war.corp_a ? a : b;
          const to = rv.transfer.toCorpId === war.corp_a ? a : b;
          const paid = Math.min(from.isk, rv.transfer.isk);
          writeCorp(from, moneyValues(from, -paid), "surrender");
          writeCorp(to, moneyValues(to, paid), "surrender");
          touch(from.corp_id);
          touch(to.corp_id);
        }
      }
    }

    if (CR && rc && !truncated && RC.maxCeoReleasesPerPass > 0) {
      if (!vcIsReady()) {
        tally("ceoReleaseWaitVc");
      } else {
        const lr = repo.listCeoReleaseInTx(tx, { limit: RC.ceoReleaseScanRows });
        if (!lr.ok) throw new Error(`ceo release scan: ${lr.reason}`);
        let releasedNow = 0;
        const mark = (corpId, value) => {
          const m = repo.markCeoReleasedInTx(tx, { corpId, value, at: now });
          if (!m.ok) throw new Error(`ceo release ${corpId}: ${m.reason}`);
          wrote = true;
        };
        for (const c of lr.rows) {
          if (releasedNow >= RC.maxCeoReleasesPerPass) break;
          if (nowMs() - t0 > P.maxPassMs) {
            truncated = true;
            tally("passTruncated");
            break;
          }
          if (c.corporation_id === null) {
            mark(c.corp_id, S.CEO_RELEASED.NONE);
            tally("ceoReleaseNoIdentity");
            continue;
          }
          const oc = ceoContracts.countOpenForCorpInTx(tx, c.corp_id);
          if (!oc.ok) throw new Error(`ceo release contracts ${c.corp_id}: ${oc.reason}`);
          if (oc.count > 0) {
            tally("ceoReleaseWaitContracts");
            continue;
          }
          const id = vc ? safe(() => vc.getOwnerIdentity(S.OWNER_KIND, c.corp_id), null) : null;
          if (!id || id.ok !== true) {
            tally("ceoReleaseWaitVc");
            continue;
          }
          const ceo = id.state === "LINKED" && Number.isSafeInteger(id.ceoCharacterId)
            && id.ceoCharacterId > 0 ? id.ceoCharacterId : null;
          if (ceo === null) {
            mark(c.corp_id, S.CEO_RELEASED.NONE);
            tally("ceoReleaseNoIdentity");
            continue;
          }
          const g = members.getInTx(tx, ceo);
          if (!g.ok) throw new Error(`ceo release member ${ceo}: ${g.reason}`);
          if (g.row) {
            mark(c.corp_id, S.CEO_RELEASED.NONE);
            tally("ceoReleaseAnomaly");
            continue;
          }
          const ins = members.insertInTx(tx, { character_id: ceo, origin_corp_id: c.corp_id, corp_id: null,
            state: S.MEMBER_STATES.FREE, vendor_corporation_id: c.corporation_id }, now);
          if (!ins.ok) throw new Error(`ceo release insert ${ceo}: ${ins.reason}`);
          mark(c.corp_id, S.CEO_RELEASED.POOLED);
          if (poolCount === null) freedUncounted += 1;
          membersPresent = true;
          releasedNow += 1;
          tally("ceoReleased");
        }
      }
    }

    if (whPresent && !truncated && P.whCorps) {
      const lo = whRepo.listOrphansInTx(tx, { limit: P.whCorps.sweepPerPass });
      if (!lo.ok) throw new Error(`wh orphans: ${lo.reason}`);
      for (const h of lo.rows) {
        const c = whRepo.closeInTx(tx, { corpId: h.corp_id, expectedVersion: h.version,
          reason: S.WH_CORP_END_REASONS[0], now });
        if (!c.ok) throw new Error(`wh home ${h.corp_id} close: ${c.reason}`);
        whHomes.delete(h.corp_id);
        wrote = true;
        tally("whHomeSwept");
      }
    }

    const gate = { saltInc: 0, nextFoundingCheckAt: null };
    let stats = null;
    let used = null;
    const huntQuota = H !== null && H.targetHunters > 0;
    const sq = stOn && stPump !== null && P.structures.targetStructureCorps > 0
      ? Math.min(P.structures.targetStructureCorps, P.structures.maxTotal) : 0;
    const quotas = [];
    if (huntQuota) {
      quotas.push({ stat: "hunters", target: H.targetHunters, weights: PQ, refused: "foundingQuotaRefused" });
    }
    if (sq > 0) quotas.push({ stat: "structureCorps", target: sq, weights: PQS, refused: "stQuotaRefused" });
    if (WC && WC.targetCorps > 0) {
      if (wh && wh.mode === WH_MODE.LIVE) {
        quotas.push({ stat: "whCorps", target: WC.targetCorps, weights: PQW, refused: "whQuotaRefused", wh: true });
      } else {
        tally("whQuotaWait");
      }
    }
    const cap = P.targetCorps + quotas.reduce((s, q) => s + q.target, 0);
    if (!truncated && P.maxFoundingsPerPass > 0 && (P.targetCorps > 0 || quotas.length > 0)
      && now >= nextFoundingCheckAt) {
      const st0 = repo.statsInTx(tx);
      if (!st0.ok) throw new Error(`stats: ${st0.reason}`);
      let st = st0;
      if (st.maxCorpId > 0 && now - st.lastFoundedAt < P.foundingIntervalMs) {
        gate.nextFoundingCheckAt = st.lastFoundedAt + P.foundingIntervalMs;
      } else {
        const blocked = (name) => {
          if (name) tally(name);
          gate.nextFoundingCheckAt = now + P.foundingIntervalMs;
        };
        for (let k = 0; k < P.maxFoundingsPerPass; k += 1) {
          if (nowMs() - t0 > P.maxPassMs) {
            truncated = true;
            tally("passTruncated");
            break;
          }
          const live = st.open < cap ? quotas.filter((q) => !q.failed && st[q.stat] < q.target) : [];
          if (live.length === 0 && st.open >= P.targetCorps) { blocked(null); break; }
          if (st.founding >= P.maxFoundingOpen) { blocked("foundingWaitOpen"); break; }
          if (st.refused >= P.maxRefused) { blocked("foundingBlockedRefused"); break; }
          const oc = vc ? safe(() => vc.countOwnerCharacters(), null) : null;
          if (!oc || oc.ok !== true || oc.ready !== true) { blocked("foundingWaitVc"); break; }
          if (!graph) { blocked("foundingWaitGraph"); break; }
          used = oc.total + st.pendingMembers;
          const ceoAvail = CR && rc && poolLeft() >= 1 && now >= ceoPeekPausedUntil ? 1 : 0;
          const poolR = rc ? Math.min(poolLeft() - ceoAvail, RC.maxRecruitsPerFounding) : 0;
          if (used + (rc ? Math.max(1 - ceoAvail, membersLo - poolR - ceoAvail) : membersLo) > budget) {
            blocked("foundingBlockedBudget");
            break;
          }
          const corpId = st.maxCorpId + 1;
          const planWith = (weights) => plan.planFounding({ worldSeed, corpId, salt: salt + gate.saltInc, now,
            S: weights, archetypes: foundArchetypes, systemsOf: (band) => systemsOf(graph, band), stationsOf,
            homeCount: (systemId) => {
              const r = repo.countOpenInHomeInTx(tx, systemId);
              if (!r.ok) throw new Error(`home count: ${r.reason}`);
              return r.count;
            },
            nameTaken: (name, ticker) => {
              const r = repo.nameOrTickerTakenInTx(tx, name, ticker);
              if (!r.ok) throw new Error(`name check: ${r.reason}`);
              return r.taken;
            },
            reserved, raceSourceFactionIds: raceIds, memberRoom: budget - used + poolR + ceoAvail });
          let p = null;
          let whPick = null;
          let whQ = null;
          for (const q of live) {
            p = planWith(q.weights);
            if (p.ok && q.wh) {
              const h = pickWhHome({ seed: p.row.seed, reach: reachOf(graph, p.row.home_system_id), env: { now, wh },
                S: P, isTaken: (jSystemId) => {
                  const t = whRepo.isJTakenInTx(tx, jSystemId);
                  if (!t.ok) throw new Error(`wh taken: ${t.reason}`);
                  return t.taken;
                } });
              if (h.ok) {
                whPick = h;
                whQ = q;
              } else {
                p = { ok: false, reason: h.reason };
              }
            }
            if (p.ok) break;
            tally(p.reason === "NO_WH_HOME" ? PLAN_COUNTERS.NO_WH_HOME : q.refused);
            q.failed = true;
          }
          if (p === null || (!p.ok && st.open < P.targetCorps)) p = planWith(PF);
          if (!p.ok) {
            if (p.reason !== "NO_WH_HOME") tally(PLAN_COUNTERS[p.reason]);
            gate.saltInc += 1;
            gate.nextFoundingCheckAt = now + P.foundingIntervalMs;
            break;
          }
          let ceoRow = null;
          if (ceoAvail === 1) {
            const lf = members.listFreeInTx(tx, { limit: 1 });
            if (!lf.ok) throw new Error(`ceo pool read: ${lf.reason}`);
            if (lf.rows.length < 1) throw new Error("ceo pool short");
            ceoRow = lf.rows[0];
            const d = members.deleteInTx(tx, { characterId: ceoRow.character_id, expectedVersion: ceoRow.version });
            if (!d.ok) throw new Error(`ceo adopt ${ceoRow.character_id}: ${d.reason}`);
            poolClaims += 1;
          }
          const k = rc ? recycleRules.recruitPlan(p.row.members_target, poolLeft(), RC) : 0;
          const base = ceoRow ? { ...p.row, ceo_character_id: ceoRow.character_id,
            ceo_source_corporation_id: ceoRow.vendor_corporation_id } : p.row;
          const row = k > 0 || ceoRow ? Object.freeze({ ...base, ...(k > 0 ? { recruited: k } : {}) }) : p.row;
          let whHomeRefused = false;
          const w = once(tx, S.keyFound(corpId), corpId, S.EVENT_FOUNDED, { corpId, archetype: row.archetype,
            name: row.name, ticker: row.ticker, homeSystemId: row.home_system_id, membersTarget: row.members_target,
            ...(k > 0 ? { recruited: k } : {}), ...(ceoRow ? { ceoCharacterId: ceoRow.character_id } : {}),
            ...(whPick ? { whSystemId: whPick.jSystemId } : {}) },
          (db) => {
            const ins = repo.insertFoundingInTx(db, row, now);
            if (!ins.ok || !whPick) return ins;
            const hw = whRepo.insertInTx(db, { corpId, jSystemId: whPick.jSystemId,
              stagingSystemId: row.home_system_id, now });
            if (hw.ok) return ins;
            whHomeRefused = true;
            return { ok: false, reason: hw.reason };
          });
          if (!w.ok && whHomeRefused && !ceoRow) {
            tally(whQ.refused);
            whQ.failed = true;
            gate.saltInc += 1;
            continue;
          }
          if (!w.ok || w.duplicate) throw new Error(`found ${corpId}: ${w.ok ? "JOURNAL_DUPLICATE" : w.reason}`);
          if (k > 0) {
            recruitInto(corpId, k);
            membersPresent = true;
            for (let i = 0; i < k; i += 1) tally("rcRecruitFounding");
          }
          const born = plan.bornOf(row) - (ceoRow ? 1 : 0);
          wrote = true;
          founded += 1;
          tally("founded");
          if (whPick) tally("whCorpsFounded");
          pushEnsure(row);
          st = { ...st, maxCorpId: corpId, open: st.open + 1, founding: st.founding + 1,
            pendingMembers: st.pendingMembers + born, lastFoundedAt: now,
            whCorps: st.whCorps + (whPick ? 1 : 0),
            hunters: st.hunters + (row.archetype === "hunter" ? 1 : 0),
            structureCorps: st.structureCorps + (row.archetype === "structure" ? 1 : 0) };
          used += born;
        }
      }
      stats = st;
    }
    let openVentures = null;
    if (V) {
      if (!truncated) {
        const pr = vrepo.pruneClosedInTx(tx, { before: Math.max(0, now - R.ventureRetentionMs), limit: R.pruneBatch });
        if (!pr.ok) throw new Error(`venture prune: ${pr.reason}`);
        if (pr.deleted > 0) {
          wrote = true;
          tallies.pruned = (tallies.pruned || 0) + pr.deleted;
        }
        if (PVP) {
          const pw = warRepo.pruneInTx(tx, { before: Math.max(0, now - R.ventureRetentionMs), limit: R.pruneBatch });
          if (!pw.ok) throw new Error(`war prune: ${pw.reason}`);
          if (pw.wars > 0) tallies.warsPruned = (tallies.warsPruned || 0) + pw.wars;
          if (pw.skirmishes > 0) tallies.skirmishesPruned = (tallies.skirmishesPruned || 0) + pw.skirmishes;
          if (pw.wars + pw.skirmishes > 0) wrote = true;
        }
      }
      const co = vrepo.countOpenInTx(tx);
      if (!co.ok) throw new Error(`venture count: ${co.reason}`);
      openVentures = co.count;
    }
    let openWars = null;
    if (Wr) {
      openWars = 0;
      for (const w of warsById.values()) if (w.open === 1) openWars += 1;
    }
    return { ok: true, ensures, wrote, foundedAny: founded > 0, tallies, gate, stats, used, truncated, sq,
      processed, due: due.rows.length, founded, activated, refused, kindEvents, openVentures, openWars,
      preyRows: preyRows === null ? null : preyRows.length, whPresent };
  }

  function pass() {
    if (state !== S.SERVICE_STATE.RUNNING || inPass) return { ok: true, ran: false };
    const governor = safe(() => deps.getGovernor(), null);
    if (governor && typeof governor.admits === "function"
      && safe(() => governor.admits(S.WORK_CLASS), true) === false) {
      bump("deferrals");
      return { ok: true, ran: false };
    }
    inPass = true;
    try {
      const vc = vcOf();
      const graph = graphOf();
      const now = clock.now();
      whMode = whModeOf(now);
      if (whMode !== WH_MODE.WAIT) whWaitSince = null;
      else if (whWaitSince === null) whWaitSince = now;
      const wh = whEnvOf(whMode, graph, whWaitSince);
      const haul = wh ? haulEnvOf(graph) : null;
      const raid = wh ? raidEnvOf(graph) : null;
      let km = false;
      if (KM) {
        const seam = safe(() => deps.virtualKillmailSeams(), null);
        km = Boolean(seam && seam.ok === true);
        if (!km) bump("kmSeamUnavailable");
      }
      let ct = null;
      if (C) {
        const seam = safe(() => deps.freeCorpsContractSeams(), null);
        if (!seam || seam.ok !== true) {
          bump("ctSeamUnavailable");
        } else {
          ct = contractGoodsOf();
          if (ct === null) bump("ctGoodsInvalid");
        }
      }
      let cr = false;
      if (CU) {
        const seam = safe(() => deps.freeCorpsCourierSeams(), null);
        cr = Boolean(seam && seam.ok === true);
        if (!cr) bump("ctCourierSeamUnavailable");
      }
      let rc = false;
      if (RC) {
        const seam = safe(() => deps.freeCorpRecycleSeams(), null);
        rc = Boolean(seam && seam.ok === true);
        if (!rc) bump("rcSeamUnavailable");
      }
      const t0 = nowMs();
      bump("passes");
      const whGasKnown = WCT && ct && ctPump ? safe(() => ctPump.gasTypesKnown(), null) : null;
      const r = store.transaction("freeCorps.pass", (tx) => runPassTx(tx, { now, t0, vc, graph, wh, km, ct, rc,
        cr, haul, raid, whGasKnown }));
      const value = r && r.ok ? r.value : null;
      if (!value || value.ok !== true) {
        bump("passFailed");
        const why = String((value && value.reason) || (r && r.reason) || "TX_FAILED")
          + (r && r.error ? ` ${messageOf(r.error)}` : "");
        if (why !== lastError) log(`pass failed - ${why}`);
        lastError = why;
        return { ok: false, reason: String((value && value.reason) || (r && r.reason) || "TX_FAILED") };
      }
      const ms = nowMs() - t0;
      metric("observe", "freeCorps.passMs", ms);
      for (const [name, n] of Object.entries(value.tallies)) bump(name, n);
      for (const e of value.kindEvents) bumpKind(e.kind, e.event);
      if (value.openVentures !== null) {
        openVentureCount = value.openVentures;
        metric("gauge", "freeCorps.openVentures", value.openVentures);
      }
      if (value.wrote) writeVersion += 1;
      salt += value.gate.saltInc;
      if (value.foundedAny) nextFoundingCheckAt = now + P.foundingIntervalMs;
      else if (value.gate.nextFoundingCheckAt !== null) nextFoundingCheckAt = value.gate.nextFoundingCheckAt;
      if (value.openWars !== null) {
        openWarCount = value.openWars;
        metric("gauge", "freeCorps.openWars", value.openWars);
      }
      if (value.preyRows !== null) preyRowsLast = value.preyRows;
      if (whRepo) whSeen = value.whPresent === true;
      if (value.stats) {
        hunterCount = value.stats.hunters;
        whCorpCount = value.stats.whCorps;
        structureQuota = value.sq > 0 ? Object.freeze({ target: value.sq, corps: value.stats.structureCorps }) : null;
        population = Object.freeze({ open: value.stats.open, founding: value.stats.founding,
          refused: value.stats.refused, target: P.targetCorps });
        metric("gauge", "freeCorps.open", value.stats.open);
        metric("gauge", "freeCorps.founding", value.stats.founding);
      }
      if (value.used !== null) ownerCharacters = Object.freeze({ used: value.used, budget });
      let ensured = 0;
      let firstFailure = null;
      for (const spec of value.ensures) {
        if (state !== S.SERVICE_STATE.RUNNING || !vc) break;
        const e = safe(() => vc.ensureOwnerIdentity(spec), { ok: false, reason: "ENSURE_THROW" });
        if (spec.ceoCharacterId !== undefined) {
          if (e && e.ok !== true && e.reason === "CEO_PEEK_FAILED") {
            ceoPeekFailed.add(spec.ownerId);
            ceoPeekPausedUntil = clock.now() + P.foundingStaleMs;
            bump("ceoPeekFailed");
          } else {
            ceoPeekFailed.delete(spec.ownerId);
          }
        }
        if (e && e.ok === true) {
          ensured += 1;
          bump("ensureQueued");
          if (spec.ceoCharacterId !== undefined && e.ceoAdoptDuplicate !== true) {
            bump(e.ceoAdopted === true ? "ceoAdopted" : "ceoAdoptFallback");
          }
          if (spec.ceoCharacterId !== undefined && e.ceoAdopted === false) {
            const rt = store.transaction("freeCorps.ceoFallback",
              (tx) => returnUnadoptedCeoInTx(tx, spec.ownerId, spec.ceoCharacterId, clock.now()));
            if (!rt || !rt.ok) {
              bump("ceoReturnFailed");
              log(`ceo fallback return failed - ${spec.ownerId}: ${String((rt && rt.reason) || "TX_FAILED")} `
                + messageOf(rt && rt.error));
            } else if (rt.value === "RETURNED") {
              bump("ceoReturnedFallback");
              writeVersion += 1;
            } else if (rt.value === "ANOMALY") {
              bump("rcMemberAnomaly");
              writeVersion += 1;
            }
          }
        } else {
          bump("ensureFailed");
          if (firstFailure === null) firstFailure = `${spec.ownerId}: ${String((e && e.reason) || "UNKNOWN")}`;
        }
      }
      if (firstFailure !== null) log(`ensureOwnerIdentity failed - ${firstFailure}`);
      if (value.founded > 0) log(`founded ${value.founded} (open ${value.stats ? value.stats.open : "?"})`);
      lastError = null;
      lastPass = Object.freeze({ at: now, due: value.due, processed: value.processed, founded: value.founded,
        activated: value.activated, refused: value.refused, ensures: ensured, ms, truncated: value.truncated });
      return { ok: true, ran: true };
    } catch (err) {
      bump("passFailed");
      lastError = messageOf(err);
      log(`pass failed - ${lastError}`);
      return { ok: false, reason: "PASS_FAILED" };
    } finally {
      inPass = false;
    }
  }

  const poller = createPoller({ runPass: () => { pass(); }, intervalMs: P.passMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => { lastError = messageOf(err); } });

  const kmPump = KM ? createKillmailPump({ store, outbox, clock, nowMs,
    writeVirtualKillmail: (spec, eventId) => (typeof deps.writeVirtualKillmail === "function"
      ? deps.writeVirtualKillmail(spec, eventId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    virtualKillmailSeams: () => (typeof deps.virtualKillmailSeams === "function" ? deps.virtualKillmailSeams()
      : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    getGovernor: deps.getGovernor, workClass: S.WORK_CLASS, isRunning: () => state === S.SERVICE_STATE.RUNNING,
    bump, metric, log, setTimer: deps.setTimer, onWrite: () => { writeVersion += 1; }, S: KM,
    retention: { ventureRetentionMs: R.ventureRetentionMs, pruneBatch: R.pruneBatch } }) : null;

  let ctPump = null;
  function contractPumpOf(mode) {
    const SC = C || P.contracts;
    return contractPumpModule.createContractPump({ store, outbox, contracts: contractRepo, corps: repo, clock, nowMs,
      adapter: () => (typeof deps.contractAdapter === "function" ? deps.contractAdapter() : null),
      seams: () => (typeof deps.freeCorpsContractSeams === "function" ? deps.freeCorpsContractSeams()
        : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
      goods: contractGoodsOf, getGovernor: deps.getGovernor, workClass: S.WORK_CLASS,
      isRunning: () => state === S.SERVICE_STATE.RUNNING, bump, metric, log, setTimer: deps.setTimer,
      onWrite: () => { writeVersion += 1; },
      addListener: typeof deps.addContractAcceptedListener === "function" ? deps.addContractAcceptedListener : null,
      S: SC, retention: R ? { ventureRetentionMs: R.ventureRetentionMs, pruneBatch: R.pruneBatch }
        : { ventureRetentionMs: 0, pruneBatch: 0 }, mode,
      courierMode: CU && mode === CONTRACT_PUMP_MODE.RUN ? CONTRACT_PUMP_MODE.RUN : CONTRACT_PUMP_MODE.CLEANUP,
      courierSeams: () => (typeof deps.freeCorpsCourierSeams === "function" ? deps.freeCorpsCourierSeams()
        : { ok: false, reason: "ADAPTER_UNAVAILABLE" }) });
  }
  if (C) ctPump = contractPumpOf(CONTRACT_PUMP_MODE.RUN);

  function cleanupPumpOf() {
    if (C || !P.contracts || typeof P.contracts !== "object" || !Number.isSafeInteger(P.contracts.pumpMs)) return null;
    const probe = contractModule.createFreeCorpContractRepository();
    const r = safe(() => store.transaction("freeCorps.contracts.count", (tx) => probe.countOpenInTx(tx)), null);
    const n = r && r.ok === true && r.value && r.value.ok === true ? r.value.count : 0;
    if (!(n > 0)) return null;
    contractRepo = probe;
    if (!outbox) outbox = outboxModule.createFreeCorpOutboxRepository();
    log(`contracts off with ${n} open rows - cleanup pump`);
    return contractPumpOf(CONTRACT_PUMP_MODE.CLEANUP);
  }

  let rcPump = null;
  function recyclePumpOf(mode) {
    const SR = RC || P.recycle;
    return createRecyclePump({ store, outbox, members, repo, clock, nowMs,
      moveFreeCharacter: (spec) => (typeof deps.moveFreeCharacter === "function" ? deps.moveFreeCharacter(spec)
        : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
      setCorporationDescription: (id, text) => (typeof deps.setCorporationDescription === "function"
        ? deps.setCorporationDescription(id, text) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
      freeCorpRecycleSeams: () => (typeof deps.freeCorpRecycleSeams === "function" ? deps.freeCorpRecycleSeams()
        : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
      getGovernor: deps.getGovernor, workClass: S.WORK_CLASS, isRunning: () => state === S.SERVICE_STATE.RUNNING,
      bump, metric, log, setTimer: deps.setTimer, onWrite: () => { writeVersion += 1; }, S: SR,
      retention: R ? { ventureRetentionMs: R.ventureRetentionMs, pruneBatch: R.pruneBatch }
        : { ventureRetentionMs: 0, pruneBatch: 0 }, mode });
  }
  if (RC) rcPump = recyclePumpOf(RECYCLE_PUMP_MODE.LIVE);

  const ST = P.structures && P.structures.enabled === true ? P.structures : null;
  let stPump = null;
  let structureRepo = null;
  if (ST) {
    const kit = deps.structureKit;
    if (!kit || typeof kit.placementCandidates !== "function" || !kit.CONDITION_FULL || !kit.CONDITION_ARMOR_STAGE
      || typeof deps.systemBlockedInTx !== "function") {
      log("structures on without structureKit / systemBlockedInTx - no structure pump");
    } else {
      structureRepo = structureModule.createFreeCorpStructureRepository();
      if (!outbox) outbox = outboxModule.createFreeCorpOutboxRepository();
      stPump = createStructurePump({ store, repo, srepo: structureRepo, outbox, clock, nowMs,
        freeCorpStructureSeams: () => (typeof deps.freeCorpStructureSeams === "function"
          ? deps.freeCorpStructureSeams() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
        structureKit: kit, systemBlockedInTx: deps.systemBlockedInTx,
        systemNameOf: (id) => {
          const g = graphOf();
          const v = g ? safe(() => g.getSystem(id), null) : null;
          return v && typeof v.name === "string" ? v.name : null;
        },
        getGovernor: deps.getGovernor, workClass: S.WORK_CLASS, worldSeed,
        isRunning: () => state === S.SERVICE_STATE.RUNNING, bump, metric, log, setTimer: deps.setTimer,
        onWrite: () => { writeVersion += 1; }, S: ST,
        retention: R ? { ventureRetentionMs: R.ventureRetentionMs, pruneBatch: R.pruneBatch }
          : { ventureRetentionMs: 0, pruneBatch: 0 } });
    }
  }

  function probeMembers() {
    const SR = P.recycle;
    const drainable = !RC && SR && typeof SR === "object" && Number.isSafeInteger(SR.pumpMs);
    const r = safe(() => store.transaction("freeCorps.recycle.probe", (tx) => {
      const c = members.countAnyInTx(tx);
      if (!c.ok) return { any: 0, pending: 0, ob: null };
      if (c.count === 0 || !drainable) return { any: c.count, pending: 0, ob: null };
      const ob = outbox || outboxModule.createFreeCorpOutboxRepository();
      const pj = ob.countPendingInTx(tx, { kind: S.OUTBOX_KIND_JOIN });
      const pc = ob.countPendingInTx(tx, { kind: S.OUTBOX_KIND_CORP_CLOSE });
      const pe = ob.countPendingInTx(tx, { kind: S.OUTBOX_KIND_CEO_CLEAN });
      return { any: c.count, pending: (pj.ok ? pj.count : 0) + (pc.ok ? pc.count : 0) + (pe.ok ? pe.count : 0), ob };
    }), null);
    const v = r && r.ok === true && r.value ? r.value : { any: 0, pending: 0, ob: null };
    membersPresent = v.any > 0;
    if (!(v.pending > 0)) return null;
    if (!outbox) outbox = v.ob;
    log(`recycle off with ${v.pending} pending moves - drain pump`);
    return recyclePumpOf(RECYCLE_PUMP_MODE.DRAIN);
  }

  const L = P.local && P.local.enabled === true ? P.local : null;
  const M = P.map && P.map.enabled === true ? P.map : null;
  const maxSystemsPerPass = config.localPilots && Number.isSafeInteger(config.localPilots.maxSystemsPerPass)
    ? config.localPilots.maxSystemsPerPass : 0;
  const reads = createResidentReads({ whHomeFilter: WC !== null });
  let residentsMemo = null;
  let mapMemo = null;
  let localStatus = null;
  let mapStatus = null;
  const failed = (counter, reason, detail) => {
    bump(counter);
    return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail: String(detail).slice(0, MAX_DETAIL) };
  };
  const unwrap = (r, what) => {
    if (!r || r.ok !== true) throw new Error(`${what}: ${(r && r.reason) || "no_result"}`);
    return r.rows;
  };
  const storeClosed = () => typeof store.isOpen === "function" && safe(() => store.isOpen(), true) === false;

  function residentsFor(systemIds, atMs) {
    if (state !== S.SERVICE_STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    if (!L) return { ok: false, reason: "LOCAL_DISABLED" };
    if (!Array.isArray(systemIds) || !Number.isFinite(atMs)) return { ok: false, reason: "INVALID_INPUT" };
    const systems = [...new Set(systemIds.filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
    if (systems.length > maxSystemsPerPass) return { ok: false, reason: "TOO_MANY_SYSTEMS" };
    const vc = vcOf();
    if (!vc) return { ok: false, reason: "VC_UNAVAILABLE" };
    if (storeClosed()) return { ok: false, reason: "STORE_CLOSED" };
    try {
      const bucket = Math.floor(atMs / L.bucketMs);
      const mapVersion = typeof vc.getMapVersion === "function" ? safe(() => vc.getMapVersion(), null) : null;
      const key = mapVersion === null || mapVersion === undefined ? null
        : `${systems.join(",")}|${writeVersion}|${mapVersion}|${bucket}|${V ? 1 : 0}`;
      if (key !== null && residentsMemo && residentsMemo.key === key) {
        bump("residentsCached");
        return residentsMemo.value;
      }
      const limit = L.maxResidentsPerSystem + 1;
      const living = (row) => row.state === S.CORP_STATES.ACTIVE || row.state === S.CORP_STATES.STRUGGLING;
      const r = store.transaction("freeCorps.residents", (tx) => {
        const homes = [];
        const list = [];
        for (const systemId of systems) {
          for (const row of unwrap(reads.homeCorpsInTx(tx, systemId, limit), "homeCorps").filter(living)) {
            const venture = V ? unwrap(reads.openVentureOfInTx(tx, row.corpId), "openVentureOf")[0] || null : null;
            homes.push({ corpId: row.corpId, homeSystemId: systemId, venture });
          }
          if (V) list.push(...unwrap(reads.venturesInSystemInTx(tx, systemId, limit), "venturesInSystem"));
        }
        let recruits = null;
        if (membersPresent) {
          const lm = members.listMembersOfCorpsInTx(tx, [...homes, ...list].map((x) => x.corpId));
          if (!lm.ok) throw new Error(`members: ${lm.reason}`);
          recruits = lm.byCorp;
        }
        return { homes, ventures: list, recruits };
      });
      if (!r || r.ok !== true || !r.value) {
        return failed("residentsFailed", "READ_FAILED", `${(r && r.reason) || "TX_FAILED"}`
          + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
      }
      const memo = new Map();
      const recruitsOf = r.value.recruits;
      const membersOf = (corpId) => {
        if (!memo.has(corpId)) {
          const id = safe(() => vc.getOwnerIdentity(S.OWNER_KIND, corpId), null);
          const born = id && id.ok === true && id.state === "LINKED" && Array.isArray(id.characterIds)
            ? id.characterIds : null;
          const extra = born && recruitsOf ? recruitsOf.get(corpId) || [] : [];
          memo.set(corpId, extra.length > 0 ? born.concat(extra) : born);
        }
        return memo.get(corpId);
      };
      const picked = pickResidents({ systems, ventures: r.value.ventures, homes: r.value.homes, membersOf, bucket,
        seed: worldSeed, homeIdlePermille: L.homeIdlePermille, maxPerSystem: L.maxResidentsPerSystem });
      for (const [systemId, ids] of picked.bySystem) picked.bySystem.set(systemId, Object.freeze(ids));
      bump("residentsReads");
      bump("residentsCut", picked.cut);
      let residents = 0;
      for (const ids of picked.bySystem.values()) residents += ids.length;
      localStatus = Object.freeze({ lastAt: clock.now(), systems: systems.length, residents, cut: picked.cut });
      const value = Object.freeze({ ok: true, bySystem: picked.bySystem, bucket, cut: picked.cut, cached: false });
      residentsMemo = key === null ? null : { key, value: Object.freeze({ ...value, cached: true }) };
      return value;
    } catch (err) {
      return failed("residentsFailed", "READ_FAILED", messageOf(err));
    }
  }

  function listMapMarks(opts) {
    if (state !== S.SERVICE_STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    if (!M) return { ok: false, reason: "MAP_DISABLED" };
    if (storeClosed()) return { ok: false, reason: "STORE_CLOSED" };
    try {
      const maxLines = Math.min(MAX_MAP_LINES, Math.max(0, Math.trunc(Number(opts && opts.maxLines) || 0)));
      const key = `${writeVersion}|${maxLines}|${V ? 1 : 0}`;
      if (mapMemo && mapMemo.key === key) {
        bump("mapCached");
        return mapMemo.value;
      }
      const limit = M.maxMarks + 1;
      const r = store.transaction("observer.freeCorpsMap", (tx) => ({
        corps: unwrap(reads.mapCorpsInTx(tx, limit), "mapCorps"),
        ventures: V ? unwrap(reads.mapVenturesInTx(tx, limit), "mapVentures") : [],
        structures: structureRepo ? unwrap(structureRepo.listOpenInTx(tx, { limit: S.STRUCTURES_MAX_TOTAL * 2 }),
          "mapStructures") : [] }));
      if (!r || r.ok !== true || !r.value) {
        return failed("mapFailed", "READ_FAILED", `${(r && r.reason) || "TX_FAILED"}`
          + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
      }
      const { corps, ventures: vs, structures: sts } = r.value;
      const truncated = corps.length > M.maxMarks || vs.length > M.maxMarks;
      const built = buildMapMarks({ corps: corps.slice(0, M.maxMarks), ventures: vs.slice(0, M.maxMarks),
        maxMarks: M.maxMarks, maxLines, truncated,
        ...(sts.length > 0 ? { structures: sts.map((s) => ({ corpId: s.corp_id, state: s.state })) } : {}) });
      bump("mapReads");
      mapStatus = Object.freeze({ lastAt: clock.now(), marks: built.marks.length, truncated: built.truncated });
      const value = Object.freeze({ ok: true, legend: MAP_STYLES,
        marks: Object.freeze(built.marks.map((m) => Object.freeze({ ...m, lines: Object.freeze(m.lines) }))),
        pilots: built.pilots, systems: built.systems, corps: built.corps, truncated: built.truncated, cached: false });
      mapMemo = { key, value: Object.freeze({ ...value, cached: true }) };
      return value;
    } catch (err) {
      return failed("mapFailed", "READ_FAILED", messageOf(err));
    }
  }

  const CH = P.chatter && P.chatter.enabled === true ? P.chatter : null;
  const chatterReads = createChatterReads();
  const hsChatter = config.highsecLife && config.highsecLife.chatter;
  const lastMaxAgeMs = hsChatter && Number.isSafeInteger(hsChatter.rumourMaxAgeMs) && hsChatter.rumourMaxAgeMs > 0
    ? hsChatter.rumourMaxAgeMs : DEFAULT_LAST_MAX_AGE_MS;
  let chatterStatus = null;
  const observeRead = (t0) => metric("observe", "freeCorps.chatterReadMs",
    Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
  const livingCorp = (row) => row.state === S.CORP_STATES.ACTIVE || row.state === S.CORP_STATES.STRUGGLING;

  function speakerOf(characterId, corpId, e, crewIds, systemId, atMs) {
    const v = e.venture;
    const l = e.last;
    const lastOk = l && (l.state === S.VENTURE_STATES.DONE || l.state === S.VENTURE_STATES.LOST)
      && Number.isFinite(l.endedAt) && atMs - l.endedAt <= lastMaxAgeMs;
    return Object.freeze({ characterId, corpId, corpName: e.corp.name, ticker: e.corp.ticker,
      archetype: e.corp.archetype, homeSystemId: e.corp.homeSystemId,
      role: v && v.systemId === systemId && crewIds.includes(characterId) ? "CREW" : "HOME",
      venture: v ? Object.freeze({ kind: v.kind, state: v.state, systemId: v.systemId, yieldIsk: v.yieldIsk }) : null,
      last: lastOk ? Object.freeze({ kind: l.kind, outcome: l.state, endReason: l.endReason, systemId: l.targetSystemId,
        crewLost: l.crewLost, yieldIsk: l.yieldIsk, endedAt: l.endedAt }) : null });
  }

  function chatterSpeakers(systemId, atMs) {
    if (state !== S.SERVICE_STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    if (!CH) return { ok: false, reason: "CHATTER_DISABLED" };
    if (!L) return { ok: false, reason: "LOCAL_DISABLED" };
    if (!Number.isSafeInteger(systemId) || systemId <= 0 || !Number.isFinite(atMs)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const vc = vcOf();
    if (!vc) return { ok: false, reason: "VC_UNAVAILABLE" };
    if (storeClosed()) return { ok: false, reason: "STORE_CLOSED" };
    const t0 = nowMs();
    try {
      const bucket = Math.floor(atMs / L.bucketMs);
      const limit = L.maxResidentsPerSystem + 1;
      const memo = new Map();
      const corpOfId = new Map();
      let chatTx = null;
      const membersOf = (corpId) => {
        if (!memo.has(corpId)) {
          const id = safe(() => vc.getOwnerIdentity(S.OWNER_KIND, corpId), null);
          let ids = id && id.ok === true && id.state === "LINKED" && Array.isArray(id.characterIds)
            ? id.characterIds : null;
          if (ids && membersPresent && chatTx) {
            const lm = members.listMembersOfCorpsInTx(chatTx, [corpId]);
            if (!lm.ok) throw new Error(`members: ${lm.reason}`);
            const extra = lm.byCorp.get(corpId) || [];
            if (extra.length > 0) ids = ids.concat(extra);
          }
          memo.set(corpId, ids);
          for (const characterId of ids || []) if (!corpOfId.has(characterId)) corpOfId.set(characterId, corpId);
        }
        return memo.get(corpId);
      };
      const r = store.transaction("freeCorps.chatter", (tx) => {
        chatTx = tx;
        const homes = [];
        for (const row of unwrap(reads.homeCorpsInTx(tx, systemId, limit), "homeCorps").filter(livingCorp)) {
          const venture = V ? unwrap(reads.openVentureOfInTx(tx, row.corpId), "openVentureOf")[0] || null : null;
          homes.push({ corpId: row.corpId, homeSystemId: systemId, venture });
        }
        const list = V ? unwrap(reads.venturesInSystemInTx(tx, systemId, limit), "venturesInSystem") : [];
        const picked = pickResidents({ systems: [systemId], ventures: list, homes, membersOf, bucket, seed: worldSeed,
          homeIdlePermille: L.homeIdlePermille, maxPerSystem: L.maxResidentsPerSystem });
        const byCorp = new Map();
        const speakers = [];
        for (const characterId of picked.bySystem.get(systemId) || []) {
          const corpId = corpOfId.get(characterId);
          if (!corpId) continue;
          if (!byCorp.has(corpId)) {
            const corp = unwrap(chatterReads.speakerCorpInTx(tx, corpId), "speakerCorp")[0] || null;
            byCorp.set(corpId, corp ? { corp,
              venture: V ? unwrap(chatterReads.openVentureDetailInTx(tx, corpId), "openVentureDetail")[0] || null : null,
              last: V ? unwrap(chatterReads.lastClosedInTx(tx, corpId), "lastClosed")[0] || null : null } : null);
          }
          const e = byCorp.get(corpId);
          if (!e) continue;
          const ids = memo.get(corpId) || [];
          const crewIds = e.venture ? ids.slice(0, Math.max(0, Math.min(e.venture.crew, ids.length))) : [];
          speakers.push(speakerOf(characterId, corpId, e, crewIds, systemId, atMs));
        }
        return speakers.sort((a, b) => a.characterId - b.characterId);
      });
      if (!r || r.ok !== true || !Array.isArray(r.value)) {
        return failed("chatterFailed", "READ_FAILED", `${(r && r.reason) || "TX_FAILED"}`
          + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
      }
      bump("chatterReads");
      observeRead(t0);
      chatterStatus = Object.freeze({ lastAt: clock.now(), speakers: r.value.length });
      return { ok: true, speakers: Object.freeze(r.value) };
    } catch (err) {
      return failed("chatterFailed", "READ_FAILED", messageOf(err));
    }
  }

  function ventureNews(q) {
    if (state !== S.SERVICE_STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    if (!CH) return { ok: false, reason: "CHATTER_DISABLED" };
    if (!q || typeof q !== "object" || !Number.isFinite(q.afterAt)
      || !(q.afterId === null || (typeof q.afterId === "string" && q.afterId !== ""))
      || !Number.isSafeInteger(q.limit) || q.limit < 1 || !Number.isSafeInteger(q.minYieldIsk) || q.minYieldIsk < 0
      || !Number.isSafeInteger(q.minCrewLost) || q.minCrewLost < 1) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    if (storeClosed()) return { ok: false, reason: "STORE_CLOSED" };
    const t0 = nowMs();
    try {
      const limit = Math.max(q.limit, P.maxCorpsPerPass + 1);
      const afterAt = Math.max(0, Math.ceil(q.afterAt));
      const afterId = Number.isInteger(q.afterAt) && q.afterAt >= 0 ? q.afterId : null;
      const r = store.transaction("freeCorps.news", (tx) => unwrap(chatterReads.newsInTx(tx, { afterAt, afterId,
        minCrewLost: q.minCrewLost, minYieldIsk: q.minYieldIsk, limit }), "news"));
      if (!r || r.ok !== true || !Array.isArray(r.value)) {
        return failed("newsFailed", "READ_FAILED", `${(r && r.reason) || "TX_FAILED"}`
          + `${r && r.error ? ` ${messageOf(r.error)}` : ""}`);
      }
      const seen = (row) => row.endedAt < q.afterAt
        || (q.afterId !== null && row.endedAt === q.afterAt && row.ventureId <= q.afterId);
      const items = r.value.filter((row) => !seen(row)).map((row) => Object.freeze({ key: `fc:${row.ventureId}`,
        ventureId: row.ventureId, kind: row.state === S.VENTURE_STATES.LOST ? "FC_LOST" : "FC_RICH",
        corpName: row.corpName, archetype: row.archetype, ventureKind: row.kind, systemId: row.targetSystemId,
        endedAt: row.endedAt, crewLost: row.crewLost, yieldIsk: row.yieldIsk }));
      bump("newsReads");
      observeRead(t0);
      return { ok: true, items: Object.freeze(items), full: r.value.length >= limit };
    } catch (err) {
      return failed("newsFailed", "READ_FAILED", messageOf(err));
    }
  }

  function getStatus() {
    return Object.freeze({ state, reason: null, counters: Object.freeze({ ...counters }), lastPass, population,
      ownerCharacters, lastError, ventures: Object.freeze({ enabled: V !== null, open: openVentureCount,
        byKind: Object.freeze({ ...kindCounters }) }),
      local: Object.freeze({ enabled: L !== null, lastAt: localStatus ? localStatus.lastAt : null,
        systems: localStatus ? localStatus.systems : 0, residents: localStatus ? localStatus.residents : 0,
        cut: localStatus ? localStatus.cut : 0 }),
      map: Object.freeze({ enabled: M !== null, lastAt: mapStatus ? mapStatus.lastAt : null,
        marks: mapStatus ? mapStatus.marks : 0, truncated: mapStatus ? mapStatus.truncated : false }),
      chatter: Object.freeze({ enabled: CH !== null, lastAt: chatterStatus ? chatterStatus.lastAt : null,
        speakers: chatterStatus ? chatterStatus.speakers : 0 }),
      ...(W ? { wormholes: Object.freeze({ mode: whMode === null ? WH_MODE.WAIT : whMode, waitSince: whWaitSince,
        index: whIndex.stats() }) } : {}),
      ...(H ? { hunting: Object.freeze({ enabled: true, hunters: hunterCount, preyRows: preyRowsLast }) } : {}),
      ...(Wr ? { wars: Object.freeze({ enabled: true, open: openWarCount }) } : {}),
      ...(kmPump ? { killmails: Object.freeze({ enabled: true, ...kmPump.status() }) } : {}),
      ...(ctPump ? { contracts: Object.freeze({ enabled: C !== null, ...ctPump.status() }) } : {}),
      ...(rcPump ? { recycle: Object.freeze({ enabled: RC !== null, ...rcPump.status(),
        ...(CR ? { ceoReuse: true } : {}) }) } : {}),
      ...(ST ? { structures: Object.freeze({ enabled: true, mode: ST.mode,
        seam: stPump ? stPump.status().seam : "UNAVAILABLE", open: stPump ? stPump.status().open : null,
        lastRefusal: stPump ? stPump.status().lastRefusal : "NO_PUMP" }) } : {}),
      ...(structureQuota ? { structureQuota } : {}),
      ...(WC ? { whCorps: Object.freeze({ open: whCorpCount, target: WC.targetCorps }) } : {}) });
  }

  function stop() {
    if (state === S.SERVICE_STATE.STOPPED) return;
    state = S.SERVICE_STATE.STOPPED;
    poller.stop();
    if (kmPump) kmPump.stop();
    if (ctPump) ctPump.stop();
    if (rcPump) rcPump.stop();
    if (stPump) stPump.stop();
    if (viewHandle) {
      safe(() => viewHandle.unregister(), null);
      viewHandle = null;
    }
  }

  const facade = Object.freeze({
    runPassNow: () => (state === S.SERVICE_STATE.RUNNING ? pass() : { ok: false, reason: state }),
    getStatus,
    stop,
    residentsFor,
    listMapMarks,
    chatterSpeakers,
    ventureNews,
  });

  state = S.SERVICE_STATE.RUNNING;
  const started = poller.start();
  if (!started.ok) {
    state = S.SERVICE_STATE.STOPPED;
    return { ok: false, reason: "MISSING_DEPS", detail: `poller ${started.reason}` };
  }
  if (kmPump) {
    const pumpStarted = kmPump.start();
    if (!pumpStarted.ok) log(`killmail pump not started - ${pumpStarted.reason}`);
  }
  if (!ctPump) ctPump = cleanupPumpOf();
  if (ctPump) {
    const pumpStarted = ctPump.start();
    if (!pumpStarted.ok) log(`contract pump not started - ${pumpStarted.reason}`);
  }
  if (C) for (const note of contractLimitNotes(config).freeCorps) log(note);
  const drainPump = probeMembers();
  if (!rcPump) rcPump = drainPump;
  if (rcPump) {
    const pumpStarted = rcPump.start();
    if (!pumpStarted.ok) log(`recycle pump not started - ${pumpStarted.reason}`);
  }
  if (stPump) {
    const pumpStarted = stPump.start();
    if (!pumpStarted.ok) log(`structure pump not started - ${pumpStarted.reason}`);
  }
  viewHandle = registerFreeCorpsView({ views: deps.views || null, store, repository: repo,
    ventureRepository: V ? vrepo : null, warRepository: warRepo, outboxRepository: KM ? outbox : null,
    contractRepository: ctPump ? contractRepo : null, membersRepository: rcPump ? members : null,
    structureRepository: structureRepo, structureMode: ST ? ST.mode : null,
    contractMode: () => (ctPump ? ctPump.status().mode : null),
    courierMode: () => (ctPump && ctPump.status().courier ? ctPump.status().courier.mode : null),
    now: () => clock.now(),
    getGovernor: deps.getGovernor, getGraph: graphOf, getStatus, getWriteVersion: () => writeVersion,
    maxRows: P.observerMaxRows, log,
    whRepository: WC ? whRepo : null,
    whSettings: WC ? Object.freeze({ target: WC.targetCorps, haul: haulWanted, raid: raidWanted,
      contracts: WCT !== null }) : null,
    whStatus: () => ({ mode: W ? (whMode === null ? WH_MODE.WAIT : whMode) : null,
      index: whIndex ? Object.freeze({ ...whIndex.stats(), kjPairs: whIndex.kjPairs() }) : null }) });
  log(`running target=${P.targetCorps} interval=${P.foundingIntervalMs}ms budget=${budget}`
    + (V ? ` ventures step=${V.stepMs}ms${typeof deps.bfs === "function" ? "" : " (no bfs: BUILD only)"}` : "")
    + (KM ? ` killmails maxPerHour=${KM.maxPerHour}` : "")
    + (ctPump ? ` contracts ${ctPump.status().mode} maxOpen=${(C || P.contracts).maxOpen}` : "")
    + (ctPump && CU ? ` couriers maxOpen=${CU.maxOpen}` : "")
    + (rcPump ? ` recycle ${rcPump.status().mode}` : "")
    + (ST ? ` structures ${stPump ? ST.mode : "no-pump"} maxTotal=${ST.maxTotal}` : ""));
  return { ok: true, freeCorps: facade };
}

module.exports = { startFreeCorps, createUnavailableFreeCorps };
