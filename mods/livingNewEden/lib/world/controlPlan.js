"use strict";

const { SEC_CLASSES } = require("../graph/universeGraph");
const { SEED_REASON, ACCEPTED_PIRATE_SOURCES, OVERRIDE_SCOPES } = require("./data/seedData");

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function parseSeedScope(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { ok: false, reason: "SEED_SCOPE_INVALID", detail: "empty" };
  }
  const parts = text.split(",").map((p) => p.trim());
  const unknown = parts.find((p) => !SEC_CLASSES.includes(p));
  if (unknown !== undefined) return { ok: false, reason: "SEED_SCOPE_INVALID", detail: `unknown class "${unknown}"` };
  const classes = SEC_CLASSES.filter((c) => parts.includes(c));
  return { ok: true, classes, tag: classes.join("+") };
}

function indexOverrides(list) {
  const bad = (detail) => ({ ok: false, reason: "CONTROL_OVERRIDES_INVALID", detail });
  if (!Array.isArray(list)) return bad("not an array");
  const index = Object.fromEntries(OVERRIDE_SCOPES.map((s) => [s, new Map()]));
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!entry || typeof entry !== "object") return bad(`[${i}] not an object`);
    if (!OVERRIDE_SCOPES.includes(entry.scope)) return bad(`[${i}] scope`);
    if (!isPositiveId(entry.id)) return bad(`[${i}] id`);
    if (entry.controllerFactionId !== null && !isPositiveId(entry.controllerFactionId)) {
      return bad(`[${i}] controllerFactionId`);
    }
    if (typeof entry.origin !== "string" || entry.origin.trim() === "") return bad(`[${i}] origin`);
    const map = index[entry.scope];
    if (map.has(entry.id)) return bad(`[${i}] duplicate ${entry.scope} ${entry.id}`);
    map.set(entry.id, entry.controllerFactionId);
  }
  return { ok: true, index };
}

function overrideFor(vertex, overrideIndex) {
  const ids = { system: vertex.id, constellation: vertex.constellationId, region: vertex.regionId };
  for (const scope of OVERRIDE_SCOPES) {
    const map = overrideIndex && overrideIndex[scope];
    if (map && map.has(ids[scope])) return { found: true, controllerFactionId: map.get(ids[scope]) };
  }
  return { found: false };
}

function planSystemControl(vertex, faction, overrideIndex, settings) {
  const sdeFactionId = isPositiveId(vertex.factionId) ? vertex.factionId : null;
  let controller = null;
  let rule = "none";
  const override = overrideFor(vertex, overrideIndex);
  const bastion = !override.found && settings && typeof settings.bastionOf === "function"
    ? settings.bastionOf(vertex.id) : null;
  if (override.found) {
    controller = override.controllerFactionId;
    rule = "override";
  } else if (isPositiveId(bastion)) {
    controller = bastion;
    rule = "bastion";
  } else if (faction && ACCEPTED_PIRATE_SOURCES.includes(faction.source) && isPositiveId(faction.factionId)) {
    controller = faction.factionId;
    rule = "pirate";
  } else if (sdeFactionId !== null) {
    controller = sdeFactionId;
    rule = "sde";
  }
  const influence = [];
  if (controller !== null) influence.push({ factionId: controller, influenceScore: settings.controllerInfluence });
  if (sdeFactionId !== null && sdeFactionId !== controller && settings.sdeFactionInfluence > 0) {
    influence.push({ factionId: sdeFactionId, influenceScore: settings.sdeFactionInfluence });
  }
  influence.sort((a, b) => a.factionId - b.factionId);
  const change = {
    systemId: vertex.id,
    expectedVersion: 0,
    reason: SEED_REASON,
    state: { securityClass: vertex.secClass, controllerFactionId: controller },
    influence,
  };
  return { change, rule };
}

module.exports = { parseSeedScope, indexOverrides, planSystemControl };
