"use strict";

const path = require("node:path");

const { SCHEMA } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_SDE_DIR = path.resolve(MOD_DIR, "..", "..", "_local", "sde", "eve-online-static-data-3396210-jsonl");
const OFFLINE_MODES = Object.freeze(["capped", "pause"]);

function schemaRow(key) {
  const row = SCHEMA.find((r) => r.key === key);
  if (!row) throw new Error(`liveSim: SCHEMA row ${key} missing`);
  return row;
}

const SPEED_ROW = schemaRow("testing.timeScale");
const PORT_ROW = schemaRow("observer.port");
const SPEED_MIN = SPEED_ROW.min;
const SPEED_MAX = SPEED_ROW.max;

const DEFAULTS = Object.freeze({
  sde: DEFAULT_SDE_DIR, dataDir: null, reset: false, speed: 10, port: null, envFile: null, settings: null, compose: null,
  set: Object.freeze({}), seed: null, offline: "capped", offlineHours: null, offlineMaxHours: 6, anchorEveryS: 5,
  statusMin: 1, statusFile: null, durationS: null, reportJson: null, checksEveryVirtualH: 24,
  statics: true,
});

const USAGE = "node mods/livingNewEden/tools/liveSim.js [--sde DIR] [--data-dir DIR] [--reset] [--speed 10] "
  + "[--port P] [--env-file FILE] [--settings FILE] [--compose FILE] [--set key=value ...] [--seed N] [--offline capped|pause] "
  + "[--offline-hours H] [--offline-max-hours 6] [--anchor-every-s 5] [--status-min 1] [--status-file FILE] "
  + "[--duration-s S] [--report-json FILE] [--checks-every-virtual-h 24] [--no-statics]";

function refusal(detail) {
  return { ok: false, reason: "ARGS_INVALID", detail: String(detail) };
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, set: {} };
  const list = Array.isArray(argv) ? argv.map(String) : [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const value = () => {
      i += 1;
      if (i >= list.length) throw new Error(`${a} needs a value`);
      return list[i];
    };
    const num = (min, max, { integer = false, minExclusive = false } = {}) => {
      const raw = value();
      const n = Number(raw);
      const low = minExclusive ? n <= min : n < min;
      if (raw.trim() === "" || !Number.isFinite(n) || low || (max !== undefined && n > max)
        || (integer && !Number.isInteger(n))) {
        const range = `${minExclusive ? ">" : ">="} ${min}${max !== undefined ? ` and <= ${max}` : ""}`;
        throw new Error(`${a} needs ${integer ? "an integer" : "a number"} ${range} (got ${raw})`);
      }
      return n;
    };
    try {
      if (a === "--sde") opts.sde = value();
      else if (a === "--data-dir") opts.dataDir = value();
      else if (a === "--reset") opts.reset = true;
      else if (a === "--speed") opts.speed = num(SPEED_MIN, SPEED_MAX);
      else if (a === "--port") opts.port = num(PORT_ROW.min, PORT_ROW.max, { integer: true });
      else if (a === "--env-file") opts.envFile = value();
      else if (a === "--settings") opts.settings = value();
      else if (a === "--compose") opts.compose = value();
      else if (a === "--set") {
        const kv = value();
        const eq = kv.indexOf("=");
        if (eq < 1) throw new Error(`--set needs key=value (got ${kv})`);
        opts.set[kv.slice(0, eq)] = kv.slice(eq + 1);
      } else if (a === "--seed") opts.seed = num(0, 0xffffffff, { integer: true });
      else if (a === "--offline") {
        const mode = value();
        if (!OFFLINE_MODES.includes(mode)) throw new Error(`--offline needs ${OFFLINE_MODES.join("|")} (got ${mode})`);
        opts.offline = mode;
      } else if (a === "--offline-hours") opts.offlineHours = num(0);
      else if (a === "--offline-max-hours") opts.offlineMaxHours = num(0);
      else if (a === "--anchor-every-s") opts.anchorEveryS = num(0, undefined, { minExclusive: true });
      else if (a === "--status-min") opts.statusMin = num(0, undefined, { minExclusive: true });
      else if (a === "--status-file") opts.statusFile = value();
      else if (a === "--duration-s") opts.durationS = num(0, undefined, { minExclusive: true });
      else if (a === "--report-json") opts.reportJson = value();
      else if (a === "--checks-every-virtual-h") opts.checksEveryVirtualH = num(0);
      else if (a === "--no-statics") opts.statics = false;
      else throw new Error(`unknown option ${a}; usage: ${USAGE}`);
    } catch (err) {
      return refusal(err.message);
    }
  }
  return { ok: true, opts };
}

module.exports = { parseArgs, DEFAULTS, OFFLINE_MODES, SPEED_MIN, SPEED_MAX, USAGE, DEFAULT_SDE_DIR, MOD_DIR };
