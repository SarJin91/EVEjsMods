"use strict";

const ACTIVE_STATES = Object.freeze(new Set(["seeded", "active", "paused"]));
const GROUPS = Object.freeze(["seeded", "active", "paused", "terminal"]);

const SUMMARY_FIELDS = Object.freeze([
  "instanceID", "templateID", "solarSystemID", "siteKey", "lifecycleState", "lifecycleReason",
  "instanceScope", "siteFamily", "spawnFamilyKey", "siteKind", "siteOrigin", "source",
  "sourceDungeonID", "archetypeID", "factionID", "difficulty", "entryObjectTypeID", "dungeonNameID",
  "position", "ownership", "timers", "roomCount", "gateCount", "completedObjectiveCount",
  "runtimeFlags", "metadata",
]);

const PARITY_DETAIL_MAX = 200;

function buildSummary(instance, deps) {
  return Object.freeze({
    instanceID: instance.instanceID,
    templateID: instance.templateID,
    solarSystemID: instance.solarSystemID,
    siteKey: instance.siteKey,
    lifecycleState: instance.lifecycleState,
    lifecycleReason: instance.lifecycleReason,
    instanceScope: instance.instanceScope,
    siteFamily: instance.siteFamily,
    spawnFamilyKey: deps.resolveSpawnFamilyKey(instance),
    siteKind: instance.siteKind,
    siteOrigin: instance.siteOrigin,
    source: instance.source,
    sourceDungeonID: instance.sourceDungeonID,
    archetypeID: instance.archetypeID,
    factionID: instance.factionID,
    difficulty: instance.difficulty,
    entryObjectTypeID: instance.entryObjectTypeID,
    dungeonNameID: instance.dungeonNameID,
    position: instance.position,
    ownership: instance.ownership,
    timers: instance.timers,
    roomCount: Object.keys(instance.roomStatesByKey || {}).length,
    gateCount: Object.keys(instance.gateStatesByKey || {}).length,
    completedObjectiveCount: Array.isArray(instance.objectiveState && instance.objectiveState.completedObjectiveIDs)
      ? instance.objectiveState.completedObjectiveIDs.length
      : 0,
    runtimeFlags: instance.runtimeFlags,
    metadata: instance.metadata,
  });
}

function compareLists(label, indexList, vendorList) {
  const fit = (text) => (text.length > PARITY_DETAIL_MAX ? text.slice(0, PARITY_DETAIL_MAX) : text);
  if (!Array.isArray(vendorList)) return fit(`${label} vendorNotArray`);
  const lenA = indexList.length;
  const lenB = vendorList.length;
  const n = Math.max(lenA, lenB);
  for (let i = 0; i < n; i += 1) {
    const a = indexList[i];
    const b = vendorList[i];
    const idA = a ? a.instanceID : undefined;
    const idB = b ? b.instanceID : undefined;
    if (idA !== idB) {
      return fit(`${label} lenIndex=${lenA} lenVendor=${lenB} firstDiff=${idA !== undefined ? idA : idB} keys=instanceID`);
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const keys = [...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])]
        .filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b && b[key]));
      return fit(`${label} lenIndex=${lenA} lenVendor=${lenB} firstDiff=${idA} keys=${keys.join(",") || "order"}`);
    }
  }
  return null;
}

function defaultNow() {
  return process.hrtime.bigint();
}

function emptyGroups() {
  const groups = {};
  for (const name of GROUPS) {
    groups[name] = { idSet: new Set(), ids: [], list: [], membershipDirty: false, valuesDirty: false };
  }
  return groups;
}

function emptyWindow() {
  return { served: 0, fallbackByReason: new Map(), refreshes: 0, refreshMaxMs: 0, changedMax: 0, parityChecks: 0 };
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfIndex", { value: original });
  return wrapper;
}

function createDungeonActiveIndex(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || defaultNow;
  const maxEntries = config.dungeonIndexMaxEntries;
  const priv = {
    deps: null,
    disabledReason: null,
    depth: 0,
    stateRef: null,
    generation: 0,
    entries: new Map(),
    groups: emptyGroups(),
    firstBuildMs: null,
    window: emptyWindow(),
  };

  function elapsedMs(started) {
    return Number(now() - started) / 1e6;
  }

  function noteFallback(reason) {
    const map = priv.window.fallbackByReason;
    map.set(reason, (map.get(reason) || 0) + 1);
  }

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    priv.entries = new Map();
    priv.groups = emptyGroups();
    priv.stateRef = null;
    log(`WARN dungeonIndex disabled: ${reason}${detail ? ` (${detail})` : ""}`);
  }

  function setDeps(stateModuleExports) {
    if (priv.deps) return true;
    const m = stateModuleExports;
    if (!m || typeof m !== "object") return false;
    if (typeof m.loadState !== "function" ||
        typeof m.resolveInstanceSpawnFamilyKey !== "function" ||
        typeof m.isUniversePersistentInstance !== "function") {
      return false;
    }
    priv.deps = {
      loadState: () => m.loadState(),
      resolveSpawnFamilyKey: (record) => m.resolveInstanceSpawnFamilyKey(record),
      isUniversePersistent: (record) => m.isUniversePersistentInstance(record),
    };
    return true;
  }

  function groupOf(record) {
    if (ACTIVE_STATES.has(record.lifecycleState)) return record.lifecycleState;
    return priv.deps.isUniversePersistent(record) ? "terminal" : null;
  }

  function removeEntry(id, entry) {
    const group = priv.groups[entry.group];
    group.idSet.delete(id);
    group.membershipDirty = true;
    priv.entries.delete(id);
  }

  function refresh() {
    let cur;
    try {
      cur = priv.deps.loadState();
    } catch (_error) {
      return { ok: false, reason: "LOAD_STATE_FAILED" };
    }
    if (!cur || typeof cur !== "object" || !cur.instancesByID || typeof cur.instancesByID !== "object") {
      return { ok: false, reason: "BAD_STATE" };
    }
    if (priv.stateRef && priv.stateRef.deref() === cur) return { ok: true };
    const started = now();
    const gen = priv.generation + 1;
    priv.generation = gen;
    let changed = 0;
    let live = 0;
    const byID = cur.instancesByID;
    for (const key of Object.keys(byID)) {
      const rec = byID[key];
      if (!rec || typeof rec !== "object") continue;
      const id = rec.instanceID;
      const entry = priv.entries.get(id);
      if (entry && entry.record === rec) {
        entry.gen = gen;
        live += 1;
        continue;
      }
      const g = groupOf(rec);
      if (!g) {
        if (entry) removeEntry(id, entry);
        continue;
      }
      if (!entry && live >= maxEntries) {
        disable("limit", `entries>=${maxEntries}`);
        return { ok: false, reason: "LIMIT" };
      }
      const summary = buildSummary(rec, priv.deps);
      changed += 1;
      if (entry) {
        if (entry.group !== g) {
          removeEntry(id, entry);
          priv.groups[g].idSet.add(id);
          priv.groups[g].membershipDirty = true;
        } else {
          priv.groups[g].valuesDirty = true;
        }
      } else {
        priv.groups[g].idSet.add(id);
        priv.groups[g].membershipDirty = true;
      }
      priv.entries.set(id, { record: rec, summary, group: g, gen });
      live += 1;
    }
    if (live > maxEntries) {
      disable("limit", `entries>${maxEntries}`);
      return { ok: false, reason: "LIMIT" };
    }
    for (const [id, entry] of priv.entries) {
      if (entry.gen !== gen) removeEntry(id, entry);
    }
    priv.stateRef = new WeakRef(cur);
    const ms = elapsedMs(started);
    const w = priv.window;
    w.refreshes += 1;
    if (ms > w.refreshMaxMs) w.refreshMaxMs = ms;
    if (changed > w.changedMax) w.changedMax = changed;
    if (priv.firstBuildMs === null) priv.firstBuildMs = ms;
    return { ok: true };
  }

  function groupList(name) {
    const group = priv.groups[name];
    if (group.membershipDirty) group.ids = [...group.idSet].sort((left, right) => left - right);
    if (group.membershipDirty || group.valuesDirty) {
      group.list = group.ids.map((id) => priv.entries.get(id).summary);
      group.membershipDirty = false;
      group.valuesDirty = false;
    }
    return group.list.slice();
  }

  function listGroup(name) {
    if (priv.disabledReason) return { ok: false, reason: "DISABLED" };
    if (!priv.deps) return { ok: false, reason: "NOT_READY" };
    try {
      const r = refresh();
      if (!r.ok) return r;
      return { ok: true, list: groupList(name) };
    } catch (error) {
      disable("error", String(error && error.message || error).slice(0, PARITY_DETAIL_MAX));
      return { ok: false, reason: "ERROR" };
    }
  }

  function listLifecycle(state) {
    return listGroup(state);
  }

  function listTerminal() {
    return listGroup("terminal");
  }

  function serve(label, groupName, original, thisArg, args) {
    const r = listGroup(groupName);
    if (!r.ok) {
      noteFallback(r.reason);
      return original.apply(thisArg, args);
    }
    if (config.dungeonIndexParityCheck === true) {
      const vendor = original.apply(thisArg, args);
      priv.window.parityChecks += 1;
      let diff;
      try {
        diff = compareLists(label, r.list, vendor);
      } catch (error) {
        diff = `${label} compareError=${String(error && error.message || error)}`;
      }
      if (diff) {
        disable("parity", diff);
        return vendor;
      }
    }
    priv.window.served += 1;
    return r.list;
  }

  function wrapScope(original) {
    const wrapped = function hotPathPerfIndexScope() {
      priv.depth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.depth -= 1;
      }
    };
    return markWrapped(wrapped, original);
  }

  function wrapLifecycleReader(original) {
    const wrapped = function hotPathPerfIndexedLifecycle(state, options) {
      if (priv.depth === 0) return original.apply(this, arguments);
      if (arguments.length > 1 && options !== undefined) return original.apply(this, arguments);
      if (typeof state !== "string" || !ACTIVE_STATES.has(state)) return original.apply(this, arguments);
      return serve(`state=${state}`, state, original, this, arguments);
    };
    return markWrapped(wrapped, original);
  }

  function wrapTerminalReader(original) {
    const wrapped = function hotPathPerfIndexedTerminal() {
      if (priv.depth === 0) return original.apply(this, arguments);
      if (!(arguments.length === 0 || arguments[0] === undefined)) return original.apply(this, arguments);
      return serve("state=terminal", "terminal", original, this, arguments);
    };
    return markWrapped(wrapped, original);
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      ready: priv.disabledReason === null && priv.deps !== null,
      disabledReason: priv.disabledReason,
      depth: priv.depth,
    };
  }

  function entryCounts() {
    const counts = {};
    for (const name of GROUPS) counts[name] = priv.groups[name].idSet.size;
    return counts;
  }

  function statsSnapshot() {
    const w = priv.window;
    return {
      ...status(),
      entries: entryCounts(),
      size: priv.entries.size,
      served: w.served,
      fallbackByReason: new Map(w.fallbackByReason),
      refreshes: w.refreshes,
      refreshMaxMs: w.refreshMaxMs,
      changedMax: w.changedMax,
      firstBuildMs: priv.firstBuildMs,
      parityChecks: w.parityChecks,
      generation: priv.generation,
    };
  }

  function drainStatsLines() {
    const w = priv.window;
    const counts = entryCounts();
    const stateText = priv.disabledReason ? `disabled:${priv.disabledReason}` : (priv.deps ? "ready" : "waiting");
    const fallback = [...w.fallbackByReason].map(([reason, n]) => `${reason}:${n}`).join(",") || "0";
    const line = `stats dungeonIndex state=${stateText} ` +
      `entries=${GROUPS.map((name) => `${name}:${counts[name]}`).join(",")} ` +
      `served=${w.served} fallback=${fallback} refreshes=${w.refreshes} refreshMaxMs=${w.refreshMaxMs.toFixed(1)} ` +
      `changedMax=${w.changedMax} firstBuildMs=${priv.firstBuildMs === null ? "-" : priv.firstBuildMs.toFixed(1)} ` +
      `parityChecks=${w.parityChecks}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setDeps, wrapScope, wrapLifecycleReader, wrapTerminalReader,
    listLifecycle, listTerminal, disable, status, statsSnapshot, drainStatsLines,
  };
}

module.exports = { createDungeonActiveIndex, buildSummary, compareLists, SUMMARY_FIELDS, ACTIVE_STATES, GROUPS };
