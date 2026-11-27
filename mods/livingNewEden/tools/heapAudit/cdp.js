"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULTS = Object.freeze({ memFactor: 1.5, diskFactor: 1.5, statsTimeoutS: 60, snapshotTimeoutS: 1800,
  durationS: 3000, everyS: 300, intervalBytes: 131072, callTimeoutS: 120, minFreeMb: 256 });
const HEAPSAMPLE_RANGES = Object.freeze({ durationS: [1, 14400], intervalBytes: [1024, 1048576] });
const MS_PER_S = 1000;
const KIB = 1024;
const MIB = KIB * KIB;
const TIMELINE_VERSION = 1;
const PROFILE_INDEX_DIGITS = 2;
const MEMINFO_PATH = "/proc/meminfo";
const MAX_DETAIL = 300;
const EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 });
const USAGE = "usage: cdp.js stats (--port <n> | --ws <url>) [--gc] [--timeout-s 60]\n"
  + "       cdp.js snapshot (--port <n> | --ws <url>) --out <file> [--mem-factor 1.5] [--disk-factor 1.5] [--force]"
  + " [--timeout-s 1800]\n"
  + "       cdp.js heapsample (--port <n> | --ws <url>) --out-dir <dir> [--duration-s 3000] [--every-s 300]"
  + " [--interval-bytes 131072] [--no-gc] [--call-timeout-s 120] [--min-free-mb 256]";

const STATS_EXPRESSION = `(() => {
  const out = { pid: process.pid, uptime: process.uptime(), memory: process.memoryUsage(), heap: null,
    spaces: null, heapReason: null };
  const main = process.mainModule;
  if (!main || typeof main.require !== "function") { out.heapReason = "NO_MAIN_MODULE"; return out; }
  try {
    const v8 = main.require("v8");
    out.heap = v8.getHeapStatistics();
    out.spaces = v8.getHeapSpaceStatistics();
  } catch (err) {
    out.heapReason = "V8_REQUIRE_FAILED: " + String(err && err.message || err).slice(0, 200);
  }
  return out;
})()`;

class Refusal extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

function detailOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function refusal(reason, detail) {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail: String(detail) };
}

function positiveNumber(text) {
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const command = args.shift();
  if (command === "heapsample") return parseHeapSampleArgs(args);
  if (command !== "stats" && command !== "snapshot") {
    return refusal("USAGE", "command must be stats, snapshot or heapsample");
  }
  const opts = { ok: true, command, port: null, ws: null, gc: false, out: null, memFactor: DEFAULTS.memFactor,
    diskFactor: DEFAULTS.diskFactor, force: false,
    timeoutS: command === "stats" ? DEFAULTS.statsTimeoutS : DEFAULTS.snapshotTimeoutS };
  while (args.length > 0) {
    const flag = args.shift();
    const value = () => {
      if (args.length === 0) throw new Refusal("USAGE", `${flag} needs a value`);
      return args.shift();
    };
    try {
      if (flag === "--port") {
        const port = Number(value());
        if (!Number.isInteger(port) || port <= 0 || port > 65535) return refusal("USAGE", "bad --port");
        opts.port = port;
      } else if (flag === "--ws") opts.ws = value();
      else if (flag === "--gc" && command === "stats") opts.gc = true;
      else if (flag === "--out" && command === "snapshot") opts.out = path.resolve(value());
      else if (flag === "--force" && command === "snapshot") opts.force = true;
      else if (flag === "--mem-factor" || flag === "--disk-factor" || flag === "--timeout-s") {
        const n = positiveNumber(value());
        if (n === null) return refusal("USAGE", `bad ${flag}`);
        if (flag === "--mem-factor") opts.memFactor = n;
        else if (flag === "--disk-factor") opts.diskFactor = n;
        else opts.timeoutS = n;
      } else return refusal("USAGE", `unknown argument ${flag}`);
    } catch (err) {
      return refusal("USAGE", err.detail || detailOf(err));
    }
  }
  if ((opts.port === null) === (opts.ws === null)) return refusal("USAGE", "give exactly one of --port, --ws");
  if (command === "snapshot" && opts.out === null) return refusal("USAGE", "snapshot needs --out");
  return opts;
}

function integerIn(text, min, max) {
  const n = Number(text);
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

function parseHeapSampleArgs(args) {
  const opts = { ok: true, command: "heapsample", port: null, ws: null, outDir: null, durationS: DEFAULTS.durationS,
    everyS: DEFAULTS.everyS, intervalBytes: DEFAULTS.intervalBytes, gc: true, callTimeoutS: DEFAULTS.callTimeoutS,
    minFreeMb: DEFAULTS.minFreeMb };
  let everyText = null;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--no-gc") {
      opts.gc = false;
      continue;
    }
    if (args.length === 0) return refusal("USAGE", `${flag} needs a value`);
    const text = args.shift();
    if (flag === "--port") {
      const port = integerIn(text, 1, 65535);
      if (port === null) return refusal("USAGE", "bad --port");
      opts.port = port;
    } else if (flag === "--ws") opts.ws = text;
    else if (flag === "--out-dir") opts.outDir = path.resolve(text);
    else if (flag === "--duration-s") {
      opts.durationS = integerIn(text, HEAPSAMPLE_RANGES.durationS[0], HEAPSAMPLE_RANGES.durationS[1]);
      if (opts.durationS === null) return refusal("USAGE", "bad --duration-s");
    } else if (flag === "--every-s") everyText = text;
    else if (flag === "--interval-bytes") {
      opts.intervalBytes = integerIn(text, HEAPSAMPLE_RANGES.intervalBytes[0], HEAPSAMPLE_RANGES.intervalBytes[1]);
      if (opts.intervalBytes === null) return refusal("USAGE", "bad --interval-bytes");
    } else if (flag === "--call-timeout-s") {
      opts.callTimeoutS = positiveNumber(text);
      if (opts.callTimeoutS === null) return refusal("USAGE", "bad --call-timeout-s");
    } else if (flag === "--min-free-mb") {
      const n = Number(text);
      if (!Number.isFinite(n) || n < 0) return refusal("USAGE", "bad --min-free-mb");
      opts.minFreeMb = n;
    } else return refusal("USAGE", `unknown argument ${flag}`);
  }
  if (everyText !== null) opts.everyS = integerIn(everyText, 1, opts.durationS);
  else if (opts.everyS > opts.durationS) opts.everyS = opts.durationS;
  if (opts.everyS === null) return refusal("USAGE", "bad --every-s (1..duration-s)");
  if ((opts.port === null) === (opts.ws === null)) return refusal("USAGE", "give exactly one of --port, --ws");
  if (opts.outDir === null) return refusal("USAGE", "heapsample needs --out-dir");
  return opts;
}

function parseMemInfo(text) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(String(text || ""));
  return m ? Number(m[1]) * KIB : null;
}

function readMemAvailable(readFile) {
  try {
    return parseMemInfo(readFile(MEMINFO_PATH, "utf8"));
  } catch (_err) {
    return null;
  }
}

function checkResources({ usedBytes, memAvailableBytes, diskFreeBytes, memFactor, diskFactor, force }) {
  const used = typeof usedBytes === "number" && usedBytes > 0 ? usedBytes : null;
  let memCheck = "unavailable";
  let diskCheck = "unavailable";
  if (used !== null && typeof memAvailableBytes === "number") {
    const need = memFactor * used;
    if (memAvailableBytes < need) {
      if (!force) return refusal("LOW_MEMORY", `MemAvailable ${memAvailableBytes} < ${memFactor} x used ${used}`);
      memCheck = "forced";
    } else memCheck = "ok";
  }
  if (used !== null && typeof diskFreeBytes === "number") {
    const need = diskFactor * used;
    if (diskFreeBytes < need) {
      if (!force) return refusal("LOW_DISK", `free ${diskFreeBytes} < ${diskFactor} x used ${used}`);
      diskCheck = "forced";
    } else diskCheck = "ok";
  }
  return { ok: true, memCheck, diskCheck };
}

async function resolveWsUrl(opts, fetchImpl, timeoutMs) {
  if (opts.ws !== null) return opts.ws;
  let list = null;
  try {
    const res = await fetchImpl(`http://127.0.0.1:${opts.port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
    list = await res.json();
  } catch (err) {
    throw new Refusal("NO_TARGET", detailOf(err));
  }
  const target = Array.isArray(list) ? list.find((t) => t && typeof t.webSocketDebuggerUrl === "string") : null;
  if (!target) throw new Refusal("NO_TARGET", "no webSocketDebuggerUrl in /json/list");
  return target.webSocketDebuggerUrl;
}

function openSession(url, WebSocketImpl) {
  return new Promise((resolve, reject) => {
    let ws = null;
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      reject(new Refusal("CDP_ERROR", detailOf(err)));
      return;
    }
    let nextId = 1;
    let opened = false;
    let closedError = null;
    const pending = new Map();
    const listeners = new Map();
    const failAll = (err) => {
      closedError = err;
      for (const p of pending.values()) p.reject(err);
      pending.clear();
    };
    const session = {
      send(method, params) {
        if (closedError !== null) return Promise.reject(closedError);
        const id = nextId;
        nextId += 1;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          try {
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          } catch (err) {
            pending.delete(id);
            rej(new Refusal("CDP_CLOSED", detailOf(err)));
          }
        });
      },
      on(method, fn) {
        listeners.set(method, fn);
      },
      close() {
        try {
          ws.close();
        } catch (_err) {
        }
      },
    };
    ws.addEventListener("open", () => {
      opened = true;
      resolve(session);
    });
    ws.addEventListener("message", (event) => {
      let msg = null;
      try {
        msg = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch (_err) {
        return;
      }
      if (msg && typeof msg.id === "number" && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) p.reject(new Refusal("CDP_ERROR", detailOf(msg.error.message || JSON.stringify(msg.error))));
        else p.resolve(msg.result || {});
        return;
      }
      if (msg && typeof msg.method === "string" && listeners.has(msg.method)) {
        try {
          listeners.get(msg.method)(msg.params || {});
        } catch (err) {
          failAll(new Refusal("CDP_ERROR", detailOf(err)));
          session.close();
        }
      }
    });
    ws.addEventListener("error", (event) => {
      const err = new Refusal(opened ? "CDP_CLOSED" : "CDP_ERROR",
        detailOf((event && event.message) || "socket error"));
      if (!opened) reject(err);
      failAll(err);
    });
    ws.addEventListener("close", () => {
      const err = new Refusal("CDP_CLOSED", "socket closed");
      if (!opened) reject(err);
      failAll(err);
    });
  });
}

function withDeadline(promise, ms, onTimeout) {
  let timer = null;
  const deadline = new Promise((_res, rej) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (_err) {
      }
      rej(new Refusal("TIMEOUT", `no result within ${ms} ms`));
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function evaluateStats(session, gc) {
  if (gc) await session.send("HeapProfiler.collectGarbage");
  const res = await session.send("Runtime.evaluate", { expression: STATS_EXPRESSION, returnByValue: true });
  if (res.exceptionDetails) throw new Refusal("CDP_ERROR", detailOf(res.exceptionDetails.text || "evaluate threw"));
  const value = res.result && res.result.value;
  if (!value || typeof value !== "object") throw new Refusal("CDP_ERROR", "evaluate returned no object");
  return value;
}

function defaultDeps(deps) {
  const d = deps || {};
  return {
    WebSocketImpl: d.WebSocketImpl !== undefined ? d.WebSocketImpl : globalThis.WebSocket,
    fetchImpl: d.fetchImpl || globalThis.fetch,
    readFile: d.readFile || fs.readFileSync,
    fsApi: d.fsApi || fs,
    nowMs: d.nowMs || (() => Date.now()),
    onStopRequest: d.onStopRequest || null,
  };
}

async function connect(opts, d, timeoutMs) {
  if (typeof d.WebSocketImpl !== "function") throw new Refusal("NO_WEBSOCKET", "global WebSocket needs Node >= 22");
  const url = await resolveWsUrl(opts, d.fetchImpl, timeoutMs);
  return openSession(url, d.WebSocketImpl);
}

async function connectBeforeDeadline(opts, d, timeoutMs, state) {
  const session = await connect(opts, d, timeoutMs);
  if (state.timedOut) {
    session.close();
    throw new Refusal("TIMEOUT", "deadline passed while connecting");
  }
  return session;
}

function onDeadline(state, getSession) {
  return () => {
    state.timedOut = true;
    const session = getSession();
    if (session) session.close();
  };
}

function asRefusal(err) {
  if (err instanceof Refusal) return refusal(err.reason, err.detail);
  return refusal("CDP_ERROR", detailOf(err));
}

async function runStats(opts, deps) {
  const d = defaultDeps(deps);
  const timeoutMs = opts.timeoutS * MS_PER_S;
  let session = null;
  const state = { timedOut: false };
  const work = (async () => {
    session = await connectBeforeDeadline(opts, d, timeoutMs, state);
    const v = await evaluateStats(session, opts.gc === true);
    return { ok: true, gc: opts.gc === true, pid: v.pid, uptimeSeconds: v.uptime, memory: v.memory, heap: v.heap,
      spaces: v.spaces, heapReason: v.heapReason, memAvailableBytes: readMemAvailable(d.readFile) };
  })();
  try {
    return await withDeadline(work, timeoutMs, onDeadline(state, () => session));
  } catch (err) {
    return asRefusal(err);
  } finally {
    if (session) session.close();
  }
}

function diskFree(fsApi, dir) {
  try {
    const s = fsApi.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch (_err) {
    return null;
  }
}

function removeQuietly(fsApi, file) {
  try {
    fsApi.rmSync(file, { force: true });
  } catch (_err) {
  }
}

async function runSnapshot(opts, deps) {
  const d = defaultDeps(deps);
  const fsApi = d.fsApi;
  const out = opts.out;
  const partial = `${out}.partial`;
  if (fsApi.existsSync(out)) return refusal("OUT_EXISTS", out);
  const timeoutMs = opts.timeoutS * MS_PER_S;
  let session = null;
  let fd = null;
  let wrote = false;
  const startedAt = d.nowMs();
  const state = { timedOut: false };
  const work = (async () => {
    session = await connectBeforeDeadline(opts, d, timeoutMs, state);
    const v = await evaluateStats(session, false);
    const usedBytes = v.heap && typeof v.heap.used_heap_size === "number" ? v.heap.used_heap_size
      : (v.memory && v.memory.heapUsed) || null;
    const memAvailableBytes = readMemAvailable(d.readFile);
    try {
      fsApi.mkdirSync(path.dirname(out), { recursive: true });
    } catch (err) {
      throw new Refusal("OUT_DIR_FAILED", detailOf(err));
    }
    const check = checkResources({ usedBytes, memAvailableBytes, diskFreeBytes: diskFree(fsApi, path.dirname(out)),
      memFactor: opts.memFactor, diskFactor: opts.diskFactor, force: opts.force === true });
    if (!check.ok) throw new Refusal(check.reason, check.detail);
    fd = fsApi.openSync(partial, "w");
    wrote = true;
    session.on("HeapProfiler.addHeapSnapshotChunk", (params) => {
      fsApi.writeSync(fd, String(params.chunk));
    });
    await session.send("HeapProfiler.enable");
    await session.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
    fsApi.closeSync(fd);
    fd = null;
    fsApi.renameSync(partial, out);
    try {
      await session.send("HeapProfiler.disable");
    } catch (_err) {
    }
    return { ok: true, out, bytes: fsApi.statSync(out).size, ms: d.nowMs() - startedAt, usedHeapBytes: usedBytes,
      memAvailableBytes, memCheck: memAvailableBytes === null ? "unavailable" : check.memCheck,
      diskCheck: check.diskCheck };
  })();
  try {
    return await withDeadline(work, timeoutMs, onDeadline(state, () => session));
  } catch (err) {
    if (fd !== null) {
      try {
        fsApi.closeSync(fd);
      } catch (_err) {
      }
    }
    if (wrote) removeQuietly(fsApi, partial);
    return asRefusal(err);
  } finally {
    if (session) session.close();
  }
}

function profileSelfBytes(profile) {
  let total = 0;
  const stack = profile && profile.head ? [profile.head] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node.selfSize === "number" && Number.isFinite(node.selfSize)) total += node.selfSize;
    if (Array.isArray(node.children)) for (const child of node.children) if (child) stack.push(child);
  }
  return total;
}

function runIdOf(iso) {
  return iso.replace(/[:.]/g, "-");
}

function writeAtomic(fsApi, file, text) {
  const partial = `${file}.partial`;
  fsApi.writeFileSync(partial, text);
  fsApi.renameSync(partial, file);
}

async function runHeapSample(opts, deps) {
  const d = defaultDeps(deps);
  const fsApi = d.fsApi;
  const outDir = opts.outDir;
  const startedAtMs = d.nowMs();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const runId = runIdOf(startedAtIso);
  const prefix = `hs-${runId}`;
  const timelineFile = path.join(outDir, `${prefix}.timeline.json`);
  const minFreeBytes = opts.minFreeMb * MIB;
  const callTimeoutMs = opts.callTimeoutS * MS_PER_S;
  try {
    fsApi.mkdirSync(outDir, { recursive: true });
  } catch (err) {
    return refusal("OUT_DIR_FAILED", detailOf(err));
  }
  let existing = [];
  try {
    existing = fsApi.readdirSync(outDir).filter((name) => name.startsWith(prefix));
  } catch (err) {
    return refusal("OUT_DIR_FAILED", detailOf(err));
  }
  if (existing.length > 0) return refusal("OUT_EXISTS", path.join(outDir, existing[0]));
  const checkDisk = () => {
    const free = diskFree(fsApi, outDir);
    if (free !== null && free < minFreeBytes) throw new Refusal("LOW_DISK", `free ${free} < ${opts.minFreeMb} MiB`);
  };
  try {
    checkDisk();
  } catch (err) {
    return asRefusal(err);
  }

  const timeline = { version: TIMELINE_VERSION, runId, intervalBytes: opts.intervalBytes, gcBeforeRead: opts.gc,
    startedAtIso, reads: [] };
  let session = null;
  let sampling = false;
  let stopRequested = false;
  let wake = null;
  if (typeof d.onStopRequest === "function") {
    d.onStopRequest(() => {
      stopRequested = true;
      if (wake) wake();
    });
  }
  const state = { timedOut: false };
  const call = (method, params) => withDeadline(session.send(method, params), callTimeoutMs,
    onDeadline(state, () => session));
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(timer);
      wake = null;
      resolve();
    };
  });
  const usage = async () => {
    const u = await call("Runtime.getHeapUsage");
    return { usedHeapBytes: typeof u.usedSize === "number" ? u.usedSize : null,
      totalHeapBytes: typeof u.totalSize === "number" ? u.totalSize : null };
  };
  const read = async (withProfile) => {
    const n = timeline.reads.length;
    let file = null;
    let profileBytes = null;
    let profileSamples = null;
    if (withProfile) {
      if (opts.gc) await call("HeapProfiler.collectGarbage");
      const res = await call("HeapProfiler.getSamplingProfile");
      const profile = res && res.profile;
      if (!profile || !profile.head) throw new Refusal("CDP_ERROR", "getSamplingProfile returned no profile");
      checkDisk();
      file = `${prefix}-${String(n).padStart(PROFILE_INDEX_DIGITS, "0")}.heapprofile`;
      writeAtomic(fsApi, path.join(outDir, file), JSON.stringify(profile));
      profileBytes = profileSelfBytes(profile);
      profileSamples = Array.isArray(profile.samples) ? profile.samples.length : 0;
    }
    const u = await usage();
    const atMs = d.nowMs();
    timeline.reads.push({ n, atIso: new Date(atMs).toISOString(), atMs, usedHeapBytes: u.usedHeapBytes,
      totalHeapBytes: u.totalHeapBytes, profileBytes, profileSamples, file });
    checkDisk();
    writeAtomic(fsApi, timelineFile, JSON.stringify(timeline, null, 2));
  };

  try {
    const connectTimeoutMs = callTimeoutMs;
    const connecting = connectBeforeDeadline(opts, d, connectTimeoutMs, state);
    session = await withDeadline(connecting, connectTimeoutMs, onDeadline(state, () => session));
    await call("HeapProfiler.enable");
    if (opts.gc) await call("HeapProfiler.collectGarbage");
    await read(false);
    let alreadySampling = false;
    try {
      await call("HeapProfiler.getSamplingProfile");
      alreadySampling = true;
    } catch (err) {
      if (!(err instanceof Refusal) || err.reason !== "CDP_ERROR") throw err;
    }
    if (alreadySampling) throw new Refusal("SAMPLING_FAILED", "sampling already running in the target");
    try {
      await call("HeapProfiler.startSampling", { samplingInterval: opts.intervalBytes,
        includeObjectsCollectedByMajorGC: false, includeObjectsCollectedByMinorGC: false });
    } catch (err) {
      throw new Refusal("SAMPLING_FAILED", err instanceof Refusal ? `${err.reason}: ${err.detail}` : detailOf(err));
    }
    sampling = true;
    const endMs = startedAtMs + opts.durationS * MS_PER_S;
    let stoppedBy = "duration";
    for (;;) {
      const remaining = endMs - d.nowMs();
      if (remaining <= 0) break;
      if (!stopRequested) await wait(Math.min(opts.everyS * MS_PER_S, remaining));
      await read(true);
      if (stopRequested) {
        stoppedBy = "signal";
        break;
      }
    }
    await call("HeapProfiler.stopSampling");
    sampling = false;
    await call("HeapProfiler.disable");
    return { ok: true, command: "heapsample", runId, outDir, reads: timeline.reads.length, stoppedBy,
      timeline: timelineFile };
  } catch (err) {
    if (sampling && session && !state.timedOut) {
      try {
        await call("HeapProfiler.stopSampling");
      } catch (_err) {
      }
    }
    for (const name of safeList(fsApi, outDir)) {
      if (name.startsWith(prefix) && name.endsWith(".partial")) removeQuietly(fsApi, path.join(outDir, name));
    }
    return { ...asRefusal(err), reads: timeline.reads.length };
  } finally {
    if (session) session.close();
  }
}

function safeList(fsApi, dir) {
  try {
    return fsApi.readdirSync(dir);
  } catch (_err) {
    return [];
  }
}

async function main(argv, deps) {
  const opts = parseArgs(argv);
  const print = (deps && deps.print) || ((line) => process.stdout.write(`${line}\n`));
  if (!opts.ok) {
    process.stderr.write(`${USAGE}\n`);
    print(JSON.stringify(opts));
    return EXIT.usage;
  }
  let result = null;
  if (opts.command === "stats") result = await runStats(opts, deps);
  else if (opts.command === "snapshot") result = await runSnapshot(opts, deps);
  else result = await runHeapSample(opts, deps);
  print(JSON.stringify(result, null, 2));
  return result.ok ? EXIT.ok : EXIT.refused;
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  const deps = {};
  if (argv[0] === "heapsample") {
    const stoppers = [];
    let signals = 0;
    const onSignal = () => {
      signals += 1;
      if (signals > 1) process.exit(EXIT.refused);
      for (const fn of stoppers) fn();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    deps.onStopRequest = (fn) => stoppers.push(fn);
  }
  main(argv, deps).then((code) => {
    process.exitCode = code;
  }, (err) => {
    process.stdout.write(`${JSON.stringify(refusal("CDP_ERROR", detailOf(err)))}\n`);
    process.exitCode = EXIT.refused;
  });
}

module.exports = { DEFAULTS, STATS_EXPRESSION, parseArgs, parseMemInfo, checkResources, runStats, runSnapshot,
  runHeapSample, profileSelfBytes, main };
