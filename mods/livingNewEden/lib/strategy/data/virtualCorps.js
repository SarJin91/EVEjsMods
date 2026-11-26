"use strict";

const VIRTUAL_CORPS_VERSION = 3;

const roleSlots = Object.freeze({
  default: 0,
  mining: 1,
  logistics: 1,
  salvage: 1,
});

const FACTIONS = Object.freeze([
  {
    id: 500019, name: "Sansha's Nation", ticker: "SANS", kind: "pirate",
    alliance: { name: "Kuvakei Dominion", ticker: "KUVAD" },
    corporations: [
      { name: "True Slaves Vanguard", ticker: "TSVG" },
      { name: "Nation Reclamation", ticker: "NRCL" },
    ],
    raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5,
  },
  {
    id: 500010, name: "Guristas Pirates", ticker: "GURI", kind: "pirate",
    alliance: { name: "Guristas Free Fleet", ticker: "GURFF" },
    corporations: [
      { name: "Pith Raiders", ticker: "PITHR" },
      { name: "Venal Shadow Company", ticker: "VSHC" },
    ],
    raceId: 1, bloodlineIds: [1, 2, 11], securityRating: -5,
  },
  {
    id: 500011, name: "Angel Cartel", ticker: "ANGEL", kind: "pirate",
    alliance: { name: "Cartel Dominion", ticker: "ANGLD" },
    corporations: [
      { name: "Domination Wing", ticker: "DOMW" },
      { name: "Curse Salvage Syndicate", ticker: "CSSY" },
    ],
    raceId: 2, bloodlineIds: [3, 4, 14], securityRating: -5,
  },
  {
    id: 500012, name: "Blood Raider Covenant", ticker: "BLOOD", kind: "pirate",
    alliance: { name: "Covenant of Blood", ticker: "BLDCV" },
    corporations: [
      { name: "Sani Sabik Chapter", ticker: "SSCH" },
      { name: "Crimson Harvest", ticker: "CRHV" },
    ],
    raceId: 4, bloodlineIds: [5, 6, 13], securityRating: -5,
  },
  {
    id: 500020, name: "Serpentis Corporation", ticker: "SERP", kind: "pirate",
    alliance: { name: "Serpentis Holdings Coalition", ticker: "SERPH" },
    corporations: [
      { name: "Shadow Serpentis Division", ticker: "SSDV" },
      { name: "Fountain Logistics Group", ticker: "FLGP" },
    ],
    raceId: 8, bloodlineIds: [7, 8, 12], securityRating: -5,
  },
  {
    id: 500003, name: "Amarr Empire", ticker: "AMAR", kind: "empire",
    alliance: { name: "Amarr Frontier Command", ticker: "AMFC" },
    corporations: [
      { name: "Imperial Frontier Legion", ticker: "IFLG" },
      { name: "Holder Pacification Corps", ticker: "HPCP" },
    ],
    raceId: 4, bloodlineIds: [5, 6, 13], securityRating: 2,
  },
  {
    id: 500001, name: "Caldari State", ticker: "CALD", kind: "empire",
    alliance: { name: "Caldari Frontier Directorate", ticker: "CFDR" },
    corporations: [
      { name: "State Expeditionary Group", ticker: "SEXG" },
      { name: "Frontier Enforcement Bureau", ticker: "FEBU" },
    ],
    raceId: 1, bloodlineIds: [1, 2, 11], securityRating: 2,
  },
  {
    id: 500002, name: "Minmatar Republic", ticker: "MINM", kind: "empire",
    alliance: { name: "Republic Frontier Tribes", ticker: "RFTR" },
    corporations: [
      { name: "Tribal Vanguard", ticker: "TRVG" },
      { name: "Freedom Fleet Expedition", ticker: "FFEX" },
    ],
    raceId: 2, bloodlineIds: [3, 4, 14], securityRating: 2,
  },
  {
    id: 500004, name: "Gallente Federation", ticker: "GALL", kind: "empire",
    alliance: { name: "Federal Frontier Authority", ticker: "FFAU" },
    corporations: [
      { name: "Federal Expeditionary Force", ticker: "FEXF" },
      { name: "Frontier Liberty Group", ticker: "FLIB" },
    ],
    raceId: 8, bloodlineIds: [7, 8, 12], securityRating: 2,
  },
  {
    id: 500016, name: "Sisters of EVE", ticker: "SOE", kind: "neutral",
    alliance: { name: "Sisters Relief Coalition", ticker: "SOERC" },
    corporations: [
      { name: "Sanctuary Rescue Wing", ticker: "SANRW" },
      { name: "Food Relief Logistics", ticker: "FRLOG" },
    ],
    raceId: 8, bloodlineIds: [7, 8, 12], securityRating: 2,
  },
]);

const BY_ID = new Map(FACTIONS.map((f) => [f.id, f]));

function getFactions() {
  return FACTIONS;
}

function getById(id) {
  return BY_ID.get(id);
}

function isQualifying(id) {
  return BY_ID.has(id);
}

function validateData() {
  const tickers = new Set();
  const errors = [];
  for (const f of FACTIONS) {
    const t = f.alliance?.ticker || "";
    if (!/^[A-Z0-9]{2,5}$/.test(t)) {
      errors.push(`faction ${f.id}: alliance ticker "${t}" invalid (2-5 chars [A-Z0-9])`);
    }
    if (tickers.has(t)) {
      errors.push(`faction ${f.id}: alliance ticker "${t}" duplicate`);
    }
    tickers.add(t);
    if (f.alliance?.name && f.alliance.name.length > 50) {
      errors.push(`faction ${f.id}: alliance name > 50 chars`);
    }
    for (const c of f.corporations || []) {
      if (!/^[A-Z0-9]{2,5}$/.test(c.ticker || "")) {
        errors.push(`faction ${f.id}: corp ticker "${c.ticker}" invalid`);
      }
      if (tickers.has(c.ticker)) {
        errors.push(`faction ${f.id}: corp ticker "${c.ticker}" duplicate`);
      }
      tickers.add(c.ticker);
      if (c.name && c.name.length > 50) {
        errors.push(`faction ${f.id}: corp name > 50 chars`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  FACTIONS,
  getFactions,
  getById,
  isQualifying,
  validateData,
  VIRTUAL_CORPS_VERSION,
  roleSlots,
};