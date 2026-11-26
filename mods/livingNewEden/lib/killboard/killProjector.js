"use strict";

const { classifyKill, planKill } = require("./killPlan");
const { priceFromBasePrice } = require("./pricing");
const { WORK_CLASS, MAX_NAME_LENGTH, CURSOR_STATE_REWOUND, CURSOR_STATE_RESETTING,
  PENDING_BACKOFF_PASSES } = require("./schema");

const SOURCE = "kills";
const CHAR_BATCH = 64;
const ORG_BATCH = 32;
const TYPE_BATCH = 64;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, 200);
}

const cleanName = (v) => (typeof v === "string" && v.length >= 1 ? v.slice(0, MAX_NAME_LENGTH) : null);

function createKillProjector(deps) {
  const { store, repo, P, rowsCap } = deps;
  const clock = deps.clock;
  const count = typeof deps.count === "function" ? deps.count : () => {};
  const gauge = typeof deps.gauge === "function" ? deps.gauge : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  let inPass = false;
  let lastPending = null;
  const status = { kills: "PENDING", passes: 0, lastPassAt: null, lastPassMs: null, cursor: 0, rows: 0, lastStop: null,
    lastError: null, lastDeferred: null, pendingStopAgeMs: null,
    counters: { examined: 0, ingested: 0, known: 0, skippedNpc: 0, skippedLneNpc: 0, skippedOld: 0, invalid: 0,
      holes: 0, bad: 0, pendingStops: 0, pendingBackoff: 0, deferredGovernor: 0, deferredRows: 0, deferredTime: 0,
      oversize: 0, namesResolved: 0, namesDeferred: 0, vendorRewound: 0, pruned: 0, passErrors: 0,
      skippedStalePending: 0, resetRows: 0, resets: 0 } };

  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  };
  const bump = (key, metric, n = 1) => {
    if (n <= 0) return;
    status.counters[key] += n;
    count(metric, n);
  };

  function admitted() {
    const governor = safe(() => deps.getGovernor(), null);
    if (!governor || typeof governor.admits !== "function") return true;
    return safe(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function fail(reason, detail) {
    status.counters.passErrors += 1;
    status.lastError = detail === undefined ? reason : `${reason}: ${detail}`;
    count("killboard.killPassErrors");
    return { ok: false, reason, ...(detail === undefined ? {} : { detail }) };
  }

  const done = (deferred, extra = {}) => ({ ok: true, ingested: 0, deferred, ...extra });

  function resolve(unknown) {
    const names = [];
    const prices = [];
    let deferred = 0;
    for (let i = 0; i < unknown.char.length; i += CHAR_BATCH) {
      const chunk = unknown.char.slice(i, i + CHAR_BATCH);
      const r = safe(() => deps.readCharacterNames(chunk), null);
      if (!r || r.ok !== true || !(r.names instanceof Map)) {
        deferred += chunk.length;
        continue;
      }
      for (const id of chunk) {
        const name = cleanName(r.names.get(id));
        if (name !== null) names.push({ kind: "char", id, name });
      }
    }
    for (const [kind, key, field] of [["corp", "corpIds", "corps"], ["alliance", "allianceIds", "alliances"]]) {
      for (let i = 0; i < unknown[kind].length; i += ORG_BATCH) {
        const chunk = unknown[kind].slice(i, i + ORG_BATCH);
        const r = safe(() => deps.readPlayerOrgNames({ [key]: chunk }), null);
        if (!r || r.ok !== true || !(r[field] instanceof Map)) {
          deferred += chunk.length;
          continue;
        }
        for (const id of chunk) {
          const name = cleanName(r[field].get(id));
          if (name !== null) names.push({ kind, id, name });
        }
      }
    }
    for (let i = 0; i < unknown.types.length; i += TYPE_BATCH) {
      const chunk = unknown.types.slice(i, i + TYPE_BATCH);
      const r = safe(() => deps.readItemTypeFacts(chunk), null);
      if (!r || r.ok !== true || !(r.facts instanceof Map)) {
        deferred += chunk.length;
        continue;
      }
      for (const t of chunk) {
        const fact = r.facts.get(t);
        if (fact) prices.push({ typeId: t, isk: priceFromBasePrice(fact.basePrice), name: cleanName(fact.name) });
        else if (Array.isArray(r.missing) && r.missing.includes(t)) prices.push({ typeId: t, isk: null, name: null });
        else deferred += 1;
      }
    }
    return { names, prices, deferred };
  }

  function unknownOf(db, plans) {
    const want = { char: new Set(), corp: new Set(), alliance: new Set(), types: new Set() };
    for (const p of plans) {
      for (const kind of ["char", "corp", "alliance"]) for (const id of p.names[kind]) want[kind].add(id);
      for (const t of p.typeIds) want.types.add(t);
    }
    const out = { char: [], corp: [], alliance: [], types: [] };
    let room = P.maxNamesPerPass;
    for (const kind of ["char", "corp", "alliance"]) {
      const ids = [...want[kind]].sort((a, b) => a - b);
      const known = repo.knownNames(db, kind, ids);
      if (!known.ok) return known;
      for (const id of ids) {
        if (room <= 0) break;
        if (known.known.has(id)) continue;
        out[kind].push(id);
        room -= 1;
      }
    }
    const types = [...want.types].sort((a, b) => a - b);
    const priced = repo.readPrices(db, types);
    if (!priced.ok) return priced;
    for (const t of types) {
      if (room <= 0) break;
      if (priced.prices.has(t)) continue;
      out.types.push(t);
      room -= 1;
    }
    return { ok: true, unknown: out };
  }

  function write(db, s, nowMs) {
    const half = Math.floor(rowsCap / 2);
    const nameRows = s.resolved.names.slice(0, half);
    const priceRows = s.resolved.prices.slice(0, Math.max(0, half - nameRows.length));
    const insNames = repo.insertNames(db, nameRows, nowMs);
    if (!insNames.ok) return insNames;
    const insPrices = repo.insertPrices(db, priceRows, nowMs);
    if (!insPrices.ok) return insPrices;
    let used = insNames.inserted + insPrices.inserted;
    const loopStart = clock.now();
    const local = { ingested: 0, known: 0, skippedNpc: 0, skippedLneNpc: 0, skippedOld: 0, invalid: 0, oversize: 0 };
    let consumed = 0;
    let deferred = null;
    let lastAt = s.cursor.atMs;
    let breakAt = null;
    for (const item of s.items) {
      if (consumed > 0 && clock.now() - loopStart > P.maxPassMs) {
        deferred = "TIME";
        breakAt = item.fact.killId;
        break;
      }
      if (item.decision !== "ACCEPT") {
        if (item.decision === "SKIP_NPC") local.skippedNpc += 1;
        else if (item.decision === "SKIP_LNE_NPC") local.skippedLneNpc += 1;
        else if (item.decision === "SKIP_OLD") local.skippedOld += 1;
        else local.invalid += 1;
      } else {
        const plan = item.plan;
        const n = 1 + plan.chars.length + plan.deltas.length;
        if (n > rowsCap - 1) {
          local.oversize += 1;
        } else if (used + n + 1 > rowsCap) {
          deferred = "ROWS";
          breakAt = item.fact.killId;
          break;
        } else {
          const r = repo.insertKill(db, plan, nowMs);
          if (!r.ok) return r;
          if (r.inserted) {
            used += n;
            local.ingested += 1;
          } else {
            local.known += 1;
          }
        }
      }
      consumed += 1;
      if (Number.isSafeInteger(item.fact.killAtMs)) lastAt = Math.max(lastAt, item.fact.killAtMs);
    }
    let key = s.read.cursor;
    let kind = s.read.cursorKind;
    if (breakAt !== null) {
      key = breakAt - 1;
      kind = key === s.cursor.keyInt ? s.cursor.keyText : (s.factIds.has(key) ? "R" : "H");
    }
    const rows = s.cursor.rows + local.ingested;
    const w = repo.writeCursor(db, SOURCE, { atMs: lastAt, keyText: kind, keyInt: key, rows }, nowMs);
    if (!w.ok) return w;
    return { ok: true, local, deferred, rows, key, kind, inserted: insNames.inserted + insPrices.inserted };
  }

  function prune(nowMs) {
    const batch = Math.max(1, Math.min(P.pruneBatch, Math.floor(rowsCap / 2)));
    const r = store.transaction("killboard.kills.prune", (db) => {
      const cur = repo.readCursor(db, SOURCE);
      if (!cur.ok || !cur.cursor) return { ok: false, reason: cur.ok ? "NO_CURSOR" : cur.reason };
      const d = repo.pruneKills(db, P.maxKillRows, batch, rowsCap);
      if (!d.ok || d.deleted === 0) return d.ok ? { ok: true, deleted: 0, rows: cur.cursor.rows } : d;
      const rows = Math.max(0, cur.cursor.rows - d.deleted);
      const w = repo.writeCursor(db, SOURCE, { ...cur.cursor, rows }, nowMs);
      if (!w.ok) return w;
      return { ok: true, deleted: d.deleted, rows };
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return r.value;
  }

  function resetStep(cursor, nowMs) {
    const t =store.transaction("killboard.kills.reset", (db) => {
      const w = repo.writeCursor(db, SOURCE, { ...cursor, state: CURSOR_STATE_RESETTING }, nowMs);
      if (!w.ok) return w;
      const d = repo.wipeKillsStep(db, rowsCap - 2);
      if (!d.ok || !d.done) return d;
      const c = repo.deleteCursor(db, SOURCE);
      return c.ok ? d : c;
    });
    if (!t.ok) return fail(t.reason, t.error ? messageOf(t.error) : undefined);
    if (!t.value.ok) return fail(t.value.reason, t.value.detail);
    if (cursor.state !== CURSOR_STATE_RESETTING) {
      log(`killboard: reset of the kill source started at the cursor ${cursor.keyInt} (killboard.resetKills): `
        + "kb_kills, kb_kill_chars, kb_char_totals and the cursor 'kills' go, then a read from killID 1");
    }
    bump("resetRows", "killboard.killsResetRows", t.value.deleted);
    if (t.value.deleted > 0) safe(() => deps.onWrite(), null);
    lastPending = null;
    status.pendingStopAgeMs = null;
    status.lastError = null;
    if (!t.value.done) {
      status.kills = CURSOR_STATE_RESETTING;
      status.lastDeferred = CURSOR_STATE_RESETTING;
      return done(CURSOR_STATE_RESETTING);
    }
    bump("resets", "killboard.killsReset");
    status.kills = "OK";
    status.cursor = 0;
    status.rows = 0;
    status.lastDeferred = "RESET";
    log("killboard: reset of the kill source done - the next pass reads from killID 1 (set killboard.resetKills "
      + "back to false)");
    return done("RESET");
  }

  function runPass(nowMs) {
    if (P.killmailsEnabled !== true) {
      status.kills = "DISABLED";
      return done("DISABLED");
    }
    if (!isRunning()) return done("NOT_RUNNING");
    if (inPass) return done("BUSY");
    if (!admitted()) {
      bump("deferredGovernor", "killboard.killsDeferredGovernor");
      status.lastDeferred = "GOVERNOR";
      return done("GOVERNOR");
    }
    const seam = safe(() => deps.killboardSeams(), null);
    if (!seam || seam.ok !== true) {
      status.kills = "SEAM_UNAVAILABLE";
      status.lastDeferred = "SEAM_UNAVAILABLE";
      return done("SEAM_UNAVAILABLE");
    }
    inPass = true;
    const startedAt = clock.now();
    try {
      return pass(nowMs);
    } catch (err) {
      return fail("PASS_FAILED", messageOf(err));
    } finally {
      inPass = false;
      status.passes += 1;
      status.lastPassAt = nowMs;
      status.lastPassMs = Math.max(0, clock.now() - startedAt);
      gauge("killboard.killPassMs", status.lastPassMs);
    }
  }

  function pass(nowMs) {
    const cr = store.transaction("killboard.kills.cursor", (db) => repo.readCursor(db, SOURCE));
    if (!cr.ok) return fail(cr.reason);
    if (!cr.value.ok) return fail(cr.value.reason);
    const cursor = cr.value.cursor || { atMs: 0, keyText: "", keyInt: 0, rows: 0, state: "RUNNING" };
    status.cursor = cursor.keyInt;
    status.rows = cursor.rows;
    if (cursor.state === CURSOR_STATE_RESETTING
      || (cursor.state === CURSOR_STATE_REWOUND && P.resetKills === true)) {
      return resetStep(cursor, nowMs);
    }
    if (cursor.state === CURSOR_STATE_REWOUND) {
      status.kills = CURSOR_STATE_REWOUND;
      status.lastDeferred = CURSOR_STATE_REWOUND;
      return done(CURSOR_STATE_REWOUND);
    }
    if (lastPending !== null && lastPending.cursor === cursor.keyInt
      && nowMs - lastPending.at < P.passMs * PENDING_BACKOFF_PASSES) {
      bump("pendingBackoff", "killboard.killPendingBackoff");
      status.lastDeferred = "PENDING_BACKOFF";
      return done("PENDING_BACKOFF");
    }
    status.kills = "OK";
    const kind = cursor.keyText === "R" || cursor.keyText === "H" ? cursor.keyText : "";
    const read = safe(() => deps.readVendorKillsAfter({ afterKillId: cursor.keyInt, limit: P.maxKillsPerPass,
      holeLookahead: P.killHoleLookahead, minAgeMs: P.killMinAgeMs, nowMs, maxAttackers: P.maxAttackersStored,
      cursorKind: kind, pendingMaxAgeMs: P.pendingMaxAgeMs }), null);
    if (!read || read.ok !== true) {
      return fail(read ? String(read.reason) : "VENDOR_READ_FAILED", read && read.detail ? read.detail : undefined);
    }
    bump("examined", "killboard.killsExamined", read.examined);
    if (read.stop === "REWOUND") {
      const t = store.transaction("killboard.kills.rewound", (db) => repo.writeCursor(db, SOURCE,
        { ...cursor, state: CURSOR_STATE_REWOUND }, nowMs));
      if (!t.ok) return fail(t.reason);
      if (!t.value.ok) return fail(t.value.reason, t.value.detail);
      bump("vendorRewound", "killboard.vendorRewound");
      status.kills = CURSOR_STATE_REWOUND;
      status.lastStop = "REWOUND";
      log(`killboard: vendor killmails rewound under the kill cursor ${cursor.keyInt} - kill passes stopped `
        + "(set killboard.resetKills=true: one reset of kb_kills, kb_kill_chars, kb_char_totals and the cursor, then "
        + "a read from killID 1; or reset the world)");
      return done(CURSOR_STATE_REWOUND, { stop: "REWOUND" });
    }
    const opts = { nowMs, killBackfillMs: P.killBackfillMs, includeNpcVictims: P.includeNpcVictims === true,
      isLneNpcCorporation: (id) => safe(() => deps.isLneNpcCorporation(id) === true, false) };
    const items = read.kills.map((fact) => {
      const c = classifyKill(fact, opts);
      if (c.decision !== "ACCEPT") return { fact, decision: c.decision, plan: null };
      const plan = planKill(fact, { cls: c.cls, maxAttackers: P.maxAttackersStored });
      return plan.ok ? { fact, decision: "ACCEPT", plan } : { fact, decision: "INVALID", plan: null };
    });
    const plans = items.filter((i) => i.plan !== null).map((i) => i.plan);
    let resolved = { names: [], prices: [], deferred: 0 };
    if (plans.length > 0) {
      const nr = store.transaction("killboard.kills.names", (db) => unknownOf(db, plans));
      if (!nr.ok) return fail(nr.reason);
      if (!nr.value.ok) return fail(nr.value.reason, nr.value.detail);
      resolved = resolve(nr.value.unknown);
    }
    const s = { cursor, read, items, resolved, factIds: new Set(read.kills.map((f) => f.killId)) };
    const wr = store.transaction("killboard.kills.write", (db) => write(db, s, nowMs));
    if (!wr.ok) return fail(wr.reason, wr.error ? messageOf(wr.error) : undefined);
    const w = wr.value;
    if (!w.ok) return fail(w.reason, w.detail);
    if (w.local.ingested > 0 || w.inserted > 0) safe(() => deps.onWrite(), null);
    bump("ingested", "killboard.killsIngested", w.local.ingested);
    status.counters.known += w.local.known;
    bump("skippedNpc", "killboard.killsSkippedNpc", w.local.skippedNpc);
    bump("skippedLneNpc", "killboard.killsSkippedLneNpc", w.local.skippedLneNpc);
    bump("skippedOld", "killboard.killsSkippedOld", w.local.skippedOld);
    bump("invalid", "killboard.killsInvalid", w.local.invalid);
    bump("oversize", "killboard.killsOversize", w.local.oversize);
    bump("holes", "killboard.killHoles", read.holes);
    bump("bad", "killboard.killsBad", read.bad);
    const stale = Number.isSafeInteger(read.stalePending) ? read.stalePending : 0;
    if (stale > 0) {
      bump("skippedStalePending", "killboard.killsSkippedStalePending", stale);
      log(`killboard: ${stale} vendor pending killmail(s) older than killboard.pendingMaxAgeMs=${P.pendingMaxAgeMs} `
        + `skipped (cursor ${w.key})`);
    }
    status.pendingStopAgeMs = read.stop === "PENDING" && w.deferred === null && Number.isSafeInteger(read.pendingAgeMs)
      ? read.pendingAgeMs : null;
    bump("namesResolved", "killboard.namesResolved", w.inserted);
    bump("namesDeferred", "killboard.namesDeferred", resolved.deferred);
    if (w.deferred === "ROWS") bump("deferredRows", "killboard.killsDeferredRows");
    else if (w.deferred === "TIME") bump("deferredTime", "killboard.killsDeferredTime");
    status.cursor = w.key;
    status.rows = w.rows;
    status.lastDeferred = w.deferred;
    status.lastStop = read.stop;
    status.lastError = null;
    if (w.deferred === null && read.stop === "PENDING") {
      bump("pendingStops", "killboard.killsPendingStops");
      lastPending = { cursor: w.key, at: nowMs };
    } else {
      lastPending = null;
    }
    if (w.rows > P.maxKillRows) {
      const p = prune(nowMs);
      if (!p.ok) return fail(p.reason, p.detail);
      if (p.deleted > 0) {
        bump("pruned", "killboard.killsPruned", p.deleted);
        status.rows = p.rows;
        safe(() => deps.onWrite(), null);
      }
    }
    return { ok: true, ingested: w.local.ingested, deferred: w.deferred, stop: read.stop };
  }

  function getStatus() {
    return Object.freeze({ kills: status.kills, passes: status.passes, lastPassAt: status.lastPassAt,
      lastPassMs: status.lastPassMs, cursor: status.cursor, rows: status.rows, lastStop: status.lastStop,
      lastError: status.lastError, lastDeferred: status.lastDeferred, pendingStopAgeMs: status.pendingStopAgeMs,
      counters: Object.freeze({ ...status.counters }) });
  }

  return Object.freeze({ runPass, getStatus });
}

module.exports = { createKillProjector };
