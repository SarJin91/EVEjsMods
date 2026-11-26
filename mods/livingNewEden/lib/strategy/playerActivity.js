"use strict";

const MAX_DETAIL = 120;
const TX_NAME = "strategy.playerActivity";

class Rollback extends Error {
  constructor(detail) {
    super(String(detail).slice(0, MAX_DETAIL));
    this.name = "PlayerActivityRollback";
  }
}

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function createPlayerActivityService(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createPlayerActivityService: deps missing");
  const { store, repository, registry, config } = deps;
  if (!store || typeof store.transaction !== "function") {
    throw new TypeError("createPlayerActivityService: store with transaction required");
  }
  if (!repository || typeof repository.recordKillInTx !== "function") {
    throw new TypeError("createPlayerActivityService: repository with recordKillInTx required");
  }
  if (!registry || typeof registry.isActive !== "function") {
    throw new TypeError("createPlayerActivityService: registry with isActive required");
  }
  const worldRepositoryOf = () => {
    if (typeof deps.getWorldRepository === "function") return deps.getWorldRepository();
    return deps.world && deps.world.repository ? deps.world.repository : null;
  };
  const hooks = deps.telemetry && deps.telemetry.hooks ? deps.telemetry.hooks : null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  let failureLogged = false;

  function count(name) {
    if (!hooks || typeof hooks.onCount !== "function") return;
    try {
      hooks.onCount(name, 1);
    } catch (_err) {
    }
  }

  function skip(reason) {
    count("strategy.playerActivity.skipped");
    return { ok: true, skipped: reason };
  }

  function fail(reason, detail) {
    count("strategy.playerActivity.failed");
    if (logger && !failureLogged) {
      failureLogged = true;
      try {
        logger.log(`strategy: player activity write failed (${reason}${detail ? ` ${detail}` : ""}); `
          + "further failures only counted");
      } catch (_err) {
      }
    }
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  }

  function onNpcKill(kill) {
    try {
      if (!config || !config.strategy || config.strategy.playerActivityEnabled !== true) return skip("DISABLED");
      if (!kill || kill.rewardable !== true) return skip("NOT_REWARDABLE");
      if (!isId(kill.victimFactionId) || !isId(kill.systemId) || !isTime(kill.atMs)) return skip("INVALID_KILL");
      if (registry.isActive(kill.victimFactionId) !== true) return skip("INACTIVE_FACTION");
      const world = worldRepositoryOf();
      if (!world || typeof world.getSystem !== "function") return fail("WORLD_UNAVAILABLE");
      const victimId = isId(kill.victimId) ? kill.victimId : null;
      const result = store.transaction(TX_NAME, (tx) => {
        const got = world.getSystem(tx, kill.systemId, { includeInfluence: false });
        if (!got || got.ok !== true) throw new Rollback((got && got.reason) || "GET_SYSTEM_FAILED");
        if (!got.system) return { skipped: "NO_ROW" };
        const r = repository.recordKillInTx(tx, { factionId: kill.victimFactionId, systemId: kill.systemId,
          at: kill.atMs, victimId });
        if (!r || r.ok !== true) throw new Rollback((r && (r.detail ? `${r.reason}:${r.detail}` : r.reason)) || "NO_RESULT");
        return { record: r.record, duplicate: r.duplicate === true, evicted: r.evicted };
      });
      if (!result || result.ok !== true) {
        const err = result && result.error;
        return fail(err instanceof Rollback ? "PLAYER_ACTIVITY_TX_FAILED" : (result && result.reason) || "TX_FAILED",
          err ? messageOf(err) : undefined);
      }
      const out = result.value;
      if (out.skipped) return skip(out.skipped);
      return { ok: true, record: out.record, ...(out.duplicate ? { duplicate: true } : {}), evicted: out.evicted };
    } catch (err) {
      return fail("PLAYER_ACTIVITY_FAILED", messageOf(err));
    }
  }

  return Object.freeze({ onNpcKill });
}

module.exports = { createPlayerActivityService };
