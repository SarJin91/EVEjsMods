"use strict";

const { performance } = require("node:perf_hooks");
const { createRng, deriveSeed } = require("../../util/rng");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../data/expansion");
const D = require("../data/capsuleers");
const VC = require("../data/virtualCorps");
const { corpNameOf, planBase, planReview } = require("./capsuleerRules");
const { bfs } = require("../ai/bfs");
const { createHostility } = require("../../battle/data/hostility");
const { planDispatches, planSweeps, hostilesPresent, PRESENT_STATES, CAPSULEER_ROLE, MERC_ROLE } =
  require("./rattingRules");
const { planHires } = require("./contractRules");
const { planSalvageDispatches } = require("./salvageRules");
const { readSalvageTargets } = require("./salvageRead");
const { planClaims } = require("./claimRules");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");
const S = require("./schema");

const METRIC_REVIEWS = "capsuleers.reviews";
const METRIC_FOUNDED = "capsuleers.founded";
const METRIC_ACTIVATED = "capsuleers.activated";
const METRIC_REFUSED = "capsuleers.refused";
const METRIC_NO_BASE = "capsuleers.noBase";
const METRIC_GRAPH_NOT_READY = "capsuleers.graphNotReady";
const METRIC_STIPENDS = "capsuleers.stipends";
const METRIC_FLEETS_BOUGHT = "capsuleers.fleetsBought";
const METRIC_FLEET_LIMIT = "capsuleers.fleetLimit";
const METRIC_BUY_REFUSED = "capsuleers.buyRefused";
const METRIC_ENSURE_CALLS = "capsuleers.ensureCalls";
const METRIC_ENSURE_REFUSED = "capsuleers.ensureRefused";
const METRIC_CORPS = "capsuleers.corps";
const METRIC_FLEETS = "capsuleers.fleets";
const METRIC_REVIEW_MS = "capsuleers.reviewMs";
const METRIC_APPLY_FAILED = "capsuleers.applyFailed";
const METRIC_DISPATCHED = "capsuleers.dispatched";
const METRIC_HOMING_DISPATCHED = "capsuleers.homingDispatched";
const METRIC_DISPATCH_REFUSED = "capsuleers.dispatchRefused";
const METRIC_TRIPS_PRUNED = "capsuleers.tripsPruned";
const METRIC_ORPHANS_RELEASED = "capsuleers.orphansReleased";
const METRIC_MEMBERS_REFRESHED = "capsuleers.membersRefreshed";
const METRIC_MERC_FLEETS_BOUGHT = "capsuleers.mercFleetsBought";
const METRIC_SALVAGE_DISPATCHED = "capsuleers.salvageDispatched";
const METRIC_CLAIMS_CREATED = "capsuleers.claimsCreated";
const METRIC_CLAIMS_LOST = "capsuleers.claimsLost";
const METRIC_CLAIMS_LOST_CONTROLLER = "capsuleers.claimsLostController";
const METRIC_CLAIMS_LOST_NO_FLEET = "capsuleers.claimsLostNoFleet";
const METRIC_CLAIM_REFUSED = "capsuleers.claimRefused";
const METRIC_CLAIMS_HELD = "capsuleers.claimsHeld";
const METRIC_FLEET_BUDGET = "capsuleers.fleetBudget";
const COUNTERS = Object.freeze({ reviews: METRIC_REVIEWS, founded: METRIC_FOUNDED, activated: METRIC_ACTIVATED,
  refused: METRIC_REFUSED, noBase: METRIC_NO_BASE, graphNotReady: METRIC_GRAPH_NOT_READY, stipends: METRIC_STIPENDS,
  fleetsBought: METRIC_FLEETS_BOUGHT, fleetLimit: METRIC_FLEET_LIMIT, buyRefused: METRIC_BUY_REFUSED,
  ensureCalls: METRIC_ENSURE_CALLS, ensureRefused: METRIC_ENSURE_REFUSED, applyFailed: METRIC_APPLY_FAILED,
  dispatched: METRIC_DISPATCHED, homingDispatched: METRIC_HOMING_DISPATCHED, dispatchRefused: METRIC_DISPATCH_REFUSED,
  tripsPruned: METRIC_TRIPS_PRUNED, orphansReleased: METRIC_ORPHANS_RELEASED,
  membersRefreshed: METRIC_MEMBERS_REFRESHED, mercFleetsBought: METRIC_MERC_FLEETS_BOUGHT,
  salvageDispatched: METRIC_SALVAGE_DISPATCHED, claimsCreated: METRIC_CLAIMS_CREATED, claimsLost: METRIC_CLAIMS_LOST,
  claimsLostController: METRIC_CLAIMS_LOST_CONTROLLER, claimsLostNoFleet: METRIC_CLAIMS_LOST_NO_FLEET,
  claimRefused: METRIC_CLAIM_REFUSED, fleetBudget: METRIC_FLEET_BUDGET });
const NO_TREASURY_REASONS = Object.freeze(["TREASURY_OFF", "NO_TREASURY"]);
const LIVE_FLEET_STATES = Object.freeze(["IDLE", "PLANNED", "TRAVELLING", "STAGED", "ENGAGED", "RETREATING",
  "REFITTING", "MATERIALIZED"]);
const MAX_DETAIL = 120;
const MS_DECIMALS = 10;

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function parseReviewPayload(p) {
  if (!isPlain(p) || Object.keys(p).join() !== "round" || !Number.isSafeInteger(p.round) || p.round < 0) return null;
  return { round: p.round };
}

function paramsOf(C, limits) {
  const globalLimit = limits && Number.isSafeInteger(limits.maxVirtualFleets) ? limits.maxVirtualFleets : 0;
  return Object.freeze({ maxCorps: C.maxCorps, membersPerCorp: C.membersPerCorp, maxFleetsPerCorp: C.maxFleetsPerCorp,
    fleetBudget: Object.freeze({ enabled: C.fleetBudgetEnabled === true, maxFleetsTotal: C.maxFleetsTotal,
      minFleetHeadroom: C.minFleetHeadroom, globalLimit }),
    maxFoundingsPerReview: C.maxFoundingsPerReview, maxFleetBuysPerReview: C.maxFleetBuysPerReview,
    stipendIskPerReview: C.stipendIskPerReview, maxIskBalance: C.maxIskBalance, initialIsk: C.initialIsk,
    baseMaxJumpsToPirate: C.baseMaxJumpsToPirate, baseScanMaxSystems: C.baseScanMaxSystems,
    baseCandidatesTop: C.baseCandidatesTop, baseSecClasses: D.parseSecClassList(C.baseSecClasses),
    pirateSystemsReadMax: C.pirateSystemsReadMax, templates: D.FLEET_TEMPLATES,
    rattingEnabled: C.rattingEnabled === true, maxDispatchesPerReview: C.maxDispatchesPerReview,
    rattingMaxJumps: C.rattingMaxJumps, rattingScanMaxSystems: C.rattingScanMaxSystems,
    rattingTargetScanMax: C.rattingTargetScanMax, rattingTargetsTop: C.rattingTargetsTop,
    rattingMaxFleetsPerSystem: C.rattingMaxFleetsPerSystem, hostileScanMaxFleets: C.hostileScanMaxFleets,
    maxHomeDispatchesPerReview: C.maxHomeDispatchesPerReview, orphanSweepsPerReview: C.orphanSweepsPerReview,
    mercenaryEnabled: C.mercenaryEnabled === true, maxMercenaryFleetsPerCorp: C.maxMercenaryFleetsPerCorp,
    mercTemplates: D.MERC_TEMPLATES, maxContractsPerCorp: C.maxContractsPerCorp,
    maxContractsPerEmpire: C.maxContractsPerEmpire, maxContractsPerReview: C.maxContractsPerReview,
    mercMaxContractsPerSystem: C.mercMaxContractsPerSystem, mercMaxJumps: C.mercMaxJumps,
    mercScanMaxSystems: C.mercScanMaxSystems, mercTargetScanMax: C.mercTargetScanMax, mercTargetsTop: C.mercTargetsTop,
    mercEnemyFleetsReadMax: C.mercEnemyFleetsReadMax, mercTargetSecClasses: D.parseSecClassList(C.mercTargetSecClasses),
    mercGuardMs: C.mercGuardMs, mercStepMs: C.mercStepMs, mercFeeFactorPermille: C.mercFeeFactorPermille,
    mercMinTreasuryMultiple: C.mercMinTreasuryMultiple,
    salvageEnabled: C.salvageEnabled === true, maxSalvageDispatchesPerReview: C.maxSalvageDispatchesPerReview,
    salvageMaxJumps: C.salvageMaxJumps, salvageScanMaxSystems: C.salvageScanMaxSystems,
    salvageFieldsPerSystem: C.salvageFieldsPerSystem,
    claimsEnabled: C.claimsEnabled === true, maxClaimsPerCorp: C.maxClaimsPerCorp,
    maxClaimsPerReview: C.maxClaimsPerReview, claimMaxJumps: C.claimMaxJumps,
    claimScanMaxSystems: C.claimScanMaxSystems });
}

function hireCapOf(P) {
  return D.MAX_SLOTS * Math.max(1, P.maxContractsPerCorp, P.maxMercenaryFleetsPerCorp);
}

function claimCapOf() {
  return D.MAX_SLOTS * D.MAX_CLAIMS_PER_CORP;
}

function createCapsuleerService(deps) {
  const { store, journal, corps, scheduler, fleetRepository, clock, config } = deps;
  const C = config.capsuleers;
  const P = paramsOf(C, config.limits);
  const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed : 0;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(Object.keys(COUNTERS).map((n) => [n, 0]));
  const excluded = new Set(EXPANSION_EXCLUDED_REGION_IDS);
  const isHostile = typeof deps.isHostile === "function" ? deps.isHostile : createHostility();
  let state = "running";
  let lastRefusal = null;
  let lastRound = null;
  let lastReviewAt = null;
  let corpList = Object.freeze([]);
  let fleetsByCorp = new Map();
  let claimList = Object.freeze([]);
  let claimsVersion = 0;

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
    metric("count", COUNTERS[name], n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const stopped = () => state !== "running";
  const roundOf = (t) => Math.floor(t / C.reviewPeriodMs) + 1;

  function soft(getter) {
    try {
      return typeof getter === "function" ? getter() || null : null;
    } catch (_err) {
      return null;
    }
  }

  function graphNow() {
    const r = soft(deps.getGraph);
    return r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
  }

  function isPirate(registry, factionId) {
    if (!Number.isSafeInteger(factionId) || factionId <= 0 || typeof registry.getFaction !== "function") return false;
    const f = registry.getFaction(factionId);
    if (!f || f.kind !== "pirate") return false;
    return typeof registry.isActive !== "function" || registry.isActive(factionId) === true;
  }

  function readRatting(db, registry, world, graph, list, fleets, cap, quietOf, heldBySlot) {
    const empty = { ok: true, openTrips: [], openTripFleetIds: new Set(), openByTarget: new Map(),
      targetsBySlot: new Map(), tripsTruncated: false };
    if (!deps.trips) return empty;
    const tl = deps.trips.listOpen(db, { limit: cap + 1 });
    if (!tl.ok) return tl;
    const openTrips = tl.trips.slice(0, Math.max(0, cap));
    const openTripFleetIds = new Set(tl.trips.map((t) => t.fleetId));
    const openByTarget = new Map();
    for (const t of tl.trips) {
      if (t.targetSystemId !== null && (t.state === S.OUTBOUND || t.state === S.RATTING)) {
        openByTarget.set(t.targetSystemId, (openByTarget.get(t.targetSystemId) || 0) + 1);
      }
    }
    const out = { ok: true, openTrips, openTripFleetIds, openByTarget, targetsBySlot: new Map(),
      tripsTruncated: tl.trips.length > cap };
    const repo = world && world.repository && typeof world.repository.getSystems === "function"
      ? world.repository : null;
    if (!P.rattingEnabled || !(P.maxDispatchesPerReview > 0) || !graph || !repo || out.tripsTruncated) return out;
    const batch = repo.limits && Number.isSafeInteger(repo.limits.maxBatchReadIds) && repo.limits.maxBatchReadIds > 0
      ? repo.limits.maxBatchReadIds : 1;
    const controllerOf = new Map();
    for (const corp of list) {
      if (corp.state !== "ACTIVE" || !corp.corporationId) continue;
      const waiting = fleets.some((f) => f.fleetRole === CAPSULEER_ROLE && f.corporationId === corp.corporationId
        && f.state === "IDLE" && f.refitPending !== true && f.currentSystemId === corp.baseSystemId
        && !openTripFleetIds.has(f.fleetId));
      if (!waiting) continue;
      const reach = bfs([corp.baseSystemId], (id) => graph.getNeighbors(id), { maxJumps: P.rattingMaxJumps,
        maxSystems: P.rattingScanMaxSystems });
      const near = [...reach.entries()].filter(([, jumps]) => jumps >= 1);
      const unknown = near.map(([id]) => id).filter((id) => !controllerOf.has(id));
      for (let i = 0; i < unknown.length; i += batch) {
        const r = repo.getSystems(db, unknown.slice(i, i + batch), { includeInfluence: false });
        if (!r || r.ok !== true) return r || { ok: false, reason: "WORLD_READ_FAILED" };
        for (const s of r.systems) controllerOf.set(s.systemId, s.controllerFactionId);
        for (const id of r.missing || []) controllerOf.set(id, null);
      }
      const candidates = near.filter(([id]) => isPirate(registry, controllerOf.get(id)))
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, P.rattingTargetScanMax);
      const targets = [];
      for (const [systemId, jumps] of candidates) {
        const q = quietOf(systemId);
        if (!q.ok) return q;
        if (q.quiet) targets.push({ systemId, jumps });
      }
      for (const claim of P.claimsEnabled && heldBySlot ? heldBySlot.get(corp.corpSlot) || [] : []) {
        const jumps = reach.get(claim.systemId);
        if (!(jumps >= 1) || controllerOf.get(claim.systemId) !== null) continue;
        const q = quietOf(claim.systemId);
        if (!q.ok) return q;
        if (q.quiet) targets.push({ systemId: claim.systemId, jumps, claim: true });
      }
      out.targetsBySlot.set(corp.corpSlot, targets);
    }
    return out;
  }

  function quietReader(db) {
    const quiet = new Map();
    return (systemId) => {
      if (!quiet.has(systemId)) {
        const fl = fleetRepository.listFleetsInSystem(db, systemId, { states: PRESENT_STATES,
          limit: P.hostileScanMaxFleets + 1 });
        if (!fl || fl.ok !== true) return fl || { ok: false, reason: "FLEETS_READ_FAILED" };
        quiet.set(systemId, !hostilesPresent(fl.fleets, { selfFactionId: D.CAPSULEER_FACTION_ID,
          isHostile, truncated: fl.fleets.length > P.hostileScanMaxFleets }));
      }
      return { ok: true, quiet: quiet.get(systemId) };
    };
  }

  function treasuryRunning(treasury) {
    try {
      return Boolean(treasury && typeof treasury.getMode === "function" && treasury.getMode() === "run");
    } catch (_err) {
      return false;
    }
  }

  function readHires(db, registry, world, graph, list, fleets, rat, fleetsTruncated) {
    const out = { ok: true, openContracts: [], contractsTruncated: false, snap: null };
    if (!deps.contracts) return out;
    const cap = hireCapOf(P);
    const cl = deps.contracts.listOpen(db, { limit: cap + 1 });
    if (!cl.ok) return cl;
    out.openContracts = cl.contracts.slice(0, cap);
    out.contractsTruncated = cl.contracts.length > cap;
    const treasury = soft(deps.getTreasury);
    const repo = world && world.repository && typeof world.repository.getSystems === "function"
      ? world.repository : null;
    if (!P.mercenaryEnabled || !(P.maxContractsPerReview > 0) || !treasuryRunning(treasury) || !graph || !repo
      || fleetsTruncated || rat.tripsTruncated || out.contractsTruncated
      || typeof treasury.readMercAccountInDb !== "function") return out;
    const busy = rat.openTripFleetIds;
    const freeMercs = [];
    const bases = new Map();
    for (const corp of list) {
      if (corp.state !== "ACTIVE" || !corp.corporationId) continue;
      for (const f of fleets) {
        if (f.fleetRole !== MERC_ROLE || f.corporationId !== corp.corporationId || f.state !== "IDLE"
          || f.refitPending === true || f.currentSystemId !== corp.baseSystemId || busy.has(f.fleetId)) continue;
        freeMercs.push({ slot: corp.corpSlot, fleetId: f.fleetId, expectedVersion: f.version,
          composition: f.composition });
        bases.set(corp.corpSlot, corp.baseSystemId);
      }
    }
    if (freeMercs.length === 0) return out;
    const pirates = registry.listActiveFactions().filter((f) => f && f.kind === "pirate"
      && isHostile(D.CAPSULEER_FACTION_ID, f.factionId)).map((f) => f.factionId).sort((a, b) => a - b);
    const ships = new Map();
    for (const factionId of pirates) {
      const r = fleetRepository.listFleetsByFaction(db, factionId, { states: PRESENT_STATES,
        limit: P.mercEnemyFleetsReadMax });
      if (!r || r.ok !== true) return r || { ok: false, reason: "FLEETS_READ_FAILED" };
      for (const f of r.fleets) {
        if (EVASIVE_ROLES.includes(f.fleetRole)) continue;
        if (!ships.has(f.currentSystemId)) ships.set(f.currentSystemId, new Map());
        const m = ships.get(f.currentSystemId);
        m.set(factionId, (m.get(factionId) || 0) + (Number.isSafeInteger(f.shipCount) ? f.shipCount : 0));
      }
    }
    const targetsBySlot = new Map();
    const wanted = new Set();
    for (const [slot, base] of bases) {
      const reach = bfs([base], (id) => graph.getNeighbors(id), { maxJumps: P.mercMaxJumps,
        maxSystems: P.mercScanMaxSystems });
      const targets = [...reach.entries()].filter(([id, jumps]) => jumps >= 1 && ships.has(id))
        .sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, P.mercTargetScanMax)
        .map(([systemId, jumps]) => ({ systemId, jumps }));
      for (const t of targets) wanted.add(t.systemId);
      targetsBySlot.set(slot, targets);
    }
    const batch = repo.limits && Number.isSafeInteger(repo.limits.maxBatchReadIds) && repo.limits.maxBatchReadIds > 0
      ? repo.limits.maxBatchReadIds : 1;
    const ids = [...wanted].sort((a, b) => a - b);
    const controllerOf = new Map();
    for (let i = 0; i < ids.length; i += batch) {
      const r = repo.getSystems(db, ids.slice(i, i + batch), { includeInfluence: false });
      if (!r || r.ok !== true) return r || { ok: false, reason: "WORLD_READ_FAILED" };
      for (const s of r.systems) controllerOf.set(s.systemId, s.controllerFactionId);
      for (const id of r.missing || []) controllerOf.set(id, null);
    }
    const accountOf = new Map();
    for (const id of ids) {
      const v = graph.getSystem(id);
      const E = v ? v.factionId : null;
      if (!Number.isSafeInteger(E) || E <= 0 || accountOf.has(E)) continue;
      let a;
      try {
        a = treasury.readMercAccountInDb(db, E);
      } catch (err) {
        a = { ok: false, reason: messageOf(err) };
      }
      accountOf.set(E, a || { ok: false, reason: "NO_RESULT" });
    }
    const open = { byCorp: new Map(), byEmployer: new Map(), bySystem: new Map() };
    const add = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    for (const c of out.openContracts) {
      add(open.byCorp, c.corpSlot);
      add(open.byEmployer, c.employerFactionId);
      add(open.bySystem, c.targetSystemId);
    }
    const enemiesBySystem = new Map([...ships].map(([systemId, m]) => [systemId,
      [...m].map(([factionId, n]) => ({ factionId, ships: n }))]));
    out.snap = { corps: list, freeMercs, targetsBySlot, enemiesBySystem, controllerOf, accountOf, open };
    return out;
  }

  function readClaims(db, world, graph, list, fleets, held, truncated) {
    const out = { ok: true, controllerOf: new Map(), missing: new Set(), nearIds: new Set(),
      candidatesBySlot: new Map() };
    const corpOf = new Map(list.map((c) => [c.corpSlot, c]));
    const fleetsOf = (corp) => fleets.filter((f) => f.corporationId === corp.corporationId);
    for (const claim of held) {
      const corp = corpOf.get(claim.corpSlot);
      if (!corp || corp.state !== "ACTIVE") continue;
      if (!graph) {
        out.nearIds.add(claim.claimId);
        continue;
      }
      const own = corp.corporationId ? fleetsOf(corp) : [];
      if (own.length === 0) continue;
      const reach = bfs([claim.systemId], (id) => graph.getNeighbors(id), { maxJumps: P.claimMaxJumps,
        maxSystems: P.claimScanMaxSystems });
      if (reach.size >= Math.max(1, P.claimScanMaxSystems) || own.some((f) => reach.has(f.currentSystemId))) {
        out.nearIds.add(claim.claimId);
      }
    }
    const repo = world && world.repository && typeof world.repository.getSystems === "function"
      ? world.repository : null;
    if (!repo) return out;
    const wanted = new Set(held.map((c) => c.systemId));
    if (graph && !truncated && P.maxClaimsPerReview > 0) {
      const heldOf = new Map();
      for (const c of held) heldOf.set(c.corpSlot, (heldOf.get(c.corpSlot) || 0) + 1);
      for (const corp of list) {
        if (corp.state !== "ACTIVE" || !corp.corporationId || fleetsOf(corp).length === 0
          || (heldOf.get(corp.corpSlot) || 0) >= P.maxClaimsPerCorp) continue;
        const reach = bfs([corp.baseSystemId], (id) => graph.getNeighbors(id), { maxJumps: P.claimMaxJumps,
          maxSystems: P.claimScanMaxSystems });
        const candidates = [];
        for (const [systemId, jumps] of reach) {
          if (jumps < 1) continue;
          const v = graph.getSystem(systemId);
          if (!v || v.secClass !== "nullsec" || excluded.has(v.regionId)) continue;
          candidates.push({ systemId, jumps });
          wanted.add(systemId);
        }
        out.candidatesBySlot.set(corp.corpSlot, candidates);
      }
    }
    const batch = repo.limits && Number.isSafeInteger(repo.limits.maxBatchReadIds) && repo.limits.maxBatchReadIds > 0
      ? repo.limits.maxBatchReadIds : 1;
    const ids = [...wanted].sort((a, b) => a - b);
    for (let i = 0; i < ids.length; i += batch) {
      const r = repo.getSystems(db, ids.slice(i, i + batch), { includeInfluence: false });
      if (!r || r.ok !== true) return r || { ok: false, reason: "WORLD_READ_FAILED" };
      for (const s of r.systems) out.controllerOf.set(s.systemId, s.controllerFactionId);
      for (const id of r.missing || []) out.missing.add(id);
    }
    return out;
  }

  function readReview(db, registry, world, graph, extra) {
    const list = corps.listCorps(db, { limit: D.MAX_SLOTS });
    if (!list.ok) return list;
    const cap = D.MAX_SLOTS * P.maxFleetsPerCorp;
    const fl = fleetRepository.listFleetsByFaction(db, D.CAPSULEER_FACTION_ID, { states: LIVE_FLEET_STATES,
      limit: cap + 1 });
    if (!fl.ok) return fl;
    const truncated = fl.fleets.length > cap || (fl.nextAfterFleetId !== null && fl.fleets.length < cap + 1);
    let globalActive = null;
    if (P.fleetBudget.enabled) {
      const counted = fleetRepository.countByState(db);
      if (!counted || counted.ok !== true) return counted || { ok: false, reason: "FLEET_COUNT_FAILED" };
      globalActive = counted.active;
    }
    const byCorp = new Map();
    const mercByCorp = new Map();
    for (const f of fl.fleets) {
      if (f.corporationId) byCorp.set(f.corporationId, (byCorp.get(f.corporationId) || 0) + 1);
      if (f.corporationId && f.fleetRole === MERC_ROLE) {
        mercByCorp.set(f.corporationId, (mercByCorp.get(f.corporationId) || 0) + 1);
      }
    }
    const pirateSystemIds = [];
    let pirateRead = false;
    if (list.corps.length < P.maxCorps && P.maxFoundingsPerReview > 0) {
      pirateRead = true;
      const repo = world && world.repository && typeof world.repository.listControlledByFaction === "function"
        ? world.repository : null;
      const pirates = repo ? registry.listActiveFactions().filter((f) => f && f.kind === "pirate")
        .map((f) => f.factionId).sort((a, b) => a - b) : [];
      for (const factionId of pirates) {
        const r = repo.listControlledByFaction(db, factionId, { limit: P.pirateSystemsReadMax });
        if (!r || r.ok !== true) return r || { ok: false, reason: "WORLD_READ_FAILED" };
        for (const s of r.systems) pirateSystemIds.push(s.systemId);
      }
    }
    const quietOf = quietReader(db);
    const claimsOn = P.claimsEnabled && Boolean(deps.claims);
    let held = [];
    let heldTruncated = false;
    if (claimsOn) {
      const claimCap = claimCapOf();
      const hl = deps.claims.listHeld(db, { limit: claimCap + 1 });
      if (!hl.ok) return hl;
      held = hl.claims.slice(0, claimCap);
      heldTruncated = hl.claims.length > claimCap;
    }
    const heldBySlot = new Map();
    for (const c of held) heldBySlot.set(c.corpSlot, [...(heldBySlot.get(c.corpSlot) || []), c]);
    const rat = readRatting(db, registry, world, graph, list.corps, fl.fleets, cap, quietOf, heldBySlot);
    if (!rat.ok) return rat;
    const claim = claimsOn ? readClaims(db, world, graph, list.corps, fl.fleets, held, truncated || heldTruncated)
      : null;
    if (claim && !claim.ok) return claim;
    const x = extra || {};
    const sal = readSalvageTargets(db, { corps: list.corps, fleets: fl.fleets, openTrips: rat.openTrips,
      tripsTruncated: rat.tripsTruncated, graph, wrecks: x.wrecks || null, salvage: x.salvage || null, quietOf,
      at: x.at, params: P, salvageParams: config.salvage });
    if (!sal.ok) return sal;
    const hire = readHires(db, registry, world, graph, list.corps, fl.fleets, rat, truncated);
    if (!hire.ok) return hire;
    return { ok: true, corps: list.corps, fleetsByCorp: byCorp, fleetsTruncated: truncated, fleetCount: fl.fleets.length,
      pirateSystemIds: [...new Set(pirateSystemIds)].sort((a, b) => a - b), pirateRead, fleets: fl.fleets,
      openTrips: rat.openTrips, openTripFleetIds: rat.openTripFleetIds, openByTarget: rat.openByTarget,
      targetsBySlot: rat.targetsBySlot, tripsTruncated: rat.tripsTruncated, mercByCorp,
      openContracts: hire.openContracts, hireSnap: hire.snap, fieldsBySlot: sal.fieldsBySlot,
      openFieldIds: sal.openFieldIds, fieldsSeen: sal.seen, claimsOn, held, heldTruncated, claimRead: claim,
      globalActive };
  }

  function stationsReader() {
    const memo = new Map();
    return (systemId) => {
      if (memo.has(systemId)) return memo.get(systemId);
      let out = [];
      try {
        const r = deps.listStations(systemId);
        if (r && r.ok === true && Array.isArray(r.stations)) out = r.stations;
      } catch (_err) {
        out = [];
      }
      memo.set(systemId, out);
      return out;
    };
  }

  function ensureSpecOf(corp, graph) {
    const v = graph ? graph.getSystem(corp.baseSystemId) : null;
    const race = VC.getById(corp.raceFactionId);
    if (!v || !race || !Array.isArray(race.bloodlineIds)) return null;
    return { ownerKind: "capsuleer", ownerId: corp.corpSlot,
      corporation: { name: corp.name, ticker: corp.ticker, description: D.CORP_DESCRIPTION },
      members: P.membersPerCorp, stationId: corp.baseStationId, stationCorporationId: corp.baseStationCorpId,
      systemId: corp.baseSystemId, constellationId: v.constellationId, regionId: v.regionId,
      bloodlineIds: race.bloodlineIds.slice(), securityRating: D.SECURITY_RATING };
  }

  function once(etx, key, slot, eventType, payload, fn, aggregate) {
    const seen = journal.findByKey(etx, key);
    if (!seen.ok) return { ok: false, reason: seen.reason || "JOURNAL_READ_FAILED" };
    if (seen.found) return { ok: true, duplicate: true };
    const r = journal.applyOnce(etx, { key, aggregate: aggregate || { type: S.CORP_AGGREGATE, id: slot }, eventType,
      payload }, fn);
    if (r.ok) return r.duplicate ? { ok: true, duplicate: true } : { ok: true, value: r.value };
    if (r.reason === "APPLY_REFUSED") {
      return { ok: true, refused: String((r.refusal && r.refusal.reason) || "REFUSED") };
    }
    if (r.reason === "APPLY_FAILED") {
      return { ok: true, refused: `APPLY_FAILED: ${messageOf(r.error)}`, applyFailed: true };
    }
    return { ok: false, reason: r.reason || "APPLY_FAILED" };
  }

  function foundEffect(etx, at, slot, base) {
    const name = corpNameOf(slot);
    const raceFactionId = createRng(deriveSeed(worldSeed, "capsuleer-race", slot)).pick(D.RACE_SOURCE_FACTION_IDS);
    const payload = { slot, name: name.name, ticker: name.ticker, baseSystemId: base.systemId,
      baseStationId: base.stationId, raceFactionId, initialIsk: P.initialIsk };
    return once(etx, S.foundKey(slot), slot, S.EVENT_FOUNDED, payload, (db) => corps.createCorp(db, { slot,
      factionId: D.CAPSULEER_FACTION_ID, name: name.name, ticker: name.ticker, baseSystemId: base.systemId,
      baseStationId: base.stationId, baseStationCorpId: base.stationCorporationId, raceFactionId,
      iskBalance: P.initialIsk, seed: deriveSeed(worldSeed, "capsuleer", slot), at }));
  }

  function transitionEffect(etx, at, slot, a) {
    if (a.identity) {
      const id = a.identity;
      const payload = { slot, corporationId: id.corporationId, ceoCharacterId: id.ceoCharacterId,
        memberIds: id.characterIds.slice(0, 16), name: String(id.name || "").slice(0, 50),
        ticker: String(id.ticker || "") };
      return once(etx, S.activateKey(slot), slot, S.EVENT_TRANSITION, { to: "ACTIVE", ...payload }, (db) => {
        const g = corps.getCorp(db, slot);
        if (!g.ok) return g;
        if (!g.corp || g.corp.state !== "FOUNDING") return { ok: false, reason: "STATE_CHANGED" };
        return corps.activate(db, { ...payload, expectedVersion: g.corp.version, at });
      });
    }
    return once(etx, S.refuseKey(slot), slot, S.EVENT_TRANSITION, { to: "REFUSED", slot, reason: a.reason }, (db) => {
      const g = corps.getCorp(db, slot);
      if (!g.ok) return g;
      if (!g.corp || g.corp.state !== "FOUNDING") return { ok: false, reason: "STATE_CHANGED" };
      return corps.refuse(db, { slot, expectedVersion: g.corp.version, reason: a.reason, at });
    });
  }

  function stipendEffect(etx, at, round, s) {
    return once(etx, S.stipendKey(round, s.slot), s.slot, S.EVENT_WALLET, { kind: "stipend", slot: s.slot, round,
      amount: s.amount }, (db) => {
      const g = corps.getCorp(db, s.slot);
      if (!g.ok) return g;
      if (!g.corp || g.corp.state !== "ACTIVE") return { ok: false, reason: "STATE_CHANGED" };
      const amount = Math.min(s.amount, P.maxIskBalance - g.corp.iskBalance);
      if (!(amount > 0)) return { ok: false, reason: "WALLET_FULL" };
      return corps.credit(db, { slot: s.slot, expectedVersion: g.corp.version, amount, maxBalance: P.maxIskBalance,
        at });
    });
  }

  function buyEffect(etx, at, round, b) {
    const k = S.buyKey(round, b.slot);
    const fleetRole = b.fleetRole === MERC_ROLE ? MERC_ROLE : CAPSULEER_ROLE;
    const template = (fleetRole === MERC_ROLE ? P.mercTemplates : P.templates)
      .find((t) => t.templateId === b.templateId);
    return once(etx, k, b.slot, S.EVENT_WALLET, { kind: "buy", slot: b.slot, round, templateId: b.templateId,
      costIsk: b.costIsk }, (db) => {
      const g = corps.getCorp(db, b.slot);
      if (!g.ok) return g;
      const corp = g.corp;
      if (!corp || corp.state !== "ACTIVE" || !template) return { ok: false, reason: "STATE_CHANGED" };
      if (corp.iskBalance < b.costIsk) return { ok: false, reason: "NO_FUNDS" };
      const f = fleetRepository.createFleet(db, { factionId: D.CAPSULEER_FACTION_ID,
        corporationId: corp.corporationId, currentSystemId: corp.baseSystemId, homeSystemId: corp.baseSystemId,
        fleetRole, composition: template.composition.map((e) => ({ hullGroup: e.hullGroup,
          typeId: e.typeId, count: e.count })) }, `${k}:fleet`);
      if (!f || f.ok !== true) return f || { ok: false, reason: "FLEET_CREATE_FAILED" };
      if (f.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED" };
      const d = corps.debitForFleet(db, { slot: b.slot, expectedVersion: corp.version, amount: b.costIsk, at });
      if (!d.ok) return d;
      return { ok: true, fleetId: f.fleetId, corporationId: corp.corporationId, fleetRole };
    });
  }

  function hireEffect(etx, at, round, h, corp) {
    const k = S.hireKey(round, h.fleetId);
    const service = deps.contractService;
    const ratting = soft(deps.getRatting);
    return once(etx, k, h.slot, S.EVENT_CORP_HIRE, { kind: "hire", slot: h.slot, round, fleetId: h.fleetId,
      targetSystemId: h.targetSystemId, employerFactionId: h.employerFactionId, enemyFactionId: h.enemyFactionId,
      contractKind: h.kind, feeIsk: h.feeIsk }, (db) => service.hireInTx(db, { ...h, at,
      baseSystemId: corp.baseSystemId }, k, ratting));
  }

  function membersEffect(etx, at, round, m) {
    return once(etx, S.membersKey(round, m.slot), m.slot, S.EVENT_CORP_MEMBERS, { slot: m.slot, round,
      memberIds: m.memberIds.slice() }, (db) => {
      const g = corps.getCorp(db, m.slot);
      if (!g.ok) return g;
      if (!g.corp || g.corp.state !== "ACTIVE") return { ok: false, reason: "STATE_CHANGED" };
      return corps.setMembers(db, { slot: m.slot, expectedVersion: g.corp.version, memberIds: m.memberIds, at });
    });
  }

  function claimsEffect(etx, round, at, claimPlan, out) {
    const claims = deps.claims;
    for (const l of claims ? claimPlan.losses : []) {
      const r = once(etx, S.claimLoseKey(round, l.claimId), l.slot, S.EVENT_CLAIM_LOST, { claimId: l.claimId,
        reason: l.reason }, (db) => claims.loseClaimInDb(db, { claimId: l.claimId, expectedVersion: l.expectedVersion,
        reason: l.reason, at }), { type: S.CLAIM_AGGREGATE, id: l.claimId });
      if (!r.ok) return r;
      if (r.value) out.claimsLost.push(r.value.claim);
      else if (r.refused) {
        out.claimRefused += 1;
        if (r.applyFailed) out.applyFailed += 1;
        out.refusals.push(`CLAIM_${r.refused}`);
      }
    }
    for (const c of claims ? claimPlan.claims : []) {
      const claimId = S.claimIdOf(c.slot, c.systemId, round);
      const r = once(etx, S.claimKey(round, c.slot), c.slot, S.EVENT_CLAIM_CREATED, { slot: c.slot,
        systemId: c.systemId }, (db) => claims.createClaimInDb(db, { claimId, slot: c.slot, systemId: c.systemId, at }),
      { type: S.CLAIM_AGGREGATE, id: claimId });
      if (!r.ok) return r;
      if (r.value) out.claimsCreated.push(r.value.claim);
      else if (r.refused) {
        out.claimRefused += 1;
        if (r.applyFailed) out.applyFailed += 1;
        out.refusals.push(`CLAIM_${r.refused}`);
      }
    }
    return { ok: true };
  }

  function reviewEffect(etx, round, at, read, plan, base, graph, dispatches, sweeps, hires, claimPlan) {
    const out = { ok: true, founded: null, foundRefused: null, foundApplyFailed: false, activated: [], refused: [],
      stipends: 0, bought: [], fleetLimit: 0, buyRefused: 0, refusals: [], ensure: [], corps: [], applyFailed: 0,
      dispatched: [], dispatchRefused: 0, pruned: 0, orphansReleased: 0, membersRefreshed: 0,
      hires: [], hireRefused: 0, hireNoTreasury: 0, orphanContracts: [], contractsPruned: 0,
      claimsCreated: [], claimsLost: [], claimRefused: 0, claimsPruned: 0 };
    if (plan.found && base && base.ok) {
      const r = foundEffect(etx, at, plan.found.slot, base);
      if (!r.ok) return r;
      if (r.value) out.founded = r.value.corp;
      else if (r.refused) {
        out.foundRefused = r.refused;
        out.foundApplyFailed = r.applyFailed === true;
      }
    }
    for (const a of [...plan.activate, ...plan.refuse]) {
      const r = transitionEffect(etx, at, a.slot, a);
      if (!r.ok) return r;
      if (r.value && a.identity) out.activated.push(a.slot);
      else if (r.value) out.refused.push(a.slot);
      else if (r.refused) {
        out.refusals.push(r.refused);
        if (r.applyFailed) out.applyFailed += 1;
      }
    }
    for (const s of plan.stipends) {
      const r = stipendEffect(etx, at, round, s);
      if (!r.ok) return r;
      if (r.value) out.stipends += 1;
    }
    for (const b of plan.buys) {
      const r = buyEffect(etx, at, round, b);
      if (!r.ok) return r;
      if (r.value) out.bought.push(r.value);
      else if (r.refused === "FLEET_LIMIT") out.fleetLimit += 1;
      else if (r.refused) {
        out.buyRefused += 1;
        out.refusals.push(r.refused);
      }
    }
    const trips = deps.trips;
    const ratting = soft(deps.getRatting);
    if (trips && C.tripPruneBatch > 0) {
      const pr = trips.prune(etx, Math.max(0, at - C.tripRetentionMs), C.tripPruneBatch);
      if (!pr.ok) return pr;
      out.pruned = pr.pruned;
    }
    if (deps.contracts && C.tripPruneBatch > 0) {
      const pc = deps.contracts.prune(etx, Math.max(0, at - C.tripRetentionMs), C.tripPruneBatch);
      if (!pc.ok) return pc;
      out.contractsPruned = pc.pruned;
    }
    if (deps.claims && C.tripPruneBatch > 0) {
      const pl = deps.claims.prune(etx, Math.max(0, at - C.tripRetentionMs), C.tripPruneBatch);
      if (!pl.ok) return pl;
      out.claimsPruned = pl.pruned;
    }
    for (const s of ratting ? sweeps : []) {
      const r = ratting.sweepInTx(etx, s, S.sweepKey(round, s.fleetId));
      if (r && r.ok === true) {
        if (r.released) out.orphansReleased += 1;
      } else out.refusals.push(`SWEEP_${String((r && r.reason) || "REFUSED")}`);
    }
    for (const m of plan.refresh || []) {
      const r = membersEffect(etx, at, round, m);
      if (!r.ok) return r;
      if (r.value) out.membersRefreshed += 1;
      else if (r.refused) {
        out.refusals.push(`MEMBERS_${r.refused}`);
        if (r.applyFailed) out.applyFailed += 1;
      }
    }
    if (claimPlan) {
      const cr = claimsEffect(etx, round, at, claimPlan, out);
      if (!cr.ok) return cr;
    }
    for (const d of ratting ? dispatches : []) {
      const corp = read.corps.find((c) => c.corpSlot === d.slot);
      const r = corp ? ratting.dispatchInTx(etx, { kind: d.kind, slot: d.slot, fleetId: d.fleetId,
        expectedVersion: d.expectedVersion, baseSystemId: corp.baseSystemId, targetSystemId: d.targetSystemId, at,
        ...(d.kind === S.SALVAGE_TRIP_KIND ? { fieldId: d.fieldId } : {}) },
      S.dispatchKey(round, d.fleetId)) : { ok: false, reason: "CORP_NOT_FOUND" };
      if (r && r.ok === true) {
        if (!r.duplicate) out.dispatched.push({ kind: d.kind, trip: r.trip || null });
      } else {
        out.dispatchRefused += 1;
        out.refusals.push(`DISPATCH_${String((r && r.reason) || "REFUSED")}`);
      }
    }
    const service = deps.contractService || null;
    for (const c of service && trips ? read.openContracts || [] : []) {
      const r = service.closeOrphanInTx(etx, c, at, S.contractCloseKey(round, c.contractId), trips);
      if (r && r.ok === true) {
        if (r.closed) out.orphanContracts.push(r.closed);
      } else out.refusals.push(`CONTRACT_${String((r && r.reason) || "REFUSED")}`);
    }
    for (const h of service && ratting ? hires : []) {
      const corp = read.corps.find((c) => c.corpSlot === h.slot);
      const r = corp ? hireEffect(etx, at, round, h, corp) : { ok: true, refused: "CORP_NOT_FOUND" };
      if (!r.ok) return r;
      if (r.value) out.hires.push(r.value);
      else if (r.applyFailed) {
        out.applyFailed += 1;
        out.refusals.push(`HIRE_${r.refused}`);
      } else if (r.refused) {
        if (NO_TREASURY_REASONS.includes(r.refused)) out.hireNoTreasury += 1;
        else out.hireRefused += 1;
        out.refusals.push(`HIRE_${r.refused}`);
      }
    }
    const after = corps.listCorps(etx, { limit: D.MAX_SLOTS });
    if (!after.ok) return after;
    out.corps = after.corps;
    for (const c of after.corps) {
      if (c.state !== "FOUNDING" && !(c.state === "ACTIVE" && plan.ensure.includes(c.corpSlot))) continue;
      const spec = ensureSpecOf(c, graph);
      if (spec) out.ensure.push(spec);
    }
    return out;
  }

  function onReview(ev, hctx) {
    try {
      const p = parseReviewPayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "CAPSULEERS_PAYLOAD_INVALID", permanent: true };
      if (stopped()) return { ok: false, reason: "CAPSULEERS_STOPPED" };
      const registry = soft(deps.getRegistry);
      if (!registry || typeof registry.listActiveFactions !== "function") {
        return { ok: false, reason: "STRATEGY_NOT_READY" };
      }
      const vc = soft(deps.getVirtualCorps);
      if (!vc || typeof vc.getOwnerIdentity !== "function" || typeof vc.ensureOwnerIdentity !== "function") {
        return { ok: false, reason: "VIRTUAL_CORPS_NOT_READY" };
      }
      const at = hctx && isTime(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const t0 = nowMs();
      const world = soft(deps.getWorld);
      const graph = graphNow();
      const extra = { at, wrecks: soft(deps.getWrecks), salvage: soft(deps.getSalvage) };
      const tx = store.transaction("capsuleers.reviewRead", (db) => readReview(db, registry, world, graph, extra));
      const read = tx.ok ? tx.value : tx;
      if (!read || read.ok !== true) {
        const reason = String((read && read.reason) || "CAPSULEERS_READ_FAILED");
        lastRefusal = reason;
        return { ok: false, reason };
      }
      const identities = new Map();
      for (const c of read.corps) {
        if (c.state === "FOUNDING" || (c.state === "ACTIVE" && c.memberIds.length < P.membersPerCorp)) {
          identities.set(c.corpSlot, vc.getOwnerIdentity("capsuleer", c.corpSlot));
        }
      }
      const mercBuy = P.mercenaryEnabled && Boolean(deps.contractService) && treasuryRunning(soft(deps.getTreasury));
      const planSnap = { corps: read.corps, identities, fleetsByCorp: read.fleetsByCorp,
        mercByCorp: read.mercByCorp, fleetsTruncated: read.fleetsTruncated, round: p.round };
      if (P.fleetBudget.enabled) {
        planSnap.fleetsTotal = read.fleetCount;
        planSnap.globalActive = read.globalActive;
      }
      const plan = planReview(planSnap, { ...P, mercBuy });
      const truncated = read.fleetsTruncated || read.tripsTruncated;
      const cr = read.claimRead;
      const claimPlan = read.claimsOn && cr ? planClaims({ corps: read.corps, fleets: read.fleets,
        fleetsTruncated: read.fleetsTruncated, held: read.held, heldTruncated: read.heldTruncated,
        controllerOf: cr.controllerOf, missing: cr.missing, fleetNearClaim: (c) => cr.nearIds.has(c.claimId),
        candidatesBySlot: cr.candidatesBySlot, vertexOf: (id) => (graph ? graph.getSystem(id) : null),
        excludedRegionIds: excluded, round: p.round }, P) : { losses: [], claims: [] };
      const lostSystems = new Set(claimPlan.losses.map((l) => l.systemId));
      const targetsBySlot = new Map([...read.targetsBySlot].map(([slot, list]) => [slot,
        list.filter((t) => !(t.claim === true && lostSystems.has(t.systemId)))]));
      const salvage = planSalvageDispatches({ corps: read.corps, fleets: read.fleets, fleetsTruncated: truncated,
        openTripFleetIds: read.openTripFleetIds, openFieldIds: read.openFieldIds, fieldsBySlot: read.fieldsBySlot }, P);
      const dispatches = [...salvage, ...planDispatches({ corps: read.corps, fleets: read.fleets,
        fleetsTruncated: truncated, openTripFleetIds: new Set([...read.openTripFleetIds,
          ...salvage.map((d) => d.fleetId)]),
        openByTarget: read.openByTarget, targetsBySlot, round: p.round }, P)];
      const sweeps = deps.trips ? planSweeps(read.fleets, read.openTripFleetIds,
        { orphanSweepsPerReview: P.orphanSweepsPerReview, truncated }) : [];
      const hs = read.hireSnap;
      const hirePlan = hs ? planHires({ ...hs, round: p.round, vertexOf: (id) => graph.getSystem(id),
        factionOf: (id) => registry.getFaction(id), isActive: (id) => typeof registry.isActive !== "function"
          || registry.isActive(id) === true, isHostile }, P) : { hires: [], refused: { noTreasury: 0, treasuryLow: 0,
        austerity: 0 } };
      let base = null;
      let graphMissing = false;
      if (plan.found) {
        if (!graph) graphMissing = true;
        else {
          base = planBase({ pirateSystemIds: read.pirateSystemIds, neighbors: (id) => graph.getNeighbors(id),
            vertexOf: (id) => graph.getSystem(id), stationsOf: stationsReader(),
            takenBaseIds: new Set(read.corps.map((c) => c.baseSystemId)), excludedRegionIds: excluded,
            rng: createRng(deriveSeed(worldSeed, "capsuleer-base", plan.found.slot)) }, P);
        }
      }
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      const next = roundOf(at);
      const busy = plan.found || plan.activate.length + plan.buys.length + dispatches.length + sweeps.length
        + plan.refresh.length + hirePlan.hires.length + claimPlan.losses.length + claimPlan.claims.length > 0;
      return { ok: true, outcome: busy ? "REVIEW" : "IDLE",
        effect: (etx) => reviewEffect(etx, p.round, at, read, plan, base, graph, dispatches, sweeps, hirePlan.hires,
          claimPlan),
        reschedule: { eventType: S.REVIEW_EVENT, aggregateId: S.REVIEW_AGGREGATE_ID, dueAt: next * C.reviewPeriodMs,
          payload: { round: next }, idempotencyKey: S.reviewKey(next) },
        onCommitted: (v) => committed(v, { at, round: p.round, ms, base, graphMissing, read, vc,
          hireRefused: hirePlan.refused, budgetRefused: plan.budgetRefused }) };
    } catch (err) {
      return { ok: false, reason: `CAPSULEERS_REVIEW_FAILED: ${messageOf(err)}` };
    }
  }

  function committed(v, r) {
    bump("reviews");
    bump("fleetBudget", r.budgetRefused);
    lastRound = r.round;
    lastReviewAt = r.at;
    metric("observe", METRIC_REVIEW_MS, r.ms);
    if (r.graphMissing) bump("graphNotReady");
    if (r.base && r.base.ok !== true) {
      bump("noBase");
      lastRefusal = r.base.reason;
    }
    if (!v) return;
    if (v.founded) {
      bump("founded");
      log(`capsuleers: corp ${v.founded.corpSlot} "${v.founded.name}" [${v.founded.ticker}] founded base=`
        + `${v.founded.baseSystemId}/${v.founded.baseStationId}`);
    } else if (v.foundRefused) {
      bump(v.foundApplyFailed ? "applyFailed" : "noBase");
      lastRefusal = v.foundRefused;
    }
    bump("applyFailed", v.applyFailed);
    bump("activated", v.activated.length);
    bump("refused", v.refused.length);
    bump("stipends", v.stipends);
    bump("fleetsBought", v.bought.length);
    bump("mercFleetsBought", v.bought.filter((b) => b.fleetRole === MERC_ROLE).length);
    bump("fleetLimit", v.fleetLimit);
    bump("buyRefused", v.buyRefused);
    if (v.refusals.length > 0) lastRefusal = v.refusals[v.refusals.length - 1];
    const byCorp = new Map(r.read.fleetsByCorp);
    for (const b of v.bought) byCorp.set(b.corporationId, (byCorp.get(b.corporationId) || 0) + 1);
    fleetsByCorp = byCorp;
    corpList = Object.freeze(v.corps.slice());
    metric("gauge", METRIC_CORPS, v.corps.length);
    metric("gauge", METRIC_FLEETS, r.read.fleetCount + v.bought.length);
    bump("dispatched", v.dispatched.filter((d) => d.kind === "rat").length);
    bump("homingDispatched", v.dispatched.filter((d) => d.kind === "home").length);
    bump("salvageDispatched", v.dispatched.filter((d) => d.kind === S.SALVAGE_TRIP_KIND).length);
    bump("dispatchRefused", v.dispatchRefused);
    bump("tripsPruned", v.pruned);
    bump("orphansReleased", v.orphansReleased);
    bump("membersRefreshed", v.membersRefreshed);
    bump("claimsCreated", v.claimsCreated.length);
    bump("claimsLost", v.claimsLost.length);
    bump("claimsLostController", v.claimsLost.filter((c) => c.lostReason === "CONTROLLER").length);
    bump("claimsLostNoFleet", v.claimsLost.filter((c) => c.lostReason === "NO_FLEET").length);
    bump("claimRefused", v.claimRefused);
    if (r.read.claimsOn) {
      const byId = new Map((r.read.held || []).map((c) => [c.claimId, c]));
      for (const c of [...v.claimsLost, ...v.claimsCreated]) byId.set(c.claimId, c);
      claimList = Object.freeze([...byId.values()].sort((a, b) => (a.claimId < b.claimId ? -1
        : a.claimId > b.claimId ? 1 : 0)));
      claimsVersion += 1;
      metric("gauge", METRIC_CLAIMS_HELD, claimList.filter((c) => c.state === "HELD").length);
    }
    const ratting = soft(deps.getRatting);
    if (ratting && typeof ratting.setTrips === "function") {
      ratting.setTrips([...(r.read.openTrips || []), ...v.dispatched.map((d) => d.trip).filter((t) => t),
        ...v.hires.map((h) => h.trip).filter((t) => t)]);
    }
    const service = deps.contractService;
    if (service && typeof service.onReviewCommitted === "function") {
      try {
        const rf = r.hireRefused || {};
        const closedIds = new Set(v.orphanContracts.map((c) => c.contract && c.contract.contractId));
        service.onReviewCommitted({ hires: v.hires, hireRefused: v.hireRefused + (rf.treasuryLow || 0)
          + (rf.austerity || 0), hireNoTreasury: v.hireNoTreasury + (rf.noTreasury || 0),
        orphans: v.orphanContracts, open: (r.read.openContracts || []).filter((c) => !closedIds.has(c.contractId)),
        lastRefusal: v.refusals.find((x) => x.startsWith("HIRE_")) || null });
      } catch (_err) {
      }
    }
    for (const spec of v.ensure) {
      bump("ensureCalls");
      let e;
      try {
        e = r.vc.ensureOwnerIdentity(spec);
      } catch (err) {
        e = { ok: false, reason: messageOf(err) };
      }
      if (!e || e.ok !== true) {
        bump("ensureRefused");
        lastRefusal = `ENSURE_${String((e && e.reason) || "REFUSED")}`;
        log(`capsuleers: ensure identity of corp ${spec.ownerId} refused - ${(e && e.reason) || "no result"}`);
      }
    }
  }

  function bootstrap() {
    try {
      if (stopped()) return { ok: false, reason: "CAPSULEERS_STOPPED" };
      const round = roundOf(clock.now());
      const r = scheduler.enqueue(S.REVIEW_EVENT, S.REVIEW_AGGREGATE_ID, round * C.reviewPeriodMs, { round },
        S.reviewKey(round));
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, duplicate: r.duplicate === true, round };
    } catch (err) {
      return { ok: false, reason: `CAPSULEERS_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function listCorps() {
    return corpList.map((c) => Object.freeze({ ...c, fleetsAlive: c.corporationId
      ? fleetsByCorp.get(c.corporationId) || 0 : 0 }));
  }

  function setCorps(list) {
    corpList = Object.freeze((list || []).slice());
  }

  function getStatus() {
    return Object.freeze({ state: stopped() ? "off" : "ready", counters: Object.freeze({ ...counters }),
      corps: corpList.length, lastRound, lastReviewAt, lastRefusal });
  }

  return Object.freeze({
    onReview,
    bootstrap,
    listCorps,
    setCorps,
    listClaims: () => claimList,
    getClaimsVersion: () => claimsVersion,
    getStatus,
    getLastRound: () => lastRound,
    getMode: () => (stopped() ? "off" : "ready"),
    stop() {
      state = "stopped";
    },
    isStopped: stopped,
  });
}

module.exports = { createCapsuleerService, parseReviewPayload, paramsOf, hireCapOf, claimCapOf, COUNTERS,
  LIVE_FLEET_STATES };
