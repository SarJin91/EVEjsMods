"use strict";

const { isExpansionTarget } = require("../../strategy/ai/expansion");
const { createRng } = require("../../util/rng");
const { ATTENTION_FACTIONS } = require("./data/attention");

const CATEGORY_FREE = "free";
const CATEGORY_ACTIVE = "active";
const CATEGORY_OTHER = "other";

function candidatePool(graph) {
  const nullsec = graph.getSystemsBySecClass("nullsec");
  const out = [];
  for (const systemId of nullsec) {
    const sys = graph.getSystem(systemId);
    if (!sys) continue;
    if (!isExpansionTarget(sys)) continue;
    out.push(systemId);
  }
  out.sort((a, b) => a - b);
  return out;
}

function sampleTargets(pool, rng, k) {
  if (k >= pool.length) return [...pool];
  const arr = [...pool];
  for (let i = 0; i < k; i += 1) {
    const j = rng.nextInt(i, arr.length - 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, k);
}

function planRoll(snapshot, params, rng) {
  const {
    round, rollSeed, sampleSeed, openTotal, openByFaction,
    profiles, sampled, stationsReady,
  } = snapshot;

  const {
    chancePermille, maxActive, maxActivePerFaction, requireSovCheck, beachheadCaptureRangeJumps,
  } = params;

  const r = rng.nextInt(1, 1000);
  if (r > chancePermille) {
    return decision("NO_ROLL", { candidates: sampled.length });
  }

  if (!stationsReady) {
    return decision("STATIONS_NOT_READY", { candidates: sampled.length });
  }

  if (openTotal >= maxActive) {
    return decision("NO_ROOM", { candidates: sampled.length });
  }

  const eligibleProfiles = profiles.filter((p) =>
    p.eligible && p.weight > 0 && (openByFaction.get(p.factionId) || 0) < maxActivePerFaction
  ).sort((a, b) => a.factionId - b.factionId);

  if (eligibleProfiles.length === 0) {
    return decision("NO_FACTION", { candidates: sampled.length });
  }

  const bias = params.seasonBias;
  const weightOf = (p) => (bias && p.factionId === bias.factionId ? Math.floor(p.weight * bias.permille / 1000)
    : p.weight);
  const totalWeight = eligibleProfiles.reduce((sum, p) => sum + weightOf(p), 0);
  const pick = rng.nextInt(1, totalWeight);
  let acc = 0;
  let chosenProfile = null;
  for (const p of eligibleProfiles) {
    acc += weightOf(p);
    if (pick <= acc) { chosenProfile = p; break; }
  }
  if (!chosenProfile) return decision("NO_FACTION", { candidates: sampled.length });

  if (requireSovCheck && sampled.some((s) => s.claimed === null)) {
    return decision("SOV_UNAVAILABLE", { candidates: sampled.length, factionId: chosenProfile.factionId });
  }

  const filtered = sampled.filter((s) => eligibleTarget(s, chosenProfile.factionId, params, chosenProfile));

  if (filtered.length === 0) {
    return decision("NO_TARGET", { candidates: sampled.length, factionId: chosenProfile.factionId });
  }

  const weighted = filtered.map((s) => ({
    ...s,
    weight: targetWeight(s, params, chosenProfile),
  })).filter((s) => s.weight > 0).sort((a, b) => a.systemId - b.systemId);

  if (weighted.length === 0) {
    return decision("NO_TARGET", { candidates: sampled.length, factionId: chosenProfile.factionId });
  }

  const weightSum = weighted.reduce((sum, s) => sum + s.weight, 0);
  const pick2 = rng.nextInt(1, weightSum);
  let acc2 = 0;
  let target = null;
  for (const s of weighted) {
    acc2 += s.weight;
    if (pick2 <= acc2) { target = s; break; }
  }
  if (!target) return decision("NO_TARGET", { candidates: sampled.length, factionId: chosenProfile.factionId });

  const captureRangeJumps = chosenProfile.captureRangeJumps ?? beachheadCaptureRangeJumps;

  return {
    v: 1,
    round,
    rollSeed,
    sampleSeed,
    outcome: "SPAWN",
    factionId: chosenProfile.factionId,
    profileId: chosenProfile.profileId,
    targetSystemId: target.systemId,
    captureRangeJumps,
    candidates: sampled.length,
    targetControllerFactionId: target.row.controllerFactionId,
    targetCategory: target.category || controllerCategoryOf(target.row.controllerFactionId, null),
  };
}

function controllerCategoryOf(controllerFactionId, registry) {
  if (controllerFactionId === null || controllerFactionId === undefined) return CATEGORY_FREE;
  if (!registry || typeof registry.isActive !== "function" || !registry.isActive(controllerFactionId)) {
    return CATEGORY_OTHER;
  }
  const faction = typeof registry.getFaction === "function" ? registry.getFaction(controllerFactionId) : null;
  const doctrine = faction && faction.doctrineId && typeof registry.getDoctrine === "function"
    ? registry.getDoctrine(faction.doctrineId) : null;
  return doctrine && doctrine.fieldsDefense === true ? CATEGORY_ACTIVE : CATEGORY_OTHER;
}

function eligibleTarget(s, invaderFactionId, params, profile) {
  if (!s.row) return false;
  if (s.row.occupationState !== "STABLE") return false;
  if (s.row.controllerFactionId === invaderFactionId) return false;
  if (s.openBeachhead) return false;
  if (s.claimed === true) return false;
  if (params.avoidStationSystems && (s.liveStations || 0) > 0) return false;
  if (params.avoidObservedSystems && s.observed) return false;
  if (params.avoidCampaignTheatres && s.inTheatre) return false;
  if (s.core === true) return false;
  if (profile && typeof profile.targetListKey === "string"
    && !(s.lists && s.lists[profile.profileId] === true)) return false;
  return true;
}

function targetWeight(s, params, profile) {
  const category = s.category === undefined
    ? (s.row.controllerFactionId === null ? CATEGORY_FREE : CATEGORY_OTHER) : s.category;
  let w;
  if (category === CATEGORY_FREE) w = params.weightFree;
  else if (category === CATEGORY_ACTIVE) w = params.weightActive;
  else w = params.weightControlled;
  if (s.attention === true && profile && Number.isSafeInteger(params.attentionWeightPermille)
    && ATTENTION_FACTIONS.abyssal.includes(profile.factionId)) {
    return Math.floor(w * params.attentionWeightPermille / 1000);
  }
  return w;
}

function decision(outcome, extra = {}) {
  return { v: 1, outcome, ...extra };
}

function activeTheatreCampaignIds(strategy, onUnavailable) {
  if (!strategy || !strategy.registry || typeof strategy.registry.isTheatreSystem !== "function"
    || typeof strategy.listActiveCampaigns !== "function") return [];
  const unavailable = (kind, detail) => {
    if (typeof onUnavailable !== "function") return;
    try { onUnavailable(kind, detail); } catch (_err) {}
  };
  let r;
  try {
    r = strategy.listActiveCampaigns();
  } catch (err) {
    unavailable("THROW", String((err && err.message) || err));
    return [];
  }
  if (!r || r.ok !== true || !Array.isArray(r.campaigns)) {
    unavailable("REFUSED", String(r && r.reason));
    return [];
  }
  return r.campaigns.filter((c) => c && c.ok).map((c) => c.campaignId);
}

function inCampaignTheatre(campaignIds, registry, systemId) {
  if (!registry || typeof registry.isTheatreSystem !== "function") return false;
  return campaignIds.some((id) => registry.isTheatreSystem(id, systemId));
}

module.exports = { candidatePool, sampleTargets, planRoll, controllerCategoryOf, eligibleTarget, targetWeight,
  activeTheatreCampaignIds, inCampaignTheatre, CATEGORY_FREE, CATEGORY_ACTIVE, CATEGORY_OTHER };