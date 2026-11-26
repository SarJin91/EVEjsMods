"use strict";

const { projectFactionKey, isFailure, REASON_PROJECTED } = require("./projection");

const WRAPPED_SITE_PROJECTION = Symbol.for("livingNewEden.siteProjectionWrapped");
const REASON_SITE_PROJECTED = REASON_PROJECTED;
const REASON_FAILED = "FAILED";
const VENDOR_PREFIX = "VENDOR_";

function isSiteFailure(reason) {
  return isFailure(reason) || (typeof reason === "string" && reason.startsWith(VENDOR_PREFIX));
}

function isExplicit(options) {
  if (options === null || typeof options !== "object") return false;
  const resolution = options.localPirateFactionResolution;
  if (resolution && typeof resolution === "object") return true;
  return typeof options.localPirateFactionKey === "string" && options.localPirateFactionKey.length > 0;
}

function decideSiteFaction(systemId, options, deps) {
  if (isExplicit(options)) return { key: null, reason: "EXPLICIT_OVERRIDE" };
  const id = Math.trunc(Number(systemId));
  if (!Number.isSafeInteger(id) || id <= 0) return { key: null, reason: "BAD_SYSTEM_ID" };
  let vendor;
  try {
    vendor = deps.resolveVendorFaction(id);
  } catch (_err) {
    return { key: null, reason: `${VENDOR_PREFIX}THREW` };
  }
  if (!vendor || typeof vendor !== "object") return { key: null, reason: `${VENDOR_PREFIX}NO_RESULT` };
  if (vendor.wormholeSpace === true) return { key: null, reason: "WORMHOLE" };
  if (vendor.specialSpace === true) return { key: null, reason: "SPECIAL_SPACE" };
  const projected = projectFactionKey(id, null, deps);
  if (!projected.key) return projected;
  if (projected.key === vendor.factionKey) return { key: null, reason: "SAME_AS_VENDOR" };
  return projected;
}

function wrapSitePolicyContext(originalFn, deps) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED_SITE_PROJECTION] === true) return { ok: true, wrapped: originalFn, noop: true };
  const d = deps || {};
  const table = d.pirateKeyByFactionId;
  if (table === null || typeof table !== "object") return { ok: false, reason: "PIRATE_TABLE_INVALID" };
  if (typeof d.readController !== "function") return { ok: false, reason: "READ_CONTROLLER_NOT_A_FUNCTION" };
  if (typeof d.resolveVendorFaction !== "function") return { ok: false, reason: "VENDOR_RESOLVER_NOT_A_FUNCTION" };
  const onOutcome = typeof d.onOutcome === "function" ? d.onOutcome : null;
  const decisionDeps = Object.freeze({
    pirateKeyByFactionId: table, readController: d.readController, resolveVendorFaction: d.resolveVendorFaction,
  });

  function livingNewEdenProjectedSitePolicyContext(systemID, options) {
    let decision;
    try {
      decision = decideSiteFaction(systemID, options, decisionDeps);
    } catch (_err) {
      decision = { key: null, reason: REASON_FAILED };
    }
    if (onOutcome) {
      try {
        onOutcome(decision.key ? "projected" : (isSiteFailure(decision.reason) ? "failed" : "vendor"), decision.reason);
      } catch (_err) {
      }
    }
    if (decision.key) {
      return originalFn.call(this, systemID, { ...(options || {}), localPirateFactionKey: decision.key });
    }
    return originalFn.apply(this, arguments);
  }

  livingNewEdenProjectedSitePolicyContext[WRAPPED_SITE_PROJECTION] = true;
  return { ok: true, wrapped: livingNewEdenProjectedSitePolicyContext };
}

module.exports = {
  decideSiteFaction, wrapSitePolicyContext, isSiteFailure, WRAPPED_SITE_PROJECTION, REASON_SITE_PROJECTED,
};
