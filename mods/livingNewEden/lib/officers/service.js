"use strict";

const { deriveSeed } = require("../util/rng");
const { createAbortSentinel } = require("../persistence/store");
const { JOURNAL_MAX_KEY_LENGTH } = require("../persistence/migrations");
const { SOURCES, REASONS, COUNTER_NAMES, AGGREGATE, EVENT, SOURCE_EVENT } = require("./schema");
const { rollHit, dayOf, officerKeyOf, sourceKeyOf, systemRangeOf, dayRangeOf } = require("./policy");

const TX_NAME = "officerReserve";
const WRITE_ABORT = createAbortSentinel("officerSpawns.write");
const MAX_DETAIL = 120;

const SEAM_COUNTERS = Object.freeze({
  [REASONS.NOT_ELIGIBLE]: "notEligible",
  [REASONS.NO_SHIP]: "noShip",
  [REASONS.SCENE_NOT_LOADED]: "sceneNotLoaded",
  [REASONS.SPAWN_FAILED]: "spawnFailed",
});
const RESERVE_COUNTERS = Object.freeze({
  [REASONS.DUPLICATE]: "duplicate",
  [REASONS.LIMIT_SYSTEM]: "limitSystem",
  [REASONS.LIMIT_DAY]: "limitDay",
});

function toPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createOfficerSpawns(deps) {
  const { store, journal, clock, worldSeed, config } = deps;
  const getSeam = typeof deps.getSeam === "function" ? deps.getSeam : () => null;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));

  function bump(name) {
    if (!Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += 1;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`events.officerSpawns.${name}`, 1);
    } catch (_err) {
    }
  }

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`officerSpawns: ${line}`);
    } catch (_err) {
    }
  }

  function reserveInTx(source, sourceId, systemId, characterId, factionKey) {
    try {
      const day = dayOf(clock.now());
      const key = officerKeyOf(day, systemId, source, sourceId);
      const srcKey = sourceKeyOf(source, sourceId);
      const maxSystem = config.maxPerSystemPerDay;
      const maxDay = config.maxPerDay;
      const r = store.transaction(TX_NAME, (db) => {
        const seen = journal.findByKey(db, srcKey);
        if (!seen || seen.ok !== true) throw WRITE_ABORT;
        if (seen.found) return { ok: false, reason: REASONS.DUPLICATE };
        if (!(maxSystem > 0)) return { ok: false, reason: REASONS.LIMIT_SYSTEM };
        const [sysFrom, sysTo] = systemRangeOf(day, systemId);
        const inSystem = journal.countKeyRange(db, sysFrom, sysTo, maxSystem);
        if (!inSystem || inSystem.ok !== true) throw WRITE_ABORT;
        if (inSystem.count >= maxSystem) return { ok: false, reason: REASONS.LIMIT_SYSTEM };
        if (!(maxDay > 0)) return { ok: false, reason: REASONS.LIMIT_DAY };
        const [dayFrom, dayTo] = dayRangeOf(day);
        const inDay = journal.countKeyRange(db, dayFrom, dayTo, maxDay);
        if (!inDay || inDay.ok !== true) throw WRITE_ABORT;
        if (inDay.count >= maxDay) return { ok: false, reason: REASONS.LIMIT_DAY };
        const aggregate = { type: AGGREGATE, id: systemId };
        const a = journal.applyOnce(db, { key, aggregate, eventType: EVENT,
          payload: { source, sourceId, characterId, factionKey, day } }, () => null);
        if (!a || a.ok !== true || a.duplicate === true) throw WRITE_ABORT;
        const b = journal.applyOnce(db, { key: srcKey, aggregate, eventType: SOURCE_EVENT,
          payload: { day, systemId } }, () => null);
        if (!b || b.ok !== true || b.duplicate === true) throw WRITE_ABORT;
        return { ok: true };
      });
      if (!r || r.ok !== true) return { ok: false, reason: REASONS.TX_FAILED, detail: String((r && r.reason) || "") };
      return r.value && r.value.ok === true ? { ok: true } : r.value;
    } catch (err) {
      return { ok: false, reason: REASONS.TX_FAILED, detail: messageOf(err) };
    }
  }

  function inputOf(source, sourceId, i) {
    if (typeof sourceId !== "string" || sourceId.length === 0) return null;
    const systemId = toPositiveInt(i.systemId);
    const characterId = toPositiveInt(i.characterId);
    if (!systemId || !characterId) return null;
    const factionId = i.factionId === null || i.factionId === undefined ? null : i.factionId;
    if (factionId !== null && !Number.isSafeInteger(factionId)) return null;
    if (source === SOURCES.HUNT && factionId === null) return null;
    const longest = Math.max(officerKeyOf(dayOf(clock.now()), systemId, source, sourceId).length,
      sourceKeyOf(source, sourceId).length);
    if (longest > JOURNAL_MAX_KEY_LENGTH) return null;
    return { systemId, characterId, factionId };
  }

  function attempt(source, sourceIdRaw, raw, sourceEnabled, chancePermille) {
    if (config.enabled !== true) return { ok: false, reason: REASONS.DISABLED };
    if (sourceEnabled !== true) return { ok: false, reason: REASONS.SOURCE_DISABLED };
    let reservation = null;
    try {
      const i = raw && typeof raw === "object" ? inputOf(source, sourceIdRaw, raw) : null;
      if (!i) return { ok: false, reason: REASONS.INVALID_INPUT };
      bump("attempt");
      bump(`source.${source}`);
      if (!rollHit(deriveSeed(worldSeed, "officer", source, sourceIdRaw), chancePermille)) {
        bump("chanceMiss");
        return { ok: false, reason: REASONS.CHANCE_MISS };
      }
      const seam = getSeam();
      if (!seam || typeof seam.spawnOfficer !== "function" || typeof seam.factionKeyOf !== "function") {
        return { ok: false, reason: REASONS.SEAM_UNAVAILABLE };
      }
      const factionKey = i.factionId === null ? null : seam.factionKeyOf(i.factionId);
      if (source === SOURCES.HUNT && !factionKey) {
        bump("notPirate");
        return { ok: false, reason: REASONS.NOT_PIRATE };
      }
      const res = seam.spawnOfficer({ systemId: i.systemId, characterId: i.characterId, factionKey: factionKey || null,
        distanceMeters: config.spawnDistanceMeters,
        reserve: () => {
          reservation = reserveInTx(source, sourceIdRaw, i.systemId, i.characterId, factionKey || null);
          if (reservation.ok === true) bump("reserved");
          return reservation;
        } });
      if (res && res.ok === true) {
        bump("spawned");
        const key = String(res.factionKey || factionKey || "pirate");
        log(`${key} officer in ${i.systemId} for ${i.characterId} (${source} ${sourceIdRaw})`);
        return { ok: true, spawned: true, entityIds: Array.isArray(res.entityIds) ? res.entityIds : [] };
      }
      const reason = String((res && res.reason) || REASONS.SPAWN_FAILED);
      if (reason === REASONS.RESERVE_REFUSED) {
        const why = reservation && reservation.ok === false ? reservation.reason : REASONS.TX_FAILED;
        if (RESERVE_COUNTERS[why]) bump(RESERVE_COUNTERS[why]);
        else bump("error");
        return { ok: false, reason: why, ...(reservation && reservation.detail ? { detail: reservation.detail } : {}) };
      }
      if (SEAM_COUNTERS[reason]) bump(SEAM_COUNTERS[reason]);
      return { ok: false, reason, ...(res && res.detail ? { detail: String(res.detail) } : {}) };
    } catch (err) {
      bump("error");
      const reason = reservation && reservation.ok === true ? REASONS.SPAWN_FAILED : REASONS.TX_FAILED;
      return { ok: false, reason, detail: messageOf(err) };
    }
  }

  function tryHunt(i) {
    return attempt(SOURCES.HUNT, i && i.huntId, i, config.huntEnabled, config.huntChancePermille);
  }

  function trySalvage(i) {
    return attempt(SOURCES.SALVAGE, i && i.anomalyId, i, config.salvageEnabled, config.salvageChancePermille);
  }

  function getStatus() {
    return Object.freeze({ state: "running", counters: Object.freeze({ ...counters }) });
  }

  return Object.freeze({ tryHunt, trySalvage, getStatus });
}

module.exports = { createOfficerSpawns };
