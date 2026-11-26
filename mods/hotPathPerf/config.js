"use strict";

const fs = require("fs");
const path = require("path");
const { IGNORE_ENV: OVERRIDE_IGNORE_ENV, overridePathOf, readOverrideFile } = require("./lib/settingsOverride");
const { parseGateTypes } = require("./lib/schedulerDueGate");

const DATA_ID = "hotPathPerf";

const DEFAULTS = Object.freeze({
  enabled: true,
  slowCallMs: 250,
  statsLogMinutes: 10,
  measureSchedulerBoundary: true,
  measureCacheMgrHandlers: true,
  measureLifecycleLists: true,
  measureCollectEmptySolarSystems: true,
  measurePrepareUniverseSites: true,
  measureEnsureScene: true,
  measureGetMultiLocations: true,
  dungeonIndex: false,
  dungeonIndexParityCheck: false,
  dungeonIndexMaxEntries: 100000,
  sceneRetention: false,
  sceneRetentionPinDocked: true,
  sceneRetentionPinDockedMaxMinutes: 120,
  sceneRetentionPinRecent: false,
  sceneRetentionRecentMinutes: 10,
  sceneRetentionMaxPinnedPerCharacter: 4,
  sceneRetentionMaxPinnedTotal: 16,
  sceneRetentionRssCeilingMb: 0,
  prewarmLocations: true,
  careerAbyssalRead: false,
  careerAbyssalReadParityCheck: false,
  careerAbyssalReadReclassifyPerCall: 64,
  careerAbyssalReadMaxKeys: 200000,
  careerAbyssalReadBusyTimeoutMs: 5000,
  careerCombatItemsRead: false,
  careerCombatItemsReadParityCheck: false,
  careerCombatItemsReadBusyTimeoutMs: 5000,
  templateReadOnlyView: false,
  templateReadOnlyViewParityCheck: false,
  templateReadOnlyRotate: false,
  templateReadOnlyCallers: false,
  dungeonInstanceRef: false,
  dungeonInstanceRefParityCheck: false,
  rockRemainderCoalesce: false,
  rockRemainderCoalesceMs: 10000,
  rockRemainderCoalesceMaxInstances: 256,
  structuresSystemFilter: false,
  structuresSystemFilterParityCheck: false,
  structuresRefreshCoalesce: false,
  structuresRefreshFreshMs: 5000,
  dronePersistCoalesce: false,
  dronePersistCoalesceMs: 5000,
  dronePersistCoalesceMaxItems: 256,
  tickStructuresThrottle: false,
  tickStructuresMinIntervalMs: 5000,
  blueprintOwnerRead: false,
  blueprintOwnerReadParityCheck: false,
  nativeWreckList: false,
  nativeWreckListParityCheck: false,
  configSnapshotMemo: false,
  configSnapshotMemoRevalidateMs: 1000,
  configSnapshotMemoParityCheck: false,
  schedulerMaxPending: 4096,
  schedulerRequestTimeoutMs: 120000,
  schedulerDueGate: true,
  schedulerDueGateTypes: "ess.settlement,sovereignty.campaign-tick",
  schedulerDueGateReleaseDelayMs: 30000,
  schedulerDueGateMaxHoldMs: 300000,
  schedulerDueGatePumpIntervalMs: 100,
  schedulerDueGateBatch: 8,
  schedulerDueGateMaxInFlight: 2,
  schedulerDueGateMinLeaseLeftMs: 10000,
  schedulerDueGateStaleDropMs: 120000,
  schedulerDueGateMaxHeld: 100000,
  schedulerDueGateUnseenReleaseMs: 10000,
  stallWatch: true,
  stallWatchThresholdMs: 5000,
  stallWatchSampleEveryMs: 20000,
  stallWatchMaxSamples: 40,
  stallWatchFrames: 12,
  stallWatchWindowMs: 1800000,
  stallWatchHeartbeatMs: 250,
  schedulerOwnersSlowCallMs: 10000,
  sovCaptureOwnedEchoSkip: true,
  cynoBroadcastSessionFilter: true,
  incursionTalesMemo: false,
  incursionTalesMemoParityCheck: false,
  bountyPoolRead: false,
  bountyPoolReadParityCheck: false,
  careerStandingCorpMemo: false,
  careerStandingCorpMemoParityCheck: false,
  reprocessingReceiptRetireDefer: false,
  reprocessingReceiptRetireDelayMs: 30000,
  reprocessingReceiptRetireMaxPendingKeys: 20000,
});

const CAREER_REPROCESSING_RANGES = Object.freeze({
  reprocessingReceiptRetireDelayMs: Object.freeze([1000, 600000]),
  reprocessingReceiptRetireMaxPendingKeys: Object.freeze([100, 200000]),
});

const STALL_WATCH_RANGES = Object.freeze({
  stallWatchThresholdMs: Object.freeze([500, 600000]),
  stallWatchSampleEveryMs: Object.freeze([1000, 600000]),
  stallWatchMaxSamples: Object.freeze([0, 1000]),
  stallWatchFrames: Object.freeze([1, 50]),
  stallWatchWindowMs: Object.freeze([60000, 86400000]),
  stallWatchHeartbeatMs: Object.freeze([50, 5000]),
  schedulerOwnersSlowCallMs: Object.freeze([0, 600000]),
});

const SCHEDULER_DUE_GATE_RANGES = Object.freeze({
  schedulerDueGateReleaseDelayMs: Object.freeze([0, 600000]),
  schedulerDueGateMaxHoldMs: Object.freeze([10000, 1800000]),
  schedulerDueGatePumpIntervalMs: Object.freeze([10, 5000]),
  schedulerDueGateBatch: Object.freeze([1, 256]),
  schedulerDueGateMaxInFlight: Object.freeze([1, 64]),
  schedulerDueGateMinLeaseLeftMs: Object.freeze([0, 29000]),
  schedulerDueGateStaleDropMs: Object.freeze([1000, 600000]),
  schedulerDueGateMaxHeld: Object.freeze([1000, 1000000]),
  schedulerDueGateUnseenReleaseMs: Object.freeze([1000, 600000]),
});

const TICK_STRUCTURES_MAX_INTERVAL_MS = 10000;
const SCHEDULER_MAX_PENDING_CAP = 65536;
const SCHEDULER_REQUEST_TIMEOUT_CAP_MS = 600000;
const CONFIG_SNAPSHOT_MEMO_REVALIDATE_CAP_MS = 60000;

const ENV = Object.freeze({
  enabled: "HOTPATH_ENABLED",
  slowCallMs: "HOTPATH_SLOW_CALL_MS",
  statsLogMinutes: "HOTPATH_STATS_MINUTES",
  measureSchedulerBoundary: "HOTPATH_MEASURE_BOUNDARY",
  measureCacheMgrHandlers: "HOTPATH_MEASURE_CACHE_MGR",
  measureLifecycleLists: "HOTPATH_MEASURE_LIFECYCLE_LISTS",
  measureCollectEmptySolarSystems: "HOTPATH_MEASURE_COLLECT_EMPTY",
  measurePrepareUniverseSites: "HOTPATH_MEASURE_PREPARE_SITES",
  measureEnsureScene: "HOTPATH_MEASURE_ENSURE_SCENE",
  measureGetMultiLocations: "HOTPATH_MEASURE_MULTI_LOCATIONS",
  dungeonIndex: "HOTPATH_DUNGEON_INDEX",
  dungeonIndexParityCheck: "HOTPATH_DUNGEON_INDEX_PARITY",
  dungeonIndexMaxEntries: "HOTPATH_DUNGEON_INDEX_MAX_ENTRIES",
  sceneRetention: "HOTPATH_SCENE_RETENTION",
  sceneRetentionPinDocked: "HOTPATH_SCENE_RETENTION_PIN_DOCKED",
  sceneRetentionPinDockedMaxMinutes: "HOTPATH_SCENE_RETENTION_DOCKED_MAX_MINUTES",
  sceneRetentionPinRecent: "HOTPATH_SCENE_RETENTION_PIN_RECENT",
  sceneRetentionRecentMinutes: "HOTPATH_SCENE_RETENTION_RECENT_MINUTES",
  sceneRetentionMaxPinnedPerCharacter: "HOTPATH_SCENE_RETENTION_MAX_PER_CHARACTER",
  sceneRetentionMaxPinnedTotal: "HOTPATH_SCENE_RETENTION_MAX_TOTAL",
  sceneRetentionRssCeilingMb: "HOTPATH_SCENE_RETENTION_RSS_CEILING_MB",
  prewarmLocations: "HOTPATH_PREWARM_LOCATIONS",
  careerAbyssalRead: "HOTPATH_CAREER_ABYSSAL_READ",
  careerAbyssalReadParityCheck: "HOTPATH_CAREER_ABYSSAL_READ_PARITY",
  careerAbyssalReadReclassifyPerCall: "HOTPATH_CAREER_ABYSSAL_READ_RECLASSIFY",
  careerAbyssalReadMaxKeys: "HOTPATH_CAREER_ABYSSAL_READ_MAX_KEYS",
  careerAbyssalReadBusyTimeoutMs: "HOTPATH_CAREER_ABYSSAL_READ_BUSY_MS",
  careerCombatItemsRead: "HOTPATH_CAREER_COMBAT_ITEMS_READ",
  careerCombatItemsReadParityCheck: "HOTPATH_CAREER_COMBAT_ITEMS_READ_PARITY",
  careerCombatItemsReadBusyTimeoutMs: "HOTPATH_CAREER_COMBAT_ITEMS_READ_BUSY_MS",
  templateReadOnlyView: "HOTPATH_TEMPLATE_READONLY",
  templateReadOnlyViewParityCheck: "HOTPATH_TEMPLATE_READONLY_PARITY",
  templateReadOnlyRotate: "HOTPATH_TEMPLATE_READONLY_ROTATE",
  templateReadOnlyCallers: "HOTPATH_TEMPLATE_READONLY_CALLERS",
  dungeonInstanceRef: "HOTPATH_DUNGEON_INSTANCE_REF",
  dungeonInstanceRefParityCheck: "HOTPATH_DUNGEON_INSTANCE_REF_PARITY",
  rockRemainderCoalesce: "HOTPATH_ROCK_REMAINDER_COALESCE",
  rockRemainderCoalesceMs: "HOTPATH_ROCK_REMAINDER_COALESCE_MS",
  rockRemainderCoalesceMaxInstances: "HOTPATH_ROCK_REMAINDER_COALESCE_MAX_INSTANCES",
  structuresSystemFilter: "HOTPATH_STRUCTURES_SYSTEM_FILTER",
  structuresSystemFilterParityCheck: "HOTPATH_STRUCTURES_SYSTEM_FILTER_PARITY",
  structuresRefreshCoalesce: "HOTPATH_STRUCTURES_REFRESH_COALESCE",
  structuresRefreshFreshMs: "HOTPATH_STRUCTURES_REFRESH_FRESH_MS",
  dronePersistCoalesce: "HOTPATH_DRONE_PERSIST_COALESCE",
  dronePersistCoalesceMs: "HOTPATH_DRONE_PERSIST_COALESCE_MS",
  dronePersistCoalesceMaxItems: "HOTPATH_DRONE_PERSIST_COALESCE_MAX_ITEMS",
  tickStructuresThrottle: "HOTPATH_TICK_STRUCTURES_THROTTLE",
  tickStructuresMinIntervalMs: "HOTPATH_TICK_STRUCTURES_MIN_INTERVAL_MS",
  blueprintOwnerRead: "HOTPATH_BLUEPRINT_OWNER_READ",
  blueprintOwnerReadParityCheck: "HOTPATH_BLUEPRINT_OWNER_READ_PARITY",
  nativeWreckList: "HOTPATH_NATIVE_WRECK_LIST",
  nativeWreckListParityCheck: "HOTPATH_NATIVE_WRECK_LIST_PARITY",
  configSnapshotMemo: "HOTPATH_CONFIG_SNAPSHOT_MEMO",
  configSnapshotMemoRevalidateMs: "HOTPATH_CONFIG_SNAPSHOT_MEMO_REVALIDATE_MS",
  configSnapshotMemoParityCheck: "HOTPATH_CONFIG_SNAPSHOT_MEMO_PARITY",
  schedulerMaxPending: "HOTPATH_SCHEDULER_MAX_PENDING",
  schedulerRequestTimeoutMs: "HOTPATH_SCHEDULER_REQUEST_TIMEOUT_MS",
  schedulerDueGate: "HOTPATH_SCHEDULER_DUE_GATE",
  schedulerDueGateTypes: "HOTPATH_SCHEDULER_DUE_GATE_TYPES",
  schedulerDueGateReleaseDelayMs: "HOTPATH_SCHEDULER_DUE_GATE_RELEASE_DELAY_MS",
  schedulerDueGateMaxHoldMs: "HOTPATH_SCHEDULER_DUE_GATE_MAX_HOLD_MS",
  schedulerDueGatePumpIntervalMs: "HOTPATH_SCHEDULER_DUE_GATE_PUMP_INTERVAL_MS",
  schedulerDueGateBatch: "HOTPATH_SCHEDULER_DUE_GATE_BATCH",
  schedulerDueGateMaxInFlight: "HOTPATH_SCHEDULER_DUE_GATE_MAX_IN_FLIGHT",
  schedulerDueGateMinLeaseLeftMs: "HOTPATH_SCHEDULER_DUE_GATE_MIN_LEASE_LEFT_MS",
  schedulerDueGateStaleDropMs: "HOTPATH_SCHEDULER_DUE_GATE_STALE_DROP_MS",
  schedulerDueGateMaxHeld: "HOTPATH_SCHEDULER_DUE_GATE_MAX_HELD",
  schedulerDueGateUnseenReleaseMs: "HOTPATH_SCHEDULER_DUE_GATE_UNSEEN_RELEASE_MS",
  stallWatch: "HOTPATH_STALL_WATCH",
  stallWatchThresholdMs: "HOTPATH_STALL_WATCH_THRESHOLD_MS",
  stallWatchSampleEveryMs: "HOTPATH_STALL_WATCH_SAMPLE_EVERY_MS",
  stallWatchMaxSamples: "HOTPATH_STALL_WATCH_MAX_SAMPLES",
  stallWatchFrames: "HOTPATH_STALL_WATCH_FRAMES",
  stallWatchWindowMs: "HOTPATH_STALL_WATCH_WINDOW_MS",
  stallWatchHeartbeatMs: "HOTPATH_STALL_WATCH_HEARTBEAT_MS",
  schedulerOwnersSlowCallMs: "HOTPATH_SCHEDULER_OWNERS_SLOW_CALL_MS",
  sovCaptureOwnedEchoSkip: "HOTPATH_SOV_CAPTURE_OWNED_ECHO_SKIP",
  cynoBroadcastSessionFilter: "HOTPATH_CYNO_BROADCAST_SESSION_FILTER",
  incursionTalesMemo: "HOTPATH_INCURSION_TALES_MEMO",
  incursionTalesMemoParityCheck: "HOTPATH_INCURSION_TALES_MEMO_PARITY_CHECK",
  bountyPoolRead: "HOTPATH_BOUNTY_POOL_READ",
  bountyPoolReadParityCheck: "HOTPATH_BOUNTY_POOL_READ_PARITY",
  careerStandingCorpMemo: "HOTPATH_CAREER_STANDING_CORP_MEMO",
  careerStandingCorpMemoParityCheck: "HOTPATH_CAREER_STANDING_CORP_MEMO_PARITY",
  reprocessingReceiptRetireDefer: "HOTPATH_REPROCESSING_RECEIPT_RETIRE_DEFER",
  reprocessingReceiptRetireDelayMs: "HOTPATH_REPROCESSING_RECEIPT_RETIRE_DELAY_MS",
  reprocessingReceiptRetireMaxPendingKeys: "HOTPATH_REPROCESSING_RECEIPT_RETIRE_MAX_PENDING_KEYS",
});

function parseValue(key, raw) {
  const def = DEFAULTS[key];
  if (typeof def === "boolean") {
    if (typeof raw === "boolean") return raw;
    const s = String(raw).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
    return def;
  }
  if (typeof def === "number") {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }
  if (typeof def === "string") return typeof raw === "string" ? raw : def;
  return def;
}

function resolveDataDir(env, modDir) {
  const configured = String((env && env.EVEJS_DATA_ROOT) || "").trim();
  const root = configured ? path.resolve(configured) : path.join(path.resolve(modDir, "..", ".."), "_local");
  return path.join(root, "mods", DATA_ID);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameKind(value, def) {
  if (typeof def === "boolean") return typeof value === "boolean";
  if (typeof def === "number") return typeof value === "number" && Number.isFinite(value);
  if (typeof def === "string") return typeof value === "string";
  return false;
}

function overrideValuesOf(options, env, warn) {
  if (isPlainObject(options.overrideValues) && env[OVERRIDE_IGNORE_ENV] !== "1") return options.overrideValues;
  const read = readOverrideFile(options.overrideFilePath
    || overridePathOf(resolveDataDir(env, options.modDir || __dirname)), env);
  for (const line of read.warnings) warn(`WARN ${line}`);
  return read.values;
}

function loadConfig(options = {}) {
  const env = options.env || process.env;
  const settingsPath = options.settingsPath || path.join(__dirname, "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {};
  } catch (_error) {
    settings = {};
  }
  const over = overrideValuesOf(options, env, options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`)));
  const config = {};
  for (const key of Object.keys(DEFAULTS)) {
    let value = DEFAULTS[key];
    if (Object.prototype.hasOwnProperty.call(settings, key)) value = parseValue(key, settings[key]);
    if (env[ENV[key]] !== undefined && env[ENV[key]] !== "") value = parseValue(key, env[ENV[key]]);
    if (Object.prototype.hasOwnProperty.call(over, key) && sameKind(over[key], DEFAULTS[key])) {
      value = parseValue(key, over[key]);
    }
    config[key] = value;
  }
  config.tickStructuresMinIntervalMs = Math.floor(config.tickStructuresMinIntervalMs);
  if (config.tickStructuresMinIntervalMs > TICK_STRUCTURES_MAX_INTERVAL_MS) {
    const warn = options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`));
    warn(`WARN tickStructuresMinIntervalMs=${config.tickStructuresMinIntervalMs} capped to ${TICK_STRUCTURES_MAX_INTERVAL_MS}`);
    config.tickStructuresMinIntervalMs = TICK_STRUCTURES_MAX_INTERVAL_MS;
  }
  config.structuresRefreshFreshMs = Math.floor(config.structuresRefreshFreshMs);
  if (config.structuresRefreshFreshMs > TICK_STRUCTURES_MAX_INTERVAL_MS) {
    const warn = options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`));
    warn(`WARN structuresRefreshFreshMs=${config.structuresRefreshFreshMs} capped to ${TICK_STRUCTURES_MAX_INTERVAL_MS}`);
    config.structuresRefreshFreshMs = TICK_STRUCTURES_MAX_INTERVAL_MS;
  }
  config.schedulerMaxPending = Math.floor(config.schedulerMaxPending);
  if (config.schedulerMaxPending > SCHEDULER_MAX_PENDING_CAP) {
    const warn = options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`));
    warn(`WARN schedulerMaxPending=${config.schedulerMaxPending} capped to ${SCHEDULER_MAX_PENDING_CAP}`);
    config.schedulerMaxPending = SCHEDULER_MAX_PENDING_CAP;
  }
  config.schedulerRequestTimeoutMs = Math.floor(config.schedulerRequestTimeoutMs);
  if (config.schedulerRequestTimeoutMs > SCHEDULER_REQUEST_TIMEOUT_CAP_MS) {
    const warn = options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`));
    warn(`WARN schedulerRequestTimeoutMs=${config.schedulerRequestTimeoutMs} capped to ${SCHEDULER_REQUEST_TIMEOUT_CAP_MS}`);
    config.schedulerRequestTimeoutMs = SCHEDULER_REQUEST_TIMEOUT_CAP_MS;
  }
  config.configSnapshotMemoRevalidateMs = Math.floor(config.configSnapshotMemoRevalidateMs);
  if (config.configSnapshotMemoRevalidateMs > CONFIG_SNAPSHOT_MEMO_REVALIDATE_CAP_MS) {
    const warn = options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`));
    warn(`WARN configSnapshotMemoRevalidateMs=${config.configSnapshotMemoRevalidateMs} capped to ${CONFIG_SNAPSHOT_MEMO_REVALIDATE_CAP_MS}`);
    config.configSnapshotMemoRevalidateMs = CONFIG_SNAPSHOT_MEMO_REVALIDATE_CAP_MS;
  }
  const warnGate = options.warn || ((m) => console.warn(`[hotPathPerf] ${m}`));
  for (const [key, [min, max]] of [...Object.entries(SCHEDULER_DUE_GATE_RANGES), ...Object.entries(STALL_WATCH_RANGES)]) {
    const value = Math.floor(config[key]);
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) warnGate(`WARN ${key}=${value} clamped to ${clamped} (${min}..${max})`);
    config[key] = clamped;
  }
  for (const [key, [min, max]] of Object.entries(CAREER_REPROCESSING_RANGES)) {
    const value = Math.floor(config[key]);
    const clamped = Math.min(max, Math.max(min, value));
    if (clamped !== value) warnGate(`WARN ${key}=${value} clamped to ${clamped} (${min}..${max})`);
    config[key] = clamped;
  }
  const gateTypes = parseGateTypes(config.schedulerDueGateTypes);
  if (gateTypes.dropped.length > 0) {
    warnGate(`WARN schedulerDueGateTypes: skipped ${gateTypes.dropped.length} (≤ 16 types, ≤ 160 characters, no *)`);
  }
  config.schedulerDueGateTypes = gateTypes.types.join(",");
  return Object.freeze(config);
}

module.exports = { DEFAULTS, ENV, loadConfig, resolveDataDir, TICK_STRUCTURES_MAX_INTERVAL_MS, SCHEDULER_MAX_PENDING_CAP,
  SCHEDULER_REQUEST_TIMEOUT_CAP_MS, CONFIG_SNAPSHOT_MEMO_REVALIDATE_CAP_MS, SCHEDULER_DUE_GATE_RANGES, STALL_WATCH_RANGES };
