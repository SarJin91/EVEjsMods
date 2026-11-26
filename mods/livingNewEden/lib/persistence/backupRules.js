"use strict";

const BACKUP_RE = /^world-(\d{8})-(\d{6})Z\.sqlite$/;
const BACKUP_TMP_RE = /^world-(\d{8})-(\d{6})Z\.sqlite\.tmp$/;
const TOOL_COPY_RE = /^(.+)\.(pre-compact|pre-reset)-(\d{8})-(\d{6})Z$/;
const BACKUP_PREFIX = "world-";
const BACKUP_SUFFIX = "Z.sqlite";
const TMP_SUFFIX = ".tmp";
const COUNT_NAMES = Object.freeze(["ok", "failed", "deferred", "aborted", "noSpace"]);

const MS_PER_DAY = 86400000;
const BYTES_PER_MB = 1048576;
const HEADER_BYTES = 100;
const SQLITE_MAGIC = "SQLite format 3\u0000";
const PAGE_SIZE_OFFSET = 16;
const CHANGE_COUNTER_OFFSET = 24;
const PAGE_COUNT_OFFSET = 28;
const VALID_FOR_OFFSET = 92;
const PAGE_SIZE_MIN = 512;
const PAGE_SIZE_MAX = 65536;
const PAGE_SIZE_MAX_MARKER = 1;

function pad(n, width) {
  return String(n).padStart(width, "0");
}

function stampToMs(day, time) {
  const y = Number(day.slice(0, 4));
  const mo = Number(day.slice(4, 6));
  const d = Number(day.slice(6, 8));
  const h = Number(time.slice(0, 2));
  const mi = Number(time.slice(2, 4));
  const s = Number(time.slice(4, 6));
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d
    || back.getUTCHours() !== h || back.getUTCMinutes() !== mi || back.getUTCSeconds() !== s) return null;
  return ms;
}

function formatBackupName(wallMs) {
  const t = new Date(wallMs);
  return `${BACKUP_PREFIX}${pad(t.getUTCFullYear(), 4)}${pad(t.getUTCMonth() + 1, 2)}${pad(t.getUTCDate(), 2)}-`
    + `${pad(t.getUTCHours(), 2)}${pad(t.getUTCMinutes(), 2)}${pad(t.getUTCSeconds(), 2)}${BACKUP_SUFFIX}`;
}

function parseBackupName(name) {
  const m = typeof name === "string" ? BACKUP_RE.exec(name) : null;
  if (!m) return { ok: false };
  const atMs = stampToMs(m[1], m[2]);
  return atMs === null ? { ok: false } : { ok: true, atMs };
}

function isBackupTmpName(name) {
  return typeof name === "string" && BACKUP_TMP_RE.test(name);
}

function parseToolCopyName(name, dbFile) {
  const m = typeof name === "string" ? TOOL_COPY_RE.exec(name) : null;
  if (!m || m[1] !== dbFile) return { ok: false };
  const atMs = stampToMs(m[3], m[4]);
  return atMs === null ? { ok: false } : { ok: true, kind: m[2], atMs };
}

function byNewest(a, b) {
  if (a.atMs !== b.atMs) return b.atMs - a.atMs;
  return a.name < b.name ? 1 : a.name > b.name ? -1 : 0;
}

function bytesOf(entry) {
  const n = Number(entry && entry.bytes);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function planRotation(entries, p) {
  const list = Array.isArray(entries) ? entries : [];
  const backups = [];
  const toolCopies = [];
  const liveNames = typeof p.dbFile === "string" && p.dbFile !== ""
    ? new Set([p.dbFile, `${p.dbFile}-wal`, `${p.dbFile}-shm`]) : new Set();
  const protect = new Set(Array.isArray(p.protect) ? p.protect : []);
  for (const e of list) {
    if (!e || typeof e.name !== "string") continue;
    if (liveNames.has(e.name)) continue;
    if (e.where !== "db") {
      const b = parseBackupName(e.name);
      if (b.ok) {
        backups.push({ name: e.name, atMs: b.atMs, bytes: bytesOf(e) });
        continue;
      }
    }
    if (e.where !== "backups") {
      const t = parseToolCopyName(e.name, p.dbFile);
      if (t.ok) toolCopies.push({ name: e.name, kind: t.kind, atMs: t.atMs, bytes: bytesOf(e) });
    }
  }
  backups.sort(byNewest);
  toolCopies.sort(byNewest);
  const keep = Number.isInteger(p.keep) && p.keep >= 1 ? p.keep : null;
  let deleteBackups = [];
  if (keep !== null) {
    const protectedCount = backups.filter((b) => protect.has(b.name)).length;
    deleteBackups = backups.filter((b) => !protect.has(b.name)).slice(Math.max(0, keep - protectedCount))
      .map((b) => b.name);
  }
  const deleteToolCopies = [];
  const days = p.pruneToolCopiesDays;
  if (Number.isFinite(days) && days > 0 && Number.isFinite(p.nowMs)) {
    const limitMs = days * MS_PER_DAY;
    const seenKind = new Set();
    for (const c of toolCopies) {
      if (!seenKind.has(c.kind)) {
        seenKind.add(c.kind);
        continue;
      }
      if (p.nowMs - c.atMs > limitMs) deleteToolCopies.push(c.name);
    }
  }
  return { backups, deleteBackups, toolCopies, deleteToolCopies,
    newestAtMs: backups.length > 0 ? backups[0].atMs : null };
}

function decideBackup(s, p) {
  if (s.inFlight) return { run: false, reason: "IN_FLIGHT", nextInMs: p.intervalMs };
  const startAt = s.startedAtMs + p.startDelayMs;
  if (s.nowMs < startAt) return { run: false, reason: "START_DELAY", nextInMs: startAt - s.nowMs };
  for (const atMs of [s.newestAtMs, s.lastOkAtMs]) {
    if (typeof atMs === "number" && atMs <= s.nowMs && s.nowMs - atMs < p.intervalMs) {
      return { run: false, reason: "NOT_DUE", nextInMs: atMs + p.intervalMs - s.nowMs };
    }
  }
  if (s.lastFailAtMs !== null && s.nowMs < s.lastFailAtMs + p.retryMs) {
    return { run: false, reason: "RETRY_WAIT", nextInMs: s.lastFailAtMs + p.retryMs - s.nowMs };
  }
  if (s.governor && s.governor.admitted !== true) return { run: false, reason: "GOVERNOR", nextInMs: p.retryMs };
  return { run: true };
}

function checkHeader(head, fileBytes, totalPages) {
  if (!Buffer.isBuffer(head) || head.length < HEADER_BYTES) return { ok: false, reason: "BAD_MAGIC" };
  if (head.toString("latin1", 0, SQLITE_MAGIC.length) !== SQLITE_MAGIC) return { ok: false, reason: "BAD_MAGIC" };
  const raw = head.readUInt16BE(PAGE_SIZE_OFFSET);
  const pageSize = raw === PAGE_SIZE_MAX_MARKER ? PAGE_SIZE_MAX : raw;
  if (pageSize < PAGE_SIZE_MIN || pageSize > PAGE_SIZE_MAX || (pageSize & (pageSize - 1)) !== 0) {
    return { ok: false, reason: "BAD_PAGE_SIZE" };
  }
  if (head.readUInt32BE(CHANGE_COUNTER_OFFSET) !== head.readUInt32BE(VALID_FOR_OFFSET)) {
    return { ok: false, reason: "STALE_COUNT" };
  }
  const pageCount = head.readUInt32BE(PAGE_COUNT_OFFSET);
  if (pageSize * pageCount !== fileBytes) return { ok: false, reason: "SIZE_MISMATCH" };
  if (pageCount !== totalPages) return { ok: false, reason: "PAGES_MISMATCH" };
  return { ok: true, pageSize, pageCount };
}

function requiredFreeBytes(dbBytes, walBytes, factor, minFreeMb) {
  return Math.ceil(((Number(dbBytes) || 0) + (Number(walBytes) || 0)) * factor) + minFreeMb * BYTES_PER_MB;
}

module.exports = {
  BACKUP_RE, TOOL_COPY_RE, TMP_SUFFIX, COUNT_NAMES, HEADER_BYTES,
  formatBackupName, parseBackupName, isBackupTmpName, parseToolCopyName, planRotation, decideBackup, checkHeader,
  requiredFreeBytes,
};
