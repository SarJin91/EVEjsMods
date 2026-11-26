"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isInside } = require("../util/paths");

const FILE_VERSION = 1;
const SUB_DIR = "runtime";
const FILE_NAME = "boots.json";
const TMP_SUFFIX = ".tmp";
const BAD_SUFFIX = ".bad-";
const SETTING_KEYS = Object.freeze(["maxUncleanBoots", "windowMs", "maxEntries"]);

function isBoot(b) {
  return b !== null && typeof b === "object" && Number.isFinite(b.atMs)
    && (b.cleanStopAtMs === null || Number.isFinite(b.cleanStopAtMs));
}

function asBootsFile(value) {
  if (value === null || typeof value !== "object" || value.v !== FILE_VERSION || !Array.isArray(value.boots)) return null;
  if (!value.boots.every(isBoot)) return null;
  return value;
}

function copyBoots(file) {
  return file && Array.isArray(file.boots)
    ? file.boots.map((b) => ({ atMs: b.atMs, cleanStopAtMs: b.cleanStopAtMs === null ? null : b.cleanStopAtMs }))
    : [];
}

function fileOf(boots, latched) {
  return latched ? { v: FILE_VERSION, latched: true, boots } : { v: FILE_VERSION, boots };
}

function recordBoot(file, nowMs, p) {
  const boots = copyBoots(file);
  const newest = boots.length > 0 ? boots[boots.length - 1] : null;
  const previousUnclean = newest === null ? null : newest.cleanStopAtMs === null;
  let streak = 0;
  for (let i = boots.length - 1; i >= 0; i -= 1) {
    const b = boots[i];
    if (b.cleanStopAtMs !== null || b.atMs < nowMs - p.windowMs) break;
    streak += 1;
  }
  if (file && file.latched === true) {
    return { file: fileOf(boots, true), tripped: true, previousUnclean, streak, latched: true };
  }
  const tripped = streak >= p.maxUncleanBoots - 1;
  boots.push({ atMs: nowMs, cleanStopAtMs: null });
  while (boots.length > p.maxEntries) boots.shift();
  return { file: fileOf(boots, tripped), tripped, previousUnclean, streak, latched: tripped };
}

function recordCleanStop(file, nowMs) {
  if (!file || file.latched === true || !Array.isArray(file.boots) || file.boots.length === 0) return file;
  const boots = copyBoots(file);
  boots[boots.length - 1].cleanStopAtMs = nowMs;
  return fileOf(boots, false);
}

function codeOf(err) {
  const code = err && err.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "ERROR";
}

function createRestartGuard(deps) {
  const d = deps || {};
  const settings = d.settings || {};
  const fsApi = d.fsApi || fs;
  const wallNow = typeof d.wallNow === "function" ? d.wallNow : () => Date.now();
  let status = { state: "idle", tripped: false, previousUnclean: null, streak: 0 };
  let current = null;
  let filePath = null;

  function refuse(reason, detail) {
    status = { state: reason === "disabled_by_config" ? "disabled" : "unavailable", reason, tripped: false,
      previousUnclean: null, streak: 0, ...(detail ? { detail } : {}) };
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  }

  function write(file) {
    const tmp = `${filePath}${TMP_SUFFIX}`;
    fsApi.writeFileSync(tmp, `${JSON.stringify(file)}\n`);
    fsApi.renameSync(tmp, filePath);
  }

  function read(nowMs) {
    let text;
    try {
      text = fsApi.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return { file: null, bad: false };
      throw err;
    }
    let parsed = null;
    try {
      parsed = asBootsFile(JSON.parse(String(text)));
    } catch (_err) {
      parsed = null;
    }
    if (parsed) return { file: parsed, bad: false };
    fsApi.renameSync(filePath, `${filePath}${BAD_SUFFIX}${nowMs}`);
    return { file: null, bad: true };
  }

  function onBoot() {
    try {
      if (settings.enabled !== true) return refuse("disabled_by_config");
      if (typeof d.dir !== "string" || d.dir === "" || !path.isAbsolute(d.dir)) {
        return refuse("GUARD_IO_FAILED", "no dataDir");
      }
      const dir = path.join(d.dir, SUB_DIR);
      if (typeof d.modDir === "string" && d.modDir !== "" && isInside(d.modDir, dir)) {
        return refuse("GUARD_DIR_IN_MOD_DIR");
      }
      for (const key of SETTING_KEYS) {
        if (!Number.isFinite(settings[key])) return refuse("GUARD_IO_FAILED", `restartGuard.${key}`);
      }
      filePath = path.join(dir, FILE_NAME);
      const nowMs = wallNow();
      fsApi.mkdirSync(dir, { recursive: true });
      const got = read(nowMs);
      const r = recordBoot(got.file, nowMs, settings);
      if (!(got.file && got.file.latched === true)) write(r.file);
      current = r.file;
      status = { state: r.tripped ? "tripped" : "ok", tripped: r.tripped, previousUnclean: r.previousUnclean,
        streak: r.streak, badFile: got.bad, file: filePath };
      return { ok: true, tripped: r.tripped, previousUnclean: r.previousUnclean, streak: r.streak, file: filePath };
    } catch (err) {
      current = null;
      return refuse("GUARD_IO_FAILED", codeOf(err));
    }
  }

  function onCleanStop() {
    try {
      if (current === null || current.latched === true || status.state !== "ok") return { ok: false, reason: "no_boot" };
      const next = recordCleanStop(current, wallNow());
      write(next);
      current = next;
      status = { ...status, cleanStop: true };
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: "GUARD_IO_FAILED", detail: codeOf(err) };
    }
  }

  return Object.freeze({
    onBoot,
    onCleanStop,
    getStatus: () => ({ ...status }),
  });
}

module.exports = { FILE_NAME, SUB_DIR, recordBoot, recordCleanStop, createRestartGuard };
