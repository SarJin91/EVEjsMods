"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { RIVALS, REL, MAX_FACTIONS } = require("./data/standingRules");

const NO_PROFILE = 0xffff;
const KINDS = Object.freeze(["empire", "pirate"]);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function factionsOf(list) {
  const seen = new Map();
  for (const f of Array.isArray(list) ? list : []) {
    if (!f || !Number.isSafeInteger(f.factionId) || f.factionId <= 0 || !KINDS.includes(f.kind)) continue;
    if (!seen.has(f.factionId)) seen.set(f.factionId, f);
  }
  return [...seen.values()].sort((a, b) => a.factionId - b.factionId).slice(0, MAX_FACTIONS);
}

function buildStandingTables(input) {
  const T = input.S.standings;
  const list = factionsOf(input.factions);
  const F = list.length;
  const factionIds = Int32Array.from(list.map((f) => f.factionId));
  const factionIndex = new Map(list.map((f, i) => [f.factionId, i + 1]));
  const pirate = Uint8Array.from(list.map((f) => (f.kind === "pirate" ? 1 : 0)));
  const raceFaction = [-1];
  const raceOfRegion = new Map();
  for (let f = 0; f < F; f += 1) {
    const regions = Array.isArray(list[f].homeRegionIds) ? list[f].homeRegionIds : [];
    if (regions.length === 0) continue;
    const g = raceFaction.length;
    raceFaction.push(f);
    for (const r of regions) if (!raceOfRegion.has(r)) raceOfRegion.set(r, g);
  }
  const G = raceFaction.length;
  const K = T.profiles;
  const P = K * G;
  const size = input.table && Number.isSafeInteger(input.table.size) ? input.table.size : 0;
  const raceOfSystem = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) raceOfSystem[i] = raceOfRegion.get(input.table.regionId[i]) || 0;
  const rivalsOf = raceFaction.map((f) => {
    if (f < 0) return new Set();
    const ids = RIVALS[list[f].factionId] || [];
    return new Set(ids.map((id) => factionIndex.get(id)).filter((x) => x !== undefined).map((x) => x - 1));
  });
  const standing = new Int8Array(P * F);
  const rel = new Uint8Array(P * F);
  const base = new Int16Array(F);
  for (let k = 0; k < K; k += 1) {
    const rng = createRng(deriveSeed(input.worldSeed, "pop-standing-profile", k));
    for (let f = 0; f < F; f += 1) {
      const lo = pirate[f] ? T.pirateBaseMin : T.empireBaseMin;
      const hi = pirate[f] ? T.pirateBaseMax : T.empireBaseMax;
      base[f] = lo + Math.floor(rng.nextFloat() * (hi - lo + 1));
    }
    for (let g = 0; g < G; g += 1) {
      const at = (k * G + g) * F;
      for (let f = 0; f < F; f += 1) {
        const v = clamp(base[f] + (f === raceFaction[g] ? T.homeBonus : 0) - (rivalsOf[g].has(f) ? T.rivalPenalty : 0),
          -100, 100);
        standing[at + f] = v;
        rel[at + f] = v >= T.friendlyMin ? REL.FRIENDLY : v <= T.hostileMax ? REL.HOSTILE : REL.NEUTRAL;
      }
    }
  }
  return Object.freeze({ F, G, K, P, factionIds, factionIndex, pirate, raceOfSystem, standing, rel });
}

function tablesBytes(t) {
  return t ? t.factionIds.byteLength + t.pirate.byteLength + t.raceOfSystem.byteLength + t.standing.byteLength
    + t.rel.byteLength : 0;
}

function createStandings(deps) {
  const t = deps.tables;
  const { F, G, K, P } = t;
  const size = Math.max(0, Math.floor(deps.size) || 0);
  const cache = new Uint16Array(size + 1).fill(NO_PROFILE);
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => 0;
  const override = typeof deps.override === "function" ? deps.override : null;
  const identityOf = typeof deps.identityOf === "function" ? deps.identityOf : (id) => id;

  const norm = (profile) => (Number.isSafeInteger(profile) && profile >= 0 && P > 0 ? profile % P : -1);

  function ownProfile(pilotId) {
    try {
      const k = deriveSeed(deps.worldSeed, "pop-standing", identityOf(pilotId)) % K;
      const i = deps.indexOf(deps.homeOf(pilotId));
      const g = i !== undefined && i >= 0 && i < t.raceOfSystem.length ? t.raceOfSystem[i] : 0;
      return k * G + (g < G ? g : 0);
    } catch (_err) {
      return 0;
    }
  }

  function profileOfPilot(pilotId) {
    const cached = Number.isSafeInteger(pilotId) && pilotId >= 1 && pilotId <= size;
    if (cached && cache[pilotId] !== NO_PROFILE) return cache[pilotId];
    const p = ownProfile(pilotId);
    if (cached) cache[pilotId] = p;
    return p;
  }

  function profileOf(pilotId) {
    if (override) {
      let v = -1;
      try {
        v = override(pilotId);
      } catch (_err) {
        v = -1;
      }
      if (Number.isSafeInteger(v) && v >= 0) return norm(v);
    }
    return profileOfPilot(pilotId);
  }

  function standingOf(profile, factionId) {
    const p = norm(profile);
    const f = t.factionIndex.get(factionId);
    return p < 0 || f === undefined ? 0 : t.standing[p * F + f - 1];
  }

  function relationOf(profile, factionId) {
    const p = norm(profile);
    const f = t.factionIndex.get(factionId);
    return p < 0 || f === undefined ? REL.NEUTRAL : t.rel[p * F + f - 1];
  }

  function distance(a, b) {
    if (F === 0) return 0;
    const pa = norm(a);
    const pb = norm(b);
    let sum = 0;
    for (let f = 0; f < F; f += 1) {
      sum += Math.abs((pa < 0 ? 0 : t.standing[pa * F + f]) - (pb < 0 ? 0 : t.standing[pb * F + f]));
    }
    return Math.round(sum / F);
  }

  function census(n, topN) {
    const t0 = nowMs();
    const counts = new Int32Array(P);
    const last = Math.max(0, Math.floor(n) || 0);
    for (let id = 1; id <= last; id += 1) {
      if (typeof deps.has === "function" && deps.has(id) !== true) continue;
      const p = profileOf(id);
      if (p >= 0 && p < P) counts[p] += 1;
    }
    const byFaction = [];
    for (let f = 0; f < F; f += 1) {
      const c = [0, 0, 0];
      for (let p = 0; p < P; p += 1) if (counts[p] > 0) c[t.rel[p * F + f]] += counts[p];
      byFaction.push(Object.freeze({ factionId: t.factionIds[f], kind: t.pirate[f] ? "pirate" : "empire",
        friendly: c[REL.FRIENDLY], neutral: c[REL.NEUTRAL], hostile: c[REL.HOSTILE] }));
    }
    const used = [];
    for (let p = 0; p < P; p += 1) if (counts[p] > 0) used.push([p, counts[p]]);
    used.sort((x, y) => y[1] - x[1] || x[0] - y[0]);
    const top = used.slice(0, Math.max(0, Math.floor(topN) || 0)).map(([profile, pilots]) => Object.freeze({ profile,
      pilots }));
    return Object.freeze({ byFaction: Object.freeze(byFaction), top: Object.freeze(top),
      ms: Math.max(0, nowMs() - t0) });
  }

  function forget(pilotId) {
    if (Number.isSafeInteger(pilotId) && pilotId >= 1 && pilotId <= size) cache[pilotId] = NO_PROFILE;
  }

  return Object.freeze({ profileOfPilot, profileOf, standingOf, relationOf, distance, census, forget,
    profileCount: () => P,
    approxBytes: () => tablesBytes(t) + cache.byteLength });
}

module.exports = { buildStandingTables, createStandings, tablesBytes };
