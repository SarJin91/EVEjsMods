"use strict";

const S = require("./schema");
const R = require("./repository");
const { createRng, deriveSeed } = require("../util/rng");
const { BOSS_SPAWN, ESCORT_CLASSES, SMUGGLER_EXTRA_ESCORTS, SMUGGLER_JUMP_FREIGHTER_LEVEL } = require("./data/levels");
const LOOT = require("./data/loot");
const { planBountyLoot, officerLootSeedOf } = require("./loot");

const RNG_STREAM_ESCORT = "escort";
const RUNNER = "RUNNER";
const AMBUSH = "AMBUSH";
const SMUGGLER = "SMUGGLER";
const MAX_CARGO = 32;
const MAX_DETAIL = 160;
const NAME_MIN = 3;
const NAME_MAX = 37;
const LIVE_COUNTER_NAMES = Object.freeze(["live", "escaped", "killed", "despawned", "spawnFailed", "lostScene",
  "killLate", "liveDeferred", "liveNoAnchor", "liveRetryWait", "escortLost", "warpOff", "ambush", "runnerFightBack",
  "liveEndFailed", "liveDisabled", "killRetry", "lootItems", "lootSkipped", "smugglerSpawned", "claimJournalFailed", "killGaveUp",
  "liveSceneRefused",
  "liveWoken", "liveWakeFailed",
  "fleeGate", "fleeNoGate", "fleeRetry", "fleeApproach", "gateJump", "arrivalSpawn",
  "gateArrivalEvents", "gateDepartureEvents"]);
const FLEE_FALLBACK_REASONS = Object.freeze(["NO_GATE", "SEAM_UNAVAILABLE", "INVALID_INPUT"]);

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const byLevelThenId = (a, b) => b.level - a.level || (a.wantedId < b.wantedId ? -1 : a.wantedId > b.wantedId ? 1 : 0);

function safeCall(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function slimNameOf(name) {
  if (typeof name !== "string") return null;
  const t = name.trim();
  return t.length >= NAME_MIN && t.length <= NAME_MAX && !/[<>]/.test(t) ? t : null;
}

function escortsOf(row, levels, maxShipsPerTarget, extra = 0) {
  const data = levels[row.level];
  const classes = ESCORT_CLASSES[row.level] || [];
  if (!data || !Array.isArray(data.escorts) || classes.length === 0) return [];
  const rng = createRng(deriveSeed(row.seed >>> 0, RNG_STREAM_ESCORT, row.stayIndex));
  const [lo, hi] = data.escorts;
  const rolled = rng.nextInt(lo, hi) + extra;
  const n = Math.max(0, Math.min(rolled - (row.escortsLost || 0), maxShipsPerTarget - 1));
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ hullClass: classes[rng.nextInt(0, classes.length - 1)] });
  return out;
}

function createLiveStep(deps) {
  const P = deps.settings;
  const { store, ram, levels } = deps;
  const bump = deps.bump;
  const log = deps.log;
  const groups = new Map();
  const retryAt = new Map();
  const orphans = new Map();
  const pendingKills = new Map();
  const arrivals = new Map();

  const sceneOf = () => {
    const seam = safeCall(() => deps.getScene(), null);
    return seam && typeof seam.spawnGroup === "function" ? seam : null;
  };
  const presenceOf = () => {
    const p = safeCall(() => deps.getPresence(), null);
    return p && typeof p.getSystemPresence === "function" && typeof p.observedSystems === "function" ? p : null;
  };
  const spaceIn = (presence, systemId) => {
    const pres = presence ? safeCall(() => presence.getSystemPresence(systemId), null) : null;
    return pres && Number.isFinite(pres.space) ? pres.space : 0;
  };

  function write(name, fn) {
    const res = safeCall(() => store.transaction(name, fn), null);
    if (!res || res.ok !== true) {
      return { ok: false, reason: String((res && res.reason) || "no_result")
        + (res && res.error ? ` ${messageOf(res.error)}` : "") };
    }
    const r = res.value;
    if (!r || r.ok !== true) {
      if (r && r.reason === "CAS_LOST") deps.onStale();
      return { ok: false, reason: String((r && r.reason) || "no_result") };
    }
    ram.apply([r.target]);
    return r;
  }

  function release(seam, g, ids) {
    const list = ids || g.allIds;
    if (seam && list.length > 0) safeCall(() => seam.despawn(g.systemId, list), null);
    if (seam) safeCall(() => seam.forgetShips(g.allIds), null);
  }

  function endRow(row, move, now) {
    const r = write("bounty.liveEnd", (tx) => R.endLiveInTx(tx, row, move, now));
    if (r.ok) {
      orphans.delete(row.wantedId);
      return true;
    }
    bump("liveEndFailed");
    orphans.set(row.wantedId, now);
    log(`live end ${row.wantedId} refused - ${r.reason}`);
    return false;
  }

  function residentsChanged(systemId) {
    if (typeof deps.onResidentsChanged === "function") safeCall(() => deps.onResidentsChanged(systemId), null);
  }

  function end(seam, g, row, move, now, counter, retry) {
    release(seam, g, null);
    groups.delete(g.wantedId);
    if (retry) retryAt.set(g.wantedId, now + P.liveRetryMs);
    bump(counter);
    if (row && row.state === S.STATES.LIVE && endRow(row, move, now) && move) residentsChanged(row.systemId);
  }

  function doWarpOff(seam, g, now) {
    const r = safeCall(() => seam.warpOff(g.systemId, [g.bossId], g.aggressorId), null);
    if (r && r.ok === true && r.ordered.includes(g.bossId)) {
      g.phase = "warp";
      g.phaseAt = now;
      if (g.warpOffAt === null) g.warpOffAt = now;
      bump("warpOff");
    }
  }

  function fleeNoGate(seam, g, now, reason) {
    if (g.fleeMode !== "warpOff") {
      g.fleeMode = "warpOff";
      bump("fleeNoGate");
      log(`live flee ${g.wantedId} (${g.archetype}) without a gate - ${reason}, warp-off`);
    }
    doWarpOff(seam, g, now);
  }

  function doFlee(seam, g, row, now) {
    if (g.fleeMode === "warpOff") {
      doWarpOff(seam, g, now);
      return;
    }
    if (P.escapeViaGate !== true || typeof seam.fleeToGate !== "function") {
      fleeNoGate(seam, g, now, P.escapeViaGate !== true ? "escapeViaGate off" : "SEAM_UNAVAILABLE");
      return;
    }
    if (g.escape === null) {
      const pick = safeCall(() => deps.pickEscape(row, now), null);
      if (!pick || pick.ok !== true) {
        fleeNoGate(seam, g, now, "NO_ESCAPE");
        return;
      }
      g.escape = { systemId: pick.systemId, nextMoveAt: pick.nextMoveAt };
    }
    const r = safeCall(() => seam.fleeToGate(g.systemId, g.bossId, g.escape.systemId,
      { landingMeters: P.gateLandingMeters, jumpRangeMeters: P.gateJumpRangeMeters }), null);
    const reason = String((r && r.reason) || "no_result");
    if (!r || (r.ok !== true && FLEE_FALLBACK_REASONS.includes(reason))) {
      fleeNoGate(seam, g, now, `${reason}${r && r.detail ? ` (${r.detail})` : ""}`);
      return;
    }
    if (r.ok !== true && reason !== "ORDER_FAILED") return;
    bump(g.fleeCount === 0 ? "fleeGate" : "fleeRetry");
    g.fleeCount += 1;
    if (r.ok === true && r.mode === "approach") bump("fleeApproach");
    if (g.phase !== "gate") {
      g.phase = "gate";
      g.phaseAt = now;
    }
    g.fleeAt = now;
    if (r.ok === true) g.gateId = r.gateId;
    g.gateMode = r.ok === true ? r.mode : null;
    if (g.warpOffAt === null) g.warpOffAt = now;
  }

  function escapeViaGate(seam, g, row, now) {
    const to = g.escape.systemId;
    if (P.gateControllerEventsEnabled === true && isId(g.gateId) && typeof seam.presentGateDeparture === "function") {
      const r = safeCall(() => seam.presentGateDeparture(g.systemId, g.bossId, g.gateId), null);
      if (r && r.ok === true && r.sent === true) bump("gateDepartureEvents");
    }
    end(seam, g, row, { systemId: to, nextMoveAt: g.escape.nextMoveAt }, now, "escaped", false);
    bump("gateJump");
    if (P.followSpawnWindowMs > 0) {
      arrivals.set(g.wantedId, { fromSystemId: g.systemId, toSystemId: to, until: now + P.followSpawnWindowMs });
    }
    log(`live escape ${g.wantedId} ${g.archetype} ${g.systemId}->${to} via gate ${g.gateId}`);
  }

  function noteWake(r, wantedId, archetype) {
    const w = r && r.wake;
    if (!w || typeof w !== "object") return;
    bump("liveWoken", Number.isSafeInteger(w.woken) ? w.woken : 0);
    const failed = Number.isSafeInteger(w.failed) ? w.failed : 0;
    if (failed > 0) {
      bump("liveWakeFailed", failed);
      log(`live wake ${wantedId} (${archetype}) refused for ${failed} ship(s)`);
    }
  }

  function spawnAmbush(seam, g) {
    g.ambushDone = true;
    if (g.pendingEscorts.length === 0) return;
    const r = safeCall(() => seam.spawnGroup({ systemId: g.systemId, anchor: { kind: "entity", entityId: g.bossId },
      factionId: g.factionId, boss: null, escorts: g.pendingEscorts, slimName: null, archetype: g.archetype,
      seedKey: g.wantedId }), null);
    if (!r || r.ok !== true || r.escortIds.length === 0) {
      log(`ambush escort ${g.wantedId} refused - ${(r && r.reason) || "no_result"}`);
      return;
    }
    noteWake(r, g.wantedId, g.archetype);
    safeCall(() => seam.markShips(r.escortIds, { wantedId: g.wantedId, version: g.version, role: "escort",
      cap: P.victimRegisterCap }), null);
    g.ids.push(...r.escortIds);
    g.allIds.push(...r.escortIds);
    bump("ambush");
  }

  function handleGroup(seam, presence, g, now) {
    if (pendingKills.has(g.wantedId)) return;
    if (g.killedAt !== null) {
      if (now >= g.killedAt + P.killedDespawnMs) {
        release(seam, g, null);
        groups.delete(g.wantedId);
      }
      return;
    }
    const row = ram.get(g.wantedId);
    if (!row || row.state !== S.STATES.LIVE || row.version !== g.version) {
      release(seam, g, null);
      groups.delete(g.wantedId);
      return;
    }
    const piloted = spaceIn(presence, g.systemId) >= 1;
    if (piloted) g.lastPlayerSeenAt = now;
    if (now - g.lastPlayerSeenAt >= P.idleDespawnMs) {
      end(seam, g, row, null, now, "despawned", false);
      return;
    }
    const read = safeCall(() => seam.readAggression(g.systemId, g.ids), null);
    if (!read || read.ok !== true) {
      if (read && read.reason === "SCENE_NOT_LOADED") {
        end(seam, g, row, null, now, piloted ? "lostScene" : "despawned", piloted);
      }
      return;
    }
    const byId = new Map(read.ships.map((s) => [s.entityId, s]));
    g.ids = g.ids.filter((id) => byId.get(id) && byId.get(id).alive);
    const boss = byId.get(g.bossId);
    if (g.phase === "jumping") {
      if (now - g.jumpAt >= P.gateJumpDespawnMs || !boss || !boss.alive) escapeViaGate(seam, g, row, now);
      return;
    }
    if (!boss || !boss.alive) {
      if (g.phase === "warp") {
        if (now - g.phaseAt < P.escapeConfirmMs) return;
        const pick = g.escape || safeCall(() => deps.pickEscape(row, now), null);
        end(seam, g, row, pick && (pick === g.escape || pick.ok === true)
          ? { systemId: pick.systemId, nextMoveAt: pick.nextMoveAt } : null, now, "escaped", false);
        return;
      }
      end(seam, g, row, null, now, "lostScene", true);
      return;
    }
    if (isId(boss.aggressorId)) {
      g.aggressorId = boss.aggressorId;
      if (g.firstAggressionAt === null) {
        g.firstAggressionAt = now;
        if (g.archetype === RUNNER) doFlee(seam, g, row, now);
      }
    }
    if (g.archetype === SMUGGLER && g.phase === "idle" && g.firstAggressionAt !== null
      && now >= g.firstAggressionAt + P.smugglerWarpOffDelayMs) {
      doFlee(seam, g, row, now);
    }
    if (g.phase === "gate" && !boss.inWarp) {
      if (g.gateId !== null) {
        const j = safeCall(() => seam.jumpAtGate(g.systemId, g.bossId, g.gateId,
          { jumpRangeMeters: P.gateJumpRangeMeters }), null);
        if (j && j.ok === true && j.jumped === true) {
          g.phase = "jumping";
          g.phaseAt = now;
          g.jumpAt = now;
          return;
        }
      }
      if (now - g.fleeAt >= P.fleeRetryMs) doFlee(seam, g, row, now);
    }
    if (g.archetype === AMBUSH && !g.ambushDone && g.firstAggressionAt !== null
      && now >= g.firstAggressionAt + P.ambushDelayMs) {
      spawnAmbush(seam, g);
    }
    if (g.archetype === RUNNER && g.firstAggressionAt !== null) {
      if (g.phase === "idle") {
        doFlee(seam, g, row, now);
      } else if (P.runnerWarpRetryMs > 0) {
        if ((g.phase === "warp" || (g.phase === "gate" && g.gateMode !== "approach"))
          && now - g.phaseAt >= P.runnerWarpRetryMs && !boss.inWarp && isId(g.aggressorId)) {
          const r = safeCall(() => seam.orderAttack(g.systemId, g.bossId, g.aggressorId), null);
          if (r && r.ok === true) {
            g.phase = "fight";
            g.phaseAt = now;
            bump("runnerFightBack");
          }
        } else if (g.phase === "fight" && now - g.phaseAt >= P.runnerWarpRetryMs) {
          doFlee(seam, g, row, now);
        }
      }
    }
  }

  function lootOf(row, smuggler) {
    const byType = new Map();
    for (const it of planBountyLoot(row.seed, row.level, smuggler, LOOT)) byType.set(it.typeId, it.quantity);
    if (row.level >= LOOT.OFFICER_LOOT_MIN_LEVEL && typeof deps.rollOfficerLoot === "function") {
      const o = safeCall(() => deps.rollOfficerLoot(row.factionId, officerLootSeedOf(row.seed)), null);
      if (o && o.ok === true && Array.isArray(o.items)) {
        for (const it of o.items) {
          if (isId(it.typeId) && isId(it.quantity)) byType.set(it.typeId, (byType.get(it.typeId) || 0) + it.quantity);
        }
        bump("lootSkipped", o.skipped || 0);
      } else {
        bump("lootSkipped");
      }
    }
    const all = [...byType].sort((a, b) => a[0] - b[0]).map(([typeId, quantity]) => ({ typeId, quantity }));
    if (all.length > MAX_CARGO) bump("lootSkipped", all.length - MAX_CARGO);
    return all.slice(0, MAX_CARGO);
  }

  function groupSizeOf(row) {
    const smuggler = row.smuggler === 1 && P.smugglerEnabled === true;
    const archetype = smuggler ? SMUGGLER : row.smuggler === 1 ? RUNNER : row.archetype;
    const levelData = levels[row.level];
    const boss = levelData && BOSS_SPAWN[levelData.boss] ? 1 : 0;
    const escorts = archetype === AMBUSH ? 0
      : escortsOf(row, levels, P.maxShipsPerTarget, smuggler ? SMUGGLER_EXTRA_ESCORTS : 0).length;
    return boss + escorts;
  }

  function spawnOne(seam, row, secClass, now) {
    if (!safeCall(() => seam.isSceneLoaded(row.systemId), false)) return;
    if (typeof deps.admitScene === "function") {
      const gate = safeCall(() => deps.admitScene(row.systemId, groupSizeOf(row), "bounty"), null);
      if (gate && gate.ok === false) {
        bump("liveSceneRefused");
        retryAt.set(row.wantedId, now + P.liveRetryMs);
        return;
      }
    }
    const marked = write("bounty.live", (tx) => R.markLiveInTx(tx, row, now));
    if (!marked.ok) return;
    const live = marked.target;
    const smuggler = live.smuggler === 1 && P.smugglerEnabled === true;
    const archetype = smuggler ? SMUGGLER : live.smuggler === 1 ? RUNNER : live.archetype;
    const levelData = levels[live.level];
    const hullBoss = levelData ? BOSS_SPAWN[levelData.boss] : null;
    const boss = hullBoss && smuggler ? { kind: "freighter", hullClass: hullBoss.hullClass,
      jump: live.level >= SMUGGLER_JUMP_FREIGHTER_LEVEL } : hullBoss;
    const escorts = escortsOf(live, levels, P.maxShipsPerTarget, smuggler ? SMUGGLER_EXTRA_ESCORTS : 0);
    const name = deps.characterNameOf ? slimNameOf(safeCall(() => deps.characterNameOf(live.characterId), null)) : null;
    const cargo = P.lootEnabled === true ? lootOf(live, smuggler) : [];
    const arrival = arrivals.get(live.wantedId) || null;
    arrivals.delete(live.wantedId);
    const belt = { kind: "belt", index: live.stayIndex, gateFallback: secClass !== "highsec" };
    const anchor = arrival && arrival.until > now && arrival.toSystemId === live.systemId
      ? { kind: "gateTo", systemId: arrival.fromSystemId, index: belt.index, gateFallback: belt.gateFallback } : belt;
    const r = boss ? safeCall(() => seam.spawnGroup({ systemId: live.systemId, anchor,
      factionId: live.factionId, boss, escorts: archetype === AMBUSH ? [] : escorts, slimName: name, archetype,
      seedKey: live.wantedId, ...(cargo.length > 0 ? { cargo } : {}),
      ...(anchor.kind === "gateTo" && P.gateControllerEventsEnabled === true ? { gateEvents: true } : {}) }), null)
      : { ok: false, reason: "NO_PROFILE", detail: "level" };
    if (!r || r.ok !== true || !isId(r.bossId)) {
      const reason = String((r && r.reason) || "no_result");
      bump(reason === "SCENE_NPC_BUDGET" ? "liveSceneRefused" : "spawnFailed");
      if (reason === "NO_ANCHOR") bump("liveNoAnchor");
      retryAt.set(live.wantedId, now + P.liveRetryMs);
      if (r && r.ok === true) safeCall(() => seam.despawn(live.systemId, r.escortIds), null);
      log(`live spawn ${live.wantedId} in ${live.systemId} refused - ${reason}${r && r.detail ? ` (${r.detail})` : ""}`);
      endRow(live, null, now);
      return;
    }
    const ids = [r.bossId, ...r.escortIds];
    if (r.cargo) {
      bump("lootItems", r.cargo.seeded);
      bump("lootSkipped", r.cargo.skipped);
    }
    if (smuggler) bump("smugglerSpawned");
    if (anchor.kind === "gateTo" && r.arrivalGate === true) bump("arrivalSpawn");
    if (Number.isSafeInteger(r.arrivals) && r.arrivals > 0) bump("gateArrivalEvents", r.arrivals);
    noteWake(r, live.wantedId, archetype);
    safeCall(() => seam.markShips([r.bossId], { wantedId: live.wantedId, version: live.version, role: "boss",
      cap: P.victimRegisterCap }), null);
    if (r.escortIds.length > 0) {
      safeCall(() => seam.markShips(r.escortIds, { wantedId: live.wantedId, version: live.version, role: "escort",
        cap: P.victimRegisterCap }), null);
    }
    groups.set(live.wantedId, { wantedId: live.wantedId, systemId: live.systemId, factionId: live.factionId,
      version: live.version, archetype, bossId: r.bossId, ids: ids.slice(), allIds: ids.slice(),
      pendingEscorts: archetype === AMBUSH ? escorts : [], spawnedAt: now, firstAggressionAt: null, aggressorId: null,
      warpOffAt: null, phase: "idle", phaseAt: now, ambushDone: archetype !== AMBUSH, lastPlayerSeenAt: now,
      killedAt: null,
      escape: null, gateId: null, gateMode: null, fleeAt: now, fleeCount: 0, jumpAt: null, fleeMode: null });
    bump("live");
  }

  function endAll(now, writeRows) {
    const seam = sceneOf();
    arrivals.clear();
    for (const g of [...groups.values()]) {
      release(seam, g, null);
      groups.delete(g.wantedId);
      const row = ram.get(g.wantedId);
      if (writeRows && g.killedAt === null && !pendingKills.has(g.wantedId) && row && row.state === S.STATES.LIVE) {
        bump("liveDisabled");
        endRow(row, null, now);
      }
    }
  }

  function step(now) {
    for (const [wantedId, k] of [...pendingKills]) {
      bossKill(wantedId, k, true);
      if (pendingKills.has(wantedId) && now - k.at >= P.killRetryMaxMs) {
        pendingKills.delete(wantedId);
        bump("killGaveUp");
        log(`kill ${wantedId} dropped - refused for ${now - k.at} ms`);
      }
    }
    for (const wantedId of [...orphans.keys()]) {
      if (pendingKills.has(wantedId)) continue;
      const row = ram.get(wantedId);
      if (!row || row.state !== S.STATES.LIVE || groups.has(wantedId)) orphans.delete(wantedId);
      else endRow(row, null, now);
    }
    if (P.liveEnabled !== true) {
      if (groups.size > 0) endAll(now, true);
      return { groups: 0, spawned: 0 };
    }
    const seam = sceneOf();
    const presence = presenceOf();
    if (!seam || !presence) return { groups: groups.size, spawned: 0 };
    for (const g of [...groups.values()]) handleGroup(seam, presence, g, now);
    for (const [id, at] of retryAt) if (at <= now) retryAt.delete(id);
    for (const [id, a] of arrivals) if (a.until <= now) arrivals.delete(id);
    const active = [...groups.values()].filter((g) => g.killedAt === null).length;
    const candidates = [];
    for (const systemId of safeCall(() => presence.observedSystems(), []) || []) {
      const rows = ram.bySystem(systemId);
      if (rows.length === 0 || spaceIn(presence, systemId) < 1) continue;
      for (const row of rows) {
        if (row.state !== S.STATES.ROAMING || row.expiresAt <= now || groups.has(row.wantedId)) continue;
        if ((retryAt.get(row.wantedId) || 0) > now) {
          bump("liveRetryWait");
          continue;
        }
        candidates.push(row);
      }
    }
    if (candidates.length === 0) return { groups: groups.size, spawned: 0 };
    candidates.sort(byLevelThenId);
    const room = Math.max(0, Math.min(P.liveSpawnsPerPass, P.maxLive - active));
    let spawned = 0;
    for (const row of candidates.slice(0, room)) {
      const before = groups.size;
      spawnOne(seam, row, safeCall(() => deps.secClassOf(row.systemId), null), now);
      if (groups.size > before) spawned += 1;
    }
    if (candidates.length > room) bump("liveDeferred", candidates.length - room);
    return { groups: groups.size, spawned };
  }

  function onNpcKill(obs, now) {
    if (!obs || typeof obs.wantedId !== "string" || !isId(obs.version) || !isId(obs.characterId)
      || (obs.role !== "boss" && obs.role !== "escort")) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const g = groups.get(obs.wantedId) || null;
    if (obs.role === "escort") {
      const r = write("bounty.kill", (tx) => R.escortLostInTx(tx, obs.wantedId, obs.version, now));
      if (!r.ok) return r.reason === "CAS_LOST" ? { ok: true, outcome: "NOOP" } : { ok: false, reason: r.reason };
      if (g) g.ids = g.ids.filter((id) => id !== obs.victimId);
      bump("escortLost");
      return { ok: true, outcome: "ESCORT_LOST" };
    }
    return bossKill(obs.wantedId, { characterId: obs.characterId, version: obs.version, victimId: obs.victimId,
      at: now }, false);
  }

  function bossKill(wantedId, k, retry) {
    let journaled = null;
    let revenged = null;
    const r = write("bounty.kill", (tx) => {
      journaled = null;
      revenged = null;
      const killed = R.killInTx(tx, wantedId, k.version, k.characterId, k.at);
      if (killed.ok && deps.journal && typeof deps.journal.applyOnce === "function") {
        journaled = deps.journal.applyOnce(tx, { key: `${killed.payout.payoutKey}:claimed`,
          aggregate: { type: S.BOUNTY_AGGREGATE, id: wantedId }, eventType: S.EVENT_BOUNTY_CLAIMED,
          payload: { wantedId, level: killed.target.level, factionId: killed.target.factionId, at: k.at } },
        () => ({ ok: true }));
      }
      if (killed.ok && typeof deps.revengeInTx === "function") {
        revenged = deps.revengeInTx(tx, killed.target, k.characterId, k.at);
      }
      return killed;
    });
    if (r.ok && journaled && journaled.ok !== true) {
      bump("claimJournalFailed");
      log(`kill ${wantedId} news fact refused - ${String(journaled.reason || "no_result")}`);
    }
    if (!r.ok) {
      if (r.reason === "INVALID_INPUT") {
        pendingKills.delete(wantedId);
        return { ok: false, reason: r.reason };
      }
      if (r.reason !== "CAS_LOST") {
        bump("killRetry");
        if (!pendingKills.has(wantedId)) log(`kill ${wantedId} refused - ${r.reason}, retried every pass`);
        pendingKills.set(wantedId, k);
        return { ok: false, reason: r.reason };
      }
      pendingKills.delete(wantedId);
      bump("killLate");
      return { ok: true, outcome: "NOOP" };
    }
    pendingKills.delete(wantedId);
    const g = groups.get(wantedId) || null;
    if (g) {
      g.killedAt = k.at;
      g.ids = g.ids.filter((id) => id !== k.victimId);
    }
    retryAt.delete(wantedId);
    bump("killed");
    if (retry) log(`kill ${wantedId} settled on retry`);
    residentsChanged(r.target.systemId);
    if (typeof deps.onKilled === "function") {
      safeCall(() => deps.onKilled({ target: r.target, payout: r.payout, characterId: k.characterId, at: k.at,
        revenge: revenged }), null);
    }
    return { ok: true, outcome: "KILLED" };
  }

  return {
    step,
    onNpcKill,
    stop: () => endAll(0, false),
    status: () => Object.freeze({ groups: groups.size, retryWaiting: retryAt.size, orphans: orphans.size,
      pendingKills: pendingKills.size,
      live: [...groups.values()].map((g) => Object.freeze({ wantedId: g.wantedId, systemId: g.systemId,
        archetype: g.archetype, ships: g.ids.length, phase: g.killedAt !== null ? "killed" : g.phase })) }),
  };
}

module.exports = { createLiveStep, escortsOf, slimNameOf, LIVE_COUNTER_NAMES };
