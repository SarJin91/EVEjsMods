"use strict";

const { performance } = require("node:perf_hooks");
const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const S = require("./schema");
const { createHeavyEventRepository } = require("./repository");
const { planPass, pumpPlanned, endInTx, Rollback, stationsPending } = require("./planner");
const { planPowerPass } = require("./power/planner");
const { planWorldPass } = require("./world/planner");
const W = require("./world/schema");
const { abandonTargetOf } = require("./machine");
const { createLive } = require("./live");
const { createReward } = require("./reward");
const { registerHeavyEventsView } = require("./view");
const { createHeavyEventPayoutRepository, lpCorporationOf } = require("./payoutRepository");
const PS = require("./payoutSchema");
const { createHeavyEventPayoutPump } = require("./payouts");
const { planIncursionSiteInTx, cancelIncursionSiteInTx } = require("./incursion/planner");
const { parseLpPerRole } = require("./incursion/rewards");
const { LAYER, layerOfEventId } = require("./layer");

const { heavyRowsOf } = require("./boardRows");

const FACADE_METHODS = Object.freeze(["getStatus", "runPass", "listOpen", "listBoardRows", "stop",
  "planIncursionSiteInTx", "cancelIncursionSiteInTx", "getSiteInTx", "siteParticipantsInTx", "planRewardPayoutsInTx",
  "incursionParticipantsInTx"]);
const MAX_POOL_PARTICIPANTS = 256;
const MAX_SITE_PREFIX = 64;

function incursionRewardsOf(R) {
  if (!R || R.enabled !== true) return null;
  const lpPerRole = parseLpPerRole(R.lpPerRole);
  if (lpPerRole === null || !Number.isSafeInteger(R.siteStandingMicro) || R.siteStandingMicro < 0) return null;
  return Object.freeze({ lpPerRole, standingMicro: R.siteStandingMicro });
}
const MODE = Object.freeze({ FULL: "running", DRAIN: "drain", STOPPED: "stopped" });
const PLAN_CLASS = "OPERATIONAL";
const PRUNE_CLASS = "MAINTENANCE";
const METRIC_PASS_MS = "world.heavyEvents.passMs";
const METRIC_POWER_PLAN_MS = "world.heavyEvents.power.planMs";
const METRIC_WORLD_PLAN_MS = "world.heavyEvents.anomaly.planMs";
const MAX_DETAIL = 160;
const NOT_READY = Object.freeze(["STATIONS_NOT_READY", "PRESENCE"]);

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function createUnavailableHeavyEvents(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" });
  const boardRefusal = reason === "disabled_by_config" ? Object.freeze({ ok: false, reason: "HEAVY_EVENTS_DISABLED" })
    : refusal;
  return Object.freeze({
    getStatus: () => ({ state: "unavailable", reason: String(reason || "HEAVY_EVENTS_UNAVAILABLE"),
      ...(detail ? { detail: String(detail) } : {}) }),
    runPass: () => refusal,
    listOpen: () => refusal,
    listBoardRows: () => boardRefusal,
    stop: () => {},
    planIncursionSiteInTx: () => refusal,
    cancelIncursionSiteInTx: () => refusal,
    getSiteInTx: () => refusal,
    siteParticipantsInTx: () => refusal,
    planRewardPayoutsInTx: () => refusal,
    incursionParticipantsInTx: () => refusal,
  });
}

function startHeavyEvents(deps) {
  const config = deps && deps.config;
  const settings = config && config.heavyEvents;
  if (!settings || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
  const power = config.powerSites || null;
  const world = config.eventAnomalies || null;
  const heavyOn = settings.enabled === true;
  const powerOn = Boolean(power && power.enabled === true);
  const worldOn = Boolean(world && world.enabled === true);
  const incursionOn = Boolean(config.factionIncursions && config.factionIncursions.enabled === true);
  const incursionRewards = incursionOn ? incursionRewardsOf(config.factionIncursions.rewards) : null;
  const full = heavyOn || powerOn || worldOn || incursionOn;
  if (full && !isModuleEnabled(config, "sites")) return { ok: false, reason: "dependency_disabled:sites" };
  const ctx = deps.ctx || {};
  const persistence = ctx.persistence;
  const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
  const journal = persistence && persistence.journal ? persistence.journal : null;
  if (!store || !journal) {
    return { ok: false, reason: full ? "HEAVY_EVENTS_STORE_UNAVAILABLE" : "disabled_by_config" };
  }
  const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed : null;
  if (full && worldSeed === null) return { ok: false, reason: "HEAVY_EVENTS_START_FAILED", detail: "worldSeed" };
  let repo;
  try {
    repo = createHeavyEventRepository({ journal });
  } catch (err) {
    return { ok: false, reason: "HEAVY_EVENTS_START_FAILED", detail: messageOf(err) };
  }
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`heavyEvents: ${line}`);
    } catch (_err) {
    }
  }

  if (!full) {
    const c = store.transaction("heavyEvents.count", (tx) => repo.countOpenInTx(tx, { any: true }));
    if (!c.ok || !c.value || c.value.ok !== true || c.value.count === 0) return { ok: false, reason: "disabled_by_config" };
    log(`drain mode - ${c.value.count} open rows to close`);
  }

  const counters = Object.fromEntries(S.COUNTER_NAMES.map((name) => [name, 0]));
  let mode = full ? MODE.FULL : MODE.DRAIN;
  let lastPassAt = null;
  let lastRefusal = null;
  let plannedBucket = null;
  let notReadyBucket = null;
  let prunedBucket = null;
  let powerBucket = null;
  let powerNotReadyBucket = null;
  let worldBucket = null;
  let worldNotReadyBucket = null;
  let recovered = false;
  let recoverRetry = new Set();
  let openRows = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `world.heavyEvents.${name}`, n);
  }

  function refuse(reason) {
    lastRefusal = reason;
    log(`refusal ${reason}`);
  }

  let factionNames = new Map();
  if (full) {
    try {
      const r = deps.adapter && typeof deps.adapter.readFactionNames === "function" ? deps.adapter.readFactionNames()
        : null;
      if (r && r.ok && r.names instanceof Map) factionNames = r.names;
    } catch (_err) {
    }
  }

  const env = Object.freeze({
    store, repo, settings, worldSeed: worldSeed === null ? 0 : worldSeed,
    power, world, maxActiveSites: config.sites ? config.sites.maxActiveSites : 0, incursionEnabled: incursionOn,
    incursionRewards,
    getStations: () => ctx.stations || null,
    getBattleRepository: () => (ctx.battle && ctx.battle.repository) || null,
    getSites: () => ctx.sites || null,
    getWorldRepository: () => (ctx.world && ctx.world.repository) || null,
    getInvasions: () => ctx.invasions || null,
    getTreasury: () => ctx.treasury || null,
    getLogistics: () => ctx.logistics || null,
    getFleetRepository: () => (ctx.fleets && ctx.fleets.repository) || null,
    getGraph: () => ctx.graph || null,
    getAbyssal: () => ctx.abyssal || null,
    getSalvageAnomaly: () => ctx.salvageAnomaly || null,
    getPresence: () => ctx.presence || null,
    getFactionKind: typeof deps.getFactionKind === "function" ? deps.getFactionKind : () => null,
    factionName: (id) => factionNames.get(id) || null,
  });

  const admits = (workClass) => {
    const governor = ctx.governor;
    try {
      return !governor || typeof governor.admits !== "function" || governor.admits(workClass) !== false;
    } catch (_err) {
      return true;
    }
  };

  const payoutRepo = createHeavyEventPayoutRepository();
  const payoutPump = createHeavyEventPayoutPump({ store, repo: payoutRepo, adapter: deps.adapter || null,
    params: Object.freeze({ payoutEnabled: settings.payoutEnabled === true, payoutMaxPerPass: settings.payoutMaxPerPass,
      payoutMaxAttempts: settings.payoutMaxAttempts, payoutRetryBaseMs: settings.payoutRetryBaseMs,
      payoutRetryMaxMs: settings.payoutRetryMaxMs, payoutRetentionMs: settings.payoutRetentionMs,
      prunePerPass: settings.pruneBatch }),
    getGovernor: () => ctx.governor || null, count: (name, n) => bump(name, n), log,
    isStopped: () => mode === MODE.STOPPED });
  let payoutInFlight = null;

  function kickPayout(at) {
    if (payoutInFlight !== null) return payoutInFlight;
    payoutInFlight = payoutPump.runPass(at).catch((err) => {
      bump("errors");
      refuse(`PAYOUT_THREW ${messageOf(err)}`);
      return null;
    }).then((summary) => {
      payoutInFlight = null;
      return summary;
    });
    return payoutInFlight;
  }

  const live = createLive({ ...env, journal,
    getSeam: () => {
      const a = deps.adapter;
      const r = a && typeof a.getHeavyEventScene === "function" ? a.getHeavyEventScene() : null;
      return r && r.ok === true && r.seam ? r.seam : null;
    },
    getOccupation: () => ctx.occupation || null,
    payoutRepo,
    admits }, { bump: (name, n) => bump(name, n), refuse: (line) => refuse(line) });

  const reward = createReward({ ...env, journal, power: env.power,
    eventRewards: config.eventRewards,
    fallbackLootTableId: config.salvageAnomaly && config.salvageAnomaly.fallbackLootTableId,
    sizedDefaultLoot: Boolean(config.salvageAnomaly && config.salvageAnomaly.sizedDefaultLoot),
    getWrecks: () => {
      const a = deps.adapter;
      return a && typeof a.getNativeWrecks === "function" ? a.getNativeWrecks() : null;
    },
    admits }, { bump: (name, n) => bump(name, n), refuse: (line) => refuse(line) });

  function applyPump(p) {
    bump("expired", p.expired);
    bump(`cancelled.${S.END_REASON.CANCELLED}`, p.cancelled);
    bump(`cancelled.${S.END_REASON.DISABLED}`, p.disabled);
    for (const [reason, n] of Object.entries(p.power || {})) bump(`power.cancelled.${reason}`, n);
    for (const [reason, n] of Object.entries(p.world || {})) bump(`anomaly.cancelled.${reason}`, n);
    bump("hullsReturned", p.returned);
    bump("hullsOrphaned", p.orphaned);
    if (p.errors > 0) {
      bump("errors", p.errors);
      refuse(`PUMP ${p.lastError}`);
    }
  }

  function plan(now, bucket) {
    if (!admits(PLAN_CLASS)) {
      bump("deferred.GOVERNOR");
      return;
    }
    const previous = plannedBucket;
    plannedBucket = bucket;
    const r = planPass(env, now);
    if (!r.ok && NOT_READY.includes(r.reason)) {
      plannedBucket = previous;
      if (notReadyBucket === bucket) return;
      notReadyBucket = bucket;
    }
    if (r.ok) {
      if (r.outcome === "PLANNED") {
        bump(`planned.${r.eventType}`);
        bump("hullsFunded", r.total);
        log(`planned ${r.eventId} ${r.eventType} tier=${r.tier} system=${r.systemId} hulls=${r.total}`);
      }
      return;
    }
    bump(`refused.${r.reason}`);
    if (r.reason === "OTHER") refuse(`PLAN ${r.detail || ""}`.trim());
  }

  function powerPlan(now, bucket) {
    if (!admits(PLAN_CLASS)) {
      bump("power.deferred.GOVERNOR");
      return;
    }
    const previous = powerBucket;
    powerBucket = bucket;
    const t0 = nowMs();
    const r = planPowerPass(env, now, bucket);
    metric("observe", METRIC_POWER_PLAN_MS, nowMs() - t0);
    if (!r.ok && NOT_READY.includes(r.reason)) {
      powerBucket = previous;
      if (powerNotReadyBucket === bucket) return;
      powerNotReadyBucket = bucket;
    }
    if (!r.ok) {
      bump(`power.refused.${r.reason}`);
      if (r.reason === "OTHER") refuse(`POWER_PLAN ${r.detail || ""}`.trim());
      return;
    }
    for (const [reason, n] of Object.entries(r.refused)) bump(`power.refused.${reason}`, n);
    for (const p of r.plans) {
      bump("power.planned");
      bump(`planned.${p.eventType}`);
      bump(`power.affix.${p.affix}`);
      bump("hullsFunded", p.total);
      log(`power planned ${p.eventId} ${p.eventType}/${p.variant} tier=${p.tier} affix=${p.affix} `
        + `system=${p.systemId} hulls=${p.total}`);
    }
  }

  function worldPlan(now, bucket) {
    if (!admits(PLAN_CLASS)) {
      bump("anomaly.deferred.GOVERNOR");
      return;
    }
    const previous = worldBucket;
    worldBucket = bucket;
    const t0 = nowMs();
    const r = planWorldPass(env, now, bucket);
    metric("observe", METRIC_WORLD_PLAN_MS, nowMs() - t0);
    if (!r.ok && NOT_READY.includes(r.reason)) {
      worldBucket = previous;
      if (worldNotReadyBucket === bucket) return;
      worldNotReadyBucket = bucket;
    }
    if (!r.ok) {
      bump(`anomaly.refused.${r.reason}`);
      if (r.reason === "OTHER") refuse(`WORLD_PLAN ${r.detail || ""}`.trim());
      return;
    }
    for (const [reason, n] of Object.entries(r.refused)) bump(`anomaly.refused.${reason}`, n);
    if (r.lossesTruncated === true) bump("anomaly.lossesTruncated");
    for (const kind of Object.keys(r.readRefused || {})) {
      if (W.KINDS.includes(kind)) bump(`anomaly.readRefused.${kind}`);
    }
    for (const p of r.plans) {
      bump("anomaly.planned");
      bump(`anomaly.planned.${p.kind}`);
      if (p.kind === W.KIND.STAGING && p.beneficiaryFactionId === null) bump("anomaly.staging.noBeneficiary");
      bump(`planned.${p.eventType}`);
      bump("hullsFunded", p.total);
      log(`anomaly planned ${p.eventId} ${p.eventType}/${p.kind} tier=${p.tier} system=${p.systemId} `
        + `hulls=${p.total}`);
    }
  }

  function prune(now, bucket) {
    if (!admits(PRUNE_CLASS)) return;
    prunedBucket = bucket;
    const r = store.transaction("heavyEvents.prune", (tx) => repo.pruneInTx(tx,
      { before: now - settings.retentionMs, limit: settings.pruneBatch }));
    if (r.ok && r.value && r.value.ok) bump("pruned", r.value.deleted);
    else bump("errors");
  }

  function drain(now) {
    const listed = store.transaction("heavyEvents.drainRead", (tx) => repo.listOpenInTx(tx,
      { limit: S.OPEN_SCAN_LIMIT }));
    if (!listed.ok || !listed.value.ok) {
      bump("errors");
      return null;
    }
    let left = 0;
    for (const listedRow of listed.value.rows) {
      const r = store.transaction("heavyEvents.drain", (tx) => {
        const got = repo.getInTx(tx, listedRow.eventId);
        const row = got.ok ? got.row : null;
        if (!row || !row.open) return { kind: "gone" };
        if (row.state === S.STATE.PLANNED || row.state === S.STATE.ENGAGED) {
          return { kind: "cancelled", ...endInTx(tx, env, row, { to: S.STATE.CANCELLED,
            reason: S.END_REASON.DISABLED }, now) };
        }
        if (row.state === S.STATE.CLEARED) {
          return { kind: "skipped", ...endInTx(tx, env, row, { to: S.STATE.COMPLETED, reason: S.END_REASON.CLEARED,
            rewardState: S.REWARD_STATE.SKIPPED }, now) };
        }
        if (row.state === S.STATE.COMPLETED) {
          const rel = repo.releaseSiteInTx(tx, { eventId: row.eventId, expectedVersion: row.version, at: now });
          if (!rel.ok) throw new Rollback("OTHER", rel.reason);
          const sites = env.getSites();
          const cleaned = sites && typeof sites.cleanupSitesInTx === "function"
            ? sites.cleanupSitesInTx(tx, row.eventId, "EVENT_END") : null;
          if (!cleaned || cleaned.ok !== true) throw new Rollback("OTHER", "CLEANUP_FAILED");
          return { kind: "released" };
        }
        return { kind: "gone" };
      });
      if (!r.ok) {
        left += 1;
        bump("errors");
        refuse(`DRAIN ${listedRow.eventId} ${r.error instanceof Rollback ? r.error.detail : r.reason}`);
        continue;
      }
      const v = r.value;
      if (v.kind === "cancelled" && !v.duplicate) bump(`cancelled.${S.END_REASON.DISABLED}`);
      if (v.kind === "skipped" && !v.duplicate) {
        bump("reward.skipped");
        bump("reward.skipped.DRAIN");
      }
      bump("hullsReturned", v.returned || 0);
      bump("hullsOrphaned", v.orphaned || 0);
    }
    return left + (listed.value.truncated ? 1 : 0);
  }

  function runPass(now) {
    if (mode === MODE.STOPPED) return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" };
    const at = Number.isSafeInteger(now) ? now : clock.now();
    const t0 = nowMs();
    try {
      if (mode === MODE.DRAIN) {
        const left = drain(at);
        lastPassAt = at;
        if (left === 0) {
          log("drain done - no open row left, service stops");
          stop("drained");
        }
        return { ok: true, mode: MODE.DRAIN, left };
      }
      if (!recovered) {
        if (stationsPending(env)) {
          lastPassAt = at;
          return { ok: true, mode, waiting: "STATIONS_NOT_READY" };
        }
        recovered = true;
        recover(at, null);
        if (!recovered) {
          lastPassAt = at;
          return { ok: true, mode, waiting: "RECOVERY" };
        }
      } else if (recoverRetry.size > 0) {
        recover(at, recoverRetry);
      }
      applyPump(pumpPlanned(env, at));
      live.pass(at);
      reward.pass(at);
      kickPayout(at);
      const bucket = Math.floor(at / settings.planIntervalMs);
      if (heavyOn && bucket !== plannedBucket) plan(at, bucket);
      if (powerOn) {
        const pwBucket = Math.floor(at / power.planIntervalMs);
        if (pwBucket !== powerBucket) powerPlan(at, pwBucket);
      }
      if (worldOn) {
        const waBucket = Math.floor(at / world.planIntervalMs);
        if (waBucket !== worldBucket) worldPlan(at, waBucket);
      }
      if (bucket !== prunedBucket) prune(at, bucket);
      const c = store.transaction("heavyEvents.countOpen", (tx) => repo.countOpenInTx(tx, { any: true }));
      openRows = c.ok && c.value && c.value.ok ? c.value.count : openRows;
    } catch (err) {
      bump("errors");
      refuse(`PASS_THREW ${messageOf(err)}`);
    }
    lastPassAt = at;
    metric("observe", METRIC_PASS_MS, nowMs() - t0);
    return { ok: true, mode };
  }

  function listOpen() {
    if (mode === MODE.STOPPED) return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" };
    const r = store.transaction("heavyEvents.read", (tx) => repo.listOpenInTx(tx, { limit: S.OPEN_SCAN_LIMIT }));
    if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED" };
    return r.value.ok ? { ok: true, rows: r.value.rows } : r.value;
  }

  function listBoardRows(opts) {
    try {
      if (mode === MODE.STOPPED) return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" };
      const limit = opts && opts.limit;
      const systemIds = opts ? opts.systemIds : undefined;
      if (!Number.isSafeInteger(limit) || limit <= 0) return { ok: false, reason: "LIMIT_INVALID" };
      if (systemIds !== null && !(systemIds instanceof Set)) return { ok: false, reason: "SYSTEM_IDS_INVALID" };
      if (typeof store.isInTransaction === "function" && store.isInTransaction()) {
        return { ok: false, reason: "TX_ACTIVE" };
      }
      const r = store.transaction("heavyEvents.board", (tx) => repo.listOpenInTx(tx, { limit: S.OPEN_SCAN_LIMIT }));
      if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED" };
      if (!r.value || r.value.ok !== true) return { ok: false, reason: String((r.value && r.value.reason) || "NO_RESULT") };
      const out = heavyRowsOf(r.value.rows, { systemIds, limit, factionName: env.factionName,
        params: power || {}, worldParams: world || power || {}, payoutEnabled: settings.payoutEnabled === true });
      return { ok: true, rows: out.rows, truncated: out.truncated || r.value.truncated === true };
    } catch (err) {
      return { ok: false, reason: "HEAVY_EVENTS_BOARD_FAILED", detail: messageOf(err) };
    }
  }

  function recover(now, only) {
    const listed = store.transaction("heavyEvents.recoverRead", (tx) => repo.listOpenInTx(tx,
      { limit: S.OPEN_SCAN_LIMIT }));
    if (!listed.ok || !listed.value.ok) {
      bump("errors");
      if (only === null) recovered = false;
      return;
    }
    const failed = new Set();
    for (const listedRow of listed.value.rows) {
      if (listedRow.state !== S.STATE.ENGAGED || (only !== null && !only.has(listedRow.eventId))) continue;
      const r = store.transaction("heavyEvents.recover", (tx) => {
        const got = repo.getInTx(tx, listedRow.eventId);
        const row = got.ok ? got.row : null;
        if (!row || row.state !== S.STATE.ENGAGED) return null;
        const target = abandonTargetOf(row, settings);
        if (target === S.STATE.EXPIRED) {
          return { expired: true, ...endInTx(tx, env, row, { to: S.STATE.EXPIRED, reason: S.END_REASON.RESTART },
            now) };
        }
        const moved = repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: row.version,
          from: S.STATE.ENGAGED, to: S.STATE.PLANNED, patch: { abandons: row.abandons + 1 }, at: now,
          reason: S.END_REASON.RESTART });
        if (!moved.ok) throw new Rollback("OTHER", moved.reason);
        return { expired: false, duplicate: moved.duplicate === true };
      });
      if (!r.ok) {
        failed.add(listedRow.eventId);
        bump("errors");
        refuse(`RECOVER ${listedRow.eventId} ${r.error instanceof Rollback ? r.error.detail : r.reason}`);
        continue;
      }
      if (!r.value || r.value.duplicate) continue;
      bump("restartReset");
      if (r.value.expired) {
        bump("expired");
        bump("hullsReturned", r.value.returned);
        bump("hullsOrphaned", r.value.orphaned);
      }
    }
    recoverRetry = failed;
  }

  const poller = createPoller({ runPass: () => runPass(clock.now()), intervalMs: settings.pumpIntervalMs,
    now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => {
      bump("errors");
      log(`pass failed - ${messageOf(err)}`);
    },
    pacing: false });

  let viewHandle = null;

  function stop(reason) {
    if (mode === MODE.STOPPED) return;
    mode = MODE.STOPPED;
    if (viewHandle) {
      try {
        viewHandle.unregister();
      } catch (_err) {
      }
      viewHandle = null;
    }
    try {
      live.stopAll();
    } catch (err) {
      log(`live stop failed - ${messageOf(err)}`);
    }
    try {
      poller.stop();
    } catch (err) {
      log(`timer stop failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
  }

  const unavailable = () => (mode === MODE.STOPPED ? { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" } : null);
  function guarded(fn) {
    try {
      return unavailable() || fn();
    } catch (err) {
      return { ok: false, reason: "HEAVY_EVENTS_INCURSION_FAILED", detail: messageOf(err) };
    }
  }
  function getSiteInTx(tx, eventId) {
    return guarded(() => {
      const got = repo.getInTx(tx, eventId);
      if (!got.ok) return got;
      const r = got.row;
      return { ok: true, site: r ? Object.freeze({ eventId: r.eventId, state: r.state, endedAt: r.endedAt,
        updatedAt: r.updatedAt }) : null };
    });
  }
  function siteParticipantsInTx(tx, eventId, limit) {
    return guarded(() => {
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      return payoutRepo.listCharacterIdsOfEventInTx(tx, eventId, limit);
    });
  }
  function incursionParticipantsInTx(tx, prefix, limit) {
    const r = guarded(() => {
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      if (typeof prefix !== "string" || prefix.length > MAX_SITE_PREFIX || !prefix.endsWith(":")
        || layerOfEventId(prefix) !== LAYER.INCURSION || prefix.split(":").length < 3) {
        return { ok: false, reason: "INVALID_INPUT", detail: "prefix" };
      }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_POOL_PARTICIPANTS) {
        return { ok: false, reason: "INVALID_INPUT", detail: "limit" };
      }
      return payoutRepo.listCharacterIdsByKeyPrefixInTx(tx, prefix, limit);
    });
    return r.reason === "HEAVY_EVENTS_INCURSION_FAILED" ? { ...r, reason: "HEAVY_EVENTS_UNAVAILABLE" } : r;
  }

  function planRewardPayoutsInTx(tx, spec) {
    try {
      if (mode !== MODE.FULL) return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE", detail: mode };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      const s = spec || {};
      const bad = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
      if (typeof s.eventId !== "string" || !PS.REWARD_EVENT_PREFIXES.some((p) => s.eventId.startsWith(p)
        && s.eventId.length > p.length)) return bad("eventId");
      if (!Array.isArray(s.characterIds) || s.characterIds.length > PS.MAX_REWARD_CHARACTERS) return bad("characterIds");
      if (!Number.isSafeInteger(s.lpAmount) || s.lpAmount < 0) return bad("lpAmount");
      if (!Number.isSafeInteger(s.issuerFactionId) || s.issuerFactionId <= 0) return bad("issuerFactionId");
      const standingMicro = s.standingMicro === undefined ? 0 : s.standingMicro;
      if (settings.payoutEnabled !== true) return { ok: false, reason: "PAYOUTS_DISABLED" };
      if (s.lpAmount > 0 && lpCorporationOf(s.issuerFactionId) === null) return { ok: false, reason: "NO_LP_CORPORATION" };
      return payoutRepo.planPayoutsInTx(tx, { eventId: s.eventId, issuerFactionId: s.issuerFactionId,
        systemId: s.systemId, characterIds: s.characterIds, iskAmount: 0, lpAmount: s.lpAmount, standingMicro,
        description: PS.REWARD_DESCRIPTION, at: s.at });
    } catch (err) {
      return { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  const facade = Object.freeze({
    planRewardPayoutsInTx,
    planIncursionSiteInTx: (tx, spec) => guarded(() => planIncursionSiteInTx(tx, env, spec)),
    cancelIncursionSiteInTx: (tx, spec) => guarded(() => cancelIncursionSiteInTx(tx, env, spec)),
    getSiteInTx,
    siteParticipantsInTx,
    incursionParticipantsInTx,
    getStatus: () => ({ state: mode, lastPassAt, lastRefusal, openRows, plannedBucket,
      passes: poller.getPasses(), live: live.status(),
      payout: { enabled: settings.payoutEnabled === true, inFlight: payoutInFlight !== null,
        ...payoutPump.getStatus() },
      counters: { ...counters } }),
    runPass,
    listOpen,
    listBoardRows,
    stop,
  });

  try {
    const armed = poller.start();
    if (!armed.ok) {
      stop("timer");
      return { ok: false, reason: "HEAVY_EVENTS_START_FAILED", detail: `timer ${armed.reason}` };
    }
  } catch (err) {
    stop("start");
    return { ok: false, reason: "HEAVY_EVENTS_START_FAILED", detail: messageOf(err) };
  }
  log(`${mode} planInterval=${settings.planIntervalMs}ms maxOpen=${settings.maxOpen} `
    + `fundFromStock=${settings.fundFromStock === true} heavy=${heavyOn} power=${powerOn}`
    + (powerOn ? ` powerPlanInterval=${power.planIntervalMs}ms powerMaxOpen=${power.maxOpen}` : "")
    + ` world=${worldOn}` + (worldOn ? ` worldPlanInterval=${world.planIntervalMs}ms worldMaxOpen=${world.maxOpen}` : ""));
  if (mode !== MODE.STOPPED) {
    viewHandle = registerHeavyEventsView({ views: deps.views || null, store, repository: repo,
      adapter: deps.adapter || null, graph: ctx.graph || null, getGovernor: () => ctx.governor || null,
      maxEnded: settings.panelMaxEnded, config: deps.config, log });
  }
  return { ok: true, heavyEvents: facade };
}

module.exports = { startHeavyEvents, createUnavailableHeavyEvents, FACADE_METHODS, incursionRewardsOf };
