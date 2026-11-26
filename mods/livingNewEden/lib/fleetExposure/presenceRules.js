"use strict";

const { OPERATION_TYPES } = require("../fleets/schema");
const { validateLegShape, hasWormholeEdges } = require("../fleets/travel");
const { membersOf, pickDetachment } = require("../playerHunt/huntRepository");
const { pickSeeded } = require("./rules");

const PRESENCE_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING", "RETREATING"]);
const CLAIMABLE_STATES = Object.freeze(["IDLE", "STAGED"]);
const RETREATING = "RETREATING";
const ANCHOR_SEED_KIND = "fleet-presence-anchor";

const RULE = Object.freeze({ BELT: "BELT", GATE: "GATE", STATION: "STATION", DEFAULT: "DEFAULT" });
const ANCHOR_RULE_OF_OPERATION = Object.freeze({
  mining: RULE.BELT, ratting: RULE.BELT, salvage: RULE.BELT,
  camp: RULE.GATE, blockade: RULE.GATE, pursuit: RULE.GATE, intercept: RULE.GATE, gank: RULE.GATE,
  escort: RULE.GATE,
  logistics: RULE.STATION, return: RULE.STATION,
  invasion: RULE.DEFAULT, defense: RULE.DEFAULT, reinforce: RULE.DEFAULT, patrol: RULE.DEFAULT, recon: RULE.DEFAULT,
  raid: RULE.DEFAULT, expedition: RULE.DEFAULT, structure_assault: RULE.DEFAULT,
  counter: RULE.DEFAULT,
  harvest_raid: RULE.DEFAULT,
});
for (const t of OPERATION_TYPES) {
  if (!ANCHOR_RULE_OF_OPERATION[t]) throw new Error(`fleetExposure/presenceRules: no anchor rule for ${t}`);
}
const CHAIN_OF_RULE = Object.freeze({
  STATION: Object.freeze(["station", "stargate", "sun", "planet"]),
  BELT: Object.freeze(["asteroidBelt", "planet", "sun", "station", "stargate"]),
  GATE: Object.freeze(["stargate", "station", "sun", "planet"]),
  DEFAULT: Object.freeze(["stargate", "station", "asteroidBelt", "sun", "planet"]),
});
const ANCHOR_KINDS = Object.freeze(["station", "stargate", "asteroidBelt", "sun", "planet"]);

function presenceSpot(fleet, now) {
  if (!fleet || !PRESENCE_STATES.includes(fleet.state)) return null;
  if (fleet.state !== RETREATING) return { windowEnd: null, exitToSystemId: null };
  const leg = fleet.route;
  if (!leg || !validateLegShape(leg).ok || hasWormholeEdges(leg) || !Number.isSafeInteger(now)) return null;
  if (!(leg.jumpMs > 0) || now < leg.departAt || now >= leg.departAt + leg.jumpMs) return null;
  if (leg.systems[0] !== fleet.currentSystemId) return null;
  return { windowEnd: leg.departAt + leg.jumpMs, exitToSystemId: leg.systems[1] };
}

function allocate(order, cap) {
  const list = Array.isArray(order) ? order : [];
  const out = new Map(list.map((o) => [o.fleetId, 0]));
  const max = list.reduce((m, o) => Math.max(m, Number.isSafeInteger(o.want) ? o.want : 0), 0);
  let sum = 0;
  const limit = Number.isSafeInteger(cap) && cap > 0 ? cap : 0;
  for (let r = 1; r <= max && sum < limit; r += 1) {
    for (const o of list) {
      if (sum >= limit) break;
      if (!(o.want >= r)) continue;
      out.set(o.fleetId, r);
      sum += 1;
    }
  }
  return out;
}

function detachmentOrder(fleet) {
  if (!fleet || !Array.isArray(fleet.composition)) return [];
  const all = membersOf(fleet.fleetId, fleet.composition);
  if (all.length <= 1) return all;
  const head = pickDetachment(all, all.length - 1);
  const used = new Set(head.map((m) => m.memberKey));
  return [...head, ...all.filter((m) => !used.has(m.memberKey))];
}

function anchorChainOf(fleetState, operationType, spot) {
  if (fleetState === "IDLE" || fleetState === "REFITTING") {
    return { kinds: [...CHAIN_OF_RULE.STATION], preferToSystemId: null };
  }
  if (fleetState === RETREATING) {
    const to = spot && Number.isSafeInteger(spot.exitToSystemId) ? spot.exitToSystemId : null;
    return { kinds: [...CHAIN_OF_RULE.GATE], preferToSystemId: to };
  }
  const rule = (typeof operationType === "string" && ANCHOR_RULE_OF_OPERATION[operationType]) || RULE.DEFAULT;
  return { kinds: [...CHAIN_OF_RULE[rule]], preferToSystemId: null };
}

function pickAnchorObject(objects, chain, worldSeed, fleetId) {
  const list = Array.isArray(objects) ? objects : [];
  if (!chain || !Array.isArray(chain.kinds)) return null;
  for (let i = 0; i < chain.kinds.length; i += 1) {
    const kind = chain.kinds[i];
    const ofKind = list.filter((o) => o && o.kind === kind);
    if (ofKind.length === 0) continue;
    if (kind === "stargate" && chain.preferToSystemId !== null) {
      const gate = ofKind.find((o) => o.toSystemId === chain.preferToSystemId);
      if (gate) return { anchor: gate, fallback: i > 0 };
    }
    const anchor = pickSeeded(ofKind, worldSeed, ANCHOR_SEED_KIND, fleetId) || ofKind[0];
    return { anchor, fallback: i > 0 || chain.preferToSystemId !== null };
  }
  return null;
}

function claimableOf(fleetState, operationType, stagedTypes) {
  if (fleetState === "IDLE") return true;
  if (fleetState !== "STAGED") return false;
  return typeof operationType === "string" && Array.isArray(stagedTypes) && stagedTypes.includes(operationType);
}

const HOSTILE_EXTRA_CLAIM_STATES = Object.freeze(["REFITTING"]);

function hostileClaimableOf(fleetState, hostileStates) {
  return HOSTILE_EXTRA_CLAIM_STATES.includes(fleetState) && Array.isArray(hostileStates)
    && hostileStates.includes(fleetState);
}

function stillShown(entry, fleet, now, claim) {
  const moved = { action: "DESPAWN", reason: "FLEET_MOVED" };
  if (!entry || !fleet || fleet.currentSystemId !== entry.systemId) return moved;
  const spot = presenceSpot(fleet, now);
  if (spot === null) return moved;
  const keys = new Set(Array.isArray(fleet.composition)
    ? membersOf(fleet.fleetId, fleet.composition).map((m) => m.memberKey) : []);
  const lostKeys = (Array.isArray(entry.members) ? entry.members : []).filter((m) => !keys.has(m.memberKey))
    .map((m) => m.memberKey);
  return { action: "KEEP", fleetState: fleet.state,
    operationId: typeof fleet.operationId === "string" ? fleet.operationId : null,
    claimable: claimableOf(fleet.state, claim && typeof claim.operationType === "string" ? claim.operationType : null,
      claim ? claim.stagedTypes : null), lostKeys, spot };
}

module.exports = { PRESENCE_STATES, CLAIMABLE_STATES, ANCHOR_RULE_OF_OPERATION, ANCHOR_KINDS, ANCHOR_SEED_KIND,
  CHAIN_OF_RULE, HOSTILE_EXTRA_CLAIM_STATES, presenceSpot, allocate, detachmentOrder, anchorChainOf, pickAnchorObject,
  stillShown, claimableOf, hostileClaimableOf };
