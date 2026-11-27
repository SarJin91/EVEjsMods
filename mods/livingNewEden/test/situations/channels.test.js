"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/situations/schema");
const R = require("../../lib/situations/repository");
const { createSituationService } = require("../../lib/situations/service");
const { createUnavailableSituations } = require("../../lib/situations");
const { toSituationRumour, createRumourRing, RUMOUR_KINDS } = require("../../lib/highsecLife/rumours");
const { createJournal } = require("../../lib/persistence/journal");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1763500000000;
const SYS_A = 30000144;
const SYS_B = 30000145;
const CHAR = 90000077;
const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

function settingsOf(over) {
  const r = resolveConfig({ modDir: MOD_DIR, env: {} });
  const parsed = S.situationsSettingsOf({ situations: { ...r.config.situations, enabled: true, chancePermille: 1000,
    boardEnabled: true, rumoursEnabled: true, ...(over || {}) } });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

function fakeScene() {
  let next = 5000;
  const sc = { ships: new Map(), gone: new Set(), players: new Map(), despawnFails: false };
  sc.idsOf = (situationId, role) => [...sc.ships].filter(([, s]) => s.situationId === situationId && s.role === role)
    .map(([id]) => id);
  sc.seam = {
    readAnchors: () => ({ ok: true, belts: [{ itemId: 40001, name: "Asteroid Belt 3", position: ORIGIN }], gates: [] }),
    readPlayers: (sys) => sc.players.get(sys) || { ok: true, ships: [] },
    spawnShip: (_sys, spec) => {
      next += 1;
      sc.ships.set(next, { role: spec.role, situationId: spec.situationId });
      return { ok: true, entityId: next };
    },
    engage: () => ({ ok: true }),
    attack: () => ({ ok: true }),
    readShips: (_sys, ids) => ({ ok: true, sceneLoaded: true, gone: ids.filter((id) => sc.gone.has(id)),
      live: ids.filter((id) => !sc.gone.has(id)).map((entityId) => ({ entityId, inWarp: false })) }),
    readAggressors: () => ({ ok: true, aggressors: [] }),
    warpTo: () => ({ ok: true, warped: 0 }),
    despawn: (_sys, ids) => (sc.despawnFails && ids.length > 0 && !ids.some((id) => sc.gone.has(id))
      ? { ok: false, reason: "BOOM", failed: [ids[0]] } : { ok: true }),
    listSituationIds: () => ({ ok: true, ids: [] }),
  };
  return sc;
}

function rig(opened, P) {
  const scene = fakeScene();
  const rumours = [];
  const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
  const made = createSituationService({ store: opened.store, journal, worldSeed: 7, settings: P, bootAt: T0,
    clock: { now: () => T0 }, getScene: () => scene.seam,
    getPresence: () => ({ observedSystems: () => [SYS_A, SYS_B], getSystemPresence: () => ({ space: 1 }) }),
    getGraph: () => ({ getSystem: (id) => ({ name: id === SYS_A ? "Jita" : "Perimeter", secClass: "highsec" }) }),
    speakersOf: () => ({ ok: true, civilians: [90000001] }),
    resolveSystemFactions: () => ({ ok: true, entries: [{ factionId: 500010 }] }),
    resolveProfiles: (reqs) => ({ ok: true, profiles: reqs.map((_r, i) => `pirate_${i}`) }),
    sendOccupantMessage: () => ({ ok: true }), leave: { despawnMs: 0, maxMs: 60000 },
    onRumour: (e) => {
      rumours.push(e);
      return true;
    } });
  assert.ok(made.ok, JSON.stringify(made));
  assert.strictEqual(made.service.boot(T0).ok, true);
  return { svc: made.service, scene, rumours, journal };
}

const bySystem = (svc, sys) => svc.listOpen().find((s) => s.systemId === sys);
const onGrid = Object.freeze({ ok: true, ships: [{ characterId: CHAR, entityId: 777, inWarp: false,
  position: ORIGIN }] });

module.exports = ({ test, skip }) => {
  test("SC5 toSituationRumour: RESCUED -> SIT_RESCUED losses = saved, LOST / UNANSWERED -> SIT_LOST, ABANDONED -> "
    + "null; ring: one rumour per situation key; stub listBoardRows by boardEnabled", () => {
    const place = (id) => (id === SYS_A ? { name: "Jita", regionName: "The Forge" } : null);
    const e = { situationId: "s1-1", kind: "BELT_RAID", outcome: "RESCUED", systemId: SYS_A, at: T0, victims: 3,
      saved: 2 };
    const r = toSituationRumour(e, place);
    assert.deepStrictEqual([r.key, r.kind, r.losses, r.systemName, r.attackerName, r.defenderName],
      ["si:s1-1", "SIT_RESCUED", 2, "Jita", null, null]);
    assert.deepStrictEqual([toSituationRumour({ ...e, outcome: "LOST", saved: 0 }, place).losses,
      toSituationRumour({ ...e, outcome: "UNANSWERED", saved: 0 }, place).kind], [3, "SIT_LOST"]);
    assert.strictEqual(toSituationRumour({ ...e, outcome: "ABANDONED" }, place), null);
    assert.strictEqual(toSituationRumour({ ...e, systemId: SYS_B }, place), null, "unknown place");
    assert.ok(RUMOUR_KINDS.includes("SIT_RESCUED") && RUMOUR_KINDS.includes("SIT_LOST"));
    const ring = createRumourRing({ size: 4 });
    assert.deepStrictEqual([ring.add(r), ring.add(toSituationRumour(e, place)), ring.size()], [true, false, 1]);
    assert.strictEqual(createUnavailableSituations("SITUATIONS_UNAVAILABLE", "x").listBoardRows().reason,
      "SITUATIONS_DISABLED");
    assert.strictEqual(createUnavailableSituations("SITUATIONS_UNAVAILABLE", "x", { boardEnabled: true })
      .listBoardRows().reason, "NOT_READY");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("SC5 situations service channels", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("SC5 service: RESCUED -> onRumour once, DUPLICATE -> none; failed despawn -> leaving + despawnRetried "
    + "readPlayers refusal keeps absentSince; listBoardRows filter / DISABLED", () => withStore(driver,
    (opened) => {
    const P = settingsOf();
    const g = rig(opened, P);
    const step = P.pollMs;
    assert.ok(g.svc.runPass(T0).ok);
    assert.deepStrictEqual(g.svc.listOpen().map((s) => s.systemId).sort(), [SYS_A, SYS_B]);
    const a = bySystem(g.svc, SYS_A);
    const board = g.svc.listBoardRows({ systemIds: new Set([SYS_A]), limit: 10, now: T0 });
    assert.deepStrictEqual(board.rows.map((x) => [x.ref, x.source, x.kind, x.title, x.endsAt, x.state, x.rewardText]),
      [[`si:${a.situationId}`, "sit", "BELT_RAID", "Distress: Asteroid Belt 3", T0 + P.callingTimeoutMs, "CALLING",
        null]]);
    assert.deepStrictEqual([board.truncated, g.svc.listBoardRows({ systemIds: null, limit: 1 }).truncated], [false, true]);
    assert.strictEqual(g.svc.listBoardRows({ systemIds: [SYS_A], limit: 3 }).reason, "SYSTEM_IDS_INVALID");
    const off = createSituationService({ store: opened.store, journal: g.journal, worldSeed: 7,
      settings: settingsOf({ boardEnabled: false }), bootAt: T0, getScene: () => null, getPresence: () => null,
      speakersOf: () => null, resolveSystemFactions: () => null, resolveProfiles: () => null,
      sendOccupantMessage: () => null });
    assert.deepStrictEqual(off.service.listBoardRows({ systemIds: new Set([SYS_A]), limit: 3 }),
      { ok: false, reason: "SITUATIONS_DISABLED" });

    g.scene.players.set(SYS_A, onGrid);
    assert.ok(g.svc.runPass(T0 + step).ok);
    assert.strictEqual(bySystem(g.svc, SYS_A).phase, "FIGHT");
    g.scene.players.set(SYS_A, { ok: false, reason: "BOOM" });
    g.svc.runPass(T0 + 2 * step);
    const late = T0 + 2 * step + P.abandonGraceMs + 1;
    g.svc.runPass(late);
    assert.strictEqual((bySystem(g.svc, SYS_A) || {}).phase, "FIGHT", "a failed player read is no absence");
    assert.strictEqual(g.svc.getStatus().counters.abandoned, 0);

    g.scene.players.set(SYS_A, onGrid);
    const pirateIds = g.scene.idsOf(a.situationId, "pirate");
    assert.ok(pirateIds.length > 0);
    for (const id of pirateIds) {
      assert.deepStrictEqual(g.svc.onKill({ characterId: CHAR, entityId: id, role: "pirate", situationId: a.situationId,
        systemId: SYS_A, atMs: late }), { ok: true, counted: true });
      g.scene.gone.add(id);
    }
    g.scene.despawnFails = true;
    g.svc.runPass(late + step);
    const st = g.svc.getStatus();
    assert.strictEqual(st.counters.rescued, 1);
    assert.deepStrictEqual([g.rumours.length, g.rumours[0].outcome, g.rumours[0].situationId, g.rumours[0].saved,
      st.counters.rumoursSent], [1, "RESCUED", a.situationId, a.victims, 1]);
    assert.deepStrictEqual([st.leaving, st.counters.despawnRetried], [1, 1], "the failed id waits in leaving");
    g.scene.despawnFails = false;

    const b = bySystem(g.svc, SYS_B);
    const row = opened.store.transaction("sc5.read", (t) => ({ ok: true, row: R.getInTx(t, b.situationId) })).value.row;
    const ext = opened.store.transaction("sc5.settle", (t) => R.settleInTx(t, g.journal, row, "UNANSWERED",
      { endReason: "TIMEOUT", saved: 0, helpers: [], reward: null }, T0 + 1));
    assert.ok(ext.ok && ext.value.ok, JSON.stringify(ext));
    g.svc.runPass(T0 + P.callingTimeoutMs + 1);
    assert.strictEqual(bySystem(g.svc, SYS_B), undefined, "B left the RAM");
    assert.deepStrictEqual([g.rumours.length, g.svc.getStatus().counters.unanswered], [1, 0]);
    const ended = opened.store.transaction("sc5.ended", (t) => ({ ok: true, all: R.listEndedSinceInTx(t, T0, 10),
      one: R.listEndedSinceInTx(t, T0, 1), bad: R.listEndedSinceInTx(t, -1, 1) })).value;
    assert.deepStrictEqual(ended.all.rows.map((x) => [x.situationId, x.state]), [[a.situationId, "RESCUED"],
      [b.situationId, "UNANSWERED"]]);
    assert.deepStrictEqual([ended.all.truncated, ended.one.rows.length, ended.one.truncated, ended.bad.reason],
      [false, 1, true, "INVALID_INPUT"]);
  }));
};
