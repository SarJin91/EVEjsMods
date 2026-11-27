"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { buildDemand } = require("../../lib/localPilots/demand");
const { assignPilots } = require("../../lib/localPilots/assign");
const { startLocalPilots } = require("../../lib/localPilots");
const { buildCrewRoster } = require("../../lib/localPilots/crewRoster");
const { createUnavailableCrews } = require("../../lib/crews");
const seamModule = require("../../lib/adapter/localPilots");
const { resolveConfig } = require("../../config");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NULL_A = 30000142;
const NULL_B = 30000144;
const WH = 31000005;
const FACTION = 500010;
const OTHER_FACTION = 500011;
const CORP = 98000101;
const CORP_B = 98000102;

function demandOf(systemId, pools) {
  return { systemId, pools: pools.map(([factionId, corporationId, wanted]) => ({
    poolKey: `${factionId}:${corporationId || 0}`, factionId, corporationId, ships: wanted, wanted })) };
}

function fakeVendor(records) {
  const emitter = new EventEmitter();
  const publishes = [];
  const sessions = new Map();
  const chat = {
    on: emitter.on.bind(emitter),
    getLocalSessionsForRoom: (room) => sessions.get(room) || [],
    publishLocalMembershipListForSession(session) {
      publishes.push(session.systemId);
      const event = { solarSystemID: session.systemId, members: [] };
      emitter.emit("local-membership-list", event);
      return event;
    },
    buildLocalGatewayMember: (s) => ({ character: { sequential: s.characterID },
      corporation: { sequential: s.corporationID }, alliance: s.allianceID ? { sequential: s.allianceID } : null,
      no_alliance: !s.allianceID, faction: null, no_faction: true, classification: "CLASSIFICATION_UNSPECIFIED" }),
  };
  const rules = {
    getLocalChatRoomNameForSolarSystemID: (id) => `solarsystemid2_${id}`,
    isDelayedLocalChatRoomName: (room) => Number(room.split("_")[1]) >= 31000000,
  };
  const state = { peekCharacterRecord: (id) => records.get(id) || null };
  const modules = { "_secondary/chat/chatRuntime": chat, "services/chat/channelRules": rules,
    "services/character/characterState": state };
  seamModule._resetForTest();
  seamModule.install(chat);
  const real = seamModule.createLocalPilotsSeam({ requireGame: (rel) => ({ ok: true, exports: modules[rel] }) });
  const log = { setRoster: [], repush: [], clears: 0, describe: 0 };
  const members = new Map();
  const seam = { ...real,
    setRoster(sid, list) {
      members.set(sid, list);
      log.setRoster.push([sid, list.map((m) => m.character.sequential)]);
      return real.setRoster(sid, list);
    },
    repushSystem(sid) {
      log.repush.push(sid);
      return real.repushSystem(sid);
    },
    clearRosters() {
      log.clears += 1;
      return real.clearRosters();
    },
    describeCharacter(id) {
      log.describe += 1;
      return real.describeCharacter(id);
    },
  };
  const localOf = (sid) => chat.publishLocalMembershipListForSession({ systemId: sid }).members
    .map((m) => m.character.sequential);
  return { seam, log, sessions, publishes, localOf, emitter, members };
}

function baseSettings(over) {
  return { enabled: true, refreshMs: 15000, nudgeDelayMs: 1000, deferRetryMs: 3000, maxSystemsPerPass: 8,
    maxFleetsPerSystem: 64,
    shipsPerPilot: 1, maxPilotsPerFactionPerSystem: 20, maxPilotsPerSystem: 40, maxRepushPerPass: 8,
    maxPoolCharacters: 512, ...over };
}

function world() {
  const records = new Map();
  const candidates = [];
  for (let i = 1; i <= 7; i += 1) {
    const id = 91000000 + i;
    records.set(id, { corporationID: i <= 5 ? CORP : CORP_B, allianceID: 99000010 });
    candidates.push({ characterId: id, ownerKind: "faction", ownerId: FACTION });
  }
  return { records, candidates };
}

function boot(opts) {
  const w = opts.world || world();
  const vendor = opts.vendor || fakeVendor(w.records);
  const fleets = opts.fleets || new Map();
  const timers = [];
  const reads = [];
  const presenceState = opts.presenceState || { observed: [NULL_A] };
  const listeners = { observed: [], unobserved: [], arrival: [] };
  const governor = { admit: true, admits: () => governor.admit };
  const store = { transaction(name, fn) {
    try {
      return { ok: true, value: fn({ tx: name }) };
    } catch (error) {
      return { ok: false, reason: "TX_FAILED", error };
    }
  } };
  const ctx = {
    adapter: { localPilotsSeams: () => ({ ok: true, seam: vendor.seam }) },
    persistence: { ok: true, store },
    governor,
    presence: {
      observedSystems: () => presenceState.observed.slice(),
      isObserved: (id) => presenceState.observed.includes(id),
      onSystemObserved: (cb) => { listeners.observed.push(cb); return { ok: true, unsubscribe() {
        listeners.observed.splice(listeners.observed.indexOf(cb), 1); } }; },
      onSystemUnobserved: (cb) => { listeners.unobserved.push(cb); return { ok: true, unsubscribe() {
        listeners.unobserved.splice(listeners.unobserved.indexOf(cb), 1); } }; },
    },
    fleets: {
      repository: { listFleetsInSystem(db, sid, o) {
        reads.push([sid, o.limit, o.states.join(",")]);
        return { ok: true, fleets: (fleets.get(sid) || []).slice(0, o.limit) };
      } },
      travel: { addArrivalListener(fn) {
        listeners.arrival.push(fn);
        return { ok: true, remove() { listeners.arrival.splice(listeners.arrival.indexOf(fn), 1); } };
      } },
    },
    virtualCorps: { listPilotCandidates: () => ({ ok: true, version: 1, candidates: w.candidates }),
      whenReady: () => Promise.resolve(), ...(opts.virtualCorps || {}) },
  };
  if (opts.crews) ctx.crews = opts.crews;
  if (opts.highsecLife) ctx.highsecLife = opts.highsecLife;
  if (opts.freeCorps) ctx.freeCorps = opts.freeCorps;
  if (opts.npcVoices) ctx.npcVoices = opts.npcVoices;
  if (opts.bounty) ctx.bounty = opts.bounty;
  if (opts.population) ctx.population = opts.population;
  const started = startLocalPilots({ config: { localPilots: baseSettings(opts.settings),
    ...(opts.populationConfig ? { population: opts.populationConfig } : {}),
    ...(opts.bountyConfig ? { bountyHunters: opts.bountyConfig } : {}),
    ...(opts.crewsConfig ? { crews: opts.crewsConfig } : {}),
    ...(opts.freeCorpsConfig ? { freeCorps: opts.freeCorpsConfig } : {}),
    ...(opts.npcVoicesConfig ? { npcVoices: opts.npcVoicesConfig } : {}) }, ctx, telemetry: opts.telemetry || null,
    clock: opts.clock || { now: () => 0 }, setTimer: (fn, ms) => { const t = { ms, cancelled: false,
      fn() { t.cancelled = true; fn(); }, cancel() { t.cancelled = true; }, hasRef: () => false };
    timers.push(t); return t; } });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  return { lp: started.localPilots, vendor, fleets, timers, reads, presenceState, listeners, governor, ctx, w };
}

function fleet(factionId, corporationId, shipCount) {
  return { factionId, corporationId, shipCount, state: "IDLE" };
}

const CREWS_CONFIG = Object.freeze({ enabled: true, shipsPerPilot: 1, maxCrewPerFleet: 64, maxFleetsPerPass: 64 });

function fakeCrews(seats, state = "running") {
  const log = { reads: [], requests: [] };
  return { log, seats,
    getStatus: () => ({ state }),
    listSeatsInTx(db, ids) {
      log.reads.push([db, ids.slice()]);
      return { ok: true, byFleet: new Map(ids.filter((id) => seats.has(id)).map((id) => [id,
        seats.get(id).map((characterId, seat) => ({ seat, characterId, hullGroup: "frigate", typeId: null }))])) };
    },
    requestEnlist(ids) {
      log.requests.push(ids.slice());
      return { ok: true, queued: ids.length };
    } };
}

module.exports = ({ test }) => {
  test("LPA1 assignPilots: global uniqueness + shortfall, sticky ids, corporation before faction, "
    + "maxPilotsPerSystem cuts pools in ship order", () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const pool = { byCorp: new Map(), byFaction: new Map([[FACTION, ids]]) };
    const demand = [demandOf(NULL_A, [[FACTION, null, 4]]), demandOf(NULL_B, [[FACTION, null, 4]])];
    const first = assignPilots({ demand, pool, previous: new Map(), maxPilotsPerSystem: 40 });
    assert.deepStrictEqual([first.bySystem.get(NULL_A), first.bySystem.get(NULL_B), first.shortfall],
      [[1, 2, 3, 4], [5, 6], 2]);
    assert.strictEqual(first.assignment.size, 6, "no id twice");
    const again = assignPilots({ demand, pool, previous: first.assignment, maxPilotsPerSystem: 40 });
    assert.deepStrictEqual([...again.bySystem], [...first.bySystem], "same demand -> same ids");
    const shifted = assignPilots({ demand: [demandOf(NULL_A, [[FACTION, null, 6]]), demandOf(NULL_B,
      [[FACTION, null, 2]])], pool, previous: first.assignment, maxPilotsPerSystem: 40 });
    assert.deepStrictEqual([shifted.bySystem.get(NULL_A), shifted.bySystem.get(NULL_B)], [[1, 2, 3, 4], [5, 6]]);
    const shrink = assignPilots({ demand: [demandOf(NULL_A, [[FACTION, null, 2]])], pool,
      previous: first.assignment, maxPilotsPerSystem: 40 });
    assert.deepStrictEqual(shrink.bySystem.get(NULL_A), [1, 2], "the lowest previous stay");

    const mixed = { byCorp: new Map([[CORP, [20, 21]]]), byFaction: new Map([[FACTION, [10, 11, 20, 21]]]) };
    const corpFirst = assignPilots({ demand: [demandOf(NULL_A, [[FACTION, CORP, 3]])], pool: mixed,
      previous: new Map(), maxPilotsPerSystem: 40 });
    assert.deepStrictEqual(corpFirst.bySystem.get(NULL_A), [10, 20, 21], "corp 20,21 then faction 10");
    assert.deepStrictEqual([...corpFirst.assignment.keys()], [20, 21, 10]);

    const two = { byCorp: new Map(), byFaction: new Map([[FACTION, [1, 2, 3]], [OTHER_FACTION, [7, 8, 9]]]) };
    const capped = assignPilots({ demand: [demandOf(NULL_A, [[OTHER_FACTION, null, 3], [FACTION, null, 3]])],
      pool: two, previous: new Map(), maxPilotsPerSystem: 4 });
    assert.deepStrictEqual([capped.bySystem.get(NULL_A), capped.shortfall], [[1, 7, 8, 9], 0],
      "first pool (more ships) whole, the second cut to the room");
  });

  test("LPD1 buildDemand: groups (faction, corporation), ceil by shipsPerPilot, per pool cap, 0 ships skipped, "
    + "order", () => {
    const m = new Map([[NULL_B, [fleet(FACTION, CORP, 4)]], [NULL_A, [fleet(FACTION, CORP, 3), fleet(FACTION, CORP, 4),
      fleet(FACTION, null, 2), fleet(OTHER_FACTION, null, 0), fleet(OTHER_FACTION, CORP_B, 40)]]]);
    const d = buildDemand(m, { shipsPerPilot: 3, maxPilotsPerFactionPerSystem: 10 });
    assert.deepStrictEqual(d.map((s) => [s.systemId, s.pools.map((p) => [p.poolKey, p.ships, p.wanted])]), [
      [NULL_A, [[`${OTHER_FACTION}:${CORP_B}`, 40, 10], [`${FACTION}:${CORP}`, 7, 3], [`${FACTION}:0`, 2, 1]]],
      [NULL_B, [[`${FACTION}:${CORP}`, 4, 2]]]]);
  });

  test("LPS1 pass: 3+2 ships -> 5 pilots + 1 repush, then 0; a fleet gone -> 3 + repush; system unobserved -> "
    + "empty roster + repush; WH (delayed Local) never read nor rostered; governor refusal -> deferrals", () => {
    try {
      const fleets = new Map([[NULL_A, [fleet(FACTION, null, 3), fleet(FACTION, null, 2)]],
        [WH, [fleet(FACTION, null, 4)]]]);
      const env = boot({ fleets, presenceState: { observed: [WH, NULL_A] } });
      const { log } = env.vendor;
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(log.setRoster, [[NULL_A, [91000001, 91000002, 91000003, 91000004, 91000005]]]);
      assert.deepStrictEqual(log.repush, [NULL_A]);
      assert.deepStrictEqual(env.reads.map((r) => r[0]), [NULL_A], "WH not read");
      assert.deepStrictEqual(env.reads[0].slice(1), [65, "IDLE,PLANNED,STAGED,REFITTING,MATERIALIZED,ENGAGED"]);
      assert.deepStrictEqual(env.vendor.localOf(WH), [], "no pilots in WH Local");
      assert.strictEqual(env.vendor.localOf(NULL_A).length, 5, "the listener appends them");

      env.lp.runPassNow();
      assert.strictEqual(log.setRoster.length, 1, "no change -> no setRoster");
      assert.strictEqual(log.repush.length, 1, "no change -> no repush");

      fleets.set(NULL_A, [fleet(FACTION, null, 3)]);
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(1), [[NULL_A, [91000001, 91000002, 91000003]]]);
      assert.deepStrictEqual(log.repush.slice(1), [NULL_A]);

      env.presenceState.observed = [WH];
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(2), [[NULL_A, []]]);
      assert.deepStrictEqual(log.repush.slice(2), [NULL_A]);
      assert.deepStrictEqual(env.vendor.localOf(NULL_A), []);

      env.presenceState.observed = [NULL_A];
      env.governor.admit = false;
      const calls = [log.setRoster.length, log.repush.length, env.reads.length, log.describe];
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: false, reason: "DEFERRED" });
      assert.deepStrictEqual([log.setRoster.length, log.repush.length, env.reads.length, log.describe], calls);
      const st = env.lp.getStatus();
      assert.deepStrictEqual([st.deferrals, st.passes, st.repushes, st.errors], [1, 4, 3, 0]);
      env.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPL1 a LIVE loss leaves Local at the next pass: ctx.materialization.liveLossesByFleet is "
    + "subtracted from the fleet row (never below 0); no facade / a throw = the rows as they are", () => {
    try {
      const fleets = new Map([[NULL_A, [{ ...fleet(FACTION, null, 3), fleetId: "f-a" },
        { ...fleet(FACTION, null, 2), fleetId: "f-b" }]]]);
      const env = boot({ fleets });
      const { log } = env.vendor;
      env.lp.runPassNow();
      assert.strictEqual(log.setRoster[0][1].length, 5);
      let losses = new Map([["f-a", 2], ["f-x", 9]]);
      env.ctx.materialization = { liveLossesByFleet: () => losses };
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(1).map((r) => r[1].length), [3], "5 - 2 lost");
      losses = new Map([["f-a", 2], ["f-b", 7]]);
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(2).map((r) => r[1].length), [1], "f-b never below 0");
      env.ctx.materialization = { liveLossesByFleet: () => { throw new Error("boom"); } };
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(3).map((r) => r[1].length), [5], "a throw = the rows");
      assert.strictEqual(env.lp.getStatus().errors, 0);
      env.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPX6 xmpp reassert: once per xmppReassertMs with the "
    + "stanza budget, counted xmppReasserts; 0 = off; a refusal is not counted", () => {
    try {
      const env = boot({ settings: { xmppReassertMs: 60000, xmppMaxReassertStanzasPerPass: 64 } });
      const calls = [];
      env.vendor.seam.reassertXmpp = (n) => { calls.push(n); return { ok: true, stanzas: 0, sockets: 0 }; };
      env.lp.runPassNow();
      env.lp.runPassNow();
      assert.deepStrictEqual([calls, env.lp.getStatus().xmppReasserts], [[64], 1], "clock 0: once");
      env.lp.stop("test");
      const off = boot({ settings: { xmppReassertMs: 0, xmppMaxReassertStanzasPerPass: 64 } });
      off.vendor.seam.reassertXmpp = (n) => { calls.push(n); return { ok: true }; };
      off.lp.runPassNow();
      assert.strictEqual(calls.length, 1, "0 = off");
      off.lp.stop("test");
      const refused = boot({ settings: { xmppReassertMs: 60000, xmppMaxReassertStanzasPerPass: 64 } });
      refused.vendor.seam.reassertXmpp = () => ({ ok: false, reason: "NOT_INSTALLED" });
      refused.lp.runPassNow();
      assert.strictEqual(refused.lp.getStatus().xmppReasserts, 0);
      refused.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPR1 restart: a new instance on a fresh seam state builds the same roster, nothing for systems outside "
    + "presence; stop clears the rosters + repush; triggers nudge one timer", () => {
    try {
      const w = world();
      const fleets = new Map([[NULL_A, [fleet(FACTION, CORP_B, 2), fleet(FACTION, CORP, 2)]],
        [NULL_B, [fleet(FACTION, CORP, 9)]]]);
      const first = boot({ world: w, fleets });
      first.lp.runPassNow();
      const roster1 = first.vendor.log.setRoster.slice();
      assert.deepStrictEqual(roster1, [[NULL_A, [91000001, 91000002, 91000006, 91000007]]]);

      const second = boot({ world: w, fleets });
      assert.strictEqual(second.timers.filter((t) => !t.cancelled).length, 1, "one pending timer");
      assert.strictEqual(second.timers.filter((t) => !t.cancelled)[0].ms, 1000, "start pass after nudgeDelayMs");
      second.timers.filter((t) => !t.cancelled)[0].fn();
      assert.deepStrictEqual(second.vendor.log.setRoster, roster1, "same roster, no NULL_B entry");
      second.listeners.arrival[0]({}, { systemId: NULL_A });
      second.listeners.observed[0](NULL_B);
      assert.strictEqual(second.timers.filter((t) => !t.cancelled).length, 1, "coalesced");

      second.lp.stop("restart");
      assert.strictEqual(second.vendor.log.clears, 1);
      assert.deepStrictEqual(second.vendor.log.repush.slice(-1), [NULL_A], "repush of the cleared system");
      assert.deepStrictEqual(second.vendor.localOf(NULL_A), []);
      assert.deepStrictEqual([second.listeners.arrival.length, second.listeners.observed.length,
        second.listeners.unobserved.length, second.timers.filter((t) => !t.cancelled).length], [0, 0, 0, 0]);
      assert.deepStrictEqual(second.lp.runPassNow(), { ok: false, reason: "not_running" });
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPCR1 buildCrewRoster: pools in ship order, fleets by id, seats by seat; pool cap 6 -> "
    + "5 + 1 of the second fleet + the foreign pool; system cap; fleet without seats = underCrewed", () => {
    const seatList = (ids) => ids.map((characterId, seat) => ({ seat, characterId })).reverse();
    const fleets = new Map([[NULL_A, [
      { fleetId: "f-b", factionId: FACTION, corporationId: CORP, shipCount: 3 },
      { fleetId: "f-a", factionId: FACTION, corporationId: CORP, shipCount: 5 },
      { fleetId: "f-o", factionId: OTHER_FACTION, corporationId: null, shipCount: 2 },
      { fleetId: "f-n", factionId: OTHER_FACTION, corporationId: null, shipCount: 1 }]]]);
    const seats = new Map([["f-a", seatList([11, 12, 13, 14, 15])], ["f-b", seatList([21, 22, 23])],
      ["f-o", [{ seat: 1, characterId: 32 }, { seat: 0, characterId: 31 }]]]);
    const s = { maxPilotsPerFactionPerSystem: 6, maxPilotsPerSystem: 40, shipsPerPilot: 1, maxCrewPerFleet: 64 };
    const r = buildCrewRoster(fleets, seats, s);
    assert.deepStrictEqual(r.bySystem.get(NULL_A), [11, 12, 13, 14, 15, 21, 31, 32]);
    assert.deepStrictEqual([r.underCrewed, r.truncated, r.shortfall], [["f-n"], 2, 1]);
    const capped = buildCrewRoster(fleets, seats, { ...s, maxPilotsPerSystem: 7 });
    assert.deepStrictEqual([capped.bySystem.get(NULL_A), capped.truncated], [[11, 12, 13, 14, 15, 21, 31], 3]);
    const fewer = buildCrewRoster(new Map([[NULL_A, [{ fleetId: "f-a", factionId: FACTION, corporationId: CORP,
      shipCount: 2 }]]]), seats, s);
    assert.deepStrictEqual([fewer.bySystem.get(NULL_A), fewer.underCrewed], [[11, 12], []]);
  });

  test("LPCR2 crews mode: roster = the seats of the present fleets (read in the Local read tx) "
    + "under-crewed -> requestEnlist; the fleet flies -> the same ids in the new system, the old one empty; a LIVE "
    + "loss leaves Local once; no write", () => {
    try {
      const fleets = new Map([[NULL_A, [{ ...fleet(FACTION, CORP, 3), fleetId: "f-1" },
        { ...fleet(FACTION, null, 2), fleetId: "f-2" }]]]);
      const crews = fakeCrews(new Map([["f-1", [91000003, 91000001, 91000005]]]));
      const env = boot({ fleets, crews, crewsConfig: CREWS_CONFIG, presenceState: { observed: [NULL_A, NULL_B] } });
      const { log } = env.vendor;
      assert.deepStrictEqual(env.lp.runPassNow(), { ok: true });
      assert.deepStrictEqual(log.setRoster, [[NULL_A, [91000003, 91000001, 91000005]]]);
      assert.deepStrictEqual(crews.log.reads, [[{ tx: "localPilots.fleets" }, ["f-1", "f-2"]]], "same tx as the fleets");
      assert.deepStrictEqual(crews.log.requests, [["f-2"]]);
      assert.deepStrictEqual([env.lp.getStatus().shortfall, env.lp.getStatus().passes], [2, 1]);

      fleets.set(NULL_A, [{ ...fleet(FACTION, null, 2), fleetId: "f-2" }]);
      fleets.set(NULL_B, [{ ...fleet(FACTION, CORP, 3), fleetId: "f-1" }]);
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(1), [[NULL_A, []], [NULL_B, [91000003, 91000001, 91000005]]]);

      env.ctx.materialization = { liveLossesByFleet: () => new Map([["f-1", 1]]) };
      env.lp.runPassNow();
      assert.deepStrictEqual(log.setRoster.slice(3), [[NULL_B, [91000003, 91000001]]]);
      crews.seats.set("f-1", [91000003, 91000001]);
      fleets.set(NULL_B, [{ ...fleet(FACTION, CORP, 2), fleetId: "f-1" }]);
      env.ctx.materialization = { liveLossesByFleet: () => new Map() };
      env.lp.runPassNow();
      assert.strictEqual(log.setRoster.length, 4, "the same 2 pilots, no new roster");
      assert.strictEqual(env.lp.getStatus().errors, 0);
      env.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPCR3: crews stub (crews.enabled on) or crews.enabled off -> the assign.js path "
    + "listSeatsInTx never called", () => {
    try {
      const fleets = new Map([[NULL_A, [{ ...fleet(FACTION, null, 3), fleetId: "f-1" },
        { ...fleet(FACTION, null, 2), fleetId: "f-2" }]]]);
      let calls = 0;
      const stub = { ...createUnavailableCrews("disabled_by_config"), listSeatsInTx: () => { calls += 1;
        return { ok: true, byFleet: new Map() }; } };
      const a = boot({ fleets, crews: stub, crewsConfig: CREWS_CONFIG });
      a.lp.runPassNow();
      assert.deepStrictEqual(a.vendor.log.setRoster, [[NULL_A, [91000001, 91000002, 91000003, 91000004, 91000005]]]);
      a.lp.stop("test");
      seamModule._resetForTest();
      const running = fakeCrews(new Map([["f-1", [91000007]]]));
      const b = boot({ fleets, crews: running, crewsConfig: { ...CREWS_CONFIG, enabled: false } });
      b.lp.runPassNow();
      assert.deepStrictEqual(b.vendor.log.setRoster, [[NULL_A, [91000001, 91000002, 91000003, 91000004, 91000005]]]);
      assert.deepStrictEqual([calls, running.log.reads.length, running.log.requests.length], [0, 0, 0]);
      b.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPG1: a governor refusal re-arms the poller after deferRetryMs (not refreshMs); the "
    + "next pass after the refusal is lifted sets the roster", () => {
    try {
      const fleets = new Map([[NULL_A, [fleet(FACTION, null, 2)]]]);
      const env = boot({ fleets, settings: { deferRetryMs: 2500 } });
      const pending = () => env.timers.filter((t) => !t.cancelled);
      assert.deepStrictEqual(pending().map((t) => t.ms), [1000], "start nudge");
      env.governor.admit = false;
      pending()[0].fn();
      assert.deepStrictEqual(pending().map((t) => t.ms), [2500], "one timer, deferRetryMs");
      assert.deepStrictEqual([env.lp.getStatus().deferrals, env.vendor.log.setRoster.length], [1, 0]);
      env.governor.admit = true;
      pending()[0].fn();
      assert.deepStrictEqual(env.vendor.log.setRoster, [[NULL_A, [91000001, 91000002]]]);
      assert.deepStrictEqual(pending().map((t) => t.ms), [15000], "back to refreshMs");
      env.lp.stop("test");
    } finally {
      seamModule._resetForTest();
    }
  });

  test("LPC1 config: SCHEMA defaults, enabled=false -> disabled_by_config with zero timers and listeners, "
    + "warning per pool cap above system cap; registry wiring", () => {
    const r = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.config.localPilots, { enabled: false, refreshMs: 15000, nudgeDelayMs: 1000,
      deferRetryMs: 3000,
      maxSystemsPerPass: 8, maxFleetsPerSystem: 64, shipsPerPilot: 1, maxPilotsPerFactionPerSystem: 100,
      maxPilotsPerSystem: 200, maxRepushPerPass: 8, maxPoolCharacters: 2048,
      xmppEnabled: true, xmppMaxBatchBytes: 32768, xmppReassertMs: 60000, xmppMaxReassertStanzasPerPass: 512 });
    const hi = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_LOCAL_PILOTS_MAX_PILOTS_PER_SYSTEM: "9999",
      EVEJS_LNE_LOCAL_PILOTS_MAX_PILOTS_PER_FACTION_PER_SYSTEM: "9999", EVEJS_LNE_VIRTUAL_CORPS_MEMBERS_PER_CORP: "50",
      EVEJS_LNE_VIRTUAL_CORPS_MAX_CHARACTERS: "100" } });
    assert.deepStrictEqual([hi.config.localPilots.maxPilotsPerSystem, hi.config.localPilots.maxPilotsPerFactionPerSystem,
      hi.config.virtualCorps.membersPerCorp, hi.config.virtualCorps.maxCharacters], [500, 500, 50, 100]);
    assert.deepStrictEqual([r.config.virtualCorps.membersPerCorp, r.config.virtualCorps.maxCharacters,
      r.config.virtualCorps.corpsPerFaction], [3, 64, 2]);
    assert.ok(!r.warnings.some((x) => x.startsWith("localPilots.")), r.warnings.join("\n"));

    let timers = 0;
    let subscribed = 0;
    const ctx = { adapter: { localPilotsSeams: () => { subscribed += 1; return { ok: false }; } },
      presence: { onSystemObserved: () => { subscribed += 1; } } };
    assert.deepStrictEqual(startLocalPilots({ config: r.config, ctx, setTimer: () => { timers += 1; } }),
      { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual([timers, subscribed], [0, 0]);
    const noSeam = startLocalPilots({ config: { localPilots: baseSettings() }, ctx: { adapter: {
      localPilotsSeams: () => ({ ok: false, reason: "SEAM_UNAVAILABLE" }) } }, setTimer: () => { timers += 1; } });
    assert.deepStrictEqual([noSeam.ok, noSeam.reason, timers], [false, "adapter_unavailable", 0]);

    const w = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_LOCAL_PILOTS_MAX_PILOTS_PER_FACTION_PER_SYSTEM: "250" } });
    assert.ok(w.warnings.some((x) => x.startsWith("localPilots.maxPilotsPerFactionPerSystem=250 above")),
      w.warnings.join("\n"));

    const seen = [];
    const def = buildDefaultServiceDefs({ startLocalPilots: (deps) => { seen.push(deps);
      return { ok: true, localPilots: { stop() {} } }; } }).find((d) => d.name === "localPilots");
    assert.deepStrictEqual([def.module, def.requires], ["world", ["persistence"]]);
    const sctx = { config: r.config, clock: { now: () => 0 } };
    assert.deepStrictEqual(def.start(sctx, { logger: { log() {} } }), { ok: true });
    assert.ok(sctx.localPilots && seen[0].ctx === sctx);
  });
};

module.exports.harness = { fakeVendor, boot, world, fleet, fakeCrews, CREWS_CONFIG, FACTION, CORP };
