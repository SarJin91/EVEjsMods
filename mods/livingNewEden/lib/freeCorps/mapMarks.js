"use strict";

const { ARCHETYPES, CORP_STATES } = require("./schema");
const { ARCHETYPE_DATA } = require("./data/archetypes");

const STYLE_PREFIX = "fc-";
const COLOURS = Object.freeze({ miner: "#d2a24c", hauler: "#4f9dff", ratter: "#ff7a45", explorer: "#b07cff",
  industrialist: "#3fc1b0", missioner: "#f0f0f0", hunter: "#ff3b3b", structure: "#8a6f55" });

const MAP_STYLES = Object.freeze(ARCHETYPES.map((a) => Object.freeze([`${STYLE_PREFIX}${a}`,
  `free corp: ${(ARCHETYPE_DATA[a] && ARCHETYPE_DATA[a].label) || a}`, COLOURS[a]])));
const RANK = new Map(ARCHETYPES.map((a, i) => [a, i]));
const LIVING = new Set([CORP_STATES.ACTIVE, CORP_STATES.STRUGGLING]);

const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const whole = (v) => Math.max(0, Math.trunc(Number(v) || 0));

function buildMapMarks(input) {
  const maxMarks = whole(input.maxMarks);
  const maxLines = whole(input.maxLines);
  const corpById = new Map();
  for (const c of input.corps || []) {
    if (c && posInt(c.corpId) && LIVING.has(c.state) && RANK.has(c.archetype)) corpById.set(c.corpId, c);
  }
  const entries = [];
  const crewOf = new Map();
  for (const v of input.ventures || []) {
    const corp = v ? corpById.get(v.corpId) : undefined;
    if (!corp || !posInt(v.systemId)) continue;
    const crew = whole(v.crew);
    crewOf.set(corp.corpId, crew);
    entries.push({ systemId: v.systemId, corpId: corp.corpId, pilots: crew, archetype: corp.archetype,
      line: `${corp.name} [${corp.ticker}] · ${corp.archetype} · ${v.kind} ${v.state} ${whole(v.step)}/`
        + `${whole(v.stepsTotal)} (${crew})` });
  }
  const structureOf = new Map();
  for (const s of input.structures || []) {
    if (s && posInt(s.corpId) && typeof s.state === "string" && !structureOf.has(s.corpId)) {
      structureOf.set(s.corpId, s.state);
    }
  }
  for (const corp of corpById.values()) {
    const n = whole(corp.membersTarget) - (crewOf.get(corp.corpId) || 0);
    if (n <= 0 || !posInt(corp.homeSystemId)) continue;
    const st = structureOf.get(corp.corpId);
    entries.push({ systemId: corp.homeSystemId, corpId: corp.corpId, pilots: n, archetype: corp.archetype,
      line: `${corp.name} [${corp.ticker}] · ${corp.archetype} · home (${n})${st ? ` · Astrahus ${st}` : ""}` });
  }
  const bySystem = new Map();
  for (const e of entries) {
    if (e.pilots <= 0) continue;
    let sys = bySystem.get(e.systemId);
    if (!sys) {
      sys = { systemId: e.systemId, pilots: 0, entries: [], byArchetype: new Map(), corps: new Set() };
      bySystem.set(e.systemId, sys);
    }
    sys.pilots += e.pilots;
    sys.entries.push(e);
    sys.corps.add(e.corpId);
    sys.byArchetype.set(e.archetype, (sys.byArchetype.get(e.archetype) || 0) + e.pilots);
  }
  const all = [...bySystem.values()].sort((a, b) => b.pilots - a.pilots || a.systemId - b.systemId);
  const kept = all.slice(0, maxMarks);
  const marks = kept.map((sys) => {
    const top = [...sys.byArchetype].sort((a, b) => b[1] - a[1] || RANK.get(a[0]) - RANK.get(b[0]))[0][0];
    sys.entries.sort((a, b) => b.pilots - a.pilots || a.corpId - b.corpId);
    const lines = [`${sys.pilots} free corp pilots · ${sys.corps.size} corps`];
    for (const e of sys.entries.slice(0, maxLines)) lines.push(e.line);
    const more = sys.entries.length - Math.min(maxLines, sys.entries.length);
    if (more > 0) lines.push(`+${more} more`);
    return { systemId: sys.systemId, style: `${STYLE_PREFIX}${top}`, pilots: sys.pilots, lines };
  });
  const corps = new Set();
  let pilots = 0;
  for (const sys of kept) {
    pilots += sys.pilots;
    for (const id of sys.corps) corps.add(id);
  }
  return { marks, pilots, systems: marks.length, corps: corps.size,
    truncated: input.truncated === true || all.length > kept.length };
}

module.exports = { MAP_STYLES, buildMapMarks };
