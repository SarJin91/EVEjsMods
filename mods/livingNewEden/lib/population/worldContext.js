"use strict";

const W = require("./data/contextWeights");
const R = require("./data/standingRules");

const PHASE = Object.freeze({ IDLE: "IDLE", BELTS: "BELTS", CONTROL: "CONTROL", GLOBAL: "GLOBAL", SWAP: "SWAP" });
const BELTS_NONE = 1;
const BELTS_SOME = 2;
const OCCUPATION_DANGER = Object.freeze({ INVASION: W.DANGER.INVASION, CONTESTED: W.DANGER.CONTESTED,
  RECON: W.DANGER.RECON });
const EMPTY_SET = Object.freeze(new Set());

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

const isOk = (r) => r !== null && typeof r === "object" && r.ok === true;

function emptyBuffer(n, withStanding) {
  const b = { control: new Uint16Array(n), battle: new Uint8Array(n), events: new Uint8Array(n), wrecks: new Uint8Array(n),
    danger: new Uint16Array(n), attract: new Uint8Array(n), byRegion: null, dangerSystems: 0,
    attractSystems: [0, 0, 0] };
  if (withStanding) Object.assign(b, { ctrlF: new Uint8Array(n), occF: new Uint8Array(n), alt: new Uint16Array(n) });
  return b;
}

function createWorldContext(deps) {
  const S = deps.S;
  const C = S.context;
  const src = deps.sources || {};
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => 0;
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const pirates = new Set(Array.isArray(src.pirateFactionIds) ? src.pirateFactionIds : []);
  const maxBatch = Number.isSafeInteger(src.maxBatchReadIds) && src.maxBatchReadIds > 0 ? src.maxBatchReadIds : Infinity;
  const controlSlice = Math.max(1, Math.min(S.contextSystemsPerSlice, maxBatch));
  const beltSlice = Math.max(1, S.contextSystemsPerSlice);
  const standing = deps.standing && typeof deps.standing.getTables === "function" ? deps.standing : null;
  let st = null;

  let table = null;
  let cur = null;
  let next = null;
  let belts = null;
  let beltsRead = false;
  let phase = PHASE.IDLE;
  let cursor = 0;
  let nextRefreshAt = 0;
  let lastRefreshAt = 0;
  let cycleMs = 0;

  const failed = () => bump("context.sourceFailed");
  const tableOf = () => {
    if (!table) {
      const t = safeCall(deps.getTable);
      if (t && Number.isSafeInteger(t.size) && t.indexOf) {
        table = t;
        belts = new Uint8Array(t.size);
      }
    }
    return table;
  };
  const idsOf = (from, count) => Array.from(table.systemIds.subarray(from, Math.min(table.size, from + count)));
  const copyRange = (field, from, to) => {
    if (cur && cur[field]) next[field].set(cur[field].subarray(from, to), from);
  };
  const standingTables = () => {
    if (!st && standing) {
      const t = safeCall(standing.getTables);
      if (t && t.factionIndex instanceof Map && t.rel) st = t;
    }
    return st;
  };

  function factionByte(factionId) {
    if (factionId === null || factionId === undefined || factionId === 0) return 0;
    const f = st.factionIndex.get(factionId);
    return f !== undefined ? f : R.OUTSIDE;
  }

  function dangerOfRow(s) {
    if (pirates.has(s.controllerFactionId) || pirates.has(s.occupierFactionId)) return W.DANGER.PIRATE_CONTROLLER;
    if (s.occupationState === "OCCUPIED") return W.DANGER.OCCUPIED;
    return OCCUPATION_DANGER[s.occupationState] || 0;
  }

  function beltsStep() {
    const ids = idsOf(cursor, beltSlice);
    const r = safeCall(() => src.readBelts(ids));
    if (isOk(r) && r.counts instanceof Map) {
      for (let k = 0; k < ids.length; k += 1) {
        const n = r.counts.get(ids[k]);
        if (Number.isFinite(n)) belts[cursor + k] = n > 0 ? BELTS_SOME : BELTS_NONE;
      }
    } else failed();
    cursor += ids.length;
    if (cursor >= table.size) {
      beltsRead = true;
      cursor = 0;
      phase = PHASE.CONTROL;
    }
  }

  function controlStep() {
    const from = cursor;
    const ids = idsOf(from, controlSlice);
    const r = safeCall(() => src.readControl(ids));
    if (isOk(r) && Array.isArray(r.systems)) {
      for (const s of r.systems) {
        const i = s ? table.indexOf.get(s.systemId) : undefined;
        if (i === undefined) continue;
        next.control[i] = dangerOfRow(s);
        if (next.ctrlF) {
          next.ctrlF[i] = factionByte(s.controllerFactionId);
          next.occF[i] = factionByte(s.occupierFactionId);
          next.alt[i] = OCCUPATION_DANGER[s.occupationState] || 0;
        }
      }
    } else {
      failed();
      copyRange("control", from, from + ids.length);
      if (next.ctrlF) for (const f of ["ctrlF", "occF", "alt"]) copyRange(f, from, from + ids.length);
    }
    cursor += ids.length;
    if (cursor >= table.size) {
      cursor = 0;
      phase = PHASE.GLOBAL;
    }
  }

  const mark = (field, systemId, bit) => {
    const i = table.indexOf.get(systemId);
    if (i !== undefined) next[field][i] |= bit;
  };

  function globalStep(now) {
    const battles = safeCall(() => src.readOpenBattleSystems(C.maxOpenBattles));
    if (isOk(battles) && Array.isArray(battles.systemIds)) {
      for (const id of battles.systemIds) mark("battle", id, 1);
    } else {
      failed();
      copyRange("battle", 0, table.size);
    }
    const events = safeCall(() => src.readOpenEvents(C.maxOpenEvents));
    if (isOk(events) && Array.isArray(events.events)) {
      for (const e of events.events) if (e) mark("events", e.systemId, 1 << W.attractOfEvent(e.eventType));
    } else {
      failed();
      copyRange("events", 0, table.size);
    }
    const veins = safeCall(() => src.richVeinSystems(), EMPTY_SET) || EMPTY_SET;
    if (typeof veins.forEach === "function") veins.forEach((id) => mark("events", id, 1 << W.ATTRACT.MINE));
    const wrecks = safeCall(() => src.readWreckSystems(now, C.maxWreckFields));
    if (isOk(wrecks) && Array.isArray(wrecks.systemIds)) {
      for (const id of wrecks.systemIds) mark("wrecks", id, 1 << W.WRECK_ATTRACT);
    } else {
      failed();
      copyRange("wrecks", 0, table.size);
    }
    phase = PHASE.SWAP;
  }

  function swapStep(now) {
    const b = next;
    const lists = Array.from({ length: W.ATTRACT_KINDS }, () => new Map());
    for (let i = 0; i < table.size; i += 1) {
      b.danger[i] = Math.max(b.control[i], b.battle[i] ? W.DANGER.OPEN_BATTLE : 0);
      if (b.danger[i] > 0) b.dangerSystems += 1;
      b.attract[i] = b.events[i] | b.wrecks[i];
      for (let k = 0; k < W.ATTRACT_KINDS; k += 1) {
        if (!(b.attract[i] & (1 << k))) continue;
        b.attractSystems[k] += 1;
        const list = lists[k].get(table.regionId[i]);
        if (list) list.push(table.systemIds[i]);
        else lists[k].set(table.regionId[i], [table.systemIds[i]]);
      }
    }
    b.byRegion = lists.map((m) => {
      const out = new Map();
      for (const [regionId, list] of m) out.set(regionId, Int32Array.from(list.sort((x, y) => x - y)));
      return out;
    });
    cur = b;
    next = null;
    lastRefreshAt = now;
    nextRefreshAt = now + C.refreshMs;
    bump("contextRefreshes");
    metric("observe", "population.contextMs", cycleMs);
    metric("gauge", "population.contextDangerSystems", b.dangerSystems);
    phase = PHASE.IDLE;
  }

  function pending(now) {
    if (!tableOf()) return false;
    return phase !== PHASE.IDLE || now >= nextRefreshAt;
  }

  function step(now) {
    if (!tableOf()) return { done: false, phase };
    const t0 = nowMs();
    let done = false;
    try {
      if (phase === PHASE.IDLE) {
        if (now >= nextRefreshAt) {
          next = emptyBuffer(table.size, standingTables() !== null);
          cycleMs = 0;
          cursor = 0;
          phase = beltsRead ? PHASE.CONTROL : PHASE.BELTS;
        }
      } else if (phase === PHASE.BELTS) beltsStep();
      else if (phase === PHASE.CONTROL) controlStep();
      else if (phase === PHASE.GLOBAL) globalStep(now);
      else if (phase === PHASE.SWAP) {
        cycleMs += Math.max(0, nowMs() - t0);
        swapStep(now);
        done = true;
        return { done, phase };
      }
    } catch (_err) {
      failed();
    }
    cycleMs += Math.max(0, nowMs() - t0);
    return { done, phase };
  }

  const indexOf = (systemId) => (table ? table.indexOf.get(systemId) : undefined);
  const curve = Array.isArray(src.hourCurvePermille) ? src.hourCurvePermille : null;

  function relAt(b, i, profile) {
    const c = b.ctrlF[i];
    const o = b.occF[i];
    if ((c === 0 && o === 0) || !Number.isSafeInteger(profile) || profile < 0 || st.F === 0) return R.REL.NEUTRAL;
    const at = (profile % st.P) * st.F - 1;
    const rc = c === 0 ? R.REL.FRIENDLY : c === R.OUTSIDE ? R.REL.NEUTRAL : st.rel[at + c];
    const ro = o === 0 ? R.REL.FRIENDLY : o === R.OUTSIDE ? R.REL.NEUTRAL : st.rel[at + o];
    if (rc === R.REL.HOSTILE || ro === R.REL.HOSTILE) return R.REL.HOSTILE;
    return rc === R.REL.FRIENDLY && ro === R.REL.FRIENDLY ? R.REL.FRIENDLY : R.REL.NEUTRAL;
  }

  const pirateByte = (x) => x > 0 && x !== R.OUTSIDE && st.pirate[x - 1] === 1;

  function profileDanger(systemId, profile, homeId) {
    const i = indexOf(systemId);
    if (!cur || i === undefined) return 0;
    const d = cur.danger[i];
    if (!cur.ctrlF) return d;
    const r = relAt(cur, i, profile);
    if (r === R.REL.HOSTILE) return systemId === homeId ? d : -1;
    if (r === R.REL.FRIENDLY) return Math.max(cur.alt[i], cur.battle[i] ? W.DANGER.OPEN_BATTLE : 0);
    return d;
  }

  const standingView = {
    dangerForProfile(systemId, profile, homeId) {
      const d = profileDanger(systemId, profile, homeId);
      if (d >= 0) return d;
      return Math.max(cur.danger[indexOf(systemId)], W.DANGER.HOSTILE_CONTROLLER);
    },
    weightForProfile(systemId, profile, homeId, avoidPermille) {
      const d = profileDanger(systemId, profile, homeId);
      return d < 0 ? 0 : Math.max(0, 1000 - (d * avoidPermille) / 1000);
    },
    hostileOnRoute(route, profile, homeId, out) {
      if (out) out.friendly = 0;
      if (!cur || !cur.ctrlF || !route || route.length === 0) return -1;
      const i0 = indexOf(route[0]);
      let leaving = route[route.length - 1] === homeId || (i0 !== undefined && relAt(cur, i0, profile) === R.REL.HOSTILE);
      for (let k = 1; k < route.length; k += 1) {
        const id = route[k];
        if (id === homeId) continue;
        const i = indexOf(id);
        if (i === undefined) continue;
        const r = relAt(cur, i, profile);
        if (r === R.REL.HOSTILE) {
          if (leaving) continue;
          return k;
        }
        leaving = false;
        if (out && r === R.REL.FRIENDLY && (pirateByte(cur.ctrlF[i]) || pirateByte(cur.occF[i]))) out.friendly = 1;
      }
      return -1;
    },
  };

  const view = Object.freeze({
    ...(standing ? standingView : {}),
    dangerOf(systemId) {
      const i = indexOf(systemId);
      return cur && i !== undefined ? cur.danger[i] : 0;
    },
    attracts(systemId, kind) {
      const i = indexOf(systemId);
      return cur !== null && i !== undefined && (cur.attract[i] & (1 << kind)) !== 0;
    },
    attractList(kind, regionId) {
      return cur && cur.byRegion && cur.byRegion[kind] ? cur.byRegion[kind].get(regionId) || null : null;
    },
    hasBelts(systemId) {
      const i = indexOf(systemId);
      if (!belts || i === undefined || belts[i] === 0) return null;
      return belts[i] === BELTS_SOME;
    },
    hourPermille(now) {
      if (!curve || typeof src.hourPermilleAt !== "function") return 1000;
      return safeCall(() => src.hourPermilleAt(curve, now), 1000);
    },
  });

  function status() {
    return Object.freeze({ phase, lastRefreshAt, dangerSystems: cur ? cur.dangerSystems : 0,
      attractSystems: Object.freeze(cur ? [...cur.attractSystems] : [0, 0, 0]), beltsRead });
  }

  function approxBytes() {
    const bufBytes = (b) => (b ? b.control.byteLength + b.battle.byteLength + b.events.byteLength + b.wrecks.byteLength
      + b.danger.byteLength + b.attract.byteLength
      + (b.ctrlF ? b.ctrlF.byteLength + b.occF.byteLength + b.alt.byteLength : 0) : 0);
    return bufBytes(cur) + (next !== cur ? bufBytes(next) : 0) + (belts ? belts.byteLength : 0);
  }

  return Object.freeze({ step, pending, view: () => view, status, approxBytes });
}

module.exports = { createWorldContext, PHASE };
