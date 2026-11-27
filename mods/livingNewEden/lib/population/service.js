"use strict";

const { performance } = require("node:perf_hooks");
const { DeadlineQueue } = require("../scheduler/deadlineQueue");
const { createRng, deriveSeed } = require("../util/rng");
const { createSlowOpLog } = require("../telemetry/slowOps");
const S_ = require("./schema");
const repo = require("./repository");
const rules = require("./rules");
const { buildSystemTable } = require("./context");
const { createPilotStore } = require("./store");
const { createNearLayer } = require("./near");
const { createLiveOwnership, activityIntentCodes } = require("./live");
const { createWorldContext } = require("./worldContext");
const { buildStandingTables, createStandings } = require("./standings");
const { createCorpsService } = require("./corps/service");
const corpsRepo = require("./corps/repository");
const { createGroupsService } = require("./groups/service");
const { HULL_CLASS_NAMES, ROUTE_RESTRICTED_CLASSES, hullClassOf, isLiveHull, isRouteRestricted } =
  require("./data/hullPools");
const { CAREER, CAREER_NAMES, identityKey } = require("./lifecycle/schema");
const lifeRules = require("./lifecycle/rules");
const { createLifecycle } = require("./lifecycle/service");

const { STATE, INTENT, ARCHETYPE, BANDS, PREWARM_MASK } = S_;
const UINT32_RANGE = 4294967296;
const LIST_DEFAULT_LIMIT = 200;
const COUNTER_NAMES = S_.COUNTER_NAMES;
const EMPTY_LIST = Object.freeze([]);

const messageOf = (err) => String((err && err.message) || err);
const keyOf = (id) => `p:${id}`;

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

const defaultYield = () => new Promise((resolve) => setImmediate(resolve));

function createPopulationService(deps) {
  const store = deps.store;
  const worldSeed = deps.worldSeed;
  const S = deps.settings;
  const clock = deps.clock;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const yieldTurn = typeof deps.yieldTurn === "function" ? deps.yieldTurn : defaultYield;
  const maxRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
    ? store.limits.maxRowsPerTransaction : S.flushRowsPerSlice + 1;
  const corpsWanted = S.corps && S.corps.enabled === true;
  const corpsOn = corpsWanted && S.standings && S.standings.enabled === true && typeof deps.generateName === "function";
  const corpsCap = corpsOn ? Math.max(1, S.corps.flushRowsPerSlice) : 0;
  const flushCap = Math.max(1, Math.min(S.flushRowsPerSlice, maxRows - 1 - 2 * corpsCap));
  const seedCap = Math.max(1, Math.min(S.seedRowsPerSlice, maxRows - 1));
  const slowLog = createSlowOpLog({ slowOpMs: deps.slowOpMs, perMin: deps.slowOpLogPerMin, nowMs, logger });

  const pilots = createPilotStore(S.size);
  const queue = new DeadlineQueue();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = "starting";
  let lastError = null;
  let stopped = false;
  let graph = null;
  let table = null;
  let loaded = 0;
  let metaSeededAt = 0;
  let retirePending = false;
  let lastFlushAt = 0;
  let flushCycle = false;
  let failLogAt = -Infinity;
  let routesLeft = 0;
  let lastPass = Object.freeze({ events: 0, ms: 0, lagMs: 0 });
  let lastFlush = Object.freeze({ rows: 0, ms: 0, at: 0 });
  let eventsTotal = 0;
  let runningAt = null;
  let memoryProbe = null;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    safeCall(() => telemetry[kind](name, value));
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `population.${name}`, n);
  }

  function admits(workClass) {
    const governor = typeof deps.getGovernor === "function" ? safeCall(deps.getGovernor) : null;
    if (!governor || typeof governor.admits !== "function") return true;
    return safeCall(() => governor.admits(workClass) !== false, true);
  }

  const identityOf = (id) => identityKey(id, pilots.genOf(id));
  const activityIntents = S.near.enabled === true && S.live.trafficEnabled === true
    ? activityIntentCodes(deps.activityIntents) : EMPTY_LIST;
  const near = S.near.enabled === true ? createNearLayer({ S, worldSeed, pilots, bump, identityOf,
    getPresence: typeof deps.getPresence === "function" ? deps.getPresence : () => null,
    getGraph: () => graph, getTable: () => table, departures: S.live.trafficEnabled === true,
    ...(activityIntents.length > 0 ? { activityIntents } : {}) }) : null;
  const activeLife = S.activeLife && S.activeLife.enabled === true;
  const standingsOn = S.standings && S.standings.enabled === true;
  let standingTables = null;
  let standings = null;
  let standingsReason = null;
  let censusCache = null;
  const worldCtx = S.context.enabled === true && deps.contextSources && typeof deps.contextSources === "object"
    ? createWorldContext({ S, getTable: () => table, sources: deps.contextSources, bump, nowMs,
      metric: (kind, name, value) => metric(kind, name, value),
      ...(standingsOn ? { standing: { getTables: () => standingTables } } : {}) }) : null;
  const ctxView = worldCtx ? worldCtx.view() : null;
  const standingOpts = standingsOn && ctxView ? Object.freeze({
    profileOf: (pilotId) => (standings ? standings.profileOf(pilotId) : -1),
    dangerForProfile: ctxView.dangerForProfile, weightForProfile: ctxView.weightForProfile,
    hostileOnRoute: ctxView.hostileOnRoute }) : null;
  const rollOpts = near || worldCtx || activeLife ? Object.freeze({ ...(near ? { attract: near.attract } : {}),
    ...(worldCtx ? { context: ctxView } : {}),
    ...(worldCtx || activeLife ? { note: (name) => bump(name) } : {}),
    ...(standingOpts ? { standing: standingOpts } : {}) }) : undefined;
  const hullsOn = S.hulls && S.hulls.enabled === true;
  const ROUTE_OPTS = Object.freeze({ maxJumps: S.maxTripJumps });
  const ROUTE_OPTS_RESTRICTED = hullsOn && S.hulls.avoidSecClasses.length > 0
    ? Object.freeze({ maxJumps: S.maxTripJumps, avoidSecClasses: S.hulls.avoidSecClasses }) : null;
  const restricted = (id) => {
    const p = pilots.get(id);
    return p !== null && isRouteRestricted(p.shipTypeId);
  };
  const hullCounts = hullsOn ? new Int32Array(HULL_CLASS_NAMES.length + 1) : null;
  const groups = S.groups && S.groups.enabled === true ? createGroupsService({ S, worldSeed, pilots, queue, keyOf, bump,
    profileOf: (id) => (standings ? standings.profileOf(id) : -1),
    isOwned: (id) => live !== null && live.isOwned(id),
    ...(ROUTE_OPTS_RESTRICTED ? { isRestricted: restricted } : {}) }) : null;
  const groupLive = groups !== null && S.groups.liveSpawnEnabled === true;
  const live = near && S.live.trafficEnabled === true ? createLiveOwnership({ S, pilots, queue, near, step, commit, bump,
    keyOf, maxOwned: Number.isSafeInteger(deps.liveMaxOwned) && deps.liveMaxOwned > 0 ? deps.liveMaxOwned : S.size,
    ...(activityIntents.length > 0 ? { activityIntents: new Set(activityIntents) } : {}),
    ...(groups ? { isGroupMember: (id) => groups.isMember(id) } : {}),
    ...(hullsOn ? { isLiveHull } : {}),
    ...(groupLive ? { membersOf: (id) => groups.membersOf(id),
      detachMember: (id, leaderId, now) => groups.detach(id, leaderId, now) } : {}) })
    : null;
  let corpsActive = false;
  let corpRows = null;
  const lifecycle = S.lifecycle && S.lifecycle.enabled === true ? createLifecycle({ S, worldSeed, pilots, bump,
    isLeader: (id) => groups !== null && groups.isLeader(id),
    removeFromCorp: (id) => {
      if (corpsActive) corps.removeMember(id);
    } }) : null;
  const careerOn = lifecycle !== null && lifecycle.careerOn === true;
  const corpsActivityOn = corpsOn && lifecycle !== null && S.lifecycle.corpsActivityEnabled === true;
  const activity = corpsActivityOn ? Object.freeze({
    isActive: (id) => pilots.stateOf(id) !== STATE.AWAY,
    isEligible: (id) => pilots.stateOf(id) !== STATE.AWAY && !(careerOn && pilots.careerOf(id) === CAREER.ROOKIE),
    compactAt: S.lifecycle.corpsRegionCompactAt }) : null;
  const corps = corpsOn ? createCorpsService({ S, worldSeed, pilots, getTable: () => table,
    standings: { profileOfPilot: (id) => (standings ? standings.profileOfPilot(id) : 0),
      distance: (a, b) => (standings ? standings.distance(a, b) : Infinity) },
    generateName: deps.generateName, bump, metric: (kind, name, value) => metric(kind, name, value), nowMs,
    ...(activity ? { activity } : {}) }) : null;

  function fail(reason, detail) {
    state = "failed";
    lastError = detail ? `${reason}: ${detail}` : reason;
    logger.log(`population: failed - ${lastError}`);
  }

  function stationCount(systemId) {
    const r = safeCall(() => deps.listStations(systemId));
    if (r && r.ok === true && Array.isArray(r.stations)) return r.stations.length;
    bump("stationsReadFailed");
    return 0;
  }

  function normalized(row) {
    const known = S_.nameOf(S_.ARCHETYPE_NAMES, row.archetype) !== null && S_.nameOf(S_.INTENT_NAMES, row.intent) !== null
      && S_.nameOf(S_.STATE_NAMES, row.state) !== null && (row.state !== STATE.TRAVEL || row.destId > 0)
      && (row.state !== STATE.AWAY || (lifecycle !== null && row.systemId === 0));
    if (known) return row;
    bump("loadNormalized");
    return { ...row, archetype: S_.nameOf(S_.ARCHETYPE_NAMES, row.archetype) !== null ? row.archetype : ARCHETYPE.TRADER,
      systemId: row.homeId, prevId: 0, destId: 0, intent: INTENT.DOCK, state: STATE.DOCKED };
  }

  function place(row) {
    if (!pilots.put(row)) return false;
    queue.schedule(keyOf(row.pilotId), row.dueAt, row.pilotId);
    return true;
  }

  function load(now) {
    const r = store.transaction("population.load", (tx) => ({ rows: repo.loadAll(tx), meta: repo.readMeta(tx),
      maxId: repo.maxPilotId(tx), ...(corps ? { corps: corpsRepo.loadAllCorps(tx) } : {}) }));
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "no result" };
    if (corps) corpRows = r.value.corps;
    for (const raw of r.value.rows) {
      if (raw.pilotId > S.size) {
        bump("retired");
        retirePending = true;
        continue;
      }
      const row = normalized(raw);
      if (row.flags & PREWARM_MASK) row.flags &= ~PREWARM_MASK;
      if (row.dueAt < now) {
        const u = deriveSeed(worldSeed, "pop-boot", row.pilotId, row.seq) / UINT32_RANGE;
        row.dueAt = now + Math.floor(u * S.bootSpreadMs);
      }
      if (place(row)) loaded += 1;
    }
    return { ok: true, meta: r.value.meta, maxId: r.value.maxId };
  }

  async function seed(meta, maxId) {
    let from = maxId + 1;
    const flushedAt = meta ? meta.flushedAt : clock.now();
    if (from > S.size) {
      const now = clock.now();
      const w = store.transaction("population.seed", (tx) => repo.writeMetaInTx(tx, { rulesVersion: S_.RULES_VERSION,
        size: S.size, seededAt: now, flushedAt }));
      if (!w || w.ok !== true) return { ok: false, reason: (w && w.reason) || "no result" };
      metaSeededAt = now;
      return { ok: true };
    }
    state = "seeding";
    while (from <= S.size) {
      if (stopped) return { ok: false, reason: "STOPPED" };
      const now = clock.now();
      const to = Math.min(S.size, from + seedCap - 1);
      const rows = [];
      for (let id = from; id <= to; id += 1) {
        const made = rules.seedPilot(id, worldSeed, table, S, now);
        if (!made.ok) return { ok: false, reason: made.reason };
        rows.push(made.row);
      }
      const last = to === S.size;
      const w = store.transaction("population.seed", (tx) => {
        store.labelTx("population_seed");
        const n = repo.insertSliceInTx(tx, rows);
        const meta = last
          ? repo.writeMetaInTx(tx, { rulesVersion: S_.RULES_VERSION, size: S.size, seededAt: now, flushedAt }) : 0;
        return { inserted: n, meta };
      });
      if (!w || w.ok !== true) return { ok: false, reason: (w && w.reason) || "no result" };
      for (const row of rows) place(row);
      bump("seeded", rows.length);
      if (last) metaSeededAt = now;
      from = to + 1;
      if (!last) await yieldTurn("seed");
    }
    return { ok: true };
  }

  function buildStandings() {
    try {
      const factions = Array.isArray(deps.standingFactions) ? deps.standingFactions : [];
      standingTables = buildStandingTables({ worldSeed, factions, table, S });
      standings = createStandings({ tables: standingTables, worldSeed, size: S.size, homeOf: (id) => pilots.homeOf(id),
        identityOf,
        indexOf: (systemId) => table.indexOf.get(systemId), has: (id) => pilots.has(id), nowMs,
        ...(corps ? { override: (id) => corps.profileOf(id) } : {}) });
      if (standingTables.F === 0) standingsReason = "NO_FACTIONS";
    } catch (err) {
      standingTables = null;
      standings = null;
      standingsReason = `BUILD_FAILED: ${messageOf(err)}`;
      logger.log(`population: standings not built - ${messageOf(err)}`);
    }
  }

  async function boot() {
    await bootSteps();
    return state;
  }

  async function bootSteps() {
    try {
      const facade = safeCall(deps.getGraph);
      const g = facade && typeof facade.whenReady === "function" ? await facade.whenReady() : null;
      if (stopped) return;
      if (!g || g.ok !== true || !g.graph || typeof g.graph.findRoute !== "function") {
        fail("GRAPH_UNAVAILABLE");
        return;
      }
      graph = g.graph;
      const ids = [];
      for (const band of BANDS) for (const id of graph.getSystemsBySecClass(band) || []) ids.push(id);
      const counts = new Map();
      for (let i = 0; i < ids.length; i += 1) {
        counts.set(ids[i], stationCount(ids[i]));
        if ((i + 1) % S.contextSystemsPerSlice === 0 && i + 1 < ids.length) {
          await yieldTurn("context");
          if (stopped) return;
        }
      }
      if (counters.stationsReadFailed > 0) {
        logger.log(`population: stations read failed in ${counters.stationsReadFailed} systems (counted as 0)`);
      }
      table = buildSystemTable({ graph, stationCountOf: (id) => counts.get(id) || 0,
        hubDistance: deps.buildHubDistance(graph, S.hubSystemIds, S.maxHubJumps), S });
      if (lifecycle) lifecycle.boot(table);
      if (standingsOn) buildStandings();
      const now = clock.now();
      lastFlushAt = now;
      const l = load(now);
      if (!l.ok) {
        fail("LOAD_FAILED", l.reason);
        return;
      }
      metaSeededAt = l.meta ? l.meta.seededAt : 0;
      if (!l.meta || l.meta.seededAt === 0 || l.meta.size < S.size || l.maxId < Math.min(S.size, l.meta.size)) {
        const s = await seed(l.meta, Math.min(l.maxId, S.size));
        if (stopped) return;
        if (!s.ok) {
          fail("SEED_FAILED", s.reason);
          return;
        }
      } else if (l.meta.size > S.size) retirePending = true;
      if (corps && standings) {
        corps.load(corpRows, clock.now());
        corpsActive = true;
      }
      corpRows = null;
      const restored = groups ? groups.restore(clock.now()) : null;
      if (hullCounts) recountHulls();
      if (careerOn) lifecycle.recountCareers(S.size);
      state = "running";
      runningAt = S.gateWarmupMs > 0 ? nowMs() : null;
      registerMemoryProbe();
      logger.log(`population: running size=${S.size} loaded=${loaded} seeded=${counters.seeded} systems=${table.size}`
        + ` retired=${counters.retired} normalized=${counters.loadNormalized}`
        + (restored ? ` groups=${restored.groups} orphaned=${restored.orphaned}` : ""));
    } catch (err) {
      fail("BOOT_THREW", messageOf(err));
    } finally {
      resolveReady(state);
    }
  }

  function recountHulls() {
    hullCounts.fill(0);
    for (let id = 1; id <= S.size; id += 1) {
      const p = pilots.get(id);
      if (p) hullCounts[hullClassOf(p.shipTypeId)] += 1;
    }
  }

  function hullsStatus() {
    const byClass = { UNKNOWN: hullCounts[0] };
    for (let i = 0; i < HULL_CLASS_NAMES.length; i += 1) byClass[HULL_CLASS_NAMES[i]] = hullCounts[i + 1];
    return Object.freeze({ enabled: true, byClass: Object.freeze(byClass),
      routeRestricted: ROUTE_RESTRICTED_CLASSES.reduce((sum, n) => sum + byClass[n], 0),
      avoidSecClasses: S.hulls.avoidSecClasses });
  }

  function inWarmup() {
    return S.gateWarmupMs > 0 && runningAt !== null && nowMs() - runningAt < S.gateWarmupMs;
  }

  function tableBytes() {
    if (!table) return 0;
    return table.systemIds.byteLength + table.band.byteLength + table.stations.byteLength + table.regionId.byteLength
      + table.hubJumps.byteLength + table.homeWeight.byteLength + table.indexOf.size * S_.MEMORY_ESTIMATE.MAP_ENTRY_BYTES;
  }

  function approxBytes() {
    const K = S_.MEMORY_ESTIMATE;
    return pilots.approxBytes() + queue.size * K.QUEUE_ENTRY_BYTES + tableBytes()
      + (near ? near.approxBytes() : 0) + (live ? live.size() * K.MAP_ENTRY_BYTES * 2 : 0)
      + (worldCtx ? worldCtx.approxBytes() : 0) + (standings ? standings.approxBytes() : 0)
      + (corps ? corps.approxBytes() : 0) + (groups ? groups.approxBytes() : 0);
  }

  function registerMemoryProbe() {
    if (!telemetry || typeof telemetry.registerMemoryProbe !== "function" || memoryProbe) return;
    try {
      const r = telemetry.registerMemoryProbe("population.memory", () => ({ entries: pilots.size() + queue.size
        + (corps ? corps.size() : 0), approxBytes: approxBytes() }));
      if (r && r.ok === true && typeof r.unregister === "function") memoryProbe = r;
      else logger.log(`population: memory probe not registered - ${(r && r.reason) || "no result"}`);
    } catch (err) {
      logger.log(`population: memory probe not registered - ${messageOf(err)}`);
    }
  }

  function findRouteBudgeted(from, to, restrictedHull) {
    if (routesLeft <= 0) return { ok: false, reason: "ROUTE_BUDGET" };
    routesLeft -= 1;
    const t = nowMs();
    const useRestricted = restrictedHull === true && ROUTE_OPTS_RESTRICTED !== null;
    if (useRestricted) bump("hulls.restrictedRoutes");
    const opts = useRestricted ? ROUTE_OPTS_RESTRICTED : ROUTE_OPTS;
    const r = safeCall(() => graph.findRoute(from, to, opts));
    metric("observe", "population.routeMs", Math.max(0, nowMs() - t));
    return r && r.ok === true && r.route ? { ok: true, route: r.route } : { ok: false, reason: "NO_ROUTE" };
  }

  function commit(p, next, now, jumped) {
    const dueAt = Math.floor(next.dueAt);
    if (hullCounts && next.shipTypeId !== undefined && next.shipTypeId !== p.shipTypeId) {
      hullCounts[hullClassOf(p.shipTypeId)] -= 1;
      hullCounts[hullClassOf(next.shipTypeId)] += 1;
    }
    const patch = careerOn ? lifecycle.patchOf(p, next, table, jumped === true) : null;
    const before = careerOn ? pilots.careerOf(p.pilotId) : 0;
    pilots.apply(p.pilotId, patch ? { ...next, ...patch, seq: p.seq + 1, sinceAt: now, dueAt }
      : { ...next, seq: p.seq + 1, sinceAt: now, dueAt });
    if (careerOn) lifecycle.countCareer(before, pilots.careerOf(p.pilotId));
    queue.schedule(keyOf(p.pilotId), dueAt, p.pilotId);
    if (near) near.afterCommit(p.pilotId, p.systemId, jumped === true, now, p.state, p.intent);
    if (groups && groups.isLeader(p.pilotId)) {
      if (next.state === STATE.POD) safeCall(() => groups.dissolve(p.pilotId, now, "POD"));
      else safeCall(() => groups.follow(p.pilotId, next, now, (m, memberNext) => applyMember(m, memberNext, now, jumped)));
    }
  }

  function applyMember(m, memberNext, now, jumped) {
    const dueAt = Math.floor(memberNext.dueAt);
    const patch = careerOn ? lifecycle.patchOf(m, memberNext, table, jumped === true) : null;
    const before = careerOn ? pilots.careerOf(m.pilotId) : 0;
    pilots.apply(m.pilotId, patch ? { ...memberNext, ...patch, seq: m.seq + 1, sinceAt: now, dueAt }
      : { ...memberNext, seq: m.seq + 1, sinceAt: now, dueAt });
    if (careerOn) lifecycle.countCareer(before, pilots.careerOf(m.pilotId));
    if (near) near.afterCommit(m.pilotId, m.systemId, jumped === true, now, m.state, m.intent);
  }

  function defer(id, now) {
    bump("deferred.ROUTE_BUDGET");
    const dueAt = now + S.passIntervalMs;
    pilots.setDue(id, dueAt);
    queue.schedule(keyOf(id), dueAt, id);
  }

  function noRoute(p, rng, now) {
    bump("noRoute");
    pilots.setRoute(p.pilotId, null);
    commit(p, rules.dwellInPlace(p, table, S, rng, now, rollOpts).next, now);
  }

  function step(id, now) {
    const p = pilots.get(id);
    if (!p) {
      queue.remove(keyOf(id));
      return;
    }
    let regrouped = false;
    if (groups) {
      if (groups.isMember(id)) {
        queue.remove(keyOf(id));
        return;
      }
      const g = safeCall(() => groups.checkLeaderEvent(p, now), "NONE");
      regrouped = g === "END" || g === "LIFETIME";
    }
    if (careerOn) lifecycle.ensureCareer(p, table);
    if (lifecycle && (p.state === STATE.AWAY || p.state === STATE.DOCKED)) {
      const l = safeCall(() => lifecycle.onDue(p, table, now));
      if (l) {
        pilots.setRoute(id, null);
        commit(p, l.next, now);
        if (l.kind === "REBORN" || l.moved === true) {
          if (standings) standings.forget(id);
          if (corpsActivityOn && corpsActive) safeCall(() => corps.noteHomeChange(id));
        }
        return;
      }
      if (p.state === STATE.AWAY) {
        bump("lifecycle.wakeFailed");
        pilots.setRoute(id, null);
        commit(p, lifeRules.forcedReturn(p, S, now), now);
        return;
      }
    }
    const stale = now - p.dueAt > S.staleMs;
    const rng = createRng(deriveSeed(worldSeed, "pop", id, p.seq));
    if (stale) bump("fastForward");
    if (p.state === STATE.POD) {
      commit(p, rules.podRespawn(p, S, rng, now, table).next, now);
      return;
    }
    const routeOf = ROUTE_OPTS_RESTRICTED && isRouteRestricted(p.shipTypeId)
      ? (f, t) => findRouteBudgeted(f, t, true) : findRouteBudgeted;
    if (p.state === STATE.TRAVEL) {
      if (!(p.destId > 0) || p.destId === p.systemId) {
        noRoute(p, rng, now);
        return;
      }
      let rs = pilots.route(id);
      if (stale) {
        const f = rules.fastForward(p, rs, now, S, table, rollOpts);
        if (f.arrived || !rs) pilots.setRoute(id, null);
        else rs.at = f.at;
        commit(p, f.next, now, true);
        return;
      }
      if (!rs || rs.route[rs.at] !== p.systemId) {
        if (standingOpts && standingOpts.weightForProfile(p.destId, standingOpts.profileOf(id), p.homeId, 0) === 0) {
          bump("standing.routeRefused");
          noRoute(p, rng, now);
          return;
        }
        const r = routeOf(p.systemId, p.destId);
        if (!r.ok && r.reason === "ROUTE_BUDGET") {
          defer(id, now);
          return;
        }
        if (!r.ok || r.route.length < 2) {
          noRoute(p, rng, now);
          return;
        }
        if (standingOpts && !rules.routeAllowed(standingOpts, r.route, standingOpts.profileOf(id), p.homeId, rollOpts)) {
          noRoute(p, rng, now);
          return;
        }
        rs = { route: Int32Array.from(r.route), at: 0 };
        pilots.setRoute(id, rs);
      }
      const h = rules.hop(p, rs, now, S, rng, table, rollOpts);
      if (h.arrived) pilots.setRoute(id, null);
      else rs.at = h.at;
      commit(p, h.next, now, true);
      return;
    }
    const r = rules.rollIntent(p, table, S, rng, routeOf, now, rollOpts);
    if (!r.ok) {
      if (r.reason === "ROUTE_BUDGET") defer(id, now);
      else noRoute(p, rng, now);
      return;
    }
    if (groups && !regrouped && (r.next.state === STATE.TRAVEL || r.next.state === STATE.ACTIVE)) {
      safeCall(() => groups.tryForm(p, table.sys(p.systemId), r.next, now));
    }
    pilots.setRoute(id, r.route ? { route: Int32Array.from(r.route), at: 0 } : null);
    commit(p, r.next, now);
  }

  function flushSlice(now) {
    const retire = retirePending;
    const corpsIn = corpsActive && !retire;
    const corpRowsOut = corpsIn ? corps.takeDirty(corpsCap) : EMPTY_LIST;
    const expired = corpsIn ? corps.expiredIds(now - S.corps.retentionMs, corpsCap) : EMPTY_LIST;
    const ids = retire ? [] : pilots.takeDirty(flushCap);
    const rows = ids.map((id) => pilots.get(id));
    const t = nowMs();
    const r = store.transaction("population.flush", (tx) => {
      store.labelTx("population_flush");
      if (corpRowsOut.length > 0) corpsRepo.upsertCorpsInTx(tx, corpRowsOut);
      if (expired.length > 0) corpsRepo.deleteDissolvedBeforeInTx(tx, now - S.corps.retentionMs, expired);
      const deleted = retire ? repo.deleteAboveInTx(tx, S.size, flushCap) : 0;
      const written = rows.length > 0 ? repo.upsertSliceInTx(tx, rows) : 0;
      const meta = repo.writeMetaInTx(tx, { rulesVersion: S_.RULES_VERSION, size: S.size, seededAt: metaSeededAt,
        flushedAt: now });
      return { deleted, written, meta };
    });
    const ms = Math.max(0, nowMs() - t);
    if (!r || r.ok !== true) {
      for (const id of ids) pilots.markDirty(id);
      for (const c of corpRowsOut) corps.markDirty(c.corpId);
      bump("flushFailed");
      if (now - failLogAt >= S.flushIntervalMs) {
        failLogAt = now;
        logger.log(`population: flush failed - ${(r && r.reason) || "no result"} (rows stay dirty)`);
      }
      return { ok: false, rows: 0 };
    }
    if (retire && r.value.deleted < flushCap) retirePending = false;
    if (expired.length > 0) corps.forget(expired);
    if (inWarmup()) metric("observe", "population.warmupFlushMs", ms);
    else metric("observe", "population.flushMs", ms);
    metric("count", "population.flushRows", r.value.written);
    lastFlush = Object.freeze({ rows: r.value.written, ms, at: now });
    return { ok: true, rows: r.value.written };
  }

  function corpsFlushPending(now) {
    return corpsActive && (corps.dirtyCount() > 0 || corps.expiredIds(now - S.corps.retentionMs, 1).length > 0);
  }

  function flushStep(now) {
    const dirty = pilots.dirtyCount();
    if (dirty === 0 && !retirePending && !corpsFlushPending(now)) {
      if (flushCycle) lastFlushAt = now;
      flushCycle = false;
      return;
    }
    if (!flushCycle && now - lastFlushAt < S.flushIntervalMs && dirty < flushCap && !retirePending) return;
    if (!admits("MAINTENANCE")) {
      if (now - lastFlushAt < S.flushMaxDeferMs) {
        bump("deferred.FLUSH_GOVERNOR");
        return;
      }
      bump("flushForced");
    }
    flushCycle = true;
    const r = flushSlice(now);
    if (r.ok && pilots.dirtyCount() === 0 && !retirePending && !corpsFlushPending(now)) {
      flushCycle = false;
      lastFlushAt = now;
    }
  }

  function dockedPermille() {
    return Math.floor((pilots.stateCount(STATE.DOCKED) * 1000) / Math.max(1, pilots.size()));
  }

  function runPass(now) {
    if (state !== "running" || stopped) return { ok: false, reason: stopped ? "stopped" : state };
    const t0 = nowMs();
    let events = 0;
    if (near) safeCall(() => near.refresh());
    if (groups) groups.beginPass();
    if (!admits("OPERATIONAL")) {
      bump("deferred.GOVERNOR");
    } else {
      routesLeft = S.maxRoutesPerPass;
      while (events < S.maxEventsPerPass && nowMs() - t0 < S.maxPassMs) {
        const head = queue.peek();
        if (!head || head.dueAtMs > now) break;
        step(head.payload, now);
        events += 1;
      }
    }
    eventsTotal += events;
    if (live) {
      safeCall(() => live.expire(now));
      metric("gauge", "population.liveOwned", live.size());
    }
    if (worldCtx && worldCtx.pending(now)) {
      if (admits("STRATEGIC")) safeCall(() => worldCtx.step(now));
      else bump("deferred.CONTEXT_GOVERNOR");
    }
    if (corpsActive && corps.pending(now)) {
      if (admits("STRATEGIC")) safeCall(() => corps.step(now));
      else bump("deferred.CORPS_GOVERNOR");
    }
    if (near && admits("LIVE")) safeCall(() => near.prewarmPass(now));
    if (near) {
      const c = near.counts();
      metric("gauge", "population.near", c.near);
      metric("gauge", "population.live", c.live);
    }
    const head = queue.peek();
    const lagMs = head && head.dueAtMs <= now ? now - head.dueAtMs : 0;
    const ms = Math.max(0, nowMs() - t0);
    if (inWarmup()) metric("observe", "population.warmupPassMs", ms);
    else metric("observe", "population.passMs", ms);
    if (events > 0) metric("count", "population.events", events);
    metric("gauge", "population.lagMs", lagMs);
    metric("gauge", "population.queue", queue.size);
    metric("gauge", "population.pilots", pilots.size());
    metric("gauge", "population.dockedPermille", dockedPermille());
    if (groups) {
      metric("gauge", "population.groups", groups.size());
      metric("gauge", "population.groupMembers", groups.members());
    }
    if (lifecycle) metric("gauge", "population.away", pilots.stateCount(STATE.AWAY));
    if (careerOn) {
      metric("gauge", "population.rookies", lifecycle.careerCount(1));
      metric("gauge", "population.veterans", lifecycle.careerCount(4));
    }
    if (slowLog.isSlow(ms)) slowLog.log(`population: slow pass ${Math.round(ms * 100) / 100}ms events=${events}`);
    flushStep(now);
    metric("gauge", "population.dirty", pilots.dirtyCount());
    lastPass = Object.freeze({ events, ms, lagMs });
    return { ok: true, events };
  }

  function stop() {
    if (stopped) return { ok: true, flushed: 0 };
    stopped = true;
    if (live) live.clear();
    if (memoryProbe) {
      const probe = memoryProbe;
      memoryProbe = null;
      safeCall(() => probe.unregister());
    }
    let flushed = 0;
    try {
      if (state === "running") {
        const now = clock.now();
        while (pilots.dirtyCount() > 0 || retirePending || corpsFlushPending(now)) {
          const r = flushSlice(now);
          if (!r.ok) break;
          flushed += r.rows;
        }
      }
    } catch (err) {
      logger.log(`population: final flush threw - ${messageOf(err)}`);
    }
    state = "stopped";
    return { ok: true, flushed };
  }

  function viewOf(p) {
    const warm = near ? near.viewOf(p.pilotId, p.flags) : null;
    return Object.freeze({ pilotId: p.pilotId, systemId: p.systemId, prevId: p.prevId, destId: p.destId,
      homeId: p.homeId, shipTypeId: p.shipTypeId, archetype: S_.nameOf(S_.ARCHETYPE_NAMES, p.archetype),
      intent: S_.nameOf(S_.INTENT_NAMES, p.intent), state: S_.nameOf(S_.STATE_NAMES, p.state), seq: p.seq,
      sinceAt: p.sinceAt, dueAt: p.dueAt, ...(warm ? { near: warm } : {}),
      ...(groups && p.groupId > 0 ? { groupId: p.groupId } : {}),
      ...(lifecycle ? { gen: p.gen, career: S_.nameOf(CAREER_NAMES, p.career) } : {}),
      ...(careerOn ? { xp: p.xp, wealth: p.wealth } : {}) });
  }

  function getStatus() {
    return Object.freeze({ state, ...(lastError ? { lastError } : {}), size: S.size, loaded, queue: queue.size,
      dirty: pilots.dirtyCount(),
      byState: Object.freeze(Object.fromEntries(S_.STATE_NAMES.map((n, i) => [n, pilots.stateCount(i + 1)])
        .filter(([n]) => lifecycle !== null || n !== "AWAY"))),
      lastPass, lastFlush, eventsTotal, counters: Object.freeze({ ...counters }),
      ...(near ? { near: near.status() } : {}), ...(live ? { liveOwned: live.size() } : {}),
      ...(worldCtx ? { context: worldCtx.status() } : {}), activeLife: activeLifeStatus(),
      standings: standingsStatus(), ...(corpsWanted ? { corps: corpsStatus() } : {}),
      ...(groups ? { groups: groups.getStatus() } : {}),
      ...(hullCounts ? { hulls: hullsStatus() } : {}),
      ...(lifecycle ? { lifecycle: lifecycle.status() } : {}) });
  }

  function corpsStatus() {
    if (corpsActive) return corps.getStatus();
    const reason = !corpsOn ? (S.standings && S.standings.enabled === true ? "NO_NAME_GENERATOR" : "NO_STANDINGS")
      : state === "running" ? "NO_STANDING_TABLES" : "NOT_LOADED";
    return Object.freeze({ enabled: false, reason });
  }

  function standingsStatus() {
    return Object.freeze({ enabled: standingsOn === true, active: standings !== null && worldCtx !== null,
      profiles: standingTables ? standingTables.P : 0, factions: standingTables ? standingTables.F : 0,
      ...(standingsOn && standingsReason ? { reason: standingsReason }
        : standingsOn && standings && !worldCtx ? { reason: "NO_CONTEXT" } : {}) });
  }

  function standingCensus() {
    if (!standingsOn || !standings || state !== "running") return null;
    if (!censusCache) {
      censusCache = standings.census(S.size, S.standings.panelTopProfiles);
      metric("observe", "population.standingCensusMs", censusCache.ms);
    }
    return censusCache;
  }

  function activeLifeStatus() {
    const enabled = activeLife === true;
    const target = Number.isSafeInteger(S.activeLife && S.activeLife.targetDockedPermille)
      ? S.activeLife.targetDockedPermille : null;
    const docked = dockedPermille();
    return Object.freeze({ enabled, dockedPermille: docked, targetDockedPermille: target,
      dockedOverTarget: target !== null && docked > target });
  }

  function topSystems(limit) {
    const all = [];
    pilots.forEachSystem((systemId, count) => {
      if (systemId !== 0) all.push([systemId, count]);
    });
    all.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    return all.slice(0, Math.max(0, limit)).map(([systemId, count]) => ({ systemId, count,
      archetypes: Array.from(pilots.archetypeCountsIn(systemId, new Int32Array(S_.ARCHETYPE_NAMES.length + 1))
        .subarray(1)),
      tier: near ? near.tierOf(systemId) : "FAR" }));
  }

  return Object.freeze({
    boot, runPass, stop, getStatus,
    whenReady: () => ready,
    isStopped: () => stopped,
    countIn: (systemId) => pilots.countIn(Number(systemId)),
    listIn(systemId, limit) {
      const n = Number.isSafeInteger(limit) && limit > 0 ? limit : LIST_DEFAULT_LIMIT;
      return Object.freeze(pilots.listIn(Number(systemId), n).map((id) => viewOf(pilots.get(id))));
    },
    localIdsIn(systemId, limit) {
      if (state !== "running" || stopped || !Number.isSafeInteger(limit) || limit <= 0) return EMPTY_LIST;
      return Object.freeze(pilots.localIdsIn(Number(systemId), limit));
    },
    pilot(pilotId) {
      const p = pilots.get(Number(pilotId));
      return p ? viewOf(p) : null;
    },
    tierOf: (systemId) => (near ? near.tierOf(systemId) : "FAR"),
    arrivalsInto: (systemId, sinceMs, limit) => (near ? near.arrivalsInto(systemId, sinceMs, limit) : EMPTY_LIST),
    onTierChange: (cb) => (near ? near.onTierChange(cb) : { ok: false, reason: "NEAR_DISABLED" }),
    topSystems,
    standingCensus,
    standings: () => standings,
    corps: () => (corpsActive ? corps : null),
    liveCandidatesIn(systemId, sinceMs, limit, acceptHull) {
      if (!live || state !== "running" || stopped) return EMPTY_LIST;
      return safeCall(() => live.candidatesIn(systemId, sinceMs, limit, acceptHull), EMPTY_LIST);
    },
    liveGroupOf(leaderId, systemId, now) {
      if (state !== "running" || stopped) return { ok: false, reason: "NOT_RUNNING" };
      if (!live) return { ok: false, reason: "LIVE_DISABLED" };
      if (!groupLive) return { ok: false, reason: "OFF" };
      return safeCall(() => live.groupOf(leaderId, systemId, now), { ok: false, reason: "NOT_RUNNING" });
    },
    releaseGroupMember(memberId, leaderId, token, now) {
      if (!live || !groupLive || state !== "running" || stopped) return { ok: true, applied: false };
      return safeCall(() => live.releaseMember(memberId, leaderId, token, now), { ok: true, applied: false });
    },
    claimLive(pilotId, systemId, now) {
      if (state !== "running" || stopped) return { ok: false, reason: "NOT_RUNNING" };
      if (!live) return { ok: false, reason: "LIVE_DISABLED" };
      return safeCall(() => live.claim(pilotId, systemId, now), { ok: false, reason: "NOT_RUNNING" });
    },
    releaseLive(pilotId, token, outcome, now) {
      if (!S_.LIVE_OUTCOMES.includes(outcome)) return { ok: false, reason: "BAD_OUTCOME" };
      if (!live || state !== "running" || stopped) return { ok: true, applied: false };
      return safeCall(() => live.release(pilotId, token, outcome, now), { ok: true, applied: false });
    },
  });
}

module.exports = { createPopulationService };
