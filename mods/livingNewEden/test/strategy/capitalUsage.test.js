"use strict";

const assert = require("node:assert");

const { TALLY_CODES, tallyReview, inventoryOf } = require("../../lib/strategy/capitalUsage");
const { buildActivityView } = require("../../lib/strategy/activity/activityView");
const { planCapitalAttach } = require("../../lib/strategy/ai/capitalAttach");
const { createViewRegistry } = require("../../lib/observer/views");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const AT = 1760000000000;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("TU1 tallyReview: notes by prefix, once per review, codes outside TALLY_CODES ignored; new frozen object", () => {
    assert.ok(TALLY_CODES.includes("LADDER_SAVING") && !TALLY_CODES.includes("FRONT_LIMIT"));
    const a = tallyReview(null, { at: AT, notes: ["LADDER_SAVING:titan:468", "LADDER_SAVING:titan:470",
      "CAPITAL_NOT_AT_STATION", "FRONT_LIMIT", "NO_TARGET:NO_CANDIDATE"], applied: [], ladder: null, inventory: null });
    assert.deepStrictEqual([a.since, a.reviews, a.notes], [AT, 1, { LADDER_SAVING: 1, CAPITAL_NOT_AT_STATION: 1 }]);
    assert.ok(Object.isFrozen(a) && Object.isFrozen(a.notes) && Object.isFrozen(a.levels));
    const ladder = { note: "LADDER_WAIT_BUFFER", cls: null, bufferPermille: 512 };
    const b = tallyReview(a, { at: AT + 1, notes: ["LADDER_SAVING:titan:500", "ESCALATION_L2"], applied: [
      { type: "MOBILIZE", composition: [{ hullGroup: "cruiser", count: 4 }, { hullGroup: "carrier", count: 1 }],
        escalationLevel: 2 },
      { type: "LAUNCH", mobilize: [{ type: "MOBILIZE", composition: [{ hullGroup: "titan", count: 1 }],
        escalationLevel: 3 }, { type: "MOBILIZE", composition: [{ hullGroup: "cruiser", count: 4 }], capitalGated: true }] },
      { type: "REPLENISH", capital: true }, { type: "REPLENISH" }], ladder, inventory: null });
    assert.notStrictEqual(b, a);
    assert.deepStrictEqual([a.reviews, a.notes.LADDER_SAVING, a.levels], [1, 1, [0, 0, 0, 0]], "prev unchanged");
    assert.deepStrictEqual([b.since, b.reviews, b.notes, b.attached, b.escorts, b.gated, b.replenished, b.levels],
      [AT, 2, { LADDER_SAVING: 2, CAPITAL_NOT_AT_STATION: 1, ESCALATION_L2: 1 }, 2, 1, 1, 1, [0, 0, 1, 1]]);
    assert.deepStrictEqual([b.ladder, b.inventory], [{ ...ladder, at: AT + 1 }, null]);
  });

  test("TU2 inventoryOf: battleships / capitals in stations and fleets apart, capitals by CAPITAL_HULL_GROUPS", () => {
    const snap = { production: { stations: [{ hulls: { battleship: 3, carrier: 1, titan: 1, cruiser: 9 } },
      { hulls: { dreadnought: 2, capital: 7 } }, {}] },
    fleets: [{ composition: [{ hullGroup: "battleship", count: 2 }, { hullGroup: "force_auxiliary", count: 1 }] },
      { composition: [{ hullGroup: "capital", count: 5 }, { hullGroup: "supercarrier", count: 1 }] }, { composition: null }] };
    assert.deepStrictEqual(inventoryOf(snap), { battleshipStock: 3, battleshipFleets: 2, capitalStock: 4,
      capitalFleets: 2 });
    assert.deepStrictEqual(inventoryOf({ production: null, fleets: [] }), { battleshipStock: 0, battleshipFleets: 0,
      capitalStock: 0, capitalFleets: 0 });
  });

  needsDriver("TU3 real store: two committed Sansha reviews -> reviews 2, levels from escalationLevel; a rolled back "
    + "review counts nothing; no tally field in the journal payload", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const state = { round: 0 };
    const hooks = { beforeEffect: (d) => {
      if (d.factionId !== R.SANSHA) return d;
      state.round += 1;
      if (state.round === 1) {
        return { ...d, intents: d.intents.map((i) => (i.type === "MOBILIZE" && i.role === "hunter"
          ? { ...i, escalationLevel: 2 } : i)) };
      }
      if (state.round === 3) return { ...d, intents: null };
      return d;
    } };
    const views = createViewRegistry();
    const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA) },
      { hooks, strategyViews: views, getHunt: () => ({ getState: () => "running" }) });
    const usage = () => views.getView("activity").getData().factions.find((x) => x.factionId === R.SANSHA)
      .capitalUsage;
    assert.strictEqual(usage(), null, "no review yet");

    await R.passesAt(env, shared, R.START_MS + R.I);
    const u1 = usage();
    assert.ok(u1, "after the first review");
    assert.deepStrictEqual([u1.reviews, u1.levels], [1, [0, 0, 1, 0]], JSON.stringify(u1));
    assert.deepStrictEqual(Object.keys(u1.inventory).sort(), ["at", "battleshipFleets", "battleshipStock",
      "capitalFleets", "capitalStock"]);
    await R.passesAt(env, shared, R.START_MS + 2 * R.I);
    const u2 = usage();
    assert.deepStrictEqual([u2.reviews, u2.levels, u2.since], [2, [0, 0, 1, 0], u1.since], JSON.stringify(u2));
    await R.passesAt(env, shared, R.START_MS + 3 * R.I);
    assert.strictEqual(state.round, 3, "the third review ran");
    assert.deepStrictEqual([usage().reviews, usage().levels], [2, [0, 0, 1, 0]], "the rolled back review counts nothing");
    const c = env.strategy.getStatus().ai.review.counters;
    assert.ok(["capitalNotAtStation", "ladderWaitBuffer", "ladderSaving"].every((n) => c[n] === 0), JSON.stringify(c));
    const payloads = env.q("SELECT payload FROM world_event_journal WHERE idempotency_key LIKE 'strategy:review:%'")
      .map((r) => String(r.payload));
    assert.ok(payloads.length > 0);
    assert.ok(payloads.every((p) => !/ladderDiag|usageIntents|capitalUsage|capitalInventory/.test(p)));
    env.strategy.stop("test");
    env.stations.stop("test");
  }));

  test("TU5 hunter without minLevelOf: titan only -> gated, titan + carrier -> the carrier "
    + "a garrison keeps the titan", () => {
    const attach = { roles: ["hunter", "garrison"], order: ["titan", "supercarrier", "carrier"], max: 1, maxGroups: 9,
      maxEntries: 9, maxShips: 99, freeGroups: [] };
    const lg = { available: () => 1 };
    const base = { template: [{ hullGroup: "cruiser", count: 2 }], stationId: "st1", lg, attach, iskLeft: null,
      war: null };
    const titanOnly = planCapitalAttach({ ...base, role: "hunter", capitalClasses: { titan: 11001 } });
    assert.deepStrictEqual([titanOnly.entries, titanOnly.note, titanOnly.gated], [[], "CAPITAL_LEVEL_GATED", true]);
    const both = { titan: 11001, supercarrier: 11002, carrier: 11004 };
    assert.deepStrictEqual(planCapitalAttach({ ...base, role: "hunter", capitalClasses: both }).entries,
      [{ hullGroup: "carrier", typeId: 11004, count: 1 }]);
    assert.deepStrictEqual(planCapitalAttach({ ...base, role: "garrison", capitalClasses: both }).entries,
      [{ hullGroup: "titan", typeId: 11001, count: 1 }]);
  });

  test("TU4 activity: capitalUsage (a copy) for the faction with a review, null for the one without", () => {
    const I = 900000;
    const NOW = 1000 * I;
    const F1 = 500001;
    const F2 = 500002;
    const u = tallyReview(null, { at: NOW, notes: ["LADDER_FULL"], applied: [], ladder: null,
      inventory: { battleshipStock: 1, battleshipFleets: 0, capitalStock: 2, capitalFleets: 0 } });
    const db = { inTransaction: true };
    const view = buildActivityView({
      store: { isOpen: () => true, transaction: (name, fn) => ({ ok: true, value: fn(db), rows: 0 }) },
      repository: { listFactions: () => ({ ok: true, records: [F1, F2].map((f) => ({ factionId: f, status: "ACTIVE",
        lastReviewAt: NOW - 60000 })) }), getChangeCount: () => 1 },
      registry: { listActiveFactions: () => [{ factionId: F1 }, { factionId: F2 }], getCampaignsForFaction: () => [] },
      getStatus: () => ({ state: "running", reason: null, seq: 1, seed: { state: "done" }, ai: { state: "on",
        reason: null }, campaigns: [] }),
      graph: { getGraph: () => ({ ok: true, graph: { getSystem: () => null } }) },
      clock: { now: () => NOW },
      config: { observer: { factionActivityMaxItems: 5, factionActivityStaleFactor: 3, factionActivityRefreshMs: 15000 },
        strategy: { reviewIntervalMs: I, maxFleetsReadPerReview: 64 }, siege: { maxOpenSieges: 10 } },
      getGovernor: () => ({ admits: () => true }),
      factionNames: new Map([[F1, "A"], [F2, "B"]]),
      getAiService: () => ({ getMemory: () => null, getSeq: () => 1, getStatus: () => ({ lastRefusal: null }),
        getCapitalUsage: (f) => (f === F1 ? u : null),
        schedule: { bucketOf: (f, t) => Math.floor(t / I), dueOf: (f, b) => b * I,
          reviewKey: (f, b) => `strategy:review:${f}:${b}`, nextOf: (f, at) => ({ dueAt: (Math.floor(at / I) + 1) * I }) } }),
      scheduler: { getStatus: () => ({ state: "ready" }), findByKey: () => ({ ok: true, found: false }) },
      fleets: { repository: { listOperations: () => ({ ok: true, operations: [] }),
        listFleetsByFaction: () => ({ ok: true, fleets: [] }) } },
    });
    const data = view.getData();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    const of = (f) => data.factions.find((x) => x.factionId === f).capitalUsage;
    assert.deepStrictEqual(of(F1), { ...u, notes: { LADDER_FULL: 1 }, levels: [0, 0, 0, 0], ladder: null,
      inventory: { battleshipStock: 1, battleshipFleets: 0, capitalStock: 2, capitalFleets: 0, at: NOW } });
    assert.notStrictEqual(of(F1), u);
    assert.strictEqual(Object.isFrozen(of(F1)), false, "a copy, not the RAM object");
    assert.strictEqual(of(F2), null);
  });
};
