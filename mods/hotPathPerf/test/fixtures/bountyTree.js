"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const STATE_BODIES = Object.freeze([
  "cloneValue", "toInteger", "normalizeMoney", "emptyState", "emptyHunterStats", "normalizeHunterStat",
  "normalizeHunterStats", "normalizePayoutRecord", "normalizePayoutRecords", "normalizeState", "readState",
  "readCorporationRecord", "readAllianceRecord", "isInRange", "inferOwnerKind", "resolveOwnerAffiliation",
  "normalizePool", "getPool",
]);
const CHAR_BODIES = Object.freeze(["getCharacterRecord", "readSharedCharacterRecord"]);
const PROXY_BODIES = Object.freeze([
  "collectRequestedIds", "extractIdList", "buildBountyPayload", "buildBountyPayloadFromPool", "buildBountyEntry",
  "buildBountyEntries",
]);

const CHARACTERS = {};
for (let i = 1; i <= 20; i += 1) {
  const id = i <= 15 ? 90000000 + i : 2100000000 + i;
  const corporationID = 98000000 + ((i % 10) + 1);
  const record = { name: `Pilot ${i}`, corporationID, skills: { [i]: { level: i % 5 } }, history: [i, i + 1] };
  if (i % 3 !== 0) record.allianceID = 99000000 + ((i % 5) + 1);
  if (i === 7) record.corporationID = String(corporationID);
  if (i === 8) record.allianceID = "not-a-number";
  CHARACTERS[String(id)] = record;
}
const CORPORATIONS = {};
for (let i = 1; i <= 10; i += 1) {
  CORPORATIONS[String(98000000 + i)] = i % 2 === 0 ? { corporationName: `Corp ${i}`, allianceID: 99000000 + i % 5 + 1 } : { corporationName: `Corp ${i}` };
}
const ALLIANCES = {};
for (let i = 1; i <= 5; i += 1) ALLIANCES[String(99000000 + i)] = { allianceName: `Alliance ${i}` };

const BOUNTY_STATE = {
  nextContributionID: 7,
  pools: {
    90000001: { targetID: 90000001, bounty: 5000000, updatedAt: "133700000000000001" },
    90000003: { targetID: 90000003, bounty: 2000000.555 },
    2100000016: { targetID: 2100000016, bounty: 1000000, updatedAt: "133700000000000002" },
    98000001: { targetID: 98000001, bounty: 25000000, updatedAt: "133700000000000003" },
    99000002: { targetID: 99000002, bounty: 100000000 },
    90500002: { targetID: 90500002, bounty: 3000000 },
  },
  contributions: { 1: { contributionID: 1, targetID: 90000001, amount: 5000000 } },
  hunterStats: { character: { 90000002: { numberOfKills: 3, bountiesClaimed: 12.5 } }, corporation: {}, alliance: {} },
  payoutsByID: { p1: { payoutID: "p1", hunterCharacterID: 90000002, amount: 10, status: "paid" } },
};

const UNKNOWN_IDS = [90500001, 90500002, 90500003, 2110000001, 2110000002, 98500001, 98500002, 98500003, 99500001, 99500002];
const EDGE_IDS = [0, -5, -98000001, 12345, 90000001, "90000002", 98000002n];
const REQUEST_IDS = Object.freeze([
  ...Object.keys(CHARACTERS).map(Number), ...Object.keys(CORPORATIONS).map(Number), ...Object.keys(ALLIANCES).map(Number),
  ...UNKNOWN_IDS, ...EDGE_IDS,
]);
const KILL_RIGHT_IDS = Object.freeze([90000004, 90000005, 2100000017, 90500001]);

const UPSTREAM_ENTRIES = "function buildBountyEntries(targetIDs) {\n" +
  "  const numericTargetIDs = extractIdList(targetIDs).map((targetID) => Number(targetID) || 0);\n" +
  "  // One read of the bounty table for the whole request, not one per target.\n" +
  "  const pools = playerBountyState.getPools(numericTargetIDs);\n" +
  "  return numericTargetIDs.map((targetID, index) => [\n    targetID,\n    buildBountyPayloadFromPool(pools[index]),\n  ]);\n}\n";
const LEGACY_ENTRIES = "function buildBountyEntry(targetID) {\n  const numericTargetID = Number(targetID) || 0;\n" +
  "  const pool = playerBountyState.getPool(null, numericTargetID);\n  return [\n    numericTargetID,\n" +
  "    buildBountyPayloadFromPool(pool),\n  ];\n}\n\n" +
  "function buildBountyEntries(targetIDs) {\n  return extractIdList(targetIDs).map((targetID) => buildBountyEntry(targetID));\n}\n";
function legacyProxy(text) {
  const src = String(text).replace(/\r\n/g, "\n");
  assert.ok(src.includes(UPSTREAM_ENTRIES), "buildBountyEntries 261115.2");
  return src.replace(UPSTREAM_ENTRIES, LEGACY_ENTRIES);
}

function extractBodies(text, names) {
  const src = String(text).replace(/\r\n/g, "\n");
  return names.map((name) => {
    const start = new RegExp(`^function ${name}\\(`, "m").exec(src);
    assert.ok(start, `vendor: function ${name}`);
    const end = /\n\}(\n|$)/g;
    end.lastIndex = start.index;
    const hit = end.exec(src);
    return src.slice(start.index, hit.index + 2);
  }).join("\n\n");
}

function extractConst(text, name) {
  const src = String(text).replace(/\r\n/g, "\n");
  const start = new RegExp(`^const ${name} = `, "m").exec(src);
  assert.ok(start, `vendor: const ${name}`);
  const end = src.indexOf("\n});", start.index);
  return src.slice(start.index, end + 4);
}

const REPO_TEXT = (data) => "\"use strict\";\n" +
  `const data = ${JSON.stringify(data)};\n` +
  "const counters = { stateReads: 0, readShared: 0, clones: 0, writes: 0, nestedFrom: null, nestedTo: null, nestedResult: undefined };\n" +
  "let fileTime = 0;\n" +
  "function currentFileTime() { fileTime += 1; return `13370000000${fileTime}`; }\n" +
  "function read(table, pth) {\n" +
  "  if (table === \"playerBounties\" && pth === \"/\") { counters.stateReads += 1; return { success: true, data: data.bounty }; }\n" +
  "  if (table === \"corporations\" && pth === \"/records\") return { success: true, data: data.corporations };\n" +
  "  if (table === \"alliances\" && pth === \"/records\") return { success: true, data: data.alliances };\n" +
  "  return { success: false, errorMsg: \"ENTRY_NOT_FOUND\", data: null };\n}\n" +
  "module.exports = { read, currentFileTime, counters, data };\n";

const CHAR_HELPERS = "const fake = require(path.join(__dirname, \"../bounty/fakeRepo\"));\n" +
  "const sharedCache = new Map();\n" +
  "function ensureMigrated() { fake.counters.readShared += 1; }\n" +
  "function readCharacters() { return fake.data.characters; }\n" +
  "function getCharacterRecordInputVersion() { return 1; }\n" +
  "function deepFreeze(v) { if (v && typeof v === \"object\" && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]); } return v; }\n" +
  "function freezeRecord(r) { return deepFreeze(r); }\n" +
  "function readCachedCharacterRecord(charId, raw, version) {\n" +
  "  const hit = sharedCache.get(String(charId));\n  return hit && hit.raw === raw && hit.version === version ? hit.record : null;\n}\n" +
  "function normalizeCharacterRecord(charId, raw) {\n" +
  "  if (fake.counters.nestedFrom === Number(charId)) {\n    fake.counters.nestedFrom = null;\n" +
  "    fake.counters.nestedResult = module.exports.getCharacterRecord(fake.counters.nestedTo);\n  }\n" +
  "  return JSON.parse(JSON.stringify(raw));\n}\n" +
  "function writeCharacterRecord() { fake.counters.writes += 1; }\n" +
  "function rememberCharacterRecord(charId, raw, version, record) {\n" +
  "  const frozen = freezeRecord(record);\n  sharedCache.set(String(charId), { raw, version, record: frozen });\n  return frozen;\n}\n" +
  "function cloneValue(value) { fake.counters.clones += 1; return JSON.parse(JSON.stringify(value)); }\n";

function makeTree(texts, tamper = null) {
  const upstream = texts.upstream === true;
  const proxyText = upstream ? texts.proxy : legacyProxy(texts.proxy);
  const proxyBodies = upstream ? PROXY_BODIES.filter((n) => n !== "buildBountyEntry") : PROXY_BODIES;
  const stateBodies = upstream ? [...STATE_BODIES, "getPools"] : STATE_BODIES;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hotpathBounty-"));
  const src = path.join(root, "server", "src");
  const dirs = { bounty: path.join(src, "services", "bounty"), character: path.join(src, "services", "character") };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });
  const bump = (text, names) => {
    if (!names.includes(tamper)) return text;
    return text.replace(new RegExp(`^function ${tamper}\\(`, "m"), `function ${tamper}( `);
  };
  const files = {
    repo: path.join(dirs.bounty, "fakeRepo.js"),
    state: path.join(dirs.bounty, "playerBountyState.js"),
    killRight: path.join(dirs.bounty, "killRightState.js"),
    proxy: path.join(dirs.bounty, "bountyProxyService.js"),
    char: path.join(dirs.character, "characterState.js"),
  };
  fs.writeFileSync(files.repo, REPO_TEXT({ bounty: BOUNTY_STATE, corporations: CORPORATIONS, alliances: ALLIANCES, characters: CHARACTERS }));
  fs.writeFileSync(files.char, "\"use strict\";\nconst path = require(\"path\");\n" + CHAR_HELPERS +
    bump(extractBodies(texts.char, CHAR_BODIES), CHAR_BODIES) +
    "\n\nmodule.exports = { getCharacterRecord, readSharedCharacterRecord };\n");
  fs.writeFileSync(files.state, "\"use strict\";\nconst path = require(\"path\");\n" +
    "const repo = require(path.join(__dirname, \"fakeRepo\"));\n" +
    "const { currentFileTime } = require(path.join(__dirname, \"fakeRepo\"));\n" +
    "const {\n  getCharacterRecord,\n} = require(path.join(__dirname, \"../character/characterState\"));\n" +
    "const TABLE_NAME = \"playerBounties\";\nconst DURABLE_PAYOUT_JOB_PREFIX = \"player-bounty:\";\n" +
    "const walkCloneValue = (value) => JSON.parse(JSON.stringify(value));\n" +
    `${extractConst(texts.state, "OWNER_KIND")}\n${extractConst(texts.state, "OWNER_RANGES")}\n\n` +
    bump(extractBodies(texts.state, stateBodies), stateBodies) +
    `\n\nmodule.exports = {\n  TABLE_NAME,\n  OWNER_KIND,\n  getPool,\n${upstream ? "  getPools,\n" : ""}  _testing: {\n    emptyState,\n    readState,\n  },\n};\n`);
  fs.writeFileSync(files.killRight, "\"use strict\";\nconst path = require(\"path\");\n" +
    "const { getCharacterRecord } = require(path.join(__dirname, \"../character/characterState\"));\n" +
    "function listAvailableKillRightsOnCharacters(ids) {\n  const out = [];\n  for (const id of ids) {\n" +
    "    const record = getCharacterRecord(id);\n    if (!record) continue;\n    record.name = `${record.name} (kill right)`;\n" +
    "    out.push({ killRightID: id, toID: id, name: record.name });\n  }\n  return out;\n}\n" +
    "module.exports = { listAvailableKillRightsOnCharacters };\n");
  fs.writeFileSync(files.proxy, "\"use strict\";\nconst path = require(\"path\");\n" +
    "const playerBountyState = require(path.join(__dirname, \"./playerBountyState\"));\n" +
    "const killRightState = require(path.join(__dirname, \"./killRightState\"));\n" +
    "function buildKeyVal(entries) { return { type: \"keyval\", entries }; }\n" +
    "function buildList(items) { return { type: \"list\", items }; }\n" +
    "function buildKillRightPayload(r) { return buildKeyVal([[\"killRightID\", r.killRightID], [\"toID\", r.toID], [\"name\", r.name]]); }\n" +
    bump(extractBodies(proxyText, proxyBodies), proxyBodies) + "\n\n" +
    "class BountyProxyService {\n" +
    "  Handle_GetBounties(args) {\n    const requested = args && args.length > 0 ? args[0] : [];\n" +
    "    return buildList(buildBountyEntries(extractIdList(requested)));\n  }\n\n" +
    "  Handle_GetBountiesAndKillRights(args) {\n    const requested = args && args.length > 0 ? args[0] : [];\n" +
    "    const killRightIds = extractIdList(args && args.length > 1 ? args[1] : []);\n" +
    "    return [\n      buildList(buildBountyEntries(extractIdList(requested))),\n" +
    "      buildList(killRightState.listAvailableKillRightsOnCharacters(killRightIds).map((r) => buildKillRightPayload(r))),\n    ];\n  }\n\n" +
    "  callMethod(method, args, session, kwargs) {\n    const handlerName = `Handle_${method}`;\n" +
    "    return this[handlerName](args, session, kwargs);\n  }\n}\n\nmodule.exports = BountyProxyService;\n");
  return { root, src, dirs, files };
}

module.exports = {
  makeTree, extractBodies, legacyProxy, REQUEST_IDS, KILL_RIGHT_IDS, CHARACTERS, CORPORATIONS, ALLIANCES, BOUNTY_STATE,
  STATE_BODIES, CHAR_BODIES, PROXY_BODIES,
};
