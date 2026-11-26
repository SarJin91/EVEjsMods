"use strict";

const { gridOfRef } = require("../battle/gridContacts");

const KIND_ANCHOR = "anchor";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function sentryAnchorRef(s) {
  if (!s || typeof s.anchorKind !== "string" || s.anchorKind.length === 0 || !isId(s.anchorId)) return null;
  return `${s.anchorKind}:${s.anchorId}`;
}

function sentryGridScopeOf(input) {
  const gridOfFleet = new Map();
  const gridOfSentry = new Map();
  let noAnchor = 0;
  const positions = input && input.positions instanceof Map ? input.positions : new Map();
  for (const [fleetId, pos] of positions) {
    gridOfFleet.set(fleetId, pos && pos.kind === KIND_ANCHOR && typeof pos.gridKey === "string" ? pos.gridKey : null);
  }
  const gridOf = gridOfRef(input && input.grids);
  for (const s of Array.isArray(input && input.sentries) ? input.sentries : []) {
    if (!s || typeof s.sentryId !== "string") continue;
    const ref = sentryAnchorRef(s);
    const g = ref === null ? undefined : gridOf.get(ref);
    const key = typeof g === "string" ? g : null;
    gridOfSentry.set(s.sentryId, key);
    if (key === null) noAnchor += 1;
  }
  return { gridOfFleet, gridOfSentry, noAnchor };
}

module.exports = { sentryGridScopeOf, sentryAnchorRef };
