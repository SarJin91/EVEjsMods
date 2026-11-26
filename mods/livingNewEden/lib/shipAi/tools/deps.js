"use strict";

const { OPEN_BATTLE_STATES } = require("../../battle/schema");
const invasionRepository = require("../../world/invasions/invasionRepository");
const eventRepository = require("../../events/eventRepository");
const { classKeyOf } = require("../callout");
const { UNKNOWN } = require("../../names/fallback");

const fail = (reason) => ({ ok: false, reason });
const NPC_CORP_IDS = Object.freeze([1000000, 2000000]);
const LIVE_PHASES = new Set(["VISIBLE", "HELD", "EXITING"]);
const LIVE_HUNT_STATES = new Set(["SPAWNING", "LIVE"]);
const TYPE_CLASS_CACHE_MAX = 512;
const call = (fnOrNull, ...args) => {
  try {
    return typeof fnOrNull === "function" ? fnOrNull(...args) : null;
  } catch (_err) {
    return null;
  }
};

function createToolDeps(o) {
  const a = o.adapter || {};
  const sensors = o.sensors || null;
  const db = o.db || null;
  let pirates;
  let factionNames;
  const bound = (name) => (typeof a[name] === "function" ? (...args) => a[name](...args) : null);

  const presence = () => call(bound("readPresence")) || fail("NO_PRESENCE");
  const graph = () => {
    const g = call(o.getGraph);
    const r = g && typeof g.getGraph === "function" ? call(() => g.getGraph()) : null;
    return r && r.ok && r.graph ? r.graph : null;
  };
  const telemetry = (playerId) => (sensors && typeof sensors.telemetry === "function"
    ? call(sensors.telemetry, playerId) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const typeName = (typeId) => {
    const r = call(bound("readItemTypeFacts"), [typeId]);
    const f = r && r.ok && r.facts instanceof Map ? r.facts.get(typeId) : null;
    return f && f.name ? f.name : null;
  };
  const stations = (systemId) => call(bound("listNpcStationsInSystem"), systemId) || fail("SEAM_UNAVAILABLE");
  const liveFleetsIn = (systemSet) => {
    const out = new Map();
    const m = call(o.getMaterialization);
    const st = m && typeof m.getStatus === "function" ? call(() => m.getStatus()) : null;
    if (!st || typeof st !== "object") return out;
    const add = (e, ships) => {
      if (!e || typeof e.fleetId !== "string" || e.fleetId === "" || !systemSet.has(e.systemId)
        || !Number.isSafeInteger(e.factionId) || !Number.isSafeInteger(ships) || ships <= 0
        || e.despawned === true) return;
      const bySystem = out.get(e.systemId) || new Map();
      const prev = bySystem.get(e.fleetId);
      if (!prev || prev.ships < ships) bySystem.set(e.fleetId, { factionId: e.factionId, ships });
      out.set(e.systemId, bySystem);
    };
    const list = (section, key) => (section && Array.isArray(section[key]) ? section[key] : []);
    const left = (e) => (Number(e.ships) || 0) - (Number(e.destroyed) || 0);
    for (const e of list(st.presence, "entries")) {
      if (LIVE_PHASES.has(e.phase)) add(e, Array.isArray(e.entityIds) ? e.entityIds.length : 0);
    }
    for (const e of list(st.hunts, "hunts")) if (LIVE_HUNT_STATES.has(e.state)) add(e, e.alive);
    for (const e of list(st.patrols, "list")) if (LIVE_HUNT_STATES.has(e.state)) add(e, e.alive);
    for (const e of list(st.exposures, "entries")) if (LIVE_PHASES.has(e.phase)) add(e, left(e));
    for (const e of list(st.sentryHolds, "entries")) if (LIVE_PHASES.has(e.phase)) add(e, left(e));
    return out;
  };
  const fleetsIn = (systemIds, states) => {
    const fleets = call(o.getFleets);
    const repo = fleets && fleets.repository;
    const store = call(o.getStore);
    if (!repo || typeof repo.listFleetsInSystems !== "function" || !store || typeof store.transaction !== "function") {
      return fail("FLEETS_UNAVAILABLE");
    }
    const ids = systemIds.filter((id) => Number.isSafeInteger(id) && id > 0);
    const perSystem = 1 + o.S.toolMaxRows;
    const live = liveFleetsIn(new Set(ids));
    const res = store.transaction("shipAi.tools.fleets", (tx) => {
      const read = repo.listFleetsInSystems(tx, ids, { states: [...states], limitPerSystem: perSystem });
      if (!read || !read.ok || !(read.bySystem instanceof Map) || live.size === 0) return read;
      const known = new Set();
      for (const rows of read.bySystem.values()) for (const f of rows) if (f && f.fleetId) known.add(f.fleetId);
      const extra = new Map();
      for (const [systemId, byFleet] of live) {
        const room = Math.max(0, perSystem - (read.bySystem.get(systemId) || []).length);
        const picked = [...byFleet.keys()].filter((id) => !known.has(id)).sort().slice(0, room);
        for (const id of picked) extra.set(id, systemId);
      }
      if (extra.size === 0) return read;
      const got = typeof repo.getFleets === "function" ? repo.getFleets(tx, [...extra.keys()]) : null;
      const rowOf = new Map(got && got.ok && Array.isArray(got.fleets) ? got.fleets.map((f) => [f.fleetId, f]) : []);
      const bySystem = new Map(read.bySystem);
      for (const [id, systemId] of extra) {
        const e = live.get(systemId).get(id);
        const row = rowOf.get(id);
        bySystem.set(systemId, [...(bySystem.get(systemId) || []), { fleetId: id,
          factionId: row && Number.isSafeInteger(row.factionId) ? row.factionId : e.factionId,
          fleetRole: row && row.fleetRole ? row.fleetRole : null, shipCount: e.ships, state: row ? row.state : null,
          inSpace: true }]);
      }
      return { ok: true, bySystem };
    });
    if (!res || !res.ok) return fail((res && res.reason) || "FLEETS_UNAVAILABLE");
    return res.value && res.value.ok ? res.value : fail((res.value && res.value.reason) || "FLEETS_UNAVAILABLE");
  };
  const localNpcs = (systemId) => {
    const s = call(bound("localPilotsSeams"));
    const seam = s && s.ok && s.seam ? s.seam : null;
    const r = seam && typeof seam.rosterSize === "function" ? call(() => seam.rosterSize(systemId)) : null;
    return r && r.ok && Number.isSafeInteger(r.pilots) && r.pilots >= 0 ? r.pilots : null;
  };
  const piratesOf = () => {
    if (pirates === undefined) {
      const r = call(bound("readPirateFactionIds"));
      pirates = r && r.ok && r.ids instanceof Set ? r.ids : null;
    }
    return pirates;
  };
  const standing = (playerId, factionId) => {
    const r = call(bound("readCharacterStanding"), playerId, factionId);
    return r && r.ok && r.found === true && Number.isFinite(r.standing) ? r.standing : null;
  };
  const factionMap = () => {
    if (factionNames !== undefined) return factionNames;
    const r = call(bound("readFactionNames"));
    if (r && r.ok && r.names instanceof Map) {
      factionNames = r.names;
      return factionNames;
    }
    return new Map();
  };
  const factionName = (factionId) => factionMap().get(factionId)
    || (Number.isSafeInteger(factionId) ? UNKNOWN.faction : null);
  const isNpcOwnerId = (id) => Number.isSafeInteger(id)
    && (factionMap().has(id) || (id >= NPC_CORP_IDS[0] && id < NPC_CORP_IDS[1]));
  const controlState = (systemId) => {
    const w = call(o.getWorld);
    return (w && typeof w.getControlState === "function" ? call(() => w.getControlState(systemId)) : null)
      || fail("WORLD_UNAVAILABLE");
  };
  const systems = (ids) => {
    const w = call(o.getWorld);
    if (!w || typeof w.getSystems !== "function") return fail("WORLD_UNAVAILABLE");
    const all = [...ids];
    let r = call(() => w.getSystems(all, { includeInfluence: false }));
    if (r && r.ok) return r;
    if (!r || r.reason !== "BATCH_TOO_LARGE" || !Number.isSafeInteger(r.limit) || r.limit < 1) {
      return fail((r && r.reason) || "WORLD_UNAVAILABLE");
    }
    const out = [];
    for (let i = 0; i < all.length; i += r.limit) {
      const part = call(() => w.getSystems(all.slice(i, i + r.limit), { includeInfluence: false }));
      if (!part || !part.ok) return fail((part && part.reason) || "WORLD_UNAVAILABLE");
      out.push(...part.systems);
    }
    r = { ok: true, systems: out };
    return r;
  };
  const prices = (typeId, regionId) => Promise.resolve(call(bound("readTradePrices"), { typeIds: [typeId],
    refRegionId: regionId, regionIds: [], maxRegions: 1 }) || fail("SEAM_UNAVAILABLE"))
    .catch(() => fail("SEAM_UNAVAILABLE"));
  const wallet = (playerId) => call(bound("tradeReadCharacterWallet"), playerId) || fail("SEAM_UNAVAILABLE");
  const itemByName = (name) => (sensors && typeof sensors.itemByName === "function"
    ? call(sensors.itemByName, name) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const itemSearch = (query, maxRows) => (sensors && typeof sensors.itemSearch === "function"
    ? call(sensors.itemSearch, query, maxRows) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const skills = (playerId, max) => (sensors && typeof sensors.skills === "function"
    ? call(sensors.skills, playerId, max) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const recentEvents = (playerId, max) => call(o.recentEvents, playerId, max) || fail("EVENTS_UNAVAILABLE");
  const dbCall = (name, ...args) => (db && typeof db[name] === "function"
    ? call(db[name], ...args) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const cargo = (playerId, maxRows) => dbCall("cargo", playerId, { maxRows });
  const fitting = (playerId, maxRows) => dbCall("fitting", playerId, { maxRows });
  const pilot = (playerId) => dbCall("pilot", playerId);
  const assets = (playerId, maxRows) => dbCall("assets", playerId, { maxRows });
  const findItem = (playerId, typeId, maxRows) => dbCall("findItem", playerId, typeId, { maxRows });
  const walletHistory = (playerId, maxRows, nowMs, sumWindowMs) => dbCall("walletHistory", playerId,
    { maxRows, nowMs, sumWindowMs });
  const skillQueue = (playerId, maxRows) => dbCall("skillQueue", playerId, { maxRows });
  const standings = (playerId, maxRows) => dbCall("standings", playerId, { maxRows, isNpcOwnerId });
  const killmails = (playerId, maxRows, nowMs) => dbCall("killmails", playerId, { maxRows, nowMs });
  const missions = (playerId, maxRows, nowMs) => dbCall("missions", playerId, { maxRows, nowMs });
  const industryJobs = (playerId, maxRows, nowMs) => dbCall("industryJobs", playerId, { maxRows, nowMs });
  const marketOrders = (playerId, maxRows) => Promise.resolve(dbCall("marketOrders", playerId,
    { maxRows, timeoutMs: o.S ? o.S.dbReadAsyncTimeoutMs : null })).catch(() => fail("SEAM_UNAVAILABLE"));
  const OPEN = new Set(OPEN_BATTLE_STATES);
  const sidesOf = (b) => ["sideA", "sideB"].filter((k) => b && b.input && b.input[k]
    && Array.isArray(b.input[k].fleets) && b.input[k].fleets.length > 0).length;
  const battlesIn = (systemIds, limitPerSystem) => {
    const battle = call(o.getBattles);
    const repo = battle && battle.repository;
    const store = call(o.getStore);
    if (!repo || typeof repo.listOpenInSystem !== "function" || !store || typeof store.transaction !== "function") {
      return fail("BATTLES_UNAVAILABLE");
    }
    const ids = [...new Set(systemIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    const limit = Number.isSafeInteger(limitPerSystem) && limitPerSystem > 0 ? limitPerSystem : 1;
    const res = store.transaction("shipAi.tools.battles", (tx) => {
      const bySystem = new Map();
      for (const id of ids) {
        const r = repo.listOpenInSystem(tx, id, { states: [...OPEN_BATTLE_STATES], limit });
        if (!r || !r.ok || !Array.isArray(r.battles)) return fail((r && r.reason) || "BATTLES_UNAVAILABLE");
        const rows = r.battles.filter((b) => b && OPEN.has(b.state))
          .map((b) => ({ state: b.state, mode: b.mode, sides: sidesOf(b) }));
        if (rows.length > 0) bySystem.set(id, rows);
      }
      return { ok: true, bySystem };
    });
    if (!res || !res.ok) return fail((res && res.reason) || "BATTLES_UNAVAILABLE");
    return res.value && res.value.ok ? res.value : fail((res.value && res.value.reason) || "BATTLES_UNAVAILABLE");
  };
  const hereIn = (systemId, limit) => {
    const store = call(o.getStore);
    if (!store || typeof store.transaction !== "function") return fail("STORE_UNAVAILABLE");
    if (!Number.isSafeInteger(systemId) || systemId <= 0) return fail("BAD_SYSTEM");
    const n = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
    const battle = call(o.getBattles);
    const repo = battle && battle.repository && typeof battle.repository.listOpenInSystem === "function"
      ? battle.repository : null;
    const sideName = (side) => {
      const id = side && Number.isSafeInteger(side.factionId) ? side.factionId : null;
      return id === null ? null : factionMap().get(id) || null;
    };
    const res = store.transaction("shipAi.world.here", (tx) => {
      let battles = null;
      if (repo) {
        try {
          const r = repo.listOpenInSystem(tx, systemId, { states: [...OPEN_BATTLE_STATES], limit: n });
          battles = r && r.ok && Array.isArray(r.battles) ? r.battles.filter((b) => b && OPEN.has(b.state)
            && typeof b.battleId === "string").map((b) => ({ battleId: b.battleId, state: b.state,
            mode: typeof b.mode === "string" ? b.mode : null, a: sideName(b.input && b.input.sideA),
            b: sideName(b.input && b.input.sideB) })) : null;
        } catch (_err) {
          battles = null;
        }
      }
      let events = null;
      try {
        const r = eventRepository.listActiveInSystem(tx, systemId, { limit: n });
        events = r && r.ok && Array.isArray(r.events) ? r.events.filter((e) => e && typeof e.eventId === "string")
          .map((e) => ({ eventId: e.eventId, eventType: e.eventType,
            label: typeof e.label === "string" ? e.label : null })) : null;
      } catch (_err) {
        events = null;
      }
      return { ok: true, battles, events };
    });
    if (!res || !res.ok || !res.value) return fail("HERE_UNAVAILABLE");
    return res.value;
  };
  const invasionsOpen = (limit) => {
    const store = call(o.getStore);
    if (!store || typeof store.transaction !== "function") return fail("INVASIONS_UNAVAILABLE");
    const n = Number.isSafeInteger(limit) && limit > 0 ? limit : 1;
    const res = store.transaction("shipAi.tools.invasions", (tx) => invasionRepository.listOpen(tx, { limit: n }));
    if (!res || !res.ok) return fail((res && res.reason) || "INVASIONS_UNAVAILABLE");
    const v = res.value;
    if (!v || !v.ok || !Array.isArray(v.invasions)) return fail("INVASIONS_UNAVAILABLE");
    return { ok: true, invasions: v.invasions.map((row) => ({ factionId: Number(row.faction_id),
      beachheadSystemId: Number(row.beachhead_system_id), state: row.state })) };
  };
  const gridNpcs = (systemId, opts) => (sensors && typeof sensors.gridNpcs === "function"
    ? call(sensors.gridNpcs, systemId, opts) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const wingCopies = (systemId, opts) => (sensors && typeof sensors.wingCopies === "function"
    ? call(sensors.wingCopies, systemId, opts) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const wingHpMarks = () => call(bound("shipWingHpMarks")) || fail("SEAM_UNAVAILABLE");
  const wingLoaded = () => call(bound("shipWingLoaded")) || fail("SEAM_UNAVAILABLE");
  const crimeFlags = (playerId) => (sensors && typeof sensors.crimeFlags === "function"
    ? call(sensors.crimeFlags, playerId) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const securityStatus = (playerId) => (sensors && typeof sensors.securityStatus === "function"
    ? call(sensors.securityStatus, playerId) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  let invaders = null;
  let invadersAt = null;
  const invaderFactions = (nowMs) => {
    const maxAge = o.S && Number.isSafeInteger(o.S.calloutInvaderCacheMs) ? o.S.calloutInvaderCacheMs : 0;
    if (invaders && Number.isSafeInteger(invadersAt) && nowMs - invadersAt < maxAge) return invaders;
    const r = invasionsOpen(o.S && Number.isSafeInteger(o.S.calloutScanMax) ? o.S.calloutScanMax : 1);
    if (!r || !r.ok) return null;
    invaders = new Set(r.invasions.map((i) => i.factionId).filter((id) => Number.isSafeInteger(id) && id > 0));
    invadersAt = nowMs;
    return invaders;
  };
  const inboundFleets = (systemId, nowMs) => {
    const m = call(o.getMaterialization);
    if (!m || typeof m.inboundFleets !== "function") return fail("SEAM_UNAVAILABLE");
    const max = o.S && Number.isSafeInteger(o.S.calloutInboundMax) ? o.S.calloutInboundMax : 1;
    const hint = call(() => m.inboundFleets(systemId, nowMs, max));
    if (!hint || hint.ok !== true || !Array.isArray(hint.fleets)) return fail((hint && hint.reason) || "SEAM_UNAVAILABLE");
    if (hint.fleets.length === 0) return { ok: true, fleets: [] };
    const fleets = call(o.getFleets);
    const repo = fleets && fleets.repository;
    const store = call(o.getStore);
    if (!repo || typeof repo.getFleets !== "function" || !store || typeof store.transaction !== "function") {
      return fail("FLEETS_UNAVAILABLE");
    }
    const res = store.transaction("shipAi.tools.inbound", (tx) => repo.getFleets(tx, hint.fleets.map((f) => f.fleetId)));
    if (!res || !res.ok) return fail((res && res.reason) || "FLEETS_UNAVAILABLE");
    const got = res.value;
    if (!got || got.ok !== true || !Array.isArray(got.fleets)) return fail((got && got.reason) || "FLEETS_UNAVAILABLE");
    const rowOf = new Map(got.fleets.map((f) => [f.fleetId, f]));
    const out = [];
    for (const h of hint.fleets) {
      const row = rowOf.get(h.fleetId);
      if (!row || row.state !== "TRAVELLING" || row.legSeq !== h.legSeq || !Number.isSafeInteger(row.factionId)
        || row.factionId <= 0 || !Number.isSafeInteger(row.shipCount) || row.shipCount <= 0) continue;
      out.push({ fleetId: h.fleetId, factionId: row.factionId, ships: row.shipCount, etaMs: h.etaMs });
    }
    return { ok: true, fleets: out };
  };
  const dscan = (playerId, opts) => (sensors && typeof sensors.dscan === "function"
    ? call(sensors.dscan, playerId, opts) || fail("SEAM_UNAVAILABLE") : fail("SEAM_UNAVAILABLE"));
  const classByType = new Map();
  const typeClass = (typeId) => {
    if (!Number.isSafeInteger(typeId) || typeId <= 0) return null;
    if (classByType.has(typeId)) return classByType.get(typeId);
    if (classByType.size >= TYPE_CLASS_CACHE_MAX) classByType.clear();
    const name = typeName(typeId);
    const r = name ? itemByName(name) : null;
    const key = r && r.ok && r.found && r.item ? classKeyOf(r.item.groupName) : null;
    classByType.set(typeId, key);
    return key;
  };
  const contactStandings = (playerId, ids) => {
    const s = call(bound("personalContactsSeams"));
    if (!s || !s.ok || !s.seam || typeof s.seam.read !== "function") return fail((s && s.reason) || "SEAM_UNAVAILABLE");
    const r = call(() => s.seam.read(playerId, ids));
    if (!r || !r.ok || !(r.rows instanceof Map)) return fail((r && r.reason) || "SEAM_UNAVAILABLE");
    const standings = new Map();
    for (const [id, row] of r.rows) {
      if (row && Number.isFinite(row.relationshipId)) standings.set(id, row.relationshipId);
    }
    return { ok: true, standings };
  };
  const typeNames = (typeIds) => {
    const r = typeIds.length > 0 ? call(bound("readItemTypeFacts"), typeIds) : null;
    const out = new Map();
    if (r && r.ok && r.facts instanceof Map) {
      for (const [id, f] of r.facts) if (f && f.name) out.set(id, f.name);
    }
    return out;
  };
  const stationNames = (stationIds) => {
    const ids = [...new Set(stationIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (ids.length === 0) return { ok: true, names: new Map() };
    const r = call(bound("readNpcStations"), ids);
    if (!r || !r.ok || !(r.stations instanceof Map)) return fail((r && r.reason) || "SEAM_UNAVAILABLE");
    const names = new Map();
    for (const [id, s] of r.stations) if (s && s.name) names.set(id, s.name);
    return { ok: true, names };
  };

  const abyssalRuns = (now) => {
    const ab = call(o.getAbyssal);
    if (!ab || typeof ab.listActive !== "function" || typeof ab.listFinished !== "function") {
      return fail("ABYSSAL_UNAVAILABLE");
    }
    const M = o.S || {};
    const at = Number.isSafeInteger(now) ? now : 0;
    const lookback = Number.isSafeInteger(M.abyssalFinishedLookbackMs) ? M.abyssalFinishedLookbackMs : 0;
    const limit = Number.isSafeInteger(M.abyssalFinishedLimit) && M.abyssalFinishedLimit > 0
      ? M.abyssalFinishedLimit : 1;
    const active = call(() => ab.listActive());
    if (!active || active.ok !== true || !Array.isArray(active.runs)) {
      return fail((active && active.reason) || "ABYSSAL_READ_FAILED");
    }
    const finished = call(() => ab.listFinished({ sinceMs: Math.max(-1, at - lookback), limit, newest: true }));
    if (!finished || finished.ok !== true || !Array.isArray(finished.runs)) {
      return fail((finished && finished.reason) || "ABYSSAL_READ_FAILED");
    }
    const copy = (r) => Object.freeze({ instanceId: r.instanceId, activatedAtMs: r.activatedAtMs,
      ownerCharacterId: r.ownerCharacterId, tier: r.tier, weather: r.weather,
      participants: Object.freeze((Array.isArray(r.participants) ? r.participants : [])
        .map((p) => Object.freeze({ characterId: p && p.characterId }))),
      pocketsCompleted: r.pocketsCompleted, expiresAtMs: r.expiresAtMs, state: r.state,
      vendorOutcome: r.vendorOutcome });
    return { ok: true, runs: [...active.runs, ...finished.runs].filter((r) => r && typeof r === "object").map(copy) };
  };

  return Object.freeze({ presence, graph, telemetry, typeName, stations, fleetsIn, localNpcs, pirates: piratesOf,
    standing, factionName, controlState, systems, prices, wallet, itemByName, itemSearch, skills, recentEvents, cargo, fitting, pilot,
    assets, findItem, walletHistory, skillQueue, standings, killmails, missions, industryJobs, marketOrders, typeNames,
    stationNames, battlesIn, invasionsOpen, gridNpcs, invaderFactions, inboundFleets, dscan, typeClass,
    contactStandings, wingCopies, wingHpMarks, wingLoaded, crimeFlags, securityStatus, hereIn, abyssalRuns });
}

const DB_METHODS = Object.freeze(["cargo", "fitting", "pilot", "assets", "findItem", "walletHistory", "skillQueue",
  "standings", "killmails", "missions", "industryJobs", "marketOrders"]);

module.exports = { createToolDeps, DB_METHODS };
