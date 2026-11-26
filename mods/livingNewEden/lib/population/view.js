"use strict";

const { ARCHETYPE_NAMES } = require("./schema");

const VIEW_ID = "population";
const LAYER_ID = "layer-population";
const VIEW_ORDER = 76;
const LAYER_ORDER = 8;
const STYLE = Object.freeze(ARCHETYPE_NAMES.map((n) => `pop-${n.toLowerCase()}`));
const COLORS = Object.freeze(["#40c0ff", "#ffb000", "#ff6060", "#c080ff", "#80e080"]);
const LEGEND = Object.freeze(ARCHETYPE_NAMES.map((n, i) => Object.freeze([STYLE[i], `pilots: ${n.toLowerCase()}`,
  COLORS[i], "ring"])));

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function layerItemsOf(rows) {
  return [...rows].sort((a, b) => a.systemId - b.systemId).map((r) => {
    let k = 0;
    for (let i = 1; i < r.archetypes.length; i += 1) if (r.archetypes[i] > r.archetypes[k]) k = i;
    const mix = ARCHETYPE_NAMES.map((n, i) => [n, r.archetypes[i]]).filter((e) => e[1] > 0)
      .map((e) => `${e[0]} ${e[1]}`).join(" ");
    const lines = [`pilots ${r.count}`, mix];
    if (r.tier !== "FAR") lines.push(`tier ${r.tier}`);
    return [r.systemId, STYLE[k], String(r.count), lines, null];
  });
}

function standingsOf(service) {
  const c = typeof service.standingCensus === "function" ? call(() => service.standingCensus(), null) : null;
  return c ? { byFaction: c.byFaction, top: c.top } : null;
}

const LIFECYCLE_RATE_KEYS = Object.freeze(["lifecycle.away", "lifecycle.returned", "lifecycle.quit",
  "lifecycle.reborn", "lifecycle.promoted", "lifecycle.homeMoved", "corps.dissolvedInactive"]);
const CAREER_RATE_KEYS = Object.freeze(["lifecycle.promoted", "lifecycle.homeMoved"]);
const CORPS_RATE_KEYS = Object.freeze(["corps.dissolvedInactive"]);
const DAY_MS = 86400000;
const SKIPPED_CANDIDATES_NOTE = "skippedCandidates = founder / recruit candidates skipped as AWAY, ROOKIE or with a "
  + "home in another region; not the count of inactive pilots";

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function pick(counters, keys) {
  const c = counters || {};
  return Object.fromEntries(keys.map((k) => [k, num(c[k])]));
}

function lifecycleOf(status, first, now) {
  const L = status.lifecycle || {};
  const c = status.counters || {};
  const career = L.career ? L.career : null;
  const corpsOn = Boolean(status.corps && status.corps.activity);
  const size = Number(status.size);
  const away = num(L.away);
  const windowMs = Math.max(0, now - first.at);
  const rateKeys = LIFECYCLE_RATE_KEYS.filter((k) => (career || !CAREER_RATE_KEYS.includes(k))
    && (corpsOn || !CORPS_RATE_KEYS.includes(k)));
  let perDay = null;
  if (windowMs > 0) {
    perDay = {};
    for (const k of rateKeys) {
      const v = c[k];
      const d = typeof v === "number" && Number.isFinite(v) ? v - num(first.counters[k]) : -1;
      perDay[k.slice(k.indexOf(".") + 1)] = d < 0 ? null : Math.round(((d * DAY_MS) / windowMs) * 10) / 10;
    }
  }
  const totals = { awayCapped: num(c["lifecycle.awayCapped"]), returnedHome: num(c["lifecycle.returnedHome"]),
    rookieFallback: num(c["lifecycle.rookieFallback"]), wakeFailed: num(c["lifecycle.wakeFailed"]),
    ...(career ? { careerSeeded: num(c["lifecycle.careerSeeded"]) } : {}) };
  return { away, awayCap: num(L.awayCap), awayPermille: size > 0 ? Math.round((away * 1000) / size) : null,
    rookieSystems: num(L.rookieSystems), windowMs, perDay, totals,
    ...(career ? { byCareer: { ...career.byCareer } } : {}),
    ...(corpsOn ? { corps: { open: typeof status.corps.open === "number" ? status.corps.open : null,
      dissolved: num(c["corps.dissolved"]), dissolvedInactive: num(c["corps.dissolvedInactive"]),
      skippedCandidates: num(c["corps.skippedInactive"]), note: SKIPPED_CANDIDATES_NOTE } } : {}) };
}

function keyOf(clock, P) {
  return `p${Math.floor(clock.now() / Math.max(1, P.observer.refreshMs))}`;
}

function buildPopulationLayer(deps) {
  const { service, settings: P, clock } = deps;
  function getData() {
    const st = call(() => service.getStatus(), null);
    if (!st || st.state !== "running") return { available: false, reason: st ? st.state : "unavailable" };
    const rows = call(() => service.topSystems(P.observer.maxSystems), []);
    const items = layerItemsOf(rows);
    const pilots = rows.reduce((s, r) => s + r.count, 0);
    return { available: true, key: keyOf(clock, P), legend: LEGEND.map((l) => [...l]), items,
      note: `${pilots} pilot(s) in the top ${items.length} system(s)` };
  }
  return { title: "NPC pilots", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER },
    cacheKey: () => keyOf(clock, P), getData };
}

function buildPopulationPanel(deps) {
  const { service, settings: P, clock } = deps;
  let prev = null;
  let first = null;
  function getData() {
    const status = call(() => service.getStatus(), null);
    if (!status) return { available: false, reason: "unavailable" };
    const now = clock.now();
    const lc = Boolean(status.lifecycle && status.lifecycle.enabled === true);
    if (lc && first === null) first = { at: now, counters: pick(status.counters, LIFECYCLE_RATE_KEYS) };
    const total = Number(status.eventsTotal) || 0;
    const eventsPerSec = prev && now > prev.at && total >= prev.total
      ? Math.round(((total - prev.total) * 1000) / (now - prev.at) * 100) / 100 : null;
    prev = { at: now, total };
    return { available: status.state === "running", status, size: status.size, byState: status.byState,
      tiers: status.near ? { live: status.near.live, near: status.near.near, systemsLive: status.near.systemsLive,
        systemsNear: status.near.systemsNear } : null,
      eventsPerSec, lagMs: status.lastPass ? status.lastPass.lagMs : null, flush: status.lastFlush || null,
      counters: status.counters || {}, nearEnabled: P.near.enabled === true,
      ...(status.activeLife && status.activeLife.enabled === true ? { activeLife: {
        dockedPermille: status.activeLife.dockedPermille, targetDockedPermille: status.activeLife.targetDockedPermille,
        dockedOverTarget: status.activeLife.dockedOverTarget } } : {}),
      ...(status.standings && status.standings.enabled === true ? { standings: standingsOf(service) } : {}),
      ...(status.hulls && status.hulls.enabled === true ? { hulls: { byClass: status.hulls.byClass,
        noLiveProfile: (status.counters || {})["hulls.noLiveProfile"] || 0 } } : {}),
      ...(lc ? { lifecycle: lifecycleOf(status, first, now) } : {}),
      generatedAt: now };
  }
  return { title: "NPC pilot population", order: VIEW_ORDER, listed: true, cacheKey: () => keyOf(clock, P),
    getData };
}

module.exports = { VIEW_ID, LAYER_ID, VIEW_ORDER, LAYER_ORDER, LEGEND, STYLE, LIFECYCLE_RATE_KEYS, layerItemsOf,
  lifecycleOf, buildPopulationLayer, buildPopulationPanel };
