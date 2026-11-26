"use strict";

const { KIND, JOB_STATE, PROGRESS_STATE } = require("./schema");
const { boardWindowOf } = require("./rules");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function refused(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function must(r, what) {
  if (!r || r.ok !== true) throw new Error(`frontJobs: ${what} - ${(r && (r.detail || r.reason)) || "no result"}`);
  return r;
}

function applyContributionInTx(tx, deps, c) {
  if (!c || typeof c !== "object") return refused("contribution");
  if (typeof c.jobId !== "string" || c.jobId === "") return refused("jobId");
  if (!isId(c.characterId)) return refused("characterId");
  if (!isId(c.amount)) return refused("amount");
  if (!Number.isSafeInteger(c.atMs) || c.atMs < 0) return refused("atMs");
  const { repo, params } = deps;
  const got = repo.getJobInTx(tx, c.jobId);
  if (!got.ok) return refused(got.detail);
  const job = got.job;
  if (!job) return { ok: false, reason: "JOB_NOT_FOUND" };
  if (job.state !== JOB_STATE.OPEN) return { ok: true, outcome: "JOB_CLOSED" };
  if (c.atMs >= job.expiresAt) return { ok: true, outcome: "EXPIRED" };
  const prev = must(repo.getProgressInTx(tx, c.jobId, c.characterId), "progress read").progress;
  if (prev && prev.state === PROGRESS_STATE.DONE) return { ok: true, outcome: "ALREADY_DONE" };
  if (job.kind === KIND.CLEAR) {
    const cap = Number.isSafeInteger(params.clearMinKills) && params.clearMinKills > 0 ? params.clearMinKills : 1;
    const counted = Math.min(cap, (prev ? prev.progress : 0) + c.amount);
    must(repo.writeProgressInTx(tx, { jobId: c.jobId, characterId: c.characterId, progress: counted, at: c.atMs,
      state: PROGRESS_STATE.ACTIVE }), "progress write");
    return { ok: true, outcome: "PROGRESS", progress: counted };
  }
  const progress = Math.min(job.targetCount, (prev ? prev.progress : 0) + c.amount);
  if (progress < job.targetCount) {
    must(repo.writeProgressInTx(tx, { jobId: c.jobId, characterId: c.characterId, progress, at: c.atMs,
      state: PROGRESS_STATE.ACTIVE }), "progress write");
    return { ok: true, outcome: "PROGRESS", progress };
  }
  return completeInTx(tx, deps, job, c.characterId, c.atMs, progress);
}

function completeInTx(tx, deps, job, characterId, atMs, progress) {
  const { repo, params } = deps;
  const { startMs } = boardWindowOf(job.day, params.resetHourUtc);
  const done = must(repo.countDoneSinceInTx(tx, characterId, startMs), "done count").count;
  if (done >= params.maxCompletionsPerCharacterDay) return { ok: true, outcome: "DAILY_CAP", progress };
  must(repo.writeProgressInTx(tx, { jobId: job.jobId, characterId, progress, at: atMs, state: PROGRESS_STATE.DONE,
    doneAt: atMs }), "progress done");
  const completed = must(repo.completeJobInTx(tx, job.jobId, job.version, atMs), "job completion");
  const payout = must(repo.insertPayoutInTx(tx, job, characterId, atMs), "payout plan");
  if (deps.notices && typeof deps.notices.doneInTx === "function") {
    deps.notices.doneInTx(tx, job, { payoutKey: payout.payoutKey, characterId, atMs });
  }
  return { ok: true, outcome: "COMPLETED", progress, filled: completed.filled, payoutKey: payout.payoutKey };
}

module.exports = { applyContributionInTx, completeInTx };
