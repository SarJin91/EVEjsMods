"use strict";

function isForeignBastion(snapshot, systemId) {
  const m = snapshot && snapshot.bastionOwners instanceof Map ? snapshot.bastionOwners : null;
  if (m === null || !m.has(systemId)) return false;
  return m.get(systemId) !== snapshot.factionId;
}

module.exports = { isForeignBastion };
