"use strict";

const { CORP_MARK } = require("./marks");
const { asciiName, LABEL_CHARS } = require("./wire");

const MAX_REASON = 60;

function createCorpMarks(deps) {
  const memo = new Map();
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const refreshMs = Math.max(1, deps.refreshMs);
  const maxTracked = Math.max(1, deps.maxTracked);

  function remember(key, value) {
    memo.delete(key);
    memo.set(key, value);
    while (memo.size > maxTracked) memo.delete(memo.keys().next().value);
  }

  function fetch(corpId, systemIds, now) {
    const lps = deps.getListeningPosts();
    if (!lps || typeof lps.markersFor !== "function") return { ok: false, reason: "LISTENING_POST_OFF" };
    let res;
    try {
      res = lps.markersFor(systemIds ? { corpId, systemIds: [...systemIds], now } : { corpId, now });
    } catch (err) {
      return { ok: false, reason: String((err && err.message) || err).slice(0, MAX_REASON) };
    }
    if (!res || res.ok !== true || !Array.isArray(res.markers)) {
      return { ok: false, reason: String((res && res.reason) || "NO_RESULT").slice(0, MAX_REASON) };
    }
    const bySystem = new Map();
    for (const m of res.markers) {
      if (!m || !Number.isSafeInteger(m.systemId) || !Number.isSafeInteger(m.count) || m.count <= 0) continue;
      bySystem.set(m.systemId, (bySystem.get(m.systemId) || 0) + m.count);
    }
    return { ok: true, bySystem };
  }

  function read(corpId, scope, id, systemIds) {
    const now = deps.clock.now();
    const bucket = Math.floor(now / refreshMs);
    const key = `${corpId}|${scope}|${id}`;
    const had = memo.get(key);
    if (had && had.bucket === bucket) {
      bump("mapCorpMarkHits");
      remember(key, had);
      return had.result;
    }
    bump("mapCorpMarkReads");
    const result = fetch(corpId, systemIds, now);
    if (!result.ok) bump("mapCorpMarkRefused");
    remember(key, { bucket, result });
    return result;
  }

  return { read, clear: () => memo.clear(), size: () => memo.size };
}

function mergeCorpMarks(entry, bySystem, limits) {
  const byIdx = new Map();
  for (const [systemId, count] of bySystem) {
    const idx = entry.nodeOf(systemId);
    if (!Number.isSafeInteger(idx) || idx < 0) continue;
    byIdx.set(idx, (byIdx.get(idx) || 0) + count);
  }
  const lp = [...byIdx].sort((a, b) => a[0] - b[0]).map(([idx, count]) => [CORP_MARK.kind, idx, count]);
  const maxMarkers = Math.max(0, limits.maxMarkers);
  const reserve = Math.min(lp.length, Math.max(0, limits.lpMaxMarkers), maxMarkers);
  if (reserve === 0) return { state: entry.state, truncMk: entry.trunc.mk, added: [] };
  const baseMk = entry.state.mk;
  const base = baseMk.slice(0, Math.max(0, maxMarkers - reserve));
  const added = lp.slice(0, reserve);
  const kinds = new Set(base.map((m) => m[0]));
  const mkl = entry.state.mkl.filter((row) => kinds.has(row[0]))
    .concat([[CORP_MARK.kind, asciiName(CORP_MARK.label, LABEL_CHARS), ...CORP_MARK.rgb]]);
  return {
    state: { ...entry.state, mk: base.concat(added), mkl },
    truncMk: entry.trunc.mk + (baseMk.length - base.length) + (lp.length - reserve),
    added,
  };
}

module.exports = { createCorpMarks, mergeCorpMarks };
