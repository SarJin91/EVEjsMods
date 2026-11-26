"use strict";

const { vec, add, scale, dot, cross, length, normalize } = require("../util/vec");

const FORMATIONS = Object.freeze(["none", "wedge", "line", "column", "sphere"]);

const VERTICAL_DOT = 0.99;
const WORLD_UP = Object.freeze({ x: 0, y: 1, z: 0 });
const WORLD_X = Object.freeze({ x: 1, y: 0, z: 0 });
const DEFAULT_FORWARD = Object.freeze({ x: 0, y: 0, z: 1 });
const DEG = Math.PI / 180;
const MS_PER_S = 1000;

const CORNER = 1 / Math.sqrt(3);
const SPHERE_DIRS = Object.freeze([
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 1], [-1, 1, 1], [1, -1, 1], [-1, -1, 1], [1, 1, -1], [-1, 1, -1], [1, -1, -1], [-1, -1, -1],
].map(([r, u, f], i) => Object.freeze(i < 6 ? { r, u, f } : { r: r * CORNER, u: u * CORNER, f: f * CORNER })));

function normalizeFormation(name) {
  if (typeof name !== "string") return null;
  const word = name.trim().toLowerCase();
  return FORMATIONS.includes(word) ? word : null;
}

function finiteVec(v) {
  return v !== null && typeof v === "object" && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function hostFrame(direction, velocity) {
  let f;
  if (length(direction) > 0) f = normalize(direction);
  else if (length(velocity) > 0) f = normalize(velocity);
  else f = vec(DEFAULT_FORWARD);
  const up = Math.abs(dot(f, WORLD_UP)) > VERTICAL_DOT ? WORLD_X : WORLD_UP;
  const r = normalize(cross(f, up));
  const u = cross(r, f);
  return { f, r, u };
}

function slotOffset(name, index, wedgeAngleDeg) {
  if (!Number.isSafeInteger(index) || index < 0) return null;
  const k = Math.floor(index / 2) + 1;
  const side = index % 2 === 0 ? 1 : -1;
  switch (name) {
    case "line":
      return { r: side * k, u: 0, f: 0 };
    case "column":
      return { r: 0, u: 0, f: -(index + 1) };
    case "wedge": {
      const a = Number(wedgeAngleDeg) * DEG;
      if (!Number.isFinite(a)) return null;
      return { r: side * k * Math.sin(a), u: 0, f: -k * Math.cos(a) };
    }
    case "sphere": {
      const dir = SPHERE_DIRS[index % SPHERE_DIRS.length];
      const ring = Math.floor(index / SPHERE_DIRS.length) + 1;
      return { r: dir.r * ring, u: dir.u * ring, f: dir.f * ring };
    }
    default:
      return null;
  }
}

function maxOffsetNorm(name, count, wedgeAngleDeg) {
  let max = 0;
  const n = Number.isSafeInteger(count) && count > 0 ? count : 0;
  for (let i = 0; i < n; i += 1) {
    const o = slotOffset(name, i, wedgeAngleDeg);
    if (o) max = Math.max(max, Math.sqrt(o.r * o.r + o.u * o.u + o.f * o.f));
  }
  return max;
}

function slotPoint(p) {
  if (!p || typeof p !== "object" || !p.host || !p.cfg) return null;
  const { name, index, count, host, cfg } = p;
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(index) || index < 0 || index >= count) return null;
  if (!finiteVec(host.position) || !finiteVec(host.velocity)) return null;
  const offset = slotOffset(name, index, cfg.formationWedgeAngleDeg);
  if (!offset) return null;
  const radius = Number.isFinite(p.maxRadius) && p.maxRadius > 0 ? p.maxRadius : 0;
  const spacing = Number(cfg.formationSpacingMeters) + 2 * radius;
  const maxDistance = Number(cfg.formationMaxDistanceMeters);
  const leadS = Number(cfg.formationLeadMs) / MS_PER_S;
  if (![spacing, maxDistance, leadS].every(Number.isFinite) || spacing <= 0) return null;
  const norm = maxOffsetNorm(name, count, cfg.formationWedgeAngleDeg);
  const k = norm > 0 ? Math.min(1, maxDistance / (spacing * norm)) : 1;
  const frame = hostFrame(host.direction, host.velocity);
  const local = add(add(scale(frame.r, offset.r), scale(frame.u, offset.u)), scale(frame.f, offset.f));
  const point = add(add(host.position, scale(local, spacing * k)), scale(host.velocity, leadS));
  return finiteVec(point) ? point : null;
}

module.exports = { FORMATIONS, SPHERE_DIRS, normalizeFormation, hostFrame, slotOffset, maxOffsetNorm, slotPoint };
