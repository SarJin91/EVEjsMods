"use strict";

const { SCHEMA } = require("../../config");
const { gameMasterSettingsOf } = require("../../lib/gameMaster/schema");
const { createStepRegistry, registerBuiltin } = require("../../lib/gameMaster/registry");
const { createWaitStep } = require("../../lib/gameMaster/steps/wait");
const { createNoticeSender, createNoticeStep } = require("../../lib/gameMaster/steps/notice");
const { createNewsStep } = require("../../lib/gameMaster/steps/news");

const SYSTEMS = Object.freeze([
  { id: 30000001, name: "Ostu", regionId: 10000001, secClass: "lowsec", n: [30000002] },
  { id: 30000002, name: "Rakka", regionId: 10000001, secClass: "lowsec", n: [30000001, 30000003] },
  { id: 30000003, name: "Vemir", regionId: 10000001, secClass: "lowsec", n: [30000002] },
  { id: 30000011, name: "Kor-Azor", regionId: 10000002, secClass: "nullsec", n: [] },
  { id: 30000012, name: "Zenith", regionId: 10000002, secClass: "nullsec", n: [] },
  { id: 30000021, name: "Jita", regionId: 10000003, secClass: "highsec", n: [] },
]);
const REGIONS = new Map([[10000001, "Alpha Reach"], [10000002, "Beta Drift"], [10000003, "The Forge"]]);
const NAMES = new Map([[500010, "Guristas Pirates"], [500011, "Angel Cartel"], [500001, "Caldari State"]]);

function graphFixture() {
  const byId = new Map(SYSTEMS.map((s) => [s.id, s]));
  return Object.freeze({
    getSystem: (id) => byId.get(Number(id)) || null,
    getNeighbors: (id) => (byId.has(Number(id)) ? byId.get(Number(id)).n : null),
    getSystemsInRegion: (r) => SYSTEMS.filter((s) => s.regionId === r).map((s) => s.id),
    getSystemsBySecClass: (c) => SYSTEMS.filter((s) => s.secClass === c).map((s) => s.id),
    getRegionName: (r) => REGIONS.get(r) || null,
  });
}

function settingsOf(over) {
  const raw = Object.fromEntries(SCHEMA.filter((r) => r.key.startsWith("gameMaster."))
    .map((r) => [r.key.slice("gameMaster.".length), r.default]));
  const parsed = gameMasterSettingsOf({ gameMaster: { ...raw, ...(over || {}) } });
  if (!parsed.ok) throw new Error(`settings ${parsed.detail}`);
  return parsed.settings;
}

function sectionOf(over) {
  const raw = Object.fromEntries(SCHEMA.filter((r) => r.key.startsWith("gameMaster."))
    .map((r) => [r.key.slice("gameMaster.".length), r.default]));
  return { ...raw, ...(over || {}) };
}

function stubKind(type, over) {
  return { type, owner: "test", version: 1, promptHint: `${type}: a stub`, maxPerThread: 1,
    duration: { minMs: 0, maxMs: 0 }, validate: (p) => ({ ok: true, params: p }),
    startInTx: (_tx, s) => ({ ok: true, handle: {}, dueAt: s.now }), pollInTx: () => ({ state: "DONE",
      outcome: "NEUTRAL" }), cancelInTx: () => ({ ok: true }), ...(over || {}) };
}

function registryWithBuiltins(S, senderDeps) {
  const registry = createStepRegistry();
  const sender = createNoticeSender({ getNotices: () => null, getPresence: () => null, getGraph: () => null, S,
    ...(senderDeps || {}) });
  for (const kind of [createWaitStep(S), createNoticeStep({ sender }), createNewsStep()]) {
    const r = registerBuiltin(registry, kind);
    if (!r.ok) throw new Error(`builtin ${kind.type} ${r.reason}`);
  }
  return { registry, sender };
}

module.exports = { SYSTEMS, REGIONS, NAMES, graphFixture, settingsOf, sectionOf, stubKind, registryWithBuiltins };
