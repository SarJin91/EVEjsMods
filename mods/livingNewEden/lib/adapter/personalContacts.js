"use strict";

const FIELD = "personalContacts";
const MAX_OPS = 64;
const LNE_RELATIONS = Object.freeze([-10, 10]);
const MAX_DETAIL = 120;
const FOREIGN = "foreign";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isRel = (v) => LNE_RELATIONS.includes(v);
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

class NothingToWrite extends Error {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function contactsOf(record) {
  const c = record && typeof record === "object" ? record[FIELD] : null;
  return c && typeof c === "object" && !Array.isArray(c) ? c : null;
}

function contactRowOf(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const rel = typeof r.relationshipID === "number" && Number.isFinite(r.relationshipID) ? r.relationshipID : NaN;
  const mask = r.labelMask === 0 || r.labelMask === "0" ? 0 : String(r.labelMask);
  return { relationshipId: rel, inWatchlist: r.inWatchlist !== false, labelMask: mask };
}

function stateOfRow(raw) {
  if (raw === undefined) return null;
  const row = contactRowOf(raw);
  return row.inWatchlist === false && row.labelMask === 0 && isRel(row.relationshipId) ? row.relationshipId : FOREIGN;
}

function readPersonalContactsFrom(characterState, characterId, contactIds) {
  try {
    const peek = characterState && characterState.peekCharacterRecord;
    if (typeof peek !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "peekCharacterRecord" };
    if (!isId(characterId)) return { ok: false, reason: "CHARACTER_NOT_FOUND" };
    const record = peek.call(characterState, characterId);
    if (!record || typeof record !== "object") return { ok: false, reason: "CHARACTER_NOT_FOUND" };
    const contacts = contactsOf(record);
    const rows = new Map();
    if (contacts && Array.isArray(contactIds)) {
      for (const id of contactIds) {
        if (isId(id) && hasOwn(contacts, String(id))) rows.set(id, contactRowOf(contacts[String(id)]));
      }
    }
    return { ok: true, rows };
  } catch (err) {
    return { ok: false, reason: "READ_THREW", detail: messageOf(err) };
  }
}

function validOps(characterId, ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.length > MAX_OPS) return false;
  const seen = new Set();
  for (const op of ops) {
    if (!op || !isId(op.contactId) || op.contactId === characterId || seen.has(op.contactId)) return false;
    seen.add(op.contactId);
    if (!Array.isArray(op.expect) || op.expect.length === 0) return false;
    if (op.op === "set") {
      if (!isRel(op.relationshipId) || !op.expect.every((e) => e === null || isRel(e))) return false;
    } else if (op.op === "delete") {
      if (!op.expect.every(isRel)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function decide(contacts, op) {
  const key = String(op.contactId);
  const state = stateOfRow(contacts && hasOwn(contacts, key) ? contacts[key] : undefined);
  if (op.op === "delete" && state === null) return "done";
  if (state === FOREIGN) return "conflict";
  if (!op.expect.includes(state)) return "conflict";
  if (op.op === "set" && state === op.relationshipId) return "done";
  return "apply";
}

function applyPersonalContactsFrom(characterState, characterId, ops) {
  try {
    if (!isId(characterId) || !validOps(characterId, ops)) return { ok: false, reason: "BAD_OP", permanent: true };
    const peek = characterState && characterState.peekCharacterRecord;
    const update = characterState && characterState.updateCharacterRecord;
    if (typeof peek !== "function" || typeof update !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
    }
    const current = peek.call(characterState, characterId);
    if (!current || typeof current !== "object") return { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true };
    const before = contactsOf(current);
    if (!ops.some((op) => decide(before, op) === "apply")) {
      const conflicts = ops.filter((op) => decide(before, op) === "conflict").map((op) => op.contactId);
      return { ok: true, applied: ops.map((op) => op.contactId).filter((id) => !conflicts.includes(id)), conflicts,
        written: false };
    }
    let applied = [];
    let conflicts = [];
    let changed = 0;
    let r;
    try {
      r = update.call(characterState, characterId, (record) => {
        const src = contactsOf(record) || {};
        const next = { ...src };
        applied = [];
        conflicts = [];
        changed = 0;
        for (const op of ops) {
          const d = decide(src, op);
          if (d === "conflict") {
            conflicts.push(op.contactId);
            continue;
          }
          applied.push(op.contactId);
          if (d !== "apply") continue;
          changed += 1;
          if (op.op === "delete") delete next[String(op.contactId)];
          else next[String(op.contactId)] = { contactID: op.contactId, inWatchlist: false,
            relationshipID: op.relationshipId, labelMask: 0 };
        }
        if (changed === 0) throw new NothingToWrite("nothing to write");
        record[FIELD] = next;
        return record;
      });
    } catch (err) {
      if (err instanceof NothingToWrite) return { ok: true, applied, conflicts, written: false };
      throw err;
    }
    if (r && r.success === true) return { ok: true, applied, conflicts, written: true };
    const errorMsg = r && typeof r.errorMsg === "string" ? r.errorMsg : "";
    if (errorMsg === "CHARACTER_NOT_FOUND") return { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true };
    return { ok: false, reason: "WRITE_FAILED", permanent: false, detail: (errorMsg || "no result").slice(0, MAX_DETAIL) };
  } catch (err) {
    return { ok: false, reason: "WRITE_THREW", permanent: false, detail: messageOf(err) };
  }
}

module.exports = { readPersonalContactsFrom, applyPersonalContactsFrom, MAX_OPS, LNE_RELATIONS };
