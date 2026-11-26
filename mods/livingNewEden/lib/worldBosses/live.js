"use strict";

const { createAbortSentinel } = require("../persistence/store");
const { STATE: SITE_STATE } = require("../events/sites/schema");
const S = require("./schema");
const M = require("./machine");
const { topFactionOf } = require("./clash");

const LIVE_CLASS = "OPERATIONAL";
const OPEN_SCAN_LIMIT = 16;
const SUBSTITUTE = Object.freeze({ dreadnought: "battleship" });
const LIVE_ABORT = createAbortSentinel("worldBosses.LIVE_REFUSED");

const messageOf = (err) => String((err && err.message) || err).slice(0, 160);

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function parseUnits(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (_err) {
    return {};
  }
}

function createLive(env) {
  const { store, repo, kinds, settings: P } = env;
  const L = P.live;
  const bootAt = env.bootAt;
  const bump = (name, n) => safe(() => env.bump(name, n), null);
  const refuse = (line) => safe(() => env.refuse(line), null);
  const getter = (name) => () => safe(() => (typeof env[name] === "function" ? env[name]() : null), null);
  const getScene = getter("getScene");
  const getPresence = getter("getPresence");
  const getSites = getter("getSites");
  const getGovernor = getter("getGovernor");
  const memory = new Map();
  const refused = new Map();
  let strays = [];

  const liveCount = () => {
    let n = 0;
    for (const entry of memory.values()) n += entry.spawned.size;
    return n;
  };

  const strayCount = () => {
    let n = 0;
    for (const item of strays) n += item.ids.length;
    return n;
  };

  const visitKeyOf = (row) => `${row.visitNo}:${row.phase}`;

  function isRefused(row, now) {
    const m = refused.get(row.bossId);
    return Boolean(m) && m.key === visitKeyOf(row) && (m.until === null || now < m.until);
  }

  function markRefused(row, permanent, now) {
    refused.set(row.bossId, { key: visitKeyOf(row), until: permanent ? null : now + L.spawnRetryCooldownMs });
  }

  const newEntry = (row, anchor, now) => ({ systemId: row.systemId, phase: row.phase, visitNo: row.visitNo,
    anchor: { ...anchor }, spawned: new Map(), skipped: new Map(), retries: new Map(), lastGridSeenAt: now,
    seen: new Set() });

  const phaseDefOf = (row) => {
    const entry = kinds.get(row.kind);
    return entry ? entry.phases[row.phase - 1] || null : null;
  };

  function governorOk() {
    const g = getGovernor();
    return !g || typeof g.admits !== "function" || safe(() => g.admits(LIVE_CLASS), true) !== false;
  }

  function write(name, fn) {
    const r = store.transaction(`worldBosses.${name}`, fn);
    if (r.ok) return r.value;
    if (r.error !== LIVE_ABORT) bump("passErrors");
    refuse(`LIVE ${name} ${r.reason || "TX_FAILED"}${r.error && r.error !== LIVE_ABORT ? ` ${messageOf(r.error)}` : ""}`);
    return null;
  }

  function despawnIds(seam, systemId, ids) {
    if (ids.length === 0) return;
    if (!seam) {
      strays.push({ systemId, ids: ids.slice() });
      return;
    }
    const r = safe(() => seam.despawn(systemId, ids), { ok: false, reason: "DESPAWN_THREW" });
    if (r && r.ok === true) return;
    const failed = r && Array.isArray(r.failed) ? r.failed : ids;
    if (failed.length > 0) strays.push({ systemId, ids: failed.slice() });
    refuse(`LIVE DESPAWN ${systemId} ${(r && r.reason) || "DESPAWN_FAILED"}`);
  }

  function retryStrays(seam) {
    if (strays.length === 0 || !seam) return;
    const list = strays;
    strays = [];
    for (const item of list) despawnIds(seam, item.systemId, item.ids);
  }

  function spawnWave(seam, row, anchor, wave, phaseDef) {
    const hasFlagship = phaseDef.units.some((u) => Boolean(u.profileId));
    const r = safe(() => seam.spawnPhase(row.systemId, { eventId: S.beaconEventIdOf(row.bossId, row.visitNo),
      factionId: row.factionId, anchorPoint: anchor, spawnDistanceM: L.spawnDistanceM, aggroRangeM: L.aggroRangeM,
      leashRangeM: L.leashRangeM, members: wave.map((u) => ({ memberKey: u.unitKey, hullGroup: u.hullGroup,
        ...(u.profileId ? { profileId: u.profileId } : {}) })), ...(hasFlagship ? {} : { substitute: SUBSTITUTE }) }),
    { ok: false, reason: "SPAWN_THREW" });
    if (r && r.ok === true && Array.isArray(r.spawned) && Array.isArray(r.unspawnable)) return r;
    if (r && Array.isArray(r.leftover) && r.leftover.length > 0) despawnIds(seam, row.systemId, r.leftover);
    refuse(`LIVE SPAWN ${row.bossId} ${(r && r.reason) || "SPAWN_FAILED"}${r && r.detail ? ` ${r.detail}` : ""}`);
    return { ok: false };
  }

  function takeWave(entry, wave, sp) {
    const byKey = new Map(wave.map((u) => [u.unitKey, u]));
    const ids = [];
    for (const x of sp.spawned) {
      const u = byKey.get(x.memberKey);
      if (!u || !Number.isSafeInteger(x.entityId)) continue;
      entry.spawned.set(u.unitKey, { entityId: x.entityId, hpBefore: u.hp, flagship: u.flagship });
      entry.retries.delete(u.unitKey);
      ids.push(x.entityId);
    }
    let flagshipRefused = null;
    let retried = 0;
    let allNoProfile = true;
    for (const x of sp.unspawnable) {
      const u = byKey.get(x.memberKey);
      if (!u) continue;
      const reason = x && typeof x.reason === "string" && x.reason ? x.reason : "SPAWN_FAILED";
      if (reason === "NO_PROFILE") {
        entry.skipped.set(u.unitKey, "NO_PROFILE");
        if (u.flagship) flagshipRefused = "NO_PROFILE";
        continue;
      }
      allNoProfile = false;
      const n = (entry.retries.get(u.unitKey) || 0) + 1;
      if (n <= L.spawnRetries) {
        entry.retries.set(u.unitKey, n);
        retried += 1;
        continue;
      }
      entry.skipped.set(u.unitKey, reason);
      if (u.flagship && flagshipRefused === null) flagshipRefused = "SPAWN_FAILED";
    }
    return { flagshipRefused, ids, retried, allNoProfile };
  }

  const takenOf = (entry) => new Set([...entry.spawned.keys(), ...entry.skipped.keys()]);

  const skippedAliveOf = (entry, units) => {
    let n = 0;
    for (const unitKey of entry.skipped.keys()) if (Number(units[unitKey]) >= 1) n += 1;
    return n;
  };

  function seePlayers(entry, grid) {
    const players = grid && grid.ok === true && Array.isArray(grid.players) ? grid.players : [];
    for (const p of players) if (p && Number.isSafeInteger(p.characterId) && p.characterId > 0) entry.seen.add(p.characterId);
    return players.length;
  }

  function currentInTx(tx, bossId, mode) {
    const got = repo.getInTx(tx, bossId);
    if (!got.ok || !got.row || got.row.mode !== mode || !S.OPEN_STATES.includes(got.row.state)) throw LIVE_ABORT;
    return got.row;
  }

  function participantsInTx(tx, entry, bossId, phase, now) {
    if (entry.seen.size === 0) return 0;
    const r = repo.upsertParticipantsInTx(tx, bossId, [...entry.seen], phase, now, L.maxParticipants);
    if (!r.ok) throw LIVE_ABORT;
    return r.overflow;
  }

  function afterParticipants(entry, overflow) {
    entry.seen = new Set();
    bump("liveParticipantsOverflow", overflow);
  }

  function tryStart(seam, row, site, now) {
    const phaseDef = phaseDefOf(row);
    if (!phaseDef) return;
    if (isRefused(row, now)) return;
    const grid = safe(() => seam.readGrid(row.systemId, site.position, L.gridRadiusM), { ok: false });
    const sceneLoaded = Boolean(grid && grid.ok === true);
    const players = sceneLoaded && Array.isArray(grid.players) ? grid.players.length : 0;
    const regen = M.unitsAt({ units_json: row.unitsJson, hp_at: row.hpAt }, now, phaseDef, P);
    const pool = M.nextWave(phaseDef, regen.units, null, Number.MAX_SAFE_INTEGER);
    const d = M.decideLive(row, { now, gridPlayers: players, sceneLoaded, lastGridSeenAt: null, alive: 0,
      pendingUnits: pool.length, openClashes: row.openClashes.length, governorOk: governorOk(),
      room: L.maxShipsPerPhase - liveCount() - strayCount() }, L);
    if (d.action === "HOLD" && d.reason === "BUDGET") bump("liveRefusedBudget");
    if (d.action !== "START") return;
    const wave = pool.slice(0, d.count);
    const sp = spawnWave(seam, row, site.position, wave, phaseDef);
    if (!sp.ok) return;
    const entry = newEntry(row, site.position, now);
    const taken = takeWave(entry, wave, sp);
    const flagshipReasons = [];
    const flagshipKeys = new Set(wave.filter((u) => u.flagship).map((u) => u.unitKey));
    for (const x of sp.unspawnable) {
      if (x && flagshipKeys.has(x.memberKey)) flagshipReasons.push(x.reason === "NO_PROFILE" ? "NO_PROFILE" : "OTHER");
    }
    if (flagshipReasons.length > 0 || taken.ids.length === 0) {
      despawnIds(seam, row.systemId, taken.ids);
      const permanent = flagshipReasons.includes("NO_PROFILE")
        || (flagshipReasons.length === 0 && sp.unspawnable.length > 0 && taken.allNoProfile);
      markRefused(row, permanent, now);
      bump("liveRefusedProfile");
      return;
    }
    seePlayers(entry, grid);
    const patch = regen.changed ? { unitsJson: JSON.stringify(regen.units), hpAt: now } : {};
    const done = write("liveStart", (tx) => {
      const current = currentInTx(tx, row.bossId, S.MODES.VIRTUAL);
      if (current.version !== row.version || current.state !== S.STATES.DWELL || current.openClashes.length > 0) {
        throw LIVE_ABORT;
      }
      const r = repo.liveStartInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
        to: current.state, now, bootAt, patch }, { key: S.keyLiveStart(row.bossId, row.visitNo, current.version),
        eventType: S.EVENT.LIVE, payload: { bossId: row.bossId, action: "START", phase: row.phase,
          ships: taken.ids.length } });
      if (!r.ok || r.duplicate === true) throw LIVE_ABORT;
      return true;
    });
    if (!done) {
      despawnIds(seam, row.systemId, taken.ids);
      return;
    }
    refused.delete(row.bossId);
    memory.set(row.bossId, entry);
    bump("liveStarted");
    bump("liveShips", taken.ids.length);
    if (taken.retried > 0) bump("liveSpawnRetry", taken.retried);
  }

  function exit(seam, row, entry, now, reason) {
    despawnIds(seam, entry.systemId, [...entry.spawned.values()].map((x) => x.entityId));
    entry.spawned = new Map();
    const r = write("liveExit", (tx) => {
      const current = currentInTx(tx, row.bossId, S.MODES.LIVE);
      const overflow = participantsInTx(tx, entry, row.bossId, current.phase, now);
      const w = repo.liveExitInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
        to: current.state, now }, { key: S.keyLiveExit(row.bossId, current.version), eventType: S.EVENT.LIVE,
        payload: { bossId: row.bossId, action: "EXIT", reason } });
      if (!w.ok) throw LIVE_ABORT;
      return { overflow };
    });
    memory.delete(row.bossId);
    if (!r) return;
    afterParticipants(entry, r.overflow);
    bump("liveEnded");
  }

  function lossesInTx(tx, row, entry, keys, now) {
    let current = currentInTx(tx, row.bossId, S.MODES.LIVE);
    const phase = current.phase;
    let written = 0;
    for (const unitKey of keys) {
      const units = parseUnits(current.unitsJson);
      if (!(Number(units[unitKey]) > 0)) continue;
      units[unitKey] = 0;
      const w = repo.liveLossInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
        to: current.state, now, patch: { unitsJson: JSON.stringify(units), hpAt: Math.max(current.hpAt, now) } },
      { key: S.keyLiveLoss(row.bossId, phase, unitKey), eventType: S.EVENT.LIVE, payload: { bossId: row.bossId,
        action: "LOSS", phase, unitKey } });
      if (!w.ok) throw LIVE_ABORT;
      if (w.row) current = w.row;
      if (w.duplicate !== true) written += 1;
    }
    const overflow = participantsInTx(tx, entry, row.bossId, phase, now);
    return { row: current, overflow, written };
  }

  function nextPhase(seam, row, entry, now) {
    const kind = kinds.get(row.kind);
    const nextDef = kind ? kind.phases[row.phase] : null;
    if (!nextDef) return;
    const r = write("livePhase", (tx) => {
      const current = currentInTx(tx, row.bossId, S.MODES.LIVE);
      if (current.phase !== row.phase) throw LIVE_ABORT;
      const overflow = participantsInTx(tx, entry, row.bossId, current.phase, now);
      const w = repo.livePhaseInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
        to: current.state, now, patch: { phase: current.phase + 1, unitsJson: JSON.stringify(M.phaseUnits(nextDef)),
          hpAt: now } }, { key: S.keyLivePhase(row.bossId, current.phase), eventType: S.EVENT.LIVE,
        payload: { bossId: row.bossId, action: "NEXT_PHASE", phase: current.phase + 1 } });
      if (!w.ok) throw LIVE_ABORT;
      return { overflow };
    });
    if (!r) return;
    afterParticipants(entry, r.overflow);
    entry.phase = row.phase + 1;
    entry.skipped = new Map();
    entry.retries = new Map();
    bump("phaseCleared");
  }

  function defeat(seam, row, entry, now) {
    const r = write("liveDefeat", (tx) => {
      const current = currentInTx(tx, row.bossId, S.MODES.LIVE);
      const overflow = participantsInTx(tx, entry, row.bossId, current.phase, now);
      const keepBeacon = Boolean(P.rewards && P.rewards.enabled === true);
      if (!keepBeacon) env.cleanupInTx(tx, current.siteEventId, "EVENT_END");
      const top = topFactionOf(current.damageBy);
      const w = repo.livePhaseInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
        to: S.STATES.DEFEATED, now, patch: { endedAt: now, endReason: S.END_REASONS.DEFEATED,
          siteEventId: keepBeacon ? current.siteEventId : null, rewardState: S.REWARD_STATES.PENDING, topFactionId: top, stepSeq: current.stepSeq + 1, hpAt: now } },
      { key: S.keyEnd(row.bossId), eventType: S.EVENT.ENDED, payload: { bossId: row.bossId, kind: current.kind,
        factionId: current.factionId, systemId: current.systemId, regionId: current.regionId,
        outcome: S.STATES.DEFEATED, reason: S.END_REASONS.DEFEATED, topFactionId: top, mode: S.MODES.LIVE } });
      if (!w.ok || w.duplicate === true || !w.row) throw LIVE_ABORT;
      return { overflow, row: w.row };
    });
    if (!r) return;
    memory.delete(row.bossId);
    afterParticipants(entry, r.overflow);
    bump("phaseCleared");
    bump("defeated");
    bump("liveEnded");
    safe(() => env.onEnd(r.row), null);
  }

  function step(seam, row, entry, now) {
    const phaseDef = phaseDefOf(row);
    const ids = [...entry.spawned.values()].map((x) => x.entityId);
    const mem = safe(() => seam.readMembers(row.systemId, ids), { ok: false });
    const sceneLoaded = Boolean(mem && mem.ok === true);
    const grid = sceneLoaded ? safe(() => seam.readGrid(row.systemId, entry.anchor, L.gridRadiusM), { ok: false })
      : { ok: false };
    const players = seePlayers(entry, grid);
    if (players > 0) entry.lastGridSeenAt = now;
    let current = row;
    if (sceneLoaded && row.state === S.STATES.DWELL && phaseDef) {
      const gone = new Set(Array.isArray(mem.gone) ? mem.gone : []);
      const lost = [];
      const unseen = [];
      for (const [unitKey, x] of entry.spawned) {
        if (!gone.has(x.entityId)) continue;
        (players > 0 ? lost : unseen).push(unitKey);
      }
      if (unseen.length > 0) {
        const unseenIds = unseen.map((k) => entry.spawned.get(k).entityId);
        for (const k of unseen) entry.spawned.delete(k);
        despawnIds(seam, row.systemId, unseenIds);
        bump("liveLostUnseen", unseen.length);
      }
      if (lost.length > 0) {
        const r = write("liveLoss", (tx) => lossesInTx(tx, row, entry, lost, now));
        if (!r) return;
        current = r.row;
        afterParticipants(entry, r.overflow);
        const lostIds = lost.map((k) => entry.spawned.get(k).entityId);
        for (const k of lost) entry.spawned.delete(k);
        despawnIds(seam, row.systemId, lostIds);
        bump("liveLost", r.written);
      }
    }
    const kind = kinds.get(current.kind);
    const def = kind ? kind.phases[current.phase - 1] : null;
    const units = def ? M.unitsAt({ units_json: current.unitsJson, hp_at: current.hpAt }, now, def, P).units : {};
    const pool = def ? M.nextWave(def, units, takenOf(entry), Number.MAX_SAFE_INTEGER) : [];
    const d = M.decideLive(current, { now, gridPlayers: players, sceneLoaded, lastGridSeenAt: entry.lastGridSeenAt,
      alive: entry.spawned.size, pendingUnits: pool.length, openClashes: current.openClashes.length,
      governorOk: governorOk(), room: L.maxShipsPerPhase - liveCount() - strayCount(),
      lastPhase: Boolean(kind) && current.phase >= kind.phases.length, skippedUnits: skippedAliveOf(entry, units) }, L);
    if (d.action === "EXIT") {
      if (d.reason === "UNSPAWNABLE") {
        markRefused(current, [...entry.skipped.values()].includes("NO_PROFILE"), now);
        bump("liveExitUnspawnable");
      }
      exit(seam, current, entry, now, d.reason);
    } else if (d.action === "NEXT_PHASE") nextPhase(seam, current, entry, now);
    else if (d.action === "DEFEAT") defeat(seam, current, entry, now);
    else if (d.action === "WAVE") {
      const wave = pool.slice(0, d.count);
      const sp = spawnWave(seam, current, entry.anchor, wave, def);
      if (!sp.ok) return;
      const taken = takeWave(entry, wave, sp);
      bump("liveShips", taken.ids.length);
      if (taken.retried > 0) bump("liveSpawnRetry", taken.retried);
      if (taken.flagshipRefused) {
        markRefused(current, taken.flagshipRefused === "NO_PROFILE", now);
        bump("liveRefusedProfile");
        exit(seam, current, entry, now, taken.flagshipRefused === "NO_PROFILE" ? "NO_PROFILE" : "SPAWN_FAILED");
      }
    }
  }

  function orphan(row, now) {
    const r = write("liveOrphan", (tx) => {
      const current = currentInTx(tx, row.bossId, S.MODES.LIVE);
      const key = current.liveBootAt === bootAt ? S.keyLiveExit(row.bossId, current.version)
        : S.keyRecover(row.bossId, bootAt);
      const w = repo.liveExitInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
        to: current.state, now }, { key, eventType: S.EVENT.LIVE, payload: { bossId: row.bossId,
        action: current.liveBootAt === bootAt ? "EXIT" : "RECOVER", reason: "NO_MEMORY" } });
      if (!w.ok) throw LIVE_ABORT;
      return current.liveBootAt === bootAt ? "exit" : "recovered";
    });
    if (r === "exit") bump("liveEnded");
    else if (r === "recovered") bump("liveRecovered");
  }

  function readWork() {
    const presence = getPresence();
    const observed = (systemId) => Boolean(presence && typeof presence.isObserved === "function"
      && safe(() => presence.isObserved(systemId), false) === true);
    const sites = getSites();
    return store.transaction("worldBosses.liveRead", (tx) => {
      const open = repo.listOpenInTx(tx, OPEN_SCAN_LIMIT);
      if (!open.ok) throw LIVE_ABORT;
      const work = [];
      const openIds = new Set();
      for (const row of open.rows) {
        openIds.add(row.bossId);
        if (row.mode === S.MODES.LIVE) {
          work.push({ row, site: null });
          continue;
        }
        if (row.state !== S.STATES.DWELL || !row.siteEventId || !observed(row.systemId)) continue;
        if (!sites || typeof sites.listSitesByEvent !== "function") continue;
        const listed = sites.listSitesByEvent(row.siteEventId, tx);
        const site = listed && listed.ok === true && Array.isArray(listed.sites)
          ? listed.sites.find((x) => x && x.slot === S.BEACON_SLOT) : null;
        if (site && site.state === SITE_STATE.ACTIVE && site.position) work.push({ row, site });
      }
      return { work, openIds, full: open.rows.length >= OPEN_SCAN_LIMIT };
    });
  }

  function pass(now) {
    if (typeof env.isActive === "function" && env.isActive() !== true) {
      stopAll();
      return;
    }
    const read = readWork();
    if (!read.ok) {
      bump("passErrors");
      refuse(`LIVE read ${read.reason || "TX_FAILED"}`);
      return;
    }
    const { work, openIds, full } = read.value;
    const seam = memory.size > 0 || work.length > 0 || strays.length > 0 ? getScene() : null;
    retryStrays(seam);
    if (!full) {
      for (const [bossId, entry] of [...memory]) {
        if (openIds.has(bossId)) continue;
        despawnIds(seam, entry.systemId, [...entry.spawned.values()].map((x) => x.entityId));
        memory.delete(bossId);
        bump("liveEnded");
      }
    }
    for (const item of work) {
      try {
        const entry = memory.get(item.row.bossId);
        if (item.row.mode === S.MODES.LIVE) {
          if (!entry) orphan(item.row, now);
          else if (seam) step(seam, item.row, entry, now);
          else if (now - entry.lastGridSeenAt >= L.abandonGraceMs) exit(null, item.row, entry, now, "SEAM_UNAVAILABLE");
        } else if (seam && !entry) tryStart(seam, item.row, item.site, now);
      } catch (err) {
        bump("passErrors");
        refuse(`LIVE ${item.row.bossId} ${messageOf(err)}`);
      }
    }
  }

  function recover(now) {
    const r = store.transaction("worldBosses.liveRecoverRead", (tx) => repo.listOpenInTx(tx, OPEN_SCAN_LIMIT));
    const rows = r.ok && r.value && r.value.ok === true ? r.value.rows : [];
    let n = 0;
    for (const row of rows) {
      if (row.mode !== S.MODES.LIVE || row.liveBootAt === bootAt) continue;
      const done = write("liveRecover", (tx) => {
        const current = currentInTx(tx, row.bossId, S.MODES.LIVE);
        if (current.liveBootAt === bootAt) throw LIVE_ABORT;
        const w = repo.liveExitInTx(tx, { bossId: row.bossId, expectedVersion: current.version, from: current.state,
          to: current.state, now: Math.max(now, current.updatedAt) }, { key: S.keyRecover(row.bossId, bootAt),
          eventType: S.EVENT.LIVE, payload: { bossId: row.bossId, action: "RECOVER", liveBootAt: current.liveBootAt } });
        if (!w.ok) throw LIVE_ABORT;
        return w.duplicate !== true;
      });
      if (done) {
        n += 1;
        bump("liveRecovered");
      }
    }
    return n;
  }

  function stopAll() {
    const seam = memory.size > 0 || strays.length > 0 ? getScene() : null;
    retryStrays(seam);
    for (const entry of memory.values()) {
      despawnIds(seam, entry.systemId, [...entry.spawned.values()].map((x) => x.entityId));
    }
    memory.clear();
    strays = [];
  }

  const status = () => Object.freeze({ episodes: memory.size, liveShips: liveCount(), strays: strays.length,
    strayShips: strayCount() });

  return Object.freeze({ pass, recover, stopAll, status, liveCount });
}

module.exports = { createLive, SUBSTITUTE };
