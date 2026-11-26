"use strict";

const { createEntry, isDue, pause, createTickBudget } = require("./cycleSchedule");

const BURST_COUNTER_NAMES = Object.freeze([
  "burst.affinity.stamped", "burst.affinity.cleared", "burst.affinity.foreign", "burst.affinity.rrOverride",
  "burst.affinity.mismatch",
  "burst.rebuild.ok", "burst.rebuild.restore", "burst.rebuild.error", "burst.rebuild.deferred", "burst.rebuild.maxMs",
]);
const FREE = Object.freeze({ controlsMovement: false });
const NO_BURST = "[]";

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function createBurstSidecar(deps) {
  const access = deps.access;
  const log = deps.log || {};
  const config = deps.config || {};
  const counters = Object.fromEntries(BURST_COUNTER_NAMES.map((name) => [name, 0]));
  const owners = new Map();
  let ownerOf = new WeakMap();
  const statsOn = config.burstShipStatsEnabled === true && typeof access.signature === "function"
    && typeof access.rebuild === "function" && typeof access.applyDerived === "function";
  const budget = createTickBudget(config.burstMaxRebuildsPerTick);
  const simNow = deps.scene && typeof deps.scene.simNow === "function" ? (scene) => deps.scene.simNow(scene)
    : (scene) => (typeof scene.getCurrentSimTimeMs === "function" ? Number(scene.getCurrentSimTimeMs()) || 0 : 0);
  const activeAccessOf = typeof deps.activeAccess === "function" ? deps.activeAccess : () => null;
  const propNow = typeof deps.propNow === "function" ? deps.propNow : () => null;
  const hrNow = typeof deps.hrNow === "function" ? deps.hrNow : () => Number(process.hrtime.bigint()) / 1e6;

  function count(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function alwaysOnOf(rt, twin, owner) {
    const active = activeAccessOf();
    const plan = rt.launch && rt.launch.active ? rt.launch.active : null;
    const ids = plan && Array.isArray(plan.alwaysOn) ? plan.alwaysOn : [];
    if (!active || typeof active.alwaysOnInputs !== "function" || ids.length === 0) return null;
    return active.alwaysOnInputs(twin, null, owner, ids, twin.skillMap, twin.fittedItems);
  }

  function rebuildStep(rt, ctx, owner) {
    const { twin, scene } = ctx;
    if (!scene) return;
    if (!rt.burst) {
      if (!isObj(twin.passiveDerivedState)) return;
      rt.burst = { base: twin.passiveDerivedState, sig: NO_BURST, appliedSig: NO_BURST,
        entry: createEntry(toInt(twin.itemID, 0), "burst") };
    }
    const b = rt.burst;
    const simMs = simNow(scene);
    if (!isDue(b.entry, simMs)) return;
    let sig;
    try {
      sig = access.signature(twin, simMs);
    } catch (_err) {
      sig = null;
    }
    if (typeof sig !== "string") {
      count("burst.rebuild.error");
      pause(b.entry, config.activeRetryMs, simMs, "ERROR");
      return;
    }
    b.sig = sig;
    if (sig === b.appliedSig) return;
    if (!budget.take(Number(ctx.nowMs) || 0)) {
      count("burst.rebuild.deferred");
      return;
    }
    const started = hrNow();
    let out;
    try {
      if (sig === NO_BURST) {
        out = access.applyDerived(scene, twin, b.base, propNow(rt));
      } else {
        const built = access.rebuild(twin, owner, alwaysOnOf(rt, twin, owner), simMs);
        out = built && built.ok === true ? access.applyDerived(scene, twin, built.state, propNow(rt)) : built;
      }
    } catch (_err) {
      out = null;
    }
    const tookMs = hrNow() - started;
    if (tookMs > counters["burst.rebuild.maxMs"]) counters["burst.rebuild.maxMs"] = tookMs;
    if (out && out.ok === true) {
      b.appliedSig = sig;
      count(sig === NO_BURST ? "burst.rebuild.restore" : "burst.rebuild.ok");
      return;
    }
    count("burst.rebuild.error");
    pause(b.entry, config.activeRetryMs, simMs, "ERROR");
  }

  function hostOf(entry) {
    return entry.hostRef ? entry.hostRef.deref() || null : null;
  }

  function clearHost(entry) {
    const host = hostOf(entry);
    if (host && access.clear(host, entry.gid) === true) count("burst.affinity.cleared");
  }

  function adoptHost(entry, host) {
    if (hostOf(entry) === host) return;
    clearHost(entry);
    entry.hostRef = new WeakRef(host);
    entry.hostId = toInt(host.itemID, 0);
    entry.verified = false;
    entry.foreign = false;
    entry.rr = false;
  }

  function selfCheck(entry, host, owner) {
    const result = access.verify(host, entry.gid);
    if (result === "rrOverride") return;
    entry.verified = true;
    if (result !== "mismatch") return;
    count("burst.affinity.mismatch");
    if (typeof log.log === "function") {
      log.log(`command burst affinity mismatch on host ${entry.hostId} of ${owner} - twins may get no bursts`);
    }
  }

  function step(rt, ctx) {
    if (!rt || rt.ending === true || !ctx) return FREE;
    const { twin, host, record } = ctx;
    if (!twin || !host || !record) return FREE;
    const owner = toInt(record.ownerCharacterId, 0);
    const gid = access.groupIdOf(owner);
    if (!(gid > 0)) return FREE;
    const shipItemId = record.shipItemId;
    ownerOf.set(rt, { owner, shipItemId });
    let entry = owners.get(owner);
    if (!entry) {
      entry = { gid, hostRef: null, hostId: 0, twins: new Set(), verified: false, foreign: false, rr: false };
      owners.set(owner, entry);
    }
    entry.twins.add(shipItemId);
    adoptHost(entry, host);
    const onHost = access.stamp(host, gid);
    if (onHost.ok === true && onHost.wrote === true) count("burst.affinity.stamped");
    if (onHost.ok !== true && onHost.reason === "FOREIGN" && !entry.foreign) {
      entry.foreign = true;
      count("burst.affinity.foreign");
    }
    const onTwin = access.stamp(twin, gid);
    if (onTwin.ok === true && onTwin.wrote === true) count("burst.affinity.stamped");
    const rr = toInt(host.remoteRepairBurstAffinityGroupID, 0) > 0;
    if (rr && !entry.rr) count("burst.affinity.rrOverride");
    entry.rr = rr;
    if (!entry.verified && !rr && !entry.foreign) selfCheck(entry, host, owner);
    if (statsOn) rebuildStep(rt, ctx, owner);
    return FREE;
  }

  function dispose(rt, _reason) {
    const info = rt ? ownerOf.get(rt) : undefined;
    if (!info) return;
    ownerOf.delete(rt);
    const entry = owners.get(info.owner);
    if (!entry) return;
    entry.twins.delete(info.shipItemId);
    if (entry.twins.size > 0) return;
    clearHost(entry);
    owners.delete(info.owner);
  }

  function clearAll() {
    for (const entry of owners.values()) clearHost(entry);
    owners.clear();
    ownerOf = new WeakMap();
  }

  function stats() {
    const fromAccess = typeof access.stats === "function" ? access.stats() : null;
    return { counters: { ...counters, ...(fromAccess && fromAccess.counters ? fromAccess.counters : {}) },
      owners: owners.size };
  }

  return { name: "burst", step, dispose, clearAll, stats };
}

module.exports = { BURST_COUNTER_NAMES, createBurstSidecar };
