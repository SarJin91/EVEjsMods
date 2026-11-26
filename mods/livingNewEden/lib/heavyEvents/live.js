"use strict";

const S = require("./schema");
const P = require("./power/schema");
const W = require("./world/schema");
const { LAYER, layerOfRow } = require("./layer");
const { tierDefOf, SUBSTITUTE, waveMembersOf, integrityWeightOf } = require("./catalog");
const { decidePlanned, decideEngaged, abandonTargetOf } = require("./machine");
const { fleetPowerOf, scaleStepsOf, membersOfPhase } = require("./scale");
const { endInTx, returnHullsInTx, Rollback, stationsRepoOf, labelOf } = require("./planner");
const { labelOf: powerLabelOf } = require("./power/choose");
const { labelOf: worldLabelOf } = require("./world/choose");
const { incursionLabelOf } = require("./incursion/label");
const { roleOfIncursionEventId } = require("./incursion/rewards");
const { STATE: SITE_STATE } = require("../events/sites/schema");
const { STATION_STATES } = require("../stations/schema");
const { participantsOf } = require("./payoutRepository");
const PS = require("./payoutSchema");
const { pocketCountOf, visibilityOfPocket, phaseOfPocket, hasWaves, waveMembersOf: powerWaveMembersOf } = require("./power/catalog");

const LIVE_CLASS = "OPERATIONAL";
const SITE_SLOT = 0;
const INFLUENCE_REASON = "HEAVY_EVENT_CLEARED";
const DEFENSE_INFLUENCE_REASON = "HEAVY_EVENT_DEFENDED";
const MS_PER_MINUTE = 60000;
const DRAIN_REASON = "heavy_event_drain";
const MINERAL_KIND = "mineral";
const MINERAL_KEY_RE = /^type:([1-9][0-9]{0,9})$/;
const PERMILLE = 1000;
const STATION_DESTROYED_STATE = STATION_STATES[3];
const MAX_DETAIL = 160;
const SAVEPOINT_ABORT = Symbol("heavyEvents.savepoint");

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
};

function markUnspawnable(members, keys) {
  if (keys.length === 0) return members;
  return members.map((m) => (m && m.state === S.MEMBER_STATE.RESERVED && keys.includes(m.key)
    ? { ...m, state: S.MEMBER_STATE.UNSPAWNABLE } : m));
}

const isDefense = (row) => Boolean(row) && row.eventType === S.TYPE.DEFENSE;

function fieldOf(row, phase, steps) {
  if (!row || !hasWaves(row.eventType)) return membersOfPhase(row, phase, steps);
  const unlocked = Number.isSafeInteger(steps) && steps > 0 ? steps : 0;
  return (Array.isArray(row.members) ? row.members : []).filter((m) => m && m.state === S.MEMBER_STATE.RESERVED
    && ((Number.isSafeInteger(m.phase) && m.phase >= S.FIRST_PHASE && m.phase <= phase)
      || (m.phase === null && Number.isSafeInteger(m.step) && m.step >= 1 && m.step <= unlocked)));
}

function pressureOf(live, hullOf, anchor, dtMs, settings) {
  if (!(dtMs > 0) || !Array.isArray(live)) return 0;
  const r2 = settings.pressureRadiusM * settings.pressureRadiusM;
  let weight = 0;
  for (const x of live) {
    const p = x && x.position;
    if (!p) continue;
    const dx = p.x - anchor.x;
    const dy = p.y - anchor.y;
    const dz = p.z - anchor.z;
    if (dx * dx + dy * dy + dz * dz > r2) continue;
    weight += integrityWeightOf(hullOf.get(x.entityId));
  }
  return (weight * settings.pressurePerHullPerMinPermille * dtMs) / MS_PER_MINUTE;
}

const integrityToRow = (value) => Math.min(S.INTEGRITY_START, Math.max(0, Math.ceil(value)));

function drainPlanOf(items, permille, maxUnits) {
  const minerals = (Array.isArray(items) ? items : []).filter((it) => it && it.itemKind === MINERAL_KIND
    && typeof it.itemKey === "string" && MINERAL_KEY_RE.test(it.itemKey) && Number.isSafeInteger(it.quantity)
    && it.quantity > 0).sort((a, b) => (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0));
  const plan = [];
  let left = Number.isSafeInteger(maxUnits) && maxUnits > 0 ? maxUnits : 0;
  for (const it of minerals) {
    if (left <= 0 || plan.length >= S.DRAIN_MAX_TYPES) break;
    const units = Math.min(Math.floor((it.quantity * permille) / PERMILLE), left);
    if (!(units > 0)) continue;
    plan.push({ itemKey: it.itemKey, typeId: Number(MINERAL_KEY_RE.exec(it.itemKey)[1]), units });
    left -= units;
  }
  return plan;
}

function createLive(env, hooks) {
  const s = env.settings;
  const power = env.power || null;
  const world = env.world || null;
  const layerOf = (row) => layerOfRow(row) || (P.isPowerType(row.eventType) ? LAYER.POWER : LAYER.HEAVY);
  const isWorldLike = (row) => {
    const layer = layerOf(row);
    return layer === LAYER.WORLD || layer === LAYER.INCURSION;
  };
  const layerSettingsOf = (row) => {
    const layer = layerOf(row);
    if (layer === LAYER.WORLD || layer === LAYER.INCURSION) return world;
    return layer === LAYER.POWER ? power : null;
  };
  const settingsOf = (row) => layerSettingsOf(row) || s;
  const mechanicPrefixOf = (row) => {
    const layer = layerOf(row);
    if (layer === LAYER.INCURSION) return "incursion";
    return layer === LAYER.WORLD ? "anomaly" : "power";
  };
  const pocketLabelBaseOf = (row) => {
    const layer = layerOf(row);
    if (layer === LAYER.WORLD || layer === LAYER.POWER || layer === LAYER.INCURSION) {
      const name = safe(() => env.factionName(row.factionId), null);
      if (layer === LAYER.INCURSION) return incursionLabelOf(name, row.variant);
      return layer === LAYER.WORLD ? worldLabelOf(name, row.variant) : powerLabelOf(name, row.eventType, row.affix);
    }
    return labelOf(env, row.factionId, row.eventType);
  };
  const paysParticipants = (row) => isDefense(row)
    || (isWorldLike(row) && Number.isSafeInteger(row.beneficiaryFactionId));
  const reinforcedFloorOf = (row) => (power && row.affix === P.AFFIX.REINFORCED
    && Number.isSafeInteger(power.reinforcedSteps) ? Math.min(power.reinforcedSteps, s.maxUpscaleSteps) : 0);
  const engagedCfgOf = (row) => {
    const ls = layerSettingsOf(row);
    return ls ? { ...s, trailPockets: ls.trailPockets, escapeAfterMs: ls.escapeAfterMs,
      musterWaves: ls.musterWaves, musterWaveIntervalMs: ls.musterWaveIntervalMs,
      musterWaveGrowthPermille: ls.musterWaveGrowthPermille } : s;
  };
  const targetRoleOf = (row) => (row.eventType === P.TYPE.HUNT ? P.ROLE.OBJECTIVE
    : (row.eventType === P.TYPE.CONVOY ? P.ROLE.HAULER : null));
  function targetFactsOf(row, entry, lostKeys, now, cfg) {
    const facts = { escapeDue: false, objectiveDestroyed: false, haulersDestroyed: 0, haulersLeft: 0 };
    const role = targetRoleOf(row);
    if (role === null) return facts;
    facts.escapeDue = Number.isSafeInteger(entry.phaseSpawnedAt) && Number.isSafeInteger(cfg.escapeAfterMs)
      && cfg.escapeAfterMs > 0 && now >= entry.phaseSpawnedAt + cfg.escapeAfterMs;
    const lost = new Set(lostKeys);
    for (const m of row.members) {
      if (!m || m.role !== role) continue;
      const state = lost.has(m.key) ? S.MEMBER_STATE.DESTROYED : m.state;
      if (state === S.MEMBER_STATE.DESTROYED) facts.haulersDestroyed += 1;
      else if (state === S.MEMBER_STATE.RESERVED) facts.haulersLeft += 1;
    }
    facts.objectiveDestroyed = role === P.ROLE.OBJECTIVE && facts.haulersDestroyed > 0;
    return facts;
  }
  const memory = new Map();
  let strays = [];
  const bump = (name, n) => safe(() => hooks.bump(name, n), null);
  const refuse = (line) => safe(() => hooks.refuse(line), null);

  const liveCount = () => {
    let n = 0;
    for (const entry of memory.values()) n += entry.spawned.size;
    return n;
  };

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let runIn = savepoints.get(tx);
    if (!runIn) {
      runIn = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "EFFECT_ERROR" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, runIn);
    }
    const holder = { refusal: null };
    try {
      return runIn(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      if (tx.inTransaction !== true) throw err;
      return { ok: false, reason: "EFFECT_ERROR", detail: messageOf(err) };
    }
  }

  function despawnIds(seam, systemId, ids) {
    if (ids.length === 0) return;
    if (!seam) {
      strays.push({ systemId, ids: ids.slice() });
      return;
    }
    const r = safe(() => seam.despawn(systemId, ids), { ok: false, reason: "DESPAWN_THREW" });
    if (r && r.ok === true) return;
    const failed = r && Array.isArray(r.failed) ? r.failed : ids;
    if (failed.length > 0) strays.push({ systemId, ids: failed.slice() });
    refuse(`DESPAWN ${systemId} ${(r && r.reason) || "DESPAWN_FAILED"}`);
  }

  function retryStrays(seam) {
    if (strays.length === 0 || !seam) return;
    const list = strays;
    strays = [];
    for (const item of list) despawnIds(seam, item.systemId, item.ids);
  }

  function spawnMembers(seam, row, anchor, members) {
    if (members.length === 0) return { ok: true, spawned: [], unspawnable: [] };
    const r = safe(() => seam.spawnPhase(row.systemId, { eventId: row.eventId, factionId: row.factionId,
      members: members.map((m) => ({ memberKey: m.key, hullGroup: m.hullGroup })), anchorPoint: anchor,
      spawnDistanceM: hasWaves(row.eventType) ? s.waveSpawnDistanceM : s.spawnDistanceM, aggroRangeM: s.aggroRangeM,
      leashRangeM: s.leashRangeM,
      substitute: SUBSTITUTE }), { ok: false, reason: "SPAWN_THREW" });
    if (r && r.ok === true && Array.isArray(r.spawned) && Array.isArray(r.unspawnable)) return r;
    if (r && Array.isArray(r.leftover) && r.leftover.length > 0) despawnIds(seam, row.systemId, r.leftover);
    refuse(`SPAWN ${row.eventId} ${(r && r.reason) || "SPAWN_FAILED"}${r && r.detail ? ` ${r.detail}` : ""}`);
    return { ok: false };
  }

  function lossesInTx(tx, row, keys, now) {
    if (keys.length === 0) return { row, lost: 0 };
    const r = env.repo.recordLossesInTx(tx, { eventId: row.eventId, expectedVersion: row.version, memberKeys: keys,
      at: now });
    if (!r.ok) throw new Rollback("OTHER", r.reason);
    return { row: r.row, lost: r.lost };
  }

  function currentInTx(tx, row) {
    const got = env.repo.getInTx(tx, row.eventId);
    if (!got.ok || !got.row) throw new Rollback("OTHER", got.ok ? "NOT_FOUND" : got.reason);
    if (got.row.version !== row.version || got.row.state !== row.state) throw new Rollback("OTHER", "VERSION_CONFLICT");
    return got.row;
  }

  function influenceInTx(tx, row, now, pointsOverride) {
    const points = typeof pointsOverride === "number" ? pointsOverride : settingsOf(row)[`${row.eventType}InfluencePoints`];
    if (!(typeof points === "number" && points > 0)) return { outcome: "OFF" };
    const occupation = safe(() => env.getOccupation(), null);
    if (!occupation || typeof occupation.dropInfluenceInTx !== "function") {
      return { outcome: "SKIPPED", reason: "NO_OCCUPATION" };
    }
    const r = inSavepoint(tx, () => occupation.dropInfluenceInTx(tx, { systemId: row.systemId,
      factionId: row.factionId, points, at: now, reason: isDefense(row) ? DEFENSE_INFLUENCE_REASON : INFLUENCE_REASON,
      allowNonController: true },
    S.influenceKeyOf(row.eventId)));
    if (r && r.ok === true) return { outcome: r.outcome === "DUPLICATE" ? "DUPLICATE" : "APPLIED" };
    return { outcome: "SKIPPED", reason: String((r && r.reason) || "REFUSED") };
  }

  function clearInTx(tx, row, now, extra, participants) {
    const isPower = P.isPowerType(row.eventType);
    const isMuster = isPower && row.eventType === P.TYPE.MUSTER;
    const powerSettings = isPower ? env.power : null;
    const cfg = isPower ? powerSettings : s;

    let haulersKilled = 0;
    if (isPower && row.eventType === P.TYPE.CONVOY) {
      for (const m of row.members || []) {
        if (m && m.role === P.ROLE.HAULER && m.state === S.MEMBER_STATE.DESTROYED) haulersKilled += 1;
      }
    }

    let drain = null;
    if (row.eventType === S.TYPE.FOUNDRY) {
      drain = drainInTx(tx, row, now);
    } else if (isPower && row.eventType === P.TYPE.CONVOY) {
      drain = convoyDrainInTx(tx, row, now, haulersKilled);
    }

    const patch = { rewardState: S.REWARD_STATE.PENDING, dueAt: now + s.rewardWaitMs, ...(extra || {}) };
    if (row.eventType === S.TYPE.FOUNDRY) {
      patch.result = drain === null ? { ...(row.result || {}) } : { ...(row.result || {}), drain };
    } else if (isPower && row.eventType === P.TYPE.CONVOY) {
      patch.result = { ...(row.result || {}), haulersKilled, drain };
    } else if (isMuster) {
      patch.result = { ...(row.result || {}), wavesCleared: row.phase };
    }

    const worldKey = layerOf(row) === LAYER.WORLD && Object.prototype.hasOwnProperty.call(W.KIND_INFLUENCE_KEY,
      row.variant) ? W.KIND_INFLUENCE_KEY[row.variant] : null;
    const influencePoints = layerOf(row) === LAYER.INCURSION ? 0 : layerOf(row) === LAYER.WORLD
      ? (world && worldKey !== null && world[worldKey] !== undefined ? world[worldKey] : 0)
      : (cfg[`${row.eventType}InfluencePoints`] !== undefined ? cfg[`${row.eventType}InfluencePoints`] : 0);

    const moved = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: row.version,
      from: S.STATE.ENGAGED, to: S.STATE.CLEARED, patch, at: now, reason: S.END_REASON.CLEARED });
    if (!moved.ok) throw new Rollback("OTHER", moved.reason);
    if (moved.duplicate === true) return { duplicate: true, returned: 0, orphaned: 0, influence: null, drain: null, payouts: null };

    const influence = influenceInTx(tx, row, now, influencePoints);
    const back = returnHullsInTx(tx, env, row, now);
    const payouts = paysParticipants(row) ? payoutsInTx(tx, row, participants, now) : null;
    return { duplicate: false, returned: back.returned, orphaned: back.orphaned,
      influence: influence.outcome === "SKIPPED" ? influence.reason : null, drain, payouts };
  }

  function payoutAmountsOf(row) {
    if (isDefense(row)) {
      return { iskAmount: s.defenseIskPerParticipant, lpAmount: s.defenseLpPerParticipant,
        standingMicro: s.defenseStandingMicro };
    }
    const R = env.incursionRewards;
    if (R && layerOf(row) === LAYER.INCURSION) {
      const role = roleOfIncursionEventId(row.eventId);
      const lp = role !== null && Number.isSafeInteger(R.lpPerRole[role]) ? R.lpPerRole[role] : 0;
      return { iskAmount: 0, lpAmount: lp, standingMicro: R.standingMicro, description: PS.WORLD_DESCRIPTION };
    }
    if (!isWorldLike(row) || !world) return null;
    const has = (obj) => Object.prototype.hasOwnProperty.call(obj, row.variant);
    const incursion = layerOf(row) === LAYER.INCURSION;
    if (incursion && (!has(W.KIND_LP_KEY) || !has(W.KIND_STANDING_KEY))) {
      return { iskAmount: 0, lpAmount: 0, standingMicro: 0, description: PS.WORLD_DESCRIPTION };
    }
    if (!has(W.KIND_LP_KEY) || !has(W.KIND_STANDING_KEY)) return null;
    const perTier = W.parseLpPerTier(world[W.KIND_LP_KEY[row.variant]]) || [];
    const lp = perTier[row.tier - 1];
    const std = world[W.KIND_STANDING_KEY[row.variant]];
    return { iskAmount: 0, lpAmount: Number.isSafeInteger(lp) ? lp : 0,
      standingMicro: Number.isSafeInteger(std) && std >= 0 ? std : 0, description: PS.WORLD_DESCRIPTION };
  }

  function payoutsInTx(tx, row, participants, now) {
    if (!paysParticipants(row) || !env.payoutRepo || !Array.isArray(participants) || participants.length === 0) {
      return null;
    }
    if (!Number.isSafeInteger(row.beneficiaryFactionId)) return { planned: 0, failed: "NO_DEFENDER" };
    const amounts = payoutAmountsOf(row);
    if (amounts === null) return null;
    const r = inSavepoint(tx, () => env.payoutRepo.planPayoutsInTx(tx, { eventId: row.eventId,
      issuerFactionId: row.beneficiaryFactionId, systemId: row.systemId, characterIds: participants,
      iskAmount: amounts.iskAmount, lpAmount: amounts.lpAmount, standingMicro: amounts.standingMicro, at: now,
      ...(amounts.description === undefined ? {} : { description: amounts.description }) }));
    if (r && r.ok === true) return { planned: r.planned, failed: null };
    return { planned: 0, failed: String((r && (r.detail || r.reason)) || "PLAN_FAILED") };
  }

  function drainInTx(tx, row, now) {
    if (row.eventType !== S.TYPE.FOUNDRY) return null;
    const got = env.repo.getInTx(tx, row.eventId);
    if (!got.ok) throw new Rollback("OTHER", got.reason);
    if (!got.row || got.row.state !== S.STATE.ENGAGED || got.row.version !== row.version) return null;
    const out = (outcome, extra) => ({ stationId: row.stationId || null, outcome, units: {}, total: 0, ...extra });
    const stations = stationsRepoOf(env);
    if (!stations) return out("REFUSED", { reason: "STATIONS_NOT_READY" });
    if (!row.stationId) return out("REFUSED", { reason: "ROW_NOT_FOUND" });
    const st = stations.getStation(tx, row.stationId);
    if (!st || st.ok !== true) throw new Rollback("OTHER", (st && st.reason) || "STATION_READ_FAILED");
    if (!st.record) return out("REFUSED", { reason: "ROW_NOT_FOUND" });
    if (st.record.state === STATION_DESTROYED_STATE) return out("REFUSED", { reason: "STATION_DESTROYED" });
    if (st.record.ownerFactionId !== row.factionId) return out("REFUSED", { reason: "STATION_LOST" });
    const stock = stations.getStock(tx, row.stationId);
    if (!stock || stock.ok !== true) throw new Rollback("OTHER", (stock && stock.reason) || "STOCK_READ_FAILED");
    const plan = drainPlanOf(stock.items, s.foundryDrainPermille, s.foundryDrainMaxUnits);
    if (plan.length === 0) return out("EMPTY");
    const r = stations.applyStockChange(tx, { stationId: row.stationId, key: S.drainKeyOf(row.eventId),
      reason: DRAIN_REASON, at: now,
      deltas: plan.map((p) => ({ itemKind: MINERAL_KIND, itemKey: p.itemKey, delta: -p.units })) });
    if (!r || r.ok !== true) return out("REFUSED", { reason: String((r && r.reason) || "DRAIN_FAILED") });
    if (r.duplicate === true) return out("DUPLICATE");
    const units = {};
    for (const p of plan) units[String(p.typeId)] = p.units;
    return out("APPLIED", { units, total: plan.reduce((a, p) => a + p.units, 0) });
  }

  function escapeInTx(tx, row, lostKeys, now) {
    const lost = lossesInTx(tx, currentInTx(tx, row), lostKeys, now);
    const current = lost.row;
    const role = targetRoleOf(current);
    const escaped = current.members.filter((m) => m && m.role === role && m.state === S.MEMBER_STATE.RESERVED)
      .map((m) => m.key);
    if (role === null || escaped.length === 0) return { duplicate: false, escaped: [], lost: lost.lost };
    const applied = env.journal.applyOnce(tx, { key: P.escapeKeyOf(current.eventId, current.phase),
      aggregate: { type: S.AGGREGATE, id: current.eventId }, eventType: S.EVENT_TRANSITION,
      payload: { eventId: current.eventId, phase: current.phase, escaped } }, () => ({ ok: true }));
    if (!applied || applied.ok !== true) throw new Rollback("OTHER", (applied && applied.reason) || "JOURNAL_FAILED");
    if (applied.duplicate === true) return { duplicate: true, escaped: [], lost: lost.lost };
    const keys = new Set(escaped);
    const moved = env.repo.transitionInTx(tx, { eventId: current.eventId, expectedVersion: current.version,
      from: S.STATE.ENGAGED, to: S.STATE.ENGAGED, at: now, patch: { members: current.members.map((m) => (m
        && keys.has(m.key) ? { ...m, state: S.MEMBER_STATE.ESCAPED } : m)) } });
    if (!moved.ok || moved.duplicate === true) throw new Rollback("OTHER", moved.ok ? "DUPLICATE" : moved.reason);
    return { duplicate: false, escaped, lost: lost.lost };
  }

  function convoyDrainInTx(tx, row, now, haulersKilled) {
    if (row.eventType !== P.TYPE.CONVOY || haulersKilled <= 0 || !power) return null;
    const permille = Math.min(power.convoyDrainPermillePerHauler * haulersKilled, PERMILLE);
    if (permille <= 0) return null;
    const got = env.repo.getInTx(tx, row.eventId);
    if (!got.ok) throw new Rollback("OTHER", got.reason);
    if (!got.row || got.row.state !== S.STATE.ENGAGED || got.row.version !== row.version) return null;
    const out = (outcome, extra) => ({ stationId: row.stationId || null, outcome, units: {}, total: 0, ...extra });
    const stations = stationsRepoOf(env);
    if (!stations) return out("REFUSED", { reason: "STATIONS_NOT_READY" });
    if (!row.stationId) return out("REFUSED", { reason: "ROW_NOT_FOUND" });
    const st = stations.getStation(tx, row.stationId);
    if (!st || st.ok !== true) throw new Rollback("OTHER", (st && st.reason) || "STATION_READ_FAILED");
    if (!st.record) return out("REFUSED", { reason: "ROW_NOT_FOUND" });
    if (st.record.state === STATION_DESTROYED_STATE) return out("REFUSED", { reason: "STATION_DESTROYED" });
    if (st.record.ownerFactionId !== row.factionId) return out("REFUSED", { reason: "STATION_LOST" });
    const stock = stations.getStock(tx, row.stationId);
    if (!stock || stock.ok !== true) throw new Rollback("OTHER", (stock && stock.reason) || "STOCK_READ_FAILED");
    const plan = drainPlanOf(stock.items, permille, power.drainMaxUnits);
    if (plan.length === 0) return out("EMPTY");
    const r = stations.applyStockChange(tx, { stationId: row.stationId, key: P.drainKeyOf(row.eventId),
      reason: DRAIN_REASON, at: now,
      deltas: plan.map((p) => ({ itemKind: MINERAL_KIND, itemKey: p.itemKey, delta: -p.units })) });
    if (!r || r.ok !== true) return out("REFUSED", { reason: String((r && r.reason) || "DRAIN_FAILED") });
    if (r.duplicate === true) return out("DUPLICATE");
    const units = {};
    for (const p of plan) units[String(p.typeId)] = p.units;
    return out("APPLIED", { units, total: plan.reduce((a, p) => a + p.units, 0) });
  }

  function write(name, eventId, fn) {
    const r = env.store.transaction(`heavyEvents.${name}`, fn);
    if (r.ok) return r.value;
    bump("errors");
    refuse(`LIVE ${name} ${eventId} ${r.error instanceof Rollback ? r.error.detail : (r.reason || "TX_FAILED")}`);
    return null;
  }

  function engage(seam, row, site, now) {
    const grid = safe(() => seam.readGrid(row.systemId, site.position, s.gridRadiusM), { ok: false });
    const players = grid && grid.ok === true && Array.isArray(grid.players) ? grid.players.length : 0;
    const d = decidePlanned(row, { now, siteActive: true, gridPlayers: players, sceneLoaded: grid && grid.ok === true,
      causeHolds: null });
    if (d.action !== "ENGAGE") return;
    if (!env.admits(LIVE_CLASS)) {
      bump("deferred.GOVERNOR");
      return;
    }
    const tier = tierDefOf(row.eventType, row.tier, row.variant);
    if (!tier.ok) {
      refuse(`ENGAGE ${row.eventId} ${tier.reason}`);
      return;
    }
    const steps = Math.max(scaleStepsOf(fleetPowerOf({ players, copies: grid.copies }, s), tier.def, row.scaleSteps, s),
      reinforcedFloorOf(row));
    const phase = Math.max(row.phase, S.FIRST_PHASE);
    const members = fieldOf(row, phase, steps);
    if (liveCount() + members.length > s.maxLiveShips) {
      bump("deferred.BUDGET");
      return;
    }
    const sp = spawnMembers(seam, row, site.position, members);
    if (!sp.ok) return;
    const ids = sp.spawned.map((x) => x.entityId);
    const lostKeys = sp.unspawnable.map((x) => x.memberKey);
    const patch = { phase, scaleSteps: steps, engagedAt: now };
    if (hasWaves(row.eventType)) {
      const cfg = engagedCfgOf(row);
      patch.dueAt = now + (isDefense(row) ? s.waveIntervalMs : cfg.musterWaveIntervalMs);
    }
    const moved = write("engage", row.eventId, (tx) => {
      const current = currentInTx(tx, row);
      const r = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: current.version,
        from: S.STATE.PLANNED, to: S.STATE.ENGAGED, at: now, patch: { ...patch,
          members: markUnspawnable(current.members, lostKeys) } });
      if (!r.ok || r.duplicate === true) throw new Rollback("OTHER", r.ok ? "DUPLICATE" : r.reason);
      return r.row;
    });
    if (!moved) {
      despawnIds(seam, row.systemId, ids);
      return;
    }
    memory.set(row.eventId, { systemId: row.systemId, anchor: { ...site.position },
      spawned: new Map(sp.spawned.map((x) => [x.memberKey, x.entityId])), lastGridSeenAt: now,
      sceneMissingSince: null, hullOf: new Map(sp.spawned.map((x) => [x.entityId, x.hullGroup])),
      integrity: isDefense(row) ? (Number.isSafeInteger(row.integrity) ? row.integrity : S.INTEGRITY_START) : null,
      pressureAt: now, seen: new Map(), phaseSpawnedAt: now });
    bump("engaged");
    bump("shipsSpawned", ids.length);
    bump("unspawnable", lostKeys.length);
  }

  function spawnPending(seam, row, entry, now) {
    const pending = fieldOf(row, row.phase, row.scaleSteps).filter((m) => !entry.spawned.has(m.key));
    if (pending.length === 0) return;
    if (!env.admits(LIVE_CLASS)) {
      bump("deferred.GOVERNOR");
      return;
    }
    if (liveCount() + pending.length > s.maxLiveShips) {
      bump("deferred.BUDGET");
      return;
    }
    const sp = spawnMembers(seam, row, entry.anchor, pending);
    if (!sp.ok) return;
    for (const x of sp.spawned) {
      entry.spawned.set(x.memberKey, x.entityId);
      entry.hullOf.set(x.entityId, x.hullGroup);
    }
    bump("shipsSpawned", sp.spawned.length);
    const keys = sp.unspawnable.map((x) => x.memberKey);
    if (keys.length === 0) return;
    const marked = write("unspawnable", row.eventId, (tx) => {
      const current = currentInTx(tx, row);
      const r = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: current.version,
        from: S.STATE.ENGAGED, to: S.STATE.ENGAGED, at: now, patch: { members: markUnspawnable(current.members, keys) } });
      if (!r.ok) throw new Rollback("OTHER", r.reason);
      return r.row;
    });
    if (marked) bump("unspawnable", keys.length);
  }

  function despawnEntry(seam, entry) {
    despawnIds(seam, entry.systemId, [...entry.spawned.values()]);
    entry.spawned = new Map();
    entry.hullOf = new Map();
  }

  function forgetLost(seam, entry, lostKeys, lostIds) {
    for (const key of lostKeys) entry.spawned.delete(key);
    for (const id of lostIds) entry.hullOf.delete(id);
    despawnIds(seam, entry.systemId, lostIds);
  }

  const integrityPatchOf = (row, entry) => (isDefense(row) ? { integrity: integrityToRow(entry.integrity) } : {});

  function seePlayers(entry, players) {
    const present = [];
    for (const p of players) {
      const id = p && p.characterId;
      if (!Number.isSafeInteger(id) || id <= 0 || present.includes(id)) continue;
      present.push(id);
      entry.seen.set(id, (entry.seen.get(id) || 0) + 1);
    }
    entry.present = present;
  }

  function abandon(seam, row, entry, now) {
    despawnEntry(seam, entry);
    const target = abandonTargetOf(row, s);
    const r = write("abandon", row.eventId, (tx) => {
      const current = currentInTx(tx, row);
      if (target === S.STATE.EXPIRED) {
        return { expired: true, ...endInTx(tx, env, current, { to: S.STATE.EXPIRED, reason: S.END_REASON.ABANDONED,
          ...integrityPatchOf(row, entry) }, now) };
      }
      const moved = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: current.version,
        from: S.STATE.ENGAGED, to: S.STATE.PLANNED, patch: { abandons: current.abandons + 1,
          ...integrityPatchOf(row, entry) }, at: now, reason: S.END_REASON.ABANDONED });
      if (!moved.ok) throw new Rollback("OTHER", moved.reason);
      return { expired: false, duplicate: moved.duplicate === true };
    });
    if (!r) return;
    memory.delete(row.eventId);
    if (r.duplicate) return;
    bump("abandoned");
    if (r.expired) {
      bump("expired");
      bump("hullsReturned", r.returned);
      bump("hullsOrphaned", r.orphaned);
    }
  }

  function fail(seam, row, entry, reason, lostKeys, lostIds, now) {
    despawnEntry(seam, entry);
    const r = write("fail", row.eventId, (tx) => {
      const lost = lossesInTx(tx, currentInTx(tx, row), lostKeys, now);
      return { lost: lost.lost, ...endInTx(tx, env, lost.row, { to: S.STATE.FAILED, reason,
        ...integrityPatchOf(row, entry) }, now) };
    });
    if (!r) return;
    despawnIds(seam, entry.systemId, lostIds);
    memory.delete(row.eventId);
    bump("hullsLost", r.lost);
    if (r.duplicate) return;
    bump(reason === S.END_REASON.ESCAPED ? `${mechanicPrefixOf(row)}.failed.ESCAPED` : `failed.${reason}`);
    bump("hullsReturned", r.returned);
    bump("hullsOrphaned", r.orphaned);
  }

  function clear(seam, row, entry, lostKeys, lostIds, now) {
    const participants = paysParticipants(row) ? participantsOf(entry.seen, entry.present, s.minParticipantPasses,
      s.maxParticipants) : [];
    const r = write("clear", row.eventId, (tx) => {
      const lost = lossesInTx(tx, currentInTx(tx, row), lostKeys, now);
      return { lost: lost.lost, ...clearInTx(tx, lost.row, now, integrityPatchOf(row, entry), participants) };
    });
    if (!r) return;
    forgetLost(seam, entry, lostKeys, lostIds);
    despawnEntry(seam, entry);
    memory.delete(row.eventId);
    bump("hullsLost", r.lost);
    if (r.duplicate) return;
    bump(`cleared.${row.eventType}`);
    if (layerOf(row) === LAYER.WORLD) bump(`anomaly.cleared.${row.variant}`);
    bump("hullsReturned", r.returned);
    bump("hullsOrphaned", r.orphaned);
    if (r.influence !== null) {
      bump("influenceSkipped");
      refuse(`INFLUENCE ${row.eventId} ${r.influence}`);
    }
    if (r.drain) {
      bump("mineralsDrained", r.drain.total);
      if (r.drain.outcome === "EMPTY") bump("drain.empty");
      if (r.drain.outcome === "REFUSED") {
        bump("drain.refused");
        refuse(`DRAIN_MINERALS ${row.eventId} ${r.drain.reason}`);
      }
    }
    if (r.payouts) {
      bump("payout.planned", r.payouts.planned);
      if (r.payouts.failed !== null) {
        bump("payout.planFailed");
        refuse(`PAYOUT_PLAN ${row.eventId} ${r.payouts.failed}`);
      }
    }
  }

  function escape(seam, row, entry, lostKeys, lostIds, now) {
    const r = write("escape", row.eventId, (tx) => escapeInTx(tx, row, lostKeys, now));
    if (!r) return;
    forgetLost(seam, entry, lostKeys, lostIds);
    const ids = [];
    for (const key of r.escaped) {
      const id = entry.spawned.get(key);
      if (id === undefined) continue;
      ids.push(id);
      entry.spawned.delete(key);
      entry.hullOf.delete(id);
    }
    despawnIds(seam, entry.systemId, ids);
    bump("hullsLost", r.lost);
    if (r.duplicate) return;
    bump(`${mechanicPrefixOf(row)}.escaped`, r.escaped.length);
  }


  function waveOf(row, steps, lostKeys, reason) {
    if (!hasWaves(row.eventType)) return [];
    const isMuster = row.eventType === P.TYPE.MUSTER;
    const cfg = engagedCfgOf(row);
    const w = isMuster
      ? powerWaveMembersOf(row.eventType, row.tier, row.variant, row.phase + 1, { musterWaves: cfg.musterWaves, musterWaveGrowthPermille: cfg.musterWaveGrowthPermille })
      : waveMembersOf(row.eventType, row.tier, row.phase + 1, s);
    if (!w.ok) throw new Error(`wave ${row.phase + 1} ${w.reason}`);
    const known = new Set(row.members.map((m) => m && m.key));
    const wave = w.members.filter((m) => !known.has(m.key));
    if (reason !== "WAVE_DUE") return wave;
    const lost = new Set(lostKeys);
    const after = { eventType: row.eventType, members: [...row.members.filter((m) => m && !lost.has(m.key)), ...wave] };
    return fieldOf(after, row.phase + 1, steps).length > settingsOf(row).maxShipsPerEvent ? null : wave;
  }

  function nextPhase(seam, row, entry, grid, players, lostKeys, lostIds, now, reason) {
    const tier = tierDefOf(row.eventType, row.tier, row.variant);
    const steps = tier.ok ? scaleStepsOf(fleetPowerOf({ players, copies: grid.copies }, s), tier.def, row.scaleSteps, s)
      : row.scaleSteps;
    const wave = waveOf(row, Math.max(steps, row.scaleSteps), lostKeys, reason);
    if (wave === null) {
      bump("deferred.BUDGET");
      hold(seam, row, entry, players, lostKeys, lostIds, now);
      return;
    }
    const r = write("phase", row.eventId, (tx) => {
      const lost = lossesInTx(tx, currentInTx(tx, row), lostKeys, now);
      const patch = { phase: lost.row.phase + 1, scaleSteps: Math.max(steps, lost.row.scaleSteps) };
      if (hasWaves(row.eventType)) {
        const cfg = engagedCfgOf(row);
        const nextDueAt = now + (isDefense(row) ? s.waveIntervalMs : cfg.musterWaveIntervalMs);
        Object.assign(patch, { members: [...lost.row.members, ...wave], dueAt: nextDueAt },
          isDefense(row) ? integrityPatchOf(row, entry) : {});
      }
      const moved = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: lost.row.version,
        from: S.STATE.ENGAGED, to: S.STATE.ENGAGED, at: now, patch });
      if (!moved.ok || moved.duplicate === true) throw new Rollback("OTHER", moved.ok ? "DUPLICATE" : moved.reason);
      return { lost: lost.lost, row: moved.row };
    });
    if (!r) return;
    forgetLost(seam, entry, lostKeys, lostIds);
    bump("hullsLost", r.lost);
    bump("phase");
    entry.phaseSpawnedAt = now;
    spawnPending(seam, r.row, entry, now);
  }

  function hold(seam, row, entry, players, lostKeys, lostIds, now) {
    let current = row;
    if (lostKeys.length > 0) {
      const r = write("losses", row.eventId, (tx) => lossesInTx(tx, currentInTx(tx, row), lostKeys, now));
      if (!r) return;
      forgetLost(seam, entry, lostKeys, lostIds);
      bump("hullsLost", r.lost);
      current = r.row;
    }
    if (players >= 1) spawnPending(seam, current, entry, now);
  }

  function nextPocket(seam, row, entry, now, reason) {
    const oldPocket = Number.isSafeInteger(row.pocket) ? row.pocket : 0;
    const ls = layerSettingsOf(row);
    if (!ls) {
      bump("errors");
      refuse(`LIVE pocket ${row.eventId} NO_LAYER_SETTINGS`);
      return;
    }
    const prefix = mechanicPrefixOf(row);
    const trailParams = { trailPockets: ls.trailPockets };
    const pockets = pocketCountOf(row.eventType, row.tier, row.variant, trailParams);
    const newPocket = oldPocket + 1;
    if (pockets === null || newPocket >= pockets) {
      return;
    }
    const pocketTtlMs = ls.pocketTtlMs;
    const siteKind = visibilityOfPocket(row.eventType, row.tier, row.variant, newPocket, trailParams);
    const pocketSuffix = ` Pocket ${newPocket + 1}`;
    const pocketBase = String(pocketLabelBaseOf(row));
    const pocketLabel = pocketBase.length + pocketSuffix.length <= W.LABEL_MAX ? `${pocketBase}${pocketSuffix}`
      : `${pocketBase.slice(0, Math.max(0, W.LABEL_MAX - pocketSuffix.length)).trimEnd()}${pocketSuffix}`;
    const phasesInfo = require("./power/catalog").phasesOf(row.eventType, row.tier, row.variant, trailParams);
    let firstPhaseOfNewPocket = row.phase + 1;
    if (phasesInfo.ok) {
      const pocketStart = phasesInfo.pocketOf.indexOf(newPocket);
      if (pocketStart >= 0) firstPhaseOfNewPocket = phasesInfo.phases.length > pocketStart ? S.FIRST_PHASE + pocketStart : row.phase + 1;
    }
    const firstGlobalPhaseOfNewPocket = phaseOfPocket(row.eventType, row.tier, row.variant, newPocket, trailParams);
    const localPhase = (firstGlobalPhaseOfNewPocket !== null && Number.isSafeInteger(firstPhaseOfNewPocket))
      ? firstPhaseOfNewPocket - firstGlobalPhaseOfNewPocket
      : 0;
    if (localPhase < 0) {
      return;
    }

    const r = env.store.transaction("heavyEvents.pocket", (tx) => {
      const current = currentInTx(tx, row);
      const lost = entry.spawned.size > 0 ? lossesInTx(tx, current, [...entry.spawned.keys()], now) : { row: current, lost: 0 };
      const currentAfterLosses = lost.row;
      const pocketKey = P.pocketKeyOf(currentAfterLosses.eventId, newPocket);
      const journal = env.journal;
      const applied = journal.applyOnce(tx, { key: pocketKey, aggregate: { type: S.AGGREGATE, id: currentAfterLosses.eventId },
        eventType: S.EVENT_TRANSITION, payload: { eventId: currentAfterLosses.eventId, pocket: newPocket } }, () => ({ ok: true }));
      if (!applied || applied.ok !== true) throw new Rollback("OTHER", (applied && applied.reason) || "JOURNAL_FAILED");
      const sites = safe(() => env.getSites(), null);
      if (!sites || typeof sites.releaseSlotInTx !== "function") throw new Rollback("OTHER", "SITES_UNAVAILABLE");
      const released = sites.releaseSlotInTx(tx, currentAfterLosses.eventId, oldPocket, "POCKET");
      if (!released || released.ok !== true) throw new Rollback("OTHER", (released && released.reason) || "RELEASE_FAILED");
      const expiresAt = now + pocketTtlMs;
      const created = sites.createSiteInTx(tx, {
        eventId: currentAfterLosses.eventId,
        slot: newPocket,
        systemId: currentAfterLosses.systemId,
        templateId: s.beaconTemplateId,
        label: pocketLabel,
        factionId: currentAfterLosses.factionId,
        siteKind,
        expiresAt,
        phase: localPhase
      });
      if (!created || created.ok !== true) {
        const reason = (created && created.reason) || "CREATE_FAILED";
        if (reason === "SITES_FULL" || reason === "SYSTEM_WINDOW_FULL") {
          throw new Rollback(reason, "site capacity full");
        }
        throw new Rollback("OTHER", reason);
      }
      const patch = {
        pocket: newPocket,
        phase: firstPhaseOfNewPocket,
        expiresAt,
        result: { ...(currentAfterLosses.result || {}), pockets: newPocket }
      };
      const moved = env.repo.transitionInTx(tx, {
        eventId: currentAfterLosses.eventId,
        expectedVersion: currentAfterLosses.version,
        from: S.STATE.ENGAGED,
        to: S.STATE.PLANNED,
        at: now,
        patch
      });
      if (!moved.ok || moved.duplicate === true) throw new Rollback("OTHER", moved.ok ? "DUPLICATE" : moved.reason);
      return moved.row;
    });
    if (!r.ok) {
      const errMsg = String(r.error?.message || r.reason || "");
      const isSitesFull = errMsg.includes("SITES_FULL") || errMsg.includes("SYSTEM_WINDOW_FULL");
      if (isSitesFull) {
        const lostKeys = [...entry.spawned.keys()];
        despawnEntry(seam, entry);
        if (lostKeys.length > 0) {
          const lossResult = write("pocket_losses", row.eventId, (tx) => lossesInTx(tx, currentInTx(tx, row), lostKeys, now));
          if (!lossResult) {
            refuse(`LIVE pocket_losses ${row.eventId} loss recording failed`);
          }
        }
        bump(`${prefix}.deferred.SITES`);
      } else {
        bump("errors");
        refuse(`LIVE pocket ${row.eventId} ${r.error instanceof Rollback ? r.error.detail : (r.reason || "TX_FAILED")}`);
      }
      return;
    }
    despawnEntry(seam, entry);
    memory.delete(row.eventId);
    bump(`${prefix}.pocket`);
  }

  function step(seam, row, entry, now) {
    const ids = [...entry.spawned.values()];
    const mem = safe(() => seam.readMembers(row.systemId, ids), { ok: false, reason: "READ_THREW" });
    if (!mem || mem.ok !== true) {
      if (entry.sceneMissingSince === null) entry.sceneMissingSince = now;
      entry.pressureAt = now;
      const cfg = engagedCfgOf(row);
      const d = decideEngaged(row, { now, sceneLoaded: false, gridPlayers: null, phaseAlive: ids.length,
        phaseDestroyedNow: 0, lastGridSeenAt: entry.lastGridSeenAt, integrity: entry.integrity,
        ...targetFactsOf(row, entry, [], now, cfg) }, cfg);
      if (d.action === "FAIL") fail(seam, row, entry, d.reason, [], [], now);
      else if (d.action === "ABANDON" && now - entry.lastGridSeenAt >= cfg.abandonGraceMs) abandon(seam, row, entry, now);
      return;
    }
    entry.sceneMissingSince = null;
    if (isDefense(row)) {
      entry.integrity -= pressureOf(mem.live, entry.hullOf, entry.anchor, now - entry.pressureAt, s);
      entry.pressureAt = now;
    }
    const grid = safe(() => seam.readGrid(row.systemId, entry.anchor, s.gridRadiusM), { ok: false });
    const players = grid && grid.ok === true && Array.isArray(grid.players) ? grid.players.length : 0;
    if (players >= 1) entry.lastGridSeenAt = now;
    if (paysParticipants(row)) seePlayers(entry, players >= 1 ? grid.players : []);
    const gone = new Set(Array.isArray(mem.gone) ? mem.gone : []);
    const lostKeys = [];
    const lostIds = [];
    let alive = 0;
    for (const [key, id] of entry.spawned) {
      if (!gone.has(id)) alive += 1;
      else if (players >= 1) {
        lostKeys.push(key);
        lostIds.push(id);
      }
    }
    const pending = fieldOf(row, row.phase, row.scaleSteps).filter((m) => !entry.spawned.has(m.key)).length;
    const cfg = engagedCfgOf(row);
    const d = decideEngaged(row, { now, sceneLoaded: true, gridPlayers: players, phaseAlive: alive + pending,
      phaseDestroyedNow: lostKeys.length, lastGridSeenAt: entry.lastGridSeenAt, integrity: entry.integrity,
      ...targetFactsOf(row, entry, lostKeys, now, cfg) }, cfg);
    if (d.action === "FAIL") fail(seam, row, entry, d.reason, lostKeys, lostIds, now);
    else if (d.action === "ABANDON") abandon(seam, row, entry, now);
    else if (d.action === "CLEAR") clear(seam, row, entry, lostKeys, lostIds, now);
    else if (d.action === "ESCAPE") escape(seam, row, entry, lostKeys, lostIds, now);
    else if (d.action === "NEXT_POCKET") {
      nextPocket(seam, row, entry, now, d.reason);
    }
    else if (d.action === "NEXT_PHASE") {
      nextPhase(seam, row, entry, grid || {}, players, lostKeys, lostIds, now, d.reason);
    }
    else hold(seam, row, entry, players, lostKeys, lostIds, now);
  }

  function readWork(now) {
    const presence = safe(() => env.getPresence(), null);
    const observed = (systemId) => Boolean(presence && typeof presence.isObserved === "function"
      && safe(() => presence.isObserved(systemId), false) === true);
    const sites = safe(() => env.getSites(), null);
    return env.store.transaction("heavyEvents.liveRead", (tx) => {
      const open = env.repo.listOpenInTx(tx, { limit: S.OPEN_SCAN_LIMIT });
      if (!open.ok) throw new Rollback("OTHER", open.reason);
      const work = [];
      const engaged = new Set();
      for (const row of open.rows) {
        if (row.state === S.STATE.ENGAGED) {
          engaged.add(row.eventId);
          if (memory.has(row.eventId)) work.push({ row, site: null });
          continue;
        }
        if (row.state !== S.STATE.PLANNED || now >= row.expiresAt || !observed(row.systemId)) continue;
        if (!sites || typeof sites.listSitesByEvent !== "function") continue;
        const listed = sites.listSitesByEvent(row.eventId, tx);
        const slot = Number.isSafeInteger(row.pocket) ? row.pocket : SITE_SLOT;
        const site = listed && listed.ok === true && Array.isArray(listed.sites)
          ? listed.sites.find((x) => x && x.slot === slot) : null;
        if (site && site.state === SITE_STATE.ACTIVE && site.position) work.push({ row, site });
      }
      return { work, engaged, truncated: open.truncated === true };
    });
  }

  function pass(now) {
    const read = readWork(now);
    if (!read.ok) {
      bump("errors");
      refuse(`LIVE read ${read.error instanceof Rollback ? read.error.detail : read.reason}`);
      return;
    }
    const { work, engaged, truncated } = read.value;
    const seam = memory.size > 0 || work.length > 0 || strays.length > 0 ? seamNow() : null;
    retryStrays(seam);
    if (!truncated) {
      for (const [eventId, entry] of [...memory]) {
        if (engaged.has(eventId)) continue;
        despawnEntry(seam, entry);
        memory.delete(eventId);
      }
    }
    if (!seam) return;
    for (const item of work) {
      try {
        if (item.site) engage(seam, item.row, item.site, now);
        else step(seam, item.row, memory.get(item.row.eventId), now);
      } catch (err) {
        bump("errors");
        refuse(`LIVE ${item.row.eventId} ${messageOf(err)}`);
      }
    }
  }

  let seamDown = false;
  function seamNow() {
    const seam = safe(() => env.getSeam(), null);
    if (!seam && !seamDown) refuse("LIVE SEAM_UNAVAILABLE");
    seamDown = !seam;
    return seam;
  }

  function stopAll() {
    const seam = memory.size > 0 || strays.length > 0 ? seamNow() : null;
    retryStrays(seam);
    for (const entry of memory.values()) despawnEntry(seam, entry);
    memory.clear();
    strays = [];
  }

  const status = () => ({ engaged: memory.size, liveShips: liveCount(), strays: strays.length });

  return Object.freeze({ pass, liveCount, stopAll, status, clearInTx, payoutAmountsOf });
}

module.exports = { createLive, markUnspawnable, drainPlanOf, fieldOf, pressureOf,
  DRAIN_REASON, MINERAL_KIND, MINERAL_KEY_RE };
