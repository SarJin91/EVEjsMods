"use strict";

const { bfs } = require("./bfs");
const { describe, effectiveIntel, isFresh, ttlOf, intelWithExtra } = require("./targeting");
const { gateOn, cooledOf } = require("./attackLossGate");
const { gateOn: transitGateOn, riskOf, skippedByRisk } = require("./transitRiskGate");
const { isForeignBastion } = require("./bastions");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const GANK_KIND = "gank";
const RAID_OPERATION_TYPE = "raid";
const PERMILLE = 1000;
const TARGET_SEC_CLASSES = Object.freeze(["lowsec", "nullsec"]);
const HIGHSEC = "highsec";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function planMinerRaids(snapshot, supply, params, used, room, opts) {
  const intents = [];
  const notes = [];
  let seen = 0;
  const P = params && params.minerRaid;
  const check = Boolean(P) && P.strengthCheck === true;
  const tooStrong = new Set();
  const prefer = Boolean(P) && P.preferUnescorted === true;
  let reordered = 0;
  const out = () => ({ intents, notes, seen, ...(check ? { tooStrong: tooStrong.size } : {}),
    ...(prefer ? { reordered } : {}) });
  if (!P || !(room > 0) || !(P.maxPerReview > 0)) return out();
  const mt = snapshot.minerTargets;
  if (!mt || typeof mt !== "object" || !Array.isArray(mt.targets)) return out();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out();
  const d = snapshot.doctrine;
  if (d && d.hive === true) return out();
  if (!d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(RAID_OPERATION_TYPE)) return out();
  const kind = (params.kinds || []).find((k) => k.kind === GANK_KIND);
  if (!kind) return out();
  if (supply && supply.homeOnly === true) {
    notes.push("MINER_RAID_AUSTERITY");
    return out();
  }
  if (mt.truncated === true) notes.push("MINER_RAID_TARGETS_TRUNCATED");

  const f = snapshot.factionId;
  const reach = supply && supply.reach instanceof Map ? supply.reach : new Map();
  const isHostile = typeof snapshot.isHostile === "function" ? snapshot.isHostile : () => false;
  const secClasses = P.highsec === true ? [...TARGET_SEC_CLASSES, HIGHSEC] : TARGET_SEC_CLASSES;
  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const opTargets = new Set((snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state))
    .map((op) => op.targetSystemId));

  const ships = new Map();
  for (const t of mt.targets) {
    if (!t || t.factionId === f || !isHostile(t.factionId)) continue;
    if (!secClasses.includes(t.secClass) || !Number.isSafeInteger(t.systemId)) continue;
    if (!(t.miningEndsAt - snapshot.at >= P.minShiftLeftMs) || !reach.has(t.systemId)) continue;
    ships.set(t.systemId, (ships.get(t.systemId) || 0) + (Number.isSafeInteger(t.ships) ? t.ships : 0));
  }
  seen = ships.size;
  for (const id of [...ships.keys()]) if (opTargets.has(id) || launched.has(id)) ships.delete(id);
  if (gateOn(snapshot, params)) for (const id of cooledOf(snapshot)) ships.delete(id);
  if (P.skipForeignBastions === true) {
    let dropped = 0;
    for (const id of [...ships.keys()]) if (isForeignBastion(snapshot, id)) { ships.delete(id); dropped += 1; }
    if (dropped > 0) notes.push("MINER_RAID_FOREIGN_BASTION");
  }
  if (ships.size === 0) return out();

  const fleets = (snapshot.fleets || []).filter((x) => x.state === IDLE && x.operationId === null
    && x.refitPending !== true && !used.has(x.fleetId) && Number.isSafeInteger(x.systemId)
    && kind.fleetRoles.includes(x.fleetRole) && x.shipCount >= P.minShips).sort(byFleetId)
    .slice(0, Math.max(0, P.maxFleetsScanned));

  const limit = Math.min(room, P.maxPerReview);
  const taken = new Set();
  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) notes.push(n);
    noted.add(n);
  };
  const cache = new Map();
  const transitGate = transitGateOn(snapshot, params);
  const bfsOpts = { maxJumps: P.maxJumps, maxSystems: params.maxBfsSystems };
  let intelMap = null;
  const requiredBySystem = new Map();
  const requiredOf = (id) => {
    if (!requiredBySystem.has(id)) {
      if (intelMap === null) intelMap = effectiveIntel({ ...snapshot, intel: intelWithExtra(snapshot) });
      const facts = describe(snapshot, params, intelMap, id);
      requiredBySystem.set(id, Math.max(1, Math.ceil(facts.enemyStrength * params.attackStrengthRatio)));
    }
    return requiredBySystem.get(id);
  };
  const classBySystem = new Map();
  const classOf = (id) => {
    if (!classBySystem.has(id)) {
      if (intelMap === null) intelMap = effectiveIntel({ ...snapshot, intel: intelWithExtra(snapshot) });
      const seenThere = intelMap.get(id);
      const fresh = isFresh(seenThere, snapshot.at, ttlOf(seenThere, params));
      classBySystem.set(id, !fresh ? 1 : (seenThere.hostileShips > ships.get(id) ? 2 : 0));
    }
    return classBySystem.get(id);
  };
  for (const x of fleets) {
    if (intents.length >= limit) break;
    if (!cache.has(x.systemId)) cache.set(x.systemId, bfs([x.systemId], snapshot.neighbors, bfsOpts));
    const dist = cache.get(x.systemId);
    const inRange = [...ships.keys()].filter((id) => !taken.has(id) && dist.has(id) && dist.get(id) >= 1);
    const byShips = inRange.filter((id) => x.shipCount * PERMILLE >= ships.get(id) * P.minShipRatioPermille);
    if (byShips.length === 0) {
      note(inRange.length > 0 ? "MINER_RAID_TOO_WEAK" : "MINER_RAID_NO_TARGET");
      continue;
    }
    const strong = check ? byShips.filter((id) => (x.strength || 0) >= requiredOf(id)) : byShips;
    if (strong.length === 0) {
      for (const id of byShips) tooStrong.add(id);
      note("MINER_RAID_TOO_STRONG");
      continue;
    }
    if (check) for (const id of byShips) if (!strong.includes(id)) tooStrong.add(id);
    const byOrder = (a, b) => dist.get(a) - dist.get(b) || ships.get(b) - ships.get(a) || a - b;
    const before = prefer ? [...strong].sort(byOrder)[0] : null;
    strong.sort(prefer ? (a, b) => classOf(a) - classOf(b) || byOrder(a, b) : byOrder);
    if (prefer && strong[0] !== before) reordered += 1;
    const target = transitGate ? strong.find((id) => !skippedByRisk(riskOf(snapshot, x.systemId, id, {
      fleetRole: x.fleetRole, shipCount: x.shipCount, operationType: kind.operationType }), params.transitRisk))
      : strong[0];
    if (target !== strong[0]) note("TRANSIT_RISK_SKIP");
    if (target === undefined) continue;
    taken.add(target);
    used.add(x.fleetId);
    intents.push({ type: "LAUNCH", kind: GANK_KIND, target: { kind: "system", systemId: target, ref: null },
      originSystemId: x.systemId, fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [],
      dueAt: snapshot.at + P.windowMs });
    notes.push(`MINER_RAID:${target}`);
  }
  return out();
}

module.exports = { planMinerRaids, GANK_KIND };
