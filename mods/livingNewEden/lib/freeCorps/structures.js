"use strict";

const { deriveSeed } = require("../util/rng");
const { CORP_STATES, keyStructure, STRUCTURE_NAME_MAX } = require("./schema");
const { corpValues } = require("./ventures");

const PERMILLE = 1000;
const SEED_KIND = "fc-structure";
const ONLINE_STATE_NAMES = Object.freeze(["SHIELD_VULNERABLE", "ARMOR_REINFORCE", "ARMOR_VULNERABLE", "HULL_REINFORCE",
  "HULL_VULNERABLE"]);
const ROW_ANCHORING = "ANCHORING";
const ROW_ONLINE = "ONLINE";

function structureKey(corpId, n) {
  return keyStructure(corpId, n);
}

function structureName(systemName, corpName) {
  const corp = typeof corpName === "string" ? corpName.trim() : "";
  if (corp === "") return null;
  const system = typeof systemName === "string" ? systemName.trim() : "";
  return (system === "" ? corp : `${system} - ${corp}`).slice(0, STRUCTURE_NAME_MAX);
}

function placementSeed(worldSeed, corpId, n, attempt) {
  return deriveSeed(worldSeed, SEED_KIND, corpId, n, attempt);
}

const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

function planAnchors(input) {
  const S = input.S;
  const picks = [];
  const skipped = {};
  const room = Math.min(S.maxAnchorsPerPlan, S.maxTotal - input.openTotal);
  const list = [...(input.candidates || [])].sort((a, b) => (b.archetype === "structure") - (a.archetype === "structure")
    || b.isk - a.isk || a.corp_id - b.corp_id);
  if (room <= 0) {
    if (list.length > 0) skipped.CAP = list.length;
    return { picks, skipped };
  }
  const minIsk = Math.max(S.minCorpIsk, S.anchorCostIsk);
  const pickedIn = new Map();
  for (const c of list) {
    if (picks.length >= room) {
      bump(skipped, "CAP");
      continue;
    }
    if (c.corporation_id === null || c.corporation_id === undefined) { bump(skipped, "NO_CORP"); continue; }
    if (!(c.isk >= minIsk)) { bump(skipped, "ISK"); continue; }
    if (c.openOfCorp >= S.maxPerCorp) { bump(skipped, "CORP_CAP"); continue; }
    const home = c.home_system_id;
    if (input.openInSystem(home) + (pickedIn.get(home) || 0) >= S.maxPerSystem) { bump(skipped, "SYSTEM_CAP"); continue; }
    if (c.lastLostAt !== null && c.lastLostAt !== undefined && input.now - c.lastLostAt < S.rebuildCooldownMs) {
      bump(skipped, "COOLDOWN");
      continue;
    }
    const blocked = input.blocked(home);
    if (blocked !== null) { bump(skipped, blocked); continue; }
    const n = c.structure_seq + 1;
    picks.push({ corpId: c.corp_id, n, key: structureKey(c.corp_id, n), systemId: home, costIsk: S.anchorCostIsk });
    pickedIn.set(home, (pickedIn.get(home) || 0) + 1);
  }
  return { picks, skipped };
}

const inStates = (names, states, state) => names.some((n) => Number.isSafeInteger(states[n]) && states[n] === state);

function watchAction(row, view, ctx) {
  const cleanup = ctx.mode === "cleanup";
  if (view === null || view.tag === null || view.tag.fcKey !== ctx.key || view.tag.world !== ctx.world) {
    return row.corpOpen ? { op: "LOST", reason: "VANISHED" } : { op: "ENDED", reason: "CORP_CLOSED" };
  }
  if (view.destroyedAt !== null && !view.modDestroyed) return { op: "LOST", reason: "DESTROYED" };
  if (view.destroyedAt !== null) {
    return { op: "ENDED", reason: !row.corpOpen ? "CORP_CLOSED" : cleanup ? "CLEANUP" : "MOD_DESTROYED" };
  }
  if (cleanup) return { op: "REMOVE", reason: "CLEANUP" };
  if (!row.corpOpen) return { op: "REMOVE", reason: "CORP_CLOSED" };
  const st = ctx.states;
  if (row.state === ROW_ANCHORING && inStates(ONLINE_STATE_NAMES, st, view.state)) return { op: "ONLINE" };
  if (row.state === ROW_ANCHORING && Number.isSafeInteger(st.ONLINING_VULNERABLE) && view.state === st.ONLINING_VULNERABLE) {
    return { op: "PATCH", patch: { state: st.SHIELD_VULNERABLE, stateEndsAt: null, condition: { ...ctx.conditionFull },
      at: ctx.now }, then: "ONLINE" };
  }
  if (row.state === ROW_ONLINE && view.state === st.SHIELD_VULNERABLE && view.upkeepState !== ctx.upkeep.FULL_POWER) {
    return { op: "PATCH", patch: { upkeepState: ctx.upkeep.FULL_POWER, at: ctx.now }, then: null };
  }
  return { op: "NONE" };
}

const advanceRow = (corp) => ({ ...corpValues(corp), next_at: corp.next_at });

function lossValues(corp, S) {
  const values = advanceRow(corp);
  const penaltyIsk = Math.floor((values.isk * S.lossTreasuryPermille) / PERMILLE);
  values.isk -= penaltyIsk;
  values.isk_lost += penaltyIsk;
  if (values.state === CORP_STATES.ACTIVE) values.state = CORP_STATES.STRUGGLING;
  return { values, penaltyIsk };
}

function debitValues(corp, costIsk, n) {
  const values = advanceRow(corp);
  if (values.isk < costIsk) return null;
  values.isk -= costIsk;
  values.structure_seq = n;
  return values;
}

function refundValues(corp, costIsk) {
  const values = advanceRow(corp);
  values.isk += costIsk;
  return values;
}

module.exports = { structureKey, structureName, placementSeed, planAnchors, watchAction, lossValues, debitValues,
  refundValues, ONLINE_STATE_NAMES };
