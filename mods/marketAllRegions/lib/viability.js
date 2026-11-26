"use strict";

const fs = require("node:fs");
const path = require("node:path");

const HANDLER_START = "async Handle_GetOrders(";

const SOURCE_REQUIREMENTS = Object.freeze([
  Object.freeze({
    key: "marketProxyService",
    file: "server/src/services/market/marketProxyService.js",
    required: Object.freeze([HANDLER_START, "module.exports = MarketProxyService;"]),
    handlerBody: Object.freeze(["marketDaemonClient.call(\"GetOrders\"", "region_id: regionID"]),
  }),
  Object.freeze({
    key: "marketDaemonClient",
    file: "server/src/services/market/marketDaemonClient.js",
    required: Object.freeze(["async call(method", "  MarketDaemonClient,"]),
  }),
  Object.freeze({
    key: "worldData",
    file: "server/src/space/worldData.js",
    required: Object.freeze(["function getSolarSystems", "  getSolarSystems,"]),
  }),
]);

function countOf(source, token) {
  return source.split(token).length - 1;
}

function extractHandlerBody(source) {
  const start = source.indexOf(HANDLER_START);
  if (start < 0) return "";
  const next = source.indexOf("async Handle_", start + HANDLER_START.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

function inspectSourceShape(runtimeRoot, definition) {
  const filename = path.join(runtimeRoot, ...definition.file.split("/"));
  let source = "";
  try {
    source = fs.readFileSync(filename, "utf8");
  } catch (error) {
    return { key: definition.key, filename, ok: false, reason: error.message };
  }
  const problems = definition.required
    .filter((token) => countOf(source, token) !== 1)
    .map((token) => `seam ${JSON.stringify(token)} count ${countOf(source, token)}, expected 1`);
  if (definition.handlerBody) {
    const body = extractHandlerBody(source);
    for (const token of definition.handlerBody) {
      if (!body.includes(token)) problems.push(`Handle_GetOrders body lacks ${JSON.stringify(token)}`);
    }
  }
  return {
    key: definition.key,
    filename,
    ok: problems.length === 0,
    reason: problems.length > 0 ? problems.join("; ") : null,
  };
}

function inspect(runtimeRoot) {
  const reports = SOURCE_REQUIREMENTS.map((definition) => inspectSourceShape(runtimeRoot, definition));
  return { ok: reports.every((report) => report.ok), reports };
}

module.exports = {
  SOURCE_REQUIREMENTS,
  extractHandlerBody,
  inspect,
  inspectSourceShape,
};
