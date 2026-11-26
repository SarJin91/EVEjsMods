"use strict";

const { metricSuffix } = require("../../adapter/sovProjection");

async function onControllerChanged(change, ctx) {
  const { sovProjection, logger, telemetry } = ctx;

  if (!change || !Number.isSafeInteger(change.systemId) || change.systemId <= 0) {
    return { ok: false, reason: "INVALID_CHANGE" };
  }

  if (!sovProjection || typeof sovProjection.projectSystem !== "function") {
    logger?.log?.(`[sovProjection] listener: projectSystem not available`);
    return { ok: false, reason: "PROJECT_SYSTEM_UNAVAILABLE" };
  }

  const systemId = change.systemId;

  try {
    const result = await sovProjection.projectSystem(systemId);

    if (result.ok && result.skipped && telemetry) {
      const reason = metricSuffix(result.reason);
      telemetry.count(`sovProjection.${reason}`, 1);
    }

    return { ok: result.ok, skipped: result.skipped, reason: result.reason };
  } catch (err) {
    logger?.log?.(`[sovProjection] listener: projectSystem(${systemId}) threw - ${err.message}`);
    if (telemetry) telemetry.count("sovProjection.listenerError", 1);
    return { ok: false, reason: `LISTENER_THREW: ${err.message}` };
  }
}

module.exports = { onControllerChanged };