"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { newsSettingsOf, KIND } = require("../../lib/news/schema");
const { KIND_DATA, PLACEHOLDERS } = require("../../lib/news/data/kinds");
const J = require("../../lib/news/collect/journalFacts");
const { createGameMasterService } = require("../../lib/gameMaster/service");
const { createGameMasterRepository } = require("../../lib/gameMaster/repository");
const { createUnavailableGameMaster, GAME_MASTER_METHODS } = require("../../lib/gameMaster");
const { createJournal } = require("../../lib/persistence/journal");
const { createNearby } = require("../../lib/jobBoard/nearby");
const { buildSnapshot } = require("../../lib/jobBoard/readModel");
const { toWireV1 } = require("../../lib/jobBoard/wire");
const { loadDriver, withStore } = require("../notices/storeHelper");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const H = 3600000;
const HOME = 30000142;
const NEAR = 30000144;
const FAR = 30002187;
const CHAR = 90000001;
const GM_KINDS = ["GM_THREAD_STARTED", "GM_THREAD_ENDED"];

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r;
}

module.exports = ({ test, skip }) => {
  test("G7 news facts of the Game Master journal (gms / gme, outcome null -> none), en / pl sentence, W90", () => {
    const newsOff = newsSettingsOf(configOf({ EVEJS_LNE_NEWS_ENABLED: "1" }).config);
    const on = configOf({ EVEJS_LNE_NEWS_ENABLED: "1", EVEJS_LNE_GAMEMASTER_ENABLED: "1" });
    const newsOn = newsSettingsOf(on.config);
    assert.ok(newsOff.ok && newsOn.ok);
    assert.deepStrictEqual(GM_KINDS.filter((k) => newsOff.settings.kinds.includes(k)), []);
    assert.deepStrictEqual(GM_KINDS.filter((k) => newsOn.settings.kinds.includes(k)), GM_KINDS);
    assert.ok(J.TAIL_AGGREGATE_TYPES.includes("gm_thread"));
    const e = (eventType, payload) => ({ journalId: 9, createdAt: 1000, aggregateType: "gm_thread",
      aggregateId: payload.threadId || "x", eventType, payload });
    const base = { threadId: "gmt:5", arc: "MUTINY", factionId: 500010, systemId: 30000002, source: "template" };
    const got = J.factsOfEntries([e("GM_THREAD_STARTED", base),
      e("GM_STEP_DONE", { ...base, stepNo: 0, stepKind: "NEWS", outcome: "NEUTRAL" }),
      e("GM_THREAD_ENDED", { ...base, outcome: "WON" }),
      e("GM_THREAD_ENDED", { ...base, threadId: "gmt:6", outcome: null }),
      e("GM_THREAD_STARTED", { threadId: "gmt:7", factionId: 500010 })], {
      kinds: newsOn.settings.kinds, refs: new Map(), factionName: () => "Guristas Pirates",
      place: () => ({ systemName: "Rakka", regionName: "Alpha Reach" }) });
    assert.deepStrictEqual(got.facts.map((f) => [f.factKey, f.kind, f.systemId, f.data.systemName, f.data.regionName,
      f.data.factionA, f.data.outcome]), [
      ["gms:gmt:5", "GM_THREAD_STARTED", 30000002, "Rakka", "Alpha Reach", "Guristas Pirates", null],
      ["gme:gmt:5", "GM_THREAD_ENDED", 30000002, "Rakka", "Alpha Reach", "Guristas Pirates", "WON"]]);
    assert.deepStrictEqual(got.skipped, { BAD_PAYLOAD: 1 });
    const offFacts = J.factsOfEntries([e("GM_THREAD_STARTED", base)], { kinds: newsOff.settings.kinds,
      refs: new Map() });
    assert.deepStrictEqual([offFacts.facts, offFacts.skipped], [[], { KIND_OFF: 1 }]);
    assert.deepStrictEqual(GM_KINDS.map((k) => KIND_DATA[KIND[k]].template), [
      { en: "{system} ({region}): unrest around {a}.", pl: "{system} ({region}): niepokój wokół {a}." },
      { en: "{system} ({region}): the unrest around {a} is over.",
        pl: "{system} ({region}): niepokój wokół {a} dobiegł końca." }]);
    for (const k of GM_KINDS) {
      for (const text of Object.values(KIND_DATA[k].template)) {
        for (const m of text.matchAll(/\{([a-z]+)\}/g)) assert.ok(PLACEHOLDERS.includes(m[1]), `${k} ${m[1]}`);
      }
    }
    const w90 = (r) => r.warnings.filter((w) => w.startsWith("gameMaster.enabled without news.enabled"));
    assert.strictEqual(w90(configOf({ EVEJS_LNE_GAMEMASTER_ENABLED: "1" })).length, 1);
    assert.deepStrictEqual([w90(on), w90(configOf({}))], [[], []]);
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("G8 game master board rows", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("G8 board: an ACTIVE thread -> near row src story ref gm: through readModel; boardEnabled false and the "
    + "disabled stub = GAME_MASTER_DISABLED (no refusal line)", () => withStore(driver, (opened) => {
    const journal = createJournal({ clock: { now: () => AT }, maxPayloadBytes: 4096, maxRows: 500 });
    const repo = createGameMasterRepository();
    const plan = (title) => ({ v: 1, arc: "MUTINY", source: "template", factionId: 500010, actorFactionId: null,
      systemId: FAR, regionId: 10000043, title, hook: "x", end: { won: "x", lost: "x" },
      steps: [{ kind: "NEWS", version: 1, params: {}, durationMs: 0 }, { kind: "SITE", version: 1,
        params: { site: "pirate_outpost", systemId: NEAR, hours: 6, label: "Mutineer Hideout" },
        durationMs: 6 * H }], textFallback: [] });
    const w = opened.store.transaction("g8.seed", (tx) => {
      for (const [id, cycleAt] of [["gmt:40", 40], ["gmt:41", 41]]) {
        const ins = repo.insertThreadInTx(tx, { threadId: id, cycleAt, arc: "MUTINY", source: "template",
          factionId: 500010, actorFactionId: null, anchorSystemId: FAR,
          planJson: JSON.stringify(plan("Mutiny in the Guristas fleet")), stepDueAt: AT, deadlineAt: AT + 48 * H,
          seed: 1, now: AT });
        assert.ok(ins.ok, JSON.stringify(ins));
      }
      return repo.updateThreadInTx(tx, { threadId: "gmt:40", version: 1, now: AT, patch: { stepNo: 1,
        stepState: "RUNNING", stepHandle: { siteKey: "lne:gm:gmt:40:1:0", systemId: NEAR, expiresAt: AT + 6 * H } } });
    });
    assert.ok(w.ok && w.value.changed, JSON.stringify(w));
    const svcOf = (over) => createGameMasterService({ store: opened.store, journal, worldSeed: 1,
      settings: F.settingsOf({ enabled: true, ...(over || {}) }), registry: F.registryWithBuiltins(F.settingsOf())
        .registry, sender: { sendInTx: () => ({ ok: true, n: 0 }) } });
    const svc = svcOf();
    const r = svc.listBoardRows({ systemIds: new Set([HOME, NEAR]), limit: 5, now: AT });
    assert.deepStrictEqual(r, { ok: true, truncated: false, rows: [{ ref: "gm:gmt:40", source: "story",
      kind: "MUTINY", title: "Mutiny in the Guristas fleet", systemId: NEAR, factionId: 500010, level: null,
      scan: false, rewardText: null, endsAt: AT + 6 * H, state: "SITE" }] });
    assert.deepStrictEqual(svc.listBoardRows({ systemIds: null, limit: 5 }).rows.map((x) => [x.ref, x.systemId,
      x.state]), [["gm:gmt:40", NEAR, "SITE"], ["gm:gmt:41", FAR, "NEWS"]]);

    const settings = configOf({ EVEJS_LNE_JOB_BOARD_ENABLED: "1" }).config.jobBoard;
    const ctx = { gameMaster: svc };
    const bumps = [];
    const nb = createNearby({ settings: { ...settings, frontEnabled: false, newsEnabled: false }, ctx,
      clock: { now: () => AT }, storeOf: () => null, bump: (n) => bumps.push(n) });
    const distances = new Map([[HOME, 0], [NEAR, 1]]);
    const names = { system: (id) => ({ [HOME]: "Jita", [NEAR]: "Perimeter" }[id] || null) };
    const wire = toWireV1(buildSnapshot({ now: AT, viewer: { characterId: CHAR, systemId: HOME },
      jobs: { ok: true, jobs: [] }, wars: { ok: true, rows: [] }, jumpsOf: (id) => distances.get(id) ?? null, names,
      limits: { maxJobRows: 5, maxWarRows: 5, maxNearRows: 10, newsMaxChars: 400 },
      nearby: nb.read({ systemId: HOME }, distances, AT, null) }), { pollMs: 0 });
    assert.deepStrictEqual(wire.near.map((x) => [x.ref, x.src, x.kind, x.title, x.sysName, x.jumps, x.endsIn,
      x.state]), [["gm:gmt:40", "story", "MUTINY", "Mutiny in the Guristas fleet", "Perimeter", 1, 6 * 3600, "SITE"]]);

    for (const facade of [svcOf({ boardEnabled: false }), createUnavailableGameMaster("GAME_MASTER_DISABLED")]) {
      ctx.gameMaster = facade;
      const quiet = nb.read({ systemId: HOME }, distances, AT, null);
      assert.deepStrictEqual([quiet.events.rows, quiet.events.refusals], [[], []]);
    }
    assert.deepStrictEqual(Object.keys(createUnavailableGameMaster("X")).sort(), [...GAME_MASTER_METHODS].sort());

    let inner = null;
    const outer = opened.store.transaction("g8b.outer", () => {
      inner = svc.listBoardRows({ systemIds: null, limit: 5 });
      return 1;
    });
    assert.deepStrictEqual(inner, { ok: false, reason: "TX_ACTIVE" });
    assert.strictEqual(outer.ok, true, JSON.stringify(outer));
    assert.ok(!("nestedAttempted" in outer), JSON.stringify(outer));
  }));
};
