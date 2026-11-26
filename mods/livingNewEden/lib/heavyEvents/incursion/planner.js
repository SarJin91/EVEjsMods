"use strict";

const { deriveSeed } = require("../../util/rng");
const S = require("../schema");
const W = require("../world/schema");
const PC = require("../power/catalog");
const { isWorldVariant } = require("../world/catalog");
const { capPeak } = require("../power/planner");
const { endInTx, Rollback } = require("../planner");
const { LAYER, layerOfEventId } = require("../layer");
const { incursionLabelOf } = require("./label");

const SITE_SLOT = 0;
const MAX_ID_LENGTH = 64;
const SAVEPOINT_ABORT = Symbol("heavyEvents.incursion.savepoint");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true || typeof tx.transaction !== "function";

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
};

const savepoints = new WeakMap();
function inSavepoint(tx, fn) {
  let runIn = savepoints.get(tx);
  if (!runIn) {
    runIn = tx.transaction((body, holder) => {
      const r = body();
      if (!r || r.ok !== true) {
        holder.refusal = r || { ok: false, reason: "OTHER" };
        throw SAVEPOINT_ABORT;
      }
      return r;
    });
    savepoints.set(tx, runIn);
  }
  const holder = { refusal: null };
  try {
    return runIn(fn, holder);
  } catch (err) {
    if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
    if (tx.inTransaction !== true) throw err;
    if (err instanceof Rollback) return { ok: false, reason: err.reason, detail: err.detail };
    return { ok: false, reason: "OTHER", detail: String((err && err.message) || err).slice(0, 160) };
  }
}

function planIncursionSiteInTx(tx, env, spec) {
  if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
  if (env.incursionEnabled !== true) return { ok: false, reason: "INCURSION_LAYER_OFF" };
  const s = spec || {};
  if (typeof s.eventId !== "string" || s.eventId.length > MAX_ID_LENGTH || /\s/.test(s.eventId)
    || layerOfEventId(s.eventId) !== LAYER.INCURSION) {
    return invalid("eventId");
  }
  if (!W.KINDS.includes(s.kind)) return invalid("kind");
  const type = W.MECHANIC_OF[s.kind];
  if (!isWorldVariant(type, s.kind)) return invalid("kind");
  if (!Number.isSafeInteger(s.tier) || s.tier < 1 || s.tier > W.TIER_COUNT) return invalid("tier");
  if (!isId(s.systemId) || !isId(s.factionId)) return invalid("ids");
  if (!(s.beneficiaryFactionId === null || isId(s.beneficiaryFactionId))) return invalid("beneficiaryFactionId");
  if (!isTime(s.at) || !isTime(s.expiresAt) || s.expiresAt <= s.at) return invalid("times");
  const existing = env.repo.getInTx(tx, s.eventId);
  if (!existing.ok) return existing;
  if (existing.row) return { ok: true, eventId: s.eventId, tier: existing.row.tier, duplicate: true };
  if (!env.world) return { ok: false, reason: "OTHER", detail: "NO_CONFIG" };
  const cfg = { ...env.world, maxUpscaleSteps: env.settings.maxUpscaleSteps };
  const candidate = capPeak({ eventType: type, tier: s.tier, variant: s.kind, funded: false }, cfg, null);
  if (!candidate) return { ok: false, reason: "SHIPS_CAP" };
  const members = PC.membersOf(type, candidate.tier, s.kind, cfg.maxUpscaleSteps, cfg);
  const siteKind = PC.visibilityOfPocket(type, candidate.tier, s.kind, 0, cfg);
  if (!members.ok || siteKind === null) return { ok: false, reason: "OTHER", detail: "CATALOG" };
  const seed = deriveSeed(env.worldSeed, s.eventId);
  const label = incursionLabelOf(safe(() => env.factionName(s.factionId), null), s.kind);
  const r = inSavepoint(tx, () => {
    const planned = env.repo.planInTx(tx, { eventId: s.eventId, planKey: s.eventId, eventType: type,
      tier: candidate.tier, systemId: s.systemId, factionId: s.factionId, beneficiaryFactionId: s.beneficiaryFactionId,
      stationId: null, members: members.members, funded: false, integrity: null, seed, at: s.at,
      expiresAt: s.expiresAt, dueAt: s.expiresAt, variant: s.kind, affix: W.AFFIX_NONE });
    if (!planned.ok) return planned;
    if (planned.duplicate) return { ok: false, reason: "PLAN_DUPLICATE" };
    const sites = safe(() => env.getSites(), null);
    if (!sites || typeof sites.createSiteInTx !== "function") return { ok: false, reason: "SITES_UNAVAILABLE" };
    const site = sites.createSiteInTx(tx, { eventId: s.eventId, slot: SITE_SLOT, systemId: s.systemId,
      templateId: env.settings.beaconTemplateId, label, factionId: s.factionId,
      expiresAt: s.expiresAt + env.settings.engagedMaxMs + env.settings.aftermathMs, siteKind });
    if (!site || site.ok !== true) return { ok: false, reason: (site && site.reason) || "SITE_REFUSED" };
    return { ok: true };
  });
  if (!r || r.ok !== true) return r || { ok: false, reason: "OTHER" };
  return { ok: true, eventId: s.eventId, tier: candidate.tier };
}

function cancelIncursionSiteInTx(tx, env, spec) {
  if (txMissing(tx)) return { ok: false, reason: "TX_REQUIRED" };
  const s = spec || {};
  if (typeof s.eventId !== "string" || layerOfEventId(s.eventId) !== LAYER.INCURSION) return invalid("eventId");
  if (!isTime(s.at)) return invalid("at");
  const got = env.repo.getInTx(tx, s.eventId);
  if (!got.ok) return got;
  const row = got.row;
  if (!row || (row.state !== S.STATE.PLANNED && row.state !== S.STATE.ENGAGED)) return { ok: true, cancelled: false };
  const r = inSavepoint(tx, () => {
    const end = endInTx(tx, env, row, { to: S.STATE.CANCELLED, reason: S.END_REASON.CANCELLED }, s.at);
    return { ok: true, duplicate: end.duplicate === true };
  });
  if (!r || r.ok !== true) return r || { ok: false, reason: "OTHER" };
  return { ok: true, cancelled: r.duplicate !== true };
}

module.exports = { planIncursionSiteInTx, cancelIncursionSiteInTx };
