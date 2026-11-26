"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { ARCHETYPE, INTENT, STATE } = require("../schema");
const { dwellMs, dockedDwell, pickWeighted, pickCumulative, poolOf, safePoolOf } = require("../rules");
const { CAREER } = require("./schema");

const DAY_MS = 86400000;
const ROOKIE_BAND = "highsec";

function logoffDecision(p, L, rng, now) {
  const docked = Math.max(0, Math.min(now - p.sinceAt, DAY_MS));
  const chance = (L.awayPerDayPermille * docked) / DAY_MS;
  if (!(rng.nextFloat() * 1000 < chance)) return { away: false };
  const span = Math.max(0, L.awayMaxMs - L.awayMinMs);
  return { away: true, next: { systemId: 0, prevId: p.systemId, destId: 0, intent: INTENT.DOCK, state: STATE.AWAY,
    dueAt: now + L.awayMinMs + Math.floor(rng.nextFloat() * span) } };
}

function wake(p, table, S, rng, now) {
  if (rng.nextFloat() * 1000 < S.lifecycle.quitOnReturnPermille) return { kind: "QUIT" };
  const back = table.sys(p.prevId);
  const home = !(back && back.stations > 0);
  return { kind: "RETURN", home, next: { systemId: home ? p.homeId : p.prevId, prevId: 0, destId: 0,
    intent: INTENT.DOCK, state: STATE.DOCKED, dueAt: now + dockedDwell(S, dwellMs(S, rng)) } };
}

function rookieHomeOf(list, table, u) {
  if (!list || list.length === 0) return 0;
  let count = 0;
  for (const id of list) if (table.bandOf(id) === ROOKIE_BAND) count += 1;
  if (count === 0) return 0;
  let k = Math.floor(u * count);
  for (const id of list) {
    if (table.bandOf(id) !== ROOKIE_BAND) continue;
    if (k === 0) return id;
    k -= 1;
  }
  return 0;
}

function bandHomeOf(S, table, rng) {
  const usable = S.bandPermille.map((w, b) => (table.homes[b].total > 0 ? w : 0));
  let b = pickWeighted(usable, rng);
  if (b < 0) b = table.homes.findIndex((h) => h.total > 0);
  if (b < 0) return 0;
  const homes = table.homes[b];
  return table.systemIds[homes.idx[pickCumulative(homes.cum, homes.total, rng)]];
}

function rebirth(p, gen, worldSeed, table, rookieIds, S, now) {
  const rng = createRng(deriveSeed(worldSeed, "pop-reborn", p.pilotId, gen));
  const a = pickWeighted(S.archetypePermille, rng);
  const archetype = a >= 0 ? a + 1 : ARCHETYPE.TRADER;
  let systemId = 0;
  let homeId = 0;
  const fallback = !(rookieIds && rookieIds.length > 0);
  if (!fallback) {
    systemId = rookieIds[Math.floor(rng.nextFloat() * rookieIds.length)];
    const sys = table.sys(systemId);
    const u = rng.nextFloat();
    homeId = rookieHomeOf(sys ? table.stationSystemsByRegion.get(sys.regionId) : null, table, u) || systemId;
  } else {
    homeId = bandHomeOf(S, table, rng);
    if (homeId === 0) return { ok: false, reason: "NO_HOME" };
    systemId = homeId;
  }
  const band = table.bandOf(homeId);
  const pool = poolOf(S, archetype, band);
  const safe = safePoolOf(S, pool, band);
  const list = safe.length > 0 ? safe : pool;
  const shipTypeId = list.length > 0 ? list[0] : p.shipTypeId;
  return { ok: true, fallback, next: { gen, career: CAREER.ROOKIE, xp: 0, wealth: 0, systemId, prevId: 0, destId: 0,
    homeId, archetype, shipTypeId, intent: INTENT.DOCK, state: STATE.DOCKED, corpId: 0, groupId: 0,
    dueAt: now + dockedDwell(S, dwellMs(S, rng)) } };
}

function forcedReturn(p, S, now) {
  return { systemId: p.homeId, prevId: 0, destId: 0, intent: INTENT.DOCK, state: STATE.DOCKED,
    dueAt: now + S.dwellMinMs };
}

module.exports = { DAY_MS, logoffDecision, wake, rebirth, forcedReturn, bandHomeOf };
