"use strict";

const path = require("node:path");
const { DEFAULT_DB_FILE } = require("../../config");
const { demoKey } = require("./contactService");

const DEMO_FLEETS = Object.freeze([
  Object.freeze({ tag: "a", fleetId: "lnedemo-a", factionId: 500019,
    composition: Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "logistics", count: 1 }]) }),
  Object.freeze({ tag: "b", fleetId: "lnedemo-b", factionId: 500010,
    composition: Object.freeze([{ hullGroup: "frigate", count: 6 }, { hullGroup: "tackle", count: 2 }]) }),
]);
const DEMO_SEC_CLASS = "nullsec";
const fleetKey = (tag) => `battle-demo:v1:fleet:${tag}`;
const REFUSED = Object.freeze({ sentinel: "battle.demo.refused" });

function messageOf(err) {
  return String((err && err.message) || err);
}

function multiplierOf(testing) {
  const m = testing && testing.battleDemoShipMultiplier;
  return Number.isSafeInteger(m) && m >= 1 ? m : 1;
}

function compositionOf(fleet, m) {
  return fleet.composition.map((e) => ({ ...e, count: e.count * m }));
}

function pickSystem(graph, testing, presence) {
  const wanted = testing.battleDemoSystemId;
  if (Number.isSafeInteger(wanted) && wanted > 0) {
    return graph.getSystem(wanted) ? { ok: true, systemId: wanted } : { ok: false, reason: "DEMO_SYSTEM_UNKNOWN" };
  }
  const observed = (id) => {
    try {
      return Boolean(presence && typeof presence.isObserved === "function" && presence.isObserved(id) === true);
    } catch (_err) {
      return false;
    }
  };
  const ids = [...graph.getSystemsBySecClass(DEMO_SEC_CLASS)].sort((x, y) => x - y);
  const id = ids.find((x) => !observed(x));
  return id === undefined ? { ok: false, reason: "DEMO_NO_SYSTEM" } : { ok: true, systemId: id };
}

function seedDemo(deps) {
  const { store, fleetRepository, scheduler, graph, testing, clock, logger } = deps;
  try {
    const opened = deps.filePath;
    const dbFile = typeof opened === "string" && opened !== "" ? path.basename(opened) : DEFAULT_DB_FILE;
    if (dbFile === DEFAULT_DB_FILE) {
      logger.log("battle: demo refused - BENCH_REQUIRES_SEPARATE_DB");
      return { ok: false, reason: "BENCH_REQUIRES_SEPARATE_DB" };
    }
    const picked = pickSystem(graph, testing, deps.presence || null);
    if (!picked.ok) {
      logger.log(`battle: demo refused - ${picked.reason}`);
      return picked;
    }
    const sys = picked.systemId;
    const dueAt = clock.now() + testing.battleDemoDelayMs;
    const m = multiplierOf(testing);
    const ships = DEMO_FLEETS.reduce((n, f) => n + compositionOf(f, m).reduce((k, e) => k + e.count, 0), 0);
    let refusal = null;
    const refuse = (r) => {
      refusal = r;
      throw REFUSED;
    };
    const tx = store.transaction("battle.demo", (db) => {
      let duplicates = 0;
      for (const f of DEMO_FLEETS) {
        const r = fleetRepository.createFleet(db, { fleetId: f.fleetId, factionId: f.factionId, currentSystemId: sys,
          homeSystemId: sys, fleetRole: "patrol", composition: compositionOf(f, m) }, fleetKey(f.tag));
        if (!r.ok) refuse(r);
        if (r.duplicate) duplicates += 1;
      }
      if (duplicates === DEMO_FLEETS.length) return { ok: true, seeded: false };
      if (duplicates > 0) refuse({ ok: false, reason: "DEMO_PARTIAL" });
      const ev = scheduler.enqueue("BATTLE_CONTACT_CHECK", sys, dueAt,
        { systemId: sys, at: dueAt, triggerFleetId: null, demo: true }, demoKey(sys), { tx: db });
      if (!ev || ev.ok !== true) refuse({ ok: false, reason: (ev && ev.reason) || "ENQUEUE_FAILED" });
      return { ok: true, seeded: true };
    });
    const r = tx.ok ? tx.value : (tx.error === REFUSED && refusal ? refusal : tx);
    if (!r || !r.ok) {
      logger.log(`battle: demo refused - ${(r && r.reason) || "TX_FAILED"}`);
      return { ok: false, reason: (r && r.reason) || "TX_FAILED" };
    }
    if (!r.seeded) logger.log(`battle: demo already seeded system=${sys}`);
    else {
      logger.log(`battle: demo fleets ${DEMO_FLEETS.map((f) => f.fleetId).join(",")} system=${sys}`
        + ` ships=${ships} check in ${testing.battleDemoDelayMs}ms`);
    }
    return { ok: true, systemId: sys, seeded: r.seeded };
  } catch (err) {
    logger.log(`battle: demo refused - ${messageOf(err)}`);
    return { ok: false, reason: "DEMO_FAILED" };
  }
}

module.exports = { seedDemo, DEMO_FLEETS };
