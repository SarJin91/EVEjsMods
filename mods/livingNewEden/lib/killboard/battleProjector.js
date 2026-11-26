"use strict";

const { planBattle } = require("./battlePlan");
const { typesToPrice, priceFromBasePrice } = require("./pricing");
const { WORK_CLASS, MAX_NAME_LENGTH } = require("./schema");

const SOURCE = "battles";
const SCAN_PAGE = 200;
const FACT_BATCH = 64;
const COMPLETED = "COMPLETED";

const keyAfter = (a, b) => a.atMs > b.atMs || (a.atMs === b.atMs && a.keyText > b.keyText);
const keyOf = (item) => ({ atMs: item.settledAt, keyText: item.battleId });

function messageOf(err) {
  return String((err && err.message) || err).slice(0, 200);
}

function createBattleProjector(deps) {
  const { store, repo, P, rowsCap } = deps;
  const clock = deps.clock;
  const count = typeof deps.count === "function" ? deps.count : () => {};
  const gauge = typeof deps.gauge === "function" ? deps.gauge : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  let inPass = false;
  const status = { passes: 0, lastPassAt: null, lastPassMs: null, watermarkAt: null, rows: 0, backlogHint: false,
    battles: "PENDING", lastError: null, lastDeferred: null,
    counters: { ingested: 0, known: 0, deferredGovernor: 0, deferredRows: 0, deferredTime: 0, pricesDeferred: 0,
      unattributed: 0, oversize: 0, planInvalid: 0, pruned: 0, passErrors: 0 } };

  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  };

  function admitted() {
    const governor = safe(() => deps.getGovernor(), null);
    if (!governor || typeof governor.admits !== "function") return true;
    return safe(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function fail(reason, detail) {
    status.counters.passErrors += 1;
    status.lastError = detail === undefined ? reason : `${reason}: ${detail}`;
    count("killboard.passErrors");
    return { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
  }

  function scan(db, battleRepo, nowMs) {
    const cur = repo.readCursor(db, SOURCE);
    if (!cur.ok) return cur;
    const cursor = cur.cursor || { atMs: P.battleBackfillMs === 0 ? 0 : Math.max(0, nowMs - P.battleBackfillMs),
      keyText: "", keyInt: 0, rows: 0 };
    const cursorKey = { atMs: cursor.atMs, keyText: cursor.keyText };
    const start = Math.max(0, cursor.atMs - P.battleOverlapMs);
    let inOverlap = start < cursor.atMs || cursor.keyText !== "";
    const half = Math.max(1, Math.floor(P.maxScanRowsPerPass / 2));
    const scanned = [];
    let afterMs = start;
    let afterId = "";
    let complete = false;
    while (scanned.length < P.maxScanRowsPerPass) {
      const room = P.maxScanRowsPerPass - scanned.length;
      const limit = Math.min(SCAN_PAGE, room, inOverlap ? half - scanned.length : room);
      if (limit <= 0) {
        afterMs = cursorKey.atMs;
        afterId = cursorKey.keyText;
        inOverlap = false;
        continue;
      }
      const page = battleRepo.listSettledAfter(db, { afterMs, afterBattleId: afterId, limit });
      if (!page || page.ok !== true) return { ok: false, reason: "SCAN_FAILED", detail: String(page && page.reason) };
      for (const r of page.rows) scanned.push(r);
      if (page.rows.length < limit) {
        complete = true;
        break;
      }
      const last = page.rows[page.rows.length - 1];
      afterMs = last.settledAt;
      afterId = last.battleId;
      if (inOverlap && keyAfter(keyOf(last), cursorKey)) inOverlap = false;
    }
    const known = repo.knownBattleIds(db, scanned.map((r) => r.battleId));
    if (!known.ok) return known;
    const unknown = scanned.filter((r) => !known.known.has(r.battleId)).slice(0, P.maxBattlesPerPass);
    const loaded = [];
    for (const item of unknown) {
      const b = battleRepo.getBattle(db, item.battleId);
      if (!b || b.ok !== true) return { ok: false, reason: "BATTLE_READ_FAILED", detail: String(b && b.reason) };
      if (!b.battle || b.battle.state !== COMPLETED) {
        loaded.push({ item, battle: null, losses: [] });
        continue;
      }
      const l = battleRepo.getLosses(db, item.battleId);
      if (!l || l.ok !== true) return { ok: false, reason: "LOSSES_READ_FAILED", detail: String(l && l.reason) };
      loaded.push({ item, battle: b.battle, losses: l.losses });
    }
    const allTypes = typesToPrice(loaded.flatMap((c) => c.losses), null);
    const read = repo.readPrices(db, allTypes);
    if (!read.ok) return read;
    const prices = read.prices;
    const toPrice = [];
    const pending = new Set();
    const candidates = [];
    for (const c of loaded) {
      const fresh = typesToPrice(c.losses, prices).filter((t) => !pending.has(t));
      if (candidates.length > 0 && toPrice.length + fresh.length > P.maxPriceTypesPerPass) break;
      for (const t of fresh) {
        pending.add(t);
        toPrice.push(t);
      }
      candidates.push(c);
    }
    return { ok: true, cursor, scanned, known: known.known, candidates, prices, toPrice, complete };
  }

  function priceTypes(typeIds) {
    const rows = [];
    const deferred = new Set();
    for (let i = 0; i < typeIds.length; i += FACT_BATCH) {
      const chunk = typeIds.slice(i, i + FACT_BATCH);
      const r = safe(() => deps.readItemTypeFacts(chunk), null);
      if (!r || r.ok !== true || !(r.facts instanceof Map)) {
        for (const t of chunk) deferred.add(t);
        continue;
      }
      for (const t of chunk) {
        const fact = r.facts.get(t);
        if (fact) {
          const name = typeof fact.name === "string" && fact.name.length >= 1 ? fact.name.slice(0, MAX_NAME_LENGTH) : null;
          rows.push({ typeId: t, isk: priceFromBasePrice(fact.basePrice), name });
        } else if (Array.isArray(r.missing) && r.missing.includes(t)) {
          rows.push({ typeId: t, isk: null, name: null });
        } else {
          deferred.add(t);
        }
      }
    }
    return { rows, deferred };
  }

  function write(db, s, priced, nowMs, startedAt) {
    const ins = repo.insertPrices(db, priced.rows.slice(0, Math.floor(rowsCap / 2)), nowMs);
    if (!ins.ok) return ins;
    const priceMap = new Map();
    for (const [t, p] of s.prices) priceMap.set(t, p.isk);
    for (const r of priced.rows) priceMap.set(r.typeId, r.isk);
    let used = ins.inserted;
    const cursorKey = { atMs: s.cursor.atMs, keyText: s.cursor.keyText };
    let mark = cursorKey;
    const advance = (item) => {
      const k = keyOf(item);
      if (keyAfter(k, mark)) mark = k;
    };
    const byId = new Map(s.candidates.map((c) => [c.item.battleId, c]));
    let ingested = 0;
    let knownNow = 0;
    let deferred = null;
    const local = { unattributed: 0, oversize: 0, planInvalid: 0 };
    for (const item of s.scanned) {
      if (s.known.has(item.battleId)) {
        advance(item);
        continue;
      }
      const c = byId.get(item.battleId);
      if (!c) {
        deferred = "LIMIT";
        break;
      }
      if (c.battle === null) {
        advance(item);
        continue;
      }
      if (ingested + knownNow > 0 && clock.now() - startedAt > P.maxPassMs) {
        deferred = "TIME";
        break;
      }
      const plan = planBattle(c.battle, c.losses, priceMap);
      if (!plan.ok) {
        local.planInvalid += 1;
        log(`killboard: battle ${item.battleId} skipped - ${plan.reason} ${plan.detail}`);
        advance(item);
        continue;
      }
      const n = 1 + plan.sides.length + plan.deltas.length;
      if (n > rowsCap - 1) {
        local.oversize += 1;
        advance(item);
        continue;
      }
      if (used + n + 1 > rowsCap) {
        deferred = "ROWS";
        break;
      }
      const r = repo.insertBattle(db, plan, nowMs);
      if (!r.ok) return r;
      if (r.inserted) {
        used += n;
        ingested += 1;
        local.unattributed += plan.unattributed;
      } else {
        knownNow += 1;
      }
      advance(item);
    }
    const rows = s.cursor.rows + ingested;
    const w = repo.writeCursor(db, SOURCE, { atMs: mark.atMs, keyText: mark.keyText, keyInt: s.cursor.keyInt || 0,
      rows }, nowMs);
    if (!w.ok) return w;
    return { ok: true, ingested, knownNow, deferred, rows, mark, pricesInserted: ins.inserted, local };
  }

  function prune(nowMs) {
    const batch = Math.max(1, Math.min(P.pruneBatch, Math.floor(rowsCap / 2)));
    const r = store.transaction("killboard.battles.prune", (db) => {
      const cur = repo.readCursor(db, SOURCE);
      if (!cur.ok || !cur.cursor) return { ok: false, reason: cur.ok ? "NO_CURSOR" : cur.reason };
      const d = repo.pruneBattles(db, P.maxBattleRows, batch, rowsCap);
      if (!d.ok || d.deleted === 0) return d.ok ? { ok: true, deleted: 0, rows: cur.cursor.rows } : d;
      const rows = Math.max(0, cur.cursor.rows - d.deleted);
      const w = repo.writeCursor(db, SOURCE, { ...cur.cursor, rows }, nowMs);
      if (!w.ok) return w;
      return { ok: true, deleted: d.deleted, rows };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    if (!r.value.ok) return r.value;
    return r.value;
  }

  function runPass(nowMs) {
    if (!isRunning()) return { ok: true, ingested: 0, known: 0, deferred: "NOT_RUNNING" };
    if (inPass) return { ok: true, ingested: 0, known: 0, deferred: "BUSY" };
    if (!admitted()) {
      status.counters.deferredGovernor += 1;
      status.lastDeferred = "GOVERNOR";
      count("killboard.deferredGovernor");
      return { ok: true, ingested: 0, known: 0, deferred: "GOVERNOR" };
    }
    const battleRepo = safe(() => deps.getBattleRepository(), null);
    if (!battleRepo || typeof battleRepo.listSettledAfter !== "function" || typeof battleRepo.getBattle !== "function"
      || typeof battleRepo.getLosses !== "function") {
      status.battles = "BATTLES_UNAVAILABLE";
      return { ok: true, ingested: 0, known: 0, deferred: "BATTLES_UNAVAILABLE" };
    }
    status.battles = "OK";
    inPass = true;
    const startedAt = clock.now();
    try {
      return pass(battleRepo, nowMs, startedAt);
    } catch (err) {
      return fail("PASS_FAILED", messageOf(err));
    } finally {
      inPass = false;
      status.passes += 1;
      status.lastPassAt = nowMs;
      status.lastPassMs = Math.max(0, clock.now() - startedAt);
      count("killboard.passes");
      gauge("killboard.passMs", status.lastPassMs);
    }
  }

  function pass(battleRepo, nowMs, startedAt) {
    const read = store.transaction("killboard.battles.scan", (db) => scan(db, battleRepo, nowMs));
    if (!read.ok) return fail(read.reason);
    const s = read.value;
    if (!s.ok) return fail(s.reason, s.detail);
    const priced = priceTypes(s.toPrice);
    if (priced.deferred.size > 0) {
      status.counters.pricesDeferred += priced.deferred.size;
      count("killboard.pricesDeferred", priced.deferred.size);
    }
    const wr = store.transaction("killboard.battles.write", (db) => write(db, s, priced, nowMs, startedAt));
    if (!wr.ok) return fail(wr.reason, wr.error ? messageOf(wr.error) : undefined);
    const w = wr.value;
    if (!w.ok) return fail(w.reason, w.detail);
    if (w.ingested > 0 || w.pricesInserted > 0) safe(() => deps.onWrite(), null);
    const knownCount = s.known.size + w.knownNow;
    status.counters.ingested += w.ingested;
    status.counters.known += knownCount;
    status.counters.unattributed += w.local.unattributed;
    status.counters.oversize += w.local.oversize;
    status.counters.planInvalid += w.local.planInvalid;
    count("killboard.battlesIngested", w.ingested);
    count("killboard.battlesKnown", knownCount);
    if (w.local.unattributed > 0) count("killboard.unattributedLosses", w.local.unattributed);
    if (w.local.oversize > 0) count("killboard.oversize", w.local.oversize);
    if (w.local.planInvalid > 0) count("killboard.planInvalid", w.local.planInvalid);
    if (w.deferred === "ROWS") {
      status.counters.deferredRows += 1;
      count("killboard.deferredRows");
    } else if (w.deferred === "TIME") {
      status.counters.deferredTime += 1;
      count("killboard.deferredTime");
    }
    status.rows = w.rows;
    status.watermarkAt = w.mark.atMs;
    status.backlogHint = !s.complete || w.deferred !== null;
    status.lastDeferred = w.deferred;
    status.lastError = null;
    if (w.rows > P.maxBattleRows) {
      const p = prune(nowMs);
      if (!p.ok) return fail(p.reason, p.detail);
      if (p.deleted > 0) {
        status.counters.pruned += p.deleted;
        status.rows = p.rows;
        count("killboard.pruned", p.deleted);
        safe(() => deps.onWrite(), null);
      }
    }
    return { ok: true, ingested: w.ingested, known: knownCount, deferred: w.deferred };
  }

  function getStatus() {
    return Object.freeze({ passes: status.passes, lastPassAt: status.lastPassAt, lastPassMs: status.lastPassMs,
      watermarkAt: status.watermarkAt, rows: status.rows, backlogHint: status.backlogHint, battles: status.battles,
      lastError: status.lastError, lastDeferred: status.lastDeferred, counters: Object.freeze({ ...status.counters }) });
  }

  return Object.freeze({ runPass, getStatus });
}

module.exports = { createBattleProjector };
