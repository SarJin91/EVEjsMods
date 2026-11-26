"use strict";

const { EWAR_KIND } = require("../adapter/ewarAccess");

const ACTIVE_ORDER = Object.freeze(["weapons", "drones", "prop", "localRep", "remoteRep", "hardeners",
  ...EWAR_KIND]);

function isObj(value) {
  return Boolean(value) && typeof value === "object";
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function runningOf(input) {
  const i = isObj(input) ? input : {};
  const task = isObj(i.task) ? i.task : null;
  const active = isObj(i.active) ? i.active : null;
  const drones = isObj(i.drones) ? i.drones : null;
  const on = new Set();
  if (task && task.task === "ATTACK" && posInt(task.targetId) && task.wait === null && task.weaponless !== true) {
    on.add("weapons");
  }
  if (drones && Number(drones.out) > 0) on.add("drones");
  if (active) {
    if (active.propOn === true) on.add("prop");
    if (active.localRepOn === true) on.add("localRep");
    if (active.repairing === "host" || active.repairing === "twin") on.add("remoteRep");
    if (Number(active.alwaysOn) > 0) on.add("hardeners");
    if (Array.isArray(active.ewarOn)) {
      for (const kind of active.ewarOn) if (EWAR_KIND.includes(kind)) on.add(kind);
    }
  }
  return ACTIVE_ORDER.filter((code) => on.has(code));
}

module.exports = { ACTIVE_ORDER, runningOf };
