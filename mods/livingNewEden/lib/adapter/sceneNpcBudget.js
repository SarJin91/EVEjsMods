"use strict";

const REASON = "SCENE_NPC_BUDGET";

const COUNTER_NAMES = Object.freeze(["materialization", "npcSpawn", "heavyEvents", "highsecTraffic", "bounty",
  "situations", "ambientRats", "miningEncounters", "officerSpawn", "other"]);

const SHED = "SHED";
const OVERLOADED = "OVERLOADED";
const NONE = "none";

const isObject = (v) => v !== null && typeof v === "object";

function parseSourceList(value) {
  if (typeof value !== "string") return [];
  const list = value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return list.includes(NONE) ? [] : list;
}

function createSceneNpcBudget(deps = {}) {
  let sources = { getMode: deps.getMode || null, count: deps.count || null, gauge: deps.gauge || null };
  let exemptCache = { raw: null, list: [] };

  const safe = (fn, fallback = undefined) => {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  };

  function settings() {
    const s = typeof deps.getSettings === "function" ? safe(deps.getSettings, null) : null;
    if (!isObject(s) || s.enabled !== true) return null;
    if (!Number.isSafeInteger(s.maxPerScene) || s.maxPerScene < 0 || !Number.isSafeInteger(s.maxScan)
      || s.maxScan <= 0 || typeof s.overloadedPermille !== "number" || !Number.isFinite(s.overloadedPermille)) {
      return null;
    }
    return s;
  }

  function exemptOf(s) {
    if (exemptCache.raw !== s.shedExemptSources) {
      exemptCache = { raw: s.shedExemptSources, list: parseSourceList(s.shedExemptSources) };
    }
    return exemptCache.list;
  }

  function capOf(s, mode, source) {
    if (mode === SHED && !exemptOf(s).includes(source)) return 0;
    if (mode === OVERLOADED) {
      const permille = Math.min(1000, Math.max(0, s.overloadedPermille));
      return Math.floor((s.maxPerScene * permille) / 1000);
    }
    return s.maxPerScene;
  }

  function countIn(systemId, maxScan) {
    const runtime = deps.getRuntime();
    if (!runtime || runtime.ok !== true || !isObject(runtime.exports)) return null;
    const scenes = runtime.exports.scenes;
    if (!(scenes instanceof Map)) return null;
    const scene = scenes.get(systemId);
    const entities = scene && scene.dynamicEntities;
    if (!entities || typeof entities.values !== "function") return null;
    let n = 0;
    let scanned = 0;
    for (const e of entities.values()) {
      scanned += 1;
      if (scanned > maxScan) return Infinity;
      if (e && e.nativeNpc === true) n += 1;
    }
    return n;
  }

  const count = (name) => safe(() => (typeof sources.count === "function" ? sources.count(name) : undefined));
  const gauge = (name, v) => safe(() => (typeof sources.gauge === "function" ? sources.gauge(name, v) : undefined));

  function admit(systemId, n, source) {
    const s = settings();
    if (s === null) return { ok: true, count: null, cap: null };
    const src = COUNTER_NAMES.includes(source) ? source : "other";
    const mode = typeof sources.getMode === "function" ? safe(sources.getMode, null) : null;
    const cap = capOf(s, mode, src);
    const npcs = safe(() => countIn(systemId, s.maxScan), null);
    if (npcs === null) return { ok: true, count: null, cap };
    const want = Number.isSafeInteger(n) && n > 0 ? n : 1;
    if (Number.isFinite(npcs)) gauge("perf.sceneNpc.lastCount", npcs);
    if (npcs + want <= cap) return { ok: true, count: npcs, cap };
    count("perf.sceneNpc.refused");
    const name = src;
    count(`perf.sceneNpc.refused.${name}`);
    return { ok: false, reason: REASON, count: Number.isFinite(npcs) ? npcs : s.maxScan, cap };
  }

  function setSources(next) {
    const x = isObject(next) ? next : {};
    sources = { getMode: typeof x.getMode === "function" ? x.getMode : null,
      count: typeof x.count === "function" ? x.count : null, gauge: typeof x.gauge === "function" ? x.gauge : null };
  }

  return Object.freeze({ admit, setSources, enabled: () => settings() !== null });
}

function admitOrPass(admit) {
  return typeof admit === "function" ? admit : () => ({ ok: true, count: null, cap: null });
}

module.exports = { createSceneNpcBudget, admitOrPass, parseSourceList, COUNTER_NAMES, REASON };
