"use strict";

const { eligibleTarget, targetWeight } = require("./rollPlanner");

const AUSTERITY = "AUSTERITY";
const PERMILLE = 1000;

const nat = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function planConduit(snapshot, C, rng) {
  const { round, factionId } = snapshot;
  const out = (outcome, extra = {}) => ({ v: 1, round, outcome, factionId, ...extra });
  if (nat(C.conduitMaxActive) === 0) return out("OFF");
  if (rng.nextInt(1, PERMILLE) > nat(C.conduitChancePermille)) return out("NO_ROLL");
  if (nat(snapshot.conduitOpen) >= C.conduitMaxActive) return out("NO_ROOM");
  if (nat(snapshot.spawnedToday) >= nat(C.conduitMaxSpawnsPerDay)) return out("DAY_CAP");
  const balance = Number.isSafeInteger(snapshot.balanceIsk) ? snapshot.balanceIsk : null;
  const surplus = balance === null ? -1 : balance - nat(C.conduitReserveIsk);
  if (balance === null || snapshot.accountMode === AUSTERITY || surplus < nat(C.conduitIskPerSpawn)) {
    return out("NO_SURPLUS");
  }
  const need = nat(C.conduitPoolFleetsPerSpawn);
  const pool = Array.isArray(snapshot.poolFleets) ? [...snapshot.poolFleets].sort(byFleetId) : [];
  if (snapshot.poolTruncated === true || pool.length < need) return out("NO_POOL");
  const T = C.target;
  const sampled = snapshot.stationsReady === true && Array.isArray(snapshot.sampled) ? snapshot.sampled : [];
  const weighted = sampled.filter((s) => eligibleTarget(s, factionId, T) && !(T.requireSovCheck && s.claimed === null))
    .map((s) => ({ systemId: s.systemId, weight: targetWeight(s, T) })).filter((s) => s.weight > 0)
    .sort((a, b) => a.systemId - b.systemId);
  if (weighted.length === 0) return out("NO_TARGET");
  const pick = rng.nextInt(1, weighted.reduce((sum, s) => sum + s.weight, 0));
  let acc = 0;
  let target = weighted[weighted.length - 1];
  for (const s of weighted) {
    acc += s.weight;
    if (pick <= acc) { target = s; break; }
  }
  const perBonus = nat(C.conduitIskPerBonusFleet);
  const room = Math.max(0, nat(snapshot.maxPackageFleets) - nat(snapshot.packageFleets));
  const bonus = perBonus === 0 ? 0 : Math.min(nat(C.conduitBonusFleetsMax), room,
    Math.floor((surplus - nat(C.conduitIskPerSpawn)) / perBonus));
  return out("SPAWN", { profileId: snapshot.profileId, targetSystemId: target.systemId,
    captureRangeJumps: snapshot.captureRangeJumps, bonusFleets: bonus,
    poolFleetIds: pool.slice(0, need).map((x) => x.fleetId), iskCost: nat(C.conduitIskPerSpawn) + bonus * perBonus });
}

module.exports = { planConduit };
