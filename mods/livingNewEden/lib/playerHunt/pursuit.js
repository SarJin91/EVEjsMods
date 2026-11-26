"use strict";

const { parseSecClassList } = require("./schema");

const isPositiveId = (v) => Number.isSafeInteger(v) && v > 0;
const SPACE_STATES = Object.freeze(["space", "transit"]);

function locateCharacter(presence, characterId) {
  try {
    if (!presence || typeof presence.observedSystems !== "function"
      || typeof presence.getSystemPresence !== "function" || !isPositiveId(characterId)) return null;
    const systems = [...presence.observedSystems()].filter(isPositiveId).sort((a, b) => a - b);
    for (const systemId of systems) {
      const sp = presence.getSystemPresence(systemId);
      const chars = sp && Array.isArray(sp.characters) ? sp.characters : [];
      const c = chars.find((x) => x && x.characterId === characterId);
      if (c) return { systemId, state: c.state };
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function decidePursuit(input, params) {
  const no = (reason) => ({ pursue: false, reason });
  const p = params || {};
  const i = input || {};
  if (p.pursuitEnabled !== true || !(p.pursuitMaxActive > 0)) return no("DISABLED");
  const located = i.located;
  if (!located || !isPositiveId(located.systemId)) return no("NOT_LOCATED");
  if (located.systemId === i.fromSystemId) return no("SAME_SYSTEM");
  if (!SPACE_STATES.includes(located.state)) return no("DOCKED");
  if (p.pursuitRequireContact === true && i.contact !== true) return no("NO_CONTACT");
  if (i.chainCooldown === true) return no("CHAIN_COOLDOWN");
  const hops = Number.isSafeInteger(i.hops) && i.hops >= 0 ? i.hops : 0;
  if (hops >= p.pursuitMaxHops) return no("HOPS_EXHAUSTED");
  const active = Number.isSafeInteger(i.activePursuits) && i.activePursuits >= 0 ? i.activePursuits : 0;
  if (active >= p.pursuitMaxActive) return no("MAX_ACTIVE");
  const route = i.route;
  if (!route) return no("GRAPH_NOT_READY");
  if (route.ok !== true) return no(typeof route.reason === "string" && route.reason !== "" ? route.reason
    : "UNREACHABLE");
  if (!Number.isSafeInteger(route.jumps) || route.jumps < 1) return no("UNREACHABLE");
  if (route.jumps > p.pursuitMaxJumps) return no("TOO_FAR");
  return { pursue: true, targetSystemId: located.systemId, jumps: route.jumps };
}

function stateInSystem(presence, systemId, characterId) {
  try {
    if (!presence || typeof presence.getSystemPresence !== "function" || !isPositiveId(systemId)
      || !isPositiveId(characterId)) return null;
    const sp = presence.getSystemPresence(systemId);
    const chars = sp && Array.isArray(sp.characters) ? sp.characters : [];
    const c = chars.find((x) => x && x.characterId === characterId);
    return c && typeof c.state === "string" ? c.state : null;
  } catch (_err) {
    return null;
  }
}

function constraintsOf(params) {
  const p = params || {};
  const avoid = parseSecClassList(p.pursuitAvoidSecClasses);
  return { maxJumps: p.pursuitMaxJumps, avoidSecClasses: avoid === null ? [] : [...avoid] };
}

function arrivalGateIndex(objects, fromSystemId) {
  if (!Array.isArray(objects) || !isPositiveId(fromSystemId)) return -1;
  return objects.findIndex((o) => o && o.kind === "stargate" && o.toSystemId === fromSystemId);
}

module.exports = { locateCharacter, decidePursuit, constraintsOf, arrivalGateIndex, stateInSystem };
