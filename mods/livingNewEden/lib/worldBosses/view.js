"use strict";

const S = require("./schema");

const LAYER_ORDER = 25;
const VIEW_ORDER = 73;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const MINUTE_MS = 60000;
const MAX_ROWS = 16;
const MAX_LINES = 4;
const LABEL = "B";
const STYLE = Object.freeze({ DWELL: "dwell", MOVING: "moving" });
const LEGEND = Object.freeze([
  Object.freeze([STYLE.DWELL, "world boss", "#c040ff", "diamond"]),
  Object.freeze([STYLE.MOVING, "world boss: moving", "#ff40c0", "versus"]),
]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const minutesOf = (ms) => Math.max(0, Math.round(ms / MINUTE_MS));

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function layerItemsOf(bosses, now) {
  const bySystem = new Map();
  for (const b of Array.isArray(bosses) ? bosses : []) {
    if (!b || !isId(b.systemId)) continue;
    const moving = b.state === S.STATES.MOVING;
    const e = bySystem.get(b.systemId) || { style: STYLE.DWELL, lines: [] };
    if (moving && e.lines.length === 0) e.style = STYLE.MOVING;
    if (!moving) e.style = STYLE.DWELL;
    e.lines.push(`${b.kind} phase ${b.phase} (${b.hpPermille === null ? "?" : b.hpPermille / 10}%) `
      + (moving ? `moving to ${b.nextSystemId}, ${minutesOf(b.nextDueAt - now)} min`
        : `dwell, ${minutesOf(b.nextDueAt - now)} min left`));
    bySystem.set(b.systemId, e);
  }
  return [...bySystem.keys()].sort((a, b) => a - b).map((id) => {
    const e = bySystem.get(id);
    return [id, e.style, LABEL, e.lines.slice(0, MAX_LINES), null];
  });
}

function readerOf(deps) {
  const { store, repo, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const viewOf = typeof deps.viewOf === "function" ? deps.viewOf : (row) => row;
  const pollMs = Math.max(1, Math.trunc(Number(deps.settings && deps.settings.passIntervalMs) || 0));

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(GALAXY_WORK_CLASS), true) !== false;
  }

  function read() {
    if (call(() => store.isOpen(), false) !== true) return { ok: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { ok: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const tx = store.transaction("observer.worldBosses", (db) => repo.listOpenInTx(db, MAX_ROWS));
    const v = tx && tx.ok ? tx.value : tx;
    if (!tx || !tx.ok || !v || !v.ok) return { ok: false, reason: String((v && v.reason) || "TX_FAILED") };
    return { ok: true, now, bosses: v.rows.map((r) => call(() => viewOf(r), r)) };
  }

  function keyOf(prefix) {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    return `${prefix}${Math.floor(clock.now() / pollMs)}`;
  }

  return { read, keyOf };
}

function buildWorldBossesLayer(deps) {
  const reader = readerOf(deps);

  function getData() {
    const r = reader.read();
    if (!r.ok) return { available: false, reason: r.reason };
    return { available: true, key: reader.keyOf("k"), legend: LEGEND.map((l) => [...l]),
      items: layerItemsOf(r.bosses, r.now), note: `${r.bosses.length} open` };
  }

  return { title: "World bosses", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER },
    cacheKey: () => reader.keyOf("k"), getData };
}

function buildWorldBossesPanel(deps) {
  const reader = readerOf(deps);
  const nameOf = (id) => {
    const n = typeof deps.systemNameOf === "function" ? call(() => deps.systemNameOf(id), null) : null;
    return typeof n === "string" && n !== "" ? n : null;
  };

  function getData() {
    const r = reader.read();
    if (!r.ok) return { available: false, reason: r.reason };
    const status = typeof deps.getStatus === "function" ? call(deps.getStatus, null) : null;
    const open = r.bosses.map((b) => ({ ...b, system: nameOf(b.systemId),
      nextSystem: isId(b.nextSystemId) ? nameOf(b.nextSystemId) : null }));
    return { available: true, open, counters: status && status.counters ? status.counters : null,
      disabledKinds: status && status.disabledKinds ? status.disabledKinds : [], generatedAt: r.now };
  }

  return { title: "World bosses", order: VIEW_ORDER, listed: true, cacheKey: () => reader.keyOf("p"), getData };
}

module.exports = { VIEW_ID: S.VIEW_ID, LAYER_ID: S.LAYER_ID, LAYER_ORDER, VIEW_ORDER, LEGEND, layerItemsOf,
  buildWorldBossesLayer, buildWorldBossesPanel };
