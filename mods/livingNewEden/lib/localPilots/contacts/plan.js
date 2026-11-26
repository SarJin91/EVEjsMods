"use strict";

const S = require("./schema");

const FOREIGN = "foreign";
const isRel = (v) => v === -10 || v === 10;

function vendorStateOf(row) {
  if (!row) return null;
  return row.inWatchlist === false && row.labelMask === 0 && isRel(row.relationshipId) ? row.relationshipId : FOREIGN;
}

function expectOf(...values) {
  const out = [];
  for (const v of values) if ((v === null || isRel(v)) && !out.includes(v)) out.push(v);
  return out;
}

function planCharacter(input) {
  const out = { ops: [], transitions: [], skippedManual: 0 };
  if (!input || typeof input !== "object") return out;
  const desired = input.desired instanceof Map ? input.desired : new Map();
  const known = input.known instanceof Set ? input.known : new Set();
  const unknown = input.unknown instanceof Set ? input.unknown : new Set();
  const vendor = input.vendor instanceof Map ? input.vendor : new Map();
  const registry = Array.isArray(input.registry) ? input.registry : [];
  const now = Number(input.nowMs);
  const delay = Number(input.confirmDelayMs);
  const byContact = new Map();
  for (const r of registry) if (r && Number.isSafeInteger(r.contactId)) byContact.set(r.contactId, r);
  const ids = new Set(byContact.keys());
  for (const [id, d] of desired) if (known.has(id) && d && isRel(d.rel)) ids.add(id);

  const set = (contactId, rel, expect) => out.ops.push({ contactId, op: "set", relationshipId: rel, expect });
  const del = (contactId, expect) => out.ops.push({ contactId, op: "delete", expect });
  const move = (t) => out.transitions.push(t);
  const release = (contactId, from, reason) => move({ contactId, from, to: S.RELEASED, reason });

  for (const id of [...ids].sort((a, b) => a - b)) {
    if (unknown.has(id)) continue;
    const reg = byContact.get(id) || null;
    const d = known.has(id) && desired.has(id) && isRel(desired.get(id).rel) ? desired.get(id) : null;
    const vs = vendorStateOf(vendor.get(id));
    if (reg === null) {
      if (d === null) continue;
      if (vs !== null) {
        out.skippedManual += 1;
        continue;
      }
      set(id, d.rel, [null]);
      move({ contactId: id, from: null, to: S.ADDING, rel: d.rel, prev: null, factionId: d.factionId, level: d.level });
      continue;
    }
    const W = reg.writtenRel;
    const P = isRel(reg.prevRel) ? reg.prevRel : null;
    const confirmed = now >= Number(reg.changedAt) + delay;
    if (reg.state === S.RELEASED) continue;
    if (reg.state === S.OWNED) {
      if (vs === null) release(id, reg.state, S.RELEASE_REASONS.MANUAL_DELETE);
      else if (vs !== W) release(id, reg.state, S.RELEASE_REASONS.MANUAL_EDIT);
      else if (d === null) {
        del(id, expectOf(W));
        move({ contactId: id, from: reg.state, to: S.REMOVING, rel: W, prev: P });
      } else if (d.rel !== W) {
        set(id, d.rel, expectOf(W));
        move({ contactId: id, from: reg.state, to: S.ADDING, rel: d.rel, prev: W });
      }
      continue;
    }
    if (reg.state === S.ADDING) {
      if (vs !== null && vs !== W && vs !== P) release(id, reg.state, S.RELEASE_REASONS.MANUAL_EDIT);
      else if (d === null) {
        del(id, expectOf(W, P));
        move({ contactId: id, from: reg.state, to: S.REMOVING, rel: W, prev: P });
      } else if (d.rel !== W) {
        set(id, d.rel, expectOf(null, P, W));
        move({ contactId: id, from: reg.state, to: S.ADDING, rel: d.rel, prev: W });
      } else if (vs === W) {
        if (confirmed) move({ contactId: id, from: reg.state, to: S.OWNED, rel: W, prev: null });
      } else {
        set(id, W, expectOf(null, P));
        move({ contactId: id, from: reg.state, to: S.ADDING, rel: W, prev: P });
      }
      continue;
    }
    if (reg.state === S.REMOVING) {
      if (vs !== null && vs !== W && vs !== P) release(id, reg.state, S.RELEASE_REASONS.MANUAL_EDIT);
      else if (d !== null) {
        const prev = d.rel !== W ? W : P;
        set(id, d.rel, expectOf(null, W, P));
        move({ contactId: id, from: reg.state, to: S.ADDING, rel: d.rel, prev });
      } else if (vs !== null) {
        del(id, expectOf(W, P));
        move({ contactId: id, from: reg.state, to: S.REMOVING, rel: W, prev: P });
      } else if (confirmed) {
        move({ contactId: id, from: reg.state, to: S.DELETE_ROW });
      }
    }
  }
  return out;
}

module.exports = { planCharacter, vendorStateOf };
