"use strict";

const { performance } = require("node:perf_hooks");
const { ACTION, REASON, metricSuffix, decideProjection, DEFAULT_INVADER_FACTION_IDS } = require("../../adapter/sovProjection");
const { getLogsByIds } = require("./repository");

async function settle(value) {
  return value && typeof value.then === "function" ? await value : value;
}

const defaultYield = () => new Promise((r) => setImmediate(r));

const SCREEN = Object.freeze({
  CANDIDATE: "CANDIDATE",
  NOT_CLAIMABLE: "NOT_CLAIMABLE",
  CLAIMABLE_ERROR: "CLAIMABLE_ERROR",
  INVADER: "INVADER",
  NO_IDENTITY: "NO_IDENTITY",
  IDENTITY_ERROR: "IDENTITY_ERROR",
});

function invaderSetOf(config) {
  const ids = new Set(
    (config?.world?.sovProjection?.invaderFactionIds ?? "500021,500026,500029")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => Number(s))
      .filter((n) => Number.isSafeInteger(n) && n > 0)
  );
  for (const id of DEFAULT_INVADER_FACTION_IDS) ids.add(id);
  return ids;
}

async function readClaim(sovState, sovProjection, systemId) {
  const claim = sovState.getSystemSovClaim ? await settle(sovState.getSystemSovClaim(systemId)) : null;
  if (!claim) return null;
  const allianceId = claim.allianceID ?? claim.allianceId ?? null;
  const corpId = claim.corporationID ?? claim.corporationId ?? null;
  const isVirtual = allianceId !== null && allianceId > 0 && sovProjection.isVirtualAlliance?.(allianceId) === true;
  return { allianceID: allianceId, corporationID: corpId, isVirtualAlliance: isVirtual };
}

async function scanClaimable(ctx, visitPage, opts) {
  const { sovProjection, world, virtualCorps, config, telemetry, logger } = ctx;
  const label = (opts && opts.label) || "syncAll";
  const yieldMetric = opts && typeof opts.yieldMetric === "string" ? opts.yieldMetric : null;
  const perfNow = typeof ctx.nowMs === "function" ? ctx.nowMs : () => performance.now();
  const yieldFn = typeof ctx.yieldFn === "function" ? ctx.yieldFn : defaultYield;
  let yields = 0;
  let maxSliceMs = 0;
  const batchSize = config?.world?.sovProjection?.syncBatchSize ?? 500;
  const sliceMs = config?.world?.sovProjection?.syncSliceMs ?? 4;
  const out = (extra) => ({ yields, maxSliceMs, ...extra });

  if (!world || typeof world.listSystems !== "function") {
    logger?.error?.(`[sovProjection] ${label}: world.listSystems not available`);
    return out({ ok: false, reason: "WORLD_LIST_SYSTEMS_UNAVAILABLE", beforeScan: true });
  }

  let sovSystemRules;
  let sovState;
  try {
    const rules = await sovProjection.requireGame("services/sovereignty/sovSystemRules");
    if (!rules.ok) throw new Error(rules.reason);
    sovSystemRules = rules.exports;

    const state = await sovProjection.requireGame("services/sovereignty/sovState");
    if (!state.ok) throw new Error(state.reason);
    sovState = state.exports;
  } catch (err) {
    logger?.error?.(`[sovProjection] ${label}: failed to load EveJS sov modules - ${err.message}`);
    return out({ ok: false, reason: `EVEJS_MODULES_FAILED: ${err.message}`, beforeScan: true });
  }

  const invaderFactionIds = invaderSetOf(config);

  let sliceStart = perfNow();
  const endSlice = async () => {
    const slice = perfNow() - sliceStart;
    if (slice > maxSliceMs) maxSliceMs = slice;
    await yieldFn();
    yields += 1;
    if (telemetry && yieldMetric) telemetry.count(yieldMetric, 1);
    sliceStart = perfNow();
  };
  const maybeYield = async () => {
    if (perfNow() - sliceStart >= sliceMs) await endSlice();
  };
  const scan = Object.freeze({ sovState, invaderFactionIds, maybeYield });

  async function screen(sys) {
    let isClaimable = false;
    try {
      isClaimable = await settle(sovSystemRules.isSovereigntyClaimableSolarSystem(sys.systemId));
    } catch (err) {
      logger?.warn?.(`[sovProjection] ${label}: isClaimable check failed for ${sys.systemId} - ${err.message}`);
      return { kind: SCREEN.CLAIMABLE_ERROR, sys, error: err.message };
    }
    if (!isClaimable) return { kind: SCREEN.NOT_CLAIMABLE, sys };
    const controllerFactionId = sys.controllerFactionId ?? null;
    let virtualIdentity = null;
    if (controllerFactionId !== null) {
      try {
        const idResult = await settle(virtualCorps.getFactionIdentity(controllerFactionId));
        if (idResult?.ok && idResult.allianceId && idResult.corporationIds?.[0]) {
          virtualIdentity = { allianceId: idResult.allianceId, executorCorpId: idResult.corporationIds[0] };
        } else if (invaderFactionIds.has(controllerFactionId)) {
          return { kind: SCREEN.INVADER, sys };
        } else {
          return { kind: SCREEN.NO_IDENTITY, sys };
        }
      } catch (err) {
        logger?.warn?.(`[sovProjection] ${label}: getFactionIdentity failed for ${controllerFactionId} - ${err.message}`);
        return { kind: SCREEN.IDENTITY_ERROR, sys, error: err.message };
      }
    }
    return {
      kind: SCREEN.CANDIDATE,
      sys,
      candidate: {
        systemId: sys.systemId,
        controllerFactionId,
        occupationState: sys.occupationState ?? "STABLE",
        phaseSeq: sys.phaseSeq ?? 0,
        capturedAt: sys.capturedAt ?? null,
        virtualIdentity,
      },
    };
  }

  const listFailed = (detail) => {
    logger?.error?.(`[sovProjection] ${label}: listSystems failed - ${detail}`);
    return out({ ok: false, reason: `LIST_SYSTEMS_FAILED: ${detail}` });
  };
  let lastSystemId = 0;
  let hasMore = true;
  while (hasMore) {
    let listed;
    try {
      listed = world.listSystems({ afterSystemId: lastSystemId, limit: batchSize, includeInfluence: false });
    } catch (err) {
      return listFailed(err.message);
    }
    if (listed && listed.ok === false) return listFailed(listed.reason || "REFUSED");
    if (!listed || !Array.isArray(listed.systems)) return listFailed("MALFORMED_LISTING");
    const systems = listed.systems;
    if (systems.length === 0) break;
    const pageLast = systems[systems.length - 1].systemId;
    const next = listed.nextAfterSystemId;
    if (next === null) {
      hasMore = false;
    } else if (next === undefined) {
      if (!(Number.isSafeInteger(pageLast) && pageLast > lastSystemId)) {
        return listFailed(`BAD_CURSOR ${String(pageLast)} after ${lastSystemId}`);
      }
      hasMore = true;
      lastSystemId = pageLast;
    } else if (Number.isSafeInteger(next) && next > lastSystemId) {
      hasMore = true;
      lastSystemId = next;
    } else {
      return listFailed(`BAD_CURSOR ${String(next)} after ${lastSystemId}`);
    }

    const entries = [];
    for (const sys of systems) {
      entries.push(await screen(sys));
      await maybeYield();
    }
    await visitPage(entries, scan);

    if (hasMore) await endSlice();
  }

  const lastSlice = perfNow() - sliceStart;
  if (lastSlice > maxSliceMs) maxSliceMs = lastSlice;
  return out({ ok: true });
}

async function syncAll(ctx) {
  const {
    sovProjection,
    persistence,
    telemetry,
    logger,
    clock,
  } = ctx;

  const nowOf = () => (clock && typeof clock.now === "function" ? clock.now() : 0);
  const startMs = nowOf();
  let processed = 0;
  let deferred = 0;
  let skipped = 0;
  let failed = 0;
  let yields = 0;
  let maxSliceMs = 0;

  const count = (name) => {
    if (telemetry) telemetry.count(name, 1);
  };
  const result = (extra) => ({ processed, deferred, skipped, failed, yields, maxSliceMs,
    durationMs: nowOf() - startMs, ...extra });

  if (!sovProjection || typeof sovProjection.projectSystem !== "function") {
    logger?.error?.(`[sovProjection] syncAll: projectSystem not available`);
    return result({ ok: false, reason: "PROJECT_SYSTEM_UNAVAILABLE", durationMs: 0 });
  }

  const store = persistence && persistence.store;
  let sovState = null;
  let invaderFactionIds = null;

  const SCREEN_SKIP_METRIC = {
    [SCREEN.NOT_CLAIMABLE]: "sovProjection.skipped.not_claimable",
    [SCREEN.INVADER]: "sovProjection.skipped.invader_faction",
    [SCREEN.NO_IDENTITY]: "sovProjection.skipped.no_virtual_identity",
    [SCREEN.IDENTITY_ERROR]: "sovProjection.skipped.virtual_identity_error",
  };
  function countScreen(entry) {
    if (entry.kind === SCREEN.CANDIDATE) return entry.candidate;
    if (entry.kind === SCREEN.CLAIMABLE_ERROR) {
      failed++;
      return null;
    }
    skipped++;
    count(SCREEN_SKIP_METRIC[entry.kind]);
    return null;
  }

  function readLogs(ids) {
    if (ids.length === 0) return new Map();
    try {
      const r = store && typeof store.transaction === "function"
        ? store.transaction("sovProjection.getLogs", (tx) => getLogsByIds(tx, ids))
        : null;
      if (r && r.ok === true && r.value && r.value.ok === true && r.value.value instanceof Map) return r.value.value;
      logger?.warn?.(`[sovProjection] syncAll: log page read failed (${(r && ((r.value && r.value.reason) || r.reason)) || "NO_STORE"}) - no log shortcut on this page`);
    } catch (err) {
      logger?.warn?.(`[sovProjection] syncAll: log page read threw - ${err.message} - no log shortcut on this page`);
    }
    return null;
  }

  function countProjection(systemId, res) {
    if (res && res.deferred === true) {
      deferred++;
    } else if (res && res.ok && res.skipped) {
      skipped++;
      const reason = metricSuffix(res.reason);
      count(`sovProjection.${reason}`);
    } else if (res && res.ok) {
      processed++;
    } else {
      failed++;
      logger?.warn?.(`[sovProjection] syncAll: projectSystem ${systemId} failed: ${res && res.reason}`);
    }
  }

  async function project(c, logs) {
    const { systemId, controllerFactionId, phaseSeq } = c;
    const row = logs ? logs.get(systemId) : null;
    if (row && row.last_controller === controllerFactionId && row.last_seq === phaseSeq) {
      skipped++;
      count("sovProjection.skipped.already_synced");
      return;
    }

    let evejsClaim = null;
    try {
      evejsClaim = await readClaim(sovState, sovProjection, systemId);
    } catch (err) {
      logger?.warn?.(`[sovProjection] syncAll: getSystemSovClaim failed for ${systemId} - ${err.message}`);
      failed++;
      return;
    }

    if (evejsClaim && evejsClaim.allianceID !== null && evejsClaim.allianceID > 0 && !evejsClaim.isVirtualAlliance) {
      skipped++;
      count("sovProjection.skipped.player_claim_protected");
      return;
    }

    const decision = decideProjection(systemId,
      { controllerFactionId, occupationState: c.occupationState, phaseSeq, capturedAt: c.capturedAt },
      c.virtualIdentity, { isClaimable: true, currentClaim: evejsClaim }, invaderFactionIds);

    if (decision.action === ACTION.NONE && decision.skip && decision.reason === REASON.ALREADY_SYNCED
      && decision.allianceId && controllerFactionId !== null) {
      try {
        await sovProjection.projectSystem(systemId);
      } catch (err) {
        logger?.warn?.(`[sovProjection] syncAll: log repair ${systemId} threw: ${err.message}`);
      }
    }

    if (decision.action === ACTION.NONE && decision.skip) {
      skipped++;
      const reason = metricSuffix(decision.reason);
      count(`sovProjection.${reason}`);
      return;
    }

    try {
      const res = await sovProjection.projectSystem(systemId);
      countProjection(systemId, res);
    } catch (err) {
      failed++;
      logger?.warn?.(`[sovProjection] syncAll: projectSystem ${systemId} threw: ${err.message}`);
    }
  }

  const scanned = await scanClaimable(ctx, async (entries, scan) => {
    sovState = scan.sovState;
    invaderFactionIds = scan.invaderFactionIds;
    const candidates = [];
    for (const entry of entries) {
      const c = countScreen(entry);
      if (c) candidates.push(c);
    }
    const logs = readLogs(candidates.map((c) => c.systemId));
    for (const c of candidates) {
      await project(c, logs);
      await scan.maybeYield();
    }
  }, { label: "syncAll", yieldMetric: "sovProjection.syncYields" });
  yields = scanned.yields;
  maxSliceMs = scanned.maxSliceMs;
  if (!scanned.ok) {
    return result(scanned.beforeScan ? { ok: false, reason: scanned.reason, durationMs: 0 }
      : { ok: false, reason: scanned.reason });
  }

  const durationMs = nowOf() - startMs;
  if (telemetry) {
    telemetry.observe("sovProjection.syncDurationMs", durationMs);
    telemetry.observe("sovProjection.syncSliceMaxMs", maxSliceMs);
  }
  return { ok: true, processed, deferred, skipped, failed, yields, maxSliceMs, durationMs };
}

const VERIFY_CLASS = Object.freeze({
  MATCHED: "matched",
  MISMATCHED: "mismatched",
  PLAYER_PROTECTED: "playerProtected",
  NO_IDENTITY: "noIdentity",
  INVADER: "invader",
  ERROR: "errors",
});

function classifyVerify(c, claim) {
  const allianceId = claim && claim.allianceID !== null && claim.allianceID > 0 ? claim.allianceID : null;
  if (allianceId !== null && !claim.isVirtualAlliance) return VERIFY_CLASS.PLAYER_PROTECTED;
  if (c.controllerFactionId === null) return allianceId === null ? VERIFY_CLASS.MATCHED : VERIFY_CLASS.MISMATCHED;
  return c.virtualIdentity && allianceId === c.virtualIdentity.allianceId ? VERIFY_CLASS.MATCHED
    : VERIFY_CLASS.MISMATCHED;
}

async function verifyAll(ctx) {
  const { sovProjection, telemetry, logger, clock, config } = ctx;
  const nowOf = () => (clock && typeof clock.now === "function" ? clock.now() : 0);
  const at = nowOf();
  if (!sovProjection || typeof sovProjection.requireGame !== "function") {
    logger?.error?.(`[sovProjection] verifyAll: requireGame not available`);
    return { ok: false, reason: "REQUIRE_GAME_UNAVAILABLE", at };
  }
  const samplesRaw = Number.isSafeInteger(ctx.verifyMaxSamples) ? ctx.verifyMaxSamples
    : config?.world?.sovProjection?.verifyMaxSamples;
  const maxSamples = Number.isSafeInteger(samplesRaw) && samplesRaw > 0 ? samplesRaw : 0;
  const counts = { matched: 0, mismatched: 0, playerProtected: 0, noIdentity: 0, invader: 0, errors: 0 };
  const sample = [];
  let checked = 0;
  const tally = (cls, systemId) => {
    counts[cls] += 1;
    if (cls === VERIFY_CLASS.MISMATCHED && sample.length < maxSamples) sample.push(systemId);
  };

  const scanned = await scanClaimable(ctx, async (entries, scan) => {
    for (const entry of entries) {
      if (entry.kind === SCREEN.NOT_CLAIMABLE) continue;
      checked += 1;
      const systemId = entry.sys.systemId;
      const controllerFactionId = entry.sys.controllerFactionId ?? null;
      if (controllerFactionId !== null && scan.invaderFactionIds.has(controllerFactionId)) {
        tally(VERIFY_CLASS.INVADER, systemId);
        continue;
      }
      if (entry.kind === SCREEN.NO_IDENTITY || entry.kind === SCREEN.INVADER) {
        tally(VERIFY_CLASS.NO_IDENTITY, systemId);
        continue;
      }
      if (entry.kind !== SCREEN.CANDIDATE) {
        tally(VERIFY_CLASS.ERROR, systemId);
        continue;
      }
      let claim;
      try {
        claim = await readClaim(scan.sovState, sovProjection, systemId);
      } catch (err) {
        logger?.warn?.(`[sovProjection] verifyAll: getSystemSovClaim failed for ${systemId} - ${err.message}`);
        tally(VERIFY_CLASS.ERROR, systemId);
        await scan.maybeYield();
        continue;
      }
      tally(classifyVerify(entry.candidate, claim), systemId);
      await scan.maybeYield();
    }
  }, { label: "verifyAll", yieldMetric: null });
  if (!scanned.ok) return { ok: false, reason: scanned.reason, at };

  const durationMs = nowOf() - at;
  try {
    if (telemetry) {
      if (typeof telemetry.gauge === "function") telemetry.gauge("sovProjection.verify.mismatched", counts.mismatched);
      if (typeof telemetry.observe === "function") telemetry.observe("sovProjection.verifyMs", durationMs);
    }
  } catch (_err) {
  }
  return { ok: true, at, checked, ...counts, sample, yields: scanned.yields, durationMs };
}

module.exports = { syncAll, verifyAll, scanClaimable, classifyVerify, SCREEN, VERIFY_CLASS };
