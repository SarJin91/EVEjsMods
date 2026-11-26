"use strict";

const S = require("./schema");
const R = require("./invasionRepository");
const P = require("./rollPlanner");
const M = require("./invasionMachine");
const { deriveSeed } = require("../../util/rng");
const { createRng } = require("../../util/rng");
const { stableJson } = require("../../util/fingerprint");
const { coreOwnerOf, getCoreIndex } = require("../../world/core");
const { planConduit } = require("./conduit");
const { INVADER_ECONOMY_FACTIONS } = require("../../strategy/data/invaderEconomy");
const { strengthOf } = require("../../strategy/ai/strength");
const { parseFleetRoleList } = require("../../fleets/schema");
const { ATTENTION_FACTIONS } = require("./data/attention");

const DAY_MS = 86400000;
const POOL_ROLE = "garrison";
const BONUS_ROLE = "invasion";

const HOLD_STATES = S.HOLD_STATES;
const MAX_PACKAGE_FLEETS = S.MAX_PACKAGE_FLEETS;

const COUNTER_NAMES = Object.freeze(["rolls", "noRoll", "noRoom", "noFaction", "noTarget", "sovUnavailable",
  "stationsNotReady", "spawnDecision", "spawned", "spawnRefused", "contactRefused", "steps", "stale", "collapsed",
  "pruned",
  "withdrawStarted", "withdrawRounds", "withdrawn", "withdrawTimeout", "withdrawLeftover",
  "withdrawDisbandRefused", "withdrawAbandoned", "withdrawAbandonSkipped",
  "withdrawReleased", "withdrawEndDeferred",
  "holds", "holdLost",
  "withdrawKeptConquest",
  "theatreFilterUnavailable",
  "conduit.rolls", "conduit.spawned", "conduit.noRoll", "conduit.noRoom", "conduit.dayCap", "conduit.noSurplus",
  "conduit.noPool", "conduit.noTarget", "conduit.spawnRefused",
  "targetListUnavailable", "targetListFiltered",
  "attentionBoosted", "attentionUnavailable",
  "seasonBoosted", "seasonBiasUnavailable", "seasonBiasNoProfile"]);
const TARGET_LIST_COUNTERS = Object.freeze(["targetListUnavailable", "targetListFiltered"]);
const ATTENTION_COUNTERS = Object.freeze(["attentionBoosted", "attentionUnavailable"]);
const SEASON_BIAS_COUNTERS = Object.freeze(["seasonBoosted", "seasonBiasUnavailable", "seasonBiasNoProfile"]);
const SEASON_RUNNING_STATES = Object.freeze(["ACTIVE", "FINALE"]);
const ATTENTION_TOP_REGIONS = 32;
const CONDUIT_OUTCOME_COUNTERS = Object.freeze({ SPAWN: null, NO_ROLL: "conduit.noRoll", NO_ROOM: "conduit.noRoom",
  DAY_CAP: "conduit.dayCap", NO_SURPLUS: "conduit.noSurplus", NO_POOL: "conduit.noPool",
  NO_TARGET: "conduit.noTarget" });

function spawnPayload(decision, round) {
  const orNull = (v) => (v === undefined ? null : v);
  return { round, factionId: orNull(decision.factionId), profileId: orNull(decision.profileId),
    targetSystemId: orNull(decision.targetSystemId), captureRangeJumps: orNull(decision.captureRangeJumps) };
}

function profileEligible(profile, registry) {
  const f = registry.getFaction(profile.factionId);
  return f && f.kind === "invader" && registry.isActive(profile.factionId);
}

function getProfiles(registry) {
  const { PROFILES } = require("./data/invaderProfiles");
  return PROFILES.map((p) => ({
    profileId: p.profileId,
    factionId: p.factionId,
    weight: p.weight,
    captureRangeJumps: p.captureRangeJumps,
    withdrawAfterKey: p.withdrawAfterKey,
    keepsConquest: p.keepsConquest,
    consolidates: p.consolidates,
    package: p.package,
    eligible: profileEligible(p, registry),
    ...(typeof p.targetListKey === "string" ? { targetListKey: p.targetListKey } : {}),
  }));
}

function refusalText(result) {
  const r = result && result.reason === "APPLY_REFUSED" && result.refusal ? result.refusal : (result || {});
  let text = String(r.reason || "SPAWN_REFUSED");
  if (r.detail !== undefined) text += ` (${String(r.detail)})`;
  if (r.code) text += ` [${String(r.code)}]`;
  else if (r.error) text += ` [${String((r.error && r.error.message) || r.error)}]`;
  return text;
}

function createInvasionService(deps) {
  const { store, journal, repository, fleets, scheduler, graph, world, stations, presence,
    sovClaims, strategy, occupation, battle, config, clock, telemetry, logger, nowMs, ids, worldSeed } = deps;

  const invasionsConfig = config.invasions || {};
  const abyssalConfig = config.abyssal || {};
  const attentionOn = abyssalConfig.enabled === true && abyssalConfig.pressureEnabled === true;
  const seasonsConfig = config.seasons || {};
  const seasonBiasOn = seasonsConfig.enabled === true && seasonsConfig.invasionBiasEnabled === true;
  const params = Object.freeze({
    ...(attentionOn ? { attentionWeightPermille: abyssalConfig.pressureWeightPermille } : {}),
    chancePermille: invasionsConfig.chancePermille,
    maxActive: invasionsConfig.maxActive,
    maxActivePerFaction: invasionsConfig.maxActivePerFaction,
    weightFree: invasionsConfig.weightFree,
    weightActive: invasionsConfig.weightActive,
    weightControlled: invasionsConfig.weightControlled,
    avoidObservedSystems: invasionsConfig.avoidObservedSystems,
    avoidStationSystems: invasionsConfig.avoidStationSystems,
    avoidCampaignTheatres: invasionsConfig.avoidCampaignTheatres,
    requireSovCheck: invasionsConfig.requireSovCheck,
    beachheadCaptureRangeJumps: Math.min(invasionsConfig.beachheadCaptureRangeJumps, config.graph.routeMaxJumps),
    targetSampleSize: Math.min(invasionsConfig.targetSampleSize, 256),
    checkIntervalMs: invasionsConfig.checkIntervalMs,
    holdMinFleets: invasionsConfig.holdMinFleets,
    maxFleetsReadPerStep: invasionsConfig.maxFleetsReadPerStep,
    maxStepsPerPass: invasionsConfig.maxStepsPerPass,
    retentionMs: invasionsConfig.retentionMs,
    pruneBatch: invasionsConfig.pruneBatch,
    withdrawRetryMs: invasionsConfig.withdrawRetryMs,
    withdrawMaxRounds: invasionsConfig.withdrawMaxRounds,
  });

  const coreIndex = deps.coreIndex || getCoreIndex(config);

  const ieConfig = config.invaderEconomy || {};
  const conduitOn = ieConfig.enabled === true && ieConfig.conduitEnabled === true;
  const conduitFactions = Object.entries(INVADER_ECONOMY_FACTIONS)
    .map(([factionId, prefix]) => ({ factionId: Number(factionId), prefix, C: ieConfig[prefix] }))
    .filter((x) => x.C && Number.isSafeInteger(x.C.conduitMaxActive) && x.C.conduitMaxActive > 0)
    .sort((a, b) => a.factionId - b.factionId);
  const hqConfig = config.strategy || {};
  const hqRoles = hqConfig.hqGarrisonEnabled === true ? parseFleetRoleList(hqConfig.hqGarrisonRoles) : null;
  const hqReserve = hqRoles && hqRoles.includes(POOL_ROLE) && Number.isSafeInteger(hqConfig.hqGarrisonMinFleets)
    ? Math.max(0, hqConfig.hqGarrisonMinFleets) : 0;
  const conduitSlots = conduitOn ? conduitFactions.reduce((s, x) => s + x.C.conduitMaxActive, 0) : 0;
  const treasuryOf = () => (typeof deps.getTreasury === "function" ? deps.getTreasury() : null);

  const originObservatories = Boolean(invasionsConfig.drifters && invasionsConfig.drifters.originObservatories === true);
  const listSets = new Map();
  let listWarned = false;

  const counters = Object.create(null);
  COUNTER_NAMES.filter((n) => (conduitOn || !n.startsWith("conduit."))
    && (originObservatories || !TARGET_LIST_COUNTERS.includes(n))
    && (attentionOn || !ATTENTION_COUNTERS.includes(n))
    && (seasonBiasOn || !SEASON_BIAS_COUNTERS.includes(n))).forEach((n) => { counters[n] = 0; });
  let lastDecision = null;
  let lastConduitDecision = null;
  let lastRefusal = null;
  let stopped = false;
  let rollHandler = null;
  let stepHandler = null;

  function bump(counts, name, n = 1) { if (n > 0) counts.push([name, n]); }
  function metric(kind, name, value) { if (telemetry && typeof telemetry[kind] === "function") { try { telemetry[kind](name, value); } catch (_err) {} } }
  function flush(counts) {
    for (const [name, n] of counts) {
      counters[name] += n;
      metric("count", `world.invasions.${name}`, n);
    }
  }
  function elapsedSince(t0) { return typeof nowMs === "function" && Number.isFinite(t0) ? Math.max(0, nowMs() - t0) : 0; }
  function startMs() { return typeof nowMs === "function" ? nowMs() : NaN; }
  function rollCommitted(counts, t0, warns = []) {
    return (value) => {
      flush(counts);
      for (const { kind, detail, line } of warns) {
        if (kind === "TARGET_LIST") {
          if (!listWarned) { listWarned = true; log(line); }
          continue;
        }
        if (theatreWarned.has(kind)) continue;
        theatreWarned.add(kind);
        log(`[LivingNewEden] invasions: theatre filter off this roll (${kind}: ${detail})`);
      }
      if (value && typeof value.refusal === "string") {
        lastRefusal = value.refusal;
        log(`[LivingNewEden] invasions: ${value.refusal}`);
      }
      metric("observe", "world.invasions.rollMs", elapsedSince(t0));
    };
  }
  function stepCommitted(counts, t0) {
    return () => { flush(counts); metric("observe", "world.invasions.stepMs", elapsedSince(t0)); };
  }

  function log(line) { try { logger && logger.log && logger.log(line); } catch (_err) {} }

  function withdrawAfterMsOf(profile) {
    const key = profile && profile.withdrawAfterKey;
    const v = key ? invasionsConfig[key] : 0;
    return Number.isSafeInteger(v) && v > 0 ? v : 0;
  }

  function effectiveWithdrawAtOf(row) {
    const { PROFILES } = require("./data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === row.profile_id);
    return M.effectiveWithdrawAt(row.withdraw_at, row.started_at, withdrawAfterMsOf(profile));
  }

  const theatreWarned = new Set();
  function theatreUnavailable(counts, warns) {
    return (kind, detail) => { bump(counts, "theatreFilterUnavailable"); warns.push({ kind, detail }); };
  }

  function loadTargetLists() {
    if (!originObservatories) return [];
    const { PROFILES } = require("./data/invaderProfiles");
    const missing = [];
    for (const p of PROFILES) {
      if (typeof p.targetListKey !== "string" || listSets.has(p.profileId)) continue;
      let r;
      try {
        r = typeof deps.readTrigDrifterSystemList === "function" ? deps.readTrigDrifterSystemList(p.targetListKey)
          : { ok: false, reason: "SEAM_UNAVAILABLE", detail: "no_adapter" };
      } catch (err) {
        r = { ok: false, reason: "SEAM_UNAVAILABLE", detail: `threw: ${String((err && err.message) || err)}` };
      }
      if (r && r.ok === true && Array.isArray(r.systemIds) && r.systemIds.length > 0) {
        listSets.set(p.profileId, new Set(r.systemIds));
      } else {
        missing.push({ profileId: p.profileId, detail: `${String(r && r.reason)}${r && r.detail ? ` ${r.detail}` : ""}` });
      }
    }
    return missing;
  }

  function attentionRegions(counts) {
    if (!attentionOn) return null;
    const threshold = abyssalConfig.pressureThresholdMilli;
    let r = null;
    try {
      const abyssal = typeof deps.getAbyssal === "function" ? deps.getAbyssal() : null;
      r = abyssal && typeof abyssal.topRegions === "function" ? abyssal.topRegions(ATTENTION_TOP_REGIONS) : null;
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !Array.isArray(r.regions)) {
      bump(counts, "attentionUnavailable");
      return new Set();
    }
    return new Set(r.regions.filter((x) => x && x.milli >= threshold).map((x) => x.regionId));
  }

  function seasonBiasOf(counts) {
    if (!seasonBiasOn) return undefined;
    let r = null;
    try {
      const seasons = typeof deps.getSeasons === "function" ? deps.getSeasons() : null;
      r = seasons && typeof seasons.current === "function" ? seasons.current() : null;
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true) {
      bump(counts, "seasonBiasUnavailable");
      return undefined;
    }
    const s = r.season;
    if (!s || !SEASON_RUNNING_STATES.includes(s.state) || !Number.isSafeInteger(s.factionId)) return undefined;
    const { PROFILES } = require("./data/invaderProfiles");
    if (!PROFILES.some((p) => p.factionId === s.factionId)) {
      bump(counts, "seasonBiasNoProfile");
      return undefined;
    }
    return { factionId: s.factionId, permille: seasonsConfig.invasionBiasPermille };
  }

  function rollProfilesOf(profiles) {
    return profiles.map((p) => {
      if (typeof p.targetListKey !== "string" || listSets.has(p.profileId)) return p;
      const { targetListKey: _drop, ...rest } = p;
      return rest;
    });
  }

  function readSampledInTx(tx, graphApi, sampledSystems, list, counts, warns, hot = null) {
    const sampled = [];
    const registry = strategy && strategy.registry ? strategy.registry : null;
    const theatreCampaignIds = P.activeTheatreCampaignIds(strategy, theatreUnavailable(counts, warns));
    for (const sysId of sampledSystems) {
      const sys = graphApi.getSystem(sysId);
      if (!sys) continue;
      const occRow = repository.getSystem(tx, sysId, { includeInfluence: false });
      const row = occRow.ok ? occRow.system : null;
      const liveStations = (() => {
        const st = typeof stations?.getMode === "function" ? stations.getMode() : "off";
        if (st !== "ready" || !stations?.repository) return 0;
        const c = stations.repository.countLiveBySystem(tx, [sysId]);
        return c.ok ? c.rows.reduce((sum, r) => sum + r.count, 0) : 0;
      })();
      const observed = presence && typeof presence.isObserved === "function" ? presence.isObserved(sysId) : false;
      let claimed = null;
      if (params.requireSovCheck) {
        const claim = sovClaims.claimOf(sysId);
        claimed = claim && claim.ok === true ? claim.claimed === true : null;
      }
      const inTheatre = P.inCampaignTheatre(theatreCampaignIds, registry, sysId);
      const openBeachhead = list.ok && list.invasions.some((inv) => inv.beachhead_system_id === sysId);
      const core = coreOwnerOf(coreIndex, sysId) !== null;
      const entry = { systemId: sysId, row, liveStations, observed, claimed, inTheatre, openBeachhead, core,
        category: P.controllerCategoryOf(row ? row.controllerFactionId : null, registry) };
      if (originObservatories && listSets.size > 0) {
        const lists = {};
        for (const [profileId, set] of listSets) lists[profileId] = set.has(sysId);
        entry.lists = lists;
      }
      if (hot !== null) entry.attention = hot.has(sys.regionId);
      sampled.push(entry);
    }
    return sampled;
  }

  function registerRollHandler() {
    if (rollHandler) return;
    rollHandler = scheduler.registerHandler(S.EVENT_TYPE_ROLL, rollHandlerFn, { maxPerPass: 1 });
  }

  function rollHandlerFn(ev, hctx) {
    const counts = [];
    const warns = [];
    const t0 = startMs();
    try {
      if (stopped) return { ok: false, reason: "INVASIONS_STOPPED" };
      const payload = ev && ev.payload;
      if (!payload || typeof payload !== "object" || !Number.isSafeInteger(payload.round)) {
        return { ok: false, reason: "INVASION_ROLL_PAYLOAD_INVALID", permanent: true };
      }
      const round = payload.round;
      if (round < 0) return { ok: false, reason: "INVASION_ROLL_PAYLOAD_INVALID", permanent: true };

      const g = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      if (!g || !g.ok || !g.graph) {
        return { ok: false, reason: "GRAPH_NOT_READY" };
      }

      const missingLists = loadTargetLists();
      if (missingLists.length > 0) {
        bump(counts, "targetListUnavailable");
        warns.push({ kind: "TARGET_LIST", line: "[LivingNewEden] invasions: WARN target list unavailable, rolling "
          + `without the filter (${missingLists.map((m) => `${m.profileId}: ${m.detail}`).join(", ")})` });
      }
      const hot = attentionRegions(counts);
      const seasonBias = seasonBiasOf(counts);

      const readResult = store.transaction("invasions.rollRead", (tx) => {
        const conduitOpen = conduitOn && R.countOpenConduit(tx).ok ? R.countOpenConduit(tx).count : 0;
        const openTotal = (R.countOpen(tx).ok ? R.countOpen(tx).count : 0) - conduitOpen;
        const openByFaction = new Map();
        const list = R.listOpen(tx, { limit: params.maxActive * 2 + conduitSlots });
        if (list.ok) {
          for (const inv of list.invasions) {
            if (conduitOn && S.isConduitInvasionId(inv.invasion_id)) continue;
            openByFaction.set(inv.faction_id, (openByFaction.get(inv.faction_id) || 0) + 1);
          }
        }
        const pool = P.candidatePool(g.graph);
        const sampleSeed = deriveSeed(worldSeed || 0, "invasions", "sample", round);
        const sampledSystems = P.sampleTargets(pool, createRng(sampleSeed), params.targetSampleSize);
        const sampled = readSampledInTx(tx, g.graph, sampledSystems, list, counts, warns, hot);
        const stationsReady = (() => {
          const st = typeof stations?.getMode === "function" ? stations.getMode() : "off";
          return st === "ready";
        })();

        return { ok: true, value: { openTotal, openByFaction, pool, sampledSystems, sampled, stationsReady, sampleSeed } };
      });

      if (!readResult.ok) return readResult;
      const data = readResult.value && readResult.value.value ? readResult.value.value : readResult.value;
      const { openTotal, openByFaction, sampled, stationsReady, sampleSeed } = data;

      const profiles = rollProfilesOf(getProfiles(strategy.registry));
      const rollSeed = deriveSeed(worldSeed || 0, "invasions", "roll", round);
      const snapshot = { round, rollSeed, sampleSeed, openTotal, openByFaction, profiles, sampled, stationsReady };

      const decision = P.planRoll(snapshot, seasonBias ? { ...params, seasonBias } : params, createRng(rollSeed));
      if (seasonBias && decision.factionId === seasonBias.factionId) bump(counts, "seasonBoosted");
      const listed = typeof decision.factionId === "number"
        ? profiles.find((p) => p.factionId === decision.factionId && typeof p.targetListKey === "string") : null;
      if (listed && sampled.some((s) => P.eligibleTarget(s, listed.factionId, params)
        && !P.eligibleTarget(s, listed.factionId, params, listed))) bump(counts, "targetListFiltered");
      if (attentionOn && decision.outcome === "SPAWN" && ATTENTION_FACTIONS.abyssal.includes(decision.factionId)
        && sampled.some((s) => s.systemId === decision.targetSystemId && s.attention === true)) {
        bump(counts, "attentionBoosted");
      }
      const invasionId = decision.outcome === "SPAWN" ? S.invasionId(round) : null;
      let fleetIds = null;
      if (decision.outcome === "SPAWN") {
        const { PROFILES } = require("./data/invaderProfiles");
        const profile = PROFILES.find((p) => p.profileId === decision.profileId);
        if (profile) {
          fleetIds = [];
          for (let i = 0; i < profile.package.length; i += 1) {
            const pkg = profile.package[i];
            for (let c = 0; c < pkg.count; c += 1) {
              if (fleetIds.length >= MAX_PACKAGE_FLEETS) break;
              fleetIds.push(S.fleetKey(invasionId, fleetIds.length));
            }
          }
        }
      }
      lastDecision = { round, outcome: decision.outcome, factionId: decision.factionId, targetSystemId: decision.targetSystemId, invasionId, fleetIds, captureRangeJumps: decision.captureRangeJumps };

      bump(counts, "rolls");
      bump(counts, decision.outcome === "SPAWN" ? "spawnDecision" : decision.outcome === "NO_ROLL" ? "noRoll" :
        decision.outcome === "NO_ROOM" ? "noRoom" : decision.outcome === "NO_FACTION" ? "noFaction" :
        decision.outcome === "NO_TARGET" ? "noTarget" : decision.outcome === "SOV_UNAVAILABLE" ? "sovUnavailable" :
        decision.outcome === "STATIONS_NOT_READY" ? "stationsNotReady" : "noRoll");

      return {
        ok: true,
        outcome: decision.outcome,
        effect: (tx) => {
          const rollKey = S.rollKey(round);
          const jr = journal.applyOnce(tx, { key: rollKey, aggregate: { type: S.AGGREGATE_ROLL, id: "roll" },
            eventType: "INVASION_ROLLED", payload: decision }, () => ({ ok: true }));
          if (!jr.ok) return jr;

          let refusal;
          if (decision.outcome === "SPAWN" && jr.duplicate !== true) {
            const spawnCounts = [];
            const sj = journal.applyOnce(tx, { key: S.spawnKey(invasionId), aggregate: { type: S.AGGREGATE_INVASION, id: invasionId },
              eventType: "INVASION_SPAWNED", payload: spawnPayload(decision, round) },
            (db) => spawnInTx(db, decision, round, hctx.now, spawnCounts));
            if (!sj.ok) {
              bump(counts, "spawnRefused");
              refusal = `spawn refused: ${refusalText(sj)}`;
            } else if (sj.duplicate !== true) {
              for (const c of spawnCounts) counts.push(c);
              bump(counts, "spawned");
            }
          }

          const endedBefore = hctx.now - params.retentionMs;
          if (endedBefore > 0 && params.pruneBatch > 0) {
            const pr = R.pruneEndedInTx(tx, { endedBefore, limit: params.pruneBatch });
            if (pr.ok) bump(counts, "pruned", pr.deleted);
          }

          const nextRound = round + 1;
          const I = invasionsConfig.rollIntervalMs;
          const phi = deriveSeed(worldSeed || 0, "invasions", "phase") % I;
          const dueAt = nextRound * I + phi;
          const nextKey = S.rollKey(nextRound);
          const r2 = scheduler.enqueue(S.EVENT_TYPE_ROLL, "roll", dueAt, { round: nextRound }, nextKey, { tx, chained: true });
          if (!r2 || !r2.ok) return { ok: false, reason: "ENQUEUE_FAILED" };

          return refusal ? { ok: true, refusal } : { ok: true };
        },
        onCommitted: rollCommitted(counts, t0, warns),
      };
    } catch (err) {
      return { ok: false, reason: `INVASION_ROLL_HANDLER_FAILED: ${String(err)}` };
    }
  }

  function spawnInTx(tx, decision, round, at, counts, conduit = null) {
    const { factionId, profileId, targetSystemId, captureRangeJumps } = decision;
    const invasionId = conduit ? conduit.invasionId : S.invasionId(round);
    const spawnKey = S.spawnKey(invasionId);

    if (conduit) {
      const open = R.countOpenConduit(tx, { factionId });
      if (!open.ok || open.count >= conduit.maxActive) return { ok: false, reason: "INVASION_TARGET_CHANGED" };
    } else {
      const conduitOpen = conduitOn && R.countOpenConduit(tx).ok ? R.countOpenConduit(tx).count : 0;
      const openTotal = (R.countOpen(tx).ok ? R.countOpen(tx).count : 0) - conduitOpen;
      if (openTotal >= params.maxActive) return { ok: false, reason: "INVASION_TARGET_CHANGED" };
      const openByFaction = new Map();
      const list = R.listOpen(tx);
      if (list.ok) {
        for (const inv of list.invasions) {
          if (conduitOn && S.isConduitInvasionId(inv.invasion_id)) continue;
          openByFaction.set(inv.faction_id, (openByFaction.get(inv.faction_id) || 0) + 1);
        }
      }
      if ((openByFaction.get(factionId) || 0) >= params.maxActivePerFaction) {
        return { ok: false, reason: "INVASION_TARGET_CHANGED" };
      }
    }

    let sysRow;
    try {
      sysRow = repository.getSystem(tx, targetSystemId, { includeInfluence: false });
    } catch (_err) {
      return { ok: false, reason: "INVASION_TARGET_CHANGED" };
    }
    if (!sysRow.ok || !sysRow.system) return { ok: false, reason: "INVASION_TARGET_CHANGED" };
    const sys = sysRow.system;
    if (sys.occupationState !== "STABLE" || sys.controllerFactionId === factionId) {
      return { ok: false, reason: "INVASION_TARGET_CHANGED" };
    }

    if (params.avoidStationSystems) {
      const st = typeof stations?.getMode === "function" ? stations.getMode() : "off";
      if (st === "ready" && stations?.repository) {
        const c = stations.repository.countLiveBySystem(tx, [targetSystemId]);
        if (c.ok && c.rows.reduce((sum, r) => sum + r.count, 0) > 0) return { ok: false, reason: "INVASION_TARGET_CHANGED" };
      }
    }

    const { PROFILES } = require("./data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === profileId);
    if (!profile) return { ok: false, reason: "INVASION_INVALID_INPUT" };

    const registry = strategy.registry;
    const doctrine = registry.getDoctrine(profile.doctrineId);
    if (!doctrine) return { ok: false, reason: "INVASION_INVALID_INPUT" };

    const fleetIds = [];
    for (let i = 0; i < profile.package.length; i += 1) {
      const pkg = profile.package[i];
      const template = doctrine.templates && doctrine.templates[pkg.role];
      if (!template) {
        return { ok: false, reason: "INVASION_PROFILE_INVALID", detail: `missing template for role ${pkg.role}` };
      }
      for (let c = 0; c < pkg.count; c += 1) {
        if (fleetIds.length >= MAX_PACKAGE_FLEETS) {
          return { ok: false, reason: "FLEET_LIMIT" };
        }
        const corpId = registry.corporationFor(factionId, pkg.role);
        const fleet = fleets.repository.createFleet(tx, {
          factionId,
          corporationId: corpId,
          currentSystemId: targetSystemId,
          homeSystemId: targetSystemId,
          fleetRole: pkg.role,
          doctrineId: profile.doctrineId,
          composition: template.map((e) => ({ hullGroup: e.hullGroup, count: e.count })),
        }, S.fleetKey(invasionId, fleetIds.length));
        if (!fleet.ok) {
          if (fleet.reason === "FLEET_LIMIT") {
            return { ok: false, reason: "FLEET_LIMIT" };
          }
          return { ok: false, reason: "FLEET_CREATE_FAILED" };
        }
        fleetIds.push(fleet.fleetId);
      }
    }
    const bonus = conduit && Number.isSafeInteger(conduit.bonusFleets) ? conduit.bonusFleets : 0;
    if (bonus > 0) {
      const template = doctrine.templates && doctrine.templates[BONUS_ROLE];
      if (!template) {
        return { ok: false, reason: "INVASION_PROFILE_INVALID", detail: `missing template for role ${BONUS_ROLE}` };
      }
      for (let c = 0; c < bonus; c += 1) {
        if (fleetIds.length >= MAX_PACKAGE_FLEETS) return { ok: false, reason: "FLEET_LIMIT" };
        const fleet = fleets.repository.createFleet(tx, { factionId,
          corporationId: registry.corporationFor(factionId, BONUS_ROLE), currentSystemId: targetSystemId,
          homeSystemId: targetSystemId, fleetRole: BONUS_ROLE, doctrineId: profile.doctrineId,
          composition: template.map((e) => ({ hullGroup: e.hullGroup, count: e.count })) },
        S.fleetKey(invasionId, fleetIds.length));
        if (!fleet.ok) {
          return { ok: false, reason: fleet.reason === "FLEET_LIMIT" ? "FLEET_LIMIT" : "FLEET_CREATE_FAILED" };
        }
        fleetIds.push(fleet.fleetId);
      }
    }

    const after = conduit && conduit.withdrawAfterMs > 0 ? conduit.withdrawAfterMs : withdrawAfterMsOf(profile);
    const withdrawAt = after > 0 ? at + after : null;
    const plan = {
      v: 1, seed: decision.rollSeed, round, profileVersion: require("./data/invaderProfiles").INVADER_PROFILES_VERSION,
      label: profile.label, package: profile.package, holdMinFleets: params.holdMinFleets,
      withdrawAfterMs: after > 0 ? after : null, consolidates: profile.consolidates,
      keepsConquest: profile.keepsConquest === true,
      ...(conduit ? { conduit: true, bonusFleets: bonus } : {}),
    };

    const ins = R.insertInvasionInTx(tx, {
      invasionId, idempotencyKey: spawnKey, rollRound: conduit ? conduit.rollRound : round, factionId, profileId,
      beachheadSystemId: targetSystemId, captureRangeJumps, fleetIds, plan, startedAt: at, withdrawAt,
    });
    if (!ins.ok) return ins;

    const occKey = S.occKey(invasionId);
    const occResult = occupation.signalInTx(tx, {
      systemId: targetSystemId, factionId, signal: "INVASION", at,
    }, occKey);
    if (!occResult.ok || occResult.outcome !== "STARTED") {
      return { ok: false, reason: "OCCUPATION_SIGNAL_FAILED", detail: String(occResult.reason || occResult.outcome || "unknown") };
    }

    const contactResult = battle.requestContactCheckInTx(tx, {
      systemId: targetSystemId, at, key: S.contactKey(targetSystemId, invasionId), triggerFleetId: fleetIds[0],
    });
    if (!contactResult.ok) {
      bump(counts, "contactRefused");
    }

    const totals = R.bumpTotalsInTx(tx, factionId, { started: 1 }, at);
    if (!totals.ok) return totals;

    const stepKey = S.stepKey(invasionId, 0, params.checkIntervalMs, Math.floor(at / params.checkIntervalMs));
    const stepEnq = scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, at + params.checkIntervalMs,
      { invasionId, seq: 0, trigger: "tick" }, stepKey, { tx, chained: true });
    if (!stepEnq || !stepEnq.ok) return { ok: false, reason: "ENQUEUE_FAILED", detail: String((stepEnq && stepEnq.reason) || "unknown") };

    return { ok: true, invasionId };
  }

  let conduitHandler = null;
  function registerConduitHandler() {
    if (conduitHandler) return;
    conduitHandler = scheduler.registerHandler(S.EVENT_TYPE_CONDUIT_ROLL, conduitHandlerFn, { maxPerPass: 1 });
  }

  function conduitDueAt(round) {
    const I = invasionsConfig.rollIntervalMs;
    return round * I + (deriveSeed(worldSeed || 0, "invasions", "conduit-phase") % I);
  }

  function poolFleetsInTx(tx, factionId, hq) {
    const fl = fleets.repository.listFleetsInSystem(tx, hq, { states: ["IDLE"],
      limit: params.maxFleetsReadPerStep + 1 });
    if (!fl.ok) return fl;
    const truncated = fl.fleets.length > params.maxFleetsReadPerStep;
    const own = fl.fleets.slice(0, params.maxFleetsReadPerStep).filter((f) => f.factionId === factionId
      && f.fleetRole === POOL_ROLE && f.homeSystemId === hq && f.operationId === null && f.refitPending !== true);
    const held = hqReserve > 0 ? hqHoldersOf(own) : null;
    const pool = (held ? own.filter((f) => !held.has(f.fleetId)) : own).map((f) => ({ fleetId: f.fleetId }));
    return { ok: true, pool, truncated };
  }

  function hqHoldersOf(own) {
    const table = strategy && strategy.powerTable ? strategy.powerTable : {};
    const ranked = own.map((f) => ({ fleetId: f.fleetId, strength: strengthOf(f.composition, table) }))
      .sort((a, b) => (b.strength - a.strength) || (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0)));
    return new Set(ranked.slice(0, hqReserve).map((x) => x.fleetId));
  }

  function conduitHandlerFn(ev, hctx) {
    const counts = [];
    const warns = [];
    const t0 = startMs();
    try {
      if (stopped) return { ok: false, reason: "INVASIONS_STOPPED" };
      const payload = ev && ev.payload;
      if (!payload || typeof payload !== "object" || !Number.isSafeInteger(payload.round) || payload.round < 0) {
        return { ok: false, reason: "INVASION_ROLL_PAYLOAD_INVALID", permanent: true };
      }
      if (!conduitOn || conduitFactions.length === 0) return { ok: true, outcome: "OFF" };
      const round = payload.round;
      const g = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      if (!g || !g.ok || !g.graph) return { ok: false, reason: "GRAPH_NOT_READY" };

      const { PROFILES } = require("./data/invaderProfiles");
      const pick = conduitFactions[round % conduitFactions.length];
      const factionId = pick.factionId;
      const profile = PROFILES.find((p) => p.factionId === factionId) || null;
      const registry = strategy.registry;
      const entry = registry && typeof registry.getFaction === "function" ? registry.getFaction(factionId) : null;
      const hq = entry && Number.isSafeInteger(entry.hqSystemId) ? entry.hqSystemId : null;
      const eligible = profile !== null && hq !== null && profileEligible(profile, registry);
      const at = hctx.now;
      const readResult = store.transaction("invasions.conduitRead", (tx) => {
        const open = R.countOpenConduit(tx, { factionId });
        if (!open.ok) return open;
        const today = R.countConduitSince(tx, { factionId, since: Math.floor(at / DAY_MS) * DAY_MS });
        if (!today.ok) return today;
        const t = treasuryOf();
        const acct = t && typeof t.readMercAccountInDb === "function" ? t.readMercAccountInDb(tx, factionId) : null;
        const known = Boolean(acct && acct.ok && acct.mode === "ready" && acct.seeded);
        const pool = hq !== null ? poolFleetsInTx(tx, factionId, hq) : { ok: true, pool: [], truncated: false };
        if (!pool.ok) return pool;
        const list = R.listOpen(tx, { limit: params.maxActive * 2 + conduitSlots });
        const sampleSeed = deriveSeed(worldSeed || 0, "invasions", "conduit-sample", round);
        const sampledSystems = P.sampleTargets(P.candidatePool(g.graph), createRng(sampleSeed),
          params.targetSampleSize);
        const sampled = readSampledInTx(tx, g.graph, sampledSystems, list, counts, warns);
        const st = typeof stations?.getMode === "function" ? stations.getMode() : "off";
        return { ok: true, value: { conduitOpen: open.count, spawnedToday: today.count,
          balanceIsk: known ? acct.balanceIsk : null, accountMode: known ? acct.accountMode : null,
          poolFleets: pool.pool, poolTruncated: pool.truncated, sampled, stationsReady: st === "ready" } };
      });
      if (!readResult.ok) return readResult;
      if (readResult.value && readResult.value.ok === false) return readResult.value;
      const data = readResult.value && readResult.value.value ? readResult.value.value : readResult.value;

      const seed = deriveSeed(worldSeed || 0, "invasions", "conduit", round);
      const snapshot = { round, factionId, profileId: profile ? profile.profileId : null,
        captureRangeJumps: profile && profile.captureRangeJumps !== null && profile.captureRangeJumps !== undefined
          ? profile.captureRangeJumps : params.beachheadCaptureRangeJumps,
        packageFleets: profile ? profile.package.reduce((s, e) => s + e.count, 0) : 0,
        maxPackageFleets: MAX_PACKAGE_FLEETS, ...data };
      const C = { ...pick.C, ...(eligible ? {} : { conduitMaxActive: 0 }), target: params };
      const planned = planConduit(snapshot, C, createRng(seed));
      const decision = { ...planned, rollSeed: seed };
      lastConduitDecision = { round, outcome: decision.outcome, factionId, targetSystemId: decision.targetSystemId,
        bonusFleets: decision.bonusFleets, iskCost: decision.iskCost };
      if (decision.outcome !== "OFF") bump(counts, "conduit.rolls");
      if (CONDUIT_OUTCOME_COUNTERS[decision.outcome]) bump(counts, CONDUIT_OUTCOME_COUNTERS[decision.outcome]);

      return {
        ok: true,
        outcome: decision.outcome,
        effect: (tx) => {
          const key = S.conduitRollKey(round);
          const prior = journal.findByKey(tx, key);
          if (!prior.ok) return prior;
          let refusal;
          if (!prior.found) {
            const jr = journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE_ROLL, id: "conduit" },
              eventType: "INVASION_CONDUIT_ROLLED", payload: decision }, () => ({ ok: true }));
            if (!jr.ok) return jr;
            if (decision.outcome === "SPAWN" && jr.duplicate !== true) {
              const invasionId = S.conduitInvasionId(round);
              const spawnCounts = [];
              const sj = journal.applyOnce(tx, { key: S.spawnKey(invasionId),
                aggregate: { type: S.AGGREGATE_INVASION, id: invasionId }, eventType: "INVASION_SPAWNED",
                payload: { ...spawnPayload(decision, round), conduit: true, bonusFleets: decision.bonusFleets,
                  iskCost: decision.iskCost, poolFleetIds: decision.poolFleetIds } },
              (db) => conduitSpawnInTx(db, decision, round, at, hq, pick.C, spawnCounts));
              if (!sj.ok) {
                bump(counts, "conduit.spawnRefused");
                refusal = `conduit spawn refused: ${refusalText(sj)}`;
              } else if (sj.duplicate !== true) {
                for (const c of spawnCounts) counts.push(c);
                bump(counts, "conduit.spawned");
              }
            }
          }
          const nextRound = round + 1;
          const r2 = scheduler.enqueue(S.EVENT_TYPE_CONDUIT_ROLL, "conduit", conduitDueAt(nextRound),
            { round: nextRound }, S.conduitRollKey(nextRound), { tx, chained: true });
          if (!r2 || !r2.ok) return { ok: false, reason: "ENQUEUE_FAILED" };
          return refusal ? { ok: true, refusal } : { ok: true };
        },
        onCommitted: rollCommitted(counts, t0, warns),
      };
    } catch (err) {
      return { ok: false, reason: `INVASION_CONDUIT_HANDLER_FAILED: ${String(err)}` };
    }
  }

  function conduitSpawnInTx(db, decision, round, at, hq, C, counts) {
    const invasionId = S.conduitInvasionId(round);
    const spawnKey = S.spawnKey(invasionId);
    const { factionId } = decision;
    if (decision.iskCost > 0) {
      const t = treasuryOf();
      if (!t || typeof t.chargeWarSpendInTx !== "function") return { ok: false, reason: "TREASURY_OFF" };
      const paid = t.chargeWarSpendInTx(db, { factionId, isk: decision.iskCost, at }, `${spawnKey}:isk`);
      if (!paid.ok) return { ok: false, reason: String(paid.reason), detail: paid.detail };
      if (paid.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${spawnKey}:isk` };
    }
    const ids = Array.isArray(decision.poolFleetIds) ? decision.poolFleetIds : [];
    if (ids.length > 0) {
      const got = fleets.repository.getFleets(db, ids);
      if (!got.ok) return { ok: false, reason: "POOL_READ_FAILED", detail: String(got.reason) };
      const byId = new Map(got.fleets.map((f) => [f.fleetId, f]));
      for (let i = 0; i < ids.length; i += 1) {
        const f = byId.get(ids[i]);
        if (!f || f.state !== "IDLE" || f.factionId !== factionId || f.fleetRole !== POOL_ROLE || f.homeSystemId !== hq
          || f.currentSystemId !== hq || f.operationId !== null || f.refitPending === true) {
          return { ok: false, reason: "POOL_CHANGED", detail: ids[i] };
        }
        const r = fleets.repository.disband(db, { fleetId: f.fleetId, expectedVersion: f.version, systemId: hq,
          fleetRole: POOL_ROLE }, `${spawnKey}:pool:${i}`);
        if (!r.ok) return { ok: false, reason: "POOL_DISBAND_REFUSED", detail: String(r.reason) };
        if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${spawnKey}:pool:${i}` };
      }
    }
    return spawnInTx(db, decision, round, at, counts, { invasionId, rollRound: S.CONDUIT_ROUND_BASE + round,
      bonusFleets: decision.bonusFleets, withdrawAfterMs: C.conduitWithdrawAfterMs, maxActive: C.conduitMaxActive });
  }

  function registerStepHandler() {
    if (stepHandler) return;
    stepHandler = scheduler.registerHandler(S.EVENT_TYPE_STEP, stepHandlerFn, { maxPerPass: params.maxStepsPerPass });
  }

  function stepHandlerFn(ev, hctx) {
    const counts = [];
    const t0 = startMs();
    try {
      if (stopped) return { ok: false, reason: "INVASIONS_STOPPED" };
      const payload = ev && ev.payload;
      if (!payload || !payload.invasionId || !Number.isSafeInteger(payload.seq)) {
        return { ok: false, reason: "INVASION_STEP_PAYLOAD_INVALID", permanent: true };
      }
      const { invasionId, seq, trigger } = payload;
      const at = hctx.now;

      const readResult = store.transaction("invasions.stepRead", (tx) => {
        const inv = R.getInvasion(tx, invasionId);
        if (!inv.ok || !inv.invasion) return { ok: false, reason: "INVASION_NOT_FOUND" };
        const invasion = inv.invasion;
        if (invasion.state === S.STATE_ENDED) return { ok: true, value: { invasion, holders: 0, holdersTruncated: false, stale: true } };
        if (invasion.step_seq !== seq) return { ok: true, value: { invasion, holders: 0, holdersTruncated: false, stale: true } };

        const fl = fleets.repository.listFleetsInSystem(tx, invasion.beachhead_system_id, {
          states: HOLD_STATES, limit: params.maxFleetsReadPerStep + 1,
        });
        if (!fl.ok) return fl;
        const holders = fl.fleets.filter((f) => f.factionId === invasion.faction_id).length;
        const holdersTruncated = fl.fleets.length > params.maxFleetsReadPerStep;

        let liveFleets = [];
        let beachhead = { controller: null, capturedAt: null, occupationState: null };
        if (invasion.state === S.STATE_WITHDRAWING) {
          let fleetIds;
          try {
            fleetIds = JSON.parse(invasion.fleet_ids_json || "[]");
          } catch (_err) {
            fleetIds = null;
          }
          if (!Array.isArray(fleetIds)) {
            return { ok: false, reason: "INVASION_FLEET_IDS_INVALID", invasionId, permanent: true };
          }
          const got = fleets.repository.getFleets(tx, fleetIds);
          if (!got.ok) return { ok: false, reason: `INVASION_FLEETS_READ_FAILED:${got.reason}`, invasionId,
            permanent: got.reason === "FLEET_INVALID_INPUT" || got.reason === "BATCH_TOO_LARGE" };
          for (const f of got.fleets) {
            if (f.state === "DESTROYED") continue;
            liveFleets.push({
              fleetId: f.fleetId,
              version: f.version,
              state: f.state,
              systemId: f.currentSystemId,
              fleetRole: f.fleetRole,
              operationId: f.operationId,
              refitPending: f.refitPending,
            });
          }
          const occRow = repository.getSystem(tx, invasion.beachhead_system_id, { includeInfluence: false });
          if (!occRow.ok) return { ok: false, reason: `INVASION_BEACHHEAD_READ_FAILED:${occRow.reason}`, invasionId };
          if (occRow.ok && occRow.system) {
            beachhead = {
              controller: occRow.system.controllerFactionId,
              capturedAt: occRow.system.capturedAt,
              occupationState: occRow.system.occupationState,
            };
          }
        }

        return { ok: true, value: { invasion, holders, holdersTruncated, stale: false, liveFleets, beachhead, beachheadSystemId: invasion.beachhead_system_id } };
      });

      if (!readResult.ok) return readResult;
      if (readResult.value && readResult.value.ok === false) {
        if (String(readResult.value.reason).startsWith("INVASION_FLEET")) {
          log(`[LivingNewEden] invasions: step ${invasionId} withdrawal fleet read refused: ${readResult.value.reason}`);
        }
        return readResult.value;
      }
      const data = readResult.value && readResult.value.value ? readResult.value.value : readResult.value;
      const { invasion, holders, holdersTruncated, stale, liveFleets, beachhead, beachheadSystemId } = data;

      if (stale) {
        bump(counts, "stale");
        return { ok: true, outcome: "STALE", onCommitted: stepCommitted(counts, t0) };
      }

      const { PROFILES } = require("./data/invaderProfiles");
      const profile = PROFILES.find((p) => p.profileId === invasion.profile_id);
      const invasionView = {
        state: invasion.state,
        stepSeq: invasion.step_seq,
        factionId: invasion.faction_id,
        version: invasion.version,
        withdrawAt: effectiveWithdrawAtOf(invasion),
        withdrawRound: invasion.withdraw_round || 0,
      };
      const view = {
        invasion: invasionView,
        payloadSeq: seq,
        holders,
        holdersTruncated,
        at,
        liveFleets: liveFleets || [],
        beachhead,
        beachheadSystemId,
        keepsConquest: !!(profile && profile.keepsConquest === true),
      };
      const decision = M.decideStep(view, {
        holdMinFleets: params.holdMinFleets,
        checkIntervalMs: params.checkIntervalMs,
        withdrawRetryMs: params.withdrawRetryMs,
        withdrawMaxRounds: params.withdrawMaxRounds,
      });

      bump(counts, "steps");

      if (decision.action === "STALE") {
        bump(counts, "stale");
        return { ok: true, outcome: "STALE", onCommitted: stepCommitted(counts, t0) };
      }

      if (decision.action === "HOLD") {
        const nextKey = S.stepKey(invasionId, seq + 1, params.checkIntervalMs, Math.floor(decision.next.dueAt / params.checkIntervalMs));
        return {
          ok: true,
          outcome: "HOLD",
          effect: (tx) => {
            const adv = R.advanceStepInTx(tx, { invasionId, expectedVersion: invasion.version, expectedSeq: seq, at });
            if (!adv.ok) return { ok: false, reason: adv.reason };
            const r = scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, decision.next.dueAt,
              { invasionId, seq: seq + 1, trigger: "tick" }, nextKey, { tx, chained: true });
            if (!r || !r.ok) return { ok: false, reason: "ENQUEUE_FAILED" };
            bump(counts, "holds");
            return { ok: true };
          },
          onCommitted: stepCommitted(counts, t0),
        };
      }

      if (decision.action === "COLLAPSE") {
        return {
          ok: true,
          outcome: "COLLAPSE",
          effect: (tx) => {
            const inv2 = R.getInvasion(tx, invasionId);
            if (!inv2.ok || !inv2.invasion) return { ok: false, reason: "INVASION_NOT_FOUND" };
            if (inv2.invasion.state === S.STATE_ENDED) return { ok: true };
            if (inv2.invasion.step_seq !== seq) {
              bump(counts, "holdLost");
              return { ok: true };
            }
            const fl2 = fleets.repository.listFleetsInSystem(tx, inv2.invasion.beachhead_system_id, {
              states: HOLD_STATES, limit: params.maxFleetsReadPerStep + 1,
            });
            if (!fl2.ok) return fl2;
            const holders2 = fl2.fleets.filter((f) => f.factionId === inv2.invasion.faction_id).length;
            if (holders2 >= params.holdMinFleets) {
              const adv = R.advanceStepInTx(tx, { invasionId, expectedVersion: inv2.invasion.version, expectedSeq: seq, at });
              if (!adv.ok) return { ok: false, reason: adv.reason };
              const nextKey = S.stepKey(invasionId, seq + 1, params.checkIntervalMs, Math.floor((at + params.checkIntervalMs) / params.checkIntervalMs));
              const r = scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, at + params.checkIntervalMs,
                { invasionId, seq: seq + 1, trigger: "tick" }, nextKey, { tx, chained: true });
              if (!r || !r.ok) return { ok: false, reason: "ENQUEUE_FAILED" };
              bump(counts, "holds");
              return { ok: true };
            }
            const endKey = S.endKey(invasionId);
            const tr = R.transition(tx, {
              invasionId, expectedVersion: inv2.invasion.version,
              from: S.STATE_ACTIVE, to: S.STATE_ENDED,
              patch: { stepSeq: seq + 1, endedAt: at, endReason: decision.reason },
              key: endKey, at,
            });
            if (!tr.ok) return tr;
            if (!tr.duplicate) R.bumpTotalsInTx(tx, invasion.faction_id, { collapsed: 1 }, at);
            bump(counts, "collapsed");
            return { ok: true };
          },
          onCommitted: stepCommitted(counts, t0),
        };
      }

      if (decision.action === "WITHDRAW") {
        bump(counts, "withdrawStarted");
        const withdrawKey = S.withdrawKey(invasionId);
        return {
          ok: true,
          outcome: "WITHDRAW",
          effect: (tx) => {
            const tr = R.transition(tx, {
              invasionId, expectedVersion: invasion.version,
              from: S.STATE_ACTIVE, to: S.STATE_WITHDRAWING,
              patch: { stepSeq: seq + 1, withdrawRound: 0 },
              key: withdrawKey, at,
            });
            if (!tr.ok) return tr;
            const nextKey = S.stepKey(invasionId, seq + 1, params.checkIntervalMs, Math.floor(at / params.checkIntervalMs));
            const r = scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, at,
              { invasionId, seq: seq + 1, trigger: "tick" }, nextKey, { tx, chained: true });
            if (!r || !r.ok) return { ok: false, reason: "ENQUEUE_FAILED" };
            return { ok: true };
          },
          onCommitted: stepCommitted(counts, t0),
        };
      }

      if (decision.action === "WITHDRAW_ROUND" || decision.action === "END_WITHDRAWN" || decision.action === "END_TIMEOUT") {
        const currentRound = invasion.withdraw_round || 0;

        return {
          ok: true,
          outcome: decision.action,
          effect: (tx) => {
            let refused = 0;
            for (const fleet of decision.disband || []) {
              const disbandKey = S.withdrawDisbandKey(invasionId, currentRound, fleet.fleetId);
              const r = fleets.repository.disband(tx, {
                fleetId: fleet.fleetId,
                expectedVersion: fleet.version,
                systemId: fleet.systemId,
                fleetRole: fleet.fleetRole,
                allowRefitPending: true,
              }, disbandKey);
              if (!r.ok) {
                refused += 1;
                bump(counts, "withdrawDisbandRefused");
              }
            }

            for (const systemId of decision.abandon || []) {
              const abandonKey = S.withdrawAbandonKey(invasionId, currentRound, systemId);
              const occ = occupation.abandonInTx(tx, { systemId, at, factionId: invasion.faction_id, allowClaim: true }, abandonKey);
              if (!occ.ok) {
                if (occ.reason === "NOT_CONTROLLER" || occ.reason === "CORE_PROTECTED") {
                  bump(counts, "withdrawAbandonSkipped");
                  continue;
                }
                return { ok: false, reason: `WITHDRAW_ABANDON_REFUSED:${occ.reason}`, systemId };
              } else {
                bump(counts, "withdrawAbandoned");
                if (occ.released === true && occ.changed === true) {
                  bump(counts, "withdrawReleased");
                }
              }
            }

            const settled = M.settleRound(decision, refused, currentRound,
              { withdrawRetryMs: params.withdrawRetryMs, withdrawMaxRounds: params.withdrawMaxRounds }, at);
            if (settled.action !== decision.action) bump(counts, "withdrawEndDeferred");
            const isFinal = settled.action === "END_WITHDRAWN" || settled.action === "END_TIMEOUT";
            const endReason = settled.action === "END_WITHDRAWN" ? S.END_REASON_WITHDRAWN : S.END_REASON_WITHDRAW_TIMEOUT;

            if (isFinal) {
              const endKey = S.withdrawEndKey(invasionId);
              const tr = R.transition(tx, {
                invasionId, expectedVersion: invasion.version,
                from: S.STATE_WITHDRAWING, to: S.STATE_ENDED,
                patch: { stepSeq: seq + 1, endedAt: at, endReason },
                key: endKey, at,
              });
              if (!tr.ok) return tr;
              if (!tr.duplicate) {
                R.bumpTotalsInTx(tx, invasion.faction_id, { withdrawn: 1 }, at);
                if ((decision.keep || []).length > 0) bump(counts, "withdrawKeptConquest");
                if (endReason === S.END_REASON_WITHDRAWN) {
                  bump(counts, "withdrawn");
                } else {
                  bump(counts, "withdrawTimeout");
                  bump(counts, "withdrawLeftover", settled.leftover || 0);
                }
              }
              return { ok: true };
            } else {
              const nextRound = currentRound + 1;
              const roundKey = S.withdrawRoundKey(invasionId, nextRound);
              const tr = R.transition(tx, {
                invasionId, expectedVersion: invasion.version,
                from: S.STATE_WITHDRAWING, to: S.STATE_WITHDRAWING,
                patch: { stepSeq: seq + 1, withdrawRound: nextRound },
                key: roundKey, at,
              });
              if (!tr.ok) return tr;
              const nextKey = S.stepKey(invasionId, seq + 1, params.checkIntervalMs, Math.floor(settled.next.dueAt / params.checkIntervalMs));
              const r = scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, settled.next.dueAt,
                { invasionId, seq: seq + 1, trigger: "tick" }, nextKey, { tx, chained: true });
              if (!r || !r.ok) return { ok: false, reason: "ENQUEUE_FAILED" };
              bump(counts, "withdrawRounds");
              return { ok: true };
            }
          },
          onCommitted: stepCommitted(counts, t0),
        };
      }

      return { ok: false, reason: "INVASION_STEP_UNKNOWN_ACTION" };
    } catch (err) {
      return { ok: false, reason: `INVASION_STEP_HANDLER_FAILED: ${String(err)}` };
    }
  }

  function bootstrap() {
    try {
      if (stopped) return { ok: false, reason: "INVASIONS_STOPPED" };
      const ready = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state === "ready" : false;
      if (!ready || typeof scheduler.enqueueMany !== "function") return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };

      const now = clock.now();
      const I = invasionsConfig.rollIntervalMs;
      const phi = deriveSeed(worldSeed || 0, "invasions", "phase") % I;
      const bucketOf = (t) => Math.floor((t - phi) / I);
      const nextRollRound = bucketOf(now) + 1;

      const readResult = store.transaction("invasions.bootstrapRead",
        (tx) => R.listOpen(tx, { limit: params.maxActive * 2 + conduitSlots }));
      if (!readResult.ok) return { ok: false, reason: readResult.reason };
      const openInvasions = readResult.value && readResult.value.invasions ? readResult.value.invasions : [];

      const specs = [];
      const dueAt = nextRollRound * I + phi;
      specs.push({ eventType: S.EVENT_TYPE_ROLL, aggregateId: "roll", dueAt, payload: { round: nextRollRound },
        idempotencyKey: S.rollKey(nextRollRound) });
      if (conduitOn && conduitFactions.length > 0) {
        const phiC = deriveSeed(worldSeed || 0, "invasions", "conduit-phase") % I;
        const nextConduitRound = Math.floor((now - phiC) / I) + 1;
        specs.push({ eventType: S.EVENT_TYPE_CONDUIT_ROLL, aggregateId: "conduit",
          dueAt: conduitDueAt(nextConduitRound), payload: { round: nextConduitRound },
          idempotencyKey: S.conduitRollKey(nextConduitRound) });
      }

      for (const inv of openInvasions) {
        if (inv.state === S.STATE_ENDED) continue;
        const stepKey = S.stepKey(inv.invasion_id, inv.step_seq, params.checkIntervalMs, Math.floor(now / params.checkIntervalMs));
        specs.push({ eventType: S.EVENT_TYPE_STEP, aggregateId: inv.invasion_id, dueAt: now, payload: { invasionId: inv.invasion_id, seq: inv.step_seq, trigger: "tick" },
          idempotencyKey: stepKey });
      }

      if (specs.length === 0) return { ok: true, enqueued: 0, duplicates: 0 };
      const r = scheduler.enqueueMany(specs);
      if (!r || !r.ok) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
      return { ok: true, enqueued: r.enqueued, duplicates: r.duplicates };
    } catch (err) {
      return { ok: false, reason: `INVASIONS_BOOTSTRAP_FAILED: ${String(err)}` };
    }
  }

  function getStatus() {
    return Object.freeze({
      state: stopped ? "stopped" : "ready",
      counters: Object.freeze({ ...counters }),
      lastDecision,
      lastRefusal,
      ...(conduitOn ? { lastConduitDecision } : {}),
    });
  }

  function start() {
    if (stopped) return { ok: false, reason: "INVASIONS_STOPPED" };
    registerRollHandler();
    registerStepHandler();
    registerConduitHandler();
    loadTargetLists();
    return { ok: true };
  }

  function stop() {
    stopped = true;
    if (rollHandler && typeof rollHandler.unregister === "function") rollHandler.unregister();
    if (stepHandler && typeof stepHandler.unregister === "function") stepHandler.unregister();
    if (conduitHandler && typeof conduitHandler.unregister === "function") conduitHandler.unregister();
    rollHandler = null;
    stepHandler = null;
    conduitHandler = null;
  }

  return Object.freeze({
    start,
    stop,
    bootstrap,
    getStatus,
    rollHandlerFn,
    stepHandlerFn,
    conduitHandlerFn,
    effectiveWithdrawAtOf,
  });
}

function createUnavailableInvasions(reason) {
  const refusal = Object.freeze({ ok: false, reason: String(reason) });
  const status = Object.freeze({ state: "unavailable", reason: refusal.reason });
  const refuse = () => refusal;
  return Object.freeze({
    start: refuse,
    stop: () => {},
    bootstrap: () => ({ ok: false, reason: refusal.reason }),
    getStatus: () => status,
    rollHandlerFn: () => refusal,
    stepHandlerFn: () => refusal,
    conduitHandlerFn: () => refusal,
    effectiveWithdrawAtOf: (row) => row.withdraw_at ?? null,
  });
}

module.exports = { createInvasionService, createUnavailableInvasions, getProfiles };