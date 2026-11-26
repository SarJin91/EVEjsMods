// The terminal rule (defeated only before expires_at) is ported from EveJS incursionLifecycle.js (see CREDITS.md).

"use strict";

const S = require("./schema");
const { projectMilli, applyCompletion } = require("./influence");
const { recordClear, refresh } = require("./rules");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function pickTargets(claimRows, p) {
  const o = p || {};
  const states = Array.isArray(o.claimStates) ? o.claimStates : [];
  const factions = Array.isArray(o.factionIds) ? o.factionIds : [];
  const occupied = o.occupiedConstellations instanceof Set ? o.occupiedConstellations : new Set();
  const existing = o.existingKeys instanceof Set ? o.existingKeys : new Set();
  const max = Number.isSafeInteger(o.maxTargets) && o.maxTargets > 0 ? o.maxTargets : 0;
  const rows = (Array.isArray(claimRows) ? claimRows : []).filter((r) => r && isId(r.systemId) && isId(r.factionId)
    && isTime(r.phaseSeq) && states.includes(r.occupationState) && factions.includes(r.factionId))
    .sort((a, b) => a.systemId - b.systemId || a.factionId - b.factionId);
  const out = [];
  const taken = new Set();
  for (const r of rows) {
    if (out.length >= max) break;
    if (isId(r.constellationId) && (occupied.has(r.constellationId) || taken.has(r.constellationId))) continue;
    if (existing.has(S.idempotencyKeyOf(r.factionId, r.systemId, r.phaseSeq))) continue;
    if (isId(r.constellationId)) taken.add(r.constellationId);
    out.push({ systemId: r.systemId, factionId: r.factionId, phaseSeq: r.phaseSeq });
  }
  return out;
}

const clearedAtOf = (fact) => (isTime(fact.endedAt) ? fact.endedAt : fact.updatedAt);

function stepIncursion(row, sites, siteFacts, now, params) {
  const policy = row.rules;
  const completionStage = policy && policy.completion && typeof policy.completion.stage === "string"
    ? policy.completion.stage : null;
  const repeatOf = new Map((policy.stages || []).map((s) => [s.key, s.repeat === true]));
  const facts = siteFacts instanceof Map ? siteFacts : new Map();
  let snap = { valueMilli: row.influenceMilli, updatedAt: row.influenceUpdatedAt, graceMinutes: row.graceMinutes,
    decayMilliPerHour: row.decayMilliPerHour };
  let progress = row.progress;
  const clears = [];
  const ended = [];
  const slotPatch = new Map();
  let changed = false;
  let hqClear = null;
  const patchSlot = (site, fields) => {
    slotPatch.set(site.slotKey, { slotKey: site.slotKey, version: site.version, state: site.state, dueAt: site.dueAt,
      clears: site.clears, incarnation: site.incarnation, eventId: site.eventId, ...fields });
  };

  const open = sites.filter((s) => s.state === S.SLOT_STATE.OPEN && typeof s.eventId === "string");
  const cleared = [];
  for (const site of open) {
    if (!facts.has(site.eventId)) continue;
    const fact = facts.get(site.eventId);
    if (fact && S.SITE_CLEARED_STATES.includes(fact.state)) cleared.push({ site, at: clearedAtOf(fact) });
    else if (fact === null || (fact && S.SITE_ENDED_STATES.includes(fact.state))) {
      ended.push({ slotKey: site.slotKey });
      patchSlot(site, { state: S.SLOT_STATE.WAITING, dueAt: now + params.siteRespawnMs });
      changed = true;
    }
  }
  cleared.sort((a, b) => a.at - b.at || (a.site.slotKey < b.site.slotKey ? -1 : 1));
  for (const { site, at } of cleared) {
    const r = recordClear(progress, policy, { stageKey: site.stageKey, receiptId: site.eventId,
      maxReceipts: params.maxSiteClearsPerIncursion, maxJsonLength: S.MAX_PROGRESS_JSON });
    let counted = false;
    if (r.ok && !r.duplicate) {
      progress = r.progress;
      const applied = applyCompletion(snap, at, row.expiresAt, row.perCompletionMilli);
      if (applied && applied.accepted) {
        snap = { ...snap, valueMilli: applied.valueMilli, updatedAt: applied.updatedAt };
        counted = true;
      }
    }
    clears.push({ slotKey: site.slotKey, eventId: site.eventId, at, counted, capped: !r.ok && r.reason === "CLEARS_CAPPED" });
    const repeat = repeatOf.get(site.stageKey) === true;
    patchSlot(site, { state: repeat ? S.SLOT_STATE.WAITING : S.SLOT_STATE.CLOSED,
      dueAt: repeat ? at + params.siteRespawnMs : site.dueAt, clears: site.clears + 1 });
    changed = true;
    if (site.stageKey === completionStage && (hqClear === null || at < hqClear.at)) {
      hqClear = { at, eventId: site.eventId };
    }
  }

  let decide = null;
  if (hqClear !== null && hqClear.at < row.expiresAt) {
    decide = { outcome: S.OUTCOME.DEFEATED, at: hqClear.at, hqEventId: hqClear.eventId };
  } else if (now >= row.expiresAt || hqClear !== null) {
    decide = { outcome: S.OUTCOME.EXPIRED, at: row.expiresAt, hqEventId: hqClear ? hqClear.eventId : null };
  }
  const cancel = [];
  const plans = [];
  if (decide !== null) {
    for (const site of sites) {
      const p = slotPatch.get(site.slotKey);
      const state = p ? p.state : site.state;
      if (state === S.SLOT_STATE.OPEN && typeof site.eventId === "string") cancel.push(site.eventId);
      if (state !== S.SLOT_STATE.CLOSED) patchSlot(p ? { ...site, ...p } : site, { state: S.SLOT_STATE.CLOSED });
    }
    changed = true;
  } else {
    const influenceNow = projectMilli(snap, now);
    const refreshed = refresh(progress, policy, { influenceMilli: influenceNow === null ? 0 : influenceNow,
      hqUnlockMilli: row.hqUnlockMilli });
    if (JSON.stringify(refreshed) !== JSON.stringify(progress)) changed = true;
    progress = refreshed;
    const canPlan = params.allowPlans === true && now + params.minSiteWindowMs < row.expiresAt;
    for (const site of sites) {
      if (!canPlan || plans.length >= params.maxPlans) break;
      const p = slotPatch.get(site.slotKey);
      const cur = p ? { ...site, ...p } : site;
      const stage = progress.stages[cur.stageKey];
      if (cur.state !== S.SLOT_STATE.WAITING || cur.dueAt > now || !stage || stage.active !== true) continue;
      const incarnation = cur.incarnation + 1;
      plans.push({ slotKey: cur.slotKey, eventId: S.siteEventIdOf(row.incursionId, row.createdAt, cur.slotKey, incarnation),
        systemId: cur.systemId, kind: cur.kind, tier: cur.tier, expiresAt: Math.min(row.expiresAt, now + params.siteTtlMs),
        incarnation });
    }
  }
  return { clears, ended, plans, decide, cancel,
    patch: { influenceMilli: snap.valueMilli, influenceUpdatedAt: snap.updatedAt, progress },
    slots: [...slotPatch.values()], changed };
}

function settlementOf(row, participants) {
  if (row.outcome === S.OUTCOME.CANCELLED) return { kind: "RECORD", effect: S.EFFECT.DISABLED };
  if (row.outcome !== S.OUTCOME.DEFEATED) return { kind: "RECORD", effect: S.EFFECT.RECORDED };
  const characterId = (Array.isArray(participants) ? participants : []).find(isId);
  return characterId === undefined ? { kind: "RECORD", effect: S.EFFECT.NO_PARTICIPANT }
    : { kind: "REPEL", characterId };
}

module.exports = { pickTargets, stepIncursion, settlementOf };
