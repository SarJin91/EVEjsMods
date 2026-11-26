"use strict";

const fs = require("node:fs");
const path = require("node:path");

const KIND = Object.freeze({ PRE_COMPACT: "pre-compact", PRE_RESET: "pre-reset", ONLINE: "online" });
const PRUNABLE_KINDS = Object.freeze([KIND.PRE_COMPACT, KIND.PRE_RESET]);
const STAMP = "(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})Z";
const OFFLINE_RE = new RegExp(`^\\.(pre-compact|pre-reset)-${STAMP}$`);
const ONLINE_RE = new RegExp(`^world-${STAMP}\\.sqlite$`);

function stampMsOf(m, from) {
  const [y, mo, d, h, mi, s] = m.slice(from, from + 6).map(Number);
  const ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const t = new Date(ms);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d || t.getUTCHours() !== h
    || t.getUTCMinutes() !== mi || t.getUTCSeconds() !== s) return null;
  return ms;
}

function parseBackupName(name, basename) {
  if (typeof name !== "string" || typeof basename !== "string" || basename === "") return null;
  if (name.startsWith(basename)) {
    const m = OFFLINE_RE.exec(name.slice(basename.length));
    if (m) {
      const stampMs = stampMsOf(m, 2);
      return stampMs === null ? null : { kind: m[1], stampMs };
    }
  }
  const online = ONLINE_RE.exec(name);
  if (online) {
    const stampMs = stampMsOf(online, 1);
    return stampMs === null ? null : { kind: KIND.ONLINE, stampMs };
  }
  return null;
}

function canonicalDir(dir) {
  const resolved = path.resolve(dir);
  try {
    return fs.realpathSync.native(resolved);
  } catch (_err) {
    return resolved;
  }
}

function dirKey(dir) {
  const resolved = path.resolve(dir);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fileIdOf(st) {
  if (!st || st.ino === undefined || st.ino === 0n || st.ino === 0) return null;
  return `${st.dev}:${st.ino}`;
}

function listBackups(dirs, basename) {
  const out = [];
  const seen = new Set();
  const seenFiles = new Set();
  for (const dir of dirs || []) {
    if (typeof dir !== "string" || dir === "") continue;
    const resolved = canonicalDir(dir);
    const key = dirKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    let names;
    try {
      names = fs.readdirSync(resolved);
    } catch (_err) {
      continue;
    }
    for (const name of names) {
      const parsed = parseBackupName(name, basename);
      if (!parsed) continue;
      const file = path.join(resolved, name);
      let st;
      try {
        st = fs.statSync(file, { bigint: true });
      } catch (_err) {
        continue;
      }
      if (!st.isFile()) continue;
      const id = fileIdOf(st);
      if (id !== null) {
        if (seenFiles.has(id)) continue;
        seenFiles.add(id);
      }
      out.push({ file, name, kind: parsed.kind, stampMs: parsed.stampMs, bytes: Number(st.size) });
    }
  }
  return out.sort((a, b) => (b.stampMs - a.stampMs) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

function planPrune(list, keep) {
  const remove = [];
  const kept = [];
  const n = Number.isInteger(keep) && keep >= 0 ? keep : 1;
  for (const kind of PRUNABLE_KINDS) {
    const ofKind = (list || []).filter((e) => e && e.kind === kind)
      .sort((a, b) => (b.stampMs - a.stampMs) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    kept.push(...ofKind.slice(0, n));
    remove.push(...ofKind.slice(n));
  }
  return { remove, keep: kept };
}

function planSpace(s) {
  const live = Math.max(0, Number(s.live) || 0);
  const wal = Math.max(0, Number(s.walBytes) || 0);
  const margin = Number(s.margin) > 0 ? Number(s.margin) : 1;
  const backupPart = Math.ceil(live * margin);
  const dbPart = Math.ceil((2 * live + wal) * margin);
  const freeDb = Math.max(0, Number(s.dbFree) || 0);
  if (s.sameDevice) {
    const needDb = dbPart + backupPart;
    return { ok: needDb <= freeDb, needDb, needBackup: backupPart, freeDb, freeBackup: freeDb };
  }
  const freeBackup = Math.max(0, Number(s.backupFree) || 0);
  return { ok: dbPart <= freeDb && backupPart <= freeBackup, needDb: dbPart, needBackup: backupPart, freeDb,
    freeBackup };
}

module.exports = { KIND, PRUNABLE_KINDS, parseBackupName, canonicalDir, dirKey, listBackups, planPrune, planSpace };
