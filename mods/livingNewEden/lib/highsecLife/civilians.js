"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { CIVILIAN_OWNER_KIND, EMPIRE_RACE_FACTION_IDS, SECURITY_RATING_MIN, SECURITY_RATING_MAX } = require("./schema");
const { CIVILIAN_CORPS } = require("./data/civilianCorps");

function buildCivilianSpecs(input) {
  const slots = Number.isSafeInteger(input.slots) && input.slots > 0 ? input.slots : 0;
  const stations = Array.isArray(input.stations) ? input.stations : [];
  const bloodlines = [];
  for (const factionId of EMPIRE_RACE_FACTION_IDS) {
    const ids = input.bloodlinesOf(factionId);
    if (Array.isArray(ids)) for (const id of ids) if (Number.isSafeInteger(id) && id > 0) bloodlines.push(id);
  }
  const out = [];
  for (let slot = 1; slot <= slots; slot += 1) {
    const corp = CIVILIAN_CORPS[slot - 1];
    if (!corp) {
      out.push({ slot, ok: false, reason: "NO_CATALOGUE_ENTRY" });
      continue;
    }
    if (stations.length === 0) {
      out.push({ slot, ok: false, reason: "NO_STATION" });
      continue;
    }
    if (bloodlines.length === 0) {
      out.push({ slot, ok: false, reason: "NO_BLOODLINES" });
      continue;
    }
    const station = stations[Math.floor(((slot - 1) * stations.length) / slots)];
    const sys = input.getSystem(station.systemId);
    if (!sys) {
      out.push({ slot, ok: false, reason: "NO_SYSTEM" });
      continue;
    }
    const rng = createRng(deriveSeed(input.worldSeed >>> 0, "hs-civ-corp", slot));
    const offset = rng.nextInt(0, bloodlines.length - 1);
    const bloodlineIds = bloodlines.slice(offset).concat(bloodlines.slice(0, offset));
    out.push({ slot, ok: true, spec: {
      ownerKind: CIVILIAN_OWNER_KIND,
      ownerId: slot,
      corporation: { name: corp.name, ticker: corp.ticker, description: corp.description },
      members: input.members,
      stationId: station.stationId,
      stationCorporationId: station.corporationId,
      systemId: station.systemId,
      constellationId: sys.constellationId,
      regionId: sys.regionId,
      bloodlineIds,
      securityRating: rng.nextInt(SECURITY_RATING_MIN, SECURITY_RATING_MAX),
    } });
  }
  return out;
}

module.exports = { buildCivilianSpecs };
