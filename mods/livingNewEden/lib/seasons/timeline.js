"use strict";

const { STATE } = require("./schema");

function planSeason(p) {
  const startsAt = p.now + p.startDelayMs;
  const endsAt = startsAt + p.durationMs;
  const row = { startsAt, endsAt, stageCount: p.stageCount };
  return { startsAt, endsAt, stageCount: p.stageCount, stageDueAt: stageBounds(row)[0] };
}

function stageBounds(row) {
  const span = row.endsAt - row.startsAt;
  const out = [];
  for (let k = 1; k < row.stageCount; k += 1) out.push(row.startsAt + Math.floor((k * span) / row.stageCount));
  return out;
}

function stageAt(row, at) {
  const last = row.stageCount - 1;
  if (at < row.startsAt) return { phase: "BEFORE", stage: 0, final: false, nextAt: row.startsAt };
  if (at >= row.endsAt) return { phase: "END", stage: last, final: true, nextAt: row.endsAt };
  const bounds = stageBounds(row);
  const stage = bounds.filter((b) => b <= at).length;
  return { phase: "STAGE", stage, final: stage === last, nextAt: stage < bounds.length ? bounds[stage] : row.endsAt };
}

function nextDueOf(row) {
  if (!row) return null;
  if (row.state === STATE.PLANNED) return row.startsAt;
  if (row.state === STATE.ACTIVE) return row.stageDueAt;
  if (row.state === STATE.FINALE) return row.endsAt;
  return null;
}

module.exports = { planSeason, stageBounds, stageAt, nextDueOf };
