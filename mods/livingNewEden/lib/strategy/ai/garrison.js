"use strict";

const { bfs } = require("./bfs");
const { strengthOf } = require("./strength");
const { isFresh, ttlOf } = require("./targeting");
const { stagingOf, stationCandidates } = require("./mobilize");
const { garrisonSystemOf, returnPostsOf, returnTargetOf, returnContext } = require("./patrol");
const { fitIskOf } = require("./warChest");
const { gateOn, cooledOf } = require("./attackLossGate");
const { planCapitalAttach, byItemKey } = require("./capitalAttach");
const { postLevelOf } = require("./capitalLevel");
const { planCapitalEscort, escortDistOf, CAPITAL_ESCORT_NOTE } = require("./capitalEscort");
const { templateLadderWithDropsOf } = require("./escalation");

const ACTIVE = "ACTIVE";
const IDLE = "IDLE";
const GARRISON_KIND = "garrison";
const GARRISON_ROLE = "garrison";
const RELEASE_ROLE = "invasion";
const READY = "ready";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const GARRISON_CONSOLIDATE_PURPOSE = "GARRISON_CONSOLIDATE";
const EVASIVE_ROLES = Object.freeze(["hunter", "capsuleer"]);
const PASSING_STATES = Object.freeze(["TRAVELLING", "RETREATING"]);

const none = () => ({ intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } });

function hotSystems(snapshot, params) {
  const hot = new Set();
  for (const i of snapshot.intel || []) {
    const hostile = i.hostileFleets > 0 || i.hostileStrength > 0;
    if (hostile && isFresh(i, snapshot.at, ttlOf(i, params))) hot.add(i.systemId);
  }
  for (const s of snapshot.sightings || []) {
    if (Array.isArray(s.hostile) && s.hostile.some((h) => h.fleets > 0)) hot.add(s.systemId);
  }
  const th = snapshot.threats;
  if (th && th.mode === READY && Array.isArray(th.items)) for (const t of th.items) hot.add(t.systemId);
  const pa = params && params.playerActivity;
  if (pa && Array.isArray(snapshot.playerActivity)) {
    for (const x of snapshot.playerActivity) if (x.kills >= pa.hotMinKills) hot.add(x.systemId);
  }
  return hot;
}

function planGarrisonReinforce({ snapshot, supply, params, ledger, slots, budget, dispatched }) {
  const out = none();
  const G = params && params.garrison;
  if (!G || !(G.maxPerReview > 0)) return out;
  const kind = (params.kinds || []).find((k) => k.kind === GARRISON_KIND);
  const d = snapshot.doctrine;
  if (!kind || !d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(kind.operationType)) return out;
  if (kind.needsCanOccupy === true && d.canOccupy !== true) return out;
  const role = kind.mobilizeRole;
  const template = d.templates && d.templates[role];
  if (!Array.isArray(template) || template.length === 0) return out;
  const consolidationIds = G.consolidate === true && Array.isArray(snapshot.consolidating) && d.consolidates !== false
    ? snapshot.consolidating.map((x) => x.systemId) : [];
  if (Array.isArray(snapshot.territory) && snapshot.territory.length === 0 && consolidationIds.length === 0) return out;
  if (snapshot.faction.status !== ACTIVE || !Array.isArray(snapshot.territory) || snapshot.territoryTruncated === true
    || snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) {
    out.notes.push("GARRISON_SKIPPED");
    return out;
  }

  const openOps = new Map(snapshot.operations.filter((op) => OPEN_OPERATION_STATES.includes(op.state))
    .map((op) => [op.operationId, op]));
  const postSet = new Set(snapshot.territory.map((t) => t.systemId));
  const ctx = params.patrol ? { ...returnContext(snapshot, supply), posts: postSet } : null;
  const held = new Map();
  const count = new Map();
  const returnees = [];
  const add = (at, f) => {
    held.set(at, (held.get(at) || 0) + (f.strength || 0));
    count.set(at, (count.get(at) || 0) + 1);
  };
  const sent = dispatched instanceof Map ? dispatched : new Map();
  for (const f of snapshot.fleets) {
    if (f.fleetRole !== role) continue;
    if (sent.has(f.fleetId)) {
      add(sent.get(f.fleetId), f);
      continue;
    }
    const r = ctx !== null && f.state === IDLE && f.operationId === null && Number.isSafeInteger(f.systemId)
      ? returnPostsOf(f.systemId, snapshot, params, ctx) : null;
    if (r !== null) returnees.push({ f, r });
    else add(garrisonSystemOf(f, openOps, postSet), f);
  }
  returnees.sort((a, b) => (a.f.fleetId < b.f.fleetId ? -1 : (a.f.fleetId > b.f.fleetId ? 1 : 0)));
  for (const { f, r } of returnees) {
    const target = returnTargetOf(r, count, params.patrol);
    add(target !== undefined ? target : f.systemId, f);
  }
  const composition = template.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count }));
  const wanted = strengthOf(composition, params.powerTable);
  const interior = params.garrisonRelease ? interiorPostsOf(snapshot, params) : new Set();
  const weakAll = [...new Set(snapshot.territory.map((t) => t.systemId))]
    .filter((id) => (held.get(id) || 0) < wanted && !interior.has(id));
  const lossCooled = gateOn(snapshot, params) ? cooledOf(snapshot) : null;
  const weakPosts = lossCooled !== null && lossCooled.size > 0 ? weakAll.filter((id) => !lossCooled.has(id))
    : weakAll;
  const consolAll = consolidationIds.length > 0 ? consolidationPostsOf(snapshot, consolidationIds, openOps, held) : [];
  const consol = lossCooled !== null && lossCooled.size > 0 ? consolAll.filter((id) => !lossCooled.has(id))
    : consolAll;
  const consolSet = new Set(consol);
  const weak = consol.length === 0 ? weakPosts : [...new Set([...weakPosts, ...consol])];
  if (weakPosts.length < weakAll.length || consol.length < consolAll.length) out.notes.push("ATTACK_LOSS_COOLDOWN");
  if (weak.length === 0) return out;

  const useLedger = Boolean(ledger) && ledger.needs(role);
  const home = snapshot.faction.homeSystemId;
  const stationSystems = useLedger ? (snapshot.stations || []).map((s) => s.systemId)
    : [...supply.stationSystems, ...(home !== null && home !== undefined ? [home] : [])];
  const bfsOpts = { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems };
  const dist = stationSystems.length > 0 ? bfs(stationSystems, snapshot.neighbors, bfsOpts) : new Map();
  const hot = hotSystems(snapshot, params);
  const far = Number.MAX_SAFE_INTEGER;
  const rankOf = (id) => (hot.has(id) ? 0 : (consolSet.has(id) ? 1 : 2));
  const posts = weak.sort((a, b) => rankOf(a) - rankOf(b)
    || (dist.has(a) ? dist.get(a) : far) - (dist.has(b) ? dist.get(b) : far) || a - b);

  const ships = template.reduce((s, e) => s + e.count, 0);
  const mobCost = { resourceUnits: ships * params.mobilizeResourcePerShip,
    reserveUnits: ships * params.mobilizeReservePerShip };
  const left = { resourceUnits: budget.resourceUnits, reserveUnits: budget.reserveUnits };
  const war = supply && supply.war ? supply.war : null;
  let isk = war && Number.isSafeInteger(budget.isk) ? budget.isk : null;
  const fit = isk !== null ? fitIskOf(template, war.valueByGroup, war.fitPermille) : 0;
  if (isk !== null) out.cost.isk = 0;
  const limit = Math.min(G.maxPerReview, slots.operations, slots.mobilizations);
  const inProduction = (snapshot.production && snapshot.production.inProduction) || {};
  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) out.notes.push(n);
    noted.add(n);
  };
  let holderReach = null;
  const reachOfHolders = () => {
    const holders = (snapshot.stations || []).filter((s) => ledger.pick(template, [s])).map((s) => s.systemId);
    return holders.length > 0 ? bfs(holders, snapshot.neighbors, bfsOpts) : new Map();
  };
  const esc = G.escalation === true && params.escalation ? templateLadderWithDropsOf(d, role, params.powerTable) : null;
  const steps = new Map();
  const stepOf = (i) => {
    if (!steps.has(i)) {
      const t = esc.ladder[i].template;
      const n = t.reduce((s, e) => s + e.count, 0);
      steps.set(i, { template: t, composition: t.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count })),
        mobCost: { resourceUnits: n * params.mobilizeResourcePerShip, reserveUnits: n * params.mobilizeReservePerShip },
        fit: isk !== null ? fitIskOf(t, war.valueByGroup, war.fitPermille) : 0, reach: null });
    }
    return steps.get(i);
  };
  const resetReach = () => {
    holderReach = null;
    for (const s of steps.values()) s.reach = null;
  };
  const reachOf = (t) => {
    const holders = (snapshot.stations || []).filter((s) => ledger.pick(t, [s])).map((s) => s.systemId);
    return holders.length > 0 ? bfs(holders, snapshot.neighbors, bfsOpts) : new Map();
  };
  const base = { template, composition, mobCost, fit };
  let slot = 0;
  let done = 0;
  let mobsUsed = 0;
  const served = new Set();
  for (const T of posts) {
    if (done >= limit || mobsUsed >= slots.mobilizations) {
      if (done < G.maxPerReview) note("GARRISON_NO_SLOT");
      break;
    }
    const level = params.capitalLevel && (esc || (useLedger && params.capitalAttach)) && dist.has(T)
      ? postLevelOf(snapshot, params, T, template).level : undefined;
    const top = esc && level > 0 ? Math.min(level, esc.ladder.length - 1) : 0;
    let systemId;
    let stationId = null;
    let hulls = [];
    let cap = null;
    let st = base;
    let step = 0;
    for (let i = top; i > 0; i -= 1) {
      const s = stepOf(i);
      if (s.mobCost.resourceUnits > left.resourceUnits || s.mobCost.reserveUnits > left.reserveUnits) continue;
      if (isk !== null && s.fit > isk) continue;
      if (useLedger) {
        if (s.reach === null) s.reach = reachOf(s.template);
        if (!s.reach.has(T)) continue;
        const r = ledger.pickWithNote(s.template, stationCandidates(snapshot, bfs([T], snapshot.neighbors, bfsOpts), T),
          inProduction);
        if (!r.picked) continue;
        ledger.take(r.picked.stationId, r.picked.hulls);
        resetReach();
        ({ systemId, stationId, hulls } = r.picked);
      } else {
        const distT = dist.has(T) ? bfs([T], snapshot.neighbors, bfsOpts) : new Map();
        systemId = stagingOf(snapshot, supply, distT, T);
        if (systemId === null) break;
      }
      st = s;
      step = i;
      break;
    }
    if (step === 0 && (mobCost.resourceUnits > left.resourceUnits || mobCost.reserveUnits > left.reserveUnits)) {
      note("INSUFFICIENT_RESOURCES");
      break;
    }
    if (step === 0 && isk !== null && fit > isk) {
      note("WAR_CHEST_SHORT");
      break;
    }
    if (step === 0 && useLedger) {
      if (holderReach === null) holderReach = reachOfHolders();
      if (!holderReach.has(T)) {
        const all = (snapshot.stations || []).filter((s) => s.systemId !== T);
        const r = ledger.pickWithNote(template, all, inProduction);
        note(r.picked ? "GARRISON_HULLS_OUT_OF_REACH" : r.note);
        continue;
      }
      const distT = bfs([T], snapshot.neighbors, bfsOpts);
      const r = ledger.pickWithNote(template, stationCandidates(snapshot, distT, T), inProduction);
      if (!r.picked) {
        note(r.note);
        continue;
      }
      ledger.take(r.picked.stationId, r.picked.hulls);
      resetReach();
      ({ systemId, stationId, hulls } = r.picked);
    } else if (step === 0) {
      const distT = dist.has(T) ? bfs([T], snapshot.neighbors, bfsOpts) : new Map();
      systemId = stagingOf(snapshot, supply, distT, T);
      if (systemId === null) {
        note("NO_STAGING");
        continue;
      }
    }
    if (useLedger && params.capitalAttach) {
      cap = planCapitalAttach({ template: st.template, role, stationId, lg: ledger,
        capitalClasses: snapshot.capitalClasses, attach: params.capitalAttach,
        iskLeft: isk !== null ? isk - st.fit : null, war, level });
      if (cap.items.length > 0) {
        ledger.take(stationId, cap.items);
        hulls = [...hulls, ...cap.items].sort(byItemKey);
      }
      if (cap.note) note(cap.note);
    }
    left.resourceUnits -= st.mobCost.resourceUnits;
    left.reserveUnits -= st.mobCost.reserveUnits;
    out.cost.resourceUnits += st.mobCost.resourceUnits;
    out.cost.reserveUnits += st.mobCost.reserveUnits;
    const capFit = cap ? cap.fitIsk : 0;
    if (isk !== null) {
      isk -= st.fit + capFit;
      out.cost.isk += st.fit + capFit;
    }
    const mob = { type: "MOBILIZE", slot: slot++, role, systemId, homeSystemId: systemId,
      composition: [...st.composition.map((e) => ({ ...e })), ...(cap ? cap.entries.map((e) => ({ ...e })) : [])],
      cost: { ...st.mobCost }, stationId, hulls, ...(isk !== null ? { warIsk: st.fit + capFit } : {}),
      ...(cap && cap.gated === true ? { capitalGated: true } : {}),
      ...(esc && step > 0 ? { escalation: step } : {}), ...(esc && step < top ? { escalationFallback: true } : {}),
      ...(esc ? { escalationLevel: level > 0 ? level : 0 } : {}) };
    if (esc && step > 0) note(step >= 3 ? "ESCALATION_L3" : step === 2 ? "ESCALATION_L2" : "ESCALATION_L1");
    if (esc && step < top) note("ESCALATION_FALLBACK");
    if (esc && level > 0 && esc.dropped > 0) note("ESCALATION_STEP_DROPPED");
    let escort = null;
    if (params.capitalEscort && cap && cap.note === "CAPITAL_NOT_AT_STATION" && mobsUsed + 2 <= slots.mobilizations) {
      const e = planCapitalEscort({ snapshot, params, lg: ledger, target: T, level, role,
        dist: escortDistOf(snapshot, params, T), budget: left, iskLeft: isk, war });
      if (e.intent) {
        ledger.take(e.intent.stationId, e.intent.hulls);
        left.resourceUnits -= e.intent.cost.resourceUnits;
        left.reserveUnits -= e.intent.cost.reserveUnits;
        out.cost.resourceUnits += e.intent.cost.resourceUnits;
        out.cost.reserveUnits += e.intent.cost.reserveUnits;
        if (isk !== null) {
          isk -= e.fit;
          out.cost.isk += e.fit;
        }
        const { type, ...rest } = e.intent;
        escort = { type, slot: slot++, ...rest, ...(esc ? { escalationLevel: level > 0 ? level : 0 } : {}) };
        note(CAPITAL_ESCORT_NOTE);
      } else if (e.note) {
        note(e.note);
      }
    }
    mobsUsed += escort ? 2 : 1;
    const consolidate = consolSet.has(T);
    out.intents.push({ type: "LAUNCH", slot: slot++, kind: kind.kind, target: { kind: "system", systemId: T, ref: null },
      originSystemId: systemId, fleets: [], mobilize: escort ? [mob, escort] : [mob],
      dueAt: snapshot.at + params[kind.windowKey],
      ...(consolidate ? { purpose: GARRISON_CONSOLIDATE_PURPOSE } : {}) });
    out.notes.push(consolidate ? `GARRISON_CONSOLIDATE:${T}` : `GARRISON_REINFORCE:${T}`);
    served.add(T);
    done += 1;
  }
  if (consolSet.size > 0) {
    const opLimit = Math.min(G.maxPerReview, slots.operations);
    const taken = new Set();
    for (const T of posts) {
      if (done >= opLimit) break;
      if (!consolSet.has(T) || served.has(T)) continue;
      const f = freeGarrisonFor(snapshot, T, { role, postSet, interior, hot, held, wanted, sent, taken, bfsOpts });
      if (f === null) continue;
      taken.add(f.fleetId);
      held.set(f.systemId, (held.get(f.systemId) || 0) - (f.strength || 0));
      out.intents.push({ type: "LAUNCH", slot: slot++, kind: kind.kind, target: { kind: "system", systemId: T, ref: null },
        originSystemId: f.systemId, fleets: [{ fleetId: f.fleetId, expectedVersion: f.version }], mobilize: [],
        dueAt: snapshot.at + params[kind.windowKey], purpose: GARRISON_CONSOLIDATE_PURPOSE });
      out.notes.push(`GARRISON_CONSOLIDATE_MOVE:${T}`);
      served.add(T);
      done += 1;
    }
  }
  return out;
}

function freeGarrisonFor(snapshot, T, { role, postSet, interior, hot, held, wanted, sent, taken, bfsOpts }) {
  const strength = (f) => f.strength || 0;
  const free = (snapshot.fleets || []).filter((f) => f.fleetRole === role && f.state === IDLE
    && (f.operationId === null || f.operationId === undefined) && f.refitPending !== true && strength(f) > 0
    && !sent.has(f.fleetId) && !taken.has(f.fleetId) && Number.isSafeInteger(f.systemId) && postSet.has(f.systemId)
    && !hot.has(f.systemId)
    && (interior.has(f.systemId) || (held.get(f.systemId) || 0) - strength(f) >= wanted));
  if (free.length === 0) return null;
  const dist = bfs([T], snapshot.neighbors, bfsOpts);
  const near = free.filter((f) => dist.has(f.systemId));
  if (near.length === 0) return null;
  near.sort((a, b) => dist.get(a.systemId) - dist.get(b.systemId) || strength(b) - strength(a)
    || (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0)));
  return near[0];
}

function consolidationPostsOf(snapshot, ids, openOps, held) {
  const standing = new Set();
  for (const f of snapshot.fleets || []) {
    if (!((f.strength || 0) > 0) || EVASIVE_ROLES.includes(f.fleetRole) || PASSING_STATES.includes(f.state)) continue;
    if (!Number.isSafeInteger(f.systemId)) continue;
    const op = f.operationId !== null && f.operationId !== undefined ? openOps.get(f.operationId) : undefined;
    if (f.operationId !== null && f.operationId !== undefined && (!op || op.targetSystemId !== f.systemId)) continue;
    standing.add(f.systemId);
  }
  return [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && !standing.has(id) && !((held.get(id) || 0) > 0))
    .sort((a, b) => a - b);
}

function interiorPostsOf(snapshot, params) {
  const f = snapshot.factionId;
  const hot = hotSystems(snapshot, params);
  const captured = new Set(Array.isArray(snapshot.capturedIds) ? snapshot.capturedIds : []);
  const owned = new Set((snapshot.systems || []).filter((s) => s.controllerFactionId === f).map((s) => s.systemId));
  const out = new Set();
  for (const { systemId } of snapshot.territory || []) {
    const nbs = snapshot.neighbors(systemId);
    if (hot.has(systemId) || !Array.isArray(nbs) || nbs.length === 0) continue;
    if (nbs.every((id) => !hot.has(id) && (owned.has(id) || captured.has(id)))) out.add(systemId);
  }
  return out;
}

function planGarrisonRelease({ snapshot, params, used, combatRoom, dispatched }) {
  const out = { intents: [], notes: [] };
  const P = params && params.garrisonRelease;
  const d = snapshot.doctrine;
  if (!P || !d || d.buildsStations === false || !Array.isArray(d.operationTypes)
    || !d.operationTypes.includes(RELEASE_ROLE)) return out;
  if (!(combatRoom >= 1)) {
    out.notes.push("GARRISON_RELEASE_CAP");
    return out;
  }
  if (snapshot.faction.status !== ACTIVE || !Array.isArray(snapshot.territory) || snapshot.territoryTruncated === true
    || snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) {
    out.notes.push("GARRISON_SKIPPED");
    return out;
  }
  const posts = new Set(snapshot.territory.map((t) => t.systemId));
  const openOps = new Map((snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state))
    .map((op) => [op.operationId, op]));
  const sent = dispatched instanceof Map ? dispatched : new Map();
  const count = new Map();
  const held = new Map();
  for (const x of snapshot.fleets) {
    if (x.fleetRole !== GARRISON_ROLE) continue;
    const at = sent.has(x.fleetId) ? sent.get(x.fleetId) : garrisonSystemOf(x, openOps, posts);
    count.set(at, (count.get(at) || 0) + 1);
    held.set(at, (held.get(at) || 0) + (x.strength || 0));
  }
  const free = snapshot.fleets.filter((x) => x.fleetRole === GARRISON_ROLE && x.state === IDLE && x.operationId === null
    && x.refitPending !== true && !used.has(x.fleetId) && !sent.has(x.fleetId) && posts.has(x.systemId))
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0)));
  const interior = interiorPostsOf(snapshot, params);
  const template = d.templates && d.templates[GARRISON_ROLE];
  const wanted = Array.isArray(template) ? strengthOf(template, params.powerTable) : 0;
  const limit = Math.min(P.maxPerReview, combatRoom);
  const release = (x) => {
    out.intents.push({ type: "GARRISON_RELEASE", fleetId: x.fleetId, expectedVersion: x.version, systemId: x.systemId,
      to: RELEASE_ROLE });
    out.notes.push(`GARRISON_RELEASE:${x.systemId}`);
    used.add(x.fleetId);
    count.set(x.systemId, count.get(x.systemId) - 1);
    held.set(x.systemId, held.get(x.systemId) - (x.strength || 0));
  };
  for (const x of free) {
    if (out.intents.length >= limit) return out;
    if (interior.has(x.systemId)) release(x);
  }
  for (const x of free) {
    if (out.intents.length >= limit) return out;
    if (used.has(x.fleetId) || interior.has(x.systemId) || count.get(x.systemId) <= P.fleetsTarget) continue;
    if (held.get(x.systemId) - (x.strength || 0) >= wanted) release(x);
  }
  return out;
}

module.exports = { planGarrisonReinforce, planGarrisonRelease, interiorPostsOf, hotSystems, GARRISON_KIND,
  consolidationPostsOf, GARRISON_CONSOLIDATE_PURPOSE };
