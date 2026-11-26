"use strict";

const { STANDING_FLEET_STATES } = require("../world/occupation/schema");

const PRESENT_STATES = Object.freeze([...STANDING_FLEET_STATES, "ENGAGED"]);
const COUNTER_NAMES = Object.freeze(["passes", "deferrals", "repushes", "repushFailed", "shortfall", "noPool",
  "noRecord", "truncatedSystems", "truncatedFleets", "errors",
  "xmppReasserts",
  "poolTruncated",
  "residentsFailed",
  "populationShortfall", "populationNoPool",
  "outlawsLeft", "nudges"]);
const GAUGE_NAMES = Object.freeze(["systems", "pilots", "xmppSockets", "xmppShown", "residents", "population"]);
const WORK_CLASS = "MAINTENANCE";
const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });

module.exports = { PRESENT_STATES, COUNTER_NAMES, GAUGE_NAMES, WORK_CLASS, STATE };
