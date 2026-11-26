"use strict";

const REVENGE_SEC_CLASSES = Object.freeze(["lowsec", "nullsec"]);
const REVENGE_WAIT_REASONS = Object.freeze(["NOT_DUE", "EXPIRED", "NOT_LOCATED", "NOT_IN_SPACE", "SEC_CLASS",
  "EXCLUDED_REGION", "GRAPH_NOT_READY", "TOO_FAR", "CAPSULE"]);

const wait = (reason) => ({ ready: false, reason });

function secClassesOf(row, params) {
  const fn = params ? params.secClassesOf : null;
  const list = typeof fn === "function" ? fn(row) : null;
  return Array.isArray(list) ? list : REVENGE_SEC_CLASSES;
}

function decideRevengeStart(row, facts, params) {
  const now = facts.now;
  if (now >= row.expiresAt) return wait("EXPIRED");
  if (now < row.dueAt) return wait("NOT_DUE");
  const located = facts.located;
  if (!located || !Number.isSafeInteger(located.systemId) || located.systemId <= 0) return wait("NOT_LOCATED");
  if (located.state !== "space") return wait("NOT_IN_SPACE");
  const system = facts.system;
  if (!system) return wait("GRAPH_NOT_READY");
  if (!secClassesOf(row, params).includes(system.secClass)) return wait("SEC_CLASS");
  if (params.excludedRegions && params.excludedRegions.has(system.regionId)) return wait("EXCLUDED_REGION");
  const route = facts.route;
  if (!route) return wait("GRAPH_NOT_READY");
  if (route.ok !== true || !Number.isSafeInteger(route.jumps) || route.jumps > params.maxJumps) return wait("TOO_FAR");
  if (facts.capsule === true) return wait("CAPSULE");
  return { ready: true, systemId: located.systemId, jumps: route.jumps };
}

module.exports = { decideRevengeStart, secClassesOf, REVENGE_SEC_CLASSES, REVENGE_WAIT_REASONS };
