"use strict";

const { defaultSetTimer: checkpointerSetTimer } = require("./checkpointer");

const STATE = Object.freeze({ IDLE: "idle", OPENING: "opening", READING: "reading", DONE: "done",
  FAILED: "failed", STOPPED: "stopped" });

function noop() {}

function defaultSetTimer(fn, ms) {
  if (ms > 0) return checkpointerSetTimer(fn, ms);
  const handle = setImmediate(fn);
  if (handle && typeof handle.unref === "function") handle.unref();
  return { cancel: () => clearImmediate(handle) };
}

function nextRead(pos, limit, chunkBytes) {
  if (!(pos < limit) || !(chunkBytes > 0)) return { read: false };
  return { read: true, length: Math.min(chunkBytes, limit - pos) };
}

function codeOf(err) {
  if (err && typeof err.code === "string" && err.code !== "") return err.code;
  return String((err && err.message) || err || "ERROR");
}

function createWarmup(deps) {
  const filePath = deps.filePath;
  const settings = deps.settings;
  const fsApi = deps.fsApi || require("node:fs");
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const nowMs = deps.nowMs;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  let state = STATE.IDLE;
  let fd = null;
  let pending = false;
  let timer = null;
  let buf = null;
  let pos = 0;
  let limit = null;
  let truncated = false;
  let chunks = 0;
  let startedAtMs = null;
  let ms = null;
  let reason = null;

  function closeFd() {
    if (fd === null) return;
    const f = fd;
    fd = null;
    try {
      fsApi.close(f, noop);
    } catch (_err) {
    }
  }

  function fail(err) {
    if (state === STATE.STOPPED) return;
    state = STATE.FAILED;
    reason = codeOf(err);
    buf = null;
    logger.log(`persistence: warmup failed - ${reason}`);
  }

  function done() {
    state = STATE.DONE;
    ms = nowMs() - startedAtMs;
    buf = null;
    const r = { bytes: pos, ms, chunks, truncated };
    logger.log(`persistence: warmup done bytes=${pos} ms=${Math.round(ms)} chunks=${chunks}`
      + `${truncated ? " truncated=1" : ""}`);
    if (typeof deps.onDone === "function") {
      try {
        deps.onDone(r);
      } catch (_err) {
      }
    }
  }

  function landed() {
    pending = false;
    if (state === STATE.STOPPED) {
      closeFd();
      return false;
    }
    return true;
  }

  function step() {
    timer = null;
    if (state !== STATE.READING) return;
    const next = nextRead(pos, limit, settings.warmupChunkBytes);
    if (!next.read) {
      done();
      return;
    }
    pending = true;
    try {
      fsApi.read(fd, buf, 0, next.length, pos, onRead);
    } catch (err) {
      pending = false;
      fail(err);
    }
  }

  function onRead(err, bytesRead) {
    if (!landed()) return;
    if (err) {
      fail(err);
      return;
    }
    const n = Number(bytesRead) || 0;
    if (n <= 0) {
      done();
      return;
    }
    pos += n;
    chunks += 1;
    if (pos >= limit) {
      done();
      return;
    }
    try {
      timer = setTimer(step, settings.warmupPauseMs);
    } catch (e) {
      timer = null;
      fail(e);
    }
  }

  function onStat(err, st) {
    if (!landed()) return;
    if (err) {
      fail(err);
      return;
    }
    const size = Math.max(0, Number(st && st.size) || 0);
    limit = Math.min(size, settings.warmupMaxBytes);
    truncated = size > settings.warmupMaxBytes;
    state = STATE.READING;
    if (limit > 0) {
      try {
        buf = Buffer.allocUnsafe(Math.min(settings.warmupChunkBytes, limit));
      } catch (e) {
        fail(e);
        return;
      }
    }
    step();
  }

  function onOpen(err, openedFd) {
    pending = false;
    if (state === STATE.STOPPED) {
      if (!err && typeof openedFd === "number") {
        fd = openedFd;
        closeFd();
      }
      return;
    }
    if (err) {
      fail(err);
      return;
    }
    fd = openedFd;
    pending = true;
    try {
      fsApi.fstat(fd, onStat);
    } catch (e) {
      pending = false;
      fail(e);
    }
  }

  function start() {
    if (state === STATE.STOPPED) return { ok: false, reason: "WARMUP_STOPPED" };
    if (state !== STATE.IDLE) return { ok: false, reason: "already_started" };
    state = STATE.OPENING;
    startedAtMs = nowMs();
    pending = true;
    try {
      fsApi.open(filePath, "r", onOpen);
    } catch (err) {
      pending = false;
      fail(err);
    }
    return { ok: true };
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    buf = null;
    if (timer !== null) {
      const t = timer;
      timer = null;
      try {
        t.cancel();
      } catch (_err) {
      }
    }
    if (!pending) closeFd();
  }

  function getStatus() {
    return Object.freeze({ state, bytes: pos, limit, chunks, ms, reason });
  }

  return Object.freeze({ start, stop, getStatus });
}

module.exports = { createWarmup, nextRead, WARMUP_STATE: STATE };
