"use strict";

const FOOTHOLD_HOLDING = "FOOTHOLD_HOLDING";
const IDLE = "IDLE";
const INVADER = "invader";
const GARRISON = "garrison";
const STAYING_STATES = Object.freeze(["REFITTING", "MATERIALIZED", "ENGAGED"]);
const ORDERED_STATES = Object.freeze(["PLANNED", "STAGED"]);

const strengthOf = (x) => (Number.isFinite(x.strength) ? x.strength : 0);
const byPriority = (a, b) => ((a.fleetRole === GARRISON ? 0 : 1) - (b.fleetRole === GARRISON ? 0 : 1))
  || (strengthOf(b) - strengthOf(a)) || (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function markFootholdHolders(snapshot, params, pseudo) {
  const notes = [];
  const P = params ? params.footholdHold : null;
  if (!P || !snapshot.entry || snapshot.entry.kind !== INVADER) return notes;
  if (snapshot.doctrine && snapshot.doctrine.hive === true) return notes;
  const systems = [...new Set((Array.isArray(snapshot.footholds) ? snapshot.footholds : [])
    .filter((fh) => fh.home !== true).map((fh) => fh.systemId))].sort((a, b) => a - b);
  if (systems.length === 0) return notes;
  const targetOf = new Map((snapshot.operations || []).map((op) => [op.operationId, op.targetSystemId]));
  const fleets = Array.isArray(snapshot.fleets) ? snapshot.fleets : [];
  let held = false;
  let unheld = false;
  for (const systemId of systems) {
    const here = fleets.filter((x) => x.systemId === systemId);
    const staying = here.filter((x) => pseudo.has(x.fleetId) || STAYING_STATES.includes(x.state)
      || (x.state === IDLE && x.refitPending === true)
      || (ORDERED_STATES.includes(x.state) && targetOf.get(x.operationId) === systemId)).length;
    const need = P.minFleets - staying;
    if (need <= 0) continue;
    const free = here.filter((x) => x.state === IDLE && x.refitPending !== true && !pseudo.has(x.fleetId))
      .sort(byPriority);
    for (const x of free.slice(0, need)) {
      pseudo.set(x.fleetId, FOOTHOLD_HOLDING);
      held = true;
    }
    if (free.length < need) unheld = true;
  }
  if (held) notes.push("FOOTHOLD_HOLD");
  if (unheld) notes.push("FOOTHOLD_UNHELD");
  return notes;
}

module.exports = { markFootholdHolders, FOOTHOLD_HOLDING };
