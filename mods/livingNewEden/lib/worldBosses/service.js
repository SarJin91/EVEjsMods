"use strict";

const { createAbortSentinel } = require("../persistence/store");
const { createRng, deriveSeed } = require("../util/rng");
const S = require("./schema");
const M = require("./machine");
const C = require("./clash");
const L = require("./live");
const { createRewards } = require("./rewards");
const { createWorldBossPayoutPump } = require("./payouts");
const { hintLinesOf } = require("./hints");

const COUNTER_NAMES = Object.freeze(["rolls", "rollSkipped", "spawned", "spawnRefused", "moves", "arrivals", "blight",
  "blightSkipped", "blightRefused", "beaconRefused", "expired", "cancelled", "casLost", "listenerErrors", "pruned",
  "passErrors",
  "clashes", "clashRefused", "clashDropped", "clashTruncated", "clashNoEnemy", "damageApplied", "staleDamage",
  "phaseCleared", "defeated",
  "liveStarted", "liveEnded", "liveShips", "liveLost", "liveLostUnseen", "liveRefusedBudget", "liveRefusedProfile",
  "liveRecovered", "liveParticipantsOverflow", "liveHolds", "etaMails", "etaSkipped",
  "liveSpawnRetry", "liveExitUnspawnable",
  "rewardPlaced", "rewardSkipped", "rewardFailed", "rewardReleased", "payoutsPaid", "payoutsFailed", "payoutsPruned",
  "gmRegistered", "gmRefused", "gmAbsent", "hintRefused", "endsReplayed"]);
const TERMINAL_BATTLE_STATES = Object.freeze(["COMPLETED", "FAILED", "QUARANTINED"]);
const CLASH_FLEET_STATES = Object.freeze(["IDLE", "STAGED"]);
const MODE = Object.freeze({ FULL: "running", DRAIN: "drain", STOPPED: "stopped" });
const OPEN_SCAN_LIMIT = 16;
const PRUNE_CLASS = "MAINTENANCE";
const PERMILLE = 1000;
const BLIGHT_REASON = "WORLD_BOSS_BLIGHT";

const CAS_ABORT = createAbortSentinel("worldBosses.CAS_LOST");
const STEP_ABORT = createAbortSentinel("worldBosses.STEP_FAILED");
const SAVEPOINT_ABORT = Symbol("worldBosses.SAVEPOINT_ABORT");

const messageOf = (err) => String((err && err.message) || err).slice(0, 200);
const isText = (v, max) => typeof v === "string" && v !== "" && v.length <= max;
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createWorldBossService(deps) {
  const { store, journal, repo, settings: P, kinds } = deps;
  const worldSeed = deps.worldSeed >>> 0;
  const telemetry = deps.telemetry || null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getter = (name) => (typeof deps[name] === "function" ? () => safe(deps[name], null) : () => null);
  const getGraph = getter("getGraph");
  const getPresence = getter("getPresence");
  const getOccupation = getter("getOccupation");
  const getSites = getter("getSites");
  const getWorldRepository = getter("getWorldRepository");
  const getGovernor = getter("getGovernor");
  const getBattle = getter("getBattle");
  const getFleetRepository = getter("getFleetRepository");
  const getNotices = getter("getNotices");
  const getScene = getter("getScene");
  const getWrecks = getter("getWrecks");
  const rewardCreditIsk = typeof deps.rewardCreditIsk === "function" ? deps.rewardCreditIsk
    : () => Promise.resolve({ ok: false, reason: "SEAM_UNAVAILABLE", permanent: false });
  let lastOpenRows = [];
  let replayed = false;
  const toldThisBoot = new Set();
  let payoutInFlight = false;
  const bootAt = Number.isSafeInteger(deps.bootAt) ? deps.bootAt : 0;
  const isHostile = typeof deps.isHostile === "function" ? deps.isHostile : () => false;
  const powerTable = deps.powerTable && typeof deps.powerTable === "object" ? deps.powerTable : {};
  const defeatedPending = new Set();

  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  const disabledKinds = Object.freeze([...(Array.isArray(deps.disabledKinds) ? deps.disabledKinds : [])]);
  const listeners = new Set();
  let mode = deps.mode === MODE.DRAIN ? MODE.DRAIN : MODE.FULL;
  let lastRolledBucket = null;
  let nextPruneAt = null;
  let lastPassAt = null;
  let lastRefusal = null;
  let openCount = null;
  const savepoints = new WeakMap();

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `worldBosses.${name}`, n);
  }

  function refuse(line) {
    lastRefusal = line;
    log(`refusal ${line}`);
  }

  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "SAVEPOINT_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT) return holder.refusal;
      if (tx.inTransaction !== true) throw err;
      return { ok: false, reason: "SAVEPOINT_FAILED", detail: messageOf(err) };
    }
  }

  const kindOn = (kind) => kinds.has(kind) && P.kinds.includes(kind);
  const enabledKinds = () => P.kinds.filter((k) => kinds.has(k));

  function hpPermilleOf(row) {
    const entry = kinds.get(row.kind);
    const def = entry ? entry.phases[row.phase - 1] : null;
    if (!def) return null;
    const max = Object.values(M.phaseUnits(def)).reduce((a, b) => a + b, 0);
    let units = {};
    try {
      units = JSON.parse(row.unitsJson);
    } catch (_err) {
      units = {};
    }
    const cur = Object.values(units).reduce((a, b) => a + (Number(b) || 0), 0);
    return max > 0 ? Math.floor((cur * PERMILLE) / max) : 0;
  }

  function viewOf(row) {
    const entry = kinds.get(row.kind);
    return Object.freeze({ bossId: row.bossId, kind: row.kind, factionId: row.factionId, originKind: row.originKind,
      originRef: row.originRef, state: row.state, mode: row.mode, phase: row.phase,
      phases: entry ? entry.phases.length : null, hpPermille: hpPermilleOf(row), systemId: row.systemId,
      nextSystemId: row.nextSystemId, regionId: row.regionId, nextDueAt: row.nextDueAt, visitNo: row.visitNo,
      hops: row.hops, createdAt: row.createdAt, expiresAt: row.expiresAt, endedAt: row.endedAt,
      endReason: row.endReason, topFactionId: row.topFactionId });
  }

  function endEventOf(row, outcome, replay) {
    return Object.freeze({ bossId: row.bossId, kind: row.kind, originKind: row.originKind, originRef: row.originRef,
      outcome, at: row.endedAt, systemId: row.systemId, topFactionId: row.topFactionId,
      ...(replay === true ? { replay: true } : {}) });
  }

  function emitEnds(events) {
    for (const e of events) {
      if (!replayed && e && e.replay !== true) toldThisBoot.add(e.bossId);
      for (const fn of [...listeners]) {
        try {
          fn(e);
        } catch (_err) {
          bump("listenerErrors");
        }
      }
    }
  }

  function beaconInTx(tx, bossId, visitNo, systemId, entry, expiresAt) {
    const sites = getSites();
    if (!sites || typeof sites.createSiteInTx !== "function") {
      bump("beaconRefused");
      return null;
    }
    const eventId = S.beaconEventIdOf(bossId, visitNo);
    const r = inSavepoint(tx, () => sites.createSiteInTx(tx, { eventId, slot: S.BEACON_SLOT, systemId,
      templateId: P.beaconTemplateId, label: entry.label, factionId: entry.factionId, expiresAt }));
    if (r && r.ok === true) return eventId;
    bump("beaconRefused");
    return null;
  }

  function cleanupInTx(tx, eventId, reason) {
    if (!eventId) return;
    const sites = getSites();
    if (!sites || typeof sites.cleanupSitesInTx !== "function") return;
    const r = inSavepoint(tx, () => sites.cleanupSitesInTx(tx, eventId, reason));
    if (!r || r.ok !== true) log(`beacon cleanup ${eventId} refused - ${(r && r.reason) || "no result"}`);
  }

  function blightInTx(tx, row, now) {
    const entry = kinds.get(row.kind);
    const permille = entry ? entry.phasePermille[row.phase - 1] : 0;
    const points = Math.floor((P.blightPoints * permille) / PERMILLE);
    const occupation = getOccupation();
    const worldRepo = getWorldRepository();
    if (!(points > 0) || !occupation || typeof occupation.dropInfluenceInTx !== "function" || !worldRepo
      || typeof worldRepo.getSystem !== "function") {
      bump("blightSkipped");
      return null;
    }
    const w = safe(() => worldRepo.getSystem(tx, row.systemId, { includeInfluence: false }), null);
    const controller = w && w.ok === true && w.system ? w.system.controllerFactionId : null;
    if (!isId(controller)) {
      bump("blightSkipped");
      return null;
    }
    const r = inSavepoint(tx, () => occupation.dropInfluenceInTx(tx, { systemId: row.systemId, factionId: controller,
      points, at: now, reason: BLIGHT_REASON, allowNonController: true }, S.keyBlight(row.bossId, row.visitNo)));
    if (!r || r.ok !== true) {
      bump("blightRefused");
      return null;
    }
    if (r.outcome !== "DUPLICATE") bump("blight");
    return { factionId: controller, points };
  }

  const asciiOf = (text) => String(text).replace(/[^\x20-\x7E]/g, "?");
  const nameOf = (graph, id) => {
    const sys = safe(() => graph.getSystem(id), null);
    return sys && typeof sys.name === "string" && sys.name !== "" ? asciiOf(sys.name) : `system ${id}`;
  };

  function etaInTx(tx, row, toSystemId, arriveAt, graph, entry, now) {
    if (!P.notices.enabled) return null;
    const presence = getPresence();
    const list = presence && typeof presence.listPresence === "function" ? safe(() => presence.listPresence(), [])
      : [];
    const dist = M.bfsFromMany(graph, [toSystemId], P.notices.radiusJumps, P.spawnMaxBfsSystems);
    const byCharacter = new Map();
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || !dist.has(p.systemId) || !Array.isArray(p.characters)) continue;
      for (const c of p.characters) {
        if (!c || !isId(c.characterId)) continue;
        const jumps = dist.get(p.systemId);
        if (!byCharacter.has(c.characterId) || byCharacter.get(c.characterId) > jumps) {
          byCharacter.set(c.characterId, jumps);
        }
      }
    }
    if (byCharacter.size === 0) return null;
    const recipients = [...byCharacter.entries()].sort((a, b) => a[1] - b[1] || a[0] - b[0])
      .slice(0, P.notices.maxRecipients);
    const notices = getNotices();
    if (!notices || typeof notices.enqueueItemsInTx !== "function") return { mails: 0, skipped: true };
    const label = asciiOf(entry ? entry.label : row.kind);
    const minutes = Math.max(0, Math.ceil((arriveAt - now) / 60000));
    const from = nameOf(graph, row.systemId);
    const to = nameOf(graph, toSystemId);
    const items = recipients.map(([characterId, jumps]) => ({ eventKey: S.keyEta(row.bossId, row.visitNo),
      characterId, kind: S.NOTICE_KIND, systemId: toSystemId, eventAt: now,
      line: `World boss ${label} leaves ${from} for ${to}, arrival in about ${minutes} min, ${jumps} jumps from you.`
        .slice(0, 400) }));
    const r = inSavepoint(tx, () => notices.enqueueItemsInTx(tx, items, now));
    return r && r.ok === true ? { mails: Number(r.inserted) || 0, skipped: false } : { mails: 0, skipped: true };
  }

  function transitionOrThrow(tx, spec, entry) {
    const r = repo.transitionInTx(tx, spec, entry);
    if (r.ok) return r;
    if (r.reason === "VERSION_CONFLICT") throw CAS_ABORT;
    refuse(`STEP ${spec.bossId} ${r.reason}${r.detail ? ` ${r.detail}` : ""}`);
    throw STEP_ABORT;
  }

  function endInTx(tx, row, to, reason, now, extraPatch) {
    cleanupInTx(tx, row.siteEventId, to === S.STATES.CANCELLED ? "EVENT_CANCELLED" : "EVENT_END");
    const liveOff = row.mode === S.MODES.LIVE ? { mode: S.MODES.VIRTUAL, liveSince: null, liveBootAt: null } : {};
    const r = transitionOrThrow(tx, { bossId: row.bossId, expectedVersion: row.version, from: row.state, to, now,
      patch: { ...(extraPatch || {}), ...liveOff, endedAt: now, endReason: reason, siteEventId: null,
        stepSeq: row.stepSeq + 1 } },
    { key: S.keyEnd(row.bossId), eventType: S.EVENT.ENDED, payload: { bossId: row.bossId, kind: row.kind,
      factionId: row.factionId, systemId: row.systemId, regionId: row.regionId, outcome: to, reason,
      topFactionId: row.topFactionId } });
    return { kind: "ended", outcome: to, event: r.duplicate || !r.row ? null : endEventOf(r.row, to) };
  }

  function stepInTx(tx, bossId, now) {
    const got = repo.getInTx(tx, bossId);
    if (!got.ok) {
      refuse(`STEP_READ ${bossId} ${got.reason}`);
      throw STEP_ABORT;
    }
    const row = got.row;
    if (!row || !S.OPEN_STATES.includes(row.state)) return { kind: "gone" };
    const d = M.decideStep(row, { now, openClashes: row.openClashes.length }, P);
    if (d.action === "NOOP") return { kind: "noop", ...(d.reason ? { waiting: d.reason } : {}) };
    const entry = kinds.get(row.kind) || null;
    const patch = {};
    const phaseDef = entry ? entry.phases[row.phase - 1] : null;
    if (phaseDef) {
      const regen = M.unitsAt({ units_json: row.unitsJson, hp_at: row.hpAt }, now, phaseDef, P);
      if (regen.changed) Object.assign(patch, { unitsJson: JSON.stringify(regen.units), hpAt: now });
    }
    if (d.action === "EXPIRE") return endInTx(tx, row, S.STATES.EXPIRED, d.reason, now, patch);
    const graph = getGraph();
    if (!graph) return { kind: "noop", waiting: "GRAPH_NOT_READY" };
    if (d.action === "DEPART" && row.mode === S.MODES.LIVE) {
      const cap = Number.isSafeInteger(row.liveSince) ? row.liveSince + P.live.maxMs : now;
      const hold = Math.min(now + P.live.moveHoldMs, cap);
      if (hold > now) {
        transitionOrThrow(tx, { bossId: row.bossId, expectedVersion: row.version, from: row.state, to: row.state, now,
          patch: { ...patch, nextDueAt: hold, stepSeq: row.stepSeq + 1 } },
        { key: S.keyLiveHold(row.bossId, row.stepSeq), eventType: S.EVENT.LIVE, payload: { bossId: row.bossId,
          action: "HOLD_DEPARTURE", nextDueAt: hold } });
        return { kind: "held" };
      }
    }
    if (d.action === "DEPART") {
      const blight = blightInTx(tx, row, now);
      const hop = M.chooseNextHop({ systemId: row.systemId, visited: row.visited, goalSystemId: row.goalSystemId,
        seed: row.seed, hops: row.hops }, graph, P);
      if (hop.systemId === null) return endInTx(tx, row, S.STATES.EXPIRED, S.END_REASONS.NO_NEIGHBOR, now, patch);
      cleanupInTx(tx, row.siteEventId, "EVENT_END");
      const visited = P.avoidRevisitHops > 0 ? [...row.visited, row.systemId].slice(-P.avoidRevisitHops) : [];
      transitionOrThrow(tx, { bossId: row.bossId, expectedVersion: row.version, from: S.STATES.DWELL,
        to: S.STATES.MOVING, now, patch: { ...patch, nextSystemId: hop.systemId, nextDueAt: d.nextDueAt,
          visitedJson: JSON.stringify(visited), siteEventId: null, stepSeq: row.stepSeq + 1 } },
      { key: S.keyStep(row.bossId, row.stepSeq), eventType: S.EVENT.MOVED, payload: { bossId: row.bossId,
        fromSystemId: row.systemId, toSystemId: hop.systemId, visitNo: row.visitNo, blight } });
      const eta = etaInTx(tx, row, hop.systemId, d.nextDueAt, graph, entry, now);
      return { kind: "moved", eta };
    }
    const to = row.nextSystemId;
    const sys = isId(to) ? graph.getSystem(to) : null;
    if (!sys) return endInTx(tx, row, S.STATES.EXPIRED, S.END_REASONS.NO_NEIGHBOR, now, patch);
    const visitNo = row.visitNo + 1;
    const goalSystemId = to === row.goalSystemId
      ? M.pickGoal({ fromSystemId: to, seed: deriveSeed(row.seed, S.RNG.GOAL, visitNo) }, graph, P).systemId
      : row.goalSystemId;
    const siteEventId = entry ? beaconInTx(tx, row.bossId, visitNo, to, entry, d.nextDueAt) : null;
    transitionOrThrow(tx, { bossId: row.bossId, expectedVersion: row.version, from: S.STATES.MOVING,
      to: S.STATES.DWELL, now, patch: { ...patch, systemId: to, nextSystemId: null, regionId: sys.regionId, visitNo,
        hops: row.hops + 1, dwellSince: now, nextDueAt: d.nextDueAt, goalSystemId, siteEventId,
        stepSeq: row.stepSeq + 1,
        nextClashAt: Number.isSafeInteger(P.clash.firstDelayMs) ? now + P.clash.firstDelayMs : null } },
    { key: S.keyStep(row.bossId, row.stepSeq), eventType: S.EVENT.ARRIVED, payload: { bossId: row.bossId,
      systemId: to, visitNo } });
    return { kind: "arrived" };
  }

  function spawnCoreInTx(tx, spec, now, keyOf) {
    const entry = kinds.get(spec.kind);
    if (!entry || !kindOn(spec.kind)) return { ok: false, reason: "KIND_OFF" };
    const graph = getGraph();
    if (!graph) return { ok: false, reason: "GRAPH_NOT_READY" };
    const count = repo.countOpenInTx(tx);
    if (!count.ok) return count;
    if (count.count >= P.maxActive) return { ok: false, reason: "BOSS_LIMIT" };
    const no = repo.nextBossNoInTx(tx);
    if (!no.ok) return no;
    const bossId = S.bossIdOf(no.bossNo, now);
    const seed = deriveSeed(worldSeed, S.RNG.SPAWN, bossId);
    let systemId = null;
    if (spec.systemId !== undefined && spec.systemId !== null) {
      systemId = M.isQualified(graph, spec.systemId, P) ? spec.systemId : null;
    } else {
      const presence = getPresence();
      const observed = presence && typeof presence.observedSystems === "function"
        ? safe(() => presence.observedSystems(), []) : [];
      systemId = M.pickSpawnSystem({ observed: Array.isArray(observed) ? observed : [], seed,
        regionId: spec.regionId === undefined ? null : spec.regionId }, graph, P).systemId;
    }
    const sys = isId(systemId) ? graph.getSystem(systemId) : null;
    if (!sys) return { ok: false, reason: "NO_SYSTEM" };
    const goal = M.pickGoal({ fromSystemId: systemId, seed: deriveSeed(seed, S.RNG.GOAL, 1) }, graph, P);
    const nextDueAt = now + P.dwellMs;
    const payload = { bossId, kind: spec.kind, factionId: entry.factionId, systemId, regionId: sys.regionId,
      originKind: spec.originKind };
    const made = inSavepoint(tx, () => {
      const siteEventId = beaconInTx(tx, bossId, 1, systemId, entry, nextDueAt);
      return repo.insertInTx(tx, { bossId, bossNo: no.bossNo, kind: spec.kind, factionId: entry.factionId,
        originKind: spec.originKind, originRef: spec.originRef === undefined ? null : spec.originRef, phase: 1,
        unitsJson: JSON.stringify(M.phaseUnits(entry.phases[0])), systemId, regionId: sys.regionId, visitNo: 1,
        visitedJson: "[]", goalSystemId: goal.systemId, seed, nextDueAt, siteEventId,
        expiresAt: now + P.maxLifetimeMs, now }, { key: keyOf(bossId), eventType: S.EVENT.SPAWNED, payload });
    });
    if (!made || made.ok !== true) return made || { ok: false, reason: "INSERT_FAILED" };
    return { ok: true, bossId, duplicate: made.duplicate === true };
  }

  function spawnInTx(tx, spec, key) {
    try {
      if (mode !== MODE.FULL) return { ok: false, reason: "WORLD_BOSSES_DISABLED" };
      if (!tx || tx.inTransaction !== true || !spec || typeof spec !== "object" || !isText(key, 200)
        || (spec.originKind !== S.ORIGIN_KINDS.SEASON && spec.originKind !== S.ORIGIN_KINDS.ADMIN)
        || !isText(spec.originRef, S.MAX_ORIGIN_REF_LENGTH) || !isText(spec.kind, S.MAX_KIND_LENGTH)
        || !Number.isSafeInteger(spec.at) || spec.at < 0
        || (spec.systemId !== undefined && spec.systemId !== null && !isId(spec.systemId))
        || (spec.regionId !== undefined && spec.regionId !== null && !isId(spec.regionId))) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const seen = repo.getByOriginInTx(tx, spec.originKind, spec.originRef);
      if (!seen.ok) return seen;
      if (seen.row) return { ok: true, bossId: seen.row.bossId, duplicate: true };
      const r = spawnCoreInTx(tx, spec, spec.at, () => key);
      if (r.ok) {
        if (!r.duplicate) bump("spawned");
      } else {
        bump("spawnRefused");
      }
      return r;
    } catch (err) {
      return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  }

  function rollInTx(tx, bucket, now) {
    const key = S.keyRoll(bucket);
    const seen = journal.findByKey(tx, key);
    if (!seen.ok) {
      refuse(`ROLL_READ ${seen.reason}`);
      throw STEP_ABORT;
    }
    if (seen.found) return { kind: "duplicate" };
    const rng = createRng(deriveSeed(worldSeed, S.RNG.ROLL, bucket));
    const hit = rng.nextUint32() % PERMILLE < P.rollChancePermille;
    const pickRoll = rng.nextUint32();
    const list = enabledKinds();
    let outcome = "MISS";
    let bossId = null;
    if (hit && list.length === 0) outcome = "NO_KIND";
    else if (hit) {
      const last = repo.lastEndedAtInTx(tx);
      if (!last.ok) throw STEP_ABORT;
      if (last.at !== null && now - last.at < P.cooldownMs) outcome = "COOLDOWN";
      else {
        const r = spawnCoreInTx(tx, { kind: list[pickRoll % list.length], originKind: S.ORIGIN_KINDS.ROLL,
          originRef: null }, now, (id) => S.keySpawn(id));
        if (r.ok) {
          outcome = "SPAWNED";
          bossId = r.bossId;
        } else if (r.reason === "GRAPH_NOT_READY") {
          return { kind: "waiting" };
        } else {
          outcome = r.reason;
        }
      }
    }
    const m = journal.applyOnce(tx, { key, aggregate: { type: S.JOURNAL_AGGREGATE, id: S.ROLL_AGGREGATE_ID },
      eventType: S.EVENT.ROLLED, payload: { bucket, outcome, bossId } }, () => true);
    if (!m.ok) {
      refuse(`ROLL_MARK ${m.reason}`);
      throw STEP_ABORT;
    }
    return { kind: "rolled", outcome, bossId };
  }

  function battleNow() {
    const b = getBattle();
    if (!b || typeof b.createFixedDefenseBattleInTx !== "function" || typeof b.getStatus !== "function") return null;
    const st = safe(() => b.getStatus(), null);
    return st && st.state === "ready" ? b : null;
  }

  function clashDue(row, at) {
    if (!P.clash.enabled || mode !== MODE.FULL || row.state !== S.STATES.DWELL || row.mode !== S.MODES.VIRTUAL) {
      return false;
    }
    const dueAt = row.nextClashAt !== null ? row.nextClashAt : row.dwellSince + P.clash.firstDelayMs;
    return at >= dueAt && at < row.nextDueAt && at < row.expiresAt;
  }

  function roundInTx(tx, bossId, at) {
    const got = repo.getInTx(tx, bossId);
    if (!got.ok) {
      refuse(`ROUND_READ ${bossId} ${got.reason}`);
      throw STEP_ABORT;
    }
    const row = got.row;
    if (!row || !clashDue(row, at)) return { kind: "noop" };
    const entry = kinds.get(row.kind) || null;
    const phaseDef = entry ? entry.phases[row.phase - 1] : null;
    const regen = phaseDef ? M.unitsAt({ units_json: row.unitsJson, hp_at: row.hpAt }, at, phaseDef, P)
      : { units: {}, changed: false };
    const fleetRepo = getFleetRepository();
    const battle = battleNow();
    let decision = { action: "UNAVAILABLE" };
    if (fleetRepo && typeof fleetRepo.listFleetsInSystem === "function" && battle) {
      const page = fleetRepo.listFleetsInSystem(tx, row.systemId, { states: [...CLASH_FLEET_STATES],
        limit: P.clash.maxFleetsRead + 1 });
      decision = page && page.ok === true && Array.isArray(page.fleets)
        ? C.decideClash(row, page.fleets, isHostile, { ...P.clash, powerTable })
        : { action: "READ_FAILED" };
    }
    let battleId = null;
    let refused = null;
    if (decision.action === "CLASH" || decision.action === "TRUNCATED") {
      const entries = C.buildEntries(row, entry, regen.units);
      if (entries.length === 0) refused = "NO_UNITS";
      else {
        const key = C.battleKeyOf({ bossId: row.bossId, visitNo: row.visitNo, round: row.clashRound,
          factionId: decision.factionId });
        const b = inSavepoint(tx, () => battle.createFixedDefenseBattleInTx(tx, { systemId: row.systemId, at,
          sideA: { factionId: decision.factionId, fleets: decision.fleets },
          fixedDefenses: { attackerRetreatLossPermille: P.clash.attackerRetreatLossPermille, entries } }, key));
        if (b && b.ok === true && typeof b.battleId === "string") battleId = b.battleId;
        else refused = String((b && b.reason) || "BATTLE_CREATE_FAILED");
      }
    }
    const patch = { nextClashAt: at + P.clash.intervalMs };
    if (regen.changed) Object.assign(patch, { unitsJson: JSON.stringify(regen.units), hpAt: at });
    if (battleId !== null) {
      Object.assign(patch, { openClashesJson: JSON.stringify([...new Set([...row.openClashes, battleId])]),
        clashRound: row.clashRound + 1 });
    }
    transitionOrThrow(tx, { bossId: row.bossId, expectedVersion: row.version, from: row.state, to: row.state, now: at,
      patch }, { key: S.keyRound(row.bossId, row.version), eventType: S.EVENT.ROUND, payload: { bossId: row.bossId,
      round: row.clashRound, action: decision.action, factionId: decision.factionId || null, battleId, refused } });
    return { kind: "round", action: decision.action, battleId, refused };
  }

  function sweepInTx(tx, bossId, at) {
    const got = repo.getInTx(tx, bossId);
    if (!got.ok) {
      refuse(`SWEEP_READ ${bossId} ${got.reason}`);
      throw STEP_ABORT;
    }
    const row = got.row;
    const battle = getBattle();
    const battles = battle && battle.repository && typeof battle.repository.getBattle === "function"
      ? battle.repository : null;
    if (!row || row.openClashes.length === 0 || !battles) return { kind: "noop" };
    const keep = [];
    let dropped = 0;
    row.openClashes.forEach((battleId, i) => {
      if (i >= P.clash.maxOpen) {
        keep.push(battleId);
        return;
      }
      const r = safe(() => battles.getBattle(tx, battleId), null);
      if (!r || r.ok !== true) keep.push(battleId);
      else if (!r.battle || TERMINAL_BATTLE_STATES.includes(r.battle.state)) dropped += 1;
      else keep.push(battleId);
    });
    if (dropped === 0) return { kind: "noop" };
    transitionOrThrow(tx, { bossId: row.bossId, expectedVersion: row.version, from: row.state, to: row.state,
      now: Math.max(at, row.updatedAt), patch: { openClashesJson: JSON.stringify(keep) } },
    { key: S.keySweep(row.bossId, row.version), eventType: S.EVENT.SWEPT, payload: { bossId: row.bossId, dropped } });
    return { kind: "swept", dropped };
  }

  function flushDefeated() {
    if (defeatedPending.size === 0) return;
    const ids = [...defeatedPending];
    defeatedPending.clear();
    const ends = [];
    for (const bossId of ids) {
      const r = store.transaction("worldBosses.defeated", (tx) => repo.getInTx(tx, bossId));
      const row = r.ok && r.value && r.value.ok === true ? r.value.row : null;
      if (row && row.state === S.STATES.DEFEATED) ends.push(endEventOf(row, S.STATES.DEFEATED));
    }
    emitEnds(ends);
  }

  const consequence = C.createConsequence({ repo, journal, kinds, settings: P,
    isActive: () => mode === MODE.FULL && P.clash.enabled === true, bump, cleanupInTx,
    onDefeated: (bossId) => defeatedPending.add(bossId) });

  const live = L.createLive({ store, repo, kinds, settings: P, bootAt, bump, refuse, cleanupInTx,
    onEnd: (row) => emitEnds([endEventOf(row, S.STATES.DEFEATED)]), getScene, getPresence, getSites, getGovernor,
    isActive: () => mode === MODE.FULL && P.live.enabled === true });

  const payoutPump = createWorldBossPayoutPump({ store, repo, settings: P, rewardCreditIsk, bump, log,
    isStopped: () => mode !== MODE.FULL, getGovernor });
  const rewards = createRewards({ store, journal, repo, kinds, settings: P, bump, refuse, cleanupInTx, getSites,
    getWrecks, notePayouts: (n) => payoutPump.notePlanned(n) });
  if (P.rewards.enabled && mode === MODE.FULL) payoutPump.boot();

  function replayEnds(now) {
    if (mode !== MODE.FULL || !(P.endReplayMs > 0)) return 0;
    const r = store.transaction("worldBosses.replay", (tx) => repo.listEndedSinceInTx(tx, now - P.endReplayMs,
      OPEN_SCAN_LIMIT));
    if (!r.ok || !r.value || r.value.ok !== true) {
      bump("passErrors");
      return null;
    }
    const events = r.value.rows.filter((row) => S.END_STATES.includes(row.state) && !toldThisBoot.has(row.bossId))
      .map((row) => endEventOf(row, row.state, true));
    emitEnds(events);
    bump("endsReplayed", events.length);
    return events.length;
  }

  function payoutPass(now) {
    if (payoutInFlight) return Promise.resolve({ ok: false, reason: "IN_FLIGHT" });
    payoutInFlight = true;
    return payoutPump.runPayoutPass(Number.isSafeInteger(now) ? now : 0)
      .catch(() => ({ ok: false, reason: "PASS_FAILED" }))
      .then((v) => {
        payoutInFlight = false;
        return v;
      });
  }

  function hintRead() {
    const graph = getGraph();
    const regionName = (id) => (graph && typeof graph.getRegionName === "function" ? graph.getRegionName(id) : null);
    return { lines: hintLinesOf(lastOpenRows, regionName, kinds) };
  }

  function compositionOf(row) {
    const entry = kinds.get(row.kind);
    const phaseDef = entry ? entry.phases[row.phase - 1] : null;
    if (!phaseDef) return [];
    let units = {};
    try {
      units = JSON.parse(row.unitsJson) || {};
    } catch (_err) {
      units = {};
    }
    const counts = new Map();
    for (const unit of phaseDef.units) {
      for (let n = 1; n <= unit.count; n += 1) {
        if (Number(units[`${unit.key}${n}`]) > 0) counts.set(unit.hullGroup, (counts.get(unit.hullGroup) || 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([hullGroup, count]) => ({ hullGroup, count }));
  }

  function bossTargetsOf(tx, reachSystemIds, max) {
    try {
      if (mode !== MODE.FULL) return { ok: false, reason: "WORLD_BOSSES_DISABLED" };
      const reach = new Set(Array.isArray(reachSystemIds) ? reachSystemIds : []);
      const limit = Number.isSafeInteger(max) && max > 0 ? max : 0;
      const r = repo.listOpenInTx(tx, OPEN_SCAN_LIMIT);
      if (!r.ok) return r;
      const items = [];
      let truncated = false;
      for (const row of r.rows) {
        const moving = row.state === S.STATES.MOVING;
        const systemId = moving ? row.nextSystemId : row.systemId;
        if (!isId(systemId) || !reach.has(systemId)) continue;
        if (items.length >= limit) {
          truncated = true;
          break;
        }
        items.push(Object.freeze({ bossId: row.bossId, kind: row.kind, factionId: row.factionId, state: row.state,
          systemId, arriveAt: moving ? row.nextDueAt : null,
          departAt: Number.isSafeInteger(row.nextDueAt) ? row.nextDueAt + (moving ? P.dwellMs : 0) : null,
          phase: row.phase,
          composition: Object.freeze(compositionOf(row)) }));
      }
      return { ok: true, items, truncated };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function clashPass(listed, at) {
    if (listed.openClashes.length > 0) {
      const v = runTx("worldBosses.sweep", (tx) => sweepInTx(tx, listed.bossId, at));
      if (v && v.kind === "swept") bump("clashDropped", v.dropped);
    }
    if (!clashDue(listed, at)) return;
    const v = runTx("worldBosses.round", (tx) => roundInTx(tx, listed.bossId, at));
    if (!v || v.kind !== "round") return;
    if (v.battleId !== null) bump("clashes");
    if (v.refused !== null) bump("clashRefused");
    if (v.action === "TRUNCATED") bump("clashTruncated");
    if (v.action === "NO_ENEMY") bump("clashNoEnemy");
  }

  function readOpen() {
    const r = store.transaction("worldBosses.read", (tx) => repo.listOpenInTx(tx, OPEN_SCAN_LIMIT));
    if (!r.ok || !r.value || r.value.ok !== true) return null;
    return r.value.rows;
  }

  function runTx(name, fn) {
    const r = store.transaction(name, fn);
    if (r.ok) return r.value;
    if (r.error === CAS_ABORT) bump("casLost");
    else {
      bump("passErrors");
      if (r.error !== STEP_ABORT) refuse(`${name} ${r.reason || "TX_FAILED"}${r.error ? ` ${messageOf(r.error)}` : ""}`);
    }
    return null;
  }

  function countEnd(v, ends) {
    if (!v || v.kind !== "ended" || !v.event) return;
    ends.push(v.event);
    bump(v.outcome === S.STATES.CANCELLED ? "cancelled" : "expired");
  }

  function drainPass(now) {
    const rows = readOpen();
    if (rows === null) {
      bump("passErrors");
      return null;
    }
    const ends = [];
    let left = 0;
    for (const listed of rows) {
      const v = runTx("worldBosses.drain", (tx) => {
        const got = repo.getInTx(tx, listed.bossId);
        if (!got.ok) throw STEP_ABORT;
        const row = got.row;
        if (!row || !S.OPEN_STATES.includes(row.state)) return { kind: "gone" };
        return endInTx(tx, row, S.STATES.CANCELLED, S.END_REASONS.DRAIN, now, null);
      });
      if (v === null) left += 1;
      countEnd(v, ends);
    }
    emitEnds(ends);
    return left + (rows.length >= OPEN_SCAN_LIMIT ? 1 : 0);
  }

  function prune(now) {
    if (nextPruneAt !== null && now < nextPruneAt) return;
    const governor = getGovernor();
    const admitted = !governor || typeof governor.admits !== "function"
      || safe(() => governor.admits(PRUNE_CLASS), true) !== false;
    if (!admitted) return;
    nextPruneAt = now + P.pruneEveryMs;
    const v = runTx("worldBosses.prune", (tx) => repo.pruneEndedInTx(tx, now - P.retentionMs, P.prunePerRun));
    if (v && v.ok) bump("pruned", v.deleted);
    else if (v) bump("passErrors");
  }

  function runPass(now) {
    if (mode === MODE.STOPPED) return { ok: false, reason: "WORLD_BOSSES_DISABLED" };
    const at = Number.isSafeInteger(now) ? now : 0;
    const t0 = nowMs();
    const out = { ok: true, rolled: 0, stepped: 0, ended: 0 };
    try {
      if (mode === MODE.DRAIN) {
        const left = drainPass(at);
        lastPassAt = at;
        if (left === 0) {
          log("drain done - no open boss left, service stops");
          stop();
        }
        return { ...out, mode: MODE.DRAIN, left };
      }
      flushDefeated();
      if (!replayed && replayEnds(at) !== null) {
        replayed = true;
        toldThisBoot.clear();
      }
      const rows = readOpen();
      if (rows === null) bump("passErrors");
      else lastOpenRows = rows;
      const ends = [];
      for (const listed of rows || []) {
        clashPass(listed, at);
        if (listed.nextDueAt > at && listed.expiresAt > at) continue;
        const v = runTx("worldBosses.step", (tx) => stepInTx(tx, listed.bossId, at));
        if (!v) continue;
        if (v.kind === "moved") {
          out.stepped += 1;
          bump("moves");
          if (v.eta) {
            bump("etaMails", v.eta.mails);
            if (v.eta.skipped) bump("etaSkipped");
          }
        } else if (v.kind === "held") {
          bump("liveHolds");
        } else if (v.kind === "arrived") {
          out.stepped += 1;
          bump("arrivals");
        } else if (v.kind === "ended") {
          out.ended += v.event ? 1 : 0;
          countEnd(v, ends);
        }
      }
      emitEnds(ends);
      if (P.rollEnabled) {
        const bucket = Math.floor(at / P.rollIntervalMs);
        if (bucket !== lastRolledBucket) {
          const v = runTx("worldBosses.roll", (tx) => rollInTx(tx, bucket, at));
          if (v && v.kind !== "waiting") {
            lastRolledBucket = bucket;
            if (v.kind === "rolled") {
              out.rolled += 1;
              bump("rolls");
              if (v.outcome === "SPAWNED") bump("spawned");
              else bump("rollSkipped");
            }
          }
        }
      }
      prune(at);
      if (P.rewards.enabled) {
        rewards.pass(at);
        rewards.releasePass(at);
        payoutPass(at);
      }
      const c = store.transaction("worldBosses.count", (tx) => repo.countOpenInTx(tx));
      if (c.ok && c.value && c.value.ok) {
        openCount = c.value.count;
        metric("gauge", "worldBosses.open", openCount);
      }
    } catch (err) {
      bump("passErrors");
      refuse(`PASS_THREW ${messageOf(err)}`);
    }
    lastPassAt = at;
    metric("observe", "worldBosses.passMs", nowMs() - t0);
    return out;
  }

  function getByOriginInTx(tx, originKind, originRef) {
    try {
      if (mode === MODE.STOPPED) return { ok: false, reason: "WORLD_BOSSES_DISABLED" };
      const r = repo.getByOriginInTx(tx, originKind, originRef);
      return r.ok ? { ok: true, boss: r.row ? viewOf(r.row) : null } : r;
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function listOpenInTx(tx) {
    try {
      if (mode === MODE.STOPPED) return { ok: false, reason: "WORLD_BOSSES_DISABLED" };
      const r = repo.listOpenInTx(tx, OPEN_SCAN_LIMIT);
      return r.ok ? { ok: true, items: r.rows.slice(0, Math.max(P.maxActive, 1)).map(viewOf) } : r;
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function addEndListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_INPUT" };
    listeners.add(fn);
    return { ok: true, remove: () => listeners.delete(fn) };
  }

  function getStatus() {
    return Object.freeze({ state: mode, open: openCount, lastRollBucket: lastRolledBucket, lastPassAt, lastRefusal,
      kinds: enabledKinds(), disabledKinds: disabledKinds, counters: Object.freeze({ ...counters }),
      ...(P.live.enabled ? { live: live.status() } : {}),
      ...(P.rewards.enabled ? { payouts: payoutPump.status() } : {}) });
  }

  function livePass(now) {
    try {
      live.pass(Number.isSafeInteger(now) ? now : 0);
      metric("gauge", "worldBosses.liveShipsNow", live.liveCount());
    } catch (err) {
      bump("passErrors");
      refuse(`LIVE_THREW ${messageOf(err)}`);
    }
  }

  function liveRecover(now) {
    try {
      return mode === MODE.FULL ? live.recover(Number.isSafeInteger(now) ? now : 0) : 0;
    } catch (err) {
      refuse(`LIVE_RECOVER_THREW ${messageOf(err)}`);
      return 0;
    }
  }

  function stop() {
    mode = MODE.STOPPED;
    safe(() => live.stopAll(), null);
  }

  return Object.freeze({ runPass, spawnInTx, getByOriginInTx, listOpenInTx, addEndListener, getStatus, stop,
    isStopped: () => mode === MODE.STOPPED, viewOf, bossTargetsOf, consequence, livePass, liveRecover,
    replayEnds, payoutPass, hintRead, count: (name) => bump(name), isFull: () => mode === MODE.FULL });
}

module.exports = { createWorldBossService, COUNTER_NAMES, MODE, OPEN_SCAN_LIMIT };
