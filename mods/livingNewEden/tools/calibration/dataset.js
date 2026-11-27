"use strict";

const { fingerprint } = require("../../lib/util/fingerprint");

const FACTION_A = 500001;
const FACTION_B = 500002;

const bump = (map, key, n = 1) => { map[key] = (map[key] || 0) + n; };
const cmpNum = (a, b) => a - b;

function unwrap(raw) {
  if (!raw || typeof raw !== "object") return null;
  const esi = raw.esi || raw.killmail || raw;
  if (!esi || typeof esi !== "object" || !esi.victim || !Array.isArray(esi.attackers)) return null;
  return { esi, zkb: raw.zkb && typeof raw.zkb === "object" ? raw.zkb : null };
}

function recordList(records) {
  if (Array.isArray(records)) return records;
  if (records && typeof records === "object") return Object.keys(records).map((k) => records[k]);
  return [];
}

const entityOf = (p) => p.alliance_id || p.corporation_id || null;

function environmentOf(systemId, ctx) {
  const d = ctx.method.dataset;
  if (systemId >= d.wormholeSystemMin && systemId <= d.wormholeSystemMax) return "wormhole";
  if (!ctx.systemSec.has(systemId)) return "other";
  const sec = ctx.systemSec.get(systemId);
  if (sec <= d.nullsecMaxSecurity) return "nullsec";
  if (sec < d.lowsecBelowSecurity) return "lowsec";
  return "highsec";
}

function acceptRecord(raw, ctx) {
  const d = ctx.method.dataset;
  const u = unwrap(raw);
  if (!u) return { ok: false, reason: "MALFORMED" };
  const { esi, zkb } = u;
  const time = Date.parse(esi.killmail_time);
  if (!Number.isSafeInteger(esi.killmail_id) || !Number.isFinite(time) || !Number.isSafeInteger(esi.solar_system_id)) {
    return { ok: false, reason: "MALFORMED" };
  }
  if (zkb && zkb.npc === true) return { ok: false, reason: "NPC" };
  const victim = esi.victim;
  if (!victim.character_id) return { ok: false, reason: "VICTIM_NOT_PILOT" };
  const vGroup = ctx.typeGroup.get(victim.ship_type_id);
  if (vGroup !== undefined) {
    if (ctx.groupCategory.get(vGroup) !== d.shipCategoryId) return { ok: false, reason: "VICTIM_NOT_SHIP" };
    if (vGroup === d.capsuleGroupId) return { ok: false, reason: "CAPSULE" };
  }
  if (!esi.attackers.some((a) => a && a.character_id)) return { ok: false, reason: "NO_PILOT_ATTACKER" };
  return { ok: true, km: { id: esi.killmail_id, time: time / 1000, systemId: esi.solar_system_id, victim,
    attackers: esi.attackers.filter((a) => a && a.character_id) } };
}

function makeUnionFind() {
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r);
    let c = x;
    while (parent.has(c) && parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (ra < rb) parent.set(rb, ra); else parent.set(ra, rb);
  };
  return { find, add, union };
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function asCounter() { return Object.create(null); }

function clusterOf(kms, ctx) {
  const d = ctx.method.dataset;
  const clusters = [];
  let current = null;
  for (const km of kms) {
    if (current && current.systemId === km.systemId && km.time - current.last <= d.clusterGapSec) {
      current.kms.push(km);
      current.last = km.time;
    } else {
      current = { systemId: km.systemId, last: km.time, kms: [km] };
      clusters.push(current);
    }
  }
  return clusters;
}

function battleOf(cluster, ctx) {
  const d = ctx.method.dataset;
  const kms = cluster.kms;
  if (kms.length < d.minKills) return { ok: false, reason: "TOO_SMALL" };
  const co = coalitions(kms, ctx);
  if (!co.ok) return co;
  const sideOfEntity = (ent) => {
    if (!ent) return null;
    const r = co.find(ent);
    return r === co.roots[0] ? 0 : r === co.roots[1] ? 1 : null;
  };
  const parts = [new Map(), new Map()];
  let skipped = 0;
  let thirdEntries = 0;
  const unmapped = [0, 0];
  const visit = (p, lost) => {
    const s = sideOfEntity(entityOf(p));
    const typeId = p.ship_type_id;
    if (!Number.isSafeInteger(typeId)) return;
    const groupId = ctx.typeGroup.get(typeId);
    if (groupId !== undefined && ctx.groupCategory.get(groupId) !== d.shipCategoryId) return;
    if (s === null) { thirdEntries += 1; return; }
    const key = `${p.character_id}|${typeId}`;
    const prev = parts[s].get(key);
    if (prev) { if (lost) prev.lost = true; return; }
    const row = groupId === undefined ? null : ctx.groupMap[String(groupId)];
    parts[s].set(key, { typeId, hullGroup: row ? row.hullGroup : null, lost });
  };
  for (const km of kms) {
    visit(km.victim, true);
    for (const a of km.attackers) visit(a, false);
  }
  const sides = [];
  for (let s = 0; s < 2; s += 1) {
    const agg = new Map();
    let mapped = 0;
    for (const e of parts[s].values()) {
      if (!e.hullGroup) { unmapped[s] += 1; continue; }
      mapped += 1;
      const k = `${e.hullGroup}|${e.typeId}`;
      const row = agg.get(k) || { hullGroup: e.hullGroup, typeId: e.typeId, count: 0, lost: 0 };
      row.count += 1;
      if (e.lost) row.lost += 1;
      agg.set(k, row);
    }
    const all = mapped + unmapped[s];
    if (all > 0 && unmapped[s] / all > d.unmappedMaxShare) return { ok: false, reason: "UNMAPPED_SHARE" };
    skipped += unmapped[s];
    sides.push([...agg.values()].sort(compareEntry));
  }
  skipped += thirdEntries;
  if (sides.some((list) => list.reduce((n, e) => n + e.count, 0) < d.minShipsPerSide)) {
    return { ok: false, reason: "TOO_SMALL" };
  }
  const first = kms[0];
  const fb = first.attackers.find((a) => a.final_blow) || first.attackers[0];
  const aIndex = sideOfEntity(entityOf(fb)) === 1 ? 1 : 0;
  const A = sides[aIndex];
  const B = sides[1 - aIndex];
  const ids = kms.map((k) => k.id).sort(cmpNum);
  const fp = fingerprint(ids);
  const battle = {
    battleId: `battle_${fp.slice(0, 12)}_${fp.slice(12, 16)}_${fp.slice(16, 20)}`,
    systemId: cluster.systemId,
    env: environmentOf(cluster.systemId, ctx),
    startTime: new Date(kms[0].time * 1000).toISOString(),
    spanSec: kms[kms.length - 1].time - kms[0].time,
    kills: kms.length,
    split: ctx.split,
    classes: [],
    sides: { A, B },
  };
  const tooLarge = [A, B].some((list) => fleetsOf(list, ctx.limits) === null);
  if (tooLarge) return { ok: false, reason: "TOO_LARGE" };
  battle.classes = classesOf(battle, ctx);
  return { ok: true, battle, skipped };
}

function compareEntry(x, y) {
  if (x.hullGroup !== y.hullGroup) return x.hullGroup < y.hullGroup ? -1 : 1;
  return x.typeId - y.typeId;
}

function coalitions(kms, ctx) {
  const uf = makeUnionFind();
  const friendly = asCounter();
  const enemy = asCounter();
  const pilotEntity = new Map();
  for (const km of kms) {
    const vEnt = entityOf(km.victim);
    const attackerEnts = [...new Set(km.attackers.map(entityOf).filter(Boolean))].sort(cmpNum);
    if (vEnt) uf.add(vEnt);
    for (const e of attackerEnts) uf.add(e);
    for (let i = 0; i < attackerEnts.length; i += 1) {
      for (let j = i + 1; j < attackerEnts.length; j += 1) bump(friendly, pairKey(attackerEnts[i], attackerEnts[j]));
      if (vEnt && vEnt !== attackerEnts[i]) bump(enemy, pairKey(vEnt, attackerEnts[i]));
    }
    for (const p of [km.victim, ...km.attackers]) {
      const ent = entityOf(p);
      if (p.character_id && ent && !pilotEntity.has(p.character_id)) pilotEntity.set(p.character_id, ent);
    }
  }
  const pairs = Object.keys(friendly).map((k) => k.split("|").map(Number)).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  for (const [a, b] of pairs) {
    const k = pairKey(a, b);
    if ((enemy[k] || 0) > friendly[k]) continue;
    uf.union(a, b);
  }
  const pilots = asCounter();
  for (const ent of pilotEntity.values()) bump(pilots, uf.find(ent));
  const ranked = Object.keys(pilots).map(Number).sort((x, y) => pilots[y] - pilots[x] || x - y);
  if (ranked.length < 2) return { ok: false, reason: "ONE_SIDED" };
  const total = ranked.reduce((s, r) => s + pilots[r], 0);
  const third = total - pilots[ranked[0]] - pilots[ranked[1]];
  if (third / total > ctx.method.dataset.thirdPartyMaxShare) return { ok: false, reason: "MULTI_PARTY" };
  return { ok: true, roots: [ranked[0], ranked[1]], find: uf.find };
}

function fleetsOf(list, limits) {
  const fleets = [];
  let cur = null;
  let ships = 0;
  for (const e of list) {
    let left = e.count;
    while (left > 0) {
      if (!cur || ships >= limits.maxShipsPerFleet || cur.length >= limits.maxCompositionEntries) {
        cur = [];
        ships = 0;
        fleets.push(cur);
        if (fleets.length > limits.maxFleetsPerSide) return null;
      }
      const take = Math.min(left, limits.maxShipsPerFleet - ships);
      cur.push({ hullGroup: e.hullGroup, typeId: e.typeId, count: take });
      ships += take;
      left -= take;
    }
  }
  return fleets;
}

function sideStrength(list, catalog) {
  let dps = 0;
  let ehp = 0;
  let ships = 0;
  let logi = 0;
  for (const e of list) {
    const s = catalog.lookup(e.hullGroup, e.typeId).strength;
    dps += s.dps * e.count;
    ehp += s.ehp * e.count;
    ships += e.count;
    if (e.hullGroup === "logistics") logi += e.count;
  }
  return { dps, ehp, ships, logiShare: ships > 0 ? logi / ships : 0, power: dps * ehp };
}

function classesOf(battle, ctx) {
  const c = ctx.method.dataset.classes;
  const a = sideStrength(battle.sides.A, ctx.catalog);
  const b = sideStrength(battle.sides.B, ctx.catalog);
  const [strong, weak] = a.power >= b.power ? [a, b] : [b, a];
  const out = ["all"];
  if (a.ships <= c.smallGangMaxPerSide && b.ships <= c.smallGangMaxPerSide) out.push("smallGang");
  if (a.ships + b.ships >= c.largeFleetMinTotal) out.push("largeFleet");
  if (weak.dps === 0 ? strong.dps > 0 : strong.dps / weak.dps >= c.dpsEdgeMinRatio) out.push("dpsEdge");
  const logi = (x, y) => x.logiShare >= c.logiEdgeMinShare && y.logiShare <= c.logiEdgeMaxOtherShare;
  if (logi(a, b) || logi(b, a)) out.push("logiEdge");
  if (weak.power === 0 ? strong.power > 0 : strong.power / weak.power >= c.outmatchedMinPowerRatio) out.push("outmatched");
  if (battle.env === "wormhole") out.push("wormhole");
  return out;
}

function buildBattles(records, ctx) {
  const rejected = {};
  const kms = [];
  for (const raw of recordList(records)) {
    const r = acceptRecord(raw, ctx);
    if (r.ok) kms.push(r.km); else bump(rejected, r.reason);
  }
  kms.sort((x, y) => x.systemId - y.systemId || x.time - y.time || x.id - y.id);
  const battles = [];
  let skippedEntries = 0;
  for (const cluster of clusterOf(kms, ctx)) {
    const r = battleOf(cluster, ctx);
    if (!r.ok) { bump(rejected, r.reason); continue; }
    battles.push(r.battle);
    skippedEntries += r.skipped;
  }
  battles.sort((x, y) => (x.battleId < y.battleId ? -1 : x.battleId > y.battleId ? 1 : 0));
  const max = ctx.method.dataset.maxBattlesPerDay;
  if (battles.length > max) {
    bump(rejected, "DAY_LIMIT", battles.length - max);
    battles.length = max;
  }
  return { battles, rejected, skippedEntries };
}

function toBattleInput(battle, opts) {
  const side = (factionId, prefix, list) => {
    const fleets = fleetsOf(list, opts.limits);
    if (fleets === null) return null;
    return { factionId, fleets: fleets.map((composition, i) => ({ fleetId: `fleet_${prefix}${i}`, factionId,
      fleetRole: "patrol", doctrineId: null, supplyState: 100, composition })) };
  };
  const a = side(FACTION_A, "a", battle.sides.A);
  const b = side(FACTION_B, "b", battle.sides.B);
  if (!a || !b) return { ok: false, reason: "TOO_LARGE", detail: battle.battleId };
  if (a.fleets.length === 0 || b.fleets.length === 0) return { ok: false, reason: "INPUT_INVALID", detail: "empty side" };
  return { ok: true, input: { v: 1, battleId: battle.battleId, seed: opts.seed, systemId: battle.systemId,
    environment: battle.env, sideA: a, sideB: b, objective: "destroy", garrison: null, resolverVersion: "internal-v1",
    maxResolutionMs: opts.maxResolutionMs } };
}

module.exports = { buildBattles, toBattleInput, fleetsOf, sideStrength, environmentOf, FACTION_A, FACTION_B };
