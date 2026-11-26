"use strict";

const { performance } = require("node:perf_hooks");
const { createPoller } = require("../presence/poller");
const { PRESENT_STATES, COUNTER_NAMES, WORK_CLASS, STATE } = require("./schema");
const { buildDemand } = require("./demand");
const { assignPilots } = require("./assign");
const { buildCrewRoster } = require("./crewRoster");
const { leaseCharacters } = require("./lease");
const { CIVILIAN_POOL_ID, CIVILIAN_POOL_KEY, CIVILIAN_METRICS } = require("../highsecLife/schema");

const MS_DECIMALS = 10;
const MAX_DETAIL = 160;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function persistenceStore(ctx) {
  const p = ctx && ctx.persistence;
  return p && p.ok === true && p.store && typeof p.store.transaction === "function" ? p.store : null;
}

function createUnavailableLocalPilots(reason) {
  const why = String(reason || "LOCAL_PILOTS_UNAVAILABLE");
  return Object.freeze({
    runPassNow: () => ({ ok: false, reason: why }),
    getStatus: () => Object.freeze({ state: "unavailable", reason: why }),
    stop: () => {},
    speakersOf: () => ({ ok: false, reason: "NOT_RUNNING" }),
    populationLeaseOf: () => ({ ok: false, reason: "NOT_RUNNING" }),
    nudge: () => ({ ok: false, reason: "NOT_RUNNING" }),
  });
}

function startLocalPilots(deps) {
  const config = deps && deps.config;
  const S = config && config.localPilots;
  if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const ctx = deps.ctx || {};
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`localPilots: ${line}`);
    } catch (_err) {
    }
  }

  const adapter = ctx.adapter;
  let seams = null;
  try {
    seams = adapter && typeof adapter.localPilotsSeams === "function" ? adapter.localPilotsSeams() : null;
  } catch (err) {
    seams = { ok: false, reason: "SEAM_THREW", detail: messageOf(err) };
  }
  if (!seams || seams.ok !== true || !seams.seam) {
    const detail = seams ? `${seams.reason || "unknown"}${seams.detail ? `:${seams.detail}` : ""}` : "no_seam";
    log(`not started - adapter_unavailable (${detail})`);
    return { ok: false, reason: "adapter_unavailable", detail };
  }
  const seam = seams.seam;
  if (!persistenceStore(ctx)) return { ok: false, reason: "NO_PERSISTENCE_STORE" };

  let state = STATE.STARTING;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let assignment = new Map();
  const signatures = new Map();
  const dirty = new Set();
  let pool = { version: -1, byCorp: new Map(), byFaction: new Map(), members: new Map(), factionOf: new Map() };
  let civPool = { version: -1, ids: [], members: new Map() };
  let speakers = { civ: new Map(), res: new Map(), atMs: null };
  let civAssignment = new Map();
  let civBucket = null;
  let civGaugesLive = false;
  let popLeases = new Map();
  let popGaugeLive = false;
  let resMembers = new Map();
  let resGaugeLive = false;
  let outMembers = new Map();
  const normalCache = new Map();
  let lastPass = null;
  let lastReassertAt = null;
  const subscriptions = [];

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    counters[name] += n;
    metric("count", `localPilots.${name}`, n);
  }

  function governorAdmits() {
    try {
      const governor = ctx.governor;
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function presenceOf() {
    const p = ctx.presence;
    return p && typeof p.observedSystems === "function" ? p : null;
  }

  function isNormal(systemId) {
    if (normalCache.has(systemId)) return normalCache.get(systemId);
    let r;
    try {
      r = seam.isNormalLocal(systemId);
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true) {
      bump("errors");
      return false;
    }
    const normal = r.normal === true;
    normalCache.set(systemId, normal);
    return normal;
  }

  function refreshPool() {
    const vc = ctx.virtualCorps;
    let cand = null;
    try {
      cand = vc && typeof vc.listPilotCandidates === "function" ? vc.listPilotCandidates() : null;
    } catch (_err) {
      cand = null;
    }
    if (!cand || cand.ok !== true) {
      pool = { version: -1, byCorp: new Map(), byFaction: new Map(), members: new Map(), factionOf: new Map() };
      return;
    }
    if (cand.version === pool.version) return;
    const next = { version: cand.version, byCorp: new Map(), byFaction: new Map(), members: new Map(),
      factionOf: new Map() };
    const list = Array.isArray(cand.candidates) ? cand.candidates.slice(0, S.maxPoolCharacters) : [];
    if (Array.isArray(cand.candidates) && cand.candidates.length > S.maxPoolCharacters) bump("poolTruncated");
    for (const c of list) {
      if (!c || !isPositiveInt(c.characterId)) continue;
      let d;
      try {
        d = seam.describeCharacter(c.characterId);
      } catch (_err) {
        d = null;
      }
      if (!d || d.ok !== true) {
        bump("noRecord");
        continue;
      }
      next.members.set(c.characterId, d.member);
      const corp = next.byCorp.get(d.corporationId);
      if (corp) corp.push(c.characterId);
      else next.byCorp.set(d.corporationId, [c.characterId]);
      if (c.ownerKind === "faction" && isPositiveInt(c.ownerId)) {
        const fac = next.byFaction.get(c.ownerId);
        if (fac) fac.push(c.characterId);
        else next.byFaction.set(c.ownerId, [c.characterId]);
        next.factionOf.set(c.characterId, c.ownerId);
      }
    }
    for (const ids of next.byCorp.values()) ids.sort((a, b) => a - b);
    for (const ids of next.byFaction.values()) ids.sort((a, b) => a - b);
    pool = next;
  }

  function crewsOf() {
    const C = config.crews;
    if (!C || C.enabled !== true) return null;
    try {
      const c = ctx.crews;
      if (!c || typeof c.listSeatsInTx !== "function" || typeof c.getStatus !== "function") return null;
      const st = c.getStatus();
      return st && st.state === STATE.RUNNING ? c : null;
    } catch (_err) {
      return null;
    }
  }

  function readSeats(db, crews, bySystem) {
    const ids = [];
    for (const list of bySystem.values()) {
      for (const f of list) if (f && typeof f.fleetId === "string" && f.fleetId !== "") ids.push(f.fleetId);
    }
    const unique = [...new Set(ids)].sort();
    const batch = Math.max(1, Number(config.crews.maxFleetsPerPass) || 1);
    const out = new Map();
    for (let i = 0; i < unique.length; i += batch) {
      const r = crews.listSeatsInTx(db, unique.slice(i, i + batch));
      if (!r || r.ok !== true || !(r.byFleet instanceof Map)) {
        throw new Error(`listSeatsInTx: ${(r && r.reason) || "no_result"}`);
      }
      for (const [id, seats] of r.byFleet) out.set(id, seats);
    }
    return out;
  }

  function readFleets(systems, crews) {
    const repo = ctx.fleets && ctx.fleets.repository;
    if (!repo || typeof repo.listFleetsInSystem !== "function") {
      bump("errors");
      return null;
    }
    const store = persistenceStore(ctx);
    if (!store) {
      bump("errors");
      return null;
    }
    const out = new Map();
    let truncated = 0;
    let seatsByFleet = null;
    const res = store.transaction("localPilots.fleets", (db) => {
      for (const systemId of systems) {
        const r = repo.listFleetsInSystem(db, systemId, { states: [...PRESENT_STATES],
          limit: S.maxFleetsPerSystem + 1 });
        if (!r || r.ok !== true) throw new Error(`listFleetsInSystem ${systemId}: ${(r && r.reason) || "no_result"}`);
        if (r.fleets.length > S.maxFleetsPerSystem) truncated += 1;
        out.set(systemId, r.fleets.slice(0, S.maxFleetsPerSystem));
      }
      if (crews) seatsByFleet = readSeats(db, crews, out);
    });
    if (!res || res.ok !== true) {
      bump("errors");
      log(`fleet read refused - ${(res && res.reason) || "no_result"}${res && res.error ? ` ${messageOf(res.error)}` : ""}`);
      return null;
    }
    bump("truncatedFleets", truncated);
    return { bySystem: withLiveLosses(out), seatsByFleet };
  }

  function crewRosterOf(read) {
    const C = config.crews;
    const r = buildCrewRoster(read.bySystem, read.seatsByFleet || new Map(), {
      maxPilotsPerFactionPerSystem: S.maxPilotsPerFactionPerSystem, maxPilotsPerSystem: S.maxPilotsPerSystem,
      shipsPerPilot: C.shipsPerPilot, maxCrewPerFleet: C.maxCrewPerFleet });
    let noRecord = 0;
    const bySystem = new Map();
    for (const [systemId, ids] of r.bySystem) {
      const known = ids.filter((id) => pool.members.has(id));
      noRecord += ids.length - known.length;
      if (known.length > 0) bySystem.set(systemId, known);
    }
    bump("noRecord", noRecord);
    return { bySystem, assignment: new Map(), shortfall: r.shortfall, underCrewed: r.underCrewed,
      truncatedPilots: r.truncated };
  }

  function requestEnlist(crews, fleetIds) {
    if (!crews || fleetIds.length === 0 || typeof crews.requestEnlist !== "function") return;
    try {
      crews.requestEnlist(fleetIds);
    } catch (err) {
      bump("errors");
      log(`crews requestEnlist failed - ${messageOf(err)}`);
    }
  }

  function civiliansOf() {
    try {
      const h = ctx.highsecLife;
      if (!h || typeof h.civilianTargets !== "function" || typeof h.getStatus !== "function") return null;
      const st = h.getStatus();
      return st && st.state === STATE.RUNNING ? h : null;
    } catch (_err) {
      return null;
    }
  }

  function refreshCivPool(vc) {
    let cand = null;
    try {
      cand = vc && typeof vc.listCivilianCandidates === "function" ? vc.listCivilianCandidates() : null;
    } catch (_err) {
      cand = null;
    }
    if (!cand || cand.ok !== true) {
      civPool = { version: -1, ids: [], members: new Map() };
      return;
    }
    if (cand.version === civPool.version) return;
    const next = { version: cand.version, ids: [], members: new Map() };
    const list = Array.isArray(cand.characterIds) ? cand.characterIds.slice(0, S.maxPoolCharacters) : [];
    for (const id of list) {
      if (!isPositiveInt(id) || next.members.has(id)) continue;
      let d;
      try {
        d = seam.describeCharacter(id);
      } catch (_err) {
        d = null;
      }
      if (!d || d.ok !== true) {
        bump("noRecord");
        continue;
      }
      next.members.set(id, d.member);
      next.ids.push(id);
    }
    next.ids.sort((a, b) => a - b);
    civPool = next;
  }

  function memberOf(id) {
    return outMembers.get(id) || pool.members.get(id) || civPool.members.get(id) || resMembers.get(id);
  }

  function outlawsOf() {
    const B = config.bountyHunters;
    if (!B || B.enabled !== true) return null;
    try {
      const b = ctx.bounty;
      if (!b || typeof b.residentsFor !== "function" || typeof b.getStatus !== "function") return null;
      const st = b.getStatus();
      return st && st.state === STATE.RUNNING ? b : null;
    } catch (_err) {
      return null;
    }
  }

  function withOutlaws(base, systems, b) {
    const r = b.residentsFor(systems, clock.now());
    if (!r || r.ok !== true || !(r.bySystem instanceof Map)) return null;
    const bySystem = new Map(base.bySystem);
    const members = new Map();
    let shown = 0;
    let noRecord = 0;
    for (const systemId of systems) {
      const list = r.bySystem.get(systemId);
      if (!Array.isArray(list) || list.length === 0) continue;
      const picked = [];
      for (const id of list) {
        if (!isPositiveInt(id) || picked.includes(id)) continue;
        let member = outMembers.get(id);
        if (!member) {
          let d;
          try {
            d = seam.describeCharacter(id);
          } catch (_err) {
            d = null;
          }
          if (!d || d.ok !== true) {
            noRecord += 1;
            continue;
          }
          member = d.member;
        }
        members.set(id, member);
        picked.push(id);
      }
      if (picked.length === 0) continue;
      shown += picked.length;
      bySystem.set(systemId, [...picked, ...(bySystem.get(systemId) || []).filter((id) => !picked.includes(id))]);
    }
    bump("noRecord", noRecord);
    return { bySystem, shown, members };
  }

  function residentsOf() {
    const F = config.freeCorps;
    if (!F || F.enabled !== true || !F.local || F.local.enabled !== true) return null;
    try {
      const fc = ctx.freeCorps;
      if (!fc || typeof fc.residentsFor !== "function" || typeof fc.getStatus !== "function") return null;
      const st = fc.getStatus();
      return st && st.state === STATE.RUNNING ? fc : null;
    } catch (_err) {
      return null;
    }
  }

  function withResidents(base, systems, fc) {
    const r = fc.residentsFor(systems, clock.now());
    if (!r || r.ok !== true || !(r.bySystem instanceof Map)) return null;
    const taken = new Set();
    for (const ids of base.bySystem.values()) for (const id of ids) taken.add(id);
    const bySystem = new Map(base.bySystem);
    const resBySystem = new Map();
    const members = new Map();
    let wanted = 0;
    let assigned = 0;
    let cut = 0;
    let noRecord = 0;
    for (const systemId of systems) {
      const list = r.bySystem.get(systemId);
      if (!Array.isArray(list) || list.length === 0) continue;
      wanted += list.length;
      const own = bySystem.get(systemId) || [];
      let room = Math.max(0, S.maxPilotsPerSystem - own.length);
      const picked = [];
      for (const id of list) {
        if (!isPositiveInt(id) || taken.has(id)) continue;
        if (room <= 0) {
          cut += 1;
          continue;
        }
        let member = resMembers.get(id);
        if (!member) {
          let d;
          try {
            d = seam.describeCharacter(id);
          } catch (_err) {
            d = null;
          }
          if (!d || d.ok !== true) {
            noRecord += 1;
            continue;
          }
          member = d.member;
        }
        taken.add(id);
        members.set(id, member);
        picked.push(id);
        room -= 1;
      }
      if (picked.length === 0) continue;
      assigned += picked.length;
      resBySystem.set(systemId, picked);
      bySystem.set(systemId, [...own, ...picked]);
    }
    bump("noRecord", noRecord);
    return { bySystem, resBySystem, wanted, assigned, cut, members };
  }

  function closeResGauge() {
    if (!resGaugeLive) return;
    resGaugeLive = false;
    metric("gauge", "localPilots.residents", 0);
  }

  function withCivilians(base, systems, civ) {
    const t = civ.civilianTargets(systems, clock.now());
    if (!t || t.ok !== true || !(t.targets instanceof Map)) return null;
    const released = civBucket !== null && t.bucket !== civBucket ? civ.civilianChurn(civAssignment, t.bucket)
      : new Set();
    civBucket = t.bucket;
    const prev = new Map();
    for (const [id, at] of civAssignment) if (!released.has(id)) prev.set(id, at);
    const demand = [];
    let wanted = 0;
    for (const systemId of systems) {
      const target = t.targets.get(systemId) || 0;
      const room = Math.max(0, S.maxPilotsPerSystem - (base.bySystem.get(systemId) || []).length);
      const want = Math.min(target, room);
      if (want <= 0) continue;
      wanted += want;
      demand.push({ systemId, pools: [{ poolKey: CIVILIAN_POOL_KEY, factionId: CIVILIAN_POOL_ID, corporationId: null,
        ships: 0, wanted: want }] });
    }
    const order = civ.civilianOrder(civPool.ids, t.bucket, released);
    const r = assignPilots({ demand, pool: { byCorp: new Map(), byFaction: new Map([[CIVILIAN_POOL_ID, order]]) },
      previous: prev, maxPilotsPerSystem: S.maxPilotsPerSystem });
    const bySystem = new Map(base.bySystem);
    let assigned = 0;
    for (const [systemId, ids] of r.bySystem) {
      assigned += ids.length;
      bySystem.set(systemId, [...(base.bySystem.get(systemId) || []), ...ids]);
    }
    civAssignment = r.assignment;
    return { bySystem, civBySystem: r.bySystem, wanted, assigned, shortfall: r.shortfall, bucket: t.bucket };
  }

  function populationOf() {
    const P = config.population;
    if (!P || !P.live || P.live.localEnabled !== true) return null;
    try {
      const p = ctx.population;
      if (!p || typeof p.localIdsIn !== "function" || typeof p.getStatus !== "function") return null;
      const st = p.getStatus();
      return st && st.state === STATE.RUNNING ? p : null;
    } catch (_err) {
      return null;
    }
  }

  function withPopulation(base, systems, pop) {
    const cap = config.population.live.maxLocalPerSystem;
    const taken = new Set();
    for (const ids of base.bySystem.values()) for (const id of ids) taken.add(id);
    const demand = [];
    let wanted = 0;
    for (const systemId of systems) {
      const room = Math.max(0, S.maxPilotsPerSystem - (base.bySystem.get(systemId) || []).length);
      const want = Math.min(room, cap);
      if (!(want > 0)) continue;
      const ids = pop.localIdsIn(systemId, want);
      const pilotIds = (Array.isArray(ids) ? ids : []).filter(isPositiveInt).slice(0, want);
      if (pilotIds.length === 0) continue;
      wanted += pilotIds.length;
      demand.push({ systemId, pilotIds });
    }
    const r = leaseCharacters({ poolIds: civPool.ids, demand, previous: popLeases, taken });
    const bySystem = new Map(base.bySystem);
    for (const [systemId, ids] of r.bySystem) bySystem.set(systemId, [...(base.bySystem.get(systemId) || []), ...ids]);
    return { bySystem, civBySystem: r.bySystem, leases: r.leases, wanted, assigned: r.assigned,
      shortfall: r.shortfall, noPool: civPool.ids.length === 0 ? wanted : 0 };
  }

  function closePopGauge() {
    if (!popGaugeLive) return;
    popGaugeLive = false;
    metric("gauge", "localPilots.population", 0);
  }

  function noteCivilians(civ, civBySystem) {
    if (!civ || typeof civ.noteCivilians !== "function") return;
    try {
      civ.noteCivilians(civBySystem, clock.now());
    } catch (err) {
      bump("errors");
      log(`civilians note failed - ${messageOf(err)}`);
    }
  }

  function freeChatterOn() {
    const F = config.freeCorps;
    return Boolean(F && F.enabled === true && F.chatter && F.chatter.enabled === true);
  }

  function noteResidents(civ, resBySystem) {
    if (!civ || typeof civ.noteResidents !== "function") return;
    try {
      civ.noteResidents(resBySystem, clock.now());
    } catch (err) {
      bump("errors");
      log(`residents note failed - ${messageOf(err)}`);
    }
  }

  function voicesOf() {
    const V = config.npcVoices;
    if (!V || V.enabled !== true || !V.local || V.local.enabled !== true) return null;
    try {
      const v = ctx.npcVoices;
      if (!v || typeof v.noteFactionCrews !== "function" || typeof v.getStatus !== "function") return null;
      const st = v.getStatus();
      return st && st.state === STATE.RUNNING ? v : null;
    } catch (_err) {
      return null;
    }
  }

  function factionCrewsOf(baseBySystem, pushedBySystem) {
    const out = new Map();
    for (const [systemId, ids] of baseBySystem) {
      if ((signatures.get(systemId) || "") !== (pushedBySystem.get(systemId) || []).join(",")) continue;
      const crews = [];
      for (const id of ids) {
        const factionId = pool.factionOf.get(id);
        if (factionId !== undefined) crews.push({ characterId: id, factionId });
      }
      if (crews.length > 0) out.set(systemId, crews);
    }
    return out;
  }

  function noteFactionCrews(voices, bySystem) {
    try {
      voices.noteFactionCrews(bySystem, clock.now());
    } catch (err) {
      bump("errors");
      log(`faction crews note failed - ${messageOf(err)}`);
    }
  }

  function closeCivGauges() {
    if (!civGaugesLive) return;
    civGaugesLive = false;
    metric("gauge", CIVILIAN_METRICS.wanted, 0);
    metric("gauge", CIVILIAN_METRICS.assigned, 0);
  }

  function withLiveLosses(bySystem) {
    let losses = null;
    try {
      const m = ctx.materialization;
      losses = m && typeof m.liveLossesByFleet === "function" ? m.liveLossesByFleet() : null;
    } catch (_err) {
      losses = null;
    }
    if (!(losses instanceof Map) || losses.size === 0) return bySystem;
    for (const [systemId, fleets] of bySystem) {
      bySystem.set(systemId, fleets.map((f) => {
        const lost = f && losses.get(f.fleetId);
        return Number.isSafeInteger(lost) && lost > 0 && Number.isFinite(f.shipCount)
          ? { ...f, shipCount: Math.max(0, f.shipCount - lost) } : f;
      }));
    }
    return bySystem;
  }

  function repushDirty() {
    const order = [...dirty].sort((a, b) => a - b).slice(0, S.maxRepushPerPass);
    for (const systemId of order) {
      let r;
      try {
        r = seam.repushSystem(systemId);
      } catch (_err) {
        r = null;
      }
      if (r && r.ok === true) {
        bump("repushes");
        dirty.delete(systemId);
      } else {
        bump("repushFailed");
      }
    }
  }

  function reassertXmpp() {
    const now = clock.now();
    if (S.xmppReassertMs > 0 && (lastReassertAt === null || now - lastReassertAt >= S.xmppReassertMs)) {
      let r = null;
      try {
        r = typeof seam.reassertXmpp === "function" ? seam.reassertXmpp(S.xmppMaxReassertStanzasPerPass) : null;
      } catch (_err) {
        r = null;
      }
      if (r && r.ok === true) {
        bump("xmppReasserts");
        lastReassertAt = now;
      }
    }
    let xmpp = null;
    try {
      const st = seam.getState();
      xmpp = st && st.xmpp ? st.xmpp : null;
    } catch (_err) {
      xmpp = null;
    }
    metric("gauge", "localPilots.xmppSockets", xmpp ? Number(xmpp.sockets) || 0 : 0);
    metric("gauge", "localPilots.xmppShown", xmpp ? Number(xmpp.shown) || 0 : 0);
  }

  function pass() {
    if (state !== STATE.RUNNING) return { ok: false, reason: "not_running" };
    if (!governorAdmits()) {
      bump("deferrals");
      poller.arm(S.deferRetryMs);
      return { ok: false, reason: "DEFERRED" };
    }
    const t0 = performance.now();
    try {
      const presence = presenceOf();
      const observed = presence ? presence.observedSystems() : [];
      const all = [...new Set(Array.isArray(observed) ? observed : [])].filter(isPositiveInt).sort((a, b) => a - b)
        .filter((systemId) => isNormal(systemId));
      const systems = all.slice(0, S.maxSystemsPerPass);
      bump("truncatedSystems", all.length - systems.length);
      refreshPool();
      const crews = crewsOf();
      const read = systems.length > 0 ? readFleets(systems, crews)
        : { bySystem: new Map(), seatsByFleet: crews ? new Map() : null };
      if (read === null) return { ok: false, reason: "READ_REFUSED" };
      let res;
      if (crews) {
        res = crewRosterOf(read);
      } else {
        const demand = buildDemand(read.bySystem, S);
        let noPool = 0;
        for (const sys of demand) {
          for (const p of sys.pools) {
            const corp = p.corporationId ? pool.byCorp.get(p.corporationId) : null;
            const fac = pool.byFaction.get(p.factionId);
            if (!(corp && corp.length) && !(fac && fac.length)) noPool += p.ships;
          }
        }
        bump("noPool", noPool);
        res = assignPilots({ demand, pool, previous: assignment, maxPilotsPerSystem: S.maxPilotsPerSystem });
      }
      const baseBySystem = res.bySystem;
      const pop = populationOf();
      const hsl = civiliansOf();
      const civ = pop ? null : hsl;
      let civRes = null;
      let popRes = null;
      if (pop) {
        refreshCivPool(ctx.virtualCorps);
        try {
          popRes = withPopulation(res, systems, pop);
        } catch (err) {
          bump("errors");
          log(`population lane failed - ${messageOf(err)}`);
          popRes = null;
        }
      } else if (civ) {
        refreshCivPool(ctx.virtualCorps);
        try {
          civRes = withCivilians(res, systems, civ);
        } catch (err) {
          bump("errors");
          log(`civilians failed - ${messageOf(err)}`);
          civRes = null;
        }
      }
      if (civRes) {
        res = { ...res, bySystem: civRes.bySystem };
      } else {
        civAssignment = new Map();
        civBucket = null;
      }
      if (popRes) {
        res = { ...res, bySystem: popRes.bySystem };
        popLeases = popRes.leases;
      } else {
        popLeases = new Map();
      }
      const laneCiv = popRes ? popRes.civBySystem : civRes ? civRes.civBySystem : new Map();
      const fc = residentsOf();
      let resRes = null;
      if (fc) {
        try {
          resRes = withResidents(res, systems, fc);
        } catch (err) {
          bump("errors");
          log(`residents failed - ${messageOf(err)}`);
          resRes = null;
        }
        if (resRes === null) bump("residentsFailed");
      }
      if (resRes) {
        res = { ...res, bySystem: resRes.bySystem };
        resMembers = resRes.members;
      } else {
        resMembers = new Map();
      }
      const outlaws = outlawsOf();
      let outRes = null;
      if (outlaws) {
        try {
          outRes = withOutlaws(res, systems, outlaws);
        } catch (err) {
          bump("errors");
          log(`outlaws failed - ${messageOf(err)}`);
          outRes = null;
        }
      }
      const nextOut = outRes ? outRes.members : new Map();
      const leftOut = [...outMembers.keys()].filter((id) => !nextOut.has(id));
      if (leftOut.length > 0) {
        bump("outlawsLeft", leftOut.length);
        log(`outlaws left Local - ${leftOut.join(",")}`);
      }
      if (outRes) {
        res = { ...res, bySystem: outRes.bySystem };
        outMembers = outRes.members;
      } else {
        outMembers = new Map();
      }
      const touched = new Set([...res.bySystem.keys(), ...signatures.keys()]);
      let pilots = 0;
      for (const systemId of [...touched].sort((a, b) => a - b)) {
        const ids = res.bySystem.get(systemId) || [];
        pilots += ids.length;
        const sig = ids.join(",");
        if (sig === (signatures.get(systemId) || "")) continue;
        const set = seam.setRoster(systemId, ids.map((id) => memberOf(id)));
        if (!set || set.ok !== true) {
          bump("errors");
          continue;
        }
        if (sig === "") signatures.delete(systemId);
        else signatures.set(systemId, sig);
        dirty.add(systemId);
      }
      if (hsl) noteCivilians(hsl, laneCiv);
      if (hsl && freeChatterOn()) noteResidents(hsl, resRes ? resRes.resBySystem : new Map());
      speakers = { civ: laneCiv, res: resRes ? resRes.resBySystem : new Map(), atMs: clock.now() };
      const voices = voicesOf();
      if (voices) noteFactionCrews(voices, factionCrewsOf(baseBySystem, res.bySystem));
      repushDirty();
      if (dirty.size > 0) poller.arm(S.nudgeDelayMs);
      assignment = res.assignment;
      if (crews) requestEnlist(crews, res.underCrewed);
      bump("passes");
      bump("shortfall", res.shortfall);
      metric("gauge", "localPilots.systems", signatures.size);
      metric("gauge", "localPilots.pilots", pilots);
      if (civRes) {
        metric("gauge", CIVILIAN_METRICS.wanted, civRes.wanted);
        metric("gauge", CIVILIAN_METRICS.assigned, civRes.assigned);
        if (civRes.shortfall > 0) metric("count", CIVILIAN_METRICS.shortfall, civRes.shortfall);
        civGaugesLive = true;
      } else {
        closeCivGauges();
      }
      if (popRes) {
        metric("gauge", "localPilots.population", popRes.assigned);
        popGaugeLive = true;
        bump("populationShortfall", popRes.shortfall);
        bump("populationNoPool", popRes.noPool);
      } else {
        closePopGauge();
      }
      if (resRes) {
        metric("gauge", "localPilots.residents", resRes.assigned);
        resGaugeLive = true;
      } else {
        closeResGauge();
      }
      reassertXmpp();
      const ms = Math.round((performance.now() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", "localPilots.passMs", ms);
      lastPass = { at: clock.now(), systems: systems.length, rosters: signatures.size, pilots, ms,
        shortfall: res.shortfall, mode: crews ? "crews" : "assign",
        ...(crews ? { underCrewed: res.underCrewed.length, truncatedPilots: res.truncatedPilots } : {}),
        ...(civRes ? { civilians: { wanted: civRes.wanted, assigned: civRes.assigned, shortfall: civRes.shortfall,
          bucket: civRes.bucket, pool: civPool.ids.length } } : {}),
        ...(popRes ? { population: { wanted: popRes.wanted, assigned: popRes.assigned, shortfall: popRes.shortfall,
          pool: civPool.ids.length } } : {}),
        ...(resRes ? { residents: { wanted: resRes.wanted, assigned: resRes.assigned, cut: resRes.cut } } : {}),
        ...(outRes ? { outlaws: outRes.shown } : {}) };
      return { ok: true };
    } catch (err) {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
      closeCivGauges();
      closeResGauge();
      closePopGauge();
      return { ok: false, reason: "PASS_FAILED", detail: messageOf(err) };
    }
  }

  const poller = createPoller({ runPass: () => { pass(); }, intervalMs: S.refreshMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => { bump("errors"); log(`timer failed - ${messageOf(err)}`); } });

  function scheduleSoon() {
    if (state !== STATE.RUNNING) return;
    poller.arm(S.nudgeDelayMs);
  }

  function nudge() {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    bump("nudges");
    scheduleSoon();
    return { ok: true };
  }

  state = STATE.RUNNING;
  poller.start();
  poller.arm(S.nudgeDelayMs);

  const presence = presenceOf();
  if (presence) {
    for (const name of ["onSystemObserved", "onSystemUnobserved"]) {
      try {
        const sub = typeof presence[name] === "function" ? presence[name](() => scheduleSoon()) : null;
        if (sub && sub.ok && typeof sub.unsubscribe === "function") subscriptions.push(() => sub.unsubscribe());
      } catch (err) {
        log(`presence ${name} refused - ${messageOf(err)}`);
      }
    }
  }
  const travel = ctx.fleets && ctx.fleets.travel;
  if (travel && typeof travel.addArrivalListener === "function") {
    try {
      const listener = travel.addArrivalListener((_tx, arrival) => {
        try {
          const p = presenceOf();
          if (arrival && p && typeof p.isObserved === "function" && p.isObserved(arrival.systemId)) scheduleSoon();
        } catch (_err) {
        }
      });
      if (listener && listener.ok && typeof listener.remove === "function") subscriptions.push(() => listener.remove());
    } catch (err) {
      log(`arrival listener refused - ${messageOf(err)}`);
    }
  }
  const vc = ctx.virtualCorps;
  if (vc && typeof vc.whenReady === "function") {
    try {
      Promise.resolve(vc.whenReady()).then(() => scheduleSoon(), () => {});
    } catch (_err) {
    }
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    try {
      closeCivGauges();
      closeResGauge();
      closePopGauge();
      if (ctx.highsecLife) noteCivilians(ctx.highsecLife, new Map());
      if (ctx.highsecLife && freeChatterOn()) noteResidents(ctx.highsecLife, new Map());
      const voices = voicesOf();
      if (voices) noteFactionCrews(voices, new Map());
    } catch (_err) {
    }
    state = STATE.STOPPED;
    poller.stop();
    for (const off of subscriptions.splice(0)) {
      try {
        off();
      } catch (_err) {
      }
    }
    let systems = [];
    try {
      const cleared = seam.clearRosters();
      systems = cleared && Array.isArray(cleared.systems) ? cleared.systems : [];
    } catch (err) {
      log(`clear failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
    for (const systemId of systems) {
      let r;
      try {
        r = seam.repushSystem(systemId);
      } catch (_err) {
        r = null;
      }
      if (r && r.ok === true) bump("repushes");
      else bump("repushFailed");
    }
    signatures.clear();
    dirty.clear();
    assignment = new Map();
    civAssignment = new Map();
    civBucket = null;
    popLeases = new Map();
    resMembers = new Map();
    outMembers = new Map();
    speakers = { civ: new Map(), res: new Map(), atMs: null };
  }

  function populationLeaseOf(pilotId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    const characterId = popLeases.get(Number(pilotId));
    return { ok: true, characterId: characterId === undefined ? null : characterId };
  }

  function speakersOf(systemId) {
    if (state !== STATE.RUNNING) return { ok: false, reason: "NOT_RUNNING" };
    if (!isPositiveInt(systemId)) return { ok: false, reason: "BAD_SYSTEM" };
    const copy = (bySystem) => {
      const ids = bySystem instanceof Map ? bySystem.get(systemId) : null;
      return (Array.isArray(ids) ? ids : []).filter(isPositiveInt).sort((a, b) => a - b);
    };
    return { ok: true, civilians: copy(speakers.civ), residents: copy(speakers.res), atMs: speakers.atMs };
  }

  function getStatus() {
    let seamState = null;
    try {
      seamState = seam.getState();
    } catch (_err) {
      seamState = null;
    }
    return { state, lastPass, rosters: signatures.size, dirty: dirty.size, poolVersion: pool.version,
      poolCharacters: pool.members.size, ...counters,
      seam: seamState ? { appended: seamState.appended, augmentErrors: seamState.augmentErrors,
        installed: seamState.installed, xmpp: seamState.xmpp || null } : null };
  }

  return { ok: true, localPilots: Object.freeze({ runPassNow: () => pass(), getStatus, stop, speakersOf,
    populationLeaseOf, nudge }) };
}

module.exports = { startLocalPilots, createUnavailableLocalPilots };
