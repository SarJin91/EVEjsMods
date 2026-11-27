"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { sightingLineOf, noticeKindOf, recipientsOf, corpSystemsOf } = require("../../lib/listeningPosts/rules");
const { createSightingRepository } = require("../../lib/listeningPosts/repository");
const { createUnavailableListeningPosts, FACADE_METHODS } = require("../../lib/listeningPosts");
const LS = require("../../lib/listeningPosts/schema");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { createUnavailableNotices } = require("../../lib/notices");
const config = require("../../config");
const { harness: H } = require("../battle/settlement.test");
const { harness: C } = require("../battle/contacts.test");
const { harness: L } = require("./listeningPost.test");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const S = H.S;
const MOD_DIR = path.resolve(__dirname, "..", "..");
const CORP_A = 98000001;
const CORP_B = 98000002;
const HOUR = 3600000;
const AT = Date.UTC(2026, 10, 19, 14, 32, 10);

function fakeAdapter(members) {
  const calls = [];
  const playerStructures = { listOwnerMemberIds: (corpId, opts) => {
    calls.push([corpId, opts.max]);
    const ids = members[corpId];
    return ids ? { ok: true, characterIds: ids, truncated: false } : { ok: false, reason: "SEAM_UNAVAILABLE" };
  } };
  return { calls, adapter: { playerStructures, readFactionNames: () => ({ ok: true,
    names: new Map([[C.SANSHA, "Sansha's Nation"]]) }) } };
}

function runningNotices() {
  const repo = createNoticeRepository();
  return { getStatus: () => ({ state: "running" }), enqueueItemsInTx: (tx, items, now) => repo.enqueueItemsInTx(tx, items, now) };
}

const items = (env) => env.q("SELECT event_key, character_id, kind, system_id, line, event_at FROM world_notice_items "
  + "ORDER BY event_key, character_id");
const firstOf = (env, fleetId) => L.rowsOf(env).find((r) => r.payload.fleetId === fleetId && r.payload.check === 0);

module.exports = ({ test, skip }) => {
  test("LPM1 rules: sightingLineOf movements / names / ASCII / length, noticeKindOf, recipientsOf, corpSystemsOf", () => {
    const names = { systems: new Map([[1, "Tama"], [2, "Nourvukaiken"], [3, "Kedama"], [4, "Jüffa"]]),
      factions: new Map([[500003, "Amarr Empire"]]) };
    const s = { systemId: 1, factionId: 500003, fleetRole: "invasion", sizeClass: "large", fromSystemId: 2,
      toSystemId: 3, seenAt: AT };
    assert.strictEqual(sightingLineOf(s, names), "Listening post Tama: Amarr Empire invasion fleet (large) passed from "
      + "Nourvukaiken to Kedama at 2026-11-19 14:32 EVE.");
    assert.ok(sightingLineOf({ ...s, fromSystemId: null }, names).includes(" departed towards Kedama at "));
    assert.ok(sightingLineOf({ ...s, toSystemId: null }, names).includes(" arrived from Nourvukaiken at "));
    assert.ok(sightingLineOf({ ...s, fromSystemId: null, toSystemId: null }, names).includes(" ended its route here at "));
    assert.ok(sightingLineOf({ ...s, factionId: 500001, toSystemId: 9 }, names)
      .startsWith("Listening post Tama: ? invasion fleet (large) passed from Nourvukaiken to ? at "));
    assert.ok(sightingLineOf({ ...s, systemId: 4 }, names).startsWith("Listening post J?ffa: "));
    const long = { systems: new Map([[1, "x".repeat(500)], [2, "y".repeat(500)], [3, "z".repeat(500)]]),
      factions: new Map([[500003, "é".repeat(500)]]) };
    const line = sightingLineOf({ ...s, fleetRole: "r".repeat(300) }, long);
    assert.ok(line.length <= 400 && /^[\x20-\x7e]+$/.test(line), line);
    assert.deepStrictEqual([noticeKindOf(s), noticeKindOf({ sizeClass: "large", fleetRole: "patrol" }),
      noticeKindOf({ sizeClass: "medium", fleetRole: "patrol" })],
    [LS.NOTICE_KIND_LARGE, LS.NOTICE_KIND_LARGE, LS.NOTICE_KIND]);
    const members = { 7: { ok: true, characterIds: [3, 1] }, 8: { ok: false }, 9: { ok: true, characterIds: [1, 5] } };
    assert.deepStrictEqual(recipientsOf([7, 8, 9], (c) => members[c], 4), { characterIds: [1, 3, 5], refused: 1, corps: 3 });
    assert.deepStrictEqual(recipientsOf([7, 8, 9], (c) => members[c], 1), { characterIds: [1, 3], refused: 0, corps: 1 });
    assert.deepStrictEqual(recipientsOf([7], () => {
      throw new Error("boom");
    }, 4), { characterIds: [], refused: 1, corps: 1 });
    assert.deepStrictEqual([...corpSystemsOf(new Map([[30, [7]], [10, [7, 8]], [20, [8]]]))], [[7, [10, 30]], [8, [10, 20]]]);
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("LPM2-LPM4 listening post reports on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  const posts = [{ itemId: 71, systemId: S.N5, ownerCorpId: CORP_A }, { itemId: 72, systemId: S.N5, ownerCorpId: CORP_B }];

  test("LPM2 mail: one line per character of both corporations, replay = duplicates, member memo per pass, refusal",
    () => {
      const env = C.createEnv(driver);
      try {
        const members = { [CORP_A]: [1, 2], [CORP_B]: [2, 3] };
        const fa = fakeAdapter(members);
        const lp = L.boot(env, L.cfgOf(env, { mailEnabled: true }), L.fakeSentries(posts, new Set([71, 72])),
          { adapter: fa.adapter, getNotices: runningNotices, getGraph: () => ({ getGraph: () => ({ ok: true,
            graph: env.graph }) }) });
        assert.ok(lp.started.ok, JSON.stringify(lp.started));
        const run = (row, now) => lp.handlers[LS.EVENT_TYPE].fn(L.evOf(row), { now });
        const a = L.mover(env, "ma", [{ hullGroup: "cruiser", count: 10 }]);
        const rowA = firstOf(env, a.fleetId);
        const now = rowA.payload.enterAt;
        const res = run(rowA, now);
        assert.strictEqual(res.outcome, "SIGHTED");
        assert.strictEqual(L.settle(env, res).committed, true);
        const key = LS.noticeKey(S.N5, a.fleetId, a.plan.legSeq);
        const got = items(env);
        assert.deepStrictEqual(got.map((i) => [i.event_key, i.character_id, i.kind, i.system_id, i.event_at]),
          [1, 2, 3].map((c) => [key, c, LS.NOTICE_KIND_LARGE, S.N5, rowA.payload.enterAt]));
        assert.ok(got[0].line.startsWith(`Listening post S${S.N5}: Sansha's Nation invasion fleet (medium) passed from `
          + `S${S.N0} to S${S.N6} at `), got[0].line);
        assert.deepStrictEqual(fa.calls, [[CORP_A, 10], [CORP_B, 10]]);
        assert.deepStrictEqual(L.settle(env, res).v.noticed, 0);
        assert.strictEqual(items(env).length, 3);
        const b = L.mover(env, "mb", [{ hullGroup: "cruiser", count: 10 }]);
        assert.strictEqual(L.settle(env, run(firstOf(env, b.fleetId), now)).committed, true);
        assert.strictEqual(fa.calls.length, 2, "memo per pass");
        assert.strictEqual(items(env).length, 6);
        members[CORP_B] = null;
        const c = L.mover(env, "mc", [{ hullGroup: "cruiser", count: 10 }]);
        assert.strictEqual(L.settle(env, run(firstOf(env, c.fleetId), now + 1)).committed, true);
        assert.deepStrictEqual(items(env).filter((i) => i.event_key === LS.noticeKey(S.N5, c.fleetId, c.plan.legSeq))
          .map((i) => i.character_id), [1, 2]);
        assert.strictEqual(env.n("SELECT COUNT(*) AS n FROM world_post_sightings WHERE fleet_id = ?", c.fleetId), 1);
        const st = lp.facade.getStatus().counters;
        assert.deepStrictEqual([st.noticesQueued, st.recipientsUnavailable, st.noticesOff, st.noticesRefused],
          [8, 1, 0, 0]);
        lp.facade.stop();
      } finally {
        env.close();
      }
    });

  test("LPM3 notices off: no line, noticesOff, no member read; mailEnabled off = no member read; W151", () => {
    const env = C.createEnv(driver);
    try {
      const fa = fakeAdapter({ [CORP_A]: [1], [CORP_B]: [2] });
      const sentries = L.fakeSentries(posts, new Set([71, 72]));
      const off = createUnavailableNotices("NOTICES_DISABLED", "disabled_by_config");
      const lp = L.boot(env, L.cfgOf(env, { mailEnabled: true }), sentries, { adapter: fa.adapter,
        getNotices: () => off });
      assert.ok(lp.started.ok, JSON.stringify(lp.started));
      const a = L.mover(env, "na", [{ hullGroup: "frigate", count: 3 }]);
      const rowA = firstOf(env, a.fleetId);
      const res = lp.handlers[LS.EVENT_TYPE].fn(L.evOf(rowA), { now: rowA.payload.enterAt });
      assert.strictEqual(L.settle(env, res).committed, true);
      assert.deepStrictEqual([items(env).length, fa.calls.length, lp.facade.getStatus().counters.noticesOff,
        env.n("SELECT COUNT(*) AS n FROM world_post_sightings")], [0, 0, 1, 1]);
      lp.facade.stop();
      const lp2 = L.boot(env, L.cfgOf(env), sentries, { adapter: fa.adapter, getNotices: runningNotices });
      assert.ok(lp2.started.ok, JSON.stringify(lp2.started));
      const b = L.mover(env, "nb", [{ hullGroup: "frigate", count: 3 }]);
      const rowB = firstOf(env, b.fleetId);
      assert.strictEqual(L.settle(env, lp2.handlers[LS.EVENT_TYPE].fn(L.evOf(rowB), { now: rowB.payload.enterAt }))
        .committed, true);
      assert.deepStrictEqual([items(env).length, fa.calls.length, lp2.facade.getStatus().counters.noticesOff], [0, 0, 0]);
      lp2.facade.stop();
      const W151 = "listeningPost.mailEnabled without notices.enabled - no listening post mail is sent";
      const resolved = (env2) => config.resolveConfig({ modDir: MOD_DIR, env: env2 }).warnings;
      assert.ok(resolved({ EVEJS_LNE_LISTENING_POST_ENABLED: "1", EVEJS_LNE_LISTENING_POST_MAIL_ENABLED: "1" })
        .includes(W151));
      assert.ok(!resolved({ EVEJS_LNE_LISTENING_POST_ENABLED: "1", EVEJS_LNE_LISTENING_POST_MAIL_ENABLED: "1",
        EVEJS_LNE_NOTICES_ENABLED: "1" }).includes(W151));
    } finally {
      env.close();
    }
  });

  test("LPM4 markersFor: own systems only, window, aggregate, truncated, filter, INVALID_INPUT, OFF, FACADE_METHODS",
    () => {
      const env = C.createEnv(driver);
      try {
        const repo = createSightingRepository();
        const now = env.clock.now();
        const add = (systemId, fleetId, sizeClass, seenAt) => assert.ok(env.store.transaction("t.add", (db) =>
          repo.insertInTx(db, { systemId, fleetId, legSeq: 0, systemIndex: 1, factionId: C.SANSHA, fleetRole: "patrol",
            sizeClass, fromSystemId: null, toSystemId: null, seenAt }, seenAt)).value.ok);
        add(S.N5, "x1", "medium", now - 1000);
        add(S.N5, "x2", "medium", now - 500);
        add(S.N5, "x3", "small", now - 100);
        add(S.N5, "old", "medium", now - 2 * HOUR);
        add(S.N7, "y1", "large", now - 200);
        const sentries = L.fakeSentries([{ itemId: 71, systemId: S.N5, ownerCorpId: CORP_A },
          { itemId: 72, systemId: S.N7, ownerCorpId: CORP_B }], new Set([71, 72]));
        const lp = L.boot(env, L.cfgOf(env), sentries);
        assert.ok(lp.started.ok, JSON.stringify(lp.started));
        const m = (q) => lp.facade.markersFor(q);
        assert.deepStrictEqual(m({ corpId: CORP_A, now }), { ok: true, truncated: false, markers: [
          { systemId: S.N5, factionId: C.SANSHA, sizeClass: "small", count: 1, lastSeenAt: now - 100 },
          { systemId: S.N5, factionId: C.SANSHA, sizeClass: "medium", count: 2, lastSeenAt: now - 500 }] });
        assert.deepStrictEqual(m({ corpId: CORP_B, now }).markers.map((x) => [x.systemId, x.sizeClass]),
          [[S.N7, "large"]], "B does not see the sightings of A");
        assert.deepStrictEqual(m({ corpId: CORP_A, systemIds: [S.N7], now }), { ok: true, markers: [], truncated: false });
        assert.deepStrictEqual(m({ corpId: 0, now }), { ok: false, reason: "INVALID_INPUT", detail: "corpId" });
        assert.strictEqual(m({ corpId: CORP_A, systemIds: "x", now }).reason, "INVALID_INPUT");
        assert.deepStrictEqual([lp.facade.getStatus().counters.markersServed,
          lp.facade.getStatus().counters.markersRefused], [3, 2]);
        lp.facade.stop();
        assert.deepStrictEqual(m({ corpId: CORP_A, now }), { ok: false, reason: "LISTENING_POST_OFF" });
        const small = L.boot(env, L.cfgOf(env, { mapMaxMarkers: 1 }), sentries);
        const t = small.facade.markersFor({ corpId: CORP_A, now });
        assert.deepStrictEqual([t.markers.length, t.markers[0].sizeClass, t.truncated], [1, "small", true]);
        small.facade.stop();
        const stub = createUnavailableListeningPosts("LISTENING_POST_DISABLED", "disabled_by_config");
        assert.deepStrictEqual(stub.markersFor({ corpId: CORP_A, now }), { ok: false, reason: "LISTENING_POST_OFF" });
        assert.deepStrictEqual([Object.keys(stub).sort(), Object.keys(lp.facade).sort()],
          [[...FACADE_METHODS].sort(), [...FACADE_METHODS].sort()]);
      } finally {
        env.close();
      }
    });

  const composeFile = findCompose();
  if (!composeFile) {
    skip("LPC1 listening post compose keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("LPC1 compose: every listeningPost.* SCHEMA key has a ${NAME:-...} line, booleans default 0", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const rows = config.SCHEMA.filter((row) => row.key.startsWith("listeningPost."));
      assert.ok(rows.length >= 19, `listeningPost.* SCHEMA rows: ${rows.length}`);
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
      assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
      const noDefault = rows.filter((row) => !text.includes(`\${${row.env}:-`)).map((row) => row.env);
      assert.deepStrictEqual(noDefault, [], `no \${NAME:-} line: ${noDefault.join(", ")}`);
      const flags = rows.filter((row) => row.type === "boolean");
      assert.ok(flags.length >= 2, `listeningPost.* boolean rows: ${flags.length}`);
      const wrong = flags.filter((row) => env[row.env] !== "0").map((row) => `${row.env}=${env[row.env]}`);
      assert.deepStrictEqual(wrong, [], `flags without :-0: ${wrong.join(", ")}`);
    });
  }
};
