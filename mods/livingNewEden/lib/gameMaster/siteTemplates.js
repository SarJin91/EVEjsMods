"use strict";

const { EVENT_CATALOG, ANOMALY_EVENT_CATALOG } = require("../events/data/eventCatalog");

const EMPTY = Object.freeze([]);
const BY_TYPE = new Map([...EVENT_CATALOG, ...ANOMALY_EVENT_CATALOG].map((t) => [t.eventType, t.templatesByFaction]));

function siteTemplatesOf(eventType, factionId) {
  const byFaction = typeof eventType === "string" ? BY_TYPE.get(eventType) : undefined;
  if (!byFaction || !Number.isSafeInteger(factionId)) return EMPTY;
  const list = Object.prototype.hasOwnProperty.call(byFaction, factionId) ? byFaction[factionId] : null;
  return Array.isArray(list) ? list : EMPTY;
}

function arcFitsFaction(arc, factionId) {
  if (!arc || arc.siteTemplate === null || arc.siteTemplate === undefined) return true;
  return siteTemplatesOf(arc.siteTemplate, factionId).length > 0;
}

module.exports = { siteTemplatesOf, arcFitsFaction };
