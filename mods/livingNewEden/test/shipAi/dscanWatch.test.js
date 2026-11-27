"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { RANK, PILOTS_KEY, buildCallout } = require("../../lib/shipAi/callout");
const { buildScanReading } = require("../../lib/shipAi/dscan/seen");
const { createDscanWatch } = require("../../lib/shipAi/dscan");
const { createShipAiClient } = require("../../lib/shipAi/client");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { createShipAiEventsRepository } = require("../../lib/shipAi/events");
const { createProactive } = require("../../lib/shipAi/proactive");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const AI = 91000001;
const JITA = 30000142;
const TAMA = 30002813;
const T0 = 1700000000000;
const GURISTAS = 500010;
const SERPENTIS = 500020;
const SHIP = 1000000001;
const NPC_TYPE = 23000;
const CHAR = 90000011;
const FAR = 5e9;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, language: "pl", ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const npcAt = (entityId, distanceMeters, factionId = GURISTAS) => ({ cat: "npc", cls: "frigate", hostile: true,
  entry: { entityId, factionId, distanceMeters, isPlayer: false } });
const pilotAt = (entityId, distanceMeters) => ({ cat: "pilot", cls: "frigate", hostile: true,
  entry: { entityId, characterId: CHAR, distanceMeters, isPlayer: true } });
const ids = (from, n) => Array.from({ length: n }, (_v, i) => from + i);
const names = (id) => ({ [GURISTAS]: "Guristas", [SERPENTIS]: "Serpentis" }[id] || null);
const scanOf = (classified, known, nowMs, systemId = JITA) => ({ systemId, classified, known: known || new Map(),
  nowMs });
const guristasKnown = (count) => new Map([[`f:${GURISTAS}`, { count, rank: RANK.scan }]]);

function rig(store) {
  const M = settings();
  let now = T0;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const transport = { post: () => Promise.resolve({ ok: false, reason: "NET_ERROR" }) };
  const client = createShipAiClient({ S: M, apiKey: "", transport, nowMs: clock.now });
  const npcs = [];
  const delivered = [];
  const toolDeps = {
    telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000, structurePermille: 1000,
      warping: false, entityId: SHIP, position: { x: 0, y: 0, z: 0 } }),
    typeName: (t) => ({ 587: "Rifter", [NPC_TYPE]: "Guristas Scout" }[t] || null),
    itemByName: () => ({ ok: true, found: true, item: { groupName: "Frigate" } }),
    graph: () => null,
    gridNpcs: () => ({ ok: true, truncated: false, npcs: npcs.map((n) => ({ ...n })) }),
    pirates: () => new Set([SERPENTIS, GURISTAS]),
    standing: () => null,
    factionName: (id) => names(id) || "an unknown faction",
    invaderFactions: () => new Set(),
  };
  const adapter = { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "P", systemId: JITA,
    state: "space" }] }) };
  const p = createProactive({ S: M, maxIdentities: 16, store, prefsRepo: createShipAiPrefsRepository(),
    eventsRepo: createShipAiEventsRepository(M), adapter, seam: null, toolDeps, client,
    deliver: (id, lines) => {
      for (const l of lines) delivered.push(l);
      return { room: lines.length, system: 0, failed: 0 };
    },
    nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
    staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 1 }]]),
    snapshot: () => ({ json: "{}", presence: null }),
    initialPrefs: new Map([[PLAYER, { quiet: false, lastProactiveAt: null }]]), nowMs: clock.now,
    setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.deepStrictEqual(p.start(), { ok: true, running: true });
  const gridNpc = (entityId, km) => ({ entityId, typeId: NPC_TYPE, factionId: GURISTAS,
    position: { x: km * 1000, y: 0, z: 0 }, targetId: 0, inWarp: false });
  let seen = null;
  const scanAndPass = (classified, systemId = JITA) => {
    const out = buildScanReading(seen, scanOf(classified, p.calloutGroupsOf(PLAYER, systemId), clock.now(), systemId),
      M, names);
    seen = out.seen;
    p.offerCallout(PLAYER, out.reading);
    clock.advance(5000);
    p.runPass();
    return out;
  };
  return { M, p, clock, npcs, gridNpc, delivered, scanAndPass };
}

function insertPrefs(store) {
  const r = store.transaction("t.prefs", (db) => createShipAiPrefsRepository().insert(db,
    { playerId: PLAYER, aiId: AI, name: "Jin", nowMs: 1000 }));
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
}

function watchRig(over, players, extraDeps) {
  const M = settings({ dscanLoginDelayMs: 0, ...(over || {}) });
  const logs = [];
  let now = T0;
  const presence = players.map((id) => ({ characterId: id, systemId: JITA, state: "space" }));
  const allowed = new Set(players);
  const calls = [];
  const offers = [];
  const timers = [];
  const refuse = new Map();
  const toolDeps = {
    dscan: (playerId, opts) => {
      calls.push({ playerId, at: now, opts });
      if (refuse.has(playerId)) return { ok: false, reason: refuse.get(playerId) };
      return { ok: true, systemId: JITA, rangeMeters: null, truncated: false, own: {},
        entries: ids(playerId * 100, 3).map((entityId) => ({ entityId, typeId: NPC_TYPE, kind: "ship",
          distanceMeters: FAR, isPlayer: false, factionId: GURISTAS })) };
    },
    pirates: () => new Set([GURISTAS]), invaderFactions: () => null, standing: () => null,
    typeClass: () => "frigate", factionName: names,
    ...(extraDeps || {}),
  };
  const w = createDscanWatch({ S: M, toolDeps, logger: { log: (line) => logs.push(line) }, readPresence: () => ({ ok: true, characters: presence }),
    isWatched: () => true, isAllowed: () => true, isDscanAllowed: (id) => allowed.has(id),
    calloutGroupsOf: () => new Map(), offer: (playerId, reading) => {
      offers.push({ playerId, reading });
      return { queued: true };
    }, nowMs: () => now, setTimer: (fn, ms) => {
      timers.push(ms);
      return { cancel() {}, hasRef: () => false };
    } });
  return { M, w, calls, offers, timers, presence, allowed, refuse, logs, at: (ms) => { now = T0 + ms; } };
}

module.exports = ({ test, skip }) => {
  test("DW1 buildScanReading: Guristas x4 on 10 scans = pending only in the 1st, in every reading (known); growth "
    + "to 7 = not covered; an NPC at 100 km out, a pilot at 100 km in; no character ID in the reading", () => {
    const M = settings();
    const four = ids(1, 4).map((id) => npcAt(id, FAR));
    let seen = null;
    let known = new Map();
    const pendingOf = (st) => [...st.objects.values()].filter((o) => o.pending).length;
    for (let i = 0; i < 10; i += 1) {
      const out = buildScanReading(seen, scanOf(four, known, T0 + i * 15000), M, names);
      seen = out.seen;
      assert.deepStrictEqual(out.reading.groups, [{ key: `f:${GURISTAS}`, faction: "Guristas", ships: 4,
        cls: "frigate" }], `scan ${i}`);
      assert.deepStrictEqual([out.newObjects, pendingOf(seen)], i === 0 ? [4, 4] : [0, 0], `scan ${i}`);
      known = guristasKnown(4);
    }
    const seven = [...four, ...ids(11, 3).map((id) => npcAt(id, FAR))];
    const grown = buildScanReading(seen, scanOf(seven, known, T0 + 200000), M, names);
    assert.deepStrictEqual([grown.reading.groups[0].ships, pendingOf(grown.seen)], [7, 3], "growth: not covered");
    const near = buildScanReading(null, scanOf([npcAt(31, 100000), pilotAt(32, 100000)], new Map(), T0), M, names);
    assert.ok(100000 <= M.calloutGridRangeMeters);
    assert.deepStrictEqual(near.reading, { level: "scan", systemId: JITA, groups: [{ key: PILOTS_KEY, faction: null,
      ships: 1, cls: "frigate" }] });
    assert.ok(!JSON.stringify(near.reading).includes(String(CHAR)), "no character ID");
  });

  test("DW2 TTL: gone and back before dscanSeenTtlMs with an empty known = no group; back after it = pending, in the "
    + "reading; dscanSeenMax 16 with 20 objects = the oldest go", () => {
    const M = settings();
    const four = ids(1, 4).map((id) => npcAt(id, FAR));
    let st = buildScanReading(null, scanOf(four, new Map(), T0), M, names).seen;
    st = buildScanReading(st, scanOf(four, guristasKnown(4), T0 + 15000), M, names).seen;
    st = buildScanReading(st, scanOf([], new Map(), T0 + 30000), M, names).seen;
    const early = buildScanReading(st, scanOf(four, new Map(), T0 + 30000 + M.calloutClearMs), M, names);
    assert.ok(30000 + M.calloutClearMs < M.dscanSeenTtlMs);
    assert.deepStrictEqual([early.reading.groups, early.newObjects], [[], 0], "back before the TTL: silence");
    const late = buildScanReading(early.seen, scanOf(four, new Map(), T0 + 30000 + M.calloutClearMs
      + M.dscanSeenTtlMs), M, names);
    assert.deepStrictEqual([late.reading.groups.length, late.newObjects], [1, 4], "back after the TTL: new");

    const small = settings({ dscanSeenMax: 16 });
    const old = buildScanReading(null, scanOf(ids(1, 4).map((id) => npcAt(id, FAR)), new Map(), T0), small, names);
    const more = buildScanReading(old.seen, scanOf(ids(101, 16).map((id) => npcAt(id, FAR)), new Map(), T0 + 1000),
      small, names);
    assert.strictEqual(more.seen.objects.size, 16);
    assert.ok(ids(1, 4).every((id) => !more.seen.objects.has(`e:${id}`)), "the oldest went first");
  });

  test("DW3 proactive + planCallout: 10 scans = 1 'Na skanie' line; then the group in the sector = 'w sektorze'; "
    + "an offer of another system = calloutOfferStale, no line; the grid first = no scan line; pilots only = "
    + "'Na skanie wrogi pilot.' with no 0 and no ID in the row", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("DW3 dscan callout proactive", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStoreAsync(driver, async ({ store }) => {
      insertPrefs(store);
      const r = rig(store);
      r.p.runPass();
      const four = ids(1, 4).map((id) => npcAt(id, FAR));
      for (let i = 0; i < 10; i += 1) r.scanAndPass(four);
      assert.deepStrictEqual(r.delivered, ["Na skanie 4 fregaty Guristas, wrogie."]);
      r.npcs.push(...ids(1, 4).map((id) => r.gridNpc(id, 20)));
      r.clock.advance(r.M.calloutMinGapMs);
      r.p.runPass();
      assert.deepStrictEqual(r.delivered.slice(1), ["Kapitanie, 4 fregaty Guristas w sektorze."], "escalation");
      r.clock.advance(r.M.calloutMinGapMs);
      const offered = buildScanReading(null, scanOf(ids(51, 3).map((id) => npcAt(id, FAR, SERPENTIS)), new Map(),
        r.clock.now(), TAMA), r.M, names);
      r.p.offerCallout(PLAYER, offered.reading);
      r.p.runPass();
      assert.deepStrictEqual([r.delivered.length, r.p.getStatus().counters.calloutOfferStale], [2, 1]);
      r.p.stop();

      const g = rig(store);
      g.npcs.push(...ids(1, 4).map((id) => g.gridNpc(id, 20)));
      g.p.runPass();
      g.clock.advance(5000);
      g.p.runPass();
      assert.deepStrictEqual(g.delivered, ["Kapitanie, 4 fregaty Guristas w sektorze."]);
      g.clock.advance(g.M.calloutMinGapMs);
      for (let i = 0; i < 3; i += 1) g.scanAndPass(four);
      assert.strictEqual(g.delivered.length, 1, `the grid first: no scan line ${JSON.stringify(g.delivered)}`);
      g.p.stop();

      const pl = rig(store);
      pl.clock.advance(120000);
      pl.p.runPass();
      pl.scanAndPass([pilotAt(77, 1e6)]);
      assert.deepStrictEqual(pl.delivered, ["Na skanie wrogi pilot."]);
      assert.strictEqual(buildCallout({ level: "scan", ships: 0, pilots: 2, groups: [], closing: false }, "en", 0,
        { maxChars: pl.M.calloutMaxChars, maxNameChars: pl.M.calloutMaxNameChars }), "On scan: 2 hostile pilots.");
      const rows = store.transaction("t.read", (db) => createShipAiEventsRepository(pl.M).listRecent(db, PLAYER, 20))
        .value.rows.filter((e) => e.kind === "HOSTILES" && e.payload.level === "scan");
      assert.ok(rows.some((e) => e.payload.pilots === 1 && e.payload.ships === 0), JSON.stringify(rows));
      assert.ok(!JSON.stringify(rows).includes(String(CHAR)), "no character ID in the row");
      pl.p.stop();
    });
  });

  test("DW4 schedule: 20 due, dscanScansPerPass 8 = 8 scans + budgetCut 1, the next 8 in the next pass; the next "
    + "scan at now + dscanIntervalMs; ABYSSAL_BLOCKED = dscanRefusedBackoffMs; docked = no dscan; isDscanAllowed "
    + "false = the entry goes", () => {
    const r = watchRig({}, ids(1, 20));
    assert.strictEqual(r.M.dscanScansPerPass, 8);
    r.w.runPass();
    assert.deepStrictEqual([r.calls.length, r.w.getStatus().counters.budgetCut, r.w.getStatus().due], [8, 1, 12]);
    r.at(2500);
    r.w.runPass();
    assert.strictEqual(r.calls.length, 16);
    r.at(5000);
    r.w.runPass();
    assert.strictEqual(r.calls.length, 20);
    assert.ok(r.calls.every((c) => c.opts.rangeMeters === null && c.opts.maxEntries === r.M.dscanMaxEntries));
    r.at(r.M.dscanIntervalMs - 1);
    r.w.runPass();
    assert.strictEqual(r.calls.length, 20, "not due before now + dscanIntervalMs");
    r.at(r.M.dscanIntervalMs);
    r.w.runPass();
    assert.strictEqual(r.calls.length, 28);
    assert.deepStrictEqual([r.offers.length, r.w.getStatus().counters.offered], [28, 28]);
    r.allowed.delete(1);
    r.w.runPass();
    assert.strictEqual(r.w.getStatus().players, 19, "isDscanAllowed false: the entry goes");

    const a = watchRig({}, [5]);
    a.refuse.set(5, "ABYSSAL_BLOCKED");
    a.w.runPass();
    a.at(a.M.dscanIntervalMs);
    a.w.runPass();
    assert.strictEqual(a.calls.length, 1, "abyssal: no scan after dscanIntervalMs");
    a.at(a.M.dscanRefusedBackoffMs);
    a.w.runPass();
    assert.deepStrictEqual([a.calls.length, a.w.getStatus().counters.backoff, a.w.getStatus().counters.failed],
      [2, 2, 0]);

    const dock = watchRig({}, [6]);
    dock.presence[0].state = "docked";
    dock.w.runPass();
    dock.at(dock.M.dscanIntervalMs);
    dock.w.runPass();
    assert.deepStrictEqual([dock.calls.length, dock.w.getStatus().players], [0, 1], "docked: zero dscan");
  });

  test("DW5 membership: dscanMaxPlayers 2 of 3 = 2 entries + playersCapped; offline = entry and memory gone (the "
    + "return is new); dscanAutoEnabled=false = start() arms no poller", () => {
    const r = watchRig({ dscanMaxPlayers: 2 }, [1, 2, 3]);
    r.w.runPass();
    assert.deepStrictEqual([r.w.getStatus().players, r.w.getStatus().counters.playersCapped >= 1], [2, true]);
    const o = watchRig({}, [4]);
    o.w.runPass();
    assert.strictEqual(o.w.getStatus().counters.newObjects, 3);
    o.at(o.M.dscanIntervalMs);
    o.w.runPass();
    assert.strictEqual(o.w.getStatus().counters.newObjects, 3, "known objects: not new");
    const rec = o.presence.pop();
    o.at(o.M.dscanIntervalMs + 2500);
    o.w.runPass();
    assert.strictEqual(o.w.getStatus().players, 0, "offline: the entry goes");
    o.presence.push(rec);
    o.at(o.M.dscanIntervalMs + 5000);
    o.w.runPass();
    assert.strictEqual(o.w.getStatus().counters.newObjects, 6, "the memory went with the entry");

    const off = watchRig({ dscanAutoEnabled: false }, [1]);
    assert.deepStrictEqual([off.w.start(), off.timers.length, off.w.getStatus().state],
      [{ ok: true, running: false }, 0, "off"]);
    const on = watchRig({}, [1]);
    assert.deepStrictEqual([on.w.start(), on.timers, on.w.getStatus().state],
      [{ ok: true, running: true }, [on.M.dscanPollMs], "running"]);
    on.w.stop();
  });

  test("DW6: one standing read per faction per scan (3 entries of one non-pirate "
    + "faction = 1 read); SEAM_FAILED twice = one log line, a good scan then a new failure = a second line", () => {
    let reads = 0;
    const r = watchRig({}, [7], { pirates: () => new Set(), standing: () => {
      reads += 1;
      return -10;
    } });
    r.w.runPass();
    assert.deepStrictEqual([r.calls.length, reads], [1, 1]);
    const f = watchRig({}, [8]);
    f.refuse.set(8, "SEAM_FAILED");
    f.w.runPass();
    f.at(f.M.dscanRefusedBackoffMs);
    f.w.runPass();
    const fails = () => f.logs.filter((l) => l.startsWith("shipAi dscan: seam failed - SEAM_FAILED"));
    assert.deepStrictEqual([f.calls.length, f.w.getStatus().counters.failed, fails().length], [2, 2, 1]);
    f.refuse.delete(8);
    f.at(2 * f.M.dscanRefusedBackoffMs);
    f.w.runPass();
    f.refuse.set(8, "SEAM_FAILED");
    f.at(2 * f.M.dscanRefusedBackoffMs + f.M.dscanIntervalMs);
    f.w.runPass();
    assert.deepStrictEqual([f.calls.length, fails().length], [4, 2]);
  });
};
