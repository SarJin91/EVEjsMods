"use strict";

const { performance } = require("node:perf_hooks");
const { chancePermilleOf } = require("./rules");

const MAX_DETAIL = 120;
const SEED_READY = Object.freeze(["done", "already_applied", "skipped", "disabled"]);
const SEED_DEGRADED = Object.freeze(["failed", "stopped"]);
const SEED_UNKNOWN = "unknown";
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function createRiskIndex(deps) {
  const { world } = deps;
  const S = deps.settings;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => Date.now();
  const perfNow = typeof deps.perfNow === "function" ? deps.perfNow : () => performance.now();
  const onBuilt = typeof deps.onBuilt === "function" ? deps.onBuilt : () => {};
  const onPageRefused = typeof deps.onPageRefused === "function" ? deps.onPageRefused : () => {};
  const onWaitSeed = typeof deps.onWaitSeed === "function" ? deps.onWaitSeed : () => {};
  let live = null;
  let builtAt = null;
  let lastBuildMs = null;
  let pageRefused = 0;
  let building = null;
  let waitSeed = null;
  let seedWaits = 0;
  let stepErrors = 0;
  let degradedSeen = null;
  let seedDegraded = null;
  const onSeedDegraded = typeof deps.onSeedDegraded === "function" ? deps.onSeedDegraded : () => {};

  function seedState() {
    const seed = world ? world.seed : null;
    if (!seed || typeof seed.getStatus !== "function") return null;
    try {
      const s = seed.getStatus();
      return s && typeof s.state === "string" ? s.state : SEED_UNKNOWN;
    } catch (_err) {
      return SEED_UNKNOWN;
    }
  }

  function waitsForSeed() {
    const state = seedState();
    degradedSeen = null;
    if (state === null || SEED_READY.includes(state)) {
      waitSeed = null;
      return false;
    }
    if (SEED_DEGRADED.includes(state)) {
      waitSeed = null;
      degradedSeen = state;
      return false;
    }
    waitSeed = state;
    seedWaits += 1;
    safeCall(() => onWaitSeed(state));
    return true;
  }

  function sentriesOf() {
    const s = safeCall(deps.getSentries);
    if (!s || typeof s.listLiveInSystem !== "function" || typeof s.getMode !== "function") return null;
    return safeCall(() => s.getMode()) === "ready" ? s : null;
  }

  function gateSentriesOf(sentries, systemId, controller) {
    if (!sentries) return 0;
    const list = safeCall(() => sentries.listLiveInSystem(systemId));
    if (!Array.isArray(list)) return 0;
    return list.filter((ref) => ref && ref.anchorKind === "gate" && ref.ownerKind === "faction"
      && ref.factionId === controller).length;
  }

  function entryOf(row, sentries) {
    if (!row || !Number.isSafeInteger(row.systemId) || row.controllerFactionId === null
      || row.controllerFactionId === undefined || !S.secClasses.includes(row.securityClass)) return null;
    const controller = row.controllerFactionId;
    const inf = Array.isArray(row.influence) ? row.influence.find((i) => i && i.factionId === controller) : null;
    const entry = { systemId: row.systemId, controllerFactionId: controller, secClass: row.securityClass,
      influence: inf && Number.isFinite(inf.influenceScore) ? inf.influenceScore : 0,
      garrison: inf && Number.isFinite(inf.garrisonStrength) ? inf.garrisonStrength : 0,
      gateSentries: gateSentriesOf(sentries, row.systemId, controller), chanceBase: 0 };
    entry.chanceBase = chancePermilleOf(entry, S);
    return Object.freeze(entry);
  }

  function step() {
    try {
      if (building === null) {
        if (live !== null && builtAt !== null && nowMs() - builtAt < S.indexRefreshMs) return;
        if (waitsForSeed()) return;
        building = { map: new Map(), afterSystemId: 0, pages: 0, workMs: 0, degraded: degradedSeen };
      }
      const t0 = perfNow();
      let page;
      try {
        page = world.listSystems({ afterSystemId: building.afterSystemId, limit: S.indexPageSize,
          includeInfluence: true });
      } catch (err) {
        page = { ok: false, reason: messageOf(err) };
      }
      if (!page || page.ok !== true || !Array.isArray(page.systems)) {
        pageRefused += 1;
        building.workMs += perfNow() - t0;
        safeCall(() => onPageRefused(String((page && page.reason) || "LIST_FAILED")));
        return;
      }
      const sentries = sentriesOf();
      for (const row of page.systems) {
        const entry = entryOf(row, sentries);
        if (entry) building.map.set(entry.systemId, entry);
      }
      building.pages += 1;
      building.workMs += perfNow() - t0;
      const next = page.nextAfterSystemId;
      if (next !== null && Number.isSafeInteger(next) && next > building.afterSystemId) {
        building.afterSystemId = next;
        return;
      }
      if (waitsForSeed()) {
        building = null;
        return;
      }
      const done = building;
      building = null;
      live = done.map;
      builtAt = nowMs();
      lastBuildMs = done.workMs;
      seedDegraded = degradedSeen || done.degraded || null;
      if (seedDegraded !== null) safeCall(() => onSeedDegraded(seedDegraded));
      safeCall(() => onBuilt({ systems: done.map.size, buildMs: done.workMs, pages: done.pages }));
    } catch (err) {
      stepErrors += 1;
      safeCall(() => onPageRefused(`STEP_THREW:${messageOf(err)}`));
    }
  }

  return Object.freeze({
    step,
    get: (systemId) => (live !== null ? live.get(systemId) || null : null),
    isWarm: () => live !== null,
    getStatus: () => Object.freeze({ state: live !== null ? "warm" : "cold", systems: live !== null ? live.size : 0,
      builtAt, building: building === null ? null : Object.freeze({ pages: building.pages,
        afterSystemId: building.afterSystemId }), lastBuildMs, pageRefused, waitSeed, seedWaits, stepErrors,
      seedDegraded }),
  });
}

module.exports = { createRiskIndex, SEED_READY, SEED_DEGRADED };
