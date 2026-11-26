"use strict";

const {
  IDENTITY_KINDS,
  IDENTITY_STATES,
  foundingOpOf,
  identityKeyForAlliance,
  identityKeyForCorporation,
  identityKeyForCharacter,
  OWNER_KINDS,
  OWNER_PREFIXES,
  identityKeyForOwnerCorporation,
  identityKeyForOwnerCharacter,
} = require("./schema");

const MAX_OWNER_MEMBERS = 10;

const QUALIFYING_KINDS = Object.freeze(["pirate", "empire", "neutral"]);

function checkFactionQualifies(registry, data, factionId) {
  if (typeof registry.isActive === "function" && !registry.isActive(factionId)) {
    return { ok: false, reason: "FACTION_INACTIVE" };
  }

  const factionData = data.getFactions ? data.getFactions().find(f => f.id === factionId) : null;
  if (!factionData) {
    return { ok: false, reason: "NO_DATA_ENTRY" };
  }

  if (registry.getFaction) {
    const faction = registry.getFaction(factionId);
    if (faction && faction.doctrineId && registry.getDoctrine) {
      const doctrine = registry.getDoctrine(faction.doctrineId);
      if (doctrine && doctrine.canOccupy === false) {
        return { ok: false, reason: "DOCTRINE_CANNOT_OCCUPY" };
      }
    }
  }

  const kind = factionData.kind || "pirate";
  if (!QUALIFYING_KINDS.includes(kind)) {
    return { ok: false, reason: "INVALID_KIND" };
  }

  return { ok: true, data: factionData };
}

function buildIdentityPlan({ factionId, factionName, factionTicker, corpsPerFaction, membersPerCorp, maxCharacters }) {
  const plan = [];
  let totalChars = 0;

  const allianceKey = identityKeyForAlliance(factionId);
  plan.push({
    kind: "alliance",
    key: allianceKey,
    foundingOp: foundingOpOf(allianceKey),
    ownerKind: "faction",
    ownerId: factionId,
    name: `${factionName} Alliance`,
    ticker: factionTicker.substring(0, 10),
    state: "planned",
  });

  for (let slot = 0; slot < corpsPerFaction; slot++) {
    if (totalChars >= maxCharacters) break;

    const corpKey = identityKeyForCorporation(factionId, slot);
    plan.push({
      kind: "corporation",
      key: corpKey,
      foundingOp: foundingOpOf(corpKey),
      ownerKind: "faction",
      ownerId: factionId,
      name: `${factionName} Corporation ${slot + 1}`,
      ticker: `${factionTicker.substring(0, 7)}C${slot}`.substring(0, 10),
      state: "planned",
    });

    for (let charIndex = 0; charIndex < membersPerCorp; charIndex++) {
      if (totalChars >= maxCharacters) break;

      const charKey = identityKeyForCharacter(factionId, slot, charIndex);
      plan.push({
        kind: "character",
        key: charKey,
        foundingOp: foundingOpOf(charKey),
        ownerKind: "faction",
        ownerId: factionId,
        state: "planned",
      });
      totalChars++;
    }
  }

  return plan;
}

function buildFactionPlan(factionData, corpsPerFaction, membersPerCorp, maxCharacters) {
  const plan = [];
  let refusedCount = 0;
  let totalChars = 0;

  const factionId = factionData.id;
  const factionName = factionData.name;
  const allianceName = factionData.alliance?.name || `${factionName} Alliance`;
  const allianceTicker = factionData.alliance?.ticker || "ALNC";
  const corporations = factionData.corporations || [];

  const allianceKey = identityKeyForAlliance(factionId);
  plan.push({
    kind: "alliance",
    key: allianceKey,
    foundingOp: foundingOpOf(allianceKey),
    ownerKind: "faction",
    ownerId: factionId,
    name: allianceName,
    ticker: allianceTicker,
    state: "PLANNED",
  });

  for (let slot = 0; slot < corpsPerFaction; slot++) {
    if (totalChars >= maxCharacters) {
      refusedCount++;
      break;
    }

    const corpData = corporations[slot];
    const corpName = corpData?.name || `${factionName} Corporation ${slot + 1}`;
    const corpTicker = corpData?.ticker || `${factionName.substring(0, 7).toUpperCase()}C${slot}`;

    const corpKey = identityKeyForCorporation(factionId, slot);
    plan.push({
      kind: "corporation",
      key: corpKey,
      foundingOp: foundingOpOf(corpKey),
      ownerKind: "faction",
      ownerId: factionId,
      name: corpName,
      ticker: corpTicker,
      state: "PLANNED",
    });

    for (let charIndex = 0; charIndex < membersPerCorp; charIndex++) {
      if (totalChars >= maxCharacters) {
        refusedCount++;
        break;
      }

      const charKey = identityKeyForCharacter(factionId, slot, charIndex);
      plan.push({
        kind: "character",
        key: charKey,
        foundingOp: foundingOpOf(charKey),
        ownerKind: "faction",
        ownerId: factionId,
        state: "PLANNED",
      });
      totalChars++;
    }
  }

  return { plan, refusedCount };
}

function planIdentities(registry, data, params) {
  const { corpsPerFaction = 2, membersPerCorp = 3, maxCharacters = 64 } = params || {};

  const allFactions = data.getFactions ? data.getFactions() : [];
  const sortedFactions = [...allFactions].sort((a, b) => a.id - b.id);

  const allEntries = [];
  let totalRefused = 0;

  for (const factionData of sortedFactions) {
    const check = checkFactionQualifies(registry, data, factionData.id);
    if (!check.ok) {
      continue;
    }

    const { plan, refusedCount } = buildFactionPlan(
      check.data,
      corpsPerFaction,
      membersPerCorp,
      maxCharacters
    );

    for (const entry of plan) {
      entry.state = entry.state.toLowerCase();
    }

    allEntries.push(...plan);
    totalRefused += refusedCount;
  }

  return { entries: allEntries, refused: totalRefused };
}

function filterByKind(plan, kind) {
  return plan.filter((e) => e.kind === kind);
}

function sortPlan(plan) {
  const order = { alliance: 0, corporation: 1, character: 2 };
  return [...plan].sort((a, b) => (order[a.kind] || 99) - (order[b.kind] || 99));
}

function validateEntry(entry) {
  if (!Object.values(IDENTITY_KINDS).includes(entry.kind)) return { ok: false, reason: "INVALID_KIND" };
  if (!Object.values(IDENTITY_STATES).includes(entry.state)) return { ok: false, reason: "INVALID_STATE" };
  if (typeof entry.key !== "string" || entry.key.length === 0) return { ok: false, reason: "MISSING_KEY" };
  if (typeof entry.foundingOp !== "string" || entry.foundingOp.length === 0) return { ok: false, reason: "MISSING_FOUNDING_OP" };
  if (entry.foundingOp !== foundingOpOf(entry.key)) return { ok: false, reason: "FOUNDING_OP_MISMATCH" };
  if (!Object.values(OWNER_KINDS).includes(entry.ownerKind) || !Number.isInteger(entry.ownerId) || entry.ownerId <= 0) {
    return { ok: false, reason: "INVALID_OWNER" };
  }
  if (entry.kind !== "character" && (typeof entry.name !== "string" || entry.name.length === 0)) {
    return { ok: false, reason: "MISSING_NAME" };
  }
  if (entry.kind !== "character" && (typeof entry.ticker !== "string" || entry.ticker.length === 0)) {
    return { ok: false, reason: "MISSING_TICKER" };
  }
  return { ok: true };
}

function buildOwnerPlan(spec) {
  const bad = (detail) => ({ ok: false, reason: "INVALID_SPEC", detail });
  if (!spec || typeof spec !== "object") return bad("spec");
  if (spec.ownerKind === OWNER_KINDS.FACTION || !Object.values(OWNER_KINDS).includes(spec.ownerKind)) {
    return bad("ownerKind");
  }
  if (!Number.isSafeInteger(spec.ownerId) || spec.ownerId <= 0) return bad("ownerId");
  if (!Number.isSafeInteger(spec.members) || spec.members < 1 || spec.members > MAX_OWNER_MEMBERS) {
    return bad("members");
  }
  const corp = spec.corporation || {};
  if (typeof corp.name !== "string" || corp.name.length < 1 || corp.name.length > 50) return bad("corporation.name");
  if (typeof corp.ticker !== "string" || !/^[A-Z0-9]{2,5}$/.test(corp.ticker)) return bad("corporation.ticker");
  const prefix = OWNER_PREFIXES[spec.ownerKind];
  const corpKey = identityKeyForOwnerCorporation(prefix, spec.ownerId, 0);
  const entries = [{ kind: IDENTITY_KINDS.CORPORATION, key: corpKey, foundingOp: foundingOpOf(corpKey),
    ownerKind: spec.ownerKind, ownerId: spec.ownerId, name: corp.name, ticker: corp.ticker,
    state: IDENTITY_STATES.PLANNED }];
  for (let n = 0; n < spec.members; n += 1) {
    const charKey = identityKeyForOwnerCharacter(prefix, spec.ownerId, 0, n);
    entries.push({ kind: IDENTITY_KINDS.CHARACTER, key: charKey, foundingOp: foundingOpOf(charKey),
      ownerKind: spec.ownerKind, ownerId: spec.ownerId, state: IDENTITY_STATES.PLANNED });
  }
  for (const e of entries) {
    const v = validateEntry(e);
    if (!v.ok) return bad(v.reason);
  }
  return { ok: true, entries };
}

module.exports = {
  buildOwnerPlan,
  MAX_OWNER_MEMBERS,
  checkFactionQualifies,
  buildIdentityPlan,
  planIdentities,
  filterByKind,
  sortPlan,
  validateEntry,
  buildFactionPlan,
};