"use strict";

const fs = require("fs");
const { workerData, parentPort } = require("worker_threads");

const PHASES = ["boot", "owners", "after_owners"];
const HDR = { HEARTBEAT: 0, PHASE: 1, SEQ: 2, CRUMB_AT: 3, LABEL_LEN: 4, STALLS: 5, MAX_GAP: 6, SAMPLES: 7 };
const LABEL_MAX_BYTES = 120;
const CHECK_MS = 250;
const PAUSE_TIMEOUT_MS = 2000;
const MAX_LINE = 2000;
const DISABLE_FALLBACK_MS = 10000;

const data = workerData || {};
const hdr = new Int32Array(data.sab, 0, 16);
const bytes = new Uint8Array(data.sab, 64, 128);
const t0 = Number(data.t0) || Date.now();
const thresholdMs = Math.max(1, Number(data.thresholdMs) || 5000);
const sampleEveryMs = Math.max(1, Number(data.sampleEveryMs) || 20000);
const maxSamples = Math.max(0, Math.floor(Number(data.maxSamples) || 0));
const frames = Math.max(1, Math.floor(Number(data.frames) || 12));
const serverRoot = data.serverRoot ? String(data.serverRoot).replace(/\\/g, "/").replace(/\/+$/, "") : null;
const decoder = new TextDecoder();
const scriptUrls = new Map();

let stalled = false;
let episodeMaxGap = 0;
let episodeSamples = 0;
let lastSampleAt = 0;
let stalls = 0;
let maxGapMs = 0;
let samples = 0;
let done = false;
let session = null;
let noInspector = false;
let debuggerOn = false;
let pauseOutstanding = false;
let pendingSample = null;
let disableWanted = false;
let disableAt = 0;

function write(line) {
  try {
    fs.writeSync(1, `[hotPathPerf] ${line}\n`);
  } catch (_error) {
  }
}

function gapNow() {
  return (Date.now() - t0) - Atomics.load(hdr, HDR.HEARTBEAT);
}

function crumb() {
  const len = Math.min(LABEL_MAX_BYTES, Math.max(0, Atomics.load(hdr, HDR.LABEL_LEN)));
  if (Atomics.load(hdr, HDR.SEQ) === 0) return "none";
  const copy = new Uint8Array(len);
  copy.set(bytes.subarray(0, len));
  const ageS = ((Date.now() - t0 - Atomics.load(hdr, HDR.CRUMB_AT)) / 1000).toFixed(1);
  return `${decoder.decode(copy)}@-${ageS}s`;
}

function phase() {
  return PHASES[Atomics.load(hdr, HDR.PHASE)] || "boot";
}

function post(method, params) {
  try {
    if (session) session.post(method, params || {}, () => {});
  } catch (_error) {
  }
}

function shortUrl(url) {
  let u = String(url || "").replace(/^file:\/\//, "");
  if (/^\/[A-Za-z]:\//.test(u)) u = u.slice(1);
  u = u.replace(/\\/g, "/");
  if (serverRoot && u.startsWith(`${serverRoot}/`)) u = u.slice(serverRoot.length + 1);
  return u || "?";
}

function onPaused(message) {
  pauseOutstanding = false;
  try {
    if (data.testExitInPause === true) {
      write("stallWatch: test exit in pause");
      process.exit(0);
    }
    const sample = pendingSample;
    pendingSample = null;
    if (sample === null || !stalled || gapNow() < thresholdMs) return;
    const callFrames = (message && message.params && message.params.callFrames) || [];
    const parts = callFrames.slice(0, frames).map((f) => {
      const line = f.location && Number.isFinite(f.location.lineNumber) ? f.location.lineNumber + 1 : "?";
      const url = f.url || (f.location && scriptUrls.get(f.location.scriptId));
      return `${f.functionName || "(anonymous)"}@${shortUrl(url)}:${line}`;
    });
    write(`stallWatch: sample n=${sample} frames: ${parts.join(" < ")}`.slice(0, MAX_LINE));
  } catch (_error) {
  } finally {
    post("Debugger.resume");
    if (disableWanted && !stalled) disableDebugger();
  }
}

function openSession() {
  if (session || noInspector) return session !== null;
  try {
    const inspector = require("inspector");
    if (!inspector || typeof inspector.Session !== "function") throw new Error("no Session");
    const s = new inspector.Session();
    if (typeof s.connectToMainThread !== "function") throw new Error("no connectToMainThread");
    s.connectToMainThread();
    s.on("Debugger.scriptParsed", (message) => {
      const p = message && message.params;
      if (p && p.scriptId && p.url) scriptUrls.set(p.scriptId, p.url);
    });
    s.on("Debugger.paused", onPaused);
    session = s;
    return true;
  } catch (_error) {
    noInspector = true;
    write("stallWatch: no inspector - gaps only");
    return false;
  }
}

function disableDebugger() {
  disableWanted = false;
  if (!debuggerOn) return;
  debuggerOn = false;
  post("Debugger.disable");
}

function sample() {
  if (maxSamples === 0 || episodeSamples >= maxSamples) return;
  episodeSamples += 1;
  samples += 1;
  Atomics.store(hdr, HDR.SAMPLES, samples);
  lastSampleAt = Date.now();
  const n = episodeSamples;
  if (!openSession()) return;
  if (!debuggerOn) {
    debuggerOn = true;
    post("Debugger.enable");
  }
  pendingSample = n;
  pauseOutstanding = true;
  post("Debugger.pause");
  const timer = setTimeout(() => {
    if (pendingSample !== n) return;
    pendingSample = null;
    write(`stallWatch: sample n=${n} no-js (native or sync I/O) last=${crumb()}`);
  }, PAUSE_TIMEOUT_MS);
  if (typeof timer.unref === "function") timer.unref();
}

function check() {
  if (done) return;
  const gap = gapNow();
  if (!stalled) {
    if (disableWanted && Date.now() >= disableAt) disableDebugger();
    if (gap < thresholdMs) return;
    stalled = true;
    disableWanted = false;
    stalls += 1;
    episodeMaxGap = gap;
    episodeSamples = 0;
    Atomics.store(hdr, HDR.STALLS, stalls);
    write(`stallWatch: stall gapMs=${gap} phase=${phase()} uptimeS=${Math.round(process.uptime())} last=${crumb()}`);
    sample();
    return;
  }
  if (gap >= thresholdMs) {
    episodeMaxGap = Math.max(episodeMaxGap, gap);
    if (Date.now() - lastSampleAt >= sampleEveryMs) sample();
    return;
  }
  stalled = false;
  maxGapMs = Math.max(maxGapMs, episodeMaxGap);
  Atomics.store(hdr, HDR.MAX_GAP, maxGapMs);
  write(`stallWatch: stall ended gapMs=${episodeMaxGap} samples=${episodeSamples} phase=${phase()}`);
  pendingSample = null;
  if (pauseOutstanding) {
    disableWanted = true;
    disableAt = Date.now() + DISABLE_FALLBACK_MS;
  } else {
    disableDebugger();
  }
}

const interval = setInterval(check, CHECK_MS);

function finish(reason) {
  if (done) return;
  done = true;
  clearInterval(interval);
  if (stalled) maxGapMs = Math.max(maxGapMs, episodeMaxGap);
  Atomics.store(hdr, HDR.MAX_GAP, maxGapMs);
  if (session) {
    post("Debugger.resume");
    try {
      session.disconnect();
    } catch (_error) {
    }
    session = null;
  }
  write(`stallWatch: done stalls=${stalls} maxGapMs=${maxGapMs} samples=${samples} reason=${reason}`);
  if (parentPort) parentPort.close();
}

if (parentPort) {
  parentPort.on("message", (message) => {
    if (message && message.stop) finish(String(message.reason || "stop"));
  });
}
