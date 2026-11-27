"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { planCharacter } = require("../../lib/localPilots/contacts/plan");
const S = require("../../lib/localPilots/contacts/schema");
const { createLocalContactsRepository } = require("../../lib/localPilots/contacts/repository");
const { startLocalContacts } = require("../../lib/localPilots/contacts/service");
const { applyPersonalContactsFrom } = require("../../lib/adapter/personalContacts");
const { createAdapter } = require("../../lib/adapter");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FAKE_SRC = path.join(path.sep, "x", "server", "src");
const CHAR = 90000123;
const ALLY_A = 99000001;
const ALLY_B = 99000002;
const ALLY_C = 99000003;
const ALLY_D = 99000004;
const FACTION = 500001;
const NOW = 1700000000000;
const DELAY = 10000;

const lne = (rel) => ({ relationshipId: rel, inWatchlist: false, labelMask: 0 });
const reg = (contactId, state, writtenRel, changedAt, prevRel = null) => ({ contactId, factionId: FACTION,
  level: "alliance", state, writtenRel, prevRel, changedAt });

function fakeCharacterState(records) {
  const log = { writes: 0 };
  return { log,
    peekCharacterRecord: (id) => records.get(id) || null,
    updateCharacterRecord(id, updater) {
      const current = records.get(id);
      if (!current) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
      const next = updater(JSON.parse(JSON.stringify(current)));
      records.set(id, { ...next });
      log.writes += 1;
      return { success: true, data: next };
    } };
}

module.exports = ({ test, skip }) => {
  test("LCP1 plan: hostile -10, friendly +10, neutral none; manual rows skipped; OWNED edited / deleted -> RELEASED; "
    + "ADDING without a row before confirmDelayMs retried; unknown standing unchanged", () => {
    const known = new Set([ALLY_A, ALLY_B, ALLY_C, ALLY_D]);
    const desired = new Map([[ALLY_A, { factionId: FACTION, level: "alliance", rel: -10 }],
      [ALLY_B, { factionId: FACTION, level: "alliance", rel: 10 }],
      [ALLY_D, { factionId: FACTION, level: "alliance", rel: 10 }]]);
    const fresh = planCharacter({ desired, known, unknown: new Set(), registry: [],
      vendor: new Map([[ALLY_D, { relationshipId: 5, inWatchlist: false, labelMask: 0 }]]), nowMs: NOW,
      confirmDelayMs: DELAY });
    assert.deepStrictEqual(fresh.ops, [
      { contactId: ALLY_A, op: "set", relationshipId: -10, expect: [null] },
      { contactId: ALLY_B, op: "set", relationshipId: 10, expect: [null] }]);
    assert.deepStrictEqual(fresh.transitions.map((t) => [t.contactId, t.from, t.to, t.rel]),
      [[ALLY_A, null, S.ADDING, -10], [ALLY_B, null, S.ADDING, 10]]);
    assert.strictEqual(fresh.skippedManual, 1);
    const watch = planCharacter({ desired, known, unknown: new Set(), registry: [],
      vendor: new Map([[ALLY_A, { relationshipId: -10, inWatchlist: true, labelMask: 0 }],
        [ALLY_B, { relationshipId: 10, inWatchlist: false, labelMask: 4 }], [ALLY_D, lne(10)]]), nowMs: NOW,
      confirmDelayMs: DELAY });
    assert.deepStrictEqual([watch.ops, watch.transitions, watch.skippedManual], [[], [], 3]);

    const ab = new Map([...desired].filter(([id]) => id !== ALLY_D));
    const owned = planCharacter({ desired: ab, known, unknown: new Set(),
      registry: [reg(ALLY_A, S.OWNED, -10, NOW - 1), reg(ALLY_B, S.OWNED, 10, NOW - 1)],
      vendor: new Map([[ALLY_A, { relationshipId: -5, inWatchlist: false, labelMask: 0 }]]), nowMs: NOW,
      confirmDelayMs: DELAY });
    assert.deepStrictEqual([owned.ops, owned.transitions.map((t) => [t.contactId, t.to, t.reason])],
      [[], [[ALLY_A, S.RELEASED, "MANUAL_EDIT"], [ALLY_B, S.RELEASED, "MANUAL_DELETE"]]]);

    const adding = planCharacter({ desired: ab, known, unknown: new Set([ALLY_B]),
      registry: [reg(ALLY_A, S.ADDING, -10, NOW - 1), reg(ALLY_B, S.OWNED, 10, NOW - 1)],
      vendor: new Map(), nowMs: NOW, confirmDelayMs: DELAY });
    assert.deepStrictEqual(adding.ops, [{ contactId: ALLY_A, op: "set", relationshipId: -10, expect: [null] }]);
    assert.deepStrictEqual(adding.transitions.map((t) => [t.contactId, t.from, t.to]), [[ALLY_A, S.ADDING, S.ADDING]]);
    const later = planCharacter({ desired: new Map([[ALLY_A, desired.get(ALLY_A)]]), known, unknown: new Set(),
      registry: [reg(ALLY_A, S.ADDING, -10, NOW - DELAY), reg(ALLY_B, S.OWNED, 10, NOW - 1)],
      vendor: new Map([[ALLY_A, lne(-10)], [ALLY_B, lne(10)]]), nowMs: NOW, confirmDelayMs: DELAY });
    assert.deepStrictEqual([later.ops, later.transitions.map((t) => [t.contactId, t.to])],
      [[{ contactId: ALLY_B, op: "delete", expect: [10] }], [[ALLY_A, S.OWNED], [ALLY_B, S.REMOVING]]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LCC1 cleanup (flag off): 2 passes remove only the LNE rows, manual rows byte for byte, tombstone stays, "
    + "service stops", () => H.withStore(driver, async (reopen) => {
    const { store } = reopen();
    const repo = createLocalContactsRepository();
    const t = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    t((db) => {
      for (const [id, rel] of [[ALLY_A, -10], [ALLY_B, 10], [ALLY_D, -10]]) {
        assert.ok(repo.insertAdding(db, { characterId: CHAR, contactId: id, factionId: FACTION, level: "alliance",
          writtenRel: rel, changedAt: NOW - DELAY }).ok);
        const next = id === ALLY_D
          ? { state: S.RELEASED, writtenRel: rel, prevRel: null, changedAt: NOW - 1, releaseReason: "MANUAL_EDIT" }
          : { state: S.OWNED, writtenRel: rel, prevRel: null, changedAt: NOW - DELAY, releaseReason: null };
        assert.ok(repo.updateRow(db, { characterId: CHAR, contactId: id }, 1, next).ok);
      }
    });
    const manualC = { contactID: ALLY_C, inWatchlist: false, relationshipID: 5, labelMask: 0 };
    const manualD = { contactID: ALLY_D, inWatchlist: true, relationshipID: -10, labelMask: "8" };
    const records = new Map([[CHAR, { characterID: CHAR, personalContacts: {
      [ALLY_A]: { contactID: ALLY_A, inWatchlist: false, relationshipID: -10, labelMask: 0 },
      [ALLY_B]: { contactID: ALLY_B, inWatchlist: false, relationshipID: 10, labelMask: 0 },
      [ALLY_C]: manualC, [ALLY_D]: manualD } }]]);
    const vendor = fakeCharacterState(records);
    const adapter = createAdapter({ moduleApi: { _cache: {
      [path.join(FAKE_SRC, "services/character/characterState.js")]: { exports: vendor } } } });
    adapter.setServerSrc(FAKE_SRC);
    const r = resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.strictEqual(r.config.localContacts.enabled, false);
    let now = NOW;
    const started = startLocalContacts({ config: r.config, clock: { now: () => now },
      ctx: { persistence: { ok: true, store }, adapter }, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
    assert.ok(started.ok, JSON.stringify(started));
    const lc = started.localContacts;
    assert.deepStrictEqual([lc.getStatus().mode, lc.getStatus().liveRows], ["cleanup", 2]);
    assert.deepStrictEqual(lc.runPassNow(), { ok: true });
    assert.deepStrictEqual([vendor.log.writes, Object.keys(records.get(CHAR).personalContacts).map(Number)],
      [1, [ALLY_C, ALLY_D]]);
    assert.deepStrictEqual(lc.getStatus().counters.removed, 2);
    now += DELAY;
    assert.deepStrictEqual(lc.runPassNow(), { ok: true });
    const pc = records.get(CHAR).personalContacts;
    assert.deepStrictEqual([JSON.stringify(pc[ALLY_C]), JSON.stringify(pc[ALLY_D])],
      [JSON.stringify(manualC), JSON.stringify(manualD)]);
    assert.strictEqual(vendor.log.writes, 1);
    const rows = t((db) => repo.listForCharacter(db, CHAR)).rows;
    assert.deepStrictEqual(rows.map((x) => [x.contactId, x.state]), [[ALLY_D, S.RELEASED]]);
    const st = lc.getStatus();
    assert.deepStrictEqual([st.mode, st.liveRows, st.releasedRows], ["stopped", 0, 1]);
    assert.deepStrictEqual(startLocalContacts({ config: r.config, ctx: { persistence: { ok: true, store }, adapter } }),
      { ok: false, reason: "disabled_by_config" });
  }));

  test("LCA1 adapter CAS: a player row seen only by the updater -> conflict, no write; contactId = characterId -> "
    + "BAD_OP; set writes exactly the vendor row shape", () => {
    const records = new Map([[CHAR, { characterID: CHAR, personalContacts: {} }]]);
    const vendor = fakeCharacterState(records);
    const racing = { peekCharacterRecord: vendor.peekCharacterRecord,
      updateCharacterRecord(id, updater) {
        records.set(id, { characterID: CHAR, personalContacts: {
          [ALLY_A]: { contactID: ALLY_A, inWatchlist: false, relationshipID: 5, labelMask: 0 } } });
        return vendor.updateCharacterRecord(id, updater);
      } };
    const op = { contactId: ALLY_A, op: "set", relationshipId: -10, expect: [null] };
    assert.deepStrictEqual(applyPersonalContactsFrom(racing, CHAR, [op]),
      { ok: true, applied: [], conflicts: [ALLY_A], written: false });
    assert.strictEqual(vendor.log.writes, 0);
    assert.strictEqual(records.get(CHAR).personalContacts[ALLY_A].relationshipID, 5);
    assert.deepStrictEqual(applyPersonalContactsFrom(vendor, CHAR, [{ ...op, contactId: CHAR }]),
      { ok: false, reason: "BAD_OP", permanent: true });
    assert.deepStrictEqual(applyPersonalContactsFrom(vendor, CHAR, [{ ...op, contactId: ALLY_B, relationshipId: 5 }]),
      { ok: false, reason: "BAD_OP", permanent: true });
    assert.deepStrictEqual(applyPersonalContactsFrom(vendor, CHAR, [{ ...op, contactId: ALLY_B, relationshipId: 10 }]),
      { ok: true, applied: [ALLY_B], conflicts: [], written: true });
    assert.deepStrictEqual(records.get(CHAR).personalContacts[ALLY_B],
      { contactID: ALLY_B, inWatchlist: false, relationshipID: 10, labelMask: 0 });
    assert.deepStrictEqual(applyPersonalContactsFrom(vendor, 1, [op]),
      { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true });
  });

  const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
  (found.ok ? test : (name) => skip(name, "EveJS server/src not found above the mod"))("LCF1 vendor facts: "
    + "personalContacts row fields, upsertPersonalContact not exported, characterState exports peekCharacterRecord "
    + "and updateCharacterRecord", () => {
    const charMgr = fs.readFileSync(path.join(found.srcDir, "services", "character", "charMgrService.js"), "utf8");
    assert.match(charMgr, /record\.personalContacts\s*=\s*contacts/);
    for (const field of ["contactID", "inWatchlist", "relationshipID", "labelMask"]) {
      assert.match(charMgr, new RegExp(`\\b${field}:`), field);
    }
    assert.match(charMgr, /module\.exports\s*=\s*CharMgrService;/);
    assert.doesNotMatch(charMgr, /module\.exports\.upsertPersonalContact|exports\.upsertPersonalContact/);
    const state = fs.readFileSync(path.join(found.srcDir, "services", "character", "characterState.js"), "utf8");
    const start = state.indexOf("module.exports = {");
    assert.ok(start >= 0, "characterState module.exports object");
    const exportsBlock = state.slice(start, state.indexOf("};", start));
    assert.match(exportsBlock, /\bpeekCharacterRecord,/);
    assert.match(exportsBlock, /\bupdateCharacterRecord,/);
  });
};
