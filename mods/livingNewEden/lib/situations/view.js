"use strict";

const S = require("./schema");
const { kindOf } = require("./catalog");

const LAYER_ORDER = 23;
const VIEW_ORDER = 69;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const MINUTE_MS = 60000;
const SECOND_MS = 1000;
const MAX_LINES = 6;
const OPEN_LABEL = "!";
const STYLE = Object.freeze({ FIGHT: "fight", CALLING: "calling", RESCUED: "rescued", LOST: "lost" });
const LEGEND = Object.freeze([
  Object.freeze([STYLE.FIGHT, "situation: fight", "#ff4040", "versus"]),
  Object.freeze([STYLE.CALLING, "situation: call for help", "#ffb000", "diamond"]),
  Object.freeze([STYLE.RESCUED, "situation: rescued", "#40d040", "triangle"]),
  Object.freeze([STYLE.LOST, "situation: lost / unanswered", "#909090", "ring"]),
]);
const PRIORITY = Object.freeze({ [STYLE.FIGHT]: 0, [STYLE.CALLING]: 1, [STYLE.RESCUED]: 2, [STYLE.LOST]: 3 });
const ENDED_STYLE = Object.freeze({ [S.STATES.RESCUED]: STYLE.RESCUED, [S.STATES.LOST]: STYLE.LOST,
  [S.STATES.UNANSWERED]: STYLE.LOST });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const minutesOf = (ms) => Math.max(0, Math.round(ms / MINUTE_MS));

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function titleOf(kind) {
  const entry = kindOf(kind);
  return entry && typeof entry.boardTitle === "string" ? entry.boardTitle : String(kind);
}

function layerItemsOf(open, ended, now) {
  const bySystem = new Map();
  const add = (systemId, style, line, isOpen) => {
    if (!isId(systemId)) return;
    const e = bySystem.get(systemId) || { style, open: false, lines: [] };
    if (PRIORITY[style] < PRIORITY[e.style]) e.style = style;
    e.open = e.open || isOpen;
    e.lines.push(line);
    bySystem.set(systemId, e);
  };
  for (const o of Array.isArray(open) ? open : []) {
    if (!o) continue;
    const style = o.phase === S.PHASES.FIGHT ? STYLE.FIGHT : STYLE.CALLING;
    add(o.systemId, style, `${titleOf(o.kind)}: ${o.anchorLabel} (${o.phase}, ${minutesOf(now - o.phaseSince)} min)`,
      true);
  }
  for (const r of Array.isArray(ended) ? ended : []) {
    if (!r || !Object.prototype.hasOwnProperty.call(ENDED_STYLE, r.state)) continue;
    add(r.systemId, ENDED_STYLE[r.state],
      `${r.state} ${r.victimsSaved === null ? 0 : r.victimsSaved}/${r.victims} (${minutesOf(now - r.endedAt)} min ago)`,
      false);
  }
  return [...bySystem.keys()].sort((a, b) => a - b).map((id) => {
    const e = bySystem.get(id);
    return [id, e.style, e.open ? OPEN_LABEL : null, e.lines.slice(0, MAX_LINES), null];
  });
}

function readerOf(deps) {
  const { store, repo, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const listOpen = typeof deps.listOpen === "function" ? deps.listOpen : () => [];
  const s = deps.settings || {};
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const recentMs = int(s.layerRecentMs, 0);
  const maxRows = int(s.layerMaxRows, 1);
  const pollMs = int(s.pollMs, 1);

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(GALAXY_WORK_CLASS), true) !== false;
  }

  function read() {
    if (call(() => store.isOpen(), false) !== true) return { ok: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { ok: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const tx = store.transaction("observer.situations", (db) => repo.listEndedSinceInTx(db,
      Math.max(0, now - recentMs), maxRows));
    const v = tx && tx.ok ? tx.value : tx;
    if (!tx || !tx.ok || !v || !v.ok) return { ok: false, reason: String((v && v.reason) || "TX_FAILED") };
    const open = call(listOpen, []);
    return { ok: true, now, open: Array.isArray(open) ? open : [], ended: v.rows, truncated: v.truncated === true };
  }

  function keyOf(prefix) {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    return `${prefix}${Math.floor(clock.now() / pollMs)}`;
  }

  return { read, keyOf, recentMs };
}

function buildSituationsLayer(deps) {
  const reader = readerOf(deps);

  function getData() {
    const r = reader.read();
    if (!r.ok) return { available: false, reason: r.reason };
    const items = layerItemsOf(r.open, r.ended, r.now);
    const note = `${r.open.length} open, ${r.ended.length} ended in ${minutesOf(reader.recentMs)} min`
      + (r.truncated ? " (truncated)" : "");
    return { available: true, key: reader.keyOf("k"), legend: LEGEND.map((l) => [...l]), items, note };
  }

  return { title: "Situations", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER },
    cacheKey: () => reader.keyOf("k"), getData };
}

function buildSituationsPanel(deps) {
  const reader = readerOf(deps);
  const nameOf = (id) => {
    const n = typeof deps.systemNameOf === "function" ? call(() => deps.systemNameOf(id), null) : null;
    return typeof n === "string" && n !== "" ? n : null;
  };

  function getData() {
    const r = reader.read();
    if (!r.ok) return { available: false, reason: r.reason };
    const status = typeof deps.getStatus === "function" ? call(deps.getStatus, null) : null;
    const open = r.open.map((o) => ({ situationId: o.situationId, kind: o.kind, system: nameOf(o.systemId),
      systemId: o.systemId, phase: o.phase, anchor: o.anchorLabel, victims: o.victims,
      ageS: Math.max(0, Math.floor((r.now - o.startedAt) / SECOND_MS)) }));
    const recent = r.ended.map((x) => ({ situationId: x.situationId, kind: x.kind, system: nameOf(x.systemId),
      systemId: x.systemId, state: x.state, endReason: x.endReason, victims: x.victims,
      saved: x.victimsSaved === null ? 0 : x.victimsSaved, endedAt: x.endedAt }));
    return { available: true, open, recent, truncated: r.truncated,
      counters: status && status.counters ? status.counters : null,
      payouts: status && status.payouts ? status.payouts : null, generatedAt: r.now };
  }

  return { title: "Situations", order: VIEW_ORDER, listed: true, cacheKey: () => reader.keyOf("p"), getData };
}

module.exports = { LAYER_ID: S.LAYER_ID, VIEW_ID: S.VIEW_ID, LAYER_ORDER, VIEW_ORDER, LEGEND, layerItemsOf,
  buildSituationsLayer, buildSituationsPanel };
