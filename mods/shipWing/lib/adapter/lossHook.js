"use strict";

const WRAPPED = Symbol.for("shipWing.lossHook");
const EXPORT_NAME = "destroyShipEntityWithWreck";
const INSURANCE_SUPPRESSED_REASON = "shipWing";
const LOSS_TWIN_REMOVED = "SHIPWING_LOSS_TWIN_REMOVED";

function isObj(value) {
  return value !== null && typeof value === "object";
}

function createLossHook(deps) {
  const target = deps && deps.shipDestructionExports;
  const wing = deps && deps.wing;
  const adapter = deps && deps.adapter;
  const config = (deps && deps.config) || {};
  const defer = deps && typeof deps.defer === "function" ? deps.defer : queueMicrotask;
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;

  function hookError(err) {
    try {
      wing.noteLossHookError(err);
    } catch (_err) {
    }
  }

  function prepare(shipEntity, options) {
    if (wing.liveTwinCount() === 0) return null;
    const claim = wing.claimTwin(shipEntity);
    if (!claim) return null;
    const begun = wing.beginLoss(claim.shipItemId, { cause: "DESTROYED" });
    let hull = null;
    if (begun && begun.ok === true) {
      try {
        hull = adapter.lossHull(claim);
      } catch (err) {
        hookError(err);
        hull = null;
      }
    }
    const opts = { ...(isObj(options) ? options : {}) };
    if (config.lossSkipInsurance !== false) {
      opts.skipInsurance = true;
      opts.insuranceSuppressedReason = INSURANCE_SUPPRESSED_REASON;
    }
    if (begun && begun.ok === true && isObj(hull)) opts.shipRecord = hull;
    const prepared = {
      claim, begun: Boolean(begun && begun.ok === true), options: opts, restore: false, saved: undefined,
    };
    if (config.durableWreck !== false) {
      prepared.saved = shipEntity.transient;
      shipEntity.transient = false;
      prepared.restore = true;
    }
    return prepared;
  }

  function restore(shipEntity, prepared) {
    if (!prepared.restore) return;
    if (prepared.saved === undefined) delete shipEntity.transient;
    else shipEntity.transient = prepared.saved;
  }

  function sweepLater(prepared) {
    defer(() => {
      try {
        wing.sweepLossTwin(prepared.claim.shipItemId);
      } catch (err) {
        hookError(err);
      }
    });
  }

  function after(prepared, result) {
    if (!prepared.begun) return;
    if (!isObj(result) || result.success !== true) {
      sweepLater(prepared);
      return;
    }
    wing.sweepLossTwin(prepared.claim.shipItemId);
    const data = isObj(result.data) ? result.data : {};
    const wreckId = isObj(data.wreck) ? Number(data.wreck.itemID) || 0 : 0;
    const vendorChanges = [...(Array.isArray(data.movedChanges) ? data.movedChanges : []),
      ...(Array.isArray(data.destroyChanges) ? data.destroyChanges : [])];
    wing.settleLoss(prepared.claim.shipItemId, { wreckId, vendorChanges });
  }

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!target || typeof target[EXPORT_NAME] !== "function" || !wing || !adapter
      || typeof adapter.lossHull !== "function") {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    if (target[EXPORT_NAME][WRAPPED] === true) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    original = target[EXPORT_NAME];
    const base = original;
    wrapper = function shipWingLoss(systemID, shipEntity, options) {
      if (!active) return base.apply(this, arguments);
      let taken = false;
      try {
        taken = typeof wing.takeLossTwin === "function" && wing.takeLossTwin(shipEntity) === true;
      } catch (err) {
        hookError(err);
      }
      if (taken) return { success: false, errorMsg: LOSS_TWIN_REMOVED };
      let prepared = null;
      try {
        prepared = prepare(shipEntity, options);
      } catch (err) {
        hookError(err);
        prepared = null;
      }
      if (!prepared) return base.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      args[2] = prepared.options;
      let result;
      try {
        result = base.apply(this, args);
      } catch (err) {
        if (prepared.begun) {
          try {
            sweepLater(prepared);
          } catch (deferErr) {
            hookError(deferErr);
          }
        }
        throw err;
      } finally {
        try {
          restore(shipEntity, prepared);
        } catch (err) {
          hookError(err);
        }
      }
      try {
        after(prepared, result);
      } catch (err) {
        hookError(err);
      }
      return result;
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== WRAPPED) wrapper[symbol] = base[symbol];
    }
    wrapper[WRAPPED] = true;
    target[EXPORT_NAME] = wrapper;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && target && target[EXPORT_NAME] === wrapper) target[EXPORT_NAME] = original;
    installed = false;
  }

  return Object.freeze({ install, uninstall, isActive: () => active });
}

function installLossHookFromGame(gameAdapter, deps) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("loss")) {
    return { ok: false, reason: "probe_loss_unavailable" };
  }
  const live = deps && deps.adapter;
  if (!live || typeof live.lossAvailable !== "function" || live.lossAvailable() !== true) {
    return { ok: false, reason: "loss_accessors_unavailable" };
  }
  const loaded = gameAdapter.requireGame("space/shipDestruction");
  if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${loaded && loaded.reason}` };
  const hook = createLossHook({ ...deps, shipDestructionExports: loaded.exports });
  const installed = hook.install();
  return installed.ok ? { ok: true, hook } : { ok: false, reason: installed.reason };
}

module.exports = {
  WRAPPED, EXPORT_NAME, INSURANCE_SUPPRESSED_REASON, LOSS_TWIN_REMOVED, createLossHook, installLossHookFromGame,
};
