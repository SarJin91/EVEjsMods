"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S = require("../../lib/shipAi/schema");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { parseAiCommand, AUTO_KINDS } = require("../../lib/shipAi/commands");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { createShipAiAutostart } = require("../../lib/shipAi/autostart");
const { CATALOG } = require("../../lib/modsHelp/catalog");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const SH = require("../notices/storeHelper");

const PLAYER = 9001;
const AI = 91000001;
const SYSTEM = 30000142;
const AUTO_S = Object.freeze({ autostartEnabled: true, autostartPollMs: 5000, autostartLoginDelayMs: 20000,
  autostartMaxWaitMs: 60000 });

function openFile(driver, file) {
  const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(o.ok, JSON.stringify(o));
  return o.store;
}

function tx(store, fn) {
  const r = store.transaction("t.autostart", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function rig(over = {}) {
  const r = { now: 1000000, online: [{ characterId: PLAYER, name: "Pilot One", systemId: SYSTEM, state: "docked" }],
    prefs: new Map([[PLAYER, { room: true, voice: true }]]), reads: 0, invites: [], links: [], system: [],
    inviteResult: () => ({ ok: true }) };
  r.auto = createShipAiAutostart({ S: over.S || AUTO_S, nowMs: () => r.now,
    readPresence: () => {
      r.reads += 1;
      return { ok: true, characters: r.online, truncated: false };
    },
    prefsOf: (id) => r.prefs.get(id) || null, anyEnabled: () => r.prefs.size > 0, isAllowed: () => true,
    isRunning: () => true,
    invite: (id) => {
      r.invites.push(id);
      return r.inviteResult();
    },
    voiceLink: (id, name) => {
      r.links.push([id, name]);
      return { ok: true, lines: [`link for ${name}`] };
    },
    sendSystem: (id, lines) => {
      r.system.push([id, lines]);
      return { system: lines.length, failed: 0 };
    },
    setTimer: () => ({ cancel: () => {}, hasRef: () => false }) });
  return r;
}

module.exports = ({ test, skip }) => {
  test("AU1 parse !ai auto (status, on, OFF, room / voice on|off, an unknown argument = status), all in AUTO_KINDS; "
    + "HELP PL / EN and the modsHelp details name !ai auto", () => {
    const want = {
      "!ai auto": { kind: "auto" },
      "!ai auto on": { kind: "autoMode", target: "all", on: true },
      "!ai AUTO off": { kind: "autoMode", target: "all", on: false },
      "!ai auto voice off": { kind: "autoMode", target: "voice", on: false },
      "!ai auto room on": { kind: "autoMode", target: "room", on: true },
      "!ai auto bogus": { kind: "auto" },
      "!ai auto room maybe": { kind: "auto" },
    };
    for (const [line, cmd] of Object.entries(want)) {
      const got = parseAiCommand(line);
      assert.deepStrictEqual(got, cmd, line);
      assert.ok(AUTO_KINDS.includes(got.kind), line);
    }
    for (const lang of ["pl", "en"]) {
      assert.ok(STATIC[lang].HELP.join(" ").includes("!ai auto"), `${lang} HELP`);
    }
    const ai = CATALOG.find((e) => e.registryName === "ai");
    assert.ok(ai && ai.details.some((x) => String(x).startsWith("!ai auto")), JSON.stringify(ai && ai.details));
  });

  test("AU2 migration ship_ai_prefs_autostart; setAutostart survives a new store, both off = NULL, no row = "
    + "NOT_FOUND, INVALID_INPUT; a bad JSON in the column reads as null", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("AU2 ship_ai_prefs_autostart", `better-sqlite3 unavailable (${driver.detail})`);
    const at = MIGRATIONS.findIndex((m) => m.name === "ship_ai_prefs_autostart");
    assert.deepStrictEqual([MIGRATIONS[at].version, MIGRATIONS[at - 1].name, MIGRATIONS[at].up],
      [94, "ship_ai_prefs_voice", S.upShipAiPrefsAutostart]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-autostart-"));
    const file = path.join(tmp, "a.sqlite");
    const stores = [];
    const open = () => {
      const s = openFile(driver, file);
      stores.push(s);
      return s;
    };
    try {
      const repo = createShipAiPrefsRepository();
      const first = open();
      assert.ok(tx(first, (db) => repo.insert(db, { playerId: PLAYER, aiId: AI, name: "Jin", nowMs: 1000 })).ok);
      const r0 = tx(first, (db) => repo.getByPlayer(db, PLAYER)).row;
      assert.strictEqual(r0.autostartPrefs, null);
      const a = tx(first, (db) => repo.setAutostart(db, { playerId: PLAYER, prefs: { room: true, voice: false },
        nowMs: 2000 }));
      assert.ok(a.ok && a.row.version === r0.version + 1, JSON.stringify(a));
      assert.deepStrictEqual(a.row.autostartPrefs, { room: true, voice: false });
      first.close("restart");
      const second = open();
      assert.deepStrictEqual(tx(second, (db) => repo.getByPlayer(db, PLAYER)).row.autostartPrefs,
        { room: true, voice: false });
      const off = tx(second, (db) => repo.setAutostart(db, { playerId: PLAYER, prefs: { room: false, voice: false },
        nowMs: 3000 }));
      assert.ok(off.ok && off.row.autostartPrefs === null, JSON.stringify(off));
      const col = () => tx(second, (db) => db.prepare("SELECT autostart_prefs AS v FROM ship_ai_prefs "
        + "WHERE player_character_id = ?").get(PLAYER)).v;
      assert.strictEqual(col(), null);
      assert.strictEqual(tx(second, (db) => repo.setAutostart(db, { playerId: PLAYER + 1,
        prefs: { room: true, voice: true }, nowMs: 4000 })).reason, "NOT_FOUND");
      assert.strictEqual(tx(second, (db) => repo.setAutostart(db, { playerId: PLAYER, prefs: { room: "yes" },
        nowMs: 4000 })).reason, "INVALID_INPUT");
      for (const bad of ['{"room":true,"voice":true,"x":1}', '{"room":1,"voice":true}', "[true]"]) {
        tx(second, (db) => db.prepare("UPDATE ship_ai_prefs SET autostart_prefs = ? WHERE player_character_id = ?")
          .run(bad, PLAYER));
        assert.strictEqual(tx(second, (db) => repo.getByPlayer(db, PLAYER)).row.autostartPrefs, null, bad);
      }
      return undefined;
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
  });

  test("AU3 planner: the first sight waits autostartLoginDelayMs, then one invitation and one system line with the "
    + "voice link; later passes send nothing", () => {
    const r = rig();
    r.auto.runPass();
    r.now += AUTO_S.autostartLoginDelayMs - 1;
    r.auto.runPass();
    assert.deepStrictEqual([r.invites.length, r.system.length], [0, 0]);
    r.now += 1;
    r.auto.runPass();
    assert.deepStrictEqual(r.invites, [PLAYER]);
    assert.deepStrictEqual(r.links, [[PLAYER, "Pilot One"]]);
    assert.deepStrictEqual(r.system, [[PLAYER, ["link for Pilot One"]]]);
    for (let i = 0; i < 3; i += 1) {
      r.now += AUTO_S.autostartPollMs;
      r.auto.runPass();
    }
    assert.deepStrictEqual([r.invites.length, r.system.length], [1, 1]);
    const st = r.auto.getStatus();
    assert.deepStrictEqual([st.tracked, st.counters.invited, st.counters.voiceLinked], [1, 1, 1]);
  });

  test("AU4 NO_CLIENT is retried until autostartMaxWaitMs (then expired, the link anyway); a character gone from the "
    + "presence and back gets the autostart again, one present all the time does not", () => {
    const r = rig();
    r.inviteResult = () => ({ ok: false, reason: "NO_CLIENT" });
    r.auto.runPass();
    r.now += AUTO_S.autostartLoginDelayMs;
    r.auto.runPass();
    r.now += AUTO_S.autostartPollMs;
    r.auto.runPass();
    assert.deepStrictEqual([r.invites.length, r.system.length], [2, 0]);
    r.now = 1000000 + AUTO_S.autostartMaxWaitMs + 1;
    r.auto.runPass();
    assert.deepStrictEqual([r.invites.length, r.system.length], [3, 1]);
    const c = r.auto.getStatus().counters;
    assert.deepStrictEqual([c.noClient, c.expired, c.invited, c.voiceLinked], [2, 1, 0, 1]);
    r.now += AUTO_S.autostartPollMs;
    r.auto.runPass();
    assert.strictEqual(r.invites.length, 3, "present all the time: no second autostart");

    r.inviteResult = () => ({ ok: true });
    const me = r.online;
    r.online = [];
    r.auto.runPass();
    assert.strictEqual(r.auto.getStatus().tracked, 0);
    r.online = me;
    r.auto.runPass();
    r.now += AUTO_S.autostartLoginDelayMs;
    r.auto.runPass();
    assert.deepStrictEqual([r.invites.length, r.system.length], [4, 2]);
  });

  test("AU5 autostartEnabled false or no player with the autostart = zero presence reads, zero invitations; "
    + "start() with the flag off = state off", () => {
    const off = rig({ S: { ...AUTO_S, autostartEnabled: false } });
    off.auto.start();
    for (let i = 0; i < 3; i += 1) {
      off.auto.runPass();
      off.now += AUTO_S.autostartLoginDelayMs;
    }
    assert.deepStrictEqual([off.reads, off.invites.length, off.system.length, off.auto.getStatus().state],
      [0, 0, 0, "off"]);
    const none = rig();
    none.prefs.clear();
    for (let i = 0; i < 3; i += 1) {
      none.auto.runPass();
      none.now += AUTO_S.autostartLoginDelayMs;
    }
    assert.deepStrictEqual([none.reads, none.invites.length, none.system.length], [0, 0, 0]);
    assert.ok(S.shipAiAutostartSettingsOf({ shipAi: AUTO_S }).ok);
    assert.deepStrictEqual(S.shipAiAutostartSettingsOf({ shipAi: { ...AUTO_S, autostartLoginDelayMs: 100000,
      autostartMaxWaitMs: 50000 } }), { ok: false, reason: "INVALID_SETTINGS", detail: "autostartMaxWaitMs" });
  });
};
