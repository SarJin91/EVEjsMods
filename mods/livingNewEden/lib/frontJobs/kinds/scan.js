"use strict";

const { KIND } = require("../schema");
const { issuerOf, drawUpTo } = require("../rules");
const { applyContributionInTx } = require("../progress");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function pickScanCandidates(fronts, params, rng, limit) {
  if (!isId(limit)) return { ok: true, candidates: [] };
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(fronts) ? fronts : []) {
    if (!f || !isId(f.systemId) || seen.has(f.systemId)) continue;
    const issuer = issuerOf(f);
    if (issuer === null) continue;
    seen.add(f.systemId);
    out.push({ kind: KIND.SCAN, issuerFactionId: issuer, targetFactionId: null, systemId: f.systemId,
      regionId: isId(f.regionId) ? f.regionId : null, targetCount: 1, ref: null,
      maxCompletions: params.scanMaxCompletions });
  }
  out.sort((a, b) => a.systemId - b.systemId);
  return { ok: true, candidates: drawUpTo(out, limit, rng) };
}

function applyScanInTx(tx, deps, jobs, scan) {
  return jobs.map((e) => applyContributionInTx(tx, deps, { jobId: e.jobId, characterId: scan.characterId, amount: 1,
    atMs: scan.atMs }));
}

module.exports = { pickScanCandidates, applyScanInTx };
