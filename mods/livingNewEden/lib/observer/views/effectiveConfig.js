"use strict";

const fs = require("node:fs");
const { buildDefaultServiceDefs } = require("../../runtime/services");
const { baseName, describeConfig } = require("../effectiveConfig");

const VIEW_ID = "effective-config";
const TITLE = "Effective config";
const ORDER = 25;
const MAX_DETAIL = 200;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function callStatus(obj) {
  return obj && typeof obj.getStatus === "function" ? obj.getStatus() : null;
}

let defaultServiceNames = null;
function serviceNames() {
  if (!defaultServiceNames) defaultServiceNames = Object.freeze(buildDefaultServiceDefs().map((d) => String(d.name)));
  return defaultServiceNames;
}

function retentionInfo(ctx) {
  const rc = ctx.config && ctx.config.retention;
  const disabledClasses = rc && typeof rc.disabledClasses === "string" ? rc.disabledClasses : "";
  const status = callStatus(ctx.retention);
  if (!status) return { state: "unavailable", reason: "not_started", disabledClasses };
  if (status.state === "unavailable") {
    return { state: status.state, reason: status.reason || null, ...(status.detail ? { detail: status.detail } : {}),
      disabledClasses };
  }
  const classes = status.classes && typeof status.classes === "object"
    ? Object.keys(status.classes).map((id) => {
      const c = status.classes[id] || {};
      return { id, scanned: c.scanned ?? null, deleted: c.deleted ?? null, candidates: c.candidates ?? null,
        sweeps: c.sweeps ?? null, guarded: c.guarded ?? null, lastSweepAt: c.lastSweepAt ?? null };
    })
    : [];
  return {
    state: status.state || null,
    dryRun: Boolean(status.params && status.params.dryRun === true),
    counters: status.counters ? { ...status.counters } : null,
    lastRefusal: status.lastRefusal ?? null,
    disabledClasses,
    classes,
  };
}

function sizeOrNull(fsApi, file) {
  try {
    return fsApi.statSync(file).size;
  } catch (err) {
    if (err && err.code === "ENOENT") return null;
    throw err;
  }
}

function databaseInfo(store, fsApi) {
  if (!store || typeof store.filePath !== "string" || store.filePath === "") {
    return { available: false, reason: "PERSISTENCE_UNAVAILABLE" };
  }
  const file = store.filePath;
  try {
    const dbBytes = fsApi.statSync(file).size;
    const walBytes = sizeOrNull(fsApi, `${file}-wal`);
    const shmBytes = sizeOrNull(fsApi, `${file}-shm`);
    return { available: true, file: baseName(file), dbBytes, walBytes, shmBytes,
      totalBytes: dbBytes + (walBytes || 0) + (shmBytes || 0) };
  } catch (err) {
    return { available: false, reason: "STAT_FAILED", detail: String((err && err.code) || "ERROR") };
  }
}

function buildEffectiveConfigView(deps) {
  const ctx = deps.ctx || {};
  const schema = deps.schema;
  const fsApi = deps.fsApi || fs;
  const getStore = typeof deps.store === "function" ? deps.store : () => null;
  const { refreshMs, originChars } = deps.settings;
  return {
    title: TITLE,
    order: ORDER,
    cacheKey(req) {
      return Math.floor(req.nowMs / refreshMs);
    },
    getData() {
      try {
        const configResult = (ctx.state && ctx.state.configResult) || {};
        const described = describeConfig({
          schema,
          config: ctx.config || configResult.config || {},
          sources: configResult.sources || {},
          warnings: configResult.warnings,
          errors: configResult.errors,
          services: callStatus(ctx.services),
          serviceNames: serviceNames(),
          originChars,
        });
        return { available: true, ...described, retention: retentionInfo(ctx), database: databaseInfo(getStore(), fsApi) };
      } catch (err) {
        return { available: false, reason: "EFFECTIVE_CONFIG_FAILED", detail: messageOf(err) };
      }
    },
  };
}

module.exports = { VIEW_ID, buildEffectiveConfigView };
