"use strict";

const { parseOperationTypeList, TERMINAL_OPERATION_STATES } = require("../fleets/schema");
const { systemsWithin } = require("../notices/recipients");
const { OUTCOME } = require("./schema");

const FAILED_BATTLE_STATES = Object.freeze(["FAILED", "QUARANTINED"]);
const OPERATION_GONE_STATES = Object.freeze(["CANCELLED", "FAILED"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function departureDecision(departure, operation, opts) {
  if (!operation) return { announce: false, reason: "NO_OPERATION" };
  if (!opts.types.has(operation.operationType)) return { announce: false, reason: "TYPE" };
  const leg = departure && departure.leg;
  const systems = leg && Array.isArray(leg.systems) ? leg.systems : [];
  if (systems.length < 2 || systems[systems.length - 1] !== operation.targetSystemId) {
    return { announce: false, reason: "NOT_TARGET_LEG" };
  }
  const etaAt = leg.departAt + (systems.length - 1) * leg.jumpMs;
  if (!Number.isSafeInteger(etaAt) || etaAt - leg.departAt < opts.minLeadMs) {
    return { announce: false, reason: "SHORT_LEAD" };
  }
  return { announce: true, etaAt };
}

function etaOfOperation(fleets, targetSystemId) {
  let eta = null;
  for (const f of Array.isArray(fleets) ? fleets : []) {
    const leg = f && f.state === "TRAVELLING" ? f.route : null;
    const systems = leg && Array.isArray(leg.systems) ? leg.systems : [];
    if (systems.length < 2 || systems[systems.length - 1] !== targetSystemId) continue;
    if (!Number.isSafeInteger(leg.arriveAt)) continue;
    if (eta === null || leg.arriveAt < eta) eta = leg.arriveAt;
  }
  return eta;
}

function charactersOf(entry) {
  const chars = entry && Array.isArray(entry.characters) ? entry.characters : [];
  const out = [];
  for (const c of chars) {
    const cid = Number(c && c.characterId);
    if (isId(cid)) out.push(cid);
  }
  return out;
}

function standingAtLeast(readStanding, characterId, factionId, min) {
  try {
    const r = readStanding(characterId, factionId);
    if (!r || r.ok !== true) return { hit: false, failed: true };
    return { hit: Number(r.standing) >= min, failed: false };
  } catch (_err) {
    return { hit: false, failed: true };
  }
}

function selectRecipients(spec) {
  const { graph, presence, readStanding, targetSystemId, attackerFactionId, defenderFactionId, settings } = spec;
  if (!presence || typeof presence.getStatus !== "function" || typeof presence.getSystemPresence !== "function") {
    return { ok: false, reason: "PRESENCE_UNAVAILABLE" };
  }
  const status = presence.getStatus();
  if (!status || status.available !== true) return { ok: false, reason: "PRESENCE_UNAVAILABLE" };
  if (status.stale) return { ok: false, reason: "PRESENCE_STALE" };
  if (!graph || typeof graph.getNeighbors !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };

  const near = new Set();
  for (const id of systemsWithin(graph, targetSystemId, settings.proximityJumps).keys()) {
    for (const cid of charactersOf(presence.getSystemPresence(id))) near.add(cid);
  }
  const standing = new Set();
  let standingFailed = 0;
  if (settings.standingMin > 0 && typeof readStanding === "function" && typeof presence.listPresence === "function"
    && settings.maxScanCharacters > 0) {
    const factions = [defenderFactionId, attackerFactionId].filter(isId);
    let scanned = 0;
    const list = presence.listPresence() || [];
    scan: for (const entry of list) {
      for (const cid of charactersOf(entry)) {
        if (scanned >= settings.maxScanCharacters) break scan;
        scanned += 1;
        if (near.has(cid) || standing.has(cid)) continue;
        for (const factionId of factions) {
          const r = standingAtLeast(readStanding, cid, factionId, settings.standingMin);
          if (r.failed) standingFailed += 1;
          if (r.hit) {
            standing.add(cid);
            break;
          }
        }
      }
    }
  }
  const all = [...[...near].sort((a, b) => a - b), ...[...standing].sort((a, b) => a - b)];
  const max = settings.maxRecipientsPerAnnouncement;
  const truncated = all.length > max;
  return { ok: true, characterIds: truncated ? all.slice(0, max) : all, truncated, standingFailed };
}

function byCreated(a, b) {
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.battleId < b.battleId ? -1 : (a.battleId > b.battleId ? 1 : 0);
}

function decideOutcome(spec) {
  const { announcement: a, operation: op, now, settings } = spec;
  const battles = Array.isArray(spec.battles) ? [...spec.battles].sort(byCreated) : [];
  const watchEnd = a.announcedAt + settings.maxWatchMs;
  const atTarget = battles.find((b) => b.systemId === a.targetSystemId) || null;
  if (atTarget) {
    if (atTarget.state === "COMPLETED") {
      return { close: true, outcome: OUTCOME.SETTLED, battleId: atTarget.battleId,
        factAt: atTarget.settledAt ?? atTarget.updatedAt };
    }
    if (FAILED_BATTLE_STATES.includes(atTarget.state)) {
      return { close: true, outcome: OUTCOME.ABORTED, battleId: atTarget.battleId, factAt: atTarget.updatedAt };
    }
    if (now < watchEnd) return { close: false };
    return { close: true, outcome: OUTCOME.EXPIRED, battleId: atTarget.battleId, factAt: now };
  }
  if (!op || OPERATION_GONE_STATES.includes(op.state)) {
    const elsewhere = battles[0] || null;
    if (elsewhere) return { close: true, outcome: OUTCOME.INTERCEPTED, battleId: elsewhere.battleId, factAt: now };
    return { close: true, outcome: OUTCOME.CANCELLED, battleId: null,
      factAt: op && Number.isSafeInteger(op.completedAt) ? op.completedAt : now };
  }
  if (op.state === "COMPLETED") {
    return { close: true, outcome: OUTCOME.NO_FIGHT, battleId: null,
      factAt: Number.isSafeInteger(op.completedAt) ? op.completedAt : now };
  }
  if (now >= a.etaAt + settings.noBattleGraceMs) {
    return { close: true, outcome: OUTCOME.NO_CONTACT, battleId: null, factAt: now };
  }
  if (now >= watchEnd) return { close: true, outcome: OUTCOME.EXPIRED, battleId: null, factAt: now };
  return { close: false };
}

function attackerWonOf(battle, attackerFactionId) {
  const input = battle && battle.input;
  const outcome = battle && battle.result ? battle.result.outcome : null;
  let side = null;
  if (input && input.sideA && input.sideA.factionId === attackerFactionId) side = "A";
  else if (input && input.sideB && input.sideB.factionId === attackerFactionId) side = "B";
  if (side === null) return null;
  if (outcome === "A_WIN") return side === "A";
  if (outcome === "B_WIN") return side === "B";
  return null;
}

function parseOperationTypes(text) {
  const list = parseOperationTypeList(text);
  if (!list || list.length === 0) return null;
  return new Set(list);
}

module.exports = { departureDecision, etaOfOperation, selectRecipients, decideOutcome, attackerWonOf, parseOperationTypes,
  TERMINAL_OPERATION_STATES };
