"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const UNIVERSE = "services/dungeon/dungeonUniverseRuntime.js";
const RUNTIME = "services/dungeon/dungeonRuntime.js";
const MISSIONS = "services/agent/agentMissionRuntime.js";
const SOV_CONST = "SOV_GUARANTEED_SITE_ORIGIN";
const FILTER_ALLOWED = Object.freeze(["\"universe_dungeon\"", "\"generatedmining\"", SOV_CONST]);

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.slice(start + 1).search(/\n(async )?function /);
  return source.slice(start, next < 0 ? source.length : start + 1 + next);
}

function filterLists(source) {
  return [...source.matchAll(/siteOriginFilter: \[([^\]]*)\]/g)]
    .map((m) => m[1].split(",").map((s) => s.trim()).filter((s) => s !== ""));
}

function modOrigin() {
  const text = fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "dungeonSites.js"), "utf8");
  const m = /\nconst SITE_ORIGIN = "([^"]+)";/.exec(text);
  assert.ok(m, "SITE_ORIGIN literal in lib/adapter/dungeonSites.js");
  return m[1];
}

module.exports = ({ test, skip }) => {
  if (!fs.existsSync(SERVER_SRC)) {
    skip("SOF1-5 site origin vendor facts", "server/src not found");
    return;
  }

  test("SOF1 vendor: resetStartupOrphanedUniverseSites resets only universe_dungeon and sov_hub", () => {
    const source = readSource(UNIVERSE);
    assert.match(source, /\nconst SOV_GUARANTEED_SITE_ORIGIN = "sov_hub";\n/);
    const body = bodyOf(source, "resetStartupOrphanedUniverseSites");
    assert.match(body, /const origins = new Set\(\["universe_dungeon", SOV_GUARANTEED_SITE_ORIGIN\]\);/);
    assert.match(body, /if \(!origins\.has\(normalizeLowerText\(instance\.siteOrigin, ""\)\)\) \{\n\s+continue;/);
  });

  test("SOF2 vendor: every siteOriginFilter of dungeonUniverseRuntime lists only universe / mining / sov", () => {
    const lists = filterLists(readSource(UNIVERSE));
    assert.ok(lists.length >= 4, `expected >= 4 siteOriginFilter lists, got ${lists.length}`);
    for (const list of lists) {
      assert.ok(list.length > 0, "a filter is never empty");
      for (const item of list) assert.ok(FILTER_ALLOWED.includes(item), `unexpected origin ${item}`);
    }
  });

  test("SOF3 vendor: the dungeonRuntime reconcile skips instances and summaries outside its siteOriginFilter", () => {
    const source = readSource(RUNTIME);
    const instances = source.match(/!siteOriginFilter\.has\(normalizeText\(instance\.siteOrigin/g) || [];
    const summaries = source.match(/siteOriginFilter\.has\(normalizeText\(summary\.siteOrigin/g) || [];
    assert.ok(instances.length >= 2, `instance filter x${instances.length}`);
    assert.strictEqual(summaries.length, 1, "summary filter once");
  });

  test("SOF4 vendor: buildMissionDungeonSiteKey returns mission:<character>:<sequence> (never lne:)", () => {
    const body = bodyOf(readSource(MISSIONS), "buildMissionDungeonSiteKey");
    assert.match(body, /return `mission:\$\{/);
    assert.ok(!body.includes("lne:"), "no lne: prefix");
  });

  test("SOF5 mod: SITE_ORIGIN lne_event is in no vendor origin set of SOF1 / SOF2", () => {
    const origin = modOrigin();
    assert.strictEqual(origin, "lne_event");
    const quoted = `"${origin}"`;
    const source = readSource(UNIVERSE);
    assert.ok(!bodyOf(source, "resetStartupOrphanedUniverseSites").includes(quoted), "not reset at startup");
    for (const list of filterLists(source)) assert.ok(!list.includes(quoted), "not in a siteOriginFilter");
    assert.ok(!["universe_dungeon", "generatedmining", "sov_hub"].includes(origin));
  });
};
