"use strict";

const { performance } = require("node:perf_hooks");
const { defaultSetTimer } = require("../../presence/poller");
const { planGroup, relationOfPlan } = require("./aggroRules");

const METRIC_GROUPS = "world.beltNavy.groups";
const METRIC_ORDERS = "world.beltNavy.orders";
const METRIC_ATTACKS = "world.beltNavy.attacks";
const METRIC_EXPIRED = "world.beltNavy.expired";
const METRIC_FAILED = "world.beltNavy.failed";
const METRIC_PASS_MS = "world.beltNavy.passMs";

const SCENE_NOT_LOADED = "SCENE_NOT_LOADED";
const ATTACK = "ATTACK";
const KIND_BELT = "belt";
const KIND_SITE = "site";
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function positiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createAggroService(deps) {
  const { hunt, scene, spawn, readStanding, getStandings, clock, settings } = deps;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const groups = new Map();
  let timer = null;
  let cursor = 0;
  let stopped = false;
  let failedLogged = false;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n) {
    if (n > 0) metric("count", name, n);
  }

  function noteFailure(where, detail) {
    bump(METRIC_FAILED, 1);
    if (failedLogged) return;
    failedLogged = true;
    try {
      logger.log(`beltNavy: ${where} failed (${detail}); further failures only counted`);
    } catch (_err) {
    }
  }

  function readPlayers(systemId) {
    const read = hunt.readPlayerShips(systemId);
    if (read && read.ok === true) return read.ships;
    if (read && read.reason === SCENE_NOT_LOADED) return [];
    throw new Error(`PLAYERS_${(read && read.reason) || "NO_RESULT"}`);
  }

  function standingReader(factionId, cache) {
    return (characterId) => {
      const key = `${characterId}:${factionId}`;
      if (!cache.has(key)) {
        const read = readStanding(characterId, factionId);
        if (!read || read.ok !== true) noteFailure("standing", (read && read.reason) || "NO_RESULT");
        cache.set(key, read && read.ok === true ? read.standing : NaN);
      }
      return cache.get(key);
    };
  }

  function charge(group, characterId, atMs) {
    const standings = getStandings();
    if (!standings || typeof standings.onNavyPenalty !== "function") return;
    standings.onNavyPenalty({ kind: ATTACK, characterId, factionId: group.factionId, systemId: group.systemId, atMs });
  }

  function give(group, orders) {
    if (orders.length === 0) return;
    const done = scene.orderGroup(group.systemId, orders);
    if (!done || done.ok !== true) {
      if (done && done.reason === SCENE_NOT_LOADED) return;
      noteFailure("order", (done && done.reason) || "NO_RESULT");
      return;
    }
    bump(METRIC_ORDERS, orders.length - done.failed.length);
    if (done.failed.length > 0) noteFailure("order", done.detail || "ORDER_FAILED");
  }

  function paint(group, ships, orders) {
    if (typeof spawn.setRelation !== "function" || ships.length === 0) return;
    const done = spawn.setRelation(group.systemId, ships.map((ship) => ship.entityId), relationOfPlan(ships, orders));
    if (done && done.ok === true) return;
    if (done && done.reason === SCENE_NOT_LOADED) return;
    noteFailure("relation", (done && done.reason) || "NO_RESULT");
  }

  function retire(group) {
    if (group.kind === KIND_SITE) {
      groups.delete(group.spawnSiteId);
      bump(METRIC_EXPIRED, 1);
      return;
    }
    const gone = spawn.despawn(group.systemId, group.entityIds);
    if (!gone || gone.ok !== true) {
      noteFailure("despawn", (gone && gone.reason) || "NO_RESULT");
      return;
    }
    groups.delete(group.spawnSiteId);
    bump(METRIC_EXPIRED, 1);
  }

  function runGroup(group, at, cache) {
    try {
      const players = readPlayers(group.systemId);
      const read = scene.readGroup(group.systemId, group.entityIds);
      if (!read || read.ok !== true) throw new Error(`GROUP_${(read && read.reason) || "NO_RESULT"}`);
      const plan = planGroup(group, { ships: read.ships, players }, standingReader(group.factionId, cache), settings, at);
      for (const [entityId, stamp] of plan.seen) group.seenAggressedAt.set(entityId, stamp);
      for (const characterId of plan.attacks) group.provoked.add(characterId);
      bump(METRIC_ATTACKS, plan.attacks.length);
      for (const characterId of plan.attacks) charge(group, characterId, at);
      if (plan.expire) retire(group);
      else {
        give(group, plan.orders);
        paint(group, read.ships, plan.orders);
      }
    } catch (err) {
      noteFailure("group", messageOf(err));
    }
  }

  function arm() {
    if (stopped || timer !== null || groups.size === 0) return;
    try {
      timer = setTimer(fire, settings.pollMs);
    } catch (err) {
      timer = null;
      noteFailure("timer", messageOf(err));
    }
  }

  function runPass() {
    const t0 = nowMs();
    const list = [...groups.values()];
    const taken = Math.min(settings.maxGroupsPerPass, list.length);
    const at = clock.now();
    const standingCache = new Map();
    for (let i = 0; i < taken; i += 1) runGroup(list[(cursor + i) % list.length], at, standingCache);
    cursor = list.length > 0 ? (cursor + taken) % list.length : 0;
    metric("gauge", METRIC_GROUPS, groups.size);
    metric("observe", METRIC_PASS_MS, Math.round((nowMs() - t0) * 100) / 100);
  }

  function fire() {
    timer = null;
    if (stopped) return;
    try {
      runPass();
    } catch (err) {
      noteFailure("pass", messageOf(err));
    }
    arm();
  }

  function canAccept() {
    return !stopped && groups.size < settings.maxGroups;
  }

  function appendToSite(group, systemId, factionId, entityIds, atMs) {
    if (group.kind !== KIND_SITE || group.systemId !== systemId || group.factionId !== factionId) {
      return { ok: false, reason: "DUPLICATE" };
    }
    for (const id of entityIds) if (!group.entityIds.includes(id)) group.entityIds.push(id);
    runGroup(group, atMs, new Map());
    arm();
    return { ok: true };
  }

  function registerGroup(input) {
    const { spawnSiteId, systemId, factionId, entityIds, atMs } = input || {};
    const kind = input && input.kind !== undefined ? input.kind : KIND_BELT;
    if (stopped) return { ok: false, reason: "STOPPED" };
    if (typeof spawnSiteId !== "string" || spawnSiteId === "" || !positiveId(systemId) || !positiveId(factionId)
      || !Array.isArray(entityIds) || entityIds.length === 0 || !entityIds.every(positiveId)
      || !Number.isFinite(atMs) || (kind !== KIND_BELT && kind !== KIND_SITE)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const existing = groups.get(spawnSiteId);
    if (existing && kind === KIND_SITE) return appendToSite(existing, systemId, factionId, entityIds, atMs);
    if (!canAccept()) return { ok: false, reason: "REGISTRY_FULL" };
    if (existing) return { ok: false, reason: "DUPLICATE" };
    const group = { spawnSiteId, systemId, factionId, entityIds: [...entityIds], spawnedAt: atMs, provoked: new Set(),
      seenAggressedAt: new Map(), kind };
    groups.set(spawnSiteId, group);
    metric("gauge", METRIC_GROUPS, groups.size);
    runGroup(group, atMs, new Map());
    arm();
    return { ok: true };
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "ready", groups: groups.size, timer: timer !== null });
  }

  return Object.freeze({
    canAccept,
    registerGroup,
    runPass,
    getStatus,
    stop() {
      if (stopped) return;
      stopped = true;
      groups.clear();
      if (timer === null) return;
      const handle = timer;
      timer = null;
      try {
        handle.cancel();
      } catch (_err) {
      }
    },
  });
}

module.exports = { createAggroService };
