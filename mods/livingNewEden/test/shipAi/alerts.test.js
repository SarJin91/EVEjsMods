"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S = require("../../lib/shipAi/schema");
const { STATIC } = require("../../lib/shipAi/data/persona");
const { staticLine } = require("../../lib/shipAi/persona");
const { parseAiCommand, ALERT_KINDS } = require("../../lib/shipAi/commands");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const SH = require("../notices/storeHelper");

const PLAYER = 9001;
const AI = 91000001;

function openFile(driver, file, migrations) {
  const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
  assert.ok(o.ok, JSON.stringify(o));
  return o.store;
}

function tx(store, fn) {
  const r = store.transaction("t.alerts", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  test("AL1 parse !ai alerts / scan (status, on, OFF, an unknown word = status), all in ALERT_KINDS; the 4 static "
    + "lines in PL and EN; HELP PL / EN names !ai alerts and !ai scan", () => {
    const want = {
      "!ai alerts": { kind: "alerts" },
      "!ai alerts on": { kind: "alertsMode", mode: "on" },
      "!ai ALERTS off": { kind: "alertsMode", mode: "off" },
      "!ai alerts maybe": { kind: "alerts" },
      "!ai scan": { kind: "scan" },
      "!ai scan on": { kind: "scanMode", mode: "on" },
      "!ai scan off": { kind: "scanMode", mode: "off" },
      "!ai scan xyz": { kind: "scan" },
    };
    for (const [line, cmd] of Object.entries(want)) {
      const got = parseAiCommand(line);
      assert.deepStrictEqual(got, cmd, line);
      assert.ok(ALERT_KINDS.includes(got.kind), line);
    }
    for (const lang of ["pl", "en"]) {
      for (const kind of ["ALERTS_ON", "ALERTS_OFF", "SCAN_ON", "SCAN_OFF"]) {
        assert.ok(S.STATIC_KINDS.includes(kind), kind);
        const text = staticLine(kind, lang, PLAYER, null);
        assert.ok(text.length > 0 && STATIC[lang][kind].includes(text), `${lang} ${kind}: ${text}`);
        assert.ok(!STATIC[lang].SIGNAL_LOST.includes(text), `${lang} ${kind} is not SIGNAL_LOST`);
      }
      const help = STATIC[lang].HELP.join(" ");
      assert.ok(help.includes("!ai alerts") && help.includes("!ai scan"), `${lang} HELP: ${help}`);
    }
  });

  test("AL2 migration ship_ai_prefs_alerts: an empty store has callout_mode / dscan_mode default 'on'; a store of the "
    + "persona migration with a row reads on / on after the full runner; setCalloutMode / setDscanMode", () => {
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("AL2 ship_ai_prefs_alerts", `better-sqlite3 unavailable (${driver.detail})`);
    const at = MIGRATIONS.findIndex((m) => m.name === "ship_ai_prefs_alerts");
    const persona = MIGRATIONS.findIndex((m) => m.name === "ship_ai_prefs_persona");
    assert.ok(at > persona && persona >= 0 && MIGRATIONS[at].up === S.upShipAiPrefsAlerts, String(at));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-alerts-"));
    const stores = [];
    const open = (name, list) => {
      const s = openFile(driver, path.join(tmp, name), list);
      stores.push(s);
      return s;
    };
    try {
      const fresh = open("fresh.sqlite", MIGRATIONS);
      const cols = tx(fresh, (db) => db.prepare("SELECT name, dflt_value AS d FROM pragma_table_info('ship_ai_prefs')")
        .all()).filter((c) => c.name === "callout_mode" || c.name === "dscan_mode").map((c) => [c.name, c.d]);
      assert.deepStrictEqual(cols, [["callout_mode", "'on'"], ["dscan_mode", "'on'"]]);

      const old = open("old.sqlite", MIGRATIONS.slice(0, persona + 1));
      tx(old, (db) => db.prepare(`INSERT INTO ship_ai_prefs (player_character_id, ai_character_id, ai_name, language,
        quiet, portrait_sha, created_at, updated_at, last_proactive_at, version)
        VALUES (?, ?, 'Jin', NULL, 0, NULL, 1000, 1000, NULL, 1)`).run(PLAYER, AI));
      old.close("upgrade");
      const up = open("old.sqlite", MIGRATIONS);
      const repo = createShipAiPrefsRepository();
      const row = tx(up, (db) => repo.getByPlayer(db, PLAYER)).row;
      assert.deepStrictEqual([row.calloutMode, row.dscanMode], ["on", "on"]);
      const a = tx(up, (db) => repo.setCalloutMode(db, { playerId: PLAYER, mode: "off", nowMs: 2000 }));
      assert.ok(a.ok && a.row.calloutMode === "off" && a.row.dscanMode === "on" && a.row.version === row.version + 1,
        JSON.stringify(a));
      const b = tx(up, (db) => repo.setDscanMode(db, { playerId: PLAYER, mode: "off", nowMs: 3000 }));
      assert.ok(b.ok && b.row.dscanMode === "off" && b.row.version === row.version + 2, JSON.stringify(b));
      assert.strictEqual(tx(up, (db) => repo.setCalloutMode(db, { playerId: PLAYER, mode: "maybe", nowMs: 4000 }))
        .reason, "INVALID_INPUT");
      assert.strictEqual(tx(up, (db) => repo.setDscanMode(db, { playerId: PLAYER + 1, mode: "on", nowMs: 4000 }))
        .reason, "NOT_FOUND");
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
};
