"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const S = require("../../lib/shipAi/schema");
const { parseRange, classifyEntries, summarizeScan, AU_METERS } = require("../../lib/shipAi/dscan/summary");
const { readDirectionalScanFrom } = require("../../lib/adapter/shipAiDscan");
const { TOOLS_DB } = require("../../lib/shipAi/tools/catalogDb");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const PLAYER = 9001;
const OWN_CORP = 98000001;
const JITA = 30000142;
const SHIP = 1000000001;
const GURISTAS = 500010;
const AMARR = 500003;
const CHAR_A = 90000011;
const CORP_A = 98000077;
const ALLY_A = 99000055;
const CHAR_B = 90000022;
const CORP_B = OWN_CORP;

const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SHIP_AI_ENABLED: "1" } }).config;
function settings(over) {
  const r = S.shipAiModelSettingsOf({ shipAi: { ...base.shipAi, ...(over || {}) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const npc = (entityId, factionId, typeId) => ({ entityId, typeId, groupId: 25, kind: "ship", distanceMeters: 1000,
  isPlayer: false, characterId: null, corporationId: null, allianceId: null, factionId, targetsMe: false });
const pilot = (entityId, characterId, corporationId, allianceId) => ({ entityId, typeId: 587, groupId: 25, kind: "ship",
  distanceMeters: 2000, isPlayer: true, characterId, corporationId, allianceId, factionId: null, targetsMe: false });
const thing = (entityId, kind) => ({ entityId, typeId: 1, groupId: 1, kind, distanceMeters: 3000, isPlayer: false,
  characterId: null, corporationId: null, allianceId: null, factionId: null, targetsMe: false });

const ENTRIES = [npc(1, GURISTAS, 101), npc(2, GURISTAS, 101), npc(3, GURISTAS, 101), npc(4, AMARR, 102),
  pilot(5, CHAR_A, CORP_A, ALLY_A), pilot(6, CHAR_B, CORP_B, null), thing(7, "wreck"), thing(8, "probe"),
  thing(9, "stargate")];
const CLASSES = new Map([[101, "frigate"], [102, "cruiser"], [587, "frigate"]]);
const FACTIONS = new Map([[GURISTAS, "Guristas"], [AMARR, "Amarr Empire"]]);

module.exports = ({ test }) => {
  test("DS1 parseRange: max, km, AU, a bare number = km, the clamp [10 km, 14.3 AU], BAD_RANGE", () => {
    assert.deepStrictEqual(parseRange("max"), { ok: true, meters: null });
    assert.deepStrictEqual(parseRange(" MAX "), { ok: true, meters: null });
    for (const t of ["300 km", "300km", "300", "300 KM"]) assert.deepStrictEqual(parseRange(t), { ok: true, meters: 300000 }, t);
    assert.deepStrictEqual(parseRange("5 AU"), { ok: true, meters: 5 * AU_METERS });
    assert.deepStrictEqual(parseRange("2,5au"), { ok: true, meters: 2.5 * AU_METERS });
    assert.deepStrictEqual(parseRange("0.001 km"), { ok: true, meters: 10000 });
    assert.deepStrictEqual(parseRange("99 AU"), { ok: true, meters: 14.3 * AU_METERS });
    for (const t of ["abc", "-5", "0", "", "5 ly", null]) {
      assert.deepStrictEqual(parseRange(t), { ok: false, reason: "BAD_RANGE" }, String(t));
    }
  });

  test("DS2 classifyEntries + summarizeScan: Guristas hostile x3, Amarr not, a hostile pilot by a corporation "
    + "contact, an own-corporation pilot never, no ID in the result, contacts null; the dscan tool", () => {
    const M = settings();
    const contacts = new Map([[CORP_A, -10], [CHAR_B, -10]]);
    const ctx = { pirates: new Set([GURISTAS]), invaders: null, standing: (id) => (id === AMARR ? 0 : null), contacts,
      ownCorporationId: OWN_CORP, ownAllianceId: null, classOf: (t) => CLASSES.get(t) || null,
      factionName: (id) => FACTIONS.get(id) || null };
    const classified = classifyEntries(ENTRIES, ctx, M);
    assert.deepStrictEqual(classified.map((c) => c.cat),
      ["npc", "npc", "npc", "npc", "pilot", "pilot", "wreck", "probe", "other"]);
    const out = summarizeScan(classified, { rangeMeters: null, truncated: false }, ctx, M);
    assert.deepStrictEqual(out, { rangeAu: null, total: 9,
      ships: [{ faction: "Guristas", cls: "frigate", count: 3, hostile: true },
        { faction: "Amarr Empire", cls: "cruiser", count: 1, hostile: false }],
      pilots: { total: 2, hostile: 1, classes: [{ cls: "frigate", count: 2 }] },
      structures: 0, wrecks: 1, probes: 1, drones: 0, containers: 0, other: 1, truncated: false });
    const json = JSON.stringify(out);
    for (const id of [CHAR_A, CORP_A, ALLY_A, CHAR_B, CORP_B, PLAYER]) assert.ok(!json.includes(String(id)), String(id));
    const blind = { ...ctx, contacts: null };
    assert.strictEqual(summarizeScan(classifyEntries(ENTRIES, blind, M), { rangeMeters: 5 * AU_METERS }, blind, M)
      .pilots.hostile, null);
    assert.strictEqual(summarizeScan([], { rangeMeters: 5 * AU_METERS }, blind, M).rangeAu, 5);

    const tool = TOOLS_DB.find((t) => t.name === "dscan");
    assert.ok(tool && tool.db === true && tool.description.length <= 70);
    const calls = [];
    const deps = { dscan: (id, o) => (calls.push(["dscan", id, o]), { ok: true, rangeMeters: o.rangeMeters,
      truncated: false, unresolved: 0, own: { corporationId: OWN_CORP, allianceId: null }, entries: ENTRIES }),
    contactStandings: (id, ids) => (calls.push(["contacts", id, ids]), { ok: true, standings: contacts }),
    pirates: () => ctx.pirates, invaderFactions: () => null, standing: (_p, f) => ctx.standing(f),
    typeClass: ctx.classOf, factionName: ctx.factionName };
    const r = tool.run({ playerId: PLAYER, deps, S: M, nowMs: () => 1 }, { range: "max" });
    assert.deepStrictEqual(r, { ok: true, data: out });
    assert.deepStrictEqual(calls, [["dscan", PLAYER, { rangeMeters: null, maxEntries: M.dscanMaxEntries }],
      ["contacts", PLAYER, [CHAR_A, CORP_A, ALLY_A, CHAR_B, CORP_B]]]);
    assert.deepStrictEqual(tool.run({ playerId: PLAYER, deps, S: M }, { range: "far" }), { ok: false, reason: "BAD_RANGE" });
    const refusing = { ...deps, dscan: () => ({ ok: false, reason: "IN_WARP" }) };
    assert.deepStrictEqual(tool.run({ playerId: PLAYER, deps: refusing, S: M }, { range: "1 AU" }),
      { ok: false, reason: "IN_WARP" });
  });

  test("DS3 readDirectionalScanFrom on a fake ScanMgrService: ABYSSAL_BLOCKED, SEAM_FAILED, [], the vendor order, "
    + "maxEntries, unresolved, targetsMe, isPlayer, IN_WARP, DOCKED, the call args; facade key dscan", () => {
    const kv = (id, typeID, groupID) => ({ type: "object", name: "util.KeyVal",
      args: { type: "dict", entries: [["id", id], ["typeID", typeID], ["groupID", groupID]] } });
    let behaviour = () => [];
    const seen = [];
    class FakeScanMgr {
      _getSystemID(session) { return session._space.systemID; }
      Handle_ConeScan(args, session) {
        seen.push({ args, systemId: this._getSystemID(session) });
        return behaviour();
      }
    }
    const ego = { kind: "ship", position: { x: 0, y: 0, z: 0 }, radius: 50 };
    const ents = new Map([
      [11, { kind: "ship", typeID: 101, position: { x: 1050, y: 0, z: 0 }, radius: 0, warFactionID: GURISTAS }],
      [12, { kind: "ship", typeID: 587, characterID: CHAR_A, corporationID: CORP_A, allianceID: ALLY_A,
        position: { x: 0, y: 2000, z: 0 }, radius: 50 }],
      [14, { kind: "wreck", position: { x: 5000, y: 0, z: 0 } }],
      [15, { kind: "probe", position: { x: 6000, y: 0, z: 0 } }]]);
    const session = { characterID: PLAYER, corporationID: OWN_CORP, _space: { shipID: SHIP, systemID: JITA } };
    const mods = (over) => ({ sessionRegistry: { getSessions: () => [session] },
      runtime: { getEntity: (s, id) => (id === SHIP ? ego : null),
        scenes: new Map([[JITA, { getEntityByID: (id) => ents.get(id) || null }]]) },
      scanMgr: FakeScanMgr,
      registry: { getControllerByEntityID: (id) => (id === 11 ? { entityID: 11, currentTargetID: SHIP } : null) },
      factionKill: { resolveVictimFactionID: (e) => e.warFactionID }, ...(over || {}) });
    const read = (o, m) => readDirectionalScanFrom(m || mods(), PLAYER, { rangeMeters: null, maxEntries: 3, ...o });

    behaviour = () => { const e = new Error("blocked"); e.name = "MachoWrappedException"; throw e; };
    assert.deepStrictEqual(read(), { ok: false, reason: "ABYSSAL_BLOCKED" });
    behaviour = () => { throw new Error("boom"); };
    assert.deepStrictEqual(read(), { ok: false, reason: "SEAM_FAILED" });
    behaviour = () => null;
    assert.deepStrictEqual(read(), { ok: false, reason: "SEAM_FAILED" });
    behaviour = () => [];
    seen.length = 0;
    assert.deepStrictEqual(read(), { ok: true, systemId: JITA, rangeMeters: null, truncated: false, unresolved: 0,
      own: { corporationId: OWN_CORP, allianceId: null }, entries: [] });
    assert.deepStrictEqual(seen, [{ args: [Math.PI * 2, 1e15, 1, 0, 0], systemId: JITA }]);

    behaviour = () => [kv(12, 587, 25), kv(13, 1, 1), kv(11, 101, 25), kv(14, 26, 186), kv(15, 479, 479)];
    const r = read();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([r.truncated, r.unresolved, r.entries.map((e) => e.entityId)], [true, 1, [12, 11]]);
    assert.deepStrictEqual(r.entries[0], { entityId: 12, typeId: 587, groupId: 25, kind: "ship", distanceMeters: 1900,
      isPlayer: true, characterId: CHAR_A, corporationId: CORP_A, allianceId: ALLY_A, factionId: null,
      targetsMe: false });
    assert.deepStrictEqual(r.entries[1], { entityId: 11, typeId: 101, groupId: 25, kind: "ship", distanceMeters: 1000,
      isPlayer: false, characterId: null, corporationId: null, allianceId: null, factionId: GURISTAS,
      targetsMe: true });
    seen.length = 0;
    assert.strictEqual(read({ rangeMeters: 300000, maxEntries: 10 }).entries.length, 4);
    assert.strictEqual(seen[0].args[1], 300000);

    ego.mode = "WARP";
    assert.deepStrictEqual(read(), { ok: false, reason: "IN_WARP" });
    delete ego.mode;
    session.stationid = 60003760;
    assert.deepStrictEqual(read(), { ok: false, reason: "DOCKED" });
    delete session.stationid;
    assert.deepStrictEqual(read({ maxEntries: 0 }), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(read({ rangeMeters: -1 }), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(read({}, mods({ scanMgr: null })), { ok: false, reason: "SEAM_UNAVAILABLE" });
    assert.deepStrictEqual(readDirectionalScanFrom(mods(), 4242, { rangeMeters: null, maxEntries: 3 }),
      { ok: false, reason: "NO_SESSION" });

    const SRC = path.join(path.sep, "x", "server", "src");
    const key = (rel) => path.join(SRC, `${rel}.js`);
    const cache = { [key("_secondary/chat/chatRuntime")]: { exports: {} },
      [key("services/chat/xmppStubServer")]: { exports: {} } };
    const adapter = createAdapter({ moduleApi: { _cache: cache }, logger: { log() {} } });
    adapter.setServerSrc(SRC);
    const seams = adapter.shipAiSeams();
    assert.strictEqual(seams.ok, true, JSON.stringify(seams));
    assert.ok(Object.keys(seams.seam.sensors).includes("dscan"));
    assert.strictEqual(seams.seam.sensors.dscan(PLAYER, { rangeMeters: null, maxEntries: 3 }).ok, false);
  });

  test("DS4 vendor facts scanMgrService.js: Handle_ConeScan uses only this._getSystemID, _getSystemID has no this., "
    + "DSCAN_MIN_RANGE_METERS 10_000, module.exports = ScanMgrService", () => {
    const text = fs.readFileSync(path.join(SERVER_SRC, "services", "exploration", "scanMgrService.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const bodyOf = (head) => {
      const at = text.indexOf(head);
      assert.ok(at >= 0, head);
      const end = text.indexOf("\n  Handle_", at + head.length);
      return text.slice(at, end < 0 ? text.length : end);
    };
    const cone = bodyOf("  Handle_ConeScan(args, session) {");
    assert.deepStrictEqual([...new Set([...cone.matchAll(/this\.(\w+)/g)].map((m) => m[1]))], ["_getSystemID"]);
    const sys = bodyOf("  _getSystemID(session) {");
    const sysBody = sys.slice(0, sys.indexOf("\n  }\n") + 4);
    assert.ok(sysBody.length > 10 && !sysBody.includes("this."), sysBody);
    assert.ok(text.includes("const DSCAN_MIN_RANGE_METERS = 10_000;"));
    assert.ok(text.includes("module.exports = ScanMgrService;"));
  });

  test("DS5: dscan without range / blank = max; another tool still needs its argument; native "
    + "required without range; the description names the values; the d-scan words in the native rules too", () => {
    const { argsFor } = require("../../lib/shipAi/tools/loop");
    const { nativeToolsOf } = require("../../lib/shipAi/tools/protocol");
    const { TOOL_RULE, TOOL_RULE_PROACTIVE } = require("../../lib/shipAi/data/persona");
    const tool = TOOLS_DB.find((t) => t.name === "dscan");
    const findItem = TOOLS_DB.find((t) => t.name === "find_item");
    for (const raw of [{}, { range: "" }, { range: "  " }, { range: null }]) {
      assert.deepStrictEqual(argsFor(tool, raw), { ok: true, args: { range: "max" } }, JSON.stringify(raw));
    }
    assert.deepStrictEqual(argsFor(tool, { range: "300 km" }), { ok: true, args: { range: "300 km" } });
    assert.deepStrictEqual(argsFor(findItem, {}), { ok: false, reason: "BAD_ARGUMENT" });
    const native = nativeToolsOf([tool, findItem]).map((t) => t.function.parameters.required);
    assert.deepStrictEqual(native, [[], ["item"]]);
    assert.ok(tool.description.length <= 70 && /max/.test(tool.description) && /km/.test(tool.description)
      && /AU/.test(tool.description), tool.description);
    for (const rule of [TOOL_RULE, TOOL_RULE_PROACTIVE]) {
      assert.ok(rule.native.join(" ").includes("na skanie") && rule.text.join(" ").includes("na skanie"));
    }
  });
};
