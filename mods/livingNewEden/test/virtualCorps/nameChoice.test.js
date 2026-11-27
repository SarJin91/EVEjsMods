"use strict";

const assert = require("node:assert");

const { processStep } = require("../../lib/virtualCorps/identitySaga");
const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");
const { chooseCharacterName } = require("../../lib/virtualCorps/nameChoice");
const names = require("../../lib/names");

const KEY = "f:500020:corp:0:char:1";
const CHAR_ID = 1000003;
const RACE = 8;

function rig(namesOpts, { record = null } = {}) {
  const rows = new Map([[KEY, { identity_key: KEY, kind: "character", state: IDENTITY_STATES.RESERVED,
    evejs_id: CHAR_ID, version: 1 }]]);
  const calls = { pick: [], keys: 0, validate: [], noted: [], written: [] };
  const repo = {
    getByKey: (k) => (rows.has(k) ? { ok: true, row: { ...rows.get(k) } } : { ok: false, reason: "NOT_FOUND" }),
    updateState: (k, version, state, extra) => {
      const row = rows.get(k);
      if (row.version !== version) return { ok: false, reason: "CAS_FAILED" };
      rows.set(k, { ...row, state, version: version + 1, evejs_id: extra.evejsId || row.evejs_id });
      return { ok: true };
    },
  };
  const adapter = {
    pickCharacterName: (raceId) => { calls.pick.push(raceId); return { ok: true, name: "Renard Moreau 2" }; },
    resolveCharacterCreationBloodlineProfile: () => ({ ok: true, raceId: RACE, typeId: 101 }),
    writeCharacter: (rec) => { calls.written.push(rec); return { ok: true }; },
    peekCharacterRecord: () => ({ ok: true, record }),
    characterNameKeys: () => { calls.keys += 1; return { ok: true, keys: new Set() }; },
    validateCharacterName: (name) => { calls.validate.push(name); return { ok: true, valid: true, code: 1 }; },
    noteCharacterNameTaken: (name) => { calls.noted.push(name); return { ok: true }; },
  };
  const ctx = { adapter, repo, logger: { log: () => {} }, config: {}, fail: () => ({ ok: false }),
    clock: { now: () => 1000000 }, ...(namesOpts ? { names: namesOpts } : {}) };
  const ctxState = { corpIds: [2000001], charIds: [], corp0Id: 2000001 };
  const step = () => processStep(ctx, { ...rows.get(KEY) }, { bloodlineIds: [5] }, ctxState);
  return { calls, step, row: () => rows.get(KEY) };
}

const ON = Object.freeze({ characterNamesEnabled: true, worldSeed: 77, maxAttempts: 48, tel: null });

module.exports = ({ test }) => {
  test("N4 identity saga name source: off = vendor pickCharacterName(raceId); on = lib/names; record reused; "
    + "no world seed transient", async () => {
    const off = rig({ characterNamesEnabled: false, worldSeed: 77, maxAttempts: 48, tel: null });
    const offRes = await off.step();
    assert.ok(offRes.ok, JSON.stringify(offRes));
    assert.deepStrictEqual(off.calls.pick, [RACE]);
    assert.strictEqual(off.calls.keys, 0);
    assert.strictEqual(off.calls.written[0].characterName, "Renard Moreau 2");
    assert.strictEqual(off.row().state, IDENTITY_STATES.CREATED);
    const noNames = rig(null);
    assert.ok((await noNames.step()).ok);
    assert.deepStrictEqual(noNames.calls.pick, [RACE], "no names options = flag off");

    const on = rig(ON);
    const onRes = await on.step();
    assert.ok(onRes.ok, JSON.stringify(onRes));
    assert.deepStrictEqual(on.calls.pick, []);
    const written = on.calls.written[0];
    assert.strictEqual(written.gender, "Male");
    assert.ok(!/[0-9]/.test(written.characterName), written.characterName);
    const expected = names.pickName({ worldSeed: 77, entityKey: KEY, style: "gallente", nicknames: true,
      gender: "Male", isTaken: () => false, maxAttempts: 48 });
    assert.strictEqual(written.characterName, expected.name, "Serpentis -> gallente style, deterministic");
    assert.deepStrictEqual(on.calls.validate, [expected.name]);
    assert.deepStrictEqual(on.calls.noted, [expected.name]);
    assert.strictEqual(on.row().state, IDENTITY_STATES.CREATED);

    const reuse = rig(ON, { record: { characterId: CHAR_ID, lneIdentityKey: KEY, characterName: "Aveline Bardot" } });
    assert.ok((await reuse.step()).ok);
    assert.strictEqual(reuse.calls.keys, 0);
    assert.strictEqual(reuse.calls.written[0].characterName, "Aveline Bardot");

    const noSeed = rig({ ...ON, worldSeed: undefined });
    const noSeedRes = await noSeed.step();
    assert.deepStrictEqual({ ok: noSeedRes.ok, reason: noSeedRes.reason, refused: noSeedRes.refused },
      { ok: false, reason: "NO_WORLD_SEED", refused: undefined });
    assert.strictEqual(noSeed.row().state, IDENTITY_STATES.RESERVED);
    assert.deepStrictEqual(noSeed.calls.written, []);

    let n = 0;
    const res = chooseCharacterName({ adapter: { characterNameKeys: () => ({ ok: true, keys: new Set() }),
      validateCharacterName: () => { n += 1; return { ok: true, valid: n > 1, code: n > 1 ? 1 : -101 }; },
      noteCharacterNameTaken: () => ({ ok: true }) }, worldSeed: 77, settings: { maxAttempts: 48 } },
    { identityKey: KEY, characterId: CHAR_ID, ownerKind: "faction", ownerId: 500020, raceId: RACE, gender: "Male" });
    assert.ok(res.ok && res.attempt === 1 && res.reused === false, JSON.stringify(res));
  });
};
