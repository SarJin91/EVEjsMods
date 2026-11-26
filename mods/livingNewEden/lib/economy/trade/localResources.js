"use strict";

const DRIFT = "LOCAL_RESOURCES_DRIFT";
const FAILED = "LOCAL_RESOURCES_FAILED";
const METRIC_READ = "trade.localResourcesRead";
const METRIC_DRIFT = "trade.localResourcesDrift";
const METRIC_FAILED = "trade.localResourcesFailed";
const METRIC_UNREADABLE = "trade.localResourcesUnreadable";
const MAX_ISSUES = 8;
const MAX_DETAIL_LENGTH = 200;
const MAX_FAMILIES = 64;
const MAX_FAMILY_LENGTH = 32;
const SOURCE_RANK = Object.freeze({ belt: 0, anomaly: 1 });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);

function intIn(value, def, min, max) {
  return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : def;
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function log(logger, line) {
  if (logger && typeof logger.log === "function") {
    try { logger.log(line); } catch (_err) {}
  }
}

function uniqueIds(ids) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!isId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function createLocalResources(deps) {
  const cfg = (deps.config && deps.config.trade) || {};
  const jumps = intIn(cfg.localOreJumps, 1, 0, 3);
  const maxPerRead = intIn(cfg.localResourcesMaxSystemsPerRead, 16, 1, 256);
  const warmMax = intIn(cfg.localResourcesWarmMaxSystems, 2048, 0, 8490);
  const includeAnomalies = cfg.localOreIncludeAnomalies === true;
  const maxFailures = intIn(cfg.localResourcesMaxFailures, 3, 1, 100);
  const ORE_TYPES = (deps.oreTypes && deps.oreTypes.ORE_TYPES) || {};
  const FAMILY_BY_BASE = (deps.oreTypes && deps.oreTypes.FAMILY_BY_BASE) || {};
  const baseByFamily = new Map(Object.entries(FAMILY_BY_BASE).map(([id, name]) => [name, Number(id)]));
  const families = [...baseByFamily.keys()].filter((n) => n.length <= MAX_FAMILY_LENGTH).sort().slice(0, MAX_FAMILIES);
  const clock = deps.clock;
  const now = () => { try { return clock.now(); } catch (_err) { return null; } };

  const st = { state: "ready", reason: null, seq: 0, calls: 0, lastRefusal: null, lastIssues: [] };
  const driftSeen = new Set();
  const cache = new Map();
  const suspects = new Map();
  const unreadable = new Set();
  let suspectOrder = 0;

  function currentGraph() {
    try {
      const g = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      return g && typeof g.getNeighbors === "function" ? g : null;
    } catch (_err) {
      return null;
    }
  }

  function radiusOf(id, graph) {
    const out = [{ systemId: id, distance: 0 }];
    if (!graph || jumps === 0) return out;
    const seen = new Set([id]);
    let frontier = [id];
    for (let d = 1; d <= jumps && frontier.length > 0; d += 1) {
      const next = [];
      for (const at of frontier) {
        let neighbors = null;
        try { neighbors = graph.getNeighbors(at); } catch (_err) { neighbors = null; }
        for (const n of Array.isArray(neighbors) ? neighbors : []) {
          if (!isId(n) || seen.has(n)) continue;
          seen.add(n);
          next.push(n);
        }
      }
      next.sort((a, b) => a - b);
      for (const n of next) out.push({ systemId: n, distance: d });
      frontier = next;
    }
    return out;
  }

  function recordOf(sys) {
    const bases = [];
    let unknown = 0;
    for (const ore of Array.isArray(sys.ores) ? sys.ores : []) {
      const row = ORE_TYPES[String(ore.typeId)];
      if (!row) unknown += 1;
      else if (!bases.includes(row.baseTypeId)) bases.push(row.baseTypeId);
    }
    const anomaly = sys.anomaly && typeof sys.anomaly.tier === "string"
      ? Object.freeze({ tier: sys.anomaly.tier, families: Object.freeze([...(sys.anomaly.families || [])]) }) : null;
    const anomalyBases = anomaly
      ? anomaly.families.map((f) => baseByFamily.get(f)).filter((b) => b !== undefined) : [];
    const ice = sys.ice && Array.isArray(sys.ice.typeIds)
      ? Object.freeze(sys.ice.typeIds.map((typeId, i) => Object.freeze({ typeId,
        name: sys.ice.typeIds.length === (sys.ice.names || []).length ? sys.ice.names[i] : null })))
      : null;
    return Object.freeze({ systemId: sys.systemId, beltCount: sys.beltCount, poolSource: sys.poolSource,
      bases: Object.freeze(bases), unknownTypeIds: unknown, ice, anomaly, anomalyBases: Object.freeze(anomalyBases) });
  }

  function refusal(reason, detail) {
    st.lastRefusal = Object.freeze({ reason, detail: String(detail === undefined ? "" : detail).slice(0, MAX_DETAIL_LENGTH),
      at: now() });
  }

  function noteFailed(batch) {
    if (batch.length === 1) {
      const id = batch[0];
      const failures = (suspects.has(id) ? suspects.get(id).failures : 0) + 1;
      if (failures >= maxFailures) {
        suspects.delete(id);
        unreadable.add(id);
        metric(deps.telemetry, METRIC_UNREADABLE, 1);
        log(deps.logger, `trade: local resources system ${id} unreadable until restart - ${failures} failed reads`);
        return;
      }
      suspectOrder += 1;
      suspects.set(id, { failures, order: suspectOrder });
      return;
    }
    for (const id of batch) {
      suspectOrder += 1;
      suspects.set(id, { failures: suspects.has(id) ? suspects.get(id).failures : 0, order: suspectOrder });
    }
  }

  function nextBatch(missing) {
    const fresh = missing.filter((id) => !suspects.has(id));
    if (fresh.length > 0) return fresh.slice(0, maxPerRead);
    let first = missing[0];
    for (const id of missing) if (suspects.get(id).order < suspects.get(first).order) first = id;
    return [first];
  }

  function readBatch(batch) {
    st.calls += 1;
    let r;
    try {
      r = deps.readLocalResources(batch, families);
    } catch (err) {
      r = { ok: false, reason: FAILED, detail: messageOf(err) };
    }
    if (!r || r.ok !== true || !(r.systems instanceof Map)) {
      const reason = r && r.reason === DRIFT ? DRIFT : FAILED;
      const detail = (r && r.detail) || (r && r.ok === true ? "systems" : "no result");
      refusal(reason, detail);
      if (reason === DRIFT) {
        st.state = "drift";
        st.reason = DRIFT;
        metric(deps.telemetry, METRIC_DRIFT, 1);
        log(deps.logger, `trade: local resources off until restart - ${DRIFT} ${detail}`);
      } else {
        metric(deps.telemetry, METRIC_FAILED, 1);
        noteFailed(batch);
      }
      return { ok: false, reason };
    }
    let added = 0;
    for (const id of batch) {
      const sys = r.systems.get(id);
      if (!sys || cache.has(id)) continue;
      cache.set(id, recordOf(sys));
      suspects.delete(id);
      added += 1;
    }
    if (added > 0) {
      st.seq += 1;
      metric(deps.telemetry, METRIC_READ, added);
    }
    const drift = Array.isArray(r.drift) ? r.drift : [];
    if (drift.length > 0) {
      metric(deps.telemetry, METRIC_DRIFT, 1);
      for (const name of drift) {
        if (driftSeen.has(name)) continue;
        driftSeen.add(name);
        log(deps.logger, `trade: local resources drift ${name}`);
      }
    }
    if (Array.isArray(r.issues) && r.issues.length > 0) st.lastIssues = r.issues.slice(0, MAX_ISSUES);
    return { ok: true, added };
  }

  function viewOf(id, radius, graphReady) {
    const self = cache.get(id) || null;
    let pending = false;
    let unknown = false;
    const ores = new Map();
    const ice = new Map();
    const offer = (baseTypeId, distance, source) => {
      const prev = ores.get(baseTypeId);
      if (prev && (prev.distance < distance
        || (prev.distance === distance && SOURCE_RANK[prev.source] <= SOURCE_RANK[source]))) return;
      ores.set(baseTypeId, { baseTypeId, family: FAMILY_BY_BASE[String(baseTypeId)] || null, distance, source });
    };
    for (const { systemId, distance } of radius) {
      const rec = cache.get(systemId);
      if (!rec) {
        if (unreadable.has(systemId)) unknown = true;
        else pending = true;
        continue;
      }
      for (const b of rec.bases) offer(b, distance, "belt");
      if (includeAnomalies) for (const b of rec.anomalyBases) offer(b, distance, "anomaly");
      for (const row of rec.ice || []) {
        const prev = ice.get(row.typeId);
        if (!prev || prev.distance > distance) ice.set(row.typeId, { typeId: row.typeId, name: row.name, distance });
      }
    }
    return {
      systemId: id,
      graphReady,
      pending,
      unknown,
      beltCount: self ? self.beltCount : null,
      poolSource: self ? self.poolSource : null,
      ores: [...ores.values()].sort((a, b) => a.distance - b.distance
        || SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.baseTypeId - b.baseTypeId),
      ice: [...ice.values()].sort((a, b) => a.distance - b.distance || a.typeId - b.typeId),
      anomaly: self && self.anomaly ? { tier: self.anomaly.tier, families: [...self.anomaly.families] } : null,
      unknownTypeIds: self ? self.unknownTypeIds : 0,
    };
  }

  function localResourcesFor(systemIds, opts) {
    if (st.state !== "ready") return null;
    const read = !(opts && opts.read === false);
    const ids = uniqueIds(systemIds);
    const graph = currentGraph();
    const radii = ids.map((id) => radiusOf(id, graph));
    if (read) {
      const missing = [];
      const seen = new Set();
      for (const radius of radii) {
        for (const { systemId } of radius) {
          if (cache.has(systemId) || seen.has(systemId) || unreadable.has(systemId)) continue;
          seen.add(systemId);
          missing.push(systemId);
        }
      }
      if (missing.length > 0) {
        readBatch(nextBatch(missing));
        if (st.state !== "ready") return null;
      }
    }
    const out = new Map();
    ids.forEach((id, i) => out.set(id, viewOf(id, radii[i], graph !== null)));
    return out;
  }

  function warm(systemIds) {
    const t0 = now();
    const msOf = () => { const t1 = now(); return Number.isFinite(t0) && Number.isFinite(t1) ? Math.max(0, t1 - t0) : 0; };
    if (st.state === "stopped") return { ok: false, reason: "STOPPED", requested: 0, read: 0, truncated: false, ms: 0 };
    if (st.state === "drift") return { ok: false, reason: DRIFT, requested: 0, read: 0, truncated: false, ms: 0 };
    const graph = currentGraph();
    const all = [];
    const seen = new Set();
    for (const id of uniqueIds(systemIds)) {
      for (const { systemId } of radiusOf(id, graph)) {
        if (seen.has(systemId)) continue;
        seen.add(systemId);
        all.push(systemId);
      }
    }
    const truncated = all.length > warmMax;
    const list = all.slice(0, warmMax).filter((id) => !cache.has(id) && !unreadable.has(id));
    let readCount = 0;
    for (let i = 0; i < list.length; i += maxPerRead) {
      if (st.state !== "ready") break;
      const r = readBatch(list.slice(i, i + maxPerRead));
      if (!r.ok) return { ok: false, reason: r.reason, requested: list.length, read: readCount, truncated, ms: msOf() };
      readCount += r.added;
    }
    return { ok: true, requested: list.length, read: readCount, truncated, ms: msOf() };
  }

  function getStatus() {
    return {
      state: st.state,
      reason: st.reason,
      seq: st.seq,
      calls: st.calls,
      cached: cache.size,
      suspects: suspects.size,
      unreadable: [...unreadable].sort((a, b) => a - b),
      graphReady: currentGraph() !== null,
      jumps,
      maxSystemsPerRead: maxPerRead,
      warmMaxSystems: warmMax,
      includeAnomalies,
      lastRefusal: st.lastRefusal,
      lastIssues: st.lastIssues,
      drift: [...driftSeen],
    };
  }

  function stop() {
    st.state = "stopped";
    st.reason = "stopped";
  }

  return { localResourcesFor, warm, getStatus, stop };
}

module.exports = { createLocalResources, LOCAL_RESOURCES_DRIFT: DRIFT, LOCAL_RESOURCES_FAILED: FAILED };
