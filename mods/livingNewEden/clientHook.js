"use strict";

const Module = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const workerThreads = require("node:worker_threads");

const NO_INSTALL_ENV = "EVEJS_LNE_NO_INSTALL";
const INSTALL_FLAG = "__livingNewEdenBoardHookInstalled";
const DEFAULT_ROOT = path.resolve(__dirname, "..", "..");

function wanted(result) {
  try {
    const c = result && result.config;
    return Boolean(result && result.ok === true && c && c.enabled === true
      && ((c.jobBoard && c.jobBoard.enabled === true)
        || (c.inGameMap && c.inGameMap.enabled === true
          && (c.inGameMap.clientProbeEnabled === true || c.inGameMap.windowEnabled === true))));
  } catch (_err) {
    return false;
  }
}

function install(deps = {}) {
  const env = deps.env || process.env;
  const isMainThread = deps.isMainThread === undefined ? workerThreads.isMainThread : deps.isMainThread;
  const globalObj = deps.globalObj || globalThis;
  if (env[NO_INSTALL_ENV] === "1") return { ok: false, reason: "no_install_env" };
  if (!isMainThread) return { ok: false, reason: "not_main_thread" };
  let configResult = null;
  try {
    configResult = (deps.loadConfig || (() => require("./config").loadConfig({ env })))();
  } catch (_err) {
    configResult = null;
  }
  if (!wanted(configResult)) return { ok: false, reason: "disabled_by_config" };
  if (globalObj[INSTALL_FLAG]) return { ok: false, reason: "already_installed" };
  globalObj[INSTALL_FLAG] = true;
  const { installBoardHandshakeHook, HOOK_STATE_KEY } = require("./lib/adapter/clientHandshakeHook");
  const hook = installBoardHandshakeHook({
    moduleApi: deps.moduleApi || Module,
    globalObj,
    root: deps.root || DEFAULT_ROOT,
    readFile: deps.readFile || ((file) => fs.readFileSync(file, "utf8")),
    hashes: configResult.config.jobBoard.handshakeHashes,
    logger: deps.logger || require("./lib/log"),
  });
  globalObj[HOOK_STATE_KEY] = hook;
  return { ok: hook.ok === true, reason: hook.ok === true ? null : hook.reason, hook };
}

module.exports = { NO_INSTALL_ENV, INSTALL_FLAG, install };

if (process.env[NO_INSTALL_ENV] !== "1") {
  try {
    install();
  } catch (_err) {
  }
}
