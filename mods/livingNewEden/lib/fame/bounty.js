"use strict";

const { TIER } = require("./schema");
const { bountyLevelOf } = require("./rules");

const BOUNTY_SEC_CLASSES = Object.freeze(["lowsec", "nullsec"]);
const SPACE = "space";
const HIGHSEC = "highsec";

const wait = (reason) => ({ post: false, wait: reason });

function planFameBounty(pair, facts, p) {
  if (!p || p.bountyEnabled !== true) return wait("OFF");
  if (!pair || pair.tier !== TIER.PUBLIC_ENEMY || typeof pair.standing !== "number"
    || !Number.isFinite(pair.standing)) return wait("NOT_ENEMY");
  const now = facts ? facts.now : NaN;
  if (!Number.isSafeInteger(pair.enemySince) || !Number.isSafeInteger(now)
    || now - pair.enemySince < p.bountyDelayAfterTierMs) return wait("DELAY");
  const located = facts.located;
  if (!located || !Number.isSafeInteger(located.systemId) || located.systemId <= 0) return wait("NOT_LOCATED");
  if (located.state !== SPACE) return wait("NOT_IN_SPACE");
  if (!BOUNTY_SEC_CLASSES.includes(facts.secClass)
    && !(p.bountyHighsecEnabled === true && facts.secClass === HIGHSEC)) return wait("SEC_CLASS");
  return { post: true, period: Math.floor(now / p.bountyCooldownMs), level: bountyLevelOf(pair.standing, p),
    systemId: located.systemId };
}

module.exports = { planFameBounty, BOUNTY_SEC_CLASSES };
