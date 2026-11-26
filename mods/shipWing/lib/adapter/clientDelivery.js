"use strict";

const zlib = require("node:zlib");

const DELIVERY_KEY = Symbol.for("evejs.shipWing.clientDelivery.v1");
const MAX_SIGNED_FUNC_BYTES = 256 * 1024;
const MAX_OWN_PAYLOAD_BYTES = 48 * 1024;
const MARSHAL_STRING = 0x74;
const HEADER_BYTES = 5;
const CODE_NAME = "<shipwing-client>";
const STUB_NAME = "<shipwing-stub>";
const STUB_SOURCE = "try:\n"
  + ` exec(compile(__import__("zlib").decompress(__import__("base64").b64decode(_sw_b)), "${CODE_NAME}", "exec"), `
  + "_sw_g)\n"
  + "except Exception:\n"
  + " print(\"SHIPWING_UI:UNAVAILABLE:COMPILE\")\n";

const ASCII_RE = /^[\x00-\x7f]*$/;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function pyLiteral(text) {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

function wrapperHead(encoded) {
  return `(lambda _sw_r: (eval(compile(${pyLiteral(STUB_SOURCE)}, '${STUB_NAME}', 'exec'), `
    + `{'__builtins__': __builtins__, '_sw_b': '${encoded}', `
    + "'_sw_g': {'__builtins__': __builtins__, '_sw_context': globals()}}), _sw_r)[1])(";
}

const WRAPPER_TAIL = ")";

function buildPayload(pythonSource) {
  try {
    if (typeof pythonSource !== "string" || pythonSource.trim() === "" || !ASCII_RE.test(pythonSource)) {
      return { ok: false, reason: "CLIENT_SOURCE" };
    }
    const encoded = zlib.deflateSync(Buffer.from(pythonSource, "ascii"), { level: 9 }).toString("base64");
    const bytes = wrapperHead(encoded).length + WRAPPER_TAIL.length;
    if (bytes > MAX_OWN_PAYLOAD_BYTES) return { ok: false, reason: "CLIENT_SOURCE" };
    return { ok: true, encoded, bytes };
  } catch (_err) {
    return { ok: false, reason: "CLIENT_SOURCE" };
  }
}

function isAsciiBytes(buffer, from) {
  for (let i = from; i < buffer.length; i += 1) if (buffer[i] > 0x7f) return false;
  return true;
}

function createClientDelivery(deps) {
  const encoded = deps && typeof deps.encoded === "string" ? deps.encoded : "";
  if (encoded === "" || !BASE64_RE.test(encoded)) throw new Error("createClientDelivery: encoded payload required");
  const head = wrapperHead(encoded);
  const log = deps.log || null;
  const counters = {};
  let ready = false;

  function bump(name) {
    counters[name] = (counters[name] || 0) + 1;
  }

  function debug(line) {
    try {
      if (log && typeof log.debug === "function") log.debug(line);
    } catch (_err) {
    }
  }

  function compose(original) {
    try {
      if (!ready) {
        bump("skipped.notReady");
        return original;
      }
      if (!Buffer.isBuffer(original) || original.length < HEADER_BYTES || original[0] !== MARSHAL_STRING
        || original.readUInt32LE(1) !== original.length - HEADER_BYTES || !isAsciiBytes(original, HEADER_BYTES)) {
        bump("skipped.badHeader");
        return original;
      }
      const length = head.length + (original.length - HEADER_BYTES) + WRAPPER_TAIL.length;
      if (length > MAX_SIGNED_FUNC_BYTES) {
        bump("skipped.tooLarge");
        debug(`client delivery skipped - signedFunc would be ${length} bytes (limit ${MAX_SIGNED_FUNC_BYTES})`);
        return original;
      }
      const data = Buffer.from(`${head}${original.toString("ascii", HEADER_BYTES)}${WRAPPER_TAIL}`, "ascii");
      const header = Buffer.alloc(HEADER_BYTES);
      header[0] = MARSHAL_STRING;
      header.writeUInt32LE(data.length, 1);
      bump("composed");
      return Buffer.concat([header, data]);
    } catch (err) {
      bump("skipped.error");
      debug(`client delivery failed - ${(err && err.message) || err}`);
      return original;
    }
  }

  return Object.freeze({
    compose,
    setReady(flag) {
      ready = flag === true;
    },
    isReady: () => ready,
    stats: () => ({ ready, counters: { ...counters } }),
  });
}

module.exports = {
  DELIVERY_KEY, MAX_SIGNED_FUNC_BYTES, MAX_OWN_PAYLOAD_BYTES, CODE_NAME, STUB_NAME, STUB_SOURCE, buildPayload,
  createClientDelivery,
};
