"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { SCHEMA } = require("../../config");
const { createClock } = require("../../lib/util/clock");

const INTERVAL_ROW = SCHEMA.find((r) => r.key === "scheduler.intervalMs");
if (!INTERVAL_ROW || !Number.isFinite(INTERVAL_ROW.min)) throw new Error("liveSim: SCHEMA scheduler.intervalMs.min missing");
const MIN_INTERVAL_MS = INTERVAL_ROW.min;

const ANCHOR_FILE = "liveSim.json";
const ANCHOR_SCHEMA = 1;
const TOOL = "liveSim";
const MS_PER_HOUR = 3600000;
const ANCHOR_NUMBERS = Object.freeze(["createdWallAt", "firstVirtualAt", "speed", "wallAt", "virtualAt", "runs"]);

function resumeAnchor(prev, opts, wallNow) {
  const wall = Math.floor(Number(wallNow));
  if (!prev) {
    return { anchor: Object.freeze({ schema: ANCHOR_SCHEMA, tool: TOOL, createdWallAt: wall, firstVirtualAt: wall,
      speed: opts.speed, anchorEveryS: opts.anchorEveryS, wallAt: wall, virtualAt: wall, runs: 1, cleanStop: false }),
    gapMs: 0, mode: "first" };
  }
  let gapMs;
  let mode;
  if (opts.offlineHours !== null && opts.offlineHours !== undefined) {
    gapMs = opts.offlineHours * MS_PER_HOUR;
    mode = "hours";
  } else if (opts.offline === "pause") {
    gapMs = 0;
    mode = "pause";
  } else {
    gapMs = Math.min(Math.max(0, wall - prev.wallAt) * prev.speed, opts.offlineMaxHours * MS_PER_HOUR);
    mode = "capped";
  }
  const pending = Number.isFinite(prev.pendingVirtualAt) ? prev.pendingVirtualAt : null;
  const base = pending !== null ? Math.max(prev.virtualAt, pending) : prev.virtualAt;
  const killed = prev.cleanStop !== true || pending !== null;
  if (killed) {
    const everyS = Number.isFinite(prev.anchorEveryS) && prev.anchorEveryS > 0 ? prev.anchorEveryS : opts.anchorEveryS;
    const windowS = Math.max(everyS, Number.isFinite(prev.maxWriteGapS) ? prev.maxWriteGapS : 0);
    gapMs = Math.max(gapMs, windowS * 1000 * prev.speed);
  }
  const gap = Math.max(0, Math.floor(gapMs));
  const { pendingVirtualAt: _pending, maxWriteGapS: _gap, ...rest } = prev;
  return { anchor: Object.freeze({ ...rest, schema: ANCHOR_SCHEMA, tool: TOOL, speed: opts.speed,
    anchorEveryS: opts.anchorEveryS, wallAt: wall, virtualAt: base + gap, runs: prev.runs + 1,
    cleanStop: false }), gapMs: gap, mode };
}

function createScaledClock({ anchor, speed, wallNow = Date.now }) {
  const base = Object.freeze({ ...anchor });
  const clock = createClock({ nowFn: () => base.virtualAt + (wallNow() - base.wallAt) * speed, timeScale: 1 });
  return Object.freeze({ now: clock.now, timeScale: clock.timeScale, travelDurationMs: clock.travelDurationMs,
    anchor: () => base });
}

function readAnchor(dataDir) {
  const file = path.join(dataDir, ANCHOR_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { ok: true, anchor: null };
    return { ok: false, reason: "ANCHOR_INVALID", detail: `${file}: ${(err && err.message) || err}` };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: "ANCHOR_INVALID", detail: `${file}: ${err.message}` };
  }
  if (!value || typeof value !== "object" || value.schema !== ANCHOR_SCHEMA || value.tool !== TOOL) {
    return { ok: false, reason: "ANCHOR_INVALID", detail: `${file}: schema ${value && value.schema} (expected ${ANCHOR_SCHEMA})` };
  }
  const bad = ANCHOR_NUMBERS.filter((k) => !Number.isFinite(value[k]));
  if (bad.length > 0 || typeof value.cleanStop !== "boolean") {
    return { ok: false, reason: "ANCHOR_INVALID", detail: `${file}: bad ${[...bad, "cleanStop"].join(",")}` };
  }
  if (value.pendingVirtualAt !== undefined && !Number.isFinite(value.pendingVirtualAt)) {
    return { ok: false, reason: "ANCHOR_INVALID", detail: `${file}: bad pendingVirtualAt` };
  }
  if (value.maxWriteGapS !== undefined && !(Number.isFinite(value.maxWriteGapS) && value.maxWriteGapS >= 0)) {
    return { ok: false, reason: "ANCHOR_INVALID", detail: `${file}: bad maxWriteGapS` };
  }
  return { ok: true, anchor: Object.freeze(value) };
}

function writeAnchor(dataDir, anchor) {
  const file = path.join(dataDir, ANCHOR_FILE);
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ ...anchor, schema: ANCHOR_SCHEMA, tool: TOOL }, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "ANCHOR_WRITE_FAILED", detail: String((err && err.message) || err) };
  }
}

function wallIntervalOf(intervalMs, speed, minIntervalMs = MIN_INTERVAL_MS) {
  return Math.max(minIntervalMs, Math.round(intervalMs / speed));
}

function schedulerParity(intervalMs, speed, minIntervalMs = MIN_INTERVAL_MS) {
  const parityLimit = intervalMs / minIntervalMs;
  return { wallMs: wallIntervalOf(intervalMs, speed, minIntervalMs), parityLimit, warning: speed > parityLimit };
}

module.exports = { ANCHOR_FILE, ANCHOR_SCHEMA, MIN_INTERVAL_MS, resumeAnchor, createScaledClock, readAnchor, writeAnchor,
  wallIntervalOf, schedulerParity };
