"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { TRIGGER_TEXT } = require("../../lib/shipAi/data/triggers");
const { activityEntryOf, noteActivity, isNotableKill, parseNameList, planTriggers, emptyTriggerState,
  TRIGGER_KINDS_B, markActivitySpoken } = require("../../lib/shipAi/triggers");
const { planProactive, createProactive, PRIORITY } = require("../../lib/shipAi/proactive");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PLAYER = 9001;
const JITA = 30000142;
const SHIP = 990001;
const T0 = 1700000000000;
const MIN = 60000;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const LABELS = new Map([[17736, { name: "Guristas Battleship", cls: "Asteroid Guristas Battleship" }],
  [23707, { name: "Guristas Frigate", cls: "Asteroid Guristas Frigate" }]]);
const names = { label: (id) => LABELS.get(id) || { name: null, cls: null }, faction: () => "Guristas Pirates",
  system: () => "Jita" };

module.exports = ({ test }) => {
  test("TRB5 activityEntryOf / noteActivity: mining cooldown, Guristas Battleship notable, frigate none, navy first, "
    + "muted, parseNameList; the templates of b", () => {
    const M = { ...settings(), notableClasses: parseNameList("Battleship,Dreadnought,Carrier,Titan,Supercarrier"),
      notablePatterns: parseNameList("Commander,Officer,Overseer"), muted: new Set() };
    const cargo = (at) => activityEntryOf({ type: "mining", reason: "cargo", shipId: SHIP, systemId: JITA, atMs: at },
      names, M);
    const e1 = cargo(T0);
    assert.deepStrictEqual([e1.kind, e1.key, e1.values.system, e1.model, e1.priority],
      ["MINING_CARGO_FULL", `mine:cargo:${SHIP}:${Math.floor(T0 / MIN)}`, "Jita", false, 46]);
    const a = noteActivity(emptyTriggerState(), [e1], T0, M);
    a.state.pending.delete(e1.key);
    markActivitySpoken(a.state, e1.kind, T0);
    const b = noteActivity(a.state, [cargo(T0 + MIN)], T0 + MIN, M);
    const c = noteActivity(b.state, [cargo(T0 + M.miningCooldownMs)], T0 + M.miningCooldownMs, M);
    assert.deepStrictEqual([a.queued, b.suppressed, b.queued, c.queued], [1, 1, 0, 1], "cooldown, then again");
    const crystal = activityEntryOf({ type: "mining", reason: "ammo", shipId: SHIP, atMs: T0 }, names, M);
    assert.deepStrictEqual([crystal.kind, noteActivity(a.state, [crystal], T0, M).queued], ["MINING_CRYSTAL", 1],
      "each mining kind has its own clock");

    const kill = (typeId, navy) => activityEntryOf({ type: "kill", victimId: 77, victimTypeId: typeId,
      victimFactionId: 500010, systemId: JITA, navy, atMs: T0 }, names, M);
    const notable = kill(17736, false);
    assert.deepStrictEqual([notable.kind, notable.key, notable.values.name, notable.values.cls, notable.values.faction,
      notable.model], ["NOTABLE_KILL", "kill:77", "Guristas Battleship", "Asteroid Guristas Battleship",
      "Guristas Pirates", true]);
    assert.strictEqual(kill(23707, false), null, "a frigate is not notable");
    const navy = kill(17736, true);
    assert.deepStrictEqual([navy.kind, navy.key, navy.model], ["NAVY_KILL", "navy:77", false], "navy first");
    assert.strictEqual(isNotableKill({ name: "Dire Pithi Commander", cls: "Asteroid Guristas Frigate" }, [],
      ["commander"]), true, "a name pattern");
    assert.strictEqual(isNotableKill({ name: null, cls: "Battleship" }, ["battleship"], []), false, "no name");
    const site = activityEntryOf({ type: "site", instanceId: 4401, siteKind: "anomaly", factionId: 500010,
      atMs: T0 }, names, M);
    assert.deepStrictEqual([site.kind, site.key, site.model, site.values.siteKind], ["SITE_CLEARED", "site:4401", true,
      "anomaly"]);
    assert.strictEqual(activityEntryOf({ type: "site", instanceId: 4401, atMs: T0 }, names,
      { ...M, siteClearedEnabled: false }), null, "flag off");

    const muted = noteActivity(emptyTriggerState(), [notable], T0, { ...M, muted: new Set(["NOTABLE_KILL"]) });
    assert.deepStrictEqual([muted.muted, muted.queued, muted.state.pending.size], [1, 0, 0]);
    assert.deepStrictEqual([parseNameList(""), parseNameList("Ab, b c,ab"), parseNameList("x"),
      parseNameList("ok,b@d")], [null, ["ab", "b c"], null, null]);
    assert.deepStrictEqual(TRIGGER_KINDS_B.map((k) => PRIORITY[k]), [46, 36, 42, 58, 44]);
    for (const lang of ["pl", "en"]) {
      for (const k of TRIGGER_KINDS_B) assert.ok(TRIGGER_TEXT[lang][k].length >= 2, `${lang} ${k}`);
    }
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_NOTABLE_KILL_CLASSES: "Battleship,x" } });
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_SHIP_AI_NOTABLE_KILL_CLASSES")), JSON.stringify(
      bad.warnings));
    assert.strictEqual(bad.config.shipAi.notableKillClasses, "Battleship,Dreadnought,Carrier,Titan,Supercarrier");
  });

  test("TRB7 the pass: cargo line once per cooldown, SITE_CLEARED model + fallback then duplicate silent, NOTABLE_KILL "
    + "template with the name, frigate notableMiss, hook status, uninstall at stop", async () => {
    let now = T0;
    const delivered = [];
    const keys = new Set();
    const requests = [];
    const hooks = {};
    let uninstalled = 0;
    const activity = {
      installMiningHook: (onStop, isWatched) => {
        hooks.mining = onStop;
        hooks.watched = isWatched;
        return { ok: true };
      },
      installSiteHook: (onCleared, _w, scanMax) => {
        hooks.site = onCleared;
        hooks.scanMax = scanMax;
        return { ok: true };
      },
      setKillListener: (l) => {
        hooks.kill = l;
        return { ok: true, wrapMounted: false };
      },
      uninstallAll: () => {
        uninstalled += 1;
        return { ok: true };
      },
      stats: () => ({ mining: { events: 0, consumerErrors: 0 }, site: null }),
    };
    const toolDeps = { telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000,
      structurePermille: 1000, capacitorPermille: 900, warping: false }),
    typeName: (id) => (LABELS.get(id) || {}).name || null,
    itemByName: (name) => {
      const hit = [...LABELS.values()].find((l) => l.name === name);
      return hit ? { ok: true, found: true, item: { groupName: hit.cls } } : { ok: true, found: false };
    }, graph: () => null, crimeFlags: () => ({ ok: true, found: false }),
    securityStatus: () => ({ ok: true, securityStatus: 1 }), factionName: () => "Guristas Pirates" };
    const eventsRepo = { noteEventInTx: (_db, spec) => {
      const fresh = !keys.has(spec.key);
      keys.add(spec.key);
      return { ok: true, inserted: fresh };
    }, markMentionedInTx: () => ({ ok: true, changed: 1 }), listPendingPods: () => ({ ok: true, playerIds: [] }) };
    const p = createProactive({ S: settings({ language: "pl", calloutEnabled: false }), maxIdentities: 4,
      store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
      prefsRepo: { setLastProactive: () => ({ ok: true }) }, eventsRepo,
      adapter: { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "P", systemId: JITA,
        state: "space" }] }) }, seam: { activity }, toolDeps,
      client: { request: (spec) => {
        requests.push(spec);
        return Promise.resolve({ ok: false, reason: "TIMEOUT" });
      } },
      deliver: (_id, lines) => {
        delivered.push(...lines);
        return { room: lines.length, system: 0, failed: 0 };
      }, nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
      staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 1 }]]),
      snapshot: () => ({ json: "{}", presence: null }), initialPrefs: new Map([[PLAYER, { quiet: false,
        lastProactiveAt: null }]]), nowMs: () => now, setTimer: () => ({ cancel() {}, hasRef: () => false }),
      logger: { log() {} } });
    p.start();
    assert.deepStrictEqual([p.getStatus().triggers.mining, p.getStatus().triggers.site, p.getStatus().triggers.kills,
      hooks.scanMax], ["on", "on", "no_wrap", 256]);
    const pass = () => {
      now += 5000;
      p.runPass();
    };
    pass();
    pass();
    assert.deepStrictEqual(delivered, [], "first sight");
    hooks.mining({ type: "mining", characterId: PLAYER, shipId: SHIP, reason: "cargo", systemId: JITA, atMs: 1 });
    pass();
    assert.ok(delivered.length === 1 && TRIGGER_TEXT.pl.MINING_CARGO_FULL.includes(delivered[0]),
      JSON.stringify(delivered));
    hooks.mining({ type: "mining", characterId: PLAYER, shipId: SHIP, reason: "cargo", systemId: JITA, atMs: 1 });
    pass();
    assert.strictEqual(delivered.length, 1, "within miningCooldownMs");

    hooks.site({ type: "site", characterId: PLAYER, instanceId: 4401, systemId: JITA, siteKind: "anomaly",
      siteFamily: "combat", factionId: 500010, atMs: 1 });
    pass();
    assert.strictEqual(requests.length, 1, "SITE_CLEARED within the global limit = a model line");
    await new Promise((r) => setImmediate(r));
    assert.ok(delivered.length === 2 && TRIGGER_TEXT.pl.SITE_CLEARED.includes(delivered[1]), JSON.stringify(delivered));
    hooks.site({ type: "site", characterId: PLAYER, instanceId: 4401, systemId: JITA, atMs: 1 });
    pass();
    assert.strictEqual(delivered.length, 2, "the second call of the instance says nothing");

    hooks.kill.onNpcKill({ characterId: PLAYER, victimId: 77, victimTypeId: 17736, victimFactionId: 500010,
      systemId: JITA, atMs: 1, navy: false });
    hooks.kill.onNpcKill({ characterId: PLAYER, victimId: 78, victimTypeId: 23707, victimFactionId: 500010,
      systemId: JITA, atMs: 1, navy: false });
    pass();
    assert.ok(TRIGGER_TEXT.pl.NOTABLE_KILL.map((t) => t.replace("{name}", "Guristas Battleship"))
      .includes(delivered[2]), JSON.stringify(delivered));
    assert.strictEqual(requests.length, 1, "no global limit: the template at once");
    const st = p.getStatus();
    assert.deepStrictEqual([st.counters.activityFacts, st.counters.activityLines, st.counters.activitySuppressed,
      st.counters.siteDuplicate, st.counters.notableMiss, st.byKind.MINING_CARGO_FULL, st.byKind.SITE_CLEARED,
      st.byKind.NOTABLE_KILL], [6, 3, 1, 1, 1, 1, 1, 1]);
    assert.deepStrictEqual(st.triggers.hooks, { mining: { events: 0, consumerErrors: 0 }, site: null });
    p.stop();
    assert.strictEqual(uninstalled, 1);
    await Promise.resolve();
  });

  test("TRB8 absent row while the timer runs: no CRIME_CLEAR, the second absent read: the line; quiet: "
    + "no trigger read, no fact; no REGION_ENTER without the region name", () => {
    const TS = { ...settings(), muted: new Set() };
    const flagged = { ok: true, found: true, criminal: true, suspect: false, timerExpiresAtMs: T0 + 900000 };
    const absent = { ok: true, found: false };
    const reading = (crime) => ({ inSpace: true, docked: false, warping: false, capacitorPermille: null, crime,
      securityStatus: null, dock: null, systemId: JITA, systemName: "Jita" });
    const s1 = planTriggers(null, reading(flagged), T0, TS);
    const s2 = planTriggers(s1.state, reading(absent), T0 + 5000, TS);
    const s3 = planTriggers(s2.state, reading(absent), T0 + 10000, TS);
    assert.deepStrictEqual([s2.changes, s2.state.crime, s3.changes, [...s3.state.pending.values()][0].kind],
      [0, "criminal", 1, "CRIME_CLEAR"]);
    const back = planTriggers(s2.state, reading(flagged), T0 + 10000, TS);
    assert.deepStrictEqual([back.changes, back.state.crimeMiss], [0, 0], "the row came back: no line");
    const expired = planTriggers(s1.state, reading(absent), T0 + 900001, TS);
    assert.strictEqual(expired.changes, 1, "the timer ran out: the absent row is taken at once");

    let reads = 0;
    const hooks = {};
    const p = createProactive({ S: settings({ calloutEnabled: false }), maxIdentities: 4,
      store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) },
      prefsRepo: { setLastProactive: () => ({ ok: true }) },
      eventsRepo: { noteEventInTx: () => ({ ok: true, inserted: true }), markMentionedInTx: () => ({ ok: true,
        changed: 1 }), listPendingPods: () => ({ ok: true, playerIds: [] }) },
      adapter: { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER, name: "P", systemId: JITA,
        state: "space" }] }) },
      seam: { activity: { installMiningHook: (fn) => {
        hooks.mining = fn;
        return { ok: true };
      }, installSiteHook: () => ({ ok: true }), setKillListener: () => ({ ok: true, wrapMounted: true }),
      uninstallAll: () => ({ ok: true }), stats: () => ({ mining: null, site: null }) } },
      toolDeps: { telemetry: () => ({ ok: true, docked: false, capacitorPermille: 900 }), typeName: () => null,
        itemByName: () => ({ ok: true, found: false }), graph: () => null, crimeFlags: () => {
          reads += 1;
          return { ok: true, found: false };
        }, securityStatus: () => ({ ok: true, securityStatus: 1 }) },
      client: { request: () => Promise.resolve({ ok: false, reason: "DISABLED" }) },
      deliver: () => ({ room: 0, system: 0, failed: 0 }), nameOf: () => "Jin", isWatched: (id) => id === PLAYER,
      isAllowed: () => true, staticIndex: () => new Map(), snapshot: () => ({ json: "{}", presence: null }),
      initialPrefs: new Map([[PLAYER, { quiet: true, lastProactiveAt: null }]]), nowMs: () => T0,
      setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
    p.start();
    p.runPass();
    p.runPass();
    hooks.mining({ characterId: PLAYER, shipId: SHIP, reason: "cargo", systemId: JITA, atMs: 1 });
    const st = p.getStatus();
    assert.deepStrictEqual([reads, st.counters.triggerReads, st.counters.activityFacts, st.triggers.kills], [0, 0, 0,
      "on"]);
    p.stop();

    const M = settings();
    const prev = { systemId: JITA, state: "space", stable: "space", regionId: 1, secClass: "highsec" };
    const free = { quiet: false, lastProactiveAt: null, lastByKind: new Map() };
    const moved = { ...prev, systemId: JITA + 1, regionId: 2 };
    assert.deepStrictEqual(planProactive(prev, { ...moved, regionName: null }, free, T0, M), []);
    assert.deepStrictEqual(planProactive(prev, { ...moved, regionName: "Venal" }, free, T0, M).map((e) => e.kind),
      ["REGION_ENTER"]);
  });
};
