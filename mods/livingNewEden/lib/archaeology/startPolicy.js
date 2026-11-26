"use strict";

const { deriveSeed, deterministicUnit } = require("../util/rng");
const { CHAIN_ID_PREFIX } = require("./schema");

const START_FAMILIES = Object.freeze(["data", "relic"]);
const PERMILLE = 1000;

function gateWin(win, input) {
  if (!win || win.excluded === true) return { ok: false, reason: "EXCLUDED" };
  if (win.own === true && typeof win.lneEventId === "string" && win.lneEventId.startsWith(CHAIN_ID_PREFIX)) {
    return { ok: false, reason: "OWN_ARCH" };
  }
  if (!START_FAMILIES.includes(win.siteFamily)) return { ok: false, reason: "FAMILY" };
  const secClass = input ? input.secClass : null;
  if (secClass === null || secClass === undefined) return { ok: false, reason: "SYSTEM_UNKNOWN" };
  const allowed = input && input.allowedSecClasses instanceof Set ? input.allowedSecClasses : new Set();
  if (!allowed.has(secClass)) return { ok: false, reason: "SEC_CLASS" };
  return { ok: true };
}

function rollStart(worldSeed, win, chancePermille) {
  const seed = deriveSeed(worldSeed, "arch:start", win.instanceId, win.outcomeId);
  return { hit: deterministicUnit(seed, "roll") * PERMILLE < chancePermille, seed };
}

function checkLimits(counts, settings, now) {
  if (counts.hasActive) return { ok: false, reason: "ACTIVE_EXISTS" };
  if (counts.seasonCount >= settings.chainsPerCharacterPerSeason) return { ok: false, reason: "SEASON_LIMIT" };
  if (counts.lastEndedAt !== null && counts.lastEndedAt + settings.restartCooldownMs > now) {
    return { ok: false, reason: "COOLDOWN" };
  }
  if (counts.activeTotal >= settings.maxActiveChains) return { ok: false, reason: "GLOBAL_LIMIT" };
  return { ok: true };
}

module.exports = { START_FAMILIES, gateWin, rollStart, checkLimits };
