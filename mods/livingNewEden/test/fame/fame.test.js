"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const R = require("../../lib/fame/rules");
const S = require("../../lib/fame/schema");
const { startFame, createUnavailableFame, FAME_METHODS } = require("../../lib/fame");
const { createJournal } = require("../../lib/persistence/journal");
const { createNoticeRepository } = require("../../lib/notices/repository");
const V = require("../../lib/npcVoices/data/voices");
const { FAME_CONTEXTS, CONTEXT_HINTS, PLACEHOLDERS, LINES } = require("../../lib/npcVoices/data/voiceLines");
const { voiceBucketEntries, fillVoiceTemplate } = require("../../lib/npcVoices/lines");
const { startNpcVoices } = require("../../lib/npcVoices");
const { filterTemplates } = require("../../lib/chatterAi/filter");
const { buildBucketSpecs } = require("../../lib/chatterAi/buckets");
const { loadDriver, withStore } = require("../notices/storeHelper");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const SYS = 30000142;
const C1 = 90000001;
const C2 = 90000002;
const CALDARI = 500001;
const GURISTAS = 500010;
const CREW = 91000001;
const ON = { EVEJS_LNE_FAME_ENABLED: "1", EVEJS_LNE_FAME_NOTICES_ENABLED: "1" };

const cache = new Map();
function cfg(env = {}) {
  const key = JSON.stringify(env);
  if (!cache.has(key)) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env }, settings: {},
      envFile: {} });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    cache.set(key, r.config);
  }
  return cache.get(key);
}

function fameRig(conf, o = {}) {
  const clock = o.clock || { t: T0, now() { return this.t; } };
  const standings = o.standings || new Map();
  const reads = [];
  const players = o.players || [{ characterId: C1, name: "Bob Pilot", state: "space" }];
  const r = startFame({ config: conf, clock, logger: { log() {} }, setTimer: () => ({ cancel() {}, hasRef: () => false }),
    persistence: o.persistence || { ok: true, store: o.store, journal: o.journal },
    readStanding: (cid, fid) => {
      reads.push([cid, fid]);
      if (o.readFails) throw new Error("boom");
      return { ok: true, found: true, standing: standings.get(`${cid}:${fid}`) || 0 };
    },
    readFactionNames: () => ({ ok: true, names: new Map([[CALDARI, "Caldari State"]]) }),
    getPresence: () => ({ listPresence: () => [{ systemId: SYS, characters: players }] }),
    getRegistry: () => ({ listActiveFactions: () => (o.factions || [CALDARI]).map((factionId) => ({ factionId })) }),
    getGovernor: () => (o.governor || null), getNotices: () => o.notices || null });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return { fame: r.fame, clock, standings, reads };
}

function fakeTimers() {
  const list = [];
  return {
    setTimer(fn, ms) {
      const t = { fn, ms, live: true };
      list.push(t);
      return { cancel: () => { t.live = false; }, hasRef: () => false };
    },
    fire() {
      const t = list.filter((x) => x.live).pop();
      assert.ok(t, "no armed timer");
      t.live = false;
      t.fn();
    },
  };
}

const VOICE_ENV = Object.freeze({ EVEJS_LNE_NPC_VOICES_ENABLED: "1", EVEJS_LNE_NPC_VOICES_LOCAL_ENABLED: "1",
  EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1", EVEJS_LNE_NPC_VOICES_LOCAL_MIN_GAP_MS: "10000",
  EVEJS_LNE_NPC_VOICES_LOCAL_MAX_GAP_MS: "10000", EVEJS_LNE_NPC_VOICES_LOCAL_TICK_MS: "1000",
  EVEJS_LNE_NPC_VOICES_LOCAL_MAX_LINES_PER_MINUTE: "60", EVEJS_LNE_NPC_VOICES_LOCAL_MAX_LINES_PER_SYSTEM_PER_HOUR: "120",
  EVEJS_LNE_NPC_VOICES_LOCAL_ADDRESS_PERMILLE: "1000", EVEJS_LNE_NPC_VOICES_LOCAL_ADDRESS_COOLDOWN_MS: "0",
  EVEJS_LNE_NPC_VOICES_LOCAL_RECENT_LINES_PER_SYSTEM: "0" });

function voiceRig(getFame) {
  const clock = { t: T0 };
  const timers = fakeTimers();
  const sends = [];
  const demands = [];
  const seam = { sendOccupantMessage(spec) {
    sends.push(spec);
    return { ok: true, sockets: 1 };
  } };
  const players = [{ characterId: C1, name: "Bob", state: "space" }];
  const presence = { getSystemPresence: (id) => (id === SYS ? { systemId: id, characters: players } : null) };
  const r = startNpcVoices({ config: cfg(VOICE_ENV), clock: { now: () => clock.t }, worldSeed: 42, telemetry: null,
    adapter: { localPilotsSeams: () => ({ ok: true, seam }) },
    getChatterAi: () => ({ demand: (k) => demands.push(k), overlay: () => ({ ok: false }) }),
    getPresence: () => presence, getGraph: () => null, logger: { log() {} }, setTimer: timers.setTimer,
    ...(getFame ? { getFame } : {}) });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  r.npcVoices.noteFactionCrews(new Map([[SYS, [{ characterId: CREW, factionId: GURISTAS }]]]), T0);
  const tick = (ms) => {
    clock.t += ms;
    timers.fire();
  };
  const until = (n, max = 200) => {
    for (let i = 0; i < max && sends.length < n; i += 1) tick(1000);
    assert.strictEqual(sends.length, n, `lines ${sends.length}`);
  };
  return { v: r.npcVoices, sends, demands, until, counters: () => r.npcVoices.getStatus().lanes.local.counters };
}

module.exports = ({ test, skip }) => {
  test("F1 fame rules: thresholds, hysteresis, null/NaN -> NONE, changeOf, effectiveHysteresis, bountyLevelOf", () => {
    const p = { legendMin: 3, enemyMax: -2, hysteresis: 0.25 };
    const rows = [
      [3, undefined, "LEGEND"], [2.99, undefined, "NONE"], [2.8, "LEGEND", "LEGEND"], [2.74, "LEGEND", "NONE"],
      [-2, undefined, "PUBLIC_ENEMY"], [-1.99, undefined, "NONE"], [-1.8, "PUBLIC_ENEMY", "PUBLIC_ENEMY"],
      [-1.7, "PUBLIC_ENEMY", "NONE"], [2.9, "PUBLIC_ENEMY", "NONE"], [-1.9, "LEGEND", "NONE"], [null, "LEGEND", "NONE"],
      [Number.NaN, "PUBLIC_ENEMY", "NONE"], [undefined, undefined, "NONE"], [10, "PUBLIC_ENEMY", "LEGEND"],
    ];
    for (const [s, prev, want] of rows) assert.strictEqual(R.tierOf(s, prev, p), want, `${s} ${prev}`);
    assert.deepStrictEqual([R.changeOf(undefined, "LEGEND"), R.changeOf("LEGEND", "NONE"), R.changeOf("NONE", "LEGEND"),
      R.changeOf("LEGEND", "PUBLIC_ENEMY"), R.changeOf("LEGEND", "LEGEND"), R.changeOf("PUBLIC_ENEMY", "NONE")]
      .map((x) => x.announce), [false, false, true, true, false, false]);
    assert.strictEqual(R.effectiveHysteresis(p), 0.25);
    assert.strictEqual(R.effectiveHysteresis({ legendMin: 1, enemyMax: -3, hysteresis: 2 }), 0.5, "W82 capped");
    assert.strictEqual(R.effectiveHysteresis({ legendMin: 4, enemyMax: -0.5, hysteresis: 2 }), 0.25);
    const b = { enemyMax: -2, bountyLevelBase: 2, bountyLevelStep: 1.5, bountyMaxLevel: 4 };
    assert.deepStrictEqual([-2, -3.5, -5, -10, 0].map((s) => R.bountyLevelOf(s, b)), [2, 3, 4, 4, 2]);
    const w = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...ON,
      EVEJS_LNE_FAME_HYSTERESIS: "2", EVEJS_LNE_FAME_LEGEND_MIN: "1" }, settings: {}, envFile: {} }).warnings;
    assert.ok(w.some((x) => x.startsWith("fame.hysteresis=2 ") && x.endsWith("capped at 0.5")), JSON.stringify(w));
    assert.ok(w.some((x) => x.startsWith("fame.noticesEnabled without notices.enabled")), "W84");
    const w67 = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_FAME_LOCAL_ENABLED: "1" }, settings: {}, envFile: {} }).warnings;
    assert.ok(w67.includes("fame.localEnabled without fame.enabled - no effect"), JSON.stringify(w67));
    assert.ok(!cfg().fame.enabled && !(config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() },
      settings: {}, envFile: {} }).warnings.some((x) => x.startsWith("fame."))));
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("F2 fame review on a real store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("F2 fame review on a real store: one announcement + FAME mail, duplicate in the period, restart = baseline, "
      + "refused mail keeps the journal row", () => withStore(driver, (opened) => {
      const clock = { t: T0, now() { return this.t; } };
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const noticeRepo = createNoticeRepository();
      const notices = { getStatus: () => ({ state: "running" }),
        enqueueItemsInTx: (tx, items, now) => noticeRepo.enqueueItemsInTx(tx, items, now) };
      const q = (sql) => opened.store.transaction("fame.test", (db) => db.prepare(sql).all()).value;
      const rows = () => q("SELECT idempotency_key AS k, aggregate_type AS t, event_type AS e FROM world_event_journal "
        + "WHERE idempotency_key LIKE 'fame:%' ORDER BY journal_id");
      const mails = () => q("SELECT * FROM world_notice_items WHERE kind = 'FAME' ORDER BY event_key");
      const conf = cfg(ON);
      const standings = new Map([[`${C1}:${CALDARI}`, 1]]);
      const a = fameRig(conf, { clock, standings, store: opened.store, journal, notices });
      assert.deepStrictEqual(a.fame.reviewNow(T0), { ok: true, players: 1, reads: 1, announced: 0 });
      standings.set(`${C1}:${CALDARI}`, 3.5);
      assert.strictEqual(a.fame.reviewNow(T0 + 1).announced, 1);
      const period = Math.floor((T0 + 1) / conf.fame.announcePeriodMs);
      const key = `fame:tier:${C1}:${CALDARI}:LEGEND:${period}`;
      assert.deepStrictEqual(rows(), [{ k: key, t: "player_fame", e: "FAME_TIER_CHANGED" }]);
      let m = mails();
      assert.strictEqual(m.length, 1);
      assert.deepStrictEqual([m[0].event_key, m[0].character_id, m[0].system_id], [key, C1, SYS]);
      assert.ok(m[0].line.startsWith("Caldari State now speaks of you as a legend") && !m[0].line.includes("Bob"),
        m[0].line);
      assert.deepStrictEqual(a.fame.tierOf(C1, CALDARI), { tier: "LEGEND", standing: 3.5 });
      standings.set(`${C1}:${CALDARI}`, 1);
      a.fame.reviewNow(T0 + 2);
      standings.set(`${C1}:${CALDARI}`, 3.5);
      assert.strictEqual(a.fame.reviewNow(T0 + 3).announced, 0);
      let st = a.fame.getStatus().counters;
      assert.deepStrictEqual([st.announced, st.announceDuplicate, st.noticesQueued, st.errors], [1, 1, 1, 0]);
      assert.strictEqual(rows().length, 1);
      a.fame.stop();
      const b = fameRig(conf, { clock, standings, store: opened.store, journal, notices });
      assert.strictEqual(b.fame.reviewNow(T0 + 4).announced, 0);
      assert.deepStrictEqual([rows().length, mails().length], [1, 1]);
      b.fame.stop();
      const refusing = { getStatus: () => ({ state: "running" }),
        enqueueItemsInTx: () => ({ ok: false, reason: "NOTICES_DISABLED" }) };
      standings.set(`${C2}:${CALDARI}`, -1);
      const c = fameRig(conf, { clock, standings, store: opened.store, journal, notices: refusing,
        players: [{ characterId: C2, name: "Eve", state: "space" }] });
      c.fame.reviewNow(T0 + 5);
      standings.set(`${C2}:${CALDARI}`, -2.5);
      assert.strictEqual(c.fame.reviewNow(T0 + 6).announced, 1);
      st = c.fame.getStatus().counters;
      assert.deepStrictEqual([st.announced, st.noticesFailed, st.noticesQueued], [1, 1, 0]);
      assert.deepStrictEqual(rows().map((x) => x.k), [key, `fame:tier:${C2}:${CALDARI}:PUBLIC_ENEMY:${period}`]);
      m = mails();
      assert.strictEqual(m.length, 1, "no mail of C2");
      c.fame.stop();
    }));
  }

  test("F3 fame budgets: 10 of 100 players per pass, the cursor wraps; failing read -> readFailed; governor -> "
    + "deferredGovernor; fame off -> disabled_by_config + stub", () => {
    const conf = cfg({ ...ON, EVEJS_LNE_FAME_REVIEW_MAX_PLAYERS: "10" });
    const players = Array.from({ length: 100 }, (_, i) => ({ characterId: C1 + i, name: `P${i}`, state: "space" }));
    const noStore = { transaction() {
      throw new Error("no write expected");
    } };
    const a = fameRig(conf, { players, store: noStore, journal: {} });
    const seen = [];
    for (let i = 0; i < 11; i += 1) {
      const r = a.fame.reviewNow(T0 + i);
      assert.deepStrictEqual([r.players, r.reads], [10, 10]);
      seen.push(a.reads.splice(0).map(([cid]) => cid));
    }
    assert.deepStrictEqual(seen[0], players.slice(0, 10).map((p) => p.characterId));
    assert.deepStrictEqual([...new Set(seen.slice(0, 10).flat())].length, 100, "every player once in 10 passes");
    assert.deepStrictEqual(seen[10], seen[0], "the cursor wraps");
    assert.strictEqual(a.fame.getStatus().pairs, 100);

    const f = fameRig(conf, { store: noStore, journal: {}, readFails: true });
    assert.strictEqual(f.fame.reviewNow(T0).announced, 0);
    assert.deepStrictEqual([f.fame.getStatus().counters.readFailed, f.fame.tierOf(C1, CALDARI).tier], [1, "NONE"]);
    const g = fameRig(conf, { store: noStore, journal: {}, governor: { admits: () => false } });
    assert.deepStrictEqual(g.fame.reviewNow(T0), { ok: false, reason: "DEFERRED_GOVERNOR" });
    assert.deepStrictEqual([g.reads.length, g.fame.getStatus().counters.deferredGovernor], [0, 1]);
    const n = fameRig(conf, { store: noStore, journal: {}, factions: [] });
    assert.deepStrictEqual(n.fame.reviewNow(T0), { ok: false, reason: "NO_REGISTRY" });

    assert.deepStrictEqual(startFame({ config: cfg(), clock: { now: () => T0 }, persistence: { ok: true,
      store: noStore, journal: {} }, readStanding: () => assert.fail("read") }), { ok: false, reason: "disabled_by_config" });
    const stub = createUnavailableFame("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub), [...FAME_METHODS]);
    assert.deepStrictEqual(Object.keys(a.fame), [...FAME_METHODS]);
    assert.deepStrictEqual([stub.tierOf(C1, CALDARI), stub.localPolicy(), stub.getStatus().state],
      [{ tier: "NONE", standing: null }, null, "off"]);
    for (const x of [a, f, g, n]) x.fame.stop();
    assert.deepStrictEqual(a.fame.reviewNow(T0), { ok: false, reason: "STOPPED" });
  });

  test("F4 Local recognition: LEGEND at the speaker's faction -> FAME_LEGEND with the nick; next slot in the cooldown "
    + "-> fameCooldown + ADDRESS; getFame null = the same 20 texts as without fame", () => {
    const pol = { permille: 1000, cooldownMs: 3600000, maxCandidates: 16, contextOf: S.LOCAL_CONTEXT_OF_TIER };
    const tiers = [];
    const fame = { localPolicy: () => pol, tierOf: (cid, fid) => {
      tiers.push([cid, fid]);
      return { tier: cid === C1 && fid === GURISTAS ? "LEGEND" : "NONE", standing: 5 };
    } };
    const r = voiceRig(() => fame);
    r.until(1);
    const legend = LINES.GURISTAS.FAME_LEGEND.map((l) => fillVoiceTemplate(l.text, { pilot: "Bob", system: null }))
      .filter(Boolean);
    assert.ok(legend.includes(r.sends[0].text), r.sends[0].text);
    assert.deepStrictEqual(r.demands, ["fv.GURISTAS.FAME_LEGEND"]);
    assert.deepStrictEqual(tiers, [[C1, GURISTAS]]);
    r.until(2);
    assert.strictEqual(r.demands[1], "fv.GURISTAS.ADDRESS", "Bob in the recognition cooldown");
    assert.ok(r.sends[1].text.includes("Bob"));
    const c = r.counters();
    assert.deepStrictEqual([c.fameLines, c.fameCooldown, c.fameNoCandidate, c.addressLines, c.lines], [1, 1, 1, 1, 2]);
    r.v.stop("test");

    const plain = voiceRig(null);
    const nulled = voiceRig(() => null);
    plain.until(20, 400);
    nulled.until(20, 400);
    assert.deepStrictEqual(nulled.sends.map((s) => s.text), plain.sends.map((s) => s.text), "bit for bit");
    assert.deepStrictEqual(nulled.demands, plain.demands);
    assert.strictEqual(nulled.counters().fameLines, 0);
    plain.v.stop("test");
    nulled.v.stop("test");
  });

  test("F5 fame data: FAME_* lines of 13 AI voices, 52 / 78 bucket entries, hints", () => {
    const F = { linesPerRequest: 100, minTemplateChars: 12, maxTemplateChars: 160, bannedWordList: [], language: "en",
      profanity: "full" };
    assert.strictEqual(V.AI_VOICES.length, 13);
    for (const voice of V.AI_VOICES) {
      for (const context of FAME_CONTEXTS) {
        const lines = LINES[voice][context];
        const where = `${voice}.${context}`;
        assert.ok(lines.length >= 3, where);
        for (const l of lines) {
          assert.ok(/^[\x20-\x7e]+$/.test(l.text), `${where} not ASCII: ${l.text}`);
          assert.ok(l.text.includes("{pilot}"), `${where} without {pilot}: ${l.text}`);
          for (const m of l.text.matchAll(/\{([A-Za-z]+)\}/g)) assert.ok(PLACEHOLDERS.includes(m[1]), `${where} ${m[0]}`);
        }
        const bucket = { key: `fv.${where}`, placeholders: PLACEHOLDERS, profanityCap: V.PROFANITY_CAPS[voice] };
        const f = filterTemplates(lines.map((l) => l.text).join("\n"), bucket, F, new Set());
        assert.strictEqual(f.accepted.length, lines.length, `${where} rejected ${JSON.stringify(f.rejected)}`);
      }
    }
    for (const context of FAME_CONTEXTS) {
      assert.ok(typeof CONTEXT_HINTS[context] === "string" && !/[0-9{]/.test(CONTEXT_HINTS[context]), context);
    }
    assert.strictEqual(voiceBucketEntries().length, 52);
    assert.strictEqual(voiceBucketEntries({ fame: false }).length, 52);
    const all = voiceBucketEntries({ fame: true });
    assert.strictEqual(all.length, 78);
    assert.deepStrictEqual(all.slice(0, 52).map((b) => b.key), voiceBucketEntries().map((b) => b.key));
    assert.ok(all.slice(52).every((b) => /^fv\.[A-Z_]+\.FAME_(LEGEND|ENEMY)$/.test(b.key)));
    const built = buildBucketSpecs({ civilian: null, resident: null, voice: all }, { promptExamples: 3 });
    assert.strictEqual(built.ok, true, JSON.stringify(built));
    assert.strictEqual(built.buckets.length, 78);
  });

  const composeFile = findCompose();
  if (!composeFile) {
    skip("FMC1 fame compose keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("FMC1 compose: every fame.* SCHEMA key has a ${NAME:-...} line, booleans default 0", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const rows = config.SCHEMA.filter((row) => row.key.startsWith("fame."));
      assert.strictEqual(rows.length, 44);
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
      assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
      const noDefault = rows.filter((row) => !text.includes(`\${${row.env}:-`)).map((row) => row.env);
      assert.deepStrictEqual(noDefault, [], `no \${NAME:-} line: ${noDefault.join(", ")}`);
      const wrong = rows.filter((row) => row.type === "boolean" && env[row.env] !== "0")
        .map((row) => `${row.env}=${env[row.env]}`);
      assert.deepStrictEqual(wrong, [], `flags without :-0: ${wrong.join(", ")}`);
    });
  }
};
