"use strict";

const { createPoller } = require("../../presence/poller");
const { CONDITION_FULL, CONDITION_ARMOR_STAGE } = require("../../stations/structures/schema");
const S = require("./schema");

const MODE = Object.freeze({ ON: "on", CLEANUP: "cleanup", OFF: "off" });
const MODES = Object.freeze([MODE.ON, MODE.CLEANUP, MODE.OFF]);
const WORK_CLASS = "OPERATIONAL";
const STATION_ROLE = "station";
const DOCKING = "none";
const MAX_DETAIL = 120;
const COUNTER_NAMES = Object.freeze(["physicalCreated", "physicalUpdated", "physicalDestroyed", "physicalRemoved",
  "physicalRefused", "physicalLost", "liveKills", "noCorp", "reinforceHoldExpired"]);
const METRIC_PHYSICAL_GAUGE = "world.sovStructures.physical";
const ONLINE_STATE_NAMES = Object.freeze(["SHIELD_VULNERABLE", "ARMOR_REINFORCE", "ARMOR_VULNERABLE", "HULL_REINFORCE",
  "HULL_VULNERABLE"]);
const PAST_ANCHOR_STATE_NAMES = Object.freeze(["ANCHORING", "ONLINING_VULNERABLE", ...ONLINE_STATE_NAMES]);
const RESTING_STATE_NAMES = Object.freeze(["SHIELD_VULNERABLE", "ANCHOR_VULNERABLE"]);
const NOT_EMPTY = "NOT_EMPTY";
const ALREADY_TAGGED = "ALREADY_TAGGED";
const READ_FACTOR = 2;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const reasonOf = (r) => String((r && r.reason) || "NO_RESULT");
const inStates = (names, states, state) => names.some((n) => Number.isSafeInteger(states[n]) && states[n] === state);

class Rollback {
  constructor(refusal) {
    this.refusal = refusal;
  }
}

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function desiredPatch(row, view, states, now) {
  if (row.state === S.ANCHORING) {
    if (view.state === states.ANCHOR_VULNERABLE) return null;
    if (inStates(PAST_ANCHOR_STATE_NAMES, states, view.state)) return null;
    return { state: states.ANCHOR_VULNERABLE, stateEndsAt: isId(row.dueAt) && row.dueAt > now ? row.dueAt : null,
      condition: { ...CONDITION_ARMOR_STAGE }, at: now };
  }
  if (row.state === S.ONLINE) {
    if (inStates(ONLINE_STATE_NAMES, states, view.state)) return null;
    return { state: states.SHIELD_VULNERABLE, stateEndsAt: null, condition: { ...CONDITION_FULL }, at: now };
  }
  return null;
}

function createSovPhysicalPump(deps) {
  const { store, repository, seam, states, world, clock } = deps;
  const C = deps.config;
  const P = C.physical;
  const mode = P.mode;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const lastObservedAt = new Map();
  const holdSince = new Map();
  const savepoints = new WeakMap();
  const SAVEPOINT_ABORT = Symbol("sov-physical-savepoint-abort");
  let poller = null;
  let stopped = false;
  let passes = 0;
  let physical = null;
  let lastRefusal = null;
  let lastPassAt = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `world.sovStructures.${name}`, n);
  }

  function refused(where, r) {
    bump("physicalRefused");
    lastRefusal = `${where}:${reasonOf(r)}${r && r.detail ? `:${String(r.detail).slice(0, MAX_DETAIL)}` : ""}`;
  }

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  const lazy = (getter) => (typeof getter === "function" ? call(getter, null) : null);

  function admitted() {
    const governor = lazy(deps.getGovernor);
    if (!governor || typeof governor.admits !== "function") return true;
    return call(() => governor.admits(WORK_CLASS) !== false, true);
  }

  function observedNow() {
    const p = lazy(deps.getPresence);
    if (!p || typeof p.observedSystems !== "function") return null;
    const st = typeof p.getStatus === "function" ? call(() => p.getStatus(), null) : null;
    if (st && st.available === false) return null;
    const list = call(() => p.observedSystems(), null);
    return Array.isArray(list) ? [...new Set(list.filter(isId))].sort((a, b) => a - b) : null;
  }

  function corporationOf(factionId) {
    const registry = lazy(deps.getRegistry);
    if (!registry || typeof registry.corporationFor !== "function") return null;
    const corp = call(() => registry.corporationFor(factionId, STATION_ROLE), null);
    return isId(corp) ? corp : null;
  }

  const tagOf = (row) => ({ sovStructureId: row.structureId, world });

  function abandonInSavepoint(db, occ, s, at) {
    let run = savepoints.get(db);
    if (!run) {
      run = db.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "SOV_ABANDON_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(db, run);
    }
    const holder = { refusal: null };
    try {
      return run(() => occ.abandonInTx(db, { systemId: s.systemId, factionId: s.factionId, at, allowClaim: true },
        S.abandonKey(s.structureId)), holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && db.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function liveKill(row, now) {
    const res = store.transaction("sovStructures.liveKill", (db) => {
      const got = repository.getById(db, row.structureId);
      if (!got.ok) throw new Rollback(got);
      const s = got.structure;
      if (!s || !S.LIVE_STATES.includes(s.state) || s.evejsItemId !== row.evejsItemId) return { stale: true };
      const t = repository.transition(db, { structure: s, to: S.DESTROYED, at: now, reason: S.REASON.LIVE_KILL,
        byFactionId: null });
      if (!t.ok) throw new Rollback(t);
      const cleared = repository.recordPhysical(db, { structureId: s.structureId, expectedItemId: s.evejsItemId,
        itemId: null, at: now });
      if (!cleared.ok) throw new Rollback(cleared);
      const occ = lazy(deps.getOccupation);
      if (!occ || typeof occ.sovClaimOfInTx !== "function" || typeof occ.abandonInTx !== "function") {
        return { stale: false, abandon: { ok: false, reason: "OCCUPATION_UNAVAILABLE" } };
      }
      const claim = occ.sovClaimOfInTx(db, s.systemId);
      if (!claim || claim.ok !== true) return { stale: false, abandon: claim || { ok: false, reason: "NO_CLAIM" } };
      if (!claim.claim || claim.claim.controllerFactionId !== s.factionId) return { stale: false, abandon: null };
      return { stale: false, abandon: abandonInSavepoint(db, occ, s, now) };
    });
    if (!res.ok) {
      refused("LIVE_KILL", res.error instanceof Rollback ? res.error.refusal : res);
      return false;
    }
    if (res.value.stale) return false;
    bump("liveKills");
    const a = res.value.abandon;
    if (a !== null && (!a || a.ok !== true)) {
      lastRefusal = `LIVE_KILL_ABANDON:${reasonOf(a)}`;
      log(`sovStructures: physical live kill ${row.structureId} - abandon refused (${reasonOf(a)}), HEAL repairs it`);
    }
    if (typeof deps.onLiveChanged === "function") call(deps.onLiveChanged, null);
    return true;
  }

  function removeTcu(itemId, tag, now) {
    const r = seam.removeSovTaggedStructure(itemId, tag);
    if (r && r.ok) {
      bump("physicalRemoved");
      return true;
    }
    if (r && r.reason === NOT_EMPTY) return destroyTcu(itemId, tag, now);
    refused("REMOVE", r);
    return false;
  }

  function destroyTcu(itemId, tag, now) {
    const r = seam.destroySovTaggedStructure(itemId, tag, now);
    if (r && r.ok) {
      bump("physicalDestroyed");
      return true;
    }
    refused("DESTROY", r);
    return false;
  }

  function createTcu(s, now, ctx) {
    const corp = corporationOf(s.factionId);
    if (corp === null) {
      bump("noCorp");
      return;
    }
    const pos = seam.sovPosition(s.systemId, P.offsetM);
    if (!pos || !pos.ok) {
      refused("POSITION", pos);
      return;
    }
    const patch = desiredPatch(s, { state: null }, states, now);
    ctx.writes += 1;
    const r = seam.createSovTaggedStructure({ tag: tagOf(s), typeId: C.typeId, systemId: s.systemId,
      ownerCorpId: corp, name: null, position: pos.position, state: patch.state, stateEndsAt: patch.stateEndsAt,
      condition: patch.condition, docking: DOCKING, quantumCore: false, at: now });
    if (r && r.ok) {
      ctx.vendorWrites += 1;
      ctx.records.push({ structureId: s.structureId, expectedItemId: null, itemId: r.structureId, vendor: true });
      ctx.created += 1;
      return;
    }
    if (r && r.reason === ALREADY_TAGGED && isId(r.structureId)) {
      ctx.writes -= 1;
      ctx.records.push({ structureId: s.structureId, expectedItemId: null, itemId: r.structureId, vendor: false });
      return;
    }
    refused("CREATE", r);
  }

  function readPass(observed) {
    const res = store.transaction("sovStructures.physicalRead", (db) => {
      const listed = repository.listPhysical(db, P.maxPhysical * READ_FACTOR);
      if (!listed.ok) return listed;
      const candidates = [];
      for (const systemId of observed) {
        const live = repository.listLiveInSystem(db, systemId);
        if (!live.ok) return live;
        for (const s of live.structures) if (s.evejsItemId === null) candidates.push(s);
      }
      return { ok: true, physical: listed.structures, count: listed.count, candidates };
    });
    return res.ok ? res.value : res;
  }

  function stepPhysical(row, now, observedSet, presenceOk, ctx) {
    const itemId = row.evejsItemId;
    const tag = tagOf(row);
    const forget = (vendor) => ctx.records.push({ structureId: row.structureId, expectedItemId: itemId, itemId: null,
      vendor });
    const got = seam.getSovStructure(itemId);
    if (!got || !got.ok) {
      refused("READ_TCU", got);
      return;
    }
    const view = got.row;
    const live = S.LIVE_STATES.includes(row.state);
    if (!view || !view.tag || view.tag.sovStructureId !== row.structureId || view.tag.world !== world) {
      bump("physicalLost");
      forget(false);
      return;
    }
    if (view.destroyedAt !== null) {
      if (live && !view.modDestroyed) ctx.kills.push(row);
      else forget(false);
      return;
    }
    const resting = inStates(RESTING_STATE_NAMES, states, view.state);
    if (resting) holdSince.delete(row.structureId);
    else if (live && !holdSince.has(row.structureId)) holdSince.set(row.structureId, now);
    if (ctx.writes >= P.maxWritesPerPass) return;
    if (!live) {
      ctx.writes += 1;
      const gone = row.state === S.DESTROYED ? destroyTcu(itemId, tag, now) : removeTcu(itemId, tag, now);
      if (gone) {
        ctx.vendorWrites += 1;
        forget(true);
      }
      return;
    }
    if (presenceOk && !observedSet.has(row.systemId)) {
      if (!lastObservedAt.has(row.systemId)) lastObservedAt.set(row.systemId, now);
      const held = resting ? null : now - holdSince.get(row.structureId);
      if (now - lastObservedAt.get(row.systemId) >= P.lingerMs && (held === null || held >= P.reinforceHoldMaxMs)) {
        if (held !== null) {
          bump("reinforceHoldExpired");
          log(`sovStructures: physical TCU ${itemId} of ${row.structureId} outside a resting state for ${held}ms `
            + `(>= reinforceHoldMaxMs ${P.reinforceHoldMaxMs}) - linger removes it`);
        }
        ctx.writes += 1;
        if (removeTcu(itemId, tag, now)) {
          ctx.vendorWrites += 1;
          forget(true);
        }
        return;
      }
    }
    const patch = desiredPatch(row, view, states, now);
    if (patch === null) return;
    ctx.writes += 1;
    const r = seam.updateSovTaggedStructure(itemId, tag, patch);
    if (r && r.ok) {
      ctx.vendorWrites += 1;
      bump("physicalUpdated");
    } else refused("UPDATE", r);
  }

  function recordAll(records, now) {
    if (records.length === 0) return;
    const res = store.transaction("sovStructures.physicalRecord", (db) => {
      for (const r of records) {
        const w = repository.recordPhysical(db, { structureId: r.structureId, expectedItemId: r.expectedItemId,
          itemId: r.itemId, at: now });
        if (!w.ok) throw new Rollback(w);
      }
      return { ok: true };
    });
    if (!res.ok) refused("RECORD", res.error instanceof Rollback ? res.error.refusal : res);
  }

  function onPass() {
    const now = clock.now();
    const observed = observedNow();
    const presenceOk = observed !== null;
    const observedList = presenceOk ? observed : [];
    for (const systemId of observedList) lastObservedAt.set(systemId, now);
    const read = readPass(observedList);
    if (!read || !read.ok) {
      refused("READ", read);
      return;
    }
    const observedSet = new Set(observedList);
    const ctx = { writes: 0, vendorWrites: 0, records: [], kills: [], created: 0 };
    for (const row of read.physical) {
      if (stopped) return;
      stepPhysical(row, now, observedSet, presenceOk, ctx);
    }
    let count = read.count;
    const candidates = [...read.candidates].sort((a, b) => (a.structureId < b.structureId ? -1 : 1));
    for (const s of candidates) {
      if (stopped || count >= P.maxPhysical || ctx.writes >= P.maxWritesPerPass) break;
      const before = ctx.records.length;
      createTcu(s, now, ctx);
      if (ctx.records.length > before) count += 1;
    }
    count -= ctx.records.filter((r) => r.itemId === null).length;
    if (ctx.vendorWrites > 0) {
      const flushed = seam.flushStructures();
      if (!flushed || !flushed.ok) {
        refused("FLUSH", flushed);
        ctx.records = ctx.records.filter((r) => !r.vendor);
        ctx.created = 0;
      }
    }
    recordAll(ctx.records, now);
    bump("physicalCreated", ctx.created);
    for (const row of ctx.kills.slice(0, P.maxWritesPerPass)) {
      if (stopped) return;
      if (liveKill(row, now)) count -= 1;
    }
    const keep = new Set(read.physical.map((r) => r.systemId).concat(observedList));
    for (const systemId of [...lastObservedAt.keys()]) if (!keep.has(systemId)) lastObservedAt.delete(systemId);
    const keepRows = new Set(read.physical.map((r) => r.structureId));
    for (const id of [...holdSince.keys()]) if (!keepRows.has(id)) holdSince.delete(id);
    physical = Math.max(0, count);
    metric("gauge", METRIC_PHYSICAL_GAUGE, physical);
  }

  function cleanupPass() {
    const listed = seam.listSovTaggedStructures();
    if (!listed || !listed.ok) {
      refused("LIST", listed);
      return;
    }
    const now = clock.now();
    const live = listed.rows.filter((v) => v && v.tag && v.destroyedAt === null)
      .sort((a, b) => a.structureId - b.structureId);
    let writes = 0;
    let gone = 0;
    for (const view of live) {
      if (stopped || writes >= P.maxWritesPerPass) break;
      writes += 1;
      if (removeTcu(view.structureId, view.tag, now)) gone += 1;
    }
    if (gone > 0) {
      const flushed = seam.flushStructures();
      if (!flushed || !flushed.ok) refused("FLUSH", flushed);
    }
    physical = live.length - gone;
    metric("gauge", METRIC_PHYSICAL_GAUGE, physical);
  }

  function runPass() {
    if (stopped) return;
    try {
      if (!admitted()) return;
      if (mode === MODE.CLEANUP) cleanupPass();
      else onPass();
    } catch (err) {
      bump("physicalRefused");
      lastRefusal = `THREW:${detailOf(err)}`;
      log(`sovStructures: physical pass failed - ${detailOf(err)}`);
    } finally {
      passes += 1;
      lastPassAt = clock.now();
    }
  }

  function start() {
    poller = createPoller({ runPass, intervalMs: P.passMs, now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => log(`sovStructures: physical timer error - ${detailOf(err)}`) });
    const started = poller.start();
    if (started && started.ok === false) return { ok: false, reason: `poller ${reasonOf(started)}` };
    return { ok: true };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (poller) poller.stop();
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", mode, passes, lastPassAt, physical,
      tracked: lastObservedAt.size, held: holdSince.size, lastRefusal, counters: Object.freeze({ ...counters }) });
  }

  return Object.freeze({ start, stop, runPass, getStatus });
}

module.exports = { createSovPhysicalPump, desiredPatch, MODE, MODES, COUNTER_NAMES };
