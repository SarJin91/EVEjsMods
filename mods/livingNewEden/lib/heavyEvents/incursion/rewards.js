"use strict";

const ROLES = Object.freeze(["hq", "assault", "vanguard", "staging"]);
const LP_MAX = 1000000;
const SITE_PREFIX = "hin";
const SITE_ID_PARTS = 5;

function parseLpPerRole(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const out = Object.fromEntries(ROLES.map((r) => [r, 0]));
  const seen = new Set();
  for (const token of text.split(",")) {
    const parts = token.trim().split(":");
    if (parts.length !== 2) return null;
    const role = parts[0].trim();
    const value = parts[1].trim();
    if (!ROLES.includes(role) || seen.has(role) || !/^\d{1,7}$/.test(value)) return null;
    const n = Number(value);
    if (n > LP_MAX) return null;
    seen.add(role);
    out[role] = n;
  }
  return Object.freeze(out);
}

function roleOfIncursionEventId(eventId) {
  if (typeof eventId !== "string") return null;
  const parts = eventId.split(":");
  if (parts.length !== SITE_ID_PARTS || parts[0] !== SITE_PREFIX) return null;
  const role = parts[3].split(".")[0];
  return ROLES.includes(role) ? role : null;
}

module.exports = { ROLES, LP_MAX, parseLpPerRole, roleOfIncursionEventId };
