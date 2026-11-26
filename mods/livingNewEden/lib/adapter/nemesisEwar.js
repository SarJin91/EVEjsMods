"use strict";

const { PIRATE_KEY_BY_FACTION_ID } = require("./data/liveProfiles");

const MAX_DETAIL = 120;
const PATHS = Object.freeze({
  pools: "space/npc/pirateHullProfiles",
  npc: "space/npc/npcData",
  fitting: "services/fitting/liveFittingState",
  ewar: "space/npc/npcEntityEwarCatalog",
});
const FUNCTIONS = Object.freeze({
  pools: Object.freeze(["listPoolCandidates"]),
  npc: Object.freeze(["getNpcProfile"]),
  fitting: Object.freeze(["getTypeAttributeMap"]),
  ewar: Object.freeze(["resolveEntityEwarSpecs"]),
});
const PROFILE_TYPE_FIELD = "shipTypeID";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v) => typeof v === "string" && v !== "";
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function familiesFrom(mods, poolQuery, hullClass) {
  const list = mods.pools.listPoolCandidates(poolQuery, hullClass);
  if (!Array.isArray(list)) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "listPoolCandidates" };
  const byFamily = new Map();
  for (const c of list) {
    const profileId = c && isText(c.profileID) ? c.profileID : null;
    if (profileId === null) continue;
    const profile = mods.npc.getNpcProfile(profileId);
    const typeId = Math.trunc(Number(profile && profile[PROFILE_TYPE_FIELD]));
    if (!isId(typeId)) continue;
    const specs = mods.ewar.resolveEntityEwarSpecs(mods.fitting.getTypeAttributeMap(typeId));
    for (const s of Array.isArray(specs) ? specs : []) {
      if (!s || !isText(s.family) || !(Number(s.activationChance) > 0)) continue;
      const ids = byFamily.get(s.family) || [];
      if (!ids.includes(profileId)) ids.push(profileId);
      byFamily.set(s.family, ids);
    }
  }
  return { ok: true, byFamily };
}

function createNemesisEwar(deps) {
  const requireGame = deps && deps.requireGame;
  const cache = new Map();
  const built = new Set();
  const known = new Map();

  const modsOf = () => {
    if (typeof requireGame !== "function") return null;
    const out = {};
    for (const key of Object.keys(PATHS)) {
      const r = requireGame(PATHS[key]);
      const mod = r && r.ok === true && r.exports ? r.exports : null;
      if (!mod || !FUNCTIONS[key].every((name) => typeof mod[name] === "function")) return null;
      out[key] = mod;
    }
    const pools = out.pools.STANDARD_POOL_QUERY_BY_FACTION;
    return pools && typeof pools === "object" ? { ...out, poolsByKey: pools } : null;
  };

  function ewarProfilesOf(factionId, hullClass, family) {
    if (!isId(factionId) || !isText(hullClass) || !isText(family)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const pair = `${factionId}:${hullClass}`;
      if (!built.has(pair)) {
        const key = Object.hasOwn(PIRATE_KEY_BY_FACTION_ID, String(factionId))
          ? PIRATE_KEY_BY_FACTION_ID[String(factionId)] : null;
        if (key === null) return { ok: false, reason: "NO_PROFILE", detail: "faction" };
        const mods = modsOf();
        if (!mods) return { ok: false, reason: "SEAM_UNAVAILABLE" };
        const poolQuery = mods.poolsByKey[key];
        if (!isText(poolQuery)) return { ok: false, reason: "NO_PROFILE", detail: "pool" };
        const f = familiesFrom(mods, poolQuery, hullClass);
        if (!f.ok) return f;
        for (const [fam, ids] of f.byFamily) {
          cache.set(`${pair}:${fam}`, Object.freeze([...ids].sort()));
          for (const id of ids) {
            const pairs = known.get(id) || new Set();
            pairs.add(pair);
            known.set(id, pairs);
          }
        }
        built.add(pair);
      }
      const ids = cache.get(`${pair}:${family}`) || null;
      return ids && ids.length > 0 ? { ok: true, profileIds: ids } : { ok: false, reason: "NO_PROFILE" };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  const isEwarProfile = (profileId, factionId, hullClass) => typeof profileId === "string" && isId(factionId)
    && isText(hullClass) && known.has(profileId) && known.get(profileId).has(`${factionId}:${hullClass}`);

  return Object.freeze({ ewarProfilesOf, isEwarProfile });
}

module.exports = { PATHS, FUNCTIONS, PROFILE_TYPE_FIELD, createNemesisEwar };
