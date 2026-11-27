"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { classifyEntries } = require("../../lib/notices/sources");
const { createTail, kindsOf } = require("../../lib/notices/tail");
const { formatNoticeLine } = require("../../lib/notices/format");
const { listOwnerMemberIdsFrom } = require("../../lib/adapter/playerStructures");
const { buildSiegesLayerView } = require("../../lib/stations/siege/siegesLayer");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30002001;
const CORP = 98000001;
const ATTACKER = 500019;
const ASTRAHUS = 35832;

function settings(overrides = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_NOTICES_ENABLED: "1" } }).config.notices, ...overrides };
}

function psiegeEntry(journalId, eventType, payload) {
  return { journalId, aggregateType: "player_structure_siege", aggregateId: "ps1", eventType, createdAt: T0,
    key: `k${journalId}`, payload };
}

const STARTED = { siegeId: "ps1", systemId: SYS, structureId: 1030000000001, structureTypeId: ASTRAHUS,
  ownerCorpId: CORP, attackerFactionId: ATTACKER, state: "SHIELD_ASSAULT", phaseEndsAt: T0 + 3600000 };
const transition = (from, to, endReason) => ({ siegeId: "ps1", systemId: SYS, structureId: 1030000000001,
  structureTypeId: ASTRAHUS, ownerCorpId: CORP, attackerFactionId: ATTACKER, from, to, endReason,
  vendorState: null, vendorEndsAt: null });

function fakeStore() {
  return Object.freeze({
    isOpen: () => true,
    limits: Object.freeze({ maxRowsPerTransaction: 500 }),
    transaction: (_name, fn) => {
      try {
        return { ok: true, value: fn(Object.freeze({ inTransaction: true })) };
      } catch (error) {
        return { ok: false, reason: "TX_FAILED", error };
      }
    },
  });
}

module.exports = ({ test }) => {
  test("PN1 classifyEntries: PSIEGE start + transitions -> STRUCTURE_SIEGE_STARTED and _ENDED only", () => {
    const s = settings();
    const entries = [
      psiegeEntry(11, "PSIEGE_STARTED", STARTED),
      psiegeEntry(12, "PSIEGE_TRANSITION", transition("SHIELD_ASSAULT", "ARMOR_TIMER", null)),
      psiegeEntry(13, "PSIEGE_WAIT", { siegeId: "ps1", waitRound: 1, dueAt: T0, why: "TIMER" }),
      psiegeEntry(14, "PSIEGE_TRANSITION", transition("HULL_ASSAULT", "DESTROYED", "DESTROYED")),
    ];
    const r = classifyEntries(entries, new Map(), { now: T0, maxEventAgeMs: s.maxEventAgeMs, kinds: kindsOf(s) });
    assert.deepStrictEqual(r.events.map((e) => [e.eventKey, e.kind, e.systemId, e.ownerCorpId, e.structureTypeId,
      e.attacker, e.outcome, e.endReason]), [
      ["j:11:STRUCTURE_SIEGE_STARTED", "STRUCTURE_SIEGE_STARTED", SYS, CORP, ASTRAHUS, ATTACKER, null, null],
      ["j:14:STRUCTURE_SIEGE_ENDED", "STRUCTURE_SIEGE_ENDED", SYS, CORP, ASTRAHUS, ATTACKER, "DESTROYED", "DESTROYED"],
    ]);
    assert.deepStrictEqual(r.skipped, {});
    const off = classifyEntries(entries, new Map(), { now: T0, maxEventAgeMs: s.maxEventAgeMs,
      kinds: kindsOf({ ...s, kindStructureSiegeStarted: false }) });
    assert.deepStrictEqual(off.events.map((e) => e.kind), ["STRUCTURE_SIEGE_ENDED"]);
  });

  test("PN2 tail: owner members (max 2 of 3) -> 2 items, recipientsTruncated, no presence; refusal -> 0 items", () => {
    const vendor = Object.freeze({ corpRuntime: Object.freeze({
      listCorporationMembers: (corpId) => Object.freeze((corpId === CORP ? [90000003, 90000001, 90000002] : [])
        .map((characterID) => Object.freeze({ characterID, corporationID: corpId }))),
    }) });
    const run = (seam) => {
      let head = 0;
      const journal = Object.freeze({
        headId: () => ({ ok: true, headId: head }),
        listAfter: (_db, o) => ({ ok: true, scannedUpTo: o.uptoId,
          entries: o.afterId < 1 && o.uptoId >= 1 ? [psiegeEntry(1, "PSIEGE_STARTED", STARTED)] : [] }),
      });
      const queued = [];
      const counts = {};
      let presenceCalls = 0;
      const tail = createTail({ store: fakeStore(), journal, repo: Object.freeze({}), settings: settings({
        maxOwnerRecipients: 2 }),
      enqueue: (_db, items) => {
        queued.push(...items);
        return { ok: true, inserted: items.length, duplicates: 0 };
      },
      getWorldRepository: () => Object.freeze({ listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }) }),
      getPresence: () => {
        presenceCalls += 1;
        return null;
      },
      getGraph: () => null, adapter: Object.freeze({ playerStructures: seam }), listLimit: 500,
      bump: (name, n = 1) => {
        counts[name] = (counts[name] || 0) + n;
      } });
      assert.ok(tail.bootstrap().ok);
      head = 1;
      const r = tail.runPass(T0);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      return { queued, counts, presenceCalls, r };
    };

    const ok = run(Object.freeze({ listOwnerMemberIds: (corpId, opts) => listOwnerMemberIdsFrom(vendor, corpId, opts) }));
    assert.deepStrictEqual(ok.queued.map((i) => [i.eventKey, i.characterId, i.kind, i.systemId]), [
      ["j:1:STRUCTURE_SIEGE_STARTED", 90000001, "STRUCTURE_SIEGE_STARTED", SYS],
      ["j:1:STRUCTURE_SIEGE_STARTED", 90000002, "STRUCTURE_SIEGE_STARTED", SYS],
    ]);
    assert.strictEqual(ok.counts.recipientsTruncated, 1);
    assert.strictEqual(ok.counts.recipientsUnavailable, undefined);
    assert.strictEqual(ok.presenceCalls, 0);
    assert.strictEqual(ok.r.events, 1);

    const refused = run(Object.freeze({ listOwnerMemberIds: () => ({ ok: false, reason: "SEAM_ERROR" }) }));
    assert.deepStrictEqual([refused.queued.length, refused.counts.recipientsUnavailable, refused.r.cursor], [0, 1, 1]);
    assert.deepStrictEqual(listOwnerMemberIdsFrom(vendor, CORP, { max: 0 }),
      { ok: false, reason: "INVALID_INPUT", detail: "max" });
  });

  test("PN3 formatNoticeLine: structure siege start / end lines with the reason phrase", () => {
    const names = new Map([[ATTACKER, "Sansha's Nation"]]);
    const opts = { systemName: "1DQ1-A", regionName: "Delve", names };
    const base = { systemId: SYS, at: T0, attacker: ATTACKER, defender: null, ownerCorpId: CORP,
      structureTypeId: ASTRAHUS };
    assert.strictEqual(formatNoticeLine({ ...base, kind: "STRUCTURE_SIEGE_STARTED" }, opts),
      "[08:53 UTC] Structure siege: Sansha's Nation attack your Astrahus in 1DQ1-A (Delve). The shield assault has begun.");
    assert.strictEqual(formatNoticeLine({ ...base, kind: "STRUCTURE_SIEGE_ENDED", outcome: "HALTED",
      endReason: "OWNER_OFFLINE" }, opts), "[08:53 UTC] Structure siege over in 1DQ1-A (Delve): your Astrahus - "
      + "Sansha's Nation halted the siege (no member of the owner corporation was active recently).");
    assert.strictEqual(formatNoticeLine({ ...base, kind: "STRUCTURE_SIEGE_ENDED", outcome: "HALTED",
      endReason: "OWNER_UNKNOWN", structureTypeId: 99999 }, { names }),
    "[08:53 UTC] Structure siege over in an unknown system: your structure - Sansha's Nation halted the "
      + "siege (the activity of the owner corporation could not be read).");
    assert.strictEqual(formatNoticeLine({ ...base, kind: "STRUCTURE_SIEGE_ENDED", outcome: "DESTROYED",
      endReason: "DESTROYED" }, opts),
    "[08:53 UTC] Structure siege over in 1DQ1-A (Delve): your Astrahus - destroyed by Sansha's Nation.");
  });

  test("PN4 layer-sieges: a player siege adds a psiege-assault mark; null / off getPlayerSiege = the old data", () => {
    const station = Object.freeze([Object.freeze({ siegeId: "s1", systemId: SYS, state: "ARMOR_TIMER",
      phaseEndsAt: T0 + 7200000, attackerFactionId: ATTACKER, ownerFactionId: 500003 })]);
    const repository = Object.freeze({ listOpen: (_db, o) => ({ ok: true, sieges: station.slice(0, o.limit),
      truncated: false }) });
    const player = Object.freeze({ siegeId: "ps1", systemId: SYS + 1, structureId: 1030000000001,
      structureTypeId: ASTRAHUS, ownerCorpId: CORP, attackerFactionId: ATTACKER, state: "SHIELD_ASSAULT",
      phaseEndsAt: T0 + 3600000 });
    const facade = (mode) => Object.freeze({ getMode: () => mode, listOpen: (tx, o) => {
      assert.strictEqual(tx.inTransaction, true);
      return { ok: true, sieges: [player].slice(0, o.limit), truncated: false };
    } });
    const build = (extra) => buildSiegesLayerView({ store: fakeStore(), repository, clock: { now: () => T0 },
      nowMs: () => 0, maxSieges: 100, maxSystems: 1000, maxLines: 6, refreshMs: 15000, ...extra }).getData();

    const before = build({});
    assert.strictEqual(before.legend.length, 2);
    assert.strictEqual(before.note, "1 open sieges in 1 systems");
    assert.deepStrictEqual(build({ getPlayerSiege: () => null }), before);
    assert.deepStrictEqual(build({ getPlayerSiege: () => facade("off") }), before);

    const withPlayer = build({ getPlayerSiege: () => facade("ready") });
    assert.deepStrictEqual(withPlayer.legend.map((l) => [l[0], l[2], l[3]]), [["siege-assault", "#ff2850", "versus"],
      ["siege-timer", "#ff2850", "versus"], ["psiege-assault", "#ffb000", "versus"], ["psiege-timer", "#ffb000", "versus"]]);
    assert.deepStrictEqual(withPlayer.items[0], before.items[0]);
    assert.deepStrictEqual(withPlayer.items[1], [SYS + 1, "psiege-assault", `${ATTACKER}v player`,
      [`ps1 - player SHIELD - A ${ATTACKER} -> corp ${CORP} (type ${ASTRAHUS}) - 1h`], [[ATTACKER, 1]], "solid"]);
    assert.strictEqual(withPlayer.note, "1 open sieges in 2 systems; 1 player structure sieges");
  });
};
