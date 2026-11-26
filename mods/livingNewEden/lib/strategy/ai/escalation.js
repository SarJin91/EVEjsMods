"use strict";

const { ESCALATION_STEPS } = require("../data/escalation");
const { strengthOf } = require("./strength");

const MAX_LEVEL = 3;
const HOME_CATEGORY = "home";

const nonNegInt = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const LEVEL_ZERO = Object.freeze({ level: 0, pressure: 0, value: 0, losses: 0 });

function escalationLevelOf(input, p) {
  if (!input || typeof input !== "object" || !p || typeof p !== "object") return { ...LEVEL_ZERO };
  const L1 = nonNegInt(p.fleetsL1);
  const L2 = nonNegInt(p.fleetsL2);
  const L3 = nonNegInt(p.fleetsL3);
  const bonus = nonNegInt(p.valueBonus);
  const step = nonNegInt(p.lossStep);
  const maxLevel = nonNegInt(p.maxLevel);
  if (L1 === null || L2 === null || L3 === null || bonus === null || step === null || maxLevel === null) {
    return { ...LEVEL_ZERO };
  }
  const required = Number(input.required);
  const base = Number(input.baseStrength);
  if (!Number.isFinite(required) || required < 0 || !Number.isFinite(base)) return { ...LEVEL_ZERO };
  const need = base > 0 ? Math.ceil(required / base) : 1;
  const pressure = need >= L3 ? 3 : need >= L2 ? 2 : need >= L1 ? 1 : 0;
  const stations = Number(input.hostileStations);
  const value = input.category === HOME_CATEGORY || (Number.isFinite(stations) && stations > 0)
    || input.playerSystem === true ? bonus : 0;
  const lost = Number(input.losses);
  const losses = step > 0 && Number.isFinite(lost) ? Math.floor(Math.max(0, lost) / step) : 0;
  const level = Math.min(maxLevel, MAX_LEVEL, pressure + value + losses);
  return { level, pressure, value, losses };
}

function keyOf(template) {
  return JSON.stringify(template.map((e) => [String(e.hullGroup), Number(e.count)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])));
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function templateLadderWithDropsOf(doctrine, mobilizeRole, powerTable) {
  const templates = doctrine && doctrine.templates ? doctrine.templates : {};
  const steps = Object.prototype.hasOwnProperty.call(ESCALATION_STEPS, mobilizeRole)
    ? ESCALATION_STEPS[mobilizeRole] : null;
  if (!steps) return { ladder: [{ role: mobilizeRole, template: templates[mobilizeRole] }], dropped: 0 };
  const table = isPlainObject(powerTable) ? powerTable : null;
  const out = [];
  let lastKey = null;
  let lastStrength = 0;
  let dropped = 0;
  for (const s of steps) {
    const source = doctrine ? doctrine[s.source] : null;
    const template = source && typeof source === "object" ? source[s.role] : undefined;
    if (out.length === 0) {
      out.push({ role: s.role, template });
      lastKey = Array.isArray(template) ? keyOf(template) : null;
      lastStrength = table && Array.isArray(template) ? strengthOf(template, table) : 0;
      continue;
    }
    if (!Array.isArray(template) || template.length === 0) continue;
    const key = keyOf(template);
    if (key === lastKey) continue;
    const strength = table ? strengthOf(template, table) : 0;
    if (table && strength <= lastStrength) {
      dropped += 1;
      continue;
    }
    out.push({ role: s.role, template });
    lastKey = key;
    lastStrength = strength;
  }
  return { ladder: out, dropped };
}

function templateLadderOf(doctrine, mobilizeRole, powerTable) {
  return templateLadderWithDropsOf(doctrine, mobilizeRole, powerTable).ladder;
}

module.exports = { escalationLevelOf, templateLadderOf, templateLadderWithDropsOf };
