"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isModuleEnabled, DEFAULT_DB_FILE } = require("../../config");
const { openStore } = require("./store");
const { createJournal } = require("./journal");
const { createCheckpointer } = require("./checkpointer");
const { createWarmup } = require("./warmup");
const { createClock } = require("../util/clock");
const { isInside } = require("../util/paths");
const { performance } = require("node:perf_hooks");

const DB_FILE_NAME = DEFAULT_DB_FILE;
const SHUTDOWN_HOOK_NAME = "livingNewEden";
const OWNER_LOST_REASON = "PERSISTENCE_OWNER_LOST";

const PERSISTENCE_DEPENDENTS = Object.freeze(["world", "fleets", "scheduler", "strategy", "battle", "events",
  "sites", "materialization"]);

function dependentsDisabled(reason) {
  const out = { persistence: String(reason) };
  for (const name of PERSISTENCE_DEPENDENTS) out[name] = "dependency_disabled:persistence";
  return out;
}

function noop() {}

function startPersistence(deps) {
  const logger = (deps && deps.logger) || { log: noop };
  const refuse = (reason, detail) => {
    logger.log(`persistence: disabled - ${reason}${detail ? ` (${detail})` : ""}`);
    return { ok: false, reason, ...(detail ? { detail } : {}), disabledModules: dependentsDisabled(reason) };
  };
  let store = null;
  try {
    const { config, adapter, modDir } = deps;
    const processApi = deps.processApi || process;
    const openStoreFn = typeof deps.openStoreFn === "function" ? deps.openStoreFn : openStore;

    if (!isModuleEnabled(config, "persistence")) return refuse("disabled_by_config");
    if (!adapter || typeof adapter.loadSqliteDriver !== "function") return refuse("adapter_unavailable");
    const disabled = typeof adapter.getDisabledModules === "function" ? adapter.getDisabledModules() : {};
    if (disabled && disabled.persistence) return refuse(`probe_drift:${disabled.persistence}`);

    if (typeof config.dataDir !== "string" || config.dataDir === "") return refuse("DATA_DIR_UNAVAILABLE", "no dataDir");
    const dbFile = config.persistence && typeof config.persistence.dbFile === "string" && config.persistence.dbFile
      ? config.persistence.dbFile : DB_FILE_NAME;
    const filePath = path.join(config.dataDir, dbFile);
    if (typeof modDir === "string" && modDir !== "" && isInside(modDir, filePath)) {
      return refuse("DB_PATH_IN_MOD_DIR", filePath);
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch (err) {
      return refuse("DATA_DIR_UNAVAILABLE", String((err && err.message) || err));
    }

    const driver = adapter.loadSqliteDriver();
    if (!driver || !driver.ok) {
      return refuse("SQLITE_DRIVER_UNAVAILABLE", driver ? driver.detail || driver.reason : "no result");
    }

    const settings = config.persistence;
    const detach = [];
    const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
    const managed = settings.managedCheckpoint === true;
    const opened = openStoreFn({
      filePath,
      openDatabase: (file) => new driver.Database(file),
      openBackupHandle: typeof driver.openBackupHandle === "function" ? driver.openBackupHandle : null,
      migrations: deps.migrations,
      exclusiveLock: settings.exclusiveLock,
      managedCheckpoint: managed,
      walSafetyPages: settings.walSafetyPages,
      checkpointFramesPerRowInitial: settings.checkpointFramesPerRowInitial,
      checkpointFramesEwma: settings.checkpointFramesEwma,
      nowMs,
      busyTimeoutMs: settings.busyTimeoutMs,
      maxRowsPerTransaction: settings.maxRowsPerTransaction,
      maxWriteMsPerPass: settings.maxWriteMsPerPass,
      randomSeed: deps.randomSeed,
      onTiming: deps.onTiming,
      walPerTx: Boolean(settings.walPerTx && settings.walPerTx.enabled === true),
      onClose: () => {
        for (const fn of detach.splice(0)) {
          try {
            fn();
          } catch (_err) {
          }
        }
      },
    });
    if (!opened || !opened.ok) return refuse(opened ? opened.reason : "DB_OPEN_FAILED", opened && opened.detail);
    store = opened.store;
    const openStoreRef = store;
    const journal = createJournal({
      clock: deps.clock || createClock(),
      maxPayloadBytes: settings.journalMaxPayloadBytes,
      maxRows: store.limits.maxRowsPerTransaction,
      onCount: typeof deps.onCount === "function" ? deps.onCount : undefined,
    });

    const hook = adapter.registerShutdownHook(SHUTDOWN_HOOK_NAME, (signal) => {
      openStoreRef.close(`shutdown:${signal}`);
    });
    if (hook && hook.ok) detach.push(hook.unregister);
    else {
      logger.log(`persistence: shutdown hook not registered - ${hook ? hook.reason : "no result"}`
        + `${hook && hook.detail ? ` (${hook.detail})` : ""}; closing on process exit only`);
    }

    const onExit = () => openStoreRef.close("exit");
    processApi.once("exit", onExit);
    detach.push(() => processApi.removeListener("exit", onExit));

    const lost = adapter.onPersistenceOwnerLost(() => {
      openStoreRef.suspend(OWNER_LOST_REASON);
      logger.log(`persistence: suspended - ${OWNER_LOST_REASON}`);
    });
    if (lost && lost.ok) detach.push(lost.unsubscribe);
    else logger.log(`persistence: owner-lost listener not registered - ${lost ? lost.reason : "no result"}`);

    let checkpointer = null;
    if (managed && typeof store.checkpoint === "function" && typeof store.getWalStatus === "function") {
      const telemetry = deps.telemetry || null;
      checkpointer = createCheckpointer({ store, settings, nowMs, logger,
        getGovernor: typeof deps.getGovernor === "function" ? deps.getGovernor : () => null,
        addTickListener: telemetry && typeof telemetry.addTickListener === "function"
          ? (fn) => telemetry.addTickListener(fn) : undefined,
        setTimer: deps.setTimer, setImmediateFn: deps.setImmediateFn,
        metrics: telemetry ? { count: (n, v) => telemetry.count(n, v), gauge: (n, v) => telemetry.gauge(n, v) }
          : null });
      const cpRef = checkpointer;
      detach.push(() => cpRef.stop());
      cpRef.start();
    }

    let warmup = null;
    if (settings.warmupEnabled === true) {
      const telemetry = deps.telemetry || null;
      warmup = createWarmup({ filePath, nowMs, logger,
        settings: { warmupChunkBytes: settings.warmupChunkBytes, warmupPauseMs: settings.warmupPauseMs,
          warmupMaxBytes: settings.warmupMaxBytes },
        fsApi: deps.warmupFs, setTimer: deps.warmupSetTimer,
        onDone: telemetry && typeof telemetry.gauge === "function" ? (r) => {
          telemetry.gauge("persistence.warmupBytes", r.bytes);
          telemetry.gauge("persistence.warmupMs", r.ms);
        } : undefined });
      const wRef = warmup;
      detach.push(() => wRef.stop());
      wRef.start();
    }

    logger.log(`persistence: open ${filePath} schema=${opened.schemaVersion} migrated=${opened.applied} `
      + `lock=${store.lockingMode} checkpoint=${checkpointer
        ? `managed aligned=${checkpointer.getStatus().aligned}` : "sqlite"} warmup=${warmup ? "on" : "off"}`);
    if (store.lockingMode !== "exclusive") {
      logger.log("persistence: warning - locking normal - no protection against a second writer");
    }
    return {
      ok: true,
      store,
      journal,
      worldSeed: opened.worldSeed,
      schemaVersion: opened.schemaVersion,
      applied: opened.applied,
      filePath,
      checkpointer,
      warmup,
      shutdownHook: Boolean(hook && hook.ok),
      ...(hook && hook.ok ? {} : { shutdownHookReason: hook ? hook.reason : "no result" }),
    };
  } catch (err) {
    if (store) store.close("start_failed");
    return refuse("PERSISTENCE_START_FAILED", String((err && err.message) || err));
  }
}

module.exports = { DB_FILE_NAME, SHUTDOWN_HOOK_NAME, PERSISTENCE_DEPENDENTS, dependentsDisabled, startPersistence };
