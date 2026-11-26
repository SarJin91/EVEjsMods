"use strict";

const { STATE: SITE_STATE } = require("../../events/sites/schema");
const { KIND, JOB_STATE } = require("../schema");
const { issuerOf, drawUpTo } = require("../rules");
const { completeInTx } = require("../progress");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const WAIT_STATES = Object.freeze([SITE_STATE.CREATING, SITE_STATE.ACTIVE]);

function refTimeBefore(updatedAt, expiresAt) {
  const t = updatedAt === null || updatedAt === undefined ? NaN : Number(updatedAt);
  return Number.isSafeInteger(t) && t >= 0 && t < expiresAt ? t : null;
}

function must(r, what) {
  if (!r || r.ok !== true) throw new Error(`frontJobs: ${what} - ${(r && (r.detail || r.reason)) || "no result"}`);
  return r;
}

function pickClearCandidatesInTx(tx, fronts, deps, rng, limit) {
  if (!isId(limit) || !deps.sites) return { ok: true, candidates: [] };
  const P = deps.params;
  const seen = new Set();
  const out = [];
  for (const f of fronts) {
    if (!f || !isId(f.systemId) || seen.has(f.systemId)) continue;
    const issuer = issuerOf(f);
    if (issuer === null) continue;
    seen.add(f.systemId);
    const site = deps.sites.listVisibleBySystemInTx(tx, f.systemId, P.clearSiteScanLimit)
      .find((s) => s && s.state === SITE_STATE.ACTIVE);
    if (!site) continue;
    out.push({ kind: KIND.CLEAR, issuerFactionId: issuer, targetFactionId: isId(site.factionId) ? site.factionId : null,
      systemId: f.systemId, regionId: isId(f.regionId) ? f.regionId : null, targetCount: 1, ref: site.siteKey,
      maxCompletions: P.clearMaxCompletions, label: typeof site.label === "string" ? site.label : "" });
  }
  out.sort((a, b) => a.systemId - b.systemId);
  return { ok: true, candidates: drawUpTo(out, limit, rng) };
}

function settleClearInTx(tx, job, deps, now) {
  const { repo, params } = deps;
  let current = must(repo.getJobInTx(tx, job.jobId), "job read").job;
  if (!current || current.state !== JOB_STATE.OPEN || current.kind !== KIND.CLEAR) {
    return { ok: true, outcome: "CLOSED" };
  }
  const late = now >= current.expiresAt;
  const site = typeof current.ref === "string" && current.ref !== "" ? deps.sites.getByKeyInTx(tx, current.ref) : null;
  if (site && WAIT_STATES.includes(site.state)) return { ok: true, outcome: "WAIT" };
  if (!site || site.state !== SITE_STATE.COMPLETED) {
    if (late) return { ok: true, outcome: "WAIT" };
    must(repo.closeJobInTx(tx, current.jobId, JOB_STATE.EXPIRED, now), "job lost");
    return { ok: true, outcome: "LOST" };
  }
  const at = late ? refTimeBefore(site.updatedAt, current.expiresAt) : now;
  if (at === null) return { ok: true, outcome: "WAIT" };
  const eligible = must(repo.listEligibleProgressInTx(tx, current.jobId, params.clearMinKills), "eligible").rows;
  let completions = 0;
  let filled = false;
  for (const p of eligible) {
    if (current.completions >= current.maxCompletions) break;
    const r = completeInTx(tx, deps, current, p.characterId, at, p.progress);
    if (r.outcome !== "COMPLETED") continue;
    completions += 1;
    if (r.filled === true) {
      filled = true;
      break;
    }
    current = must(repo.getJobInTx(tx, current.jobId), "job read").job;
  }
  if (completions === 0) {
    must(repo.closeJobInTx(tx, current.jobId, JOB_STATE.EXPIRED, now), "job unclaimed");
    return { ok: true, outcome: "LOST", completions: 0 };
  }
  if (!filled) must(repo.closeJobInTx(tx, current.jobId, JOB_STATE.FILLED, now), "job filled");
  return { ok: true, outcome: "SETTLED", completions };
}

module.exports = { pickClearCandidatesInTx, settleClearInTx, refTimeBefore };
