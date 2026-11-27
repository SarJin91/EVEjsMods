"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const S = require("../../lib/stations/playerSiege/schema");
const M = require("../../lib/stations/playerSiege/machine");
const { startPlayerSiege, createUnavailablePlayerSiege, FACADE_METHODS } = require("../../lib/stations/playerSiege");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { capitalPowerOverlayOf } = require("../../lib/battle/data/capitalStrengthRows");
const { relationOf, huntThresholds } = require("../../lib/playerHunt/policy");
const { parseNeutralPolicy } = require("../../lib/playerHunt/schema");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const C = DEFAULTS.playerSiege;
const SYS = 30000142;
const OWNER = 98000001;
const SID = 1035000001;
const PIRATE = 500019;
const PIRATE2 = 500020;
const EMPIRE = 500001;
const HOUR = 3600000;
const T0 = 1760000000000;
const HOLD = Object.freeze({ attackerShips: 20, attackerDps: 2000, attackerStrength: 100, engaged: false,
  contested: false });

function view(over = {}) {
  return Object.freeze({ structureId: SID, systemId: SYS, typeId: 35832, family: "citadel", size: "medium",
    ownerCorpId: OWNER, allianceId: null, state: "SHIELD_VULNERABLE", stateEndsAt: null, name: "Fort", stateId: 3,
    destroyedAt: null, upkeep: "FULL_POWER", ehp: Object.freeze({ shield: 1e6, armor: 1e6, hull: 1e6 }),
    damageLimit: Object.freeze({ shield: 0, armor: 0, hull: 0 }), assetSafety: true, tagged: false, ...over });
}

function facts(siege, at, over = {}) {
  return { at, phaseSeq: siege.phaseSeq, round: siege.waitRound, maxWaitRounds: C.maxWaitRounds,
    recheckMs: C.recheckMs, lagRecheckMs: C.lagRecheckMs, maxLagRounds: C.maxLagRounds,
    timerExitDelayMs: C.timerExitDelayMs, hitMarginMs: C.hitMarginMs, assaultMinMs: C.assaultMinMs,
    assaultMaxMs: C.assaultMaxMs, destroyEnabled: true, ownerActive: null, virtualOwner: false, ...over };
}

function siegeRow(over = {}) {
  return Object.freeze({ siegeId: "ps_x", open: true, state: S.SHIELD_ASSAULT, phaseSeq: 0, waitRound: 0,
    phaseStartedAt: T0 - C.assaultMinMs, phaseEndsAt: T0, ownerCorpId: OWNER, ...over });
}

function applied(siege, d, at) {
  if (d.action === "WAIT") return Object.freeze({ ...siege, waitRound: d.round, phaseEndsAt: d.dueAt });
  assert.ok(M.canTransition(siege.state, d.to).ok, `${siege.state} -> ${d.to}`);
  if (d.action === "END") return Object.freeze({ ...siege, state: d.to, open: false });
  return Object.freeze({ ...siege, state: d.to, phaseSeq: siege.phaseSeq + 1, waitRound: 0, phaseStartedAt: at,
    phaseEndsAt: d.phaseEndsAt });
}

const pirateFleet = (id, factionId, count) => ({ fleetId: id, factionId, fleetRole: "invasion", state: "IDLE",
  composition: [{ hullGroup: "battleship", count }] });

module.exports = ({ test, skip }) => {
  test("PG1 playerSiege machine: SHIELD (HIT) -> ARMOR_TIMER -> WAIT TIMER -> ARMOR_ASSAULT (window) -> HIT -> "
    + "HULL_TIMER -> gate -> HULL_ASSAULT -> HIT -> DESTROYED", () => {
    const log = [];
    let s = siegeRow();
    let at = T0;
    const step = (v, over) => {
      const d = M.decidePlayerStep(s, v, HOLD, facts(s, at, over));
      log.push(d.action === "END" || d.action === "ADVANCE" ? `${d.action}:${d.to}` : d.action);
      if (d.action === "WAIT" || d.action === "ADVANCE" || d.action === "END") s = applied(s, d, at);
      return d;
    };
    assert.deepStrictEqual(step(view()), { action: "HIT", layer: "shield" });
    const armorEnds = at + 24 * HOUR;
    const t1 = step(view({ state: "ARMOR_REINFORCE", stateEndsAt: armorEnds }));
    assert.strictEqual(t1.phaseEndsAt, armorEnds + C.timerExitDelayMs);
    at = t1.phaseEndsAt;
    const w = step(view({ state: "ARMOR_REINFORCE", stateEndsAt: armorEnds + 60000 }));
    assert.deepStrictEqual(w, { action: "WAIT", round: 1, dueAt: armorEnds + 60000 + C.timerExitDelayMs, why: "TIMER" });
    at = w.dueAt;
    const a = step(view({ state: "ARMOR_VULNERABLE", stateEndsAt: at + 900000 }));
    assert.strictEqual(a.phaseEndsAt, Math.min(at + C.assaultMinMs, at + 900000 - C.hitMarginMs));
    at = a.phaseEndsAt;
    assert.deepStrictEqual(step(view({ state: "ARMOR_VULNERABLE", stateEndsAt: at + 60000 })),
      { action: "HIT", layer: "armor" });
    const h = step(view({ state: "HULL_REINFORCE", stateEndsAt: at + 48 * HOUR }));
    at = h.phaseEndsAt;
    assert.deepStrictEqual(step(view({ state: "HULL_VULNERABLE", stateEndsAt: at + 1800000 })),
      { action: "NEED_OWNER" });
    const ha = step(view({ state: "HULL_VULNERABLE", stateEndsAt: at + 1800000 }), { ownerActive: true });
    at = ha.phaseEndsAt;
    assert.deepStrictEqual(step(view({ state: "HULL_VULNERABLE", stateEndsAt: at + 60000 })),
      { action: "HIT", layer: "hull" });
    step(view({ state: "HULL_VULNERABLE", destroyedAt: at }));
    assert.deepStrictEqual(log, ["HIT", "ADVANCE:ARMOR_TIMER", "WAIT", "ADVANCE:ARMOR_ASSAULT", "HIT",
      "ADVANCE:HULL_TIMER", "NEED_OWNER", "ADVANCE:HULL_ASSAULT", "HIT", "END:DESTROYED"]);
    assert.strictEqual(s.open, false);
  });

  test("PG2 playerSiege machine: final gate OWNER_OFFLINE / NO_ASSET_SAFETY / NEED_OWNER / FINAL_DISABLED, "
    + "REPAIRED", () => {
    const hullV = view({ state: "HULL_VULNERABLE", stateEndsAt: T0 + 1800000 });
    const out = [];
    for (const state of [S.ARMOR_ASSAULT, S.HULL_TIMER]) {
      const s = siegeRow({ state });
      const d = (v, over) => M.decidePlayerStep(s, v, HOLD, facts(s, T0, over));
      out.push([state, d(hullV, { ownerActive: false }).reason, d(view({ state: "HULL_VULNERABLE",
        assetSafety: false }), { ownerActive: true }).reason, d(hullV).action,
      d(hullV, { destroyEnabled: false, ownerActive: true }).reason]);
    }
    const repaired = M.decidePlayerStep(siegeRow({ state: S.ARMOR_ASSAULT }), view(), HOLD,
      facts(siegeRow(), T0));
    assert.deepStrictEqual(out, [
      [S.ARMOR_ASSAULT, "OWNER_OFFLINE", "NO_ASSET_SAFETY", "NEED_OWNER", "FINAL_DISABLED"],
      [S.HULL_TIMER, "OWNER_OFFLINE", "NO_ASSET_SAFETY", "NEED_OWNER", "FINAL_DISABLED"]]);
    assert.deepStrictEqual(repaired, { action: "END", to: S.REPELLED, reason: "REPAIRED" });
  });

  test("PG4 playerSiege planPlayerStart: NOT_NULLSEC, COOLDOWN, maxOpenPerOwner, empire neutral NOT_HOSTILE, pirate "
    + "start, faction choice order", () => {
    const groups = expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf(DEFAULTS.strategy));
    const thresholds = huntThresholds(DEFAULTS.playerHunt);
    const policy = parseNeutralPolicy(DEFAULTS.playerHunt.neutralPolicy);
    const KIND = { [PIRATE]: "pirate", [PIRATE2]: "pirate", [EMPIRE]: "empire" };
    const at = T0;
    const spec = (over = {}) => ({ system: { systemId: SYS, secClass: "nullsec" }, structures: [view()],
      fleets: [pirateFleet("f1", PIRATE, 20)], truncated: false, openStructureIds: new Set(), openTotal: 0,
      openByFaction: new Map(), openByOwner: new Map(), lastByStructure: new Map(), triggerFleetId: null, at,
      relation: (f) => relationOf(0, KIND[f], thresholds, policy), isActive: () => true,
      isHostileFaction: () => false, groups,
      params: { targetFamilies: ["citadel", "engineering", "refinery"], structureCooldownMs: C.structureCooldownMs,
        maxOpen: C.maxOpen, maxOpenPerFaction: C.maxOpenPerFaction, maxOpenPerOwner: C.maxOpenPerOwner,
        assaultMinMs: C.assaultMinMs, assaultMaxMs: C.assaultMaxMs }, ...over });
    const reasons = [
      M.planPlayerStart(spec({ system: { systemId: SYS, secClass: "highsec" } })).reason,
      M.planPlayerStart(spec({ system: { systemId: SYS, secClass: "lowsec" } })).reason,
      M.planPlayerStart(spec({ lastByStructure: new Map([[SID, { open: false, endedAt: at - HOUR }]]) })).reason,
      M.planPlayerStart(spec({ openByOwner: new Map([[OWNER, 1]]) })).reason,
      M.planPlayerStart(spec({ fleets: [pirateFleet("f9", EMPIRE, 20)] })).reason,
    ];
    assert.deepStrictEqual(reasons, ["NOT_NULLSEC", "NOT_NULLSEC", "COOLDOWN", "LIMIT", "NOT_HOSTILE"]);
    const p = M.planPlayerStart(spec());
    assert.deepStrictEqual([p.start.structureId, p.start.attackerFactionId, p.start.phaseEndsAt, p.start.attackerShips],
      [SID, PIRATE, at + C.assaultMinMs, 20]);
    const two = [pirateFleet("f1", PIRATE, 10), pirateFleet("f2", PIRATE2, 30)];
    assert.deepStrictEqual([
      M.planPlayerStart(spec({ fleets: two })).start.attackerFactionId,
      M.planPlayerStart(spec({ fleets: two, triggerFleetId: "f1" })).start.attackerFactionId,
      M.planPlayerStart(spec({ fleets: [pirateFleet("f1", PIRATE2, 10), pirateFleet("f2", PIRATE, 10)] }))
        .start.attackerFactionId], [PIRATE2, PIRATE, PIRATE]);
  });

  test("PG5 playerSiege off: disabled_by_config, no seam -> refused without a handler, stub getMode off; stub "
    + "methods = facade methods", () => {
    const registered = [];
    const scheduler = { getStatus: () => ({ state: "ready" }), enqueue: () => ({ ok: true }),
      enqueueMany: () => ({ ok: true, enqueued: 0, duplicates: 0 }),
      registerHandler: (type) => {
        registered.push(type);
        return { ok: true, unregister() {} };
      } };
    const fleets = { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [], nextAfterFleetId: null }) },
      travel: { addArrivalListener: () => ({ ok: true, remove() {} }) } };
    const registry = { isActive: () => true, getFaction: () => ({ kind: "pirate" }) };
    const store = { transaction: () => ({ ok: false, reason: "FAKE_STORE" }) };
    const cfg = (enabled) => ({ ...DEFAULTS, modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
      playerSiege: { ...C, enabled } });
    const deps = (enabled, seamOk) => ({ config: cfg(enabled), persistence: { ok: true, store, journal: {
      applyOnce() {}, findByKey() {} } }, clock: { now: () => T0 }, ids: { next: () => "ps_1" }, scheduler, fleets,
    strategy: { registry }, graph: null, adapter: { playerStructureSeams: () => (seamOk ? { ok: true }
      : { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE", detail: "x" }), playerStructures: {} } });
    assert.strictEqual(C.enabled, true, "Default on since");
    assert.deepStrictEqual(startPlayerSiege(deps(false, true)), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(startPlayerSiege(deps(true, false)).reason, "PLAYER_STRUCTURES_SEAM_UNAVAILABLE");
    assert.deepStrictEqual(registered, []);
    const stub = createUnavailablePlayerSiege("PLAYER_SIEGE_DISABLED", "disabled_by_config");
    assert.strictEqual(stub.getMode(), "off");
    assert.strictEqual(stub.readForFaction({}, PIRATE).reason, "PLAYER_SIEGE_UNAVAILABLE");
    const real = startPlayerSiege(deps(true, true));
    assert.ok(real.ok, JSON.stringify(real));
    assert.deepStrictEqual(registered, [S.CHECK_EVENT_TYPE, S.STEP_EVENT_TYPE, S.SCAN_EVENT_TYPE]);
    assert.deepStrictEqual([Object.keys(stub).sort(), Object.keys(real.playerSiege).sort()],
      [[...FACADE_METHODS].sort(), [...FACADE_METHODS].sort()]);
    assert.ok(Object.isFrozen(real.playerSiege) && Object.isFrozen(stub));
    real.playerSiege.stop("test");
    assert.strictEqual(real.playerSiege.getMode(), "off");
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function rig(reopen, wrapStep, flushedOf = () => true) {
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
      playerSiege: { ...C, enabled: true }, playerHunt: DEFAULTS.playerHunt, strategy: DEFAULTS.strategy,
      persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 } };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock, ids: shared.ids,
      nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const vendor = { state: "SHIELD_VULNERABLE", hits: 0 };
    const current = () => view({ state: vendor.state, stateEndsAt: vendor.state === "ARMOR_REINFORCE"
      ? clock.now() + 24 * HOUR : null });
    const seam = {
      listCandidates: () => ({ ok: true, bySystem: new Map([[SYS, Object.freeze([current()])]]), total: 1,
        truncated: false, builtAt: clock.now() }),
      readStructure: () => ({ ok: true, view: current() }),
      applySiegeHit: (id, layer) => {
        if (layer !== "shield" || vendor.state !== "SHIELD_VULNERABLE") {
          return { ok: false, reason: "STATE_MISMATCH", state: vendor.state };
        }
        vendor.hits += 1;
        vendor.state = "ARMOR_REINFORCE";
        return { ok: true, view: current(), destroyed: false, flushed: flushedOf() };
      },
      readOwnerFace: () => ({ ok: true, ceoId: 90000001, npc: false }),
      readOwnerActivity: () => ({ ok: true, onlineNow: true, lastSeenMs: null, members: 1, truncated: false }),
    };
    const fleetsList = [pirateFleet("f1", PIRATE, 20)];
    const fleets = { repository: { listFleetsInSystem: (tx, systemId, opts) => ({ ok: true,
      fleets: fleetsList.filter((f) => opts.states.includes(f.state)), nextAfterFleetId: null }) },
    travel: { addArrivalListener: () => ({ ok: true, remove() {} }) } };
    const scheduler = { ...sr.scheduler, registerHandler: (type, fn, o) => sr.scheduler.registerHandler(type,
      type !== S.STEP_EVENT_TYPE ? fn : wrapStep(fn), o) };
    const started = startPlayerSiege({ config: cfg, persistence: { ok: true, store: opened.store, journal }, clock,
      ids: shared.ids, scheduler, fleets, strategy: { registry: { isActive: () => true,
        getFaction: () => ({ kind: "pirate" }) } },
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) },
      adapter: { playerStructureSeams: () => ({ ok: true }), playerStructures: seam,
        readCharacterStanding: () => ({ ok: true, found: true, standing: -10 }) },
      getVirtualCorps: () => ({ isVirtualCorporation: () => false }) });
    assert.ok(started.ok, JSON.stringify(started));
    const ps = started.playerSiege;
    const tx = (fn) => {
      const r = opened.store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const openList = () => tx((db) => ps.listOpen(db, { limit: 8 })).sieges;
    return { sr, ps, clock, vendor, tx, openList, journal };
  }

  needsDriver("PG3 playerSiege restart: the hit lands, the effect crashes, the retry sees the vendor ahead -> ADVANCE "
    + "without a second hit; the same key again -> DONE, zero hits", () => H.withStore(driver, async (reopen) => {
    const crash = { armed: false };
    const { sr, ps, clock, vendor, openList } = rig(reopen, (fn) => (ev, hctx) => {
      const res = fn(ev, hctx);
      if (!crash.armed || !res || typeof res.effect !== "function") return res;
      crash.armed = false;
      return { ...res, effect: (tx, event) => {
        res.effect(tx, event);
        throw new Error("crash after the effect writes");
      } };
    });
    const at = clock.now();
    assert.ok(sr.scheduler.enqueue(S.CHECK_EVENT_TYPE, String(SYS), at, { systemId: SYS, at, triggerFleetId: null },
      "test:check").ok);
    await sr.scheduler.runPass();
    const [siege] = openList();
    assert.deepStrictEqual([siege.state, siege.structureId, siege.attackerFactionId], [S.SHIELD_ASSAULT, SID, PIRATE]);

    clock.set(siege.phaseEndsAt);
    crash.armed = true;
    await sr.scheduler.runPass();
    assert.deepStrictEqual([vendor.hits, openList()[0].state], [1, S.SHIELD_ASSAULT], "hit landed, effect rolled back");
    clock.set(siege.phaseEndsAt + 5000);
    await sr.scheduler.runPass();
    const after = openList()[0];
    assert.deepStrictEqual([vendor.hits, after.state, after.phaseSeq, after.vendorState],
      [1, S.ARMOR_TIMER, 1, "ARMOR_REINFORCE"]);
    const again = sr.scheduler.enqueue(S.STEP_EVENT_TYPE, siege.siegeId, siege.phaseEndsAt,
      { siegeId: siege.siegeId, phaseSeq: 0, round: 0 }, S.stepKey(siege.siegeId, 0, 0));
    assert.deepStrictEqual([again.ok, again.duplicate, again.state], [true, true, "DONE"]);
    await sr.scheduler.runPass();
    assert.strictEqual(vendor.hits, 1);
    ps.stop("test");
  }));

  needsDriver("PG6 reconcile: an open siege whose STEP is QUARANTINED ends ABORTED STEP_LOST (counters "
    + "end CHECK); a second reconcile closes nothing", () => H.withStore(driver, async (reopen) => {
    const lose = { armed: false, permanent: true };
    const { sr, ps, clock, vendor, openList } = rig(reopen, (fn) => (ev, hctx) => (lose.armed
      ? { ok: false, reason: "TEST_LOST", permanent: lose.permanent } : fn(ev, hctx)));
    const at = clock.now();
    assert.ok(sr.scheduler.enqueue(S.CHECK_EVENT_TYPE, String(SYS), at, { systemId: SYS, at, triggerFleetId: null },
      "test:check").ok);
    await sr.scheduler.runPass();
    const [siege] = openList();
    const stepState = () => sr.scheduler.findByKey(S.stepKey(siege.siegeId, 0, 0)).event;
    assert.strictEqual(stepState().state, "QUEUED");
    assert.deepStrictEqual([ps.reconcile().lost, openList().length], [0, 1]);
    clock.set(siege.phaseEndsAt);
    lose.armed = true;
    lose.permanent = false;
    await sr.scheduler.runPass();
    assert.strictEqual(stepState().state, "RETRY");
    assert.deepStrictEqual([ps.reconcile().lost, openList().length], [0, 1]);
    lose.permanent = true;
    clock.set(stepState().dueAt);
    await sr.scheduler.runPass();
    const step = sr.scheduler.findByKey(S.stepKey(siege.siegeId, 0, 0));
    assert.deepStrictEqual([step.event.state, openList().length], ["QUARANTINED", 1]);
    const rec = ps.reconcile();
    assert.deepStrictEqual([rec.ok, rec.lost, rec.open, openList().length], [true, 1, 0, 0], JSON.stringify(rec));
    const c = ps.getStatus().counters;
    assert.deepStrictEqual([c.stepLost, c.aborted, vendor.hits], [1, 1, 0]);
    assert.strictEqual(sr.scheduler.findByKey(S.endCheckKey(SYS, siege.siegeId)).found, true);
    assert.strictEqual(ps.reconcile().lost, 0);
    ps.stop("test");
  }));

  needsDriver("PG7 durable flush of the hit: a promise of false or a rejection -> flushFailed once, a promise of "
    + "true -> none; the hit still advances the siege", async () => {
    const run = (flushedOf) => H.withStore(driver, async (reopen) => {
      const { sr, ps, clock, vendor, openList } = rig(reopen, (fn) => fn, flushedOf);
      const at = clock.now();
      assert.ok(sr.scheduler.enqueue(S.CHECK_EVENT_TYPE, String(SYS), at, { systemId: SYS, at, triggerFleetId: null },
        "test:check").ok);
      await sr.scheduler.runPass();
      const [siege] = openList();
      clock.set(siege.phaseEndsAt);
      await sr.scheduler.runPass();
      await new Promise((r) => setImmediate(r));
      const out = [vendor.hits, openList()[0].state, ps.getStatus().counters.flushFailed];
      ps.stop("test");
      return out;
    });
    assert.deepStrictEqual(await run(() => Promise.resolve(true)), [1, S.ARMOR_TIMER, 0]);
    assert.deepStrictEqual(await run(() => Promise.resolve(false)), [1, S.ARMOR_TIMER, 1]);
    assert.deepStrictEqual(await run(() => Promise.reject(new Error("worker gone"))), [1, S.ARMOR_TIMER, 1]);
  });
};
