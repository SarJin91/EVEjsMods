"use strict";

const fs = require("node:fs");
const path = require("node:path");
const R = require("../lib/resonators");
const FL = require("../lib/factionLoot");
const { mergeSettings } = require("../lib/settings");

const SOURCE_FACTION_ID = 500010;
const COMPONENT_IDS = { aips: R.COMPONENTS.aips, lsbu: R.COMPONENTS.lsbu };
const OLD_BASELINE = Object.freeze({
  chance: { frigate: 0.25, destroyer: 0.30, cruiser: 0.35, battlecruiser: 0.40, battleship: 0.50, capital: 1 },
  eliteChance: 1,
  soeChanceMultiplier: 0.25,
});
const ROWS = Object.freeze([
  { label: "frigate", band: "frigate", tier: "normal" },
  { label: "destroyer", band: "destroyer", tier: "normal" },
  { label: "cruiser", band: "cruiser", tier: "normal" },
  { label: "battlecruiser", band: "battlecruiser", tier: "normal" },
  { label: "battleship", band: "battleship", tier: "normal" },
  { label: "capital", band: "capital", tier: "normal" },
  { label: "elite battleship", band: "battleship", tier: "elite" },
]);

function makeRng(seed) {
  let st = seed | 0;
  return () => {
    st = (st + 0x6d2b79f5) | 0;
    let t = Math.imul(st ^ (st >>> 15), 1 | st);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oldShare(chance) {
  return 1 - (1 - chance) * (1 - Math.min(1, chance * OLD_BASELINE.soeChanceMultiplier));
}

function simulate(settings, ids, { wrecks = 1000000, seed = 99 } = {}) {
  const rng = makeRng(seed);
  return ROWS.map((row) => {
    const source = { factionID: SOURCE_FACTION_ID, resonatorTypeID: ids.resonatorTypeID, band: row.band, tier: row.tier };
    let res = 0;
    let aips = 0;
    let lsbu = 0;
    for (let i = 0; i < wrecks; i += 1) {
      const out = R.rollResonators(source, settings, rng, { soeTypeID: ids.soeTypeID });
      if (out.some((r) => r.typeID === ids.resonatorTypeID || r.typeID === ids.soeTypeID)) res += 1;
      if (out.some((r) => r.typeID === COMPONENT_IDS.aips)) aips += 1;
      if (out.some((r) => r.typeID === COMPONENT_IDS.lsbu)) lsbu += 1;
    }
    const old = oldShare(row.tier === "elite" ? OLD_BASELINE.eliteChance : OLD_BASELINE.chance[row.band]);
    return { label: row.label, oldResonator: old, resonator: res / wrecks, aips: aips / wrecks, lsbu: lsbu / wrecks };
  });
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const cell = (old, now) => `${pct(old)} -> ${pct(now)} (${now > 0 ? `${(old / now).toFixed(1)}x fewer` : "none"})`;

function formatTable(rows) {
  const lines = ["| hull | wreck with a resonator | wreck with AIPS | wreck with LSBU |", "|---|---|---|---|"];
  for (const r of rows) {
    lines.push(`| ${r.label} | ${cell(r.oldResonator, r.resonator)} | ${cell(r.oldResonator, r.aips)} | ${cell(r.oldResonator, r.lsbu)} |`);
  }
  return lines.join("\n");
}

const FACTION_TIERS = ["normal", "commander", "officer"];
const FACTION_BANDS = ["frigate", "cruiser", "battleship"];
const WRECK_SECONDS = 10;
const HOUR_SECONDS = 3600;

function simulateFaction(settings, data, { wrecks = 10000, seed = 99 } = {}) {
  const rng = makeRng(seed);
  const s = { ...settings, factionLootEnabled: true };
  const deps = { settings: s, data, rng, nowMs: 0, caps: { take: () => true },
    getItemType: (typeID) => ({ typeID, name: String(typeID) }),
    buildCopyState: (spec) => ({ runsRemaining: spec.runsRemaining, original: false }) };
  const call = { lootTable: null, options: { source: { npcTypeID: 1 } }, vendorEntries: [] };
  const rows = [];
  for (const f of data.factions.values()) {
    for (const tier of FACTION_TIERS) {
      for (const band of FACTION_BANDS) {
        const resolved = { factionID: f.factionID, band, tier, size: FL.SIZE_OF_BAND[band], via: "group" };
        const hits = { uncommon: 0, rare: 0, epic: 0 };
        for (let i = 0; i < wrecks; i += 1) {
          const out = FL.rollFactionLoot(call, { ...deps, resolved });
          if (!out.ok) throw new Error(`${f.key} ${tier} ${band}: ${out.reason} ${out.detail || ""}`);
          for (const r of Object.keys(hits)) if (out.drops.some((d) => d.rarity === r)) hits[r] += 1;
        }
        const share = (n) => n / wrecks;
        rows.push({ faction: f.key, tier, band, uncommon: share(hits.uncommon), rare: share(hits.rare), epic: share(hits.epic),
          epicPerHour: share(hits.epic) * (HOUR_SECONDS / WRECK_SECONDS) });
      }
    }
  }
  return rows;
}

function formatFactionTable(rows) {
  const p = (x) => `${(x * 100).toFixed(2)}%`;
  const lines = ["| faction | tier | hull | wreck with uncommon | wreck with rare | wreck with epic | epic/h at 1 wreck/10 s |",
    "|---|---|---|---|---|---|---|"];
  for (const r of rows) lines.push(`| ${r.faction} | ${r.tier} | ${r.band} | ${p(r.uncommon)} | ${p(r.rare)} | ${p(r.epic)} | ${r.epicPerHour.toFixed(2)} |`);
  return lines.join("\n");
}

function argOf(name, fallback) {
  const i = process.argv.indexOf(name);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
}

function readSettingsFile(modDir) {
  try { return JSON.parse(fs.readFileSync(path.join(modDir, "settings.json"), "utf8")) || {}; } catch (_error) { return {}; }
}

function mainFaction(modDir) {
  const settings = mergeSettings(readSettingsFile(modDir));
  const valid = FL.validateSettings({ ...settings, factionLootEnabled: true });
  if (!valid.ok) throw new Error(`settings: ${valid.reason} ${valid.detail || ""}`);
  const loaded = FL.loadData(JSON.parse(fs.readFileSync(path.join(modDir, "data", "factionLoot.json"), "utf8")));
  if (!loaded.ok) throw new Error(`data file: ${loaded.reason} ${loaded.detail || ""}`);
  const wrecks = argOf("--wrecks", 10000);
  const seed = argOf("--seed", 99);
  console.log(`faction loot: ${wrecks} simulated wrecks per row, seed ${seed}, raw chances (no caps, no filler)`);
  console.log(formatFactionTable(simulateFaction(settings, loaded.data, { wrecks, seed })));
}

function main() {
  const modDir = path.resolve(__dirname, "..");
  if (process.argv.includes("--faction")) return mainFaction(modDir);
  const file = readSettingsFile(modDir);
  const loaded = R.loadData(JSON.parse(fs.readFileSync(path.join(modDir, "data", "pirateNpcGroups.json"), "utf8")));
  if (!loaded.ok) throw new Error(`data file: ${loaded.reason} ${loaded.detail || ""}`);
  const ids = {
    resonatorTypeID: loaded.data.factions.get(SOURCE_FACTION_ID).resonatorTypeID,
    soeTypeID: loaded.data.factions.get(R.SOE_FACTION_ID).resonatorTypeID,
  };
  const settings = mergeSettings(file);
  const valid = R.validateSettings(settings);
  if (!valid.ok) throw new Error(`settings: ${valid.reason} ${valid.detail || ""}`);
  const wrecks = argOf("--wrecks", 1000000);
  const seed = argOf("--seed", 99);
  console.log(`${wrecks} simulated wrecks per row, seed ${seed}, SoE on (multiplier ${settings.soeChanceMultiplier})`);
  console.log(formatTable(simulate(settings, ids, { wrecks, seed })));
}

if (require.main === module) main();

module.exports = { simulate, formatTable, oldShare, makeRng, ROWS, OLD_BASELINE, simulateFaction, formatFactionTable,
  FACTION_TIERS, FACTION_BANDS };
