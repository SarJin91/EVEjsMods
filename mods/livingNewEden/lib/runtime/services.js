"use strict";

const { isModuleEnabled, effectiveTimeScale } = require("../../config");
const { createClock } = require("../util/clock");
const { createRng, createStreams, randomSeed } = require("../util/rng");
const { createIdGenerator } = require("../util/ids");
const { createViewRegistry } = require("../observer/views");
const { createHttpRoutes } = require("../observer/httpRoutes");
const { createStepRegistry } = require("../gameMaster/registry");
const { createCrisisRegistry } = require("../seasons/registry");
const { createLiveConfig } = require("../modSettings/live");
const { createRestartGuard } = require("./restartGuard");
const { exemptKindsOf } = require("../world/sovStructures/schema");

let sentryHostility = null;
function factionHostility(a, b) {
  if (sentryHostility === null) sentryHostility = require("../battle/data/hostility").createHostility();
  return sentryHostility(a, b);
}

function factionKindOf(ctx, factionId) {
  const registry = ctx.strategy && ctx.strategy.registry;
  const faction = registry && typeof registry.getFaction === "function" ? registry.getFaction(factionId) : null;
  return faction && typeof faction.kind === "string" ? faction.kind : null;
}

function isFactionEnemyOf(ctx, factionId, otherId) {
  if (!Number.isSafeInteger(otherId) || otherId <= 0 || otherId === factionId) return false;
  const registry = ctx.strategy && ctx.strategy.registry;
  const faction = registry && typeof registry.getFaction === "function" ? registry.getFaction(factionId) : null;
  if (!faction) return false;
  if (Array.isArray(faction.allies) && faction.allies.includes(otherId)) return false;
  return factionHostility(factionId, otherId) === true;
}

function needsSovStructureOf(ctx, factionId) {
  const kind = factionKindOf(ctx, factionId);
  if (kind === null) return true;
  const sov = ctx.config && ctx.config.sovStructures;
  const exempt = exemptKindsOf(sov ? sov.exemptKinds : null);
  return !exempt.includes(kind);
}

function canOccupyOf(ctx, factionId) {
  const r = ctx.strategy && ctx.strategy.registry;
  const e = r && typeof r.getFaction === "function" ? r.getFaction(factionId) : null;
  const d = e && e.doctrineId && typeof r.getDoctrine === "function" ? r.getDoctrine(e.doctrineId) : null;
  return !(d && d.canOccupy === false);
}

const SERVICES_SHUTDOWN_HOOK_NAME = "livingNewEden.services";

const STATE = Object.freeze({
  PENDING: "pending", RUNNING: "running", DISABLED: "disabled", FAILED: "failed", STOPPED: "stopped",
});

const DISABLED_REASONS = Object.freeze(["disabled_by_config", "adapter_unavailable", "telemetry_unavailable"]);
const DISABLED_REASON_PREFIXES = Object.freeze(["probe_drift:", "dependency_disabled:"]);

const START_THREW = "SERVICE_START_THREW";

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err);
}

function withDetail(reason, detail) {
  return `${reason}${detail ? ` (${detail})` : ""}`;
}

function classifyRefusal(reason) {
  const text = String(reason);
  if (DISABLED_REASONS.includes(text)) return STATE.DISABLED;
  return DISABLED_REASON_PREFIXES.some((p) => text.startsWith(p)) ? STATE.DISABLED : STATE.FAILED;
}

function refusalOf(result) {
  if (!result || typeof result !== "object") return { ok: false, reason: "no_result" };
  const reason = String(result.reason || "no_result");
  return { ok: false, reason, ...(result.detail ? { detail: result.detail } : {}) };
}

function footholdsOf(ctx, tx, f) {
  const raw = ctx.invasions && typeof ctx.invasions.listFootholdsInTx === "function"
    ? ctx.invasions.listFootholdsInTx(tx, f) : { ok: true, footholds: [] };
  const home = raw && raw.ok ? invaderHomeOf(ctx, tx, f) : null;
  const a = home ? { ok: true, footholds: [...raw.footholds, home] } : raw;
  const h = ctx.strategy && ctx.strategy.hive;
  if (!a || !a.ok || !h || typeof h.listNodesInTx !== "function") return a;
  const b = h.listNodesInTx(tx, f);
  return b && b.ok ? { ok: true, footholds: [...a.footholds, ...b.footholds] } : b;
}

function beachheadsOf(ctx, tx, limit, systems) {
  return ctx.invasions && typeof ctx.invasions.listBeachheadsInTx === "function"
    ? ctx.invasions.listBeachheadsInTx(tx, { limit, systems }) : { ok: true, beachheads: [], truncated: false };
}

function worldBossTargetsOf(ctx, tx, systems, max) {
  const wb = ctx.worldBosses;
  const r = wb && typeof wb.bossTargetsOf === "function" ? wb.bossTargetsOf(tx, systems, max) : null;
  return r && r.ok === true ? r : { ok: true, items: [], truncated: false };
}

function invaderHomeOf(ctx, tx, f) {
  const inv = ctx.config && ctx.config.invasions;
  if (!inv || inv.homeBaseEnabled !== true) return null;
  const registry = ctx.strategy && ctx.strategy.registry;
  const entry = registry && typeof registry.getFaction === "function" ? registry.getFaction(f) : null;
  if (!entry || entry.kind !== "invader" || !Number.isSafeInteger(entry.hqSystemId)) return null;
  const repo = ctx.world && ctx.world.repository;
  if (!repo || typeof repo.getSystem !== "function") return null;
  const row = repo.getSystem(tx, entry.hqSystemId, { includeInfluence: false });
  if (!row || row.ok !== true || !row.system || row.system.controllerFactionId !== f) return null;
  const maxJumps = ctx.config.graph && Number.isSafeInteger(ctx.config.graph.routeMaxJumps)
    ? ctx.config.graph.routeMaxJumps : inv.homeCaptureRangeJumps;
  return { systemId: entry.hqSystemId, jumps: Math.min(inv.homeCaptureRangeJumps, maxJumps), home: true };
}

function crewSummaryOf(ctx, tx, fleetIds) {
  const crews = ctx.crews;
  const cfg = ctx.config && ctx.config.crews;
  if (!crews || typeof crews.summarizeInTx !== "function" || !cfg || cfg.enabled !== true) return null;
  const batch = cfg.maxFleetsPerPass;
  if (!Number.isSafeInteger(batch) || batch < 1) return null;
  const ids = [...new Set(fleetIds)];
  const out = new Map();
  for (let i = 0; i < ids.length; i += batch) {
    const r = crews.summarizeInTx(tx, ids.slice(i, i + batch), { maxNames: cfg.tooltipMaxNames });
    if (!r || r.ok !== true) return null;
    for (const [id, v] of r.byFleet) out.set(id, v);
  }
  return out;
}

function fameHighsecOf(fame) {
  if (!fame || typeof fame !== "object") return null;
  return Object.freeze({ enabled: fame.enabled === true && fame.bountyHighsecEnabled === true,
    spawnEnabled: fame.bountyHighsecConcordSpawnEnabled === true, extraMs: fame.bountyHighsecConcordExtraMs,
    fallbackMs: fame.bountyHighsecConcordFallbackMs, killMs: fame.bountyHighsecConcordKillMs,
    leaveMs: fame.bountyHighsecConcordLeaveMs, maxLive: fame.bountyHighsecMaxLive,
    minSecurity: fame.bountyHighsecMinSecurity, maxSecurity: fame.bountyHighsecMaxSecurity });
}

function persistenceRefusal(reason, detail) {
  let disabledModules;
  try {
    disabledModules = require("../persistence").dependentsDisabled(reason);
  } catch (_err) {
    disabledModules = { persistence: String(reason) };
  }
  return { ok: false, reason, ...(detail ? { detail } : {}), disabledModules };
}

function unavailableScheduler(starters, reason, detail) {
  try {
    return (starters.createUnavailableScheduler || require("../scheduler").createUnavailableScheduler)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableWorld(starters, reason, detail) {
  try {
    return (starters.createUnavailableWorld || require("../world").createUnavailableWorld)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailablePresence(starters, reason, detail) {
  try {
    return (starters.createUnavailablePresence || require("../presence").createUnavailablePresence)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableWrecks(starters, reason, detail) {
  try {
    return (starters.createUnavailableWrecks || require("../world/wrecks").createUnavailableWrecks)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableOccupation(starters, reason, detail) {
  try {
    return (starters.createUnavailableOccupation || require("../world/occupation").createUnavailableOccupation)(reason,
      detail);
  } catch (_err) {
    return null;
  }
}

const releaseContactOf = (ctx) => (db, info) => {
  const b = ctx.battle;
  return b && typeof b.requestReleaseContactInTx === "function" ? b.requestReleaseContactInTx(db, info)
    : { ok: false, reason: "BATTLE_UNAVAILABLE" };
};

function bindBeltNavyRoll(ctx) {
  try {
    const { createBeltNavyRoll } = require("../world/beltNavy");
    ctx.beltNavyRoll = createBeltNavyRoll({ getWorld: () => ctx.world || null, getOccupation: () => ctx.occupation || null,
      worldSeed: ctx.persistence ? ctx.persistence.worldSeed : undefined, settings: ctx.config.world.beltNavy });
  } catch (_err) {
    ctx.beltNavyRoll = null;
  }
}

function unavailableSovProjection(starters, reason, detail) {
  try {
    return (starters.createUnavailableSovProjection || require("../world/sovProjection").createUnavailableSovProjection)(reason,
      detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSovReconcile(starters, reason, detail) {
  try {
    return (starters.createUnavailableSovReconcile || require("../world/sovReconcile").createUnavailableSovReconcile)(reason,
      detail);
  } catch (_err) {
    return null;
  }
}

function unavailablePlayerSov(starters, reason, detail) {
  try {
    return (starters.createUnavailablePlayerSov || require("../world/playerSov").createUnavailablePlayerSov)(reason,
      detail);
  } catch (_err) {
    return null;
  }
}

function unavailableLiberation(starters, reason, detail) {
  try {
    return (starters.createUnavailableLiberation || require("../world/liberation").createUnavailableLiberation)(
      reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableStandings(starters, reason, detail) {
  try {
    return (starters.createUnavailableStandings || require("../world/standings").createUnavailableStandings)(
      reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableBattle(starters, reason, detail) {
  try {
    return (starters.createUnavailableBattle || require("../battle").createUnavailableBattle)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableStrategy(starters, reason, detail) {
  try {
    return (starters.createUnavailableStrategy || require("../strategy").createUnavailableStrategy)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableStations(starters, reason, detail) {
  try {
    return (starters.createUnavailableStations || require("../stations").createUnavailableStations)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableMining(starters, reason, detail) {
  try {
    return (starters.createUnavailableMining || require("../economy/mining").createUnavailableMining)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableProduction(starters, reason, detail) {
  try {
    return (starters.createUnavailableProduction || require("../economy/production").createUnavailableProduction)(
      reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableLogistics(starters, reason, detail) {
  try {
    return (starters.createUnavailableLogistics || require("../economy/logistics").createUnavailableLogistics)(
      reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableConstruction(starters, reason, detail) {
  try {
    return (starters.createUnavailableConstruction
      || require("../stations/construction").createUnavailableConstruction)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableTrade(starters, reason, detail) {
  try {
    return (starters.createUnavailableTrade || require("../economy/trade").createUnavailableTrade)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableTreasury(starters, reason, detail) {
  try {
    return (starters.createUnavailableTreasury || require("../economy/treasury").createUnavailableTreasury)(reason,
      detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSiege(starters, reason, detail) {
  try {
    return (starters.createUnavailableSiege || require("../stations/siege").createUnavailableSiege)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailablePlayerSiege(starters, reason, detail) {
  try {
    return (starters.createUnavailablePlayerSiege
      || require("../stations/playerSiege").createUnavailablePlayerSiege)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableHarvestRaid(starters, reason, detail) {
  try {
    return (starters.createUnavailableHarvestRaid
      || require("../stations/harvestRaid").createUnavailableHarvestRaid)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSentries(starters, reason, detail) {
  try {
    return (starters.createUnavailableSentries || require("../sentries").createUnavailableSentries)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSovStructures(starters, reason, detail) {
  try {
    return (starters.createUnavailableSovStructures
      || require("../world/sovStructures").createUnavailableSovStructures)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableHunt(starters, reason, detail) {
  try {
    return (starters.createUnavailableHunt || require("../strategy/hunt").createUnavailableHunt)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableCapsuleers(starters, reason, detail) {
  try {
    return (starters.createUnavailableCapsuleers
      || require("../strategy/capsuleers").createUnavailableCapsuleers)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableLowsec(starters, reason, detail) {
  try {
    return (starters.createUnavailableLowsec || require("../strategy/lowsec").createUnavailableLowsec)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableBlockade(starters, reason, detail) {
  try {
    return (starters.createUnavailableBlockade
      || require("../strategy/blockade").createUnavailableBlockade)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableFortress(starters, reason, detail) {
  try {
    return (starters.createUnavailableFortress
      || require("../strategy/fortress").createUnavailableFortress)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableTransit(starters, reason, detail) {
  try {
    return (starters.createUnavailableTransit
      || require("../strategy/transit").createUnavailableTransit)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableListeningPosts(reason, detail) {
  try {
    return require("../listeningPosts").createUnavailableListeningPosts(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableGridDefense(starters, reason, detail) {
  try {
    return (starters.createUnavailableGridDefense
      || require("../strategy/gridDefense").createUnavailableGridDefense)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableExpeditions(starters, reason, detail) {
  try {
    return (starters.createUnavailableExpeditions
      || require("../strategy/expeditions").createUnavailableExpeditions)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableRetention(starters, reason, detail) {
  try {
    return (starters.createUnavailableRetention
      || require("../retention").createUnavailableRetention)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableBackup(starters, reason, detail) {
  try {
    return (starters.createUnavailableBackup
      || require("../persistence/backupService").createUnavailableBackup)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableInvasions(starters, reason, detail) {
  try {
    return (starters.createUnavailableInvasions || require("../world/invasions").createUnavailableInvasions)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSalvage(starters, reason, detail) {
  try {
    return (starters.createUnavailableSalvage || require("../world/salvage").createUnavailableSalvage)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableVirtualCorps(starters, reason, detail) {
  try {
    return (starters.createUnavailableVirtualCorps || require("../virtualCorps").createUnavailableVirtualCorps)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableStructures(starters, reason, detail) {
  try {
    return (starters.createUnavailableStructures
      || require("../stations/structures").createUnavailableStructures)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSites(starters, reason, detail) {
  try {
    return (starters.unavailableSites || require("../events/sites").unavailableSites)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableEvents(starters, reason, detail) {
  try {
    return (starters.unavailableEvents || require("../events").unavailableEvents)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableSalvageAnomaly(starters, reason, detail) {
  try {
    return (starters.unavailableSalvageAnomaly
      || require("../events/salvage").unavailableSalvageAnomaly)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableEventRewards(starters, reason, detail) {
  try {
    return (starters.unavailableEventRewards
      || require("../events/rewards").unavailableEventRewards)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailablePlayerHunt(starters, reason, detail) {
  try {
    return (starters.createUnavailablePlayerHunt
      || require("../playerHunt").createUnavailablePlayerHunt)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableFleetExposure(starters, reason, detail) {
  try {
    return (starters.createUnavailableFleetExposure
      || require("../fleetExposure").createUnavailableFleetExposure)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableNotices(starters, reason, detail) {
  try {
    return (starters.createUnavailableNotices || require("../notices").createUnavailableNotices)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableNews(starters, reason, detail) {
  try {
    return (starters.createUnavailableNews || require("../news").createUnavailableNews)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableMaterialization(starters, reason, detail) {
  try {
    return (starters.createUnavailableMaterialization
      || require("../materialization").createUnavailableMaterialization)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableWormholes(starters, reason, detail) {
  try {
    return (starters.createUnavailableWormholes
      || require("../graph/wormholes").createUnavailableWormholes)(reason, detail);
  } catch (_err) {
    return null;
  }
}

function unavailableFleets(starters, reason, detail) {
  try {
    return (starters.createUnavailableFleets || require("../fleets").createUnavailableFleets)(reason, detail);
  } catch (_err) {
    return null;
  }
}

const pollerHooksOf = new WeakMap();

function buildPollerPacer(ctx, telemetry) {
  const perf = ctx.config && ctx.config.perf;
  const pp = perf && perf.pollerPacing;
  if (!pp || pp.enabled !== true) return null;
  const mc = ctx.config.telemetry && ctx.config.telemetry.moduleCost;
  const { createPollerPacer } = require("../telemetry/pollerPacer");
  const maxLabels = mc && Number.isSafeInteger(mc.maxPollerLabels) ? mc.maxPollerLabels : 0;
  return createPollerPacer({ ...pp, maxLabels }, {
    getMode: () => {
      const g = ctx.governor;
      const status = g && typeof g.getStatus === "function" ? g.getStatus() : null;
      return status && typeof status.baseMode === "string" ? status.baseMode : null;
    },
    overBudget: typeof telemetry.moduleOverBudget === "function" ? telemetry.moduleOverBudget : () => false,
    inBudget: typeof telemetry.moduleInBudget === "function" ? telemetry.moduleInBudget : () => true,
    count: telemetry.count,
    gauge: telemetry.gauge,
  });
}

function installSceneNpcSources(ctx) {
  const adapter = ctx.adapter;
  if (!adapter || typeof adapter.setSceneNpcSources !== "function") return;
  try {
    const telemetry = ctx.telemetry;
    adapter.setSceneNpcSources({
      getMode: () => {
        const g = ctx.governor;
        const policy = g && typeof g.getPolicy === "function" ? g.getPolicy() : null;
        return policy && typeof policy.mode === "string" ? policy.mode : null;
      },
      count: telemetry && typeof telemetry.count === "function" ? (name) => telemetry.count(name) : undefined,
      gauge: telemetry && typeof telemetry.gauge === "function" ? (name, v) => telemetry.gauge(name, v) : undefined,
    });
  } catch (_err) {
  }
}

function installPollerHooksFor(ctx, telemetry) {
  const meter = typeof telemetry.notePoller === "function" ? telemetry.notePoller : null;
  const pacer = buildPollerPacer(ctx, telemetry);
  if (meter === null && pacer === null) return;
  const h = { ...(meter !== null ? { meter } : {}), ...(pacer !== null ? { pacer } : {}) };
  require("../presence/poller").installPollerHooks(h);
  pollerHooksOf.set(telemetry, h);
}

function uninstallPollerMeter(telemetry) {
  if (!telemetry || (typeof telemetry !== "object" && typeof telemetry !== "function")) return;
  try {
    const own = pollerHooksOf.get(telemetry);
    if (own === undefined) return;
    pollerHooksOf.delete(telemetry);
    const poller = require("../presence/poller");
    if (poller.getPollerHooks() === own) poller.installPollerHooks(null);
  } catch (_err) {
  }
}

function buildDefaultServiceDefs(starters = {}) {
  return [
    {
      name: "telemetry",
      module: "telemetry",
      requires: [],
      probeGated: false,
      start(ctx, deps) {
        const startTelemetry = starters.startTelemetry || require("../telemetry").startTelemetry;
        const started = startTelemetry({ config: ctx.config, adapter: ctx.adapter, modDir: ctx.modDir,
          logger: deps.logger, clock: ctx.clock, stallTimers: ctx.stallTimers || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.telemetry = started.telemetry;
        installPollerHooksFor(ctx, started.telemetry);
        try {
          const st = started.telemetry.getStatus();
          const snap = started.telemetry.getSnapshot();
          deps.logger.log(`telemetry: running interval=${ctx.config.telemetry.intervalSeconds}s tick=${st.tick}`
            + `${snap.status.tickReason ? ` (${snap.status.tickReason})` : ""} gc=${st.gc} `
            + `file=${snap.capture.path || `unavailable (${snap.status.snapshotWriteReason})`}`);
        } catch (err) {
          deps.logger.log(`telemetry: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx) {
        const telemetry = ctx.telemetry;
        ctx.telemetry = null;
        uninstallPollerMeter(telemetry);
        if (telemetry) telemetry.stop();
      },
      onUnavailable(ctx) {
        const telemetry = ctx.telemetry;
        ctx.telemetry = null;
        uninstallPollerMeter(telemetry);
        if (telemetry && typeof telemetry.stop === "function") telemetry.stop();
      },
    },
    {
      name: "persistence",
      module: "persistence",
      requires: [],
      logsRefusal: true,
      start(ctx, deps) {
        const startPersistence = starters.startPersistence || require("../persistence").startPersistence;
        const hooks = (ctx.telemetry && ctx.telemetry.hooks) || {};
        const result = startPersistence({ config: ctx.config, adapter: ctx.adapter, modDir: ctx.modDir,
          logger: deps.logger, clock: ctx.clock, onTiming: hooks.onTiming, onCount: hooks.onCount,
          processApi: deps.processApi,
          getGovernor: () => ctx.governor || null, telemetry: ctx.telemetry || null });
        ctx.persistence = result || null;
        if (!result || !result.ok) return refusalOf(result);
        ctx.streams = createStreams(result.worldSeed);
        return { ok: true };
      },
      stop(ctx, reason) {
        if (ctx.persistence && ctx.persistence.ok) ctx.persistence.store.close(reason);
      },
      onUnavailable(ctx, reason, detail) {
        if (!ctx.persistence || ctx.persistence.ok !== false) ctx.persistence = persistenceRefusal(reason, detail);
        ctx.streams = null;
      },
    },
    {
      name: "governor",
      module: null,
      requires: ["telemetry"],
      start(ctx, deps) {
        const startGovernor = starters.startGovernor || require("../telemetry/governorService").startGovernor;
        const adapter = ctx.adapter;
        const subscribeVendorPauses = adapter && typeof adapter.subscribeVendorPauses === "function"
          ? (fn, opts) => adapter.subscribeVendorPauses(fn, opts) : undefined;
        const started = startGovernor({ config: ctx.config, telemetry: ctx.telemetry, logger: deps.logger,
          subscribeVendorPauses });
        if (!started || !started.ok) return refusalOf(started);
        ctx.governor = started.governor;
        installSceneNpcSources(ctx);
        return { ok: true };
      },
      stop(ctx) {
        const governor = ctx.governor;
        ctx.governor = null;
        if (governor) governor.stop();
      },
      onUnavailable(ctx) {
        ctx.governor = null;
      },
    },
    {
      name: "graph",
      module: "graph",
      requires: [],
      start(ctx, deps) {
        const startGraph = starters.startGraph || require("../graph").startGraph;
        const fortress = ctx.config.fortress;
        const transitAversion = fortress && fortress.routeAversionEnabled === true
          ? { systemIds: require("../strategy/data/fortresses").FORTRESSES.map((f) => f.systemId),
            detourMaxJumps: fortress.routeDetourMaxJumps }
          : null;
        const started = startGraph({ config: ctx.config, adapter: ctx.adapter, telemetry: ctx.telemetry || null,
          logger: deps.logger, fail: deps.fail, views: ctx.views || null, getGovernor: () => ctx.governor || null,
          ...(transitAversion ? { transitAversion } : {}) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.graph = started.graph;
        return { ok: true };
      },
      stop(ctx, reason) {
        if (ctx.graph) ctx.graph.stop(reason);
      },
      onUnavailable(ctx, reason, detail) {
        if (ctx.graph) return;
        let createUnavailableGraph;
        try {
          createUnavailableGraph = (starters.createUnavailableGraph || require("../graph").createUnavailableGraph);
        } catch (_err) {
          ctx.graph = null;
          return;
        }
        ctx.graph = createUnavailableGraph(reason === "disabled_by_config" ? "GRAPH_DISABLED" : "GRAPH_UNAVAILABLE",
          detail ? `${reason}:${detail}` : reason);
      },
    },
    {
      name: "world",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startWorld = starters.startWorld || require("../world").startWorld;
        const started = startWorld({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, graph: ctx.graph || null, adapter: ctx.adapter || null,
          getGovernor: () => ctx.governor || null, views: ctx.views || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.world = started.world;
        return { ok: true };
      },
      stop(ctx, reason) {
        const world = ctx.world;
        ctx.world = unavailableWorld(starters, "WORLD_UNAVAILABLE", "stopped");
        if (world && typeof world.stop === "function") world.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.world = unavailableWorld(starters, reason === "disabled_by_config" ? "WORLD_DISABLED" : "WORLD_UNAVAILABLE",
          reason);
      },
    },
    {
      name: "presence",
      module: "presence",
      requires: [],
      start(ctx, deps) {
        const startPresence = starters.startPresence || require("../presence").startPresence;
        const started = startPresence({ config: ctx.config, adapter: ctx.adapter, graph: ctx.graph || null,
          telemetry: ctx.telemetry || null, views: ctx.views || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.presence = started.presence;
        return { ok: true };
      },
      stop(ctx, reason) {
        const presence = ctx.presence;
        ctx.presence = unavailablePresence(starters, "PRESENCE_UNAVAILABLE", "stopped");
        if (presence && typeof presence.stop === "function") presence.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.presence = unavailablePresence(starters,
          reason === "disabled_by_config" ? "PRESENCE_DISABLED" : "PRESENCE_UNAVAILABLE", reason);
      },
    },
    {
      name: "scheduler",
      module: "scheduler",
      requires: ["persistence"],
      start(ctx, deps) {
        const startScheduler = starters.startScheduler || require("../scheduler").startScheduler;
        const started = startScheduler({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, telemetry: ctx.telemetry || null, views: ctx.views || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.scheduler = started.scheduler;
        let passes = "";
        try {
          if (typeof started.scheduler.startPasses === "function") {
            const r = started.scheduler.startPasses();
            passes = r && r.ok ? " passes=every " : ` passes=refused:${(r && r.reason) || "no result"}`;
          }
        } catch (err) {
          passes = ` passes=failed:${messageOf(err)}`;
        }
        try {
          const st = started.scheduler.getStatus();
          if (passes === " passes=every ") passes += `${st.driver ? st.driver.intervalMs : "?"}ms`;
          deps.logger.log(`scheduler: running open=${st.open}`
            + ` recovered=${st.recovered.retried}/${st.recovered.quarantined}`
            + ` rebuildMs=${Math.round(st.rebuildMs * 10) / 10}${passes}`);
        } catch (err) {
          deps.logger.log(`scheduler: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const scheduler = ctx.scheduler;
        ctx.scheduler = unavailableScheduler(starters, "SCHEDULER_UNAVAILABLE", "stopped");
        if (scheduler && typeof scheduler.stop === "function") scheduler.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.scheduler = unavailableScheduler(starters,
          reason === "disabled_by_config" ? "SCHEDULER_DISABLED" : "SCHEDULER_UNAVAILABLE", reason);
      },
    },
    {
      name: "fleets",
      module: "fleets",
      requires: ["persistence"],
      start(ctx, deps) {
        const startFleets = starters.startFleets || require("../fleets").startFleets;
        const started = startFleets({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, telemetry: ctx.telemetry || null, logger: deps.logger, scheduler: ctx.scheduler || null,
          graph: ctx.graph || null, presence: ctx.presence || null, views: ctx.views || null,
          getGovernor: () => ctx.governor || null,
          adapter: ctx.adapter || null,
          getStations: () => ctx.stations || null,
          getRegistry: () => (ctx.strategy && ctx.strategy.registry) || null,
          getVirtualCorps: () => ctx.virtualCorps || null,
          getWormholes: () => ctx.wormholes || null,
          getCrewSummary: (tx, fleetIds) => crewSummaryOf(ctx, tx, fleetIds) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.fleets = started.fleets;
        try {
          const counted = started.fleets.countByState();
          const st = typeof started.fleets.getStatus === "function" ? started.fleets.getStatus() : null;
          const travel = st && st.travel ? st.travel : null;
          const travelPart = !travel ? "?" : (travel.state === "ready" ? "ready" : `unavailable:${travel.reason}`);
          deps.logger.log(`fleets: running active=${counted && counted.ok ? counted.active : "?"}`
            + ` limit=${ctx.config.limits.maxVirtualFleets} travel=${travelPart}`);
        } catch (err) {
          deps.logger.log(`fleets: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const fleets = ctx.fleets;
        ctx.fleets = unavailableFleets(starters, "FLEETS_UNAVAILABLE", "stopped");
        if (fleets && typeof fleets.stop === "function") fleets.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.fleets = unavailableFleets(starters,
          reason === "disabled_by_config" ? "FLEETS_DISABLED" : "FLEETS_UNAVAILABLE", reason);
      },
    },
    {
      name: "wormholes",
      module: "graph",
      requires: [],
      start(ctx, deps) {
        const startWormholes = starters.startWormholes || require("../graph/wormholes").startWormholes;
        const started = startWormholes({ config: ctx.config, adapter: ctx.adapter || null, graph: ctx.graph || null,
          clock: ctx.clock, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null,
          getFleets: () => ctx.fleets || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.wormholes = started.wormholes;
        return { ok: true };
      },
      stop(ctx, reason) {
        const wormholes = ctx.wormholes;
        ctx.wormholes = unavailableWormholes(starters, "WORMHOLES_UNAVAILABLE", "stopped");
        if (wormholes && typeof wormholes.stop === "function") wormholes.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.wormholes = unavailableWormholes(starters,
          reason === "disabled_by_config" ? "WORMHOLES_DISABLED" : "WORMHOLES_UNAVAILABLE", reason);
      },
    },
    {
      name: "wrecks",
      module: "world",
      requires: ["persistence", "scheduler"],
      start(ctx, deps) {
        const startWrecks = starters.startWrecks || require("../world/wrecks").startWrecks;
        const started = startWrecks({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, views: ctx.views || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.wrecks = started.wrecks;
        try {
          const counted = typeof started.wrecks.countActive === "function" ? started.wrecks.countActive() : null;
          deps.logger.log(`wrecks: running active=${counted && counted.ok ? counted.count : "?"}`
            + ` limit=${ctx.config.wrecks.maxFieldsGlobal}`);
        } catch (err) {
          deps.logger.log(`wrecks: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const wrecks = ctx.wrecks;
        ctx.wrecks = unavailableWrecks(starters, "WRECKS_UNAVAILABLE", "stopped");
        if (wrecks && typeof wrecks.stop === "function") wrecks.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.wrecks = unavailableWrecks(starters,
          reason === "disabled_by_config" ? "WRECKS_DISABLED" : "WRECKS_UNAVAILABLE", reason);
      },
    },
    {
      name: "occupation",
      module: "world",
      requires: ["persistence", "scheduler", "fleets", "world"],
      start(ctx, deps) {
        const startOccupation = starters.startOccupation || require("../world/occupation").startOccupation;
        const started = startOccupation({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, world: ctx.world || null,
          graph: ctx.graph || null, getStations: () => ctx.stations || null, views: ctx.views || null,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null,
          nonOccupierFactionIds: [require("../strategy/data/capsuleers").CAPSULEER_FACTION_ID],
          getCaptureBelt: (f) => (ctx.strategy && typeof ctx.strategy.getCaptureBelt === "function"
            ? ctx.strategy.getCaptureBelt(f) : { ok: false, reason: "STRATEGY_UNAVAILABLE" }),
          footholdsOf: (tx, f) => footholdsOf(ctx, tx, f),
          consolidatesOf: (factionId) => {
            const r = ctx.strategy && ctx.strategy.registry;
            const e = r && r.getFaction(factionId);
            const d = e && e.doctrineId ? r.getDoctrine(e.doctrineId) : null;
            return !(d && d.consolidates === false);
          },
          canOccupyOf: (factionId) => canOccupyOf(ctx, factionId),
          drawsGarrisonOf: (f) => !(ctx.strategy && ctx.strategy.hive && ctx.strategy.hive.isHive(f)),
          captureSlowFactorOf: (c, home) => (ctx.strategy && ctx.strategy.hive
            ? ctx.strategy.hive.captureSlowFactorOf(c, home) : 1),
          getSovStructures: () => ctx.sovStructures || null,
          needsSovStructureOf: (f) => needsSovStructureOf(ctx, f),
          getPlayerSovSiege: () => ctx.playerSovSiege || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.occupation = started.occupation;
        bindBeltNavyRoll(ctx);
        try {
          const st = started.occupation.getStatus();
          deps.logger.log(`occupation: running bootstrap=${st.counters ? st.counters.bootstrapEnqueued : "?"}`
            + `/${st.counters ? st.counters.bootstrapDuplicates : "?"}`
            + ` limit=${ctx.config.occupation.maxActiveSystems}`);
        } catch (err) {
          deps.logger.log(`occupation: running (status line failed: ${messageOf(err)})`);
        }
        const startBastions = starters.startBastionReconcile
          || require("../world/bastions/reconcileService").startBastionReconcile;
        const bastions = startBastions({ config: ctx.config, store: ctx.persistence.store,
          scheduler: ctx.scheduler, getOccupation: () => ctx.occupation || null, getGraph: () => ctx.graph || null,
          coreIndex: require("../world/core").getCoreIndex(ctx.config), clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, nowMs: () => performance.now(),
          getRegistry: () => (ctx.strategy && ctx.strategy.registry) || null });
        if (bastions && bastions.ok) {
          ctx.bastions = bastions.reconcile;
          ctx.bastionsRegistration = bastions.registration;
        } else {
          deps.logger.log(`world: bastion reconcile not started - ${(bastions && bastions.reason) || "no result"}`
            + `${bastions && bastions.detail ? ` (${bastions.detail})` : ""}`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const occupation = ctx.occupation;
        try {
          if (ctx.bastions) ctx.bastions.stop();
          if (ctx.bastionsRegistration) ctx.bastionsRegistration.unregister();
        } catch (_err) {
        }
        ctx.bastions = null;
        ctx.bastionsRegistration = null;
        ctx.occupation = unavailableOccupation(starters, "OCCUPATION_UNAVAILABLE", "stopped");
        ctx.beltNavyRoll = null;
        if (occupation && typeof occupation.stop === "function") occupation.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.occupation = unavailableOccupation(starters,
          reason === "disabled_by_config" ? "OCCUPATION_DISABLED" : "OCCUPATION_UNAVAILABLE", reason);
        bindBeltNavyRoll(ctx);
      },
    },
    {
      name: "sovStructures",
      module: "world",
      requires: ["persistence", "scheduler", "occupation"],
      start(ctx, deps) {
        const startSovStructures = starters.startSovStructures || require("../world/sovStructures").startSovStructures;
        const started = startSovStructures({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, getOccupation: () => ctx.occupation || null,
          getTreasury: () => ctx.treasury || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getPresence: () => ctx.presence || null, needsSovStructureOf: (f) => needsSovStructureOf(ctx, f),
          views: ctx.views || null, getGovernor: () => ctx.governor || null, graph: ctx.graph || null,
          adapter: ctx.adapter || null,
          getRegistry: () => (ctx.strategy && ctx.strategy.registry) || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.sovStructures = started.sovStructures;
        try {
          const st = started.sovStructures.getStatus();
          deps.logger.log(`sovStructures: running live=${st.live === null ? "?" : st.live}`
            + ` anchorMs=${ctx.config.sovStructures.anchorMs} costIsk=${ctx.config.sovStructures.costIsk}`
            + ` exempt=${ctx.config.sovStructures.exemptKinds}`);
        } catch (err) {
          deps.logger.log(`sovStructures: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const sovStructures = ctx.sovStructures;
        ctx.sovStructures = unavailableSovStructures(starters, "SOV_STRUCTURES_UNAVAILABLE", "stopped");
        if (sovStructures && typeof sovStructures.stop === "function") sovStructures.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.sovStructures = unavailableSovStructures(starters,
          reason === "disabled_by_config" ? "SOV_STRUCTURES_DISABLED" : "SOV_STRUCTURES_UNAVAILABLE", reason);
      },
    },
    
    {
      name: "liberation",
      module: "world",
      requires: ["persistence", "scheduler", "world", "occupation"],
      start(ctx, deps) {
        const startLiberation = starters.startLiberation || require("../world/liberation").startLiberation;
        const started = startLiberation({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, occupation: ctx.occupation || null, world: ctx.world || null,
          graph: ctx.graph || null, views: ctx.views || null, adapter: ctx.adapter || null,
          telemetry: ctx.telemetry || null, getGovernor: () => ctx.governor || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.liberation = started.liberation;
        try {
          const st = started.liberation.getStatus();
          deps.logger.log(`liberation: running view=${st.view === true} `
            + `points=${ctx.config.liberation.killInfluencePoints} threshold=${ctx.config.liberation.minControllerScore}`);
        } catch (err) {
          deps.logger.log(`liberation: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const liberation = ctx.liberation;
        ctx.liberation = unavailableLiberation(starters, "LIBERATION_UNAVAILABLE", "stopped");
        if (liberation && typeof liberation.stop === "function") liberation.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.liberation = unavailableLiberation(starters,
          reason === "disabled_by_config" ? "LIBERATION_DISABLED" : "LIBERATION_UNAVAILABLE", reason);
      },
    },
    {
      name: "standings",
      module: "world",
      requires: ["persistence", "scheduler", "world"],
      start(ctx, deps) {
        const startStandings = starters.startStandings || require("../world/standings").startStandings;
        const started = startStandings({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, world: ctx.world || null, graph: ctx.graph || null,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.standings = started.standings;
        try {
          const s = ctx.config.standings;
          const status = typeof started.standings.getStatus === "function" ? started.standings.getStatus() : null;
          const p = status && status.prune;
          const prune = p && p.state === "on" ? `prune=on retention=${s.retentionMs} grace=${s.receiptGraceMs} `
            + `interval=${s.pruneIntervalMs}` : `prune=off:${(p && p.reason) || "unknown"}`;
          deps.logger.log(`standings: running raw=${s.rawChangePerGrant} window=${s.debounceWindowMs} `
            + `cap=${s.maxGrantsPerCharacterDay} ${prune}`);
        } catch (err) {
          deps.logger.log(`standings: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const standings = ctx.standings;
        ctx.standings = unavailableStandings(starters, "STANDINGS_UNAVAILABLE", "stopped");
        if (standings && typeof standings.stop === "function") standings.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.standings = unavailableStandings(starters,
          reason === "disabled_by_config" ? "STANDINGS_DISABLED" : "STANDINGS_UNAVAILABLE", reason);
      },
    },
    {
      name: "beltNavy",
      module: "world",
      requires: ["world"],
      start(ctx, deps) {
        const startBeltNavy = starters.startBeltNavy || require("../world/beltNavy").startBeltNavy;
        const started = startBeltNavy({ config: ctx.config, adapter: ctx.adapter || null, clock: ctx.clock,
          getStandings: () => ctx.standings || null, telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.beltNavy = started.beltNavy;
        return { ok: true };
      },
      stop(ctx, reason) {
        const beltNavy = ctx.beltNavy;
        ctx.beltNavy = null;
        if (beltNavy && typeof beltNavy.stop === "function") beltNavy.stop(reason);
      },
      onUnavailable(ctx) {
        ctx.beltNavy = null;
      },
    },
    {
      name: "battle",
      module: "battle",
      requires: ["persistence", "fleets", "scheduler"],
      start(ctx, deps) {
        const startBattle = starters.startBattle || require("../battle").startBattle;
        const started = startBattle({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock, ids: ctx.ids,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, graph: ctx.graph || null,
          world: ctx.world || null, wrecks: ctx.wrecks || null, occupation: ctx.occupation || null,
          presence: ctx.presence || null,
          views: ctx.views || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null,
          getStations: () => ctx.stations || null, getSiege: () => ctx.siege || null,
          getStrategy: () => ctx.strategy || null,
          getTreasury: () => ctx.treasury || null,
          getCrews: () => ctx.crews || null,
          getSentries: () => ctx.sentries || null,
          getWorldBosses: () => ctx.worldBosses || null,
          getDevIndices: () => ctx.devIndices || null,
          getStructureSeam: () => (ctx.adapter && typeof ctx.adapter.getStructureSeam === "function"
            ? ctx.adapter.getStructureSeam() : null) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.battle = started.battle;
        return { ok: true };
      },
      stop(ctx, reason) {
        const battle = ctx.battle;
        ctx.battle = unavailableBattle(starters, "BATTLE_UNAVAILABLE", "stopped");
        if (battle && typeof battle.stop === "function") battle.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.battle = unavailableBattle(starters,
          reason === "disabled_by_config" ? "BATTLE_DISABLED" : "BATTLE_UNAVAILABLE", reason);
      },
    },
    {
      name: "strategy",
      module: "strategy",
      requires: ["persistence"],
      start(ctx, deps) {
        const startStrategy = starters.startStrategy || require("../strategy").startStrategy;
        const started = startStrategy({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          graph: ctx.graph || null, world: ctx.world || null, adapter: ctx.adapter || null, views: ctx.views || null,
          telemetry: ctx.telemetry || null, logger: deps.logger, getGovernor: () => ctx.governor || null,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, presence: ctx.presence || null,
          getStations: () => ctx.stations || null, getOccupation: () => ctx.occupation || null,
          getMining: () => ctx.mining || null, getProduction: () => ctx.production || null,
          getLogistics: () => ctx.logistics || null, getConstruction: () => ctx.construction || null,
          getTrade: () => ctx.trade || null, getSiege: () => ctx.siege || null,
          getPlayerSiege: () => ctx.playerSiege || null,
          getHarvestRaid: () => ctx.harvestRaid || null,
          getPlayerSovSiege: () => ctx.playerSovSiege || null,
          getPlayerValue: () => ctx.playerValue || null,
          getTransit: () => ctx.transit || null,
          getDevIndices: () => ctx.devIndices || null,
          getTreasury: () => ctx.treasury || null,
          getSentries: () => ctx.sentries || null,
          getHunt: () => ctx.hunt || null,
          getBlockade: () => ctx.blockade || null,
          footholdsOf: (tx, f) => footholdsOf(ctx, tx, f),
          beachheadsOf: (tx, limit, systems) => beachheadsOf(ctx, tx, limit, systems),
          getWorldBosses: () => ctx.worldBosses || null,
          worldBossTargetsOf: (tx, systems, max) => worldBossTargetsOf(ctx, tx, systems, max),
          getServices: () => ctx.services || null,
          getVirtualCorps: () => ctx.virtualCorps || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.strategy = started.strategy;
        return { ok: true };
      },
      stop(ctx, reason) {
        const strategy = ctx.strategy;
        ctx.strategy = unavailableStrategy(starters, "STRATEGY_UNAVAILABLE", "stopped");
        if (strategy && typeof strategy.stop === "function") strategy.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.strategy = unavailableStrategy(starters,
          reason === "disabled_by_config" ? "STRATEGY_DISABLED" : "STRATEGY_UNAVAILABLE", reason);
      },
    },
    {
      name: "stations",
      module: "strategy",
      requires: ["persistence", "strategy"],
      start(ctx, deps) {
        const startStations = starters.startStations || require("../stations").startStations;
        const started = startStations({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          strategy: ctx.strategy || null, graph: ctx.graph || null, adapter: ctx.adapter || null,
          views: ctx.views || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null,
          footholdsOf: (tx, f) => (ctx.invasions && typeof ctx.invasions.listFootholdsInTx === "function"
            ? ctx.invasions.listFootholdsInTx(tx, f) : null),
          homeOf: (tx, f) => invaderHomeOf(ctx, tx, f) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.stations = started.stations;
        return { ok: true };
      },
      stop(ctx, reason) {
        const stations = ctx.stations;
        ctx.stations = unavailableStations(starters, "STATIONS_UNAVAILABLE", "stopped");
        if (stations && typeof stations.stop === "function") stations.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.stations = unavailableStations(starters,
          reason === "disabled_by_config" ? "STATIONS_DISABLED" : "STATIONS_UNAVAILABLE", reason);
      },
    },
    {
      name: "mining",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "world", "strategy", "stations"],
      start(ctx, deps) {
        const startMining = starters.startMining || require("../economy/mining").startMining;
        const started = startMining({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock, ids: ctx.ids,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, world: ctx.world || null,
          strategy: ctx.strategy || null, graph: ctx.graph || null, getStations: () => ctx.stations || null,
          adapter: ctx.adapter || null, views: ctx.views || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.mining = started.mining;
        return { ok: true };
      },
      stop(ctx, reason) {
        const mining = ctx.mining;
        ctx.mining = unavailableMining(starters, "MINING_UNAVAILABLE", "stopped");
        if (mining && typeof mining.stop === "function") mining.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.mining = unavailableMining(starters,
          reason === "disabled_by_config" ? "MINING_DISABLED" : "MINING_UNAVAILABLE", reason);
      },
    },
    {
      name: "production",
      module: "strategy",
      requires: ["persistence", "scheduler", "strategy", "stations"],
      start(ctx, deps) {
        const startProduction = starters.startProduction || require("../economy/production").startProduction;
        const started = startProduction({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, scheduler: ctx.scheduler || null, strategy: ctx.strategy || null,
          getStations: () => ctx.stations || null, adapter: ctx.adapter || null, views: ctx.views || null,
          telemetry: ctx.telemetry || null, logger: deps.logger, getGovernor: () => ctx.governor || null,
          getGraph: () => ctx.graph || null,
          getExtraction: () => ctx.extraction || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.production = started.production;
        return { ok: true };
      },
      stop(ctx, reason) {
        const production = ctx.production;
        ctx.production = unavailableProduction(starters, "PRODUCTION_UNAVAILABLE", "stopped");
        if (production && typeof production.stop === "function") production.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.production = unavailableProduction(starters,
          reason === "disabled_by_config" ? "PRODUCTION_DISABLED" : "PRODUCTION_UNAVAILABLE", reason);
      },
    },
    {
      name: "logistics",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy", "stations"],
      start(ctx, deps) {
        const startLogistics = starters.startLogistics || require("../economy/logistics").startLogistics;
        const started = startLogistics({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          graph: ctx.graph || null, getStations: () => ctx.stations || null, adapter: ctx.adapter || null,
          views: ctx.views || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null, getConstruction: () => ctx.construction || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.logistics = started.logistics;
        return { ok: true };
      },
      stop(ctx, reason) {
        const logistics = ctx.logistics;
        ctx.logistics = unavailableLogistics(starters, "LOGISTICS_UNAVAILABLE", "stopped");
        if (logistics && typeof logistics.stop === "function") logistics.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.logistics = unavailableLogistics(starters,
          reason === "disabled_by_config" ? "LOGISTICS_DISABLED" : "LOGISTICS_UNAVAILABLE", reason);
      },
    },
    {
      name: "construction",
      module: "strategy",
      requires: ["persistence", "scheduler", "world", "strategy", "stations"],
      start(ctx, deps) {
        const startConstruction = starters.startConstruction || require("../stations/construction").startConstruction;
        const started = startConstruction({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, scheduler: ctx.scheduler || null, world: ctx.world || null, strategy: ctx.strategy || null,
          getStations: () => ctx.stations || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          views: ctx.views || null, adapter: ctx.adapter || null, graph: ctx.graph || null,
          getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.construction = started.construction;
        return { ok: true };
      },
      stop(ctx, reason) {
        const construction = ctx.construction;
        ctx.construction = unavailableConstruction(starters, "CONSTRUCTION_UNAVAILABLE", "stopped");
        if (construction && typeof construction.stop === "function") construction.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.construction = unavailableConstruction(starters,
          reason === "disabled_by_config" ? "CONSTRUCTION_DISABLED" : "CONSTRUCTION_UNAVAILABLE", reason);
      },
    },
    {
      name: "trade",
      module: "strategy",
      requires: ["persistence", "strategy", "stations"],
      start(ctx, deps) {
        const startTrade = starters.startTrade || require("../economy/trade").startTrade;
        const started = startTrade({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, views: ctx.views || null, adapter: ctx.adapter || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, getGovernor: () => ctx.governor || null,
          scheduler: ctx.scheduler || null,
          getStations: () => ctx.stations || null,
          getVirtualCorps: () => ctx.virtualCorps || null,
          getTreasury: () => ctx.treasury || null,
          getNotices: () => ctx.notices || null,
          getRegistry: () => (ctx.strategy && ctx.strategy.registry) || null,
          getGraph: () => ctx.graph || null,
          getExtraction: () => ctx.extraction || null,
          modDir: ctx.modDir });
        if (!started || !started.ok) return refusalOf(started);
        ctx.trade = started.trade;
        return { ok: true };
      },
      stop(ctx, reason) {
        const trade = ctx.trade;
        ctx.trade = unavailableTrade(starters, "TRADE_UNAVAILABLE", "stopped");
        if (trade && typeof trade.stop === "function") trade.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.trade = unavailableTrade(starters,
          reason === "disabled_by_config" ? "TRADE_DISABLED" : "TRADE_UNAVAILABLE", reason);
      },
    },
    {
      name: "treasury",
      module: "strategy",
      requires: ["persistence", "strategy"],
      start(ctx, deps) {
        const startTreasury = starters.startTreasury || require("../economy/treasury").startTreasury;
        const started = startTreasury({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, getTrade: () => ctx.trade || null,
          getStrategy: () => ctx.strategy || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.treasury = started.treasury;
        return { ok: true };
      },
      stop(ctx, reason) {
        const treasury = ctx.treasury;
        ctx.treasury = unavailableTreasury(starters, "TREASURY_UNAVAILABLE", "stopped");
        if (treasury && typeof treasury.stop === "function") treasury.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.treasury = unavailableTreasury(starters,
          reason === "disabled_by_config" ? "TREASURY_DISABLED" : "TREASURY_UNAVAILABLE", reason);
      },
    },
    {
      name: "siege",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy", "stations"],
      start(ctx, deps) {
        const startSiege = starters.startSiege || require("../stations/siege").startSiege;
        const started = startSiege({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          graph: ctx.graph || null, getStations: () => ctx.stations || null,
          getOccupation: () => ctx.occupation || null, getConstruction: () => ctx.construction || null,
          getWrecks: () => ctx.wrecks || null, views: ctx.views || null, adapter: ctx.adapter || null,
          telemetry: ctx.telemetry || null, logger: deps.logger, getGovernor: () => ctx.governor || null,
          getPlayerSiege: () => ctx.playerSiege || null,
          getHarvestRaid: () => ctx.harvestRaid || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.siege = started.siege;
        return { ok: true };
      },
      stop(ctx, reason) {
        const siege = ctx.siege;
        ctx.siege = unavailableSiege(starters, "SIEGE_UNAVAILABLE", "stopped");
        if (siege && typeof siege.stop === "function") siege.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.siege = unavailableSiege(starters,
          reason === "disabled_by_config" ? "SIEGE_DISABLED" : "SIEGE_UNAVAILABLE", reason);
      },
    },
    {
      name: "playerSiege",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy"],
      start(ctx, deps) {
        const startPlayerSiege = starters.startPlayerSiege || require("../stations/playerSiege").startPlayerSiege;
        const started = startPlayerSiege({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          graph: ctx.graph || null, adapter: ctx.adapter || null, getVirtualCorps: () => ctx.virtualCorps || null,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.playerSiege = started.playerSiege;
        return { ok: true };
      },
      stop(ctx, reason) {
        const playerSiege = ctx.playerSiege;
        ctx.playerSiege = unavailablePlayerSiege(starters, "PLAYER_SIEGE_UNAVAILABLE", "stopped");
        if (playerSiege && typeof playerSiege.stop === "function") playerSiege.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.playerSiege = unavailablePlayerSiege(starters,
          reason === "disabled_by_config" ? "PLAYER_SIEGE_DISABLED" : "PLAYER_SIEGE_UNAVAILABLE", reason);
      },
    },
    {
      name: "harvestRaid",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy"],
      start(ctx, deps) {
        const startHarvestRaid = starters.startHarvestRaid || require("../stations/harvestRaid").startHarvestRaid;
        const started = startHarvestRaid({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          graph: ctx.graph || null, adapter: ctx.adapter || null, getPresence: () => ctx.presence || null,
          getVirtualCorps: () => ctx.virtualCorps || null, getPlayerSiege: () => ctx.playerSiege || null,
          getNotices: () => ctx.notices || null,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.harvestRaid = started.harvestRaid;
        return { ok: true };
      },
      stop(ctx, reason) {
        const harvestRaid = ctx.harvestRaid;
        ctx.harvestRaid = unavailableHarvestRaid(starters, "HARVEST_RAID_UNAVAILABLE", "stopped");
        if (harvestRaid && typeof harvestRaid.stop === "function") harvestRaid.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.harvestRaid = unavailableHarvestRaid(starters,
          reason === "disabled_by_config" ? "HARVEST_RAID_DISABLED" : "HARVEST_RAID_UNAVAILABLE", reason);
      },
    },
    {
      name: "sentries",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy"],
      start(ctx, deps) {
        const startSentries = starters.startSentries || require("../sentries").startSentries;
        const { createOwnerOnline } = require("../world/playerSov/ownerOnline");
        const ownerOnline = createOwnerOnline({ getPresence: () => ctx.presence || null, adapter: ctx.adapter || null,
          config: ctx.config, now: () => ctx.clock.now() });
        const started = startSentries({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, graph: ctx.graph || null, adapter: ctx.adapter || null,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          getTreasury: () => ctx.treasury || null,
          fleets: ctx.fleets || null, getPresence: () => ctx.presence || null,
          getFactionKind: (factionId) => factionKindOf(ctx, factionId),
          isFactionEnemy: (factionId, otherId) => isFactionEnemyOf(ctx, factionId, otherId),
          views: ctx.views || null, getGovernor: () => ctx.governor || null,
          getBattle: () => ctx.battle || null, getOwnerOnline: () => ownerOnline });
        if (!started || !started.ok) return refusalOf(started);
        ctx.sentries = started.sentries;
        return { ok: true };
      },
      stop(ctx, reason) {
        const sentries = ctx.sentries;
        ctx.sentries = unavailableSentries(starters, "SENTRIES_UNAVAILABLE", "stopped");
        if (sentries && typeof sentries.stop === "function") sentries.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.sentries = unavailableSentries(starters,
          reason === "disabled_by_config" ? "SENTRIES_DISABLED" : "SENTRIES_UNAVAILABLE", reason);
      },
    },
    {
      name: "hunt",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy", "battle"],
      start(ctx, deps) {
        const startHunt = starters.startHunt || require("../strategy/hunt").startHunt;
        const started = startHunt({ config: ctx.config, persistence: ctx.persistence, scheduler: ctx.scheduler || null,
          fleets: ctx.fleets || null, battle: ctx.battle || null, graph: ctx.graph || null,
          telemetry: ctx.telemetry || null, clock: ctx.clock, ids: ctx.ids, logger: deps.logger,
          getWorld: () => ctx.world || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.hunt = started.hunt;
        return { ok: true };
      },
      stop(ctx, reason) {
        const hunt = ctx.hunt;
        ctx.hunt = unavailableHunt(starters, "HUNT_UNAVAILABLE", "stopped");
        if (hunt && typeof hunt.stop === "function") hunt.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.hunt = unavailableHunt(starters,
          reason === "disabled_by_config" ? "HUNT_DISABLED" : "HUNT_UNAVAILABLE", reason);
      },
    },
    {
      name: "lowsec",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy"],
      start(ctx, deps) {
        const startLowsec = starters.startLowsec || require("../strategy/lowsec").startLowsec;
        const started = startLowsec({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          graph: ctx.graph || null, telemetry: ctx.telemetry || null, clock: ctx.clock, ids: ctx.ids,
          logger: deps.logger,
          getLogistics: () => ctx.logistics || null, getBattle: () => ctx.battle || null,
          getWorld: () => ctx.world || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.lowsec = started.lowsec;
        return { ok: true };
      },
      stop(ctx, reason) {
        const lowsec = ctx.lowsec;
        ctx.lowsec = unavailableLowsec(starters, "LOWSEC_UNAVAILABLE", "stopped");
        if (lowsec && typeof lowsec.stop === "function") lowsec.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.lowsec = unavailableLowsec(starters,
          reason === "disabled_by_config" ? "LOWSEC_DISABLED" : "LOWSEC_UNAVAILABLE", reason);
      },
    },
    {
      name: "blockade",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets"],
      start(ctx, deps) {
        const startBlockade = starters.startBlockade || require("../strategy/blockade").startBlockade;
        const started = startBlockade({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, telemetry: ctx.telemetry || null,
          logger: deps.logger,
          getBattle: () => ctx.battle || null,
          clock: ctx.clock, getWorld: () => ctx.world || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.blockade = started.blockade;
        return { ok: true };
      },
      stop(ctx, reason) {
        const blockade = ctx.blockade;
        ctx.blockade = unavailableBlockade(starters, "BLOCKADE_UNAVAILABLE", "stopped");
        if (blockade && typeof blockade.stop === "function") blockade.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.blockade = unavailableBlockade(starters,
          reason === "disabled_by_config" ? "BLOCKADE_DISABLED" : "BLOCKADE_UNAVAILABLE", reason);
      },
    },
    {
      name: "gridDefense",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets"],
      start(ctx, deps) {
        const startGridDefense = starters.startGridDefense || require("../strategy/gridDefense").startGridDefense;
        const started = startGridDefense({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, graph: ctx.graph || null, getBattle: () => ctx.battle || null,
          getWorld: () => ctx.world || null, getStations: () => ctx.stations || null,
          getSiege: () => ctx.siege || null,
          getHunt: () => ctx.hunt || null,
          getSentries: () => ctx.sentries || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.gridDefense = started.gridDefense;
        return { ok: true };
      },
      stop(ctx, reason) {
        const gridDefense = ctx.gridDefense;
        ctx.gridDefense = unavailableGridDefense(starters, "GRID_DEFENSE_UNAVAILABLE", "stopped");
        if (gridDefense && typeof gridDefense.stop === "function") gridDefense.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.gridDefense = unavailableGridDefense(starters,
          reason === "disabled_by_config" ? "GRID_DEFENSE_DISABLED" : "GRID_DEFENSE_UNAVAILABLE", reason);
      },
    },
    {
      name: "fortress",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets"],
      start(ctx, deps) {
        const startFortress = starters.startFortress || require("../strategy/fortress").startFortress;
        const started = startFortress({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, getBattle: () => ctx.battle || null, getPresence: () => ctx.presence || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.fortress = started.fortress;
        return { ok: true };
      },
      stop(ctx, reason) {
        const fortress = ctx.fortress;
        ctx.fortress = unavailableFortress(starters, "FORTRESS_UNAVAILABLE", "stopped");
        if (fortress && typeof fortress.stop === "function") fortress.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.fortress = unavailableFortress(starters,
          reason === "disabled_by_config" ? "FORTRESS_DISABLED" : "FORTRESS_UNAVAILABLE", reason);
      },
    },
    {
      name: "transit",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "world"],
      start(ctx, deps) {
        const startTransit = starters.startTransit || require("../strategy/transit").startTransit;
        const started = startTransit({ config: ctx.config, fleets: ctx.fleets || null, world: ctx.world || null,
          getSentries: () => ctx.sentries || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          persistence: ctx.persistence, scheduler: ctx.scheduler || null, getBattle: () => ctx.battle || null,
          getPresence: () => ctx.presence || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.transit = started.transit;
        return { ok: true };
      },
      stop(ctx, reason) {
        const transit = ctx.transit;
        ctx.transit = unavailableTransit(starters, "TRANSIT_UNAVAILABLE", "stopped");
        if (transit && typeof transit.stop === "function") transit.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.transit = unavailableTransit(starters,
          reason === "disabled_by_config" ? "TRANSIT_DISABLED" : "TRANSIT_UNAVAILABLE", reason);
      },
    },
    {
      name: "listeningPost",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "world"],
      start(ctx, deps) {
        const startListeningPosts = starters.startListeningPosts || require("../listeningPosts").startListeningPosts;
        const started = startListeningPosts({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, getSentries: () => ctx.sentries || null,
          getGraph: () => ctx.graph || null, clock: ctx.clock, telemetry: ctx.telemetry || null, logger: deps.logger,
          adapter: ctx.adapter || null, getNotices: () => ctx.notices || null, views: ctx.views || null,
          getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.listeningPosts = started.listeningPosts;
        return { ok: true };
      },
      stop(ctx, reason) {
        const listeningPosts = ctx.listeningPosts;
        ctx.listeningPosts = unavailableListeningPosts("LISTENING_POST_UNAVAILABLE", "stopped");
        if (listeningPosts && typeof listeningPosts.stop === "function") listeningPosts.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.listeningPosts = unavailableListeningPosts(
          reason === "disabled_by_config" ? "LISTENING_POST_DISABLED" : "LISTENING_POST_UNAVAILABLE", reason);
      },
    },
    {
      name: "expeditions",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy"],
      start(ctx, deps) {
        const startExpeditions = starters.startExpeditions || require("../strategy/expeditions").startExpeditions;
        const started = startExpeditions({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          graph: ctx.graph || null, telemetry: ctx.telemetry || null, clock: ctx.clock, ids: ctx.ids,
          logger: deps.logger, getWormholes: () => ctx.wormholes || null, views: ctx.views || null,
          getGovernor: () => ctx.governor || null, getWorld: () => ctx.world || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.expeditions = started.expeditions;
        return { ok: true };
      },
      stop(ctx, reason) {
        const expeditions = ctx.expeditions;
        ctx.expeditions = unavailableExpeditions(starters, "EXPEDITIONS_UNAVAILABLE", "stopped");
        if (expeditions && typeof expeditions.stop === "function") expeditions.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.expeditions = unavailableExpeditions(starters,
          reason === "disabled_by_config" ? "EXPEDITIONS_DISABLED" : "EXPEDITIONS_UNAVAILABLE", reason);
      },
    },
    {
      name: "retention",
      module: "persistence",
      requires: ["persistence", "scheduler"],
      start(ctx, deps) {
        const startRetention = starters.startRetention || require("../retention").startRetention;
        const started = startRetention({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, clock: ctx.clock, telemetry: ctx.telemetry || null,
          logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.retention = started.retention;
        try {
          const p = started.retention.getStatus().params;
          deps.logger.log(`retention: running dry=${p.dryRun} interval=${p.intervalMs} minAge=${p.minAgeMs} `
            + `classes=${p.classes.length}`);
        } catch (err) {
          deps.logger.log(`retention: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const retention = ctx.retention;
        ctx.retention = unavailableRetention(starters, "RETENTION_UNAVAILABLE", "stopped");
        if (retention && typeof retention.stop === "function") retention.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.retention = unavailableRetention(starters,
          reason === "disabled_by_config" ? "RETENTION_DISABLED" : "RETENTION_UNAVAILABLE", reason);
      },
    },
    {
      name: "backup",
      module: "persistence",
      requires: ["persistence"],
      start(ctx, deps) {
        const startBackup = starters.startBackup || require("../persistence/backupService").startBackup;
        const started = startBackup({ config: ctx.config, persistence: ctx.persistence, modDir: ctx.modDir,
          getGovernor: () => ctx.governor || null, telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.backup = started.backup;
        try {
          const st = started.backup.getStatus();
          const b = ctx.config.backup;
          deps.logger.log(`backup: running dir=${st.dir} interval=${b.intervalMs} keep=${b.keep} `
            + `startDelay=${b.startDelayMs}`);
        } catch (err) {
          deps.logger.log(`backup: running (status line failed: ${messageOf(err)})`);
        }
        return { ok: true };
      },
      stop(ctx, reason) {
        const backup = ctx.backup;
        ctx.backup = unavailableBackup(starters, "BACKUP_UNAVAILABLE", "stopped");
        if (backup && typeof backup.stop === "function") backup.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.backup = unavailableBackup(starters,
          reason === "disabled_by_config" ? "BACKUP_DISABLED" : "BACKUP_UNAVAILABLE", reason);
      },
    },
    {
      name: "invasions",
      module: "world",
      requires: ["persistence", "scheduler", "fleets", "world", "strategy", "occupation", "battle"],
      start(ctx, deps) {
        const startInvasions = starters.startInvasions || require("../world/invasions").startInvasions;
        const started = startInvasions({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, world: ctx.world || null,
          graph: ctx.graph || null, stations: ctx.stations || null, presence: ctx.presence || null,
          adapter: ctx.adapter || null, strategy: ctx.strategy || null, occupation: ctx.occupation || null,
          battle: ctx.battle || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          views: ctx.views || null, getGovernor: () => ctx.governor || null,
          getTreasury: () => ctx.treasury || null,
          getAbyssal: () => ctx.abyssal || null,
          getSeasons: () => ctx.seasons || null,
          getFactionIncursions: () => ctx.factionIncursions || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.invasions = started.invasions;
        return { ok: true };
      },
      stop(ctx, reason) {
        const invasions = ctx.invasions;
        ctx.invasions = unavailableInvasions(starters, "INVASIONS_UNAVAILABLE", "stopped");
        if (invasions && typeof invasions.stop === "function") invasions.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.invasions = unavailableInvasions(starters,
          reason === "disabled_by_config" ? "INVASIONS_DISABLED" : "INVASIONS_UNAVAILABLE", reason);
      },
    },
    {
      name: "salvage",
      module: "world",
      requires: ["persistence", "scheduler", "wrecks"],
      start(ctx, deps) {
        const startSalvage = starters.startSalvage || require("../world/salvage").startSalvage;
        const started = startSalvage({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, wrecks: ctx.wrecks || null, graph: ctx.graph || null,
          getStations: () => ctx.stations || null, telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.salvage = started.salvage;
        return { ok: true };
      },
      stop(ctx, reason) {
        const salvage = ctx.salvage;
        ctx.salvage = unavailableSalvage(starters, "SALVAGE_UNAVAILABLE", "stopped");
        if (salvage && typeof salvage.stop === "function") salvage.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.salvage = unavailableSalvage(starters,
          reason === "disabled_by_config" ? "SALVAGE_DISABLED" : "SALVAGE_UNAVAILABLE", reason);
      },
    },
    {
      name: "virtualCorps",
      module: "virtualCorps",
      requires: ["persistence", "scheduler"],
      probeGated: false,
      start(ctx, deps) {
        const startVirtualCorps = starters.startVirtualCorps || require("../virtualCorps").startVirtualCorps;
        const started = startVirtualCorps({
          config: ctx.config,
          adapter: ctx.adapter,
          persistence: ctx.persistence,
          logger: deps.logger,
          fail: deps.fail,
          clock: ctx.clock,
          telemetry: ctx.telemetry,
          strategy: ctx.strategy,
        });
        if (!started || !started.ok) return refusalOf(started);
        const { ok, ...facade } = started;
        ctx.virtualCorps = facade;
        globalThis.getLivingNewEdenVirtualCorps = () => facade;
        return { ok: true };
      },
      stop(ctx, reason) {
        const virtualCorps = ctx.virtualCorps;
        ctx.virtualCorps = unavailableVirtualCorps(starters, "VIRTUAL_CORPS_UNAVAILABLE", reason);
        if (virtualCorps && typeof virtualCorps.stop === "function") virtualCorps.stop(reason);
        if (globalThis.getLivingNewEdenVirtualCorps) delete globalThis.getLivingNewEdenVirtualCorps;
      },
      onUnavailable(ctx, reason) {
        ctx.virtualCorps = unavailableVirtualCorps(starters,
          reason === "disabled_by_config" ? "VIRTUAL_CORPS_DISABLED" : "VIRTUAL_CORPS_UNAVAILABLE", reason);
      },
    },
    {
      name: "sovProjection",
      module: "world",
      requires: ["persistence", "scheduler", "world", "occupation", "virtualCorps"],
      probeGated: false,
      start(ctx, deps) {
        const startSovProjection = starters.startSovProjection || require("../world/sovProjection").startSovProjection;
        const started = startSovProjection({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, virtualCorps: ctx.virtualCorps || null, occupation: ctx.occupation || null,
          world: ctx.world || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null, fail: deps.fail, views: ctx.views || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.sovProjection = started.service;
        return { ok: true };
      },
      stop(ctx, reason) {
        const sovProjection = ctx.sovProjection;
        ctx.sovProjection = unavailableSovProjection(starters, "SOV_PROJECTION_UNAVAILABLE", "stopped");
        if (sovProjection && typeof sovProjection.stop === "function") sovProjection.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.sovProjection = unavailableSovProjection(starters,
          reason === "disabled_by_config" ? "SOV_PROJECTION_DISABLED" : "SOV_PROJECTION_UNAVAILABLE", reason);
      },
    },
    {
      name: "sovReconcile",
      module: "world",
      requires: ["persistence", "world", "occupation", "virtualCorps", "sovProjection"],
      probeGated: false,
      start(ctx, deps) {
        const startSovReconcile = starters.startSovReconcile || require("../world/sovReconcile").startSovReconcile;
        const started = startSovReconcile({
          config: ctx.config,
          persistence: ctx.persistence,
          clock: ctx.clock,
          adapter: ctx.adapter || null,
          virtualCorps: ctx.virtualCorps || null,
          occupation: ctx.occupation || null,
          sovProjection: ctx.sovProjection || null,
          world: ctx.world || null,
          telemetry: ctx.telemetry || null,
          logger: deps.logger,
          getGovernor: () => ctx.governor || null,
          fail: deps.fail,
          setTimer: deps.setTimer,
          views: ctx.views || null,
        });
        if (!started || !started.ok) return refusalOf(started);
        ctx.sovReconcile = started.service;
        return { ok: true };
      },
      stop(ctx, reason) {
        const sovReconcile = ctx.sovReconcile;
        ctx.sovReconcile = unavailableSovReconcile(starters, "SOV_RECONCILE_UNAVAILABLE", "stopped");
        if (sovReconcile && typeof sovReconcile.stop === "function") sovReconcile.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.sovReconcile = unavailableSovReconcile(starters,
          reason === "disabled_by_config" ? "SOV_RECONCILE_DISABLED" : "SOV_RECONCILE_UNAVAILABLE", reason);
      },
    },
    {
      name: "playerSov",
      module: "world",
      requires: ["persistence", "virtualCorps"],
      probeGated: false,
      start(ctx, deps) {
        const startPlayerSov = starters.startPlayerSov || require("../world/playerSov").startPlayerSov;
        const started = startPlayerSov({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, virtualCorps: ctx.virtualCorps || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, views: ctx.views || null, graph: ctx.graph || null,
          getGovernor: () => ctx.governor || null, setTimer: deps.setTimer });
        if (!started || !started.ok) return refusalOf(started);
        ctx.playerSov = started.playerSov;
        return { ok: true };
      },
      stop(ctx, reason) {
        const playerSov = ctx.playerSov;
        ctx.playerSov = unavailablePlayerSov(starters, "PLAYER_SOV_UNAVAILABLE", "stopped");
        if (playerSov && typeof playerSov.stop === "function") playerSov.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.playerSov = unavailablePlayerSov(starters,
          reason === "disabled_by_config" ? "PLAYER_SOV_DISABLED" : "PLAYER_SOV_UNAVAILABLE", reason);
      },
    },
    {
      name: "playerSovSiege",
      module: "world",
      requires: ["persistence", "occupation"],
      probeGated: false,
      start(ctx, deps) {
        const startPlayerSovSiege = starters.startPlayerSovSiege
          || require("../world/playerSov/siege").startPlayerSovSiege;
        const started = startPlayerSovSiege({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          playerSov: ctx.playerSov || null, adapter: ctx.adapter || null, getPresence: () => ctx.presence || null,
          getRegistry: () => (ctx.strategy && ctx.strategy.registry) || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, getGovernor: () => ctx.governor || null, setTimer: deps.setTimer });
        if (!started || !started.ok) return refusalOf(started);
        ctx.playerSovSiege = started.playerSovSiege;
        return { ok: true };
      },
      stop(ctx) {
        const siege = ctx.playerSovSiege;
        ctx.playerSovSiege = null;
        if (siege && typeof siege.stop === "function") siege.stop();
      },
      onUnavailable(ctx) {
        ctx.playerSovSiege = null;
      },
    },
    {
      name: "capsuleers",
      module: "strategy",
      requires: ["persistence", "scheduler", "fleets", "strategy", "virtualCorps"],
      start(ctx, deps) {
        const startCapsuleers = starters.startCapsuleers || require("../strategy/capsuleers").startCapsuleers;
        const started = startCapsuleers({ config: ctx.config, persistence: ctx.persistence,
          scheduler: ctx.scheduler || null, fleets: ctx.fleets || null, strategy: ctx.strategy || null,
          virtualCorps: ctx.virtualCorps || null, graph: ctx.graph || null, world: ctx.world || null,
          adapter: ctx.adapter || null, views: ctx.views || null, telemetry: ctx.telemetry || null, clock: ctx.clock,
          logger: deps.logger,
          ids: ctx.ids, getLiberation: () => ctx.liberation || null,
          getTreasury: () => ctx.treasury || null,
          getWrecks: () => ctx.wrecks || null, getSalvage: () => ctx.salvage || null,
          getGovernor: () => ctx.governor || null,
          getCrewSummary: (tx, fleetIds) => crewSummaryOf(ctx, tx, fleetIds),
          getHighsecLife: () => ctx.highsecLife || null,
          getFreeCorps: () => ctx.freeCorps || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.capsuleers = started.capsuleers;
        return { ok: true };
      },
      stop(ctx, reason) {
        const capsuleers = ctx.capsuleers;
        ctx.capsuleers = unavailableCapsuleers(starters, "CAPSULEERS_UNAVAILABLE", "stopped");
        if (capsuleers && typeof capsuleers.stop === "function") capsuleers.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.capsuleers = unavailableCapsuleers(starters,
          reason === "disabled_by_config" ? "CAPSULEERS_DISABLED" : "CAPSULEERS_UNAVAILABLE", reason);
      },
    },
    {
      name: "structures",
      module: "structures",
      requires: ["persistence"],
      start(ctx, deps) {
        const startStructures = starters.startStructures || require("../stations/structures").startStructures;
        const started = startStructures({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          views: ctx.views || null, getGovernor: () => ctx.governor || null,
          getStations: () => ctx.stations || null,
          getSiege: () => ctx.siege || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.structures = started.structures;
        return { ok: true };
      },
      stop(ctx, reason) {
        const structures = ctx.structures;
        ctx.structures = unavailableStructures(starters, "STRUCTURES_UNAVAILABLE", "stopped");
        if (structures && typeof structures.stop === "function") structures.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.structures = unavailableStructures(starters,
          reason === "disabled_by_config" ? "STRUCTURES_DISABLED" : "STRUCTURES_UNAVAILABLE", reason);
      },
    },
    {
      name: "sites",
      module: "sites",
      requires: ["persistence"],
      start(ctx, deps) {
        const startSites = starters.startSites || require("../events/sites").startSites;
        const started = startSites({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.sites = started.sites;
        return { ok: true };
      },
      stop(ctx, reason) {
        const sites = ctx.sites;
        ctx.sites = unavailableSites(starters, "SITES_UNAVAILABLE", "stopped");
        if (sites && typeof sites.stop === "function") sites.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.sites = unavailableSites(starters,
          reason === "disabled_by_config" ? "SITES_DISABLED" : "SITES_UNAVAILABLE", reason);
      },
    },
    {
      name: "events",
      module: "events",
      requires: ["persistence", "scheduler"],
      probeGated: false,
      start(ctx, deps) {
        const startEvents = starters.startEvents || require("../events").startEvents;
        const started = startEvents({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          ids: ctx.ids, scheduler: ctx.scheduler || null, adapter: ctx.adapter || null,
          telemetry: ctx.telemetry || null, logger: deps.logger, getWorld: () => ctx.world || null,
          getStrategy: () => ctx.strategy || null, getPresence: () => ctx.presence || null,
          getGraph: () => ctx.graph || null, getSites: () => ctx.sites || null,
          getOccupation: () => ctx.occupation || null,
          getBattleRepository: () => (ctx.battle && ctx.battle.repository) || null,
          getDevIndices: () => ctx.devIndices || null,
          ratFactionsOf: (ids) => (ctx.adapter && typeof ctx.adapter.resolveSystemFactions === "function"
            ? ctx.adapter.resolveSystemFactions(ids) : { ok: false, reason: "NO_ADAPTER" }),
          views: ctx.views || null, getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.events = started.events;
        return { ok: true };
      },
      stop(ctx, reason) {
        const events = ctx.events;
        ctx.events = unavailableEvents(starters, "EVENTS_UNAVAILABLE", "stopped");
        if (events && typeof events.stop === "function") events.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.events = unavailableEvents(starters,
          reason === "disabled_by_config" ? "EVENTS_DISABLED" : "EVENTS_UNAVAILABLE", reason);
      },
    },
    {
      name: "salvageAnomaly",
      module: "sites",
      requires: ["persistence"],
      start(ctx, deps) {
        const startSalvageAnomaly = starters.startSalvageAnomaly || require("../events/salvage").startSalvageAnomaly;
        const started = startSalvageAnomaly({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null, getPresence: () => ctx.presence || null,
          getSites: () => ctx.sites || null, getWrecks: () => ctx.wrecks || null,
          views: ctx.views || null, graph: ctx.graph || null,
          getOfficerSpawns: () => ctx.officerSpawns || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.salvageAnomaly = started.salvageAnomaly;
        return { ok: true };
      },
      stop(ctx, reason) {
        const salvageAnomaly = ctx.salvageAnomaly;
        ctx.salvageAnomaly = unavailableSalvageAnomaly(starters, "SALVAGE_ANOMALY_UNAVAILABLE", "stopped");
        if (salvageAnomaly && typeof salvageAnomaly.stop === "function") salvageAnomaly.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.salvageAnomaly = unavailableSalvageAnomaly(starters,
          reason === "disabled_by_config" ? "SALVAGE_ANOMALY_DISABLED" : "SALVAGE_ANOMALY_UNAVAILABLE", reason);
      },
    },
    {
      name: "eventRewards",
      module: "events",
      requires: ["persistence"],
      start(ctx, deps) {
        const startEventRewards = starters.startEventRewards || require("../events/rewards").startEventRewards;
        const started = startEventRewards({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, getEvents: () => ctx.events || null,
          getSites: () => ctx.sites || null, getAdapter: () => ctx.adapter || null,
          getGovernor: () => ctx.governor || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.eventRewards = started.eventRewards;
        return { ok: true };
      },
      stop(ctx, reason) {
        const eventRewards = ctx.eventRewards;
        ctx.eventRewards = unavailableEventRewards(starters, "EVENT_REWARDS_UNAVAILABLE", "stopped");
        if (eventRewards && typeof eventRewards.stop === "function") eventRewards.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.eventRewards = unavailableEventRewards(starters,
          reason === "disabled_by_config" ? "EVENT_REWARDS_DISABLED" : "EVENT_REWARDS_UNAVAILABLE", reason);
      },
    },
    {
      name: "crews",
      module: "fleets",
      requires: ["persistence", "fleets"],
      start(ctx, deps) {
        const startCrews = starters.startCrews || require("../crews").startCrews;
        const started = startCrews({ config: ctx.config, ctx, clock: ctx.clock, telemetry: ctx.telemetry || null,
          logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.crews = started.crews;
        return { ok: true };
      },
      stop(ctx, reason) {
        const crews = ctx.crews;
        ctx.crews = (starters.createUnavailableCrews || require("../crews").createUnavailableCrews)("stopped");
        if (crews && typeof crews.stop === "function") crews.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.crews = (starters.createUnavailableCrews || require("../crews").createUnavailableCrews)(reason);
      },
    },
    {
      name: "playerHunt",
      module: "fleets",
      requires: ["persistence", "fleets"],
      start(ctx, deps) {
        const startPlayerHunt = starters.startPlayerHunt || require("../playerHunt").startPlayerHunt;
        const started = startPlayerHunt({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          getFleets: () => ctx.fleets || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getOccupation: () => ctx.occupation || null,
          getCrews: () => ctx.crews || null,
          releaseContact: releaseContactOf(ctx) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.playerHunt = started.playerHunt;
        return { ok: true };
      },
      stop(ctx, reason) {
        const playerHunt = ctx.playerHunt;
        ctx.playerHunt = unavailablePlayerHunt(starters, "PLAYER_HUNT_UNAVAILABLE", "stopped");
        if (playerHunt && typeof playerHunt.stop === "function") playerHunt.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.playerHunt = unavailablePlayerHunt(starters,
          reason === "disabled_by_config" ? "PLAYER_HUNT_DISABLED" : "PLAYER_HUNT_UNAVAILABLE", reason);
      },
    },
    {
      name: "fleetExposure",
      module: "fleets",
      requires: ["persistence", "fleets"],
      start(ctx, deps) {
        const startFleetExposure = starters.startFleetExposure || require("../fleetExposure").startFleetExposure;
        const started = startFleetExposure({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          getFleets: () => ctx.fleets || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getCrews: () => ctx.crews || null,
          releaseContact: releaseContactOf(ctx) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.fleetExposure = started.fleetExposure;
        return { ok: true };
      },
      stop(ctx, reason) {
        const fleetExposure = ctx.fleetExposure;
        ctx.fleetExposure = unavailableFleetExposure(starters, "FLEET_EXPOSURE_UNAVAILABLE", "stopped");
        if (fleetExposure && typeof fleetExposure.stop === "function") fleetExposure.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.fleetExposure = unavailableFleetExposure(starters,
          reason === "disabled_by_config" ? "FLEET_EXPOSURE_DISABLED" : "FLEET_EXPOSURE_UNAVAILABLE", reason);
      },
    },
    {
      name: "materialization",
      module: "materialization",
      requires: ["persistence", "battle"],
      start(ctx, deps) {
        const startMaterialization = starters.startMaterialization
          || require("../materialization").startMaterialization;
        const started = startMaterialization({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          views: ctx.views || null, getBattle: () => ctx.battle || null, getPresence: () => ctx.presence || null,
          getGovernor: () => ctx.governor || null,
          getFleets: () => ctx.fleets || null,
          ownerFactionIds: [require("../strategy/data/capsuleers").CAPSULEER_FACTION_ID],
          getPlayerHunt: () => ctx.playerHunt || null,
          getFleetExposure: () => ctx.fleetExposure || null,
          getLogistics: () => ctx.logistics || null,
          getStandings: () => ctx.standings || null,
          getFrontJobs: () => ctx.frontJobs || null,
          getFactionKind: (factionId) => {
            const registry = ctx.strategy && ctx.strategy.registry;
            const faction = registry && typeof registry.getFaction === "function" ? registry.getFaction(factionId)
              : null;
            return faction && typeof faction.kind === "string" ? faction.kind : null;
          },
          huntExcludedFactionIds: [require("../strategy/data/capsuleers").CAPSULEER_FACTION_ID],
          getGraph: () => ctx.graph || null,
          getOccupation: () => ctx.occupation || null,
          getNotices: () => ctx.notices || null,
          getCrews: () => ctx.crews || null,
          getSentries: () => ctx.sentries || null,
          getWorld: () => ctx.world || null,
          isFactionEnemy: (factionId, otherId) => isFactionEnemyOf(ctx, factionId, otherId),
          getOfficerSpawns: () => ctx.officerSpawns || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.materialization = started.materialization;
        return { ok: true };
      },
      stop(ctx, reason) {
        const materialization = ctx.materialization;
        ctx.materialization = unavailableMaterialization(starters, "MATERIALIZATION_UNAVAILABLE", "stopped");
        if (materialization && typeof materialization.stop === "function") materialization.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.materialization = unavailableMaterialization(starters,
          reason === "disabled_by_config" ? "MATERIALIZATION_DISABLED" : "MATERIALIZATION_UNAVAILABLE", reason);
      },
    },
    {
      name: "notices",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startNotices = starters.startNotices || require("../notices").startNotices;
        const started = startNotices({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.notices = started.notices;
        return { ok: true };
      },
      stop(ctx, reason) {
        const notices = ctx.notices;
        ctx.notices = unavailableNotices(starters, "NOTICES_UNAVAILABLE", "stopped");
        if (notices && typeof notices.stop === "function") notices.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.notices = unavailableNotices(starters,
          reason === "disabled_by_config" ? "NOTICES_DISABLED" : "NOTICES_UNAVAILABLE", reason);
      },
    },
    {
      name: "escalations",
      module: "sites",
      requires: ["persistence"],
      start(ctx, deps) {
        const startEscalations = starters.startEscalations || require("../escalations").startEscalations;
        const started = startEscalations({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null, getSites: () => ctx.sites || null,
          getNotices: () => ctx.notices || null, getPresence: () => ctx.presence || null,
          getGraph: () => ctx.graph || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.escalations = started.escalations;
        return { ok: true };
      },
      stop(ctx, reason) {
        const escalations = ctx.escalations;
        ctx.escalations = require("../escalations").createUnavailableEscalations("ESCALATIONS_UNAVAILABLE", "stopped");
        if (escalations && typeof escalations.stop === "function") escalations.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.escalations = require("../escalations").createUnavailableEscalations(
          reason === "disabled_by_config" ? "ESCALATIONS_DISABLED" : "ESCALATIONS_UNAVAILABLE", reason);
      },
    },
    {
      name: "frontJobs",
      module: "world",
      requires: ["persistence", "world", "occupation"],
      start(ctx, deps) {
        const startFrontJobs = starters.startFrontJobs || require("../frontJobs").startFrontJobs;
        const started = startFrontJobs({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.frontJobs = started.frontJobs;
        return { ok: true };
      },
      stop(ctx, reason) {
        const frontJobs = ctx.frontJobs;
        ctx.frontJobs = require("../frontJobs").createUnavailableFrontJobs("FRONT_JOBS_UNAVAILABLE", "stopped");
        if (frontJobs && typeof frontJobs.stop === "function") frontJobs.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.frontJobs = require("../frontJobs").createUnavailableFrontJobs(
          reason === "disabled_by_config" ? "FRONT_JOBS_DISABLED" : "FRONT_JOBS_UNAVAILABLE", reason);
      },
    },
    {
      name: "battleAnnounce",
      module: "world",
      requires: ["persistence", "scheduler", "fleets", "notices"],
      start(ctx, deps) {
        const startBattleAnnounce = starters.startBattleAnnounce || require("../battleAnnounce").startBattleAnnounce;
        const started = startBattleAnnounce({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.battleAnnounce = started.battleAnnounce;
        return { ok: true };
      },
      stop(ctx, reason) {
        const battleAnnounce = ctx.battleAnnounce;
        ctx.battleAnnounce = require("../battleAnnounce").createUnavailableBattleAnnounce("BATTLE_ANNOUNCE_UNAVAILABLE",
          "stopped");
        if (battleAnnounce && typeof battleAnnounce.stop === "function") battleAnnounce.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.battleAnnounce = require("../battleAnnounce").createUnavailableBattleAnnounce(
          reason === "disabled_by_config" ? "BATTLE_ANNOUNCE_DISABLED" : "BATTLE_ANNOUNCE_UNAVAILABLE", reason);
      },
    },
    {
      name: "warContracts",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startWarContracts = starters.startWarContracts || require("../warContracts").startWarContracts;
        const started = startWarContracts({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.warContracts = started.warContracts;
        return { ok: true };
      },
      stop(ctx, reason) {
        const warContracts = ctx.warContracts;
        ctx.warContracts = require("../warContracts").createUnavailableWarContracts("WAR_CONTRACTS_UNAVAILABLE",
          "stopped");
        if (warContracts && typeof warContracts.stop === "function") warContracts.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.warContracts = require("../warContracts").createUnavailableWarContracts(
          reason === "disabled_by_config" ? "WAR_CONTRACTS_DISABLED" : "WAR_CONTRACTS_UNAVAILABLE", reason);
      },
    },
    {
      name: "frontChat",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startFrontChat = starters.startFrontChat || require("../frontChat").startFrontChat;
        const started = startFrontChat({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, liveConfig: ctx.liveConfig || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.frontChat = started.frontChat;
        return { ok: true };
      },
      stop(ctx, reason) {
        const frontChat = ctx.frontChat;
        ctx.frontChat = null;
        if (frontChat && typeof frontChat.stop === "function") frontChat.stop(reason);
      },
      onUnavailable(ctx) {
        ctx.frontChat = null;
      },
    },
    {
      name: "jobBoard",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startJobBoard = starters.startJobBoard || require("../jobBoard").startJobBoard;
        const started = startJobBoard({ config: ctx.config, ctx, adapter: ctx.adapter || null,
          world: ctx.bootWorld || null, clock: ctx.clock, telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.jobBoard = started.jobBoard;
        return { ok: true };
      },
      stop(ctx, reason) {
        const jobBoard = ctx.jobBoard;
        ctx.jobBoard = require("../jobBoard").createUnavailableJobBoard("JOB_BOARD_UNAVAILABLE", "stopped");
        if (jobBoard && typeof jobBoard.stop === "function") jobBoard.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.jobBoard = require("../jobBoard").createUnavailableJobBoard(
          reason === "disabled_by_config" ? "JOB_BOARD_DISABLED" : "JOB_BOARD_UNAVAILABLE", reason);
      },
    },
    {
      name: "modsHelp",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startModsHelp = starters.startModsHelp || require("../modsHelp").startModsHelp;
        const started = startModsHelp({ config: ctx.config, adapter: ctx.adapter || null, clock: ctx.clock,
          logger: deps.logger, liveConfig: ctx.liveConfig || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.modsHelp = started.modsHelp;
        return { ok: true };
      },
      stop(ctx, reason) {
        const modsHelp = ctx.modsHelp;
        ctx.modsHelp = null;
        if (modsHelp && typeof modsHelp.stop === "function") modsHelp.stop(reason);
      },
      onUnavailable(ctx) {
        ctx.modsHelp = null;
      },
    },
    {
      name: "inGameMap",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startInGameMap = starters.startInGameMap || require("../inGameMap").startInGameMap;
        const started = startInGameMap({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, liveConfig: ctx.liveConfig || null,
          world: ctx.bootWorld || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.inGameMap = started.inGameMap;
        return { ok: true };
      },
      stop(ctx, reason) {
        const inGameMap = ctx.inGameMap;
        ctx.inGameMap = null;
        if (inGameMap && typeof inGameMap.stop === "function") inGameMap.stop(reason);
      },
      onUnavailable(ctx) {
        ctx.inGameMap = null;
      },
    },
    {
      name: "playerValue",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startPlayerValue = starters.startPlayerValue || require("../world/playerValue").startPlayerValue;
        const started = startPlayerValue({ config: ctx.config, adapter: ctx.adapter || null, clock: ctx.clock,
          getSentries: () => ctx.sentries || null, getVirtualCorps: () => ctx.virtualCorps || null,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.playerValue = started.playerValue;
        return { ok: true };
      },
      stop(ctx) {
        const playerValue = ctx.playerValue;
        ctx.playerValue = null;
        if (playerValue && typeof playerValue.stop === "function") playerValue.stop();
      },
      onUnavailable(ctx) {
        ctx.playerValue = null;
      },
    },
    {
      name: "modSettings",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startModSettings = starters.startModSettings || require("../modSettings").startModSettings;
        const started = startModSettings({ config: ctx.config, adapter: ctx.adapter || null, modDir: ctx.modDir,
          logger: deps.logger, clock: ctx.clock || null, telemetry: ctx.telemetry || null,
          httpRoutes: ctx.httpRoutes || null, liveConfig: ctx.liveConfig || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.modSettings = started.modSettings;
        return { ok: true };
      },
      stop(ctx, reason) {
        const modSettings = ctx.modSettings;
        ctx.modSettings = null;
        if (modSettings && typeof modSettings.stop === "function") modSettings.stop(reason);
      },
      onUnavailable(ctx) {
        ctx.modSettings = null;
      },
    },
    {
      name: "loyalty",
      module: "world",
      requires: ["world"],
      start(ctx, deps) {
        const startLoyalty = starters.startLoyalty || require("../loyalty").startLoyalty;
        const started = startLoyalty({ config: ctx.config, ctx, adapter: ctx.adapter || null,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.loyalty = started.loyalty;
        return { ok: true };
      },
      stop(ctx, reason) {
        const loyalty = ctx.loyalty;
        ctx.loyalty = require("../loyalty").createUnavailableLoyalty("stopped");
        if (loyalty && typeof loyalty.stop === "function") loyalty.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.loyalty = require("../loyalty").createUnavailableLoyalty(reason);
      },
    },
    {
      name: "fame",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startFame = starters.startFame || require("../fame").startFame;
        const adapterFn = (name, fallback) => (...args) => (ctx.adapter && typeof ctx.adapter[name] === "function"
          ? ctx.adapter[name](...args) : fallback);
        const started = startFame({ config: ctx.config, clock: ctx.clock, persistence: ctx.persistence,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          readStanding: adapterFn("readCharacterStanding", { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          readFactionNames: adapterFn("readFactionNames", { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          getPresence: () => ctx.presence || null,
          getRegistry: () => (ctx.strategy && ctx.strategy.registry) || null,
          getGovernor: () => ctx.governor || null, getNotices: () => ctx.notices || null,
          setMarketSlot: adapterFn("setFameMarketSlot", { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          getMarketStatus: adapterFn("getFameMarketStatus", null),
          getBounty: () => ctx.bounty || null, getGraph: () => ctx.graph || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.fame = started.fame;
        return { ok: true };
      },
      stop(ctx, reason) {
        const fame = ctx.fame;
        ctx.fame = require("../fame").createUnavailableFame("stopped");
        if (fame && typeof fame.stop === "function") fame.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.fame = require("../fame").createUnavailableFame(reason);
      },
    },
    {
      name: "trigBridge",
      module: null,
      requires: ["telemetry"],
      start(ctx, deps) {
        const startTrigBridge = starters.startTrigBridge || require("../trigBridge").startTrigBridge;
        const started = startTrigBridge({ config: ctx.config, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, persistence: ctx.persistence || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.trigBridge = started.trigBridge;
        return { ok: true };
      },
      stop(ctx, reason) {
        const trigBridge = ctx.trigBridge;
        ctx.trigBridge = require("../trigBridge").createUnavailableTrigBridge("stopped");
        if (trigBridge && typeof trigBridge.stop === "function") trigBridge.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.trigBridge = require("../trigBridge").createUnavailableTrigBridge(reason);
      },
    },
    {
      name: "npcVoices",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startNpcVoices = starters.startNpcVoices || require("../npcVoices").startNpcVoices;
        const started = startNpcVoices({ config: ctx.config, clock: ctx.clock, logger: deps.logger,
          worldSeed: ctx.persistence ? ctx.persistence.worldSeed : undefined, telemetry: ctx.telemetry || null,
          adapter: ctx.adapter || null, getChatterAi: () => ctx.chatterAi || null,
          getPresence: () => ctx.presence || null, getGraph: () => ctx.graph || null,
          getFame: () => ctx.fame || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.npcVoices = started.npcVoices;
        return { ok: true };
      },
      stop(ctx, reason) {
        const npcVoices = ctx.npcVoices;
        ctx.npcVoices = require("../npcVoices").createUnavailableNpcVoices("stopped");
        if (npcVoices && typeof npcVoices.stop === "function") npcVoices.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.npcVoices = require("../npcVoices").createUnavailableNpcVoices(reason);
      },
    },
    {
      name: "bountyHunters",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startBounty = starters.startBounty || require("../bounty").startBounty;
        const VC_DATA = require("../strategy/data/virtualCorps");
        const { FACTIONS_V1 } = require("../strategy/data/factions");
        const homeStationOf = (factionId) => {
          const f = FACTIONS_V1.find((x) => x.factionId === factionId);
          if (!f) return null;
          const npc = (f.startStations || []).find((s) => s.kind === "npc" && s.stationId > 0 && s.systemId > 0);
          if (npc) return { stationId: npc.stationId, corporationId: npc.corporationId || null, systemId: npc.systemId };
          const listed = ctx.adapter && typeof ctx.adapter.listNpcStationsInSystem === "function"
            ? ctx.adapter.listNpcStationsInSystem(f.hqSystemId) : null;
          const first = listed && listed.ok === true && Array.isArray(listed.stations) ? listed.stations[0] : null;
          return first ? { stationId: first.stationId, corporationId: first.corporationId, systemId: f.hqSystemId }
            : null;
        };
        const started = startBounty({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          getGraph: () => ctx.graph || null, getVirtualCorps: () => ctx.virtualCorps || null, homeStationOf,
          bloodlinesOf: (factionId) => {
            const f = VC_DATA.getById(factionId);
            return f && Array.isArray(f.bloodlineIds) ? f.bloodlineIds : null;
          },
          excludedRegionIds: require("../strategy/data/expansion").EXPANSION_EXCLUDED_REGION_IDS,
          systemFactionsOf: (ids) => (ctx.adapter && typeof ctx.adapter.resolveSystemFactions === "function"
            ? ctx.adapter.resolveSystemFactions(ids) : { ok: false, reason: "NO_ADAPTER" }),
          getPresence: () => ctx.presence || null,
          getBountyScene: () => {
            const r = ctx.adapter && typeof ctx.adapter.getBountyScene === "function" ? ctx.adapter.getBountyScene()
              : null;
            return r && r.ok === true ? r.seam : null;
          },
          onResidentsChanged: () => {
            const lp = ctx.localPilots;
            if (lp && typeof lp.nudge === "function") lp.nudge();
          },
          characterNameOf: (characterId) => {
            const r = ctx.adapter && typeof ctx.adapter.readCharacterNames === "function"
              ? ctx.adapter.readCharacterNames([characterId]) : null;
            return r && r.ok === true && r.names instanceof Map ? r.names.get(characterId) || null : null;
          },
          admitScene: (systemId, n, source) => (ctx.adapter && typeof ctx.adapter.admitSceneNpc === "function"
            ? ctx.adapter.admitSceneNpc(systemId, n, source) : { ok: true, count: null, cap: null }),
          rewardCreditIsk: (spec) => (ctx.adapter && typeof ctx.adapter.rewardCreditIsk === "function"
            ? ctx.adapter.rewardCreditIsk(spec)
            : Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false })),
          sendCharacterSystemLine: (spec) => (ctx.adapter && typeof ctx.adapter.sendCharacterSystemLine === "function"
            ? ctx.adapter.sendCharacterSystemLine(spec) : { ok: false, reason: "SEAM_UNAVAILABLE" }),
          rollOfficerLoot: (factionId, seed) => (ctx.adapter && typeof ctx.adapter.rollFactionOfficerLoot === "function"
            ? ctx.adapter.rollFactionOfficerLoot(factionId, seed) : { ok: false, reason: "SEAM_UNAVAILABLE" }),
          getHuntScene: () => (ctx.adapter && typeof ctx.adapter.getHuntScene === "function"
            ? ctx.adapter.getHuntScene() : null),
          getHuntParams: () => ctx.config.playerHunt || null,
          createNemesisStep: ctx.config.nemesis && ctx.config.nemesis.enabled === true
            ? require("../nemesis").createNemesisStep : null,
          typesKnown: (typeIds) => (ctx.adapter && typeof ctx.adapter.readItemTypeFacts === "function"
            ? ctx.adapter.readItemTypeFacts(typeIds) : { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" }),
          ewarProfilesOf: (factionId, hullClass, family) => (ctx.adapter
            && typeof ctx.adapter.ewarProfilesOf === "function"
            ? ctx.adapter.ewarProfilesOf(factionId, hullClass, family) : { ok: false, reason: "SEAM_UNAVAILABLE" }),
          getNotices: () => ctx.notices || null,
          getChatterAi: () => ctx.chatterAi || null,
          readFactionNames: () => (ctx.adapter && typeof ctx.adapter.readFactionNames === "function"
            ? ctx.adapter.readFactionNames() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          fameHighsec: fameHighsecOf(ctx.config.fame),
          getConcord: () => ctx.adapter || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.bounty = started.bounty;
        return { ok: true };
      },
      stop(ctx, reason) {
        const bounty = ctx.bounty;
        ctx.bounty = require("../bounty").createUnavailableBounty("BOUNTY_UNAVAILABLE", "stopped");
        if (bounty && typeof bounty.stop === "function") bounty.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.bounty = require("../bounty").createUnavailableBounty(
          reason === "disabled_by_config" ? "BOUNTY_DISABLED" : "BOUNTY_UNAVAILABLE", reason);
      },
    },
    {
      name: "localPilots",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startLocalPilots = starters.startLocalPilots || require("../localPilots").startLocalPilots;
        const started = startLocalPilots({ config: ctx.config, ctx, clock: ctx.clock, telemetry: ctx.telemetry || null,
          logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.localPilots = started.localPilots;
        return { ok: true };
      },
      stop(ctx, reason) {
        const localPilots = ctx.localPilots;
        ctx.localPilots = null;
        if (localPilots && typeof localPilots.stop === "function") localPilots.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.localPilots = (starters.createUnavailableLocalPilots
          || require("../localPilots").createUnavailableLocalPilots)(reason);
      },
    },
    {
      name: "chatterAi",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const startChatterAi = starters.startChatterAi || require("../chatterAi").startChatterAi;
        const config = ctx.config || {};
        let buckets = [];
        if (config.chatterAi && config.chatterAi.enabled === true) {
          const settings = require("../chatterAi/schema").chatterAiSettingsOf(config);
          const H = config.highsecLife;
          const F = config.freeCorps;
          const civilianOn = Boolean(H && H.enabled === true && H.civilians && H.civilians.enabled === true
            && H.chatter && H.chatter.enabled === true);
          const residentOn = civilianOn && Boolean(F && F.enabled === true && F.chatter && F.chatter.enabled === true);
          const voiceOn = Boolean(config.npcVoices && config.npcVoices.enabled === true);
          const fameLocalOn = Boolean(config.fame && config.fame.enabled === true && config.fame.localEnabled === true);
          if (settings.ok && (civilianOn || voiceOn)) {
            const built = require("../chatterAi/buckets").buildBucketSpecs({
              civilian: civilianOn ? { ...require("../highsecLife/data/chatterLines"),
                PLACEHOLDERS: require("../highsecLife/chatter").PLACEHOLDERS } : null,
              resident: residentOn ? require("../freeCorps/data/chatterLines") : null,
              ...(voiceOn ? { voice: require("../npcVoices/lines").voiceBucketEntries({ fame: fameLocalOn }) } : {}),
            }, settings.settings);
            if (!built.ok && built.reason === "BAD_CATALOGUE") {
              return { ok: false, reason: "CHATTER_AI_BAD_CATALOGUE", detail: built.detail };
            }
            if (built.ok) buckets = built.buckets;
          }
        }
        const NV = config.npcVoices;
        const ARC = config.archaeology;
        const talkEnabled = Boolean(NV && NV.enabled === true && NV.talk && NV.talk.enabled === true)
          || Boolean(ARC && ARC.enabled === true && ARC.loreAiEnabled === true);
        const newsEnabled = Boolean(config.news && config.news.enabled === true && config.news.aiEnabled === true);
        const GM = config.gameMaster;
        const plotEnabled = Boolean(GM && GM.enabled === true && GM.aiEnabled === true);
        const started = startChatterAi({ config, clock: ctx.clock, logger: deps.logger,
          telemetry: ctx.telemetry || null, getGovernor: () => ctx.governor || null, buckets, talkEnabled,
          newsEnabled, plotEnabled, transport: require("../chatterAi/transport").createDefaultChatTransport() });
        if (!started || !started.ok) return refusalOf(started);
        ctx.chatterAi = started.chatterAi;
        return { ok: true };
      },
      stop(ctx, reason) {
        const chatterAi = ctx.chatterAi;
        ctx.chatterAi = require("../chatterAi").createUnavailableChatterAi("stopped");
        if (chatterAi && typeof chatterAi.stop === "function") chatterAi.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.chatterAi = require("../chatterAi").createUnavailableChatterAi(reason);
      },
    },
    {
      name: "news",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startNews = starters.startNews || require("../news").startNews;
        const started = startNews({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.news = started.news;
        return { ok: true };
      },
      stop(ctx, reason) {
        const news = ctx.news;
        ctx.news = unavailableNews(starters, "NEWS_UNAVAILABLE", "stopped");
        if (news && typeof news.stop === "function") news.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.news = unavailableNews(starters, reason === "disabled_by_config" ? "NEWS_DISABLED" : "NEWS_UNAVAILABLE",
          reason);
      },
    },
    {
      name: "highsecLife",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startHighsecLife = starters.startHighsecLife || require("../highsecLife").startHighsecLife;
        const VC_DATA = require("../strategy/data/virtualCorps");
        const started = startHighsecLife({ config: ctx.config, clock: ctx.clock, logger: deps.logger,
          worldSeed: ctx.persistence ? ctx.persistence.worldSeed : undefined,
          getGraph: () => ctx.graph || null, getVirtualCorps: () => ctx.virtualCorps || null,
          listStations: (systemId) => (ctx.adapter && typeof ctx.adapter.listNpcStationsInSystem === "function"
            ? ctx.adapter.listNpcStationsInSystem(systemId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          bloodlinesOf: (factionId) => {
            const f = VC_DATA.getById(factionId);
            return f && Array.isArray(f.bloodlineIds) ? f.bloodlineIds : null;
          },
          telemetry: ctx.telemetry || null, getNotices: () => ctx.notices || null,
          getBattle: () => ctx.battle || null, getGovernor: () => ctx.governor || null,
          sendOccupantMessage: (spec) => {
            const seams = ctx.adapter && typeof ctx.adapter.localPilotsSeams === "function"
              ? ctx.adapter.localPilotsSeams() : null;
            const seam = seams && seams.ok === true ? seams.seam : null;
            return seam && typeof seam.sendOccupantMessage === "function" ? seam.sendOccupantMessage(spec)
              : { ok: false, reason: "NOT_INSTALLED" };
          },
          getPresence: () => ctx.presence || null,
          getTrafficScene: () => (ctx.adapter && typeof ctx.adapter.getHighsecTrafficScene === "function"
            ? ctx.adapter.getHighsecTrafficScene() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          trafficProfiles: require("../adapter/data/trafficProfiles").TRAFFIC_HAULER_PROFILES,
          civilianHulls: require("../adapter/data/civilianLiveProfiles"),
          getWrecks: () => ctx.wrecks || null,
          resolveEmpireFaction: (graph, systemId) => require("../ambientRats/highsecFaction").resolveEmpireFaction(
            graph, systemId, require("../ambientRats/schema").HIGHSEC_EXCLUDED_FACTION_IDS),
          getFreeCorps: () => ctx.freeCorps || null,
          freeCorpsChatter: require("../freeCorps/chatter"),
          getChatterAi: () => ctx.chatterAi || null,
          getLocalPilots: () => ctx.localPilots || null,
          readCharacterNames: (ids) => (ctx.adapter && typeof ctx.adapter.readCharacterNames === "function"
            ? ctx.adapter.readCharacterNames(ids) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          getPopulation: () => ctx.population || null,
          readTypeLooks: (ids) => (ctx.adapter && typeof ctx.adapter.readTypeLooks === "function"
            ? ctx.adapter.readTypeLooks(ids) : { ok: false, reason: "ITEM_TYPES_UNAVAILABLE" }),
          populationSpawnBackoff: require("../materialization/spawnBackoff").createSpawnBackoff(
            ctx.config.materialization && ctx.config.materialization.spawnBackoff),
          spawnFailureReasonOf: require("../materialization/spawnBackoff").failureReasonOf,
          isLiveBattleShip: (entityId) => {
            const m = ctx.materialization;
            const side = m && typeof m.liveSideOf === "function" ? m.liveSideOf(entityId) : null;
            return Boolean(side && side.ok === true);
          } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.highsecLife = started.highsecLife;
        return { ok: true };
      },
      stop(ctx, reason) {
        const highsecLife = ctx.highsecLife;
        ctx.highsecLife = null;
        if (highsecLife && typeof highsecLife.stop === "function") highsecLife.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.highsecLife = require("../highsecLife").createUnavailableHighsecLife(reason);
      },
    },
    {
      name: "situations",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startSituations = starters.startSituations || require("../situations").startSituations;
        const config = ctx.config || {};
        const adapterFn = (name, fallback) => (...args) => (ctx.adapter && typeof ctx.adapter[name] === "function"
          ? ctx.adapter[name](...args) : fallback);
        const hsl = config.highsecLife || {};
        const traffic = hsl.traffic || {};
        const civilianRows = hsl.enabled === true && hsl.civilianHullsEnabled === true;
        const civData = require("../adapter/data/civilianLiveProfiles");
        const byRole = civilianRows ? require("../highsecLife/traffic/plan").civilianProfilesByRole(civData) : null;
        const victimProfiles = byRole ? byRole.MINER.map((p) => p.profileId) : [];
        const haulerProfiles = byRole ? byRole.HAULER.map((p) => p.profileId) : [];
        const podHull = civilianRows ? civData.CIVILIAN_HULLS.find((h) => h.roles.includes("POD")) : null;
        const podProfileId = podHull ? civData.civilianProfileId(podHull.key) : null;
        const started = startSituations({ config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          getScene: () => {
            const r = ctx.adapter && typeof ctx.adapter.getSituationScene === "function"
              ? ctx.adapter.getSituationScene() : null;
            return r && r.ok === true ? r.seam : null;
          },
          getPresence: () => ctx.presence || null,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          },
          getGovernor: () => ctx.governor || null,
          speakersOf: (systemId) => (ctx.localPilots && typeof ctx.localPilots.speakersOf === "function"
            ? ctx.localPilots.speakersOf(systemId) : { ok: false, reason: "NOT_RUNNING" }),
          trafficShipsIn: (systemId) => (ctx.highsecLife && typeof ctx.highsecLife.trafficShipsIn === "function"
            ? ctx.highsecLife.trafficShipsIn(systemId) : 0),
          readCharacterNames: adapterFn("readCharacterNames", { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          resolveSystemFactions: adapterFn("resolveSystemFactions", { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          resolveProfiles: (requests, options) => {
            const spawn = ctx.adapter && typeof ctx.adapter.getNpcSpawn === "function" ? ctx.adapter.getNpcSpawn()
              : null;
            return spawn && typeof spawn.resolveProfiles === "function" ? spawn.resolveProfiles(requests, options)
              : { ok: false, reason: "SEAM_UNAVAILABLE" };
          },
          admitScene: (systemId, n, source) => (ctx.adapter && typeof ctx.adapter.admitSceneNpc === "function"
            ? ctx.adapter.admitSceneNpc(systemId, n, source) : { ok: true, count: null, cap: null }),
          sendOccupantMessage: (spec) => {
            const seams = ctx.adapter && typeof ctx.adapter.localPilotsSeams === "function"
              ? ctx.adapter.localPilotsSeams() : null;
            const seam = seams && seams.ok === true ? seams.seam : null;
            return seam && typeof seam.sendOccupantMessage === "function" ? seam.sendOccupantMessage(spec)
              : { ok: false, reason: "NOT_INSTALLED" };
          },
          victimProfiles,
          haulerProfiles,
          podProfileId,
          leave: { despawnMs: Number(traffic.dockDelayMs) || 0, maxMs: Number(traffic.maxLifetimeMs) || 0 },
          rewardCreditIsk: (spec) => (ctx.adapter && typeof ctx.adapter.rewardCreditIsk === "function"
            ? ctx.adapter.rewardCreditIsk(spec)
            : Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false })),
          applyStandingGrant: adapterFn("applyStandingGrant", { ok: false, reason: "SEAM_UNAVAILABLE" }),
          views: ctx.views || null,
          onRumour: (e) => (ctx.highsecLife && typeof ctx.highsecLife.onSituationRumour === "function"
            ? ctx.highsecLife.onSituationRumour(e) === true : false) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.situations = started.situations;
        return { ok: true };
      },
      stop(ctx, reason) {
        const situations = ctx.situations;
        const sitCfg = (ctx.config && ctx.config.situations) || {};
        ctx.situations = require("../situations").createUnavailableSituations("SITUATIONS_UNAVAILABLE", "stopped",
          { boardEnabled: sitCfg.boardEnabled === true });
        if (situations && typeof situations.stop === "function") situations.stop(reason);
      },
      onUnavailable(ctx, reason) {
        const sitCfg = (ctx.config && ctx.config.situations) || {};
        ctx.situations = require("../situations").createUnavailableSituations(
          reason === "disabled_by_config" ? "SITUATIONS_DISABLED" : "SITUATIONS_UNAVAILABLE", reason,
          { boardEnabled: sitCfg.boardEnabled === true });
      },
    },
    {
      name: "freeCorps",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startFreeCorps = starters.startFreeCorps || require("../freeCorps").startFreeCorps;
        const VC_DATA = require("../strategy/data/virtualCorps");
        const CAP_DATA = require("../strategy/data/capsuleers");
        let reserved = null;
        let contractGoodsMemo = null;
        const reservedNames = () => {
          if (reserved) return reserved;
          const { nameKey } = require("../freeCorps/names");
          const names = new Set();
          const tickers = new Set();
          const add = (entry) => {
            if (!entry) return;
            if (typeof entry.name === "string" && entry.name) names.add(nameKey(entry.name));
            if (typeof entry.ticker === "string" && entry.ticker) tickers.add(entry.ticker);
          };
          for (const f of VC_DATA.getFactions() || []) {
            add(f.alliance);
            for (const c of f.corporations || []) add(c);
          }
          const { corpNameOf } = require("../strategy/capsuleers/capsuleerRules");
          for (let s = 1; s <= CAP_DATA.MAX_SLOTS; s += 1) add(corpNameOf(s));
          for (const c of require("../highsecLife/data/civilianCorps").CIVILIAN_CORPS) add(c);
          reserved = Object.freeze({ names, tickers });
          return reserved;
        };
        const started = startFreeCorps({ config: ctx.config, clock: ctx.clock, logger: deps.logger,
          telemetry: ctx.telemetry || null, persistence: ctx.persistence, views: ctx.views || null,
          getGraph: () => (ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null),
          getVirtualCorps: () => ctx.virtualCorps || null, getGovernor: () => ctx.governor || null,
          listStations: (systemId) => (ctx.adapter && typeof ctx.adapter.listNpcStationsInSystem === "function"
            ? ctx.adapter.listNpcStationsInSystem(systemId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          bloodlinesOf: (factionId) => {
            const f = VC_DATA.getById(factionId);
            return f && Array.isArray(f.bloodlineIds) ? f.bloodlineIds : null;
          },
          raceSourceFactionIds: CAP_DATA.RACE_SOURCE_FACTION_IDS,
          excludedRegionIds: require("../strategy/data/expansion").EXPANSION_EXCLUDED_REGION_IDS,
          reservedNames,
          bfs: require("../strategy/ai/bfs").bfs,
          readSystemBelts: (systemIds) => (ctx.adapter && typeof ctx.adapter.readSystemBelts === "function"
            ? ctx.adapter.readSystemBelts(systemIds) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          getPresence: () => ctx.presence || null,
          getWormholes: () => ctx.wormholes || null,
          writeVirtualKillmail: (spec, eventId) => (ctx.adapter && typeof ctx.adapter.writeVirtualKillmail === "function"
            ? ctx.adapter.writeVirtualKillmail(spec, eventId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          virtualKillmailSeams: () => (ctx.adapter && typeof ctx.adapter.virtualKillmailSeams === "function"
            ? ctx.adapter.virtualKillmailSeams() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          hullEhpOf: (typeId) => {
            const t = require("../battle/data/strengthCatalog").TYPES[typeId];
            return t ? t.ehp : null;
          },
          contractGoods: () => {
            if (contractGoodsMemo === null) {
              const IC = require("../economy/data/industryCatalog");
              const MP = require("../economy/data/mineralRefPrices");
              const HT = require("../economy/data/hullTradeTypes");
              const FC = ctx.config.freeCorps || {};
              const whCt = FC.whCorps && FC.whCorps.contracts;
              const gas = whCt && whCt.enabled === true
                ? { gasTypes: require("../freeCorps/data/whGoods").WH_GAS_TYPES } : {};
              contractGoodsMemo = require("../freeCorps/contractGoods").buildContractGoods({ oreBands: IC.ORE_BANDS,
                oreTypes: require("../economy/data/oreTypes").ORE_TYPES, refPriceMilli: MP.REF_PRICE_MILLI,
                hullValueFactorPermille: MP.HULL_VALUE_FACTOR_PERMILLE,
                hullGroups: require("../economy/data/hullRecipes").GROUPS, hullRaces: HT.RACES,
                factionRace: HT.FACTION_RACE, hullGroupKeys: ["frigate", "destroyer"], ...gas });
            }
            return contractGoodsMemo;
          },
          contractAdapter: () => ctx.adapter || null,
          freeCorpsContractSeams: () => (ctx.adapter && typeof ctx.adapter.freeCorpsContractSeams === "function"
            ? ctx.adapter.freeCorpsContractSeams() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          freeCorpsCourierSeams: () => (ctx.adapter && typeof ctx.adapter.freeCorpsCourierSeams === "function"
            ? ctx.adapter.freeCorpsCourierSeams() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          addContractAcceptedListener: (spec) => (ctx.adapter
            && typeof ctx.adapter.addContractAcceptedListener === "function"
            ? ctx.adapter.addContractAcceptedListener(spec) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          moveFreeCharacter: (spec) => (ctx.adapter && typeof ctx.adapter.moveFreeCharacter === "function"
            ? ctx.adapter.moveFreeCharacter(spec) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          setCorporationDescription: (id, text) => (ctx.adapter
            && typeof ctx.adapter.setCorporationDescription === "function"
            ? ctx.adapter.setCorporationDescription(id, text) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          freeCorpRecycleSeams: () => (ctx.adapter && typeof ctx.adapter.freeCorpRecycleSeams === "function"
            ? ctx.adapter.freeCorpRecycleSeams() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          freeCorpStructureSeams: () => (ctx.adapter && typeof ctx.adapter.freeCorpStructureSeams === "function"
            ? ctx.adapter.freeCorpStructureSeams() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          structureKit: Object.freeze({ placementCandidates: require("../stations/structures/projection")
            .placementCandidates, CONDITION_FULL: require("../stations/structures/schema").CONDITION_FULL,
          CONDITION_ARMOR_STAGE: require("../stations/structures/schema").CONDITION_ARMOR_STAGE }),
          systemBlockedInTx: (tx, systemId) => {
            const w = ctx.world && ctx.world.repository;
            const st = ctx.stations && ctx.stations.repository;
            if (!w || typeof w.getSystem !== "function" || !st || typeof st.countLiveBySystem !== "function") {
              return { ok: false, reason: "WORLD_UNAVAILABLE" };
            }
            const s = w.getSystem(tx, systemId, { includeInfluence: false });
            if (!s || !s.ok) return { ok: false, reason: (s && s.reason) || "WORLD_READ" };
            const controller = s.system ? s.system.controllerFactionId : null;
            if (controller !== null && controller !== undefined) return { ok: true, blocked: "SOV" };
            const c = st.countLiveBySystem(tx, [systemId]);
            if (!c || !c.ok) return { ok: false, reason: (c && c.reason) || "STATIONS_READ" };
            return { ok: true, blocked: c.rows.some((r) => r.count > 0) ? "STATION" : null };
          } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.freeCorps = started.freeCorps;
        return { ok: true };
      },
      stop(ctx, reason) {
        const freeCorps = ctx.freeCorps;
        ctx.freeCorps = require("../freeCorps").createUnavailableFreeCorps("stopped");
        if (freeCorps && typeof freeCorps.stop === "function") freeCorps.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.freeCorps = require("../freeCorps").createUnavailableFreeCorps(reason);
      },
    },
    {
      name: "miningEncounters",
      module: "world",
      requires: [],
      start(ctx, deps) {
        const tools = ctx.adapter && typeof ctx.adapter.getMiningEncounterTools === "function"
          ? ctx.adapter.getMiningEncounterTools() : { ok: false, reason: "SEAM_UNAVAILABLE" };
        const startMiningEncounters = starters.startMiningEncounters
          || require("../miningEncounters").startMiningEncounters;
        const started = startMiningEncounters({ config: ctx.config, clock: ctx.clock, telemetry: ctx.telemetry || null,
          logger: deps.logger, getGovernor: () => ctx.governor || null, seam: tools.ok ? tools.seam : null,
          getEvents: () => ctx.events || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.miningEncounters = started.encounters;
        return { ok: true };
      },
      stop(ctx, reason) {
        const encounters = ctx.miningEncounters;
        ctx.miningEncounters = null;
        if (encounters && typeof encounters.stop === "function") encounters.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.miningEncounters = require("../miningEncounters").createUnavailableMiningEncounters(reason);
      },
    },
    {
      name: "ambientRats",
      module: "world",
      requires: ["world"],
      start(ctx, deps) {
        const startAmbientRats = starters.startAmbientRats || require("../ambientRats").startAmbientRats;
        const { PIRATE_KEY_BY_FACTION_ID } = require("../adapter/data/liveProfiles");
        const { NAVY_PROFILES_BY_FACTION_ID } = require("../adapter/empireNavyCatalog");
        const started = startAmbientRats({ config: ctx.config, clock: ctx.clock, telemetry: ctx.telemetry || null,
          logger: deps.logger, adapter: ctx.adapter || null, getGovernor: () => ctx.governor || null,
          getPresence: () => ctx.presence || null, getWorld: () => ctx.world || null,
          getFactionKind: (factionId) => factionKindOf(ctx, factionId),
          getGraph: () => ctx.graph || null,
          getTransit: () => ctx.transit || null,
          tables: { pirateKeyByFactionId: PIRATE_KEY_BY_FACTION_ID,
            navyFactionIds: Object.keys(NAVY_PROFILES_BY_FACTION_ID).map(Number) } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.ambientRats = started.ambientRats;
        return { ok: true };
      },
      stop(ctx, reason) {
        const ambientRats = ctx.ambientRats;
        ctx.ambientRats = null;
        if (ambientRats && typeof ambientRats.stop === "function") ambientRats.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.ambientRats = require("../ambientRats").createUnavailableAmbientRats(reason);
      },
    },
    {
      name: "officerSpawns",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startOfficerSpawns = starters.startOfficerSpawns || require("../officers").startOfficerSpawns;
        const started = startOfficerSpawns({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          getSeam: () => {
            const tools = ctx.adapter && typeof ctx.adapter.getOfficerSpawn === "function"
              ? ctx.adapter.getOfficerSpawn() : null;
            return tools && tools.ok === true ? tools.seam : null;
          } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.officerSpawns = started.officerSpawns;
        return { ok: true };
      },
      stop(ctx) {
        ctx.officerSpawns = require("../officers").createUnavailableOfficerSpawns(
          require("../officers/schema").STUB_STOPPED);
      },
      onUnavailable(ctx, reason) {
        ctx.officerSpawns = require("../officers").createUnavailableOfficerSpawns(
          reason === "disabled_by_config" ? require("../officers/schema").STUB_DISABLED : "OFFICER_SPAWNS_UNAVAILABLE");
      },
    },
    {
      name: "heavyEvents",
      module: "world",
      requires: ["persistence", "world", "sites"],
      start(ctx, deps) {
        const startHeavyEvents = starters.startHeavyEvents || require("../heavyEvents").startHeavyEvents;
        const started = startHeavyEvents({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, views: ctx.views || null,
          getFactionKind: (factionId) => factionKindOf(ctx, factionId) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.heavyEvents = started.heavyEvents;
        return { ok: true };
      },
      stop(ctx, reason) {
        const heavyEvents = ctx.heavyEvents;
        ctx.heavyEvents = require("../heavyEvents").createUnavailableHeavyEvents("stopped");
        if (heavyEvents && typeof heavyEvents.stop === "function") heavyEvents.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.heavyEvents = require("../heavyEvents").createUnavailableHeavyEvents(reason);
      },
    },
    {
      name: "gameMaster",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startGameMaster = starters.startGameMaster || require("../gameMaster").startGameMaster;
        const started = startGameMaster({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, registry: ctx.gmSteps || null,
          views: ctx.views || null,
          getNotices: () => ctx.notices || null,
          getPresence: () => ctx.presence || null,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          },
          getGovernor: () => ctx.governor || null,
          getSites: () => ctx.sites || null,
          getChatterAi: () => ctx.chatterAi || null,
          getNews: () => ctx.news || null,
          readFactionNames: () => (ctx.adapter && typeof ctx.adapter.readFactionNames === "function"
            ? ctx.adapter.readFactionNames() : { ok: false, reason: "ADAPTER_UNAVAILABLE" }) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.gameMaster = started.gameMaster;
        return { ok: true };
      },
      stop(ctx, reason) {
        const gameMaster = ctx.gameMaster;
        ctx.gameMaster = require("../gameMaster").createUnavailableGameMaster("GAME_MASTER_UNAVAILABLE", "stopped");
        if (gameMaster && typeof gameMaster.stop === "function") gameMaster.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.gameMaster = require("../gameMaster").createUnavailableGameMaster(
          reason === "disabled_by_config" ? "GAME_MASTER_DISABLED" : "GAME_MASTER_UNAVAILABLE", reason);
      },
    },
    {
      name: "seasons",
      module: "world",
      requires: ["persistence", "scheduler"],
      start(ctx, deps) {
        const startSeasons = starters.startSeasons || require("../seasons").startSeasons;
        const started = startSeasons({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, registry: ctx.seasonCrises || null, telemetry: ctx.telemetry || null,
          logger: deps.logger, adapter: ctx.adapter || null,
          invaderFactionIds: require("../world/invasions/data/invaderProfiles").PROFILES.map((p) => p.factionId),
          factionKindOf: (factionId) => factionKindOf(ctx, factionId),
          regionOf: (systemId) => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            const sys = r && r.ok === true && r.graph ? r.graph.getSystem(systemId) : null;
            return sys && Number.isSafeInteger(sys.regionId) ? sys.regionId : null;
          },
          views: ctx.views || null, getGovernor: () => ctx.governor || null, hintRegistry: ctx.gmSteps || null,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.seasons = started.seasons;
        return { ok: true };
      },
      stop(ctx, reason) {
        const seasons = ctx.seasons;
        ctx.seasons = require("../seasons").createUnavailableSeasons("SEASONS_UNAVAILABLE", "stopped");
        if (seasons && typeof seasons.stop === "function") seasons.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.seasons = require("../seasons").createUnavailableSeasons(
          reason === "disabled_by_config" ? "SEASONS_DISABLED" : "SEASONS_UNAVAILABLE", reason);
      },
    },
    {
      name: "localContacts",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startLocalContacts = starters.startLocalContacts
          || require("../localPilots/contacts/service").startLocalContacts;
        const started = startLocalContacts({ config: ctx.config, ctx, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          getFactionKind: (factionId) => {
            const registry = ctx.strategy && ctx.strategy.registry;
            const faction = registry && typeof registry.getFaction === "function" ? registry.getFaction(factionId)
              : null;
            return faction && typeof faction.kind === "string" ? faction.kind : null;
          } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.localContacts = started.localContacts;
        return { ok: true };
      },
      stop(ctx, reason) {
        const localContacts = ctx.localContacts;
        ctx.localContacts = null;
        if (localContacts && typeof localContacts.stop === "function") localContacts.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.localContacts = (starters.createUnavailableLocalContacts
          || require("../localPilots/contacts/service").createUnavailableLocalContacts)(reason);
      },
    },
    {
      name: "shipAi",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startShipAi = starters.startShipAi || require("../shipAi").startShipAi;
        const started = startShipAi({ config: ctx.config, persistence: ctx.persistence, adapter: ctx.adapter || null,
          clock: ctx.clock, logger: deps.logger, telemetry: ctx.telemetry || null,
          getGraph: () => ctx.graph || null, getFleets: () => ctx.fleets || null, getWorld: () => ctx.world || null,
          getGovernor: () => ctx.governor || null,
          getBattles: () => ctx.battle || null,
          getNotices: () => ctx.notices || null,
          getMaterialization: () => ctx.materialization || null,
          getAbyssal: () => ctx.abyssal || null,
          getJobBoard: () => ctx.jobBoard || null,
          httpRoutes: ctx.httpRoutes || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.shipAi = started.shipAi;
        return { ok: true };
      },
      stop(ctx, reason) {
        const shipAi = ctx.shipAi;
        ctx.shipAi = require("../shipAi").createUnavailableShipAi("stopped");
        if (shipAi && typeof shipAi.stop === "function") shipAi.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.shipAi = require("../shipAi").createUnavailableShipAi(reason);
      },
    },
    {
      name: "archaeology",
      module: "sites",
      requires: ["persistence"],
      start(ctx, deps) {
        const startArchaeology = starters.startArchaeology || require("../archaeology").startArchaeology;
        const started = startArchaeology({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger, views: ctx.views || null,
          excludedRegionIds: require("../strategy/data/expansion").EXPANSION_EXCLUDED_REGION_IDS,
          getGovernor: () => ctx.governor || null, getNotices: () => ctx.notices || null,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          },
          getWorld: () => ctx.world || null, getSeasons: () => ctx.seasons || null,
          getSites: () => ctx.sites || null, getPresence: () => ctx.presence || null,
          getChatterAi: () => ctx.chatterAi || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.archaeology = started.archaeology;
        return { ok: true };
      },
      stop(ctx, reason) {
        const archaeology = ctx.archaeology;
        ctx.archaeology = require("../archaeology").createUnavailableArchaeology("ARCHAEOLOGY_UNAVAILABLE", "stopped");
        if (archaeology && typeof archaeology.stop === "function") archaeology.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.archaeology = require("../archaeology").createUnavailableArchaeology(
          reason === "disabled_by_config" ? "ARCHAEOLOGY_DISABLED" : "ARCHAEOLOGY_UNAVAILABLE", reason);
      },
    },
    {
      name: "abyssal",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startAbyssal = starters.startAbyssal || require("../abyssal").startAbyssal;
        const started = startAbyssal({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.abyssal = started.abyssal;
        return { ok: true };
      },
      stop(ctx, reason) {
        const abyssal = ctx.abyssal;
        ctx.abyssal = require("../abyssal").createUnavailableAbyssal("stopped");
        if (abyssal && typeof abyssal.stop === "function") abyssal.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.abyssal = require("../abyssal").createUnavailableAbyssal(reason);
      },
    },
    {
      name: "worldBosses",
      module: "world",
      requires: ["persistence", "world", "sites"],
      start(ctx, deps) {
        const startWorldBosses = starters.startWorldBosses || require("../worldBosses").startWorldBosses;
        const started = startWorldBosses({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, views: ctx.views || null,
          excludedRegionIds: require("../strategy/data/expansion").EXPANSION_EXCLUDED_REGION_IDS,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          },
          getPresence: () => ctx.presence || null,
          getOccupation: () => ctx.occupation || null,
          getSites: () => ctx.sites || null,
          getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
          getGovernor: () => ctx.governor || null,
          getBattle: () => ctx.battle || null,
          getFleetRepository: () => (ctx.fleets && ctx.fleets.repository) || null,
          isHostile: require("../battle/data/hostility").createHostility(),
          getScene: () => {
            const r = ctx.adapter && typeof ctx.adapter.getHeavyEventScene === "function"
              ? ctx.adapter.getHeavyEventScene() : null;
            return r && r.ok === true && r.seam ? r.seam : null;
          },
          getNotices: () => ctx.notices || null,
          getWrecks: () => (ctx.adapter && typeof ctx.adapter.getNativeWrecks === "function"
            ? ctx.adapter.getNativeWrecks() : null),
          rewardCreditIsk: (spec) => (ctx.adapter && typeof ctx.adapter.rewardCreditIsk === "function"
            ? ctx.adapter.rewardCreditIsk(spec)
            : Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false })),
          gmSteps: ctx.gmSteps || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.worldBosses = started.worldBosses;
        return { ok: true };
      },
      stop(ctx, reason) {
        const worldBosses = ctx.worldBosses;
        ctx.worldBosses = require("../worldBosses").createUnavailableWorldBosses("WORLD_BOSSES_UNAVAILABLE", "stopped");
        if (worldBosses && typeof worldBosses.stop === "function") worldBosses.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.worldBosses = require("../worldBosses").createUnavailableWorldBosses(
          reason === "disabled_by_config" ? "WORLD_BOSSES_DISABLED" : "WORLD_BOSSES_UNAVAILABLE", reason);
      },
    },
    {
      name: "killboard",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startKillboard = starters.startKillboard || require("../killboard").startKillboard;
        const started = startKillboard({ config: ctx.config, ctx, adapter: ctx.adapter || null, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          isLneNpcCorporation: (id) => Boolean(ctx.virtualCorps && typeof ctx.virtualCorps.isVirtualCorporation
            === "function" && ctx.virtualCorps.isVirtualCorporation(id) === true) });
        if (!started || !started.ok) return refusalOf(started);
        ctx.killboard = started.killboard;
        return { ok: true };
      },
      stop(ctx, reason) {
        const killboard = ctx.killboard;
        ctx.killboard = require("../killboard").createUnavailableKillboard("stopped");
        if (killboard && typeof killboard.stop === "function") killboard.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.killboard = require("../killboard").createUnavailableKillboard(reason);
      },
    },
    {
      name: "devIndices",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startDevIndices = starters.startDevIndices || require("../world/devIndices").startDevIndices;
        const started = startDevIndices({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger, views: ctx.views || null, adapter: ctx.adapter || null,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          },
          getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
          getGovernor: () => ctx.governor || null,
          getStrategyRegistry: () => (ctx.strategy && ctx.strategy.registry) || null, ids: ctx.ids || null,
          gmSteps: ctx.gmSteps || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.devIndices = started.devIndices;
        return { ok: true };
      },
      stop(ctx, reason) {
        const devIndices = ctx.devIndices;
        ctx.devIndices = require("../world/devIndices").createUnavailableDevIndices("stopped");
        if (devIndices && typeof devIndices.stop === "function") devIndices.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.devIndices = require("../world/devIndices").createUnavailableDevIndices(reason);
      },
    },
    {
      name: "population",
      module: "world",
      requires: ["persistence"],
      start(ctx, deps) {
        const startPopulation = starters.startPopulation || require("../population").startPopulation;
        const started = startPopulation({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          worldSeed: ctx.persistence ? ctx.persistence.worldSeed : undefined,
          getGraph: () => ctx.graph || null, getGovernor: () => ctx.governor || null,
          listStations: (systemId) => (ctx.adapter && typeof ctx.adapter.listNpcStationsInSystem === "function"
            ? ctx.adapter.listNpcStationsInSystem(systemId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
          buildHubDistance: require("../highsecLife/density").buildHubDistance,
          getPresence: () => ctx.presence || null, views: ctx.views || null,
          liveMaxOwned: ctx.config.highsecLife && ctx.config.highsecLife.traffic
            ? ctx.config.highsecLife.traffic.maxShipsGlobal : undefined,
          contextSources: ctx.config.population && ctx.config.population.context
            && ctx.config.population.context.enabled === true ? populationContextSources(ctx) : undefined,
          standingFactions: ctx.config.population && ctx.config.population.standings
            && ctx.config.population.standings.enabled === true ? populationStandingFactions() : undefined,
          generateName: ctx.config.population && ctx.config.population.corps
            && ctx.config.population.corps.enabled === true ? require("../freeCorps/names").generateName : undefined });
        if (!started || !started.ok) return refusalOf(started);
        ctx.population = started.population;
        return { ok: true };
      },
      stop(ctx, reason) {
        const population = ctx.population;
        ctx.population = require("../population").createUnavailablePopulation("POPULATION_UNAVAILABLE", "stopped");
        if (population && typeof population.stop === "function") population.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.population = require("../population").createUnavailablePopulation(reason);
      },
    },
    {
      name: "extraction",
      module: "strategy",
      requires: ["persistence", "scheduler", "world", "strategy", "stations"],
      start(ctx, deps) {
        const startExtraction = starters.startExtraction || require("../economy/extraction").startExtraction;
        const started = startExtraction({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          scheduler: ctx.scheduler || null, world: ctx.world || null, strategy: ctx.strategy || null,
          getStations: () => ctx.stations || null, graph: ctx.graph || null, adapter: ctx.adapter || null,
          views: ctx.views || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getGovernor: () => ctx.governor || null,
          getProduction: () => ctx.production || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.extraction = started.extraction;
        return { ok: true };
      },
      stop(ctx, reason) {
        const extraction = ctx.extraction;
        ctx.extraction = require("../economy/extraction").createUnavailableExtraction("EXTRACTION_UNAVAILABLE",
          "stopped");
        if (extraction && typeof extraction.stop === "function") extraction.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.extraction = require("../economy/extraction").createUnavailableExtraction(reason);
      },
    },
    {
      name: "nativeIncursions",
      module: "world",
      requires: ["persistence", "world"],
      start(ctx, deps) {
        const startNativeIncursions = starters.startNativeIncursions
          || require("../nativeIncursions").startNativeIncursions;
        const started = startNativeIncursions({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          adapter: ctx.adapter || null, telemetry: ctx.telemetry || null, logger: deps.logger,
          getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
          getOccupation: () => ctx.occupation || null,
          getGovernor: () => ctx.governor || null,
          getHeavyEvents: () => ctx.heavyEvents || null,
          views: ctx.views || null,
          getGraph: () => {
            const r = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
            return r && r.ok === true ? r.graph : null;
          } });
        if (!started || !started.ok) return refusalOf(started);
        ctx.nativeIncursions = started.nativeIncursions;
        return { ok: true };
      },
      stop(ctx, reason) {
        const nativeIncursions = ctx.nativeIncursions;
        ctx.nativeIncursions = require("../nativeIncursions").createUnavailableNativeIncursions(
          "NATIVE_INCURSIONS_UNAVAILABLE", "stopped");
        if (nativeIncursions && typeof nativeIncursions.stop === "function") nativeIncursions.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.nativeIncursions = require("../nativeIncursions").createUnavailableNativeIncursions(reason);
      },
    },
    {
      name: "factionIncursions",
      module: "world",
      requires: ["persistence", "world"],
      start(ctx, deps) {
        const startFactionIncursions = starters.startFactionIncursions
          || require("../factionIncursions").startFactionIncursions;
        const started = startFactionIncursions({ config: ctx.config, persistence: ctx.persistence, clock: ctx.clock,
          telemetry: ctx.telemetry || null, logger: deps.logger,
          getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
          getOccupation: () => ctx.occupation || null,
          getHeavyEvents: () => ctx.heavyEvents || null,
          getGraph: () => ctx.graph || null,
          getGovernor: () => ctx.governor || null,
          getAdapter: () => ctx.adapter || null,
          getPresence: () => ctx.presence || null });
        if (!started || !started.ok) return refusalOf(started);
        ctx.factionIncursions = started.factionIncursions;
        return { ok: true };
      },
      stop(ctx, reason) {
        const factionIncursions = ctx.factionIncursions;
        ctx.factionIncursions = require("../factionIncursions").createUnavailableFactionIncursions(
          "FACTION_INCURSIONS_UNAVAILABLE", "stopped");
        if (factionIncursions && typeof factionIncursions.stop === "function") factionIncursions.stop(reason);
      },
      onUnavailable(ctx, reason) {
        ctx.factionIncursions = require("../factionIncursions").createUnavailableFactionIncursions(reason);
      },
    },
    {
      name: "alerts",
      module: null,
      requires: [],
      probeGated: false,
      runsOnRefusal: true,
      start(ctx, deps) {
        const startAlerts = starters.startAlerts || require("../alerts").startAlerts;
        const started = startAlerts({ config: ctx.config, ctx, logger: deps.logger });
        if (!started || !started.ok) return refusalOf(started);
        ctx.alerts = started.alerts;
        return { ok: true };
      },
      stop(ctx, reason) {
        const alerts = ctx.alerts;
        ctx.alerts = null;
        if (alerts && typeof alerts.stop === "function") alerts.stop(reason);
      },
      onUnavailable(ctx) {
        ctx.alerts = null;
      },
    },
    {
      name: "observer",
      module: null,
      requires: [],
      probeGated: false,
      runsOnRefusal: true,
      start(ctx, deps) {
        const startObserver = starters.startObserver || require("../observer").startObserver;
        const started = startObserver({ config: ctx.config, ctx, views: ctx.views, logger: deps.logger,
          fail: deps.fail });
        if (!started || !started.ok) return refusalOf(started);
        ctx.observer = started.observer;
        return { ok: true };
      },
      stop(ctx, reason) {
        const observer = ctx.observer;
        ctx.observer = null;
        if (observer) observer.stop(reason);
      },
      onUnavailable(ctx) {
        const observer = ctx.observer;
        ctx.observer = null;
        if (observer) observer.stop("unavailable");
      },
    },
  ];
}

function formatServicesLine(statuses) {
  const parts = (Array.isArray(statuses) ? statuses : [])
    .map((s) => `${s.name}=${s.state}${s.reason ? `:${s.reason}` : ""}`);
  return `services: ${parts.join(" ")}`;
}

function createServiceRegistry(deps = {}) {
  const logger = deps.logger || { log: noop, logError: noop };
  const defs = Array.isArray(deps.defs) ? deps.defs : buildDefaultServiceDefs(deps.starters);
  const statuses = defs.map((def) => ({
    name: String(def.name), module: def.module || null, requires: Array.isArray(def.requires) ? [...def.requires] : [],
    state: STATE.PENDING, reason: null, detail: null,
  }));
  let phase = "idle";
  let refusal = null;
  let ctxRef = null;
  let unregisterHook = null;
  let disabledModules = Object.freeze({});
  let guard = null;

  function logError(message, err) {
    try {
      if (typeof logger.logError === "function") logger.logError(message, err);
      else logger.log(`${message}: ${messageOf(err)}`);
    } catch (_err) {
    }
  }

  function setState(status, state, reason, detail) {
    status.state = state;
    status.reason = reason === undefined ? null : reason;
    status.detail = detail === undefined || detail === "" ? null : detail;
  }

  function unavailable(def, status, ctx) {
    if (typeof def.onUnavailable !== "function") return;
    try {
      def.onUnavailable(ctx, status.reason, status.detail || undefined);
    } catch (err) {
      logError(`services: ${status.name} cleanup failed`, err);
    }
  }

  function refuseAll(reason, detail) {
    refusal = reason;
    for (const status of statuses) setState(status, STATE.DISABLED, reason);
    return { ok: false, reason, ...(detail ? { detail } : {}) };
  }

  function bootGuard(ctx, hookRegistered) {
    try {
      const config = ctx.config;
      if (hookRegistered !== true) {
        if (deps.restartGuard || (config.restartGuard && config.restartGuard.enabled === true)) {
          logger.log("services: restart guard - start not counted (no shutdown hook)");
        }
        return null;
      }
      guard = deps.restartGuard || createRestartGuard({ dir: config.dataDir, modDir: ctx.modDir,
        settings: config.restartGuard || { enabled: false } });
      ctx.restartGuard = guard;
      const r = guard.onBoot() || {};
      if (r.ok === true && r.tripped === true) {
        const streak = Number.isFinite(r.streak) ? r.streak + 1 : "?";
        return { reason: "crash_loop_guard", detail: `${streak} starts without a clean stop; `
          + `reset: delete ${r.file || "runtime/boots.json"}` };
      }
      if (r.ok !== true && r.reason !== "disabled_by_config") {
        logger.log(`services: restart guard unavailable - ${withDetail(r.reason, r.detail)}; starting without it`);
      }
    } catch (err) {
      logError("services: restart guard failed - starting without it", err);
    }
    return null;
  }

  function coreGate(ctx) {
    const adapter = ctx.adapter;
    if (!adapter) return { reason: "adapter_unavailable" };
    const report = typeof adapter.getProbeReport === "function" ? adapter.getProbeReport() : null;
    if (!report) return { reason: "probe_report_missing" };
    const map = (typeof adapter.getDisabledModules === "function" && adapter.getDisabledModules()) || {};
    if (map.core) return { reason: "probe_core_drift", detail: String(map.core) };
    return { probeMap: map };
  }

  function registerHook(ctx) {
    let hook;
    try {
      hook = typeof ctx.adapter.registerShutdownHook === "function"
        ? ctx.adapter.registerShutdownHook(SERVICES_SHUTDOWN_HOOK_NAME, (signal) => stopAll(`shutdown:${signal}`))
        : { ok: false, reason: "SHUTDOWN_HOOK_UNAVAILABLE" };
    } catch (err) {
      hook = { ok: false, reason: "SHUTDOWN_HOOK_REJECTED", detail: messageOf(err) };
    }
    if (hook && hook.ok) {
      unregisterHook = typeof hook.unregister === "function" ? hook.unregister : null;
      return true;
    }
    logger.log(`services: shutdown hook not registered - ${withDetail(hook ? hook.reason : "no result",
      hook && hook.detail)}; services stop with the process only`);
    return false;
  }

  function dropHook() {
    if (unregisterHook === null) return;
    const unregister = unregisterHook;
    unregisterHook = null;
    try {
      unregister();
    } catch (_err) {
    }
  }

  function startOne(def, status, ctx, probeMap) {
    const byName = new Map(statuses.map((s) => [s.name, s]));
    const config = ctx.config;
    const missingDep = status.requires.find((dep) => !byName.has(dep) || byName.get(dep).state !== STATE.RUNNING);
    let gated = null;
    if (status.module && !isModuleEnabled(config, status.module)) gated = "disabled_by_config";
    else if (missingDep !== undefined) gated = `dependency_disabled:${missingDep}`;
    else if (def.probeGated !== false && status.module && probeMap[status.module]) {
      gated = `probe_drift:${probeMap[status.module]}`;
    }
    if (gated !== null) {
      setState(status, STATE.DISABLED, gated);
      logger.log(`${status.name}: disabled - ${gated}`);
      unavailable(def, status, ctx);
      return;
    }
    const fail = (reason, detail) => {
      try {
        if (phase !== "started" || status.state !== STATE.RUNNING) return { ok: false, reason: "not_running" };
        setState(status, STATE.FAILED, String(reason || "SERVICE_FAILED"),
          detail === undefined ? undefined : String(detail));
        unavailable(def, status, ctx);
        return { ok: true };
      } catch (_err) {
        return { ok: false, reason: "fail_threw" };
      }
    };
    const startDeps = Object.freeze({ logger, processApi: deps.processApi, fail });
    let result;
    try {
      result = def.start(ctx, startDeps);
    } catch (err) {
      setState(status, STATE.FAILED, START_THREW, messageOf(err));
      logError(`${status.name}: start failed - continuing without it`, err);
      unavailable(def, status, ctx);
      return;
    }
    if (result && result.ok === true) {
      setState(status, STATE.RUNNING);
      return;
    }
    const refused = refusalOf(result);
    setState(status, classifyRefusal(refused.reason), refused.reason, refused.detail);
    if (!def.logsRefusal) logger.log(`${status.name}: disabled - ${withDetail(refused.reason, refused.detail)}`);
    unavailable(def, status, ctx);
  }

  function startAll(ctx) {
    if (phase === "stopped") return { ok: false, reason: "stopped" };
    if (phase === "started") return { ok: false, reason: "already_started" };
    phase = "started";
    try {
      ctxRef = ctx;
      if (!ctx || !ctx.config || ctx.config.enabled !== true) {
        return refuseAll("disabled_by_config");
      }
      ctx.views = createViewRegistry();
      ctx.gmSteps = createStepRegistry();
      ctx.seasonCrises = createCrisisRegistry();
      ctx.httpRoutes = createHttpRoutes();
      ctx.liveConfig = createLiveConfig(ctx.config);
      let gate = coreGate(ctx);
      if (!gate.reason) {
        const latched = bootGuard(ctx, registerHook(ctx));
        if (latched !== null) {
          dropHook();
          gate = latched;
        }
      }
      if (gate.reason) {
        logger.log(`services not started - ${withDetail(gate.reason, gate.detail)}`);
        const refused = refuseAll(gate.reason, gate.detail);
        defs.forEach((def, i) => {
          if (def.runsOnRefusal !== true) return;
          try {
            startOne(def, statuses[i], ctx, {});
          } catch (err) {
            logError(`services: ${statuses[i].name} start failed`, err);
          }
        });
        return refused;
      }
      ctx.clock = deps.clock || createClock({ timeScale: effectiveTimeScale(ctx.config) });
      const seedFn = typeof deps.randomSeed === "function" ? deps.randomSeed : randomSeed;
      ctx.ids = createIdGenerator({ clock: ctx.clock, rng: createRng(seedFn()) });
      ctx.persistence = null;
      ctx.streams = null;
      defs.forEach((def, i) => startOne(def, statuses[i], ctx, gate.probeMap));
      const persisted = (ctx.persistence && ctx.persistence.disabledModules) || {};
      disabledModules = Object.freeze({ ...persisted, ...gate.probeMap });
      ctx.disabledModules = disabledModules;
      logger.log(formatServicesLine(statuses));
      return { ok: true, status: getStatus() };
    } catch (err) {
      logError("services: registry failed - continuing without services", err);
      return { ok: false, reason: "SERVICES_START_FAILED", detail: messageOf(err) };
    }
  }

  function stopAll(reason) {
    if (phase !== "started") return { ok: true, alreadyStopped: true };
    phase = "stopped";
    const stopped = [];
    try {
      for (let i = defs.length - 1; i >= 0; i -= 1) {
        const status = statuses[i];
        if (status.state !== STATE.RUNNING) continue;
        try {
          if (typeof defs[i].stop === "function") defs[i].stop(ctxRef, String(reason));
        } catch (err) {
          logError(`services: ${status.name} stop failed`, err);
        }
        setState(status, STATE.STOPPED, status.reason, status.detail);
        stopped.push(status.name);
      }
      if (unregisterHook !== null) {
        const unregister = unregisterHook;
        unregisterHook = null;
        try {
          unregister();
        } catch (_err) {
        }
      }
      if (refusal === null) {
        if (guard !== null && typeof guard.onCleanStop === "function") {
          try {
            guard.onCleanStop();
          } catch (err) {
            logError("services: restart guard stop failed", err);
          }
        }
        logger.log(`services: stopped (${reason}) ${stopped.join(",")}`);
      }
    } catch (err) {
      logError("services: stop failed", err);
    }
    return { ok: true, stopped };
  }

  function getStatus() {
    return Object.freeze({
      started: phase !== "idle",
      stopped: phase === "stopped",
      refusal,
      services: statuses.map((s) => Object.freeze({ ...s, requires: [...s.requires] })),
      disabledModules,
    });
  }

  return Object.freeze({ startAll, stopAll, getStatus });
}

function populationContextSources(ctx) {
  const refuse = (reason) => ({ ok: false, reason });
  const store = () => (ctx.persistence && ctx.persistence.ok === true ? ctx.persistence.store : null);
  const density = require("../highsecLife/density");
  const hsl = ctx.config && ctx.config.highsecLife;
  const curve = hsl ? require("../highsecLife/schema").parseHourCurve(hsl.hourCurvePermille) : null;
  const world = ctx.config && ctx.config.world;
  return Object.freeze({
    readControl(ids) {
      if (!ctx.world || typeof ctx.world.getSystems !== "function") return refuse("WORLD_UNAVAILABLE");
      return ctx.world.getSystems(ids, { includeInfluence: false });
    },
    readOpenBattleSystems(limit) {
      const repo = ctx.battle && ctx.battle.repository;
      const s = store();
      if (!repo || typeof repo.summarizeOpen !== "function" || !s) return refuse("BATTLE_UNAVAILABLE");
      const r = s.transaction("population.context.battles", (tx) => repo.summarizeOpen(tx, { limit }));
      if (!r || r.ok !== true) return refuse((r && r.reason) || "TX_FAILED");
      if (!r.value || r.value.ok !== true) return refuse((r.value && r.value.reason) || "BATTLE_READ_FAILED");
      return { ok: true, systemIds: r.value.battles.map((b) => b.systemId), truncated: r.value.truncated === true };
    },
    readOpenEvents(limit) {
      if (!ctx.events || typeof ctx.events.listOpenEvents !== "function") return refuse("EVENTS_UNAVAILABLE");
      const r = ctx.events.listOpenEvents({ limit });
      if (!r || r.ok !== true || !Array.isArray(r.events)) return refuse((r && r.reason) || "EVENTS_READ_FAILED");
      return { ok: true, events: r.events.filter(Boolean).map((e) => ({ systemId: e.systemId, eventType: e.eventType })),
        truncated: r.truncated === true };
    },
    richVeinSystems: () => (ctx.events && typeof ctx.events.richVeinSystems === "function"
      ? ctx.events.richVeinSystems() : new Set()),
    readWreckSystems(at, limit) {
      const wrecks = ctx.wrecks;
      const s = store();
      if (!wrecks || !wrecks.repository || typeof wrecks.effectivePool !== "function" || !s) {
        return refuse("WRECKS_UNAVAILABLE");
      }
      const r = s.transaction("population.context.wrecks", (tx) => wrecks.repository.listActive(tx, { at, limit }));
      if (!r || r.ok !== true) return refuse((r && r.reason) || "TX_FAILED");
      if (!r.value || r.value.ok !== true) return refuse((r.value && r.value.reason) || "WRECKS_READ_FAILED");
      const ids = r.value.fields.filter((f) => wrecks.effectivePool(f, at).total > 0).map((f) => f.systemId);
      return { ok: true, systemIds: ids, truncated: r.value.truncated === true };
    },
    readBelts: (ids) => (ctx.adapter && typeof ctx.adapter.readSystemBelts === "function"
      ? ctx.adapter.readSystemBelts(ids) : refuse("ADAPTER_UNAVAILABLE")),
    pirateFactionIds: Object.freeze(require("../strategy/data/factions").FACTIONS_V1
      .filter((f) => f.kind === "pirate").map((f) => f.factionId)),
    hourCurvePermille: curve,
    hourPermilleAt: density.hourPermilleAt,
    maxBatchReadIds: world && Number.isSafeInteger(world.maxBatchReadIds) ? world.maxBatchReadIds : undefined,
  });
}

function populationStandingFactions() {
  return Object.freeze(require("../strategy/data/factions").FACTIONS_V1
    .filter((f) => f.kind === "empire" || f.kind === "pirate")
    .map((f) => Object.freeze({ factionId: f.factionId, kind: f.kind,
      homeRegionIds: Object.freeze(Array.isArray(f.homeRegionIds) ? [...f.homeRegionIds] : []) })));
}

module.exports = { SERVICES_SHUTDOWN_HOOK_NAME, buildDefaultServiceDefs, createServiceRegistry, formatServicesLine,
  canOccupyOf, footholdsOf, populationContextSources, populationStandingFactions };
