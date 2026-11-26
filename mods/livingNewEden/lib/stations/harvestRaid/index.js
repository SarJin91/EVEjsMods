"use strict";

const { isModuleEnabled } = require("../../../config");
const { GROUPS: STRENGTH_GROUPS } = require("../../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../battle/strength");
const { capitalPowerOverlayOf } = require("../../battle/data/capitalStrengthRows");
const { createHostility } = require("../../battle/data/hostility");
const { createOwnerOnline } = require("../../world/playerSov/ownerOnline");
const { createHarvestRaidRepository } = require("./repository");
const { createHarvestRaidService } = require("./service");
const S = require("./schema");

const SCHEDULER_READY = "ready";
const UNAVAILABLE = "HARVEST_RAID_UNAVAILABLE";
const START_FAILED = "HARVEST_RAID_START_FAILED";
const COUNT_KEYS = Object.freeze(["warningMs", "raidMs", "sampleMs", "wallDeadlineMs", "settleWallMs", "lossPermille",
  "maxLossVolumeM3", "minLootVolumeM3", "maxPlanLines", "targetCooldownMs", "ownerCooldownMs", "maxOpen",
  "maxOpenPerFaction", "retentionMs", "pruneBatch", "maxBayLines", "maxFleetsReadPerCheck", "maxPerPass",
  "skyhookLossPermille", "skyhookLaunchLeadMs", "skyhookMinLootUnits", "maxSkyhooksIndexed"]);
const FACADE_METHODS = Object.freeze(["getMode", "getStatus", "whenReady", "reconcile", "listOpen",
  "readTargetsForFaction", "stop"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableHarvestRaid(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE, detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  return Object.freeze({ getMode: () => "off", getStatus: () => status, whenReady: () => Promise.resolve(status),
    reconcile: refuse, listOpen: refuse, readTargetsForFaction: refuse, stop() {} });
}

function seamsOf(adapter) {
  if (!adapter) return { ok: false, reason: "HARVEST_BAYS_SEAM_UNAVAILABLE", detail: "adapter" };
  let bays = null;
  let structures = null;
  try {
    bays = adapter.harvestBays;
    structures = adapter.playerStructures;
  } catch (err) {
    return { ok: false, reason: "HARVEST_BAYS_SEAM_UNAVAILABLE", detail: messageOf(err) };
  }
  if (!bays || typeof bays.checkSeams !== "function") {
    return { ok: false, reason: "HARVEST_BAYS_SEAM_UNAVAILABLE", detail: "harvestBays" };
  }
  let check;
  try {
    check = bays.checkSeams();
  } catch (err) {
    check = { ok: false, detail: messageOf(err) };
  }
  if (!check || check.ok !== true) {
    return { ok: false, reason: "HARVEST_BAYS_SEAM_UNAVAILABLE", detail: String((check && (check.detail
      || check.reason)) || "?") };
  }
  let ps;
  try {
    ps = typeof adapter.playerStructureSeams === "function" ? adapter.playerStructureSeams() : null;
  } catch (err) {
    ps = { ok: false, detail: messageOf(err) };
  }
  if (!ps || ps.ok !== true || !structures || typeof structures.listCandidates !== "function") {
    return { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE", detail: String((ps && (ps.detail || ps.reason))
      || "playerStructures") };
  }
  return { ok: true, bays, structures };
}

function skyhookSeamOf(adapter, C) {
  if (!C || C.skyhookEnabled !== true) return { skyhooks: null, mode: "disabled" };
  let seam = null;
  let check;
  try {
    seam = adapter ? adapter.playerSkyhooks : null;
    check = seam && typeof seam.checkRaidSeams === "function" ? seam.checkRaidSeams()
      : { ok: false, detail: "playerSkyhooks" };
  } catch (err) {
    check = { ok: false, detail: messageOf(err) };
  }
  if (check && check.ok === true) return { skyhooks: seam, mode: "on" };
  return { skyhooks: null, mode: `off:${String((check && (check.detail || check.reason)) || "?")}` };
}

function startHarvestRaid(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    if (!config || !config.harvestRaid || config.harvestRaid.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!isModuleEnabled(config, "presence")) return { ok: false, reason: "dependency_disabled:presence" };
    const N = config.notices;
    if (!isModuleEnabled(config, "world") || !N || N.enabled !== true || N.kindHarvestRaid === false) {
      return { ok: false, reason: "dependency_disabled:notices" };
    }
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueueMany !== "function"
      || typeof scheduler.enqueue !== "function" || typeof scheduler.findByKey !== "function"
      || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository || typeof fleets.repository.listFleetsInSystem !== "function"
      || typeof fleets.repository.getFleet !== "function" || typeof fleets.repository.getOperation !== "function"
      || !fleets.travel || typeof fleets.travel.addArrivalListener !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    const registry = deps.strategy && deps.strategy.registry;
    if (!registry || typeof registry.isActive !== "function" || typeof registry.getFaction !== "function") {
      return { ok: false, reason: "dependency_disabled:strategy" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: START_FAILED, detail: "clock" };
    const C = config.harvestRaid;
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 0) {
        return { ok: false, reason: START_FAILED, detail: `harvestRaid.${key}` };
      }
    }
    if (C.lossPermille > S.MAX_LOSS_PERMILLE) {
      return { ok: false, reason: START_FAILED, detail: `harvestRaid.lossPermille ${C.lossPermille} > `
        + `${S.MAX_LOSS_PERMILLE}` };
    }
    if (C.skyhookLossPermille > S.MAX_LOSS_PERMILLE) {
      return { ok: false, reason: START_FAILED, detail: `harvestRaid.skyhookLossPermille ${C.skyhookLossPermille} > `
        + `${S.MAX_LOSS_PERMILLE}` };
    }
    if (C.retentionMs < C.targetCooldownMs || C.retentionMs < C.ownerCooldownMs) {
      return { ok: false, reason: START_FAILED, detail: `harvestRaid.retentionMs ${C.retentionMs} < a cooldown `
        + `(target ${C.targetCooldownMs}, owner ${C.ownerCooldownMs})` };
    }
    const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
    if (Number.isSafeInteger(maxRows) && (S.START_ROWS + C.pruneBatch > maxRows || S.END_ROWS > maxRows)) {
      return { ok: false, reason: START_FAILED, detail: `harvest raid start rows ${S.START_ROWS + C.pruneBatch} > `
        + `persistence.maxRowsPerTransaction ${maxRows} - lower harvestRaid.pruneBatch` };
    }
    const seams = seamsOf(deps.adapter);
    if (!seams.ok) return { ok: false, reason: seams.reason, detail: seams.detail };
    const adapter = deps.adapter;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const graph = deps.graph || null;
    const owner = createOwnerOnline({ getPresence: typeof deps.getPresence === "function" ? deps.getPresence
      : () => null, adapter, config, now: () => clock.now() });
    const sky = skyhookSeamOf(adapter, C);
    if (sky.mode.startsWith("off:")) {
      logger.log(`harvestRaid: skyhook off ${sky.mode.slice(4)} (W161, Metenox raids go on)`);
    }
    const service = createHarvestRaidService({ store: persistence.store,
      raids: createHarvestRaidRepository({ journal: persistence.journal }), scheduler,
      fleetRepository: fleets.repository, registry, structures: seams.structures, bays: seams.bays,
      skyhooks: sky.skyhooks, skyhookMode: sky.mode,
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, ownerId) => adapter.readCharacterStanding(characterId, ownerId) : null,
      getVirtualCorps: typeof deps.getVirtualCorps === "function" ? deps.getVirtualCorps : () => null,
      getPlayerSiege: typeof deps.getPlayerSiege === "function" ? deps.getPlayerSiege : () => null,
      getNotices: typeof deps.getNotices === "function" ? deps.getNotices : () => null,
      ownerOnline: owner.ownerOnline, hostility: createHostility(),
      groups: expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy)),
      getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null), config, clock,
      telemetry: deps.telemetry || null, logger });

    const registrations = [];
    const unregisterAll = () => {
      for (const r of registrations.splice(0)) swallow(() => r.unregister());
    };
    for (const [type, fn] of [[S.CHECK_EVENT_TYPE, service.onCheck], [S.STEP_EVENT_TYPE, service.onStep],
      [S.SETTLE_EVENT_TYPE, service.onSettle]]) {
      let registration;
      try {
        registration = scheduler.registerHandler(type, fn, { maxPerPass: C.maxPerPass });
      } catch (err) {
        registration = { ok: false, reason: messageOf(err) };
      }
      if (!registration || !registration.ok) {
        unregisterAll();
        return { ok: false, reason: START_FAILED,
          detail: `handler ${type}: ${(registration && registration.reason) || "no result"}` };
      }
      registrations.push(registration);
    }
    const listener = fleets.travel.addArrivalListener(service.onArrival);
    if (!listener || !listener.ok) {
      unregisterAll();
      return { ok: false, reason: START_FAILED, detail: `arrival listener: ${(listener && listener.reason)
        || "no result"}` };
    }

    const rec = service.reconcile();
    if (!rec.ok) logger.log(`harvestRaid: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0 || rec.lost > 0) {
      logger.log(`harvestRaid: reconcile open=${rec.open} enqueued=${rec.enqueued} lost=${rec.lost}`);
    }
    logger.log(`harvestRaid: running open=${rec.ok ? rec.open : "?"} metenox=${C.metenoxEnabled === true} loss=`
      + `${C.lossPermille}permille maxM3=${C.maxLossVolumeM3} skyhook=${sky.mode === "on" ? "on"
        : sky.mode === "disabled" ? "off:disabled" : sky.mode}`);

    const facade = {
      getMode: service.getMode,
      getStatus: service.getStatus,
      whenReady: () => Promise.resolve(service.getStatus()),
      reconcile: service.reconcile,
      listOpen: service.listOpen,
      readTargetsForFaction: service.readTargetsForFaction,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        unregisterAll();
        swallow(() => listener.remove());
      },
    };
    return { ok: true, harvestRaid: Object.freeze(facade), service };
  } catch (err) {
    return { ok: false, reason: START_FAILED, detail: messageOf(err) };
  }
}

module.exports = { startHarvestRaid, createUnavailableHarvestRaid, FACADE_METHODS };
