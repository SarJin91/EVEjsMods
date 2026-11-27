"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");
const { billOf, RECIPE_METHOD } = require("../production/buildRecipes");

const WTB_GROUPS = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics",
  "ewar", "tackle"]);

const HULL_TRADE_METHOD = Object.freeze({
  tableVersion: 1,
  groups: WTB_GROUPS,
  sourceGroups: Object.freeze(Object.fromEntries(WTB_GROUPS.map((g) => [g, RECIPE_METHOD.sourceGroups[g]]))),
  baseGroups: Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship"]),
  races: Object.freeze([1, 2, 4, 8]),
  skillAttributes: Object.freeze([182, 183, 184]),
  maxSkillDepth: 8,
  maxTypes: 32,
  factionShipRace: Object.freeze({
    500001: 1, 500002: 2, 500003: 4, 500004: 8, 500010: 1, 500011: 2, 500012: 4, 500016: 8, 500019: 4, 500020: 8,
  }),
  raceControls: Object.freeze({ 587: 2 }),
});

const ATTR_TECH_LEVEL = 422;
const ATTR_META_LEVEL = 633;
const ATTR_META_GROUP = 1692;

const fail = (reason, detail) => ({ ok: false, reason, detail });
const idOf = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);

function uniqueRaceSkills(races, raceIds) {
  const byRace = new Map();
  for (const r of races) if (raceIds.includes(r.raceId)) byRace.set(r.raceId, new Set(r.skills.map(Number)));
  const out = new Map();
  for (const r of raceIds) {
    const own = byRace.get(r) || new Set();
    const unique = [...own].filter((s) => raceIds.every((o) => o === r || !(byRace.get(o) || new Set()).has(s)));
    out.set(r, unique.sort((a, b) => a - b));
  }
  return out;
}

function skillClosure(typeId, dogma, method) {
  const seen = new Set();
  let frontier = [typeId];
  for (let depth = 0; depth < method.maxSkillDepth && frontier.length > 0; depth += 1) {
    const next = [];
    for (const t of frontier) {
      const attrs = dogma.get(t);
      if (!attrs) continue;
      for (const a of method.skillAttributes) {
        const s = idOf(attrs[a]);
        if (s !== null && !seen.has(s)) {
          seen.add(s);
          next.push(s);
        }
      }
    }
    frontier = next;
  }
  return seen;
}

function raceOf(typeId, dogma, uniqueSkills, method) {
  const closure = skillClosure(typeId, dogma, method);
  const hits = method.races.filter((r) => (uniqueSkills.get(r) || []).some((s) => closure.has(s)));
  return hits.length === 1 ? hits[0] : null;
}

const META_GROUP_LEVEL = Object.freeze({ 1: "T1", 2: "T2" });

function levelOf(attrs, metaGroupId) {
  if (typeof metaGroupId === "number") return META_GROUP_LEVEL[metaGroupId] || null;
  if (!attrs) return null;
  const tech = attrs[ATTR_TECH_LEVEL];
  const meta = attrs[ATTR_META_LEVEL];
  const metaGroup = attrs[ATTR_META_GROUP];
  if (tech === 1 && (meta === undefined || meta === 0) && (metaGroup === undefined || metaGroup === 1)) return "T1";
  if (tech === 2 && (metaGroup === undefined || metaGroup === 2)) return "T2";
  return null;
}

function serialize(header, races, factionRace) {
  const out = [];
  out.push("\"use strict\";");
  out.push("");
  out.push("function deepFreeze(value) {");
  out.push("  if (value && typeof value === \"object\" && !Object.isFrozen(value)) {");
  out.push("    for (const key of Object.keys(value)) deepFreeze(value[key]);");
  out.push("    Object.freeze(value);");
  out.push("  }");
  out.push("  return value;");
  out.push("}");
  out.push("");
  out.push(`const HEADER = ${JSON.stringify(header, null, 2)};`);
  out.push("");
  out.push("const RACES = {");
  for (const r of Object.keys(races)) out.push(`  ${JSON.stringify(r)}: ${JSON.stringify(races[r])},`);
  out.push("};");
  out.push("");
  out.push("const FACTION_RACE = {");
  for (const f of Object.keys(factionRace)) out.push(`  ${JSON.stringify(f)}: ${factionRace[f]},`);
  out.push("};");
  out.push("");
  out.push("module.exports = deepFreeze({ HEADER, RACES, FACTION_RACE });");
  out.push("");
  return out.join("\n");
}

function buildHullTradeTypes(inputs, method = HULL_TRADE_METHOD) {
  if (!inputs || !inputs.sde || !Array.isArray(inputs.types) || !(inputs.blueprints instanceof Map)
    || !(inputs.dogma instanceof Map) || !Array.isArray(inputs.races)) {
    return fail("INPUT_INVALID", "inputs need sde, types, blueprints, dogma, races");
  }
  const uniqueSkills = uniqueRaceSkills(inputs.races, method.races);
  const empty = method.races.filter((r) => uniqueSkills.get(r).length === 0);
  if (empty.length > 0) return fail("RACE_SKILLS_AMBIGUOUS", empty.join(","));

  for (const [typeId, want] of Object.entries(method.raceControls || {})) {
    const got = raceOf(Number(typeId), inputs.dogma, uniqueSkills, method);
    if (got !== want) return fail("RACE_CONTROL_MISMATCH", `${typeId} race ${got} != ${want}`);
  }

  const ctx = { minerals: new Set(RECIPE_METHOD.minerals), blueprints: inputs.blueprints,
    maxDepth: RECIPE_METHOD.maxDepth };
  const ignored = new Set();
  const candidates = new Map(method.races.map((r) => [r, new Map(method.groups.map((g) => [g, { T1: [], T2: [] }]))]));
  const sortedTypes = [...inputs.types].sort((a, b) => a.typeId - b.typeId);
  for (const t of sortedTypes) {
    if (!method.groups.includes(t.hullGroup)) continue;
    if (!(method.sourceGroups[t.hullGroup] || []).includes(t.groupId)) continue;
    if (!inputs.blueprints.has(t.typeId)) continue;
    const level = levelOf(inputs.dogma.get(t.typeId), t.metaGroupId);
    if (level === null) continue;
    const race = raceOf(t.typeId, inputs.dogma, uniqueSkills, method);
    if (race === null) continue;
    let sum = 0;
    for (const v of billOf(t.typeId, ctx, ignored).values()) sum += v;
    if (!(sum > 0)) continue;
    candidates.get(race).get(t.hullGroup)[level].push({ typeId: t.typeId, sum });
  }

  const races = {};
  const rows = [];
  const picked = new Set();
  for (const r of method.races) {
    const row = {};
    for (const g of method.groups) {
      const c = candidates.get(r).get(g);
      const level = c.T1.length > 0 ? "T1" : c.T2.length > 0 ? "T2" : null;
      if (level === null) continue;
      const list = c[level].sort((a, b) => a.sum - b.sum || a.typeId - b.typeId);
      const pick = list[Math.floor((list.length - 1) / 2)];
      row[g] = pick.typeId;
      picked.add(pick.typeId);
      rows.push({ raceId: r, group: g, typeId: pick.typeId, level, mineralSum: pick.sum, sampleSize: list.length });
    }
    races[String(r)] = row;
  }
  for (const r of method.races) {
    const missing = method.baseGroups.filter((g) => !rows.some((x) => x.raceId === r && x.group === g
      && x.level === "T1"));
    if (missing.length > 0) return fail("RACE_GROUP_EMPTY", `${r}:${missing.join(",")}`);
  }
  if (picked.size > method.maxTypes) return fail("TOO_MANY_TYPES", `${picked.size} > ${method.maxTypes}`);

  const factionRace = {};
  for (const f of Object.keys(method.factionShipRace).map(Number).sort((a, b) => a - b)) {
    factionRace[String(f)] = method.factionShipRace[f];
  }
  const sourceHash = fingerprint({
    sde: { buildNumber: inputs.sde.buildNumber, releaseDate: inputs.sde.releaseDate },
    method,
    picked: rows.map((x) => [x.raceId, x.group, x.typeId, x.level, x.mineralSum, x.sampleSize]),
    raceSkills: method.races.map((r) => [r, uniqueSkills.get(r)]),
  });
  const header = {
    tableVersion: method.tableVersion,
    sdeBuild: inputs.sde.buildNumber,
    sdeReleaseDate: inputs.sde.releaseDate,
    sourceHash,
    groups: method.groups,
    typeCount: picked.size,
  };
  return { ok: true, header, races, factionRace, rows, source: serialize(header, races, factionRace) };
}

module.exports = { buildHullTradeTypes, HULL_TRADE_METHOD, WTB_GROUPS, levelOf, raceOf, uniqueRaceSkills };
