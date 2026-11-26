"use strict";

const { createRng } = require("../util/rng");
const { CORP_STATES, WAR_STATES, warIdOf } = require("./schema");
const { COMPETITOR_WEIGHT } = require("./data/skirmish");

const PERMILLE = 1000;
const living = (state) => state === CORP_STATES.ACTIVE || state === CORP_STATES.STRUGGLING;

function sideOf(war, corpId) {
  if (!war || !Number.isSafeInteger(corpId)) return null;
  if (war.corp_a === corpId) return "A";
  if (war.corp_b === corpId) return "B";
  if (war.ally_corp_id !== null && war.ally_corp_id !== undefined && war.ally_corp_id === corpId) {
    return war.ally_side === "A" || war.ally_side === "B" ? war.ally_side : null;
  }
  return null;
}

function membersOf(war, side) {
  const out = [{ corpId: side === "A" ? war.corp_a : war.corp_b, home: side === "A" ? war.home_a : war.home_b }];
  if (war.ally_corp_id !== null && war.ally_corp_id !== undefined && war.ally_side === side) {
    out.push({ corpId: war.ally_corp_id, home: war.home_ally });
  }
  return out;
}

function indexWars(rows) {
  const byCorp = new Map();
  const list = Array.isArray(rows) ? rows.slice().sort((a, b) => (a.war_id < b.war_id ? -1 : a.war_id > b.war_id ? 1
    : 0)) : [];
  for (const war of list) {
    for (const side of ["A", "B"]) {
      const mine = membersOf(war, side);
      const theirs = membersOf(war, side === "A" ? "B" : "A");
      for (const m of mine) {
        if (byCorp.has(m.corpId)) continue;
        byCorp.set(m.corpId, Object.freeze({ warId: war.war_id, side, state: war.state,
          enemies: Object.freeze(theirs.map((x) => x.corpId)),
          friends: Object.freeze(mine.filter((x) => x.corpId !== m.corpId).map((x) => x.corpId)),
          enemyHomes: Object.freeze(theirs.map((x) => x.home).filter((h) => Number.isSafeInteger(h) && h > 0)) }));
      }
    }
  }
  return { byCorp, open: list.length };
}

function pickWeighted(items, weightOf, rng) {
  let sum = 0;
  for (const it of items) sum += weightOf(it);
  let r = rng.nextInt(1, sum);
  for (const it of items) {
    const w = weightOf(it);
    if (r <= w) return it;
    r -= w;
  }
  return items[items.length - 1];
}

function planDeclaration(input) {
  const { corp, regionOf, candidates, belligerents, openWars, hunting, seed, S } = input;
  const W = S.wars;
  if (!(corp.isk >= W.declareMinIsk + W.declareCostIsk)) return { ok: false, reason: "POOR" };
  if (belligerents.has(corp.corp_id)) return { ok: false, reason: "AT_WAR" };
  if (openWars >= W.maxOpenWars) return { ok: false, reason: "LIMIT" };
  const rng = createRng(seed);
  if (rng.nextInt(1, PERMILLE) > W.declareChancePermille) return { ok: false, reason: "ROLL" };
  const region = regionOf(corp.home_system_id);
  if (region === null || region === undefined) return { ok: false, reason: "NO_REGION" };
  const free = (c) => c.corp_id !== corp.corp_id && living(c.state) && !belligerents.has(c.corp_id)
    && regionOf(c.home_system_id) === region;
  const pool = (candidates || []).filter(free).sort((a, b) => a.corp_id - b.corp_id);
  if (pool.length === 0) return { ok: false, reason: "NO_TARGET" };
  const target = pickWeighted(pool, (c) => (c.archetype === corp.archetype ? COMPETITOR_WEIGHT.sameArchetype
    : COMPETITOR_WEIGHT.other), rng);
  let allyId = null;
  if (hunting === true && corp.archetype !== "hunter" && W.allyFeeIsk > 0
    && corp.isk >= W.declareMinIsk + W.declareCostIsk + W.allyFeeIsk) {
    const hunters = pool.filter((c) => c.archetype === "hunter" && c.corp_id !== target.corp_id);
    if (hunters.length > 0) allyId = rng.pick(hunters).corp_id;
  }
  return { ok: true, targetId: target.corp_id, allyId, costIsk: W.declareCostIsk,
    feeIsk: allyId === null ? 0 : W.allyFeeIsk };
}

function warRowOf({ declarerId, targetId, allyId, n, now, costIsk, feeIsk, S }) {
  const W = S.wars;
  const a = Math.min(declarerId, targetId);
  const b = Math.max(declarerId, targetId);
  const activeAt = now + W.declareDelayMs;
  const hasAlly = Number.isSafeInteger(allyId) && allyId > 0;
  return Object.freeze({ war_id: warIdOf(a, b, n), corp_a: a, corp_b: b, n, declarer_corp_id: declarerId,
    ally_corp_id: hasAlly ? allyId : null, ally_side: hasAlly ? (declarerId === a ? "A" : "B") : null,
    ally_fee_isk: hasAlly ? feeIsk : 0, declare_cost_isk: costIsk, state: WAR_STATES.DECLARED, open: 1,
    declared_at: now, active_at: activeAt, ends_at: activeAt + W.warDurationMs, next_at: activeAt });
}

function warValues(war) {
  return { state: war.state, open: war.open, next_at: war.next_at, ended_at: war.ended_at === undefined ? null
    : war.ended_at, kills_a: war.kills_a, kills_b: war.kills_b, isk_lost_a: war.isk_lost_a, isk_lost_b: war.isk_lost_b,
  skirmishes: war.skirmishes, surrender_isk: war.surrender_isk, winner: war.winner === undefined ? null : war.winner,
  end_reason: war.end_reason === undefined ? null : war.end_reason };
}

function reviewWar(war, a, b, now, S) {
  const W = S.wars;
  const row = warValues(war);
  const end = (reason, winner) => {
    row.state = WAR_STATES.ENDED;
    row.open = 0;
    row.ended_at = now;
    row.end_reason = reason;
    row.winner = winner;
  };
  if (!a || !b) {
    end("SIDE_CLOSED", a ? war.corp_a : b ? war.corp_b : null);
    return { op: "end", reason: "SIDE_CLOSED", row, transfer: null };
  }
  if (war.state === WAR_STATES.DECLARED) {
    if (now >= war.active_at) {
      row.state = WAR_STATES.ACTIVE;
      row.next_at = Math.min(war.ends_at, now + W.reviewMs);
      return { op: "activate", reason: null, row, transfer: null };
    }
    row.next_at = war.active_at;
    return { op: "reschedule", reason: null, row, transfer: null };
  }
  if (now >= war.ends_at) {
    const winner = war.isk_lost_a < war.isk_lost_b ? war.corp_a : war.isk_lost_b < war.isk_lost_a ? war.corp_b : null;
    end("TIMEOUT", winner);
    return { op: "end", reason: "TIMEOUT", row, transfer: null };
  }
  const gives = (corp, oppKills, lost, oppLost) => corp.state === CORP_STATES.STRUGGLING
    || (oppKills >= W.surrenderMinKills && lost * PERMILLE >= W.surrenderLossRatioPermille * Math.max(1, oppLost));
  const sides = [[a, b, war.kills_b, war.isk_lost_a, war.isk_lost_b], [b, a, war.kills_a, war.isk_lost_b,
    war.isk_lost_a]];
  for (const [x, y, oppKills, lost, oppLost] of sides) {
    if (!gives(x, oppKills, lost, oppLost)) continue;
    const isk = Math.floor(Math.max(0, x.isk) * W.surrenderIskPermille / PERMILLE);
    end("SURRENDER", y.corp_id);
    row.surrender_isk = isk;
    return { op: "end", reason: "SURRENDER", row,
      transfer: isk > 0 ? { fromCorpId: x.corp_id, toCorpId: y.corp_id, isk } : null };
  }
  row.next_at = Math.min(war.ends_at, now + W.reviewMs);
  return { op: "reschedule", reason: null, row, transfer: null };
}

function warAfterSkirmish(war, attackerCorpId, result) {
  const side = sideOf(war, attackerCorpId);
  if (side === null) return null;
  const row = warValues(war);
  const mine = side === "A" ? "a" : "b";
  const theirs = side === "A" ? "b" : "a";
  row[`kills_${mine}`] += result.crewLostD;
  row[`kills_${theirs}`] += result.crewLostA;
  row[`isk_lost_${mine}`] += result.iskLostA;
  row[`isk_lost_${theirs}`] += result.iskLostD;
  row.skirmishes += 1;
  return row;
}

module.exports = { sideOf, indexWars, planDeclaration, warRowOf, reviewWar, warAfterSkirmish, warValues };
