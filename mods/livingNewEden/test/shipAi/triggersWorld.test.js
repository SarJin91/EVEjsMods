"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { TRIGGER_TEXT } = require("../../lib/shipAi/data/triggers");
const { worldEntriesOf, planHere, whereOf, worldTemplateOf, parseWorldKinds, noteActivity, emptyTriggerState,
  WORLD_NOTICE_KINDS, TRIGGER_KINDS_D } = require("../../lib/shipAi/triggers");
const { createProactive, PRIORITY } = require("../../lib/shipAi/proactive");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const { createShipAiMail, noticesSenderOf } = require("../../lib/shipAi/mail");
const { createToolDeps } = require("../../lib/shipAi/tools/deps");
const eventRepository = require("../../lib/events/eventRepository");
const { KINDS: ALL_KINDS } = require("../../lib/notices/sources");
const { createUnavailableNotices, startNotices } = require("../../lib/notices");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { systemsWithin } = require("../../lib/notices/recipients");
const { createJournal } = require("../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createManualClock } = require("../../lib/util/clock");
const F = require("../notices/sourceFixture");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const OTHER = 9002;
const AI = 91000001;
const NOTICES_SENDER = 140000004;
const T0 = 1700000000000;
const A = 30000001;
const B = 30000002;
const C = 30000003;
const D = 30000004;
const EDGES = new Map([[A, [B]], [B, [A, C]], [C, [B, D]], [D, [C]]]);
const graph = Object.freeze({ getNeighbors: (id) => EDGES.get(id) || null, hasSystem: () => false,
  getSystem: () => null, getRegionName: () => null });
const NOTIMER = () => ({ cancel() {}, hasRef: () => false });

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}
const view = (over) => Object.freeze({ eventKey: "j:7:SYSTEM_CAPTURED", kind: "SYSTEM_CAPTURED", systemId: A, at: T0,
  attackerName: "Guristas", defenderName: "Amarr Empire", systemName: "Venal", regionName: "R", recipients: [],
  outcome: null, ...(over || {}) });
const filled = (lines, values) => lines.map((l) => l.replace(/\{(\w+)\}/g, (_m, k) => values[k]));

function proactiveRig(over, extra) {
  const x = extra || {};
  let now = T0;
  const delivered = [];
  const keys = new Set();
  const requests = [];
  const logs = [];
  const toolDeps = { telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000,
    structurePermille: 1000, capacitorPermille: 900, warping: false }), typeName: () => null,
  itemByName: () => ({ ok: true, found: false }), graph: () => graph, crimeFlags: () => ({ ok: true, found: false }),
  securityStatus: () => ({ ok: true, securityStatus: 1 }), ...(x.toolDeps || {}) };
  const eventsRepo = { noteEventInTx: (_db, spec) => {
    const fresh = !keys.has(spec.key);
    keys.add(spec.key);
    return { ok: true, inserted: fresh };
  }, markMentionedInTx: () => ({ ok: true, changed: 1 }), listPendingPods: () => ({ ok: true, playerIds: [] }) };
  const p = createProactive({ S: settings({ language: "pl", calloutEnabled: false, ...(over || {}) }),
    maxIdentities: 4, store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
    prefsRepo: { setLastProactive: () => ({ ok: true }) }, eventsRepo,
    adapter: { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "P", systemId: B,
      state: "space" }] }) }, seam: null, toolDeps,
    client: { request: (spec) => {
      requests.push(spec);
      return Promise.resolve({ ok: false, reason: "TIMEOUT" });
    } },
    deliver: (_id, lines) => {
      delivered.push(...lines);
      return { room: lines.length, system: 0, failed: 0 };
    }, nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
    staticIndex: () => new Map([[B, { name: "Bej", security: "nullsec", region: "R", regionId: 1 }]]),
    snapshot: () => ({ json: "{}", presence: null }), initialPrefs: new Map([[PLAYER, { quiet: false,
      lastProactiveAt: null }]]), nowMs: () => now, setTimer: NOTIMER, logger: { log: (l) => logs.push(l) },
    getNotices: x.getNotices });
  const pass = (ms) => {
    now += ms === undefined ? 5000 : ms;
    p.runPass();
  };
  return { p, pass, delivered, requests, keys, logs, now: () => now };
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

module.exports = ({ test, skip }) => {
  test("TWD2 worldEntriesOf: radius, not observed, PLAYER_IMPACT by recipients, system cooldown, kindOff, whereOf",
    () => {
    const M = Object.assign(Object.create(settings({ language: "pl" })), { worldKinds: null, muted: new Set() });
    const within = (id) => systemsWithin(graph, id, M.worldNewsRadiusJumps);
    const far = worldEntriesOf([view()], new Map([[PLAYER, D]]), within, new Map(), T0, M);
    assert.deepStrictEqual([far.byPlayer.size, far.outOfRange], [0, 1], "3 jumps at radius 2");
    const notObserved = worldEntriesOf([view()], new Map([[OTHER, A]]), within, new Map(), T0, M);
    assert.deepStrictEqual([...notObserved.byPlayer.keys()], [OTHER], "only the given players");
    assert.strictEqual(worldEntriesOf([view()], new Map(), within, new Map(), T0, M).byPlayer.size, 0);
    const impact = worldEntriesOf([view({ eventKey: "j:8:PLAYER_IMPACT", kind: "PLAYER_IMPACT", recipients: [PLAYER,
      OTHER] })], new Map([[PLAYER, D]]), within, new Map(), T0, M);
    assert.deepStrictEqual([impact.byPlayer.get(PLAYER).length, impact.notObserved], [1, 1], "recipients, no radius");
    assert.strictEqual(impact.byPlayer.get(PLAYER)[0].values.where, "w pobliżu");

    const near = worldEntriesOf([view()], new Map([[PLAYER, C]]), within, new Map(), T0, M);
    const e = near.byPlayer.get(PLAYER)[0];
    assert.deepStrictEqual([e.kind, e.key, e.priority, e.model, e.template, e.systemId, e.values], ["WORLD_NEWS",
      "world:j:7:SYSTEM_CAPTURED", PRIORITY.WORLD_NEWS, false, "WORLD_NEWS_SYSTEM_CAPTURED", A,
      { notice: "SYSTEM_CAPTURED", where: "2 skoki stąd", system: "Venal", jumps: 2, attacker: "Guristas",
        defender: "Amarr Empire" }]);
    const twice = noteActivity(emptyTriggerState(), [e, e], T0, M);
    assert.deepStrictEqual([twice.queued, twice.state.pending.size], [1, 1]);
    const st = { ...emptyTriggerState(), lastWorldBySystem: new Map([[A, T0 - 1000]]) };
    const cool = worldEntriesOf([view()], new Map([[PLAYER, C]]), within, new Map([[PLAYER, st]]), T0, M);
    assert.deepStrictEqual([cool.byPlayer.size, cool.systemCooldown], [0, 1]);
    const later = worldEntriesOf([view()], new Map([[PLAYER, C]]), within, new Map([[PLAYER, st]]),
      T0 + M.worldNewsSystemCooldownMs, M);
    assert.strictEqual(later.byPlayer.size, 1);
    const off = worldEntriesOf([view()], new Map([[PLAYER, A]]), within, new Map(), T0,
      Object.assign(Object.create(M), { worldKinds: parseWorldKinds("SIEGE_STARTED") }));
    assert.deepStrictEqual([off.byPlayer.size, off.kindOff], [0, 1]);
    const noGraph = worldEntriesOf([view()], new Map([[PLAYER, A], [OTHER, B]]), () => null, new Map(), T0, M);
    assert.deepStrictEqual([[...noGraph.byPlayer.keys()], noGraph.noGraph, noGraph.byPlayer.get(PLAYER)[0].values.where],
      [[PLAYER], 1, "w tym systemie"]);
    assert.deepStrictEqual([whereOf(2, "pl"), whereOf(5, "pl"), whereOf(1, "pl"), whereOf(0, "en"), whereOf(3, "en"),
      whereOf(null, "en")], ["2 skoki stąd", "5 skoków stąd", "jeden skok stąd", "in this system", "3 jumps away",
      "nearby"]);
    assert.deepStrictEqual([worldTemplateOf(view({ attackerName: null })), worldTemplateOf(view({
      kind: "ATTACK_REPELLED", attackerName: null }))], ["WORLD_NEWS_SYSTEM_CAPTURED_PLAIN", "WORLD_NEWS_ATTACK_REPELLED"]);
    assert.deepStrictEqual([parseWorldKinds(""), [...parseWorldKinds("siege_started, PLAYER_IMPACT")],
      parseWorldKinds("FOO")], [null, ["SIEGE_STARTED", "PLAYER_IMPACT"], false]);
    const heavy = worldEntriesOf([view({ eventKey: "j:10:HEAVY_EVENT_STARTED", kind: "HEAVY_EVENT_STARTED",
      recipients: [PLAYER] })], new Map([[PLAYER, D]]), within, new Map(), T0, M);
    assert.deepStrictEqual([heavy.byPlayer.get(PLAYER).length, heavy.outOfRange,
      heavy.byPlayer.get(PLAYER)[0].values.where], [1, 0, "w pobliżu"], "heavy event 3 jumps away at radius 2");
    const released = worldEntriesOf([view({ eventKey: "j:11:SYSTEM_RELEASED", kind: "SYSTEM_RELEASED",
      recipients: [OTHER, PLAYER] })], new Map([[PLAYER, B], [OTHER, D]]), within, new Map(), T0, M);
    assert.deepStrictEqual([[...released.byPlayer.keys()].sort(), released.byPlayer.get(PLAYER).length,
      released.byPlayer.get(PLAYER)[0].values.jumps, released.outOfRange], [[PLAYER, OTHER], 1, 1, 0],
      "a contributor out of the radius + a recipient within it, one entry each");
    const personal = worldEntriesOf([view({ eventKey: "j:12:PLAYER_IMPACT", kind: "PLAYER_IMPACT",
      recipients: [OTHER] })], new Map([[PLAYER, A], [OTHER, D]]), within, new Map(), T0, M);
    assert.deepStrictEqual([...personal.byPlayer.keys()], [OTHER], "a personal kind: no radius");
  });

  test("TWD3 planHere: baseline, new VIRTUAL battle, LIVE skipped for good, the same battle / another system = 0, "
    + "ACTIVE event, battles:null unchanged, worldHereSeenMax", () => {
    const M = settings();
    const battle = (battleId, over) => ({ battleId, state: "RESOLVING", mode: "VIRTUAL", a: "Amarr Empire",
      b: "Minmatar Republic", ...(over || {}) });
    const first = planHere(null, { battles: [battle("b1")], events: [] }, "Bej", T0, M);
    assert.deepStrictEqual([first.entries, [...first.state.seen.keys()]], [[], ["battle:b1"]], "baseline");
    const two = planHere(first.state, { battles: [battle("b1"), battle("b2")], events: [] }, "Bej", T0 + 1, M);
    assert.strictEqual(two.entries.length, 1);
    const e = two.entries[0];
    assert.deepStrictEqual([e.kind, e.key, e.model, e.template, e.values, e.priority], ["BATTLE_HERE", "battle:b2", true,
      "BATTLE_HERE", { system: "Bej", a: "Amarr Empire", b: "Minmatar Republic" }, PRIORITY.BATTLE_HERE]);
    const plain = planHere(two.state, { battles: [battle("b9", { a: null, mode: null, state: "PENDING" })], events: null },
      null, T0 + 2, M);
    assert.deepStrictEqual([plain.entries[0].template, plain.entries[0].values], ["BATTLE_HERE_PLAIN", {}]);
    const live = planHere(two.state, { battles: [battle("b3", { mode: "LIVE_EVEJS", state: "LIVE" })], events: [] },
      "Bej", T0 + 2, M);
    assert.deepStrictEqual([live.entries.length, live.liveSkipped], [0, 1]);
    const again = planHere(live.state, { battles: [battle("b3", { mode: "LIVE_EVEJS" }), battle("b2")], events: [] },
      "Bej", T0 + 3, M);
    assert.deepStrictEqual([again.entries.length, again.liveSkipped], [0, 0], "known keys");
    const elsewhere = planHere(again.state, { battles: [], events: [] }, "Other", T0 + 4, M);
    const back = planHere(elsewhere.state, { battles: [battle("b2")], events: [] }, "Bej", T0 + 5, M);
    assert.strictEqual(back.entries.length, 0, "another system and back");
    const ev = planHere(back.state, { battles: null, events: [{ eventId: "ev-1", eventType: "INCURSION",
      label: "Raid" }] }, "Bej", T0 + 6, M);
    assert.deepStrictEqual(ev.entries.map((x) => [x.kind, x.key, x.template, x.values]), [["EVENT_HERE", "event:ev-1",
      "EVENT_HERE", { system: "Bej", eventType: "INCURSION", label: "Raid" }]]);
    const none = planHere(ev.state, { battles: null, events: null }, "Bej", T0 + 7, M);
    assert.deepStrictEqual([none.entries, [...none.state.seen.keys()]], [[], [...ev.state.seen.keys()]], "no reading");
    const small = { worldHereSeenMax: 2 };
    let s = planHere(null, { battles: [battle("x1"), battle("x2")], events: [] }, "Bej", T0, small).state;
    s = planHere(s, { battles: [battle("x3")], events: [] }, "Bej", T0 + 1, small).state;
    assert.deepStrictEqual([...s.seen.keys()], ["battle:x2", "battle:x3"], "the oldest out");
    s = planHere(s, { battles: [battle("x2"), battle("x4")], events: [] }, "Bej", T0 + 2, small).state;
    assert.deepStrictEqual([...s.seen.keys()], ["battle:x2", "battle:x4"], "a visible key refreshed");
  });

  const driver = SH.loadDriver();
  const twd4 = "TWD4 listActiveInSystem: only ACTIVE of the system, limit + truncated, world_events_system; hereIn "
    + "without listOpenInSystem = battles:null and the events; noteEventInTx world:<key> once";
  if (!driver.ok) {
    skip(twd4, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(twd4, () => {
      SH.withStore(driver, ({ store }) => {
        const plan = (i, systemId) => ({ planKey: `p${i}`, eventType: "INCURSION", catalogVersion: 1, systemId,
          factionId: 500010, campaignId: null, cause: "TEST", templateIds: ["t1"], label: `L${i}`, dueAt: T0,
          expiresAt: T0 + 3600000, seed: i, reason: {} });
        const rows = [[1, A, "ACTIVE"], [2, A, "PLANNED"], [3, A, "COMPLETED"], [4, B, "ACTIVE"], [5, A, "ACTIVE"]];
        const w = store.transaction("t.twd4", (db) => {
          for (const [i, sys, state] of rows) {
            const r = eventRepository.insertPlannedInTx(db, plan(i, sys), { eventId: `ev-${i}`, now: T0 + i });
            assert.ok(r.ok && r.inserted, JSON.stringify(r));
            db.prepare("UPDATE world_events SET state = ? WHERE event_id = ?").run(state, `ev-${i}`);
          }
          return { ok: true };
        });
        assert.ok(w.ok, JSON.stringify(w));
        const read = (limit) => store.transaction("t.twd4r", (db) => eventRepository.listActiveInSystem(db, A,
          { limit })).value;
        const all = read(10);
        assert.deepStrictEqual([all.events.map((e) => e.eventId), all.truncated], [["ev-5", "ev-1"], false]);
        const cut = read(1);
        assert.deepStrictEqual([cut.events.map((e) => e.eventId), cut.truncated], [["ev-5"], true]);
        const planText = store.transaction("t.twd4p", (db) => ({ ok: true, rows: db.prepare("EXPLAIN QUERY PLAN "
          + "SELECT * FROM world_events WHERE system_id = ? AND state = 'ACTIVE' ORDER BY created_at DESC, event_id "
          + "LIMIT ?").all(A, 2) })).value.rows.map((r) => r.detail).join(" | ");
        assert.ok(planText.includes("world_events_system"), planText);

        const deps = createToolDeps({ adapter: {}, sensors: null, S: settings(), getGraph: () => null,
          getFleets: () => null, getWorld: () => null, getStore: () => store, getBattles: () => ({ repository: {} }) });
        const here = deps.hereIn(A, 5);
        assert.deepStrictEqual(here, { ok: true, battles: null, events: [{ eventId: "ev-5", eventType: "INCURSION",
          label: "L5" }, { eventId: "ev-1", eventType: "INCURSION", label: "L1" }] });
        assert.deepStrictEqual(deps.hereIn(0, 5), { ok: false, reason: "BAD_SYSTEM" });

        const repo = createShipAiEventsRepository(settings());
        const note = () => store.transaction("t.twd4n", (db) => repo.noteEventInTx(db, { playerId: PLAYER,
          kind: "WORLD_NEWS", key: "world:j:7:SYSTEM_CAPTURED", payload: { notice: "SYSTEM_CAPTURED" }, nowMs: T0 }))
          .value;
        assert.deepStrictEqual([note().inserted, note().inserted], [true, false]);
      });
    });
  }

  test("TWD5 mail: a notices mail skipped at the digest only when its events were told; noticesSenderOf; start on "
    + "NOTICES_DISABLED = WORLD_NEWS_NEEDS_NOTICES; stop removes only the own listener", () => {
    let listener = null;
    let now = T0;
    const told = new Set([1, 4]);
    const advanced = [];
    const mails = [{ messageId: 1, senderId: NOTICES_SENDER, title: "Front", body: "one" },
      { messageId: 2, senderId: NOTICES_SENDER, title: "Front", body: "two" },
      { messageId: 3, senderId: 7001, title: "Hi", body: "three" }];
    const seam = { hookState: () => "installed", addListener: (fn) => {
      listener = fn;
      return { ok: true, remove: () => { listener = null; } };
    }, removeListener: () => true, listIncoming: () => ({ ok: true, mails, maxId: 3, truncated: false, count: 3 }),
    readIncoming: ({ messageId }) => (messageId === 4 ? { ok: true, found: true, mail: { messageId: 4,
      senderId: NOTICES_SENDER, title: "Front", body: "four" } } : { ok: true, found: false }),
    senderInfo: (id) => ({ name: null, system: id === NOTICES_SENDER }) };
    const isNoticesSender = noticesSenderOf(0, (id) => seam.senderInfo(id));
    const mail = createShipAiMail({ S: settings({ mailEnabled: true }),
      store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
      prefsRepo: { advanceMailSeen: (_db, spec) => {
        advanced.push(spec.seenId);
        return { ok: true, changed: 1 };
      } }, seam, client: { request: () => Promise.resolve({ ok: false, reason: "DISABLED" }) },
      deliver: (_id, lines) => ({ room: lines.length, system: 0, failed: 0 }), memory: null, nameOf: () => "Jin",
      snapshot: () => ({ json: "{}", presence: null }), isAllowed: () => true,
      aiIdOf: (id) => (id === PLAYER ? AI : null), aiIds: () => new Set([AI]),
      initialPrefs: new Map([[PLAYER, { mailMode: "quiet", mailSeenId: 0 }]]),
      readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER }] }), nowMs: () => now, setTimer: NOTIMER,
      logger: { log() {} }, worldNewsToldMail: (pid, mid) => pid === PLAYER && told.has(mid), isNoticesSender });
    mail.start();
    listener({ characterId: PLAYER, messageId: 1, senderId: NOTICES_SENDER });
    assert.deepStrictEqual([mail.getStatus().counters.worldNewsSkipped, mail.getStatus().entries], [0, 1],
      "listed as any mail");
    mail.runPass();
    now += 86400000;
    mail.runPass();
    let c = mail.getStatus().counters;
    assert.deepStrictEqual([c.worldNewsSkipped, c.staticDigests, advanced], [1, 1, [3]], "mail 1 out, 2 and 3 in");
    listener({ characterId: PLAYER, messageId: 4, senderId: NOTICES_SENDER });
    now += 86400000;
    mail.runPass();
    c = mail.getStatus().counters;
    assert.deepStrictEqual([c.worldNewsSkipped, c.staticDigests, advanced], [2, 1, [3, 4]],
      "a told mail alone: no digest, the cursor past it");
    mail.stop();
    const fixed = noticesSenderOf(55, () => ({ system: true }));
    assert.deepStrictEqual([fixed(55), fixed(NOTICES_SENDER), isNoticesSender(NOTICES_SENDER), isNoticesSender(7001),
      noticesSenderOf(0, null)(NOTICES_SENDER)], [true, false, true, false, false]);

    const off = proactiveRig(null, { getNotices: () => createUnavailableNotices("NOTICES_DISABLED") });
    off.p.start();
    assert.deepStrictEqual([off.p.getStatus().triggers.world, off.p.worldNewsCovers(PLAYER)],
      ["WORLD_NEWS_NEEDS_NOTICES", false]);
    off.p.stop();
    const none = proactiveRig(null, {});
    none.p.start();
    assert.strictEqual(none.p.getStatus().triggers.world, "WORLD_NEWS_NEEDS_NOTICES", "no ctx.notices");
    none.p.stop();
    const cfgOff = proactiveRig({ worldNewsEnabled: false }, { getNotices: () => { throw new Error("never"); } });
    cfgOff.p.start();
    assert.strictEqual(cfgOff.p.getStatus().triggers.world, "off");
    cfgOff.p.stop();

    const listeners = [];
    const facade = { onWarEvents: (fn) => {
      listeners.push(fn);
      return { ok: true, unsubscribe: () => listeners.splice(listeners.indexOf(fn), 1) };
    } };
    const other = () => {};
    const on = proactiveRig({ triggersDisabledKinds: "" }, { getNotices: () => facade });
    on.p.start();
    listeners.push(other);
    assert.deepStrictEqual([on.p.getStatus().triggers.world, listeners.length, on.p.worldNewsCovers(PLAYER)],
      ["on", 2, true]);
    on.p.stop();
    assert.deepStrictEqual([listeners, on.p.worldNewsCovers(PLAYER)], [[other], false]);
    const muted = proactiveRig({ triggersDisabledKinds: "WORLD_NEWS" }, { getNotices: () => facade });
    muted.p.start();
    assert.strictEqual(muted.p.worldNewsCovers(PLAYER), false, "muted");
    muted.p.stop();
  });

  const twd5b = "TWD5b real startNotices: the shipAi listener and another listener both get the committed views";
  if (!driver.ok) {
    skip(twd5b, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(twd5b, () => {
      SH.withStore(driver, ({ store }) => {
        const clock = createManualClock(T0);
        const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
        const world = createWorldStateRepository({ journal, clock, limits: { maxFactionsPerSystem: 8,
          maxBatchReadIds: 400, maxListLimit: 500 } });
        let version = 0;
        const change = (state, reason, key) => {
          const r = store.transaction("t", (db) => world.applyChange(db, { systemId: A, expectedVersion: version,
            reason, state }, key));
          assert.ok(r.ok && r.value.ok, JSON.stringify(r));
          version = r.value.version;
        };
        change({ securityClass: "nullsec", controllerFactionId: F.DEFENDER }, "SEED_CONTROL", "tw:seed");
        const presence = { getStatus: () => ({ available: true, stale: false }),
          getSystemPresence: (id) => ({ characters: id === A ? [{ characterId: PLAYER, name: "x", state: "space" }]
            : [] }) };
        const adapter = { readFactionNames: () => ({ ok: true, names: new Map([[F.ATTACKER, "Guristas"]]) }),
          sendPlayerMail: () => ({ ok: true, messageId: 1 }), findPlayerMail: () => ({ ok: true, found: false }),
          defaultMailSender: () => ({ ok: true, senderId: 7 }) };
        const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config;
        const started = startNotices({ config: cfg, ctx: { persistence: { ok: true, store, journal },
          world: { repository: world }, presence, graph: { getGraph: () => ({ ok: true, graph }) } }, adapter, clock,
        setTimer: () => ({ cancel: () => {} }) });
        assert.ok(started.ok, JSON.stringify(started));
        const n = started.notices;
        const r = proactiveRig(null, { getNotices: () => n });
        r.p.start();
        const got = [];
        assert.ok(n.onWarEvents((views) => got.push(...views.map((v) => v.kind))).ok);
        const p = F.occupationSteps(A);
        change({ occupationState: "CONTESTED", occupierFactionId: F.ATTACKER }, "OCCUPATION_SIGNAL", "tw:sig");
        change(p.invade, "OCCUPATION_PHASE_CHANGE", "tw:inv");
        n.stop("test");
        assert.deepStrictEqual([got, r.p.getStatus().counters.worldViews, r.p.getStatus().triggers.queuedViews],
          [["ATTACK_STARTED"], 1, 1]);
        r.p.stop();
      });
    });
  }

  test("TWD6 config and templates: worldNewsKinds FOO = warning + default, the literal copies = sources.KINDS, every "
    + "KIND has its pl / en template (+ _PLAIN when it names a faction), the d kinds have a priority", () => {
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_WORLD_NEWS_KINDS: "FOO" } });
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_SHIP_AI_WORLD_NEWS_KINDS")), JSON.stringify(
      bad.warnings));
    assert.strictEqual(bad.config.shipAi.worldNewsKinds, "");
    const good = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_WORLD_NEWS_KINDS: "SIEGE_STARTED,player_impact" } });
    assert.strictEqual(good.config.shipAi.worldNewsKinds, "SIEGE_STARTED,player_impact");
    const KINDS = ALL_KINDS.filter((k) => k !== "HARVEST_RAID_WARNED" && k !== "HARVEST_RAID_ENDED"
      && k !== "NATIVE_INCURSION_STARTED" && k !== "NATIVE_INCURSION_ENDED");
    assert.deepStrictEqual([...WORLD_NOTICE_KINDS], [...KINDS]);
    assert.ok(KINDS.every((k) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_WORLD_NEWS_KINDS: k } })
      .config.shipAi.worldNewsKinds === k), "the check copy accepts every KIND");
    for (const lang of ["pl", "en"]) {
      for (const k of KINDS) {
        const main = TRIGGER_TEXT[lang][`WORLD_NEWS_${k}`];
        assert.ok(Array.isArray(main) && main.length >= 2, `${lang} WORLD_NEWS_${k}`);
        if (main.some((l) => l.includes("{attacker}") || l.includes("{defender}"))) {
          assert.ok(TRIGGER_TEXT[lang][`WORLD_NEWS_${k}_PLAIN`].length >= 2, `${lang} WORLD_NEWS_${k}_PLAIN`);
        }
      }
      for (const k of ["BATTLE_HERE", "BATTLE_HERE_PLAIN", "EVENT_HERE"]) assert.ok(TRIGGER_TEXT[lang][k].length >= 2);
    }
    assert.deepStrictEqual(TRIGGER_KINDS_D.map((k) => PRIORITY[k]), [48, 52, 38]);
    const d = base.shipAi;
    assert.deepStrictEqual([d.worldNewsEnabled, d.worldNewsRadiusJumps, d.worldNewsKinds, d.worldNewsSystemCooldownMs,
      d.worldNewsCooldownMs, d.worldNewsModel, d.battleHereEnabled, d.eventHereEnabled, d.worldHereCooldownMs,
      d.worldHereScanMs, d.worldHereSeenMax], [true, 2, "", 900000, 300000, false, true, true, 600000, 30000, 64]);
  });

  test("TWD7 the pass: a world news line one jump away, the system cooldown, BATTLE_HERE model fallback with the "
    + "names, a LIVE battle skipped", async () => {
    let listener = null;
    let battles = [{ battleId: "b1", state: "RESOLVING", mode: "VIRTUAL", a: "X", b: "Y" }];
    const mailKeys = new Map([[1, ["j:7:SYSTEM_CAPTURED"]], [2, ["j:7:SYSTEM_CAPTURED", "j:9:ATTACK_STARTED"]],
      [3, []]]);
    const r = proactiveRig(null, { getNotices: () => ({ onWarEvents: (fn) => {
      listener = fn;
      return { ok: true, unsubscribe: () => { listener = null; } };
    }, mailEventKeys: (_pid, mid) => ({ ok: true, eventKeys: mailKeys.get(mid) || [] }) }),
    toolDeps: { hereIn: () => ({ ok: true, battles, events: [] }) } });
    r.p.start();
    r.pass();
    r.pass();
    assert.deepStrictEqual([r.delivered, r.p.getStatus().counters.hereReads], [[], 1], JSON.stringify(r.logs));
    listener([view()]);
    r.pass();
    const values = { attacker: "Guristas", system: "Venal", where: "jeden skok stąd" };
    assert.ok(r.delivered.length === 1 && filled(TRIGGER_TEXT.pl.WORLD_NEWS_SYSTEM_CAPTURED, values)
      .includes(r.delivered[0]), JSON.stringify(r.delivered));
    listener([view({ eventKey: "j:9:ATTACK_STARTED", kind: "ATTACK_STARTED" })]);
    r.pass();
    assert.deepStrictEqual([r.delivered.length, r.p.getStatus().counters.worldSystemCooldown], [1, 1]);
    assert.deepStrictEqual([1, 2, 3].map((mid) => r.p.worldNewsToldMail(PLAYER, mid)).concat(
      r.p.worldNewsToldMail(OTHER, 1)), [true, false, false, false], "told only when every event was told");
    battles = [...battles, { battleId: "b2", state: "RESOLVING", mode: "VIRTUAL", a: "Amarr Empire",
      b: "Minmatar Republic" }];
    r.pass(30000);
    assert.strictEqual(r.requests.length, 1, "BATTLE_HERE asks the model within the global limit");
    await flush();
    const battleLines = filled(TRIGGER_TEXT.pl.BATTLE_HERE, { a: "Amarr Empire", b: "Minmatar Republic" });
    assert.ok(r.delivered.length === 2 && battleLines.includes(r.delivered[1]), JSON.stringify(r.delivered));
    battles = [...battles, { battleId: "b3", state: "LIVE", mode: "LIVE_EVEJS", a: "X", b: "Y" }];
    r.pass(30000);
    const st = r.p.getStatus();
    assert.deepStrictEqual([r.delivered.length, st.counters.hereLiveSkipped, st.counters.worldLines,
      st.counters.hereLines, st.byKind.WORLD_NEWS, st.byKind.BATTLE_HERE, st.triggers.here, r.keys.has("battle:b2"),
      r.keys.has("world:j:7:SYSTEM_CAPTURED")], [2, 1, 1, 1, 1, 1, "on", true, true]);
    r.p.stop();
    assert.strictEqual(listener, null, "unsubscribed");
    assert.strictEqual(r.p.worldNewsToldMail(PLAYER, 1), false, "stopped");
  });

  test("TWD8: a BATTLE_HERE whose row is not new starts no cooldown (the next new battle is told)", async () => {
    let battles = [{ battleId: "b1", state: "RESOLVING", mode: "VIRTUAL", a: "X", b: "Y" }];
    const r = proactiveRig({ worldNewsEnabled: false }, { toolDeps: { hereIn: () => ({ ok: true, battles,
      events: [] }) } });
    r.p.start();
    r.pass();
    r.pass();
    r.keys.add("battle:b2");
    battles = [...battles, { battleId: "b2", state: "RESOLVING", mode: "VIRTUAL", a: "X", b: "Y" }];
    r.pass(30000);
    assert.deepStrictEqual([r.requests.length, r.p.getStatus().counters.triggerDuplicate], [0, 1], "b2 told before");
    battles = [...battles, { battleId: "b4", state: "RESOLVING", mode: "VIRTUAL", a: "X", b: "Y" }];
    r.pass(30000);
    assert.strictEqual(r.requests.length, 1, "b4 is told (no cooldown from b2)");
    await flush();
    r.p.stop();
  });

  const twd9 = "TWD9 notices listMailEventKeysInTx: the event keys of the SENT batch of one mail, else none";
  if (!driver.ok) {
    skip(twd9, `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test(twd9, () => {
      SH.withStore(driver, ({ store }) => {
        const repo = createNoticeRepository();
        const item = (eventKey, characterId) => ({ eventKey, characterId, kind: "SYSTEM_CAPTURED", systemId: A,
          line: `line ${eventKey}`, eventAt: T0 });
        const w = store.transaction("t.twd9", (db) => {
          const q = repo.enqueueItemsInTx(db, [item("k2", PLAYER), item("k1", PLAYER), item("k1", OTHER)], T0);
          assert.ok(q.ok && q.inserted === 3, JSON.stringify(q));
          const o = repo.openBatchInTx(db, { characterId: PLAYER, senderId: 7, now: T0, maxItems: 5,
            render: (lines) => ({ title: "Front", body: lines.join("\n") }) });
          assert.ok(o.ok && o.batch, JSON.stringify(o));
          const f = repo.finishBatchInTx(db, o.batch.batchKey, { outcome: "SENT", messageId: 77, now: T0,
            maxAttempts: 3 });
          assert.ok(f.ok, JSON.stringify(f));
          return { ok: true };
        });
        assert.ok(w.ok, JSON.stringify(w));
        const keys = (characterId, messageId) => store.transaction("t.twd9r", (db) => repo.listMailEventKeysInTx(db,
          { characterId, messageId, limit: 10 })).value;
        assert.deepStrictEqual([keys(PLAYER, 77), keys(PLAYER, 78), keys(OTHER, 77), keys(PLAYER, 0).reason],
          [{ ok: true, eventKeys: ["k1", "k2"] }, { ok: true, eventKeys: [] }, { ok: true, eventKeys: [] },
            "INVALID_INPUT"]);
      });
    });
  }
};
