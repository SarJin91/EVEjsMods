"use strict";

const { STATE } = require("./schema");

const OPEN_FOR_KILLS = Object.freeze([STATE.ACTIVE, STATE.FINALE]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function createScoring(deps) {
  const { getRow, regionOf, bump } = deps;
  const S = deps.settings;
  const entries = new Map();
  let regionRow = null;
  let regionSet = null;

  function regionsOf(row) {
    if (row !== regionRow) {
      regionRow = row;
      regionSet = new Set(row.crisis.regionIds);
    }
    return regionSet;
  }

  function onNpcKill(kill) {
    const k = kill && typeof kill === "object" ? kill : null;
    if (!k || !isId(k.characterId) || !isId(k.systemId) || !isTime(k.atMs) || !isId(k.victimFactionId)) {
      return { ok: false, reason: "INVALID_KILL" };
    }
    const row = getRow();
    if (!row || !OPEN_FOR_KILLS.includes(row.state)) return { ok: false, reason: "NO_SEASON" };
    const f = row.crisis.factionId;
    const ofCrisis = f !== null && (k.victimFactionId === f || k.convoyOwnerFactionId === f);
    let inArea = ofCrisis && k.atMs >= row.startsAt && k.atMs < row.endsAt;
    if (inArea && row.crisis.regionIds.length > 0) inArea = regionsOf(row).has(regionOf(k.systemId));
    if (!inArea) {
      bump("killsNotCrisis");
      return { ok: false, reason: "NOT_CRISIS" };
    }
    const key = `${row.seasonNo}:${k.characterId}`;
    const e = entries.get(key);
    if (!e) {
      if (entries.size >= S.maxPendingKeys) {
        bump("killsDropped.QUEUE_FULL");
        return { ok: false, reason: "QUEUE_FULL" };
      }
      entries.set(key, { seasonNo: row.seasonNo, characterId: k.characterId, points: S.killPoints, kills: 1,
        lastAt: k.atMs });
    } else {
      e.points = Math.min(Number.MAX_SAFE_INTEGER, e.points + S.killPoints);
      e.kills += 1;
      e.lastAt = Math.max(e.lastAt, k.atMs);
    }
    bump("killsQueued");
    return { ok: true, queued: 1 };
  }

  function peekForFlush(limit) {
    const out = [];
    for (const e of entries.values()) {
      if (out.length >= limit) break;
      out.push({ ...e });
    }
    return out;
  }

  function ack(items) {
    for (const it of Array.isArray(items) ? items : []) {
      const key = `${it.seasonNo}:${it.characterId}`;
      const e = entries.get(key);
      if (!e) continue;
      e.points = Math.max(0, e.points - it.points);
      e.kills = Math.max(0, e.kills - it.kills);
      if (e.kills === 0) entries.delete(key);
    }
  }

  return Object.freeze({ onNpcKill, peekForFlush, ack, size: () => entries.size });
}

module.exports = { createScoring };
