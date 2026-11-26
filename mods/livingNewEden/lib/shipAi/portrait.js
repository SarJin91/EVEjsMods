"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const S = require("./schema");

const JPEG_MAGIC = Object.freeze([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Object.freeze([0x89, 0x50, 0x4e, 0x47]);
const EXTENSIONS = Object.freeze(["jpg", "png"]);
const MAX_REASON = 60;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const safeReason = (value) => String(value ?? "unknown").replace(/[^\w:.\-]/g, "_").slice(0, MAX_REASON);
const startsWith = (bytes, magic) => bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);

function portraitDirOf(config) {
  const dir = config && typeof config.dataDir === "string" ? config.dataDir : "";
  return dir !== "" ? path.join(dir, S.PORTRAIT_DIR) : null;
}

function resolvePortraitFile(dir, playerId, fsApi = fs) {
  if (typeof dir !== "string" || dir === "" || !isId(playerId)) return { ok: false, reason: "NO_FILE" };
  const names = [...EXTENSIONS.map((e) => [`avatar-${playerId}.${e}`, true]),
    ...EXTENSIONS.map((e) => [`avatar.${e}`, false])];
  for (const [name, perPlayer] of names) {
    const file = path.join(dir, name);
    let st = null;
    try {
      st = fsApi.statSync(file);
    } catch (_err) {
    }
    if (st && st.isFile()) return { ok: true, file, size: Number(st.size), perPlayer };
  }
  return { ok: false, reason: "NO_FILE" };
}

function checkImage(bytes, settings) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) return { ok: false, reason: "BAD_FILE" };
  if (bytes.length > settings.portraitMaxBytes) return { ok: false, reason: "TOO_LARGE" };
  if (startsWith(bytes, JPEG_MAGIC)) return { ok: true, extension: "jpg" };
  if (startsWith(bytes, PNG_MAGIC)) return { ok: true, extension: "png" };
  return { ok: false, reason: "BAD_FILE" };
}

function sha256Of(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

const STATUS_OF = Object.freeze({ BAD_FILE: "bad_file", TOO_LARGE: "too_large" });

function inTx(store, label, fn) {
  const res = store.transaction(label, fn);
  if (!res.ok) return { ok: false, reason: safeReason(res.reason) };
  return res.value && res.value.ok ? res.value : { ok: false, reason: safeReason(res.value && res.value.reason) };
}

function syncPortrait(deps, playerId) {
  const d = deps || {};
  const fail = (reason) => ({ ok: false, status: "failed", reason: safeReason(reason) });
  if (!d.S || d.S.portraitEnabled !== true) return { ok: true, status: "off" };
  if (!isId(playerId) || !d.store || !d.repo || typeof d.storePortrait !== "function" || typeof d.nowMs !== "function") {
    return fail("INVALID_INPUT");
  }
  const fsApi = d.fsApi || fs;
  try {
    const got = inTx(d.store, "shipAi.portrait.read", (db) => d.repo.getByPlayer(db, playerId));
    if (!got.ok) return fail(got.reason);
    if (!got.row) return fail("NO_IDENTITY");
    const found = resolvePortraitFile(d.dir, playerId, fsApi);
    if (!found.ok) return { ok: true, status: "default" };
    if (found.size > d.S.portraitMaxBytes) return { ok: true, status: "too_large" };
    let bytes;
    try {
      bytes = fsApi.readFileSync(found.file);
    } catch (err) {
      return fail(`READ_FAILED:${(err && err.code) || "io"}`);
    }
    const checked = checkImage(bytes, d.S);
    if (!checked.ok) return { ok: true, status: STATUS_OF[checked.reason] };
    const sha = sha256Of(bytes);
    if (got.row.portraitSha === sha) return { ok: true, status: "unchanged" };
    const stored = d.storePortrait(got.row.aiId, bytes, checked.extension);
    if (!stored || !stored.ok) return fail(stored && stored.reason);
    const saved = inTx(d.store, "shipAi.portrait.save", (db) => d.repo.setPortraitSha(db, { playerId, sha,
      nowMs: d.nowMs() }));
    if (!saved.ok) return fail(`SAVE:${saved.reason}`);
    return { ok: true, status: "stored", sizes: stored.sizes };
  } catch (err) {
    return fail((err && (err.code || err.message)) || err);
  }
}

function createPortraitSync(deps) {
  const d = deps || {};
  const defer = typeof d.defer === "function" ? d.defer : (fn) => setImmediate(fn);
  const log = (line) => {
    try {
      if (d.logger && typeof d.logger.log === "function") d.logger.log(line);
    } catch (_err) {
    }
  };
  let state = "running";
  if (!d.S || d.S.portraitEnabled !== true) state = "off";
  else if (!d.dir) state = "no_data_dir";
  else if (typeof d.storePortrait !== "function") state = "unavailable";
  const byStatus = Object.fromEntries(S.PORTRAIT_STATUS.map((n) => [n, 0]));
  let last = state === "running" ? null : "off";
  const queue = new Set();
  let scheduled = false;

  const step = () => {
    scheduled = false;
    if (state !== "running") return;
    const batch = [...queue].slice(0, d.S.portraitBootBatch);
    for (const playerId of batch) {
      queue.delete(playerId);
      const r = syncPortrait(d, playerId);
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      last = r.status;
      if (r.status === "stored") log(`shipAi: portrait stored for an AI (sizes=${r.sizes})`);
      else if (r.status === "failed") log(`shipAi: portrait not stored - ${r.reason}`);
      else if (r.status === "bad_file" || r.status === "too_large") log(`shipAi: portrait file refused - ${r.status}`);
    }
    if (queue.size > 0) schedule();
  };
  const schedule = () => {
    if (scheduled || state !== "running") return;
    scheduled = true;
    defer(() => {
      try {
        step();
      } catch (err) {
        scheduled = false;
        log(`shipAi: portrait pass failed - ${safeReason((err && (err.code || err.message)) || err)}`);
      }
    });
  };

  return Object.freeze({
    syncSoon: (playerId) => {
      if (state !== "running" || !isId(playerId)) return;
      queue.add(playerId);
      schedule();
    },
    bootPass: (playerIds) => {
      if (state !== "running" || !Array.isArray(playerIds)) return;
      for (const id of playerIds) if (isId(id)) queue.add(id);
      schedule();
    },
    getStatus: () => ({ state, last, pending: queue.size, byStatus: { ...byStatus } }),
    stop: () => {
      if (state === "running") state = "stopped";
      queue.clear();
    },
  });
}

module.exports = { portraitDirOf, resolvePortraitFile, checkImage, sha256Of, syncPortrait, createPortraitSync };
