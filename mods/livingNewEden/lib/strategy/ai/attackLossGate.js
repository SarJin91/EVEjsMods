"use strict";

const { fitIskOf, MAX_ISK } = require("./warChest");

const PERMILLE = 1000;

function gateOn(snapshot, params) {
  return Boolean(params && params.attackLoss) && Boolean(snapshot) && snapshot.attackLosses instanceof Map;
}

function cooledOf(snapshot) {
  if (!snapshot || !(snapshot.attackLosses instanceof Map) || snapshot.attackLosses.size === 0) return new Set();
  const out = new Set();
  for (const [systemId, e] of snapshot.attackLosses) {
    if (e && Number.isSafeInteger(e.cooldownUntil) && e.cooldownUntil > snapshot.at) out.add(systemId);
  }
  return out;
}

function lossesOf(snapshot, systemId) {
  if (!snapshot || !(snapshot.attackLosses instanceof Map)) return 0;
  const e = snapshot.attackLosses.get(systemId);
  return e && Number.isSafeInteger(e.losses) && e.losses > 0 ? e.losses : 0;
}

function raisedRequired(base, losses, attackLoss) {
  if (!attackLoss || !Number.isSafeInteger(losses) || losses <= 0) return base;
  const steps = Math.min(losses, attackLoss.maxMultiplier);
  return Math.ceil(base * (PERMILLE + attackLoss.stepPermille * steps) / PERMILLE);
}

function launchValueIsk(compositions, war) {
  if (!war) return 0;
  const permille = PERMILLE + (Number.isSafeInteger(war.fitPermille) && war.fitPermille > 0 ? war.fitPermille : 0);
  let total = 0;
  for (const c of Array.isArray(compositions) ? compositions : []) {
    total = Math.min(MAX_ISK, total + fitIskOf(c, war.valueByGroup, permille));
  }
  return total;
}

function expectedLossIsk(value, losses, attackLoss) {
  if (!attackLoss || !attackLoss.iskGate || !Number.isSafeInteger(value) || value <= 0) return 0;
  const steps = Number.isSafeInteger(losses) && losses > 0 ? Math.min(losses, attackLoss.maxMultiplier) : 0;
  const share = Math.min(PERMILLE,
    Math.floor(attackLoss.iskGate.sharePermille * (PERMILLE + attackLoss.stepPermille * steps) / PERMILLE));
  return Math.floor(value / PERMILLE) * share + Math.floor(((value % PERMILLE) * share) / PERMILLE);
}

module.exports = { gateOn, cooledOf, lossesOf, raisedRequired, launchValueIsk, expectedLossIsk };
