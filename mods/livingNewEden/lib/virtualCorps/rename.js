"use strict";

const { createRepository } = require("./identityRepository");
const { IDENTITY_KINDS, IDENTITY_STATES, atOfClock } = require("./schema");
const { chooseCharacterName } = require("./nameChoice");
const { pickGender } = require("./characterRecord");
const { createPoller } = require("../presence/poller");

const SUFFIX_RE = / [0-9]+$/;
const RENAME_STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", DONE: "done", STOPPED: "stopped" });
const GENDER_OF_CODE = Object.freeze({ 0: "Female", 1: "Male" });

const hasSuffix = (name) => typeof name === "string" && SUFFIX_RE.test(name);

function planRenameBatch(characters, rowsByKey, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 0;
  const list = Array.isArray(characters) ? characters : [];
  const rows = rowsByKey instanceof Map ? rowsByKey : new Map();
  const byId = new Map();
  for (const c of list) {
    const id = c ? Number(c.characterId) : NaN;
    if (Number.isSafeInteger(id) && id > 0 && typeof c.lneIdentityKey === "string" && typeof c.name === "string") {
      byId.set(id, c);
    }
  }
  const renameAll = [];
  let unmatched = 0;
  for (const id of [...byId.keys()].sort((a, b) => a - b)) {
    const c = byId.get(id);
    if (!hasSuffix(c.name)) continue;
    const row = rows.get(c.lneIdentityKey);
    if (!row) {
      unmatched += 1;
      continue;
    }
    renameAll.push({ characterId: id, identityKey: c.lneIdentityKey, row });
  }
  const syncAll = [];
  for (const key of [...rows.keys()].sort()) {
    const row = rows.get(key);
    const c = row && row.evejs_id ? byId.get(Number(row.evejs_id)) : undefined;
    if (!c || hasSuffix(c.name) || !hasSuffix(row.name) || row.name === c.name) continue;
    syncAll.push({ identityKey: key, row, name: c.name });
  }
  const rename = renameAll.slice(0, cap);
  const sync = syncAll.slice(0, cap);
  return { rename, sync, left: renameAll.length - rename.length + syncAll.length - sync.length, unmatched };
}

function genderOf(record, characterId) {
  const g = record ? record.gender : undefined;
  if (g === "Male" || g === "Female") return g;
  if (GENDER_OF_CODE[g] !== undefined) return GENDER_OF_CODE[g];
  return pickGender(characterId);
}

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (err) {
    return fallback(err);
  }
};

function createRenamePass(deps) {
  const d = deps || {};
  const S = d.settings || {};
  const repoOf = typeof d.repoOf === "function" ? d.repoOf : createRepository;
  const nowMs = typeof d.nowMs === "function" ? d.nowMs : () => (d.clock ? d.clock.now() : 0);
  const tel = d.telemetry || null;
  const log = (line) => { if (d.logger && typeof d.logger.log === "function") d.logger.log(line); };
  let state = RENAME_STATE.IDLE;
  let poller = null;
  const skipChars = new Set();
  const skipKeys = new Set();
  const totals = { passes: 0, renamed: 0, synced: 0, failed: 0, left: null, unmatched: 0, lastReason: null };

  const metric = (kind, name, value) => {
    if (!tel || typeof tel[kind] !== "function") return;
    safe(() => (kind === "observe" ? tel.observe(name, value, d.clock ? d.clock.now() : 0) : tel[kind](name, value)),
      () => null);
  };

  function readRows() {
    const tx = d.store.transaction("virtualCorps.renameRead", (db) => {
      const repo = repoOf(db);
      const out = [];
      for (const st of Object.values(IDENTITY_STATES)) {
        for (const row of repo.listByState(st)) if (row && row.kind === IDENTITY_KINDS.CHARACTER) out.push(row);
      }
      return out;
    });
    if (!tx || tx.ok !== true) return { ok: false, reason: (tx && tx.reason) || "TX_FAILED" };
    const map = new Map();
    for (const row of tx.value) if (!skipKeys.has(row.identity_key)) map.set(row.identity_key, row);
    return { ok: true, rows: map };
  }

  function writeNames(txName, items, at) {
    if (items.length === 0) return { ok: true, written: 0, failed: 0, lost: [] };
    const tx = d.store.transaction(txName, (db) => {
      const repo = repoOf(db);
      let written = 0;
      const lost = [];
      for (const it of items) {
        const res = repo.update(it.identityKey, it.row.version, { evejsId: it.row.evejs_id ?? null,
          state: it.row.state, name: it.name, ticker: it.row.ticker ?? null, at });
        if (res && res.ok === true) written += 1;
        else lost.push(it.identityKey);
      }
      return { written, lost };
    });
    if (!tx || tx.ok !== true) {
      return { ok: false, reason: (tx && tx.reason) || "TX_FAILED", written: 0, failed: items.length, lost: [] };
    }
    return { ok: true, written: tx.value.written, failed: tx.value.lost.length, lost: tx.value.lost };
  }

  function runOnce() {
    const started = nowMs();
    totals.passes += 1;
    const scan = safe(() => d.adapter.scanVirtualCharacters(), (err) => ({ ok: false,
      reason: `SCAN_THREW: ${String((err && err.message) || err).slice(0, 120)}` }));
    if (!scan || scan.ok !== true) {
      totals.lastReason = (scan && scan.reason) || "SCAN_FAILED";
      return { ok: false, reason: totals.lastReason };
    }
    const read = readRows();
    if (!read.ok) {
      totals.lastReason = read.reason;
      return { ok: false, reason: read.reason };
    }
    const chars = scan.characters.filter((c) => c && !skipChars.has(Number(c.characterId)));
    const plan = planRenameBatch(chars, read.rows, S.batchPerPass);
    const at = atOfClock(d.clock);
    let failed = 0;

    const synced = writeNames("virtualCorps.renameSync", plan.sync, at);
    if (!synced.ok) totals.lastReason = synced.reason;
    failed += synced.failed;
    for (const key of synced.lost) skipKeys.add(key);

    const done = [];
    for (const r of plan.rename) {
      const peek = safe(() => d.adapter.peekCharacterRecord(r.characterId), () => null);
      const record = peek && peek.ok === true ? peek.record : null;
      const raceId = r.row.race_id || (record && record.raceID) || 1;
      const pick = chooseCharacterName({ adapter: d.adapter, worldSeed: d.worldSeed,
        settings: { maxAttempts: S.maxAttempts } },
      { identityKey: r.identityKey, characterId: r.characterId, ownerKind: r.row.owner_kind,
        ownerId: r.row.owner_id, raceId, gender: genderOf(record, r.characterId) }, { reuse: false });
      if (!pick.ok) {
        failed += 1;
        skipChars.add(r.characterId);
        totals.lastReason = pick.reason;
        continue;
      }
      const res = safe(() => d.adapter.renameVirtualCharacter(r.characterId, pick.name, r.identityKey),
        (err) => ({ ok: false, reason: "VENDOR_FAILED", detail: String((err && err.message) || err).slice(0, 120) }));
      if (!res || res.ok !== true) {
        failed += 1;
        skipChars.add(r.characterId);
        totals.lastReason = (res && res.reason) || "VENDOR_FAILED";
        continue;
      }
      done.push({ identityKey: r.identityKey, row: r.row, name: pick.name });
    }

    const written = writeNames("virtualCorps.rename", done, at);
    if (!written.ok) totals.lastReason = written.reason;
    failed += written.failed;
    if (done.length > 0) {
      const fl = safe(() => d.adapter.virtualIdentityFlush(["characters"]), (err) => ({ ok: false,
        reason: String((err && err.message) || err).slice(0, 120) }));
      if (!fl || fl.ok !== true) {
        totals.lastReason = `FLUSH: ${(fl && fl.reason) || "FAILED"}`;
        failed += 1;
      }
    }
    const rowsChanged = synced.written + written.written;
    if (rowsChanged > 0 && typeof d.onRowsChanged === "function") safe(() => d.onRowsChanged(), () => null);

    totals.renamed += done.length;
    totals.synced += synced.written;
    totals.failed += failed;
    totals.left = plan.left;
    totals.unmatched = plan.unmatched;
    if (done.length > 0) metric("count", "names.renamed", done.length);
    if (failed > 0) metric("count", "names.renameFailed", failed);
    metric("gauge", "names.renameLeft", plan.left);
    metric("observe", "names.renamePassMs", Math.max(0, nowMs() - started));
    const more = plan.left > 0 || done.length > 0 || synced.written > 0;
    return { ok: true, renamed: done.length, synced: synced.written, failed, left: plan.left, more };
  }

  function runPass() {
    if (state !== RENAME_STATE.RUNNING) return;
    const res = safe(() => runOnce(), (err) => ({ ok: false,
      reason: `PASS_THREW: ${String((err && err.message) || err).slice(0, 120)}` }));
    if (res.ok && res.more) return;
    if (!res.ok) {
      log(`virtualCorps: rename of the suffixed characters stopped - ${res.reason}`);
      state = RENAME_STATE.STOPPED;
    } else {
      log(`virtualCorps: rename of the suffixed characters done renamed=${totals.renamed} synced=${totals.synced} `
        + `failed=${totals.failed} unmatched=${totals.unmatched}`);
      state = RENAME_STATE.DONE;
    }
    if (poller) poller.stop();
  }

  function start() {
    if (S.enabled !== true) return { ok: false, reason: "DISABLED" };
    if (state !== RENAME_STATE.IDLE) return { ok: false, reason: "ALREADY_STARTED" };
    if (!d.adapter || !d.store || typeof d.store.transaction !== "function" || !d.clock
      || !Number.isInteger(S.passMs) || S.passMs <= 0) {
      return { ok: false, reason: "INVALID_DEPS" };
    }
    state = RENAME_STATE.RUNNING;
    poller = createPoller({ runPass, intervalMs: S.passMs, now: nowMs, setTimer: d.setTimer,
      onError: (err) => log(`virtualCorps: rename pass failed - ${String((err && err.message) || err)}`) });
    poller.start();
    return { ok: true };
  }

  function stop() {
    if (poller) poller.stop();
    if (state === RENAME_STATE.RUNNING || state === RENAME_STATE.IDLE) state = RENAME_STATE.STOPPED;
  }

  function getStatus() {
    return { state, passes: totals.passes, renamed: totals.renamed, synced: totals.synced, failed: totals.failed,
      left: totals.left, unmatched: totals.unmatched, lastReason: totals.lastReason };
  }

  return Object.freeze({ start, stop, getStatus, runPass, runOnce });
}

module.exports = { planRenameBatch, createRenamePass, RENAME_STATE, SUFFIX_RE };
