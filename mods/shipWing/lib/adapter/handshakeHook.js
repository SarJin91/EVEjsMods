"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const HANDSHAKE_REL = Object.freeze(["server", "src", "network", "tcp", "handshake.js"]);
const DCB_KEY = Symbol.for("evejs.ourMods.privateFittingRuntime");
const MOON_KEY = Symbol.for("evejs.moonOreAnomalies.transientNames");
const SEAM_FUNCTION = "function buildTidiSignedFunc(";
const SEAM_CALL = "[buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole }), 0]";
const TAIL_MARKER = "__shipWingPreviousLogin";
const DCB_MARKER = "__fscOriginalLogin";
const MOON_MARKER = "__moonPreviousLogin";
const LOG_TAG = "SHIPWING_UI";

const TAIL = "\n;const __shipWingPreviousLogin = buildTidiSignedFunc;\n"
  + "buildTidiSignedFunc = function () {\n"
  + "  const original = __shipWingPreviousLogin.apply(this, arguments);\n"
  + "  try {\n"
  + "    const delivery = globalThis[Symbol.for(\"evejs.shipWing.clientDelivery.v1\")];\n"
  + "    return delivery && typeof delivery.compose === \"function\" ? delivery.compose(original) : original;\n"
  + "  } catch (_error) { return original; }\n"
  + "};\n";

const canonical = (filename) => path.resolve(String(filename)).toLowerCase();

function sha256(text) {
  return crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

function refusal(reason, detail) {
  return { ok: false, reason, line: `${LOG_TAG}:UNAVAILABLE:${reason}${detail ? ` ${detail}` : ""}` };
}

function logLine(logger, line) {
  try {
    if (logger && typeof logger.log === "function") logger.log(line);
  } catch (_err) {
  }
}

function installHandshakeHook(deps) {
  const { moduleApi, globalObj, root, readFile, hashes, delivery, logger } = deps;
  if (globalObj && (globalObj[DCB_KEY] || globalObj[MOON_KEY])) {
    return refusal("LOAD_ORDER", `dcb=${globalObj[DCB_KEY] ? 1 : 0} moon=${globalObj[MOON_KEY] ? 1 : 0}`);
  }
  if (!moduleApi || !moduleApi.prototype || typeof moduleApi.prototype._compile !== "function") {
    return refusal("SEAM_CHANGED", "Module.prototype._compile");
  }
  const file = path.join(String(root), ...HANDSHAKE_REL);
  const target = canonical(file);
  if (Object.keys(moduleApi._cache || {}).some((name) => canonical(name) === target)) {
    return refusal("HANDSHAKE_ALREADY_LOADED");
  }
  let baseline;
  try {
    baseline = String(readFile(file));
  } catch (err) {
    return refusal("HANDSHAKE_UNREADABLE", (err && err.code) || "");
  }
  const hash = sha256(baseline);
  if (!Array.isArray(hashes) || !hashes.includes(hash)) return refusal("UNKNOWN_HANDSHAKE", `hash=${hash}`);
  if (!baseline.includes(SEAM_FUNCTION) || !baseline.includes(SEAM_CALL)) return refusal("SEAM_CHANGED");
  if (!delivery || typeof delivery.compose !== "function") return refusal("CLIENT_SOURCE");

  const state = { status: "HOOKED", tailBytes: null, dcb: false, moon: false, target };
  const previous = moduleApi.prototype._compile;
  let done = false;

  function shipWingCompile(content, filename) {
    const args = Array.prototype.slice.call(arguments);
    if (!done) {
      try {
        if (typeof filename === "string" && canonical(filename) === target) {
          done = true;
          if (typeof content === "string" && content.startsWith(baseline) && !content.includes(TAIL_MARKER)) {
            const foreign = content.slice(baseline.length);
            state.tailBytes = Buffer.byteLength(foreign, "utf8");
            state.dcb = foreign.includes(DCB_MARKER);
            state.moon = foreign.includes(MOON_MARKER);
            args[0] = content + TAIL;
            state.status = "WRAPPED";
            logLine(logger, `${LOG_TAG}:WRAPPER_READY tail=${state.tailBytes} dcb=${state.dcb ? 1 : 0} `
              + `moon=${state.moon ? 1 : 0}`);
          } else {
            state.status = "CONFLICT";
            logLine(logger, `${LOG_TAG}:UNAVAILABLE:CONFLICTING_SOURCE`);
          }
        }
      } catch (_err) {
        args[0] = content;
        state.status = "CONFLICT";
      }
    }
    return previous.apply(this, args);
  }

  moduleApi.prototype._compile = shipWingCompile;
  return { ok: true, state };
}

module.exports = {
  HANDSHAKE_REL, DCB_KEY, MOON_KEY, SEAM_FUNCTION, SEAM_CALL, TAIL, TAIL_MARKER, sha256, installHandshakeHook,
};
