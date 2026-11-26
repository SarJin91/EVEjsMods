"use strict";

const LAYER_ORDER = 26;
const VIEW_ORDER = 78;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const MINUTE_MS = 60000;
const MAX_BOUND_ROWS = 3;
const MAX_LINES = 4;
const LABEL = "I";
const STYLE_BOUND = "bound";
const LEGEND = Object.freeze([Object.freeze([STYLE_BOUND, "Sansha incursion (LNE target)", "#30d0c0", "diamond"])]);
const STATUS_FIELDS = Object.freeze(["mode", "steer", "settle", "vendorBands", "installed", "drift", "bound",
  "consequences", "lastRefusal", "counters"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const minutesOf = (ms) => Math.max(0, Math.round(ms / MINUTE_MS));

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function layerItemsOf(boundRows, now) {
  const bySystem = new Map();
  for (const r of Array.isArray(boundRows) ? boundRows : []) {
    if (!r || !isId(r.targetSystemId)) continue;
    const lines = bySystem.get(r.targetSystemId) || [];
    lines.push(`tale ${r.taleId} g${r.generation} ${r.band}${r.steered ? " steered" : ""}`,
      `${minutesOf(r.expiresAt - now)} min left`);
    bySystem.set(r.targetSystemId, lines);
  }
  return [...bySystem.keys()].sort((a, b) => a - b)
    .map((id) => [id, STYLE_BOUND, LABEL, bySystem.get(id).slice(0, MAX_LINES), null]);
}

function readerOf(deps) {
  const { store, repo, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const settings = deps.settings || {};
  const pollMs = Math.max(1, Math.trunc(Number(settings.passIntervalMs) || 0));
  const settledRows = Math.max(1, Math.trunc(Number(settings.settledRows) || 0));

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(GALAXY_WORK_CLASS), true) !== false;
  }

  function read() {
    if (call(() => store.isOpen(), false) !== true) return { ok: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { ok: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const tx = store.transaction("observer.nativeIncursions", (db) => {
      const bound = repo.listBoundInTx(db, MAX_BOUND_ROWS);
      if (!bound.ok) return bound;
      const settled = repo.listRecentSettledInTx(db, settledRows);
      if (!settled.ok) return settled;
      return { ok: true, bound: bound.rows, settled: settled.rows };
    });
    const v = tx && tx.ok ? tx.value : tx;
    if (!tx || !tx.ok || !v || !v.ok) return { ok: false, reason: String((v && v.reason) || "TX_FAILED") };
    return { ok: true, now, bound: v.bound, settled: v.settled };
  }

  function keyOf(prefix) {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    return `${prefix}${Math.floor(clock.now() / pollMs)}`;
  }

  return { read, keyOf };
}

function buildNativeIncursionsLayer(deps) {
  const reader = readerOf(deps);

  function getData() {
    const r = reader.read();
    if (!r.ok) return { available: false, reason: r.reason };
    return { available: true, key: reader.keyOf("k"), legend: LEGEND.map((l) => [...l]),
      items: layerItemsOf(r.bound, r.now), note: `${r.bound.length} bound` };
  }

  return { title: "Native incursions", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER },
    cacheKey: () => reader.keyOf("k"), getData };
}

function buildNativeIncursionsPanel(deps) {
  const reader = readerOf(deps);
  const nameOf = (id) => {
    const n = typeof deps.systemNameOf === "function" ? call(() => deps.systemNameOf(id), null) : null;
    return typeof n === "string" && n !== "" ? n : null;
  };
  const boundView = (r) => ({ taleId: r.taleId, generation: r.generation, constellationId: r.constellationId,
    band: r.band, targetSystemId: r.targetSystemId, system: nameOf(r.targetSystemId), steered: r.steered,
    boundAt: r.boundAt, expiresAt: r.expiresAt });

  function getData() {
    const r = reader.read();
    if (!r.ok) return { available: false, reason: r.reason };
    const st = typeof deps.getStatus === "function" ? call(deps.getStatus, null) : null;
    const status = {};
    for (const key of STATUS_FIELDS) status[key] = st && st[key] !== undefined ? st[key] : null;
    return { available: true, bound: r.bound.map(boundView),
      settled: r.settled.map((s) => ({ ...boundView(s), outcome: s.outcome, effect: s.effect, settledAt: s.settledAt,
        attempts: s.attempts })),
      status, generatedAt: r.now };
  }

  return { title: "Native incursions", order: VIEW_ORDER, listed: true, cacheKey: () => reader.keyOf("p"), getData };
}

module.exports = { LAYER_ORDER, VIEW_ORDER, LEGEND, MAX_BOUND_ROWS, layerItemsOf, buildNativeIncursionsLayer,
  buildNativeIncursionsPanel };
