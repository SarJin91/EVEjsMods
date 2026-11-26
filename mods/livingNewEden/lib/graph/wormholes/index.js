"use strict";

const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../../config");
const { createPoller } = require("../../presence/poller");
const { diffWormholeEdges, STATUS } = require("./sync");

const WORK_CLASS = "MAINTENANCE";
const STATE = Object.freeze({ STARTING: "starting", SYNCED: "synced", UNAVAILABLE: "unavailable", STOPPED: "stopped" });
const MAX_DETAIL_LENGTH = 200;
const MS_DECIMALS = 10;
const FLEETS_ABSENT = new Set(["FLEETS_DISABLED", "FLEETS_UNAVAILABLE"]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function createUnavailableWormholes(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, isSynced: () => false, syncNow: () => refusal, stop() {} });
}

function startWormholes(deps) {
  try {
    const { config, adapter, graph, clock } = deps || {};
    if (!isModuleEnabled(config, "graph") || !config.wormholes || config.wormholes.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "WORMHOLES_START_FAILED", detail: "clock" };
    if (!graph || typeof graph.whenReady !== "function") {
      return { ok: false, reason: "WORMHOLES_START_FAILED", detail: "graph" };
    }
    const settings = config.wormholes;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const telemetry = deps.telemetry || null;
    const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
    const getFleets = typeof deps.getFleets === "function" ? deps.getFleets : () => null;
    const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();

    let state = STATE.STARTING;
    let reason = "GRAPH_LOADING";
    let detail = null;
    let target = null;
    let applied = new Map();
    let synced = false;
    let lastSyncAt = null;
    let lastPairs = 0;
    let vendorDisabled = false;
    const counters = { syncs: 0, failed: 0, skipped: 0, edgeRefusals: 0, opened: 0, closed: 0, closures: 0,
      closuresDeferred: 0, transitsPurged: 0 };

    const log = (line) => {
      try {
        logger.log(line);
      } catch (_err) {
      }
    };
    const metric = (kind, name, value) => {
      if (!telemetry) return;
      try {
        telemetry[kind](name, value);
      } catch (_err) {
      }
    };

    function refuse(why, text) {
      counters.failed += 1;
      metric("count", "wormholes.syncFailed", 1);
      const changed = state !== STATE.UNAVAILABLE || reason !== why;
      state = STATE.UNAVAILABLE;
      reason = why;
      detail = text ? String(text).slice(0, MAX_DETAIL_LENGTH) : null;
      if (changed) log(`wormholes: unavailable - ${why}${detail ? ` (${detail})` : ""}; overlay kept`);
      return Object.freeze({ ok: false, reason: why, ...(detail ? { detail } : {}) });
    }

    function readPairs() {
      try {
        if (!adapter || typeof adapter.readWormholePairs !== "function") {
          return { ok: false, reason: "WORMHOLE_STATE_UNAVAILABLE", detail: "no adapter.readWormholePairs" };
        }
        return adapter.readWormholePairs({ maxPairs: settings.maxPairs }) || { ok: false, reason: "no_result" };
      } catch (err) {
        return { ok: false, reason: "WORMHOLE_STATE_FAILED", detail: messageOf(err) };
      }
    }

    function closeTransits(pairs, now) {
      let fleets = null;
      try {
        fleets = getFleets();
      } catch (_err) {
        fleets = null;
      }
      if (!fleets || typeof fleets.listOpenWormholeTransitPairs !== "function"
        || typeof fleets.closeWormholeTransits !== "function") return { ok: true, ran: false };
      const open = fleets.listOpenWormholeTransitPairs({ now, limit: settings.maxPairs });
      if (open && open.ok === false && FLEETS_ABSENT.has(open.reason)) return { ok: true, ran: false };
      if (!open || open.ok !== true) {
        return { ok: false, reason: String((open && open.reason) || "TRANSITS_READ_FAILED"), detail: open && open.detail };
      }
      const byKey = new Map(pairs.map((p) => [p.pairKey, p]));
      const closures = [];
      for (const pairKey of open.pairKeys) {
        const pair = byKey.get(pairKey);
        if (pair && pair.active === true) continue;
        let closedAt = now;
        if (pair && pair.collapseAt > 0) closedAt = Math.min(closedAt, pair.collapseAt);
        if (pair && pair.expiresAt > 0 && pair.expiresAt <= now) closedAt = Math.min(closedAt, pair.expiresAt);
        closures.push({ pairKey, closedAt });
      }
      const r = fleets.closeWormholeTransits(closures, { now });
      if (!r || r.ok !== true) {
        return { ok: false, reason: String((r && r.reason) || "TRANSITS_CLOSE_FAILED"), detail: r && r.detail };
      }
      counters.closures += r.closed;
      counters.closuresDeferred += r.deferred;
      counters.transitsPurged += r.purged;
      if (r.closed > 0) metric("count", "wormholes.closures", r.closed);
      if (r.deferred > 0) metric("count", "wormholes.closuresDeferred", r.deferred);
      if (r.purged > 0) metric("count", "wormholes.transitsPurged", r.purged);
      return { ok: true, ran: true, closed: r.closed, deferred: r.deferred, partial: r.partial || 0,
        purged: r.purged };
    }

    function sync() {
      try {
        if (state === STATE.STOPPED) return Object.freeze({ ok: false, reason: "WORMHOLES_STOPPED" });
        if (target === null) return Object.freeze({ ok: false, reason: "GRAPH_NOT_READY" });
        const governor = getGovernor();
        if (governor && typeof governor.admits === "function" && governor.admits(WORK_CLASS) === false) {
          counters.skipped += 1;
          metric("count", "wormholes.syncSkipped", 1);
          return Object.freeze({ ok: false, reason: "GOVERNOR_HOLD" });
        }
        const startedAt = nowMs();
        const read = readPairs();
        if (!read || read.ok !== true) return refuse(String((read && read.reason) || "no_result"), read && read.detail);
        const now = clock.now();
        const diff = diffWormholeEdges(applied, read.pairs, { now, minRemainingMs: settings.minRemainingMs,
          hasSystem: (id) => target.hasSystem(id) });
        let opened = 0;
        let closed = 0;
        let refused = 0;
        for (const change of diff.changes) {
          const r = target.updateWormholeEdge(change.connectionId, change.state);
          if (r && r.ok === true) {
            if (change.state.status === STATUS.OPEN) opened += r.changed ? 1 : 0;
            else closed += r.changed ? 1 : 0;
          } else {
            refused += 1;
            if (change.state.status === STATUS.OPEN) {
              if (applied.has(change.connectionId)) diff.next.set(change.connectionId, applied.get(change.connectionId));
              else diff.next.delete(change.connectionId);
            }
          }
        }
        applied = diff.next;
        const closing = closeTransits(read.pairs, now);
        if (!closing.ok) return refuse(closing.reason, closing.detail);
        counters.syncs += 1;
        counters.opened += opened;
        counters.closed += closed;
        counters.edgeRefusals += refused;
        lastSyncAt = now;
        lastPairs = read.pairs.length;
        const wasSynced = synced && state === STATE.SYNCED;
        const deferred = closing.ran ? closing.deferred : 0;
        if (deferred === 0) synced = true;
        state = STATE.SYNCED;
        reason = null;
        detail = null;
        const disabledNow = read.vendorDisabled === true;
        if (disabledNow !== vendorDisabled) {
          vendorDisabled = disabledNow;
          log(disabledNow ? "wormholes: vendor wormholes disabled (wormholesEnabled=false); overlay empty"
            : "wormholes: vendor wormholes enabled again");
        }
        metric("count", "wormholes.syncs", 1);
        metric("gauge", "wormholes.pairs", lastPairs);
        metric("gauge", "wormholes.vendorDisabled", vendorDisabled ? 1 : 0);
        metric("observe", "wormholes.syncMs", Math.round(Math.max(0, nowMs() - startedAt) * MS_DECIMALS) / MS_DECIMALS);
        if (synced && !wasSynced) {
          log(`wormholes: synced pairs=${lastPairs} skipped=${read.skipped} edges=${applied.size}`
            + ` refused=${refused} deferred=${deferred}`);
        }
        return Object.freeze({ ok: true, pairs: lastPairs, edges: applied.size, opened, closed, refused,
          ...(closing.ran ? { closures: closing.closed, deferred: closing.deferred, partial: closing.partial,
            purged: closing.purged } : {}) });
      } catch (err) {
        return refuse("WORMHOLES_SYNC_THREW", messageOf(err));
      }
    }

    const poller = createPoller({
      runPass: () => { sync(); },
      intervalMs: settings.syncIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => log(`wormholes: poll pass threw - ${messageOf(err)}`),
    });

    function onGraph(result) {
      if (state === STATE.STOPPED) return;
      const ready = result && result.ok === true && result.graph && typeof result.graph.updateWormholeEdge === "function"
        && typeof result.graph.hasSystem === "function";
      if (!ready) {
        state = STATE.UNAVAILABLE;
        reason = String((result && result.reason) || "GRAPH_UNAVAILABLE");
        log(`wormholes: unavailable - ${reason}; no poll`);
        return;
      }
      target = result.graph;
      const started = poller.start();
      if (!started.ok) {
        state = STATE.UNAVAILABLE;
        reason = "WORMHOLES_START_FAILED";
        detail = `poller ${started.reason}`;
        log(`wormholes: unavailable - ${reason} (${detail})`);
        return;
      }
      poller.arm(0);
    }

    graph.whenReady().then(onGraph).catch((err) => {
      state = state === STATE.STOPPED ? state : STATE.UNAVAILABLE;
      reason = "WORMHOLES_START_FAILED";
      detail = messageOf(err);
      log(`wormholes: unavailable - ${reason} (${detail})`);
    });
    log(`wormholes: running every ${settings.syncIntervalMs}ms minRemainingMs=${settings.minRemainingMs}`
      + ` maxPairs=${settings.maxPairs} (first sync after the graph build)`);

    const facade = {
      getStatus: () => Object.freeze({ state, reason, detail, synced, vendorDisabled, lastSyncAt, pairs: lastPairs,
        edges: applied.size, passes: poller.getPasses(), ...counters }),
      isSynced: () => synced,
      syncNow: sync,
      stop() {
        if (state === STATE.STOPPED) return;
        state = STATE.STOPPED;
        reason = "stopped";
        poller.stop();
      },
    };
    return { ok: true, wormholes: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "WORMHOLES_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startWormholes, createUnavailableWormholes, WORMHOLES_STATE: STATE };
