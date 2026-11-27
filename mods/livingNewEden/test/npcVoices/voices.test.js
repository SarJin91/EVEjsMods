"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const V = require("../../lib/npcVoices/data/voices");
const { CONTEXTS, PLACEHOLDERS, LINES } = require("../../lib/npcVoices/data/voiceLines");
const { ALPHABETS, EXTENDED_ALPHABETS } = require("../../lib/npcVoices/data/glyphs");
const { glyphLine, alphabetOf } = require("../../lib/npcVoices/glyphs");
const { voiceOf, fillVoiceTemplate, pickVoiceLine, voiceBucketEntries } = require("../../lib/npcVoices/lines");
const { startNpcVoices, createUnavailableNpcVoices } = require("../../lib/npcVoices");
const { filterTemplates } = require("../../lib/chatterAi/filter");
const { buildBucketSpecs } = require("../../lib/chatterAi/buckets");
const { createRegistry, REJECTED } = require("../../lib/telemetry/registry");
const { createRng } = require("../../lib/util/rng");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const LP = require("../localPilots/localPilots.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const SYS = 30000142;
const PLAYER = 90000001;
const CREW = 91000001;
const GURISTAS = 500010;
const FACADE_METHODS = ["noteFactionCrews", "getStatus", "stop"];

const EXPECTED = { 500010: "GURISTAS", 500011: "ANGEL", 500012: "BLOOD", 500019: "SANSHA", 500020: "SERPENTIS",
  500029: "DEATHLESS", 500003: "AMARR", 500007: "AMARR", 500008: "AMARR", 500001: "CALDARI", 500004: "GALLENTE",
  500002: "MINMATAR", 500006: "CONCORD", 500027: "CONCORD", 500026: "TRIGLAVIAN", 500024: "DRIFTER",
  500021: "SLEEPER", 500025: "ROGUE_DRONE" };

let configCache = null;
function configOf(env) {
  configCache = configCache || new Map();
  const key = JSON.stringify(env);
  if (!configCache.has(key)) {
    const r = resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
    assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
    configCache.set(key, r.config);
  }
  return configCache.get(key);
}

const ON_ENV = Object.freeze({ EVEJS_LNE_NPC_VOICES_ENABLED: "1", EVEJS_LNE_NPC_VOICES_LOCAL_ENABLED: "1",
  EVEJS_LNE_LOCAL_PILOTS_ENABLED: "1", EVEJS_LNE_NPC_VOICES_LOCAL_MIN_GAP_MS: "10000",
  EVEJS_LNE_NPC_VOICES_LOCAL_MAX_GAP_MS: "10000", EVEJS_LNE_NPC_VOICES_LOCAL_TICK_MS: "1000",
  EVEJS_LNE_NPC_VOICES_LOCAL_MAX_LINES_PER_MINUTE: "1", EVEJS_LNE_NPC_VOICES_LOCAL_MAX_LINES_PER_SYSTEM_PER_HOUR: "2",
  EVEJS_LNE_NPC_VOICES_LOCAL_ADDRESS_PERMILLE: "1000" });

function fakeTimers() {
  const list = [];
  return {
    setTimer(fn, ms) {
      const t = { fn, ms, live: true };
      list.push(t);
      return { cancel: () => { t.live = false; }, hasRef: () => false };
    },
    live: () => list.filter((t) => t.live),
    fire() {
      const t = list.filter((x) => x.live).pop();
      assert.ok(t, "no armed timer");
      t.live = false;
      t.fn();
    },
  };
}

function rig(config) {
  const clock = { t: T0 };
  const timers = fakeTimers();
  const registry = createRegistry({ histogramSamples: 16, maxMetrics: 64 });
  const sends = [];
  const demands = [];
  const seam = { refuse: null, sendOccupantMessage(spec) {
    sends.push(spec);
    return seam.refuse ? { ok: false, reason: seam.refuse } : { ok: true, sockets: 1 };
  } };
  const players = [{ characterId: PLAYER, name: "Bob", state: "space" }];
  const presence = { getSystemPresence: (id) => (id === SYS ? { systemId: id, characters: players } : null) };
  const chatterAi = { demand: (k) => demands.push(k), overlay: () => ({ ok: false, reason: "EMPTY" }) };
  const r = startNpcVoices({ config, clock: { now: () => clock.t }, worldSeed: 42, telemetry: registry,
    adapter: { localPilotsSeams: () => ({ ok: true, seam }) }, getChatterAi: () => chatterAi,
    getPresence: () => presence, getGraph: () => null, logger: { log() {} }, setTimer: timers.setTimer });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  const tick = (ms) => {
    clock.t += ms;
    timers.fire();
  };
  return { v: r.npcVoices, clock, timers, registry, sends, demands, seam, tick };
}

module.exports = ({ test }) => {
  test("FV2-1 data: every faction of factions.js has its voice, >= 3 ASCII lines per bucket passing the chatterAi "
    + "filter at the cap, only {system}/{pilot}, ADDRESS has {pilot}, caps, speakers, colours, 52 bucket specs", () => {
    for (const f of FACTIONS_V1) {
      assert.strictEqual(voiceOf(f.factionId), EXPECTED[f.factionId] || "INDEPENDENT", String(f.factionId));
    }
    assert.deepStrictEqual([voiceOf(500022), voiceOf(1), voiceOf("500010"), voiceOf(null)], [null, null, null, null]);
    assert.strictEqual(Object.keys(V.FACTION_VOICE).length, FACTIONS_V1.length, "nothing outside factions.js");
    assert.deepStrictEqual([V.AI_VOICES.length, V.GLYPH_VOICES.length], [13, 3]);
    assert.deepStrictEqual(V.PROFANITY_CAPS, { GURISTAS: "full", ANGEL: "full", BLOOD: "full", SANSHA: "full",
      SERPENTIS: "full", DEATHLESS: "full", TRIGLAVIAN: "mild", INDEPENDENT: "mild", AMARR: "off", CALDARI: "off",
      GALLENTE: "off", MINMATAR: "off", CONCORD: "off" });
    const S = { linesPerRequest: 100, minTemplateChars: 12, maxTemplateChars: 160, bannedWordList: [], language: "en",
      profanity: "full" };
    for (const voice of V.AI_VOICES) {
      assert.ok(typeof V.STYLES[voice] === "string" && V.STYLES[voice] !== "", voice);
      for (const context of CONTEXTS) {
        const lines = LINES[voice][context];
        const where = `${voice}.${context}`;
        assert.ok(lines.length >= 3, where);
        for (const l of lines) {
          assert.ok(/^[\x20-\x7e]+$/.test(l.text), `${where} not ASCII: ${l.text}`);
          for (const m of l.text.matchAll(/\{([A-Za-z]+)\}/g)) assert.ok(PLACEHOLDERS.includes(m[1]), `${where} ${m[0]}`);
        }
        const bucket = { key: `fv.${where}`, placeholders: PLACEHOLDERS, profanityCap: V.PROFANITY_CAPS[voice] };
        const f = filterTemplates(lines.map((l) => l.text).join("\n"), bucket, S, new Set());
        assert.strictEqual(f.accepted.length, lines.length, `${where} rejected ${JSON.stringify(f.rejected)}`);
      }
      assert.ok(LINES[voice].ADDRESS.some((l) => l.text.includes("{pilot}")), `${voice} ADDRESS without {pilot}`);
    }
    for (const voice of V.VOICES) {
      assert.ok(new Set(V.SPEAKERS[voice]).size >= 2, voice);
      assert.ok(/^0xff[0-9a-f]{6}$/.test(V.COLORS[voice]), voice);
    }
    const built = buildBucketSpecs({ civilian: null, resident: null, voice: voiceBucketEntries() },
      { promptExamples: 3 });
    assert.strictEqual(built.ok, true, JSON.stringify(built));
    assert.strictEqual(built.buckets.length, 52);
    assert.ok(built.buckets.every((b) => b.key.startsWith("fv.") && b.lane === "voice" && b.onDemand === true));
    const g = built.buckets.find((b) => b.key === "fv.GURISTAS.ADDRESS");
    assert.deepStrictEqual([g.profanityCap, g.style, g.placeholders], ["full", V.STYLES.GURISTAS, ["system", "pilot"]]);
  });

  test("FV2-2 glyphs: every code point of the default alphabets is safe (Latin-1 / machine ASCII), extended only on "
    + "request, glyphLine stays inside the word and length bounds", () => {
    const UNSAFE = /[<>&"'\p{Cc}\p{Cf}\p{Mn}\p{Me}\p{Cs}\p{Zl}\p{Zp}\p{Script=Hebrew}\p{Script=Arabic}]/u;
    const MACHINE = new Set("01:-.xABCDEF");
    for (const voice of V.GLYPH_VOICES) {
      const a = ALPHABETS[voice];
      assert.ok(a.length >= 8, voice);
      for (const ch of a) {
        const cp = ch.codePointAt(0);
        assert.strictEqual([...ch].length, 1, `${voice} one code point`);
        if (voice === "ROGUE_DRONE") assert.ok(MACHINE.has(ch), `${voice} U+${cp.toString(16)}`);
        else assert.ok(cp >= 0xa1 && cp <= 0xff && cp !== 0xad, `${voice} U+${cp.toString(16)}`);
        assert.ok(!UNSAFE.test(ch), `${voice} unsafe U+${cp.toString(16)}`);
      }
      for (const ch of EXTENDED_ALPHABETS[voice]) assert.ok(!UNSAFE.test(ch), `${voice} extended`);
      assert.strictEqual(alphabetOf(voice, false), a);
      assert.strictEqual(alphabetOf(voice, true), EXTENDED_ALPHABETS[voice]);
    }
    const shared = ALPHABETS.DRIFTER.filter((ch) => ALPHABETS.SLEEPER.includes(ch));
    assert.deepStrictEqual(shared, [], "DRIFTER and SLEEPER differ");
    assert.strictEqual(alphabetOf("GURISTAS", false), null);
    const G = { minWords: 2, maxWords: 6, minWordLen: 2, maxWordLen: 6 };
    const rng = createRng(1);
    for (let i = 0; i < 200; i += 1) {
      const words = glyphLine(rng, ALPHABETS.DRIFTER, G).split(" ");
      assert.ok(words.length >= 2 && words.length <= 6, String(words.length));
      for (const w of words) {
        const signs = [...w];
        assert.ok(signs.length >= 2 && signs.length <= 6 && signs.every((s) => ALPHABETS.DRIFTER.includes(s)), w);
      }
    }
    assert.strictEqual(glyphLine(rng, [], G), null);
    assert.strictEqual(glyphLine(rng, ALPHABETS.DRIFTER, { ...G, minWords: 7 }), null);
  });

  test("FV2-3 pickVoiceLine static / ai / glyph and fillVoiceTemplate (markup stripped, too long -> null)", () => {
    assert.strictEqual(fillVoiceTemplate("Hey {pilot}, nice ship.", { pilot: "A<b>&" }, 200), "Hey Ab, nice ship.");
    assert.strictEqual(fillVoiceTemplate("Hey {pilot}, nice ship.", { pilot: "Bob" }, 10), null, "too long");
    assert.strictEqual(fillVoiceTemplate("Hey {pilot}", { pilot: "<>" }, 200), null, "empty after strip");
    assert.strictEqual(fillVoiceTemplate("Quiet in {system}", {}, 200), null, "missing value");
    assert.strictEqual(fillVoiceTemplate("Quiet in {region}", { region: "X" }, 200), null, "outside the set");

    const base = { voice: "GURISTAS", context: "CHATTER", values: { system: "Jita" }, recentLineIds: [], ai: null,
      maxChars: 200 };
    const s = pickVoiceLine({ ...base, rng: createRng(5) });
    assert.deepStrictEqual([s.ok, s.source, s.bucketKey], [true, "static", "fv.GURISTAS.CHATTER"]);
    assert.ok(s.lineId.startsWith("fv.GURISTAS.CHATTER.") && !s.text.includes("{"), s.text);
    assert.deepStrictEqual(pickVoiceLine({ ...base, rng: createRng(5) }), s, "deterministic");
    const ids = LINES.GURISTAS.CHATTER.map((l) => l.id);
    const lru = pickVoiceLine({ ...base, rng: createRng(5), recentLineIds: ids });
    assert.strictEqual(lru.lineId, ids[0], "every line recent -> the one used longest ago");

    const asked = [];
    const ai = { permille: 1000, linesOf: (k) => {
      asked.push(k);
      return [{ id: "ai-fv.GURISTAS.ADDRESS-1", text: "Pay up, {pilot}, the Guristas are watching." }];
    } };
    const a = pickVoiceLine({ ...base, context: "ADDRESS", values: { system: "Jita", pilot: "Bob" }, ai,
      rng: createRng(5) });
    assert.deepStrictEqual([a.source, a.text, a.bucketKey, asked], ["ai", "Pay up, Bob, the Guristas are watching.",
      "fv.GURISTAS.ADDRESS", ["fv.GURISTAS.ADDRESS"]]);
    const unfit = pickVoiceLine({ ...base, rng: createRng(5),
      ai: { permille: 1000, linesOf: () => [{ id: "ai-x-2", text: "Nice {region} you have" }] } });
    assert.strictEqual(unfit.source, "static", "an AI template that does not fill -> the static line");

    const G = { minWords: 2, maxWords: 3, minWordLen: 2, maxWordLen: 3 };
    const glyph = pickVoiceLine({ voice: "DRIFTER", context: "ADDRESS", rng: createRng(5), maxChars: 200,
      ai: { permille: 1000, linesOf: () => { throw new Error("never asked"); } },
      glyphs: { rng: createRng(9), alphabet: alphabetOf("DRIFTER", false), settings: G } });
    assert.deepStrictEqual([glyph.ok, glyph.source, glyph.bucketKey], [true, "glyph", null]);
    assert.ok([...glyph.text.replace(/ /g, "")].every((ch) => ALPHABETS.DRIFTER.includes(ch)), glyph.text);
    assert.deepStrictEqual(pickVoiceLine({ ...base, voice: "FOO", rng: createRng(5) }),
      { ok: false, reason: "NO_VOICE" });
  });

  test("FV2-4 Local lane on a fake clock: ADDRESS with {pilot} from presence, minute and hour limits, NOT_OCCUPANT -> "
    + "sendFailed without retry, flags off -> no timer, no send, no metric", () => {
    const r = rig(configOf(ON_ENV));
    assert.strictEqual(r.v.getStatus().lanes.local.state, "running");
    r.v.noteFactionCrews(new Map([[SYS, [{ characterId: CREW, factionId: GURISTAS }]], [-1, [{}]]]), T0);
    for (let i = 0; i < 15 && r.sends.length === 0; i += 1) r.tick(1000);
    assert.strictEqual(r.sends.length, 1, "first line");
    const first = r.sends[0];
    assert.deepStrictEqual([first.systemId, first.characterId], [SYS, CREW]);
    assert.ok(first.text.includes("Bob") && !first.text.includes("{"), first.text);
    assert.deepStrictEqual(r.demands, ["fv.GURISTAS.ADDRESS"], "demand before the AI choice");
    r.tick(10000);
    assert.strictEqual(r.sends.length, 1, "minute limit (1 per minute)");
    r.tick(60000);
    assert.strictEqual(r.sends.length, 2, "after the minute");
    assert.ok(!r.sends[1].text.includes("Bob"), "Bob in addressCooldownMs -> CHATTER");
    assert.strictEqual(r.demands[1], "fv.GURISTAS.CHATTER");
    r.tick(10000);
    assert.strictEqual(r.sends.length, 2, "hour limit (2 per system and hour)");
    const c1 = r.v.getStatus().lanes.local.counters;
    assert.deepStrictEqual([c1.lines, c1.addressLines, c1.rateLimited, c1.sendFailed], [2, 1, 2, 0]);

    r.seam.refuse = "NOT_OCCUPANT";
    r.tick(3600000);
    assert.strictEqual(r.sends.length, 3, "one attempt");
    r.tick(1000);
    assert.strictEqual(r.sends.length, 3, "no retry");
    const c2 = r.v.getStatus().lanes.local.counters;
    assert.deepStrictEqual([c2.lines, c2.sendFailed], [2, 1]);
    assert.deepStrictEqual([r.registry.counter("npcVoices.localLines"), r.registry.counter("npcVoices.sendFailed"),
      r.registry.counter("npcVoices.rateLimited"), r.registry.counter(REJECTED)], [2, 1, 2, 0]);
    r.v.stop("test");
    assert.deepStrictEqual([r.v.getStatus().state, r.timers.live().length], ["stopped", 0]);

    for (const [env, state] of [[{}, null], [{ EVEJS_LNE_NPC_VOICES_ENABLED: "1" }, "off"],
      [{ ...ON_ENV, EVEJS_LNE_LOCAL_PILOTS_ENABLED: "0" }, "disabled_by_dependency"]]) {
      const off = rig(configOf(env));
      off.v.noteFactionCrews(new Map([[SYS, [{ characterId: CREW, factionId: GURISTAS }]]]), T0);
      assert.strictEqual(off.timers.live().length, 0, JSON.stringify(env));
      const st = off.v.getStatus();
      assert.strictEqual(state === null ? st.state : st.lanes.local.state, state === null ? "off" : state);
      assert.deepStrictEqual([off.sends.length, off.registry.counter("npcVoices.localLines")], [0, 0]);
    }
  });

  test("FV2-5 facades: method lists of the real ctx.npcVoices (running / off / unavailable); localPilots calls "
    + "noteFactionCrews only with the flags (crew of the pushed roster, empty map at stop); voice buckets to chatterAi "
    + "only with npcVoices.enabled", () => {
    const running = rig(configOf(ON_ENV)).v;
    const off = startNpcVoices({ config: configOf({}), clock: { now: () => T0 } }).npcVoices;
    for (const f of [running, off, createUnavailableNpcVoices("x")]) assert.deepStrictEqual(Object.keys(f), FACADE_METHODS);
    running.stop("test");

    const fleets = () => new Map([[30000142, [LP.fleet(LP.FACTION, null, 2)]]]);
    const voices = { calls: [], noteFactionCrews(m) { this.calls.push([...m]); }, getStatus: () => ({ state: "running" }),
      stop() {} };
    const on = LP.boot({ fleets: fleets(), npcVoices: voices, npcVoicesConfig: { enabled: true, local: { enabled: true } } });
    assert.deepStrictEqual(on.lp.runPassNow(), { ok: true });
    assert.deepStrictEqual(voices.calls, [[[30000142, [{ characterId: 91000001, factionId: LP.FACTION },
      { characterId: 91000002, factionId: LP.FACTION }]]]]);
    on.lp.stop("test");
    assert.deepStrictEqual(voices.calls[voices.calls.length - 1], [], "empty map at stop");
    for (const npcVoicesConfig of [undefined, { enabled: true, local: { enabled: false } }]) {
      const quiet = { calls: [], noteFactionCrews(m) { this.calls.push([...m]); }, getStatus: () => ({ state: "running" }) };
      const env = LP.boot({ fleets: fleets(), npcVoices: quiet, ...(npcVoicesConfig ? { npcVoicesConfig } : {}) });
      env.lp.runPassNow();
      env.lp.stop("test");
      assert.deepStrictEqual(quiet.calls, [], JSON.stringify(npcVoicesConfig));
    }

    let buckets = null;
    const defs = buildDefaultServiceDefs({ startChatterAi: (deps) => {
      buckets = deps.buckets;
      return { ok: true, chatterAi: { stop() {} } };
    } });
    const at = (name) => defs.findIndex((d) => d.name === name);
    assert.ok(at("npcVoices") >= 0 && at("npcVoices") < at("localPilots"), "npcVoices before localPilots");
    const ai = { EVEJS_LNE_CHATTER_AI_ENABLED: "1" };
    defs[at("chatterAi")].start({ config: configOf({ ...ai, EVEJS_LNE_NPC_VOICES_ENABLED: "1" }) }, { logger: { log() {} } });
    assert.strictEqual(buckets.length, 52);
    assert.ok(buckets.every((b) => b.key.startsWith("fv.")));
    defs[at("chatterAi")].start({ config: configOf(ai) }, { logger: { log() {} } });
    assert.deepStrictEqual(buckets, [], "npcVoices off -> the bucket set as before");
  });
};
