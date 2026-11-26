"use strict";

const SRC_WORLD = "world";
const SRC_SDE = "sde";
const MIN_RING_POINTS = 4;
const PERCENT = 100;

function ownerKeyOf(owner) {
  if (!owner || !Number.isSafeInteger(owner.factionId) || owner.factionId <= 0) return 0;
  return owner.factionId * 2 + (owner.source === SRC_SDE ? 1 : 0);
}

function segDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

function douglasPeucker(pts, from, to, tol2, keep) {
  const n = pts.length;
  const stack = [[from, to]];
  while (stack.length > 0) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const pa = pts[a % n];
    const pb = pts[b % n];
    let best = -1;
    let bestD = tol2;
    for (let k = a + 1; k < b; k += 1) {
      const p = pts[k % n];
      const d = segDist2(p[0], p[1], pa[0], pa[1], pb[0], pb[1]);
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best >= 0) {
      keep[best % n] = true;
      stack.push([a, best], [best, b]);
    }
  }
}

function dropCollinear(pts) {
  const n = pts.length;
  const out = [];
  for (let k = 0; k < n; k += 1) {
    const p = pts[(k + n - 1) % n];
    const c = pts[k];
    const q = pts[(k + 1) % n];
    const cross = (c[0] - p[0]) * (q[1] - c[1]) - (c[1] - p[1]) * (q[0] - c[0]);
    if (cross !== 0) out.push(c);
  }
  return out;
}

function simplifyRing(pts, tol) {
  const base = dropCollinear(pts);
  if (tol <= 0 || base.length <= MIN_RING_POINTS) return base;
  const n = base.length;
  let far = 0;
  let farD = -1;
  for (let k = 1; k < n; k += 1) {
    const dx = base[k][0] - base[0][0];
    const dy = base[k][1] - base[0][1];
    const d = dx * dx + dy * dy;
    if (d > farD) {
      farD = d;
      far = k;
    }
  }
  const keep = new Array(n).fill(false);
  keep[0] = true;
  keep[far] = true;
  const tol2 = tol * tol;
  douglasPeucker(base, 0, far, tol2, keep);
  douglasPeucker(base, far, n, tol2, keep);
  const out = base.filter((_p, k) => keep[k]);
  return out.length < MIN_RING_POINTS ? base : out;
}

function rasterPass(input, keys, cell, r, simplifyPercent) {
  const { systems, grid } = input;
  const count = systems.id.length;
  const pad = Math.ceil(r / cell);
  const cols = Math.ceil(Math.max(1, grid.width) / cell) + 2 * pad;
  const rows = Math.ceil(Math.max(1, grid.height) / cell) + 2 * pad;
  const origin = -pad * cell;
  const total = cols * rows;
  const best = new Float64Array(total).fill(Infinity);
  const win = new Int32Array(total).fill(-1);
  const r2 = r * r;
  const placed = new Uint8Array(count);
  let stampOps = 0;

  for (let i = 0; i < count; i += 1) {
    const x = systems.x[i];
    const y = systems.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    placed[i] = 1;
    const c0 = Math.max(0, Math.floor((x - r - origin) / cell));
    const c1 = Math.min(cols - 1, Math.floor((x + r - origin) / cell));
    const w0 = Math.max(0, Math.floor((y - r - origin) / cell));
    const w1 = Math.min(rows - 1, Math.floor((y + r - origin) / cell));
    for (let cy = w0; cy <= w1; cy += 1) {
      if (c1 >= c0) stampOps += c1 - c0 + 1;
      const dy = origin + (cy + 0.5) * cell - y;
      for (let cx = c0; cx <= c1; cx += 1) {
        const dx = origin + (cx + 0.5) * cell - x;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const at = cy * cols + cx;
        if (d2 < best[at]) {
          best[at] = d2;
          win[at] = i;
        }
      }
    }
  }

  const label = new Float64Array(total).fill(-1);
  for (let at = 0; at < total; at += 1) if (win[at] >= 0) label[at] = keys[win[at]];
  const comp = new Int32Array(total).fill(-1);
  const comps = [];
  const queue = new Int32Array(total);
  for (let start = 0; start < total; start += 1) {
    if (label[start] <= 0 || comp[start] >= 0) continue;
    const id = comps.length;
    const own = label[start];
    const cells = [];
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    comp[start] = id;
    while (head < tail) {
      const at = queue[head++];
      cells.push(at);
      const cx = at % cols;
      const near = [cx > 0 ? at - 1 : -1, cx < cols - 1 ? at + 1 : -1, at >= cols ? at - cols : -1,
        at + cols < total ? at + cols : -1];
      for (const nb of near) {
        if (nb >= 0 && comp[nb] < 0 && label[nb] === own) {
          comp[nb] = id;
          queue[tail++] = nb;
        }
      }
    }
    comps.push({ key: own, cells, systems: [] });
  }

  let unplaced = 0;
  for (let i = 0; i < count; i += 1) {
    if (keys[i] <= 0) continue;
    if (!placed[i]) {
      unplaced += 1;
      continue;
    }
    const cx = Math.floor((systems.x[i] - origin) / cell);
    const cy = Math.floor((systems.y[i] - origin) / cell);
    const at = cy * cols + cx;
    if (cx >= 0 && cx < cols && cy >= 0 && cy < rows && label[at] === keys[i] && comp[at] >= 0) {
      comps[comp[at]].systems.push(systems.id[i]);
    } else {
      unplaced += 1;
    }
  }

  const vcols = cols + 1;
  const tol = (cell * simplifyPercent) / PERCENT;
  const areas = [];
  let fragments = 0;
  let points = 0;
  for (let id = 0; id < comps.length; id += 1) {
    const c = comps[id];
    if (c.systems.length === 0) {
      fragments += 1;
      continue;
    }
    const out = new Map();
    const addEdge = (a, b) => {
      const list = out.get(a);
      if (list) list.push(b);
      else out.set(a, [b]);
    };
    for (const at of c.cells) {
      const cx = at % cols;
      const cy = (at - cx) / cols;
      const tl = cy * vcols + cx;
      const tr = tl + 1;
      const bl = tl + vcols;
      const br = bl + 1;
      const inside = (nb, ok) => ok && comp[nb] === id;
      if (!inside(at - cols, cy > 0)) addEdge(tl, tr);
      if (!inside(at + 1, cx < cols - 1)) addEdge(tr, br);
      if (!inside(at + cols, cy < rows - 1)) addEdge(br, bl);
      if (!inside(at - 1, cx > 0)) addEdge(bl, tl);
    }
    const starts = [...out.keys()].sort((a, b) => a - b);
    const rings = [];
    for (const s of starts) {
      for (;;) {
        const list = out.get(s);
        if (!list || list.length === 0) break;
        const first = list.shift();
        const verts = [s];
        let prev = s;
        let cur = first;
        for (;;) {
          const dx = (cur % vcols) - (prev % vcols);
          const dy = Math.floor(cur / vcols) - Math.floor(prev / vcols);
          const cand = (out.get(cur) || []).slice();
          if (cur === s) cand.push(first);
          let next;
          if (cand.length === 0) break;
          if (cand.length === 1) {
            next = cand[0];
          } else {
            const want = (Math.floor(cur / vcols) + dx) * vcols + (cur % vcols) - dy;
            next = cand.includes(want) ? want : cand[0];
          }
          if (cur === s && next === first) break;
          const list2 = out.get(cur);
          list2.splice(list2.indexOf(next), 1);
          verts.push(cur);
          prev = cur;
          cur = next;
        }
        const pts = verts.map((v) => [origin + (v % vcols) * cell, origin + Math.floor(v / vcols) * cell]);
        const simple = simplifyRing(pts, tol);
        const flat = [];
        for (const p of simple) flat.push(Math.round(p[0]), Math.round(p[1]));
        points += simple.length;
        rings.push(flat);
      }
    }
    const factionId = Math.floor(c.key / 2);
    areas.push({ factionId, source: c.key % 2 === 1 ? SRC_SDE : SRC_WORLD,
      systems: c.systems.slice().sort((a, b) => a - b), rings });
  }
  areas.sort((a, b) => a.factionId - b.factionId || (a.source === b.source ? 0 : a.source === SRC_WORLD ? -1 : 1)
    || a.systems[0] - b.systems[0]);
  return { areas, cells: total, stampOps, points, unplaced, fragments };
}

function passWork(systems, width, height, cell, r) {
  const pad = Math.ceil(r / cell);
  const cols = Math.ceil(width / cell) + 2 * pad;
  const rows = Math.ceil(height / cell) + 2 * pad;
  const origin = -pad * cell;
  let stampOps = 0;
  for (let i = 0; i < systems.id.length; i += 1) {
    const x = systems.x[i];
    const y = systems.y[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const c0 = Math.max(0, Math.floor((x - r - origin) / cell));
    const c1 = Math.min(cols - 1, Math.floor((x + r - origin) / cell));
    const w0 = Math.max(0, Math.floor((y - r - origin) / cell));
    const w1 = Math.min(rows - 1, Math.floor((y + r - origin) / cell));
    if (c1 >= c0 && w1 >= w0) stampOps += (c1 - c0 + 1) * (w1 - w0 + 1);
  }
  return { cells: cols * rows, stampOps };
}

function buildTerritoryAreas(input) {
  const { systems, grid, ownerOf, opts } = input;
  const count = systems && Array.isArray(systems.id) ? systems.id.length : 0;
  if (count === 0) return { ok: false, reason: "NO_SYSTEMS" };
  const keys = new Float64Array(count);
  for (let i = 0; i < count; i += 1) keys[i] = ownerKeyOf(ownerOf(i));
  const width = Math.max(1, Number(grid && grid.width) || 1);
  const height = Math.max(1, Number(grid && grid.height) || 1);
  let cell = Math.max(opts.cellSize, Math.ceil(Math.sqrt((width * height) / opts.maxCells)));
  const maxStampOps = Number.isFinite(opts.maxStampOps) ? opts.maxStampOps : Infinity;
  const ceilCell = Math.max(width, height, opts.radius);
  let workSteps = 0;
  let last = null;
  for (let step = 0; step <= opts.maxCoarsenSteps; step += 1) {
    if (step > 0) cell *= 2;
    for (;;) {
      const work = passWork(systems, width, height, cell, Math.max(opts.radius, cell));
      if (work.cells <= opts.maxCells && work.stampOps <= maxStampOps) break;
      if (cell >= ceilCell) {
        return { ok: false, reason: "TOO_MUCH_WORK", detail: `cells=${work.cells} maxCells=${opts.maxCells} `
          + `stampOps=${work.stampOps} maxStampOps=${maxStampOps} cell=${cell}` };
      }
      cell *= 2;
      workSteps += 1;
    }
    const r = Math.max(opts.radius, cell);
    const pass = rasterPass({ systems, grid: { width, height } }, keys, cell, r, opts.simplifyPercent);
    if (pass.points <= opts.maxPoints) {
      return { ok: true, cellSize: cell, radius: r, areas: pass.areas,
        stats: { cells: pass.cells, stampOps: pass.stampOps, areas: pass.areas.length, points: pass.points,
          unplaced: pass.unplaced, fragments: pass.fragments, coarsenSteps: step, workSteps } };
    }
    last = pass;
  }
  return { ok: false, reason: "TOO_MANY_POINTS",
    detail: `points=${last.points} maxPoints=${opts.maxPoints} cell=${cell}` };
}

module.exports = { buildTerritoryAreas, SRC_WORLD, SRC_SDE };
