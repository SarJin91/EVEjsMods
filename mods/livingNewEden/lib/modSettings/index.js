"use strict";

const { readOverrideFile, overridePathOf } = require("./overrideFile");
const { describeRows, redactRowMessages } = require("./catalog");
const { PROVIDER_MODS, createProvider } = require("./providers");
const { auditPathOf, createAudit } = require("./audit");
const { createWriter } = require("./writer");
const { startSettingsWeb } = require("./web");
const { APPLY_LIVE, createLiveApplier } = require("./live");

const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function modListOf(csv) {
  return String(csv || "").split(",").map((s) => s.trim()).filter((s) => s !== "");
}

function startModSettings(deps) {
  const config = deps && deps.config;
  const settings = config && config.modSettings;
  if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const adapter = deps.adapter || null;
  const env = deps.env || process.env;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  let state = STATE.STARTING;
  let describes = 0;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`modSettings: ${line}`);
    } catch (_err) {
    }
  }

  const enabledMods = modListOf(settings.mods);
  let loadedDirs = null;
  try {
    const r = adapter && typeof adapter.listLoadedModDirs === "function" ? adapter.listLoadedModDirs() : null;
    if (r && r.ok === true && Array.isArray(r.dirs)) loadedDirs = r.dirs;
    else log(`loaded mods unknown - ${(r && r.reason) || "no_seam"}`);
  } catch (err) {
    log(`loaded mods unknown - ${messageOf(err)}`);
  }

  const applier = createLiveApplier({ liveConfig: deps.liveConfig || null, globalObj: deps.globalObj || globalThis });
  const entries = new Map();
  for (const modId of enabledMods) {
    if (!PROVIDER_MODS.includes(modId)) {
      entries.set(modId, { provider: null, reason: "NO_PROVIDER", running: null });
      continue;
    }
    const made = createProvider(modId, { config, adapter, env, modDir: deps.modDir });
    if (!made || made.ok !== true) {
      entries.set(modId, { provider: null, reason: (made && made.reason) || "PROVIDER_FAILED", running: null });
      log(`${modId}: no provider - ${(made && made.reason) || "PROVIDER_FAILED"}`);
      continue;
    }
    const p = made.provider;
    let running;
    try {
      running = typeof p.flatten === "function" ? p.flatten(config) : p.current();
    } catch (err) {
      entries.set(modId, { provider: null, reason: "SNAPSHOT_FAILED", running: null });
      log(`${modId}: no running snapshot - ${messageOf(err)}`);
      continue;
    }
    const provider = Object.freeze({ ...p, apply: (key) => (applier.applyOf(modId, key, p) === APPLY_LIVE
      ? APPLY_LIVE : p.apply(key)) });
    entries.set(modId, { provider, reason: null, running: Object.freeze(running) });
  }

  function applyLive(req) {
    const r = applier.apply(req);
    if (r.ok === true && req.entry && req.after && req.after.values) {
      const changed = Object.fromEntries(r.applied.map((k) => [k, req.after.values[k]]));
      req.entry.running = Object.freeze({ ...req.entry.running, ...changed });
      log(`${req.modId}: live ${r.applied.join(", ")}`);
    }
    return r;
  }
  state = STATE.RUNNING;

  function listMods() {
    const ids = new Set([...(loadedDirs || []), ...enabledMods]);
    return [...ids].sort().map((modId) => {
      const e = entries.get(modId);
      const loaded = loadedDirs === null ? null : loadedDirs.includes(modId);
      if (!e) return { modId, title: modId, loaded, provider: false, reason: "NOT_ENABLED" };
      return { modId, title: e.provider ? e.provider.title : modId, loaded, provider: e.provider !== null,
        reason: e.reason };
    });
  }

  function describe(modId, query) {
    try {
      if (state !== STATE.RUNNING) return { ok: false, reason: state.toUpperCase() };
      const e = entries.get(String(modId));
      if (!e) return { ok: false, reason: "NOT_ENABLED" };
      if (!e.provider) return { ok: false, reason: e.reason };
      describes += 1;
      const file = readOverrideFile(overridePathOf(e.provider.dataDir), env);
      const next = e.provider.resolve(file.values);
      const underlying = e.provider.resolve(null);
      const page = describeRows(e.provider, { running: e.running, next, underlying, overrides: file.values },
        { ...(query || {}), maxRowsPerPage: settings.maxRowsPerPage });
      const rows = e.provider.rows();
      return { ...page, overrideFile: { present: file.present, ignored: file.ignored, revision: file.revision,
        warnings: file.warnings }, warnings: redactRowMessages(next.warnings, rows),
      errors: redactRowMessages(next.errors, rows) };
    } catch (err) {
      log(`describe ${String(modId).slice(0, MAX_DETAIL)} failed - ${messageOf(err)}`);
      return { ok: false, reason: "DESCRIBE_FAILED", detail: messageOf(err) };
    }
  }

  const audit = typeof config.dataDir === "string" && config.dataDir !== ""
    ? createAudit({ filePath: auditPathOf(config.dataDir), maxBytes: settings.auditMaxBytes })
    : { append: () => ({ ok: false, reason: "AUDIT_FAILED", detail: "no data folder" }) };
  const writer = createWriter({ entryOf: (modId) => entries.get(modId) || null, env, clock: deps.clock || null,
    audit, telemetry: deps.telemetry || null, log, applyLive });

  function write(fn, req) {
    if (state !== STATE.RUNNING) return { ok: false, reason: state.toUpperCase() };
    return fn(req);
  }

  let web = null;

  function stop() {
    state = STATE.STOPPED;
    if (web) web.stop();
  }

  const modSettings = Object.freeze({
    listMods,
    describe,
    set: (req) => write(writer.setSetting, req),
    reset: (req) => write(writer.resetSetting, req),
    getStatus: () => ({ state, mods: enabledMods.length, providers: [...entries.values()].filter((e) => e.provider)
      .length, loadedMods: loadedDirs === null ? null : loadedDirs.length, describes,
    web: web ? web.status() : null }),
    stop,
  });
  try {
    web = startSettingsWeb({ config, getModSettings: () => (state === STATE.RUNNING ? modSettings : null),
      httpRoutes: deps.httpRoutes || null, adapter, clock: deps.clock || { now: () => Date.now() },
      telemetry: deps.telemetry || null, log, isRunning: () => state === STATE.RUNNING,
      randomBytes: deps.randomBytes });
  } catch (err) {
    log(`web panel not started - ${messageOf(err)}`);
  }
  return { ok: true, modSettings };
}

module.exports = { startModSettings };
