"use strict";

const PERMILLE = 1000;

const isRisk = (v) => Number.isSafeInteger(v) && v >= 0 && v <= PERMILLE;

function gateOn(snapshot, params) {
  return Boolean(params && params.transitRisk) && Boolean(snapshot && snapshot.transitRisk)
    && typeof snapshot.transitRisk.of === "function";
}

function riskOf(snapshot, fromSystemId, toSystemId, mover) {
  if (!snapshot || !snapshot.transitRisk || typeof snapshot.transitRisk.of !== "function") return null;
  let r;
  try {
    r = snapshot.transitRisk.of(fromSystemId, toSystemId, mover);
  } catch (_err) {
    return null;
  }
  return isRisk(r) ? r : null;
}

function skippedByRisk(risk, P) {
  return isRisk(risk) && Boolean(P) && Number.isSafeInteger(P.skipPermille) && risk > P.skipPermille;
}

function raisedByRisk(base, risk, P) {
  if (!isRisk(risk) || risk <= 0 || !P || !Number.isSafeInteger(P.raiseStepPermille) || P.raiseStepPermille <= 0
    || !Number.isFinite(base)) return base;
  const mult = PERMILLE + Math.floor(risk * P.raiseStepPermille / PERMILLE);
  return Math.ceil(base * mult / PERMILLE);
}

function operationShipCountOf(template, P) {
  if (!P || P.templateShips !== true || !Array.isArray(template) || template.length === 0) return null;
  let n = 0;
  for (const e of template) {
    if (!e || !Number.isSafeInteger(e.count) || e.count < 0) return null;
    n += e.count;
  }
  return n > 0 ? n : null;
}

module.exports = { gateOn, riskOf, skippedByRisk, raisedByRisk, operationShipCountOf };
