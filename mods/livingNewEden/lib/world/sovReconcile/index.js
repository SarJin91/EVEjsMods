"use strict";

const { createSovReconcileService, createUnavailableSovReconcile } = require("./service");
const { buildSovFactsView } = require("./factsView");
const { defaultSetTimer } = require("../../presence/poller");

const STATE_STOPPED = "stopped";
const VIEW_ID = "sov-facts";

function startSovReconcile(ctx) {
  try {
    const {
      config,
      persistence,
      adapter,
      virtualCorps,
      occupation,
      sovProjection,
      world,
      telemetry,
      logger,
      clock,
      getGovernor,
      fail,
      setTimer,
    } = ctx;

    if (config?.world?.sovReconcile?.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }

    const processRole = adapter && typeof adapter.getProcessRole === "function"
      ? adapter.getProcessRole()
      : "unknown";
    if (processRole !== "world") {
      return { ok: false, reason: "not_world_process" };
    }

    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!adapter || typeof adapter.getSovNative !== "function") {
      return { ok: false, reason: "dependency_disabled:adapter" };
    }
    if (!virtualCorps || typeof virtualCorps.isVirtualAlliance !== "function" || typeof virtualCorps.whenReady !== "function") {
      return { ok: false, reason: "dependency_disabled:virtualCorps" };
    }
    if (!occupation || typeof occupation.abandonInTx !== "function" || typeof occupation.dropInfluenceInTx !== "function") {
      return { ok: false, reason: "dependency_disabled:occupation" };
    }
    if (!sovProjection || typeof sovProjection.getStatus !== "function" || typeof sovProjection.isProjecting !== "function") {
      return { ok: false, reason: "dependency_disabled:sovProjection" };
    }
    if (!telemetry) {
      return { ok: false, reason: "dependency_disabled:telemetry" };
    }
    if (!world || !world.repository || typeof world.repository.isApplied !== "function"
      || typeof world.repository.getSystem !== "function") {
      return { ok: false, reason: "dependency_disabled:world" };
    }

    const sovNative = adapter.getSovNative();
    const seamCheck = sovNative.checkSovNativeSeams();
    if (!seamCheck.ok) {
      logger?.log?.(`[sovReconcile] native sov seams unavailable: ${seamCheck.reason}${seamCheck.missing ? " (" + seamCheck.missing.join(", ") + ")" : ""}`);
      return { ok: false, reason: "SOV_SEAM_UNAVAILABLE", detail: seamCheck };
    }

    const service = createSovReconcileService({
      store: persistence.store,
      repository: world.repository,
      journal: persistence.journal,
      clock,
      occupation,
      virtualCorps,
      sovProjection,
      adapter,
      config,
      telemetry,
      logger,
      getGovernor,
      fail,
      setTimer: setTimer || defaultSetTimer,
      coreIndex: ctx.coreIndex,
    });

    const startRes = service.start();
    if (!startRes.ok) {
      return { ok: false, reason: startRes.reason };
    }

    ctx.sovReconcile = service;

    const views = ctx.views;
    if (views && typeof views.registerView === "function") {
      const viewDef = buildSovFactsView({
        store: persistence.store,
        journal: persistence.journal,
        config,
        getGovernor,
      });
      const r = views.registerView(VIEW_ID, viewDef);
      if (r && r.ok) {
        logger?.log?.(`[sovReconcile] view ${VIEW_ID} registered`);
      } else {
        logger?.log?.(`[sovReconcile] view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
      }
    }

    logger?.log?.(`[sovReconcile] started`);

    return { ok: true, service };
  } catch (err) {
    return { ok: false, reason: "SOV_RECONCILE_START_FAILED", detail: String(err) };
  }
}

function stopSovReconcile(ctx) {
  const service = ctx.sovReconcile;
  if (service && typeof service.stop === "function") {
    service.stop("service_stop");
  }
  ctx.sovReconcile = createUnavailableSovReconcile("stopped");
}

module.exports = {
  startSovReconcile,
  stopSovReconcile,
  createUnavailableSovReconcile,
};