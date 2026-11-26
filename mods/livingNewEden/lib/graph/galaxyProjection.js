"use strict";

function projectTopDown(points, gridSize) {
  const n = points.length;
  const x = new Int32Array(n);
  const y = new Int32Array(n);
  if (n === 0) return { x, y, width: 0, height: 0, bounds: { minU: 0, maxU: 0, minV: 0, maxV: 0 } };
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (const p of points) {
    const u = p.x;
    const v = -p.z;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  const span = Math.max(maxU - minU, maxV - minV);
  const scale = span > 0 ? gridSize / span : 1;
  for (let i = 0; i < n; i += 1) {
    x[i] = Math.round((points[i].x - minU) * scale);
    y[i] = Math.round((-points[i].z - minV) * scale);
  }
  return { x, y, width: Math.round((maxU - minU) * scale), height: Math.round((maxV - minV) * scale),
    bounds: { minU, maxU, minV, maxV } };
}

module.exports = { projectTopDown };
