"use strict";

const { decideEventStep, causeHolds } = require("./eventMachine");
const { campaignsBySystem, causesOfSystem } = require("./candidates");
const { getEventType } = require("./catalog");
const { CAUSE } = require("./data/eventCatalog");
const { chooseEvents } = require("./director");
const { STATE, RESULT } = require("./eventMachine");
const { MODES: DEV_MODES } = require("../world/devIndices/schema");

const PROGRAMMER_REASONS = Object.freeze(["TX_ACTIVE", "TX_NESTED", "TX_REQUIRED", "SITE_REQUEST_INVALID"]);
const CAMPAIGN_UNKNOWN_REASONS = Object.freeze(["CAMPAIGN_PENDING", "GRAPH_UNAVAILABLE"]);
const FRONT_INPUT = Object.freeze({});

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function readCampaigns(strategy) {
  const out = { known: false, byId: new Map(), active: [] };
  if (!strategy || typeof strategy.listActiveCampaigns !== "function") return out;
  const listed = call(() => strategy.listActiveCampaigns(), null);
  if (!listed || listed.ok !== true || !Array.isArray(listed.campaigns)) return out;
  out.known = true;
  for (const entry of listed.campaigns) {
    if (!entry || typeof entry.campaignId !== "string") continue;
    out.byId.set(entry.campaignId, { ok: entry.ok === true, reason: entry.reason || null });
    if (entry.ok !== true || typeof strategy.getCampaign !== "function") continue;
    const r = call(() => strategy.getCampaign(entry.campaignId), null);
    const c = r && r.ok === true ? r.campaign : null;
    if (!c || !Array.isArray(c.systemIds) || !Number.isSafeInteger(c.ownerFactionId)) continue;
    out.active.push({ campaignId: entry.campaignId, ownerFactionId: c.ownerFactionId,
      systemIds: c.systemIds.filter((id) => Number.isSafeInteger(id) && id > 0) });
  }
  return out;
}

function gatherPulseContext(tx, deps, opts) {
  const { repo, worldRepository: wr, sites, P } = deps;
  const stats = { readRefused: 0, siteReadRefused: 0 };
  const refused = (r, site) => {
    if (r && PROGRAMMER_REASONS.includes(r.reason)) stats.readRefused += 1;
    else if (site) stats.siteReadRefused += 1;
  };
  const open = repo.listOpen(tx, { limit: P.maxOpenEvents });
  if (!open.ok) return { ok: false, reason: open.reason };
  const pending = repo.listPendingCleanup(tx, { limit: P.maxCleanupRetriesPerPass });
  if (!pending.ok) return { ok: false, reason: pending.reason };

  let openSystems = null;
  const openIds = [...new Set(open.events.map((e) => e.systemId))];
  const sys = call(() => wr.getSystems(tx, openIds, { includeInfluence: false }), null);
  if (sys && sys.ok === true) openSystems = new Map(sys.systems.map((s) => [s.systemId, s]));
  else refused(sys, false);

  const siteStates = new Map();
  for (const ev of open.events) {
    if (ev.state !== STATE.ACTIVE || !(ev.sitesCreated > 0)) continue;
    const r = sites && typeof sites.listSitesByEvent === "function"
      ? call(() => sites.listSitesByEvent(ev.eventId, tx), { ok: false, reason: "SITES_ERROR" })
      : { ok: false, reason: "SITES_UNAVAILABLE" };
    if (r && r.ok === true && Array.isArray(r.sites)) siteStates.set(ev.eventId, r.sites.map((s) => s.state));
    else {
      siteStates.set(ev.eventId, null);
      refused(r, true);
    }
  }

  const campaigns = readCampaigns(deps.strategy);
  const out = { ok: true, open, pending, openSystems, siteStates, campaigns, occ: null, theatre: null, recent: null,
    stats };
  if (opts.boot) return out;

  const occ = call(() => wr.listActiveOccupations(tx, { limit: P.maxCandidatesPerPass, afterSystemId: deps.cursor }),
    null);
  if (occ && occ.ok === true) out.occ = occ;
  else refused(occ, false);
  const theatreIds = [...new Set(campaigns.active.flatMap((c) => c.systemIds))].sort((a, b) => a - b)
    .slice(0, deps.maxBatchReadIds);
  if (theatreIds.length > 0) {
    const th = call(() => wr.getSystems(tx, theatreIds, { includeInfluence: false }), null);
    if (th && th.ok === true) out.theatre = th.systems;
    else refused(th, false);
  } else out.theatre = [];
  const recent = repo.listRecent(tx, { sinceAt: opts.at - deps.lookbackMs, limit: P.maxRecentRows });
  if (!recent.ok) return { ok: false, reason: recent.reason };
  out.recent = recent;
  if (deps.aftermath) {
    const a = readAftermath(tx, deps, opts.at, out);
    out.aftermath = a.aftermath;
    out.aftermathStats = a.stats;
  }
  if (deps.liberated) {
    const l = readLiberated(tx, deps, opts.at);
    out.liberated = l.liberated;
    out.liberatedStats = l.stats;
  }
  if (deps.developed) {
    const d = readDeveloped(tx, deps, out);
    out.developed = d.developed;
    out.developedStats = d.stats;
  }
  return out;
}

function readDeveloped(tx, deps, out) {
  const D = deps.developed;
  const stats = { read: 0, refused: 0, truncated: 0, cold: 0, ratRefused: 0, noRatFaction: 0 };
  const dev = call(() => D.getDevIndices(), null);
  const mode = dev && typeof dev.getMode === "function" ? call(() => dev.getMode(), null) : null;
  if (!dev || typeof dev.listTop !== "function" || mode === DEV_MODES.STOPPED) {
    stats.cold = 1;
    return { developed: null, stats };
  }
  const top = (kind, secClasses) => {
    const r = call(() => dev.listTop(kind, { minLevel: D.minLevel, limit: D.candidateRows, secClasses }), null);
    return Array.isArray(r) ? r.filter((e) => e && Number.isSafeInteger(e.systemId) && e.systemId > 0) : [];
  };
  const ind = top("ind", D.oreClasses);
  const mil = top("mil", D.ratClasses);
  const levels = new Map();
  const rank = new Map();
  const note = (e, kind) => {
    const lv = levels.get(e.systemId) || { ind: 0, mil: 0 };
    levels.set(e.systemId, { ...lv, [kind]: e.level });
    const r = rank.get(e.systemId) || [0, 0];
    rank.set(e.systemId, [Math.max(r[0], e.level), Math.max(r[1], e.points)]);
  };
  for (const e of ind) note(e, "ind");
  for (const e of mil) note(e, "mil");
  const ratFactions = new Map();
  const milIds = mil.map((e) => e.systemId);
  if (milIds.length > 0) {
    const r = typeof D.ratFactionsOf === "function" ? call(() => D.ratFactionsOf(milIds), null) : null;
    if (!r || r.ok !== true || !Array.isArray(r.entries)) stats.ratRefused = 1;
    else {
      for (const e of r.entries) {
        if (!e || !Number.isSafeInteger(e.systemId)) continue;
        const f = Number.isSafeInteger(e.factionId) && e.factionId > 0 ? e.factionId : null;
        if (f === null) stats.noRatFaction += 1;
        ratFactions.set(e.systemId, f);
      }
    }
  }
  const known = new Set();
  for (const s of (out.occ ? out.occ.systems : [])) known.add(s.systemId);
  for (const s of (out.theatre || [])) known.add(s.systemId);
  for (const s of (out.aftermath ? out.aftermath.systems : [])) known.add(s.systemId);
  for (const s of (out.liberated ? out.liberated.systems : [])) known.add(s.systemId);
  let ids = [...levels.keys()].filter((id) => !known.has(id)).sort((a, b) => {
    const ra = rank.get(a);
    const rb = rank.get(b);
    return (rb[0] - ra[0]) || (rb[1] - ra[1]) || (a - b);
  });
  const cap = Math.min(2 * D.candidateRows, deps.maxBatchReadIds);
  if (ids.length > cap) {
    stats.truncated = 1;
    ids = ids.slice(0, cap);
  }
  let systems = [];
  if (ids.length > 0) {
    const sys = call(() => deps.worldRepository.getSystems(tx, ids, { includeInfluence: false }), null);
    if (!sys || sys.ok !== true || !Array.isArray(sys.systems)) {
      stats.refused = 1;
      return { developed: null, stats };
    }
    systems = sys.systems;
  }
  stats.read = 1;
  return { developed: { levels, ratFactions, rank, systems }, stats };
}

function readLiberated(tx, deps, at) {
  const L = deps.liberated;
  const stats = { read: 0, refused: 0, truncated: 0 };
  const wr = deps.worldRepository;
  const r = wr && typeof wr.listLiberatedSince === "function"
    ? call(() => wr.listLiberatedSince(tx, { sinceMs: Math.max(0, at - L.windowMs),
      limit: Math.min(L.maxRows, deps.maxBatchReadIds) }), null)
    : null;
  if (!r || r.ok !== true || !Array.isArray(r.systems)) {
    stats.refused = 1;
    return { liberated: null, stats };
  }
  stats.read = 1;
  if (r.truncated === true) stats.truncated = 1;
  const systems = r.systems.filter((s) => s && Number.isSafeInteger(s.systemId) && s.systemId > 0);
  return { liberated: { systems, truncated: r.truncated === true }, stats };
}

function readAftermath(tx, deps, at, out) {
  const A = deps.aftermath;
  const stats = { read: 0, refused: 0, truncated: 0, systemsTruncated: 0 };
  const refusedResult = () => {
    stats.refused = 1;
    return { aftermath: null, stats };
  };
  const battleRepo = call(() => A.getBattleRepository(), null);
  if (!battleRepo || typeof battleRepo.listVirtualLossesSince !== "function") return refusedResult();
  const r = call(() => battleRepo.listVirtualLossesSince(tx, { sinceMs: Math.max(0, at - A.windowMs),
    limit: A.maxLossRows }), null);
  if (!r || r.ok !== true || !Array.isArray(r.losses)) return refusedResult();
  stats.read = 1;
  if (r.truncated === true) stats.truncated = 1;
  const losses = [];
  for (const l of r.losses) {
    if (!l || !Number.isSafeInteger(l.systemId) || l.systemId <= 0 || !Number.isSafeInteger(l.factionId)
      || !Number.isSafeInteger(l.count) || !Number.isSafeInteger(l.settledAt) || !A.factions.has(l.factionId)) continue;
    losses.push({ systemId: l.systemId, factionId: l.factionId, count: l.count, settledAt: l.settledAt });
  }
  const known = new Set();
  for (const s of (out.occ ? out.occ.systems : [])) known.add(s.systemId);
  for (const s of (out.theatre || [])) known.add(s.systemId);
  const newest = aftermathNewestBySystem(losses, A, deps.catalog || null, deps.graph || null, out.recent);
  let ids = [...newest.keys()].filter((id) => !known.has(id))
    .sort((a, b) => (newest.get(b) - newest.get(a)) || (a - b));
  const cap = Math.min(A.maxSystems, deps.maxBatchReadIds);
  const systemsTruncated = ids.length > cap;
  if (systemsTruncated) {
    stats.systemsTruncated = 1;
    ids = ids.slice(0, cap);
  }
  let systems = [];
  if (ids.length > 0) {
    const sys = call(() => deps.worldRepository.getSystems(tx, ids, { includeInfluence: false }), null);
    if (!sys || sys.ok !== true || !Array.isArray(sys.systems)) return refusedResult();
    systems = sys.systems;
  }
  return { aftermath: { losses, systems, truncated: r.truncated === true, systemsTruncated }, stats };
}

function lastAftermathBySystem(rows, catalog) {
  const last = new Map();
  if (!catalog) return last;
  for (const r of rows) {
    if (!r || r.resultReference === RESULT.UNOBSERVED) continue;
    const t = getEventType(catalog, r.eventType);
    if (!t || t.cause !== CAUSE.BATTLE_AFTERMATH) continue;
    if (r.createdAt > (last.get(r.systemId) || 0)) last.set(r.systemId, r.createdAt);
  }
  return last;
}

function aftermathNewestBySystem(losses, A, catalog, graph, recent) {
  const last = lastAftermathBySystem(recent && Array.isArray(recent.rows) ? recent.rows : [], catalog);
  let classes = null;
  if (catalog && Array.isArray(catalog.types)) {
    classes = new Set();
    for (const t of catalog.types) {
      if (t.cause === CAUSE.BATTLE_AFTERMATH) for (const c of t.securityClasses || []) classes.add(c);
    }
  }
  const sums = new Map();
  for (const l of losses) {
    if (!(l.count > 0) || !(l.settledAt > (last.get(l.systemId) || 0))) continue;
    const key = `${l.systemId}:${l.factionId}`;
    const s = sums.get(key) || { systemId: l.systemId, count: 0, newest: 0 };
    s.count += l.count;
    if (l.settledAt > s.newest) s.newest = l.settledAt;
    sums.set(key, s);
  }
  const newest = new Map();
  for (const s of sums.values()) {
    if (s.count < A.minLosses) continue;
    if (s.newest > (newest.get(s.systemId) || 0)) newest.set(s.systemId, s.newest);
  }
  if (classes && graph && typeof graph.getSystem === "function") {
    for (const id of [...newest.keys()]) {
      const v = call(() => graph.getSystem(id), null);
      if (v && typeof v.secClass === "string" && !classes.has(v.secClass)) newest.delete(id);
    }
  }
  return newest;
}

function causeOf(row, read) {
  const system = read.openSystems ? read.openSystems.get(row.systemId) || null : null;
  if (!system) return null;
  if (row.cause !== CAUSE.CAMPAIGN_THEATRE) return causeHolds(row, system, []);
  const c = read.campaigns;
  if (!c.known) return null;
  const entry = c.byId.get(row.campaignId);
  if (!entry) return false;
  if (entry.ok) return causeHolds(row, system, [row.campaignId]);
  return CAMPAIGN_UNKNOWN_REASONS.includes(entry.reason) ? null : false;
}

function activationOf(row, P, presence, presenceOn) {
  const R = Math.min(P.activationRadius, P.presenceRadius);
  let distance;
  if (presenceOn) {
    const d = call(() => presence.distanceToObserved(row.systemId, P.presenceRadius), null);
    if (d && d.ok === true) distance = Number.isSafeInteger(d.distance) ? d.distance : null;
  }
  const observed = !presenceOn || distance === undefined ? null : (distance !== null && distance <= R);
  return { observed, waitUntil: row.createdAt + P.plannedWaitMs, distance: observed ? distance : null };
}

function buildDirectorInput(read, deps, opts) {
  const { catalog, P, graph, presence } = deps;
  const status = presence && typeof presence.getStatus === "function" ? call(() => presence.getStatus(), null) : null;
  const presenceOn = Boolean(status && status.available && !status.stale
    && typeof presence.distanceToObserved === "function");
  const presenceMode = P.presenceActivation === true;
  let corrupt = 0;
  let presenceUnknown = false;
  const waiting = [];
  const facts = read.open.events.map((row) => {
    if (row.corrupt) corrupt += 1;
    const type = row.corrupt ? null : getEventType(catalog, row.eventType);
    const siteStates = read.siteStates.has(row.eventId) ? read.siteStates.get(row.eventId) : [];
    const activation = presenceMode && row.state === STATE.PLANNED ? activationOf(row, P, presence, presenceOn) : null;
    const f = { now: opts.at, type, causeHolds: causeOf(row, read), siteStates,
      ...(P.activeCauseStickyEnabled === true ? { causeSticky: true } : {}) };
    if (activation) f.activation = { observed: activation.observed, waitUntil: activation.waitUntil };
    const decision = decideEventStep(row, f);
    if (activation) {
      if (activation.observed === null) presenceUnknown = true;
      if (decision.action === "NONE" && activation.observed !== true) {
        waiting.push({ eventId: row.eventId, systemId: row.systemId,
          reason: activation.observed === false ? "NOT_OBSERVED" : "PRESENCE_UNKNOWN" });
      }
    }
    return { row, decision, activation };
  });
  if (opts.boot) {
    return { facts, context: null, candidatesTruncated: false, corrupt, presenceUnknown, waiting };
  }

  const merged = new Map();
  for (const s of (read.occ ? read.occ.systems : [])) merged.set(s.systemId, s);
  for (const s of (read.theatre || [])) if (!merged.has(s.systemId)) merged.set(s.systemId, s);
  let systems = [...merged.values()];
  const candidatesTruncated = systems.length > P.maxCandidatesPerPass;
  if (candidatesTruncated) systems = systems.slice(0, P.maxCandidatesPerPass);
  const bySystem = campaignsBySystem(read.campaigns.active);
  const candidates = [];
  const recentRows = read.recent ? read.recent.rows.filter((r) => r.resultReference !== RESULT.UNOBSERVED) : [];
  const aftermathOf = aftermathInputOf(read, deps, catalog, recentRows);
  const L = deps.liberated || null;
  const liberatedOf = L && read.liberated ? Object.freeze({ sinceMs: opts.at - L.windowMs }) : null;
  const F = deps.front || null;
  const frontOf = F ? FRONT_INPUT : null;
  const DV = deps.developed || null;
  const developedOf = DV && read.developed ? Object.freeze({ levels: read.developed.levels, minLevel: DV.minLevel,
    ratFactions: read.developed.ratFactions }) : null;
  const changedAt = new Map();
  let aftermathCauseCount = 0;
  const addCandidate = (s, allowed) => {
    const v = call(() => graph.getSystem(s.systemId), null);
    const sdeFactionId = v && Number.isSafeInteger(v.factionId) && v.factionId > 0 ? v.factionId : null;
    const all = causesOfSystem({ ...s, sdeFactionId }, bySystem.get(s.systemId) || [],
      aftermathOf ? aftermathOf(s.systemId) : null, liberatedOf, frontOf, developedOf);
    const causes = allowed ? Object.freeze(all.filter((c) => allowed.has(c.cause))) : all;
    if (causes.length === 0) return;
    aftermathCauseCount += causes.filter((c) => c.cause === CAUSE.BATTLE_AFTERMATH).length;
    if (liberatedOf || frontOf) changedAt.set(s.systemId, s.lastStateChangeAt);
    let observedDistance = null;
    if (presenceOn) {
      const d = call(() => presence.distanceToObserved(s.systemId, P.presenceRadius), null);
      observedDistance = d && d.ok === true && Number.isSafeInteger(d.distance) ? d.distance : null;
    }
    candidates.push({ systemId: s.systemId, securityClass: s.securityClass,
      regionId: v && Number.isSafeInteger(v.regionId) ? v.regionId : null, causes, observedDistance });
  };
  if (graph) {
    for (const s of systems) addCandidate(s, null);
    const extra = new Map();
    const addExtra = (s, cause) => {
      if (merged.has(s.systemId)) return;
      let e = extra.get(s.systemId);
      if (!e) {
        e = { system: s, allowed: new Set() };
        extra.set(s.systemId, e);
      }
      e.allowed.add(cause);
    };
    if (aftermathOf) for (const s of read.aftermath.systems) addExtra(s, CAUSE.BATTLE_AFTERMATH);
    if (liberatedOf) for (const s of read.liberated.systems) addExtra(s, CAUSE.LIBERATED);
    if (developedOf) {
      for (const s of read.developed.systems) {
        addExtra(s, CAUSE.DEVELOPED_INDUSTRY);
        addExtra(s, CAUSE.DEVELOPED_MILITARY);
      }
    }
    for (const e of extra.values()) addCandidate(e.system, e.allowed);
  }
  const openUnobserved = presenceMode
    ? facts.filter((x) => x.row.state === STATE.PLANNED && !(x.activation && x.activation.observed === true)).length
    : 0;
  const context = {
    now: opts.at, seed: opts.seed, round: opts.round, intervalMs: opts.intervalMs, catalog,
    excludedRegionIds: deps.excludedRegionIds,
    limits: deps.limits,
    candidates,
    openEvents: read.open.events.map((e) => ({ systemId: e.systemId, eventType: e.eventType })),
    recent: recentRows,
    recentTruncated: Boolean(read.recent && read.recent.truncated),
    openUnobserved,
  };
  const veinsOn = Boolean(liberatedOf || frontOf);
  const devSpec = developedOf ? { names: DV.eventTypes, maxOpen: DV.maxOpen,
    rankOf: (id) => read.developed.rank.get(id) || [0, 0],
    counted: [CAUSE.DEVELOPED_INDUSTRY, CAUSE.DEVELOPED_MILITARY] } : null;
  let cap = null;
  let dcap = null;
  let capRoundsBound = false;
  if (veinsOn && devSpec) {
    const bound = causeCountOf(candidates, VEIN_CAUSES) + causeCountOf(candidates, devSpec.counted) + 1;
    let cappedV = 0;
    let cappedD = 0;
    for (let round = 1; ; round += 1) {
      cap = capVeins(candidates, changedAt, context, deps);
      dcap = capOpen(candidates, devSpec, context);
      cappedV += cap.capped;
      cappedD += dcap.capped;
      if (cap.cut === 0 && dcap.cut === 0) break;
      if (round >= bound) {
        capRoundsBound = true;
        break;
      }
    }
    cap = { ...cap, capped: cappedV };
    dcap = { ...dcap, capped: cappedD };
  } else if (veinsOn) cap = capVeins(candidates, changedAt, context, deps);
  else if (devSpec) dcap = capOpen(candidates, devSpec, context);
  const out = { facts, context, candidatesTruncated, corrupt, presenceUnknown, waiting };
  if (capRoundsBound) out.capRoundsBound = true;
  if (aftermathOf) out.aftermathCauses = aftermathCauseCount;
  if (L) out.liberatedCauses = cap ? cap.causes : 0;
  if (F) out.frontCauses = cap ? cap.frontCauses : 0;
  if (L || F) out.richVeinsCapped = cap ? cap.capped : 0;
  if (DV) {
    out.developedCauses = dcap ? dcap.left[CAUSE.DEVELOPED_INDUSTRY] + dcap.left[CAUSE.DEVELOPED_MILITARY] : 0;
    out.developedCapped = dcap ? dcap.capped : 0;
  }
  return out;
}

function capVeins(candidates, changedAt, context, deps) {
  const L = deps.liberated || null;
  const F = deps.front || null;
  const names = new Set([...(L ? L.eventTypes : []), ...(F ? F.eventTypes : [])]);
  const maxOpen = L ? L.maxOpen : F.maxOpen;
  const r = capOpen(candidates, { names, maxOpen, rankOf: (id) => [changedAt.get(id) || 0],
    counted: VEIN_CAUSES }, context);
  return { causes: r.left[CAUSE.LIBERATED], frontCauses: r.left[CAUSE.FRONT_LINE], capped: r.capped, cut: r.cut };
}

const VEIN_CAUSES = Object.freeze([CAUSE.LIBERATED, CAUSE.FRONT_LINE]);

function causeCountOf(candidates, counted) {
  let n = 0;
  for (const c of candidates) n += c.causes.filter((x) => counted.includes(x.cause)).length;
  return n;
}

function capOpen(candidates, spec, context) {
  const { names, maxOpen } = spec;
  const byRank = (a, b) => {
    const ra = spec.rankOf(a);
    const rb = spec.rankOf(b);
    for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
      const d = (rb[i] || 0) - (ra[i] || 0);
      if (d !== 0) return d;
    }
    return a - b;
  };
  const classesOf = new Map();
  for (const t of context.catalog.types) {
    if (!names.has(t.eventType)) continue;
    const set = classesOf.get(t.cause) || new Set();
    for (const c of t.securityClasses) set.add(c);
    classesOf.set(t.cause, set);
  }
  const isVein = (x) => classesOf.has(x.cause);
  const free = maxOpen - context.openEvents.filter((e) => names.has(e.eventType)).length;
  const veins = candidates.filter((c) => c.causes.some(isVein));
  let cut = new Set();
  if (veins.length > 0 && free <= 0) cut = new Set(veins.map((c) => c.systemId));
  else if (veins.length > 0) {
    const dry = chooseEvents({ ...context, candidates: [...candidates] });
    const planned = new Set(dry.ok ? dry.plans.filter((p) => names.has(p.eventType)).map((p) => p.systemId) : []);
    if (planned.size > free) {
      const ranked = veins.filter((c) => planned.has(c.systemId));
      ranked.sort((a, b) => byRank(a.systemId, b.systemId));
      const kept = new Set(ranked.slice(0, free).map((c) => c.systemId));
      cut = new Set(veins.filter((c) => !kept.has(c.systemId)).map((c) => c.systemId));
    }
  }
  const counted = (c, cause) => c.causes.filter((x) => x.cause === cause && classesOf.has(cause)
    && classesOf.get(cause).has(c.securityClass)).length;
  let capped = 0;
  let cutSystems = 0;
  const left = {};
  for (const cause of spec.counted) left[cause] = 0;
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const c = candidates[i];
    if (!cut.has(c.systemId)) {
      for (const cause of spec.counted) left[cause] += counted(c, cause);
      continue;
    }
    cutSystems += 1;
    const kept = c.causes.filter((x) => !isVein(x));
    capped += c.causes.filter((x) => isVein(x) && classesOf.get(x.cause).has(c.securityClass)).length;
    if (kept.length === 0) candidates.splice(i, 1);
    else candidates[i] = { ...c, causes: Object.freeze(kept) };
  }
  return { left, capped, cut: cutSystems };
}

function aftermathInputOf(read, deps, catalog, recentRows) {
  const A = deps.aftermath;
  if (!A || !read.aftermath) return null;
  const lastBySystem = lastAftermathBySystem(recentRows, catalog);
  const lossesBySystem = new Map();
  for (const l of read.aftermath.losses) {
    let list = lossesBySystem.get(l.systemId);
    if (!list) {
      list = [];
      lossesBySystem.set(l.systemId, list);
    }
    list.push(l);
  }
  return (systemId) => ({ losses: lossesBySystem.get(systemId) || [], sinceMs: lastBySystem.get(systemId) || 0,
    minLosses: A.minLosses, factions: A.factions });
}

module.exports = { gatherPulseContext, buildDirectorInput, readCampaigns, PROGRAMMER_REASONS };
