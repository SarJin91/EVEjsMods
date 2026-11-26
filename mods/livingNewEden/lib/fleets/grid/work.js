"use strict";

const { deriveSeed, createRng } = require("../../util/rng");

const WORK_TARGETS_VERSION = 1;
const BELT_SEED_KIND = "fleet-exposure-belt";
const ANY = "*";
const NONE = null;
const TARGET = Object.freeze({ CP: "CP", BELT_SELF: "BELT_SELF", BELT_HOSTILE_MINER: "BELT_HOSTILE_MINER",
  BELT_OWN_MINER: "BELT_OWN_MINER", STAY: "STAY" });

const rule = (operationType, objective, fleetRole, target, missing = null) => Object.freeze({ operationType,
  objective, fleetRole, target, missing, id: `${operationType === NONE ? "none" : operationType}/${objective}/`
    + `${fleetRole}` });

const WORK_TARGETS = Object.freeze([
  rule(ANY, ANY, "scout", TARGET.STAY),
  rule("invasion", "capture", ANY, TARGET.CP),
  rule("raid", "raid", ANY, TARGET.CP),
  rule("defense", "hold", ANY, TARGET.CP),
  rule("reinforce", "hold", ANY, TARGET.CP),
  rule("return", "return", ANY, TARGET.CP),
  rule("logistics", "deliver", ANY, TARGET.CP),
  rule("mining", "mine", ANY, TARGET.BELT_SELF, TARGET.CP),
  rule("mining", "deliver", ANY, TARGET.CP),
  rule("ratting", "rat", ANY, TARGET.BELT_SELF, TARGET.CP),
  rule("gank", "raid", ANY, TARGET.BELT_HOSTILE_MINER, TARGET.STAY),
  rule("escort", "hold", ANY, TARGET.BELT_OWN_MINER, TARGET.CP),
  rule("patrol", "patrol", "hunter", TARGET.STAY),
  rule("patrol", ANY, ANY, TARGET.CP),
  rule("recon", ANY, ANY, TARGET.STAY),
  rule("intercept", "destroy", ANY, TARGET.CP),
  rule("expedition", ANY, ANY, TARGET.CP),
  rule("camp", ANY, ANY, TARGET.STAY),
  rule("blockade", ANY, ANY, TARGET.STAY),
  rule("pursuit", ANY, ANY, TARGET.STAY),
  rule("salvage", ANY, ANY, TARGET.STAY),
  rule("structure_assault", ANY, ANY, TARGET.STAY),
  rule("counter", "destroy", ANY, TARGET.CP),
  rule("harvest_raid", ANY, ANY, TARGET.STAY),
  rule(ANY, "liberate", ANY, TARGET.CP),
  rule(ANY, "capture", ANY, TARGET.CP),
  rule(NONE, ANY, ANY, TARGET.CP),
  rule(ANY, ANY, ANY, TARGET.CP),
]);

const matches = (pattern, value) => pattern === ANY || pattern === value;

function ruleOf(operationType, objective, fleetRole) {
  for (const r of WORK_TARGETS) {
    if (matches(r.operationType, operationType) && matches(r.objective, objective) && matches(r.fleetRole, fleetRole)) {
      return r;
    }
  }
  return WORK_TARGETS[WORK_TARGETS.length - 1];
}

function pickBelt(belts, worldSeed, fleetId) {
  if (!Array.isArray(belts) || belts.length === 0 || !Number.isInteger(worldSeed)) return null;
  const sorted = [...belts].sort((a, b) => a.id - b.id);
  const rng = createRng(deriveSeed(worldSeed, BELT_SEED_KIND, String(fleetId)));
  return sorted[rng.nextUint32() % sorted.length];
}

function minerOf(miners, pred) {
  let best = null;
  for (const m of Array.isArray(miners) ? miners : []) {
    if (m && typeof m.fleetId === "string" && pred(m) && (best === null || m.fleetId < best.fleetId)) best = m;
  }
  return best;
}

const anchorOf = (a) => Object.freeze({ kind: a.kind, id: a.id });

function resolve(target, input, belts) {
  const { fleet, sys, worldSeed } = input;
  if (target === TARGET.CP) return sys.cp;
  if (target === TARGET.BELT_SELF) return pickBelt(belts, worldSeed, fleet.fleetId);
  if (target === TARGET.BELT_HOSTILE_MINER || target === TARGET.BELT_OWN_MINER) {
    const own = target === TARGET.BELT_OWN_MINER;
    const miner = minerOf(input.miners, (m) => (own ? m.factionId === fleet.factionId && m.fleetId !== fleet.fleetId
      : m.factionId !== fleet.factionId));
    return miner ? pickBelt(belts, worldSeed, miner.fleetId) : null;
  }
  return null;
}

function workTargetOf(input) {
  try {
    const fleet = (input && input.fleet) || {};
    const r = workRuleOf(input && input.operation, fleet.fleetRole);
    const sys = input && input.sys ? input.sys : { anchors: [], cp: null };
    const belts = (Array.isArray(sys.anchors) ? sys.anchors : []).filter((a) => a && a.kind === "belt");
    let target = r.target;
    let missing = false;
    if (target === TARGET.STAY) return { kind: "STAY", rule: r.id, missing };
    let anchor = resolve(target, { ...input, fleet, sys }, belts);
    if (anchor === null && r.missing !== null) {
      missing = true;
      target = r.missing;
      if (target === TARGET.STAY) return { kind: "STAY", rule: r.id, missing };
      anchor = resolve(target, { ...input, fleet, sys }, belts);
    }
    if (!anchor || anchor.kind === "system") return { kind: "STAY", rule: "NO_ANCHORS", missing };
    return { kind: "ANCHOR", anchor: anchorOf(anchor), rule: r.id, missing };
  } catch (_err) {
    return { kind: "STAY", rule: "NO_ANCHORS", missing: false };
  }
}

function workRuleOf(operation, fleetRole) {
  const op = operation || null;
  return ruleOf(op ? op.operationType : NONE, op ? op.objective : NONE, fleetRole);
}

module.exports = { WORK_TARGETS, WORK_TARGETS_VERSION, TARGET, workTargetOf, workRuleOf, pickBelt };
