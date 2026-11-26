"use strict";

const LAYER_ID = "layer-sieges";
const LAYER_ORDER = 14;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxySiegesMs";
const MS_DECIMALS = 10;
const MS_PER_HOUR = 3600000;
const STYLE_ASSAULT = "siege-assault";
const STYLE_TIMER = "siege-timer";
const MULTIPLY_SIGN = "×";

const LEGEND = Object.freeze([
  Object.freeze([STYLE_ASSAULT, "siege assault phase (left = attacker, right = owner)", "#ff2850", "versus", null, "solid"]),
  Object.freeze([STYLE_TIMER, "siege timer phase (left = attacker, right = owner)", "#ff2850", "versus", null, "dashed"]),
]);
const STYLE_PSIEGE_ASSAULT = "psiege-assault";
const STYLE_PSIEGE_TIMER = "psiege-timer";
const PLAYER_LEGEND = Object.freeze([
  Object.freeze([STYLE_PSIEGE_ASSAULT, "player structure siege, assault (left = attacker, right = player)", "#ffb000",
    "versus", null, "solid"]),
  Object.freeze([STYLE_PSIEGE_TIMER, "player structure siege, timer (left = attacker, right = player)", "#ffb000",
    "versus", null, "dashed"]),
]);
const PLAYER_ASSAULT_STATES = Object.freeze(["SHIELD_ASSAULT", "ARMOR_ASSAULT", "HULL_ASSAULT"]);
const PLAYER_STATE_TEXT = Object.freeze({ SHIELD_ASSAULT: "SHIELD", ARMOR_TIMER: "ARMOR TIMER", ARMOR_ASSAULT: "ARMOR",
  HULL_TIMER: "HULL TIMER", HULL_ASSAULT: "HULL" });

const STYLE_HRAID_WARNED = "hraid-warned";
const STYLE_HRAID_RAIDING = "hraid-raiding";
const RAID_LEGEND = Object.freeze([
  Object.freeze([STYLE_HRAID_WARNED, "harvester raid, warning (left = attacker, right = player)", "#c040ff", "versus",
    null, "dashed"]),
  Object.freeze([STYLE_HRAID_RAIDING, "harvester raid, raiding (left = attacker, right = player)", "#c040ff", "versus",
    null, "solid"]),
]);
const RAID_KIND = "raid";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function phaseLabel(phaseEndsAt, now) {
  const remaining = Math.max(0, Math.ceil((phaseEndsAt - now) / MS_PER_HOUR));
  return `${remaining}h`;
}

function toItems(sieges, maxLines, now) {
  const bySystem = new Map();
  for (const s of sieges) {
    let list = bySystem.get(s.systemId);
    if (!list) {
      list = [];
      bySystem.set(s.systemId, list);
    }
    list.push(s);
  }
  const lineCap = Math.max(0, Math.trunc(Number(maxLines) || 0));
  const items = [];
  for (const [systemId, list] of bySystem) {
    list.sort((x, y) => x.phaseEndsAt - y.phaseEndsAt || (x.siegeId < y.siegeId ? -1 : x.siegeId > y.siegeId ? 1 : 0));
    const earliest = list[0];
    const isAssault = earliest.state === "SHIELD_ASSAULT" || earliest.state === "ARMOR_ASSAULT" || earliest.state === "HULL_ASSAULT" || earliest.state === "ANCHOR_ASSAULT";
    const style = isAssault ? STYLE_ASSAULT : STYLE_TIMER;
    const label = `${earliest.attackerFactionId}v${earliest.ownerFactionId}${list.length > 1 ? ` ${MULTIPLY_SIGN}${list.length}` : ""}`;
    const lines = list.slice(0, lineCap).map((s) => {
      const stateText = s.state === "SHIELD_ASSAULT" ? "SHIELD" : s.state === "ARMOR_TIMER" ? "ARMOR TIMER" :
        s.state === "ARMOR_ASSAULT" ? "ARMOR" : s.state === "HULL_TIMER" ? "HULL TIMER" :
        s.state === "HULL_ASSAULT" ? "HULL" : s.state === "ANCHOR_ASSAULT" ? "ANCHOR" : s.state;
      return `${s.siegeId} - ${stateText} - A ${s.attackerFactionId} -> O ${s.ownerFactionId} - ${phaseLabel(s.phaseEndsAt, now)}`;
    });
    if (list.length > lineCap && lineCap > 0) lines.push(`+${list.length - lineCap} more`);
    const factions = [[earliest.attackerFactionId, 1], [earliest.ownerFactionId, 1]];
    items.push([systemId, style, label, lines, factions, isAssault ? "solid" : "dashed"]);
  }
  return items.sort((x, y) => x[0] - y[0]);
}

function mergePlayerItems(items, sieges, maxLines, now) {
  const lineCap = Math.max(0, Math.trunc(Number(maxLines) || 0));
  const bySystem = new Map();
  for (const s of sieges) {
    if (!bySystem.has(s.systemId)) bySystem.set(s.systemId, []);
    bySystem.get(s.systemId).push(s);
  }
  const out = items.map((item) => [...item]);
  const at = new Map(out.map((item, i) => [item[0], i]));
  for (const [systemId, list] of bySystem) {
    list.sort((x, y) => x.phaseEndsAt - y.phaseEndsAt || (x.siegeId < y.siegeId ? -1 : x.siegeId > y.siegeId ? 1 : 0));
    const lines = list.slice(0, lineCap).map((s) => `${s.siegeId} - player ${PLAYER_STATE_TEXT[s.state] || s.state}`
      + ` - A ${s.attackerFactionId} -> corp ${s.ownerCorpId} (type ${s.structureTypeId})`
      + ` - ${phaseLabel(s.phaseEndsAt, now)}`);
    if (list.length > lineCap && lineCap > 0) lines.push(`+${list.length - lineCap} more player`);
    if (at.has(systemId)) {
      const item = out[at.get(systemId)];
      item[3] = [...item[3], ...lines];
      continue;
    }
    const earliest = list[0];
    const assault = PLAYER_ASSAULT_STATES.includes(earliest.state);
    const label = `${earliest.attackerFactionId}v player${list.length > 1 ? ` ${MULTIPLY_SIGN}${list.length}` : ""}`;
    out.push([systemId, assault ? STYLE_PSIEGE_ASSAULT : STYLE_PSIEGE_TIMER, label, lines,
      [[earliest.attackerFactionId, 1]], assault ? "solid" : "dashed"]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function mergeRaidItems(items, raids, maxLines, now) {
  const lineCap = Math.max(0, Math.trunc(Number(maxLines) || 0));
  const bySystem = new Map();
  for (const r of Array.isArray(raids) ? raids : []) {
    if (!r) continue;
    if (!bySystem.has(r.systemId)) bySystem.set(r.systemId, []);
    bySystem.get(r.systemId).push(r);
  }
  const out = items.map((item) => [...item]);
  const at = new Map(out.map((item, i) => [item[0], i]));
  for (const [systemId, list] of bySystem) {
    list.sort((x, y) => x.wallDeadlineAt - y.wallDeadlineAt || (x.raidId < y.raidId ? -1 : x.raidId > y.raidId ? 1 : 0));
    const lines = list.slice(0, lineCap).map((r) => `${r.raidId} - raid ${r.state} - A ${r.attackerFactionId}`
      + ` -> corp ${r.ownerCorpId} (${r.targetKind}) - ${phaseLabel(r.wallDeadlineAt, now)} left`);
    if (list.length > lineCap && lineCap > 0) lines.push(`+${list.length - lineCap} more raid`);
    if (at.has(systemId)) {
      const item = out[at.get(systemId)];
      item[3] = [...item[3], ...lines];
      continue;
    }
    const earliest = list[0];
    const warned = earliest.state === "WARNED";
    const label = `${earliest.attackerFactionId}v raid${list.length > 1 ? ` ${MULTIPLY_SIGN}${list.length}` : ""}`;
    out.push([systemId, warned ? STYLE_HRAID_WARNED : STYLE_HRAID_RAIDING, label, lines,
      [[earliest.attackerFactionId, 1]], warned ? "dashed" : "solid"]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}

function buildSiegesLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxSieges = int(deps.maxSieges, 1);
  const maxSystems = int(deps.maxSystems, 0);
  const maxLines = int(deps.maxLines, 0);
  const refreshMs = int(deps.refreshMs, 1);
  const getPlayerSiege = typeof deps.getPlayerSiege === "function" ? deps.getPlayerSiege : () => null;
  const getHarvestRaid = typeof deps.getHarvestRaid === "function" ? deps.getHarvestRaid : () => null;

  function harvestRaidReady() {
    try {
      const hr = getHarvestRaid();
      return hr && typeof hr.getMode === "function" && typeof hr.listOpen === "function" && hr.getMode() === "ready"
        ? hr : null;
    } catch (_err) {
      return null;
    }
  }

  function playerSiegeReady() {
    try {
      const ps = getPlayerSiege();
      return ps && typeof ps.getMode === "function" && typeof ps.listOpen === "function" && ps.getMode() === "ready"
        ? ps : null;
    } catch (_err) {
      return null;
    }
  }

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

  const keyAt = (now) => `k${Math.floor(now / refreshMs)}`;

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const ps = playerSiegeReady();
    const hr = harvestRaidReady();
    const legend = (ps ? [...LEGEND, ...PLAYER_LEGEND] : LEGEND).map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 open sieges (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxySieges", (db) => {
      const open = repository.listOpen(db, { limit: maxSieges });
      if ((!ps && !hr) || !open || !open.ok) return open;
      let player = null;
      if (ps) {
        try {
          player = ps.listOpen(db, { limit: maxSieges });
        } catch (_err) {
          player = null;
        }
      }
      let raid = null;
      if (hr) {
        try {
          raid = hr.listOpen(db, { limit: maxSieges });
        } catch (_err) {
          raid = null;
        }
      }
      return { ...open, player: player && player.ok === true && Array.isArray(player.sieges) ? player : null,
        raid: raid && raid.ok === true && Array.isArray(raid.raids) ? raid : null };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const stationItems = toItems(read.sieges, maxLines, now);
    const playerItems = read.player ? mergePlayerItems(stationItems, read.player.sieges, maxLines, now) : stationItems;
    const items = read.raid ? mergeRaidItems(playerItems, read.raid.raids, maxLines, now) : playerItems;
    observe(nowMs() - t0);
    let note = `${read.sieges.length} open sieges in ${items.length} systems`;
    if (read.truncated) note = `${note} (truncated)`;
    if (read.player) {
      note = `${note}; ${read.player.sieges.length} player structure sieges${read.player.truncated ? " (truncated)" : ""}`;
    }
    if (!read.raid) return { available: true, key: keyAt(now), legend, items, note };
    note = `${note}; ${read.raid.raids.length} harvester raids${read.raid.truncated ? " (truncated)" : ""}`;
    const raids = read.raid.raids.slice(0, maxSieges).map((r) => ({ kind: RAID_KIND, raidId: r.raidId,
      systemId: r.systemId, state: r.state, targetKind: r.targetKind, ownerCorpId: r.ownerCorpId,
      attackerFactionId: r.attackerFactionId, creditedMs: r.creditedMs, wallDeadlineAt: r.wallDeadlineAt }));
    return { available: true, key: keyAt(now), legend: [...legend, ...RAID_LEGEND.map((l) => [...l])], items, note,
      raids };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Sieges", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, LAYER_ORDER, LEGEND, PLAYER_LEGEND, RAID_LEGEND, toItems, mergePlayerItems,
  mergeRaidItems, buildSiegesLayerView };