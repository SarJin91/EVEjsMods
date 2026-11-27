"use strict";

const assert = require("node:assert");

const { createSiteStep } = require("../../lib/gameMaster/steps/site");
const { registerBuiltin, createStepRegistry } = require("../../lib/gameMaster/registry");
const { buildOffer } = require("../../lib/gameMaster/digest");
const { templateProposal } = require("../../lib/gameMaster/fallback");
const { validateProposal } = require("../../lib/gameMaster/validate");
const { createGameMasterService } = require("../../lib/gameMaster/service");
const { createGameMasterRepository } = require("../../lib/gameMaster/repository");
const { startGameMaster } = require("../../lib/gameMaster");
const { ARCS } = require("../../lib/gameMaster/data/arcs");
const { OUTPOST_TEMPLATES } = require("../../lib/events/data/eventCatalog");
const { createJournal } = require("../../lib/persistence/journal");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const HOUR = 3600000;
const T0 = 1763568000000 + HOUR;
const TX = Object.freeze({ inTransaction: true });

function stubSites() {
  const s = { state: "running", calls: [], next: null, rows: new Map(), listeners: [] };
  s.facade = Object.freeze({
    getStatus: () => ({ state: s.state }),
    createSiteInTx(_tx, req) {
      s.calls.push(["create", req]);
      if (s.next) return s.next;
      if (!s.rows.has(req.eventId)) {
        s.rows.set(req.eventId, { siteKey: `lne:${req.eventId}:0`, slot: 0, state: "CREATING",
          expiresAt: req.expiresAt });
      }
      return { ok: true, siteKey: `lne:${req.eventId}:0`, created: true, state: "CREATING" };
    },
    listSitesByEvent: (eventId) => ({ ok: true, sites: s.rows.has(eventId) ? [s.rows.get(eventId)] : [] }),
    cleanupSitesInTx(_tx, eventId, reason) {
      s.calls.push(["cleanup", eventId, reason]);
      return { ok: true, released: 1 };
    },
    addSiteStateListener(fn) {
      s.listeners.push(fn);
      return () => {
        s.listeners = s.listeners.filter((x) => x !== fn);
      };
    },
  });
  return s;
}

function spyTimers() {
  const calls = [];
  return { calls, setTimer: (fn, ms) => {
    calls.push(ms);
    return { cancel() {}, hasRef: () => false };
  } };
}

module.exports = ({ test, skip }) => {
  test("G6 SITE kind on a stub of ctx.sites: validate, start (retry on SITES_FULL), poll WON / RUNNING / LOST, cancel; "
    + "arcs with SITE only with SITE registered", () => {
    const S = F.settingsOf({ enabled: true });
    const st = stubSites();
    const kind = createSiteStep({ getSites: () => st.facade, S });
    const offer = { places: [{ ref: "P1", systemId: 30000002 }] };
    assert.deepStrictEqual(kind.validate({ place: "P1", hours: 6 }, { offer, arc: ARCS.MUTINY }), { ok: true,
      params: { site: "pirate_outpost", systemId: 30000002, hours: 6, label: "Mutineer Hideout" } });
    assert.strictEqual(kind.validate({ hours: 99 }, { offer, arc: ARCS.MUTINY }).params.hours, S.siteMaxHours);
    assert.strictEqual(kind.validate({ hours: 6, site: "ded_complex" }, { offer, arc: ARCS.MUTINY }).reason, "SITE");
    assert.strictEqual(kind.validate({ hours: 6, place: "P9" }, { offer, arc: ARCS.MUTINY }).reason, "PLACE");
    assert.strictEqual(kind.validate({ place: "P1" }, { offer, arc: ARCS.MUTINY }).reason, "HOURS");
    assert.strictEqual(kind.validate({ hours: 6 }, { offer, arc: ARCS.WAR_RUMOUR }).reason, "NO_SITE");

    const params = { site: "pirate_outpost", systemId: null, hours: 6, label: "Mutineer Hideout" };
    const s = { threadId: "gmt:1", stepNo: 2, stepKey: "gm:gmt:1:2", params, handle: null, factionId: 500010,
      systemId: 30000001, now: T0, seed: 77 };
    st.next = { ok: false, reason: "SITES_FULL" };
    assert.deepStrictEqual(kind.startInTx(TX, s), { ok: false, reason: "SITES_FULL", retry: true });
    st.next = { ok: false, reason: "IDEMPOTENCY_CONFLICT" };
    assert.deepStrictEqual(kind.startInTx(TX, s), { ok: false, reason: "IDEMPOTENCY_CONFLICT", retry: false });
    st.next = null;
    const started = kind.startInTx(TX, s);
    assert.deepStrictEqual(started, { ok: true, dueAt: T0,
      handle: { siteKey: "lne:gm:gmt:1:2:0", systemId: 30000001, expiresAt: T0 + 6 * HOUR } });
    const reqs = st.calls.filter((c) => c[0] === "create").map((c) => c[1]);
    assert.deepStrictEqual(reqs.map((r) => [r.eventId, r.slot, r.systemId, r.label, r.factionId, r.expiresAt]),
      Array(3).fill(["gm:gmt:1:2", 0, 30000001, "Mutineer Hideout", 500010, T0 + 6 * HOUR]));
    assert.ok(OUTPOST_TEMPLATES[500010].includes(reqs[0].templateId), reqs[0].templateId);
    assert.ok(reqs.every((r) => r.templateId === reqs[0].templateId), "the same template on a retry (seed, stepNo)");
    assert.deepStrictEqual(kind.startInTx(TX, { ...s, factionId: 500001 }),
      { ok: false, reason: "NO_TEMPLATE", retry: false });

    const polled = { ...s, handle: started.handle };
    const row = st.rows.get("gm:gmt:1:2");
    row.state = "ACTIVE";
    assert.deepStrictEqual(kind.pollInTx(TX, polled), { state: "RUNNING", dueAt: T0 });
    assert.deepStrictEqual(kind.pollInTx(TX, { ...polled, now: T0 + 6 * HOUR }), { state: "DONE", outcome: "LOST" });
    row.state = "FAILED";
    assert.deepStrictEqual(kind.pollInTx(TX, polled), { state: "DONE", outcome: "LOST" });
    row.state = "COMPLETED";
    assert.deepStrictEqual(kind.pollInTx(TX, { ...polled, now: T0 + 7 * HOUR }), { state: "DONE", outcome: "WON" });
    assert.deepStrictEqual(kind.cancelInTx(TX, polled, "DEADLINE"), { ok: true });
    assert.deepStrictEqual(st.calls.filter((c) => c[0] === "cleanup"), [["cleanup", "gm:gmt:1:2", "EVENT_CANCELLED"]]);

    const graph = F.graphFixture();
    const input = (registry) => ({ cycleAt: T0 - HOUR, seed: 5, graph, factionNames: F.NAMES, activityRows: [],
      recentThreads: [], registry, S });
    const plain = F.registryWithBuiltins(S).registry;
    assert.deepStrictEqual(buildOffer(input(plain)).offer.arcs, ["WAR_RUMOUR"]);
    const full = F.registryWithBuiltins(S).registry;
    assert.ok(registerBuiltin(full, kind).ok);
    const o = buildOffer(input(full)).offer;
    assert.deepStrictEqual(o.arcs, ["DEFECTOR", "MUTINY", "SMUGGLER_CACHE", "WAR_RUMOUR"]);
    const seen = new Set();
    for (let seed = 1; seed <= 40; seed += 1) {
      const p = templateProposal(o, seed, S);
      assert.ok(p.ok, JSON.stringify(p));
      const v = validateProposal(p.raw, o, full, S, "template");
      assert.ok(v.ok, `${seed} ${JSON.stringify(v)}`);
      seen.add(v.plan.arc);
      for (const step of v.plan.steps.filter((x) => x.kind === "SITE")) {
        assert.strictEqual(step.params.site, ARCS[v.plan.arc].siteTemplate);
      }
    }
    assert.ok(seen.has("MUTINY") && seen.has("SMUGGLER_CACHE"), [...seen].join(","));
  });

  test("G6c SITE poll: LOST before the expiry -> RUNNING (sites recreates it), at the expiry -> LOST "
    + "CREATING / ACTIVE -> RUNNING, COMPLETED -> WON; CLEANING / CLEANED / PURGED / FAILED / no row -> LOST", () => {
    const S = F.settingsOf({ enabled: true });
    const st = stubSites();
    const kind = createSiteStep({ getSites: () => st.facade, S });
    const key = "gm:gmt:2:1";
    const row = { siteKey: `lne:${key}:0`, slot: 0, state: "LOST", expiresAt: T0 + 6 * HOUR };
    st.rows.set(key, row);
    const s = { threadId: "gmt:2", stepNo: 1, stepKey: key, params: {}, now: T0,
      handle: { siteKey: row.siteKey, systemId: 30000001, expiresAt: T0 + 6 * HOUR } };
    const LOST = { state: "DONE", outcome: "LOST" };
    assert.deepStrictEqual(kind.pollInTx(TX, s), { state: "RUNNING", dueAt: T0 });
    assert.deepStrictEqual(kind.pollInTx(TX, { ...s, now: T0 + 6 * HOUR }), LOST);
    for (const state of ["CREATING", "ACTIVE"]) {
      row.state = state;
      assert.deepStrictEqual(kind.pollInTx(TX, s), { state: "RUNNING", dueAt: T0 }, state);
    }
    row.state = "COMPLETED";
    assert.deepStrictEqual(kind.pollInTx(TX, s), { state: "DONE", outcome: "WON" });
    for (const state of ["CLEANING", "CLEANED", "PURGED", "FAILED"]) {
      row.state = state;
      assert.deepStrictEqual(kind.pollInTx(TX, s), LOST, state);
    }
    st.rows.delete(key);
    assert.deepStrictEqual(kind.pollInTx(TX, s), LOST, "no row in slot 0");
  });

  test("G6d SITE maxPerThread = maxSiteStepsPerThread clamped to 1..3; 3 SITE steps ok at 3, STEP_LIMIT "
    + "at 2", () => {
    const st = stubSites();
    const at = (n) => F.settingsOf({ enabled: true, maxSiteStepsPerThread: n });
    const k3 = createSiteStep({ getSites: () => st.facade, S: at(3) });
    assert.strictEqual(k3.maxPerThread, 3);
    assert.ok(registerBuiltin(createStepRegistry(), k3).ok);
    const k0 = createSiteStep({ getSites: () => st.facade, S: at(0) });
    assert.strictEqual(k0.maxPerThread, 1);
    assert.ok(registerBuiltin(createStepRegistry(), k0).ok);
    const offer = Object.freeze({ places: [{ ref: "P1", systemId: 30000001, name: "Ostu", regionId: 10000001,
      regionName: "Alpha Reach", secClass: "lowsec" }],
    factions: [{ key: "guristas", factionId: 500010, role: "pirate", name: "Guristas Pirates" }],
    arcs: ["MUTINY"], stepKinds: [], recent: [], activity: [], lines: [], cycleAt: T0 });
    const raw = JSON.stringify({ v: 1, arc: "MUTINY", faction: "guristas", place: "P1", title: "Mutiny near Ostu",
      hook: "Pilots in Ostu speak of a Guristas Pirates mutiny.", end: { won: "It is over.", lost: "They got away." },
      steps: [1, 2, 3].map(() => ({ t: "SITE", place: "P1", hours: 3 })) });
    const v = (n) => {
      const S = at(n);
      const { registry } = F.registryWithBuiltins(S);
      assert.ok(registerBuiltin(registry, createSiteStep({ getSites: () => st.facade, S })).ok);
      return validateProposal(raw, offer, registry, S);
    };
    const ok3 = v(3);
    assert.ok(ok3.ok, JSON.stringify(ok3));
    assert.strictEqual(ok3.plan.steps.filter((x) => x.kind === "SITE").length, 3);
    assert.strictEqual(v(2).reason, "STEP_LIMIT");
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("G6 SITE thread on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("G6 SITE thread on a store: RUNNING -> COMPLETED -> ENDED/WON; deadline -> cleanup; startGameMaster registers "
    + "SITE while sites runs, the listener wakes the poller for gm:* only", () => {
    withStore(driver, (opened) => {
      const clock = { now: T0 };
      const journal = createJournal({ clock: { now: () => clock.now }, maxPayloadBytes: 4096, maxRows: 500 });
      const S = F.settingsOf({ enabled: true });
      const st = stubSites();
      const { registry, sender } = F.registryWithBuiltins(S);
      assert.ok(registerBuiltin(registry, createSiteStep({ getSites: () => st.facade, S })).ok);
      const repo = createGameMasterRepository();
      const svc = createGameMasterService({ store: opened.store, journal, worldSeed: 1, settings: S, registry,
        sender });
      const step = { kind: "SITE", version: 1, params: { site: "pirate_outpost", systemId: null, hours: 6,
        label: "Mutineer Hideout" }, durationMs: 6 * HOUR };
      const plan = { v: 1, arc: "MUTINY", source: "template", factionId: 500010, actorFactionId: null,
        systemId: 30000002, regionId: 10000001, title: "Mutiny", hook: "x", end: { won: "x", lost: "x" },
        steps: [step], textFallback: [] };
      const seed = (threadId, cycleAt, deadlineAt) => opened.store.transaction("g6.seed", (tx) => repo
        .insertThreadInTx(tx, { threadId, cycleAt, arc: "MUTINY", source: "template", factionId: 500010,
          actorFactionId: null, anchorSystemId: 30000002, planJson: JSON.stringify(plan), stepDueAt: T0,
          deadlineAt, seed: 3, now: T0 }));
      const read = (id) => opened.store.transaction("g6.read", (tx) => repo.readThreadInTx(tx, id)).value;
      assert.ok(seed("gmt:10", 10, T0 + 48 * HOUR).value.ok);
      assert.ok(svc.runPass(T0).ok);
      let t = read("gmt:10");
      assert.deepStrictEqual([t.state, t.stepState, t.stepHandle.siteKey], ["ACTIVE", "RUNNING", "lne:gm:gmt:10:0:0"]);
      st.rows.get("gm:gmt:10:0").state = "ACTIVE";
      assert.ok(svc.runPass(T0 + 60000).ok);
      assert.strictEqual(read("gmt:10").stepState, "RUNNING");
      st.rows.get("gm:gmt:10:0").state = "COMPLETED";
      assert.ok(svc.runPass(T0 + 120000).ok);
      t = read("gmt:10");
      assert.deepStrictEqual([t.state, t.outcome, t.stepResults.map((r) => [r.kind, r.state, r.outcome])],
        ["ENDED", "WON", [["SITE", "DONE", "WON"]]]);

      assert.ok(seed("gmt:20", 20, T0 + HOUR).value.ok);
      assert.ok(svc.runPass(T0 + 180000).ok);
      assert.ok(svc.runPass(T0 + 2 * HOUR).ok);
      t = read("gmt:20");
      assert.deepStrictEqual([t.state, t.outcome], ["ENDED", "EXPIRED"]);
      assert.deepStrictEqual(st.calls.filter((c) => c[0] === "cleanup"), [["cleanup", "gm:gmt:20:0", "EVENT_CANCELLED"]]);

      const timers = spyTimers();
      const shared = createStepRegistry();
      const st2 = stubSites();
      const on = startGameMaster({ config: { enabled: true, modules: { world: { enabled: true } },
        gameMaster: F.sectionOf({ enabled: true }) }, persistence: { ok: true, store: opened.store, journal,
        worldSeed: 1 }, clock: { now: () => clock.now }, setTimer: timers.setTimer, registry: shared,
        getSites: () => st2.facade });
      assert.ok(on.ok, JSON.stringify(on));
      assert.deepStrictEqual(shared.list().map((k) => k.type), ["NEWS", "NOTICE", "SITE", "WAIT"]);
      assert.strictEqual(st2.listeners.length, 1);
      const before = timers.calls.length;
      st2.listeners[0]({ siteKey: "lne:ev:1:0", eventId: "ev:1", slot: 0, state: "COMPLETED" });
      assert.strictEqual(timers.calls.length, before, "no nudge for another event");
      st2.listeners[0]({ siteKey: "lne:gm:gmt:30:0:0", eventId: "gm:gmt:30:0", slot: 0, state: "COMPLETED" });
      assert.deepStrictEqual(timers.calls.slice(before), [0], "the nudge arms the pass at 0");
      st2.state = "stopped";
      on.gameMaster.runPass();
      assert.deepStrictEqual(shared.list().map((k) => k.type), ["NEWS", "NOTICE", "WAIT"]);
      assert.strictEqual(st2.listeners.length, 0, "the listener follows the running facade");
      st2.state = "running";
      on.gameMaster.runPass();
      assert.ok(shared.get("SITE"));
      on.gameMaster.stop();
      assert.deepStrictEqual([shared.list(), st2.listeners.length], [[], 0]);
    });
  });
};
