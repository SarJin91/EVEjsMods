"use strict";

const { performance } = require("node:perf_hooks");
const {
  IDENTITY_KINDS,
  IDENTITY_STATES,
  OWNER_KINDS,
  OWNER_PREFIXES,
  foundingOpOf,
  parseIdentityKey,
  REASON_INVALID_AT,
  isValidAt,
  atOfClock,
} = require("./schema");

const { buildVirtualCharacterRecord, pickGender } = require("./characterRecord");
const { chooseCharacterName } = require("./nameChoice");
const { ATTEMPTS_PER_TIER } = require("../names");

const isTerminal = (state) => state === IDENTITY_STATES.LINKED || state === IDENTITY_STATES.REFUSED
  || state === IDENTITY_STATES.RELEASED;

const MAX_NAME_VARIANTS = 5;

const FREE_SAGA_FLUSH_TABLES = Object.freeze(["characters", "corporations", "corporationRuntime"]);

function countFree(fs, name, n) {
  if (!fs || !fs.tel || typeof fs.tel.count !== "function" || !(n > 0)) return;
  try {
    fs.tel.count(name, n);
  } catch (_err) {
  }
}

function observeFree(fs, name, ms, at) {
  if (!fs || !fs.tel || typeof fs.tel.observe !== "function") return;
  try {
    fs.tel.observe(name, ms, at);
  } catch (_err) {
  }
}

function countNames(tel, name) {
  if (!tel) return;
  try {
    tel.count(name, 1);
  } catch (_err) {
  }
}

async function pickNameFor(ctx, row, characterId, raceId, gender) {
  const S = ctx.names || {};
  if (S.characterNamesEnabled !== true) return ctx.adapter.pickCharacterName(raceId);
  const parsed = parseIdentityKey(row.identity_key);
  const ownerKind = parsed ? Object.keys(OWNER_PREFIXES).find((k) => OWNER_PREFIXES[k] === parsed.ownerPrefix) : null;
  const res = chooseCharacterName({ adapter: ctx.adapter, worldSeed: S.worldSeed,
    settings: { maxAttempts: S.maxAttempts } },
  { identityKey: row.identity_key, characterId, ownerKind: ownerKind || "", ownerId: parsed ? parsed.factionId : 0,
    raceId, gender });
  if (res.ok && res.reused) countNames(S.tel, "names.reused");
  else if (res.ok) {
    countNames(S.tel, "names.generated");
    if (res.attempt >= ATTEMPTS_PER_TIER) countNames(S.tel, "names.variant");
  } else if (res.reason === "NAME_UNAVAILABLE") countNames(S.tel, "names.unavailable");
  return res;
}

async function drainMemberStates(ctx, ctxState) {
  const fs = ctxState && ctxState.freeSaga;
  if (!fs || !Array.isArray(ctxState.pendingMemberStates) || ctxState.pendingMemberStates.length === 0) return;
  const list = ctxState.pendingMemberStates;
  ctxState.pendingMemberStates = [];
  let res = null;
  try {
    res = await ctx.adapter.virtualIdentityEnsureMemberStates(list);
  } catch (err) {
    res = { ok: false, reason: String((err && err.message) || err).slice(0, 120) };
  }
  const failed = res && res.ok === true ? res.failed : list.length;
  if (failed > 0) {
    countFree(fs, "virtualCorps.freeMemberStateFailed", failed);
    const reason = res && res.ok === true ? res.firstReason : res && res.reason;
    ctx.logger.log(`virtualCorps: deferred member states failed ${failed}/${list.length}: ${reason || "UNKNOWN"}`);
  }
}

async function flushSlice(ctx, ctxState) {
  const fs = ctxState.freeSaga;
  if (!fs) {
    await ctx.adapter.virtualIdentityFlush();
    return;
  }
  const started = performance.now();
  if (fs.lean === true) {
    await drainMemberStates(ctx, ctxState);
    await ctx.adapter.virtualIdentityFlush(FREE_SAGA_FLUSH_TABLES);
  } else {
    await ctx.adapter.virtualIdentityFlush();
  }
  observeFree(fs, "virtualCorps.freeSagaFlushMs", performance.now() - started, atOfClock(ctx.clock));
}

function generateNameVariant(baseName, baseTicker, attempt) {
  const suffixes = [" II", " III", " IV", " V"];
  const suffix = suffixes[attempt - 1] || ` ${attempt + 1}`;
  const name = `${baseName}${suffix}`.substring(0, 64);

  const tickerBase = baseTicker.substring(0, 4);
  const tickerDigit = String(Math.min(attempt + 1, 5));
  const ticker = `${tickerBase}${tickerDigit}`.substring(0, 5);

  return { name, ticker };
}

async function updateStateWithCAS(ctx, identityKey, expectedVersion, newState, extra = {}) {
  const { repo, logger } = ctx;
  let attempt = 0;
  const maxAttempts = 3;
  const at = atOfClock(ctx.clock);
  if (!isValidAt(at)) return { ok: false, reason: REASON_INVALID_AT };
  extra = { ...extra, at };

  while (attempt < maxAttempts) {
    const getRes = repo.getByKey(identityKey);
    if (!getRes.ok) return { ok: false, reason: getRes.reason };
    const row = getRes.row;
    if (row.version !== expectedVersion) {
      attempt++;
      if (attempt >= maxAttempts) return { ok: false, reason: "CAS_FAILED" };
      expectedVersion = row.version;
      continue;
    }
    const upRes = repo.updateState(identityKey, expectedVersion, newState, extra);
    if (!upRes.ok && upRes.reason === "CAS_FAILED") {
      attempt++;
      if (attempt >= maxAttempts) return { ok: false, reason: "CAS_FAILED" };
      expectedVersion = row.version + 1;
      continue;
    }
    if (!upRes.ok) {
      return { ok: false, reason: upRes.reason };
    }
    const newRow = repo.getByKey(identityKey);
    return { ok: true, row: newRow.row };
  }
  return { ok: false, reason: "CAS_FAILED" };
}

async function refuse(ctx, row, reason) {
  const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.REFUSED, { reason });
  if (!upRes.ok) return { ok: false, reason: upRes.reason };
  row.version = upRes.row.version;
  return { ok: true, row: upRes.row };
}

async function processStep(ctx, row, factionData, ctxState) {
  const { adapter, repo, logger } = ctx;
  const parsed = parseIdentityKey(row.identity_key);
  if (!parsed) return { ok: false, reason: "INVALID_KEY" };
  if (isTerminal(row.state)) {
    return { ok: true, deferred: true };
  }
  if (!isValidAt(atOfClock(ctx.clock))) return { ok: false, reason: REASON_INVALID_AT };

  switch (row.kind) {
    case "character":
      if (parsed.slot === 0 && parsed.n === 0) {
        return processCEO(ctx, row, factionData, ctxState);
      }
      return processCharacter(ctx, row, factionData, ctxState);

    case "corporation":
      if (parsed.slot === 0) {
        return processCorp0(ctx, row, factionData, ctxState);
      }
      return processCorpN(ctx, row, factionData, ctxState);

    case "alliance":
      return processAlliance(ctx, row, factionData, ctxState);

    default:
      logger.log(`virtualCorps: unknown kind ${row.kind} for ${row.identity_key}`);
      return { ok: false, reason: "UNKNOWN_KIND" };
  }
}

async function processCEO(ctx, row, factionData, ctxState) {
  const { adapter, repo, logger } = ctx;
  const parsed = parseIdentityKey(row.identity_key);

  if (row.state === IDENTITY_STATES.PLANNED) {
    const reserveRes = await adapter.reserveCharacterId();
    if (!reserveRes.ok) {
      logger.log(`virtualCorps: reserveCharacterId failed for ${row.identity_key}: ${reserveRes.reason}`);
      return { ok: false, reason: reserveRes.reason };
    }
    const characterId = reserveRes.characterId;
    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.RESERVED, { evejsId: characterId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    row.version = upRes.row.version;
    row.evejs_id = characterId;
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.RESERVED) {
    const characterId = row.evejs_id;
    if (!characterId) {
      const refuseRes = await refuse(ctx, row, "NO_EVEJS_ID");
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: "NO_EVEJS_ID", refused: true };
    }

    const bloodlineIds = factionData.bloodlineIds || [1];
    const bloodlineId = bloodlineIds[0];
    const bloodlineRes = await adapter.resolveCharacterCreationBloodlineProfile(bloodlineId);
    const raceId = bloodlineRes.ok ? bloodlineRes.raceId : 1;
    const typeId = bloodlineRes.ok ? bloodlineRes.typeId : 1;

    const gender = pickGender(characterId);
    let nameRes = await pickNameFor(ctx, row, characterId, raceId, gender);
    let name = nameRes.ok ? nameRes.name : null;

    if (!nameRes.ok && nameRes.reason === "NAME_UNAVAILABLE") {
      const refuseRes = await refuse(ctx, row, "NAME_UNAVAILABLE");
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: "NAME_UNAVAILABLE", refused: true };
    }
    if (!nameRes.ok && ctx.names && ctx.names.characterNamesEnabled === true) {
      return { ok: false, reason: nameRes.reason };
    }

    const ownerCorpId = factionData.ownerCorporationId || 0;
    const stationId = factionData.stationId || 0;
    const systemId = factionData.systemId || 0;
    const constellationId = factionData.constellationId || 0;
    const regionId = factionData.regionId || 0;
    const securityRating = factionData.securityRating || 0;
    const nowMs = atOfClock(ctx.clock);

    const record = buildVirtualCharacterRecord({
      identityKey: row.identity_key,
      name,
      gender,
      bloodlineId,
      raceId,
      typeId,
      corporationId: ownerCorpId,
      stationId,
      systemId,
      constellationId,
      regionId,
      securityRating,
      nowMs,
    });
    record.characterId = characterId;

    const writeRes = await adapter.writeCharacter(record);
    if (!writeRes.ok) {
      logger.log(`virtualCorps: writeCharacter failed for ${characterId}: ${writeRes.reason}`);
      const refuseRes = await refuse(ctx, row, writeRes.reason);
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: writeRes.reason, refused: true };
    }

    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: characterId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    row.version = upRes.row.version;
    ctxState.ceoId = characterId;
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.CREATED) {
    if (!ctxState.corp0Id) return { ok: true, deferred: true };
    const characterId = row.evejs_id;
    const fs = ctxState.freeSaga;
    const joinRes = fs && fs.lean === true
      ? await adapter.joinCorporation(characterId, ctxState.corp0Id, ctxState.allianceId || 0,
        { skipWhenAffiliated: true })
      : await adapter.joinCorporation(characterId, ctxState.corp0Id, ctxState.allianceId || 0);
    if (fs && !(joinRes.ok && joinRes.already === true)) countFree(fs, "virtualCorps.freeAffiliations", 1);
    if (!joinRes.ok) {
      logger.log(`virtualCorps: joinCorporation failed for ${characterId}: ${joinRes.reason}`);
      return { ok: false, reason: joinRes.reason };
    }
    if (fs && joinRes.already === true) {
      countFree(fs, joinRes.memberStateEnsured === true ? "virtualCorps.freeCeoMemberStateRepaired"
        : "virtualCorps.freeCeoJoinSkipped", 1);
    }
    if (fs && joinRes.readFallback === true) countFree(fs, "virtualCorps.freeCeoJoinReadFallback", 1);

    ctxState.charIds.push(characterId);

    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.LINKED, { evejsId: characterId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    return { ok: true, linked: true };
  }

  return { ok: true, deferred: true };
}

async function processCorp0(ctx, row, factionData, ctxState) {
  const { adapter, repo, logger } = ctx;
  const parsed = parseIdentityKey(row.identity_key);

  if (!ctxState.ceoId) return { ok: true, deferred: true };

  const corporations = factionData.corporations || [];
  const corpData = corporations[0] || {};
  const baseName = corpData.name || row.name;
  const baseTicker = corpData.ticker || row.ticker;

  if (row.state === IDENTITY_STATES.PLANNED) {
    let attempt = 0;
    let corpId = null;

    while (attempt < MAX_NAME_VARIANTS) {
      const variant = attempt === 0 ? { name: baseName, ticker: baseTicker } : generateNameVariant(baseName, baseTicker, attempt);

      const createRes = await adapter.ensureCorporation(ctxState.ceoId, {
        name: variant.name,
        tickerName: variant.ticker,
        description: factionData.description ?? `Virtual corporation of ${factionData.name}`,
        stationID: factionData.stationId || 0,
        foundingOperationID: row.founding_op,
      });

      if (createRes.ok) {
        corpId = createRes.corporationId;
        if (attempt > 0) {
          const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: corpId, name: variant.name, ticker: variant.ticker });
          if (!upRes.ok) return { ok: false, reason: upRes.reason };
          row.version = upRes.row.version;
        } else {
          const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: corpId });
          if (!upRes.ok) return { ok: false, reason: upRes.reason };
          row.version = upRes.row.version;
        }
        break;
      }

      if (createRes.reason === "NAME_TAKEN" || createRes.reason === "TICKER_TAKEN") {
        attempt++;
        continue;
      }

      logger.log(`virtualCorps: ensureCorporation failed for ${row.identity_key}: ${createRes.reason}`);
      const refuseRes = await refuse(ctx, row, createRes.reason);
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: createRes.reason, refused: true };
    }

    if (!corpId) {
      const refuseRes = await refuse(ctx, row, "NAME_TAKEN");
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: "NAME_TAKEN", refused: true };
    }

    const noWarRes = await adapter.markCorporationNoWar(corpId);
    if (!noWarRes.ok) {
      logger.log(`virtualCorps: markCorporationNoWar failed for ${corpId}: ${noWarRes.reason}`);
      return { ok: false, reason: noWarRes.reason };
    }

    ctxState.corp0Id = corpId;
    ctxState.corpIds.push(corpId);
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.CREATED) {
    const corpId = row.evejs_id;
    const noWarRes = await adapter.markCorporationNoWar(corpId);
    if (!noWarRes.ok) {
      logger.log(`virtualCorps: markCorporationNoWar failed for corp ${corpId}: ${noWarRes.reason}`);
      return { ok: false, reason: noWarRes.reason };
    }
    if (ctxState.allianceId) {
      const joinRes = await adapter.joinAlliance(corpId, ctxState.allianceId);
      if (!joinRes.ok) {
        logger.log(`virtualCorps: joinAlliance failed for corp ${corpId}: ${joinRes.reason}`);
        return { ok: false, reason: joinRes.reason };
      }
    }
    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.LINKED, { evejsId: corpId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    return { ok: true, linked: true, needsFlush: true };
  }

  return { ok: true, deferred: true };
}

async function processAlliance(ctx, row, factionData, ctxState) {
  const { adapter, repo, logger } = ctx;
  const parsed = parseIdentityKey(row.identity_key);

  if (!ctxState.corp0Id) return { ok: true, deferred: true };

  const baseName = factionData.alliance?.name || row.name;
  const baseTicker = factionData.alliance?.ticker || row.ticker;

  if (row.state === IDENTITY_STATES.PLANNED) {
    let attempt = 0;
    let allianceId = null;

    while (attempt < MAX_NAME_VARIANTS) {
      const variant = attempt === 0 ? { name: baseName, ticker: baseTicker } : generateNameVariant(baseName, baseTicker, attempt);

      const createRes = await adapter.ensureAlliance(
        ctxState.ceoId,
        ctxState.corp0Id,
        {
          name: variant.name,
          shortName: variant.ticker,
          description: `Virtual alliance of ${factionData.name}`,
          foundingOperationID: row.founding_op,
        }
      );

      if (createRes.ok) {
        allianceId = createRes.allianceId;
        if (attempt > 0) {
          const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: allianceId, name: variant.name, ticker: variant.ticker });
          if (!upRes.ok) return { ok: false, reason: upRes.reason };
          row.version = upRes.row.version;
        } else {
          const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: allianceId });
          if (!upRes.ok) return { ok: false, reason: upRes.reason };
          row.version = upRes.row.version;
        }
        break;
      }

      if (createRes.reason === "NAME_TAKEN" || createRes.reason === "SHORT_NAME_TAKEN") {
        attempt++;
        continue;
      }

      logger.log(`virtualCorps: ensureAlliance failed for ${row.identity_key}: ${createRes.reason}`);
      const refuseRes = await refuse(ctx, row, createRes.reason);
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: createRes.reason, refused: true };
    }

    if (!allianceId) {
      const refuseRes = await refuse(ctx, row, "NAME_TAKEN");
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: "NAME_TAKEN", refused: true };
    }

    const npcRes = await adapter.markAllianceNpc(allianceId);
    if (!npcRes.ok) {
      logger.log(`virtualCorps: markAllianceNpc failed for ${allianceId}: ${npcRes.reason}`);
      return { ok: false, reason: npcRes.reason };
    }

    ctxState.allianceId = allianceId;
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.CREATED) {
    const allianceId = row.evejs_id;
    const npcRes = await adapter.markAllianceNpc(allianceId);
    if (!npcRes.ok) {
      logger.log(`virtualCorps: markAllianceNpc failed for alliance ${allianceId}: ${npcRes.reason}`);
      return { ok: false, reason: npcRes.reason };
    }
    const joinRes = await adapter.joinAlliance(ctxState.corp0Id, allianceId);
    if (!joinRes.ok) {
      logger.log(`virtualCorps: joinAlliance failed for corp0 ${ctxState.corp0Id}: ${joinRes.reason}`);
      return { ok: false, reason: joinRes.reason };
    }
    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.LINKED, { evejsId: allianceId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    return { ok: true, linked: true, needsFlush: true };
  }

  return { ok: true, deferred: true };
}

async function processCharacter(ctx, row, factionData, ctxState) {
  const { adapter, repo, logger } = ctx;
  const parsed = parseIdentityKey(row.identity_key);

  if (row.state === IDENTITY_STATES.PLANNED) {
    const reserveRes = await adapter.reserveCharacterId();
    if (!reserveRes.ok) {
      logger.log(`virtualCorps: reserveCharacterId failed for ${row.identity_key}: ${reserveRes.reason}`);
      return { ok: false, reason: reserveRes.reason };
    }
    const characterId = reserveRes.characterId;
    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.RESERVED, { evejsId: characterId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    row.version = upRes.row.version;
    row.evejs_id = characterId;
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.RESERVED) {
    const corpId = ctxState.corpIds[parsed.slot];
    if (!corpId) return { ok: true, deferred: true };
    const characterId = row.evejs_id;
    if (!characterId) {
      const refuseRes = await refuse(ctx, row, "NO_EVEJS_ID");
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: "NO_EVEJS_ID", refused: true };
    }

    const bloodlineIds = factionData.bloodlineIds || [1];
    const bloodlineId = bloodlineIds[parsed.n % bloodlineIds.length];
    const bloodlineRes = await adapter.resolveCharacterCreationBloodlineProfile(bloodlineId);
    const raceId = bloodlineRes.ok ? bloodlineRes.raceId : 1;
    const typeId = bloodlineRes.ok ? bloodlineRes.typeId : 1;

    const gender = pickGender(characterId);
    const nameRes = await pickNameFor(ctx, row, characterId, raceId, gender);
    if (!nameRes.ok) {
      logger.log(`virtualCorps: pickCharacterName failed for race ${raceId}: ${nameRes.reason}`);
      if (ctx.names && ctx.names.characterNamesEnabled === true && nameRes.reason !== "NAME_UNAVAILABLE") {
        return { ok: false, reason: nameRes.reason };
      }
      const refuseRes = await refuse(ctx, row, nameRes.reason);
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: nameRes.reason, refused: true };
    }
    const name = nameRes.name;

    const startInCorp = Boolean(ctxState.freeSaga && ctxState.freeSaga.membersStartInCorp === true);
    const ownerCorpId = startInCorp ? corpId : factionData.ownerCorporationId || ctxState.corp0Id;
    const stationId = factionData.stationId || 0;
    const systemId = factionData.systemId || 0;
    const constellationId = factionData.constellationId || 0;
    const regionId = factionData.regionId || 0;
    const securityRating = factionData.securityRating || 0;
    const nowMs = atOfClock(ctx.clock);

    const record = buildVirtualCharacterRecord({
      identityKey: row.identity_key,
      name,
      gender,
      bloodlineId,
      raceId,
      typeId,
      corporationId: ownerCorpId,
      stationId,
      systemId,
      constellationId,
      regionId,
      securityRating,
      nowMs,
    });
    record.characterId = characterId;

    const writeRes = await adapter.writeCharacter(record);
    if (!writeRes.ok) {
      logger.log(`virtualCorps: writeCharacter failed for ${characterId}: ${writeRes.reason}`);
      const refuseRes = await refuse(ctx, row, writeRes.reason);
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: writeRes.reason, refused: true };
    }

    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: characterId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    row.version = upRes.row.version;
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.CREATED) {
    const corpId = ctxState.corpIds[parsed.slot];
    if (!corpId) return { ok: true, deferred: true };
    const characterId = row.evejs_id;
    const fs = ctxState.freeSaga;
    const deferMemberState = Boolean(fs && fs.lean === true);
    const joinRes = deferMemberState
      ? await adapter.joinCorporation(characterId, corpId, ctxState.allianceId || 0, { memberState: false })
      : await adapter.joinCorporation(characterId, corpId, ctxState.allianceId || 0);
    if (fs) countFree(fs, "virtualCorps.freeAffiliations", 1);
    if (!joinRes.ok) {
      logger.log(`virtualCorps: joinCorporation failed for ${characterId}: ${joinRes.reason}`);
      return { ok: false, reason: joinRes.reason };
    }
    if (deferMemberState && joinRes.memberStateDeferred === true) {
      ctxState.pendingMemberStates.push({ corporationId: corpId, characterId });
      countFree(fs, "virtualCorps.freeMemberStatesDeferred", 1);
    }

    ctxState.charIds.push(characterId);
    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.LINKED, { evejsId: characterId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    return { ok: true, linked: true };
  }

  return { ok: true, deferred: true };
}

async function processCorpN(ctx, row, factionData, ctxState) {
  const { adapter, repo, logger } = ctx;
  const parsed = parseIdentityKey(row.identity_key);

  if (!ctxState.ceoId || !ctxState.allianceId) return { ok: true, deferred: true };

  const corporations = factionData.corporations || [];
  const corpData = corporations[parsed.slot] || {};
  const baseName = corpData.name || row.name;
  const baseTicker = corpData.ticker || row.ticker;

  if (row.state === IDENTITY_STATES.PLANNED) {
    let attempt = 0;
    let corpId = null;

    while (attempt < MAX_NAME_VARIANTS) {
      const variant = attempt === 0 ? { name: baseName, ticker: baseTicker } : generateNameVariant(baseName, baseTicker, attempt);

      const createRes = await adapter.ensureCorporation(
        ctxState.ceoId,
        {
          name: variant.name,
          tickerName: variant.ticker,
          description: `Virtual corporation of ${factionData.name}`,
          stationID: factionData.stationId || 0,
        foundingOperationID: row.founding_op,
      });

      if (createRes.ok) {
        corpId = createRes.corporationId;
        if (attempt > 0) {
          const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: corpId, name: variant.name, ticker: variant.ticker });
          if (!upRes.ok) return { ok: false, reason: upRes.reason };
          row.version = upRes.row.version;
        } else {
          const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.CREATED, { evejsId: corpId });
          if (!upRes.ok) return { ok: false, reason: upRes.reason };
          row.version = upRes.row.version;
        }
        break;
      }

      if (createRes.reason === "NAME_TAKEN" || createRes.reason === "TICKER_TAKEN") {
        attempt++;
        continue;
      }

      logger.log(`virtualCorps: ensureCorporation failed for ${row.identity_key}: ${createRes.reason}`);
      const refuseRes = await refuse(ctx, row, createRes.reason);
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: createRes.reason, refused: true };
    }

    if (!corpId) {
      const refuseRes = await refuse(ctx, row, "NAME_TAKEN");
      if (!refuseRes.ok) return { ok: false, reason: refuseRes.reason };
      return { ok: false, reason: "NAME_TAKEN", refused: true };
    }

    const noWarRes = await adapter.markCorporationNoWar(corpId);
    if (!noWarRes.ok) {
      logger.log(`virtualCorps: markCorporationNoWar failed for ${corpId}: ${noWarRes.reason}`);
      return { ok: false, reason: noWarRes.reason };
    }

    const joinRes = await adapter.joinAlliance(corpId, ctxState.allianceId);
    if (!joinRes.ok) {
      logger.log(`virtualCorps: joinAlliance failed for corp ${corpId}: ${joinRes.reason}`);
      return { ok: false, reason: joinRes.reason };
    }

    ctxState.corpIds[parsed.slot] = corpId;
    return { ok: true, needsFlush: true };
  }

  if (row.state === IDENTITY_STATES.CREATED) {
    const corpId = row.evejs_id;
    const noWarRes = await adapter.markCorporationNoWar(corpId);
    if (!noWarRes.ok) {
      logger.log(`virtualCorps: markCorporationNoWar failed for corp ${corpId}: ${noWarRes.reason}`);
      return { ok: false, reason: noWarRes.reason };
    }
    const joinRes = await adapter.joinAlliance(corpId, ctxState.allianceId);
    if (!joinRes.ok) {
      logger.log(`virtualCorps: joinAlliance failed for corp ${corpId}: ${joinRes.reason}`);
      return { ok: false, reason: joinRes.reason };
    }
    const upRes = await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.LINKED, { evejsId: corpId });
    if (!upRes.ok) return { ok: false, reason: upRes.reason };
    return { ok: true, linked: true, needsFlush: true };
  }

  return { ok: true, deferred: true };
}

async function adoptExisting(ctx, strategyData) {
  const { adapter, repo, logger } = ctx;

  const scanRes = await adapter.scanVirtualCharacters();
  if (!scanRes.ok) {
    logger.log(`virtualCorps: scanVirtualCharacters failed: ${scanRes.reason}`);
    return { ok: false, adopted: 0 };
  }

  let adopted = 0;

  for (const char of scanRes.characters) {
    const rowRes = repo.getByKey(char.lneIdentityKey);
    if (rowRes.ok && rowRes.row) {
      const row = rowRes.row;
      if (!row.evejs_id) {
        await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.LINKED, { evejsId: char.characterId });
        adopted++;
      } else if (row.evejs_id !== char.characterId) {
        logger.log(`virtualCorps: adoption mismatch for ${row.identity_key}: db=${row.evejs_id} game=${char.characterId}`);
      }
    }
  }

  return { ok: true, adopted };
}

async function repairExisting(ctx) {
  const { adapter, repo, logger } = ctx;
  let repaired = 0;

  const states = [IDENTITY_STATES.CREATED, IDENTITY_STATES.LINKED, IDENTITY_STATES.RESERVED];
  for (const state of states) {
    const rows = repo.listByState(state);
    for (const row of rows) {
      if (!row.evejs_id) continue;

      const kind = row.kind === "alliance" ? "alliance" : row.kind === "corporation" ? "corporation" : "character";
      const existsRes = await adapter.virtualIdentityExists(kind, row.evejs_id, row.founding_op);
      if (!existsRes.ok) {
        logger.log(`virtualCorps: exists check failed for ${row.identity_key}: ${existsRes.reason}`);
        continue;
      }
      if (!existsRes.found) {
        logger.log(`virtualCorps: repairing missing ${kind} ${row.evejs_id} for ${row.identity_key}`);
        await updateStateWithCAS(ctx, row.identity_key, row.version, IDENTITY_STATES.PLANNED, { evejsId: null });
        repaired++;
      }
    }
  }

  const repairStates = [IDENTITY_STATES.CREATED, IDENTITY_STATES.LINKED];
  for (const state of repairStates) {
    const rows = repo.listByState(state);
    for (const row of rows) {
      if (row.kind !== "corporation") continue;
      if (!row.evejs_id) continue;
      if (row.owner_kind !== "faction") continue;

      const corpId = row.evejs_id;

      const corpAllianceRes = await adapter.checkCorporationAlliance(corpId);
      if (!corpAllianceRes.ok) {
        logger.log(`virtualCorps: checkCorporationAlliance failed for ${corpId} (${row.identity_key}): ${corpAllianceRes.reason}`);
        continue;
      }

      let allianceId = corpAllianceRes.allianceId;

      if (!corpAllianceRes.inAlliance) {
        const allianceRows = repo.listByOwner("faction", row.owner_id).filter(r => r.kind === "alliance" && r.evejs_id);
        if (allianceRows.length === 0) {
          logger.log(`virtualCorps: no alliance found for faction ${row.owner_id} to join corporation ${corpId}`);
          continue;
        }
        allianceId = allianceRows[0].evejs_id;
        const joinRes = await adapter.joinAlliance(corpId, allianceId);
        if (!joinRes.ok) {
          logger.log(`virtualCorps: joinAlliance failed for corp ${corpId} to alliance ${allianceId}: ${joinRes.reason}`);
          continue;
        }
        logger.log(`virtualCorps: repaired corporation ${corpId} (${row.identity_key}) - joined to alliance ${allianceId}`);
        repaired++;
      }

      if (allianceId) {
        const factionAllianceRows = repo.listByOwner("faction", row.owner_id).filter(r => r.kind === "alliance" && r.evejs_id);
        if (factionAllianceRows.length > 0 && factionAllianceRows[0].evejs_id !== allianceId) {
          logger.log(`virtualCorps: skipping foreign alliance ${allianceId} for corp ${corpId} (faction alliance is ${factionAllianceRows[0].evejs_id})`);
        } else {
          const npcRes = await adapter.checkAllianceIsNpc(allianceId);
          if (!npcRes.ok) {
            logger.log(`virtualCorps: checkAllianceIsNpc failed for alliance ${allianceId} (corp ${corpId}): ${npcRes.reason}`);
            continue;
          }
          if (!npcRes.isNpc) {
            const markRes = await adapter.markAllianceNpc(allianceId);
            if (!markRes.ok) {
              logger.log(`virtualCorps: markAllianceNpc failed for alliance ${allianceId}: ${markRes.reason}`);
              continue;
            }
            logger.log(`virtualCorps: repaired alliance ${allianceId} (corp ${corpId}) - marked as NPC`);
            repaired++;
          }
        }
      }
    }
  }

  const allFactionIds = new Set();
  const allStates = [IDENTITY_STATES.PLANNED, IDENTITY_STATES.RESERVED, IDENTITY_STATES.CREATED, IDENTITY_STATES.LINKED];
  for (const state of allStates) {
    const rows = repo.listByState(state);
    for (const r of rows) {
      if (r.owner_kind === "faction") allFactionIds.add(r.owner_id);
    }
  }

  const repairCorpStates = [IDENTITY_STATES.CREATED, IDENTITY_STATES.LINKED];
  for (const state of repairCorpStates) {
    const rows = repo.listByState(state);
    for (const row of rows) {
      if (row.kind !== "corporation") continue;
      if (!row.evejs_id) continue;

      const corpId = row.evejs_id;
      const noWarRes = await adapter.markCorporationNoWar(corpId);
      if (!noWarRes.ok) {
        logger.log(`virtualCorps: markCorporationNoWar failed for corp ${corpId} (${row.identity_key}): ${noWarRes.reason}`);
        continue;
      }
      if (noWarRes.changed === true) {
        logger.log(`virtualCorps: repaired corporation ${corpId} (${row.identity_key}) - set allowWar=0`);
        repaired++;
      }
    }
  }

  for (const factionId of allFactionIds) {
    const allianceRows = repo.listByOwner("faction", factionId).filter(r => r.kind === "alliance" && r.evejs_id);
    if (allianceRows.length === 0) continue;
    const factionAllianceId = allianceRows[0].evejs_id;

    const npcRes = await adapter.checkAllianceIsNpc(factionAllianceId);
    if (!npcRes.ok) {
      logger.log(`virtualCorps: checkAllianceIsNpc failed for faction ${factionId} alliance ${factionAllianceId}: ${npcRes.reason}`);
      continue;
    }
    if (!npcRes.isNpc) {
      const markRes = await adapter.markAllianceNpc(factionAllianceId);
      if (!markRes.ok) {
        logger.log(`virtualCorps: markAllianceNpc failed for faction ${factionId} alliance ${factionAllianceId}: ${markRes.reason}`);
        continue;
      }
      logger.log(`virtualCorps: repaired faction ${factionId} alliance ${factionAllianceId} - marked as NPC`);
      repaired++;
    }
  }

  return { ok: true, repaired };
}

async function runSagaForFaction(ctx, factionId, factionData, seedOpsPerSlice) {
  return runSagaForOwner(ctx, "faction", factionId, factionData, seedOpsPerSlice);
}

async function runSagaForOwner(ctx, ownerKind, factionId, factionData, seedOpsPerSlice) {
  const { repo, logger, config } = ctx;

  const rows = repo.listByOwner(ownerKind, factionId);

  const ctxState = {
    ceoId: null,
    corp0Id: null,
    allianceId: null,
    corpIds: [],
    charIds: [],
    freeSaga: ownerKind === OWNER_KINDS.FREE && ctx.freeSaga ? ctx.freeSaga : null,
    pendingMemberStates: [],
  };
  for (const row of rows) {
    if (!row.evejs_id) continue;
    if (row.kind === "character" && parseIdentityKey(row.identity_key)?.slot === 0 && parseIdentityKey(row.identity_key)?.n === 0) {
      if (row.state === IDENTITY_STATES.CREATED || row.state === IDENTITY_STATES.LINKED) {
        ctxState.ceoId = row.evejs_id;
      }
      ctxState.charIds.push(row.evejs_id);
    } else if (row.kind === "corporation" && parseIdentityKey(row.identity_key)?.slot === 0) {
      ctxState.corp0Id = row.evejs_id;
      ctxState.corpIds.push(row.evejs_id);
    } else if (row.kind === "alliance") {
      ctxState.allianceId = row.evejs_id;
    } else if (row.kind === "corporation") {
      ctxState.corpIds.push(row.evejs_id);
    } else if (row.kind === "character") {
      ctxState.charIds.push(row.evejs_id);
    }
  }

  const ceoRows = rows.filter(r => r.kind === "character" && parseIdentityKey(r.identity_key)?.slot === 0 && parseIdentityKey(r.identity_key)?.n === 0);
  const corp0Rows = rows.filter(r => r.kind === "corporation" && parseIdentityKey(r.identity_key)?.slot === 0);
  const allianceRows = rows.filter(r => r.kind === "alliance");
  const otherCharRows = rows.filter(r => r.kind === "character" && !(parseIdentityKey(r.identity_key)?.slot === 0 && parseIdentityKey(r.identity_key)?.n === 0));
  const corpNRows = rows.filter(r => r.kind === "corporation" && (parseIdentityKey(r.identity_key)?.slot || 0) > 0);

  let processed = 0;
  let deferred = 0;
  let refused = 0;
  let linked = 0;
  let stepFailed = 0;
  let opsSinceFlush = 0;

  const maxIterations = config?.virtualCorps?.sagaMaxIterations ?? 100;
  const noProgressThreshold = config?.virtualCorps?.sagaNoProgressIterations ?? 3;
  let iteration = 0;
  let consecutiveNoProgress = 0;

  try {
    while (iteration < maxIterations) {
      iteration++;

      const processedStart = processed;
      const linkedStart = linked;
      const refusedStart = refused;

      const currentRows = repo.listByOwner(ownerKind, factionId);

      ctxState.ceoId = null;
      ctxState.corp0Id = null;
      ctxState.allianceId = null;
      ctxState.corpIds = [];
      ctxState.charIds = [];
      for (const row of currentRows) {
        if (!row.evejs_id) continue;
        if (row.kind === "character" && parseIdentityKey(row.identity_key)?.slot === 0 && parseIdentityKey(row.identity_key)?.n === 0) {
          if (row.state === IDENTITY_STATES.CREATED || row.state === IDENTITY_STATES.LINKED) {
            ctxState.ceoId = row.evejs_id;
          }
          ctxState.charIds.push(row.evejs_id);
        } else if (row.kind === "corporation" && parseIdentityKey(row.identity_key)?.slot === 0) {
          ctxState.corp0Id = row.evejs_id;
          ctxState.corpIds.push(row.evejs_id);
        } else if (row.kind === "alliance") {
          ctxState.allianceId = row.evejs_id;
        } else if (row.kind === "corporation") {
          ctxState.corpIds.push(row.evejs_id);
        } else if (row.kind === "character") {
          ctxState.charIds.push(row.evejs_id);
        }
      }

      const hasNonTerminal = currentRows.some(r => !isTerminal(r.state));
      if (!hasNonTerminal) break;

      const ceoRowsCurr = currentRows.filter(r => r.kind === "character" && parseIdentityKey(r.identity_key)?.slot === 0 && parseIdentityKey(r.identity_key)?.n === 0);
      const corp0RowsCurr = currentRows.filter(r => r.kind === "corporation" && parseIdentityKey(r.identity_key)?.slot === 0);
      const allianceRowsCurr = currentRows.filter(r => r.kind === "alliance");
      const otherCharRowsCurr = currentRows.filter(r => r.kind === "character" && !(parseIdentityKey(r.identity_key)?.slot === 0 && parseIdentityKey(r.identity_key)?.n === 0));
      const corpNRowsCurr = currentRows.filter(r => r.kind === "corporation" && (parseIdentityKey(r.identity_key)?.slot || 0) > 0);

      const orderedRowsCurr = [
        ...ceoRowsCurr,
        ...corp0RowsCurr,
        ...allianceRowsCurr,
        ...otherCharRowsCurr,
        ...corpNRowsCurr,
      ];

      for (const row of orderedRowsCurr) {
        if (isTerminal(row.state)) continue;

        const res = await processStep(ctx, row, factionData, ctxState);

        if (res.deferred) {
          deferred++;
        } else if (res.refused) {
          refused++;
        } else if (res.linked) {
          linked++;
        }

        if (res.ok && !res.deferred) {
          processed++;
          opsSinceFlush++;
        } else if (!res.ok && !res.deferred) {
          stepFailed++;
        }

        if (opsSinceFlush >= seedOpsPerSlice) {
          await flushSlice(ctx, ctxState);
          opsSinceFlush = 0;
          if (typeof ctx.yieldSlice === "function") await ctx.yieldSlice();
          if (typeof ctx.isCurrent === "function" && !ctx.isCurrent()) {
            return { ok: false, reason: "STOPPED", processed, deferred, refused, linked, stepFailed };
          }
        }
      }

      if (opsSinceFlush > 0) {
        await flushSlice(ctx, ctxState);
        opsSinceFlush = 0;
      }

      const iterationProgress = (processed - processedStart) + (linked - linkedStart) + (refused - refusedStart);
      if (iterationProgress === 0) {
        consecutiveNoProgress++;
        if (consecutiveNoProgress >= noProgressThreshold) {
          logger.log(`virtualCorps: no progress for ${consecutiveNoProgress} iterations, faction ${factionId} may have permanent errors`);
          break;
        }
      } else {
        consecutiveNoProgress = 0;
      }
    }

    if (iteration >= maxIterations) {
      logger.log(`virtualCorps: max iterations reached for faction ${factionId}, some rows may be stuck`);
    }
  } finally {
    await drainMemberStates(ctx, ctxState);
  }

  return { ok: true, processed, deferred, refused, linked, stepFailed };
}

module.exports = {
  runSagaForFaction,
  runSagaForOwner,
  adoptExisting,
  repairExisting,
  processStep,
  generateNameVariant,
  updateStateWithCAS,
  drainMemberStates,
  FREE_SAGA_FLUSH_TABLES,
};