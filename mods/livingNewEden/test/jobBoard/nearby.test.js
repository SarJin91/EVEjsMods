"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { createJournal } = require("../../lib/persistence/journal");
const { startEvents, unavailableEvents } = require("../../lib/events");
const eventRepository = require("../../lib/events/eventRepository");
const { SIGNATURE_EVENT_TYPES } = require("../../lib/events/boardRows");
const { ANOMALY_EVENT_CATALOG } = require("../../lib/events/data/eventCatalog");
const { startHeavyEvents, createUnavailableHeavyEvents, FACADE_METHODS: HEAVY_METHODS } = require("../../lib/heavyEvents");
const { createSalvageAnomalyService } = require("../../lib/events/salvage/anomalyService");
const { unavailableSalvageAnomaly } = require("../../lib/events/salvage");
const { startNews, createUnavailableNews } = require("../../lib/news");
const { NEWS_METHODS } = require("../../lib/news/schema");
const { startJobBoard } = require("../../lib/jobBoard");
const { createNearby } = require("../../lib/jobBoard/nearby");
const { buildSnapshot } = require("../../lib/jobBoard/readModel");
const { toWireV1, MAX_REFUSALS } = require("../../lib/jobBoard/wire");
const { heavyRowsOf } = require("../../lib/heavyEvents/boardRows");
const WC = require("../../lib/heavyEvents/world/catalog");
const W = require("../../lib/heavyEvents/world/schema");
const R = require("../news/mailRig");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const H = 3600000;
const HOME = 30000142;
const NEAR = 30000144;
const FAR = 30002187;
const FORGE = 10000002;
const CHAR = 90000001;
const GURISTAS = 500010;
const ROW_KEYS = ["endsAt", "factionId", "kind", "level", "ref", "rewardText", "scan", "source", "state", "systemId",
  "title"];
const SET_TIMER = () => ({ cancel() {}, hasRef: () => false });
const SALVAGE_BOARD_SQL = "SELECT anomaly_id, system_id, state, wrecks_remaining, expires_at FROM "
  + "world_salvage_anomalies WHERE state = 'PLACED' AND system_id IN (SELECT value FROM json_each(?)) "
  + "ORDER BY expires_at, anomaly_id LIMIT ?";
const DML = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_JOB_BOARD_ENABLED: "1",
    EVEJS_LNE_EVENTS_ENABLED: "1", EVEJS_LNE_SITES_ENABLED: "1", EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "0",
    EVEJS_LNE_NEWS_ENABLED: "1", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

const NODES = { [HOME]: { name: "Jita", regionId: FORGE }, [NEAR]: { name: "Perimeter", regionId: FORGE },
  [FAR]: { name: "Amarr", regionId: 10000043 } };
const GRAPH = Object.freeze({
  getSystem: (id) => NODES[id] || null,
  getNeighbors: (id) => (id === HOME ? [NEAR] : id === NEAR ? [HOME] : []),
  getSystemsInRegion: (r) => Object.keys(NODES).map(Number).filter((id) => NODES[id].regionId === r),
  getRegionName: (r) => (r === FORGE ? "The Forge" : "Domain"),
});

function counting(store) {
  const names = [];
  const dml = [];
  const wrapDb = (db) => new Proxy(db, { get(t, k) {
    if (k === "prepare") {
      return (sql) => {
        const st = t.prepare(sql);
        if (!DML.test(sql)) return st;
        return new Proxy(st, { get(s, m) {
          if (m === "run") return (...a) => {
            dml.push(sql);
            return s.run(...a);
          };
          const v = s[m];
          return typeof v === "function" ? v.bind(s) : v;
        } });
      };
    }
    if (k === "exec") return (sql) => {
      dml.push(sql);
      return t.exec(sql);
    };
    const v = t[k];
    return typeof v === "function" ? v.bind(t) : v;
  } });
  const wrapped = { ...store, transaction(name, fn) {
    names.push(name);
    return store.transaction(name, (db) => fn(wrapDb(db)));
  } };
  return { store: wrapped, names, dml };
}

const run = (store, fn) => {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function seed(store) {
  run(store, (db) => {
    const plan = (k, eventType, systemId, expiresAt, label) => eventRepository.insertPlannedInTx(db, { planKey: `pk:${k}`,
      eventType, catalogVersion: 1, systemId, factionId: GURISTAS, campaignId: null, cause: "OCCUPATION_CLAIM",
      templateIds: ["client-dungeon:1"], label, dueAt: AT, expiresAt, seed: 1, reason: {} }, { eventId: `e${k}`, now: AT });
    assert.ok(plan("a", "pirate_stronghold", NEAR, AT + 2 * H, "Guristas Stronghold").ok);
    assert.ok(plan("b", "ded_complex", NEAR, AT + H, "Zażółć Deadspace Complex").ok);
    assert.ok(plan("c", "pirate_outpost", NEAR, AT + 3 * H, "Ended outpost").ok);
    assert.ok(plan("d", "pirate_war_depot", FAR, AT + 4 * H, "Guristas War Depot").ok);
    db.prepare("UPDATE world_events SET state = 'ACTIVE' WHERE event_id IN ('ea', 'ed')").run();
    db.prepare("UPDATE world_events SET state = 'ENDED' WHERE event_id = 'ec'").run();
    const heavy = db.prepare("INSERT INTO world_heavy_events (event_id, plan_key, event_type, tier, system_id, faction_id, "
      + "state, open, members_json, seed, created_at, expires_at, updated_at, variant, affix, pocket) "
      + "VALUES (?, ?, ?, 1, ?, ?, ?, 1, '[]', 1, ?, ?, ?, ?, ?, 0)");
    heavy.run("hev:1:0", "plan-hev-1", "redoubt", NEAR, GURISTAS, "PLANNED", AT, AT + 5 * H, AT, null, null);
    heavy.run("hev:1:1", "plan-hev-2", "foundry", NEAR, GURISTAS, "CLEARED", AT, AT + H, AT, null, null);
    heavy.run("hpw:1:0", "plan-hpw-1", "cache", NEAR, GURISTAS, "PLANNED", AT, AT + 2 * H, AT, "guard", "none");
    heavy.run("hpw:1:1", "plan-hpw-2", "outpost", HOME, GURISTAS, "ENGAGED", AT, AT + 3 * H, AT, "brawl", "rich");
    heavy.run("hwa:1:0", "plan-hwa-1", "hunt", NEAR, GURISTAS, "PLANNED", AT, AT + H, AT, "guarded", "none");
    const salv = db.prepare("INSERT INTO world_salvage_anomalies (anomaly_id, field_id, system_id, state, haul_salvage, "
      + "haul_loot, seed, plan_json, wrecks_planned, wrecks_remaining, expires_at, next_at, created_at, updated_at) "
      + "VALUES (?, ?, ?, ?, 0, 0, 1, '[]', 3, ?, ?, ?, ?, ?)");
    salv.run("salv:a", "f-a", NEAR, "PLACED", 3, AT + H, AT, AT, AT);
    salv.run("salv:b", "f-b", HOME, "PLACED", 2, AT + 2 * H, AT, AT, AT);
    salv.run("salv:c", "f-c", FAR, "PLACED", 2, AT + H, AT, AT, AT);
    salv.run("salv:d", "f-d", NEAR, "SITE_PENDING", 0, AT + H, AT, AT, AT);
  });
}

function rig(opened, env = {}) {
  const config = configOf(env);
  const counted = counting(opened.store);
  const store = counted.store;
  const clock = { at: AT };
  clock.now = () => clock.at;
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: 1 };
  const events = startEvents({ config, persistence, clock, ids: { next: () => "id" }, logger: { log() {} },
    scheduler: { registerHandler: () => ({ ok: true, unregister() {} }), enqueue: () => ({ ok: true }) } });
  assert.ok(events.ok, JSON.stringify(events));
  const heavy = startHeavyEvents({ config, ctx: { persistence }, clock, setTimer: SET_TIMER, logger: { log() {} } });
  assert.ok(heavy.ok, JSON.stringify(heavy));
  const salvage = createSalvageAnomalyService({ store, journal, worldSeed: 1, adapter: null, clock, config });
  const adapter = { readFactionNames: () => ({ ok: true, names: new Map([[GURISTAS, "Guristas Pirates"]]) }),
    installChatCommand: () => ({ ok: true }), uninstallChatCommand: () => ({ ok: true }),
    boardHookState: () => ({ status: "WRAPPED" }),
    publishBoardDelivery: () => ({ ok: true, bytes: 1, delivery: { setReady() {},
      stats: () => ({ ready: true, composed: 0, skipped: 0 }) } }),
    withdrawBoardDelivery: () => ({ ok: true }),
    registerClientService(_w, spec) {
      adapter.handlers = spec.handlers;
      return { ok: true, unregister() {} };
    },
    sendClientNotification: () => ({ ok: true }) };
  const news = startNews({ config, adapter, clock, setTimer: SET_TIMER,
    ctx: { persistence, notices: { onWarEvents: () => ({ ok: false, reason: "NOTICES_DISABLED" }) } } });
  assert.ok(news.ok, JSON.stringify(news));
  const world = { repository: {
    getSystem: () => ({ ok: false, reason: "NOT_FOUND" }),
    getSystems: (_db, ids) => ({ ok: true, systems: ids.map((systemId) => ({ systemId, occupationState: "STABLE",
      controllerFactionId: GURISTAS, occupierFactionId: null })) }),
  } };
  const ctx = { persistence, graph: { getGraph: () => ({ ok: true, graph: GRAPH }) }, governor: { admits: () => true },
    world, events: events.events, heavyEvents: heavy.heavyEvents,
    salvageAnomaly: { listBoardRows: (o) => salvage.listBoardRows(o) }, news: news.news };
  const jb = startJobBoard({ config, ctx, adapter, clock, world: {} });
  assert.ok(jb.ok, JSON.stringify(jb));
  return { config, clock, store, names: counted.names, dml: counted.dml, ctx, events: events.events,
    heavy: heavy.heavyEvents, salvage, news: news.news, GetBoard: adapter.handlers.GetBoard,
    stop() {
      jb.jobBoard.stop("test");
      news.news.stop("test");
      heavy.heavyEvents.stop("test");
      events.events.stop("test");
    } };
}

function assertShape(rows) {
  for (const r of rows) {
    assert.deepStrictEqual(Object.keys(r).sort(), ROW_KEYS, JSON.stringify(r));
    assert.ok(r.ref.length <= 64 && r.kind.length <= 24 && r.title.length <= 80 && r.state.length <= 16);
    assert.ok(/^[\x20-\x7e]+$/.test(r.kind) && /^[\x20-\x7e]+$/.test(r.title), JSON.stringify(r));
    assert.ok(r.rewardText === null || r.rewardText.length <= 60);
    assert.strictEqual(typeof r.scan, "boolean");
  }
}

const refs = (r) => {
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assertShape(r.rows);
  return r.rows.map((x) => x.ref);
};

function row(source, ref, over = {}) {
  return { ref, source, kind: "k", title: `t ${ref}`, systemId: NEAR, factionId: null, level: null, scan: false,
    rewardText: "Loot", endsAt: AT + H, state: "ACTIVE", ...over };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("JN1 listBoardRows on the real facades: shape, prefixes, hwa: unknown kind out, filter, limit + truncated, "
    + "WAITING, "
    + "scan, refusals, TX_ACTIVE, EXPLAIN, stub keys", () => withStore(driver, (opened) => {
    seed(opened.store);
    const g = rig(opened);
    try {
      const near = new Set([HOME, NEAR]);
      const ev = g.events.listBoardRows({ systemIds: near, limit: 10, now: AT });
      assert.deepStrictEqual(refs(ev), ["ev:eb", "ev:ea"]);
      assert.deepStrictEqual(ev.rows.map((r) => [r.source, r.state, r.scan, r.factionId]),
        [["events", "WAITING", true, GURISTAS], ["events", "ACTIVE", false, GURISTAS]]);
      assert.strictEqual(ev.rows[0].title, "Za???? Deadspace Complex");
      assert.deepStrictEqual([ev.truncated, g.events.listBoardRows({ systemIds: near, limit: 1 }).truncated], [false, true]);
      const all = g.events.listBoardRows({ systemIds: null, limit: 10 });
      assert.deepStrictEqual(refs(all), ["ev:eb", "ev:ea", "ev:ed"]);
      assert.strictEqual(all.rows[2].rewardText, "Faction loot depot");

      const hv = g.heavy.listBoardRows({ systemIds: near, limit: 10 });
      assert.deepStrictEqual(refs(hv), ["pw:hpw:1:0", "pw:hpw:1:1", "hv:hev:1:0"]);
      assert.ok(hv.rows.length > 0 && hv.rows.every((x) => x.level === null), JSON.stringify(hv.rows));
      assert.deepStrictEqual(hv.rows.map((r) => [r.source, r.kind, r.scan, r.rewardText, r.state]), [
        ["power", "guard", true, "Cache loot", "PLANNED"], ["power", "brawl", false, "Loot chest", "ENGAGED"],
        ["heavy", "redoubt", false, "Loot chest", "PLANNED"]]);
      assert.strictEqual(hv.rows[2].title, "an unknown faction Redoubt", "drain mode: no faction names");
      const hvOne = g.heavy.listBoardRows({ systemIds: new Set([NEAR]), limit: 1 });
      assert.deepStrictEqual([refs(hvOne), hvOne.truncated], [["pw:hpw:1:0"], true]);

      const sv = g.salvage.listBoardRows({ systemIds: near, limit: 10 });
      assert.deepStrictEqual(refs(sv), ["sv:salv:a", "sv:salv:b"]);
      assert.deepStrictEqual([sv.rows[0].title, sv.rows[0].kind, sv.rows[0].rewardText, sv.rows[0].factionId],
        ["Wreck field (3 wrecks)", "wreck_field", "Salvage + loot", null]);
      assert.deepStrictEqual(g.salvage.listBoardRows({ systemIds: near, limit: 1 }).truncated, true);
      const plan = run(opened.store, (db) => db.prepare(`EXPLAIN QUERY PLAN ${SALVAGE_BOARD_SQL}`)
        .all(JSON.stringify([HOME, NEAR]), 11)).map((x) => String(x.detail)).join(" | ");
      assert.ok(plan.includes("world_salvage_anomalies_system"), plan);

      const inTx = run(g.store, () => [g.events.listBoardRows({ systemIds: near, limit: 3 }).reason,
        g.heavy.listBoardRows({ systemIds: near, limit: 3 }).reason,
        g.salvage.listBoardRows({ systemIds: near, limit: 3 }).reason, g.news.latestHeadline().reason]);
      assert.deepStrictEqual(inTx, ["TX_ACTIVE", "TX_ACTIVE", "TX_ACTIVE", "TX_ACTIVE"]);
      assert.strictEqual(g.heavy.listBoardRows({ systemIds: [NEAR], limit: 3 }).reason, "SYSTEM_IDS_INVALID");
      assert.strictEqual(g.events.listBoardRows({ systemIds: near, limit: 0 }).reason, "LIMIT_INVALID");
      const boom = { ...g.store, isInTransaction: () => false, transaction() {
        throw new Error("disk gone");
      } };
      const svBoom = createSalvageAnomalyService({ store: boom, journal: null, worldSeed: 1, adapter: null,
        clock: g.clock, config: g.config }).listBoardRows({ systemIds: near, limit: 3 });
      assert.deepStrictEqual([svBoom.ok, svBoom.reason], [false, "SALVAGE_BOARD_FAILED"]);

      assert.deepStrictEqual(Object.keys(unavailableEvents("EVENTS_DISABLED")).sort(), Object.keys(g.events).sort());
      assert.strictEqual(unavailableEvents("EVENTS_DISABLED").listBoardRows({}).reason, "EVENTS_DISABLED");
      assert.deepStrictEqual(Object.keys(g.heavy).sort(), [...HEAVY_METHODS].sort());
      assert.deepStrictEqual(Object.keys(createUnavailableHeavyEvents("x")).sort(), [...HEAVY_METHODS].sort());
      assert.deepStrictEqual([createUnavailableHeavyEvents("disabled_by_config").listBoardRows().reason,
        createUnavailableHeavyEvents("stopped").listBoardRows().reason],
      ["HEAVY_EVENTS_DISABLED", "HEAVY_EVENTS_UNAVAILABLE"]);
      assert.ok(Object.keys(unavailableSalvageAnomaly("SALVAGE_ANOMALY_DISABLED")).includes("listBoardRows"));
      assert.deepStrictEqual(Object.keys(g.news), [...NEWS_METHODS]);
      assert.deepStrictEqual(Object.keys(createUnavailableNews("NEWS_DISABLED")), [...NEWS_METHODS]);
      assert.strictEqual(createUnavailableNews("NEWS_DISABLED").latestHeadline().reason, "NEWS_DISABLED");
      for (const t of ANOMALY_EVENT_CATALOG) assert.ok(SIGNATURE_EVENT_TYPES.includes(t.eventType), t.eventType);
    } finally {
      g.stop();
    }
  }));

  test("JN2 read model + nearby: merge, order, cut + more.near, mask, _DISABLED silent, refused / throwing source, "
    + "no system, foreign prefix", () => {
    const settings = configOf().jobBoard;
    const bumps = [];
    const ctx = {
      events: { listBoardRows: () => ({ ok: true, rows: [row("events", "ev:2", { endsAt: null }),
        row("events", "ev:1", { systemId: HOME, scan: true, level: "L5", kind: "ded_complex" })], truncated: true }) },
      heavyEvents: { listBoardRows: () => {
        throw new Error("boom");
      } },
      salvageAnomaly: { listBoardRows: () => ({ ok: true, rows: [row("salvage", "sv:1", { endsAt: AT + 60000 }),
        row("salvage", "hv:9"), row("salvage", "sv:far", { systemId: FAR })] }) },
    };
    const nb = createNearby({ settings: { ...settings, frontEnabled: false, newsEnabled: false }, ctx,
      clock: { now: () => AT }, storeOf: () => null, bump: (n) => bumps.push(n) });
    const distances = new Map([[HOME, 0], [NEAR, 1]]);
    const input = nb.read({ systemId: HOME }, distances, AT, GRAPH);
    assert.deepStrictEqual([input.front, input.news], [null, null]);
    assert.deepStrictEqual(input.events.refusals, ["heavy:THREW"]);
    const names = { system: (id) => (NODES[id] ? NODES[id].name : null) };
    const snap = (over) => buildSnapshot({ now: AT, viewer: { characterId: CHAR, systemId: HOME },
      jobs: { ok: true, jobs: [] }, wars: { ok: true, rows: [] }, jumpsOf: (id) => distances.get(id) ?? null, names,
      limits: { maxJobRows: 5, maxWarRows: 5, maxNearRows: 2, newsMaxChars: 400 }, nearby: input, ...over });
    const s = snap({});
    assert.deepStrictEqual(s.near.map((r) => [r.ref, r.jumps, r.endsIn]), [["ev:1", 0, 3600], ["sv:1", 1, 60]]);
    assert.deepStrictEqual([s.more.near, s.refusals], [1 + 1, ["heavy:THREW"]], "one cut row + one truncated source");
    assert.deepStrictEqual([s.near[0].title, s.near[0].kind, s.near[0].reward, s.near[0].level, s.near[0].scan],
      ["Unknown signature", "signature", "", "", true]);
    const open = snap({ revealSignatures: true });
    assert.deepStrictEqual([open.near[0].title, open.near[0].kind, open.near[0].level], ["t ev:1", "ded_complex", "L5"]);
    const wire = toWireV1(snap({ limits: { maxJobRows: 5, maxWarRows: 5, maxNearRows: 10 } }), { pollMs: 0 });
    assert.deepStrictEqual(wire.near.map((r) => r.ref), ["ev:1", "sv:1", "ev:2"], "endsIn 0 last; hv:9 / far dropped");
    assert.deepStrictEqual(Object.keys(wire.near[0]), ["ref", "src", "kind", "title", "sys", "sysName", "jumps",
      "level", "scan", "reward", "endsIn", "state"]);

    ctx.events = { listBoardRows: () => ({ ok: false, reason: "EVENTS_DISABLED" }) };
    ctx.heavyEvents = {};
    ctx.salvageAnomaly = { listBoardRows: () => ({ ok: false, reason: "TX_FAILED" }) };
    bumps.length = 0;
    const quiet = nb.read({ systemId: HOME }, distances, AT, GRAPH);
    assert.deepStrictEqual([quiet.events.rows, quiet.events.refusals], [[], ["salvage:TX_FAILED"]]);
    assert.deepStrictEqual(bumps.filter((b) => b === "nearSourceOff").length, 4);
    const none = nb.read({ systemId: null }, null, AT, GRAPH);
    assert.deepStrictEqual(none.events.refusals, ["nearby:NO_SYSTEM"]);
    assert.strictEqual(none.events.systemIds.size, 0, "never the whole world");
  });

  test("SC2 situations source: si: row -> near row src sit with title and endsIn; SITUATIONS_DISABLED silent", () => {
    const settings = configOf().jobBoard;
    const bumps = [];
    const off = (reason) => ({ listBoardRows: () => ({ ok: false, reason }) });
    const answer = { r: { ok: true, truncated: false, rows: [row("sit", "si:sabc-1", { kind: "BELT_RAID",
      title: "Distress: Asteroid Belt 3", rewardText: null, endsAt: AT + 600000, state: "CALLING" })] } };
    const ctx = { events: off("EVENTS_DISABLED"), heavyEvents: off("HEAVY_EVENTS_DISABLED"),
      salvageAnomaly: off("SALVAGE_ANOMALY_DISABLED"), situations: { listBoardRows: () => answer.r } };
    const nb = createNearby({ settings: { ...settings, frontEnabled: false, newsEnabled: false }, ctx,
      clock: { now: () => AT }, storeOf: () => null, bump: (n) => bumps.push(n) });
    const distances = new Map([[HOME, 0], [NEAR, 1]]);
    const names = { system: (id) => (NODES[id] ? NODES[id].name : null) };
    const wireOf = (input) => toWireV1(buildSnapshot({ now: AT, viewer: { characterId: CHAR, systemId: HOME },
      jobs: { ok: true, jobs: [] }, wars: { ok: true, rows: [] }, jumpsOf: (id) => distances.get(id) ?? null, names,
      limits: { maxJobRows: 5, maxWarRows: 5, maxNearRows: 10, newsMaxChars: 400 }, nearby: input }), { pollMs: 0 });
    const w = wireOf(nb.read({ systemId: HOME }, distances, AT, GRAPH));
    assert.deepStrictEqual(w.near.map((r) => [r.ref, r.src, r.kind, r.title, r.sysName, r.jumps, r.reward, r.endsIn,
      r.state]), [["si:sabc-1", "sit", "BELT_RAID", "Distress: Asteroid Belt 3", "Perimeter", 1, "", 600, "CALLING"]]);
    answer.r = { ok: false, reason: "SITUATIONS_DISABLED" };
    bumps.length = 0;
    const quiet = nb.read({ systemId: HOME }, distances, AT, GRAPH);
    assert.deepStrictEqual([quiet.events.rows, quiet.events.refusals], [[], []]);
    assert.strictEqual(bumps.filter((b) => b === "nearSourceOff").length, 5);
    answer.r = { ok: false, reason: "NOT_READY" };
    assert.deepStrictEqual(nb.read({ systemId: HOME }, distances, AT, GRAPH).events.refusals, ["situations:NOT_READY"]);
  });

  needsDriver("JN3 GetBoard: constant tx set, zero writes; cache TTL; flags off -> no new keys, fields "
    + "unchanged", () => withStore(driver, (opened) => {
    seed(opened.store);
    R.publishEdition(opened.store, { boundaryAt: AT - H, now: AT - H, title: "War", paragraphs: ["p1"],
      activeSince: AT - H, limit: 10 });
    const g = rig(opened, { EVEJS_LNE_JOB_BOARD_FRONT_CACHE_TTL_MS: "0", EVEJS_LNE_JOB_BOARD_NEWS_CACHE_TTL_MS: "0" });
    try {
      g.names.length = 0;
      g.dml.length = 0;
      const first = g.GetBoard({ characterId: CHAR, systemId: HOME });
      assert.strictEqual(first.v, 1, JSON.stringify(first));
      assert.deepStrictEqual([...g.names].sort(), ["events.board", "frontChat.region", "heavyEvents.board",
        "jobBoard.read", "news.read", "observer.systemCard", "salvageAnomaly.board"]);
      assert.deepStrictEqual(first.near.map((r) => r.ref), ["sv:salv:b", "pw:hpw:1:1", "ev:eb", "sv:salv:a",
        "ev:ea", "pw:hpw:1:0", "hv:hev:1:0"]);
      assert.deepStrictEqual([first.more.near, first.front.sys, first.news.seq], [0, HOME, 1]);
      g.clock.at += 2000;
      g.names.length = 0;
      g.GetBoard({ characterId: CHAR, systemId: HOME });
      assert.strictEqual(g.names.length, 7, "TTL 0 -> every read again");
      assert.deepStrictEqual(g.dml, [], "zero writes");
    } finally {
      g.stop();
    }
    const cached = rig(opened);
    const off = rig(opened, { EVEJS_LNE_JOB_BOARD_EVENTS_ENABLED: "0", EVEJS_LNE_JOB_BOARD_FRONT_ENABLED: "0",
      EVEJS_LNE_JOB_BOARD_NEWS_ENABLED: "0" });
    try {
      const on = cached.GetBoard({ characterId: CHAR, systemId: HOME });
      cached.clock.at += 2000;
      cached.names.length = 0;
      cached.GetBoard({ characterId: CHAR, systemId: HOME });
      assert.deepStrictEqual([...cached.names].sort(), ["events.board", "heavyEvents.board", "jobBoard.read",
        "salvageAnomaly.board"], "Front and News from the cache");
      off.names.length = 0;
      const plain = off.GetBoard({ characterId: CHAR, systemId: HOME });
      assert.deepStrictEqual(off.names, ["jobBoard.read"]);
      for (const k of ["near", "front", "news"]) assert.ok(!(k in plain), k);
      assert.ok(!("near" in plain.more));
      const { near: _n, front: _f, news: _w, ...rest } = on;
      const { near: _m, ...more } = on.more;
      assert.deepStrictEqual({ ...rest, more, refusals: on.refusals.filter((r) => !/^(nearby|events|heavy|salvage|front|news):/
        .test(r)) }, plain);
    } finally {
      cached.stop();
      off.stop();
    }
  }));

  needsDriver("JN4 Front and News: lines <= frontMaxLines + ASCII; Polish title folded, text <= newsMaxChars; "
    + "NEWS_DISABLED -> no section, NEWS_UNAVAILABLE -> refusal", () => withStore(driver, (opened) => {
    seed(opened.store);
    R.publishEdition(opened.store, { boundaryAt: AT - H, now: AT - H, title: "Żółć w Delve",
      paragraphs: [`Łódź ${"ą".repeat(600)}`], activeSince: AT - H, limit: 10 });
    const g = rig(opened, { EVEJS_LNE_JOB_BOARD_FRONT_MAX_LINES: "2", EVEJS_LNE_JOB_BOARD_NEWS_MAX_CHARS: "100" });
    try {
      const w = g.GetBoard({ characterId: CHAR, systemId: HOME });
      assert.ok(w.front.lines.length >= 1 && w.front.lines.length <= 2, JSON.stringify(w.front));
      assert.ok(w.front.lines.every((l) => /^[\x20-\x7e]*$/.test(l) && l.length <= 96), JSON.stringify(w.front));
      assert.ok(w.front.lines[0].startsWith("LNE front - Jita (The Forge)"), w.front.lines[0]);
      assert.deepStrictEqual([w.news.title, w.news.text.length, w.news.text.slice(0, 7), w.news.ageS],
        ["Zolc w Delve", 100, "Lodz aa", 3600]);
      const sections = (news) => {
        g.ctx.news = news;
        g.clock.at += 61000;
        return g.GetBoard({ characterId: CHAR, systemId: HOME });
      };
      const disabled = sections(createUnavailableNews("NEWS_DISABLED"));
      assert.ok(!("news" in disabled) && !disabled.refusals.some((r) => r.startsWith("news:")), JSON.stringify(disabled));
      const down = sections(createUnavailableNews("NEWS_UNAVAILABLE"));
      assert.ok(!("news" in down) && down.refusals.includes("news:NEWS_UNAVAILABLE"), JSON.stringify(down.refusals));
    } finally {
      g.stop();
    }
  }));

  needsDriver("JN5 world rows (hwa:) on the real facade: anomaly source, an: ref, kind / level / scan / reward; pure "
    + "heavyRowsOf: LP text, title, bit for bit without hwa:", () => withStore(driver, (opened) => {
    run(opened.store, (db) => {
      const ins = db.prepare("INSERT INTO world_heavy_events (event_id, plan_key, event_type, tier, system_id, faction_id, "
        + "beneficiary_faction_id, state, open, members_json, seed, created_at, expires_at, updated_at, variant, affix, "
        + "pocket) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', 1, ?, ?, ?, ?, 'none', 0)");
      ins.run("hwa:2:0", "plan-hwa-20", "muster", 2, NEAR, GURISTAS, null, "PLANNED", AT, AT + H, AT, "warcamp");
      ins.run("hwa:2:1", "plan-hwa-21", "hunt", 1, HOME, GURISTAS, null, "ENGAGED", AT, AT + 2 * H, AT, "hideout");
      ins.run("hwa:2:2", "plan-hwa-22", "muster", 3, NEAR, GURISTAS, 500001, "PLANNED", AT, AT + 3 * H, AT, "staging");
      ins.run("hwa:2:3", "plan-hwa-23", "muster", 1, NEAR, GURISTAS, null, "CLEARED", AT, AT + H, AT, "warcamp");
      ins.run("hwa:2:4", "plan-hwa-24", "muster", 1, FAR, GURISTAS, null, "PLANNED", AT, AT + H, AT, "warcamp");
    });
    const g = rig(opened, { EVEJS_LNE_HEAVY_EVENTS_PAYOUT_ENABLED: "0" });
    try {
      assert.strictEqual(g.config.heavyEvents.payoutEnabled, false);
      g.names.length = 0;
      g.dml.length = 0;
      const r = g.heavy.listBoardRows({ systemIds: new Set([HOME, NEAR]), limit: 10 });
      assert.deepStrictEqual(refs(r), ["an:hwa:2:0", "an:hwa:2:1", "an:hwa:2:2"], "CLEARED / FAR left out");
      assert.deepStrictEqual(r.rows.map((x) => [x.source, x.kind, x.level, x.scan, x.rewardText, x.state, x.title]), [
        ["anomaly", "warcamp", "L5", false, "Faction loot chest", "PLANNED", "Regroup Camp"],
        ["anomaly", "hideout", "L4", true, "Commander loot chest", "ENGAGED", "Hidden Command Post"],
        ["anomaly", "staging", "INCURSION", false, "Loot chest", "PLANNED", "Invasion Staging"]]);
      assert.ok(r.rows.every((x) => x.source !== "power" && x.factionId === GURISTAS));
      assert.deepStrictEqual([g.names, g.dml], [["heavyEvents.board"], []], "one read tx, zero writes");
    } finally {
      g.stop();
    }

    const ev = (eventId, eventType, variant, tier, over = {}) => ({ eventId, eventType, variant, tier, pocket: 0,
      affix: "none", systemId: NEAR, factionId: GURISTAS, beneficiaryFactionId: null, state: "PLANNED",
      expiresAt: AT + H, ...over });
    const base = [ev("hev:9:0", "redoubt", null, 1, { expiresAt: AT + 4 * H }),
      ev("hpw:9:0", "cache", "guard", 1, { expiresAt: AT + 2 * H }), ev("hpw:9:1", "outpost", "brawl", 2)];
    const world = [ev("hwa:9:0", "muster", "staging", 3, { beneficiaryFactionId: 500001 }),
      ev("hwa:9:1", "muster", "staging", 1, { expiresAt: AT + 3 * H })];
    const o = { systemIds: null, limit: 20, factionName: (id) => (id === GURISTAS ? "Guristas Pirates" : null),
      params: configOf().powerSites, worldParams: configOf().eventAnomalies, payoutEnabled: true };
    const mixed = heavyRowsOf([...world, ...base], o);
    const an = mixed.rows.filter((x) => x.ref.startsWith("an:"));
    assert.deepStrictEqual(an.map((x) => [x.ref, x.rewardText, x.title]), [
      ["an:hwa:9:0", "Loot chest + defender LP", "Guristas Pirates Invasion Staging"],
      ["an:hwa:9:1", "Loot chest", "Guristas Pirates Invasion Staging"]]);
    assert.strictEqual(heavyRowsOf(world, { ...o, payoutEnabled: false }).rows[0].rewardText, "Loot chest");
    assert.deepStrictEqual(heavyRowsOf(base, o), { rows: mixed.rows.filter((x) => !x.ref.startsWith("an:")),
      truncated: false });
    for (const kind of W.KINDS) {
      const texts = [WC.META[kind].rewardText, WC.META[kind].payoutRewardText].filter((t) => t !== undefined);
      assert.ok(texts.length >= 1 && texts.every((t) => typeof t === "string" && /^[\x20-\x7e]{1,60}$/.test(t)), kind);
    }
  }));

  test("JN6 board: anomaly mask / level / reward; worst refusal input -> front:, news: and one Nearby refusal kept; "
    + "lib/jobBoard sources ASCII", () => {
    const names = { system: (id) => (NODES[id] ? NODES[id].name : null) };
    const distances = new Map([[HOME, 0], [NEAR, 1]]);
    const nearby = (over) => ({ events: { rows: [
      row("anomaly", "an:hwa:1:0", { kind: "hideout", title: "Hidden Command Post", level: "L4", scan: true,
        rewardText: "Commander loot chest", state: "PLANNED" }),
      row("anomaly", "an:hwa:1:1", { systemId: HOME, kind: "warcamp", title: "Regroup Camp", level: "L5",
        rewardText: "Faction loot chest", state: "PLANNED" })],
    refusals: [], systemIds: new Set([HOME, NEAR]), truncatedSources: 0 }, front: null, news: null, ...over });
    const snap = (over) => buildSnapshot({ now: AT, viewer: { characterId: CHAR, systemId: HOME },
      jobs: { ok: true, jobs: [] }, wars: { ok: true, rows: [] }, jumpsOf: (id) => distances.get(id) ?? null, names,
      limits: { maxJobRows: 5, maxWarRows: 5, maxNearRows: 10, newsMaxChars: 400 }, nearby: nearby({}), ...over });
    const w = toWireV1(snap({}), { pollMs: 0 });
    assert.deepStrictEqual(w.near.map((r) => [r.ref, r.src, r.kind, r.title, r.level, r.reward, r.scan]), [
      ["an:hwa:1:1", "anomaly", "warcamp", "Regroup Camp", "L5", "Faction loot chest", false],
      ["an:hwa:1:0", "anomaly", "signature", "Unknown signature", "", "", true]]);

    const no = (reason) => ({ ok: false, reason });
    const worst = toWireV1(snap({ jobs: no("JOBS_DOWN"), pinsOn: true, pins: no("PINS_DOWN"), done: no("DONE_DOWN"),
      awards: no("AWARDS_DOWN"), wars: no("WARS_DOWN"), nearby: nearby({ events: { rows: [],
        refusals: ["events:TX_FAILED", "heavy:THREW", "salvage:TX_FAILED"], systemIds: new Set([HOME]),
        truncatedSources: 0 }, front: no("FRONT_DOWN"), news: no("NEWS_UNAVAILABLE") }) }), { pollMs: 0 });
    assert.strictEqual(worst.refusals.length, MAX_REFUSALS);
    assert.ok(worst.refusals.includes("front:FRONT_DOWN") && worst.refusals.includes("news:NEWS_UNAVAILABLE"),
      JSON.stringify(worst.refusals));
    assert.ok(worst.refusals.some((r) => /^(nearby|events|heavy|salvage):/.test(r)), JSON.stringify(worst.refusals));

    const dir = path.join(MOD_DIR, "lib", "jobBoard");
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js"))) {
      const bad = [...fs.readFileSync(path.join(dir, f))].findIndex((b) => !(b === 9 || b === 10 || b === 13
        || (b >= 0x20 && b <= 0x7e)));
      assert.strictEqual(bad, -1, `${f}: non-ASCII byte at ${bad}`);
    }
  });
};
