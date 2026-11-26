"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { REWARD_FACTIONS, rewardLootIdOf } = require("../events/data/eventCatalog");
const { STATE: SITE_STATE } = require("../events/sites/schema");
const data = require("../events/salvage/data");
const S = require("./schema");
const P = require("./power/schema");
const W = require("./world/schema");
const WC = require("./world/catalog");
const { LAYER, layerOfRow } = require("./layer");
const { Rollback } = require("./planner");

const POWER_SKIP = "POWER";

const REWARD_CLASS = "OPERATIONAL";
const SITE_SLOT = 0;
const DAY_MS = 86400000;
const SEED_STREAM = "hevrwd";
const POWER_SEED_STREAM = "hpwrwd";
const LAST_DEGREE = 359;
const RAD_PER_DEGREE = Math.PI / 180;
const MAX_DETAIL = 160;
const PROFILES = Object.freeze({
  redoubt: Object.freeze({ key: "redoubt", sizeBand: "large", hullGroup: "battleship" }),
  foundry: Object.freeze({ key: "foundry", sizeBand: "medium", hullGroup: "battlecruiser" }),
  defense: Object.freeze({ key: "defense", sizeBand: "medium", hullGroup: "battlecruiser" }),
});
const POWER_PROFILES = Object.freeze({
  power_small: Object.freeze({ key: "power_small", sizeBand: "medium", hullGroup: "cruiser" }),
  power_cache: Object.freeze({ key: "power_cache", sizeBand: "large", hullGroup: "battlecruiser" }),
  power_rare: Object.freeze({ key: "power_rare", sizeBand: "large", hullGroup: "battleship" }),
});
const PERMILLE = 1000;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
};

const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const dayOf = (createdAt) => Math.floor(createdAt / DAY_MS);

function rollsOf(row, settings) {
  const perTier = S.parseTierRolls(settings.redoubtRolls) || [];
  const index = row.eventType === S.TYPE.DEFENSE ? 0 : row.tier - 1;
  const base = Number.isSafeInteger(perTier[index]) ? perTier[index] : 0;
  return Math.min(settings.maxLootRolls, base + row.scaleSteps * settings.rollsPerUpscaleStep);
}

function fixedItemsOf(row, settings) {
  if (row.eventType !== S.TYPE.FOUNDRY) return [];
  const drain = row.result && typeof row.result === "object" ? row.result.drain : null;
  if (!drain || drain.outcome !== "APPLIED" || !drain.units || typeof drain.units !== "object") return [];
  const out = [];
  for (const [key, drained] of Object.entries(drain.units)) {
    const typeId = Number(key);
    if (!Number.isSafeInteger(typeId) || typeId <= 0 || !Number.isSafeInteger(drained) || drained <= 0) continue;
    const quantity = Math.min(Math.floor((drained * settings.foundryLootSharePermille) / PERMILLE),
      settings.foundryLootMaxUnitsPerType);
    if (quantity > 0) out.push({ typeId, quantity });
  }
  return out.sort((a, b) => a.typeId - b.typeId).slice(0, S.DRAIN_MAX_TYPES);
}

function powerRollsOf(row, settings, resultJson) {
  const rollsKey = P.TYPE_ROLLS_KEY[row.eventType];
  const perTier = P.parseTierRolls(settings[rollsKey]) || [];
  const base = Number.isSafeInteger(perTier[row.tier - 1]) ? perTier[row.tier - 1] : 0;
  let mult = 1;
  if (resultJson && typeof resultJson === "object") {
    if (row.eventType === P.TYPE.TRAIL && Number.isSafeInteger(resultJson.pockets)) mult = Math.max(1, resultJson.pockets + 1);
    else if (row.eventType === P.TYPE.CONVOY && Number.isSafeInteger(resultJson.haulersKilled)) mult = Math.max(1, resultJson.haulersKilled);
    else if (row.eventType === P.TYPE.MUSTER && Number.isSafeInteger(resultJson.wavesCleared)) mult = Math.max(1, resultJson.wavesCleared);
  }
  let rolls = base * mult;
  if (row.affix === P.AFFIX.REINFORCED || row.affix === P.AFFIX.FLEETING) rolls += settings.affixRolls;
  if (row.affix === P.AFFIX.RICH) rolls += settings.richRolls;
  return Math.min(settings.maxLootRolls, rolls);
}

function worldRollsOf(row, settings) {
  const key = hasOwn(W.KIND_ROLLS_KEY, row.variant) ? W.KIND_ROLLS_KEY[row.variant] : null;
  const perTier = (key !== null && W.parseTierRolls(settings[key])) || [];
  const base = Number.isSafeInteger(perTier[row.tier - 1]) ? perTier[row.tier - 1] : 0;
  const result = row.result && typeof row.result === "object" ? row.result : {};
  const mult = row.eventType === P.TYPE.MUSTER && Number.isSafeInteger(result.wavesCleared)
    ? Math.max(1, result.wavesCleared) : 1;
  return Math.min(settings.maxLootRolls, base * mult);
}

function worldProfileOf(row) {
  const meta = hasOwn(WC.META, row.variant) ? WC.META[row.variant] : null;
  return meta && meta.rewardProfiles[row.tier - 1] ? meta.rewardProfiles[row.tier - 1] : null;
}

function cacheDrainInTx(tx, row, now, stations, settings) {
  if (row.eventType !== P.TYPE.CACHE) return null;
  if (!row.stationId) return { stationId: null, outcome: "REFUSED", reason: "ROW_NOT_FOUND", units: {}, total: 0 };
  const got = stations.getStation(tx, row.stationId);
  if (!got || got.ok !== true) throw new Rollback("OTHER", (got && got.reason) || "STATION_READ_FAILED");
  if (!got.record) return { stationId: row.stationId || null, outcome: "REFUSED", reason: "ROW_NOT_FOUND", units: {}, total: 0 };
  const { STATION_STATES } = require("../stations/schema");
  const STATION_DESTROYED_STATE = STATION_STATES[3];
  if (got.record.state === STATION_DESTROYED_STATE) return { stationId: row.stationId, outcome: "REFUSED", reason: "STATION_DESTROYED", units: {}, total: 0 };
  if (got.record.ownerFactionId !== row.factionId) return { stationId: row.stationId, outcome: "REFUSED", reason: "STATION_LOST", units: {}, total: 0 };
  const stock = stations.getStock(tx, row.stationId);
  if (!stock || stock.ok !== true) throw new Rollback("OTHER", (stock && stock.reason) || "STOCK_READ_FAILED");
  const { drainPlanOf, MINERAL_KIND, DRAIN_REASON } = require("./live");
  const plan = drainPlanOf(stock.items, settings.cacheDrainPermille, settings.drainMaxUnits);
  if (plan.length === 0) return { stationId: row.stationId, outcome: "EMPTY", units: {}, total: 0 };
  const r = stations.applyStockChange(tx, { stationId: row.stationId, key: P.drainKeyOf(row.eventId),
    reason: DRAIN_REASON, at: now,
    deltas: plan.map((p) => ({ itemKind: MINERAL_KIND, itemKey: p.itemKey, delta: -p.units })) });
  if (!r || r.ok !== true) {
    const detail = r && r.detail ? ` (${r.detail})` : "";
    return { stationId: row.stationId, outcome: "REFUSED", reason: String((r && r.reason) || "DRAIN_FAILED") + detail, units: {}, total: 0 };
  }
  if (r.duplicate === true) return { stationId: row.stationId, outcome: "DUPLICATE", units: {}, total: 0 };
  const units = {};
  for (const p of plan) units[String(p.typeId)] = p.units;
  return { stationId: row.stationId, outcome: "APPLIED", units, total: plan.reduce((a, p) => a + p.units, 0) };
}

function cacheFixedItemsOf(drainResult, settings) {
  if (!drainResult || drainResult.outcome !== "APPLIED" || !drainResult.units) return [];
  const out = [];
  for (const [key, drained] of Object.entries(drainResult.units)) {
    const typeId = Number(key);
    if (!Number.isSafeInteger(typeId) || typeId <= 0 || !Number.isSafeInteger(drained) || drained <= 0) continue;
    const quantity = Math.min(Math.floor((drained * settings.lootSharePermille) / PERMILLE),
      settings.lootMaxUnitsPerType);
    if (quantity > 0) out.push({ typeId, quantity });
  }
  return out.sort((a, b) => a.typeId - b.typeId).slice(0, S.DRAIN_MAX_TYPES);
}

function decidePowerReward(row, facts, settings) {
  if (facts.keyFound) return { action: "MARK" };
  if (!P.isPowerType(row.eventType)) return { action: "SKIP", reason: "NO_PROFILE" };
  if (!row.members.some((m) => m && m.state === S.MEMBER_STATE.DESTROYED)) return { action: "SKIP", reason: "NO_LOSSES" };
  if (row.rewardAttempts >= settings.rewardMaxAttempts) return { action: "SKIP", reason: "ATTEMPTS" };
  if (facts.dayFull) return { action: "SKIP", reason: "LIMIT_DAY" };
  if (facts.systemFull) return { action: "SKIP", reason: "LIMIT_SYSTEM" };
  const late = row.dueAt === null || facts.now >= row.dueAt;
  if (!facts.siteActive) return late ? { action: "SKIP", reason: "SITE" } : { action: "WAIT" };
  if (facts.sceneLoaded === false) return late ? { action: "SKIP", reason: "SCENE" } : { action: "WAIT" };
  return { action: "PLACE" };
}

function powerChestSpecOf(row, site, cfg, now, drainResult) {
  const meta = cfg.META && cfg.META[row.eventType];
  const profileKey = typeof cfg.profileOf === "function" ? cfg.profileOf(row) : (meta && meta.rewardProfile);
  const profile = profileKey ? POWER_PROFILES[profileKey] : null;
  if (!profile) return { ok: false, reason: "NO_PROFILE" };
  const Psettings = cfg.eventRewards;
  const faction = Object.prototype.hasOwnProperty.call(REWARD_FACTIONS, row.factionId) ? REWARD_FACTIONS[row.factionId] : null;
  const rng = require("../util/rng").createRng(require("../util/rng").deriveSeed(row.seed, POWER_SEED_STREAM));
  const angle = rng.nextInt(0, LAST_DEGREE) * RAD_PER_DEGREE;
  const slot = Number.isSafeInteger(row.pocket) ? row.pocket : SITE_SLOT;
  const spec = {
    anomalyId: row.eventId,
    slot,
    siteKey: site.siteKey,
    systemId: row.systemId,
    offset: { x: Math.round(Psettings.cacheOffsetM * Math.cos(angle)), y: 0, z: Math.round(Psettings.cacheOffsetM * Math.sin(angle)) },
    shipTypeId: 0,
    hullGroup: profile.hullGroup,
    factionName: data.wreckFactionNameOf(row.factionId),
    ownerId: data.ownerCorporationOf(row.factionId),
    lootRolls: typeof cfg.rollsOf === "function" ? cfg.rollsOf(row) : powerRollsOf(row, cfg.powerSettings, row.result),
    nowMs: now,
    expiresAtMs: now + cfg.settings.aftermathMs,
    fallbackWreckNames: data.fallbackWreckNamesOf(profile.hullGroup, row.factionId),
    adopt: true,
  };
  const fixedItems = cacheFixedItemsOf(drainResult, cfg.powerSettings);
  if (fixedItems.length > 0) spec.fixedItems = fixedItems;
  if (faction) {
    let deadspaceWeight = Psettings.deadspaceModuleWeight;
    if (profile.key === "power_rare" || row.affix === P.AFFIX.RICH) {
      const factor = Math.min(cfg.powerSettings.rareDeadspacePermille / PERMILLE, 1);
      deadspaceWeight = Math.min(deadspaceWeight * factor, cfg.powerSettings.maxWeight || Psettings.maxWeight || deadspaceWeight);
    }
    spec.rewardLoot = {
      id: rewardLootIdOf(profile.key, row.factionId),
      sizeBand: profile.sizeBand,
      itemPrefixes: [...faction.itemPrefixes],
      deadspacePrefixes: [...faction.deadspacePrefixes],
      factionAmmoWeight: Psettings.factionAmmoWeight,
      factionModuleWeight: Psettings.factionModuleWeight,
      deadspaceModuleWeight: deadspaceWeight,
      minEntries: Psettings.minEntries,
      maxEntries: Math.max(Psettings.minEntries, Psettings.maxEntries),
    };
  } else {
    spec.lootTableId = typeof cfg.lootTableOf === "function" ? cfg.lootTableOf(row, profile.hullGroup)
      : chestLootTableOf(row.factionId, profile.hullGroup, cfg);
  }
  return { ok: true, spec, profile: profile.key };
}

function worldLootTableOf(row, hullGroup, cfg) {
  const meta = hasOwn(WC.META, row.variant) ? WC.META[row.variant] : null;
  if (meta && meta.invaderLoot === true) {
    return data.resolveLootTable(row.factionId, hullGroup, { sizedDefault: true, fallbackId: null });
  }
  return chestLootTableOf(row.factionId, hullGroup, cfg);
}

function chestLootTableOf(factionId, hullGroup, cfg) {
  return data.resolveLootTable(factionId, hullGroup,
    { sizedDefault: cfg.sizedDefaultLoot === true, fallbackId: cfg.fallbackLootTableId });
}

function chestSpecOf(row, site, cfg, now) {
  const profile = hasOwn(PROFILES, row.eventType) ? PROFILES[row.eventType] : null;
  if (!profile) return { ok: false, reason: "NO_PROFILE" };
  const P = cfg.eventRewards;
  const faction = hasOwn(REWARD_FACTIONS, row.factionId) ? REWARD_FACTIONS[row.factionId] : null;
  const rng = createRng(deriveSeed(row.seed, SEED_STREAM));
  const angle = rng.nextInt(0, LAST_DEGREE) * RAD_PER_DEGREE;
  const slot = Number.isSafeInteger(row.pocket) ? row.pocket : SITE_SLOT;
  const spec = {
    anomalyId: row.eventId,
    slot,
    siteKey: site.siteKey,
    systemId: row.systemId,
    offset: { x: Math.round(P.cacheOffsetM * Math.cos(angle)), y: 0, z: Math.round(P.cacheOffsetM * Math.sin(angle)) },
    shipTypeId: 0,
    hullGroup: profile.hullGroup,
    factionName: data.wreckFactionNameOf(row.factionId),
    ownerId: data.ownerCorporationOf(row.factionId),
    lootRolls: rollsOf(row, cfg.settings),
    nowMs: now,
    expiresAtMs: now + cfg.settings.aftermathMs,
    fallbackWreckNames: data.fallbackWreckNamesOf(profile.hullGroup, row.factionId),
    adopt: true,
  };
  const fixedItems = fixedItemsOf(row, cfg.settings);
  if (fixedItems.length > 0) spec.fixedItems = fixedItems;
  if (faction) {
    spec.rewardLoot = {
      id: rewardLootIdOf(profile.key, row.factionId),
      sizeBand: profile.sizeBand,
      itemPrefixes: [...faction.itemPrefixes],
      deadspacePrefixes: [...faction.deadspacePrefixes],
      factionAmmoWeight: P.factionAmmoWeight,
      factionModuleWeight: P.factionModuleWeight,
      deadspaceModuleWeight: P.deadspaceModuleWeight,
      minEntries: P.minEntries,
      maxEntries: Math.max(P.minEntries, P.maxEntries),
    };
  } else {
    spec.lootTableId = chestLootTableOf(row.factionId, profile.hullGroup, cfg);
  }
  return { ok: true, spec, profile: profile.key };
}

function decideReward(row, facts, settings) {
  if (facts.keyFound) return { action: "MARK" };
  if (!hasOwn(PROFILES, row.eventType)) return { action: "SKIP", reason: "NO_PROFILE" };
  if (!row.members.some((m) => m && m.state === S.MEMBER_STATE.DESTROYED)) return { action: "SKIP", reason: "NO_LOSSES" };
  if (row.rewardAttempts >= settings.rewardMaxAttempts) return { action: "SKIP", reason: "ATTEMPTS" };
  if (facts.dayFull) return { action: "SKIP", reason: "LIMIT_DAY" };
  if (facts.systemFull) return { action: "SKIP", reason: "LIMIT_SYSTEM" };
  const late = row.dueAt === null || facts.now >= row.dueAt;
  if (!facts.siteActive) return late ? { action: "SKIP", reason: "SITE" } : { action: "WAIT" };
  if (facts.sceneLoaded === false) return late ? { action: "SKIP", reason: "SCENE" } : { action: "WAIT" };
  return { action: "PLACE" };
}

function createReward(env, hooks) {
  const s = env.settings;
  const cfg = { settings: s, eventRewards: env.eventRewards, fallbackLootTableId: env.fallbackLootTableId,
    sizedDefaultLoot: env.sizedDefaultLoot === true };
  const bump = (name, n) => safe(() => hooks.bump(name, n), null);
  const refuse = (line) => safe(() => hooks.refuse(line), null);
  const rowLimit = env.store.limits && Number.isSafeInteger(env.store.limits.maxRowsPerTransaction)
    && env.store.limits.maxRowsPerTransaction > 0 ? env.store.limits.maxRowsPerTransaction : null;
  const POWER_DESC = Object.freeze({ counter: "power", rewardKeyOf: P.rewardKeyOf, rewardDayRangeOf: P.rewardDayRangeOf,
    settings: env.power, chestSettings: env.power, profileOf: null, rollsOf: null });
  const WORLD_DESC = Object.freeze({ counter: "anomaly", rewardKeyOf: W.rewardKeyOf,
    rewardDayRangeOf: W.rewardDayRangeOf, settings: env.world || null,
    chestSettings: env.world ? { ...(env.power || {}), ...env.world } : null, profileOf: worldProfileOf,
    rollsOf: (row) => worldRollsOf(row, env.world),
    lootTableOf: (row, hullGroup) => worldLootTableOf(row, hullGroup, cfg) });
  const layerDescOf = (row) => {
    const layer = layerOfRow(row) || (P.isPowerType(row.eventType) ? LAYER.POWER : LAYER.HEAVY);
    if (layer === LAYER.WORLD || layer === LAYER.INCURSION) return WORLD_DESC;
    return layer === LAYER.POWER ? POWER_DESC : null;
  };

  function capFull(tx, counts, picked, from, to, cap) {
    if (cap <= 0) return true;
    const limit = rowLimit === null ? cap : Math.min(cap, rowLimit);
    if (!counts.has(from)) {
      const r = env.journal.countKeyRange(tx, from, to, limit);
      if (!r || r.ok !== true) throw new Rollback("OTHER", `countKeyRange ${(r && r.reason) || "no result"}`);
      counts.set(from, r.count);
    }
    return counts.get(from) + (picked.get(from) || 0) >= limit;
  }

  function readWork(now, rewardsAdmitted) {
    const sites = safe(() => env.getSites(), null);
    return env.store.transaction("heavyEvents.rewardRead", (tx) => {
      const open = env.repo.listOpenInTx(tx, { limit: S.OPEN_SCAN_LIMIT });
      if (!open.ok) throw new Rollback("OTHER", open.reason);
      const chests = [];
      const releases = [];
      let waiting = 0;
      let siteReadFailed = 0;
      const counts = new Map();
      const picked = new Map();
      for (const row of open.rows) {
        if (row.state === S.STATE.COMPLETED && row.cleanupAt !== null && now >= row.cleanupAt) {
          releases.push(row);
          continue;
        }
        if (row.state !== S.STATE.CLEARED) continue;
        if (!rewardsAdmitted) {
          waiting += 1;
          continue;
        }
        const desc = layerDescOf(row);
        if (desc) {
          const day = dayOf(row.createdAt);
          const key = desc.rewardKeyOf(day, row.systemId, row.eventId);
          if (!desc.settings) {
            chests.push({ row, key, site: null, facts: { now }, d: { action: "SKIP", reason: "NO_PROFILE" },
              isPower: true, desc });
            continue;
          }
          const seen = env.journal.findByKey(tx, key);
          if (!seen || seen.ok !== true) throw new Rollback("OTHER", `findByKey ${(seen && seen.reason) || "no result"}`);
          const listed = sites && typeof sites.listSitesByEvent === "function" ? sites.listSitesByEvent(row.eventId, tx)
            : null;
          const readable = Boolean(listed && listed.ok === true && Array.isArray(listed.sites));
          if (!readable && seen.found !== true) {
            siteReadFailed += 1;
            continue;
          }
          const slot = Number.isSafeInteger(row.pocket) ? row.pocket : SITE_SLOT;
          const site = readable ? listed.sites.find((x) => x && x.slot === slot) || null : null;
          const siteActive = Boolean(site && site.state === SITE_STATE.ACTIVE && typeof site.siteKey === "string");
          const dayRange = desc.rewardDayRangeOf(day);
          const sysFrom = `${dayRange.from}${row.systemId}:`;
          const facts = { now, keyFound: seen.found === true, siteActive, sceneLoaded: null,
            dayFull: seen.found !== true && capFull(tx, counts, picked, dayRange.from, dayRange.to,
              desc.settings.rewardMaxPerDay),
            systemFull: false };
          if (!facts.keyFound && !facts.dayFull) {
            facts.systemFull = capFull(tx, counts, picked, sysFrom, `${dayRange.from}${row.systemId};`,
              desc.settings.rewardMaxPerSystemPerDay);
          }
          const d = decidePowerReward(row, facts, desc.settings);
          if (d.action === "PLACE") {
            picked.set(dayRange.from, (picked.get(dayRange.from) || 0) + 1);
            picked.set(sysFrom, (picked.get(sysFrom) || 0) + 1);
          }
          chests.push({ row, key, site, facts, d, isPower: true, desc });
          continue;
        }
        const day = dayOf(row.createdAt);
        const key = S.rewardKeyOf(day, row.systemId, row.eventId);
        const seen = env.journal.findByKey(tx, key);
        if (!seen || seen.ok !== true) throw new Rollback("OTHER", `findByKey ${(seen && seen.reason) || "no result"}`);
        const listed = sites && typeof sites.listSitesByEvent === "function" ? sites.listSitesByEvent(row.eventId, tx)
          : null;
        const readable = Boolean(listed && listed.ok === true && Array.isArray(listed.sites));
        if (!readable && seen.found !== true) {
          siteReadFailed += 1;
          continue;
        }
        const slot = Number.isSafeInteger(row.pocket) ? row.pocket : SITE_SLOT;
        const site = readable ? listed.sites.find((x) => x && x.slot === slot) || null : null;
        const siteActive = Boolean(site && site.state === SITE_STATE.ACTIVE && typeof site.siteKey === "string");
        const dayRange = S.rewardDayRangeOf(day);
        const sysFrom = `${dayRange.from}${row.systemId}:`;
        const facts = { now, keyFound: seen.found === true, siteActive, sceneLoaded: null,
          dayFull: seen.found !== true && capFull(tx, counts, picked, dayRange.from, dayRange.to, s.rewardMaxPerDay),
          systemFull: false };
        if (!facts.keyFound && !facts.dayFull) {
          facts.systemFull = capFull(tx, counts, picked, sysFrom, `${dayRange.from}${row.systemId};`,
            s.rewardMaxPerSystemPerDay);
        }
        const d = decideReward(row, facts, s);
        if (d.action === "PLACE") {
          picked.set(dayRange.from, (picked.get(dayRange.from) || 0) + 1);
          picked.set(sysFrom, (picked.get(sysFrom) || 0) + 1);
        }
        chests.push({ row, key, site, facts, d, isPower: false });
      }
      return { chests, releases, waiting, siteReadFailed };
    });
  }

  function complete(row, key, rewardState, now, payload) {
    const r = env.store.transaction("heavyEvents.reward", (tx) => {
      const got = env.repo.getInTx(tx, row.eventId);
      if (!got.ok) throw new Rollback("OTHER", got.reason);
      if (!got.row || got.row.state !== S.STATE.CLEARED) return { gone: true };
      if (got.row.version !== row.version) throw new Rollback("OTHER", "VERSION_CONFLICT");
      if (payload !== null) {
        const marked = env.journal.applyOnce(tx, { key, aggregate: { type: S.AGGREGATE, id: row.eventId },
          eventType: S.EVENT_REWARD, payload }, () => ({ ok: true }));
        if (!marked || marked.ok !== true) throw new Rollback("OTHER", (marked && marked.reason) || "MARK_FAILED");
      }
      const moved = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: row.version,
        from: S.STATE.CLEARED, to: S.STATE.COMPLETED, at: now, reason: S.END_REASON.CLEARED,
        patch: { rewardState, cleanupAt: now + s.aftermathMs, endedAt: now, endReason: S.END_REASON.CLEARED } });
      if (!moved.ok) throw new Rollback("OTHER", moved.reason);
      return { gone: false, duplicate: moved.duplicate === true };
    });
    if (r.ok) return r.value;
    bump("errors");
    refuse(`REWARD ${row.eventId} ${r.error instanceof Rollback ? r.error.detail : (r.reason || "TX_FAILED")}`);
    return null;
  }

  function skip(item, reason, now) {
    const r = complete(item.row, item.key, S.REWARD_STATE.SKIPPED, now, null);
    if (!r || r.gone || r.duplicate) return;
    if (item.isPower) {
      bump(`${item.desc.counter}.reward.skipped`);
      bump(`${item.desc.counter}.reward.skipped.${reason}`);
      return;
    }
    if (reason === POWER_SKIP) {
      bump("power.reward.skipped");
      return;
    }
    bump("reward.skipped");
    bump(`reward.skipped.${reason}`);
  }

  function attempt(row, now) {
    const r = env.store.transaction("heavyEvents.rewardAttempt", (tx) => {
      const moved = env.repo.rewardAttemptInTx(tx, { eventId: row.eventId, expectedVersion: row.version, at: now });
      if (!moved.ok) throw new Rollback("OTHER", moved.reason);
      return moved;
    });
    if (!r.ok) bump("errors");
  }

  function place(wrecks, item, now) {
    const built = chestSpecOf(item.row, item.site, cfg, now);
    if (!built.ok) {
      skip(item, built.reason, now);
      return;
    }
    const res = safe(() => wrecks.place(built.spec), { ok: false, reason: "PLACE_THREW" }) || { ok: false };
    if (Number.isSafeInteger(res.vendorWrites) && res.vendorWrites > 0 && typeof wrecks.flush === "function") {
      safe(() => wrecks.flush(), null);
    }
    if (res.ok !== true) {
      bump("reward.failed");
      refuse(`REWARD place ${item.row.eventId} ${res.reason || "PLACE_FAILED"}${res.detail ? ` ${res.detail}` : ""}`);
      attempt(item.row, now);
      return;
    }
    const r = complete(item.row, item.key, S.REWARD_STATE.PLACED, now, { eventId: item.row.eventId,
      systemId: item.row.systemId, factionId: item.row.factionId, profile: built.profile });
    if (!r || r.gone || r.duplicate) return;
    bump("reward.placed");
  }

  function placePower(wrecks, item, now) {
    const row = item.row;
    const stations = safe(() => env.getStations(), null);
    const stationsRepo = stations && stations.repository;
    if (!stationsRepo) {
      refuse("REWARD STATIONS_UNAVAILABLE");
      skip(item, "STATIONS_UNAVAILABLE", now);
      return;
    }
    const desc = item.desc;
    const powerCfg = { ...cfg, powerSettings: desc.chestSettings, META: require("./power/catalog").META,
      ...(desc.profileOf ? { profileOf: desc.profileOf } : {}), ...(desc.rollsOf ? { rollsOf: desc.rollsOf } : {}),
      ...(desc.lootTableOf ? { lootTableOf: desc.lootTableOf } : {}) };
    const r = env.store.transaction("heavyEvents.powerReward", (tx) => {
      const got = env.repo.getInTx(tx, row.eventId);
      if (!got.ok) throw new Rollback("OTHER", got.reason);
      if (!got.row || got.row.state !== S.STATE.CLEARED) return { gone: true };
      if (got.row.version !== row.version) throw new Rollback("OTHER", "VERSION_CONFLICT");
      const drainResult = cacheDrainInTx(tx, got.row, now, stationsRepo, env.power);
      const specDrain = got.row.eventType === P.TYPE.CONVOY ? (got.row.result && got.row.result.drain) || null
        : drainResult;
      const built = powerChestSpecOf(got.row, item.site, powerCfg, now, specDrain);
      if (!built.ok) throw new Rollback("OTHER", built.reason);
      return { built, drainResult };
    });
    if (!r.ok) {
      bump("errors");
      refuse(`POWER_REWARD_TX ${row.eventId} ${r.error instanceof Rollback ? r.error.detail : (r.reason || "TX_FAILED")}`);
      return;
    }
    const { built, drainResult } = r.value;
    if (drainResult) {
    }
    const res = safe(() => wrecks.place(built.spec), { ok: false, reason: "PLACE_THREW" }) || { ok: false };
    if (Number.isSafeInteger(res.vendorWrites) && res.vendorWrites > 0 && typeof wrecks.flush === "function") {
      safe(() => wrecks.flush(), null);
    }
    if (res.ok !== true) {
      bump(`${desc.counter}.reward.failed`);
      refuse(`POWER_REWARD place ${row.eventId} ${res.reason || "PLACE_FAILED"}${res.detail ? ` ${res.detail}` : ""}`);
      attempt(row, now);
      return;
    }
    const markResult = env.store.transaction("heavyEvents.powerRewardMark", (tx) => {
      const got = env.repo.getInTx(tx, row.eventId);
      if (!got.ok) throw new Rollback("OTHER", got.reason);
      if (!got.row || got.row.state !== S.STATE.CLEARED) return { gone: true };
      if (got.row.version !== row.version) throw new Rollback("OTHER", "VERSION_CONFLICT");
      const marked = env.journal.applyOnce(tx, { key: item.key, aggregate: { type: S.AGGREGATE, id: row.eventId },
        eventType: S.EVENT_REWARD, payload: { eventId: row.eventId, systemId: row.systemId, factionId: row.factionId, profile: built.profile } },
        () => ({ ok: true }));
      if (!marked || marked.ok !== true) throw new Rollback("OTHER", (marked && marked.reason) || "MARK_FAILED");
      const patch = { rewardState: S.REWARD_STATE.PLACED, cleanupAt: now + env.settings.aftermathMs, endedAt: now, endReason: S.END_REASON.CLEARED };
      if (drainResult) patch.result = { ...(got.row.result || {}), drain: drainResult };
      const moved = env.repo.transitionInTx(tx, { eventId: row.eventId, expectedVersion: row.version,
        from: S.STATE.CLEARED, to: S.STATE.COMPLETED, at: now, reason: S.END_REASON.CLEARED, patch });
      if (!moved.ok) throw new Rollback("OTHER", moved.reason);
      return { gone: false, duplicate: moved.duplicate === true, drainResult };
    });
    if (!markResult.ok) {
      bump("errors");
      refuse(`POWER_REWARD_MARK ${row.eventId} ${markResult.error instanceof Rollback ? markResult.error.detail : (markResult.reason || "TX_FAILED")}`);
      return;
    }
    if (!markResult.value || markResult.value.gone || markResult.value.duplicate) return;
    if (drainResult) {
      bump("mineralsDrained", drainResult.total);
      if (drainResult.outcome === "EMPTY") bump("drain.empty");
      if (drainResult.outcome === "REFUSED") {
        bump("drain.refused");
        refuse(`DRAIN_MINERALS ${row.eventId} ${drainResult.reason}`);
      }
    }
    bump(`${desc.counter}.reward.placed`);
  }

  function release(row, now) {
    const r = env.store.transaction("heavyEvents.release", (tx) => {
      const got = env.repo.getInTx(tx, row.eventId);
      if (!got.ok) throw new Rollback("OTHER", got.reason);
      if (!got.row || !got.row.open || got.row.state !== S.STATE.COMPLETED) return null;
      const rel = env.repo.releaseSiteInTx(tx, { eventId: row.eventId, expectedVersion: got.row.version, at: now });
      if (!rel.ok) throw new Rollback("OTHER", rel.reason);
      const sites = safe(() => env.getSites(), null);
      const cleaned = sites && typeof sites.cleanupSitesInTx === "function"
        ? sites.cleanupSitesInTx(tx, row.eventId, "EVENT_END") : null;
      if (!cleaned || cleaned.ok !== true) throw new Rollback("OTHER", (cleaned && cleaned.reason) || "CLEANUP_FAILED");
      return rel;
    });
    if (r.ok) return;
    bump("errors");
    refuse(`RELEASE ${row.eventId} ${r.error instanceof Rollback ? r.error.detail : (r.reason || "TX_FAILED")}`);
  }

  function wrecksNow() {
    const w = safe(() => env.getWrecks(), null);
    return w && w.ok === true && typeof w.place === "function" ? w : null;
  }

  function sceneLoaded(wrecks, systemId) {
    if (typeof wrecks.readGrid !== "function") return null;
    const g = safe(() => wrecks.readGrid(systemId, [], null, 0), null);
    return g && g.ok === true ? g.sceneLoaded === true : null;
  }

  function pass(now) {
    const admitted = env.admits(REWARD_CLASS);
    const read = readWork(now, admitted);
    if (!read.ok) {
      bump("errors");
      refuse(`REWARD read ${read.error instanceof Rollback ? read.error.detail : read.reason}`);
      return;
    }
    const { chests, releases, waiting, siteReadFailed } = read.value;
    if (waiting > 0) bump("deferred.GOVERNOR");
    if (siteReadFailed > 0) {
      bump("deferred.SITE_READ", siteReadFailed);
      refuse(`REWARD SITE_READ ${siteReadFailed} rows`);
    }
    let wrecks;
    for (const item of chests) {
      try {
        const d = item.d;
        if (d.action === "SKIP") skip(item, d.reason, now);
        else if (d.action === "WAIT") bump("deferred.SCENE");
        else if (d.action === "MARK") {
          if (item.isPower) {
            const r = complete(item.row, item.key, S.REWARD_STATE.PLACED, now, null);
            if (r && !r.gone && !r.duplicate) bump(`${item.desc.counter}.reward.placed`);
          } else {
            const r = complete(item.row, item.key, S.REWARD_STATE.PLACED, now, null);
            if (r && !r.gone && !r.duplicate) bump("reward.placed");
          }
        } else {
          if (wrecks === undefined) wrecks = wrecksNow();
          if (!wrecks) {
            refuse("REWARD SEAM_UNAVAILABLE");
            break;
          }
          if (item.isPower) {
            const scene = sceneLoaded(wrecks, item.row.systemId);
            const again = scene === false ? decidePowerReward(item.row, { ...item.facts, sceneLoaded: false },
              item.desc.settings) : d;
            if (again.action === "SKIP") skip(item, again.reason, now);
            else if (again.action === "WAIT") bump("deferred.SCENE");
            else placePower(wrecks, item, now);
          } else {
            const scene = sceneLoaded(wrecks, item.row.systemId);
            const again = scene === false ? decideReward(item.row, { ...item.facts, sceneLoaded: false }, s) : d;
            if (again.action === "SKIP") skip(item, again.reason, now);
            else if (again.action === "WAIT") bump("deferred.SCENE");
            else place(wrecks, item, now);
          }
        }
      } catch (err) {
        bump("errors");
        refuse(`REWARD ${item.row.eventId} ${messageOf(err)}`);
      }
    }
    for (const row of releases) release(row, now);
  }

  return Object.freeze({ pass });
}

module.exports = { createReward, chestSpecOf, decideReward, rollsOf, dayOf, fixedItemsOf, PROFILES,
  powerRollsOf, cacheDrainInTx, cacheFixedItemsOf, decidePowerReward, powerChestSpecOf, POWER_PROFILES,
  worldRollsOf, worldProfileOf, worldLootTableOf };
