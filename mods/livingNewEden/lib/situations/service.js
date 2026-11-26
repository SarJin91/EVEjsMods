"use strict";

const { performance } = require("node:perf_hooks");
const { deriveSeed } = require("../util/rng");
const S = require("./schema");
const R = require("./repository");
const { CATALOG, kindOf } = require("./catalog");
const { renderLine, beltLabelOf, gateLabelOf } = require("./lines");
const { eligibleKinds, pickKind, rollSituation, decideStep, helpersOf } = require("./plan");
const { createSituationPayoutPump } = require("./payouts");

const SCENE_METHODS = Object.freeze(["readAnchors", "readPlayers", "spawnShip", "engage", "attack", "readShips",
  "readAggressors", "warpTo", "despawn", "listSituationIds"]);
const WORK_CLASS = "OPERATIONAL";
const MS_DECIMALS = 10;
const MAX_DETAIL = 160;
const NAME_MIN = 3;
const NAME_MAX = 37;
const BOOT_CANCEL_BATCH = 200;
const BOOT_CANCEL_ROUNDS = 10;
const SCENE_NPC_BUDGET = "SCENE_NPC_BUDGET";

const BOARD_SOURCE = "sit";
const BOARD_REF_PREFIX = "si:";
const BOARD_LEN = Object.freeze({ ref: 64, kind: 24, title: 80, state: 16 });
const REWARD_TEXT = "Rescue reward";

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function clip(value, max) {
  const text = String(value ?? "").replace(/[^\x20-\x7e]/g, "?");
  return text.length > max ? text.slice(0, max) : text;
}

const endsOf = (row) => (Number.isSafeInteger(row.endsAt) ? row.endsAt : Number.MAX_SAFE_INTEGER);

function byEndsThenRef(a, b) {
  return endsOf(a) - endsOf(b) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
}

function slimNameOf(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name.length >= NAME_MIN && name.length <= NAME_MAX && !/[<>]/.test(name) ? name : null;
}

function distance(a, b) {
  if (!a || !b) return Infinity;
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function createSituationService(deps) {
  const P = deps && deps.settings;
  if (!P || typeof P !== "object") return { ok: false, reason: "MISSING_DEPS", detail: "settings" };
  for (const k of ["getScene", "getPresence", "speakersOf", "resolveSystemFactions", "resolveProfiles",
    "sendOccupantMessage"]) {
    if (typeof deps[k] !== "function") return { ok: false, reason: "MISSING_DEPS", detail: k };
  }
  if (!deps.store || typeof deps.store.transaction !== "function") {
    return { ok: false, reason: "MISSING_DEPS", detail: "store" };
  }
  if (!deps.journal || typeof deps.journal.applyOnce !== "function") {
    return { ok: false, reason: "MISSING_DEPS", detail: "journal" };
  }
  if (!Number.isSafeInteger(deps.worldSeed)) return { ok: false, reason: "MISSING_DEPS", detail: "worldSeed" };
  if (!Number.isSafeInteger(deps.bootAt) || deps.bootAt < 0) {
    return { ok: false, reason: "MISSING_DEPS", detail: "bootAt" };
  }
  const { store, journal } = deps;
  const leave = deps.leave && Number.isFinite(deps.leave.despawnMs) && Number.isFinite(deps.leave.maxMs) ? deps.leave
    : { despawnMs: 0, maxMs: 0 };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const kindEntry = (sit) => kindOf(sit.kind) || kindOf(S.KINDS.BELT_RAID);
  const podProfileId = typeof deps.podProfileId === "string" && deps.podProfileId.trim() !== ""
    ? deps.podProfileId.trim() : null;
  const START_COUNTER = Object.freeze({ [S.KINDS.GATE_AMBUSH]: "startedGateAmbush",
    [S.KINDS.STRANDED_POD]: "startedStrandedPod" });

  const counters = Object.fromEntries(S.COUNTER_NAMES.map((name) => [name, 0]));
  const active = new Map();
  const leaving = [];
  const rolled = new Map();
  const swept = new Set();
  const loggedFailures = new Set();
  let seq = 0;
  let stopped = false;
  let nextPruneAt = 0;
  let lastPass = null;
  let podKindOff = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`situations: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kindName, name, value) {
    if (!telemetry || typeof telemetry[kindName] !== "function") return;
    try {
      telemetry[kindName](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `situations.${name}`, n);
  }

  function fail(counter, what, detail) {
    bump(counter);
    if (loggedFailures.has(what)) return;
    loggedFailures.add(what);
    log(`${what} failed (${String(detail || "NO_RESULT").slice(0, MAX_DETAIL)}); further failures only counted`);
  }

  function call(fn) {
    try {
      return fn();
    } catch (err) {
      return { ok: false, reason: "THREW", detail: messageOf(err) };
    }
  }

  function tx(name, fn) {
    let res = null;
    try {
      res = store.transaction(name, fn);
    } catch (err) {
      return { ok: false, reason: "TX_THREW", detail: messageOf(err) };
    }
    if (!res || res.ok !== true) return { ok: false, reason: String((res && res.reason) || "no_result") };
    const v = res.value;
    return v && v.ok === true ? v : { ok: false, reason: String((v && v.reason) || "no_result"),
      ...(v && v.detail ? { detail: String(v.detail) } : {}) };
  }

  const pump = createSituationPayoutPump({ store, settings: P,
    rewardCreditIsk: typeof deps.rewardCreditIsk === "function" ? deps.rewardCreditIsk
      : async () => ({ ok: false, reason: "SEAM_UNAVAILABLE" }),
    applyStandingGrant: typeof deps.applyStandingGrant === "function" ? deps.applyStandingGrant
      : () => ({ ok: false, reason: "SEAM_UNAVAILABLE" }),
    bump, log, isStopped: () => stopped });

  function sceneOf() {
    try {
      const seam = deps.getScene();
      return seam && SCENE_METHODS.every((m) => typeof seam[m] === "function") ? seam : null;
    } catch (_err) {
      return null;
    }
  }

  function presenceOf() {
    try {
      const p = deps.getPresence();
      return p && typeof p.observedSystems === "function" && typeof p.getSystemPresence === "function" ? p : null;
    } catch (_err) {
      return null;
    }
  }

  function spaceOf(presence, systemId) {
    try {
      const info = presence ? presence.getSystemPresence(systemId) : null;
      return info && Number.isFinite(info.space) ? info.space : 0;
    } catch (_err) {
      return 0;
    }
  }

  function systemOf(systemId) {
    try {
      const g = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      const sys = g && typeof g.getSystem === "function" ? g.getSystem(systemId) : null;
      return sys && typeof sys === "object" ? sys : null;
    } catch (_err) {
      return null;
    }
  }

  function governorAdmits() {
    try {
      const g = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function liveShipsIn(systemId) {
    let n = 0;
    for (const sit of active.values()) {
      if (sit.systemId === systemId) n += sit.victimIds.length + sit.pirateIds.length;
    }
    for (const e of leaving) if (e.systemId === systemId) n += e.ids.length;
    return n;
  }

  function liveShips() {
    let n = 0;
    for (const sit of active.values()) n += sit.victimIds.length + sit.pirateIds.length;
    for (const e of leaving) n += e.ids.length;
    return n;
  }

  function despawnIds(scene, systemId, ids) {
    if (!scene || ids.length === 0) return [];
    const r = call(() => scene.despawn(systemId, ids));
    if (r && r.ok === true) return ids;
    fail("despawnFailed", "despawn", r && (r.detail || r.reason));
    const failed = new Set(r && Array.isArray(r.failed) ? r.failed : ids);
    return ids.filter((id) => !failed.has(id));
  }

  function despawnOrRetry(scene, systemId, ids, now) {
    const removed = despawnIds(scene, systemId, ids);
    if (!scene || removed.length === ids.length) return removed;
    const gone = new Set(removed);
    const failed = ids.filter((id) => !gone.has(id));
    leaving.push({ systemId, ids: failed, at: now, seenWarp: false, warpEndAt: null });
    bump("despawnRetried", failed.length);
    return removed;
  }

  function say(sit, set, index) {
    const line = renderLine(set, index, { belt: sit.beltLabel, system: sit.systemName });
    if (!line.ok || !isId(sit.speakerId)) return false;
    const r = call(() => deps.sendOccupantMessage({ systemId: sit.systemId, characterId: sit.speakerId,
      text: line.text }));
    return Boolean(r && r.ok === true);
  }

  function sendDistress(sit, now) {
    const ok = say(sit, kindEntry(sit).lines.distress, sit.distressSent);
    sit.distressSent += 1;
    sit.lastDistressAt = now;
    bump(ok ? "distressLines" : "distressRefused");
  }

  function spawnRole(scene, sit, role, profileId, offset, slimName, out) {
    const r = call(() => scene.spawnShip(sit.systemId, { role, profileId, anchor: { kind: sit.anchor.kind,
      id: sit.anchor.id }, spawnOffsetMeters: offset, situationId: sit.situationId,
    ...(slimName ? { slimName } : {}) }));
    if (r && r.ok === true && isId(r.entityId)) return r.entityId;
    if (out) out.reason = String((r && r.reason) || "NO_RESULT");
    if (r && r.reason === SCENE_NPC_BUDGET) bump("sceneRefused");
    else fail("spawnFailed", `spawn ${role}`, r && (r.detail ? `${r.reason} ${r.detail}` : r.reason));
    if (r && Array.isArray(r.leftover) && r.leftover.length > 0) despawnIds(scene, sit.systemId, r.leftover);
    return null;
  }

  function engage(scene, sit) {
    if (sit.pirateIds.length === 0 || sit.victimIds.length === 0) return false;
    const r = call(() => scene.engage(sit.systemId, sit.pirateIds, sit.victimIds));
    if (r && r.ok === true) return true;
    fail("readFailed", "engage", r && (r.detail || r.reason));
    return false;
  }

  function deferPirates(sit, now) {
    bump("piratesDeferred");
    if (now >= sit.callingSince + P.callingTimeoutMs) {
      sit.pending = { outcome: S.STATES.UNANSWERED, reason: S.END_REASONS.TIMEOUT };
    }
  }

  function spawnPirates(scene, sit, now) {
    if (typeof deps.admitScene === "function") {
      const gate = call(() => deps.admitScene(sit.systemId, sit.pirateProfiles.length, "situations"));
      if (gate && gate.ok === false) {
        deferPirates(sit, now);
        return;
      }
    }
    let sceneRefusals = 0;
    for (const profileId of sit.pirateProfiles) {
      const out = {};
      const id = spawnRole(scene, sit, S.ROLES.PIRATE, profileId, P.pirateStandoffMeters, null, out);
      if (id !== null) sit.pirateIds.push(id);
      else if (out.reason === SCENE_NPC_BUDGET) sceneRefusals += 1;
    }
    if (sit.pirateIds.length === 0 && sceneRefusals > 0) {
      deferPirates(sit, now);
      return;
    }
    if (sit.pirateIds.length === 0) {
      sit.pending = { outcome: S.STATES.CANCELLED, reason: S.END_REASONS.SPAWN_FAILED };
      return;
    }
    sit.phase = S.PHASES.FIGHT;
    sit.fightSince = now;
    sit.absentSince = null;
    sit.engaged = engage(scene, sit);
    if (sit.engaged) bump("engaged");
  }

  function retaliate(scene, sit, pairs) {
    if (P.pirateRetaliate !== true) return;
    for (const [pirateId, shipId] of pairs) {
      const key = `${pirateId}:${shipId}`;
      if (sit.retaliated.has(key)) continue;
      const r = call(() => scene.attack(sit.systemId, pirateId, shipId));
      if (r && r.ok === true) {
        sit.retaliated.add(key);
        bump("retaliations");
      } else {
        fail("readFailed", "attack", r && (r.detail || r.reason));
      }
    }
  }

  function stepOne(scene, sit, now) {
    const ids = [...sit.victimIds, ...sit.pirateIds];
    const read = call(() => scene.readShips(sit.systemId, ids));
    if (!read || read.ok !== true) {
      fail("readFailed", "readShips", read && (read.detail || read.reason));
      if (now >= sit.startedAt + P.callingTimeoutMs + P.maxFightMs) {
        sit.pending = { outcome: S.STATES.ABANDONED, reason: S.END_REASONS.SCENE_GONE };
      }
      return;
    }
    const sceneLoaded = read.sceneLoaded === true;
    let victimDied = false;
    const playersByShip = new Map();
    let playersOnGrid = 0;
    let newAggressors = 0;
    let rescuersInRange = 0;
    const pairs = [];
    if (sceneLoaded) {
      const gone = new Set(Array.isArray(read.gone) ? read.gone : []);
      if (gone.size > 0) {
        const before = sit.victimIds.length;
        sit.victimIds = sit.victimIds.filter((id) => !gone.has(id));
        sit.pirateIds = sit.pirateIds.filter((id) => !gone.has(id));
        victimDied = sit.victimIds.length < before;
        call(() => scene.despawn(sit.systemId, [...gone]));
      }
      const players = call(() => scene.readPlayers(sit.systemId));
      const playersRead = Boolean(players && players.ok === true && Array.isArray(players.ships));
      if (playersRead) {
        for (const ship of players.ships) {
          if (!ship || !isId(ship.characterId) || !isId(ship.entityId)) continue;
          playersByShip.set(ship.entityId, ship.characterId);
          if (ship.inWarp !== true && distance(ship.position, sit.anchor.position) <= P.engageRangeMeters) {
            playersOnGrid += 1;
          }
        }
      } else if (!players || players.reason !== "SCENE_NOT_LOADED") {
        fail("readFailed", "readPlayers", players && (players.detail || players.reason));
      }
      if (sit.phase === S.PHASES.FIGHT && sit.pirateIds.length > 0) {
        const ag = call(() => scene.readAggressors(sit.systemId, sit.pirateIds));
        if (ag && ag.ok === true && Array.isArray(ag.aggressors)) {
          for (const a of ag.aggressors) {
            if (!a || a.aggressorKind !== "player" || !isId(a.aggressorId) || !isId(a.entityId)) continue;
            const characterId = playersByShip.get(a.aggressorId);
            if (!isId(characterId)) continue;
            if (!sit.aggressors.has(characterId)) newAggressors += 1;
            sit.aggressors.add(characterId);
            if (!sit.retaliated.has(`${a.entityId}:${a.aggressorId}`)) pairs.push([a.entityId, a.aggressorId]);
          }
        }
      }
      if (sit.phase === S.PHASES.FIGHT && playersRead) {
        sit.absentSince = playersOnGrid > 0 ? null : (sit.absentSince === null ? now : sit.absentSince);
      }
      if (sit.kind === S.KINDS.STRANDED_POD && playersRead) {
        const live = Array.isArray(read.live) ? read.live : [];
        const pod = live.find((s) => s && sit.victimIds.includes(s.entityId));
        const rescuers = new Set();
        if (pod && pod.position) {
          for (const ship of players.ships) {
            if (!ship || !isId(ship.characterId) || ship.inWarp === true) continue;
            if (distance(ship.position, pod.position) <= P.rescueRangeMeters) rescuers.add(ship.characterId);
          }
        }
        if (rescuers.size > 0) {
          if (sit.rescueSince === null) sit.rescueSince = now;
        } else if (sit.rescueSince !== null) {
          sit.rescueSince = null;
          bump("podHoldResets");
        }
        sit.rescuers = rescuers;
        rescuersInRange = rescuers.size;
      }
    }
    const d = decideStep(sit, { now, playersOnGrid, sceneLoaded, victimsAlive: sit.victimIds.length,
      piratesAlive: sit.pirateIds.length, pirateKillsByPlayers: sit.pirateKills, aggressors: pairs.length > 0
        ? Math.max(1, newAggressors) : 0, victimDied, rescuersInRange }, P);
    if (d.action === "DISTRESS") sendDistress(sit, now);
    else if (d.action === "SPAWN_PIRATES") spawnPirates(scene, sit, now);
    else if (d.action === "ENGAGE") {
      sit.engaged = engage(scene, sit);
      if (sit.engaged) bump("engaged");
    } else if (d.action === "RETARGET") {
      if (victimDied) engage(scene, sit);
      retaliate(scene, sit, pairs);
    } else if (d.action === "RESOLVE") {
      sit.pending = { outcome: d.outcome, reason: d.reason };
    }
  }

  function runLifecycle(scene, now) {
    for (const sit of active.values()) {
      if (sit.pending) continue;
      if (!scene) {
        sit.pending = { outcome: S.STATES.ABANDONED, reason: S.END_REASONS.SCENE_GONE };
        continue;
      }
      try {
        stepOne(scene, sit, now);
      } catch (err) {
        fail("readFailed", "step", messageOf(err));
      }
    }
  }

  const OUTCOME_COUNTER = Object.freeze({ [S.STATES.RESCUED]: "rescued", [S.STATES.LOST]: "lost",
    [S.STATES.UNANSWERED]: "unanswered", [S.STATES.ABANDONED]: "abandoned", [S.STATES.CANCELLED]: "cancelled" });

  function cleanup(scene, sit, outcome, now) {
    const all = [...sit.victimIds, ...sit.pirateIds];
    if (!scene) return;
    const lines = kindEntry(sit).lines;
    if (outcome === S.STATES.RESCUED) {
      say(sit, lines.thanks, sit.speakerPick);
      despawnOrRetry(scene, sit.systemId, sit.pirateIds, now);
      if (sit.victimIds.length > 0 && sit.exitPoint) {
        const w = call(() => scene.warpTo(sit.systemId, sit.victimIds, sit.exitPoint));
        if (w && w.ok === true && Number(w.warped) > 0) {
          leaving.push({ systemId: sit.systemId, ids: [...sit.victimIds], at: now, seenWarp: false, warpEndAt: null });
          return;
        }
      }
      despawnOrRetry(scene, sit.systemId, sit.victimIds, now);
      return;
    }
    if (outcome === S.STATES.LOST && lines.lost) say(sit, lines.lost, sit.speakerPick);
    despawnOrRetry(scene, sit.systemId, all, now);
  }

  const RUMOUR_OUTCOMES = Object.freeze([S.STATES.RESCUED, S.STATES.LOST, S.STATES.UNANSWERED]);

  function rumour(sit, outcome, saved, now) {
    if (P.rumoursEnabled !== true || typeof deps.onRumour !== "function" || !RUMOUR_OUTCOMES.includes(outcome)) return;
    let sent = false;
    try {
      sent = deps.onRumour({ situationId: sit.situationId, kind: sit.kind, outcome, systemId: sit.systemId, at: now,
        victims: sit.victims, saved }) === true;
    } catch (_err) {
      sent = false;
    }
    bump(sent ? "rumoursSent" : "rumoursRefused");
  }

  function settle(scene, sit, now) {
    const { outcome, reason } = sit.pending;
    const rescued = outcome === S.STATES.RESCUED;
    const saved = rescued ? sit.victimIds.length : 0;
    const helpers = rescued ? helpersOf(sit, P).characterIds : [];
    const reward = rescued && P.rewardsEnabled === true ? { iskPerSaved: P.rewardIskPerSaved,
      standingMicro: P.rewardStandingMicro, standingFactionId: kindEntry(sit).standingFactionId,
      maxPerDay: P.maxRewardsPerCharacterPerDay } : null;
    const r = tx("situations.settle", (t) => R.settleInTx(t, journal, sit, outcome,
      { endReason: reason, saved, helpers, reward }, now));
    if (!r.ok && r.reason !== "DUPLICATE" && r.reason !== "CAS_LOST") {
      fail("settleFailed", "settle", `${r.reason}${r.detail ? ` ${r.detail}` : ""}`);
      return false;
    }
    if (r.ok) {
      bump(OUTCOME_COUNTER[outcome]);
      if (r.planned > 0) {
        pump.notePlanned(r.planned);
        bump("payoutsPlanned", r.planned);
      }
      bump("rewardCapped", r.capped);
      rumour(sit, outcome, saved, now);
    }
    cleanup(scene, sit, outcome, now);
    active.delete(sit.situationId);
    return true;
  }

  function runSettlements(scene, now) {
    for (const sit of [...active.values()]) {
      if (!sit.pending) continue;
      try {
        settle(scene, sit, now);
      } catch (err) {
        fail("settleFailed", "settle", messageOf(err));
      }
    }
  }

  function runLeaving(scene, now) {
    for (let i = leaving.length - 1; i >= 0; i -= 1) {
      const e = leaving[i];
      let done = !scene || now >= e.at + leave.maxMs;
      if (!done) {
        const read = call(() => scene.readShips(e.systemId, e.ids));
        if (!read || read.ok !== true) {
          fail("readFailed", "readShips", read && (read.detail || read.reason));
          continue;
        }
        if (read.sceneLoaded !== true) done = true;
        else {
          const live = Array.isArray(read.live) ? read.live : [];
          e.ids = live.map((s) => s.entityId);
          if (live.some((s) => s.inWarp === true)) e.seenWarp = true;
          else if (e.seenWarp && e.warpEndAt === null) e.warpEndAt = now;
          done = e.ids.length === 0 || (e.warpEndAt !== null && now >= e.warpEndAt + leave.despawnMs);
        }
      }
      if (!done) continue;
      if (scene && e.ids.length > 0) despawnIds(scene, e.systemId, e.ids);
      leaving.splice(i, 1);
    }
  }

  function sweepOrphans(scene, systemId, now) {
    if (swept.has(systemId)) return;
    const listed = call(() => scene.listSituationIds(systemId));
    if (!listed || listed.ok !== true || !Array.isArray(listed.ids)) {
      fail("readFailed", "listSituationIds", listed && (listed.detail || listed.reason));
      return;
    }
    swept.add(systemId);
    const known = new Set();
    for (const sit of active.values()) for (const id of [...sit.victimIds, ...sit.pirateIds]) known.add(id);
    for (const e of leaving) for (const id of e.ids) known.add(id);
    const orphans = listed.ids.filter((id) => !known.has(id));
    bump("orphans", despawnOrRetry(scene, systemId, orphans, now).length);
  }

  function speakerOf(systemId, pick) {
    const sp = call(() => deps.speakersOf(systemId));
    if (!sp || sp.ok !== true) return null;
    const ids = [];
    for (const id of [...(Array.isArray(sp.civilians) ? sp.civilians : []),
      ...(Array.isArray(sp.residents) ? sp.residents : [])]) {
      if (isId(id) && !ids.includes(id)) ids.push(id);
    }
    return ids.length > 0 ? ids[pick % ids.length] : null;
  }

  function nameOf(characterId) {
    if (typeof deps.readCharacterNames !== "function") return null;
    const r = call(() => deps.readCharacterNames([characterId]));
    return r && r.ok === true && r.names instanceof Map ? slimNameOf(r.names.get(characterId)) : null;
  }

  function nearestGate(anchors, from) {
    let best = null;
    for (const g of Array.isArray(anchors.gates) ? anchors.gates : []) {
      if (!best || distance(g.position, from) < distance(best.position, from)) best = g;
    }
    return best ? best.position : null;
  }

  function victimListOf(k) {
    if (k.kind === S.KINDS.STRANDED_POD) return podProfileId !== null ? [podProfileId] : [];
    const own = k.kind === S.KINDS.GATE_AMBUSH ? deps.haulerProfiles : deps.victimProfiles;
    return Array.isArray(own) && own.length > 0 ? own : k.victimFallbackProfiles;
  }

  function start(scene, systemId, bucket, roll, anchors, now) {
    const k = kindOf(roll.kind);
    if (!k) return "NO_PROFILE";
    const speakerId = speakerOf(systemId, roll.speakerPick);
    if (speakerId === null) return "NO_SPEAKER";
    const traffic = typeof deps.trafficShipsIn === "function" ? Number(call(() => deps.trafficShipsIn(systemId))) : 0;
    const total = roll.victims + roll.pirates.length;
    if ((Number.isFinite(traffic) ? traffic : 0) + liveShipsIn(systemId) + total > P.maxCivilianShipsPerSystem) {
      return "BUDGET";
    }
    if (typeof deps.admitScene === "function") {
      const gate = call(() => deps.admitScene(systemId, total, "situations"));
      if (gate && gate.ok === false) return "BUDGET";
    }
    let factionId = null;
    let pirateProfiles = [];
    if (k.pirates !== false) {
      const fr = call(() => deps.resolveSystemFactions([systemId]));
      const entry = fr && fr.ok === true && Array.isArray(fr.entries) ? fr.entries[0] : null;
      factionId = entry && isId(entry.factionId) ? entry.factionId : null;
      if (factionId === null) return "NO_PIRATE_FACTION";
      const prof = call(() => deps.resolveProfiles(roll.pirates.map((p, i) => ({ memberKey: `p${i}`, factionId,
        hullGroup: p.hullGroup })), { seedPrefix: `sit:${systemId}:${bucket}` }));
      if (!prof || prof.ok !== true || !Array.isArray(prof.profiles) || prof.profiles.length === 0) return "NO_PROFILE";
      pirateProfiles = prof.profiles;
    }
    const victimList = victimListOf(k);
    if (victimList.length === 0) return "NO_PROFILE";
    const atGate = k.anchorKind === S.ANCHOR_KINDS.GATE;
    const list = atGate ? (Array.isArray(anchors.hotGates) ? anchors.hotGates : []) : anchors.belts;
    const anchor = list[roll.anchorIndex];
    if (!anchor) return "NO_ANCHOR";
    const sys = systemOf(systemId);
    seq += 1;
    const spec = { situationId: S.situationIdOf(deps.bootAt, seq), kind: k.kind, systemId, bucket,
      anchorKind: k.anchorKind, anchorId: anchor.itemId, speakerId, pirateFactionId: factionId,
      victims: roll.victims, bootAt: deps.bootAt };
    const w = tx("situations.start", (t) => R.startInTx(t, journal, spec, now));
    if (!w.ok) {
      if (w.reason === "DUPLICATE") bump("duplicates");
      else fail("startFailed", "start", `${w.reason}${w.detail ? ` ${w.detail}` : ""}`);
      return null;
    }
    const sit = { situationId: spec.situationId, version: w.situation.version, kind: k.kind, systemId, bucket,
      victims: roll.victims, anchor: { kind: k.anchorKind, id: anchor.itemId, position: anchor.position },
      beltLabel: atGate ? gateLabelOf(anchor.name) : beltLabelOf(anchor.name, roll.anchorIndex + 1),
      systemName: sys && typeof sys.name === "string" ? sys.name : null,
      exitPoint: k.kind === S.KINDS.BELT_RAID ? nearestGate(anchors, anchor.position) : null,
      speakerId, speakerPick: roll.speakerPick, pirateFactionId: factionId, pirateProfiles,
      victimIds: [], pirateIds: [], phase: S.PHASES.CALLING, startedAt: now, callingSince: now, fightSince: null,
      lastDistressAt: now, distressSent: 0, engaged: false, absentSince: null, aggressors: new Set(),
      killers: new Set(), excluded: new Set(), retaliated: new Set(), pirateKills: 0, pending: null,
      rescueSince: null, rescuers: new Set() };
    active.set(sit.situationId, sit);
    bump("started");
    if (START_COUNTER[k.kind]) bump(START_COUNTER[k.kind]);
    sweepOrphans(scene, systemId, now);
    const speakerName = nameOf(speakerId);
    const offset = k.kind === S.KINDS.STRANDED_POD ? P.podDistanceMeters : P.victimOffsetMeters;
    const refusal = {};
    for (let i = 0; i < roll.victims; i += 1) {
      const profileId = victimList[roll.victimPicks[i] % victimList.length];
      const id = spawnRole(scene, sit, S.ROLES.VICTIM, profileId, offset, i === 0 ? speakerName : null, refusal);
      if (id !== null) sit.victimIds.push(id);
    }
    if (sit.victimIds.length === 0) {
      if (k.kind === S.KINDS.STRANDED_POD && refusal.reason === "SPAWN_FAILED" && podKindOff === null) {
        podKindOff = refusal.reason;
        bump("podKindOff");
        log(`stranded pod kind off (capsule ${podProfileId} refused: ${refusal.reason}) until the next restart`);
      }
      sit.pending = { outcome: S.STATES.CANCELLED, reason: S.END_REASONS.SPAWN_FAILED };
      return null;
    }
    sendDistress(sit, now);
    if (k.startPhase === S.PHASES.FIGHT) spawnPirates(scene, sit, now);
    return null;
  }

  function hotGatesOf(scene, systemId, anchors) {
    const gates = Array.isArray(anchors.gates) ? [...anchors.gates].sort((a, b) => a.itemId - b.itemId) : [];
    if (gates.length === 0) return [];
    const players = call(() => scene.readPlayers(systemId));
    if (!players || players.ok !== true || !Array.isArray(players.ships)) {
      if (!players || players.reason !== "SCENE_NOT_LOADED") {
        fail("readFailed", "readPlayers", players && (players.detail || players.reason));
      }
      return [];
    }
    const ships = players.ships.filter((s) => s && isId(s.characterId) && s.inWarp !== true);
    return gates.filter((g) => ships.some((s) => distance(s.position, g.position) <= P.engageRangeMeters));
  }

  function runRolls(scene, now) {
    if (!scene) return;
    const presence = presenceOf();
    if (!presence) return;
    let observed = [];
    try {
      observed = presence.observedSystems().map(Number);
    } catch (_err) {
      observed = [];
    }
    const bucket = Math.floor(now / P.bucketMs);
    for (const [systemId, b] of [...rolled]) if (b !== bucket) rolled.delete(systemId);
    const busy = new Set([...active.values()].map((s) => s.systemId));
    const candidates = observed.filter((id) => isId(id) && !busy.has(id) && !rolled.has(id)
      && spaceOf(presence, id) > 0).sort((a, b) => a - b);
    for (const systemId of candidates) {
      const sys = systemOf(systemId);
      const secClass = sys && typeof sys.secClass === "string" ? sys.secClass : null;
      if (!secClass || !P.bands.includes(secClass)) continue;
      if (!governorAdmits()) {
        bump("refused.GOVERNOR");
        return;
      }
      rolled.set(systemId, bucket);
      bump("rolls");
      const anchors = call(() => scene.readAnchors(systemId));
      if (!anchors || anchors.ok !== true) {
        if (!anchors || anchors.reason !== "SCENE_NOT_LOADED") {
          fail("readFailed", "readAnchors", anchors && (anchors.detail || anchors.reason));
        }
        continue;
      }
      const belts = Array.isArray(anchors.belts) ? anchors.belts : [];
      const hotGates = P.gateAmbushEnabled === true && P.gateAmbushWeight > 0 ? hotGatesOf(scene, systemId, anchors)
        : [];
      const eligible = eligibleKinds({ settings: P, beltCount: belts.length, hotGateCount: hotGates.length,
        podProfile: podProfileId !== null, podKindOff: podKindOff !== null });
      if (eligible.length >= 2) bump("kindDraws");
      const kind = pickKind(eligible, eligible.length >= 2
        ? deriveSeed(deps.worldSeed >>> 0, S.RNG_KIND_STREAM, systemId, bucket) : 0);
      const seed = deriveSeed(deps.worldSeed >>> 0, S.RNG_STREAM, systemId, bucket);
      const roll = rollSituation({ seed, systemId, bucket, secClass, kind, anchors: { belts, hotGates },
        catalog: CATALOG }, P);
      if (!roll.roll) {
        if (roll.reason === "NO_ANCHOR") bump("refused.NO_ANCHOR");
        else if (roll.reason) bump("refused.NO_PROFILE");
        continue;
      }
      if (active.size >= P.maxActive) {
        bump("refused.BUDGET");
        continue;
      }
      const refused = start(scene, systemId, bucket, roll, { ...anchors, belts, hotGates }, now);
      if (refused) bump(`refused.${refused}`);
    }
  }

  function prune(now) {
    if (now < nextPruneAt) return;
    nextPruneAt = now + P.pruneEveryMs;
    if (now - P.retentionMs <= 0) return;
    const r = tx("situations.prune", (t) => R.pruneEndedInTx(t, now - P.retentionMs, P.prunePerRun));
    if (r.ok) bump("pruned", r.deleted);
    else fail("readFailed", "prune", r.reason);
  }

  function boot(now) {
    let recovered = 0;
    for (let i = 0; i < BOOT_CANCEL_ROUNDS; i += 1) {
      const r = tx("situations.boot", (t) => R.cancelStaleInTx(t, deps.bootAt, now, BOOT_CANCEL_BATCH));
      if (!r.ok) return { ok: false, reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
      recovered += r.cancelled;
      if (r.cancelled < BOOT_CANCEL_BATCH) break;
    }
    bump("recovered", recovered);
    const pb = pump.boot();
    if (!pb.ok) return { ok: false, reason: `payouts:${pb.reason}` };
    return { ok: true, recovered };
  }

  function runPass(now) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = nowMs();
    try {
      const scene = sceneOf();
      runLifecycle(scene, now);
      runSettlements(scene, now);
      runLeaving(scene, now);
      runRolls(scene, now);
      prune(now);
      bump("passes");
      return { ok: true, active: active.size };
    } catch (err) {
      fail("readFailed", "pass", messageOf(err));
      return { ok: false, reason: "PASS_FAILED", detail: messageOf(err) };
    } finally {
      const ms = Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("gauge", S.METRICS.liveShips, liveShips());
      metric("gauge", S.METRICS.active, active.size);
      metric("observe", S.METRICS.passMs, ms);
      lastPass = { active: active.size, ms };
    }
  }

  function onKill(e) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    if (!e || !isId(e.characterId) || typeof e.situationId !== "string" || !Object.values(S.ROLES).includes(e.role)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const sit = active.get(e.situationId);
    if (!sit || sit.pending) return { ok: true, counted: false };
    if (e.role === S.ROLES.PIRATE) {
      sit.killers.add(e.characterId);
      sit.pirateKills += 1;
      bump("pirateKills");
    } else {
      sit.excluded.add(e.characterId);
      bump("victimKilledByPlayer");
    }
    return { ok: true, counted: true };
  }

  function listOpen() {
    return Object.freeze([...active.values()].map((s) => {
      const fight = s.phase === S.PHASES.FIGHT && Number.isSafeInteger(s.fightSince);
      const phaseSince = fight ? s.fightSince : s.callingSince;
      return Object.freeze({ situationId: s.situationId, kind: s.kind, systemId: s.systemId, phase: s.phase,
        beltLabel: s.beltLabel, anchorLabel: s.beltLabel, victims: s.victimIds.length, startedAt: s.startedAt,
        phaseSince, deadlineAt: phaseSince + (fight ? P.maxFightMs : P.callingTimeoutMs) });
    }));
  }

  function listBoardRows(opts) {
    if (P.boardEnabled !== true) return { ok: false, reason: "SITUATIONS_DISABLED" };
    const limit = opts && opts.limit;
    const systemIds = opts ? opts.systemIds : undefined;
    if (!Number.isSafeInteger(limit) || limit <= 0) return { ok: false, reason: "LIMIT_INVALID" };
    if (systemIds !== null && !(systemIds instanceof Set)) return { ok: false, reason: "SYSTEM_IDS_INVALID" };
    const out = [];
    for (const s of listOpen()) {
      if (systemIds !== null && !systemIds.has(s.systemId)) continue;
      const entry = kindOf(s.kind);
      const title = `${entry && entry.boardTitle ? entry.boardTitle : s.kind}: ${s.anchorLabel}`;
      out.push({ ref: clip(`${BOARD_REF_PREFIX}${s.situationId}`, BOARD_LEN.ref), source: BOARD_SOURCE,
        kind: clip(s.kind, BOARD_LEN.kind), title: clip(title, BOARD_LEN.title), systemId: s.systemId,
        factionId: null, level: null, scan: false, rewardText: P.rewardsEnabled === true ? REWARD_TEXT : null,
        endsAt: s.deadlineAt, state: clip(s.phase, BOARD_LEN.state) });
    }
    out.sort(byEndsThenRef);
    return { ok: true, rows: out.slice(0, limit), truncated: out.length > limit };
  }

  function stop() {
    if (stopped) return;
    const scene = sceneOf();
    const now = clock.now();
    for (const sit of [...active.values()]) {
      try {
        sit.pending = sit.pending || { outcome: S.STATES.CANCELLED, reason: S.END_REASONS.STOPPED };
        settle(scene, sit, now);
      } catch (_err) {
      }
    }
    for (const sit of active.values()) despawnIds(scene, sit.systemId, [...sit.victimIds, ...sit.pirateIds]);
    for (const e of leaving) despawnIds(scene, e.systemId, e.ids);
    stopped = true;
    active.clear();
    leaving.length = 0;
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", active: active.size, leaving: leaving.length,
      liveShips: liveShips(), lastPass, payouts: pump.status(), podKindOff,
      counters: Object.freeze({ ...counters }) });
  }

  return { ok: true, service: Object.freeze({ boot, runPass, onKill, listOpen, listBoardRows, getStatus, stop,
    isStopped: () => stopped, runPayoutPass: (now) => pump.runPayoutPass(now) }) };
}

module.exports = { createSituationService, SCENE_METHODS };
