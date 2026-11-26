"use strict";

const NO_ANCHOR = "SENTRY_NO_ANCHOR";
const TOO_CLOSE = "SENTRY_TOO_CLOSE";
const LIMIT = "SENTRY_LIMIT";
const SPACE = "space";

function vec(p) {
  if (!p || typeof p !== "object") return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function eligible(anchor, input) {
  if (anchor.kind === "gate") return true;
  if (input.ownerKind === "faction") return anchor.kind === "structure" && typeof anchor.lneStationId === "string"
    && anchor.lneStationId !== "";
  if (anchor.kind === "station") return true;
  return anchor.kind === "structure" && anchor.ownerCorpId === input.ownerCorpId;
}

function freeAnchor(pos, input) {
  const free = input.free;
  if (!free || typeof free !== "object" || free.enabled !== true) return null;
  if (!Number.isSafeInteger(input.itemId) || input.itemId <= 0) return { ok: false, reason: NO_ANCHOR };
  if (input.anchorsTruncated === true) return { ok: false, reason: NO_ANCHOR, detail: "clearance" };
  let nearest = Infinity;
  for (const anchor of Array.isArray(input.anchors) ? input.anchors : []) {
    const at = anchor ? vec(anchor.position) : null;
    if (!at) continue;
    nearest = Math.min(nearest, distance(pos, at) - Math.max(0, Number(anchor.radius) || 0));
  }
  const clearance = Math.max(Number(free.clearanceM) || 0, Number(input.minM) || 0);
  if (nearest < clearance) return { ok: false, reason: NO_ANCHOR, detail: "clearance" };
  return { ok: true, anchor: { kind: SPACE, id: input.itemId, surfaceM: nearest === Infinity ? null : nearest } };
}

function checkPlacement(input) {
  const pos = vec(input && input.position);
  if (!pos) return { ok: false, reason: NO_ANCHOR };
  let best = null;
  for (const anchor of Array.isArray(input.anchors) ? input.anchors : []) {
    if (!anchor || !Number.isSafeInteger(anchor.id) || anchor.id <= 0 || !eligible(anchor, input)) continue;
    const at = vec(anchor.position);
    if (!at) continue;
    const surfaceM = distance(pos, at) - Math.max(0, Number(anchor.radius) || 0);
    if (!(surfaceM >= input.minM && surfaceM <= input.maxM)) continue;
    if (best === null || surfaceM < best.surfaceM || (surfaceM === best.surfaceM && anchor.id < best.id)) {
      best = { kind: anchor.kind, id: anchor.id, surfaceM };
    }
  }
  if (best === null) {
    const free = freeAnchor(pos, input);
    if (free === null) return { ok: false, reason: NO_ANCHOR };
    if (!free.ok) return free;
    best = free.anchor;
  }
  for (const other of Array.isArray(input.others) ? input.others : []) {
    const at = vec(other && other.position);
    if (at && distance(pos, at) < input.spacingM) return { ok: false, reason: TOO_CLOSE };
  }
  return { ok: true, anchor: best };
}

function checkLimits(counts, s) {
  if (counts.perAnchor >= s.maxPerAnchor) return { ok: false, reason: LIMIT, detail: "anchor" };
  if (counts.perSystemOwner >= s.maxPerSystemPerOwner) return { ok: false, reason: LIMIT, detail: "system" };
  if (counts.perOwner >= s.maxPerOwner) return { ok: false, reason: LIMIT, detail: "owner" };
  if (counts.total >= s.maxTotal) return { ok: false, reason: LIMIT, detail: "total" };
  return { ok: true };
}

function checkKindLimits(counts, s) {
  if (counts.perAnchor >= s.maxPerAnchor) return { ok: false, reason: LIMIT, detail: "anchor" };
  if (counts.perSystemOwner >= s.maxPerSystemPerOwner) return { ok: false, reason: LIMIT, detail: "system" };
  if (counts.perOwner >= s.maxPerOwner) return { ok: false, reason: LIMIT, detail: "owner" };
  if (counts.perSystem >= s.maxPerSystem) return { ok: false, reason: LIMIT, detail: "systemAll" };
  if (counts.total >= s.maxTotal) return { ok: false, reason: LIMIT, detail: "total" };
  return { ok: true };
}

function checkFreeLimits(counts, s) {
  if (counts.perSystemOwner >= s.maxPerSystemPerOwner) return { ok: false, reason: LIMIT, detail: "freeSystem" };
  if (counts.perOwner >= s.maxPerOwner) return { ok: false, reason: LIMIT, detail: "freeOwner" };
  return { ok: true };
}

module.exports = { checkPlacement, checkLimits, checkKindLimits, checkFreeLimits };
