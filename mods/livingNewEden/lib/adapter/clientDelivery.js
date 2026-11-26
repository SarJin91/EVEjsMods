"use strict";

const zlib = require("node:zlib");

const DELIVERY_KEY = Symbol.for("evejs.lne.clientDelivery.v1");
const MAX_SIGNED_FUNC_BYTES = 256 * 1024;
const MAX_OWN_PAYLOAD_BYTES = 48 * 1024;
const MARSHAL_STRING = 0x74;
const HEADER_BYTES = 5;
const CODE_NAME = "<lne-board>";
const STUB_NAME = "<lne-board-stub>";
const BOARD_NAMES = Object.freeze({ code: CODE_NAME, stub: STUB_NAME, tag: "LNE_BOARD_UI" });
const PART_NAMES = Object.freeze({
  board: BOARD_NAMES,
  map: Object.freeze({ code: "<lne-map>", stub: "<lne-map-stub>", tag: "LNE_MAP_UI" }),
  mapProbe: Object.freeze({ code: "<lne-map-probe>", stub: "<lne-map-probe-stub>", tag: "LNE_MAP_UI" }),
});
const PART_PRIORITY = Object.freeze({ board: 10, map: 20, mapProbe: 30 });
const FILE_NAME_RE = /^<[a-z][a-z-]{0,40}>$/;
const TAG_RE = /^[A-Z][A-Z_]{0,31}$/;

function namesOf(names) {
  const n = names === undefined || names === null ? BOARD_NAMES : names;
  if (!n || typeof n !== "object" || !FILE_NAME_RE.test(String(n.code)) || !FILE_NAME_RE.test(String(n.stub))
    || !TAG_RE.test(String(n.tag))) {
    return null;
  }
  return n;
}

function stubSource(names) {
  const n = namesOf(names) || BOARD_NAMES;
  return "try:\n"
    + ` exec(compile(__import__("zlib").decompress(__import__("base64").b64decode(_lne_b)), "${n.code}", "exec"), `
    + "_lne_g)\n"
    + "except Exception:\n"
    + ` print("${n.tag}:UNAVAILABLE:COMPILE")\n`;
}
const STUB_SOURCE = stubSource(BOARD_NAMES);

const ASCII_RE = /^[\x00-\x7f]*$/;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

function pyLiteral(text) {
  return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`;
}

function wrapperHead(encoded, names) {
  const n = namesOf(names) || BOARD_NAMES;
  return `(lambda _lne_r: (eval(compile(${pyLiteral(stubSource(n))}, '${n.stub}', 'exec'), `
    + `{'__builtins__': __builtins__, '_lne_b': '${encoded}', `
    + "'_lne_g': {'__builtins__': __builtins__, '_lne_context': globals()}}), _lne_r)[1])(";
}

const WRAPPER_TAIL = ")";

function budgetOf(maxOwnBytes) {
  return Number.isSafeInteger(maxOwnBytes) && maxOwnBytes > 0 ? Math.min(maxOwnBytes, MAX_OWN_PAYLOAD_BYTES)
    : MAX_OWN_PAYLOAD_BYTES;
}

function buildPayload(pythonSource, maxOwnBytes, names) {
  try {
    if (typeof pythonSource !== "string" || pythonSource.trim() === "" || !ASCII_RE.test(pythonSource)) {
      return { ok: false, reason: "CLIENT_SOURCE", detail: "not_ascii_or_empty" };
    }
    const n = namesOf(names);
    if (!n) return { ok: false, reason: "CLIENT_SOURCE", detail: "bad_names" };
    const encoded = zlib.deflateSync(Buffer.from(pythonSource, "ascii"), { level: 9 }).toString("base64");
    const bytes = wrapperHead(encoded, n).length + WRAPPER_TAIL.length;
    const budget = budgetOf(maxOwnBytes);
    if (bytes > budget) return { ok: false, reason: "CLIENT_SOURCE", detail: `bytes=${bytes} budget=${budget}` };
    return { ok: true, encoded, bytes };
  } catch (err) {
    return { ok: false, reason: "CLIENT_SOURCE", detail: String((err && err.message) || err).slice(0, 80) };
  }
}

function isAsciiBytes(buffer, from) {
  for (let i = from; i < buffer.length; i += 1) if (buffer[i] > 0x7f) return false;
  return true;
}

function isValidHeader(original) {
  return Buffer.isBuffer(original) && original.length >= HEADER_BYTES && original[0] === MARSHAL_STRING
    && original.readUInt32LE(1) === original.length - HEADER_BYTES && isAsciiBytes(original, HEADER_BYTES);
}

function marshal(text) {
  const data = Buffer.from(text, "ascii");
  const header = Buffer.alloc(HEADER_BYTES);
  header[0] = MARSHAL_STRING;
  header.writeUInt32LE(data.length, 1);
  return Buffer.concat([header, data]);
}

function createClientDelivery(deps) {
  const encoded = deps && typeof deps.encoded === "string" ? deps.encoded : "";
  if (encoded === "" || !BASE64_RE.test(encoded)) throw new Error("createClientDelivery: encoded payload required");
  const names = namesOf(deps.names);
  if (!names) throw new Error("createClientDelivery: bad names");
  const head = wrapperHead(encoded, names);
  const log = deps.log || null;
  const counters = { composed: 0, skipped: 0 };
  let ready = false;

  function debug(line) {
    try {
      if (log && typeof log.debug === "function") log.debug(line);
    } catch (_err) {
    }
  }

  function skip() {
    counters.skipped += 1;
  }

  function compose(original) {
    try {
      if (!ready) {
        skip();
        return original;
      }
      if (!isValidHeader(original)) {
        skip();
        return original;
      }
      const length = head.length + (original.length - HEADER_BYTES) + WRAPPER_TAIL.length;
      if (length > MAX_SIGNED_FUNC_BYTES) {
        skip();
        debug(`jobBoard: client delivery skipped - signedFunc would be ${length} bytes `
          + `(limit ${MAX_SIGNED_FUNC_BYTES})`);
        return original;
      }
      const out = marshal(`${head}${original.toString("ascii", HEADER_BYTES)}${WRAPPER_TAIL}`);
      counters.composed += 1;
      return out;
    } catch (err) {
      skip();
      debug(`jobBoard: client delivery failed - ${(err && err.message) || err}`);
      return original;
    }
  }

  return Object.freeze({
    compose,
    wrapInner: (inner) => `${head}${inner}${WRAPPER_TAIL}`,
    extraBytes: () => head.length + WRAPPER_TAIL.length,
    noteSkip: skip,
    noteComposed() {
      counters.composed += 1;
    },
    setReady(flag) {
      ready = flag === true;
    },
    isReady: () => ready,
    stats: () => ({ ready, composed: counters.composed, skipped: counters.skipped }),
  });
}

const PART_NAME_RE = /^[A-Za-z]{1,32}$/;
const PART_METHODS = Object.freeze(["wrapInner", "extraBytes", "noteSkip", "noteComposed", "isReady", "stats"]);

function createCompositeDelivery(deps) {
  let log = (deps && deps.log) || null;
  const entries = new Map();
  const counters = { composed: 0, passed: 0, failed: 0 };

  function debug(line) {
    try {
      if (log && typeof log.debug === "function") log.debug(line);
    } catch (_err) {
    }
  }

  function sorted() {
    return [...entries.entries()].map(([name, e]) => ({ name, ...e }))
      .sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  function setPart(name, part, priority, partLog) {
    if (typeof name !== "string" || !PART_NAME_RE.test(name) || !Number.isSafeInteger(priority) || !part
      || typeof part !== "object" || PART_METHODS.some((m) => typeof part[m] !== "function")) {
      return { ok: false, reason: "BAD_PART" };
    }
    if (!log && partLog && typeof partLog.debug === "function") log = partLog;
    entries.set(name, { part, priority });
    return { ok: true };
  }

  function removePart(name, part) {
    const e = entries.get(name);
    if (e && e.part === part) entries.delete(name);
    return { ok: true, empty: entries.size === 0 };
  }

  function compose(original) {
    const list = sorted();
    const counted = new Set();
    try {
      if (!isValidHeader(original)) {
        for (const e of list) e.part.noteSkip();
        counters.passed += 1;
        return original;
      }
      let inner = original.toString("ascii", HEADER_BYTES);
      let wrapped = 0;
      for (const e of list) {
        if (!e.part.isReady()) {
          e.part.noteSkip();
          continue;
        }
        const length = inner.length + e.part.extraBytes();
        if (length > MAX_SIGNED_FUNC_BYTES) {
          e.part.noteSkip();
          debug(`client delivery: part ${e.name} skipped - signedFunc would be ${length} bytes `
            + `(limit ${MAX_SIGNED_FUNC_BYTES})`);
          continue;
        }
        inner = e.part.wrapInner(inner);
        e.part.noteComposed();
        counted.add(e.name);
        wrapped += 1;
      }
      if (wrapped === 0) {
        counters.passed += 1;
        return original;
      }
      const out = marshal(inner);
      counters.composed += 1;
      return out;
    } catch (err) {
      counters.failed += 1;
      debug(`client delivery failed - ${(err && err.message) || err}`);
      for (const e of list) {
        if (counted.has(e.name)) continue;
        try {
          e.part.noteSkip();
        } catch (_err) {
        }
      }
      return original;
    }
  }

  function parts() {
    return sorted().map((e) => {
      let ready = false;
      try {
        ready = e.part.isReady() === true;
      } catch (_err) {
        ready = false;
      }
      return { name: e.name, priority: e.priority, ready };
    });
  }

  function stats() {
    const out = { composed: counters.composed, passed: counters.passed, failed: counters.failed, parts: {} };
    for (const e of sorted()) {
      try {
        out.parts[e.name] = { priority: e.priority, ...e.part.stats() };
      } catch (_err) {
        out.parts[e.name] = { priority: e.priority };
      }
    }
    return out;
  }

  return Object.freeze({ setPart, removePart, compose, parts, stats });
}

module.exports = {
  DELIVERY_KEY, MAX_SIGNED_FUNC_BYTES, MAX_OWN_PAYLOAD_BYTES, CODE_NAME, STUB_NAME, STUB_SOURCE, PART_NAMES,
  PART_PRIORITY, stubSource, buildPayload, createClientDelivery, createCompositeDelivery,
};
