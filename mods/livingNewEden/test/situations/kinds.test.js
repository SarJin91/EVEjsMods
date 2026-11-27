"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/situations/schema");
const { CATALOG } = require("../../lib/situations/catalog");
const { createSituationService } = require("../../lib/situations/service");
const { createJournal } = require("../../lib/persistence/journal");
const { createSituationScene } = require("../../lib/adapter/situationScene");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1763600000000;
const SYS = 30000144;
const CHAR = 90000077;
const BELT = Object.freeze({ itemId: 40001, name: "Asteroid Belt 3", position: { x: 0, y: 0, z: 0 } });
const GATE = Object.freeze({ itemId: 50001, name: "Stargate (Perimeter)", position: { x: 1e9, y: 0, z: 0 } });
const POD_PROFILE = "lne_civ_capsule";

function settingsOf(over) {
  const r = resolveConfig({ modDir: MOD_DIR, env: {} });
  const parsed = S.situationsSettingsOf({ situations: { ...r.config.situations, enabled: true, chancePermille: 1000,
    ...(over || {}) } });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

function fakeScene() {
  let next = 7000;
  const sc = { ships: new Map(), despawned: [], engaged: 0, player: null, refuse: new Set(), specs: [] };
  const anchorPos = (a) => (a.kind === "gate" ? GATE.position : BELT.position);
  sc.idsOf = (role) => [...sc.ships].filter(([, s]) => s.role === role).map(([id]) => id);
  sc.seam = {
    readAnchors: () => ({ ok: true, belts: [BELT], gates: [GATE] }),
    readPlayers: () => ({ ok: true, ships: sc.player ? [{ characterId: CHAR, entityId: 777, inWarp: false,
      position: sc.player }] : [] }),
    spawnShip: (_sys, spec) => {
      sc.specs.push(spec);
      if (sc.refuse.has(spec.profileId)) return { ok: false, reason: "SPAWN_FAILED", detail: "type 27287 unknown" };
      next += 1;
      const p = anchorPos(spec.anchor);
      sc.ships.set(next, { role: spec.role, position: { x: p.x + spec.spawnOffsetMeters, y: 0, z: 0 } });
      return { ok: true, entityId: next };
    },
    engage: () => {
      sc.engaged += 1;
      return { ok: true };
    },
    attack: () => ({ ok: true }),
    readShips: (_sys, ids) => ({ ok: true, sceneLoaded: true, gone: ids.filter((id) => !sc.ships.has(id)),
      live: ids.filter((id) => sc.ships.has(id)).map((entityId) => ({ entityId, inWarp: false,
        position: sc.ships.get(entityId).position })) }),
    readAggressors: () => ({ ok: true, aggressors: [] }),
    warpTo: () => ({ ok: true, warped: 0 }),
    despawn: (_sys, ids) => {
      for (const id of ids) {
        if (sc.ships.delete(id)) sc.despawned.push(id);
      }
      return { ok: true };
    },
    listSituationIds: () => ({ ok: true, ids: [] }),
  };
  return sc;
}

function rig(opened, P, extra) {
  const scene = fakeScene();
  const logs = [];
  const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
  const made = createSituationService({ store: opened.store, journal, worldSeed: 7, settings: P, bootAt: T0,
    clock: { now: () => T0 }, getScene: () => scene.seam,
    getPresence: () => ({ observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) }),
    getGraph: () => ({ getSystem: () => ({ name: "Jita", secClass: "highsec" }) }),
    speakersOf: () => ({ ok: true, civilians: [90000001] }),
    resolveSystemFactions: () => ({ ok: true, entries: [{ factionId: 500010 }] }),
    resolveProfiles: (reqs) => ({ ok: true, profiles: reqs.map((_r, i) => `pirate_${i}`) }),
    sendOccupantMessage: () => ({ ok: true }), leave: { despawnMs: 0, maxMs: 60000 },
    logger: { log: (l) => logs.push(l) }, ...(extra || {}) });
  assert.ok(made.ok, JSON.stringify(made));
  assert.strictEqual(made.service.boot(T0).ok, true);
  return { svc: made.service, scene, logs };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("SC7 situations kinds", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("SC7 GATE_AMBUSH: one pass = start at the hot gate, haulers, pirates and engage (FIGHT)", () => withStore(driver,
    (opened) => {
    const P = settingsOf({ gateAmbushEnabled: true, beltRaidWeight: 0 });
    const g = rig(opened, P);
    g.scene.player = { x: GATE.position.x + 1000, y: 0, z: 0 };
    assert.ok(g.svc.runPass(T0).ok);
    const [open] = g.svc.listOpen();
    assert.deepStrictEqual([open.kind, open.phase, open.anchorLabel], ["GATE_AMBUSH", "FIGHT", GATE.name]);
    const victims = g.scene.specs.filter((s) => s.role === "victim");
    assert.ok(victims.length >= P.victimsMin && victims.every((s) => s.anchor.kind === "gate"
      && s.anchor.id === GATE.itemId && CATALOG.GATE_AMBUSH.victimFallbackProfiles.includes(s.profileId)),
    JSON.stringify(victims));
    assert.ok(g.scene.idsOf("pirate").length > 0, "pirates in the start pass");
    const c = g.svc.getStatus().counters;
    assert.deepStrictEqual([c.started, c.startedGateAmbush, c.engaged, g.scene.engaged, c.distressLines],
      [1, 1, 1, 1, 1]);
    const h = rig(opened, P);
    h.svc.runPass(T0 + 2 * P.bucketMs);
    assert.deepStrictEqual([h.svc.listOpen().length, h.svc.getStatus().counters["refused.NO_PROFILE"]], [0, 1]);
  }));

  test("SC7 STRANDED_POD: hold rescueHoldMs at 1 km -> RESCUED PICKED_UP, payout saved 1, capsule gone; a reset of "
    + "the hold; a refused capsule -> podKindOff", () => withStore(driver, (opened) => {
    const P = settingsOf({ strandedPodEnabled: true, beltRaidWeight: 0, rewardsEnabled: true });
    const g = rig(opened, P, { podProfileId: POD_PROFILE });
    const step = P.pollMs;
    assert.ok(g.svc.runPass(T0).ok);
    const [open] = g.svc.listOpen();
    assert.deepStrictEqual([open.kind, open.phase, open.victims], ["STRANDED_POD", "CALLING", 1]);
    const [spec] = g.scene.specs;
    assert.deepStrictEqual([spec.profileId, spec.spawnOffsetMeters, spec.anchor.kind], [POD_PROFILE,
      P.podDistanceMeters, "belt"]);
    assert.deepStrictEqual([g.scene.idsOf("pirate").length, g.svc.getStatus().counters.startedStrandedPod], [0, 1]);
    const [podId] = g.scene.idsOf("victim");
    const podX = g.scene.ships.get(podId).position.x;
    g.scene.player = { x: podX + 1000, y: 0, z: 0 };
    g.svc.runPass(T0 + step);
    g.scene.player = { x: podX + P.rescueRangeMeters + 1000, y: 0, z: 0 };
    g.svc.runPass(T0 + 2 * step);
    assert.strictEqual(g.svc.getStatus().counters.podHoldResets, 1);
    g.scene.player = { x: podX + 1000, y: 0, z: 0 };
    g.svc.runPass(T0 + 3 * step);
    g.svc.runPass(T0 + 3 * step + P.rescueHoldMs - 1);
    assert.strictEqual(g.svc.listOpen().length, 1, "before the hold");
    g.svc.runPass(T0 + 3 * step + P.rescueHoldMs);
    const c = g.svc.getStatus().counters;
    assert.deepStrictEqual([c.rescued, c.payoutsPlanned, g.svc.listOpen().length], [1, 1, 0]);
    assert.ok(g.scene.despawned.includes(podId), "the capsule left");
    const rows = opened.store.transaction("sc7.read", (t) => ({ ok: true,
      sit: t.prepare("SELECT kind, state, end_reason, victims_saved, pirate_faction_id, anchor_kind FROM "
        + "world_situations").all(),
      pay: t.prepare("SELECT character_id, amount_isk FROM world_situation_payouts").all() })).value;
    assert.deepStrictEqual(rows.sit.map((r) => [r.kind, r.state, r.end_reason, r.victims_saved, r.pirate_faction_id,
      r.anchor_kind]), [["STRANDED_POD", "RESCUED", "PICKED_UP", 1, null, "belt"]]);
    assert.deepStrictEqual(rows.pay.map((r) => [r.character_id, r.amount_isk]), [[CHAR, P.rewardIskPerSaved]]);

    const k = rig(opened, P, { podProfileId: POD_PROFILE, bootAt: T0 + 1 });
    k.scene.refuse.add(POD_PROFILE);
    const T1 = T0 + 5 * P.bucketMs;
    k.svc.runPass(T1);
    const st = k.svc.getStatus();
    assert.deepStrictEqual([st.podKindOff, st.counters.podKindOff, st.counters.startedStrandedPod], ["SPAWN_FAILED",
      1, 1]);
    assert.ok(k.logs.some((l) => l.includes("stranded pod kind off")), k.logs.join("\n"));
    k.svc.runPass(T1 + P.bucketMs);
    const c2 = k.svc.getStatus().counters;
    assert.deepStrictEqual([c2.cancelled, c2.startedStrandedPod, c2["refused.NO_PROFILE"], k.scene.specs.length],
      [1, 1, 1, 1], "no second capsule");
  }));

  test("SN6: pirates refused by the scene NPC budget (pre-check or per ship) keep CALLING, no "
    + "spawnFailed / CANCELLED, the next pass fights; past callingTimeoutMs -> UNANSWERED; the seam hands "
    + "SCENE_NPC_BUDGET on", () => {
    withStore(driver, (opened) => {
      const P = settingsOf();
      let full = false;
      const gates = [];
      const g = rig(opened, P, { admitScene: (sys, n, source) => {
        gates.push([sys, n, source]);
        return full ? { ok: false, reason: "SCENE_NPC_BUDGET", count: 150, cap: 150 } : { ok: true, count: 0, cap: 150 };
      } });
      assert.ok(g.svc.runPass(T0).ok);
      assert.deepStrictEqual(g.svc.listOpen().map((o) => o.phase), ["CALLING"]);
      const victims = g.scene.specs.length;
      g.scene.player = { x: 1000, y: 0, z: 0 };
      full = true;
      g.svc.runPass(T0 + P.pollMs);
      assert.deepStrictEqual(gates[gates.length - 1].slice(2), ["situations"]);
      assert.deepStrictEqual([g.svc.listOpen().map((o) => o.phase), g.scene.specs.length], [["CALLING"], victims]);
      full = false;
      const seamSpawn = g.scene.seam.spawnShip;
      g.scene.seam.spawnShip = (sys, spec) => (spec.role === "pirate" ? { ok: false, reason: "SCENE_NPC_BUDGET" }
        : seamSpawn(sys, spec));
      g.svc.runPass(T0 + 2 * P.pollMs);
      let c = g.svc.getStatus().counters;
      assert.deepStrictEqual([g.svc.listOpen().map((o) => o.phase), c.piratesDeferred, c.spawnFailed, c.cancelled],
        [["CALLING"], 2, 0, 0]);
      assert.ok(c.sceneRefused >= 1);
      g.scene.seam.spawnShip = seamSpawn;
      g.svc.runPass(T0 + 3 * P.pollMs);
      assert.deepStrictEqual(g.svc.listOpen().map((o) => o.phase), ["FIGHT"]);
      assert.ok(g.scene.idsOf("pirate").length > 0);
      c = g.svc.getStatus().counters;
      assert.deepStrictEqual([c.spawnFailed, c.cancelled, c.podKindOff], [0, 0, 0]);
    });
    withStore(driver, (opened) => {
      const P = settingsOf();
      let asked = 0;
      const g = rig(opened, P, { admitScene: () => ((asked += 1) === 1 ? { ok: true, count: 0, cap: 150 }
        : { ok: false, reason: "SCENE_NPC_BUDGET", count: 150, cap: 150 }) });
      assert.ok(g.svc.runPass(T0).ok);
      g.scene.player = { x: 1000, y: 0, z: 0 };
      g.svc.runPass(T0 + P.callingTimeoutMs);
      g.svc.runPass(T0 + P.callingTimeoutMs + P.pollMs);
      const c = g.svc.getStatus().counters;
      assert.deepStrictEqual([c.unanswered, c.cancelled, c.spawnFailed, g.scene.idsOf("pirate").length], [1, 0, 0, 0]);
    });
    const runtime = { scenes: new Map([[SYS, { getEntityByID: () => null }]]), isSolarSystemSceneLoaded: (s) => s === SYS };
    const seam = createSituationScene({ requireGame: (rel) => (rel === "space/runtime" ? { ok: true, exports: runtime }
      : { ok: false, reason: "missing" }), getHuntScene: () => null,
    getNpcSpawn: () => ({ pickGridAnchor: () => ({ ok: true, anchorDescriptor: { kind: "entity", itemID: 1 } }),
      spawnShip: () => ({ ok: false, reason: "SCENE_NPC_BUDGET", count: 150, cap: 150 }),
      publish: () => assert.fail("no publish"), despawn: () => ({ ok: true }) }) });
    assert.deepStrictEqual(seam.spawnShip(SYS, { role: "pirate", profileId: "p", anchor: { kind: "belt", id: 1 },
      spawnOffsetMeters: 0, situationId: "sx" }), { ok: false, reason: "SCENE_NPC_BUDGET" });
  });
};
