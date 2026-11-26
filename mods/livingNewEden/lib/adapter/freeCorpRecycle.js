"use strict";

const MAX_DETAIL = 200;
const MAX_DESCRIPTION = 1000;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const fn = (mod, name) => Boolean(mod) && typeof mod[name] === "function";

function seamsOf(mods) {
  const cs = mods && mods.characterState;
  const st = mods && mods.corporationState;
  const rt = mods && mods.corporationRuntimeState;
  if (!fn(cs, "peekCharacterRecord") || !fn(st, "getCorporationRecord") || !fn(st, "setCharacterAffiliation")
    || !fn(rt, "ensureCharacterMemberState") || !fn(rt, "getCorporationMember") || !fn(rt, "updateCorporationRuntime")) {
    return null;
  }
  return { cs, st, rt };
}

function moveFreeCharacterWith(mods, spec) {
  const s = spec || {};
  if (!isId(s.characterId) || !isId(s.toCorporationId) || !(Number.isSafeInteger(s.fromHint) && s.fromHint >= 0)
    || typeof s.cleanSource !== "boolean") {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const m = seamsOf(mods);
  if (!m) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "functions" };
  const char = s.characterId;
  const to = s.toCorporationId;
  try {
    const peek = m.cs.peekCharacterRecord(char);
    if (!peek) return { ok: false, reason: "CHARACTER_MISSING" };
    if (!m.st.getCorporationRecord(to)) return { ok: false, reason: "TARGET_MISSING" };
    const current = Number.isSafeInteger(Number(peek.corporationID)) ? Number(peek.corporationID) : 0;
    const already = current === to;
    const from = already ? s.fromHint : current;
    if (!already) {
      const res = m.st.setCharacterAffiliation(char, to, 0);
      if (!res || res.success !== true) {
        return { ok: false, reason: String((res && res.errorMsg) || "AFFILIATE_FAILED").slice(0, MAX_DETAIL) };
      }
      m.rt.ensureCharacterMemberState(to, char);
    } else if (m.rt.getCorporationMember(to, char) === null) {
      m.rt.ensureCharacterMemberState(to, char);
    }
    let cleaned = false;
    if (s.cleanSource && from > 0 && from !== to && m.rt.getCorporationMember(from, char) !== null) {
      m.rt.updateCorporationRuntime(from, (runtime) => {
        if (runtime && runtime.members) delete runtime.members[String(char)];
        return runtime;
      });
      cleaned = true;
    }
    return { ok: true, already, cleaned };
  } catch (err) {
    return { ok: false, reason: "VENDOR_THROW", detail: detailOf(err) };
  }
}

function setCorporationDescriptionWith(mods, corporationId, description) {
  if (!isId(corporationId) || typeof description !== "string" || description === ""
    || description.length > MAX_DESCRIPTION) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const st = mods && mods.corporationState;
  const rt = mods && mods.corporationRuntimeState;
  if (!fn(st, "getCorporationRecord") || !fn(rt, "updateCorporationRecord")) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "functions" };
  }
  try {
    const rec = st.getCorporationRecord(corporationId);
    if (!rec) return { ok: false, reason: "TARGET_MISSING" };
    if (rec.description === description) return { ok: true, changed: false };
    const res = rt.updateCorporationRecord(corporationId, { description });
    if (!res || res.success !== true) {
      return { ok: false, reason: String((res && res.errorMsg) || "UPDATE_FAILED").slice(0, MAX_DETAIL) };
    }
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, reason: "VENDOR_THROW", detail: detailOf(err) };
  }
}

module.exports = { moveFreeCharacterWith, setCorporationDescriptionWith };
