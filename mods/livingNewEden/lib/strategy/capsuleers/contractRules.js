"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const D = require("../data/capsuleers");

const DISPATCHED = "DISPATCHED";
const ON_STATION = "ON_STATION";
const COMPLETED = "COMPLETED";
const CANCELLED = "CANCELLED";
const CONTRACT_STATES = Object.freeze([DISPATCHED, ON_STATION, COMPLETED, CANCELLED]);
const OPEN_CONTRACT_STATES = Object.freeze([DISPATCHED, ON_STATION]);
const CONTRACT_TRANSITIONS = Object.freeze({
  [DISPATCHED]: Object.freeze([ON_STATION, CANCELLED]),
  [ON_STATION]: Object.freeze([COMPLETED]),
  [COMPLETED]: Object.freeze([]),
  [CANCELLED]: Object.freeze([]),
});
const CONTRACT_KINDS = Object.freeze(["DEFENSE", "RAID"]);
const KIND_OPERATION = Object.freeze({
  DEFENSE: Object.freeze({ operationType: "defense", objective: "hold" }),
  RAID: Object.freeze({ operationType: "raid", objective: "raid" }),
});
const MAX_FEE_ISK = 1e15;
const PERMILLE = 1000;

function canTransitionContract(from, to) {
  if (!CONTRACT_STATES.includes(from) || !CONTRACT_STATES.includes(to)) {
    return { ok: false, reason: "UNKNOWN_STATE", from, to };
  }
  if (!CONTRACT_TRANSITIONS[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

function feeOf(composition, params) {
  try {
    let isk = 0;
    for (const e of composition || []) {
      const count = e && Number.isSafeInteger(e.count) && e.count > 0 ? e.count : 0;
      const per = e && Object.prototype.hasOwnProperty.call(D.MERC_FEE_BY_HULL, e.hullGroup)
        ? D.MERC_FEE_BY_HULL[e.hullGroup] : D.MERC_FEE_DEFAULT;
      isk += count * per;
    }
    const permille = params && Number.isSafeInteger(params.mercFeeFactorPermille) ? params.mercFeeFactorPermille : 0;
    const fee = Math.floor((isk * permille) / PERMILLE);
    return Math.min(MAX_FEE_ISK, Math.max(1, Number.isFinite(fee) ? fee : 1));
  } catch (_err) {
    return 1;
  }
}

function closeOutcomeOf(contract) {
  if (!contract) return null;
  if (contract.state === ON_STATION) return { to: COMPLETED };
  if (contract.state === DISPATCHED) return { to: CANCELLED };
  return null;
}

const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
const countOf = (map, key) => (map instanceof Map ? map.get(key) || 0 : 0);

function planHires(snap, params) {
  const out = { hires: [], refused: { noTreasury: 0, treasuryLow: 0, austerity: 0 } };
  try {
    const p = params || {};
    const perReview = Number.isSafeInteger(p.maxContractsPerReview) ? p.maxContractsPerReview : 0;
    if (!snap || perReview <= 0) return out;
    const open = snap.open || {};
    const byCorp = new Map(open.byCorp instanceof Map ? open.byCorp : []);
    const byEmployer = new Map(open.byEmployer instanceof Map ? open.byEmployer : []);
    const bySystem = new Map(open.bySystem instanceof Map ? open.bySystem : []);
    const balance = new Map();
    const secClasses = Array.isArray(p.mercTargetSecClasses) ? p.mercTargetSecClasses : [];
    const top = Math.max(1, Number.isSafeInteger(p.mercTargetsTop) ? p.mercTargetsTop : 1);
    const corps = [...(snap.corps || [])].filter((c) => c && c.state === "ACTIVE")
      .sort((a, b) => a.corpSlot - b.corpSlot);
    const free = [...(snap.freeMercs || [])].filter((f) => f)
      .sort((a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
    const pirate = (id) => {
      const f = snap.factionOf(id);
      return Boolean(f && f.kind === "pirate" && snap.isActive(id) === true);
    };
    for (const corp of corps) {
      for (const fleet of free) {
        if (fleet.slot !== corp.corpSlot) continue;
        if (out.hires.length >= perReview) return out;
        if (countOf(byCorp, corp.corpSlot) >= p.maxContractsPerCorp) break;
        const fee = feeOf(fleet.composition, p);
        const passed = [];
        let refusal = null;
        const targets = (snap.targetsBySlot instanceof Map ? snap.targetsBySlot.get(corp.corpSlot) : null) || [];
        for (const t of targets) {
          const v = snap.vertexOf(t.systemId);
          if (!v || !secClasses.includes(v.secClass)) continue;
          const E = v.factionId;
          const ef = Number.isSafeInteger(E) && E > 0 ? snap.factionOf(E) : null;
          if (!ef || ef.kind !== "empire" || snap.isActive(E) !== true) continue;
          let enemy = null;
          const present = (snap.enemiesBySystem instanceof Map ? snap.enemiesBySystem.get(t.systemId) : null) || [];
          for (const e of present) {
            if (!e || !pirate(e.factionId) || !snap.isHostile(E, e.factionId)
              || !snap.isHostile(D.CAPSULEER_FACTION_ID, e.factionId)) continue;
            if (enemy === null || e.ships > enemy.ships || (e.ships === enemy.ships && e.factionId < enemy.factionId)) {
              enemy = e;
            }
          }
          if (!enemy) continue;
          const c = snap.controllerOf instanceof Map && snap.controllerOf.has(t.systemId)
            ? snap.controllerOf.get(t.systemId) : null;
          let kind = null;
          if (c === null || c === undefined || c === E) kind = "DEFENSE";
          else if (pirate(c)) kind = "RAID";
          if (kind === null) continue;
          if (countOf(bySystem, t.systemId) >= p.mercMaxContractsPerSystem
            || countOf(byEmployer, E) >= p.maxContractsPerEmpire) continue;
          const acc = snap.accountOf instanceof Map ? snap.accountOf.get(E) : null;
          let why = null;
          if (!acc || acc.ok !== true || acc.mode !== "ready" || acc.seeded !== true) why = "noTreasury";
          else if (acc.accountMode === "AUSTERITY") why = "austerity";
          else {
            const local = balance.has(E) ? balance.get(E) : acc.balanceIsk;
            if (!(local >= fee * p.mercMinTreasuryMultiple)) why = "treasuryLow";
          }
          if (why) {
            if (refusal === null) refusal = why;
            continue;
          }
          passed.push({ systemId: t.systemId, employerFactionId: E, enemyFactionId: enemy.factionId, kind });
        }
        const ranked = passed.slice(0, top);
        if (ranked.length === 0) {
          if (refusal) out.refused[refusal] += 1;
          continue;
        }
        const pick = createRng(deriveSeed(corp.seed, "hire", snap.round, fleet.fleetId)).pick(ranked) || ranked[0];
        const acc = snap.accountOf.get(pick.employerFactionId);
        balance.set(pick.employerFactionId, (balance.has(pick.employerFactionId)
          ? balance.get(pick.employerFactionId) : acc.balanceIsk) - fee);
        bump(byCorp, corp.corpSlot);
        bump(byEmployer, pick.employerFactionId);
        bump(bySystem, pick.systemId);
        out.hires.push({ slot: corp.corpSlot, fleetId: fleet.fleetId, expectedVersion: fleet.expectedVersion,
          targetSystemId: pick.systemId, employerFactionId: pick.employerFactionId,
          enemyFactionId: pick.enemyFactionId, kind: pick.kind, feeIsk: fee, guardMs: p.mercGuardMs });
      }
    }
    return out;
  } catch (_err) {
    return out;
  }
}

module.exports = { CONTRACT_STATES, OPEN_CONTRACT_STATES, CONTRACT_TRANSITIONS, CONTRACT_KINDS, KIND_OPERATION,
  DISPATCHED, ON_STATION, COMPLETED, CANCELLED, MAX_FEE_ISK, canTransitionContract, feeOf, closeOutcomeOf,
  planHires };
