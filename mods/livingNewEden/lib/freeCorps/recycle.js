"use strict";

const { MAX_DESCRIPTION_LENGTH } = require("./schema");
const { backoffMs } = require("./killmails");

function pickMergePartner(weak, rows, { regionOf, excluded, warPairOpen, cap }) {
  if (!weak || !Array.isArray(rows)) return null;
  const region = regionOf(weak.home_system_id);
  if (region === null || region === undefined) return null;
  for (const c of rows) {
    if (!c || c.corp_id === weak.corp_id) continue;
    if (regionOf(c.home_system_id) !== region) continue;
    if (excluded(c.corp_id) || warPairOpen(weak.corp_id, c.corp_id)) continue;
    if (!(c.members_target < cap) || !(c.isk > weak.isk)) continue;
    return c;
  }
  return null;
}

function planClose({ weak, identity, recruits, partner, cap }) {
  const ceo = identity && Number.isSafeInteger(identity.ceoCharacterId) ? identity.ceoCharacterId : null;
  const byId = new Map();
  for (const id of (identity && Array.isArray(identity.characterIds) ? identity.characterIds : [])) {
    if (Number.isSafeInteger(id) && id > 0 && id !== ceo) byId.set(id, null);
  }
  for (const r of recruits || []) {
    if (r && Number.isSafeInteger(r.character_id) && r.character_id !== ceo) byId.set(r.character_id, r);
  }
  const ids = [...byId.keys()].sort((a, b) => a - b);
  const room = partner ? Math.max(0, Math.min(ids.length, cap - partner.members_target)) : 0;
  const moves = ids.map((characterId, i) => {
    const existing = byId.get(characterId);
    return { characterId, originCorpId: existing ? existing.origin_corp_id : weak.corp_id, existing,
      to: i < room ? partner.corp_id : null };
  });
  return { moves, moved: room };
}

function recruitPlan(membersTarget, poolLeft, S) {
  const k = Math.min(membersTarget - 1, poolLeft, S.maxRecruitsPerFounding);
  return Number.isSafeInteger(k) && k > 0 ? k : 0;
}

function closeDescription(kind, atMs, partnerName) {
  const day = new Date(Math.max(0, Math.trunc(Number(atMs) || 0))).toISOString().slice(0, 10);
  const text = kind === "MERGED" ? `Merged into ${String(partnerName || "another corporation")} ${day}`
    : `Disbanded ${day}`;
  return text.slice(0, MAX_DESCRIPTION_LENGTH);
}

module.exports = { pickMergePartner, planClose, recruitPlan, closeDescription, backoffMs };
