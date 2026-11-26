"use strict";

const { IDENTITY_STATES } = require("./schema");

function buildVirtualCorpsView(deps) {
  const { virtualCorps, strategy, config } = deps;
  const adapterNames = deps.factionNames;

  return {
    title: "Virtual Corporations",
    order: 200,
    cacheKey() {
      if (!virtualCorps) return "unavailable";
      if (typeof virtualCorps.getMapVersion !== "function") return "unavailable";
      return `vc-v${virtualCorps.getMapVersion()}`;
    },
    getData() {

      if (!virtualCorps || typeof virtualCorps.listIdentities !== "function") {
        return { available: false, reason: "virtualCorps module not running" };
      }

      const identities = virtualCorps.listIdentities();
      if (!identities || identities.length === 0) {
        return { available: true, rows: [], message: "No virtual identities created yet" };
      }

      const byFaction = new Map();
      for (const row of identities) {
        if (row.owner_kind !== "faction") continue;
        if (row.state === IDENTITY_STATES.RELEASED) continue;
        const factionId = row.owner_id;
        if (!byFaction.has(factionId)) {
          byFaction.set(factionId, { alliance: null, corporations: [], characters: [] });
        }
        const factionData = byFaction.get(factionId);
        if (row.kind === "alliance") {
          factionData.alliance = row;
        } else if (row.kind === "corporation") {
          factionData.corporations.push(row);
        } else if (row.kind === "character") {
          factionData.characters.push(row);
        }
      }

      const configNames = new Map();
      if (config && config.virtualCorps && Array.isArray(config.virtualCorps.factions)) {
        for (const fc of config.virtualCorps.factions) {
          if (fc && fc.name) configNames.set(fc.id, fc.name);
        }
      }
      const factionNames = new Map();
      for (const factionId of byFaction.keys()) {
        let name = adapterNames instanceof Map ? adapterNames.get(factionId) : undefined;
        if (!name && strategy && typeof strategy.registry?.getFaction === "function") {
          const f = strategy.registry.getFaction(factionId);
          if (f && f.name) name = f.name;
        }
        if (!name) name = configNames.get(factionId);
        if (name) factionNames.set(factionId, name);
      }

      const rows = [];
      for (const [factionId, data] of byFaction.entries()) {
        const factionName = factionNames.get(factionId) || `Faction ${factionId}`;

        let allianceName = "-";
        let allianceTicker = "-";
        let allianceId = "-";
        let allianceState = "-";
        if (data.alliance) {
          allianceName = data.alliance.name || "-";
          allianceTicker = data.alliance.ticker || "-";
          allianceId = data.alliance.evejs_id || "-";
          allianceState = data.alliance.state || "-";
        }

        const corpNames = data.corporations.map(c => c.name || "-").join(", ") || "-";
        const corpTickers = data.corporations.map(c => c.ticker || "-").join(", ") || "-";
        const corpIds = data.corporations.map(c => c.evejs_id || "-").join(", ") || "-";
        const corpStates = data.corporations.map(c => c.state || "-").join(", ") || "-";

        const charCount = data.characters.length;
        const charLinked = data.characters.filter(c => c.state === IDENTITY_STATES.LINKED).length;

        const states = [
          data.alliance?.state,
          ...data.corporations.map(c => c.state),
        ].filter(Boolean);
        let overallState = IDENTITY_STATES.PLANNED;
        if (states.every(s => s === IDENTITY_STATES.LINKED)) overallState = IDENTITY_STATES.LINKED;
        else if (states.some(s => s === IDENTITY_STATES.REFUSED)) overallState = IDENTITY_STATES.REFUSED;
        else if (states.some(s => s === IDENTITY_STATES.CREATED)) overallState = IDENTITY_STATES.CREATED;
        else if (states.some(s => s === IDENTITY_STATES.RESERVED)) overallState = IDENTITY_STATES.RESERVED;

        const refused = [...(data.alliance ? [data.alliance] : []), ...data.corporations]
          .find(r => r.state === IDENTITY_STATES.REFUSED);
        const reason = refused?.reason || (overallState === IDENTITY_STATES.LINKED ? "OK" : overallState);

        rows.push({
          factionId,
          faction: factionName,
          alliance: `${allianceName} [${allianceTicker}] ${allianceId}`,
          allianceState,
          corporations: `${corpNames} [${corpTickers}] ${corpIds}`,
          corporationStates: corpStates,
          characters: `${charLinked}/${charCount} LINKED`,
          state: overallState,
          reason,
        });
      }

      rows.sort((a, b) => a.factionId - b.factionId);

      return { available: true, rows };
    },
  };
}

module.exports = { buildVirtualCorpsView };