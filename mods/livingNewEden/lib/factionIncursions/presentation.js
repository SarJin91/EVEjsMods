"use strict";

const S = require("./schema");
const { PHASE } = require("./timeline");

const SEVERITY_STAGING = 4;
const TEMPLATE_CLASS_ID = 2;
const MILLI_PER_STEP = 10;
const STEPS = 100;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function scenesOf(view) {
  if (!Array.isArray(view.systems) || view.systems.length === 0) return null;
  const out = [];
  for (const s of view.systems) {
    const sceneType = s && Object.prototype.hasOwnProperty.call(S.SCENE_OF_ROLE, s.role) ? S.SCENE_OF_ROLE[s.role] : 0;
    if (!s || !isId(s.systemId) || sceneType === 0) return null;
    out.push({ systemId: s.systemId, sceneType });
  }
  return out;
}

function entryOf(view, templateNameID) {
  if (!view || view.state !== S.ROW_STATE.ACTIVE || !isId(view.incursionId) || !isId(view.factionId)) return null;
  if (!Object.prototype.hasOwnProperty.call(S.UI_STATE_OF_PHASE, view.phase)) return null;
  const scenes = scenesOf(view);
  if (scenes === null || !Number.isSafeInteger(view.influenceMilli)) return null;
  const staging = scenes.find((s) => s.sceneType === S.SCENE_OF_ROLE.staging) || scenes[scenes.length - 1];
  return {
    taleID: S.taleIdOf(view.incursionId),
    severity: SEVERITY_STAGING,
    stagingSolarSystemID: staging.systemId,
    state: S.UI_STATE_OF_PHASE[view.phase],
    templateNameID,
    templateClassID: TEMPLATE_CLASS_ID,
    aggressorFactionID: view.factionId,
    influence: Math.round(view.influenceMilli / MILLI_PER_STEP) / STEPS,
    systems: scenes.map((s) => ({ solarSystemID: s.systemId, sceneType: s.sceneType, templateNameID })),
    effects: [],
    incursedSystems: scenes.map((s) => s.systemId),
    rewardGroupID: 0,
    hasChat: false,
    hasFinalEncounter: false,
    chatAnnouncementMessageId: 0,
    musicState: null,
  };
}

function buildUiEntries(views, opts) {
  const o = opts || {};
  const maxEntries = Number.isSafeInteger(o.maxEntries) && o.maxEntries > 0 ? o.maxEntries : 0;
  if (!Array.isArray(views) || maxEntries === 0) return [];
  const templateNameID = Number.isSafeInteger(o.templateNameID) && o.templateNameID >= 0 ? o.templateNameID : 0;
  const out = [];
  for (const view of views) {
    if (out.length >= maxEntries) break;
    const entry = entryOf(view, templateNameID);
    if (entry !== null) out.push(entry);
  }
  return out;
}

function buildHudIncursions(views) {
  if (!Array.isArray(views)) return [];
  const out = [];
  for (const view of views) {
    if (!view || view.state !== S.ROW_STATE.ACTIVE || view.phase === PHASE.OVER || !isId(view.incursionId)) continue;
    const scenes = scenesOf(view);
    if (scenes === null || !Number.isSafeInteger(view.influenceRawMilli) || !isTime(view.influenceUpdatedAt)
      || !isTime(view.graceMinutes) || !isTime(view.decayMilliPerHour)) continue;
    out.push({ taleId: S.taleIdOf(view.incursionId), factionId: view.factionId, systems: scenes,
      influenceMilli: view.influenceRawMilli, influenceUpdatedAt: view.influenceUpdatedAt,
      graceMinutes: view.graceMinutes, decayMilliPerHour: view.decayMilliPerHour });
  }
  return out;
}

module.exports = { buildUiEntries, buildHudIncursions };
