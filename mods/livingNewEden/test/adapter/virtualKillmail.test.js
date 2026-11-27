"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { buildVendorKillmailRecord, writeVirtualKillmailWith } = require("../../lib/adapter/virtualKillmail");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");
const { KILLMAIL_HULLS } = require("../../lib/freeCorps/data/killmailHulls");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const CONSUMER = "freeCorpsKillmails";

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

const payload = (over = {}) => ({ v: 1, skirmishId: "fcs:fcv:1:1:1", at: 0, systemId: 30000012, warId: null,
  victim: { characterId: 980000020, corporationId: 98000002, shipTypeId: 32880, damageTaken: 868 },
  attackers: [{ characterId: 980000010, corporationId: 98000001, shipTypeId: 587, damageDone: 600, securityStatus: -2 },
    { characterId: 980000011, corporationId: 98000001, shipTypeId: 16242, damageDone: 268, securityStatus: -2 }],
  ...over });

function fakeKillmailState() {
  const byEvent = new Map();
  const records = new Map();
  let next = 1;
  return { byEvent, records,
    createKillmailRecordIdempotent(record, eventID) {
      if (!eventID || typeof eventID !== "string") throw new Error("KILLMAIL_EVENT_ID_REQUIRED");
      if (byEvent.has(eventID)) return records.get(byEvent.get(eventID));
      const killID = next;
      next += 1;
      byEvent.set(eventID, killID);
      records.set(killID, { ...record, killID });
      return records.get(killID);
    } };
}

module.exports = ({ test }) => {
  test("KM1 vendor facts of createKillmailRecordIdempotent / DBS / FW, GAME_MODULES consumer, record shape "
    + "idempotent write, blind adapter, hulls in the catalog", () => {
    const src = readSource("services/killmail/killmailState.js");
    const at = src.indexOf("\nfunction createKillmailRecordIdempotent(record, eventID) {");
    assert.ok(at >= 0, "createKillmailRecordIdempotent(record, eventID)");
    const end = src.indexOf("\nfunction settleFactionWarfareAchievement(", at);
    assert.ok(end > at, "settleFactionWarfareAchievement after it");
    const body = src.slice(at, end);
    const replay = body.indexOf("terminalEventKillIDs[eventID]");
    assert.ok(replay >= 0 && replay < body.indexOf("cloneValue(prepared.record)"), "replay before the new record");
    assert.ok(!body.includes("careerProgress"), "no career projection on the idempotent path");
    assert.match(src.slice(src.search(/^module\.exports = \{/m)), /^ {2}createKillmailRecordIdempotent,$/m);
    assert.ok(src.slice(end).startsWith("\nfunction settleFactionWarfareAchievement(record, options) {\n"
      + "  if (!record.achievementFwWinnerCharacterID) return;"), "FW achievement no-op without the field");
    const dbs = readSource("services/dynamic/dynamicBountyRuntime.js");
    const q = dbs.slice(dbs.indexOf("\nfunction qualifyingLoss("), dbs.indexOf("\nfunction stampLossRecord("));
    assert.ok(q.includes("!(record.finalCharacterID > 0)"), "DBS loss needs finalCharacterID > 0");

    assert.ok(!MODULE_NAMES.includes(CONSUMER), "freeCorpsKillmails is not a module name");
    const entry = GAME_MODULES.find((e) => e.path === "services/killmail/killmailState");
    const s = entry.symbols.find((x) => x.name === "createKillmailRecordIdempotent");
    assert.ok(s && s.kind === "export" && s.consumers.includes(CONSUMER));
    assert.ok(s.wrap !== true && s.firstLoad !== true, "not wrapped, no first-load");

    const built = buildVendorKillmailRecord(payload());
    assert.ok(built.ok);
    const rec = built.record;
    assert.strictEqual(rec.finalCharacterID, null);
    assert.strictEqual(rec.killTime, "116444736000000000");
    assert.deepStrictEqual(Object.keys(rec).filter((k) => /^(achievement|career)|^iskLost$|^iskDestroyed$/.test(k)), []);
    assert.deepStrictEqual([rec.finalCorporationID, rec.finalShipTypeID, rec.finalDamageDone, rec.attackers.length,
      rec.victimDamageTaken, rec.items.length], [98000001, 587, 600, 2, 868, 0]);
    assert.strictEqual(buildVendorKillmailRecord(payload({ attackers: [] })).reason, "INVALID_INPUT");

    const km = fakeKillmailState();
    const key = "lne:fc:km:fcs:fcv:1:1:1";
    const a = writeVirtualKillmailWith(km, payload(), key);
    const b = writeVirtualKillmailWith(km, payload(), key);
    assert.deepStrictEqual([a, b], [{ ok: true, killId: 1 }, { ok: true, killId: 1 }]);
    assert.strictEqual(km.records.size, 1, "one killmail for one eventID");
    const thrower = { createKillmailRecordIdempotent() { throw new Error(`disk ${"x".repeat(400)}`); } };
    const t = writeVirtualKillmailWith(thrower, payload(), key);
    assert.strictEqual(t.reason, "VENDOR_THROW");
    assert.ok(t.detail.length <= 200);
    assert.deepStrictEqual(writeVirtualKillmailWith({ createKillmailRecordIdempotent: () => null }, payload(), key),
      { ok: false, reason: "NO_RECORD" });
    assert.strictEqual(writeVirtualKillmailWith(km, payload(), "fcs:fcv:1:1:1").reason, "INVALID_INPUT");
    assert.strictEqual(writeVirtualKillmailWith(km, payload(), "lne:fc:km:a b").reason, "INVALID_INPUT");
    assert.strictEqual(writeVirtualKillmailWith(null, payload(), key).reason, "SEAM_UNAVAILABLE");

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.deepStrictEqual(blind.virtualKillmailSeams(), { ok: true });
    const w = blind.writeVirtualKillmail(payload(), key);
    assert.strictEqual(w.ok, false);
    assert.strictEqual(w.reason, "SEAM_UNAVAILABLE");

    for (const [kind, ids] of Object.entries(KILLMAIL_HULLS)) {
      for (const id of ids) assert.ok(TYPES[id] && TYPES[id].ehp > 0, `${kind} ${id} in strengthCatalog`);
    }
  });
};
