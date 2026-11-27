"use strict";

const assert = require("node:assert");

const R = require("../../lib/world/devIndices/rules");
const S = require("../../lib/world/devIndices/schema");
const CMD = require("../../lib/world/devIndices/command");
const { createDevHints, registerDevHints } = require("../../lib/world/devIndices/gmHint");
const { startDevIndices } = require("../../lib/world/devIndices");
const { createContactService } = require("../../lib/battle/contactService");
const { planSellOffers } = require("../../lib/strategy/ai/tradeSell");
const { describe } = require("../../lib/strategy/ai/targeting");
const { garrisonPowerOf } = require("../../lib/strategy/ai/strength");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: RV } = require("../strategy/review.test");
const F = require("./fixture");

const { FACTION_A: SANSHA, FACTION_B: OWNER } = H;
const SMALL = Object.freeze([{ hullGroup: "frigate", count: 2 }]);
const EFFECTS_ENV = Object.freeze({ EVEJS_LNE_DEV_INDICES_GARRISON_ENABLED: "1",
  EVEJS_LNE_DEV_INDICES_TRADE_DISCOUNT_ENABLED: "1", EVEJS_LNE_DEV_INDICES_GM_HINT_ENABLED: "1" });

function devFake(P, levels, counts) {
  return { effectsOf: (systemId, use) => {
    if (counts) counts.push([systemId, use]);
    return R.effectsOf(levels[systemId] || null, P);
  } };
}

function contactOf(opts = {}) {
  const created = [];
  const fleets = [{ fleetId: "fa", factionId: SANSHA, state: "STAGED", shipCount: 5, operationId: null, version: 1,
    composition: SMALL }, { fleetId: "fb", factionId: OWNER, state: "IDLE", shipCount: 5, operationId: null, version: 1,
    composition: SMALL }];
  const svc = createContactService({
    store: { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) },
    scheduler: { enqueue: () => ({ ok: true }) },
    battleRepository: { createBattle: (tx, spec) => {
      created.push(spec);
      return { ok: true, battleId: "b1", duplicate: false };
    } },
    cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
    fleetRepository: { listFleetsInSystem: () => ({ ok: true, fleets, nextAfterFleetId: null }),
      getFleets: (tx, ids) => ({ ok: true, fleets: fleets.filter((f) => ids.includes(f.fleetId)) }) },
    getGraph: () => ({ getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) }),
    worldRepository: { getSystem: (tx, systemId, o) => {
      if (opts.calls) opts.calls.push(o);
      return { ok: true, system: { controllerFactionId: opts.controller || null,
        influence: [{ factionId: OWNER, garrisonStrength: 30 }] } };
    } },
    resolverVersion: "internal-v1",
    settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
      stationGarrisonEnabled: false, structureLiveCombatEnabled: false, ...(opts.settings || {}) },
    ...(opts.grid ? { grid: opts.grid } : {}),
    ...(opts.getDevIndices ? { getDevIndices: opts.getDevIndices } : {}),
    limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 }, isHostile: () => true, bump: () => {},
    logger: { log() {} }, isActive: () => true });
  const r = svc.onContactCheck({ payload: { systemId: H.S.N5, at: 0, triggerFleetId: "fa" } });
  assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
  assert.ok(r.effect({ inTransaction: true }, { idempotencyKey: "contact:k" }).ok);
  return created[0];
}

const T = Object.freeze({ maxOffersPerReview: 10, wtsOffersPerReview: 10, wtsMaxOpenPerFaction: 10,
  maxOpenOffersPerFaction: 10, targetOpenContracts: 0, maxOpenOffersPerStation: 10, wtsStationSlotHeadroom: 0,
  maxQuantityPerOffer: 1000, wtsMaxIskPerOffer: 1000000000, minIskPerOffer: 1, hullMaxPerOffer: 5, wtsTtlMs: 3600000 });

function wtsUnit(trade) {
  const newOffers = [];
  planSellOffers({ trade: { open: [], sellQuotes: { "type:34": { ok: true, unitMilli: 10000, refMilli: 10000 } },
    ...trade }, T, at: 0, newOffers, intents: [], notes: [],
  candidates: [{ stationId: "s1", stationInfo: { stationId: "s1", systemId: 7, ownerCorporationId: 1000002 },
    itemKind: "mineral", itemKey: "type:34", typeId: 34, surplus: 100 }],
  state: { budgetLeft: 0, openFactionCount: 0, openPerStation: new Map(), offersCreated: 0 } });
  assert.strictEqual(newOffers.length, 1);
  return newOffers[0].unitPriceMilli;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("DI11 effectsOf table + garrison: controller on B +mil x 20, on A nothing, flag off = the same spec", () => {
    const off = F.settingsFor();
    const on = F.settingsFor(EFFECTS_ENV);
    const lv = { mil: 3, ind: 1, trade: 5 };
    assert.deepStrictEqual([R.effectsOf(lv, off), R.effectsOf(null, on), R.effectsOf(lv, on),
      R.effectsOf({ mil: 9, trade: 2 }, on)], [S.NO_EFFECTS, S.NO_EFFECTS,
      { garrisonPoints: 60, wtsDiscountPermille: 40, sites: false },
      { garrisonPoints: 100, wtsDiscountPermille: 16, sites: false }]);

    const levels = { [H.S.N5]: { mil: 3, ind: 0, trade: 0 } };
    const seen = [];
    const onB = contactOf({ controller: OWNER, getDevIndices: () => devFake(on, levels, seen) });
    assert.deepStrictEqual(onB.garrison, { side: "B", factionId: OWNER, strength: 30 + 60 });
    assert.deepStrictEqual(seen, [[H.S.N5, "garrison"]]);
    const onA = contactOf({ controller: SANSHA, getDevIndices: () => devFake(on, levels) });
    assert.strictEqual(onA.garrison.strength, 30, "the controller on side A gets nothing");
    const base = contactOf({ controller: OWNER });
    assert.deepStrictEqual(contactOf({ controller: OWNER, getDevIndices: () => devFake(off, levels) }), base,
      "flag off = the spec of today");
    assert.deepStrictEqual(contactOf({ controller: OWNER, getDevIndices: () => {
      throw new Error("boom");
    } }), base, "a throwing getter = nothing");
  });

  test("DI14 influenceGarrison off + getter: B the controller -> mil x 20, one getSystem without influence "
    + "no getter -> no getSystem", () => {
    const on = F.settingsFor(EFFECTS_ENV);
    const levels = { [H.S.N5]: { mil: 3, ind: 0, trade: 0 } };
    const calls = [];
    const offOn = contactOf({ controller: OWNER, settings: { influenceGarrison: "off" }, calls,
      getDevIndices: () => devFake(on, levels) });
    assert.deepStrictEqual(offOn.garrison, { side: "B", factionId: OWNER, strength: 3 * 20 });
    assert.deepStrictEqual(calls, [{ includeInfluence: false }]);
    const none = [];
    const base = contactOf({ controller: OWNER, settings: { influenceGarrison: "off" }, calls: none });
    assert.deepStrictEqual([none, base.garrison], [[], null], "no getter = no read, the spec of today");
  });

  test("DI15 off + grid: a contact outside the CP grid without a station of B (influenceAllowed false) -> 0",
    () => {
      const on = F.settingsFor(EFFECTS_ENV);
      const levels = { [H.S.N5]: { mil: 3, ind: 0, trade: 0 } };
      const gridAt = (gridKey) => ({ isEnabled: () => true,
        positionsOf: () => ({ ok: true, anchorsReason: null, positions: new Map([["fa", { kind: "anchor", gridKey }],
          ["fb", { kind: "anchor", gridKey }]]) }),
        readSystemGrid: () => ({ ok: true, cp: { kind: "station", id: 9 },
          grids: [{ gridKey: "station:9", anchors: [{ kind: "station", id: 9 }] }] }) });
      const settings = { influenceGarrison: "off", gridContactsEnabled: true };
      const getDevIndices = () => devFake(on, levels);
      const outside = contactOf({ controller: OWNER, settings, grid: gridAt("gate:1"), getDevIndices });
      assert.strictEqual(outside.garrison, null, "influenceAllowed false -> no dev garrison");
      const cp = contactOf({ controller: OWNER, settings, grid: gridAt("station:9"), getDevIndices });
      assert.deepStrictEqual(cp.garrison, { side: "B", factionId: OWNER, strength: 60 }, "the CP grid -> the bonus");
    });

  test("DI16 planner: resolver + influencePoints false + devGarrison 60 -> garrisonPowerOf(60 + stations) "
    + "no field = today", () => {
    const ge = { mode: "resolver", influencePoints: false, stationPoints: 10, powerPerPoint: 2 };
    const snapOf = (sys) => ({ factionId: 1, isHostile: (x) => x === 2, at: 0, theatre: [], doctrine: {},
      systems: [{ systemId: 5, controllerFactionId: 2, controllerGarrison: 40, hostileStations: 1, ...sys }] });
    const garrisonOf = (sys, g = ge) => describe(snapOf(sys), { garrisonEstimate: g }, new Map(), 5).garrison;
    assert.strictEqual(garrisonOf({ devGarrison: 60 }), garrisonPowerOf(60 + 10, 2));
    assert.strictEqual(garrisonOf({}), garrisonPowerOf(10, 2), "no field = the estimate of today");
    assert.strictEqual(garrisonOf({ devGarrison: 60 }, { ...ge, influencePoints: true }),
      garrisonPowerOf(40 + 60 + 10, 2));
    assert.strictEqual(garrisonOf({ devGarrison: 60 }, { mode: "legacy" }), 40, "legacy unchanged");
  });

  needsDriver("DI16b review snapshot: devGarrison only on a foreign controller with points, no `use`; no "
    + "getter / flag off -> no key", async () => {
    const levels = Object.fromEntries(RV.THEATRE.map((id) => [id, { mil: 3, ind: 0, trade: 0 }]));
    const run = (getDevIndices) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(RV.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: RV.graphOf(),
        controllers: new Map(RV.THEATRE.map((id) => [id, RV.SANSHA])) };
      const seen = [];
      const hooks = { beforeEffect: (d, snapshot) => {
        seen.push(snapshot);
        return d;
      } };
      const e = await RV.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
        { hooks, getDevIndices });
      await RV.passesAt(e, shared, RV.START_MS + RV.I);
      e.strategy.stop("test");
      return seen;
    });
    const rowsWithKey = (seen) => seen.flatMap((s) => s.systems.filter((x) => "devGarrison" in x)
      .map((x) => [s.factionId, x.systemId, x.controllerFactionId, x.devGarrison]));
    const uses = [];
    const on = await run(() => devFake(F.settingsFor(EFFECTS_ENV), levels, uses));
    const keyed = rowsWithKey(on);
    assert.ok(keyed.length > 0, "a foreign Sansha system carries the dev garrison");
    assert.ok(keyed.every(([f, , c, g]) => f !== c && c === RV.SANSHA && g === 60), JSON.stringify(keyed));
    assert.ok(uses.length > 0 && uses.every(([, use]) => use === undefined), "no use -> effects.garrison untouched");
    assert.deepStrictEqual(rowsWithKey(await run(undefined)), [], "no getter");
    assert.deepStrictEqual(rowsWithKey(await run(() => devFake(F.settingsFor(), levels))), [], "flag off");
  });

  test("DI12 WTS discount: max 40 per mille, floor own WTB + 1, no map = the price of today", () => {
    const today = wtsUnit({});
    assert.strictEqual(today, 10000);
    const P = F.settingsFor(EFFECTS_ENV);
    const d = R.effectsOf({ mil: 0, ind: 0, trade: 5 }, P).wtsDiscountPermille;
    assert.strictEqual(d, P.tradeDiscountMaxPermille);
    assert.strictEqual(wtsUnit({ devWtsDiscounts: new Map([[7, d]]) }), 10000 - 400);
    assert.strictEqual(wtsUnit({ devWtsDiscounts: new Map([[8, d]]) }), today, "another system");
    assert.strictEqual(wtsUnit({ devWtsDiscounts: new Map([[7, d]]), buyUnitMax: { 34: 9900 } }), 9901);
  });

  test("DI13 GM hint: FULL -> gm.refused, read <= 3 ASCII lines without ids, no gmSteps -> nothing; !dev Effects", () => {
    const counts = {};
    const bump = (name) => {
      counts[name] = (counts[name] || 0) + 1;
    };
    const hints = createDevHints({ systemNameOf: (id) => (id === 30000142 ? "Jita" : id === 9 ? "Sysé" : "Amarr"),
      bump });
    assert.strictEqual(hints.read(), null, "empty buffer");
    hints.push([{ kind: "collapse", systemId: 30000142, index: "mil", level: 1 },
      { kind: "boom", systemId: 30002187, index: "trade", level: 5 }, { kind: "boom", systemId: 9, index: "ind", level: 5 },
      { kind: "collapse", systemId: 30000142, index: "ind", level: 2 }, { kind: "boom", systemId: 30000142, index: "mil",
        level: 5 }]);
    const r = hints.read();
    assert.deepStrictEqual(r, { lines: ["Boom: Jita military 5", "Collapse: Jita industry fell to 2",
      "Boom: Amarr trade 5"] });
    for (const line of r.lines) {
      assert.ok(/^[\x20-\x7e]{1,160}$/.test(line) && !/3000/.test(line), line);
    }
    hints.push(Array.from({ length: 20 }, () => ({ kind: "boom", systemId: 1, index: "mil", level: 5 })));
    assert.strictEqual(hints.size(), S.GM_HINT_BUFFER);
    assert.strictEqual(counts["gm.reads"], 2);
    const full = { registerHintSource: () => ({ ok: false, reason: "FULL" }) };
    assert.deepStrictEqual(registerDevHints(full, hints), { ok: false, reason: "FULL" });
    assert.deepStrictEqual(registerDevHints(null, hints), { ok: false, reason: "NO_REGISTRY" });

    const timers = { setTimer: () => ({ cancel() {}, hasRef: () => false }) };
    const start = (gmSteps) => startDevIndices({ config: F.configOf(EFFECTS_ENV).config,
      persistence: { ok: true, store: {} }, clock: { now: () => F.T0 }, setTimer: timers.setTimer, gmSteps });
    const a = start(full);
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.deepStrictEqual([a.devIndices.getStatus().counters["gm.refused"],
      a.devIndices.getStatus().counters["gm.registered"]], [1, 0]);
    assert.deepStrictEqual(a.devIndices.effectsOf(1), S.NO_EFFECTS, "cold index");
    a.devIndices.stop("test");
    const b = start(null);
    assert.deepStrictEqual([b.devIndices.getStatus().counters["gm.refused"],
      b.devIndices.getStatus().counters["gm.registered"]], [0, 0]);
    b.devIndices.stop("test");
    const sources = [];
    const c = start({ registerHintSource: (src) => {
      sources.push(src.key);
      return { ok: true, unregister: () => sources.push(`-${src.key}`) };
    } });
    c.devIndices.stop("test");
    assert.deepStrictEqual(sources, ["devIndices", "-devIndices"]);

    const levels = Object.freeze({ mil: 3, ind: 1, trade: 2, milPoints: 3100, indPoints: 1000, tradePoints: 2000,
      trend: { mil: 0, ind: 0, trade: 0 } });
    assert.strictEqual(CMD.formatEffectsLine(levels, F.settingsFor(EFFECTS_ENV)), "Effects: garrison +60, market -1.6%");
    assert.strictEqual(CMD.formatEffectsLine(levels, F.settingsFor({ EVEJS_LNE_DEV_INDICES_GARRISON_ENABLED: "1" })),
      "Effects: garrison +60");
    assert.strictEqual(CMD.formatEffectsLine(levels, F.settingsFor()), null);
  });
};
