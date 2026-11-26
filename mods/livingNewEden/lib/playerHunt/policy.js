"use strict";

const { deriveSeed, deterministicUnit } = require("../util/rng");
const { planRepel } = require("./repel");

const PERMILLE = 1000;

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function classifyStanding(standing, thresholds) {
  const value = isNum(standing) ? standing : 0;
  if (value <= thresholds.hostileMax) return "hostile";
  if (value >= thresholds.friendlyMin) return "friendly";
  return "neutral";
}

function huntThresholds(s) {
  const friendlyMin = s.loyaltySpareEnabled === true && isNum(s.loyaltySpareStandingMin)
    ? Math.min(s.friendlyStandingMin, s.loyaltySpareStandingMin) : s.friendlyStandingMin;
  return { hostileMax: s.hostileStandingMax, friendlyMin };
}

function isTarget(cls, factionKind, neutralPolicy) {
  if (typeof factionKind !== "string" || factionKind === "") return false;
  if (cls === "hostile") return true;
  if (cls !== "neutral") return false;
  return Boolean(neutralPolicy) && Object.prototype.hasOwnProperty.call(neutralPolicy, factionKind)
    && neutralPolicy[factionKind] === "hostile";
}

function relationOf(standing, factionKind, thresholds, neutralPolicy) {
  if (!isNum(standing) || !thresholds) return null;
  const cls = classifyStanding(standing, thresholds);
  if (isTarget(cls, factionKind, neutralPolicy)) return "hostile";
  return cls === "friendly" ? "friendly" : "neutral";
}

function hasScanner(composition, scannerHullGroups) {
  if (!Array.isArray(composition) || !Array.isArray(scannerHullGroups)) return false;
  return composition.some((e) => e && scannerHullGroups.includes(e.hullGroup) && Number.isSafeInteger(e.count)
    && e.count > 0);
}

function sweepOrder(objects, kinds, seed) {
  if (!Array.isArray(objects) || !Array.isArray(kinds)) return [];
  const list = objects.filter((o) => o && kinds.includes(o.kind) && Number.isSafeInteger(o.itemId))
    .map((o) => ({ kind: o.kind, itemId: o.itemId }))
    .sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.itemId - b.itemId);
  const n = list.length;
  if (n === 0) return [];
  const start = (Number.isSafeInteger(seed) && seed >= 0 ? seed : 0) % n;
  return [...list.slice(start), ...list.slice(0, start)];
}

function scanRoll(seed, cycle, signatureRadius, p) {
  const ref = isNum(p.refSignatureM) && p.refSignatureM > 0 ? p.refSignatureM : 1;
  const sig = isNum(signatureRadius) && signatureRadius > 0 ? signatureRadius : ref;
  const raw = Math.round((p.basePermille * sig) / ref);
  const chancePermille = Math.min(p.maxPermille, Math.max(p.minPermille, raw));
  const roll = Math.floor(deterministicUnit(deriveSeed(seed >>> 0, "scan", cycle)) * PERMILLE);
  return { chancePermille, found: roll < chancePermille };
}

function distSqOf(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);

function dscanOrder(objects, quarryPos, seed, p) {
  if (!Array.isArray(objects)) return [];
  const copy = [...objects];
  const range = p && isNum(p.rangeMeters) && p.rangeMeters > 0 ? p.rangeMeters : 0;
  const noisePm = p && isNum(p.noisePermille) && p.noisePermille > 0 ? Math.min(PERMILLE, p.noisePermille) : 0;
  if (!isPoint(quarryPos) || copy.length < 3 || !copy[0] || !isPoint(copy[0].position)) return copy;
  if (distSqOf(copy[0].position, quarryPos) > range * range) return copy;
  const base = Number.isSafeInteger(seed) ? seed >>> 0 : 0;
  const keyed = copy.slice(1).map((o) => {
    const itemId = o && Number.isSafeInteger(o.itemId) ? o.itemId : 0;
    if (!o || !isPoint(o.position)) return { o, itemId, key: Infinity };
    const noise = noisePm === 0 ? 0
      : Math.round(((2 * deterministicUnit(deriveSeed(base, "dscan", itemId))) - 1) * noisePm);
    return { o, itemId, key: (Math.sqrt(distSqOf(o.position, quarryPos)) * (PERMILLE + noise)) / PERMILLE };
  });
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.itemId - b.itemId));
  return [copy[0], ...keyed.map((k) => k.o)];
}

const ANOMALY_KIND = "anomaly";

function placeAnomalies(objects, quarryPos, maxAnomalies) {
  const list = Array.isArray(objects) ? objects.filter(Boolean) : [];
  const anomalies = list.filter((o) => o.kind === ANOMALY_KIND);
  if (anomalies.length === 0) return { objects: [...list], anchorless: false, dropped: 0 };
  const others = list.filter((o) => o.kind !== ANOMALY_KIND);
  if (others.length === 0) return { objects: [], anchorless: true, dropped: 0 };
  const max = Number.isSafeInteger(maxAnomalies) && maxAnomalies >= 1 ? maxAnomalies : 1;
  const hasQuarry = isPoint(quarryPos);
  const idOf = (o) => (Number.isSafeInteger(o.itemId) ? o.itemId : 0);
  const keyed = anomalies.map((o) => ({ o, itemId: idOf(o),
    key: !isPoint(o.position) ? Infinity : hasQuarry ? distSqOf(o.position, quarryPos) : 0 }));
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.itemId - b.itemId));
  const kept = keyed.slice(0, max).map((k) => k.o);
  return { objects: [others[0], ...kept, ...others.slice(1)], anchorless: false, dropped: keyed.length - kept.length };
}

function retargetTowardQuarry(objects, objectIndex, quarryPos, gridRadiusMeters, extra) {
  if (!isPoint(quarryPos) || !isNum(gridRadiusMeters) || !(gridRadiusMeters > 0)) return null;
  const list = Array.isArray(objects) ? objects : [];
  const gridSq = gridRadiusMeters * gridRadiusMeters;
  const near = (o) => Boolean(o) && isPoint(o.position) && distSqOf(o.position, quarryPos) <= gridSq;
  const current = Number.isSafeInteger(objectIndex) ? list[objectIndex] : null;
  if (near(current)) return null;
  const idOf = (o) => (Number.isSafeInteger(o.itemId) ? o.itemId : null);
  const best = (candidates) => {
    let pick = null;
    for (const c of candidates) {
      if (!near(c.o)) continue;
      const key = distSqOf(c.o.position, quarryPos);
      const id = idOf(c.o) === null ? 0 : idOf(c.o);
      if (pick === null || key < pick.key || (key === pick.key && id < pick.id)) pick = { ...c, key, id };
    }
    return pick;
  };
  const inSweep = best(list.map((o, i) => ({ o, i })).filter((c) => c.i !== objectIndex));
  if (inSweep) return { objectIndex: inSweep.i, itemId: idOf(inSweep.o), point: { ...inSweep.o.position } };
  const outside = best((Array.isArray(extra) ? extra : []).map((o) => ({ o, i: null })));
  if (outside) return { objectIndex: null, itemId: idOf(outside.o), point: { ...outside.o.position } };
  return null;
}

function pickCandidate(fleets, opts) {
  if (!Array.isArray(fleets) || !opts) return null;
  const excluded = Array.isArray(opts.excludedFactions) ? opts.excludedFactions : [];
  const hasKind = (factionId) => {
    try {
      const kind = typeof opts.factionKindOf === "function" ? opts.factionKindOf(factionId) : null;
      return typeof kind === "string" && kind !== "";
    } catch (_err) {
      return false;
    }
  };
  const ok = fleets.filter((f) => f && f.state === "IDLE" && (f.operationId === null || f.operationId === undefined)
    && f.refitPending !== true && Array.isArray(opts.roles) && opts.roles.includes(f.fleetRole)
    && Number.isSafeInteger(f.shipCount) && f.shipCount > 0
    && (opts.oversizeOk === true || f.shipCount <= opts.maxShips)
    && !excluded.includes(f.factionId) && hasKind(f.factionId));
  ok.sort(compareHuntCandidates);
  return ok.length > 0 ? ok[0] : null;
}

function compareHuntCandidates(a, b) {
  const sa = Number.isSafeInteger(a.shipCount) ? a.shipCount : 0;
  const sb = Number.isSafeInteger(b.shipCount) ? b.shipCount : 0;
  return sb - sa || (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0);
}

function pickClaimCandidates(fleets, claim, opts) {
  if (!Array.isArray(fleets) || !opts || !claim || !Number.isSafeInteger(claim.occupierFactionId)) return [];
  const pretender = claim.occupierFactionId;
  const excluded = Array.isArray(opts.excludedFactions) ? opts.excludedFactions : [];
  if (excluded.includes(pretender)) return [];
  let kind = null;
  try {
    kind = typeof opts.factionKindOf === "function" ? opts.factionKindOf(pretender) : null;
  } catch (_err) {
    kind = null;
  }
  if (typeof kind !== "string" || kind === "") return [];
  const roles = Array.isArray(opts.roles) ? opts.roles : [];
  const ok = fleets.filter((f) => f && f.factionId === pretender
    && ((f.state === "IDLE" && (f.operationId === null || f.operationId === undefined)) || f.state === "STAGED")
    && f.refitPending !== true && roles.includes(f.fleetRole)
    && Number.isSafeInteger(f.shipCount) && f.shipCount > 0
    && (opts.oversizeOk === true || f.shipCount <= opts.maxShips));
  ok.sort((a, b) => b.shipCount - a.shipCount || (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
  return ok;
}

const CAPSULE_CLASS = "capsule";

function buildGroupIndex(types) {
  const out = new Map();
  if (!types || typeof types !== "object") return out;
  const rows = Object.values(types).filter((t) => t && Number.isSafeInteger(t.typeId)
    && Number.isSafeInteger(t.groupId) && t.groupId > 0 && typeof t.hullGroup === "string" && t.hullGroup !== "")
    .sort((a, b) => a.typeId - b.typeId);
  for (const t of rows) if (!out.has(t.groupId)) out.set(t.groupId, t.hullGroup);
  return out;
}

function hullClassOf(ship, types, groupIndex) {
  if (!ship || typeof ship !== "object") return null;
  if (ship.capsule === true) return CAPSULE_CLASS;
  const typeId = Number.isSafeInteger(ship.typeId) && ship.typeId > 0 ? ship.typeId : null;
  if (typeId === null) return null;
  const known = types && Object.prototype.hasOwnProperty.call(types, String(typeId)) ? types[String(typeId)] : null;
  if (known && typeof known.hullGroup === "string" && known.hullGroup !== "") return known.hullGroup;
  const groupId = Number.isSafeInteger(ship.groupId) && ship.groupId > 0 ? ship.groupId : null;
  if (groupId === null || !(groupIndex instanceof Map)) return null;
  return groupIndex.get(groupId) || null;
}

function huntSizeFor(hullClass, table, p) {
  const known = typeof hullClass === "string" && Boolean(table) && Object.prototype.hasOwnProperty.call(table, hullClass)
    && Number.isSafeInteger(table[hullClass]);
  const pos = (v) => (Number.isSafeInteger(v) && v > 0 ? v : Infinity);
  const want = known ? table[hullClass] : (p && Number.isSafeInteger(p.defaultShips) ? p.defaultShips : 1);
  const cap = Math.min(pos(want), pos(p && p.maxShips), pos(p && p.fleetShips));
  return { cap: Number.isFinite(cap) ? Math.max(1, cap) : 1, known };
}

function currentObjectOf(e) {
  const list = e && Array.isArray(e.objects) ? e.objects : [];
  const o = Number.isSafeInteger(e && e.objectIndex) ? list[e.objectIndex] : undefined;
  if (!o || typeof o !== "object") return null;
  return { kind: typeof o.kind === "string" ? o.kind : null,
    itemId: Number.isSafeInteger(o.itemId) ? o.itemId : null,
    point: isPoint(o.point) ? { x: o.point.x, y: o.point.y, z: o.point.z } : null };
}

const HULL_WEIGHT = Object.freeze({ frigate: 1, tackle: 1, ewar: 1, destroyer: 2, cruiser: 3, logistics: 3,
  battlecruiser: 5, battleship: 8, capital: 20, carrier: 20, dreadnought: 20, force_auxiliary: 20, supercarrier: 40,
  titan: 40 });

const HULL_RANK = Object.freeze({ industrial: 0, frigate: 1, tackle: 1, ewar: 1, destroyer: 2, cruiser: 3,
  logistics: 3, battlecruiser: 4, battleship: 5, capital: 6, carrier: 6, dreadnought: 6, force_auxiliary: 6,
  supercarrier: 6, titan: 6 });

const hasOwn = (obj, key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);

function heavyScoreOf(composition) {
  if (!Array.isArray(composition)) return 0;
  let sum = 0;
  for (const e of composition) {
    if (!e || !hasOwn(HULL_WEIGHT, e.hullGroup) || !Number.isSafeInteger(e.count) || e.count < 1) continue;
    sum += HULL_WEIGHT[e.hullGroup] * e.count;
  }
  return sum;
}

function compareHeavyCandidates(a, b) {
  return heavyScoreOf(b.composition) - heavyScoreOf(a.composition) || compareHuntCandidates(a, b);
}

function orderForQuarry(members, quarryClass) {
  const list = Array.isArray(members) ? members : [];
  if (!hasOwn(HULL_RANK, quarryClass)) return [...list];
  const q = HULL_RANK[quarryClass];
  const keyed = list.map((m, i) => {
    const ranked = Boolean(m) && hasOwn(HULL_RANK, m.hullGroup);
    const rank = ranked ? HULL_RANK[m.hullGroup] : -1;
    return { m, i, dist: ranked ? Math.abs(rank - q) : Infinity, rank };
  });
  keyed.sort((a, b) => (a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : b.rank - a.rank || a.i - b.i));
  return keyed.map((k) => k.m);
}

function heatOf(rows, p) {
  if (!Array.isArray(rows) || !p || !Number.isSafeInteger(p.maxHeat) || p.maxHeat < 1) return 0;
  let heat = 0;
  for (const r of rows) {
    if (heat >= p.maxHeat) break;
    if (!r || !Array.isArray(r.members)) continue;
    if (planRepel({ members: r.members, reason: r.endReason, outcome: "RELEASED" },
      { lossPermille: p.lossPermille }).repel === true) heat += 1;
  }
  return heat;
}

function escalatedApproachJumps(base, heat, max) {
  const h = Number.isSafeInteger(heat) && heat > 0 ? heat : 0;
  return Math.max(base, Math.min(max, base + h));
}

function escalatedCap(cap, heat, permille, maxShips) {
  const h = Number.isSafeInteger(heat) && heat > 0 ? heat : 0;
  const pm = Number.isSafeInteger(permille) && permille > 0 ? permille : 0;
  if (h === 0 || pm === 0) return cap;
  return Math.min(maxShips, Math.max(cap, Math.floor((cap * (PERMILLE + (h * pm))) / PERMILLE)));
}

module.exports = { classifyStanding, huntThresholds, isTarget, relationOf, hasScanner, sweepOrder, dscanOrder, placeAnomalies, retargetTowardQuarry, scanRoll,
  pickCandidate, compareHuntCandidates, pickClaimCandidates,buildGroupIndex, hullClassOf, huntSizeFor, currentObjectOf,
  HULL_WEIGHT, HULL_RANK, heavyScoreOf, compareHeavyCandidates, orderForQuarry, heatOf, escalatedApproachJumps,
  escalatedCap };
