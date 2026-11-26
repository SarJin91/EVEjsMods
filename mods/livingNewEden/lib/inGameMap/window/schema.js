"use strict";

const SERVICE_NAME = "lneMapSvc";
const NOTIFY_PROBE = "OnLneMapProbe";
const PART_PROBE = "mapProbe";
const LOG_TAG = "LNE_MAP_UI";
const MAX_REPORT_ITEMS = 64;
const MAX_REPORT_ITEM_CHARS = 96;
const PROTO = 1;
const PROBE_NAMES = Object.freeze({ code: "<lne-map-probe>", stub: "<lne-map-probe-stub>", tag: LOG_TAG });
const READY_ITEM = "p.ready=1";
const UNSUPPORTED_BUILD = "UNSUPPORTED_BUILD";
const PROBE_MODES = Object.freeze(["nodes", "attrs"]);
const COUNTER_NAMES = Object.freeze(["reports", "reportSuppressed", "probesSent", "probeRefused", "composed",
  "composeSkipped", "errors",
  "mapReads", "mapRateLimited", "mapBusy", "mapRefused", "mapUnchanged", "mapStaticSent", "mapStateSent",
  "mapCacheHits", "mapStaleSources", "mapTruncSys", "mapTruncMk",
  "opens", "openNoSession", "openFallbackLink",
  "mapCorpMarkReads", "mapCorpMarkHits", "mapCorpMarkRefused"]);
const SCOPES = Object.freeze(["here", "region", "galaxy"]);
const NOTIFY_OPEN = "OnLneMapOpen";
const PART_MAP = "map";
const MAP_NAMES = Object.freeze({ code: "<lne-map>", stub: "<lne-map-stub>", tag: LOG_TAG });
const MAP_READY_ITEM = "m.ready=1";
const ITEM_PREFIX = Object.freeze({ mapProbe: "p.", map: "m." });
const MAP_BUILD_FAIL_STEPS = Object.freeze(["class", "window", "parent", "layout"]);
const MAP_WORK_CLASS = "MAINTENANCE";

function asciiOf(value, max) {
  const text = String(value ?? "").replace(/\s/g, "_").replace(/[^\x20-\x7e]/g, "?");
  return text.length > max ? text.slice(0, max) : text;
}

module.exports = {
  SERVICE_NAME, NOTIFY_PROBE, PART_PROBE, LOG_TAG, MAX_REPORT_ITEMS, MAX_REPORT_ITEM_CHARS, PROTO, PROBE_NAMES,
  READY_ITEM, UNSUPPORTED_BUILD, PROBE_MODES, COUNTER_NAMES, SCOPES, NOTIFY_OPEN, MAP_WORK_CLASS, PART_MAP, MAP_NAMES,
  MAP_READY_ITEM, ITEM_PREFIX, MAP_BUILD_FAIL_STEPS, asciiOf,
};
