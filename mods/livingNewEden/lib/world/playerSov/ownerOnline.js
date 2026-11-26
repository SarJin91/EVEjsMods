"use strict";

const REASON = Object.freeze({ PRESENCE_UNAVAILABLE: "PRESENCE_UNAVAILABLE", PRESENCE_STALE: "PRESENCE_STALE",
  MEMBERS_UNAVAILABLE: "MEMBERS_UNAVAILABLE", INVALID_INPUT: "INVALID_INPUT" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createOwnerOnline(deps) {
  const C = deps.config.playerSov;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const members = new Map();
  let online = { version: null, set: null };

  const off = (reason) => ({ online: false, reason });

  function presence() {
    const p = typeof deps.getPresence === "function" ? call(deps.getPresence, null) : null;
    return p && typeof p.listPresence === "function" && typeof p.getVersion === "function" ? p : null;
  }

  function onlineSet(p) {
    const status = typeof p.getStatus === "function" ? call(() => p.getStatus(), null) : null;
    if (!status || status.available !== true) return { reason: REASON.PRESENCE_UNAVAILABLE };
    if (status.stale === true) {
      bump("presenceStale");
      return { reason: REASON.PRESENCE_STALE };
    }
    const version = call(() => p.getVersion(), null);
    if (version !== null && version === online.version && online.set !== null) return { set: online.set };
    const list = call(() => p.listPresence(), null);
    if (!Array.isArray(list)) return { reason: REASON.PRESENCE_UNAVAILABLE };
    const set = new Set();
    for (const sys of list) {
      for (const c of (sys && Array.isArray(sys.characters) ? sys.characters : [])) {
        if (c && isId(c.characterId)) set.add(c.characterId);
      }
    }
    online = { version, set };
    return { set };
  }

  function memberSet(corpId, at) {
    const hit = members.get(corpId);
    if (hit && at - hit.at >= 0 && at - hit.at < C.reconcileMs) return hit.set;
    const seam = deps.adapter ? call(() => deps.adapter.playerStructures, null) : null;
    const r = seam && typeof seam.listOwnerMemberIds === "function"
      ? call(() => seam.listOwnerMemberIds(corpId, { max: C.ownerMembersMax }), null) : null;
    if (!r || r.ok !== true || !Array.isArray(r.characterIds)) {
      bump("membersReadFailed");
      return null;
    }
    if (r.truncated === true) bump("membersTruncated");
    const set = new Set(r.characterIds.filter(isId));
    members.set(corpId, { at, set });
    return set;
  }

  function ownerOnline(corpId, at) {
    try {
      if (!isId(corpId)) return off(REASON.INVALID_INPUT);
      const now = Number.isSafeInteger(at) ? at : (typeof deps.now === "function" ? call(deps.now, 0) : 0);
      const p = presence();
      if (p === null) return off(REASON.PRESENCE_UNAVAILABLE);
      const o = onlineSet(p);
      if (!o.set) return off(o.reason);
      const m = memberSet(corpId, now);
      if (m === null) return off(REASON.MEMBERS_UNAVAILABLE);
      const [small, big] = o.set.size <= m.size ? [o.set, m] : [m, o.set];
      for (const id of small) if (big.has(id)) return { online: true, reason: null };
      return { online: false, reason: null };
    } catch (_err) {
      return off(REASON.MEMBERS_UNAVAILABLE);
    }
  }

  function clear() {
    members.clear();
    online = { version: null, set: null };
  }

  return Object.freeze({ ownerOnline, clear });
}

module.exports = { createOwnerOnline, OWNER_ONLINE_REASON: REASON };
