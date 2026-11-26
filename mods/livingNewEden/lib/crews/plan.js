"use strict";

function seatKey(hullGroup, typeId) {
  return `${hullGroup}|${typeId === null || typeId === undefined ? "" : typeId}`;
}

function crewTargets(composition, s) {
  const entries = (Array.isArray(composition) ? composition : [])
    .filter((e) => e && Number.isSafeInteger(e.count) && e.count > 0)
    .map((e) => ({ hullGroup: e.hullGroup, typeId: e.typeId === undefined ? null : e.typeId, count: e.count }));
  const ships = entries.reduce((n, e) => n + e.count, 0);
  if (ships === 0) return Object.freeze([]);
  const size = Math.min(Math.ceil(ships / s.shipsPerPilot), s.maxCrewPerFleet);
  const parts = entries.map((e, index) => ({ index, seats: Math.floor((e.count * size) / ships),
    rest: (e.count * size) % ships }));
  let left = size - parts.reduce((n, p) => n + p.seats, 0);
  const order = [...parts].sort((a, b) => (b.rest - a.rest) || (a.index - b.index));
  for (const p of order) {
    if (left <= 0) break;
    p.seats += 1;
    left -= 1;
  }
  const out = [];
  for (const p of parts) {
    if (p.seats <= 0) continue;
    const e = entries[p.index];
    out.push(Object.freeze({ hullGroup: e.hullGroup, typeId: e.typeId, seats: p.seats }));
  }
  return Object.freeze(out);
}

function diffSeats(seats, targets) {
  const groups = new Map();
  let top = -1;
  for (const s of seats) {
    const key = seatKey(s.hullGroup, s.typeId);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s.seat);
    if (s.seat > top) top = s.seat;
  }
  for (const list of groups.values()) list.sort((a, b) => a - b);
  const remove = [];
  const add = [];
  let wanted = 0;
  const targeted = new Set();
  for (const t of targets) {
    const key = seatKey(t.hullGroup, t.typeId);
    targeted.add(key);
    wanted += t.seats;
    const have = groups.get(key) || [];
    if (have.length > t.seats) remove.push(...have.slice(t.seats));
    for (let i = have.length; i < t.seats; i += 1) {
      top += 1;
      add.push({ seat: top, hullGroup: t.hullGroup, typeId: t.typeId });
    }
  }
  for (const [key, list] of groups) {
    if (!targeted.has(key)) remove.push(...list);
  }
  remove.sort((a, b) => a - b);
  return { remove, add, wanted };
}

function pickPilots(req) {
  const need = Math.max(0, req.need | 0);
  const picked = [];
  const chosen = new Set();
  const free = (id) => !chosen.has(id) && !req.taken.has(id) && req.pool.info.has(id)
    && !((req.cooldown.get(id) || 0) > req.at);
  const lists = [
    [...(req.preferred || [])].sort((a, b) => a - b),
    req.corporationId ? req.pool.byCorp.get(req.corporationId) || [] : [],
    req.pool.byFaction.get(req.factionId) || [],
  ];
  for (const list of lists) {
    for (const id of list) {
      if (picked.length >= need) break;
      if (!free(id)) continue;
      chosen.add(id);
      picked.push(id);
    }
  }
  return { picked, shortfall: need - picked.length };
}

function pickReclaim(req) {
  const out = [];
  const cutoff = req.at - req.minIdleMs;
  const victims = req.victims.filter((v) => v.lastSeenAt === null || v.lastSeenAt < cutoff)
    .sort((a, b) => {
      if (a.lastSeenAt === null && b.lastSeenAt !== null) return -1;
      if (b.lastSeenAt === null && a.lastSeenAt !== null) return 1;
      if (a.lastSeenAt !== b.lastSeenAt) return a.lastSeenAt - b.lastSeenAt;
      return a.fleetId < b.fleetId ? 1 : (a.fleetId > b.fleetId ? -1 : 0);
    });
  for (const v of victims) {
    const seats = [...v.seats].sort((a, b) => b.seat - a.seat);
    for (const s of seats) {
      if (out.length >= req.need) return out;
      out.push({ fleetId: v.fleetId, seat: s.seat, characterId: s.characterId });
    }
  }
  return out;
}

module.exports = { seatKey, crewTargets, diffSeats, pickPilots, pickReclaim };
