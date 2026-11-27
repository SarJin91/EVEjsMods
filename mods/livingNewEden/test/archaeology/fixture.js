"use strict";

const START = 100;
const EXCLUDED_REGION = 99;
const REGION_NAMES = Object.freeze({ 10: "Origin", 20: "Alpha", 30: "Beta", 40: "Low", 50: "Gamma", 60: "Delta",
  99: "Excluded" });

function regionOf(id) {
  if (id <= 105) return 10;
  if (id <= 108) return 20;
  if (id <= 110) return 30;
  if (id === 111) return EXCLUDED_REGION;
  if (id === 112) return 40;
  if (id <= 114) return 50;
  return 60;
}

function lineGraph(opts = {}) {
  const sys = new Map();
  for (let id = START; id <= 130; id += 1) {
    const low = opts.allLow === true || id === START || id === 112;
    sys.set(id, Object.freeze({ id, name: `Sys-${id}`, regionId: regionOf(id), secClass: low ? "lowsec" : "nullsec" }));
  }
  return {
    getSystem: (id) => sys.get(id) || null,
    getNeighbors(id) {
      if (!sys.has(id)) return null;
      return [id - 1, id + 1].filter((n) => sys.has(n));
    },
    getRegionName: (rid) => REGION_NAMES[rid] || null,
  };
}

function fakeSites() {
  const rows = new Map();
  const calls = { create: [], cleanup: [], providers: [], nudges: 0 };
  const s = {
    rows,
    calls,
    refuse: null,
    getStatus: () => ({ state: "running" }),
    createSiteInTx(tx, req) {
      calls.create.push(req);
      if (s.refuse) return { ok: false, reason: s.refuse };
      const ex = rows.get(req.eventId);
      if (ex) return { ok: true, siteKey: ex.siteKey, created: false, state: ex.state };
      const siteKey = `lne:${req.eventId}:${req.slot}`;
      rows.set(req.eventId, { siteKey, slot: req.slot, eventId: req.eventId, systemId: req.systemId,
        templateId: req.templateId, label: req.label, state: "CREATING", failReason: null, expiresAt: req.expiresAt });
      return { ok: true, siteKey, created: true, state: "CREATING" };
    },
    cleanupSitesInTx(tx, eventId, reason) {
      calls.cleanup.push([eventId, reason]);
      return { ok: true, released: rows.has(eventId) ? 1 : 0 };
    },
    listSitesByEvent(eventId) {
      const r = rows.get(eventId);
      return { ok: true, sites: r ? [{ ...r }] : [] };
    },
    registerContentProvider(p) {
      calls.providers.push(p);
      return { ok: true, unregister() {
        const i = calls.providers.indexOf(p);
        if (i >= 0) calls.providers.splice(i, 1);
      } };
    },
    nudge() {
      calls.nudges += 1;
    },
    setState(eventId, state, failReason = null) {
      const r = rows.get(eventId);
      if (r) Object.assign(r, { state, failReason });
    },
    only: () => [...rows.values()],
  };
  return s;
}

function fakePresence() {
  const where = new Map();
  return {
    where,
    getStatus: () => ({ state: "running", available: true, stale: false }),
    getSystemPresence: (id) => ({ systemId: id, characters: [...where].filter(([, sys]) => sys === id)
      .map(([characterId]) => ({ characterId })) }),
  };
}

module.exports = { START, EXCLUDED_REGION, lineGraph, regionOf, fakeSites, fakePresence };
