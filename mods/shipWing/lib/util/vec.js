"use strict";

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function vec(v) {
  return { x: num(v && v.x), y: num(v && v.y), z: num(v && v.z) };
}

function add(a, b) {
  const p = vec(a);
  const q = vec(b);
  return { x: p.x + q.x, y: p.y + q.y, z: p.z + q.z };
}

function scale(a, k) {
  const p = vec(a);
  const f = num(k);
  return { x: p.x * f, y: p.y * f, z: p.z * f };
}

function length(a) {
  const p = vec(a);
  return Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
}

function distance(a, b) {
  const p = vec(a);
  const q = vec(b);
  const dx = p.x - q.x;
  const dy = p.y - q.y;
  const dz = p.z - q.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function surfaceDistance(a, radiusA, b, radiusB) {
  return Math.max(0, distance(a, b) - Math.max(0, num(radiusA)) - Math.max(0, num(radiusB)));
}

function normalize(a, fallback = { x: 1, y: 0, z: 0 }) {
  const len = length(a);
  if (len <= 0) return vec(fallback);
  return scale(a, 1 / len);
}

function sub(a, b) {
  const p = vec(a);
  const q = vec(b);
  return { x: p.x - q.x, y: p.y - q.y, z: p.z - q.z };
}

function dot(a, b) {
  const p = vec(a);
  const q = vec(b);
  return p.x * q.x + p.y * q.y + p.z * q.z;
}

function cross(a, b) {
  const p = vec(a);
  const q = vec(b);
  return { x: p.y * q.z - p.z * q.y, y: p.z * q.x - p.x * q.z, z: p.x * q.y - p.y * q.x };
}

module.exports = { vec, add, sub, scale, dot, cross, length, distance, surfaceDistance, normalize };
