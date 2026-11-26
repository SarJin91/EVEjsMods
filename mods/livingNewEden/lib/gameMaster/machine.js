"use strict";

const { STATE_THREAD, STEP_STATE, STEP_RESULT, OUTCOME } = require("./schema");

function outcomeOf(results) {
  const sites = (Array.isArray(results) ? results : []).filter((r) => r && r.kind === "SITE");
  if (sites.length === 0) return OUTCOME.NEUTRAL;
  const last = sites[sites.length - 1];
  if (last.state === STEP_RESULT.DONE && Object.values(OUTCOME).includes(last.outcome)) return last.outcome;
  return OUTCOME.LOST;
}

function nextThreadAction(row, now, registry) {
  if (!row || row.state !== STATE_THREAD.ACTIVE) return { action: "WAIT" };
  if (now >= row.deadlineAt) return { action: "EXPIRE" };
  const steps = row.plan && Array.isArray(row.plan.steps) ? row.plan.steps : [];
  if (row.stepState === STEP_STATE.PENDING && row.stepNo >= steps.length) {
    return { action: "END", outcome: outcomeOf(row.stepResults) };
  }
  const step = steps[row.stepNo];
  const kind = step ? registry.get(step.kind) : null;
  if (!step || !kind || kind.version !== step.version) return { action: "SKIP_KIND", step: step || null };
  if (now < row.stepDueAt) return { action: "WAIT" };
  return { action: row.stepState === STEP_STATE.RUNNING ? "POLL" : "START", kind, step };
}

module.exports = { nextThreadAction, outcomeOf };
