"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { startEscalations, createUnavailableEscalations } = require("../../lib/escalations");
const { createSiteService } = require("../../lib/events/sites/siteService");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { loadDriver, withStore } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SRC = 30000001;
const ALPHA = 30000002;
const BETA = 30000003;
const GAMMA = 30000004;
const C1 = 91000001;
const C2 = 91000002;
const C3 = 91000003;
const BASE_ENV = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_SITES_ENABLED: "1", EVEJS_LNE_NOTICES_ENABLED: "1",
  EVEJS_LNE_ESCALATIONS_ENABLED: "1", EVEJS_LNE_ESCALATIONS_CHANCE: "1",
  EVEJS_LNE_MAX_NEW_SITES_PER_SYSTEM_PER_WINDOW: "32" };

const configCache = new Map();
function cfg(env = {}, base = BASE_ENV) {
  const key = JSON.stringify([env, base]);
  if (!configCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { ...base, ...env } });
    assert.deepStrictEqual(r.errors || [], []);
    configCache.set(key, r.config);
  }
  return configCache.get(key);
}

function chainGraph() {
  const sys = { [SRC]: ["highsec", "Source Prime"], [ALPHA]: ["lowsec", "Alpha"], [BETA]: ["lowsec", "Beta"],
    [GAMMA]: ["lowsec", "Gamma"] };
  const links = { [SRC]: [ALPHA], [ALPHA]: [SRC, BETA], [BETA]: [ALPHA, GAMMA], [GAMMA]: [BETA] };
  return {
    getNeighbors: (id) => (links[id] ? links[id] : null),
    getSystem: (id) => (sys[id] ? { id, secClass: sys[id][0], name: sys[id][1] } : null),
  };
}

let nextInstance = 5000;
function completion(extra = {}) {
  nextInstance += 1;
  return { instanceId: nextInstance, systemId: SRC, templateId: "client-dungeon:9001", factionId: 500010,
    siteOrigin: "universe_dungeon", own: false, completedAtMs: T0 - 1000, characterIds: [C1], ...extra };
}

function rig(opened, conf, opts = {}) {
  const store = opened.store;
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const logger = { lines: [], log(l) { this.lines.push(l); } };
  const siteService = createSiteService({ store, adapter: {}, clock, config: conf, logger });
  const siteCalls = [];
  const sites = { getStatus: () => ({ state: "running" }),
    createSiteInTx(tx, req) {
      siteCalls.push(req.systemId);
      if (opts.refuseSite && opts.refuseSite(siteCalls.length)) return { ok: false, reason: "SITES_FULL" };
      return siteService.createSiteInTx(tx, req);
    } };
  const noticeRepo = createNoticeRepository();
  const noticesState = { state: opts.noticesState || "running" };
  const notices = { getStatus: () => noticesState,
    enqueueItemsInTx: (tx, items, now) => (opts.enqueue ? opts.enqueue(tx, items, now)
      : noticeRepo.enqueueItemsInTx(tx, items, now)) };
  const presenceBy = new Map(opts.presence || []);
  const presence = { getStatus: () => ({ available: true, stale: false }),
    getSystemPresence: (id) => (presenceBy.has(id)
      ? { systemId: id, characters: presenceBy.get(id).map((c) => ({ characterId: c })) } : null) };
  const graph = chainGraph();
  const listeners = [];
  const seam = { calls: 0 };
  const adapter = {
    onCombatSiteCompleted(fn) {
      seam.calls += 1;
      listeners.push(fn);
      return { ok: true, unsubscribe() {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      } };
    },
    getDungeonSites: () => ({ ok: true, checkTemplates: () => ({ ok: true, missing: [] }) }),
  };
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false };
    timers.push(t);
    return { cancel() { t.cancelled = true; }, hasRef: () => false };
  };
  const started = startEscalations({ config: conf, persistence: opened, clock, adapter, logger, setTimer,
    getSites: () => sites, getNotices: () => notices, getPresence: () => presence,
    getGraph: () => ({ getGraph: () => ({ ok: true, graph }) }) });
  const q = (sql) => {
    const r = store.transaction("esc.test", (db) => db.prepare(sql).all());
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return {
    clock, started, listeners, seam, timers, siteCalls, noticesState, logger, graph,
    esc: started.ok ? started.escalations : null,
    emit(c) {
      for (const fn of [...listeners]) fn(c);
    },
    pass() {
      return started.escalations.runPass(clock.now());
    },
    counters: () => started.escalations.getStatus().counters,
    rows: () => q("SELECT escalation_id AS id, target_system_id AS target, jumps, template_id AS tpl, site_key AS sk,"
      + " expires_at AS exp FROM world_escalations ORDER BY created_at, escalation_id")
      .map((r) => ({ ...r, target: Number(r.target), jumps: Number(r.jumps), exp: Number(r.exp) })),
    recipients: () => q("SELECT escalation_id AS id, character_id AS c FROM world_escalation_recipients"
      + " ORDER BY escalation_id, character_id").map((r) => ({ id: r.id, c: Number(r.c) })),
    sitesRows: () => q("SELECT event_id AS e, slot, system_id AS s, state, template_id AS tpl FROM world_event_sites"
      + " ORDER BY event_id").map((r) => ({ ...r, slot: Number(r.slot), s: Number(r.s) })),
    items: () => q("SELECT character_id AS c, kind, event_key AS k, system_id AS s, line FROM world_notice_items"
      + " ORDER BY item_id").map((r) => ({ ...r, c: Number(r.c), s: Number(r.s) })),
  };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("S1-S5 escalations service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("S1 happy path: one completion -> lead row, recipients, sites row (slot 0, CREATING), ESCALATION_LEAD lines "
    + "with the target name and the jumps; presence fallback when the completion has no characters", () => {
    withStore(driver, (opened) => {
      const h = rig(opened, cfg(), { presence: [[SRC, [C3]]] });
      assert.ok(h.started.ok, JSON.stringify(h.started));
      assert.strictEqual(h.seam.calls, 1);
      const c = completion({ characterIds: [C2, C1] });
      h.emit(c);
      assert.strictEqual(h.esc.getStatus().queued, 1);
      assert.ok(h.timers.some((t) => t.ms === 0 && !t.cancelled), "the listener armed the poller (arm(0))");
      const pass = h.pass();
      assert.deepStrictEqual(pass, { ok: true, processed: 1, offered: 1, skipped: 0, deferred: 0 });
      const id = `esc:${c.instanceId}:${c.completedAtMs}`;
      const rows = h.rows();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(rows[0].id, id);
      assert.ok([ALPHA, BETA, GAMMA].includes(rows[0].target), JSON.stringify(rows[0]));
      assert.strictEqual(rows[0].exp, T0 + cfg().escalations.leadTtlMs);
      assert.deepStrictEqual(h.recipients(), [{ id, c: C1 }, { id, c: C2 }]);
      assert.deepStrictEqual(h.sitesRows(), [{ e: id, slot: 0, s: rows[0].target, state: "CREATING", tpl: rows[0].tpl }]);
      const items = h.items();
      assert.deepStrictEqual(items.map((i) => [i.c, i.kind, i.k, i.s]),
        [[C1, "ESCALATION_LEAD", id, rows[0].target], [C2, "ESCALATION_LEAD", id, rows[0].target]]);
      const name = h.graph.getSystem(rows[0].target).name;
      const jumps = rows[0].jumps === 1 ? "1 jump" : `${rows[0].jumps} jumps`;
      assert.ok(items[0].line.includes(` in ${name} (`) && items[0].line.includes(`${jumps} from Source Prime`),
        items[0].line);
      assert.strictEqual(h.counters().offered, 1);
      assert.strictEqual(h.counters().completions, 1);

      h.emit(completion({ characterIds: [] }));
      assert.strictEqual(h.pass().offered, 1);
      assert.strictEqual(h.counters().recipientsFromPresence, 1);
      assert.ok(h.recipients().some((r) => r.c === C3));
      h.esc.stop();
    });
  });

  test("S2 idempotence / restart: the same completion twice (also in a new service on the same store) -> duplicate, "
    + "rows unchanged; a miss (chance 0) writes nothing", () => {
    withStore(driver, (opened) => {
      const h = rig(opened, cfg());
      const c = completion();
      h.emit(c);
      h.emit(c);
      const p = h.pass();
      assert.strictEqual(p.offered, 1);
      assert.strictEqual(h.counters().duplicate, 1);
      const before = [h.rows().length, h.recipients().length, h.sitesRows().length, h.items().length];
      assert.deepStrictEqual(before, [1, 1, 1, 1]);
      h.esc.stop();
      const h2 = rig(opened, cfg());
      h2.emit(c);
      h2.pass();
      assert.strictEqual(h2.counters().duplicate, 1);
      assert.strictEqual(h2.counters().offered, 0);
      assert.deepStrictEqual([h2.rows().length, h2.recipients().length, h2.sitesRows().length, h2.items().length],
        before);
      h2.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg({ EVEJS_LNE_ESCALATIONS_CHANCE: "0" }));
      h.emit(completion());
      assert.deepStrictEqual(h.pass(), { ok: true, processed: 1, offered: 0, skipped: 0, deferred: 0 });
      assert.strictEqual(h.counters().misses, 1);
      assert.deepStrictEqual([h.rows().length, h.sitesRows().length, h.items().length], [0, 0, 0]);
      h.esc.stop();
    });
  });

  test("S3 limits: a character over maxPerCharacterPerDay is left out (another gets the lead), all over -> "
    + "LIMIT_CHARACTER; maxPerDay -> LIMIT_DAY; maxActive -> LIMIT_ACTIVE; no write on a refusal", () => {
    withStore(driver, (opened) => {
      const h = rig(opened, cfg({ EVEJS_LNE_ESCALATIONS_MAX_PER_CHARACTER_PER_DAY: "1" }));
      h.emit(completion({ characterIds: [C1] }));
      h.emit(completion({ characterIds: [C1, C2] }));
      h.emit(completion({ characterIds: [C1, C2] }));
      h.pass();
      const leads = h.rows();
      assert.strictEqual(leads.length, 2);
      assert.deepStrictEqual(h.recipients().filter((r) => r.id === leads[1].id).map((r) => r.c), [C2]);
      assert.strictEqual(h.counters()["skipped.LIMIT_CHARACTER"], 1);
      assert.strictEqual(h.sitesRows().length, 2);
      assert.strictEqual(h.items().length, 2);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg({ EVEJS_LNE_ESCALATIONS_MAX_PER_DAY: "1" }));
      h.emit(completion({ characterIds: [C1] }));
      h.emit(completion({ characterIds: [C2] }));
      h.pass();
      assert.strictEqual(h.rows().length, 1);
      assert.strictEqual(h.counters()["skipped.LIMIT_DAY"], 1);
      assert.deepStrictEqual([h.sitesRows().length, h.items().length], [1, 1]);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg({ EVEJS_LNE_ESCALATIONS_MAX_ACTIVE: "1" }));
      h.emit(completion({ characterIds: [C1] }));
      h.emit(completion({ characterIds: [C2] }));
      h.pass();
      assert.strictEqual(h.rows().length, 1);
      assert.strictEqual(h.counters()["skipped.LIMIT_ACTIVE"], 1);
      assert.deepStrictEqual([h.sitesRows().length, h.items().length], [1, 1]);
      h.esc.stop();
    });
  });

  test("S4 dependency refusals: notices stopped -> skipped.NOTICES without a site row; every site attempt refused "
    + "-> SITE_REFUSED, nothing written; the second attempt placed -> lead in the second system; own / "
    + "excludedOrigins -> excluded, queue empty", () => {
    withStore(driver, (opened) => {
      const h = rig(opened, cfg());
      h.noticesState.state = "stopped";
      h.emit(completion());
      h.pass();
      assert.strictEqual(h.counters()["skipped.NOTICES"], 1);
      assert.deepStrictEqual([h.rows().length, h.sitesRows().length, h.items().length], [0, 0, 0]);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg(), { refuseSite: () => true });
      h.emit(completion());
      h.pass();
      assert.strictEqual(h.counters()["skipped.SITE_REFUSED"], 1);
      assert.strictEqual(h.siteCalls.length, 3, "maxTargetAttempts attempts, one per system");
      assert.strictEqual(new Set(h.siteCalls).size, 3);
      assert.deepStrictEqual([h.rows().length, h.sitesRows().length, h.items().length], [0, 0, 0]);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg(), { refuseSite: (n) => n === 1 });
      h.emit(completion());
      h.pass();
      const rows = h.rows();
      assert.strictEqual(rows.length, 1);
      assert.strictEqual(h.siteCalls.length, 2);
      assert.strictEqual(rows[0].target, h.siteCalls[1]);
      assert.notStrictEqual(rows[0].target, h.siteCalls[0]);
      assert.strictEqual(h.sitesRows()[0].s, h.siteCalls[1]);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg());
      h.emit(completion({ own: true, siteOrigin: "lne_event" }));
      h.emit(completion({ siteOrigin: "Sansha_Incursion" }));
      assert.strictEqual(h.counters().excluded, 2);
      assert.strictEqual(h.esc.getStatus().queued, 0);
      h.esc.stop();
    });
  });

  test("S6 notices refusal after the site insert -> whole tx rolled back; INVALID_INPUT -> errors + "
    + "log, not skipped.NOTICES; retention keeps rows the limit window still counts", () => {
    withStore(driver, (opened) => {
      const h = rig(opened, cfg(), { enqueue: () => ({ ok: false, reason: "NOTICES_STOPPED" }) });
      h.emit(completion());
      h.pass();
      assert.strictEqual(h.siteCalls.length, 1, "the site was inserted inside the transaction");
      assert.strictEqual(h.counters()["skipped.NOTICES"], 1);
      assert.deepStrictEqual([h.rows().length, h.recipients().length, h.sitesRows().length, h.items().length],
        [0, 0, 0, 0]);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const h = rig(opened, cfg(), { enqueue: () => ({ ok: false, reason: "INVALID_INPUT", detail: "items[0].line" }) });
      h.emit(completion());
      assert.strictEqual(h.pass().skipped, 1);
      assert.strictEqual(h.counters().errors, 1);
      assert.strictEqual(h.counters()["skipped.NOTICES"], 0);
      assert.ok(h.logger.lines.some((l) => l.includes("INVALID_INPUT") && l.includes("items[0].line")),
        h.logger.lines.join("\n"));
      assert.deepStrictEqual([h.rows().length, h.sitesRows().length, h.items().length], [0, 0, 0]);
      h.esc.stop();
    });
    withStore(driver, (opened) => {
      const DAY = 86400000;
      const HOUR = 3600000;
      const h = rig(opened, cfg({ EVEJS_LNE_ESCALATIONS_RETENTION_MS: String(DAY),
        EVEJS_LNE_ESCALATIONS_LIMIT_WINDOW_MS: String(7 * DAY), EVEJS_LNE_ESCALATIONS_LEAD_TTL_MS: String(HOUR),
        EVEJS_LNE_ESCALATIONS_MAX_PER_CHARACTER_PER_DAY: "1" }));
      h.emit(completion({ characterIds: [C1] }));
      assert.strictEqual(h.pass().offered, 1);
      h.clock.t = T0 + HOUR + DAY + 1;
      h.pass();
      assert.strictEqual(h.counters().retained, 0);
      assert.strictEqual(h.rows().length, 1);
      h.emit(completion({ characterIds: [C1], completedAtMs: h.clock.t - 1000 }));
      h.pass();
      assert.strictEqual(h.counters()["skipped.LIMIT_CHARACTER"], 1, "the kept row still counts in the window");
      h.clock.t = T0 + HOUR + 7 * DAY + 1;
      h.pass();
      assert.strictEqual(h.counters().retained, 1);
      assert.strictEqual(h.rows().length, 0);
      h.esc.stop();
    });
  });

  test("S5 start: default config -> disabled_by_config, no seam call; notices off -> dependency_disabled:notices; "
    + "bad siteKind -> ESCALATIONS_START_FAILED; stop() removes the listener; the stub refuses", () => {
    withStore(driver, (opened) => {
      const def = rig(opened, cfg({}, { EVEJS_DATA_ROOT: os.tmpdir() }));
      assert.deepStrictEqual(def.started, { ok: false, reason: "disabled_by_config" });
      assert.strictEqual(def.seam.calls, 0);
      const noSites = rig(opened, cfg({ EVEJS_LNE_SITES_ENABLED: "0" }));
      assert.deepStrictEqual(noSites.started, { ok: false, reason: "disabled_by_config" });
      const off = rig(opened, cfg(), { noticesState: "unavailable" });
      assert.deepStrictEqual(off.started, { ok: false, reason: "dependency_disabled:notices" });
      assert.strictEqual(off.seam.calls, 0);
      const bad = rig(opened, cfg({ EVEJS_LNE_ESCALATIONS_SITE_KIND: "wormhole" }));
      assert.deepStrictEqual(bad.started, { ok: false, reason: "ESCALATIONS_START_FAILED", detail: "siteKind" });
      assert.strictEqual(bad.seam.calls, 0);

      const h = rig(opened, cfg());
      assert.strictEqual(h.listeners.length, 1);
      assert.strictEqual(h.esc.getStatus().listening, true);
      h.esc.stop();
      assert.strictEqual(h.listeners.length, 0);
      assert.strictEqual(h.esc.getStatus().state, "stopped");
      assert.ok(h.timers.every((t) => t.cancelled), "poller timer cancelled");

      const stub = createUnavailableEscalations("ESCALATIONS_DISABLED", "disabled_by_config");
      assert.deepStrictEqual(stub.runPass(T0), { ok: false, reason: "ESCALATIONS_DISABLED",
        detail: "disabled_by_config" });
      assert.strictEqual(stub.getStatus().state, "unavailable");
    });
  });
};
