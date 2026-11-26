"use strict";

const { performance } = require("node:perf_hooks");
const { classifyEntries, endedSiegeIds, playerSovAllianceIds, harvestRaidLossTypeIds, KIND,
  AGGREGATE_TYPES, NATIVE_AGGREGATE, nativeBindTaleIds } = require("./sources");
const { proximityRecipients } = require("./recipients");
const { formatNoticeLine } = require("./format");
const { readFactionNames } = require("../world/sovProjection");

const MS_DECIMALS = 10;
const DEFAULT_LIST_LIMIT = 500;
const TAIL_STATE = Object.freeze({ PENDING: "pending", RUNNING: "running" });
const KIND_SWITCHES = Object.freeze([["kindAttackStarted", KIND.ATTACK_STARTED],
  ["kindSystemCaptured", KIND.SYSTEM_CAPTURED], ["kindSystemReleased", KIND.SYSTEM_RELEASED],
  ["kindAttackRepelled", KIND.ATTACK_REPELLED], ["kindSiegeStarted", KIND.SIEGE_STARTED],
  ["kindSiegeEnded", KIND.SIEGE_ENDED], ["kindPlayerImpact", KIND.PLAYER_IMPACT],
  ["kindStructureSiegeStarted", KIND.STRUCTURE_SIEGE_STARTED],
  ["kindStructureSiegeEnded", KIND.STRUCTURE_SIEGE_ENDED],
  ["kindPlayerSovSiege", KIND.PLAYER_SOV_SIEGE], ["kindPlayerSovReinforced", KIND.PLAYER_SOV_REINFORCED],
  ["kindPlayerSovLost", KIND.PLAYER_SOV_LOST],
  ["kindHarvestRaid", KIND.HARVEST_RAID_WARNED], ["kindHarvestRaid", KIND.HARVEST_RAID_ENDED]]);
const OWNER_KINDS = Object.freeze([KIND.STRUCTURE_SIEGE_STARTED, KIND.STRUCTURE_SIEGE_ENDED,
  KIND.PLAYER_SOV_SIEGE, KIND.PLAYER_SOV_REINFORCED, KIND.PLAYER_SOV_LOST, KIND.HARVEST_RAID_WARNED,
  KIND.HARVEST_RAID_ENDED]);
const NATIVE_KINDS = Object.freeze([KIND.NATIVE_INCURSION_STARTED, KIND.NATIVE_INCURSION_ENDED]);
const MAX_ALLIANCE_NAMES = 32;
const MAX_TYPE_NAMES = 32;

class Abort {
  constructor(result) {
    this.result = result;
  }
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function kindsOf(settings) {
  return new Set(KIND_SWITCHES.filter(([key]) => settings[key] !== false).map(([, kind]) => kind));
}

function createTail(deps) {
  const store = deps.store;
  const journal = deps.journal;
  const repo = deps.repo;
  const enqueue = deps.enqueue;
  const s = deps.settings;
  const soft = (fn) => () => {
    try {
      return typeof fn === "function" ? fn() || null : null;
    } catch (_err) {
      return null;
    }
  };
  const getWorldRepository = soft(deps.getWorldRepository);
  const getSiegeRepository = soft(deps.getSiegeRepository);
  const getPresence = soft(deps.getPresence);
  const getGraph = soft(deps.getGraph);
  const getGovernor = soft(deps.getGovernor);
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const observe = typeof deps.observe === "function" ? deps.observe : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const onCommitted = typeof deps.onCommitted === "function" ? deps.onCommitted : null;
  const hasWarListeners = typeof deps.hasWarListeners === "function" ? deps.hasWarListeners : () => false;
  const kinds = kindsOf(s);
  const heavy = deps.heavySettings || null;
  if (heavy && Number.isSafeInteger(heavy.announceMaxRecipients) && heavy.announceMaxRecipients > 0
    && Number.isSafeInteger(heavy.announceRadiusJumps) && heavy.announceRadiusJumps >= 0) {
    kinds.add(KIND.HEAVY_EVENT_STARTED);
  }
  const harvest = deps.harvestSettings || null;
  const harvestLeadMs = harvest && Number.isSafeInteger(harvest.warningMs) && harvest.warningMs >= 0
    && Number.isSafeInteger(harvest.raidMs) && harvest.raidMs >= 0 ? harvest.warningMs + harvest.raidMs : null;
  const native = deps.nativeSettings || null;
  const nativeOn = Boolean(native && Number.isSafeInteger(native.radiusJumps) && native.radiusJumps >= 0
    && Number.isSafeInteger(native.maxRecipients) && native.maxRecipients > 0
    && typeof deps.getNativeIncursionRow === "function");
  if (nativeOn) {
    kinds.add(KIND.NATIVE_INCURSION_STARTED);
    kinds.add(KIND.NATIVE_INCURSION_ENDED);
  }
  const aggregateTypes = Object.freeze(nativeOn ? [...AGGREGATE_TYPES, NATIVE_AGGREGATE] : [...AGGREGATE_TYPES]);
  const listLimit = Number.isSafeInteger(deps.listLimit) && deps.listLimit > 0 ? deps.listLimit : DEFAULT_LIST_LIMIT;

  let cursor = null;
  let head = null;
  let marks = new Map();
  let state = TAIL_STATE.PENDING;
  let offReason = null;
  let names = new Map();
  let failedAt = null;
  let failedPasses = 0;

  function tx(name, fn) {
    const r = store.transaction(name, (db) => {
      const out = fn(db);
      if (!out || out.ok !== true) throw new Abort(out || { ok: false, reason: "NO_RESULT" });
      return out;
    });
    if (r && r.ok) return { ok: true, value: r.value };
    if (r && r.error instanceof Abort) {
      const inner = r.error.result;
      return { ok: false, reason: String(inner.reason || "REFUSED"), ...(inner.detail ? { detail: inner.detail } : {}) };
    }
    return { ok: false, reason: r ? String(r.reason || "TX_FAILED") : "TX_FAILED",
      ...(r && r.error ? { detail: messageOf(r.error) } : {}) };
  }

  function governorAdmits() {
    try {
      const g = getGovernor();
      return !g || typeof g.admits !== "function" || g.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function graphOf() {
    const g = getGraph();
    if (!g || typeof g.getGraph !== "function") return null;
    const r = g.getGraph();
    return r && r.ok && r.graph ? r.graph : null;
  }

  function ownerSeam() {
    try {
      const seam = deps.adapter ? deps.adapter.playerStructures : null;
      return seam && typeof seam.listOwnerMemberIds === "function" ? seam : null;
    } catch (_err) {
      return null;
    }
  }

  function placeOf(graph, systemId) {
    const sys = graph && typeof graph.getSystem === "function" ? graph.getSystem(systemId) : null;
    const regionName = sys && sys.regionId != null && typeof graph.getRegionName === "function"
      ? graph.getRegionName(sys.regionId) : null;
    return { systemName: sys && sys.name ? sys.name : "", regionName: regionName || null };
  }

  function setOff(reason) {
    cursor = null;
    state = TAIL_STATE.PENDING;
    if (offReason !== reason) log(`tail off - ${reason}`);
    offReason = reason;
  }

  function bootstrap() {
    const world = getWorldRepository();
    if (!world || typeof world.listSystems !== "function") {
      setOff("WORLD_UNAVAILABLE");
      return { ok: false, reason: "WORLD_UNAVAILABLE" };
    }
    if (typeof journal.headId !== "function" || typeof journal.listAfter !== "function") {
      setOff("JOURNAL_TAIL_UNAVAILABLE");
      return { ok: false, reason: "JOURNAL_TAIL_UNAVAILABLE" };
    }
    let r;
    try {
      r = tx("notices.bootstrap", (db) => {
        const h = journal.headId(db);
        if (!h.ok) return h;
        const read = new Map();
        let after = 0;
        for (;;) {
          const page = world.listSystems(db, { afterSystemId: after, limit: listLimit,
            includeInfluence: false });
          if (!page.ok) return page;
          for (const sys of page.systems) {
            read.set(Number(sys.systemId), Object.freeze({ state: sys.occupationState ?? null,
              controller: sys.controllerFactionId ?? null, occupier: sys.occupierFactionId ?? null }));
          }
          if (page.nextAfterSystemId === null) break;
          after = page.nextAfterSystemId;
        }
        return { ok: true, headId: h.headId, marks: read };
      });
    } catch (err) {
      r = { ok: false, reason: "BOOTSTRAP_THREW", detail: messageOf(err) };
    }
    if (!r.ok) {
      bump("errors");
      setOff(r.reason);
      return { ok: false, reason: r.reason };
    }
    cursor = r.value.headId;
    head = r.value.headId;
    marks = r.value.marks;
    state = TAIL_STATE.RUNNING;
    offReason = null;
    names = readFactionNames(deps.adapter || null, deps.logger || null);
    return { ok: true, headId: cursor, systems: marks.size };
  }

  function itemsOf(db, event, graph, cap) {
    const items = [];
    const place = placeOf(graph, event.systemId);
    const line = (personal) => formatNoticeLine(event, { ...place, names, personal });
    const add = (characterId, personal) => items.push({ eventKey: event.eventKey, characterId, kind: event.kind,
      systemId: event.systemId, line: line(personal), eventAt: event.at });
    if (event.kind === KIND.PLAYER_IMPACT) {
      add(event.characterId, true);
      return { ok: true, items };
    }
    if (OWNER_KINDS.includes(event.kind)) {
      const seam = ownerSeam();
      let got = null;
      try {
        got = seam ? seam.listOwnerMemberIds(event.ownerCorpId, { max: Math.min(s.maxOwnerRecipients, cap) }) : null;
      } catch (_err) {
        got = null;
      }
      if (!got || got.ok !== true || !Array.isArray(got.characterIds)) {
        bump("recipientsUnavailable");
        return { ok: true, items };
      }
      if (got.truncated === true) bump("recipientsTruncated");
      for (const id of got.characterIds) add(id, false);
      return { ok: true, items };
    }
    const isHeavy = event.kind === KIND.HEAVY_EVENT_STARTED;
    const isNative = nativeOn && NATIVE_KINDS.includes(event.kind);
    let jumps = s.proximityJumps;
    let max = s.maxRecipientsPerEvent;
    if (isHeavy) {
      jumps = heavy.announceRadiusJumps;
      max = heavy.announceMaxRecipients;
    } else if (isNative) {
      jumps = native.radiusJumps;
      max = native.maxRecipients;
    }
    const near = proximityRecipients({ graph, presence: getPresence(), systemId: event.systemId, jumps,
      max: Math.min(max, cap) });
    let nearIds = [];
    if (!near.ok) bump("recipientsUnavailable");
    else {
      nearIds = near.characterIds;
      if (near.truncated) bump("recipientsTruncated");
    }
    for (const id of nearIds) add(id, false);
    if (event.kind === KIND.SYSTEM_RELEASED && s.impactWindowMs > 0 && s.maxImpactRecipients > 0
      && items.length < cap) {
      const listed = repo.listImpactContributorsInTx(db, { systemId: event.systemId,
        since: Math.max(0, event.at - s.impactWindowMs), limit: s.maxImpactRecipients });
      if (!listed.ok) return listed;
      const nearSet = new Set(nearIds);
      for (const id of listed.characterIds) {
        if (items.length >= cap) {
          bump("recipientsTruncated");
          break;
        }
        if (!nearSet.has(id)) add(id, true);
      }
    }
    return { ok: true, items };
  }

  function allianceNamesOf(entries) {
    const ids = playerSovAllianceIds(entries, MAX_ALLIANCE_NAMES);
    const adapter = deps.adapter || null;
    if (ids.length === 0 || !adapter || typeof adapter.readPlayerOrgNames !== "function") return new Map();
    try {
      const r = adapter.readPlayerOrgNames({ allianceIds: ids });
      return r && r.ok === true && r.alliances instanceof Map ? r.alliances : new Map();
    } catch (_err) {
      return new Map();
    }
  }

  function typeNamesOf(entries) {
    const ids = harvestRaidLossTypeIds(entries, MAX_TYPE_NAMES);
    if (ids.length === 0 || !deps.adapter) return new Map();
    try {
      const bays = deps.adapter.harvestBays;
      if (!bays || typeof bays.readTypeNames !== "function") return new Map();
      const r = bays.readTypeNames({ typeIds: ids });
      return r && r.ok === true && r.names instanceof Map ? r.names : new Map();
    } catch (_err) {
      return new Map();
    }
  }

  function nativeTargetsOf(db, entries) {
    const out = new Map();
    for (const taleId of nativeBindTaleIds(entries, entries.length)) {
      const got = deps.getNativeIncursionRow(db, taleId);
      if (got && got.ok === true && got.row) out.set(taleId, got.row.targetSystemId);
    }
    return out;
  }

  function passInTx(db, now) {
    const h = journal.headId(db);
    if (!h.ok) return h;
    const headId = h.headId;
    if (headId < cursor || headId - cursor > s.tailMaxLagRows) {
      return { ok: true, lag: true, headId, skipped: Math.max(0, headId - cursor) };
    }
    const rowCap = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : s.tailMaxRowsPerPass;
    const listed = journal.listAfter(db, { afterId: cursor, uptoId: Math.min(headId, cursor + s.tailScanWindow),
      aggregateTypes: [...aggregateTypes], limit: Math.max(1, Math.min(s.tailMaxRowsPerPass, rowCap)) });
    if (!listed.ok) return listed;
    const entries = listed.entries;
    const sieges = new Map();
    const ended = endedSiegeIds(entries);
    if (ended.length > 0) {
      const siegeRepo = getSiegeRepository();
      if (!siegeRepo || typeof siegeRepo.getSiege !== "function") bump("sourceMissing", ended.length);
      else {
        for (const id of ended) {
          const got = siegeRepo.getSiege(db, id);
          sieges.set(id, got && got.ok && got.siege ? got.siege : null);
        }
      }
    }
    const ctx = { now, maxEventAgeMs: s.maxEventAgeMs, kinds, sieges, allianceNames: allianceNamesOf(entries),
      harvestLeadMs, typeNames: typeNamesOf(entries), nativeTargets: nativeOn ? nativeTargetsOf(db, entries) : null };
    const classified = classifyEntries(entries, marks, ctx);
    const graph = graphOf();
    let queued = 0;
    let done = 0;
    let stopAt = null;
    const warEvents = [];
    const warRecipients = new Map();
    const units = [];
    for (const ev of classified.events) {
      const last = units[units.length - 1];
      if (last && last.journalId === ev.journalId) last.events.push(ev);
      else units.push({ journalId: ev.journalId, events: [ev] });
    }
    for (const unit of units) {
      const room = s.maxItemsPerPass - queued;
      const unitItems = [];
      for (const ev of unit.events) {
        const cap = queued === 0 ? Math.max(1, room - unitItems.length) : Number.MAX_SAFE_INTEGER;
        const got = itemsOf(db, ev, graph, cap);
        if (!got.ok) return got;
        unitItems.push(...got.items);
      }
      if (queued > 0 && unitItems.length > room) {
        stopAt = unit.journalId;
        break;
      }
      if (unitItems.length > 0) {
        const r = enqueue(db, unitItems, now);
        if (!r || !r.ok) return r || { ok: false, reason: "ENQUEUE_NO_RESULT" };
      }
      for (const it of unitItems) {
        if (!warRecipients.has(it.eventKey)) warRecipients.set(it.eventKey, new Set());
        warRecipients.get(it.eventKey).add(it.characterId);
      }
      queued += unitItems.length;
      done += unit.events.length;
      warEvents.push(...unit.events);
    }
    let delta = classified.marks;
    let next = listed.scannedUpTo;
    let rows = entries.length;
    let skipped = classified.skipped;
    if (stopAt !== null) {
      const doneEntries = entries.filter((e) => e.journalId < stopAt);
      const partial = classifyEntries(doneEntries, marks, ctx);
      delta = partial.marks;
      skipped = partial.skipped;
      next = stopAt - 1;
      rows = doneEntries.length;
    }
    return { ok: true, lag: false, headId, cursor: next, delta, rows, events: done, items: queued, skipped,
      stopped: stopAt !== null, warEvents, warRecipients };
  }

  function deliverCommitted(events, recipientsByKey) {
    if (!onCommitted || !Array.isArray(events) || events.length === 0) return;
    try {
      if (hasWarListeners() !== true) return;
      const graph = graphOf();
      const nameOf = (id) => (id === null || id === undefined ? null : names.get(id) || null);
      const views = Object.freeze(events.map((ev) => {
        const place = placeOf(graph, ev.systemId);
        const got = recipientsByKey instanceof Map ? recipientsByKey.get(ev.eventKey) : null;
        const recipients = Object.freeze(got ? [...got].sort((a, b) => a - b) : []);
        const ended = ev.kind === KIND.SIEGE_ENDED || ev.kind === KIND.STRUCTURE_SIEGE_ENDED;
        return Object.freeze({ eventKey: ev.eventKey, kind: ev.kind, systemId: ev.systemId, at: ev.at,
          attackerName: nameOf(ev.attacker), defenderName: nameOf(ev.defender), systemName: place.systemName,
          regionName: place.regionName, recipients,
          outcome: ended && typeof ev.outcome === "string" ? ev.outcome : null });
      }));
      onCommitted(views);
    } catch (err) {
      bump("errors");
      log(`war events delivery failed - ${messageOf(err)}`);
    }
  }

  function runPass(now, opts) {
    const force = opts && opts.force === true;
    if (state !== TAIL_STATE.RUNNING) {
      if (force) return { ok: false, reason: offReason || "TAIL_NOT_STARTED" };
      const b = bootstrap();
      if (!b.ok) return b;
    }
    if (!force && !governorAdmits()) return { ok: true, deferred: true, rows: 0, events: 0, items: 0, cursor };
    const t0 = nowMs();
    let r;
    try {
      r = tx("notices.tail", (db) => passInTx(db, now));
    } catch (err) {
      r = { ok: false, reason: "TAIL_THREW", detail: messageOf(err) };
    } finally {
      observe("tailMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    }
    if (!r.ok) {
      bump("errors");
      log(`tail pass ${r.reason}${r.detail ? ` - ${r.detail}` : ""}`);
      if (failedAt === cursor) failedPasses += 1;
      else {
        failedAt = cursor;
        failedPasses = 1;
      }
      if (failedPasses < s.tailMaxFailedPasses) return { ok: false, reason: r.reason };
      const from = cursor;
      failedAt = null;
      failedPasses = 0;
      bump("tailSkippedFailed");
      log(`tail ${s.tailMaxFailedPasses} failed passes at journal ${from} (${r.reason}) - jump to the head`);
      const b = bootstrap();
      return b.ok ? { ok: false, reason: r.reason, skippedFailed: true, cursor } : b;
    }
    failedAt = null;
    failedPasses = 0;
    const v = r.value;
    head = v.headId;
    if (v.lag) {
      bump("tailSkippedLag", Math.max(1, v.skipped));
      log(`tail lag ${v.skipped} rows above tailMaxLagRows - jump to the head ${v.headId}`);
      const b = bootstrap();
      return b.ok ? { ok: true, rows: 0, events: 0, items: 0, cursor } : b;
    }
    cursor = v.cursor;
    for (const [id, mark] of v.delta) marks.set(id, mark);
    if (v.rows > 0) bump("tailRows", v.rows);
    if (v.events > 0) bump("events", v.events);
    if (v.skipped.STALE) bump("eventsStale", v.skipped.STALE);
    if (v.skipped.SIEGE_MISSING) bump("sourceMissing", v.skipped.SIEGE_MISSING);
    deliverCommitted(v.warEvents, v.warRecipients);
    return { ok: true, rows: v.rows, events: v.events, items: v.items, cursor };
  }

  function flush(now) {
    try {
      return runPass(now, { force: true });
    } catch (err) {
      return { ok: false, reason: "FLUSH_THREW", detail: messageOf(err) };
    }
  }

  function getStatus() {
    return { tail: state === TAIL_STATE.RUNNING ? "running" : `off:${offReason || "not_started"}`, cursor, head,
      lag: cursor !== null && head !== null ? Math.max(0, head - cursor) : null, marks: marks.size };
  }

  function lineOf(event) {
    return formatNoticeLine(event, { ...placeOf(graphOf(), event.systemId), names });
  }

  return Object.freeze({ bootstrap, runPass, flush, getStatus, lineOf });
}

module.exports = { createTail, kindsOf, KIND_SWITCHES };
