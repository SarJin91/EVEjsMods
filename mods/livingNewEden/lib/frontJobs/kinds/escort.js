"use strict";

const { KIND } = require("../schema");
const { issuerOf, drawUpTo } = require("../rules");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function pickEscortCandidatesInTx(tx, fronts, deps, rng, limit) {
  if (!isId(limit)) return { ok: true, candidates: [] };
  const logistics = deps && deps.logistics;
  if (!logistics || typeof logistics.readOpen !== "function") {
    return { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: "no readOpen" };
  }
  const issuers = new Set();
  for (const f of Array.isArray(fronts) ? fronts : []) {
    const issuer = issuerOf(f);
    if (issuer !== null) issuers.add(issuer);
  }
  const regionOf = typeof deps.regionOf === "function" ? deps.regionOf : () => null;
  const P = deps.params;
  const out = [];
  for (const issuer of [...issuers].sort((a, b) => a - b)) {
    const r = logistics.readOpen(tx, issuer, { limit: 1 });
    if (!r || r.ok !== true) {
      return { ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: String((r && r.reason) || "no result") };
    }
    const first = Array.isArray(r.convoys) ? r.convoys[0] : null;
    if (!first || !isId(first.destSystemId)) continue;
    const regionId = regionOf(first.destSystemId);
    out.push({ kind: KIND.ESCORT, issuerFactionId: issuer, targetFactionId: null, systemId: first.destSystemId,
      regionId: isId(regionId) ? regionId : null, targetCount: P.escortTarget, ref: null,
      maxCompletions: P.escortMaxCompletions });
  }
  return { ok: true, candidates: drawUpTo(out, limit, rng) };
}

module.exports = { pickEscortCandidatesInTx };
