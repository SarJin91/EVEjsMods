"use strict";

const path = require("node:path");

const LINE_PREFIX = "stall-diag: profile ";
const US_PER_MS = 1000;
const MS_PER_SECOND = 1000;
const MAX_KEY_CHARS = 80;
const MAX_NAME_CHARS = 30;
const SPECIAL = Object.freeze({ "(garbage collector)": "gc", "(program)": "program", "(idle)": "idle" });

function noop() {}

function toSlash(p) {
  return String(p).replace(/\\/g, "/");
}

function messageOf(err) {
  return String((err && err.message) || err).replace(/\s+/g, " ").slice(0, 200);
}

function summarizeProfile(profile, rootDir) {
  const root = typeof rootDir === "string" && rootDir !== "" ? `${toSlash(rootDir).replace(/\/+$/, "")}/` : "";
  const keyById = new Map();
  for (const node of profile.nodes || []) {
    const f = node.callFrame || {};
    const name = typeof f.functionName === "string" && f.functionName !== "" ? f.functionName : "(anonymous)";
    let key = name;
    if (!Object.prototype.hasOwnProperty.call(SPECIAL, name)) {
      let url = toSlash(f.url || "").replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:\/)/, "$1");
      if (root !== "" && url.startsWith(root)) url = url.slice(root.length);
      const head = name.slice(0, MAX_NAME_CHARS);
      const where = `${url || "-"}:${Number.isSafeInteger(f.lineNumber) ? f.lineNumber + 1 : 0}`;
      key = `${head}@${where.slice(-(MAX_KEY_CHARS - head.length - 1))}`;
    }
    keyById.set(node.id, key);
  }
  const samples = Array.isArray(profile.samples) ? profile.samples : [];
  const deltas = Array.isArray(profile.timeDeltas) ? profile.timeDeltas : [];
  const points = [];
  let t = Number.isFinite(profile.startTime) ? profile.startTime : 0;
  for (let i = 0; i < samples.length; i += 1) {
    const d = Number.isFinite(deltas[i]) ? deltas[i] : 0;
    t += d;
    points.push({ key: keyById.get(samples[i]) || "(unknown)", us: Math.max(0, d), atUs: t });
  }
  return points;
}

function topOf(points, topN) {
  const byKey = new Map();
  const special = { gc: 0, program: 0, idle: 0 };
  for (const p of points) {
    if (Object.prototype.hasOwnProperty.call(SPECIAL, p.key)) special[SPECIAL[p.key]] += p.us;
    else byKey.set(p.key, (byKey.get(p.key) || 0) + p.us);
  }
  const top = [...byKey.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN)
    .map(([key, us]) => `${key}/${Math.round(us / US_PER_MS)}`);
  return { top: top.length > 0 ? top.join(",") : "-", special };
}

function createCpuProfile(o) {
  const opts = o || {};
  const now = typeof opts.now === "function" ? opts.now : () => 0;
  const wallNow = typeof opts.wallNow === "function" ? opts.wallNow : () => 0;
  const log = typeof opts.log === "function" ? opts.log : noop;
  const noteOp = typeof opts.noteOp === "function" ? opts.noteOp : noop;
  const countFn = typeof opts.count === "function" ? opts.count : noop;
  const gaps = typeof opts.gaps === "function" ? opts.gaps : () => [];
  const setTimer = typeof opts.setTimer === "function" ? opts.setTimer : null;
  const durationSec = Number.isFinite(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : 120;
  const intervalUs = Number.isSafeInteger(opts.samplingIntervalUs) && opts.samplingIntervalUs > 0
    ? opts.samplingIntervalUs : 1000;
  const topN = Number.isSafeInteger(opts.topN) && opts.topN > 0 ? opts.topN : 10;
  const maxPerBoot = Number.isSafeInteger(opts.maxPerBoot) && opts.maxPerBoot >= 0 ? opts.maxPerBoot : 1;
  const metrics = opts.metrics || {};
  const fsApi = opts.fs;
  const dir = typeof opts.dir === "string" && opts.dir !== "" ? opts.dir : null;

  let state = "idle";
  let started = 0;
  let session = null;
  let timer = null;
  let stopped = false;
  let startAt = null;
  let lastError = "";
  let lastFile = null;

  function count(name) {
    if (typeof name !== "string") return;
    try {
      countFn(name, 1);
    } catch (_err) {
    }
  }

  function iso(ms) {
    try {
      return new Date(ms).toISOString();
    } catch (_err) {
      return "-";
    }
  }

  function closeSession() {
    const s = session;
    session = null;
    if (s === null) return;
    try {
      s.disconnect();
    } catch (_err) {
    }
  }

  function fail(step, err) {
    state = "failed";
    lastError = `${step}: ${messageOf(err)}`;
    if (timer !== null) {
      try {
        timer.cancel();
      } catch (_err) {
      }
      timer = null;
    }
    closeSession();
    count(metrics.failed);
    try {
      log(`${LINE_PREFIX}failed step=${step} error=${messageOf(err)}`);
    } catch (_err) {
    }
  }

  function post(method, params, onDone) {
    session.post(method, params, (err, result) => {
      if (stopped && method !== "Profiler.stop") return;
      if (err) {
        fail(method, err);
        return;
      }
      try {
        onDone(result);
      } catch (e) {
        fail(method, e);
      }
    });
  }

  function writeProfile(profile, atWall) {
    if (dir === null || !fsApi || !fsApi.promises) {
      state = "done";
      return;
    }
    const file = path.join(dir, `stall-${iso(atWall).replace(/[:.]/g, "-")}.cpuprofile`);
    Promise.resolve()
      .then(() => fsApi.promises.mkdir(dir, { recursive: true }))
      .then(() => {
        const t0 = now();
        const json = JSON.stringify(profile);
        noteOp("telemetry", "profileWrite", t0, now() - t0);
        return fsApi.promises.writeFile(file, json);
      })
      .then(() => {
        state = "done";
        lastFile = file;
        log(`${LINE_PREFIX}written file=${file}`);
      }, (err) => fail("write", err))
      .catch(() => {
        state = "failed";
      });
  }

  function onStopped(result) {
    const stopNow = now();
    closeSession();
    const profile = result && result.profile;
    if (!profile || !Array.isArray(profile.nodes)) {
      fail("Profiler.stop", new Error("no profile"));
      return;
    }
    state = "writing";
    const points = summarizeProfile(profile, opts.rootDir);
    const whole = topOf(points, topN);
    const r = (us) => Math.round(us / US_PER_MS);
    let aligned = "no";
    let gapText = "";
    if (startAt !== null && Number.isFinite(profile.startTime) && Number.isFinite(profile.endTime)) {
      const offStart = profile.startTime / US_PER_MS - startAt;
      const offStop = profile.endTime / US_PER_MS - stopNow;
      const drift = Math.abs(offStop - offStart);
      if (drift <= durationSec * MS_PER_SECOND) {
        aligned = `yes drift=${Math.round(drift)}`;
        const windows = gaps();
        const inGap = points.filter((p) => {
          const atMs = p.atUs / US_PER_MS - offStop;
          return windows.some((g) => atMs >= g[0] && atMs <= g[1]);
        });
        const g = topOf(inGap, topN);
        gapText = ` gaps=${windows.length} gapTop=${g.top}`;
      }
    }
    try {
      log(`${LINE_PREFIX}top=${whole.top} gc=${r(whole.special.gc)} program=${r(whole.special.program)}`
        + ` idle=${r(whole.special.idle)} samples=${points.length} aligned=${aligned}${gapText}`);
    } catch (_err) {
    }
    writeProfile(profile, wallNow());
  }

  function finish() {
    timer = null;
    if (state !== "running" || session === null) return;
    try {
      post("Profiler.stop", undefined, onStopped);
    } catch (err) {
      fail("Profiler.stop", err);
    }
  }

  function trigger(reason) {
    if (stopped) return { ok: false, reason: "busy" };
    if (state === "running" || state === "writing") return { ok: false, reason: "busy" };
    if (started >= maxPerBoot) return { ok: false, reason: "exhausted" };
    if (!opts.inspector || typeof opts.inspector.Session !== "function" || setTimer === null) {
      started += 1;
      fail("Session", new Error("inspector unavailable"));
      return { ok: false, reason: "inspector_failed" };
    }
    started += 1;
    state = "running";
    lastError = "";
    try {
      session = new opts.inspector.Session();
      session.connect();
      post("Profiler.enable", undefined, () => {
        post("Profiler.setSamplingInterval", { interval: intervalUs }, () => {
          const t0 = now();
          post("Profiler.start", undefined, () => {
            startAt = now();
            noteOp("telemetry", "profileStart", t0, startAt - t0);
            count(metrics.started);
            log(`${LINE_PREFIX}started at=${iso(wallNow())} reason=${String(reason || "-").slice(0, 80)}`
              + ` durationSec=${durationSec} intervalUs=${intervalUs}`);
            timer = setTimer(finish, durationSec * MS_PER_SECOND);
          });
        });
      });
    } catch (err) {
      fail("Session", err);
    }
    return state === "failed" ? { ok: false, reason: "inspector_failed" } : { ok: true };
  }

  function stop() {
    stopped = true;
    if (timer !== null) {
      try {
        timer.cancel();
      } catch (_err) {
      }
      timer = null;
    }
    closeSession();
    if (state === "running") state = "done";
  }

  function getStatus() {
    return { state, started, maxPerBoot, lastError, file: lastFile };
  }

  return Object.freeze({ trigger, stop, getStatus });
}

module.exports = { LINE_PREFIX, summarizeProfile, createCpuProfile };
