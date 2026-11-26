"use strict";

const VIEW_ID = "abyssal-runs";
const VIEW_ORDER = 67;
const WORK_CLASS = "MAINTENANCE";
const ROOMS_PER_RUN = 3;
const PRESSURE_ROWS = 5;
const ROW_KEYS = Object.freeze(["instanceId", "pilotId", "pilot", "sourceSystemId", "sourceSystem", "tier", "weather",
  "shipClass", "participants", "room", "state", "vendorOutcome", "startedAt", "finishedAt", "durationMs"]);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildAbyssalRunsView(deps) {
  const repository = deps.repository;
  const viewLimit = deps.viewLimit;
  const now = deps.now;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function pilotNames() {
    const presence = call(getPresence, null);
    const list = presence && typeof presence.listPresence === "function" ? call(() => presence.listPresence(), []) : [];
    const names = new Map();
    for (const sys of list || []) for (const c of sys.characters || []) if (c.name) names.set(c.characterId, c.name);
    return names;
  }

  function systemNameOf() {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(() => deps.graph.getGraph(), null) : null;
    const graph = res && res.ok === true && res.graph ? res.graph : null;
    return (id) => {
      if (!graph || id <= 0) return null;
      const vertex = call(() => graph.getSystem(id), null);
      return vertex && typeof vertex.name === "string" ? vertex.name : null;
    };
  }

  function rowOf(run, names, systemName, nowMs) {
    const end = run.finishedAtMs === null ? nowMs : run.finishedAtMs;
    return { instanceId: run.instanceId, pilotId: run.ownerCharacterId, pilot: names.get(run.ownerCharacterId) || null,
      sourceSystemId: run.sourceSystemId, sourceSystem: systemName(run.sourceSystemId), tier: run.tier,
      weather: run.weather, shipClass: run.shipClass, participants: run.participants.length,
      room: `${run.roomIndex}/${ROOMS_PER_RUN}`, state: run.state, vendorOutcome: run.vendorOutcome,
      startedAt: run.activatedAtMs, finishedAt: run.finishedAtMs, durationMs: Math.max(0, end - run.activatedAtMs) };
  }

  function getData() {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const active = repository.listActive();
    if (!active || !active.ok) return { available: false, reason: String((active && active.reason) || "READ_FAILED") };
    const done = repository.listFinished({ limit: viewLimit, newest: true });
    if (!done || !done.ok) return { available: false, reason: String((done && done.reason) || "READ_FAILED") };
    const names = pilotNames();
    const systemName = systemNameOf();
    const nowMs = now();
    const out = { available: true, active: active.runs.map((r) => rowOf(r, names, systemName, nowMs)),
      finished: done.runs.map((r) => rowOf(r, names, systemName, nowMs)) };
    const pressure = pressureSection();
    if (pressure) out.pressure = pressure;
    return out;
  }

  function pressureSection() {
    const memo = typeof deps.getPressure === "function" ? call(deps.getPressure, null) : null;
    if (!memo) return null;
    const top = call(() => memo.topRegions(PRESSURE_ROWS), null);
    if (!top || top.ok !== true) return null;
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(() => deps.graph.getGraph(), null) : null;
    const graph = res && res.ok === true && res.graph ? res.graph : null;
    const nameOf = (id) => (graph && typeof graph.getRegionName === "function"
      ? call(() => graph.getRegionName(id), null) : null);
    return { atMs: top.atMs, regions: top.regions.map((r) => ({ regionId: r.regionId, region: nameOf(r.regionId),
      milli: r.milli })) };
  }

  return { title: "Abyssal runs", order: VIEW_ORDER, listed: true, getData };
}

function registerAbyssalRunsView(deps) {
  const views = deps && deps.views;
  if (!views || typeof views.registerView !== "function") return null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const def = buildAbyssalRunsView(deps);
  const r = call(() => views.registerView(VIEW_ID, def), null);
  if (r && r.ok) return r;
  log(`abyssal: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
  return null;
}

module.exports = { VIEW_ID, ROW_KEYS, ROOMS_PER_RUN, buildAbyssalRunsView, registerAbyssalRunsView };
