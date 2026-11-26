"use strict";

function crewSummaryIn(getCrewSummary, tx, fleetIds) {
  if (typeof getCrewSummary !== "function" || !Array.isArray(fleetIds) || fleetIds.length === 0) return null;
  try {
    const m = getCrewSummary(tx, fleetIds);
    return m instanceof Map ? m : null;
  } catch (_err) {
    return null;
  }
}

function pilotsLine(crews, fleetId) {
  const c = crews ? crews.get(fleetId) : null;
  if (!c || !Array.isArray(c.names) || c.names.length === 0) return null;
  const more = Math.max(0, (Number(c.seated) || 0) - c.names.length);
  return `pilots: ${c.names.join(", ")}${more > 0 ? ` +${more}` : ""}`;
}

function crewSuffix(crews, fleetId) {
  const c = crews ? crews.get(fleetId) : null;
  return c && Number(c.seated) > 0 ? ` - crew ${c.seated}` : "";
}

module.exports = { crewSummaryIn, pilotsLine, crewSuffix };
