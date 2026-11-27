"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { moveFreeCharacterWith, setCorporationDescriptionWith } = require("../../lib/adapter/freeCorpRecycle");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const CONSUMER = "freeCorpsRecycle";

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function body(src, head, nextHead) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, head);
  const end = src.indexOf(nextHead, at + head.length);
  return src.slice(at, end > at ? end : undefined);
}

function fakeVendor(chars) {
  const corpOf = new Map(Object.entries(chars).map(([k, v]) => [Number(k), v]));
  const rosters = new Map();
  const calls = [];
  const roster = (corp) => {
    if (!rosters.has(corp)) rosters.set(corp, {});
    return rosters.get(corp);
  };
  for (const [c, corp] of corpOf) roster(corp)[String(c)] = { characterID: c };
  const mods = {
    characterState: { peekCharacterRecord: (id) => (corpOf.has(id) ? { corporationID: corpOf.get(id) } : null) },
    corporationState: {
      getCorporationRecord: (id) => (id > 0 && id !== 404 ? { corporationID: id, description: "old" } : null),
      setCharacterAffiliation: (id, corp) => {
        calls.push(`setCharacterAffiliation:${id}:${corp}`);
        corpOf.set(id, corp);
        return { success: true };
      } },
    corporationRuntimeState: {
      ensureCharacterMemberState: (corp, id) => {
        calls.push(`ensureCharacterMemberState:${corp}:${id}`);
        roster(corp)[String(id)] = { characterID: id };
      },
      getCorporationMember: (corp, id) => roster(corp)[String(id)] || null,
      updateCorporationRuntime: (corp, updater) => {
        calls.push(`updateCorporationRuntime:${corp}`);
        rosters.set(corp, updater({ members: { ...roster(corp) } }).members);
        return { success: true };
      },
      updateCorporationRecord: (id, changes) => {
        calls.push(`updateCorporationRecord:${id}:${changes.description}`);
        return { success: true };
      } } };
  return { mods, calls, corpOf, rosters };
}

module.exports = ({ test }) => {
  test("RC1 vendor facts of the affiliation / employment history / roster cleanup, GAME_MODULES consumer "
    + "moveFreeCharacterWith order and peek, description no-op, blind adapter", () => {
    const cs = readSource("services/corporation/corporationState.js");
    const aff = body(cs, "\nfunction setCharacterAffiliation(characterID, corporationID, allianceID = null, "
      + "{ durable = false } = {}) {", "\nfunction ");
    const changed = aff.indexOf("corporationChanged &&");
    assert.ok(changed >= 0 && aff.indexOf("employmentHistory.push(", changed) > changed,
      "the history is pushed behind corporationChanged");
    const svc = readSource("services/corporation/corpService.js");
    const rec = body(svc, "Handle_GetEmploymentRecord(args, session) {", "\n  Handle_");
    assert.ok(rec.includes("charData.employmentHistory"), "Show Info reads employmentHistory");
    const reg = readSource("services/corporation/corpRegistryRuntime.js");
    const move = body(reg, "\nfunction moveCharacterToCorporation(", "\nfunction ");
    const a = move.indexOf("setCharacterAffiliation(");
    assert.ok(a >= 0 && move.indexOf("delete runtime.members[String(characterID)]", a) > a,
      "the vendor deletes the source entry after the affiliation");
    const rt = readSource("services/corporation/corporationRuntimeState.js");
    const exp = rt.slice(rt.search(/^module\.exports = \{/m));
    for (const name of ["updateCorporationRuntime", "getCorporationMember", "updateCorporationRecord",
      "ensureCharacterMemberState"]) {
      assert.match(exp, new RegExp(`^ {2}${name},$`, "m"), name);
    }

    assert.ok(!MODULE_NAMES.includes(CONSUMER), "freeCorpsRecycle is not a module name");
    const want = [["services/character/characterState", "peekCharacterRecord"],
      ["services/corporation/corporationState", "getCorporationRecord"],
      ["services/corporation/corporationState", "setCharacterAffiliation"],
      ["services/corporation/corporationRuntimeState", "ensureCharacterMemberState"],
      ["services/corporation/corporationRuntimeState", "getCorporationMember"],
      ["services/corporation/corporationRuntimeState", "updateCorporationRuntime"],
      ["services/corporation/corporationRuntimeState", "updateCorporationRecord"]];
    for (const [p, name] of want) {
      const syms = GAME_MODULES.filter((e) => e.path === p).flatMap((e) => e.symbols)
        .filter((s) => s.name === name && s.consumers.includes(CONSUMER));
      assert.strictEqual(syms.length, 1, `${p}.${name}`);
      assert.ok(syms[0].kind === "export" && syms[0].wrap !== true && syms[0].firstLoad !== true, name);
    }

    const va = fakeVendor({ 11: 2 });
    assert.deepStrictEqual(moveFreeCharacterWith(va.mods, { characterId: 11, toCorporationId: 2, fromHint: 1,
      cleanSource: true }), { ok: true, already: true, cleaned: false });
    assert.strictEqual(va.calls.filter((c) => c.startsWith("setCharacterAffiliation")).length, 0);
    const vb = fakeVendor({ 12: 1 });
    assert.deepStrictEqual(moveFreeCharacterWith(vb.mods, { characterId: 12, toCorporationId: 2, fromHint: 0,
      cleanSource: true }), { ok: true, already: false, cleaned: true });
    assert.deepStrictEqual(vb.calls, ["setCharacterAffiliation:12:2", "ensureCharacterMemberState:2:12",
      "updateCorporationRuntime:1"]);
    assert.strictEqual(vb.rosters.get(1)["12"], undefined, "the source roster lost the entry");
    assert.deepStrictEqual(moveFreeCharacterWith(vb.mods, { characterId: 12, toCorporationId: 2, fromHint: 1,
      cleanSource: true }), { ok: true, already: true, cleaned: false });
    assert.strictEqual(vb.calls.length, 3);
    assert.strictEqual(moveFreeCharacterWith(vb.mods, { characterId: 99, toCorporationId: 2, fromHint: 1,
      cleanSource: true }).reason, "CHARACTER_MISSING");
    assert.strictEqual(moveFreeCharacterWith(vb.mods, { characterId: 12, toCorporationId: 404, fromHint: 1,
      cleanSource: true }).reason, "TARGET_MISSING");
    const vd = fakeVendor({ 13: 1 });
    assert.deepStrictEqual(moveFreeCharacterWith(vd.mods, { characterId: 13, toCorporationId: 2, fromHint: 0,
      cleanSource: false }), { ok: true, already: false, cleaned: false });
    assert.ok(!vd.calls.some((c) => c.startsWith("updateCorporationRuntime")));
    assert.strictEqual(moveFreeCharacterWith(vd.mods, { characterId: 13, toCorporationId: 2 }).reason, "INVALID_INPUT");

    const ve = fakeVendor({});
    assert.deepStrictEqual(setCorporationDescriptionWith(ve.mods, 2, "old"), { ok: true, changed: false });
    assert.strictEqual(ve.calls.length, 0);
    assert.deepStrictEqual(setCorporationDescriptionWith(ve.mods, 2, "Disbanded 2033-05-18"), { ok: true, changed: true });
    assert.deepStrictEqual(ve.calls, ["updateCorporationRecord:2:Disbanded 2033-05-18"]);
    assert.strictEqual(setCorporationDescriptionWith(ve.mods, 404, "x").reason, "TARGET_MISSING");

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.deepStrictEqual(blind.freeCorpRecycleSeams(), { ok: true });
    const m = blind.moveFreeCharacter({ characterId: 1, toCorporationId: 2, fromHint: 0, cleanSource: true });
    assert.deepStrictEqual([m.ok, m.reason], [false, "SEAM_UNAVAILABLE"]);
    const d = blind.setCorporationDescription(2, "x");
    assert.deepStrictEqual([d.ok, d.reason], [false, "SEAM_UNAVAILABLE"]);
  });
};
