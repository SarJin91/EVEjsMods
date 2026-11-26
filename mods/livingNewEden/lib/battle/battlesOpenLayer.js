"use strict";

const LAYER_ID = "layer-battles-open";
const LAYER_ORDER = 17;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyBattlesOpenMs";
const MS_DECIMALS = 10;
const MS_PER_MINUTE = 60000;
const STYLE_BATTLE = "battle";
const STYLE_HELD = "battle-held";
const MULTIPLY_SIGN = "×";

const LEGEND = Object.freeze([
  Object.freeze([STYLE_BATTLE, "battle in progress (left = attacker A, right = defender B)", "#ff2850", "versus",
    null, "solid"]),
  Object.freeze([STYLE_HELD, "battle held (player nearby)", "#ff2850", "versus", null, "dashed"]),
]);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

const sideText = (side) => (side ? `faction ${side.factionId} ${side.fleets}` : "faction - 0");

function battleLine(b, now) {
  const hold = b.holdReason ? ` (${b.holdReason})` : "";
  const a = b.sides.A;
  const d = b.sides.B;
  const age = Math.max(0, Math.floor((now - b.createdAt) / MS_PER_MINUTE));
  return `${b.battleId} - ${b.state}${hold} - A ${sideText(a)} fleets/${a ? a.ships : 0} ships -> B ${sideText(d)}`
    + `/${d ? d.ships : 0} - ${age} min`;
}

function toItems(battles, maxLines, now) {
  const bySystem = new Map();
  for (const b of battles) {
    let list = bySystem.get(b.systemId);
    if (!list) {
      list = [];
      bySystem.set(b.systemId, list);
    }
    list.push(b);
  }
  const lineCap = Math.max(0, Math.trunc(Number(maxLines) || 0));
  const items = [];
  for (const [systemId, list] of bySystem) {
    list.sort((x, y) => x.createdAt - y.createdAt || (x.battleId < y.battleId ? -1 : x.battleId > y.battleId ? 1 : 0));
    const oldest = list[0];
    const a = oldest.sides.A;
    const d = oldest.sides.B;
    const label = `${a ? a.fleets : 0}v${d ? d.fleets : 0}${list.length > 1 ? ` ${MULTIPLY_SIGN}${list.length}` : ""}`;
    const held = list.some((b) => b.holdReason !== null && b.holdReason !== undefined);
    const lines = list.slice(0, lineCap).map((b) => battleLine(b, now));
    if (list.length > lineCap && lineCap > 0) lines.push(`+${list.length - lineCap} more`);
    const factions = a && d ? [[a.factionId, a.fleets], [d.factionId, d.fleets]] : null;
    items.push([systemId, held ? STYLE_HELD : STYLE_BATTLE, label, lines, factions]);
  }
  return items.sort((x, y) => x[0] - y[0]);
}

function buildBattlesOpenLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const maxBattles = Math.max(0, Math.trunc(Number(deps.maxBattles) || 0));
  const maxLines = Math.max(0, Math.trunc(Number(deps.maxLines) || 0));
  const refreshMs = Math.max(1, Math.trunc(Number(deps.refreshMs) || 1));

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

  const keyAt = (now) => `o${Math.floor(now / refreshMs)}`;

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxBattles === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 battles in progress (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyBattlesOpen", (db) => repository.summarizeOpen(db,
      { limit: maxBattles }));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const items = toItems(read.battles, maxLines, now);
    observe(nowMs() - t0);
    const note = `${read.battles.length} battles in progress in ${items.length} systems`;
    return { available: true, key: keyAt(now), legend, items, note: read.truncated ? `${note} (truncated)` : note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Battles in progress", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey,
    getData };
}

module.exports = { LAYER_ID, LAYER_ORDER, LEGEND, toItems, buildBattlesOpenLayerView };
