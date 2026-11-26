"use strict";

const S = require("./schema");

const byWantedId = (a, b) => (a.wantedId < b.wantedId ? -1 : a.wantedId > b.wantedId ? 1 : 0);
const finite = (v) => (Number.isFinite(v) ? v : Infinity);

function createRamIndex(cooldowns) {
  const respawnMs = cooldowns.respawnCooldownMs;
  const killedMs = cooldowns.killedCooldownMs;
  let active = new Map();
  let systems = new Map();
  let characters = new Map();
  let heads = new Map();
  let traces = new Map();

  function index(t) {
    active.set(t.wantedId, t);
    const set = systems.get(t.systemId);
    if (set) set.add(t.wantedId);
    else systems.set(t.systemId, new Set([t.wantedId]));
    characters.set(t.characterId, t.wantedId);
    if (Number.isSafeInteger(t.traceSystemId)) {
      const tr = traces.get(t.traceSystemId);
      if (tr) tr.add(t.wantedId);
      else traces.set(t.traceSystemId, new Set([t.wantedId]));
    }
  }

  function unindex(wantedId) {
    const t = active.get(wantedId);
    if (!t) return;
    active.delete(wantedId);
    const set = systems.get(t.systemId);
    if (set) {
      set.delete(wantedId);
      if (set.size === 0) systems.delete(t.systemId);
    }
    if (characters.get(t.characterId) === wantedId) characters.delete(t.characterId);
    const tr = Number.isSafeInteger(t.traceSystemId) ? traces.get(t.traceSystemId) : null;
    if (tr) {
      tr.delete(wantedId);
      if (tr.size === 0) traces.delete(t.traceSystemId);
    }
  }

  const deferred = new Map();

  function headReadyAt(head) {
    if (!head) return 0;
    if (S.ACTIVE_STATES.includes(head.state)) return Infinity;
    if (!Number.isFinite(head.endedAt)) return Infinity;
    return head.endedAt + (head.state === S.STATES.KILLED ? killedMs : respawnMs);
  }

  const readyAtOfSlot = (slot) => Math.max(headReadyAt(heads.get(slot)), deferred.get(slot) || 0);

  const dueOf = (t) => (t.state === S.STATES.ROAMING ? Math.min(t.nextMoveAt, t.expiresAt) : Infinity);

  return {
    load(rows, list) {
      active = new Map();
      systems = new Map();
      characters = new Map();
      heads = new Map();
      traces = new Map();
      for (const h of list || []) heads.set(h.slot, { cycle: h.cycle, state: h.state, endedAt: h.endedAt });
      for (const t of rows || []) {
        if (S.ACTIVE_STATES.includes(t.state)) index(t);
      }
    },
    apply(changes) {
      for (const t of changes || []) {
        unindex(t.wantedId);
        if (S.ACTIVE_STATES.includes(t.state)) index(t);
        deferred.delete(t.gangSlot);
        const head = heads.get(t.gangSlot);
        if (!head || head.cycle <= t.cycle) {
          heads.set(t.gangSlot, { cycle: t.cycle, state: t.state, endedAt: t.endedAt });
        }
      }
    },
    dueRows(now, limit) {
      const out = [];
      for (const t of active.values()) {
        const due = dueOf(t);
        if (due <= now) out.push({ due, t });
      }
      out.sort((a, b) => a.due - b.due || byWantedId(a.t, b.t));
      return out.slice(0, Math.max(0, limit)).map((x) => x.t);
    },
    readySlots(now, maxSlots, limit, skip) {
      const out = [];
      for (let slot = 1; slot <= maxSlots; slot += 1) {
        if (typeof skip === "function" && skip(slot)) continue;
        const readyAt = readyAtOfSlot(slot);
        if (readyAt <= now) out.push({ slot, readyAt });
      }
      out.sort((a, b) => a.readyAt - b.readyAt || a.slot - b.slot);
      return out.slice(0, Math.max(0, limit));
    },
    bySystem(systemId) {
      const set = systems.get(systemId);
      if (!set) return [];
      return [...set].map((id) => active.get(id)).sort(byWantedId);
    },
    byTraceSystem(systemId) {
      const set = traces.get(systemId);
      if (!set) return [];
      return [...set].map((id) => active.get(id)).sort(byWantedId);
    },
    byCharacter(characterId) {
      const id = characters.get(characterId);
      return id ? active.get(id) || null : null;
    },
    nextWorkAt(now, cfg) {
      let at = Math.min(finite(cfg.nextPruneAt), finite(cfg.nextResyncAt));
      for (const t of active.values()) at = Math.min(at, dueOf(t));
      if (active.size < cfg.maxActive) {
        const skip = typeof cfg.skip === "function" ? cfg.skip : null;
        for (let slot = 1; slot <= cfg.maxSlots; slot += 1) {
          if (skip === null || !skip(slot)) at = Math.min(at, readyAtOfSlot(slot));
        }
      }
      return at;
    },
    defer(slot, at) {
      if (Number.isSafeInteger(slot) && Number.isFinite(at)) deferred.set(slot, Math.max(deferred.get(slot) || 0, at));
    },
    get: (wantedId) => active.get(wantedId) || null,
    activeCount: () => active.size,
    busySystems: () => new Set(systems.keys()),
    activeRows: () => [...active.values()].sort(byWantedId),
    census() {
      const byLevel = {};
      const byState = {};
      const byFaction = {};
      for (const t of active.values()) {
        byLevel[t.level] = (byLevel[t.level] || 0) + 1;
        byState[t.state] = (byState[t.state] || 0) + 1;
        byFaction[t.factionId] = (byFaction[t.factionId] || 0) + 1;
      }
      return { byLevel, byState, byFaction };
    },
  };
}

module.exports = { createRamIndex };
