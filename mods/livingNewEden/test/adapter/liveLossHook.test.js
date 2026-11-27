"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const hook = require("../../lib/adapter/liveLossHook");

module.exports = ({ test }) => {
  test("LH1 liveLossHook: a foreign wrapper symbol survives our wrap, the sink gets (entity, result) once and "
    + "the original result is returned; a second bindSink -> SINK_BOUND; after unbind the sink is silent", () => {
    const S = Symbol("npcKillsGiveSp.wrapped");
    const calls = [];
    const foreign = (name) => {
      const fn = function foreignWrapper(entity, result) {
        calls.push([name, this === exportsObj, entity.itemID, result.success]);
        return `vendor:${name}`;
      };
      fn[S] = true;
      return fn;
    };
    const exportsObj = { recordKillmailFromDestruction: foreign("record"),
      enqueueKillmailFromDestruction: foreign("enqueue") };
    assert.strictEqual(hook.checkHookInstalled(exportsObj), false);
    const r = hook.install(exportsObj);
    assert.deepStrictEqual(r, { ok: true, installed: true,
      methods: ["recordKillmailFromDestruction", "enqueueKillmailFromDestruction"] });
    for (const m of hook.METHODS) {
      assert.strictEqual(exportsObj[m][S], true, `${m}: the foreign symbol is visible on our wrapper`);
      assert.strictEqual(exportsObj[m][hook.WRAPPED], true, m);
    }
    assert.strictEqual(hook.checkHookInstalled(exportsObj), true);
    assert.strictEqual(hook.install(exportsObj).alreadyInstalled, true);

    const seen = [];
    const killers = [];
    const bound = hook.bindSink((entity, result, killer) => {
      seen.push([entity.itemID, result.success]);
      killers.push(killer.killerCharacterId);
    });
    assert.strictEqual(bound.ok, true, JSON.stringify(bound));
    try {
      assert.deepStrictEqual(hook.bindSink(() => {}), { ok: false, reason: "SINK_BOUND" });
      assert.deepStrictEqual(hook.bindSink(null), { ok: false, reason: "SINK_INVALID" });
      const out = exportsObj.recordKillmailFromDestruction({ itemID: 5001 }, { success: true }, { whenMs: 1 });
      assert.strictEqual(out, "vendor:record");
      assert.deepStrictEqual(calls, [["record", true, 5001, true]], "the original runs once with this and args");
      assert.deepStrictEqual(seen, [[5001, true]]);
      exportsObj.recordKillmailFromDestruction({ itemID: 5004 }, { success: true },
        { attackerEntity: { pilotCharacterID: 90000001, characterID: 7 } });
      exportsObj.recordKillmailFromDestruction({ itemID: 5005 }, { success: true },
        { attackerIdentity: { characterID: 90000002 }, attackerEntity: { characterID: 7 } });
      assert.deepStrictEqual(killers, [null, 90000001, 90000002]);
      seen.length = 1;
      calls.length = 1;
    } finally {
      bound.unbind();
    }
    exportsObj.enqueueKillmailFromDestruction({ itemID: 5002 }, { success: true });
    assert.strictEqual(seen.length, 1, "after unbind the sink is not called");
    assert.strictEqual(calls.length, 2);
    const bad = hook.bindSink(() => { throw new Error("boom"); });
    try {
      assert.strictEqual(exportsObj.enqueueKillmailFromDestruction({ itemID: 5003 }, { success: true }),
        "vendor:enqueue");
    } finally {
      bad.unbind();
    }
  });

  test("LH3: addListener is additive (the sink still gets the call, a throwing "
    + "listener is counted, never reaches the game), removeListener silences it; lossFactsOf on the vendor shape of "
    + "killmailTracker.js (victim pilotCharacterID ?? characterID, typeID, killID of the record / receipt)", () => {
    const record = function vendorRecord() {
      return { killID: 77 };
    };
    const exportsObj = { recordKillmailFromDestruction: record,
      enqueueKillmailFromDestruction: function vendorEnqueue() { return { success: true, killID: 78 }; } };
    hook.install(exportsObj);
    const sink = [];
    const seen = [];
    const bound = hook.bindSink((e) => sink.push(e.itemID));
    const before = hook.listenerStats().listenerErrors;
    const a = hook.addListener((e, r, out) => seen.push(hook.lossFactsOf(e, r, out)));
    const b = hook.addListener(() => { throw new Error("boom"); });
    try {
      const pilot = { itemID: 6001, typeID: 587, systemID: 30000142, pilotCharacterID: 9001 };
      assert.deepStrictEqual(exportsObj.recordKillmailFromDestruction(pilot, { success: true }), { killID: 77 });
      exportsObj.enqueueKillmailFromDestruction({ itemID: 6002, typeID: 670, characterID: 9001 }, { success: true });
      assert.deepStrictEqual(sink, [6001, 6002], "the sink of the materialization is untouched");
      assert.deepStrictEqual(seen, [
        { victimCharacterId: 9001, shipTypeId: 587, itemId: 6001, killId: 77, systemId: 30000142, copy: false,
          copyName: null },
        { victimCharacterId: 9001, shipTypeId: 670, itemId: 6002, killId: 78, systemId: null, copy: false,
          copyName: null }]);
      assert.strictEqual(hook.listenerStats().listenerErrors, before + 2, "the throwing listener is counted");
      assert.strictEqual(hook.lossFactsOf({ itemID: 1, pilotCharacterID: 0 }, { success: true }, null), null);
      assert.strictEqual(hook.lossFactsOf({ itemID: 1, characterID: 5 }, { success: false }, null), null);
      assert.strictEqual(hook.lossFactsOf({ itemID: 1, session: { characterID: 5 } }, { success: true }, null)
        .victimCharacterId, 5);
      for (const kind of ["drone", "Fighter", "structure"]) {
        assert.strictEqual(hook.lossFactsOf({ kind, itemID: 2, typeID: 2488, characterID: 9001 }, { success: true },
          null), null, kind);
      }
      assert.strictEqual(hook.lossFactsOf({ kind: "ship", itemID: 3, characterID: 9001 }, { success: true }, null)
        .victimCharacterId, 9001);
    } finally {
      a.remove();
      b.remove();
      bound.unbind();
    }
    exportsObj.recordKillmailFromDestruction({ itemID: 6003, characterID: 9001 }, { success: true });
    assert.strictEqual(seen.length, 2, "after remove the listener is silent");
    assert.deepStrictEqual(hook.addListener(null), { ok: false, reason: "LISTENER_INVALID" });

    const file = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "combat",
      "killmailTracker.js");
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const needle of ["targetEntity.pilotCharacterID ?? targetEntity.characterID",
      "victimShipTypeID: toPositiveInt(targetEntity.typeID, null)", "{ killID: receipt.killID }",
      "if (!targetEntity || !destroyResult || destroyResult.success !== true) {"]) {
      assert.ok(text.includes(needle), `killmailTracker.js: ${needle}`);
    }
  });

  test("LH4 the vendor shape of a destroyed player ship (pilot 0, character "
    + "0, session null, ownerID = the character) -> victim = ownerID only when isCharacter says so; an NPC hull or a "
    + "faction corp owner -> null; a ShipWing copy stays copy:true", () => {
    const PLAYER = 90000001;
    const isCharacter = (id) => id === PLAYER;
    const lost = { kind: "ship", itemID: 7001, typeID: 587, systemID: 30000142, pilotCharacterID: 0, characterID: 0,
      session: null, ownerID: PLAYER };
    assert.deepStrictEqual(hook.lossFactsOf(lost, { success: true }, { killID: 91 }, { isCharacter }),
      { victimCharacterId: PLAYER, shipTypeId: 587, itemId: 7001, killId: 91, systemId: 30000142, copy: false,
        copyName: null });
    assert.strictEqual(hook.lossFactsOf(lost, { success: true }, null), null, "no isCharacter -> no fallback");
    assert.strictEqual(hook.lossFactsOf({ ...lost, ownerID: 1000125 }, { success: true }, null, { isCharacter }), null,
      "a faction corp owner is no victim");
    for (const npc of [{ nativeNpc: true }, { nativeNpcOccupied: true }, { npcEntityType: "NPC" },
      { npcEntityType: "concord" }]) {
      assert.strictEqual(hook.lossFactsOf({ ...lost, ...npc }, { success: true }, null, { isCharacter: () => true }),
        null, JSON.stringify(npc));
    }
    assert.strictEqual(hook.lossFactsOf(lost, { success: true }, null, { isCharacter: () => { throw new Error("x"); } }),
      null, "a throwing check is no victim");
    const copy = { kind: "ship", transient: true, itemID: 7002, typeID: 16227, characterID: 0, pilotCharacterID: PLAYER,
      ownerID: PLAYER, itemName: "Ferox", session: null, destroying: true };
    const facts = hook.lossFactsOf(copy, { success: true }, null, { isCharacter });
    assert.strictEqual(facts.victimCharacterId, PLAYER);
    assert.strictEqual(facts.copy, true);
    assert.strictEqual(facts.copyName, "Ferox");

    const file = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "space", "combat",
      "killmailTracker.js");
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    for (const needle of ["?? resolveVictimCharacterIDFromOwner(targetEntity);",
      "if (!ownerID || !resolveCharacterRecord(ownerID)) {", "entity.nativeNpcOccupied === true ||"]) {
      assert.ok(text.includes(needle), `killmailTracker.js: ${needle}`);
    }
  });
};
