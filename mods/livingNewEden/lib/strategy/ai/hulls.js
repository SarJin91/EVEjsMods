"use strict";

const MINING_ROLE = "mining";
const LOGISTICS_ROLE = "logistics";
const REQUIRED = "required";
const LEGACY = "legacy";

function hullsOf(template) {
  const sums = new Map();
  for (const e of template) sums.set(e.hullGroup, (sums.get(e.hullGroup) || 0) + e.count);
  return [...sums.keys()].sort().map((g) => ({ itemKey: `group:${g}`, count: sums.get(g) }));
}

function paidOf(template, free) {
  const set = free instanceof Set ? free : new Set(Array.isArray(free) ? free : []);
  return template.filter((e) => !set.has(e.hullGroup));
}

function createHullLedger(snapshot, params) {
  const P = params && params.production;
  const pr = snapshot && snapshot.production;
  const policy = P && P.mobilizeHulls === REQUIRED && pr && pr.mode === "ready" ? REQUIRED : LEGACY;
  const exempt = Boolean(snapshot && snapshot.doctrine && snapshot.doctrine.hullsRequired === false);
  const free = new Set(P && Array.isArray(P.freeHullGroups) ? P.freeHullGroups : []);
  const paidHulls = (template) => hullsOf(paidOf(template, free));
  const freePick = (candidates) => {
    const c = (candidates || [])[0];
    return c ? { stationId: c.stationId, systemId: c.systemId, hulls: [] } : null;
  };
  const stock = new Map();
  for (const s of (pr && pr.stations) || []) {
    const m = new Map();
    for (const g of Object.keys(s.hulls || {})) m.set(`group:${g}`, s.hulls[g]);
    stock.set(s.stationId, m);
  }

  function needs(role) {
    if (exempt) return false;
    if (policy !== REQUIRED) return false;
    if (role === LOGISTICS_ROLE) return P.logisticsNeedsHulls === true;
    return role !== MINING_ROLE || P.miningNeedsHulls === true;
  }

  function has(stationId, hulls) {
    const m = stock.get(stationId);
    return Boolean(m) && hulls.every((h) => (m.get(h.itemKey) || 0) >= h.count);
  }

  function pick(template, candidates) {
    if (!Array.isArray(template) || template.length === 0) return null;
    const hulls = paidHulls(template);
    if (hulls.length === 0) return freePick(candidates);
    for (const c of candidates || []) {
      if (has(c.stationId, hulls)) return { stationId: c.stationId, systemId: c.systemId, hulls };
    }
    return null;
  }

  function take(stationId, hulls) {
    const m = stock.get(stationId);
    if (!m) return;
    for (const h of hulls) m.set(h.itemKey, (m.get(h.itemKey) || 0) - h.count);
  }

  function available(stationId, group) {
    const m = stock.get(stationId);
    return m ? Math.max(0, m.get(`group:${group}`) || 0) : 0;
  }

  function pickWithNote(template, candidates, inProduction) {
    if (!Array.isArray(template) || template.length === 0) return { picked: null, note: "NO_TEMPLATE" };
    const hulls = paidHulls(template);
    const picked = pick(template, candidates);
    if (picked) return { picked, note: null };

    const missingGroups = [];
    for (const h of hulls) {
      const group = h.itemKey.slice("group:".length);
      let availableAnywhere = false;
      for (const c of candidates || []) {
        if (available(c.stationId, group) >= h.count) {
          availableAnywhere = true;
          break;
        }
      }
      if (!availableAnywhere) missingGroups.push(group);
    }

    if (missingGroups.length === 0) {
      return { picked: null, note: "NO_HULLS:unknown" };
    }

    for (const g of missingGroups) {
      if ((inProduction && inProduction[g]) > 0) {
        return { picked: null, note: `NO_HULLS_IN_PRODUCTION:${g}` };
      }
    }

    return { picked: null, note: `NO_HULLS:${missingGroups[0]}` };
  }

  function fork() {
    const clonedStock = new Map();
    for (const [stationId, groups] of stock) {
      const clonedGroups = new Map(groups);
      clonedStock.set(stationId, clonedGroups);
    }
    function forkedTake(stationId, hulls) {
      const m = clonedStock.get(stationId);
      if (!m) return;
      for (const h of hulls) m.set(h.itemKey, (m.get(h.itemKey) || 0) - h.count);
    }
    function forkedAvailable(stationId, group) {
      const m = clonedStock.get(stationId);
      return m ? Math.max(0, m.get(`group:${group}`) || 0) : 0;
    }
    function forkedHas(stationId, hulls) {
      const m = clonedStock.get(stationId);
      return Boolean(m) && hulls.every((h) => (m.get(h.itemKey) || 0) >= h.count);
    }
    function forkedPick(template, candidates) {
      if (!Array.isArray(template) || template.length === 0) return null;
      const hulls = paidHulls(template);
      if (hulls.length === 0) return freePick(candidates);
      for (const c of candidates || []) {
        if (forkedHas(c.stationId, hulls)) return { stationId: c.stationId, systemId: c.systemId, hulls };
      }
      return null;
    }
    function forkedPickWithNote(template, candidates, inProduction) {
      if (!Array.isArray(template) || template.length === 0) return { picked: null, note: "NO_TEMPLATE" };
      const hulls = paidHulls(template);
      const picked = forkedPick(template, candidates);
      if (picked) return { picked, note: null };

      const missingGroups = [];
      for (const h of hulls) {
        const group = h.itemKey.slice("group:".length);
        let availableAnywhere = false;
        for (const c of candidates || []) {
          if (forkedAvailable(c.stationId, group) >= h.count) {
            availableAnywhere = true;
            break;
          }
        }
        if (!availableAnywhere) missingGroups.push(group);
      }

      if (missingGroups.length === 0) {
        return { picked: null, note: "NO_HULLS:unknown" };
      }

      for (const g of missingGroups) {
        if ((inProduction && inProduction[g]) > 0) {
          return { picked: null, note: `NO_HULLS_IN_PRODUCTION:${g}` };
        }
      }

      return { picked: null, note: `NO_HULLS:${missingGroups[0]}` };
    }

    return Object.freeze({
      policy,
      needs,
      pick: forkedPick,
      pickWithNote: forkedPickWithNote,
      take: forkedTake,
      available: forkedAvailable,
      fork
    });
  }

  return Object.freeze({ policy, needs, pick, pickWithNote, take, available, fork });
}

module.exports = { createHullLedger, hullsOf, paidOf };
