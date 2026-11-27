"use strict";

const assert = require("node:assert");
const fs = require("node:fs");

const config = require("../../config");
const NS = require("../../lib/nemesis");
const NR = require("../../lib/nemesis/repository");
const { returnLineOf } = require("../../lib/nemesis/data/ranks");
const { createJournal } = require("../../lib/persistence/journal");
const { createNoticeRepository } = require("../../lib/notices/repository");
const { loadDriver, withStoreAsync } = require("../notices/storeHelper");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const R = require("./returns.test").helpers;

const T0 = 1760000000000;
const FACTION = 500010;
const SYS = 4;
const PILOT = "Mara Voss";
const AI_LINE = "You ran this time, but my guns will find your ship soon.";
const tick = () => new Promise((resolve) => setImmediate(resolve));

const sql = (opened, text, ...args) => {
  const r = opened.store.transaction("nl.sql", (db) => db.prepare(text).all(...args).map((x) => ({ ...x })));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const exec = (opened, text, ...args) => {
  const r = opened.store.transaction("nl.exec", (db) => db.prepare(text).run(...args).changes);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const nemOf = (opened, id) => sql(opened, "SELECT * FROM world_nemesis WHERE nemesis_id = ?", id)[0];
const items = (opened) => sql(opened, "SELECT * FROM world_notice_items WHERE kind = 'NEMESIS' ORDER BY item_id");

function rig(opened, N, opts = {}) {
  const lines = [];
  const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
  const step = NS.createNemesisStep({ settings: N, store: opened.store, journal, worldSeed: 7,
    log: (l) => lines.push(l) });
  const repo = createNoticeRepository();
  const noticeState = { state: "running" };
  const notices = { getStatus: () => ({ ...noticeState }),
    enqueueItemsInTx: (tx, list, now) => repo.enqueueItemsInTx(tx, list, now) };
  const asks = [];
  const ai = { answer: null, complete(spec) {
    asks.push(spec);
    return ai.answer ? Promise.resolve(ai.answer(spec)) : new Promise(() => {});
  } };
  const ctx = { getNotices: () => notices, getChatterAi: () => (opts.noAi ? null : ai),
    pilotNameOf: () => PILOT, factionNameOf: () => "Guristas Pirates",
    memberOf: () => ({ member: true, corpName: "Red Gang" }), isWantedBusy: () => false,
    isSquadCommander: () => false };
  const create = (characterId, commanderId) => {
    const nemesisId = `nem:${characterId}:${commanderId}`;
    const r = opened.store.transaction("nl.nem", (tx) => NR.createNemesisInTx(tx, { nemesisId, characterId,
      commanderId, factionId: FACTION, gangId: 1, name: "Bo Hunter", baseLevel: 3, originRevengeId: "rev:old",
      originSystemId: SYS, seed: 11, profile: {}, history: [] }, T0 - 1000));
    assert.ok(r.ok && r.value.created, JSON.stringify(r));
    return nemesisId;
  };
  let revSeq = 0;
  const end = (nemesisId, now, action = "WON") => {
    revSeq += 1;
    const characterId = Number(nemesisId.split(":")[1]);
    const revengeId = `rev:${characterId}:t${revSeq}`;
    exec(opened, "UPDATE world_nemesis SET state = 'HUNTING', open_revenge_id = ? WHERE nemesis_id = ?", revengeId,
      nemesisId);
    const o = { revengeId, nemesisId, state: "DONE", reason: "TARGET_DOWN", engaged: true,
      bossKilled: action === "DEFEATED", characterId, systemId: SYS, killSystemId: SYS, quarryTypeId: null,
      quarryGroupId: null };
    const res = opened.store.transaction("nl.end", (tx) => step.onRevengeEndInTx(tx, { nemesisId }, o, now));
    assert.ok(res.ok && res.value.outcome === "encounter", JSON.stringify(res));
    step.onRevengeEndCommitted(res.value);
    return res.value.nemesis;
  };
  const read = (now) => {
    const r = opened.store.transaction("nl.read", (tx) => step.readInTx(tx, now, false));
    assert.ok(r.ok, JSON.stringify(r));
    step.load(r.value.rows, r.value.recovered, r.value.letters);
    return r.value;
  };
  return { step, ctx, ai, asks, lines, noticeState, create, end, read, counters: () => step.status().counters,
    pass: (now) => step.lettersStep(now, ctx) };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const N = (over = {}) => R.nemesisOn({ letterEnabled: true, ...over });
  if (!driver.ok) {
    skip("NL1-NL4 letters", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("NL1 WON -> letter_seq 1; no answer -> template after letterWaitMs; AI text framed with {pilot}; bad text "
      + "-> template", () => withStoreAsync(driver, async (o) => {
      const S = N();
      const r = rig(o, S);
      const a = r.create(90000101, 7101);
      r.end(a, T0);
      const row = nemOf(o, a);
      assert.deepStrictEqual([row.letter_seq, row.letter_sent_seq, row.letter_kind], [1, 0, "WON"]);
      assert.strictEqual(r.pass(T0).requested, true);
      assert.strictEqual(r.pass(T0 + 1000).sent, 0, "waits for the answer");
      assert.strictEqual(r.pass(T0 + S.letterWaitMs).sent, 1);
      const first = items(o);
      assert.strictEqual(first.length, 1);
      assert.deepStrictEqual([first[0].event_key, first[0].character_id, first[0].system_id, first[0].kind],
        [`nem:${a}:1`, 90000101, SYS, "NEMESIS"]);
      assert.ok(first[0].line.startsWith(`Bo Hunter, Captain of Red Gang, to ${PILOT}: `), first[0].line);
      assert.ok(/^[\x20-\x7E]+$/.test(first[0].line) && first[0].line.length <= S.letterMaxChars, first[0].line);
      assert.strictEqual(nemOf(o, a).letter_sent_seq, 1);
      r.ai.answer = () => ({ ok: true, line: AI_LINE });
      const b = r.create(90000102, 7102);
      r.end(b, T0 + 2000);
      r.pass(T0 + 2000);
      await tick();
      assert.strictEqual(r.pass(T0 + 3000).sent, 1);
      assert.strictEqual(items(o)[1].line, `Bo Hunter, Captain of Red Gang, to ${PILOT}: ${AI_LINE}`);
      const bad = ["Zginiesz tutaj, pilocie, moje działa cie znajda.", "{pilot} you will die here today, fool."];
      for (const [i, text] of bad.entries()) {
        r.ai.answer = () => ({ ok: true, line: text });
        const c = r.create(90000110 + i, 7110 + i);
        r.end(c, T0 + 4000);
        r.pass(T0 + 4000);
        await tick();
        assert.strictEqual(r.pass(T0 + 5000).sent, 1);
        const got = items(o).find((x) => x.event_key === `nem:${c}:1`);
        assert.ok(got && !got.line.includes(text.slice(0, 12)) && !got.line.includes("{"), got && got.line);
      }
      const c = r.counters();
      assert.deepStrictEqual([c.nemesisLetterQueued, c.nemesisLetterLlm, c.nemesisLetterTemplate], [4, 1, 3]);
      r.step.stop();
    }));

    test("NL2 second pass / replayed finalize -> one item, version kept; notices off -> seq moved; a newer event "
      + "wins", () => withStoreAsync(driver, async (o) => {
      const S = N();
      const r = rig(o, S, { noAi: true });
      const a = r.create(90000201, 7201);
      r.end(a, T0);
      const stale = r.read(T0);
      assert.strictEqual(stale.letters.length, 1);
      const before = nemOf(o, a);
      assert.strictEqual(r.pass(T0).sent, 1, "no AI -> the template at once");
      assert.strictEqual(r.pass(T0 + 1000).sent, 0);
      r.step.load(stale.rows, 0, stale.letters);
      assert.strictEqual(r.pass(T0 + 2000).sent, 0);
      const after = nemOf(o, a);
      assert.strictEqual(items(o).length, 1);
      assert.deepStrictEqual([after.letter_seq, after.letter_sent_seq, after.version, after.updated_at],
        [1, 1, before.version, before.updated_at]);
      const again = o.store.transaction("nl.dup", (tx) => createNoticeRepository().enqueueItemsInTx(tx, [{
        eventKey: `nem:${a}:1`, characterId: 90000201, kind: "NEMESIS", systemId: SYS, line: "x", eventAt: T0 }], T0));
      assert.deepStrictEqual([again.value.inserted, again.value.duplicates], [0, 1]);
      r.noticeState.state = "stopped";
      const b = r.create(90000202, 7202);
      r.end(b, T0 + 3000);
      r.pass(T0 + 3000);
      assert.deepStrictEqual([items(o).length, nemOf(o, b).letter_sent_seq, r.counters().nemesisLetterNoNotices],
        [1, 1, 1]);
      r.noticeState.state = "running";
      const ai = rig(o, S);
      const c = ai.create(90000203, 7203);
      ai.end(c, T0 + 4000);
      assert.strictEqual(ai.pass(T0 + 4000).requested, true);
      ai.end(c, T0 + 5000);
      assert.strictEqual(nemOf(o, c).letter_seq, 2);
      ai.pass(T0 + 4000 + S.letterWaitMs);
      assert.strictEqual(ai.asks.length, 2, "the newer seq asked again");
      ai.pass(T0 + 4000 + 2 * S.letterWaitMs);
      const keys = items(o).map((x) => x.event_key).filter((k) => k.startsWith(`nem:${c}:`));
      assert.deepStrictEqual(keys, [`nem:${c}:2`]);
      assert.strictEqual(nemOf(o, c).letter_sent_seq, 2);
      r.step.stop();
      ai.step.stop();
    }));

    test("NL3 letterMaxPerDay, letterMinGapMs, letterMaxAgeMs; prompt without pilot name / id; no text in the log",
      () => withStoreAsync(driver, async (o) => {
        const S = N({ letterMaxPerDay: 1 });
        const r = rig(o, S);
        r.ai.answer = () => ({ ok: true, line: AI_LINE });
        const CHAR = 90000301;
        const a = r.create(CHAR, 7301);
        r.end(a, T0);
        r.pass(T0);
        await tick();
        r.pass(T0 + 1000);
        const b = r.create(90000302, 7302);
        r.end(b, T0 + 2000);
        assert.strictEqual(r.pass(T0 + 2000).sent, 1, "cap -> template at once");
        assert.deepStrictEqual([r.asks.length, r.counters().nemesisLetterCapped, r.counters().nemesisLetterTemplate],
          [1, 1, 1]);
        const c = r.create(CHAR, 7303);
        r.end(c, T0 + 3000);
        r.pass(T0 + 3000);
        assert.deepStrictEqual([items(o).length, nemOf(o, c).letter_sent_seq, r.counters().nemesisLetterCapped],
          [2, 1, 2]);
        const d = r.create(90000304, 7304);
        r.end(d, T0 + 4000);
        r.pass(T0 + 4000 + S.letterMaxAgeMs + 1);
        assert.deepStrictEqual([items(o).length, r.counters().nemesisLetterStale], [2, 1]);
        const text = JSON.stringify(r.asks[0].messages);
        assert.ok(text.includes("Bo Hunter") && text.includes("Red Gang") && text.includes("Guristas Pirates"), text);
        for (const leak of [PILOT, "Mara", String(CHAR), a]) assert.ok(!text.includes(leak), `${leak} in ${text}`);
        assert.deepStrictEqual([r.asks[0].lane, r.asks[0].key], ["talk", "nemesis:WON"]);
        assert.ok(r.lines.every((l) => !l.includes(AI_LINE.slice(0, 12)) && !l.includes(PILOT)), r.lines.join(" | "));
        r.step.stop();
      }));

    test("NL4 flag off: no letter_seq, no request, no item, template return line; on: the AI return line once",
      () => withStoreAsync(driver, async (o) => {
        const off = rig(o, R.nemesisOn());
        const a = off.create(90000401, 7401);
        off.end(a, T0);
        off.pass(T0);
        off.pass(T0 + 120000);
        assert.deepStrictEqual([nemOf(o, a).letter_seq, off.asks.length, items(o).length], [0, 0, 0]);
        assert.deepStrictEqual(off.read(T0).letters, []);
        off.step.stop();
        const P = R.settings();
        const NOFF = R.nemesisOn();
        R.nemesisRow(o, NOFF);
        const plain = R.rig(o, P, { nemesis: NOFF, getChatterAi: () => ({ complete: () => {
          throw new Error("never asked");
        } }) });
        R.returnAndStart(plain, NOFF);
        assert.ok(plain.sent.includes(returnLineOf("Bo Hunter", "Blood Gang", 1)), plain.sent.join(" | "));
        plain.svc.stop();
      }).then(() => withStoreAsync(driver, async (o) => {
        const P = R.settings();
        const NON = N();
        R.nemesisRow(o, NON);
        const asks = [];
        const RET_LINE = "I am back, and this time I bring more guns for you.";
        const r = R.rig(o, P, { nemesis: NON, getChatterAi: () => ({ complete: (spec) => {
          asks.push(spec);
          return Promise.resolve({ ok: true, line: RET_LINE });
        } }) });
        const t1 = T0 + 1000;
        r.pass(t1);
        assert.deepStrictEqual([asks.length, asks[0] && asks[0].key], [1, "nemesis:RETURN"]);
        await tick();
        r.pass(t1 + 1000);
        r.pass(t1 + NON.returnLeadMs);
        assert.strictEqual(r.scene.of("spawnGroup").length, 1, r.lines.join(" | "));
        assert.ok(r.sent.includes(`Bo Hunter of Blood Gang: ${RET_LINE}`), r.sent.join(" | "));
        assert.strictEqual(r.counters().nemesisReturnLineLlm, 1);
        const row = R.returnRows(o)[0];
        const sq = r.step().squadOf({ nemesisId: row.nemesis_id, revengeId: row.revenge_id },
          { isWantedBusy: () => false, isSquadCommander: () => false,
            memberOf: () => ({ member: true, corpName: "Blood Gang" }) });
        assert.ok(sq === null || sq.line === returnLineOf("Bo Hunter", "Blood Gang", 1), sq && sq.line);
        assert.strictEqual(r.counters().nemesisReturnLineLlm, 1);
        r.svc.stop();
      })));
  }

  const composeFile = findCompose();
  if (!composeFile) {
    skip("NMC1 nemesis compose keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("NMC1 compose: every nemesis.* SCHEMA key has a ${NAME:-...} line, booleans default 0", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const rows = config.SCHEMA.filter((row) => row.key.startsWith("nemesis."));
      assert.ok(rows.length >= 30, `nemesis.* SCHEMA rows: ${rows.length}`);
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
      assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
      const noDefault = rows.filter((row) => !text.includes(`\${${row.env}:-`)).map((row) => row.env);
      assert.deepStrictEqual(noDefault, [], `no \${NAME:-} line: ${noDefault.join(", ")}`);
      const flags = rows.filter((row) => row.type === "boolean");
      assert.ok(flags.length >= 4, `nemesis.* boolean rows: ${flags.length}`);
      const wrong = flags.filter((row) => env[row.env] !== "0").map((row) => `${row.env}=${env[row.env]}`);
      assert.deepStrictEqual(wrong, [], `flags without :-0: ${wrong.join(", ")}`);
    });
  }
};
