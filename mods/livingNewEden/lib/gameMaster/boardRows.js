"use strict";

const { SIGNATURE_EVENT_TYPES, byEndsThenRef, clip } = require("../events/boardRows");
const { STATE_THREAD, STEP_STATE } = require("./schema");

const SOURCE = "story";
const REF_PREFIX = "gm:";
const ROW_LEN = Object.freeze({ ref: 40, kind: 24, title: 80, state: 16 });
const ACTIVE_TEXT = "ACTIVE";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function rowOf(t) {
  const steps = t.plan && Array.isArray(t.plan.steps) ? t.plan.steps : [];
  const step = steps[t.stepNo] || null;
  const running = step !== null && t.stepState === STEP_STATE.RUNNING;
  const h = running && t.stepHandle && typeof t.stepHandle === "object" ? t.stepHandle : {};
  const site = running && step.kind === "SITE";
  const systemId = site && isId(h.systemId) ? h.systemId : t.anchorSystemId;
  const stepEnd = Number.isSafeInteger(h.expiresAt) ? h.expiresAt : (Number.isSafeInteger(h.dueAt) ? h.dueAt : null);
  return {
    ref: clip(`${REF_PREFIX}${t.threadId}`, ROW_LEN.ref),
    source: SOURCE,
    kind: clip(t.arc, ROW_LEN.kind),
    title: clip(t.plan && typeof t.plan.title === "string" && t.plan.title !== "" ? t.plan.title : t.arc,
      ROW_LEN.title),
    systemId,
    factionId: isId(t.factionId) ? t.factionId : null,
    level: null,
    scan: Boolean(site && step.params && SIGNATURE_EVENT_TYPES.includes(step.params.site)),
    rewardText: null,
    endsAt: stepEnd !== null ? stepEnd : (Number.isSafeInteger(t.deadlineAt) ? t.deadlineAt : null),
    state: clip(step ? step.kind : ACTIVE_TEXT, ROW_LEN.state),
  };
}

function threadRowsOf(threads, opts) {
  const ids = opts && opts.systemIds instanceof Set ? opts.systemIds : null;
  const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 1;
  const out = [];
  for (const t of Array.isArray(threads) ? threads : []) {
    if (!t || t.state !== STATE_THREAD.ACTIVE) continue;
    const row = rowOf(t);
    if (!isId(row.systemId) || (ids !== null && !ids.has(row.systemId))) continue;
    out.push(row);
  }
  out.sort(byEndsThenRef);
  return { rows: out.slice(0, limit), truncated: out.length > limit };
}

module.exports = { SOURCE, REF_PREFIX, threadRowsOf };
