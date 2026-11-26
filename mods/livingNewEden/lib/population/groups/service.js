"use strict";

const { createRng, deriveSeed } = require("../../util/rng");
const { STATE, MEMORY_ESTIMATE } = require("../schema");
const G_ = require("./schema");

function createGroupsService(deps) {
  const { worldSeed, pilots, queue, keyOf } = deps;
  const G = deps.S.groups;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const profileOf = typeof deps.profileOf === "function" ? deps.profileOf : () => -1;
  const isOwned = typeof deps.isOwned === "function" ? deps.isOwned : () => false;
  const isRestricted = typeof deps.isRestricted === "function" ? deps.isRestricted : () => false;
  const groups = new Map();
  let memberTotal = 0;
  let formsLeft = 0;
  let formsPass = 0;
  let scansPass = 0;
  let last = Object.freeze({ forms: 0, scans: 0 });
  const dissolvedBy = Object.fromEntries(G_.DISSOLVE_REASONS.map((r) => [r, 0]));

  const isLeader = (id) => groups.has(id);

  function isMember(id) {
    const leader = pilots.groupOf(id);
    return leader !== 0 && leader !== id && groups.has(leader);
  }

  function beginPass() {
    last = Object.freeze({ forms: formsPass, scans: scansPass });
    formsPass = 0;
    scansPass = 0;
    formsLeft = G.maxFormsPerPass;
  }

  function dissolve(leaderId, now, reason) {
    const rec = groups.get(leaderId);
    if (!rec) return 0;
    groups.delete(leaderId);
    memberTotal -= rec.members.length;
    for (const id of rec.members) {
      const m = pilots.get(id);
      if (!m) continue;
      pilots.setGroup(id, 0);
      const dueAt = Math.max(m.dueAt, now);
      pilots.setDue(id, dueAt);
      queue.schedule(keyOf(id), dueAt, id);
    }
    pilots.setGroup(leaderId, 0);
    bump("groups.dissolved");
    if (Object.prototype.hasOwnProperty.call(dissolvedBy, reason)) dissolvedBy[reason] += 1;
    return rec.members.length;
  }

  function membersOf(leaderId) {
    const rec = groups.get(leaderId);
    return rec ? Object.freeze(rec.members.slice()) : null;
  }

  function detach(memberId, leaderId, now) {
    const rec = groups.get(leaderId);
    if (!rec || pilots.groupOf(memberId) !== leaderId || memberId === leaderId) return false;
    const at = rec.members.indexOf(memberId);
    if (at < 0) return false;
    rec.members.splice(at, 1);
    memberTotal -= 1;
    pilots.setGroup(memberId, 0);
    if (rec.members.length === 0) dissolve(leaderId, now, "EMPTY");
    return true;
  }

  function checkLeaderEvent(p, now) {
    const rec = groups.get(p.pilotId);
    if (!rec) return "NONE";
    if (p.state !== STATE.TRAVEL) {
      dissolve(p.pilotId, now, "END");
      return "END";
    }
    if (now - rec.formedAt > G.maxLifetimeMs) {
      dissolve(p.pilotId, now, "LIFETIME");
      return "LIFETIME";
    }
    return "KEPT";
  }

  function tryForm(p, sys, next, now) {
    if (G.enabled !== true) return { ok: false, reason: "OFF" };
    const leaderId = p.pilotId;
    const spec = G_.kindSpecOf(p.archetype);
    if (p.state !== STATE.DOCKED || pilots.groupOf(leaderId) !== 0 || !sys || !(sys.stations > 0) || !spec || !next
      || (next.state !== STATE.TRAVEL && next.state !== STATE.ACTIVE)) {
      return { ok: false, reason: "NOT_ELIGIBLE" };
    }
    if (groups.size >= G.maxGroups || formsLeft <= 0) {
      bump("groups.capped");
      return { ok: false, reason: "CAPPED" };
    }
    const g = createRng(deriveSeed(worldSeed, "pgroup", leaderId, p.seq));
    if (!(g.nextFloat() * 1000 < G.formPermille)) return { ok: false, reason: "NOT_ROLLED" };
    const target = G.minMembers + g.nextInt(0, Math.max(0, G.maxSize - G.minMembers));
    const leaderCorp = pilots.corpOf(leaderId);
    const leaderProf = profileOf(leaderId);
    const accepted = [];
    const leaderRestricted = isRestricted(leaderId);
    let escorts = 0;
    let checks = 0;
    for (const id of pilots.idsIn(p.systemId)) {
      if (accepted.length >= target || checks >= G.scanPerForm) break;
      if (id === leaderId) continue;
      checks += 1;
      const c = pilots.get(id);
      if (!c || c.state !== STATE.DOCKED || c.groupId !== 0 || isOwned(id)) continue;
      if (!leaderRestricted && isRestricted(id)) {
        bump("hulls.groupRefused");
        continue;
      }
      const main = spec.main.includes(c.archetype);
      if (!main && !(spec.escort.includes(c.archetype) && escorts < G.escortMax)) continue;
      const affine = (c.corpId > 0 && c.corpId === leaderCorp) || leaderProf < 0 || profileOf(id) === leaderProf;
      if (!affine) continue;
      if (!main) escorts += 1;
      accepted.push(id);
    }
    scansPass += checks;
    if (accepted.length < G.minMembers) {
      bump("groups.noMembers");
      return { ok: false, reason: "NO_MEMBERS" };
    }
    formsLeft -= 1;
    formsPass += 1;
    accepted.sort((a, b) => a - b);
    pilots.setGroup(leaderId, leaderId);
    for (const id of accepted) {
      pilots.setGroup(id, leaderId);
      queue.remove(keyOf(id));
      pilots.setRoute(id, null);
    }
    groups.set(leaderId, { kind: spec.kind, members: accepted, formedAt: now });
    memberTotal += accepted.length;
    bump("groups.formed");
    return { ok: true, leaderId, members: accepted.slice() };
  }

  function follow(leaderId, next, now, apply) {
    const rec = groups.get(leaderId);
    if (!rec) return 0;
    const memberNext = {};
    for (const f of G_.MEMBER_FIELDS) if (next[f] !== undefined) memberNext[f] = next[f];
    Object.freeze(memberNext);
    let n = 0;
    for (const id of rec.members) {
      const m = pilots.get(id);
      if (!m) continue;
      apply(m, memberNext, now);
      n += 1;
    }
    return n;
  }

  function validMember(m, leaderId) {
    if (!pilots.has(leaderId) || pilots.groupOf(leaderId) !== leaderId) return false;
    if (G_.kindSpecOf(pilots.archetypeOf(leaderId)) === null) return false;
    const L = pilots.get(leaderId);
    if (m.systemId !== L.systemId || m.state !== L.state || m.state === STATE.POD) return false;
    const rec = groups.get(leaderId);
    return !rec || rec.members.length < G.maxSize;
  }

  function restore(now) {
    let orphaned = 0;
    for (let id = 1; id <= pilots.capacity; id += 1) {
      const leaderId = pilots.groupOf(id);
      if (leaderId === 0 || leaderId === id) continue;
      const m = pilots.get(id);
      if (!m) continue;
      if (!validMember(m, leaderId)) {
        pilots.setGroup(id, 0);
        orphaned += 1;
        continue;
      }
      let rec = groups.get(leaderId);
      if (!rec) {
        rec = { kind: G_.kindSpecOf(pilots.archetypeOf(leaderId)).kind, members: [], formedAt: now };
        groups.set(leaderId, rec);
      }
      rec.members.push(id);
      memberTotal += 1;
      queue.remove(keyOf(id));
      pilots.setRoute(id, null);
    }
    for (let id = 1; id <= pilots.capacity; id += 1) {
      if (pilots.groupOf(id) !== id || groups.has(id)) continue;
      pilots.setGroup(id, 0);
      orphaned += 1;
    }
    bump("groups.orphaned", orphaned);
    return { ok: true, groups: groups.size, members: memberTotal, orphaned };
  }

  function getStatus() {
    return Object.freeze({ enabled: true, groups: groups.size, members: memberTotal, formsLastPass: last.forms,
      scansLastPass: last.scans, dissolvedBy: Object.freeze({ ...dissolvedBy }) });
  }

  function approxBytes() {
    return groups.size * (MEMORY_ESTIMATE.MAP_ENTRY_BYTES + G_.GROUP_REC_BYTES) + memberTotal * G_.GROUP_MEMBER_BYTES;
  }

  return Object.freeze({ restore, beginPass, isMember, isLeader, checkLeaderEvent, tryForm, follow, dissolve,
    membersOf, detach, size: () => groups.size, members: () => memberTotal, getStatus, approxBytes });
}

module.exports = { createGroupsService };
