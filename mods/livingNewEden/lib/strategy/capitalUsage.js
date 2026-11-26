"use strict";

const { CAPITAL_HULL_GROUPS } = require("../fleets/schema");

const BATTLESHIP = "battleship";
const LEVELS = 4;

const TALLY_CODES = Object.freeze(["CAPITAL_NOT_AT_STATION", "CAPITAL_SKIPPED_ISK", "CAPITAL_LEVEL_GATED",
  "CAPITAL_ESCORT", "CAPITAL_ESCORT_NONE", "CAPITAL_ESCORT_ISK", "CAPITAL_ESCORT_RESOURCES", "CAPITAL_REPLENISH",
  "CAPITAL_REPLENISH_NO_STOCK", "LADDER_WAIT_BUFFER", "LADDER_SAVING", "LADDER_FULL", "LADDER_PRODUCE",
  "LADDER_FEE_SHORT", "LADDER_FEE_UNREACHABLE", "LADDER_NO_SITE", "ESCALATION_L1", "ESCALATION_L2", "ESCALATION_L3",
  "ESCALATION_FALLBACK", "PRODUCTION_POOL_CAP"]);
const TALLY_SET = new Set(TALLY_CODES);

const nat = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const codeOf = (note) => (typeof note === "string" ? note.split(":")[0] : null);
const isCapital = (e) => Boolean(e) && CAPITAL_HULL_GROUPS.includes(e.hullGroup);

function mobilizesOf(applied) {
  const out = [];
  for (const i of applied) {
    if (!i || typeof i !== "object") continue;
    if (i.type === "MOBILIZE") out.push(i);
    else if (i.type === "LAUNCH" && Array.isArray(i.mobilize)) out.push(...i.mobilize.filter((m) => m));
  }
  return out;
}

function inventoryOf(snapshot) {
  const out = { battleshipStock: 0, battleshipFleets: 0, capitalStock: 0, capitalFleets: 0 };
  if (!snapshot || typeof snapshot !== "object") return out;
  const pr = snapshot.production;
  for (const s of pr && Array.isArray(pr.stations) ? pr.stations : []) {
    const h = s && s.hulls && typeof s.hulls === "object" ? s.hulls : {};
    out.battleshipStock += nat(h[BATTLESHIP]);
    for (const c of CAPITAL_HULL_GROUPS) out.capitalStock += nat(h[c]);
  }
  for (const f of Array.isArray(snapshot.fleets) ? snapshot.fleets : []) {
    for (const e of f && Array.isArray(f.composition) ? f.composition : []) {
      if (!e) continue;
      if (e.hullGroup === BATTLESHIP) out.battleshipFleets += nat(e.count);
      else if (isCapital(e)) out.capitalFleets += nat(e.count);
    }
  }
  return out;
}

const freezeUsage = (u) => Object.freeze({ ...u, notes: Object.freeze({ ...u.notes }),
  levels: Object.freeze([...u.levels]), ladder: u.ladder ? Object.freeze({ ...u.ladder }) : null,
  inventory: u.inventory ? Object.freeze({ ...u.inventory }) : null });

function tallyReview(prev, review) {
  const r = review && typeof review === "object" ? review : {};
  const at = Number.isSafeInteger(r.at) ? r.at : 0;
  const p = prev && typeof prev === "object" ? prev : null;
  const u = { since: p ? p.since : at, reviews: (p ? p.reviews : 0) + 1, notes: p ? { ...p.notes } : {},
    attached: p ? p.attached : 0, escorts: p ? p.escorts : 0, replenished: p ? p.replenished : 0,
    gated: p ? p.gated : 0, levels: p ? [...p.levels] : new Array(LEVELS).fill(0), ladder: null, inventory: null };
  const seen = new Set();
  for (const n of Array.isArray(r.notes) ? r.notes : []) {
    const c = codeOf(n);
    if (c !== null && TALLY_SET.has(c)) seen.add(c);
  }
  for (const c of seen) u.notes[c] = (u.notes[c] || 0) + 1;
  const applied = Array.isArray(r.applied) ? r.applied : [];
  for (const m of mobilizesOf(applied)) {
    const comp = Array.isArray(m.composition) ? m.composition : [];
    if (comp.some(isCapital)) {
      u.attached += 1;
      if (comp.length === 1 && comp[0].count === 1) u.escorts += 1;
    } else if (m.capitalGated === true) u.gated += 1;
    const L = m.escalationLevel;
    if (Number.isSafeInteger(L) && L >= 0 && L < LEVELS) u.levels[L] += 1;
  }
  for (const i of applied) if (i && i.type === "REPLENISH" && i.capital === true) u.replenished += 1;
  const l = r.ladder && typeof r.ladder === "object" ? r.ladder : null;
  if (l) {
    u.ladder = { note: typeof l.note === "string" ? l.note : null, cls: typeof l.cls === "string" ? l.cls : null,
      bufferPermille: Number.isSafeInteger(l.bufferPermille) ? l.bufferPermille : null, at };
  }
  const inv = r.inventory && typeof r.inventory === "object" ? r.inventory : null;
  if (inv) {
    u.inventory = { battleshipStock: nat(inv.battleshipStock), battleshipFleets: nat(inv.battleshipFleets),
      capitalStock: nat(inv.capitalStock), capitalFleets: nat(inv.capitalFleets), at };
  }
  return freezeUsage(u);
}

module.exports = { TALLY_CODES, tallyReview, inventoryOf };
