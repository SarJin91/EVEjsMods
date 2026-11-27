"use strict";

const assert = require("node:assert");

const { validateCatalog, listTemplateIds, EVENT_CATALOG, CAUSE, DENIED_TEMPLATE_IDS } = require("../../lib/events/catalog");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");

function claimCovered(catalog, factionId) {
  return catalog.types.some((t) => {
    if (t.cause !== CAUSE.OCCUPATION_CLAIM) return false;
    if (Array.isArray(t.causeFactions) && !t.causeFactions.includes(factionId)) return false;
    if (t.content === "OPPONENT") return Array.isArray(t.causeFactions) && t.causeFactions.includes(factionId);
    return Array.isArray(t.templatesByFaction[factionId]) && t.templatesByFaction[factionId].length > 0;
  });
}

module.exports = ({ test }) => {
  test("WEC1 catalog v2 coverage: validates, every faction with the invasion operation has a claim type (SELF key "
    + "or OPPONENT causeFactions), no denied template", () => {
    const r = validateCatalog(EVENT_CATALOG);
    assert.ok(r.ok, JSON.stringify(r.errors));
    const doctrines = new Map(DOCTRINES_V1.map((d) => [d.doctrineId, d]));
    const invaders = FACTIONS_V1.filter((f) => {
      const d = f.doctrineId ? doctrines.get(f.doctrineId) : null;
      return Boolean(d && Array.isArray(d.operationTypes) && d.operationTypes.includes("invasion"));
    }).map((f) => f.factionId).sort((a, b) => a - b);
    for (const id of [500001, 500003, 500010, 500019, 500021, 500025, 500026, 500029]) {
      assert.ok(invaders.includes(id), `faction ${id} expected among the invaders: ${invaders.join(",")}`);
    }
    assert.deepStrictEqual(invaders.filter((id) => !claimCovered(r.catalog, id)), [], "factions without a claim type");
    const denied = new Set(DENIED_TEMPLATE_IDS);
    assert.deepStrictEqual(listTemplateIds(r.catalog).filter((t) => denied.has(t)), []);
  });
};
