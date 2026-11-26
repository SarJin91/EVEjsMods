"use strict";

const S = require("./schema");
const RR = require("./revengeRepository");
const { decideRevengeStart, REVENGE_SEC_CLASSES } = require("./revengePolicy");
const { slotLayout } = require("./plan");
const { escortsOf, slimNameOf } = require("./live");
const { BOSS_SPAWN } = require("./data/levels");
const { locateCharacter } = require("../playerHunt/pursuit");
const { decideHuntStep, PHASES } = require("../playerHunt/phases");
const { watchedBy } = require("../playerHunt/exit");
const { deriveSeed } = require("../util/rng");
const { isFameWantedId } = require("../fame/schema");

const REVENGE_COUNTER_NAMES = Object.freeze(["revengeCreated", "revengeSkippedOpen", "revengeCreateFailed",
  "revengeExpired", "revengeReady", "revengeWaitNotLocated", "revengeWaitNotInSpace", "revengeWaitSecClass",
  "revengeWaitRegion", "revengeWaitTooFar", "revengeWaitGraph", "revengeWaitCapsule", "revengePruned",
  "revengeRecovered",
  "revengeLive", "revengeSpawnFailed", "revengeNoAnchor", "revengeNoCommander", "revengeNoParams", "revengeDone",
  "revengeRetry", "revengeExpiredAttempts", "revengeHunterLost", "revengeEngaged", "revengeEndFailed",
  "revengeDisabled", "revengeLine", "revengeLineFailed",
  "revengeSceneGone",
  "revengeNemesisOff", "revengeNemesisNoSquad",
  "highsecStarted", "highsecSecurity", "highsecGateConcord", "highsecFull", "concordTimers", "concordSpawned",
  "concordSpawnRefused", "concordNoSpawn", "concordEnded"]);
const WAIT_COUNTERS = Object.freeze({ NOT_LOCATED: "revengeWaitNotLocated", NOT_IN_SPACE: "revengeWaitNotInSpace",
  SEC_CLASS: "revengeWaitSecClass", EXCLUDED_REGION: "revengeWaitRegion", GRAPH_NOT_READY: "revengeWaitGraph",
  TOO_FAR: "revengeWaitTooFar", CAPSULE: "revengeWaitCapsule" });
const REVENGE_READ_CAP = 4096;
const END_WINDOW = "WINDOW";
const MAX_DETAIL = 160;
const MAX_REASON = 32;

const HUNTER_ARCHETYPE = "HUNTER";
const HUNTER_ROLE = "hunter";
const GATE_INDEX_SPACE = 65536;
const MODE_SCAN = "SCAN";
const CONTACT_ENDS = Object.freeze(["WIPED", "RETREATED"]);
const END_DISABLED = "DISABLED";
const END_IDLE = "IDLE";
const END_SEAM_GONE = "SEAM_GONE";
const LINKED = "LINKED";
const GANG_FALLBACK = "the gang";
const REVENGE_HUNT_METHODS = Object.freeze(["readPlayerShips", "readShips", "readAggressors", "setSearch",
  "warpShips", "attackTargets"]);
const REVENGE_SCENE_METHODS = Object.freeze(["spawnGroup", "despawn", "markShips", "forgetShips"]);
const REVENGE_STEP_METHODS = Object.freeze(["createInTx", "noteKill", "readInTx", "load", "step", "status",
  "openCount", "onHunterKill", "residents", "isCommander", "stop", "adopt", "openFor",
  "createFameInTx", "noteFame"]);
const HUNT_PARAM_KEYS = Object.freeze(["gridRadiusMeters", "landingSpreadMeters", "scanCycleMs",
  "warpInDistanceMeters", "warpTimeoutMs", "reacquireGraceMs", "exitGraceMs"]);
const HIGHSEC = "highsec";
const FAME_HIGHSEC_SEC_CLASSES = Object.freeze([HIGHSEC, ...REVENGE_SEC_CLASSES]);
const CONCORD = Object.freeze({ NONE: "NONE", WAIT: "WAIT", FIGHT: "FIGHT", LEAVE: "LEAVE" });
const END_CONCORD = "CONCORD";

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const byDueThenId = (a, b) => a.dueAt - b.dueAt || (a.revengeId < b.revengeId ? -1 : a.revengeId > b.revengeId ? 1 : 0);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
function displaySecurity(s) { return Math.round(s * 10) / 10; }
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);
const distSq = (a, b) => ((a.x - b.x) * (a.x - b.x)) + ((a.y - b.y) * (a.y - b.y)) + ((a.z - b.z) * (a.z - b.z));
const ABSENT = Object.freeze({ state: "absent", ship: null });

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function revengeLineOf(nick, corpName) {
  const gang = typeof corpName === "string" && corpName.trim() !== "" ? corpName.trim() : GANG_FALLBACK;
  return nick ? `${nick} of ${gang} has found you. The gang wants its revenge.`
    : `Hunters of ${gang} have found you. The gang wants its revenge.`;
}

function createRevengeStep(deps) {
  const P = deps.settings;
  const { store, bump, log } = deps;
  const levels = deps.levels && typeof deps.levels === "object" ? deps.levels : {};
  const excludedRegions = deps.excludedRegions instanceof Set ? deps.excludedRegions : new Set();
  const open = new Map();
  const nextCheckAt = new Map();
  const readyNow = new Map();
  const squads = new Map();
  const orphans = new Map();
  let truncated = false;
  let seamLogged = false;
  let sceneGoneLogged = false;
  const H = deps.fameHighsec && typeof deps.fameHighsec === "object" ? deps.fameHighsec : null;
  const highsecOn = Boolean(H && H.enabled === true);
  const readyHighsec = new Set();
  let concordRefusedLogged = false;

  function forget(revengeId) {
    open.delete(revengeId);
    nextCheckAt.delete(revengeId);
    readyNow.delete(revengeId);
    readyHighsec.delete(revengeId);
  }

  const secClassesOf = (row) => (highsecOn && row && isFameWantedId(row.wantedId) ? FAME_HIGHSEC_SEC_CLASSES
    : REVENGE_SEC_CLASSES);
  const highsecLive = () => {
    let n = 0;
    for (const sq of squads.values()) if (sq.highsec === true) n += 1;
    return n;
  };
  const concordOf = () => safeCall(() => (typeof deps.getConcord === "function" ? deps.getConcord() : null), null);

  function apply(rows) {
    for (const r of rows) {
      if (S.REVENGE_OPEN_STATES.includes(r.state)) open.set(r.revengeId, r);
      else forget(r.revengeId);
    }
  }

  function readInTx(tx, now, recover) {
    const rec = recover ? RR.recoverRevengeLiveInTx(tx, now) : null;
    const list = RR.listOpenRevengeInTx(tx, REVENGE_READ_CAP + 1);
    const rows = list.ok ? list.rows : [];
    truncated = rows.length > REVENGE_READ_CAP;
    return { recovered: rec && rec.ok ? rec.recovered : 0, rows: rows.slice(0, REVENGE_READ_CAP) };
  }

  function load(rows) {
    const keep = new Map(nextCheckAt);
    const wasReady = new Map(readyNow);
    open.clear();
    nextCheckAt.clear();
    readyNow.clear();
    apply(rows);
    for (const [id, at] of keep) if (open.has(id)) nextCheckAt.set(id, at);
    for (const [id, systemId] of wasReady) if (open.has(id)) readyNow.set(id, systemId);
    for (const id of [...readyHighsec]) if (!readyNow.has(id)) readyHighsec.delete(id);
    if (truncated) {
      truncated = false;
      log(`revenge read cut at ${REVENGE_READ_CAP} open rows - the rest waits for a later read`);
    }
  }

  function createInTx(tx, target, killerId, at) {
    if (P.revengeEnabled !== true || !target || !(target.level >= P.revengeMinLevel)) return null;
    const journal = deps.journal;
    if (!journal || typeof journal.applyOnce !== "function") return { outcome: "failed", reason: "NO_JOURNAL" };
    const lay = slotLayout(target.gangSlot, P.gangMembers);
    if (!lay.ok) return { outcome: "failed", reason: "GANG" };
    const spec = { wantedId: target.wantedId, characterId: killerId, factionId: target.factionId, gangId: lay.gangId,
      bossCharacterId: target.characterId, targetLevel: target.level, killSystemId: target.systemId, killedAt: at,
      seed: deriveSeed(deps.worldSeed >>> 0, S.RNG_STREAM_REVENGE, target.wantedId), delayMs: P.revengeDelayMs,
      windowMs: P.revengeWindowMs };
    let j = null;
    try {
      j = journal.applyOnce(tx, { key: S.revengeJournalKeyOf(target.wantedId),
        aggregate: { type: S.REVENGE_AGGREGATE, id: S.revengeIdOf(target.wantedId) }, eventType: S.EVENT_REVENGE_SWORN,
        payload: { wantedId: target.wantedId, characterId: killerId, factionId: target.factionId, level: target.level,
          at } },
      (db) => {
        const r = RR.createRevengeInTx(db, spec, at);
        return r.ok && r.created ? r : { ok: false, reason: r.reason || "NOT_CREATED" };
      });
    } catch (err) {
      if (tx.inTransaction !== true) throw err;
      return { outcome: "failed", reason: messageOf(err) };
    }
    if (j && j.ok === true) {
      return j.duplicate !== true && j.value && j.value.revenge ? { outcome: "created", revenge: j.value.revenge }
        : { outcome: "duplicate" };
    }
    const why = j && j.refusal ? j.refusal.reason : null;
    if (why === "OPEN_EXISTS") return { outcome: "skippedOpen" };
    if (why === "DUPLICATE") return { outcome: "duplicate" };
    return { outcome: "failed", reason: String(why || (j && j.reason) || "no_result") };
  }

  function noteKill(res, wantedId) {
    if (!res) return;
    if (res.outcome === "created") {
      apply([res.revenge]);
      bump("revengeCreated");
    } else if (res.outcome === "skippedOpen") {
      bump("revengeSkippedOpen");
    } else if (res.outcome === "failed") {
      bump("revengeCreateFailed");
      log(`revenge for ${wantedId} refused - ${res.reason}`);
    }
  }

  function createFameInTx(tx, spec, gang) {
    const journal = deps.journal;
    if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
      return { outcome: "failed", reason: "NO_JOURNAL" };
    }
    if (!spec || !isFameWantedId(spec.wantedId) || !gang) return { outcome: "failed", reason: "INVALID_INPUT" };
    const row = { wantedId: spec.wantedId, characterId: spec.characterId, factionId: spec.factionId,
      gangId: gang.gangId, bossCharacterId: gang.bossCharacterId, targetLevel: spec.level, killSystemId: spec.systemId,
      killedAt: spec.at, seed: deriveSeed(deps.worldSeed >>> 0, S.RNG_STREAM_FAME, spec.wantedId),
      delayMs: spec.delayMs, windowMs: spec.windowMs };
    const key = S.revengeJournalKeyOf(spec.wantedId);
    let j = null;
    try {
      const f = journal.findByKey(tx, key);
      if (!f || f.ok !== true) return { outcome: "failed", reason: String((f && f.reason) || "no_result") };
      if (f.found === true) return { outcome: "duplicate" };
      j = journal.applyOnce(tx, { key,
        aggregate: { type: S.REVENGE_AGGREGATE, id: S.revengeIdOf(spec.wantedId) }, eventType: S.EVENT_REVENGE_SWORN,
        payload: { wantedId: spec.wantedId, characterId: spec.characterId, factionId: spec.factionId,
          level: spec.level, at: spec.at } },
      (db) => {
        const r = RR.createRevengeInTx(db, row, spec.at);
        return r.ok && r.created ? r : { ok: false, reason: r.reason || "NOT_CREATED" };
      });
    } catch (err) {
      if (tx.inTransaction !== true) throw err;
      return { outcome: "failed", reason: messageOf(err) };
    }
    if (j && j.ok === true) {
      return j.duplicate !== true && j.value && j.value.revenge ? { outcome: "created", revenge: j.value.revenge }
        : { outcome: "duplicate" };
    }
    const why = j && j.refusal ? j.refusal.reason : null;
    if (why === "OPEN_EXISTS") return { outcome: "skippedOpen" };
    if (why === "DUPLICATE") return { outcome: "duplicate" };
    return { outcome: "failed", reason: String(why || (j && j.reason) || "no_result") };
  }

  function noteFame(res, wantedId) {
    if (!res) return;
    if (res.outcome === "created") {
      apply([res.revenge]);
      bump("fameCreated");
    } else if (res.outcome === "skippedOpen") {
      bump("fameSkippedOpen");
    } else if (res.outcome === "failed") {
      bump("fameFailed");
      log(`fame bounty ${wantedId} refused - ${res.reason}`);
    }
  }

  function factsOf(row, presence, graph, now) {
    const located = presence ? locateCharacter(presence, row.characterId) : null;
    const system = located && graph ? safeCall(() => graph.getSystem(located.systemId), null) : null;
    let route = null;
    if (located && located.state === "space" && system && secClassesOf(row).includes(system.secClass)
      && !excludedRegions.has(system.regionId) && graph && typeof graph.findRoute === "function") {
      route = safeCall(() => graph.findRoute(row.killSystemId, located.systemId, { maxJumps: P.revengeMaxJumps }), null);
    }
    return { now, located, system: system ? { secClass: system.secClass, regionId: system.regionId,
      security: system.security } : null, route, capsule: null };
  }

  function expireStep(now) {
    const due = [...open.values()].filter((r) => r.state === S.REVENGE_STATES.WAITING && r.expiresAt <= now)
      .sort(byDueThenId).slice(0, P.revengeChecksPerPass);
    if (due.length === 0) return 0;
    const res = safeCall(() => store.transaction("bounty.revenge", (tx) => {
      const changes = [];
      const hooks = [];
      let lost = 0;
      for (const r of due) {
        const e = RR.expireRevengeInTx(tx, r, END_WINDOW, now);
        if (e.ok) {
          changes.push(e.revenge);
          const h = hookInTx(tx, e.revenge, outcomeOf(r, e.revenge, { reason: END_WINDOW, engaged: false }), now);
          if (h) hooks.push(h);
        } else {
          lost += 1;
        }
      }
      return { changes, lost, hooks };
    }), null);
    if (!res || res.ok !== true) {
      bump("errors");
      log(`revenge expire refused - ${String((res && res.reason) || "no_result")}`
        + `${res && res.error ? ` ${messageOf(res.error)}` : ""}`);
      return 0;
    }
    apply(res.value.changes);
    for (const h of res.value.hooks) safeCall(() => deps.onRevengeEndCommitted(h), null);
    bump("revengeExpired", res.value.changes.length);
    if (res.value.lost > 0) deps.onStale();
    return res.value.changes.length;
  }

  function checkStep(now) {
    const rows = [...open.values()].filter((r) => r.state === S.REVENGE_STATES.WAITING && r.dueAt <= now
      && r.expiresAt > now && (nextCheckAt.get(r.revengeId) || 0) <= now).sort(byDueThenId)
      .slice(0, P.revengeChecksPerPass);
    if (rows.length === 0) return 0;
    const presence = safeCall(() => deps.getPresence(), null);
    const graph = safeCall(() => deps.getGraph(), null);
    const params = { maxJumps: P.revengeMaxJumps, excludedRegions, secClassesOf };
    let gateOpen = null;
    for (const row of rows) {
      const facts = factsOf(row, presence, graph, now);
      const d = decideRevengeStart(row, facts, params);
      nextCheckAt.set(row.revengeId, now + P.revengeCheckEveryMs);
      readyHighsec.delete(row.revengeId);
      if (d.ready && facts.system && facts.system.secClass === HIGHSEC) {
        if (gateOpen === null) gateOpen = concordGateOpen();
        const refused = highsecRefusal(facts.system.security, gateOpen);
        if (refused) {
          readyNow.delete(row.revengeId);
          bump(refused);
          continue;
        }
        readyHighsec.add(row.revengeId);
      }
      if (d.ready) {
        readyNow.set(row.revengeId, d.systemId);
        bump("revengeReady");
      } else {
        readyNow.delete(row.revengeId);
        if (WAIT_COUNTERS[d.reason]) bump(WAIT_COUNTERS[d.reason]);
      }
    }
    return rows.length;
  }

  function concordGateOpen() {
    const c = concordOf();
    const r = c && typeof c.readConcordGateNpcAggro === "function" ? safeCall(() => c.readConcordGateNpcAggro(), null)
      : null;
    return Boolean(r && r.ok === true && r.enabled === false);
  }

  function highsecRefusal(security, gateOpen) {
    if (!H || !isNum(security)) return "highsecSecurity";
    const shown = displaySecurity(security);
    if (shown < H.minSecurity || shown > H.maxSecurity) return "highsecSecurity";
    if (!gateOpen) return "highsecGateConcord";
    if (highsecLive() >= H.maxLive) return "highsecFull";
    return null;
  }

  const seamOf = (get, names) => {
    const s = safeCall(() => (typeof get === "function" ? get() : null), null);
    return s && names.every((n) => typeof s[n] === "function") ? s : null;
  };

  function paramsOf() {
    const hp = safeCall(() => (typeof deps.getHuntParams === "function" ? deps.getHuntParams() : null), null);
    if (!hp || typeof hp !== "object" || !HUNT_PARAM_KEYS.every((k) => isNum(hp[k]))) return null;
    return { ...hp, maxDurationMs: P.revengeMaxDurationMs, maxScanCycles: P.revengeMaxScanCycles, exitEnabled: true,
      retreatEnabled: true, dockCampEnabled: false, sweepRetargetEnabled: false };
  }

  function writeRow(fn) {
    const res = safeCall(() => store.transaction("bounty.revenge", fn), null);
    if (!res || res.ok !== true) {
      return { ok: false, reason: String((res && res.reason) || "no_result")
        + (res && res.error ? ` ${messageOf(res.error)}` : "") };
    }
    const r = res.value;
    if (!r || r.ok !== true) {
      if (r && r.reason === "CAS_LOST") deps.onStale();
      return { ok: false, reason: String((r && r.reason) || "no_result") };
    }
    apply([r.revenge]);
    return r;
  }

  function hookInTx(tx, ended, outcome, now) {
    if (typeof deps.onRevengeEndInTx !== "function") return null;
    try {
      return deps.onRevengeEndInTx(tx, ended, outcome, now);
    } catch (err) {
      if (tx.inTransaction !== true) throw err;
      return { outcome: "failed", reason: messageOf(err) };
    }
  }

  function outcomeOf(row, ended, end) {
    return Object.freeze({ revengeId: ended.revengeId,
      nemesisId: typeof ended.nemesisId === "string" ? ended.nemesisId : null, state: ended.state,
      reason: String(end.reason || "no_result").slice(0, MAX_REASON), engaged: end.engaged === true,
      bossKilled: end.bossKilled === true, commanderId: isId(row.commanderId) ? row.commanderId : null,
      commanderName: typeof end.commanderName === "string" && end.commanderName !== "" ? end.commanderName : null,
      characterId: ended.characterId, factionId: ended.factionId, gangId: ended.gangId,
      hunterLevel: ended.hunterLevel, systemId: isId(row.systemId) ? row.systemId : null,
      killSystemId: ended.killSystemId, quarryTypeId: isId(end.quarryTypeId) ? end.quarryTypeId : null,
      quarryGroupId: isId(end.quarryGroupId) ? end.quarryGroupId : null });
  }

  function settle(row, end, now) {
    const reason = String(end.reason || "no_result").slice(0, MAX_REASON);
    let fn;
    let counter;
    if (end.spawnRefused === true) {
      fn = (tx) => RR.retryRevengeInTx(tx, row, { dueAt: now + P.liveRetryMs, countAttempt: false, reason }, now);
      counter = null;
    } else if (end.reason === END_DISABLED) {
      fn = (tx) => RR.retryRevengeInTx(tx, row, { dueAt: now, countAttempt: false, reason }, now);
      counter = "revengeDisabled";
    } else if (end.engaged === true || end.bossKilled === true || CONTACT_ENDS.includes(end.reason)) {
      fn = (tx) => RR.endRevengeInTx(tx, row, { state: S.REVENGE_STATES.DONE, reason }, now);
      counter = "revengeDone";
    } else if (row.attempts + 1 >= P.revengeMaxAttempts) {
      fn = (tx) => RR.endRevengeInTx(tx, row, { state: S.REVENGE_STATES.EXPIRED, reason }, now);
      counter = "revengeExpiredAttempts";
    } else if (now + P.revengeRetryMs >= row.expiresAt) {
      fn = (tx) => RR.endRevengeInTx(tx, row, { state: S.REVENGE_STATES.EXPIRED, reason }, now);
      counter = "revengeExpired";
    } else {
      fn = (tx) => RR.retryRevengeInTx(tx, row, { dueAt: now + P.revengeRetryMs, countAttempt: true, reason }, now);
      counter = "revengeRetry";
    }
    if (counter === "revengeDone" || counter === "revengeExpiredAttempts" || counter === "revengeExpired") {
      const base = fn;
      fn = (tx) => {
        const e = base(tx);
        if (!e || e.ok !== true) return e;
        return { ...e, nemesis: hookInTx(tx, e.revenge, outcomeOf(row, e.revenge, { ...end, reason }), now) };
      };
    }
    const r = writeRow(fn);
    if (r.ok) {
      orphans.delete(row.revengeId);
      if (counter) bump(counter);
      if (r.nemesis) safeCall(() => deps.onRevengeEndCommitted(r.nemesis), null);
      return true;
    }
    if (r.reason === "CAS_LOST") {
      orphans.delete(row.revengeId);
      return false;
    }
    bump("revengeEndFailed");
    orphans.set(row.revengeId, { reason: end.reason, engaged: end.engaged === true,
      spawnRefused: end.spawnRefused === true, bossKilled: end.bossKilled === true,
      commanderName: typeof end.commanderName === "string" ? end.commanderName : null,
      quarryTypeId: isId(end.quarryTypeId) ? end.quarryTypeId : null,
      quarryGroupId: isId(end.quarryGroupId) ? end.quarryGroupId : null });
    log(`revenge end ${row.revengeId} (${reason}) refused - ${r.reason}, retried every pass`);
    return false;
  }

  function release(scene, sq) {
    const all = Array.isArray(sq.concordIds) && sq.concordIds.length > 0 ? [...sq.allIds, ...sq.concordIds] : sq.allIds;
    if (scene && all.length > 0) safeCall(() => scene.despawn(sq.systemId, all), null);
    if (scene) safeCall(() => scene.forgetShips(sq.allIds), null);
  }

  function keepWithoutScene(scene, sq) {
    if (scene) return false;
    bump("revengeSceneGone");
    if (!sceneGoneLogged) {
      sceneGoneLogged = true;
      log(`revenge squad ${sq.revengeId} kept - the bounty scene seam is gone, no despawn possible`);
    }
    return true;
  }

  function finish(scene, sq, reason, now) {
    if (keepWithoutScene(scene, sq)) return;
    release(scene, sq);
    squads.delete(sq.revengeId);
    const row = open.get(sq.revengeId);
    if (!row || row.state !== S.REVENGE_STATES.LIVE || row.version !== sq.version) return;
    settle(row, { reason, engaged: sq.engaged, bossKilled: sq.bossKilled, commanderName: sq.commanderName,
      quarryTypeId: sq.quarryTypeId, quarryGroupId: sq.quarryGroupId }, now);
  }

  function squadFacts(sq, hunt, params, now) {
    const players = safeCall(() => hunt.readPlayerShips(sq.systemId), null);
    if (!players || players.ok !== true || !Array.isArray(players.ships)) {
      if (players && players.reason === "SCENE_NOT_LOADED") {
        return { now, sceneLoaded: false, quarry: ABSENT, ownAlive: [], hostilesOnGrid: [] };
      }
      return null;
    }
    if (players.ships.length > 0) sq.lastPlayerSeenAt = now;
    const own = sq.ids.length > 0 ? safeCall(() => hunt.readShips(sq.systemId, sq.ids), null) : { ok: true, ships: [] };
    if (!own || own.ok !== true || !Array.isArray(own.ships)) return null;
    const ownAlive = own.ships;
    const aliveIds = new Set(ownAlive.map((s) => s.entityId));
    for (const id of aliveIds) sq.seenAlive.add(id);
    if (aliveIds.size > 0) sq.spawnConfirmed = true;
    if (ownAlive.length > 0) {
      const ag = safeCall(() => hunt.readAggressors(sq.systemId, ownAlive.map((s) => s.entityId)), null);
      if (ag && ag.ok === true && Array.isArray(ag.aggressors)) {
        const playerIds = new Set(players.ships.map((p) => p.entityId));
        for (const a of ag.aggressors) if (playerIds.has(a.aggressorId)) sq.aggressors.add(a.aggressorId);
      }
    }
    const grid = params.gridRadiusMeters;
    const gridSq = grid * grid;
    const ownPts = ownAlive.filter((s) => s.inWarp !== true && isPoint(s.position));
    const onGrid = (p) => p.inWarp !== true && isPoint(p.position)
      && ownPts.some((s) => distSq(s.position, p.position) <= gridSq);
    const quarryShip = players.ships.find((p) => p.characterId === sq.characterId) || null;
    if (quarryShip && quarryShip.capsule !== true && isId(quarryShip.typeId)) {
      sq.quarryTypeId = quarryShip.typeId;
      sq.quarryGroupId = isId(quarryShip.groupId) ? quarryShip.groupId : null;
    }
    const hostilesOnGrid = players.ships.filter((p) => p.capsule !== true
      && (p.characterId === sq.characterId || sq.aggressors.has(p.entityId)) && onGrid(p)).map((p) => p.entityId);
    const lead = ownAlive[0];
    return { now, sceneLoaded: true, quarry: quarryShip ? { state: "space", ship: quarryShip } : ABSENT, ownAlive,
      hostilesOnGrid, members: sq.allIds.length,
      lost: sq.allIds.filter((id) => sq.seenAlive.has(id) && !aliveIds.has(id)).length,
      watched: watchedBy(ownAlive, players.ships, grid), exitPoint: sq.gate ? { ...sq.gate } : null,
      exitOnGrid: Boolean(sq.gate && lead && isPoint(lead.position) && distSq(lead.position, sq.gate) <= gridSq),
      warmScan: true };
  }

  function applyDecision(sq, d, facts, hunt, params) {
    const alive = facts.ownAlive.map((s) => s.entityId);
    if (alive.length === 0) return;
    let attacked = false;
    const attack = (targets) => {
      attacked = true;
      const r = safeCall(() => hunt.attackTargets(sq.systemId, alive, targets), null);
      if (r && r.ok === true) {
        sq.targetKey = targets.join(",");
        if (sq.highsec === true && sq.concordState === CONCORD.NONE) startConcordTimer(sq, facts.now);
      }
    };
    for (const a of d.actions) {
      if (a.type === "search") {
        safeCall(() => hunt.setSearch(sq.systemId, alive), null);
        sq.targetKey = null;
      } else if (a.type === "warp") {
        safeCall(() => hunt.warpShips(sq.systemId, alive, a.point, { spreadMeters: params.landingSpreadMeters }), null);
      } else if (a.type === "attack") {
        attack(a.targets);
      }
    }
    if (!attacked && d.phase === PHASES.ENGAGED && facts.hostilesOnGrid.length > 0
      && facts.hostilesOnGrid.join(",") !== sq.targetKey) {
      attack(facts.hostilesOnGrid);
    }
  }

  function startConcordTimer(sq, now) {
    const c = concordOf();
    const r = c && typeof c.concordResponseDelayMs === "function"
      ? safeCall(() => c.concordResponseDelayMs(sq.systemId), null) : null;
    const delay = r && r.ok === true && isNum(r.ms) && r.ms > 0 ? r.ms : H.fallbackMs;
    sq.concordState = CONCORD.WAIT;
    sq.concordAt = now + delay + H.extraMs;
    bump("concordTimers");
  }

  function toLeave(sq, hunt, alive, now) {
    if (sq.gate && alive.length > 0) safeCall(() => hunt.warpShips(sq.systemId, alive, { ...sq.gate }), null);
    sq.concordState = CONCORD.LEAVE;
    sq.leaveAt = now + H.leaveMs;
  }

  function concordEnd(scene, sq, now) {
    bump("concordEnded");
    finish(scene, sq, END_CONCORD, now);
  }

  function concordArrives(sq, facts, hunt, alive, now) {
    if (H.spawnEnabled !== true) {
      bump("concordNoSpawn");
      toLeave(sq, hunt, alive, now);
      return;
    }
    const lead = facts.ownAlive.find((s) => isPoint(s.position)) || null;
    const c = concordOf();
    const r = lead && c && typeof c.spawnConcordAgainst === "function"
      ? safeCall(() => c.spawnConcordAgainst(sq.systemId, alive, { ...lead.position }), null)
      : { ok: false, reason: lead ? "SEAM_UNAVAILABLE" : "NO_ANCHOR" };
    const ids = r && r.ok === true && Array.isArray(r.entityIds) ? r.entityIds.filter(isId) : [];
    if (ids.length === 0) {
      bump("concordSpawnRefused");
      if (!concordRefusedLogged) {
        concordRefusedLogged = true;
        log(`revenge CONCORD spawn in ${sq.systemId} refused - ${String((r && r.reason) || "no_result")}`
          + `${r && r.detail ? ` (${String(r.detail).slice(0, MAX_DETAIL)})` : ""}; the hunters leave`);
      }
      toLeave(sq, hunt, alive, now);
      return;
    }
    sq.concordIds = ids;
    sq.concordState = CONCORD.FIGHT;
    sq.leaveAt = now + H.killMs;
    bump("concordSpawned");
  }

  function concordStep(sq, facts, hunt, scene, now) {
    if (sq.highsec !== true || sq.concordState === CONCORD.NONE || !H) return false;
    if (facts.sceneLoaded === false) return false;
    const alive = facts.ownAlive.map((s) => s.entityId);
    if (sq.concordState === CONCORD.WAIT) {
      if (now < sq.concordAt) return false;
      if (alive.length === 0) {
        concordEnd(scene, sq, now);
        return true;
      }
      concordArrives(sq, facts, hunt, alive, now);
      if (sq.concordState === CONCORD.LEAVE) return true;
    }
    if (alive.length === 0 || (sq.concordState === CONCORD.LEAVE && now >= sq.leaveAt)) {
      concordEnd(scene, sq, now);
      return true;
    }
    if (sq.concordState === CONCORD.LEAVE) return true;
    if (now >= sq.leaveAt) {
      toLeave(sq, hunt, alive, now);
      return true;
    }
    safeCall(() => hunt.attackTargets(sq.systemId, sq.concordIds, alive), null);
    return false;
  }

  function squadStep(now) {
    if (squads.size === 0) return;
    const hunt = seamOf(deps.getHuntScene, REVENGE_HUNT_METHODS);
    const scene = seamOf(deps.getScene, REVENGE_SCENE_METHODS);
    const params = paramsOf();
    for (const sq of [...squads.values()]) {
      if (keepWithoutScene(scene, sq)) continue;
      const row = open.get(sq.revengeId);
      if (!row || row.state !== S.REVENGE_STATES.LIVE || row.version !== sq.version) {
        release(scene, sq);
        squads.delete(sq.revengeId);
        continue;
      }
      if (!hunt || !params) {
        finish(scene, sq, END_SEAM_GONE, now);
        continue;
      }
      const facts = squadFacts(sq, hunt, params, now);
      if (now - sq.lastPlayerSeenAt >= P.idleDespawnMs) {
        finish(scene, sq, END_IDLE, now);
        continue;
      }
      if (!facts) {
        if (now - sq.liveSince >= P.revengeMaxDurationMs) finish(scene, sq, END_SEAM_GONE, now);
        continue;
      }
      if (concordStep(sq, facts, hunt, scene, now)) continue;
      const d = decideHuntStep(sq, facts, params);
      sq.phase = d.phase;
      sq.phaseSince = d.phaseSince;
      sq.objectIndex = d.objectIndex;
      sq.visited = d.visited;
      sq.quarryAbsentSince = d.quarryAbsentSince;
      sq.noTargetSince = d.noTargetSince;
      sq.scanCycle = d.scanCycle;
      sq.warpSeen = d.warpSeen;
      sq.exitReason = d.exitReason;
      if (d.phase === PHASES.ENGAGED && !sq.engaged) {
        sq.engaged = true;
        bump("revengeEngaged");
      }
      applyDecision(sq, d, facts, hunt, params);
      if (d.end) finish(scene, sq, d.end.reason, now);
    }
  }

  function gangOf(row) {
    const vc = safeCall(() => (typeof deps.getVirtualCorps === "function" ? deps.getVirtualCorps() : null), null);
    const idn = vc && typeof vc.getOwnerIdentity === "function"
      ? safeCall(() => vc.getOwnerIdentity(S.OUTLAW_OWNER_KIND, row.gangId), null) : null;
    const linked = Boolean(idn && idn.ok === true && idn.state === LINKED && Array.isArray(idn.characterIds));
    const corpName = linked && typeof idn.name === "string" ? idn.name : null;
    if (!linked) return { commanderId: null, slimName: null, corpName };
    const taken = new Set();
    for (const s of squads.values()) if (s.commanderId !== null) taken.add(s.commanderId);
    const busy = (id) => typeof deps.isCharacterBusy === "function" && safeCall(() => deps.isCharacterBusy(id), true);
    const pool = [];
    idn.characterIds.forEach((id, i) => {
      if (isId(id) && id !== row.bossCharacterId && !taken.has(id) && !busy(id)) pool.push(i);
    });
    if (pool.length === 0) return { commanderId: null, slimName: null, corpName };
    const at = pool[(row.seed >>> 0) % pool.length];
    const commanderId = idn.characterIds[at];
    const member = Array.isArray(idn.memberNames) ? idn.memberNames[at] : null;
    const name = typeof member === "string" && member !== "" ? member
      : typeof deps.characterNameOf === "function" ? safeCall(() => deps.characterNameOf(commanderId), null) : null;
    return { commanderId, slimName: slimNameOf(name), corpName };
  }

  function startStep(now) {
    if (squads.size >= P.revengeMaxLive || readyNow.size === 0) return 0;
    const nemesisOn = typeof deps.nemesisSquadOf === "function";
    const rows = [...readyNow.keys()].map((id) => open.get(id)).filter((r) => {
      if (!r || r.state !== S.REVENGE_STATES.WAITING || r.dueAt > now || r.expiresAt <= now || squads.has(r.revengeId)
        || orphans.has(r.revengeId)) return false;
      if (r.nemesisId && !nemesisOn) {
        readyNow.delete(r.revengeId);
        readyHighsec.delete(r.revengeId);
        bump("revengeNemesisOff");
        return false;
      }
      if (readyHighsec.has(r.revengeId) && (!H || highsecLive() >= H.maxLive)) return false;
      return true;
    }).sort(byDueThenId);
    if (rows.length === 0) return 0;
    const params = paramsOf();
    if (!params) {
      bump("revengeNoParams");
      return 0;
    }
    const hunt = seamOf(deps.getHuntScene, REVENGE_HUNT_METHODS);
    const scene = seamOf(deps.getScene, REVENGE_SCENE_METHODS);
    if (!hunt || !scene) {
      if (!seamLogged) {
        seamLogged = true;
        log("revenge squads need the hunt and the bounty scene seams - none started");
      }
      return 0;
    }
    const row = rows[0];
    const systemId = readyNow.get(row.revengeId);
    const highsec = readyHighsec.has(row.revengeId);
    readyNow.delete(row.revengeId);
    readyHighsec.delete(row.revengeId);
    const players = safeCall(() => hunt.readPlayerShips(systemId), null);
    const killer = players && players.ok === true && Array.isArray(players.ships)
      ? players.ships.find((p) => p.characterId === row.characterId) || null : null;
    if (!killer) {
      bump("revengeWaitNotLocated");
      return 0;
    }
    if (killer.capsule === true) {
      bump("revengeWaitCapsule");
      return 0;
    }
    let nemesisSquad = null;
    if (row.nemesisId) {
      nemesisSquad = safeCall(() => deps.nemesisSquadOf(row), null);
      if (!nemesisSquad || !isId(nemesisSquad.commanderId)) {
        bump("revengeNemesisNoSquad");
        return 0;
      }
    }
    const gang = nemesisSquad ? { commanderId: nemesisSquad.commanderId, slimName: nemesisSquad.slimName || null,
      corpName: nemesisSquad.corpName || null } : gangOf(row);
    if (gang.commanderId === null) bump("revengeNoCommander");
    const marked = writeRow((tx) => RR.markRevengeLiveInTx(tx, row, { systemId, commanderId: gang.commanderId }, now));
    if (!marked.ok) {
      if (marked.reason !== "CAS_LOST") log(`revenge start ${row.revengeId} refused - ${marked.reason}`);
      return 0;
    }
    const live = marked.revenge;
    const levelData = levels[live.hunterLevel];
    const boss = levelData ? BOSS_SPAWN[levelData.boss] || null : null;
    const extra = nemesisSquad && Number.isSafeInteger(nemesisSquad.extraEscorts) && nemesisSquad.extraEscorts > 0
      ? nemesisSquad.extraEscorts : 0;
    let escorts = boss ? escortsOf({ level: live.hunterLevel, seed: live.seed, stayIndex: live.attempts,
      escortsLost: 0 }, levels, P.maxShipsPerTarget, extra) : [];
    if (nemesisSquad && typeof nemesisSquad.escortsFor === "function" && escorts.length > 0) {
      const adapted = safeCall(() => nemesisSquad.escortsFor(escorts), null);
      if (Array.isArray(adapted) && adapted.length === escorts.length
        && adapted.every((e) => e && typeof e.hullClass === "string")) escorts = adapted;
    }
    const cargo = nemesisSquad && Array.isArray(nemesisSquad.cargo) && nemesisSquad.cargo.length > 0
      ? { cargo: nemesisSquad.cargo } : {};
    const r = boss ? safeCall(() => scene.spawnGroup({ systemId,
      anchor: { kind: "gate", index: (live.seed >>> 0) % GATE_INDEX_SPACE }, factionId: live.factionId, boss, escorts,
      slimName: gang.slimName, archetype: HUNTER_ARCHETYPE, seedKey: live.revengeId, ...cargo }), null)
      : { ok: false, reason: "NO_PROFILE", detail: "level" };
    if (nemesisSquad && r && r.ok === true && typeof nemesisSquad.onSpawn === "function") {
      safeCall(() => nemesisSquad.onSpawn(r), null);
    }
    if (!r || r.ok !== true || !isId(r.bossId)) {
      const reason = String((r && r.reason) || "no_result");
      bump("revengeSpawnFailed");
      if (reason === "NO_ANCHOR") bump("revengeNoAnchor");
      if (r && r.ok === true && Array.isArray(r.escortIds)) safeCall(() => scene.despawn(systemId, r.escortIds), null);
      log(`revenge spawn ${live.revengeId} in ${systemId} refused - ${reason}${r && r.detail ? ` (${r.detail})` : ""}`);
      settle(live, { reason, engaged: false, spawnRefused: true }, now);
      return 0;
    }
    const ids = [r.bossId, ...(Array.isArray(r.escortIds) ? r.escortIds : [])];
    safeCall(() => scene.markShips(ids, { wantedId: live.revengeId, version: live.version, role: HUNTER_ROLE,
      cap: P.victimRegisterCap }), null);
    safeCall(() => hunt.setSearch(systemId, ids), null);
    squads.set(live.revengeId, { revengeId: live.revengeId, version: live.version, systemId,
      characterId: live.characterId, commanderId: gang.commanderId, factionId: live.factionId, ids: ids.slice(),
      allIds: ids.slice(), seenAlive: new Set(), gate: isPoint(r.anchorPoint) ? { ...r.anchorPoint } : null,
      phase: PHASES.SCAN, phaseSince: now, objects: [], objectIndex: 0, visited: 0, liveSince: now,
      quarryAbsentSince: null, noTargetSince: null, mode: MODE_SCAN, seed: live.seed, scanCycle: 0, warpSeen: false,
      spawnConfirmed: false, engaged: false, aggressors: new Set(), exitReason: null, lastPlayerSeenAt: now,
      targetKey: null,
      bossId: r.bossId, bossKilled: false, commanderName: gang.slimName, quarryTypeId: null, quarryGroupId: null,
      highsec, concordState: CONCORD.NONE, concordAt: null, concordIds: [], leaveAt: null });
    bump("revengeLive");
    if (highsec) bump("highsecStarted");
    const sent = typeof deps.sendCharacterSystemLine === "function" ? safeCall(() => deps.sendCharacterSystemLine({
      characterId: live.characterId, systemId, text: nemesisSquad && typeof nemesisSquad.line === "string"
        && nemesisSquad.line !== "" ? nemesisSquad.line : revengeLineOf(gang.slimName, gang.corpName) }), null) : null;
    bump(sent && sent.ok === true ? "revengeLine" : "revengeLineFailed");
    return 1;
  }

  function endAll(now, writeRows) {
    const scene = seamOf(deps.getScene, REVENGE_SCENE_METHODS);
    for (const sq of [...squads.values()]) {
      if (writeRows) {
        finish(scene, sq, END_DISABLED, now);
      } else {
        release(scene, sq);
        squads.delete(sq.revengeId);
      }
    }
  }

  function orphanStep(now) {
    for (const [id, end] of [...orphans]) {
      const row = open.get(id);
      if (!row || row.state !== S.REVENGE_STATES.LIVE || squads.has(id)) orphans.delete(id);
      else settle(row, end, now);
    }
  }

  function step(now) {
    if (orphans.size > 0) orphanStep(now);
    if (P.revengeEnabled !== true || P.liveEnabled !== true) {
      if (squads.size > 0) endAll(now, true);
      return { expired: 0, checked: 0, live: 0, started: 0 };
    }
    const expired = expireStep(now);
    const checked = checkStep(now);
    squadStep(now);
    const started = startStep(now);
    return { expired, checked, live: squads.size, started };
  }

  function onHunterKill(obs) {
    const sq = obs && typeof obs.wantedId === "string" ? squads.get(obs.wantedId) || null : null;
    if (!sq || obs.version !== sq.version) return { ok: true, outcome: "NOOP" };
    sq.ids = sq.ids.filter((id) => id !== obs.victimId);
    if (obs.victimId === sq.bossId) sq.bossKilled = true;
    if (sq.allIds.includes(obs.victimId)) {
      sq.seenAlive.add(obs.victimId);
      sq.spawnConfirmed = true;
    }
    bump("revengeHunterLost");
    return { ok: true, outcome: "HUNTER_LOST" };
  }

  function residents() {
    const out = new Map();
    for (const sq of squads.values()) {
      if (sq.commanderId === null) continue;
      const list = out.get(sq.systemId) || [];
      if (!list.includes(sq.commanderId)) list.push(sq.commanderId);
      out.set(sq.systemId, list);
    }
    return out;
  }

  const isCommander = (characterId) => [...squads.values()].some((sq) => sq.commanderId === characterId);

  function status() {
    let waiting = 0;
    let live = 0;
    for (const r of open.values()) {
      if (r.state === S.REVENGE_STATES.WAITING) waiting += 1;
      else if (r.state === S.REVENGE_STATES.LIVE) live += 1;
    }
    return Object.freeze({ open: open.size, waiting, live, readyNow: readyNow.size, orphans: orphans.size,
      squads: [...squads.values()].map((sq) => Object.freeze({ revengeId: sq.revengeId, systemId: sq.systemId,
        phase: sq.phase, ships: sq.ids.length, commander: sq.commanderId !== null })) });
  }

  const openFor = (characterId) => [...open.values()].some((r) => r.characterId === characterId);

  return { createInTx, noteKill, readInTx, load, step, status, openCount: () => open.size, onHunterKill, residents,
    isCommander, stop: () => endAll(0, false),
    adopt: (rows) => apply(Array.isArray(rows) ? rows.filter(Boolean) : []), openFor,
    createFameInTx, noteFame };
}

module.exports = { createRevengeStep, revengeLineOf, REVENGE_COUNTER_NAMES, REVENGE_READ_CAP, REVENGE_HUNT_METHODS,
  REVENGE_SCENE_METHODS, REVENGE_STEP_METHODS, displaySecurity };
