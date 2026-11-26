"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { KIND, JOB_STATE, jobIdOf } = require("./schema");
const { boardDayOf, boardWindowOf, pickJobs, rewardOf, descriptionOf } = require("./rules");
const { pickClearCandidatesInTx } = require("./kinds/clear");
const { pickDeliverCandidatesInTx } = require("./kinds/deliver");
const { pickScanCandidates } = require("./kinds/scan");
const { pickEscortCandidatesInTx } = require("./kinds/escort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function readFronts(tx, worldRepository, scanLimit) {
  const fronts = [];
  let after = 0;
  let remaining = scanLimit;
  while (remaining > 0) {
    const page = worldRepository.listActiveOccupations(tx, { afterSystemId: after, limit: remaining });
    if (!page || page.ok !== true) return { ok: false, detail: String((page && page.reason) || "no result") };
    for (const s of page.systems) fronts.push(s);
    remaining -= page.systems.length;
    if (page.nextAfterSystemId === null || page.systems.length === 0) break;
    after = page.nextAfterSystemId;
  }
  return { ok: true, fronts };
}

function ensureBoardInTx(tx, deps, now) {
  if (!Number.isSafeInteger(now) || now < 0) return { ok: false, reason: "INVALID_INPUT", detail: "now" };
  const P = deps.params;
  const day = boardDayOf(now, P.resetHourUtc);
  if (!Number.isSafeInteger(day) || day < 0) return { ok: false, reason: "INVALID_INPUT", detail: "day" };
  const existing = deps.repo.countJobsOfDayInTx(tx, day);
  if (!existing.ok) return { ok: false, reason: "INVALID_INPUT", detail: existing.detail };
  if (existing.count > 0) return { ok: true, created: 0, day, existing: true };
  const worldRepository = typeof deps.getWorldRepository === "function" ? deps.getWorldRepository() : null;
  if (!worldRepository || typeof worldRepository.listActiveOccupations !== "function") {
    return { ok: false, reason: "WORLD_UNAVAILABLE" };
  }
  const read = readFronts(tx, worldRepository, P.frontScanLimit);
  if (!read.ok) return { ok: false, reason: "WORLD_UNAVAILABLE", detail: read.detail };
  const regionOf = typeof deps.regionOf === "function" ? deps.regionOf : () => null;
  const fronts = read.fronts.map((s) => ({ systemId: s.systemId, regionId: regionOf(s.systemId),
    controllerFactionId: s.controllerFactionId, occupierFactionId: s.occupierFactionId,
    previousControllerFactionId: s.previousControllerFactionId, occupationState: s.occupationState }));
  const rng = createRng(deriveSeed(deps.worldSeed, "frontJobs", day));
  const kills = pickJobs(fronts, P, rng, (f) => isId(deps.lpCorpOf(f)));
  const special = pickSpecialsInTx(tx, fronts, deps, day, now);
  const picks = [...kills.slice(0, Math.max(0, P.jobsPerDay - special.candidates.length)), ...special.candidates]
    .map((p, slot) => ({ ...p, slot }));
  const { endMs } = boardWindowOf(day, P.resetHourUtc);
  const created = [];
  for (const p of picks) {
    const reward = rewardOf(p.kind, p.issuerFactionId, { ...P, lpCorpOf: deps.lpCorpOf });
    const job = { jobId: jobIdOf(day, p.slot, now), day, slot: p.slot, kind: p.kind, state: JOB_STATE.OPEN,
      issuerFactionId: p.issuerFactionId, targetFactionId: p.targetFactionId, systemId: p.systemId,
      regionId: p.regionId, targetCount: p.targetCount, ref: typeof p.ref === "string" ? p.ref : null, ...reward,
      maxCompletions: p.kind === KIND.KILL ? P.maxCompletionsPerJob : p.maxCompletions,
      description: descriptionOf(p, deps.names || null), createdAt: now, expiresAt: endMs };
    const r = deps.repo.insertJobInTx(tx, job);
    if (!r.ok) throw new Error(`frontJobs: job row refused - ${r.detail || r.reason}`);
    created.push(job);
  }
  if (created.length > 0 && deps.notices && typeof deps.notices.boardInTx === "function") {
    deps.notices.boardInTx(tx, { day, createdAt: now, jobs: created });
  }
  return { ok: true, created: picks.length, day, ...(special.refusals.length > 0 ? { refusals: special.refusals } : {}) };
}

function pickSpecialsInTx(tx, fronts, deps, day, now) {
  const P = deps.params;
  const candidates = [];
  const refusals = [];
  const take = (kind, fn) => {
    try {
      const r = fn(createRng(deriveSeed(deps.worldSeed, `frontJobs.${kind}`, day)));
      if (r && r.ok === true) candidates.push(...r.candidates);
      else refusals.push(`${kind}:${(r && r.reason) || "NO_RESULT"}`);
    } catch (err) {
      refusals.push(`${kind}:THREW ${String((err && err.message) || err).slice(0, 120)}`);
    }
  };
  if (P.clearEnabled === true && P.maxClearPerDay > 0 && deps.sites) {
    take(KIND.CLEAR, (rng) => pickClearCandidatesInTx(tx, fronts, deps, rng, P.maxClearPerDay));
  }
  if (P.deliverEnabled === true && P.maxDeliverPerDay > 0 && deps.offers) {
    take(KIND.DELIVER, (rng) => pickDeliverCandidatesInTx(tx, fronts, deps, rng, P.maxDeliverPerDay, now));
  }
  if (P.scanEnabled === true && P.maxScanPerDay > 0) {
    let mounted = false;
    try {
      mounted = typeof deps.scanWrapMounted === "function" && deps.scanWrapMounted() === true;
    } catch (_err) {
      mounted = false;
    }
    if (mounted) take(KIND.SCAN, (rng) => pickScanCandidates(fronts, P, rng, P.maxScanPerDay));
    else refusals.push(`${KIND.SCAN}:NO_WRAP`);
  }
  if (P.escortEnabled === true && P.maxEscortPerDay > 0 && deps.logistics) {
    take(KIND.ESCORT, (rng) => pickEscortCandidatesInTx(tx, fronts, deps, rng, P.maxEscortPerDay));
  }
  return { candidates: candidates.slice(0, P.jobsPerDay), refusals };
}

module.exports = { ensureBoardInTx };
