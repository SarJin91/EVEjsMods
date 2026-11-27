"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { startArchaeology } = require("../../lib/archaeology");
const S = require("../../lib/archaeology/schema");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { START, EXCLUDED_REGION, lineGraph, fakeSites } = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const C1 = 91000001;
const C2 = 91000002;
const BASE_ENV = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_SITES_ENABLED: "1", EVEJS_LNE_ARCHAEOLOGY_ENABLED: "1",
  EVEJS_LNE_ARCHAEOLOGY_START_CHANCE_PERMILLE: "1000", EVEJS_LNE_ARCHAEOLOGY_RESTART_COOLDOWN_MS: "0" };

const configCache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { ...BASE_ENV, ...env } });
    assert.deepStrictEqual(r.errors || [], []);
    configCache.set(key, r.config);
  }
  return configCache.get(key);
}

let nextInstance = 7000;
function hackWin(extra = {}) {
  nextInstance += 1;
  return { instanceId: nextInstance, systemId: START, siteFamily: "relic", siteKind: "signature",
    templateId: "client-dungeon:1808", own: false, lneEventId: null, excluded: false, contentKey: "k:1",
    characterId: C1, outcomeId: `o-${nextInstance}`, atMs: T0 - 1000, ...extra };
}

function rig(opened, conf, opts = {}) {
  const store = opts.store || opened.store;
  const clock = opts.clock || { t: T0, now() { return this.t; } };
  const logger = { lines: [], log(l) { this.lines.push(l); } };
  const noticeRepo = createNoticeRepository();
  const notices = { getStatus: () => ({ state: opts.noticesState || "running" }),
    enqueueItemsInTx: opts.enqueue || ((tx, items, now) => noticeRepo.enqueueItemsInTx(tx, items, now)) };
  const graph = lineGraph();
  const world = { repository: { getSystems: (tx, ids) => ({ ok: true, missing: [],
    systems: ids.map((id) => ({ systemId: id, controllerFactionId: id % 2 === 0 ? 500011 : null })) }) } };
  const listeners = [];
  const lines = [];
  const installs = [];
  const seam = { calls: 0 };
  const sites = opts.sites || fakeSites();
  const wins = opts.wins || new Map();
  const adapter = opts.adapter || {
    readSiteHackWins: (siteKey) => wins.get(siteKey) || { ok: true, state: "active", wins: [] },
    readItemTypeFacts: opts.readItemTypeFacts || ((ids) => ({ ok: true,
      facts: new Map(ids.map((id) => [id, { typeId: id }])), missing: [] })),
    ...(opts.readWormholePairs ? { readWormholePairs: opts.readWormholePairs } : {}),
    onSiteContainerHacked(fn) {
      seam.calls += 1;
      listeners.push(fn);
      return { ok: true, unsubscribe() {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      } };
    },
    sendCharacterSystemLine: (spec) => {
      lines.push(spec);
      return { ok: true };
    },
    installChatCommand: (o) => {
      installs.push(o);
      return { ok: true };
    },
    uninstallChatCommand: () => ({ ok: true }),
  };
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false };
    timers.push(t);
    return { cancel() { t.cancelled = true; }, hasRef: () => false };
  };
  const started = startArchaeology({ config: conf, persistence: { ...opened, store }, clock, adapter, logger,
    setTimer, views: opts.views || null, excludedRegionIds: [EXCLUDED_REGION], getNotices: () => notices,
    getGraph: opts.getGraph || (() => graph), getWorld: () => world, getSeasons: () => opts.seasons || null, getSites: () => sites,
    getPresence: () => opts.presence || null, getChatterAi: () => opts.chatterAi || null });
  const q = (sql) => {
    const r = opened.store.transaction("arc.test", (db) => db.prepare(sql).all());
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { started, a: started.archaeology, emit: (w) => listeners.forEach((fn) => fn(w)), listeners, lines,
    installs, seam, timers, clock, logger, q, sites, wins };
}

const chains = (r) => r.q(`SELECT * FROM ${S.TABLE} ORDER BY chain_id`);
const items = (r) => r.q("SELECT * FROM world_notice_items WHERE kind = 'ARCH_HINT' ORDER BY event_key");

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("A3 archaeology service", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test("A3 archaeology service: same win 2x / two passes / restart -> 1 chain + 1 mail; second player; "
    + "ACTIVE_EXISTS; deadline -> EXPIRED; retention after retentionMs", () => withStore(driver, (opened) => {
    const conf = cfg();
    const r = rig(opened, conf);
    assert.strictEqual(r.started.ok, true, JSON.stringify(r.started));
    assert.strictEqual(r.installs.length, 1, "!relic installed");
    const w = hackWin();
    r.emit(w);
    r.emit(w);
    assert.strictEqual(r.a.runPass(T0).ok, true);
    r.a.runPass(T0 + 1);
    let rows = chains(r);
    assert.strictEqual(rows.length, 1);
    const c = rows[0];
    assert.strictEqual(c.chain_id, `arc:s0:${C1}:1`);
    assert.deepStrictEqual([c.state, c.stage_state, c.stage_no], ["ACTIVE", "REVEALED", 1]);
    assert.ok(c.stage_count >= 4 && c.stage_count <= 6, String(c.stage_count));
    assert.ok(c.stage_system_id >= 106 && c.stage_system_id <= 120 && c.stage_system_id !== 111
      && c.stage_system_id !== 112, String(c.stage_system_id));
    assert.strictEqual(c.next_check_at, T0 + conf.archaeology.presenceCheckMs);
    assert.strictEqual(c.deadline_at, T0 + conf.archaeology.chainMaxMs);
    assert.deepStrictEqual(JSON.parse(c.visited_regions)[0], 10);
    let mails = items(r);
    assert.strictEqual(mails.length, 1);
    assert.strictEqual(mails[0].event_key, `arch:hint:${c.chain_id}:1`);
    assert.ok(mails[0].line.includes(`Sys-${c.stage_system_id}`) && mails[0].line.length <= 400, mails[0].line);
    assert.strictEqual(r.lines.length, 1);
    assert.deepStrictEqual([r.lines[0].characterId, r.lines[0].systemId], [C1, START]);
    const st = r.a.getStatus().counters;
    assert.deepStrictEqual([st["chains.started"], st["starts.duplicate"], st["mail.queued"], st["line.sent"]],
      [1, 1, 1, 1]);
    assert.strictEqual(r.a.readChainOf(C1).chain.stageNo, 1);
    assert.deepStrictEqual(r.a.readChainOf(C2), { ok: true, chain: null });

    r.a.stop();
    const r2 = rig(opened, conf);
    r2.emit(w);
    r2.a.runPass(T0 + 2);
    assert.strictEqual(chains(r2).length, 1);
    assert.strictEqual(items(r2).length, 1);
    assert.strictEqual(r2.a.getStatus().counters["starts.duplicate"], 1);
    r2.emit(hackWin());
    r2.emit(hackWin({ characterId: C2 }));
    r2.a.runPass(T0 + 3);
    rows = chains(r2);
    assert.deepStrictEqual(rows.map((x) => x.character_id), [C1, C2]);
    assert.strictEqual(r2.a.getStatus().counters["starts.refused.ACTIVE_EXISTS"], 1);
    mails = items(r2);
    assert.strictEqual(mails.length, 2);

    const end = T0 + conf.archaeology.chainMaxMs;
    r2.a.runPass(end + 10);
    rows = chains(r2);
    assert.deepStrictEqual(rows.map((x) => [x.state, x.end_reason, x.ended_at]),
      [["EXPIRED", "DEADLINE", end + 10], ["EXPIRED", "DEADLINE", end + 10]]);
    assert.strictEqual(r2.a.getStatus().counters["chains.ended.EXPIRED"], 2);
    r2.emit(hackWin());
    r2.a.runPass(end + 20);
    assert.strictEqual(chains(r2).length, 2);
    assert.strictEqual(r2.a.getStatus().counters["starts.refused.SEASON_LIMIT"], 1);
    assert.strictEqual(r2.a.getStatus().chainsActive, 0);

    r2.a.runPass(end + 10 + conf.archaeology.retentionMs);
    assert.strictEqual(chains(r2).length, 2, "not yet (ended_at < before is strict)");
    r2.a.runPass(end + 11 + conf.archaeology.retentionMs);
    assert.strictEqual(chains(r2).length, 2, "the newest chain of each pair stays");
    assert.strictEqual(r2.a.getStatus().counters["retention.deleted"], 0);
    r2.a.stop();
  }));

  function twoEndedThenRetention(opened, opts) {
    const conf = cfg({ EVEJS_LNE_ARCHAEOLOGY_CHAINS_PER_CHARACTER_PER_SEASON: "2" });
    const r = rig(opened, conf, opts);
    const M = conf.archaeology.chainMaxMs;
    const R = conf.archaeology.retentionMs;
    r.emit(hackWin());
    r.a.runPass(T0);
    r.a.runPass(T0 + M + 10);
    r.emit(hackWin());
    r.a.runPass(T0 + M + 20);
    r.a.runPass(T0 + 2 * M + 30);
    assert.deepStrictEqual(chains(r).map((x) => [x.chain_no, x.state]), [[1, "EXPIRED"], [2, "EXPIRED"]]);
    const tR = T0 + M + 11 + R;
    assert.strictEqual(r.a.runPass(tR).retained, 1, "retention deletes chain 1");
    assert.deepStrictEqual(chains(r).map((x) => x.chain_no), [2]);
    return { r, conf, M, R, tR };
  }

  test("A5 archaeology: a5a season key of the seasons service -> SEASON_LIMIT survives retention "
    + "a5b s0 key -> rolling window, chainNo = MAX + 1 (:3), the newest chain never deleted; a5c a duplicate mail = "
    + "skipped; errors 0", () => {
    withStore(driver, (opened) => {
      const { r, tR } = twoEndedThenRetention(opened, { seasons: { currentSeasonKey: () => "se1" } });
      assert.ok(chains(r)[0].chain_id.startsWith("arc:se1:"), chains(r)[0].chain_id);
      r.emit(hackWin());
      r.a.runPass(tR + 1);
      const st = r.a.getStatus().counters;
      assert.strictEqual(st["starts.refused.SEASON_LIMIT"], 1);
      assert.strictEqual(st.errors, 0);
      assert.deepStrictEqual(chains(r).map((x) => x.chain_no), [2]);
      r.a.stop();
    });
    withStore(driver, (opened) => {
      const { r, M, R, tR } = twoEndedThenRetention(opened, {});
      r.emit(hackWin());
      r.a.runPass(tR + 1);
      let rows = chains(r);
      assert.deepStrictEqual(rows.map((x) => [x.chain_id, x.state]),
        [[`arc:s0:${C1}:2`, "EXPIRED"], [`arc:s0:${C1}:3`, "ACTIVE"]]);
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([st["chains.started"], st.errors], [3, 0]);
      assert.ok(!r.logger.lines.some((l) => l.includes("start failed")), r.logger.lines.join("\n"));
      const end3 = tR + 1 + M + 10;
      r.a.runPass(end3);
      r.a.runPass(end3 + R + 1);
      rows = chains(r);
      assert.deepStrictEqual(rows.map((x) => [x.chain_no, x.state]), [[3, "EXPIRED"]]);
      r.a.runPass(end3 + 10 * R);
      assert.deepStrictEqual(chains(r).map((x) => x.chain_no), [3], "the newest chain is never deleted");
      r.a.stop();
    });
    withStore(driver, (opened) => {
      const r = rig(opened, cfg(), { enqueue: () => ({ ok: true, inserted: 0, duplicates: 1 }) });
      r.emit(hackWin());
      r.a.runPass(T0);
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([st["chains.started"], st["mail.skipped"], st["mail.queued"], st.errors], [1, 1, 0, 0]);
      r.a.stop();
    });
  });
};

module.exports.harness = { T0, C1, C2, cfg, rig, hackWin, chains, items, loadDriver, withStore, MOD_DIR };
