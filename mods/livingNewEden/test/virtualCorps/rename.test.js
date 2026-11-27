"use strict";

const assert = require("node:assert");

const { planRenameBatch, createRenamePass, SUFFIX_RE } = require("../../lib/virtualCorps/rename");
const { createVirtualIdentitiesAdapter } = require("../../lib/adapter/virtualIdentities");
const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");

const DIGIT = /[0-9]/;
const clone = (v) => JSON.parse(JSON.stringify(v));

function fakeVendor(records, opts = {}) {
  const calls = { update: 0, normalized: 0, flush: [], scan: 0, keys: 0 };
  const skills = {};
  const keyOf = (n) => String(n).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const modules = {
    "services/character/characterState": {
      peekCharacterRecord: (id) => records[String(id)] || null,
      writeCharacterRecord: (id, record) => {
        calls.update += 1;
        records[String(id)] = clone(record);
        return { success: true, data: clone(record) };
      },
      updateCharacterRecord: (id, updater) => {
        calls.normalized += 1;
        const cur = records[String(id)];
        if (!cur) return { success: false, errorMsg: "CHARACTER_NOT_FOUND" };
        const g = Number(cur.gender);
        const normalized = { ...clone(cur), gender: g === 0 || g === 1 || g === 2 ? g : 1 };
        if (!skills[String(id)]) skills[String(id)] = [3300, 3327];
        records[String(id)] = updater(normalized);
        return { success: true };
      },
    },
    "services/character/characterNameRuntime": {
      getExistingCharacterNameKeys: () => {
        calls.keys += 1;
        return new Set(Object.values(records).map((r) => keyOf(r.characterName)));
      },
      validateCharacterName: () => 1,
      VALIDATION_CODE: { VALID: 1 },
    },
    "gameStore/index": {
      read: () => { calls.scan += 1; return { success: true, data: records }; },
      flushTablesSync: (tables) => {
        calls.flush.push(tables);
        return opts.flushFails ? { success: false, errorMsg: "FLUSH_ERROR" } : { success: true };
      },
    },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "MISSING" });
  return { calls, skills, requireGame };
}

function passAdapter(requireGame) {
  const id = createVirtualIdentitiesAdapter({ requireGame, config: { virtualCorps: { characterScanCacheTtlMs: 0 } } });
  return { scanVirtualCharacters: id.scanVirtualCharacters, renameVirtualCharacter: id.renameCharacter,
    virtualIdentityFlush: id.flush, peekCharacterRecord: id.peekCharacterRecord,
    characterNameKeys: id.characterNameKeys, validateCharacterName: id.validateCharacterName,
    noteCharacterNameTaken: id.noteCharacterNameTaken };
}

function fakeStore(rows) {
  const tx = [];
  const ctl = { boom: false };
  const repo = {
    listByState: (st) => [...rows.values()].filter((r) => r.state === st).map((r) => ({ ...r })),
    update: (key, version, f) => {
      if (ctl.boom) throw new Error("crash");
      const row = rows.get(key);
      if (!row || row.version !== version) return { ok: false, reason: "CAS_FAILED" };
      rows.set(key, { ...row, evejs_id: f.evejsId, state: f.state, name: f.name, ticker: f.ticker,
        updated_at: f.at, version: version + 1 });
      return { ok: true };
    },
  };
  const store = {
    transaction: (name, fn) => {
      tx.push(name);
      const before = new Map([...rows].map(([k, v]) => [k, { ...v }]));
      try {
        return { ok: true, value: fn({}) };
      } catch (_err) {
        rows.clear();
        for (const [k, v] of before) rows.set(k, v);
        return { ok: false, reason: "TX_FAILED" };
      }
    },
  };
  return { store, tx, ctl, repoOf: () => repo };
}

const charRow = (key, evejsId, name, extra = {}) => ({ identity_key: key, kind: "character", owner_kind: "faction",
  owner_id: 500020, evejs_id: evejsId, state: IDENTITY_STATES.LINKED, name, ticker: null, race_id: 8, version: 1,
  ...extra });
const vendorRec = (id, key, name, gender = "Male") => ({ characterId: id, lneIdentityKey: key, characterName: name,
  gender, raceID: 8, corporationID: 2000001, allianceID: 0, balance: 1234, skillPoints: 50000 });

function world() {
  const records = {
    1000001: vendorRec(1000001, "f:500020:corp:0:char:0", "Renard Moreau 2"),
    1000003: vendorRec(1000003, "f:500020:corp:0:char:1", "Aline Duval 3", "Female"),
    1000005: vendorRec(1000005, "f:500020:corp:0:char:2", "Clean Name"),
    90000001: { characterId: 90000001, characterName: "Player 7", gender: 1 },
  };
  const rows = new Map([
    ["f:500020:corp:0:char:0", charRow("f:500020:corp:0:char:0", 1000001, "Renard Moreau 2")],
    ["f:500020:corp:0:char:1", charRow("f:500020:corp:0:char:1", 1000003, null)],
    ["f:500020:corp:0:char:2", charRow("f:500020:corp:0:char:2", 1000005, null)],
  ]);
  return { records, rows };
}

function rig(enabled = true, vendorOpts = {}) {
  const w = world();
  const v = fakeVendor(w.records, vendorOpts);
  const s = fakeStore(w.rows);
  const timers = [];
  const tel = { counts: {}, gauges: {}, observed: [] };
  const telemetry = { count: (n, k) => { tel.counts[n] = (tel.counts[n] || 0) + k; },
    gauge: (n, x) => { tel.gauges[n] = x; }, observe: (n, x) => { tel.observed.push(n); } };
  let rebuilt = 0;
  const pass = createRenamePass({ adapter: passAdapter(v.requireGame), store: s.store, repoOf: s.repoOf,
    clock: { now: () => 5000000 }, nowMs: () => 1, worldSeed: 77, telemetry, logger: { log: () => {} },
    settings: { enabled, batchPerPass: 50, passMs: 5000, maxAttempts: 48 }, onRowsChanged: () => { rebuilt += 1; },
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false }; timers.push(t);
      return { cancel: () => { t.cancelled = true; }, hasRef: () => false }; } });
  const fire = () => {
    const t = timers.filter((x) => !x.cancelled).pop();
    assert.ok(t, "an armed timer");
    t.cancelled = true;
    t.fn();
  };
  return { ...w, v, s, pass, tel, fire, timers, rebuilt: () => rebuilt };
}

module.exports = ({ test }) => {
  test("R1 planRenameBatch: rename = suffix + row of the marker, sync = clean vendor + suffixed row, limit/left", () => {
    const chars = [
      { characterId: 30, lneIdentityKey: "k3", name: "Gamma Name 4" },
      { characterId: 10, lneIdentityKey: "k1", name: "Alpha Name 2" },
      { characterId: 20, lneIdentityKey: "k2", name: "Beta Name 12" },
      { characterId: 40, lneIdentityKey: "k4", name: "Delta Clean" },
      { characterId: 50, lneIdentityKey: "k5", name: "Eps Clean" },
      { characterId: 60, lneIdentityKey: "k6", name: "Zeta Orphan 2" },
      { characterId: 70, lneIdentityKey: "k7", name: "Agent 007x" },
    ];
    const rows = new Map([
      ["k1", { identity_key: "k1", evejs_id: 10, name: null, version: 1 }],
      ["k2", { identity_key: "k2", evejs_id: 20, name: "Beta Name 12", version: 2 }],
      ["k3", { identity_key: "k3", evejs_id: 30, name: null, version: 1 }],
      ["k4", { identity_key: "k4", evejs_id: 40, name: "Delta Old 3", version: 5 }],
      ["k5", { identity_key: "k5", evejs_id: 50, name: null, version: 1 }],
      ["k7", { identity_key: "k7", evejs_id: 70, name: "Agent 007x", version: 1 }],
    ]);
    const all = planRenameBatch(chars, rows, 50);
    assert.deepStrictEqual(all.rename.map((r) => [r.characterId, r.identityKey]), [[10, "k1"], [20, "k2"], [30, "k3"]]);
    assert.deepStrictEqual(all.sync.map((s) => [s.identityKey, s.name]), [["k4", "Delta Clean"]]);
    assert.deepStrictEqual([all.left, all.unmatched], [0, 1]);
    const two = planRenameBatch(chars, rows, 2);
    assert.deepStrictEqual(two.rename.map((r) => r.characterId), [10, 20]);
    assert.deepStrictEqual([two.sync.length, two.left], [1, 1]);
    assert.ok(SUFFIX_RE.test("Renard Moreau 2") && !SUFFIX_RE.test("Renard Moreau"));
  });

  test("R2 adapter renameCharacter changes only characterName of the RAW record (no vendor normalize: gender "
    + "\"Female\" kept, no skills seeded); another marker -> NOT_LNE, nothing written", () => {
    const records = { 1000001: vendorRec(1000001, "f:1:corp:0:char:0", "Renard Moreau 2", "Female") };
    const before = clone(records[1000001]);
    const v = fakeVendor(records);
    const a = createVirtualIdentitiesAdapter({ requireGame: v.requireGame });
    assert.deepStrictEqual(a.renameCharacter(1000001, "Renard Moreau", "f:9:corp:0:char:0"), { ok: false,
      reason: "NOT_LNE" });
    assert.strictEqual(v.calls.update, 0);
    assert.deepStrictEqual(a.renameCharacter(1000001, "Renard Moreau", "f:1:corp:0:char:0"), { ok: true,
      changed: true });
    assert.deepStrictEqual(records[1000001], { ...before, characterName: "Renard Moreau" });
    assert.deepStrictEqual(a.renameCharacter(1000001, "Renard Moreau", "f:1:corp:0:char:0"), { ok: true,
      changed: false });
    assert.strictEqual(v.calls.update, 1);
    assert.deepStrictEqual([v.calls.normalized, v.skills], [0, {}], "never the normalizing updateCharacterRecord");
    assert.deepStrictEqual(a.renameCharacter(42, "X Y", "f:1:corp:0:char:0"), { ok: false, reason: "NO_RECORD" });
    assert.strictEqual(a.renameCharacter(1000001, "", "f:1:corp:0:char:0").reason, "INVALID_INPUT");
  });

  test("R3 pass: off = zero calls; on = names without digits, rows updated, one flush; next pass ends (done)", () => {
    const off = rig(false);
    assert.deepStrictEqual(off.pass.start(), { ok: false, reason: "DISABLED" });
    assert.deepStrictEqual([off.v.calls.scan, off.v.calls.update, off.v.calls.flush.length, off.s.tx.length,
      off.timers.length], [0, 0, 0, 0, 0]);

    const on = rig(true);
    const raw = clone(on.records);
    assert.deepStrictEqual(on.pass.start(), { ok: true });
    assert.strictEqual(on.timers[0].ms, 5000);
    on.fire();
    const a = on.records[1000001].characterName;
    const b = on.records[1000003].characterName;
    assert.ok(!DIGIT.test(a) && !DIGIT.test(b) && a !== b, `${a} / ${b}`);
    assert.deepStrictEqual(on.records, { ...raw, 1000001: { ...raw[1000001], characterName: a },
      1000003: { ...raw[1000003], characterName: b } });
    assert.deepStrictEqual([on.v.calls.normalized, on.v.skills], [0, {}]);
    assert.deepStrictEqual([on.rows.get("f:500020:corp:0:char:0").name, on.rows.get("f:500020:corp:0:char:1").name,
      on.rows.get("f:500020:corp:0:char:2").name], [a, b, null]);
    assert.deepStrictEqual(on.v.calls.flush, [["characters"]]);
    assert.deepStrictEqual(on.s.tx, ["virtualCorps.renameRead", "virtualCorps.rename"]);
    assert.deepStrictEqual([on.tel.counts["names.renamed"], on.tel.gauges["names.renameLeft"]], [2, 0]);
    assert.ok(on.tel.observed.includes("names.renamePassMs"));
    assert.strictEqual(on.rebuilt(), 1);
    assert.strictEqual(on.pass.getStatus().state, "running");

    on.fire();
    assert.deepStrictEqual([on.records[1000001].characterName, on.records[1000003].characterName], [a, b]);
    assert.deepStrictEqual([on.v.calls.update, on.v.calls.flush.length, on.rebuilt()], [2, 1, 1]);
    assert.strictEqual(on.pass.getStatus().state, "done");
    assert.strictEqual(on.timers.filter((t) => !t.cancelled).length, 0, "no timer after done");

    const nf = rig(true, { flushFails: true });
    nf.pass.start();
    nf.fire();
    assert.deepStrictEqual([nf.tel.counts["names.renamed"], nf.tel.counts["names.renameFailed"]], [2, 1]);
    assert.match(String(nf.pass.getStatus().lastReason), /^FLUSH: /);
  });

  test("R4 crash between the vendor and the mod write -> the next pass syncs the row with the same name", () => {
    const ref = rig(true);
    ref.pass.start();
    ref.fire();
    const expected = ref.records[1000001].characterName;

    const r = rig(true);
    r.pass.start();
    r.s.ctl.boom = true;
    r.fire();
    assert.strictEqual(r.records[1000001].characterName, expected, "vendor written, deterministic name");
    assert.strictEqual(r.rows.get("f:500020:corp:0:char:0").name, "Renard Moreau 2", "row rolled back");
    assert.strictEqual(r.tel.counts["names.renameFailed"], 2);
    r.s.ctl.boom = false;
    const keysBefore = r.v.calls.update;
    r.fire();
    assert.strictEqual(r.rows.get("f:500020:corp:0:char:0").name, expected, "row synced from the vendor");
    assert.strictEqual(r.v.calls.update, keysBefore, "no new vendor write (no new pick)");
    assert.ok(r.s.tx.includes("virtualCorps.renameSync"));
    assert.strictEqual(r.rows.get("f:500020:corp:0:char:1").name, null);
  });
};
