"use strict";

const DEFAULT_SECURITY_BANDS = "0.75:0.5:0.5;0.55:0.75:0.75;0.45:1:1;0:1.5:1.25;-1:2:1.5";
const LIMITS = Object.freeze({ minSec: [-1, 1], sizeMultiplier: [0.1, 10], specialChanceMultiplier: [0, 10] });
const MAX_BANDS = 16;
const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function inRange(value, [lo, hi]) {
  return Number.isFinite(value) && value >= lo && value <= hi;
}

function parseSecurityBands(text) {
  if (typeof text !== "string" || text.trim() === "") return { ok: false, reason: "BAD_BANDS", detail: "empty" };
  const parts = text.split(";").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0 || parts.length > MAX_BANDS) {
    return { ok: false, reason: "BAD_BANDS", detail: `1..${MAX_BANDS} bands` };
  }
  const bands = [];
  for (const part of parts) {
    const fields = part.split(":").map((f) => f.trim());
    if (fields.length !== 3 || !fields.every((f) => NUMBER_RE.test(f))) {
      return { ok: false, reason: "BAD_BANDS", detail: `band "${part}" is not minSec:size:special` };
    }
    const [minSec, sizeMultiplier, specialChanceMultiplier] = fields.map(Number);
    const band = { minSec, sizeMultiplier, specialChanceMultiplier };
    for (const name of Object.keys(LIMITS)) {
      if (!inRange(band[name], LIMITS[name])) {
        return { ok: false, reason: "BAD_BANDS", detail: `${name} ${band[name]} outside ${LIMITS[name].join("..")}` };
      }
    }
    if (bands.some((b) => b.minSec === minSec)) {
      return { ok: false, reason: "BAD_BANDS", detail: `duplicate minSec ${minSec}` };
    }
    bands.push(Object.freeze(band));
  }
  bands.sort((a, b) => b.minSec - a.minSec);
  return { ok: true, bands: Object.freeze(bands) };
}

function selectSecurityBand(bands, security) {
  if (!Array.isArray(bands) || !Number.isFinite(security)) return null;
  for (const band of bands) {
    if (security >= band.minSec) return band;
  }
  return null;
}

module.exports = { DEFAULT_SECURITY_BANDS, parseSecurityBands, selectSecurityBand };
