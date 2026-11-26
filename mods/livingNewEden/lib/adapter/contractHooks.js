"use strict";

const TAG_PREFIX = "[LNE:";

function isLneRecord(contract) {
  const description = contract && typeof contract === "object" ? contract.description : null;
  return typeof description === "string" && description.includes(TAG_PREFIX);
}

function wrapContractAccepted(notificationsExports, onAccepted) {
  if (!notificationsExports || typeof notificationsExports.notifyContractAccepted !== "function") {
    return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
  }

  if (notificationsExports._lneWrapped === true) {
    return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
  }

  const original = notificationsExports.notifyContractAccepted;
  let active = true;

  const wrapper = function (...args) {
    const result = original.apply(this, args);
    if (active) {
      try {
        if (isLneRecord(args[0]) && typeof onAccepted === "function") onAccepted(args[0]);
      } catch (_err) {
      }
    }
    return result;
  };

  wrapper._lneOriginal = original;
  notificationsExports._lneWrapped = true;
  notificationsExports.notifyContractAccepted = wrapper;

  return {
    ok: true,
    uninstall() {
      active = false;
      if (notificationsExports.notifyContractAccepted === wrapper) {
        notificationsExports.notifyContractAccepted = original;
      }
      notificationsExports._lneWrapped = false;
    },
  };
}

module.exports = { wrapContractAccepted, isLneRecord, TAG_PREFIX };
