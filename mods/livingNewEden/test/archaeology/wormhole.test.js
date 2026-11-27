"use strict";

const assert = require("node:assert");

const { harness: H } = require("./service.test");
const { lineGraph, regionOf, fakeSites, fakePresence } = require("./fixture");
const { bfsOf, pickWormholeStage } = require("../../lib/archaeology/places");

const ARCHIVE = "container:lne_archive";
const HOUR = 3600000;
const J1 = 31000100;
const winOf = (characterId, outcomeId) => ({ ok: true, state: "active",
  wins: [{ contentKey: ARCHIVE, characterId, outcomeId, atMs: 1 }] });
const eventOf = (c) => `${c.chain_id}:s${c.stage_no}:r${c.stage_spawn_no}`;

function whGraph() {
  const g = lineGraph();
  return { ...g, hasSystem: (id) => g.getSystem(id) !== null };
}

module.exports = ({ test, skip }) => {
  test("A11a archaeology wormhole pick: only the valid k-J pair, the latest end of a duplicate, deterministic; "
    + "bfsOf without withJumps has no jumpsOf", () => {
    const graph = whGraph();
    const now = 1000 * HOUR;
    const bfs = bfsOf(graph, { fromSystemId: 100, minJumps: 6, maxJumps: 20, maxBfsNodes: 4000,
      excludedRegionIds: [99], withJumps: true });
    assert.deepStrictEqual([bfs.jumpsOf.get(100), bfs.jumpsOf.get(110), bfs.jumpsOf.get(120)], [0, 10, 20]);
    const plain = bfsOf(graph, { fromSystemId: 100, minJumps: 6, maxJumps: 20, maxBfsNodes: 4000, excludedRegionIds: [99] });
    assert.deepStrictEqual(Object.keys(plain), ["byRegion", "nodes", "truncated"]);
    const p = (from, to, extra = {}) => ({ pairKey: `${from}-${to}`, fromSystemId: from, toSystemId: to, active: true,
      expiresAt: now + 10 * HOUR, ...extra });
    const pairs = [p(107, 108), p(31000001, 31000002), p(109, 30000999), p(108, 31000006, { expiresAt: now + HOUR }),
      p(103, 31000007), p(111, 31000008), p(109, 31000009, { active: false }), p(110, 31000005),
      p(31000005, 110, { expiresAt: 0 })];
    const input = { jumpsOf: bfs.jumpsOf, minJumps: 6, now, whMinRemainingMs: 4 * HOUR, excludedRegionIds: [99],
      seed: 7, stageNo: 2 };
    const pick = pickWormholeStage(graph, pairs, input);
    assert.deepStrictEqual(pick, { ok: true, kind: "WH", systemId: 31000005, entrySystemId: 110, regionId: 30,
      pairExpiresAt: 0, regionReused: false });
    assert.deepStrictEqual(pickWormholeStage(graph, [...pairs].reverse(), input), pick, "deterministic");
    assert.deepStrictEqual(pickWormholeStage(graph, pairs.slice(0, 7), input), { ok: false, reason: "NO_WH" });
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("A11 archaeology wormhole pump", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  function toFound(r, P, presence, wins, chars) {
    for (const characterId of chars) r.emit(H.hackWin({ characterId }));
    let t = H.T0;
    r.a.runPass(t);
    for (const c of H.chains(r)) presence.where.set(c.character_id, c.stage_system_id);
    t += P.presenceCheckMs;
    r.a.runPass(t);
    for (const c of H.chains(r)) {
      assert.strictEqual(c.stage_state, "SITE_PENDING");
      wins.set(`lne:${eventOf(c)}:0`, winOf(c.character_id, `o-${c.character_id}`));
      r.emit(H.hackWin({ own: true, lneEventId: eventOf(c) }));
    }
    r.a.runPass(t + 1);
    assert.ok(H.chains(r).every((c) => c.stage_state === "FOUND"));
    return t + 1;
  }
  const THREE = { EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MIN: "3", EVEJS_LNE_ARCHAEOLOGY_STAGE_COUNT_MAX: "3" };
  const WH_ON = { ...THREE, EVEJS_LNE_ARCHAEOLOGY_WORMHOLE_STAGES_ENABLED: "1",
    EVEJS_LNE_ARCHAEOLOGY_WORMHOLE_PERMILLE: "1000" };

  test("A11 archaeology wormhole pump: off -> no pair read; on -> WH stage 2 (entry, due = pair end), SPAWN without "
    + "presence; FAILED -> one replacement from the entry (:w1); refused pairs -> normal stage, 2 chains = 1 read",
  () => {
    H.withStore(driver, (opened) => {
      const conf = H.cfg(THREE);
      const presence = fakePresence();
      const wins = new Map();
      let reads = 0;
      const r = H.rig(opened, conf, { presence, wins, sites: fakeSites(), getGraph: () => whGraph(),
        readWormholePairs: () => {
          reads += 1;
          return { ok: true, pairs: [], vendorDisabled: false };
        } });
      const t = toFound(r, conf.archaeology, presence, wins, [H.C1]);
      r.a.runPass(t + 1);
      assert.deepStrictEqual([H.chains(r)[0].stage_no, reads], [2, 0]);
      r.a.stop();
    });

    H.withStore(driver, (opened) => {
      const conf = H.cfg(WH_ON);
      const P = conf.archaeology;
      const presence = fakePresence();
      const sites = fakeSites();
      const wins = new Map();
      const state = { pairs: [] };
      let reads = 0;
      const r = H.rig(opened, conf, { presence, wins, sites, getGraph: () => whGraph(),
        readWormholePairs: () => {
          reads += 1;
          return { ok: true, pairs: state.pairs, vendorDisabled: false };
        } });
      const t = toFound(r, P, presence, wins, [H.C1]);
      const s1 = H.chains(r)[0].stage_system_id;
      const entry = s1 + 6;
      const pairEnd = t + 1 + 10 * HOUR;
      state.pairs = [{ pairKey: "p1", fromSystemId: entry, toSystemId: J1, active: true, expiresAt: pairEnd }];
      presence.where.clear();
      r.a.runPass(t + 1);
      let c = H.chains(r)[0];
      assert.deepStrictEqual([c.stage_no, c.stage_kind, c.stage_system_id, c.stage_entry_system_id, c.stage_region_id,
        c.stage_due_at, c.stage_state], [2, "WH", J1, entry, regionOf(entry), Math.min(pairEnd, t + 1 + P.whStageMs),
        "REVEALED"]);
      const hint = r.q(`SELECT line FROM world_notice_items WHERE event_key = 'arch:hint:${c.chain_id}:2'`)[0].line;
      assert.ok(hint.includes(`through a wormhole in Sys-${entry}`), hint);
      r.a.runPass(t + 2);
      c = H.chains(r)[0];
      const req = sites.calls.create.at(-1);
      assert.deepStrictEqual([c.stage_state, req.systemId, req.expiresAt, c.stage_due_at], ["SITE_PENDING", J1, pairEnd,
        pairEnd]);
      const old = eventOf(c);
      sites.setState(old, "FAILED", "SYSTEM_UNKNOWN");
      r.a.runPass(t + 2 + P.sitePollMs);
      c = H.chains(r)[0];
      assert.deepStrictEqual([c.state, c.stage_no, c.stage_state, c.stage_spawn_no, c.stage_entry_system_id,
        c.stage_due_at], ["ACTIVE", 2, "REVEALED", 1, null, null]);
      assert.ok(c.stage_kind === "NULL" || c.stage_kind === "HOSTILE_NULL", c.stage_kind);
      const jumps = Math.abs(c.stage_system_id - entry);
      assert.ok(jumps >= P.minJumps && jumps <= P.maxJumps, `jumps from the entry ${jumps}`);
      assert.deepStrictEqual(sites.calls.cleanup.at(-1), [old, "EVENT_END"]);
      const keys = r.q("SELECT event_key FROM world_notice_items").map((x) => x.event_key);
      assert.ok(keys.includes(`arch:hint:${c.chain_id}:2:w1`), keys.join(","));
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([st["stages.wh"], st["stages.whReplaced"], st["stages.whFallback"], st.errors, reads],
        [1, 1, 0, 0, 1]);
      r.a.stop();
    });

    H.withStore(driver, (opened) => {
      const conf = H.cfg(WH_ON);
      const presence = fakePresence();
      const wins = new Map();
      let reads = 0;
      const r = H.rig(opened, conf, { presence, wins, sites: fakeSites(), getGraph: () => whGraph(),
        readWormholePairs: () => {
          reads += 1;
          return { ok: false, reason: "WORMHOLE_STATE_TOO_LARGE" };
        } });
      const t = toFound(r, conf.archaeology, presence, wins, [H.C1, H.C2]);
      r.a.runPass(t + 1);
      const rows = H.chains(r);
      assert.deepStrictEqual(rows.map((c) => [c.stage_no, c.stage_kind === "WH", c.stage_entry_system_id]),
        [[2, false, null], [2, false, null]]);
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([reads, st["stages.whFallback"], st["stages.wh"]], [1, 2, 0]);
      assert.strictEqual(r.logger.lines.filter((l) => l.includes("wormhole stages fall back")).length, 1);
      r.a.stop();
    });
  });

  test("A14 archaeology: a WH stage SITE_ACTIVE whose instance is missing -> RESPAWN = one "
    + "replacement with stages.lostWin 1 and whReplaced 1; loreOf with full lines as usedTexts -> another fragment",
  () => {
    const { loreOf, loreLine } = require("../../lib/archaeology/hints");
    const spec = { theme: "JOVE", language: "en", seed: 11, stageNo: 2 };
    const first = loreOf(spec);
    const full = loreLine({ language: "en", theme: "JOVE", stageNo: 1, stageCount: 3, lore: first });
    assert.notStrictEqual(full, first);
    const second = loreOf({ ...spec, usedTexts: [full] });
    assert.ok(typeof second === "string" && second !== first, `${first} | ${second}`);
    assert.strictEqual(loreOf({ ...spec, usedTexts: ["unrelated line: other text"] }), first, "no collision = same");

    H.withStore(driver, (opened) => {
      const conf = H.cfg(WH_ON);
      const P = conf.archaeology;
      const presence = fakePresence();
      const sites = fakeSites();
      const wins = new Map();
      const state = { pairs: [] };
      const r = H.rig(opened, conf, { presence, wins, sites, getGraph: () => whGraph(),
        readWormholePairs: () => ({ ok: true, pairs: state.pairs, vendorDisabled: false }) });
      const t = toFound(r, P, presence, wins, [H.C1]);
      const entry = H.chains(r)[0].stage_system_id + 6;
      state.pairs = [{ pairKey: "p1", fromSystemId: entry, toSystemId: J1, active: true, expiresAt: t + 10 * HOUR }];
      r.a.runPass(t + 1);
      r.a.runPass(t + 2);
      let c = H.chains(r)[0];
      assert.deepStrictEqual([c.stage_kind, c.stage_state], ["WH", "SITE_PENDING"]);
      const ev = eventOf(c);
      sites.setState(ev, "ACTIVE");
      r.a.runPass(t + 2 + P.sitePollMs);
      assert.strictEqual(H.chains(r)[0].stage_state, "SITE_ACTIVE");
      wins.set(`lne:${ev}:0`, { ok: true, state: "missing", wins: [] });
      r.a.runPass(t + 2 + 2 * P.sitePollMs);
      c = H.chains(r)[0];
      assert.deepStrictEqual([c.state, c.stage_state, c.stage_spawn_no, c.stage_kind === "WH"],
        ["ACTIVE", "REVEALED", 1, false]);
      const st = r.a.getStatus().counters;
      assert.deepStrictEqual([st["stages.lostWin"], st["stages.whReplaced"], st.errors], [1, 1, 0]);
      r.a.stop();
    });
  });
};
