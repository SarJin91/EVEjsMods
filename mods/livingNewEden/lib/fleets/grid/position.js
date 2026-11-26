"use strict";

const { IN_FLIGHT, positionAt } = require("../travel");
const { anchorRef, entryGateOf } = require("./anchors");

const REFITTING = "REFITTING";

function isVisitValid(fleet, visit) {
  return Boolean(fleet && visit && visit.systemId === fleet.currentSystemId && visit.legSeq === fleet.legSeq);
}

function anchorPosition(sys, anchor, source) {
  const ref = anchorRef(anchor.kind, anchor.id);
  const gridKey = (sys.gridOf instanceof Map && sys.gridOf.get(ref)) || (anchor.kind === "system" ? ref
    : `system:${sys.systemId}`);
  return { kind: "anchor", anchorKind: anchor.kind, anchorId: anchor.id, gridKey, position: anchor.position || null,
    source };
}

const cpOf = (sys, source) => anchorPosition(sys, sys.cp, source);

function lookup(sys, kind, id) {
  return sys.byRef instanceof Map ? sys.byRef.get(anchorRef(kind, id)) || null : null;
}

function gridPositionAt(fleet, visit, at, sys) {
  if (fleet && IN_FLIGHT.includes(fleet.state)) {
    return { kind: "transit", systemId: positionAt(fleet, at).systemId, source: "ROUTE" };
  }
  if (fleet && fleet.state === REFITTING) return cpOf(sys, "REFIT");
  if (!isVisitValid(fleet, visit)) return cpOf(sys, "CP");
  if (visit.toKind !== null && visit.toKind !== undefined) {
    if (at >= visit.departAt && at < visit.arriveAt) {
      const span = visit.arriveAt - visit.departAt;
      const progress = span > 0 ? Math.min(1, Math.max(0, (at - visit.departAt) / span)) : 1;
      return { kind: "warp", from: { kind: visit.atKind, id: visit.atId }, to: { kind: visit.toKind, id: visit.toId },
        progress, source: "MOVE" };
    }
    if (at >= visit.arriveAt) {
      const to = lookup(sys, visit.toKind, visit.toId);
      return to ? anchorPosition(sys, to, "MOVE") : cpOf(sys, "GONE");
    }
  }
  if (visit.atKind !== null && visit.atKind !== undefined) {
    const here = lookup(sys, visit.atKind, visit.atId);
    return here ? anchorPosition(sys, here, "MOVE") : cpOf(sys, "GONE");
  }
  if (visit.enteredVia === "GATE") {
    const gate = entryGateOf(sys.anchors, visit.entryFromSystemId);
    return gate ? anchorPosition(sys, gate, "ENTRY") : cpOf(sys, "GONE");
  }
  return cpOf(sys, "ENTRY_CP");
}

module.exports = { isVisitValid, gridPositionAt };
