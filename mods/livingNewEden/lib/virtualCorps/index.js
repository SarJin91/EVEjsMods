"use strict";

const { performance } = require("node:perf_hooks");
const { fingerprint } = require("../util/fingerprint");
const { createStoreRepository } = require("./identityRepository");
const { IDENTITY_STATES, OWNER_KINDS, OWNER_PREFIXES, identityKeyForOwnerCorporation,
  identityKeyForOwnerCharacter, atOfClock, parseIdentityKey } = require("./schema");
const { planIdentities, buildOwnerPlan } = require("./identityPlan");
const { runSagaForFaction, runSagaForOwner, adoptExisting, repairExisting } = require("./identitySaga");
const { createRenamePass, RENAME_STATE } = require("./rename");
const { createVirtualIdentitiesAdapter } = require("../adapter/virtualIdentities");
const { buildPilotCandidates, buildCivilianCandidates } = require("./pilotCandidates");
const strategyData = require("../strategy/data/virtualCorps");

let repo = null;
let readyResolve = null;
let isRunning = false;
let enabled = false;
let fleetCorporations = true;
let readyPromise = null;

let corpMap = null;
let nameMap = null;
let mapVersion = 0;
let factionMap = null;
let linkedRows = null;
let store = null;
let issuerMap = null;
let ownerMap = null;
let pilotCandidates = null;
let civilianCandidates = null;
let pilotVersion = 0;
let pilotPrint = null;
let civilianVersion = 0;
let civilianPrint = null;
let ownerCharacterCounts = null;
let telemetryRef = null;
let freeSagaOptions = null;
let sagaContext = null;
let sagaOpsPerSlice = 4;
let ownerChain = Promise.resolve();
const ownerQueued = new Set();
let generation = 0;
let renamePass = null;

const CORP_SLOT_KEY = /^f:(\d+):corp:(\d+)$/;
const SLOT_HEAD_KEY = /^f:(\d+):corp:(\d+):char:0$/;

function buildIssuerMap(linked) {
  const corps = new Map();
  const heads = new Map();
  for (const row of linked) {
    if (row.owner_kind !== "faction" || !row.evejs_id) continue;
    const key = String(row.identity_key || "");
    const corp = row.kind === "corporation" ? CORP_SLOT_KEY.exec(key) : null;
    if (corp) corps.set(`${corp[1]}:${corp[2]}`, row.evejs_id);
    const head = row.kind === "character" ? SLOT_HEAD_KEY.exec(key) : null;
    if (head) heads.set(`${head[1]}:${head[2]}`, row.evejs_id);
  }
  const map = new Map();
  for (const [slotKey, corporationId] of corps) {
    const characterId = heads.get(slotKey);
    if (!characterId) continue;
    const [factionId, slot] = slotKey.split(":").map(Number);
    if (!map.has(factionId)) map.set(factionId, []);
    map.get(factionId).push(Object.freeze({ factionId, slot, corporationId, characterId }));
  }
  for (const [factionId, list] of map) map.set(factionId, Object.freeze(list.sort((a, b) => a.slot - b.slot)));
  return map;
}

function rebuildMaps() {
  if (!repo) return;
  if (store && typeof store.isInTransaction === "function" && store.isInTransaction()) return;
  const linkedRes = repo.readByState(IDENTITY_STATES.LINKED);
  if (!linkedRes.ok) return;
  const allRows = linkedRes.rows;
  const newCorpMap = new Map();
  const newNameMap = new Map();
  const newFactionMap = new Map();
  const factionEntry = (factionId) => {
    if (!newFactionMap.has(factionId)) {
      newFactionMap.set(factionId, { allianceId: 0, corporationIds: [], characterIds: [], refused: false });
    }
    return newFactionMap.get(factionId);
  };
  for (const row of allRows) {
    if (row.owner_kind === "faction" && row.evejs_id) {
      const entry = factionEntry(row.owner_id);
      if (row.kind === "alliance" && !entry.allianceId) entry.allianceId = row.evejs_id;
      else if (row.kind === "corporation") entry.corporationIds.push(row.evejs_id);
      else if (row.kind === "character") entry.characterIds.push(row.evejs_id);
    }
  }
  const refusedRes = repo.readByState(IDENTITY_STATES.REFUSED);
  if (!refusedRes.ok) return;
  for (const row of refusedRes.rows) {
    if (row.owner_kind === "faction") factionEntry(row.owner_id).refused = true;
  }
  const newOwnerMap = new Map();
  const byKind = emptyOwnerCounts();
  let ownerCharTotal = 0;
  const ownerEntry = (row) => {
    const k = `${row.owner_kind}:${row.owner_id}`;
    if (!newOwnerMap.has(k)) {
      newOwnerMap.set(k, { corp: null, ceo: null, members: [], refused: false, reason: null, refusedMembers: 0 });
    }
    return newOwnerMap.get(k);
  };
  for (const row of allRows) {
    if (row.owner_kind === "faction" || !row.evejs_id || !OWNER_PREFIXES[row.owner_kind]) continue;
    const prefix = OWNER_PREFIXES[row.owner_kind];
    const e = ownerEntry(row);
    if (row.identity_key === identityKeyForOwnerCorporation(prefix, row.owner_id, 0)) {
      e.corp = row;
      if (row.name) newNameMap.set(row.evejs_id, row.name);
    } else if (row.kind === "character") {
      if (row.identity_key === identityKeyForOwnerCharacter(prefix, row.owner_id, 0, 0)) e.ceo = row;
      e.members.push(row);
      ownerCharTotal += 1;
      if (Object.prototype.hasOwnProperty.call(byKind, row.owner_kind)) byKind[row.owner_kind] += 1;
    }
  }
  for (const row of refusedRes.rows) {
    if (row.owner_kind === "faction" || !OWNER_PREFIXES[row.owner_kind]) continue;
    const prefix = OWNER_PREFIXES[row.owner_kind];
    if (row.identity_key === identityKeyForOwnerCorporation(prefix, row.owner_id, 0)
      || row.identity_key === identityKeyForOwnerCharacter(prefix, row.owner_id, 0, 0)) {
      const e = ownerEntry(row);
      e.refused = true;
      e.reason = e.reason || row.reason || "REFUSED";
    } else if (row.kind === "character") {
      ownerEntry(row).refusedMembers += 1;
    }
  }
  for (const row of allRows) {
    if (row.kind === "corporation" && row.evejs_id && row.owner_kind === "faction") {
      const factionId = row.owner_id;
      if (!newCorpMap.has(factionId)) newCorpMap.set(factionId, []);
      newCorpMap.get(factionId).push(row.evejs_id);
      if (row.name) newNameMap.set(row.evejs_id, row.name);
    } else if (row.kind === "alliance" && row.evejs_id && row.owner_kind === "faction") {
      if (row.name) newNameMap.set(row.evejs_id, row.name);
    }
  }
  for (const [factionId, ids] of newCorpMap.entries()) {
    ids.sort((a, b) => a - b);
  }
  corpMap = newCorpMap;
  nameMap = newNameMap;
  factionMap = newFactionMap;
  linkedRows = allRows;
  issuerMap = buildIssuerMap(allRows);
  ownerMap = newOwnerMap;
  pilotCandidates = buildPilotCandidates(allRows);
  civilianCandidates = buildCivilianCandidates(allRows);
  const pp = fingerprint(pilotCandidates);
  if (pp !== pilotPrint) {
    pilotPrint = pp;
    pilotVersion += 1;
  }
  const cp = fingerprint(civilianCandidates);
  if (cp !== civilianPrint) {
    civilianPrint = cp;
    civilianVersion += 1;
  }
  ownerCharacterCounts = Object.freeze({ total: ownerCharTotal, byKind: Object.freeze(byKind) });
  mapVersion++;
}

function emptyOwnerCounts() {
  const out = {};
  for (const kind of Object.values(OWNER_KINDS)) if (kind !== OWNER_KINDS.FACTION) out[kind] = 0;
  return out;
}

function getMapVersion() {
  return mapVersion;
}

function getCorporationIds(factionId) {
  return corpMap?.get(factionId) || [];
}

function getName(evejsId) {
  return nameMap?.get(evejsId) || null;
}

function startVirtualCorps(ctx) {
  try {
    const { config, adapter, persistence, logger, telemetry, clock, strategy } = ctx;

    if (!config.modules || !config.modules.virtualCorps || config.modules.virtualCorps.enabled !== true) {
      return stubFacade("disabled_by_config", "DISABLED");
    }

    let processRole = "unknown";
    if (adapter && typeof adapter.getProcessRole === "function") {
      processRole = adapter.getProcessRole();
    } else if (process && process.env && process.env.EVEJS_GAMESTORE_OWNER_ROLE) {
      processRole = process.env.EVEJS_GAMESTORE_OWNER_ROLE;
    }
    if (processRole !== "world") {
      return stubFacade("not_world_process", "NOT_WORLD_PROCESS");
    }

    const persistenceStore = persistence && persistence.store;
    if (!persistenceStore || typeof persistenceStore.transaction !== "function") {
      return stubFacade("NO_PERSISTENCE_STORE", "NO_PERSISTENCE_STORE");
    }

    if (!clock || typeof clock.now !== "function") {
      return stubFacade("NO_CLOCK", "NO_CLOCK");
    }

    store = persistenceStore;
    repo = createStoreRepository(persistenceStore, { telemetry, logger });
    telemetryRef = telemetry || null;

    const vc = config.virtualCorps || {};
    const corpsPerFaction = vc.corpsPerFaction || 2;
    const membersPerCorp = vc.membersPerCorp || 3;
    const maxCharacters = vc.maxCharacters || 64;
    const seedOpsPerSlice = vc.seedOpsPerSlice || 4;

    enabled = true;
    fleetCorporations = vc.fleetCorporations !== false;

    const sagaAdapter = createSagaAdapter(adapter);

    const fsCfg = vc.freeSaga || {};
    let freeLean = fsCfg.lean === true;
    if (freeLean) {
      let seams = null;
      try {
        seams = adapter && typeof adapter.freeSagaLeanSeams === "function" ? adapter.freeSagaLeanSeams() : null;
      } catch (err) {
        seams = { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((err && err.message) || err).slice(0, 120) };
      }
      if (!seams || seams.ok !== true) {
        freeLean = false;
        if (logger && typeof logger.log === "function") logger.log(`virtualCorps: freeSaga.lean off - ${(seams && seams.reason) || "SEAM_UNAVAILABLE"}`
          + `${seams && seams.detail ? ` (${seams.detail})` : ""}`);
      }
    }
    freeSagaOptions = Object.freeze({ lean: freeLean, membersStartInCorp: fsCfg.membersStartInCorp === true });

    const sagaCtx = {
      adapter: sagaAdapter,
      repo,
      logger,
      config,
      fail: ctx.fail,
      clock,
      yieldSlice: () => new Promise((resolve) => { setImmediate(resolve); }),
      isCurrent: () => false,
      names: namesOptionsOf(config, persistence, telemetry),
    };
    generation += 1;
    const startGeneration = generation;
    sagaCtx.isCurrent = () => startGeneration === generation;
    sagaContext = sagaCtx;
    sagaOpsPerSlice = seedOpsPerSlice;
    ownerChain = Promise.resolve();
    ownerQueued.clear();

    const tel = telemetry || null;
    const seedStartMs = clock.now();

    readyPromise = new Promise((resolve) => { readyResolve = resolve; });

    (async () => {
      try {
        const repairRes = await repairExisting(sagaCtx);
        if (repairRes.ok && repairRes.repaired > 0) {
          if (tel) tel.count("virtualCorps.repaired", repairRes.repaired);
          logger.log(`virtualCorps: repaired ${repairRes.repaired} existing identities`);
        }

        const adoptRes = await adoptExisting(sagaCtx, strategyData);
        if (adoptRes.ok && adoptRes.adopted > 0) {
          if (tel) tel.count("virtualCorps.adopted", adoptRes.adopted);
          logger.log(`virtualCorps: adopted ${adoptRes.adopted} existing entities`);
        }
        rebuildMaps();

        const planResult = planIdentities(strategy?.registry || { isActive: () => true }, strategyData, {
          corpsPerFaction,
          membersPerCorp,
          maxCharacters,
        });

        if (planResult.refused > 0) {
          if (tel) tel.count("virtualCorps.refused", planResult.refused);
          logger.log(`virtualCorps: plan refused ${planResult.refused} entries (LIMIT)`);
        }

        const plan = { inserted: 0, existing: 0, conflicts: 0, failed: 0, firstConflict: null, firstFailure: null };
        const failedOn = (key, reason) => {
          plan.failed++;
          if (plan.firstFailure === null) plan.firstFailure = `${key}: ${String(reason || "UNKNOWN")}`;
        };
        for (const entry of planResult.entries) {
          const seen = repo.getByKey(entry.key);
          if (seen.ok) { plan.existing++; continue; }
          if (seen.reason !== "NOT_FOUND") {
            failedOn(entry.key, seen.reason);
            continue;
          }
          const res = repo.insert({
            key: entry.key,
            foundingOp: entry.foundingOp,
            kind: entry.kind,
            ownerKind: entry.ownerKind,
            ownerId: entry.ownerId,
            name: entry.name,
            ticker: entry.ticker,
            state: entry.state,
            at: clock.now(),
          });
          if (res.ok) plan.inserted++;
          else if (res.reason === "DUPLICATE_KEY") {
            plan.conflicts++;
            if (plan.firstConflict === null) plan.firstConflict = entry.key;
          } else failedOn(entry.key, res.reason);
        }
        if (tel) {
          if (plan.existing > 0) tel.count("virtualCorps.planExisting", plan.existing);
          if (plan.inserted > 0) tel.count("virtualCorps.planInserted", plan.inserted);
          if (plan.conflicts > 0) tel.count("virtualCorps.planConflicts", plan.conflicts);
          if (plan.failed > 0) tel.count("virtualCorps.planFailed", plan.failed);
        }
        if (plan.inserted + plan.conflicts + plan.failed > 0) {
          logger.log(`virtualCorps: plan inserted=${plan.inserted} existing=${plan.existing} `
            + `conflicts=${plan.conflicts} failed=${plan.failed}`
            + (plan.firstConflict !== null ? ` (first conflict ${plan.firstConflict})` : "")
            + (plan.firstFailure !== null ? ` (first failure ${plan.firstFailure})` : ""));
        }

        const allFactions = strategyData.getFactions ? strategyData.getFactions() : [];
        const qualifyingFactions = allFactions.filter(f => {
          if (strategy?.registry?.isActive && !strategy.registry.isActive(f.id)) return false;
          return true;
        });

        let totalProcessed = 0;
        let totalDeferred = 0;
        let totalRefused = 0;
        let totalLinked = 0;
        let totalStepFailed = 0;
        let totalCreatedChars = 0;
        let totalCreatedCorps = 0;
        let totalCreatedAlliances = 0;

        for (const faction of qualifyingFactions.sort((a, b) => a.id - b.id)) {
          if (!sagaCtx.isCurrent()) return;
          const factionData = strategyData.getById ? strategyData.getById(faction.id) : faction;
          if (!factionData) continue;

          const res = await runSagaForFaction(sagaCtx, faction.id, factionData, seedOpsPerSlice);
          if (res.ok) {
            totalProcessed += res.processed;
            totalDeferred += res.deferred;
            totalRefused += res.refused;
            totalLinked += res.linked;
            totalStepFailed += res.stepFailed || 0;

            const factionRows = repo.listByOwner("faction", faction.id);
            for (const row of factionRows) {
              if (row.state === IDENTITY_STATES.LINKED && row.evejs_id) {
                if (row.kind === "character") totalCreatedChars++;
                else if (row.kind === "corporation") totalCreatedCorps++;
                else if (row.kind === "alliance") totalCreatedAlliances++;
              }
            }
          }
          if (!sagaCtx.isCurrent()) return;
          rebuildMaps();
        }

        if (tel) {
          tel.count("virtualCorps.createdCharacters", totalCreatedChars);
          tel.count("virtualCorps.createdCorporations", totalCreatedCorps);
          tel.count("virtualCorps.createdAlliances", totalCreatedAlliances);
          tel.count("virtualCorps.refused", totalRefused);
          tel.count("virtualCorps.stepFailed", totalStepFailed);
          tel.gauge("virtualCorps.linked", totalLinked);
          const seedEndMs = clock.now();
          tel.observe("virtualCorps.seedMs", seedEndMs - seedStartMs, seedEndMs);
        }

        logger.log(
          `virtualCorps: seed complete chars=${totalCreatedChars} corps=${totalCreatedCorps} alliances=${totalCreatedAlliances} ` +
          `linked=${totalLinked} deferred=${totalDeferred} refused=${totalRefused} failed=${totalStepFailed} repaired=${repairRes.repaired || 0}`
        );

        isRunning = true;
        if (readyResolve) readyResolve();
        if (sagaCtx.isCurrent()) startRenamePass(config, adapter, persistence, persistenceStore, clock, telemetry, logger);

      } catch (err) {
        logger.log(`virtualCorps: boot failed - ${err.message}`);
        if (readyResolve) readyResolve();
      }
    })();

    return {
      ok: true,
      whenReady,
      getFactionIdentity,
      isVirtualAlliance,
      isVirtualCorporation,
      listIdentities,
      corporationForRole,
      listTradeIssuers,
      listPilotCandidates,
      listCivilianCandidates,
      nameOf,
      getMapVersion,
      ensureOwnerIdentity,
      getOwnerIdentity,
      countOwnerCharacters,
      getStatus,
      stop: () => { if (startGeneration === generation) stopVirtualCorps(); },
    };

  } catch (err) {
    return stubFacade(`startVirtualCorps: ${err.message}`, "START_FAILED");
  }
}

function stopVirtualCorps(ctx) {
  isRunning = false;
  enabled = false;
  fleetCorporations = true;
  repo = null;
  store = null;
  readyPromise = null;
  readyResolve = null;
  corpMap = null;
  nameMap = null;
  factionMap = null;
  linkedRows = null;
  issuerMap = null;
  ownerMap = null;
  pilotCandidates = null;
  civilianCandidates = null;
  pilotPrint = null;
  civilianPrint = null;
  ownerCharacterCounts = null;
  telemetryRef = null;
  freeSagaOptions = null;
  mapVersion = 0;
  generation += 1;
  sagaContext = null;
  ownerQueued.clear();
  if (renamePass) renamePass.stop();
  renamePass = null;
}

function ensureOwnerIdentity(spec) {
  try {
    if (!enabled) return { ok: false, reason: "DISABLED" };
    if (!repo || !sagaContext) return { ok: false, reason: "NOT_STARTED" };
    const planned = buildOwnerPlan(spec);
    if (!planned.ok) return planned;
    const s = spec;
    const isId = (v) => Number.isSafeInteger(v) && v > 0;
    for (const k of ["stationId", "systemId", "constellationId", "regionId"]) {
      if (!isId(s[k])) return { ok: false, reason: "INVALID_SPEC", detail: k };
    }
    if (s.stationCorporationId !== null && !isId(s.stationCorporationId)) {
      return { ok: false, reason: "INVALID_SPEC", detail: "stationCorporationId" };
    }
    if (!Array.isArray(s.bloodlineIds) || s.bloodlineIds.length === 0 || !s.bloodlineIds.every(isId)) {
      return { ok: false, reason: "INVALID_SPEC", detail: "bloodlineIds" };
    }
    if (typeof s.securityRating !== "number" || !Number.isFinite(s.securityRating)) {
      return { ok: false, reason: "INVALID_SPEC", detail: "securityRating" };
    }
    const adoption = s.ceoCharacterId === undefined ? null : adoptCeo(s, planned.entries);
    if (adoption && !adoption.ok) return adoption;
    for (const entry of planned.entries) {
      const seen = repo.getByKey(entry.key);
      if (seen.ok) continue;
      if (seen.reason !== "NOT_FOUND") return { ok: false, reason: seen.reason };
      const res = repo.insert({ key: entry.key, foundingOp: entry.foundingOp, kind: entry.kind,
        ownerKind: entry.ownerKind, ownerId: entry.ownerId, name: entry.name, ticker: entry.ticker,
        state: entry.state, at: atOfClock(sagaContext.clock) });
      if (!res.ok && res.reason !== "DUPLICATE_KEY") return { ok: false, reason: res.reason };
    }
    const queueKey = `${s.ownerKind}:${s.ownerId}`;
    const adopted = adoption ? { ceoAdopted: adoption.adopted, ...(adoption.duplicate ? { ceoAdoptDuplicate: true }
      : {}) } : {};
    if (ownerQueued.has(queueKey)) return { ok: true, queued: false, ...adopted };
    const corp = s.corporation;
    const ownerData = Object.freeze({ name: corp.name,
      description: typeof corp.description === "string" && corp.description !== "" ? corp.description : corp.name,
      corporations: Object.freeze([Object.freeze({ name: corp.name, ticker: corp.ticker })]),
      ownerCorporationId: s.stationCorporationId, stationId: s.stationId, systemId: s.systemId,
      constellationId: s.constellationId, regionId: s.regionId, bloodlineIds: Object.freeze(s.bloodlineIds.slice()),
      securityRating: s.securityRating });
    const gen = generation;
    const ctx = sagaContext;
    const ops = sagaOpsPerSlice;
    const tel = s.ownerKind === OWNER_KINDS.FREE && telemetryRef && typeof telemetryRef.observe === "function"
      ? telemetryRef : null;
    let sliceStart = 0;
    const observeSlice = () => {
      try {
        tel.observe("virtualCorps.freeSagaSliceMs", performance.now() - sliceStart, atOfClock(ctx.clock));
      } catch (_err) {
      }
    };
    const sliceCtx = tel === null ? ctx : { ...ctx, yieldSlice: async () => {
      observeSlice();
      if (typeof ctx.yieldSlice === "function") await ctx.yieldSlice();
      sliceStart = performance.now();
    } };
    const fso = freeSagaOptions || { lean: false, membersStartInCorp: false };
    const runCtx = s.ownerKind !== OWNER_KINDS.FREE ? sliceCtx : { ...sliceCtx, freeSaga: Object.freeze({
      lean: fso.lean === true, membersStartInCorp: fso.membersStartInCorp === true,
      tel: telemetryRef && typeof telemetryRef.count === "function" ? telemetryRef : null }) };
    ownerQueued.add(queueKey);
    ownerChain = ownerChain.then(() => whenReady()).then(async () => {
      if (gen !== generation) return;
      try {
        sliceStart = performance.now();
        await runSagaForOwner(runCtx, s.ownerKind, s.ownerId, ownerData, ops);
        if (tel !== null) observeSlice();
      } finally {
        if (gen === generation) {
          ownerQueued.delete(queueKey);
          rebuildMaps();
        }
      }
    }).catch((err) => {
      try {
        if (ctx && ctx.logger && typeof ctx.logger.log === "function") {
          ctx.logger.log(`virtualCorps: owner saga ${queueKey} failed - ${(err && err.message) || err}`);
        }
      } catch (_err) {
      }
    });
    return { ok: true, queued: true, ...adopted };
  } catch (err) {
    return { ok: false, reason: `ENSURE_FAILED: ${String((err && err.message) || err).slice(0, 120)}` };
  }
}

function adoptCeo(s, entries) {
  if (!Number.isSafeInteger(s.ceoCharacterId) || s.ceoCharacterId <= 0) {
    return { ok: false, reason: "INVALID_SPEC", detail: "ceoCharacterId" };
  }
  const headKey = identityKeyForOwnerCharacter(OWNER_PREFIXES[s.ownerKind], s.ownerId, 0, 0);
  const head = entries.find((e) => e.key === headKey);
  if (!head) return { ok: false, reason: "INVALID_SPEC", detail: "ceoCharacterId" };
  const seen = repo.getByKey(head.key);
  if (seen.ok) return { ok: true, adopted: Number(seen.row.evejs_id) === s.ceoCharacterId, duplicate: true };
  if (seen.reason !== "NOT_FOUND") return { ok: false, reason: seen.reason };
  const adapter = sagaContext.adapter;
  let peek = null;
  try {
    peek = adapter && typeof adapter.peekCharacterRecord === "function" ? adapter.peekCharacterRecord(s.ceoCharacterId)
      : null;
  } catch (err) {
    return { ok: false, reason: "CEO_PEEK_FAILED", detail: String((err && err.message) || err).slice(0, 120) };
  }
  if (!peek || peek.ok !== true) {
    return { ok: false, reason: "CEO_PEEK_FAILED", detail: String((peek && peek.reason) || "PEEK_UNAVAILABLE") };
  }
  if (!peek.record) return { ok: true, adopted: false };
  const r = repo.adoptCharacter({ entry: head, characterId: s.ceoCharacterId, at: atOfClock(sagaContext.clock) });
  if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ADOPT_FAILED" };
  return { ok: true, adopted: r.adopted === true, duplicate: r.duplicate === true };
}

function getOwnerIdentity(ownerKind, ownerId) {
  if (!enabled) return { ok: false, reason: "DISABLED" };
  if (!repo) return { ok: false, reason: "NOT_STARTED" };
  if (ownerKind === OWNER_KINDS.FACTION || !OWNER_PREFIXES[ownerKind]) return { ok: false, reason: "INVALID_OWNER" };
  const e = ownerMap ? ownerMap.get(`${ownerKind}:${ownerId}`) : null;
  if (!e) return { ok: true, state: "PENDING" };
  if (e.corp && e.ceo) {
    const sorted = e.members.slice().sort((a, b) => (a.identity_key < b.identity_key ? -1 : 1));
    const characterIds = sorted.map((r) => r.evejs_id);
    const memberNames = sorted.map((r) => (typeof r.name === "string" && r.name ? r.name : null));
    const memberIndexes = sorted.map((r) => {
      const k = parseIdentityKey(r.identity_key);
      return k && k.type === "character" ? k.n : null;
    });
    return { ok: true, state: "LINKED", corporationId: e.corp.evejs_id, ceoCharacterId: e.ceo.evejs_id,
      characterIds, memberNames, memberIndexes, name: e.corp.name, ticker: e.corp.ticker,
      refusedMemberCount: e.refusedMembers };
  }
  if (e.refused) return { ok: true, state: "REFUSED", reason: String(e.reason || "REFUSED") };
  return { ok: true, state: "PENDING" };
}

function stubFacade(reason, methodReason, detail, ready) {
  const out = {
    ok: false,
    reason,
    whenReady: typeof ready === "function" ? ready : () => Promise.resolve(),
    getFactionIdentity: () => ({ ok: false, reason: methodReason }),
    isVirtualAlliance: () => false,
    isVirtualCorporation: () => false,
    listIdentities: () => [],
    corporationForRole: () => null,
    listTradeIssuers: () => ({ ok: false, reason: methodReason }),
    listPilotCandidates: () => ({ ok: false, reason: methodReason }),
    listCivilianCandidates: () => ({ ok: false, reason: methodReason }),
    nameOf: () => null,
    getMapVersion: () => 0,
    ensureOwnerIdentity: () => ({ ok: false, reason: methodReason }),
    getOwnerIdentity: () => ({ ok: false, reason: methodReason }),
    countOwnerCharacters: () => ({ ok: false, reason: methodReason }),
    getStatus: () => ({ rename: { state: RENAME_STATE.IDLE, enabled: false } }),
    stop: () => {},
  };
  if (detail !== undefined) out.detail = detail;
  return out;
}

function namesOptionsOf(config, persistence, telemetry) {
  const n = (config && config.names) || {};
  return Object.freeze({
    characterNamesEnabled: n.enabled === true && n.characterNamesEnabled === true,
    worldSeed: persistence ? persistence.worldSeed : undefined,
    maxAttempts: n.maxAttempts,
    tel: telemetry && typeof telemetry.count === "function" ? telemetry : null,
  });
}

function startRenamePass(config, adapter, persistence, persistenceStore, clock, telemetry, logger) {
  if (renamePass) renamePass.stop();
  renamePass = null;
  const n = (config && config.names) || {};
  if (n.enabled !== true || n.renameSuffixedEnabled !== true) return;
  const pass = createRenamePass({ adapter, store: persistenceStore, clock, nowMs: () => performance.now(),
    worldSeed: persistence ? persistence.worldSeed : undefined, telemetry, logger,
    settings: { enabled: true, batchPerPass: n.renameBatchPerPass, passMs: n.renamePassMs,
      maxAttempts: n.maxAttempts },
    onRowsChanged: () => rebuildMaps() });
  const started = pass.start();
  if (!started.ok) {
    if (logger && typeof logger.log === "function") logger.log(`virtualCorps: rename pass not started - ${started.reason}`);
    return;
  }
  renamePass = pass;
}

function getStatus() {
  return { rename: renamePass ? { enabled: true, ...renamePass.getStatus() }
    : { state: RENAME_STATE.IDLE, enabled: false } };
}

function createSagaAdapter(adapter) {
  return {
    reserveCharacterId: () => adapter.reserveCharacterId(),
    writeCharacter: (record) => adapter.writeCharacter(record),
    pickCharacterName: (raceId) => adapter.pickCharacterName(raceId),
    ensureCorporation: (ceoId, spec) => adapter.ensureCorporation(ceoId, spec),
    ensureAlliance: (creatorId, execCorpId, spec) => adapter.ensureAlliance(creatorId, execCorpId, spec),
    markAllianceNpc: (allianceId) => adapter.markAllianceNpc(allianceId),
    markCorporationNoWar: (corporationId) => adapter.markCorporationNoWar(corporationId),
    joinCorporation: (characterId, corporationId, allianceId, options) => (options === undefined
      ? adapter.joinCorporation(characterId, corporationId, allianceId)
      : adapter.joinCorporation(characterId, corporationId, allianceId, options)),
    virtualIdentityEnsureMemberStates: (entries) => (typeof adapter.virtualIdentityEnsureMemberStates === "function"
      ? adapter.virtualIdentityEnsureMemberStates(entries) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    joinAlliance: (corporationId, allianceId) => adapter.joinAlliance(corporationId, allianceId),
    virtualIdentityExists: (kind, evejsId, foundingOp) => adapter.virtualIdentityExists(kind, evejsId, foundingOp),
    scanVirtualCharacters: () => adapter.scanVirtualCharacters(),
    virtualIdentityFlush: (tables) => adapter.virtualIdentityFlush(tables),
    resolveCharacterCreationBloodlineProfile: (bloodlineId) => adapter.resolveCharacterCreationBloodlineProfile(bloodlineId),
    checkCorporationAlliance: (corporationId) => adapter.checkCorporationAlliance(corporationId),
    checkAllianceIsNpc: (allianceId) => adapter.checkAllianceIsNpc(allianceId),
    peekCharacterRecord: (characterId) => (typeof adapter.peekCharacterRecord === "function"
      ? adapter.peekCharacterRecord(characterId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    characterNameKeys: () => (typeof adapter.characterNameKeys === "function"
      ? adapter.characterNameKeys() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    noteCharacterNameTaken: (name) => (typeof adapter.noteCharacterNameTaken === "function"
      ? adapter.noteCharacterNameTaken(name) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
    validateCharacterName: (name) => (typeof adapter.validateCharacterName === "function"
      ? adapter.validateCharacterName(name) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
  };
}

function whenReady() {
  return readyPromise || Promise.resolve();
}

function getFactionIdentity(factionId) {
  if (!repo) return { ok: false, reason: "NOT_STARTED" };

  const entry = factionMap ? factionMap.get(factionId) : null;
  if (!entry) return { ok: true, allianceId: 0, corporationIds: [], characterIds: [] };
  const linkedCount = (entry.allianceId ? 1 : 0) + entry.corporationIds.length + entry.characterIds.length;
  if (entry.refused && linkedCount === 0) {
    return { ok: false, reason: "REFUSED" };
  }

  return {
    ok: true,
    allianceId: entry.allianceId || 0,
    corporationIds: entry.corporationIds.slice(),
    characterIds: entry.characterIds.slice(),
  };
}

function corporationForRole(factionId, role) {
  if (!enabled || !fleetCorporations) return null;
  if (role === "station") return null;

  const corporationIds = getCorporationIds(factionId);
  if (corporationIds.length === 0) return null;

  const identity = getFactionIdentity(factionId);
  if (!identity.ok) return null;

  const hasLinked = (identity.allianceId && identity.allianceId > 0) ||
    corporationIds.some(id => id > 0) ||
    (identity.characterIds && identity.characterIds.some(id => id > 0));
  if (!hasLinked) return null;

  const roleSlots = strategyData.roleSlots || { default: 0 };
  const slot = Math.min(roleSlots[role] ?? roleSlots.default, corporationIds.length - 1);
  return corporationIds[slot] || null;
}

function listTradeIssuers(factionId) {
  if (!repo) return { ok: false, reason: "NOT_STARTED" };
  const map = issuerMap || new Map();
  let issuers;
  if (factionId === undefined || factionId === null) {
    issuers = [...map.keys()].sort((a, b) => a - b).flatMap((f) => map.get(f));
  } else {
    issuers = map.get(factionId) || [];
  }
  return { ok: true, ready: isRunning === true, issuers: Object.freeze(issuers.slice()) };
}

function listPilotCandidates() {
  if (pilotCandidates === null) return { ok: true, version: 0, candidates: Object.freeze([]) };
  return { ok: true, version: pilotVersion, candidates: pilotCandidates };
}

function listCivilianCandidates() {
  if (civilianCandidates === null) return { ok: true, version: 0, characterIds: Object.freeze([]) };
  return { ok: true, version: civilianVersion, characterIds: civilianCandidates };
}

const EMPTY_OWNER_COUNTS = Object.freeze({ ok: true, ready: false, total: 0,
  byKind: Object.freeze(emptyOwnerCounts()) });

function countOwnerCharacters() {
  if (!enabled) return { ok: false, reason: "DISABLED" };
  if (ownerCharacterCounts === null) return EMPTY_OWNER_COUNTS;
  return { ok: true, ready: isRunning === true, total: ownerCharacterCounts.total,
    byKind: ownerCharacterCounts.byKind };
}

function nameOf(corporationOrAllianceId) {
  if (!corporationOrAllianceId) return null;
  return getName(corporationOrAllianceId);
}

function isVirtualAlliance(allianceId) {
  if (!allianceId) return false;
  return nameMap?.has(allianceId) === true;
}

function isVirtualCorporation(corporationId) {
  if (!corporationId) return false;
  return nameMap?.has(corporationId) === true;
}

function listIdentities() {
  if (!repo) return [];
  return linkedRows ? linkedRows.slice() : [];
}

function createUnavailableVirtualCorps(reason, detail) {
  const out = stubFacade(reason, reason, detail, whenReady);
  if (detail === undefined) out.detail = detail;
  return out;
}

function setRepoForTest(testRepo) {
  repo = testRepo;
  store = null;
  enabled = true;
  fleetCorporations = true;
  rebuildMaps();
}

module.exports = {
  startVirtualCorps,
  stopVirtualCorps,
  whenReady,
  getFactionIdentity,
  isVirtualAlliance,
  isVirtualCorporation,
  listIdentities,
  createUnavailableVirtualCorps,
  corporationForRole,
  listTradeIssuers,
  listPilotCandidates,
  listCivilianCandidates,
  nameOf,
  getMapVersion,
  ensureOwnerIdentity,
  getOwnerIdentity,
  countOwnerCharacters,
  rebuildMaps,
  setRepoForTest,
};