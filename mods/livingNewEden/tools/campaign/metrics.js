"use strict";

const { CLAIM_STATES } = require("../../lib/world/occupation/schema");
const { coreCounts } = require("./checks");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { CONVOY_OPEN_STATES, TRIBUTE_PURPOSE } = require("../../lib/economy/schema");

const REVIEW_05B = Object.freeze(["defenses", "defenseInsufficient", "reclaims", "territoryLimit", "captureNotAdjacent",
  "lostHomeTruncated", "reliefs"]);
const P95 = 0.95;
const P50 = 0.5;
const REACTIVE_COUNTERS = Object.freeze(["runs", "idle", "reacted", "skipped", "deferred", "stale", "launches",
  "defenses", "reliefs", "capped", "capScanTruncated", "intentRefused", "pruned", "sweeps", "rowCapped", "readFailed",
  "superseded", "fullReads"]);
const REVIEW_ECON = Object.freeze(["launches", "mobilized", "produced", "mineDispatched"]);
const OBSERVE_NAMES = Object.freeze(["strategy.reviewReadMs", "strategy.reactiveReadMs", "strategy.reactiveDecideMs"]);
const OBSERVE_NULLABLE = new Set(["strategy.reactiveReadMs", "strategy.reactiveDecideMs"]);
const REACTIVE_KEY_PREFIX = "strategy:react:";
const ROLL_CATEGORIES = Object.freeze(["free", "active", "other"]);
const TRIBUTE_RECIPIENTS = Object.freeze([...new Set(FACTIONS_V1.map((f) => f.tributeTo)
  .filter((r) => Number.isSafeInteger(r)))].sort((a, b) => a - b));
const TRIBUTE_PAYERS = Object.freeze(FACTIONS_V1.filter((f) => Number.isSafeInteger(f.tributeTo))
  .map((f) => [f.factionId, f.tributeTo]).sort((a, b) => a[0] - b[0]));

function pct(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const round2 = (v) => Math.round(v * 100) / 100;

function observeStat(values) {
  const list = Array.isArray(values) ? values : [];
  return { n: list.length, p50: round2(pct(list, P50)), p95: round2(pct(list, P95)),
    max: round2(list.length > 0 ? pct(list, 1) : 0) };
}

function observeDay(observe) {
  const src = observe || {};
  const out = {};
  for (const name of OBSERVE_NAMES) {
    const values = src[name];
    out[name] = OBSERVE_NULLABLE.has(name) && !(Array.isArray(values) && values.length > 0) ? null : observeStat(values);
  }
  return out;
}

function delta(counters, prev, name) {
  return (counters[name] || 0) - ((prev && prev[name]) || 0);
}

function inDay(db, sql, fromAt, at) {
  return db.prepare(sql).get(fromAt, at).n;
}

function factionRows(db, config, coreHeld) {
  const claimIn = `(${CLAIM_STATES.map((s) => `'${s}'`).join(", ")})`;
  const one = (sql, ...args) => db.prepare(sql).get(...args).n;
  const out = {};
  for (const f of db.prepare(`SELECT faction_id, resource_units, reserve_units, upkeep_unpaid_periods
    FROM world_factions WHERE status = 'ACTIVE' ORDER BY faction_id`).all()) {
    const id = f.faction_id;
    const captured = one("SELECT count(*) AS n FROM world_system_state WHERE controller_faction_id = ? "
      + "AND captured_at IS NOT NULL", id);
    const fleets = db.prepare(`SELECT count(*) AS n, coalesce(sum(ship_count), 0) AS ships FROM virtual_fleets
      WHERE faction_id = ? AND state <> 'DESTROYED'`).get(id);
    out[id] = {
      controlled: one("SELECT count(*) AS n FROM world_system_state WHERE controller_faction_id = ?", id),
      captured,
      lostHome: one(`SELECT count(*) AS n FROM world_system_state WHERE home_faction_id = ?
        AND (controller_faction_id IS NULL OR controller_faction_id <> ?)`, id, id),
      lostHomeTruncated: null,
      threats: one(`SELECT count(*) AS n FROM world_system_state WHERE controller_faction_id = ?
        AND occupation_state IN ${claimIn} AND occupier_faction_id <> ?`, id, id),
      claims: one(`SELECT count(*) AS n FROM world_system_state WHERE occupier_faction_id = ?
        AND occupation_state IN ${claimIn}`, id),
      captureRoom: Math.max(0, config.strategy.maxCapturedSystemsPerFaction - captured),
      fronts: one(`SELECT count(DISTINCT target_system_id) AS n FROM world_operations WHERE faction_id = ?
        AND state IN ('PLANNED', 'ACTIVE')`, id),
      resourceUnits: f.resource_units,
      reserveUnits: f.reserve_units,
      unpaidPeriods: f.upkeep_unpaid_periods,
      liveFleets: fleets.n,
      liveShips: fleets.ships,
      stations: one("SELECT count(*) AS n FROM world_stations WHERE owner_faction_id = ? AND state <> 'DESTROYED'", id),
      coreHeld: coreHeld.get(id) || 0,
    };
  }
  return out;
}

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function replayOccupation(entries, cursor) {
  const states = new Map(cursor && cursor.occupation ? cursor.occupation : []);
  const claims = new Map(cursor && cursor.claims ? cursor.claims : []);
  const edges = {};
  const repelledBy = {};
  const reconExpiredBy = {};
  let claimsRepelled = 0;
  let reconExpired = 0;
  const lostPostsBy = {};
  let lostPostsHostile = 0;
  let lostPostsAbandoned = 0;
  for (const e of entries) {
    let p = e.payload;
    if (typeof p === "string") {
      try {
        p = JSON.parse(p);
      } catch (_err) {
        continue;
      }
    }
    const st = p && p.state && typeof p.state === "object" ? p.state : null;
    if (st === null) continue;
    const id = e.aggregateId;
    const before = claims.get(id) || [null, null, null];
    const after = [has(st, "controllerFactionId") ? st.controllerFactionId : before[0],
      has(st, "occupierFactionId") ? st.occupierFactionId : before[1],
      has(st, "capturedAt") ? st.capturedAt : (before[2] === undefined ? null : before[2])];
    claims.set(id, after);
    if (before[0] !== null && before[0] !== undefined && before[2] !== null && before[2] !== undefined
      && after[0] !== before[0]) {
      lostPostsBy[before[0]] = (lostPostsBy[before[0]] || 0) + 1;
      if (after[0] === null || after[0] === undefined) lostPostsAbandoned += 1;
      else lostPostsHostile += 1;
    }
    const to = typeof st.occupationState === "string" ? st.occupationState : null;
    if (to === null) continue;
    const from = states.get(id);
    if (from !== undefined && from !== to) {
      edges[`${from}>${to}`] = (edges[`${from}>${to}`] || 0) + 1;
      const defended = to === "STABLE" && before[0] !== null && before[1] !== null && before[1] !== before[0]
        && after[0] === before[0];
      if (defended && from === "CONTESTED") {
        claimsRepelled += 1;
        repelledBy[before[0]] = (repelledBy[before[0]] || 0) + 1;
      } else if (defended && from === "RECON") {
        reconExpired += 1;
        reconExpiredBy[before[0]] = (reconExpiredBy[before[0]] || 0) + 1;
      }
    }
    states.set(id, to);
  }
  return { edges, claimsRepelled, repelledBy, reconExpired, reconExpiredBy,
    lostPosts: { total: lostPostsHostile + lostPostsAbandoned, hostile: lostPostsHostile, abandoned: lostPostsAbandoned,
      byFaction: lostPostsBy },
    occupation: [...states], claims: [...claims] };
}

function occupationEdges(db, cursor) {
  let journalId = cursor ? cursor.journalId : 0;
  const rows = [];
  for (const r of db.prepare(`SELECT journal_id, aggregate_id, payload FROM world_event_journal
    WHERE journal_id > ? AND aggregate_type = 'world_system' AND state = 'APPLIED' ORDER BY journal_id`).iterate(journalId)) {
    journalId = r.journal_id;
    rows.push({ aggregateId: r.aggregate_id, payload: r.payload });
  }
  const rep = replayOccupation(rows, cursor);
  const lastJournal = db.prepare("SELECT coalesce(max(journal_id), 0) AS n FROM world_event_journal").get().n;
  return { edges: rep.edges, claimsRepelled: rep.claimsRepelled, repelledBy: rep.repelledBy,
    reconExpired: rep.reconExpired, reconExpiredBy: rep.reconExpiredBy, lostPosts: rep.lostPosts, cursorPart: { occupation: rep.occupation, claims: rep.claims, journalId: Math.max(journalId, lastJournal) } };
}

function diagnostics(db, fromJournalId, fromAt, at) {
  const launches = {};
  const reactiveLaunches = {};
  for (const r of db.prepare(`SELECT aggregate_id AS f, json_extract(payload, '$.intent.kind') AS kind,
    (idempotency_key LIKE '${REACTIVE_KEY_PREFIX}%') AS reactive, count(*) AS n
    FROM world_event_journal WHERE journal_id > ? AND event_type = 'STRATEGY_INTENT' AND aggregate_type = 'world_faction'
    AND json_extract(payload, '$.intent.type') = 'LAUNCH' GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).all(fromJournalId)) {
    const target = r.reactive ? reactiveLaunches : launches;
    (target[r.f] || (target[r.f] = {}))[String(r.kind)] = r.n;
  }
  const mobilized = {};
  const addMob = (f, role, n) => {
    const row = mobilized[f] || (mobilized[f] = {});
    row[String(role)] = (row[String(role)] || 0) + n;
  };
  for (const r of db.prepare(`SELECT aggregate_id AS f, json_extract(payload, '$.intent.role') AS role, count(*) AS n
    FROM world_event_journal WHERE journal_id > ? AND event_type = 'STRATEGY_INTENT' AND aggregate_type = 'world_faction'
    AND json_extract(payload, '$.intent.type') = 'MOBILIZE' GROUP BY 1, 2 ORDER BY 1, 2`).all(fromJournalId)) {
    addMob(r.f, r.role, r.n);
  }
  for (const r of db.prepare(`SELECT j.aggregate_id AS f, json_extract(m.value, '$.role') AS role, count(*) AS n
    FROM world_event_journal j, json_each(j.payload, '$.intent.mobilize') m WHERE j.journal_id > ?
    AND j.event_type = 'STRATEGY_INTENT' AND j.aggregate_type = 'world_faction'
    AND json_extract(j.payload, '$.intent.type') = 'LAUNCH' GROUP BY 1, 2 ORDER BY 1, 2`).all(fromJournalId)) {
    addMob(r.f, r.role, r.n);
  }
  const destroyed = {};
  for (const r of db.prepare(`SELECT faction_id AS f, fleet_role AS role, count(*) AS n FROM virtual_fleets
    WHERE state = 'DESTROYED' AND updated_at >= ? AND updated_at < ? GROUP BY 1, 2 ORDER BY 1, 2`).all(fromAt, at)) {
    (destroyed[r.f] || (destroyed[r.f] = {}))[r.role] = r.n;
  }
  const active = new Set(db.prepare("SELECT faction_id FROM world_factions WHERE status = 'ACTIVE'").all()
    .map((r) => r.faction_id));
  const ctrlOf = db.prepare("SELECT controller_faction_id AS c FROM world_system_state WHERE system_id = ?");
  const rolls = { outcomes: {}, spawnByCategory: { free: 0, active: 0, other: 0 }, spawnCategoryApprox: 0,
    spawnByProfile: {} };
  for (const r of db.prepare(`SELECT payload FROM world_event_journal WHERE journal_id > ?
    AND event_type = 'INVASION_ROLLED' ORDER BY journal_id`).all(fromJournalId)) {
    let p;
    try {
      p = JSON.parse(r.payload);
    } catch (_err) {
      continue;
    }
    const outcome = String(p && p.outcome);
    rolls.outcomes[outcome] = (rolls.outcomes[outcome] || 0) + 1;
    if (outcome !== "SPAWN") continue;
    let cat;
    if (ROLL_CATEGORIES.includes(p.targetCategory)) {
      cat = p.targetCategory;
    } else {
      const row = Number.isSafeInteger(p.targetSystemId) ? ctrlOf.get(p.targetSystemId) : undefined;
      const c = row ? row.c : null;
      cat = c === null || c === undefined ? "free" : active.has(c) ? "active" : "other";
      rolls.spawnCategoryApprox += 1;
    }
    rolls.spawnByCategory[cat] += 1;
    const profile = String(p.profileId);
    rolls.spawnByProfile[profile] = (rolls.spawnByProfile[profile] || 0) + 1;
  }
  const roles = {};
  for (const r of db.prepare(`SELECT faction_id AS f, fleet_role AS role, count(*) AS n FROM virtual_fleets
    WHERE state <> 'DESTROYED' GROUP BY 1, 2 ORDER BY 1, 2`).all()) {
    (roles[r.f] || (roles[r.f] = {}))[r.role] = r.n;
  }
  return { launches, reactiveLaunches, mobilized, destroyed, rolls, roles };
}

function invasionRows(db, fromAt, at) {
  return db.prepare(`SELECT invasion_id, faction_id, profile_id, beachhead_system_id, state, started_at, withdraw_at,
    withdraw_round, step_seq, ended_at, end_reason FROM world_invasions
    WHERE open = 1 OR (ended_at > ? AND ended_at <= ?) ORDER BY started_at, invasion_id`).all(fromAt, at)
    .map((r) => ({ invasionId: r.invasion_id, factionId: r.faction_id, profileId: r.profile_id,
      beachheadSystemId: r.beachhead_system_id, state: r.state, startedAt: r.started_at, withdrawAt: r.withdraw_at,
      withdrawRound: r.withdraw_round, stepSeq: r.step_seq, endedAt: r.ended_at, endReason: r.end_reason }));
}

function tributeProbe(db, fromAt, at) {
  const recipient = {};
  for (const r of TRIBUTE_RECIPIENTS) {
    const stock = db.prepare(`SELECT coalesce(sum(CASE WHEN k.item_kind = 'mineral' THEN k.quantity END), 0) AS minerals,
      coalesce(sum(CASE WHEN k.item_kind = 'hull' THEN k.quantity END), 0) AS hulls FROM world_station_stock k
      JOIN world_stations s ON s.station_id = k.station_id WHERE s.owner_faction_id = ? AND s.state = 'ONLINE'`).get(r);
    const jobs = db.prepare(`SELECT count(*) AS n, coalesce(sum(runs), 0) AS runs FROM world_production_jobs
      WHERE faction_id = ? AND created_at > ? AND created_at <= ?`).get(r, fromAt, at);
    const fleets = db.prepare(`SELECT count(*) AS n, coalesce(sum(ship_count), 0) AS ships FROM virtual_fleets
      WHERE faction_id = ? AND state <> 'DESTROYED'`).get(r);
    recipient[r] = { mineralUnits: stock.minerals, hullUnits: stock.hulls, produceJobs: jobs.n, produceRuns: jobs.runs,
      liveFleets: fleets.n, liveShips: fleets.ships };
  }
  const opsPerFaction = {};
  for (const r of db.prepare(`SELECT faction_id AS f, count(*) AS n FROM world_operations WHERE planned_at > ?
    AND planned_at <= ? GROUP BY 1 ORDER BY 1`).all(fromAt, at)) opsPerFaction[r.f] = r.n;
  const convoys = {};
  for (const r of db.prepare(`SELECT faction_id AS f, state, count(*) AS n FROM world_convoys WHERE purpose = ?
    GROUP BY 1, 2 ORDER BY 1, 2`).all(TRIBUTE_PURPOSE)) {
    const row = convoys[r.f] || (convoys[r.f] = { DELIVERED: 0, LOST: 0, ABORTED: 0, open: 0 });
    const key = CONVOY_OPEN_STATES.includes(r.state) ? "open" : r.state;
    row[key] = (row[key] || 0) + r.n;
  }
  const deliveredUnits = {};
  for (const r of db.prepare(`SELECT c.faction_id AS f, coalesce(sum(j.value), 0) AS n FROM world_convoys c,
    json_each(c.delivered_json) j WHERE c.purpose = ? AND c.state = 'DELIVERED' AND c.ended_at > ?
    AND c.ended_at <= ? GROUP BY 1 ORDER BY 1`).all(TRIBUTE_PURPOSE, fromAt, at)) deliveredUnits[r.f] = r.n;
  const payerFleetsAtRecipient = {};
  for (const [payer, receiver] of TRIBUTE_PAYERS) {
    payerFleetsAtRecipient[payer] = db.prepare(`SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ?
      AND fleet_role = 'logistics' AND state = 'IDLE' AND current_system_id IN (SELECT system_id FROM world_stations
      WHERE owner_faction_id = ? AND state <> 'DESTROYED')`).get(payer, receiver).n;
  }
  return { recipient, opsPerFaction, convoys, deliveredUnits, payerFleetsAtRecipient };
}

function idleProbe(db) {
  const roles = {};
  for (const r of db.prepare(`SELECT fleet_role AS role, count(*) AS live, coalesce(sum(state = 'IDLE'), 0) AS idle
    FROM virtual_fleets WHERE state <> 'DESTROYED' GROUP BY 1 ORDER BY 1`).all()) {
    roles[r.role] = { live: r.live, idle: r.idle };
  }
  const ships = db.prepare(`SELECT s.system_id AS id, coalesce((SELECT sum(v.ship_count) FROM virtual_fleets v
    WHERE v.faction_id = s.controller_faction_id AND v.current_system_id = s.system_id AND v.fleet_role = 'garrison'
    AND v.state <> 'DESTROYED'), 0) AS n FROM world_system_state s WHERE s.controller_faction_id IS NOT NULL
    AND s.captured_at IS NOT NULL AND s.occupation_state = 'STABLE' ORDER BY s.system_id`).all()
    .map((r) => r.n).sort((a, b) => a - b);
  const mid = ships.length >> 1;
  const median = ships.length === 0 ? null : ships.length % 2 === 1 ? ships[mid] : (ships[mid - 1] + ships[mid]) / 2;
  const posts = {};
  for (const r of db.prepare(`SELECT controller_faction_id AS f, system_id AS id FROM world_system_state
    WHERE controller_faction_id IS NOT NULL AND captured_at IS NOT NULL ORDER BY 1, 2`).all()) {
    (posts[r.f] || (posts[r.f] = [])).push(r.id);
  }
  return { roles, garrisonShips: { posts: ships.length, median, zero: ships.filter((n) => n === 0).length }, posts };
}

function sampleDay(db, ctx) {
  const { config, fromAt, at } = ctx;
  const counters = ctx.counters || {};
  const prev = ctx.prevCounters || null;
  const cursor = ctx.cursor || null;
  const core = coreCounts(db, config);
  const perFaction = factionRows(db, config, core.audit ? core.audit.heldByFaction : new Map());
  const settledSince = db.prepare(`SELECT count(*) AS n FROM world_event_journal WHERE journal_id > ?
    AND event_type = 'BATTLE_SETTLED'`).get(cursor ? cursor.journalId : 0).n;
  const occ = occupationEdges(db, cursor);
  const diag = diagnostics(db, cursor ? cursor.journalId : 0, fromAt, at);
  const notes = ctx.reviewNotes || { perFaction: {}, missedRounds: null, errors: null };
  for (const [f, m] of Object.entries(perFaction)) {
    const n = notes.perFaction[f] || { reviews: 0, notes: {} };
    m.reviews = n.reviews;
    m.reviewNotes = n.notes;
    m.launches = diag.launches[f] || {};
    m.reactiveLaunches = diag.reactiveLaunches[f] || {};
    m.mobilized = diag.mobilized[f] || {};
    m.fleetRoles = diag.roles[f] || {};
  }
  const totals = db.prepare(`SELECT (SELECT coalesce(sum(mineral_units), 0) FROM world_mining_totals) AS mined,
    (SELECT coalesce(sum(hulls_delivered), 0) FROM world_production_totals) AS hulls`).get();
  const review = {};
  for (const name of REVIEW_05B) review[name] = delta(counters, prev, `strategy.review.${name}`);
  const trim = {};
  for (const name of Object.keys(counters).filter((k) => k.startsWith("strategy.trim")).sort()) {
    trim[name.slice("strategy.".length)] = delta(counters, prev, name);
  }
  let reactive = null;
  if (has(counters, "strategy.reactive.runs")) {
    reactive = {};
    for (const name of REACTIVE_COUNTERS) reactive[name] = delta(counters, prev, `strategy.reactive.${name}`);
  }
  const reviewEcon = {};
  for (const name of REVIEW_ECON) reviewEcon[name] = delta(counters, prev, `strategy.review.${name}`);
  const run = ctx.run || { passes: 0, events: 0, wallMs: 0, passMs: [] };
  const sample = {
    day: ctx.day,
    at,
    tradeMode: ctx.tradeMode,
    perFaction,
    global: {
      occupationEdges: occ.edges,
      claimsRepelled: occ.claimsRepelled,
      claimsRepelledBy: occ.repelledBy,
      reconExpired: occ.reconExpired,
      reconExpiredBy: occ.reconExpiredBy,
      lostPosts: occ.lostPosts,
      fleetsDestroyed: diag.destroyed,
      invasionRolls: diag.rolls,
      invasions: invasionRows(db, fromAt, at),
      reactive,
      reviewEcon,
      tx: run.tx || null,
      checkpoint: run.checkpoint || null,
      observe: observeDay(ctx.observe),
      notesMissedRounds: notes.missedRounds,
      notesTapErrors: notes.errors,
      homeReclaimed: delta(counters, prev, "world.occupation.homeReclaimed"),
      battlesSettled: settledSince,
      defensesPlanned: inDay(db, `SELECT count(*) AS n FROM world_operations WHERE operation_type = 'defense'
        AND planned_at > ? AND planned_at <= ?`, fromAt, at),
      review,
      hoard: { upkeepHoardCapped: delta(counters, prev, "strategy.review.upkeepHoardCapped"),
        raidTargets: delta(counters, prev, "strategy.review.raidTargets"),
        raidTargetLaunches: delta(counters, prev, "strategy.review.raidTargetLaunches") },
      trim,
      tribute: tributeProbe(db, fromAt, at),
      idle: idleProbe(db),
      wreckFields: inDay(db, "SELECT count(*) AS n FROM world_wreck_fields WHERE created_at > ? AND created_at <= ?",
        fromAt, at),
      salvageJobs: inDay(db, "SELECT count(*) AS n FROM salvage_jobs WHERE created_at > ? AND created_at <= ?",
        fromAt, at),
      invasionsStarted: inDay(db, "SELECT count(*) AS n FROM world_invasions WHERE started_at > ? AND started_at <= ?",
        fromAt, at),
      invasionsOpen: db.prepare("SELECT count(*) AS n FROM world_invasions WHERE open = 1").get().n,
      siegesStarted: inDay(db, `SELECT count(*) AS n FROM world_station_sieges WHERE started_at > ?
        AND started_at <= ?`, fromAt, at),
      mineralUnitsMined: totals.mined - (cursor ? cursor.mined : 0),
      hullsDelivered: totals.hulls - (cursor ? cursor.hulls : 0),
      sovUnavailable: delta(counters, prev, "world.invasions.sovUnavailable"),
      journalRows: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
      openSchedulerEvents: db.prepare(`SELECT count(*) AS n FROM world_scheduled_events
        WHERE state <> 'DONE' AND state IN ('QUEUED', 'RETRY', 'CLAIMED')`).get().n,
      schedulerRows: db.prepare("SELECT count(*) AS n FROM world_scheduled_events").get().n,
      liveFleets: db.prepare("SELECT count(*) AS n FROM virtual_fleets WHERE state <> 'DESTROYED'").get().n,
      dbBytes: ctx.files ? ctx.files.dbBytes : null,
      walBytes: ctx.files ? ctx.files.walBytes : null,
      passes: run.passes,
      events: run.events,
      wallMs: round2(run.wallMs),
      totalMs: round2(run.wallMs + (run.checkpoint && Number.isFinite(run.checkpoint.ms) ? run.checkpoint.ms : 0)),
      p95PassMs: round2(pct(run.passMs, P95)),
    },
    views: ctx.views || { galaxyState: null, control: null },
  };
  return { sample, cursor: { ...occ.cursorPart, mined: totals.mined, hulls: totals.hulls } };
}

const kv = (o) => {
  const parts = Object.entries(o || {}).map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`);
  return parts.length > 0 ? parts.join(", ") : "-";
};

function formatDiagnostics(report, lines) {
  const samples = report.samples.filter((s) => s.global && s.global.invasionRolls);
  if (samples.length === 0) return;
  lines.push("", "## Diagnostics (global, per day)", "",
    "Roll target category = targetCategory of the roll; \"(approx N)\" = N spawns without it, read from the "
      + "controller of the target at the sample (ACTIVE faction -> active). reconExpired (RECON -> STABLE) is no "
      + "defense. reactive defenses: strategy.reactive.defenses (\"-\" = no reactive review).", "",
    "| day | claimsRepelled | repelledBy | reconExpired | reactive defenses | destroyed fleets | roll outcomes "
      + "| SPAWN free/active/other | SPAWN per profile | notesMissedRounds | tapErrors |",
    "|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of samples) {
    const g = s.global;
    const dead = Object.values(g.fleetsDestroyed).reduce((a, r) => a + Object.values(r).reduce((x, y) => x + y, 0), 0);
    const c = g.invasionRolls.spawnByCategory;
    const other = c.other !== undefined ? c.other : c.passive;
    const approx = g.invasionRolls.spawnCategoryApprox ? ` (approx ${g.invasionRolls.spawnCategoryApprox})` : "";
    const reconExpired = g.reconExpired === undefined ? "-" : g.reconExpired;
    const reactive = g.reactive ? g.reactive.defenses : "-";
    lines.push(`| ${s.day} | ${g.claimsRepelled} | ${kv(g.claimsRepelledBy)} | ${reconExpired} | ${reactive} | ${dead} `
      + `| ${kv(g.invasionRolls.outcomes)} | ${c.free}/${c.active}/${other}${approx} `
      + `| ${kv(g.invasionRolls.spawnByProfile)} | ${g.notesMissedRounds} | ${g.notesTapErrors} |`);
  }
  const withInvasions = samples.filter((s) => Array.isArray(s.global.invasions));
  if (withInvasions.length > 0) {
    lines.push("", "## Invasions per day (open at the sample or ended within the day)", "",
      "| day | invasion | faction | profile | beachhead | state | startedAt | withdrawAt | withdrawRound | stepSeq "
        + "| endedAt | endReason |", "|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const s of withInvasions) {
      for (const i of s.global.invasions) {
        lines.push(`| ${s.day} | ${i.invasionId} | ${i.factionId} | ${i.profileId} | ${i.beachheadSystemId} | ${i.state} `
          + `| ${i.startedAt} | ${i.withdrawAt === null ? "-" : i.withdrawAt} | ${i.withdrawRound} | ${i.stepSeq} `
          + `| ${i.endedAt === null ? "-" : i.endedAt} | ${i.endReason === null ? "-" : i.endReason} |`);
      }
    }
  }
  lines.push("", "## Review notes, LAUNCH, mobilizations and losses per faction and day", "",
    "| day | faction | reviews | notes | LAUNCH per kind | reactive LAUNCH | mobilized per role | destroyed per role |",
    "|---|---|---|---|---|---|---|---|");
  for (const s of samples) {
    for (const [f, m] of Object.entries(s.perFaction)) {
      lines.push(`| ${s.day} | ${f} | ${m.reviews} | ${kv(m.reviewNotes)} | ${kv(m.launches)} `
        + `| ${kv(m.reactiveLaunches)} | ${kv(m.mobilized)} | ${kv(s.global.fleetsDestroyed[f])} |`);
    }
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  lines.push("", `## Live fleets per role, day ${first.day} and day ${last.day}`, "",
    `| faction | day ${first.day} | day ${last.day} |`, "|---|---|---|");
  for (const f of Object.keys(last.perFaction)) {
    lines.push(`| ${f} | ${kv(first.perFaction[f] && first.perFaction[f].fleetRoles)} `
      + `| ${kv(last.perFaction[f].fleetRoles)} |`);
  }
}

function formatReactive(report, lines) {
  const samples = report.samples.filter((s) => s.global && s.global.reviewEcon);
  if (samples.length === 0) return;
  lines.push("", "## Reactive review", "",
    "reactive: strategy.reactive.* of the day (\"-\" = no reactive review). review: strategy.review.* of the day. "
      + "Read times: wall ms of the day samples (no digest, no checks). schedulerRows: all world_scheduled_events rows.",
    "", "| day | runs | launches | defenses | reliefs | capped | review launches | mobilized | produced "
      + "| mineDispatched | reactiveReadMs p50/p95/max | reviewReadMs p95 | schedulerRows |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of samples) {
    const g = s.global;
    const r = g.reactive;
    const v = (k) => (r && r[k] !== undefined ? r[k] : "-");
    const o = g.observe || {};
    const rr = o["strategy.reactiveReadMs"];
    const vr = o["strategy.reviewReadMs"];
    lines.push(`| ${s.day} | ${v("runs")} | ${v("launches")} | ${v("defenses")} | ${v("reliefs")} | ${v("capped")} `
      + `| ${g.reviewEcon.launches} | ${g.reviewEcon.mobilized} | ${g.reviewEcon.produced} `
      + `| ${g.reviewEcon.mineDispatched} | ${rr ? `${rr.p50}/${rr.p95}/${rr.max}` : "-"} | ${vr ? vr.p95 : "-"} `
      + `| ${g.schedulerRows === undefined ? "-" : g.schedulerRows} |`);
  }
}

function formatLostPosts(report, lines) {
  const samples = report.samples.filter((s) => s.global && s.global.lostPosts);
  if (samples.length === 0) return;
  lines.push("", "## Lost posts", "",
    "Lost post = a captured system (controller and capturedAt set) whose controller changes (journal replay of "
      + "world_system). hostile = another faction takes it, abandoned = no controller after it. byFaction = the "
      + "faction that lost it.", "",
    "| day | lost | hostile | abandoned | run total | byFaction |", "|---|---|---|---|---|---|");
  let total = 0;
  for (const s of samples) {
    const l = s.global.lostPosts;
    total += l.total;
    lines.push(`| ${s.day} | ${l.total} | ${l.hostile} | ${l.abandoned} | ${total} | ${kv(l.byFaction)} |`);
  }
}

function formatMd(report) {
  const lines = [`# Campaign bench seed=${report.seed} days=${report.days} restart=${report.restart.mode}`, ""];
  for (const [k, v] of Object.entries(report.header)) lines.push(`- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`);
  lines.push("", "| day | edges | battles | defenses | reclaims | captureNotAdjacent | territoryLimit | invasions | "
    + "sieges | mined | hulls | journal | open ev | passes | wall ms | ckpt ms | total ms | p95 ms | db MB |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const s of report.samples) {
    const g = s.global;
    const edges = Object.values(g.occupationEdges).reduce((a, b) => a + b, 0);
    lines.push(`| ${s.day} | ${edges} | ${g.battlesSettled} | ${g.review.defenses} | ${g.review.reclaims} `
      + `| ${g.review.captureNotAdjacent} | ${g.review.territoryLimit} | ${g.invasionsStarted} | ${g.siegesStarted} `
      + `| ${g.mineralUnitsMined} | ${g.hullsDelivered} | ${g.journalRows} | ${g.openSchedulerEvents} | ${g.passes} `
      + `| ${g.wallMs} | ${g.checkpoint ? g.checkpoint.ms : "-"} | ${g.totalMs === undefined ? "-" : g.totalMs} `
      + `| ${g.p95PassMs} | ${g.dbBytes === null ? "-" : round2((g.dbBytes + g.walBytes) / 1048576)} |`);
  }
  const last = report.samples[report.samples.length - 1];
  if (last) {
    lines.push("", `## Factions, day ${last.day}`, "", "| faction | controlled | captured | lostHome | threats | claims "
      + "| captureRoom | fronts | resource | reserve | unpaid | fleets | ships | stations | coreHeld |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [f, m] of Object.entries(last.perFaction)) {
      lines.push(`| ${f} | ${m.controlled} | ${m.captured} | ${m.lostHome} | ${m.threats} | ${m.claims} `
        + `| ${m.captureRoom} | ${m.fronts} | ${m.resourceUnits} | ${m.reserveUnits} | ${m.unpaidPeriods} `
        + `| ${m.liveFleets} | ${m.liveShips} | ${m.stations} | ${m.coreHeld} |`);
    }
  }
  formatDiagnostics(report, lines);
  formatReactive(report, lines);
  formatLostPosts(report, lines);
  lines.push("", `checks: ${report.checksLine}`, `result: ${report.ok ? "PASS" : `FAIL ${report.failures.join("; ")}`}`);
  return `${lines.join("\n")}\n`;
}

module.exports = { sampleDay, formatMd, replayOccupation, tributeProbe, idleProbe, REVIEW_05B, OBSERVE_NAMES };
