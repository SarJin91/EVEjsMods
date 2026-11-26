"use strict";

const HOLDING = "HOLDING";
const IDLE = "IDLE";
const NONE_TOKEN = "none";
const CLAIM_HOLD_STATES_ALLOWED = Object.freeze(["CONTESTED", "INVASION", "OCCUPIED", "CONSOLIDATING"]);
const STAYING_STATES = Object.freeze(["REFITTING", "MATERIALIZED"]);
const ORDERED_STATES = Object.freeze(["PLANNED", "STAGED"]);

const byStrength = (a, b) => (b.strength - a.strength) || (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function parseClaimHoldStates(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === NONE_TOKEN) return Object.freeze([]);
  const out = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim();
    if (!CLAIM_HOLD_STATES_ALLOWED.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return Object.freeze(out);
}

function markClaimHolders(snapshot, params, pseudo) {
  const notes = [];
  const P = params.claimHold;
  const hive = Boolean(snapshot.doctrine) && snapshot.doctrine.hive === true;
  const claims = (Array.isArray(snapshot.occupations) ? snapshot.occupations : [])
    .filter((o) => P && o.occupier === snapshot.factionId && P.states.includes(o.state)
      && (hive ? o.homeOwn === true : true));
  if (claims.length === 0) return notes;
  const targetOf = new Map((snapshot.operations || []).map((op) => [op.operationId, op.targetSystemId]));
  const here = new Map();
  for (const x of snapshot.fleets) {
    if (!P.roles.includes(x.fleetRole) || !(x.strength > 0)) continue;
    if (!here.has(x.systemId)) here.set(x.systemId, []);
    here.get(x.systemId).push(x);
  }
  const stays = (x, systemId) => pseudo.has(x.fleetId) || STAYING_STATES.includes(x.state)
    || (ORDERED_STATES.includes(x.state) && targetOf.get(x.operationId) === systemId);
  let held = false;
  let expired = false;
  for (const o of claims) {
    const fleets = here.get(o.systemId) || [];
    if (fleets.some((x) => stays(x, o.systemId))) continue;
    const free = fleets.filter((x) => x.state === IDLE && x.refitPending !== true).sort(byStrength);
    if (free.length === 0) continue;
    if (!Number.isSafeInteger(o.sinceAt) || snapshot.at - o.sinceAt >= P.maxMs) {
      expired = true;
      continue;
    }
    pseudo.set(free[0].fleetId, HOLDING);
    held = true;
  }
  if (held) notes.push("CLAIM_HOLD");
  if (expired) notes.push("CLAIM_HOLD_EXPIRED");
  return notes;
}

function claimHoldYields(snapshot) {
  const th = snapshot.threats;
  if (th && th.mode === "ready" && Array.isArray(th.items) && th.items.length > 0) return true;
  const sg = snapshot.siege;
  return Boolean(sg && sg.mode === "ready" && Array.isArray(sg.defending) && sg.defending.length > 0);
}

function defensePseudo(snapshot, pseudo) {
  if (![...pseudo.values()].includes(HOLDING) || !claimHoldYields(snapshot)) return pseudo;
  return new Map([...pseudo].filter(([, v]) => v !== HOLDING));
}

function freedHolders(pseudo, guard) {
  if (guard === pseudo) return new Set();
  return new Set([...pseudo].filter(([id, v]) => v === HOLDING && !guard.has(id)).map(([id]) => id));
}

module.exports = { markClaimHolders, parseClaimHoldStates, claimHoldYields, defensePseudo, freedHolders, HOLDING,
  CLAIM_HOLD_STATES_ALLOWED };
