"use strict";

(function galaxyModule(global) {
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 80;
  const ZOOM_STEP = 1.5;
  const WHEEL_ZOOM_PER_PX = 0.0015;
  const FIT_MARGIN = 0.95;
  const HIT_CELLS = 128;
  const HIT_RADIUS_PX = 8;
  const CLICK_MOVE_PX = 4;
  const POINT_MIN_PX = 1.5;
  const POINT_MAX_PX = 5;
  const POINT_GROWTH_PER_ZOOM = 0.15;
  const SYSTEM_LABEL_ZOOM = 6;
  const LABEL_FONT = "11px system-ui, sans-serif";
  const REGION_FONT = "12px system-ui, sans-serif";
  const SECURITY_TENTHS = 10;
  const HUE_TURN = 360;
  const COLOR_RE = /^#[0-9a-f]{6}$/i;
  const RING_LINE_PX = 1.5;
  const RING_GAP_PX = 3;
  const SYSTEM_LABEL_GAP_PX = 2;
  const TOOLTIP_OFFSET_PX = 12;
  const MARK_LINE_PX = 2;
  const MARK_RING_GAP_PX = 6;
  const MARK_LABEL_FONT = "bold 11px system-ui, sans-serif";
  const MARK_LABEL_OFFSET_PX = 4;
  const MARK_DEFAULT_COLOR = "#ffffff";
  const MARK_SHAPES = Object.freeze(["ring", "diamond", "diamond2", "triangle", "versus", "square", "hexagon",
    "pip"]);
  const MARK_PIP_RADIUS_PX = 3;
  const MARK_PIP_OFFSET_PX = 7;
  const MARK_VERSUS_GAP_PX = 16;
  const MARK_VERSUS_LINE_PX = 3;
  const DEG = Math.PI / 180;
  const VERSUS_LEFT = Object.freeze([110 * DEG, 250 * DEG]);
  const VERSUS_RIGHT = Object.freeze([-70 * DEG, 70 * DEG]);
  const COLOUR_MODES = Object.freeze(["control", "security", "faction"]);
  const DEFAULT_COLOUR_MODE = "control";
  const COLOUR_MODE_STORAGE_KEY = "lne.galaxy.colourMode";
  const DASH_PATTERNS = Object.freeze({ solid: Object.freeze([]), dashed: Object.freeze([6, 4]),
    dotted: Object.freeze([1.5, 3]), dashdot: Object.freeze([6, 3, 1.5, 3]) });
  const DEFAULT_DASH = "solid";
  const MARK_SCALE_MIN = 0.5;
  const MARK_SCALE_MAX = 2;
  const MARK_DEFAULT_SCALE = 1;
  const MARK_TRIANGLE_LIFT_PX = 14;
  const MARK_TRIANGLE_HALF_PX = 5;
  const MARK_SQUARE_DROP_PX = 14;
  const MARK_SQUARE_HALF_PX = 5;
  const MARK_HEXAGON_HALF_PX = 5;
  const MARK_DEFAULT_SHAPE = "ring";
  const MARK_DIAMOND_GAP_PX = 9;
  const MARK_DOUBLE_GAP_PX = 3;
  const PATH_LINE_PX = 1.5;
  const PATH_ALPHA = 0.55;
  const FLEET_MARK_RADIUS_PX = 3.5;
  const FLEET_MARK_LABEL_OFFSET_PX = 5;
  const AREA_FILL_ALPHA = 0.18;
  const AREA_FILL_ALPHA_SDE = 0.10;
  const AREA_STROKE_ALPHA = 0.75;
  const AREA_LINE_PX = 1.5;
  const AREA_SDE_DASH_PX = Object.freeze([6, 4]);
  const AREA_MIN_RING = 6;
  const LAYER_STORAGE_PREFIX = "lne.galaxy.layer.";
  const RETRY_MAX_MANIFESTS = 12;
  const BAR_WIDTHS = Object.freeze([[2, 18], [6, 24], [Infinity, 32]]);
  const BAR_HEIGHT_PX = 5;
  const BAR_LIFT_PX = 4;
  const BAR_GAP_PX = 2;
  const BAR_MAX_LEVELS = 3;
  const BAR_RATIO_MAX = 1000;
  const BAR_TRACK = "rgba(11, 15, 20, 0.9)";
  const BAR_EDGE = Object.freeze({ ADVANCING: "rgba(230, 236, 245, 0.55)", READY: "#3fb67a", BLOCKED: "#e0a43a",
    COUNTDOWN: "rgba(139, 150, 163, 0.7)", REVERTING: "#e5534b" });
  const BAR_FILL_ALPHA = Object.freeze({ ADVANCING: 1, READY: 1, BLOCKED: 0.6, COUNTDOWN: 0.45, REVERTING: 0.6 });
  const BAR_STATE_RANK = Object.freeze(["INVASION", "OCCUPIED", "CONSOLIDATING", "CONTESTED", "RECON"]);
  const FOCUS_ZOOM = SYSTEM_LABEL_ZOOM;
  const OPS_OPEN_STORAGE_KEY = "lne.galaxy.opsOpen";
  const HOLD_REASON = "GOVERNOR_HOLD";
  const INTERIOR_HIT_PX = HIT_RADIUS_PX;
  const INTERIOR_EDGE_SLACK = 1.05;

  const BACKGROUND = "#0b0f14";
  const EDGE_INTRA = "rgba(120, 140, 170, 0.35)";
  const EDGE_INTER = "rgba(200, 120, 220, 0.45)";
  const NOT_IN_WORLD = "#4a5260";
  const NO_CONTROLLER = "#e8e8e8";
  const SELECT_RING = "#ffffff";
  const HOVER_RING = "#ffd75e";
  const REGION_LABEL = "rgba(220, 230, 245, 0.75)";
  const SYSTEM_LABEL = "rgba(230, 236, 245, 0.9)";

  const FACTION_COLORS = Object.freeze({
    500001: "#4f8fe0",
    500002: "#c0533f",
    500003: "#e0b13c",
    500004: "#3fb36b",
    500010: "#d6d640",
    500011: "#e07a2c",
    500012: "#a3202a",
    500016: "#f07fa8",
    500019: "#9a5be0",
    500020: "#7fb83a",
  });
  const SEC_COLORS = Object.freeze(["#f00000", "#d73000", "#f04800", "#f06000", "#d77700", "#efef00",
    "#8fef2f", "#00f000", "#00ef47", "#48f0c0", "#2fefef"]);
  const NULL_SEC_COLOR = "#8a1010";
  const CLASS_LABELS = Object.freeze(["highsec", "lowsec", "nullsec"]);
  const NULLSEC_CLASS = CLASS_LABELS.indexOf("nullsec");

  function retryAfter(failures) {
    return Math.min(RETRY_MAX_MANIFESTS, 2 ** Math.max(0, failures - 1));
  }
  function stateNoteOf(data) {
    if (!data || data.available) return null;
    if (data.reason === HOLD_REASON) return "state on hold (server load)";
    return `state not available: ${data.reason || "unknown"}`;
  }
  function cardDataAtMs(data, staleAgeMs, nowMs) {
    if (data && data.stale === true && typeof data.staleSinceMs === "number" && Number.isFinite(data.staleSinceMs)) {
      return data.staleSinceMs;
    }
    return nowMs - (Number(staleAgeMs) || 0);
  }
  function markShape(value) {
    return MARK_SHAPES.includes(value) ? value : MARK_DEFAULT_SHAPE;
  }
  function markScale(value) {
    return typeof value === "number" && value >= MARK_SCALE_MIN && value <= MARK_SCALE_MAX ? value : MARK_DEFAULT_SCALE;
  }
  function parseColourMode(value) {
    return COLOUR_MODES.includes(value) ? value : DEFAULT_COLOUR_MODE;
  }
  function readColourMode(storage) {
    try {
      return parseColourMode(storage ? storage.getItem(COLOUR_MODE_STORAGE_KEY) : null);
    } catch (_err) {
      return DEFAULT_COLOUR_MODE;
    }
  }
  function writeColourMode(storage, mode) {
    try {
      if (!storage) return false;
      storage.setItem(COLOUR_MODE_STORAGE_KEY, parseColourMode(mode));
      return true;
    } catch (_err) {
      return false;
    }
  }
  function readLayerEnabled(storage, layerId) {
    try {
      return (storage ? storage.getItem(`${LAYER_STORAGE_PREFIX}${layerId}`) : null) !== "0";
    } catch (_err) {
      return true;
    }
  }
  function writeLayerEnabled(storage, layerId, on) {
    try {
      if (!storage) return false;
      storage.setItem(`${LAYER_STORAGE_PREFIX}${layerId}`, on ? "1" : "0");
      return true;
    } catch (_err) {
      return false;
    }
  }
  function markDash(value) {
    return Object.prototype.hasOwnProperty.call(DASH_PATTERNS, value) ? value : DEFAULT_DASH;
  }
  function dashPattern(name) {
    return DASH_PATTERNS[markDash(name)].slice();
  }
  const isFactionId = (v) => Number.isSafeInteger(v) && v > 0;
  function ingestFactions(value) {
    if (!Array.isArray(value)) return null;
    const out = [];
    for (const entry of value) {
      if (!Array.isArray(entry) || !isFactionId(entry[0]) || !Number.isSafeInteger(entry[1]) || entry[1] < 0) continue;
      out.push([entry[0], entry[1]]);
    }
    return out.length > 0 ? out : null;
  }
  function itemColour(color, factions, mode, colourOf) {
    if (mode !== "faction") return color;
    if (Array.isArray(factions) && factions.length > 0 && isFactionId(factions[0][0])) return colourOf(factions[0][0]);
    if (isFactionId(factions)) return colourOf(factions);
    return color;
  }
  function factionLegend(stateFactions, layerFactionIds, names) {
    const nameOf = (id, given) => given || (names && names.get(id)) || `faction ${id}`;
    const rows = (Array.isArray(stateFactions) ? stateFactions : [])
      .filter((f) => Array.isArray(f) && isFactionId(f[0]))
      .map((f) => [f[0], f[1], Number(f[2]) || 0]);
    rows.sort((a, b) => b[2] - a[2] || a[0] - b[0]);
    const seen = new Set();
    const out = [];
    for (const [id, name, count] of rows) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push([id, `${nameOf(id, name)} (${count} systems)`]);
    }
    const extra = [...new Set(layerFactionIds || [])].filter((id) => isFactionId(id) && !seen.has(id));
    extra.sort((a, b) => a - b);
    for (const id of extra) out.push([id, `${nameOf(id, null)} (fleets only)`]);
    return out;
  }
  function ingestMarks(data, idToIndex) {
    const styles = new Map();
    const legend = [];
    for (const entry of Array.isArray(data && data.legend) ? data.legend : []) {
      if (!Array.isArray(entry)) continue;
      const color = safeColor(entry[2], MARK_DEFAULT_COLOR);
      const shape = markShape(entry[3]);
      const scale = markScale(entry[4]);
      const dash = markDash(entry[5]);
      styles.set(String(entry[0]), { color, shape, scale, dash });
      legend.push([String(entry[1]), color, shape, scale, dash]);
    }
    const byIndex = new Map();
    let offMap = 0;
    for (const item of Array.isArray(data && data.items) ? data.items : []) {
      if (!Array.isArray(item)) continue;
      const i = idToIndex.get(item[0]);
      if (i === undefined) {
        offMap += 1;
        continue;
      }
      const style = styles.get(String(item[1]));
      const color = style ? style.color : MARK_DEFAULT_COLOR;
      const shape = style ? style.shape : MARK_DEFAULT_SHAPE;
      const scale = style ? style.scale : MARK_DEFAULT_SCALE;
      const dash = style ? style.dash : DEFAULT_DASH;
      const label = item[2] === null || item[2] === undefined ? null : String(item[2]);
      const lines = Array.isArray(item[3]) ? item[3].map(String) : null;
      byIndex.set(i, { color, shape, scale, dash, label, lines, factions: ingestFactions(item[4]) });
    }
    return { byIndex, legend, offMap };
  }

  function ingestPaths(data, idToIndex) {
    const styles = new Map();
    const legend = [];
    for (const entry of Array.isArray(data && data.legend) ? data.legend : []) {
      if (!Array.isArray(entry)) continue;
      const color = safeColor(entry[2], MARK_DEFAULT_COLOR);
      const dash = markDash(entry[3]);
      styles.set(String(entry[0]), { color, dash });
      legend.push([String(entry[1]), color, undefined, MARK_DEFAULT_SCALE, dash]);
    }
    const items = [];
    const byIndex = new Map();
    let offMap = 0;
    for (const item of Array.isArray(data && data.items) ? data.items : []) {
      if (!Array.isArray(item) || !Array.isArray(item[0]) || item[0].length === 0) continue;
      const idx = new Int32Array(item[0].length);
      let missing = false;
      for (let k = 0; k < item[0].length; k += 1) {
        const i = idToIndex.get(item[0][k]);
        if (i === undefined) {
          missing = true;
          break;
        }
        idx[k] = i;
      }
      if (missing) {
        offMap += 1;
        continue;
      }
      const jumps = idx.length - 1;
      const raw = Number(item[2]);
      const progress = Number.isFinite(raw) ? clamp(raw, 0, 1) : 0;
      const at = idx[Math.min(jumps, Math.floor(progress * jumps))];
      const style = styles.get(String(item[1]));
      const color = style ? style.color : MARK_DEFAULT_COLOR;
      const dash = style ? style.dash : DEFAULT_DASH;
      const label = item[3] === null || item[3] === undefined ? null : String(item[3]);
      const lines = Array.isArray(item[4]) ? item[4].map(String) : null;
      const factionId = isFactionId(item[5]) ? item[5] : null;
      items.push({ idx, color, dash, factionId, progress, label, lines, at });
      const here = byIndex.get(at);
      if (here) {
        here.count += 1;
        here.label = String(here.count);
        if (lines) here.lines = (here.lines || []).concat(lines);
      } else {
        byIndex.set(at, { count: 1, label: "1", lines: lines ? lines.slice() : null });
      }
    }
    return { items, byIndex, legend, offMap };
  }

  function ingestAreas(data, idToIndex) {
    const names = new Map();
    for (const entry of Array.isArray(data && data.names) ? data.names : []) {
      if (Array.isArray(entry) && isFactionId(entry[0])) {
        names.set(entry[0], typeof entry[1] === "string" && entry[1] !== "" ? entry[1] : null);
      }
    }
    const items = [];
    const byIndex = new Map();
    const perFaction = new Map();
    let offMap = 0;
    for (const a of Array.isArray(data && data.areas) ? data.areas : []) {
      if (!Array.isArray(a) || !isFactionId(a[0]) || !Array.isArray(a[2]) || !Array.isArray(a[3])) continue;
      const rings = a[3].filter((r) => Array.isArray(r) && r.length >= AREA_MIN_RING && r.length % 2 === 0
        && r.every((v) => typeof v === "number" && Number.isFinite(v))).map((r) => r.slice());
      if (rings.length === 0) continue;
      const factionId = a[0];
      const n = a[2].length;
      items.push({ factionId, sde: a[1] === 1, rings, systems: n, path: null });
      const line = `${names.get(factionId) || `faction ${factionId}`}: area of ${n} systems`;
      for (const id of a[2]) {
        const i = idToIndex.get(id);
        if (i === undefined) offMap += 1;
        else byIndex.set(i, { label: null, lines: [line] });
      }
      const f = perFaction.get(factionId) || [factionId, names.get(factionId) || null, 0, 0];
      f[2] += 1;
      f[3] += n;
      perFaction.set(factionId, f);
    }
    if (Array.isArray(data && data.details)) {
      for (const entry of data.details) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const systemId = entry[0];
        const lines = Array.isArray(entry[1]) ? entry[1].map(String) : [];
        if (lines.length === 0) continue;
        const i = idToIndex.get(systemId);
        if (i === undefined) {
          offMap += 1;
        } else {
          byIndex.set(i, { label: null, lines });
        }
      }
    }
    const factions = [...perFaction.values()].sort((x, y) => x[0] - y[0]);
    return { items, byIndex, factions, legend: [], offMap };
  }
  function readOpsOpen(storage) {
    try {
      return (storage ? storage.getItem(OPS_OPEN_STORAGE_KEY) : null) !== "0";
    } catch (_err) {
      return true;
    }
  }
  function writeOpsOpen(storage, on) {
    try {
      if (!storage) return false;
      storage.setItem(OPS_OPEN_STORAGE_KEY, on ? "1" : "0");
      return true;
    } catch (_err) {
      return false;
    }
  }
  function barRank(state) {
    const at = BAR_STATE_RANK.indexOf(state);
    return at === -1 ? BAR_STATE_RANK.length : at;
  }
  function ingestBars(data, idToIndex) {
    const items = [];
    const byIndex = new Map();
    let offMap = 0;
    for (const item of Array.isArray(data && data.items) ? data.items : []) {
      if (!item || typeof item !== "object") continue;
      const i = idToIndex.get(item.systemId);
      if (i === undefined) {
        offMap += 1;
        continue;
      }
      const entry = { ...item, i, ratio: clamp(Number(item.ratio) || 0, 0, BAR_RATIO_MAX) };
      items.push(entry);
      byIndex.set(i, entry);
    }
    items.sort((a, b) => barRank(a.state) - barRank(b.state) || b.ratio - a.ratio || a.systemId - b.systemId);
    const maxDrawn = Number.isSafeInteger(data && data.maxDrawn) && data.maxDrawn > 0 ? data.maxDrawn : 0;
    return { items, byIndex, legend: [], offMap, maxDrawn };
  }
  function barWidth(zoom) {
    for (const [below, width] of BAR_WIDTHS) if (zoom < below) return width;
    return BAR_WIDTHS[BAR_WIDTHS.length - 1][1];
  }
  function placeBar(placed, x, y, w) {
    for (let level = 0; level < BAR_MAX_LEVELS; level += 1) {
      const top = y - level * (BAR_HEIGHT_PX + BAR_GAP_PX);
      const hit = placed.some((p) => x < p.x + p.w && p.x < x + w
        && top < p.y + BAR_HEIGHT_PX && p.y < top + BAR_HEIGHT_PX);
      if (!hit) {
        placed.push({ x, y: top, w });
        return top;
      }
    }
    return null;
  }
  function areaPath(rings) {
    const path = new Path2D();
    for (const r of rings) {
      const n = r.length / 2;
      const mx = (k) => (r[2 * (k % n)] + r[2 * ((k + 1) % n)]) / 2;
      const my = (k) => (r[2 * (k % n) + 1] + r[2 * ((k + 1) % n) + 1]) / 2;
      path.moveTo(mx(n - 1), my(n - 1));
      for (let k = 0; k < n; k += 1) path.quadraticCurveTo(r[2 * k], r[2 * k + 1], mx(k), my(k));
      path.closePath();
    }
    return path;
  }

  const LAYER_KINDS = {
    bars: {
      ingest: ingestBars,
      fetchAlways: true,
      draw(layer, env) {
        const c = env.ctx;
        const w = barWidth(env.zoom);
        const placed = [];
        let drawn = 0;
        c.lineWidth = 1;
        for (const item of layer.items) {
          if (drawn >= layer.maxDrawn) break;
          if (!env.visible(item.i)) continue;
          const p = env.screen(item.i);
          if (p === null) continue;
          const x = Math.round(p.sx - w / 2);
          const y = placeBar(placed, x, Math.round(p.sy - env.size - BAR_LIFT_PX - BAR_HEIGHT_PX), w);
          if (y === null) continue;
          const ratio = item.ratio / BAR_RATIO_MAX;
          c.fillStyle = BAR_TRACK;
          c.fillRect(x, y, w, BAR_HEIGHT_PX);
          c.globalAlpha = BAR_FILL_ALPHA[item.status] ?? 1;
          c.fillStyle = env.colourOf(item.attacker);
          c.fillRect(x + 1, y + 1, Math.max(ratio > 0 ? 1 : 0, (w - 2) * ratio), BAR_HEIGHT_PX - 2);
          c.globalAlpha = 1;
          c.strokeStyle = BAR_EDGE[item.status] || BAR_EDGE.ADVANCING;
          c.strokeRect(x + 0.5, y + 0.5, w - 1, BAR_HEIGHT_PX - 1);
          drawn += 1;
        }
      },
      linesAt(layer, i) {
        const item = layer.byIndex.get(i);
        const card = global.LneSystemCard;
        return item && card ? { label: null, lines: [card._pure.barLine(item)] } : null;
      },
    },
    areas: {
      ingest: ingestAreas,
      under: true,
      draw() {},
      drawUnder(layer, env) {
        const c = env.ctx;
        c.lineJoin = "round";
        c.lineWidth = AREA_LINE_PX / env.k;
        for (const item of layer.items) {
          if (item.path === null) item.path = areaPath(item.rings);
          const color = env.colourOf(item.factionId);
          c.fillStyle = color;
          c.globalAlpha = item.sde ? AREA_FILL_ALPHA_SDE : AREA_FILL_ALPHA;
          c.fill(item.path, "evenodd");
          c.strokeStyle = color;
          c.globalAlpha = AREA_STROKE_ALPHA;
          c.setLineDash(item.sde ? AREA_SDE_DASH_PX.map((px) => px / env.k) : []);
          c.stroke(item.path);
        }
        c.globalAlpha = 1;
        c.setLineDash([]);
        c.lineJoin = "miter";
      },
      linesAt(layer, i) {
        return layer.byIndex.get(i) || null;
      },
    },
    paths: {
      ingest: ingestPaths,
      draw(layer, env) {
        const c = env.ctx;
        c.font = MARK_LABEL_FONT;
        c.textAlign = "left";
        c.textBaseline = "middle";
        for (const item of layer.items) {
          if (!env.visible(item.at)) continue;
          const pts = Array.from(item.idx, (i) => env.point(i));
          const color = itemColour(item.color, item.factionId, env.mode, env.colourOf);
          c.globalAlpha = PATH_ALPHA;
          c.strokeStyle = color;
          c.lineWidth = PATH_LINE_PX;
          c.setLineDash(env.mode === "faction" ? dashPattern(item.dash) : []);
          c.beginPath();
          c.moveTo(pts[0].sx, pts[0].sy);
          for (let k = 1; k < pts.length; k += 1) c.lineTo(pts[k].sx, pts[k].sy);
          c.stroke();
          c.setLineDash([]);
          c.globalAlpha = 1;
          const jumps = pts.length - 1;
          let x = pts[0].sx;
          let y = pts[0].sy;
          if (jumps > 0) {
            const s = Math.min(jumps - 1, Math.floor(item.progress * jumps));
            const f = item.progress * jumps - s;
            x = pts[s].sx + (pts[s + 1].sx - pts[s].sx) * f;
            y = pts[s].sy + (pts[s + 1].sy - pts[s].sy) * f;
          }
          c.fillStyle = color;
          c.beginPath();
          c.arc(x, y, FLEET_MARK_RADIUS_PX, 0, Math.PI * 2);
          c.fill();
          if (item.label !== null) c.fillText(item.label, x + FLEET_MARK_RADIUS_PX + FLEET_MARK_LABEL_OFFSET_PX, y);
        }
      },
      linesAt(layer, i) {
        const here = layer.byIndex.get(i);
        return here ? { label: here.label, lines: here.lines } : null;
      },
    },
    marks: {
      ingest: ingestMarks,
      draw(layer, env) {
        const c = env.ctx;
        c.lineWidth = MARK_LINE_PX;
        c.font = MARK_LABEL_FONT;
        c.textBaseline = "middle";
        const faction = env.mode === "faction";
        const diamond = (x, y, r) => {
          c.moveTo(x, y - r);
          c.lineTo(x + r, y);
          c.lineTo(x, y + r);
          c.lineTo(x - r, y);
          c.closePath();
        };
        for (const [i, mark] of layer.byIndex) {
          if (!env.visible(i)) continue;
          const p = env.screen(i);
          if (p === null) continue;
          const color = itemColour(mark.color, mark.factions, env.mode, env.colourOf);
          c.setLineDash(faction ? dashPattern(mark.dash) : []);
          if (mark.shape === "versus") {
            const r = env.size + MARK_VERSUS_GAP_PX;
            const fa = faction && mark.factions ? mark.factions[0] : null;
            const fb = faction && mark.factions && mark.factions.length > 1 ? mark.factions[1] : null;
            c.lineWidth = MARK_VERSUS_LINE_PX;
            c.strokeStyle = fa ? env.colourOf(fa[0]) : mark.color;
            c.beginPath();
            c.arc(p.sx, p.sy, r, VERSUS_LEFT[0], VERSUS_LEFT[1]);
            c.stroke();
            c.strokeStyle = fb ? env.colourOf(fb[0]) : mark.color;
            c.beginPath();
            c.arc(p.sx, p.sy, r, VERSUS_RIGHT[0], VERSUS_RIGHT[1]);
            c.stroke();
            c.lineWidth = MARK_LINE_PX;
            c.setLineDash([]);
            if (mark.label !== null) {
              c.fillStyle = mark.color;
              c.textAlign = "center";
              c.fillText(mark.label, p.sx, p.sy + r + MARK_LABEL_OFFSET_PX);
            }
            continue;
          }
          if (mark.shape === "triangle") {
            const h = MARK_TRIANGLE_HALF_PX * mark.scale;
            const cy = p.sy - (env.size + MARK_TRIANGLE_LIFT_PX);
            c.strokeStyle = color;
            c.beginPath();
            c.moveTo(p.sx - h, cy - h);
            c.lineTo(p.sx + h, cy - h);
            c.lineTo(p.sx, cy + h);
            c.closePath();
            c.stroke();
            c.setLineDash([]);
            if (mark.label !== null) {
              c.fillStyle = color;
              c.textAlign = "center";
              c.fillText(mark.label, p.sx, cy - h - MARK_LABEL_OFFSET_PX - MARK_TRIANGLE_HALF_PX);
            }
            continue;
          }
          if (mark.shape === "square") {
            const h = MARK_SQUARE_HALF_PX * mark.scale;
            const cy = p.sy + env.size + MARK_SQUARE_DROP_PX;
            c.strokeStyle = color;
            c.strokeRect(p.sx - h, cy - h, 2 * h, 2 * h);
            c.setLineDash([]);
            if (mark.label !== null) {
              c.fillStyle = color;
              c.textAlign = "left";
              c.fillText(mark.label, p.sx + h + MARK_LABEL_OFFSET_PX, cy);
            }
            continue;
          }
          if (mark.shape === "hexagon") {
            const h = MARK_HEXAGON_HALF_PX * mark.scale;
            const cy = p.sy + env.size + MARK_SQUARE_DROP_PX;
            c.strokeStyle = color;
            c.beginPath();
            c.moveTo(p.sx, cy - h);
            c.lineTo(p.sx + h * 0.866, cy - h * 0.5);
            c.lineTo(p.sx + h * 0.866, cy + h * 0.5);
            c.lineTo(p.sx, cy + h);
            c.lineTo(p.sx - h * 0.866, cy + h * 0.5);
            c.lineTo(p.sx - h * 0.866, cy - h * 0.5);
            c.closePath();
            c.stroke();
            c.setLineDash([]);
            if (mark.label !== null) {
              c.fillStyle = color;
              c.textAlign = "left";
              c.fillText(mark.label, p.sx + h * 0.866 + MARK_LABEL_OFFSET_PX, cy);
            }
            continue;
          }
          if (mark.shape === "pip") {
            const r = MARK_PIP_RADIUS_PX * mark.scale;
            const cx = p.sx + env.size + MARK_PIP_OFFSET_PX;
            const cy = p.sy - env.size - MARK_PIP_OFFSET_PX;
            c.setLineDash([]);
            c.fillStyle = color;
            c.beginPath();
            c.arc(cx, cy, r, 0, Math.PI * 2);
            c.fill();
            if (mark.label !== null) {
              c.textAlign = "left";
              c.fillText(mark.label, cx + r + MARK_LABEL_OFFSET_PX, cy);
            }
            continue;
          }
          const ring = mark.shape === MARK_DEFAULT_SHAPE;
          const r = env.size + (ring ? MARK_RING_GAP_PX : MARK_DIAMOND_GAP_PX);
          c.strokeStyle = color;
          c.beginPath();
          if (ring) c.arc(p.sx, p.sy, r, 0, Math.PI * 2);
          else diamond(p.sx, p.sy, r);
          if (mark.shape === "diamond2") diamond(p.sx, p.sy, r + MARK_DOUBLE_GAP_PX);
          c.stroke();
          c.setLineDash([]);
          if (mark.label !== null) {
            c.fillStyle = color;
            c.textAlign = ring ? "left" : "right";
            c.fillText(mark.label, ring ? p.sx + r + MARK_LABEL_OFFSET_PX : p.sx - r - MARK_LABEL_OFFSET_PX, p.sy);
          }
        }
      },
      linesAt(layer, i) {
        const mark = layer.byIndex.get(i);
        return mark ? { label: mark.label, lines: mark.lines } : null;
      },
    },
  };

  function hashHue(id) {
    let h = 2166136261;
    const text = String(id);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h % HUE_TURN;
  }
  function factionColor(id) {
    const fixed = FACTION_COLORS[id];
    return fixed || `hsl(${hashHue(id)}, 65%, 58%)`;
  }
  function secColor(tenths, cls) {
    if (cls === NULLSEC_CLASS) return NULL_SEC_COLOR;
    if (tenths <= 0) return tenths === 0 ? SEC_COLORS[0] : NULL_SEC_COLOR;
    return SEC_COLORS[Math.min(SEC_COLORS.length - 1, tenths)];
  }
  function safeColor(value, fallback) {
    return typeof value === "string" && COLOR_RE.test(value) ? value : fallback;
  }
  function fitTransform(width, height, cw, ch) {
    const k = Math.min(cw / Math.max(1, width), ch / Math.max(1, height)) * FIT_MARGIN;
    return { k, ox: (cw - width * k) / 2, oy: (ch - height * k) / 2 };
  }
  function canFit(cw, ch) {
    return Number.isFinite(cw) && Number.isFinite(ch) && cw > 1 && ch > 1;
  }
  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }
  function zoomAt(view, factor, mx, my, kFit, zoomMax = ZOOM_MAX) {
    const k = clamp(view.k * factor, kFit * ZOOM_MIN, kFit * zoomMax);
    const f = k / view.k;
    return { k, ox: mx - (mx - view.ox) * f, oy: my - (my - view.oy) * f };
  }
  function ingestStatic(data) {
    const s = data.systems;
    const n = s.count;
    const x = Int32Array.from(s.x);
    const y = Int32Array.from(s.y);
    const idIndex = new Map();
    for (let i = 0; i < n; i += 1) idIndex.set(s.id[i], i);
    const regionNames = data.regions.map((r) => r[1]);
    const sums = data.regions.map(() => ({ x: 0, y: 0, n: 0 }));
    for (let i = 0; i < n; i += 1) {
      const c = sums[s.region[i]];
      c.x += x[i];
      c.y += y[i];
      c.n += 1;
    }
    const regionCenters = sums.map((c, i) => ({ name: regionNames[i], x: c.n ? c.x / c.n : 0,
      y: c.n ? c.y / c.n : 0, n: c.n }));
    const cell = Math.max(1, Math.ceil(Math.max(data.grid.width, 1) / HIT_CELLS));
    const cols = Math.floor(data.grid.width / cell) + 1;
    const hit = new Map();
    for (let i = 0; i < n; i += 1) {
      const key = Math.floor(y[i] / cell) * cols + Math.floor(x[i] / cell);
      const list = hit.get(key);
      if (list) list.push(i);
      else hit.set(key, [i]);
    }
    return { key: data.key, n, x, y, id: s.id, sec: s.sec, cls: s.cls, region: s.region, name: s.name,
      regionNames, regionCenters, edges: Uint32Array.from(data.edges), grid: data.grid, idIndex,
      hit: { cell, cols, buckets: hit }, stats: data.stats || null };
  }
  function nearest(st, gx, gy, r, visible) {
    const { cell, cols, buckets } = st.hit;
    const c0 = Math.floor((gx - r) / cell);
    const c1 = Math.floor((gx + r) / cell);
    const r0 = Math.floor((gy - r) / cell);
    const r1 = Math.floor((gy + r) / cell);
    let best = -1;
    let bestD = r * r;
    for (let row = r0; row <= r1; row += 1) {
      for (let col = c0; col <= c1; col += 1) {
        if (col < 0 || col >= cols || row < 0) continue;
        const list = buckets.get(row * cols + col);
        if (!list) continue;
        for (const i of list) {
          if (!visible(i)) continue;
          const dx = st.x[i] - gx;
          const dy = st.y[i] - gy;
          const d = dx * dx + dy * dy;
          if (d <= bestD) {
            bestD = d;
            best = i;
          }
        }
      }
    }
    return best;
  }

  function createPanel(h) {
    const { el, clear, fmtNum, getJson } = h;
    const ui = {
      manifest: null, static: null, staticPending: false, staticNote: "waiting for map data",
      state: null, stateKey: undefined, statePending: false, stateNote: null,
      mode: "control", classes: [true, true, true],
      view: null, kFit: 1, fitted: false, cssW: 0, cssH: 0, dpr: 1,
      selectedId: null, hover: -1, drag: null, focusWanted: null,
      buckets: [], paths: null, drawQueued: false,
      seq: 0, staticRetry: { failures: 0, retryAt: 0 }, stateRetry: { failures: 0, retryAt: 0 },
      layers: new Map(),
      layerBarSig: null,
      card: { id: null, data: null, pending: false, token: 0, fetchedAtMs: 0, dataAtMs: 0, failures: 0, retryAt: 0 },
      interior: { id: null, data: null, pending: false, token: 0, fetchedAtMs: 0, failures: 0, retryAt: 0,
        message: null, layout: null, layoutSig: null, hoverKey: null, disc: null },
      opButtons: new Map(),
    };

    const errorSlot = el("div", { cls: "card-error hidden" });
    const status = el("div", { cls: "note" });
    const bar = el("div", { cls: "gx-bar" });
    const canvas = document.createElement("canvas");
    canvas.setAttribute("class", "gx-canvas");
    const tooltip = el("div", { cls: "gx-tooltip hidden" });
    const wrap = el("div", { cls: "gx-wrap" }, [canvas, tooltip]);
    const legend = el("div", { cls: "gx-legend" });
    const detailBox = el("div", { cls: "gx-details hidden" });
    const opsTitle = el("summary", { text: "Takeovers in progress" });
    const opsList = el("div");
    const ops = el("details", { cls: "gx-ops hidden" }, [opsTitle, opsList]);
    const card = global.LneSystemCard ? global.LneSystemCard.createCard({ el, clear, fmtNum,
      colourOf: (id) => colourOfFaction(id), secColor, factionName: (id) => factionName(id),
      systemName: (id) => systemNameOf(id) }) : null;
    const side = el("div", { cls: "gx-side hidden" }, [ops, card ? card.root : null]);
    const stage = el("div", { cls: "gx-stage gx-stage--full" }, [wrap, side]);
    const root = el("div", { cls: "gx" }, [errorSlot, status, bar, stage, legend, detailBox]);
    const ctx = canvas.getContext("2d");

    const classBoxes = CLASS_LABELS.map((label, i) => {
      const box = document.createElement("input");
      box.setAttribute("type", "checkbox");
      box.checked = true;
      box.addEventListener("change", () => {
        ui.classes[i] = box.checked;
        ui.paths = null;
        rebuildBuckets();
        if (ui.selectedId !== null && selectedIndex() === -1) clearSelection();
        requestDraw();
      });
      return el("label", { cls: "gx-check" }, [box, el("span", { text: label })]);
    });
    const storage = (() => {
      try {
        return global.localStorage || null;
      } catch (_err) {
        return null;
      }
    })();
    ui.mode = readColourMode(storage);
    ops.open = readOpsOpen(storage);
    ops.addEventListener("toggle", () => writeOpsOpen(storage, ops.open));
    const modeSelect = el("select", { cls: "ctl-select" });
    for (const [value, text] of [["control", "colour: control"], ["security", "colour: security"],
      ["faction", "colour: faction (fleets + battles)"]]) {
      const option = el("option", { text });
      option.setAttribute("value", value);
      modeSelect.appendChild(option);
    }
    modeSelect.value = ui.mode;
    modeSelect.addEventListener("change", () => {
      ui.mode = parseColourMode(modeSelect.value);
      writeColourMode(storage, ui.mode);
      rebuildBuckets();
      drawLegend();
      requestDraw();
    });
    const button = (text, title, fn) => {
      const b = el("button", { cls: "gx-btn", text, title });
      b.setAttribute("type", "button");
      b.addEventListener("click", fn);
      return b;
    };
    const layerBox = el("span", { cls: "gx-layers" });
    bar.appendChild(el("span", { cls: "gx-group" }, classBoxes));
    bar.appendChild(modeSelect);
    bar.appendChild(el("span", { cls: "gx-group" }, [
      button("+", "Zoom in", () => zoomCenter(ZOOM_STEP)),
      button("−", "Zoom out", () => zoomCenter(1 / ZOOM_STEP)),
      button("Fit", "Show the whole map", () => { fit(); requestDraw(); }),
    ]));
    bar.appendChild(layerBox);

    function factionName(id) {
      if (id === null || id === undefined) return "-";
      const name = ui.state && ui.state.names.get(id);
      return name || `faction ${id}`;
    }
    function rowOf(i) {
      return ui.state ? ui.state.byId.get(ui.static.id[i]) : undefined;
    }
    function systemNameOf(id) {
      const i = ui.static ? ui.static.idIndex.get(id) : undefined;
      return i === undefined ? `system ${id}` : ui.static.name[i];
    }
    const factionColours = new Map();
    function colourOfFaction(id) {
      let c = factionColours.get(id);
      if (c === undefined) {
        c = factionColor(id);
        factionColours.set(id, c);
      }
      return c;
    }
    function colorOf(i) {
      if (ui.mode === "security") return secColor(ui.static.sec[i], ui.static.cls[i]);
      const row = rowOf(i);
      if (!row) return NOT_IN_WORLD;
      return row[1] === null ? NO_CONTROLLER : colourOfFaction(row[1]);
    }
    function visible(i) {
      return ui.classes[ui.static.cls[i]] === true;
    }

    function rebuildBuckets() {
      const st = ui.static;
      if (!st) return;
      const byColor = new Map();
      for (let i = 0; i < st.n; i += 1) {
        if (!visible(i)) continue;
        const c = colorOf(i);
        const list = byColor.get(c);
        if (list) list.push(i);
        else byColor.set(c, [i]);
      }
      ui.buckets = [...byColor];
    }
    function buildPaths() {
      const st = ui.static;
      const intra = new Path2D();
      const inter = new Path2D();
      for (let e = 0; e < st.edges.length; e += 2) {
        const a = st.edges[e];
        const b = st.edges[e + 1];
        if (!visible(a) || !visible(b)) continue;
        const p = st.region[a] === st.region[b] ? intra : inter;
        p.moveTo(st.x[a], st.y[a]);
        p.lineTo(st.x[b], st.y[b]);
      }
      ui.paths = { intra, inter };
    }

    function fit() {
      if (!ui.static || !canFit(ui.cssW, ui.cssH)) return;
      const t = fitTransform(ui.static.grid.width, ui.static.grid.height, ui.cssW, ui.cssH);
      ui.kFit = t.k;
      ui.view = t;
      ui.fitted = true;
    }
    function interiorCfg() {
      const m = ui.manifest;
      return global.LneSystemInterior && m && m.ui && m.ui.systemInterior ? m.ui.systemInterior : null;
    }
    function zoomMaxOf() {
      const cfg = interiorCfg();
      const zoomMax = cfg ? Number(cfg.zoomMax) : NaN;
      return Number.isFinite(zoomMax) ? Math.max(ZOOM_MAX, zoomMax) : ZOOM_MAX;
    }
    function screenOf(i) {
      const v = ui.view;
      return { sx: ui.static.x[i] * v.k + v.ox, sy: ui.static.y[i] * v.k + v.oy };
    }
    function syncInterior() {
      const it = ui.interior;
      const cfg = interiorCfg();
      let next = null;
      const pure = cfg ? global.LneSystemInterior._pure : null;
      if (cfg && ui.static && ui.view && ui.view.k / ui.kFit >= pure.leaveZoom(cfg)) {
        const sel = selectedIndex();
        const { gx, gy } = toGrid(ui.cssW / 2, ui.cssH / 2);
        const near = nearest(ui.static, gx, gy, Number(cfg.pickPx) / ui.view.k, visible);
        const zoomRel = ui.view.k / ui.kFit;
        const R = pure.discRadius(zoomRel, cfg);
        const discSeen = (i) => {
          const p = screenOf(i);
          return pure.discOnScreen(p.sx, p.sy, R, ui.cssW, ui.cssH, 0);
        };
        const prevIdx = it.id === null ? undefined : ui.static.idIndex.get(it.id);
        next = pure.interiorTarget({ prevId: it.id, zoomRel, cfg,
          selectedOnScreenId: sel !== -1 && discSeen(sel) ? ui.selectedId : null,
          prevDiscOnScreen: prevIdx !== undefined && discSeen(prevIdx),
          nearestCenterId: near === -1 ? null : ui.static.id[near] });
        if (next !== null && ui.static.idIndex.get(next) === undefined) next = null;
      }
      if (next === it.id) return;
      it.id = next;
      it.token += 1;
      it.pending = false;
      it.hoverKey = null;
      if (next === null) return;
      it.failures = 0;
      it.retryAt = 0;
      it.message = null;
      loadInterior(next);
    }
    function interiorFailed(id, text) {
      const it = ui.interior;
      it.pending = false;
      it.failures += 1;
      it.retryAt = ui.seq + retryAfter(it.failures);
      it.fetchedAtMs = Date.now();
      it.message = `Could not fetch the data: ${text}`;
      if (!it.data || it.data.systemId !== id) it.data = null;
      requestDraw();
    }
    function loadInterior(id) {
      const it = ui.interior;
      it.token += 1;
      const token = it.token;
      it.pending = true;
      getJson(`/api/views/system-interior?system=${id}`).then((r) => {
        if (token !== it.token) return;
        it.pending = false;
        if (!r.body || r.body.ok !== true) {
          interiorFailed(id, failText(r));
          return;
        }
        it.failures = 0;
        it.retryAt = 0;
        it.fetchedAtMs = Date.now();
        const data = r.body.data || {};
        const own = it.data !== null && it.data.systemId === id;
        if (data.available !== false) {
          it.data = data;
          it.layoutSig = null;
          it.message = data.statics ? null : global.LneSystemCard && global.LneSystemCard._pure
            ? global.LneSystemCard._pure.messageFor(data.staticsReason) : String(data.staticsReason || "");
        } else if (!(data.reason === HOLD_REASON && own)) {
          it.message = global.LneSystemCard && global.LneSystemCard._pure
            ? global.LneSystemCard._pure.messageFor(data.reason) : String(data.reason || "");
          if (!own) it.data = null;
        }
        requestDraw();
      }).catch((err) => {
        if (token === it.token) interiorFailed(id, err && err.message);
      });
    }
    function refreshInterior(m) {
      const it = ui.interior;
      const cfg = m && m.ui ? m.ui.systemInterior : null;
      if (!cfg || it.id === null || it.pending || ui.seq < it.retryAt) return;
      if (Date.now() - it.fetchedAtMs >= cfg.refreshMs) loadInterior(it.id);
    }
    function drawInterior() {
      const it = ui.interior;
      it.disc = null;
      syncInterior();
      const cfg = interiorCfg();
      if (!cfg || it.id === null) return;
      const i = ui.static.idIndex.get(it.id);
      if (i === undefined) return;
      const { sx, sy } = screenOf(i);
      const zoomRel = ui.view.k / ui.kFit;
      const R = global.LneSystemInterior._pure.discRadius(zoomRel, cfg);
      const data = it.data && it.data.systemId === it.id ? it.data : null;
      const sig = data ? `${data.key}|${data.systemId}|${Math.round(R)}` : null;
      if (sig !== it.layoutSig) {
        it.layout = data ? global.LneSystemInterior._pure.layoutInterior(data, Math.round(R), cfg.logBaseMilliAu,
        cfg.moonRingPermille) : null;
        it.layoutSig = sig;
      }
      it.disc = { cx: sx, cy: sy, R };
      global.LneSystemInterior.draw(ctx, data ? it.layout : null, { cx: sx, cy: sy, R,
        title: (data && data.name) || ui.static.name[i], message: it.message, hoverKey: it.hoverKey,
        colourOf: colourOfFaction, viewW: ui.cssW, viewH: ui.cssH });
    }
    function interiorHit(mx, my) {
      const it = ui.interior;
      const d = it.disc;
      if (!d || it.id === null || Math.hypot(mx - d.cx, my - d.cy) > d.R * INTERIOR_EDGE_SLACK) {
        return { inside: false, item: null };
      }
      const item = it.layout ? global.LneSystemInterior.hitTest(it.layout, d.cx, d.cy, mx, my, INTERIOR_HIT_PX) : null;
      return { inside: true, item };
    }
    function zoomCenter(factor) {
      if (!ui.view) return;
      ui.view = zoomAt(ui.view, factor, ui.cssW / 2, ui.cssH / 2, ui.kFit, zoomMaxOf());
      requestDraw();
    }
    function resize() {
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(1, Math.round(rect.width));
      const hgt = Math.max(1, Math.round(rect.height));
      const dpr = global.devicePixelRatio || 1;
      if (w === ui.cssW && hgt === ui.cssH && dpr === ui.dpr) return;
      ui.cssW = w;
      ui.cssH = hgt;
      ui.dpr = dpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hgt * dpr);
      if (ui.static && !ui.fitted) {
        fit();
        applyFocusWanted();
      }
      else if (ui.static && canFit(w, hgt)) ui.kFit = fitTransform(ui.static.grid.width, ui.static.grid.height, w, hgt).k;
      requestDraw();
    }
    function toGrid(mx, my) {
      return { gx: (mx - ui.view.ox) / ui.view.k, gy: (my - ui.view.oy) / ui.view.k };
    }
    function pick(mx, my) {
      if (!ui.static || !ui.view) return -1;
      const { gx, gy } = toGrid(mx, my);
      return nearest(ui.static, gx, gy, HIT_RADIUS_PX / ui.view.k, visible);
    }
    function selectedIndex() {
      if (ui.selectedId === null || !ui.static) return -1;
      const i = ui.static.idIndex.get(ui.selectedId);
      return i === undefined || !visible(i) ? -1 : i;
    }

    function requestDraw() {
      if (ui.drawQueued) return;
      ui.drawQueued = true;
      global.requestAnimationFrame(() => {
        ui.drawQueued = false;
        try {
          draw();
        } catch (err) {
          error(`draw failed: ${err && err.message}`);
        }
      });
    }
    function pointSize() {
      const zoom = ui.view.k / ui.kFit;
      return clamp(POINT_MIN_PX + (zoom - 1) * POINT_GROWTH_PER_ZOOM, POINT_MIN_PX, POINT_MAX_PX);
    }
    function ring(i, color, size) {
      const v = ui.view;
      ctx.strokeStyle = color;
      ctx.lineWidth = RING_LINE_PX;
      ctx.beginPath();
      ctx.arc(ui.static.x[i] * v.k + v.ox, ui.static.y[i] * v.k + v.oy, size + RING_GAP_PX, 0, Math.PI * 2);
      ctx.stroke();
    }
    function shownLayers() {
      return [...ui.layers.values()].filter((l) => l.enabled && l.data !== null);
    }
    function drawLayerMarks(size) {
      const st = ui.static;
      const v = ui.view;
      const env = {
        ctx,
        visible,
        size,
        zoom: v.k / ui.kFit,
        mode: ui.mode,
        colourOf: colourOfFaction,
        screen(i) {
          const sx = st.x[i] * v.k + v.ox;
          const sy = st.y[i] * v.k + v.oy;
          if (sx < -size || sy < -size || sx > ui.cssW + size || sy > ui.cssH + size) return null;
          return { sx, sy };
        },
        point(i) {
          return { sx: st.x[i] * v.k + v.ox, sy: st.y[i] * v.k + v.oy };
        },
      };
      for (const l of shownLayers()) if (!LAYER_KINDS[l.kind].under) LAYER_KINDS[l.kind].draw(l.data, env);
    }
    function drawLayersUnder() {
      const env = { ctx, k: ui.view.k, colourOf: colourOfFaction };
      for (const l of shownLayers()) if (LAYER_KINDS[l.kind].under) LAYER_KINDS[l.kind].drawUnder(l.data, env);
    }
    function draw() {
      const dpr = ui.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const st = ui.static;
      if (!st || !ui.view) return;
      const v = ui.view;
      if (!ui.paths) buildPaths();
      ctx.setTransform(v.k * dpr, 0, 0, v.k * dpr, v.ox * dpr, v.oy * dpr);
      drawLayersUnder();
      ctx.lineWidth = 1 / v.k;
      ctx.strokeStyle = EDGE_INTRA;
      ctx.stroke(ui.paths.intra);
      ctx.strokeStyle = EDGE_INTER;
      ctx.stroke(ui.paths.inter);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = pointSize();
      const half = size / 2;
      const shown = [];
      for (const [color, list] of ui.buckets) {
        ctx.fillStyle = color;
        for (const i of list) {
          const sx = st.x[i] * v.k + v.ox;
          const sy = st.y[i] * v.k + v.oy;
          if (sx < -size || sy < -size || sx > ui.cssW + size || sy > ui.cssH + size) continue;
          ctx.fillRect(sx - half, sy - half, size, size);
          shown.push(i);
        }
      }
      drawLayerMarks(size);
      const sel = selectedIndex();
      if (ui.hover !== -1 && ui.hover !== sel) ring(ui.hover, HOVER_RING, size);
      if (sel !== -1) ring(sel, SELECT_RING, size);
      drawLabels(shown);
      drawInterior();
    }
    function drawLabels(shown) {
      const v = ui.view;
      const st = ui.static;
      ctx.textBaseline = "middle";
      if (v.k / ui.kFit < SYSTEM_LABEL_ZOOM) {
        ctx.font = REGION_FONT;
        ctx.fillStyle = REGION_LABEL;
        ctx.textAlign = "center";
        for (const c of st.regionCenters) {
          if (!c.name || c.n === 0) continue;
          ctx.fillText(c.name, c.x * v.k + v.ox, c.y * v.k + v.oy);
        }
        return;
      }
      const max = ui.manifest && ui.manifest.ui ? ui.manifest.ui.maxLabels : 0;
      ctx.font = LABEL_FONT;
      ctx.fillStyle = SYSTEM_LABEL;
      ctx.textAlign = "left";
      const offset = pointSize() + SYSTEM_LABEL_GAP_PX;
      for (let n = 0; n < shown.length && n < max; n += 1) {
        const i = shown[n];
        ctx.fillText(st.name[i], st.x[i] * v.k + v.ox + offset, st.y[i] * v.k + v.oy);
      }
    }

    function swatch(color, shape, dash) {
      if (shape === "versus") {
        const v = el("span", { cls: "gx-swatch gx-swatch-versus" });
        v.style.borderLeftColor = color;
        v.style.borderRightColor = color;
        return v;
      }
      const diamond = shape !== undefined && shape !== MARK_DEFAULT_SHAPE && shape !== "triangle"
        && shape !== "square" && shape !== "pip";
      let cls = shape === "triangle" ? "gx-swatch gx-swatch-triangle" : (diamond ? "gx-swatch gx-swatch-diamond"
        : "gx-swatch");
      if (shape === "square") cls = "gx-swatch gx-swatch-square";
      if (shape === "hexagon") cls = "gx-swatch gx-swatch-hexagon";
      if (shape === "pip") cls = "gx-swatch gx-swatch-pip";
      const outlined = dash !== undefined && markDash(dash) !== DEFAULT_DASH && shape !== "triangle"
        && shape !== "pip";
      if (outlined) cls += ` gx-swatch-dash-${markDash(dash)}`;
      const s = el("span", { cls });
      if (outlined) s.style.borderColor = color;
      else s.style.backgroundColor = color;
      return s;
    }
    function legendItem(color, text, shape, dash) {
      return el("span", { cls: "gx-legend-item" }, [swatch(color, shape, dash), el("span", { text })]);
    }
    function drawLayerLegend(neutral) {
      for (const l of shownLayers()) {
        if (l.kind === "areas") {
          for (const [id, name, areas, systems] of l.data.factions) {
            const known = ui.state && ui.state.names.get(id);
            legend.appendChild(legendItem(colourOfFaction(id),
              `${l.title}: ${known || name || `faction ${id}`} (${fmtNum(areas)} areas, ${fmtNum(systems)} systems)`));
          }
          continue;
        }
        for (const [label, color, shape, , dash] of l.data.legend) {
          legend.appendChild(neutral ? legendItem(MARK_DEFAULT_COLOR, `${l.title}: ${label}`, shape, dash)
            : legendItem(color, `${l.title}: ${label}`, shape));
        }
      }
    }
    function layerFactionIds() {
      const ids = new Set();
      for (const l of shownLayers()) {
        if (l.kind === "marks") {
          for (const mark of l.data.byIndex.values()) for (const [id] of mark.factions || []) ids.add(id);
        } else if (l.kind === "paths") {
          for (const item of l.data.items) if (item.factionId !== null) ids.add(item.factionId);
        }
      }
      return ids;
    }
    function drawLegend() {
      clear(legend);
      if (ui.mode === "security") {
        for (let t = 10; t >= 1; t -= 1) legend.appendChild(legendItem(secColor(t), (t / SECURITY_TENTHS).toFixed(1)));
        legend.appendChild(legendItem(secColor(0), "0.0"));
        legend.appendChild(legendItem(NULL_SEC_COLOR, "< 0.0"));
        drawLayerLegend();
        return;
      }
      const st = ui.static;
      let notInWorld = 0;
      let noController = 0;
      if (st) {
        for (let i = 0; i < st.n; i += 1) {
          const row = rowOf(i);
          if (!row) notInWorld += 1;
          else if (row[1] === null) noController += 1;
        }
      }
      if (ui.mode === "faction") {
        for (const [id, text] of factionLegend(ui.state ? ui.state.factions : null, layerFactionIds(),
          ui.state ? ui.state.names : null)) {
          legend.appendChild(legendItem(colourOfFaction(id), text));
        }
      } else {
        for (const [id, name, count] of ui.state ? ui.state.factions : []) {
          legend.appendChild(legendItem(colourOfFaction(id), `${name || `faction ${id}`} (${fmtNum(count)})`));
        }
      }
      legend.appendChild(legendItem(NO_CONTROLLER, `no controller (${fmtNum(noController)})`));
      legend.appendChild(legendItem(NOT_IN_WORLD, `not in world (${fmtNum(notInWorld)})`));
      drawLayerLegend(ui.mode === "faction");
    }
    function drawLayers() {
      const layers = (ui.manifest && ui.manifest.layers) || [];
      const sig = JSON.stringify(layers.map((l) => {
        const st = ui.layers.get(l.id);
        return [l.id, l.title, st && st.data ? st.data.offMap || 0 : 0, Boolean(st)];
      }));
      if (sig === ui.layerBarSig) return;
      ui.layerBarSig = sig;
      clear(layerBox);
      for (const l of layers) {
        const st = ui.layers.get(l.id);
        if (!st) {
          layerBox.appendChild(el("span", { cls: "note", text: `${l.title} (unsupported kind)` }));
          continue;
        }
        const box = document.createElement("input");
        box.setAttribute("type", "checkbox");
        box.checked = st.enabled;
        box.addEventListener("change", () => {
          st.enabled = box.checked;
          writeLayerEnabled(storage, st.id, st.enabled);
          if (st.enabled && !st.pending && st.key !== st.serverKey) loadLayer(st);
          drawLegend();
          drawDetails();
          requestDraw();
        });
        const off = st.data && st.data.offMap > 0 ? ` (${fmtNum(st.data.offMap)} off map)` : "";
        layerBox.appendChild(el("label", { cls: "gx-check" }, [box, el("span", { text: `${st.title}${off}` })]));
      }
    }
    function layerInfoAt(i) {
      const out = [];
      for (const l of shownLayers()) {
        const info = LAYER_KINDS[l.kind].linesAt(l.data, i);
        if (info) out.push({ title: l.title, label: info.label, lines: info.lines });
      }
      return out;
    }
    function drawStatus() {
      const parts = [];
      const st = ui.static;
      if (st) parts.push(`${fmtNum(st.n)} systems / ${fmtNum(st.edges.length / 2)} gates`);
      else parts.push(ui.staticNote);
      if (ui.state) {
        const s = ui.state;
        parts.push(`world rows ${fmtNum(s.totals.rows)}, controlled ${fmtNum(s.totals.controlled)}`);
        if (s.seed && s.seed.state) parts.push(`seed ${s.seed.state}${s.seed.scope ? ` (${s.seed.scope})` : ""}`);
      } else if (ui.manifest && ui.manifest.stateAvailable === false) {
        parts.push("world state unavailable");
      } else if (ui.stateNote) {
        parts.push(ui.stateNote);
      }
      if (ui.statePending) parts.push("updating state…");
      status.textContent = parts.join(" · ");
    }
    function cardMode() {
      return card !== null && Boolean(ui.manifest && ui.manifest.ui && ui.manifest.ui.systemCard === true);
    }
    function barsLayer() {
      for (const l of ui.layers.values()) if (l.kind === "bars") return l;
      return null;
    }
    function drawCardHead() {
      const i = selectedIndex();
      if (i === -1) {
        card.hide();
        return;
      }
      const st = ui.static;
      const row = rowOf(i);
      const hasData = ui.card.data !== null && ui.card.data.systemId === ui.selectedId;
      card.showHeader({ name: st.name[i], region: st.regionNames[st.region[i]] || `region index ${st.region[i]}`,
        tenths: st.sec[i], cls: st.cls[i], classLabel: CLASS_LABELS[st.cls[i]],
        controller: hasData && ui.card.data.system ? ui.card.data.system.controller : (row ? row[1] : undefined) });
      card.setLayerLines(layerInfoAt(i));
    }
    function drawSide() {
      const on = cardMode() || barsLayer() !== null;
      side.classList.toggle("hidden", !on);
      stage.classList.toggle("gx-stage--full", !on);
      if (card) card.root.classList.toggle("hidden", !cardMode());
    }
    function markOps() {
      for (const [id, b] of ui.opButtons) b.classList.toggle("is-selected", id === ui.selectedId);
    }
    function opRow(item) {
      const model = global.LneSystemCard._pure.opRowModel(item);
      const dot = el("span", { cls: "gc-dot", title: factionName(item.attacker) });
      dot.style.setProperty("--fx", colourOfFaction(item.attacker));
      const fill = el("span", { cls: "gc-fill" });
      fill.style.width = `${global.LneSystemCard._pure.percent(item.ratio)}%`;
      const track = el("div", { cls: "gc-bar" }, [fill]);
      track.style.setProperty("--fx", colourOfFaction(item.attacker));
      const rightCls = { BLOCKED: " is-held", REVERTING: " is-warn" }[item.status] || "";
      const b = el("button", { cls: "gx-op" }, [
        el("span", { cls: "gx-op-head" }, [dot, el("span", { cls: "gx-op-name", text: ui.static.name[item.i] }),
          el("span", { cls: "gx-op-phase", text: model.phase }),
          el("span", { cls: `gx-op-right${rightCls}`, text: model.right })]),
        el("span", { cls: "gx-op-foot" }, [track, el("span", { cls: "gx-op-note", text: model.note })])]);
      b.setAttribute("type", "button");
      b.addEventListener("click", () => focusSystem(item.i));
      return b;
    }
    function renderOps() {
      const layer = barsLayer();
      ui.opButtons.clear();
      clear(opsList);
      ops.classList.toggle("hidden", layer === null || !global.LneSystemCard);
      drawSide();
      if (layer === null || !global.LneSystemCard) return;
      const items = layer.data ? layer.data.items : [];
      opsTitle.textContent = layer.data ? `Takeovers in progress (${fmtNum(items.length)})` : "Takeovers in progress";
      if (items.length === 0) {
        opsList.appendChild(el("div", { cls: "gx-ops-empty",
          text: global.LneSystemCard._pure.opsEmptyText(Boolean(layer.data), layer.unavailable) }));
      }
      for (const item of items) {
        const b = opRow(item);
        ui.opButtons.set(item.systemId, b);
        opsList.appendChild(b);
      }
      markOps();
    }
    function selectSystem(id) {
      ui.selectedId = id;
      ui.card.id = id;
      if (cardMode()) {
        ui.card.failures = 0;
        ui.card.retryAt = 0;
        card.setStale(null);
        card.setMessage(null);
        drawCardHead();
        if (ui.card.data !== null && ui.card.data.systemId === id) card.setData(ui.card.data);
        else card.setLoading();
        loadCard(id);
      } else drawDetails();
      markOps();
      requestDraw();
    }
    function focusSystem(i) {
      const st = ui.static;
      if (!ui.view) return;
      if (!visible(i)) classBoxes[st.cls[i]].querySelector("input").click();
      const k = Math.max(ui.view.k, ui.kFit * FOCUS_ZOOM);
      ui.view = { k, ox: ui.cssW / 2 - st.x[i] * k, oy: ui.cssH / 2 - st.y[i] * k };
      selectSystem(st.id[i]);
    }
    function applyFocusWanted() {
      if (!ui.focusWanted || !ui.static || !ui.view) return;
      const i = ui.static.idIndex.get(ui.focusWanted);
      ui.focusWanted = null;
      if (i === undefined) return;
      focusSystem(i);
      requestDraw();
    }
    function focusSystemId(id) {
      ui.focusWanted = Number.isSafeInteger(id) && id > 0 ? id : null;
      applyFocusWanted();
    }
    function drawDetails() {
      if (cardMode()) {
        drawCardHead();
        return;
      }
      const i = selectedIndex();
      clear(detailBox);
      if (i === -1) {
        detailBox.classList.add("hidden");
        return;
      }
      const st = ui.static;
      const row = rowOf(i);
      const bastion = ui.state && ui.state.bastions ? ui.state.bastions.get(st.id[i]) : undefined;
      const lines = [
        ["system", `${st.name[i]} (${st.id[i]})`],
        ["region", st.regionNames[st.region[i]] || `region index ${st.region[i]}`],
        ["security", `${(st.sec[i] / SECURITY_TENTHS).toFixed(1)} ${CLASS_LABELS[st.cls[i]]}`],
        ["controller", row ? factionName(row[1]) : (bastion !== undefined ? factionName(bastion) : "not in world")],
        ["occupation", row ? row[2] : "-"],
        ["influence", row && row[3].length
          ? row[3].map(([id, score]) => `${factionName(id)} ${fmtNum(score)}`).join(", ") : "-"],
      ];
      if (bastion !== undefined) lines.push(["sovereignty", `NPC base of ${factionName(bastion)} (not capturable)`]);
      for (const info of layerInfoAt(i)) {
        lines.push([info.title, info.lines ? info.lines.join(", ") : (info.label || "-")]);
      }
      const body = el("tbody");
      for (const [k, v] of lines) body.appendChild(el("tr", null, [el("td", { text: k }), el("td", { text: v })]));
      detailBox.appendChild(el("table", { cls: "kv" }, [body]));
      detailBox.classList.remove("hidden");
    }
    function clearSelection() {
      ui.selectedId = null;
      ui.card.id = null;
      ui.card.token += 1;
      ui.card.pending = false;
      drawDetails();
      markOps();
      requestDraw();
    }

    function local(ev) {
      const rect = canvas.getBoundingClientRect();
      return { mx: ev.clientX - rect.left, my: ev.clientY - rect.top };
    }
    canvas.addEventListener("wheel", (ev) => {
      if (!ui.view) return;
      ev.preventDefault();
      const { mx, my } = local(ev);
      ui.view = zoomAt(ui.view, Math.exp(-ev.deltaY * WHEEL_ZOOM_PER_PX), mx, my, ui.kFit, zoomMaxOf());
      requestDraw();
    }, { passive: false });
    canvas.addEventListener("pointerdown", (ev) => {
      if (!ui.view) return;
      const { mx, my } = local(ev);
      ui.drag = { id: ev.pointerId, mx, my, ox: ui.view.ox, oy: ui.view.oy, moved: false };
      try {
        canvas.setPointerCapture(ev.pointerId);
      } catch (_err) {
      }
    });
    canvas.addEventListener("pointermove", (ev) => {
      if (!ui.view) return;
      const { mx, my } = local(ev);
      const d = ui.drag;
      if (d && d.id === ev.pointerId) {
        if (Math.abs(mx - d.mx) + Math.abs(my - d.my) > CLICK_MOVE_PX) d.moved = true;
        if (d.moved) {
          ui.view = { k: ui.view.k, ox: d.ox + mx - d.mx, oy: d.oy + my - d.my };
          tooltip.classList.add("hidden");
          requestDraw();
          return;
        }
      }
      const inner = interiorHit(mx, my);
      if (inner.inside) {
        const key = inner.item ? inner.item.key : null;
        if (ui.hover !== -1 || key !== ui.interior.hoverKey) {
          ui.hover = -1;
          ui.interior.hoverKey = key;
          requestDraw();
        }
        if (!inner.item) {
          tooltip.classList.add("hidden");
          return;
        }
        const names = new Map(((ui.interior.data && ui.interior.data.names) || []).filter((n) => n[1]));
        if (ui.state) for (const [id, name] of ui.state.names) if (!names.has(id)) names.set(id, name);
        tooltip.textContent = global.LneSystemInterior._pure.tooltipLines(inner.item, names, systemNameOf).join("\n");
        tooltip.style.left = `${Math.round(mx + TOOLTIP_OFFSET_PX)}px`;
        tooltip.style.top = `${Math.round(my + TOOLTIP_OFFSET_PX)}px`;
        tooltip.classList.remove("hidden");
        return;
      }
      if (ui.interior.hoverKey !== null) {
        ui.interior.hoverKey = null;
        requestDraw();
      }
      const i = pick(mx, my);
      if (i !== ui.hover) {
        ui.hover = i;
        requestDraw();
      }
      if (i === -1) {
        tooltip.classList.add("hidden");
        return;
      }
      const text = [ui.static.name[i]];
      for (const info of layerInfoAt(i)) if (info.lines) text.push(...info.lines);
      tooltip.textContent = text.join("\n");
      tooltip.style.left = `${Math.round(mx + TOOLTIP_OFFSET_PX)}px`;
      tooltip.style.top = `${Math.round(my + TOOLTIP_OFFSET_PX)}px`;
      tooltip.classList.remove("hidden");
    });
    const endDrag = (ev) => {
      const d = ui.drag;
      if (!d || d.id !== ev.pointerId) return;
      ui.drag = null;
      if (d.moved || ev.type !== "pointerup") return;
      const { mx, my } = local(ev);
      if (interiorHit(mx, my).inside) {
        selectSystem(ui.interior.id);
        return;
      }
      const i = pick(mx, my);
      if (i === -1) clearSelection();
      else selectSystem(ui.static.id[i]);
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("pointerleave", () => {
      tooltip.classList.add("hidden");
      if (ui.hover !== -1 || ui.interior.hoverKey !== null) {
        ui.hover = -1;
        ui.interior.hoverKey = null;
        requestDraw();
      }
    });
    document.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape" && ui.selectedId !== null) clearSelection();
    });
    if (typeof global.ResizeObserver === "function") new global.ResizeObserver(resize).observe(canvas);
    else global.addEventListener("resize", resize);

    function failText(r) {
      const err = (r.body && r.body.error) || {};
      return `HTTP ${r.status} ${err.reason || "error"}${err.message ? `: ${err.message}` : ""}`;
    }
    function allRetries() {
      return [ui.staticRetry, ui.stateRetry, ...ui.layers.values()];
    }
    function noteKey(retry, key) {
      if (retry.seenKey !== key) {
        retry.seenKey = key;
        retry.retryAt = 0;
      }
    }
    function mayTry(retry) {
      return ui.seq >= retry.retryAt;
    }
    function failed(retry, text) {
      retry.failures += 1;
      retry.retryAt = ui.seq + retryAfter(retry.failures);
      error(text);
    }
    function succeeded(retry) {
      retry.failures = 0;
      retry.retryAt = 0;
      if (allRetries().every((r) => r.failures === 0)) errorSlot.classList.add("hidden");
    }
    function loadStatic() {
      ui.staticPending = true;
      getJson("/api/views/galaxy-static").then((r) => {
        ui.staticPending = false;
        if (!r.body || r.body.ok !== true) {
          failed(ui.staticRetry, `map data: ${failText(r)}`);
          return;
        }
        succeeded(ui.staticRetry);
        const data = r.body.data || {};
        if (!data.available) {
          ui.staticNote = `map data not available: ${data.reason || "unknown"}`;
          drawStatus();
          return;
        }
        ui.static = ingestStatic(data);
        ui.paths = null;
        ui.hover = -1;
        if (!ui.fitted) {
          resize();
          fit();
        }
        applyFocusWanted();
        for (const l of ui.layers.values()) if (l.raw) l.data = LAYER_KINDS[l.kind].ingest(l.raw, ui.static.idIndex);
        rebuildBuckets();
        drawLayers();
        drawLegend();
        drawStatus();
        drawDetails();
        renderOps();
        requestDraw();
      }).catch((err) => {
        ui.staticPending = false;
        failed(ui.staticRetry, `map data: ${err && err.message}`);
      });
    }
    function loadState() {
      ui.statePending = true;
      drawStatus();
      getJson("/api/views/galaxy-state").then((r) => {
        ui.statePending = false;
        if (!r.body || r.body.ok !== true) {
          failed(ui.stateRetry, `map state: ${failText(r)}`);
          drawStatus();
          return;
        }
        succeeded(ui.stateRetry);
        const data = r.body.data || {};
        ui.stateNote = stateNoteOf(data);
        if (data.available) {
          ui.stateKey = data.key;
          ui.state = { byId: new Map(data.systems.map((row) => [row[0], row])), factions: data.factions,
            names: new Map((data.names || []).filter((n) => n[1]).map((n) => [n[0], n[1]])),
            bastions: new Map(Array.isArray(data.bastions) ? data.bastions : []),
            totals: data.totals, seed: data.seed };
          rebuildBuckets();
          drawLegend();
          drawDetails();
          renderOps();
          requestDraw();
        }
        drawStatus();
      }).catch((err) => {
        ui.statePending = false;
        failed(ui.stateRetry, `map state: ${err && err.message}`);
      });
    }
    function loadLayer(l) {
      l.pending = true;
      const requested = l.serverKey;
      getJson(`/api/views/${encodeURIComponent(l.id)}`).then((r) => {
        l.pending = false;
        if (ui.layers.get(l.id) !== l) return;
        if (!r.body || r.body.ok !== true) {
          l.unavailable = failText(r);
          failed(l, `layer ${l.title}: ${l.unavailable}`);
          if (l.kind === "bars") renderOps();
          return;
        }
        succeeded(l);
        const data = r.body.data || {};
        if (!data.available) {
          l.unavailable = String(data.reason || "unavailable");
          if (l.kind === "bars") renderOps();
          return;
        }
        l.unavailable = null;
        l.key = requested;
        l.raw = data;
        l.data = ui.static ? LAYER_KINDS[l.kind].ingest(data, ui.static.idIndex) : null;
        drawLayers();
        drawLegend();
        drawDetails();
        if (l.kind === "bars") renderOps();
        requestDraw();
      }).catch((err) => {
        l.pending = false;
        l.unavailable = String((err && err.message) || "error");
        failed(l, `layer ${l.title}: ${l.unavailable}`);
        if (l.kind === "bars") renderOps();
      });
    }
    function cardFailed(id, text) {
      const c = ui.card;
      c.pending = false;
      c.failures += 1;
      c.retryAt = ui.seq + retryAfter(c.failures);
      c.fetchedAtMs = Date.now();
      card.setMessage(`Could not fetch the data: ${text}`);
      if (!c.data || c.data.systemId !== id) card.setData(null);
    }
    function cardAnswer(id, data, staleAgeMs) {
      const c = ui.card;
      c.data = data;
      c.dataAtMs = cardDataAtMs(data, staleAgeMs, Date.now());
      card.setMessage(null);
      card.setStale(staleAgeMs > 0 || data.stale === true ? c.dataAtMs : null);
      card.setData(data);
      drawCardHead();
    }
    function loadCard(id) {
      const c = ui.card;
      c.token += 1;
      const token = c.token;
      c.pending = true;
      getJson(`/api/views/system-card?system=${id}`).then((r) => {
        if (token !== c.token) return;
        c.pending = false;
        if (!r.body || r.body.ok !== true) {
          cardFailed(id, failText(r));
          return;
        }
        c.failures = 0;
        c.retryAt = 0;
        c.fetchedAtMs = Date.now();
        const data = r.body.data || {};
        if (data.available !== false) {
          cardAnswer(id, data, data.stale === true ? data.staleAgeMs : 0);
          return;
        }
        const own = c.data !== null && c.data.systemId === id;
        if (data.reason === HOLD_REASON && own) {
          card.setStale(c.dataAtMs);
          return;
        }
        card.setMessage(global.LneSystemCard._pure.messageFor(data.reason));
        if (!own) card.setData(null);
      }).catch((err) => {
        if (token === c.token) cardFailed(id, err && err.message);
      });
    }
    function syncLayers(m) {
      const listed = new Set();
      for (const entry of m.layers || []) {
        if (!Object.prototype.hasOwnProperty.call(LAYER_KINDS, entry.kind)) continue;
        listed.add(entry.id);
        let l = ui.layers.get(entry.id);
        if (!l || l.kind !== entry.kind) {
          l = { id: entry.id, kind: entry.kind, title: entry.title, key: undefined, serverKey: undefined,
            pending: false, failures: 0, retryAt: 0, seenKey: undefined, raw: null, data: null,
            enabled: l ? l.enabled : readLayerEnabled(storage, entry.id) };
          ui.layers.set(entry.id, l);
        }
        l.title = entry.title;
        l.serverKey = entry.key;
        noteKey(l, entry.key);
        const wanted = l.enabled || LAYER_KINDS[l.kind].fetchAlways === true;
        if (wanted && !l.pending && l.key !== entry.key && mayTry(l)) loadLayer(l);
      }
      let removed = false;
      for (const id of [...ui.layers.keys()]) {
        if (listed.has(id)) continue;
        ui.layers.delete(id);
        removed = true;
      }
      if (removed) {
        drawLegend();
        drawDetails();
        renderOps();
        requestDraw();
      }
    }
    function refreshCard(m) {
      const c = ui.card;
      if (!cardMode() || c.id === null || c.pending || ui.seq < c.retryAt) return;
      if (Date.now() - c.fetchedAtMs >= m.ui.systemCardRefreshMs) loadCard(c.id);
    }

    function update(m) {
      ui.seq += 1;
      if (allRetries().every((r) => r.failures === 0)) errorSlot.classList.add("hidden");
      ui.manifest = m;
      syncLayers(m);
      drawLayers();
      drawSide();
      refreshCard(m);
      refreshInterior(m);
      if (ui.interior.id !== null && !interiorCfg()) requestDraw();
      if (!m.available) {
        ui.staticNote = `map not available: ${m.reason || "unknown"}`;
        drawStatus();
        return;
      }
      noteKey(ui.staticRetry, m.staticKey);
      noteKey(ui.stateRetry, m.stateKey);
      if (!ui.staticPending && mayTry(ui.staticRetry)
        && (!ui.static || (m.staticKey !== null && m.staticKey !== ui.static.key))) loadStatic();
      if (m.stateAvailable && !ui.statePending && mayTry(ui.stateRetry) && m.stateKey !== ui.stateKey) loadState();
      if (!m.stateAvailable && ui.state) {
        ui.state = null;
        ui.stateKey = undefined;
        rebuildBuckets();
        drawLegend();
        requestDraw();
      }
      drawStatus();
    }

    function error(text) {
      errorSlot.textContent = text;
      errorSlot.classList.remove("hidden");
    }

    drawLegend();
    drawStatus();
    return { root, update, error, focusSystem: focusSystemId };
  }

  global.LneGalaxy = Object.freeze({
    createPanel,
    _pure: Object.freeze({ hashHue, factionColor, secColor, safeColor, fitTransform, canFit, zoomAt,
      ingestStatic, nearest, retryAfter, ingestMarks, ingestPaths, markShape, markScale, parseColourMode, readColourMode,
      writeColourMode, dashPattern, itemColour, factionLegend, ingestAreas, readLayerEnabled, writeLayerEnabled,
      ingestBars, placeBar, barWidth, readOpsOpen, writeOpsOpen, stateNoteOf, cardDataAtMs }),
  });
}(typeof window !== "undefined" ? window : globalThis));
