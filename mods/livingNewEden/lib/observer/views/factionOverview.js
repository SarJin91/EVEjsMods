"use strict";

const { CAPSULEER_FACTION_ID } = require("../../strategy/data/capsuleers");
const { netOf } = require("../../economy/treasury/treasuryService");

const VIEW_ID = "faction-overview";
const SOURCE_IDS = Object.freeze(["factions", "activity", "faction-fleets", "trade", "production", "mining",
  "stations", "logistics", "control", "invasions"]);
const WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.factionOverviewMs";
const COUNTER_SOURCE_ERRORS = "observer.factionOverviewSourceErrors";
const MS_DECIMALS = 10;
const MAX_ERROR_MESSAGE_CHARS = 200;
const NOTE_CATEGORY_ORDER = Object.freeze(["blokada", "oczekiwane", "informacja"]);
const LINES_RE = /^(\d+)\/(\d+)$/;
const ROLE = Object.freeze({ AI: "ai", INVADER: "invader", HIVE: "hive", CAPSULEERS: "capsuleers", SDE_ONLY: "sde-only" });
const KIND_ROLE = Object.freeze({ invader: ROLE.INVADER, hive: ROLE.HIVE });
const INVASION_ACTIVE = "ACTIVE";
const INVASION_WITHDRAWING = "WITHDRAWING";
const MS_MIN = 60000;
const MS_H = 3600000;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const arr = (v) => (Array.isArray(v) ? v : []);
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const orNull = (v) => (v === undefined ? null : v);

function isThenable(v) {
  return v !== null && (typeof v === "object" || typeof v === "function") && typeof v.then === "function";
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_ERROR_MESSAGE_CHARS);
}

function round(ms) {
  return Math.round(ms * MS_DECIMALS) / MS_DECIMALS;
}

function pick(obj, keys) {
  if (!isObject(obj)) return null;
  const out = {};
  for (const k of keys) out[k] = orNull(obj[k]);
  return out;
}

function buildNameIndex(factionsRows, factionNames) {
  const index = new Map();
  const add = (id, name) => {
    if (!Number.isSafeInteger(id) || typeof name !== "string" || name === "") return;
    if (!index.has(name)) index.set(name, id);
    else if (index.get(name) !== id) index.set(name, null);
  };
  for (const row of arr(factionsRows)) if (row) add(row.factionId, row.name);
  if (factionNames instanceof Map) for (const [id, name] of factionNames) add(id, name);
  return index;
}

function idOf(faction, nameIndex) {
  if (Number.isSafeInteger(faction) && faction > 0) return faction;
  if (typeof faction !== "string" || !(nameIndex instanceof Map)) return null;
  const id = nameIndex.get(faction);
  return Number.isSafeInteger(id) ? id : null;
}

function noteRank(note) {
  const i = NOTE_CATEGORY_ORDER.indexOf(note && note.category);
  return i === -1 ? NOTE_CATEGORY_ORDER.length : i;
}

function sortNotes(notes, maxNotes) {
  const all = arr(notes).filter(isObject).map((n, i) => ({ n, i, r: noteRank(n) }));
  all.sort((a, b) => a.r - b.r || a.i - b.i);
  const kept = all.slice(0, Math.max(0, maxNotes)).map(({ n }) => ({ code: orNull(n.code), arg: orNull(n.arg),
    category: orNull(n.category), text: orNull(n.text) }));
  return { notes: kept, notesTruncated: all.length - kept.length };
}

function sumLines(stations) {
  let used = 0;
  let total = 0;
  for (const s of arr(stations)) {
    const m = s && typeof s.lines === "string" ? LINES_RE.exec(s.lines) : null;
    if (!m) continue;
    used += Number(m[1]);
    total += Number(m[2]);
  }
  return { used, total };
}

const DAY_KEYS = Object.freeze(["income", "fleetUpkeep", "productionFees", "losses", "tradeOut", "tradeIn"]);
const FULL_DAY_KEYS = Object.freeze([...DAY_KEYS, "admin", "warSpend", "mercFees", "mercRefunds"]);

function fullDay(d) {
  if (!isObject(d)) return null;
  return { ...pick(d, FULL_DAY_KEYS), net: numOrNull(netOf(d)) };
}

function treasuryOf(t, full) {
  if (!full) {
    return { mode: orNull(t.mode), balanceIsk: orNull(t.balanceIsk), initialIsk: orNull(t.initialIsk),
      today: pick(t.today, DAY_KEYS), forecast: pick(t.forecast, ["trend", "daysToZero", "daysToAusterity"]) };
  }
  return { mode: orNull(t.mode), balanceIsk: orNull(t.balanceIsk), initialIsk: orNull(t.initialIsk),
    today: fullDay(t.today), yesterday: fullDay(t.yesterday), avg7dNetIsk: numOrNull(t.avg7dNetIsk),
    forecast: pick(t.forecast, ["trend", "daysToZero", "daysToAusterity"]) };
}

function projectFactions(data, ctx) {
  const full = Boolean(ctx && ctx.treasuryFullDay === true);
  const rows = [];
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    rows.push({ factionId: r.factionId, name: typeof r.name === "string" ? r.name : null });
    const t = isObject(r.treasury) ? r.treasury : null;
    const upkeep = isObject(r.upkeep) ? r.upkeep : null;
    const per = upkeep && isObject(upkeep.perPeriod) ? upkeep.perPeriod : null;
    const review = isObject(r.lastReview) ? r.lastReview : null;
    entries.push([r.factionId, {
      name: typeof r.name === "string" ? r.name : null,
      kind: orNull(r.kind), status: orNull(r.status), base: orNull(r.base), doctrine: orNull(r.doctrine),
      campaigns: arr(r.campaigns), corporation: isObject(r.corporation) ? pick(r.corporation, ["id", "name"]) : null,
      treasury: t ? treasuryOf(t, full) : null,
      resources: { units: orNull(r.resources), reserves: orNull(r.reserves),
        unpaidPeriods: upkeep ? orNull(upkeep.unpaidPeriods) : null,
        perPeriod: per ? { ...pick(per, ["income", "cost", "net"]),
          ...pick(per, ["homeIncome", "shipRoom"].filter((k) => per[k] !== undefined)) } : null },
      borderSystems: numOrNull(r.borderSystems),
      fronts: isObject(r.fronts) ? pick(r.fronts, ["count", "limit"]) : null,
      lastReview: review ? pick(review, ["round", "outcome", "target"]) : null,
    }]);
  }
  return { entries, rows };
}

function projectActivity(data, ctx) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    const plans = isObject(r.plans) ? r.plans : null;
    entries.push([r.factionId, {
      name: typeof r.name === "string" ? r.name : null,
      verdict: isObject(r.verdict) ? pick(r.verdict, ["code", "label", "sentence"]) : null,
      ...sortNotes(r.notes, ctx.maxNotes),
      plans: plans ? {
        target: isObject(plans.target) ? pick(plans.target, ["systemId", "name"]) : null,
        decision: arr(plans.decision).filter(isObject).map((d) => pick(d, ["type", "label", "count"])),
        lastReviewAt: orNull(plans.lastReviewAt), nextReviewAt: orNull(plans.nextReviewAt),
      } : null,
      offensive: isObject(r.offensive) ? {
        ...pick(r.offensive, ["stalled", "since", "lastCaptureAt"]),
        idleInvasion: isObject(r.offensive.idleInvasion)
          ? pick(r.offensive.idleInvasion, ["fleets", "ships", "oldestSince", "truncated"]) : null,
      } : null,
      truces: isObject(r.truces) ? {
        status: orNull(r.truces.status),
        items: arr(r.truces.items).filter(isObject).map((t) => pick(t, ["partnerId", "partnerName", "until",
          "initiator"])),
        truncated: r.truces.truncated === true,
      } : null,
    }]);
  }
  return { entries };
}

function projectFactionFleets(data) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    const { factionId, ...rest } = r;
    entries.push([factionId, rest]);
  }
  return { entries };
}

function projectTrade(data) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    entries.push([r.faction, { availableIsk: orNull(r.availableIsk), reservedIsk: orNull(r.reservedIsk),
      capIsk: orNull(r.capIsk), headroomIsk: orNull(r.headroomIsk), fundedTotal: orNull(r.fundedTotal),
      spentTotal: orNull(r.spentTotal), releasedTotal: orNull(r.releasedTotal), lastFundedAt: orNull(r.lastFundedAt),
      openOffers: arr(r.offers).length }]);
  }
  const contracts = [];
  const byFaction = isObject(data.contracts) ? arr(data.contracts.byFaction) : [];
  for (const c of byFaction) {
    if (!isObject(c)) continue;
    contracts.push([c.faction, { open: orNull(c.open), tiers: Array.isArray(c.tiers) ? [...c.tiers] : null,
      cap: orNull(c.cap) }]);
  }
  return { entries, contracts };
}

function projectProduction(data, ctx) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    const jobs = [];
    for (const s of arr(r.stations)) {
      if (!isObject(s)) continue;
      const systemId = Number.isSafeInteger(s.system) ? s.system : null;
      for (const j of arr(s.jobs)) {
        if (!isObject(j)) continue;
        jobs.push({ hullGroup: orNull(j.hullGroup), runs: orNull(j.runs), dueAt: orNull(j.dueAt),
          station: orNull(s.station), systemId, systemName: ctx.systemName(systemId) });
      }
    }
    const due = (j) => (typeof j.dueAt === "number" && Number.isFinite(j.dueAt) ? j.dueAt : Infinity);
    jobs.sort((a, b) => due(a) - due(b));
    const pool = isObject(r.hullPool) ? r.hullPool : null;
    entries.push([r.faction, { lines: sumLines(r.stations), jobsTotal: jobs.length,
      jobs: jobs.slice(0, Math.max(0, ctx.maxJobs)),
      hullPool: pool ? { total: orNull(pool.total), groups: isObject(pool.groups) ? { ...pool.groups } : {} } : null,
      inProduction: isObject(r.inProduction) ? { ...r.inProduction } : {},
      deficit: isObject(r.deficit) ? { ...r.deficit } : {},
      last24h: pick(r.last24h, ["hullsDelivered", "hullsLost"]) }]);
  }
  return { entries };
}

function projectMining(data) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    const stock = isObject(r.mineralStock) ? r.mineralStock : null;
    entries.push([r.faction, { miners: pick(r.miners, ["live", "idle", "onTrip"]),
      last24h: pick(r.last24h, ["delivered", "lost"]),
      mineralStock: stock ? { total: orNull(stock.total),
        minerals: arr(stock.minerals).filter(isObject).map((m) => [orNull(m.mineral), orNull(m.quantity)]) } : null }]);
  }
  return { entries };
}

function projectStations(data, ctx) {
  const byFaction = new Map();
  for (const s of arr(data.stations)) {
    if (!isObject(s)) continue;
    const key = s.faction;
    let agg = byFaction.get(key);
    if (!agg) {
      agg = { total: 0, byKind: {}, byState: {}, list: [], truncated: data.truncated === true };
      byFaction.set(key, agg);
    }
    agg.total += 1;
    const kind = String(s.kind);
    const state = String(s.state);
    agg.byKind[kind] = (agg.byKind[kind] || 0) + 1;
    agg.byState[state] = (agg.byState[state] || 0) + 1;
    if (agg.list.length < Math.max(0, ctx.maxStations)) {
      agg.list.push({ station: orNull(s.station), system: orNull(s.system), kind: orNull(s.kind),
        state: orNull(s.state) });
    } else agg.truncated = true;
  }
  return { entries: [...byFaction] };
}

function projectLogistics(data) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!isObject(r)) continue;
    entries.push([r.faction, { open: arr(r.open).length, last24h: pick(r.last24h, ["delivered", "lost"]),
      totals: pick(r.totals, ["delivered", "lost"]) }]);
  }
  return { entries };
}

function projectControl(data) {
  const entries = [];
  for (const r of arr(data.factions)) {
    if (!Array.isArray(r)) continue;
    entries.push([r[0], { controlledSystems: numOrNull(r[2]) }]);
  }
  return { entries };
}

function projectInvasions(data) {
  const byKey = new Map();
  for (const r of arr(data.open)) {
    if (!isObject(r)) continue;
    let list = byKey.get(r.faction);
    if (!list) {
      list = [];
      byKey.set(r.faction, list);
    }
    const at = typeof r.withdrawAt === "string" ? Date.parse(r.withdrawAt) : NaN;
    list.push({ state: orNull(r.state), system: orNull(r.system), withdrawAt: Number.isFinite(at) ? at : null });
  }
  return { entries: [...byKey].map(([k, open]) => [k, { open }]), rollIntervalMs: numOrNull(data.rollIntervalMs) };
}

function roleOf(id, f, factionsUp) {
  if (id === CAPSULEER_FACTION_ID) return ROLE.CAPSULEERS;
  if (!factionsUp) return null;
  if (!f) return ROLE.SDE_ONLY;
  return Object.prototype.hasOwnProperty.call(KIND_ROLE, f.kind) ? KIND_ROLE[f.kind] : ROLE.AI;
}

function spanText(ms) {
  const m = Math.max(0, Math.floor(ms / MS_MIN));
  const h = Math.floor(m / (MS_H / MS_MIN));
  return h > 0 ? `${h} h ${m % (MS_H / MS_MIN)} min` : `${m} min`;
}

function invaderVerdict(inv, meta, now) {
  if (!meta || meta.available !== true) return null;
  const open = inv ? arr(inv.open) : [];
  const active = open.filter((o) => o.state === INVASION_ACTIVE);
  if (active.length) {
    const parts = active.map((o) => `${o.system === null ? "?" : o.system}`
      + (Number.isFinite(o.withdrawAt) ? `, withdrawal in ${spanText(o.withdrawAt - now)}` : ""));
    return { code: "WORKING", label: "invasion", sentence: `invasion active: ${parts.join("; ")}` };
  }
  const leaving = open.filter((o) => o.state === INVASION_WITHDRAWING);
  if (leaving.length) {
    return { code: "WORKING", label: "withdrawing",
      sentence: `invasion withdrawing: ${leaving.map((o) => (o.system === null ? "?" : o.system)).join(", ")}` };
  }
  const roll = Number.isFinite(meta.rollIntervalMs) && meta.rollIntervalMs > 0
    ? `, next roll every ${spanText(meta.rollIntervalMs).replace(/ 0 min$/, "")}` : "";
  return { code: "WAITING", label: "no invasion", sentence: `no invasion${roll}` };
}

const PROJECT = Object.freeze({
  factions: projectFactions,
  activity: projectActivity,
  "faction-fleets": projectFactionFleets,
  trade: projectTrade,
  production: projectProduction,
  mining: projectMining,
  stations: projectStations,
  logistics: projectLogistics,
  control: projectControl,
  invasions: projectInvasions,
});

function joinEntries(entries, nameIndex) {
  const byId = new Map();
  let unmatched = 0;
  for (const [faction, payload] of arr(entries)) {
    const id = idOf(faction, nameIndex);
    if (id === null) unmatched += 1;
    else if (!byId.has(id)) byId.set(id, payload);
  }
  return { byId, unmatched };
}

function buildFactionOverviewView(deps) {
  const views = deps.views;
  const clock = deps.clock;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const s = deps.settings || {};
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const refreshMs = int(s.refreshMs, 1);
  const maxFactions = int(s.maxFactions, 0);
  const ctx = Object.freeze({ maxNotes: int(s.maxNotes, 0), maxJobs: int(s.maxJobs, 0),
    maxStations: int(s.maxStations, 0), treasuryFullDay: s.treasuryFullDay === true, systemName });
  const memo = new Map();

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function tele(method, name, value) {
    if (!telemetry || typeof telemetry[method] !== "function") return;
    try {
      telemetry[method](name, value);
    } catch (_err) {
    }
  }

  function systemName(id) {
    if (!Number.isSafeInteger(id)) return null;
    try {
      const graph = deps.graph;
      const res = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
      return vertex && typeof vertex.name === "string" ? vertex.name : null;
    } catch (_err) {
      return null;
    }
  }

  const unavailable = (reason, extra) => ({ available: false, reason, cached: false, projection: null, ...extra });

  function readSource(id, req) {
    let view;
    try {
      view = views && typeof views.getView === "function" ? views.getView(id) : null;
    } catch (err) {
      tele("count", COUNTER_SOURCE_ERRORS, 1);
      return unavailable("SOURCE_FAILED", { message: messageOf(err) });
    }
    if (!view || typeof view.getData !== "function") {
      memo.delete(id);
      return unavailable("VIEW_MISSING");
    }
    try {
      const k = typeof view.cacheKey === "function" ? view.cacheKey(req) : null;
      const key = k === undefined ? null : k;
      const hit = memo.get(id);
      if (key !== null && hit && hit.key === key && hit.getData === view.getData) {
        return { available: true, reason: null, cached: true, projection: hit.projection, builtAtMs: hit.builtAtMs,
          buildMs: hit.buildMs };
      }
      const t0 = nowMs();
      const data = view.getData(req);
      if (isThenable(data)) {
        try {
          data.then(undefined, () => {});
        } catch (_err) {
        }
        return unavailable("SOURCE_ASYNC");
      }
      if (!isObject(data)) return unavailable("SOURCE_INVALID");
      if (data.available === false) return unavailable(typeof data.reason === "string" ? data.reason : "UNAVAILABLE");
      const projection = PROJECT[id](data, ctx);
      const buildMs = round(nowMs() - t0);
      const builtAtMs = req && Number.isFinite(req.nowMs) ? req.nowMs : clock.now();
      memo.set(id, { key, getData: view.getData, projection, builtAtMs, buildMs });
      return { available: true, reason: null, cached: false, projection, builtAtMs, buildMs };
    } catch (err) {
      tele("count", COUNTER_SOURCE_ERRORS, 1);
      return unavailable("SOURCE_FAILED", { message: messageOf(err) });
    }
  }

  function card(id, j) {
    const f = j.factions.get(id) || null;
    const a = j.activity.get(id) || null;
    const st = j.stations.get(id) || null;
    const c = j.control.get(id) || null;
    const tradeRow = j.trade.get(id) || null;
    const contracts = j.contracts.get(id) || null;
    const name = (f && f.name) || factionNames.get(id) || (a && a.name) || null;
    const role = roleOf(id, f, j.meta.factionsUp);
    const invasion = role === ROLE.INVADER ? j.invasions.get(id) || null : null;
    const invVerdict = role === ROLE.INVADER ? invaderVerdict(invasion, j.meta.invasions, j.meta.now) : null;
    return {
      factionId: id, name, role,
      kind: f ? f.kind : null, status: f ? f.status : null, base: f ? f.base : null,
      doctrine: f ? f.doctrine : null, campaigns: f ? f.campaigns : [], corporation: f ? f.corporation : null,
      verdict: invVerdict || (a ? a.verdict : null),
      invasion,
      isk: {
        treasury: f && role !== ROLE.HIVE ? f.treasury : null,
        trade: tradeRow ? { ...tradeRow, contracts } : null,
        resources: f ? f.resources : null,
      },
      fleets: j["faction-fleets"].get(id) || null,
      production: j.production.get(id) || null,
      mining: j.mining.get(id) || null,
      logistics: j.logistics.get(id) || null,
      territory: {
        controlledSystems: c ? c.controlledSystems : null,
        borderSystems: f ? f.borderSystems : null,
        fronts: f ? f.fronts : null,
        stations: st,
      },
      strategy: {
        lastReview: f ? f.lastReview : null,
        plans: a ? a.plans : null,
        notes: a ? a.notes : [],
        notesTruncated: a ? a.notesTruncated : 0,
        offensive: a ? a.offensive : null,
        truces: a ? a.truces : null,
      },
    };
  }

  function getData(req) {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const t0 = nowMs();
    const reqNow = req && Number.isFinite(req.nowMs) ? req.nowMs : clock.now();
    const read = {};
    for (const id of SOURCE_IDS) read[id] = readSource(id, req);
    const factionsRows = read.factions.available ? read.factions.projection.rows : [];
    const nameIndex = buildNameIndex(factionsRows, factionNames);
    const joined = {};
    const sources = {};
    for (const id of SOURCE_IDS) {
      const r = read[id];
      let unmatched = 0;
      if (r.available) {
        const main = joinEntries(r.projection.entries, nameIndex);
        joined[id] = main.byId;
        unmatched += main.unmatched;
        if (id === "trade") {
          const con = joinEntries(r.projection.contracts, nameIndex);
          joined.contracts = con.byId;
          unmatched += con.unmatched;
        }
      } else {
        joined[id] = new Map();
        if (id === "trade") joined.contracts = new Map();
      }
      sources[id] = { available: r.available, reason: r.reason, cached: r.cached,
        ageMs: r.available ? Math.max(0, reqNow - r.builtAtMs) : null, buildMs: r.available ? r.buildMs : null,
        unmatched, ...(r.message !== undefined ? { message: r.message } : {}) };
    }
    const order = [];
    const seen = new Set();
    for (const row of factionsRows) {
      const id = idOf(row.factionId, nameIndex);
      if (id !== null && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
    const rest = new Set();
    for (const id of SOURCE_IDS) for (const fid of joined[id].keys()) if (!seen.has(fid)) rest.add(fid);
    for (const fid of joined.contracts.keys()) if (!seen.has(fid)) rest.add(fid);
    order.push(...[...rest].sort((a, b) => a - b));
    const kept = order.slice(0, maxFactions);
    joined.meta = { factionsUp: read.factions.available === true, now: reqNow,
      invasions: { available: read.invasions.available === true,
        rollIntervalMs: read.invasions.available ? read.invasions.projection.rollIntervalMs : null } };
    const factions = kept.map((id) => card(id, joined));
    tele("observe", METRIC_BUILD_MS, round(nowMs() - t0));
    return { available: true, generatedAt: clock.now(), refreshMs, sources, factionsTruncated: order.length - kept.length,
      factions };
  }

  function cacheKey() {
    if (!admitted()) return null;
    return `fo${Math.floor(clock.now() / refreshMs)}`;
  }

  return { title: "Factions — overview", cacheKey, getData };
}

module.exports = { VIEW_ID, SOURCE_IDS, PROJECT, ROLE, buildFactionOverviewView, buildNameIndex, idOf, sortNotes, sumLines,
  roleOf, invaderVerdict };
