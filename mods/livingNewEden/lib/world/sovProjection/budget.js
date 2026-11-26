"use strict";

const { SovWriteBudget, createBudget } = require("../../adapter/sovProjection");

function createSovBudget(config) {
  return createBudget(config);
}

function createSovBudgetFromConfig(config, now) {
  const maxWrites = config?.limits?.maxSovWritesPerWindow ?? config?.world?.sovProjection?.maxSovWritesPerWindow ?? 8;
  const windowMs = config?.limits?.sovWriteWindowMs ?? config?.world?.sovProjection?.sovWriteWindowMs ?? 300000;
  return createBudget({ maxSovWritesPerWindow: maxWrites, sovWriteWindowMs: windowMs, now });
}

const nonNegativeInt = (v, fallback) => (Number.isFinite(v) && v >= 0 ? Math.trunc(v) : fallback);

function createProjectionPacer(opts) {
  if (!opts || typeof opts.now !== "function") throw new Error("createProjectionPacer requires a 'now' function");
  const now = opts.now;
  const minSpacingMs = nonNegativeInt(opts.minSpacingMs, 0);
  const costFactor = nonNegativeInt(opts.costFactor, 0);
  let nextAllowedAt = 0;
  let lastVendorMs = null;
  return Object.freeze({
    check() {
      const t = now();
      return t >= nextAllowedAt ? { ok: true } : { ok: false, retryAt: nextAllowedAt };
    },
    record(vendorMs) {
      const ms = Number.isFinite(vendorMs) && vendorMs > 0 ? vendorMs : 0;
      lastVendorMs = ms;
      nextAllowedAt = now() + Math.max(minSpacingMs, Math.round(ms * costFactor));
    },
    getStatus: () => ({ nextAllowedAt, lastVendorMs }),
  });
}

function createProjectionPacerFromConfig(config, now) {
  const cfg = (config && config.world && config.world.sovProjection) || {};
  return createProjectionPacer({ minSpacingMs: cfg.projectionMinSpacingMs ?? 5000,
    costFactor: cfg.projectionCostFactor ?? 20, now });
}

module.exports = {
  createSovBudget,
  createSovBudgetFromConfig,
  createProjectionPacer,
  createProjectionPacerFromConfig,
  SovWriteBudget,
};