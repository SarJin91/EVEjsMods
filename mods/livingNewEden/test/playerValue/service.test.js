"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { startPlayerValue } = require("../../lib/world/playerValue");
const { VALUE_KINDS } = require("../../lib/world/playerValue/rules");
const { TRIG_MARKER_KEY } = require("../../lib/adapter/playerStructures");
const { listPlayerSkyhooksFrom, createPlayerSkyhookSeam } = require("../../lib/adapter/playerSkyhooks");
const { SCHEMA } = require("../../config");

const MOD = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD, "..", "..", "server", "src");
const read = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const AT = 1760000000000;
const TTL = 60000;
const VIRTUAL_CORP = 98000666;

function config(over = {}) {
  const weight = Object.fromEntries(VALUE_KINDS.map((k) => [k,
    SCHEMA.find((r) => r.key === `playerValue.weight.${k}`).default]));
  return { playerValue: { enabled: true, indexTtlMs: TTL, maxIndexStructures: 100, maxIndexSkyhooks: 10,
    maxCountPerKind: 3, valueCap: 120, unclaimedPermille: 0, weight, ...over } };
}

const st = (structureId, systemId, o = {}) => Object.freeze({ structureId, systemId, typeId: 35832,
  family: "citadel", size: "STRUCTURE_SIZE_MEDIUM", ownerCorpId: 98000001, state: "SHIELD_VULNERABLE", trig: false,
  ...o });

function fakeAdapter(o = {}) {
  const calls = { structures: 0, skyhooks: 0 };
  const adapter = {
    playerStructures: { listCandidates(opts) {
      calls.structures += 1;
      calls.lastOpts = opts;
      if (o.structuresRefused) return { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE", detail: "drift" };
      return { ok: true, truncated: false, total: 0, builtAt: opts.nowMs, bySystem: new Map([
        [30001, [st(1, 30001), st(2, 30001, { typeId: 81826, family: "refinery", size: "STRUCTURE_SIZE_FLEX" }),
          st(3, 30001, { ownerCorpId: VIRTUAL_CORP, size: "STRUCTURE_SIZE_EXTRA_LARGE" })]],
        [30002, [st(4, 30002, { typeId: 35841, family: "flex", size: "STRUCTURE_SIZE_FLEX", trig: true }),
          st(5, 30002, { state: "ANCHORING" })]],
      ]) };
    } },
    playerSkyhooks: { listPlayerSkyhooks(opts) {
      calls.skyhooks += 1;
      assert.strictEqual(opts.max, 10);
      return { ok: true, truncated: false, skyhooks: [
        { skyhookId: 11, systemId: 30001, corpId: 98000001, active: true, destroyed: false },
        { skyhookId: 12, systemId: 30001, corpId: 98000001, active: false, destroyed: false },
        { skyhookId: 13, systemId: 30001, corpId: 98000001, active: true, destroyed: true },
        { skyhookId: 14, systemId: 30003, corpId: VIRTUAL_CORP, active: true, destroyed: false },
      ] };
    } },
  };
  return { adapter, calls };
}

const virtualCorps = () => ({ isVirtualCorporation: (id) => id === VIRTUAL_CORP });

module.exports = ({ test }) => {
  test("PV4 playerValue service: off = no read; TTL; refused seam -> 0 + seamRefused; no kindOf -> sentry; "
    + "virtual owner skipped; unknown kind = 0 + unknownKind", () => {
    const off = fakeAdapter();
    assert.deepStrictEqual(startPlayerValue({ config: config({ enabled: false }), adapter: off.adapter }),
      { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(startPlayerValue({ config: {}, adapter: off.adapter }).reason, "disabled_by_config");
    assert.deepStrictEqual([off.calls.structures, off.calls.skyhooks], [0, 0]);
    assert.deepStrictEqual(startPlayerValue({ config: config(), adapter: null }).reason, "adapter_unavailable");

    const sentryRefs = [{ sentryId: "a", ownerKind: "player", typeId: 1 }, { sentryId: "b", ownerKind: "player" },
      { sentryId: "c", ownerKind: "faction" }];
    const sentries = { listLiveInSystem: (id) => (id === 30002 ? sentryRefs : []) };
    const counted = [];
    const telemetry = { count: (n, v) => counted.push([n, v]), gauge: (n, v) => counted.push([n, v]) };
    const { adapter, calls } = fakeAdapter();
    const r = startPlayerValue({ config: config(), adapter, getSentries: () => sentries,
      getVirtualCorps: virtualCorps, telemetry });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const pv = r.playerValue;
    assert.deepStrictEqual(pv.valueOf(30001, AT), { value: 45, capped: false });
    assert.deepStrictEqual(calls.lastOpts.families, ["citadel", "engineering", "refinery", "flex"]);
    assert.deepStrictEqual(pv.snapshotFor([30003, 30002, 30001, 30001], AT + 1),
      new Map([[30001, 45], [30002, 30]]));
    assert.deepStrictEqual([calls.structures, calls.skyhooks], [1, 1], "inside the TTL: no vendor read");
    pv.valueOf(30001, AT + TTL);
    assert.deepStrictEqual([calls.structures, calls.skyhooks], [2, 2], "after the TTL: rebuilt");
    assert.deepStrictEqual([...pv.snapshotFor(null, AT + TTL).keys()], [30001, 30002]);
    sentries.kindOf = (ref) => (ref.sentryId === "a" ? "listening_post" : "mystery");
    pv.valueOf(30001, AT + 2 * TTL);
    assert.deepStrictEqual(pv.valueOf(30002, AT + 2 * TTL), { value: 35, capped: false });
    assert.strictEqual(pv.getStatus().counters.unknownKind, 1);
    pv.notePremium(2, 1);
    assert.deepStrictEqual([pv.getStatus().counters.premiumApplied, pv.getStatus().counters.premiumCapped], [2, 1]);
    assert.ok(counted.some(([n]) => n === "playerValue.indexBuilds"), JSON.stringify(counted));
    assert.ok(counted.some(([n]) => n === "playerValue.systemsValued"), JSON.stringify(counted));

    const lines = [];
    const bad = fakeAdapter({ structuresRefused: true });
    const r2 = startPlayerValue({ config: config(), adapter: bad.adapter, logger: { log: (l) => lines.push(l) } });
    assert.deepStrictEqual(r2.playerValue.valueOf(30002, AT), { value: 0, capped: false });
    assert.deepStrictEqual(r2.playerValue.valueOf(30001, AT + TTL), { value: 15, capped: false });
    assert.strictEqual(r2.playerValue.getStatus().counters.seamRefused, 2);
    assert.strictEqual(lines.filter((l) => l.includes("refused")).length, 1, lines.join("\n"));
    const r3 = startPlayerValue({ config: config(), adapter: { get playerStructures() { throw new Error("x"); } } });
    assert.deepStrictEqual(r3.playerValue.snapshotFor([30001], AT), new Map());
    r3.playerValue.stop();
    assert.deepStrictEqual(r3.playerValue.valueOf(30001, AT), { value: 0, capped: false });
    assert.strictEqual(r3.playerValue.getStatus().state, "stopped");
  });

  test("PV5 vendor facts + K2 text rules: 81826 refinery, 35841 flex, listRaidSkyhooks deployedItem, trig marker key, "
    + "GAME_MODULES row, no getHubUpgrades, no SQLite", () => {
    const constants = read(path.join(SERVER_SRC, "services", "structure", "structureConstants.js"));
    assert.match(constants, /\n {2}81826: \{\n {4}typeID: 81826,\n {4}family: STRUCTURE_FAMILY\.REFINERY,/);
    assert.match(constants, /\n {2}35841: \{\n {4}typeID: 35841,\n {4}family: STRUCTURE_FAMILY\.FLEX,/);
    assert.match(constants, /REFINERY: "refinery",/);
    assert.match(constants, /FLEX: "flex",/);
    const sov = read(path.join(SERVER_SRC, "services", "sovereignty", "sovModernState.js"));
    const body = sov.slice(sov.indexOf("function listRaidSkyhooks() {"));
    assert.ok(body.length > 0 && sov.includes("function listRaidSkyhooks() {"));
    assert.match(body.slice(0, body.indexOf("\n}\n")), /\.filter\(\(record\) => record\.deployedItem === true\)/);
    assert.match(sov.slice(sov.lastIndexOf("module.exports")), /\n {2}listRaidSkyhooks,\n/);
    assert.match(read(path.join(MOD, "lib", "adapter", "trigBridge.js")), /const MARKER_KEY = "lneTrigBridge";/);
    assert.strictEqual(TRIG_MARKER_KEY, "lneTrigBridge");
    assert.strictEqual(TRIG_MARKER_KEY, require("../../lib/adapter/trigBridge").MARKER_KEY);
    assert.ok(!read(path.join(MOD, "lib", "adapter", "playerStructures.js")).includes("\"lneTrigBridge\""));
    assert.match(read(path.join(MOD, "lib", "adapter", "gameModules.js")),
      /sym\("listRaidSkyhooks", "export", \["playerValue", HARVEST_RAID_SKYHOOK\]/);
    const k2 = ["lib/world/playerValue/index.js", "lib/world/playerValue/rules.js", "lib/adapter/playerSkyhooks.js",
      "lib/strategy/ai/playerValue.js"].map((f) => [f, read(path.join(MOD, f))]);
    for (const [f, text] of k2) {
      assert.ok(!text.includes("getHubUpgrades"), f);
      assert.ok(!/\.transaction\(|persistence|\.prepare\(/.test(text), `${f}: no SQLite`);
    }
    let n = 0;
    const vendor = { sov: { listRaidSkyhooks: () => {
      n += 1;
      return [{ skyhookID: 9, solarSystemID: 30001, corporationID: 98000001, active: true, destroyed: false },
        { skyhookID: 3, solarSystemID: 30002, corporationID: 98000002, destroyed: true },
        { skyhookID: 0, solarSystemID: 30002, corporationID: 98000002 }];
    } } };
    assert.deepStrictEqual(listPlayerSkyhooksFrom(vendor, { max: 1 }), { ok: true, truncated: true,
      skyhooks: [{ skyhookId: 3, systemId: 30002, corpId: 98000002, active: true, destroyed: true }] });
    assert.deepStrictEqual(listPlayerSkyhooksFrom(vendor, { max: 0 }), { ok: true, skyhooks: [], truncated: false });
    assert.strictEqual(n, 1);
    assert.strictEqual(listPlayerSkyhooksFrom({ sov: { listRaidSkyhooks: () => { throw new Error("boom"); } } },
      { max: 5 }).reason, "SEAM_ERROR");
    assert.strictEqual(listPlayerSkyhooksFrom({ sov: {} }, { max: 5 }).reason, "PLAYER_SKYHOOKS_SEAM_UNAVAILABLE");
    const drift = createPlayerSkyhookSeam({ requireGame: () => ({ ok: true, exports: vendor.sov }),
      disabledReason: (c) => (c === "playerValue" ? "drift:listRaidSkyhooks" : null) });
    assert.strictEqual(drift.listPlayerSkyhooks({ max: 5 }).reason, "PLAYER_SKYHOOKS_SEAM_UNAVAILABLE");
    const live = createPlayerSkyhookSeam({ requireGame: () => ({ ok: true, exports: vendor.sov }) });
    assert.strictEqual(live.listPlayerSkyhooks({ max: 5 }).skyhooks.length, 2);
  });
};
