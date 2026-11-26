"use strict";

const { OWNER_KINDS, FLEET_OWNER_KINDS } = require("./schema");

const OWNER_KIND_SET = new Set(FLEET_OWNER_KINDS);
const CHAR_MARK = ":char:";

function positiveId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function buildPilotCandidates(linkedRows) {
  const rows = Array.isArray(linkedRows) ? linkedRows : [];
  const corpByKey = new Map();
  const allianceByKey = new Map();
  const characters = [];
  for (const row of rows) {
    if (!row) continue;
    if (row.kind === "corporation") {
      const id = positiveId(row.evejs_id);
      if (id !== null && typeof row.identity_key === "string") corpByKey.set(row.identity_key, id);
    } else if (row.kind === "alliance") {
      const id = positiveId(row.evejs_id);
      if (id !== null && typeof row.identity_key === "string") allianceByKey.set(row.identity_key, id);
    } else if (row.kind === "character") {
      characters.push(row);
    }
  }
  const out = [];
  const seen = new Set();
  for (const row of characters) {
    if (!OWNER_KIND_SET.has(row.owner_kind)) continue;
    const characterId = Number(row.evejs_id);
    if (!Number.isInteger(characterId) || characterId <= 0 || seen.has(characterId)) continue;
    seen.add(characterId);
    const key = typeof row.identity_key === "string" ? row.identity_key : "";
    const at = key.lastIndexOf(CHAR_MARK);
    const corpKey = at > 0 ? key.slice(0, at) : null;
    const parts = key.split(":");
    const allianceKey = parts.length >= 2 ? `${parts[0]}:${parts[1]}:alliance` : null;
    out.push(Object.freeze({
      characterId,
      ownerKind: row.owner_kind,
      ownerId: Number(row.owner_id),
      name: typeof row.name === "string" && row.name ? row.name : null,
      corporationId: corpKey !== null && corpByKey.has(corpKey) ? corpByKey.get(corpKey) : null,
      allianceId: allianceKey !== null && allianceByKey.has(allianceKey) ? allianceByKey.get(allianceKey) : null,
    }));
  }
  out.sort((a, b) => a.characterId - b.characterId);
  return Object.freeze(out);
}

function buildCivilianCandidates(linkedRows) {
  const rows = Array.isArray(linkedRows) ? linkedRows : [];
  const ids = new Set();
  for (const row of rows) {
    if (!row || row.kind !== "character" || row.owner_kind !== OWNER_KINDS.CIVILIAN) continue;
    const characterId = Number(row.evejs_id);
    if (Number.isSafeInteger(characterId) && characterId > 0) ids.add(characterId);
  }
  return Object.freeze([...ids].sort((a, b) => a - b));
}

module.exports = { buildPilotCandidates, buildCivilianCandidates };
