"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { staticLineWith, formatIsk } = require("../../lib/shipAi/persona");
const { TRIGGER_TEXT } = require("../../lib/shipAi/data/triggers");
const { planTriggers, takeTrigger, crimeOf, parseSecThresholds, emptyTriggerState,
  TRIGGER_KINDS_A } = require("../../lib/shipAi/triggers");
const { planProactive, createProactive, PRIORITY, LINE_KINDS } = require("../../lib/shipAi/proactive");
const { parseAiCommand, MUTE_KINDS_CMD } = require("../../lib/shipAi/commands");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const AI = 91000001;
const JITA = 30000142;
const T0 = 1700000000000;
const DAY = 86400000;
const BATCH = ["CRIMINAL", "SUSPECT", "CRIME_CLEAR", "CAP_LOW", "SEC_STATUS_DROP", "DOCK_DAMAGED",
  "MINING_CARGO_FULL", "MINING_CRYSTAL", "SITE_CLEARED", "NAVY_KILL", "NOTABLE_KILL", "BOUNTY_PAID", "ISK_IN",
  "SKILL_QUEUE_EMPTY", "MISSION_OBJECTIVE", "WELCOME_BACK", "WORLD_NEWS", "BATTLE_HERE", "EVENT_HERE"];

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;

function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, minIntervalMs: 0, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function openFile(driver, file, migrations) {
  const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
  assert.ok(o.ok, JSON.stringify(o));
  return o.store;
}

function tx(store, fn) {
  const r = store.transaction("t.triggers", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-triggers-"));
  const stores = [];
  try {
    return fn((driver, name, list) => {
      const s = openFile(driver, path.join(tmp, name), list);
      stores.push(s);
      return s;
    });
  } finally {
    for (const s of stores) {
      try {
        s.close("test_cleanup");
      } catch (_err) {
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

const insertPrefs = (db) => db.prepare(`INSERT INTO ship_ai_prefs (player_character_id, ai_character_id, ai_name,
  language, quiet, portrait_sha, created_at, updated_at, last_proactive_at, version)
  VALUES (?, ?, 'Jin', NULL, 0, NULL, 1000, 1000, NULL, 1)`).run(PLAYER, AI);

const TS = Object.freeze({ triggerPendingMaxAgeMs: 15000, triggerQueueMax: 8, capLowPermille: 150,
  capLowRearmPermille: 400, capLowCooldownMs: 120000, secStatusThresholds: "-2,-5", dockRepairPermille: 900 });
const reading = (r) => ({ inSpace: true, docked: false, warping: false, capacitorPermille: null, crime: null,
  securityStatus: null, dock: null, systemId: JITA, systemName: "Jita", ...(r || {}) });
const flag = (kind, exp) => ({ ok: true, found: true, criminal: kind === "criminal", suspect: kind === "suspect",
  timerExpiresAtMs: exp });
function stepper(settingsOf) {
  let state = null;
  return (r, at, over) => {
    const out = planTriggers(state, reading(r), at, { ...TS, ...(settingsOf || {}), ...(over || {}) });
    const kinds = [...out.state.pending.values()].map((e) => e.kind);
    out.state.pending.clear();
    state = out.state;
    return { kinds, out };
  };
}

module.exports = ({ test, skip }) => {
  test("TRG1 migration ship_ai_triggers keeps an old DOCK row, takes every kind of a-d and muted_kinds JSON only; "
    + "EVENT_KINDS / PRIORITY / MUTE_KINDS; staticLineWith fills or gives \"\", formatIsk", () => {
    for (const k of BATCH) {
      assert.ok(S.EVENT_KINDS.includes(k), k);
      assert.ok(Number.isFinite(PRIORITY[k]), `PRIORITY ${k}`);
    }
    assert.deepStrictEqual([PRIORITY.CRIMINAL, PRIORITY.SUSPECT, PRIORITY.CAP_LOW, PRIORITY.SEC_STATUS_DROP,
      PRIORITY.DOCK_DAMAGED, PRIORITY.CRIME_CLEAR, PRIORITY.REGION_ENTER, PRIORITY.WELCOME_BACK],
    [85, 66, 62, 56, 30, 28, 25, 20]);
    const wantMute = LINE_KINDS.filter((k) => k !== "LOSS_SHIP" && k !== "LOSS_POD" && k !== "HOSTILES"
      && !k.startsWith("HOSTILE_")).sort();
    assert.deepStrictEqual([...S.MUTE_KINDS].sort(), wantMute, "MUTE_KINDS = PRIORITY minus losses / hostiles");
    for (const lang of ["pl", "en"]) {
      for (const k of [...TRIGGER_KINDS_A, "REGION_ENTER"]) {
        assert.ok(TRIGGER_TEXT[lang][k].length >= 2, `${lang} ${k}`);
      }
    }
    assert.strictEqual(staticLineWith("DOCK_DAMAGED", "pl", 0, { layer: "Pancerz", pct: 60 }),
      "Jesteśmy w stacji. Pancerz ma 60 procent, warto naprawić.");
    assert.strictEqual(staticLineWith("DOCK_DAMAGED", "pl", 0, { layer: "", pct: 60 }), "", "empty value = no line");
    assert.strictEqual(staticLineWith("REGION_ENTER", "en", 0, {}), "", "missing value = no line");
    assert.strictEqual(staticLineWith("REGION_ENTER", "pl", 0, { region: "Ve<n>al" }), "Witamy w regionie Ve n al.");
    assert.strictEqual(staticLineWith("SEC_STATUS_DROP", "pl", 0, { threshold: -2.5 }),
      "Status bezpieczeństwa spadł poniżej -2,5. W highsecu będą nas ścigać.");
    assert.ok(staticLineWith("DOCK", "en", 0, null).length > 0, "a STATIC kind passes through");
    assert.strictEqual(staticLineWith("NO_SUCH_KIND", "en", 0, null), "");
    assert.deepStrictEqual([formatIsk(4200000, "pl"), formatIsk(4200000, "en"), formatIsk(12000, "pl"),
      formatIsk(12000, "en"), formatIsk(800, "pl")], ["4,2 mln ISK", "4.2 million ISK", "12 tys. ISK",
      "12 thousand ISK", "800 ISK"]);

    const ddl = /kind\s+TEXT\s+NOT NULL CHECK \(kind IN \(([^)]*)\)\)/.exec(String(S.upShipAiTriggers));
    assert.ok(ddl, "the CHECK of kind in the DDL");
    assert.deepStrictEqual(ddl[1].split(",").map((s) => s.trim().replace(/'/g, "")), [...S.EVENT_KINDS],
      "the CHECK of migration 92 = EVENT_KINDS");
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("TRG1 migration", `better-sqlite3 unavailable (${driver.detail})`);
    const at = MIGRATIONS.findIndex((m) => m.name === "ship_ai_triggers");
    assert.ok(MIGRATIONS[at].version === 92 && MIGRATIONS[at].up === S.upShipAiTriggers, String(at));
    return withTmp((open) => {
      const old = open(driver, "old.sqlite", MIGRATIONS.slice(0, at));
      tx(old, (db) => {
        insertPrefs(db);
        db.prepare(`INSERT INTO ship_ai_events (player_character_id, event_key, kind, payload, occurred_at,
          mentioned_at) VALUES (?, 'dock:1:1', 'DOCK', '{}', 1000, NULL)`).run(PLAYER);
        return true;
      });
      old.close("upgrade");
      const up = open(driver, "old.sqlite", MIGRATIONS);
      const rows = tx(up, (db) => db.prepare("SELECT kind, event_key FROM ship_ai_events").all());
      assert.deepStrictEqual(rows.map((r) => [r.kind, r.event_key]), [["DOCK", "dock:1:1"]]);
      tx(up, (db) => {
        const ins = db.prepare(`INSERT INTO ship_ai_events (player_character_id, event_key, kind, payload,
          occurred_at, mentioned_at) VALUES (?, ?, ?, '{}', 2000, NULL)`);
        for (const k of BATCH) ins.run(PLAYER, `k:${k}`, k);
        return true;
      });
      const n = tx(up, (db) => db.prepare("SELECT COUNT(*) AS n FROM ship_ai_events").get().n);
      assert.strictEqual(Number(n), BATCH.length + 1);
      const setMuted = (value) => tx(up, (db) => {
        try {
          db.prepare("UPDATE ship_ai_prefs SET muted_kinds = ? WHERE player_character_id = ?").run(value, PLAYER);
          return true;
        } catch (_err) {
          return false;
        }
      });
      assert.deepStrictEqual([setMuted("[\"SUSPECT\"]"), setMuted("not-json")], [true, false]);
      const cols = tx(up, (db) => db.prepare("SELECT name FROM pragma_table_info('ship_ai_prefs')").all())
        .map((c) => c.name);
      assert.ok(cols.includes("muted_kinds") && cols.includes("last_seen_at"), cols.join(","));
      return undefined;
    });
  });

  test("TRG2 planTriggers: SUSPECT, (longer: none), CRIMINAL, CRIME_CLEAR; first sight / null silent; CAP_LOW "
    + "hysteresis, warp, cooldown; SEC marks -2 then (same day) none then -5; DOCK_DAMAGED 600 yes / 950 no", () => {
    assert.deepStrictEqual([crimeOf(null, T0), crimeOf({ ok: false }, T0), crimeOf({ ok: true, found: false }, T0),
      crimeOf(flag("suspect", T0 - 1), T0), crimeOf(flag("criminal", T0 + 1), T0)],
    [null, null, "none", "none", "criminal"]);
    assert.deepStrictEqual([parseSecThresholds("-5, -2,-2"), parseSecThresholds(""), parseSecThresholds("1"),
      parseSecThresholds("-2.55"), parseSecThresholds("a")], [[-2, -5], [], null, null, null]);
    const first = planTriggers(null, reading({ crime: null }), T0, TS);
    assert.deepStrictEqual([first.changes, first.state.crime], [0, null], "crime:null = no reading");

    const c = stepper();
    const crime = [
      c({ crime: { ok: true, found: false } }, T0).kinds,
      c({ crime: flag("suspect", T0 + 900000) }, T0 + 5000).kinds,
      c({ crime: flag("suspect", T0 + 1800000) }, T0 + 10000).kinds,
      c({ crime: flag("criminal", T0 + 1800000) }, T0 + 15000).kinds,
      c({ crime: null }, T0 + 20000).kinds,
      c({ crime: flag("criminal", T0 + 1800000) }, T0 + 1800001).kinds,
    ];
    assert.deepStrictEqual(crime, [[], ["SUSPECT"], [], ["CRIMINAL"], [], ["CRIME_CLEAR"]]);
    const seen = planTriggers(null, reading({ crime: flag("criminal", T0 + 9) }), T0, TS);
    assert.deepStrictEqual([seen.changes, seen.state.crime], [0, "criminal"], "first sight of a flag: no line");
    const pend = planTriggers(seen.state, reading({ crime: flag("suspect", T0 + 9) }), T0 + 1, TS);
    assert.strictEqual(pend.changes, 0, "criminal -> suspect: no line");

    const k = stepper();
    const cap = [
      k({ capacitorPermille: 100 }, T0).kinds,
      k({ capacitorPermille: 500 }, T0 + 5000).kinds,
      k({ capacitorPermille: 100 }, T0 + 10000).kinds,
      k({ capacitorPermille: 300 }, T0 + 15000).kinds,
      k({ capacitorPermille: 100 }, T0 + 20000).kinds,
      k({ capacitorPermille: 500 }, T0 + 25000).kinds,
      k({ capacitorPermille: 100, warping: true }, T0 + 30000).kinds,
      k({ capacitorPermille: null }, T0 + 35000).kinds,
    ];
    assert.deepStrictEqual(cap, [[], [], ["CAP_LOW"], [], [], [], [], []]);
    const cool = k({ capacitorPermille: 100 }, T0 + 40000);
    assert.deepStrictEqual([cool.kinds, cool.out.suppressed], [[], 1], "within capLowCooldownMs: suppressed");

    const s = stepper();
    const day = T0 - (T0 % DAY) + 1000;
    const sec = [
      s({ securityStatus: -1 }, day).kinds,
      s({ securityStatus: -2.5 }, day + 5000),
      s({ securityStatus: -1.5 }, day + 10000).kinds,
      s({ securityStatus: -2.5 }, day + 15000),
      s({ securityStatus: -6 }, day + 20000),
    ];
    assert.deepStrictEqual([sec[0], sec[1].kinds, sec[2], sec[3].kinds, sec[3].out.suppressed, sec[4].kinds],
      [[], ["SEC_STATUS_DROP"], [], [], 1, ["SEC_STATUS_DROP"]]);
    const deep = planTriggers({ ...emptyTriggerState(), secStatus: -1 }, reading({ securityStatus: -6 }), day, TS);
    const entry = takeTrigger(deep.state);
    assert.deepStrictEqual([entry.key, entry.values.threshold], [`sec:-50:${Math.floor(day / DAY)}`, -5],
      "the deepest mark");

    const dock = (armor) => planTriggers(null, reading({ inSpace: false, docked: true,
      dock: { armorPermille: armor, structurePermille: 1000 } }), T0, TS);
    const hit = takeTrigger(dock(600).state);
    assert.deepStrictEqual([hit.kind, hit.values.layer, hit.values.pct, hit.priority], ["DOCK_DAMAGED", "armor", 60, 30]);
    assert.strictEqual(dock(950).changes, 0);

    const m = stepper({ muted: new Set(["SUSPECT"]) });
    m({ crime: { ok: true, found: false } }, T0);
    const muted = m({ crime: flag("suspect", T0 + 900000) }, T0 + 5000);
    assert.deepStrictEqual([muted.kinds, muted.out.muted, muted.out.state.crime], [[], 1, "suspect"]);
    const aged = planTriggers(dock(600).state, reading({}), T0 + 15001, TS);
    assert.deepStrictEqual([aged.dropped, aged.state.pending.size], [1, 0], "older than triggerPendingMaxAgeMs");
  });

  test("TRG3 planProactive: CRIMINAL first with LOW_HP and the global limit used; DOCK_DAMAGED replaces DOCK; muted "
    + "kind gone; REGION_ENTER only with regionLineEnabled; a pass delivers CRIMINAL, a SEC row already there none",
  async () => {
    const M = settings();
    const prev = { systemId: JITA, state: "space", stable: "space", regionId: 1, secClass: "highsec" };
    const top = (kind) => ({ kind, priority: PRIORITY[kind], key: `${kind}:1`, values: {}, at: T0 });
    const prefs = (over) => ({ quiet: false, lastProactiveAt: T0, lastByKind: new Map(), ...(over || {}) });
    const crim = planProactive(prev, { ...prev, lowHp: true, triggerTop: top("CRIMINAL") }, prefs(), T0, M);
    assert.deepStrictEqual(crim.map((p) => [p.kind, p.line]), [["CRIMINAL", "trigger"], ["LOW_HP", "static"]]);
    const docked = { ...prev, state: "docked", stable: "docked" };
    const free = prefs({ lastProactiveAt: null });
    assert.ok(planProactive(prev, docked, free, T0, M).some((p) => p.kind === "DOCK"), "DOCK without the trigger");
    const dmg = planProactive(prev, { ...docked, triggerTop: top("DOCK_DAMAGED") }, free, T0, M);
    assert.deepStrictEqual(dmg.map((p) => p.kind), ["DOCK_DAMAGED"]);
    const muted = planProactive(prev, { ...prev, lowHp: true, triggerTop: top("CRIMINAL") },
      prefs({ muted: new Set(["CRIMINAL"]) }), T0, M);
    assert.deepStrictEqual(muted.map((p) => p.kind), ["LOW_HP"]);
    const region = { ...prev, systemId: JITA + 1, regionId: 2, regionName: "Venal" };
    assert.deepStrictEqual(planProactive(prev, region, free, T0, M).map((p) => [p.kind, p.line]),
      [["REGION_ENTER", "model"]]);
    assert.deepStrictEqual(planProactive(prev, region, free, T0, settings({ regionLineEnabled: false })), []);

    let now = T0;
    const delivered = [];
    const notes = [];
    const io = { crime: { ok: true, found: false }, sec: -1, insertSec: false };
    const toolDeps = { telemetry: () => ({ ok: true, docked: false, shipTypeId: 587, armorPermille: 1000,
      structurePermille: 1000, capacitorPermille: 900, warping: false }), typeName: () => "Rifter",
    itemByName: () => ({ ok: true, found: false }), graph: () => null, crimeFlags: () => io.crime,
    securityStatus: () => ({ ok: true, securityStatus: io.sec }) };
    const eventsRepo = { noteEventInTx: (_db, spec) => {
      notes.push(spec.kind);
      return { ok: true, inserted: spec.kind !== "SEC_STATUS_DROP" || io.insertSec };
    }, markMentionedInTx: () => ({ ok: true, changed: 1 }), listPendingPods: () => ({ ok: true, playerIds: [] }) };
    const p = createProactive({ S: settings({ language: "pl", calloutEnabled: false }), maxIdentities: 4,
      store: { transaction: (_n, fn) => ({ ok: true, value: fn({}) }) }, prefsRepo: { setLastProactive: () => ({
        ok: true }) }, eventsRepo, adapter: { readPresence: () => ({ ok: true, characters: [{ characterId: PLAYER,
        name: "P", systemId: JITA, state: "space" }] }) }, seam: null, toolDeps,
      client: { request: () => Promise.resolve({ ok: false, reason: "DISABLED" }) },
      deliver: (_id, lines) => {
        delivered.push(...lines);
        return { room: lines.length, system: 0, failed: 0 };
      }, nameOf: () => "Jin", isWatched: (id) => id === PLAYER, isAllowed: () => true,
      staticIndex: () => new Map([[JITA, { name: "Jita", security: "highsec", region: "The Forge", regionId: 1 }]]),
      snapshot: () => ({ json: "{}", presence: null }), initialPrefs: new Map([[PLAYER, { quiet: false,
        lastProactiveAt: T0 }]]), nowMs: () => now, setTimer: () => ({ cancel() {}, hasRef: () => false }),
      logger: { log() {} } });
    p.start();
    const pass = () => {
      now += 5000;
      p.runPass();
    };
    pass();
    pass();
    assert.deepStrictEqual(delivered, [], "first sight / no change");
    io.crime = flag("criminal", now + 900000);
    pass();
    assert.ok(delivered.length === 1 && TRIGGER_TEXT.pl.CRIMINAL.includes(delivered[0]), JSON.stringify(delivered));
    assert.ok(notes.includes("CRIMINAL"));
    io.sec = -3;
    pass();
    const st = p.getStatus();
    assert.deepStrictEqual([delivered.length, st.counters.triggerDuplicate, st.counters.triggerLines,
      st.triggers.enabled, st.triggers.crime], [1, 1, 1, true, "on"]);
    p.stop();
    await Promise.resolve();
  });

  test("TRG4 vendor facts: getCharacterState exported, reads only; state.criminal / state.suspect assigned "
    + "only in recomputeCharacterPenaltyState; every caller of the penalty functions persists", () => {
    const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const rt = read(path.join("services", "security", "crimewatchRuntimeState.js"));
    assert.ok(/module\.exports = \{[\s\S]*\n {2}getCharacterState,/.test(rt), "getCharacterState exported");
    const from = rt.indexOf("function getCharacterState(");
    const body = rt.slice(from, rt.indexOf("\nfunction ", from + 10));
    assert.ok(from >= 0 && body.includes("database.read(") && !body.includes("database.write(")
      && !body.includes("database.remove("), "getCharacterState reads only");
    const cw = read(path.join("services", "security", "crimewatchState.js"));
    const re = /^(?:async\s+)?function\s+(\w+)\s*\(/gm;
    const starts = [];
    for (let m = re.exec(cw); m; m = re.exec(cw)) starts.push({ name: m[1], at: m.index });
    const fns = starts.map((s, i) => {
      const text = cw.slice(s.at, i + 1 < starts.length ? starts[i + 1].at : cw.length);
      return { name: s.name, body: text.slice(text.indexOf("{")) };
    });
    assert.ok(fns.length > 50, String(fns.length));
    const assigns = fns.filter((f) => /(?<![\w.])state\.(criminal|suspect) =(?!=)/.test(f.body)).map((f) => f.name);
    assert.deepStrictEqual(assigns, ["recomputeCharacterPenaltyState"]);
    const skipNames = ["setNonTheftPenalty", "recomputeCharacterPenaltyState", "normalizeStoredCharacterState"];
    const callers = fns.filter((f) => !skipNames.includes(f.name)
      && /\b(setNonTheftPenalty|recomputeCharacterPenaltyState)\(/.test(f.body));
    assert.ok(callers.length > 0);
    const lost = callers.filter((f) => !/\b(finalizeCharacterStateMutation|persistCharacterState)\(/.test(f.body))
      .map((f) => f.name);
    assert.deepStrictEqual(lost, [], "CRIME_SEAM_STALE: a flag change without a persist");
  });

  test("TRG5 !ai mute parse (never say); setMutedKinds survives a new repository, unmute all = NULL; "
    + "triggersDisabledKinds FOO / LOSS_SHIP rejected, every MUTE_KINDS accepted; bad marks rejected", () => {
    const want = { "!ai mute": { kind: "muteList" }, "!ai unmute": { kind: "muteList" },
      "!ai mute suspect": { kind: "mute", target: "SUSPECT" }, "!ai UNMUTE Cap_Low": { kind: "unmute", target: "CAP_LOW" },
      "!ai unmute all": { kind: "unmute", target: "ALL" } };
    for (const [line, cmd] of Object.entries(want)) {
      const got = parseAiCommand(line);
      assert.deepStrictEqual(got, cmd, line);
      assert.ok(MUTE_KINDS_CMD.includes(got.kind), line);
    }
    const warnsOf = (env) => resolveConfig({ modDir: MOD_DIR, env }).warnings;
    const kindsKey = "EVEJS_LNE_SHIP_AI_TRIGGERS_DISABLED_KINDS";
    for (const bad of ["FOO", ...LINE_KINDS.filter((k) => !S.MUTE_KINDS.includes(k))]) {
      assert.ok(warnsOf({ [kindsKey]: bad }).some((w) => w.startsWith(`${kindsKey}=`)), bad);
    }
    const all = resolveConfig({ modDir: MOD_DIR, env: { [kindsKey]: S.MUTE_KINDS.join(",") } });
    assert.deepStrictEqual(all.warnings.filter((w) => w.startsWith(`${kindsKey}=`)), []);
    assert.strictEqual(all.config.shipAi.triggersDisabledKinds, S.MUTE_KINDS.join(","));
    assert.strictEqual(resolveConfig({ modDir: MOD_DIR, env: { [kindsKey]: "FOO" } }).config.shipAi
      .triggersDisabledKinds, "", "rejected = the default");
    const secKey = "EVEJS_LNE_SHIP_AI_SEC_STATUS_THRESHOLDS";
    for (const bad of ["1", "-2,-5,-6,-7,-8,-9", "-11", "x"]) {
      assert.ok(warnsOf({ [secKey]: bad }).some((w) => w.startsWith(`${secKey}=`)), bad);
    }
    assert.deepStrictEqual(warnsOf({ [secKey]: "-0.5,-9.5" }).filter((w) => w.startsWith(`${secKey}=`)), []);
    const pair = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_CAP_LOW_PERMILLE: "500",
      EVEJS_LNE_SHIP_AI_CAP_LOW_REARM_PERMILLE: "400" } });
    assert.deepStrictEqual([pair.config.shipAi.capLowPermille, pair.config.shipAi.capLowRearmPermille], [150, 400]);
    assert.ok(pair.warnings.some((w) => w.startsWith("shipAi.capLowRearmPermille (400) is not above")));

    const driver = SH.loadDriver();
    if (!driver.ok) return skip("TRG5 muted_kinds", `better-sqlite3 unavailable (${driver.detail})`);
    return withTmp((open) => {
      const store = open(driver, "mute.sqlite", MIGRATIONS);
      tx(store, (db) => insertPrefs(db));
      const repo = createShipAiPrefsRepository();
      const a = tx(store, (db) => repo.setMutedKinds(db, { playerId: PLAYER, kinds: ["SUSPECT"], nowMs: 2000 }));
      assert.ok(a.ok && a.row.version === 2, JSON.stringify(a));
      assert.strictEqual(tx(store, (db) => repo.setMutedKinds(db, { playerId: PLAYER, kinds: ["LOSS_SHIP"],
        nowMs: 2000 })).reason, "INVALID_INPUT");
      store.close("restart");
      const again = open(driver, "mute.sqlite", MIGRATIONS);
      const fresh = createShipAiPrefsRepository();
      assert.deepStrictEqual(tx(again, (db) => fresh.getByPlayer(db, PLAYER)).row.mutedKinds, ["SUSPECT"]);
      const b = tx(again, (db) => fresh.setMutedKinds(db, { playerId: PLAYER, kinds: [], nowMs: 3000 }));
      assert.ok(b.ok && b.row.mutedKinds.length === 0, JSON.stringify(b));
      const raw = tx(again, (db) => db.prepare("SELECT muted_kinds AS m FROM ship_ai_prefs").get().m);
      assert.strictEqual(raw, null, "unmute all = NULL");
      return undefined;
    });
  });
};
