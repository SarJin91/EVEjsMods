"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ps = require("../../lib/adapter/playerStructures");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const MOD_FILE = path.resolve(__dirname, "..", "..", "lib", "adapter", "playerStructures.js");

const HOUR = 3600 * 1000;
const NOW = 1_800_000_000_000;
const FILETIME_EPOCH = 116444736000000000n;
const toFiletime = (ms) => String(BigInt(ms) * 10000n + FILETIME_EPOCH);

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const STRUCTURE_STATE = Object.freeze({ UNKNOWN: 0, SHIELD_VULNERABLE: 110, ARMOR_REINFORCE: 111, ARMOR_VULNERABLE: 112,
  HULL_REINFORCE: 113, HULL_VULNERABLE: 114 });
const STRUCTURE_UPKEEP_STATE = Object.freeze({ FULL_POWER: 1, LOW_POWER: 2, ABANDONED: 3 });
const STRUCTURE_FAMILY = Object.freeze({ CITADEL: "citadel", ENGINEERING: "engineering", FLEX: "flex" });

function row(id, systemId, extra = {}) {
  return deepFreeze({ structureID: id, solarSystemID: systemId, typeID: 35832, structureFamily: "citadel",
    structureSize: "STRUCTURE_SIZE_MEDIUM", ownerCorpID: 98000001, allianceID: null, state: 110, stateEndsAt: 0,
    upkeepState: 1, destroyedAt: 0, name: `S${id}`, devFlags: {}, ...extra });
}

function fakeVendor(rows, opts = {}) {
  const calls = [];
  const byId = () => new Map(rows.map((r) => [r.structureID, r]));
  const modules = {
    "services/structure/structureState": {
      STRUCTURES_TABLE: "structures",
      peekStructures(o) { calls.push(["peekStructures", o]); return rows.filter((r) => !r.destroyedAt); },
      getStructureByID(id, o) { calls.push(["getStructureByID", id, o]); return byId().get(id) || null; },
      applyAdminStructureDamage(...args) {
        calls.push(["applyAdminStructureDamage", ...args]);
        return opts.hitResult || { success: true, data: { changed: true } };
      },
      resolveStructureEffectiveHitpoints: () => ({ effectiveShieldCapacity: 1000, effectiveArmorHP: 2000,
        effectiveStructureHP: 3000 }),
      resolveStructureLayerDamageLimits: () => ({ shield: 5000, armor: 5000, structure: 5000 }),
    },
    "services/structure/structureConstants": { STRUCTURE_STATE, STRUCTURE_UPKEEP_STATE, STRUCTURE_FAMILY },
    "services/structure/structureAssetSafetyState": {
      isAssetSafetyDisabledForStructure: (r) => opts.noAssetSafety === true || r.structureFamily === "flex",
    },
    "services/corporation/corporationState": {
      getCorporationRecord: (id) => (id === 98000001 ? { corporationID: id, ceoID: 90000001 } : null),
      isNpcCorporationID: (id) => id >= 1000000 && id < 2000000,
    },
    "services/corporation/corporationRuntimeState": {
      listCorporationMembers: () => (opts.members || []).map((m) => ({ ...m })),
    },
    "services/online/characterControlRuntime": {
      getCharacterControlSnapshot: (id) => Object.freeze({ characterID: id, online: (opts.online || []).includes(id) }),
    },
    "services/character/characterState": {
      peekCharacterRecord: (id) => (opts.records || {})[id] || null,
    },
    "gameStore/index": {
      flushTableSync(table) { calls.push(["flushTableSync", table]); return { success: true }; },
    },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
  return { calls, modules, seam: ps.createPlayerStructureSeam({ requireGame }) };
}

const count = (calls, name) => calls.filter((c) => c[0] === name).length;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, `${rel}.js`), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.search(new RegExp(`\\n(async )?function ${name}\\(`));
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

module.exports = ({ test, skip }) => {
  test("PST1 listCandidates: frozen live rows, only player rows of the families, sorted; TTL memory of the facade", () => {
    const rows = [
      row(1005, 30000002),
      row(1001, 30000009, { devFlags: { lneStationId: "upw-1", lneWorld: 1 } }),
      row(1002, 30000001, { ownerCorpID: 1000125 }),
      row(1003, 30000001, { destroyedAt: NOW - 5 }),
      row(1004, 30000001, { structureFamily: "flex" }),
      row(1006, 30000001, { allianceID: 99000001, state: 112, stateEndsAt: NOW + HOUR }),
    ];
    const { calls, seam } = fakeVendor(rows);
    const opts = { nowMs: NOW, ttlMs: 60000, families: ["citadel", "engineering"], maxStructures: 10 };
    const r = seam.listCandidates(opts);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([...r.bySystem.keys()], [30000001, 30000002]);
    assert.deepStrictEqual(r.bySystem.get(30000001).map((s) => s.structureId), [1006]);
    assert.deepStrictEqual(r.bySystem.get(30000001)[0], { structureId: 1006, systemId: 30000001, typeId: 35832,
      family: "citadel", size: "STRUCTURE_SIZE_MEDIUM", ownerCorpId: 98000001, allianceId: 99000001,
      state: "ARMOR_VULNERABLE", stateEndsAt: NOW + HOUR, trig: false });
    assert.deepStrictEqual([r.total, r.truncated, r.builtAt], [2, false, NOW]);
    assert.strictEqual(r.bySystem.get(30000002)[0].stateEndsAt, null, "vendor 0 -> null");
    assert.strictEqual(count(calls, "peekStructures"), 1);
    r.bySystem.clear();
    const again = seam.listCandidates({ ...opts, nowMs: NOW + 59999 });
    assert.strictEqual(count(calls, "peekStructures"), 1);
    assert.strictEqual(again.total, 2);
    assert.strictEqual(again.bySystem.size, 2);
    const late = seam.listCandidates({ ...opts, nowMs: NOW + 60000, maxStructures: 1 });
    assert.strictEqual(count(calls, "peekStructures"), 2);
    assert.deepStrictEqual([late.total, late.truncated, [...late.bySystem.keys()]], [1, true, [30000001]]);
    assert.deepStrictEqual(seam.listCandidates({ ...opts, families: "citadel" }),
      { ok: false, reason: "INVALID_INPUT", detail: "families" });
  });

  test("PST2 applySiegeHit compare-and-set: ARMOR_REINFORCE + armor -> STATE_MISMATCH without a write; "
    + "ARMOR_VULNERABLE -> one vendor call (id, 'armor', 1, {}) and one flush", () => {
    const rows = [row(2001, 30000001, { state: 111 })];
    const { calls, seam } = fakeVendor(rows);
    assert.deepStrictEqual(seam.applySiegeHit(2001, "armor"),
      { ok: false, reason: "STATE_MISMATCH", state: "ARMOR_REINFORCE" });
    assert.strictEqual(count(calls, "applyAdminStructureDamage") + count(calls, "flushTableSync"), 0);
    rows[0] = row(2001, 30000001, { state: 112 });
    const r = seam.applySiegeHit(2001, "armor");
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(calls.filter((c) => c[0] === "applyAdminStructureDamage"),
      [["applyAdminStructureDamage", 2001, "armor", 1, {}]]);
    assert.deepStrictEqual(calls.filter((c) => c[0] === "flushTableSync"), [["flushTableSync", "structures"]]);
    assert.deepStrictEqual([r.destroyed, r.flushed, r.view.state, r.view.ehp.armor, r.view.damageLimit.hull],
      [false, true, "ARMOR_VULNERABLE", 2000, 5000]);
    assert.ok(calls.filter((c) => c[0] === "getStructureByID").every((c) => c[2] && c[2].refresh === false));
  });

  test("PST3 hull: no asset safety (FLEX/WH or ABANDONED) -> ASSET_SAFETY_UNAVAILABLE without a write; "
    + "a vendor destroy -> destroyed:true", () => {
    const rows = [row(3001, 31000005, { state: 114 })];
    const noSafety = fakeVendor(rows, { noAssetSafety: true });
    assert.deepStrictEqual(noSafety.seam.applySiegeHit(3001, "hull"), { ok: false, reason: "ASSET_SAFETY_UNAVAILABLE" });
    assert.strictEqual(count(noSafety.calls, "applyAdminStructureDamage"), 0);
    const abandoned = fakeVendor([row(3002, 30000001, { state: 114, upkeepState: 3 })]);
    assert.deepStrictEqual(abandoned.seam.applySiegeHit(3002, "hull"), { ok: false, reason: "ASSET_SAFETY_UNAVAILABLE" });
    assert.strictEqual(count(abandoned.calls, "applyAdminStructureDamage"), 0);
    const live = [row(3003, 30000001, { state: 114 })];
    const ok = fakeVendor(live, { hitResult: { success: true, data: { destroy: true, changed: true } } });
    const r = ok.seam.applySiegeHit(3003, "hull");
    assert.deepStrictEqual([r.ok, r.destroyed, r.flushed], [true, true, true]);
    assert.deepStrictEqual(ok.calls.filter((c) => c[0] === "applyAdminStructureDamage"),
      [["applyAdminStructureDamage", 3003, "hull", 1, {}]]);
  });

  test("PST4 readOwnerActivity: lastLogoff 47 h ago -> lastSeenMs, online snapshot -> onlineNow, maxMembers 1 of 2 "
    + "-> truncated, a record without history -> lastSeenMs null", () => {
    const seen = NOW - 47 * HOUR;
    const members = [{ characterID: 90000001 }, { characterID: 90000002 }];
    const a = fakeVendor([], { members, online: [90000002],
      records: { 90000001: { lastLogonDateTime: toFiletime(seen - HOUR), lastLogoffDateTime: toFiletime(seen) } } });
    assert.deepStrictEqual(a.seam.readOwnerActivity(98000001, { maxMembers: 5 }),
      { ok: true, onlineNow: true, lastSeenMs: seen, members: 2, truncated: false });
    assert.deepStrictEqual(a.seam.readOwnerActivity(98000001, { maxMembers: 1 }),
      { ok: true, onlineNow: false, lastSeenMs: seen, members: 1, truncated: true });
    const b = fakeVendor([], { members: [{ characterID: 90000003 }], records: { 90000003: { characterID: 90000003 } } });
    assert.deepStrictEqual(b.seam.readOwnerActivity(98000001, { maxMembers: 5 }),
      { ok: true, onlineNow: false, lastSeenMs: null, members: 1, truncated: false });
    assert.deepStrictEqual(a.seam.readOwnerFace(98000001), { ok: true, ceoId: 90000001, npc: false });
    const throwing = (code) => {
      const v = fakeVendor([], { members: [{ characterID: 90000004 }] });
      v.modules["services/online/characterControlRuntime"].getCharacterControlSnapshot = () => {
        const err = new Error("control"); if (code) err.code = code; throw err;
      };
      return v.seam.readOwnerActivity(98000001, { maxMembers: 5 });
    };
    assert.deepStrictEqual(throwing("CHARACTER_CONTROL_UNAVAILABLE"),
      { ok: true, onlineNow: true, lastSeenMs: null, members: 1, truncated: false });
    for (const code of ["CHARACTER_LEASE_EXPIRED", undefined]) {
      const r = throwing(code);
      assert.deepStrictEqual([r.ok, r.reason], [false, "SEAM_ERROR"], String(code));
    }
  });

  const statePath = path.join(SERVER_SRC, "services", "structure", "structureState.js");
  if (!fs.existsSync(statePath)) {
    skip("PST5 player structures vendor facts", "server/src not found");
    return;
  }
  test("PST5 vendor facts: exports of every seam module (no Object.freeze of module.exports), amount trap, "
    + "destroyed rows kept, session only for the GM bypass; calls of the seam within REQUIRED", () => {
    const exportBlock = (source) => {
      const assign = source.lastIndexOf("\nObject.assign(module.exports, {");
      const literal = source.lastIndexOf("\nmodule.exports = {");
      return source.slice(Math.max(assign, literal));
    };
    const problems = [];
    for (const [key, rel] of Object.entries(ps.PATHS)) {
      const source = readSource(rel);
      if (/Object\.freeze\(\s*module\.exports/.test(source)) problems.push(`${rel}: Object.freeze(module.exports`);
      const form = rel === "services/structure/structureState" ? "\nObject.assign(module.exports, {"
        : "\nmodule.exports = {";
      if (!source.includes(form)) problems.push(`${rel}: export form ${form.trim()}`);
      const block = exportBlock(source);
      const names = rel === "services/structure/structureConstants" ? Object.keys(ps.REQUIRED_CONSTANTS)
        : rel === "services/structure/structureState" ? [...ps.REQUIRED[key], "STRUCTURES_TABLE"] : ps.REQUIRED[key];
      for (const name of names) {
        if (rel === "services/online/characterControlRuntime") {
          const factory = source.lastIndexOf("\n  return Object.freeze({", source.lastIndexOf("\nmodule.exports = {"));
          if (!/\n {2}\.\.\.defaultRuntime,/.test(block) || !source.slice(factory).includes(`\n    ${name},`)) {
            problems.push(`${rel}.${name}`);
          }
        } else if (!new RegExp(`\\n {2}${name},`).test(block)) {
          problems.push(`${rel}.${name}`);
        }
      }
    }
    assert.deepStrictEqual(problems, []);
    const state = readSource("services/structure/structureState");
    const hit = bodyOf(state, "applyAdminStructureDamage");
    assert.ok(hit.includes("normalizedAmount <= 0"), "pin of the amount trap");
    assert.ok(hit.includes("normalizedAmount <= 1 && maxValue > 0"), "amount <= 1 = fraction of the layer");
    assert.ok(/peekStructures\(options = \{\}\) \{\n\s+const rows = ensureStructureCache\(\)\.rows;/.test(state),
      "peekStructures: live rows, no tick");
    const destroy = bodyOf(state, "destroyStructure");
    assert.ok(/updateStructureRecord\(structureID, \(currentStructure\) => \(\{\n\s+\.\.\.currentStructure,\n\s+destroyedAt: nowMs,/
      .test(destroy), "destroyStructure keeps the row (destroyedAt), byStructureID still finds it");
    const safety = readSource("services/structure/structureAssetSafetyState");
    const handle = bodyOf(safety, "handleStructureDestroyed");
    assert.deepStrictEqual(handle.match(/options\.session/g), ["options.session"], "session only for the GM bypass");
    assert.ok(handle.includes("hasStructureGmBypass(options.session)"));
    const control = readSource("services/online/characterControlRuntime");
    assert.ok(/\n {4}online: controlState !== CONTROL_STATES\.OFFLINE,/.test(control), "snapshot.online");
    assert.ok(control.includes('UNAVAILABLE: "CHARACTER_CONTROL_UNAVAILABLE"'), "control UNAVAILABLE code");
    const mine = fs.readFileSync(MOD_FILE, "utf8");
    const called = new Set([...mine.matchAll(/vendor\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`));
    const required = new Set(Object.entries(ps.REQUIRED).flatMap(([k, fns]) => fns.map((f) => `${k}.${f}`)));
    assert.ok(called.size >= 10, [...called].join(","));
    assert.deepStrictEqual([...called].filter((c) => !required.has(c)), []);
  });
};
