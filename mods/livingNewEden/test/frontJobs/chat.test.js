"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { startFrontJobs } = require("../../lib/frontJobs");
const { formatBoardReply } = require("../../lib/frontJobs/format");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { boardDayOf } = require("../../lib/frontJobs/rules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DAY = 86400000;
const AT = Date.UTC(2026, 10, 7, 12, 0, 0);
const CALDARI = 500001;
const GURISTAS = 500010;
const S1 = 30000001;
const S2 = 30000002;
const FRONTS = [
  { systemId: S1, controllerFactionId: GURISTAS, occupierFactionId: CALDARI, previousControllerFactionId: null,
    occupationState: "INVASION" },
  { systemId: S2, controllerFactionId: CALDARI, occupierFactionId: null, previousControllerFactionId: GURISTAS,
    occupationState: "INVASION" }];

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FRONT_JOBS_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

const fakeWorld = () => ({ repository: { listActiveOccupations(_tx, opts) {
  const rows = FRONTS.filter((f) => f.systemId > opts.afterSystemId).slice(0, opts.limit);
  return { ok: true, systems: rows, nextAfterSystemId: null };
} } });

function fakePresence(ids) {
  const p = { stale: false, getStatus: () => ({ available: true, stale: p.stale }),
    listPresence: () => [{ systemId: S1, characters: ids.slice(0, 1).map((characterId) => ({ characterId })) },
      { systemId: S2, characters: ids.slice(1).map((characterId) => ({ characterId })) }] };
  return p;
}

function fakeAdapter() {
  const a = { installed: null, installs: 0, installChatCommand(opts) {
    a.installs += 1;
    a.installed = opts;
    return { ok: true };
  }, uninstallChatCommand(name) {
    if (a.installed && a.installed.name === name) a.installed = null;
    return { ok: true };
  } };
  return a;
}

function boot(opened, env, clock, extra = {}) {
  const notices = createNoticeRepository();
  const ctx = { persistence: { ok: true, store: opened.store, worldSeed: 4242 }, world: fakeWorld(),
    notices: { enqueueItemsInTx: (tx, items, now) => notices.enqueueItemsInTx(tx, items, now) }, ...extra.ctx };
  const started = startFrontJobs({ config: configOf(env), ctx, clock, adapter: extra.adapter || null,
    setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  return { fj: started.frontJobs, ctx };
}

const rows = (store, sql) => {
  const r = store.transaction("t", (db) => db.prepare(sql).all());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const itemsOf = (store) => rows(store, "SELECT event_key AS k, character_id AS c, kind, system_id AS s, line "
  + "FROM world_notice_items ORDER BY item_id");
const kill = (characterId, systemId, victimFactionId, atMs) => ({ characterId, victimFactionId, systemId, atMs,
  rewardable: true });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("JC2 !zlecenia: own progress, cut to chatMaxChars, empty = one line, limiter; chatEnabled=false", () => {
    const job = (slot, over) => ({ slot, description: `Kill 10 Guristas rats in Jita ${slot}`, iskAmount: 2000000,
      lpAmount: 500, targetCount: 10, state: "OPEN", myProgress: 0, myState: null, ...over });
    const opts = { maxChars: 900, lineBreak: "<br>", resetHourUtc: 11 };
    assert.strictEqual(formatBoardReply({ day: 1, jobs: [] }, opts), "LNE jobs: no front jobs today");
    const full = formatBoardReply({ day: boardDayOf(AT, 11), jobs: [job(0, { myProgress: 3 }),
      job(1, { lpAmount: 0, myProgress: 10, myState: "DONE" })] }, opts);
    assert.strictEqual(full, "LNE front jobs 2026-11-07 (UTC)"
      + "<br>#0 Kill 10 Guristas rats in Jita 0 - 2,000,000 ISK + 500 LP - 3/10 - OPEN"
      + "<br>#1 Kill 10 Guristas rats in Jita 1 - 2,000,000 ISK - 10/10 - DONE");
    const cut = formatBoardReply({ day: 1, jobs: [0, 1, 2, 3].map((s) => job(s)) }, { ...opts, maxChars: 200 });
    assert.ok(cut.length <= 200 && cut.endsWith("..."), cut);

    withStore(driver, (opened) => {
      const clock = { t: AT, now() { return this.t; } };
      const adapter = fakeAdapter();
      const { fj } = boot(opened, { EVEJS_LNE_FRONT_JOBS_KILL_TARGET: "3" }, clock, { adapter });
      try {
        assert.strictEqual(adapter.installed.name, "jobs");
        assert.ok(adapter.installed.match("!Zlecenia") && adapter.installed.match("!jobs now"));
        assert.ok(!adapter.installed.match("!jobsx") && !adapter.installed.match("!front"));
        fj.onNpcKill(kill(9001, S1, GURISTAS, AT + 1));
        const text = adapter.installed.handle({ characterId: 9001, systemId: S1 });
        assert.ok(/#\d Kill 3 \S+ rats in 30000001 for \S+ - 2,000,000 ISK[^<]* - 1\/3 - OPEN/.test(text), text);
        assert.ok(/ - 0\/3 - OPEN/.test(text), "the other job: 0 of the asking character");
        assert.ok(/^LNE jobs: wait \d+ s/.test(adapter.installed.handle({ characterId: 9001, systemId: S1 })));
        assert.deepStrictEqual([fj.getStatus().counters.chatReplies, fj.getStatus().counters.chatRateLimited,
          fj.getStatus().chat], [1, 1, "installed"]);
      } finally {
        fj.stop("test");
      }
      assert.strictEqual(adapter.installed, null, "stop unregisters the command");
      const off = fakeAdapter();
      const b = boot(opened, { EVEJS_LNE_FRONT_JOBS_CHAT_ENABLED: "0" }, clock, { adapter: off });
      b.fj.stop("test");
      assert.strictEqual(off.installs, 0, "chatEnabled=false: nothing registered");
    });
  });

  needsDriver("JC3 board mail: N online items in the board tx (max recipients); presence stale -> 0 + counter", () =>
    withStore(driver, (opened) => {
      const clock = { t: AT, now() { return this.t; } };
      const presence = fakePresence([9003, 9001, 9002]);
      const { fj } = boot(opened, { EVEJS_LNE_FRONT_JOBS_MAX_BOARD_MAIL_RECIPIENTS: "2" }, clock,
        { ctx: { presence } });
      try {
        const day = boardDayOf(AT, 11);
        const items = itemsOf(opened.store);
        assert.deepStrictEqual(items.map((i) => [i.k, i.c, i.kind, i.s]), [[`fjboard:${day}:${AT}`, 9001,
          "FRONT_JOBS_BOARD", 0], [`fjboard:${day}:${AT}`, 9002, "FRONT_JOBS_BOARD", 0]]);
        assert.ok(items[0].line.startsWith("New front job board 2026-11-07, type !jobs in local"), items[0].line);
        assert.ok(items[0].line.length <= 400);
        assert.strictEqual(fj.getStatus().counters.boardMails, 2);
        presence.stale = true;
        clock.t = AT + DAY;
        fj.runPass(clock.t);
        const day2 = boardDayOf(clock.t, 11);
        assert.strictEqual(rows(opened.store, `SELECT count(*) AS n FROM world_front_jobs WHERE day = ${day2}`)[0].n, 2);
        assert.strictEqual(itemsOf(opened.store).length, 2);
        assert.strictEqual(fj.getStatus().counters.boardMailSkipped, 1);
      } finally {
        fj.stop("test");
      }
    }));

  needsDriver("JC4 DONE -> FRONT_JOB_DONE item with eventKey = payout_key; notices stub -> DONE and payout anyway",
    () => withStore(driver, (opened) => {
      const clock = { t: AT, now() { return this.t; } };
      const { fj } = boot(opened, { EVEJS_LNE_FRONT_JOBS_KILL_TARGET: "1" }, clock);
      try {
        const r = fj.onNpcKill(kill(9001, S1, GURISTAS, AT + 5));
        assert.strictEqual(r.outcome, "COMPLETED");
        const key = r.results[0].payoutKey;
        const done = itemsOf(opened.store).filter((i) => i.kind === "FRONT_JOB_DONE");
        assert.deepStrictEqual(done.map((i) => [i.k, i.c, i.s]), [[key, 9001, S1]]);
        assert.ok(/^Front job done: Kill 1 .* Reward 2,000,000 ISK \+ 500 LP, standing \+0\.005 \(paid shortly\)\.$/
          .test(done[0].line), done[0].line);
        assert.strictEqual(fj.getStatus().counters.doneMails, 1);
      } finally {
        fj.stop("test");
      }
      const stub = boot(opened, {}, clock, { ctx: { notices: { enqueueItemsInTx: () => ({ ok: false,
        reason: "NOTICES_DISABLED" }) } } });
      try {
        const s = stub.fj;
        assert.strictEqual(s.onNpcKill(kill(9002, S2, CALDARI, AT + 6)).outcome, "COMPLETED");
        const pay = rows(opened.store, "SELECT state FROM world_front_job_payouts WHERE character_id = 9002");
        assert.deepStrictEqual(pay.map((p) => p.state), ["PENDING"]);
        assert.strictEqual(itemsOf(opened.store).filter((i) => i.c === 9002).length, 0);
        assert.strictEqual(s.getStatus().counters.noticeRefused, 1);
      } finally {
        stub.fj.stop("test");
      }
    }));
};
