"use strict";

const { deriveSeed } = require("../util/rng");

const PERMILLE = 1000;

function homeIdle(characterId, bucket, seed, permille) {
  if (!(permille > 0)) return false;
  if (permille >= PERMILLE) return true;
  return deriveSeed(seed >>> 0, "fc-home", characterId, bucket) % PERMILLE < permille;
}

const bySystemThenCorp = (key) => (a, b) => a[key] - b[key] || a.corpId - b.corpId;

function pickResidents(input) {
  const observed = new Set(Array.isArray(input.systems) ? input.systems : []);
  const max = Math.max(0, Math.trunc(Number(input.maxPerSystem) || 0));
  const seen = new Set();
  const crews = new Map();
  const homes = new Map();
  const corps = new Set();
  const add = (target, systemId, ids) => {
    let list = target.get(systemId);
    if (!list) {
      list = [];
      target.set(systemId, list);
    }
    for (const id of ids) {
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      list.push(id);
    }
  };
  const crewOf = (crew, ids) => Math.min(Math.max(0, Math.trunc(Number(crew) || 0)), ids.length);
  for (const v of [...(input.ventures || [])].sort(bySystemThenCorp("systemId"))) {
    if (!v || !observed.has(v.systemId)) continue;
    const ids = input.membersOf(v.corpId);
    if (!Array.isArray(ids)) continue;
    const crew = ids.slice(0, crewOf(v.crew, ids));
    if (crew.length > 0) corps.add(v.corpId);
    add(crews, v.systemId, crew);
  }
  for (const h of [...(input.homes || [])].sort(bySystemThenCorp("homeSystemId"))) {
    if (!h || !observed.has(h.homeSystemId)) continue;
    const ids = input.membersOf(h.corpId);
    if (!Array.isArray(ids)) continue;
    const rest = ids.slice(h.venture ? crewOf(h.venture.crew, ids) : 0)
      .filter((id) => homeIdle(id, input.bucket, input.seed, input.homeIdlePermille));
    if (rest.length > 0) corps.add(h.corpId);
    add(homes, h.homeSystemId, rest);
  }
  const bySystem = new Map();
  let cut = 0;
  for (const systemId of [...observed].sort((a, b) => a - b)) {
    const all = [...(crews.get(systemId) || []), ...(homes.get(systemId) || [])];
    if (all.length === 0) continue;
    const kept = all.slice(0, max);
    cut += all.length - kept.length;
    if (kept.length > 0) bySystem.set(systemId, kept);
  }
  return { bySystem, cut, corps: corps.size };
}

module.exports = { homeIdle, pickResidents };
