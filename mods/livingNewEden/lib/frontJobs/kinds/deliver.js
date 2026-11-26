"use strict";

const T = require("../../strategy/data/tradeStates");
const { KIND, JOB_STATE } = require("../schema");
const { issuerOf, drawUpTo } = require("../rules");
const { applyContributionInTx } = require("../progress");
const { refTimeBefore } = require("./clear");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const WAIT_STATES = Object.freeze([T.PLANNED, T.ISSUING, T.OPEN]);
const ACCEPTED_STATES = Object.freeze([T.ACCEPTED, T.INTAKE, T.DELIVERED]);
const CONTRACT = "contract";

function must(r, what) {
  if (!r || r.ok !== true) throw new Error(`frontJobs: ${what} - ${(r && (r.detail || r.reason)) || "no result"}`);
  return r;
}

function offerable(o, now) {
  return Boolean(o) && o.state === T.OPEN && o.channel === CONTRACT && o.side !== T.SIDE_SELL
    && (o.assigneeCharacterId === null || o.assigneeCharacterId === undefined) && typeof o.offerId === "string"
    && isId(o.systemId) && isId(o.typeId) && isId(o.quantity) && !(Number.isSafeInteger(o.expiresAt) && o.expiresAt <= now);
}

function pickDeliverCandidatesInTx(tx, fronts, deps, rng, limit, now) {
  if (!isId(limit) || !deps.offers) return { ok: true, candidates: [] };
  const issuers = [...new Set(fronts.map(issuerOf).filter(isId))].sort((a, b) => a - b);
  const regionOf = typeof deps.regionOf === "function" ? deps.regionOf : () => null;
  const isWarOffer = typeof deps.isWarOffer === "function" ? (offerId) => {
    try {
      return deps.isWarOffer(tx, offerId) !== false;
    } catch (_err) {
      return true;
    }
  } : () => false;
  const all = [];
  for (const issuer of issuers) {
    const r = deps.offers.listOpenOfFaction(tx, issuer, deps.params.deliverScanLimit);
    if (!r || r.ok !== true) return { ok: false, reason: "OFFERS_UNAVAILABLE", detail: String((r && r.reason) || "") };
    for (const o of r.offers) if (offerable(o, now) && !isWarOffer(o.offerId)) all.push({ issuer, o });
  }
  all.sort((a, b) => (a.o.offerId < b.o.offerId ? -1 : a.o.offerId > b.o.offerId ? 1 : 0));
  const typeName = typeof deps.typeName === "function" ? deps.typeName : () => null;
  const candidates = drawUpTo(all, limit, rng).map(({ issuer, o }) => {
    const region = regionOf(o.systemId);
    return { kind: KIND.DELIVER, issuerFactionId: issuer, targetFactionId: null, systemId: o.systemId,
      regionId: isId(region) ? region : null, targetCount: 1, ref: o.offerId, maxCompletions: 1,
      typeId: o.typeId, quantity: o.quantity, typeName: typeName(o.typeId) };
  });
  return { ok: true, candidates };
}

function settleDeliverInTx(tx, job, deps, now) {
  const { repo } = deps;
  const current = must(repo.getJobInTx(tx, job.jobId), "job read").job;
  if (!current || current.state !== JOB_STATE.OPEN || current.kind !== KIND.DELIVER) {
    return { ok: true, outcome: "CLOSED" };
  }
  const late = now >= current.expiresAt;
  const read = deps.offers.getOffer(tx, current.ref);
  if (!read || read.ok !== true) {
    return { ok: false, reason: "OFFER_READ_FAILED", detail: String((read && read.reason) || "no result") };
  }
  const offer = read.offer;
  if (offer && WAIT_STATES.includes(offer.state)) return { ok: true, outcome: "WAIT" };
  if (offer && ACCEPTED_STATES.includes(offer.state) && isId(offer.acceptorCharacterId)) {
    const characterId = offer.acceptorCharacterId;
    const at = late ? refTimeBefore(offer.updatedAt, current.expiresAt) : now;
    if (at === null) return { ok: true, outcome: "WAIT" };
    const c = applyContributionInTx(tx, deps, { jobId: current.jobId, characterId, amount: 1, atMs: at });
    if (!c.ok) return c;
    if (c.outcome === "COMPLETED" || c.outcome === "ALREADY_DONE") {
      if (c.filled !== true) must(repo.closeJobInTx(tx, current.jobId, JOB_STATE.FILLED, now), "job filled");
      return { ok: true, outcome: "SETTLED", characterId };
    }
    must(repo.closeJobInTx(tx, current.jobId, JOB_STATE.EXPIRED, now), "job capped");
    return { ok: true, outcome: c.outcome === "DAILY_CAP" ? "DAILY_CAP" : "LOST", characterId };
  }
  if (late) return { ok: true, outcome: "WAIT" };
  must(repo.closeJobInTx(tx, current.jobId, JOB_STATE.EXPIRED, now), "job lost");
  return { ok: true, outcome: "LOST" };
}

module.exports = { pickDeliverCandidatesInTx, settleDeliverInTx };
