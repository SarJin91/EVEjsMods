"use strict";

const { bfs } = require("../ai/bfs");
const { jobIdOf } = require("../../world/salvageSchema");
const D = require("../data/capsuleers");
const { fieldEligible } = require("./salvageRules");
const { CAPSULEER_ROLE } = require("./rattingRules");

const byRank = (a, b) => b.pool - a.pool || a.jumps - b.jumps || (a.fieldId < b.fieldId ? -1 : a.fieldId > b.fieldId
  ? 1 : 0);

function readSalvageTargets(db, input) {
  const out = { ok: true, fieldsBySlot: new Map(), openFieldIds: new Set(), seen: 0 };
  const p = input.params;
  const wrecks = input.wrecks;
  const repo = wrecks && wrecks.repository && typeof wrecks.repository.listUnmaterializedInSystem === "function"
    && typeof wrecks.effectivePool === "function" ? wrecks.repository : null;
  if (p.salvageEnabled !== true || !(p.maxSalvageDispatchesPerReview > 0) || !input.graph || !repo
    || input.tripsTruncated) return out;
  const salvage = input.salvage;
  const jobs = salvage && salvage.repository && typeof salvage.repository.getJob === "function"
    ? salvage.repository : null;
  const openTrips = input.openTrips || [];
  for (const t of openTrips) if (t.fieldId) out.openFieldIds.add(t.fieldId);
  const busy = new Set(openTrips.map((t) => t.fleetId));
  const graph = input.graph;
  const at = input.at;
  const rules = { salvageParams: input.salvageParams, capsuleerFactionId: D.CAPSULEER_FACTION_ID };
  const listed = new Map();
  for (const corp of [...input.corps].sort((a, b) => a.corpSlot - b.corpSlot)) {
    if (corp.state !== "ACTIVE" || !corp.corporationId) continue;
    const waiting = input.fleets.some((f) => f.fleetRole === CAPSULEER_ROLE && f.corporationId === corp.corporationId
      && f.state === "IDLE" && f.refitPending !== true && f.currentSystemId === corp.baseSystemId
      && !busy.has(f.fleetId));
    if (!waiting) continue;
    const reach = bfs([corp.baseSystemId], (id) => graph.getNeighbors(id), { maxJumps: p.salvageMaxJumps,
      maxSystems: p.salvageScanMaxSystems });
    const list = [];
    for (const [systemId, jumps] of reach) {
      if (jumps < 1) continue;
      let entries = listed.get(systemId);
      if (!entries) {
        const r = repo.listUnmaterializedInSystem(db, { systemId, at, limit: p.salvageFieldsPerSystem });
        if (!r || r.ok !== true) return r || { ok: false, reason: "WRECKS_READ_FAILED" };
        entries = [];
        for (const field of r.fields) {
          let job = null;
          if (jobs) {
            const j = jobs.getJob(db, jobIdOf(field.fieldId));
            if (!j || j.ok !== true) return j || { ok: false, reason: "SALVAGE_READ_FAILED" };
            job = j.job;
          }
          entries.push({ field, job, pool: wrecks.effectivePool(field, at).total });
        }
        out.seen += entries.length;
        listed.set(systemId, entries);
      }
      const eligible = entries.filter((e) => fieldEligible({ field: e.field, job: e.job, jobKnown: jobs !== null,
        pool: e.pool, jumps, at }, rules).ok);
      if (eligible.length === 0) continue;
      const q = input.quietOf(systemId);
      if (!q || q.ok !== true) return q || { ok: false, reason: "FLEETS_READ_FAILED" };
      if (q.quiet !== true) continue;
      for (const e of eligible) list.push({ fieldId: e.field.fieldId, systemId, jumps, pool: e.pool });
    }
    out.fieldsBySlot.set(corp.corpSlot, list.sort(byRank));
  }
  return out;
}

module.exports = { readSalvageTargets };
