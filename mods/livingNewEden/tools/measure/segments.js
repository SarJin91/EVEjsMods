"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { deferredOf, deferredMark } = require("./histogramsDeferred");

const DB_FILE = "world.sqlite";
const SEGMENT_REPORT_RE = /^seg(\d+)\.report\.json$/;

class UsageError extends Error {}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function median(values) {
  const nums = (Array.isArray(values) ? values : []).filter(isNum);
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function maxOf(values) {
  const nums = (Array.isArray(values) ? values : []).filter(isNum);
  return nums.length === 0 ? null : Math.max(...nums);
}

function channelsOf(telemetry) {
  if (!telemetry || typeof telemetry !== "object") return null;
  if (telemetry.channels && typeof telemetry.channels === "object") return telemetry.channels;
  return telemetry;
}

function counter(telemetry, channel, name) {
  const ch = channelsOf(telemetry);
  const v = ch && ch[channel] && typeof ch[channel] === "object" ? ch[channel][name] : undefined;
  return isNum(v) ? v : 0;
}

function histogramP95(telemetry, channel, name) {
  const ch = channelsOf(telemetry);
  const h = ch && ch[channel] && typeof ch[channel] === "object" ? ch[channel][name] : undefined;
  return h && typeof h === "object" && isNum(h.p95) ? h.p95 : null;
}

function schedulerValues(records, field) {
  return (Array.isArray(records) ? records : [])
    .map((r) => (r && r.scheduler && typeof r.scheduler === "object" ? r.scheduler[field] : undefined))
    .filter(isNum);
}

function segmentExitOk(s) {
  if (!s || !s.report || typeof s.report !== "object"
    || Object.prototype.hasOwnProperty.call(s.report, "error")) return false;
  return s.exitCode === undefined || s.exitCode === null || s.exitCode === 0;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch (_err) {
    }
  }
  return out;
}

function logCounts(file, patterns) {
  const out = {};
  for (const k of Object.keys(patterns)) out[k] = 0;
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    for (const [k, re] of Object.entries(patterns)) if (re.test(line)) out[k] += 1;
  }
  return out;
}

function exitCodeOf(file) {
  if (!fs.existsSync(file)) return null;
  const n = Number(fs.readFileSync(file, "utf8").trim());
  return Number.isSafeInteger(n) ? n : -1;
}

function segmentsOf(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`not a directory: ${dir}`);
  const db = path.join(dir, DB_FILE);
  if (!fs.existsSync(db)) throw new UsageError(`missing ${DB_FILE} in ${dir}`);
  const segs = fs.readdirSync(dir).map((f) => SEGMENT_REPORT_RE.exec(f)).filter(Boolean)
    .map((m) => Number(m[1])).sort((a, b) => a - b);
  if (segs.length === 0) throw new UsageError(`missing seg<n>.report.json in ${dir}`);
  return { db, segs };
}

function readDays(dir, patterns) {
  const { db, segs } = segmentsOf(dir);
  const days = segs.map((n) => {
    const report = readJson(path.join(dir, `seg${n}.report.json`));
    const telFile = path.join(dir, `seg${n}.telemetry.json`);
    return { index: n, startVirtualAt: report.startVirtualAt, stopVirtualAt: report.stopVirtualAt, report,
      telemetry: fs.existsSync(telFile) ? readJson(telFile) : null,
      status: readJsonl(path.join(dir, `seg${n}.status.jsonl`)),
      ...logCounts(path.join(dir, `seg${n}.log`), patterns || {}),
      exitCode: exitCodeOf(path.join(dir, `seg${n}.exit`)) };
  });
  return { db, days, from: days[0].startVirtualAt, to: days[days.length - 1].stopVirtualAt };
}

module.exports = { UsageError, DB_FILE, isNum, median, maxOf, channelsOf, counter, histogramP95, schedulerValues,
  segmentExitOk, readJson, readJsonl, logCounts, exitCodeOf, segmentsOf, readDays, deferredOf, deferredMark };
