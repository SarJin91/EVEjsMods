"use strict";

const defaultRepository = require("./eventRepository");
const { STATE, OPEN_STATES } = require("./eventMachine");

const LAYER_ID = "layer-events";
const LAYER_ORDER = 19;
const LAYER_FORMAT = 1;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyEventsMs";
const MS_DECIMALS = 10;
const SHAPE = "ring";
const SCALE = 1.8;

const EVENT_STYLES = Object.freeze([
  Object.freeze({ styleId: "events-active", state: STATE.ACTIVE, label: "event active (sites in space)",
    colour: "#ff5ad1" }),
  Object.freeze({ styleId: "events-completing", state: STATE.COMPLETING, label: "event completing (sites cleared)",
    colour: "#e0b0ff" }),
  Object.freeze({ styleId: "events-planned", state: STATE.PLANNED, label: "event planned (waiting)",
    colour: "#8c96a8" }),
]);
const LEGEND = Object.freeze(EVENT_STYLES.map((s) => Object.freeze([s.styleId, s.label, s.colour, SHAPE, SCALE])));
const PRIORITY = new Map(EVENT_STYLES.map((s, i) => [s.state, i]));

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function byPriority(a, b) {
  return PRIORITY.get(a.state) - PRIORITY.get(b.state) || a.dueAt - b.dueAt || cmpStr(String(a.eventId),
    String(b.eventId));
}

function buildEventsLayerView(deps) {
  const { store, clock } = deps;
  const repository = deps.repository || defaultRepository;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getPulseMark = typeof deps.getPulseMark === "function" ? deps.getPulseMark : () => 0;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxEvents = int(deps.maxEvents, 1);
  const maxSystems = int(deps.maxSystems, 0);
  const refreshMs = int(deps.refreshMs, 1);
  const presenceActivation = deps.presenceActivation === true;

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

  function pulseMark() {
    try {
      const m = Number(getPulseMark());
      return Number.isFinite(m) ? m : 0;
    } catch (_err) {
      return 0;
    }
  }

  const keyAt = (now) => `e${LAYER_FORMAT}:${Math.floor(now / refreshMs)}:${pulseMark()}`;

  function triggerOf(e) {
    const a = e.result && typeof e.result === "object" ? e.result.activation : null;
    if (a && typeof a === "object" && typeof a.trigger === "string" && Number.isSafeInteger(a.distance)
      && a.distance >= 0) {
      return `${a.trigger} (d=${a.distance})`;
    }
    if (e.state === STATE.PLANNED) return presenceActivation ? "waiting for a player" : "waiting for due time";
    return "due";
  }

  function eventLine(e) {
    if (e.corrupt === true) return `${String(e.eventId)} · corrupt row · ${String(e.state)}`;
    return `${String(e.label)} · ${String(e.eventType)} · faction ${String(e.factionId)} · cause ${String(e.cause)} · `
      + `${String(e.state)} · trigger ${triggerOf(e)} · sites ${String(e.sitesCreated)}/${String(e.spawnBudget)}`;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 events (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyEvents", (db) => repository.listOpen(db, { limit: maxEvents }));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const bySystem = new Map();
    let events = 0;
    for (const e of read.events) {
      if (!e || !OPEN_STATES.includes(e.state)) continue;
      events += 1;
      let list = bySystem.get(e.systemId);
      if (!list) {
        list = [];
        bySystem.set(e.systemId, list);
      }
      list.push(e);
    }
    const built = [];
    for (const [systemId, list] of bySystem) {
      list.sort(byPriority);
      built.push({ systemId, top: list[0], list });
    }
    built.sort((a, b) => PRIORITY.get(a.top.state) - PRIORITY.get(b.top.state) || a.top.dueAt - b.top.dueAt
      || a.systemId - b.systemId);
    const items = built.slice(0, maxSystems).map((s) => {
      const style = EVENT_STYLES[PRIORITY.get(s.top.state)];
      const n = s.list.length;
      const label = n > 1 ? `${String(s.top.label)} +${n - 1}` : String(s.top.label);
      return [s.systemId, style.styleId, label, s.list.map(eventLine)];
    });
    observe(nowMs() - t0);
    let note = `${events} open events in ${built.length} systems`;
    if (built.length > maxSystems) note += ` (+${built.length - maxSystems} more systems)`;
    if (read.truncated) note += " (truncated)";
    return { available: true, key: keyAt(now), legend, items, note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Events", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, LEGEND, EVENT_STYLES, buildEventsLayerView };
