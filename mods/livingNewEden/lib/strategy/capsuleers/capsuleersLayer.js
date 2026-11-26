"use strict";

const { performance } = require("node:perf_hooks");
const { positionAt } = require("../../fleets/travel");
const { crewSummaryIn, pilotsLine } = require("../../fleets/crewSummary");
const { OPEN_TRIP_STATES, MERC_TRIP_KIND, SALVAGE_TRIP_KIND } = require("./schema");
const { OPEN_CONTRACT_STATES } = require("./contractRules");
const { LIVE_FLEET_STATES } = require("./capsuleerService");
const { CAPSULEER_FACTION_ID } = require("../data/capsuleers");

const LAYER_ID = "layer-capsuleers";
const LAYER_ORDER = 9;
const LAYER_TITLE = "Wolni piloci";
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyCapsuleersMs";
const MS_DECIMALS = 10;
const SHAPE = "pip";
const RAT_TRIP_KIND = "rat";
const HOME_TRIP_KIND = "home";
const ENGAGED_STATE = "ENGAGED";
const TRAVEL_STATES = Object.freeze(["TRAVELLING", "RETREATING", "PLANNED"]);
const ACTIVITY_STYLES = Object.freeze([
  Object.freeze({ styleId: "combat", label: "mercenary / in combat", colour: "#ff6ad5" }),
  Object.freeze({ styleId: "ratting", label: "ratting", colour: "#ffd84a" }),
  Object.freeze({ styleId: "salvage", label: "salvaging", colour: "#7fdcff" }),
  Object.freeze({ styleId: "travel", label: "travelling", colour: "#c9c9c9" }),
  Object.freeze({ styleId: "base", label: "at base / idle", colour: "#6fd39a" }),
]);
const STYLE_RANK = new Map(ACTIVITY_STYLES.map((s, i) => [s.styleId, i]));
const LEGEND = Object.freeze(ACTIVITY_STYLES.map((s) => Object.freeze([s.styleId, s.label, s.colour, SHAPE])));
const CIVILIAN_STYLE = "civilian";
const CIVILIAN_LEGEND = Object.freeze([CIVILIAN_STYLE, "highsec civilians", "#9fb3c8", SHAPE]);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

const isOpenTrip = (t) => Boolean(t && OPEN_TRIP_STATES.includes(t.state));
const isOpenContract = (c) => Boolean(c && OPEN_CONTRACT_STATES.includes(c.state));
const towards = (what, systemId) => (systemId === null || systemId === undefined ? what : `${what} -> ${systemId}`);

function activityOf(fleet, trip, contract) {
  const state = fleet && typeof fleet.state === "string" ? fleet.state : "?";
  const t = isOpenTrip(trip) ? trip : null;
  if (isOpenContract(contract)) return { style: "combat", text: `contract ${contract.state}` };
  if (t && t.kind === MERC_TRIP_KIND) return { style: "combat", text: towards("merc", t.targetSystemId) };
  if (state === ENGAGED_STATE) return { style: "combat", text: ENGAGED_STATE };
  if (t && t.kind === RAT_TRIP_KIND) return { style: "ratting", text: towards("ratting", t.targetSystemId) };
  if (t && t.kind === SALVAGE_TRIP_KIND) return { style: "salvage", text: towards("salvage", t.targetSystemId) };
  if (t && t.kind === HOME_TRIP_KIND) return { style: "travel", text: towards("home", t.targetSystemId) };
  if (TRAVEL_STATES.includes(state)) return { style: "travel", text: state };
  return { style: "base", text: state };
}

function compositionText(fleet) {
  const counts = new Map();
  for (const e of Array.isArray(fleet.composition) ? fleet.composition : []) {
    if (!e) continue;
    const group = String(e.hullGroup || "ship");
    counts.set(group, (counts.get(group) || 0) + (Number(e.count) || 0));
  }
  if (counts.size === 0) return `${fleet.shipCount}x ship`;
  return [...counts].map(([g, n]) => `${n}x ${g}`).join(", ");
}

function aggregate(input) {
  const corpById = new Map();
  for (const c of input.corps || []) if (c && c.corporationId !== null && c.corporationId !== undefined) {
    corpById.set(c.corporationId, c);
  }
  const tripByFleet = new Map();
  for (const t of input.trips || []) if (isOpenTrip(t)) tripByFleet.set(t.fleetId, t);
  const contractByFleet = new Map();
  for (const c of input.contracts || []) if (isOpenContract(c)) contractByFleet.set(c.fleetId, c);
  const crews = input.crews || null;
  const bySystem = new Map();
  let pilotsTotal = 0;
  for (const f of input.fleets) {
    const pos = positionAt(f, input.now);
    const systemId = pos.systemId;
    if (!Number.isSafeInteger(systemId) || systemId <= 0) continue;
    const crew = crews ? crews.get(f.fleetId) : null;
    const pilots = crew && Number(crew.seated) > 0 ? Number(crew.seated) : (Number(f.shipCount) || 0);
    const act = activityOf(f, tripByFleet.get(f.fleetId), contractByFleet.get(f.fleetId));
    let sys = bySystem.get(systemId);
    if (!sys) {
      sys = { systemId, pilots: 0, fleets: [] };
      bySystem.set(systemId, sys);
    }
    sys.pilots += pilots;
    sys.fleets.push({ fleet: f, act, rank: STYLE_RANK.get(act.style) });
    pilotsTotal += pilots;
  }
  const maxLines = input.maxLines;
  const built = [...bySystem.values()].sort((a, b) => b.pilots - a.pilots || a.systemId - b.systemId);
  const items = built.map((sys) => {
    sys.fleets.sort((a, b) => a.rank - b.rank || (a.fleet.fleetId < b.fleet.fleetId ? -1
      : a.fleet.fleetId > b.fleet.fleetId ? 1 : 0));
    const lines = [`${sys.pilots} pilots · ${sys.fleets.length} fleets`];
    for (const entry of sys.fleets.slice(0, maxLines)) {
      const f = entry.fleet;
      const corp = corpById.get(f.corporationId);
      const who = corp ? `${corp.name} [${corp.ticker}]` : `corp ${f.corporationId}`;
      lines.push(`${who} · ${compositionText(f)} · ${entry.act.text}`);
      const pl = pilotsLine(crews, f.fleetId);
      if (pl !== null) lines.push(pl);
    }
    const more = sys.fleets.length - Math.min(maxLines, sys.fleets.length);
    if (more > 0) lines.push(`+${more} more`);
    return [sys.systemId, sys.fleets[0].act.style, String(sys.pilots), lines, null];
  });
  return { items, pilots: pilotsTotal, systems: built.length };
}

function civilianLine(entry) {
  const names = Array.isArray(entry.names) ? entry.names : [];
  if (names.length === 0) return `${entry.count} civilians`;
  const more = entry.count - names.length;
  return `${entry.count} civilians: ${names.join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

function mergeCivilians(items, roster) {
  const out = (Array.isArray(items) ? items : []).map((it) => [it[0], it[1], it[2], [...it[3]], it[4]]);
  const at = new Map(out.map((it, i) => [it[0], i]));
  let civilians = 0;
  let systems = 0;
  for (const entry of Array.isArray(roster) ? roster : []) {
    if (!entry || !Number.isSafeInteger(entry.systemId) || !Number.isSafeInteger(entry.count) || entry.count <= 0) {
      continue;
    }
    civilians += entry.count;
    systems += 1;
    const line = civilianLine(entry);
    const i = at.get(entry.systemId);
    if (i !== undefined) {
      const it = out[i];
      it[2] = String(Number(it[2]) + entry.count);
      it[3].push(line);
      continue;
    }
    const lines = [`${entry.count} civilians`];
    if (Array.isArray(entry.names) && entry.names.length > 0) lines.push(line);
    at.set(entry.systemId, out.length);
    out.push([entry.systemId, CIVILIAN_STYLE, String(entry.count), lines, null]);
  }
  out.sort((a, b) => Number(b[2]) - Number(a[2]) || a[0] - b[0]);
  return { items: out, civilians, systems };
}

function mergeFreeCorps(items, marks) {
  const out = (Array.isArray(items) ? items : []).map((it) => [it[0], it[1], it[2], [...it[3]], it[4]]);
  const at = new Map(out.map((it, i) => [it[0], i]));
  let pilots = 0;
  let systems = 0;
  for (const m of Array.isArray(marks) ? marks : []) {
    if (!m || !Number.isSafeInteger(m.systemId) || !Number.isSafeInteger(m.pilots) || m.pilots <= 0
      || typeof m.style !== "string") continue;
    const lines = Array.isArray(m.lines) ? m.lines.map(String) : [];
    pilots += m.pilots;
    systems += 1;
    const i = at.get(m.systemId);
    if (i !== undefined) {
      const it = out[i];
      it[2] = String(Number(it[2]) + m.pilots);
      it[3].push(...lines);
      continue;
    }
    at.set(m.systemId, out.length);
    out.push([m.systemId, m.style, String(m.pilots), lines, null]);
  }
  out.sort((a, b) => Number(b[2]) - Number(a[2]) || a[0] - b[0]);
  return { items: out, pilots, systems };
}

function buildCapsuleersLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxFleets = int(deps.maxFleets, 0);
  const maxLines = int(deps.maxLines, 0);
  const refreshMs = int(deps.refreshMs, 1);
  const civilianNames = int(deps.civilianNames, 0);
  const list = (fn) => {
    try {
      const v = typeof fn === "function" ? fn() : [];
      return Array.isArray(v) ? v : [];
    } catch (_err) {
      return [];
    }
  };

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_BUILD_MS, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  function civilianRosterOf() {
    if (typeof deps.getHighsecLife !== "function") return null;
    try {
      const hs = deps.getHighsecLife();
      if (!hs || typeof hs.listCivilianRoster !== "function") return null;
      const r = hs.listCivilianRoster({ maxNames: civilianNames });
      return r && r.ok === true && Array.isArray(r.systems) ? r.systems : null;
    } catch (_err) {
      return null;
    }
  }

  function freeCorpsMarksOf() {
    if (typeof deps.getFreeCorps !== "function") return null;
    try {
      const fc = deps.getFreeCorps();
      if (!fc || typeof fc.listMapMarks !== "function") return null;
      const r = fc.listMapMarks({ maxLines });
      return r && r.ok === true && Array.isArray(r.marks) && Array.isArray(r.legend) ? r : null;
    } catch (_err) {
      return null;
    }
  }

  function withFreeCorps(answer) {
    const fc = freeCorpsMarksOf();
    if (fc === null) return answer;
    const merged = mergeFreeCorps(answer.items, fc.marks);
    const legend = [...answer.legend, ...fc.legend.map((l) => [String(l[0]), String(l[1]), String(l[2]), SHAPE])];
    return { ...answer, legend, items: merged.items,
      note: `${answer.note} · ${merged.pilots} free corp pilots in ${merged.systems} systems`
        + (fc.truncated === true ? " (truncated)" : "") };
  }

  const keyAt = (now) => `c${Math.floor(now / refreshMs)}`;
  const noteOf = (pilots, systems, fleets, truncated) => `${pilots} pilots in ${systems} systems (${fleets} fleets)`
    + (truncated ? " (truncated)" : "");

  function collect(tx) {
    const fleets = [];
    let after = "";
    for (;;) {
      const remaining = maxFleets - fleets.length;
      if (remaining <= 0) {
        const more = repository.listFleetsByFaction(tx, CAPSULEER_FACTION_ID, { states: LIVE_FLEET_STATES,
          limit: 1, afterFleetId: after });
        if (!more.ok) return more;
        return { ok: true, fleets, truncated: more.fleets.length > 0 };
      }
      const page = repository.listFleetsByFaction(tx, CAPSULEER_FACTION_ID, { states: LIVE_FLEET_STATES,
        limit: remaining, afterFleetId: after });
      if (!page.ok) return page;
      fleets.push(...page.fleets);
      if (page.nextAfterFleetId === null) return { ok: true, fleets, truncated: false };
      after = page.nextAfterFleetId;
    }
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxFleets === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: `${noteOf(0, 0, 0, false)} (layer limit 0)` };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyCapsuleers", (db) => {
      const r = collect(db);
      return r.ok ? { ...r, crews: crewSummaryIn(deps.getCrewSummary, db, r.fleets.map((f) => f.fleetId)) } : r;
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const agg = aggregate({ fleets: read.fleets, now, corps: list(deps.listCorps), trips: list(deps.listTrips),
      contracts: list(deps.listContracts), crews: read.crews, maxLines });
    const note = noteOf(agg.pilots, agg.systems, read.fleets.length, read.truncated);
    const roster = civilianRosterOf();
    if (roster === null) {
      const out = withFreeCorps({ available: true, key: keyAt(now), legend, items: agg.items, note });
      observe(nowMs() - t0);
      return out;
    }
    const merged = mergeCivilians(agg.items, roster);
    const out = withFreeCorps({ available: true, key: keyAt(now), legend: [...legend, [...CIVILIAN_LEGEND]],
      items: merged.items, note: `${note} · ${merged.civilians} civilians in ${merged.systems} systems` });
    observe(nowMs() - t0);
    return out;
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: LAYER_TITLE, listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, LEGEND, ACTIVITY_STYLES, activityOf, aggregate, mergeCivilians, mergeFreeCorps,
  buildCapsuleersLayerView };
