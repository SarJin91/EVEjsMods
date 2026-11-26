"use strict";

const { checkBattleInvariants } = require("../../lib/battle/checks");
const { checkFleetInvariants } = require("../../lib/fleets/stateMachine");
const { FLEET_STATES, TERMINAL_OPERATION_STATES, OPEN_OPERATION_STATES } = require("../../lib/fleets/schema");
const { BATTLE_STATES, OPEN_BATTLE_STATES } = require("../../lib/battle/schema");
const { AWAITING_LIVE } = require("../../lib/battle/resolutionService");
const { STATE: EVENT_STATE, LIVE_INDEX_WHERE: LIVE } = require("../../lib/scheduler/schema");
const { EVENT_TYPES, getEventType } = require("../../lib/scheduler/eventTypes");
const { KIND_OUTBOX, STATE_PENDING, STATE_FAILED } = require("../../lib/persistence/journal");
const PH = require("../../lib/playerHunt/schema");
const { checkCampaignInvariants } = require("../campaign/checks");
const { checkEnded, journalOf } = require("../huntState");

const SEVERITY = Object.freeze({ ERROR: "ERROR", WARN: "WARN", INFO: "INFO" });

function pick(list, value) {
  if (!list.includes(value)) throw new Error(`auditWorldDb: state ${value} missing in its module`);
  return value;
}

function eventType(name) {
  const t = getEventType(name);
  if (!t) throw new Error(`auditWorldDb: event type ${name} missing in lib/scheduler/eventTypes.js`);
  return t.eventType;
}

const FLEET = Object.freeze({
  TRAVELLING: pick(FLEET_STATES, "TRAVELLING"), RETREATING: pick(FLEET_STATES, "RETREATING"),
  REFITTING: pick(FLEET_STATES, "REFITTING"), MATERIALIZED: pick(FLEET_STATES, "MATERIALIZED"),
  DESTROYED: pick(FLEET_STATES, "DESTROYED"), PLANNED: pick(FLEET_STATES, "PLANNED"),
  STAGED: pick(FLEET_STATES, "STAGED"),
});
const BATTLE_LIVE = pick(BATTLE_STATES, "LIVE");
const OPEN_NOT_LIVE = Object.freeze(OPEN_BATTLE_STATES.filter((s) => s !== BATTLE_LIVE));
const HUNT_ENDED = pick(PH.HUNT_STATES, "ENDED");
const OPEN_EVENT = Object.freeze([EVENT_STATE.QUEUED, EVENT_STATE.RETRY, EVENT_STATE.CLAIMED]);
const WAITING_EVENT = Object.freeze([EVENT_STATE.QUEUED, EVENT_STATE.RETRY]);
const T_ARRIVAL = eventType("FLEET_ARRIVAL");
const T_REFIT = eventType("FLEET_REFIT_COMPLETE");
const T_RECONCILE = eventType("BATTLE_RECONCILE");
const PERIODIC_TYPES = Object.freeze(Object.values(EVENT_TYPES).filter((t) => t.periodic === true)
  .map((t) => t.eventType));
const RECONCILE_KEY = /^battle:reconcile:(\d+)$/;
const RECONCILE_PREFIX = "battle:reconcile:";

const T = Object.freeze({ EVENTS: "world_scheduled_events", JOURNAL: "world_event_journal", FLEETS: "virtual_fleets",
  OPERATIONS: "world_operations", BATTLES: "battle_records", HUNTS: PH.TABLE_NAME });
const BATTLE_TABLES = Object.freeze([T.BATTLES, "battle_participants", T.FLEETS, T.JOURNAL, T.EVENTS,
  "world_wreck_fields"]);
const CAMPAIGN_TABLES = Object.freeze([...BATTLE_TABLES, "world_system_state"]);

const NEGATIVE_SCALAR = /(^|_)(isk|balance|units|quantity|qty|stock|reserve|volume|count|budget)(_|$)/;
const NEGATIVE_ALLOWED = Object.freeze([]);
const RESOURCE_JSON = Object.freeze([
  ["world_mining_trips", "cargo_json"], ["world_mining_trips", "delivered_json"],
  ["world_convoys", "cargo_json"], ["world_convoys", "delivered_json"],
  ["world_production_jobs", "consumed_json"],
  ["world_station_builds", "required_json"], ["world_station_builds", "delivered_json"],
  ["virtual_fleets", "composition_json"], ["world_wreck_fields", "composition_json"],
]);
const KEY_COLUMNS = Object.freeze(["idempotency_key", "settlement_key"]);
const INTEGRITY_LIMIT = 100;
const INTEGRITY_MESSAGES_MAX = 20;

function messageOf(err) {
  return String((err && err.message) || err);
}

const marks = (list) => list.map(() => "?").join(", ");
const quote = (name) => `"${String(name).replace(/"/g, "\"\"")}"`;

function tablesOf(db) {
  return new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' "
    + "ESCAPE '\\' ORDER BY name").all().map((r) => r.name));
}

function skipToken(sql, i) {
  const ch = sql[i];
  if (ch === "'" || ch === "\"" || ch === "`") {
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === ch) {
        if (sql[j + 1] === ch) j += 2;
        else return j + 1;
      } else j += 1;
    }
    return sql.length;
  }
  if (ch === "[") {
    const e = sql.indexOf("]", i + 1);
    return e === -1 ? sql.length : e + 1;
  }
  if (sql.startsWith("--", i)) {
    const e = sql.indexOf("\n", i);
    return e === -1 ? sql.length : e + 1;
  }
  if (sql.startsWith("/*", i)) {
    const e = sql.indexOf("*/", i + 2);
    return e === -1 ? sql.length : e + 2;
  }
  return -1;
}

const IDENT_CHAR = /[A-Za-z0-9_$]/;

function extractChecks(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const skipped = skipToken(sql, i);
    if (skipped !== -1) {
      i = skipped;
      continue;
    }
    const word = sql.slice(i, i + 5).toUpperCase() === "CHECK" && !IDENT_CHAR.test(sql[i - 1] || "")
      && !IDENT_CHAR.test(sql[i + 5] || "");
    if (!word) {
      i += 1;
      continue;
    }
    let j = i + 5;
    while (j < sql.length && /\s/.test(sql[j])) j += 1;
    if (sql[j] !== "(") {
      i = j;
      continue;
    }
    let depth = 0;
    let k = j;
    while (k < sql.length) {
      const s = skipToken(sql, k);
      if (s !== -1) {
        k = s;
        continue;
      }
      if (sql[k] === "(") depth += 1;
      else if (sql[k] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
      k += 1;
    }
    out.push(sql.slice(j + 1, k));
    i = k + 1;
  }
  return out;
}

function checkConstraintViolations(db) {
  const byTable = {};
  const unevaluated = [];
  const errors = {};
  let total = 0;
  for (const t of db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' "
    + "ESCAPE '\\' AND sql IS NOT NULL ORDER BY name").all()) {
    const checks = extractChecks(t.sql);
    if (checks.length === 0) continue;
    const where = checks.map((e) => `(NOT (${e}))`).join(" OR ");
    const stmt = db.prepare(`SELECT count(*) AS n FROM ${quote(t.name)} WHERE ${where}`);
    let n;
    try {
      n = stmt.get().n;
    } catch (err) {
      unevaluated.push(t.name);
      errors[t.name] = messageOf(err);
      n = 1;
    }
    if (n > 0) {
      byTable[t.name] = n;
      total += n;
    }
  }
  return { total, byTable, unevaluated, errors };
}

function runIntegrity(db, mode) {
  if (mode === "off") {
    return { ok: null, messages: [], checkViolations: {}, checkUnevaluated: [], count: 0, pragmaCount: 0,
      checkScan: null };
  }
  const quick = mode === "quick";
  const rows = db.pragma(`${quick ? "quick_check" : "integrity_check"}(${INTEGRITY_LIMIT})`);
  const messages = rows.map((r) => String(Object.values(r)[0])).filter((m) => m !== "ok");
  const pragmaCount = messages.length;
  if (quick) {
    return { ok: pragmaCount === 0, messages, checkViolations: {}, checkUnevaluated: [], count: pragmaCount,
      pragmaCount, checkScan: "skipped" };
  }
  const checks = checkConstraintViolations(db);
  for (const [t, n] of Object.entries(checks.byTable)) {
    messages.push(checks.unevaluated.includes(t) ? `CHECK not evaluable in ${t}: ${checks.errors[t]}`
      : `CHECK constraint failed in ${t}: ${n} rows`);
  }
  const count = pragmaCount + checks.total;
  return { ok: count === 0, messages, checkViolations: checks.byTable, checkUnevaluated: checks.unevaluated, count,
    pragmaCount, checkScan: "done" };
}

function referenceTime(db, nowArg, clock) {
  try {
    const tables = tablesOf(db);
    let lastBootAt = null;
    if (tables.has(T.EVENTS)) {
      const rows = db.prepare(`SELECT idempotency_key AS k FROM ${T.EVENTS} WHERE idempotency_key >= ? `
        + "AND idempotency_key < ? AND event_type = ?")
        .all(RECONCILE_PREFIX, `${RECONCILE_PREFIX.slice(0, -1)};`, T_RECONCILE);
      for (const r of rows) {
        const m = RECONCILE_KEY.exec(r.k);
        if (m && (lastBootAt === null || Number(m[1]) > lastBootAt)) lastBootAt = Number(m[1]);
      }
    }
    if (Number.isSafeInteger(nowArg)) return { ok: true, refNow: nowArg, source: "arg", lastBootAt };
    const candidates = [];
    if (tables.has(T.EVENTS)) {
      const e = db.prepare(`SELECT max(finished_at) AS f, max(created_at) AS c FROM ${T.EVENTS}`).get();
      candidates.push(e.f, e.c);
    }
    if (tables.has(T.JOURNAL)) {
      const j = db.prepare(`SELECT created_at AS c FROM ${T.JOURNAL} ORDER BY journal_id DESC LIMIT 1`).get();
      if (j) candidates.push(j.c);
    }
    const known = candidates.filter((v) => Number.isSafeInteger(v));
    if (known.length === 0) return { ok: true, refNow: clock(), source: "clock", lastBootAt };
    return { ok: true, refNow: Math.max(...known), source: "db", lastBootAt };
  } catch (err) {
    return { ok: false, reason: "CHECK_FAILED", detail: messageOf(err) };
  }
}

function parseJson(text) {
  try {
    return text === null || text === undefined ? null : JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function runAudit(db, ctx) {
  let current = "init";
  try {
    const sampleMax = Number.isSafeInteger(ctx.sample) && ctx.sample >= 0 ? ctx.sample : 5;
    const findings = [];
    const notes = [];
    const tables = tablesOf(db);
    const refNow = ctx.refNow;
    const boot = ctx.lastBootAt === null || ctx.lastBootAt === undefined ? 0 : ctx.lastBootAt;
    const add = (id, severity, count, sample, extra = {}) => {
      const f = { id, severity, count, sample: (sample || []).slice(0, sampleMax).map(String) };
      if (extra.detail !== undefined) f.detail = extra.detail;
      if (extra.note !== undefined) f.note = extra.note;
      findings.push(f);
    };
    const missing = (id, needed) => {
      const absent = needed.filter((t) => !tables.has(t));
      if (absent.length > 0) notes.push(`${id}: missing table ${absent.join(", ")}`);
      return absent.length > 0;
    };
    const check = (id, severity, needed, fn) => {
      current = id;
      if (missing(id, needed)) {
        add(id, severity, 0, []);
        return;
      }
      const [count, sample, extra] = fn();
      add(id, severity, count, sample, extra);
    };
    const rows = (sql, ...params) => db.prepare(sql).all(...params);

    current = "integrity";
    const integrity = ctx.integrityResult || runIntegrity(db, ctx.integrity);
    add("integrity", SEVERITY.ERROR, Number.isSafeInteger(integrity.count) ? integrity.count : integrity.messages.length,
      Object.keys(integrity.checkViolations || {}),
      integrity.ok === null ? { note: "integrity: off" }
        : { detail: { mode: ctx.integrity, checkScan: integrity.checkScan === undefined ? null : integrity.checkScan,
          messages: integrity.messages.slice(0, INTEGRITY_MESSAGES_MAX),
          checkViolations: integrity.checkViolations || {}, checkUnevaluated: integrity.checkUnevaluated || [] } });

    check("foreignKeys", SEVERITY.ERROR, [], () => {
      const fk = db.pragma("foreign_key_check");
      const byTable = {};
      for (const r of fk) byTable[`${r.table}->${r.parent}`] = (byTable[`${r.table}->${r.parent}`] || 0) + 1;
      return [fk.length, fk.map((r) => `${r.table}:${r.rowid}`), { detail: { byTable } }];
    });

    check("duplicateKeys", SEVERITY.ERROR, [], () => {
      let n = 0;
      const sample = [];
      const byColumn = {};
      for (const t of tables) {
        for (const c of db.prepare(`PRAGMA table_info(${quote(t)})`).all()) {
          if (!KEY_COLUMNS.includes(c.name)) continue;
          const dup = rows(`SELECT ${quote(c.name)} AS k, count(*) AS n FROM ${quote(t)} NOT INDEXED `
            + `WHERE ${quote(c.name)} IS NOT NULL GROUP BY ${quote(c.name)} HAVING count(*) > 1 ORDER BY 1`);
          if (dup.length === 0) continue;
          n += dup.length;
          byColumn[`${t}.${c.name}`] = dup.length;
          for (const d of dup) sample.push(`${t}.${c.name}=${d.k}`);
        }
      }
      if (tables.has(T.HUNTS)) {
        const dup = rows(`SELECT fleet_id AS k FROM ${T.HUNTS} NOT INDEXED WHERE state IN (${marks(PH.OPEN_STATES)}) `
          + "GROUP BY fleet_id HAVING count(*) > 1 ORDER BY 1", ...PH.OPEN_STATES);
        if (dup.length > 0) {
          n += dup.length;
          byColumn[`${T.HUNTS}.openFleet`] = dup.length;
          for (const d of dup) sample.push(`${T.HUNTS}.fleet_id=${d.k}`);
        }
      }
      return [n, sample, { detail: { byColumn } }];
    });

    current = "battleInvariants";
    let battle = null;
    if (!missing("battleInvariants", BATTLE_TABLES)) {
      battle = checkBattleInvariants(db);
      if (!battle.ok) return { ok: false, reason: "CHECK_FAILED", check: "battleInvariants", detail: battle.detail };
    }
    const fromBattle = (id, field) => add(id, SEVERITY.ERROR, battle ? battle[field] : 0, []);

    current = "campaignInvariants";
    let campaign = null;
    if (!missing("campaignInvariants", CAMPAIGN_TABLES)) {
      campaign = checkCampaignInvariants(db, { config: ctx.config, prev: null, graph: null, disabledTables: [],
        disabledInformational: true, now: refNow });
      if (!campaign.ok) {
        return { ok: false, reason: "CHECK_FAILED", check: "campaignInvariants",
          detail: `${campaign.reason}${campaign.detail ? ` ${campaign.detail}` : ""}` };
      }
    }
    const fromCampaign = (id, severity, sample = []) => add(id, severity, campaign ? campaign.counts[id] : 0, sample);

    fromBattle("duplicateSettlements", "duplicateSettlements");
    fromBattle("fleetsInTwoOpenBattles", "fleetsInTwoOpenBattles");
    const chainSamples = (key) => (campaign ? (campaign.details[key] || []) : [])
      .map((g) => `${g.eventType}:${g.aggregateId}:${g.keys.join("|")}`);
    fromCampaign("periodicChainsDoubled", SEVERITY.ERROR, chainSamples("periodicChainsDoubled"));
    fromCampaign("periodicChainsConverging", SEVERITY.INFO, chainSamples("periodicChainsConverging"));
    fromCampaign("occupationTickChainsDoubled", SEVERITY.ERROR,
      campaign ? campaign.details.occupationTickChainsDoubled.map((g) => g.keys.join("|")) : []);
    fromCampaign("upkeepOverlaps", SEVERITY.ERROR);

    check("huntNotExactlyOnce", SEVERITY.ERROR, [T.HUNTS, T.JOURNAL, T.FLEETS], () => {
      const fleetState = db.prepare(`SELECT state FROM ${T.FLEETS} WHERE fleet_id = ?`);
      let n = 0;
      const sample = [];
      for (const h of db.prepare(`SELECT hunt_id, fleet_id, members_json, losses_json FROM ${T.HUNTS} `
        + "WHERE state = ? ORDER BY hunt_id").iterate(HUNT_ENDED)) {
        const members = parseJson(h.members_json);
        const hunt = { members: Array.isArray(members) ? members : [], losses: parseJson(h.losses_json) };
        const f = fleetState.get(h.fleet_id);
        const problems = checkEnded(hunt, journalOf(db, h.hunt_id), f ? { state: f.state } : null);
        if (problems.length === 0) continue;
        n += 1;
        sample.push(`${h.hunt_id}: ${problems.join("; ")}`);
      }
      return [n, sample];
    });

    check("negativeResources", SEVERITY.ERROR, [], () => {
      let n = 0;
      const byColumn = {};
      for (const t of tables) {
        for (const c of db.prepare(`PRAGMA table_info(${quote(t)})`).all()) {
          const type = String(c.type).toUpperCase();
          if ((type !== "INTEGER" && type !== "REAL") || !NEGATIVE_SCALAR.test(c.name)) continue;
          if (NEGATIVE_ALLOWED.includes(`${t}.${c.name}`)) continue;
          const k = db.prepare(`SELECT count(*) AS n FROM ${quote(t)} WHERE ${quote(c.name)} < 0`).get().n;
          if (k > 0) {
            n += k;
            byColumn[`${t}.${c.name}`] = k;
          }
        }
      }
      for (const [t, c] of RESOURCE_JSON) {
        if (!tables.has(t)) {
          notes.push(`negativeResources: missing table ${t}`);
          continue;
        }
        const k = db.prepare(`SELECT count(*) AS n FROM ${quote(t)} AS x WHERE EXISTS (SELECT 1 FROM `
          + `json_tree(CASE WHEN json_valid(x.${quote(c)}) THEN x.${quote(c)} ELSE '[]' END) `
          + "WHERE type IN ('integer', 'real') AND value < 0)").get().n;
        if (k > 0) {
          n += k;
          byColumn[`${t}.${c}`] = k;
        }
      }
      return [n, Object.keys(byColumn), { detail: { byColumn } }];
    });

    check("malformedJson", SEVERITY.ERROR, [], () => {
      let n = 0;
      const sample = [];
      const byColumn = {};
      for (const [t, c] of RESOURCE_JSON) {
        if (!tables.has(t)) {
          notes.push(`malformedJson: missing table ${t}`);
          continue;
        }
        const pkCol = db.prepare(`PRAGMA table_info(${quote(t)})`).all().find((col) => col.pk === 1);
        const pk = pkCol ? quote(pkCol.name) : "rowid";
        const bad = rows(`SELECT ${pk} AS k FROM ${quote(t)} WHERE ${quote(c)} IS NOT NULL `
          + `AND json_valid(${quote(c)}) = 0 ORDER BY 1`);
        if (bad.length === 0) continue;
        n += bad.length;
        byColumn[`${t}.${c}`] = bad.length;
        for (const b of bad) sample.push(`${t}.${c}:${b.k}`);
      }
      return [n, sample, { detail: { byColumn } }];
    });

    fromBattle("orphanEngaged", "orphanEngaged");

    const ids = (list, key) => list.map((r) => r[key]);
    check("inFlightWithoutArrival", SEVERITY.ERROR, [T.FLEETS, T.EVENTS], () => {
      const r = rows(`SELECT f.fleet_id FROM ${T.FLEETS} f WHERE f.state IN (?, ?) AND NOT EXISTS (SELECT 1 FROM `
        + `${T.EVENTS} e WHERE e.${LIVE} AND e.event_type = ? AND e.aggregate_id = f.fleet_id `
        + `AND e.state IN (${marks(OPEN_EVENT)})) ORDER BY f.fleet_id`, FLEET.TRAVELLING, FLEET.RETREATING, T_ARRIVAL, ...OPEN_EVENT);
      return [r.length, ids(r, "fleet_id")];
    });
    check("refittingWithoutDeadline", SEVERITY.ERROR, [T.FLEETS, T.EVENTS], () => {
      const r = rows(`SELECT f.fleet_id FROM ${T.FLEETS} f WHERE f.state = ? AND NOT EXISTS (SELECT 1 FROM `
        + `${T.EVENTS} e WHERE e.${LIVE} AND e.event_type = ? AND e.aggregate_id = f.fleet_id `
        + `AND e.state IN (${marks(OPEN_EVENT)})) ORDER BY f.fleet_id`, FLEET.REFITTING, T_REFIT, ...OPEN_EVENT);
      return [r.length, ids(r, "fleet_id")];
    });
    check("materializedWithoutHunt", SEVERITY.ERROR, [T.FLEETS, T.HUNTS], () => {
      const r = rows(`SELECT f.fleet_id FROM ${T.FLEETS} f WHERE f.state = ? AND NOT EXISTS (SELECT 1 FROM `
        + `${T.HUNTS} h WHERE h.fleet_id = f.fleet_id AND h.state IN (${marks(PH.OPEN_STATES)})) ORDER BY f.fleet_id`,
      FLEET.MATERIALIZED, ...PH.OPEN_STATES);
      return [r.length, ids(r, "fleet_id")];
    });
    check("fleetInvariant", SEVERITY.ERROR, [T.FLEETS], () => {
      const bad = new Set();
      const sample = [];
      const byField = {};
      const hit = (fleetId, field) => {
        byField[field] = (byField[field] || 0) + 1;
        if (!bad.has(fleetId)) sample.push(`${fleetId}:${field}`);
        bad.add(fleetId);
      };
      for (const r of db.prepare(`SELECT fleet_id, state, operation_id, route_json, target_system_id, next_action_at, `
        + `ship_count FROM ${T.FLEETS} WHERE state <> ? ORDER BY fleet_id`).iterate(FLEET.DESTROYED)) {
        const v = checkFleetInvariants({ state: r.state, operationId: r.operation_id,
          route: r.route_json === null ? null : parseJson(r.route_json), targetSystemId: r.target_system_id,
          nextActionAt: r.next_action_at, shipCount: r.ship_count });
        if (!v.ok) hit(r.fleet_id, v.field);
      }
      for (const r of rows(`SELECT fleet_id FROM ${T.FLEETS} WHERE state = ? AND ship_count <> 0 ORDER BY fleet_id`,
        FLEET.DESTROYED)) hit(r.fleet_id, "shipCount");
      const compositionOf = "json_each(CASE WHEN json_valid(f.composition_json) THEN f.composition_json ELSE '[]' END)";
      for (const r of rows(`SELECT fleet_id FROM ${T.FLEETS} f WHERE (f.ship_count <> (SELECT `
        + `coalesce(sum(CASE WHEN type = 'object' THEN json_extract(value, '$.count') END), 0) FROM ${compositionOf}) `
        + `OR EXISTS (SELECT 1 FROM ${compositionOf} WHERE type <> 'object')) AND json_valid(f.composition_json) `
        + "ORDER BY fleet_id")) {
        hit(r.fleet_id, "compositionSum");
      }
      return [bad.size, sample, { detail: { byField } }];
    });
    check("operationLinkBroken", SEVERITY.ERROR, [T.FLEETS, T.OPERATIONS], () => {
      const withOp = [FLEET.PLANNED, FLEET.TRAVELLING, FLEET.STAGED];
      const r = rows(`SELECT f.fleet_id FROM ${T.FLEETS} f LEFT JOIN ${T.OPERATIONS} o ON o.operation_id = `
        + `f.operation_id WHERE f.state IN (${marks(withOp)}) AND f.operation_id IS NOT NULL AND (o.operation_id IS NULL `
        + `OR o.state IN (${marks(TERMINAL_OPERATION_STATES)})) ORDER BY f.fleet_id`, ...withOp,
      ...TERMINAL_OPERATION_STATES);
      return [r.length, ids(r, "fleet_id")];
    });

    fromBattle("openBattleWithoutEvent", "openWithoutEvent");
    const staleBattles = (held) => rows(`SELECT battle_id FROM ${T.BATTLES} WHERE state IN (${marks(OPEN_NOT_LIVE)}) `
      + `AND coalesce(hold_reason, '') ${held ? "=" : "<>"} ? AND ? - max(updated_at, ?) > ? ORDER BY battle_id`,
    ...OPEN_NOT_LIVE, AWAITING_LIVE, refNow, boot, ctx.staleMs);
    check("staleOpenBattle", SEVERITY.ERROR, [T.BATTLES], () => {
      const r = staleBattles(false);
      return [r.length, ids(r, "battle_id")];
    });
    fromBattle("quarantinedBattles", "quarantined");
    check("quarantinedEvents", SEVERITY.ERROR, [T.EVENTS], () => {
      const byType = {};
      for (const r of rows(`SELECT event_type AS t, count(*) AS n FROM ${T.EVENTS} WHERE ${LIVE} AND state = ? GROUP BY event_type `
        + "ORDER BY event_type", EVENT_STATE.QUARANTINED)) byType[r.t] = r.n;
      const sample = ids(rows(`SELECT idempotency_key AS k FROM ${T.EVENTS} WHERE ${LIVE} AND state = ? ORDER BY event_id LIMIT ?`,
        EVENT_STATE.QUARANTINED, sampleMax), "k");
      return [campaign ? campaign.counts.quarantinedEvents : Object.values(byType).reduce((a, b) => a + b, 0), sample,
        { detail: { byType } }];
    });
    fromCampaign("occupationInvariantViolations", SEVERITY.ERROR);

    check("staleHeldBattle", SEVERITY.WARN, [T.BATTLES], () => {
      const r = staleBattles(true);
      return [r.length, ids(r, "battle_id")];
    });
    check("staleLiveBattle", SEVERITY.WARN, [T.BATTLES], () => {
      const r = rows(`SELECT battle_id FROM ${T.BATTLES} WHERE state = ? AND ? - max(updated_at, ?) > ? `
        + "ORDER BY battle_id", BATTLE_LIVE, refNow, boot, ctx.staleMs);
      return [r.length, ids(r, "battle_id")];
    });
    check("overdueEvents", SEVERITY.WARN, [T.EVENTS], () => {
      const limit = refNow - ctx.backlogLagMs;
      const byType = {};
      let n = 0;
      let oldest = null;
      for (const r of rows(`SELECT event_type AS t, count(*) AS n, min(due_at) AS d FROM ${T.EVENTS} `
        + `WHERE ${LIVE} AND state IN (${marks(WAITING_EVENT)}) AND due_at < ? GROUP BY event_type ORDER BY event_type`,
      ...WAITING_EVENT, limit)) {
        byType[r.t] = r.n;
        n += r.n;
        if (oldest === null || r.d < oldest) oldest = r.d;
      }
      return [n, Object.keys(byType), { detail: { oldestLagMs: oldest === null ? null : refNow - oldest, byType } }];
    });
    check("outboxFailed", SEVERITY.WARN, [T.JOURNAL], () => {
      const n = db.prepare(`SELECT count(*) AS n FROM ${T.JOURNAL} WHERE kind = ? AND state = ?`)
        .get(KIND_OUTBOX, STATE_FAILED).n;
      const sample = ids(rows(`SELECT idempotency_key AS k FROM ${T.JOURNAL} WHERE kind = ? AND state = ? `
        + "ORDER BY journal_id LIMIT ?", KIND_OUTBOX, STATE_FAILED, sampleMax), "k");
      return [n, sample];
    });
    check("outboxPendingOld", SEVERITY.WARN, [T.JOURNAL], () => {
      const limit = refNow - ctx.staleMs;
      const n = db.prepare(`SELECT count(*) AS n FROM ${T.JOURNAL} WHERE kind = ? AND state = ? AND created_at < ?`)
        .get(KIND_OUTBOX, STATE_PENDING, limit).n;
      const sample = ids(rows(`SELECT idempotency_key AS k FROM ${T.JOURNAL} WHERE kind = ? AND state = ? `
        + "AND created_at < ? ORDER BY journal_id LIMIT ?", KIND_OUTBOX, STATE_PENDING, limit, sampleMax), "k");
      return [n, sample];
    });
    check("periodicChainStopped", SEVERITY.WARN, [T.EVENTS], () => {
      if (PERIODIC_TYPES.length === 0) return [0, []];
      const r = rows(`SELECT event_type AS t FROM ${T.EVENTS} WHERE event_type IN (${marks(PERIODIC_TYPES)}) `
        + `GROUP BY event_type HAVING sum(state IN (${marks(OPEN_EVENT)})) = 0 ORDER BY event_type`,
      ...PERIODIC_TYPES, ...OPEN_EVENT);
      return [r.length, ids(r, "t"), r.length > 0 ? { note: "a disabled module legitimately produces this" } : {}];
    });
    check("operationWithoutFleets", SEVERITY.WARN, [T.FLEETS, T.OPERATIONS], () => {
      const r = rows(`SELECT o.operation_id FROM ${T.OPERATIONS} o WHERE o.state IN (${marks(OPEN_OPERATION_STATES)}) `
        + `AND NOT EXISTS (SELECT 1 FROM ${T.FLEETS} f WHERE f.operation_id = o.operation_id AND f.state <> ?) `
        + "ORDER BY o.operation_id", ...OPEN_OPERATION_STATES, FLEET.DESTROYED);
      return [r.length, ids(r, "operation_id")];
    });
    current = "campaignWarnings";
    fromCampaign("capturedOverLimit", SEVERITY.WARN,
      campaign ? campaign.details.capturedOverLimit.map((d) => d.factionId) : []);
    fromCampaign("coreViolations", SEVERITY.WARN);
    fromCampaign("fleetsOverLimit", SEVERITY.WARN);

    check("claimedEvents", SEVERITY.INFO, [T.EVENTS], () => {
      const n = db.prepare(`SELECT count(*) AS n FROM ${T.EVENTS} WHERE ${LIVE} AND state = ?`).get(EVENT_STATE.CLAIMED).n;
      return [n, [], n > 0 ? { note: "interrupted claims; startup recovers them (CLAIM_INTERRUPTED)" } : {}];
    });

    return { ok: true, findings, notes, integrity: { ok: integrity.ok } };
  } catch (err) {
    return { ok: false, reason: "CHECK_FAILED", check: current, detail: messageOf(err) };
  }
}

module.exports = { runAudit, runIntegrity, referenceTime, SEVERITY, NEGATIVE_SCALAR, NEGATIVE_ALLOWED, RESOURCE_JSON };
