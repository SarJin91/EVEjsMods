"use strict";

const BANDS = ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "capital", "hauler"];
const TIERS = ["normal", "elite"];
const CTR_BANDS = ["battleship", "capital"];
const SOE_FACTION_ID = 500016;
const COMPONENTS = { aips: 57478, lsbu: 57486, ctr: 57479 };

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const posInt = (v) => Number.isInteger(v) && v > 0;
const isChance = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isNonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function loadData(json) {
  const bad = (detail) => ({ ok: false, reason: "BAD_DATA", detail });
  if (!isObj(json) || json.schemaVersion !== 1) return bad("schemaVersion must be 1");
  if (!isObj(json.factions) || !Array.isArray(json.groups)) return bad("factions/groups missing");
  const factions = new Map();
  for (const [key, row] of Object.entries(json.factions)) {
    const factionID = Number(key);
    if (!posInt(factionID) || !isObj(row) || !posInt(row.resonatorTypeID)) return bad(`faction ${key}`);
    factions.set(factionID, { resonatorTypeID: row.resonatorTypeID, label: String(row.label || key) });
  }
  const groups = new Map();
  for (const row of json.groups) {
    if (!isObj(row) || !posInt(row.groupID)) return bad("group without groupID");
    if (groups.has(row.groupID)) return bad(`duplicate group ${row.groupID}`);
    if (!factions.has(row.factionID)) return bad(`group ${row.groupID}: unknown faction ${row.factionID}`);
    if (!BANDS.includes(row.band) || !TIERS.includes(row.tier)) return bad(`group ${row.groupID}: band/tier`);
    groups.set(row.groupID, { groupID: row.groupID, factionID: row.factionID, band: row.band, tier: row.tier });
  }
  return { ok: true, data: { groups, factions } };
}

function validateSettings(s) {
  const bad = (detail) => ({ ok: false, reason: "BAD_CONFIG", detail });
  if (!isObj(s)) return bad("settings missing");
  if (!isObj(s.resonatorChance) || !isObj(s.resonatorQuantity)) return bad("resonatorChance/resonatorQuantity");
  for (const band of BANDS) {
    if (!isChance(s.resonatorChance[band])) return bad(`resonatorChance.${band}`);
    const q = s.resonatorQuantity[band];
    if (!Array.isArray(q) || q.length !== 2 || !Number.isInteger(q[0]) || !Number.isInteger(q[1]) || q[0] < 0 || q[0] > q[1]) {
      return bad(`resonatorQuantity.${band}`);
    }
  }
  if (!isChance(s.resonatorEliteChance)) return bad("resonatorEliteChance");
  if (!Number.isInteger(s.resonatorEliteQuantityMultiplier) || s.resonatorEliteQuantityMultiplier < 1) return bad("resonatorEliteQuantityMultiplier");
  if (!isChance(s.componentChance)) return bad("componentChance");
  if (!isNonNeg(s.componentAipsPerResonator)) return bad("componentAipsPerResonator");
  if (!isNonNeg(s.componentLsbuPerResonator)) return bad("componentLsbuPerResonator");
  if (!isObj(s.componentCtrChance)) return bad("componentCtrChance");
  for (const band of CTR_BANDS) if (!isChance(s.componentCtrChance[band])) return bad(`componentCtrChance.${band}`);
  if (!isChance(s.componentCtrEliteChance)) return bad("componentCtrEliteChance");
  if (!isNonNeg(s.soeChanceMultiplier)) return bad("soeChanceMultiplier");
  if (!Number.isInteger(s.resonatorSummaryEvery) || s.resonatorSummaryEvery < 0) return bad("resonatorSummaryEvery");
  return { ok: true, settings: s };
}

function resolveResonatorFlag(settings, env) {
  const raw = String(env && env.EVEJS_BPDROPS_RESONATORS_ENABLED || "").trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return !!(settings && settings.resonatorsEnabled === true);
}

function checkTypes(data, hasType) {
  const missing = [];
  for (const f of data.factions.values()) if (!hasType(f.resonatorTypeID)) missing.push(f.resonatorTypeID);
  if (missing.length) return { ok: false, reason: "MISSING_TYPE", detail: `resonators ${missing.join(",")}` };
  const missingComponents = Object.values(COMPONENTS).filter((id) => !hasType(id));
  return { ok: true, componentsOk: missingComponents.length === 0, missingComponents };
}

function resolveSource({ profileFactionID, npcGroupID } = {}, data) {
  if (!data) return null;
  const group = data.groups.get(Number(npcGroupID));
  if (!group) return null;
  const pf = Number(profileFactionID);
  const byProfile = pf > 0 && data.factions.has(pf);
  const factionID = byProfile ? pf : group.factionID;
  const faction = data.factions.get(factionID);
  if (!faction) return null;
  return { factionID, resonatorTypeID: faction.resonatorTypeID, band: group.band, tier: group.tier, via: byProfile ? "profile" : "group" };
}

const randInt = (min, max, rng) => min + Math.min(max - min, Math.floor(rng() * (max - min + 1)));

function roundRandom(x, rng) {
  const whole = Math.floor(x);
  const frac = x - whole;
  return frac > 0 && rng() < frac ? whole + 1 : whole;
}

function rollResonators(source, settings, rng, opts = {}) {
  if (!source || !BANDS.includes(source.band)) return [];
  const elite = source.tier === "elite";
  const baseChance = elite ? settings.resonatorEliteChance : settings.resonatorChance[source.band];
  const [min, max] = settings.resonatorQuantity[source.band];
  const mult = elite ? settings.resonatorEliteQuantityMultiplier : 1;
  const rollOne = (chance) => {
    if (!(chance > 0) || rng() >= chance) return 0;
    return randInt(min, max, rng) * mult;
  };
  const out = [];
  let units = 0;
  const q = rollOne(baseChance);
  if (q > 0) { out.push({ typeID: source.resonatorTypeID, quantity: q }); units += q; }
  const soeTypeID = opts.soeTypeID;
  if (settings.soeFromAllPirates && soeTypeID && source.factionID !== SOE_FACTION_ID) {
    const qs = rollOne(Math.min(1, baseChance * settings.soeChanceMultiplier));
    if (qs > 0) { out.push({ typeID: soeTypeID, quantity: qs }); units += qs; }
  }
  if (units > 0 && settings.resonatorComponentsEnabled && opts.componentsOk !== false) {
    const chance = settings.componentChance;
    if (chance > 0 && rng() < chance) {
      const aips = roundRandom(units * settings.componentAipsPerResonator, rng);
      const lsbu = roundRandom(units * settings.componentLsbuPerResonator, rng);
      if (aips > 0) out.push({ typeID: COMPONENTS.aips, quantity: aips });
      if (lsbu > 0) out.push({ typeID: COMPONENTS.lsbu, quantity: lsbu });
    }
    if (CTR_BANDS.includes(source.band)) {
      const bandCtr = settings.componentCtrChance[source.band];
      const ctrChance = elite ? Math.max(settings.componentCtrEliteChance, bandCtr) : bandCtr;
      if (ctrChance > 0 && rng() < ctrChance) out.push({ typeID: COMPONENTS.ctr, quantity: 1 });
    }
  }
  return out;
}

function startupState(settings, resonatorData) {
  if (!settings || settings.resonatorsEnabled !== true) return { on: false, reason: "DISABLED" };
  if (!resonatorData || !resonatorData.ok) {
    return { on: false, reason: "BAD_DATA", detail: String(resonatorData && resonatorData.detail || "data missing") };
  }
  const valid = validateSettings(settings);
  if (!valid.ok) return { on: false, reason: "BAD_CONFIG", detail: valid.detail };
  return { on: true };
}

function startupReport(settings, resonatorData) {
  const failed = (error) => ({ on: false, reason: "INIT_FAILED", detail: String(error && error.message || error) });
  const offLine = (s) => (s.reason === "DISABLED" ? "resonators: off" : `resonators: off (${s.reason}: ${s.detail})`);
  let start;
  try {
    start = startupState(settings, resonatorData);
  } catch (error) {
    start = failed(error);
  }
  let line;
  try {
    line = start.on
      ? `resonators: on (groups=${resonatorData.data.groups.size}, factions=${resonatorData.data.factions.size}, soeFromAllPirates=${settings.soeFromAllPirates ? "on" : "off"}, types checked at the first wreck)`
      : offLine(start);
  } catch (error) {
    start = failed(error);
    line = offLine(start);
  }
  return { start, line, forceOff: !start.on && start.reason !== "DISABLED" };
}

function buildWreckEntries(source, deps) {
  const none = { entries: [], resolved: null, rolled: [] };
  if (!source || !deps || !deps.data || !deps.itemTypes) return none;
  let profileFactionID = 0;
  if (source.profileID && typeof deps.getProfile === "function") {
    const profile = deps.getProfile(source.profileID);
    profileFactionID = Number(profile && profile.factionID) || 0;
  }
  const npcType = deps.itemTypes.get(Number(source.npcTypeID));
  const resolved = resolveSource({ profileFactionID, npcGroupID: npcType && npcType.groupID }, deps.data);
  if (!resolved) return none;
  const rolled = rollResonators(resolved, deps.settings, deps.rng, { soeTypeID: deps.soeTypeID, componentsOk: deps.componentsOk });
  const entries = [];
  for (const { typeID, quantity } of rolled) {
    const itemType = deps.itemTypes.get(typeID);
    if (!itemType) continue;
    entries.push({ itemType, typeID, name: itemType.name, quantity, singleton: false });
  }
  return { entries, resolved, rolled };
}

module.exports = {
  BANDS, TIERS, COMPONENTS, SOE_FACTION_ID,
  loadData, validateSettings, resolveResonatorFlag, checkTypes, resolveSource, rollResonators, roundRandom,
  startupState, startupReport, buildWreckEntries,
};
