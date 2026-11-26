"use strict";

const { boardWindowOf } = require("./rules");

const ELLIPSIS = "...";
const MICRO = 1e6;
const DATE_CHARS = 10;
const STANDING_DECIMALS = 3;
const JOBS_COMMAND = "!jobs";
const MS_PER_SECOND = 1000;

function groupDigits(n) {
  const s = String(Math.max(0, Math.trunc(Number(n) || 0)));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function rewardText(job) {
  const parts = [`${groupDigits(job.iskAmount)} ISK`];
  if (Number(job.lpAmount) > 0) parts.push(`${groupDigits(job.lpAmount)} LP`);
  return parts.join(" + ");
}

function dateOfDay(day, resetHourUtc) {
  const { startMs } = boardWindowOf(day, resetHourUtc);
  return Number.isSafeInteger(startMs) ? new Date(startMs).toISOString().slice(0, DATE_CHARS) : `day ${day}`;
}

function stateOf(job) {
  return job.myState === "DONE" ? "DONE" : String(job.state);
}

function cutJoined(lines, maxChars, lineBreak) {
  const out = [];
  let used = 0;
  for (const line of lines) {
    const sep = out.length > 0 ? lineBreak.length : 0;
    if (used + sep + line.length <= maxChars) {
      out.push(line);
      used += sep + line.length;
      continue;
    }
    const room = maxChars - used - sep - ELLIPSIS.length;
    if (room > 0) out.push(`${line.slice(0, room)}${ELLIPSIS}`);
    else if (out.length > 0) {
      const last = out[out.length - 1];
      out[out.length - 1] = `${last.slice(0, Math.max(0, last.length - ELLIPSIS.length))}${ELLIPSIS}`;
    }
    break;
  }
  return out.join(lineBreak);
}

function formatBoardReply(board, opts) {
  const lineBreak = String(opts.lineBreak);
  const jobs = board && Array.isArray(board.jobs) ? board.jobs : [];
  if (jobs.length === 0) return cutJoined(["LNE jobs: no front jobs today"], opts.maxChars, lineBreak);
  const lines = [`LNE front jobs ${dateOfDay(board.day, opts.resetHourUtc)} (UTC)`];
  for (const j of jobs) {
    const progress = Math.min(Number(j.myProgress) || 0, j.targetCount);
    lines.push(`#${j.slot} ${j.description} - ${rewardText(j)} - ${progress}/${j.targetCount} - ${stateOf(j)}`);
  }
  return cutJoined(lines, opts.maxChars, lineBreak);
}

function formatJobsRefusal(reason, opts = {}) {
  switch (reason) {
    case "RATE_LIMITED":
      return `LNE jobs: wait ${Math.max(1, Math.ceil((Number(opts.waitMs) || 0) / MS_PER_SECOND))} s before the next `
        + JOBS_COMMAND;
    case "BUSY":
      return "LNE jobs: server busy, try again later";
    default:
      return `LNE jobs unavailable (${String(opts.detail || reason)})`;
  }
}

function formatBoardMailLine(board, opts) {
  const jobs = board && Array.isArray(board.jobs) ? board.jobs : [];
  const items = jobs.map((j) => `#${j.slot} ${j.description} (${rewardText(j)})`);
  const text = `New front job board ${dateOfDay(board.day, opts.resetHourUtc)}, type ${JOBS_COMMAND} in local `
    + `for your progress: ${items.join("; ")}`;
  return text.length <= opts.maxLine ? text : `${text.slice(0, opts.maxLine - ELLIPSIS.length)}${ELLIPSIS}`;
}

function formatDoneLine(job, opts) {
  const std = Number(job.standingMicro) > 0
    ? `, standing +${(job.standingMicro / MICRO).toFixed(STANDING_DECIMALS)}` : "";
  const text = `Front job done: ${job.description}. Reward ${rewardText(job)}${std} (paid shortly).`;
  return text.length <= opts.maxLine ? text : `${text.slice(0, opts.maxLine - ELLIPSIS.length)}${ELLIPSIS}`;
}

module.exports = { formatBoardReply, formatJobsRefusal, formatBoardMailLine, formatDoneLine, groupDigits, rewardText };
