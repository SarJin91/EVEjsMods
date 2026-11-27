"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { SCHEMA, MODULE_NAMES } = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { readVendorKillsFrom, filetimeToMs } = require("../../lib/adapter/vendorKills");
const { readPlayerOrgNamesFrom, readCharacterNamesFrom } = require("../../lib/adapter/playerOrgNames");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { classifyKill, planKill } = require("../../lib/killboard/killPlan");
const { createKillboardRepository } = require("../../lib/killboard/repository");
const { createKillProjector } = require("../../lib/killboard/killProjector");
const { startKillboard } = require("../../lib/killboard");
const { createViewRegistry } = require("../../lib/observer/views");
const { createRouter } = require("../../lib/observer/router");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const NOW = 1800000000000;
const DAY = 86400000;
const SYS_A = 30000142;
const SYS_B = 30000144;
const LNE_CORP = 98500001;

const KB_DEFAULTS = Object.freeze(Object.fromEntries(SCHEMA.filter((r) => r.key.startsWith("killboard."))
  .map((r) => [r.key.slice("killboard.".length), r.default])));

const filetime = (ms) => String((BigInt(ms) + 11644473600000n) * 10000n);
const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

function rec(killID, over = {}) {
  return { killID, killTime: filetime(over.at === undefined ? NOW - DAY : over.at), solarSystemID: over.system || SYS_A,
    victimCharacterID: over.victim === undefined ? 90000001 : over.victim,
    victimCorporationID: over.corp === undefined ? 98000001 : over.corp, victimAllianceID: over.alliance || null,
    victimFactionID: null, victimShipTypeID: over.ship || 587,
    finalCharacterID: over.final === undefined ? 90000002 : over.final, finalCorporationID: 98000002,
    iskLost: over.isk === undefined ? 1500000.4 : over.isk,
    attackers: over.attackers || [
      { characterID: 90000002, corporationID: 98000002, allianceID: 99000001, factionID: null, shipTypeID: 621,
        damageDone: 800.6 },
      { characterID: 90000003, corporationID: 98000002, allianceID: null, factionID: null, shipTypeID: 587,
        damageDone: 100 }], items: [] };
}

function fakeKm(records, pending = [], reservedAt = new Map()) {
  const km = { records: new Map(records.map((r) => [r.killID, r])), pending: new Set(pending), calls: 0, reservedAt,
    getKillmailRecord(k) {
      km.calls += 1;
      const r = km.records.get(Number(k));
      return r ? JSON.parse(JSON.stringify(r)) : null;
    },
    listPendingKillmailEvents() {
      km.calls += 1;
      return [...km.pending].sort((a, b) => a - b).map((killID) => ({ killID,
        reservedAt: filetime(km.reservedAt.has(killID) ? km.reservedAt.get(killID) : NOW), record: {} }));
    },
    getAllKillmailRecords() { throw new Error("full clone forbidden"); },
    listKillmailsForCharacter() { throw new Error("index read forbidden"); },
    listKillmailsForCorporation() { throw new Error("index read forbidden"); },
    ensureKillmailIndexes() { throw new Error("index build forbidden"); } };
  return km;
}

const spec = (over = {}) => ({ afterKillId: 0, limit: 50, holeLookahead: 16, minAgeMs: 10000, nowMs: NOW,
  maxAttackers: 10, cursorKind: "", ...over });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const opened = openStore({ filePath: ":memory:", openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
  assert.ok(opened.ok, JSON.stringify(opened));
  const store = opened.store;
  const tx = (f) => {
    const r = store.transaction("test", f);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const all = (sql) => tx((db) => db.prepare(sql).all());
  try {
    return fn({ store, tx, all });
  } finally {
    store.close();
  }
}

const CHAR_NAMES = { 90000001: "Alice Pilot", 90000002: "Bob Hunter" };
const fakeCharacterState = { peekCharacterRecord: (id) => (CHAR_NAMES[id] ? { characterName: CHAR_NAMES[id] } : null) };
const fakeCorporationState = { getCorporationRecord: (id) => (id === 98000001 ? { corporationName: "Corp One" } : null),
  getAllianceRecord: (id) => (id === 99000001 ? { allianceName: "Alliance One" } : null) };
function itemFacts(ids) {
  const byId = { 587: ["Rifter", 400000], 621: ["Caracal", 9000000] };
  const facts = new Map();
  const missing = [];
  for (const id of ids) {
    if (byId[id]) facts.set(id, { typeId: id, name: byId[id][0], volume: null, portionSize: null, basePrice: byId[id][1] });
    else missing.push(id);
  }
  return { ok: true, facts, missing };
}

function adapterOver(km, extra = {}) {
  return { killboardSeams: () => ({ ok: true, missing: [] }),
    readVendorKillsAfter: (s) => readVendorKillsFrom(km, s),
    readCharacterNames: extra.readCharacterNames || ((ids) => readCharacterNamesFrom(fakeCharacterState, ids)),
    readPlayerOrgNames: extra.readPlayerOrgNames || ((s) => readPlayerOrgNamesFrom(fakeCorporationState, s)),
    readItemTypeFacts: extra.readItemTypeFacts || itemFacts,
    readFactionNames: () => ({ ok: true, names: new Map() }) };
}

function projectorOn(h, km, extra = {}) {
  const metrics = [];
  const logs = [];
  const gov = { admit: true };
  const a = adapterOver(km, extra);
  const p = createKillProjector({ store: h.store, repo: createKillboardRepository(),
    P: { ...KB_DEFAULTS, enabled: true, killmailsEnabled: true, ...(extra.P || {}) }, rowsCap: extra.rowsCap || 500,
    clock: extra.clock || { now: () => NOW }, getGovernor: () => ({ admits: () => gov.admit }),
    killboardSeams: a.killboardSeams, readVendorKillsAfter: a.readVendorKillsAfter,
    readCharacterNames: a.readCharacterNames, readPlayerOrgNames: a.readPlayerOrgNames,
    readItemTypeFacts: a.readItemTypeFacts, isLneNpcCorporation: (id) => id === LNE_CORP,
    count: (n, v) => metrics.push([n, v === undefined ? 1 : v]), gauge: () => {}, onWrite: () => {},
    log: (l) => logs.push(l) });
  return { p, metrics, gov, logs };
}

module.exports = ({ test, skip }) => {
  test("KB17 client: kill routes, roleLabel, formatAgo, killsUnavailableText of a 404 VIEW_NOT_FOUND", () => {
    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "killboard.js"), "utf8"), sandbox,
      { filename: "killboard.js" });
    const pure = sandbox.window.LneKillboard._pure;
    const ph = (h) => JSON.parse(JSON.stringify(pure.parseHash(h)));
    const home = { page: "battles", params: {} };
    assert.deepStrictEqual(ph("#/kills"), { page: "kills", params: {} });
    assert.deepStrictEqual(ph("#/kills?system=30000142&before=9&x=1"),
      { page: "kills", params: { system: 30000142, before: 9 } });
    assert.deepStrictEqual(ph("#/kill/7"), { page: "kill", params: { kill: 7 } });
    assert.deepStrictEqual(ph("#/character/90000001?before=3"),
      { page: "character", params: { character: 90000001, before: 3 } });
    for (const h of ["#/kill", "#/kill/x", "#/kill/1/2", "#/character", "#/kills/3"]) assert.deepStrictEqual(ph(h), home, h);
    assert.strictEqual(pure.formatHash("kills", { system: 5, before: 2 }), "#/kills?system=5&before=2");
    assert.strictEqual(pure.formatHash("kill", { kill: 7 }), "#/kill/7");
    assert.deepStrictEqual(ph(pure.formatHash("character", { character: 9, before: 4 })),
      { page: "character", params: { character: 9, before: 4 } });
    assert.strictEqual(pure.buildViewUrl("kills", { system: 5 }), "/api/views/kb-kills?system=5");
    assert.strictEqual(pure.buildViewUrl("kill", { kill: 7 }), "/api/views/kb-kill?kill=7");
    assert.strictEqual(pure.buildViewUrl("character", { character: 9, before: 4 }),
      "/api/views/kb-character?character=9&before=4");
    assert.strictEqual(pure.buildViewUrl("kill", {}), null);
    assert.deepStrictEqual(["V", "A", "F", "X", null].map(pure.roleLabel),
      ["Victim", "Attacker", "Final blow", "—", "—"]);
    assert.deepStrictEqual([pure.formatAgo(NOW - 30000, NOW), pure.formatAgo(NOW - 3 * 3600000, NOW),
      pure.formatAgo(null, NOW)], ["30 s ago", "3 h ago", "—"]);
    const res = (status, reason) => ({ status, body: { error: { reason } } });
    assert.strictEqual(pure.killsUnavailableText(res(404, "VIEW_NOT_FOUND")), "killboard.killmailsEnabled = off");
    for (const r of [res(404, "OTHER"), res(200, "VIEW_NOT_FOUND"), { status: 404, body: null }, null]) {
      assert.strictEqual(pure.killsUnavailableText(r), null);
    }
  });

  test("KB10 readVendorKillsFrom: holes, PENDING / YOUNG / REWOUND / END, bad time, no full read; vendor facts; "
    + "GAME_MODULES; adapter facade", () => {
    const km = fakeKm([rec(1), rec(2), rec(4), rec(7)], [6]);
    const r = readVendorKillsFrom(km, spec());
    assert.deepStrictEqual([r.ok, r.kills.map((k) => k.killId), r.cursor, r.cursorKind, r.stop, r.holes, r.bad,
      r.examined], [true, [1, 2, 4], 5, "H", "PENDING", 2, 0, 6], "holes 3 and 5 skipped, stop on the pending 6");
    const f = r.kills[0];
    assert.deepStrictEqual(f, { killId: 1, killAtMs: NOW - DAY, systemId: SYS_A,
      victim: { characterId: 90000001, corporationId: 98000001, allianceId: null, factionId: null, shipTypeId: 587 },
      iskLost: 1500000.4, finalCharacterId: 90000002, finalCorporationId: 98000002, attackerCount: 2,
      attackers: [{ characterId: 90000002, corporationId: 98000002, allianceId: 99000001, factionId: null,
        shipTypeId: 621, damageDone: 801 }, { characterId: 90000003, corporationId: 98000002, allianceId: null,
        factionId: null, shipTypeId: 587, damageDone: 100 }], attackerCharacterIds: [90000002, 90000003] });
    km.pending.delete(6);
    const after = readVendorKillsFrom(km, spec({ afterKillId: 5, cursorKind: "H" }));
    assert.deepStrictEqual([after.kills.map((k) => k.killId), after.cursor, after.stop, after.holes], [[7], 7, "END", 1]);
    assert.strictEqual(readVendorKillsFrom(km, spec({ afterKillId: 7, cursorKind: "R" })).stop, "END");
    assert.deepStrictEqual(readVendorKillsFrom(km, spec({ afterKillId: 2, cursorKind: "R", limit: 1 })),
      { ok: true, kills: [], cursor: 3, cursorKind: "H", stop: "LIMIT", holes: 1, bad: 0, examined: 1, stalePending: 0,
        pendingAgeMs: null });
    const young = fakeKm([rec(1), rec(2, { at: NOW - 1000 })]);
    assert.deepStrictEqual(readVendorKillsFrom(young, spec()).stop, "YOUNG");
    assert.strictEqual(readVendorKillsFrom(young, spec()).cursor, 1);
    assert.strictEqual(readVendorKillsFrom(fakeKm([]), spec({ afterKillId: 4, cursorKind: "R" })).stop, "REWOUND");
    assert.strictEqual(readVendorKillsFrom(fakeKm([]), spec({ afterKillId: 4, cursorKind: "H" })).stop, "END");
    assert.strictEqual(readVendorKillsFrom(fakeKm([], [4]), spec({ afterKillId: 4, cursorKind: "R" })).stop, "END");
    const bad = readVendorKillsFrom(fakeKm([{ ...rec(1), killTime: "x" }, rec(2)]), spec());
    assert.deepStrictEqual([bad.bad, bad.kills.map((k) => k.killId), bad.cursor], [1, [2], 2]);
    assert.strictEqual(readVendorKillsFrom(km, spec({ limit: 0 })).reason, "INVALID_INPUT");
    assert.strictEqual(readVendorKillsFrom(km, spec({ cursorKind: "X" })).reason, "INVALID_INPUT");
    assert.strictEqual(readVendorKillsFrom(null, spec()).reason, "SEAM_UNAVAILABLE");
    const thrower = { getKillmailRecord() { throw new Error("disk"); }, listPendingKillmailEvents: () => [] };
    assert.strictEqual(readVendorKillsFrom(thrower, spec()).reason, "VENDOR_THROW");
    assert.deepStrictEqual([filetimeToMs(filetime(NOW)), filetimeToMs("1"), filetimeToMs(5)], [NOW, null, null]);

    const ks = readSource("services/killmail/killmailState.js");
    const body = (src, head, n) => src.slice(src.indexOf(head), src.indexOf(head) + n);
    const get = body(ks, "\nfunction getKillmailRecord(killID) {", 500);
    assert.ok(get.includes("killmailTableCache || readKillmailTableView()"), "getKillmailRecord reads the table view");
    assert.ok(!get.includes("ensureKillmailIndexes") && get.includes("cloneValue(record)"), "one record, no index");
    assert.ok(body(ks, "\nfunction listPendingKillmailEvents() {", 600).includes("table.pending"));
    assert.ok(body(ks, "\nfunction reserveKillmailID() {", 400).includes("table._meta.nextKillID = killID + 1"));
    assert.ok(body(ks, "\nfunction reserveKillmailEvent(record = {}) {", 700)
      .includes("reservedAt: currentFileTime().toString(),"), "pending reservedAt");
    const exportsText = ks.slice(ks.search(/^module\.exports = \{/m));
    for (const n of ["getKillmailRecord", "listPendingKillmailEvents"]) {
      assert.match(exportsText, new RegExp(`^ {2}${n},$`, "m"), n);
    }
    const prep = readSource("services/killmail/killmailPreparationTasks.js");
    assert.ok(prep.includes("const PLAYER_OWNER_MIN_ID = 2000000;"), "PLAYER_OWNER_MIN_ID");
    assert.ok(prep.includes("function isOwnerKillLogVictim(record) {"));
    for (const field of ["killTime: normalizeFiletimeString(", "solarSystemID:", "victimCharacterID:",
      "victimShipTypeID:", "finalCharacterID:", "iskLost: normalizeNumber(", "attackers: normalizedAttackers,",
      "characterID: normalizePositiveInteger(entry.characterID", "damageDone:"]) {
      assert.ok(prep.includes(field), field);
    }
    const cs = readSource("services/character/characterState.js");
    assert.ok(body(cs, "\nfunction peekCharacterRecord(charId) {", 200).includes("ensureMigrated();"));
    assert.ok(cs.includes("charData.characterName"), "record field characterName");
    assert.ok(body(readSource("services/inventory/itemStore.js"), "\nfunction ensureMigrated() {", 120)
      .includes("if (migrationComplete) {"), "ensureMigrated is a flag check after the first call");

    const syms = (p) => GAME_MODULES.find((e) => e.path === p).symbols;
    for (const n of ["getKillmailRecord", "listPendingKillmailEvents"]) {
      const s = syms("services/killmail/killmailState").find((x) => x.name === n);
      assert.ok(s && s.kind === "export" && s.wrap !== true && s.firstLoad !== true, n);
      assert.deepStrictEqual([...s.consumers], ["killboard.vendorKills"]);
    }
    assert.ok(syms("services/character/characterState").some((s) => s.name === "peekCharacterRecord"
      && s.consumers.includes("killboard.names")));
    for (const n of ["getCorporationRecord", "getAllianceRecord"]) {
      assert.ok(syms("services/corporation/corporationState").find((s) => s.name === n).consumers
        .includes("killboard.names"), n);
    }
    assert.ok(!MODULE_NAMES.includes("killboard.vendorKills") && !MODULE_NAMES.includes("killboard.names"));

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    for (const n of ["readVendorKillsAfter", "killboardSeams", "readCharacterNames"]) {
      assert.strictEqual(typeof blind[n], "function", n);
    }
    assert.deepStrictEqual(blind.killboardSeams(), { ok: true, missing: [] });
    assert.strictEqual(blind.readVendorKillsAfter(spec()).reason, "SEAM_UNAVAILABLE");
    const names = blind.readCharacterNames([90000001]);
    assert.deepStrictEqual([names.ok, names.names.get(90000001)], [true, null]);
    assert.strictEqual(blind.readCharacterNames(Array.from({ length: 65 }, (_, i) => i + 1)).reason, "INVALID_INPUT");
    assert.strictEqual(blind.readPlayerOrgNames({ corpIds: [1] }, "nope").reason, "INVALID_INPUT");
    assert.strictEqual(blind.readPlayerOrgNames({ corpIds: [1] }, "killboard.names").corps.get(1), null);
  });

  test("KB11 classifyKill / planKill: capsuleer, player structure, LNE NPC, NPC on / off, backfill, deltas", () => {
    const fact = (over) => readVendorKillsFrom(fakeKm([rec(1, over)]), spec()).kills[0];
    const opts = { nowMs: NOW, killBackfillMs: 30 * DAY, includeNpcVictims: false,
      isLneNpcCorporation: (id) => id === LNE_CORP };
    assert.deepStrictEqual(classifyKill(fact({}), opts), { decision: "ACCEPT", cls: "PVP" }, "capsuleer");
    assert.deepStrictEqual(classifyKill(fact({ victim: null, corp: 98000005 }), opts),
      { decision: "ACCEPT", cls: "PVP" }, "player structure: corp >= 2 000 000");
    assert.deepStrictEqual(classifyKill(fact({ victim: null, corp: LNE_CORP }), opts), { decision: "SKIP_LNE_NPC" });
    assert.deepStrictEqual(classifyKill(fact({ victim: null, corp: 1000125 }), opts), { decision: "SKIP_NPC" });
    assert.deepStrictEqual(classifyKill(fact({ victim: null, corp: 1000125 }), { ...opts, includeNpcVictims: true }),
      { decision: "ACCEPT", cls: "PVE" });
    assert.deepStrictEqual(classifyKill(fact({ victim: null, corp: 1000125, final: null, attackers: [
      { characterID: null, corporationID: 1000127 }] }), { ...opts, includeNpcVictims: true }),
    { decision: "SKIP_NPC" }, "an NPC victim of NPCs never enters");
    assert.deepStrictEqual(classifyKill(fact({ at: NOW - 31 * DAY }), opts), { decision: "SKIP_OLD" });
    assert.deepStrictEqual(classifyKill(fact({ at: NOW - 31 * DAY }), { ...opts, killBackfillMs: 0 }),
      { decision: "ACCEPT", cls: "PVP" }, "killBackfillMs 0 = the whole history");

    const plan = planKill(fact({}), { cls: "PVP", maxAttackers: 1 });
    assert.strictEqual(plan.ok, true);
    assert.deepStrictEqual([plan.row.iskLost, plan.row.attackerCount, JSON.parse(plan.row.attackersJson)],
      [1500000, 2, [[90000002, 98000002, 99000001, null, 621, 801]]], "rounded ISK, maxAttackers stored, count whole");
    assert.deepStrictEqual(plan.chars, [{ characterId: 90000001, role: "V" }, { characterId: 90000002, role: "F" },
      { characterId: 90000003, role: "A" }]);
    assert.deepStrictEqual(plan.deltas.map((d) => [d.characterId, d.kills, d.losses, d.iskKilled, d.iskLost]),
      [[90000001, 0, 1, 0, 1500000], [90000002, 1, 0, 1500000, 0], [90000003, 1, 0, 1500000, 0]]);
    assert.deepStrictEqual(plan.names, { char: [90000001, 90000002, 90000003], corp: [98000001, 98000002],
      alliance: [99000001] });
    assert.deepStrictEqual(plan.typeIds, [587, 621]);
    const self = planKill(fact({ attackers: [{ characterID: 90000001, corporationID: 98000001 },
      { characterID: 90000003 }, { characterID: 90000003 }], final: 90000001 }), { cls: "PVP", maxAttackers: 10 });
    assert.deepStrictEqual(self.chars, [{ characterId: 90000001, role: "V" }, { characterId: 90000003, role: "A" }]);
    assert.deepStrictEqual(self.deltas.map((d) => [d.characterId, d.kills, d.losses]), [[90000001, 0, 1],
      [90000003, 1, 0]]);
    const structure = planKill(fact({ victim: null, corp: 98000005 }), { cls: "PVP", maxAttackers: 10 });
    assert.deepStrictEqual(structure.chars.map((c) => c.role), ["F", "A"], "no victim character row");
    assert.strictEqual(planKill(fact({}), { cls: "X" }).reason, "PLAN_INVALID");
  });

  const driver = loadDriver();
  const k12 = "KB12 kill projector: frozen names, idempotent pass / restart / replay, rowsCap, moving clock, PENDING "
    + "backoff, VENDOR_REWOUND = 0 vendor reads";
  const k13 = "KB13 views kb-kills (system, before) / kb-kill / kb-character, GOVERNOR_HOLD, killmailsEnabled off";
  const k14 = "KB14 resetKills: VENDOR_REWOUND -> RESETTING in row-budget steps (restart-safe, 0 vendor reads) "
    + "-> the kill tables and the cursor gone -> a new base from killID 1 counted once; small tables = one tx";
  const k15 = "KB15 pendingMaxAgeMs: a stale pending with a record after it is skipped (counter, log), a young "
    + "one stops with pendingStopAgeMs";
  const k16 = "KB16: kb-battle capsuleerKills (window +- slack, other system, limit) and kb-kill battles "
    + "(two battles, one covers, relatedScanRows trims)";
  if (!driver.ok) {
    for (const k of [k12, k13, k14, k15, k16]) skip(k, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test(k12, () => {
    assert.strictEqual(MIGRATIONS[99].version, 100);
    assert.strictEqual(MIGRATIONS[99].name, "killboard_kills");
    withStore(driver, (h) => {
      const records = [rec(1), rec(2, { victim: null, corp: 1000125 }), rec(3, { victim: null, corp: LNE_CORP }),
        rec(4, { victim: null, corp: 98000005, isk: 2000000, attackers: [{ characterID: 90000002 }] }),
        rec(5, { at: NOW - 31 * DAY })];
      const km = fakeKm(records);
      const pr = projectorOn(h, km);
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 2, deferred: null, stop: "END" });
      assert.deepStrictEqual(h.all("SELECT kill_id, victim_character_id, victim_corporation_id, isk_lost, class, "
        + "attacker_count FROM kb_kills ORDER BY kill_id"), [
        { kill_id: 1, victim_character_id: 90000001, victim_corporation_id: 98000001, isk_lost: 1500000, class: "PVP",
          attacker_count: 2 },
        { kill_id: 4, victim_character_id: null, victim_corporation_id: 98000005, isk_lost: 2000000, class: "PVP",
          attacker_count: 1 }]);
      const totals = () => h.all("SELECT character_id, kills, losses, isk_killed, isk_lost, first_kill_id, "
        + "last_kill_id FROM kb_char_totals ORDER BY character_id");
      const before = totals();
      assert.deepStrictEqual(before.map((t) => Object.values(t)), [[90000001, 0, 1, 0, 1500000, 1, 1],
        [90000002, 2, 0, 3500000, 0, 1, 4], [90000003, 1, 0, 1500000, 0, 1, 1]]);
      assert.deepStrictEqual(h.all("SELECT character_id, kill_id, role FROM kb_kill_chars ORDER BY kill_id, "
        + "character_id").map((r) => Object.values(r)), [[90000001, 1, "V"], [90000002, 1, "F"], [90000003, 1, "A"],
        [90000002, 4, "F"]]);
      assert.deepStrictEqual(h.all("SELECT kind, id, name FROM kb_names ORDER BY kind, id").map((r) => Object.values(r)),
        [["alliance", 99000001, "Alliance One"], ["char", 90000001, "Alice Pilot"], ["char", 90000002, "Bob Hunter"],
          ["corp", 98000001, "Corp One"]], "unknown names get no row");
      assert.deepStrictEqual(h.all("SELECT type_id, isk, name FROM kb_type_prices ORDER BY type_id")
        .map((r) => Object.values(r)), [[587, 400000, "Rifter"], [621, 9000000, "Caracal"]]);
      assert.deepStrictEqual(h.all("SELECT source, key_int, key_text, rows, state FROM kb_cursor"),
        [{ source: "kills", key_int: 5, key_text: "R", rows: 2, state: "RUNNING" }]);
      const st = pr.p.getStatus().counters;
      assert.deepStrictEqual([st.ingested, st.skippedNpc, st.skippedLneNpc, st.skippedOld, st.examined],
        [2, 1, 1, 1, 6]);
      assert.ok(pr.metrics.some(([n, v]) => n === "killboard.killsSkippedLneNpc" && v === 1));

      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 0, deferred: null, stop: "END" }, "second");
      assert.deepStrictEqual(projectorOn(h, km).p.runPass(NOW).ingested, 0, "restart: a new projector");
      h.tx((db) => db.prepare("DELETE FROM kb_cursor WHERE source = 'kills'").run());
      const replay = projectorOn(h, km);
      assert.deepStrictEqual(replay.p.runPass(NOW), { ok: true, ingested: 0, deferred: null, stop: "END" });
      assert.strictEqual(replay.p.getStatus().counters.known, 2, "replay: both kills known by the PK");
      assert.deepStrictEqual(totals(), before, "no double count");
      assert.strictEqual(h.all("SELECT rows FROM kb_cursor")[0].rows, 0,
        "the replay counts no new row (rows restart from the deleted cursor)");

      km.records.delete(5);
      const rw = projectorOn(h, km);
      h.tx((db) => db.prepare("UPDATE kb_cursor SET key_int = 5, key_text = 'R' WHERE source = 'kills'").run());
      assert.deepStrictEqual(rw.p.runPass(NOW), { ok: true, ingested: 0, deferred: "VENDOR_REWOUND", stop: "REWOUND" });
      assert.strictEqual(h.all("SELECT state FROM kb_cursor")[0].state, "VENDOR_REWOUND");
      assert.ok(rw.metrics.some(([n]) => n === "killboard.vendorRewound"));
      km.records.set(5, rec(5));
      km.records.set(6, rec(6));
      const calls = km.calls;
      for (const p of [rw.p, projectorOn(h, km).p]) {
        assert.deepStrictEqual(p.runPass(NOW), { ok: true, ingested: 0, deferred: "VENDOR_REWOUND" });
      }
      assert.strictEqual(km.calls, calls, "0 vendor reads after VENDOR_REWOUND");
      assert.strictEqual(rw.p.getStatus().kills, "VENDOR_REWOUND");
    });

    withStore(driver, (h) => {
      const km = fakeKm([rec(1), rec(2, { attackers: [{ characterID: 90000003 }], final: null })]);
      const refuse = () => ({ ok: false, reason: "SEAM_UNAVAILABLE" });
      const extra = { rowsCap: 10, readCharacterNames: refuse, readPlayerOrgNames: refuse, readItemTypeFacts: refuse };
      const pr = projectorOn(h, km, extra);
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: "ROWS", stop: "END" });
      assert.deepStrictEqual(h.all("SELECT key_int, key_text, rows FROM kb_cursor")[0],
        { key_int: 1, key_text: "R", rows: 1 });
      assert.strictEqual(pr.p.getStatus().counters.namesDeferred > 0, true, "refused names are never frozen");
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: null, stop: "END" });
      assert.strictEqual(h.all("SELECT count(*) AS n FROM kb_names")[0].n, 0);
    });

    withStore(driver, (h) => {
      const km = fakeKm([rec(1), rec(2), rec(3)]);
      let t = NOW;
      const clock = { now: () => { t += KB_DEFAULTS.maxPassMs + 1; return t; } };
      const pr = projectorOn(h, km, { clock });
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: "TIME", stop: "END" });
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: "TIME", stop: "END" });
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: null, stop: "END" });
      assert.strictEqual(pr.p.getStatus().counters.deferredTime, 2);
    });

    withStore(driver, (h) => {
      const km = fakeKm([rec(1), rec(3)], [2]);
      const pr = projectorOn(h, km);
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: null, stop: "PENDING" });
      const calls = km.calls;
      assert.deepStrictEqual(pr.p.runPass(NOW + KB_DEFAULTS.passMs), { ok: true, ingested: 0,
        deferred: "PENDING_BACKOFF" });
      assert.strictEqual(km.calls, calls, "backoff: no vendor read");
      km.pending.delete(2);
      km.records.set(2, rec(2));
      assert.deepStrictEqual(pr.p.runPass(NOW + 4 * KB_DEFAULTS.passMs), { ok: true, ingested: 2, deferred: null,
        stop: "END" });
      assert.deepStrictEqual(pr.p.getStatus().counters.pendingStops, 1);
      assert.deepStrictEqual(pr.p.getStatus().counters.pendingBackoff, 1);
      pr.gov.admit = false;
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 0, deferred: "GOVERNOR" });
    });
  });

  test(k13, () => {
    withStore(driver, (h) => {
      const km = fakeKm([rec(1, { system: SYS_A }), rec(2, { system: SYS_B, victim: 90000002 }),
        rec(3, { system: SYS_A, at: NOW - DAY + 5 }), rec(4, { system: SYS_A, victim: 90000003, at: NOW - DAY + 9 })]);
      const views = createViewRegistry();
      const gov = { admit: true };
      const adapter = adapterOver(km);
      const ctx = { persistence: { store: h.store }, views, governor: { admits: () => gov.admit },
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => (id === SYS_A ? { name: "Jita",
          security: 0.946 } : null) } }) } };
      const boot = (P) => startKillboard({ config: { killboard: { ...KB_DEFAULTS, enabled: true, ...P },
        persistence: { maxRowsPerTransaction: 500 } }, ctx, adapter, clock: { now: () => NOW },
      setTimer: () => ({ cancel() {}, hasRef: () => false }), isLneNpcCorporation: () => false });
      const started = boot({ killmailsEnabled: true, pageRows: 2 });
      assert.ok(started.ok, JSON.stringify(started));
      const pass = started.killboard.runPassNow();
      assert.deepStrictEqual([pass.deferred, pass.kills.ingested], ["BATTLES_UNAVAILABLE", 4],
        "battles off, kills on: the kill pass runs");
      const router = createRouter({ views, assets: {}, config: { maxResponseBytes: 262144, refreshSeconds: 5 },
        modVersion: "t", now: () => NOW });
      const get = (view, q = "") => {
        const r = router.route({ method: "GET", url: `/api/views/${view}${q}`, host: "127.0.0.1" });
        return { status: r.status, body: JSON.parse(r.body) };
      };
      const p1 = get("kb-kills").body.data;
      assert.deepStrictEqual([p1.rows.map((r) => r.killId), p1.nextBefore], [[4, 3], 3]);
      assert.deepStrictEqual(get("kb-kills", `?before=${p1.nextBefore}`).body.data.rows.map((r) => r.killId), [2, 1]);
      const sys = get("kb-kills", `?system=${SYS_A}`).body.data;
      assert.deepStrictEqual([sys.rows.map((r) => r.killId), sys.nextBefore, sys.rows[0].systemName],
        [[4, 3], 3, "Jita"]);
      assert.deepStrictEqual(get("kb-kills", `?system=${SYS_A}&before=3`).body.data.rows.map((r) => r.killId), [1]);
      const row = p1.rows[1];
      assert.deepStrictEqual([row.victim.characterName, row.victim.corporationName, row.victim.shipTypeName,
        row.final.characterName, row.iskLost, row.cls], ["Alice Pilot", "Corp One", "Rifter", "Bob Hunter", 1500000,
        "PVP"]);

      const kill = get("kb-kill", "?kill=1").body.data;
      assert.deepStrictEqual([kill.available, kill.killId, kill.battles, kill.attackerCount, kill.storedAttackers],
        [true, 1, [], 2, 2]);
      assert.deepStrictEqual(kill.attackers[0], { characterId: 90000002, characterName: "Bob Hunter",
        corporationId: 98000002, corporationName: null, allianceId: 99000001, allianceName: "Alliance One",
        factionId: null, shipTypeId: 621, shipTypeName: "Caracal", damageDone: 801, finalBlow: true });
      assert.deepStrictEqual(kill.characters.map((c) => [c.characterId, c.role]), [[90000001, "V"], [90000002, "F"],
        [90000003, "A"]]);
      assert.deepStrictEqual(get("kb-kill", "?kill=99").body.data, { available: false, reason: "NOT_FOUND" });

      const ch = get("kb-character", "?character=90000002").body.data;
      assert.deepStrictEqual([ch.name, ch.totals.kills, ch.totals.losses, ch.totals.iskKilled,
        ch.kills.map((k) => [k.killId, k.role]), ch.nextBefore], ["Bob Hunter", 3, 1, 4500000, [[4, "F"], [3, "F"]], 3]);
      assert.deepStrictEqual(get("kb-character", "?character=90000002&before=3").body.data.kills
        .map((k) => [k.killId, k.role]), [[2, "V"], [1, "F"]]);
      const nobody = get("kb-character", "?character=1").body.data;
      assert.deepStrictEqual([nobody.available, nobody.totals, nobody.kills], [true, null, []]);

      gov.admit = false;
      for (const [v, q] of [["kb-kills", "?system=1"], ["kb-kill", "?kill=2"], ["kb-character", "?character=2"]]) {
        assert.deepStrictEqual(get(v, q).body.data, { available: false, reason: "GOVERNOR_HOLD" }, v);
      }
      started.killboard.stop();

      const calls = km.calls;
      const off = boot({ killmailsEnabled: false });
      assert.ok(off.ok);
      assert.strictEqual(off.killboard.runPassNow().kills.deferred, "DISABLED");
      assert.strictEqual(km.calls, calls);
      assert.strictEqual(get("kb-kills").status, 404);
      assert.strictEqual(get("kb-battles").status, 200);
      off.killboard.stop();
    });
  });

  test("KB19 debt-sweep: listKills system + pruned before -> no rows; existing before -> same page; no system "
    + "unchanged", () => {
    withStore(driver, (h) => {
      const km = fakeKm([rec(1, { system: SYS_A }), rec(2, { system: SYS_B, victim: 90000002 }),
        rec(3, { system: SYS_A, at: NOW - DAY + 5 }), rec(4, { system: SYS_A, victim: 90000003, at: NOW - DAY + 9 })]);
      assert.strictEqual(projectorOn(h, km).p.runPass(NOW).ingested, 4);
      const repo = createKillboardRepository();
      const ids = (opts) => {
        const r = h.tx((db) => repo.listKills(db, { limit: 10, ...opts }));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        return r.rows.map((k) => k.killId);
      };
      assert.deepStrictEqual(ids({ systemId: SYS_A, before: 3 }), [1]);
      assert.deepStrictEqual(ids({ systemId: SYS_A }), [4, 3, 1]);
      h.tx((db) => {
        db.prepare("DELETE FROM kb_kill_chars WHERE kill_id = 3").run();
        db.prepare("DELETE FROM kb_kills WHERE kill_id = 3").run();
      });
      assert.deepStrictEqual(ids({ systemId: SYS_A, before: 3 }), [], "pruned before: empty page");
      assert.deepStrictEqual(ids({ systemId: SYS_A, before: 4 }), [1]);
      assert.deepStrictEqual(ids({ before: 3 }), [2, 1], "no system: listKillsAll unchanged");
    });
  });

  test(k14, () => {
    assert.deepStrictEqual([KB_DEFAULTS.resetKills, KB_DEFAULTS.pendingMaxAgeMs], [false, 3600000]);
    withStore(driver, (h) => {
      const count = (t) => h.all(`SELECT count(*) AS n FROM ${t}`)[0].n;
      const km = fakeKm([rec(1), rec(2), rec(3)]);
      assert.strictEqual(projectorOn(h, km).p.runPass(NOW).ingested, 3);
      assert.deepStrictEqual([count("kb_kills"), count("kb_kill_chars"), count("kb_char_totals")], [3, 9, 3]);
      km.records = new Map([[1, rec(1, { victim: 90000011, final: 90000012,
        attackers: [{ characterID: 90000012 }] })]]);
      const rw = projectorOn(h, km);
      assert.strictEqual(rw.p.runPass(NOW).stop, "REWOUND");
      assert.ok(rw.logs.some((l) => l.includes("killboard.resetKills=true") && !l.includes("DELETE")), rw.logs[0]);
      assert.strictEqual(rw.p.runPass(NOW).deferred, "VENDOR_REWOUND", "flag off = the stop stays");

      const calls = km.calls;
      const small = projectorOn(h, km, { rowsCap: 6, P: { resetKills: true } });
      assert.deepStrictEqual(small.p.runPass(NOW), { ok: true, ingested: 0, deferred: "RESETTING" });
      assert.deepStrictEqual([h.all("SELECT state FROM kb_cursor")[0].state, small.p.getStatus().kills],
        ["RESETTING", "RESETTING"]);
      assert.ok(small.logs.some((l) => l.includes("reset of the kill source started")));
      const resumed = projectorOn(h, km, { rowsCap: 6 });
      const steps = [];
      for (let i = 0; i < 5 && steps[steps.length - 1] !== "RESET"; i += 1) steps.push(resumed.p.runPass(NOW).deferred);
      assert.deepStrictEqual(steps, ["RESETTING", "RESETTING", "RESET"], "a reset under way goes on with the flag off");
      assert.strictEqual(km.calls, calls, "no vendor read during the reset");
      assert.deepStrictEqual([count("kb_kills"), count("kb_kill_chars"), count("kb_char_totals"), count("kb_cursor")],
        [0, 0, 0, 0]);
      assert.ok(count("kb_names") > 0, "the frozen names stay");
      assert.deepStrictEqual([small.p.getStatus().counters.resetRows + resumed.p.getStatus().counters.resetRows,
        resumed.p.getStatus().counters.resets], [15, 1]);

      const fresh = projectorOn(h, km, { P: { resetKills: true } });
      assert.deepStrictEqual(fresh.p.runPass(NOW), { ok: true, ingested: 1, deferred: null, stop: "END" });
      assert.strictEqual(fresh.p.getStatus().counters.known, 0);
      assert.deepStrictEqual(h.all("SELECT character_id, kills, losses FROM kb_char_totals ORDER BY character_id")
        .map((r) => Object.values(r)), [[90000011, 0, 1], [90000012, 1, 0]]);
      assert.deepStrictEqual(h.all("SELECT key_int, rows, state FROM kb_cursor")[0],
        { key_int: 1, rows: 1, state: "RUNNING" });
      assert.strictEqual(fresh.p.runPass(NOW).ingested, 0, "flag left on while RUNNING = no reset");
      assert.strictEqual(count("kb_kills"), 1);

      km.records = new Map();
      assert.strictEqual(fresh.p.runPass(NOW).stop, "REWOUND");
      assert.deepStrictEqual(fresh.p.runPass(NOW), { ok: true, ingested: 0, deferred: "RESET" });
      assert.deepStrictEqual([count("kb_kills"), count("kb_cursor")], [0, 0]);
    });
  });

  test(k15, () => {
    const HOUR = 3600000;
    const old = new Map([[2, NOW - 2 * HOUR]]);
    const r = readVendorKillsFrom(fakeKm([rec(1), rec(3)], [2], old), spec({ pendingMaxAgeMs: HOUR }));
    assert.deepStrictEqual([r.kills.map((k) => k.killId), r.stalePending, r.stop, r.cursor, r.cursorKind,
      r.pendingAgeMs], [[1, 3], 1, "END", 3, "R", null]);
    const noLimit = readVendorKillsFrom(fakeKm([rec(1), rec(3)], [2], old), spec());
    assert.deepStrictEqual([noLimit.stop, noLimit.pendingAgeMs, noLimit.stalePending], ["PENDING", 2 * HOUR, 0]);
    const nothingAfter = readVendorKillsFrom(fakeKm([rec(1)], [2], old), spec({ pendingMaxAgeMs: HOUR }));
    assert.deepStrictEqual([nothingAfter.stop, nothingAfter.stalePending], ["PENDING", 0], "no record after it");
    assert.strictEqual(readVendorKillsFrom(fakeKm([]), spec({ pendingMaxAgeMs: -1 })).reason, "INVALID_INPUT");

    withStore(driver, (h) => {
      const pr = projectorOn(h, fakeKm([rec(1), rec(3)], [2], old));
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 2, deferred: null, stop: "END" });
      assert.strictEqual(pr.p.getStatus().counters.skippedStalePending, 1);
      assert.ok(pr.metrics.some(([n, v]) => n === "killboard.killsSkippedStalePending" && v === 1));
      assert.ok(pr.logs.some((l) => l.includes("older than killboard.pendingMaxAgeMs")), JSON.stringify(pr.logs));
      assert.strictEqual(pr.p.getStatus().pendingStopAgeMs, null);
    });
    withStore(driver, (h) => {
      const pr = projectorOn(h, fakeKm([rec(1), rec(3)], [2], new Map([[2, NOW - 60000]])));
      assert.deepStrictEqual(pr.p.runPass(NOW), { ok: true, ingested: 1, deferred: null, stop: "PENDING" });
      assert.deepStrictEqual([pr.p.getStatus().pendingStopAgeMs, pr.p.getStatus().counters.skippedStalePending],
        [60000, 0]);
    });
  });

  test(k16, () => {
    const SLACK = KB_DEFAULTS.relatedKillSlackMs;
    const T0 = NOW - DAY;
    const MIN = 60000;
    assert.deepStrictEqual([KB_DEFAULTS.relatedKillsMax, SLACK, KB_DEFAULTS.relatedScanRows], [20, 300000, 200]);
    withStore(driver, (h) => {
      const km = fakeKm([rec(1, { at: T0 }), rec(2, { at: T0 - 10 * MIN - SLACK - 1 }),
        rec(3, { at: T0, system: SYS_B }), rec(4, { at: T0 + 9 * MIN + SLACK }), rec(5, { at: T0 + MIN })]);
      assert.strictEqual(projectorOn(h, km).p.runPass(NOW).ingested, 5);
      const battle = (id, createdAt, settledAt, systemId) => h.tx((db) => db.prepare(`INSERT INTO kb_battles
        (battle_id, settled_at, created_at, system_id, mode, environment, objective, outcome, a_fleets, b_fleets,
        a_ships_lost, b_ships_lost, a_isk_lost, b_isk_lost, unpriced_ships, price_basis, ingested_at)
        VALUES (?, ?, ?, ?, 'VIRTUAL', 'SPACE', 'SKIRMISH', 'A_WIN', 1, 1, 0, 0, 0, 0, 0, 'base-v1', ?)`)
        .run(id, settledAt, createdAt, systemId, NOW));
      battle("w1", T0 - 10 * MIN, T0 + 9 * MIN, SYS_A);
      battle("w2", T0 + DAY / 2, T0 + DAY / 2 + MIN, SYS_A);

      const repo = createKillboardRepository();
      const inWin = (q) => h.tx((db) => repo.listKillsInWindow(db, q));
      const win = { systemId: SYS_A, fromMs: T0 - 10 * MIN - SLACK, toMs: T0 + 9 * MIN + SLACK };
      assert.deepStrictEqual(inWin({ ...win, limit: 20 }).rows.map((k) => k.killId), [1, 5, 4],
        "in the window, kill_at order; kill 2 = 1 ms before the window - slack; kill 3 = another system");
      assert.deepStrictEqual(inWin({ ...win, limit: 2 }).rows.map((k) => k.killId), [1, 5], "limit");
      assert.deepStrictEqual(inWin({ ...win, limit: 0 }), { ok: true, rows: [] });
      assert.strictEqual(inWin({ ...win, systemId: 0, limit: 1 }).ok, false);
      const covering = (q) => h.tx((db) => repo.listBattlesCovering(db, { systemId: SYS_A, atMs: T0, slackMs: SLACK,
        scanRows: 200, max: 5, ...q }));
      assert.deepStrictEqual(covering({}), { ok: true, battles: [{ no: 1, settledAt: T0 + 9 * MIN, outcome: "A_WIN" }] });
      assert.deepStrictEqual(covering({ scanRows: 1 }).battles, [], "relatedScanRows trims: only battle 2 scanned");
      assert.deepStrictEqual(covering({ atMs: T0 + DAY / 2 + MIN + SLACK }).battles.map((b) => b.no), [2]);
      assert.deepStrictEqual(covering({ systemId: SYS_B }).battles, []);
      assert.strictEqual(covering({ max: 6 }).ok, false);

      const views = createViewRegistry();
      const ctx = { persistence: { store: h.store }, views, governor: { admits: () => true },
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: () => null } }) } };
      const boot = (P) => startKillboard({ config: { killboard: { ...KB_DEFAULTS, enabled: true, ...P },
        persistence: { maxRowsPerTransaction: 500 } }, ctx, adapter: adapterOver(km), clock: { now: () => NOW },
      setTimer: () => ({ cancel() {}, hasRef: () => false }), isLneNpcCorporation: () => false });
      const router = createRouter({ views, assets: {}, config: { maxResponseBytes: 262144, refreshSeconds: 5 },
        modVersion: "t", now: () => NOW });
      const get = (view, q) => JSON.parse(router.route({ method: "GET", url: `/api/views/${view}${q}`,
        host: "127.0.0.1" }).body).data;
      const on = boot({ killmailsEnabled: true });
      assert.ok(on.ok, JSON.stringify(on));
      const b1 = get("kb-battle", "?battle=1");
      assert.deepStrictEqual(b1.capsuleerKills.map((k) => k.killId), [1, 5, 4]);
      assert.deepStrictEqual(b1.capsuleerKills[0], { killId: 1, killAt: T0, victim: { characterId: 90000001,
        name: "Alice Pilot", shipTypeId: 587, shipName: "Rifter" }, iskLost: 1500000, attackerCount: 2 });
      assert.deepStrictEqual(get("kb-battle", "?battle=2").capsuleerKills, []);
      assert.deepStrictEqual(get("kb-kill", "?kill=1").battles, [{ no: 1, settledAt: T0 + 9 * MIN, outcome: "A_WIN" }]);
      assert.deepStrictEqual(get("kb-kill", "?kill=3").battles, [], "another system");
      on.killboard.stop();
      const capped = boot({ killmailsEnabled: false, relatedKillsMax: 2 });
      assert.deepStrictEqual(get("kb-battle", "?battle=1").capsuleerKills.map((k) => k.killId), [1, 5],
        "relatedKillsMax; kb-battle reads kb_kills with the kill views off");
      capped.killboard.stop();
      const off = boot({ relatedKillsMax: 0 });
      assert.deepStrictEqual(get("kb-battle", "?battle=1").capsuleerKills, [], "0 = off");
      off.killboard.stop();
    });
  });
};
