"use strict";

const { performance } = require("node:perf_hooks");
const { FACTION_AGGREGATE } = require("./schema");

const TRIM_EVENT = "STRATEGY_TERRITORY_TRIM";
const SYSTEM_EVENT = "STRATEGY_TRIM_SYSTEM";
const STALE = "TRIM_STALE";
const STABLE = "STABLE";
const READY = "ready";
const MAX_BATCH = 64;
const MAX_REASON_LENGTH = 120;
const MS_DECIMALS = 100;
const COUNTER_NAMES = Object.freeze(["batches", "batchesSkipped", "planned", "trimmed", "noop", "skipped",
  "refused", "duplicate", "done"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const trimKey = (f, systemId) => `strategy:trim:v1:${f}:${systemId}`;
const batchKey = (f, round) => `strategy:trim:v1:${f}:batch:${round}`;
const doneKey = (f) => `strategy:trim:v1:done:${f}`;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createTerritoryTrimService(deps) {
  const { journal, config } = deps;
  const S = config.strategy;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const cursors = new Map();
  const doneFactions = new Set();
  let lastRefusal = null;
  let stopped = false;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, metricName, n = 1) {
    if (n <= 0) return;
    counters[name] += n;
    if (metricName) metric("count", metricName, n);
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function occupationService() {
    const occ = typeof deps.getOccupation === "function" ? call(deps.getOccupation, null) : null;
    if (!occ || typeof occ.abandonInTx !== "function" || typeof occ.getStatus !== "function") return null;
    return call(() => occ.getStatus().state, null) === READY ? occ : null;
  }

  function stationRepository() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    return st && st.repository && typeof st.repository.countLiveBySystem === "function" ? st.repository : null;
  }

  function validPayload(p) {
    if (!p || typeof p !== "object" || !isId(p.factionId) || !Number.isSafeInteger(p.round)
      || !Array.isArray(p.systemIds) || Object.keys(p).some((k) => !["factionId", "round", "systemIds"].includes(k))) {
      return false;
    }
    const ids = p.systemIds;
    return ids.length >= 1 && ids.length <= MAX_BATCH && ids.every(isId) && new Set(ids).size === ids.length;
  }

  function trimSystem(tx, f, systemId, at, occ, stations, worldRepo, out) {
    const res = journal.applyOnce(tx, { key: `${trimKey(f, systemId)}:w`,
      aggregate: { type: FACTION_AGGREGATE, id: String(f) }, eventType: SYSTEM_EVENT,
      payload: { factionId: f, systemId } }, (db) => {
      const r = deps.worldRepository.getSystem(db, systemId, { includeInfluence: false });
      if (!r || !r.ok) return r || { ok: false, reason: "WORLD_READ_FAILED" };
      const s = r.system;
      if (!s || s.controllerFactionId !== f || s.capturedAt !== null || s.occupationState !== STABLE) {
        return { ok: false, reason: STALE };
      }
      if (stations) {
        const c = stations.countLiveBySystem(db, [systemId]);
        if (!c || !c.ok) return c || { ok: false, reason: "STATIONS_READ_FAILED" };
        if (c.rows.some((x) => x.factionId === f && x.count > 0)) return { ok: false, reason: STALE };
      }
      const a = occ.abandonInTx(db, { systemId, at, factionId: f }, trimKey(f, systemId));
      if (!a.ok) return a;
      const h = worldRepo.clearHomeInTx(db, systemId, f);
      if (!h.ok) return h;
      return a;
    });
    if (res.ok && res.duplicate) {
      out.duplicate += 1;
      return;
    }
    if (res.ok) {
      if (res.value && res.value.duplicate === true) out.duplicate += 1;
      else if (res.value && res.value.changed === true) out.trimmed += 1;
      else out.noop += 1;
      return;
    }
    const refusal = res.reason === "APPLY_REFUSED" ? res.refusal : res;
    const reason = String((refusal && refusal.reason) || "REFUSED");
    if (reason === STALE) {
      out.skipped += 1;
      return;
    }
    out.refused += 1;
    out.lastRefusal = `${systemId}:${reason}`;
    if (res.reason === "APPLY_FAILED") {
      log(`strategy: trim ${f} system ${systemId} failed ${res.code || ""} `
        + `${String((res.error && res.error.message) || res.error).slice(0, MAX_REASON_LENGTH)}`);
    }
  }

  function handler(ev, hctx) {
    try {
      const p = ev && ev.payload;
      if (!validPayload(p)) return { ok: false, reason: "TRIM_PAYLOAD_INVALID", permanent: true };
      if (stopped) return { ok: false, reason: "STRATEGY_STOPPED" };
      const occ = occupationService();
      const world = deps.worldRepository;
      if (S.territoryTrimEnabled !== true || !occ || !world || typeof world.getSystem !== "function") {
        return { ok: true, outcome: "SKIPPED", onCommitted: () => bump("batchesSkipped") };
      }
      const f = p.factionId;
      const at = hctx && Number.isSafeInteger(hctx.anchorAt) ? hctx.anchorAt : ev.dueAt;
      const stations = stationRepository();
      return { ok: true, outcome: "DONE",
        effect: (tx) => {
          const t0 = nowMs();
          const out = { ok: true, trimmed: 0, noop: 0, skipped: 0, refused: 0, duplicate: 0, lastRefusal: null };
          for (const systemId of p.systemIds) trimSystem(tx, f, systemId, at, occ, stations, world, out);
          out.ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
          return out;
        },
        onCommitted: (out) => {
          if (!out) return;
          bump("batches");
          bump("trimmed", "strategy.trimmed", out.trimmed);
          bump("noop", null, out.noop);
          bump("skipped", "strategy.trimSkipped", out.skipped);
          bump("refused", "strategy.trimRefused", out.refused);
          bump("duplicate", null, out.duplicate);
          metric("observe", "strategy.trimBatchMs", out.ms);
          if (out.lastRefusal) lastRefusal = out.lastRefusal;
          if (out.trimmed > 0) call(() => occ.count("abandoned", out.trimmed), null);
          if (out.trimmed + out.refused > 0) {
            log(`strategy: trim ${f} r${p.round} trimmed=${out.trimmed} skipped=${out.skipped} `
              + `refused=${out.refused} duplicate=${out.duplicate}`);
          }
        } };
    } catch (err) {
      return { ok: false, reason: `TRIM_FAILED: ${String((err && err.message) || err).slice(0, MAX_REASON_LENGTH)}` };
    }
  }

  function cursorOf(factionId) {
    const c = cursors.get(factionId);
    return c ? { afterSystemId: c.afterSystemId, passClean: c.passClean } : { afterSystemId: 0, passClean: true };
  }

  function noteReview(factionId, cursor, info) {
    if (cursor && Number.isSafeInteger(cursor.afterSystemId) && cursor.afterSystemId >= 0) {
      cursors.set(factionId, { afterSystemId: cursor.afterSystemId, passClean: cursor.passClean === true });
    }
    const planned = info && Number.isSafeInteger(info.planned) ? info.planned : 0;
    bump("planned", "strategy.trimPlanned", planned);
    if (info && info.done === true) {
      cursors.delete(factionId);
      if (!doneFactions.has(factionId)) {
        doneFactions.add(factionId);
        bump("done", "strategy.trimDone");
        log(`strategy: trim ${factionId} done`);
      }
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : (S.territoryTrimEnabled === true ? "on" : "off"),
      counters: Object.freeze({ ...counters }), doneFactions: doneFactions.size, lastRefusal });
  }

  return Object.freeze({
    handler,
    cursorOf,
    noteReview,
    getStatus,
    keys: Object.freeze({ trimKey, batchKey, doneKey }),
    stop() {
      stopped = true;
    },
  });
}

module.exports = { createTerritoryTrimService, TRIM_EVENT, trimKey, batchKey, doneKey };
