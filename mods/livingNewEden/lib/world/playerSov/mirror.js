"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function endOf(live, reason) {
  return { kind: S.ACTION.END, systemId: live.systemId, claimId: live.claimId, from: live.state, reason };
}

function insertOf(systemId, allianceId, corpId, hubItemId, state) {
  return { kind: S.ACTION.INSERT, systemId, allianceId, corpId, hubItemId, state,
    claimId: S.claimIdOf(systemId, allianceId, hubItemId) };
}

const goneReason = (live) => (live.state === S.RETAKING ? S.END_REASON.RETAKEN : S.END_REASON.NATIVE_GONE);
const changedReason = (live, newClaim) => (live.state === S.RETAKING && !newClaim ? S.END_REASON.RETAKEN
  : S.END_REASON.OWNER_CHANGED);

function planSystem(v, live, out) {
  if (v.virtualClaim === true) {
    if (live) out.push(endOf(live, S.END_REASON.OWNER_CHANGED));
    return;
  }
  const claimed = isId(v.allianceId);
  if (claimed) {
    const corpOk = isId(v.corpId) && isId(v.hubItemId);
    if (!live) {
      if (corpOk) out.push(insertOf(v.systemId, v.allianceId, v.corpId, v.hubItemId, S.HELD));
      return;
    }
    if (live.allianceId === v.allianceId) {
      if (live.state === S.CAPTURING) {
        out.push({ kind: S.ACTION.PROMOTE, systemId: v.systemId, claimId: live.claimId });
      } else if ((live.state === S.SIEGED || live.state === S.REINFORCED) && live.baseState === S.CAPTURING) {
        out.push({ kind: S.ACTION.SET_BASE, systemId: v.systemId, claimId: live.claimId, baseState: S.HELD });
      }
      return;
    }
    out.push(endOf(live, changedReason(live, true)));
    if (corpOk) out.push(insertOf(v.systemId, v.allianceId, v.corpId, v.hubItemId, S.HELD));
    return;
  }
  const hub = v.neutralHub;
  if (!hub || !isId(hub.allianceId) || !isId(hub.corpId) || !isId(hub.itemId)) {
    if (live) out.push(endOf(live, goneReason(live)));
    return;
  }
  if (!live) {
    out.push(insertOf(v.systemId, hub.allianceId, hub.corpId, hub.itemId, S.CAPTURING));
    return;
  }
  if (live.allianceId === hub.allianceId) return;
  out.push(endOf(live, changedReason(live, false)));
  out.push(insertOf(v.systemId, hub.allianceId, hub.corpId, hub.itemId, S.CAPTURING));
}

function planMirror(vendorRows, liveRows, at) {
  const live = liveRows instanceof Map ? liveRows : new Map();
  const bySystem = new Map();
  for (const v of Array.isArray(vendorRows) ? vendorRows : []) {
    if (v && isId(v.systemId) && !bySystem.has(v.systemId)) bySystem.set(v.systemId, v);
  }
  const systems = new Set([...bySystem.keys(), ...[...live.keys()].filter(isId)]);
  const out = [];
  for (const systemId of [...systems].sort((a, b) => a - b)) {
    const row = live.get(systemId) || null;
    const v = bySystem.get(systemId) || { systemId, allianceId: null, corpId: null, hubItemId: null, neutralHub: null,
      virtualClaim: false };
    planSystem(v, row, out);
  }
  return out.map((a) => ({ ...a, at }));
}

module.exports = { planMirror };
