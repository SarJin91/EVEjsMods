"use strict";

const FACTION_KEYS = Object.freeze(["costIsk", "minBalanceMultiple", "maxPerFaction", "maxPerSystem",
  "maxBuildsPerReview", "maxCandidateSystems", "allowHighsec"]);

function sentryFactionParamsOf(config) {
  const c = config || {};
  const strategyOn = Boolean(c.modules && c.modules.strategy && c.modules.strategy.enabled === true);
  const S = c.sentries;
  if (!strategyOn || !S || S.enabled !== true || !S.faction || S.faction.enabled !== true) return null;
  return Object.freeze({ ...Object.fromEntries(FACTION_KEYS.map((k) => [k, S.faction[k]])),
    maxPerAnchor: S.maxPerAnchor, maxTotal: S.maxTotal });
}

module.exports = { sentryFactionParamsOf };
