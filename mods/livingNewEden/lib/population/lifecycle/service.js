"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { STATE, BANDS } = require("../schema");
const rules = require("./rules");
const career = require("./career");
const { CAREER_NAMES } = require("./schema");

const EMPTY = Object.freeze([]);

function createLifecycle(deps) {
  const { S, worldSeed, pilots } = deps;
  const L = S.lifecycle;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const isLeader = typeof deps.isLeader === "function" ? deps.isLeader : () => false;
  const removeFromCorp = typeof deps.removeFromCorp === "function" ? deps.removeFromCorp : () => {};
  let rookieIds = EMPTY;
  const C = L.career || null;
  const careerCounts = C ? new Int32Array(CAREER_NAMES.length + 1) : null;
  const careerIdx = (c) => (c >= 1 && c <= CAREER_NAMES.length ? c : 0);

  function noteSeeded(id) {
    if (careerIdx(pilots.careerOf(id)) === 0) bump("lifecycle.careerSeeded");
  }

  function ensureCareer(p, table) {
    if (!C || careerIdx(p.career) !== 0) return;
    const band = table ? table.bandOf(p.homeId) : null;
    const s = career.seedCareerOf(p, C, worldSeed, band === null ? -1 : BANDS.indexOf(band));
    p.career = s.career;
    p.xp = s.xp;
  }

  function patchOf(p, next, table, jumped) {
    if (!C || next.career !== undefined) return null;
    ensureCareer(p, table);
    noteSeeded(p.pilotId);
    const band = table ? table.bandOf(p.systemId) : null;
    const a = career.accrue(p, next, C, band === null ? -1 : BANDS.indexOf(band), jumped);
    return { career: p.career, xp: a.xp, wealth: a.wealth };
  }

  function countCareer(before, after) {
    if (!careerCounts) return;
    const a = careerIdx(before);
    const b = careerIdx(after);
    if (a === b) return;
    careerCounts[a] -= 1;
    careerCounts[b] += 1;
  }

  function recountCareers(capacity) {
    if (!careerCounts) return;
    careerCounts.fill(0);
    for (let id = 1; id <= capacity; id += 1) if (pilots.has(id)) careerCounts[careerIdx(pilots.careerOf(id))] += 1;
  }

  const careerCount = (c) => (careerCounts ? careerCounts[careerIdx(c)] : 0);

  function boot(table) {
    rookieIds = Object.freeze((L.rookieSystemIds || EMPTY).filter((id) => {
      const sys = table ? table.sys(id) : null;
      return sys !== null && sys.stations > 0;
    }));
    return { ok: true, rookieSystems: rookieIds.length };
  }

  const awayCap = () => Math.floor((L.maxAwayPermille * pilots.size()) / 1000);

  function onAway(p, table, now) {
    const w = rules.wake(p, table, S, createRng(deriveSeed(worldSeed, "pop-life", p.pilotId, p.seq)), now);
    if (w.kind === "RETURN") {
      bump("lifecycle.returned");
      if (w.home) bump("lifecycle.returnedHome");
      return { kind: "RETURN", next: w.next };
    }
    const r = rules.rebirth(p, p.gen + 1, worldSeed, table, rookieIds, S, now);
    if (!r.ok) return null;
    removeFromCorp(p.pilotId);
    bump("lifecycle.quit");
    bump("lifecycle.reborn");
    if (r.fallback) bump("lifecycle.rookieFallback");
    return { kind: "REBORN", next: r.next };
  }

  function onPromotion(p, table, now) {
    const to = career.promotionOf(p, C);
    if (to === 0) return null;
    const r = career.promote(p, to, C, S, table, worldSeed, now);
    noteSeeded(p.pilotId);
    bump("lifecycle.promoted");
    if (r.moved) bump("lifecycle.homeMoved");
    return { kind: "PROMOTED", moved: r.moved, next: r.next };
  }

  function onDue(p, table, now) {
    if (p.state === STATE.AWAY) return onAway(p, table, now);
    if (p.state !== STATE.DOCKED) return null;
    const sys = table.sys(p.systemId);
    if (sys === null || !(sys.stations > 0) || isLeader(p.pilotId)) return null;
    if (C) {
      const promoted = onPromotion(p, table, now);
      if (promoted) return promoted;
    }
    const d = rules.logoffDecision(p, L, createRng(deriveSeed(worldSeed, "pop-life", p.pilotId, p.seq)), now);
    if (!d.away) return null;
    if (pilots.stateCount(STATE.AWAY) >= awayCap()) {
      bump("lifecycle.awayCapped");
      return null;
    }
    bump("lifecycle.away");
    return { kind: "AWAY", next: d.next };
  }

  function status() {
    return Object.freeze({ enabled: true, rookieSystems: rookieIds.length, away: pilots.stateCount(STATE.AWAY),
      awayCap: awayCap(),
      ...(careerCounts ? { career: Object.freeze({ byCareer: Object.freeze(Object.fromEntries([["UNASSIGNED",
        careerCounts[0]], ...CAREER_NAMES.map((n, i) => [n, careerCounts[i + 1]])])) }) } : {}) });
  }

  return Object.freeze({ boot, onDue, status, careerOn: C !== null, ensureCareer, patchOf, countCareer, recountCareers,
    careerCount });
}

module.exports = { createLifecycle };
