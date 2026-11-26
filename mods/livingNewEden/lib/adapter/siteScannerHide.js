"use strict";

const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function createSiteScannerHide(deps) {
  const providerExports = deps && deps.providerExports;
  const scanMgr = deps && deps.scanMgr;
  const maxHidden = deps && isPositiveInt(deps.maxHidden) ? deps.maxHidden : 1;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const hidden = new Map();
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!providerExports || typeof providerExports.listAnomalySites !== "function") {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    if (providerExports._lneWrapped === true) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    original = providerExports.listAnomalySites;
    const base = original;
    wrapper = function (...args) {
      const out = base.apply(this, args);
      if (!active || hidden.size === 0 || !Array.isArray(out)) return out;
      try {
        return out.filter((site) => !hidden.has(Number(site && site.siteID)));
      } catch (_err) {
        return out;
      }
    };
    wrapper._lneOriginal = original;
    providerExports._lneWrapped = true;
    providerExports.listAnomalySites = wrapper;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && providerExports && providerExports.listAnomalySites === wrapper) {
      providerExports.listAnomalySites = original;
    }
    if (installed && providerExports) providerExports._lneWrapped = false;
    installed = false;
    hidden.clear();
  }

  function hide(systemId, siteId) {
    if (!installed || !active) return { ok: false, reason: "NOT_INSTALLED" };
    if (!isPositiveInt(systemId) || !isPositiveInt(siteId)) return { ok: false, reason: "HIDE_INVALID" };
    if (!hidden.has(siteId)) hidden.set(siteId, systemId);
    while (hidden.size > maxHidden) hidden.delete(hidden.keys().next().value);
    let notified = false;
    try {
      if (scanMgr && typeof scanMgr.notifyAnomalyDeltaForSystem === "function") {
        scanMgr.notifyAnomalyDeltaForSystem(systemId);
        notified = true;
      }
    } catch (err) {
      log(`sites: scanner delta of system ${systemId} failed - ${messageOf(err)}`);
    }
    return { ok: true, notified };
  }

  function forget(siteId) {
    hidden.delete(siteId);
  }

  return Object.freeze({ install, uninstall, hide, forget, size: () => hidden.size });
}

module.exports = { createSiteScannerHide };
