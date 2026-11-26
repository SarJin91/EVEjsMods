"use strict";

const { HASH_LIMITS, validateInput } = require("./contract");
const { LIVE_MEMBER_STATES, GARRISON_FLEET_ID, MAX_GARRISON_PROXIES } = require("./schema");
const { HULL_GROUPS_V1 } = require("../fleets/schema");

const GARRISON_HULL_GROUPS = Object.freeze(HULL_GROUPS_V1.filter((g) => g !== "industrial"));

const EXIT_REASONS = Object.freeze(["EXIT", "RESTART", "END", "STRUCTURE_DESTROYED"]);
const LIVE_SOURCE = "live";

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const typeOf = (typeId) => (typeId === null || typeId === undefined ? 0 : typeId);

function memberKeyOf(fleetId, hullGroup, typeId, ordinal) {
  return `${fleetId}:${hullGroup}:${typeOf(typeId)}:${ordinal}`;
}

function groupsOf(input) {
  const out = [];
  for (const [side, s] of [["A", input.sideA], ["B", input.sideB]]) {
    const fleets = [...s.fleets].sort((x, y) => (x.fleetId < y.fleetId ? -1 : x.fleetId > y.fleetId ? 1 : 0));
    for (const f of fleets) {
      const entries = [...f.composition].sort((x, y) => (x.hullGroup !== y.hullGroup
        ? (x.hullGroup < y.hullGroup ? -1 : 1) : typeOf(x.typeId) - typeOf(y.typeId)));
      for (const e of entries) {
        out.push({ side, factionId: s.factionId, fleetId: f.fleetId, hullGroup: e.hullGroup, typeId: e.typeId,
          count: e.count });
      }
    }
  }
  return out;
}

function planLiveMembers(input, opts) {
  if (!opts || typeof opts !== "object" || !Number.isSafeInteger(opts.maxShips) || opts.maxShips < 1) {
    return { ok: false, reason: "INPUT_INVALID", detail: "opts.maxShips" };
  }
  const valid = validateInput(input, HASH_LIMITS);
  if (!valid.ok) return { ok: false, reason: "INPUT_INVALID", detail: valid.detail };
  const groups = groupsOf(valid.input);
  let ships = 0;
  for (const g of groups) ships += g.count;
  if (ships > opts.maxShips) return { ok: false, reason: "LIVE_TOO_LARGE", ships, limit: opts.maxShips };
  const members = [];
  for (const g of groups) {
    for (let ordinal = 1; ordinal <= g.count; ordinal += 1) {
      members.push({ memberKey: memberKeyOf(g.fleetId, g.hullGroup, g.typeId, ordinal), fleetId: g.fleetId,
        side: g.side, factionId: g.factionId, hullGroup: g.hullGroup, typeId: g.typeId, ordinal });
    }
  }
  return { ok: true, members, ships };
}

function planGarrisonMembers(input, opts) {
  const invalidOpts = (detail) => ({ ok: false, reason: "INPUT_INVALID", detail: `opts.${detail}` });
  if (!opts || typeof opts !== "object") return invalidOpts("");
  if (!Number.isSafeInteger(opts.maxShips) || opts.maxShips < 0 || opts.maxShips > MAX_GARRISON_PROXIES) {
    return invalidOpts("maxShips");
  }
  if (!Number.isSafeInteger(opts.pointsPerShip) || opts.pointsPerShip < 1) return invalidOpts("pointsPerShip");
  if (!GARRISON_HULL_GROUPS.includes(opts.hullGroup)) return invalidOpts("hullGroup");
  if (!Number.isSafeInteger(opts.room) || opts.room < 0) return invalidOpts("room");
  const valid = validateInput(input, HASH_LIMITS);
  if (!valid.ok) return { ok: false, reason: "INPUT_INVALID", detail: valid.detail };
  const g = valid.input.garrison;
  if (g === null || g.strength === 0 || opts.maxShips === 0) return { ok: true, members: [], ships: 0 };
  const ships = Math.min(opts.maxShips, Math.ceil(g.strength / opts.pointsPerShip));
  if (ships > opts.room) return { ok: false, reason: "LIVE_TOO_LARGE", ships, limit: opts.room };
  const members = [];
  for (let ordinal = 1; ordinal <= ships; ordinal += 1) {
    members.push({ memberKey: memberKeyOf(GARRISON_FLEET_ID, opts.hullGroup, null, ordinal),
      fleetId: GARRISON_FLEET_ID, side: g.side, factionId: g.factionId, hullGroup: opts.hullGroup, typeId: null,
      ordinal });
  }
  return { ok: true, members, ships };
}

function splitMembers(members) {
  const fleet = [];
  const garrison = [];
  for (const m of Array.isArray(members) ? members : []) {
    (m && m.fleetId === GARRISON_FLEET_ID ? garrison : fleet).push(m);
  }
  return { fleet, garrison };
}

function garrisonProblem(input, proxies) {
  if (!Array.isArray(proxies)) return "garrison: proxies not an array";
  if (proxies.length === 0) return null;
  const g = input && typeof input === "object" ? input.garrison : null;
  if (!g || typeof g !== "object") return "garrison: proxies without a garrison";
  if (proxies.length > MAX_GARRISON_PROXIES) {
    return `garrison: ${proxies.length} proxies > ${MAX_GARRISON_PROXIES}`;
  }
  const hullGroup = proxies[0] && proxies[0].hullGroup;
  if (!GARRISON_HULL_GROUPS.includes(hullGroup)) return `garrison: hullGroup ${hullGroup}`;
  const ordinals = new Set();
  for (const p of proxies) {
    const where = `garrison member ${p && p.memberKey}`;
    if (!p || typeof p !== "object") return "garrison: member not an object";
    if (p.side !== g.side) return `${where}: side ${p.side} != ${g.side}`;
    if (p.factionId !== g.factionId) return `${where}: factionId ${p.factionId} != ${g.factionId}`;
    if (typeOf(p.typeId) !== 0) return `${where}: typeId ${p.typeId}`;
    if (p.hullGroup !== hullGroup) return `${where}: hullGroup ${p.hullGroup} != ${hullGroup}`;
    if (!Number.isSafeInteger(p.ordinal) || p.ordinal < 1 || p.ordinal > proxies.length || ordinals.has(p.ordinal)) {
      return `${where}: ordinal ${p.ordinal} not in 1..${proxies.length}`;
    }
    ordinals.add(p.ordinal);
    if (p.memberKey !== memberKeyOf(GARRISON_FLEET_ID, hullGroup, null, p.ordinal)) return `${where}: memberKey`;
  }
  return null;
}

function buildLiveResult(battle, members, opts) {
  const bad = (detail) => ({ ok: false, reason: "MEMBERS_INVALID", detail });
  if (!battle || typeof battle !== "object" || !battle.input) return bad("battle");
  if (!isTime(battle.updatedAt)) return bad("battle.updatedAt");
  if (!opts || !isTime(opts.at)) return bad("opts.at");
  if (!EXIT_REASONS.includes(opts.reason)) return bad("opts.reason");
  if (!Array.isArray(members) || members.length === 0) return bad("members: empty");
  const { fleet, garrison } = splitMembers(members);
  const plan = planLiveMembers(battle.input, { maxShips: Math.max(1, fleet.length) });
  if (!plan.ok) return bad(plan.reason === "LIVE_TOO_LARGE" ? `members ${fleet.length} < plan ${plan.ships}`
    : `input: ${plan.detail}`);
  if (plan.ships !== fleet.length) return bad(`members ${fleet.length} != plan ${plan.ships}`);
  const proxyProblem = garrisonProblem(battle.input, garrison);
  if (proxyProblem) return bad(proxyProblem);
  const byKey = new Map(plan.members.map((m) => [m.memberKey, m]));
  const seen = new Set();
  const destroyed = new Map();
  for (const m of fleet) {
    const p = m && typeof m.memberKey === "string" ? byKey.get(m.memberKey) : undefined;
    if (!p) return bad(`member ${m && m.memberKey}: not in the plan`);
    if (seen.has(m.memberKey)) return bad(`member ${m.memberKey}: duplicate`);
    seen.add(m.memberKey);
    if (m.fleetId !== p.fleetId || m.side !== p.side || m.hullGroup !== p.hullGroup
      || typeOf(m.typeId) !== typeOf(p.typeId)) {
      return bad(`member ${m.memberKey}: fields differ from the plan`);
    }
    if (!LIVE_MEMBER_STATES.includes(m.state)) return bad(`member ${m.memberKey}: state ${m.state}`);
    if (m.state === "DESTROYED") {
      const g = `${p.fleetId}|${p.hullGroup}|${typeOf(p.typeId)}`;
      destroyed.set(g, (destroyed.get(g) || 0) + 1);
    }
  }
  const destroyedShips = [];
  const survivingShips = [];
  const alive = { A: 0, B: 0 };
  for (const g of groupsOf(battle.input)) {
    const d = destroyed.get(`${g.fleetId}|${g.hullGroup}|${typeOf(g.typeId)}`) || 0;
    const s = g.count - d;
    if (d > 0) destroyedShips.push({ fleetId: g.fleetId, hullGroup: g.hullGroup, typeId: g.typeId, count: d });
    if (s > 0) survivingShips.push({ fleetId: g.fleetId, hullGroup: g.hullGroup, typeId: g.typeId, count: s });
    alive[g.side] += s;
  }
  let garrisonLost = 0;
  for (const p of garrison) {
    if (!LIVE_MEMBER_STATES.includes(p.state)) return bad(`member ${p.memberKey}: state ${p.state}`);
    if (p.state === "DESTROYED") garrisonLost += 1;
    else alive[p.side] += 1;
  }
  let outcome = "DRAW";
  if (alive.A > 0 && alive.B === 0) outcome = "A_WIN";
  else if (alive.B > 0 && alive.A === 0) outcome = "B_WIN";
  const diagnostics = garrison.length > 0
    ? { source: LIVE_SOURCE, exit: opts.reason, garrisonShips: garrison.length, garrisonLost }
    : { source: LIVE_SOURCE, exit: opts.reason };
  return { ok: true, result: { battleId: battle.input.battleId, resolver: battle.input.resolverVersion, outcome,
    destroyedShips, escapedShips: [], survivingShips, objectiveAchieved: outcome === "A_WIN",
    estimatedDurationSec: Math.max(0, Math.floor((opts.at - battle.updatedAt) / 1000)), confidence: 1,
    diagnostics } };
}

module.exports = { LIVE_MEMBER_STATES, EXIT_REASONS, GARRISON_HULL_GROUPS, memberKeyOf, planLiveMembers,
  planGarrisonMembers, splitMembers, garrisonProblem, buildLiveResult };
