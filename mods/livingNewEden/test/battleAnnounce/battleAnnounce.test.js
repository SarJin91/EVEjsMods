"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { startBattleAnnounce } = require("../../lib/battleAnnounce");
const { createBattleAnnounceRepository } = require("../../lib/battleAnnounce/repository");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { battleAnnounceTxRowsOf } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const STANDING_RUNTIME = path.resolve(__dirname, "..", "..", "..", "..", "server", "src", "services", "character",
  "standingRuntime.js");
const T0 = 1760000000000;
const ATT = 500003;
const DEF = 500001;
const TARGET = 30000001;
const NEAR = 30000002;
const FAR = 30000003;
const LONELY = 30000009;
const STAGING = 30000005;
const C_NEAR = 91000001;
const C_STAND = 91000002;
const C_NONE = 91000003;
const JUMP_MS = 120000;

const configCache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    configCache.set(key, config.resolveConfig({ env: { EVEJS_LNE_NOTICES_ENABLED: "1",
      EVEJS_LNE_BATTLE_ANNOUNCE_ENABLED: "1", ...env }, modDir: MOD_DIR }));
  }
  return configCache.get(key);
}

function op(id, extra = {}) {
  return { operationId: id, operationType: "invasion", factionId: ATT, targetSystemId: TARGET, fleetIds: [`${id}-f1`],
    state: "ACTIVE", completedAt: null, ...extra };
}

function departure(opId, extra = {}) {
  return { fleetId: `${opId}-f1`, factionId: ATT, fleetRole: "invasion", operationId: opId, legSeq: 1,
    leg: { systems: [FAR, NEAR, TARGET], departAt: T0, jumpMs: JUMP_MS }, wormholes: false, chained: false, ...extra };
}

function rig(opened, conf, opts = {}) {
  const store = opened.store;
  const clock = { t: T0, now() { return this.t; } };
  const ops = new Map();
  const battles = new Map();
  const events = new Map();
  const handlers = new Map();
  const listeners = [];
  const fleets = new Map();
  const noticeRepo = createNoticeRepository();
  const conflicts = { n: 0 };
  const scheduler = {
    registerHandler(type, fn, o) {
      handlers.set(type, { fn, o });
      return { ok: true, unregister() { handlers.delete(type); } };
    },
    enqueue(type, aggregateId, dueAt, payload, key, o) {
      const json = JSON.stringify(payload);
      const seen = events.get(key);
      if (seen && seen.json === json) return { ok: true, duplicate: true };
      if (seen) {
        conflicts.n += 1;
        return { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
      }
      events.set(key, { type, aggregateId, dueAt, payload, json, chained: Boolean(o && o.chained) });
      return { ok: true, duplicate: false };
    },
  };
  const presenceBy = new Map(opts.presence || [[NEAR, [C_NEAR]], [LONELY, [C_STAND, C_NONE]]]);
  const presence = {
    getStatus: () => ({ available: true, stale: false }),
    getSystemPresence: (id) => (presenceBy.has(id)
      ? { systemId: id, characters: presenceBy.get(id).map((c) => ({ characterId: c })) } : null),
    listPresence: () => [...presenceBy].map(([systemId, cs]) => ({ systemId,
      characters: cs.map((c) => ({ characterId: c })) })),
  };
  const adj = { [TARGET]: [NEAR], [NEAR]: [TARGET, FAR], [FAR]: [NEAR] };
  const graph = { getNeighbors: (id) => adj[id] || [], getSystem: (id) => ({ name: `Sys${id}`, regionId: 10000002 }),
    getRegionName: () => "The Forge" };
  const standings = new Map([[`${C_STAND}:${DEF}`, 6]]);
  const adapter = {
    readCharacterStanding: (c, f) => ({ ok: true, found: true, standing: standings.get(`${c}:${f}`) || 0 }),
    readFactionNames: () => ({ ok: true, names: new Map([[ATT, "Caldari State"], [DEF, "Amarr Empire"]]) }),
  };
  const notices = { getStatus: () => ({ state: "running" }),
    enqueueItemsInTx: (tx, items, now) => noticeRepo.enqueueItemsInTx(tx, items, now) };
  const ctx = { persistence: opened, scheduler, notices, presence, graph: { getGraph: () => ({ ok: true, graph }) },
    fleets: { repository: { getOperation: (_tx, id) => ({ ok: true, operation: ops.get(id) || null }),
      listFleetsOfOperation: (_tx, id) => ({ ok: true, fleets: [...fleets.values()].filter((f) => f.operationId === id),
        truncated: false }) },
      travel: { addDepartureListener(fn) {
        listeners.push(fn);
        return { ok: true, remove() { listeners.splice(listeners.indexOf(fn), 1); } };
      } } },
    world: { repository: { getSystem: (_db, id) => ({ ok: true,
      system: { systemId: id, controllerFactionId: DEF, occupierFactionId: null } }) } },
    battle: { repository: { getByFleet: (_db, fleetId) => ({ ok: true, battles: battles.get(fleetId) || [] }) } } };
  const started = startBattleAnnounce({ config: conf, ctx, adapter, clock, logger: { log() {} } });
  assert.ok(started.ok, JSON.stringify(started));

  const tx = (fn) => {
    const r = store.transaction("ba.test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  function depart(...ds) {
    tx((db) => {
      for (const d of ds) {
        fleets.set(d.fleetId, { fleetId: d.fleetId, operationId: d.operationId, state: "TRAVELLING",
          route: { ...d.leg, arriveAt: d.leg.departAt + (d.leg.systems.length - 1) * d.leg.jumpMs } });
        for (const fn of listeners) fn(db, d);
      }
      return { ok: true };
    });
  }
  function run(key, effects = 1) {
    const ev = events.get(key);
    assert.ok(ev, `no event ${key}`);
    const res = handlers.get(ev.type).fn({ eventType: ev.type, payload: ev.payload, dueAt: ev.dueAt }, {});
    assert.ok(res && res.ok, JSON.stringify(res));
    let value;
    for (let i = 0; i < effects && typeof res.effect === "function"; i += 1) {
      value = tx((db) => {
        const v = res.effect(db);
        assert.ok(!v || v.ok !== false, JSON.stringify(v));
        return v;
      });
      if (typeof res.onCommitted === "function") res.onCommitted(value);
    }
    if (typeof res.effect !== "function" && typeof res.onCommitted === "function") res.onCommitted(undefined);
    return { res, value };
  }
  const items = () => tx((db) => db.prepare("SELECT character_id AS c, kind, event_key AS k, line FROM "
    + "world_notice_items ORDER BY item_id").all().map((r) => ({ c: Number(r.c), kind: r.kind, k: r.k, line: r.line })));
  const rows = () => tx((db) => db.prepare("SELECT operation_id AS id, state, outcome, check_round AS round, "
    + "recipients FROM battle_announcements ORDER BY operation_id").all().map((r) => ({ ...r, round: Number(r.round),
    recipients: Number(r.recipients) })));
  return { store, clock, ops, battles, events, fleets, conflicts, handlers, listeners, depart, run, items, rows, tx, standings,
    status: () => started.battleAnnounce.getStatus(), stop: () => started.battleAnnounce.stop() };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("BA1-BA4 battle announcements", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("BA1 departure -> one BATTLE_ANNOUNCE, OPEN row, proximity + standing recipients, ETA lines, duplicate", () => {
      withStore(driver, (opened) => {
        const h = rig(opened, cfg().config);
        h.ops.set("op1", op("op1", { fleetIds: ["op1-f1", "op1-f2"] }));
        h.depart(departure("op1"), departure("op1", { fleetId: "op1-f2", leg: { systems: [FAR, NEAR, TARGET],
          departAt: T0, jumpMs: JUMP_MS * 2 } }));
        h.depart(departure("op1", { fleetId: "op1-f3", leg: { systems: [NEAR, TARGET], departAt: T0 + 1000,
          jumpMs: 300000 } }));
        h.depart(departure("op1", { fleetId: "op1-f4", leg: { systems: [NEAR, TARGET], departAt: T0 + 2000,
          jumpMs: 200000 } }));
        const ann = h.events.get("bann:eta:op1");
        assert.deepStrictEqual([ann.type, ann.dueAt, Object.keys(ann.payload).sort(), h.events.size],
          ["BATTLE_ANNOUNCE", T0, ["factionId", "operationId", "operationType", "targetSystemId"], 1]);
        assert.deepStrictEqual([h.status().listenerQueued, h.status().listenerDuplicate,
          h.status().listenerRefused, h.conflicts.n], [1, 3, 0, 0]);
        const { res } = h.run("bann:eta:op1");
        assert.strictEqual(res.outcome, "ANNOUNCED");
        assert.deepStrictEqual(h.rows(), [{ id: "op1", state: "OPEN", outcome: null, round: 0, recipients: 2 }]);
        const lines = h.items();
        assert.deepStrictEqual(lines.map((l) => [l.c, l.kind, l.k]), [[C_NEAR, "BATTLE_ETA", "bann:op1:eta"],
          [C_STAND, "BATTLE_ETA", "bann:op1:eta"]]);
        const hhmm = new Date(T0 + 202000).toISOString().slice(11, 16);
        assert.notStrictEqual(hhmm, new Date(T0 + 2 * JUMP_MS).toISOString().slice(11, 16));
        assert.ok(lines[0].line.includes(`ETA ~${hhmm} EVE (in ~3 min)`), lines[0].line);
        assert.ok(lines[0].line.startsWith("Fleet alert: Caldari State forces are moving on Sys30000001 (The Forge), "
          + "held by Amarr Empire."), lines[0].line);
        const chk = h.events.get("bann:chk:op1:0");
        assert.deepStrictEqual([chk.type, chk.dueAt, chk.chained], ["BATTLE_ANNOUNCE_CHECK", T0 + 120000, true]);
        assert.deepStrictEqual([h.status().announced, h.status().recipientsQueued], [1, 2]);
      });
    });

    test("BA2 end mail: CANCELLED only to the announced + stale round no-op; SETTLED A_WIN -> won the battle", () => {
      withStore(driver, (opened) => {
        const h = rig(opened, cfg().config);
        h.ops.set("op1", op("op1"));
        h.depart(departure("op1"));
        h.run("bann:eta:op1");
        h.ops.set("op1", op("op1", { state: "CANCELLED", completedAt: T0 + 30000 }));
        h.clock.t = T0 + 120000;
        const a = h.run("bann:chk:op1:0");
        assert.deepStrictEqual([a.value.closed, a.value.outcome, a.value.mailed], [true, "CANCELLED", 2]);
        const ends = h.items().filter((l) => l.kind === "BATTLE_END");
        assert.deepStrictEqual(ends.map((l) => [l.c, l.k]), [[C_NEAR, "bann:op1:end"], [C_STAND, "bann:op1:end"]]);
        assert.strictEqual(ends[0].line, "Update: the attack of Caldari State on Sys30000001 was called off.");
        assert.deepStrictEqual(h.rows()[0].state, "CLOSED");
        const again = h.run("bann:chk:op1:0");
        assert.strictEqual(again.value.stale, true);
        assert.strictEqual(h.items().filter((l) => l.kind === "BATTLE_END").length, 2);
        h.clock.t = T0 + 600000;
        h.ops.set("op2", op("op2"));
        h.depart(departure("op2", { leg: { systems: [FAR, NEAR, TARGET], departAt: h.clock.t, jumpMs: JUMP_MS } }));
        h.run("bann:eta:op2");
        h.battles.set("op2-f1", [{ battleId: "b1", systemId: TARGET, state: "COMPLETED", createdAt: h.clock.t + 1000,
          updatedAt: h.clock.t + 2000, settledAt: h.clock.t + 2000, input: { sideA: { factionId: ATT, fleets: [] },
            sideB: { factionId: DEF, fleets: [] } }, result: { outcome: "A_WIN" } }]);
        h.clock.t += 120000;
        const b = h.run("bann:chk:op2:0");
        assert.deepStrictEqual([b.value.outcome, b.value.mailed], ["SETTLED", 2]);
        const won = h.items().filter((l) => l.k === "bann:op2:end");
        assert.strictEqual(won[0].line, "Battle report: Caldari State won the battle at Sys30000001 (The Forge).");
        assert.deepStrictEqual([h.status().closed, h.status().endMailed], [2, 2]);
      });
    });

    test("BA3 effect twice -> one row and one line per character; daily cap; same open target skipped", () => {
      withStore(driver, (opened) => {
        const h = rig(opened, cfg().config);
        h.ops.set("op1", op("op1"));
        h.depart(departure("op1"));
        h.run("bann:eta:op1", 2);
        assert.strictEqual(h.rows().length, 1);
        assert.strictEqual(h.items().length, 2);
        const repo = createBattleAnnounceRepository();
        h.tx((db) => {
          assert.ok(repo.closeInTx(db, { operationId: "op1", expectedVersion: 1, outcome: "NO_FIGHT", battleId: null,
            endMailed: false, now: T0 }).ok);
          assert.ok(repo.createInTx(db, { operationId: "open1", operationType: "raid", factionId: 500002,
            defenderFactionId: null, targetSystemId: TARGET, etaAt: T0, announcedAt: T0, characterIds: [C_STAND] }).ok);
          for (let i = 0; i < 5; i += 1) {
            const id = `old${i}`;
            assert.ok(repo.createInTx(db, { operationId: id, operationType: "raid", factionId: ATT,
              defenderFactionId: null, targetSystemId: 30000100 + i, etaAt: T0, announcedAt: T0,
              characterIds: [C_NEAR] }).ok);
            assert.ok(repo.closeInTx(db, { operationId: id, expectedVersion: 1, outcome: "NO_FIGHT", battleId: null,
              endMailed: false, now: T0 }).ok);
          }
          return { ok: true };
        });
        h.ops.set("op2", op("op2"));
        h.depart(departure("op2"));
        const r = h.run("bann:eta:op2");
        assert.strictEqual(r.value.empty, true);
        assert.deepStrictEqual([h.status().dailyCapped, h.status().sameTargetSkipped, h.status().announced],
          [1, 1, 1]);
        assert.strictEqual(h.rows().filter((x) => x.id === "op2").length, 0);
      });
    });

    test("BA4 filters: patrol, staging leg, short lead, transaction budget -> no event; late event -> TOO_LATE", () => {
      withStore(driver, (opened) => {
        const h = rig(opened, cfg().config);
        h.ops.set("pat", op("pat", { operationType: "patrol" }));
        h.ops.set("stg", op("stg"));
        h.ops.set("short", op("short"));
        h.depart(departure("pat"));
        h.depart(departure("stg", { leg: { systems: [FAR, NEAR, STAGING], departAt: T0, jumpMs: JUMP_MS } }));
        h.depart(departure("short", { leg: { systems: [NEAR, TARGET], departAt: T0, jumpMs: 60000 } }));
        assert.strictEqual(h.events.size, 0);
        assert.strictEqual(h.status().listenerShortLead, 1);
        for (const id of ["b1", "b2", "b3"]) h.ops.set(id, op(id));
        h.depart(departure("b1"), departure("b2"), departure("b3"));
        assert.deepStrictEqual([...h.events.keys()], ["bann:eta:b1", "bann:eta:b2"]);
        assert.strictEqual(h.status().budgetPass, 1);
        h.clock.t = T0 + 2 * JUMP_MS - 60000;
        const late = h.run("bann:eta:b1");
        assert.deepStrictEqual([late.res.outcome, h.status().tooLate, h.rows().length, h.items().length],
          ["TOO_LATE", 1, 0, 0]);
      });
    });
  }

  test("BA5 config defaults/clamps/warnings, off = disabled_by_config without listener, row bound, vendor fact", () => {
    const off = config.resolveConfig({ env: {}, modDir: MOD_DIR });
    const b = off.config.battleAnnounce;
    assert.deepStrictEqual([b.enabled, b.operationTypes, b.minLeadMs, b.proximityJumps, b.standingMin,
      b.maxRecipientsPerAnnouncement, b.maxPerCharacterPerDay, b.maxAnnouncementsPerTransaction, b.pruneBatch],
    [false, "invasion,raid,counter,structure_assault", 180000, 2, 5, 30, 6, 2, 5]);
    assert.ok(!off.warnings.some((w) => w.startsWith("battleAnnounce")), off.warnings.join("; "));
    assert.strictEqual(cfg({ EVEJS_LNE_BATTLE_ANNOUNCE_PROXIMITY_JUMPS: "9" }).config.battleAnnounce.proximityJumps, 5);
    const noNotices = cfg({ EVEJS_LNE_NOTICES_ENABLED: "0" });
    assert.ok(noNotices.warnings.some((w) => w.startsWith("battleAnnounce.enabled without notices.enabled")));
    assert.ok(!cfg().warnings.some((w) => w.startsWith("battleAnnounce.retentionMs")), cfg().warnings.join("; "));
    assert.ok(cfg({ EVEJS_LNE_BATTLE_ANNOUNCE_RETENTION_MS: "3600000" }).warnings
      .some((w) => w.startsWith("battleAnnounce.retentionMs=3600000 < capWindowMs=86400000")));
    let added = 0;
    const ctx = { fleets: { travel: { addDepartureListener() { added += 1; return { ok: true, remove() {} }; } } } };
    assert.deepStrictEqual(startBattleAnnounce({ config: off.config, ctx }), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(added, 0);
    assert.deepStrictEqual([battleAnnounceTxRowsOf(off.config), battleAnnounceTxRowsOf(cfg().config)], [0, 2]);
    const onBounds = rowBoundsOfConfig(cfg().config);
    const offBounds = rowBoundsOfConfig(cfg({ EVEJS_LNE_BATTLE_ANNOUNCE_ENABLED: "0" }).config);
    assert.strictEqual(onBounds.review - offBounds.review, 2);
    if (!fs.existsSync(STANDING_RUNTIME)) return;
    const text = fs.readFileSync(STANDING_RUNTIME, "utf8");
    assert.ok(/const MAX_STANDING = 10\.0;/.test(text), "standingRuntime MAX_STANDING = 10.0");
    assert.ok(/^\s+getCharacterRawStandingFromRecord,\s*$/m.test(text), "standingRuntime exports the raw read");
  });
};
