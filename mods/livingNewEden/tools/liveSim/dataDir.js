"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveDataDir } = require("../../config");
const { ANCHOR_FILE } = require("./clock");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_DATA_DIR = path.resolve(MOD_DIR, "..", "..", "_local", "liveSim");

function refusal(detail) {
  return { ok: false, reason: "DATA_DIR_REFUSED", detail: String(detail) };
}

function normal(p) {
  const r = path.resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}

function isInside(child, parent) {
  const rel = path.relative(normal(parent), normal(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function prepareDataDir(opts, deps = {}) {
  const fsApi = deps.fs || fs;
  const modDir = deps.modDir || MOD_DIR;
  const env = deps.env || {};
  const dir = path.resolve(opts.dataDir || DEFAULT_DATA_DIR);
  for (const server of [resolveDataDir({}, modDir), resolveDataDir(env, modDir)]) {
    if (normal(dir) === normal(server)) return refusal(`${dir} is the data folder of the local server`);
  }
  if (isInside(dir, modDir)) return refusal(`${dir} is inside the mod folder`);
  try {
    const exists = fsApi.existsSync(dir);
    if (exists && !fsApi.statSync(dir).isDirectory()) return refusal(`${dir} is not a folder`);
    const entries = exists ? fsApi.readdirSync(dir) : [];
    const marked = entries.includes(ANCHOR_FILE);
    if (entries.length > 0 && !marked) return refusal(`${dir} is not empty and has no ${ANCHOR_FILE}`);
    let reset = false;
    if (opts.reset === true && exists) {
      fsApi.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      reset = true;
    }
    fsApi.mkdirSync(dir, { recursive: true });
    return { ok: true, dataDir: dir, fresh: reset || !marked, reset };
  } catch (err) {
    return refusal(`${dir}: ${(err && err.message) || err}`);
  }
}

module.exports = { prepareDataDir, DEFAULT_DATA_DIR };
