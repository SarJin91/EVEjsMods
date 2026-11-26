"use strict";

const B = require("./schema");
const { createAbortSentinel } = require("../../persistence/store");

const SAVEPOINT_ABORT = createAbortSentinel("world.bastion.restore.refused");
const STATION_SAVEPOINT_ABORT = createAbortSentinel("world.bastion.station.refused");
const COUNTER_NAMES = Object.freeze(["runs", "restored", "noop", "noRow", "drift", "refused", "garrisonReleased",
  "deferred",
  "stationsReturned", "stationsSkipped", "stationsRefused"]);
const MAX_REFUSAL = 120;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_REFUSAL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (Object.keys(p).sort().join() !== B.PAYLOAD_KEYS.join()) return null;
  if (!isCount(p.bucket) || typeof p.after !== "string" || !/^\d{1,16}$/.test(p.after)) return null;
  return { bucket: p.bucket, after: p.after };
}

function bastionReconcileSettingsOf(config, store) {
  const w = (config && config.world) || {};
  const perRestore = B.RESTORE_BASE_ROWS + (Number.isSafeInteger(w.maxFactionsPerSystem) ? w.maxFactionsPerSystem : 8);
  const rowsCap = store && store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
    ? store.limits.maxRowsPerTransaction : null;
  const knob = Number.isSafeInteger(w.npcSovBastionReconcileMaxPerPass) ? w.npcSovBastionReconcileMaxPerPass : 1;
  const stationOn = w.npcSovBastionStationReturnEnabled === true;
  const stationMax = Number.isSafeInteger(w.npcSovBastionStationReturnMaxPerPass)
    ? w.npcSovBastionStationReturnMaxPerPass : 1;
  const st = (config && config.stations) || {};
  const oc = (config && config.occupation) || {};
  const stockRows = Number.isSafeInteger(st.maxStockItemsPerStation) ? st.maxStockItemsPerStation : 256;
  const fleetRows = Number.isSafeInteger(oc.maxFleetsReadPerEval) ? oc.maxFleetsReadPerEval : 64;
  let stationRows = stationOn ? stationMax * (B.STATION_RETURN_BASE_ROWS + stockRows + 2 * fleetRows) : 0;
  let stationReturnEnabled = stationOn;
  let stationReturnTooSmall = false;
  let byRows = rowsCap === null ? knob : Math.floor((rowsCap - B.FIXED_ROWS - stationRows) / perRestore);
  if (stationOn && rowsCap !== null && byRows < 1) {
    stationReturnEnabled = false;
    stationReturnTooSmall = true;
    stationRows = 0;
    byRows = Math.floor((rowsCap - B.FIXED_ROWS) / perRestore);
  }
  return {
    enabled: w.npcSovBastionsEnabled === true,
    intervalMs: Number.isSafeInteger(w.npcSovBastionReconcileIntervalMs) ? w.npcSovBastionReconcileIntervalMs : 21600000,
    delayMs: Number.isSafeInteger(w.npcSovBastionReconcileDelayMs) ? w.npcSovBastionReconcileDelayMs : 60000,
    pageRows: Math.max(1, Math.min(knob, byRows)),
    rowsCap,
    stationReturnEnabled,
    stationReturnMaxPerPass: stationMax,
    stationRows,
    stationReturnTooSmall,
  };
}

function createBastionReconcile(deps) {
  const { scheduler, clock } = deps;
  const settings = deps.settings;
  const coreIndex = deps.coreIndex;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const bastions = coreIndex && coreIndex.bastions instanceof Map ? coreIndex.bastions : new Map();
  const ids = [...bastions.keys()].sort((a, b) => a - b);
  const byFaction = new Map();
  for (const f of bastions.values()) byFaction.set(f, (byFaction.get(f) || 0) + 1);
  const issues = coreIndex && Array.isArray(coreIndex.bastionIssues) ? [...coreIndex.bastionIssues] : [];
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const savepoints = new WeakMap();
  const stationSavepoints = new WeakMap();
  let stopped = false;
  let lastRunAt = null;
  let lastRefusal = null;
  let driftLogged = new Map();

  const log = (line) => call(() => logger.log(line), null);
  const bucketOf = (t) => Math.floor(t / settings.intervalMs);

  function bump(name, n = 1) {
    if (n > 0) counters[name] += n;
  }

  function telemetryOf(fn) {
    if (!telemetry) return;
    call(fn, null);
  }

  function gauges() {
    telemetryOf(() => telemetry.gauge("world.bastions.systems", ids.length));
    telemetryOf(() => telemetry.gauge("world.bastions.drift", counters.drift));
  }

  function enqueue(tx, bucket, after, dueAt) {
    const payload = { bucket, after };
    const key = B.reconcileKey(bucket, after);
    const r = tx
      ? scheduler.enqueue(B.EVENT_TYPE, B.AGGREGATE_ID, dueAt, payload, key, { tx, chained: true })
      : scheduler.enqueue(B.EVENT_TYPE, B.AGGREGATE_ID, dueAt, payload, key);
    if (r && r.ok === false && r.reason === "IDEMPOTENCY_CONFLICT" && !tx) return { ok: true, duplicate: true };
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
    return { ok: true, duplicate: r.duplicate === true };
  }

  function restoreOne(tx, occ, systemId, factionId, at) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "BASTION_RESTORE_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(() => occ.restoreBastionInTx(tx, { systemId, factionId, at }, B.restoreKeyBase(systemId)), holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function stationsOne(tx, occ, spec) {
    let run = stationSavepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "BASTION_STATION_RETURN_FAILED" };
          throw STATION_SAVEPOINT_ABORT;
        }
        return r;
      });
      stationSavepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(() => occ.returnBastionStationsInTx(tx, spec, B.restoreKeyBase(spec.systemId)), holder);
    } catch (err) {
      if (err === STATION_SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function corporationOf(factionId) {
    return call(() => {
      const reg = typeof deps.getRegistry === "function" ? deps.getRegistry() : null;
      const c = reg && typeof reg.corporationFor === "function" ? reg.corporationFor(factionId, "station") : null;
      return Number.isSafeInteger(c) && c > 0 ? c : null;
    }, null);
  }

  function graphOf() {
    const g = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
    const r = g && typeof g.getGraph === "function" ? call(() => g.getGraph(), null) : null;
    return r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
  }

  function handler(ev, hctx) {
    try {
      const p = parsePayload(ev && ev.payload);
      if (!p) return { ok: false, reason: "BASTION_RECONCILE_PAYLOAD_INVALID", permanent: true };
      if (settings.enabled !== true) return { ok: true, outcome: "DISABLED" };
      if (stopped) return { ok: false, reason: "BASTION_RECONCILE_STOPPED" };
      const at = hctx && isCount(hctx.now) ? hctx.now : clock.now();
      const occ = typeof deps.getOccupation === "function" ? call(deps.getOccupation, null) : null;
      if (!occ || typeof occ.restoreBastionInTx !== "function") {
        bump("deferred");
        return { ok: false, reason: "OCCUPATION_UNAVAILABLE", deferUntil: at + settings.delayMs };
      }
      const graph = graphOf();
      if (!graph) {
        bump("deferred");
        return { ok: false, reason: "GRAPH_NOT_READY", deferUntil: at + settings.delayMs };
      }
      const after = Number(p.after);
      const start = ids.findIndex((id) => id > after);
      const page = start < 0 ? [] : ids.slice(start, start + settings.pageRows);
      const more = start >= 0 && start + page.length < ids.length;
      const tally = { restored: 0, noop: 0, noRow: 0, drift: 0, refused: 0, garrisonReleased: 0, first: null,
        restoredLines: [], driftLines: [],
        stationsReturned: 0, stationsRefused: 0, upwell: 0, busy: 0, limit: 0, noCorporation: 0, stationLines: [],
        stationFirst: null };
      const stationOn = settings.stationReturnEnabled === true && typeof occ.returnBastionStationsInTx === "function";
      let stationBudget = stationOn && isCount(settings.stationReturnMaxPerPass) ? settings.stationReturnMaxPerPass : 0;
      const t0 = typeof deps.nowMs === "function" ? deps.nowMs() : null;
      return { ok: true, outcome: "RECONCILED",
        effect: (tx) => {
          for (const systemId of page) {
            const F = bastions.get(systemId);
            const v = call(() => graph.getSystem(systemId), null);
            if (!v || v.secClass !== "nullsec" || v.factionId !== F) {
              tally.drift += 1;
              tally.driftLines.push(`world: bastion ${systemId} drift catalog=${F} graph=`
                + `${v ? `${v.factionId}/${v.secClass}` : "missing"} - rebuild tools/buildNpcSovCatalog.js`);
              continue;
            }
            const r = restoreOne(tx, occ, systemId, F, at);
            if (r && r.ok === true) {
              if (r.outcome === "NOOP" || r.duplicate === true) tally.noop += 1;
              else {
                tally.restored += 1;
                tally.garrisonReleased += isCount(r.garrisonReleased) ? r.garrisonReleased : 0;
                const old = r.previousControllerFactionId === null || r.previousControllerFactionId === undefined
                  ? "none" : r.previousControllerFactionId;
                tally.restoredLines.push(`world: bastion ${systemId} restored ${old}->${F} state=${r.state}`);
              }
            } else if (r && r.reason === "NO_SYSTEM_ROW") {
              tally.noRow += 1;
            } else {
              tally.refused += 1;
              if (tally.first === null) tally.first = `${systemId}:${(r && r.reason) || "?"}`;
            }
            if (stationOn && stationBudget > 0 && r && r.ok === true) {
              const corp = corporationOf(F);
              if (corp === null) {
                tally.noCorporation += 1;
                continue;
              }
              const s = stationsOne(tx, occ, { systemId, factionId: F, ownerCorporationId: corp, at,
                max: stationBudget });
              if (s && s.ok === true) {
                const returned = Array.isArray(s.returned) ? s.returned : [];
                tally.stationsReturned += returned.length;
                stationBudget -= returned.length;
                tally.upwell += isCount(s.foreignUpwell) ? s.foreignUpwell : 0;
                tally.busy += isCount(s.busy) ? s.busy : 0;
                tally.limit += isCount(s.limit) ? s.limit : 0;
                tally.garrisonReleased += isCount(s.garrisonReleased) ? s.garrisonReleased : 0;
                for (const x of returned) {
                  tally.stationLines.push(`world: bastion ${systemId} station ${x.stationId} returned `
                    + `${x.fromFactionId}->${F}`);
                }
              } else {
                tally.stationsRefused += 1;
                if (tally.stationFirst === null) tally.stationFirst = `${systemId}:${(s && s.reason) || "?"}`;
              }
            }
          }
          const next = more
            ? [p.bucket, String(page[page.length - 1]), at]
            : (() => {
              const b = Math.max(p.bucket, bucketOf(at)) + 1;
              return [b, B.START_AFTER, b * settings.intervalMs];
            })();
          const e = enqueue(tx, ...next);
          return e.ok ? { ok: true } : e;
        },
        onCommitted: () => {
          bump("runs");
          lastRunAt = at;
          for (const name of ["restored", "noop", "noRow", "drift", "refused", "garrisonReleased"]) {
            bump(name, tally[name]);
          }
          for (const line of tally.restoredLines) log(line);
          const seen = driftLogged.get(p.bucket) || 0;
          const room = Math.max(0, B.MAX_DRIFT_LOG_LINES - seen);
          for (const line of tally.driftLines.slice(0, room)) log(line);
          if (!driftLogged.has(p.bucket)) driftLogged = new Map();
          driftLogged.set(p.bucket, seen + Math.min(room, tally.driftLines.length));
          if (tally.refused > 0) {
            lastRefusal = tally.first;
            log(`world: bastion reconcile refused=${tally.refused} first=${tally.first}`);
          }
          const skipped = tally.upwell + tally.busy + tally.limit + tally.noCorporation;
          bump("stationsReturned", tally.stationsReturned);
          bump("stationsSkipped", skipped);
          bump("stationsRefused", tally.stationsRefused);
          for (const line of tally.stationLines) log(line);
          if (skipped > 0) {
            log(`world: bastion stations skipped upwell=${tally.upwell} busy=${tally.busy} limit=${tally.limit} `
              + `noCorp=${tally.noCorporation}`);
          }
          if (tally.stationsRefused > 0) {
            lastRefusal = tally.stationFirst;
            log(`world: bastion station return refused=${tally.stationsRefused} first=${tally.stationFirst}`);
          }
          if (settings.stationReturnEnabled === true) {
            telemetryOf(() => telemetry.count("world.bastions.stationsReturned", tally.stationsReturned));
            telemetryOf(() => telemetry.count("world.bastions.stationsSkipped", skipped));
            telemetryOf(() => telemetry.count("world.bastions.stationsRefused", tally.stationsRefused));
          }
          telemetryOf(() => telemetry.count("world.bastions.restored", tally.restored));
          telemetryOf(() => telemetry.count("world.bastions.refused", tally.refused));
          telemetryOf(() => telemetry.count("world.bastions.garrisonReleased", tally.garrisonReleased));
          if (t0 !== null) telemetryOf(() => telemetry.observe("world.bastions.passMs", deps.nowMs() - t0));
          gauges();
        } };
    } catch (err) {
      return { ok: false, reason: `BASTION_RECONCILE_FAILED: ${messageOf(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (settings.enabled !== true) return { ok: true, enqueued: false };
      if (stopped) return { ok: false, reason: "BASTION_RECONCILE_STOPPED" };
      const now = clock.now();
      const r = enqueue(null, bucketOf(now), B.START_AFTER, now + settings.delayMs);
      gauges();
      return r.ok ? { ok: true, enqueued: !r.duplicate, duplicate: r.duplicate } : r;
    } catch (err) {
      return { ok: false, reason: `BASTION_RECONCILE_BOOTSTRAP_FAILED: ${messageOf(err)}` };
    }
  }

  function bootLine() {
    const parts = [...byFaction].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([f, n]) => `${f}:${n}`);
    return `world: npc-sov bastions ${ids.length} (${parts.join(", ")}) issues=${issues.length}`;
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : (settings.enabled === true ? "ready" : "off"),
      systems: ids.length, byFaction: Object.freeze(Object.fromEntries(byFaction)), restored: counters.restored,
      noop: counters.noop, noRow: counters.noRow, drift: counters.drift, refused: counters.refused,
      lastRunAt, issues: Object.freeze([...issues]), counters: Object.freeze({ ...counters }), lastRefusal });
  }

  return Object.freeze({
    bootstrap,
    handler,
    getStatus,
    bootLine,
    stop() {
      stopped = true;
    },
  });
}

function startBastionReconcile(deps) {
  try {
    const { config, store, scheduler } = deps;
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function") {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const settings = bastionReconcileSettingsOf(config, store);
    const reconcile = createBastionReconcile({ ...deps, settings });
    const registration = scheduler.registerHandler(B.EVENT_TYPE, reconcile.handler, { maxPerPass: 1 });
    if (!registration || registration.ok !== true) {
      return { ok: false, reason: (registration && registration.reason) || "REGISTER_FAILED" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    if (settings.enabled === true) {
      logger.log(reconcile.bootLine());
      if (settings.pageRows < config.world.npcSovBastionReconcileMaxPerPass) {
        logger.log(`world: bastion reconcile page bounded by persistence.maxRowsPerTransaction ${settings.rowsCap} `
          + `(${config.world.npcSovBastionReconcileMaxPerPass} -> ${settings.pageRows})`);
      }
      if (settings.stationReturnTooSmall === true) {
        logger.log(`world: bastion station return off - persistence.maxRowsPerTransaction ${settings.rowsCap} too small`);
      }
      const boot = reconcile.bootstrap();
      if (!boot.ok) logger.log(`world: bastion reconcile bootstrap failed ${boot.reason}; the next start retries`);
    }
    return { ok: true, reconcile, registration };
  } catch (err) {
    return { ok: false, reason: "BASTION_RECONCILE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { createBastionReconcile, startBastionReconcile, bastionReconcileSettingsOf, parsePayload,
  COUNTER_NAMES };
