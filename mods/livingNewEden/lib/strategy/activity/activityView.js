"use strict";

const { LIVE_FLEET_STATES } = require("../reviewService");
const { VERDICT_LABEL, judgeFaction, summarizeDecision, decisionText, groupNotes, fmtDuration } = require("./verdict");
const { TRIBUTE_PURPOSE } = require("../../economy/schema");

const VIEW_ID = "activity";
const VIEW_ORDER = 26;
const VIEW_TITLE = "Faction activity";
const WORK_CLASS = "MAINTENANCE";
const READY = "ready";
const PENDING = "pending";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const STATION_ONLINE = "ONLINE";
const MAX_REASON_LENGTH = 200;
const PERCENT = 100;
const MS_DECIMALS = 1000;
const OFFENSIVE_KINDS = Object.freeze(["empire", "pirate", "invader"]);
const NEUTRAL_KIND = "neutral";
const OFFENSIVE_OPERATION_TYPES = Object.freeze(["invasion", "recon", "raid"]);
const INVASION_ROLE = "invasion";
const INVASION_OPERATION = "invasion";
const IDLE_STATE = "IDLE";
const TRIBUTE_IN_TRANSIT_LABEL = "tribute in transit";
const TRIBUTE_RETURNED_LABEL = "tribute returned";
const TRIBUTE_ENDED_LABELS = Object.freeze({ DELIVERED: "tribute delivered", LOST: "tribute lost",
  ABORTED: "tribute cancelled" });

const DEPENDENCY_SERVICES = Object.freeze(["persistence", "scheduler", "graph", "world", "fleets", "stations",
  "occupation", "mining", "production", "logistics", "construction", "trade", "siege"]);

const ACTIVITY_SECTIONS = Object.freeze([
  ["operations", "operations"],
  ["mining", "mining trips"],
  ["production", "production jobs"],
  ["logistics", "convoys"],
  ["construction", "builds"],
  ["sieges", "sieges"],
]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_REASON_LENGTH);
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function capitalUsageOf(ai, f) {
  const u = ai && typeof ai.getCapitalUsage === "function" ? call(() => ai.getCapitalUsage(f), null) : null;
  if (!u || typeof u !== "object") return null;
  return { ...u, notes: { ...u.notes }, levels: Array.isArray(u.levels) ? [...u.levels] : [],
    ladder: u.ladder ? { ...u.ladder } : null, inventory: u.inventory ? { ...u.inventory } : null };
}

function refusalText(r, fallback) {
  if (!r) return fallback;
  return `${r.reason || fallback}${r.detail ? ` (${r.detail})` : ""}`;
}

function buildActivityView(deps) {
  const { store, repository, registry, clock, config } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const O = config.observer;
  const maxItems = O.factionActivityMaxItems;
  const readLimit = Math.max(1, maxItems);
  const intervalMs = config.strategy.reviewIntervalMs;
  const staleFactor = O.factionActivityStaleFactor;
  const refreshMs = Math.max(1, O.factionActivityRefreshMs);
  const stallMs = Number.isSafeInteger(O.factionActivityOffensiveStallMs) ? O.factionActivityOffensiveStallMs : 0;
  const maxCapturedRows = Number.isSafeInteger(O.factionActivityMaxCapturedRows) && O.factionActivityMaxCapturedRows > 0
    ? O.factionActivityMaxCapturedRows : 1;
  const maxOffensiveScanRows = Number.isSafeInteger(O.factionActivityMaxOffensiveScanRows)
    && O.factionActivityMaxOffensiveScanRows > 0 ? O.factionActivityMaxOffensiveScanRows : 1;
  const startedAt = clock.now();
  const truceOn = Boolean(deps.truce && typeof deps.truce.listTrucesInDb === "function");

  const lazy = (name) => (typeof deps[name] === "function" ? call(deps[name], null) : null);
  const aiService = () => lazy("getAiService");

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function storeOpen() {
    return call(() => store.isOpen() === true, false);
  }

  function strategyStatus() {
    return call(() => deps.getStatus(), null) || {};
  }

  function aiSeq() {
    const ai = aiService();
    return ai && typeof ai.getSeq === "function" ? call(() => ai.getSeq(), 0) : 0;
  }

  function systemRef(id) {
    if (id === null || id === undefined) return null;
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(() => deps.graph.getGraph(), null)
      : null;
    const vertex = res && res.ok === true && res.graph ? call(() => res.graph.getSystem(id), null) : null;
    return { systemId: id, name: vertex && vertex.name ? vertex.name : String(id) };
  }

  function eta(at, now) {
    return Number.isFinite(at) ? fmtDuration(at - now) : "-";
  }

  function modeOf(svc) {
    if (!svc || typeof svc.getMode !== "function") return "off";
    return call(() => svc.getMode(), "off");
  }

  function serviceStatuses() {
    const reg = lazy("getServices");
    const st = reg && typeof reg.getStatus === "function" ? call(() => reg.getStatus(), null) : null;
    const list = st && Array.isArray(st.services) ? st.services : [];
    return new Map(list.map((s) => [s.name, s]));
  }

  function gate(services, serviceName, mode) {
    const s = services.get(serviceName);
    if (s && s.state === "failed") {
      return { status: "error", reason: `service ${serviceName}: ${s.reason || "failed"}${s.detail ? ` (${s.detail})` : ""}` };
    }
    if (mode === PENDING || (s && s.state === "pending")) return { status: "pending", reason: "module starting" };
    if (mode !== READY) {
      const why = s && s.state === "disabled" && s.reason ? ` (${s.reason})` : "";
      return { status: "off", reason: `module disabled${why}` };
    }
    return null;
  }

  function section(fn) {
    try {
      return fn();
    } catch (err) {
      return { status: "error", reason: messageOf(err), count: 0 };
    }
  }

  function empty(g) {
    return { ...g, count: 0, truncated: false, items: [] };
  }

  function readOperations(db, f, services, now) {
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository) return empty(gate(services, "fleets", "off"));
    const g = gate(services, "fleets", READY);
    if (g) return empty(g);
    const ops = [];
    let truncated = false;
    for (const state of OPEN_OPERATION_STATES) {
      const r = fleets.repository.listOperations(db, { factionId: f, state, limit: readLimit + 1 });
      if (!r || !r.ok) return empty({ status: "error", reason: refusalText(r, "OPERATIONS_READ_FAILED") });
      if (r.operations.length > readLimit) truncated = true;
      ops.push(...r.operations.slice(0, readLimit));
    }
    ops.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0) || (a.operationId < b.operationId ? -1 : 1));
    return { status: "ok", reason: null, count: ops.length, truncated,
      items: ops.slice(0, maxItems).map((op) => ({ type: op.operationType, state: op.state,
        target: systemRef(op.targetSystemId), dueAt: Number.isFinite(op.dueAt) ? op.dueAt : null,
        eta: eta(op.dueAt, now) })),
      dues: ops.filter((op) => Number.isFinite(op.dueAt)).map((op) => ({ label: `operation ${op.operationType}`,
        dueAt: op.dueAt })) };
  }

  function readFleets(db, f, services) {
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository) return { ...gate(services, "fleets", "off"), count: 0, truncated: false, byState: {} };
    const g = gate(services, "fleets", READY);
    if (g) return { ...g, count: 0, truncated: false, byState: {} };
    const limit = config.strategy.maxFleetsReadPerReview;
    const r = fleets.repository.listFleetsByFaction(db, f, { limit: limit + 1, states: [...LIVE_FLEET_STATES] });
    if (!r || !r.ok) {
      return { status: "error", reason: refusalText(r, "FLEETS_READ_FAILED"), count: 0, truncated: false, byState: {} };
    }
    const list = r.fleets.slice(0, limit);
    const truncated = r.fleets.length > limit;
    const byState = {};
    const idleInvasion = { fleets: 0, ships: 0, oldestSince: null, truncated };
    for (const x of list) {
      byState[x.state] = (byState[x.state] || 0) + 1;
      if (x.fleetRole !== INVASION_ROLE || x.state !== IDLE_STATE) continue;
      idleInvasion.fleets += 1;
      idleInvasion.ships += Number.isFinite(x.shipCount) ? x.shipCount : 0;
      if (Number.isFinite(x.updatedAt) && (idleInvasion.oldestSince === null || x.updatedAt < idleInvasion.oldestSince)) {
        idleInvasion.oldestSince = x.updatedAt;
      }
    }
    return { status: "ok", reason: null, count: list.length, truncated, byState, idleInvasion };
  }

  function isOffensiveFaction(fx) {
    if (!fx) return false;
    if (OFFENSIVE_KINDS.includes(fx.kind)) return true;
    if (fx.kind !== NEUTRAL_KIND) return false;
    const doctrine = call(() => registry.getDoctrine(fx.doctrineId), null);
    return Boolean(doctrine && Array.isArray(doctrine.operationTypes) && doctrine.operationTypes.includes(INVASION_OPERATION));
  }

  function readLastCapture(db, f, repo) {
    let after = 0;
    let seen = 0;
    let last = null;
    for (;;) {
      const r = repo.listControlledByFaction(db, f, { capturedOnly: true, limit: maxCapturedRows + 1 - seen,
        afterSystemId: after });
      if (!r || !r.ok || !Array.isArray(r.systems)) return { ok: false };
      for (const s of r.systems) {
        seen += 1;
        if (Number.isFinite(s.capturedAt) && (last === null || s.capturedAt > last)) last = s.capturedAt;
      }
      if (seen > maxCapturedRows) return { ok: true, lastCaptureAt: null, truncated: true };
      if (r.systems.length === 0 || r.nextAfterSystemId === null || r.nextAfterSystemId === undefined) {
        return { ok: true, lastCaptureAt: last, truncated: false };
      }
      after = r.nextAfterSystemId;
    }
  }

  function scanOpenOffensive(db, f) {
    const repo = deps.fleets && deps.fleets.repository ? deps.fleets.repository : null;
    if (!repo) return { ok: false };
    let seen = 0;
    for (const state of OPEN_OPERATION_STATES) {
      let after;
      for (;;) {
        const r = repo.listOperations(db, { factionId: f, state, limit: maxOffensiveScanRows + 1 - seen,
          ...(after === undefined ? {} : { afterOperationId: after }) });
        if (!r || !r.ok || !Array.isArray(r.operations)) return { ok: false };
        for (const op of r.operations) {
          if (OFFENSIVE_OPERATION_TYPES.includes(op.operationType)) return { ok: true, open: true, truncated: false };
          seen += 1;
        }
        if (seen > maxOffensiveScanRows) return { ok: true, open: false, truncated: true };
        if (r.operations.length === 0 || r.nextAfterOperationId === null || r.nextAfterOperationId === undefined) break;
        after = r.nextAfterOperationId;
      }
    }
    return { ok: true, open: false, truncated: false };
  }

  function readOffensive(db, f, fx, services) {
    if (!(stallMs > 0) || !isOffensiveFaction(fx)) return null;
    try {
      const repo = deps.world && deps.world.repository ? deps.world.repository : null;
      if (!repo || gate(services, "fleets", READY)) return { ok: false };
      const ops = scanOpenOffensive(db, f);
      if (!ops.ok) return { ok: false };
      const claim = repo.listByOccupier(db, f, { limit: 1 });
      if (!claim || !claim.ok || !Array.isArray(claim.systems)) return { ok: false };
      const cap = readLastCapture(db, f, repo);
      if (!cap.ok) return { ok: false };
      return { ok: true, openOffensive: ops.open, opsTruncated: ops.truncated, ownClaim: claim.systems.length > 0,
        lastCaptureAt: cap.lastCaptureAt, captureTruncated: cap.truncated };
    } catch (_err) {
      return { ok: false };
    }
  }

  function offensiveOf(ev, sections, row, now) {
    const fl = sections.fleets;
    const idleInvasion = fl && fl.status === "ok" && fl.idleInvasion ? fl.idleInvasion : null;
    if (!ev) return { stalled: false, since: null, lastCaptureAt: null, idleInvasion };
    const lastCaptureAt = ev.ok === true ? ev.lastCaptureAt : null;
    const since = row && Number.isFinite(row.createdAt) ? Math.max(lastCaptureAt === null ? 0 : lastCaptureAt,
      row.createdAt) : null;
    const stalled = ev.ok === true && ev.openOffensive === false && ev.opsTruncated !== true
      && ev.captureTruncated !== true && ev.ownClaim !== true && since !== null && now - since >= stallMs;
    return { stalled, since, lastCaptureAt, idleInvasion };
  }

  function readTruces(db, f, now) {
    try {
      const r = deps.truce.listTrucesInDb(db, f, now);
      if (!r || r.ok !== true || !Array.isArray(r.truces)) {
        return { status: "error", reason: refusalText(r, "TRUCE_READ_FAILED") };
      }
      return { status: "ok", truncated: r.truces.length > maxItems,
        items: r.truces.slice(0, maxItems).map((t) => ({ partnerId: t.partner,
          partnerName: factionNames.get(t.partner) || String(t.partner), until: t.until, initiator: t.initiator,
          eta: eta(t.until, now) })) };
    } catch (err) {
      return { status: "error", reason: messageOf(err) };
    }
  }

  function readStationsOnline(db, f) {
    const st = lazy("getStations");
    const mode = modeOf(st);
    if (mode !== READY || !st.repository) return { mode, stations: [] };
    const r = st.repository.listStationsOfFaction(db, f, { states: [STATION_ONLINE] });
    if (!r || !r.ok) return { mode: "error", reason: refusalText(r, "STATIONS_READ_FAILED"), stations: [] };
    return { mode, stations: r.records.map((s) => ({ stationId: s.stationId, systemId: s.systemId, kind: s.kind })) };
  }

  function readMining(db, f, services) {
    const mn = lazy("getMining");
    const g = gate(services, "mining", modeOf(mn));
    if (g) return empty(g);
    const r = mn.readSiteState(db, f);
    if (!r || !r.ok) return empty({ status: "error", reason: refusalText(r, "MINING_READ_FAILED") });
    const belts = r.openByBelt || [];
    return { status: "ok", reason: null, count: belts.reduce((n, b) => n + b.n, 0), truncated: false,
      items: belts.slice(0, maxItems).map((b) => ({ system: systemRef(b.systemId), trips: b.n })) };
  }

  function readProduction(db, f, services, stations, now) {
    const pr = lazy("getProduction");
    const g = gate(services, "production", modeOf(pr));
    if (g) return empty(g);
    if (stations.mode === "error") return empty({ status: "error", reason: stations.reason });
    if (stations.mode !== READY) return empty(gate(services, "stations", stations.mode) || { status: "off",
      reason: "module disabled (stations)" });
    const r = pr.readStationState(db, f, stations.stations.map((s) => ({ stationId: s.stationId, kind: s.kind })));
    if (!r || !r.ok) return empty({ status: "error", reason: refusalText(r, "PRODUCTION_READ_FAILED") });
    const jobs = [];
    r.stations.forEach((s, i) => {
      for (const j of s.activeJobs || []) jobs.push({ ...j, systemId: stations.stations[i].systemId });
    });
    jobs.sort((a, b) => (a.dueAt || 0) - (b.dueAt || 0) || (a.jobId < b.jobId ? -1 : 1));
    const count = Number.isSafeInteger(r.activeJobsTotal) ? r.activeJobsTotal : jobs.length;
    return { status: "ok", reason: null, count, truncated: false,
      items: jobs.slice(0, maxItems).map((j) => ({ hullGroup: j.hullGroup, runs: j.runs, system: systemRef(j.systemId),
        dueAt: Number.isFinite(j.dueAt) ? j.dueAt : null, eta: eta(j.dueAt, now) })),
      dues: jobs.filter((j) => Number.isFinite(j.dueAt)).map((j) => ({ label: `production ${j.hullGroup}`,
        dueAt: j.dueAt })) };
  }

  function readLogistics(db, f, services, stations) {
    const lg = lazy("getLogistics");
    const g = gate(services, "logistics", modeOf(lg));
    if (g) return empty(g);
    const r = lg.readOpen(db, f, { limit: readLimit });
    if (!r || !r.ok) return empty({ status: "error", reason: refusalText(r, "LOGISTICS_READ_FAILED") });
    const where = (stationId) => {
      const s = stations.stations.find((x) => x.stationId === stationId);
      return s ? systemRef(s.systemId) : stationId;
    };
    const unitsOf = (items) => Object.values(items || {}).reduce((n, q) => n + (Number.isFinite(q) ? q : 0), 0);
    return { status: "ok", reason: null, count: r.convoys.length, truncated: r.truncated === true,
      items: r.convoys.slice(0, maxItems).map((c) => (c.purpose === TRIBUTE_PURPOSE
        ? { purpose: c.purpose, state: c.state, label: TRIBUTE_IN_TRANSIT_LABEL, from: where(c.sourceStationId),
          to: Number.isSafeInteger(c.destSystemId) ? systemRef(c.destSystemId) : where(c.destStationId),
          units: unitsOf(c.items) }
        : { purpose: c.purpose, state: c.state, from: where(c.sourceStationId), to: where(c.destStationId),
          units: unitsOf(c.items) })),
      lastTribute: lastTributeOf(db, f, lg, stations) };
  }

  function lastTributeOf(db, f, lg, stations) {
    if (typeof lg.findLastEndedOfFaction !== "function") return null;
    const r = lg.findLastEndedOfFaction(db, f, TRIBUTE_PURPOSE);
    if (!r || !r.ok || !r.convoy) return null;
    const c = r.convoy;
    const home = c.state === "DELIVERED" && stations.stations.some((x) => x.stationId === c.deliveredStationId);
    const units = c.state === "DELIVERED" ? c.delivered : c.cargo || c.plan;
    return { state: c.state, endedAt: Number.isFinite(c.endedAt) ? c.endedAt : null,
      units: Object.values(units || {}).reduce((n, q) => n + (Number.isFinite(q) ? q : 0), 0),
      label: home ? TRIBUTE_RETURNED_LABEL : TRIBUTE_ENDED_LABELS[c.state] || c.state };
  }

  function readConstruction(db, f, services) {
    const c = lazy("getConstruction");
    const g = gate(services, "construction", modeOf(c));
    if (g) return empty(g);
    const r = c.readOpen(db, f, { limit: readLimit });
    if (!r || !r.ok) return empty({ status: "error", reason: refusalText(r, "CONSTRUCTION_READ_FAILED") });
    const pct = (b) => {
      const req = Object.values(b.required || {}).reduce((n, q) => n + q, 0);
      const got = Object.keys(b.required || {}).reduce((n, k) => n + Math.min(b.required[k],
        (b.delivered && b.delivered[k]) || 0), 0);
      return req > 0 ? Math.floor((got * PERCENT) / req) : PERCENT;
    };
    const dues = [];
    for (const b of r.builds) {
      if (Number.isFinite(b.supplyDeadlineAt)) dues.push({ label: "build: supply deadline", dueAt: b.supplyDeadlineAt });
      if (Number.isFinite(b.anchorUntilAt)) dues.push({ label: "build: anchoring", dueAt: b.anchorUntilAt });
    }
    return { status: "ok", reason: null, count: r.builds.length, truncated: r.truncated === true,
      items: r.builds.slice(0, maxItems).map((b) => ({ system: systemRef(b.systemId), state: b.state,
        deliveredPct: pct(b) })), dues };
  }

  function readSieges(db, f, services) {
    const sg = lazy("getSiege");
    const g = gate(services, "siege", modeOf(sg));
    if (g) return empty(g);
    const r = sg.readForFaction(db, f, { limit: config.siege.maxOpenSieges });
    if (!r || !r.ok) return empty({ status: "error", reason: refusalText(r, "SIEGE_READ_FAILED") });
    const all = [...r.attacking.map((s) => ({ side: "attack", ...s })),
      ...r.defending.map((s) => ({ side: "defense", ...s }))];
    return { status: "ok", reason: null, count: all.length, truncated: r.truncated === true,
      items: all.slice(0, maxItems).map((s) => ({ side: s.side, system: systemRef(s.systemId), state: s.state,
        phaseEndsAt: Number.isFinite(s.phaseEndsAt) ? s.phaseEndsAt : null })),
      dues: all.filter((s) => Number.isFinite(s.phaseEndsAt)).map((s) => ({ label: `siege (${s.side})`,
        dueAt: s.phaseEndsAt })) };
  }

  function readCampaigns(f, st) {
    const states = new Map((st.campaigns || []).map((c) => [c.campaignId, c.state]));
    const list = call(() => registry.getCampaignsForFaction(f), []) || [];
    const active = list.filter((c) => states.has(c.campaignId));
    return { status: "ok", count: active.length,
      items: active.slice(0, maxItems).map((c) => ({ campaignId: c.campaignId, state: states.get(c.campaignId) })) };
  }

  function readFaction(db, f, services, now, st) {
    const sections = {};
    sections.operations = section(() => readOperations(db, f, services, now));
    sections.fleets = section(() => readFleets(db, f, services));
    const stations = (() => {
      try {
        return readStationsOnline(db, f);
      } catch (err) {
        return { mode: "error", reason: messageOf(err), stations: [] };
      }
    })();
    sections.mining = section(() => readMining(db, f, services));
    sections.production = section(() => readProduction(db, f, services, stations, now));
    sections.logistics = section(() => readLogistics(db, f, services, stations));
    sections.construction = section(() => readConstruction(db, f, services));
    sections.sieges = section(() => readSieges(db, f, services));
    sections.campaigns = section(() => readCampaigns(f, st));
    return sections;
  }

  function reviewEventOf(f, row, now, ai, schedulerReady) {
    if (!ai || !schedulerReady || !ai.schedule || typeof deps.scheduler.findByKey !== "function") return null;
    const { bucketOf, reviewKey, dueOf } = ai.schedule;
    const buckets = row && Number.isFinite(row.lastReviewAt) ? [bucketOf(f, row.lastReviewAt) + 1]
      : [bucketOf(f, now) + 1, bucketOf(f, now)];
    for (const b of buckets) {
      const r = call(() => deps.scheduler.findByKey(reviewKey(f, b)), null);
      if (!r || !r.ok) return null;
      if (r.found) {
        const e = r.event;
        return { found: true, state: e.state, attempts: e.attempts, lastError: e.lastError || null, dueAt: e.dueAt,
          expectedDueAt: dueOf(f, b) };
      }
    }
    return { found: false };
  }

  function nowText(sections) {
    const parts = ACTIVITY_SECTIONS.filter(([k]) => sections[k] && sections[k].count > 0)
      .map(([k, label]) => `${label}: ${sections[k].count}${sections[k].truncated ? "+" : ""}`);
    return parts.length > 0 ? parts.join(", ") : "none";
  }

  function plansText(plans) {
    const parts = [];
    if (plans.target) parts.push(`target: ${plans.target.name}`);
    if (plans.decision.length > 0) parts.push(`decision: ${decisionText(plans.decision)}`);
    if (Number.isSafeInteger(plans.hiveNodesActive)) {
      parts.push(`hive: nodes ${plans.hiveNodesActive}, brood ${plans.hiveBroodMobilized}`);
    }
    if (plans.nextReviewAt !== null) parts.push(`next review in ~${plans.untilNextReview}`);
    return parts.length > 0 ? parts.join(" · ") : "none";
  }

  function getData() {
    if (!storeOpen()) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const t0 = nowMs();
    const now = clock.now();
    const st = strategyStatus();
    const services = serviceStatuses();
    const ai = aiService();
    const activeList = call(() => registry.listActiveFactions(), []) || [];
    const active = activeList.map((x) => x.factionId);
    const tx = store.transaction("observer.activity", (db) => {
      const listed = repository.listFactions(db);
      if (!listed || !listed.ok) return listed || { ok: false, reason: "TX_FAILED" };
      const perFaction = new Map();
      const offensive = new Map();
      const truces = new Map();
      for (const fx of activeList) {
        perFaction.set(fx.factionId, readFaction(db, fx.factionId, services, now, st));
        offensive.set(fx.factionId, readOffensive(db, fx.factionId, fx, services));
        if (truceOn) truces.set(fx.factionId, readTruces(db, fx.factionId, now));
      }
      return { ok: true, records: listed.records, perFaction, offensive, truces };
    });
    const read = tx && tx.ok ? tx.value : tx;
    if (!tx || !tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const rows = new Map(read.records.map((r) => [r.factionId, r]));
    const aiState = st.ai && st.ai.state ? st.ai.state : "off";
    const strategy = { state: st.state || null, reason: st.reason || null, aiState,
      aiReason: st.ai ? st.ai.reason || null : null, seedState: st.seed ? st.seed.state : null };
    const failedServices = DEPENDENCY_SERVICES.map((n) => services.get(n)).filter((s) => s && s.state === "failed")
      .map((s) => ({ name: s.name, reason: s.reason || null }));
    const schedulerReady = Boolean(deps.scheduler) && call(() => deps.scheduler.getStatus().state === READY, false);
    const reviewStatus = ai && typeof ai.getStatus === "function" ? call(() => ai.getStatus(), null) : null;
    const lastRefusal = reviewStatus ? reviewStatus.lastRefusal || null : null;

    const factions = active.map((f) => {
      const row = rows.get(f) || null;
      const sections = read.perFaction.get(f);
      const memory = ai && typeof ai.getMemory === "function" ? call(() => ai.getMemory(f), null) : null;
      const reviewEvent = aiState === "on" ? reviewEventOf(f, row, now, ai, schedulerReady) : null;
      const activityCount = ACTIVITY_SECTIONS.reduce((n, [k]) => n + (sections[k] && sections[k].count > 0
        ? sections[k].count : 0), 0);
      const lastReviewAt = row && Number.isFinite(row.lastReviewAt) ? row.lastReviewAt : null;
      let nextReviewAt = reviewEvent && reviewEvent.found && Number.isFinite(reviewEvent.dueAt) ? reviewEvent.dueAt
        : null;
      if (nextReviewAt === null && ai && ai.schedule && aiState === "on") {
        nextReviewAt = call(() => ai.schedule.nextOf(f, lastReviewAt === null ? now : lastReviewAt).dueAt, null);
      }
      const teraz = nowText(sections);
      const offensive = offensiveOf(read.offensive.get(f) || null, sections, row, now);
      const verdict = judgeFaction({ now, intervalMs, staleFactor, startedAt, strategy, failedServices,
        row: row ? { status: row.status, lastReviewAt } : null, memory, reviewEvent, activityCount, lastRefusal,
        nowText: teraz, nextReviewAt, offensive });
      const dues = [];
      if (reviewEvent && reviewEvent.found && Number.isFinite(reviewEvent.dueAt)) {
        dues.push({ label: "strategy review", dueAt: reviewEvent.dueAt });
      }
      for (const k of Object.keys(sections)) if (Array.isArray(sections[k].dues)) dues.push(...sections[k].dues);
      dues.sort((a, b) => a.dueAt - b.dueAt);
      const decision = summarizeDecision(memory ? memory.applied : null);
      const plans = {
        target: memory && memory.target ? systemRef(memory.target.systemId) : null,
        outcome: memory ? memory.outcome : null,
        round: memory ? memory.round : null,
        decision,
        refused: memory ? memory.refused : 0,
        lastReviewAt,
        sinceLastReview: lastReviewAt === null ? "-" : fmtDuration(now - lastReviewAt),
        nextReviewAt,
        untilNextReview: nextReviewAt === null ? "-" : fmtDuration(Math.max(0, nextReviewAt - now)),
        reviewEvent: reviewEvent && reviewEvent.found ? { state: reviewEvent.state, attempts: reviewEvent.attempts,
          lastError: reviewEvent.lastError } : null,
        scheduled: { count: dues.length, next: dues.slice(0, maxItems).map((d) => ({ label: d.label, dueAt: d.dueAt,
          eta: eta(d.dueAt, now) })) },
        ...(memory && Number.isSafeInteger(memory.hiveNodesActive) ? { hiveNodesActive: memory.hiveNodesActive,
          hiveBroodMobilized: Number.isSafeInteger(memory.hiveBroodMobilized) ? memory.hiveBroodMobilized : 0 } : {}),
      };
      const publicSections = {};
      for (const k of Object.keys(sections)) {
        const { dues: _dues, ...rest } = sections[k];
        publicSections[k] = rest;
      }
      return {
        factionId: f,
        name: factionNames.get(f) || String(f),
        verdict: { code: verdict.code, label: verdict.label, sentence: verdict.sentence },
        notes: groupNotes(memory ? memory.notes : []),
        now: { total: activityCount, sections: publicSections },
        plans,
        offensive,
        capitalUsage: capitalUsageOf(ai, f),
        ...(truceOn ? { truces: read.truces.get(f) || { status: "error", reason: "TRUCE_READ_FAILED" } } : {}),
      };
    });

    const ms = nowMs() - t0;
    if (deps.telemetry && typeof deps.telemetry.observe === "function") {
      try {
        deps.telemetry.observe("strategy.activityViewMs", Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
      } catch (_err) {
      }
    }
    return {
      available: true,
      generatedAt: now,
      intervalMs,
      staleAfterMs: intervalMs * staleFactor,
      summary: factions.map((x) => ({ frakcja: x.name, werdykt: VERDICT_LABEL[x.verdict.code], kod: x.verdict.code,
        uzasadnienie: x.verdict.sentence, teraz: nowText(x.now.sections), plany: plansText(x.plans) })),
      factions,
    };
  }

  function cacheKey() {
    if (!storeOpen() || !admitted()) return null;
    const st = strategyStatus();
    const changes = call(() => repository.getChangeCount(), 0);
    return `s${changes}|${st.seq === undefined ? 0 : st.seq}|a${aiSeq()}|t${Math.floor(clock.now() / refreshMs)}`;
  }

  return { title: VIEW_TITLE, order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, DEPENDENCY_SERVICES, buildActivityView };
