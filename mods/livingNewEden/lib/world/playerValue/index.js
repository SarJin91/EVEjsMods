"use strict";

const { VALUE_KINDS, kindOfStructure, systemValueOf } = require("./rules");

const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });
const FAMILIES = Object.freeze(["citadel", "engineering", "refinery", "flex"]);
const COUNTER_NAMES = Object.freeze(["indexBuilds", "indexTruncated", "seamRefused", "unknownKind", "premiumApplied",
  "premiumCapped"]);
const SENTRY_KINDS = Object.freeze({ sentry: "sentry", listening_post: "listeningPost", heavy_sentry: "heavySentry" });
const PLAYER_OWNER = "player";
const MAX_DETAIL = 120;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function startPlayerValue(deps) {
  const config = deps && deps.config;
  const P = config && config.playerValue;
  if (!P || P.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const adapter = deps.adapter || null;
  if (!adapter || typeof adapter !== "object") return { ok: false, reason: "adapter_unavailable" };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const weights = Object.freeze(Object.fromEntries(VALUE_KINDS.map((k) => [k,
    P.weight && Number.isSafeInteger(P.weight[k]) ? P.weight[k] : 0])));
  const caps = Object.freeze({ maxCountPerKind: P.maxCountPerKind, valueCap: P.valueCap });
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const loggedRefusals = new Set();
  let state = STATE.STARTING;
  let index = null;
  let sentryMemo = new Map();

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`playerValue: ${line}`);
    } catch (_err) {
    }
  }

  function count(name, n) {
    if (!COUNTER_NAMES.includes(name) || !(n > 0)) return;
    counters[name] += n;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`playerValue.${name}`, n);
    } catch (_err) {
    }
  }

  function gauge(name, value) {
    if (!telemetry || typeof telemetry.gauge !== "function") return;
    try {
      if (name === "indexBuildMs") telemetry.gauge("playerValue.indexBuildMs", value);
      else if (name === "systemsValued") telemetry.gauge("playerValue.systemsValued", value);
    } catch (_err) {
    }
  }

  function refused(source, r) {
    count("seamRefused", 1);
    const reason = String((r && r.reason) || "NO_RESULT");
    const key = `${source}:${reason}`;
    if (loggedRefusals.has(key)) return;
    loggedRefusals.add(key);
    log(`${source} refused (${reason}${r && r.detail ? `: ${String(r.detail).slice(0, MAX_DETAIL)}` : ""}) - `
      + "no value from it (logged once)");
  }

  function virtualOf(corpId) {
    const vc = typeof deps.getVirtualCorps === "function" ? call(deps.getVirtualCorps, null) : null;
    if (!vc || typeof vc.isVirtualCorporation !== "function") return false;
    return call(() => vc.isVirtualCorporation(corpId) === true, false);
  }

  function add(bySystem, systemId, kind) {
    if (!bySystem.has(systemId)) bySystem.set(systemId, {});
    const c = bySystem.get(systemId);
    c[kind] = (c[kind] || 0) + 1;
  }

  function build(at) {
    const started = nowMs();
    const bySystem = new Map();
    let truncated = false;
    const seam = call(() => adapter.playerStructures, null);
    const s = seam && typeof seam.listCandidates === "function"
      ? call(() => seam.listCandidates({ nowMs: at, ttlMs: P.indexTtlMs, families: [...FAMILIES],
        maxStructures: P.maxIndexStructures }), null)
      : { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE" };
    if (s && s.ok === true && s.bySystem instanceof Map) {
      truncated = truncated || s.truncated === true;
      for (const [systemId, list] of s.bySystem) {
        if (!isId(systemId)) continue;
        for (const summary of Array.isArray(list) ? list : []) {
          if (!summary || virtualOf(summary.ownerCorpId)) continue;
          const kind = kindOfStructure(summary);
          if (kind !== null) add(bySystem, systemId, kind);
        }
      }
    } else refused("playerStructures", s);
    if (P.maxIndexSkyhooks > 0) {
      const hooks = call(() => adapter.playerSkyhooks, null);
      const h = hooks && typeof hooks.listPlayerSkyhooks === "function"
        ? call(() => hooks.listPlayerSkyhooks({ max: P.maxIndexSkyhooks }), null)
        : { ok: false, reason: "PLAYER_SKYHOOKS_SEAM_UNAVAILABLE" };
      if (h && h.ok === true && Array.isArray(h.skyhooks)) {
        truncated = truncated || h.truncated === true;
        for (const k of h.skyhooks) {
          if (!k || k.active !== true || k.destroyed === true || !isId(k.systemId) || virtualOf(k.corpId)) continue;
          add(bySystem, k.systemId, "skyhook");
        }
      } else refused("playerSkyhooks", h);
    }
    index = { at, bySystem, truncated };
    sentryMemo = new Map();
    count("indexBuilds", 1);
    if (truncated) count("indexTruncated", 1);
    let valued = 0;
    for (const c of bySystem.values()) if (systemValueOf(c, weights, caps).value > 0) valued += 1;
    gauge("systemsValued", valued);
    gauge("indexBuildMs", Math.max(0, Math.round(nowMs() - started)));
  }

  function ensureIndex(at) {
    if (index === null || at < index.at || at - index.at >= P.indexTtlMs) build(at);
  }

  function sentryCounts(systemId) {
    if (sentryMemo.has(systemId)) return sentryMemo.get(systemId);
    const out = {};
    const sentries = typeof deps.getSentries === "function" ? call(deps.getSentries, null) : null;
    const refs = sentries && typeof sentries.listLiveInSystem === "function"
      ? call(() => sentries.listLiveInSystem(systemId), []) : [];
    const kindOf = sentries && typeof sentries.kindOf === "function" ? sentries.kindOf : null;
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (!ref || ref.ownerKind !== PLAYER_OWNER) continue;
      const answer = kindOf === null ? "sentry" : call(() => kindOf(ref), null);
      if (typeof answer !== "string" || !hasOwn(SENTRY_KINDS, answer)) {
        count("unknownKind", 1);
        continue;
      }
      const kind = SENTRY_KINDS[answer];
      out[kind] = (out[kind] || 0) + 1;
    }
    sentryMemo.set(systemId, out);
    return out;
  }

  function valueAt(systemId) {
    const base = index.bySystem.get(systemId) || {};
    const counts = { ...base };
    for (const [kind, n] of Object.entries(sentryCounts(systemId))) counts[kind] = (counts[kind] || 0) + n;
    return systemValueOf(counts, weights, caps);
  }

  function valueOf(systemId, at) {
    const zero = { value: 0, capped: false };
    if (state !== STATE.RUNNING || !isId(systemId) || !Number.isSafeInteger(at)) return zero;
    try {
      ensureIndex(at);
      return valueAt(systemId);
    } catch (err) {
      refused("index", { reason: "THREW", detail: messageOf(err) });
      return zero;
    }
  }

  function snapshotFor(systemIds, at) {
    const out = new Map();
    if (state !== STATE.RUNNING || !Number.isSafeInteger(at)) return out;
    try {
      ensureIndex(at);
      const ids = systemIds === null ? [...index.bySystem.keys()] : (Array.isArray(systemIds) ? systemIds : []);
      for (const id of [...new Set(ids)].filter(isId).sort((a, b) => a - b)) {
        const v = valueAt(id);
        if (v.value > 0) out.set(id, v.value);
      }
    } catch (err) {
      refused("index", { reason: "THREW", detail: messageOf(err) });
      return new Map();
    }
    return out;
  }

  function notePremium(applied, capped) {
    if (state !== STATE.RUNNING) return;
    if (Number.isSafeInteger(applied)) count("premiumApplied", applied);
    if (Number.isSafeInteger(capped)) count("premiumCapped", capped);
  }

  state = STATE.RUNNING;
  log(`running ttlMs=${P.indexTtlMs} valueCap=${P.valueCap} maxCountPerKind=${P.maxCountPerKind} `
    + `unclaimedPermille=${P.unclaimedPermille}`);
  return {
    ok: true,
    playerValue: Object.freeze({
      valueOf,
      snapshotFor,
      notePremium,
      getStatus: () => ({ state, index: index === null ? null
        : { at: index.at, systems: index.bySystem.size, truncated: index.truncated }, counters: { ...counters } }),
      stop() {
        state = STATE.STOPPED;
        index = null;
        sentryMemo = new Map();
      },
    }),
  };
}

module.exports = { startPlayerValue, COUNTER_NAMES, FAMILIES, SENTRY_KINDS };
