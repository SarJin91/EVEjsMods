"use strict";

const TABLE = "world_bosses";
const PARTICIPANTS_TABLE = "world_boss_participants";
const PAYOUTS_TABLE = "world_boss_payouts";

const STATES = Object.freeze({ DWELL: "DWELL", MOVING: "MOVING", DEFEATED: "DEFEATED", EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED" });
const OPEN_STATES = Object.freeze([STATES.DWELL, STATES.MOVING]);
const END_STATES = Object.freeze([STATES.DEFEATED, STATES.EXPIRED, STATES.CANCELLED]);
const MODES = Object.freeze({ VIRTUAL: "VIRTUAL", LIVE: "LIVE" });
const ORIGIN_KINDS = Object.freeze({ ROLL: "roll", SEASON: "season", ADMIN: "admin" });
const REWARD_STATES = Object.freeze({ NONE: "NONE", PENDING: "PENDING", PLACED: "PLACED", SKIPPED: "SKIPPED" });
const END_REASONS = Object.freeze({ MAX_HOPS: "MAX_HOPS", LIFETIME: "LIFETIME", NO_NEIGHBOR: "NO_NEIGHBOR",
  DRAIN: "DRAIN", ADMIN: "ADMIN", DEFEATED: "DEFEATED" });

const JOURNAL_AGGREGATE = "world_boss";
const ROLL_AGGREGATE_ID = "roll";
const EVENT = Object.freeze({ SPAWNED: "WORLD_BOSS_SPAWNED", MOVED: "WORLD_BOSS_MOVED",
  ARRIVED: "WORLD_BOSS_ARRIVED", ENDED: "WORLD_BOSS_ENDED", ROLLED: "WORLD_BOSS_ROLLED",
  ROUND: "WORLD_BOSS_ROUND", SWEPT: "WORLD_BOSS_CLASHES_SWEPT", DAMAGED: "WORLD_BOSS_DAMAGED",
  LIVE: "WORLD_BOSS_LIVE",
  REWARD: "WORLD_BOSS_REWARD", RELEASED: "WORLD_BOSS_RELEASED" });
const REWARD_REASONS = Object.freeze({ NO_PARTICIPANTS: "NO_PARTICIPANTS", NO_SITE: "NO_SITE", ATTEMPTS: "ATTEMPTS",
  STALE: "STALE", VIRTUAL: "VIRTUAL" });
const PAYOUT_STATES = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });
const ISK_SOURCE = "lne-worldbosses";
const PAYOUT_DESCRIPTION = "World boss bounty";
const GM_STEP_TYPE = "BOSS";
const GM_OWNER = "worldBosses";
const HINT_KEY = "worldBosses";
const NEWS = Object.freeze({ AGGREGATE: JOURNAL_AGGREGATE, SPAWNED: EVENT.SPAWNED, ENDED: EVENT.ENDED,
  START_PREFIX: "wbs", END_PREFIX: "wbe", LIVE_MODE: MODES.LIVE,
  OUTCOMES: Object.freeze({ DEFEATED: STATES.DEFEATED, EXPIRED: STATES.EXPIRED, CANCELLED: STATES.CANCELLED }) });
const NOTICE_KIND = "WORLD_BOSS";

const RNG = Object.freeze({ ROLL: "world-boss", SPAWN: "world-boss-spawn", HOP: "hop", GOAL: "goal" });

const MAX_BOSS_ID_LENGTH = 40;
const MAX_ORIGIN_REF_LENGTH = 64;
const MAX_KIND_LENGTH = 32;
const MAX_SITE_EVENT_ID_LENGTH = 64;
const BEACON_SLOT = 0;

const WORLD_BOSS_BATTLE_ROWS_BOUND = 5;

const VIEW_ID = "world-bosses";
const LAYER_ID = "layer-bosses";

function bossIdOf(bossNo, createdAt) {
  return `wb${Math.trunc(bossNo).toString(36)}-${Math.trunc(createdAt)}`;
}

const SENTRY_PREFIX = "wb:";
const UNIT_SENTRY_RE = /^wb:(\d+):p(\d+):([a-z_]+\d+)$/;

function sentryIdOf(bossNo, phase, unitKey) {
  return `${SENTRY_PREFIX}${Math.trunc(bossNo)}:p${Math.trunc(phase)}:${unitKey}`;
}

function parseSentryId(sentryId) {
  const m = typeof sentryId === "string" ? UNIT_SENTRY_RE.exec(sentryId) : null;
  if (!m) return null;
  const bossNo = Number(m[1]);
  const phase = Number(m[2]);
  return Number.isSafeInteger(bossNo) && bossNo > 0 && Number.isSafeInteger(phase) && phase > 0
    ? { bossNo, phase, unitKey: m[3] } : null;
}

const keyRoll = (bucket) => `wb:roll:${bucket}`;
const keySpawn = (bossId) => `wb:${bossId}:spawn`;
const keyStep = (bossId, stepSeq) => `wb:${bossId}:step:${stepSeq}`;
const keyBlight = (bossId, visitNo) => `wb:${bossId}:blight:${visitNo}`;
const keyEnd = (bossId) => `wb:${bossId}:end`;
const keyRound = (bossId, version) => `wb:${bossId}:round:v${version}`;
const keySweep = (bossId, version) => `wb:${bossId}:sweep:v${version}`;
const keyDamage = (ck) => `${ck}:wb`;
const beaconEventIdOf = (bossId, visitNo) => `wb:${bossId}:v${visitNo}`;
const keyLiveStart = (bossId, visitNo, version) => `wb:${bossId}:live:${visitNo}:${version}`;
const keyLiveLoss = (bossId, phase, unitKey) => `wb:${bossId}:lk:${phase}:${unitKey}`;
const keyLivePhase = (bossId, phase) => `wb:${bossId}:ph:${phase}`;
const keyLiveExit = (bossId, version) => `wb:${bossId}:lx:v${version}`;
const keyRecover = (bossId, bootAt) => `wb:${bossId}:recover:${bootAt}`;
const keyLiveHold = (bossId, stepSeq) => `wb:${bossId}:hold:${stepSeq}`;
const keyEta = (bossId, visitNo) => `wb:${bossId}:eta:${visitNo}`;
const keyReward = (bossId) => `wbrwd:${bossId}`;
const keyRelease = (bossId) => `wb:${bossId}:release`;
const payoutKeyOf = (bossId, characterId) => `wb:${bossId}:pay:${characterId}`;

const SEC_CLASS_CHOICES = Object.freeze(["highsec", "lowsec", "nullsec"]);

function splitCsv(value) {
  if (typeof value !== "string") return null;
  return value.split(",").map((p) => p.trim()).filter((p) => p !== "");
}

function parseSecClasses(value) {
  const parts = splitCsv(value);
  if (!parts || parts.length === 0 || parts.some((p) => !SEC_CLASS_CHOICES.includes(p))
    || new Set(parts).size !== parts.length) {
    return null;
  }
  return Object.freeze(parts);
}

function parseRegionIds(value) {
  const parts = splitCsv(value);
  if (!parts) return null;
  if (parts.some((p) => !/^\d+$/.test(p) || !(Number(p) > 0) || !Number.isSafeInteger(Number(p)))) return null;
  const ids = parts.map(Number);
  return new Set(ids).size === ids.length ? Object.freeze(ids) : null;
}

function parseKinds(value) {
  const parts = splitCsv(value);
  return parts ? Object.freeze([...new Set(parts)]) : Object.freeze([]);
}

function settingsOf(config, opts) {
  const W = config && config.worldBosses;
  if (!W || typeof W !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "worldBosses" };
  const o = opts || {};
  const secClasses = parseSecClasses(W.secClasses);
  if (!secClasses) return { ok: false, reason: "INVALID_SETTINGS", detail: "secClasses" };
  const own = parseRegionIds(W.excludedRegionIdsCsv === undefined ? "" : W.excludedRegionIdsCsv);
  if (!own) return { ok: false, reason: "INVALID_SETTINGS", detail: "excludedRegionIdsCsv" };
  const fallback = Array.isArray(o.defaultExcludedRegionIds) ? o.defaultExcludedRegionIds : [];
  const roll = W.roll || {};
  const spawn = W.spawn || {};
  const route = W.route || {};
  const routeMax = Number.isSafeInteger(o.routeMaxJumps) && o.routeMaxJumps > 0 ? o.routeMaxJumps : spawn.maxJumps;
  const spawnMaxJumps = Math.min(spawn.maxJumps, routeMax);
  if (!(spawn.minJumps <= spawnMaxJumps)) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "spawn.minJumps>spawn.maxJumps" };
  }
  const clash = W.clash || {};
  const battleMax = Number.isSafeInteger(o.battleMaxFleetsPerSide) && o.battleMaxFleetsPerSide > 0
    ? o.battleMaxFleetsPerSide : clash.maxFleetsPerSide;
  const live = W.live || {};
  const notices = W.notices || {};
  const rewards = W.rewards || {};
  const gm = W.gm || {};
  const liveCap = config.limits ? config.limits.maxLiveMaterializationsPerSystem : undefined;
  return { ok: true, settings: Object.freeze({
    enabled: W.enabled === true,
    kinds: parseKinds(W.kindsCsv),
    secClasses,
    excludedRegionIds: Object.freeze(own.length > 0 ? [...own] : [...fallback]),
    maxActive: W.maxActive,
    passIntervalMs: W.passIntervalMs,
    rollEnabled: roll.enabled === true,
    rollIntervalMs: roll.intervalMs,
    rollChancePermille: roll.chancePermille,
    cooldownMs: W.cooldownMs,
    spawnMinJumps: spawn.minJumps,
    spawnMaxJumps,
    spawnMaxBfsSystems: spawn.maxBfsSystems,
    dwellMs: W.dwellMs,
    hopMs: W.hopMs,
    maxHops: W.maxHops,
    maxLifetimeMs: W.maxLifetimeMs,
    avoidRevisitHops: W.avoidRevisitHops,
    goalBiasPermille: route.goalBiasPermille,
    regenPermillePerHour: W.regenPermillePerHour,
    blightPoints: W.blightPoints,
    beaconTemplateId: W.beaconTemplateId,
    retentionMs: W.retentionMs,
    pruneEveryMs: W.pruneEveryMs,
    prunePerRun: W.prunePerRun,
    clash: Object.freeze({
      enabled: clash.enabled === true,
      firstDelayMs: clash.firstDelayMs,
      intervalMs: clash.intervalMs,
      maxOpen: clash.maxOpen,
      maxFleetsPerSide: Math.min(clash.maxFleetsPerSide, battleMax),
      maxFleetsRead: clash.maxFleetsRead,
      roles: Object.freeze(splitCsv(clash.roles) || []),
      attackerRetreatLossPermille: clash.attackerRetreatLossPermille,
      moveWaitMaxMs: clash.moveWaitMaxMs,
    }),
    live: Object.freeze({
      enabled: live.enabled === true,
      pumpIntervalMs: live.pumpIntervalMs,
      maxShipsPerPhase: Number.isSafeInteger(liveCap) && liveCap > 0
        ? Math.min(live.maxShipsPerPhase, liveCap) : live.maxShipsPerPhase,
      gridRadiusM: live.gridRadiusM,
      spawnDistanceM: live.spawnDistanceM,
      aggroRangeM: live.aggroRangeM,
      leashRangeM: live.leashRangeM,
      abandonGraceMs: live.abandonGraceMs,
      maxMs: live.maxMs,
      moveHoldMs: live.moveHoldMs,
      maxParticipants: live.maxParticipants,
      spawnRetries: live.spawnRetries,
      spawnRetryCooldownMs: live.spawnRetryCooldownMs,
    }),
    notices: Object.freeze({
      enabled: notices.enabled === true,
      radiusJumps: notices.radiusJumps,
      maxRecipients: notices.maxRecipients,
    }),
    rewards: Object.freeze({
      enabled: rewards.enabled === true,
      iskPool: rewards.iskPool,
      iskMaxPerCharacter: rewards.iskMaxPerCharacter,
      maxAttempts: rewards.maxAttempts,
      maxAgeMs: rewards.maxAgeMs,
      aftermathMs: rewards.aftermathMs,
      chestOffsetM: rewards.chestOffsetM,
      lootRolls: rewards.lootRolls,
      fallbackLootTableId: rewards.fallbackLootTableId,
      payoutBatch: rewards.payoutBatch,
      payoutRetryBaseMs: rewards.payoutRetryBaseMs,
      payoutRetryMaxMs: rewards.payoutRetryMaxMs,
      payoutMaxAttempts: rewards.payoutMaxAttempts,
      payoutRetentionMs: rewards.payoutRetentionMs,
    }),
    newsEnabled: W.newsEnabled === true,
    gm: Object.freeze({ enabled: gm.enabled === true, rangeJumps: gm.rangeJumps, pollMs: gm.pollMs }),
    endReplayMs: W.endReplayMs,
  }) };
}

function upWorldBosses(db) {
  db.exec(`CREATE TABLE world_bosses (
    boss_id           TEXT    PRIMARY KEY NOT NULL CHECK (length(boss_id) BETWEEN 1 AND 40),
    boss_no           INTEGER NOT NULL UNIQUE CHECK (boss_no > 0),
    kind              TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 32),
    faction_id        INTEGER NOT NULL CHECK (faction_id > 0),
    origin_kind       TEXT    NOT NULL CHECK (origin_kind IN ('roll', 'season', 'admin')),
    origin_ref        TEXT    CHECK (origin_ref IS NULL OR length(origin_ref) BETWEEN 1 AND 64),
    state             TEXT    NOT NULL CHECK (state IN ('DWELL', 'MOVING', 'DEFEATED', 'EXPIRED', 'CANCELLED')),
    mode              TEXT    NOT NULL DEFAULT 'VIRTUAL' CHECK (mode IN ('VIRTUAL', 'LIVE')),
    phase             INTEGER NOT NULL CHECK (phase >= 1),
    units_json        TEXT    NOT NULL CHECK (length(units_json) >= 2),
    hp_at             INTEGER NOT NULL CHECK (hp_at >= 0),
    system_id         INTEGER NOT NULL CHECK (system_id > 0),
    next_system_id    INTEGER CHECK (next_system_id IS NULL OR next_system_id > 0),
    region_id         INTEGER NOT NULL CHECK (region_id >= 0),
    visit_no          INTEGER NOT NULL CHECK (visit_no >= 0),
    hops              INTEGER NOT NULL CHECK (hops >= 0),
    step_seq          INTEGER NOT NULL CHECK (step_seq >= 0),
    visited_json      TEXT    NOT NULL CHECK (length(visited_json) >= 2),
    goal_system_id    INTEGER NOT NULL CHECK (goal_system_id > 0),
    seed              INTEGER NOT NULL CHECK (seed >= 0),
    dwell_since       INTEGER NOT NULL CHECK (dwell_since >= 0),
    next_due_at       INTEGER NOT NULL CHECK (next_due_at >= 0),
    next_clash_at     INTEGER CHECK (next_clash_at IS NULL OR next_clash_at >= 0),
    clash_round       INTEGER NOT NULL DEFAULT 0 CHECK (clash_round >= 0),
    open_clashes_json TEXT    NOT NULL DEFAULT '[]',
    damage_by_json    TEXT    NOT NULL DEFAULT '{}',
    site_event_id     TEXT    CHECK (site_event_id IS NULL OR length(site_event_id) BETWEEN 1 AND 64),
    live_since        INTEGER CHECK (live_since IS NULL OR live_since >= 0),
    live_boot_at      INTEGER CHECK (live_boot_at IS NULL OR live_boot_at >= 0),
    reward_state      TEXT    NOT NULL DEFAULT 'NONE' CHECK (reward_state IN ('NONE', 'PENDING', 'PLACED',
                        'SKIPPED')),
    reward_attempts   INTEGER NOT NULL DEFAULT 0 CHECK (reward_attempts >= 0),
    top_faction_id    INTEGER CHECK (top_faction_id IS NULL OR top_faction_id > 0),
    created_at        INTEGER NOT NULL CHECK (created_at >= 0),
    expires_at        INTEGER NOT NULL CHECK (expires_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason        TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX idx_world_bosses_open ON world_bosses (state, next_due_at) WHERE state IN ('DWELL', 'MOVING');
  CREATE UNIQUE INDEX idx_world_bosses_origin ON world_bosses (origin_kind, origin_ref) WHERE origin_ref IS NOT NULL;
  CREATE INDEX idx_world_bosses_ended ON world_bosses (ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE world_boss_participants (
    boss_id      TEXT    NOT NULL CHECK (length(boss_id) BETWEEN 1 AND 40),
    character_id INTEGER NOT NULL CHECK (character_id > 0),
    phases_mask  INTEGER NOT NULL CHECK (phases_mask >= 0),
    first_at     INTEGER NOT NULL CHECK (first_at >= 0),
    last_at      INTEGER NOT NULL CHECK (last_at >= 0),
    PRIMARY KEY (boss_id, character_id)
  ) STRICT;
  CREATE TABLE world_boss_payouts (
    payout_key      TEXT    PRIMARY KEY NOT NULL CHECK (length(payout_key) BETWEEN 1 AND 80),
    boss_id         TEXT    NOT NULL CHECK (length(boss_id) BETWEEN 1 AND 40),
    character_id    INTEGER NOT NULL CHECK (character_id > 0),
    system_id       INTEGER NOT NULL CHECK (system_id > 0),
    amount_isk      INTEGER NOT NULL CHECK (amount_isk >= 0),
    state           TEXT    NOT NULL CHECK (state IN ('PENDING', 'PAID', 'FAILED')),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
    last_reason     TEXT,
    created_at      INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at      INTEGER NOT NULL CHECK (updated_at >= 0),
    settled_at      INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
    version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX idx_world_boss_payouts_due ON world_boss_payouts (state, next_attempt_at);
  CREATE INDEX idx_world_boss_payouts_character ON world_boss_payouts (character_id, created_at);`);
}

module.exports = { TABLE, PARTICIPANTS_TABLE, PAYOUTS_TABLE, STATES, OPEN_STATES, END_STATES, MODES, ORIGIN_KINDS,
  REWARD_STATES, END_REASONS, JOURNAL_AGGREGATE, ROLL_AGGREGATE_ID, EVENT, RNG, MAX_BOSS_ID_LENGTH,
  MAX_ORIGIN_REF_LENGTH, MAX_KIND_LENGTH, MAX_SITE_EVENT_ID_LENGTH, BEACON_SLOT, WORLD_BOSS_BATTLE_ROWS_BOUND,
  VIEW_ID, LAYER_ID, SEC_CLASS_CHOICES, SENTRY_PREFIX, bossIdOf, sentryIdOf, parseSentryId, keyRoll, keySpawn, keyStep, keyBlight, keyEnd, keyRound,
  keySweep, keyDamage, beaconEventIdOf, keyLiveStart, keyLiveLoss, keyLivePhase, keyLiveExit, keyRecover, keyLiveHold,
  keyEta, NOTICE_KIND, parseSecClasses, REWARD_REASONS, PAYOUT_STATES, ISK_SOURCE, PAYOUT_DESCRIPTION, GM_STEP_TYPE,
  GM_OWNER, HINT_KEY, NEWS, keyReward, keyRelease, payoutKeyOf,
  parseRegionIds, parseKinds, settingsOf, upWorldBosses };
