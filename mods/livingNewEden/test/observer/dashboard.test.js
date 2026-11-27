"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { ASSET_FILES } = require("../../lib/observer");
const { SOURCE_IDS, buildFactionOverviewView } = require("../../lib/observer/views/factionOverview");
const { CALDARI, SOURCES, factionNames } = require("./fixtures/factionOverviewSources");

const WEB_DIR = path.resolve(__dirname, "..", "..", "web");
const SETTINGS = Object.freeze({ refreshMs: 15000, maxFactions: 32, maxNotes: 12, maxJobs: 16, maxStations: 16 });
const FORBIDDEN = ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function",
  "http://", "https://", "@import"];

function same(actual, expected, message) {
  assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);
}

function load(file, globalName) {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(WEB_DIR, file), "utf8"), sandbox, { filename: file });
  return sandbox.window[globalName];
}

function overview(dropIds, patch) {
  const drop = new Set(dropIds || []);
  const defs = new Map();
  for (const id of SOURCE_IDS) {
    if (drop.has(id)) continue;
    const fixture = patch && patch[id] ? () => patch[id](SOURCES[id]()) : SOURCES[id];
    defs.set(id, { id, title: id, getData: () => fixture(), cacheKey: () => `k-${id}` });
  }
  const now = 1793352069212;
  const view = buildFactionOverviewView({ views: { getView: (id) => defs.get(id) || null },
    clock: { now: () => now }, factionNames: factionNames(), getGovernor: () => null, telemetry: null,
    nowMs: () => 0, settings: SETTINGS });
  return { data: view.getData({ nowMs: now }), now };
}

function section(model, id) {
  const s = model.sections.find((x) => x.id === id);
  assert.ok(s, `section ${id}`);
  return s;
}

module.exports = ({ test }) => {
  test("FD1 static page: script order, no style=, assets routed, no HTML injection / remote sources", () => {
    const html = fs.readFileSync(path.join(WEB_DIR, "index.html"), "utf8");
    const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
    same(scripts, ["/systemCard.js", "/systemInterior.js", "/galaxy.js", "/tabs.js", "/factions.js", "/app.js"]);
    assert.ok(!/\sstyle\s*=/i.test(html), "no style attribute in index.html");
    const routes = ASSET_FILES.map((a) => a.route);
    for (const r of ["/systemCard.js", "/tabs.js", "/factions.js"]) assert.ok(routes.includes(r), `ASSET_FILES has ${r}`);
    for (const r of ["/settings.html", "/settings.js", "/settings.css"]) assert.ok(routes.includes(r), r);
    const panel = fs.readFileSync(path.join(WEB_DIR, "settings.html"), "utf8");
    same([...panel.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]), ["<script src=\"/settings.js\">"]);
    assert.ok(!/\sstyle\s*=/i.test(panel) && !/\son[a-z]+\s*=/i.test(panel), "no inline style or handler");
    const hits = [];
    for (const file of fs.readdirSync(WEB_DIR).filter((f) => /\.(js|css|html)$/.test(f)).sort()) {
      const text = fs.readFileSync(path.join(WEB_DIR, file), "utf8");
      for (const word of FORBIDDEN) if (text.includes(word)) hits.push(`${file}: ${word}`);
    }
    same(hits, []);
  });

  test("FD2 tabs: tabOf, viewsForTab order + other, viewsToFetch per tab, hash round trip and garbage", () => {
    const tabs = load("tabs.js", "LneTabs");
    const p = tabs._pure;
    same(tabs.TABS.map((t) => t.id), ["factions", "map", "economy", "war", "system", "other"]);
    assert.strictEqual(p.tabOf("trade"), "economy");
    assert.strictEqual(p.tabOf("galaxy"), "map");
    assert.strictEqual(p.tabOf("new-panel"), "other");
    const listed = ["telemetry", "new-b", "trade", "status", "control", "galaxy", "production", "activity",
      "faction-overview", "new-a"].map((id) => ({ id, title: id }));
    const ids = (rows) => rows.map((r) => r.id);
    same(ids(p.viewsForTab("economy", listed)), ["production", "trade"], "TABS order");
    same(ids(p.viewsForTab("factions", listed)), ["faction-overview", "activity"]);
    same(ids(p.viewsForTab("other", listed)), ["new-b", "new-a"], "unknown in server order");
    same(ids(p.viewsToFetch("map", listed)), ["status", "telemetry", "galaxy"]);
    same(ids(p.viewsToFetch("system", listed)), ["status", "telemetry"], "no duplicates");
    same(ids(p.viewsToFetch("map", listed.filter((v) => v.id !== "status"))),
      ["telemetry", "galaxy"], "only listed views");
    same(ids(p.viewsForTab("other", listed.filter((v) => !v.id.startsWith("new")))), [],
      "Other empty -> hidden");
    same(p.parseHash("#factions/500001"), { tab: "factions", factionId: 500001, systemId: null });
    for (const v of [{ tab: "factions", factionId: 500001, systemId: null },
      { tab: "map", factionId: null, systemId: null }, { tab: "factions", factionId: null, systemId: null },
      { tab: "other", factionId: null, systemId: null }, { tab: "map", factionId: null, systemId: 30000142 }]) {
      same(p.parseHash(p.formatHash(v)), v, JSON.stringify(v));
    }
    assert.strictEqual(p.formatHash({ tab: "map" }), "#map");
    assert.strictEqual(p.formatHash({ tab: "factions", factionId: 500001 }), "#factions/500001");
    same(p.parseHash("#map/30000142"), { tab: "map", factionId: null, systemId: 30000142 });
    assert.strictEqual(p.formatHash({ tab: "map", systemId: 30000142 }), "#map/30000142");
    same(["#map/abc", "#map/0", "#map/-1", "#map/1.5", "#map/30000142/x"].map((h) => p.parseHash(h)),
      Array(5).fill({ tab: "map", factionId: null, systemId: null }));
    const garbage = ["#x/abc", "#factions/-1", "", "#factions/abc", "#factions/1.5", "#factions/0", null];
    same(garbage.map((h) => p.parseHash(h)),
      garbage.map(() => ({ tab: "factions", factionId: null, systemId: null })));
  });

  test("FD3 factions formatting: fmtIsk bounds, sortFleets, hullsText, verdictClass", () => {
    const p = load("factions.js", "LneFactions")._pure;
    same([999, 1000, 4990112550000, -2500000, 0, null, undefined, 999999, 1e6, 1e9].map(p.fmtIsk),
      ["999 ISK", "1.00 k", "4.99 T", "−2.50 M", "0 ISK", "-", "-", "1.00 M", "1.00 M", "1.00 B"]);
    const sorted = p.sortFleets([
      { fleetId: "vf_1_1_a", state: "IDLE", ships: 50 },
      { fleetId: "vf_1_2_b", state: "ENGAGED", ships: 2 },
      { fleetId: "vf_1_3_c", state: "IDLE", ships: 60 },
      { fleetId: "vf_1_4_d", state: "STAGED", ships: 5 },
      { fleetId: "vf_1_0_e", state: "IDLE", ships: 60 },
    ]);
    same(sorted.map((f) => f.fleetId), ["vf_1_2_b", "vf_1_4_d", "vf_1_0_e", "vf_1_3_c", "vf_1_1_a"]);
    assert.strictEqual(p.hullsText([["cruiser", 40], ["frigate", 30]]), "cruiser ×40 · frigate ×30");
    assert.strictEqual(p.hullsText([]), "-");
    same(["WORKING", "WAITING", "BLOCKED", "STALE", "ERROR", "NOPE"].map(p.verdictClass),
      ["ok", "off", "warn", "warn", "error", "unknown"]);
  });

  test("FD4 contract a -> b: detailModel over the real faction-overview data; missing source text", () => {
    const p = load("factions.js", "LneFactions")._pure;
    const { data, now } = overview();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    const cal = data.factions[0];
    assert.strictEqual(cal.factionId, CALDARI);
    const model = p.detailModel(cal, data.sources, now);
    same(model.sections.map((s) => s.id),
      ["isk", "fleets", "operations", "production", "mining", "territory", "strategy"]);
    const rows = (blocks) => blocks.filter((b) => b.type === "kv").flatMap((b) => b.rows);
    const value = (id, label) => {
      const row = rows(section(model, id).blocks).find((r) => r[0] === label);
      assert.ok(row, `${id}: row ${label}`);
      return row[1];
    };
    assert.strictEqual(value("isk", "balance"), p.fmtIsk(cal.isk.treasury.balanceIsk));
    assert.strictEqual(value("isk", "available"), p.fmtIsk(9673139075));
    assert.strictEqual(value("isk", "contracts"), "9/25");
    assert.strictEqual(value("fleets", "hulls"), "cruiser ×40 · frigate ×30");
    assert.strictEqual(value("production", "lines"), "3/20");
    assert.strictEqual(value("territory", "controlled systems (LNE world)"), "7");
    assert.ok(!JSON.stringify(model).includes("no data"), "every source up");
    const list = p.listRows(data);
    same(list[0], { factionId: CALDARI, name: "Caldari State", role: "ai", roleBadge: null, verdictClass: "warn",
      verdictLabel: "BLOCKED", balance: "4.99 T", fleets: "26/104", systems: "7" });

    const noTrade = overview(["trade"]);
    const m2 = p.detailModel(noTrade.data.factions[0], noTrade.data.sources, noTrade.now);
    const isk = section(m2, "isk").blocks;
    const at = isk.findIndex((b) => b.type === "h" && b.text === "Trade budget");
    assert.ok(at >= 0, "trade budget heading");
    same(isk[at + 1], { type: "missing", text: "no data: trade (VIEW_MISSING)" });
    assert.ok(m2.footer.unavailable.includes("no data: trade (VIEW_MISSING)"));

    const zero = { ...cal, territory: { ...cal.territory, controlledSystems: null } };
    assert.strictEqual(p.listRows({ sources: data.sources, factions: [zero] })[0].systems, "0");
    const noControl = overview(["control"]);
    const m3 = p.detailModel(noControl.data.factions[0], noControl.data.sources, noControl.now);
    assert.strictEqual(rows(section(m3, "territory").blocks).find((r) => r[0] === "controlled systems (LNE world)")[1],
      "no data: control (VIEW_MISSING)");
  });

  test("FD-TR1: activity truces -> card.strategy.truces; the strategy "
    + "block shows `rozejm z <name>` only for the truce in force; truces null -> no row", () => {
    const p = load("factions.js", "LneFactions")._pure;
    const NOW = 1793352069212;
    const truces = { status: "ok", truncated: false, items: [
      { partnerId: 500010, partnerName: "Guristas Pirates", until: NOW + 3600000, initiator: 500010, eta: "1 h" },
      { partnerId: 500004, partnerName: "Ammatar Mandate", until: NOW, initiator: CALDARI, eta: "0 s" }] };
    const withTruces = (a) => ({ ...a, factions: a.factions.map((f) => (f.factionId === CALDARI ? { ...f, truces } : f)) });
    const { data, now } = overview([], { activity: withTruces });
    const cal = data.factions[0];
    same(cal.strategy.truces, { status: "ok", truncated: false, items: truces.items.map(({ eta: _e, ...t }) => t) });
    const strategyRows = (card) => section(p.detailModel(card, data.sources, now), "strategy").blocks
      .filter((b) => b.type === "kv").flatMap((b) => b.rows).map((r) => [r[0], r[1]]);
    const trRows = (card) => strategyRows(card).filter((r) => r[0].startsWith("truce"));
    same(trRows(cal), [["truce with Guristas Pirates", "ends in 1 h 0 min, asked by Guristas Pirates"]]);
    const own = { ...cal, strategy: { ...cal.strategy, truces: { ...cal.strategy.truces,
      items: [{ ...cal.strategy.truces.items[0], initiator: CALDARI }], truncated: true } } };
    same(strategyRows(own).filter((r) => r[0].startsWith("truce") || r[0].startsWith("+")),
      [["truce with Guristas Pirates", "ends in 1 h 0 min, asked by this faction"], ["+ more truces", "…"]]);
    const plain = overview().data.factions[0];
    assert.strictEqual(plain.strategy.truces, null);
    same(trRows(plain), []);
  });

  test("FD5 tabs: Factions -> Map -> Factions keeps the chosen faction", () => {
    const p = load("tabs.js", "LneTabs")._pure;
    let remembered = p.rememberFaction(null, p.parseHash("#factions/500003"));
    assert.strictEqual(remembered, 500003);
    const toMap = p.hashForTab("map", p.parseHash("#factions/500003"), remembered);
    same(toMap, { tab: "map", factionId: null });
    remembered = p.rememberFaction(remembered, p.parseHash(p.formatHash(toMap)));
    assert.strictEqual(remembered, 500003, "#map keeps the remembered id");
    const back = p.hashForTab("factions", p.parseHash("#map"), remembered);
    assert.strictEqual(p.formatHash(back), "#factions/500003");
    remembered = p.rememberFaction(remembered, p.parseHash("#factions/500001"));
    assert.strictEqual(remembered, 500001);
    same(p.hashForTab("factions", p.parseHash("#factions/500002"), remembered), { tab: "factions", factionId: 500002 });
    same(p.hashForTab("factions", p.parseHash("#map"), null), { tab: "factions", factionId: null });
    assert.strictEqual(p.rememberFaction(-4, p.parseHash("#x/abc")), null);
    same(p.hashForTab("economy", p.parseHash("#factions/500001"), 500001), { tab: "economy", factionId: null });
  });

  test("FD6 galaxy: no fit on the 1x1 canvas of a hidden pane", () => {
    const g = load("galaxy.js", "LneGalaxy")._pure;
    same([[1, 1], [1, 600], [800, 1], [0, 0], [NaN, 600], [2, 2], [800, 600]].map(([w, h]) => g.canFit(w, h)),
      [false, false, false, false, false, true, true]);
    const source = fs.readFileSync(path.join(WEB_DIR, "galaxy.js"), "utf8");
    const fitBody = /function fit\(\) \{([\s\S]*?)\n {4}\}/.exec(source);
    assert.ok(fitBody, "fit() found");
    const guard = fitBody[1].indexOf("canFit(ui.cssW, ui.cssH)");
    assert.ok(guard >= 0 && guard < fitBody[1].indexOf("ui.fitted = true"), "fit() returns before marking fitted");
  });

  test("FD7 factions: signed trade / per-period text, no stale card under available:false", () => {
    const p = load("factions.js", "LneFactions")._pure;
    same([5000, 0, -0, null, 0.2].map(p.fmtOutflow), ["−5.00 k", "0 ISK", "0 ISK", "-", "0 ISK"]);
    same([5000, 0, -2500000, null, 0.2].map(p.fmtSigned), ["+5.00 k", "0 ISK", "−2.50 M", "-", "0 ISK"]);
    same([-0.3, 0.3, -0].map(p.fmtSigned), [p.fmtSigned(0), p.fmtSigned(0), p.fmtSigned(0)]);
    assert.ok(p.fmtSigned(-5).startsWith("−"), p.fmtSigned(-5));
    assert.ok(p.fmtSigned(5).startsWith("+"), p.fmtSigned(5));
    assert.strictEqual(p.perPeriodText({ income: 1500, cost: 400, net: 1100 }), "+1.50 k −400 = +1.10 k");
    assert.strictEqual(p.perPeriodText({ income: 0, cost: -5, net: -5 }), "0 +5 = −5", "never −-5");
    assert.strictEqual(p.perPeriodText({ income: 10, cost: null, net: 10 }), "+10 - = +10");
    assert.strictEqual(p.perPeriodText(null), "-");
    const source = fs.readFileSync(path.join(WEB_DIR, "factions.js"), "utf8");
    const branch = /if \(d\.available === false\) \{([\s\S]*?)return;/.exec(source);
    assert.ok(branch && branch[1].includes("clear(listBox)") && branch[1].includes("clear(detailBox)"),
      "available:false clears the list and the card");
  });

  test("T5 system card: fmtEta bounds, statusText, stepperModel, list row, calm, percent; no thresholds in web/", () => {
    const p = load("systemCard.js", "LneSystemCard")._pure;
    const M = 60000;
    const H = 60 * M;
    same([59999, M, 7 * M, 58 * M, H, 47 * H, 48 * H, 72 * H, null].map(p.fmtEta),
      ["< 1 min", "~5 min", "~5 min", "~1 h", "~1 h", "~47 h", "~2 days", "~3 days", "-"]);
    same([0, 42000, 5 * M, 3 * H, 72 * H, -1].map(p.fmtAge), ["0 s", "42 s", "5 min", "3 h", "3 days", "-"]);
    same([0, 4, 640, 1000, 5000].map(p.percent), [0, 0, 64, 100, 100]);
    same([1, 2, 5, 12, 22].map((n) => p.plural(n, "one", "few", "many")),
      ["one", "few", "many", "many", "few"]);

    assert.strictEqual(p.statusText({ status: "ADVANCING", etaMs: 2 * H, blockers: [] }), "~2 h");
    assert.strictEqual(p.statusText({ status: "READY", etaMs: 0, blockers: [] }), "at the next evaluation");
    assert.strictEqual(p.statusText({ status: "COUNTDOWN", fallback: { to: "STABLE", etaMs: H }, blockers: [] }),
      "expires in ~1 h");
    const held = { status: "BLOCKED", blockers: ["NO_ATTACKER_FLEET", "OUT_OF_RANGE"], fallback: { to: "STABLE", etaMs: H } };
    assert.strictEqual(p.statusText(held), "no progress: no fleet");
    assert.strictEqual(p.fallbackText(held), "repelled in ~1 h");
    assert.strictEqual(p.statusText({ status: "REVERTING", blockers: ["FIELD_LOST"] }), "reverting: field lost");
    assert.strictEqual(p.statusText({ status: "REVERTING", blockers: [] }), "reverting");
    assert.strictEqual(p.fallbackText({ status: "ADVANCING" }), null);
    assert.strictEqual(p.statusText({ status: "BLOCKED", blockers: ["NOWY_KOD"] }), "no progress: NOWY_KOD", "raw code");
    assert.strictEqual(p.barLine({ state: "INVASION", ratio: 640, status: "ADVANCING", etaMs: 2 * H, blockers: [] }),
      "Invasion 64% · ~2 h");
    same(p.opRowModel({ state: "CONTESTED", ratio: 120, status: "BLOCKED", blockers: ["NO_ATTACKER_FLEET"] }),
      { phase: "Contested", right: "no progress", note: "no fleet" });
    same(p.opRowModel({ state: "INVASION", ratio: 640, status: "ADVANCING", etaMs: 2 * H, blockers: [] }),
      { phase: "Invasion", right: "~2 h", note: "64%" });

    same(p.stepperModel("INVASION", "ADVANCING").map((s) => s.cls),
      ["is-done", "is-done", "is-current", "is-todo", "is-todo", "is-todo"]);
    assert.strictEqual(p.stepperModel("OCCUPIED", "REVERTING")[3].cls, "is-current is-warn");
    assert.strictEqual(p.stepperModel("RECON", "BLOCKED")[0].cls, "is-current is-held");
    same(p.stepperModel("UNKNOWN", "ADVANCING").map((s) => s.cls), Array(6).fill("is-todo"));
    assert.strictEqual(p.markTitle({ code: "OCCUPY_MIN", score: 60 }), "Takeover threshold 60");
    assert.strictEqual(p.markLeft(30, 100), 30);

    const calm = { progress: null, system: { state: "STABLE", controller: 7 }, operations: { rows: [] }, sieges: [], invasions: [], battles: [],
      fleets: { groups: [{ factionId: 7, role: "garrison", fleets: 2 }] }, influence: [{ factionId: 7, garrison: 1240 }] };
    assert.strictEqual(p.isCalm(calm), true);
    assert.strictEqual(p.isCalm({ ...calm, battles: [{}] }), false);
    assert.strictEqual(p.isCalm({ ...calm, fleets: { groups: [{ factionId: 8 }] } }), false);
    assert.strictEqual(p.isCalm({ ...calm, progress: { status: "ADVANCING" } }), false);
    assert.strictEqual(p.isCalm({ ...calm, sieges: null, fleets: null }), true, "a module off is no conflict");
    const noProgress = { ...calm, system: { state: "INVASION", controller: 7 } };
    assert.strictEqual(p.isCalm(noProgress), false, "progress null in a conflict is not calm");
    assert.strictEqual(p.phaseFallbackText(noProgress), "Invasion · progress unavailable");
    assert.strictEqual(p.phaseFallbackText(calm), null);
    assert.strictEqual(p.phaseFallbackText({ ...noProgress, progress: { status: "ADVANCING" } }), null);
    assert.strictEqual(p.opsEmptyText(false), "Loading takeovers…");
    assert.strictEqual(p.opsEmptyText(true), "No takeovers in progress");
    assert.strictEqual(p.opsEmptyText(false, "X"), "Takeovers unavailable (X)");
    assert.strictEqual(p.opsEmptyText(true, "X"), "No takeovers in progress", "data shown wins");
    const timedPhase = { status: "BLOCKED", blockers: ["NO_CONSOLIDATION"] };
    assert.strictEqual(p.statusText(timedPhase, { attackerInvasion: { state: "ACTIVE", withdrawMs: 2 * H } }),
      "timed invasion · withdrawal in ~2 h");
    assert.strictEqual(p.statusText(timedPhase, { attackerInvasion: { state: "ACTIVE", withdrawMs: null } }),
      "timed invasion · no deadline");
    assert.strictEqual(p.statusText(timedPhase, { attackerInvasion: { state: "WITHDRAWING", withdrawMs: 0 } }),
      "timed invasion · withdrawing");
    assert.strictEqual(p.statusText(timedPhase, { attackerInvasion: null }), "no progress: faction not consolidating");
    assert.strictEqual(p.garrisonText(calm, String), "Garrison: 2 fleets · strength 1240");
    assert.strictEqual(p.garrisonText({ ...calm, fleets: null, influence: [] }, String), "Garrison: none");

    for (const file of ["systemCard.js", "galaxy.js"]) {
      const text = fs.readFileSync(path.join(WEB_DIR, file), "utf8");
      assert.ok(!/ScoreM|MinScore|MaxDefender|HoldMs|SettleMs|consolidateMs/.test(text), file);
      assert.ok(!/setAttribute\(\s*["']style/.test(text), `${file}: no style attribute`);
    }
  });

  test("T6 low-sweep system card stale line: the moment staleSinceMs (HH:MM:SS) like the banner, not an age", () => {
    const p = load("systemCard.js", "LneSystemCard")._pure;
    const g = load("galaxy.js", "LneGalaxy")._pure;
    const since = new Date(2026, 10, 3, 14, 5, 7).getTime();
    assert.strictEqual(p.staleText(since), "⚠ Data from 14:05:07 (last read, server under load)");
    assert.strictEqual(p.staleText(NaN), "⚠ Data from the last read (server under load)");
    assert.strictEqual(g.cardDataAtMs({ stale: true, staleSinceMs: since, staleAgeMs: 6000 }, 6000, since + 99000), since);
    assert.strictEqual(g.cardDataAtMs({ stale: true, staleAgeMs: 6000 }, 6000, since + 6000), since);
    assert.strictEqual(g.cardDataAtMs({}, 0, since), since);
  });

  test("FD8 listRows roles: hive -> no treasury, SDE-only Jove -> outside the AI, 500018 -> capsuleers", () => {
    const p = load("factions.js", "LneFactions")._pure;
    const rows = p.listRows({ sources: {}, factions: [
      { factionId: 500025, name: "Rogue Drones", role: "hive", isk: { treasury: { balanceIsk: 0 } } },
      { factionId: 500005, name: "Jove Empire", role: "sde-only", isk: { treasury: null } },
      { factionId: 500018, name: "Mordu's Legion", role: "capsuleers" },
      { factionId: 500001, name: "Caldari State", role: "ai", isk: { treasury: { balanceIsk: 999 } } },
    ] });
    assert.strictEqual(JSON.stringify(rows.map((r) => [r.factionId, r.balance, r.roleBadge])), JSON.stringify([
      [500025, "no treasury", null], [500005, "-", "outside AI"], [500018, "-", "capsuleers"], [500001, "999 ISK", null]]));
    const hive = p.detailModel({ factionId: 500025, role: "hive" }, { factions: { available: true } }, 0);
    assert.strictEqual(hive.sections[0].blocks[1].text, "no treasury (hive, by design)");
    assert.strictEqual(hive.header.rows[0][1], "hive (no treasury)");
  });
};
