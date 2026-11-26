"use strict";

const { createTickBudget } = require("./cycleSchedule");
const { FAMILY_LAYER, CYCLE_REASON, layerPct, candidates, pick } = require("./logiPolicy");

const DRONE_MODE = Object.freeze(["auto", "off"]);
const DRONE_PHASE = Object.freeze(["NONE", "OUT", "RETURNING", "BLOCKED"]);
const SCOOP_DISTANCE_M = 2500;
const MIN_ORBIT_DISTANCE_M = 500;
const DEFAULT_DURATION_MS = 1000;
const MINE_REFUSAL = Object.freeze(["NO_ROOM", "TARGET", "KIND", "NOT_A_TWIN", "HOOK_UNAVAILABLE", "ERROR"]);
const MINE_RANGE_GRACE_M = 1;
const SALVAGE_REFUSAL = Object.freeze(["NO_SNAPSHOT", "NO_TARGET", "RANGE", "NO_HOST", "CARGO", "ERROR"]);
const SALVAGE_DONE_REFUSAL = Object.freeze(["NO_TARGET", "CARGO"]);
const DRONE_COUNTER_NAMES = Object.freeze([
  "drone.launch.refused.LIMIT", "drone.recall.instant", "drone.cycle.deferred", "drone.lost", "drone.abandoned",
  ...DRONE_MODE.map((mode) => `drone.mode.${mode}`), "drone.error",
  "drone.repair.cycle", ...CYCLE_REASON.map((reason) => `drone.repair.refused.${reason}`),
  "drone.stranded", "drone.reclaim.skipped.lost", "drone.reclaim.skipped.disabled",
  "drone.mine.cycle", "drone.mine.depleted", ...MINE_REFUSAL.map((reason) => `drone.mine.refused.${reason}`),
  "drone.launch.skipped.noCombatDrones",
  "drone.salvage.cycle", "drone.salvage.ok", ...SALVAGE_REFUSAL.map((reason) => `drone.salvage.refused.${reason}`),
]);
const DRONE_KINDS = Object.freeze(["combat", "repair", "mining", "salvage"]);
const FREE = Object.freeze({ controlsMovement: false });

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function byKey(a, b) {
  return a.typeId - b.typeId || a.itemId - b.itemId;
}

function compareUnits(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const c = byKey(a[i], b[i]);
    if (c !== 0) return c;
  }
  return a.length - b.length;
}

function planLaunch(entries, room, freeBandwidth) {
  const max = Math.max(0, toInt(room, 0));
  const free = toNum(freeBandwidth, 0);
  const sorted = (Array.isArray(entries) ? entries : []).filter((e) => e && toInt(e.left, 0) > 0
    && toNum(e.bandwidth, 0) >= 0).sort(byKey);
  if (max === 0 || sorted.length === 0) return [];
  const classes = new Map();
  for (const entry of sorted) {
    const bw = toNum(entry.bandwidth, 0);
    if (!classes.has(bw)) classes.set(bw, []);
    const units = classes.get(bw);
    for (let i = 0; i < toInt(entry.left, 0) && units.length < max; i += 1) units.push(entry);
  }
  const groups = [...classes.entries()].sort((a, b) => a[0] - b[0]);
  let count = 0;
  let sum = 0;
  for (const [bw, units] of groups) {
    for (let i = 0; i < units.length && count < max && sum + bw <= free; i += 1) {
      count += 1;
      sum += bw;
    }
  }
  if (count === 0) return [];
  let best = null;
  let bestSum = -1;
  const take = new Array(groups.length).fill(0);
  function visit(g, left, total) {
    if (total > free) return;
    if (g === groups.length) {
      if (left !== 0 || total < bestSum) return;
      const units = groups.flatMap(([, list], i) => list.slice(0, take[i])).sort(byKey);
      if (best === null || total > bestSum || compareUnits(units, best) < 0) {
        best = units;
        bestSum = total;
      }
      return;
    }
    const [bw, list] = groups[g];
    for (let n = Math.min(left, list.length); n >= 0; n -= 1) {
      take[g] = n;
      visit(g + 1, left - n, total + n * bw);
    }
    take[g] = 0;
  }
  visit(0, count, 0);
  return best || [];
}

function createDroneSidecar(deps) {
  const access = deps.access;
  const ts = deps.scene;
  const combat = deps.combat && typeof deps.combat.checkTarget === "function" ? deps.combat : null;
  const config = deps.config || {};
  const counters = Object.fromEntries(DRONE_COUNTER_NAMES.map((name) => [name, 0]));
  const launchBudget = createTickBudget(config.droneLaunchesPerTick);
  const cycleBudget = createTickBudget(config.droneMaxCyclesPerTick);
  const defaultMode = DRONE_MODE.includes(config.droneDefaultMode) ? config.droneDefaultMode : "auto";
  const repairOn = config.droneRepairEnabled === true && typeof access.fireRepair === "function"
    && typeof access.repairSnapshot === "function";
  const wingTwins = typeof deps.wingTwins === "function" ? deps.wingTwins : () => [];
  const miningOn = config.droneMiningEnabled === true && config.miningEnabled === true
    && typeof deps.mineYield === "function" && typeof deps.mineRock === "function"
    && typeof access.miningSnapshot === "function";
  const salvageOn = config.droneSalvageEnabled === true && config.salvageEnabled === true
    && typeof access.salvageSnapshot === "function" && typeof access.salvageCycle === "function";
  const journal = deps.journal && typeof deps.journal.add === "function" ? deps.journal : null;
  const perPilot = new Map();
  const bays = new Map();
  const live = new Map();
  let priv = new WeakMap();
  let seq = 0;

  function count(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function stateOf(rt) {
    if (!rt.drones) {
      rt.drones = { mode: defaultMode, phase: "NONE", out: new Map(), bay: null, idleSinceMs: {}, lastRefusal: null,
        blocked: false, repair: { targetId: null, retargetAtSimMs: 0 }, mineRock: null, noCombatTargetId: null,
        salvageDoneId: null,
        salvageDoneReason: null,
        wanted: null };
    }
    return rt.drones;
  }

  function note(owner, delta) {
    const n = (perPilot.get(owner) || 0) + delta;
    if (n > 0) perPilot.set(owner, n);
    else perPilot.delete(owner);
  }

  function bayOf(record) {
    const ship = toInt(record.shipItemId, 0);
    const launchedAtMs = toNum(record.launchedAtMs, 0);
    const cached = bays.get(ship);
    if (cached && cached.launchedAtMs === launchedAtMs) return cached.bay;
    const owner = toInt(record.ownerCharacterId, 0);
    const read = access.bayDrones(owner, ship);
    const limit = access.limits(owner, ship);
    if (!read || read.ok !== true || !limit || limit.ok !== true) count("drone.error");
    const drones = read && read.ok === true ? read.drones.map((d) => ({ ...d, left: d.quantity, failed: false })) : [];
    const inSpace = live.has(ship) ? [...live.get(ship).values()] : [];
    const outRepair = inSpace.find((i) => i.kind === "repair" && FAMILY_LAYER[i.family]) || null;
    const firstRepair = outRepair || drones.find((d) => d.kind === "repair" && FAMILY_LAYER[d.family]) || null;
    const bay = { drones, kinds: new Set([...drones, ...inSpace].map((d) => d.kind)),
      repairFamily: firstRepair ? firstRepair.family : null,
      limit: limit && limit.ok === true ? { maxActive: limit.maxActive, bandwidth: limit.bandwidth }
        : { maxActive: 0, bandwidth: 0 } };
    bays.set(ship, { launchedAtMs, bay });
    return bay;
  }

  function privFor(rt, record, twin) {
    let p = priv.get(rt);
    if (!p) {
      const owner = toInt(record.ownerCharacterId, 0);
      const shipItemId = toInt(record.shipItemId, 0);
      p = { owner, shipItemId, proxy: access.makeProxy({ shipItemId, ownerCharId: owner,
        systemId: toInt(twin && twin.systemID, 0) }) };
      priv.set(rt, p);
    }
    return p;
  }

  function systemOf(scene, twin) {
    return toInt(scene && scene.systemID, 0) || toInt(twin && twin.systemID, 0);
  }

  function journalAdd(p, systemId, droneId, nowMs) {
    if (journal) {
      journal.add({ droneId: toInt(droneId, 0), shipItemId: p.shipItemId, ownerCharacterId: p.owner,
        systemId: toInt(systemId, 0), launchedAtMs: Math.max(0, toNum(nowMs, 0)) });
    }
  }

  function removeOut(d, p, id, counter) {
    if (!d.out.delete(id)) return;
    if (journal) journal.remove(id);
    if (p) note(p.owner, -1);
    if (counter) count(counter);
  }

  function settle(d) {
    if (d.out.size === 0) d.phase = d.blocked ? "BLOCKED" : "NONE";
  }

  function moveOnce(info, scene, drone, targetId, rangeM, fast) {
    const moved = info.movedTo;
    if (moved && moved.targetId === targetId && moved.rangeM === rangeM) return;
    access.orbit(scene, drone, targetId, rangeM, { fast });
    info.movedTo = { targetId, rangeM };
  }

  function reconcile(d, p, scene, twin) {
    const twinId = toInt(twin.itemID, 0);
    for (const id of [...d.out.keys()]) {
      const drone = ts.entity(scene, id);
      if (!drone) {
        removeOut(d, p, id, "drone.lost");
      } else if (toInt(drone.controllerID, 0) !== twinId) {
        d.blocked = true;
        removeOut(d, p, id, "drone.abandoned");
      }
    }
  }

  function wantCombat(rt) {
    const id = rt.combat ? rt.combat.targetId : null;
    return rt.task === "ATTACK" && Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  function allowedTarget(scene, twin, host, id) {
    if (id === null || !combat) return null;
    const target = ts.entity(scene, id);
    if (!target) return null;
    const checked = combat.checkTarget(scene, twin, host, target);
    return checked && checked.ok === true ? target : null;
  }

  function wantedEntry(entry, wanted) {
    if (entry.kind === "combat") return wanted.combat === true;
    if (entry.kind === "mining") return Boolean(wanted.mining) && entry.yieldKind === wanted.mining;
    if (entry.kind === "salvage") return wanted.salvage === true;
    return entry.kind === "repair" && wanted.repair !== null && entry.family === wanted.repair;
  }

  function copyCap(bay) {
    return Math.min(toInt(config.droneMaxPerCopy, 0), bay.limit.maxActive);
  }

  function planFor(d, wanted, room) {
    const bay = d.bay;
    const fits = wanted ? (e) => wantedEntry(e, wanted) : (e) => (e.kind === "combat"
      || (e.kind === "repair" && repairOn && e.family === bay.repairFamily) || (e.kind === "mining" && miningOn)
      || (e.kind === "salvage" && salvageOn));
    const used = [...d.out.values()].reduce((sum, info) => sum + toNum(info.bandwidth, 0), 0);
    return planLaunch(bay.drones.filter((e) => !e.failed && fits(e)), room, bay.limit.bandwidth - used);
  }

  function launchMore(d, p, scene, twin, nowMs, wanted) {
    let room = copyCap(d.bay) - d.out.size;
    if (toInt(config.droneMaxPerPilot, 0) > 0) {
      room = Math.min(room, toInt(config.droneMaxPerPilot, 0) - (perPilot.get(p.owner) || 0));
    }
    if (room <= 0) {
      if (d.out.size === 0 && d.lastRefusal !== "LIMIT") {
        d.lastRefusal = "LIMIT";
        count("drone.launch.refused.LIMIT");
      }
      return;
    }
    for (const entry of planFor(d, wanted, room)) {
      if (entry.failed || entry.left <= 0) continue;
      if (!launchBudget.take(nowMs)) return;
      seq += 1;
      const out = access.launch(scene, twin, { ownerCharId: p.owner, shipItemId: p.shipItemId, itemId: entry.itemId,
        launchIndex: d.out.size, seq });
      if (!out || out.ok !== true) {
        entry.failed = true;
        d.lastRefusal = out && out.reason ? out.reason : "ERROR";
        if (out && toInt(out.droneId, 0) > 0) {
          count("drone.stranded");
          journalAdd(p, systemOf(scene, twin), out.droneId, nowMs);
        }
        if (out && out.reason === "NOT_IN_BAY") {
          bays.delete(p.shipItemId);
          return;
        }
        continue;
      }
      entry.left -= 1;
      journalAdd(p, systemOf(scene, twin), out.droneId, nowMs);
      d.out.set(out.droneId, { kind: entry.kind, family: entry.family || null, bandwidth: entry.bandwidth,
        nextCycleAtSimMs: 0, movedTo: null, returning: false,
        yieldKind: entry.yieldKind || null, mineEndAtSimMs: 0, mineRockId: 0,
        salvageEndAtSimMs: 0, salvageWreckId: 0 });
      note(p.owner, 1);
      d.lastRefusal = null;
      d.phase = "OUT";
    }
  }

  function toReturning(d, scene, twin) {
    d.phase = "RETURNING";
    d.idleSinceMs = {};
    for (const [id, info] of d.out) {
      const drone = ts.entity(scene, id);
      if (drone) moveOnce(info, scene, drone, toInt(twin.itemID, 0), 0, true);
    }
  }

  function returning(d, p, scene, twin) {
    const ready = [];
    for (const [id, info] of d.out) {
      const drone = ts.entity(scene, id);
      if (!drone) continue;
      if (ts.surfaceDistance(scene, drone, twin) <= SCOOP_DISTANCE_M) ready.push(drone);
      else moveOnce(info, scene, drone, toInt(twin.itemID, 0), 0, true);
    }
    if (ready.length > 0) recallInto(d, p, scene, p.shipItemId, ready);
    settle(d);
  }

  function recallInto(d, p, scene, ship, drones) {
    const out = access.recall(scene, ship, drones);
    if (!out || out.ok !== true || !Array.isArray(out.ids)) return false;
    for (const id of out.ids) removeOut(d, p, toInt(id, 0), null);
    if (out.ids.length > 0) bays.delete(ship);
    return true;
  }

  function homeOrScoop(d, p, scene, twin, targets) {
    const ready = [];
    for (const [id, info] of d.out) {
      if (hasTarget(targets, info) && !info.returning) continue;
      const drone = ts.entity(scene, id);
      if (!drone) continue;
      if (info.returning) {
        if (ts.surfaceDistance(scene, drone, twin) <= SCOOP_DISTANCE_M) ready.push(drone);
        else moveOnce(info, scene, drone, toInt(twin.itemID, 0), 0, true);
        continue;
      }
      const rangeM = Math.max(MIN_ORBIT_DISTANCE_M, toNum(drone.droneHomeOrbitDistance, MIN_ORBIT_DISTANCE_M));
      moveOnce(info, scene, drone, toInt(twin.itemID, 0), rangeM, false);
    }
    if (ready.length > 0) recallInto(d, p, scene, p.shipItemId, ready);
  }

  function remoteRepairTargetOf(rt, layer) {
    const remote = rt.active && Array.isArray(rt.active.remote) ? rt.active.remote : [];
    for (const e of remote) {
      const id = toInt(e && e.entry && e.entry.targetId, 0);
      if (id > 0 && e.rep && FAMILY_LAYER[e.rep.family] === layer) return id;
    }
    return 0;
  }

  function repairTarget(d, p, rt, ctx, simMs) {
    const family = d.bay && d.bay.repairFamily;
    if (!repairOn || !family) return null;
    const { scene, twin, host } = ctx;
    const layer = FAMILY_LAYER[family];
    const threshold = toNum(config.logiRepairThresholdPct, 0);
    const r = d.repair;
    if (simMs >= r.retargetAtSimMs) {
      r.retargetAtSimMs = simMs + Math.max(1, toInt(config.logiRetargetMs, 0));
      const own = [];
      for (const t of wingTwins(p.owner) || []) {
        const id = toInt(t && t.twinEntityId, 0);
        const entity = id > 0 && id !== toInt(twin.itemID, 0) ? ts.entity(scene, id) : null;
        if (entity) own.push(entity);
      }
      const list = candidates({ twin, host, wingTwins: own, ownerCharId: p.owner,
        sameScene: (entity) => ts.entity(scene, entity.itemID) === entity && access.canInteract(twin, entity) === true });
      const rr = remoteRepairTargetOf(rt, layer);
      const first = rr > 0 ? list.find((c) => toInt(c.entity.itemID, 0) === rr) : null;
      const chosen = first && layerPct(first.entity, layer) < threshold ? first : pick(list, family, threshold);
      r.targetId = chosen ? toInt(chosen.entity.itemID, 0) : null;
    }
    if (r.targetId === null) return null;
    const target = ts.entity(scene, r.targetId);
    if (!target || target.destroyed === true || !(layerPct(target, layer) < threshold)) return null;
    return target;
  }

  function engageRepair(d, p, scene, target, simMs, nowMs) {
    const targetId = toInt(target.itemID, 0);
    for (const [id, info] of d.out) {
      if (info.kind !== "repair" || info.returning) continue;
      const drone = ts.entity(scene, id);
      if (!drone) continue;
      const snap = access.repairSnapshot(drone, p.proxy);
      if (!snap || snap.ok !== true) {
        count("drone.error");
        continue;
      }
      const r = access.ranges(snap.snapshot);
      const far = ts.surfaceDistance(scene, drone, target) > r.engagementRange + 1;
      moveOnce(info, scene, drone, targetId, r.movementRange, far);
      if (far || simMs < info.nextCycleAtSimMs) continue;
      if (!cycleBudget.take(nowMs)) {
        count("drone.cycle.deferred");
        continue;
      }
      info.nextCycleAtSimMs = simMs + Math.max(1, toNum(snap.snapshot.durationMs, DEFAULT_DURATION_MS));
      const fired = access.fireRepair(scene, drone, target, snap.snapshot, simMs, p.owner);
      if (fired && fired.ok === true) {
        count("drone.repair.cycle");
      } else {
        const reason = fired && fired.reason;
        count(CYCLE_REASON.includes(reason) ? `drone.repair.refused.${reason}` : "drone.error");
        d.repair.retargetAtSimMs = 0;
      }
    }
  }

  function engage(d, p, ctx, target, simMs, nowMs) {
    const { scene, twin, host } = ctx;
    const targetId = toInt(target.itemID, 0);
    for (const [id, info] of d.out) {
      if (info.kind !== "combat" || info.returning) continue;
      const drone = ts.entity(scene, id);
      if (!drone) continue;
      const snap = access.combatSnapshot(drone, p.proxy);
      if (!snap || snap.ok !== true) continue;
      const r = access.ranges(snap.snapshot);
      const far = ts.surfaceDistance(scene, drone, target) > r.engagementRange + 1;
      moveOnce(info, scene, drone, targetId, r.movementRange, far);
      if (far || simMs < info.nextCycleAtSimMs) continue;
      const checked = combat.checkTarget(scene, twin, host, target);
      if (!checked || checked.ok !== true) return;
      if (!cycleBudget.take(nowMs)) {
        count("drone.cycle.deferred");
        continue;
      }
      info.nextCycleAtSimMs = simMs + Math.max(1, toNum(snap.snapshot.durationMs, DEFAULT_DURATION_MS));
      const fired = access.fireCombat(scene, drone, target, snap.snapshot, simMs, p.owner);
      if (!fired || fired.ok !== true) count("drone.error");
      else if (fired.destroyed === true) return;
    }
  }

  function hasTarget(targets, info) {
    if (info.kind === "mining") return Boolean(targets.mining) && targets.miningKind === info.yieldKind;
    return Boolean(targets[info.kind]);
  }

  function salvageTarget(d, rt, scene) {
    const s = rt.salvage;
    const wreckId = s && s.claimed === true ? s.wreckId : null;
    if (!salvageOn || rt.task !== "SALVAGE" || !Number.isSafeInteger(wreckId) || wreckId <= 0) {
      d.salvageDoneId = null;
      d.salvageDoneReason = null;
      return null;
    }
    if (d.salvageDoneId === wreckId || !d.bay) return null;
    if (!d.bay.kinds.has("salvage") && ![...d.out.values()].some((i) => i.kind === "salvage")) return null;
    return ts.entity(scene, wreckId);
  }

  function engageSalvage(d, p, rt, ctx, wreck, simMs, nowMs) {
    const { scene, twin, record } = ctx;
    const wreckId = toInt(wreck.itemID, 0);
    const hostShipId = toInt(rt.salvage && rt.salvage.hostShipId, 0) || toInt(record && record.hostShipId, 0);
    for (const [id, info] of d.out) {
      if (info.kind !== "salvage" || info.returning) continue;
      const drone = ts.entity(scene, id);
      if (!drone) continue;
      const snap = access.salvageSnapshot(drone, p.proxy);
      if (!snap || snap.ok !== true) {
        count("drone.error");
        continue;
      }
      const s = snap.snapshot;
      const orbitM = Math.max(MIN_ORBIT_DISTANCE_M, toNum(s.orbitDistanceMeters, MIN_ORBIT_DISTANCE_M));
      const maxRange = Math.max(orbitM, toNum(s.maxRangeMeters, orbitM));
      const far = ts.surfaceDistance(scene, drone, wreck) > maxRange + MINE_RANGE_GRACE_M;
      moveOnce(info, scene, drone, wreckId, orbitM, far);
      if (far) {
        info.salvageEndAtSimMs = 0;
        continue;
      }
      const durationMs = Math.max(1, toNum(s.durationMs, DEFAULT_DURATION_MS));
      if (!(info.salvageEndAtSimMs > 0) || info.salvageWreckId !== wreckId) {
        info.salvageWreckId = wreckId;
        info.salvageEndAtSimMs = simMs + durationMs;
        continue;
      }
      if (simMs < info.salvageEndAtSimMs) continue;
      if (!cycleBudget.take(nowMs)) {
        count("drone.cycle.deferred");
        continue;
      }
      const out = access.salvageCycle(scene, twin, drone, wreckId, p.owner, hostShipId, simMs, s);
      if (out && out.ok === true) {
        count("drone.salvage.cycle");
        info.salvageEndAtSimMs = simMs + durationMs;
        if (out.salvaged === true) {
          count("drone.salvage.ok");
          d.salvageDoneId = wreckId;
          d.salvageDoneReason = "SALVAGED";
          return;
        }
        continue;
      }
      const reason = SALVAGE_REFUSAL.includes(out && out.reason) ? out.reason : "ERROR";
      count(`drone.salvage.refused.${reason}`);
      info.salvageEndAtSimMs = 0;
      if (SALVAGE_DONE_REFUSAL.includes(reason)) {
        d.salvageDoneId = wreckId;
        d.salvageDoneReason = reason;
        return;
      }
    }
  }

  function miningTarget(d, rt, scene) {
    if (!miningOn || rt.task !== "MINE" || !rt.mine || rt.mine.claimed !== true) return null;
    const rockId = rt.mine.rockId;
    if (!Number.isSafeInteger(rockId) || rockId <= 0 || !d.bay || !d.bay.kinds.has("mining")) return null;
    const rock = ts.entity(scene, rockId);
    if (!rock) return null;
    if (!d.mineRock || d.mineRock.rockId !== rockId) {
      d.mineRock = null;
      const read = deps.mineRock(scene, rockId);
      if (!read || read.ok !== true || !read.yieldKind) return null;
      d.mineRock = { rockId, yieldKind: String(read.yieldKind), depleted: false };
    }
    if (d.mineRock.depleted) return null;
    const yieldKind = d.mineRock.yieldKind;
    const fits = (e) => e.kind === "mining" && e.yieldKind === yieldKind;
    if (!d.bay.drones.some(fits) && ![...d.out.values()].some(fits)) return null;
    return { rock, yieldKind };
  }

  function engageMining(d, p, scene, twin, mineTo, simMs, nowMs) {
    const rockId = toInt(mineTo.rock.itemID, 0);
    for (const [id, info] of d.out) {
      if (info.kind !== "mining" || info.returning || info.yieldKind !== mineTo.yieldKind) continue;
      const drone = ts.entity(scene, id);
      if (!drone) continue;
      const snap = access.miningSnapshot(drone, p.proxy);
      if (!snap || snap.ok !== true) {
        count("drone.error");
        continue;
      }
      const s = snap.snapshot;
      const orbitM = Math.max(MIN_ORBIT_DISTANCE_M, toNum(s.orbitDistanceMeters, MIN_ORBIT_DISTANCE_M));
      const maxRange = Math.max(orbitM, toNum(s.maxRangeMeters, orbitM));
      const far = ts.surfaceDistance(scene, drone, mineTo.rock) > maxRange + MINE_RANGE_GRACE_M;
      moveOnce(info, scene, drone, rockId, orbitM, far);
      const durationMs = Math.max(1, toNum(s.durationMs, DEFAULT_DURATION_MS));
      if (far) {
        info.mineEndAtSimMs = 0;
        continue;
      }
      if (!(info.mineEndAtSimMs > 0) || info.mineRockId !== rockId) {
        info.mineRockId = rockId;
        info.mineEndAtSimMs = simMs + durationMs;
        access.miningFx(scene, drone, rockId, s);
        continue;
      }
      if (simMs < info.mineEndAtSimMs) continue;
      if (!cycleBudget.take(nowMs)) {
        count("drone.cycle.deferred");
        continue;
      }
      const out = deps.mineYield(scene, twin, drone, { snapshot: s, yieldKind: info.yieldKind }, rockId, simMs);
      if (out && out.ok === true) {
        count("drone.mine.cycle");
        if (out.depleted === true) {
          count("drone.mine.depleted");
          info.mineEndAtSimMs = 0;
          if (d.mineRock) d.mineRock.depleted = true;
          return;
        }
        info.mineEndAtSimMs = simMs + durationMs;
        access.miningFx(scene, drone, rockId, s);
      } else {
        const reason = out && out.reason;
        count(MINE_REFUSAL.includes(reason) ? `drone.mine.refused.${reason}` : "drone.error");
        info.mineEndAtSimMs = 0;
        d.mineRock = null;
      }
    }
  }

  function step(rt, ctx) {
    if (!rt || rt.ending === true || !ctx) return FREE;
    const { twin, host, record, scene } = ctx;
    if (!twin || !record || !scene) return FREE;
    const d = stateOf(rt);
    const p = privFor(rt, record, twin);
    live.set(p.shipItemId, d.out);
    d.bay = bayOf(record);
    const nowMs = toNum(ctx.nowMs, 0);
    const simMs = ts.simNow(scene);
    reconcile(d, p, scene, twin);
    const target = allowedTarget(scene, twin, host, wantCombat(rt));
    const repairTo = repairTarget(d, p, rt, ctx, simMs);
    const mineTo = miningTarget(d, rt, scene);
    if (!mineTo) {
      for (const info of d.out.values()) if (info.kind === "mining") info.mineEndAtSimMs = 0;
    }
    const salvageTo = salvageTarget(d, rt, scene);
    if (!salvageTo) {
      for (const info of d.out.values()) if (info.kind === "salvage") info.salvageEndAtSimMs = 0;
    }
    const targets = { combat: target, repair: repairTo, mining: mineTo ? mineTo.rock : null,
      miningKind: mineTo ? mineTo.yieldKind : null, salvage: salvageTo };
    const any = Boolean(target || repairTo || mineTo || salvageTo);
    if (d.phase === "RETURNING") {
      if (!(d.mode === "auto" && any)) {
        returning(d, p, scene, twin);
        return FREE;
      }
      d.phase = "OUT";
      for (const info of d.out.values()) info.returning = !hasTarget(targets, info);
    }
    if (d.mode === "auto" && !d.blocked) noCombatDrones(d, target);
    if (any) {
      d.wanted = { combat: Boolean(target), repair: repairTo ? d.bay.repairFamily : null,
        mining: mineTo ? mineTo.yieldKind : null, salvage: Boolean(salvageTo) };
    }
    if (d.mode === "auto" && any && !d.blocked) launchMore(d, p, scene, twin, nowMs, d.wanted);
    if (d.out.size === 0) {
      settle(d);
      return FREE;
    }
    d.phase = "OUT";
    if (d.mode === "off") {
      toReturning(d, scene, twin);
      return FREE;
    }
    idleKinds(d, targets, nowMs);
    if ([...d.out.values()].every((info) => info.returning)) {
      toReturning(d, scene, twin);
      return FREE;
    }
    if (target) engage(d, p, ctx, target, simMs, nowMs);
    if (repairTo) engageRepair(d, p, scene, repairTo, simMs, nowMs);
    if (mineTo) engageMining(d, p, scene, twin, mineTo, simMs, nowMs);
    if (salvageTo) engageSalvage(d, p, rt, ctx, salvageTo, simMs, nowMs);
    homeOrScoop(d, p, scene, twin, targets);
    settle(d);
    return FREE;
  }

  function noCombatDrones(d, target) {
    if (!target || !d.bay || d.bay.kinds.has("combat")) return;
    const targetId = toInt(target.itemID, 0);
    if (d.noCombatTargetId === targetId) return;
    d.noCombatTargetId = targetId;
    count("drone.launch.skipped.noCombatDrones");
  }

  function idleKinds(d, targets, nowMs) {
    const recallMs = toInt(config.droneIdleRecallMs, 0);
    for (const kind of DRONE_KINDS) {
      const mine = [...d.out.values()].filter((info) => info.kind === kind);
      if (mine.length === 0) continue;
      if (targets[kind]) {
        d.idleSinceMs[kind] = null;
        for (const info of mine) info.returning = false;
        continue;
      }
      if (mine.every((info) => info.returning)) continue;
      if (d.idleSinceMs[kind] === null || d.idleSinceMs[kind] === undefined) d.idleSinceMs[kind] = nowMs;
      if (recallMs > 0 && nowMs - d.idleSinceMs[kind] >= recallMs) {
        d.idleSinceMs[kind] = null;
        for (const info of mine) info.returning = true;
      }
    }
  }

  function suspend(rt, _reason, ctx = {}) {
    const d = rt && rt.drones;
    if (!d || d.out.size === 0) return;
    const scene = ctx.scene || null;
    const twin = scene && ctx.record ? ts.entity(scene, ctx.record.twinEntityId) : null;
    if (!twin) {
      d.phase = "RETURNING";
      return;
    }
    toReturning(d, scene, twin);
  }

  function beforeEnd(rt, reason, ctx = {}) {
    const d = rt && rt.drones;
    if (!d || d.out.size === 0 || reason === "SCENE_GONE") return;
    const p = priv.get(rt) || null;
    const record = ctx.record || null;
    const ship = p ? p.shipItemId : toInt(record && record.shipItemId, 0);
    const scene = ctx.scene || null;
    const drones = [];
    for (const id of [...d.out.keys()]) {
      const drone = scene ? ts.entity(scene, id) : null;
      if (drone) drones.push(drone);
      else removeOut(d, p, id, "drone.lost");
    }
    if (drones.length > 0) {
      count("drone.recall.instant");
      if (!recallInto(d, p, scene, ship, drones) && drones.length > 1) {
        for (const drone of drones) recallInto(d, p, scene, ship, [drone]);
      }
    }
    for (let i = 0; i < d.out.size; i += 1) count("drone.stranded");
    settle(d);
  }

  function dispose(rt, reason, ctx = {}) {
    if (!rt) return;
    const p = priv.get(rt) || null;
    const d = rt.drones;
    if (journal && reason === "LOST") {
      let removed = 0;
      for (const id of d ? d.out.keys() : []) {
        if (journal.remove(id).removed === true) removed += 1;
      }
      const ship = p ? p.shipItemId : toInt(ctx && ctx.shipItemId, 0);
      if (ship > 0 && typeof journal.removeShip === "function") removed += journal.removeShip(ship).removed;
      for (let i = 0; i < removed; i += 1) count("drone.reclaim.skipped.lost");
      if (removed > 0) journal.flush();
    }
    if (d && p) note(p.owner, -d.out.size);
    if (d) d.out.clear();
    if (p) {
      const cached = bays.get(p.shipItemId);
      if (cached && d && cached.bay === d.bay) bays.delete(p.shipItemId);
      if (d && live.get(p.shipItemId) === d.out) live.delete(p.shipItemId);
      priv.delete(rt);
    }
  }

  function hasCombatDrones(record) {
    try {
      if (!record || !Number.isSafeInteger(record.shipItemId)) return false;
      return bayOf(record).kinds.has("combat");
    } catch (_err) {
      count("drone.error");
      return false;
    }
  }

  function hasSalvageDrones(record, rt) {
    try {
      if (!salvageOn || !record || !Number.isSafeInteger(record.shipItemId)) return false;
      const d = rt && rt.drones ? rt.drones : null;
      if ((d ? d.mode : defaultMode) !== "auto" || (d && d.blocked === true)) return false;
      if (d && [...d.out.values()].some((info) => info.kind === "salvage")) return true;
      const read = access.bayDrones(toInt(record.ownerCharacterId, 0), toInt(record.shipItemId, 0));
      if (!read || read.ok !== true) {
        count("drone.error");
        return false;
      }
      return read.drones.some((drone) => drone.kind === "salvage" && toNum(drone.quantity, 0) > 0);
    } catch (_err) {
      count("drone.error");
      return false;
    }
  }

  function salvageProgress(rt, wreckId) {
    const d = rt && rt.drones ? rt.drones : null;
    if (!salvageOn) return { able: false, out: 0, done: null };
    if (!d) return { able: defaultMode === "auto", out: 0, done: null };
    let out = 0;
    for (const info of d.out.values()) if (info.kind === "salvage" && !info.returning) out += 1;
    const done = d.salvageDoneId !== null && d.salvageDoneId === wreckId ? d.salvageDoneReason || "SALVAGED" : null;
    return { able: d.mode === "auto" && d.blocked !== true, out, done };
  }

  function setMode(rt, mode) {
    if (!DRONE_MODE.includes(mode)) return { ok: false, reason: "MODE_INVALID" };
    const d = stateOf(rt);
    count(`drone.mode.${mode}`);
    if (d.mode !== mode) {
      d.mode = mode;
      if (mode === "off" && d.out.size > 0) {
        d.phase = "RETURNING";
        for (const info of d.out.values()) info.movedTo = null;
      }
    }
    return { ok: true, mode };
  }

  function view(rt) {
    const d = rt ? rt.drones : null;
    const max = d && d.bay ? d.out.size + planFor(d, d.wanted, copyCap(d.bay) - d.out.size).length : null;
    return { drones: { mode: d ? d.mode : defaultMode, out: d ? d.out.size : 0, max, phase: d ? d.phase : "NONE" } };
  }

  function flush() {
    return journal ? journal.flush() : { ok: true, written: false };
  }

  function reclaimBoot(opts = {}) {
    if (!journal) return { entries: 0, reclaimed: 0, skipped: 0, flushed: true };
    const entries = journal.list();
    const hasLoss = typeof opts.hasLoss === "function" ? opts.hasLoss : () => false;
    let reclaimed = 0;
    let skipped = 0;
    for (const entry of entries) {
      let out = null;
      if (opts.enabled !== true) count("drone.reclaim.skipped.disabled");
      else if (lossOf(hasLoss, entry.shipItemId)) count("drone.reclaim.skipped.lost");
      else if (typeof access.reclaim === "function") out = access.reclaim(entry);
      if (out && out.ok === true) reclaimed += 1;
      else skipped += 1;
      journal.remove(entry.droneId);
    }
    const flushed = journal.flush();
    return { entries: entries.length, reclaimed, skipped, flushed: flushed.ok === true };
  }

  function lossOf(hasLoss, shipItemId) {
    try {
      return hasLoss(shipItemId) === true;
    } catch (_err) {
      count("drone.error");
      return true;
    }
  }

  function clearAll() {
    flush();
    perPilot.clear();
    bays.clear();
    live.clear();
    priv = new WeakMap();
  }

  function stats() {
    const fromAccess = typeof access.stats === "function" ? access.stats() : null;
    const fromJournal = journal && typeof journal.stats === "function" ? journal.stats() : null;
    return { counters: { ...counters, ...(fromAccess && fromAccess.counters ? fromAccess.counters : {}),
      ...(fromJournal && fromJournal.counters ? fromJournal.counters : {}) }, pilots: perPilot.size };
  }

  return { name: "drones", step, suspend, beforeEnd, dispose, view, stats, hasCombatDrones, setMode, clearAll, flush,
    reclaimBoot, hasSalvageDrones, salvageProgress };
}

module.exports = { DRONE_MODE, DRONE_PHASE, DRONE_COUNTER_NAMES, SCOOP_DISTANCE_M, SALVAGE_REFUSAL, createDroneSidecar,
  planLaunch };
