"use strict";

const { deriveSeed, deterministicUnit, createRng } = require("../util/rng");
const { UNKNOWN } = require("../names/fallback");

const MAX_LINE = 400;
const ELLIPSIS = "...";

const LEAD_BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const CAP_KEYS = Object.freeze({ highsec: "maxDedHighsec", lowsec: "maxDedLowsec", nullsec: "maxDedNullsec" });

const intOr = (v, fallback) => (Number.isInteger(v) ? v : fallback);

function capOf(P, secClass) {
  if (!Object.prototype.hasOwnProperty.call(CAP_KEYS, secClass)) return 0;
  const cap = P ? P[CAP_KEYS[secClass]] : 0;
  return Number.isInteger(cap) && cap > 0 ? cap : 0;
}

function rollOf(worldSeed, completion, chance) {
  const seed = deriveSeed(worldSeed, "escalations", completion.instanceId, completion.completedAtMs);
  const unit = deterministicUnit(seed, "roll");
  return { hit: typeof chance === "number" && unit < chance, seed, unit };
}

function targetCandidatesOf(graph, sourceSystemId, P) {
  if (!graph || typeof graph.getNeighbors !== "function" || typeof graph.getSystem !== "function") return [];
  const source = Number(sourceSystemId);
  if (!Array.isArray(graph.getNeighbors(source))) return [];
  const maxJumps = Math.max(0, intOr(P && P.maxJumps, 0));
  const minJumps = Math.max(1, Math.min(intOr(P && P.minJumps, 1), maxJumps));
  const seen = new Set([source]);
  const out = [];
  let frontier = [source];
  for (let d = 1; d <= maxJumps && frontier.length > 0; d += 1) {
    const next = [];
    for (const id of frontier) {
      for (const n of graph.getNeighbors(id) || []) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
        if (d < minJumps) continue;
        const system = graph.getSystem(n);
        const secClass = system ? system.secClass : null;
        if (capOf(P, secClass) > 0) out.push({ systemId: n, jumps: d, secClass });
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId);
}

function templatesFor(catalog, factionId, secClass, P) {
  const cap = capOf(P, secClass);
  if (cap <= 0 || !Array.isArray(catalog)) return Object.freeze([]);
  const band = catalog.filter((t) => t && Array.isArray(t.bands) && t.bands.includes(secClass) && t.dedRating <= cap)
    .sort((a, b) => (a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0));
  if (P && P.matchFaction === true && factionId !== null && factionId !== undefined) {
    const own = band.filter((t) => t.factionId === factionId);
    if (own.length > 0) return Object.freeze(own);
  }
  return Object.freeze(band);
}

function planEscalation(graph, catalog, completion, seed, P) {
  const byBand = new Map();
  const templatesOf = (secClass) => {
    if (!byBand.has(secClass)) byBand.set(secClass, templatesFor(catalog, completion.factionId, secClass, P));
    return byBand.get(secClass);
  };
  const pool = targetCandidatesOf(graph, completion.systemId, P).filter((t) => templatesOf(t.secClass).length > 0);
  if (pool.length === 0) return { ok: false, reason: "NO_TARGET" };
  const maxAttempts = Math.max(1, intOr(P && P.maxTargetAttempts, 1));
  const rng = createRng(deriveSeed(seed, "plan"));
  const attempts = [];
  while (attempts.length < maxAttempts && pool.length > 0) {
    const target = rng.pick(pool);
    pool.splice(pool.indexOf(target), 1);
    const template = rng.pick(templatesOf(target.secClass));
    attempts.push({ systemId: target.systemId, jumps: target.jumps, secClass: target.secClass,
      templateId: template.templateId, dedRating: template.dedRating, name: template.name });
  }
  return { ok: true, attempts };
}

function nameOf(value, _fallbackId) {
  if (typeof value === "string" && value.trim() !== "") return value.replace(/\s+/g, " ").trim();
  return UNKNOWN.system;
}

function eveTimeOf(ms) {
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return "unknown time";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

function formatLeadLine(attempt, sourceName, targetName, expiresAt) {
  const jumps = attempt.jumps === 1 ? "1 jump" : `${attempt.jumps} jumps`;
  const text = `Escalation lead (DED ${attempt.dedRating}): ${attempt.name} in ${nameOf(targetName, attempt.systemId)} `
    + `(${attempt.secClass}, ${jumps} from ${nameOf(sourceName, "?")}). Scan the signature down before `
    + `${eveTimeOf(expiresAt)} EVE time.`;
  return text.length <= MAX_LINE ? text : `${text.slice(0, MAX_LINE - ELLIPSIS.length)}${ELLIPSIS}`;
}

module.exports = {
  MAX_LINE,
  LEAD_BANDS,
  rollOf,
  targetCandidatesOf,
  templatesFor,
  planEscalation,
  formatLeadLine,
};
