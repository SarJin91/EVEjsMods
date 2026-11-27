"use strict";

const assert = require("node:assert");

const { ensureIdentity } = require("../../lib/shipAi/identity");
const { createShipAiPrefsRepository } = require("../../lib/shipAi/prefsRepository");
const { parseAllowlist, shipAiSettingsOf } = require("../../lib/shipAi/schema");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY } = require("../../lib/persistence/worldReset");
const SH = require("../notices/storeHelper");

const P1 = 9001;
const P2 = 9002;
const FIRST_ID = 91000001;

function fakeIdentities() {
  const records = new Map();
  const fail = { write: 0, flush: 0 };
  let next = FIRST_ID;
  return {
    records,
    fail,
    reserveCharacterId: () => ({ ok: true, characterId: next++ }),
    writeCharacter: (rec) => {
      if (fail.write > 0) {
        fail.write -= 1;
        return { ok: false, reason: "WRITE_FAILED: crash" };
      }
      records.set(rec.characterId, { ...rec });
      return { ok: true };
    },
    flush: () => {
      if (fail.flush > 0) {
        fail.flush -= 1;
        return { ok: false, reason: "FLUSH_FAILED: crash" };
      }
      return { ok: true };
    },
    findByMarker: (key) => {
      const hit = [...records.values()].find((r) => r.lneIdentityKey === key);
      return hit ? { ok: true, found: true, characterId: hit.characterId, name: hit.characterName }
        : { ok: true, found: false };
    },
  };
}

const SETTINGS = Object.freeze({ defaultName: "Jin", bio: "bio", corporationId: 1000169, maxIdentities: 2 });

module.exports = ({ test, skip }) => {
  test("SAI5a settings: allowlist \"\" / \"*\" / ids / garbage, shipAiSettingsOf shapes", () => {
    assert.deepStrictEqual([parseAllowlist("").all, parseAllowlist("").ids.size], [false, 0]);
    assert.deepStrictEqual([parseAllowlist(" * ").all], [true]);
    assert.deepStrictEqual([...parseAllowlist("9001, 9002").ids], [9001, 9002]);
    assert.deepStrictEqual(parseAllowlist("9001,abc"), { ok: false, reason: "INVALID_SETTINGS",
      detail: "allowCharacterIds: abc" });
    assert.deepStrictEqual(shipAiSettingsOf({}), { ok: false, reason: "INVALID_SETTINGS", detail: "shipAi section" });
    const ok = shipAiSettingsOf({ shipAi: { enabled: true, channel: "private", allowCharacterIds: "*",
      defaultName: " Jin ", bio: "", corporationId: 1000169, maxIdentities: 16, minIntervalMs: 0,
      xmppMaxBatchBytes: 32768 } });
    assert.deepStrictEqual([ok.ok, ok.settings.defaultName, ok.settings.allow.all], [true, "Jin", true]);
  });

  const driver = SH.loadDriver();
  const name = "SAI5 identity: crash after reserve / after write -> the retry (new repository) finds or creates ONE "
    + "record by the marker shipai:<id>; the row is the fast path; limit -> IDENTITY_LIMIT; migration 84, reset KEEP";
  if (!driver.ok) {
    skip(name, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(name, () => SH.withStore(driver, (persistence) => {
    const store = persistence.store;
    const ids = fakeIdentities();
    const deps = () => ({ store, repo: createShipAiPrefsRepository(), settings: SETTINGS, identities: ids,
      nowMs: () => 5000 });
    const rows = () => store.transaction("t", (db) => db.prepare("SELECT player_character_id AS p, "
      + "ai_character_id AS a FROM ship_ai_prefs ORDER BY p").all().map((r) => [Number(r.p), Number(r.a)])).value;

    ids.fail.write = 1;
    const r1 = ensureIdentity(deps(), P1);
    assert.deepStrictEqual([r1.ok, r1.reason], [false, "IDENTITY_FAILED"]);
    assert.ok(r1.detail.startsWith("write:"), r1.detail);
    assert.deepStrictEqual([ids.records.size, rows()], [0, []]);
    const r2 = ensureIdentity(deps(), P1);
    assert.deepStrictEqual(r2, { ok: true, aiId: FIRST_ID + 1, name: "Jin", created: true });
    assert.deepStrictEqual(rows(), [[P1, FIRST_ID + 1]]);
    const rec = ids.records.get(FIRST_ID + 1);
    assert.deepStrictEqual([rec.characterName, rec.corporationID, rec.gender, rec.typeID, rec.lneIdentityKey,
      rec.description], ["Jin", 1000169, 0, 1373, `shipai:${P1}`, "bio"]);
    assert.deepStrictEqual(ensureIdentity(deps(), P1), { ok: true, aiId: FIRST_ID + 1, name: "Jin", created: false },
      "the row is the fast path");

    ids.fail.flush = 1;
    const r3 = ensureIdentity(deps(), P2);
    assert.deepStrictEqual([r3.ok, r3.reason], [false, "IDENTITY_FAILED"]);
    assert.deepStrictEqual([ids.records.size, rows().length], [2, 1]);
    const r4 = ensureIdentity(deps(), P2);
    assert.deepStrictEqual(r4, { ok: true, aiId: FIRST_ID + 2, name: "Jin", created: false });
    assert.deepStrictEqual([ids.records.size, rows()], [2, [[P1, FIRST_ID + 1], [P2, FIRST_ID + 2]]]);

    const r5 = ensureIdentity(deps(), 9003);
    assert.deepStrictEqual(r5, { ok: false, reason: "IDENTITY_LIMIT", detail: "2/2" });
    assert.strictEqual(ids.records.size, 2);
    assert.deepStrictEqual(ensureIdentity(deps(), 0), { ok: false, reason: "IDENTITY_FAILED", detail: "playerId" });

    const m = MIGRATIONS.find((x) => x.name === "ship_ai_prefs");
    assert.ok(m && m.version >= 84, "migration ship_ai_prefs");
    assert.strictEqual(TABLE_POLICY.ship_ai_prefs, "KEEP");
  }));
};
