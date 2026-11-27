"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const HANDSHAKE_REL = Object.freeze(["server", "src", "network", "tcp", "handshake.js"]);
const DCB_KEY = Symbol.for("evejs.ourMods.privateFittingRuntime");
const MOON_KEY = Symbol.for("evejs.moonOreAnomalies.transientNames");
const HOOK_STATE_KEY = Symbol.for("evejs.lne.boardHook.v1");
const SEAM_FUNCTION = "function buildTidiSignedFunc(";
const SEAM_CALL = "[buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole }), 0]";
const LOGIN_CALL = "buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole })";
const TAIL_MARKER = "__lneBoardPreviousLogin";
const LOG_TAG = "LNE_BOARD_UI";
const HASH_RE = /^[0-9a-f]{64}$/;

const TAIL = "\n;const __lneBoardPreviousLogin = buildTidiSignedFunc;\n"
  + "buildTidiSignedFunc = function () {\n"
  + "  const original = __lneBoardPreviousLogin.apply(this, arguments);\n"
  + "  try {\n"
  + "    const delivery = globalThis[Symbol.for(\"evejs.lne.clientDelivery.v1\")];\n"
  + "    return delivery && typeof delivery.compose === \"function\" ? delivery.compose(original) : original;\n"
  + "  } catch (_error) { return original; }\n"
  + "};\n";

const canonical = (filename) => path.resolve(String(filename)).toLowerCase();

function sha256(text) {
  return crypto.createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");
}

function parseHashList(value) {
  const list = Array.isArray(value) ? value : String(value ?? "").split(",");
  return [...new Set(list.map((h) => String(h).trim().toLowerCase()).filter((h) => HASH_RE.test(h)))];
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

function count(text, token) {
  return text.split(token).length - 1;
}

// Peers may wrap the login call site; the tail only needs the declaration and the call through its binding.
function acceptsSource(content, baseline) {
  if (typeof content !== "string") return false;
  if (content.startsWith(baseline)) return true;
  const declarationEnd = baseline.indexOf("\nfunction ", baseline.indexOf(SEAM_FUNCTION) + 1);
  return declarationEnd > 0 && content.startsWith(baseline.slice(0, declarationEnd))
    && count(content, SEAM_FUNCTION) === 1 && count(content, LOGIN_CALL) === 1;
}

function installBoardHandshakeHook(deps) {
  const { moduleApi, globalObj, root, readFile, hashes, logger } = deps || {};
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
  if (!parseHashList(hashes).includes(hash)) return refusal("UNKNOWN_HANDSHAKE", `hash=${hash}`);
  if (!baseline.includes(SEAM_FUNCTION) || !baseline.includes(SEAM_CALL)) return refusal("SEAM_CHANGED");

  const state = { status: "HOOKED", tailBytes: null, target };
  const previous = moduleApi.prototype._compile;
  let done = false;

  function lneBoardCompile(content, filename) {
    const args = Array.prototype.slice.call(arguments);
    if (!done) {
      try {
        if (typeof filename === "string" && canonical(filename) === target) {
          done = true;
          if (acceptsSource(content, baseline) && !content.includes(TAIL_MARKER)) {
            state.tailBytes = Buffer.byteLength(content, "utf8") - Buffer.byteLength(baseline, "utf8");
            args[0] = content + TAIL;
            state.status = "WRAPPED";
            logLine(logger, `${LOG_TAG}:WRAPPER_READY tail=${state.tailBytes}`);
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

  moduleApi.prototype._compile = lneBoardCompile;
  return { ok: true, state };
}

module.exports = {
  HANDSHAKE_REL, DCB_KEY, MOON_KEY, HOOK_STATE_KEY, SEAM_FUNCTION, SEAM_CALL, TAIL, TAIL_MARKER, LOG_TAG, sha256,
  parseHashList, installBoardHandshakeHook,
};
