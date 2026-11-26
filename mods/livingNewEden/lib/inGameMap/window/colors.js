"use strict";

const FACTION_HEX = Object.freeze({
  500001: "#4f8fe0",
  500002: "#c0533f",
  500003: "#e0b13c",
  500004: "#3fb36b",
  500010: "#d6d640",
  500011: "#e07a2c",
  500012: "#a3202a",
  500016: "#f07fa8",
  500019: "#9a5be0",
  500020: "#7fb83a",
});
const SEC_HEX = Object.freeze(["#f00000", "#d73000", "#f04800", "#f06000", "#d77700", "#efef00", "#8fef2f",
  "#00f000", "#00ef47", "#48f0c0", "#2fefef"]);
const NULL_SEC_HEX = "#8a1010";
const NULLSEC_CLASS = 2;
const HUE_TURN = 360;
const HASH_SATURATION = 65;
const HASH_LIGHTNESS = 58;
const PERCENT = 100;
const CHANNEL_MAX = 255;
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

function hexToRgb(hex) {
  const n = Number.parseInt(String(hex).slice(1), 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function hashHue(id) {
  let h = FNV_OFFSET;
  const text = String(id);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h % HUE_TURN;
}

function hslToRgb(h, s, l) {
  const sat = s / PERCENT;
  const light = l / PERCENT;
  const f = (n) => {
    const k = (n + h / 30) % 12;
    const a = sat * Math.min(light, 1 - light);
    return light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)].map((v) => Math.round(v * CHANNEL_MAX));
}

function factionRgb(id) {
  const fixed = FACTION_HEX[id];
  return fixed ? hexToRgb(fixed) : hslToRgb(hashHue(id), HASH_SATURATION, HASH_LIGHTNESS);
}

function secRgb(tenths, cls) {
  if (cls === NULLSEC_CLASS) return hexToRgb(NULL_SEC_HEX);
  if (typeof tenths !== "number" || !Number.isFinite(tenths)) return hexToRgb(NULL_SEC_HEX);
  const t = Math.round(tenths);
  if (t <= 0) return hexToRgb(t === 0 ? SEC_HEX[0] : NULL_SEC_HEX);
  return hexToRgb(SEC_HEX[Math.min(SEC_HEX.length - 1, t)]);
}

module.exports = { FACTION_HEX, SEC_HEX, NULL_SEC_HEX, hexToRgb, hashHue, hslToRgb, factionRgb, secRgb };
