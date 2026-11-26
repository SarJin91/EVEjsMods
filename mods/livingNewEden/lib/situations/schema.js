"use strict";

const TABLE = "world_situations";
const PAYOUTS_TABLE = "world_situation_payouts";

const STATES = Object.freeze({ OPEN: "OPEN", RESCUED: "RESCUED", LOST: "LOST", UNANSWERED: "UNANSWERED",
  ABANDONED: "ABANDONED", CANCELLED: "CANCELLED" });
const OUTCOMES = Object.freeze([STATES.RESCUED, STATES.LOST, STATES.UNANSWERED, STATES.ABANDONED,
  STATES.CANCELLED]);
const PHASES = Object.freeze({ CALLING: "CALLING", FIGHT: "FIGHT" });

const KINDS = Object.freeze({ BELT_RAID: "BELT_RAID", GATE_AMBUSH: "GATE_AMBUSH", STRANDED_POD: "STRANDED_POD" });
const ANCHOR_KINDS = Object.freeze({ BELT: "belt", GATE: "gate", POINT: "point" });
const ROLES = Object.freeze({ VICTIM: "victim", PIRATE: "pirate" });

const END_REASONS = Object.freeze({ RESTART: "RESTART", SPAWN_FAILED: "SPAWN_FAILED", STOPPED: "STOPPED",
  TIMEOUT: "TIMEOUT", SCENE_GONE: "SCENE_GONE", VICTIMS_GONE: "VICTIMS_GONE", PIRATES_DOWN: "PIRATES_DOWN",
  NO_PLAYER_KILL: "NO_PLAYER_KILL", FIGHT_TIMEOUT: "FIGHT_TIMEOUT", NO_PLAYER: "NO_PLAYER",
  PICKED_UP: "PICKED_UP" });

const AGGREGATE = "situation";
const EVENT_STARTED = "SITUATION_STARTED";
const EVENT_RESOLVED = "SITUATION_RESOLVED";
const RNG_STREAM = "situation";
const RNG_KIND_STREAM = "situation.kind";

const MAX_SITUATION_ID_LENGTH = 40;
const MAX_PAYOUT_KEY_LENGTH = 80;
const MAX_END_REASON_LENGTH = 32;
const DAY_MS = 86400000;

const PAYOUT_ROW_STATES = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });
const LEG_STATES = Object.freeze({ PENDING: "PENDING", DONE: "DONE", FAILED: "FAILED", SKIPPED: "SKIPPED" });
const PAYOUT_DESCRIPTION = "LNE rescue";
const ISK_SOURCE = "lne-situations";
const STANDING_REASON = "SITUATION_RESCUE";
const STANDING_DATA = Object.freeze({
  eventTypeId: 486,
  msgByReason: Object.freeze({ [STANDING_REASON]: "Rescue of miners (Living New Eden)" }),
});
const STANDING_MICRO = 1e6;

const REFUSALS = Object.freeze(["NO_SPEAKER", "NO_ANCHOR", "NO_PIRATE_FACTION", "NO_PROFILE", "BUDGET", "GOVERNOR"]);

const COUNTER_NAMES = Object.freeze(["passes", "rolls", "started", "startFailed", "duplicates", "recovered",
  ...REFUSALS.map((r) => `refused.${r}`),
  "distressLines", "distressRefused", "engaged", "retaliations", "rescued", "lost", "unanswered", "abandoned",
  "cancelled", "settleFailed", "pirateKills", "victimKilledByPlayer", "payoutsPlanned", "payoutsPaid", "payoutsFailed",
  "payoutRetries", "payoutDuplicates", "payoutMarkFailed", "rewardCapped", "spawnFailed", "orphans", "despawnFailed",
  "readFailed", "pruned", "payoutsPruned",
  "rumoursSent", "rumoursRefused", "despawnRetried",
  "kindDraws", "startedGateAmbush", "startedStrandedPod", "podHoldResets", "podKindOff",
  "sceneRefused", "piratesDeferred"]);

const LAYER_ID = "layer-situations";
const VIEW_ID = "situations";

const METRICS = Object.freeze({ liveShips: "situations.liveShips", active: "situations.active",
  passMs: "situations.passMs" });

function situationIdOf(bootAt, seq) {
  return `s${Math.trunc(bootAt).toString(36)}-${seq}`;
}

function startKeyOf(systemId, bucket) {
  return `sit:start:${systemId}:${bucket}`;
}

function settleKeyOf(situationId) {
  return `sit:${situationId}:settle`;
}

function payoutKeyOf(situationId, characterId) {
  return `sit:${situationId}:${characterId}`;
}

const BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const HULL_GROUPS = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser"]);
const MAX_PIRATES = 8;

function splitList(value, sep) {
  if (typeof value !== "string") return null;
  const parts = value.split(sep).map((p) => p.trim()).filter((p) => p !== "");
  return parts.length > 0 ? parts : null;
}

function parseBands(value) {
  const parts = splitList(value, ",");
  if (!parts || parts.some((p) => !BANDS.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function parsePiratesBySec(value) {
  const parts = splitList(value, ";");
  if (!parts) return null;
  const out = {};
  for (const part of parts) {
    const m = /^([a-z]+):(\d+)-(\d+):([a-z|]+)$/.exec(part.replace(/\s+/g, ""));
    if (!m || !BANDS.includes(m[1]) || Object.prototype.hasOwnProperty.call(out, m[1])) return null;
    const min = Number(m[2]);
    const max = Number(m[3]);
    if (!(min >= 1 && min <= max && max <= MAX_PIRATES)) return null;
    const hulls = m[4].split("|").filter((h) => h !== "");
    if (hulls.length === 0 || hulls.some((h) => !HULL_GROUPS.includes(h)) || new Set(hulls).size !== hulls.length) {
      return null;
    }
    out[m[1]] = Object.freeze({ min, max, hulls: Object.freeze(hulls) });
  }
  return Object.freeze(out);
}

function situationsSettingsOf(config) {
  const S = config && config.situations;
  if (!S || typeof S !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "situations" };
  const bands = parseBands(S.bands);
  if (!bands) return { ok: false, reason: "INVALID_SETTINGS", detail: "bands" };
  const pirates = parsePiratesBySec(S.piratesBySec);
  if (!pirates) return { ok: false, reason: "INVALID_SETTINGS", detail: "piratesBySec" };
  if (S.victimsMin > S.victimsMax) return { ok: false, reason: "INVALID_SETTINGS", detail: "victimsMin>victimsMax" };
  if (S.victimsMax + 1 > S.maxShipsPerSituation) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "victimsMax+1>maxShipsPerSituation" };
  }
  return { ok: true, settings: Object.freeze({ ...S, bands, piratesBySec: pirates }) };
}

function upSituations(db) {
  db.exec(`CREATE TABLE world_situations (
    situation_id      TEXT    PRIMARY KEY NOT NULL CHECK (length(situation_id) BETWEEN 1 AND 40),
    kind              TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
    system_id         INTEGER NOT NULL CHECK (system_id > 0),
    bucket            INTEGER NOT NULL CHECK (bucket >= 0),
    state             TEXT    NOT NULL CHECK (state IN ('OPEN', 'RESCUED', 'LOST', 'UNANSWERED', 'ABANDONED',
                        'CANCELLED')),
    anchor_kind       TEXT    NOT NULL CHECK (length(anchor_kind) BETWEEN 1 AND 8),
    anchor_id         INTEGER NOT NULL CHECK (anchor_id >= 0),
    speaker_id        INTEGER CHECK (speaker_id IS NULL OR speaker_id > 0),
    pirate_faction_id INTEGER CHECK (pirate_faction_id IS NULL OR pirate_faction_id > 0),
    victims           INTEGER NOT NULL CHECK (victims >= 0),
    victims_saved     INTEGER CHECK (victims_saved IS NULL OR victims_saved >= 0),
    helpers_json      TEXT    NOT NULL DEFAULT '[]' CHECK (length(helpers_json) BETWEEN 2 AND 400),
    boot_at           INTEGER NOT NULL CHECK (boot_at >= 0),
    started_at        INTEGER NOT NULL CHECK (started_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason        TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (system_id, bucket)
  ) STRICT;
  CREATE INDEX idx_situations_open ON world_situations (state) WHERE state = 'OPEN';
  CREATE INDEX idx_situations_ended ON world_situations (ended_at) WHERE state <> 'OPEN';
  CREATE TABLE world_situation_payouts (
    payout_key          TEXT    PRIMARY KEY NOT NULL CHECK (length(payout_key) BETWEEN 1 AND 80),
    situation_id        TEXT    NOT NULL CHECK (length(situation_id) BETWEEN 1 AND 40),
    character_id        INTEGER NOT NULL CHECK (character_id > 0),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    amount_isk          INTEGER NOT NULL CHECK (amount_isk >= 0),
    standing_faction_id INTEGER CHECK (standing_faction_id IS NULL OR standing_faction_id > 0),
    standing_micro      INTEGER NOT NULL DEFAULT 0 CHECK (standing_micro >= 0),
    isk_state           TEXT    NOT NULL CHECK (isk_state IN ('PENDING', 'DONE', 'FAILED', 'SKIPPED')),
    std_state           TEXT    NOT NULL CHECK (std_state IN ('PENDING', 'DONE', 'FAILED', 'SKIPPED')),
    state               TEXT    NOT NULL CHECK (state IN ('PENDING', 'PAID', 'FAILED')),
    attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at     INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
    last_reason         TEXT,
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    settled_at          INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX idx_situation_payouts_due ON world_situation_payouts (state, next_attempt_at);
  CREATE INDEX idx_situation_payouts_character ON world_situation_payouts (character_id, created_at);`);
}

module.exports = { TABLE, PAYOUTS_TABLE, STATES, OUTCOMES, PHASES, KINDS, ANCHOR_KINDS, ROLES, END_REASONS,
  AGGREGATE, EVENT_STARTED, EVENT_RESOLVED, RNG_STREAM, RNG_KIND_STREAM, MAX_SITUATION_ID_LENGTH, MAX_PAYOUT_KEY_LENGTH,
  MAX_END_REASON_LENGTH, DAY_MS, PAYOUT_ROW_STATES, LEG_STATES, PAYOUT_DESCRIPTION, ISK_SOURCE, STANDING_REASON,
  STANDING_DATA, STANDING_MICRO, REFUSALS, COUNTER_NAMES, LAYER_ID, VIEW_ID, METRICS, BANDS, HULL_GROUPS, situationIdOf, startKeyOf,
  settleKeyOf, payoutKeyOf, parseBands, parsePiratesBySec, situationsSettingsOf, upSituations };
