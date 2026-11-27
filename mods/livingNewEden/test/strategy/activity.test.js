"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { NOTE_CATEGORIES, NOTE_DICTIONARY } = require("../../lib/strategy/activity/notes");
const { VERDICT, judgeFaction } = require("../../lib/strategy/activity/verdict");
const { buildActivityView } = require("../../lib/strategy/activity/activityView");

const I = 900000;
const NOW = 1000 * I;
const F = 500001;
const JITA = 30000142;
const STRATEGY_DIR = path.join(__dirname, "..", "..", "lib", "strategy");

function input(over) {
  return { now: NOW, intervalMs: I, staleFactor: 3, startedAt: NOW - I,
    strategy: { state: "running", reason: null, aiState: "on", aiReason: null, seedState: "done" },
    failedServices: [], row: { status: "ACTIVE", lastReviewAt: NOW - 60000 },
    memory: { round: 1000, outcome: "DONE", notes: [], applied: { FACTION_TOUCH: 1 }, refused: 0 },
    reviewEvent: { found: true, state: "QUEUED", attempts: 0, lastError: null, dueAt: NOW + I },
    activityCount: 0, lastRefusal: null, ...over };
}

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(p));
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const LITERAL = /"([A-Z][A-Z0-9_]+)"/g;
const TEMPLATE_PREFIX = /`([A-Z][A-Z0-9_]+):/g;

const TEMPLATE_EXPR = /\$\{[^}]*\}/g;

function literalsIn(text, into, withTemplates) {
  const bare = text.replace(TEMPLATE_EXPR, "");
  for (const re of withTemplates ? [LITERAL, TEMPLATE_PREFIX] : [LITERAL]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(bare)) !== null) into.add(m[1]);
  }
}

function collectCodes(source, into) {
  const groups = [
    [/\bnotes\.(?:push|add)\(([^;]*)\)/g, true],
    [/\bnotes:\s*\[([^\]]*)\]/g, false],
    [/\bnotes\s*=\s*new Set\(\[([^\]]*)\]\)/g, false],
    [/\bconst\s+\w*Note\s*=\s*([^;]+);/g, false],
  ];
  for (const [re, templates] of groups) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) literalsIn(m[1], into, templates);
  }
  for (const re of [/\b(?:none|done)\(\s*"([A-Z][A-Z0-9_]+)"/g, /\bnote:\s*"([A-Z][A-Z0-9_]+)"/g,
    /\bskip:\s*"([A-Z][A-Z0-9_]+)"/g]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) into.add(m[1]);
  }
}

function thrower(name) {
  return () => {
    throw new Error(`write ${name} called by a read-only panel`);
  };
}

function fakeView(opts) {
  const o = opts || {};
  const state = { admit: true, now: NOW };
  const db = { inTransaction: true };
  const memory = { round: 1000, outcome: "DONE", target: { systemId: JITA }, notes: ["UPKEEP_RESERVE"],
    applied: { FACTION_TOUCH: 1 }, refused: 0 };
  const view = buildActivityView({
    store: { isOpen: () => true, transaction: (name, fn) => ({ ok: true, value: fn(db), rows: 0 }),
      checkpoint: thrower("store.checkpoint") },
    repository: { listFactions: () => ({ ok: true, records: [{ factionId: F, status: "ACTIVE",
      lastReviewAt: NOW - 60000 }] }), getChangeCount: () => 3, applyFactionChange: thrower("applyFactionChange") },
    registry: { listActiveFactions: () => [{ factionId: F }], getCampaignsForFaction: () => [] },
    getStatus: () => ({ state: "running", reason: null, seq: 1, seed: { state: "done" },
      ai: { state: "on", reason: null }, campaigns: [] }),
    graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === JITA ? { name: "Jita" } : null) } }) },
    clock: { now: () => state.now },
    config: { observer: { factionActivityMaxItems: 5, factionActivityStaleFactor: 3, factionActivityRefreshMs: 15000 },
      strategy: { reviewIntervalMs: I, maxFleetsReadPerReview: 64 }, siege: { maxOpenSieges: 10 } },
    getGovernor: () => ({ admits: () => state.admit }),
    factionNames: new Map([[F, "Fake Faction"]]),
    getAiService: () => ({ getMemory: () => memory, getSeq: () => 7, getStatus: () => ({ lastRefusal: null }),
      schedule: { bucketOf: (f, t) => Math.floor(t / I), dueOf: (f, b) => b * I,
        reviewKey: (f, b) => `strategy:review:${f}:${b}`, nextOf: (f, at) => ({ dueAt: (Math.floor(at / I) + 1) * I }) },
      handler: thrower("ai.handler") }),
    scheduler: { getStatus: () => ({ state: "ready" }), enqueue: thrower("scheduler.enqueue"),
      findByKey: (key) => ({ ok: true, found: key === `strategy:review:${F}:1000`,
        event: { state: "QUEUED", attempts: 0, lastError: null, dueAt: NOW + I } }) },
    fleets: { repository: { listOperations: () => ({ ok: true, operations: [] }),
      listFleetsByFaction: () => ({ ok: true, fleets: [] }), createFleet: thrower("createFleet") } },
    getMining: () => ({ getMode: () => "off", dispatchInTx: thrower("mining.dispatchInTx") }),
    getServices: () => ({ getStatus: () => ({ services: [
      { name: "mining", state: "disabled", reason: "disabled_by_config", detail: null },
      { name: "fleets", state: "running", reason: null, detail: null }] }) }),
    ...o,
  });
  return { view, state };
}

const DAY = 86400000;
const STALL_MS = 3 * DAY;
const PATROLS7 = [1, 2, 3, 4, 5, 6, 7].map((n) => ({ operationId: `op-0${n}`, operationType: "patrol", state: "ACTIVE",
  targetSystemId: JITA, dueAt: NOW + n * I }));

function fakeWorld(captures, opts) {
  const o = opts || {};
  const rows = captures.map((at, i) => ({ systemId: 30000001 + i, capturedAt: at }));
  return { repository: {
    listByOccupier: (db, f, q) => (o.claimFail ? { ok: false, reason: "WORLD_INVALID_INPUT" }
      : { ok: true, systems: o.claim && q.limit >= 1 ? [{ systemId: JITA }] : [], nextAfterSystemId: null }),
    listControlledByFaction: (db, f, q) => {
      assert.strictEqual(q.capturedOnly, true);
      const page = rows.filter((r) => r.systemId > (q.afterSystemId || 0)).slice(0, q.limit);
      return { ok: true, systems: page, nextAfterSystemId: page.length === q.limit ? page[page.length - 1].systemId
        : null };
    },
    applyChange: thrower("world.applyChange") } };
}

function stallView(over) {
  const o = over || {};
  const ops = o.ops || [{ operationId: "op-1", operationType: "patrol", state: "ACTIVE", targetSystemId: JITA,
    dueAt: NOW + I }];
  const fleets = [1, 2, 3].map((n) => ({ fleetId: `fl-${n}`, fleetRole: "invasion", state: "IDLE", shipCount: 10,
    updatedAt: NOW - n * DAY })).concat([{ fleetId: "fl-p", fleetRole: "patrol", state: "MOVING", shipCount: 5,
    updatedAt: NOW }]);
  return fakeView({
    repository: { listFactions: () => ({ ok: true, records: [{ factionId: F, status: "ACTIVE", lastReviewAt: NOW - 60000,
      createdAt: 0 }] }), getChangeCount: () => 3, applyFactionChange: thrower("applyFactionChange") },
    registry: { listActiveFactions: () => [{ factionId: F, kind: "empire", doctrineId: "d" }],
      getCampaignsForFaction: () => [], getDoctrine: () => null },
    config: { observer: { factionActivityMaxItems: 5, factionActivityStaleFactor: 3, factionActivityRefreshMs: 15000,
      factionActivityOffensiveStallMs: STALL_MS, factionActivityMaxCapturedRows: o.maxCaptured || 64,
      factionActivityMaxOffensiveScanRows: o.maxScan || 64 },
    strategy: { reviewIntervalMs: I, maxFleetsReadPerReview: 64 }, siege: { maxOpenSieges: 10 } },
    fleets: { repository: { listOperations: (db, q) => {
      const page = ops.filter((op) => op.state === q.state && op.operationId > (q.afterOperationId || ""))
        .sort((a, b) => (a.operationId < b.operationId ? -1 : 1)).slice(0, q.limit);
      return { ok: true, operations: page,
        nextAfterOperationId: page.length === q.limit ? page[page.length - 1].operationId : null };
    },
    listFleetsByFaction: () => ({ ok: true, fleets }), createFleet: thrower("createFleet") } },
    world: o.world || fakeWorld([NOW - 4 * DAY, NOW - 9 * DAY]),
  }).view.getData().factions[0];
}

module.exports = ({ test }) => {
  test("AV-O1 activity: empire with only patrols, last capture 4 days ago, UPKEEP_RESERVE, 3 idle invasion fleets "
    + "-> NO_OFFENSIVE with the brake note and the idle fleets", () => {
    const f = stallView();
    assert.strictEqual(f.verdict.code, VERDICT.NO_OFFENSIVE, f.verdict.sentence);
    assert.strictEqual(f.verdict.label, "NO OFFENSIVE");
    assert.ok(f.verdict.sentence.includes(`brake: ${NOTE_DICTIONARY.UPKEEP_RESERVE.text}`), f.verdict.sentence);
    assert.ok(f.verdict.sentence.includes("idle invasion fleets: 3 (30 ships)"), f.verdict.sentence);
    assert.ok(f.verdict.sentence.startsWith("No offensive for 96 h"), f.verdict.sentence);
    assert.ok(f.verdict.sentence.includes("Still: operations: 1"), f.verdict.sentence);
    assert.deepStrictEqual(f.offensive, { stalled: true, since: NOW - 4 * DAY, lastCaptureAt: NOW - 4 * DAY,
      idleInvasion: { fleets: 3, ships: 30, oldestSince: NOW - 3 * DAY, truncated: false } });
    const seven = stallView({ ops: PATROLS7 });
    assert.strictEqual(seven.now.sections.operations.truncated, true);
    assert.strictEqual(seven.verdict.code, VERDICT.NO_OFFENSIVE, seven.verdict.sentence);
  });

  test("AV-O2 activity: the same faction with an open invasion or an own claim stays WORKING", () => {
    const inv = stallView({ ops: [{ operationId: "op-1", operationType: "patrol", state: "ACTIVE",
      targetSystemId: JITA, dueAt: NOW + I }, { operationId: "op-2", operationType: "invasion", state: "PLANNED",
      targetSystemId: JITA, dueAt: NOW + I }] });
    assert.strictEqual(inv.verdict.code, VERDICT.WORKING, inv.verdict.sentence);
    assert.strictEqual(inv.offensive.idleInvasion.fleets, 3, "the idle fleets line stays with WORKING");
    const claim = stallView({ world: fakeWorld([NOW - 4 * DAY], { claim: true }) });
    assert.strictEqual(claim.verdict.code, VERDICT.WORKING, claim.verdict.sentence);
    const late = stallView({ maxScan: 64, ops: [...PATROLS7, { operationId: "op-08", operationType: "invasion",
      state: "ACTIVE", targetSystemId: JITA, dueAt: NOW + 9 * I }] });
    assert.strictEqual(late.verdict.code, VERDICT.WORKING, late.verdict.sentence);
    const capped = stallView({ maxScan: 6, ops: PATROLS7 });
    assert.notStrictEqual(capped.verdict.code, VERDICT.NO_OFFENSIVE, capped.verdict.sentence);
  });

  test("AV-O3 activity: judgeFaction without offensive = as before; a hard block beats a stall", () => {
    const base = input({ activityCount: 1, nowText: "operations: 1" });
    const before = judgeFaction(base);
    assert.strictEqual(before.code, VERDICT.WORKING);
    assert.deepStrictEqual(judgeFaction({ ...base, offensive: { stalled: false, since: 0, lastCaptureAt: null,
      idleInvasion: null } }), before);
    const blocked = judgeFaction({ ...base, memory: { round: 1000, outcome: "DONE", notes: ["NO_HULLS"],
      applied: { FACTION_TOUCH: 1 }, refused: 0 }, offensive: { stalled: true, since: NOW - 4 * DAY,
      lastCaptureAt: null, idleInvasion: null } });
    assert.strictEqual(blocked.code, VERDICT.BLOCKED, blocked.sentence);
  });

  test("AV-O4 activity: captured rows over the cap or a failed world read -> no NO_OFFENSIVE (fail-safe)", () => {
    const many = Array.from({ length: 70 }, () => NOW - 9 * DAY);
    const cut = stallView({ world: fakeWorld(many), maxCaptured: 64 });
    assert.notStrictEqual(cut.verdict.code, VERDICT.NO_OFFENSIVE, cut.verdict.sentence);
    assert.strictEqual(cut.offensive.stalled, false);
    const failed = stallView({ world: fakeWorld([NOW - 4 * DAY], { claimFail: true }) });
    assert.notStrictEqual(failed.verdict.code, VERDICT.NO_OFFENSIVE, failed.verdict.sentence);
    const noWorld = stallView({ world: { repository: null } });
    assert.notStrictEqual(noWorld.verdict.code, VERDICT.NO_OFFENSIVE, noWorld.verdict.sentence);
  });

  test("AV-TR1 activity: 2 truces at maxItems 1 -> truces {ok, 1 item with "
    + "partnerName, truncated}; truce null -> no field; a refusal -> {status:error}, available and the verdict unchanged",
  () => {
    const P1 = 500002;
    const P2 = 500003;
    const cfg = { observer: { factionActivityMaxItems: 1, factionActivityStaleFactor: 3,
      factionActivityRefreshMs: 15000 }, strategy: { reviewIntervalMs: I, maxFleetsReadPerReview: 64 },
    siege: { maxOpenSieges: 10 } };
    const names = new Map([[F, "Fake Faction"], [P1, "Partner One"], [P2, "Partner Two"]]);
    const calls = [];
    const truce = { listTrucesInDb: (db, f, at) => {
      calls.push([db.inTransaction, f, at]);
      return { ok: true, truces: [{ partner: P1, until: NOW + I, initiator: F }, { partner: P2, until: NOW + 2 * I,
        initiator: P2 }] };
    } };
    const on = fakeView({ config: cfg, factionNames: names, truce }).view.getData();
    assert.strictEqual(on.available, true);
    assert.deepStrictEqual(calls, [[true, F, NOW]], "one read inside the observer.activity tx");
    const { eta: _eta, ...item } = on.factions[0].truces.items[0];
    assert.deepStrictEqual([on.factions[0].truces.status, on.factions[0].truces.truncated, on.factions[0].truces.items.length,
      item], ["ok", true, 1, { partnerId: P1, partnerName: "Partner One", until: NOW + I, initiator: F }]);
    const off = fakeView({ config: cfg, factionNames: names, truce: null }).view.getData();
    assert.ok(!("truces" in off.factions[0]));
    const refused = fakeView({ config: cfg, factionNames: names,
      truce: { listTrucesInDb: () => ({ ok: false, reason: "INVALID_INPUT", detail: "at" }) } }).view.getData();
    assert.strictEqual(refused.available, true);
    assert.strictEqual(refused.factions[0].truces.status, "error");
    assert.deepStrictEqual(refused.factions[0].verdict, off.factions[0].verdict);
    const thrown = fakeView({ config: cfg, factionNames: names,
      truce: { listTrucesInDb: () => { throw new Error("boom"); } } }).view.getData();
    assert.deepStrictEqual([thrown.available, thrown.factions[0].truces], [true, { status: "error", reason: "boom" }]);
  });

  test("T1 activity: WORKING with activity and info notes; WAITING on UPKEEP_RESERVE with the dictionary text", () => {
    const working = judgeFaction(input({ activityCount: 2, nowText: "operations: 2",
      memory: { round: 1000, outcome: "DONE", notes: ["UPKEEP_ANCHOR", "REPLENISH"], applied: { FACTION_TOUCH: 1 },
        refused: 0 } }));
    assert.strictEqual(working.code, VERDICT.WORKING);
    assert.ok(working.sentence.startsWith("Working"), working.sentence);
    const waiting = judgeFaction(input({ memory: { round: 1000, outcome: "DONE", notes: ["UPKEEP_RESERVE"],
      applied: { FACTION_TOUCH: 1 }, refused: 0 } }));
    assert.strictEqual(waiting.code, VERDICT.WAITING);
    assert.ok(waiting.sentence.includes(NOTE_DICTIONARY.UPKEEP_RESERVE.text), waiting.sentence);
  });

  test("T2 activity: BLOCKED beats activity; first block named with its args and +N others", () => {
    const v = judgeFaction(input({ activityCount: 1, nowText: "mining trips: 1",
      memory: { round: 1000, outcome: "DONE", notes: ["PRODUCTION_NO_SITE:frigate", "PRODUCTION_NO_SITE:cruiser",
        "NO_HULLS"], applied: { FACTION_TOUCH: 1 }, refused: 0 } }));
    assert.strictEqual(v.code, VERDICT.BLOCKED);
    assert.ok(v.sentence.includes(NOTE_DICTIONARY.PRODUCTION_NO_SITE.text), v.sentence);
    assert.ok(v.sentence.includes("frigate, cruiser"), v.sentence);
    assert.ok(v.sentence.includes("+1"), v.sentence);
    assert.ok(v.sentence.includes("Still: mining trips: 1"), v.sentence);
  });

  test("T2b activity: PRODUCTION_LINES_BUSY with activity -> WORKING (not BLOCKED)", () => {
    const v = judgeFaction(input({ activityCount: 2, nowText: "production: 2, patrol: 1",
      memory: { round: 1000, outcome: "DONE", notes: ["PRODUCTION_LINES_BUSY:frigate", "UPKEEP_RESERVE"],
        applied: { FACTION_TOUCH: 1 }, refused: 0 } }));
    assert.strictEqual(v.code, VERDICT.WORKING, "PRODUCTION_LINES_BUSY is a waiting note, should not block with activity: " + v.sentence);
    assert.ok(v.sentence.startsWith("Working"), v.sentence);
  });

  test("T3 activity: STALE after interval x factor; ERROR beats STALE; quarantined review; broken chain", () => {
    const stale = input({ row: { status: "ACTIVE", lastReviewAt: NOW - 4 * I } });
    assert.strictEqual(judgeFaction(stale).code, VERDICT.STALE);
    assert.strictEqual(judgeFaction({ ...stale, failedServices: [{ name: "mining", reason: "boom" }] }).code,
      VERDICT.ERROR);
    assert.strictEqual(judgeFaction(input({ reviewEvent: { found: true, state: "QUARANTINED", attempts: 5,
      lastError: "x" } })).code, VERDICT.ERROR);
    const broken = judgeFaction(input({ reviewEvent: { found: false } }));
    assert.strictEqual(broken.code, VERDICT.ERROR);
    assert.ok(broken.sentence.includes("review chain"), broken.sentence);
  });

  test("T4 activity view on fakes: module off is not an error, target name, governor gate, cache bucket, read only", () => {
    const { view, state } = fakeView();
    assert.strictEqual(view.order, 26);
    const data = view.getData();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    const f = data.factions[0];
    assert.strictEqual(f.now.sections.mining.status, "off");
    assert.ok(f.now.sections.mining.reason.includes("module disabled"), f.now.sections.mining.reason);
    assert.notStrictEqual(f.verdict.code, VERDICT.ERROR, f.verdict.sentence);
    assert.strictEqual(f.plans.target.name, "Jita");
    assert.strictEqual(data.summary[0].frakcja, "Fake Faction");
    const k1 = view.cacheKey();
    state.now += 1000;
    assert.strictEqual(view.cacheKey(), k1);
    state.admit = false;
    assert.strictEqual(view.cacheKey(), null);
    assert.deepStrictEqual(view.getData(), { available: false, reason: "GOVERNOR_HOLD" });
  });

  test("T5 activity: every note code of lib/strategy/ai/** and reviewService.js is in the dictionary", () => {
    const codes = new Set();
    const files = [...listJs(path.join(STRATEGY_DIR, "ai")), path.join(STRATEGY_DIR, "reviewService.js")];
    for (const file of files) collectCodes(fs.readFileSync(file, "utf8"), codes);
    const missing = [...codes].filter((c) => !Object.prototype.hasOwnProperty.call(NOTE_DICTIONARY, c)).sort();
    assert.deepStrictEqual(missing, [], `note codes without a dictionary entry: ${missing.join(", ")}`);
    assert.ok(codes.size >= 60, `scan found only ${codes.size} codes`);
    for (const c of ["PRODUCTION_NO_SITE", "NO_TARGET", "UPKEEP_RESERVE", "LOGISTICS_RETIRE", "NO_STAGING",
      "ELIMINATED"]) {
      assert.ok(codes.has(c), `scan must find ${c}`);
    }
    for (const [code, e] of Object.entries(NOTE_DICTIONARY)) {
      assert.ok(NOTE_CATEGORIES.includes(e.category), `${code} category ${e.category}`);
      assert.ok(typeof e.text === "string" && e.text.length > 0, `${code} text`);
    }
  });

  test("TB5 tribute panel: the 8 TRIBUTE_* codes are found in lib/strategy/ai/** and are in the "
    + "dictionary; section logistics: an open TRIBUTE convoy labelled \"tribute in transit\" with the receiver system, "
    + "lastTribute DELIVERED -> \"tribute delivered\", delivered to an own station -> \"tribute returned\"", () => {
    const codes = new Set();
    for (const file of listJs(path.join(STRATEGY_DIR, "ai"))) collectCodes(fs.readFileSync(file, "utf8"), codes);
    const TRIBUTE_CODES = ["TRIBUTE_DISPATCHED", "TRIBUTE_IN_TRANSIT", "TRIBUTE_NO_SURPLUS", "TRIBUTE_RECIPIENT_FULL",
      "TRIBUTE_NO_RECIPIENT", "TRIBUTE_NO_FLEET", "TRIBUTE_SMALL_LOAD", "TRIBUTE_DISPATCH_LIMIT"];
    assert.deepStrictEqual([...codes].filter((c) => c.startsWith("TRIBUTE_")).sort(), [...TRIBUTE_CODES].sort());
    for (const c of TRIBUTE_CODES) assert.ok(NOTE_DICTIONARY[c], c);

    const last = { convoyId: "cv-1", state: "DELIVERED", endedAt: NOW - 5, deliveredStationId: "st-rcv",
      delivered: { "mineral/type:34": 3000 }, cargo: { "mineral/type:34": 3000 }, plan: { "mineral/type:34": 3000 } };
    const logisticsOf = (lastConvoy) => () => ({ getMode: () => "ready", dispatchInTx: thrower("dispatchInTx"),
      readOpen: () => ({ ok: true, truncated: false, convoys: [
        { convoyId: "cv-2", fleetId: "lf", state: "IN_TRANSIT", purpose: "TRIBUTE", sourceStationId: "st-pay",
          destStationId: "st-rcv", destSystemId: JITA, items: { "mineral/type:34": 1000, "mineral/type:35": 200 } },
        { convoyId: "cv-3", fleetId: "lg", state: "TO_SOURCE", purpose: "CONSTRUCTION", sourceStationId: "st-pay",
          destStationId: "site-1", destSystemId: JITA, items: { "mineral/type:34": 5 } }] }),
      findLastEndedOfFaction: (db, f, purpose) => (f === F && purpose === "TRIBUTE"
        ? { ok: true, convoy: lastConvoy } : { ok: false, reason: "WRONG_CALL" }) });
    const sectionOf = (o) => fakeView(o).view.getData().factions[0].now.sections.logistics;
    const s = sectionOf({ getLogistics: logisticsOf(last) });
    assert.deepStrictEqual([s.status, s.count, s.items[0]], ["ok", 2, { purpose: "TRIBUTE", state: "IN_TRANSIT",
      label: "tribute in transit", from: "st-pay", to: { systemId: JITA, name: "Jita" }, units: 1200 }]);
    assert.deepStrictEqual(s.items[1], { purpose: "CONSTRUCTION", state: "TO_SOURCE", from: "st-pay", to: "site-1",
      units: 5 }, "other purposes unchanged");
    assert.deepStrictEqual(s.lastTribute, { state: "DELIVERED", endedAt: NOW - 5, units: 3000,
      label: "tribute delivered" });
    const home = sectionOf({ getLogistics: logisticsOf({ ...last, deliveredStationId: "st-pay" }),
      getStations: () => ({ getMode: () => "ready", repository: { listStationsOfFaction: () => ({ ok: true,
        records: [{ stationId: "st-pay", systemId: JITA, kind: "upwell" }] }) } }) });
    assert.strictEqual(home.lastTribute.label, "tribute returned");
    assert.deepStrictEqual(sectionOf({ getLogistics: logisticsOf({ ...last, state: "LOST", delivered: null }) })
      .lastTribute.label, "tribute lost");
    assert.strictEqual(sectionOf({ getLogistics: logisticsOf(null) }).lastTribute, null);
  });
};
