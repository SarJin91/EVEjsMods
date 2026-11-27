"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tool = require("../../tools/measure/heapGrowthReport");

const NOW = 1795000000000;
const H = 3600000;
const D = 86400000;
const SEP = "\u001f";
const PLAYER_ID = 2112000001;
const LNE_CHAR_ID = 95000001;
const SECRET_TITLE = "Tajny tytul HG4";
const SECRET_BODY = "Tresc listu HG4";
const CHAR_NAME = "Zuzanna Testowa HG4";
const ft = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const esc = (s) => String(s).replace(/'/g, "''");

function instance(id, o) {
  return { instanceID: id, templateID: o.templateID || `tpl:${id}`, solarSystemID: o.system || 30000142,
    lifecycleState: o.state, siteOrigin: o.origin, metadata: o.metadata || {},
    runtimeFlags: { universePersistent: o.persistent === true },
    timers: { createdAtMs: o.created, expiresAtMs: o.expires || 0, lastUpdatedAtMs: o.updated || o.created },
    ownership: { characterID: PLAYER_ID }, spawnState: { rocks: { pad: "x".repeat(200) }, small: 1 } };
}

const LNE_MD = (siteKey) => ({ providerID: "livingNewEden", lneSiteKey: siteKey });

const GAMESTORE = {
  dungeonRuntimeState: [
    [`instancesByID${SEP}1`, instance(1, { state: "active", origin: "lne_event", metadata: LNE_MD("lne:s:a"),
      created: NOW - 2 * D, expires: NOW - 1000, updated: NOW - 2 * D })],
    [`instancesByID${SEP}2`, instance(2, { state: "completed", origin: "lne_event", metadata: LNE_MD("lne:s:b"),
      created: NOW - 3 * H, updated: NOW - 2 * H })],
    [`instancesByID${SEP}3`, instance(3, { state: "active", origin: "lne_event", metadata: LNE_MD("lne:s:gone"),
      created: NOW - 10 * D, expires: NOW + D })],
    [`instancesByID${SEP}4`, instance(4, { state: "active", origin: "universe_dungeon", persistent: true,
      system: 30002187, created: NOW - 40 * D, updated: NOW })],
    [`instancesByID${SEP}5`, instance(5, { state: "active", origin: "lne_event", metadata: { providerID: "x" },
      created: NOW - H })],
  ],
  killmails: [
    [`records${SEP}1`, { killTime: ft(NOW - 2 * D), victimCharacterID: null, finalCharacterID: null,
      attackers: [{ characterID: null }, { characterID: null }], items: [{ typeID: 1 }, { typeID: 2 }] }],
    [`records${SEP}2`, { killTime: ft(NOW - H), victimCharacterID: null, finalCharacterID: null,
      attackers: [{ characterID: LNE_CHAR_ID }], items: [] }],
    [`records${SEP}3`, { killTime: ft(NOW - 8 * D), victimCharacterID: PLAYER_ID, finalCharacterID: null,
      attackers: [], items: [{ typeID: 3 }] }],
    [`pending${SEP}4`, { killID: 4 }],
    ["_meta", { nextKillID: 5, terminalEventKillIDs: { "lne:fc:km:x": 2, "self:1": 3 } }],
  ],
  items: [
    [`__evejsInventoryGrantReceipts${SEP}${encodeURIComponent("lne:trade:o1:grant")}`,
      { receiptKey: "lne:trade:o1:grant", completedAtMs: NOW - 3 * D }],
    [`__evejsInventoryGrantReceipts${SEP}${encodeURIComponent(`skinr-app:${PLAYER_ID}:1`)}`,
      { receiptKey: `skinr-app:${PLAYER_ID}:1`, completedAtMs: NOW - H }],
    [`__evejsCareerCombatOutcomes${SEP}1`, { characterID: PLAYER_ID }],
    ["990000001", { itemID: 990000001, ownerID: PLAYER_ID, typeID: 34 }],
  ],
  mail: [
    [`messages${SEP}1`, { senderID: PLAYER_ID, title: SECRET_TITLE, body: SECRET_BODY, sentDate: ft(NOW - D / 2) }],
    [`messages${SEP}2`, { senderID: 1000125, title: SECRET_TITLE, body: SECRET_BODY, sentDate: ft(NOW - 9 * D) }],
    [`messages${SEP}3`, { senderID: LNE_CHAR_ID, title: SECRET_TITLE, body: SECRET_BODY, sentDate: ft(NOW - H) }],
    [`mailboxes${SEP}${PLAYER_ID}`, { characterID: PLAYER_ID }],
  ],
  notifications: [
    [`boxes${SEP}${PLAYER_ID}`, { byID: { 1: { typeID: 5, created: ft(NOW - H), data: SECRET_BODY },
      2: { typeID: 5, created: ft(NOW - 40 * D) } }, order: [1, 2] }],
  ],
  npcEntities: [[`entities${SEP}1`, { entityID: 1 }]],
  npcWrecks: [["wrecks", { 980300000001: { createdAtMs: NOW - 3 * D, expiresAtMs: NOW - D },
    980300000002: { createdAtMs: NOW - H, expiresAtMs: NOW + H } }]],
  characters: [[String(PLAYER_ID), { characterName: CHAR_NAME }]],
};

function seed(driver, dir, wal) {
  const gs = path.join(dir, "gamestore.sqlite");
  const world = path.join(dir, "world.sqlite");
  const src = wal ? path.join(fs.mkdirSync(path.join(dir, "live"), { recursive: true }), "gamestore.sqlite") : gs;
  let db = driver.open(src, { readOnly: false });
  try {
    if (wal) db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    for (const [table, rows] of Object.entries(GAMESTORE)) {
      db.exec(`CREATE TABLE "${table}"(key TEXT PRIMARY KEY, json TEXT NOT NULL)`);
      for (const [k, v] of rows) {
        db.exec(`INSERT INTO "${table}"(key, json) VALUES ('${esc(k)}', '${esc(JSON.stringify(v))}')`);
      }
    }
    if (wal) {
      fs.copyFileSync(src, gs);
      fs.copyFileSync(`${src}-wal`, `${gs}-wal`);
    }
  } finally {
    db.close();
  }
  db = driver.open(world, { readOnly: false });
  try {
    db.exec("CREATE TABLE world_event_sites (site_key TEXT PRIMARY KEY, state TEXT NOT NULL);"
      + "INSERT INTO world_event_sites VALUES ('lne:s:a', 'ACTIVE'), ('lne:s:b', 'CLEANING');"
      + "CREATE TABLE world_free_corp_members (character_id INTEGER PRIMARY KEY);"
      + `INSERT INTO world_free_corp_members VALUES (${LNE_CHAR_ID});`);
  } finally {
    db.close();
  }
  return { gs, world };
}

function runTool(argv, serverDir) {
  const out = [];
  const err = [];
  const deps = { print: (t) => out.push(t), warn: (t) => err.push(t) };
  if (serverDir !== undefined) deps.serverDir = serverDir;
  const code = tool.main(argv, deps);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

function withFixture(fn, wal = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hg-"));
  try {
    const driver = tool.loadDriver(tool.findServerDir(path.resolve(__dirname, "..", "..", "tools", "measure")));
    assert.ok(driver.ok, JSON.stringify(driver));
    const files = seed(driver, dir, wal);
    return fn({ dir, ...files });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

let reportSeq = 0;

function report(f, extra = [], serverDir) {
  reportSeq += 1;
  const json = path.join(f.dir, `r${reportSeq}.json`);
  const r = runTool([f.gs, "--world", f.world, "--json", json, ...extra], serverDir);
  assert.strictEqual(r.code, 0, r.err);
  const text = fs.readFileSync(json, "utf8");
  return { ...r, text, json: JSON.parse(text) };
}

module.exports = ({ test }) => {
  test("HG1 report on a synthetic copy: sections 1-8 + markdown, LNE/vendor classes, killmail and receipt classes, "
    + "WAL copy (file + -wal) unchanged", () => withFixture((f) => {
    const stat = () => [f.gs, `${f.gs}-wal`].map((p) => {
      const s = fs.statSync(p);
      return [s.mtimeMs, s.size];
    });
    const before = stat();
    assert.ok(before[1][1] > 0, "the rows are in the -wal of the copy");
    const r = report(f);
    assert.deepStrictEqual(stat(), before, "no write to the copy or its -wal (no checkpoint)");
    assert.ok(!fs.existsSync(`${f.gs}-journal`), "no journal");
    const j = r.json;
    for (const s of ["meta", "tables", "dungeon", "killmails", "items", "mail", "notifications", "npc"]) {
      assert.ok(j[s], `section ${s}`);
      if (s !== "meta" && s !== "tables") assert.ok(r.out.includes(`## ${s}`), `markdown ${s}`);
    }
    assert.deepStrictEqual([j.meta.now, j.meta.nowSource, j.meta.lneCharacters], [NOW, "dungeon.lastUpdatedAtMs", 1]);
    const d = j.dungeon;
    assert.deepStrictEqual([d.instances, d.lne.instances, d.lne.staleActive, d.lne.terminalOld, d.lne.orphans.noRow,
      d.lne.orphans.purgedRow, d.foreignAlarm, d.persistentSystems], [5, 3, 1, 1, 1, 0, 1, 1]);
    const v = d.buckets["vendor:universe_dungeon|active|persistent"];
    assert.deepStrictEqual([v.count, v.age.gt30d], [1, 1]);
    assert.strictEqual(d.top.length, 5);
    assert.deepStrictEqual(d.top[0].spawnStateTopKeys.map((k) => k.key), ["rocks", "small"]);
    const k = j.killmails;
    assert.deepStrictEqual(Object.keys(k.classes).sort(), ["LNE_CHAR", "NPC_ONLY", "PLAYER"]);
    assert.deepStrictEqual([k.classes.NPC_ONLY.count, k.classes.NPC_ONLY.attackersMax, k.classes.NPC_ONLY.itemsMax,
      k.classes.NPC_ONLY.age.d1to7, k.classes.PLAYER.age.d7to30], [1, 2, 2, 1, 1]);
    assert.deepStrictEqual([k.pending, k.meta.terminalEventKillIDs, k.meta.terminalEventKillIDsLne], [1, 2, 1]);
    const i = j.items;
    assert.deepStrictEqual([i.receipts.classes["lne:trade:"].count, i.receipts.classes.other.count, i.items.rows,
      i.outcomes.__evejsCareerCombatOutcomes.rows], [1, 1, 1, 1]);
    assert.deepStrictEqual(j.mail.senders, { npc: 1, lne: 1, other: 1 });
    assert.deepStrictEqual([j.notifications.boxes, j.notifications.notifications, j.notifications.topTypeIDs],
      [1, 2, [{ typeID: 5, count: 2 }]]);
    assert.deepStrictEqual([j.npc.wrecks.count, j.npc.wrecks.expired], [2, 1]);
    assert.ok(j.missing.includes("npcCargo"), "absent table -> missing, not an error");
    assert.ok(j.tables.byName.dungeonRuntimeState.jsonBytes > 0);
  }, true));

  test("HG2 refusals: path under /var/lib/evejs/ and a missing file -> exit 2; bad argument, --now out of the Date "
    + "range, --json onto an input or its sidecar -> exit 1", () => withFixture((f) => {
    assert.strictEqual(runTool(["/var/lib/evejs/gamestore.sqlite"]).code, 2);
    const missing = runTool([path.join(os.tmpdir(), "lne-hg-none", "gamestore.sqlite")]);
    assert.strictEqual(missing.code, 2);
    assert.ok(missing.err.includes("does not exist"));
    assert.strictEqual(runTool(["--now", "x", "a.sqlite"]).code, 1);
    assert.strictEqual(tool.isLiveVolume("C:\\var\\lib\\evejs\\gamestore.sqlite"), true);
    const badNow = runTool([f.gs, "--now", "9000000000000000"]);
    assert.strictEqual(badNow.code, 1);
    assert.ok(badNow.err.includes("not a valid date") && !badNow.err.includes("    at "), badNow.err);
    const before = fs.statSync(f.gs);
    for (const out of [f.gs, f.world, `${f.gs}-wal`, `${f.world}-shm`, `${f.gs}-journal`]) {
      const r = runTool([f.gs, "--world", f.world, "--json", out]);
      assert.strictEqual(r.code, 1, out);
      assert.ok(r.err.includes("would overwrite the input"), r.err);
    }
    assert.deepStrictEqual([fs.statSync(f.gs).size, fs.statSync(f.gs).mtimeMs], [before.size, before.mtimeMs]);
    assert.strictEqual(tool.outputClash("C:\\Copy\\GameStore.SQLITE-WAL", ["c:\\copy\\gamestore.sqlite"], "win32"),
      "c:\\copy\\gamestore.sqlite-wal");
    assert.strictEqual(tool.outputClash("/c/GameStore.sqlite", ["/c/gamestore.sqlite"], "linux"), null);
  }));

  test("HG3 --diff: perDay = delta / days; b.now <= a.now -> exit 2", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hg-"));
    try {
      const a = { v: 1, meta: { now: NOW, gamestore: "a" }, killmails: { classes: { NPC_ONLY: { bytes: 100, count: 1 } } } };
      const b = { v: 1, meta: { now: NOW + 2 * D, gamestore: "b" },
        killmails: { classes: { NPC_ONLY: { bytes: 300, count: 5 } } } };
      const fa = path.join(dir, "a.json");
      const fb = path.join(dir, "b.json");
      const out = path.join(dir, "d.json");
      fs.writeFileSync(fa, JSON.stringify(a));
      fs.writeFileSync(fb, JSON.stringify(b));
      const r = runTool(["--diff", fa, fb, "--json", out]);
      assert.strictEqual(r.code, 0, r.err);
      const d = JSON.parse(fs.readFileSync(out, "utf8"));
      const row = d.rows.find((x) => x.key === "killmails.classes.NPC_ONLY.bytes");
      assert.deepStrictEqual([d.days, row.a, row.b, row.delta, row.perDay], [2, 100, 300, 200, 100]);
      assert.strictEqual(d.rows.find((x) => x.key === "killmails.classes.NPC_ONLY.count").perDay, 2);
      assert.ok(r.out.includes("killmails.classes.NPC_ONLY.bytes"));
      assert.strictEqual(runTool(["--diff", fb, fa]).code, 2);
      assert.strictEqual(runTool(["--diff", fa, fa]).code, 2);
      const bText = fs.readFileSync(fb, "utf8");
      assert.strictEqual(runTool(["--diff", fa, fb, "--json", fb]).code, 1);
      assert.strictEqual(fs.readFileSync(fb, "utf8"), bText);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("HG4 privacy: no player ID, mail title/body or character name in the JSON or markdown",
    () => withFixture((f) => {
      const r = report(f);
      const stdout = runTool([f.gs, "--world", f.world]);
      assert.strictEqual(stdout.code, 0, stdout.err);
      for (const text of [r.text, r.out, stdout.out]) {
        for (const secret of [String(PLAYER_ID), String(LNE_CHAR_ID), SECRET_TITLE, SECRET_BODY, CHAR_NAME]) {
          assert.ok(!text.includes(secret), `leaked ${secret}`);
        }
      }
    }));

  test("HG5 node:sqlite fallback (no server dir) gives the same sections as the server driver", () => withFixture((f) => {
    const a = report(f).json;
    const b = report(f, [], null).json;
    assert.strictEqual(b.meta.driver, "node:sqlite");
    for (const s of ["tables", "dungeon", "killmails", "items", "mail", "notifications", "npc", "missing"]) {
      assert.deepStrictEqual(b[s], a[s], s);
    }
  }));
};
