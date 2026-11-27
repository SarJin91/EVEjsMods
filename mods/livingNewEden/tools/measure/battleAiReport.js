#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const S = require("./segments");

const { isNum, median, maxOf, counter, histogramP95, schedulerValues, segmentExitOk, UsageError } = S;

const RAID_TYPES = Object.freeze(["invasion", "raid", "gank", "reinforce", "patrol", "intercept"]);
const B_WIN = "B_WIN";

const COUNTER_NAMES = Object.freeze([
  "battle.contacts.assemblyDeferred",
  "battle.contacts.assemblyReadFailed",
  "battle.contacts.assemblySuperseded",
  "battle.contacts.assemblyRoundsExhausted",
  "battle.contacts.enqueueRefused",
  "battle.contacts.declined",
  "battle.contacts.declineFleetsRetreated",
  "battle.contacts.declineStuck",
  "battle.contacts.declineNoPower",
  "strategy.attackLoss.recorded",
  "strategy.attackLoss.cooldowns",
  "strategy.attackLoss.evicted",
  "strategy.attackLoss.limit",
  "strategy.attackLoss.blocked",
  "strategy.attackLoss.requiredRaised",
  "strategy.attackLoss.iskGateBlocked",
  "strategy.review.launches",
  "strategy.review.mobilized",
  "strategy.review.noHulls",
]);

const HISTOGRAM_NAMES = Object.freeze(["strategy.decideMs", "strategy.reviewReadMs"]);

const LOG_PATTERNS = Object.freeze({
  logErrors: / error|TX_FAILED/,
  logRowLimit: /TX_ROW_LIMIT/,
  logAttackLossFailed: /ATTACK_LOSS_WRITE_FAILED|ATTACK_LOSS_THREW/,
});

const THRESHOLDS = Object.freeze({
  noiseFactor: 2,
  minBand: 2,
  c1: Object.freeze({ minCheckRuns: 3, logErrorsSlack: 2,
    zeroCounters: Object.freeze(["battle.contacts.assemblyReadFailed", "battle.contacts.declineNoPower"]) }),
  c2: Object.freeze({ passFactor: 1.25, passSlackMs: 2, latenessFactor: 1.25, latenessSlackMs: 2000,
    decideFactor: 1.25, decideSlackMs: 2, decideHistogram: "strategy.decideMs" }),
  c3: Object.freeze({ capturesLowRel: 0.40, capturesHighRel: 0.50, battlesLowRel: 0.50, battlesHighRel: 0.50,
    lostPostsFactor: 1.1, lostPostsSlack: 2 }),
  asm: Object.freeze({ counter: "battle.contacts.assemblyDeferred", minBase: 10, minDrop: 0.15 }),
  mem: Object.freeze({ counters: Object.freeze(["strategy.attackLoss.recorded", "strategy.attackLoss.blocked"]),
    minRepeat: 3, rel: 0.30 }),
  dec: Object.freeze({ counter: "battle.contacts.declined", retreated: "battle.contacts.declineFleetsRetreated",
    stuck: "battle.contacts.declineStuck", maxStuckShare: 0.5 }),
  isk: Object.freeze({ counter: "strategy.attackLoss.iskGateBlocked", launches: "strategy.review.launches",
    launchesRel: 0.40 }),
});

const FLAGS = Object.freeze([
  Object.freeze(["assembly", "asm", "base"]),
  Object.freeze(["memory", "mem", "asm"]),
  Object.freeze(["decline", "dec", "mem"]),
  Object.freeze(["iskGate", "isk", "dec"]),
]);

const USAGE = "usage: node mods/livingNewEden/tools/measure/battleAiReport.js --variant <name>=<dir> [--variant ...] "
  + "--base <name> --noise <name> [--asm <name>] [--mem <name>] [--dec <name>] [--isk <name>] [--json <file>]";

function splitName(full) {
  const i = full.indexOf(".");
  return [full.slice(0, i), full.slice(i + 1)];
}

const numOr0 = (v) => (isNum(v) ? v : 0);

function summarize(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.days) || input.days.length === 0) {
    return { ok: false, reason: "INVALID_INPUT", detail: "days" };
  }
  const segs = [...input.days].sort((a, b) => a.index - b.index);
  for (const d of segs) {
    if (!d || !Number.isSafeInteger(d.index) || !isNum(d.startVirtualAt) || !isNum(d.stopVirtualAt)
      || d.stopVirtualAt < d.startVirtualAt) {
      return { ok: false, reason: "INVALID_INPUT", detail: `segment ${d && d.index}` };
    }
  }
  const from = segs[0].startVirtualAt;
  const to = segs[segs.length - 1].stopVirtualAt;
  const contiguous = segs.every((d, i) => d.index === i + 1);
  const out = { ok: true, windowMs: to - from, segments: segs.length,
    exitOk: contiguous && segs.every(segmentExitOk), checks: { runs: 0, pass: 0, fail: 0, error: 0 },
    battles: 0, raidBattles: 0, raidBWin: 0, shipsLost: 0, raidShipsLostA: 0, captures: 0, lostPosts: 0,
    recaptures: { total: 0, home: 0, other: 0 }, grinders: 0, repeatLosses: 0, piecemeal: null, counters: {},
    histogramsP95Max: {}, passP95MsMedian: null, latenessP95MsMedian: null, logErrors: 0, logRowLimit: 0,
    logAttackLossFailed: 0 };
  for (const b of input.battles || []) {
    if (!b || !isNum(b.createdAt) || b.createdAt < from || b.createdAt >= to) continue;
    out.battles += 1;
    out.shipsLost += numOr0(b.shipsLost);
    if (typeof b.operationTypeA === "string" && RAID_TYPES.includes(b.operationTypeA)) {
      out.raidBattles += 1;
      if (b.outcome === B_WIN) out.raidBWin += 1;
      out.raidShipsLostA += numOr0(b.shipsLostA);
    }
  }
  for (const c of input.captures || []) {
    if (c && isNum(c.capturedAt) && c.capturedAt >= from && c.capturedAt < to) out.captures += 1;
  }
  const odds = input.odds && typeof input.odds === "object" ? input.odds : {};
  const grinders = Array.isArray(odds.grinders) ? odds.grinders : [];
  out.grinders = grinders.length;
  out.repeatLosses = grinders.reduce((s, g) => s + numOr0(g && g.bWins), 0);
  const v2 = odds.piecemealV2;
  if (v2 && typeof v2 === "object" && isNum(v2.base)) {
    const first = v2.firstOutcome || {};
    out.piecemeal = { base: v2.base, cases: numOr0(v2.cases), share: isNum(v2.share) ? v2.share : null,
      firstBWinPiecemeal: numOr0(first.piecemeal && first.piecemeal[B_WIN]),
      firstBWinWhole: numOr0(first.whole && first.whole[B_WIN]) };
  }
  const occ = input.occupation && typeof input.occupation === "object" ? input.occupation : {};
  out.lostPosts = numOr0(occ.lostPosts && occ.lostPosts.total);
  if (occ.recaptures) {
    out.recaptures = { total: numOr0(occ.recaptures.total), home: numOr0(occ.recaptures.home),
      other: numOr0(occ.recaptures.other) };
  }
  for (const name of COUNTER_NAMES) out.counters[name] = 0;
  for (const name of HISTOGRAM_NAMES) out.histogramsP95Max[name] = null;
  const passAll = [];
  const lateAll = [];
  for (const d of segs) {
    const c = d.report && d.report.checks ? d.report.checks : {};
    for (const k of ["runs", "pass", "fail", "error"]) out.checks[k] += numOr0(c[k]);
    out.logErrors += numOr0(d.logErrors);
    out.logRowLimit += numOr0(d.logRowLimit);
    out.logAttackLossFailed += numOr0(d.logAttackLossFailed);
    for (const name of COUNTER_NAMES) out.counters[name] += counter(d.telemetry, ...splitName(name));
    for (const name of HISTOGRAM_NAMES) {
      out.histogramsP95Max[name] = maxOf([out.histogramsP95Max[name], histogramP95(d.telemetry, ...splitName(name))]);
    }
    passAll.push(...schedulerValues(d.status, "passP95Ms"));
    lateAll.push(...schedulerValues(d.status, "latenessP95Ms"));
  }
  out.passP95MsMedian = median(passAll);
  out.latenessP95MsMedian = median(lateAll);
  Object.assign(out, S.deferredMark(segs.map((d) => d.telemetry)));
  return out;
}

function recapturesOf(entries, homeOf) {
  const home = (id) => {
    if (typeof homeOf === "function") return homeOf(id);
    if (homeOf instanceof Map) return homeOf.has(id) ? homeOf.get(id) : null;
    return homeOf && Object.prototype.hasOwnProperty.call(homeOf, id) ? homeOf[id] : null;
  };
  const controller = new Map();
  const lost = new Map();
  const out = { total: 0, home: 0, other: 0 };
  for (const e of entries || []) {
    if (!e) continue;
    let p = e.payload;
    if (typeof p === "string") {
      try {
        p = JSON.parse(p);
      } catch (_err) {
        continue;
      }
    }
    const st = p && p.state && typeof p.state === "object" ? p.state : null;
    if (st === null || !Object.prototype.hasOwnProperty.call(st, "controllerFactionId")) continue;
    const id = String(e.aggregateId);
    const before = controller.has(id) ? controller.get(id) : null;
    const after = st.controllerFactionId === undefined ? null : st.controllerFactionId;
    controller.set(id, after);
    if (after === before) continue;
    if (!lost.has(id)) lost.set(id, new Set());
    const set = lost.get(id);
    if (before !== null) set.add(before);
    if (after !== null && set.has(after)) {
      set.delete(after);
      out.total += 1;
      const h = home(id);
      if (h !== null && h !== undefined && Number(h) === Number(after)) out.home += 1;
      else out.other += 1;
    }
  }
  return out;
}

const counterOf = (s, name) => numOr0(s.counters && s.counters[name]);

function gate(blocking) {
  return { pass: true, blocking, detail: [] };
}

function fail(g, line) {
  g.pass = false;
  g.detail.push(`FAIL ${line}`);
}

function note(g, line) {
  g.detail.push(line);
}

function inconclusive(g, line) {
  g.pass = false;
  g.inconclusive = true;
  g.detail.push(`INCONCLUSIVE ${line}`);
}

const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(3))) : "-");

function gateC1(V, base, T) {
  const g = gate(true);
  if (!V.exitOk) fail(g, "exitOk false (a segment without report, with report.error or exit != 0)");
  if (V.checks.runs < T.c1.minCheckRuns) fail(g, `checks.runs=${V.checks.runs} < ${T.c1.minCheckRuns}`);
  if (V.checks.fail !== 0 || V.checks.error !== 0) fail(g, `checks fail=${V.checks.fail} error=${V.checks.error}`);
  if (V.logErrors > base.logErrors + T.c1.logErrorsSlack) {
    fail(g, `logErrors=${V.logErrors} > base=${base.logErrors} + ${T.c1.logErrorsSlack}`);
  }
  if (V.logRowLimit > base.logRowLimit) fail(g, `logRowLimit=${V.logRowLimit} > base=${base.logRowLimit}`);
  if (V.logAttackLossFailed !== 0) fail(g, `logAttackLossFailed=${V.logAttackLossFailed} != 0`);
  for (const name of T.c1.zeroCounters) if (counterOf(V, name) !== 0) fail(g, `${name}=${counterOf(V, name)} != 0`);
  note(g, `checks r/p/f/e ${V.checks.runs}/${V.checks.pass}/${V.checks.fail}/${V.checks.error}; logErrors `
    + `${V.logErrors} (base ${base.logErrors}); logRowLimit ${V.logRowLimit} (base ${base.logRowLimit})`);
  return g;
}

function gateC2(V, P, T) {
  const g = gate(true);
  const line = (label, v, p, factor, slack) => {
    const limit = isNum(p) ? factor * p + slack : null;
    const text = `${label}=${fmt(v)} <= ${fmt(limit)} (P ${fmt(p)})`;
    if (limit === null || !isNum(v)) fail(g, `${text} - no data`);
    else if (v > limit) fail(g, text);
    else note(g, text);
  };
  line("passP95MsMedian", V.passP95MsMedian, P.passP95MsMedian, T.c2.passFactor, T.c2.passSlackMs);
  line("latenessP95MsMedian", V.latenessP95MsMedian, P.latenessP95MsMedian, T.c2.latenessFactor,
    T.c2.latenessSlackMs);
  const h = T.c2.decideHistogram;
  line(`${h} p95 max`, V.histogramsP95Max[h], P.histogramsP95Max[h], T.c2.decideFactor, T.c2.decideSlackMs);
  return g;
}

function verdict(summaries, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const pick = (role) => (roles && typeof roles[role] === "string" && summaries && summaries[roles[role]]
    && summaries[roles[role]].ok === true ? summaries[roles[role]] : null);
  const base = pick("base");
  const noise = pick("noise");
  if (!base || !noise) return { ok: false, reason: "INVALID_INPUT", detail: `roles base/noise: ${JSON.stringify(roles)}` };
  const N = (m) => Math.abs(base[m] - noise[m]);
  const flags = {};
  let previousGo = true;
  for (const [flag, role, prevRole] of FLAGS) {
    const V = pick(role);
    const P = pick(prevRole);
    if (!V || !P) {
      const g = gate(true);
      inconclusive(g, `no variant ${!V ? role : prevRole}`);
      flags[flag] = { verdict: previousGo ? "INCONCLUSIVE" : "BLOCKED", gates: { E: g } };
      previousGo = false;
      continue;
    }
    const band = (m, rel) => Math.max(rel * P[m], T.noiseFactor * N(m), T.minBand);
    const c1 = gateC1(V, base, T);
    const c2 = gateC2(V, P, T);

    const c3 = gate(true);
    for (const [m, lowRel, highRel] of [["captures", T.c3.capturesLowRel, T.c3.capturesHighRel],
      ["battles", T.c3.battlesLowRel, T.c3.battlesHighRel]]) {
      const lo = P[m] - band(m, lowRel);
      const hi = P[m] + band(m, highRel);
      const text = `${m}=${V[m]} in [${fmt(lo)}, ${fmt(hi)}] (P ${P[m]}, base ${base[m]}, noise ${noise[m]})`;
      if (V[m] < lo || V[m] > hi) fail(c3, text);
      else note(c3, text);
    }
    const lostHi = Math.max(T.c3.lostPostsFactor * P.lostPosts, P.lostPosts + T.c3.lostPostsSlack,
      P.lostPosts + T.noiseFactor * N("lostPosts"));
    const lostText = `lostPosts=${V.lostPosts} <= ${fmt(lostHi)} (P ${P.lostPosts})`;
    if (V.lostPosts > lostHi) fail(c3, lostText);
    else note(c3, lostText);

    const e = gate(true);
    if (flag === "assembly") {
      const deferred = counterOf(V, T.asm.counter);
      if (deferred > 0) note(e, `${T.asm.counter}=${deferred}`);
      else fail(e, `${T.asm.counter}=0`);
      const pp = P.piecemeal;
      const pv = V.piecemeal;
      if (!pp || !pv || !isNum(pp.share) || !isNum(pv.share)) inconclusive(e, "piecemeal T4 v2: no data");
      else if (pp.base < T.asm.minBase) inconclusive(e, `piecemeal.base(P)=${pp.base} < ${T.asm.minBase}`);
      else {
        const nb = base.piecemeal && noise.piecemeal && isNum(base.piecemeal.share) && isNum(noise.piecemeal.share)
          ? Math.abs(base.piecemeal.share - noise.piecemeal.share) : 0;
        const limit = pp.share - Math.max(T.asm.minDrop, T.noiseFactor * nb);
        const text = `piecemeal share=${fmt(pv.share)} <= ${fmt(limit)} (P ${fmt(pp.share)}, base n=${pp.base})`;
        if (pv.share > limit) fail(e, text);
        else note(e, text);
      }
    } else if (flag === "memory") {
      for (const name of T.mem.counters) {
        if (counterOf(V, name) > 0) note(e, `${name}=${counterOf(V, name)}`);
        else fail(e, `${name}=0`);
      }
      if (P.repeatLosses < T.mem.minRepeat) inconclusive(e, `repeatLosses(P)=${P.repeatLosses} < ${T.mem.minRepeat}`);
      else {
        const limit = P.repeatLosses - Math.max(T.mem.rel * P.repeatLosses, T.noiseFactor * N("repeatLosses"));
        const text = `repeatLosses=${V.repeatLosses} <= ${fmt(limit)} (P ${P.repeatLosses}, grinders ${V.grinders})`;
        if (V.repeatLosses > limit) fail(e, text);
        else note(e, text);
      }
    } else if (flag === "decline") {
      const declined = counterOf(V, T.dec.counter);
      if (declined > 0) note(e, `${T.dec.counter}=${declined}`);
      else fail(e, `${T.dec.counter}=0`);
      const retreated = counterOf(V, T.dec.retreated);
      const stuck = counterOf(V, T.dec.stuck);
      const stuckText = `declineStuck=${stuck} <= ${T.dec.maxStuckShare} x (retreated ${retreated} + stuck ${stuck})`;
      if (stuck > T.dec.maxStuckShare * (retreated + stuck)) fail(e, stuckText);
      else note(e, stuckText);
      const limit = P.raidShipsLostA + T.noiseFactor * N("raidShipsLostA");
      const text = `raidShipsLostA=${V.raidShipsLostA} <= ${fmt(limit)} (P ${P.raidShipsLostA})`;
      if (V.raidShipsLostA > limit) fail(e, text);
      else note(e, text);
    } else {
      const blocked = counterOf(V, T.isk.counter);
      if (blocked > 0) note(e, `${T.isk.counter}=${blocked}`);
      else fail(e, `${T.isk.counter}=0`);
      const lv = counterOf(V, T.isk.launches);
      const lp = counterOf(P, T.isk.launches);
      const lb = counterOf(base, T.isk.launches);
      const ln = counterOf(noise, T.isk.launches);
      const lo = lp - Math.max(T.isk.launchesRel * lp, T.noiseFactor * Math.abs(lb - ln), T.minBand);
      const text = `launches=${lv} >= ${fmt(lo)} (P ${lp})`;
      if (lv < lo) fail(e, text);
      else note(e, text);
    }

    const r = gate(false);
    note(r, `recaptures total/home/other ${V.recaptures.total}/${V.recaptures.home}/${V.recaptures.other} `
      + `(P ${P.recaptures.total}/${P.recaptures.home}/${P.recaptures.other})`);

    const gates = { C1: c1, C2: c2, C3: c3, E: e, R: r };
    const hardFail = !c1.pass || !c2.pass || !c3.pass || (!e.pass && !e.inconclusive)
      || e.detail.some((d) => d.startsWith("FAIL "));
    let v;
    if (!previousGo) v = "BLOCKED";
    else if (hardFail) v = "NO_GO";
    else if (e.inconclusive) v = "INCONCLUSIVE";
    else v = "GO";
    flags[flag] = { verdict: v, gates };
    if (v !== "GO") previousGo = false;
  }
  return { flags };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseJsonOr(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function readOdds(dbFile, from, opts) {
  const { main: auditMain } = require("../battleOddsAudit");
  const lines = [];
  const code = auditMain({ argv: ["--db", dbFile, "--since", String(from), "--json"], print: (l) => lines.push(l),
    env: {}, ...(opts.config ? { config: opts.config } : {}),
    ...(opts.Database ? { driver: { ok: true, Database: opts.Database } } : {}) });
  const json = lines.map((l) => parseJsonOr(l, null)).filter((x) => x && typeof x === "object").pop();
  if (code !== 0 || !json || json.ok === false) {
    throw new Error(`battleOddsAudit exit ${code}: ${lines.slice(-2).join(" | ")}`);
  }
  return { grinders: Array.isArray(json.grinders) ? json.grinders : [], piecemealV2: json.piecemealV2 || null };
}

function operationTypeLookup(db) {
  const byFleet = new Map();
  if (hasTable(db, "world_operations")) {
    for (const o of db.prepare("SELECT operation_type, fleet_ids, planned_at FROM world_operations").all()) {
      const ids = parseJsonOr(o.fleet_ids, null);
      if (!Array.isArray(ids)) continue;
      for (const id of ids) {
        if (!byFleet.has(id)) byFleet.set(id, []);
        byFleet.get(id).push({ at: Number(o.planned_at), type: o.operation_type });
      }
    }
  }
  const viaFleet = db.prepare(`SELECT o.operation_type AS t FROM virtual_fleets f
    JOIN world_operations o ON o.operation_id = f.operation_id WHERE f.fleet_id = ?`);
  return (fleetId, at) => {
    let best = null;
    for (const x of byFleet.get(fleetId) || []) if (x.at <= at && (best === null || x.at > best.at)) best = x;
    if (best) return best.type;
    const r = viaFleet.get(fleetId);
    return r ? r.t : null;
  };
}

function readVariant(resultsDir, opts = {}) {
  const { db: dbFile, days, from, to } = S.readDays(resultsDir, LOG_PATTERNS);
  const odds = readOdds(dbFile, from, opts);
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const opType = operationTypeLookup(db);
    const firstA = db.prepare(`SELECT fleet_id, faction_id FROM battle_participants WHERE battle_id = ? AND side = 'A'
      ORDER BY fleet_id LIMIT 1`);
    const battles = db.prepare(`SELECT b.battle_id AS battleId, b.created_at AS createdAt, b.result_json AS result,
        (SELECT coalesce(sum(l.count), 0) FROM battle_losses l WHERE l.battle_id = b.battle_id) AS shipsLost,
        (SELECT coalesce(sum(l.count), 0) FROM battle_losses l JOIN battle_participants p
          ON p.battle_id = l.battle_id AND p.fleet_id = l.fleet_id
          WHERE l.battle_id = b.battle_id AND p.side = 'A') AS shipsLostA
      FROM battle_records b WHERE b.state = 'COMPLETED' AND b.created_at >= ? AND b.created_at < ?`).all(from, to)
      .map((r) => {
        const res = parseJsonOr(r.result, null);
        const a = firstA.get(r.battleId);
        const createdAt = Number(r.createdAt);
        return { createdAt, outcome: res && typeof res.outcome === "string" ? res.outcome : null,
          factionA: a ? Number(a.faction_id) : null, operationTypeA: a ? opType(a.fleet_id, createdAt) : null,
          shipsLost: Number(r.shipsLost), shipsLostA: Number(r.shipsLostA) };
      });
    const captures = db.prepare(`SELECT captured_at AS capturedAt FROM world_system_state
      WHERE captured_at IS NOT NULL AND captured_at >= ? AND captured_at < ?`).all(from, to)
      .map((r) => ({ capturedAt: Number(r.capturedAt) }));
    const entries = db.prepare(`SELECT aggregate_id AS aggregateId, payload FROM world_event_journal
      WHERE aggregate_type = 'world_system' AND state = 'APPLIED' AND created_at < ? ORDER BY journal_id`).all(to);
    const homes = new Map(db.prepare("SELECT system_id, home_faction_id FROM world_system_state").all()
      .map((r) => [String(r.system_id), r.home_faction_id === null ? null : Number(r.home_faction_id)]));
    const { replayOccupation } = require("../campaign/metrics");
    const occupation = { lostPosts: replayOccupation(entries, null).lostPosts, recaptures: recapturesOf(entries, homes) };
    return summarize({ days, battles, captures, odds, occupation });
  } finally {
    db.close();
  }
}

const ROLE_FLAGS = Object.freeze({ "--base": "base", "--noise": "noise", "--asm": "asm", "--mem": "mem",
  "--dec": "dec", "--isk": "isk" });

function parseArgs(argv) {
  const out = { variants: [], roles: {}, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--variant") {
      const m = typeof v === "string" ? /^([A-Za-z0-9_-]+)=(.+)$/.exec(v) : null;
      if (!m) throw new UsageError("--variant needs <name>=<dir>");
      if (out.variants.some((x) => x.name === m[1])) throw new UsageError(`--variant ${m[1]} twice`);
      out.variants.push({ name: m[1], dir: path.resolve(m[2]) });
    } else if (ROLE_FLAGS[a]) {
      if (typeof v !== "string" || v === "") throw new UsageError(`${a} needs a variant name`);
      out.roles[ROLE_FLAGS[a]] = v;
    } else if (a === "--json") {
      if (typeof v !== "string" || v === "") throw new UsageError("--json needs a file");
      out.json = path.resolve(v);
    } else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.variants.length === 0) throw new UsageError("at least one --variant");
  for (const role of ["base", "noise"]) if (!out.roles[role]) throw new UsageError(`--${role} is required`);
  for (const [role, name] of Object.entries(out.roles)) {
    if (!out.variants.some((x) => x.name === name)) throw new UsageError(`--${role} ${name} is not a --variant`);
  }
  return out;
}

const fmtCell = (v) => (v === null || v === undefined ? "-" : String(v));

const TABLE_HEAD = ["variant", "exitOk", "checks r/p/f/e", "battles", "raid/B_WIN", "shipsLost", "raidLostA",
  "captures", "lostPosts", "recapt t/h/o", "grinders/repeat", "piecemeal base/cases/share", "deferred", "declined",
  "alRecorded/blocked", "iskBlocked", "launches", "logErr/rowLimit/alFail", "passP95 med", "lateP95 med",
  "decide p95"];

function rowOf(name, s) {
  const c = (k) => counterOf(s, k);
  const p = s.piecemeal;
  return [name, s.exitOk, `${s.checks.runs}/${s.checks.pass}/${s.checks.fail}/${s.checks.error}`, s.battles,
    `${s.raidBattles}/${s.raidBWin}`, s.shipsLost, s.raidShipsLostA, s.captures, s.lostPosts,
    `${s.recaptures.total}/${s.recaptures.home}/${s.recaptures.other}`, `${s.grinders}/${s.repeatLosses}`,
    p ? `${p.base}/${p.cases}/${fmt(p.share)}` : "-", c("battle.contacts.assemblyDeferred"),
    c("battle.contacts.declined"), `${c("strategy.attackLoss.recorded")}/${c("strategy.attackLoss.blocked")}`,
    c("strategy.attackLoss.iskGateBlocked"), c("strategy.review.launches"),
    `${s.logErrors}/${s.logRowLimit}/${s.logAttackLossFailed}`, fmtCell(s.passP95MsMedian),
    fmtCell(s.latenessP95MsMedian), fmtCell(s.histogramsP95Max["strategy.decideMs"])];
}

function markdown(r) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const x of r.results) lines.push(`| ${rowOf(x.name, x.summary).join(" | ")} |`);
  const v = r.verdict;
  if (!v || !v.flags) {
    lines.push("", `verdict: ${v ? `${v.reason} ${v.detail || ""}` : "-"}`);
    return lines.join("\n");
  }
  lines.push("", "| flag | verdict | gate | pass | blocking | detail |", "|---|---|---|---|---|---|");
  for (const [flag, f] of Object.entries(v.flags)) {
    for (const [g, x] of Object.entries(f.gates)) {
      lines.push(`| ${flag} | ${f.verdict} | ${g} | ${x.pass ? "PASS" : "FAIL"} | ${x.blocking ? "yes" : "no"} | `
        + `${x.detail.join("; ")} |`);
    }
  }
  return lines.join("\n");
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
    for (const v of args.variants) S.segmentsOf(v.dir);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`battleAiReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const summaries = {};
  const results = [];
  for (const v of args.variants) {
    let summary;
    try {
      summary = readVariant(v.dir, { Database: io.Database, config: io.config });
    } catch (e) {
      err(`battleAiReport: ${v.name}: read failed - ${(e && e.message) || e}`);
      return 2;
    }
    if (!summary.ok) {
      err(`battleAiReport: ${v.name}: ${summary.reason} ${summary.detail || ""}`.trim());
      return 2;
    }
    summaries[v.name] = summary;
    results.push({ name: v.name, summary });
  }
  const verdictValue = verdict(summaries, args.roles);
  out(markdown({ results, verdict: verdictValue }));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ roles: args.roles, thresholds: THRESHOLDS,
      variants: Object.fromEntries(results.map((x) => [x.name, x.summary])), verdict: verdictValue }, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize, verdict, recapturesOf, readVariant, parseArgs, main, markdown, THRESHOLDS,
  COUNTER_NAMES, RAID_TYPES };
