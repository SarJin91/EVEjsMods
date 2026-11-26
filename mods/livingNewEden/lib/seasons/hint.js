"use strict";

const { STATE } = require("./schema");

const DAY_MS = 86400000;
const MAX_HINT_LINES = 3;
const MAX_HINT_CHARS = 160;
const MAX_HINT_REGIONS = 3;

const kindLabelOf = (kind) => String(kind || "crisis").toLowerCase().replace(/_/g, " ");

function asciiCut(text, max) {
  const s = String(text).replace(/[^\x20-\x7e]/g, "?");
  return s.length <= max ? s : s.slice(0, Math.max(0, max));
}

const daysUntil = (at, now) => Math.max(0, Math.ceil((at - now) / DAY_MS));

const isRunningSeason = (s) => Boolean(s) && (s.state === STATE.ACTIVE || s.state === STATE.FINALE);

function namerOf(names) {
  const pick = (fn, id, fallback) => {
    try {
      const n = names && typeof names[fn] === "function" ? names[fn](id) : null;
      return typeof n === "string" && n.trim() !== "" ? n : fallback;
    } catch (_err) {
      return fallback;
    }
  };
  return {
    faction: (id) => (Number.isSafeInteger(id) ? pick("factionName", id, `faction ${id}`) : "unknown faction"),
    region: (id) => pick("regionName", id, `region ${id}`),
  };
}

function hintOf(season, names, now) {
  if (!isRunningSeason(season)) return null;
  const n = namerOf(names);
  const lines = [`Season ${season.seasonNo} crisis: ${n.faction(season.factionId)} ${kindLabelOf(season.crisisKind)} `
    + `(stage ${season.stage + 1}/${season.stageCount}, ${daysUntil(season.endsAt, now)} days left)`];
  const regions = Array.isArray(season.regionIds) ? season.regionIds.slice(0, MAX_HINT_REGIONS) : [];
  if (regions.length > 0) lines.push(`Crisis regions: ${regions.map((r) => n.region(r)).join(", ")}`);
  return { lines: lines.slice(0, MAX_HINT_LINES).map((l) => asciiCut(l, MAX_HINT_CHARS)) };
}

module.exports = { hintOf, kindLabelOf, asciiCut, daysUntil, isRunningSeason, namerOf, MAX_HINT_LINES,
  MAX_HINT_CHARS, DAY_MS };
