"use strict";

const { CAPTURE_TARGETS } = require("../data/doctrines");
const { garrisonPowerOf } = require("./strength");
const { premiumExtra } = require("./playerValue");

const OCCUPATION_STABLE = "STABLE";

function usableKinds(snapshot, params) {
  const d = snapshot.doctrine;
  return params.kinds.filter((k) => k.enabled === true && d.operationTypes.includes(k.operationType)
    && (k.needsCanOccupy !== true || d.canOccupy === true));
}

function effectiveIntel(snapshot) {
  const out = new Map();
  for (const i of snapshot.intel) out.set(i.systemId, i);
  for (const s of snapshot.sightings) {
    let fleets = 0;
    let ships = 0;
    let strength = 0;
    for (const h of s.hostile) {
      fleets += h.fleets;
      ships += h.ships;
      strength += h.strength;
    }
    out.set(s.systemId, { systemId: s.systemId, observedAt: snapshot.at, hostileFleets: fleets, hostileShips: ships,
      hostileStrength: strength, hostileStations: s.hostileStations, controllerFactionId: s.controllerFactionId });
  }
  return out;
}

function intelWithExtra(snapshot) {
  const base = snapshot.intel || [];
  return Array.isArray(snapshot.extraIntel) && snapshot.extraIntel.length > 0 ? base.concat(snapshot.extraIntel) : base;
}

const isFresh = (intel, at, ttl) => Boolean(intel) && intel.observedAt >= at - ttl;
const BATTLE_SOURCE = "battle";

function ttlOf(intel, params) {
  const b = params.battleIntelTtlMs;
  if (intel && intel.source === BATTLE_SOURCE && Number.isFinite(b) && b > 0) return b;
  return params.intelTtlMs;
}
const CLAIM_STATES = Object.freeze(["CONTESTED", "INVASION"]);

function expansionSet(snapshot) {
  const theatre = new Set(snapshot.theatre);
  return new Set((snapshot.expansion || []).filter((id) => !theatre.has(id)));
}

function borderSet(snapshot) {
  const b = snapshot.border;
  if (!b || b.mode !== "ready" || !Array.isArray(b.candidates)) return new Set();
  const skip = new Set([...snapshot.theatre, ...(snapshot.expansion || [])]);
  return new Set(b.candidates.filter((id) => !skip.has(id)));
}

function raidSet(snapshot) {
  return new Set(Array.isArray(snapshot.raidTargets) ? snapshot.raidTargets : []);
}

function captureOnlyOf(snapshot, systemId) {
  return expansionSet(snapshot).has(systemId) && !raidSet(snapshot).has(systemId);
}

function categoryOf(snapshot, params, facts, systemId) {
  if (!facts.sys) return null;
  const s = facts.sys;
  if (s.homeFactionId === snapshot.factionId && (facts.controller === null || facts.hostileController)) {
    const d = snapshot.doctrine;
    const targets = Array.isArray(d.captureTargets) ? d.captureTargets : (d.canOccupy === true ? CAPTURE_TARGETS : []);
    if (targets.includes("home")) return "home";
  }
  if (facts.controller === null) return "free";
  if (!facts.hostileController) return null;
  if (snapshot.theatre.includes(systemId)) return "contested";
  if (s.occupationState && s.occupationState !== OCCUPATION_STABLE) return "contested";
  if (Number.isFinite(params.reclaimMinInfluence) && (s.ownInfluence || 0) >= params.reclaimMinInfluence) {
    return "contested";
  }
  return "hostile";
}

function captureAllowed(snapshot, category) {
  const d = snapshot.doctrine;
  const targets = Array.isArray(d.captureTargets) ? d.captureTargets : (d.canOccupy === true ? CAPTURE_TARGETS : []);
  return category !== null && targets.includes(category);
}

function adjacentOwn(snapshot, supply, systemId) {
  const f = snapshot.factionId;
  const sys = snapshot.systems.find((s) => s.systemId === systemId);
  if (sys && sys.controllerFactionId === f) return true;
  if (Array.isArray(snapshot.capturedIds) && snapshot.capturedIds.includes(systemId)) return true;
  if (Array.isArray(snapshot.footholds) && snapshot.footholds.some((fh) => fh.systemId === systemId)) return true;
  if (supply.border instanceof Map && supply.border.get(systemId) === 1) return true;
  const neighbours = snapshot.neighbors(systemId) || [];
  for (const nbId of neighbours) {
    const nb = snapshot.systems.find((s) => s.systemId === nbId);
    if (nb && nb.controllerFactionId === f) return true;
    if (Array.isArray(snapshot.capturedIds) && snapshot.capturedIds.includes(nbId)) return true;
    if (Array.isArray(snapshot.footholds) && snapshot.footholds.some((fh) => fh.systemId === nbId)) return true;
    if (supply.border instanceof Map && supply.border.get(nbId) === 1) return true;
  }
  return false;
}

function hiveAdjacent(snapshot, systemId) {
  const f = snapshot.factionId;
  for (const nbId of snapshot.neighbors(systemId) || []) {
    const nb = snapshot.systems.find((s) => s.systemId === nbId);
    if (nb && nb.controllerFactionId === f) return true;
    if (Array.isArray(snapshot.capturedIds) && snapshot.capturedIds.includes(nbId)) return true;
    if (Array.isArray(snapshot.footholds) && snapshot.footholds.some((fh) => fh.systemId === nbId)) return true;
  }
  return false;
}

function captureBlock(snapshot, supply, params, facts, systemId) {
  if (facts.category === "home") return null;
  if (supply.warCaptureShort === true) return "WAR_CHEST_SHORT";
  if (supply.captureRoom !== null && !(supply.captureRoom > 0)) return "TERRITORY_LIMIT";
  if (params.captureRequiresAdjacency === true && !adjacentOwn(snapshot, supply, systemId)) return "CAPTURE_NOT_ADJACENT";
  return null;
}

const EMPTY_KILLS = new Map();
const playerKillMemo = new WeakMap();
function playerKillsOf(snapshot) {
  const list = snapshot.playerActivity;
  if (!Array.isArray(list)) return EMPTY_KILLS;
  let map = playerKillMemo.get(list);
  if (!map) {
    map = new Map(list.map((x) => [x.systemId, x.kills]));
    playerKillMemo.set(list, map);
  }
  return map;
}

function describe(snapshot, params, intelMap, systemId) {
  const sys = snapshot.systems.find((s) => s.systemId === systemId) || null;
  const controller = sys ? sys.controllerFactionId : null;
  const hostileController = controller !== null && controller !== snapshot.factionId && snapshot.isHostile(controller);
  const intel = intelMap.get(systemId) || null;
  const fresh = isFresh(intel, snapshot.at, ttlOf(intel, params));
  const ge = params.garrisonEstimate;
  const garrison = ge && ge.mode === "resolver"
    ? garrisonPowerOf(hostileController && sys
      ? (ge.influencePoints === false ? 0 : Number(sys.controllerGarrison) || 0) + (Number(sys.devGarrison) || 0)
      + (Number(sys.hostileStations) || 0) * (Number(ge.stationPoints) || 0) : 0, ge.powerPerPoint)
    : (hostileController && sys ? sys.controllerGarrison : 0);
  const enemyStrength = (fresh ? intel.hostileStrength : 0) + garrison;
  const claimedByOther = Boolean(sys) && Number.isSafeInteger(sys.occupierFactionId)
    && sys.occupierFactionId !== snapshot.factionId && CLAIM_STATES.includes(sys.occupationState);
  const facts = { sys, controller, hostileController, intel: fresh ? intel : null, fresh, garrison, enemyStrength,
    claimedByOther };
  facts.category = categoryOf(snapshot, params, facts, systemId);
  facts.captureAllowed = captureAllowed(snapshot, facts.category);
  facts.passive = hostileController && typeof snapshot.isPlaying === "function"
    && snapshot.isPlaying(controller) !== true;
  if (facts.passive && facts.category === "hostile") facts.captureAllowed = false;
  facts.hive = hostileController && typeof snapshot.isHive === "function" && snapshot.isHive(controller) === true;
  if (facts.hive && params.hive) facts.enemyStrength += params.hive.assumedGarrisonStrength;
  const owner = snapshot.coreOwners instanceof Map ? snapshot.coreOwners.get(systemId) : undefined;
  facts.core = owner !== undefined && owner !== snapshot.factionId;
  if (facts.core) facts.captureAllowed = false;
  if (snapshot.lowsecIds instanceof Set && snapshot.lowsecIds.has(systemId)) facts.captureAllowed = false;
  facts.playerKills = playerKillsOf(snapshot).get(systemId) || 0;
  return facts;
}

function attackKind(kinds, supply, facts, systemId, opts) {
  const attacks = kinds.filter((k) => k.offensive === true && k.needsIntel === true);
  const capture = facts.claimedByOther === true || facts.captureAllowed === false ? null
    : attacks.find((k) => k.captures === true && supply.captureReach.has(systemId));
  if (capture) {
    if (opts && opts.snapshot && opts.params) {
      const block = captureBlock(opts.snapshot, supply, opts.params, facts, systemId);
      if (block !== null) {
        if (opts.blocked instanceof Set) opts.blocked.add(block);
      } else {
        return capture;
      }
    } else {
      return capture;
    }
  }
  if (opts && opts.captureOnly === true) return null;
  if (!facts.hostileController || facts.hive === true) return null;
  return attacks.find((k) => k.captures !== true) || null;
}

function scoreCandidate(snapshot, params, facts, systemId, jumps) {
  const w = params.scoring;
  const own = (id) => {
    const s = snapshot.systems.find((x) => x.systemId === id);
    return Boolean(s) && s.controllerFactionId === snapshot.factionId;
  };
  const neighbours = snapshot.neighbors(systemId) || [];
  const region = snapshot.regionOf(systemId);
  const penalty = Math.max(w.strengthPenaltyCap, Math.floor(facts.enemyStrength / w.strengthUnit) * w.strengthPer1000);
  const economyBonus = (facts.hostileController && !facts.captureAllowed && facts.sys && facts.sys.richnessPermille)
    ? Math.floor(w.hostileEconomyPer1000 * (facts.sys.richnessPermille || 0) / 1000)
    : 0;
  const homeReclaimBonus = (facts.category === "home" && w.homeReclaim) ? w.homeReclaim : 0;
  const playerActivity = facts.playerKills > 0 && Number.isSafeInteger(w.playerActivityPerKill)
    && Number.isSafeInteger(w.playerActivityCap)
    ? Math.max(w.playerActivityCap, facts.playerKills * w.playerActivityPerKill) : 0;
  const hostileW = facts.hive === true ? w.hiveControlled
    : (params.hostilePremiumCaptureOnly === true
      ? (facts.captureAllowed === true && facts.captureBlocked !== true ? w.hostileControlled : 0)
      : w.hostileControlled);
  return w.base + w.perJump * jumps + (facts.controller === null ? w.free : 0)
    + (facts.hostileController ? hostileW : 0)
    + w.adjacentOwn * neighbours.filter(own).length
    + w.hostileStation * (facts.sys ? facts.sys.hostileStations : 0)
    + (region !== null && snapshot.entry.homeRegionIds.includes(region) ? w.homeRegion : 0)
    + (facts.fresh ? 0 : w.unknownIntel) + penalty
    + (facts.sys && facts.sys.observed ? w.playerObserved : 0)
    + economyBonus
    + homeReclaimBonus
    + playerActivity
    + (facts.playerSov === true && params.playerSov ? params.playerSov.targetPremium : 0)
    + (params.playerValue
      ? premiumExtra(snapshot.playerValue, systemId, facts.playerSov === true, params.playerValue) : 0);
}

function candidateFacts(snapshot, params, supply, kinds, intelMap, systemId, captureOnly) {
  if (snapshot.doctrine.confinedToBelt === true) {
    if (!(supply.border instanceof Map) || !supply.border.has(systemId)) return null;
  }
  const facts = describe(snapshot, params, intelMap, systemId);
  const bastionOwner = snapshot.bastionOwners instanceof Map ? snapshot.bastionOwners.get(systemId) : undefined;
  if (bastionOwner !== undefined && bastionOwner !== snapshot.factionId) return null;
  if (facts.core && params.coreRaidsAllowed !== true) return null;
  if (facts.hive === true && !hiveAdjacent(snapshot, systemId)) return null;
  if (facts.sys === null || facts.controller === snapshot.factionId) return null;
  if (facts.controller !== null && !facts.hostileController) return null;
  if (facts.controller === null && snapshot.doctrine.canOccupy !== true) return null;
  if (snapshot.doctrine.capturesStations === false && facts.sys && facts.sys.hostileStations > 0) return null;
  const k = attackKind(kinds, supply, facts, systemId, { captureOnly, snapshot, params });
  if (k === null) return null;
  if (supply.raidFull === true && k.captures !== true) return null;
  if (params.hostilePremiumCaptureOnly === true) facts.capturable = k.captures === true;
  if (params.hostilePremiumCaptureOnly === true) {
    const block = captureBlock(snapshot, supply, params, facts, systemId);
    facts.captureBlocked = block !== null;
  }
  const ps = playerSovOf(snapshot, params, systemId);
  if (ps !== null) {
    if (playerSovSkipped(snapshot, params, supply, ps, k, systemId)) return null;
    facts.playerSov = true;
  }
  return facts;
}

function playerSovOf(snapshot, params, systemId) {
  if (!params.playerSov || !(snapshot.playerSov instanceof Map)) return null;
  return snapshot.playerSov.get(systemId) || null;
}

function playerSovSkipped(snapshot, params, supply, ps, k, systemId) {
  const notes = supply.playerSovNotes instanceof Set ? supply.playerSovNotes : new Set();
  const max = params.playerSov.maxSiegesPerFaction;
  const pending = playerSovPending(snapshot, params, supply);
  const rows = Number.isSafeInteger(snapshot.playerSovSieges) ? snapshot.playerSovSieges : 0;
  const sieges = rows + pending.size;
  const engaged = ps.siegedBySelf === true || pending.has(systemId);
  if (ps.hostile !== true) notes.add("PLAYER_SOV_FRIENDLY");
  else if (ps.ownerSeen !== true) notes.add("PLAYER_SOV_INACTIVE");
  else if (ps.siegedByOther === true) notes.add("PLAYER_SOV_BUSY");
  else if (!(max > 0) || (!engaged && sieges >= max)) notes.add("PLAYER_SOV_LIMIT");
  else if (k.captures !== true) notes.add("PLAYER_SOV_NO_CAPTURE");
  else return false;
  return true;
}

function playerSovPending(snapshot, params, supply) {
  const out = new Set();
  const live = snapshot.playerSov;
  const add = (id) => {
    const ps = live.get(id);
    if (ps && ps.siegedBySelf !== true && ps.siegedByOther !== true) out.add(id);
  };
  const capturing = new Set((params.kinds || []).filter((x) => x.captures === true).map((x) => x.operationType));
  for (const op of Array.isArray(snapshot.operations) ? snapshot.operations : []) {
    if (op && capturing.has(op.operationType)) add(op.targetSystemId);
  }
  if (supply.playerSovLaunched instanceof Set) for (const id of supply.playerSovLaunched) add(id);
  return out;
}

function countCaptureCandidates(snapshot, supply, params) {
  const intelMap = effectiveIntel(snapshot);
  const kinds = usableKinds(snapshot, params);
  const ids = new Set([...snapshot.theatre, ...expansionSet(snapshot), ...borderSet(snapshot)]);
  let n = 0;
  for (const systemId of ids) {
    if (!supply.captureReach.has(systemId)) continue;
    const facts = candidateFacts(snapshot, params, supply, kinds, intelMap, systemId, true);
    if (facts !== null && facts.hive !== true) n += 1;
  }
  return n;
}

function chooseTargetSystem(snapshot, supply, params, rng) {
  if (supply.anchors.length === 0) return { ok: false, reason: "NO_ANCHOR" };
  const intelMap = effectiveIntel(snapshot);
  const kinds = usableKinds(snapshot, params);
  const fronts = new Set(supply.frontTargets);
  const open = Array.isArray(supply.openFronts) ? supply.openFronts : supply.frontTargets;
  const isHiveSystem = (id) => (Array.isArray(snapshot.hiveFrontIds) && snapshot.hiveFrontIds.includes(id))
    || snapshot.systems.some((x) => x.systemId === id && typeof snapshot.isHive === "function"
      && snapshot.isHive(x.controllerFactionId) === true);
  const hiveFull = params.hive ? open.filter(isHiveSystem).length >= params.hive.maxFrontsPerAttacker : false;
  const raw = [];
  const consider = (systemId, jumps, captureOnly) => {
    const facts = candidateFacts(snapshot, params, supply, kinds, intelMap, systemId, captureOnly);
    if (facts !== null && hiveFull && facts.hive === true) return;
    if (facts !== null) raw.push({ systemId, jumps, facts });
  };
  const homeOnly = supply.homeOnly === true;
  const exp = expansionSet(snapshot);
  const raids = raidSet(snapshot);
  const border = borderSet(snapshot);
  for (const systemId of homeOnly ? [] : snapshot.theatre) {
    if (!supply.reach.has(systemId) || fronts.has(systemId)) continue;
    consider(systemId, supply.reach.get(systemId), false);
  }
  for (const systemId of homeOnly ? [] : exp) {
    if (!supply.captureReach.has(systemId) || fronts.has(systemId)) continue;
    consider(systemId, supply.captureReach.get(systemId), !raids.has(systemId));
  }
  for (const systemId of homeOnly ? [] : border) {
    if (!supply.reach.has(systemId) || fronts.has(systemId)) continue;
    consider(systemId, supply.reach.get(systemId), false);
  }
  const considered = new Set([...snapshot.theatre, ...exp, ...border]);
  for (const systemId of homeOnly ? [] : raids) {
    if (considered.has(systemId)) continue;
    if (!supply.reach.has(systemId) || fronts.has(systemId)) continue;
    consider(systemId, supply.reach.get(systemId), false);
  }
  const seen = new Set(raw.map((c) => c.systemId));
  const lostHome = (snapshot.lostHome && snapshot.lostHome.systemIds) || [];
  for (const systemId of lostHome) {
    if (seen.has(systemId) || fronts.has(systemId)) continue;
    if (supply.captureReach.has(systemId)) {
      consider(systemId, supply.captureReach.get(systemId), false);
      seen.add(systemId);
    } else if (supply.reach.has(systemId)) {
      consider(systemId, supply.reach.get(systemId), false);
      seen.add(systemId);
    }
  }
  if (raw.length === 0) return { ok: false, reason: "NO_CANDIDATE" };
  raw.sort((a, b) => {
    const catA = a.facts.category === "home" ? 0 : 1;
    const catB = b.facts.category === "home" ? 0 : 1;
    if (catA !== catB) return catA - catB;
    return a.jumps - b.jumps || a.systemId - b.systemId;
  });
  const candidates = raw.slice(0, params.maxTargetCandidates).map((c) => ({ systemId: c.systemId, jumps: c.jumps,
    score: scoreCandidate(snapshot, params, c.facts, c.systemId, c.jumps) }));
  candidates.sort((a, b) => b.score - a.score || a.systemId - b.systemId);
  const top = candidates.slice(0, Math.max(1, params.targetPickTopK));
  const min = Math.min(...top.map((c) => c.score));
  const weights = top.map((c) => c.score - min + 1);
  const total = weights.reduce((s, x) => s + x, 0);
  let cursor = rng.nextInt(1, total);
  let chosen = top[top.length - 1];
  for (let i = 0; i < top.length; i += 1) {
    cursor -= weights[i];
    if (cursor <= 0) {
      chosen = top[i];
      break;
    }
  }
  return { ok: true, systemId: chosen.systemId, score: chosen.score, candidates: candidates.length,
    jumps: chosen.jumps };
}

module.exports = { chooseTargetSystem, scoreCandidate, usableKinds, effectiveIntel, describe, attackKind, isFresh,
  expansionSet, borderSet, raidSet, captureOnlyOf, categoryOf, captureAllowed, countCaptureCandidates, candidateFacts,
  adjacentOwn, captureBlock, ttlOf, intelWithExtra };
