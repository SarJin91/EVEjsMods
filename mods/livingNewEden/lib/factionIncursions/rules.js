// Port with changes of EveJS 261108.1 incursionSiteModel.js (AGPL-3.0-only, see CREDITS.md): keyValid, validateCondition, the prerequisite cycles and the unfinishable stage of validatePolicy, condition, refresh and the receipt rule of recordObjective.

"use strict";

const MAX_STAGES = 16;
const MAX_SLOTS = 8;
const MAX_CHILDREN = 64;
const MAX_DEPTH = 32;
const CONDITION_BUDGET = 512;
const MILLI_MAX = 1000;
const HQ_UNLOCK = "hqUnlock";
const STAGE_KEY_RE = /^[A-Za-z0-9_.#-]{1,32}$/;
const OBJECTIVE_RE = /^clears:([A-Za-z0-9_.#-]{1,32}):([1-9][0-9]{0,5})$/;
const RESERVED = Object.freeze(["__proto__", "prototype", "constructor"]);

class RulesError extends Error {
  constructor(reason, detail) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

const has = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);
const keyValid = (value) => typeof value === "string" && !RESERVED.includes(value) && STAGE_KEY_RE.test(value);
const isMilli = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MILLI_MAX;

function parseObjective(text) {
  const m = typeof text === "string" ? OBJECTIVE_RE.exec(text) : null;
  return m ? { stageKey: m[1], count: Number(m[2]) } : null;
}

function validateCondition(cond, stageKeys, depth, budget) {
  budget.left -= 1;
  if (depth > MAX_DEPTH || budget.left < 0) throw new RulesError("RULES_INVALID", "condition depth");
  if (!cond || typeof cond !== "object" || Array.isArray(cond)) throw new RulesError("RULES_INVALID", "condition");
  const keys = Object.keys(cond);
  if (keys.length !== 1) throw new RulesError("RULES_INVALID", "condition keys");
  if (has(cond, "all") || has(cond, "any")) {
    const children = cond.all || cond.any;
    if (!Array.isArray(children) || children.length === 0 || children.length > MAX_CHILDREN) {
      throw new RulesError("RULES_INVALID", "condition children");
    }
    for (const child of children) validateCondition(child, stageKeys, depth + 1, budget);
  } else if (has(cond, "stage")) {
    if (!stageKeys.has(cond.stage)) throw new RulesError("RULES_INVALID", `unknown stage ${cond.stage}`);
  } else if (has(cond, "objective")) {
    const o = parseObjective(cond.objective);
    if (!o || !stageKeys.has(o.stageKey)) throw new RulesError("RULES_INVALID", `objective ${cond.objective}`);
  } else if (has(cond, "influenceAtLeast")) {
    if (cond.influenceAtLeast !== HQ_UNLOCK && !isMilli(cond.influenceAtLeast)) {
      throw new RulesError("RULES_INVALID", "influenceAtLeast");
    }
  } else throw new RulesError("RULES_INVALID", `leaf ${keys[0]}`);
}

function stageRefsOf(cond) {
  if (!cond || typeof cond !== "object") return [];
  if (Array.isArray(cond.all) || Array.isArray(cond.any)) return (cond.all || cond.any).flatMap(stageRefsOf);
  if (typeof cond.stage === "string") return [cond.stage];
  const o = parseObjective(cond.objective);
  return o ? [o.stageKey] : [];
}

function objectivesOf(cond) {
  if (!cond || typeof cond !== "object") return [];
  if (Array.isArray(cond.all) || Array.isArray(cond.any)) return (cond.all || cond.any).flatMap(objectivesOf);
  const o = parseObjective(cond.objective);
  return o ? [o] : [];
}

function validateOrThrow(policy) {
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.stages) || policy.stages.length === 0
    || policy.stages.length > MAX_STAGES) {
    throw new RulesError("RULES_INVALID", "stages");
  }
  const stageKeys = new Set();
  for (const stage of policy.stages) {
    if (!stage || !keyValid(stage.key) || stageKeys.has(stage.key) || !Array.isArray(stage.prerequisites)
      || typeof stage.repeat !== "boolean" || !Number.isSafeInteger(stage.slots) || stage.slots < 0
      || stage.slots > MAX_SLOTS || (stage.unlock !== null && (typeof stage.unlock !== "object" || !stage.unlock))) {
      throw new RulesError("RULES_INVALID", `stage ${stage && stage.key}`);
    }
    stageKeys.add(stage.key);
  }
  const byKey = new Map(policy.stages.map((s) => [s.key, s]));
  for (const stage of policy.stages) {
    if (stage.prerequisites.some((k) => !stageKeys.has(k) || k === stage.key)) {
      throw new RulesError("RULES_INVALID", `prerequisites ${stage.key}`);
    }
    if (stage.unlock !== null) validateCondition(stage.unlock, stageKeys, 0, { left: CONDITION_BUDGET });
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (key) => {
    if (visiting.has(key)) throw new RulesError("RULES_CYCLE", key);
    if (visited.has(key)) return;
    visiting.add(key);
    const stage = byKey.get(key);
    for (const parent of [...stage.prerequisites, ...stageRefsOf(stage.unlock)]) visit(parent);
    visiting.delete(key);
    visited.add(key);
  };
  for (const stage of policy.stages) visit(stage.key);
  validateCondition(policy.completion, stageKeys, 0, { left: CONDITION_BUDGET });
  const referenced = new Set([...policy.stages.flatMap((s) => [...s.prerequisites, ...stageRefsOf(s.unlock)]),
    ...stageRefsOf(policy.completion)]);
  for (const key of referenced) {
    if (byKey.get(key).slots < 1) throw new RulesError("RULES_UNFINISHABLE", key);
  }
  for (const o of [...objectivesOf(policy.completion), ...policy.stages.flatMap((s) => objectivesOf(s.unlock))]) {
    const stage = byKey.get(o.stageKey);
    if (stage.slots < 1 || (!stage.repeat && o.count > stage.slots)) {
      throw new RulesError("RULES_UNFINISHABLE", `clears:${o.stageKey}:${o.count}`);
    }
  }
}

function validateRules(policy) {
  try {
    validateOrThrow(policy);
    return { ok: true };
  } catch (err) {
    if (err instanceof RulesError) return { ok: false, reason: err.reason, detail: String(err.detail) };
    return { ok: false, reason: "RULES_INVALID", detail: String((err && err.message) || err) };
  }
}

function createProgress(policy) {
  const stages = {};
  for (const stage of policy.stages) stages[stage.key] = { active: false, completed: false, clears: 0 };
  return { stages, receipts: {} };
}

function cloneProgress(progress) {
  const stages = {};
  for (const [key, s] of Object.entries((progress && progress.stages) || {})) {
    stages[key] = { active: s.active === true, completed: s.completed === true,
      clears: Number.isSafeInteger(s.clears) ? s.clears : 0 };
  }
  return { stages, receipts: { ...((progress && progress.receipts) || {}) } };
}

function condition(progress, policy, cond, facts) {
  if (!cond || typeof cond !== "object") return false;
  if (Array.isArray(cond.all)) return cond.all.every((c) => condition(progress, policy, c, facts));
  if (Array.isArray(cond.any)) return cond.any.some((c) => condition(progress, policy, c, facts));
  const stages = (progress && progress.stages) || {};
  if (typeof cond.stage === "string") return has(stages, cond.stage) && stages[cond.stage].completed === true;
  if (typeof cond.objective === "string") {
    const o = parseObjective(cond.objective);
    return Boolean(o && has(stages, o.stageKey) && stages[o.stageKey].clears >= o.count);
  }
  if (has(cond, "influenceAtLeast")) {
    const f = facts || {};
    const threshold = cond.influenceAtLeast === HQ_UNLOCK ? f.hqUnlockMilli : cond.influenceAtLeast;
    return Number.isSafeInteger(threshold) && Number.isSafeInteger(f.influenceMilli) && f.influenceMilli >= threshold;
  }
  return false;
}

function refresh(progress, policy, facts) {
  const next = cloneProgress(progress);
  for (const stage of policy.stages) {
    if (!has(next.stages, stage.key)) next.stages[stage.key] = { active: false, completed: false, clears: 0 };
    const st = next.stages[stage.key];
    if (st.active) continue;
    if (stage.prerequisites.every((k) => has(next.stages, k) && next.stages[k].completed === true)
      && (stage.unlock === null || condition(next, policy, stage.unlock, facts))) {
      st.active = true;
    }
  }
  return next;
}

function recordClear(progress, policy, clear) {
  const c = clear || {};
  const stage = policy.stages.find((s) => s.key === c.stageKey);
  if (!stage || typeof c.receiptId !== "string" || c.receiptId === "") return { ok: false, reason: "UNKNOWN_STAGE" };
  const receipts = (progress && progress.receipts) || {};
  if (has(receipts, c.receiptId)) return { ok: true, progress, duplicate: true };
  const st = progress && progress.stages && progress.stages[stage.key];
  if (!st || st.active !== true) return { ok: false, reason: "STAGE_INACTIVE" };
  const max = Number.isSafeInteger(c.maxReceipts) ? c.maxReceipts : Number.MAX_SAFE_INTEGER;
  if (Object.keys(receipts).length >= max) return { ok: false, reason: "CLEARS_CAPPED" };
  const next = cloneProgress(progress);
  next.receipts[c.receiptId] = 1;
  next.stages[stage.key].clears += 1;
  next.stages[stage.key].completed = true;
  if (Number.isSafeInteger(c.maxJsonLength) && JSON.stringify(next).length > c.maxJsonLength) {
    return { ok: false, reason: "CLEARS_CAPPED" };
  }
  return { ok: true, progress: next, duplicate: false };
}

module.exports = { HQ_UNLOCK, keyValid, parseObjective, validateRules, createProgress, condition, refresh,
  recordClear };
