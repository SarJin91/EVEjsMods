"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { MS_PER_HOUR, OWNER, OUTCOME } = require("../schema");
const { siteTemplatesOf } = require("../siteTemplates");

const TYPE = "SITE";
const SLOT = 0;
const PARAM_KEYS = Object.freeze(["site", "place", "hours"]);
const RETRY_REFUSALS = Object.freeze(["SITES_FULL", "SYSTEM_WINDOW_FULL"]);
const LIVE_STATES = Object.freeze(["CREATING", "ACTIVE", "LOST"]);
const MAX_SITE_KIND_PER_THREAD = 3;
const WON_STATE = "COMPLETED";
const CLEANUP_REASON = "EVENT_CANCELLED";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function safeCall(fn, fallback) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function runningSites(getSites) {
  const s = safeCall(getSites, null);
  if (!s || typeof s.createSiteInTx !== "function") return null;
  if (typeof s.getStatus !== "function") return s;
  const st = safeCall(() => s.getStatus(), null);
  return st && st.state === "running" ? s : null;
}

function createSiteStep(deps) {
  const { getSites, S } = deps;
  const minHours = S.siteMinHours;
  const maxHours = S.siteMaxHours;
  return Object.freeze({
    type: TYPE,
    owner: OWNER,
    version: 1,
    promptHint: "SITE: a combat or exploration site of the arc at a place, cleared = won (params place, hours)",
    maxPerThread: Math.min(MAX_SITE_KIND_PER_THREAD, Math.max(1, S.maxSiteStepsPerThread)),
    duration: Object.freeze({ minMs: minHours * MS_PER_HOUR, maxMs: maxHours * MS_PER_HOUR }),
    validate(params, v) {
      if (Object.keys(params).some((k) => !PARAM_KEYS.includes(k))) return { ok: false, reason: "UNKNOWN_PARAM" };
      const arc = v && v.arc;
      if (!arc || typeof arc.siteTemplate !== "string") return { ok: false, reason: "NO_SITE" };
      if (params.site !== undefined && params.site !== arc.siteTemplate) return { ok: false, reason: "SITE" };
      let systemId = null;
      if (params.place !== undefined) {
        const places = v.offer && Array.isArray(v.offer.places) ? v.offer.places : [];
        const place = places.find((p) => p.ref === params.place);
        if (!place) return { ok: false, reason: "PLACE" };
        systemId = place.systemId;
      }
      if (!Number.isFinite(params.hours)) return { ok: false, reason: "HOURS" };
      const hours = Math.min(maxHours, Math.max(minHours, Math.round(params.hours)));
      return { ok: true, params: { site: arc.siteTemplate, systemId, hours, label: arc.labelNoun } };
    },
    startInTx(tx, s) {
      const sites = runningSites(getSites);
      if (!sites) return { ok: false, reason: "SITES_OFF", retry: true };
      const p = s.params || {};
      const templates = siteTemplatesOf(p.site, s.factionId);
      if (templates.length === 0) return { ok: false, reason: "NO_TEMPLATE", retry: false };
      const templateId = templates[createRng(deriveSeed(s.seed, "site", s.stepNo)).nextInt(0, templates.length - 1)];
      const systemId = isId(p.systemId) ? p.systemId : s.systemId;
      const expiresAt = s.now + p.hours * MS_PER_HOUR;
      const r = sites.createSiteInTx(tx, { eventId: s.stepKey, slot: SLOT, systemId, templateId, label: p.label,
        factionId: isId(s.factionId) ? s.factionId : null, expiresAt });
      if (r && r.ok === true) {
        return { ok: true, handle: { siteKey: r.siteKey, systemId, expiresAt }, dueAt: s.now };
      }
      const reason = String((r && r.reason) || "NO_RESULT");
      return { ok: false, reason, retry: RETRY_REFUSALS.includes(reason) };
    },
    pollInTx(tx, s) {
      const sites = safeCall(getSites, null);
      if (!sites || typeof sites.listSitesByEvent !== "function") return { state: "RUNNING", dueAt: s.now };
      const r = sites.listSitesByEvent(s.stepKey, tx);
      if (!r || r.ok !== true || !Array.isArray(r.sites)) return { state: "RUNNING", dueAt: s.now };
      const site = r.sites.find((x) => x && x.slot === SLOT) || null;
      if (site && site.state === WON_STATE) return { state: "DONE", outcome: OUTCOME.WON };
      const h = s.handle || {};
      const expiresAt = Number.isSafeInteger(h.expiresAt) ? h.expiresAt
        : (site && Number.isSafeInteger(site.expiresAt) ? site.expiresAt : s.now);
      if (s.now >= expiresAt) return { state: "DONE", outcome: OUTCOME.LOST };
      if (site && LIVE_STATES.includes(site.state)) return { state: "RUNNING", dueAt: s.now };
      return { state: "DONE", outcome: OUTCOME.LOST };
    },
    cancelInTx(tx, s) {
      const sites = safeCall(getSites, null);
      if (!sites || typeof sites.cleanupSitesInTx !== "function") return { ok: false };
      const r = sites.cleanupSitesInTx(tx, s.stepKey, CLEANUP_REASON);
      return { ok: Boolean(r && r.ok === true) };
    },
  });
}

module.exports = { createSiteStep, runningSites };
